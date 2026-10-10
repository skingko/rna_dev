import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { PROJECT_SCHEDULE_DEFAULTS, PROJECT_SCHEDULE_PRESETS, makeProject, normalizeProjectSchedule, updateProject } from '../project-proactivity.mjs';
import { applyProjectPermissions } from '../project-permissions.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { ProjectEvolutionService } from '../test-support/marketplace-isolation.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from '../../../packages/sdk/test/fixtures/project-genome.mjs';
const model = { protocol: 'openai', providerId: 'fixture', modelId: 'fixture', maxOutputTokens: 2048, contextWindow: 64000 };
async function until(check) { const limit = Date.now() + 10000; while (!check()) { if (Date.now() > limit) throw new Error('Schedule fixture did not settle'); await delay(5); } }
const decision = (input, action = 'wait') => ({ action, reason: 'Actual project evidence', evidenceIds: action === 'wait' ? [] : [input.events.at(-1).id], content: action === 'wait' ? '' : 'Check current evidence', nextReviewAfterMs: 1000 });
async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-project-schedule-')), store = new Store(join(dir, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 2048, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Timing fixture', workspace: dir });
  store.mutate(state => { const row = state.projects.find(p => p.id === project.id); row.decisionMode = 'rna-model'; row.simulated = false; row.initialization = { status: 'ready' }; });
  let clock = 1000; const calls = [], handles = [];
  const defaultProvider = async function* (request) { const input = JSON.parse(request.messages[0].content[0].text); calls.push(input); yield { type: 'text_delta', delta: JSON.stringify(decision(input)) }; yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done' }; };
  const create = extra => { const controller = new ProjectInitiativeController(store, { now: () => clock, tickIntervalMs: 0, initialDelayMs: 0, decisionProvider: defaultProvider, ...options, ...extra }); handles.push(controller); return controller; };
  t.after(async () => { for (const handle of handles) await handle.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, project, session, dir, create, calls, clock: value => { clock = value; }, current: () => store.state.projects.find(row => row.id === project.id) };
}
test('project presets and custom millisecond values persist; legacy cooldown and evaluated timestamps are preserved', async t => {
  const f = await fixture(t); assert.equal(f.current().initiative.cooldownMs, 300000); assert.equal(f.current().evolution.minIntervalMs, 3600000);
  for (const preset of Object.values(PROJECT_SCHEDULE_PRESETS)) {
    const { minIntervalMs, ...initiative } = preset; f.store.updateProject(f.project.id, { initiative, evolution: { minIntervalMs } });
    assert.deepEqual(new Store(f.store.file).state.projects.find(p => p.id === f.project.id).initiative.reviewMaxMs, preset.reviewMaxMs);
  }
  for (const patch of [{ initiative: { reviewMinMs: 0 } }, { initiative: { reviewMinMs: 20000, reviewMaxMs: 10000 } }, { initiative: { cooldownMs: 1.5 } }, { evolution: { minIntervalMs: 604800001 } }]) assert.throws(() => f.store.updateProject(f.project.id, patch));
  const legacy = { initiative: { cooldownMs: 6000 }, evolution: { lastEvaluatedAt: '2026-01-01T00:00:00.000Z' } }; normalizeProjectSchedule(legacy); assert.equal(legacy.initiative.cooldownMs, 6000); assert.equal(legacy.evolution.lastAutonomousStartedAt, null); assert.equal(legacy.evolution.lastEvaluatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(makeProject({ evolution: { minIntervalMs: 0 } }).evolution.minIntervalMs, 0); assert.equal(PROJECT_SCHEDULE_DEFAULTS.reviewMinMs, 30000);
});
test('changing project cadence updates an existing coordinator wake and restart uses the persisted anchor without a model call', async t => {
  const f = await fixture(t), controller = f.create(); await until(() => f.calls.length === 1 && !controller.contexts.get(f.project.id)?.reviewPromise);
  const context = controller.contexts.get(f.project.id), anchor = context.coordinator.snapshot().reviewSchedule.at;
  f.clock(11000); f.store.updateProject(f.project.id, { initiative: { reviewMinMs: 120000, reviewMaxMs: 600000 } }); await until(() => context.coordinator.policy.reviewMinMs === 120000);
  assert.ok(context.coordinator.snapshot().nextReviewAt >= anchor + 120000); assert.equal(f.calls.length, 1);
  f.store.updateProject(f.project.id, { initiative: { reviewMinMs: 15000, reviewMaxMs: 15000 } }); await until(() => context.coordinator.snapshot().nextReviewAt === anchor + 15000);
  await controller.close(); const reopened = f.create(); await until(() => reopened.contexts.has(f.project.id)); assert.equal(reopened.contexts.get(f.project.id).coordinator.snapshot().nextReviewAt, anchor + 15000); assert.equal(f.calls.length, 1);
  f.clock(anchor + 15000); await reopened.pump(); await until(() => f.calls.length === 2);
});
test('autonomous interval is based only on admitted automatic attempts; fresh evidence and interval edits retain their own gates', async t => {
  const f = await fixture(t); let evolves = 0;
  const controller = f.create({ initialDelayMs: 86400000, evolutionService: { async evolve() { evolves++; return { status: 'rejected', summary: 'Isolated fixture evaluation did not improve', usage: { totalTokens: 0 } }; } } });
  await until(() => controller.contexts.has(f.project.id)); const context = controller.contexts.get(f.project.id), signal = new AbortController().signal;
  const action = id => ({ id, action: 'learn', evidenceIds: [id], content: 'Evaluate new evidence', revision: context.coordinator.state.revision });
  const run = id => controller.learn(context, action(id), { signal, evidence: [{ id, type: 'note', summary: 'New external evidence' }], tokenBudget: null });
  assert.equal((await run('first')).summary, 'Isolated fixture evaluation did not improve'); assert.equal(evolves, 1); const started = f.current().evolution.lastAutonomousStartedAt; assert.equal(Date.parse(started), 1000);
  f.clock(2000); assert.equal((await run('second')).reason, 'learning_interval'); assert.equal(evolves, 1); assert.equal(f.current().jobs.length, 1);
  f.store.updateProject(f.project.id, { evolution: { minIntervalMs: 1000 } }); await until(() => context.coordinator.policy.learnNotBefore === 2000); await run('second'); assert.equal(evolves, 2);
  const lastStart = f.current().evolution.lastAutonomousStartedAt;
  // Manual evaluations use the separate evolution service; their completion
  // timestamp is not an autonomous-start clock and must not move that gate.
  f.store.mutate(state => { state.projects.find(p => p.id === f.project.id).evolution.lastEvaluatedAt = new Date(9000000).toISOString(); });
  assert.equal(f.current().evolution.lastAutonomousStartedAt, lastStart);
  const noEvidence = await controller.learn(context, action('empty'), { signal, evidence: [], tokenBudget: null }); assert.equal(noEvidence.reason, 'learning_requires_new_evidence'); assert.equal(evolves, 2);
  const reopened = new Store(f.store.file).state.projects.find(p => p.id === f.project.id); assert.equal(reopened.evolution.lastAutonomousStartedAt, lastStart);
});
test('a plan conversation caps background tools at read without editing grants; leaving all plans restores saved scope', async t => {
  const f = await fixture(t); f.store.mutate(state => applyProjectPermissions(state, f.project.id, { workspace: 'execute', background: 'inherit' })); f.store.updateSession(f.session.id, { mode: 'plan' });
  let calls = 0;
  const controller = f.create({ initialDelayMs: 86400000, runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* (request) { calls++; assert.ok(['project_write', 'project_exec'].every(name => request.tools.some(tool => tool.name === name)), 'declared; the plan cap is enforced at execution'); assert.match(JSON.stringify(request.messages), /readOnly\W+true/); yield { type: 'text_delta', delta: 'Read-only plan analysis' }; yield { type: 'usage', usage: { totalTokens: 0 } }; yield { type: 'done' }; } }) });
  await until(() => controller.contexts.has(f.project.id)); const context = controller.contexts.get(f.project.id), grants = structuredClone(f.current().permissions), scope = context.scope;
  assert.equal(controller.snapshot(f.current()).actionContracts.work.permissions.effective.background, 'read'); assert.match(controller.snapshot(f.current()).actionContracts.work.effects, /plan mode/);
  await controller.work(context, { id: 'planning', action: 'work', content: 'Inspect', evidenceIds: [], revision: context.coordinator.state.revision }, { signal: new AbortController().signal, evidence: [], tokenBudget: null });
  assert.equal(calls, 1); assert.deepEqual(f.current().permissions, grants);
  // Plan mode is enforced live (backgroundProject); toggling it is not a scope change (PDL-1).
  f.store.updateSession(f.session.id, { mode: 'build' }); assert.equal(controller.scope(f.current(), controller.model(f.current())), scope); assert.equal(controller.valid(context), true); assert.equal(controller.snapshot(f.current()).actionContracts.work.permissions.effective.background, 'execute'); assert.deepEqual(f.current().permissions, grants);
});
test('explicit manual candidate evaluation runs during an autonomous interval and does not move the automatic clock', async t => {
  const f = await fixture(t), genome = projectGenomeFixture(), calls = [];
  const prepared = await new ProjectGenomeStore(f.store).prepare(f.current(), { genome, versionId: f.current().activeVersionId }); await prepared.commit();
  const lastStart = new Date().toISOString();
  f.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.versions.find(row => row.id === project.activeVersionId).bundle = prepared.record; project.evolution.minIntervalMs = 604800000; project.evolution.lastAutonomousStartedAt = lastStart; });
  const service = new ProjectEvolutionService(f.store, { provider: genomeEvaluationProvider({ calls }) }); t.after(() => service.close());
  const result = await service.evolve(f.project.id, { model, genome: projectGenomeFixture({ candidate: true }), evidence: [{ id: 'manual-evidence', type: 'note', summary: 'Explicitly requested candidate evaluation' }] });
  assert.ok(['ready', 'rejected'].includes(result.status), JSON.stringify(result)); assert.ok(calls.length > 0); assert.equal(f.current().evolution.lastAutonomousStartedAt, lastStart); assert.equal(f.current().evolution.minIntervalMs, 604800000);
});
test('switching a conversation to plan before a returned tool batch prevents background writes immediately', async t => {
  const f = await fixture(t); f.store.mutate(state => applyProjectPermissions(state, f.project.id, { workspace: 'execute', background: 'inherit' }));
  let calls = 0;
  const controller = f.create({ initialDelayMs: 86400000, runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* () {
    if (++calls === 1) { f.store.updateSession(f.session.id, { mode: 'plan' }); yield { type: 'tool_call', id: 'forbidden-write', name: 'project_write', arguments: { path: 'must-not-exist.txt', content: 'not authorized in plan' } }; yield { type: 'done', stopReason: 'toolUse' }; }
    else { yield { type: 'text_delta', delta: 'Plan acknowledged' }; yield { type: 'done' }; }
  } }) });
  await until(() => controller.contexts.has(f.project.id)); const context = controller.contexts.get(f.project.id);
  await controller.work(context, { id: 'switch-plan', action: 'work', content: 'Inspect', evidenceIds: [], revision: context.coordinator.state.revision }, { signal: new AbortController().signal, evidence: [], tokenBudget: null });
  assert.equal(existsSync(join(f.dir, 'must-not-exist.txt')), false); assert.equal(f.current().permissions.workspace, 'execute'); assert.equal(f.current().permissions.background, 'inherit');
  const job = f.current().jobs.find(job => job.id === 'switch-plan'); if (job.runtimeFile) assert.ok(!readFileSync(job.runtimeFile, 'utf8').includes('"requiresResolution":true'));
});
