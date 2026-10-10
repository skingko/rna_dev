// Plan 2026-10-05 D2 (the option-B completion gate, SHADOW): what the host knows by code about a finished background run, the
// route it would take, and the comparison of that verdict with what the review it triggered came to (C2's work-outcome view).
// mu: notify-routing.ts:33-60 (now | next_turn | drop, unjudged next_turn), goal-met.ts:7-17 (facts outrank the closing message;
// "is it done" is never asked of a closing message).
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPLETION_CLASSES, COMPLETION_POINT, unreviewedCompletions, completionFacts, completionLabel, wakeAfter, wakesAfter, toldByReview, reviewedAfter, followUpsOf, reviewFollowUps, completionReport } from '../work-completion.mjs';
import { outcomeFacts, actionOutcome } from '../work-outcome.mjs';

const MIN = 60000, HOUR = 3600000;
const NOW = Date.parse('2026-10-05T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const action = (id, kind, status, extra = {}) => ({ id, action: kind, status, createdAt: NOW - 5 * HOUR, finishedAt: NOW - 4 * HOUR, evidenceIds: [], ...extra });
const job = (id, extra = {}) => ({ id, lane: 'background', kind: 'research', status: 'completed', ...extra });
const project = (actions = [], extra = {}) => ({ id: 'p1', name: 'Billing service', description: 'Keep the invoice API correct', initiativeRuntime: { sdkState: { actions, lastDecision: { at: NOW - HOUR } } }, jobs: [], backgroundChanges: [], directFixes: [], inbox: [], mind: { threads: [] }, git: { applies: [] }, ...extra });
const completed = (id, at = NOW - 4 * HOUR) => ({ id: `action:${id}:completed`, type: 'action_completed', summary: `work completed. ${id}`, at });

test('unreviewedCompletions: the completed work actions no decision has followed (the signal deliveryJustCompleted is true exactly then)', () => {
  const actions = [action('w1', 'work', 'completed'), action('w2', 'work', 'completed'), action('s1', 'share', 'completed'), action('l1', 'learn', 'completed')];
  const evidence = [completed('w1', 100), completed('w2', 300), completed('s1', 300), completed('l1', 300), { id: 'user:1', type: 'user_message', at: 300 }, completed('w2', 300), completed('ghost', 300)];
  assert.deepEqual(unreviewedCompletions(evidence, actions, 200).map(row => row.id), ['w2'], 'w1 predates the last decision; shares and learning are not work; an unknown run is not an action');
  assert.deepEqual(unreviewedCompletions(evidence, actions, undefined).map(row => row.id), ['w1', 'w2'], 'no decision yet: every completion');
  assert.deepEqual(unreviewedCompletions([{ id: 'action:w1:completed', type: 'action_completed' }], actions, 200).map(row => row.id), ['w1'], 'a completion without a time is unreviewed');
  assert.deepEqual(unreviewedCompletions([], actions, 0), []);
});

test('completionFacts: code facts first, in order — needs_review, unreported, schedule_occurrence, resolves_pending, no_handoff, then the judge', () => {
  const run = (extra = {}, jobExtra = {}, projectExtra = {}) => { const row = action('w', 'work', 'completed', { handoff: 'Done: checked 14 endpoints. Nothing left.', ...extra }); return completionFacts(project([row], { jobs: [job('w', jobExtra)], ...projectExtra }), row); };
  assert.deepEqual(COMPLETION_CLASSES, ['needs_review', 'unreported', 'schedule_occurrence', 'resolves_pending', 'no_handoff', 'judge']);
  const plain = run();
  assert.deepEqual([plain.class, plain.route, plain.handoff, plain.change, plain.changed], ['judge', null, 'Done: checked 14 endpoints. Nothing left.', 'none', 'none'], 'nothing a code fact settles: the judge reads the handoff');
  // A scheduled occurrence is the user's schedule firing: no review (the host delivers it).
  assert.deepEqual([run({ hostSchedule: { key: 'k' } }).class, run({ hostSchedule: { key: 'k' } }).route], ['schedule_occurrence', 'defer']);
  // A run that fulfils a request or an open item owes the user an answer: review as today.
  assert.deepEqual([run({ resolves: ['c1'] }).class, run({ resolves: ['c1'] }).route], ['resolves_pending', 'review']);
  assert.equal(run({ resolves: [] }).class, 'judge', 'an empty list resolves nothing');
  // It ended without a report (its last step was an unsent tool call): review as today, whatever else is true of it.
  for (const extra of [{}, { resolves: ['c1'] }, { hostSchedule: { key: 'k' } }]) assert.deepEqual([run(extra, { unreported: true }).class, run(extra, { unreported: true }).route], ['unreported', 'review']);
  // A job that did not end cleanly needs a check.
  assert.equal(run({}, { status: 'needs_review' }).class, 'needs_review');
  assert.equal(run({ status: 'needs_review' }).class, 'needs_review');
  assert.deepEqual([run({}, { status: 'needs_review', unreported: true }).class], ['needs_review'], 'the stronger fact first');
  // Nothing to read: the worker left no handoff.
  assert.deepEqual([run({ handoff: '' }).class, run({ handoff: '   ' }).class, run({ handoff: undefined }).route], ['no_handoff', 'no_handoff', 'review']);
  // The job's handoff is read when the action row has none (the job outlives the SDK's history compaction).
  assert.equal(run({ handoff: undefined }, { handoff: 'From the job.' }).handoff, 'From the job.');
  // The change set is a fact for the report, never for the judge: its status and how many files.
  const kept = project([action('w', 'work', 'completed', { handoff: 'h' })], { jobs: [job('w')], backgroundChanges: [{ id: 'c', kind: 'git', actionId: 'w', at: iso(NOW), status: 'kept', files: [{ path: 'a' }, { path: 'b' }] }] });
  const facts = completionFacts(kept, kept.initiativeRuntime.sdkState.actions[0]);
  assert.deepEqual([facts.change, facts.changed, facts.class], ['applied', 'few', 'judge']);
  const waiting = project([action('w', 'work', 'completed', { handoff: 'h' })], { jobs: [job('w')], backgroundChanges: [{ id: 'c', kind: 'git', actionId: 'w', at: iso(NOW), status: 'deferred', files: [{ path: 'a' }] }] });
  assert.deepEqual([completionFacts(waiting, waiting.initiativeRuntime.sdkState.actions[0]).change, completionFacts(waiting, waiting.initiativeRuntime.sdkState.actions[0]).changed], ['waiting', 'one']);
});

test('completionLabel: what the review that followed a completion came to, from records — not from what the model chose', () => {
  const run = delivered => ({ stages: Number.isFinite(delivered) ? { delivered } : {} });
  const f = (outcome, kind = 'work', extra = {}) => ({ id: 'x', kind, outcome, ...extra });
  assert.deepEqual(completionLabel({ run: run(NOW), reviewed: true }), { label: 'productive', told: true, followedWork: false, followedVisible: false }, 'a message that cites it reached the user');
  assert.equal(completionLabel({ run: run(), followUps: [f('visible')], reviewed: true }).label, 'productive', 'an action it led to became visible');
  assert.equal(completionLabel({ run: run(), followUps: [f('visible', 'share')], reviewed: true }).followedWork, false);
  assert.equal(completionLabel({ run: run(), followUps: [f('pending')], reviewed: true }).label, 'pending', 'an action it led to is not settled');
  assert.equal(completionLabel({ run: run(), followUps: [f('none'), f('pending')], reviewed: true }).label, 'pending');
  assert.equal(completionLabel({ run: run(), followUps: [f('none'), f('failed'), f('undone')], reviewed: true }).label, 'unproductive', 'the review admitted work and none of it became visible');
  assert.equal(completionLabel({ run: run(), followUps: [], reviewed: true }).label, 'waited', 'a review that admitted nothing: the model\'s own choice, listed apart');
  assert.equal(completionLabel({ run: run(), followUps: [], reviewed: false }).label, 'unreviewed');
  assert.equal(completionLabel({ run: null, followUps: [], reviewed: false }).label, 'unreviewed', 'no outcome record at all (a scheduled occurrence has none)');
  // A follow-up the user stopped, a restart or a scope change cut says nothing about whether the review was needed.
  assert.equal(completionLabel({ run: run(), followUps: [f('none', 'work', { neutral: true })], reviewed: true }).label, 'waited');
  assert.equal(completionLabel({ run: run(), followUps: [f('none', 'work', { neutral: true }), f('visible')], reviewed: true }).label, 'productive');
  assert.equal(completionLabel({ run: run(), followUps: [f('none', 'work', { neutral: true })], reviewed: false }).label, 'waited', 'a follow-up exists, so a decision was made');
});

test('wakeAfter and reviewedAfter: the first review that read the completion, else the project\'s last decision, else a later action', () => {
  const wake = (at, outcome, extra = {}) => ({ at: iso(at), outcome, ...extra });
  const rows = [wake(NOW - 5 * HOUR, 'work'), wake(NOW - 3 * HOUR, 'deferred'), wake(NOW - 2 * HOUR, 'interrupted'), wake(NOW - HOUR, 'thought', { tokens: 30000, latencyMs: 20000 })];
  assert.equal(wakeAfter(rows, NOW - 4 * HOUR)?.tokens, 30000, 'a gate deferral and an interrupted wake did not reach a decision');
  assert.equal(wakeAfter(rows, NOW - 4 * HOUR + 1)?.tokens, 30000);
  assert.equal(wakeAfter([wake(NOW - 4 * HOUR + 5000, 'thought', { latencyMs: 60000 })], NOW - 4 * HOUR), null, 'a decision that started before the run ended did not read it');
  assert.equal(wakeAfter([], NOW), null); assert.equal(wakeAfter(rows, undefined), null);
  const base = project([action('w', 'work', 'completed')]);
  assert.equal(reviewedAfter(base, NOW - 4 * HOUR, []), true, 'the last decision came after');
  base.initiativeRuntime.sdkState.lastDecision = { at: NOW - 6 * HOUR };
  assert.equal(reviewedAfter(base, NOW - 4 * HOUR, []), false, 'no decision since, no wake row');
  base.initiativeRuntime.sdkState.actions.push(action('later', 'share', 'completed', { createdAt: NOW - 3 * HOUR }));
  assert.equal(reviewedAfter(base, NOW - 4 * HOUR, []), true, 'an action created after it');
  base.initiativeRuntime.sdkState.actions.at(-1).hostSchedule = { key: 'k' };
  assert.equal(reviewedAfter(base, NOW - 4 * HOUR, []), false, 'a scheduled occurrence is no decision');
  assert.equal(reviewedAfter(base, NOW - 4 * HOUR, rows), true, 'a wake row after it');
});

/**
 * One project, seven completions (one ledger row each) and the wake rows of the reviews they woke: what the report must make
 * of them. Each run ends an hour after the one before it; its review is the wake row ten minutes later.
 */
function fixture() {
  const end = index => NOW - (8 - index) * HOUR, wake = (index, outcome, extra = {}) => ({ at: iso(end(index) + 10 * MIN), outcome, tokens: 25000, latencyMs: MIN, ...extra });
  const actions = [
    action('r1', 'work', 'completed', { handoff: 'Nothing found.', createdAt: end(0) - 10 * MIN, finishedAt: end(0) }),                // would defer; the review waited
    action('r2', 'work', 'completed', { handoff: 'Found a problem.', createdAt: end(1) - 10 * MIN, finishedAt: end(1) }),              // would review (untold); the review shared it
    action('r3', 'work', 'completed', { handoff: 'Quiet.', createdAt: end(2) - 10 * MIN, finishedAt: end(2) }),                        // would defer; the review started work that became visible: a missed review
    action('r4', 'work', 'completed', { handoff: 'Next: run the suite.', createdAt: end(3) - 10 * MIN, finishedAt: end(3) }),          // would review (next step); the work it started came to nothing
    action('r5', 'work', 'completed', { handoff: '', hostSchedule: { key: 'k' }, createdAt: end(4) - 10 * MIN, finishedAt: end(4) }),  // scheduled: would defer; the review waited
    action('r6', 'work', 'completed', { handoff: 'Quiet again.', createdAt: end(5) - 10 * MIN, finishedAt: end(5) }),                  // other evidence in the same review: left out
    action('r7', 'work', 'completed', { handoff: 'Budget.', createdAt: end(6) - 10 * MIN, finishedAt: end(6) }),                       // no verdict
    action('s2', 'share', 'completed', { evidenceIds: ['action:r2:completed'], createdAt: end(1) + 10 * MIN, finishedAt: end(1) + 11 * MIN }),
    action('w3', 'work', 'completed', { evidenceIds: ['action:r3:completed'], createdAt: end(2) + 10 * MIN, finishedAt: end(2) + 30 * MIN }),
    action('w4', 'work', 'completed', { evidenceIds: ['action:r4:completed'], createdAt: end(3) + 10 * MIN, finishedAt: end(3) + 30 * MIN }),
  ];
  const p = project(actions, {
    jobs: actions.filter(row => row.action === 'work').map(row => job(row.id)),
    backgroundChanges: [{ id: 'c3', kind: 'git', actionId: 'w3', at: iso(end(2) + 30 * MIN), status: 'kept', files: [{ path: 'a.md' }] }],
    inbox: [{ id: 'e2', actionId: 's2', kind: 'share', tier: 'inline', createdAt: iso(end(1) + 11 * MIN), status: 'unread', feedback: null }],
  });
  const message = { id: 'm2', kind: 'assistant', source: 'initiative', initiativeActionId: 's2', createdAt: iso(end(1) + 11 * MIN), text: 'x', evidenceIds: ['action:r2:completed'], initiative: { kind: 'insight', reach: 'inline' } };
  const state = { projects: [p], sessions: [{ id: 's1', projectId: 'p1', items: [message] }] };
  const wakeRows = [wake(0, 'thought'), wake(1, 'work', { actionId: 's2' }), wake(2, 'work', { actionId: 'w3' }), wake(3, 'work', { actionId: 'w4' }), wake(4, 'thought'), wake(5, 'thought'), wake(6, 'thought')];
  const wakes = { rows: () => wakeRows };
  const row = (id, at, outcome, predictions) => ({ id: `row-${id}`, at, point: COMPLETION_POINT, scope: { projectId: 'p1' }, outcome: { actionId: id, real: 'delivery_just_completed', ...outcome }, ...(predictions ? { predictions } : {}) });
  const ledger = [
    row('r1', NOW - 4 * HOUR + MIN, { basis: 'judge', route: 'defer', reason: 'nothing_to_act_on' }, { reports_untold: .05, names_next_step: .04, evidence_relevant: .9 }),
    row('r2', NOW - 4 * HOUR + 2 * MIN, { basis: 'judge', route: 'review', reason: 'reports_untold' }, { reports_untold: .95, names_next_step: .1, evidence_relevant: .9 }),
    row('r3', NOW - 4 * HOUR + 3 * MIN, { basis: 'judge', route: 'defer', reason: 'nothing_to_act_on' }, { reports_untold: .1, names_next_step: .1, evidence_relevant: .95 }),
    row('r4', NOW - 4 * HOUR + 4 * MIN, { basis: 'judge', route: 'review', reason: 'names_next_step' }, { reports_untold: .1, names_next_step: .9, evidence_relevant: .9 }),
    row('r5', NOW - 4 * HOUR + 5 * MIN, { basis: 'code_fact', route: 'defer', reason: 'completion_schedule_occurrence', class: 'schedule_occurrence' }),
    row('r6', NOW - 4 * HOUR + 6 * MIN, { basis: 'judge', route: 'defer', reason: 'nothing_to_act_on', others: 2 }, { reports_untold: .05, names_next_step: .05, evidence_relevant: .9 }),
    row('r7', NOW - 4 * HOUR + 7 * MIN, { basis: 'budget', route: 'review', reason: 'shadow_budget_priority' }),
    { ...row('old', NOW - 40 * 24 * HOUR, { basis: 'judge', route: 'defer', reason: 'nothing_to_act_on' }, { reports_untold: .05, names_next_step: .05, evidence_relevant: .9 }) },
    { id: 'other-point', at: NOW - HOUR, point: 'initiative.review', scope: { projectId: 'p1' }, outcome: { actionId: 'r1', route: 'review' } },
  ];
  return { p, state, ledger, wakes, wakeRows, end };
}

test('completionReport: would-be route against what the review came to; deferMissed, reviewWasted, mixed rows left out, no-verdict rows counted apart', () => {
  const { state, ledger, wakes } = fixture();
  const report = completionReport(state, { rows: ledger, wakes, window: '7d', now: NOW });
  assert.equal(report.point, 'work.completion'); assert.equal(report.mode, 'shadow');
  assert.equal(report.rows, 7, 'the window, and only this point');
  assert.deepEqual(report.basis, { judge: 5, code_fact: 1, budget: 1 });
  assert.deepEqual(report.classes, { schedule_occurrence: 1 });
  assert.equal(report.mixed, 1, 'r6: the same review also read other evidence');
  assert.deepEqual(report.attribution, { wake: 6 }, 'every verdict is read against the decision its wake row records');
  assert.deepEqual(report.comparison.defer, { productive: 1, unproductive: 0, waited: 2, pending: 0, unreviewed: 0 }, 'r1 and r5 waited; r3 led to a visible change');
  assert.deepEqual(report.comparison.review, { productive: 1, unproductive: 1, waited: 0, pending: 0, unreviewed: 0 }, 'r2 told the user; r4\'s work came to nothing');
  assert.deepEqual(report.verdicts, { review: 2, defer: 3 });
  assert.deepEqual(report.deferMissed, { n: 1, of: 3, rate: .333 }, 'a skip would have lost one of three');
  assert.deepEqual(report.reviewWasted, { n: 1, of: 2, rate: .5, waited: 0 });
  assert.deepEqual(report.byBasis.code_fact.defer, { productive: 0, unproductive: 0, waited: 1, pending: 0, unreviewed: 0 });
  assert.equal(report.byBasis.judge.defer.waited, 1);
  assert.equal(report.questions.reports_untold.told.n, 1, 'r2 is the only run a message told the user about');
  assert.equal(report.questions.reports_untold.told.mean, .95);
  assert.equal(report.questions.reports_untold.notTold.n, 3);
  assert.equal(report.questions.names_next_step.followedWork.n, 2, 'r3 and r4 were followed by work');
  assert.equal(report.judged, 4, 'the judged, labelled, unmixed rows');
  assert.deepEqual(report.tokens, { deferWouldHaveSkipped: 25000 * 3, reviewKept: 25000 * 2 }, 'the wake row after each run');
  assert.ok(report.sample.length >= 6 && report.sample.every(entry => entry.actionId && !('text' in entry) && !('handoff' in entry)), 'ids, codes and probabilities only: no text');
  const r3 = report.sample.find(entry => entry.actionId === 'r3');
  assert.deepEqual([r3.label, r3.run.outcome, r3.run.reason, r3.attribution, r3.followUps.map(item => `${item.kind}:${item.outcome}`)], ['productive', 'none', 'nothing_visible', 'wake', ['work:visible']], 'the run itself showed nothing; the work its review started did');
  assert.equal(report.sample.find(entry => entry.actionId === 'r2').run.reason, 'cited_by_delivery');
  // The same rows, a narrower window or another project.
  assert.equal(completionReport(state, { rows: ledger, window: '24h', now: NOW }).rows, 7);
  assert.equal(completionReport(state, { rows: ledger, window: 'all', now: NOW }).rows, 8);
  assert.equal(completionReport(state, { rows: ledger, window: '7d', now: NOW, projectId: 'nope' }).rows, 0);
});

test('completionReport: a later decision that happens to cite a run is not what its own review did; without wake rows the citations are read', () => {
  const { p, state, ledger, wakes } = fixture();
  // The main model cites the newest events whatever they are: a later work action cites r1's completion and becomes visible.
  p.initiativeRuntime.sdkState.actions.push(action('w9', 'work', 'completed', { evidenceIds: ['action:r1:completed'], createdAt: NOW - 20 * MIN, finishedAt: NOW - 10 * MIN }));
  p.backgroundChanges.push({ id: 'c9', kind: 'git', actionId: 'w9', at: iso(NOW - 10 * MIN), status: 'kept', files: [{ path: 'b.md' }] });
  const read = report => report.sample.find(entry => entry.actionId === 'r1');
  const withWakes = completionReport(state, { rows: ledger, wakes, now: NOW });
  assert.deepEqual([read(withWakes).label, read(withWakes).attribution, read(withWakes).followUps], ['waited', 'wake', []], 'r1\'s review waited; w9 came from a later wake');
  assert.deepEqual(withWakes.comparison.defer, { productive: 1, unproductive: 0, waited: 2, pending: 0, unreviewed: 0 });
  // No wake row can say (the wake log holds none for the time): the actions that cite the completion are read instead.
  const withoutWakes = completionReport(state, { rows: ledger, wakes: null, now: NOW });
  assert.deepEqual([read(withoutWakes).label, read(withoutWakes).attribution, read(withoutWakes).followUps], ['productive', 'citation', [{ kind: 'work', outcome: 'visible' }]]);
  assert.equal(withoutWakes.attribution.citation, 6);
  // A wake row from before 0.69 (outcome work, no actionId) cannot say either.
  const oldRows = [{ at: iso(NOW - 8 * HOUR + 10 * MIN), outcome: 'work', tokens: 1000, latencyMs: MIN }];
  assert.equal(read(completionReport(state, { rows: ledger, wakes: { rows: () => oldRows }, now: NOW })).attribution, 'citation');
});

test('reviewFollowUps: the wake\'s own action; a wait has none; a row that cannot say falls back to the citations', () => {
  const { p } = fixture(), facts = outcomeFacts(p, [], { now: NOW });
  const at = iso(NOW - HOUR);
  assert.deepEqual(reviewFollowUps(p, 'r3', { wake: { at, outcome: 'work', actionId: 'w3' }, facts, now: NOW }), { attribution: 'wake', followUps: [{ id: 'w3', kind: 'work', outcome: 'visible', reason: 'change_applied' }] });
  assert.deepEqual(reviewFollowUps(p, 'r3', { wake: { at, outcome: 'thought' }, facts, now: NOW }), { attribution: 'wake', followUps: [] });
  assert.equal(reviewFollowUps(p, 'r3', { wake: { at, outcome: 'work' }, facts, now: NOW }).attribution, 'citation');
  assert.deepEqual(reviewFollowUps(p, 'r3', { wake: null, facts, now: NOW }).followUps.map(row => row.id), ['w3']);
  assert.deepEqual(reviewFollowUps(p, 'nobody', { wake: { at, outcome: 'work', actionId: 'gone' }, facts, now: NOW }).followUps, [{ id: 'gone', kind: 'work', outcome: 'pending' }], 'an action no record names yet is pending');
});

test('completionReport: a revert after the fact turns a productive row unproductive; a review not made yet is unreviewed', () => {
  const { p, state, ledger, wakes } = fixture();
  assert.equal(completionReport(state, { rows: ledger, wakes, now: NOW }).comparison.defer.productive, 1);
  p.backgroundChanges[0].status = 'reverted'; p.backgroundChanges[0].revertedAt = iso(NOW - MIN);
  const after = completionReport(state, { rows: ledger, wakes, now: NOW });
  assert.deepEqual([after.comparison.defer.productive, after.comparison.defer.unproductive], [0, 1], 'the follow-up change is undone: the review that led to it came to nothing');
  // No decision since the runs ended and none of them led to anything: nothing to compare yet.
  p.initiativeRuntime.sdkState.lastDecision = { at: NOW - 10 * HOUR };
  p.initiativeRuntime.sdkState.actions = p.initiativeRuntime.sdkState.actions.filter(row => ['r1', 'r5'].includes(row.id));
  const early = completionReport(state, { rows: ledger.filter(row => ['r1', 'r5'].includes(row.outcome?.actionId)), wakes: { rows: () => [] }, now: NOW });
  assert.deepEqual([early.comparison.defer.unreviewed, early.deferMissed.of], [2, 0], 'unreviewed rows are counted, never rated');
  assert.equal(early.deferMissed.rate, null);
});

test('followUpsOf: the actions that cite a completion, with their own outcome; a schedule occurrence\'s are not decisions', () => {
  const { p } = fixture();
  const facts = outcomeFacts(p, [], { now: NOW });
  assert.deepEqual(followUpsOf(p, 'r3', facts, NOW).map(row => [row.id, row.kind, row.outcome]), [['w3', 'work', 'visible']]);
  assert.deepEqual(followUpsOf(p, 'r1', facts, NOW), []);
  p.initiativeRuntime.sdkState.actions.find(row => row.id === 'w3').hostSchedule = { key: 'k' };
  assert.deepEqual(followUpsOf(p, 'r3', outcomeFacts(p, [], { now: NOW }), NOW), []);
});

// ---------------------------------------------------------------- review findings (D2 fix pass)
/** The delivery of a message that cites the given completions, by a share action decided by the review at `at` (a wake row beside it). */
function laterShare(p, state, wakeRows, { id = 's9', cites = ['r1'], at = NOW - HOUR } = {}) {
  p.initiativeRuntime.sdkState.actions.push(action(id, 'share', 'completed', { evidenceIds: cites.map(run => `action:${run}:completed`), createdAt: at - MIN, finishedAt: at }));
  state.sessions[0].items.push({ id: `m-${id}`, kind: 'assistant', source: 'initiative', initiativeActionId: id, createdAt: iso(at), text: 'x', evidenceIds: cites.map(run => `action:${run}:completed`), initiative: { kind: 'insight', reach: 'inline' } });
  wakeRows.push({ at: iso(at), outcome: 'work', tokens: 25000, latencyMs: MIN, actionId: id });
}

test('toldByReview: a message that merely cites the run counts only when the review that read the run delivered it, or it reached the user before the next review', () => {
  const { p, state, wakeRows } = fixture();
  laterShare(p, state, wakeRows);
  const facts = outcomeFacts(p, state.sessions, { now: NOW }), run = actionOutcome(p, 'r1', NOW, { facts }), [wake, next] = wakesAfter(wakeRows, NOW - 8 * HOUR, 2);
  assert.equal(run.via, 'cited'); assert.equal(Number.isFinite(run.stages.delivered), true, 'the view counts a later citing message as the run\'s delivery');
  assert.equal(wake.actionId, undefined, 'r1\'s own review waited'); assert.equal(next.actionId, 's2', 'the next review is another one');
  assert.equal(toldByReview(p, 'r1', { run, wake, next, facts, now: NOW }), false, 'delivered hours after the next review began: not what r1\'s review did');
  assert.equal(toldByReview(p, 'r1', { run, wake, next: null, facts, now: NOW }), true, 'no later review exists: the message reached the user before any other review');
  assert.equal(toldByReview(p, 'r1', { run, wake: null, facts, now: NOW }), true, 'without a wake row nothing says which review it came from: citations are read (attribution: citation)');
  assert.equal(toldByReview(p, 'r1', { run: { ...run, stages: {} }, wake, next, facts, now: NOW }), false, 'nothing reached the user');
  // The review's own action delivered it, however late.
  assert.equal(toldByReview(p, 'r1', { run, wake: { ...wake, actionId: 's9' }, next, facts, now: NOW }), true);
  // Delivered before the next review began (not by the wake's own action: it admitted nothing).
  assert.equal(toldByReview(p, 'r1', { run, wake, next: { at: iso(NOW + HOUR), outcome: 'thought', latencyMs: MIN }, facts, now: NOW }), true);
  // The run's own delivery is the run's, whatever the review did.
  assert.equal(toldByReview(p, 'r1', { run: { ...run, via: undefined }, wake, next, facts, now: NOW }), true);
});

test('completionReport: a later review that shares a message citing a run does not make the run\'s own waiting review productive', () => {
  const { p, state, ledger, wakes, wakeRows } = fixture();
  laterShare(p, state, wakeRows);  // r1: verdict defer, its review (wake 0) waited; four hours later another review shares a message citing it
  const report = completionReport(state, { rows: ledger, wakes, now: NOW });
  const r1 = report.sample.find(entry => entry.actionId === 'r1');
  assert.deepEqual([r1.label, r1.attribution, r1.followUps, r1.run.reason], ['waited', 'wake', [], 'cited_by_delivery'], 'the view calls the run delivered; its own review did nothing');
  assert.deepEqual(report.comparison.defer, { productive: 1, unproductive: 0, waited: 2, pending: 0, unreviewed: 0 }, 'r3 only: r1 is not a missed skip');
  assert.deepEqual(report.deferMissed, { n: 1, of: 3, rate: .333 });
  assert.equal(report.questions.reports_untold.told.n, 1, 'r1 was not told by its review: the question\'s labels stay r2 only');
  // The review that read r1 is the one that shares: the same run IS productive.
  const { p: q, state: stateQ, ledger: ledgerQ, wakes: wakesQ, wakeRows: rowsQ } = fixture();
  laterShare(q, stateQ, rowsQ, { id: 's8', cites: ['r1'], at: NOW - 8 * HOUR + 12 * MIN });
  rowsQ.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)); rowsQ.splice(rowsQ.findIndex(row => row.outcome === 'thought' && Date.parse(row.at) === NOW - 8 * HOUR + 10 * MIN), 1);
  rowsQ.find(row => row.actionId === 's8').at = iso(NOW - 8 * HOUR + 10 * MIN);
  const own = completionReport(stateQ, { rows: ledgerQ, wakes: wakesQ, now: NOW }).sample.find(entry => entry.actionId === 'r1');
  assert.deepEqual([own.label, own.attribution, own.followUps], ['productive', 'wake', [{ kind: 'share', outcome: 'visible' }]], 'its own review\'s action delivered it');
});

