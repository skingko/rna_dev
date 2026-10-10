import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { resolveModel, initialConfiguration } from '../configuration.mjs';
import { providerPresets, providerPreset } from '../provider-presets.mjs';
import { normalizeDiscoveredModel } from '../provider-discovery.mjs';
import { resolveReasoningCapability, validateReasoningSelection, migrateReasoningSelections, legacyReasoning, discoveredReasoning } from '../reasoning-capability.mjs';
import { ruleReasoning, stepEffort, withBudget } from '../reasoning-routing.mjs';
import { reasoningRoute } from '../reasoning-api.mjs';
import { DecisionService } from '../decision-service.mjs';
import { RuntimeController } from '../runtime-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { createDecisionKernel } from '../../../packages/sdk/src/decision-kernel.mjs';

async function until(check, label = 'condition', timeout = 8000) { const deadline = Date.now() + timeout; while (!check()) { if (Date.now() > deadline) throw Error(`Timeout: ${label}`); await delay(5); } }
const ids = capability => capability.efforts.map(effort => effort.id);

test('every preset model declares a sourced capability consistent with its legacy reasoning list', () => {
  const expected = {
    'deepseek-v4-pro': ['effort', 'high,max', true, 'high', 'full'], 'deepseek-flash': ['effort', 'high,max', true, 'high', 'full'],
    'gpt-5.4': ['effort', 'low,medium,high,xhigh', true, null, 'hidden'], 'gpt-4.1-mini': ['none', '', true, null, 'hidden'],
    'claude-opus-5-5': ['adaptive', 'low,medium,high,xhigh,max', false, 'medium', 'summary'], 'claude-sonnet-5': ['adaptive', 'low,medium,high,xhigh,max', false, 'high', 'summary'],
    'claude-haiku-4-5-20251001': ['budget', 'low,medium,high', true, null, 'summary'], 'gemini-2.5-flash': ['effort', 'low,medium,high', false, null, 'hidden'],
    'llama-3.3-70b-versatile': ['none', '', true, null, 'hidden'], 'openai/gpt-4.1-mini': ['none', '', true, null, 'hidden'],
    'qwen3.8-max': ['toggle', 'high', true, null, 'full'], 'qwen3.8-flash': ['toggle', 'high', true, null, 'full'],
    'kimi-k3': ['effort', 'low,high,max', false, null, 'full'], 'k3-256k': ['effort', 'low,high,max', false, null, 'full'], 'kimi-for-coding': ['effort', 'low,high,max', false, null, 'full'],
    'glm-5.3': ['effort', 'low,high,max', false, null, 'full'], 'glm-5.3-flash': ['effort', 'low,high,max', false, null, 'full'], 'glm-5.3-flashx': ['effort', 'low,high,max', false, null, 'full'],
    'mimo-v2.6-pro': ['toggle', 'high', true, null, 'full'], 'mimo-v2.6-flash': ['toggle', 'high', true, null, 'full'],
  };
  let checked = 0;
  for (const preset of providerPresets()) for (const model of preset.models) {
    const capability = model.reasoningCapability, row = expected[model.id];
    assert.ok(row, `missing expectation for ${model.id}`);
    assert.deepEqual([capability.control, ids(capability).join(','), capability.canDisable, capability.providerDefault, capability.visibility, capability.source], [...row, 'preset'], model.id);
    assert.deepEqual(model.reasoning, legacyReasoning(capability)); assert.ok(model.source.url); checked++;
  }
  assert.ok(checked >= 27);
  assert.deepEqual(providerPreset('openai').models[0].compat.reasoningEffortMap, { off: 'none' });
  assert.equal(providerPreset('anthropic').models[0].compat.thinkingDisplay, 'summarized');
});

