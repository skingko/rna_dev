// D4 scenario (C2, plan §2.2): what became of the actions the background decided, across the whole host. Crosses the
// initiative's decision and SDK action queue, the narrator's pacing (presence, away), the project mind's threads (a held
// message), the inbox and the daily digest, background worktrees (a run's change set, the user's revert), the JEV gate and
// its decision ledger (the wake judgment's label), the wake log and the work-outcome log (both sidecars inside `<state>.rna`).
// Before C2 the ladder reset when the host ADMITTED a decision, a held message was never credited to the action that held it
// (a welcome-back is its own receipt), and the gate's calibration labels came from the model's own next choice. Now
// (Headlong monolith/step:357-373, 582-586; mu decision.ts:25-31; the plan's PDL-7):
//  - an admitted decision is pending: the ladder stays where it was until a VISIBLE outcome, which resets it;
//  - a welcome-back or a digest that carries a held message is credited to the ORIGINAL action, once, and is no action of its own;
//  - a late revert finds its row after the SDK has forgotten the action, and relabels the wake the action came from;
//  - a restart replays the outcomes and emits nothing twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorld, until, gitReady } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { decide, decisionInput } from '../harness/faux-model.mjs';
import { WorkOutcomeLog, outcomeLogFile, actionOutcome } from '../../work-outcome.mjs';
import { wakeLogFile, readWakeLog } from '../../wake-log.mjs';
import { windowRange } from '../../metric-windows.mjs';

const MINUTE = 60000, HOUR = 60 * MINUTE;
const actions = world => world.project().initiativeRuntime?.sdkState?.actions ?? [];
const wake = world => world.project().mind?.pacing?.wake ?? {};
const outcomes = (world, actionId) => world.store.outcomeLog.rows().filter(row => row.actionId === actionId).map(row => [row.from, row.to]);
const wakeRows = world => readWakeLog(wakeLogFile(world.stateFile))[world.projectId] ?? [];
/** What the view derives for an action now, from the world's records (the log keeps only its transitions). */
const derived = (world, id) => actionOutcome(world.project(), id, Date.now(), { sessions: world.store.state.sessions.filter(row => row.projectId === world.projectId), state: world.store.state });
const setLadder = (world, values) => world.store.mutate(state => { const project = state.projects.find(row => row.id === world.projectId); project.mind ??= {}; project.mind.pacing ??= {}; project.mind.pacing.wake = { ...project.mind.pacing.wake, ...values }; });

