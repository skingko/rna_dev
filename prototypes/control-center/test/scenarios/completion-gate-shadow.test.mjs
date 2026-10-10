// D4 scenario (D2, plan §2.2: the option-B completion gate, SHADOW): a finished background run still sends the next review to
// the main model, as before; beside it the host works out whether that review would have been skipped and records the
// verdict, then compares it with what the review came to. Crosses the initiative's decision and work queue (a real run on the
// scenario workspace), the decision gate's bypass rule, the JEV completion template (fake JEV), the decision ledger, the wake
// log and C2's work-outcome view, and the report route.
// Before D2 every completion cost a paid decision and nothing recorded whether it had been needed. Now (mu notify-routing.ts:33-60:
// now | next_turn | drop; goal-met.ts:7-17: the closing message is never asked "is it done"):
//  - a run whose handoff says nothing is left would be skipped: recorded as a shadow `defer`, and the review still happens;
//  - a run whose handoff names a step to start now would be reviewed;
//  - the report sets each verdict beside what the review that followed it came to: a message a LATER review shares, citing the run
//    among its evidence, is that later review's, not what the run's own review did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { decide, decisionInput } from '../harness/faux-model.mjs';
import { ledgerRows } from '../../decision-ledger.mjs';
import { actionOutcome } from '../../work-outcome.mjs';

const completionRows = world => ledgerRows(world.store).filter(row => row.point === 'work.completion');
const bypasses = world => ledgerRows(world.store).filter(row => row.point === 'initiative.review' && row.reason === 'bypass_delivery_just_completed');
const reviews = world => world.faux.of('initiative').length;
const report = async world => (await world.get('/api/v2/decision-kernel/completion?window=7d')).body;
const WORK = (handoff, text = 'Checked notes.md.') => [{ toolCalls: [{ name: 'project_read', args: { path: 'notes.md' } }] }, `${text}\nHandoff: ${handoff}`];

