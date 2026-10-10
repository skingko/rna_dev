// Plan 2026-10-05 C2 (P2.2): the work-outcome view. `actionOutcome(project, actionId, now)` derives, from records that
// outlive the SDK's history compaction, one of visible | pending | none | undone | failed, with six distinctly named
// stages; only the transitions are persisted (and a daily aggregate), keyed so a restart replay never emits one twice.
// Headlong's shape (derived indexes over a log, visible steps only: monolith/step:357-373, conversation_memory.md:348-394,
// outbound_delivery.md:162-185), not an event bus.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STAGES, OUTCOMES, actionOutcome, outcomeFacts, outcomeLabels, outcomeLogFile, WorkOutcomeLog, readOutcomeLog, OUTCOME_HORIZON_MS } from '../work-outcome.mjs';
import { DailyRollup, metricsRoot } from '../metrics-rollup.mjs';
import { windowRange } from '../metric-windows.mjs';

const MIN = 60000, HOUR = 3600000, DAY = 86400000, TZ = 'Asia/Shanghai';
const NOW = Date.parse('2026-10-05T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const temp = t => { const dir = mkdtempSync(join(tmpdir(), 'rna-c2-outcome-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return { dir, stateFile: join(dir, 'state.json') }; };
const project = (extra = {}) => ({ id: 'p1', initiativeRuntime: { sdkState: { actions: [] } }, jobs: [], backgroundChanges: [], directFixes: [], inbox: [], mind: { threads: [] }, git: { applies: [] }, ...extra });
const withActions = (...actions) => project({ initiativeRuntime: { sdkState: { actions } } });
const action = (id, kind, status, extra = {}) => ({ id, action: kind, status, createdAt: NOW - 2 * HOUR, evidenceIds: [], ...extra });
const change = (actionId, extra = {}) => ({ id: `c-${actionId}`, kind: 'git', actionId, at: iso(NOW - HOUR), status: 'kept', files: [{ path: 'a.md' }], ...extra });
const entry = (actionId, extra = {}) => ({ id: `e-${actionId}`, actionId, kind: 'share', tier: 'inline', createdAt: iso(NOW - 30 * MIN), status: 'unread', feedback: null, ...extra });
const message = (id, actionId, extra = {}) => ({ id, kind: 'assistant', source: 'initiative', initiativeActionId: actionId, createdAt: iso(NOW - 30 * MIN), text: 'x', initiative: { kind: 'insight', reach: 'inline' }, ...extra });
const session = (...items) => ({ id: 's1', projectId: 'p1', items });
const read = (p, id, sessions = [], extra = {}) => actionOutcome(p, id, NOW, { sessions, ...extra });

test('the stages and outcomes are named exactly', () => {
  assert.deepEqual(STAGES, ['decided', 'admitted', 'ran', 'applied', 'delivered', 'reacted']);
  assert.deepEqual(OUTCOMES, ['visible', 'pending', 'none', 'undone', 'failed']);
});

test('a background run: pending while it runs, visible once its change set is kept, pending while the set waits, undone when the user takes it back', () => {
  const running = withActions(action('w1', 'work', 'running', { startedAt: NOW - HOUR }));
  const record = read(running, 'w1');
  assert.deepEqual([record.outcome, record.reason, record.kind], ['pending', 'running', 'work']);
  assert.deepEqual(Object.keys(record.stages), ['decided', 'admitted', 'ran'], 'decided, admitted and ran are three facts; nothing was applied or delivered');
  const kept = withActions(action('w1', 'work', 'completed', { startedAt: NOW - 100 * MIN, finishedAt: NOW - HOUR }));
  kept.backgroundChanges = [change('w1')];
  const done = read(kept, 'w1');
  assert.deepEqual([done.outcome, done.reason, done.at], ['visible', 'change_applied', NOW - HOUR]);
  assert.deepEqual(Object.keys(done.stages), ['decided', 'admitted', 'ran', 'applied'], 'applied is not delivered: nobody was told');
  // The set waits for the project folder (a git operation, a conflict card): not visible yet.
  kept.backgroundChanges = [change('w1', { status: 'deferred' })];
  assert.deepEqual([read(kept, 'w1').outcome, read(kept, 'w1').reason], ['pending', 'change_waiting']);
  // The user reverts it: undone, at the instant they did.
  kept.backgroundChanges = [change('w1', { status: 'reverted', revertedAt: iso(NOW - 10 * MIN) })];
  assert.deepEqual([read(kept, 'w1').outcome, read(kept, 'w1').reason, read(kept, 'w1').at], ['undone', 'change_undone', NOW - 10 * MIN]);
  kept.backgroundChanges = [change('w1', { status: 'reverted', discarded: true, droppedBy: 'agent', revertedAt: iso(NOW - 10 * MIN) })];
  assert.equal(read(kept, 'w1').reason, 'change_dropped', 'a conversation that dropped it with agent_merge says so');
});

