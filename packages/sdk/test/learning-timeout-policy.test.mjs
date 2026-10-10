import test from 'node:test';
import assert from 'node:assert/strict';
import { reflectProjectLearning } from '../src/learning.mjs';
import { decideInitiative, InitiativeCoordinator, initiativeFailure } from '../src/initiative.mjs';
import { streamCompletion, iterateCompletion, resolveCompletionTimeoutPolicy } from '../src/providers.mjs';

const model = { providerId: 'fixture', modelId: 'deepseek-v4-pro', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', contextWindow: 128000, maxOutputTokens: 4096 };
const episode = { id: 'e1', fingerprint: 'fp1', kind: 'work_result', summary: 'A real completed tool found an invalid parameter.', at: '2026-09-26T00:00:00Z' };
const decision = { outcome: 'no_change', reason: 'One observation is insufficient.', evidenceIds: ['e1'], diagnosis: 'Review the observed boundary.', hypothesis: '', intervention: '', validationPlan: '', limitations: 'No verified improvement.', nextReviewAfterMs: 60000 };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const finishFrame = value => ({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: 'stop' }] });
function transport() {
  const entered = deferred(), encoder = new TextEncoder(), wire = [], requests = [];
  let body, calls = 0;
  const fetch = async (_url, options) => {
    calls++; wire.push(JSON.parse(options.body));
    const response = new Response(new ReadableStream({ start(controller) { body = controller; } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    entered.resolve(); return response;
  };
  return { entered: entered.promise, wire, requests, get calls() { return calls; },
    provider: async function* (request) { requests.push(request); yield* streamCompletion({ ...request, fetch, maxRetries: 0 }); },
    send: value => body.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)),
    finish(value) { body.enqueue(encoder.encode(`data: ${JSON.stringify(finishFrame(value))}\n\ndata: [DONE]\n\n`)); body.close(); },
  };
}

test('one shared timeout policy preserves request inactivity alias and rejects invalid bounds', () => {
  assert.deepEqual(resolveCompletionTimeoutPolicy(), { version: 1, idleTimeoutMs: 120000, totalTimeoutMs: 900000, idleSource: 'default', totalSource: 'default' });
  assert.deepEqual(resolveCompletionTimeoutPolicy({ timeoutMs: 35, totalTimeoutMs: 80 }), { version: 1, idleTimeoutMs: 35, totalTimeoutMs: 80, idleSource: 'legacy_timeout', totalSource: 'explicit' });
  assert.equal(resolveCompletionTimeoutPolicy({ timeoutMs: 35, idleTimeoutMs: 45 }).idleTimeoutMs, 45);
  for (const key of ['idleTimeoutMs', 'totalTimeoutMs', 'timeoutMs']) for (const bad of [0, -1, NaN, Infinity, '120000', 2147483648]) assert.throws(() => resolveCompletionTimeoutPolicy({ [key]: bad }), { code: 'configuration' });
});

test('active native reasoning and text survive the former 120s reflection cutoff under the normal bounded stream policy', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const native = transport(), receipts = [];
  const promise = reflectProjectLearning({ model, episodes: [episode], provider: native.provider, requestControl: { onUsage: row => receipts.push(row) } });
  await native.entered; await flush();
  for (let index = 0; index < 3; index++) {
    t.mock.timers.tick(60000);
    native.send({ choices: [{ delta: index === 2 ? { content: ' ' } : { reasoning_content: 'Reasoning is active.' } }] });
    await flush();
  }
  native.send({ usage: { prompt_tokens: 10, completion_tokens: 3 } }); native.finish(decision);
  const result = await promise;
  assert.equal(result.decision.outcome, 'no_change'); assert.equal(native.calls, 1);
  assert.deepEqual(result.request.timeoutPolicy, resolveCompletionTimeoutPolicy());
  assert.equal(native.requests[0].totalTimeoutMs, 900000); assert.equal(native.requests[0].idleTimeoutMs, 120000);
  assert.deepEqual(native.wire[0].response_format, { type: 'json_object' });
  assert.equal(result.usage.totalTokens, 13); assert.equal(receipts.length, 1); assert.equal(receipts[0].completed, true);
  assert.deepEqual(receipts[0].timeoutPolicy, result.request.timeoutPolicy);
});

test('native reflection inactivity still aborts once and retains received usage and timeout policy', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const native = transport(), receipts = [];
  const promise = reflectProjectLearning({ model, episodes: [episode], provider: native.provider, idleTimeoutMs: 30000, requestControl: { onUsage: row => receipts.push(row) } });
  const checked = assert.rejects(promise, error => error.code === 'idle_timeout' && error.request.timeoutPolicy.idleTimeoutMs === 30000 && error.usage.totalTokens === 13);
  await native.entered; native.send({ usage: { prompt_tokens: 10, completion_tokens: 3 }, choices: [{ delta: { reasoning_content: 'active before stall' } }] }); await flush();
  t.mock.timers.tick(30001); await checked;
  assert.equal(native.calls, 1); assert.equal(receipts.length, 1); assert.equal(receipts[0].usageReported, true); assert.equal(receipts[0].completed, false);
});

