import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectLearningController } from '../project-learning-controller.mjs';
import { learningHash, projectLearningEpisodes } from '../project-learning-evidence.mjs';
import { learningExecutionScope, learningCredentialIdentity, learningEvidenceScopeV2 } from '../project-learning-scope.mjs';
import { LEARNING_REFLECTION_CONTRACT_HASH } from '../../../packages/sdk/src/learning.mjs';

const legacyIdentity = 'f605978f11adbdbdd166774fdf132ab5726e2c03cabf3c2f345e7b0b9ac289b8';
async function until(predicate) { const end = Date.now() + 6000; while (!predicate()) { if (Date.now() > end) throw Error('condition timeout'); await delay(10); } }
const decision = episodes => ({ outcome: 'no_change', evidenceIds: episodes.map(row => row.id), reason: 'Existing source remains unchanged', diagnosis: 'No independent new outcome was observed', hypothesis: '', intervention: '', validationPlan: '', limitations: 'Fixture only', nextReviewAfterMs: 60000 });
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-learning-scope-')), store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'scope fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-credential-one', models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 8192, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const workspace = join(directory, 'workspace'); mkdirSync(workspace);
  const { project, session } = store.createProject({ name: 'Scope fixture', description: 'Keep independently recorded evidence', workspace });
  store.mutate(state => {
    const p = state.projects.find(row => row.id === project.id), s = state.sessions.find(row => row.id === session.id);
    Object.assign(p, { decisionMode: 'rna-model', simulated: false, initialization: { status: 'ready' }, activeVersionId: 'baseline', versions: [{ id: 'baseline', bundle: { hash: 'baseline-hash', genome: { skills: [], tools: [], evaluationSuite: { cases: [] } } } }] });
    p.rhythm = { control: 'manual' }; p.initiative.enabled = true; p.initiative.tokenBudget = null; p.evolution.enabled = true; p.evolution.minIntervalMs = 0;
    for (const id of ['consumed', 'pending']) {
      const at = new Date(Date.now() - (id === 'consumed' ? 2000 : 1000)).toISOString();
      s.turns.push({ id, status: 'completed', createdAt: at, completedAt: at, modelConfig: { execution: 'rna' } });
      s.items.push({ id: `${id}-u`, turnId: id, kind: 'user', text: 'Check both boundary cases', createdAt: at }, { id: `${id}-tool`, turnId: id, kind: 'tool', tool: { name: 'project_exec', status: 'succeeded', output: 'One real command completed' }, simulated: false });
    }
  });
  const current = () => store.state.projects.find(row => row.id === project.id), calls = [], controllers = [], service = { running: new Map(), evolve: async () => { throw Error('No experiment should dispatch in this fixture'); } };
  const restart = options => {
    const c = new ProjectLearningController(store, { evolutionService: service, tickIntervalMs: 0, initialDelayMs: 100000, minReviewMs: 0, reflect: async input => { calls.push(input); return { decision: decision(input.episodes) }; }, ...options }); controllers.push(c); return c;
  };
  t.after(async () => { await Promise.all(controllers.map(c => c.close())); rmSync(directory, { recursive: true, force: true }); });
  const controller = restart(); await until(() => current().learningRuntime?.sdkState.episodes.length === 2); await controller.close();
  const seed = namespace => store.mutate(state => {
    const p = state.projects.find(row => row.id === project.id), runtime = p.learningRuntime;
    const episodes = projectLearningEpisodes(state, p, namespace ?? runtime.scopeHash, { since: 0 }).episodes.map(row => ({ ...row, key: learningHash([row.id, row.fingerprint]) }));
    runtime.evidenceFloor = 0;
    runtime.sdkState = { schemaVersion: 1, episodes: [{ ...episodes[1], status: 'deferred', nextReviewAt: Date.now() + 86400000, consecutiveFailures: 1, deferCount: 0 }],
      reviews: [{ id: 'consumed-review', status: 'no_change', episodeKeys: [episodes[0].key], sourceIds: episodes[0].sourceIds, decision: decision([episodes[0]]), startedAt: 1, completedAt: 2 }, { id: 'retained-review', status: 'failed', episodeKeys: [episodes[1].key], sourceIds: episodes[1].sourceIds, error: { code: 'fixture_error' }, startedAt: 3, completedAt: 4 }],
      seen: [{ key: episodes[0].key, reviewId: 'consumed-review', outcome: 'no_change', at: 2 }], nextReviewAt: Date.now() + 86400000 };
  });
  seed();
  return { store, current, project, session, provider, controller, calls, restart, seed };
}
async function restored(app, options) { const controller = app.restart(options); await until(() => controller.contexts.get(app.project.id)?.lastProjection); return controller; }
function retained(before, after) {
  assert.equal(after.scopeSchemaVersion, 3); assert.equal(after.scopeHash, before.scopeHash); assert.equal(after.evidenceFloor, before.evidenceFloor);
  assert.deepEqual(after.sdkState.episodes, before.sdkState.episodes); assert.deepEqual(after.sdkState.seen, before.sdkState.seen); assert.deepEqual(after.sdkState.reviews, before.sdkState.reviews);
}