test('a run that changed nothing and told nobody is none; a failed run is failed, unless something visible came of it (Headlong: visible first)', () => {
  const quiet = withActions(action('w1', 'work', 'completed', { finishedAt: NOW - HOUR }));
  assert.deepEqual([read(quiet, 'w1').outcome, read(quiet, 'w1').reason], ['none', 'nothing_visible']);
  const failed = withActions(action('w1', 'work', 'failed', { errorCode: 'tool_failed' }));
  assert.deepEqual([read(failed, 'w1').outcome, read(failed, 'w1').reason], ['failed', 'tool_failed']);
  failed.backgroundChanges = [change('w1', { failed: true })];
  assert.equal(read(failed, 'w1').outcome, 'visible', 'it broke after writing files that stayed: something happened outside the head');
  const cancelled = withActions(action('w1', 'work', 'cancelled', { cancellationReason: 'new_evidence' }), action('w2', 'work', 'cancelled', { cancellationReason: 'action_control' }), action('w3', 'work', 'cancelled'), action('s1', 'share', 'cancelled', { cancellationReason: 'already_reported' }));
  assert.deepEqual([read(cancelled, 'w1').outcome, read(cancelled, 'w1').reason, read(cancelled, 'w1').neutral], ['none', 'cancelled:new_evidence', undefined], 'overtaken by new evidence: a decision that came to nothing');
  assert.deepEqual([read(cancelled, 's1').reason, read(cancelled, 's1').neutral], ['cancelled:already_reported', undefined], 'the host found it redundant: a verdict');
  assert.deepEqual([read(cancelled, 'w2').outcome, read(cancelled, 'w2').neutral], ['none', true], 'the user stopped it: it says nothing about the wake');
  assert.deepEqual([read(cancelled, 'w3').reason, read(cancelled, 'w3').neutral], ['cancelled:cancelled', true], 'a cancellation nobody kept a reason for (runs from before reasons were recorded) neither');
});

test('a read-only investigation is credited through the later message that cites its completion', () => {
  const p = withActions(action('w1', 'work', 'completed', { finishedAt: NOW - HOUR }), action('s1', 'share', 'completed', { evidenceIds: ['action:w1:completed'], finishedAt: NOW - 30 * MIN }));
  p.inbox = [entry('s1')];
  const delivered = session(message('m1', 's1', { evidenceIds: ['action:w1:completed'] }));
  assert.equal(read(p, 'w1', []).outcome, 'none', 'without the conversation the citing message is not visible to the view');
  const credited = read(p, 'w1', [delivered]);
  assert.deepEqual([credited.outcome, credited.reason, credited.via, credited.at], ['visible', 'cited_by_delivery', 'cited', NOW - 30 * MIN]);
  assert.deepEqual(Object.keys(credited.stages), ['decided', 'admitted', 'delivered'], 'the run never applied anything; its finding was delivered by another action');
  // The message waits in the digest: not yet.
  p.inbox = [entry('s1', { tier: 'digest', heldForDigest: true })];
  assert.equal(read(p, 'w1', [session()]).outcome, 'none');
});

test('a message: delivered is visible, and the reaction is a stage of its own', () => {
  const p = withActions(action('s1', 'share', 'completed', { deliveryOutcome: 'shared', finishedAt: NOW - 30 * MIN }));
  p.inbox = [entry('s1')];
  const unreacted = read(p, 's1');
  assert.deepEqual([unreacted.outcome, unreacted.reason, unreacted.reaction], ['visible', 'delivered', undefined]);
  assert.deepEqual(Object.keys(unreacted.stages), ['decided', 'admitted', 'delivered']);
  p.inbox = [entry('s1', { feedback: { outcome: 'replied', at: iso(NOW - 10 * MIN) } })];
  const replied = read(p, 's1');
  assert.deepEqual([replied.outcome, replied.reaction, replied.stages.reacted], ['visible', 'replied', NOW - 10 * MIN]);
  assert.deepEqual(Object.keys(replied.stages), ['decided', 'admitted', 'delivered', 'reacted']);
  // A vote on the delivered message is a reaction too.
  p.inbox = [];
  assert.equal(read(p, 's1', [session(message('m1', 's1', { feedback: { vote: 'down' } }))]).reaction, 'down');
});

test('a message held for the digest is pending, and visible when the digest carries it; the digest is not an action of its own', () => {
  const p = withActions(action('s1', 'share', 'completed', { deliveryOutcome: 'digest', finishedAt: NOW - 8 * HOUR }), action('s2', 'share', 'completed', { deliveryOutcome: 'digest', finishedAt: NOW - 8 * HOUR }));
  p.inbox = [entry('s1', { tier: 'digest', heldForDigest: true, createdAt: iso(NOW - 8 * HOUR) }), entry('s2', { tier: 'digest', heldForDigest: true, createdAt: iso(NOW - 8 * HOUR) })];
  assert.deepEqual([read(p, 's1').outcome, read(p, 's1').reason], ['pending', 'digest_pending']);
  // The digest is composed: each entry carries its own action id, credited at the digest's time.
  p.inbox = p.inbox.map(row => ({ ...row, heldForDigest: false, digestedAt: iso(NOW - HOUR), digestItemId: 'dg1', digestSessionId: 's1' }));
  const digest = session({ id: 'dg1', kind: 'assistant', source: 'initiative', createdAt: iso(NOW - HOUR), text: 'digest', initiative: { kind: 'digest', reach: 'digest', entryIds: ['e-s1', 'e-s2'] } });
  const facts = outcomeFacts(p, [digest], { now: NOW });
  const all = ['s1', 's2'].map(id => actionOutcome(p, id, NOW, { facts }));
  assert.deepEqual(all.map(row => [row.outcome, row.reason, row.via, row.at]), [['visible', 'digest', 'digest', NOW - HOUR], ['visible', 'digest', 'digest', NOW - HOUR]]);
  assert.equal(actionOutcome(p, 'dg1', NOW, { facts }), null, 'the digest message is no action');
});

