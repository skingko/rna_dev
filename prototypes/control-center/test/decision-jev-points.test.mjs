import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionService, DECISION_POINT_INFO } from '../decision-service.mjs';
import { RuntimeController } from '../runtime-controller.mjs';
import { recallProjectMemory } from '../memory-context.mjs';
import { checkedMessageViolations } from '../proactive-delivery.mjs';
import { calibrationReport } from '../decision-calibration-report.mjs';
import { createDecisionKernel } from '../../../packages/sdk/src/decision-kernel.mjs';
import { DECISION_THRESHOLDS, skillOptionKeys } from '../../../packages/sdk/src/decision-templates.mjs';

// Fake System One: answers every question from `pick` (noul p, choice id) and
// records each request body. No network, no paid calls.
function fakeJev(pick = {}, { delayMs = 0 } = {}) {
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      const value = typeof pick === 'function' ? pick(id, question, requests.length) : pick[id];
      if (question.type === 'noul') return [id, { type: 'noul', noul: value ?? .5 }];
      if (question.type === 'choice') { const keys = Object.keys(question.criteria), chosen = value ?? keys.at(-1); return [id, { type: 'choice', choice: chosen, probabilities: Object.fromEntries(keys.map(key => [key, key === chosen ? .96 : .04 / (keys.length - 1)])), confidence: .96 }]; }
      return [id, { type: 'score', score: value ?? 1, legend: {}, probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === (value ?? 1) ? 1 : 0])), confidence: .9 }];
    }));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 300, output_tokens: 10 } }));
  };
  return { fetch, requests };
}
function fixture({ modes = {}, pick = {}, delayMs = 0, mode = 'active' } = {}) {
  let clock = Date.parse('2026-09-28T10:00:00Z');
  const project = { id: 'p', name: 'Research desk', description: 'Deliver verified market findings', workspace: '/fixture/ws', focus: '', schedules: [], versions: [], inbox: [], initiativeRuntime: { sdkState: { actions: [] } } };
  const session = { id: 's', projectId: 'p', items: [], turns: [], status: 'idle' };
  const usage = [];
  const store = { state: { settings: { realTokenBudget: null }, configuration: { decisionKernel: { mode, modes }, providers: [] }, projects: [project], sessions: [session] },
    configurationService: { secrets: { 'judge:jev': 'TEST-ONLY-SECRET' }, writeSecret(id, input) { if (input.apiKey !== undefined) this.secrets[id] = input.apiKey; } }, mutate(fn) { return fn(this.state); }, usageLedger: { record: row => usage.push(row) } };
  const jev = fakeJev(pick, { delayMs });
  const service = new DecisionService(store, { now: () => clock, kernelFactory: options => createDecisionKernel({ ...options, fetch: jev.fetch }) });
  return { service, store, project, session, jev, usage, advance: ms => { clock += ms; }, now: () => clock };
}
const efforts = [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }];
const skills = [{ id: 'pdf-report', name: 'PDF report', description: 'Build PDF reports' }, { id: 'web-scan', name: 'Web scan', description: 'Scan sites' }];

