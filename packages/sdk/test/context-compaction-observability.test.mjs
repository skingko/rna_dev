import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';

const model = { providerId: 'context-fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 6000, maxOutputTokens: 500, reasoning: 'off' };
const plain = message => message.content?.filter(part => part.type === 'text').map(part => part.text).join('');
const isSummary = request => request.systemPrompt.startsWith('Summarize the provided');
const receipt = cacheUsageReported => ({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, ...(cacheUsageReported !== undefined ? { cacheUsageReported } : {}) });
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-context-observability-')), handles = [];
  const args = { sessionId: 'context-observability', projectId: 'context-project', cwd: dir, stateDir: join(dir, 'state'), model, ...options };
  const create = async extra => { const session = await createSession({ ...args, ...extra }); handles.push(session); return session; };
  t.after(async () => { await Promise.allSettled(handles.map(session => session.dispose())); await rm(dir, { recursive: true, force: true }); });
  return { session: await create(), create };
}

test('automatic compression exposes current pressure and immediate reduced projection without losing tool groups or billing', async t => {
  let responses = 0, summaries = 0, executions = 0; const events = [], requests = [];
  const { session, create } = await fixture(t, {
    maxSteps: 30, onEvent: event => events.push(event),
    tools: [{ name: 'inspect', effect: 'read', description: 'Read local fixture evidence.', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => { executions++; return `completed:${executions} ${'evidence '.repeat(280)}`; } }],
    provider: async function* (request) {
      requests.push(request);
      if (isSummary(request)) {
        summaries++; assert.equal(request.tools.length, 0);
        // Complete groups only: as many tool results as tool calls in the summary transcript.
        const source = plain(request.messages[0]);
        const calls = (source.match(/^\[Assistant tool calls\]: .*$/gm) ?? []).reduce((sum, line) => sum + line.split('; ').length, 0);
        assert.ok(calls > 0); assert.equal(calls, (source.match(/^\[Tool result/gm) ?? []).length);
        yield { type: 'text_delta', delta: 'Completed read evidence remains available. Continue the original authorized read task.' };
      } else {
        if (summaries) {
          const projected = events.findLast(event => event.type === 'context_usage').usage;
          assert.equal(projected.status, 'ready'); assert.ok(projected.compactionId);
          assert.ok(projected.afterTokens < projected.beforeTokens);
        }
        if (++responses <= 16) yield { type: 'tool_call', id: `read-${responses}`, name: 'inspect', arguments: {} };
        else yield { type: 'text_delta', delta: 'Verified evidence ready.' };
      }
      yield { type: 'usage', usage: receipt(true) }; yield { type: 'done', stopReason: 'stop' };
    }
  });
  await session.prompt('Inspect the evidence; no writes are authorized.');
  assert.equal(executions, 16); assert.ok(summaries >= 1);
  const saved = session.snapshot(), updates = events.filter(event => event.type === 'context_usage');
  assert.equal(saved.usage.totalTokens, requests.length * 12);
  assert.equal(saved.contextUsage.estimatedInputTokens, saved.cache.estimatedInputTokens);
  assert.equal(saved.contextUsage.inputTrigger, 4300);
  assert.equal(saved.contextUsage.outputReserve, 500);
  assert.equal(saved.contextUsage.capacity, 6000);
  assert.equal(saved.contextUsage.automaticEnabled, true);
  assert.ok(updates.some(event => event.usage.status === 'compacting' && event.usage.requestId));
  assert.equal(updates.at(-1).usage.status, 'ready');
  assert.equal(saved.messages.filter(message => message.role === 'toolResult').length, executions);
  assert.equal(events.filter(event => event.type === 'compaction_request_end').length, summaries);
  assert.ok(events.filter(event => event.type === 'compaction_request_end').every(event => event.usage.cacheUsageReported === true));
  assert.ok(saved.messages.filter(message => message.role === 'assistant').every(message => message.usage.cacheUsageReported === true));
  assert.ok(updates.length <= requests.length * 3, 'context updates happen at stable boundaries, never per token');
  await session.dispose(); const reopened = await create({ sessionFile: saved.sessionFile });
  assert.deepEqual(reopened.snapshot().contextUsage, saved.contextUsage);
  assert.equal(reopened.snapshot().usage.totalTokens, saved.usage.totalTokens);
  assert.deepEqual(reopened.snapshot().messages, saved.messages);
});

test('manual compaction publishes reduced current input immediately without a following request and survives reopening', async t => {
  let requests = 0; const events = [];
  const { session, create } = await fixture(t, { model: { ...model, contextWindow: 100000 }, onEvent: event => events.push(event), provider: async function* () {
    requests++; yield { type: 'text_delta', delta: 'verified fact '.repeat(600) }; yield { type: 'usage', usage: receipt() }; yield { type: 'done', stopReason: 'stop' };
  } });
  for (let i = 0; i < 4; i++) await session.prompt(`task-${i}`);
  const before = session.snapshot(); await session.compact({ summary: 'Four earlier tasks produced verified fixture facts.', keepLastTurns: 1 });
  const after = session.snapshot();
  assert.equal(requests, 4); assert.equal(after.usage.totalTokens, before.usage.totalTokens);
  assert.deepEqual(after.messages, before.messages);
  assert.ok(after.contextUsage.estimatedInputTokens < before.contextUsage.estimatedInputTokens);
  assert.equal(after.contextUsage.afterTokens, after.contextUsage.estimatedInputTokens);
  assert.equal(after.contextUsage.beforeTokens, before.contextUsage.estimatedInputTokens);
  assert.deepEqual(events.findLast(event => event.type === 'context_usage').usage, after.contextUsage);
  assert.equal(after.messages.at(-1).usage.cacheUsageReported, false, 'missing cache metadata remains unknown');
  await session.dispose(); const reopened = await create({ sessionFile: after.sessionFile });
  assert.deepEqual(reopened.snapshot().contextUsage, after.contextUsage);
});

test('context usage is the latest input projection rather than summed charged tokens and tracks the selected model after reopen', async t => {
  const { session, create } = await fixture(t, { model: { ...model, contextWindow: 32000 }, provider: async function* () {
    yield { type: 'text_delta', delta: 'done' }; yield { type: 'usage', usage: { input: 1000, output: 20, cacheRead: 800, cacheWrite: 0, totalTokens: 1820, cacheUsageReported: true } }; yield { type: 'done', stopReason: 'stop' };
  } });
  for (let i = 0; i < 5; i++) await session.prompt(`short ${i}`);
  const saved = session.snapshot();
  assert.equal(saved.usage.totalTokens, 9100);
  assert.ok(saved.contextUsage.estimatedInputTokens >= 1820 && saved.contextUsage.estimatedInputTokens < 2000);
  assert.match(saved.contextUsage.method, /provider usage/);
  await session.dispose(); const reopened = await create({ sessionFile: saved.sessionFile, model: { ...model, modelId: 'other-model', contextWindow: 16000, maxOutputTokens: 2000 } });
  const projected = reopened.snapshot().contextUsage;
  assert.equal(projected.capacity, 16000); assert.equal(projected.outputReserve, 2000); assert.equal(projected.inputTrigger, 10800);
  assert.match(projected.method, /^provider usage \(earlier prefix or model\)/, 'another model of the same provider is an approximate anchor (Pi: last usage plus new tail)');
  assert.ok(projected.estimatedInputTokens >= 1820 && projected.estimatedInputTokens < 2000);
  assert.equal(reopened.snapshot().usage.totalTokens, 9100);
});

for (const failure of ['length', 'cancelled']) test(`${failure} compaction clears in-progress projection, preserves history and keeps observed fees`, async t => {
  const events = []; const abort = new AbortController();
  const { session } = await fixture(t, { model: { ...model, contextWindow: 100000 }, onEvent: event => events.push(event), provider: async function* (request) {
    yield { type: 'text_delta', delta: isSummary(request) ? 'unfinished summary' : 'evidence '.repeat(500) };
    yield { type: 'usage', usage: receipt(true) };
    if (isSummary(request) && failure === 'cancelled') { abort.abort(); request.signal.throwIfAborted(); }
    yield { type: 'done', stopReason: isSummary(request) ? 'length' : 'stop' };
  } });
  for (let i = 0; i < 3; i++) await session.prompt(`task-${i}`);
  const before = session.snapshot();
  await assert.rejects(session.compact({ generate: true, signal: abort.signal }), failure === 'length' ? { code: 'invalid_summary' } : undefined);
  const after = session.snapshot();
  assert.equal(after.compaction, null); assert.deepEqual(after.messages, before.messages);
  assert.equal(after.contextUsage.estimatedInputTokens, before.contextUsage.estimatedInputTokens);
  assert.equal(after.contextUsage.status, 'ready');
  assert.equal(events.findLast(event => event.type === 'context_usage').usage.status, 'ready');
  assert.ok(events.some(event => event.type === 'context_usage' && event.usage.status === 'compacting'));
  const fee = events.findLast(event => event.type === 'compaction_request_end');
  assert.equal(fee.usage.totalTokens, 12); assert.equal(fee.usageReported, true); assert.equal(fee.usage.cacheUsageReported, true);
  assert.equal(after.usage.totalTokens, before.usage.totalTokens + 12);
});

test('explicitly disabled automatic compaction retains bounded evaluation policy and emits no summary request', async t => {
  let requests = 0;
  const { session } = await fixture(t, { autoCompaction: false, provider: async function* (request) {
    assert.equal(isSummary(request), false); requests++; yield { type: 'text_delta', delta: 'evidence '.repeat(600) }; yield { type: 'done', stopReason: 'stop' };
  } });
  let rejected;
  for (let i = 0; i < 20; i++) { try { await session.prompt(`task-${i}`); } catch (error) { rejected = error; break; } }
  assert.equal(rejected?.code, 'context_limit'); assert.ok(requests >= 2); assert.equal(session.snapshot().compaction, null);
  assert.equal(session.snapshot().contextUsage.automaticEnabled, false);
});

test('many text deltas do not create repeated context measurements or duplicate usage accounting', async t => {
  const events = [];
  const { session } = await fixture(t, { onEvent: event => events.push(event), provider: async function* () {
    for (let i = 0; i < 100; i++) yield { type: 'text_delta', delta: 'a' };
    yield { type: 'usage', usage: { ...receipt(true), totalTokens: 10 } }; yield { type: 'usage', usage: receipt(true) }; yield { type: 'done', stopReason: 'stop' };
  } });
  await session.prompt('short');
  assert.equal(events.filter(event => event.type === 'context_usage').length, 2);
  assert.equal(session.snapshot().usage.totalTokens, 12);
  const journal = (await readFile(session.snapshot().sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(journal.filter(row => row.type === 'event' && row.data?.type === 'context_usage').length, 2);
});

test('automatic compaction between the 80% and 90% triggers runs after the answer; above 90% it runs before the request', async t => {
  const calls = []; let reported = 0;
  const provider = async function* (request) {
    calls.push(isSummary(request) ? 'summary' : plain(request.messages.findLast(message => message.role === 'user')));
    if (isSummary(request)) { yield { type: 'text_delta', delta: 'Earlier tasks produced fixture evidence.' }; yield { type: 'done', stopReason: 'stop' }; return; }
    reported += 2600;
    yield { type: 'text_delta', delta: 'evidence '.repeat(700) }; yield { type: 'usage', usage: { input: reported - 600, output: 600, cacheRead: 0, cacheWrite: 0, totalTokens: reported } }; yield { type: 'done', stopReason: 'stop' };
  };
  const small = { ...model, contextWindow: 10000, maxOutputTokens: 500 };
  const { session, create } = await fixture(t, { model: small, provider });
  for (const task of ['task-1', 'task-2']) await session.prompt(task);
  assert.deepEqual(calls, ['task-1', 'task-2'], 'below the trigger nothing is summarized');
  await session.prompt('task-3');
  assert.deepEqual(calls, ['task-1', 'task-2', 'task-3', 'summary'], 'the answer is requested first; the summary follows the completed run');
  const usage = session.snapshot().contextUsage;
  assert.ok(usage.compactionId); assert.equal(usage.inputTrigger, 7500); assert.equal(usage.blockingTrigger, 8500);
  await session.dispose();
  // A log that already exceeds the blocking trigger (e.g. automatic compaction
  // was disabled earlier) is summarized before the next request.
  const other = await create({ sessionId: 'blocking', autoCompaction: false }); calls.length = 0; reported = 0;
  for (const task of ['a', 'b', 'c', 'd']) await other.prompt(task);
  assert.ok(other.snapshot().contextUsage.estimatedInputTokens > 8500); await other.dispose();
  const reopened = await create({ sessionId: 'blocking' }); calls.length = 0;
  await reopened.prompt('e');
  assert.deepEqual(calls.slice(0, 2), ['summary', 'e'], 'above the blocking trigger the summary precedes the request');
});