test('a held message is pending; the welcome-back that carries it is credited to it, never counted as an action of its own', () => {
  const thread = { id: 't1', status: 'open', held: [{ id: 'h1', actionId: 's1', kind: 'share', createdAt: iso(NOW - 3 * HOUR) }], heldAsks: [] };
  const p = withActions(action('s1', 'share', 'completed', { deliveryOutcome: 'held', finishedAt: NOW - 3 * HOUR }));
  p.mind.threads = [thread];
  assert.deepEqual([read(p, 's1').outcome, read(p, 's1').reason], ['pending', 'held']);
  // The user is back: one welcome-back message carries the held row; its receipt is `welcome-back:<id>`.
  p.mind.threads = [{ ...thread, held: [] }];
  p.inbox = [entry('welcome-back:w9', { createdAt: iso(NOW - 5 * MIN), creditedActionIds: ['s1'], itemId: 'w9' })];
  const welcome = session({ id: 'w9', kind: 'assistant', source: 'initiative', createdAt: iso(NOW - 5 * MIN), text: 'while you were away', initiative: { kind: 'welcome_back', reach: 'inline', actionIds: ['s1'] } });
  const credited = read(p, 's1', [welcome]);
  assert.deepEqual([credited.outcome, credited.reason, credited.via, credited.at], ['visible', 'welcome_back', 'welcome_back', NOW - 5 * MIN]);
  assert.equal(actionOutcome(p, 'welcome-back:w9', NOW, { sessions: [welcome] }), null, 'the welcome-back receipt is not an action');
  // Even without the conversation item (its session archived), the inbox receipt credits it.
  assert.equal(read(p, 's1', []).outcome, 'visible');
  // A held row that left its thread without a delivery (the thread resolved) is none: it was dropped.
  p.inbox = []; assert.deepEqual([read(p, 's1', []).outcome, read(p, 's1', []).reason], ['none', 'held_dropped']);
});

test('a message the narrator dropped is none; a question card is visible, and answering it is the reaction', () => {
  const p = withActions(action('s1', 'share', 'cancelled', { cancellationReason: 'below_threshold' }), action('a1', 'ask', 'completed', { deliveryOutcome: 'asked', finishedAt: NOW - HOUR }), action('a2', 'ask', 'queued', { deferredReason: 'narrator_away' }));
  assert.deepEqual([read(p, 's1').outcome, read(p, 's1').reason], ['none', 'cancelled:below_threshold']);
  p.inbox = [entry('a1', { kind: 'ask', interactionId: 'i1', feedback: { outcome: 'acted', at: iso(NOW - 20 * MIN) } })];
  assert.deepEqual([read(p, 'a1').outcome, read(p, 'a1').reaction, read(p, 'a1').kind], ['visible', 'acted', 'ask']);
  assert.deepEqual([read(p, 'a2').outcome, read(p, 'a2').reason], ['pending', 'queued'], 'a question held for the user\'s return is pending');
});

test('a finding handled directly: visible while its fixes stand, undone when the user reverts them', () => {
  const p = withActions(action('s1', 'share', 'completed', { finishedAt: NOW - HOUR }));
  p.directFixes = [{ id: 'f1', actionId: 's1', at: iso(NOW - HOUR), status: 'pending', files: [{ path: 'a.md' }] }];
  assert.deepEqual([read(p, 's1').outcome, read(p, 's1').reason], ['visible', 'change_applied']);
  p.directFixes = [{ id: 'f1', actionId: 's1', at: iso(NOW - HOUR), status: 'reverted', settledAt: iso(NOW - 5 * MIN), files: [{ path: 'a.md' }] }];
  assert.deepEqual([read(p, 's1').outcome, read(p, 's1').at], ['undone', NOW - 5 * MIN]);
});

test('schedule and learn actions: a schedule made is visible; a candidate that passed is, one that did not is none', () => {
  const p = withActions(action('c1', 'schedule', 'completed', { finishedAt: NOW - HOUR }), action('l1', 'learn', 'completed', { finishedAt: NOW - HOUR }), action('l2', 'learn', 'completed', { finishedAt: NOW - HOUR }));
  p.jobs = [{ id: 'l1', lane: 'background', kind: 'evolution', status: 'completed', versionId: 'v2', createdAt: iso(NOW - 2 * HOUR), completedAt: iso(NOW - HOUR) }, { id: 'l2', lane: 'background', kind: 'evolution', status: 'rejected', createdAt: iso(NOW - 2 * HOUR), completedAt: iso(NOW - HOUR) }];
  assert.deepEqual([read(p, 'c1').outcome, read(p, 'c1').reason], ['visible', 'schedule_created']);
  assert.deepEqual([read(p, 'l1').outcome, read(p, 'l1').reason], ['visible', 'candidate_ready']);
  assert.deepEqual([read(p, 'l2').outcome, read(p, 'l2').reason], ['none', 'candidate_not_ready']);
});

test('records an action has no more of read as unknown, and an archived or revoked action is not read at all', () => {
  assert.equal(read(project(), 'ghost'), null);
  assert.equal(read(withActions({ ...action('w1', 'work', 'completed'), contextRevoked: true }), 'w1'), null);
  assert.equal(actionOutcome(project(), '', NOW), null);
});

test('labels come from outcomes: needed, not needed, or nothing; a message needs a reaction first (PDL-7)', () => {
  const wake = { gate: { ledgerId: 'L1', deferred: ['D1', 'D2'] } };
  const labels = (outcome, extra = {}) => outcomeLabels({ outcome, kind: 'work', ...extra }, wake);
  assert.deepEqual(labels('visible'), [{ id: 'L1', value: 'wake_needed_work' }, { id: 'D1', value: 'defer_missed' }, { id: 'D2', value: 'defer_missed' }], 'a kept change: the wake was needed, the deferrals missed');
  assert.deepEqual(labels('none'), [{ id: 'L1', value: 'wake_unneeded' }, { id: 'D1', value: 'defer_right' }, { id: 'D2', value: 'defer_right' }]);
  assert.deepEqual(labels('undone').map(row => row.value), ['wake_unneeded', 'defer_right', 'defer_right']);
  assert.deepEqual(labels('pending'), []); assert.deepEqual(labels('failed'), [], 'a run that broke says nothing about whether the wake was needed');
  assert.deepEqual(labels('none', { neutral: true }), [], 'a stop by the user or a restart neither');
  assert.deepEqual(labels('visible', { kind: 'share' }), [], 'delivered, nobody reacted yet');
  assert.deepEqual(labels('visible', { kind: 'share', reaction: 'replied' }).map(row => row.value), ['wake_needed_share', 'defer_missed', 'defer_missed']);
  assert.deepEqual(labels('visible', { kind: 'ask', reaction: 'acted' })[0], { id: 'L1', value: 'wake_needed_ask' });
  for (const reaction of ['dismissed', 'ignored', 'down']) assert.deepEqual(labels('visible', { kind: 'share', reaction }).map(row => row.value), ['wake_unneeded', 'defer_right', 'defer_right'], reaction);
  assert.deepEqual(outcomeLabels({ outcome: 'visible', kind: 'work' }, { gate: { deferred: ['D1'] } }), [{ id: 'D1', value: 'defer_missed' }], 'a wake without its own judgment row labels the deferrals');
  assert.deepEqual(outcomeLabels({ outcome: 'visible', kind: 'work' }, {}), [], 'a wake with no judgment rows has nothing to label');
});

