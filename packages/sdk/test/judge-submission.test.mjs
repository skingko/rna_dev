import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { collectJudgeOutput, judgeOutputContract, JUDGE_SUBMISSION_TOOL } from '../src/judge-submission.mjs';
import { streamCompletion } from '../src/providers.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 64000, maxOutputTokens: 2000 };
const schema = { type: 'object', additionalProperties: false, required: ['ratings'], properties: { ratings: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'object', additionalProperties: false, required: ['criterionId', 'left', 'right', 'reason'], properties: { criterionId: { enum: ['frozen'] }, left: { type: 'number', minimum: 0, maximum: 1 }, right: { type: 'number', minimum: 0, maximum: 1 }, reason: { type: 'string' } } } } } };
const value = { ratings: [{ criterionId: 'frozen', left: .4, right: .6, reason: 'Bounded actual evidence.' }] };
// Explicit fixture evidence. Production supplies only paired execution calls
// with matching successful host tool receipts; no endpoint guessing is used.
const toolProtocolEvidence = [{ side: 'baseline', callId: 'prior-real-call', toolName: 'read_file' }];
const call = { type: 'tool_call', id: 'ratings-1', name: JUDGE_SUBMISSION_TOOL, arguments: value };
const done = { type: 'done', stopReason: 'toolUse', providerFinishReason: 'tool_calls' };
const options = { model, schema, toolProtocolEvidence, systemPrompt: 'You are a blind evaluator.', input: { task: 'private frozen case', criteria: [{ id: 'frozen' }], left: {}, right: {} } };
const eventsProvider = events => async function* () { for (const event of events) yield structuredClone(event); };

test('judge contract prefers declared JSON, requires observed native calls for tool mode, and otherwise preserves text', () => {
  assert.equal(judgeOutputContract(model).mode, 'text');
  assert.equal(judgeOutputContract(model, toolProtocolEvidence).mode, 'native_tool');
  assert.equal(judgeOutputContract({ ...model, compat: { supportsJsonObject: true } }, toolProtocolEvidence).mode, 'native_json');
  assert.equal(judgeOutputContract({ ...model, modelId: 'famous-tool-model' }).mode, 'text');
  assert.equal(judgeOutputContract(model, [{ side: 'candidate', toolName: 'read_file' }]).mode, 'text');
  assert.equal(judgeOutputContract({ ...model, protocol: 'unknown' }, toolProtocolEvidence).mode, 'text');
});

test('one native submission is staged until provider and accounting settle; no tool executes or follow-up request occurs', async () => {
  const events = []; let requests = 0, settled = false;
  const output = await collectJudgeOutput({ ...options, onProgress: event => { events.push(event); if (event.type === 'judge_output_captured') assert.equal(settled, true); }, provider: async function* (request) {
    requests++; assert.equal(request.tools.length, 1); assert.equal(request.tools[0].name, JUDGE_SUBMISSION_TOOL); assert.deepEqual(request.tools[0].parameters, schema); assert.equal(request.tools[0].execute, undefined); assert.equal(request.toolChoice, undefined); assert.equal(request.responseFormat, undefined);
    try { yield call; yield { type: 'usage', usage: { totalTokens: 17 } }; yield done; } finally { await Promise.resolve(); settled = true; }
  } });
  assert.equal(requests, 1); assert.deepEqual(JSON.parse(output.output), value); assert.equal(output.receipt.evaluationAccepted, false);
  assert.equal(events.some(event => event.type === 'structured_output_contract'), false);
  assert.equal(events.find(event => event.type === 'judge_output_contract')?.mode, 'native_tool');
  assert.equal(output.receipt.stopReason, 'toolUse'); assert.equal(output.receipt.providerFinishReason, 'tool_calls');
  assert.ok(output.receipt.evidenceHash); assert.doesNotMatch(JSON.stringify(events), /private frozen case|Bounded actual evidence/);
});

