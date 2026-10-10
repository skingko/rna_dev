import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { ProjectEvolutionService } from '../test-support/marketplace-isolation.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from '../../../packages/sdk/test/fixtures/project-genome.mjs';
import { evolutionHash as digest } from '../../../packages/sdk/src/evolution.mjs';
import { createProjectEvaluationPartitionPlan } from '../../../packages/sdk/src/project-evaluation-partitions.mjs';
import { readStateFile, readStateText } from '../state-shards.mjs';

const model = { providerId: 'local-fixture', modelId: 'fixture', execution: 'rna', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 128000, maxOutputTokens: 4000, reasoning: 'off' };
const evidence = [{ id: 'original-receipt', summary: 'Observed evidence interpretation can be made more useful.' }];
function plan() {
  const suite = projectGenomeFixture().evaluationSuite;
  return createProjectEvaluationPartitionPlan({ suite, frozenAt: '2026-09-27T01:00:00.000Z', assignments: [
    { caseId: 'case_1', partition: 'development', taskFamily: 'evidence' },
    { caseId: 'case_2', partition: 'selection', taskFamily: 'evidence' },
    { caseId: 'case_3', partition: 'confirmation', taskFamily: 'evidence' },
  ], confirmationProvenance: { datasetId: 'reviewed-host-evidence', version: 'v1', reviewId: 'independent-review', reviewedAt: '2026-09-26T01:00:00.000Z', sourceHash: digest([suite.cases[2]]), authorship: 'independent_host_review', exposure: 'withheld' } });
}
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-evolution-partition-host-')), store = new Store(join(dir, 'state.json'));
  const { project } = store.createProject({ name: 'Frozen independent confirmation', workspace: dir, initiative: { enabled: false } });
  const genomes = new ProjectGenomeStore(store), prepared = await genomes.prepare(project, { genome: projectGenomeFixture(), versionId: project.activeVersionId }); await prepared.commit();
  store.mutate(state => { const current = state.projects.find(row => row.id === project.id); current.simulated = false; current.decisionMode = 'rna-model'; current.initialization = { status: 'ready' }; current.versions.find(row => row.id === current.activeVersionId).bundle = prepared.record; });
  const services = [], service = new ProjectEvolutionService(store, { genomeStore: genomes, provider: genomeEvaluationProvider() }); services.push(service);
  t.after(async () => { for (const item of services) item.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, service, services, projectId: project.id, baselineId: project.activeVersionId, current: () => store.state.projects.find(row => row.id === project.id) };
}
function wrappedProvider({ calls = [], beforeAuthor, beforeConfirmation, failConfirmation = false, confirmationTransportError = false } = {}) {
  const ordinary = genomeEvaluationProvider();
  return async function* (request) {
    const author = request.systemPrompt.includes('Create one improved executable project agent'), judge = request.systemPrompt.includes('blind evaluator');
    const task = author ? null : judge ? JSON.parse(request.messages[0].content[0].text).task : request.messages.find(row => row.role === 'user')?.content.find(row => row.type === 'text')?.text;
    calls.push({ author, judge, task });
    if (author) await beforeAuthor?.(request);
    if (task?.includes('input 3')) {
      await beforeConfirmation?.(request);
      if (confirmationTransportError) { yield { type: 'usage', usage: { input: 11, output: 6, totalTokens: 17 } }; throw Object.assign(new Error('fixture confirmation provider interruption'), { code: 'fixture_confirmation_error' }); }
      if (judge && failConfirmation) {
        const input = JSON.parse(request.messages[0].content[0].text), ratings = { ratings: input.criteria.map(row => ({ criterionId: row.id, left: input.left.answer.includes('precise') ? .7 : .9, right: input.right.answer.includes('precise') ? .7 : .9, reason: 'The retained confirmation execution regressed in this fixture.' })) };
        yield { type: 'tool_call', id: `ratings-${calls.length}`, name: request.tools[0].name, arguments: ratings }; yield { type: 'usage', usage: { input: 20, output: 10, totalTokens: 30 } }; yield { type: 'done', stopReason: 'toolUse' }; return;
      }
    }
    yield* ordinary(request);
  };
}

