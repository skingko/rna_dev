import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { DecisionService } from '../decision-service.mjs';
import { prepareJudgmentPolicy } from '../judgment-policy-service.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { ProjectLearningController } from '../project-learning-controller.mjs';
import { RuntimeController } from '../runtime-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { createDecisionKernel } from '../../../packages/sdk/src/decision-kernel.mjs';
import { createProjectSchedule } from '../../../packages/sdk/src/project-schedules.mjs';

async function until(check, label = 'condition', timeout = 5000) { const deadline = Date.now() + timeout; while (!check()) { if (Date.now() > deadline) throw Error(`Timeout: ${label}`); await delay(5); } }
const assessmentPlan = () => ({ version: 1, questions: {
  ...Object.fromEntries(['initiative_need','initiative_pause','schedule_need','evolution_need','memory_need'].map(key => [key, { type: 'boolean', instructions: `Main-model fixture criterion for ${key} using verified project evidence.`, criteria: { true: `Verified evidence supports ${key}.`, false: `Verified evidence contradicts ${key}; uncertainty remains unknown.` } }])),
  task_state: { type: 'choice', instructions: 'Compare retained execution evidence with the project delivery criteria.', criteria: { active: 'An explicitly requested verification remains unfinished.', complete: 'The requested checks all have successful delivery receipts.', unknown: 'The retained evidence is insufficient.' } },
  user_satisfaction: { type: 'score', instructions: 'Use only explicit feedback about the delivered result.', criteria: ['Explicitly rejected acceptance quality.', 'Explicitly confirmed acceptance requirements were met.'] },
} });
const answer = noul => new Response(JSON.stringify({ answers: {
  ...Object.fromEntries(['initiative_need','evolution_need','memory_need'].map(key => [key, { type: 'noul', noul }])),
  initiative_pause: { type: 'noul', noul: 1 - noul }, schedule_need: { type: 'noul', noul: .01 },
  task_state: { type: 'choice', choice: 'active', probabilities: { active: .99, complete: .005, unknown: .005 } }, user_satisfaction: { type: 'score', score: .8, confidence: .99 },
}, usage: { input_tokens: 42, output_tokens: 0 } }));
const hold = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
function fixture(t, { fetch: judgeFetch = async () => answer(.01), now = Date.now, autoRecall = false, withPlan = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-decision-routing-')), store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Isolated routing fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 4096, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall, autoStore: false } });
  const { project, session } = store.createProject({ name: 'Bounded routing project', description: 'Produce verified project deliverables', workspace: directory, rhythm: { control: 'manual' }, initiative: { cooldownMs: 0 } });
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); Object.assign(p, { decisionMode: 'rna-model', simulated: false, initialization: { status: 'ready' }, assignments: { skillIds: [], toolIds: ['project_read', 'project_list', 'openviking_search', 'openviking_read'], mcpServerIds: [] } }); p.initiative.tokenBudget = null; p.evolution.minIntervalMs = 0; state.settings.realTokenBudget = null; if (withPlan) p.judgmentPolicy = prepareJudgmentPolicy(assessmentPlan(), { project: p, source: { kind: 'main_model', method: 'initialization', providerId: provider.id, modelId: 'fixture', receiptId: 'completed-fixture-model-message', createdAt: new Date(now()).toISOString() } }); });
  writeFileSync(join(directory, 'main.js'), 'export const add = (a, b) => a + b;');
  const judgments = [], service = new DecisionService(store, { now, kernelFactory: options => createDecisionKernel({ ...options, timeoutMs: 800, fetch: async (url, init) => { const body = JSON.parse(init.body); judgments.push(body); return judgeFetch(url, init, judgments.length); } }) });
  service.update({ apiKey: 'isolated-routing-fixture-key', mode: 'active', modes: { 'initiative.review': 'active', 'evolution.review': 'active', 'chat.preflight': 'active' } });
  const controllers = [], current = () => store.state.projects.find(row => row.id === project.id), conversation = () => store.state.sessions.find(row => row.id === session.id);
  t.after(async () => { await service.close(); for (const controller of controllers) await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  const addTurn = (id = 'first') => store.mutate(state => { const s = state.sessions.find(row => row.id === session.id), at = new Date(now()).toISOString(); s.turns.push({ id, status: 'completed', createdAt: at, completedAt: at, modelConfig: { execution: 'rna' } }); s.items.push({ id: `${id}-user`, turnId: id, kind: 'user', text: `Check both input forms: ${id}`, createdAt: at }, { id: `${id}-tool`, turnId: id, kind: 'tool', tool: { name: 'project_exec', status: 'succeeded', output: `Only one variant checked: ${id}` }, simulated: false }, { id: `${id}-answer`, turnId: id, kind: 'assistant', text: 'The check was performed', simulated: false }); });
  const initiative = options => {
    const calls = [];
    const controller = new ProjectInitiativeController(store, { decisionService: service, now, initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true,
      decisionProvider: async function* (request) { const input = JSON.parse(request.messages[0].content[0].text); calls.push(input); yield { type: 'text_delta', delta: JSON.stringify({ action: 'wait', content: '', evidenceIds: input.events.length ? [input.events.at(-1).id] : [], reason: 'The isolated evidence was reviewed', nextReviewAfterMs: 60000, ...(input.hostConditions?.judgment?.requiresAssessment ? { judgmentPolicy: assessmentPlan() } : {}) }) }; yield { type: 'usage', usage: { totalTokens: 12 } }; yield { type: 'done', stopReason: 'stop' }; }, ...options });
    controllers.push(controller); return { controller, calls };
  };
  const learning = options => {
    store.mutate(state => { const p = state.projects.find(row => row.id === project.id); p.activeVersionId = 'base'; p.versions = [{ id: 'base', bundle: { hash: 'basehash', genome: { skills: [], tools: [], evaluationSuite: { cases: [] } } } }]; });
    const calls = [], experiments = [], evolutionService = { running: new Map(), evolve: async (_, input) => { experiments.push(input); return { status: 'rejected', version: { id: 'fixture-candidate' }, summary: 'Fixture rejected' }; } };
    const controller = new ProjectLearningController(store, { decisionService: service, now, evolutionService, initialDelayMs: 0, tickIntervalMs: 0, minReviewMs: 0,
      reflect: async input => { calls.push(input); return { decision: { outcome: 'no_change', evidenceIds: input.episodes.map(row => row.id), reason: 'Evidence was examined; no supported reusable change', diagnosis: 'A single occurrence is insufficient for this isolated fixture', hypothesis: '', intervention: '', validationPlan: '', limitations: 'Synthetic test only', nextReviewAfterMs: 60000 } }; }, ...options });
    controllers.push(controller); return { controller, calls, experiments, evolutionService };
  };
  return { store, service, current, conversation, project, session, directory, judgments, controllers, initiative, learning, addTurn };
}

test('initiative judge delay retains unreviewed SDK evidence and new outside evidence immediately invalidates it', async t => {
  const f = fixture(t), run = f.initiative();
  await until(() => f.service.ledger().some(row => row.disposition === 'deferred'), 'first defer');
  const context = run.controller.contexts.get(f.project.id), before = context.coordinator.snapshot();
  assert.equal(run.calls.length, 0); assert.ok(before.lastDecision == null); assert.ok(before.events.length > 0); assert.notEqual(before.decisionRevision, before.revision);
  await run.controller.pump(); assert.equal(f.judgments.length, 1);
  // A label alone is no longer a host-bound workspace observation. The
  // observer binds metadata to the project, exact workspace and source revision.
  f.store.mutate(state => state.projects.find(row => row.id === f.project.id).observations.push({ id: 'unbound-proof', kind: 'workspace_change', text: 'An unbound source claims a change', simulated: false, createdAt: new Date().toISOString() }));
  assert.equal(run.controller.sources(f.current(), context.scope).some(row => row.id === 'observation:unbound-proof'), false);
  await run.controller.pump(); await until(() => !run.controller.pumping && !context.reviewPromise, 'unbound observation drained');
  assert.equal(f.judgments.length, 1); assert.equal(context.coordinator.snapshot().events.some(row => row.id === 'observation:unbound-proof'), false);
  const bindingId = createHash('sha256').update(JSON.stringify([f.project.id, resolve(f.directory)])).digest('hex');
  f.store.mutate(state => state.projects.find(row => row.id === f.project.id).observations.push({ id: 'fresh-proof', eventId: 'fresh-proof', kind: 'workspace_change', text: 'A new independent source changed the acceptance condition', status: 'pending', simulated: false, createdAt: new Date().toISOString(),
    data: { source: { id: 'workspace', kind: 'workspace', bindingId, revision: 1 }, trust: 'untrusted', instruction: false, changes: [{ path: 'main.js', change: 'modified' }], totalChanges: 1, truncated: false } }));
  await until(() => f.judgments.length === 2, 'new evidence judgment');
  assert.ok(context.coordinator.snapshot().events.some(row => row.id === 'observation:fresh-proof'));
  assert.equal(run.calls.length, 0);
});

test('learning judge delay does not consume episodes, create a review or reserve main-model tokens', async t => {
  const f = fixture(t); f.addTurn(); const run = f.learning();
  await until(() => run.controller.contexts.get(f.project.id)?.judgeDeferred, 'learning defer');
  const snapshot = f.current().learningRuntime.sdkState;
  assert.equal(snapshot.episodes.length, 1); assert.equal(snapshot.episodes[0].status, 'pending'); assert.equal(snapshot.reviews.length, 0);
  assert.equal(run.calls.length, 0); assert.equal(run.experiments.length, 0); assert.equal(f.store.state.realUsage.reservedTokens, 0);
  f.addTurn('second'); await until(() => f.judgments.length === 2, 'new learning evidence');
  assert.equal(f.current().learningRuntime.sdkState.episodes.filter(row => row.status === 'pending').length, 2);
});

test('JEV HTTP failure falls back to the original initiative judgment', async t => {
  const f = fixture(t, { fetch: async () => new Response('private server error', { status: 503 }) }), run = f.initiative();
  await until(() => run.calls.length === 1, 'fallback model review');
  await until(() => f.current().initiativeRuntime.sdkState.lastDecision, 'decision persisted');
  assert.equal(f.service.ledger()[0].source, 'fallback'); assert.equal(f.service.ledger()[0].reason, 'server');
  assert.equal(f.current().initiativeRuntime.sdkState.lastDecision.action, 'wait');
});

test('JEV HTTP failure preserves the complete learning reflection path', async t => {
  const f = fixture(t, { fetch: async () => new Response('', { status: 503 }) }); f.addTurn(); const run = f.learning();
  await until(() => run.calls.length === 1, 'fallback reflection');
  await until(() => f.current().learningRuntime.sdkState.reviews[0]?.status === 'no_change', 'reflection completed');
  assert.equal(f.service.ledger()[0].source, 'fallback'); assert.equal(run.experiments.length, 0);
});

test('a scheduled occurrence bypasses judge admission and delivers its work', async t => {
  const origin = Date.parse('2026-09-26T00:00:00Z'), f = fixture(t, { now: () => origin + 3600000 });
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).schedules = [createProjectSchedule({ id: 'daily', title: 'Daily report', task: 'Deliver the prepared fixture result', destinationSessionId: f.session.id, rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }, { now: origin })]; });
  let workers = 0;
  const run = f.initiative({ initialDelayMs: 86400000, runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* () { workers++; yield { type: 'text_delta', delta: 'The scheduled fixture report is ready.' }; yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: 'stop' }; } }) });
  await until(() => f.current().scheduleRuntime?.occurrences[0]?.status === 'delivered', 'scheduled delivery');
  assert.equal(workers, 1); assert.equal(f.judgments.length, 0); assert.equal(run.calls.length, 0);
  assert.equal(f.conversation().items.filter(row => row.scheduleOccurrenceKey).length, 1);
});