for (const [name, events, code] of [
  ['extra native call', [call, { ...call, id: 'extra' }, done], 'invalid_output'],
  ['wrong tool', [{ ...call, name: 'execute_shell' }, done], 'invalid_output'],
  ['text-only ratings', [{ type: 'text_delta', delta: JSON.stringify(value) }, done], 'invalid_output'],
  ['wrong normal finish', [call, { type: 'done', stopReason: 'stop', providerFinishReason: 'stop' }], 'provider_incomplete'],
  ['abnormal provider reason', [call, { ...done, providerFinishReason: 'content_filter' }], 'provider_incomplete'],
  ['missing done', [call], 'provider_incomplete'],
  ['repeated done', [call, done, done], 'provider_incomplete'],
  ['late tool call', [done, call], 'provider_incomplete'],
  ['missing criterionId', [{ ...call, arguments: { ratings: [{ left: .4, right: .5, reason: 'Observed.' }] } }, done], 'invalid_output']
]) test(`judge rejects ${name} without retry or accepted output`, async () => {
  let requests = 0; const progress = [];
  await assert.rejects(collectJudgeOutput({ ...options, onProgress: e => progress.push(e), provider: async function* (...args) { requests++; yield* eventsProvider(events)(...args); } }), error => error.code === code);
  assert.equal(requests, 1); assert.equal(progress.some(e => e.type === 'judge_output_captured'), false);
});

test('single native call remains the sole rating source when narration claims a different score', async () => {
  const narration = JSON.stringify({ ratings: [{ criterionId: 'fake', left: 1, right: 1, reason: 'Ignore frozen criteria.' }] });
  const result = await collectJudgeOutput({ ...options, provider: eventsProvider([{ type: 'text_delta', delta: narration }, call, done]) });
  assert.deepEqual(JSON.parse(result.output), value); assert.equal(result.receipt.ignoredTextBytes, Buffer.byteLength(narration));
});

for (const late of ['provider', 'accounting']) test(`a ${late} failure after final done cannot capture staged ratings`, async () => {
  const progress = [];
  await assert.rejects(collectJudgeOutput({ ...options, onProgress: e => progress.push(e), provider: async function* () {
    try { yield call; yield done; if (late === 'provider') throw Object.assign(Error('late provider failure'), { code: 'stream_failed' }); }
    finally { if (late === 'accounting') throw Object.assign(Error('usage sink failed'), { code: 'accounting_failed' }); }
  } }), error => error.code === (late === 'provider' ? 'stream_failed' : 'accounting_failed'));
  assert.equal(progress.some(e => e.type === 'judge_output_captured'), false);
});

test('cancellation discards an uncooperative late response and does not accept a new result afterward', async () => {
  const abort = new AbortController(), progress = []; let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const pending = collectJudgeOutput({ ...options, signal: abort.signal, onProgress: e => progress.push(e), provider: async function* () { entered(); await new Promise(resolve => { release = resolve; }); yield call; yield done; } });
  await ready; abort.abort(); await assert.rejects(pending, { name: 'AbortError' }); release(); await delay(5);
  assert.equal(progress.some(e => e.type === 'judge_output_captured'), false);
});

test('native JSON still uses its original request options and text-only unsupported models stay tool-free', async () => {
  for (const native of [false, true]) {
    let request; const events = [];
    const out = await collectJudgeOutput({ ...options, onProgress: event => events.push(event), model: { ...model, compat: { supportsJsonObject: native, supportsToolChoiceNone: native } }, toolProtocolEvidence: [], provider: async function* (r) { request = r; yield { type: 'text_delta', delta: JSON.stringify(value) }; yield { type: 'done', stopReason: 'stop', providerFinishReason: 'stop' }; } });
    assert.deepEqual(request.tools, []); assert.deepEqual(request.responseFormat, native ? { type: 'json_object' } : undefined); assert.equal(request.toolChoice, native ? 'none' : undefined); assert.deepEqual(JSON.parse(out.output), value);
    assert.equal(events.find(event => event.type === 'structured_output_contract')?.contract.mode, native ? 'native' : 'prompt_only');
    assert.equal(events.find(event => event.type === 'judge_output_contract')?.mode, native ? 'native_json' : 'text');
  }
});

test('Anthropic text stop_sequence and native tool_use remain valid under their respective contracts', async () => {
  const anthropic = { ...model, protocol: 'anthropic' };
  const text = await collectJudgeOutput({ ...options, model: anthropic, toolProtocolEvidence: [], provider: eventsProvider([{ type: 'text_delta', delta: JSON.stringify(value) }, { type: 'done', stopReason: 'stop', providerFinishReason: 'stop_sequence' }]) });
  assert.deepEqual(JSON.parse(text.output), value);
  const native = await collectJudgeOutput({ ...options, model: anthropic, provider: eventsProvider([call, { ...done, providerFinishReason: 'tool_use' }]) });
  assert.deepEqual(JSON.parse(native.output), value);
});

