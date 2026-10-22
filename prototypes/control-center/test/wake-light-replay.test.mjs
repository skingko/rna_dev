import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lightProjectView } from '../benchmark/wake-light-view.mjs';
import { wakeCases, plannedRuns, runCost, runKey, SpendLedger, summarize, upperBound, auc } from '../benchmark/wake-light-replay.mjs';

// The light floor wake's host view and the replay that decides whether it ships (docs/research/wake-light-context-replay-20261022.md).
const project = { id: 'p', title: 'Daily research', focus: 'F'.repeat(900), openQuestions: ['Which channel?', 'How many items?'], actionContracts: { work: { scope: 'x'.repeat(5000) } }, capabilityContext: { tools: new Array(40).fill({ description: 'd'.repeat(500) }) },
  mind: { lessons: [{ id: 'l1', kind: 'preference', text: 'Write in Chinese' }], agenda: [{ id: 'g1', kind: 'todo', stage: 'next', text: 'Write the report '.repeat(40) }, { id: 'g2', kind: 'awaiting_user', text: 'Which channel?' }], commitments: [{ id: 'c1', kind: 'user_request', status: 'pending', text: 'Send me Friday summaries', overdueAt: '2026-10-23T00:00:00Z' }] },
  schedules: [{ id: 's1', title: 'Daily brief', task: 'T'.repeat(2000), rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, enabled: true, state: 'scheduled', nextRunAt: '2026-10-23T01:00:00.000Z' }],
  communication: { lastDeliveredAt: '2026-10-22T02:16:20.220Z', recentDeliveries: [{ text: 'Long delivery text '.repeat(200) }], pending: [], recentWorkNotReferencedByDelivery: [{ actionId: 'a1', finishedAt: 1792068051136, summary: 'Checked the sources. '.repeat(30) }] },
  rhythmStatus: { assessment: { lifecycle: 'recurring', reason: 'Daily duty continues. '.repeat(40), initiative: { mode: 'event_only', reviewAfterMs: 86400000 } } }, recentConversation: [{ id: 'm1', role: 'assistant', text: 'hello', at: '2026-10-03T01:36:10.618Z' }], pendingJobs: [] };

test('the view keeps what says whether something waits to be done and drops what only steers how', () => {
  const view = lightProjectView(project), text = JSON.stringify(view);
  assert.equal(view.title, 'Daily research'); assert.ok(view.goal.length <= 400);
  assert.deepEqual(view.agenda.map(row => row.kind), ['todo', 'awaiting_user']); assert.equal(view.agenda[0].stage, 'next'); assert.ok(view.agenda[0].text.length <= 160); assert.equal(view.agenda[0].id, undefined);
  assert.equal(view.openRequests[0].text, 'Send me Friday summaries'); assert.equal(view.openRequests[0].status, 'pending');
  assert.deepEqual(view.schedules, [{ title: 'Daily brief', rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, enabled: true, state: 'scheduled', nextRunAt: '2026-10-23T01:00:00.000Z' }]);
  assert.equal(view.delivery.lastDeliveredAt, '2026-10-22T02:16:20.220Z'); assert.equal(view.delivery.finishedWorkNotInAnyDelivery.length, 1); assert.ok(view.delivery.finishedWorkNotInAnyDelivery[0].summary.length <= 160);
  assert.equal(view.rhythm.lifecycle, 'recurring'); assert.ok(view.rhythm.reason.length <= 420); assert.deepEqual(view.rhythm.initiative, { mode: 'event_only', reviewAfterMs: 86400000 });
  assert.equal(view.conversation.newestRole, 'assistant');
  for (const dropped of ['Write in Chinese', 'Long delivery text', 'TTTT', 'xxxxx', 'dddd']) assert.ok(!text.includes(dropped), `${dropped} is not in the view`);
  assert.ok(text.length < 3500, 'a view is a few thousand characters');
});
test('an empty project gives an empty view without throwing', () => { assert.deepEqual(lightProjectView({}), {}); assert.deepEqual(lightProjectView(), {}); });