test('an already queued initiative share is delivered without asking JEV again', async t => {
  const f = fixture(t, { fetch: async () => answer(.99) });
  f.store.presences.set(f.project.id, { sessionId: f.session.id, visible: true, typing: true, expiresAt: new Date(Date.now() + 60000).toISOString() });
  const run = f.initiative({ decisionProvider: async function* (request) { const input = JSON.parse(request.messages[0].content[0].text); yield { type: 'text_delta', delta: JSON.stringify({ action: 'share', content: 'A fixture finding awaits typing to finish.', evidenceIds: [input.events.at(-1).id], reason: 'A checked fixture finding', nextReviewAfterMs: 60000 }) }; yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: 'stop' }; } });
  await until(() => f.current().initiativeRuntime?.sdkState.actions.some(row => row.status === 'queued'), 'queued share');
  const requests = f.judgments.length;
  f.store.presences.delete(f.project.id); await run.controller.pump();
  await until(() => f.conversation().items.some(row => row.source === 'initiative'), 'share delivered');
  assert.equal(f.judgments.length, requests);
});

test('foreground stop cancels a hanging JEV preflight before any main-model request', async t => {
  let entered = false, receivedSignal, calls = 0;
  const f = fixture(t, { autoRecall: true, fetch: async (_, options) => { entered = true; receivedSignal = options.signal; return new Promise(() => {}); } });
  f.store.memoryService.recall = async () => ({ entries: [], content: '', estimatedTokens: 0, candidateCount: 0, stage: 'summaries' });
  const controller = new RuntimeController(f.store, { decisionService: f.service, factory: options => createRnaRuntime({ ...options, provider: async function* () { calls++; yield { type: 'text_delta', delta: 'No execution expected' }; yield { type: 'done', stopReason: 'stop' }; } }) });
  f.controllers.push(controller);
  f.store.message(f.session.id, { text: 'Explain this project briefly' }); await until(() => entered, 'preflight');
  // The judge never answers, so settling at all proves the stop cancelled it; the limit leaves room for a busy machine.
  f.store.controlSession(f.session.id, 'stop'); await until(() => controller.running.size === 0, 'stop during preflight', 5000);
  assert.equal(receivedSignal.aborted, true); assert.equal(calls, 0); assert.equal(f.conversation().turns[0].status, 'stopped');
});

