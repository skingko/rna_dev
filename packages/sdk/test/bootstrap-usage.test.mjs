import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapProject } from '../src/bootstrap.mjs';
import { projectGenomeFixture } from './fixtures/project-genome-fixture.mjs';
const model = { protocol: 'openai', providerId: 'fixture', modelId: 'fixture', maxOutputTokens: 2048 };
const valid = () => ({ overview: 'Test project', focus: 'Check evidence', facts: [], openQuestions: [], milestones: [], assignments: { skillIds: [], toolIds: [], mcpServerIds: [], reasons: [] }, unmetCapabilities: [], genome: projectGenomeFixture() });
const reported = { type: 'usage', usage: { input: 12, output: 5, totalTokens: 17 } };

test('bootstrap charges a later cancelled repair separately from an earlier reported request', async () => {
  const controller = new AbortController(), estimates = [], events = []; let calls = 0, error;
  try { await bootstrapProject({ title: '计量', model, signal: controller.signal, beforeRequest: request => estimates.push(request.estimatedTokens), onEvent: event => events.push(event), provider: async function* () { calls++; if (calls === 1) { yield { type: 'text_delta', delta: '{}' }; yield reported; yield { type: 'done', stopReason: 'stop' }; } else { controller.abort(); controller.signal.throwIfAborted(); } } }); } catch (failure) { error = failure; }
  assert.equal(error.name, 'AbortError'); assert.equal(calls, 2); assert.equal(error.usage.totalTokens, 17 + estimates[1]); assert.equal(error.usage.estimatedTokens, estimates[1]);
  assert.equal(events.filter(event => event.type === 'bootstrap_request_end').length, 2); assert.equal(events.at(-1).requestUsage.estimatedTokens, estimates[1]); assert.equal(events.at(-1).usage.totalTokens, error.usage.totalTokens);
});

test('bootstrap estimates each unreported attempt and keeps the repair prompt in admission headroom', async () => {
  const estimates = []; let calls = 0;
  const result = await bootstrapProject({ title: '计量', model, beforeRequest: request => estimates.push(request.estimatedTokens), provider: async function* () { calls++; yield { type: 'text_delta', delta: calls === 1 ? '{}' : JSON.stringify(valid()) }; yield { type: 'done', stopReason: 'stop' }; } });
  assert.equal(calls, 2); assert.ok(estimates[1] > estimates[0]); assert.equal(result.usage.totalTokens, estimates[0] + estimates[1]); assert.equal(result.usage.estimatedTokens, result.usage.totalTokens); assert.equal(result.usage.input, 0);
});

test('bootstrap denial before a repair preserves earlier usage and never starts or estimates the denied request', async () => {
  let calls = 0, admissions = 0, error; const events = [];
  try { await bootstrapProject({ title: '计量', model, beforeRequest: async ({ usage }) => { admissions++; if (admissions === 2) { assert.equal(usage.totalTokens, 17); throw Object.assign(new Error('budget denied'), { code: 'budget' }); } }, onEvent: event => events.push(event), provider: async function* () { calls++; yield { type: 'text_delta', delta: '{}' }; yield reported; yield { type: 'done', stopReason: 'stop' }; } }); } catch (failure) { error = failure; }
  assert.equal(error.code, 'budget'); assert.equal(calls, 1); assert.equal(admissions, 2); assert.equal(error.usage.totalTokens, 17); assert.equal(error.usage.estimatedTokens, 0); assert.equal(events.filter(event => event.type === 'bootstrap_request_start').length, 1);
});

test('bootstrap treats repeated provider usage frames as request totals and settles once', async () => {
  const result = await bootstrapProject({ title: '计量', model, provider: async function* () { yield { type: 'text_delta', delta: JSON.stringify(valid()) }; yield reported; yield reported; yield { type: 'done', stopReason: 'stop' }; } });
  assert.equal(result.usage.totalTokens, 17); assert.equal(result.usage.estimatedTokens, 0);
});

test('bootstrap interrupted before the admitted request starts releases without estimated spend', async () => {
  const controller = new AbortController(); let calls = 0, error;
  try { await bootstrapProject({ title: '计量', model, signal: controller.signal, beforeRequest: () => controller.abort(), provider: async function* () { calls++; } }); } catch (failure) { error = failure; }
  assert.equal(error.name, 'AbortError'); assert.equal(calls, 0); assert.equal(error.usage.totalTokens, 0);
});

test('after an answer cut off by the output allowance the next attempt runs one reasoning level lower (spec p1 effort §3.5)', async () => {
  const capability = { control: 'effort', efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }], providerDefault: null, canDisable: false };
  const efforts = [], events = []; let calls = 0;
  const result = await bootstrapProject({ title: '计量', model: { ...model, reasoning: 'max', reasoningCapability: capability }, onEvent: event => events.push(event), provider: async function* (request) {
    calls++; efforts.push(request.model.reasoning);
    if (calls === 1) { yield { type: 'text_delta', delta: '{"overview":' }; yield reported; yield { type: 'done', stopReason: 'length' }; }
    else { yield { type: 'text_delta', delta: JSON.stringify(valid()) }; yield reported; yield { type: 'done', stopReason: 'stop' }; }
  } });
  assert.equal(result.status, 'ready'); assert.deepEqual(efforts, ['max', 'high']);
  assert.deepEqual(events.filter(event => event.type === 'bootstrap_reasoning_step_down').map(event => event.reasoning), ['high']);
  assert.equal(result.usage.totalTokens, 34, 'the allowance stays the configured one; both requests are billed');
});