test('turn.route: one request replaces chat.route + chat.preflight; migration keeps an enabled chat.route', async () => {
  const keys = skillOptionKeys(skills);
  const f = fixture({ modes: { 'chat.route': 'active' }, pick: { reasoning_effort: 'low', needs_memory: .05, skill_pick: keys[1], skill_gate_action: .9, skill_gate_procedure: .8, skill_gate_prose: .1, stop_background: .95, redirect_background: .1, clarify_needed: .1, needs_tools: .9 } });
  assert.equal(f.service.config().modes['turn.route'], 'active', 'migrated from chat.route');
  assert.equal(f.service.routePoint(), 'turn.route');
  assert.deepEqual(f.service.routeAvailability(), { available: true, backend: 'typesafe', point: 'turn.route' });
  const value = await f.service.route({ project: f.project, sessionId: 's', turnId: 't1', userMessage: '先停下后台的扫描，帮我看看网站', efforts, memory: true, skills, background: [{ kind: 'work', status: 'running', summary: 'scan competitors' }] });
  assert.equal(f.jev.requests.length, 1);
  assert.equal(value.point, 'turn.route'); assert.equal(value.reasoning, 'low'); assert.equal(value.reasoningDecided, true);
  assert.equal(value.needsMemory, false); assert.equal(value.memoryDecided, true); assert.deepEqual(value.skills, ['web-scan']);
  assert.equal(value.background.stop, 'act'); assert.equal(value.needsTools, true);
  assert.match(value.hints.hints.join(' '), /Relevant to the current request: skill "Web scan"/);
  const row = f.store.decisionLedger.rows().at(-1);
  assert.equal(row.point, 'turn.route'); assert.equal(row.scope.turnId, 't1'); assert.equal(row.decided, true); assert.equal(row.applied, true);
  assert.equal(row.predictions.needs_memory, .05); assert.ok(row.predictions.reasoning_effort > .9);
  assert.equal(f.usage.at(-1).purpose, 'jev'); assert.equal(f.usage.at(-1).usage.input, 300);
  // Shadow: the same answers are recorded but change nothing.
  const shadow = fixture({ modes: { 'turn.route': 'shadow' }, pick: { reasoning_effort: 'low', needs_memory: .05 } });
  const observed = await shadow.service.route({ project: shadow.project, sessionId: 's', turnId: 't2', userMessage: 'hi there', efforts, memory: true, skills: [] });
  assert.equal(observed.reasoningDecided, false); assert.equal(observed.needsMemory, true);
  const shadowRow = shadow.store.decisionLedger.rows().at(-1);
  assert.equal(shadowRow.decided, true); assert.equal(shadowRow.applied, false);
  // Legacy chat.route is used only when turn.route is explicitly off.
  const legacy = fixture({ modes: { 'chat.route': 'active', 'turn.route': 'off' }, pick: { reasoning_effort: 'low' } });
  assert.equal(legacy.service.routePoint(), 'chat.route');
  assert.equal((await legacy.service.route({ project: legacy.project, sessionId: 's', turnId: 't3', userMessage: 'x', efforts, memory: false, skills: [] })).point, undefined);
});

test('turn.route fan-out is measurably faster than the two separate requests it replaces (fake 60 ms server)', async () => {
  const one = fixture({ modes: { 'turn.route': 'active' }, delayMs: 60, pick: { reasoning_effort: 'low', needs_memory: .05 } });
  let started = performance.now();
  await one.service.route({ project: one.project, sessionId: 's', turnId: 't', userMessage: 'hello', efforts, memory: true, skills });
  const fanout = performance.now() - started;
  const two = fixture({ modes: { 'turn.route': 'off', 'chat.route': 'active' }, delayMs: 60, pick: { reasoning_effort: 'low', memory_need: .05 } });
  started = performance.now();
  await two.service.route({ project: two.project, sessionId: 's', turnId: 't', userMessage: 'hello', efforts, memory: false, skills: [] });
  await two.service.route({ project: two.project, sessionId: 's', turnId: 't2', userMessage: 'hello', efforts: [], memory: true, skills: [] });
  const serial = performance.now() - started;
  assert.equal(one.jev.requests.length, 1); assert.equal(two.jev.requests.length, 2);
  assert.ok(fanout < serial, `fan-out ${fanout.toFixed(0)}ms vs serial ${serial.toFixed(0)}ms`);
});

test('calibration: backfilled outcomes give reliability buckets, coverage and abstain rate; validation', async () => {
  const f = fixture({ modes: { 'turn.route': 'active' }, pick: { needs_memory: .9, needs_tools: .9, clarify_needed: .1 } });
  for (const turnId of ['a', 'b', 'c']) {
    f.session.turns.push({ id: turnId, status: 'completed', createdAt: new Date(f.now()).toISOString() });
    await f.service.route({ project: f.project, sessionId: 's', turnId, userMessage: 'what did we decide about pricing?', efforts: [], memory: true, skills: [] });
    f.advance(1000);
  }
  // Turn a used memory search and a file tool; b used nothing; c is still open.
  f.session.items.push({ id: 'i1', turnId: 'a', tool: { name: 'openviking_search', args: {} } }, { id: 'i2', turnId: 'a', tool: { name: 'project_read', args: {} } });
  f.session.turns.find(row => row.id === 'c').status = 'running';
  const report = f.service.calibration({ point: 'turn.route', window: '24h' });
  assert.equal(report.decisions, 3); assert.equal(report.labeled, 2); assert.equal(report.thresholdsVersion, DECISION_THRESHOLDS.version); assert.equal(report.thresholdChanges, 'manual');
  assert.deepEqual(report.questions.needs_memory.buckets, [{ range: [.9, 1], n: 2, predicted: .9, observed: .5 }]);
  assert.equal(report.questions.needs_memory.brier, .41);
  assert.equal(report.coverage, 1); assert.equal(report.abstainRate, 0); assert.equal(report.savings.auxiliaryCalls, 3);
  assert.throws(() => f.service.calibration({ point: 'nope' }), /配置无效/); assert.throws(() => f.service.calibration({ window: '1y' }), /配置无效/);
  const all = f.service.calibration({ window: 'all' });
  assert.ok(all.points['turn.route']);
  const summary = f.service.public();
  assert.equal(summary.thresholds.version, 1); assert.equal(summary.thresholdsEditable, false);
  assert.ok(summary.points.find(row => row.point === 'tool.risk' && row.builtIn === false)); assert.deepEqual(summary.settings.editable, ['apiKey', 'fastModel', 'autoModel']);
  assert.equal(summary.calibration['turn.route'].decisions, 3);
  assert.deepEqual(Object.keys(DECISION_POINT_INFO).sort(), summary.points.map(row => row.point).sort());
  // Report math on synthetic rows: abstentions count against coverage.
  const synthetic = calibrationReport([{ point: 'x', at: 1, answers: {}, decided: true }, { point: 'x', at: 1, answers: {}, decided: false }, { point: 'x', at: 1, reason: 'timeout' }], { point: 'x', window: 'all', now: 2 });
  assert.equal(synthetic.coverage, .5); assert.equal(synthetic.abstainRate, .5); assert.deepEqual(synthetic.unscoredReasons, { timeout: 1 });
});

