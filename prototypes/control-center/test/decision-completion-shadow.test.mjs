// Plan 2026-10-05 D2 (the option-B completion gate): SHADOW ONLY. A finished background run still makes the host send the next
// review to the main model (bypass_delivery_just_completed); beside it the host works out the route the completion WOULD take
// (code facts first, then the completion template) and records it in the ledger (point work.completion). Nothing is acted on:
// every test here also asserts the real routing did not change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionService } from '../decision-service.mjs';
import { COMPLETION_POINT } from '../work-completion.mjs';

const BASE = 2_000_000;
const COMPLETED_AT = BASE - 60000;
/**
 * A project with one finished work action and its completion evidence, a store the service reads, and a kernel fake that
 * answers each question of a plan by id (`answers`; 0.5 = JEV's abstention), counting what it was asked.
 */
function fixture({ action: actionExtra = {}, job = {}, answers = {}, evidence: evidenceExtra = {}, settings = {}, kernel = null, mode = 'active', kernelConfig = null } = {}) {
  let clock = BASE, calls = 0;
  const action = { id: 'w1', action: 'work', status: 'completed', createdAt: COMPLETED_AT - 600000, finishedAt: COMPLETED_AT, evidenceIds: [], handoff: 'Checked the sources; nothing new turned up.', ...actionExtra };
  const project = { id: 'p', name: 'Daily research', description: 'Deliver verified findings', workspace: '/fixture', focus: 'Sources', schedules: [], versions: [], observations: [], jobs: [{ id: 'w1', lane: 'background', kind: 'research', status: 'completed', ...job }], backgroundChanges: [], directFixes: [], inbox: [{ id: 'e1', actionId: 's0', kind: 'share', tier: 'inline', createdAt: new Date(COMPLETED_AT - 3600000).toISOString(), text: 'The Q3 source list has two dead links.' }],
    initiativeRuntime: { sdkState: { actions: [action], lastDecision: { at: COMPLETED_AT - 3600000, action: 'work' } } } };
  const store = { state: { settings: { realTokenBudget: null, ...settings }, configuration: { decisionKernel: kernelConfig ?? (mode === 'active' ? {} : { mode }) }, projects: [project], sessions: [{ id: 's', projectId: 'p', items: [], turns: [], status: 'idle' }] },
    configurationService: { secrets: { 'judge:jev': 'TEST-ONLY-SECRET' }, writeSecret() {} }, mutate(fn) { return fn(this.state); } };
  const requests = [];
  const service = new DecisionService(store, { now: () => clock, kernelFactory: options => ({ close() {}, async decide(input) {
    calls++; requests.push(input);
    if (kernel) return kernel(input, options);
    const selected = options.modes[input.point] ?? options.mode, questions = Object.keys(input.assessmentPlan?.questions ?? {});
    const measured = Object.fromEntries(questions.map(id => [id, answers[id] ?? { type: 'boolean', probability: .5 }]));
    return { point: input.point, backend: 'typesafe', source: selected === 'active' ? 'judge' : 'fallback', networkAttempted: true, mode: selected, reason: selected === 'active' ? 'accepted' : 'shadow', policy: { confidence: .9, yes: .8, no: .05, margin: .1 }, answers: measured, usage: { inputTokens: 300, outputTokens: 0 }, latencyMs: 8, ledgerId: `j${calls}` };
  } }) });
  const evidence = [{ id: 'action:w1:completed', type: 'action_completed', summary: 'work completed. Checked the sources.', at: COMPLETED_AT, ...evidenceExtra }];
  const rows = () => store.decisionLedger.rows().filter(row => row.point === COMPLETION_POINT);
  const asked = () => requests.filter(request => request.point === COMPLETION_POINT);
  return { service, store, project, action, evidence, requests, asked, rows, calls: () => calls, advance(ms) { clock += ms; } };
}
const nothing = { reports_untold: { type: 'boolean', probability: .05 }, names_next_step: { type: 'boolean', probability: .04 }, evidence_relevant: { type: 'boolean', probability: .92 } };
const REAL = { review: true, reason: 'main_review_required', bypass: 'delivery_just_completed' };

