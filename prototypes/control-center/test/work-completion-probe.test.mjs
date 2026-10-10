// The D2 labelled probe harness (benchmark/work-completion-probe.mjs; docs/research/jev-work-completion-probe-20261005.md): its
// synthetic set must be well formed through the production state builder, its readers must count what they say, and its real-set
// builder must read a state without touching conversation replies. No network: the probe's JEV calls are not made here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, completionState, readQuestion, summarize, readRoute, decisionFollowUps, realSpecs } from '../benchmark/work-completion-probe.mjs';
import { combineWorkCompletion, WORK_COMPLETION_QUESTIONS } from '../../../packages/sdk/src/decision-templates.mjs';
import { outcomeFacts } from '../work-outcome.mjs';

test('every synthetic case builds a state that reaches the judge whole, with an expectation for each question it scores', () => {
  assert.equal(CASES.length, 35);
  assert.equal(new Set(CASES.map(row => row.id)).size, CASES.length, 'ids are unique');
  for (const row of CASES) {
    const state = completionState({ handoff: row.handoff, reports: row.reports, project: row.project });
    assert.deepEqual(Object.keys(state).sort(), ['project', 'review', 'run'], row.id);
    assert.equal(state.run.handoff, row.handoff, `${row.id}: the handoff reaches the judge whole`);
    assert.equal(state.review.recentReports.length, row.reports.length, row.id);
    for (const key of ['untold', 'next', 'relevant']) assert.ok([true, false, null].includes(row.expect[key]), `${row.id}: expect.${key}`);
  }
  // The set covers every situation its three questions name, in both languages.
  const has = test => CASES.some(test);
  assert.ok(has(row => row.expect.untold === true) && has(row => row.expect.untold === false));
  assert.ok(has(row => row.expect.next === true) && has(row => row.expect.next === false));
  assert.ok(has(row => row.expect.relevant === false));
  assert.ok(has(row => /^[\x00-\x7f]*$/.test(row.handoff)) && has(row => /[一-鿿]/.test(row.handoff)));
});

test('readQuestion counts confident verdicts at each stake tier against the truth', () => {
  const rows = [.95, .9, .1, .5].map((p, index) => ({ truth: index < 3 ? index < 2 : undefined, probabilities: { reports_untold: p } }));
  const read = readQuestion(rows, 'reports_untold', row => row.truth);
  assert.equal(read.n, 3, 'a row with no truth is not scored');
  assert.deepEqual([read.positives.n, read.negatives.n], [2, 1]);
  assert.deepEqual(read.tiers.high, { threshold: .85, yesOnPositive: 2, noOnPositive: 0, undecidedOnPositive: 0, yesOnNegative: 0, noOnNegative: 1, undecidedOnNegative: 0 });
  assert.equal(read.tiers.floor.yesOnPositive, 2);
  assert.deepEqual(Object.keys(summarize(rows, { reports_untold: row => row.truth, names_next_step: undefined })), ['reports_untold']);
});

test('readRoute counts the combined route against productive / not productive and the reasons', () => {
  const answer = (untold, next) => ({ reports_untold: { type: 'boolean', probability: untold }, names_next_step: { type: 'boolean', probability: next } });
  const rows = [[.05, .05, false], [.05, .05, true], [.95, .1, true], [.5, .5, false], [.5, .5, undefined]].map(([untold, next, productive]) => ({ productive, verdict: combineWorkCompletion(answer(untold, next)) }));
  const read = readRoute(rows, row => row.productive);
  assert.deepEqual(read.defer, { productive: 1, notProductive: 1 });
  assert.deepEqual(read.review, { productive: 1, notProductive: 1 });
  assert.deepEqual(read.reasons, { nothing_to_act_on: 2, reports_untold: 1, unsure: 1 });
  assert.deepEqual(WORK_COMPLETION_QUESTIONS, ['reports_untold', 'names_next_step', 'evidence_relevant']);
});

