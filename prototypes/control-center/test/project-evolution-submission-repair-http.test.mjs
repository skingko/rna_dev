import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, stat, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { ProjectEvolutionService } from '../test-support/marketplace-isolation.mjs';
import { streamCompletion } from '../../../packages/sdk/src/providers.mjs';
import { evolutionHash } from '../../../packages/sdk/src/evolution.mjs';
import { projectGenomeFixture, diagnosisFixture } from '../../../packages/sdk/test/fixtures/project-genome.mjs';

// Every response and rating is an explicit isolated HTTP fixture, not evidence
// of live-model quality. Scripts and the original frozen evaluation path execute
// for real. The older three submission HTTP tests are intentionally unchanged.
const malformedArguments = '{"summary":"unterminated fixture';
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-submission-repair-http-'));
  const store = new Store(join(dir, 'state.json'));
  const { project } = store.createProject({ name: 'Structured author repair boundary', workspace: dir, initiative: { enabled: false } });
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
  const calls = [], wireErrors = [], hooks = {}; let authorCalls = 0, submissionCalls = 0;
  const writeResponse = (res, { text, tool, finishReason = tool ? 'tool_calls' : 'stop' }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`);
    const delta = tool ? { tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.rawArguments ?? JSON.stringify(tool.arguments) } }] } : { content: text };
    res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  };
  const server = createServer(async (req, res) => {
    try {
      let bytes = ''; for await (const chunk of req) bytes += chunk;
      const body = JSON.parse(bytes), prompt = body.messages.find(message => message.role === 'system')?.content ?? '';
      const row = { body, kind: null }; calls.push(row);
      if (body.tools?.some(tool => tool.function.name === 'submit_project_artifact')) {
        row.kind = 'submission'; row.submissionIndex = ++submissionCalls;
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
        assert.ok(submissionCalls <= 2, 'A malformed sole submission has at most one remaining repair.');
        await hooks.beforeSubmissionResponse?.(submissionCalls);
        if (submissionCalls === 1) return writeResponse(res, { tool: { id: 'malformed-project-proposal', name: 'submit_project_artifact', rawArguments: malformedArguments }, finishReason: 'tool_calls' });
        return writeResponse(res, { tool: { id: 'repaired-project-proposal', name: 'submit_project_artifact', arguments: proposal }, finishReason: 'tool_calls' });
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
  for (const entry of await readdir(result.version.artifactDir, { withFileTypes: true })) {
    if (entry.isFile()) assert.equal((await readFile(join(result.version.artifactDir, entry.name), 'utf8')).includes('unterminated fixture'), false, `Raw malformed arguments leaked into ${entry.name}.`);
  }
  assert.equal(JSON.stringify(result.version).includes('unterminated fixture'), false);
  return files;
}

async function assertUnpublished(app, result, { paid, captures = 0 }) {
  const files = await assertPreserved(app, result);
  assert.equal(app.calls.length, paid);
  assert.equal(app.calls.filter(row => row.kind === 'research').length, 6);
  assert.equal(app.calls.filter(row => row.kind === 'submission').length, paid - 6);
  assert.equal(app.calls.some(row => ['evaluation', 'judge'].includes(row.kind)), false);
  assert.equal(files.trace.filter(row => row.type === 'author_submission_captured').length, captures);
  assert.equal(files.trace.filter(row => row.type === 'learning_context_read').length, 5);
  assert.equal(result.version.proposal, undefined); assert.equal(result.version.bundle, undefined); assert.equal(result.version.evaluation, null);
  const failure = await files.artifact('failure.json');
  assert.equal(failure.requests.filter(row => row.requestStarted).length, paid);
  assert.equal(failure.usage.totalTokens, paid * 13); assert.equal(failure.usage.estimatedTokens, 0);
  assert.equal(result.usage.totalTokens, paid * 13);
  await assert.rejects(access(join(result.version.artifactDir, 'proposal.json')), { code: 'ENOENT' });
  await assert.rejects(access(join(result.version.artifactDir, 'evaluation.json')), { code: 'ENOENT' });
  assert.equal(await files.mode('failure.json'), 0o600);
  return files;
}

test('HTTP completed malformed sole submission uses only the eighth author request and retains the original inheritance comparison chain', async t => {
  const app = await setup(t), admitted = [], settled = [];
  const result = await app.service.evolve(app.projectId, {
    model: app.model, evidence: app.evidence, learningContext: app.learningContext, learningReviewId: 'review-submission-repair-fixture',
    requestControl: { beforeRequest: request => admitted.push(request.id), onUsage: entry => settled.push(entry) },
  });
  assert.equal(result.status, 'ready', JSON.stringify({ error: result.version?.error, wireErrors: app.wireErrors.map(error => error.message) }));
  const files = await assertPreserved(app, result);
  assert.equal(app.calls.filter(row => row.kind === 'research').length, 6);
  assert.equal(app.calls.filter(row => row.kind === 'submission').length, 2);
  assert.equal(app.calls.filter(row => row.kind === 'evaluation').length, 12);
  assert.equal(app.calls.filter(row => row.kind === 'judge').length, 3);
  const submissions = app.calls.filter(row => row.kind === 'submission').map(row => row.body);
  const receipts = submissions.map(body => body.messages.filter(message => message.role === 'tool'));
  assert.deepEqual(receipts[0].map(row => row.tool_call_id), [1, 2, 3, 4, 5].map(index => `source-read-${index}`));
  assert.deepEqual(receipts[1], receipts[0], 'Repair carries the same settled research receipts without replaying readers.');
  for (const body of submissions) {
    assert.deepEqual(body.tools, submissions[0].tools);
    assert.equal(body.reasoning_effort, app.calls[0].body.reasoning_effort);
    assert.equal(body.messages.some(message => message.tool_call_id === 'malformed-project-proposal'), false);
  }
  assert.notDeepEqual(submissions[1].messages, submissions[0].messages, 'The one remaining attempt receives host validation feedback.');
  const repairData = submissions[1].messages.filter(message => message.role === 'user').find(message => typeof message.content === 'string' && message.content.includes(malformedArguments));
  assert.ok(repairData, 'The complete raw failed arguments are available only as untrusted in-memory repair data.');
  assert.match(repairData.content, /UNVERIFIED/); assert.match(repairData.content, /not instructions/);
  assert.equal(result.version.proposalAttempts, 3);
  assert.equal(result.version.evaluation.gatePassed, true); assert.equal(result.version.evaluation.evaluationComplete, true);
  assert.equal(result.version.evaluation.baselineScore, .5); assert.equal(result.version.evaluation.candidateScore, .9);
  const inheritance = { baselineHash: evolutionHash(app.baseline), tools: [{ id: app.baseline.tools[0].id, toolHash: evolutionHash(app.baseline.tools[0]) }] };
  assert.deepEqual(result.version.proposal.toolInheritance, inheritance);
  const proposal = await files.artifact('proposal.json'); assert.deepEqual(proposal.toolInheritance, inheritance); assert.deepEqual(proposal.genome.tools, app.baseline.tools);
  const bundle = await app.service.genomes.read(app.projectId, result.version.id); assert.deepEqual(bundle.genome.tools, app.baseline.tools);
  assert.equal(JSON.stringify(bundle.genome).includes('inheritFromBaseline'), false);
  assert.deepEqual((await files.artifact('frozen-evaluation.json')).suite, app.baseline.evaluationSuite);
  const saved = await files.artifact('result.json'); assert.equal(saved.requests.length, 23); assert.equal(saved.usage.totalTokens, 299); assert.equal(saved.usage.estimatedTokens, 0);
  const authorRequests = saved.requests.filter(row => row.phase.startsWith('proposal:'));
  assert.equal(authorRequests.length, 8); assert.equal(authorRequests.reduce((sum, row) => sum + row.usage.totalTokens, 0), 104);
  assert.deepEqual(authorRequests.slice(-2).map(row => row.providerFinishReason), ['tool_calls', 'tool_calls']);
  assert.equal(new Set(admitted).size, 23); assert.deepEqual(settled.map(row => row.id), admitted);
  assert.ok(settled.every(row => row.usage.totalTokens === 13 && row.usageReported && !row.estimatedWhenUnknown));
  const starts = files.trace.filter(row => row.type === 'author_submission_started'), captures = files.trace.filter(row => row.type === 'author_submission_captured');
  assert.equal(starts.length, 2); assert.equal(captures.length, 1);
  assert.equal(captures[0].requestId, authorRequests.at(-1).id); assert.equal(captures[0].callId, 'repaired-project-proposal');
  assert.equal(captures[0].sourceRequestId, starts[0].sourceRequestId); assert.equal(starts[1].sourceRequestId, starts[0].sourceRequestId);
  assert.equal(captures[0].schemaHash, evolutionHash(submissions[1].tools[0].function.parameters)); assert.equal(captures[0].argumentHash, evolutionHash(app.proposal));
  const failures = files.trace.filter(row => row.type === 'author_submission_failed'); assert.equal(failures.length, 1);
  assert.equal(failures[0].complete, false); assert.equal(failures[0].callCount, 0);
  const diagnostic = failures[0].argumentDiagnostic;
  assert.equal(diagnostic.kind, 'completed_submission_arguments_invalid_json'); assert.equal(diagnostic.transportCompleted, true);
  assert.equal(diagnostic.completionMarker, 'openai_done'); assert.equal(diagnostic.assembledToolCount, 1);
  assert.equal(diagnostic.callId, 'malformed-project-proposal'); assert.equal(diagnostic.toolName, 'submit_project_artifact'); assert.equal(diagnostic.providerFinishReason, 'tool_calls');
  assert.equal(diagnostic.argumentBytes, Buffer.byteLength(malformedArguments)); assert.equal(diagnostic.argumentHash, createHash('sha256').update(malformedArguments).digest('hex'));
  assert.equal(diagnostic.requestId, authorRequests.at(-2).id); assert.equal(diagnostic.schemaHash, starts[0].schemaHash);
  assert.equal(diagnostic.contextDigest, starts[0].contextDigest); assert.equal(diagnostic.contractHash, starts[0].contractHash);
  assert.equal(files.trace.filter(row => row.type === 'learning_context_read').length, 5);
  assert.equal(await files.mode('proposal.json'), 0o600); assert.equal(await files.mode('result.json'), 0o600);
});

test('repair admission revocation, budget rejection and cancellation retain seven actual bills without an eighth HTTP request', async t => {
  for (const boundary of ['source_revoked', 'budget_exhausted', 'cancel']) {
    const app = await setup(t), controller = new AbortController(), settled = []; let sourceCurrent = true, boundaryHit = false, admissionCount = 0;
    const result = await app.service.evolve(app.projectId, {
      model: app.model, evidence: app.evidence, learningContext: app.learningContext, signal: controller.signal, commitGuard: () => sourceCurrent,
      requestControl: {
        // Use the actual host admission interface, without pretending this is
        // the application's deletion API or a live global-budget integration.
        beforeRequest: () => {
          if (++admissionCount !== 8) return;
          boundaryHit = true;
          if (boundary === 'source_revoked') { sourceCurrent = false; app.store.mutate(state => { state.projects.find(row => row.id === app.projectId).versions.at(-1).contextRevoked = true; }); }
          if (boundary === 'cancel') { controller.abort(new DOMException('Fixture cancellation before repair dispatch', 'AbortError')); controller.signal.throwIfAborted(); }
          throw Object.assign(new Error(`Fixture repair admission rejected: ${boundary}`), { code: boundary });
        },
        onUsage: entry => settled.push(entry),
      },
    });
    assert.equal(boundaryHit, true, boundary); assert.equal(admissionCount, 8);
    assert.equal(result.status, boundary === 'cancel' ? 'interrupted' : 'failed');
    if (boundary !== 'cancel') assert.equal(result.version.error.code, boundary);
    const files = await assertUnpublished(app, result, { paid: 7 });
    assert.equal(settled.length, 7); assert.equal(new Set(settled.map(row => row.id)).size, 7);
    assert.ok(settled.every(row => row.usageReported && row.usage.totalTokens === 13 && !row.estimatedWhenUnknown));
    assert.equal((await files.artifact('failure.json')).requests.length, 7, 'Denied admission does not fabricate a bill.');
  }
});

test('accounting settlement failures after malformed or repaired HTTP submission cannot capture or publish an artifact', async t => {
  for (const failAt of [7, 8]) {
    const app = await setup(t), settled = []; let boundaryHit = false;
    const result = await app.service.evolve(app.projectId, {
      model: app.model, evidence: app.evidence, learningContext: app.learningContext,
      requestControl: { onUsage: entry => {
        settled.push(entry);
        if (settled.length === failAt) { boundaryHit = true; throw Object.assign(new Error('Fixture settlement failed after its actual receipt'), { code: 'settlement_failed' }); }
      } },
    });
    assert.equal(boundaryHit, true); assert.equal(result.status, 'failed'); assert.equal(result.version.error.code, 'settlement_failed');
    await assertUnpublished(app, result, { paid: failAt });
    assert.equal(settled.length, failAt); assert.equal(new Set(settled.map(row => row.id)).size, failAt);
    assert.ok(settled.every(row => row.usageReported && row.usage.totalTokens === 13));
  }
});

test('source revocation after the eighth HTTP dispatch retains its bill but rejects the staged repaired envelope before evaluation and publication', async t => {
  const app = await setup(t), settled = []; let sourceCurrent = true, boundaryHit = false;
  app.hooks.beforeSubmissionResponse = index => {
    if (index !== 2) return;
    boundaryHit = true; sourceCurrent = false;
    app.store.mutate(state => { state.projects.find(row => row.id === app.projectId).versions.at(-1).contextRevoked = true; });
  };
  const result = await app.service.evolve(app.projectId, {
    model: app.model, evidence: app.evidence, learningContext: app.learningContext, commitGuard: () => sourceCurrent,
    requestControl: { onUsage: entry => settled.push(entry) },
  });
  assert.equal(boundaryHit, true); assert.equal(result.status, 'stale'); assert.equal(result.version.error.code, 'stale'); assert.equal(result.version.contextRevoked, true);
  // Captured is explicitly only an operation-memory draft. The original host
  // commit guard must still reject it before a durable accepted proposal.
  await assertUnpublished(app, result, { paid: 8, captures: 1 });
  assert.equal(settled.length, 8); assert.ok(settled.every(row => row.usageReported && row.usage.totalTokens === 13));
});
