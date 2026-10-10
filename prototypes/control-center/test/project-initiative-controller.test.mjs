import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { createServer } from '../server.mjs';
import { CapabilityInstallService } from '../capability-install-service.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { ProjectEvolutionService } from '../test-support/marketplace-isolation.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from '../../../packages/sdk/test/fixtures/project-genome.mjs';
import { estimateProjectEvolutionBudget } from '../../../packages/sdk/src/project-evolution.mjs';
import { createSession } from '../../../packages/sdk/src/session.mjs';
import { iterateCompletion } from '../../../packages/sdk/src/providers.mjs';
import { SessionDeletionService } from '../session-deletion.mjs';
import { readStateFile } from '../state-shards.mjs';
import { publishPrefix, forgetPrefix } from '../prompt-prefix-registry.mjs';
import { sayAndFinish, finishActiveTurn } from './helpers/foreground-turn.mjs';

const hold = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
// Sharded persistence makes each mutate fsync-heavier; under the parallel full suite long multi-step jobs need more than 15 s.
async function until(check, label = 'condition') { const deadline = Date.now() + 30000; while (Date.now() < deadline) { if (check()) return; await delay(10); } throw new Error(`Timed out: ${label}`); }
const decision = (input, action = 'wait', content = '', evidence = input.events.at(-1).id) => ({ action, content, evidenceIds: [evidence], reason: 'Observed a concrete project fact', nextReviewAfterMs: 60000 });
function decisions(fn, calls = []) { return async function* (options) { const input = JSON.parse(options.messages[0].content[0].text); calls.push(input); const output = await fn(input, options); yield { type: 'text_delta', delta: JSON.stringify(output) }; yield { type: 'usage', usage: { input: 12, output: 8, totalTokens: 20 } }; yield { type: 'done', stopReason: 'stop' }; }; }
async function fixture(t, options = {}) {
  const { beforeStart, ...controllerOptions } = options;
  const directory = mkdtempSync(join(tmpdir(), 'rna-initiative-controller-'));
  const store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Isolated fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 3000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'No goal needed', description: 'Check current compatibility evidence', workspace: directory, initiative: { cooldownMs: 0 } });
  store.mutate(state => { const target = state.projects.find(row => row.id === project.id); target.decisionMode = 'rna-model'; target.simulated = false; target.initialization = { status: 'ready' }; target.overview = 'Investigate compatibility evidence'; target.assignments = { skillIds: [], toolIds: ['project_read', 'project_list'], mcpServerIds: [] }; target.initiative.tokenBudget = 100000; state.settings.realTokenBudget = 200000; });
  writeFileSync(join(directory, 'evidence.txt'), 'compatibility: second input variant is missing');
  await beforeStart?.({ store, project, session, directory });
  const calls = [], defaultDecisionProvider = decisions(input => decision(input), calls);
  // These scripted initiative/budget fixtures do not make market-selection
  // decisions. Isolate that dependency while retaining the real evolution
  // service, tool execution and request-by-request accounting.
  const evolutionService = new ProjectEvolutionService(store, { provider: controllerOptions.evolutionProvider ?? controllerOptions.decisionProvider ?? defaultDecisionProvider });
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, decisionProvider: defaultDecisionProvider, evolutionService, ...controllerOptions });
  t.after(async () => { await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, controller, project, session, calls, current: () => store.state.projects.find(row => row.id === project.id), messages: () => store.state.sessions.find(row => row.id === session.id)?.items.filter(item => item.source === 'initiative') ?? [] };
}

test('natural initiative review authors project judgment options without an extra model call or action', async t => {
  const plan = { version: 1, questions: { initiative_pause: { type: 'boolean', instructions: 'Should the compatibility project stay quiet until new receipts arrive?', criteria: { true: 'Delivered checks are unchanged and there is no unresolved decision.', false: 'A new failure or requested review has not been handled.' } } } };
  let requests = 0;
  const contracts = [], conditions = [], systems = [];
  const app = await fixture(t, { decisionService: { enabled: () => true, review: async () => ({ review: true }) }, decisionProvider: decisions((input, options) => { requests++; contracts.push(input.hostActionContracts.judgment); conditions.push(input.hostConditions?.judgment); systems.push(options.systemPrompt); return { ...decision(input), ...(input.hostConditions?.judgment?.enabled ? { judgmentPolicy: plan } : {}) }; }) });
  await until(() => Boolean(app.current().judgmentPolicy), 'main-model options persisted');
  assert.equal(requests, 1); assert.equal(conditions[0].enabled, true); assert.equal(conditions[0].requiresAssessment, true); assert.deepEqual(app.current().judgmentPolicy.plan, plan);
  assert.equal(app.current().judgmentPolicy.source.method, 'initiative'); assert.equal(app.current().judgmentPolicy.source.modelId, 'fixture-model');
  assert.equal(app.current().initiativeRuntime.sdkState.actions.length, 0);
  // A fresh, valid plan is not offered for re-authoring on the next wake: the contract says so at the request tail and
  // carries no plan, while the system prompt stays byte-identical (it used to flip with the authoring guidance).
  sayAndFinish(app.store, app.session.id, 'The project now targets a new input format.');
  await until(() => requests === 2, 'second wake');
  assert.equal(conditions[1].enabled, false, 'no plan accepted while it is fresh'); assert.equal(conditions[1].existingPlan, undefined);
  assert.deepEqual(contracts[1], contracts[0], 'the contract head is the same on both wakes'); assert.equal(contracts[0].requiresAssessment, undefined);
  assert.equal(systems[1], systems[0], 'one system prompt for revisit and ordinary wakes');
  assert.deepEqual(app.current().judgmentPolicy.plan, plan, 'the plan on file is unchanged');
});
// Spec prefix.md §2: sharing the agent prefix with decisions cannot lower uncached input, so decisions keep their own
// tool-free prefix even on an endpoint verified for tool_choice none (DeepSeek here; Claude's official endpoint too).
test('a decision on a verified tool_choice:none endpoint keeps its own prefix: decision system prompt, no tools', async t => {
  const requests = [];
  const app = await fixture(t, {
    beforeStart: ({ store, project }) => {
      const verified = store.configurationService.provider(null, { name: 'DeepSeek-shaped', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', models: [{ id: 'deepseek-v4-pro', contextWindow: 64000, maxOutputTokens: 3000, reasoning: ['off'] }] });
      store.configurationService.update({ defaultModel: { providerId: verified.id, modelId: 'deepseek-v4-pro', reasoning: 'off' } });
      publishPrefix(project.id, { systemPrompt: 'AGENT_SYSTEM_PROMPT', tools: [{ name: 'project_read', description: 'Read a file.', parameters: { type: 'object' } }], initialContext: [{ key: 'skill-catalog', source: 'capability-catalog', text: '[]' }], cacheScope: `project:${project.id}`, modelKey: `${verified.id}/deepseek-v4-pro` });
      t.after(() => forgetPrefix(project.id));
    },
    decisionProvider: decisions((input, options) => { requests.push({ system: options.systemPrompt, tools: options.tools, toolChoice: options.toolChoice, messages: options.messages.length }); return decision(input); }) });
  await until(() => requests.length >= 1 && app.current().mind?.pacing?.wake?.history?.length >= 1, 'one decision');
  // The wake history measures a request against the previous one: a second decision records which prefix it used.
  sayAndFinish(app.store, app.session.id, 'Another compatibility case arrived.');
  await until(() => requests.length >= 2 && app.current().mind.pacing.wake.history.some(row => row.prompt), 'a measured second decision');
  assert.notEqual(requests[0].system, 'AGENT_SYSTEM_PROMPT'); assert.match(requests[0].system, /ongoing project collaborator/);
  assert.deepEqual(requests[0].tools, []); assert.equal(requests[0].messages, 1, 'the decision request alone, no shared catalogue or orientation');
  assert.equal(requests[0].toolChoice, 'none', 'the verified endpoint still disables tools explicitly');
  assert.equal(requests[1].system, requests[0].system); assert.deepEqual(requests[1].tools, []);
  assert.equal(app.current().mind.pacing.wake.history.findLast(row => row.prompt).prompt.prefix, 'own');
});

test('a proposed work the host finds already covered is not started, counts as a thought wake, and the next decision is told why', async t => {
  // Live 2026-10-04: after almost every foreground turn the initiative started a 220k–400k-token re-verification run.
  let requests = 0, checked = 0;
  const inputs = [];
  // No judgment plan contract here (enabled() is false); the coverage check is called whenever the host provides it.
  const app = await fixture(t, { decisionService: { enabled: () => false, review: async () => ({ review: true }), workCoverage: async (project, proposal) => { checked++; assert.equal(proposal.action, 'work'); return { covered: true, ledgerId: 'coverage-ledger' }; } },
    decisionProvider: decisions(input => { requests++; inputs.push(input); return requests === 1 ? decision(input, 'work', 'Re-read evidence.txt and verify the compatibility note again') : decision(input); }) });
  await until(() => requests >= 1 && app.current().decisions?.some(row => row.admission), 'covered decision recorded');
  assert.equal(checked, 1);
  assert.equal(app.current().initiativeRuntime.sdkState.actions.length, 0, 'no work queued or run');
  const row = app.current().decisions.find(item => item.admission);
  assert.deepEqual({ action: row.action, reason: row.admission.reason, status: row.admission.status, ledgerId: row.admission.ledgerId }, { action: 'work', reason: 'already_covered', status: 'not_admitted', ledgerId: 'coverage-ledger' });
  await until(() => app.current().mind?.pacing?.wake?.history?.length, 'wake recorded');
  const wake = app.current().mind.pacing.wake.history.at(-1);
  assert.equal(wake.outcome, 'thought', 'nothing visible happened: rumination backs off'); assert.equal(wake.reason, 'already_covered');
  sayAndFinish(app.store, app.session.id, 'Any news on the compatibility case?');
  await until(() => requests === 2, 'next decision');
  assert.equal(inputs[1].previousDecision.admission, 'already_covered'); assert.match(inputs[1].previousDecision.content, /verify the compatibility note again/);
});
test('no Goal: project context drives real SDK read work and the model separately chooses a conversational share', async t => {
  const calls = [], workCalls = [];
  const provider = decisions(input => {
    assert.equal(input.project.goal, undefined);
    const completed = input.events.find(event => event.type === 'action_completed');
    if (completed) return decision(input, 'share', '兼容性资料缺少第二种输入的例子。', completed.id);
    return decision(input, 'work', 'Read evidence.txt and explain the missing compatibility case');
  }, calls);
  const app = await fixture(t, { decisionProvider: provider, runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* (request) {
    workCalls.push(request); assert.ok(request.tools.every(tool => !/write|edit|exec/.test(tool.name)));
    if (!request.messages.some(message => message.role === 'toolResult')) {
      yield { type: 'tool_call', id: 'read1', name: 'project_read', arguments: { path: 'evidence.txt' } };
      yield { type: 'done', stopReason: 'toolUse' };
    } else { assert.match(JSON.stringify(request.messages), /second input variant is missing/); yield { type: 'text_delta', delta: 'Verified evidence.txt: a second input compatibility example is missing.' }; yield { type: 'done', stopReason: 'stop' }; }
    yield { type: 'usage', usage: { input: 12, output: 8, totalTokens: 20 } };
  } }) });
  await until(() => app.messages().length === 1, 'background finding delivered');
  assert.equal(app.store.state.goals.length, 0); assert.equal(workCalls.length, 2);
  assert.equal(app.current().jobs[0].status, 'completed'); assert.equal(app.current().jobs[0].simulated, false);
  assert.match(readFileSync(app.current().jobs[0].runtimeFile, 'utf8'), /second input variant is missing/);
  assert.equal(app.messages()[0].simulated, false); assert.equal(app.current().initiative.spentUsd, 0);
  assert.equal(app.current().initiative.tokens, 80); assert.equal(app.store.state.realUsage.tokens, 80); assert.equal(app.store.state.realUsage.reservedTokens, 0);
  const count = calls.length; app.controller.schedule(); await delay(50); assert.equal(calls.length, count); assert.equal(app.messages().length, 1);
});

test('independent learning removes the normal router learning capability and prompts while retaining communication', async t => {
  const observed = [];
  const app = await fixture(t, { independentLearning: true, decisionProvider: decisions(input => {
    observed.push(input);
    assert.ok(!input.availableActions.includes('learn'));
    assert.equal(input.hostActionContracts.learn, undefined);
    assert.equal(input.project.learningEnabled, undefined);
    assert.equal(input.project.learningStatus, undefined);
    assert.equal(input.project.learningPolicy, undefined);
    return decision(input, 'share', 'A concrete finding from the current project context.');
  }) });
  await until(() => app.messages().length === 1);
  assert.equal(app.current().evolution.enabled, true);
  assert.ok(observed.length > 0); assert.equal(app.current().initiativeRuntime.sdkState.actions[0].action, 'share');
  assert.equal(app.current().versions.length, 1);
});

test('normal router admission subtracts completed and reserved independent learning tokens', async t => {
  const app = await fixture(t, { independentLearning: true, beforeStart({ store, project }) {
    store.mutate(state => { const target = state.projects.find(row => row.id === project.id); target.learningRuntime = { usage: { totalTokens: 99990, reservedTokens: 10 } }; });
  } });
  await until(() => app.current().initiativeRuntime?.status === 'budget_exhausted');
  assert.equal(app.calls.length, 0);
  assert.equal(app.controller.contexts.get(app.project.id).coordinator.policy.tokenBudget, 0);
  app.store.updateProject(app.project.id, { initiative: { tokenBudget: 200000 } });
  await until(() => app.calls.length === 1 && app.current().initiativeRuntime.sdkState.usedTokens === 20);
  assert.equal(app.current().initiative.tokens, 100010);
});

test('enabling the independent learner preserves historical work evidence and only retires queued legacy learning', async t => {
  const app = await fixture(t, { decisionProvider: decisions(input => decision(input, 'share', 'A recorded concrete finding')) });
  await until(() => app.current().initiativeRuntime?.sdkState.actions.some(row => row.status === 'completed'));
  await app.controller.close(); const originalScope = app.current().initiativeRuntime.sourceHash;
  app.store.mutate(state => { const p = state.projects.find(row => row.id === app.project.id), sdk = p.initiativeRuntime.sdkState, source = sdk.actions[0];
    sdk.actions = [{ ...source, id: 'retained-work', action: 'work', content: 'Original work intent', resultSummary: 'Actual retained worker result', status: 'completed' }, { ...source, id: 'unstarted-learn', intentKey: 'unstarted-learn', action: 'learn', status: 'queued', content: 'An old unstarted proposal' }];
  });
  const next = new ProjectInitiativeController(app.store, { independentLearning: true, tickIntervalMs: 0, initialDelayMs: 100000, decisionProvider: decisions(input => decision(input)) });
  t.after(() => next.close()); await until(() => app.current().initiativeRuntime.sdkState.actions.find(row => row.id === 'unstarted-learn')?.status === 'cancelled');
  const work = app.current().initiativeRuntime.sdkState.actions.find(row => row.id === 'retained-work');
  assert.equal(app.current().initiativeRuntime.sourceHash, originalScope); assert.equal(work.contextRevoked, undefined); assert.equal(work.content, 'Original work intent'); assert.equal(work.resultSummary, 'Actual retained worker result');
});