test('a finished run is judged in shadow beside the review the host still makes: the verdict is recorded, the real routing is untouched', async () => {
  const f = fixture({ answers: nothing });
  assert.deepEqual(await f.service.review('initiative.review', f.project, { evidence: f.evidence, freshCount: 1 }), REAL, 'the review is still sent to the main model, as today');
  await f.service.drain();
  assert.equal(f.asked().length, 1, 'one completion, one judgment');
  const [row] = f.rows();
  assert.equal(row.point, 'work.completion'); assert.equal(row.disposition, 'work_completion');
  assert.deepEqual(row.outcome, { actionId: 'w1', class: 'judge', change: 'none', changed: 'none', real: 'delivery_just_completed', basis: 'judge', route: 'defer', reason: 'nothing_to_act_on' });
  assert.deepEqual(row.predictions, { reports_untold: .05, names_next_step: .04, evidence_relevant: .92 });
  assert.equal(row.mode, 'shadow'); assert.equal(row.source, 'fallback', 'the kernel scores it in shadow: it never applies a verdict');
  assert.notEqual(row.applied, true, 'nothing was applied');
  assert.equal(row.scope.projectId, 'p');
  // The judge read the handoff and what the user was told, and nothing the host knows by code.
  const state = f.asked()[0].state;
  assert.deepEqual(Object.keys(state), ['run', 'review', 'project']);
  assert.equal(state.run.handoff, 'Checked the sources; nothing new turned up.');
  assert.deepEqual(state.review.recentReports, ['[proactive message] The Q3 source list has two dead links.']);
  assert.deepEqual(Object.keys(f.asked()[0].assessmentPlan.questions), ['reports_untold', 'names_next_step', 'evidence_relevant']);
  assert.equal(JSON.stringify(state).includes('resolves'), false);
});

test('a run whose handoff names a step to start now would be reviewed, with the reason; a doubt is a review too, as today', async () => {
  const next = fixture({ answers: { reports_untold: { type: 'boolean', probability: .1 }, names_next_step: { type: 'boolean', probability: .9 }, evidence_relevant: { type: 'boolean', probability: .9 } } });
  await next.service.review('initiative.review', next.project, { evidence: next.evidence, freshCount: 1 }); await next.service.drain();
  assert.deepEqual([next.rows()[0].outcome.route, next.rows()[0].outcome.reason], ['review', 'names_next_step']);
  const unsure = fixture();
  assert.deepEqual(await unsure.service.review('initiative.review', unsure.project, { evidence: unsure.evidence, freshCount: 1 }), REAL); await unsure.service.drain();
  assert.deepEqual([unsure.rows()[0].outcome.route, unsure.rows()[0].outcome.reason], ['review', 'unsure'], 'JEV abstained: the fallback is today\'s behaviour');
});

test('each run is judged once: a second pass, a restart and a pass that reads other evidence ask nothing more', async () => {
  const f = fixture({ answers: nothing });
  for (let pass = 0; pass < 3; pass++) { await f.service.review('initiative.review', f.project, { evidence: f.evidence, freshCount: 1 }); await f.service.drain(); }
  assert.equal(f.asked().length, 1); assert.equal(f.rows().length, 1);
  // A restart: the ledger is the memory. The restarted kernel ANSWERS and counts its calls: a service that forgot the run would
  // ask again (a swallowed throw would leave the row count at 1 whatever the memory held) and write a second row.
  let askedAgain = 0;
  const restarted = new DecisionService(f.store, { now: () => BASE, kernelFactory: () => ({ close() {}, async decide(input) {
    if (input.point === COMPLETION_POINT) askedAgain++;
    return { point: input.point, backend: 'typesafe', source: 'fallback', networkAttempted: true, mode: 'shadow', reason: 'shadow', policy: null, answers: nothing, usage: { inputTokens: 300, outputTokens: 0 }, latencyMs: 8, ledgerId: 'again' };
  } }) });
  assert.equal((await restarted.review('initiative.review', f.project, { evidence: f.evidence, freshCount: 1 })).bypass, 'delivery_just_completed'); await restarted.drain();
  assert.equal(askedAgain, 0, 'the restarted service remembers the run from the ledger and asks nothing');
  assert.equal(f.rows().length, 1, 'one run, one row');
});