test('host freezes and persists partitions before author dispatch while hidden inputs stay outside the author context', async t => {
  const app = await setup(t), frozen = plan(); let sawAuthor = false, sawConfirmation = false;
  app.service.provider = wrappedProvider({
    beforeAuthor: async request => {
      const pending = app.current().versions.at(-1), persisted = readStateFile(app.store.file).state.projects.find(row => row.id === app.projectId).versions.at(-1);
      const artifact = JSON.parse(await readFile(join(pending.artifactDir, 'frozen-evaluation.json'), 'utf8'));
      assert.deepEqual(pending.evaluationPartitions, frozen); assert.deepEqual(persisted.evaluationPartitions, frozen); assert.deepEqual(artifact.evaluationPartitions, frozen);
      assert.equal(JSON.stringify(request).includes(projectGenomeFixture().evaluationSuite.cases[2].input), false); sawAuthor = true;
    },
    beforeConfirmation: async () => {
      const persisted = readStateFile(app.store.file).state.projects.find(row => row.id === app.projectId), claim = persisted.evolution.confirmationClaims[0];
      assert.equal(claim.status, 'claimed'); assert.equal(claim.planHash, frozen.planHash);
      const artifact = JSON.parse(await readFile(join(app.current().versions.at(-1).artifactDir, 'confirmation-claim.json'), 'utf8'));
      assert.deepEqual(artifact, claim); sawConfirmation = true;
    },
  });
  const result = await app.service.evolve(app.projectId, { model, evidence, partitionPlan: frozen });
  assert.equal(result.status, 'ready', JSON.stringify(result.version.error)); assert.equal(sawAuthor, true); assert.equal(sawConfirmation, true); assert.equal(result.usage.totalTokens, 330);
  assert.equal(app.current().activeVersionId, app.baselineId); assert.equal(app.current().evolution.confirmationClaims[0].status, 'passed');
});