test('initiative.gate (opt-in): without a plan JEV decides wait and saves a main-model wake; off means zero calls', async () => {
  const off = fixture({ modes: { 'initiative.review': 'active' } });
  assert.deepEqual(await off.service.review('initiative.review', off.project), { review: true, reason: 'assessment_plan_required' });
  assert.equal(off.jev.requests.length, 0);
  const f = fixture({ modes: { 'initiative.review': 'active', 'initiative.gate': 'active' }, pick: { needs_main_model: .05, evidence_relevant: .1, already_reported: .9, likely_action: 'wait' } });
  const verdict = await f.service.review('initiative.review', f.project, { evidence: [{ id: 'e1', type: 'ci', summary: 'nightly build green again' }] });
  assert.equal(verdict.review, false); assert.equal(verdict.likelyAction, 'wait');
  assert.equal(f.jev.requests.length, 1); assert.ok(f.jev.requests[0].state.review.newEvidence[0].includes('nightly build'));
  const row = f.store.decisionLedger.rows().at(-1);
  assert.equal(row.disposition, 'deferred'); assert.equal(row.savings.mainModelCalls, 1); assert.equal(row.predictions.needs_main_model, .05);
  assert.equal(f.service.calibration({ point: 'initiative.review', window: '24h' }).savings.mainModelCalls, 1);
  const wake = fixture({ modes: { 'initiative.review': 'active', 'initiative.gate': 'active' }, pick: { needs_main_model: .95 } });
  assert.equal((await wake.service.review('initiative.review', wake.project, { evidence: [{ id: 'e2', type: 'failure', summary: 'deploy failed' }] })).review, true);
  const shadow = fixture({ modes: { 'initiative.review': 'active', 'initiative.gate': 'shadow' }, pick: { needs_main_model: .05, evidence_relevant: .1, already_reported: .9 } });
  assert.equal((await shadow.service.review('initiative.review', shadow.project, { evidence: [{ id: 'e3', type: 'ci', summary: 'x' }] })).review, true, 'shadow gate never defers');
  // The gate's state carries what is open (Headlong's routing signals) as buckets, never raw counts or text.
  const routed = fixture({ modes: { 'initiative.review': 'active', 'initiative.gate': 'active' }, pick: { needs_main_model: .95 } });
  const at = new Date(routed.now()).toISOString();
  routed.project.mind = { agenda: [{ id: 'q1', kind: 'awaiting_user', status: 'open', text: '目标平台？', createdAt: at }, { id: 't1', kind: 'todo', status: 'open', text: '整理素材', createdAt: at }], commitments: [{ id: 'c1', status: 'pending', request: '写第二章', createdAt: at, overdueAt: new Date(routed.now() + 3600000).toISOString() }],
    threads: [{ id: 'th', status: 'open', held: [{ id: 'h1', text: '发现一个渲染问题' }] }], pacing: { wake: { lastOutcome: 'thought' } } };
  await routed.service.review('initiative.review', routed.project, { evidence: [{ id: 'e4', type: 'workspace_change', summary: 'scene.js edited' }], freshCount: 1 });
  const review = routed.jev.requests.at(-1).state.review;
  assert.deepEqual(review.openWork, { pendingRequests: 'one', overdueRequests: 'none', openAgenda: 'few', waitingOnUser: 'one', heldFindings: 'one' });
  assert.equal(review.newSinceLastDecision, 'one'); assert.equal(review.lastWake, 'thought');
});

