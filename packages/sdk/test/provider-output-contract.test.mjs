import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildRequest, resolveJsonOutputContract, streamCompletion } from '../src/providers.mjs';
import { bootstrapProject } from '../src/bootstrap.mjs';
import { proposeProjectGenome } from '../src/project-evolution.mjs';
import { projectGenomeFixture, diagnosisFixture } from './fixtures/project-genome.mjs';

const model = { providerId: 'actual-provider', modelId: 'deepseek-v4-pro', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', contextWindow: 128000, maxOutputTokens: 8192, reasoning: 'off' };
const jsonRequest = { model, systemPrompt: 'Return one complete JSON object.', messages: [{ role: 'user', content: 'Return JSON.' }], responseFormat: { type: 'json_object' }, toolChoice: 'none' };

test('native JSON inference requires the verified official endpoint and model, with explicit false taking priority', () => {
  for (const baseUrl of ['https://api.deepseek.com', 'https://api.deepseek.com/', 'https://api.deepseek.com/v1', 'https://api.deepseek.com:443/v1/']) for (const modelId of ['deepseek-v4-pro', 'deepseek-flash']) {
    const contract = resolveJsonOutputContract({ ...model, baseUrl, modelId }); assert.equal(contract.mode, 'native'); assert.equal(contract.reason, 'verified_deepseek_chat');
    const wire = buildRequest({ ...jsonRequest, model: { ...model, baseUrl, modelId } }); assert.deepEqual(wire.body.response_format, { type: 'json_object' }); assert.equal(wire.body.tool_choice, 'none'); assert.equal(wire.body.thinking.type, 'disabled');
  }
  const disabled = resolveJsonOutputContract({ ...model, compat: { supportsJsonObject: false, supportsToolChoiceNone: false } });
  assert.equal(disabled.mode, 'prompt_only'); assert.equal(disabled.reason, 'disabled_by_compat'); assert.deepEqual(disabled.requestOptions, {});
  const noJson = resolveJsonOutputContract({ ...model, compat: { supportsJsonObject: false } }); assert.equal(noJson.mode, 'prompt_only'); assert.deepEqual(noJson.requestOptions, { toolChoice: 'none' });
  const noChoice = resolveJsonOutputContract({ ...model, compat: { supportsToolChoiceNone: false } }); assert.equal(noChoice.mode, 'native'); assert.deepEqual(noChoice.requestOptions, { responseFormat: { type: 'json_object' } });
});

test('unknown models, proxies, nondefault ports, paths and Anthropic never gain implicit OpenAI native constraints', () => {
  for (const variant of [
    { baseUrl: 'https://api.deepseek.com:8443/v1' }, { baseUrl: 'https://api.deepseek.com/proxy' }, { baseUrl: 'https://api.deepseek.com.attacker.invalid/v1' },
    { baseUrl: 'https://proxy.invalid/v1' }, { baseUrl: 'https://api.openai.com/v1', modelId: 'legacy-model' }, { modelId: 'deepseek-chat' }, { modelId: 'unlisted-model' },
    { protocol: 'anthropic', compat: { supportsJsonObject: true, supportsToolChoiceNone: true } },
  ]) {
    const selected = { ...model, ...variant }, contract = resolveJsonOutputContract(selected); assert.equal(contract.mode, 'prompt_only'); assert.deepEqual(contract.requestOptions, {});
    assert.throws(() => buildRequest({ ...jsonRequest, model: selected }), { code: 'unsupported_output_contract' });
  }
  const declared = resolveJsonOutputContract({ ...model, baseUrl: 'https://proxy.invalid/v1', modelId: 'configured-model', compat: { supportsJsonObject: true, supportsToolChoiceNone: true } });
  assert.equal(declared.mode, 'native'); assert.equal(declared.reason, 'explicit_compat');
});

test('explicit response format and tool policy have narrow validated shapes and leave ordinary chat requests unchanged', () => {
  for (const responseFormat of [null, [], 'json_object', { type: 'text' }, { type: 'json_schema' }, { type: 'json_object', schema: {} }]) assert.throws(() => buildRequest({ ...jsonRequest, responseFormat }), { code: 'invalid_output_contract' });
  for (const toolChoice of ['required', 'auto', null, { type: 'function', function: { name: 'run' } }]) assert.throws(() => buildRequest({ ...jsonRequest, toolChoice }), { code: 'invalid_output_contract' });
  for (const key of ['supportsJsonObject', 'supportsToolChoiceNone']) assert.throws(() => resolveJsonOutputContract({ ...model, compat: { [key]: 'true' } }), { code: 'configuration' });
  const plain = buildRequest({ model, messages: jsonRequest.messages }); assert.equal(plain.body.response_format, undefined); assert.equal(plain.body.tool_choice, undefined);
  const thinking = buildRequest({ ...jsonRequest, model: { ...model, reasoning: 'high' } }); assert.equal(thinking.body.thinking.type, 'enabled'); assert.equal(thinking.body.tool_choice, 'none');
});

test('unsupported explicitly required native JSON rejects before even one fetch, with no downgrade', async () => {
  let fetches = 0;
  await assert.rejects(Array.fromAsync(streamCompletion({ ...jsonRequest, model: { ...model, baseUrl: 'https://unverified.invalid/v1' }, fetch: async () => { fetches++; throw new Error('Must not fetch'); } })), { code: 'unsupported_output_contract' });
  assert.equal(fetches, 0);
});

async function fixture(t, handler) {
  const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { ...model, modelId: 'local-json-fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, compat: { supportsJsonObject: true, supportsToolChoiceNone: true } };
}

test('an explicit native JSON request rejected by the provider is not retried as prompt-only', async t => {
  let hits = 0; const selected = await fixture(t, async (request, response) => {
    hits++; let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw);
    assert.deepEqual(body.response_format, { type: 'json_object' }); assert.equal(body.tool_choice, 'none'); response.writeHead(400); response.end();
  });
  await assert.rejects(Array.fromAsync(streamCompletion({ ...jsonRequest, model: selected })), error => error.code === 'http_error' && error.status === 400); assert.equal(hits, 1);
});

for (const kind of ['bootstrap', 'evolution']) test(`HTTP direct ${kind} JSON request uses native constraints and keeps its exact business schema and audit`, async t => {
  const genome = projectGenomeFixture({ candidate: kind === 'evolution' });
  const output = kind === 'bootstrap'
    ? { overview: 'A methods project', focus: 'Check real outcomes', facts: ['A methods project was requested'], openQuestions: ['Which outcomes?'], milestones: [], assignments: { skillIds: [], toolIds: [], mcpServerIds: [], reasons: [] }, unmetCapabilities: [], genome }
    : { summary: 'Check actual evidence', hypothesis: 'Better verification makes results useful.', diagnosis: diagnosisFixture(), changes: ['Improve verification'], genome };
  let hits = 0; const errors = [], audit = [];
  const selected = await fixture(t, async (request, response) => {
    try {
      hits++; let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw);
      assert.deepEqual(body.response_format, { type: 'json_object' }); assert.equal(body.tool_choice, 'none'); assert.equal(body.tools?.length ?? 0, 0);
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify(output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
  });
  const result = kind === 'bootstrap' ? await bootstrapProject({ title: 'A methods project', model: selected, maxAttempts: 1, onEvent: event => audit.push(event) })
    : await proposeProjectGenome({ project: { id: 'direct-json' }, baseline: projectGenomeFixture(), evidence: [], model: selected, maxAttempts: 1, onProgress: event => audit.push(event) });
  assert.deepEqual(errors, []); assert.equal(hits, 1); assert.equal(result.usage.totalTokens, 30);
  assert.ok(audit.some(event => event.contract?.mode === 'native' && event.contract.requestOptions.toolChoice === 'none'));
  if (kind === 'evolution') { assert.deepEqual(result.requests[0].responseFormat, { type: 'json_object' }); assert.equal(result.requests[0].toolChoice, 'none'); }
});