test('new learning evidence arriving during JEV cannot inherit the stale negative delay', async t => {
  const gate = hold(); let firstSignal;
  const f = fixture(t, { fetch: async (_, options, count) => { if (count === 1) { firstSignal = options.signal; await gate.promise; return answer(.01); } return answer(.99); } });
  t.after(() => gate.resolve()); f.addTurn(); const run = f.learning();
  await until(() => firstSignal, 'first learning judgment');
  f.addTurn('new-during-judge'); await run.controller.pump(); gate.resolve();
  await until(() => run.calls.length === 1, 'new evidence gets main review without ten-minute stale delay', 1500);
  assert.equal(run.calls[0].episodes.length, 2);
});

test('an existing queued experiment bypasses JEV and retains its original reflection', async t => {
  let clock = Date.now(), reflections = 0;
  const f = fixture(t, { now: () => clock, fetch: async () => answer(.99) }); f.addTurn();
  const run = f.learning({ reflect: async input => { reflections++; return { decision: { outcome: 'experiment', evidenceIds: input.episodes.map(row => row.id), reason: 'A repeated boundary gap has an isolated check', diagnosis: 'Only one input variant was verified', hypothesis: 'An explicit boundary checklist prevents omissions', intervention: 'Extend the checking skill with the missing variant', validationPlan: 'Compare original and changed skills on frozen variant cases', limitations: 'Does not establish visual quality', nextReviewAfterMs: 60000 } }; } });
  run.evolutionService.running.set(f.project.id, {});
  await until(() => f.current().learningRuntime?.sdkState.reviews[0]?.status === 'queued_experiment', 'queued experiment');
  assert.equal(reflections, 1); const requests = f.judgments.length;
  run.evolutionService.running.delete(f.project.id); clock += 61000; await run.controller.pump();
  await until(() => f.current().learningRuntime.sdkState.reviews[0]?.status === 'completed', 'existing experiment completed');
  assert.equal(reflections, 1); assert.equal(f.judgments.length, requests); assert.equal(run.experiments.length, 1);
});

