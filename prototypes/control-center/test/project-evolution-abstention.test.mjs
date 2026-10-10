import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { ProjectEvolutionService } from '../test-support/marketplace-isolation.mjs';
import { ProjectLearningController } from '../project-learning-controller.mjs';
import { resolveModel } from '../configuration.mjs';
import { captureSessionEvidence, discoverSessionEvidence, purgeSessionEvidenceFiles } from '../session-evidence-cleanup.mjs';
import { getEvolutionEvidenceCoverage, getProjectEvolutionIdentity } from '../project-evolution-identity.mjs';
import { describeEvolutionAssessment } from '../project-evolution-assessment.mjs';
import { authorAbstentionDisplay, versionChangeSummary, evaluationBenefitDisplay } from '../presentation/evolution-evidence-display.mjs';
import { formatVersionDetail } from '../cli-evaluation.mjs';
import { projectGenomeFixture } from '../../../packages/sdk/test/fixtures/project-genome.mjs';
import { createProjectEvaluationPartitionPlan } from '../../../packages/sdk/src/project-evaluation-partitions.mjs';
import { evolutionHash } from '../../../packages/sdk/src/evolution.mjs';

const evidence = [{ id: 'source-message', summary: 'The retained completed receipt establishes the requested procedure.' }];
const response = (ids = evidence.map(row => row.id), reason = 'no_method_gap', text = '') => ({ decision: 'no_change', abstention: {
  reason, summary: `The observed work does not establish a reusable method defect. ${text}`,
  explanation: `The supplied receipt already demonstrates this procedure; further distinct work evidence is required before claiming a reusable improvement. ${text}`,
  evidenceIds: ids, revisitWhen: [{ condition: 'reproduced_failure', description: `A later ordinary task reproduces a method failure beyond this work result. ${text}` }]
} });
function plan() {
  const suite = projectGenomeFixture().evaluationSuite;
  return createProjectEvaluationPartitionPlan({ suite, frozenAt: '2026-09-26T01:00:00.000Z', assignments: [
    { caseId: 'case_1', partition: 'development', taskFamily: 'evidence' },
    { caseId: 'case_2', partition: 'selection', taskFamily: 'evidence' },
    { caseId: 'case_3', partition: 'confirmation', taskFamily: 'evidence' },
  ], confirmationProvenance: { datasetId: 'abstention-reviewed-evidence', version: 'v1', reviewId: 'independent-review', reviewedAt: '2026-09-25T01:00:00.000Z', sourceHash: evolutionHash([suite.cases[2]]), authorship: 'independent_host_review', exposure: 'withheld' } });
}
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-host-abstention-')), store = new Store(join(dir, 'state.json'));
  const { project, session } = store.createProject({ name: 'Evidence-based learning', workspace: dir, initiative: { enabled: false } });
  const genomes = new ProjectGenomeStore(store), baseline = projectGenomeFixture();
  const prepared = await genomes.prepare(project, { genome: baseline, versionId: project.activeVersionId }); await prepared.commit();
  store.mutate(state => {
    state.configuration.providers.push({ id: 'local-fixture', name: 'Fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', name: 'Fixture', contextWindow: 128000, maxOutputTokens: 4000, reasoning: ['off'] }] });
    state.configuration.defaultModel = { providerId: 'local-fixture', modelId: 'fixture', reasoning: 'off' };
    Object.assign(state.configuration.memory, { autoRecall: false, autoStore: false });
    const current = state.projects.find(row => row.id === project.id); current.initialization = { status: 'ready' }; current.simulated = false; current.decisionMode = 'rna-model'; current.rhythm = { control: 'manual' };
    current.versions.find(row => row.id === current.activeVersionId).bundle = prepared.record;
    const source = state.sessions.find(row => row.id === session.id), at = new Date().toISOString();
    source.turns.push({ id: 'source-turn', userItemId: 'source-message', status: 'completed', modelConfig: { execution: 'rna' }, simulated: false, createdAt: at, completedAt: at });
    source.items.push({ id: 'source-message', turnId: 'source-turn', kind: 'user', text: 'Verify the requested procedure.', simulated: false, createdAt: at }, { id: 'source-answer', turnId: 'source-turn', kind: 'assistant', text: 'The result is present.', simulated: false });
  });
  const model = resolveModel(store.state.configuration, null), calls = [], services = [], controllers = [];
  const current = () => store.state.projects.find(row => row.id === project.id);
  const service = new ProjectEvolutionService(store, { genomeStore: genomes, provider: async function* (request) {
    calls.push(request); assert.match(request.systemPrompt, /Create one improved executable project agent/, 'no paired or judge request may dispatch');
    const input = JSON.parse(request.messages[0].content[0].text);
    yield { type: 'text_delta', delta: JSON.stringify(options.output?.(calls.length, input) ?? response(input.evidence.map(row => row.id))) };
    yield { type: 'usage', usage: { input: 20, output: 10, cacheRead: 7, totalTokens: 37 } };
    await options.afterUsage?.(calls.length); yield { type: 'done', stopReason: 'stop' };
  } }); services.push(service);
  t.after(async () => { for (const controller of controllers) await controller.close(); for (const instance of services) instance.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, genomes, baseline, model, calls, service, services, controllers, current, projectId: project.id, sessionId: session.id, baselineId: project.activeVersionId };
}
async function until(check) { const deadline = Date.now() + 6000; while (!check()) { if (Date.now() > deadline) throw Error('learning state did not settle'); await new Promise(done => setTimeout(done, 10)); } }

