import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { ProjectEvolutionService } from '../test-support/marketplace-isolation.mjs';
import { createEvolutionSearchPolicy, describeEvolutionSearchOutcome } from '../project-evolution-search.mjs';
import { readEvolutionSkillDeliveryDiagnostic } from '../project-skill-discovery-feedback.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from '../../../packages/sdk/test/fixtures/project-genome.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', execution: 'rna', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 128000, maxOutputTokens: 4000 };
async function setup(t, { providerFailure = false, revoke = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-discovery-failure-')), store = new Store(join(dir, 'state.json'));
  const { project } = store.createProject({ name: 'Discovery failure integration', workspace: dir, initiative: { enabled: false } });
  const genomes = new ProjectGenomeStore(store), baseline = projectGenomeFixture(), candidate = structuredClone(baseline);
  candidate.skills[0].instructions += '\nCheck scope before writing the conclusion.';
  const prepared = await genomes.prepare(project, { genome: baseline, versionId: project.activeVersionId }); await prepared.commit();
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); p.initialization = { status: 'ready' }; p.simulated = false; p.versions.find(row => row.id === p.activeVersionId).bundle = prepared.record; });
  const requests = [], failedProvider = genomeEvaluationProvider({ candidate, calls: requests, failJudge: true });
  const service = new ProjectEvolutionService(store, { genomeStore: genomes, provider: async function* (request) {
    if (request.systemPrompt.includes('blind evaluator')) {
      if (revoke) store.mutate(state => { state.projects.find(row => row.id === project.id).versions.at(-1).sourceDeleted = true; });
      if (providerFailure) throw Object.assign(new Error('Isolated judge transport failed.'), { code: 'provider_error' });
    }
    yield* failedProvider(request);
  } });
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  const current = () => store.state.projects.find(row => row.id === project.id);
  return { dir, store, service, genomes, baseline, candidate, requests, projectId: project.id, current };
}

test('actual first-judge failure rolls back the unpublished bundle while its bound selection delivery reaches the next author', async t => {
  const f = await setup(t), first = await f.service.evolve(f.projectId, { model, evidence: [{ id: 'first-work', summary: 'Source scope needs review.' }] });
  assert.equal(first.status, 'failed'); assert.equal(first.version.bundle, undefined); assert.equal(first.version.evaluation, null);
  assert.equal(first.version.evaluationEvidence.cases.length, 0, 'first judge failed before a scored case was appended');
  assert.equal(first.version.evaluationEvidence.inFlightCase.partition, 'selection');
  assert.equal(first.version.evaluationEvidence.simulated, false);
  const diagnostic = first.version.skillDeliveryDiagnostic;
  assert.ok(diagnostic, JSON.stringify(first.version.error)); assert.equal(diagnostic.skillDelivery.observedExecutions, 1); assert.equal(diagnostic.skillDelivery.expectedExecutions, 3);
  assert.equal(diagnostic.skillDelivery.items[0].notRequested, 1); assert.equal(first.version.searchFeedback.measured, false);
  assert.equal(first.version.searchFeedback.outcome, 'not_evaluated');
  assert.equal(diagnostic.binding.candidateHash, first.version.candidateHash); assert.equal(diagnostic.binding.evidenceHash, first.version.evidenceHash);
  await assert.rejects(stat(join(f.genomes.rootDir, f.projectId, first.version.id)), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(join(first.version.artifactDir, 'skill-delivery-diagnostic.json'), 'utf8')), diagnostic);
  assert.doesNotMatch(JSON.stringify(diagnostic), /case_1|case_2|Check project input|baselineScore|candidateScore|genome|instructions/);
  const saved = structuredClone(first.version), provider = genomeEvaluationProvider({ candidate: f.candidate }); let observed = false;
  f.service.provider = async function* (request) {
    if (request.systemPrompt.includes('Create one improved executable project agent')) {
      const input = JSON.parse(request.messages[0].content[0].text), history = input.searchContext.history;
      assert.equal(history.length, 1); assert.equal(history[0].id, first.version.id); assert.equal(history[0].outcome, 'not_evaluated');
      assert.equal(history[0].feedback.skillDelivery.items[0].notRequested, 1); assert.doesNotMatch(JSON.stringify(input.searchContext), /case_1|case_2|candidateScore|baselineScore|blind evaluator/); observed = true;
    }
    yield* provider(request);
  };
  const second = await f.service.evolve(f.projectId, { model, evidence: [{ id: 'second-work', summary: 'A new public work receipt.' }] });
  assert.ok(['ready', 'rejected'].includes(second.status), JSON.stringify(second.version?.error)); assert.equal(observed, true);
  assert.deepEqual(f.current().versions.find(row => row.id === first.version.id), saved, 'later authoring never rewrites the original failure');
});

test('actual judge provider throw keeps a diagnostic without fabricating scores or a usable candidate', async t => {
  const f = await setup(t, { providerFailure: true }), result = await f.service.evolve(f.projectId, { model, evidence: [{ id: 'work', summary: 'A method may need attention.' }] });
  assert.equal(result.status, 'failed'); assert.equal(result.version.bundle, undefined); assert.equal(result.version.evaluationEvidence.cases.length, 0);
  assert.equal(result.version.skillDeliveryDiagnostic.skillDelivery.items[0].notRequested, 1);
  assert.equal(result.version.searchFeedback.measured, false); assert.equal(result.version.evaluationEvidence.candidateScore, undefined);
});

test('deleted source at actual judge failure cannot yield cached author feedback', async t => {
  const f = await setup(t, { revoke: true }), result = await f.service.evolve(f.projectId, { model, evidence: [{ id: 'work', summary: 'Observed public method gap.' }] });
  assert.equal(result.status, 'failed'); assert.equal(result.version.sourceDeleted, true); assert.equal(result.version.skillDeliveryDiagnostic, undefined);
  const policy = createEvolutionSearchPolicy(f.current(), { baseline: f.baseline, context: result.version.searchContext });
  assert.equal(policy.policy.history.length, 0);
});

test('retained failure diagnostics reject changed identities, receipt content, stale and revoked state', async t => {
  const f = await setup(t), result = await f.service.evolve(f.projectId, { model, evidence: [{ id: 'work', summary: 'Observed public method gap.' }] });
  assert.ok(readEvolutionSkillDeliveryDiagnostic(result.version, f.baseline));
  for (const mutate of [v => { v.candidateHash = 'b'.repeat(64); }, v => { v.modelHash = 'b'.repeat(64); }, v => { v.evidenceHash = 'b'.repeat(64); },
    v => { v.searchContext.comparisonKey = 'b'.repeat(64); }, v => { v.evaluationPartitions.planHash = 'b'.repeat(64); },
    v => { v.evaluationEvidence.inFlightCase.candidate.answer = 'Changed receipt'; }, v => { v.skillDeliveryDiagnostic.skillDelivery.items[0].delivered = 1; },
    v => { v.state = 'stale'; }, v => { v.contextRevoked = true; }, v => { v.sourceDeleted = true; }]) {
    const version = structuredClone(result.version); mutate(version);
    assert.equal(readEvolutionSkillDeliveryDiagnostic(version, f.baseline), undefined, mutate.toString());
    assert.equal(describeEvolutionSearchOutcome(version, f.baseline).skillDelivery, undefined, mutate.toString());
    assert.equal(createEvolutionSearchPolicy({ versions: [version] }, { baseline: f.baseline, context: result.version.searchContext }).policy.history.length, 0, mutate.toString());
  }
});