test('protocol inference and discovery evidence outrank nothing they should not', () => {
  const custom = { protocol: 'openai', baseUrl: 'https://llm.example/v1' };
  assert.deepEqual(resolveReasoningCapability(custom, { id: 'x', reasoning: ['off'] }), { canDisable: true, providerDefault: null, source: 'protocol', control: 'none', efforts: [], visibility: 'hidden' });
  const glmProxy = resolveReasoningCapability({ ...custom }, { id: 'glm-5.3', reasoning: ['max', 'high', 'low'], compat: { thinkingFormat: 'zai' } });
  assert.deepEqual([glmProxy.control, ids(glmProxy), glmProxy.canDisable, glmProxy.visibility, glmProxy.source], ['effort', ['low', 'high', 'max'], false, 'full', 'protocol']);
  const anthropic = resolveReasoningCapability({ protocol: 'anthropic', baseUrl: 'https://proxy.example' }, { id: 'c', reasoning: ['off', 'low', 'high'], compat: { adaptiveThinking: true } });
  assert.deepEqual([anthropic.control, anthropic.canDisable, anthropic.visibility], ['adaptive', true, 'summary']);
  assert.equal(resolveReasoningCapability({ protocol: 'openai', baseUrl: 'https://llm.example/v1' }, { id: 'q', reasoning: ['high', 'off'], compat: { thinkingFormat: 'qwen' } }).control, 'toggle');
  const found = discoveredReasoning({ supported_reasoning_levels: [{ effort: 'high' }, { effort: 'low' }, 'none', 'bogus'], default_reasoning_level: 'low' });
  assert.deepEqual(found, { efforts: ['low', 'high'], canDisable: true, providerDefault: 'low' });
  const row = normalizeDiscoveredModel(custom, { id: 'router/model', context_length: 64000, max_output_tokens: 8000, supported_parameters: ['tools'], supported_reasoning_levels: ['minimal', 'medium'], default_reasoning_level: 'medium' }, { checkedAt: '2026-09-28T00:00:00Z' });
  assert.deepEqual(row.reasoning, ['minimal', 'medium']); assert.equal(row.reasoningDiscovery.providerDefault, 'medium');
  const capability = resolveReasoningCapability(custom, { id: 'router/model', reasoning: row.reasoning, reasoningDiscovery: row.reasoningDiscovery });
  assert.deepEqual([capability.source, ids(capability), capability.providerDefault, capability.canDisable], ['discovery', ['minimal', 'medium'], 'medium', false]);
});

test('selection values are auto, default, off only when disable is supported, or a supported effort', () => {
  const glm = providerPreset('glm').models[0].reasoningCapability, haiku = providerPreset('anthropic').models[2].reasoningCapability;
  assert.equal(validateReasoningSelection(glm, undefined), 'auto');
  for (const value of ['auto', 'default', 'low', 'max']) assert.equal(validateReasoningSelection(glm, value), value);
  assert.throws(() => validateReasoningSelection(glm, 'off'), /不能关闭思考/); assert.throws(() => validateReasoningSelection(glm, 'medium'), error => error.status === 400);
  assert.equal(validateReasoningSelection(haiku, 'off'), 'off');
});

function storeFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-reasoning-')), store = new Store(join(directory, 'state.json'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, store };
}

test('resolution no longer materializes the first listed level; public view exposes the capability', t => {
  const { store } = storeFixture(t);
  assert.equal(store.state.configuration.defaultModel.reasoning, 'auto');
  const glm = store.configurationService.provider(null, { presetId: 'glm', apiKey: 'fixture-key-glm' });
  const auto = resolveModel(store.state.configuration, { providerId: glm.id, modelId: 'glm-5.3' });
  assert.deepEqual([auto.reasoning, auto.reasoningSelection, auto.reasoningCapability.control], ['default', 'auto', 'effort']);
  const pinned = resolveModel(store.state.configuration, { providerId: glm.id, modelId: 'glm-5.3', reasoning: 'high' });
  assert.deepEqual([pinned.reasoning, pinned.reasoningSelection], ['high', 'high']);
  assert.throws(() => resolveModel(store.state.configuration, { providerId: glm.id, modelId: 'glm-5.3', reasoning: 'off' }), error => error.status === 400);
  const view = store.configurationService.public().providers.find(row => row.id === glm.id).models.find(row => row.id === 'glm-5.3');
  assert.deepEqual(view.reasoning, ['low', 'high', 'max']); assert.equal(view.reasoningCapability.source, 'preset');
  const session = store.createSession({ modelSelection: { providerId: glm.id, modelId: 'glm-5.3' } });
  assert.equal(session.modelSelection.reasoning, 'auto'); assert.equal(session.modelConfig.reasoning, 'default');
  store.updateSession(session.id, { modelSelection: { providerId: glm.id, modelId: 'glm-5.3', reasoning: 'default' } });
  assert.equal(store.state.sessions.find(row => row.id === session.id).modelSelection.reasoning, 'default');
});

