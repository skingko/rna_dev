import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, SessionError } from '../src/session.mjs';
import { proposeProjectGenome } from '../src/project-evolution.mjs';
import { bootstrapProject } from '../src/bootstrap.mjs';
import { projectGenomeFixture, diagnosisFixture } from './fixtures/project-genome.mjs';

const model = { providerId: 'terminal-fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 8192, reasoning: 'off' };
const evidence = [{ id: 'external-fact', summary: 'A real completion check is missing.' }];
const learningContext = { schemaVersion: 1, evidence: [{ id: 'external-fact', content: 'The recorded tool result was incomplete.' }], files: [{ path: 'source.js', content: 'const completion = false;' }] };
const candidate = () => { const genome = projectGenomeFixture({ candidate: true }); genome.tools = [{ id: 'evidence_helper', inheritFromBaseline: true }]; delete genome.evaluationSuite; return { summary: 'Check actual completion', hypothesis: 'Apply a reusable completion method', diagnosis: { ...diagnosisFixture(), evidenceIds: ['external-fact'] }, changes: ['Improve the method'], genome }; };
const measured = { input: 10, output: 3, totalTokens: 13 };
const learningOptions = { project: { id: 'terminal-diagnostic' }, baseline: projectGenomeFixture(), evidence, learningContext, model };
const textOf = message => message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');

async function endpoint(t, outcomes) {
  const calls = [], errors = [], server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); calls.push(body); const index = calls.length - 1, step = index % 6, attempt = Math.floor(index / 6);
      assert.ok(attempt < outcomes.length, 'No attempt may exceed the configured bound');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } } : {}) })}\n\n`);
      if (body.tools?.length === 1 && body.tools[0].function.name === 'submit_project_artifact') {
        assert.equal(index, 12); assert.equal(body.response_format, undefined); assert.equal(body.tool_choice, undefined);
        assert.equal(body.messages.filter(message => message.role === 'tool').length, 5, 'The last settled research is reused without replay');
        if (outcomes[2] === 'valid') send({ tool_calls: [{ index: 0, id: 'submit-third-attempt', function: { name: 'submit_project_artifact', arguments: JSON.stringify(candidate()) } }] }, 'tool_calls');
        else send({ content: ' \n' }, 'stop');
        response.end('data: [DONE]\n\n'); return;
      }
      if (step < 5) {
        assert.ok(body.tools.length); assert.ok(body.tools.every(tool => ['learning_context_list', 'learning_context_read'].includes(tool.function.name)));
        assert.equal(body.response_format, undefined);
        send({ tool_calls: [{ index: 0, id: `read-${index}`, type: 'function', function: { name: 'learning_context_read', arguments: JSON.stringify({ id: 'file:source.js', offset: step, limit: 1 }) } }] }); send({}, 'tool_calls');
      } else {
        assert.equal(body.tools?.length ?? 0, 0); assert.equal(body.tool_choice, 'none'); assert.deepEqual(body.response_format, { type: 'json_object' });
        assert.equal(body.messages.filter(message => message.role === 'tool').length, 5, 'Only this attempt has read receipts; earlier attempts are not replayed into its session');
        const outcome = outcomes[attempt];
        if (outcome === 'empty') send({ reasoning_content: 'Thinking is not a final structured artifact.', content: ' \n' });
        else send({ content: JSON.stringify(candidate()) });
        send({}, outcome === 'length' ? 'length' : 'stop');
      }
      response.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(errors, []); });
  return { calls, model: { ...model, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, compat: { supportsJsonObject: true, supportsToolChoiceNone: true } } };
}

for (const success of [true, false]) test(`HTTP completed empty and truncated author responses ${success ? 'use the existing third attempt successfully' : 'stop after exactly three attempts with original terminal evidence'}`, async t => {
  const app = await endpoint(t, ['length', 'empty', success ? 'valid' : 'empty']), events = [], admissions = [], receipts = [];
  const operation = proposeProjectGenome({ ...learningOptions, model: app.model, maxAttempts: 3, onProgress: event => events.push(event), requestControl: { beforeRequest: row => admissions.push(row), onUsage: row => receipts.push(row) } });
  if (success) {
    const result = await operation; assert.equal(result.attempts, 3); assert.equal(result.validation.passed, true); assert.equal(result.usage.totalTokens, 169); assert.equal(result.learningContextReads.length, 10);
    assert.deepEqual(result.repairEvidence.slice(0, 2).map(row => row.error.code), ['invalid_output', 'invalid_output']);
  } else await assert.rejects(operation, error => {
    assert.equal(error.code, 'invalid_output'); assert.equal(error.evolutionDiagnostic.kind, 'invalid_submission'); assert.equal(error.evolutionDiagnostic.providerFinishReason, 'stop');
    assert.equal(error.evolutionDiagnostic.responseDiagnostic, undefined, 'Missing native submission is not a new Session empty-tail diagnostic');
    assert.equal(error.usage.totalTokens, 169); assert.equal(error.requests.length, 13); assert.equal(error.learningContextReads.length, 10); assert.equal(error.repairEvidence.length, 3); return true;
  });
  assert.equal(app.calls.length, 13); assert.equal(admissions.length, 13); assert.deepEqual(receipts.map(row => row.id), admissions.map(row => row.id)); assert.equal(new Set(receipts.map(row => row.id)).size, 13); assert.ok(receipts.every(row => row.completed && row.usageReported));
  const failures = events.filter(row => row.type === 'structured_output_failure'); assert.equal(failures.length, 2);
  assert.deepEqual(failures.slice(0, 2).map(row => [row.diagnostic.kind, row.diagnostic.stopReason]), [['output_truncated', 'length'], ['empty_response', 'stop']]);
  assert.equal(failures[0].diagnostic.outputBytes, Buffer.byteLength(JSON.stringify(candidate()))); assert.equal(failures[0].diagnostic.toolCallCount, 0); assert.equal(failures[1].diagnostic.outputBytes, 2);
  assert.equal(JSON.stringify(failures).includes('Thinking is not'), false); assert.equal(JSON.stringify(failures).includes('Check actual completion'), false);
  const reads = events.filter(row => row.type === 'learning_context_read'); assert.equal(reads.length, 10); assert.equal(new Set(reads.map(row => row.contextHash)).size, 1);
});

for (const terminal of ['empty', 'length']) test(`ordinary Session keeps ${terminal} final-response step_limit without retries and persists its exact terminal diagnostic`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-terminal-session-')); let calls = 0, executed = 0;
  const output = terminal === 'empty' ? ' \n' : '{"draft":"中文未结束"}';
  const session = await createSession({ stateDir: dir, model, maxSteps: 1, stepLimitBehavior: 'summarize', tools: [{ name: 'observe', effect: 'read', parameters: { type: 'object' }, execute: async () => { executed++; return { content: [{ type: 'text', text: 'recorded' }] }; } }], provider: async function* ({ purpose }) {
    const tooling = purpose !== 'summary';
    calls++; if (tooling) yield { type: 'tool_call', id: 'observation', name: 'observe', arguments: {} }; else { yield { type: 'thinking_delta', delta: 'PRIVATE_THINKING_IS_NOT_DIAGNOSTIC' }; yield { type: 'text_delta', delta: output }; }
    yield { type: 'usage', usage: measured }; yield { type: 'done', stopReason: tooling ? 'toolUse' : terminal === 'empty' ? 'stop' : 'length' };
  } });
  t.after(async () => { await session.dispose(); await rm(dir, { recursive: true, force: true }); });
  let failure; await assert.rejects(session.prompt('Inspect the source.'), error => { failure = error; return error.code === 'step_limit'; });
  assert.equal(calls, 2); assert.equal(executed, 1); assert.equal(session.snapshot().usage.totalTokens, 26);
  const rows = (await readFile(session.snapshot().sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const completion = rows.filter(row => row.type === 'request_completed').at(-1).data;
  assert.deepEqual(completion.responseDiagnostic, failure.responseDiagnostic); assert.equal(completion.message.stopReason, 'error'); assert.equal(completion.message.source, 'step-limit-summary');
  assert.equal(completion.responseDiagnostic.requestId, completion.requestId); assert.equal(completion.responseDiagnostic.messageId, completion.message.id); assert.equal(completion.responseDiagnostic.outputBytes, Buffer.byteLength(output));
  assert.equal(completion.responseDiagnostic.stopReason, terminal === 'empty' ? 'stop' : 'length'); assert.equal(completion.responseDiagnostic.completed, true); assert.equal(completion.responseDiagnostic.toolCallCount, 0);
  assert.deepEqual(Object.keys(completion.responseDiagnostic).sort(), ['completed', 'kind', 'messageId', 'outputBytes', 'purpose', 'requestId', 'stopReason', 'toolCallCount'].sort());
  assert.equal(JSON.stringify(completion.responseDiagnostic).includes('PRIVATE_THINKING'), false); assert.equal(textOf(completion.message), output);
});

for (const kind of ['evolution', 'initialization']) test(`read-only reference ${kind} maps a known completed invalid final response into its existing next attempt`, async () => {
  let calls = 0, reads = 0; const events = [];
  const referenceTools = [{ name: 'marketplace_read', effect: 'read', parameters: { type: 'object' }, execute: async () => { reads++; return { content: [{ type: 'text', text: 'Public method reference.' }] }; } }];
  const state = { overview: 'Source review', focus: 'Check facts', facts: [], openQuestions: [], milestones: [], assignments: { skillIds: [], toolIds: [], mcpServerIds: [], reasons: [] }, unmetCapabilities: [], genome: projectGenomeFixture() };
  const provider = async function* (request) {
    calls++;
    if (calls <= 5) { assert.deepEqual(request.tools.map(tool => tool.name), ['marketplace_read']); yield { type: 'tool_call', id: `public-${calls}`, name: 'marketplace_read', arguments: {} }; }
    else { assert.deepEqual(request.tools, []); if (calls === 6) { if (kind === 'initialization') yield { type: 'text_delta', delta: JSON.stringify(state) }; } else yield { type: 'text_delta', delta: JSON.stringify(kind === 'initialization' ? state : candidate()) }; }
    yield { type: 'usage', usage: measured }; yield { type: 'done', stopReason: calls <= 5 ? 'toolUse' : calls === 6 && kind === 'initialization' ? 'length' : 'stop' };
  };
  const result = kind === 'initialization' ? await bootstrapProject({ title: 'Reference review', catalog: { skills: [], tools: [], mcpServers: [] }, model, provider, referenceTools, maxAttempts: 2, onEvent: event => events.push(event) }) : await proposeProjectGenome({ ...learningOptions, learningContext: undefined, referenceTools, provider, maxAttempts: 2, onProgress: event => events.push(event) });
  assert.equal(calls, 7); assert.equal(reads, 5); assert.equal(result.attempts, 2); assert.equal(result.usage.totalTokens, 91); assert.equal(result.repairEvidence[0].error.code, 'invalid_output');
  assert.equal(events.filter(row => row.type === (kind === 'initialization' ? 'bootstrap_output_failure' : 'structured_output_failure')).length, 1);
  if (kind === 'initialization') { assert.equal(result.status, 'ready'); assert.equal(result.repairEvidence[0].after, null); assert.equal(result.repairEvidence[0].error.responseDiagnostic.stopReason, 'length'); }
  else assert.equal(result.validation.passed, true);
});

for (const failureKind of ['no_done', 'unknown_stop', 'missing_stop', 'error_after_done', 'illegal_tool', 'forged_diagnostic', 'budget', 'cancel']) test(`author finalization ${failureKind} cannot acquire a new paid retry through terminal diagnostics`, async () => {
  let calls = 0, admissions = 0; const events = [], controller = new AbortController();
  const provider = async function* (request) {
    calls++;
    if (request.tools.length) { yield { type: 'tool_call', id: `source-${calls}`, name: 'learning_context_read', arguments: { id: 'file:source.js' } }; yield { type: 'usage', usage: measured }; yield { type: 'done', stopReason: 'toolUse' }; return; }
    if (failureKind === 'forged_diagnostic') throw Object.assign(new SessionError('Untrusted provider exception', 'step_limit'), { responseDiagnostic: { purpose: 'step-limit-summary', requestId: 'invented', messageId: 'invented', completed: true, toolCallCount: 0, stopReason: 'stop', outputBytes: 0, kind: 'empty_response' } });
    if (failureKind === 'illegal_tool') yield { type: 'tool_call', id: 'forbidden-final-read', name: 'learning_context_read', arguments: { id: 'file:source.js' } };
    yield { type: 'usage', usage: measured };
    if (failureKind === 'cancel') { controller.abort(Object.assign(new Error('Explicit cancellation'), { code: 'cancelled' })); request.signal.throwIfAborted(); }
    if (failureKind !== 'no_done') yield { type: 'done', ...(failureKind === 'missing_stop' ? {} : { stopReason: failureKind === 'unknown_stop' ? 'unknown' : failureKind === 'illegal_tool' ? 'toolUse' : 'stop' }) };
    if (failureKind === 'error_after_done') throw Object.assign(new Error('Provider failed after its done frame'), { code: 'provider_error' });
  };
  const expected = { no_done: 'provider_incomplete', unknown_stop: 'step_limit', missing_stop: 'step_limit', error_after_done: 'provider_error', illegal_tool: 'step_limit', forged_diagnostic: 'step_limit', budget: 'budget_exhausted', cancel: 'cancelled' }[failureKind];
  await assert.rejects(proposeProjectGenome({ ...learningOptions, maxAttempts: 3, provider, signal: controller.signal, onProgress: event => events.push(event), requestControl: { beforeRequest: () => { admissions++; if (failureKind === 'budget' && admissions === 6) throw Object.assign(new Error('No remaining budget'), { code: 'budget_exhausted' }); } } }), error => {
    assert.equal(error.code, expected); assert.equal(error.responseDiagnostic, undefined); assert.equal(error.evolutionDiagnostic?.responseDiagnostic, undefined); assert.equal(error.learningContextReads.length, 5);
    if (failureKind !== 'forged_diagnostic') assert.equal(error.usage.totalTokens, failureKind === 'budget' ? 65 : 78);
    else assert.ok(error.usage.estimatedTokens > 0, 'An actually dispatched failed request retains unknown usage instead of claiming zero');
    return true;
  });
  assert.equal(calls, failureKind === 'budget' ? 5 : 6); assert.equal(admissions, 6); assert.equal(events.filter(event => event.type === 'structured_output_failure').length, 0);
});
