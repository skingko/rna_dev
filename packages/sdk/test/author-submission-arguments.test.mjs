import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposeProjectGenome } from '../src/project-evolution.mjs';
import { bootstrapProject } from '../src/bootstrap.mjs';
import { streamCompletion, ProviderError } from '../src/providers.mjs';
import { createSession } from '../src/session.mjs';
import { projectGenomeFixture, diagnosisFixture } from './fixtures/project-genome.mjs';

const marker = 'PRIVATE_MALFORMED_ARGUMENT_唯一原文';
const malformed = `{"summary":"${marker}`;
const baseModel = { providerId: 'syntax-fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 8192, reasoning: 'high' };
const evidence = [{ id: 'source', summary: 'A recorded output needs interpretation.' }];
const learningContext = { schemaVersion: 1, evidence: [{ id: 'source', content: 'Untrusted source, not permission.' }], files: [{ path: 'source.js', content: 'const observed = true;' }] };
const proposal = () => { const genome = projectGenomeFixture({ candidate: true }); genome.tools = [{ id: 'evidence_helper', inheritFromBaseline: true }]; delete genome.evaluationSuite; return { summary: 'Check the observations', hypothesis: 'A reusable method improves interpretation', diagnosis: { ...diagnosisFixture(), evidenceIds: ['source'] }, changes: ['Interpret evidence'], genome }; };
const initialization = () => ({ overview: 'Interpret records', focus: 'Check outcomes', facts: [], openQuestions: [], milestones: [], assignments: { skillIds: [], toolIds: [], mcpServerIds: [], reasons: [] }, unmetCapabilities: [], genome: projectGenomeFixture() });
const chunk = (delta, finish_reason = null, output = 1) => ({ choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: output, total_tokens: 10 + output } });