test('a share held while the user is away is pending, and its welcome-back credits the original action once: the ladder resets there, not when it was admitted', async t => {
  const world = await createWorld(t, { initiative: true, files: { 'chapter3.md': '# Chapter three\n\nThe harbour at dawn.\n' } });
  const s = scenario(world);
  world.jev.answer('needs_main_model', .95).answer('evidence_relevant', .9).answer('already_reported', .05)
    .answer('new_information', .9).answer('relevant_now', .9).answer('continues_open_thread_or_commitment', .6).answer('time_sensitive', .1);
  let next = 'wait';
  world.faux.on('initiative', request => {
    const input = decisionInput(request);
    if (next !== 'share') return decide(input, 'wait', '', { reason: 'Nothing new needs the user yet.', nextReviewAfterMs: 30 * MINUTE });
    next = 'wait';
    return decide(input, 'share', 'The map link in chapter three is broken; the harbour scene needs another one.', { reason: 'A concrete broken link in chapter three.', nextReviewAfterMs: 30 * MINUTE });
  });
  await s.advanceClock(1000, { settleMs: 1500, label: 'the initiative reviews the new project' });
  await s.send('Draft chapter three tonight.', { reply: 'Started on chapter three.' });
  // The user leaves for an hour (away); the ladder rests deep.
  await world.idle(60 * MINUTE, { stepMs: 10 * MINUTE, settleMs: 120 });
  setLadder(world, { level: 3, ticksAtLevel: 1, quietWakes: 4 });
  next = 'share';
  // The review the last decision set (30 minutes) falls due and decides.
  await world.idle(40 * MINUTE, { stepMs: 10 * MINUTE, settleMs: 150 });
  const action = await until(() => actions(world).find(row => row.action === 'share'), 'the share was decided');
  const thread = () => world.project().mind.threads.find(row => (row.held ?? []).some(held => held.actionId === action.id));
  await until(() => thread(), 'the narrator held it for the user\'s return');

  // Admitted, decided, ran: and not delivered. Pending, its row in the wake log names it; the ladder did not reset.
  assert.equal(world.session().items.some(item => item.initiativeActionId === action.id), false, 'not in the conversation');
  await world.idle(10 * MINUTE, { stepMs: 5 * MINUTE, settleMs: 200 });
  assert.deepEqual(outcomes(world, action.id), [[null, 'pending']]);
  assert.deepEqual([derived(world, action.id).outcome, derived(world, action.id).reason], ['pending', 'held'], 'admitted, ran, held in its thread: not delivered');
  assert.equal(wakeRows(world).find(row => row.actionId === action.id)?.pending, true, 'its wake row, in the sidecar');
  assert.equal(wake(world).lastVisibleAt, undefined, 'nothing visible happened');
  assert.ok(wake(world).level >= 3, `the ladder was not reset by the admission (level ${wake(world).level})`);

  // The user is back: one welcome-back message carries the held row.
  const back = await s.step('the user is back', async () => {
    const saved = await world.post(`/api/projects/${world.projectId}/presence`, { sessionId: world.sessionId, visible: true, typing: false });
    assert.equal(saved.status, 200);
    world.tick();
    return until(() => world.session().items.find(item => item.initiative?.kind === 'welcome_back'), 'the welcome-back message');
  });
  const welcome = back.outcome;
  assert.deepEqual(welcome.initiative.actionIds, [action.id], 'the message says whose held row it carries');
  await world.idle(10 * MINUTE, { stepMs: 5 * MINUTE, settleMs: 200 });
  await until(() => world.store.outcomeLog.last(action.id)?.to === 'visible', 'the delivery was credited to the original action');
  // Credited once, at the welcome-back; no action of the receipt's own.
  assert.deepEqual(outcomes(world, action.id), [[null, 'pending'], ['pending', 'visible']]);
  assert.equal(world.store.outcomeLog.last(action.id).reason, 'welcome_back');
  assert.equal(world.store.outcomeLog.last(action.id).at, Date.parse(welcome.createdAt));
  assert.deepEqual(world.store.outcomeLog.rows().filter(row => /^welcome-back:/.test(row.actionId)), [], 'the welcome-back receipt is not an action');
  const receipt = world.project().inbox.find(row => /^welcome-back:/.test(row.actionId));
  assert.deepEqual(receipt.creditedActionIds, [action.id]);
  const counts = world.store.outcomeLog.cells(world.projectId, windowRange({ days: 7 }, { now: Date.now() })).filter(cell => cell.key.kind === 'share').reduce((sum, cell) => ({ ...sum, [cell.key.to]: (sum[cell.key.to] ?? 0) + cell.values.n }), {});
  assert.deepEqual(counts, { pending: 1, visible: 1 }, 'one admission, one delivery: no double count');
  // The ladder moved when the outcome did.
  await until(() => wake(world).lastVisibleActionId === action.id, 'the visible outcome reset the ladder');
  assert.ok(Date.parse(wake(world).lastVisibleAt) >= Date.parse(welcome.createdAt) - MINUTE);
  assert.deepEqual(world.unknownSidecars(), [], 'no new top-level sidecar');
  assert.ok(world.sidecarEntries('.rna').includes('metrics'));
});

test('a digest-tier share is pending until the digest carries it, then credited to its own action, once', async t => {
  const world = await createWorld(t, { initiative: true, files: { 'notes.md': '# Notes\n' } });
  const s = scenario(world);
  world.jev.answer('needs_main_model', .95).answer('evidence_relevant', .9).answer('already_reported', .05);
  let next = 'wait';
  world.faux.on('initiative', request => {
    const input = decisionInput(request);
    if (next !== 'share') return decide(input, 'wait', '', { reason: 'Nothing new.', nextReviewAfterMs: 30 * MINUTE });
    next = 'wait';
    return decide(input, 'share', 'The notes file has no entry for the second interview yet.', { reason: 'A gap in the notes.', nextReviewAfterMs: 30 * MINUTE, fields: { urgency: 'digest' } });
  });
  await s.advanceClock(1000, { settleMs: 1500, label: 'the initiative reviews the new project' });
  next = 'share';
  await world.idle(40 * MINUTE, { stepMs: 10 * MINUTE, settleMs: 150 });
  const action = await until(() => actions(world).find(row => row.action === 'share' && row.status === 'completed'), 'the share was decided and filed', 20000);
  await world.idle(MINUTE, { stepMs: MINUTE, settleMs: 200 });
  const entry = () => world.project().inbox.find(row => row.actionId === action.id);
  assert.equal(entry().tier, 'digest', 'filed for the daily digest'); assert.equal(entry().heldForDigest, true);
  assert.deepEqual(outcomes(world, action.id), [[null, 'pending']]);
  assert.deepEqual([derived(world, action.id).outcome, derived(world, action.id).reason], ['pending', 'digest_pending']);
  // A day later the digest is composed, and carries the entry.
  await world.post(`/api/projects/${world.projectId}/presence`, { sessionId: world.sessionId, visible: true, typing: false });
  await world.idle(26 * HOUR, { stepMs: HOUR, settleMs: 120 });
  await until(() => world.session().items.find(item => item.initiative?.kind === 'digest'), 'the digest message', 20000);
  const digest = world.session().items.find(item => item.initiative?.kind === 'digest');
  await until(() => world.store.outcomeLog.last(action.id)?.to === 'visible', 'the digest was credited to the original action');
  assert.deepEqual(outcomes(world, action.id), [[null, 'pending'], ['pending', 'visible']]);
  assert.equal(world.store.outcomeLog.last(action.id).reason, 'digest'); assert.equal(world.store.outcomeLog.last(action.id).at, Date.parse(entry().digestedAt));
  assert.deepEqual(digest.initiative.entryIds, [entry().id]);
  assert.deepEqual(world.store.outcomeLog.rows().filter(row => row.to === 'visible' && row.kind === 'share').map(row => row.actionId), [action.id], 'the digest message is no action: one visible outcome');
});

