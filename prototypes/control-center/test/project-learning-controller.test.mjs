import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectLearningController } from '../project-learning-controller.mjs';
import { projectLearningEpisodes, freezeProjectLearningFiles } from '../project-learning-evidence.mjs';
import { ProjectLearningBudget } from '../project-learning-budget.mjs';
import { PROJECT_EVALUATION_RUNTIME_HASH } from '../../../packages/sdk/src/project-evolution.mjs';

const hold = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(fn) { const end = Date.now() + 6000; while (!fn()) { if (Date.now() > end) throw Error('condition timeout'); await delay(10); } }
const result = episodes => ({ outcome: 'experiment', evidenceIds: episodes.map(row => row.id), reason: 'A repeated check missed an input boundary', diagnosis: 'Boundary verification was absent in the actual execution', hypothesis: 'Explicit boundary checks reduce omissions', intervention: 'Add boundary verification to the existing skill', validationPlan: 'Run the unchanged baseline cases and input compatibility checks; reject if they regress', limitations: 'No browser quality claim', nextReviewAfterMs: 60000 });
async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-learning-host-')), store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Learning test fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 4096, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ name: 'Boundary project', description: 'Build correct examples', workspace: join(directory, 'workspace') });
  mkdirSync(join(directory, 'workspace')); writeFileSync(join(directory, 'workspace', 'main.js'), 'export const add = (a, b) => a + b;');
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); Object.assign(p, { rhythm: { control: 'manual' }, decisionMode: 'rna-model', simulated: false, initialization: { status: 'ready' }, activeVersionId: 'base', versions: [{ id: 'base', bundle: { hash: 'basehash', genome: { skills: [], tools: [], evaluationSuite: { cases: [] } } } }] }); p.initiative.enabled = true; p.initiative.tokenBudget = null; p.evolution.enabled = true; p.evolution.minIntervalMs = 0; });
  const current = () => store.state.projects.find(row => row.id === project.id);
  const addTurn = (id = 'first') => store.mutate(state => { const s = state.sessions.find(row => row.id === session.id); s.turns.push({ id, status: 'completed', createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), modelConfig: { execution: 'rna' } }); s.items.push({ id: `${id}-user`, turnId: id, kind: 'user', text: 'Check both input forms', createdAt: new Date().toISOString() }, { id: `${id}-tool`, turnId: id, kind: 'tool', tool: { name: 'project_exec', status: 'succeeded', output: 'Only one variant checked' }, simulated: false }, { id: `${id}-answer`, turnId: id, kind: 'assistant', text: 'The test command succeeded', simulated: false }); });
  addTurn(); const calls = [], experiments = [];
  const service = { running: new Map(), evolve: async (id, input) => { experiments.push(input); return { status: 'rejected', version: { id: 'candidate' }, summary: 'Fixture evaluation rejected this candidate', usage: { totalTokens: 0 } }; }, ...options.service };
  const controller = new ProjectLearningController(store, { evolutionService: service, initialDelayMs: 0, tickIntervalMs: 0, minReviewMs: 0,
    reflect: async input => { calls.push(input); return { decision: result(input.episodes) }; }, ...options });
  t.after(async () => { await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, project, session, directory, current, controller, calls, experiments, addTurn, service };
}

test('independent learning consumes completed work without a new command or Goal, using immutable files', async t => {
  const app = await fixture(t); await until(() => app.experiments.length === 1 && app.current().learningRuntime.sdkState.reviews.at(-1)?.status === 'completed');
  assert.equal(app.store.state.goals.length, 0); assert.equal(app.calls.length, 1);
  assert.match(app.experiments[0].learningContext.files.find(row => row.path === 'main.js').content, /a \+ b/);
  assert.ok(app.experiments[0].learningReviewId); assert.match(app.experiments[0].learningIntent.content, /boundary/i);
  writeFileSync(join(app.directory, 'workspace', 'main.js'), 'changed');
  assert.match(app.experiments[0].learningContext.files[0].content, /a \+ b/);
  for (let i = 0; i < 4; i++) { await app.controller.pump(); await delay(5); }
  assert.equal(app.calls.length, 1); assert.equal(app.experiments.length, 1);
});

