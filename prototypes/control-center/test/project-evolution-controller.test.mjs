import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { ProjectEvolutionService } from '../test-support/marketplace-isolation.mjs';
import { ProjectEvolutionController } from '../project-evolution-controller.mjs';
import { resolveModel } from '../configuration.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from '../../../packages/sdk/test/fixtures/project-genome.mjs';

async function setup(t, { provider: executionProvider = genomeEvaluationProvider() } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-edit-evaluation-')), store = new Store(join(dir, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 4000 }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture' } });
  const { project } = store.createProject({ name: 'Project', workspace: dir, initiative: { enabled: false } });
  const genomes = new ProjectGenomeStore(store), prepared = await genomes.prepare(project, { genome: projectGenomeFixture(), versionId: project.activeVersionId }); await prepared.commit();
  store.mutate(state => { const p = state.projects.find(p => p.id === project.id); p.simulated = false; p.decisionMode = 'rna-model'; p.initialization = { status: 'ready' }; p.versions[0].bundle = prepared.record; p.versions[0].simulated = false; state.usage.tokens = 100000000; });
  const service = new ProjectEvolutionService(store, { provider: executionProvider }), controller = new ProjectEvolutionController(store, { service });
  t.after(async () => { await controller.close(); service.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, controller, service, id: project.id, baselineId: project.activeVersionId, model: resolveModel(store.state.configuration), project: () => store.state.projects.find(p => p.id === project.id) };
}

function heldProvider() {
  let release, entered; const ready = new Promise(resolve => { entered = resolve; }), hold = new Promise(resolve => { release = resolve; }), actual = genomeEvaluationProvider(); let first = true;
  return { ready, release, provider: async function* (request) { if (first) { first = false; entered(request); await hold; } yield* actual(request); } };
}

test('edited genome uses real evaluation, independent accounting, trial/adopt/parent rollback without deleting versions', async t => {
  const app = await setup(t), result = app.controller.start(app.id, { baseVersionId: app.baselineId, genome: projectGenomeFixture({ candidate: true }) });
  assert.equal(result.status, 'running'); assert.throws(() => app.controller.start(app.id, {}), /已有/);
  await app.controller.operations.get(app.id).promise;
  const p = app.project(), version = p.versions.at(-1); assert.equal(version.state, 'ready'); assert.equal(p.activeVersionId, app.baselineId);
  assert.equal(app.store.state.realUsage.tokens, 450); assert.equal(app.store.state.usage.tokens, 100000000); assert.equal(app.store.state.realUsage.reservedTokens, 0);
  app.store.version(app.id, version.id, 'trial'); assert.equal(app.project().trialVersionId, version.id);
  app.store.version(app.id, version.id, 'adopt'); assert.equal(app.project().activeVersionId, version.id);
  app.store.version(app.id, version.id, 'rollback'); assert.equal(app.project().activeVersionId, app.baselineId); assert.equal(app.project().versions.length, 2);
  const altered = structuredClone(version); altered.bundle.hash = 'wrong'; app.store.mutate(s => { s.projects.find(p => p.id === app.id).versions.push({ ...altered, id: 'forged', state: 'ready' }); });
  assert.throws(() => app.store.version(app.id, 'forged', 'trial'), /冻结评测证据/);
});

