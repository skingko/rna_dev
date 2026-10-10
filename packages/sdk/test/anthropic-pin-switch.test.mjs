import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { streamCompletion } from '../src/providers.mjs';
import { createFakeAnthropic } from './fixtures/fake-anthropic.mjs';
import { assertAppendOnly, thinkingBlocks } from './helpers/append-only.mjs';

// Review P1 (CLAUDE-1/INT-1, CLAUDE-4/INT-4, CLAUDE-7): the pinned prefix after an idle commit by the host's
// maintenance handle, economies committed under another model when a conversation moves to Claude, and a refused
// partial answer. The fake endpoint runs in 'error' mode: any history edit not covered by a rebase is a 400.
const KEY = 'sk-ant-fixture-not-a-real-key';
const opus = { providerId: 'anthropic', modelId: 'claude-opus-5-5', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', contextWindow: 1000000, maxOutputTokens: 64000, reasoning: 'default', compat: { adaptiveThinking: true, thinkingDisplay: 'summarized', thinkingBindingMode: 'error' } };
const glm = { providerId: 'glm', modelId: 'glm-5.3', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', contextWindow: 1000000, maxOutputTokens: 1000, reasoning: 'off' };
const MIN = 60000;
const records = async file => (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const SUMMARY = /^Summarize the provided conversation record/;
const tool = (name, execute, effect = 'read') => ({ name, effect, idempotent: effect === 'read', parameters: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, additionalProperties: false }, execute });
const writeTool = tool('write', async () => 'written', 'write');

async function harness(t, { respond, big = 'x'.repeat(3000), notes = true, ...options } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rna-pin-switch-')), handles = [], glmRequests = [];
  let now = Date.parse('2026-10-04T08:00:00Z'), turn = 0, writes = 0, glmWriting = false;
  // Claude: every turn thinks; it writes a large file while `writing`, else answers.
  let writing = true;
  const fake = createFakeAnthropic({ now: () => now, respond: respond ?? (body => {
    if (SUMMARY.test(body.system?.[0]?.text ?? '')) return [{ text: 'Summary of the earlier work.' }];
    const last = body.messages.at(-1), answered = Array.isArray(last.content) && last.content.some(block => block.type === 'tool_result');
    if (answered || !writing) return [{ thinking: `answer ${turn}` }, { text: 'saved' }];
    return [{ thinking: `plan ${turn}` }, { tool: { id: `toolu_w${++writes}`, name: 'write', input: { path: `f${writes}`, text: big } } }];
  }) });
  // GLM (another protocol, free history editing): writes while `glmWriting`, else answers; usage is reported.
  async function* glmStream(request) {
    glmRequests.push(request);
    const usage = { type: 'usage', usage: { input: 400, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 405, cacheUsageReported: true } };
    if (glmWriting && request.messages.at(-1)?.role !== 'toolResult') { yield { type: 'tool_call', id: `call_g${++writes}`, name: 'write', arguments: { path: `g${writes}`, text: big } }; yield usage; yield { type: 'done', stopReason: 'toolUse' }; return; }
    yield { type: 'text_delta', delta: 'saved' }; yield usage; yield { type: 'done', stopReason: 'stop' };
  }
  const provider = input => input.model.protocol === 'anthropic' ? streamCompletion({ ...input, fetch: fake.fetch, maxRetries: 0 }) : glmStream(input);
  t.after(async () => { await Promise.allSettled(handles.map(handle => handle.dispose())); await rm(root, { recursive: true, force: true }); });
  const base = { sessionId: 'pin-switch', projectId: 'p', cwd: root, stateDir: join(root, 'state'), model: opus, apiKey: KEY, provider, autoCompaction: false, clock: () => now, tools: [writeTool],
    settleArguments: (name, args) => name === 'write' ? { path: args.path, text: '[settled]' } : null,
    beforeRequest: async () => notes ? { contextUpdates: [{ key: 'notes', source: 'host-notes', text: `notes for turn ${turn} ${'n'.repeat(1500)}` }] } : undefined };
  const open = async (extra = {}) => { const session = await createSession({ ...base, ...options, ...extra }); handles.push(session); return session; };
  return { fake, glmRequests, open, advance: ms => { now += ms; }, prompt: async (session, text) => { turn++; await session.prompt(text); },
    set: value => { if (value.writing !== undefined) writing = value.writing; if (value.glmWriting !== undefined) glmWriting = value.glmWriting; } };
}
async function assertSession(fake, file) {
  const journal = await records(file), conversation = fake.requests.filter(row => !row.keepAlive && !SUMMARY.test(row.body.system?.[0]?.text ?? ''));
  const started = journal.filter(row => row.type === 'request_started' && row.data.model?.protocol === 'anthropic');
  assert.equal(started.length, conversation.length, 'one wire request per journaled Claude request');
  for (let index = 1; index < conversation.length; index++) {
    const between = journal.filter(row => row.type === 'thinking_rebase' && row.seq > started[index - 1].seq && row.seq < started[index].seq).map(row => row.data);
    const rebase = between.length ? (between.at(-1).throughMessageId === started[index - 1].data.tailMessageId ? 'tail' : 'response') : undefined;
    assertAppendOnly(conversation[index - 1].body, conversation[index].body, { prevResponse: conversation[index - 1].response, rebase });
  }
  assert.deepEqual(fake.errors, [], 'no request was rejected');
  return journal;
}
const idleCommit = async (h, session, { systemPrompt }) => {
  const file = session.snapshot().sessionFile, plan = session.prepareCompaction({ keepUserTurns: 2 });
  assert.ok(plan);
  await session.dispose();
  await writeFile(`${file}.idle-summary.json`, JSON.stringify({ id: `idle-${plan.throughMessageId}`, sessionId: plan.sessionId, trigger: 'idle', previousCompactionId: plan.previousCompactionId, throughMessageId: plan.throughMessageId, sourceDigest: plan.sourceDigest, summary: 'Summary of the earlier work.', archivedMessages: plan.archivedMessages, retainedMessages: plan.retainedMessages, requestId: `req-${plan.throughMessageId}`, usage: { input: 900, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 920 }, usageReported: true, model: plan.model, beforeTokens: plan.beforeTokens }), { mode: 0o600 });
  h.advance(30 * MIN);
  // The host's maintenance handle (idle-compaction-service.mjs): no conversation prompt, no tools.
  const maintenance = await h.open({ sessionFile: file, tools: [], systemPrompt, beforeRequest: undefined });
  assert.equal(maintenance.commitPreparedCompaction().committed, true);
  await maintenance.dispose();
  return file;
};

test('a system-prompt revision archived by an idle maintenance commit is not lost: the next turn re-pins with the current prompt', async t => {
  const h = await harness(t);
  let session = await h.open({ systemPrompt: 'RULES v1.' });
  for (const text of ['One.', 'Two.']) { await h.prompt(session, text); h.advance(2 * MIN); }
  const file = session.snapshot().sessionFile; await session.dispose();
  // The operator prompt changes: appended as a revision, the pin keeps v1.
  session = await h.open({ systemPrompt: 'RULES v2.', sessionFile: file });
  for (const text of ['Three.', 'Four.', 'Five.']) { await h.prompt(session, text); h.advance(2 * MIN); }
  let journal = await records(file);
  assert.equal(journal.filter(row => row.type === 'message' && row.data.message.role === 'system').length, 1, 'one revision, in turn three');
  // The idle summary keeps turns four and five: the revision lies behind the boundary.
  await idleCommit(h, session, { systemPrompt: 'You are Rna Agent.' });
  journal = await records(file);
  assert.equal(journal.filter(row => row.type === 'prefix_pin').length, 1, 'the maintenance handle left the pin alone');
  session = await h.open({ systemPrompt: 'RULES v2.', sessionFile: file });
  await h.prompt(session, 'Six.');
  journal = await assertSession(h.fake, file);
  const first = h.fake.requests.find(row => JSON.stringify(row.body.messages).includes('Summary of the earlier work.'));
  assert.deepEqual(first.body.system.map(block => block.text), ['RULES v2.'], 'the model reads the current prompt');
  assert.equal(JSON.stringify(first.body).includes('RULES v1'), false, 'the stale pinned prompt is gone');
  const pins = journal.filter(row => row.type === 'prefix_pin');
  assert.equal(pins.length, 2); assert.equal(pins.at(-1).data.systemPrompt, 'RULES v2.');
  assert.deepEqual(journal.filter(row => row.type === 'thinking_rebase').map(row => row.data.reason), ['compaction'], 'the re-pin rides on the compaction\'s rebase');
  assert.deepEqual(thinkingBlocks(first.body.messages), []);
});

test('a revision still after the compaction boundary keeps counting: no duplicate revision, no re-pin', async t => {
  const h = await harness(t);
  let session = await h.open({ systemPrompt: 'RULES v1.' });
  for (const text of ['One.', 'Two.', 'Three.']) { await h.prompt(session, text); h.advance(2 * MIN); }
  const file = session.snapshot().sessionFile; await session.dispose();
  session = await h.open({ systemPrompt: 'RULES v2.', sessionFile: file });
  for (const text of ['Four.', 'Five.']) { await h.prompt(session, text); h.advance(2 * MIN); }
  await idleCommit(h, session, { systemPrompt: 'You are Rna Agent.' });
  session = await h.open({ systemPrompt: 'RULES v2.', sessionFile: file });
  await h.prompt(session, 'Six.');
  const journal = await assertSession(h.fake, file);
  assert.equal(journal.filter(row => row.type === 'message' && row.data.message.role === 'system').length, 1, 'the kept revision is still the one in force');
  assert.equal(journal.filter(row => row.type === 'prefix_pin').length, 1);
  const last = h.fake.requests.at(-1).body;
  assert.deepEqual(last.system.map(block => block.text), ['RULES v1.']);
  assert.ok(last.messages.some(message => message.role === 'system' && JSON.stringify(message.content).includes('RULES v2.')), 'the revision reaches the model');
});

test('a conversation built on another model keeps its settles and folds when it moves to Claude: one rebase at the switch', async t => {
  const h = await harness(t, { model: glm, cacheSurvivalMs: MIN });
  h.set({ glmWriting: true });
  const session = await h.open({ model: glm, apiKey: 'glm-fixture-key' });
  // Four GLM turns, each after the learned survival: the last one is a cold break that settles and folds.
  for (const text of ['One.', 'Two.', 'Three.', 'Four.']) { await h.prompt(session, text); h.advance(5 * MIN); }
  const file = session.snapshot().sessionFile;
  let journal = await records(file);
  assert.ok(journal.some(row => row.type === 'context_settle'), 'GLM settled earlier writes');
  assert.ok(journal.some(row => row.type === 'context_fold'), 'GLM folded earlier notes');
  assert.ok(!journal.some(row => row.type === 'prefix_pin'), 'no pin on another protocol');
  const glmLast = JSON.stringify(h.glmRequests.at(-1).messages);
  assert.match(glmLast, /\[settled\]/);
  // Switch to Claude: the first Claude request keeps every economy GLM committed.
  session.setModel(opus, { apiKey: KEY, reason: 'user' });
  h.set({ writing: false });
  await h.prompt(session, 'Five.');
  journal = await assertSession(h.fake, file);
  const rebase = journal.find(row => row.type === 'thinking_rebase'), pin = journal.find(row => row.type === 'prefix_pin');
  assert.equal(rebase?.data.reason, 'prefix_changed', 'a rebase at the switch');
  assert.ok(rebase.seq < pin.seq, 'journaled before the first pin');
  const first = JSON.stringify(h.fake.requests[0].body.messages);
  assert.match(first, /\[settled\]/, 'settled writes stay settled');
  assert.match(first, /Superseded: a later update of \\"notes\\"/, 'folded notes stay folded');
  const whole = text => text.split('x'.repeat(3000)).length - 1;
  assert.ok(whole(glmLast) < 4, 'GLM already sent some writes settled');
  assert.ok(whole(first) <= whole(glmLast), `no settled payload comes back whole (${whole(first)} vs ${whole(glmLast)})`);
});

test('back on Claude after a GLM epoch its own reasoning stays; the GLM economies apply at the next context-pressure rebase instead of a summary', async t => {
  const big = 'y'.repeat(30000);
  const h = await harness(t, { big, notes: false, cacheSurvivalMs: MIN });
  let session = await h.open();
  for (const text of ['One.', 'Two.']) { await h.prompt(session, text); h.advance(2 * MIN); }
  // GLM epoch: three cold answers; the third settles the two Claude-epoch writes (free editing on GLM).
  session.setModel(glm, { apiKey: 'glm-fixture-key', reason: 'user' });
  for (const text of ['Three.', 'Four.', 'Five.']) { await h.prompt(session, text); h.advance(5 * MIN); }
  const file = session.snapshot().sessionFile;
  assert.ok((await records(file)).some(row => row.type === 'context_settle'), 'GLM settled the earlier writes');
  // Back on Claude: its signed reasoning from the first epoch is still replayable, so no rebase at the switch; the
  // settled writes wait (an append-only projection applies economies only at or before the floor).
  session.setModel(opus, { apiKey: KEY, reason: 'user' }); h.set({ writing: false });
  await h.prompt(session, 'Six.');
  let journal = await assertSession(h.fake, file);
  assert.deepEqual(journal.filter(row => row.type === 'thinking_rebase'), [], 'no rebase while Claude reasoning would be lost');
  assert.equal(JSON.stringify(h.fake.requests.at(-1).body.messages).includes(big), true, 'the writes are whole on Claude for now');
  assert.equal(thinkingBlocks(h.fake.requests.at(-1).body.messages).length, 4, 'every Claude reasoning block is replayed');
  const estimate = session.snapshot().contextUsage.estimatedInputTokens; await session.dispose();
  // Context pressure: the blocking trigger. Nothing new to settle, fold or forget, but the recorded settles free
  // enough: a context_pressure rebase applies them and no summary is paid for.
  session = await h.open({ sessionFile: file, model: { ...opus, contextWindow: Math.floor((estimate + 400) / 0.9), maxOutputTokens: 500 }, autoCompaction: true });
  await h.prompt(session, 'Seven.');
  journal = await assertSession(h.fake, file);
  assert.deepEqual(journal.filter(row => row.type === 'thinking_rebase').map(row => row.data.reason), ['context_pressure']);
  assert.equal(journal.some(row => row.type === 'context_compaction'), false, 'no summary');
  assert.equal(h.fake.requests.some(row => SUMMARY.test(row.body.system?.[0]?.text ?? '')), false, 'no summary request');
  const last = JSON.stringify(h.fake.requests.at(-1).body.messages);
  assert.match(last, /\[settled\]/); assert.equal(last.includes(big), false);
});

test('a refused partial answer is journaled empty: the next request does not replay it', async t => {
  let call = 0;
  const h = await harness(t, { notes: false, respond: () => call++ === 0 ? Object.assign([{ text: 'Here is how to start: step one is' }], { stopReason: 'refusal', stopDetails: { type: 'refusal', category: 'cyber' } }) : [{ text: 'A different answer.' }] });
  const session = await h.open();
  await assert.rejects(h.prompt(session, 'Explain.'), error => error.code === 'provider_termination' && error.errorDiagnostic?.category === 'refusal');
  const journal = await records(session.snapshot().sessionFile), completed = journal.find(row => row.type === 'request_completed');
  assert.deepEqual(completed.data.message.content, [], 'the partial is not kept');
  assert.equal(completed.data.message.stopReason, 'error'); assert.equal(completed.data.message.errorDiagnostic.category, 'refusal');
  await h.prompt(session, 'Something else.');
  assert.equal(JSON.stringify(h.fake.requests.at(-1).body.messages).includes('step one is'), false, 'the declined partial is never sent back');
  assert.deepEqual(h.fake.errors, []);
});