test('steering accepted during preflight invalidates a negative recall hint and is delivered once', async t => {
  const gate = hold(); let entered = false, recalls = 0; const mainRequests = [];
  const f = fixture(t, { autoRecall: true, fetch: async () => { entered = true; await gate.promise; return answer(.01); } });
  t.after(() => gate.resolve());
  f.store.memoryService.recall = async () => { recalls++; return { entries: [], content: '', estimatedTokens: 0, candidateCount: 0, stage: 'summaries' }; };
  const controller = new RuntimeController(f.store, { decisionService: f.service, factory: options => createRnaRuntime({ ...options, provider: async function* (request) { mainRequests.push(request); yield { type: 'text_delta', delta: 'Fixture reply' }; yield { type: 'done', stopReason: 'stop' }; } }) }); f.controllers.push(controller);
  f.store.message(f.session.id, { text: 'Hello, a short explanation please' }); await until(() => entered, 'preflight entered');
  f.store.message(f.session.id, { text: 'Use the project memory for the boundary case', delivery: 'steer' }); gate.resolve();
  await until(() => f.conversation().turns[0]?.status === 'completed', 'steered turn completed');
  assert.equal(recalls, 1);
  const messages = mainRequests.at(-1).messages.filter(row => row.role === 'user').map(row => JSON.stringify(row.content));
  assert.equal(messages.filter(row => row.includes('Hello, a short explanation please')).length, 1);
  assert.equal(messages.filter(row => row.includes('Use the project memory for the boundary case')).length, 1);
  assert.equal(f.conversation().turns[0].modelConfig.reasoning, 'off');
});