const call = (id, at, { events = ['e1'], sources = ['none'], newEvidence = 'none', action = 'wait', status = 'decided', tokens = 70000 } = {}) => ({ id, at, projectId: 'p', request: { events: events.map(eventId => ({ id: eventId })), project: { clock: { now: at } } }, call: { facts: { wakeSources: sources, newEvidence } }, outcome: status === 'decided' ? { status, action, usage: { totalTokens: tokens } } : { status } });
test('a case is a floor wake with the same evidence after a wait', () => {
  const { cases, skipped } = wakeCases([
    call('c0', '2026-10-20T01:00:00Z', { events: ['e0'], sources: ['scheduled run due'], newEvidence: 'few' }),   // the first call has nothing before it
    call('c1', '2026-10-20T01:30:00Z', { events: ['e0'] }),                                                       // floor, same evidence, after c0 (a wait): a case
    call('c2', '2026-10-20T02:00:00Z', { events: ['e0', 'e1'], sources: ['background result'], newEvidence: 'one' }), // a wake with a source
    call('c3', '2026-10-20T02:30:00Z', { events: ['e0', 'e1'], action: 'work' }),                                  // a case whose recorded action is work
    call('c4', '2026-10-20T03:00:00Z', { events: ['e0', 'e1'] }),                                                  // floor after a work decision: the light route does not apply
    call('c5', '2026-10-20T03:30:00Z', { events: ['e0', 'e1'], status: 'failed' }),                                // no action to compare with
    call('c6', '2026-10-20T04:00:00Z', { events: ['e0', 'e1', 'e2'] })]);                                          // floor but new evidence
  assert.deepEqual(cases.map(row => [row.id, row.reference, row.predecessor.id]), [['c1', 'wait', 'c0'], ['c3', 'work', 'c2']]);
  assert.deepEqual(skipped, { notFloor: 1, newEvidence: 1, notDecided: 1, afterAction: 1 });
  assert.equal(cases[0].recordedTokens, 70000);
});
const item = (id, reference) => ({ id, at: '2026-10-20T01:30:00Z', reference, recordedTokens: 72000, predecessor: { id: 'x', at: '2026-10-20T01:00:00Z', action: 'wait' },
  call: { request: { project: { title: 'P', clock: { now: '2026-10-20T01:30:00Z' }, mind: { agenda: [{ kind: 'todo', text: 'Write' }] } }, events: [{ id: 'e1', type: 'x', summary: 's', at: 1 }], recentActions: [], availableActions: ['work'], presence: {}, policy: {} } } });
