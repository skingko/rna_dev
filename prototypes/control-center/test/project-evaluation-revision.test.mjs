import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { ProjectEvolutionService } from '../test-support/marketplace-isolation.mjs';
import { ProjectEvolutionController } from '../project-evolution-controller.mjs';
import { describeEvolutionAssessment } from '../project-evolution-assessment.mjs';
import { evolutionHash } from '../../../packages/sdk/src/evolution.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from '../../../packages/sdk/test/fixtures/project-genome.mjs';
const model = { providerId: 'fixture', modelId: 'fixture', execution: 'rna', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 128000, maxOutputTokens: 4000, reasoning: 'off' };
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-standard-revision-')), store = new Store(join(dir, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'fixture', protocol: 'openai', baseUrl: model.baseUrl, models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 4000 }] }); store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture' } });
  const { project } = store.createProject({ name: 'Research fixture', workspace: dir, initiative: { enabled: false } }); const genomes = new ProjectGenomeStore(store), baseline = projectGenomeFixture(), prepared = await genomes.prepare(project, { genome: baseline, versionId: project.activeVersionId }); await prepared.commit();
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); p.initialization = { status: 'ready' }; p.simulated = false; p.versions[0].bundle = prepared.record; p.versions[0].simulated = false; });
  const calls = [], service = new ProjectEvolutionService(store, { genomeStore: genomes, provider: genomeEvaluationProvider({ calls }) }), controller = new ProjectEvolutionController(store, { service });
  const source = (await service.evolve(project.id, { model, genome: projectGenomeFixture({ candidate: true }) })).version;
  t.after(async () => { await controller.close(); service.close(); await rm(dir, { recursive: true, force: true }); });
  const suite = structuredClone(baseline.evaluationSuite); suite.version = 'explicit-clock'; suite.cases.forEach(row => row.clock = { now: '2025-06-01T01:00:00.000Z', timeZone: 'Asia/Shanghai' });
  const input = { retryVersionId: source.id, evaluationRevision: { schemaVersion: 1, sourceSuiteHash: evolutionHash(baseline.evaluationSuite), reason: 'Supply an explicit shared date for a reproducible task environment.', suite } };
  return { dir, store, service, controller, source, projectId: project.id, baseline, baselineId: project.activeVersionId, calls, input, current: () => store.state.projects.find(row => row.id === project.id) };
}
test('reviewed paired run, separate standard adoption and later original-candidate retry preserve historical records', async t => {
  const app = await setup(t);
  app.store.mutate(state => { state.projects.find(row => row.id === app.projectId).versions.find(row => row.id === app.source.id).referenceDiscovery = { mode: 'read-only', searches: 1, filesRead: 1, sources: [{ id: 'fixed-source', contentHash: 'a'.repeat(64) }], installed: false }; });
  const sourceBefore = structuredClone(app.current().versions.find(row => row.id === app.source.id)), baselineBefore = structuredClone(app.current().versions[0]);
  const count = app.calls.length, preview = app.controller.preview(app.projectId, app.input); assert.equal(app.calls.length, count); assert.ok(preview.changes.length); assert.equal(preview.revision.adoption, 'separate_review_required');
  assert.throws(() => app.controller.start(app.projectId, { ...app.input, reviewedRevisionHash: 'bad' }), /预览/); assert.equal(app.store.state.realUsage.reservedTokens, 0);
  app.controller.start(app.projectId, { ...app.input, reviewedRevisionHash: preview.revision.revisionHash }); await app.controller.operations.get(app.projectId).promise;
  const review = app.current().versions.at(-1); assert.equal(review.state, 'reviewed', JSON.stringify(review.error)); assert.equal(review.candidateHash, app.source.candidateHash); assert.equal(review.baselineHash, baselineBefore.bundle.hash); assert.equal(review.evaluation.suiteHash, preview.revision.suiteHash); assert.equal(review.evaluation.baselineHash, baselineBefore.bundle.hash); assert.equal(app.current().activeVersionId, app.baselineId);
  assert.deepEqual(review.referenceDiscovery.sources, sourceBefore.referenceDiscovery.sources); assert.equal(review.referenceDiscovery.inheritedFromVersionId, app.source.id); assert.equal(review.referenceDiscovery.installed, false);
  assert.throws(() => app.store.version(app.projectId, review.id, 'trial'), /修订评估标准/); assert.throws(() => app.store.version(app.projectId, review.id, 'adopt'), /修订评估标准/);
  const paid = app.calls.length, adopted = await app.controller.adoptEvaluationStandard(app.projectId, { action: 'adopt-evaluation-standard', reviewVersionId: review.id, revisionHash: preview.revision.revisionHash });
  assert.equal(app.calls.length, paid); assert.equal(adopted.status, 'standard_adopted'); assert.deepEqual(adopted.version.bundle.genome.skills, app.baseline.skills); assert.deepEqual(adopted.version.bundle.genome.tools, app.baseline.tools); assert.equal(adopted.version.bundle.genome.systemPrompt, app.baseline.systemPrompt); assert.deepEqual(adopted.version.bundle.genome.evaluationSuite, preview.revision.suite);
  assert.deepEqual(app.current().versions.find(row => row.id === app.source.id), sourceBefore); assert.deepEqual(app.current().versions[0], baselineBefore);
  const assessment = describeEvolutionAssessment(sourceBefore, { activeVersionId: adopted.version.id, project: app.current() }); assert.equal(assessment.retry.available, true); assert.equal(assessment.standardRebaseAvailable, true);
  const next = await app.service.evolve(app.projectId, { model, retryVersionId: app.source.id }); assert.equal(next.status, 'ready', JSON.stringify(next.version?.error)); assert.equal(next.version.parentVersionId, adopted.version.id); assert.equal(next.version.evaluation.suiteHash, preview.revision.suiteHash); assert.deepEqual(next.version.bundle.genome.evaluationSuite, preview.revision.suite); assert.equal(next.version.standardRebase.priorCandidateHash, app.source.candidateHash); assert.notEqual(next.version.candidateHash, app.source.candidateHash); assert.deepEqual(next.version.bundle.genome.skills, app.source.bundle.genome.skills);
});
test('revision mutation, source revocation and frozen artifact tampering fail without adopting standards', async t => {
  const app = await setup(t), preview = app.controller.preview(app.projectId, app.input), altered = structuredClone(app.input); altered.evaluationRevision.suite.cases[0].input += ' changed';
  assert.throws(() => app.controller.start(app.projectId, { ...altered, reviewedRevisionHash: preview.revision.revisionHash }), /预览/);
  app.controller.start(app.projectId, { ...app.input, reviewedRevisionHash: preview.revision.revisionHash }); await app.controller.operations.get(app.projectId).promise; const review = app.current().versions.at(-1), paid = app.calls.length;
  const originalRevision = structuredClone(review.evaluationRevision), originalDetails = structuredClone(review.evaluation.details);
  app.store.mutate(state => { state.projects.find(row => row.id === app.projectId).versions.find(row => row.id === review.id).evaluation.details = []; });
  assert.equal(describeEvolutionAssessment(app.current().versions.at(-1), { project: app.current(), activeVersionId: app.baselineId }).standardAdoption.available, false);
  await assert.rejects(app.service.adoptEvaluationStandard(app.projectId, { reviewVersionId: review.id, revisionHash: preview.revision.revisionHash }), { code: 'standard_adoption_invalid' });
  app.store.mutate(state => { state.projects.find(row => row.id === app.projectId).versions.find(row => row.id === review.id).evaluation.details = originalDetails; });
  app.store.mutate(state => { state.projects.find(row => row.id === app.projectId).versions.find(row => row.id === review.id).evaluationRevision.suiteHash = 'f'.repeat(64); });
  await assert.rejects(app.service.adoptEvaluationStandard(app.projectId, { reviewVersionId: review.id, revisionHash: preview.revision.revisionHash })); assert.equal(app.current().activeVersionId, app.baselineId); assert.equal(app.calls.length, paid);
  app.store.mutate(state => { state.projects.find(row => row.id === app.projectId).versions.find(row => row.id === review.id).evaluationRevision = originalRevision; });
  const path = join(review.artifactDir, 'frozen-evaluation.json'), originalFile = await readFile(path, 'utf8'), frozen = JSON.parse(originalFile); frozen.suite.cases[0].input += ' altered artifact'; await writeFile(path, JSON.stringify(frozen));
  await assert.rejects(app.service.adoptEvaluationStandard(app.projectId, { reviewVersionId: review.id, revisionHash: preview.revision.revisionHash }), { code: 'standard_evidence_changed' });
  await writeFile(path, originalFile); app.store.mutate(state => { state.projects.find(row => row.id === app.projectId).versions.find(row => row.id === app.source.id).sourceDeleted = true; });
  await assert.rejects(app.service.adoptEvaluationStandard(app.projectId, { reviewVersionId: review.id, revisionHash: preview.revision.revisionHash }), { code: 'standard_adoption_invalid' }); assert.equal(app.current().activeVersionId, app.baselineId); assert.equal(app.calls.length, paid);
});
test('source revoked during reviewed evaluation blocks the next paid request and never publishes the pair', async t => {
  const app = await setup(t), preview = app.controller.preview(app.projectId, app.input); let admitted = 0;
  const result = await app.service.evolve(app.projectId, { model, retryVersionId: app.source.id, evaluationRevision: preview.revision, reviewedRevisionHash: preview.revision.revisionHash, requestControl: { beforeRequest() { admitted++; app.store.mutate(state => { state.projects.find(row => row.id === app.projectId).versions.find(row => row.id === app.source.id).sourceDeleted = true; }); } } });
  assert.equal(admitted, 1); assert.equal(result.status, 'stale'); assert.equal(result.usage.totalTokens, 0); assert.equal(result.version.bundle, undefined);
});
test('standard-only rebase stops after an in-flight source revocation and retains the consumed request charge', async t => {
  const app = await setup(t), preview = app.controller.preview(app.projectId, app.input);
  const reviewed = await app.service.evolve(app.projectId, { model, retryVersionId: app.source.id, evaluationRevision: preview.revision, reviewedRevisionHash: preview.revision.revisionHash });
  await app.service.adoptEvaluationStandard(app.projectId, { reviewVersionId: reviewed.version.id, revisionHash: preview.revision.revisionHash });
  const actual = app.service.provider; let requests = 0;
  app.service.provider = async function* (request) {
    requests++; yield* actual(request);
    app.store.mutate(state => { state.projects.find(row => row.id === app.projectId).versions.find(row => row.id === app.source.id).contextRevoked = true; });
  };
  const result = await app.service.evolve(app.projectId, { model, retryVersionId: app.source.id });
  assert.equal(requests, 1); assert.equal(result.status, 'stale'); assert.equal(result.usage.totalTokens, 30); assert.equal(result.version.bundle, undefined); assert.equal(result.version.standardRebase.priorCandidateHash, app.source.candidateHash);
});
test('legacy deterministic rejection explicitly reports unscored paired diagnostics without changing scores', () => {
  const version = { state: 'rejected', evaluation: { gatePassed: false, evaluationComplete: false, stage: 'deterministic_case', scoredCases: 0, skippedCases: 3, suite: { cases: [{ id: 'daily', requiredTerms: ['可信度', '来源'] }, {}, {}, {}] }, details: [{ id: 'daily', baseline: { answer: '可信度 来源', toolResults: [{ toolName: 'project_write', isError: true, output: 'Invalid tool arguments: $.expectedHash: anyOf constraint failed' }] }, candidate: { answer: '来源', toolResults: [], checks: { requiredTerms: false }, workspace: { checks: [{ id: 'file', path: 'daily.md', kind: 'file_exists', code: 'artifact_missing', passed: false }] } } }] } };
  const before = structuredClone(version), assessment = describeEvolutionAssessment(version); assert.equal(assessment.scoredCases, 0); assert.equal(assessment.executedCases, 1); assert.equal(assessment.skippedCases, 3); assert.equal(assessment.unscoredReason, 'deterministic_checks_failed'); assert.match(assessment.summary, /尚未进行质量评分/); assert.deepEqual(assessment.diagnosticCases[0].candidate.missingRequiredTerms, ['可信度']); assert.equal(assessment.diagnosticCases[0].baseline.toolErrors[0].argumentPath, '$.expectedHash'); assert.deepEqual(version, before);
});