test('a finished run is judged in shadow beside the review the host still makes; the report sets each verdict against what the review came to', async t => {
  const world = await createWorld(t, { initiative: true, files: { 'notes.md': '# Notes\n\nSee the harbour map.\n' } });
  const s = scenario(world);
  // The fake JEV reads what the host sent: the handoff in `run.handoff` decides its answers (the way a judge would read it).
  world.jev.answerAll((id, _question, body) => {
    const handoff = String(body.state?.run?.handoff ?? '');
    if (id === 'reports_untold') return /problem/i.test(handoff) ? .95 : .05;
    if (id === 'names_next_step') return /next step/i.test(handoff) ? .9 : .04;
    if (id === 'evidence_relevant') return .92;
    return undefined;
  });
  await s.advanceClock(1000, { settleMs: 1500, label: 'the initiative reviews the new project' });

  // Run A: nothing is left. The completion would be skipped; the review is made all the same.
  const beforeA = reviews(world);
  const runA = (await s.backgroundRun({ task: 'Check notes.md for dead links.', work: WORK('checked notes.md; no dead links found; nothing left.') })).outcome;
  assert.equal(runA.action.status, 'completed');
  const rowA = await until(() => completionRows(world).find(row => row.outcome?.actionId === runA.action.id), 'the completion of run A to be judged');
  assert.deepEqual([rowA.outcome.basis, rowA.outcome.route, rowA.outcome.reason, rowA.outcome.class], ['judge', 'defer', 'nothing_to_act_on', 'judge'], 'a shadow verdict: it would be skipped');
  assert.equal(rowA.outcome.real, 'delivery_just_completed', 'the real routing: straight to the main model, as before');
  assert.deepEqual(rowA.predictions, { reports_untold: .05, names_next_step: .04, evidence_relevant: .92 });
  assert.equal(rowA.mode, 'shadow'); assert.notEqual(rowA.applied, true);
  await until(() => reviews(world) >= beforeA + 2, 'the main model to review the completion all the same');
  assert.ok(bypasses(world).length >= 1, 'the rule row of the real routing is still written');
  // What the judge was asked: the handoff and what the user was told, and a template of exactly three literal questions.
  const asked = world.jev.asked('reports_untold');
  assert.equal(asked.length, 1, 'once for the run');
  assert.deepEqual(Object.keys(asked[0].questions), ['reports_untold', 'names_next_step', 'evidence_relevant']);
  assert.match(asked[0].state.run.handoff, /no dead links found; nothing left/);
  assert.deepEqual(Object.keys(asked[0].state).sort(), ['project', 'review', 'run']);

  // Run B: its handoff names a step to start now. The completion would be reviewed, with the reason.
  const beforeB = reviews(world);
  const runB = (await s.backgroundRun({ task: 'Draft CHANGELOG.md.', work: WORK('drafted the changelog; next step: run the suite now.', 'Checked notes.md for the changelog.') })).outcome;
  const rowB = await until(() => completionRows(world).find(row => row.outcome?.actionId === runB.action.id), 'the completion of run B to be judged');
  assert.deepEqual([rowB.outcome.basis, rowB.outcome.route, rowB.outcome.reason], ['judge', 'review', 'names_next_step']);
  await until(() => reviews(world) >= beforeB + 2, 'the main model to review run B\'s completion');

  // The comparison. The main model waited after each completion (the scenario's decisions): each review admitted nothing, which is
  // the model's own choice and listed apart. Run B was decided by a LATER wake that cited run A's completion as its evidence (the
  // newest event then); it is not what A's own review did, so A is not read as having started work.
  const compared = await until(async () => { const value = await report(world); return value.comparison?.defer?.waited >= 1 && value.comparison?.review?.waited >= 1 ? value : null; }, 'the report to see both reviews', 20000);
  assert.equal(compared.rows, 2); assert.equal(compared.mode, 'shadow');
  assert.deepEqual(compared.verdicts, { review: 1, defer: 1 });
  assert.deepEqual(compared.basis, { judge: 2 });
  assert.deepEqual(compared.attribution, { wake: 2 }, 'each verdict is read against the decision its wake row records');
  assert.deepEqual(compared.deferMissed, { n: 0, of: 1, rate: 0 }, 'a skip of run A would have lost nothing');
  assert.deepEqual([compared.reviewWasted.n, compared.reviewWasted.of, compared.reviewWasted.waited], [1, 1, 1], 'run B\'s review admitted nothing: the model\'s own choice, listed apart');
  const detail = compared.sample.find(row => row.actionId === runA.action.id);
  assert.deepEqual([detail.route, detail.label, detail.real, detail.attribution, detail.followUps], ['defer', 'waited', 'delivery_just_completed', 'wake', []], 'not the later work that cites it');
  assert.equal(compared.sample.find(row => row.actionId === runB.action.id).label, 'waited');
  assert.ok(compared.tokens.deferWouldHaveSkipped > 0, 'the review a skip would have spared, from its wake row');
  assert.equal(JSON.stringify(compared).includes('dead links'), false, 'ids, codes and probabilities only: no project text');
  assert.deepEqual((await world.get('/api/v2/decision-kernel/completion?window=forever')).body, { error: 'window must be 24h, 7d, 30d or all', code: 'window_invalid' });
  assert.equal((await world.get('/api/v2/decision-kernel/completion?projectId=nope')).body.rows, 0);
  // The ledger rows are the whole of it: no new sidecar.
  assert.deepEqual(world.unknownSidecars(), []);
});

test('no judge, no shadow: without a JEV key the completion is reviewed as before and nothing is recorded', async t => {
  const world = await createWorld(t, { initiative: true, jev: false, files: { 'notes.md': '# Notes\n' } });
  const s = scenario(world);
  await s.advanceClock(1000, { settleMs: 1500, label: 'the initiative reviews the new project' });
  const before = reviews(world);
  const run = (await s.backgroundRun({ task: 'Check notes.md.', work: WORK('checked notes.md; nothing left.') })).outcome;
  await until(() => reviews(world) >= before + 2, 'the main model to review the completion');
  assert.deepEqual(completionRows(world), []);
  assert.equal(run.action.status, 'completed');
  assert.deepEqual((await report(world)).rows, 0);
});