test('decisionFollowUps reads the first decision after the run: a wait admitted nothing, another action is the one created then, none yet is unreviewed', () => {
  const NOW = Date.parse('2026-10-05T12:00:00Z'), MIN = 60000, iso = ms => new Date(ms).toISOString();
  const run = { id: 'r', action: 'work', status: 'completed', createdAt: NOW - 3 * MIN, finishedAt: NOW - MIN };
  const follow = (decisions, actions) => { const p = project(decisions, actions); return decisionFollowUps(p, run, outcomeFacts(p, [], { now: NOW }), NOW); };
  const project = (decisions, actions) => ({ id: 'p', decisions, jobs: [], backgroundChanges: [], directFixes: [], inbox: [], mind: { threads: [] }, initiativeRuntime: { sdkState: { actions: [run, ...actions] } } });
  assert.deepEqual(follow([], []), { reviewed: false, followUps: [] }, 'no decision since');
  assert.deepEqual(follow([{ at: iso(NOW - 2 * MIN), action: 'work' }], []), { reviewed: false, followUps: [] }, 'a decision before the run ended is not its review');
  assert.deepEqual(follow([{ at: iso(NOW), action: 'wait' }, { at: iso(NOW + MIN), action: 'work' }], []), { reviewed: true, followUps: [] }, 'the first decision after it waited; a later one is not its review');
  const next = { id: 'w', action: 'work', status: 'completed', createdAt: NOW + 20000, finishedAt: NOW + 5 * MIN };
  const found = follow([{ at: iso(NOW + 25000), action: 'work' }], [next]);
  assert.deepEqual([found.reviewed, found.followUps.map(row => [row.id, row.kind])], [true, [['w', 'work']]]);
  assert.equal(follow([{ at: iso(NOW + 25000), action: 'share' }], [next]).followUps, null, 'an action the SDK no longer holds cannot be read');
});

test('realSpecs rebuilds the state from the host\'s own records only: handoff, proactive messages and the run\'s work line, never a foreground reply', () => {
  const NOW = Date.parse('2026-10-05T12:00:00Z'), MIN = 60000, iso = ms => new Date(ms).toISOString();
  const run = { id: 'run-aaaaaaaa', action: 'work', status: 'completed', createdAt: NOW - 20 * MIN, finishedAt: NOW - 10 * MIN, handoff: 'Checked the sources; nothing found.', evidenceIds: [] };
  const state = { projects: [{ id: 'project-bbbbbbbb', name: 'Research', description: 'Verified findings', jobs: [{ id: 'run-aaaaaaaa', lane: 'background', status: 'completed' }], backgroundChanges: [], directFixes: [], mind: { threads: [] }, initiativeRuntime: { sdkState: { actions: [run], lastDecision: { at: NOW } } }, decisions: [{ at: iso(NOW), action: 'wait' }],
    inbox: [{ id: 'e1', actionId: 's0', kind: 'share', createdAt: iso(NOW - 3 * 3600000), text: 'An old finding.' }, { id: 'e2', actionId: 's1', kind: 'share', createdAt: iso(NOW + 3600000), text: 'A message sent after the run.' }] }],
  sessions: [{ id: 's', projectId: 'project-bbbbbbbb', items: [
    { id: 'u1', kind: 'user', text: 'PRIVATE USER MESSAGE', createdAt: iso(NOW - 30 * MIN) },
    { id: 'a1', kind: 'assistant', text: 'PRIVATE FOREGROUND REPLY', createdAt: iso(NOW - 25 * MIN), turnId: 't1' },
    { id: 'l1', kind: 'assistant', source: 'initiative', initiativeActionId: 'run-aaaaaaaa-changes', text: 'Background work changed no files: checked the sources.', createdAt: iso(NOW - 10 * MIN), updatedAt: iso(NOW - 10 * MIN), initiative: { kind: 'background_work', backgroundWork: { status: 'done' } } }] }] };
  const [spec] = realSpecs(state, NOW);
  assert.deepEqual([spec.class, spec.project, spec.id], ['judge', 'project-', 'run-aaaa']);
  assert.equal(spec.spec.handoff, 'Checked the sources; nothing found.');
  assert.deepEqual(spec.spec.reports, ['[proactive message] An old finding.', '[background work line] Background work changed no files: checked the sources.'], 'what the user had been told by then, and no foreground reply, user message or later message');
  assert.equal(JSON.stringify(spec).includes('PRIVATE'), false);
  assert.deepEqual([spec.label.label, spec.label.told], ['waited', false], 'the decision after it waited');
});