for (const pauseBeforeResolution of [false, true]) test(`unknown background tool execution keeps action/job needs_review and explicit resolution works while ${pauseBeforeResolution ? 'paused' : 'enabled'}`, async t => {
  let clock = 1000, modelRequests = 0; const observed = [];
  const app = await fixture(t, { now: () => clock, decisionProvider: decisions(input => {
    const unresolved = input.recentActions.find(action => action.blocksExecution);
    if (unresolved) { assert.deepEqual(input.availableActions.sort(), ['share', 'wait']); assert.equal(unresolved.failure.code, 'uncertain_tool'); return decision(input, 'share', '先核对尚未确认结束的外部命令，后续执行正在等待结果确认。'); }
    return decision(input, 'work', 'Inspect the assigned read capability');
  }, observed), runtimeFactory: options => createSession({ ...options, tools: [{ name: 'fixture_read', effect: 'read', idempotent: true, parameters: { type: 'object' }, execute: async () => ({ isError: true, content: [{ type: 'text', text: 'The process may still be running.' }], details: { cleanupUncertain: true } }) }], provider: async function* () {
    modelRequests++; yield { type: 'tool_call', id: 'uncertain-read', name: 'fixture_read', arguments: {} }; yield { type: 'usage', usage: { totalTokens: 17 } }; yield { type: 'done', stopReason: 'toolUse' };
  } }) });
  await until(() => app.current().initiativeRuntime?.sdkState.actions.some(action => action.status === 'needs_review'));
  const action = app.current().initiativeRuntime.sdkState.actions[0], job = app.current().jobs.find(job => job.id === action.id);
  assert.equal(action.blocksExecution, true); assert.equal(action.errorCode, 'uncertain_tool'); assert.equal(job.status, 'needs_review'); assert.match(job.output, /未决外部执行/); assert.match(readFileSync(job.runtimeFile, 'utf8'), /tool_uncertain/); assert.equal(modelRequests, 1);
  clock = app.current().initiativeRuntime.sdkState.nextReviewAt; app.controller.schedule(); await until(() => app.messages().length === 1);
  assert.equal(modelRequests, 1); assert.ok(observed.some(input => input.recentActions.some(action => action.blocksExecution)));
  await assert.rejects(app.controller.resolveAction(app.project.id, action.id, { status: 'completed', summary: ' ' }), { status: 400, code: 'invalid_resolution' });
  await assert.rejects(app.controller.resolveAction('missing', action.id, { status: 'completed', summary: 'checked' }), { status: 404, code: 'project_not_found' });
  if (pauseBeforeResolution) { app.store.updateProject(app.project.id, { initiative: { enabled: false } }); await until(() => !app.controller.contexts.has(app.project.id)); }
  const spent = app.current().initiative.tokens, wake = app.current().initiativeRuntime.sdkState.nextReviewAt;
  const resolved = await app.controller.resolveAction(app.project.id, action.id, { status: 'completed', summary: 'Checked the isolated fixture; no command remains running and its output was inspected.' });
  assert.equal(resolved.status, 'completed'); assert.equal(resolved.resolutionSource, 'user'); assert.equal(app.current().jobs.find(job => job.id === action.id).status, 'completed'); assert.equal(app.current().initiativeRuntime.sdkState.actions.find(row => row.id === action.id).resolutionSource, 'user');
  assert.equal(app.current().initiative.enabled, !pauseBeforeResolution); assert.equal(app.current().initiative.tokens, spent); assert.equal(app.current().initiativeRuntime.sdkState.nextReviewAt, wake); assert.equal(modelRequests, 1);
  await assert.rejects(app.controller.resolveAction(app.project.id, action.id, { status: 'not-executed', summary: 'second confirmation' }), { status: 409, code: 'invalid_resolution' });
});

test('initial spontaneous review waits 45 seconds; a user message is reviewed at once when its turn ends, not while it runs', async t => {
  const app = await fixture(t, { initialDelayMs: 45000 });
  await until(() => app.controller.contexts.size === 1 && app.controller.contexts.values().next().value.initialized);
  assert.equal(app.calls.length, 0);
  app.store.message(app.session.id, { text: 'The project now targets a new input format.' });
  // PDL-2: the message starts a foreground turn; it is observed, and nothing is decided while the turn runs.
  const context = app.controller.contexts.get(app.project.id);
  await until(() => context.coordinator.state.events.some(event => event.summary.includes('new input format')), 'observed');
  for (let n = 0; n < 20; n++) { await app.controller.pump(); await delay(2); }
  assert.equal(app.calls.length, 0, 'no decision during the turn');
  finishActiveTurn(app.store, app.session.id, { reply: 'Switched the parser to the new input format.' });
  await until(() => app.calls.length === 1);
  assert.ok(app.calls[0].events.some(event => event.summary.includes('new input format')));
  assert.ok(app.calls[0].events.some(event => event.type === 'conversation_result'), 'the turn\'s result is the wake');
  assert.equal(app.messages().length, 0);
});

test('a project with no conversation makes no writes or model requests during 1000 idle pumps and can share after the user creates one', async t => {
  const calls = [];
  const app = await fixture(t, { now: () => 1000, beforeStart: async ({ store, session }) => {
    const cleanup = new SessionDeletionService(store);
    try { store.deleteSession(session.id); assert.equal((await cleanup.wait(session.id)).status, 'completed'); }
    finally { await cleanup.close(); }
  }, decisionProvider: decisions(input => decision(input, 'share', 'A checked project finding awaits a conversation.'), calls) });
  await until(() => app.current().initiativeRuntime?.sdkState.actions.some(action => action.status === 'queued' && action.deferredReason === 'no_conversation'));
  await until(() => !app.controller.pumping && !app.controller.contexts.get(app.project.id)?.reviewPromise);
  const writes = app.store.persistence.writes, requests = calls.length, snapshot = structuredClone(app.store.state);
  assert.equal(app.controller.presence(app.current()).conversationAvailable, false); assert.equal(requests, 1);
  for (let pump = 0; pump < 1000; pump++) { await app.controller.pump(); await app.controller.contexts.get(app.project.id)?.reviewPromise; }
  assert.equal(app.store.persistence.writes, writes); assert.equal(calls.length, requests); assert.deepEqual(app.store.state, snapshot);
  assert.equal(app.store.state.sessions.filter(session => session.projectId === app.project.id).length, 0);
  const created = app.store.createSession({ projectId: app.project.id });
  await until(() => app.store.state.sessions.find(session => session.id === created.id)?.items.some(item => item.source === 'initiative'));
  const delivered = app.store.state.sessions.find(session => session.id === created.id).items.filter(item => item.source === 'initiative');
  assert.equal(delivered.length, 1); assert.match(delivered[0].text, /checked project finding/);
  // A new conversation is not a scope change (PDL-1): the queued finding is delivered as decided, without another
  // paid decision or a cancellation.
  assert.equal(calls.length, requests);
  await app.controller.pump(); await app.controller.contexts.get(app.project.id)?.reviewPromise;
  assert.equal(app.store.state.sessions.find(session => session.id === created.id).items.filter(item => item.source === 'initiative').length, 1);
});

test('typing is rechecked after model generation; releasing presence delivers once without rerunning the decision', async t => {
  const entered = hold(), release = hold(); let calls = 0;
  const app = await fixture(t, { decisionProvider: decisions(async input => { calls++; entered.resolve(); await release.promise; return decision(input, 'share', 'A concrete finding'); }) });
  await entered.promise;
  app.store.presence(app.project.id, { sessionId: app.session.id, typing: true, visible: true }); release.resolve();
  await until(() => app.current().initiativeRuntime.sdkState.actions[0]?.status === 'queued'); assert.equal(app.messages().length, 0);
  app.store.presence(app.project.id, { sessionId: app.session.id, typing: false, visible: true }); app.controller.schedule();
  await until(() => app.messages().length === 1); assert.equal(calls, 1);
});

test('muting and quiet time defer communication while real background work continues', async t => {
  const app = await fixture(t, { initialDelayMs: 45000, decisionProvider: decisions(input => {
    const completed = input.events.find(event => event.type === 'action_completed');
    return completed ? decision(input, 'share', '项目简介中的兼容性约束需要核对。', completed.id) : decision(input, 'work', 'Review the current project introduction and identify an unresolved question');
  }), runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* () { yield { type: 'text_delta', delta: 'The provided project introduction leaves compatibility cases unresolved.' }; yield { type: 'usage', usage: { totalTokens: 20, input: 10, output: 10 } }; yield { type: 'done', stopReason: 'stop' }; } }) });
  await until(() => app.controller.contexts.size === 1);
  app.store.updateProject(app.project.id, { initiative: { notificationMuted: true } }); app.controller.contexts.get(app.project.id).notBefore = 0; app.controller.schedule();
  await until(() => app.current().jobs[0]?.status === 'completed' && app.current().initiativeRuntime.sdkState.actions.some(action => action.action === 'share' && action.status === 'queued'));
  assert.equal(app.messages().length, 0);
  app.store.updateProject(app.project.id, { initiative: { notificationMuted: false, quietUntil: new Date(Date.now() + 60000).toISOString() } });
  await delay(30); assert.equal(app.messages().length, 0);
  app.store.updateProject(app.project.id, { initiative: { quietUntil: null } }); await until(() => app.messages().length === 1);
});

test('new user input invalidates an in-flight share even if the provider ignores abort', async t => {
  const entered = hold(), release = hold(); let calls = 0;
  const app = await fixture(t, { decisionProvider: decisions(async input => { calls++; if (calls === 1) { entered.resolve(); await release.promise; return decision(input, 'share', 'obsolete-message'); } return decision(input); }) });
  await entered.promise; sayAndFinish(app.store, app.session.id, 'Ignore the previous compatibility direction.'); release.resolve();
  await until(() => calls >= 2); assert.equal(app.messages().length, 0); assert.ok(!JSON.stringify(app.current().initiativeRuntime.sdkState.events).includes('obsolete-message'));
});

test('paused and deleted projects cannot receive late decisions or be resurrected', async t => {
  const entered = hold(), release = hold();
  const app = await fixture(t, { decisionProvider: decisions(async input => { entered.resolve(); await release.promise; return decision(input, 'share', 'late-message'); }) });
  await entered.promise; app.store.updateProject(app.project.id, { initiative: { enabled: false } }); release.resolve();
  await until(() => !app.controller.contexts.size); assert.equal(app.messages().length, 0);
  assert.equal(app.current().initiativeRuntime.status, 'paused');
  app.store.deleteProject(app.project.id); app.controller.schedule(); await delay(30); assert.equal(app.current(), undefined); assert.equal(app.store.state.realUsage.reservedTokens, 0);
});

test('deletion during generation releases reservations without reviving the project', async t => {
  const entered = hold(), release = hold();
  const app = await fixture(t, { decisionProvider: decisions(async input => { entered.resolve(); await release.promise; return decision(input, 'share', 'too-late-for-deleted-project'); }) });
  await entered.promise; assert.ok(app.store.state.realUsage.reservedTokens > 0);
  app.store.deleteProject(app.project.id); release.resolve();
  await until(() => app.controller.contexts.size === 0);
  assert.equal(app.current(), undefined); assert.equal(app.store.state.sessions.length, 0); assert.equal(app.store.state.realUsage.reservedTokens, 0);
  assert.ok(app.store.state.realUsage.tokens > 20); assert.equal(app.store.state.realUsage.tokens, app.store.state.realUsage.estimatedTokens);
});

test('archiving a conversation cancels its pending share and removes the old context from the new project review', async t => {
  const entered = hold(), release = hold(); let calls = 0;
  const app = await fixture(t, { decisionProvider: decisions(async input => { calls++; entered.resolve(); await release.promise; return decision(input, 'share', 'obsolete archived conversation'); }) });
  await entered.promise; app.store.updateSession(app.session.id, { archived: true }); release.resolve();
  await until(() => app.controller.contexts.size === 1 && !app.controller.pumping);
  assert.equal(app.messages().length, 0);
  assert.ok(app.current().initiativeRuntime.sdkState.actions.every(action => action.status !== 'completed'));
  assert.ok(calls >= 1);
});

test('autonomous learning executes generated scripts and frozen comparisons before a ready version is proactively offered for trial', async t => {
  const calls = [];
  const app = await fixture(t, { beforeStart: async ({ store, project }) => {
    const prepared = await new ProjectGenomeStore(store).prepare(project, { genome: projectGenomeFixture(), versionId: project.activeVersionId }); await prepared.commit();
    store.mutate(state => { state.projects.find(item => item.id === project.id).versions.find(version => version.id === project.activeVersionId).bundle = prepared.record; });
  }, decisionProvider: decisions(input => {
    const completed = input.events.find(event => event.type === 'action_completed');
    return completed ? decision(input, 'share', '项目新版本已经通过真实评测，可以开始试用。', completed.id) : decision(input, 'learn', 'Improve executable project evidence behavior');
  }), evolutionProvider: genomeEvaluationProvider({ calls }) });
  const baseline = app.current().activeVersionId;
  await until(() => app.messages().length === 1, 'evaluated project version notice');
  const candidate = app.current().versions.find(version => version.state === 'ready');
  assert.ok(candidate); assert.equal(candidate.simulated, false); assert.equal(candidate.evaluation.gatePassed, true); assert.equal(candidate.evaluation.cases, 3); assert.equal(app.current().activeVersionId, baseline); assert.equal(app.current().trialVersionId, null);
  assert.equal(candidate.bundle.genome.systemPrompt.startsWith('CANDIDATE_AGENT'), true); assert.equal(calls.length, 16); assert.match(app.messages()[0].text, /可以开始试用/);
  assert.equal(app.current().jobs.find(job => job.kind === 'evolution').status, 'completed');
});