test('editing refuses a stale base and an explicit zero real limit before provider execution', async t => {
  const app = await setup(t); assert.throws(() => app.controller.start(app.id, { genome: { schemaVersion: 1 } }), error => error.status === 400); assert.equal(app.controller.operations.size, 0); assert.equal(app.store.state.realUsage.tokens, 0); assert.throws(() => app.controller.start(app.id, { baseVersionId: 'old' }), /基线已变化/);
  app.store.settings({ realTokenBudget: 0 }); assert.throws(() => app.controller.start(app.id, {}), /真实调用/); assert.equal(app.service.running.size, 0);
});
test('manual retry validates its immutable source before charging and links the new attempt', async t => {
  const app = await setup(t, { provider: genomeEvaluationProvider({ failJudge: true }) });
  assert.throws(() => app.controller.start(app.id, { retryVersionId: 'missing' }), error => error.code === 'retry_source_invalid');
  assert.equal(app.store.state.realUsage.reservedTokens, 0);
  app.controller.start(app.id, { genome: projectGenomeFixture({ candidate: true }) }); await app.controller.operations.get(app.id).promise;
  const source = app.project().versions.at(-1); assert.equal(source.state, 'failed');
  assert.throws(() => app.controller.start(app.id, { retryVersionId: source.id, genome: projectGenomeFixture({ candidate: true }) }), error => error.status === 400);
  app.service.provider = genomeEvaluationProvider(); app.controller.start(app.id, { retryVersionId: source.id }); await app.controller.operations.get(app.id).promise;
  const retried = app.project().versions.at(-1); assert.equal(retried.state, 'ready'); assert.equal(retried.retryOfVersionId, source.id); assert.equal(retried.candidateHash, source.candidateHash); assert.equal(app.store.state.realUsage.reservedTokens, 0);
});

function authorFailure(app) {
  const row = { id: 'author-failed', simulated: false, state: 'failed', parentVersionId: app.baselineId,
    learningReviewId: 'review', learningContextHash: 'a'.repeat(64), learningIntent: { content: 'Original hypothesis' }, error: { code: 'step_limit', diagnostic: { phase: 'proposal' } } };
  app.store.mutate(state => state.projects.find(project => project.id === app.id).versions.push(row));
  return structuredClone(row);
}
test('author retry routes only the immutable source identifier and does not fabricate another user-edit evidence batch', async t => {
  const app = await setup(t), original = authorFailure(app), calls = [];
  app.service.regenerateAuthor = async (id, input) => { calls.push({ id, input }); return { status: 'rejected', version: { id: 'new-attempt' }, summary: 'Original inputs checked, quality gate still applies', usage: { totalTokens: 19, estimatedTokens: 2 } }; };
  for (const conflict of [{ genome: projectGenomeFixture() }, { retryVersionId: original.id }, { summary: 'Replace original experiment' }]) assert.throws(() => app.controller.start(app.id, { retryAuthorVersionId: original.id, ...conflict }), error => error.status === 400);
  assert.throws(() => app.controller.start(app.id, { retryAuthorVersionId: 'missing' }), error => error.code === 'author_retry_source_invalid');
  assert.equal(app.store.state.realUsage.reservedTokens, 0); assert.equal(calls.length, 0);
  app.controller.start(app.id, { retryAuthorVersionId: original.id }); await app.controller.operations.get(app.id).promise;
  assert.equal(calls.length, 1); assert.equal(calls[0].id, app.id); assert.equal(calls[0].input.retryAuthorVersionId, original.id); assert.equal(calls[0].input.evidence, undefined); assert.equal(calls[0].input.learningIntent, undefined);
  assert.equal(app.store.state.realUsage.tokens, 19); assert.equal(app.store.state.realUsage.reportedTokens, 17); assert.equal(app.store.state.realUsage.estimatedTokens, 2); assert.equal(app.store.state.realUsage.reservedTokens, 0);
  assert.equal(app.project().evolution.request.versionId, 'new-attempt'); assert.deepEqual(app.project().versions.find(row => row.id === original.id), original);
});
test('failed author recovery preflight releases its reservation without billing requests that were never sent', async t => {
  const app = await setup(t), original = authorFailure(app);
  app.service.regenerateAuthor = async () => { throw Object.assign(new Error('Frozen source differs'), { code: 'author_retry_evidence_changed', usage: { totalTokens: 0, estimatedTokens: 0 } }); };
  app.controller.start(app.id, { retryAuthorVersionId: original.id }); await app.controller.operations.get(app.id).promise;
  assert.equal(app.store.state.realUsage.tokens, 0); assert.equal(app.store.state.realUsage.reservedTokens, 0); assert.equal(app.controller.operations.size, 0);
  assert.equal(app.project().evolution.request.code, 'author_retry_evidence_changed'); assert.deepEqual(app.project().versions.find(row => row.id === original.id), original);
});
test('closing an author recovery passes cancellation to the same execution and waits for its settlement', async t => {
  const app = await setup(t), original = authorFailure(app); let activeSignal;
  app.service.regenerateAuthor = async (_id, input) => { activeSignal = input.signal; await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true })); return { status: 'interrupted', usage: { totalTokens: 0 }, summary: 'No request dispatched' }; };
  app.controller.start(app.id, { retryAuthorVersionId: original.id }); assert.equal(activeSignal.aborted, false); await app.controller.close();
  assert.equal(activeSignal.aborted, true); assert.equal(app.controller.operations.size, 0); assert.equal(app.store.state.realUsage.reservedTokens, 0); assert.equal(app.project().evolution.request.status, 'interrupted'); assert.deepEqual(app.project().versions.find(row => row.id === original.id), original);
});