test('the full arm reruns the recorded actions that were not waits and a spread of waits', () => {
  const cases = [item('a', 'wait'), item('b', 'work'), item('c', 'wait'), item('d', 'wait'), item('e', 'wait'), item('f', 'work'), item('g', 'wait')];
  const runs = plannedRuns(cases, { noiseWork: 3, noiseWait: 2, reps: 2 });
  assert.equal(runs.filter(run => run.arm === 'light').length, 7); assert.equal(runs.filter(run => run.arm === 'jev').length, 7);
  const full = runs.filter(run => run.arm === 'full');
  assert.deepEqual(full.filter(run => run.item.reference === 'work').map(runKey), ['full:b:0', 'full:b:1', 'full:f:0', 'full:f:1']);
  assert.equal(full.filter(run => run.item.reference === 'wait').length, 2);
  assert.equal(new Set(runs.map(runKey)).size, runs.length, 'every run has its own key (a resumed run skips the ones done)');
  assert.deepEqual(plannedRuns(cases, { arms: ['light'], limit: 3 }).map(runKey), ['light:a:0', 'light:b:0', 'light:c:0']);
});
test('a stored result and the run that made it have the same key, so a resumed run skips what is done', () => {
  const run = { arm: 'light@low', item: item('a', 'wait'), rep: 1 };
  assert.equal(runKey(run), 'light@low:a:1'); assert.equal(runKey({ arm: 'light@low', caseId: 'a', rep: 1, outcome: 'wait' }), runKey(run));
});
test('a run costs its digest plus the answer, a full rerun about its recorded cost; its ceiling covers the whole output allowance', () => {
  const light = runCost({ arm: 'light', item: item('a', 'wait'), rep: 0 }), full = runCost({ arm: 'full', item: item('a', 'wait'), rep: 0 }), jev = runCost({ arm: 'jev', item: item('a', 'wait'), rep: 0 });
  assert.ok(light.expected > 3000 && light.expected < 8000); assert.ok(light.ceiling > light.expected + 10000);
  assert.equal(full.expected, Math.ceil(72000 * 1.1)); assert.ok(full.ceiling > 32768);
  assert.deepEqual(jev, { expected: 0, ceiling: 0 });
});
test('the spend ledger records an approval, refuses a vague one and fails closed on a record it cannot read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wake-light-')), ledger = new SpendLedger(dir);
  try {
    assert.deepEqual(ledger.status(), { approved: 0, spent: 0, remaining: 0, approvals: 0 });
    assert.throws(() => ledger.approve(0, 'the user approved in chat'), /positive integer/); assert.throws(() => ledger.approve(1500000, 'ok'), /who approved/);
    assert.equal(ledger.approve(1500000, 'user, 2026-10-22: light wake replay, 1.5M tokens').remaining, 1500000);
    ledger.update('job-1', { spentTokens: 200000, inFlightTokens: 50000, phase: 'running' });
    assert.deepEqual(ledger.status(), { approved: 1500000, spent: 250000, remaining: 1250000, approvals: 1 });
    ledger.update('job-1', { spentTokens: 260000, inFlightTokens: 0, phase: 'completed' });
    assert.equal(ledger.status().remaining, 1240000);
    assert.equal(statSync(join(dir, 'spend.json')).mode & 0o777, 0o600);
    writeFileSync(join(dir, 'spend.json'), '{ not json');
    assert.equal(ledger.status().unreadable, true); assert.throws(() => ledger.approve(1, 'a second approval'), /unreadable/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('upper bounds and AUC', () => {
  assert.ok(Math.abs(upperBound(0, 3) - 0.708) < 0.01, 'none of three missed still allows 71%'); assert.ok(Math.abs(upperBound(0, 31) - 0.112) < 0.01); assert.equal(upperBound(3, 3), 1); assert.equal(upperBound(0, 0), null);
  assert.equal(auc([0.9, 0.8], [0.1, 0.2]), 1); assert.equal(auc([0.5], [0.5]), 0.5); assert.equal(auc([], [0.5]), null);
});
test('the summary counts caught and missed actions, over-asks, the saving per wake and the full arm against itself', () => {
  const cases = [item('a', 'wait'), item('b', 'wait'), item('c', 'work'), item('d', 'work')];
  const light = (caseId, outcome, tokens = 8000, failure) => ({ arm: 'light', caseId, rep: 0, outcome, tokens, ...(failure ? { failure } : {}) });
  const summary = summarize(cases, [light('a', 'wait'), light('b', 'reread', 9000), light('c', 'reread'), light('d', 'wait'),
    { arm: 'full', caseId: 'c', rep: 0, status: 'decided', action: 'work', tokens: 75000 }, { arm: 'full', caseId: 'c', rep: 1, status: 'decided', action: 'wait', tokens: 74000 },
    { arm: 'jev', caseId: 'a', rep: 0, probability: 0.2 }, { arm: 'jev', caseId: 'b', rep: 0, probability: 0.4 }, { arm: 'jev', caseId: 'c', rep: 0, probability: 0.9 }, { arm: 'jev', caseId: 'd', rep: 0, probability: 0.3 }]);
  assert.deepEqual(summary.reference, { waits: 2, acts: 2, actions: { wait: 2, work: 2 } });
  assert.deepEqual([summary.light.waitOnWait, summary.light.rereadOnWait, summary.light.rereadOnAct, summary.light.waitOnAct], [1, 1, 1, 1]);
  assert.deepEqual(summary.light.missedActions.map(row => row.caseId), ['d']); assert.ok(summary.light.missedUpperBound > 0.5);
  assert.equal(summary.light.rereadRate, 0.5);
  assert.equal(summary.perWake.fullMean, 72000); assert.equal(summary.perWake.lightMean, 8250); assert.equal(summary.perWake.expectedWithLight, 8250 + 36000); assert.equal(summary.perWake.saved, Math.round((1 - 44250 / 72000) * 1000) / 1000);
  assert.deepEqual(summary.full.byCase.c, { reference: 'work', reruns: ['work', 'wait'] }); assert.equal(summary.full.sameAsReference, 1);
  assert.equal(summary.jev.auc, 0.75); assert.equal(summary.jev.acts, 2);
});
test('a light run that could not be answered counts as a reread, never as a wait', () => {
  const cases = [item('a', 'work')], summary = summarize(cases, [{ arm: 'light', caseId: 'a', rep: 0, outcome: 'reread', failure: 'truncated', tokens: 5000 }]);
  assert.equal(summary.light.waitOnAct, 0); assert.equal(summary.light.rereadOnAct, 1); assert.equal(summary.light.notAnswered, 1); assert.deepEqual(summary.light.failures, { truncated: 1 });
});