test('uncapped autonomous evolution of a substantial five-case genome reserves by genome size and completes over 100k measured tokens', async t => {
  const baselineGenome = projectGenomeFixture(); baselineGenome.systemPrompt += ' Explain checked project evidence.'.repeat(230);
  baselineGenome.skills.push({ ...structuredClone(baselineGenome.skills[0]), id: 'secondary_evidence', name: 'Secondary evidence' });
  baselineGenome.tools.push({ ...structuredClone(baselineGenome.tools[0]), id: 'secondary_helper', name: 'Secondary helper' });
  for (let n = 4; n <= 5; n++) baselineGenome.evaluationSuite.cases.push({ ...structuredClone(baselineGenome.evaluationSuite.cases[0]), id: `case_${n}`, input: `Check project edge input ${n} with verified evidence.` });
  const candidate = structuredClone(baselineGenome); candidate.systemPrompt = `CANDIDATE_AGENT: provide precise actionable evidence. ${baselineGenome.systemPrompt}`;
  const calls = [], blocked = hold(); let started = false;
  t.after(() => blocked.resolve());
  const generated = genomeEvaluationProvider({ candidate, calls });
  const app = await fixture(t, { beforeStart: async ({ store, project }) => {
    const prepared = await new ProjectGenomeStore(store).prepare(project, { genome: baselineGenome, versionId: project.activeVersionId }); await prepared.commit();
    store.mutate(state => { const current = state.projects.find(row => row.id === project.id); current.versions.find(version => version.id === project.activeVersionId).bundle = prepared.record; current.initiative.tokenBudget = null; state.settings.realTokenBudget = null; });
  }, decisionProvider: decisions(input => input.events.some(event => event.type === 'action_completed') ? decision(input, 'wait') : decision(input, 'learn', 'Evaluate the substantial project genome')),
  evolutionProvider: async function* (request) { if (!started) { started = true; await blocked.promise; } for await (const event of generated(request)) yield event.type === 'usage' ? { type: 'usage', usage: { input: 3000, output: 1000, totalTokens: 4000 } } : event; } });
  await until(() => started, 'evolution proposal admitted');
  const expected = estimateProjectEvolutionBudget(baselineGenome, app.controller.model(app.current())); assert.ok(expected > 50000);
  const inFlight = app.current().initiativeRuntime.sdkState.reservedTokens;
  assert.ok(inFlight > 0 && inFlight < expected, 'Only the actual current request remains reserved once admitted'); assert.equal(app.store.state.realUsage.reservations[`initiative:${app.project.id}`], inFlight); assert.equal(app.current().initiativeRuntime.sdkState.policy.tokenBudget, null);
  blocked.resolve(); await until(() => app.current().versions.some(version => version.state === 'ready'), 'five-case evaluation completed');
  await until(() => app.store.state.realUsage.reservedTokens === 0);
  const ready = app.current().versions.find(version => version.state === 'ready'); assert.equal(ready.evaluation.cases, 5); assert.equal(ready.usage.totalTokens, 104000); assert.equal(calls.length, 26); assert.ok(app.store.state.realUsage.reportedTokens >= 104000); assert.equal(app.store.state.realUsage.estimatedTokens, 0);
});

test('finite project and global budgets admit only their current remaining intersection to autonomous learning', async t => {
  for (const [projectCap, globalCap] of [[50000, null], [null, 60000], [70000, 50000]]) {
    const release = hold(); let allowance;
    t.after(() => release.resolve());
    const expected = Math.min(projectCap ?? Infinity, globalCap ?? Infinity) - 20;
    const app = await fixture(t, { beforeStart: async ({ store, project }) => { store.mutate(state => { state.projects.find(row => row.id === project.id).initiative.tokenBudget = projectCap; state.settings.realTokenBudget = globalCap; }); }, decisionProvider: decisions(input => input.events.some(event => event.type === 'action_completed') ? decision(input, 'wait') : decision(input, 'learn', 'Evaluate within the explicit cap')), evolutionService: { async evolve(_id, options) { assert.equal(options.tokenBudget, null); await assert.rejects(options.requestControl.beforeRequest({ estimatedTokens: expected + 1 }), { code: 'budget' }); await options.requestControl.beforeRequest({ estimatedTokens: expected }); allowance = expected; await release.promise; await options.requestControl.onUsage({ usage: { totalTokens: 200 } }); return { status: 'rejected', summary: 'Fixture comparison rejected', usage: { totalTokens: 200 } }; } } });
    await until(() => allowance !== undefined);
    assert.equal(allowance, expected); assert.equal(app.current().initiativeRuntime.sdkState.reservedTokens, expected); assert.equal(app.store.state.realUsage.reservations[`initiative:${app.project.id}`], expected);
    release.resolve(); await until(() => app.store.state.realUsage.reservedTokens === 0); await app.controller.close();
  }
});

test('project and global budget gates stop a provider call before spending', async t => {
  const app = await fixture(t, { initialDelayMs: 45000 }); await until(() => app.controller.contexts.size === 1);
  app.store.mutate(state => { state.settings.realTokenBudget = 1; });
  app.store.message(app.session.id, { text: 'New project observation under exhausted budget' });
  await delay(50); assert.equal(app.calls.length, 0); assert.equal(app.messages().length, 0); assert.equal(app.store.state.realUsage.tokens, 0);
});

test('restart recovers receipts without repeating proactive delivery', async t => {
  const app = await fixture(t, { decisionProvider: decisions(input => decision(input, 'share', 'once-only finding')) });
  await until(() => app.messages().length === 1); await app.controller.close();
  let repeated = 0;
  const restarted = new ProjectInitiativeController(app.store, { initialDelayMs: 0, tickIntervalMs: 0, decisionProvider: decisions(input => { repeated++; return decision(input, 'share', 'different wording for the same finding'); }) });
  t.after(() => restarted.close());
  await until(() => restarted.contexts.size === 1); await delay(50); assert.equal(app.messages().length, 1); assert.equal(repeated, 0);
  await restarted.close();
});

test('restart settles orphan reservations even for a project whose initiative is paused', async t => {
  const app = await fixture(t, { initialDelayMs: 45000 }); await until(() => app.controller.contexts.size === 1); await app.controller.close();
  app.store.mutate(state => { const project = state.projects.find(project => project.id === app.project.id), saved = project.initiativeRuntime.sdkState; project.initiative.enabled = false; saved.usedTokens = 10; saved.reservedTokens = 123; saved.actions = [{ id: 'uncertain', action: 'share', status: 'running', evidenceIds: saved.events.map(event => event.id), content: 'not replayed' }]; state.realUsage.tokens = 10; state.realUsage.reservations[`initiative:${project.id}`] = 123; state.realUsage.reservedTokens = 123; });
  const restarted = new ProjectInitiativeController(app.store, { tickIntervalMs: 0 });
  assert.equal(app.store.state.realUsage.tokens, 133); assert.equal(app.store.state.realUsage.reservedTokens, 0); assert.equal(app.current().initiativeRuntime.sdkState.actions[0].status, 'needs_review'); assert.equal(app.messages().length, 0);
  await restarted.close();
});

test('background declares the full project grant (stable prefix) from mixed MCP servers but executes only assigned read tools', async t => {
  const requests = [], factoryGrants = [];
  const app = await fixture(t, {
    beforeStart: async ({ store, project }) => {
      const installer = new CapabilityInstallService(store);
      await installer.assign(project.id, { toolIds: ['project_write', 'project_edit', 'project_exec'] });
      await installer.install(project.id, { kind: 'mcp', activate: true, source: { type: 'mcp-config', config: { mcpServers: { mixed: { command: process.execPath, args: [fileURLToPath(new URL('../../../packages/sdk/test/fixtures/mcp-server.mjs', import.meta.url))] } } } }, allowTools: { echo: { permission: 'read', idempotent: true }, unapproved_write: { permission: 'write' } } });
    },
    decisionProvider: decisions(input => input.events.some(event => event.type === 'action_completed') ? decision(input) : decision(input, 'work', 'Verify the assigned read-only MCP evidence')),
    runtimeFactory: options => {
      factoryGrants.push(structuredClone(options.project.assignments));
      assert.deepEqual(options.managementTools.map(tool => [tool.name, tool.effect, tool.permission]), [['project_document_read', 'read', 'read'], ['project_history', 'read', 'read'], ['project_present', 'read', 'read'], ['marketplace_search', 'read', 'read'], ['marketplace_read', 'read', 'read']]);
      return createRnaRuntime({ ...options, provider: async function* (request) {
        requests.push(request);
        const names = request.tools.map(tool => tool.name);
        // Tiered tools: the foreground grant stays declared so the tools array
        // matches the foreground; the read-only background grant rejects it at execution.
        for (const name of ['project_write', 'project_edit', 'project_exec', 'mcp__mixed__unapproved_write']) assert.ok(names.includes(name), `${name} is declared for a stable prefix`);
        for (const name of ['capability_install', 'capability_assign', 'capability_remove']) assert.ok(!names.includes(name), `Background must not gain ${name}`);
        assert.ok(names.includes('project_read')); assert.ok(names.includes('mcp__mixed__echo'));
        if (!request.messages.some(message => message.role === 'toolResult')) { yield { type: 'tool_call', id: 'read-mcp', name: 'mcp__mixed__echo', arguments: { text: 'background-read-evidence' } }; yield { type: 'tool_call', id: 'write-mcp', name: 'mcp__mixed__unapproved_write', arguments: {} }; yield { type: 'done', stopReason: 'toolUse' }; }
        else { assert.match(JSON.stringify(request.messages), /initialized:background-read-evidence/); assert.match(JSON.stringify(request.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'write-mcp')), /Read-only authorization: writes are rejected/); yield { type: 'text_delta', delta: 'Confirmed the local MCP read evidence.' }; yield { type: 'done', stopReason: 'stop' }; }
        yield { type: 'usage', usage: { input: 10, output: 10, totalTokens: 20 } };
      } });
    }
  });
  await until(() => app.current().jobs[0]?.status === 'completed', 'mixed-grant background completion');
  assert.equal(requests.length, 2); assert.equal(factoryGrants.length, 1);
  assert.deepEqual(factoryGrants[0].toolIds, app.current().assignments.toolIds, 'the runtime receives the unreduced project grant; enforcement is per call');
  assert.deepEqual(factoryGrants[0].mcpServerIds, ['mixed']);
  assert.ok(app.current().assignments.toolIds.includes('project_exec'), 'Reducing background scope must not modify the foreground grant');
  assert.ok(app.current().assignments.toolIds.includes('mcp:mixed:unapproved_write'));
  assert.equal(app.messages().length, 0);
});

test('a privacy scope change (another workspace folder) cancels in-flight background work and discards late results even when the fixture ignores abort', async t => {
  const entered = hold(), release = hold(); let workRequests = 0, actionSignal;
  const app = await fixture(t, {
    decisionProvider: decisions(input => input.project.title === 'No goal needed' ? decision(input, 'work', 'Inspect old project context') : decision(input)),
    runtimeFactory: options => { actionSignal = options.signal; assert.ok(actionSignal instanceof AbortSignal); return createRnaRuntime({ ...options, provider: async function* () {
      workRequests++; entered.resolve(); await release.promise;
      yield { type: 'text_delta', delta: 'OBSOLETE_WORK_RESULT' };
      yield { type: 'usage', usage: { totalTokens: 20, input: 10, output: 10 } }; yield { type: 'done', stopReason: 'stop' };
    } }); }
  });
  await entered.promise;
  const moved = join(app.directory, 'moved'); mkdirSync(moved);
  app.store.mutate(state => { state.projects.find(row => row.id === app.project.id).workspace = moved; }); release.resolve();
  assert.equal(actionSignal.aborted, true);
  await until(() => app.current().jobs[0]?.status === 'cancelled' && !app.controller.pumping, 'old work cancellation');
  assert.equal(workRequests, 1); assert.equal(app.messages().length, 0);
  assert.match(app.current().jobs[0].runtimeFile, /\.rna\.jsonl$/);
  assert.ok(app.current().jobs[0].failure.code, 'Cancellation keeps a private journal reference and concrete diagnostic');
  assert.ok(!JSON.stringify(app.current().initiativeRuntime.sdkState).includes('OBSOLETE_WORK_RESULT'));
  assert.equal(app.store.state.realUsage.reservedTokens, 0);
});

test('a drift change (project wording) leaves in-flight background work running and keeps its result (PDL-1)', async t => {
  const entered = hold(), release = hold(); let actionSignal;
  const app = await fixture(t, {
    decisionProvider: decisions(input => input.events.some(event => event.type === 'action_completed') ? decision(input) : decision(input, 'work', 'Inspect the compatibility evidence')),
    runtimeFactory: options => { actionSignal = options.signal; return createRnaRuntime({ ...options, provider: async function* () {
      entered.resolve(); await release.promise;
      yield { type: 'text_delta', delta: 'KEPT_WORK_RESULT' };
      yield { type: 'usage', usage: { totalTokens: 20, input: 10, output: 10 } }; yield { type: 'done', stopReason: 'stop' };
    } }); }
  });
  await entered.promise;
  app.store.updateProject(app.project.id, { name: 'Updated project context' });
  app.store.createSession({ projectId: app.project.id, title: 'A second conversation' });
  app.store.updateSession(app.session.id, { mode: 'plan' }); app.store.updateSession(app.session.id, { mode: 'build' });
  assert.equal(actionSignal.aborted, false, 'drift and conversation membership never stop running work');
  release.resolve();
  await until(() => app.current().jobs[0]?.status === 'completed', 'work completed');
  const work = app.current().initiativeRuntime.sdkState.actions.find(action => action.action === 'work');
  assert.equal(work.status, 'completed'); assert.equal(work.contextRevoked, undefined); assert.match(work.resultSummary, /KEPT_WORK_RESULT/);
});

test('archiving a conversation withdraws what came from it (its events, the work citing it and the share of that work) from the model context while retaining audit receipts', async t => {
  const calls = []; let archived = false;
  const app = await fixture(t, { beforeStart: ({ store, session }) => { store.mutate(state => { state.sessions.find(row => row.id === session.id).items.push({ id: 'archived-request', kind: 'user', text: 'Please check ARCHIVED_SCOPE_SECRET compatibility.', createdAt: new Date().toISOString(), simulated: false }); }); },
    decisionProvider: decisions(input => {
    calls.push(input);
    if (archived) { assert.ok(!JSON.stringify(input).includes('ARCHIVED_SCOPE_SECRET')); return decision(input); }
    const completed = input.events.find(event => event.type === 'action_completed');
    return completed ? decision(input, 'share', 'ARCHIVED_SCOPE_SECRET is a checked finding.', completed.id) : decision(input, 'work', 'Review ARCHIVED_SCOPE_SECRET', input.events.find(event => event.type === 'user_message').id);
  }), runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* () {
    yield { type: 'text_delta', delta: 'ARCHIVED_SCOPE_SECRET verified from previous project context.' };
    yield { type: 'usage', usage: { totalTokens: 20, input: 10, output: 10 } }; yield { type: 'done', stopReason: 'stop' };
  } }) });
  await until(() => app.messages().length === 1);
  const receipt = app.current().initiativeRuntime.sdkState.actions.find(action => action.action === 'share');
  const oldJob = app.current().jobs[0], oldFile = oldJob.runtimeFile;
  assert.match(readFileSync(oldFile, 'utf8'), /ARCHIVED_SCOPE_SECRET/);
  await until(() => !app.controller.contexts.get(app.project.id)?.reviewPromise && !app.controller.pumping, 'review settled');
  archived = true; app.store.updateSession(app.session.id, { archived: true });
  await until(() => app.current().initiativeRuntime.sdkState.actions.every(action => action.contextRevoked && action.revokedBy === 'session_archived'), 'what came from the archived conversation withdrawn');
  const saved = app.current().initiativeRuntime.sdkState;
  assert.ok(!JSON.stringify(saved).includes('ARCHIVED_SCOPE_SECRET'));
  const retained = saved.actions.find(action => action.id === receipt.id);
  assert.equal(retained.intentKey, receipt.intentKey); assert.equal(retained.status, 'completed');
  assert.equal(app.current().jobs[0].runtimeFile, oldFile); assert.match(app.current().jobs[0].output, /ARCHIVED_SCOPE_SECRET/);
  await app.controller.close();
  const disk = readStateFile(app.store.file).state.projects.find(project => project.id === app.project.id);
  assert.ok(!JSON.stringify(disk.initiativeRuntime.sdkState).includes('ARCHIVED_SCOPE_SECRET'));
});