test('explicit legacy reflection hard deadline still cuts an active stream and explicit total deadline takes precedence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [options, hard] of [[{ timeoutMs: 90000 }, 90000], [{ timeoutMs: 90000, totalTimeoutMs: 180000 }, 180000]]) {
    const native = transport();
    const promise = reflectProjectLearning({ model, episodes: [episode], provider: native.provider, ...options });
    const checked = assert.rejects(promise, error => error.code === 'total_timeout' && error.request.timeoutPolicy.totalTimeoutMs === hard && error.request.responseBytes > 0);
    await native.entered; await flush();
    for (let elapsed = 30000; elapsed < hard; elapsed += 30000) { t.mock.timers.tick(30000); native.send({ choices: [{ delta: { reasoning_content: 'active', content: ' ' } }] }); await flush(); }
    t.mock.timers.tick(30001); await checked; assert.equal(native.calls, 1);
  }
});

test('user abort retains received reflection usage without accepting late output or retrying', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const native = transport(), controller = new AbortController(), receipts = [];
  const promise = reflectProjectLearning({ model, episodes: [episode], provider: native.provider, signal: controller.signal, requestControl: { onUsage: row => receipts.push(row) } });
  const checked = assert.rejects(promise, error => ['aborted', 'AbortError'].includes(error.code ?? error.name) || error.name === 'AbortError');
  await native.entered; native.send({ usage: { prompt_tokens: 10, completion_tokens: 3 } }); await flush(); controller.abort(); await checked;
  assert.equal(native.calls, 1); assert.equal(receipts.length, 1); assert.equal(receipts[0].usage.totalTokens, 13); assert.equal(receipts[0].completed, false);
});

test('invalid reflection limits are rejected before budget admission or provider dispatch', async () => {
  let admissions = 0, calls = 0;
  await assert.rejects(reflectProjectLearning({ model, episodes: [episode], totalTimeoutMs: 0, provider: async function* () { calls++; }, requestControl: { beforeRequest: () => { admissions++; } } }), { code: 'configuration' });
  assert.equal(admissions, 0); assert.equal(calls, 0);
});

test('iterator honors request hard limit even for an uncooperative provider and keeps the explicit iterator override', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [options, limit] of [[undefined, 90], [{ timeoutMs: 140 }, 140]]) {
    const released = deferred(), entered = deferred(); let failure, calls = 0;
    const promise = Array.fromAsync(iterateCompletion(async function* (request) { calls++; assert.equal(request.totalTimeoutMs, limit); entered.resolve(); await released.promise; yield { type: 'text_delta', delta: 'late' }; }, { model, messages: [], totalTimeoutMs: 90 }, options));
    const checked = assert.rejects(promise, error => { failure = error; return error.code === 'total_timeout'; });
    await entered.promise; t.mock.timers.tick(limit + 1); await checked; assert.equal(calls, 1); assert.ok(failure.completionPending);
    released.resolve(); await failure.completionPending;
  }
});

test('initiative shares the stream deadline, preserves explicit policy and audits bounded metadata on success and failure', async () => {
  const value = { action: 'wait', reason: 'No new work.', evidenceIds: [], content: '', nextReviewAfterMs: 60000 };
  for (const [policy, expected] of [[{}, 900000], [{ decisionTimeoutMs: 250000 }, 250000]]) {
    const result = await decideInitiative({ model, policy, provider: async function* (request) { assert.equal(request.totalTimeoutMs, expected); assert.equal(request.idleTimeoutMs, 120000); yield { type: 'text_delta', delta: JSON.stringify(value) }; yield { type: 'done', stopReason: 'stop' }; } });
    assert.equal(result.timeoutPolicy.totalTimeoutMs, expected);
    const coordinator = new InitiativeCoordinator({ model, policy }); assert.equal(coordinator.policy.decisionTimeoutMs, expected); await coordinator.close();
  }
  await assert.rejects(decideInitiative({ model, policy: { decisionTimeoutMs: 70000 }, provider: async function* () { throw Object.assign(new Error('failure'), { code: 'idle_timeout' }); } }), error => error.initiativeFailure.request.timeoutPolicy.totalTimeoutMs === 70000);
  const projected = initiativeFailure(new Error('x'), { request: { timeoutPolicy: { ...resolveCompletionTimeoutPolicy(), privateBody: 'DO_NOT_PERSIST' } } });
  assert.ok(!JSON.stringify(projected).includes('DO_NOT_PERSIST')); assert.deepEqual(projected.request.timeoutPolicy, resolveCompletionTimeoutPolicy());
});
