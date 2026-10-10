import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { RuntimeController } from '../runtime-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';

async function until(check, timeout = 8000) { const deadline = Date.now() + timeout; while (!check()) { if (Date.now() > deadline) throw new Error('condition did not settle'); await delay(10); } }
function fixture(t, { autoModel = true, tier = 'fast', fastWindow = 64000, fastInput } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-auto-model-')), store = new Store(join(directory, 'state.json'));
  const main = store.configurationService.provider(null, { name: 'Main', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'main-provider-key', models: [{ id: 'main-model', contextWindow: 128000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  const fast = store.configurationService.provider(null, { name: 'Fast', protocol: 'openai', baseUrl: 'http://127.0.0.1:2/v1', apiKey: 'fast-provider-key', models: [{ id: 'fast-model', contextWindow: fastWindow, maxOutputTokens: 500, reasoning: ['off'], ...(fastInput ? { input: fastInput } : {}) }] });
  store.configurationService.update({ defaultModel: { providerId: main.id, modelId: 'main-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { session } = store.createProject({ name: 'Auto model', workspace: directory, initiative: { enabled: false } });
  const routes = [], requests = [], verdict = { value: tier };
  const decisions = { routePoint: () => 'turn.route', enabled: () => true, chat: async () => null,
    config: () => ({ mode: 'active', modes: { 'turn.route': 'active' }, autoModel, fastModel: { providerId: fast.id, modelId: 'fast-model' } }),
    route: async input => { routes.push(input); return { ledgerId: `ledger-${routes.length}`, source: 'jev', point: 'turn.route', backend: 'typesafe', skills: [], ...(verdict.value ? { modelTier: verdict.value } : {}) }; } };
  const runtime = new RuntimeController(store, { decisionService: decisions, factory: options => createRnaRuntime({ ...options, provider: async function* (request) {
    requests.push({ model: request.model.modelId, apiKey: request.apiKey });
    yield { type: 'text_delta', delta: `from ${request.model.modelId}` }; yield { type: 'usage', usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25, cacheUsageReported: true } }; yield { type: 'done', stopReason: 'stop' };
  } }) });
  t.after(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  const current = () => store.state.sessions.find(row => row.id === session.id);
  const send = async text => { store.message(session.id, { text }); const count = current().turns.length; await until(() => current().turns[count - 1]?.status === 'completed' && !runtime.running.size); return current().turns[count - 1]; };
  return { store, main, fast, session, routes, requests, verdict, current, send };
}
const journalRecords = file => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('a simple turn runs on the fast model when 自动选择模型 is on, then returns to the user model in the same journal', async t => {
  const f = fixture(t);
  const first = await f.send('What is 2 + 2?');
  assert.deepEqual(f.requests[0], { model: 'fast-model', apiKey: 'fast-provider-key' });
  assert.equal(first.modelConfig.modelId, 'fast-model'); assert.equal(first.model, 'Fast · fast-model');
  assert.deepEqual(first.modelConfig.modelDecision, { requested: { providerId: f.main.id, modelId: 'main-model', auto: true }, effective: { providerId: f.fast.id, modelId: 'fast-model', tier: 'fast' }, source: 'jev', reason: 'route_fast', latencyMs: first.modelConfig.modelDecision.latencyMs, ledgerId: 'ledger-1' });
  assert.equal(f.current().modelSelection.modelId, 'main-model', 'the user selection is unchanged');
  assert.equal(f.routes.length, 1, 'the tier rides the turn.route fan-out even without reasoning/memory questions');
  f.verdict.value = 'main';
  const second = await f.send('Now refactor the module and explain the design.');
  assert.equal(f.requests.at(-1).model, 'main-model'); assert.equal(second.modelConfig.modelId, 'main-model');
  assert.equal(second.modelConfig.modelDecision.source, 'fallback'); assert.equal(second.modelConfig.modelDecision.reason, 'route_main');
  const changes = journalRecords(f.current().runtime.sessionFile).filter(row => row.type === 'model_change').map(row => [row.data.to.modelId, row.data.reason]);
  assert.deepEqual(changes, [['fast-model', 'auto_fast_model'], ['main-model', 'session_model']], 'one session journal records both switches');
  assert.equal(readFileSync(f.current().runtime.sessionFile, 'utf8').includes('fast-provider-key'), false);
});

test('auto model off: no extra judgment, the user model runs and the decision says so', async t => {
  const f = fixture(t, { autoModel: false });
  const turn = await f.send('hello');
  assert.equal(f.routes.length, 0); assert.equal(f.requests[0].model, 'main-model');
  assert.deepEqual(turn.modelConfig.modelDecision, { requested: { providerId: f.main.id, modelId: 'main-model', auto: false }, effective: { providerId: f.main.id, modelId: 'main-model' }, source: 'user' });
});

test('the fast model must fit the current context; an uncertain verdict keeps the user model', async t => {
  const small = fixture(t, { fastWindow: 1200 });
  const turn = await small.send('hello');
  assert.equal(small.requests[0].model, 'main-model'); assert.equal(turn.modelConfig.modelDecision.reason, 'fast_model_context');
  const unsure = fixture(t, { tier: null });
  const kept = await unsure.send('hello');
  assert.equal(unsure.requests[0].model, 'main-model'); assert.equal(kept.modelConfig.modelDecision.reason, 'route_uncertain');
});

test('the 自动选择模型 setting is a boolean on the judgment settings, off by default', async t => {
  const { DecisionService } = await import('../decision-service.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'rna-auto-model-setting-')), store = new Store(join(directory, 'state.json')), service = new DecisionService(store);
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(service.config().autoModel, false); assert.equal(service.public().autoModel, false);
  assert.equal(service.update({ autoModel: true }).autoModel, true); assert.equal(store.state.configuration.decisionKernel.autoModel, true);
  assert.throws(() => service.update({ autoModel: 'yes' }), /配置无效/);
});
