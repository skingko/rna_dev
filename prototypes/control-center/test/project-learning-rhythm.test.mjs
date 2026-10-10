import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectLearningController } from '../project-learning-controller.mjs';
import { ProjectLearningBudget } from '../project-learning-budget.mjs';
import { projectRhythmStatus } from '../project-rhythm.mjs';
import { PROJECT_EVALUATION_RUNTIME_HASH } from '../../../packages/sdk/src/project-evolution.mjs';

const DAY = 86400000;
const assessment = (mode = 'daily') => ({ lifecycle: 'recurring', reason: 'One verified delivery per day; batch reusable changes after that delivery.', evidenceIds: ['project:fixture'], scheduleIds: [],
  initiative: { mode: 'event_only', reviewAfterMs: DAY }, evolution: { mode, maxPerDay: 1, maxPerWeek: 3, minIntervalMs: 3600000 } });
const decision = (ids, outcome = 'no_change') => ({ outcome, evidenceIds: ids, reason: 'Observed result is already covered', diagnosis: 'No new reusable deficiency was demonstrated', hypothesis: outcome === 'experiment' ? 'A boundary check reduces omissions' : '', intervention: outcome === 'experiment' ? 'Add a boundary check' : '', validationPlan: outcome === 'experiment' ? 'Use the unchanged frozen cases' : '', limitations: 'Protocol fixture only', nextReviewAfterMs: 60000 });
async function until(predicate) { const end = Date.now() + 6000; while (!predicate()) { if (Date.now() > end) throw Error('condition timeout'); await delay(10); } }