test('delivery.reach v2 atomic nouls lower but never raise the tier', async () => {
  const f = fixture({ modes: { 'delivery.reach': 'active' }, pick: { time_sensitive: .05, needs_user_decision: .05, related_to_current_topic: .1, similar_recently_ignored: .95 } });
  const lowered = await f.service.reach(f.project, { entry: { actionId: 'a1', kind: 'share', text: 'Competitor X cut prices by 10%.' }, maxTier: 'notify', recent: [{ at: new Date(f.now() - 3600000).toISOString(), reaction: 'ignored', message: 'Price watch: no change.' }] });
  assert.deepEqual([lowered.tier, lowered.lowered], ['digest', true]);
  assert.deepEqual(Object.keys(f.jev.requests[0].questions).sort(), ['needs_user_decision', 'related_to_current_topic', 'similar_recently_ignored', 'time_sensitive']);
  assert.equal(f.jev.requests[0].state.recentDeliveries[0].when, 'earlier_today');
  const urgent = fixture({ modes: { 'delivery.reach': 'active' }, pick: { time_sensitive: .95 } });
  assert.equal((await urgent.service.reach(urgent.project, { entry: { actionId: 'a2', text: 'Server down' }, maxTier: 'inbox' })).tier, 'inbox');
  assert.equal(await urgent.service.reach(urgent.project, { entry: { actionId: 'a3', text: 'x' }, maxTier: 'digest' }), null, 'nothing lower than digest');
});

test('skill.screen v2: wide choice + gate, shortlist verification, fits floor; closed gate stops after one request; >254 buckets', async () => {
  const candidates = Array.from({ length: 6 }, (_, index) => ({ name: `Skill ${index}`, description: `Method ${index}`, source: 'market' }));
  const f = fixture({ modes: { 'skill.screen': 'active' }, pick: (id, question, n) => id === 'which' ? (n === 1 ? 'c_4' : 'c_0') : id.startsWith('gate_') ? (id === 'gate_prose' ? .1 : .9) : id === 'fits_0' ? .95 : id === 'fits_1' ? .5 : .05 });
  const screened = await f.service.screenSkills({ projectId: 'p', title: 'Research desk', taskTypes: ['research'], candidates });
  assert.equal(f.jev.requests.length, 2); assert.equal(screened.source, 'judge'); assert.equal(screened.method, 'two_stage_v2');
  assert.equal(screened.verdicts[4], true, 'top of the shortlist fits');
  assert.equal(screened.verdicts.filter(value => value === undefined).length, 1, 'the middling candidate goes to main-model review');
  assert.ok(Object.keys(f.jev.requests[1].questions).includes('fits_2'));
  const closed = fixture({ modes: { 'skill.screen': 'active' }, pick: { gate_action: .05, gate_procedure: .05, gate_prose: .95 } });
  const none = await closed.service.screenSkills({ projectId: 'p', taskTypes: ['writing'], candidates });
  assert.equal(closed.jev.requests.length, 1); assert.equal(none.gate, 'closed'); assert.ok(none.verdicts.every(value => value === undefined));
  const many = fixture({ modes: { 'skill.screen': 'active' }, pick: { gate_action: .05, gate_procedure: .05, gate_prose: .95 } });
  await many.service.screenSkills({ projectId: 'p', taskTypes: ['coding', 'research'], candidates: Array.from({ length: 300 }, (_, index) => ({ name: `S${index}`, description: 'd', taskType: index % 2 ? 'coding' : 'research' })) });
  assert.equal(many.jev.requests.length, 2, 'bucketed by task type'); assert.ok(many.jev.requests.every(body => Object.keys(body.questions.which.criteria).length <= 255));
});

