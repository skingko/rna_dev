import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { streamCompletion } from '../src/providers.mjs';
import { historyEditMode, historyEditsAllowed, coldAfterMs } from '../src/cache-survival.mjs';
import { createFakeAnthropic } from './fixtures/fake-anthropic.mjs';
import { assertAppendOnly, thinkingBlocks } from './helpers/append-only.mjs';

// Integration of the cold-break context economy (spec p1 compaction) with append-only Anthropic history (spec p1
// claude): on an append-only target an economy edit commits only at a thinking rebase point — never at a cold break
// alone — and a compaction (idle or not) is journaled with its `thinking_rebase`. The fake endpoint runs in 'error'
// mode, so any edit of history that is not covered by a rebase is a 400 and fails the test.
const KEY = 'sk-ant-fixture-not-a-real-key';
const opus = { providerId: 'anthropic', modelId: 'claude-opus-5-5', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', contextWindow: 1000000, maxOutputTokens: 64000, reasoning: 'default', compat: { adaptiveThinking: true, thinkingDisplay: 'summarized', thinkingBindingMode: 'error' } };
const MIN = 60000;
const big = 'x'.repeat(3000);
const records = async file => (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const SUMMARY = /^Summarize the provided conversation record/;
const tool = (name, execute, effect = 'read') => ({ name, effect, idempotent: effect === 'read', parameters: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, additionalProperties: false }, execute });
const writeTool = tool('write', async () => `written ${'w'.repeat(2500)}`, 'write');
const readTool = tool('read', async (_id, args) => `contents of ${args.path}`);
// Every user turn: think, write a large file, then say so (tool-use ids are unique, as the API's are).
const writer = () => {
  let calls = 0;
  return body => {
    if (SUMMARY.test(body.system?.[0]?.text ?? '')) return [{ text: 'Summary of the earlier writing.' }];
    const last = body.messages.at(-1), answered = Array.isArray(last.content) && last.content.some(block => block.type === 'tool_result');
    return answered ? [{ text: 'saved' }] : [{ thinking: `plan ${++calls}` }, { tool: { id: `toolu_w${calls}`, name: 'write', input: { path: `f${calls}`, text: big } } }];
  };
};

async function harness(t, { tools = () => [writeTool, readTool], ...options } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rna-cold-economy-')), handles = [];
  let now = Date.parse('2026-10-04T08:00:00Z'), turn = 0, judged = 0;
  const fake = createFakeAnthropic({ respond: writer(), now: () => now });
  t.after(async () => { await Promise.allSettled(handles.map(handle => handle.dispose())); await rm(root, { recursive: true, force: true }); });
  const provider = Object.assign(input => streamCompletion({ ...input, fetch: fake.fetch, maxRetries: 0 }), { meteredBase: streamCompletion });
  const base = { sessionId: 'cold-economy', projectId: 'p', cwd: root, stateDir: join(root, 'state'), model: opus, apiKey: KEY, provider, autoCompaction: false, clock: () => now,
    settleArguments: (name, args) => name === 'write' ? { path: args.path, text: '[settled]' } : null,
    forgetStale: async ({ results }) => { judged++; return results.map(row => row.id); },
    // A host note revised every turn: each earlier copy is a fold target once a later one exists.
    beforeRequest: async () => ({ tools: tools(), contextUpdates: [{ key: 'notes', source: 'host-notes', text: `notes for turn ${turn} ${'n'.repeat(1500)}` }] }) };
  const open = async (extra = {}) => { const session = await createSession({ ...base, ...options, ...extra }); handles.push(session); return session; };
  return { fake, open, advance: ms => { now += ms; }, prompt: async (session, text) => { turn++; await session.prompt(text); }, judged: () => judged, clock: () => now };
}
/** Consecutive conversation requests stay append-only unless the journal holds a rebase between them; the fake saw no rejection. */
async function assertSession(fake, file) {
  const journal = await records(file), conversation = fake.requests.filter(row => !row.keepAlive && !SUMMARY.test(row.body.system?.[0]?.text ?? ''));
  const started = journal.filter(row => row.type === 'request_started');
  assert.equal(started.length, conversation.length, 'one wire request per journaled request');
  for (let index = 1; index < conversation.length; index++) {
    const between = journal.filter(row => row.type === 'thinking_rebase' && row.seq > started[index - 1].seq && row.seq < started[index].seq).map(row => row.data);
    const rebase = between.length ? (between.at(-1).throughMessageId === started[index - 1].data.tailMessageId ? 'tail' : 'response') : undefined;
    assertAppendOnly(conversation[index - 1].body, conversation[index].body, { prevResponse: conversation[index - 1].response, rebase });
  }
  assert.deepEqual(fake.errors, [], 'no request was rejected');
  return journal;
}
const between = (journal, from, to) => journal.filter(row => row.seq > from.seq && row.seq < to.seq && row.type !== 'event').map(row => row.type);

test('history edit modes come from one source: append-only Claude rebases, a declared path never edits, others edit freely', () => {
  assert.equal(historyEditMode(opus), 'rebase');
  assert.equal(historyEditsAllowed(opus), false, 'no outright edit on an append-only target');
  assert.equal(historyEditMode({ ...opus, compat: { ...opus.compat, appendOnly: false } }), 'free', 'the explicit compat flag wins');
  assert.equal(historyEditMode({ ...opus, baseUrl: 'https://api.kimi.com/coding' }), 'free', 'third-party Anthropic-protocol endpoints keep editing');
  assert.equal(historyEditMode({ protocol: 'openai', compat: { appendOnly: true } }), 'none');
  assert.equal(historyEditMode({ protocol: 'openai' }), 'free');
  // One cold-gap rule: Anthropic's documented TTL unless a warm sample outlived it, the learned survival elsewhere.
  assert.equal(coldAfterMs(opus).coldAfterMs, 5 * MIN);
  assert.equal(coldAfterMs(opus, { coldAfterMs: 90 * MIN, warmMaxMs: 3 * MIN }).coldAfterMs, 5 * MIN);
  assert.equal(coldAfterMs({ protocol: 'openai' }, { coldAfterMs: 137 * MIN, warmMaxMs: 107 * MIN }).coldAfterMs, 137 * MIN);
  assert.equal(coldAfterMs({ protocol: 'openai' }).coldAfterMs, null);
});

test('on an append-only Claude target a cold break edits nothing; the economies ride on the next rebase point', async t => {
  let tools = [writeTool, readTool];
  const h = await harness(t, { tools: () => tools });
  const session = await h.open();
  // Four turns, each after the 5-minute TTL: every economy point is a cold break (documented TTL, no host estimate).
  for (const text of ['One.', 'Two.', 'Three.', 'Four.']) { await h.prompt(session, text); h.advance(10 * MIN); }
  const file = session.snapshot().sessionFile;
  let journal = await assertSession(h.fake, file);
  assert.deepEqual(journal.filter(row => ['context_settle', 'context_fold', 'context_forget', 'thinking_rebase'].includes(row.type)).map(row => row.type), [], 'no edit and no standalone cold-break rebase');
  assert.equal(h.judged(), 0, 'no forget judgment is asked when its answer could not be committed');
  const warmWire = JSON.stringify(h.fake.requests.at(-1).body.messages);
  assert.match(warmWire, /notes for turn 1 /, 'the first turn\'s note is still whole');
  assert.equal(warmWire.includes(big), true, 'the first turn\'s written text is still whole');
  assert.equal(thinkingBlocks(h.fake.requests.at(-1).body.messages).length, 4, 'every reasoning block is replayed');
  // A tool-set change is a rebase point: the cold economies commit right after its rebase, before the request reads the history.
  tools = [writeTool, readTool, tool('search', async () => 'found')];
  const before = journal.filter(row => row.type === 'request_started').at(-1);
  await h.prompt(session, 'Five.');
  journal = await assertSession(h.fake, file);
  const next = journal.find(row => row.type === 'request_started' && row.seq > before.seq);
  const order = between(journal, before, next).filter(type => ['thinking_rebase', 'prefix_pin', 'context_settle', 'context_fold'].includes(type));
  assert.deepEqual(order, ['thinking_rebase', 'prefix_pin', 'context_settle', 'context_fold'], 'rebase and pin first, then the deferred economies');
  assert.equal(journal.find(row => row.type === 'thinking_rebase').data.reason, 'prefix_changed');
  const sent = JSON.stringify(h.fake.requests.find(row => row.body.tools.length === 3).body.messages);
  assert.match(sent, /\[settled\]/, 'earlier writes are settled');
  assert.match(sent, /Superseded: a later update of \\"notes\\"/, 'earlier notes are folded');
  assert.ok((await records(file)).some(row => row.type === 'event' && row.data.type === 'context_economy' && row.data.reason === 'prefix_change' && row.data.settled > 0 && row.data.folded > 0));
});

test('idle compaction on an append-only Claude target commits with a thinking_rebase and keeps the pin; the next cold turn stays valid', async t => {
  const h = await harness(t);
  let session = await h.open();
  for (const text of ['One.', 'Two.', 'Three.', 'Four.']) { await h.prompt(session, text); h.advance(2 * MIN); }
  const file = session.snapshot().sessionFile;
  // The host's detached path: plan on an idle handle, a summary generated elsewhere, the hand-over committed by a
  // maintenance handle that carries neither the conversation's prompt nor its tools.
  const plan = session.prepareCompaction({ keepUserTurns: 2 });
  assert.ok(plan, 'an append-only conversation can still be compacted at idle');
  const prepared = { id: 'idle-claude-1', sessionId: plan.sessionId, trigger: 'idle', previousCompactionId: plan.previousCompactionId, throughMessageId: plan.throughMessageId, sourceDigest: plan.sourceDigest, summary: 'Summary of the earlier writing.', archivedMessages: plan.archivedMessages, retainedMessages: plan.retainedMessages, requestId: 'idle-claude-request', usage: { input: 900, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 920 }, usageReported: true, model: plan.model, beforeTokens: plan.beforeTokens };
  await session.dispose();
  await writeFile(`${file}.idle-summary.json`, JSON.stringify(prepared), { mode: 0o600 });
  h.advance(30 * MIN);
  const maintenance = await h.open({ sessionFile: file, tools: [], systemPrompt: 'You are Rna Agent.', beforeRequest: undefined });
  const outcome = maintenance.commitPreparedCompaction();
  assert.equal(outcome.committed, true);
  await maintenance.dispose();
  let journal = await records(file);
  const compaction = journal.find(row => row.type === 'context_compaction');
  assert.equal(compaction.data.trigger, 'idle');
  const rebase = journal[journal.indexOf(compaction) + 1];
  assert.equal(rebase.type, 'thinking_rebase'); assert.equal(rebase.data.reason, 'compaction', 'journaled with its rebase in one step');
  assert.equal(journal.filter(row => row.type === 'prefix_pin').length, 1, 'the maintenance handle does not re-pin with its own prompt and tools');
  // The next turn (cold): same pin, the summary, no thinking before the floor, and the economies ride on the rebase.
  session = await h.open({ sessionFile: file });
  const before = journal.filter(row => row.type === 'request_started').at(-1);
  await h.prompt(session, 'Five.');
  journal = await assertSession(h.fake, file);
  const first = h.fake.requests.find(row => JSON.stringify(row.body.messages).includes('Summary of the earlier writing.'));
  assert.ok(first, 'the next request carries the summary');
  assert.deepEqual(first.body.system.map(block => block.text), h.fake.requests[0].body.system.map(block => block.text), 'the pinned system prompt is unchanged');
  assert.deepEqual(thinkingBlocks(first.body.messages), [], 'no thinking at or before the floor');
  const next = journal.find(row => row.type === 'request_started' && row.seq > before.seq);
  assert.ok(between(journal, before, next).includes('context_fold'), 'superseded notes fold at the rebase point');
  assert.equal(journal.filter(row => row.type === 'thinking_rebase').length, 1, 'no further rebase was needed');
});

test('a prepared summary committed at a turn\'s cold break rebases and re-pins with the turn\'s own prompt and tools', async t => {
  const h = await harness(t);
  const session = await h.open();
  for (const text of ['One.', 'Two.', 'Three.', 'Four.']) { await h.prompt(session, text); h.advance(2 * MIN); }
  const plan = session.prepareCompaction({ keepUserTurns: 2 });
  assert.equal(session.offerCompaction({ id: 'idle-claude-2', sessionId: plan.sessionId, trigger: 'idle', previousCompactionId: null, throughMessageId: plan.throughMessageId, sourceDigest: plan.sourceDigest, summary: 'Summary of the earlier writing.', archivedMessages: plan.archivedMessages, retainedMessages: plan.retainedMessages, requestId: 'idle-claude-request-2', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, usageReported: true, model: plan.model }), true);
  // Warm (inside the TTL): the summary waits; the history is unchanged.
  await h.prompt(session, 'Five.');
  assert.equal(session.snapshot().compaction, null);
  h.advance(10 * MIN);
  await h.prompt(session, 'Six.');
  const journal = await assertSession(h.fake, session.snapshot().sessionFile);
  const compaction = journal.find(row => row.type === 'context_compaction');
  assert.equal(compaction.data.preparedId, 'idle-claude-2');
  assert.deepEqual(journal.slice(journal.indexOf(compaction), journal.indexOf(compaction) + 3).map(row => row.type), ['context_compaction', 'thinking_rebase', 'prefix_pin']);
  assert.ok((await records(session.snapshot().sessionFile)).some(row => row.type === 'event' && row.data.type === 'context_economy' && row.data.preparedCommitted === true && row.data.reason === 'idle'));
});