async function fixture(t, { rhythmAssessment, automatic = true, start = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-learning-rhythm-')), store = new Store(join(directory, 'state.json')), workspace = join(directory, 'workspace'); mkdirSync(workspace);
  const configured = store.configurationService.provider(null, { name: 'Rhythm fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 4096, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: configured.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ name: 'Domain-neutral fixture', description: 'Deliver the requested output according to observed responsibilities.', workspace });
  let clock = Date.UTC(2026, 8, 26, 12), calls = 0; const experiments = [], controllers = [];
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); Object.assign(p, { rhythm: { control: automatic ? 'auto' : 'manual' }, decisionMode: 'rna-model', simulated: false, initialization: { status: 'ready' }, activeVersionId: 'base', versions: [{ id: 'base', bundle: { hash: 'base-hash', genome: { skills: [], tools: [], evaluationSuite: { cases: [] } } } }], ...(rhythmAssessment ? { rhythmRuntime: { assessment: rhythmAssessment } } : {}) }); p.initiative.enabled = true; p.evolution.enabled = true; p.initiative.tokenBudget = null; p.evolution.minIntervalMs = 0; });
  const current = () => store.state.projects.find(row => row.id === project.id);
  const addTurn = id => store.mutate(state => { const s = state.sessions.find(row => row.id === session.id), at = new Date(clock).toISOString(); s.turns.push({ id, status: 'completed', createdAt: at, completedAt: at, modelConfig: { execution: 'rna' } }); s.items.push({ id: `${id}-u`, kind: 'user', turnId: id, text: 'Check the boundary before reporting.', createdAt: at }, { id: `${id}-tool`, turnId: id, kind: 'tool', simulated: false, tool: { name: 'project_exec', status: 'succeeded', output: 'Actual tool receipt' } }); });
  addTurn('one');
  async function* provider(input) { calls++; const payload = JSON.parse(input.messages[0].content[0].text); yield { type: 'text_delta', delta: JSON.stringify(decision(payload.allowedEvidenceIds)) }; yield { type: 'usage', usage: { input: 20, output: 10, totalTokens: 30 } }; yield { type: 'done', stopReason: 'stop' }; }
  const service = { running: new Map(), evolve: async (_id, input) => { experiments.push(input); return { status: 'rejected', version: { id: 'fixture-version' }, summary: 'Unchanged fixture gate rejected the experiment' }; } };
  const restart = options => { const controller = new ProjectLearningController(store, { evolutionService: service, provider, now: () => clock, tickIntervalMs: 0, initialDelayMs: 0, minReviewMs: 0, freezeFiles: async () => ({ context: { files: [] }, coverage: {} }), ...options }); controllers.push(controller); return controller; };
  const controller = start ? restart() : null;
  t.after(async () => { for (const controller of controllers) await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, project, session, controller, current, addTurn, restart, experiments, calls: () => calls, now: () => clock, advance: ms => { clock += ms; } };
}

test('auto projects retain new evidence without paying for reflection before the first model rhythm assessment', async t => {
  const app = await fixture(t); await until(() => app.current().learningRuntime?.sdkState.episodes.length === 1);
  for (let i = 0; i < 5; i++) await app.controller.pump();
  assert.equal(app.calls(), 0); assert.equal(app.current().learningRuntime.sdkState.reviews.length, 0);
  assert.equal(app.current().learningRuntime.sdkState.episodes[0].status, 'pending');
  assert.equal(projectRhythmStatus(app.store.state, app.current(), { now: app.now() }).evolution.reason, 'assessment_required');
});

test('real SDK review identity reaches atomic cadence admission and daily evidence waits without another model call', async t => {
  const app = await fixture(t, { rhythmAssessment: assessment() });
  await until(() => app.current().learningRuntime?.sdkState.reviews[0]?.status === 'no_change');
  const review = app.current().learningRuntime.sdkState.reviews[0], runtime = app.current().rhythmRuntime;
  assert.equal(app.calls(), 1); assert.equal(runtime.learningAttempts.length, 1); assert.equal(runtime.learningAttempts[0].id, review.id);
  assert.equal(review.request.reviewId, review.id); assert.equal(app.current().learningRuntime.usage.lastReceipt.reviewId, review.id);
  assert.equal(app.current().learningRuntime.usage.totalTokens, 30);
  app.advance(1000); app.addTurn('two'); await until(() => app.current().learningRuntime.sdkState.episodes.length === 1);
  for (let i = 0; i < 5; i++) await app.controller.pump(); assert.equal(app.calls(), 1);
  assert.equal(projectRhythmStatus(app.store.state, app.current(), { now: app.now() }).evolution.reason, 'daily_review_quota');
  app.advance(DAY); await app.controller.pump();
  await until(() => app.current().learningRuntime.sdkState.reviews.length === 2 && app.current().learningRuntime.sdkState.reviews[1].status === 'no_change');
  assert.equal(app.calls(), 2); assert.equal(app.current().rhythmRuntime.learningAttempts.length, 2);
});

test('an already queued experiment survives adaptive evolution off without repaying its reflection', async t => {
  const app = await fixture(t, { rhythmAssessment: assessment('off') });
  await until(() => app.current().learningRuntime?.sdkState.episodes.length); await app.controller.close();
  app.store.mutate(state => { const p = state.projects.find(row => row.id === app.project.id), sdk = p.learningRuntime.sdkState, episode = sdk.episodes[0]; episode.status = 'queued_experiment'; episode.reviewId = 'already-reviewed'; sdk.reviews.push({ id: episode.reviewId, status: 'queued_experiment', episodeKeys: [episode.key], sourceIds: episode.sourceIds, decision: decision([episode.id], 'experiment'), startedAt: app.now() }); });
  app.restart(); await until(() => app.current().learningRuntime.sdkState.reviews.at(-1)?.status === 'completed');
  assert.equal(app.calls(), 0); assert.equal(app.experiments.length, 1); assert.equal(app.experiments[0].learningReviewId, 'already-reviewed');
});

test('durable result reconciliation and verified ready notices still complete while adaptive learning is off', async t => {
  const app = await fixture(t, { rhythmAssessment: assessment('off') });
  await until(() => app.current().learningRuntime?.sdkState.episodes.length); await app.controller.close();
  app.store.mutate(state => {
    const p = state.projects.find(row => row.id === app.project.id), sdk = p.learningRuntime.sdkState, episode = sdk.episodes[0];
    episode.status = 'executing'; episode.reviewId = 'completed-before-restart';
    sdk.reviews.push({ id: episode.reviewId, status: 'executing', episodeKeys: [episode.key], sourceIds: episode.sourceIds, decision: decision([episode.id], 'experiment'), startedAt: app.now() });
    p.versions.push({ id: 'durable-result', learningReviewId: episode.reviewId, parentVersionId: 'base', state: 'ready', title: 'Frozen checks passed', bundle: { hash: 'candidate-hash' }, evaluationRuntimeHash: PROJECT_EVALUATION_RUNTIME_HASH,
      evaluation: { gatePassed: true, simulated: false, candidateHash: 'candidate-hash', baselineHash: 'base-hash', evaluationRuntimeHash: PROJECT_EVALUATION_RUNTIME_HASH } });
  });
  const controller = app.restart();
  await until(() => app.current().learningRuntime.sdkState.reviews.at(-1)?.status === 'completed');
  await until(() => app.current().versions.at(-1).learningNotificationDeliveredAt);
  for (let i = 0; i < 5; i++) await controller.pump();
  assert.equal(app.current().learningRuntime.sdkState.reviews.at(-1).result.versionId, 'durable-result');
  assert.equal(app.calls(), 0); assert.equal(app.experiments.length, 0); assert.equal(app.current().activeVersionId, 'base');
  assert.equal(app.store.state.sessions.find(row => row.id === app.session.id).items.filter(row => row.versionId === 'durable-result').length, 1);
});

test('token refusal and pacing refusal roll back both reservations and learning admission', async t => {
  const app = await fixture(t, { rhythmAssessment: assessment(), start: false });
  const budget = new ProjectLearningBudget(app.store, app.project.id, { now: app.now });
  app.store.mutate(state => { state.settings.realTokenBudget = 20; const p = state.projects.find(row => row.id === app.project.id); p.learningRuntime = { sdkState: { episodes: [], reviews: [{ id: 'review-one', status: 'reviewing' }] } }; });
  assert.throws(() => budget.beforeRequest({ id: 'request-one', reviewId: 'review-one', phase: 'learning_reflection', estimatedTokens: 30 }), { code: 'budget' });
  assert.equal(app.current().rhythmRuntime.learningAttempts, undefined); assert.equal(app.store.state.realUsage.reservedTokens, 0);
  budget.beforeRequest({ id: 'request-one', reviewId: 'review-one', phase: 'learning_reflection', estimatedTokens: 10 }); budget.onUsage({ id: 'request-one', usage: { totalTokens: 5 }, usageReported: true, requestStarted: true });
  app.store.mutate(state => { state.projects.find(row => row.id === app.project.id).learningRuntime.sdkState.reviews.push({ id: 'review-two', status: 'reviewing' }); });
  assert.throws(() => budget.beforeRequest({ id: 'request-two', reviewId: 'review-two', phase: 'learning_reflection', estimatedTokens: 10 }), { code: 'project_rhythm_waiting' });
  assert.equal(app.current().rhythmRuntime.learningAttempts.length, 1); assert.equal(app.current().learningRuntime.usage.activeRequest, undefined); assert.equal(app.store.state.realUsage.reservedTokens, 0);
  // A retry inside the immutable review is not another daily admission.
  budget.beforeRequest({ id: 'request-one-retry', reviewId: 'review-one', phase: 'learning_reflection', estimatedTokens: 10 });
  assert.equal(app.current().rhythmRuntime.learningAttempts.length, 1); budget.onUsage({ requestStarted: false, usage: { totalTokens: 0 } });
  app.store.mutate(state => { state.projects.find(row => row.id === app.project.id).evolution.enabled = false; });
  assert.throws(() => budget.beforeRequest({ id: 'request-one-after-pause', reviewId: 'review-one', phase: 'learning_reflection', estimatedTokens: 10 }), { code: 'project_rhythm_waiting', reason: 'user_disabled' });
  assert.equal(app.store.state.realUsage.reservedTokens, 0); assert.equal(app.current().rhythmRuntime.learningAttempts.length, 1);
});

test('manual frequency bypasses adaptive assessment, while the user hard switch still prevents new reviews', async t => {
  const app = await fixture(t, { automatic: false }); await until(() => app.current().learningRuntime?.sdkState.reviews[0]?.status === 'no_change');
  assert.equal(app.calls(), 1); assert.equal(app.current().rhythmRuntime?.learningAttempts, undefined);
  app.store.mutate(state => { state.projects.find(row => row.id === app.project.id).evolution.enabled = false; }); app.addTurn('disabled');
  await app.controller.pump(); await delay(20); assert.equal(app.calls(), 1);
});