test('new messages and newly created conversations queue experience without aborting the running evaluation', async t => {
  const gate = hold(); let active;
  const app = await fixture(t, { service: { evolve: async (_, input) => { active = input; await gate.promise; input.signal.throwIfAborted(); return { status: 'rejected', version: { id: 'c' }, summary: 'Fixture rejection' }; } } });
  t.after(() => gate.resolve()); await until(() => active);
  app.store.mutate(state => { const s = state.sessions.find(row => row.id === app.session.id); s.items.push({ id: 'new-message', kind: 'user', text: 'Also consider bounds', createdAt: new Date().toISOString() }); state.sessions.push({ ...structuredClone(s), id: 'new-conversation', turns: [], items: [] }); });
  app.addTurn('second'); await app.controller.pump(); assert.equal(active.signal.aborted, false); assert.equal(active.commitGuard(), true);
  assert.equal(app.current().learningRuntime.sdkState.episodes.filter(row => row.status === 'pending').length, 1);
  gate.resolve(); await until(() => app.current().learningRuntime.sdkState.reviews[0].status === 'completed');
});

test('permission or baseline changes revoke old frozen work and preserve a visible interrupted audit', async t => {
  const gate = hold(); let active;
  const app = await fixture(t, { service: { evolve: async (_, input) => { active = input; await gate.promise; input.signal.throwIfAborted(); return { status: 'rejected', version: { id: 'c' }, summary: 'unused' }; } } });
  t.after(() => gate.resolve()); await until(() => active);
  app.store.mutate(state => { const p = state.projects.find(row => row.id === app.project.id); p.permissions = { foreground: 'read', background: 'read' }; });
  assert.equal(active.signal.aborted, true); assert.equal(active.commitGuard(), false); gate.resolve();
  await until(() => app.current().learningRuntime.sdkState.reviews.some(row => row.status === 'interrupted'));
});

test('shared evaluator contention defers the experiment without discarding evidence or repaying reflection', async t => {
  const app = await fixture(t, { now: () => 1900000000000 });
  app.service.running.set(app.project.id, {});
  await until(() => app.current().learningRuntime?.sdkState.reviews.at(-1)?.status === 'queued_experiment');
  assert.equal(app.calls.length, 1); assert.equal(app.experiments.length, 0);
  await app.controller.pump(); await delay(20); assert.equal(app.calls.length, 1);
});

test('temporary source read failure retains the hypothesis and later retries preparation without a second reflection', async t => {
  let clock = Date.now(), reads = 0;
  const app = await fixture(t, { now: () => clock, freezeFiles: async (...args) => { if (++reads === 1) throw Object.assign(Error('fixture unavailable'), { code: 'EACCES' }); return freezeProjectLearningFiles(...args); } });
  await until(() => app.current().learningRuntime?.sdkState.reviews.at(-1)?.deferredReason === 'learning_source_unavailable');
  assert.equal(app.calls.length, 1); assert.equal(app.experiments.length, 0);
  clock += 61000; await app.controller.pump();
  await until(() => app.current().learningRuntime.sdkState.reviews.at(-1)?.status === 'completed');
  assert.equal(app.calls.length, 1); assert.equal(app.experiments.length, 1);
});

for (const lineage of ['autonomous', 'explicit-authoring-retry']) test(`${lineage} ready notifications require a real passed gate, respect typing, and deliver exactly once without adopting`, async t => {
  const app = await fixture(t, { initialDelayMs: 100000 }); await until(() => app.current().learningRuntime);
  app.store.mutate(state => { const p = state.projects.find(row => row.id === app.project.id); p.versions.push({ id: 'ready', ...(lineage === 'autonomous' ? { learningReviewId: 'review' } : { source: lineage, retryOfLearningReviewId: 'review' }), parentVersionId: 'base', state: 'ready', title: 'Boundary method', bundle: { hash: 'candidatehash' }, evaluationRuntimeHash: PROJECT_EVALUATION_RUNTIME_HASH, evaluation: { gatePassed: true, simulated: false, candidateHash: 'candidatehash', baselineHash: 'basehash', evaluationRuntimeHash: PROJECT_EVALUATION_RUNTIME_HASH } }); });
  app.store.presences.set(app.project.id, { visible: true, typing: true, sessionId: app.session.id, expiresAt: new Date(Date.now() + 60000).toISOString() });
  app.controller.deliverReady(app.current()); assert.equal(app.current().versions.at(-1).learningNotificationDeliveredAt, undefined);
  app.store.presences.delete(app.project.id); app.controller.deliverReady(app.current()); app.controller.deliverReady(app.current());
  assert.equal(app.store.state.sessions.find(row => row.id === app.session.id).items.filter(row => row.versionId === 'ready').length, 1);
  assert.equal(app.current().activeVersionId, 'base');
});

