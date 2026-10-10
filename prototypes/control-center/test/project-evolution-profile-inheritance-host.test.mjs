import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../store.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { ProjectEvolutionService } from '../test-support/marketplace-isolation.mjs';
import { streamCompletion } from '../../../packages/sdk/src/providers.mjs';
import { evolutionHash } from '../../../packages/sdk/src/evolution.mjs';
import { PROJECT_EVALUATION_RUNTIME } from '../../../packages/sdk/src/project-evolution.mjs';
import { projectGenomeFixture, diagnosisFixture } from '../../../packages/sdk/test/fixtures/project-genome.mjs';

// Explicit isolated HTTP responses and judge ratings; generated helpers and
// skill resource reads execute through the actual evaluator. No live model.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function setup(t, { execution } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-profile-inheritance-host-')), store = new Store(join(dir, 'state.json'));
  const { project } = store.createProject({ name: 'Profile and immutable skills fixture', workspace: dir, initiative: { enabled: false } });
  const baseline = projectGenomeFixture();
  baseline.skills[0].resources = [1, 2, 3, 4].map(index => ({ path: `references/guide-${index}.md`, content: `Frozen evidence procedure resource ${index}.` }));
  baseline.skills.push({ id: 'verification_detail', name: 'Verification detail', description: 'Preserve a checked reference.', instructions: 'Consult the retained procedure when verification is needed.', resources: [{ path: 'checks/retained.md', content: 'The checked helper result must retain the original output shape.' }] });
  if (execution) baseline.evaluationSuite.execution = structuredClone(execution);
  const genomes = new ProjectGenomeStore(store), prepared = await genomes.prepare(project, { genome: baseline, versionId: project.activeVersionId }); await prepared.commit();
  store.mutate(state => { const current = state.projects.find(row => row.id === project.id); current.simulated = false; current.decisionMode = 'rna-model'; current.initialization = { status: 'ready' }; current.versions.find(row => row.id === current.activeVersionId).bundle = prepared.record; });
  await writeFile(join(dir, 'user-project.txt'), 'Original user-owned workspace bytes.');
  const current = () => store.state.projects.find(row => row.id === project.id), originalBaseline = structuredClone(current().versions.find(row => row.id === project.activeVersionId));
  const candidate = structuredClone(baseline); candidate.systemPrompt = projectGenomeFixture({ candidate: true }).systemPrompt;
  const rawGenome = structuredClone(candidate); delete rawGenome.evaluationSuite;
  rawGenome.tools = [{ id: baseline.tools[0].id, inheritFromBaseline: true }];
  rawGenome.skills = [
    { id: baseline.skills[0].id, inheritFromBaseline: true },
    { ...structuredClone(baseline.skills[1]), instructions: 'Use the checked reference, then explain the observed result precisely.', resources: [{ path: baseline.skills[1].resources[0].path, inheritFromBaseline: true }] },
  ];
  const proposal = { summary: 'Preserve reference procedures while improving interpretation', hypothesis: 'Useful interpretation can improve without deleting checked project procedures.', diagnosis: diagnosisFixture(), changes: ['Improve interpretation and retain all original resources.'], genome: rawGenome };
  const calls = [], wireErrors = [], hooks = { failJudge: false };
  const respond = (res, { text, tool }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`);
    const delta = tool ? { tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { content: text };
    res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  };
  const server = createServer(async (request, response) => {
    try {
      let bodyText = ''; for await (const chunk of request) bodyText += chunk;
      const body = JSON.parse(bodyText), prompt = body.messages.find(row => row.role === 'system')?.content ?? '', row = { body, kind: null }; calls.push(row);
      if (prompt.includes('Create one improved executable project agent')) { row.kind = 'author'; return respond(response, { text: JSON.stringify(proposal) }); }
      if (prompt.includes('blind evaluator')) {
        row.kind = 'judge'; const input = JSON.parse(body.messages.find(message => message.role === 'user').content);
        const ratings = hooks.failJudge ? { ratings: [] } : { ratings: input.criteria.map(criterion => ({ criterionId: criterion.id, left: input.left.answer.includes('precise') ? .9 : .5, right: input.right.answer.includes('precise') ? .9 : .5, reason: 'Explicit fixture rating of actual helper output and retained procedure reads.' })) };
        if (body.tools?.[0]?.function.name === 'submit_evaluation_ratings') return respond(response, { tool: { id: `ratings-${calls.length}`, name: 'submit_evaluation_ratings', arguments: ratings } });
        return respond(response, { text: JSON.stringify(ratings) });
      }
      assert.ok(prompt.includes('BASELINE_AGENT') || prompt.includes('CANDIDATE_AGENT'));
      row.kind = prompt.includes('CANDIDATE_AGENT') ? 'candidate' : 'baseline';
      const receipts = body.messages.filter(message => message.role === 'tool'); row.completedTools = receipts.length;
      const id = `read-${calls.length}`;
      if (receipts.length === 0) return respond(response, { tool: { id, name: 'skill_load', arguments: { id: 'evidence_review' } } });
      if (receipts.length <= 4) return respond(response, { tool: { id, name: 'skill_load', arguments: { id: 'evidence_review', path: `references/guide-${receipts.length}.md` } } });
      if (receipts.length === 5) return respond(response, { tool: { id, name: 'evidence_helper', arguments: { value: 2 } } });
      assert.equal(receipts.length, 6);
      for (const [index, receipt] of receipts.slice(1, 5).entries()) assert.match(receipt.content, new RegExp(`Frozen evidence procedure resource ${index + 1}`));
      return respond(response, { text: row.kind === 'candidate' ? 'precise evidence: the checked helper returned 4; retain the procedures and apply the result.' : 'preliminary evidence: the checked helper returned 4.' });
    } catch (error) { wireErrors.push(error); if (!response.headersSent) response.writeHead(500); response.end('Isolated fixture assertion failed.'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const model = { providerId: 'local-profile-fixture', modelId: 'fixture', execution: 'rna', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 128000, maxOutputTokens: 4000, reasoning: 'off' };
  const service = new ProjectEvolutionService(store, { genomeStore: genomes, provider: streamCompletion });
  t.after(async () => { service.close(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, projectId: project.id, baselineId: project.activeVersionId, current, originalBaseline, baseline, candidate, proposal, model, calls, wireErrors, hooks, service };
}
async function artifacts(version) {
  const json = name => readFile(join(version.artifactDir, name), 'utf8').then(JSON.parse);
  const trace = await readFile(join(version.artifactDir, 'trace.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  return { json, frozen: await json('frozen-evaluation.json'), trace: trace.trim().split('\n').filter(Boolean).map(JSON.parse) };
}
async function immutableFiles(dir) {
  return Promise.all((await readdir(dir)).sort().map(async name => ({ name, hash: sha(await readFile(join(dir, name))) })));
}
async function preserved(app) {
  assert.deepEqual(app.wireErrors, []); assert.equal(app.current().activeVersionId, app.baselineId); assert.equal(app.current().trialVersionId, null);
  assert.deepEqual(app.current().versions.find(row => row.id === app.baselineId), app.originalBaseline);
  assert.equal(await readFile(join(app.dir, 'user-project.txt'), 'utf8'), 'Original user-owned workspace bytes.');
}
function manifest(version, frozen, expected) {
  const value = version.evaluationExecution;
  assert.ok(value); assert.deepEqual(frozen.evaluationExecution, value);
  assert.equal(value.profile.id, 'workflow-v3'); assert.equal(value.profile.version, 1); assert.match(value.profile.hash, /^[a-f0-9]{64}$/);
  const profile = PROJECT_EVALUATION_RUNTIME.executionProfile;
  assert.deepEqual(value.profile, { id: profile.id, version: profile.version, hash: profile.hash });
  assert.deepEqual(profile.defaults.withoutWorkspace, { maxSteps: 16, maxOutputTokens: 4096 });
  assert.deepEqual(value.sessionPolicy, { autoCompaction: false, stepLimitBehavior: 'error' });
  assert.equal(value.sourceSuiteHash, evolutionHash(frozen.suite)); assert.equal(value.cases.length, 3);
  for (const row of value.cases) assert.deepEqual(row.execution, expected);
  assert.match(value.effectiveExecutionHash, /^[a-f0-9]{64}$/); assert.match(value.manifestHash, /^[a-f0-9]{64}$/);
  return value;
}

test('fixed evaluation profile completes necessary resource reads while inherited skills retain exact frozen bytes and durable manifest provenance', async t => {
  const app = await setup(t), result = await app.service.evolve(app.projectId, { model: app.model });
  assert.equal(result.status, 'ready', JSON.stringify(result.version.error));
  const files = await artifacts(result.version), execution = manifest(result.version, files.frozen, { maxSteps: 16, maxOutputTokens: 4000 });
  assert.deepEqual(result.version.evaluation.evaluationExecution, execution); assert.deepEqual((await files.json('evaluation.json')).evaluationExecution, execution);
  assert.deepEqual(files.frozen.suite, app.baseline.evaluationSuite);
  const proposal = await files.json('proposal.json'), expectedSkill = app.baseline.skills[0], expectedResource = app.baseline.skills[1].resources[0];
  assert.deepEqual(proposal.genome.skills[0], expectedSkill); assert.deepEqual(proposal.genome.skills[1].resources[0], expectedResource);
  assert.equal(proposal.assetChanges.baselineHash, evolutionHash(app.baseline));
  assert.deepEqual(proposal.assetChanges.inheritedSkills, [{ id: expectedSkill.id, beforeHash: evolutionHash(expectedSkill) }]);
  assert.deepEqual(proposal.assetChanges.inheritedSkillResources, [{ skillId: app.baseline.skills[1].id, path: expectedResource.path, beforeHash: evolutionHash(expectedResource) }]);
  assert.deepEqual(result.version.proposal.assetChanges, proposal.assetChanges);
  const bundle = await app.service.genomes.read(app.projectId, result.version.id); assert.deepEqual(bundle.genome.skills, proposal.genome.skills);
  assert.equal(app.calls.filter(row => row.kind === 'author').length, 1); assert.equal(app.calls.filter(row => row.kind === 'baseline').length, 21); assert.equal(app.calls.filter(row => row.kind === 'candidate').length, 21); assert.equal(app.calls.filter(row => row.kind === 'judge').length, 3);
  assert.equal(result.usage.totalTokens, 46 * 13); assert.equal(result.usage.estimatedTokens, 0);
  assert.equal(result.version.evaluation.evaluationComplete, true); assert.equal(result.version.evaluation.gatePassed, true);
  await preserved(app);
});

test('explicit frozen suite limits override the new profile and remain recorded on failed execution with exact actual usage', async t => {
  const app = await setup(t, { execution: { maxSteps: 4, maxOutputTokens: 512 } });
  const result = await app.service.evolve(app.projectId, { model: app.model, genome: app.candidate });
  assert.equal(result.status, 'failed'); assert.equal(result.version.error.code, 'step_limit');
  const files = await artifacts(result.version), execution = manifest(result.version, files.frozen, { maxSteps: 4, maxOutputTokens: 512 });
  const failure = await files.json('failure.json'); assert.deepEqual(failure.evaluationExecution, execution); assert.deepEqual(failure.evidence.evaluationExecution, execution);
  assert.deepEqual(result.version.evaluationEvidence.evaluationExecution, execution);
  assert.equal(app.calls.length, 4); assert.ok(app.calls.every(row => row.kind === 'baseline'));
  assert.equal(result.usage.totalTokens, 52); assert.equal(result.usage.estimatedTokens, 0); assert.equal(result.version.bundle, undefined); assert.equal(result.version.evaluation, null);
  assert.equal(failure.evidence.inFlightCase.baseline.execution.maxSteps, 4); assert.equal(failure.evidence.inFlightCase.baseline.execution.maxOutputTokens, 512);
  await preserved(app);
});

test('explicit reevaluation labels the current execution contract, records prior manifest and preserves all source record and artifact bytes', async t => {
  const app = await setup(t); app.hooks.failJudge = true;
  const first = await app.service.evolve(app.projectId, { model: app.model });
  assert.equal(first.status, 'failed'); assert.ok(first.version.candidateHash && first.version.proposal);
  const original = structuredClone(first.version), originalFiles = await immutableFiles(first.version.artifactDir), priorCalls = app.calls.length;
  app.hooks.failJudge = false;
  const result = await app.service.evolve(app.projectId, { model: app.model, retryVersionId: first.version.id });
  assert.equal(result.status, 'ready', JSON.stringify(result.version.error)); assert.notEqual(result.version.id, original.id);
  assert.equal(result.version.retryOfVersionId, original.id); assert.equal(result.version.candidateHash, original.candidateHash); assert.equal(result.version.baselineHash, original.baselineHash);
  assert.deepEqual(result.version.priorEvaluationExecution, original.evaluationExecution);
  const files = await artifacts(result.version); manifest(result.version, files.frozen, { maxSteps: 16, maxOutputTokens: 4000 });
  assert.match(result.version.proposal.hypothesis, /当前执行契约/); assert.match(result.version.proposal.hypothesis, /原评估记录保持/);
  assert.deepEqual(files.frozen.suite, (await artifacts(original)).frozen.suite);
  assert.deepEqual(result.version.proposal.assetChanges, original.proposal.assetChanges);
  assert.equal(app.calls.slice(priorCalls).filter(row => row.kind === 'author').length, 0); assert.equal(app.calls.length - priorCalls, 45);
  assert.deepEqual(app.current().versions.find(row => row.id === original.id), original); assert.deepEqual(await immutableFiles(first.version.artifactDir), originalFiles);
  const duplicate = await app.service.evolve(app.projectId, { model: app.model, genome: (await files.json('proposal.json')).genome });
  assert.equal(duplicate.replayed, true); assert.equal(app.calls.length - priorCalls, 45);
  await preserved(app);
});

test('a candidate that drops a baseline skill resource without declaration cannot buy more steps into a passing comparison', async t => {
  const app = await setup(t), candidate = structuredClone(app.candidate);
  candidate.skills[0].resources = candidate.skills[0].resources.slice(1);
  const result = await app.service.evolve(app.projectId, { model: app.model, genome: candidate });
  assert.notEqual(result.status, 'ready'); assert.equal(app.calls.length, 0, 'Asset compatibility must reject before paid A/B requests.');
  assert.equal(result.usage.totalTokens, 0); assert.equal(result.usage.estimatedTokens, 0);
  assert.equal(result.version.bundle, undefined); assert.equal(result.version.evaluation?.gatePassed ?? false, false);
  assert.equal(result.version.evaluation?.candidateScore ?? null, null);
  const files = await artifacts(result.version); manifest(result.version, files.frozen, { maxSteps: 16, maxOutputTokens: 4000 });
  assert.equal(files.trace.length, 0);
  const failure = await files.json('failure.json'); assert.deepEqual(failure.evaluationExecution, result.version.evaluationExecution);
  assert.deepEqual(failure.evidence.evaluationExecution, result.version.evaluationExecution);
  const all = await readdir(result.version.artifactDir); assert.equal(all.includes('result.json'), false);
  await preserved(app);
});

test('reevaluation rejects state or private-artifact asset provenance tampering before billing or appending a new version', async t => {
 for (const retained of ['proposal_only', 'bundle']) {
  const app = await setup(t); app.hooks.failJudge = retained === 'proposal_only';
  const first = await app.service.evolve(app.projectId, { model: app.model }); assert.equal(first.status, retained === 'proposal_only' ? 'failed' : 'ready');
  if (retained === 'bundle') {
    // Explicit metadata fixture for an evaluator upgrade; this does not claim
    // the preceding fixture execution actually ran an older implementation.
    app.store.mutate(state => { state.projects.find(row => row.id === app.projectId).versions.find(row => row.id === first.version.id).evaluationRuntimeHash = 'fixture-previous-runtime'; });
  }
  const original = structuredClone(app.current().versions.find(row => row.id === first.version.id)), path = join(first.version.artifactDir, 'proposal.json'), bytes = await readFile(path), proposal = JSON.parse(bytes);
  const paidBefore = app.calls.length, versionCount = app.current().versions.length;
  for (const boundary of ['state_changed', 'artifact_changed', 'state_removed', 'artifact_removed']) {
    const stateCopy = structuredClone(original), artifactCopy = structuredClone(proposal);
    if (boundary === 'state_changed') stateCopy.proposal.assetChanges.inheritedSkills[0].beforeHash = '0'.repeat(64);
    if (boundary === 'artifact_changed') artifactCopy.assetChanges.inheritedSkills[0].beforeHash = '0'.repeat(64);
    if (boundary === 'state_removed') delete stateCopy.proposal.assetChanges;
    if (boundary === 'artifact_removed') delete artifactCopy.assetChanges;
    app.store.mutate(state => { const project = state.projects.find(row => row.id === app.projectId), index = project.versions.findIndex(row => row.id === original.id); project.versions[index] = structuredClone(stateCopy); });
    await writeFile(path, JSON.stringify(artifactCopy));
    const changedBytes = await readFile(path);
    await assert.rejects(app.service.evolve(app.projectId, { model: app.model, retryVersionId: original.id }), { code: 'retry_evidence_changed' }, boundary);
    assert.equal(app.calls.length, paidBefore, boundary); assert.equal(app.current().versions.length, versionCount, boundary);
    assert.deepEqual(app.current().versions.find(row => row.id === original.id), stateCopy, 'Validation must not rewrite the failed source record.');
    assert.equal(sha(await readFile(path)), sha(changedBytes), 'Validation must not repair or overwrite source artifact bytes.');
  }
  // Only restore this isolated fixture's deliberate corruption, never production.
  app.store.mutate(state => { const project = state.projects.find(row => row.id === app.projectId), index = project.versions.findIndex(row => row.id === original.id); project.versions[index] = structuredClone(original); });
  await writeFile(path, bytes);
  await preserved(app);
 }
});