test('a scheduled occurrence is settled by a code fact: it would not be reviewed (the host delivers it), no judge is asked, and the review still happens', async t => {
  const world = await createWorld(t, { initiative: true, start: '2026-10-05T01:00:00.000Z', files: { 'evidence.txt': 'Measured result: seven verified sources.\n' } });
  const s = scenario(world);
  const created = await world.post(`/api/projects/${world.projectId}/schedules`, { requestId: 'daily-report', title: 'Daily report', task: 'Read evidence.txt and report the measured result.', destinationSessionId: world.sessionId, rule: { kind: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' } });
  assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 300));
  await s.advanceClock(1000, { settleMs: 1500, label: 'the initiative reviews the new schedule' });
  world.faux.script('background-work',
    { toolCalls: [{ name: 'project_read', args: { path: 'evidence.txt' } }] },
    'The measured result is seven verified sources.\nHandoff: reported the measured result from evidence.txt; nothing left.');
  const delivered = () => world.project().scheduleRuntime?.occurrences?.find(row => row.status === 'delivered');
  const before = reviews(world);
  await s.advanceClock(70 * 60000, { label: 'the schedule comes due', until: delivered });
  const action = world.project().initiativeRuntime.sdkState.actions.find(row => row.hostSchedule && row.action === 'work');
  assert.ok(action, 'the occurrence ran as a host-scheduled work action');
  const row = await until(() => completionRows(world).find(item => item.outcome?.actionId === action.id), 'the completion of the occurrence to be recorded');
  assert.deepEqual([row.outcome.basis, row.outcome.class, row.outcome.route, row.outcome.reason, row.source], ['code_fact', 'schedule_occurrence', 'defer', 'completion_schedule_occurrence', 'rule']);
  assert.deepEqual(world.jev.asked('reports_untold'), [], 'a code fact is not asked of the judge');
  // The real routing did not change: the completion still reaches the main model by rule, as before.
  await until(() => bypasses(world).length >= 1 && reviews(world) > before, 'the main model to review the completion all the same');
});

test('a message a later review shares, citing a finished run, is not what that run\'s own review did: the run it would have skipped is not a missed skip', async t => {
  const MINUTE = 60000;
  const world = await createWorld(t, { initiative: true, files: { 'notes.md': '# Notes\n\nSee the harbour map.\n' } });
  const s = scenario(world);
  world.jev.answer('needs_main_model', .95).answer('evidence_relevant', .9).answer('already_reported', .05).answer('new_information', .9).answer('relevant_now', .9).answer('continues_open_thread_or_commitment', .6).answer('time_sensitive', .1)
    .answerAll((id, _question, _body) => id === 'reports_untold' ? .05 : id === 'names_next_step' ? .04 : undefined);
  await s.advanceClock(1000, { settleMs: 1500, label: 'the initiative reviews the new project' });
  const run = (await s.backgroundRun({ task: 'Check notes.md for dead links.', work: WORK('checked notes.md; no dead links found; nothing left.') })).outcome;
  const id = run.action.id;
  const row = await until(() => completionRows(world).find(item => item.outcome?.actionId === id), 'the completion to be judged');
  assert.deepEqual([row.outcome.route, row.outcome.reason], ['defer', 'nothing_to_act_on'], 'it would be skipped');
  await until(() => reviews(world) >= 2, 'the review of the completion (the model waits)');
  // Hours later a different review shares a message, with the finished run among its evidence (the newest event it read).
  let share = true;
  world.faux.on('initiative', request => {
    const input = decisionInput(request);
    if (!share) return decide(input, 'wait', '', { reason: 'Nothing new.', nextReviewAfterMs: 30 * MINUTE });
    share = false;
    return decide(input, 'share', 'The notes file has no dead links; the harbour map is intact.', { reason: 'A concrete result.', evidenceIds: [`action:${id}:completed`], nextReviewAfterMs: 30 * MINUTE });
  });
  await world.post(`/api/projects/${world.projectId}/presence`, { sessionId: world.sessionId, visible: true, typing: false });
  await world.idle(3 * 60 * MINUTE, { stepMs: 30 * MINUTE, settleMs: 150 });
  const message = world.session().items.find(item => item.source === 'initiative' && (item.evidenceIds ?? []).includes(`action:${id}:completed`));
  assert.ok(message, 'the later review told the user, citing the run');
  const view = actionOutcome(world.project(), id, Date.now(), { sessions: world.store.state.sessions.filter(item => item.projectId === world.projectId), state: world.store.state });
  assert.deepEqual([view.outcome, view.reason, view.via], ['visible', 'cited_by_delivery', 'cited'], 'the work-outcome view calls the run delivered: a message that cites it reached the user');
  // The report does not: that message came from a review that began after the run's own review.
  const compared = (await report(world));
  assert.deepEqual(compared.comparison.defer, { productive: 0, unproductive: 0, waited: 1, pending: 0, unreviewed: 0 });
  assert.deepEqual(compared.deferMissed, { n: 0, of: 1, rate: 0 }, 'a skip of the run would have lost nothing it had to say');
  const detail = compared.sample.find(item => item.actionId === id);
  assert.deepEqual([detail.label, detail.attribution, detail.followUps, detail.run.reason], ['waited', 'wake', [], 'cited_by_delivery']);
  assert.equal(compared.questions.reports_untold.told.n, 0, 'nor is it a label for "untold": the model waited');
});