test('isolated observation HTTP API records real human evidence and immediately wakes a ready project without a goal or chat command', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-observation-api-')), calls = [], releaseInitialization = hold();
  const app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false, initiative: true, initiativeOptions: { initialDelayMs: 45000, tickIntervalMs: 0, decisionProvider: decisions(input => {
    const evidence = input.events.find(event => event.summary.includes('HUMAN_OBSERVATION_SENTINEL'));
    assert.ok(evidence); return decision(input, 'share', '这条兼容性证据值得补充到当前讨论。', evidence.id);
  }, calls) }, projectGenerate: async () => { await releaseInitialization.promise; return { status: 'ready', overview: 'Ready real project', focus: 'Understand compatibility', facts: [], openQuestions: [], milestones: [], unmetCapabilities: [], assignments: { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] }, genome: projectGenomeFixture(), attempts: 1, usage: { totalTokens: 0 } }; } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { releaseInitialization.resolve(); await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const provider = app.store.configurationService.provider(null, { name: 'No external requests', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'isolated-model', contextWindow: 64000, maxOutputTokens: 3000, reasoning: ['off'] }] });
  app.store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'isolated-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const api = async (path, body) => { const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result; };
  const created = await api('/projects', { rhythm: { control: 'manual' }, name: 'Human observation fixture', workspace: directory, initiative: { cooldownMs: 0 } });
  const project = () => app.store.state.projects.find(row => row.id === created.project.id);
  await until(() => project()?.initialization.status === 'initializing');
  assert.equal(project().simulated, false); assert.notEqual(project().decisionMode, 'rna-model');
  await api(`/projects/${created.project.id}/observations`, { kind: 'context', eventId: 'queued-human-evidence', text: 'QUEUED_OBSERVATION_SENTINEL: evidence submitted during project initialization.' });
  assert.equal(project().observations[0].simulated, false); assert.equal(project().observations[0].source, 'user-observation');
  assert.equal(project().facts.at(-1).simulated, false); assert.equal(project().facts.at(-1).source, 'user-observation');
  assert.equal(calls.length, 0); releaseInitialization.resolve();
  await until(() => project()?.initialization.status === 'ready' && app.projectInitiative.contexts.get(created.project.id)?.initialized);
  assert.equal(calls.length, 0);
  const input = { kind: 'context', eventId: 'human-evidence-once', text: 'HUMAN_OBSERVATION_SENTINEL: a user supplied compatibility case is missing.' };
  await api(`/projects/${created.project.id}/observations`, input);
  const messages = () => app.store.state.sessions.find(row => row.id === created.session.id).items.filter(item => item.source === 'initiative');
  await until(() => messages().length === 1, 'human observation wakes proactive model');
  assert.equal(calls.length, 1); assert.equal(project().observations.at(-1).simulated, false); assert.equal(project().observations.at(-1).source, 'user-observation');
  assert.ok(calls[0].events.some(event => event.summary.includes('QUEUED_OBSERVATION_SENTINEL')), 'Pre-initialization human evidence remains available after initialization');
  assert.equal(app.store.state.goals.length, 0); assert.equal(app.store.state.sessions.find(row => row.id === created.session.id).turns.length, 0);
  const evidenceId = `observation:${project().observations.at(-1).id}`;
  assert.deepEqual(messages()[0].evidenceIds, [evidenceId]); assert.equal(messages()[0].simulated, false);
  await api(`/projects/${created.project.id}/observations`, input); app.projectInitiative.schedule(); await delay(40);
  assert.equal(calls.length, 1); assert.equal(messages().length, 1); assert.equal(project().observations.length, 2);
});

test('learning its own evaluation receipt cannot finance another autonomous experiment', async () => {
  const current = { evolution: { enabled: true }, activeVersionId: 'baseline', versions: [] };
  const context = { projectId: 'fixture', coordinator: { state: { actions: [{ id: 'previous-learn', action: 'learn' }] } } };
  const host = { project: () => current, startJob: () => assert.fail('No new job may start from learning its own evaluation failure') };
  const result = await ProjectInitiativeController.prototype.learn.call(host, context, { id: 'repeated-learn' }, { signal: new AbortController().signal, evidence: [{ id: 'action:previous-learn:completed', summary: 'Previous candidate failed' }], tokenBudget: null });
  assert.equal(result.superseded, true); assert.equal(result.reason, 'learning_requires_new_evidence'); assert.equal(result.usage.totalTokens, 0);
});

test('migration keeps real user words but excludes simulated assistant and turn outcomes from autonomous evidence', () => {
  const items = [
    { id: 'old-user', kind: 'user', text: 'REAL_OLD_USER_REQUIREMENT', simulated: true, turnId: 'demo-turn' },
    { id: 'demo-answer', kind: 'assistant', text: 'FAKE_DEMO_ANSWER', turnId: 'demo-turn' },
    { id: 'demo-notice', kind: 'assistant', text: 'FAKE_DEMO_NOTICE', simulated: true },
    { id: 'real-answer', kind: 'assistant', text: 'CHECKED_REAL_ANSWER', turnId: 'real-turn' },
    { id: 'fake-tool', kind: 'tool', tool: { name: 'demo', output: 'FAKE_TOOL_OUTPUT' }, simulated: true, turnId: 'real-turn' }
  ];
  const turns = [{ id: 'demo-turn', status: 'completed', modelConfig: { execution: 'simulation' } }, { id: 'real-turn', status: 'completed', modelConfig: { execution: 'rna' } }];
  const project = { id: 'fixture', workspace: tmpdir(), evolution: { enabled: true }, versions: [], observations: [{ id: 'old-demo', text: 'FAKE_DEMO_OBSERVATION', simulated: true }, { id: 'real-human', text: 'REAL_HUMAN_OBSERVATION', simulated: false }] };
  const host = { store: { state: { sessions: [{ id: 'session', projectId: project.id, items, turns }] } }, now: () => 0 };
  const snapshot = ProjectInitiativeController.prototype.snapshot.call(host, project), sources = ProjectInitiativeController.prototype.sources.call(host, project, 'migration-scope');
  const context = JSON.stringify({ snapshot, sources });
  assert.match(context, /REAL_OLD_USER_REQUIREMENT/); assert.match(context, /CHECKED_REAL_ANSWER/); assert.match(context, /REAL_HUMAN_OBSERVATION/);
  assert.ok(!context.includes('FAKE_')); assert.ok(!sources.some(event => event.id.startsWith('turn:demo-turn:'))); assert.ok(sources.some(event => /^turn:real-turn:completed@[a-f0-9]{20}$/.test(event.id)));
});

test('one hung project decision does not block other projects and shutdown quarantines late provider output', async t => {
  const hung = hold(), entered = hold(); let firstId, secondId;
  t.after(() => hung.resolve());
  const provider = decisions(async input => {
    if (input.project.id === firstId) { entered.resolve(); await hung.promise; return decision(input, 'share', 'stale first result'); }
    return decision(input, 'share', 'Useful finding from second project');
  });
  const app = await fixture(t, { maxConcurrentReviews: 2, beforeStart: ({ store, project }) => {
    firstId = project.id;
    const second = store.createProject({ rhythm: { control: 'manual' }, name: 'Independent second project', description: 'Inspect a separate project' }).project; secondId = second.id;
    store.mutate(state => { const target = state.projects.find(item => item.id === secondId); target.decisionMode = 'rna-model'; target.simulated = false; target.initialization = { status: 'ready' }; target.initiative.tokenBudget = null; state.settings.realTokenBudget = null; });
  }, decisionProvider: request => {
    const projectId = JSON.parse(request.messages[0].content[0].text).project.id;
    // Inject the short deadline into the hung transport only. Giving every
    // project 40 ms also times out the responsive stream under test-runner
    // contention, testing machine speed instead of project isolation.
    return projectId === firstId
      ? iterateCompletion(provider, { ...request, totalTimeoutMs: 40 })
      : provider(request);
  } });
  await entered.promise;
  await until(() => app.store.state.sessions.some(session => session.projectId === secondId && session.items.some(item => item.source === 'initiative')));
  await until(() => app.controller.health().projects.find(project => project.projectId === firstId)?.unsettledOperations === 1);
  assert.equal(app.messages().length, 0); assert.equal(app.controller.health().concurrencyLimit, 2);
  await Promise.race([app.controller.close(), delay(250).then(() => { throw new Error('Controller shutdown blocked by hung project'); })]);
  hung.resolve(); await delay(10); assert.equal(app.messages().length, 0); assert.equal(app.store.state.realUsage.reservedTokens, 0);
});

test('concurrent projects reserve the finite global budget atomically before provider admission', async t => {
  const admission = hold(), held = hold(), estimates = []; let requests = 0, rejected = 0;
  t.after(() => { admission.resolve(); held.resolve(); });
  const app = await fixture(t, { initialDelayMs: 45000, maxConcurrentReviews: 4, beforeStart: ({ store }) => {
    for (let n = 0; n < 4; n++) {
      const project = store.createProject({ rhythm: { control: 'manual' }, name: `Concurrent project ${n}`, description: 'Test a shared budget' }).project;
      store.mutate(state => { const target = state.projects.find(item => item.id === project.id); target.decisionMode = 'rna-model'; target.simulated = false; target.initialization = { status: 'ready' }; target.initiative.tokenBudget = null; });
    }
  }, decisionProvider: decisions(async input => { requests++; await held.promise; return decision(input); }) });
  await until(() => app.controller.contexts.size === 5 && [...app.controller.contexts.values()].every(context => context.initialized) && !app.controller.pumping);
  const save = app.controller.save.bind(app.controller);
  app.controller.save = async (context, snapshot, metadata) => {
    if (!metadata?.reservationAdmission) return save(context, snapshot, metadata);
    estimates.push(snapshot.reservedTokens);
    await admission.promise;
    try { return await save(context, snapshot, metadata); }
    catch (error) { if (error.code === 'budget') rejected++; throw error; }
  };
  for (const context of app.controller.contexts.values()) context.notBefore = 0;
  app.controller.schedule();
  await until(() => estimates.length === 4, 'four decisions awaiting their actual reservation admission');
  assert.equal(requests, 0); assert.equal(app.store.state.realUsage.reservedTokens, 0);
  // Use the current SDK's actual reservation, including its schema, evidence
  // and configured output ceiling. The cap admits any one request, never two;
  // no provider has started and the production atomic admission is unchanged.
  const cap = Math.max(...estimates);
  assert.ok(cap > 0 && cap < 2 * Math.min(...estimates));
  app.store.mutate(state => { state.settings.realTokenBudget = cap; });
  admission.resolve();
  await until(() => requests === 1 && rejected === 3, 'one admitted request and three budget rejections');
  assert.equal(requests, 1, 'the next request cannot enter after the first reservation consumed available capacity');
  assert.ok(app.store.state.realUsage.reservedTokens <= cap); assert.ok(estimates.includes(app.store.state.realUsage.reservedTokens));
  held.resolve(); await until(() => app.store.state.realUsage.reservedTokens === 0); await app.controller.close();
});

test('a due persisted wake resumes after restart without reapplying the first-project grace period', async t => {
  let clock = Date.now();
  const app = await fixture(t, { now: () => clock });
  await until(() => app.current().initiativeRuntime?.sdkState.lastDecision);
  const due = app.current().initiativeRuntime.sdkState.nextReviewAt; await app.controller.close(); clock = due + 1;
  let calls = 0;
  const restarted = new ProjectInitiativeController(app.store, { now: () => clock, initialDelayMs: 45000, tickIntervalMs: 0, decisionProvider: decisions(input => { calls++; return decision(input); }) });
  t.after(() => restarted.close());
  await until(() => calls === 1); assert.equal(restarted.contexts.get(app.project.id).notBefore, 0); await restarted.close();
});

test('uncapped real background work can inspect five tool batches, exceed its 12k reservation estimate and preserve configured model output', async t => {
  let requests = 0;
  const app = await fixture(t, { beforeStart: ({ store, project }) => store.mutate(state => { state.settings.realTokenBudget = null; state.projects.find(row => row.id === project.id).initiative.tokenBudget = null; }),
    decisionProvider: decisions(input => input.events.some(event => event.type === 'action_completed') ? decision(input) : decision(input, 'work', 'Inspect five source batches')),
    runtimeFactory: options => { assert.equal(options.maxSteps, 64); assert.equal(options.stepLimitBehavior, 'summarize'); assert.equal(options.model.maxOutputTokens, 3000); return createRnaRuntime({ ...options, provider: async function* (request) {
      requests++; assert.equal(request.model.maxOutputTokens, 3000);
      if (requests <= 5) yield { type: 'tool_call', id: `read-${requests}`, name: 'project_read', arguments: { path: 'evidence.txt' } };
      else { assert.equal(request.messages.filter(message => message.role === 'toolResult').length, 5); yield { type: 'text_delta', delta: 'Five source batches inspected; compatibility evidence remains incomplete.' }; }
      yield { type: 'usage', usage: { input: 2500, output: 500, totalTokens: 3000 } }; yield { type: 'done', stopReason: requests <= 5 ? 'toolUse' : 'stop' };
    } }); }
  });
  await until(() => app.current().jobs[0]?.status === 'completed' && app.current().initiativeRuntime.sdkState.reservedTokens === 0);
  assert.equal(requests, 6); assert.equal(app.current().jobs[0].usage.totalTokens, 18000); assert.equal(app.current().initiativeRuntime.sdkState.policy.decisionMaxTokens, 3000); assert.ok(app.store.state.realUsage.reportedTokens >= 18020); assert.equal(app.store.state.realUsage.estimatedTokens, 0);
});