test('skill.screen pick: ONE choice request over names + descriptions; the probability distribution picks up to three; none picks nothing', async () => {
  const candidates = Array.from({ length: 5 }, (_, index) => ({ name: `Skill ${index}`, description: `Method ${index}`, source: 'market', body: 'not sent' }));
  const f = fixture({ modes: { 'skill.screen': 'active' }, pick: { which: 'c_3' } });
  const picked = await f.service.pickSkills({ projectId: 'p', title: 'Game studio', candidates });
  assert.equal(f.jev.requests.length, 1); assert.deepEqual(Object.keys(f.jev.requests[0].questions), ['which']);
  assert.equal(f.jev.requests[0].questions.which.type, 'choice'); assert.ok(Object.hasOwn(f.jev.requests[0].questions.which.criteria, 'none'));
  assert.equal(JSON.stringify(f.jev.requests[0]).includes('not sent'), false, 'only published names and descriptions');
  assert.equal(picked.source, 'judge'); assert.deepEqual(picked.indexes, [3]);
  const none = fixture({ modes: { 'skill.screen': 'active' }, pick: { which: 'none' } });
  const nothing = await none.service.pickSkills({ projectId: 'p', candidates });
  assert.deepEqual(nothing.indexes, []); assert.equal(nothing.none, true);
});
test('candidate.prescore v2: atomic prior for the 0.2 weight; skipping evaluation needs a high-stake negative and a second signal', async () => {
  const skip = fixture({ modes: { 'candidate.prescore': 'active' }, pick: { targets_observed_problem: .05, may_regress_other_tasks: .8, exceeds_hypothesis: .2 } });
  const negative = await skip.service.prescoreCandidate({ projectId: 'p', summary: 'Reword intro', hypothesis: 'Shorter intro', changedAreas: ['prompt'], evidence: [{ type: 'user_correction', summary: 'wrong totals' }] });
  assert.equal(negative.better, false); assert.equal(negative.source, 'judge'); assert.ok(negative.probability < .1);
  assert.equal(skip.store.decisionLedger.rows().at(-1).savings.mainModelCalls, 1);
  const unsure = fixture({ modes: { 'candidate.prescore': 'active' }, pick: { targets_observed_problem: .05, may_regress_other_tasks: .1 } });
  assert.equal((await unsure.service.prescoreCandidate({ projectId: 'p', summary: 's', hypothesis: 'h' })).better, undefined);
  const shadow = fixture({ modes: { 'candidate.prescore': 'shadow' }, pick: { targets_observed_problem: .05, may_regress_other_tasks: .8 } });
  assert.deepEqual(Object.keys(await shadow.service.prescoreCandidate({ projectId: 'p', summary: 's', hypothesis: 'h' })).sort(), ['ledgerId', 'source']);
});

test('tool.risk is retired: full access never triggers a per-call JEV check or a confirmation', async () => {
  const f = fixture({ modes: { 'tool.risk': 'active' } });
  assert.equal(f.service.enabled('tool.risk'), true, 'a diagnostic selection can still name it');
  const builtIn = fixture();
  assert.equal(builtIn.service.enabled('tool.risk'), false, 'not a built-in point');
  assert.equal(typeof RuntimeController.prototype.toolRiskGate, 'undefined', 'the runtime has no confirmation gate');
});
test('message.check adds one-rewrite codes beside the regex checks; memory.filter drops only confident irrelevant passages', async () => {
  const f = fixture({ modes: { 'message.check': 'active', 'memory.filter': 'active' }, pick: { status_ping: .95, result_not_first: .9, relevant_0: .95, relevant_1: .05, relevant_2: .5 } });
  const violations = await checkedMessageViolations(f.project, [f.session], 'Quick update: I have been looking into the pricing data for a while now.', { now: f.now(), decisions: f.service });
  assert.deepEqual(violations.map(row => row.code).sort(), ['result_not_first', 'status_ping']);
  assert.ok(violations.every(row => row.repair));
  assert.deepEqual(await checkedMessageViolations(f.project, [f.session], 'Result: A beats B.', { now: f.now(), decisions: null }), []);
  const entries = [0, 1, 2].map(index => ({ uri: `viking://m/${index}`, summary: `memory ${index}` }));
  const service = { recall: async () => ({ entries, content: JSON.stringify({ strategy: 'progressive', entries }), truncated: false, candidateCount: 3 }) };
  const recalled = await recallProjectMemory({ service, projectId: 'p', prompt: 'pricing decision?', snapshot: { tools: ['openviking_search'] }, model: { contextWindow: 128000, maxOutputTokens: 4096 },
    filter: list => f.service.memoryFilter({ projectId: 'p', sessionId: 's', turnId: 't', prompt: 'pricing decision?', entries: list }) });
  assert.deepEqual(recalled.projection.entries.map(row => row.uri), ['viking://m/0', 'viking://m/2']); assert.equal(recalled.projection.filtered, 1);
  // A slow or failing filter keeps every passage.
  const slow = await recallProjectMemory({ service, projectId: 'p', prompt: 'x', snapshot: { tools: ['openviking_search'] }, model: { contextWindow: 128000, maxOutputTokens: 4096 }, filter: async () => { throw new Error('down'); } });
  assert.equal(slow.projection.entries.length, 3);
});

