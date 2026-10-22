import test from 'node:test';
import assert from 'node:assert/strict';
import { declaredFollowUp, untilNextRun, FOLLOW_UP_INSTRUCTION, FOLLOW_UP_MAX_DEPTH } from '../declared-follow-up.mjs';
import { wakeOutcome } from '../project-initiative-controller.mjs';

// What the host decides from a finished run's own declaration (FOLLOW-UP: none | a task), pure: the rows it reads and what it returns.
const NOW = Date.UTC(2026, 9, 22, 2, 0, 0), HOUR = 3600000, DAY = 24 * HOUR;
const completed = id => ({ id: `action:${id}:completed`, type: 'action_completed', at: NOW - 60000 });
const run = (id, followUp, extra = {}) => ({ action: { id, action: 'work', status: 'completed', hostSchedule: { key: 'k' }, ...extra }, job: { id, lane: 'background', status: 'completed', ...(followUp ? { followUp } : {}) } });
const view = (runs, { schedules = [{ enabled: true, nextRunAt: new Date(NOW + 23 * HOUR).toISOString() }], delivery = true } = {}) => ({
  project: { jobs: runs.map(row => row.job), schedules },
  unread: [...runs.map(row => completed(row.action.id)), { id: 'observation:o1', type: 'workspace_change', at: NOW - 30000 }, { id: 'schedule-state:s', type: 'schedule_state', at: NOW }],
  actions: [...runs.map(row => row.action), ...(delivery ? [{ id: 'delivery-1', action: 'share', status: 'completed', hostSchedule: { key: 'k' } }] : [])], now: NOW,
});
const none = { kind: 'none' }, task = { kind: 'task', task: 'Re-check the one open row against the primary source today' };

test('a scheduled run that declared none: a wait that rests until the next occurrence', () => {
  const result = declaredFollowUp(view([run('r1', none)]));
  assert.equal(result.decision.action, 'wait'); assert.deepEqual(result.decision.evidenceIds, []); assert.equal(result.decision.nextReviewAfterMs, 23 * HOUR);
  assert.deepEqual(result.meta, { kind: 'none', from: ['r1'], depth: 0 });
  assert.equal(declaredFollowUp({ ...view([run('r1', none)]), project: { jobs: [{ id: 'r1', lane: 'background', status: 'completed', followUp: none }], schedules: [] } }).decision.nextReviewAfterMs, DAY, 'no schedule ahead: a day');
});

test('a declared task becomes one work, citing the completion, with the instruction so that it can declare in turn', () => {
  const result = declaredFollowUp(view([run('r1', task)]));
  assert.equal(result.decision.action, 'work'); assert.deepEqual(result.decision.evidenceIds, ['action:r1:completed']);
  assert.ok(result.decision.content.startsWith(task.task)); assert.ok(result.decision.content.endsWith(FOLLOW_UP_INSTRUCTION));
  assert.equal(result.decision.title, task.task); assert.ok(result.decision.nextReviewAfterMs >= 1000);
  assert.deepEqual(result.meta, { kind: 'task', from: ['r1'], depth: 1 });
});

test('one follow-up at most: the first declared task, whatever else was declared', () => {
  const result = declaredFollowUp(view([run('r1', none), run('r2', task), run('r3', { kind: 'task', task: 'A different later check of another source' })]));
  assert.equal(result.decision.action, 'work'); assert.deepEqual(result.decision.evidenceIds, ['action:r2:completed']); assert.deepEqual(result.meta.from, ['r1', 'r2', 'r3']);
});

test('a follow-up that was itself declared may declare again; the chain stops at its depth', () => {
  const second = run('r2', task, { hostSchedule: undefined, hostDeclared: { kind: 'task', from: ['r1'], depth: 1 } });
  assert.equal(declaredFollowUp(view([second])).meta.depth, 2);
  assert.equal(declaredFollowUp(view([run('r4', none, { hostSchedule: undefined, hostDeclared: { kind: 'task', from: ['r3'], depth: FOLLOW_UP_MAX_DEPTH } })])).decision.action, 'wait', 'none still settles at any depth');
  assert.equal(declaredFollowUp(view([run('r4', task, { hostSchedule: undefined, hostDeclared: { kind: 'task', from: ['r3'], depth: FOLLOW_UP_MAX_DEPTH } })])), null, 'a task past the depth is the model\'s');
});

