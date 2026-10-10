import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
// The observer is a local QA harness under qa/, which is not part of the repository: without it these tests are skipped.
const observer = new URL('../qa/phase6f-foundation-observer.mjs', import.meta.url);
const { observeProvider, observeReferenceTools, assertModelRequestAdmission } = existsSync(observer) ? await import(observer.href) : {};
const test = observeProvider ? nodeTest : (name, ...rest) => nodeTest(name, { skip: 'needs the local QA observer (qa/phase6f-foundation-observer.mjs)' }, typeof rest.at(-1) === 'function' ? rest.at(-1) : () => {});
import { bootstrapProject } from '../../../packages/sdk/src/bootstrap.mjs';

test('live provider observer preserves request identity, stream events and cancellation signal without saving prompt or reasoning', async () => {
  const signal = new AbortController().signal, request = { systemPrompt: '中文 PRIVATE_PROMPT', messages: [{ content: 'PRIVATE_INPUT' }], model: { maxOutputTokens: 32768, reasoning: 'max' }, signal, apiKey: 'PRIVATE_KEY', tools: [{ name: 'marketplace_plan' }] };
  const events = [{ type: 'thinking_delta', delta: 'PRIVATE_THOUGHT😀' }, { type: 'text_delta', delta: 'PRIVATE_ANSWER' }, { type: 'tool_call', id: 'call-1', name: 'marketplace_plan', arguments: { secret: 'PRIVATE_ARGUMENT' } }, { type: 'done', stopReason: 'toolUse' }];
  const row = { phase: 'research' }; let time = 1000, saves = 0;
  const provider = observeProvider({ getReceipt: () => row, now: () => time, save: () => saves++, complete: async function* (actual) { assert.equal(actual, request); assert.equal(actual.signal, signal); for (const event of events) { time += 10; yield event; } } });
  const received = []; for await (const event of provider(request)) received.push(event);
  received.forEach((event, index) => assert.equal(event, events[index])); assert.equal(row.phase, 'research'); assert.equal(row.phaseSource, 'sdk_request_event'); assert.equal(row.systemPromptUtf8Bytes, Buffer.byteLength(request.systemPrompt)); assert.equal(row.thinkingCharacters, Array.from(events[0].delta).length); assert.equal(row.textCharacters, events[1].delta.length); assert.equal(row.streamElapsedMs, 40); assert.equal(row.firstDeltaLatencyMs, 10); assert.equal(row.emittedToolCalls[0].name, 'marketplace_plan'); assert.ok(saves >= 2);
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE_|😀|arguments|apiKey/); assert.deepEqual(request.model, { maxOutputTokens: 32768, reasoning: 'max' });
});

test('live provider observer propagates the exact error and retains only completed counters', async () => {
  const row = {}, error = new Error('PRIVATE_UPSTREAM'), provider = observeProvider({ getReceipt: () => row, complete: async function* () { yield { type: 'thinking_delta', delta: 'PRIVATE_THOUGHT' }; throw error; } });
  await assert.rejects(async () => { for await (const ignored of provider({ systemPrompt: 'PRIVATE_PROMPT', tools: [] })) {} }, value => value === error);
  assert.equal(row.thinkingDeltaCount, 1); assert.ok(row.streamEndedAt); assert.doesNotMatch(JSON.stringify(row), /PRIVATE_/);
});

test('reference tool observer delegates original argument objects and returns original results with only bounded metadata', async () => {
  const result = { content: [{ type: 'text', text: '{"code":"marketplace_resolution_limit","body":"PRIVATE_SOURCE"}' }], isError: true }, args = ['call-1', { query: 'PRIVATE_QUERY' }, new AbortController().signal];
  let time = 1100, receiver; const tool = { name: 'marketplace_read', async execute(...actual) { receiver = this; actual.forEach((value, index) => assert.equal(value, args[index])); time += 20; return result; } };
  const report = { startedAt: new Date(0).toISOString(), requests: [{ streamStartedAt: new Date(1000).toISOString() }], referenceOperations: [] };
  const [observed] = observeReferenceTools([tool], { report, now: () => time }); assert.equal(await observed.execute(...args), result); assert.equal(receiver, tool); assert.equal(report.firstToolLatencyMs, 100); assert.equal(report.referenceOperations[0].elapsedMs, 20); assert.equal(report.referenceOperations[0].code, 'marketplace_resolution_limit'); assert.equal(report.referenceOperations[0].isError, true);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|query|body/);
});

test('reference tool observer preserves rejection identity without retaining private error text', async () => {
  const error = Object.assign(new Error('PRIVATE_STACK_OR_PATH'), { code: 'PRIVATE INVALID CODE' }), report = { startedAt: new Date().toISOString(), requests: [], referenceOperations: [] };
  const [tool] = observeReferenceTools([{ name: 'marketplace_search', execute: async () => { throw error; } }], { report });
  await assert.rejects(tool.execute('invalid id with spaces', {}), value => value === error); assert.equal(report.referenceOperations[0].toolCallId, null); assert.equal(report.referenceOperations[0].completed, false); assert.equal(report.referenceOperations[0].code, 'tool_failed'); assert.ok(report.referenceOperations[0].endedAt); assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
});

test('the actual bootstrap repair loop cannot send a second provider request after a recorded length stop', async () => {
  const report = { requests: [] }; let calls = 0;
  await assert.rejects(bootstrapProject({ title: 'QA admission fixture', model: { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', maxOutputTokens: 1024 }, maxAttempts: 4,
    beforeRequest: () => assertModelRequestAdmission(report, { requestCap: 12, reportedTokenCap: 300000, deadlineAt: Date.now() + 5000 }),
    provider: async function* () { calls++; yield { type: 'thinking_delta', delta: 'PRIVATE_THOUGHT' }; yield { type: 'usage', usage: { input: 10, output: 1024, totalTokens: 1034 } }; yield { type: 'done', stopReason: 'length' }; },
    onEvent: event => { if (event.type === 'bootstrap_request_start') report.requests.push({ requestId: event.requestId }); if (event.type === 'bootstrap_request_end') Object.assign(report.requests.find(row => row.requestId === event.requestId), { endedAt: new Date().toISOString(), completed: event.completed, stopReason: event.stopReason, usage: event.requestUsage }); },
  }), { code: 'qa_prior_request_failed' });
  assert.equal(calls, 1); assert.equal(report.requests.length, 1); assert.equal(report.requests[0].stopReason, 'length'); assert.equal(report.requests[0].usage.totalTokens, 1034); assert.doesNotMatch(JSON.stringify(report), /PRIVATE_THOUGHT/);
});