test('late project evidence reaches ordinary recall and never injects the stale JEV assessment', async t => {
  for (const change of ['workspace_change', 'source_correction', 'stable']) await t.test(change, async t => {
    const gate = hold(); let entered = false, recalls = 0; const mainRequests = [];
    const f = fixture(t, { autoRecall: true, fetch: async () => { entered = true; await gate.promise; return answer(.01); } });
    t.after(() => gate.resolve());
    f.store.memoryService.recall = async () => { recalls++; return { entries: [{ uri: 'viking://fixture/accepted-constraint', summary: 'Verify the corrected boundary.', level: 'abstract' }], content: 'Accepted constraint: verify the corrected boundary.', estimatedTokens: 12, candidateCount: 1, stage: 'summaries' }; };
    const controller = new RuntimeController(f.store, { decisionService: f.service, factory: options => createRnaRuntime({ ...options, provider: async function* (request) {
      mainRequests.push(request); yield { type: 'text_delta', delta: 'Fixture reply' }; yield { type: 'done', stopReason: 'stop' };
    } }) }); f.controllers.push(controller);
    f.store.message(f.session.id, { text: 'Hello, a short explanation please' }); await until(() => entered, 'preflight entered');
    const policyRevision = f.current().judgmentPolicy.revision;
    if (change === 'workspace_change') f.store.mutate(state => state.projects.find(row => row.id === f.project.id).observations.push({ id: 'after-dispatch', kind: 'workspace_change', text: 'Accepted input boundary changed', simulated: false }));
    if (change === 'source_correction') f.store.mutate(state => state.projects.find(row => row.id === f.project.id).focus = 'The formerly accepted input boundary was corrected');
    assert.equal(f.current().judgmentPolicy.revision, policyRevision);
    assert.equal(f.conversation().inbox.length, 0, 'this is not the already-protected steering path');
    gate.resolve(); await until(() => f.conversation().turns[0]?.status === 'completed', 'ordinary turn completed');
    const changed = change !== 'stable', turn = f.conversation().turns[0];
    assert.equal(recalls, 1, 'memory is fetched in parallel with the judgment; only a stale or positive judgment injects it');
    // The turn-end judgment (turn.settled) is a separate point; count the preflight only.
    const preflight = f.judgments.filter(body => !Object.hasOwn(body.questions ?? {}, 'instruction_complete'));
    assert.equal(preflight.length, 1); assert.equal(mainRequests.length, 1);
    assert.equal(turn.preflight.source, changed ? 'fallback' : 'judge');
    assert.equal(Boolean(turn.preflight.assessment), !changed);
    assert.equal(f.service.ledger().find(row => row.point !== 'turn.settled').disposition, changed ? 'stale' : 'chat_preflight');
    // This fixture's judge answers only the preflight questions; the turn-end request gets no usable answer and is not metered.
    assert.equal(f.service.public().metrics.totalTokens, 42 * preflight.length);
    const text = JSON.stringify(mainRequests[0]);
    assert.equal(text.includes('Accepted constraint: verify the corrected boundary.'), changed);
  });
});