test('SDK execution revision changes preserve exact episode fingerprints, consumed keys and evidence floor', async t => {
  const app = await fixture(t); app.store.mutate(state => { state.projects.find(p => p.id === app.project.id).learningRuntime.executionRevisionHash = 'previous-sdk-runtime'; });
  const before = structuredClone(app.current().learningRuntime); await restored(app);
  retained(before, app.current().learningRuntime); assert.notEqual(app.current().learningRuntime.executionRevisionHash, before.executionRevisionHash); assert.equal(app.calls.length, 0);
});

for (const field of ['contextWindow', 'maxOutputTokens', 'name']) test(`${field} configuration edits refresh execution without re-ingesting old sources`, async t => {
  const app = await fixture(t), before = structuredClone(app.current().learningRuntime), provider = app.store.state.configuration.providers.find(p => p.id === app.provider.id);
  const value = field === 'contextWindow' ? 256000 : field === 'maxOutputTokens' ? 16384 : 'Renamed UI model';
  app.store.configurationService.provider(provider.id, { models: provider.models.map(m => ({ ...m, [field]: value })) });
  await restored(app); retained(before, app.current().learningRuntime); assert.notEqual(app.current().learningRuntime.executionRevisionHash, before.executionRevisionHash); assert.equal(app.calls.length, 0);
});

test('discovery annotations and unselected catalog rows do not change evidence or execution', async t => {
  const app = await fixture(t), before = structuredClone(app.current().learningRuntime);
  app.store.mutate(state => { const p = state.configuration.providers.find(p => p.id === app.provider.id); p.modelDiscovery = { checkedAt: new Date().toISOString(), found: 8 }; p.models[0].modelMaxOutputTokens = 131072; p.models.push({ id: 'other-catalog-row', name: 'Other', contextWindow: 64000, maxOutputTokens: 4096, reasoning: ['off'] }); });
  await restored(app); retained(before, app.current().learningRuntime); assert.equal(app.current().learningRuntime.executionRevisionHash, before.executionRevisionHash); assert.equal(app.calls.length, 0);
});

test('registered legacy release migration proves full previous boundary and keeps its fingerprint namespace', async t => {
  const app = await fixture(t), legacy = app.controller.legacyScope(app.current(), app.controller.model(app.current()), legacyIdentity); app.seed(legacy);
  app.store.mutate(state => { const r = state.projects.find(p => p.id === app.project.id).learningRuntime; r.scopeHash = legacy; delete r.scopeSchemaVersion; delete r.evidenceScopeHash; delete r.executionRevisionHash; });
  const before = structuredClone(app.current().learningRuntime); await restored(app); const after = app.current().learningRuntime;
  retained(before, after); assert.equal(after.scopeMigration.verifiedLegacyMethodIdentity, legacyIdentity); assert.equal(after.scopeMigration.verifiedScopeHash, legacy); assert.equal(app.calls.length, 0);
  assert.equal(after.scopeMigration.verifiedSourceBoundaryHash, after.evidenceScopeHash);
});