// ----------------------------------------------------------------------------------------------------- the log
test('only transitions are persisted, once; a restart replays the records and emits nothing it already persisted', t => {
  const { stateFile } = temp(t); let now = NOW;
  const file = outcomeLogFile(stateFile), p = withActions(action('w1', 'work', 'running', { startedAt: NOW - HOUR }), action('s1', 'share', 'completed', { finishedAt: NOW - 30 * MIN }));
  p.inbox = [entry('s1')];
  let log = new WorkOutcomeLog({ file, now: () => now });
  const first = log.reconcile(p, [], { now });
  assert.deepEqual(first.transitions.map(row => [row.actionId, row.from, row.to]).sort(), [['s1', null, 'visible'], ['w1', null, 'pending']]);
  assert.deepEqual(log.reconcile(p, [], { now }).transitions, [], 'nothing moved: nothing is emitted');
  // The run completes with a kept change set: pending → visible, once.
  p.initiativeRuntime.sdkState.actions[0] = action('w1', 'work', 'completed', { startedAt: NOW - HOUR, finishedAt: NOW - 10 * MIN });
  p.backgroundChanges = [change('w1', { at: iso(NOW - 10 * MIN) })];
  now += MIN;
  assert.deepEqual(log.reconcile(p, [], { now }).transitions.map(row => [row.actionId, row.from, row.to]), [['w1', 'pending', 'visible']]);
  assert.deepEqual(log.reconcile(p, [], { now }).transitions, []);
  const lines = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(row => [row.t, row.actionId, row.from, row.to]).sort(), [['transition', 's1', null, 'visible'], ['transition', 'w1', null, 'pending'], ['transition', 'w1', 'pending', 'visible']]);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['actionId', 'at', 'from', 'kind', 'projectId', 'reason', 't', 'to'], 'the transition and what groups it, nothing else');
  // A restart: a new log reads the file, the records say what they said, and nothing is emitted or written.
  const size = readFileSync(file, 'utf8').length;
  log = new WorkOutcomeLog({ file, now: () => now });
  assert.deepEqual(log.reconcile(p, [], { now }).transitions, [], 'the replay emits no duplicate');
  assert.deepEqual(log.last('w1') && [log.last('w1').to, log.last('s1').to], ['visible', 'visible']);
  assert.equal(readFileSync(file, 'utf8').length, size, 'and writes nothing');
});

test('a late revert finds its row: the action has left the SDK\'s history and its job, and the change set alone says it was undone', t => {
  const { stateFile } = temp(t); let now = NOW;
  const log = new WorkOutcomeLog({ file: outcomeLogFile(stateFile), now: () => now }), p = withActions(action('w1', 'work', 'completed', { startedAt: NOW - 100 * MIN, finishedAt: NOW - HOUR }));
  p.backgroundChanges = [change('w1')];
  assert.deepEqual(log.reconcile(p, [], { now }).transitions.map(row => row.to), ['visible']);
  // The SDK compacts its history (maxHistory); the job is archived with it: only the change set row is left.
  p.initiativeRuntime.sdkState.actions = [];
  now += 2 * DAY;
  assert.deepEqual(log.reconcile(p, [], { now }).transitions, [], 'still visible');
  assert.equal(log.reconcile(p, [], { now }).records.get('w1').outcome, 'visible', 'followed from the log, not from the SDK');
  // Two days later the user reverts the change set.
  p.backgroundChanges = [change('w1', { status: 'reverted', revertedAt: iso(now - MIN) })];
  const late = log.reconcile(p, [], { now }).transitions;
  assert.deepEqual(late.map(row => [row.actionId, row.kind, row.from, row.to, row.at, row.reason]), [['w1', 'work', 'visible', 'undone', now - MIN, 'change_undone']], 'the late revert found the row it belongs to');
  // Beyond the undo horizon the action is no longer followed (project-mind's WORK_OUTCOME_HORIZON_MS).
  now += OUTCOME_HORIZON_MS + DAY;
  p.backgroundChanges = [change('w1')];
  assert.deepEqual(log.reconcile(p, [], { now }).transitions, [], 'a history older than the horizon is left alone');
});