test('normal initiative and learning work proceed with zero JEV requests until the main model has authored options', async t => {
  const initiative = fixture(t, { withPlan: false }), run = initiative.initiative();
  await until(() => initiative.current().initiativeRuntime?.sdkState.lastDecision, 'main initiative without plan');
  assert.equal(run.calls.length, 1); assert.equal(initiative.judgments.length, 0); assert.equal(initiative.service.public().planReadyCount, 1); assert.equal(initiative.current().judgmentPolicy.source.method, 'initiative'); assert.equal(run.calls[0].hostConditions.judgment.requiresAssessment, true); assert.equal(run.calls[0].hostConditions.judgment.enabled, true);
  const learning = fixture(t, { withPlan: false }); learning.addTurn(); const learn = learning.learning();
  await until(() => learning.current().learningRuntime?.sdkState.reviews[0]?.status === 'no_change', 'main reflection without plan');
  assert.equal(learn.calls.length, 1); assert.equal(learning.judgments.length, 0); assert.equal(learn.experiments.length, 0);
});

test('real SDK HTTP scoring contains only main-model options and shadow scores never defer initiative', async t => {
  const f = fixture(t); f.service.update({ mode: 'shadow', modes: { 'initiative.review': 'shadow', 'evolution.review': 'shadow', 'chat.preflight': 'shadow' } });
  const run = f.initiative(); await until(() => f.current().initiativeRuntime?.sdkState.lastDecision, 'shadow initiative completes main review');
  assert.equal(run.calls.length, 1); assert.equal(f.judgments.length, 1); assert.equal(f.service.deferrals.size, 0);
  assert.equal(f.service.ledger()[0].reason, 'shadow'); assert.equal(f.service.ledger()[0].disposition, 'main_review');
  const questions = f.judgments[0].questions;
  for (const [id, question] of Object.entries(questions)) { assert.ok(Object.hasOwn(f.current().judgmentPolicy.plan.questions, id)); assert.equal(question.instructions, f.current().judgmentPolicy.plan.questions[id].instructions); }
  for (const id of ['taskType', 'reasoning', 'needsPlan', 'review']) assert.equal(questions[id], undefined);
  assert.equal(f.service.ledger()[0].planRevision, f.current().judgmentPolicy.revision);
});

test('slow shadow scoring never delays foreground memory or injects scores into its model input', async t => {
  let scoringSignal, recalls = 0, shadowPendingAtMain = 0; const main = [];
  const f = fixture(t, { autoRecall: true, fetch: async (_, options) => { scoringSignal = options.signal; return new Promise(() => {}); } });
  f.service.update({ mode: 'shadow', modes: { 'chat.preflight': 'shadow' } });
  f.store.memoryService.recall = async () => { recalls++; return { entries: [], content: '', estimatedTokens: 0, candidateCount: 0, stage: 'summaries' }; };
  const controller = new RuntimeController(f.store, { decisionService: f.service, factory: options => createRnaRuntime({ ...options, provider: async function* (request) { main.push(request); shadowPendingAtMain = f.service.shadows.size; yield { type: 'text_delta', delta: 'Foreground continued.' }; yield { type: 'done', stopReason: 'stop' }; } }) }); f.controllers.push(controller);
  f.store.message(f.session.id, { text: 'Explain the project' });
  await until(() => f.conversation().turns[0]?.status === 'completed', 'foreground completes while shadow request remains pending');
  assert.equal(recalls, 1); assert.equal(main.length, 1); assert.equal(shadowPendingAtMain, 1);
  assert.equal(f.conversation().turns[0].preflight.assessment, undefined);
  assert.equal(f.conversation().turns[0].preflight.reason, 'shadow_parallel');
  await f.service.close(); assert.equal(scoringSignal.aborted, true); assert.equal(f.service.shadows.size, 0);
  assert.equal(f.store.state.realUsage.reservedTokens, 0);
  const row = f.service.ledger()[0]; assert.equal(row.execution.latencyClass, 'parallel'); assert.equal(row.execution.blocksHost, false);
  assert.equal(row.execution.cacheImpact, 'none'); assert.equal(row.networkAttempted, true);
});