test('confirmation result hash binds a retained original report even when host adds author phase cost', async t => {
  const app = await setup(t); app.service.provider = wrappedProvider();
  const result = await app.service.evolve(app.projectId, { model, evidence, partitionPlan: plan() });
  assert.equal(result.status, 'ready');
  const claim = app.current().evolution.confirmationClaims[0], report = JSON.parse(await readFile(join(result.version.artifactDir, 'evaluation.json'), 'utf8'));
  const retained = [report];
  for (const name of ['evaluation-sdk.json', 'sdk-evaluation.json']) try { retained.push(JSON.parse(await readFile(join(result.version.artifactDir, name), 'utf8'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.ok(retained.some(value => digest(value) === claim.resultHash), 'The actual result bytes identified by a durable claim must remain available');
  assert.equal(result.version.operationPhaseLedger.phases.find(row => row.phase === 'author').usage.totalTokens, 30);
  assert.equal(result.version.operationPhaseLedger.usage.totalTokens, 330);
  assert.equal(result.version.evaluation.phaseLedger.usage.totalTokens, 300, 'Host enrichment leaves the original SDK report bytes unchanged');
});

test('reopening and retrying interrupted confirmation cannot silently downgrade its plan to a selection-only comparison', async t => {
  const app = await setup(t); app.service.provider = wrappedProvider({ confirmationTransportError: true });
  const first = await app.service.evolve(app.projectId, { model, evidence, partitionPlan: plan() });
  assert.equal(first.status, 'failed'); assert.equal(first.version.evaluationEvidence.selection.gatePassed, true); assert.equal(app.current().evolution.confirmationClaims[0].status, 'interrupted');
  const original = JSON.parse(JSON.stringify(app.current().versions.find(row => row.id === first.version.id))), originalClaim = structuredClone(app.current().evolution.confirmationClaims[0]); app.service.close();
  const store = new Store(app.store.file), calls = [], service = new ProjectEvolutionService(store, { provider: wrappedProvider({ calls }) }); app.services.push(service);
  await assert.rejects(service.evolve(app.projectId, { model, retryVersionId: first.version.id }), error => error.code === 'evaluation_confirmation_consumed' && error.usage.totalTokens === 0 && /独立审阅/.test(error.message));
  assert.equal(calls.length, 0, 'A consumed confirmation set is rejected before even selection or author dispatch');
  const project = store.state.projects.find(row => row.id === app.projectId);
  assert.deepEqual(project.versions.find(row => row.id === first.version.id), original); assert.deepEqual(project.evolution.confirmationClaims, [originalClaim]); assert.equal(project.activeVersionId, app.baselineId);
});

test('restart at a claimed confirmation boundary preserves consumed tasks and never automatically replays work', async t => {
  const app = await setup(t); let crashedSnapshot;
  app.service.provider = wrappedProvider({ beforeConfirmation: async () => { crashedSnapshot ??= readStateText(app.store.file); }, confirmationTransportError: true });
  const result = await app.service.evolve(app.projectId, { model, evidence, partitionPlan: plan() }); assert.equal(result.status, 'failed');
  assert.ok(crashedSnapshot); const before = JSON.parse(crashedSnapshot).projects.find(row => row.id === app.projectId), consumed = before.evolution.confirmationClaims[0];
  assert.equal(consumed.status, 'claimed'); assert.equal(before.versions.at(-1).state, 'evaluating');
  app.service.close(); await writeFile(app.store.file, crashedSnapshot);
  const store = new Store(app.store.file), calls = [], service = new ProjectEvolutionService(store, { provider: wrappedProvider({ calls }) }); app.services.push(service);
  const reopened = store.state.projects.find(row => row.id === app.projectId);
  assert.equal(reopened.versions.at(-1).state, 'interrupted'); assert.deepEqual(reopened.evolution.confirmationClaims, [consumed]); assert.equal(calls.length, 0);
  await assert.rejects(service.evolve(app.projectId, { model, evidence: [{ id: 'different-external-receipt', summary: 'Another verified external observation.' }], partitionPlan: plan() }), error => error.code === 'evaluation_confirmation_consumed' && error.usage.totalTokens === 0);
  assert.equal(calls.length, 0); assert.equal(store.state.projects.find(row => row.id === app.projectId).versions.length, before.versions.length);
  assert.deepEqual(store.state.projects.find(row => row.id === app.projectId).evolution.confirmationClaims, [consumed]);
});

test('host failed confirmation reports completed author work, exact partial cost and phase failure reason', async t => {
  const app = await setup(t); app.service.provider = wrappedProvider({ confirmationTransportError: true });
  const result = await app.service.evolve(app.projectId, { model, evidence, partitionPlan: plan() });
  assert.equal(result.status, 'failed'); assert.equal(result.usage.totalTokens, 197);
  const ledger = result.version.evaluationEvidence.phaseLedger;
  assert.equal(ledger.usage.totalTokens, 197); assert.equal(ledger.phases.find(row => row.phase === 'author').status, 'passed'); assert.equal(ledger.phases.find(row => row.phase === 'author').usage.totalTokens, 30);
  assert.equal(ledger.phases.find(row => row.phase === 'paired').status, 'passed'); assert.equal(ledger.phases.find(row => row.phase === 'paired').usage.totalTokens, 150);
  assert.equal(ledger.phases.find(row => row.phase === 'confirmation').usage.totalTokens, 17); assert.ok(ledger.phases.find(row => row.phase === 'confirmation').reasons.includes('fixture_confirmation_error'));
  assert.ok(ledger.phases.every(row => row.status !== 'running'));
  const audit = JSON.parse(await readFile(join(result.version.artifactDir, 'failure.json'), 'utf8')); assert.deepEqual(audit.evidence.phaseLedger, ledger); assert.equal(audit.requests.length, 7);
});

test('retry refuses tampered frozen partition evidence or explicit confirmation downgrade before paid work', async t => {
  const app = await setup(t); app.service.provider = wrappedProvider({ confirmationTransportError: true });
  const first = await app.service.evolve(app.projectId, { model, evidence, partitionPlan: plan() }); assert.equal(first.status, 'failed');
  const path = join(first.version.artifactDir, 'frozen-evaluation.json'), original = await readFile(path, 'utf8'), changed = JSON.parse(original), calls = [];
  app.service.provider = wrappedProvider({ calls }); changed.evaluationPartitions.assignments[0].partition = 'selection'; await writeFile(path, JSON.stringify(changed));
  await assert.rejects(app.service.evolve(app.projectId, { model, retryVersionId: first.version.id }), error => error.code === 'evaluation_partition_changed' && error.usage.totalTokens === 0);
  assert.equal(calls.length, 0);
  await writeFile(path, original);
  const downgrade = createProjectEvaluationPartitionPlan({ suite: projectGenomeFixture().evaluationSuite });
  await assert.rejects(app.service.evolve(app.projectId, { model, retryVersionId: first.version.id, partitionPlan: downgrade }), error => error.code === 'evaluation_confirmation_downgrade' && error.usage.totalTokens === 0);
  assert.equal(calls.length, 0); assert.equal(app.current().versions.length, 2); assert.equal(app.current().evolution.confirmationClaims.length, 1);
  const relocated = join(app.dir, 'copied-frozen-evidence.json'); await writeFile(relocated, original); await rm(path); await symlink(relocated, path);
  await assert.rejects(app.service.evolve(app.projectId, { model, retryVersionId: first.version.id }), error => error.code === 'evaluation_partition_changed' && error.usage.totalTokens === 0);
  assert.equal(calls.length, 0);
});

test('reviewed new partition method cannot replay an old selection-only score, but a timestamp refresh cannot buy another experiment', async t => {
  const app = await setup(t), calls = []; app.service.provider = wrappedProvider({ calls });
  const old = await app.service.evolve(app.projectId, { model, evidence }); assert.equal(old.status, 'ready'); assert.equal(calls.length, 16); assert.equal(old.version.evaluation.confirmation.status, 'not_applicable');
  const reviewed = await app.service.evolve(app.projectId, { model, evidence, partitionPlan: plan() });
  assert.equal(reviewed.status, 'ready'); assert.notEqual(reviewed.version.id, old.version.id); assert.equal(reviewed.version.evaluation.confirmation.status, 'passed'); assert.equal(calls.length, 27);
  const refreshed = createProjectEvaluationPartitionPlan({ suite: projectGenomeFixture().evaluationSuite, assignments: plan().assignments.map(({ caseHash, ...row }) => row), confirmationProvenance: plan().confirmation.provenance, frozenAt: '2026-09-27T01:30:00.000Z' });
  const replay = await app.service.evolve(app.projectId, { model, evidence, partitionPlan: refreshed });
  assert.equal(replay.replayed, true); assert.equal(replay.version.id, reviewed.version.id); assert.equal(calls.length, 27); assert.equal(app.current().evolution.confirmationClaims.length, 1);
});

test('runtime upgrade refuses consumed confirmation before request admission, while preserving the prior ready result', async t => {
  const app = await setup(t), calls = []; app.service.provider = wrappedProvider({ calls });
  const first = await app.service.evolve(app.projectId, { model, evidence, partitionPlan: plan() }); assert.equal(first.status, 'ready');
  app.store.mutate(state => { const version = state.projects.find(row => row.id === app.projectId).versions.find(row => row.id === first.version.id); version.evaluationRuntimeHash = 'previous-runtime'; version.evaluation.evaluationRuntimeHash = 'previous-runtime'; });
  const before = structuredClone(app.current()); calls.length = 0; let admissions = 0;
  await assert.rejects(app.service.evolve(app.projectId, { model, retryVersionId: first.version.id, requestControl: { beforeRequest() { admissions++; } } }), error => error.code === 'evaluation_confirmation_consumed' && error.usage.totalTokens === 0);
  assert.equal(calls.length, 0); assert.equal(admissions, 0); assert.deepEqual(app.current(), before);
});

test('selection-only runtime retry remains available and bills only the actual paired comparison', async t => {
  const app = await setup(t), calls = []; app.service.provider = wrappedProvider({ calls });
  const first = await app.service.evolve(app.projectId, { model, evidence }); assert.equal(first.status, 'ready');
  app.store.mutate(state => { const version = state.projects.find(row => row.id === app.projectId).versions.find(row => row.id === first.version.id); version.evaluationRuntimeHash = 'previous-runtime'; version.evaluation.evaluationRuntimeHash = 'previous-runtime'; });
  calls.length = 0;
  const retry = await app.service.evolve(app.projectId, { model, retryVersionId: first.version.id });
  assert.equal(retry.status, 'ready'); assert.equal(retry.version.evaluation.confirmation.status, 'not_applicable'); assert.equal(retry.usage.totalTokens, 450);
  assert.equal(calls.length, 15); assert.ok(calls.every(row => !row.author)); assert.equal(retry.version.priorEvaluationRuntimeHash, 'previous-runtime');
});

test('an independently reviewed unused task inventory can admit a retained candidate after consumed confirmation', async t => {
  const app = await setup(t); app.service.provider = wrappedProvider({ confirmationTransportError: true });
  const first = await app.service.evolve(app.projectId, { model, evidence, partitionPlan: plan() }); assert.equal(first.status, 'failed');
  // case_1 was never executed by the previous experiment. This fixture's host
  // review attests it remains withheld; changing a consumed task's label alone
  // would not change its hash and would still be refused.
  const suite = projectGenomeFixture().evaluationSuite;
  const fresh = createProjectEvaluationPartitionPlan({ suite, assignments: [
    { caseId: 'case_1', partition: 'confirmation', taskFamily: 'evidence' },
    { caseId: 'case_2', partition: 'selection', taskFamily: 'evidence' },
    { caseId: 'case_3', partition: 'development', taskFamily: 'evidence' },
  ], confirmationProvenance: { datasetId: 'unused-host-reserve', version: 'v2', reviewId: 'new-independent-review', reviewedAt: '2026-09-26T01:00:00.000Z', sourceHash: digest([suite.cases[0]]), authorship: 'independent_host_review', exposure: 'withheld' } });
  const calls = []; app.service.provider = wrappedProvider({ calls });
  const retry = await app.service.evolve(app.projectId, { model, retryVersionId: first.version.id, partitionPlan: fresh });
  assert.equal(retry.status, 'ready'); assert.equal(calls.length, 10); assert.ok(calls.every(row => !row.author));
  assert.equal(app.current().evolution.confirmationClaims.length, 2); assert.equal(retry.version.evaluation.confirmation.status, 'passed');
});
