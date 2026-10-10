import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamCompletion, ProviderError } from '../src/providers.mjs';
import { createSession } from '../src/session.mjs';
import { proposeProjectGenome } from '../src/project-evolution.mjs';
import { bootstrapProject } from '../src/bootstrap.mjs';
import { projectGenomeFixture } from './fixtures/project-genome.mjs';
const baseModel = { providerId: 'terminal-fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 8192, reasoning: 'off' };
const usage = { prompt_tokens: 10, completion_tokens: 3 }, tool = { index: 0, id: 'call-1', function: { name: 'read', arguments: '{}' } };
const chunk = (finish_reason, delta = {}, receipt = usage) => ({ choices: [{ index: 0, delta, ...(finish_reason !== undefined ? { finish_reason } : {}) }], ...(receipt ? { usage: receipt } : {}) });
async function endpoint(t, handler) {
  const calls = [], server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part; calls.push(JSON.parse(raw)); response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(handler(calls.at(-1), calls.length).map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join(''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { calls, model: { ...baseModel, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, compat: { supportsJsonObject: true, supportsToolChoiceNone: true } } };
}
async function collect(app, protocol = 'openai') { const events = []; let error; try { for await (const row of streamCompletion({ model: { ...app.model, protocol }, messages: [{ role: 'user', content: 'Inspect' }], maxRetries: 0 })) events.push(row); } catch (failure) { error = failure; } return { events, error }; }
const admitted = events => events.filter(row => row.type === 'tool_call' || row.type === 'done');
for (const reason of ['content_filter', 'insufficient_system_resource', 'aborted', 'future_state', '', '__proto__', 'x'.repeat(1000), { private: 'must-not-be-stringified' }]) test(`HTTP abnormal OpenAI finish ${typeof reason === 'object' ? 'object' : reason.slice(0, 25) || 'empty'} retains usage without tool dispatch or success`, async t => {
  const app = await endpoint(t, () => [chunk(null, { content: '{"looks":"valid"}', tool_calls: [tool] }, null), chunk(reason), '[DONE]']); const { events, error } = await collect(app);
  assert.ok(error instanceof ProviderError); assert.equal(error.code, 'provider_termination'); assert.equal(error.retryable, false);
  assert.equal(error.providerFinishReason, typeof reason === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(reason) ? reason : '[invalid_finish_reason]');
  assert.equal(events.filter(row => row.type === 'usage').length, 1); assert.equal(events.findLast(row => row.type === 'usage').usage.totalTokens, 13); assert.deepEqual(admitted(events), []); assert.equal(app.calls.length, 1); assert.equal(JSON.stringify(error).includes('must-not-be-stringified'), false);
});
test('HTTP normal OpenAI reasons retain exact metadata and stop-plus-complete-tool compatibility', async t => {
  for (const [reason, expected, withTool] of [['stop', 'stop', false], ['length', 'length', false], ['tool_calls', 'toolUse', true], ['function_call', 'toolUse', true], ['stop', 'stop', true]]) {
    const app = await endpoint(t, () => [chunk(reason, withTool ? { tool_calls: [tool] } : { content: 'answer' }), '[DONE]']); const { events, error } = await collect(app);
    assert.equal(error, undefined); assert.deepEqual(events.at(-1), { type: 'done', stopReason: expected, providerFinishReason: reason }); assert.equal(events.filter(row => row.type === 'tool_call').length, Number(withTool)); assert.equal(events.filter(row => row.type === 'usage').length, 1);
  }
});
test('HTTP missing finish reasons on DONE or EOF do not infer success from body or tools', async t => {
  for (const ending of [[], ['[DONE]']]) { const app = await endpoint(t, () => [chunk(undefined, { content: 'complete-looking', tool_calls: [tool] }), ...ending]); const { events, error } = await collect(app); assert.equal(error.code, 'incomplete_stream'); assert.equal(error.providerFinishReason, null); assert.deepEqual(admitted(events), []); assert.equal(events.findLast(row => row.type === 'usage').usage.totalTokens, 13); }
});
test('HTTP abnormal or conflicting reasons cannot be overwritten by late normal reasons or usage', async t => {
  for (const reasons of [['content_filter', 'stop'], ['stop', 'length'], ['tool_calls', 'stop']]) {
    const app = await endpoint(t, () => [chunk(reasons[0], { content: 'partial', tool_calls: [tool] }, null), chunk(reasons[1], {}, null), { choices: [], usage }, '[DONE]']); const { events, error } = await collect(app);
    assert.equal(error.code, 'provider_termination'); assert.equal(error.providerFinishReason, reasons[0] === 'content_filter' ? reasons[0] : reasons[1]); assert.deepEqual(admitted(events), []); assert.equal(events.findLast(row => row.type === 'usage').usage.totalTokens, 13);
  }
});
test('HTTP truncated tool fragments are not dispatched even when their JSON looks complete', async t => {
  const app = await endpoint(t, () => [chunk('length', { tool_calls: [tool] }), '[DONE]']); const { events, error } = await collect(app); assert.equal(error.code, 'provider_protocol'); assert.equal(error.providerFinishReason, 'length'); assert.deepEqual(admitted(events), []); assert.equal(events.findLast(row => row.type === 'usage').usage.totalTokens, 13);
});
const anthropic = reason => [{ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'read', input: {} } }, { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 3 } }, { type: 'message_stop' }];
test('HTTP Anthropic pause refusal context exhaustion unknown and missing reasons preserve cumulative usage without dispatch', async t => {
  for (const reason of ['pause_turn', 'refusal', 'model_context_window_exceeded', 'future_reason', null]) { const app = await endpoint(t, () => anthropic(reason)); const { events, error } = await collect(app, 'anthropic'); assert.equal(error.code, reason === null ? 'incomplete_stream' : 'provider_termination'); assert.equal(error.providerFinishReason, reason); assert.deepEqual(admitted(events), []); assert.deepEqual(events.filter(row => row.type === 'usage').map(row => row.usage.totalTokens), [11, 13]); assert.equal(app.calls.length, 1); }
});
test('HTTP Anthropic documented normal reasons preserve wire metadata and cumulative usage', async t => {
  for (const [reason, expected] of [['end_turn', 'stop'], ['stop_sequence', 'stop'], ['max_tokens', 'length'], ['tool_use', 'toolUse']]) { const app = await endpoint(t, () => anthropic(reason).filter(row => reason === 'tool_use' || row.type !== 'content_block_start')); const { events, error } = await collect(app, 'anthropic'); assert.equal(error, undefined); assert.deepEqual(events.at(-1), { type: 'done', stopReason: expected, providerFinishReason: reason }); assert.equal(events.filter(row => row.type === 'usage').at(-1).usage.totalTokens, 13); }
});
test('HTTP explicit stream errors preserve their usage frame without leaking body or emitting done', async t => {
  for (const protocol of ['openai', 'anthropic']) { const app = await endpoint(t, () => [{ type: 'error', error: { message: 'private-body' }, usage: protocol === 'openai' ? usage : { input_tokens: 10, output_tokens: 3 } }]); const { events, error } = await collect(app, protocol); assert.equal(error.code, 'stream_error'); assert.equal(events.findLast(row => row.type === 'usage').usage.totalTokens, 13); assert.deepEqual(admitted(events), []); assert.equal(error.message.includes('private-body'), false); }
});
test('HTTP ordinary Session journals successful and failed raw reasons without executing abnormal tool fragments', async t => {
  for (const reason of ['stop', 'content_filter']) {
    const app = await endpoint(t, () => [chunk(reason, { content: 'answer', ...(reason !== 'stop' ? { tool_calls: [tool] } : {}) }), '[DONE]']); const root = await mkdtemp(join(tmpdir(), 'rna-terminal-session-')); t.after(() => rm(root, { recursive: true, force: true })); let executed = 0;
    const session = await createSession({ projectId: 'terminal-project', sessionId: 'terminal-session', stateDir: root, cwd: root, model: app.model, tools: [{ name: 'read', parameters: { type: 'object' }, execute: async () => { executed++; return 'unexpected'; } }] });
    if (reason === 'stop') await session.prompt('Inspect'); else await assert.rejects(session.prompt('Inspect'), error => error.code === 'provider_termination' && error.providerFinishReason === reason && error.responseDiagnostic === undefined);
    const message = session.snapshot().messages.at(-1); assert.equal(message.providerFinishReason, reason); assert.equal(message.stopReason, reason === 'stop' ? 'stop' : 'error'); assert.equal(message.usage.totalTokens, 13); assert.equal(executed, 0);
    const journal = (await readFile(session.snapshot().sessionFile, 'utf8')).trim().split('\n').map(JSON.parse); assert.equal(journal.findLast(row => row.type === 'request_completed').data.message.providerFinishReason, reason); await session.dispose();
  }
});
for (const reason of ['insufficient_system_resource', null]) test(`HTTP isolated author ${reason ?? 'missing'} final termination preserves six paid requests without format retry`, async t => {
  const app = await endpoint(t, (_body, call) => call <= 5 ? [chunk('tool_calls', { tool_calls: [{ ...tool, id: `read-${call}`, function: { name: 'learning_context_read', arguments: '{"id":"file:source.js"}' } }] }), '[DONE]'] : [chunk(reason, { content: '{"plausible":"json"}' }), '[DONE]']); const events = [], receipts = [];
  await assert.rejects(proposeProjectGenome({ project: { id: 'provider-failure' }, baseline: projectGenomeFixture(), evidence: [], learningContext: { schemaVersion: 1, evidence: [], files: [{ path: 'source.js', content: 'const value = 1;' }] }, model: app.model, maxAttempts: 3, onProgress: row => events.push(row), requestControl: { onUsage: row => receipts.push(row) } }), error => { assert.equal(error.code, reason === null ? 'incomplete_stream' : 'provider_termination'); assert.equal(error.evolutionDiagnostic.providerFinishReason, reason); assert.equal(error.usage.totalTokens, 78); assert.equal(error.requests.length, 6); assert.equal(error.learningContextReads.length, 5); return true; });
  assert.equal(app.calls.length, 6); assert.equal(app.calls[5].tool_choice, 'none'); assert.equal(receipts.length, 6); assert.equal(receipts.at(-1).completed, false); assert.equal(receipts.at(-1).usageReported, true); assert.equal(receipts.at(-1).providerFinishReason, reason); assert.ok(receipts.slice(0, 5).every(row => row.providerFinishReason === 'tool_calls')); assert.equal(events.filter(row => ['structured_output_failure', 'author_format_feedback'].includes(row.type)).length, 0);
});
test('HTTP direct reference and initialization authors do not retry provider termination as output validation', async t => {
  for (const path of ['direct', 'reference', 'initialization-direct', 'initialization-reference']) {
    const app = await endpoint(t, () => [chunk('content_filter', { content: '{}' }), '[DONE]']), events = [], referenceTools = [{ name: 'marketplace_read', effect: 'read', parameters: { type: 'object' }, execute: () => assert.fail('No tool should execute') }];
    const operation = path.startsWith('initialization') ? bootstrapProject({ title: 'Inspect', model: app.model, catalog: {}, maxAttempts: 3, ...(path.endsWith('reference') ? { referenceTools } : {}), onEvent: row => events.push(row) }) : proposeProjectGenome({ project: { id: 'termination' }, baseline: projectGenomeFixture(), evidence: [], model: app.model, maxAttempts: 3, ...(path === 'reference' ? { referenceTools } : {}), onProgress: row => events.push(row) });
    await assert.rejects(operation, error => error.code === 'provider_termination' && error.providerFinishReason === 'content_filter' && error.usage.totalTokens === 13); assert.equal(app.calls.length, 1); assert.equal(events.find(row => row.type === 'model_request' || row.type === 'bootstrap_request_end').providerFinishReason, 'content_filter');
  }
});

test('HTTP normal empty content remains a completed transport response with explicit raw stop metadata', async t => {
  const app = await endpoint(t, () => [chunk('stop', { content: '  \n' }), '[DONE]']); const { events, error } = await collect(app);
  assert.equal(error, undefined); assert.deepEqual(events.at(-1), { type: 'done', stopReason: 'stop', providerFinishReason: 'stop' }); assert.equal(events.find(row => row.type === 'text_delta').delta, '  \n');
});