test('v2 unknown namespace without migration proof is never accepted just because the stored boundary matches', async t => {
  const app = await fixture(t), namespace = 'a'.repeat(64); app.seed(namespace);
  app.store.mutate(state => { const r = state.projects.find(p => p.id === app.project.id).learningRuntime; r.scopeHash = namespace; delete r.scopeMigration; });
  await restored(app); const after = app.current().learningRuntime;
  assert.notEqual(after.scopeHash, namespace); assert.ok(after.sdkState.reviews.slice(0, 2).every(r => r.sourceRevoked === true));
});

// G9: only a privacy boundary revokes; context drift annotates and keeps evidence.
test('workspace (privacy) boundary change revokes old frozen source text', async t => {
  const app = await fixture(t), before = structuredClone(app.current().learningRuntime);
  app.store.mutate(state => { state.projects.find(p => p.id === app.project.id).workspace += '-other'; });
  await restored(app); const after = app.current().learningRuntime;
  assert.notEqual(after.scopeHash, before.scopeHash); assert.ok(after.sdkState.reviews.slice(0, 2).every(r => r.sourceRevoked === true && r.revocationReason === 'privacy_boundary_changed'));
  assert.ok(!after.sdkState.episodes.some(e => e.key === before.sdkState.episodes[0].key));
});

test('archiving a conversation revokes only that conversation\'s sources, keeping the namespace', async t => {
  const app = await fixture(t), before = structuredClone(app.current().learningRuntime);
  app.store.mutate(state => { state.sessions.find(s => s.id === app.session.id).archivedAt = new Date().toISOString(); });
  await restored(app); const after = app.current().learningRuntime;
  assert.equal(after.scopeHash, before.scopeHash);
  assert.ok(after.sdkState.reviews.slice(0, 2).every(r => r.sourceRevoked === true && r.revocationReason === 'session_archived'));
  assert.equal(after.sdkState.episodes.length, 0);
});

for (const [change, component] of [['permission', 'permissions'], ['endpoint', 'model'], ['credential', 'credential'], ['model-switch', 'model'], ['active-version', 'activeVersion']]) test(`${change} drift annotates episodes and never revokes`, async t => {
  const app = await fixture(t), before = structuredClone(app.current().learningRuntime);
  if (change === 'credential') app.store.configurationService.provider(app.provider.id, { apiKey: 'fixture-credential-two' });
  else if (change === 'endpoint') app.store.configurationService.provider(app.provider.id, { baseUrl: 'http://127.0.0.1:2/v1' });
  else if (change === 'model-switch') { const provider = app.store.state.configuration.providers.find(p => p.id === app.provider.id); app.store.configurationService.provider(provider.id, { models: [...provider.models, { id: 'fixture-two', contextWindow: 128000, maxOutputTokens: 8192, reasoning: ['off'] }] }); app.store.mutate(state => { state.projects.find(p => p.id === app.project.id).initiative.modelSelection = { providerId: app.provider.id, modelId: 'fixture-two', reasoning: 'off' }; }); }
  else app.store.mutate(state => {
    const p = state.projects.find(p => p.id === app.project.id);
    if (change === 'permission') p.permissions = { foreground: 'read', background: 'read' };
    if (change === 'active-version') { p.versions.push({ id: 'v2', bundle: { hash: 'v2-hash', genome: { skills: [], tools: [], evaluationSuite: { cases: [] } } } }); p.activeVersionId = 'v2'; }
  });
  await restored(app); const after = app.current().learningRuntime;
  assert.equal(after.scopeSchemaVersion, 3); assert.equal(after.scopeHash, before.scopeHash); assert.equal(after.evidenceScopeHash, before.evidenceScopeHash);
  assert.ok(after.sdkState.reviews.every(r => r.sourceRevoked !== true), 'drift never revokes');
  assert.deepEqual(after.sdkState.seen, before.sdkState.seen);
  assert.ok(after.sdkState.episodes.length >= 1 && after.sdkState.episodes.every(e => e.contextDrift?.includes(component)), `episodes annotated with ${component}`);
  assert.ok(after.contextDrift.at(-1).components.includes(component));
});