test('configured background step limit closes the complete read batch with a metered tool-free conclusion', async t => {
  let requests = 0;
  const app = await fixture(t, { workMaxSteps: 2, decisionProvider: decisions(input => input.events.some(event => event.type === 'action_completed') ? decision(input) : decision(input, 'work', 'Inspect sources and report uncertainty')),
    runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* (request) {
      requests++;
      if (requests <= 2) yield { type: 'tool_call', id: `read-${requests}`, name: 'project_read', arguments: { path: 'evidence.txt' } };
      // TC-5: the tool-free conclusion keeps the conversation's tools declared (its cached prefix); the boundary rides at the tail.
      else { assert.equal(request.purpose, 'summary'); assert.ok(request.tools.length > 0); assert.match(JSON.stringify(request.messages.at(-1)), /step_allowance_reached/); assert.equal(request.messages.filter(message => message.role === 'toolResult').length, 2); yield { type: 'text_delta', delta: 'Two reads completed. Further cases remain unchecked.' }; }
      yield { type: 'usage', usage: { totalTokens: 50 } }; yield { type: 'done', stopReason: requests <= 2 ? 'toolUse' : 'stop' };
    } })
  });
  await until(() => app.current().jobs[0]?.status === 'completed');
  assert.equal(requests, 3); assert.equal(app.current().jobs[0].usage.totalTokens, 150); assert.match(app.current().jobs[0].output, /remain unchecked/);
  const journal = readFileSync(app.current().jobs[0].runtimeFile, 'utf8'); assert.match(journal, /step-limit-summary/);
});

test('background automatic summaries are metered together with ordinary model requests', async t => {
  let requests = 0, summaries = 0, steps = 0;
  const app = await fixture(t, { beforeStart: ({ store, directory }) => {
    const provider = store.configurationService.public().providers.find(row => row.id === store.state.configuration.defaultModel.providerId);
    // The full host contract plus newest tool batch must fit before any
    // historical batch can be compacted. Keep a small 16k fixture window and
    // still require real automatic summaries and exact per-request accounting.
    store.configurationService.provider(provider.id, { ...provider, models: [{ id: 'fixture-model', contextWindow: 16000, maxOutputTokens: 500, reasoning: ['off'] }] });
    writeFileSync(join(directory, 'evidence.txt'), 'Read-only compatibility evidence. '.repeat(160));
  }, decisionProvider: decisions(input => input.events.some(event => event.type === 'action_completed') ? decision(input) : decision(input, 'work', 'Inspect source batches')),
    runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* (request) {
      requests++;
      if (request.systemPrompt.startsWith('Summarize the provided')) { summaries++; yield { type: 'text_delta', delta: 'Prior read batches completed. The authorized task is read-only inspection of compatibility evidence. No writes or publication are authorized.' }; }
      else if (++steps <= 15) yield { type: 'tool_call', id: `read-${steps}`, name: 'project_read', arguments: { path: 'evidence.txt' } };
      else yield { type: 'text_delta', delta: 'Fifteen batches inspected; no complete compatibility table is present.' };
      yield { type: 'usage', usage: { input: 10, output: 10, totalTokens: 20 } }; yield { type: 'done' };
    } })
  });
  await until(() => {
    const job = app.current().jobs[0];
    if (job?.status === 'failed') assert.fail(`Compaction fixture failed: ${job.errorCode}: ${job.failure?.message}`);
    return job?.status === 'completed' && app.current().initiativeRuntime.sdkState.reservedTokens === 0;
  });
  assert.ok(summaries > 0); assert.equal(steps, 16); assert.equal(app.current().jobs[0].usage.totalTokens, requests * 20); assert.equal(app.current().jobs[0].usage.estimatedTokens, 0);
  const records = readFileSync(app.current().jobs[0].runtimeFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(row => row.type === 'compaction_request_completed').length, summaries); assert.ok(app.store.state.realUsage.reportedTokens >= requests * 20 + 20);
});

test('decision diagnostics are privately archived, inherited failures are not cleared, and natural success records recovery', async t => {
  let clock = Date.now(), requests = 0; const credential = 'diagnostic-fixture-secret';
  const app = await fixture(t, { now: () => clock, beforeStart: ({ store }) => { store.configurationService.secrets.fixture = credential; }, decisionProvider: async function* () {
    requests++; throw Object.assign(new Error(`provider rejected ${credential}; api_key=unlisted-value`), { code: 'authentication', status: 401 });
  } });
  await until(() => app.current().initiativeRuntime?.sdkState.failureCount === 1);
  const runtime = app.current().initiativeRuntime;
  assert.equal(runtime.lastFailure.source, 'provider'); assert.equal(runtime.lastFailure.code, 'authentication'); assert.equal(runtime.lastFailure.httpStatus, 401); assert.equal(runtime.lastErrorCode, 'authentication');
  assert.match(runtime.lastError, /authentication/); assert.ok(!JSON.stringify(app.current()).includes(credential)); assert.ok(!JSON.stringify(app.current()).includes('unlisted-value'));
  assert.equal(app.controller.health().projects[0].lastFailure.code, 'authentication');
  await app.controller.close();
  const archiveDirectory = `${app.store.file}.archive/initiative/${app.project.id}/failures`, files = readdirSync(archiveDirectory);
  assert.equal(files.length, 1); assert.deepEqual(JSON.parse(readFileSync(join(archiveDirectory, files[0]), 'utf8')), runtime.lastFailure); assert.equal(statSync(join(archiveDirectory, files[0])).mode & 0o077, 0);
  const due = runtime.sdkState.nextReviewAt;
  const restarted = new ProjectInitiativeController(app.store, { now: () => clock, tickIntervalMs: 0, decisionProvider: decisions(input => { requests++; return decision(input); }) }); t.after(() => restarted.close());
  await until(() => restarted.contexts.size === 1); await delay(20); assert.equal(requests, 1); assert.equal(app.current().initiativeRuntime.sdkState.failureCount, 1);
  clock = due; restarted.schedule(); await until(() => app.current().initiativeRuntime.sdkState.failureCount === 0);
  assert.equal(requests, 2); assert.equal(app.current().initiativeRuntime.lastFailure.recoveredAt, clock); assert.equal(app.current().initiativeRuntime.lastError, null);
});

test('invalid evidence references retain only safe classifications in private host archives and stay failed until a real successful review', async t => {
  let clock = Date.now(), requests = 0;
  const messageId = 'raw-conversation-reference', responseText = 'PRIVATE_INVALID_RESPONSE_BODY';
  const app = await fixture(t, { now: () => clock, beforeStart: ({ store, session }) => store.mutate(state => { state.sessions.find(row => row.id === session.id).items.push({ id: messageId, kind: 'user', text: 'A concrete project fact', createdAt: new Date(clock).toISOString() }); }), decisionProvider: decisions(input => {
    requests++; assert.deepEqual(input.allowedEvidenceIds, input.events.map(event => event.id));
    assert.equal(input.project.recentConversation[0].messageId, messageId);
    return { ...decision(input, 'wait', '', messageId), reason: responseText };
  }) });
  await until(() => app.current().initiativeRuntime?.sdkState.failureCount === 1);
  const failure = app.current().initiativeRuntime.lastFailure, due = app.current().initiativeRuntime.sdkState.nextReviewAt;
  assert.deepEqual(failure.evidenceValidation.categories, { actionReceiptId: 0, conversationMessageId: 1, unknown: 0 });
  assert.equal(app.current().initiativeRuntime.lastErrorCode, 'invalid_decision'); await app.controller.close();
  const archive = `${app.store.file}.archive/initiative/${app.project.id}/failures`, files = readdirSync(archive);
  assert.equal(files.length, 1); const original = readFileSync(join(archive, files[0]), 'utf8');
  assert.deepEqual(JSON.parse(original), failure); assert.ok(!original.includes(messageId)); assert.ok(!original.includes(responseText));
  const restarted = new ProjectInitiativeController(app.store, { now: () => clock, tickIntervalMs: 0, decisionProvider: decisions(input => { requests++; return decision(input); }) }); t.after(() => restarted.close());
  // The host asks an invalid decision once more (decisionAttempts 2); the model repeated the same citation.
  await until(() => restarted.contexts.size === 1); await delay(20); assert.equal(requests, 2); assert.equal(app.current().initiativeRuntime.sdkState.failureCount, 1);
  clock = due; restarted.schedule(); await until(() => app.current().initiativeRuntime.sdkState.failureCount === 0);
  assert.equal(requests, 3); assert.equal(app.current().initiativeRuntime.lastFailure.recoveredAt, clock); assert.equal(readFileSync(join(archive, files[0]), 'utf8'), original);
});

test('finite background allowance rejects the step-limit conclusion before another paid call and retains the actual failure code and journal', async t => {
  let requests = 0;
  // Budgets leave room for one decision (reserved by prompt size: about 23k here) and one 15k work request, not a second
  // request (about 17k estimated): some 5k of margin either way, so the decision prompt can grow without this timing out.
  const app = await fixture(t, { workMaxSteps: 1, beforeStart: ({ store, project }) => store.mutate(state => { state.settings.realTokenBudget = 28000; state.projects.find(row => row.id === project.id).initiative.tokenBudget = 31000; }),
    decisionProvider: decisions(input => decision(input, 'work', 'Inspect evidence within the finite allowance')),
    runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* () {
      requests++; yield { type: 'tool_call', id: 'one-read', name: 'project_read', arguments: { path: 'evidence.txt' } };
      yield { type: 'usage', usage: { input: 12000, output: 3000, totalTokens: 15000 } }; yield { type: 'done', stopReason: 'toolUse' };
    } })
  });
  await until(() => app.current().jobs[0]?.status === 'failed' && app.current().initiativeRuntime.sdkState.reservedTokens === 0);
  assert.equal(requests, 1); assert.equal(app.current().jobs[0].errorCode, 'budget'); assert.equal(app.current().jobs[0].usage.totalTokens, 15000); assert.equal(app.current().initiativeRuntime.sdkState.actions[0].errorCode, 'budget'); assert.equal(app.store.state.realUsage.reportedTokens, 15020); assert.equal(app.store.state.realUsage.reservedTokens, 0);
  const records = readFileSync(app.current().jobs[0].runtimeFile, 'utf8').trim().split('\n').map(JSON.parse); assert.equal(records.filter(row => row.type === 'request_started').length, 1); assert.ok(records.some(row => row.type === 'run_settled' && row.data.code === 'budget'));
});

test('tightening an unlimited or finite global/project budget stops the next background request and charges the admitted request once', async t => {
  for (const [kind, initial] of [['global', null], ['project', null], ['global', 50000], ['project', 50000]]) {
    const entered = hold(), release = hold(); let calls = 0;
    t.after(() => release.resolve());
    const app = await fixture(t, { beforeStart: ({ store, project }) => store.mutate(state => { state.settings.realTokenBudget = kind === 'global' ? initial : null; state.projects.find(row => row.id === project.id).initiative.tokenBudget = kind === 'project' ? initial : null; }),
      decisionProvider: decisions(input => decision(input, 'work', 'Inspect evidence')),
      runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* () {
        calls++; entered.resolve(); await release.promise;
        yield { type: 'tool_call', id: 'read-once', name: 'project_read', arguments: { path: 'evidence.txt' } }; yield { type: 'usage', usage: { input: 80, output: 20, totalTokens: 100 } }; yield { type: 'done', stopReason: 'toolUse' };
      } })
    });
    await entered.promise;
    app.store.mutate(state => { if (kind === 'global') state.settings.realTokenBudget = 1; else state.projects.find(row => row.id === app.project.id).initiative.tokenBudget = 1; });
    release.resolve(); await until(() => app.current().jobs[0]?.status === 'failed' && app.store.state.realUsage.reservedTokens === 0);
    assert.equal(calls, 1); assert.equal(app.current().jobs[0].errorCode, 'budget'); assert.equal(app.current().jobs[0].usage.totalTokens, 100); assert.equal(app.current().initiativeRuntime.sdkState.usedTokens, 120); assert.equal(app.store.state.realUsage.reportedTokens, 120); assert.equal(app.store.state.realUsage.estimatedTokens, 0);
    await app.controller.close();
  }
});

test('two background projects cannot reuse the same newly finite global allowance at their next request boundary', async t => {
  const nextBoundary = hold(), finish = hold(); const arrivals = [], estimates = [], decisionsSeen = []; let admittedSecondRequests = 0;
  t.after(() => { nextBoundary.resolve(); finish.resolve(); });
  const app = await fixture(t, { beforeStart: ({ store, directory }) => {
    const second = store.createProject({ rhythm: { control: 'manual' }, name: 'Second independent workspace', description: 'Inspect evidence', workspace: directory }).project;
    store.mutate(state => { state.settings.realTokenBudget = null; for (const project of state.projects) { project.decisionMode = 'rna-model'; project.simulated = false; project.initialization = { status: 'ready' }; project.initiative.tokenBudget = null; project.assignments = { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] }; } });
    assert.ok(second.id);
  }, decisionProvider: decisions(input => input.events.some(event => event.type === 'action_completed') ? decision(input) : decision(input, 'work', 'Read current evidence'), decisionsSeen),
    runtimeFactory: options => { let boundaries = 0, requests = 0; return createRnaRuntime({ ...options,
      beforeCompletion: async input => {
        if (++boundaries === 2) { estimates.push(Math.ceil(input.estimatedInputTokens + input.maxOutputTokens + 1536)); arrivals.push(options.project.id); await nextBoundary.promise; }
        await options.beforeCompletion(input);
      }, provider: async function* () {
        if (++requests === 1) yield { type: 'tool_call', id: 'read-once', name: 'project_read', arguments: { path: 'evidence.txt' } };
        else { admittedSecondRequests++; await finish.promise; yield { type: 'text_delta', delta: 'Read evidence verified; remaining compatibility cases are missing.' }; }
        yield { type: 'usage', usage: { totalTokens: 100, input: 80, output: 20 } }; yield { type: 'done', stopReason: requests === 1 ? 'toolUse' : 'stop' };
      } }); }
  });
  await until(() => arrivals.length === 2 && app.store.state.realUsage.reservedTokens === 0);
  const alreadySpent = app.store.state.realUsage.tokens, cap = alreadySpent + Math.max(...estimates);
  app.store.mutate(state => { state.settings.realTokenBudget = cap; }); nextBoundary.resolve();
  await until(() => admittedSecondRequests === 1 && app.store.state.projects.some(project => project.jobs.some(job => job.status === 'failed')));
  assert.equal(admittedSecondRequests, 1); assert.ok(app.store.state.realUsage.tokens + app.store.state.realUsage.reservedTokens <= cap); assert.equal(app.store.state.projects.flatMap(project => project.jobs).filter(job => job.errorCode === 'budget').length, 1);
  finish.resolve(); await until(() => app.store.state.projects.some(project => project.jobs.some(job => job.status === 'completed')) && app.store.state.realUsage.reservedTokens === 0);
  assert.equal(admittedSecondRequests, 1); assert.equal(app.store.state.projects.flatMap(project => project.jobs).reduce((sum, job) => sum + job.usage.totalTokens, 0), 300); assert.equal(app.store.state.realUsage.reportedTokens, 300 + decisionsSeen.length * 20);
});