test('completionReport: completions read by one review are mixed, whatever each row counted when it was written', () => {
  const { state, ledger, wakeRows, end } = fixture();
  // r1 and r2 finished before the same review began (one wake row decided after both and before r3 ended): each row says others 0, the report knows better.
  const together = { rows: () => [{ at: iso(end(1) + 30 * MIN), outcome: 'thought', tokens: 25000, latencyMs: MIN }, ...wakeRows.slice(2)] };
  assert.deepEqual(wakeAfter(together.rows(), end(0)), wakeAfter(together.rows(), end(1)), 'one review follows both runs');
  const report = completionReport(state, { rows: ledger, wakes: together, now: NOW });
  assert.deepEqual(report.sample.filter(entry => entry.sharedReview).map(entry => [entry.actionId, entry.sharedReview, entry.others]).sort(), [['r1', 2, 1], ['r2', 2, 1]]);
  assert.equal(report.mixed, 3, 'r1 and r2 read together, and r6 by its own count');
  assert.deepEqual(report.verdicts, { review: 1, defer: 2 }, 'neither shared row is rated: r3, r4 and r5 are');
  assert.deepEqual(report.deferMissed, { n: 1, of: 2, rate: .5 });
  // A review that read only one completion row is not shared; a row outside the window still counts as a reader of the same review.
  assert.equal(completionReport(state, { rows: ledger.filter(row => row.outcome?.actionId !== 'r2'), wakes: together, now: NOW }).sample.find(entry => entry.actionId === 'r1').sharedReview, undefined);
  const old = ledger.map(row => row.outcome?.actionId === 'r2' ? { ...row, at: NOW - 20 * 24 * HOUR } : row);
  assert.equal(completionReport(state, { rows: old, wakes: together, window: '24h', now: NOW }).sample.find(entry => entry.actionId === 'r1').sharedReview, 2);
});