test('a consistent v2 runtime migrates to v3 without revocation; a drifted boundary is annotated', async t => {
  const app = await fixture(t), model = app.controller.model(app.current());
  const v2 = learningEvidenceScopeV2(app.store.state, app.current(), model, learningCredentialIdentity(app.store, model)); app.seed(v2);
  app.store.mutate(state => { const p = state.projects.find(p => p.id === app.project.id), r = p.learningRuntime; Object.assign(r, { scopeSchemaVersion: 2, scopeHash: v2, evidenceScopeHash: v2 }); delete r.driftIdentity; delete r.scopeMigration; p.permissions = { foreground: 'read', background: 'read' }; });
  const before = structuredClone(app.current().learningRuntime); await restored(app); const after = app.current().learningRuntime;
  assert.equal(after.scopeSchemaVersion, 3); assert.equal(after.scopeHash, v2, 'namespace kept'); assert.equal(after.scopeMigration.from, 'evidence-scope-v2'); assert.equal(after.scopeMigration.exact, false);
  assert.ok(after.sdkState.reviews.every(r => r.sourceRevoked !== true)); assert.deepEqual(after.sdkState.seen, before.sdkState.seen);
  assert.ok(after.sdkState.episodes[0].contextDrift.includes('scope_v3_migration'));
});

for (const invalidation of ['unknown-legacy-method', 'changed-permission', 'changed-credential']) test(`legacy migration fails closed for ${invalidation}`, async t => {
  const app = await fixture(t), legacy = app.controller.legacyScope(app.current(), app.controller.model(app.current()), invalidation === 'unknown-legacy-method' ? 'unregistered-runtime' : legacyIdentity); app.seed(legacy);
  app.store.mutate(state => { const p = state.projects.find(p => p.id === app.project.id), r = p.learningRuntime; r.scopeHash = legacy; delete r.scopeSchemaVersion; delete r.evidenceScopeHash; delete r.executionRevisionHash; if (invalidation === 'changed-permission') p.permissions = { foreground: 'read', background: 'read' }; });
  if (invalidation === 'changed-credential') app.store.configurationService.provider(app.provider.id, { apiKey: 'changed-legacy-credential' });
  await restored(app); const after = app.current().learningRuntime;
  assert.notEqual(after.scopeHash, legacy); assert.equal(after.scopeMigration, undefined); assert.ok(after.sdkState.reviews.slice(0, 2).every(r => r.sourceRevoked === true));
});

test('a changed execution revision re-reviews queued decisions without revoking their sources or replaying consumed work', async t => {
  const app = await fixture(t);
  app.store.mutate(state => { const r = state.projects.find(p => p.id === app.project.id).learningRuntime, e = r.sdkState.episodes[0], review = r.sdkState.reviews[1];
    r.executionRevisionHash = 'old-runtime'; review.status = 'queued_experiment'; review.decision = { ...decision([e]), outcome: 'experiment', hypothesis: 'A bounded improvement', intervention: 'Change a skill', validationPlan: 'Check unchanged cases' }; delete review.error;
    e.status = 'queued_experiment'; e.reviewId = review.id; r.sdkState.nextReviewAt = 0;
  });
  const namespace = app.current().learningRuntime.scopeHash; await restored(app); await until(() => app.calls.length === 1 && app.current().learningRuntime.sdkState.reviews.at(-1).status === 'no_change');
  const after = app.current().learningRuntime; assert.equal(after.scopeHash, namespace); assert.equal(after.sdkState.seen.length, 2);
  const prior = after.sdkState.reviews.find(r => r.id === 'retained-review'); assert.equal(prior.status, 'interrupted'); assert.equal(prior.sourceRevoked, undefined); assert.equal(prior.error.code, 'learning_execution_revision_changed'); assert.ok(prior.reconciledAt); assert.equal(prior.decision.outcome, 'experiment');
});