test('background receipts settle before midnight so a continuing action does not charge prior-day usage twice', async t => {
  let clock = Date.UTC(2026, 8, 24, 23, 59, 50), requests = 0; const boundary = hold(), release = hold(), decisionsSeen = [];
  t.after(() => release.resolve());
  const app = await fixture(t, { now: () => clock, beforeStart: ({ store, project }) => store.mutate(state => { state.settings.realTokenBudget = null; state.projects.find(row => row.id === project.id).initiative.tokenBudget = null; }),
    decisionProvider: decisions(input => input.events.some(event => event.type === 'action_completed') ? decision(input) : decision(input, 'work', 'Read evidence'), decisionsSeen),
    runtimeFactory: options => { let calls = 0; return createRnaRuntime({ ...options, beforeCompletion: async input => { if (++calls === 2) { boundary.resolve(); await release.promise; } await options.beforeCompletion(input); }, provider: async function* () {
      requests++; if (requests === 1) yield { type: 'tool_call', id: 'first-day', name: 'project_read', arguments: { path: 'evidence.txt' } }; else yield { type: 'text_delta', delta: 'Evidence read across the date boundary.' };
      yield { type: 'usage', usage: { totalTokens: 100, input: 80, output: 20 } }; yield { type: 'done', stopReason: requests === 1 ? 'toolUse' : 'stop' };
    } }); }
  });
  await boundary.promise; await until(() => app.store.state.realUsage.tokens === 120 && app.store.state.realUsage.reservedTokens === 0); assert.equal(app.store.state.realUsage.day, '2026-09-24');
  clock += 20000; release.resolve(); await until(() => app.current().jobs[0]?.status === 'completed' && app.store.state.realUsage.reservedTokens === 0);
  assert.equal(app.store.state.realUsage.day, '2026-09-25'); assert.equal(app.current().jobs[0].usage.totalTokens, 200); assert.equal(app.store.state.realUsage.reportedTokens, 100 + (decisionsSeen.length - 1) * 20); assert.equal(app.current().initiativeRuntime.sdkState.usedTokens, 200 + decisionsSeen.length * 20);
});

test('autonomous evolution obeys budget tightening after proposal, baseline, candidate and judge requests without recharging settled usage', async t => {
  for (const holdAt of [1, 2, 4, 6]) {
    const entered = hold(), release = hold(), calls = []; let dispatched = 0;
    t.after(() => release.resolve());
    const generated = genomeEvaluationProvider({ calls });
    const app = await fixture(t, { beforeStart: async ({ store, project }) => {
      const prepared = await new ProjectGenomeStore(store).prepare(project, { genome: projectGenomeFixture(), versionId: project.activeVersionId }); await prepared.commit();
      store.mutate(state => { state.settings.realTokenBudget = null; const target = state.projects.find(row => row.id === project.id); target.initiative.tokenBudget = null; target.versions.find(version => version.id === project.activeVersionId).bundle = prepared.record; });
    }, decisionProvider: decisions(input => decision(input, 'learn', 'Improve checked evidence handling')),
      evolutionProvider: async function* (request) { if (++dispatched === holdAt) { entered.resolve(); await release.promise; } yield* generated(request); }
    });
    await entered.promise;
    assert.equal(app.store.state.realUsage.reportedTokens, 20 + (holdAt - 1) * 30);
    app.store.mutate(state => { if (holdAt % 4 === 0) state.projects.find(row => row.id === app.project.id).initiative.tokenBudget = 1; else state.settings.realTokenBudget = 1; });
    release.resolve(); await until(() => app.current().jobs[0]?.status === 'failed' && app.store.state.realUsage.reservedTokens === 0);
    assert.equal(calls.length, holdAt); assert.equal(dispatched, holdAt); assert.equal(app.current().jobs[0].errorCode, 'budget'); assert.equal(app.current().jobs[0].usage.totalTokens, holdAt * 30); assert.equal(app.current().initiativeRuntime.sdkState.actions[0].status, 'failed'); assert.equal(app.current().initiativeRuntime.sdkState.actions[0].errorCode, 'budget');
    assert.equal(app.store.state.realUsage.reportedTokens, 20 + holdAt * 30); assert.equal(app.store.state.realUsage.estimatedTokens, 0); assert.equal(app.current().initiativeRuntime.sdkState.usedTokens, 20 + holdAt * 30); assert.equal(app.current().initiativeRuntime.sdkState.events.filter(event => event.type === 'action_completed').length, 0);
    const candidate = app.current().versions.find(version => version.source === 'autonomous-project-evolution'); assert.equal(candidate.state, 'failed'); assert.equal(candidate.error.code, 'budget'); assert.equal(candidate.usage.totalTokens, holdAt * 30); assert.equal(app.current().activeVersionId, candidate.parentVersionId);
    await app.controller.close();
  }
});

test('autonomous evolution unknown-usage estimates are settled per request and reconciled once with its final report', async t => {
  const calls = [], decisionsSeen = [], generated = genomeEvaluationProvider({ calls }); let requestNumber = 0;
  const app = await fixture(t, { beforeStart: async ({ store, project }) => {
    const prepared = await new ProjectGenomeStore(store).prepare(project, { genome: projectGenomeFixture(), versionId: project.activeVersionId }); await prepared.commit();
    store.mutate(state => { const target = state.projects.find(row => row.id === project.id); target.versions.find(version => version.id === project.activeVersionId).bundle = prepared.record; });
  }, decisionProvider: decisions(input => input.events.some(event => event.type === 'action_completed') ? decision(input) : decision(input, 'learn', 'Improve evidence'), decisionsSeen),
    evolutionProvider: async function* (request) { const index = ++requestNumber; for await (const event of generated(request)) if (index !== 1 || event.type !== 'usage') yield event; }
  });
  await until(() => app.current().versions.some(version => version.state === 'ready') && app.store.state.realUsage.reservedTokens === 0);
  const candidate = app.current().versions.find(version => version.state === 'ready'); assert.equal(calls.length, 16); assert.ok(candidate.usage.estimatedTokens > 0); assert.equal(candidate.usage.totalTokens, candidate.usage.estimatedTokens + 15 * 30);
  assert.equal(app.store.state.realUsage.estimatedTokens, candidate.usage.estimatedTokens); assert.equal(app.current().initiativeRuntime.sdkState.estimatedTokens, candidate.usage.estimatedTokens); assert.equal(app.store.state.realUsage.reportedTokens, 15 * 30 + decisionsSeen.length * 20); assert.equal(app.current().initiativeRuntime.sdkState.usedTokens, candidate.usage.totalTokens + decisionsSeen.length * 20);
});

const addDeletedConversationEvidence = ({ store, session }) => store.mutate(state => {
  state.sessions.find(row => row.id === session.id).items.push({ id: 'deleted-background-evidence', kind: 'user', text: 'DELETED_PRIVATE_BACKGROUND_CONTEXT', createdAt: new Date().toISOString(), simulated: false });
});

test('session deletion waits for the real read-only cancellation checkpoint before unlinking; the barrier admits no new target review', { timeout: 20000 }, async t => {
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  const entered = hold(), checkpoint = hold(), release = hold(); t.after(() => release.resolve());
  let workRequests = 0, firstDecision = true;
  const seen = [];
  const app = await fixture(t, { beforeStart: addDeletedConversationEvidence, decisionProvider: decisions(input => { if (firstDecision) { firstDecision = false; return decision(input, 'work', 'Inspect the isolated file', input.events.find(event => event.type === 'user_message').id); } return decision(input); }, seen), runtimeFactory: options => createSession({ ...options, tools: [{ name: 'async_read', effect: 'read', idempotent: true, parameters: { type: 'object' }, execute: async (_id, _args, signal) => {
    entered.resolve(); await new Promise((resolve, reject) => { const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
  } }], provider: async function* () { workRequests++; yield { type: 'tool_call', id: 'async-read', name: 'async_read', arguments: {} }; yield { type: 'done', stopReason: 'toolUse' }; } }) });
  await entered.promise;
  const context = app.controller.contexts.get(app.project.id), originalSave = context.coordinator.saveState;
  context.coordinator.saveState = async (...args) => { if (app.controller.deletionPending(app.project.id)) { checkpoint.resolve(); await release.promise; } return originalSave(...args); };
  const dir = join(`${app.store.file}.rna`, app.session.id); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'chat.jsonl'), 'owned conversation journal');
  const service = new SessionDeletionService(app.store, { projectInitiative: app.controller }); t.after(() => service.close());
  app.store.deleteSession(app.session.id); await checkpoint.promise;
  const requestsAtDeletion = seen.length, result = await service.wait(app.session.id, 25);
  assert.equal(result.status, 'pending'); assert.equal(result.localStatus, 'pending'); assert.equal(existsSync(dir), true);
  for (let i = 0; i < 10; i++) await app.controller.pump();
  assert.equal(seen.length, requestsAtDeletion); assert.equal(workRequests, 1); assert.equal(app.controller.valid(context), false);
  release.resolve(); const stopped = await service.wait(app.session.id); assert.equal(stopped.status, 'completed', JSON.stringify({ stopped, unsettled: context.coordinator.unsettled.size, handles: context.activeHandles.size, active: context.coordinator.active.size, workRuns: context.workRuns.size, jobs: app.current().jobs.map(job => ({ status: job.status, errorCode: job.errorCode })) })); assert.equal(existsSync(dir), false);
  const action = app.current().initiativeRuntime.sdkState.actions.find(action => action.action === 'work');
  assert.equal(action.status, 'needs_review'); assert.equal(action.resolutionSource, undefined);
  assert.notEqual(action.blocksExecution, true); assert.equal(app.current().jobs.find(job => job.id === action.id).status, 'cancelled');
  const other = app.store.createProject({ rhythm: { control: 'manual' }, name: 'Unaffected project', workspace: app.directory });
  app.store.mutate(state => { const project = state.projects.find(project => project.id === other.project.id); project.decisionMode = 'rna-model'; project.simulated = false; project.initialization = { status: 'ready' }; });
  await until(() => seen.some(input => input.project.id === other.project.id), 'other project runs after cleanup');
});

test('unsettled background side effects keep deletion pending, block target requests, and retain needs_review after cleanup', { timeout: 20000 }, async t => {
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  const entered = hold(), release = hold(); t.after(() => release.resolve()); let workRequests = 0, firstDecision = true;
  const seen = [];
  const app = await fixture(t, { beforeStart: addDeletedConversationEvidence, decisionProvider: decisions(input => { if (firstDecision) { firstDecision = false; return decision(input, 'work', 'Check one isolated operation', input.events.find(event => event.type === 'user_message').id); } return decision(input); }, seen), runtimeFactory: options => createSession({ ...options, tools: [{ name: 'uncertain_operation', effect: 'write', parameters: { type: 'object' }, execute: async () => {
    entered.resolve(); await release.promise; return { isError: true, content: [{ type: 'text', text: 'Isolated operation ended without an acknowledged outcome.' }], details: { cleanupUncertain: true } };
  } }], provider: async function* () { workRequests++; yield { type: 'tool_call', id: 'pending-effect', name: 'uncertain_operation', arguments: {} }; yield { type: 'done', stopReason: 'toolUse' }; } }) });
  await entered.promise; const context = app.controller.contexts.get(app.project.id);
  const dir = join(`${app.store.file}.rna`, app.session.id); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'chat.jsonl'), 'owned conversation journal');
  const service = new SessionDeletionService(app.store, { projectInitiative: app.controller }); t.after(() => service.close());
  app.store.deleteSession(app.session.id);
  const result = await service.wait(app.session.id);
  assert.equal(result.status, 'pending'); assert.equal(result.localStatus, 'pending'); assert.equal(result.code, 'SESSION_BACKGROUND_CLEANUP_PENDING');
  assert.equal(existsSync(dir), true); assert.ok(context.coordinator.unsettled.size > 0); assert.ok(context.activeHandles.size > 0);
  const atBarrier = seen.length; for (let i = 0; i < 10; i++) await app.controller.pump();
  assert.equal(seen.length, atBarrier); assert.equal(workRequests, 1);
  await app.controller.close(); assert.equal(app.controller.contexts.get(app.project.id), context);
  await assert.rejects(app.controller.drainDeletedSession(app.store.state.sessionDeletions.find(record => record.sessionId === app.session.id)), { code: 'SESSION_BACKGROUND_CLEANUP_PENDING' });
  const pending = app.current().initiativeRuntime.sdkState.actions.find(action => action.action === 'work'); assert.equal(pending.status, 'needs_review');
  release.resolve(); await until(() => !context.coordinator.unsettled.size && !context.activeHandles.size, 'old handler and SDK journal writer settle');
  // It cannot clear on its own: the record waits for the user's decision (review X-1), not for a timer.
  const stopped = await service.clean(app.session.id, { retry: true }); assert.equal(stopped.status, 'blocked'); assert.equal(stopped.code, 'SESSION_BACKGROUND_EXECUTION_UNCONFIRMED'); assert.equal(stopped.decision, 'execution'); assert.equal(stopped.retryAt, null); assert.equal(existsSync(dir), true);
  const receipt = app.current().initiativeRuntime.sdkState.actions.find(action => action.id === pending.id);
  assert.equal(receipt.status, 'needs_review'); assert.equal(receipt.resolutionSource, undefined); assert.equal(receipt.resolvedAt, undefined);
  const job = app.current().jobs.find(job => job.id === pending.id); assert.equal(job.status, 'needs_review'); assert.equal(job.errorCode, 'uncertain_tool');
  assert.equal(receipt.blocksExecution, true, 'Late journal uncertainty must upgrade the earlier aborted action'); assert.equal(receipt.errorCode, 'uncertain_tool');
  assert.equal(existsSync(job.runtimeFile), true); assert.match(readFileSync(job.runtimeFile, 'utf8'), /tool_uncertain/);
  assert.equal(app.controller.contexts.has(app.project.id), false);
  const reopened = new ProjectInitiativeController(app.store, { initialDelayMs: 86400000, tickIntervalMs: 0, decisionProvider: async function* () { assert.fail('Deletion recovery must not request a model'); } }); t.after(() => reopened.close());
  service.projectInitiative = reopened;
  await reopened.resolveAction(app.project.id, receipt.id, { status: 'not-executed', summary: 'Explicit fixture review of the entire action: the controlled tool only waited in memory, made no external mutation, and has fully exited. No operation may be replayed.' });
  assert.equal((await service.clean(app.session.id, { retry: true })).status, 'completed'); assert.equal(existsSync(dir), false); assert.equal(existsSync(job.runtimeFile), false);
  assert.equal(app.current().initiativeRuntime.sdkState.actions.find(action => action.id === receipt.id).resolutionSource, 'user');
  assert.equal(workRequests, 1);
});