test('completionReport: a run\'s end time comes from its action, else its job; a ledger row\'s own time is never a stand-in', () => {
  const { p, state, ledger, wakes, end } = fixture();
  // The SDK dropped r3's action row (past its history); the job outlives it and says when it ended.
  p.initiativeRuntime.sdkState.actions = p.initiativeRuntime.sdkState.actions.filter(row => row.id !== 'r3');
  p.jobs.find(row => row.id === 'r3').completedAt = iso(end(2));
  const withJob = completionReport(state, { rows: ledger, wakes, now: NOW }).sample.find(entry => entry.actionId === 'r3');
  assert.deepEqual([withJob.attribution, withJob.label, withJob.followUps], ['wake', 'productive', [{ kind: 'work', outcome: 'visible' }]], 'its own review (the one that started w3), not a later one: the row was written hours after');
  // Neither is left: no review can be tied to the run.
  p.jobs = p.jobs.filter(row => row.id !== 'r3');
  const gone = completionReport(state, { rows: ledger, wakes, now: NOW });
  const entry = gone.sample.find(item => item.actionId === 'r3');
  assert.deepEqual([entry.attribution, entry.label], ['unknown', null]);
  assert.equal(gone.attribution.unknown, 1);
  assert.equal(gone.verdicts.defer, 2, 'left out of the comparison, not guessed');
});

