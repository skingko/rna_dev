import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { RuntimeController } from '../runtime-controller.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { ProjectLearningController } from '../project-learning-controller.mjs';
import { ProjectEvolutionController } from '../project-evolution-controller.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { projectGenomeFixture } from '../../../packages/sdk/test/fixtures/project-genome.mjs';
import { createProjectSchedule } from '../../../packages/sdk/src/project-schedules.mjs';

async function until(check, timeout = 5000) { const deadline = Date.now() + timeout; while (!check()) { if (Date.now() >= deadline) throw new Error('Fixture did not settle'); await delay(5); } }
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-interactive-policy-')), store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { presetId: 'kimi-coding', apiKey: 'isolated-fixture-key' });
  const selection = { providerId: provider.id, modelId: 'k3-256k', reasoning: 'high' };
  store.configurationService.update({ defaultModel: selection, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ name: 'Interactive subscription isolation', workspace: directory, rhythm: { control: 'manual' }, initiative: { cooldownMs: 0 } });
  const prepared = await new ProjectGenomeStore(store).prepare(project, { genome: projectGenomeFixture(), versionId: project.activeVersionId }); await prepared.commit();
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); Object.assign(p, { decisionMode: 'rna-model', simulated: false, initialization: { status: 'ready' } }); p.versions[0].bundle = prepared.record; p.initiative.tokenBudget = null; p.evolution.minIntervalMs = 0; state.settings.realTokenBudget = null; });
  const controllers = [], current = () => store.state.projects.find(row => row.id === project.id), conversation = () => store.state.sessions.find(row => row.id === session.id);
  const evolutionService = { running: new Map(), evolve: async () => { throw Error('Interactive-only background execution escaped its admission gate'); } };
  t.after(async () => { for (const controller of controllers) await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, project, session, provider, selection, current, conversation, controllers, evolutionService };
}

test('Kimi coding foreground requests run through the real controller/session without a background-policy rejection', async t => {
  const f = await fixture(t), calls = [];
  const runtime = new RuntimeController(f.store, { factory: options => createRnaRuntime({ ...options, provider: async function* (request) { calls.push(request); yield { type: 'text_delta', delta: 'Foreground fixture answer' }; yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: 'stop' }; } }) }); f.controllers.push(runtime);
  f.store.message(f.session.id, { text: 'Explain this project in one sentence' });
  await until(() => ['completed', 'failed'].includes(f.conversation().turns[0]?.status));
  assert.equal(f.conversation().turns[0].status, 'completed'); assert.equal(calls.length, 1);
  assert.equal(f.conversation().items.findLast(row => row.kind === 'assistant').text, 'Foreground fixture answer');
});

test('initiative and a due schedule cannot dispatch a Kimi coding background model', async t => {
  const f = await fixture(t), origin = Date.parse('2026-09-26T00:00:00Z'); let decisions = 0, workers = 0;
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).schedules = [createProjectSchedule({ id: 'fixture-daily', title: 'Daily research', task: 'Produce the due fixture report', destinationSessionId: f.session.id, rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }, { now: origin })]; });
  const controller = new ProjectInitiativeController(f.store, { tickIntervalMs: 0, initialDelayMs: 0, now: () => origin + 3600000, decisionProvider: async function* () { decisions++; }, runtimeFactory: () => { workers++; throw Error('Unexpected background worker'); } }); f.controllers.push(controller);
  assert.throws(() => controller.model(f.current()), { code: 'interactive_subscription_only' });
  await controller.pump(); await new Promise(resolve => setImmediate(resolve)); await controller.pump();
  assert.equal(decisions, 0); assert.equal(workers, 0); assert.equal(controller.contexts.size, 0); assert.equal(f.store.state.realUsage.reservedTokens, 0);
  assert.equal(f.conversation().items.some(row => row.source === 'initiative'), false);
});

test('learning refuses Kimi coding before reflection, candidate creation or budget reservation', async t => {
  const f = await fixture(t); let reflections = 0;
  f.store.mutate(state => { const s = state.sessions.find(row => row.id === f.session.id); s.turns.push({ id: 'completed-experience', status: 'completed', createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), modelConfig: { execution: 'rna' } }); s.items.push({ id: 'request', kind: 'user', turnId: 'completed-experience', text: 'Inspect both boundary variants' }, { id: 'answer', kind: 'assistant', turnId: 'completed-experience', text: 'One variant inspected', simulated: false }); });
  const controller = new ProjectLearningController(f.store, { evolutionService: f.evolutionService, tickIntervalMs: 0, initialDelayMs: 0, minReviewMs: 0, reflect: async () => { reflections++; throw Error('Unexpected reflection'); } }); f.controllers.push(controller);
  assert.throws(() => controller.model(f.current()), { code: 'interactive_subscription_only' }); await controller.pump(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reflections, 0); assert.equal(controller.contexts.size, 0); assert.equal(f.store.state.realUsage.reservedTokens, 0); assert.equal(f.current().versions.length, 1);
});

test('manual evolution rejects Kimi coding before paid evaluation and preserves its current baseline', async t => {
  const f = await fixture(t), controller = new ProjectEvolutionController(f.store, { service: f.evolutionService }); f.controllers.push(controller);
  const before = JSON.stringify(f.current().versions);
  assert.throws(() => controller.start(f.project.id, { summary: 'Try an independent candidate' }), error => error.status === 409 && /交互式/.test(error.message));
  assert.equal(controller.operations.size, 0); assert.equal(f.store.state.realUsage.reservedTokens, 0); assert.equal(JSON.stringify(f.current().versions), before);
});

test('a separately chosen Kimi open-platform API can serve background work without changing the foreground subscription', async t => {
  const f = await fixture(t), api = f.store.configurationService.provider(null, { presetId: 'kimi-cn', apiKey: 'isolated-platform-key' });
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).initiative.modelSelection = { providerId: api.id, modelId: 'kimi-k3' }; });
  const controller = new ProjectInitiativeController(f.store, { tickIntervalMs: 0, initialDelayMs: 86400000 }); f.controllers.push(controller);
  const model = controller.model(f.current()); assert.equal(model.providerId, api.id); assert.notEqual(model.usagePolicy, 'interactive_only');
  assert.deepEqual(f.store.state.configuration.defaultModel, f.selection);
});