test('startup reconciles an older aborted action with its stronger durable uncertain job without clearing or replaying it', async t => {
  const app = await fixture(t, { initialDelayMs: 999999, beforeStart: ({ store, project }) => store.mutate(state => {
    const p = state.projects.find(row => row.id === project.id);
    const make = (id, overrides = {}) => ({ id, action: 'work', status: 'needs_review', evidenceIds: [], content: 'Retained fixture intention', errorCode: 'interrupted', ...overrides });
    p.initiativeRuntime = { sdkState: { schemaVersion: 1, revision: 1, decisionRevision: 1, events: [], seenEventIds: [], actions: [make('legacy'), make('ordinary'), make('resolved', { status: 'cancelled', resolvedAt: 123, resolutionSource: 'user', resolutionOutcome: 'cancelled' })], usedTokens: 50, reservedTokens: 0 } };
    p.jobs = ['legacy', 'resolved'].map(id => ({ id, lane: 'background', simulated: false, status: 'needs_review', errorCode: 'uncertain_tool', output: 'Original unconfirmed tool receipt', failure: { id: `${id}-failure`, code: 'uncertain_tool', message: 'Original recorded cleanup uncertainty', at: 100 } }));
  }) });
  await until(() => app.controller.contexts.get(app.project.id)?.initialized);
  const saved = app.current().initiativeRuntime.sdkState, legacy = saved.actions.find(a => a.id === 'legacy');
  assert.equal(legacy.status, 'needs_review'); assert.equal(legacy.blocksExecution, true); assert.equal(legacy.errorCode, 'uncertain_tool'); assert.equal(legacy.failure.id, 'legacy-failure'); assert.equal(legacy.failure.at, 100);
  assert.equal(saved.actions.find(a => a.id === 'ordinary').blocksExecution, undefined);
  assert.equal(saved.actions.find(a => a.id === 'resolved').status, 'cancelled'); assert.equal(saved.actions.find(a => a.id === 'resolved').blocksExecution, undefined);
  assert.equal(app.current().jobs[0].output, 'Original unconfirmed tool receipt'); assert.equal(app.current().jobs[0].status, 'needs_review'); assert.equal(app.calls.length, 0);
  const before = readFileSync(app.store.file, 'utf8'); app.controller.recover(); assert.equal(readFileSync(app.store.file, 'utf8'), before, 'Repeated recovery does not rewrite aligned receipts');
  assert.equal(app.controller.health().projects.find(p => p.projectId === app.project.id).executionBlocked, true);
});


test('foreground handoff waits for actual background writer disposal while keeping saved grants and the next background turn read-only', async t => {
  const entered = hold(), disposing = hold(), releaseDispose = hold(); let calls = 0, options, aborts = 0;
  t.after(() => releaseDispose.resolve());
  const app = await fixture(t, {
    beforeStart: ({ store, project }) => store.mutate(state => { const p = state.projects.find(row => row.id === project.id); p.permissions = { workspace: 'execute', background: 'inherit', revision: 1 }; p.assignments.toolIds = ['project_read', 'project_write']; }),
    decisionProvider: decisions(input => decision(input, calls++ === 0 ? 'work' : 'wait', calls === 1 ? 'Inspect and improve one fixture file' : '')),
    runtimeFactory: async value => { options = value; return {
      prompt: () => new Promise((_, reject) => { entered.resolve(); if (value.signal.aborted) reject(value.signal.reason); else value.signal.addEventListener('abort', () => reject(value.signal.reason), { once: true }); }),
      abort: () => { aborts++; },
      snapshot: () => ({ messages: [], sessionFile: '/isolated/no-live-journal', recovery: { uncertainTools: [] } }),
      dispose: async () => { disposing.resolve(); await releaseDispose.promise; }
    }; }
  });
  await entered.promise; assert.equal(options.readOnly, false);
  app.store.message(app.session.id, { text: 'Take over this project in the foreground.' });
  await disposing.promise;
  const context = app.controller.contexts.get(app.project.id); assert.equal(context.activeHandles.size, 1, 'abort result must not remove a still-disposing handle');
  assert.equal(options.getProject().permissions.background, 'read', 'every subsequent tool sees foreground read-only scope');
  let admitted = false, stopped = null; const admission = app.controller.prepareForeground(app.project.id, { signal: new AbortController().signal }).then(value => { admitted = true; stopped = value; });
  await delay(20); assert.equal(admitted, false); assert.ok(aborts > 0);
  releaseDispose.resolve(); await admission;
  // What was stopped comes back, so the turn can say so in the conversation and build on it.
  assert.deepEqual(stopped.map(row => row.task), ['Inspect and improve one fixture file']);
  assert.equal(context.activeHandles.size, 0); assert.equal(context.workRuns.size, 0);
  assert.deepEqual(app.current().permissions, { workspace: 'execute', background: 'inherit', revision: 1 });
  const projected = app.controller.snapshot(app.current()); assert.equal(projected.actionContracts.work.foregroundBusy, true); assert.equal(projected.actionContracts.work.permissions.effective.background, 'read');
  const session = app.store.state.sessions.find(row => row.id === app.session.id); app.store.finishRuntimeTurn(app.session.id, session.activeTurnId);
  assert.equal(app.controller.backgroundProject(app.current()).permissions.background, 'inherit');
});

test('foreground writer drain is bounded and abort-aware; later retries still wait for the same disposal', async t => {
  const entered = hold(), disposing = hold(), releaseDispose = hold(); let calls = 0;
  t.after(() => releaseDispose.resolve());
  const app = await fixture(t, { foregroundDrainTimeoutMs: 30,
    beforeStart: ({ store, project }) => store.mutate(state => { state.projects.find(row => row.id === project.id).permissions = { workspace: 'execute', background: 'inherit', revision: 1 }; }),
    decisionProvider: decisions(input => decision(input, calls++ === 0 ? 'work' : 'wait', calls === 1 ? 'Bounded writer' : '')),
    runtimeFactory: async value => ({ prompt: () => new Promise((_, reject) => { entered.resolve(); value.signal.addEventListener('abort', () => reject(value.signal.reason), { once: true }); }), abort: () => {}, snapshot: () => ({ messages: [], recovery: { uncertainTools: [] } }), dispose: async () => { disposing.resolve(); await releaseDispose.promise; } })
  });
  await entered.promise; app.store.message(app.session.id, { text: 'Foreground takes priority.' }); await disposing.promise;
  await assert.rejects(app.controller.prepareForeground(app.project.id), { code: 'background_recovery_required' });
  assert.equal(app.controller.contexts.get(app.project.id).workRuns.size, 1);
  const stop = new AbortController(); const waiting = app.controller.prepareForeground(app.project.id, { signal: stop.signal }); stop.abort(Object.assign(new Error('User stopped the foreground'), { code: 'user_stopped' }));
  await assert.rejects(waiting, { code: 'user_stopped' }); assert.equal(app.controller.contexts.get(app.project.id).workRuns.size, 1);
  releaseDispose.resolve(); await until(() => app.controller.contexts.get(app.project.id).workRuns.size === 0);
  await app.controller.prepareForeground(app.project.id);
});