test('completionReport: a review the host had to make anyway is listed apart: no skip would have saved it, and its tokens are not savings', () => {
  const { state, ledger, wakes } = fixture();
  const forced = ledger.map(row => ['r1', 'r3'].includes(row.outcome?.actionId) ? { ...row, outcome: { ...row.outcome, real: row.outcome.actionId === 'r1' ? 'due_schedule' : 'pending_review' } } : row);
  const report = completionReport(state, { rows: forced, wakes, now: NOW });
  assert.deepEqual(report.forced, { n: 2, reasons: { due_schedule: 1, pending_review: 1 }, comparison: { review: { productive: 0, unproductive: 0, waited: 0, pending: 0, unreviewed: 0 }, defer: { productive: 1, unproductive: 0, waited: 1, pending: 0, unreviewed: 0 } } });
  assert.deepEqual(report.comparison.defer, { productive: 0, unproductive: 0, waited: 1, pending: 0, unreviewed: 0 }, 'only r5 (a scheduled occurrence, delivery_just_completed) remains');
  assert.deepEqual(report.deferMissed, { n: 0, of: 1, rate: 0 }, 'r3\'s productive review was forced by a failed check, not by this completion');
  assert.deepEqual(report.tokens, { deferWouldHaveSkipped: 25000, reviewKept: 25000 * 2 });
  assert.equal(report.judged, 2, 'the question distributions leave forced rows out');
  assert.equal(report.questions.names_next_step.followedWork.n, 1, 'r4 only');
  // The gate's own judgment during a foreground turn, and a row from before `real` was recorded, are decided by the completion.
  const judged = ledger.map(row => row.outcome?.actionId === 'r1' ? { ...row, outcome: { ...row.outcome, real: 'judged' } } : row.outcome?.actionId === 'r3' ? { ...row, outcome: { ...row.outcome, real: undefined } } : row);
  assert.deepEqual(completionReport(state, { rows: judged, wakes, now: NOW }).comparison.defer, { productive: 1, unproductive: 0, waited: 2, pending: 0, unreviewed: 0 });
});