test('turn.route hints are appended once at the tail through prepareRequest', async () => {
  const controller = Object.create(RuntimeController.prototype);
  Object.assign(controller, { store: { state: { sessions: [{ id: 's', items: [] }] } }, admitSteering: async () => {} });
  const context = { sessionId: 's', routeHints: { hints: ['Relevant to the current request: skill "Web scan". Ignore this if it does not fit what the user actually asked for.'], note: 'n' } };
  const first = await controller.prepareRequest(context, { snapshot: { messages: [] } });
  assert.equal(first.contextUpdates[0].key, 'turn-route-hints'); assert.match(first.contextUpdates[0].text, /Web scan/);
  assert.equal(await controller.prepareRequest(context, { snapshot: { messages: [] } }), undefined, 'sent once');
});

test('settings: fastModel and endpoint rules; the API never redirects the key; TYPESAFE_ENDPOINT is honored', async () => {
  const f = fixture();
  assert.throws(() => f.service.update({ endpoint: 'https://gateway.example' }), /配置无效/);
  assert.throws(() => f.service.update({ fastModel: { providerId: 'missing', modelId: 'x' } }), /配置无效/);
  const previous = process.env.TYPESAFE_ENDPOINT;
  try {
    process.env.TYPESAFE_ENDPOINT = 'https://gateway.example/v1/systemone'; assert.equal(f.service.endpoint(), 'https://gateway.example/v1/systemone');
    process.env.TYPESAFE_ENDPOINT = 'http://evil.example/v1'; assert.equal(f.service.endpoint(), null);
  } finally { if (previous === undefined) delete process.env.TYPESAFE_ENDPOINT; else process.env.TYPESAFE_ENDPOINT = previous; }
});

test('turn.settled and initiative.direct reach the judge through the real kernel (initiative.direct was rejected as unconfigured before 0.33)', async () => {
  const f = fixture({ pick: { instruction_complete: .04, waiting_on_user: .05, deferred_without_cause: .9, feedback_worthwhile: .2, schedule_requested: .03, proposes_file_changes: .97, objective_errors_only: .96, safe_without_user: .95 } });
  const verdict = await f.service.settled(f.project, { sessionId: 's', turnId: 't', request: '继续完成 6-10 章', reply: '6、7 章完成。说“继续”随时收尾。', effects: ['project_write 第006章.md'], scheduled: true });
  assert.deepEqual({ ...verdict, ledgerId: undefined }, { continue: true, promise: null, waitingForUser: false, unfinished: true, dropSchedule: true, feedback: false, complete: false, waiting: false, deferred: true, finished: false, ledgerId: undefined });
  assert.equal(f.jev.requests.length, 1);
  assert.deepEqual(Object.keys(f.jev.requests[0].questions).sort(), ['commits_to_later_work', 'deferred_without_cause', 'feedback_worthwhile', 'instruction_complete', 'promise_sentence', 'schedule_requested', 'waiting_on_user']);
  const row = f.store.decisionLedger.rows().at(-1);
  assert.equal(row.point, 'turn.settled'); assert.equal(row.applied, true); assert.equal(row.scope.turnId, 't');
  // The feedback-invitation label backfills the feedback_worthwhile prediction.
  assert.equal(f.service.labelDecision(row.id, 'invite_dismissed'), true);
  f.service.backfill({ force: true });
  assert.equal(f.store.decisionLedger.rows().find(item => item.id === row.id).observed.feedback_worthwhile, false);
  assert.equal(await f.service.directHandle(f.project, { text: '第 3 章“张三”应为“张山”，与人物表不一致。' }), true);
  assert.equal(f.jev.requests.length, 2);
  assert.equal(f.store.decisionLedger.rows().at(-1).point, 'initiative.direct');
});