test('code facts settle the route without the judge: a schedule occurrence would not be reviewed, a run that owes an answer or ended without a report would', async () => {
  const cases = [
    ['schedule_occurrence', { action: { hostSchedule: { key: 'k' } } }, 'defer'],
    ['resolves_pending', { action: { resolves: ['c1'] } }, 'review'],
    ['unreported', { job: { unreported: true } }, 'review'],
    ['needs_review', { job: { status: 'needs_review' } }, 'review'],
    ['no_handoff', { action: { handoff: '' } }, 'review'],
  ];
  for (const [kind, extra, route] of cases) {
    const f = fixture({ ...extra, answers: nothing });
    assert.deepEqual(await f.service.review('initiative.review', f.project, { evidence: f.evidence, freshCount: 1 }), REAL, `${kind}: the review is unchanged`); await f.service.drain();
    assert.equal(f.asked().length, 0, `${kind}: no judge call`);
    const [row] = f.rows();
    assert.deepEqual([row.outcome.basis, row.outcome.class, row.outcome.route, row.outcome.reason, row.source, row.backend], ['code_fact', kind, route, `completion_${kind}`, 'rule', 'rule'], kind);
    assert.notEqual(row.decided, true, `${kind}: nothing was decided or applied by it`);
    assert.equal(row.predictions, undefined);
  }
});

test('no verdict is no skip: a judge that is unreachable, a spending cap and a missing key leave the review and record only what they are', async () => {
  const down = fixture({ kernel: async input => ({ point: input.point, backend: 'typesafe', source: 'fallback', mode: 'shadow', reason: 'unreachable', networkAttempted: true, usage: {}, latencyMs: 5, ledgerId: 'jx' }) });
  assert.deepEqual(await down.service.review('initiative.review', down.project, { evidence: down.evidence, freshCount: 1 }), REAL); await down.service.drain();
  assert.deepEqual([down.rows()[0].outcome.basis, down.rows()[0].outcome.route, down.rows()[0].outcome.reason], ['fallback', 'review', 'unreachable'], 'the verdict falls back to a review');
  const capped = fixture({ answers: nothing, settings: { realTokenBudget: 1000000 } });
  assert.deepEqual(await capped.service.review('initiative.review', capped.project, { evidence: capped.evidence, freshCount: 1 }), REAL); await capped.service.drain();
  assert.equal(capped.asked().length, 0, 'with an explicit cap, observation spends nothing: the main request has priority');
  assert.deepEqual([capped.rows()[0].outcome.basis, capped.rows()[0].outcome.reason], ['budget', 'shadow_budget_priority']);
  const off = fixture({ answers: nothing, mode: 'off' });
  assert.deepEqual(await off.service.review('initiative.review', off.project, { evidence: off.evidence, freshCount: 1 }), { review: true }); await off.service.drain();
  assert.equal(off.rows().length, 0, 'no judge, no shadow');
  const unkeyed = fixture({ answers: nothing }); unkeyed.store.configurationService.secrets = {}; const saved = process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_API_KEY;
  try { await unkeyed.service.review('initiative.review', unkeyed.project, { evidence: unkeyed.evidence, freshCount: 1 }); await unkeyed.service.drain(); assert.equal(unkeyed.rows().length, 0); }
  finally { if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved; }
});

test('a judge that throws never reaches the review; one that answers late never delays it', async () => {
  const f = fixture({ kernel: async () => { throw new Error('provider exploded'); } });
  assert.deepEqual(await f.service.review('initiative.review', f.project, { evidence: f.evidence, freshCount: 1 }), REAL); await f.service.drain();
  assert.equal(f.rows().length, 0, 'telemetry that failed leaves no row, and no error');
  let release; const slow = fixture({ kernel: input => new Promise(resolve => { release = () => resolve({ point: input.point, backend: 'typesafe', source: 'fallback', mode: 'shadow', reason: 'shadow', networkAttempted: true, answers: {}, usage: {}, latencyMs: 1, ledgerId: 'jy' }); }) });
  const reviewed = await slow.service.review('initiative.review', slow.project, { evidence: slow.evidence, freshCount: 1 });
  assert.deepEqual(reviewed, REAL, 'the review did not wait for the judge');
  assert.equal(slow.rows().length, 0); release(); await slow.service.drain(); assert.equal(slow.rows().length, 1);
});