test('a late revert finds its row after the SDK forgot the action; the wake it came from is relabelled; a restart replays nothing', { skip: gitReady ? false : 'git 2.38 or later is needed' }, async t => {
  const world = await createWorld(t, { initiative: true, files: { 'notes.md': 'one\ntwo\nthree\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  world.jev.answer('needs_main_model', .95).answer('evidence_relevant', .9).answer('already_reported', .05);
  await s.send('Keep the notes file tidy.', { reply: 'I will keep notes.md tidy.' });
  const run = await s.backgroundRun({ task: 'Tidy notes.md: mark the second line as tidied.', work: [
    { toolCalls: [{ name: 'project_read', args: { path: 'notes.md' } }] },
    { toolCalls: [{ name: 'project_write', args: { path: 'notes.md', content: 'one\ntwo (tidied)\nthree\n' } }] },
    'Tidied notes.md.\nHandoff: changed the second line of notes.md; nothing left to do.',
  ] });
  const action = run.outcome.action, changeId = run.outcome.change?.id;
  assert.ok(changeId, 'the run left a change set');
  await world.idle(10 * 1000, { stepMs: 5000, settleMs: 300 });
  await until(() => world.store.outcomeLog.last(action.id)?.to === 'visible', 'the kept change set is visible');
  const row = wakeRows(world).find(entry => entry.actionId === action.id);
  assert.ok(row?.gate?.ledgerId, 'the wake row names the judgment it came from');
  await until(() => world.store.decisionLedger.get(row.gate.ledgerId)?.label?.value === 'wake_needed_work', 'the outcome labelled the wake needed');
  assert.equal(world.store.decisionLedger.get(row.gate.ledgerId).label.source, 'outcome', 'by the outcome, not by the model\'s own next choice');
  assert.equal(wake(world).lastVisibleActionId, action.id, 'and the ladder reset there');

  // The SDK's history compaction (maxHistory) archives the action out of the coordinator's list.
  const context = world.app.projectInitiative.contexts.get(world.projectId);
  context.coordinator.state.actions = context.coordinator.state.actions.filter(entry => entry.id !== action.id);
  await context.coordinator._persist();
  assert.equal(actions(world).some(entry => entry.id === action.id), false, 'the SDK no longer holds the action');
  world.store.mutate(state => { const project = state.projects.find(item => item.id === world.projectId); project.jobs = project.jobs.filter(job => job.id !== action.id); });
  await world.idle(2 * HOUR, { stepMs: 30 * MINUTE, settleMs: 100 });
  assert.deepEqual(outcomes(world, action.id), [[null, 'pending'], ['pending', 'visible']].slice(-(outcomes(world, action.id).length)), 'nothing new while it stands');

  // Hours later the user reverts the change set. The view finds it through the change set row and the log.
  await s.revert({ change: changeId });
  await world.idle(10 * 1000, { stepMs: 5000, settleMs: 300 });
  await until(() => world.store.outcomeLog.last(action.id)?.to === 'undone', 'the late revert was found');
  assert.deepEqual(outcomes(world, action.id).at(-1), ['visible', 'undone']);
  assert.equal(world.store.outcomeLog.last(action.id).reason, 'change_undone');
  // The wake it came from is relabelled: the work was not needed after all. The old observation is dropped, the new read.
  await until(() => world.store.decisionLedger.get(row.gate.ledgerId).label.value === 'wake_unneeded', 'the revert relabelled the wake');
  assert.equal(world.store.decisionLedger.get(row.gate.ledgerId).label.source, 'outcome');

  // A restart: the records say what they said; nothing is emitted, nothing written.
  const file = outcomeLogFile(world.stateFile), again = new WorkOutcomeLog({ file, now: () => Date.now() });
  const sessions = world.store.state.sessions.filter(item => item.projectId === world.projectId);
  assert.deepEqual(again.reconcile(world.project(), sessions, { now: Date.now(), state: world.store.state }).transitions, [], 'the replay emits no duplicate');
  assert.equal(again.last(action.id).to, 'undone');
});

test('review: the user reverts a kept change set and then undoes the rollback: the action is visible again once, and the ladder is not driven by a transition re-emitted every pass', { skip: gitReady ? false : 'git 2.38 or later is needed' }, async t => {
  const world = await createWorld(t, { initiative: true, files: { 'notes.md': 'one\ntwo\nthree\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  world.jev.answer('needs_main_model', .95).answer('evidence_relevant', .9).answer('already_reported', .05);
  await s.send('Keep the notes file tidy.', { reply: 'I will keep notes.md tidy.' });
  const run = await s.backgroundRun({ task: 'Tidy notes.md: mark the second line as tidied.', work: [
    { toolCalls: [{ name: 'project_read', args: { path: 'notes.md' } }] },
    { toolCalls: [{ name: 'project_write', args: { path: 'notes.md', content: 'one\ntwo (tidied)\nthree\n' } }] },
    'Tidied notes.md.\nHandoff: changed the second line of notes.md; nothing left to do.',
  ] });
  const action = run.outcome.action, changeId = run.outcome.change?.id, change = () => world.project().backgroundChanges.find(row => row.id === changeId);
  assert.ok(changeId, 'the run left a change set');
  await world.idle(10 * 1000, { stepMs: 5000, settleMs: 300 });
  await until(() => world.store.outcomeLog.last(action.id)?.to === 'visible', 'the kept change set is visible');

  // The user rolls the change set back: undone.
  await s.revert({ change: changeId });
  await world.idle(10 * 1000, { stepMs: 5000, settleMs: 300 });
  await until(() => world.store.outcomeLog.last(action.id)?.to === 'undone', 'the revert was found');
  assert.equal(change().status, 'reverted');
  // Then undoes the rollback in the apply history (the rollback's own record is rolled back, two steps).
  const rollback = world.project().git.applies.findLast(row => row.kind === 'rollback' && row.initiator === 'user');
  assert.ok(rollback, 'the revert wrote a rollback record');
  const path = `/api/v2/projects/${world.projectId}/applies/${rollback.id}/rollback`;
  let response = await world.post(path, {}); assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 300));
  if (typeof response.body?.confirm === 'string') { response = await world.post(path, { confirm: response.body.confirm }); assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 300)); }
  await world.idle(10 * 1000, { stepMs: 5000, settleMs: 300 });
  await until(() => change().status === 'kept', 'the change set row follows its apply records: kept again');
  await until(() => world.store.outcomeLog.last(action.id)?.to === 'visible' && outcomes(world, action.id).length >= 3, 'visible again');
  assert.deepEqual(outcomes(world, action.id).slice(-2), [['visible', 'undone'], ['undone', 'visible']]);

  // It stays: minutes of upkeep passes (one every few seconds) emit nothing more, and write nothing.
  const rows = world.store.outcomeLog.rows().length, size = readFileSync(outcomeLogFile(world.stateFile), 'utf8').length;
  await world.idle(3 * MINUTE, { stepMs: 5000, settleMs: 60 });
  assert.equal(world.store.outcomeLog.rows().length, rows, 'no transition is re-emitted');
  assert.equal(readFileSync(outcomeLogFile(world.stateFile), 'utf8').length, size);
  assert.deepEqual(outcomes(world, action.id).filter(row => row[1] === 'visible').length, 2, 'visible twice in all: first kept, then restored');
  // A restart agrees.
  const again = new WorkOutcomeLog({ file: outcomeLogFile(world.stateFile), now: () => Date.now() }), sessions = world.store.state.sessions.filter(item => item.projectId === world.projectId);
  assert.deepEqual(again.reconcile(world.project(), sessions, { now: Date.now(), state: world.store.state }).transitions, []);
  assert.equal(again.last(action.id).to, 'visible');
});