test('migration moves defaultModel and never-chosen sessions/projects to auto and keeps explicit choices', () => {
  const state = { configuration: { ...initialConfiguration(), providers: [{ id: 'g', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: [{ id: 'glm-5.3', reasoning: ['max', 'high', 'low'] }] }], defaultModel: { providerId: 'g', modelId: 'glm-5.3', reasoning: 'high' } },
    sessions: [{ modelSelection: { providerId: 'g', modelId: 'glm-5.3', reasoning: 'max' }, modelConfig: { reasoning: 'max' } }, { modelSelection: { providerId: 'g', modelId: 'glm-5.3', reasoning: 'low' } }, { modelSelection: { providerId: 'g', modelId: 'glm-5.3', reasoning: 'medium' } }],
    projects: [{ initiative: { modelSelection: { providerId: 'g', modelId: 'glm-5.3' } } }, { initiative: {} }] };
  delete state.configuration.reasoningSelectionVersion;
  assert.equal(migrateReasoningSelections(state), true);
  assert.equal(state.configuration.defaultModel.reasoning, 'auto');
  assert.deepEqual(state.sessions.map(row => row.modelSelection.reasoning), ['auto', 'low', 'auto']);
  assert.deepEqual(state.sessions[0].modelConfig, { reasoning: 'default', reasoningSelection: 'auto' });
  assert.equal(state.projects[0].initiative.modelSelection.reasoning, 'auto');
  state.sessions[1].modelSelection.reasoning = 'max'; assert.equal(migrateReasoningSelections(state), false); assert.equal(state.sessions[1].modelSelection.reasoning, 'max');
});

test('zero-latency rules: careful request, retry after failure, plan mode and trivial greeting', () => {
  const capability = { control: 'effort', efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }], canDisable: false, providerDefault: 'medium' };
  assert.equal(ruleReasoning({ capability, prompt: '请仔细想想这个并发问题' }).effective, 'high');
  assert.equal(ruleReasoning({ capability, prompt: 'Please think carefully about the migration.' }).effective, 'high');
  assert.equal(ruleReasoning({ capability, prompt: 'again', previousTurn: { status: 'failed', modelConfig: { reasoning: 'high' } } }).effective, 'xhigh');
  assert.equal(ruleReasoning({ capability, prompt: 'again', previousTurn: { status: 'failed', modelConfig: { reasoning: 'default' } } }).effective, 'high');
  assert.equal(ruleReasoning({ capability, mode: 'plan', prompt: 'plan the refactor' }).effective, 'high');
  assert.equal(ruleReasoning({ capability, prompt: '你好！' }).effective, 'low'); assert.equal(ruleReasoning({ capability, prompt: 'thanks' }).effective, 'low');
  assert.equal(ruleReasoning({ capability, prompt: 'Refactor the scheduler to use a heap' }), null);
  assert.equal(ruleReasoning({ capability: { efforts: [{ id: 'high' }] }, prompt: '你好' }), null, 'single-level models are never routed');
  assert.equal(stepEffort(capability, 'xhigh', 1), 'xhigh');
});

test('budget helper resolves the fallback on timeout and on rejection', async () => {
  const started = Date.now();
  assert.equal(await withBudget(new Promise(() => {}), 40, 'late'), 'late'); assert.ok(Date.now() - started < 400);
  assert.equal(await withBudget(Promise.reject(new Error('x')), 40, null), null); assert.equal(await withBudget(Promise.resolve(3), 40), 3);
});