test('read-only background work is not cancelled by foreground admission, while unknown effects still refuse it', async t => {
  const entered = hold(), release = hold(); let calls = 0, aborted = false;
  t.after(() => release.resolve());
  const app = await fixture(t, { decisionProvider: decisions(input => decision(input, calls++ === 0 ? 'work' : 'wait', calls === 1 ? 'Read retained evidence' : '')),
    runtimeFactory: async options => ({ prompt: async () => { entered.resolve(); await release.promise; }, abort: () => { aborted = true; }, snapshot: () => ({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Retained result' }] }] }), dispose: async () => {} })
  });
  await entered.promise; await app.controller.prepareForeground(app.project.id);
  assert.equal(aborted, false); assert.equal(app.controller.contexts.get(app.project.id).workRuns.size, 1);
  const context = app.controller.contexts.get(app.project.id);
  context.coordinator.state.actions.push({ id: 'unknown-effect', action: 'work', status: 'needs_review', blocksExecution: true, evidenceIds: [], content: 'An earlier external operation' });
  await assert.rejects(app.controller.prepareForeground(app.project.id), { code: 'background_recovery_required' }); assert.equal(aborted, false);
  await context.coordinator._persist(); release.resolve(); await until(() => context.coordinator.active.size === 0);
  await app.controller.close(); assert.equal(app.controller.contexts.size, 0);
  await assert.rejects(app.controller.prepareForeground(app.project.id), { code: 'background_recovery_required' }, 'a paused/offline project must not bypass its durable unknown receipt');
});


test('a failed background runtime disposal remains uncertain and cannot admit a foreground writer', async t => {
  let calls = 0;
  const app = await fixture(t, {
    beforeStart: ({ store, project }) => store.mutate(state => { state.projects.find(row => row.id === project.id).permissions = { workspace: 'execute', background: 'inherit', revision: 1 }; }),
    decisionProvider: decisions(input => decision(input, calls++ === 0 ? 'work' : 'wait', calls === 1 ? 'One bounded operation' : '')),
    runtimeFactory: async () => ({ prompt: async () => {}, abort: () => {}, snapshot: () => ({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Work model returned, cleanup still required.' }] }] }), dispose: async () => { throw new Error('Injected child cleanup failure'); } })
  });
  await until(() => app.current().initiativeRuntime?.sdkState.actions.some(action => action.blocksExecution));
  const context = app.controller.contexts.get(app.project.id);
  assert.equal(context.activeHandles.size, 1); assert.equal(context.workRuns.size, 1);
  assert.equal(app.current().jobs.at(-1).status, 'needs_review'); assert.equal(app.current().jobs.at(-1).errorCode, 'process_cleanup_uncertain');
  await assert.rejects(app.controller.prepareForeground(app.project.id), { code: 'background_recovery_required' });
});

test('during a foreground turn the real background SDK still inspects evidence; declared write or exec tools are rejected at execution', async t => {
  let calls = 0, requests = 0;
  const app = await fixture(t, {
    // PDL-2: a decision during a foreground turn needs evidence independent of the turn (here a report from elsewhere);
    // the turn's own message is observed and waits for the turn's end.
    beforeStart: ({ store, project, session }) => { store.mutate(state => { const p = state.projects.find(row => row.id === project.id); p.permissions = { workspace: 'execute', background: 'inherit', revision: 1 }; p.assignments.toolIds = ['project_read', 'project_write', 'project_exec']; }); store.message(session.id, { text: 'I am editing the same project in the foreground.' }); },
    decisionProvider: decisions(input => decision(input, calls++ === 0 ? 'work' : 'wait', calls === 1 ? 'Read the existing evidence without modifying the foreground workspace' : '')),
    runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* (request) {
      requests++; assert.equal(options.readOnly, true); assert.ok(['project_write', 'project_exec'].every(name => request.tools.some(tool => tool.name === name)), 'declared for a stable prefix');
      yield { type: 'usage', usage: { totalTokens: 10 } };
      if (requests === 1) { yield { type: 'tool_call', id: 'read-existing-fact', name: 'project_read', arguments: { path: 'evidence.txt' } }; yield { type: 'tool_call', id: 'rejected-write', name: 'project_write', arguments: { path: 'evidence.txt', content: 'overwritten' } }; yield { type: 'done', stopReason: 'toolUse' }; }
      else { assert.match(JSON.stringify(request.messages), /compatibility: second input variant is missing/); assert.match(JSON.stringify(request.messages.find(message => message.toolCallId === 'rejected-write')), /Read-only authorization: writes are rejected/); yield { type: 'text_delta', delta: 'The retained compatibility evidence lacks the second input variant.' }; yield { type: 'done', stopReason: 'stop' }; }
    } })
  });
  await until(() => app.controller.contexts.get(app.project.id)?.initialized, 'context');
  app.store.mutate(state => { state.projects.find(row => row.id === app.project.id).observations.push({ id: 'ci-report', kind: 'external_report', text: 'CI: the second input variant is still missing.', status: 'pending', createdAt: new Date().toISOString(), simulated: false }); });
  await until(() => app.current().jobs.some(job => job.status === 'completed'));
  assert.equal(requests, 2); assert.equal(readFileSync(join(app.directory, 'evidence.txt'), 'utf8'), 'compatibility: second input variant is missing');
  assert.equal(app.current().permissions.background, 'inherit');
  assert.equal(app.store.state.sessions.find(row => row.id === app.session.id).status, 'running');
});

test('直接处理: a finding JEV marks as objective fixes is applied in the background, then kept or reverted from a card', async t => {
  const { UserInteractionService } = await import('../user-interaction-service.mjs');
  let interactions;
  const provider = decisions(input => {
    const completed = input.events.find(event => event.type === 'action_completed');
    if (completed) return decision(input, 'share', '审稿发现：第1章人名笔误，「周一来」应为「周一鸣」。回复即可按此修订。', completed.id);
    return decision(input, 'work', 'Review chapter 1 for name consistency');
  });
  const directCalls = [];
  const app = await fixture(t, {
    beforeStart: ({ store, project, directory }) => {
      writeFileSync(join(directory, 'chapter1.md'), '周一来推开门。');
      store.mutate(state => { const target = state.projects.find(row => row.id === project.id); target.permissions = { workspace: 'write', background: 'inherit' }; target.assignments = { skillIds: [], toolIds: ['project_read', 'project_edit', 'project_write'], mcpServerIds: [] }; });
    },
    get interactionService() { return interactions; },
    decisionService: { enabled: () => false, review: async () => ({ review: true }), directHandle: async (_project, { text }) => { directCalls.push(text); return true; } },
    decisionProvider: provider,
    runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* (request) {
      const text = JSON.stringify(request.messages);
      if (/Direct fix:/.test(text) && !request.messages.some(message => message.role === 'toolResult')) {
        yield { type: 'tool_call', id: 'edit1', name: 'project_edit', arguments: { path: 'chapter1.md', oldText: '周一来', newText: '周一鸣' } };
        yield { type: 'done', stopReason: 'toolUse' };
      } else { yield { type: 'text_delta', delta: /Direct fix:/.test(text) ? 'chapter1.md：「周一来」→「周一鸣」（1 处）。' : '第1章把周一鸣误写成周一来。' }; yield { type: 'done', stopReason: 'stop' }; }
      yield { type: 'usage', usage: { input: 10, output: 5, totalTokens: 15 } };
    } })
  });
  interactions = new UserInteractionService(app.store); app.controller.interactions = interactions; t.after(() => interactions.close());
  await until(() => (app.current().directFixes ?? []).length === 1, 'fix applied and card published');
  assert.equal(readFileSync(join(app.directory, 'chapter1.md'), 'utf8'), '周一鸣推开门。');
  assert.match(directCalls[0], /周一来/);
  const card = app.store.state.sessions.find(row => row.id === app.session.id).items.find(item => item.interaction?.id === app.current().directFixes[0].interactionId);
  assert.equal(card.interaction.questions[0].header, '已直接处理');
  assert.deepEqual(card.interaction.questions[0].options.map(option => option.id), ['keep', 'revert']);
  assert.match(card.interaction.questions[0].detail, /chapter1\.md/);
  assert.equal(app.messages().filter(item => item.kind === 'assistant').length, 0, 'the finding is not also asked as a plain message');
  interactions.answer(app.session.id, card.interaction.id, { requestId: 'r1', answers: [{ id: 'decision', selected: ['revert'] }] });
  app.controller.schedule();
  await until(() => app.current().directFixes[0].status === 'reverted', 'reverted');
  assert.equal(readFileSync(join(app.directory, 'chapter1.md'), 'utf8'), '周一来推开门。');
  assert.match(app.messages().at(-1).text, /已回退 1 个文件：chapter1\.md/);
  assert.equal(existsSync(`${app.store.file}.direct-fixes/${app.current().directFixes[0].id}`), false, 'snapshots are discarded once settled');
});

test('an actively used project with read-only background is offered, once, the choice to let the collaborator do the work', async t => {
  const { UserInteractionService } = await import('../user-interaction-service.mjs');
  const { ProjectPermissionService } = await import('../project-permissions.mjs');
  const { projectInteraction } = await import('../project-rhythm.mjs');
  const app = await fixture(t, { beforeStart: ({ store, project, session }) => store.mutate(state => {
    const target = state.projects.find(row => row.id === project.id); target.permissions = { workspace: 'write', background: 'read', revision: 0, source: 'default' };
    const conversation = state.sessions.find(row => row.id === session.id);
    for (const [index, text] of ['写第一章', '主角改成女性', '节奏再快一点'].entries()) conversation.items.push({ id: `u${index}`, kind: 'user', text, createdAt: new Date(Date.now() - (3 - index) * 60000).toISOString() });
    target.mind = { ...(target.mind ?? {}), lessons: [{ id: 'l1', kind: 'preference', text: '节奏要快', status: 'active', source: { kind: 'correction' }, createdAt: new Date().toISOString() }], agenda: [] };
  }) });
  const interaction = projectInteraction(app.store.state, app.current(), { now: Date.now() });
  assert.equal(interaction.recentUserMessages, 3); assert.equal(interaction.steering, 1); assert.ok(Date.now() - interaction.lastUserAt < 2 * 60000);
  const interactions = new UserInteractionService(app.store); t.after(() => interactions.close());
  Object.assign(app.controller, { interactions, permissionService: new ProjectPermissionService(app.store) });
  app.controller.offerBackgroundHelp(app.current());
  const cards = () => app.store.state.sessions.find(row => row.id === app.session.id).items.filter(item => item.interaction?.permission || item.interaction?.metadata?.kind === 'permission' || item.kind === 'question');
  assert.equal(cards().length, 1);
  assert.match(JSON.stringify(cards()[0].interaction.questions), /后台自主工作也使用此权限/);
  assert.ok(app.current().initiative.backgroundOfferAt);
  app.controller.offerBackgroundHelp(app.current());
  assert.equal(cards().length, 1, 'asked only once');
  // At 完全访问 (execute) background work is already covered: no card, the saved background follows.
  app.store.mutate(state => { const card = state.sessions.find(row => row.id === app.session.id).items.find(item => item.interaction)?.interaction; Object.assign(card, { status: 'cancelled', canRespond: false }); });
  app.store.mutate(state => { const target = state.projects.find(row => row.id === app.project.id); target.permissions = { workspace: 'execute', background: 'read', revision: 1, source: 'default' }; delete target.initiative.backgroundOfferAt; });
  app.controller.offerBackgroundHelp(app.current());
  assert.equal(cards().length, 1); assert.equal(app.current().permissions.background, 'inherit');
});

test('F10: in an English interface the background-help offer and the direct-fix worker task, card and detail are English; the worker task is English in any interface', async t => {
  const { UserInteractionService } = await import('../user-interaction-service.mjs');
  const { ProjectPermissionService } = await import('../project-permissions.mjs');
  // The background-help offer card.
  const offer = await fixture(t, { beforeStart: ({ store, project, session }) => store.mutate(state => {
    state.settings.interfaceLanguage = 'en';
    const target = state.projects.find(row => row.id === project.id); target.permissions = { workspace: 'write', background: 'read', revision: 0, source: 'default' };
    const conversation = state.sessions.find(row => row.id === session.id);
    for (const [index, text] of ['Write chapter one', 'Make the lead a woman', 'Faster pacing'].entries()) conversation.items.push({ id: `u${index}`, kind: 'user', text, createdAt: new Date(Date.now() - (3 - index) * 60000).toISOString() });
    target.mind = { ...(target.mind ?? {}), lessons: [{ id: 'l1', kind: 'preference', text: 'Keep the pace quick', status: 'active', source: { kind: 'correction' }, createdAt: new Date().toISOString() }], agenda: [] };
  }) });
  const offerInteractions = new UserInteractionService(offer.store); t.after(() => offerInteractions.close());
  Object.assign(offer.controller, { interactions: offerInteractions, permissionService: new ProjectPermissionService(offer.store) });
  offer.controller.offerBackgroundHelp(offer.current());
  const cards = offer.store.state.sessions.find(row => row.id === offer.session.id).items.filter(item => item.interaction?.permission || item.interaction?.metadata?.kind === 'permission' || item.kind === 'question');
  assert.equal(cards.length, 1);
  const [question] = cards[0].interaction.questions;
  assert.equal(question.header, 'Project permissions');
  assert.match(question.detail, /Requested: Read and write project files; background autonomous work uses this permission too/);
  assert.doesNotMatch(JSON.stringify(cards[0].interaction.questions), /[一-鿿]/, 'nothing Chinese on the card: not the reason, not the scope, not the labels');
  assert.deepEqual(question.options.map(option => option.id), ['allow', 'deny']);

  // 直接处理: the worker's task, the card and the detail under it.
  let interactions; const tasks = [];
  const provider = decisions(input => {
    const completed = input.events.find(event => event.type === 'action_completed');
    if (completed) return decision(input, 'share', 'Review found a name typo in chapter 1: "Zhou Lai" should be "Zhou Ming". Reply to have it revised.', completed.id);
    return decision(input, 'work', 'Review chapter 1 for name consistency');
  });
  const app = await fixture(t, {
    beforeStart: ({ store, project, directory }) => {
      writeFileSync(join(directory, 'chapter1.md'), 'Zhou Lai pushed the door open.');
      store.mutate(state => { state.settings.interfaceLanguage = 'en'; const target = state.projects.find(row => row.id === project.id); target.permissions = { workspace: 'write', background: 'inherit' }; target.assignments = { skillIds: [], toolIds: ['project_read', 'project_edit', 'project_write'], mcpServerIds: [] }; });
    },
    get interactionService() { return interactions; },
    decisionService: { enabled: () => false, review: async () => ({ review: true }), directHandle: async () => true },
    decisionProvider: provider,
    runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* (request) {
      const task = request.messages.find(message => message.role === 'user' && JSON.stringify(message).includes('Direct fix:'));
      if (task && !tasks.length) tasks.push(task.content[0].text); // the task itself; the retrieved-evidence part after it is separate host data
      if (task && !request.messages.some(message => message.role === 'toolResult')) {
        yield { type: 'tool_call', id: 'edit1', name: 'project_edit', arguments: { path: 'chapter1.md', oldText: 'Zhou Lai', newText: 'Zhou Ming' } };
        yield { type: 'done', stopReason: 'toolUse' };
      } else { yield { type: 'text_delta', delta: task ? 'chapter1.md: "Zhou Lai" to "Zhou Ming" (1 place).' : 'Chapter 1 spells Zhou Ming as Zhou Lai.' }; yield { type: 'done', stopReason: 'stop' }; }
      yield { type: 'usage', usage: { input: 10, output: 5, totalTokens: 15 } };
    } })
  });
  interactions = new UserInteractionService(app.store); app.controller.interactions = interactions; t.after(() => interactions.close());
  await until(() => (app.current().directFixes ?? []).length === 1, 'fix applied and card published');
  assert.equal(readFileSync(join(app.directory, 'chapter1.md'), 'utf8'), 'Zhou Ming pushed the door open.');
  assert.equal(tasks.length, 1, 'the worker received the direct-fix task');
  assert.match(tasks[0], /report written in English:/); assert.doesNotMatch(tasks[0], /[一-鿿]/, 'the task the worker model reads has no Chinese in it');
  const card = app.store.state.sessions.find(row => row.id === app.session.id).items.find(item => item.interaction?.id === app.current().directFixes[0].interactionId);
  const [fix] = card.interaction.questions;
  assert.deepEqual([fix.header, fix.question], ['Handled directly', 'I found a few clear-cut problems and fixed them directly (1 file). Keep these changes?']);
  assert.deepEqual(fix.options.map(option => [option.id, option.label]), [['keep', 'Keep changes'], ['revert', 'Revert these changes']]);
  assert.equal(fix.detail, 'chapter1.md: "Zhou Lai" to "Zhou Ming" (1 place).\n\nChanged files:\n- chapter1.md');
  assert.doesNotMatch(JSON.stringify(card.interaction.questions), /[一-鿿]/);
});

test('background work that stops on an unsent tool call is recorded as unreported, and its change line says what it was doing', async t => {
  const run = async (finalText) => {
    const app = await fixture(t, {
      beforeStart: ({ store, project, directory }) => {
        writeFileSync(join(directory, 'chapter1.md'), '第一章。');
        store.mutate(state => { const target = state.projects.find(row => row.id === project.id); target.permissions = { workspace: 'write', background: 'inherit' }; target.assignments = { skillIds: [], toolIds: ['project_read', 'project_write'], mcpServerIds: [] }; });
      },
      decisionService: { enabled: () => false, review: async () => ({ review: true }) },
      decisionProvider: decisions(input => input.events.some(event => event.type === 'action_completed') ? decision(input) : decision(input, 'work', '给第1章补一段结尾。然后核对人名。')),
      runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* (request) {
        if (!request.messages.some(message => message.role === 'toolResult')) { yield { type: 'tool_call', id: 'r1', name: 'project_read', arguments: { path: 'chapter1.md' } }; yield { type: 'tool_call', id: 'w1', name: 'project_write', arguments: { path: 'chapter1.md', content: '第一章。结尾。' } }; yield { type: 'done', stopReason: 'toolUse' }; }
        else { yield { type: 'text_delta', delta: finalText }; yield { type: 'done', stopReason: 'stop' }; }
        yield { type: 'usage', usage: { input: 10, output: 5, totalTokens: 15 } };
      } })
    });
    await until(() => (app.current().backgroundChanges ?? []).length === 1 && app.current().initiativeRuntime?.sdkState?.actions?.some(row => row.action === 'work' && row.status === 'completed'), 'work completed with its change set');
    const action = app.current().initiativeRuntime.sdkState.actions.find(row => row.action === 'work'), job = app.current().jobs.find(row => row.id === action.id);
    const line = app.messages().find(item => item.initiative?.backgroundChange === app.current().backgroundChanges[0].id);
    return { app, action, job, line };
  };
  const unsent = await run('写好了，再读回确认一下：\n<invoke name="project_read">\n<parameter name="path">chapter1.md</parameter>\n</invoke>');
  assert.match(unsent.job.output, /^未交接：/); assert.equal(unsent.job.unreported, true);
  assert.match(unsent.action.resultSummary, /^未交接：/); assert.doesNotMatch(unsent.action.resultSummary, /invoke/);
  assert.match(unsent.action.handoff, /^未交接：给第1章补一段结尾。然后核对人名。；工作者停在一个没有发出的工具调用上/);
  assert.match(unsent.line.text, /^这次后台在做：给第1章补一段结尾。\n\n它停在半途，没有留下完成汇报/);
  assert.equal(unsent.app.current().backgroundChanges[0].unreported, true);
  const reported = await run('第1章结尾已补。\n\n交接：给第1章补了一段结尾，人名还没核对。');
  assert.equal(reported.job.unreported, undefined); assert.equal(reported.action.handoff, '给第1章补了一段结尾，人名还没核对。');
  assert.equal(reported.line.text, '给第1章补了一段结尾，人名还没核对。\n\n改了 1 个文件，改动都在下面，可以逐个查看；需要的话可以一键回退。');
});

test('background work that fails after writing still lists its changes and can be reverted', async t => {
  const app = await fixture(t, {
    beforeStart: ({ store, project, directory }) => {
      writeFileSync(join(directory, 'chapter1.md'), '第一章。');
      store.mutate(state => { const target = state.projects.find(row => row.id === project.id); target.permissions = { workspace: 'write', background: 'inherit' }; target.assignments = { skillIds: [], toolIds: ['project_read', 'project_write'], mcpServerIds: [] }; });
    },
    decisionService: { enabled: () => false, review: async () => ({ review: true }) },
    decisionProvider: decisions(input => input.events.some(event => event.type === 'action_failed' || event.type === 'action_completed') ? decision(input) : decision(input, 'work', '给第1章补一段结尾。然后核对人名。')),
    runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* (request) {
      if (!request.messages.some(message => message.role === 'toolResult')) { yield { type: 'tool_call', id: 'r1', name: 'project_read', arguments: { path: 'chapter1.md' } }; yield { type: 'tool_call', id: 'w1', name: 'project_write', arguments: { path: 'chapter1.md', content: '第一章。结尾。' } }; yield { type: 'usage', usage: { input: 10, output: 5, totalTokens: 15 } }; yield { type: 'done', stopReason: 'toolUse' }; return; }
      yield { type: 'error', error: { message: 'upstream closed', code: 'server_unavailable', retryable: false } };
    } })
  });
  await until(() => (app.current().backgroundChanges ?? []).length === 1 && app.current().initiativeRuntime?.sdkState?.actions?.some(row => row.action === 'work' && ['failed', 'needs_review'].includes(row.status)), 'failed work with its change set');
  const change = app.current().backgroundChanges[0], line = app.messages().find(item => item.initiative?.backgroundChange === change.id);
  assert.equal(change.failed, true); assert.deepEqual(change.files.map(row => row.path), ['chapter1.md']);
  assert.match(line.text, /^这次后台在做：给第1章补一段结尾。\n\n它没有做完就停了。停之前已经改了 1 个文件/);
  const reverted = app.controller.revertBackgroundChange(app.project.id, change.id);
  assert.deepEqual(reverted.outcome.restored, ['chapter1.md']); assert.equal(readFileSync(join(app.directory, 'chapter1.md'), 'utf8'), '第一章。');
});

test('a decision that comes back unparseable is asked once more in the same wake instead of failing it', async t => {
  let attempts = 0;
  const provider = async function* (options) {
    attempts++;
    const input = JSON.parse(options.messages[0].content[0].text);
    yield { type: 'text_delta', delta: attempts === 1 ? '{"action": "wait", "reason": "未闭合' : JSON.stringify(decision(input)) };
    yield { type: 'usage', usage: { input: 12, output: 8, totalTokens: 20 } }; yield { type: 'done', stopReason: 'stop' };
  };
  const app = await fixture(t, { decisionProvider: provider });
  await until(() => attempts >= 2 && app.current().initiativeRuntime?.status !== 'reviewing', 'second attempt');
  await until(() => (app.current().mind?.pacing?.wake?.history ?? []).length >= 1 || app.current().initiativeRuntime?.lastFailure, 'wake settled');
  assert.equal(app.current().initiativeRuntime?.lastErrorCode ?? null, null, 'no failed wake');
  assert.equal(attempts, 2);
});