test('host retains a metered author-only review without candidate assets, paired evaluation, confirmation use or activation', async t => {
  const f = await setup(t), baseline = structuredClone(f.current().versions[0]), calls = [], settled = [], attemptCount = f.current().evolution.candidateCount ?? 0;
  f.genomes.prepare = async () => { throw Error('no candidate package may be prepared'); };
  const result = await f.service.evolve(f.projectId, { evidence, model: f.model, partitionPlan: plan(), learningReviewId: 'author-review', requestControl: { beforeRequest: row => calls.push(row), onUsage: row => settled.push(row) } });
  assert.equal(result.status, 'no_change', JSON.stringify(result.version?.error)); assert.equal(f.calls.length, 1); assert.equal(calls.length, 1); assert.equal(settled.length, 1);
  assert.equal(settled[0].usage.totalTokens, 37); assert.equal(result.usage.totalTokens, 37); assert.deepEqual(result.version.usage, result.usage);
  for (const key of ['proposal', 'bundle', 'candidateHash', 'evaluationEvidence']) assert.equal(result.version[key], undefined, key);
  assert.equal(result.version.candidateGenerated, false); assert.equal(result.version.evaluation, null);
  assert.equal(f.current().activeVersionId, f.baselineId); assert.deepEqual(f.current().versions[0], baseline); assert.equal(f.current().trialVersionId, null);
  assert.deepEqual(f.current().evolution.confirmationClaims ?? [], []); assert.equal(f.current().evolution.candidateCount, attemptCount + 1, 'legacy admission-attempt accounting remains intact');
  const phases = result.version.operationPhaseLedger.phases;
  assert.equal(phases.find(row => row.phase === 'author').usage.totalTokens, 37);
  assert.ok(phases.filter(row => row.phase !== 'author').every(row => row.requests === 0));
  const files = await readdir(result.version.artifactDir); assert.ok(files.includes('author-review.json')); assert.ok(!files.includes('evaluation.json')); assert.ok(!files.includes('proposal.json')); assert.ok(!files.includes('confirmation-claim.json'));
  const stored = JSON.parse(await readFile(join(result.version.artifactDir, 'result.json'), 'utf8'));
  assert.equal(stored.status, 'no_change'); assert.equal(stored.requests.length, 1); assert.equal(stored.usage.totalTokens, 37);
  assert.deepEqual(JSON.parse(await readFile(join(result.version.artifactDir, 'author-review.json'), 'utf8')).sourceEvidenceIds, evidence.map(row => row.id));
  const assessment = describeEvolutionAssessment(result.version, { activeVersionId: f.baselineId, project: f.current() });
  assert.equal(assessment.category, 'no_change'); assert.equal(assessment.scoredCases, 0); assert.equal(assessment.candidateRetained, false); assert.equal(assessment.retry.available, false); assert.equal(assessment.authorRetry.available, false);
  assert.equal(evaluationBenefitDisplay(result.version), null); assert.equal(authorAbstentionDisplay(result.version).label, '本轮无需变更');
  assert.equal(versionChangeSummary(f.current(), result.version).kind, 'review');
  const cli = formatVersionDetail(f.current(), result.version); assert.match(cli, /不是候选质量评分/); assert.match(cli, /后续关注/);
});