test('GET /api/v2/models/:providerId/:modelId/reasoning returns capability and auto availability', t => {
  const { store } = storeFixture(t), provider = store.configurationService.provider(null, { presetId: 'openrouter', apiKey: 'fixture-key-openrouter' });
  const decisions = new DecisionService(store); t.after(() => decisions.close());
  const found = reasoningRoute({ method: 'GET', pathname: `/api/v2/models/${provider.id}/${encodeURIComponent('openai/gpt-4.1-mini')}/reasoning`, store, decisions });
  assert.equal(found.status, 200); assert.equal(found.body.capability.control, 'none'); assert.deepEqual(found.body.auto, { available: false, backend: null });
  decisions.update({ apiKey: 'fixture-jev-key', mode: 'active', modes: { 'chat.route': 'active' } });
  assert.deepEqual(reasoningRoute({ method: 'GET', pathname: `/api/v2/models/${provider.id}/${encodeURIComponent('openai/gpt-4.1-mini')}/reasoning`, store, decisions }).body.auto, { available: true, backend: 'typesafe' });
  assert.equal(reasoningRoute({ method: 'GET', pathname: `/api/v2/models/${provider.id}/missing/reasoning`, store, decisions }).status, 404);
  assert.equal(reasoningRoute({ method: 'POST', pathname: `/api/v2/models/${provider.id}/x/reasoning`, store, decisions }), null);
});

