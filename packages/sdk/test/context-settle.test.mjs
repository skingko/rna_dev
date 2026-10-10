import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';

// Seen live (2026-10-01): a novel session re-read ~400k tokens on every step, about half of it chapter text the
// model had already written to files (write contents and python heredocs). After a run, text written in earlier
// turns is set aside in the model's view when it frees a real share of the context; the journal keeps it.
const model = { providerId: 'settle-fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 1000000, maxOutputTokens: 500, reasoning: 'off' };
const receipt = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 };
const NOTE = '[set aside]';
// What a warm edit must free is computed from the model's cache prices and this conversation's requests per run
// (cache-economics.mjs). A run here is two requests (the write, then the answer), so a cache read at 0.6 of the uncached
// rate makes the share (1 − 0.6) / (1 + 0.6) = 0.25, the figure these scenarios were written for.
const PRICING = { input: 1, cacheRead: 0.6 };
const settleArguments = (name, args) => name === 'write' && args.content.length > 100 ? { ...args, content: NOTE } : null;

async function fixture(t, { hook = settleArguments, forgetStale, size = 6000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-context-settle-')), handles = [], requests = [];
  let calls = 0;
  const provider = async function* (request) {
    requests.push(request);
    if (request.messages.at(-1).role === 'user') yield { type: 'tool_call', id: `write-${++calls}`, name: 'write', arguments: { path: `ch${calls}.md`, content: `第${calls}章 ${'正文'.repeat(size)}` } };
    else yield { type: 'text_delta', delta: 'written' };
    yield { type: 'usage', usage: receipt }; yield { type: 'done', stopReason: 'stop' };
  };
  const tools = [{ name: 'write', effect: 'write', description: 'Write a fixture file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, additionalProperties: false }, execute: async (_id, args) => `wrote ${args.path}` }];
  const args = { sessionId: 'context-settle', projectId: 'settle-project', cwd: dir, stateDir: join(dir, 'state'), model, tools, provider, settleArguments: hook, forgetStale, cachePricing: PRICING };
  const create = async extra => { const session = await createSession({ ...args, ...extra }); handles.push(session); return session; };
  t.after(async () => { await Promise.allSettled(handles.map(session => session.dispose())); await rm(dir, { recursive: true, force: true }); });
  return { session: await create(), create, requests };
}
const wire = request => JSON.stringify(request.messages);

test('text written in earlier turns is set aside after a run; the last two turns stay whole; the journal keeps it and reopening keeps the choice', async t => {
  const forgets = [];
  const f = await fixture(t, { forgetStale: async input => { forgets.push(input); return []; } });
  await f.session.prompt('Write chapter 1.'); await f.session.prompt('Write chapter 2.');
  assert.ok(!wire(f.requests.at(-1)).includes(NOTE), 'two turns: nothing outside the protected range yet');
  await f.session.prompt('Write chapter 3.');
  assert.ok(!f.requests.some(request => wire(request).includes(NOTE)), 'the third run: chapters 1 and 2 are the last two completed turns');
  const before = f.session.snapshot().contextUsage.estimatedInputTokens;
  await f.session.prompt('Write chapter 4.');
  // ECON-1: the first request of turn 4 keeps the two completed turns before it (chapters 2 and 3) whole, as the
  // after-run pass did before TC-4 moved it; chapter 1 is the note.
  const last = wire(f.requests.at(-2));
  assert.ok(last.includes(NOTE), 'chapter 1 is a note'); assert.ok(!last.includes('第1章'));
  assert.ok(last.includes(`第2章 ${'正文'.repeat(100)}`) && last.includes(`第3章 ${'正文'.repeat(100)}`), 'chapters 2 and 3 keep their text');
  assert.ok(f.session.snapshot().contextUsage.estimatedInputTokens < before + 6000, 'the estimate drops with the note (chapter 4 added, chapter 1 set aside)');
  assert.equal(forgets.length, 0, 'no result large enough to judge here (the forget pass runs with the settle pass)');
  const saved = f.session.snapshot();
  assert.match(JSON.stringify(saved.messages), /第1章 正文正文/, 'the journal keeps the written text');
  await f.session.dispose();
  const reopened = await f.create({ sessionFile: saved.sessionFile });
  await reopened.prompt('Anything else?');
  assert.ok(wire(f.requests.at(-2)).includes(NOTE)); assert.ok(!wire(f.requests.at(-2)).includes('第1章'));
});

test('nothing is set aside when it would free too little of the context, or when the host has no hook', async t => {
  // Small writes against a large context: below the break-even share, the cached prefix is worth more than the saving.
  const f = await fixture(t, { size: 60, hook: (name, args) => ({ ...args, content: NOTE }) });
  await f.session.prompt(`Background: ${'资料'.repeat(20000)}`);
  for (const index of [2, 3, 4]) await f.session.prompt(`Write chapter ${index}.`);
  assert.ok(!f.requests.some(request => wire(request).includes(NOTE)), `below the break-even share (${f.session.cacheBreakEven().share}) of the context`);
  const g = await fixture(t, { hook: null });
  for (const index of [1, 2, 3, 4]) await g.session.prompt(`Write chapter ${index}.`);
  assert.ok(!g.requests.some(request => wire(request).includes(NOTE)));
});

// DeepSeek harness (dsh-compaction-tool-result-pruner): an earlier result over 8192 characters keeps its first 4096
// and last 1024 around a marker; the settle pass counts it toward the share and the journal keeps it whole.
test('earlier large tool results keep their head and tail in the same pass; recent ones stay whole', async t => {
  const { PRUNE_MARKER, prunedResultContent } = await import('../src/context.mjs');
  assert.equal(prunedResultContent([{ type: 'text', text: 'x'.repeat(3000) }]), null, 'a small result stays');
  const kept = prunedResultContent([{ type: 'text', text: `${'头'.repeat(5000)}${'中'.repeat(20000)}${'尾'.repeat(2000)}` }]);
  assert.equal(kept[0].text, `${'头'.repeat(4096)}${PRUNE_MARKER}${'尾'.repeat(1024)}`, 'head and tail by code point');
  const dir = await mkdtemp(join(tmpdir(), 'rna-context-prune-')), requests = [];
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const provider = async function* (request) {
    requests.push(request);
    if (request.messages.at(-1).role === 'user') yield { type: 'tool_call', id: `read-${++calls}`, name: 'read', arguments: { path: `ref-${calls}.md` } };
    else yield { type: 'text_delta', delta: 'read it' };
    yield { type: 'usage', usage: receipt }; yield { type: 'done', stopReason: 'stop' };
  };
  const tools = [{ name: 'read', effect: 'read', description: 'Read a reference.', parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false }, execute: async (_id, args) => `${args.path} 开头 ${'参考正文'.repeat(6000)} 结尾 ${args.path}` }];
  const session = await createSession({ sessionId: 'context-prune', projectId: 'p', cwd: dir, stateDir: join(dir, 'state'), model, tools, provider, cachePricing: PRICING, settleArguments: () => null });
  t.after(() => session.dispose());
  for (const index of [1, 2, 3, 4]) await session.prompt(`Read reference ${index}.`);
  const sent = wire(requests.at(-1));
  assert.ok(sent.includes('the middle of this earlier result was set aside'), 'reference 1 is pruned');
  assert.ok(sent.includes('结尾 ref-1.md'), 'its tail stays'); assert.ok(sent.includes('ref-4.md 开头'));
  assert.equal(sent.split('参考正文'.repeat(1000)).length - 1 >= 1, true, 'the recent results stay whole');
  assert.match(JSON.stringify(session.snapshot().messages), /ref-1\.md 开头 (参考正文){6000}/, 'the journal keeps it whole');
});

// TC-4 (spec p1 compaction §B5): nothing is settled in a run's finally — the cache is warm right after an answer.
// The next run's first request decides: warm, only when settle + prune + forget free at least the break-even share; cold
// (idle past the cache survival), any saving.
test('settling waits for the next run; warm needs the share, a cold break takes any saving', async t => {
  let now = Date.parse('2026-10-04T08:00:00Z');
  const f = await fixture(t, { size: 300, hook: (name, args) => ({ ...args, content: NOTE }) });
  await f.session.dispose();
  const session = await f.create({ sessionId: 'context-settle-cold', clock: () => now, cacheSurvivalMs: 3600000 });
  await session.prompt(`Background: ${'资料'.repeat(20000)}`);
  for (const index of [2, 3, 4]) await session.prompt(`Write chapter ${index}.`);
  const log = () => readFile(session.snapshot().sessionFile, 'utf8');
  assert.doesNotMatch(await log(), /"type":"context_settle"/, `warm and below the break-even share (${session.cacheBreakEven().share}) of the context: nothing settles`);
  assert.ok(!f.requests.some(request => wire(request).includes(NOTE)));
  now += 2 * 3600000;
  await session.prompt('Write chapter 5.');
  assert.match(await log(), /"type":"context_settle"/, 'cold: any positive saving is committed');
  const first = wire(f.requests.at(-2));
  assert.ok(first.includes(NOTE), 'already in the first request of the cold run');
  // ECON-1, cold: chapters 3 and 4 (the two completed turns before this run) stay whole; 1 and 2 are notes.
  assert.ok(first.includes(`第3章 ${'正文'.repeat(300)}`) && first.includes(`第4章 ${'正文'.repeat(300)}`), 'the last two completed turns keep their text');
  assert.ok(!first.includes('第1章') && !first.includes('第2章'), 'earlier chapters are notes');
  const records = (await log()).trim().split('\n').map(line => JSON.parse(line));
  const settledAt = records.findIndex(row => row.type === 'context_settle'), runStart = records.findLastIndex((row, index) => index < settledAt && row.type === 'run_started'), runEnd = records.findLastIndex((row, index) => index < settledAt && row.type === 'run_settled');
  assert.ok(runStart > runEnd, 'committed inside the next run, never in the previous run\'s finally');
});

test('a deferred compaction settles first and needs no summary when that is enough', async t => {
  const requests = [], root = await mkdtemp(join(tmpdir(), 'rna-settle-deferred-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const provider = async function* (request) {
    requests.push(request);
    if (request.systemPrompt.startsWith('Summarize the provided')) yield { type: 'text_delta', delta: 'summary' };
    else if (request.messages.at(-1).role === 'user') yield { type: 'tool_call', id: `write-${++calls}`, name: 'write', arguments: { path: `ch${calls}.md`, content: `第${calls}章 ${'正文'.repeat(1500)}` } };
    else yield { type: 'text_delta', delta: 'written' };
    yield { type: 'usage', usage: receipt }; yield { type: 'done', stopReason: 'stop' };
  };
  const tools = [{ name: 'write', effect: 'write', description: 'Write.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, additionalProperties: false }, execute: async (_id, args) => `wrote ${args.path}` }];
  const session = await createSession({ sessionId: 'settle-deferred', projectId: 'p', cwd: root, stateDir: join(root, 'state'), model: { ...model, contextWindow: 16000, maxOutputTokens: 500 }, tools, provider, cachePricing: PRICING, settleArguments });
  t.after(() => session.dispose());
  for (const index of [1, 2, 3, 4]) await session.prompt(`Write chapter ${index}.`);
  assert.equal(requests.filter(request => request.systemPrompt.startsWith('Summarize the provided')).length, 0, 'settling the earlier chapters kept the context under the trigger');
  assert.match(JSON.stringify(session.snapshot().messages), /第1章 正文/, 'the journal keeps the text');
  assert.ok(wire(requests.at(-1)).includes(NOTE));
});

// ECON-4: a model that streams no usage (compat.supportsUsageInStreaming: false) still reaches the economy point:
// the cold/warm decision is anchored on the last request the session sent, not on the last one that reported usage.
const silentProvider = (requests, size, { silent = () => true } = {}) => {
  let calls = 0;
  return async function* (request) {
    requests.push(request);
    if (request.messages.at(-1).role === 'user') yield { type: 'tool_call', id: `write-${++calls}`, name: 'write', arguments: { path: `ch${calls}.md`, content: `第${calls}章 ${'正文'.repeat(size)}` } };
    else yield { type: 'text_delta', delta: 'written' };
    if (!silent(request)) yield { type: 'usage', usage: receipt };
    yield { type: 'done', stopReason: 'stop' };
  };
};
const writeTool = [{ name: 'write', effect: 'write', description: 'Write a fixture file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, additionalProperties: false }, execute: async (_id, args) => `wrote ${args.path}` }];
const silentModel = { ...model, modelId: 'silent', compat: { supportsUsageInStreaming: false } };

test('without streamed usage, earlier writes are still set aside: warm with the share, and at a cold break', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rna-settle-silent-')), requests = [], cold = [];
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = await createSession({ sessionId: 'settle-silent', projectId: 'p', cwd: root, stateDir: join(root, 'state'), model: silentModel, tools: writeTool, provider: silentProvider(requests, 6000), cachePricing: PRICING, settleArguments });
  t.after(() => session.dispose());
  for (const index of [1, 2, 3, 4]) await session.prompt(`Write chapter ${index}.`);
  assert.equal(session.snapshot().messages.some(message => message.usageReported === true), false, 'no response reported usage');
  const first = wire(requests.at(-2));
  assert.ok(first.includes(NOTE) && !first.includes('第1章'), 'warm, over the share: chapter 1 is a note in the first request of turn 4');
  // Cold: idle past the survival estimate, a small saving is committed too.
  let now = Date.parse('2026-10-04T08:00:00Z');
  const quiet = await createSession({ sessionId: 'settle-silent-cold', projectId: 'p', cwd: root, stateDir: join(root, 'cold'), model: silentModel, tools: writeTool, provider: silentProvider(cold, 300), cachePricing: PRICING, settleArguments: (name, args) => ({ ...args, content: NOTE }), clock: () => now, cacheSurvivalMs: 3600000 });
  t.after(() => quiet.dispose());
  await quiet.prompt(`Background: ${'资料'.repeat(20000)}`);
  for (const index of [2, 3, 4]) await quiet.prompt(`Write chapter ${index}.`);
  assert.ok(!cold.some(request => wire(request).includes(NOTE)), 'warm and below the share: nothing yet');
  now += 2 * 3600000;
  await quiet.prompt('Write chapter 5.');
  assert.ok(wire(cold.at(-2)).includes(NOTE), 'cold: committed in the first request');
});

test('after a switch to a model without streamed usage, only the first run on it is a model-change break', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rna-settle-switch-')), requests = [], reasons = [];
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = await createSession({ sessionId: 'settle-switch', projectId: 'p', cwd: root, stateDir: join(root, 'state'), model, tools: writeTool, provider: silentProvider(requests, 300, { silent: request => request.model.modelId === 'silent' }), cachePricing: PRICING, settleArguments: (name, args) => ({ ...args, content: NOTE }), onEvent: event => { if (event.type === 'context_economy') reasons.push(event.reason); } });
  t.after(() => session.dispose());
  await session.prompt(`Background: ${'资料'.repeat(20000)}`);
  for (const index of [2, 3]) await session.prompt(`Write chapter ${index}.`);
  session.setModel(silentModel, { reason: 'user' });
  for (const index of [4, 5, 6]) await session.prompt(`Write chapter ${index}.`);
  const log = (await readFile(session.snapshot().sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(log.filter(row => row.type === 'context_settle').length, 1, 'the model change is cold once; later runs on the silent model are warm (small savings wait)');
  assert.deepEqual(reasons, ['model_change']);
});