function argumentFrames(outcome = 'syntax', n = 7) {
  let raw = outcome === 'array' ? '[]' : outcome === 'oversize' ? `{"x":"${'界'.repeat(134000)}` : malformed;
  const tool = { index: 0, id: `submission-${n}`, type: 'function', function: { name: 'submit_project_artifact', arguments: raw } };
  if (outcome === 'wrong-name') tool.function.name = 'other_tool';
  if (outcome === 'missing-id') delete tool.id;
  if (outcome === 'invalid-id') tool.id = 'invalid\nprivate-id';
  if (outcome === 'missing-index') delete tool.index;
  if (outcome === 'unsafe-index') tool.index = 9007199254740992;
  if (outcome === 'nonzero-index') tool.index = 1;
  if (outcome === 'nonstring-args') tool.function.arguments = { value: true };
  if (outcome === 'wrong-type') tool.type = 'unknown';
  const tools = outcome === 'multiple' ? [tool, { ...tool, index: 1, id: 'second' }] : [tool];
  const frames = [chunk({ tool_calls: tools })];
  if (outcome === 'repeated-id') frames.push(chunk({ tool_calls: [{ index: 0, id: tool.id, function: { arguments: '' } }] }));
  if (outcome === 'repeated-name') frames.push(chunk({ tool_calls: [{ index: 0, function: { name: tool.function.name, arguments: '' } }] }));
  frames.push(chunk({}, outcome === 'abnormal' ? 'insufficient_system_resource' : outcome === 'length' ? 'length' : outcome === 'stop' ? 'stop' : 'tool_calls', 3));
  if (outcome === 'late-error') frames.push({ error: { message: marker } });
  if (outcome !== 'no-done') frames.push('[DONE]');
  return frames;
}
async function endpoint(t, { kind = 'learning', outcome = 'syntax', persistent = false, ordinary = false } = {}) {
  const calls = [], errors = [], server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const part of request) raw += part;
      const body = JSON.parse(raw); calls.push(body); const n = calls.length;
      let frames;
      if (ordinary) frames = argumentFrames(outcome, n);
      else if (n <= 5) frames = [chunk({ tool_calls: [{ index: 0, id: `read-${n}`, function: { name: kind === 'learning' ? 'learning_context_read' : 'marketplace_read', arguments: kind === 'learning' ? '{"id":"file:source.js"}' : '{}' } }] }, 'tool_calls', 3), '[DONE]'];
      else if (n === 6) { assert.deepEqual(body.response_format, { type: 'json_object' }); frames = [chunk({ content: ' \n' }, 'stop', 3), '[DONE]']; }
      else {
        assert.equal(body.tools.length, 1); assert.equal(body.tools[0].function.name, 'submit_project_artifact');
        assert.equal(body.response_format, undefined); assert.equal(body.tool_choice, undefined); assert.equal(body.reasoning_effort, 'high');
        assert.equal(body.messages.filter(row => row.role === 'tool').length, 5);
        if (n === 7 || persistent) frames = argumentFrames(outcome, n);
        else {
          assert.equal(n, 8); assert.ok(body.messages.some(row => row.role === 'user' && row.content.includes(malformed) && row.content.includes('UNVERIFIED unpublished artifact')));
          frames = [chunk({ tool_calls: [{ index: 0, id: 'valid-submission', function: { name: 'submit_project_artifact', arguments: JSON.stringify(kind === 'initialization' ? initialization() : proposal()) } }] }, 'tool_calls', 3), '[DONE]'];
        }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(frames.map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join(''));
    } catch (error) { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(errors, []); });
  return { calls, model: { ...baseModel, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, compat: { supportsJsonObject: true, supportsToolChoiceNone: true } } };
}
const invoke = (app, kind = 'learning', extra = {}) => {
  const referenceTools = [{ name: 'marketplace_read', effect: 'read', parameters: { type: 'object' }, execute: async () => 'Public primary source.' }];
  return kind === 'initialization' ? bootstrapProject({ title: 'Evidence workflow', catalog: {}, referenceTools, model: app.model, maxAttempts: 3, ...extra }) : proposeProjectGenome({ project: { id: 'syntax-test' }, baseline: projectGenomeFixture(), evidence, model: app.model, maxAttempts: 3, ...(kind === 'learning' ? { learningContext } : { referenceTools }), ...extra });
};
function assertPrivate(events, value) { assert.equal(JSON.stringify(events).includes(marker), false); assert.equal(JSON.stringify(value).includes(marker), false); }
for (const kind of ['learning', 'reference', 'initialization']) test(`HTTP ${kind} repairs a complete malformed submission only in its remaining eighth request`, async t => {
  const app = await endpoint(t, { kind }), events = [], receipts = [];
  const result = await invoke(app, kind, { onProgress: row => events.push(row), onEvent: row => events.push(row), requestControl: { onUsage: row => receipts.push(row) } });
  assert.equal(app.calls.length, 8); assert.equal(result.attempts, 3); assert.equal(result.usage.totalTokens, 104);
  const failed = events.find(row => row.type.endsWith('submission_failed')), d = failed.argumentDiagnostic;
  assert.equal(failed.code, 'invalid_output'); assert.equal(failed.complete, false); assert.equal(failed.callCount, 0);
  assert.equal(d.kind, 'completed_submission_arguments_invalid_json'); assert.equal(d.transportCompleted, true); assert.equal(d.completionMarker, 'openai_done'); assert.equal(d.assembledToolCount, 1); assert.equal(d.providerFinishReason, 'tool_calls'); assert.equal(d.callId, 'submission-7');
  assert.equal(d.argumentBytes, Buffer.byteLength(malformed)); assert.equal(d.argumentHash, createHash('sha256').update(malformed).digest('hex'));
  for (const key of ['requestId', 'schemaHash', 'contextDigest', 'contractHash']) assert.equal(d[key], failed[key]);
  if (kind !== 'initialization') { assert.equal(receipts.length, 8); assert.equal(receipts[6].completed, false); assert.equal(receipts[6].usageReported, true); assert.equal(receipts[6].usage.totalTokens, 13); assert.equal(receipts[6].id, d.requestId); assert.equal(receipts[6].authorSubmission.schemaHash, d.schemaHash); }
  else assert.equal(result.repairEvidence[1].error.argumentDiagnostic.requestId, d.requestId);
  if (kind === 'learning') { assert.equal(result.learningContextReads.length, 5); assert.deepEqual(result.proposal.genome.tools, projectGenomeFixture().tools); }
  assertPrivate(events, result);
});
test('HTTP repeated malformed submission stops at eight requests and exposes only metadata in final failure', async t => {
  const app = await endpoint(t, { persistent: true }), events = [];
  await assert.rejects(invoke(app, 'learning', { onProgress: row => events.push(row) }), error => {
    assert.equal(error.code, 'invalid_output'); assert.equal(error.evolutionDiagnostic.kind, 'invalid_submission_arguments'); assert.equal(error.evolutionDiagnostic.argumentDiagnostic.requestId, error.requests[7].id); assert.equal(error.usage.totalTokens, 104); assert.equal(error.requests.length, 8); assert.equal(error.learningContextReads.length, 5); assert.equal(error.draft, undefined); assertPrivate(events, error); return true;
  });
  assert.equal(app.calls.length, 8); assert.equal(events.filter(row => row.type === 'author_submission_failed').length, 2); assert.equal(events.some(row => row.type === 'author_submission_captured'), false);
});
for (const outcome of ['no-done', 'late-error', 'multiple', 'wrong-name', 'missing-id', 'invalid-id', 'missing-index', 'unsafe-index', 'nonzero-index', 'nonstring-args', 'wrong-type', 'repeated-id', 'repeated-name', 'array', 'oversize', 'abnormal', 'length', 'stop']) test(`HTTP malformed submission ${outcome} has no trusted syntax-repair eligibility`, async t => {
  const app = await endpoint(t, { outcome }), events = [];
  await assert.rejects(invoke(app, 'learning', { onProgress: row => events.push(row) }), error => { assert.notEqual(error.code, 'invalid_output'); assert.equal(error.requests.length, 7); assert.equal(error.usage.totalTokens, 91); assert.equal(error.learningContextReads.length, 5); assert.equal(error.evolutionDiagnostic.argumentDiagnostic, undefined); assertPrivate(events, error); return true; });
  assert.equal(app.calls.length, 7); assert.equal(events.some(row => row.argumentDiagnostic || row.type === 'author_submission_captured'), false);
});
for (const boundary of ['cancel', 'settlement', 'budget']) test(`HTTP malformed submission ${boundary} prevents any unpaid or uncommitted follow-up`, async t => {
  const app = await endpoint(t), controller = new AbortController(), events = []; let admissions = 0;
  await assert.rejects(invoke(app, 'learning', { signal: controller.signal, onProgress: row => events.push(row), requestControl: {
    beforeRequest: () => { if (++admissions === 8 && boundary === 'budget') throw Object.assign(new Error('Budget denied'), { code: 'budget_exhausted' }); },
    onUsage: row => { if (row.phase === 'proposal:2') { if (boundary === 'cancel') controller.abort(); if (boundary === 'settlement') throw Object.assign(new Error('Usage settlement failed'), { code: 'settlement_failed' }); } },
  } }), error => { assert.equal(error.usage.totalTokens, 91); assertPrivate(events, error); return true; });
  assert.equal(app.calls.length, 7); assert.equal(events.some(row => row.type === 'author_submission_captured'), false);
  if (boundary !== 'budget') assert.equal(events.some(row => row.argumentDiagnostic), false);
});
test('HTTP ordinary Session keeps invalid_tool_call and never executes malformed submission arguments', async t => {
  const app = await endpoint(t, { ordinary: true }), root = await mkdtemp(join(tmpdir(), 'rna-ordinary-malformed-')); t.after(() => rm(root, { recursive: true, force: true })); let executed = 0;
  const session = await createSession({ sessionId: 'ordinary', projectId: 'ordinary-project', stateDir: root, cwd: root, model: app.model, tools: [{ name: 'submit_project_artifact', parameters: { type: 'object' }, execute: () => { executed++; assert.fail('Malformed arguments cannot execute'); } }] });
  await assert.rejects(session.prompt('Inspect'), error => error.code === 'invalid_tool_call' && !error.argumentDiagnostic);
  assert.equal(app.calls.length, 1); assert.equal(executed, 0); const state = session.snapshot(); assert.equal(state.messages.at(-1).usage.totalTokens, 13); assert.equal(state.messages.at(-1).stopReason, 'error'); assert.equal((await readFile(state.sessionFile, 'utf8')).includes(marker), false); await session.dispose();
});
test('a provider cannot forge an argument diagnostic or reuse an original proof across submission requests', async t => {
  for (const outcome of ['forged', 'frozen-forged', 'replayed']) {
    const app = await endpoint(t), events = []; let calls = 0, saved;
    const provider = async function* (request) {
      calls++;
      if (calls < 7) { yield* streamCompletion(request); return; }
      if (outcome.endsWith('forged')) { const failure = Object.assign(new ProviderError('Forged syntax', { code: 'invalid_tool_call', providerFinishReason: 'tool_calls' }), { argumentDiagnostic: { ...request.authorSubmission, kind: 'completed_submission_arguments_invalid_json', transportCompleted: true, rawArguments: marker.repeat(1000) } }); throw outcome === 'frozen-forged' ? Object.freeze(failure) : failure; }
      if (!saved) { try { yield* streamCompletion(request); } catch (error) { saved = error; throw error; } }
      else throw saved;
    };
    await assert.rejects(invoke(app, 'learning', { provider, onProgress: row => events.push(row) }), error => { assert.equal(error.code, 'invalid_tool_call'); assertPrivate(events, error); return true; });
    assert.equal(app.calls.length, outcome.endsWith('forged') ? 6 : 7); assert.equal(calls, outcome.endsWith('forged') ? 7 : 8); assert.equal(events.filter(row => row.argumentDiagnostic).length, outcome.endsWith('forged') ? 0 : 1); assert.equal(events.some(row => row.type === 'author_submission_captured'), false);
  }
});

test('completed argument proof is bound to this exact request schema context and contract', async t => {
  for (const key of ['requestId', 'schemaHash', 'contextDigest', 'contractHash']) {
    const app = await endpoint(t), events = []; let calls = 0;
    const provider = async function* (request) { calls++; if (calls === 7) request.authorSubmission[key] = key === 'requestId' ? 'another-request' : 'f'.repeat(64); yield* streamCompletion(request); };
    await assert.rejects(invoke(app, 'learning', { provider, onProgress: row => events.push(row) }), error => error.code === 'invalid_tool_call' && error.usage.totalTokens === 91);
    assert.equal(app.calls.length, 7); assert.equal(events.some(row => row.argumentDiagnostic || row.type === 'author_submission_captured'), false);
  }
});