test('decision settings: backend selection, llm judge model validation, chat.route opt-in, label backfill', t => {
  const { store } = storeFixture(t), service = new DecisionService(store); t.after(() => service.close());
  const provider = store.configurationService.provider(null, { name: 'Local judge', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fast', contextWindow: 32000, maxOutputTokens: 2048, reasoning: ['off'] }] });
  store.mutate(state => { state.configuration.decisionKernel = { mode: 'active' }; }); service.update({ apiKey: 'fixture-jev-key' });
  assert.equal(service.config().modes['chat.route'], 'off', 'a global mode does not silently enable routing'); assert.equal(service.config().modes['chat.preflight'], 'active'); assert.equal(service.config().backend, 'typesafe');
  assert.throws(() => service.update({ backend: 'llm' }), error => error.code === 'invalid_decision_configuration');
  assert.throws(() => service.update({ backend: 'llm', llmModel: { providerId: 'demo', modelId: 'demo' } }), error => error.code === 'invalid_decision_configuration');
  const view = service.update({ backend: 'llm', llmModel: { providerId: provider.id, modelId: 'fast' }, modes: { 'chat.route': 'active' } });
  assert.deepEqual([view.backend, view.provider, view.model, view.status, view.route.available, view.route.backend], ['llm', 'llm', 'fast', 'ready', true, 'llm']);
  assert.equal(service.update({ backend: 'off' }).status, 'off'); assert.equal(service.enabled('chat.route'), false);
  store.mutate(state => { state.decisionKernelRuntime = { metrics: { requests: 0 }, recent: [{ id: 'row-1', at: Date.now(), point: 'chat.route', scope: { sessionId: 'x' } }] }; });
  assert.equal(service.labelDecision('row-1', 'user_corrected'), true); assert.equal(store.decisionLedger.get('row-1').label.value, 'user_corrected'); assert.deepEqual(store.state.decisionKernelRuntime.recent, [], 'the row moved out of state when it was labeled');
  assert.equal(service.labelDecision('missing', 'failed'), false); assert.throws(() => service.labelDecision('row-1', 'Free form <text>'), error => error.status === 400);
});

function runtimeFixture(t, { judge, modes = { 'chat.route': 'active' }, autoRecall = true } = {}) {
  const { directory, store } = storeFixture(t);
  const provider = store.configurationService.provider(null, { name: 'Routing fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 4096, reasoning: ['low', 'medium', 'high', 'off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture' }, memory: { autoRecall, autoStore: false } });
  const { project, session } = store.createProject({ name: 'Routing project', description: 'Route reasoning per turn', workspace: directory, rhythm: { control: 'manual' } });
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); Object.assign(p, { decisionMode: 'rna-model', simulated: false, initialization: { status: 'ready' }, assignments: { skillIds: [], toolIds: ['project_read', 'openviking_search', 'openviking_read'], mcpServerIds: [] } }); state.settings.realTokenBudget = null; });
  writeFileSync(join(directory, 'main.js'), 'export {};');
  let recalls = 0; store.memoryService.recall = async () => { recalls++; return { entries: [], content: '', estimatedTokens: 0, candidateCount: 0, stage: 'summaries' }; };
  // Turn-start routing is under test; the turn-end judgment (turn.settled) is not counted here.
  const judgments = [], service = new DecisionService(store, { kernelFactory: options => createDecisionKernel({ ...options, fetch: async (_url, init) => { const body = JSON.parse(init.body); if (!Object.hasOwn(body.questions ?? {}, 'instruction_complete')) judgments.push(body); return judge(body); } }) });
  if (judge) service.update({ apiKey: 'fixture-jev-key', mode: 'active', modes });
  const requests = [], controller = new RuntimeController(store, { decisionService: service, factory: options => createRnaRuntime({ ...options, provider: async function* (request) { requests.push(request); yield { type: 'text_delta', delta: 'ok' }; yield { type: 'done', stopReason: 'stop' }; } }) });
  t.after(async () => { await controller.close(); await service.close(); });
  const conversation = () => store.state.sessions.find(row => row.id === session.id);
  const send = async text => { const count = conversation().turns.length; store.message(session.id, { text }); await until(() => conversation().turns[count]?.status === 'completed', `turn ${count} completes`); return conversation().turns[count]; };
  return { store, service, session, requests, judgments, send, conversation, recalls: () => recalls };
}
const answer = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('auto without a decision backend: rules first, otherwise the provider default, recorded per contract', async t => {
  const f = runtimeFixture(t);
  const first = await f.send('Refactor the scheduler to use a heap');
  assert.deepEqual(first.modelConfig.reasoningDecision, { requested: 'auto', effective: 'default', source: 'provider-default', rationale: '未启用自动判断，使用供应商默认', latencyMs: null });
  assert.equal(first.modelConfig.reasoning, 'default'); assert.equal(f.requests[0].model.reasoning, 'default');
  const greeting = await f.send('你好');
  assert.deepEqual([greeting.modelConfig.reasoning, greeting.modelConfig.reasoningDecision.source, greeting.modelConfig.reasoningDecision.latencyMs], ['low', 'rule', 0]); assert.equal(f.requests.at(-1).model.reasoning, 'low');
  f.store.updateSession(f.session.id, { modelSelection: { ...f.conversation().modelSelection, reasoning: 'medium' } });
  const pinned = await f.send('Do the thing');
  assert.deepEqual(pinned.modelConfig.reasoningDecision, { requested: 'medium', effective: 'medium', source: 'user', latencyMs: null }); assert.equal(f.requests.at(-1).model.reasoning, 'medium');
});

test('auto with chat.route: JEV picks the effort and memory need in one host-template request', async t => {
  const f = runtimeFixture(t, { judge: () => answer({ answers: { reasoning_effort: { choice: 'high', probabilities: { low: .01, medium: .02, high: .96, unknown: .01 }, confidence: .97 }, memory_need: { noul: .01, confidence: .97 }, skill_code_review: { noul: .96, confidence: .97 }, skill_research: { noul: .02, confidence: .97 } }, usage: { input_tokens: 50, output_tokens: 4 } }) });
  const turn = await f.send('Design a migration plan for the storage layer');
  assert.equal(f.judgments.length, 1); assert.deepEqual(Object.keys(f.judgments[0].questions).sort(), ['memory_need', 'reasoning_effort', 'skill_code_review', 'skill_research']);
  assert.deepEqual(Object.keys(f.judgments[0].questions.reasoning_effort.criteria), ['low', 'medium', 'high', 'unknown']);
  const decision = turn.modelConfig.reasoningDecision;
  assert.deepEqual([decision.requested, decision.effective, decision.source, turn.modelConfig.reasoning, f.requests[0].model.reasoning], ['auto', 'high', 'jev', 'high', 'high']);
  assert.ok(Number.isFinite(decision.latencyMs)); assert.equal(turn.memoryContext.execution, 'not_required'); assert.equal(turn.preflight, undefined, 'chat.route supersedes chat.preflight');
  const row = f.service.ledger().find(row => row.point !== 'turn.settled');
  assert.deepEqual([row.point, row.backend, row.outcome.reasoning, row.outcome.needsMemory, row.source], ['chat.route', 'typesafe', 'high', false, 'judge']); assert.deepEqual(row.outcome.skills, ['code-review']); assert.deepEqual(turn.route.skills, ['code-review']);
  assert.ok(!JSON.stringify(row).includes('storage layer'));
});

test('turn.route at turn start: one fan-out sets effort, skips recall and appends the skill hint at the tail', async t => {
  const pick = (id, question) => question.type === 'noul' ? { type: 'noul', noul: { needs_memory: .02, skill_gate_action: .9, skill_gate_procedure: .9, skill_gate_prose: .05 }[id] ?? .1 }
    : { type: 'choice', choice: id === 'reasoning_effort' ? 'low' : Object.keys(question.criteria).find(key => key.startsWith('skill_code')), probabilities: Object.fromEntries(Object.keys(question.criteria).map((key, index, keys) => [key, (id === 'reasoning_effort' ? key === 'low' : key.startsWith('skill_code')) ? .97 : .03 / (keys.length - 1)])), confidence: .97 };
  const f = runtimeFixture(t, { judge: body => answer({ answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, pick(id, question)])), usage: { input_tokens: 80, output_tokens: 4 } }), modes: { 'turn.route': 'active' } });
  const turn = await f.send('Review the storage module for bugs');
  assert.equal(f.judgments.length, 1, 'one request replaces chat.route + chat.preflight');
  assert.ok(['reasoning_effort', 'needs_memory', 'needs_tools', 'clarify_needed', 'skill_pick', 'skill_gate_action'].every(id => Object.hasOwn(f.judgments[0].questions, id)));
  assert.equal(f.judgments[0].state.turn.message, 'Review the storage module for bugs'); assert.ok(f.judgments[0].state.turn.features.intents.includes('review'));
  const decision = turn.modelConfig.reasoningDecision;
  // A judged level carries no rationale: source 'jev' says where it came from (UX audit F38), never the point or backend.
  assert.deepEqual([decision.effective, decision.source, decision.rationale], ['low', 'jev', undefined]);
  assert.equal(turn.memoryContext.execution, 'not_required'); assert.equal(turn.preflight, undefined);
  assert.deepEqual(turn.route.skills, ['code-review']); assert.equal(turn.route.point, 'turn.route');
  const sent = JSON.stringify(f.requests[0].messages);
  assert.match(sent, /Relevant to the current request: skill/);
  const row = f.service.ledger().find(row => row.point !== 'turn.settled');
  assert.deepEqual([row.point, row.decided, row.applied], ['turn.route', true, true]); assert.ok(!JSON.stringify(row).includes('storage module'));
});