test('exact no-change replay is free across reorder/timestamps and reopen; genuinely fresh evidence or source bytes reopens authoring', async t => {
  const f = await setup(t), batch = [...evidence, { id: 'other-receipt', summary: 'A second ordinary completed work receipt.' }], context = text => ({ schemaVersion: 1, evidence: [{ id: evidence[0].id, content: text }], files: [] });
  const first = await f.service.evolve(f.projectId, { evidence: batch, learningContext: context('Original source receipt.'), model: f.model });
  const frozen = JSON.stringify(first.version), count = f.current().versions.length;
  f.service.close(); const reopenedStore = new Store(f.store.file), reopened = new ProjectEvolutionService(reopenedStore, { provider: f.service.provider }); f.services.push(reopened);
  const replay = await reopened.evolve(f.projectId, { evidence: [...batch].reverse().map(row => ({ ...row, at: Date.now() })), learningContext: context('Original source receipt.'), model: f.model });
  assert.equal(replay.replayed, true); assert.equal(replay.status, 'no_change'); assert.equal(replay.version.id, first.version.id); assert.equal(replay.usage.totalTokens, 0); assert.equal(f.calls.length, 1);
  assert.equal(reopened.project(f.projectId).versions.length, count); assert.equal(JSON.stringify(replay.version), frozen);
  const next = await reopened.evolve(f.projectId, { evidence: [...batch, { id: 'new-receipt', summary: 'A different work task provides new evidence.' }], learningContext: context('Original source receipt.'), model: f.model });
  assert.equal(next.status, 'no_change'); assert.notEqual(next.version.id, first.version.id); assert.equal(f.calls.length, 2);
  const changed = await reopened.evolve(f.projectId, { evidence: batch, learningContext: context('Corrected receipt bytes, same semantic summary.'), model: f.model });
  assert.equal(changed.status, 'no_change'); assert.notEqual(changed.version.learningContextHash, first.version.learningContextHash); assert.equal(f.calls.length, 3);
  const identity = getProjectEvolutionIdentity(reopened.project(f.projectId), { evidence: batch, model: f.model, baselineHash: first.version.baselineHash, learningContextHash: first.version.learningContextHash });
  assert.equal(getEvolutionEvidenceCoverage(reopened.project(f.projectId), identity).hasNewEvidence, false);
});

test('a repaired author review retains both charged requests; an interrupted stop-looking reply cannot become no_change', async t => {
  const repaired = await setup(t, { output: (attempt, input) => response(attempt === 1 ? ['invented-receipt'] : input.evidence.map(row => row.id)) });
  const result = await repaired.service.evolve(repaired.projectId, { evidence, model: repaired.model });
  assert.equal(result.status, 'no_change'); assert.equal(repaired.calls.length, 2); assert.equal(result.usage.totalTokens, 74); assert.equal(result.version.proposalAttempts, 2); assert.equal(result.version.repairEvidence.length, 1);
  const retained = JSON.parse(await readFile(join(result.version.artifactDir, 'author-review.json'), 'utf8')); assert.equal(retained.requests.length, 2); assert.equal(retained.usage.totalTokens, 74);
  const failed = await setup(t, { afterUsage: () => { throw Object.assign(Error('provider disconnected after output'), { code: 'fixture_transport_error' }); } });
  const failure = await failed.service.evolve(failed.projectId, { evidence, model: failed.model });
  assert.equal(failure.status, 'failed'); assert.equal(failed.calls.length, 1); assert.equal(failure.usage.totalTokens, 37); assert.equal(failure.version.authorAbstention, undefined); assert.equal(authorAbstentionDisplay(failure.version), null);
});

test('source revocation after a completed author response prevents publication and keeps incurred usage', async t => {
  let authorized = true;
  const f = await setup(t, { afterUsage: () => { authorized = false; } });
  const result = await f.service.evolve(f.projectId, { evidence, model: f.model, commitGuard: () => authorized });
  assert.equal(result.status, 'stale'); assert.equal(result.usage.totalTokens, 37); assert.equal(f.calls.length, 1); assert.equal(result.version.authorAbstention, undefined); assert.equal(result.version.bundle, undefined);
  assert.equal(f.current().activeVersionId, f.baselineId); assert.equal((await readdir(result.version.artifactDir)).includes('author-review.json'), false);
});

test('an uncertainty review persists host source identities even when the model cites none', async t => {
  const f = await setup(t, { output: () => response([], 'insufficient_evidence') });
  const result = await f.service.evolve(f.projectId, { evidence, model: f.model });
  assert.equal(result.status, 'no_change'); assert.equal(result.version.assessment.label, '等待更多证据'); assert.equal(f.calls.length, 1);
  const artifact = JSON.parse(await readFile(join(result.version.artifactDir, 'author-review.json'), 'utf8'));
  assert.deepEqual(artifact.abstention.evidenceIds, []); assert.deepEqual(artifact.sourceEvidenceIds, ['source-message']);
});

