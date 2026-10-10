import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { bootstrapProject, projectBootstrapSchema } from '../src/bootstrap.mjs';
import { proposeProjectGenome } from '../src/project-evolution.mjs';
import { streamCompletion } from '../src/providers.mjs';
import { projectGenomeFixture, diagnosisFixture } from './fixtures/project-genome.mjs';

const initialization = () => ({ overview: 'A methods project', focus: 'Inspect real outcomes', facts: ['The title requests a methods project'], openQuestions: ['Which outcomes matter most?'], milestones: [{ title: 'Validate a method', description: 'Use actual evidence', acceptanceCriteria: ['An outcome has a recorded check'] }], assignments: { skillIds: [], toolIds: [], mcpServerIds: [], reasons: [] }, unmetCapabilities: [], genome: projectGenomeFixture() });
const candidate = () => { const genome = projectGenomeFixture({ candidate: true }); delete genome.evaluationSuite; return { summary: 'Use checked evidence', hypothesis: 'Explicit verification improves usefulness.', diagnosis: diagnosisFixture(), changes: ['Clarify the evidence method'], genome }; };
const packet = (response, body) => response.write(`data: ${JSON.stringify(body)}\n\n`);
async function endpoint(t, kind, mode = 'json') {
  const calls = [], errors = []; let reads = 0;
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw), number = calls.push(body); assert.ok(number <= 6);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (number <= 5 && mode !== 'early') {
        assert.equal(body.tools[0].function.name, 'marketplace_read');
        assert.equal(body.response_format, undefined); assert.equal(body.tool_choice, undefined);
        packet(response, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `reference-${number}`, type: 'function', function: { name: 'marketplace_read', arguments: JSON.stringify({ page: number }) } }] }, finish_reason: null }] });
        packet(response, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
      } else {
        if (mode !== 'early') {
          assert.equal(body.tools?.length ?? 0, 0);
          assert.deepEqual(body.response_format, { type: 'json_object' }); assert.equal(body.tool_choice, 'none');
          const prompt = body.messages.find(row => row.role === 'system').content, contract = prompt.slice(prompt.lastIndexOf('Final response task:'));
          assert.doesNotMatch(prompt, /Summarize only facts established/); assert.match(contract, /Mandatory execution constraints: Do not claim unfinished work succeeded/);
          const schema = JSON.parse(contract.match(/Output schema:\n([^\n]+)/)?.[1] ?? 'null');
          if (kind === 'bootstrap') { assert.match(contract, /complete project initialization JSON object/); assert.deepEqual(schema.required, projectBootstrapSchema.required); assert.equal(schema.required.includes('hypothesis'), false); }
          else { assert.match(contract, /complete proposal JSON object/); assert.deepEqual(schema.required, ['summary', 'hypothesis', 'diagnosis', 'changes', 'genome']); assert.equal(schema.required.includes('overview'), false); }
          assert.deepEqual(body.messages.filter(row => row.role === 'tool').map(row => row.tool_call_id), [1, 2, 3, 4, 5].map(n => `reference-${n}`));
        }
        const delta = mode === 'tool' ? { tool_calls: [{ index: 0, id: 'forbidden-tail', type: 'function', function: { name: 'marketplace_read', arguments: '{"page":6}' } }] } : { content: JSON.stringify(kind === 'bootstrap' ? initialization() : candidate()) };
        packet(response, { choices: [{ index: 0, delta, finish_reason: null }] }); packet(response, { choices: [{ index: 0, delta: {}, finish_reason: mode === 'tool' ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
      }
      response.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(errors, []); });
  const model = { providerId: 'reference-http', modelId: 'fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 128000, maxOutputTokens: 8192, reasoning: 'off', compat: { supportsJsonObject: true, supportsToolChoiceNone: true } };
  const referenceTools = [{ name: 'marketplace_read', effect: 'read', parameters: { type: 'object', properties: { page: { type: 'integer' } }, required: ['page'] }, execute: async (_id, { page }) => { reads++; return `Reference page ${page}: inspect actual outcomes before claiming completion.`; } }];
  const run = ({ beforeRequest, ...options } = {}) => kind === 'bootstrap'
    ? bootstrapProject({ title: 'A methods project', catalog: {}, model, referenceTools, maxAttempts: 1, beforeRequest, ...options })
    : proposeProjectGenome({ project: { id: 'reference-evolution' }, baseline: projectGenomeFixture(), evidence: [], model, referenceTools, maxAttempts: 1, requestControl: { beforeRequest }, ...options });
  return { calls, reads: () => reads, run };
}

for (const kind of ['bootstrap', 'evolution']) {
  test(`HTTP ${kind} reserves the sixth request for its own exact JSON schema after five public reads`, async t => {
    const app = await endpoint(t, kind); const result = await app.run();
    assert.equal(app.calls.length, 6); assert.equal(app.reads(), 5); assert.equal(result.usage.totalTokens, 180); assert.equal(result.attempts, 1);
    if (kind === 'bootstrap') assert.equal(result.status, 'ready'); else assert.equal(result.validation.passed, true);
  });
  test(`HTTP ${kind} still accepts a complete first response without extra research or a forced final call`, async t => {
    const app = await endpoint(t, kind, 'early'), result = await app.run(); assert.equal(app.calls.length, 1); assert.equal(app.reads(), 0); assert.equal(result.usage.totalTokens, 30);
  });
  test(`HTTP ${kind} refuses a tail tool call without executing it or hiding incurred usage`, async t => {
    const app = await endpoint(t, kind, 'tool'); await assert.rejects(app.run(), error => error.code === 'step_limit' && error.usage.totalTokens === 180);
    assert.equal(app.calls.length, 6); assert.equal(app.reads(), 5);
  });
  test(`HTTP ${kind} budget rejection at final admission sends only five requests and retains their actual usage`, async t => {
    const app = await endpoint(t, kind); let admissions = 0;
    await assert.rejects(app.run({ beforeRequest: () => { if (++admissions === 6) throw Object.assign(new Error('No remaining fixture budget'), { code: 'budget_exhausted' }); } }), error => error.code === 'budget_exhausted' && error.usage.totalTokens === 150);
    assert.equal(app.calls.length, 5); assert.equal(app.reads(), 5); assert.equal(admissions, 6);
  });
  test(`HTTP ${kind} cancellation after final usage retains the bill and never returns a successful artifact`, async t => {
    const app = await endpoint(t, kind), controller = new AbortController();
    const provider = async function* (request) { for await (const event of streamCompletion(request)) { yield event; if (!request.tools.length && event.type === 'usage') { controller.abort(Object.assign(new Error('Cancelled fixture'), { code: 'cancelled' })); request.signal.throwIfAborted(); } } };
    await assert.rejects(app.run({ signal: controller.signal, provider }), error => error.code === 'cancelled' && error.usage.totalTokens === 180);
    assert.equal(app.calls.length, 6); assert.equal(app.reads(), 5);
  });
}

for (const kind of ['bootstrap', 'evolution', 'learning']) test(`${kind} author rejects a growing context without unbudgeted automatic compaction requests`, async () => {
  let calls = 0, reads = 0;
  const model = { providerId: 'bounded-fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 128000, maxOutputTokens: 8192, reasoning: 'off' };
  const referenceTools = [{ name: 'marketplace_read', effect: 'read', parameters: { type: 'object', properties: {} }, execute: async () => { reads++; return 'x'.repeat(120000); } }];
  const provider = async function* (request) {
    calls++; assert.ok(request.tools.length > 0, 'No implicit compaction or prematurely forced tail request may be paid'); assert.ok(calls <= 5);
    if (kind === 'learning') for (let page = 0; page < 10; page++) yield { type: 'tool_call', id: `${calls}-${page}`, name: 'learning_context_read', arguments: { id: 'file:source.txt', offset: page * 12000, limit: 12000 } };
    else yield { type: 'tool_call', id: `source-${calls}`, name: 'marketplace_read', arguments: {} };
    yield { type: 'usage', usage: { totalTokens: 1 } }; yield { type: 'done', stopReason: 'toolUse' };
  };
  const operation = kind === 'bootstrap' ? bootstrapProject({ title: 'A methods project', model, provider, referenceTools, maxAttempts: 1 })
    : proposeProjectGenome({ project: { id: 'bounded' }, baseline: projectGenomeFixture(), evidence: [], model, provider, maxAttempts: 1,
      ...(kind === 'learning' ? { learningContext: { schemaVersion: 1, evidence: [], files: [{ path: 'source.txt', content: 'x'.repeat(120000) }] } } : { referenceTools }) });
  await assert.rejects(operation, error => { assert.equal(error.code, 'context_limit'); assert.equal(error.usage.totalTokens, calls); if (kind === 'learning') assert.equal(error.learningContextReads.length, calls * 10); return true; });
  assert.ok(calls >= 2 && calls < 6); if (kind !== 'learning') assert.equal(reads, calls);
});