test('anything that is not only the declaring runs\' own doing is the model\'s', () => {
  const base = view([run('r1', none)]);
  assert.equal(declaredFollowUp({ ...base, unread: [...base.unread, { id: 'message:m1', type: 'user_message', at: NOW }] }), null, 'a user message');
  assert.equal(declaredFollowUp({ ...base, unread: [...base.unread, { id: 'turn:t', type: 'conversation_result', at: NOW }] }), null, 'a foreground turn');
  assert.equal(declaredFollowUp({ ...base, unread: [] }), null, 'nothing unread');
  assert.equal(declaredFollowUp({ ...base, unread: base.unread.filter(row => row.type !== 'action_completed') }), null, 'no completion among them');
  assert.equal(declaredFollowUp({ ...base, unread: [{ id: 'action:ghost:completed', type: 'action_completed', at: NOW }] }), null, 'a completion the coordinator does not know');
});

test('a run the host cannot trust to have finished, or that owes the user an answer, is reviewed', () => {
  assert.equal(declaredFollowUp(view([run('r1', null)])), null, 'no declaration');
  assert.equal(declaredFollowUp(view([run('r1', { kind: 'maybe' })])), null, 'not a declaration');
  assert.equal(declaredFollowUp(view([run('r1', none, { resolves: ['commitment-1'] })])), null, 'it resolves a request of the user\'s');
  assert.equal(declaredFollowUp(view([run('r1', none, { status: 'needs_review' })])), null, 'the action did not complete cleanly');
  const unreported = view([run('r1', none)]); unreported.project.jobs[0].unreported = true;
  assert.equal(declaredFollowUp(unreported), null, 'its last step was a tool call that was never sent');
  const failed = view([run('r1', none)]); failed.project.jobs[0].status = 'failed';
  assert.equal(declaredFollowUp(failed), null, 'the job failed');
  // A model-decided work (neither scheduled nor itself declared) never settles its own review.
  assert.equal(declaredFollowUp(view([run('r1', none, { hostSchedule: undefined })])), null);
});

test('untilNextRun: the nearest enabled occurrence ahead, at least a minute and at most a day', () => {
  const at = ms => new Date(NOW + ms).toISOString();
  assert.equal(untilNextRun({ schedules: [{ enabled: true, nextRunAt: at(5 * HOUR) }, { enabled: true, nextRunAt: at(2 * HOUR) }, { enabled: false, nextRunAt: at(HOUR) }, { enabled: true, nextRunAt: at(-HOUR) }] }, NOW), 2 * HOUR);
  assert.equal(untilNextRun({ schedules: [{ enabled: true, nextRunAt: at(10) }] }, NOW), 60000);
  assert.equal(untilNextRun({ schedules: [{ enabled: true, nextRunAt: at(40 * HOUR) }] }, NOW), DAY);
  assert.equal(untilNextRun({ schedules: [] }, NOW), null); assert.equal(untilNextRun({}, NOW), null);
});

test('wakeOutcome: a declared task is work, a declared none is settled without the model, with the saving', () => {
  assert.deepEqual(wakeOutcome({ status: 'decided', declared: { kind: 'task' }, decision: { action: 'work' }, admitted: true, savedTokens: 70000 }), { outcome: 'work', reason: 'declared_follow_up', saved: 70000 });
  assert.deepEqual(wakeOutcome({ status: 'decided', declared: { kind: 'none' }, decision: { action: 'wait' }, admitted: true, savedTokens: 70000 }), { outcome: 'deferred', reason: 'declared_no_follow_up', saved: 70000 });
  assert.deepEqual(wakeOutcome({ status: 'decided', declared: { kind: 'task' }, decision: { action: 'work' }, admitted: false, savedTokens: 5 }), { outcome: 'deferred', reason: 'declared_not_admitted', saved: 5 });
  assert.deepEqual(wakeOutcome({ status: 'decided', decision: { action: 'wait' } }), { outcome: 'thought' }, 'a model decision is as before');
});