test('deleting the source removes no-change rationale from hot state and artifacts, retaining accounting and baseline', async t => {
  const secret = 'PRIVATE_CONVERSATION_REASON_72638', f = await setup(t, { output: (_attempt, input) => response(input.evidence.map(row => row.id), 'no_method_gap', secret) });
  const result = await f.service.evolve(f.projectId, { evidence, model: f.model }); assert.equal(result.status, 'no_change');
  const source = f.store.state.sessions.find(row => row.id === f.sessionId), record = { sessionId: f.sessionId, projectId: f.projectId, evidence: captureSessionEvidence(f.store.state, source) };
  assert.ok(record.evidence.evolutionVersionIds.includes(result.version.id)); f.store.deleteSession(f.sessionId);
  record.evidence = await discoverSessionEvidence(f.store.file, record, { state: f.store.state }); await purgeSessionEvidenceFiles(f.store.file, record, { writersSettled: true });
  const version = f.current().versions.find(row => row.id === result.version.id);
  assert.equal(version.sourceDeleted, true); assert.equal(version.authorAbstention, undefined); assert.equal(JSON.stringify(f.current()).includes(secret), false); assert.equal(version.usage.totalTokens, 37);
  assert.equal(authorAbstentionDisplay(version), null); assert.equal(describeEvolutionAssessment(version).category, 'source_deleted'); assert.equal(f.current().activeVersionId, f.baselineId);
  const names = await readdir(version.artifactDir); assert.ok(!names.includes('author-review.json'));
  for (const name of names) if (name.endsWith('.json') || name.endsWith('.jsonl')) assert.equal((await readFile(join(version.artifactDir, name), 'utf8')).includes(secret), false, name);
  const receipt = JSON.parse(await readFile(join(version.artifactDir, 'result.json'), 'utf8')); assert.equal(receipt.usage.totalTokens, 37); assert.equal(receipt.status, 'no_change');
});

test('learning restart reconciles the exact durable author no-change result as terminal without new reflection or author calls', async t => {
  const f = await setup(t); let reflections = 0;
  f.store.mutate(state => { const p = state.projects.find(row => row.id === f.projectId); p.initiative.enabled = true; p.initiative.tokenBudget = null; p.evolution.enabled = true; p.evolution.minIntervalMs = 0; });
  const controllerOptions = { evolutionService: f.service, initialDelayMs: 100000, tickIntervalMs: 0, minReviewMs: 100000, reflect: async () => { reflections++; throw Error('reconciliation must not reflect again'); } };
  const initial = new ProjectLearningController(f.store, controllerOptions); f.controllers.push(initial);
  await until(() => f.current().learningRuntime?.sdkState?.episodes.length); await initial.close();
  const reviewId = 'interrupted-author-review', episode = structuredClone(f.current().learningRuntime.sdkState.episodes[0]);
  const author = await f.service.evolve(f.projectId, { model: f.model, evidence: [{ id: episode.id, summary: episode.summary }], learningReviewId: reviewId });
  assert.equal(author.status, 'no_change');
  f.store.mutate(state => {
    const p = state.projects.find(row => row.id === f.projectId), sdk = p.learningRuntime.sdkState, row = sdk.episodes.find(row => row.key === episode.key);
    row.status = 'executing'; row.reviewId = reviewId;
    sdk.reviews.push({ id: reviewId, status: 'executing', episodeKeys: [row.key], sourceIds: row.sourceIds, startedAt: Date.now(), executionStartedAt: Date.now(), decision: { outcome: 'experiment', evidenceIds: [row.id], reason: 'A work result warranted inspection.', diagnosis: 'The work needs source verification.', hypothesis: 'A verification method could improve reliability.', intervention: 'Inspect the original work before changing the method.', validationPlan: 'Retain the frozen suite for any proposed candidate.', limitations: 'The hypothesis is unverified.', nextReviewAfterMs: 60000 } });
  });
  const recovered = new ProjectLearningController(f.store, controllerOptions); f.controllers.push(recovered);
  await until(() => f.current().learningRuntime.sdkState.reviews.find(row => row.id === reviewId)?.status === 'completed');
  const review = f.current().learningRuntime.sdkState.reviews.find(row => row.id === reviewId);
  assert.equal(review.result.status, 'no_change'); assert.equal(review.result.versionId, author.version.id); assert.equal(review.result.usage.totalTokens, 37);
  assert.equal(f.calls.length, 1); assert.equal(reflections, 0); assert.ok(f.current().learningRuntime.sdkState.seen.some(row => row.key === episode.key && row.outcome === 'no_change'));
  assert.equal(f.current().learningRuntime.sdkState.episodes.some(row => row.key === episode.key), false);
  await recovered.pump(); assert.equal(f.calls.length, 1); assert.equal(reflections, 0);
});
