import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { streamCompletion } from '../src/providers.mjs';
import { foldedContextText } from '../src/context.mjs';
import { createFakeAnthropic } from './fixtures/fake-anthropic.mjs';
import { assertAppendOnly, thinkingBlocks } from './helpers/append-only.mjs';

// C4 on an append-only Claude target: ordinary economies wait for the thinking floor, but a revocation does not — the
// user took the material's source back, so its copies fold on the very next request and that edit rides a thinking
// rebase of its own (`thinking_rebase`, reason `revoked`). The fake endpoint answers any history edit that no rebase
// covers with the documented 400, so a missing rebase fails here.
const KEY = 'sk-ant-fixture-not-a-real-key';
const opus = { providerId: 'anthropic', modelId: 'claude-opus-5-5', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', contextWindow: 1000000, maxOutputTokens: 64000, reasoning: 'default', compat: { adaptiveThinking: true, thinkingDisplay: 'summarized', thinkingBindingMode: 'error' } };
const records = async file => (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const notes = text => ({ key: 'project-notes', source: 'host-notes', text });

test('an append-only Claude target folds revoked copies at once with a thinking rebase, once, and nothing is rejected', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rna-revoke-anthropic-')), handles = [];
  let now = Date.parse('2026-10-05T08:00:00Z'), turn = 0, revoke = null, updates = [];
  const fake = createFakeAnthropic({ respond: () => [{ thinking: `think ${++turn}` }, { text: `answer ${turn}` }], now: () => now });
  t.after(async () => { await Promise.allSettled(handles.map(handle => handle.dispose())); await rm(root, { recursive: true, force: true }); });
  const provider = Object.assign(input => streamCompletion({ ...input, fetch: fake.fetch, maxRetries: 0 }), { meteredBase: streamCompletion });
  const session = await createSession({ sessionId: 'revoke-anthropic', projectId: 'p', cwd: root, stateDir: join(root, 'state'), model: opus, apiKey: KEY, provider, autoCompaction: false, clock: () => now,
    beforeRequest: () => (updates.length || revoke ? { ...(updates.length ? { contextUpdates: updates } : {}), ...(revoke ? { revokeContext: revoke } : {}) } : undefined) });
  handles.push(session);
  const step = async (text, next = []) => { now += 1000; updates = next; await session.prompt(text); };
  await step('One.', [notes(`first secret ${'a'.repeat(1500)}`)]);
  await step('Two.', [notes(`second secret ${'b'.repeat(1500)}`)]);
  const warm = JSON.stringify(fake.requests.at(-1).body.messages);
  assert.ok(warm.includes('first secret'), 'without a revocation the history stays append-only and whole');
  assert.equal(thinkingBlocks(fake.requests.at(-1).body.messages).length, 1, 'the earlier turn\'s reasoning block is replayed');
  now += 1000; revoke = [{ id: 'r1', contextKeys: ['project-notes'], before: now + 1 }];
  await step('Three.');
  const sent = JSON.stringify(fake.requests.at(-1).body.messages);
  assert.ok(!sent.includes('first secret') && !sent.includes('second secret'), 'both copies left the very next request');
  assert.ok(sent.includes(foldedContextText('project-notes', 'revoked').replace(/"/g, '\\"')), 'each is one line saying its source was withdrawn');
  await step('Four.');
  const file = session.snapshot().sessionFile, journal = await records(file);
  const rebases = journal.filter(row => row.type === 'thinking_rebase').map(row => row.data.reason);
  assert.deepEqual(rebases, ['revoked'], 'the edit rode one rebase of its own, and the same revocation sent again edited nothing');
  assert.equal(journal.filter(row => row.type === 'context_fold' && row.data.reason === 'revoked' && row.data.targets).length, 1);
  // Reopened from the journal, the projection is the same: the folded copies stay out, and the next request is still a valid continuation.
  await session.dispose();
  const reopened = await createSession({ sessionId: 'revoke-anthropic', projectId: 'p', cwd: root, stateDir: join(root, 'state'), sessionFile: file, model: opus, apiKey: KEY, provider, autoCompaction: false, clock: () => now,
    beforeRequest: () => (revoke ? { revokeContext: revoke } : undefined) });
  handles.push(reopened); now += 1000; await reopened.prompt('Five.');
  assert.ok(!JSON.stringify(fake.requests.at(-1).body.messages).includes('first secret'), 'still gone after a reopen');
  const conversation = fake.requests.filter(row => !row.keepAlive), started = (await records(file)).filter(row => row.type === 'request_started');
  assert.equal(started.length, conversation.length, 'one wire request per journaled request');
  for (let index = 1; index < conversation.length; index++) {
    const between = journal.filter(row => row.type === 'thinking_rebase' && row.seq > started[index - 1].seq && row.seq < started[index].seq).map(row => row.data);
    const rebase = between.length ? (between.at(-1).throughMessageId === started[index - 1].data.tailMessageId ? 'tail' : 'response') : undefined;
    assertAppendOnly(conversation[index - 1].body, conversation[index].body, { prevResponse: conversation[index - 1].response, rebase });
  }
  assert.deepEqual(fake.errors, [], 'the endpoint rejected no request');
});

test('an append-only Claude target: a summary that archived a revoked source is withdrawn on the next request, in a journaled rebase, and nothing is rejected', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rna-revoke-summary-')), handles = [];
  let now = Date.parse('2026-10-05T08:00:00Z'), turn = 0, revoke = null, updates = [];
  const fake = createFakeAnthropic({ respond: () => [{ thinking: `think ${++turn}` }, { text: `answer ${turn}` }], now: () => now });
  t.after(async () => { await Promise.allSettled(handles.map(handle => handle.dispose())); await rm(root, { recursive: true, force: true }); });
  const provider = Object.assign(input => streamCompletion({ ...input, fetch: fake.fetch, maxRetries: 0 }), { meteredBase: streamCompletion });
  const session = await createSession({ sessionId: 'revoke-summary', projectId: 'p', cwd: root, stateDir: join(root, 'state'), model: opus, apiKey: KEY, provider, autoCompaction: false, clock: () => now,
    beforeRequest: () => (updates.length || revoke ? { ...(updates.length ? { contextUpdates: updates } : {}), ...(revoke ? { revokeContext: revoke } : {}) } : undefined) });
  handles.push(session);
  const step = async (text, next = []) => { now += 1000; updates = next; await session.prompt(text); };
  await step('One.', [{ key: 'project-collaboration:f1', source: 'host-delivered', scope: 'window', text: `finding ${'a'.repeat(1500)}`, sourceIds: ['action:act-1'] }]);
  await step('Two.'); await step('Three.');
  await session.compact({ summary: 'Earlier: the finding said the Qingdao archive is closed on Mondays.', keepLastTurns: 1 });
  await step('Four.');
  assert.ok(JSON.stringify(fake.requests.at(-1).body.messages).includes('Qingdao archive'), 'the summary stands while nothing is revoked');
  now += 1000; revoke = [{ id: 'privacy', sourceIds: ['action:act-1'] }];
  await step('Five.');
  const sent = JSON.stringify(fake.requests.at(-1).body.messages);
  assert.ok(!sent.includes('Qingdao archive') && !sent.includes('finding aaaa'), 'neither the summary nor the delivered copy reaches the model');
  assert.ok(sent.includes('summary of the earlier part of this conversation was withdrawn'), 'the notice does');
  await step('Six.');
  const journal = await records(session.snapshot().sessionFile);
  const compactions = journal.filter(row => row.type === 'context_compaction').map(row => row.data);
  assert.deepEqual(compactions.map(row => row.trigger ?? 'manual'), ['manual', 'revoked'], 'the summary and its withdrawal');
  assert.equal(journal.filter(row => row.type === 'thinking_rebase').length >= 2, true, 'each edit of earlier history rode a journaled rebase');
  assert.deepEqual(fake.errors, [], 'the endpoint rejected no request: the withdrawal is a valid continuation');
});