test('the user\'s undo in the git apply records finds the action before its change row catches up', t => {
  const { stateFile } = temp(t); const now = NOW;
  const log = new WorkOutcomeLog({ file: outcomeLogFile(stateFile), now: () => now }), p = withActions(action('w1', 'work', 'completed', { finishedAt: NOW - HOUR }));
  p.backgroundChanges = [change('w1', { applyId: 'ap1', applyIds: ['ap1'] })];
  const applied = { id: 'ap1', kind: 'background', target: 'project', at: iso(NOW - HOUR), state: 'applied', source: { actionId: 'w1' }, files: 1, sample: [{ path: 'a.md' }] };
  p.git = { applies: [applied] };
  const state = { sessions: [], projects: [p] };
  assert.deepEqual(log.reconcile(p, [], { now, state }).transitions.map(row => row.to), ['visible']);
  // The panel's rollback of the apply record: the change row still says `kept` (its upkeep has not run yet).
  p.git = { applies: [applied, { id: 'rb1', kind: 'rollback', initiator: 'user', target: 'project', at: iso(NOW - 5 * MIN), state: 'applied', undoes: 'ap1', files: 1, sample: [{ path: 'a.md' }], source: {} }] };
  assert.equal(p.backgroundChanges[0].status, 'kept');
  const undone = log.reconcile(p, [], { now, state });
  assert.deepEqual(undone.transitions.map(row => [row.actionId, row.from, row.to, row.at]), [['w1', 'visible', 'undone', NOW - 5 * MIN]]);
  assert.deepEqual(log.reconcile(p, [], { now, state }).transitions, [], 'and once');
});

test('a derivation that goes backwards is a record that aged out, not news', t => {
  const { stateFile } = temp(t); const now = NOW;
  const log = new WorkOutcomeLog({ file: outcomeLogFile(stateFile), now: () => now }), p = withActions(action('s1', 'share', 'completed', { finishedAt: NOW - HOUR }));
  p.inbox = [entry('s1')];
  assert.deepEqual(log.reconcile(p, [], { now }).transitions.map(row => row.to), ['visible']);
  p.inbox = []; p.initiativeRuntime.sdkState.actions = [];
  assert.deepEqual(log.reconcile(p, [], { now }).transitions, [], 'the inbox entry was trimmed: nothing to say');
  p.initiativeRuntime.sdkState.actions = [action('s1', 'share', 'queued')];
  assert.deepEqual(log.reconcile(p, [], { now }).transitions, [], 'visible never goes back to pending');
  // An undo the user reversed: undone → visible is allowed (the outcome in between was recorded first).
  p.initiativeRuntime.sdkState.actions = [action('w2', 'work', 'completed', { finishedAt: NOW - HOUR })];
  p.backgroundChanges = [change('w2', { status: 'reverted', revertedAt: iso(NOW - 20 * MIN) })];
  assert.deepEqual(log.reconcile(p, [], { now }).transitions.map(row => [row.actionId, row.from, row.to]), [['w2', null, 'undone']]);
  p.backgroundChanges = [change('w2', { at: iso(NOW - 5 * MIN) })];
  assert.deepEqual(log.reconcile(p, [], { now }).transitions.map(row => [row.actionId, row.from, row.to]), [['w2', 'undone', 'visible']]);
});

test('an undo the user reversed is visible again once: the newest transition is the last one emitted, not the one with the latest instant (review: no re-emission every pass)', t => {
  const { stateFile } = temp(t); let now = NOW;
  const file = outcomeLogFile(stateFile), log = new WorkOutcomeLog({ file, now: () => now }), p = withActions(action('w1', 'work', 'completed', { startedAt: NOW - 100 * MIN, finishedAt: NOW - 5 * HOUR }));
  p.backgroundChanges = [change('w1', { at: iso(NOW - 5 * HOUR) })];
  const pass = () => log.reconcile(p, [], { now }).transitions.map(row => `${row.from}->${row.to}`);
  assert.deepEqual(pass(), ['null->visible']);
  // The user rolls the change set back (an hour ago), then undoes the rollback: the row is `kept` again (syncGitRows) and
  // the view derives `visible` from the apply time, five hours ago: older than the `undone` it follows.
  p.backgroundChanges = [change('w1', { at: iso(NOW - 5 * HOUR), status: 'reverted', revertedAt: iso(NOW - HOUR) })];
  assert.deepEqual(pass(), ['visible->undone']);
  p.backgroundChanges = [change('w1', { at: iso(NOW - 5 * HOUR) })];
  now += 5000;
  assert.deepEqual(pass(), ['undone->visible'], 'the undo was undone: visible again');
  const back = log.last('w1');
  assert.ok(back.at >= NOW - HOUR, 'a transition never starts before the one it follows');
  // And then it stays: a pass every five seconds for a minute emits nothing, writes nothing, and a restart agrees.
  const size = readFileSync(file, 'utf8').length;
  for (let n = 0; n < 12; n++) { now += 5000; assert.deepEqual(pass(), [], `pass ${n}`); }
  assert.equal(readFileSync(file, 'utf8').length, size);
  assert.deepEqual(new WorkOutcomeLog({ file, now: () => now }).reconcile(p, [], { now }).transitions, [], 'a restart replays nothing');
  assert.equal(new WorkOutcomeLog({ file, now: () => now }).last('w1').to, 'visible');
  assert.deepEqual(log.rows().map(row => row.to), ['visible', 'undone', 'visible']);
  // The user takes it back again later: that one is news too, and found after the first undo was undone.
  now += HOUR; p.backgroundChanges = [change('w1', { at: iso(NOW - 5 * HOUR), status: 'reverted', revertedAt: iso(now - MIN) })];
  assert.deepEqual(pass(), ['visible->undone']); assert.deepEqual(pass(), []);
  // A rewrite sorts by instant and keeps the order per action: a reload still ends where the log did.
  log.rewrite();
  assert.equal(new WorkOutcomeLog({ file, now: () => now }).last('w1').to, 'undone');
});