test('new real projects get distinct managed directories instead of the daemon source tree', async t => {
  const app = await setup(t), a = app.store.createProject({ name: 'One', initialize: true }), b = app.store.createProject({ name: 'Two', initialize: true });
  assert.notEqual(a.project.workspace, b.project.workspace); assert.notEqual(a.project.workspace, process.cwd()); assert.equal(a.project.workspaceManaged, true); assert.equal(a.session.workspace, a.project.workspace);
});

test('failed reservation persistence releases the manual operation lock and permits a corrected retry', async t => {
  const app = await setup(t), persist = app.store.persist.bind(app.store);
  app.store.persist = () => { throw new Error('fixture disk failure'); };
  assert.throws(() => app.controller.start(app.id, {}), /fixture disk failure/);
  assert.equal(app.controller.operations.size, 0); assert.equal(app.service.running.size, 0); assert.equal(app.store.state.realUsage.reservedTokens, 0); assert.equal(app.project().evolution.request, undefined);
  app.store.persist = persist;
  assert.equal(app.controller.start(app.id, { genome: projectGenomeFixture({ candidate: true }) }).status, 'running');
  await app.controller.operations.get(app.id).promise; assert.equal(app.project().evolution.request.status, 'ready');
});

for (const first of ['manual', 'autonomous']) test(`${first} evolution holds the same project lock against the other entry point`, async t => {
  const hold = heldProvider(), app = await setup(t, hold); let pending;
  if (first === 'manual') { app.controller.start(app.id, { genome: projectGenomeFixture({ candidate: true }) }); pending = app.controller.operations.get(app.id).promise; }
  else pending = app.service.evolve(app.id, { model: app.model, evidence: [{ id: 'new-external-evidence', summary: 'Improve observed response quality' }] });
  await hold.ready;
  try {
    if (first === 'manual') await assert.rejects(app.service.evolve(app.id, { model: app.model }), { code: 'evolution_busy' });
    else assert.throws(() => app.controller.start(app.id, {}), /已有进化评测/);
  } finally { hold.release(); }
  const result = await pending; assert.equal(result.status, 'ready'); assert.equal(app.project().versions.length, 2); assert.equal(app.project().activeVersionId, app.baselineId);
});

for (const interruption of ['archive', 'emergency']) test(`${interruption} during manual evaluation aborts an ignoring provider and prevents late ready publication`, async t => {
  const hold = heldProvider(), app = await setup(t, hold); app.controller.start(app.id, { genome: projectGenomeFixture({ candidate: true }) }); const pending = app.controller.operations.get(app.id).promise;
  const request = await hold.ready;
  if (interruption === 'archive') app.store.updateProject(app.id, { archived: true }); else app.store.emergency(true);
  assert.equal(request.signal.aborted, true); hold.release(); await pending;
  const version = app.project().versions.at(-1); assert.equal(version.state, 'interrupted'); assert.equal(version.bundle, undefined); assert.equal(app.project().activeVersionId, app.baselineId); assert.equal(app.project().trialVersionId, null); assert.equal(app.store.state.realUsage.reservedTokens, 0); assert.equal(app.controller.operations.size, 0);
});
