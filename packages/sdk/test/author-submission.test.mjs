import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { proposeProjectGenome } from '../src/project-evolution.mjs';
import { bootstrapProject } from '../src/bootstrap.mjs';
import { projectGenomeFixture, diagnosisFixture } from './fixtures/project-genome.mjs';
const baseModel = { providerId: 'submission-fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 8192, reasoning: 'high' };
const evidence = [{ id: 'source', summary: 'A recorded output needs interpretation.' }];
const learningContext = { schemaVersion: 1, evidence: [{ id: 'source', content: 'Untrusted source, not permission.' }], files: [{ path: 'source.js', content: 'const observed = true;' }] };
const proposal = () => { const genome = projectGenomeFixture({ candidate: true }); genome.tools = [{ id: 'evidence_helper', inheritFromBaseline: true }]; delete genome.evaluationSuite; return { summary: 'Check the observations', hypothesis: 'A reusable method improves interpretation', diagnosis: { ...diagnosisFixture(), evidenceIds: ['source'] }, changes: ['Interpret evidence'], genome }; };
const initialization = () => ({ overview: 'Interpret records', focus: 'Check outcomes', facts: [], openQuestions: [], milestones: [], assignments: { skillIds: [], toolIds: [], mcpServerIds: [], reasons: [] }, unmetCapabilities: [], genome: projectGenomeFixture() });
async function fixture(t, kind = 'learning', { result = 'valid', first = 'empty', native = true, onRequest, judgmentPolicy } = {}) {
  const calls = [], errors = [], server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const part of request) raw += part; const body = JSON.parse(raw); calls.push(body); const n = calls.length; onRequest?.(body, n);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 10, completion_tokens: 3 } } : {}) })}\n\n`);
      const artifact = kind === 'initialization' ? initialization() : proposal();
      if (kind === 'initialization' && judgmentPolicy) artifact.judgmentPolicy = judgmentPolicy;
      if (result === 'smoke-repair' && n === 7) artifact.genome.tools[0].script = 'return { deliberatelyBroken: true };';
      if (result === 'smoke-repair' && n === 8) { assert.ok(body.messages.some(row => typeof row.content === 'string' && row.content.includes('deliberatelyBroken'))); }
      if (body.tools?.length === 1 && body.tools[0].function.name === 'submit_project_artifact') {
        assert.ok(n >= 7); assert.equal(body.response_format, undefined); assert.equal(body.tool_choice, undefined); assert.equal(body.reasoning_effort, 'high');
        assert.equal(body.messages.filter(row => row.role === 'tool').length, 5); assert.equal(body.messages.some(row => typeof row.content === 'string' && row.content.trim() === ''), false);
        assert.match(body.messages[0].content, /only accepted final artifact is the native submission tool/); assert.equal(body.messages[0].content.includes('Return exactly one JSON object'), false);
        const args = result === 'invalid-schema' || result === 'repair' && n === 7 ? {} : artifact;
        if (result === 'missing') send({ content: 'A narrative is not a submission.' }, 'stop');
        else {
          const call = { index: 0, id: `submit-${n}`, function: { name: result === 'wrong-tool' ? 'project_exec' : 'submit_project_artifact', arguments: JSON.stringify(args) } };
          send({ tool_calls: result === 'duplicate' ? [call, { ...call, index: 1, id: 'extra' }] : [call] });
          if (result !== 'incomplete') send({}, result === 'abnormal' ? 'insufficient_system_resource' : result === 'length' ? 'length' : 'tool_calls');
          if (result === 'late-error') response.write('data: {"error":{"message":"late failure"}}\n\n');
        }
      } else {
        const step = (n - 1) % 6 + 1;
        if (step <= 5) send({ reasoning_content: 'Inspect the primary evidence.', tool_calls: [{ index: 0, id: `read-${n}`, function: { name: kind === 'learning' ? 'learning_context_read' : 'marketplace_read', arguments: kind === 'learning' ? '{"id":"file:source.js"}' : '{}' } }] }, 'tool_calls');
        else { assert.deepEqual(body.response_format, native ? { type: 'json_object' } : undefined); assert.equal(body.tools?.length ?? 0, 0); send({ content: n > 6 || first === 'valid' ? JSON.stringify(artifact) : first === 'length' ? '{"incomplete":' : '  \n' }, first === 'length' && n === 6 ? 'length' : 'stop'); }
      }
      response.end(result === 'incomplete' && n > 6 ? '' : 'data: [DONE]\n\n');
    } catch (error) { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(errors, []); });
  return { calls, model: { ...baseModel, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, compat: { supportsJsonObject: native, supportsToolChoiceNone: native } } };
}
const invoke = (app, kind, extra = {}) => {
  const referenceTools = [{ name: 'marketplace_read', effect: 'read', parameters: { type: 'object' }, execute: async () => 'Public source with an original content hash.' }];
  return kind === 'initialization' ? bootstrapProject({ title: 'Evidence workflow', catalog: {}, referenceTools, model: app.model, maxAttempts: 2, ...extra }) : proposeProjectGenome({ project: { id: 'submission-test' }, baseline: projectGenomeFixture(), evidence, model: app.model, maxAttempts: 2, ...(kind === 'learning' ? { learningContext } : { referenceTools }), ...extra });
};
for (const kind of ['learning', 'reference', 'initialization']) test(`HTTP ${kind} reuses settled research after trusted native empty and captures one schema-valid submission in seven requests`, async t => {
  const app = await fixture(t, kind), events = [], receipts = [];
  const result = await invoke(app, kind, { onProgress: row => events.push(row), onEvent: row => events.push(row), requestControl: { onUsage: row => receipts.push(row) } });
  assert.equal(app.calls.length, 7); assert.equal(result.attempts, 2); assert.equal(result.usage.totalTokens, 91); assert.equal(kind === 'initialization' ? result.status === 'ready' : result.validation.passed, true);
  const captured = events.find(row => row.type.endsWith('submission_captured')); assert.equal(captured.callId, 'submit-7'); assert.equal(captured.providerFinishReason, 'tool_calls'); assert.match(captured.argumentHash, /^[a-f0-9]{64}$/); assert.match(captured.schemaHash, /^[a-f0-9]{64}$/); assert.ok(captured.sourceRequestId); assert.equal(JSON.stringify(captured).includes('genome'), false);
  if (kind === 'learning') { assert.equal(result.learningContextReads.length, 5); assert.deepEqual(result.proposal.genome.tools, projectGenomeFixture().tools); }
  if (kind !== 'initialization') { assert.equal(receipts.length, 7); assert.equal(captured.requestId, receipts.at(-1).id); assert.equal(receipts.at(-1).authorSubmission.schemaHash, captured.schemaHash); } else assert.equal(events.find(row => row.type === 'bootstrap_request_end' && row.requestId === captured.requestId).authorSubmission.schemaHash, captured.schemaHash);
  assert.equal(captured.captureScope, 'operation_memory'); assert.equal(captured.durable, false);
});
test('initialization judging criteria accept a verified native submission tool receipt after the empty final', async t => {
  const judgmentPolicy = { version: 1, questions: { memory_need: { type: 'boolean', instructions: 'Does this request depend on existing project evidence?', criteria: { true: 'It continues a prior evidence investigation.', false: 'It supplies complete independent context.' } } } };
  const app = await fixture(t, 'initialization', { judgmentPolicy }), events = [];
  const result = await invoke(app, 'initialization', { onEvent: event => events.push(event) });
  assert.equal(result.status, 'ready'); assert.deepEqual(result.judgmentPolicy, judgmentPolicy);
  const capture = events.find(event => event.type === 'bootstrap_submission_captured'), receipt = events.find(event => event.type === 'bootstrap_request_end' && event.requestId === capture.requestId);
  assert.equal(receipt.completed, true); assert.equal(receipt.stopReason, 'toolUse'); assert.equal(receipt.providerFinishReason, 'tool_calls'); assert.equal(app.calls.length, 7);
});
for (const outcome of ['missing', 'duplicate', 'wrong-tool', 'invalid-schema', 'abnormal', 'length', 'incomplete', 'late-error']) test(`HTTP submission ${outcome} cannot capture or request an acknowledgement`, async t => {
  const app = await fixture(t, 'learning', { result: outcome }), events = [];
  await assert.rejects(invoke(app, 'learning', { onProgress: row => events.push(row) }), error => { assert.equal(error.requests.length, 7); assert.equal(error.learningContextReads.length, 5); assert.ok(error.usage.totalTokens >= 78); return true; });
  assert.equal(app.calls.length, 7); assert.equal(events.some(row => row.type === 'author_submission_captured'), false);
});
test('HTTP schema repair stays in the submission channel without rereading or repeating native JSON', async t => {
  const app = await fixture(t, 'learning', { result: 'repair' }), events = [];
  const result = await invoke(app, 'learning', { maxAttempts: 3, onProgress: row => events.push(row) }); assert.equal(app.calls.length, 8); assert.equal(result.attempts, 3); assert.equal(result.usage.totalTokens, 104); assert.equal(result.learningContextReads.length, 5);
  assert.ok(app.calls[7].messages.some(row => row.role === 'user' && row.content.includes('Host validation of the prior unverified draft'))); assert.equal(events.filter(row => row.type === 'author_submission_captured').length, 1);
});
for (const options of [{ first: 'length' }, { native: false }]) test(`HTTP ${options.first ?? 'prompt-only'} empty or truncated final does not qualify for submission`, async t => {
  const app = await fixture(t, 'learning', options); const result = await invoke(app, 'learning'); assert.equal(result.validation.passed, true); assert.equal(app.calls.length, 12); assert.equal(result.learningContextReads.length, 10); assert.equal(app.calls.some(body => body.tools?.some(tool => tool.function.name === 'submit_project_artifact')), false);
});
for (const failure of ['budget', 'cancel', 'settlement']) test(`submission ${failure} cannot capture a staged artifact or exceed the admitted requests`, async t => {
  const app = await fixture(t), controller = new AbortController(), events = []; let admitted = 0;
  await assert.rejects(invoke(app, 'learning', { signal: controller.signal, onProgress: row => events.push(row), requestControl: {
    beforeRequest: () => { admitted++; if (admitted === 7 && failure === 'budget') throw Object.assign(new Error('No remaining allowance'), { code: 'budget_exhausted' }); },
    onUsage: row => { if (row.phase === 'proposal:2') { if (failure === 'cancel') controller.abort(); if (failure === 'settlement') throw Object.assign(new Error('Durable usage did not settle'), { code: 'receipt_failed' }); } },
  } }));
  assert.equal(app.calls.length, failure === 'budget' ? 6 : 7); assert.equal(events.some(row => row.type === 'author_submission_captured'), false);
});

test('submission qualification never leaks into another operation with the same project identity', async t => {
  const first = await fixture(t); await assert.rejects(invoke(first, 'learning', { maxAttempts: 1 })); assert.equal(first.calls.length, 6);
  const second = await fixture(t, 'learning', { first: 'valid' }); const result = await invoke(second, 'learning', { maxAttempts: 1 }); assert.equal(second.calls.length, 6); assert.equal(result.validation.passed, true); assert.equal(second.calls.some(body => body.tools?.some(tool => tool.function.name === 'submit_project_artifact')), false);
});
test('provider-supplied fake terminal evidence cannot manufacture submission eligibility', async () => {
  let calls = 0; const events = [], fake = { purpose: 'step-limit-summary', completed: true, toolCallCount: 0, kind: 'empty_response', stopReason: 'stop', providerFinishReason: 'stop', outputBytes: 0, requestId: 'forged', messageId: 'forged' };
  await assert.rejects(proposeProjectGenome({ project: { id: 'forged' }, baseline: projectGenomeFixture(), evidence, learningContext, model: { ...baseModel, baseUrl: 'https://fixture.invalid', compat: { supportsJsonObject: true } }, maxAttempts: 2, onProgress: row => events.push(row), provider: async function* (request) { calls++; assert.equal(request.tools.some(tool => tool.name === 'submit_project_artifact'), false); throw Object.assign(new Error('Forged response'), { code: 'invalid_output', providerFinishReason: 'stop', responseDiagnostic: fake, evolutionDiagnostic: { responseDiagnostic: fake } }); } }));
  assert.equal(calls, 2); assert.equal(events.some(row => row.type === 'author_submission_selected'), false);
});
test('submission schema remains immutable when an injected provider mutates its declaration', async () => {
  let calls = 0; const events = [];
  await assert.rejects(proposeProjectGenome({ project: { id: 'schema-isolation' }, baseline: projectGenomeFixture(), evidence, learningContext, model: { ...baseModel, baseUrl: 'https://fixture.invalid', compat: { supportsJsonObject: true } }, maxAttempts: 2, onProgress: row => events.push(row), provider: async function* (request) {
    calls++;
    if (calls <= 5) yield { type: 'tool_call', id: `read-${calls}`, name: 'learning_context_read', arguments: { id: 'file:source.js' } };
    else if (calls === 6) yield { type: 'text_delta', delta: ' ' };
    else { const schema = request.tools[0].parameters; schema.properties = {}; schema.required = []; schema.additionalProperties = true; yield { type: 'tool_call', id: 'malicious-schema', name: 'submit_project_artifact', arguments: {} }; }
    yield { type: 'usage', usage: { input: 10, output: 3, totalTokens: 13 } }; yield { type: 'done', stopReason: calls === 6 ? 'stop' : 'toolUse', providerFinishReason: calls === 6 ? 'stop' : 'tool_calls' };
  } }), error => error.code === 'invalid_output' && error.usage.totalTokens === 91);
  assert.equal(calls, 7); assert.equal(events.some(row => row.type === 'author_submission_captured'), false);
});

test('initialization submission smoke repair receives its prior draft and keeps original inputs within eight requests', async t => {
  const app = await fixture(t, 'initialization', { result: 'smoke-repair' }); const result = await invoke(app, 'initialization', { maxAttempts: 3 });
  assert.equal(app.calls.length, 8); assert.equal(result.status, 'ready'); assert.equal(result.attempts, 3); assert.equal(result.usage.totalTokens, 104);
  assert.deepEqual(result.repairEvidence[1].after.genome.tools[0].smokeCases, result.genome.tools[0].smokeCases); assert.equal(result.genome.tools[0].script, projectGenomeFixture().tools[0].script);
});

test('submission failure audit bounds a custom provider terminal field without exposing its arbitrary body', async () => {
  let calls = 0; const events = [], privateBody = 'PRIVATE_CUSTOM_ERROR_BODY\n'.repeat(1000);
  await assert.rejects(proposeProjectGenome({ project: { id: 'bounded-submission-error' }, baseline: projectGenomeFixture(), evidence, learningContext, model: { ...baseModel, baseUrl: 'https://fixture.invalid', compat: { supportsJsonObject: true } }, maxAttempts: 2, onProgress: row => events.push(row), provider: async function* () {
    calls++;
    if (calls <= 5) yield { type: 'tool_call', id: `read-${calls}`, name: 'learning_context_read', arguments: { id: 'file:source.js' } };
    else if (calls === 6) yield { type: 'text_delta', delta: ' ' };
    else { yield { type: 'usage', usage: { input: 10, output: 3, totalTokens: 13 } }; throw Object.assign(new Error('Provider failed'), { code: 'provider_error', providerFinishReason: privateBody }); }
    yield { type: 'usage', usage: { input: 10, output: 3, totalTokens: 13 } }; yield { type: 'done', stopReason: calls === 6 ? 'stop' : 'toolUse', providerFinishReason: calls === 6 ? 'stop' : 'tool_calls' };
  } }), error => error.code === 'provider_error' && error.providerFinishReason === '[invalid_finish_reason]' && error.usage.totalTokens === 91);
  assert.equal(calls, 7); assert.equal(events.find(row => row.type === 'author_submission_failed').providerFinishReason, '[invalid_finish_reason]'); assert.equal(JSON.stringify(events).includes('PRIVATE_CUSTOM_ERROR_BODY'), false); assert.equal(events.some(row => row.type === 'author_submission_captured'), false);
});