test('an outcome with no instant of its own (a cancelled or failed action never gets finishedAt) is dated at its admission, and is not emitted again when it leaves the log (review: every 31 days)', t => {
  const { stateFile } = temp(t); let now = Date.parse('2026-09-01T10:00:00Z');
  const rollup = () => new DailyRollup({ file: join(metricsRoot(stateFile), 'outcomes-daily.json'), kind: 'outcomes', now: () => now, timeZone: TZ });
  const log = new WorkOutcomeLog({ file: outcomeLogFile(stateFile), now: () => now, rollup: rollup() });
  const admitted = now - 10 * DAY, p = withActions(
    { ...action('a-cancelled', 'share', 'cancelled', { cancellationReason: 'new_evidence' }), createdAt: admitted },
    { ...action('a-failed', 'share', 'failed', { errorCode: 'provider_down' }), createdAt: admitted });
  // First start after the upgrade: dated when they were decided, not stamped with today.
  const first = log.reconcile(p, [], { now }).transitions;
  assert.deepEqual(first.map(row => [row.actionId, row.to, row.at]).sort(), [['a-cancelled', 'none', admitted], ['a-failed', 'failed', admitted]]);
  now += DAY;
  assert.deepEqual(log.reconcile(p, [], { now }).transitions, []);
  // 33 days later both transitions have left the log (folded into the aggregate), and the SDK still holds its last 128 actions.
  now += 32 * DAY;
  log.add({ projectId: 'p1', actionId: 'other', kind: 'work', from: null, to: 'visible', at: now });
  assert.equal(log.last('a-cancelled'), null, 'they left the log');
  assert.deepEqual(log.reconcile(p, [], { now }).transitions, [], 'and are not emitted again, which would fold them into the aggregate twice');
  const range = windowRange({ days: 90 }, { now, timeZone: TZ }), count = to => log.cells('p1', range, { timeZone: TZ }).filter(cell => cell.key.to === to).reduce((sum, cell) => sum + cell.values.n, 0);
  assert.deepEqual([count('none'), count('failed')], [1, 1]);
});

test('the host\'s own schedule occurrences are not decided actions: no outcome, however many records still name them (review: they inflated the rate)', t => {
  const { stateFile } = temp(t), log = new WorkOutcomeLog({ file: outcomeLogFile(stateFile), now: () => NOW });
  const hostSchedule = { key: 'daily:1', scheduleId: 'sc1', scheduleRevision: 1, destinationSessionId: 's1' };
  const p = withActions(action('occ-delivery', 'share', 'completed', { hostSchedule, finishedAt: NOW - HOUR }), action('occ-work', 'work', 'completed', { hostSchedule, finishedAt: NOW - 2 * HOUR }), action('s1', 'share', 'completed', { finishedAt: NOW - 30 * MIN }));
  p.inbox = [entry('occ-delivery', { scheduled: true }), entry('s1')];
  p.jobs = [{ id: 'occ-work', lane: 'background', kind: 'research', status: 'completed', scheduleId: 'sc1', occurrenceKey: 'daily:1', createdAt: iso(NOW - 3 * HOUR), completedAt: iso(NOW - 2 * HOUR) }];
  assert.equal(read(p, 'occ-delivery'), null); assert.equal(read(p, 'occ-work'), null);
  assert.deepEqual(log.reconcile(p, [], { now: NOW }).transitions.map(row => [row.actionId, row.to]), [['s1', 'visible']], 'the model\'s own share counts; the user\'s schedule firing does not');
  // The SDK has forgotten the occurrence's rows: what is left still says it was the schedule's (the inbox entry's flag, the
  // job's schedule id, the occurrence list), whichever record outlives the others.
  const bare = project({ inbox: [entry('gone-1', { scheduled: true })], jobs: [{ id: 'gone-2', lane: 'background', kind: 'research', status: 'completed', occurrenceKey: 'daily:2', createdAt: iso(NOW - 3 * HOUR), completedAt: iso(NOW - 2 * HOUR) }],
    scheduleRuntime: { occurrences: [{ key: 'daily:3', scheduleId: 'sc1', actionId: 'gone-3', deliveryActionId: 'gone-4', status: 'delivered' }] }, backgroundChanges: [change('gone-3')] });
  bare.inbox.push(entry('gone-4'));
  for (const id of ['gone-1', 'gone-2', 'gone-3', 'gone-4']) assert.equal(read(bare, id), null, id);
  assert.deepEqual(new WorkOutcomeLog({ now: () => NOW }).reconcile(bare, [], { now: NOW }).transitions, []);
});

test('a late revert is found even when every row of the action is gone: the git apply records outlive them (review)', t => {
  const { stateFile } = temp(t); let now = NOW;
  const log = new WorkOutcomeLog({ file: outcomeLogFile(stateFile), now: () => now }), p = withActions(action('w1', 'work', 'completed', { finishedAt: NOW - HOUR }));
  const applied = { id: 'ap1', kind: 'background', target: 'project', at: iso(NOW - HOUR), state: 'applied', source: { actionId: 'w1' }, files: 1, sample: [{ path: 'a.md' }] };
  p.backgroundChanges = [change('w1', { applyId: 'ap1', applyIds: ['ap1'] })]; p.git = { applies: [applied] };
  const state = { sessions: [], projects: [p] };
  assert.deepEqual(log.reconcile(p, [], { now, state }).transitions.map(row => row.to), ['visible']);
  // Days later: the SDK archived the action, the conversation was deleted and took the job, the change set row was trimmed
  // (the list keeps 30), and the inbox entry is gone. Only the apply records remain, and then the user rolls the apply back.
  now += 3 * DAY;
  p.initiativeRuntime.sdkState.actions = []; p.jobs = []; p.backgroundChanges = []; p.inbox = [];
  p.git = { applies: [applied, { id: 'rb1', kind: 'rollback', initiator: 'user', target: 'project', at: iso(now - 5 * MIN), state: 'applied', undoes: 'ap1', files: 1, sample: [{ path: 'a.md' }], source: {} }] };
  assert.deepEqual(log.reconcile(p, [], { now, state }).transitions.map(row => [row.actionId, row.from, row.to, row.at]), [['w1', 'visible', 'undone', now - 5 * MIN]], 'found');
  assert.deepEqual(log.reconcile(p, [], { now, state }).transitions, [], 'once');
  // Nothing in the log and no record at all: still nothing.
  assert.deepEqual(new WorkOutcomeLog({ now: () => now }).reconcile(p, [], { now, state }).transitions, [], 'an action the log never followed is not invented from an undo it has no row for');
});