test('chat.route timeout falls back to the provider default within the budget and still recalls memory', async t => {
  const f = runtimeFixture(t, { judge: () => new Promise(() => {}) });
  const started = Date.now(), turn = await f.send('Explain the build pipeline');
  const decision = turn.modelConfig.reasoningDecision;
  assert.deepEqual([decision.effective, decision.source], ['default', 'provider-default']); assert.ok(decision.latencyMs >= 800 && decision.latencyMs < 2500);
  // The routing budget is checked by latencyMs above; the wall clock only proves the turn never waits on the hung
  // judge (which never answers), with room for a busy machine running the suite in parallel.
  assert.equal(f.requests[0].model.reasoning, 'default'); assert.equal(f.recalls(), 1); assert.ok(Date.now() - started < 20000);
});

test('rules short-circuit JEV for reasoning; memory-only routing still runs', async t => {
  const f = runtimeFixture(t, { judge: () => answer({ answers: { memory_need: { noul: .97, confidence: .97 }, skill_code_review: { noul: .5 }, skill_research: { noul: .5 } } }) });
  f.store.updateSession(f.session.id, { mode: 'plan' });
  const turn = await f.send('Plan the refactor');
  assert.deepEqual([turn.modelConfig.reasoning, turn.modelConfig.reasoningDecision.source], ['high', 'rule']);
  assert.deepEqual(Object.keys(f.judgments[0].questions), ['memory_need', 'skill_code_review', 'skill_research']); assert.equal(f.recalls(), 1);
});