test('configured output increase retries an exactly receipted truncated batch once after scope verification', async t => {
  const app = await fixture(t);
  app.store.mutate(state => { const r = state.projects.find(p => p.id === app.project.id).learningRuntime, review = r.sdkState.reviews[1];
    r.sdkState.episodes[0].status = 'awaiting_evidence'; review.error = { code: 'incomplete_learning_reflection' };
    review.request = { phase: 'learning_reflection', requestStarted: true, usageReported: true, stopReason: 'length', completed: false, usage: { output: 4096 } };
  });
  const before = structuredClone(app.current().learningRuntime), provider = app.store.state.configuration.providers.find(p => p.id === app.provider.id);
  app.store.configurationService.provider(provider.id, { models: provider.models.map(m => ({ ...m, maxOutputTokens: 16384 })) });
  await restored(app); await until(() => app.calls.length === 1 && app.current().learningRuntime.sdkState.reviews.at(-1).status === 'no_change');
  const after = app.current().learningRuntime; assert.equal(after.scopeHash, before.scopeHash); assert.equal(after.evidenceFloor, 0); assert.equal(after.sdkState.seen.length, 2);
  const prior = after.sdkState.reviews.find(r => r.id === 'retained-review'); assert.deepEqual(prior.request, before.sdkState.reviews[1].request); assert.equal(prior.error.code, 'incomplete_learning_reflection'); assert.equal(prior.outputBudgetRecovery.maxOutputTokens, 16384); assert.equal(prior.sourceRevoked, undefined);
});

for (const proof of ['verified-legacy', 'persisted-before-recovery', 'invalid-persisted-proof', 'unknown-legacy', 'new-contract-receipt']) test(`contract correction recovery requires an actual older contract: ${proof}`, async t => {
  const app = await fixture(t);
  const previousMethod = 'fb1ce0cf91fc54b258b6897d6245f6e313673e32f97e4561b32e909657105c92';
  const model = app.controller.model(app.current());
  const legacyExecution = learningExecutionScope(app.store.state, app.current(), model, previousMethod, learningCredentialIdentity(app.store, model));
  app.store.mutate(state => {
    const r = state.projects.find(p => p.id === app.project.id).learningRuntime, review = r.sdkState.reviews[1];
    r.executionRevisionHash = proof === 'verified-legacy' ? legacyExecution : 'unknown-runtime';
    if (['persisted-before-recovery', 'invalid-persisted-proof'].includes(proof)) {
      r.executionRevisionHash = app.controller.scope(app.current(), model);
      r.reflectionContractMigration = { from: 'legacy-reflection-contract-v1', previousMethodIdentity: previousMethod,
        previousContractHash: '7911e68f79c061114dd35215e70db3eed7d974ded4a987a4d22d3734402fc3a9', previousExecutionRevisionHash: legacyExecution,
        verifiedSourceBoundaryHash: proof === 'persisted-before-recovery' ? r.evidenceScopeHash : 'invalid-boundary' };
    }
    r.sdkState.episodes[0].status = 'awaiting_evidence'; r.sdkState.episodes[0].consecutiveFailures = 3;
    review.error = { code: 'invalid_learning_reflection' };
    review.request = { phase: 'learning_reflection', requestStarted: true, usageReported: true, stopReason: 'stop', completed: false, usage: { output: 8912 }, ...(proof === 'new-contract-receipt' ? { reflectionContractHash: LEARNING_REFLECTION_CONTRACT_HASH } : {}) };
  });
  const before = structuredClone(app.current().learningRuntime);
  await restored(app);
  if (['verified-legacy', 'persisted-before-recovery'].includes(proof)) {
    await until(() => app.calls.length === 1 && app.current().learningRuntime.sdkState.reviews.at(-1).status === 'no_change');
    const after = app.current().learningRuntime, prior = after.sdkState.reviews.find(r => r.id === 'retained-review');
    assert.equal(after.scopeHash, before.scopeHash); assert.equal(after.evidenceFloor, 0); assert.equal(after.sdkState.seen.length, 2);
    assert.deepEqual(prior.request, before.sdkState.reviews[1].request); assert.equal(prior.error.code, 'invalid_learning_reflection');
    assert.equal(prior.contractRecovery.contractHash, LEARNING_REFLECTION_CONTRACT_HASH); assert.equal(prior.sourceRevoked, undefined);
    assert.equal(after.reflectionContractMigration.previousExecutionRevisionHash, legacyExecution);
  } else {
    retained(before, app.current().learningRuntime); assert.equal(app.calls.length, 0);
  }
});