test('turn.settled: feedback asks are paced by how the user treated the last ones, judged, not counted', async () => {
  const history = [{ outcome: 'dismissed', at: new Date(Date.now() - 3600000).toISOString() }, { outcome: 'expired', at: new Date(Date.now() - 1800000).toISOString() }, { outcome: 'dismissed', at: new Date().toISOString() }];
  const tired = fixture({ pick: { instruction_complete: .96, waiting_on_user: .04, deferred_without_cause: .05, feedback_worthwhile: .9, feedback_welcome: .08 } });
  const value = await tired.service.settled(tired.project, { sessionId: 's', turnId: 't', request: '润色第 2 章', reply: '润色完成，语气改得更克制了。', recentFeedbackAsks: history });
  assert.equal(value.feedback, false, 'a confident "not welcome" keeps the ask back');
  const request = tired.jev.requests[0];
  assert.ok(request.questions.feedback_welcome); assert.match(JSON.stringify(request), /"recentFeedbackAsks":\[\{"outcome":"dismissed"[^\]]*"outcome":"expired"[^\]]*"outcome":"dismissed"/);
  const fresh = fixture({ pick: { instruction_complete: .96, waiting_on_user: .04, deferred_without_cause: .05, feedback_worthwhile: .9 } });
  assert.equal((await fresh.service.settled(fresh.project, { sessionId: 's', turnId: 't', request: '润色第 2 章', reply: '润色完成，语气改得更克制了。' })).feedback, true);
  assert.equal(fresh.jev.requests[0].questions.feedback_welcome, undefined, 'no history, no pacing question');
});

test('turn.settled: waiting on the user, or any doubt, ends the turn as it is', async () => {
  const waiting = fixture({ pick: { instruction_complete: .03, waiting_on_user: .9, deferred_without_cause: .1, feedback_worthwhile: .9 } });
  assert.deepEqual({ ...(await waiting.service.settled(waiting.project, { sessionId: 's', turnId: 't', request: '写第 8 章', reply: '第 8 章结局要悲剧还是圆满？' })), ledgerId: undefined }, { continue: false, promise: null, waitingForUser: true, unfinished: true, dropSchedule: false, feedback: false, complete: false, waiting: true, deferred: false, finished: false, ledgerId: undefined });
  const unsure = fixture({ pick: { instruction_complete: .3, waiting_on_user: .3, deferred_without_cause: .5, feedback_worthwhile: .9 } });
  const value = await unsure.service.settled(unsure.project, { sessionId: 's', turnId: 't', request: '润色第 2 章', reply: '润色完成，语气改得更克制了。' });
  assert.equal(value.continue, false); assert.equal(value.feedback, true);
  const off = fixture({ mode: 'off' });
  assert.equal(await off.service.settled(off.project, { sessionId: 's', turnId: 't', request: 'x', reply: 'y' }), null);
});

test('tool.admission runs in shadow by default and is labeled by what the model later read back', async () => {
  // No saved diagnostic mode: the product default, where new points observe first.
  const f = fixture({ mode: null, pick: { needed_0: .02, needed_1: .97, needed_2: .03 } });
  assert.equal(f.service.config().modes['tool.admission'], 'shadow'); assert.equal(f.service.config().modes['turn.settled'], 'active');
  const chunks = [{ range: [41, 80], lines: '41-80', text: 'ok ok ok' }, { range: [81, 120], lines: '81-120', text: 'AssertionError: expected 50' }, { range: [121, 160], lines: '121-160', text: 'ok ok ok' }];
  const applied = await f.service.admission(f.project, { sessionId: 's', turnId: 't', request: 'why does the test fail?', name: 'project_exec', preview: 'head … tail', chunks, spillId: 'out-0123456789ab' });
  assert.equal(applied, null, 'shadow never changes what the model sees');
  const row = f.store.decisionLedger.rows().at(-1);
  assert.equal(row.point, 'tool.admission'); assert.equal(row.mode, 'shadow'); assert.deepEqual(row.outcome.wouldOmit, [0, 2]);
  assert.deepEqual(row.scope.ranges, [[41, 80], [81, 120], [121, 160]]);
  // The model searched the saved output and hit line 95 only.
  f.session.turns.push({ id: 't', status: 'completed' });
  f.session.items.push({ id: 'r', turnId: 't', kind: 'tool', tool: { name: 'tool_output_read', status: 'succeeded', args: { id: 'out-0123456789ab', pattern: 'Assertion' }, output: '95:\tAssertionError: expected 50\n\n1 matching lines of 400.' } });
  f.service.backfill({ force: true });
  assert.deepEqual({ ...f.store.decisionLedger.rows().at(-1).observed, at: undefined }, { needed_0: false, needed_1: true, needed_2: false, at: undefined });
});