test('the shadow also runs during a foreground turn (the gate judges the review then) and counts the other evidence the same review reads', async () => {
  const f = fixture({ answers: { ...nothing, needs_main_model: { type: 'boolean', probability: .95 }, evidence_relevant: { type: 'boolean', probability: .9 } } });
  f.store.state.sessions[0].status = 'running';
  const during = await f.service.review('initiative.review', f.project, { evidence: f.evidence, freshCount: 1, progress: { key: 'k', foreground: { turnIds: ['t'], sessionIds: ['s'], request: 'Write chapter 4' }, work: [] } });
  assert.equal(during.bypass, undefined, 'judged by the gate, not bypassed');
  await f.service.drain();
  assert.equal(f.rows()[0].outcome.real, 'judged'); assert.equal(f.rows()[0].outcome.others, undefined);
  // A user message arrived in the same pass: the review is not this completion's alone.
  const mixed = fixture({ answers: nothing });
  await mixed.service.review('initiative.review', mixed.project, { evidence: [...mixed.evidence, { id: 'message:m1', type: 'user_message', summary: 'hello', at: BASE }], freshCount: 3 }); await mixed.service.drain();
  assert.equal(mixed.rows()[0].outcome.others, 2);
});

test('two runs that finished before one review each count the other as new evidence: neither row is one run\'s alone', async () => {
  const f = fixture({ answers: nothing });
  f.project.initiativeRuntime.sdkState.actions.push({ id: 'w2', action: 'work', status: 'completed', createdAt: COMPLETED_AT - 300000, finishedAt: COMPLETED_AT + 1000, evidenceIds: [], handoff: 'Checked the sources again; nothing new.' });
  f.project.jobs.push({ id: 'w2', lane: 'background', kind: 'research', status: 'completed' });
  const both = [...f.evidence, { id: 'action:w2:completed', type: 'action_completed', summary: 'work completed. Checked again.', at: COMPLETED_AT + 1000 }];
  assert.deepEqual(await f.service.review('initiative.review', f.project, { evidence: both, freshCount: 2 }), REAL); await f.service.drain();
  assert.deepEqual(f.rows().map(row => [row.outcome.actionId, row.outcome.others]).sort(), [['w1', 1], ['w2', 1]], 'each row counts the other completion (a user message was already counted)');
  // The caller gave no count: what the review reads that is not this completion (an already-reviewed one is not new).
  const g = fixture({ answers: nothing });
  g.project.initiativeRuntime.sdkState.actions.push({ id: 'w0', action: 'work', status: 'completed', createdAt: COMPLETED_AT - 900000, finishedAt: COMPLETED_AT - 800000, evidenceIds: [], handoff: 'Earlier.' });
  await g.service.review('initiative.review', g.project, { evidence: [{ id: 'action:w0:completed', type: 'action_completed', summary: 'old', at: COMPLETED_AT - 3 * 3600000 }, ...g.evidence, { id: 'message:m1', type: 'user_message', summary: 'hello', at: BASE }] }); await g.service.drain();
  assert.equal(g.rows().length, 1); assert.equal(g.rows()[0].outcome.others, 1, 'the user message: the old completion was reviewed already');
});