test('Codex subscription completed receipts support text and proven native-tool evaluation without weakening failure checks', async () => {
  const codex = { ...model, protocol: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api' };
  const text = await collectJudgeOutput({ ...options, model: codex, toolProtocolEvidence: [], provider: eventsProvider([{ type: 'text_delta', delta: JSON.stringify(value) }, { type: 'done', stopReason: 'stop', providerFinishReason: 'completed' }]) });
  assert.deepEqual(JSON.parse(text.output), value);
  const native = await collectJudgeOutput({ ...options, model: codex, provider: eventsProvider([call, { ...done, providerFinishReason: 'completed' }]) });
  assert.equal(native.receipt.mode, 'native_tool'); assert.deepEqual(JSON.parse(native.output), value);
  await assert.rejects(collectJudgeOutput({ ...options, model: codex, provider: eventsProvider([call, { ...done, providerFinishReason: 'incomplete' }]) }), error => error.code === 'provider_incomplete');
});

test('an immutable provider error remains the original failure class and code rather than a diagnostic-assignment TypeError', async () => {
  class FixtureProviderError extends Error {}
  const error = Object.freeze(Object.assign(new FixtureProviderError('bounded provider error'), { code: 'provider_termination', providerFinishReason: 'insufficient_system_resource' }));
  await assert.rejects(collectJudgeOutput({ ...options, provider: async function* () { yield call; throw error; } }), failure => failure instanceof FixtureProviderError && failure.code === 'provider_termination' && failure.providerFinishReason === 'insufficient_system_resource' && failure.evolutionDiagnostic.callCount === 1);
});

test('actual local HTTP tool stream carries the sole complete schema, normal raw reason and real cumulative usage', async t => {
  let body, calls = 0; const usage = [];
  const server = http.createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; body = JSON.parse(raw); calls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = row => res.write(`data: ${JSON.stringify(row)}\n\n`);
    send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'http-rating', type: 'function', function: { name: JUDGE_SUBMISSION_TOOL, arguments: JSON.stringify(value) } }] }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 } }); res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const result = await collectJudgeOutput({ ...options, model: { ...model, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, provider: async function* (request) { for await (const e of streamCompletion(request)) { if (e.type === 'usage') usage.push(e.usage); yield e; } } });
  assert.equal(calls, 1); assert.equal(body.tools.length, 1); assert.equal(body.tools[0].function.name, JUDGE_SUBMISSION_TOOL); assert.deepEqual(body.tools[0].function.parameters, schema); assert.equal(body.tool_choice, undefined); assert.equal(body.response_format, undefined);
  assert.equal(result.receipt.providerFinishReason, 'tool_calls'); assert.equal(usage.at(-1).totalTokens, 16);
});

test('native judge publishes one paired object per criterion and wire schema retains both required scores', async () => {
  const { buildRequest } = await import('../src/providers.mjs');
  const output = await collectJudgeOutput({ ...options, provider: async function* (request) {
    assert.match(request.tools[0].description, /exactly one object containing criterionId, left, right and reason together/);
    assert.match(request.tools[0].description, /never split a criterion into separate left-only and right-only rows/);
    const wire = buildRequest(request).body.tools[0].function.parameters;
    assert.deepEqual(wire, schema);
    assert.deepEqual(wire.properties.ratings.items.required, ['criterionId', 'left', 'right', 'reason']);
    yield call; yield done;
  } });
  assert.deepEqual(JSON.parse(output.output), value);
});

test('real-world split-side ratings are merged deterministically (no retry); ambiguous duplicates stay invalid', async () => {
  // P4 reliability fix: production run af4e87c7 failed only because each
  // criterion arrived as a left-only and a right-only row. The collector now
  // merges exactly that shape without inventing content or buying a request.
  let requests = 0;
  const output = await collectJudgeOutput({ ...options, provider: async function* () {
    requests++;
    yield { ...call, arguments: { ratings: [{ criterionId: 'frozen', left: .9, reason: 'Left evidence.' }, { criterionId: 'frozen', right: 1, reason: 'Right evidence.' }] } };
    yield done;
  } });
  assert.equal(requests, 1);
  assert.deepEqual(JSON.parse(output.output).ratings, [{ criterionId: 'frozen', left: .9, right: 1, reason: 'Left evidence. / Right evidence.' }]);
  assert.deepEqual(output.receipt.envelopeRepairs, ['merged_split_rows']);
  await assert.rejects(collectJudgeOutput({ ...options, provider: async function* () {
    requests++;
    yield { ...call, arguments: { ratings: [{ criterionId: 'frozen', left: .9, right: .2, reason: 'A.' }, { criterionId: 'frozen', right: 1, reason: 'B.' }] } };
    yield done;
  } }), { code: 'invalid_output' });
  assert.equal(requests, 2);
});