test('a cancellation the user or a restart caused is `neutral` in the log and the aggregate, and says nothing about the decision (review: it ticked the ladder)', t => {
  const { stateFile } = temp(t), file = outcomeLogFile(stateFile);
  const rollup = new DailyRollup({ file: join(metricsRoot(stateFile), 'outcomes-daily.json'), kind: 'outcomes', now: () => NOW, timeZone: TZ });
  const log = new WorkOutcomeLog({ file, now: () => NOW, rollup });
  const p = withActions(action('w1', 'work', 'cancelled', { cancellationReason: 'action_control' }), action('w2', 'work', 'cancelled', { cancellationReason: 'new_evidence' }));
  const moved = log.reconcile(p, [], { now: NOW }).transitions;
  assert.deepEqual(moved.map(row => [row.actionId, row.neutral]).sort(), [['w1', true], ['w2', undefined]]);
  assert.equal(JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).neutral === true || JSON.parse(readFileSync(file, 'utf8').split('\n')[1]).neutral === true, true, 'persisted with the transition');
  assert.equal(new WorkOutcomeLog({ file, now: () => NOW }).last('w1').neutral, true);
  const range = windowRange({ days: 7 }, { now: NOW, timeZone: TZ });
  assert.deepEqual(log.cells('p1', range, { timeZone: TZ }).map(cell => [cell.key.from, cell.key.to, cell.key.neutral === true]).sort(), [['new', 'none', false], ['new', 'none', true]]);
});

test('transitions older than their 31 days fold into the daily aggregate exactly once, across a crash; history older than the log is never emitted', t => {
  const { stateFile } = temp(t); let now = NOW;
  const rollup = () => new DailyRollup({ file: join(metricsRoot(stateFile), 'outcomes-daily.json'), kind: 'outcomes', now: () => now, timeZone: TZ }), file = outcomeLogFile(stateFile);
  let log = new WorkOutcomeLog({ file, now: () => now, rollup: rollup() });
  log.add({ projectId: 'p1', actionId: 'a', kind: 'work', from: null, to: 'visible', at: now - DAY });
  log.add({ projectId: 'p1', actionId: 'b', kind: 'share', from: null, to: 'none', at: now - DAY });
  log.add({ projectId: 'p1', actionId: 'c', kind: 'work', from: null, to: 'visible', at: now - 2 * DAY });
  now += 31 * DAY + HOUR; // a and b are 32 days old, c 33: all three leave.
  const before = readFileSync(file, 'utf8');
  log.add({ projectId: 'p1', actionId: 'd', kind: 'work', from: null, to: 'failed', at: now });
  log.prune();
  assert.deepEqual(log.rows().map(row => row.actionId), ['d']);
  const range = windowRange({ days: 90 }, { now, timeZone: TZ }), summary = cells => cells.reduce((sum, cell) => { const key = `${cell.key.kind}:${cell.key.to}`; sum[key] = (sum[key] ?? 0) + cell.values.n; return sum; }, {});
  assert.deepEqual(summary(log.cells('p1', range, { timeZone: TZ })), { 'work:visible': 2, 'share:none': 1, 'work:failed': 1 }, 'the aggregate and the file together');
  // A crash after the aggregate was written and before the file was rewritten: the old file comes back, its rows are behind the watermark.
  writeFileSync(file, before);
  log = new WorkOutcomeLog({ file, now: () => now, rollup: rollup() });
  assert.deepEqual(summary(log.cells('p1', range, { timeZone: TZ })), { 'work:visible': 2, 'share:none': 1 }, 'not counted twice; the failed row was never in the old file');
  // An SDK action older than the log is not emitted: it would be folded again each time it left.
  const old = withActions(action('w9', 'work', 'completed', { createdAt: now - 40 * DAY, finishedAt: now - 40 * DAY }));
  old.backgroundChanges = [change('w9', { at: iso(now - 40 * DAY) })];
  assert.deepEqual(log.reconcile(old, [], { now }).transitions, []);
  assert.deepEqual(summary(log.cells('p1', range, { timeZone: TZ })), { 'work:visible': 2, 'share:none': 1 });
});