test('chat.preflight remains the memory path when chat.route is off', async t => {
  const f = runtimeFixture(t, { judge: () => answer({ answers: {} }), modes: { 'chat.preflight': 'active' } });
  const turn = await f.send('Refactor the scheduler');
  assert.equal(f.judgments.length, 0, 'no judgment plan: preflight falls back without a request');
  assert.equal(turn.preflight.reason, 'assessment_plan_required'); assert.equal(turn.modelConfig.reasoningDecision.source, 'provider-default'); assert.equal(f.recalls(), 1);
});

test('shadow chat.route never delays the first request and keeps chat.preflight as the memory path', async t => {
  const f = runtimeFixture(t, { judge: () => new Promise(() => {}), modes: { 'chat.route': 'shadow' } });
  const turn = await f.send('Refactor the scheduler to use a heap');
  assert.deepEqual([turn.modelConfig.reasoning, turn.modelConfig.reasoningDecision.source], ['default', 'provider-default']);
  assert.match(turn.modelConfig.reasoningDecision.rationale, /观察模式/); assert.equal(turn.modelConfig.reasoningDecision.latencyMs, null); assert.equal(f.recalls(), 1);
});

// Claude spec §G / effort spec: Claude adaptive thinking decides the depth per request, so 'auto' is the provider
// default there: no keyword rule, no turn.route effort, and the level never changes between turns.
test('auto on a Claude adaptive model is the provider default, even for a greeting or a request to think carefully', async t => {
  const { directory, store } = storeFixture(t);
  const provider = store.configurationService.provider(null, { name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', models: [{ id: 'claude-opus-5-5' }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'claude-opus-5-5' }, memory: { autoRecall: false, autoStore: false } });
  const { session } = store.createProject({ name: 'Claude project', description: 'Adaptive thinking', workspace: directory, rhythm: { control: 'manual' } });
  const requests = [], controller = new RuntimeController(store, { factory: options => createRnaRuntime({ ...options, provider: async function* (request) { requests.push(request); yield { type: 'text_delta', delta: 'ok' }; yield { type: 'done', stopReason: 'stop' }; } }) });
  t.after(async () => { await controller.close(); });
  const conversation = () => store.state.sessions.find(row => row.id === session.id);
  const send = async text => { const count = conversation().turns.length; store.message(session.id, { text }); await until(() => conversation().turns[count]?.status === 'completed', `turn ${count} completes`); return conversation().turns[count]; };
  assert.equal(conversation().modelSelection.reasoning, 'auto');
  const greeting = await send('你好');
  assert.deepEqual([greeting.modelConfig.reasoning, greeting.modelConfig.reasoningDecision.source, greeting.modelConfig.reasoningDecision.rationale], ['default', 'provider-default', '该模型的默认思考会按任务自行调节，使用供应商默认']);
  const careful = await send('请仔细思考这个架构问题');
  assert.equal(careful.modelConfig.reasoning, 'default', 'no keyword rule on adaptive thinking');
  assert.deepEqual(requests.map(row => row.model.reasoning), ['default', 'default']);
});
