import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { streamCompletion } from '../src/providers.mjs';
import { openJournal } from '../src/journal.mjs';
import { createFakeAnthropic } from './fixtures/fake-anthropic.mjs';
import { thinkingBlocks } from './helpers/append-only.mjs';

const KEY = 'sk-ant-fixture-not-a-real-key';
const opus = { providerId: 'anthropic', modelId: 'claude-opus-5-5', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', contextWindow: 1000000, maxOutputTokens: 64000, reasoning: 'default', input: ['text', 'image'], compat: { adaptiveThinking: true, thinkingDisplay: 'summarized' } };
const withMode = thinkingBindingMode => ({ ...opus, compat: { ...opus.compat, thinkingBindingMode } });
const readTool = { name: 'read', effect: 'read', idempotent: true, parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false }, execute: async (_id, args) => `contents of ${args.path}` };
const records = async file => (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const firstTurn = [[{ thinking: 'Plan: read a.' }, { tool: { id: 'toolu_a', name: 'read', input: { path: 'a' } } }], [{ thinking: 'a is read.' }, { text: 'A says hello.' }]];

async function harness(t, { model = opus, respond, wrap = provider => provider, fetch: customFetch } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rna-binding-')), fake = createFakeAnthropic({ respond, reads: { 'claude-opus-5-5': ['claude-sonnet-5-5'] } }), handles = [];
  t.after(async () => { await Promise.allSettled(handles.map(handle => handle.dispose())); await rm(root, { recursive: true, force: true }); });
  const provider = Object.assign(wrap(input => streamCompletion({ ...input, fetch: customFetch ?? fake.fetch, maxRetries: 0 })), { meteredBase: streamCompletion });
  const open = async (extra = {}) => { const session = await createSession({ sessionId: 'binding', projectId: 'p', cwd: root, stateDir: join(root, 'state'), model, apiKey: KEY, provider, tools: [readTool], autoCompaction: false, ...extra }); handles.push(session); return session; };
  return { root, fake, open };
}
// A legacy harness edit: a compaction journaled without its thinking rebase (what pre-0.65 code did).
async function injectLegacyCompaction(app, session) {
  const snapshot = session.snapshot(), through = snapshot.messages.find(message => message.role === 'toolResult').id;
  await session.dispose();
  const journal = openJournal({ stateDir: join(app.root, 'state'), sessionFile: snapshot.sessionFile, sessionId: 'binding', projectId: 'p' });
  journal.append('context_compaction', { id: randomUUID(), summary: 'Earlier: the assistant read file a.', throughMessageId: through, sourceDigest: 'legacy', archivedMessages: 3, retainedMessages: 1 });
  journal.close();
  return snapshot.sessionFile;
}

for (const [mode, expected] of [['off', 'strip'], ['error', 'strip'], ['unset', 'drop_block']]) test(`a legacy history edit with binding mode ${mode} recovers by ${expected}, journals the rebase, and the next request is clean`, async t => {
  const app = await harness(t, { model: withMode(mode), respond: [...firstTurn, [{ thinking: 'After the summary.' }, { text: 'Next done.' }], [{ text: 'Third.' }]] });
  let session = await app.open(); await session.prompt('Read a.');
  const file = await injectLegacyCompaction(app, session);
  session = await app.open({ sessionFile: file });
  await session.prompt('Next.');
  const journal = await records(file), rebases = journal.filter(row => row.type === 'thinking_rebase').map(row => row.data);
  assert.equal(app.fake.errors.length, 1, 'exactly one rejection');
  assert.match(app.fake.errors[0].message, /bound to a different conversation/);
  if (expected === 'strip') {
    assert.deepEqual(rebases.map(row => row.reason), ['binding_rejected']);
    assert.deepEqual(thinkingBlocks(app.fake.requests.at(-1).body.messages), [], 'the retry carries no thinking');
  } else {
    assert.equal(app.fake.requests.at(-1).body.thinking.block_binding.prefix_mismatch_behavior, 'drop_block');
    assert.deepEqual(rebases.map(row => row.reason), ['binding_dropped'], 'the dropped blocks become a rebase');
    assert.ok(app.fake.responses.at(-1).transformations.some(row => row.reason === 'prefix_binding_mismatch'));
  }
  const tail = journal.findLast(row => row.type === 'request_started').data.tailMessageId;
  assert.equal(rebases[0].throughMessageId, tail, 'the floor reaches the request tail');
  await session.prompt('Third.');
  assert.equal(app.fake.errors.length, 1, 'no further rejection');
  assert.deepEqual(app.fake.responses.at(-1).transformations ?? [], [], 'nothing left to drop after the rebase');
  const last = app.fake.requests.at(-1).body;
  assert.equal(thinkingBlocks(last.messages).length, 1, 'only the thinking produced after the rebase is replayed');
});

test('drop_block (the production default) never fails the turn: one drop, one rebase, then a clean history', async t => {
  const app = await harness(t, { respond: [...firstTurn, [{ thinking: 'After.' }, { text: 'Next done.' }], [{ text: 'Third.' }]] });
  let session = await app.open(); await session.prompt('Read a.');
  const file = await injectLegacyCompaction(app, session);
  session = await app.open({ sessionFile: file });
  await session.prompt('Next.');
  assert.equal(app.fake.errors.length, 0);
  const message = session.snapshot().messages.findLast(row => row.role === 'assistant');
  assert.deepEqual(message.inputTransformations.map(row => [row.type, row.reason, row.sourceMessageId !== undefined]), [['thinking_dropped', 'prefix_binding_mismatch', true]]);
  assert.deepEqual((await records(file)).filter(row => row.type === 'thinking_rebase').map(row => row.data.reason), ['binding_dropped']);
  await session.prompt('Third.');
  assert.deepEqual(app.fake.responses.at(-1).transformations, [], 'the following request has zero transformations');
});

test('a mutated signature is stripped once as invalid_signature; drop_block cannot absorb it', async t => {
  let mutate = false;
  const wrap = provider => input => provider(mutate ? { ...input, messages: input.messages.map(message => message.role === 'assistant' ? { ...message, content: message.content.map(part => part.type === 'thinking' && part.signature ? { ...part, signature: `${part.signature}x` } : part) } : message) } : input);
  const app = await harness(t, { wrap, respond: [...firstTurn, [{ text: 'Next.' }]] });
  const session = await app.open(); await session.prompt('Read a.');
  mutate = true; await session.prompt('Next.');
  assert.equal(app.fake.errors.length, 1); assert.doesNotMatch(app.fake.errors[0].message, /bound to a different conversation/);
  assert.deepEqual((await records(session.snapshot().sessionFile)).filter(row => row.type === 'thinking_rebase').map(row => row.data.reason), ['invalid_signature']);
  assert.deepEqual(thinkingBlocks(app.fake.requests.at(-1).body.messages), []);
});

test('a second rejection fails the turn with thinking_binding and no third request; other 400s are never retried', async t => {
  const rejection = { type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".' } };
  for (const [body, calls, code] of [[rejection, 2, 'thinking_binding'], [{ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: too large' } }, 1, 'http_error']]) {
    let seen = 0;
    const fetch = async () => { seen++; return new Response(JSON.stringify(body), { status: 400, headers: { 'content-type': 'application/json' } }); };
    const app = await harness(t, { fetch });
    const session = await app.open();
    await assert.rejects(session.prompt('Go.'), error => error.code === code);
    assert.equal(seen, calls);
  }
});

test('Opus to Sonnet to Opus on one provider sends every block, reports only model drops and journals no rebase', async t => {
  const sonnet = { ...opus, modelId: 'claude-sonnet-5-5' };
  const app = await harness(t, { respond: [...firstTurn, [{ thinking: 'Sonnet view.' }, { text: 'Sonnet answer.' }], [{ thinking: 'Back on Opus.' }, { text: 'Opus answer.' }]] });
  const session = await app.open(); await session.prompt('Read a.');
  session.setModel(sonnet); await session.prompt('Sonnet turn.');
  session.setModel(opus); await session.prompt('Opus turn.');
  assert.equal(app.fake.errors.length, 0);
  const [sonnetRequest, backRequest] = app.fake.requests.slice(2).map(row => row.body);
  assert.equal(thinkingBlocks(sonnetRequest.messages).length, 2, 'Opus blocks are sent to Sonnet (the API drops them)');
  assert.equal(thinkingBlocks(backRequest.messages).length, 3, 'every block, Sonnet\'s included, goes back to Opus: nothing is put back');
  assert.deepEqual([...new Set(app.fake.responses.flatMap(row => row.transformations ?? []).map(row => row.reason))], ['model_binding_mismatch']);
  assert.deepEqual((await records(session.snapshot().sessionFile)).filter(row => row.type === 'thinking_rebase'), []);
});