test('without a JEV key a fast model is no observer: it is never asked and nothing is recorded, the review is the same', async () => {
  const f = fixture({ answers: nothing, kernelConfig: { fastModel: { providerId: 'fast', modelId: 'fast-1' } } });
  f.store.configurationService.secrets = {}; const saved = process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_API_KEY;
  f.service.judgeModel = () => ({ execution: 'rna' });
  try {
    assert.equal(f.service.config().backend, 'llm', 'with no JEV key the fast model is the judge backend');
    assert.equal(f.service.enabled('work.completion'), true, 'so the point would be ready: it is the shadow\'s own rule that keeps it off');
    assert.equal(f.service.completionShadow(f.project, f.evidence, { freshCount: 1, bypass: 'delivery_just_completed' }), 0, 'an unprobed, paid judge is not asked on every completion');
    assert.deepEqual(await f.service.review('initiative.review', f.project, { evidence: f.evidence, freshCount: 1 }), REAL); await f.service.drain();
    assert.equal(f.asked().length, 0); assert.deepEqual(f.rows(), []);
  } finally { if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved; }
  // With a JEV key beside it the JEV backend wins and the shadow runs.
  const keyed = fixture({ answers: nothing, kernelConfig: { fastModel: { providerId: 'fast', modelId: 'fast-1' } } });
  keyed.service.judgeModel = () => ({ execution: 'rna' });
  assert.equal(keyed.service.config().backend, 'typesafe');
  await keyed.service.review('initiative.review', keyed.project, { evidence: keyed.evidence, freshCount: 1 }); await keyed.service.drain();
  assert.equal(keyed.rows().length, 1);
});

test('even when a diagnostic override puts the point in active mode, nothing is applied: the row is recorded as the shadow it is', async () => {
  const f = fixture({ answers: nothing, kernelConfig: { mode: 'active', modes: { 'work.completion': 'active', 'initiative.gate': 'active', 'initiative.review': 'active' } } });
  assert.equal(f.service.config().modes['work.completion'], 'active', 'the override took effect');
  assert.deepEqual(await f.service.review('initiative.review', f.project, { evidence: f.evidence, freshCount: 1 }), REAL, 'the real routing is unchanged');
  await f.service.drain();
  const [row] = f.rows();
  assert.deepEqual([row.outcome.route, row.mode, row.source, row.reason], ['defer', 'shadow', 'fallback', 'shadow']);
  assert.notEqual(row.applied, true);
});

test('the point is built in as a shadow point: the settings list it, it can never be switched to active, and it is not gated by the project\'s review signals', async () => {
  const f = fixture({ answers: nothing });
  const info = f.service.public().points.find(row => row.point === 'work.completion');
  assert.deepEqual([info.mode, info.builtIn, info.templateVersion, info.stake], ['shadow', true, 1, 'medium']);
  assert.match(info.effect, /^shadow:/);
  assert.equal(f.service.config().modes['work.completion'], 'shadow');
  await f.service.review('initiative.review', f.project, { evidence: f.evidence, freshCount: 1 }); await f.service.drain();
  assert.equal(f.asked()[0].signals.deliveryJustCompleted, undefined, 'the judge is asked even though the project signals say a review is due');
});

test('completionReport reads the ledger and the work-outcome view; an invalid window is a 400', async () => {
  const f = fixture({ answers: nothing });
  await f.service.review('initiative.review', f.project, { evidence: f.evidence, freshCount: 1 }); await f.service.drain();
  const report = f.service.completionReport({ window: '7d' });
  assert.equal(report.rows, 1); assert.deepEqual(report.basis, { judge: 1 }); assert.deepEqual(report.verdicts, { review: 0, defer: 1 });
  assert.equal(report.comparison.defer.unreviewed, 1, 'no decision has followed it yet: nothing to rate');
  f.project.initiativeRuntime.sdkState.lastDecision = { at: BASE, action: 'wait' };
  assert.equal(f.service.completionReport({ window: '7d' }).comparison.defer.waited, 1, 'a decision followed and admitted nothing: the model\'s own choice, listed apart');
  assert.equal(f.service.completionReport({ window: '24h', projectId: 'p' }).rows, 1);
  assert.equal(f.service.completionReport({ projectId: 'nope' }).rows, 0);
  assert.throws(() => f.service.completionReport({ window: 'forever' }), error => error.status === 400 && error.code === 'window_invalid');
  assert.throws(() => f.service.completionReport({ archived: 'maybe' }), error => error.status === 400 && error.code === 'archived_invalid');
});
