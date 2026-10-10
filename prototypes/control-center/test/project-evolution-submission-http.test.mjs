import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { ProjectEvolutionService } from '../test-support/marketplace-isolation.mjs';
import { streamCompletion } from '../../../packages/sdk/src/providers.mjs';
import { evolutionHash } from '../../../packages/sdk/src/evolution.mjs';
import { projectGenomeFixture, diagnosisFixture } from '../../../packages/sdk/test/fixtures/project-genome.mjs';

// All model responses here are explicit local HTTP fixtures. Generated helper
// scripts and the normal frozen evaluation pipeline still execute for real.
async function setup(t, { abnormalSubmission = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-submission-http-'));
  const store = new Store(join(dir, 'state.json'));
  const { project } = store.createProject({ name: 'Structured author submission boundary', workspace: dir, initiative: { enabled: false } });
  const genomes = new ProjectGenomeStore(store), baseline = projectGenomeFixture();
  const prepared = await genomes.prepare(project, { genome: baseline, versionId: project.activeVersionId }); await prepared.commit();
  store.mutate(state => {
    const target = state.projects.find(row => row.id === project.id);
    target.simulated = false; target.decisionMode = 'rna-model'; target.initialization = { status: 'ready' };
    target.versions.find(row => row.id === target.activeVersionId).bundle = prepared.record;
  });
  await writeFile(join(dir, 'original-project.txt'), 'unchanged user workspace');
  const current = () => store.state.projects.find(row => row.id === project.id);
  const originalBaseline = structuredClone(current().versions.find(row => row.id === project.activeVersionId));
  const evidence = [{ id: 'observed-work', type: 'work_result', summary: 'A checked helper result lacked a useful interpretation.', detail: { sourceIds: ['session:fixture-source'] } }];
  const learningContext = { schemaVersion: 1, evidence: [{ id: evidence[0].id, content: 'Recorded helper result was correct; interpretation was absent.' }], files: [1, 2, 3, 4, 5].map(index => ({ path: `source${index}.js`, content: `export const observed${index} = ${index};` })) };
  const candidate = projectGenomeFixture({ candidate: true });
  candidate.tools = [{ id: baseline.tools[0].id, inheritFromBaseline: true }]; delete candidate.evaluationSuite;
  const proposal = { summary: 'Interpret already checked evidence', hypothesis: 'A precise interpretation improves the usefulness of the same helper result.', diagnosis: { ...diagnosisFixture(), evidenceIds: [evidence[0].id] }, changes: ['Improve instructions while retaining the validated helper implementation.'], genome: candidate };
  const calls = [], wireErrors = [], hooks = {}; let authorCalls = 0;
  const writeResponse = (res, { text, tool, finishReason = tool ? 'tool_calls' : 'stop' }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`);
    const delta = tool ? { tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { content: text };
    res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  };
  const server = createServer(async (req, res) => {
    try {
      let bytes = ''; for await (const chunk of req) bytes += chunk;
      const body = JSON.parse(bytes), prompt = body.messages.find(message => message.role === 'system')?.content ?? '';
      const row = { body, kind: null }; calls.push(row);
      if (body.tools?.some(tool => tool.function.name === 'submit_project_artifact')) {
        row.kind = 'submission';
        assert.equal(body.tools.length, 1); assert.equal(body.response_format, undefined); assert.equal(body.tool_choice, undefined);
        const schema = body.tools[0].function.parameters;
        assert.equal(schema.type, 'object'); assert.equal(schema.oneOf.length, 2);
        const candidateSchema = schema.oneOf.find(branch => branch.properties?.genome);
        const abstentionSchema = schema.oneOf.find(branch => branch.properties?.decision?.const === 'no_change');
        assert.ok(candidateSchema); assert.ok(abstentionSchema);
        assert.deepEqual(Object.keys(abstentionSchema.properties).sort(), ['abstention', 'decision']);
        assert.deepEqual([...abstentionSchema.required].sort(), ['abstention', 'decision']);
        assert.equal(abstentionSchema.additionalProperties, false);
        assert.deepEqual(Object.keys(candidateSchema.properties).sort(), [...Object.keys(proposal), 'withdrawSkills', 'withdrawSkillResources'].sort());
        assert.ok(candidateSchema.required.includes('genome'));
        for (const optional of ['withdrawSkills', 'withdrawSkillResources']) assert.equal(candidateSchema.required.includes(optional), false);
        await hooks.beforeSubmissionResponse?.();
        return writeResponse(res, { tool: { id: 'captured-project-proposal', name: 'submit_project_artifact', arguments: proposal }, ...(abnormalSubmission ? { finishReason: 'insufficient_system_resource' } : {}) });
      }
      if (prompt.includes('Create one improved executable project agent')) {
        row.kind = 'research'; authorCalls++;
        if (authorCalls <= 5) {
          assert.ok(body.tools.some(tool => tool.function.name === 'learning_context_read'));
          return writeResponse(res, { tool: { id: `source-read-${authorCalls}`, name: 'learning_context_read', arguments: { id: `file:source${authorCalls}.js` } } });
        }
        assert.equal(authorCalls, 6, 'The submission retry cannot restart paid source research.');
        assert.deepEqual(body.response_format, { type: 'json_object' }); assert.equal(body.tool_choice, 'none');
        return writeResponse(res, { text: ' \n ', finishReason: 'stop' });
      }
      if (prompt.includes('blind evaluator')) {
        row.kind = 'judge'; assert.equal(body.tools?.some(tool => /learning_context|submit_project_artifact/.test(tool.function.name)) ?? false, false);
        const input = JSON.parse(body.messages.find(message => message.role === 'user').content);
        return writeResponse(res, { text: JSON.stringify({ ratings: input.criteria.map(criterion => ({ criterionId: criterion.id, left: input.left.answer.includes('precise') ? .9 : .5, right: input.right.answer.includes('precise') ? .9 : .5, reason: 'Fixture judgment compares actually executed helper answers.' })) }) });
      }
      assert.ok(prompt.includes('BASELINE_AGENT') || prompt.includes('CANDIDATE_AGENT'));
      row.kind = 'evaluation'; assert.equal(body.tools?.some(tool => /learning_context|submit_project_artifact/.test(tool.function.name)) ?? false, false);
      if (!body.messages.some(message => message.role === 'tool')) return writeResponse(res, { tool: { id: `evaluate-helper-${calls.length}`, name: 'evidence_helper', arguments: { value: 2 } } });
      return writeResponse(res, { text: prompt.includes('CANDIDATE_AGENT') ? 'precise evidence: the helper returned 4; use the checked result for the next project decision.' : 'preliminary evidence: the helper returned 4.' });
    } catch (error) { wireErrors.push(error); if (!res.headersSent) res.writeHead(500); res.end('isolated fixture assertion failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const model = { providerId: 'local-submission-fixture', modelId: 'fixture', execution: 'rna', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 128000, maxOutputTokens: 4000, reasoning: 'off', compat: { supportsJsonObject: true, supportsToolChoiceNone: true } };
  const service = new ProjectEvolutionService(store, { genomeStore: genomes, provider: streamCompletion });
  t.after(async () => { service.close(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, service, current, calls, wireErrors, hooks, model, evidence, learningContext, proposal, baseline, originalBaseline, projectId: project.id, baselineId: project.activeVersionId };
}
async function audit(result) {
  const dir = result.version.artifactDir;
  return { trace: (await readFile(join(dir, 'trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse), artifact: name => readFile(join(dir, name), 'utf8').then(JSON.parse), mode: name => stat(join(dir, name)).then(value => value.mode & 0o777) };
}
async function assertPreserved(app, result) {
  assert.deepEqual(app.wireErrors, []);
  assert.equal(app.current().activeVersionId, app.baselineId); assert.equal(app.current().trialVersionId, null);
  assert.deepEqual(app.current().versions.find(row => row.id === app.baselineId), app.originalBaseline);
  assert.equal(await readFile(join(app.dir, 'original-project.txt'), 'utf8'), 'unchanged user workspace');
  const files = await audit(result);
  assert.deepEqual((await files.artifact('evidence.json')).evidence, app.evidence);
  assert.deepEqual((await files.artifact('baseline.json')).genome, app.baseline);
  assert.deepEqual((await files.artifact('learning-context.json')).files, app.learningContext.files);
  assert.deepEqual(result.version.learningContextReads.map(row => row.id), [1, 2, 3, 4, 5].map(index => `file:source${index}.js`));
  return files;
}

test('HTTP native empty tail uses one sole structured submission then original inheritance evaluation and private receipt chain', async t => {
  const app = await setup(t), admitted = [], settled = [];
  const result = await app.service.evolve(app.projectId, { model: app.model, evidence: app.evidence, learningContext: app.learningContext, learningReviewId: 'review-submission-fixture', requestControl: { beforeRequest: request => admitted.push(request.id), onUsage: entry => settled.push(entry) } });
  assert.equal(result.status, 'ready', JSON.stringify({ error: result.version?.error, wireErrors: app.wireErrors.map(error => error.message) }));
  const files = await assertPreserved(app, result);
  assert.equal(app.calls.filter(row => row.kind === 'research').length, 6); assert.equal(app.calls.filter(row => row.kind === 'submission').length, 1);
  assert.equal(app.calls.filter(row => row.kind === 'evaluation').length, 12); assert.equal(app.calls.filter(row => row.kind === 'judge').length, 3);
  const submission = app.calls.find(row => row.kind === 'submission').body;
  const sourceReceipts = submission.messages.filter(message => message.role === 'tool');
  assert.deepEqual(sourceReceipts.map(message => message.tool_call_id), [1, 2, 3, 4, 5].map(index => `source-read-${index}`));
  assert.deepEqual(sourceReceipts.map(message => JSON.parse(message.content).content), app.learningContext.files.map(file => file.content));
  assert.equal(submission.reasoning_effort, app.calls[0].body.reasoning_effort);
  assert.equal(result.version.proposalAttempts, 2); assert.equal(result.version.evaluation.gatePassed, true); assert.equal(result.version.evaluation.evaluationComplete, true);
  assert.equal(result.version.evaluation.baselineScore, .5); assert.equal(result.version.evaluation.candidateScore, .9);
  const inheritance = { baselineHash: evolutionHash(app.baseline), tools: [{ id: app.baseline.tools[0].id, toolHash: evolutionHash(app.baseline.tools[0]) }] };
  assert.deepEqual(result.version.proposal.toolInheritance, inheritance);
  const proposal = await files.artifact('proposal.json'); assert.deepEqual(proposal.toolInheritance, inheritance); assert.deepEqual(proposal.genome.tools, app.baseline.tools);
  const bundle = await app.service.genomes.read(app.projectId, result.version.id); assert.deepEqual(bundle.genome.tools, app.baseline.tools); assert.equal(JSON.stringify(bundle.genome).includes('inheritFromBaseline'), false);
  assert.deepEqual((await files.artifact('frozen-evaluation.json')).suite, app.baseline.evaluationSuite);
  const saved = await files.artifact('result.json'); assert.equal(saved.requests.length, 22); assert.equal(saved.usage.totalTokens, 286); assert.equal(saved.usage.estimatedTokens, 0);
  assert.equal(result.usage.totalTokens, 286); assert.equal(new Set(admitted).size, 22); assert.deepEqual(settled.map(row => row.id), admitted);
  assert.ok(settled.every(row => row.usage.totalTokens === 13 && row.usageReported && !row.estimatedWhenUnknown));
  const captures = files.trace.filter(row => row.type === 'author_submission_captured'); assert.equal(captures.length, 1);
  assert.equal(captures[0].schemaHash, evolutionHash(submission.tools[0].function.parameters)); assert.equal(captures[0].argumentHash, evolutionHash(app.proposal));
  assert.equal(captures[0].sourceRequestId, files.trace.find(row => row.type === 'structured_output_failure').diagnostic.requestId);
  assert.equal(captures[0].requestId, files.trace.find(row => row.type === 'author_submission_started').requestId);
  assert.equal(captures[0].callId, 'captured-project-proposal'); assert.equal(captures[0].reasoning, app.model.reasoning);
  assert.equal(captures[0].providerFinishReason, 'tool_calls'); assert.equal(captures[0].stopReason, 'toolUse'); assert.equal(captures[0].textBytes, 0);
  assert.equal(files.trace.filter(row => row.type === 'author_submission_started').length, 1); assert.equal(files.trace.filter(row => row.type === 'learning_context_read').length, 5);
  assert.equal(await files.mode('proposal.json'), 0o600); assert.equal(await files.mode('result.json'), 0o600);
});

test('HTTP abnormal structured submission cannot capture a valid-looking proposal and retains exactly seven actual request bills', async t => {
  const app = await setup(t, { abnormalSubmission: true }), settled = [];
  const result = await app.service.evolve(app.projectId, { model: app.model, evidence: app.evidence, learningContext: app.learningContext, requestControl: { onUsage: entry => settled.push(entry) } });
  assert.equal(result.status, 'failed'); assert.equal(result.version.error.code, 'provider_termination');
  const files = await assertPreserved(app, result);
  assert.equal(app.calls.length, 7); assert.equal(app.calls.filter(row => row.kind === 'submission').length, 1);
  assert.equal(result.version.proposal, undefined); assert.equal(result.version.bundle, undefined); assert.equal(result.version.evaluation, null);
  assert.equal(files.trace.some(row => row.type === 'author_submission_captured'), false);
  const saved = await files.artifact('failure.json'); assert.equal(saved.requests.length, 7); assert.equal(saved.usage.totalTokens, 91); assert.equal(saved.usage.estimatedTokens, 0);
  assert.equal(result.usage.totalTokens, 91); assert.equal(settled.length, 7); assert.equal(new Set(settled.map(row => row.id)).size, 7);
  assert.equal(saved.requests.at(-1).providerFinishReason, 'insufficient_system_resource'); assert.equal(saved.requests.at(-1).completed, false); assert.equal(saved.requests.at(-1).usage.totalTokens, 13);
  await assert.rejects(access(join(result.version.artifactDir, 'proposal.json')), { code: 'ENOENT' });
  assert.equal(await files.mode('failure.json'), 0o600);
});

test('cancellation and source revocation before admission or during HTTP submission preserve actual bills without publishing a proposal or bundle', async t => {
  for (const boundary of ['cancel', 'source_revoked', 'source_revoked_inflight']) {
    const app = await setup(t), controller = new AbortController(), settled = []; let sourceCurrent = true, boundaryHit = false, denied = 0;
    const revokeSource = () => { sourceCurrent = false; app.store.mutate(state => { const version = state.projects.find(row => row.id === app.projectId).versions.at(-1); version.contextRevoked = true; }); };
    if (boundary === 'source_revoked_inflight') app.hooks.beforeSubmissionResponse = () => { boundaryHit = true; revokeSource(); };
    const result = await app.service.evolve(app.projectId, {
      model: app.model, evidence: app.evidence, learningContext: app.learningContext, signal: controller.signal, commitGuard: () => sourceCurrent,
      requestControl: {
        // This fixture exercises the real host admission/commit interfaces. It
        // does not pretend to exercise the application's deletion API.
        beforeRequest: () => { if (!sourceCurrent) { denied++; throw Object.assign(new Error('Fixture source was revoked before dispatch'), { code: 'source_revoked' }); } },
        onUsage: entry => settled.push(entry),
      },
      onProgress: event => {
        if (event.type !== 'structured_output_failure' || boundaryHit || boundary === 'source_revoked_inflight') return;
        boundaryHit = true;
        if (boundary === 'cancel') controller.abort(new DOMException('Fixture cancellation after a paid tail response', 'AbortError'));
        else revokeSource();
      },
    });
    assert.equal(boundaryHit, true); assert.equal(result.status, boundary === 'cancel' ? 'interrupted' : boundary === 'source_revoked_inflight' ? 'stale' : 'failed');
    if (boundary === 'source_revoked') { assert.equal(denied, 1); assert.equal(result.version.error.code, 'source_revoked'); assert.equal(result.version.contextRevoked, true); }
    if (boundary === 'source_revoked_inflight') { assert.equal(denied, 0); assert.equal(result.version.error.code, 'stale'); assert.equal(result.version.contextRevoked, true); }
    const files = await assertPreserved(app, result);
    const paidRequests = boundary === 'source_revoked_inflight' ? 7 : 6;
    assert.equal(app.calls.length, paidRequests); assert.equal(app.calls.filter(row => row.kind === 'submission').length, paidRequests - 6);
    // Captured is a staged in-memory envelope, not a published candidate. A
    // source revoked in flight is still rejected by the host's commit guard.
    assert.equal(files.trace.filter(row => row.type === 'author_submission_captured').length, paidRequests - 6);
    assert.equal(app.calls.some(row => ['evaluation', 'judge'].includes(row.kind)), false);
    assert.equal(result.version.bundle, undefined); assert.equal(result.version.proposal, undefined); assert.equal(result.version.evaluation, null);
    const saved = await files.artifact('failure.json'); assert.equal(saved.requests.length, paidRequests); assert.equal(saved.usage.totalTokens, paidRequests * 13); assert.equal(saved.usage.estimatedTokens, 0);
    assert.equal(result.usage.totalTokens, paidRequests * 13); assert.equal(settled.length, paidRequests); assert.equal(new Set(settled.map(row => row.id)).size, paidRequests);
    assert.ok(settled.every(row => row.completed && row.usageReported && row.usage.totalTokens === 13));
    await assert.rejects(access(join(result.version.artifactDir, 'proposal.json')), { code: 'ENOENT' });
    await assert.rejects(access(join(result.version.artifactDir, 'evaluation.json')), { code: 'ENOENT' });
  }
});