test('source collection excludes private and symlink files, unknown claims remain labeled, learning does not feed itself', async t => {
  const app = await fixture(t, { initialDelayMs: 100000 });
  writeFileSync(join(app.directory, 'workspace', '.env'), 'SECRET'); symlinkSync(join(app.directory, 'state.json'), join(app.directory, 'workspace', 'state-link.json'));
  mkdirSync(join(app.directory, 'workspace', '.state')); writeFileSync(join(app.directory, 'workspace', '.state', 'oracle.json'), 'HELD OUT');
  const { episodes } = projectLearningEpisodes(app.store.state, app.current(), 'scope'); assert.equal(episodes.length, 1); assert.match(episodes[0].summary, /verifiedByHost.*false/);
  const { context } = await freezeProjectLearningFiles(app.current(), episodes); assert.deepEqual(context.files.map(row => row.path), ['main.js']);
  app.store.mutate(state => { const p = state.projects.find(row => row.id === app.project.id); p.initiativeRuntime = { sdkState: { actions: [{ id: 'learner', action: 'learn', status: 'completed', resultSummary: 'self praise' }] } }; });
  assert.equal(projectLearningEpisodes(app.store.state, app.current(), 'scope').episodes.length, 1);
});

test('startup reconciles leftover learning admission even when the project is disabled or archived', async t => {
  const app = await fixture(t, { initialDelayMs: 100000 }); await until(() => app.current().learningRuntime);
  await app.controller.close();
  new ProjectLearningBudget(app.store, app.project.id).beforeRequest({ id: 'lost-before-restart', estimatedTokens: 123, phase: 'learning_reflection' });
  app.store.mutate(state => { const p = state.projects.find(row => row.id === app.project.id); p.initiative.enabled = false; p.evolution.enabled = false; p.archivedAt = new Date().toISOString(); });
  const recovered = new ProjectLearningController(app.store, { evolutionService: app.service, tickIntervalMs: 0 });
  t.after(() => recovered.close());
  assert.equal(app.current().learningRuntime.usage.totalTokens, 123); assert.equal(app.current().learningRuntime.usage.reservedTokens, 0);
  assert.equal(app.store.state.realUsage.reservations[`learning:${app.project.id}`], undefined);
  assert.equal(app.current().learningRuntime.usage.recoveredRequests, 1); assert.equal(app.calls.length, 0);
});

test('restart settles the exact durable version without executing the experiment again', async t => {
  const app = await fixture(t, { initialDelayMs: 100000 }); await until(() => app.current().learningRuntime?.sdkState?.episodes.length);
  await app.controller.close();
  app.store.mutate(state => { const p = state.projects.find(row => row.id === app.project.id), sdk = p.learningRuntime.sdkState, episode = sdk.episodes[0];
    episode.status = 'executing'; episode.reviewId = 'review-before-restart';
    sdk.reviews.push({ id: episode.reviewId, status: 'executing', episodeKeys: [episode.key], sourceIds: episode.sourceIds, startedAt: Date.now(), decision: result([episode]) });
    p.versions.push({ id: 'durable-rejection', state: 'rejected', learningReviewId: episode.reviewId, parentVersionId: 'base', simulated: false });
  });
  const recovered = new ProjectLearningController(app.store, { evolutionService: app.service, tickIntervalMs: 0, initialDelayMs: 100000 }); t.after(() => recovered.close());
  await until(() => app.current().learningRuntime.sdkState.reviews.at(-1)?.status === 'completed');
  assert.equal(app.current().learningRuntime.sdkState.reviews.at(-1).result.versionId, 'durable-rejection'); assert.equal(app.experiments.length, 0);
});