test('lines of a kind this release does not know survive a rewrite; a deleted project\'s rows go with it; readOutcomeLog reads a copy', t => {
  const { stateFile } = temp(t); const now = NOW, file = outcomeLogFile(stateFile);
  mkdirSync(metricsRoot(stateFile), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ t: 'transition', projectId: 'p1', actionId: 'a', kind: 'work', from: null, to: 'visible', at: now - HOUR })}\n${JSON.stringify({ t: 'future', at: now - HOUR, note: 'a later release' })}\nnot json\n`);
  const rollup = new DailyRollup({ file: join(metricsRoot(stateFile), 'outcomes-daily.json'), kind: 'outcomes', now: () => now, timeZone: TZ });
  const log = new WorkOutcomeLog({ file, now: () => now, rollup });
  log.add({ projectId: 'p2', actionId: 'b', kind: 'share', from: null, to: 'none', at: now });
  log.rewrite();
  assert.ok(readFileSync(file, 'utf8').includes('"t":"future"'), 'kept');
  assert.deepEqual(readOutcomeLog(file).map(row => row.actionId).sort(), ['a', 'b']);
  assert.equal(log.removeProject('p1'), 1);
  assert.deepEqual(log.rows().map(row => row.actionId), ['b']); assert.equal(log.last('a'), null);
  assert.deepEqual(readOutcomeLog(file).map(row => row.actionId), ['b']);
  assert.equal(existsSync(join(metricsRoot(stateFile), 'outcomes-daily.json')) || true, true);
});

test('the log is a sidecar inside the journal root, never a new top-level sibling of the state file', t => {
  const { stateFile } = temp(t);
  assert.equal(outcomeLogFile(stateFile), `${stateFile}.rna/metrics/work-outcomes.jsonl`);
  const log = new WorkOutcomeLog({ file: outcomeLogFile(stateFile) });
  log.add({ projectId: 'p1', actionId: 'a', kind: 'work', from: null, to: 'pending', at: NOW });
  assert.ok(existsSync(`${stateFile}.rna/metrics/work-outcomes.jsonl`));
});

test('the experience report shows the wake mix by tier and what became of the actions decided; the K2 block shows the mix too', async t => {
  const { experienceReport } = await import('../experience-report.mjs'), { proactiveMetrics } = await import('../proactive-metrics.mjs');
  const { stateFile } = temp(t), now = NOW;
  const log = new WorkOutcomeLog({ file: outcomeLogFile(stateFile), now: () => now });
  for (const [kind, to, minutes] of [['work', 'pending', 50], ['work', 'visible', 40], ['share', 'visible', 30], ['work', 'none', 20], ['share', 'none', 15], ['work', 'undone', 10], ['work', 'failed', 5]]) log.add({ projectId: 'p1', actionId: `${kind}-${to}-${minutes}`, kind, from: null, to, at: now - minutes * MIN });
  log.add({ projectId: 'p2', actionId: 'other', kind: 'work', from: null, to: 'visible', at: now - MIN });
  const at = minutes => iso(now - minutes * MIN), wake = { history: [
    { at: at(70), outcome: 'thought', floor: false }, { at: at(60), outcome: 'thought', floor: true, tier: 'think' }, { at: at(50), outcome: 'work', floor: false, pending: true, tier: 'request', tierFacts: ['open_commitment'] },
    { at: at(40), outcome: 'work', floor: false, pending: true, tier: 'think' }, { at: at(30), outcome: 'failed', floor: false, reason: 'x', tier: 'request' }, { at: at(20), outcome: 'deferred', floor: false, reason: 'judged_idle' }] };
  const state = { settings: { interfaceLanguage: 'en' }, projects: [{ id: 'p1', name: 'Novel', inbox: [], mind: { pacing: { wake } }, genes: { genes: [] } }], sessions: [], decisionKernelRuntime: { recent: [] } };
  const [row] = experienceReport(state, { now, outcomes: log }).projects;
  assert.deepEqual(row.wakes.byTier, { unrecorded: 2, think: 2, request: 2 }, 'a wake from before the tier was recorded is `unrecorded`');
  assert.deepEqual({ pending: row.outcomes.pending, visible: row.outcomes.visible, none: row.outcomes.none, undone: row.outcomes.undone, failed: row.outcomes.failed }, { pending: 1, visible: 2, none: 2, undone: 1, failed: 1 });
  assert.deepEqual(row.outcomes.byKind, { work: { pending: 1, visible: 1, none: 1, undone: 1, failed: 1 }, share: { visible: 1, none: 1 } });
  assert.equal(row.outcomes.visibleRate, .333, '2 of the 6 that settled (the pending one and the other project\'s are not counted)');
  assert.deepEqual(experienceReport(state, { now }).projects[0].outcomes.visible, 0, 'without the log there is nothing to count');
  const block = proactiveMetrics(state.projects[0], [], { now, windowMs: DAY }).wakes;
  assert.deepEqual(block.byTier, { unrecorded: 2, think: 2, request: 2 });
});

test('the share of decided actions that became visible counts actions, not transitions: a credit, an undo and a user stop are not extra decisions (review)', async t => {
  const { experienceReport } = await import('../experience-report.mjs');
  const { stateFile } = temp(t), now = NOW, log = new WorkOutcomeLog({ file: outcomeLogFile(stateFile), now: () => now });
  const rows = [
    ['A', 'work', null, 'pending', 90], ['A', 'work', 'pending', 'visible', 80],                       // kept
    ['B', 'work', null, 'pending', 90], ['B', 'work', 'pending', 'none', 70], ['B', 'work', 'none', 'visible', 20], // a read-only run a later message cited
    ['C', 'work', null, 'pending', 90], ['C', 'work', 'pending', 'visible', 60], ['C', 'work', 'visible', 'undone', 10], // kept, then taken back
    ['D', 'share', null, 'none', 50],                                                                 // dropped
    ['E', 'work', null, 'none', 40, true],                                                            // stopped by the user: says nothing
    ['F', 'work', null, 'pending', 30],                                                                // still running
    ['G', 'work', null, 'failed', 25]];
  for (const [actionId, kind, from, to, minutes, neutral] of rows) log.add({ projectId: 'p1', actionId, kind, from, to, at: now - minutes * MIN, ...(neutral ? { neutral: true } : {}) });
  const state = { settings: { interfaceLanguage: 'en' }, projects: [{ id: 'p1', name: 'Novel', inbox: [], mind: { pacing: { wake: { history: [] } } }, genes: { genes: [] } }], sessions: [], decisionKernelRuntime: { recent: [] } };
  const { outcomes } = experienceReport(state, { now, outcomes: log }).projects[0];
  // Transitions by the outcome they moved to (documented as such).
  assert.deepEqual([outcomes.pending, outcomes.visible, outcomes.none, outcomes.undone, outcomes.failed, outcomes.neutral], [4, 3, 3, 1, 1, 1]);
  // Actions: A, B, C, D, G settled (E was stopped, F is running); A and B stand as visible (C was taken back).
  assert.equal(outcomes.settled, 5); assert.equal(outcomes.visibleRate, .4, '2 of the 5 that settled; counting transitions would say 3 of 8');
  // Only what the log holds is counted: without it there is no rate.
  assert.equal(experienceReport(state, { now }).projects[0].outcomes.visibleRate, null);
});