test('shadow mode with an explicit budget leaves the complete admission allowance to the foreground request', async t => {
  let recalls = 0, requests = 0, requiredAllowance;
  const f = fixture(t, { autoRecall: true, fetch: async () => { throw new Error('A budgeted shadow request must not be dispatched'); } });
  f.service.update({ mode: 'shadow', modes: { 'chat.preflight': 'shadow' } });
  f.store.mutate(state => { state.settings.realTokenBudget = 1000000; });
  f.store.memoryService.recall = async () => { recalls++; return { entries: [], content: '', estimatedTokens: 0, candidateCount: 0, stage: 'summaries' }; };
  const controller = new RuntimeController(f.store, { decisionService: f.service, factory: options => createRnaRuntime({ ...options,
    beforeCompletion: input => {
      // Use the real SDK estimate, not a guessed prompt length. Restrict the
      // remaining allowance exactly at admission; any earlier JEV reservation
      // would make the otherwise-admissible foreground call fail.
      requiredAllowance = Math.ceil(input.estimatedInputTokens + input.maxOutputTokens + 1536);
      f.store.mutate(state => { state.settings.realTokenBudget = requiredAllowance; });
      options.beforeCompletion(input);
    },
    provider: async function* () { requests++; yield { type: 'text_delta', delta: 'Foreground completed inside the explicit allowance.' }; yield { type: 'usage', usage: { input: 12, output: 3, totalTokens: 15 } }; yield { type: 'done', stopReason: 'stop' }; },
  }) }); f.controllers.push(controller);
  f.store.message(f.session.id, { text: 'Explain the project within the saved allowance' });
  await until(() => ['completed', 'failed'].includes(f.conversation().turns[0]?.status), 'budgeted foreground settles');
  assert.equal(f.conversation().turns[0].status, 'completed'); assert.equal(requests, 1); assert.equal(recalls, 1);
  assert.ok(requiredAllowance > 0); assert.equal(f.judgments.length, 0); assert.equal(f.service.shadows.size, 0);
  assert.equal(f.conversation().turns[0].preflight.reason, 'shadow_budget_priority');
  assert.equal(f.conversation().turns[0].preflight.assessment, undefined);
  assert.equal(f.store.state.realUsage.reservedTokens, 0); assert.equal(f.store.state.realUsage.reportedTokens, 15);
  const row = f.service.ledger()[0]; assert.equal(row.reason, 'shadow_budget_priority'); assert.equal(row.networkAttempted, false);
  assert.equal(row.execution.latencyClass, 'not_requested'); assert.deepEqual(row.usage, { inputTokens: 0, outputTokens: 0 });
  assert.equal(f.service.public().performance.groups[0].measuredRequests, 0); assert.equal(f.service.public().metrics.parallelScores ?? 0, 0);
});

test('explicit budgets suppress only shadow admission across review lanes; unlimited mode still scores and bills', async t => {
  const f = fixture(t); f.service.update({ mode: 'shadow', modes: { 'initiative.review': 'shadow', 'evolution.review': 'shadow', 'chat.preflight': 'shadow' } });
  for (const cap of [0, 1000000]) {
    f.store.mutate(state => { state.settings.realTokenBudget = cap; });
    for (const point of ['initiative.review', 'evolution.review']) assert.deepEqual(await f.service.review(point, f.current()), { review: true, reason: 'shadow_budget_priority' });
    assert.deepEqual(await f.service.chat(f.current(), { sessionId: f.session.id, turnId: `bounded-${cap}` }), { needsMemory: true, source: 'fallback', reason: 'shadow_budget_priority' });
  }
  assert.equal(f.judgments.length, 0); assert.equal(f.service.deferrals.size, 0); assert.equal(f.store.state.realUsage.reportedTokens, 0);
  f.store.mutate(state => { state.settings.realTokenBudget = null; });
  assert.equal((await f.service.review('evolution.review', f.current())).reason, 'shadow_parallel');
  await f.service.drain(); assert.equal(f.judgments.length, 1); assert.equal(f.store.state.realUsage.reportedTokens, 42);
  assert.equal(f.store.state.realUsage.reservedTokens, 0); assert.equal(f.service.deferrals.size, 0);
});