test('input.interjection: a correction stops the response in progress; an addition waits', async () => {
  const stop = fixture({ mode: null, pick: { supersedes_current: .93 } });
  assert.equal(stop.service.config().modes['input.interjection'], 'active');
  const verdict = await stop.service.interjection(stop.project, { sessionId: 's', turnId: 't', request: '写第一章', progress: '第一章：他走进了雨里……', message: '不对，改成第一人称' });
  assert.equal(verdict.interrupt, true);
  assert.equal(stop.store.decisionLedger.rows().at(-1).point, 'input.interjection');
  const wait = fixture({ mode: null, pick: { supersedes_current: .1 } });
  assert.equal((await wait.service.interjection(wait.project, { sessionId: 's', turnId: 't', request: '写第一章', progress: '第一章……', message: '写完顺便列一下人物表' })).interrupt, false);
});

test('feedback.signal: a note about this reply only stays there; a standing wish gets its lesson kind', async () => {
  const once = fixture({ mode: null, pick: { standing: .08, kind: 'unknown' } });
  assert.deepEqual({ ...(await once.service.feedbackSignal(once.project, { vote: 'down', note: '这段有个错别字', reply: '……' })), ledgerId: undefined }, { durable: 'one_off', kind: null, ledgerId: undefined });
  const standing = fixture({ mode: null, pick: { standing: .94, kind: 'constraint' } });
  const verdict = await standing.service.feedbackSignal(standing.project, { vote: 'down', note: '以后别在章节末尾写总结', reply: '……本章完。总结：' });
  assert.equal(verdict.durable, 'durable'); assert.equal(verdict.kind, 'constraint');
  const row = standing.store.decisionLedger.rows().at(-1);
  standing.service.labelDecision(row.id, 'lesson_confirmed'); standing.service.backfill({ force: true });
  assert.equal(standing.store.decisionLedger.rows().at(-1).observed.standing, true);
});

test('notes.worth: a batch with nothing new about the user skips the notes call; doubt keeps it', async () => {
  const skip = fixture({ mode: null, pick: { has_notes: .06 } });
  assert.equal(skip.service.config().modes['notes.worth'], 'active');
  assert.equal(await skip.service.notesWorth(skip.project, { messages: ['把第三章再改短一点', '继续'], existing: [] }), false);
  assert.equal(skip.store.decisionLedger.rows().at(-1).point, 'notes.worth');
  const keep = fixture({ mode: null, pick: { has_notes: .91 } });
  assert.equal(await keep.service.notesWorth(keep.project, { messages: ['我是高中语文老师，晚上才有空看稿'], existing: [] }), true);
  const unsure = fixture({ mode: null, pick: { has_notes: .5 } });
  assert.equal(await unsure.service.notesWorth(unsure.project, { messages: ['嗯'], existing: [] }), null);
});

test('ask.necessity: a question the project notes already answer is not asked (known); without notes the question is not even posed', async () => {
  const questions = [{ question: '标题用中文还是英文？', options: [{ label: '中文' }, { label: '英文' }] }];
  const knows = fixture({ mode: null, pick: { essential: .9, reasonable_default: .2, already_known: .95 } });
  assert.equal(await knows.service.askNecessity(knows.project, { sessionId: 's', turnId: 't', request: '起个标题', questions, present: true, known: ['偏好：标题一律用中文'] }), 'known');
  const unsure = fixture({ mode: null, pick: { essential: .9, reasonable_default: .2, already_known: .6 } });
  assert.equal(await unsure.service.askNecessity(unsure.project, { sessionId: 's', turnId: 't', request: '起个标题', questions, present: true, known: ['偏好：结论先行'] }), false);
  const { askNecessityTemplate } = await import('../../../packages/sdk/src/decision-templates.mjs');
  assert.equal(askNecessityTemplate().questions.already_known, undefined); assert.ok(askNecessityTemplate({ known: 1 }).questions.already_known);
});

test('ask.necessity: skip only with a confident easy default; any doubt asks', async () => {
  const questions = [{ question: '章节标题用什么格式？', options: [{ label: '第X章 标题' }, { label: 'Chapter X' }] }];
  const skip = fixture({ mode: null, pick: { essential: .05, reasonable_default: .95 } });
  assert.equal(await skip.service.askNecessity(skip.project, { sessionId: 's', turnId: 't', request: '写第一章', questions, present: false }), true);
  assert.equal(skip.jev.requests[0].state.user.state, 'away');
  const unsure = fixture({ mode: null, pick: { essential: .3, reasonable_default: .95 } });
  assert.equal(await unsure.service.askNecessity(unsure.project, { sessionId: 's', turnId: 't', request: '写第一章', questions }), false);
});
