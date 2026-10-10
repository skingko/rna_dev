import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectSchedule, updateProjectSchedule, projectScheduleDue, projectScheduleView, projectScheduleExecutionRevision, projectScheduleClaimCurrent, projectSchedulePeriodMs, projectScheduleWindowOpen, projectScheduleWindowPassed } from '../src/project-schedules.mjs';
import { InitiativeCoordinator } from '../src/initiative.mjs';
const at = Date.parse;
const create = (rule, now = at('2026-09-25T19:00:00Z')) => createProjectSchedule({ id: 'daily', title: 'Research report', task: 'Research current primary sources and deliver a cited report.', destinationSessionId: 'session-a', rule }, { now });
test('daily uses the explicit project time zone and never claims an occurrence before creation', () => {
  const row = create({ kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' });
  assert.equal(row.nextRunAt, '2026-09-26T01:00:00.000Z');
  assert.equal(projectScheduleDue(row, at('2026-09-26T00:59:59Z')), null);
  const due = projectScheduleDue(row, at('2026-09-26T01:00:00Z'));
  assert.equal(due.scheduledAt, row.nextRunAt); assert.equal(due.nextRunAt, '2026-09-27T01:00:00.000Z');
  assert.deepEqual(projectScheduleDue(row, at('2026-09-26T01:00:00Z')), due);
  assert.equal(projectScheduleView(row).deliveryMode, 'project-conversation');
});
test('outage coalesces to latest due occurrence rather than a paid backlog', () => {
  const row = create({ kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' });
  const due = projectScheduleDue(row, at('2027-09-26T04:00:00Z'));
  assert.equal(due.scheduledAt, '2027-09-26T01:00:00.000Z'); assert.equal(due.coalescedFrom, row.nextRunAt);
  assert.equal(projectScheduleDue({ ...row, nextRunAt: due.nextRunAt }, at('2027-09-26T04:00:00Z')), null);
});
test('weekly, DST gaps, repeated clocks and half-hour zones are deterministic', () => {
  const weekly = create({ kind: 'weekly', time: '09:00', timeZone: 'Asia/Kolkata', days: [1, 5] });
  assert.equal(weekly.nextRunAt, '2026-09-28T03:30:00.000Z');
  const gap = create({ kind: 'daily', time: '02:30', timeZone: 'America/New_York' }, at('2026-03-08T04:00:00Z'));
  assert.equal(gap.nextRunAt, '2026-03-09T06:30:00.000Z');
  const fold = create({ kind: 'daily', time: '01:30', timeZone: 'America/New_York' }, at('2026-11-01T04:00:00Z'));
  assert.equal(fold.nextRunAt, '2026-11-01T05:30:00.000Z');
  const due = projectScheduleDue(fold, at('2026-11-01T06:45:00Z'));
  assert.equal(due.scheduledAt, fold.nextRunAt); assert.equal(due.nextRunAt, '2026-11-02T06:30:00.000Z');
});
test('interval anchor survives restart, clock rollback and arbitrary missed periods', () => {
  const row = create({ kind: 'interval', everyMs: 300000 }, 1000000);
  const copy = JSON.parse(JSON.stringify(row));
  assert.equal(projectScheduleDue(copy, 999999), null);
  const due = projectScheduleDue(copy, 1e12);
  assert.equal((Date.parse(due.scheduledAt) - Date.parse(row.rule.anchorAt)) % 300000, 0);
  assert.ok(Date.parse(due.nextRunAt) > 1e12); assert.ok(Date.parse(due.nextRunAt) <= 1e12 + 300000);
});
test('once is future-only, canonical and consumed exactly once by cursor', () => {
  const row = create({ kind: 'once', at: '2026-09-26T09:00:00+08:00' });
  const due = projectScheduleDue(row, at('2026-09-26T02:00:00Z'));
  assert.equal(due.scheduledAt, '2026-09-26T01:00:00.000Z'); assert.equal(due.nextRunAt, null);
  assert.equal(projectScheduleDue({ ...row, nextRunAt: null }, at('2026-09-27T02:00:00Z')), null);
  assert.equal(updateProjectSchedule(row, { enabled: false }, { now: at('2026-09-27T02:00:00Z') }).enabled, false);
});
test('input refuses impossible dates, unknown fields, ambiguous zones and unbounded frequency', () => {
  for (const rule of [{ kind: 'once', at: '2027-02-30T09:00:00Z' }, { kind: 'once', at: '2027-02-20T09:00:00' }, { kind: 'daily', time: '24:00', timeZone: 'UTC' }, { kind: 'daily', time: '09:00', timeZone: 'CST' }, { kind: 'weekly', time: '09:00', timeZone: 'UTC', days: [1, 1] }, { kind: 'interval', everyMs: 299999 }, { kind: 'daily', time: '09:00', timeZone: 'UTC', shell: 'never' }]) assert.throws(() => create(rule), { code: 'invalid_schedule' });
  assert.throws(() => updateProjectSchedule(create({ kind: 'daily', time: '09:00', timeZone: 'UTC' }), { enabled: null }), { code: 'invalid_schedule' });
});
test('a pause never silently replays a past occurrence: switching back on starts from now', () => {
  const row = create({ kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' });
  assert.equal(projectScheduleDue({ ...row, enabled: false }, at('2026-09-27T01:00:00Z')), null);
  const paused = updateProjectSchedule(row, { enabled: false }, { now: at('2026-09-26T00:00:00Z') });
  const resumed = updateProjectSchedule(paused, { enabled: true }, { now: at('2026-09-28T03:00:00Z') });
  assert.equal(resumed.nextRunAt, '2026-09-29T01:00:00.000Z', 'the windows the pause covered are not caught up');
  assert.equal(projectScheduleDue(resumed, at('2026-09-28T03:00:00Z')), null);
});
test('the occurrence key names the window (schedule id + scheduledAt): a title edit keeps a due window and the execution revision', () => {
  const row = create({ kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }), now = at('2026-09-27T01:00:00Z');
  const before = projectScheduleDue(row, now);
  const renamed = updateProjectSchedule(row, { title: 'Updated report' }, { now });
  assert.equal(renamed.revision, 2); assert.equal(projectScheduleExecutionRevision(renamed), 1, 'a title is not what an occurrence performs');
  assert.equal(renamed.nextRunAt, row.nextRunAt, 'the due window an edit found unclaimed stays due (it used to be skipped silently)');
  assert.deepEqual(projectScheduleDue(renamed, now), before, 'same window, same key');
  assert.equal(updateProjectSchedule(renamed, { rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }, { now }).executionRevision, 1, 'the same rule sent again is no change');
  for (const patch of [{ task: 'Another task.' }, { destinationSessionId: 'session-b' }, { rule: { kind: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' } }, { enabled: false }]) assert.equal(updateProjectSchedule(renamed, patch, { now }).executionRevision, 3, `${JSON.stringify(patch)}: the revision of this edit`);
  const moved = updateProjectSchedule(renamed, { rule: { kind: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' } }, { now });
  assert.equal(moved.nextRunAt, '2026-09-27T02:00:00.000Z', 'a new rule starts from now');
  // Records saved before the execution revision existed read their revision, and an edit carries it on.
  const legacy = { ...row, revision: 5 }; delete legacy.executionRevision;
  assert.equal(projectScheduleExecutionRevision(legacy), 5); assert.equal(updateProjectSchedule(legacy, { title: 'Renamed' }, { now }).executionRevision, 5);
  assert.notEqual(projectScheduleDue({ ...row, id: 'other' }, now).key, before.key, 'the key belongs to its schedule');
});
test('a claim stays current while nothing it performs changed since the revision it was claimed at, claims made by 0.68 included', () => {
  const now = at('2026-09-27T01:00:00Z'), row = create({ kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' });
  const renamed = updateProjectSchedule(row, { title: 'Renamed' }, { now });
  assert.equal(projectScheduleClaimCurrent(renamed, 1), true, 'claimed before the title edit');
  assert.equal(projectScheduleClaimCurrent(renamed, 2), true, 'claimed after it: a claim carries the record revision, so a 0.68 claim made after a rollback reads the same');
  const retasked = updateProjectSchedule(renamed, { task: 'Another task.' }, { now });
  assert.deepEqual([retasked.revision, retasked.executionRevision], [3, 3]);
  for (const claimed of [1, 2]) assert.equal(projectScheduleClaimCurrent(retasked, claimed), false, `claimed at ${claimed}, before the task changed`);
  assert.equal(projectScheduleClaimCurrent(retasked, 3), true);
  assert.equal(projectScheduleClaimCurrent(retasked, 4), false, 'not a revision this record has had');
  assert.equal(projectScheduleClaimCurrent(retasked, undefined), false);
  // A rollback edits with 0.68's update, which keeps the fields it does not know and moves the revision: anything may
  // have changed, so only claims made since that edit stay current, and the next edit here starts from it.
  const older = { ...renamed, task: 'Changed by 0.68.', revision: 3 };
  assert.equal(projectScheduleExecutionRevision(older), 3);
  assert.equal(projectScheduleClaimCurrent(older, 2), false); assert.equal(projectScheduleClaimCurrent(older, 3), true);
  const forward = updateProjectSchedule(older, { title: 'Renamed again' }, { now });
  assert.deepEqual([forward.revision, forward.executionRevision, forward.executionRevisionAt], [4, 3, 4]);
  assert.equal(projectScheduleClaimCurrent(forward, 3), true, 'a title edit after the roll-forward keeps the 0.68 claim');
  // A record saved before the execution revision existed: only a claim at its revision is current (0.68's rule).
  const legacy = { ...row, revision: 5 }; delete legacy.executionRevision; delete legacy.executionRevisionAt;
  assert.equal(projectScheduleClaimCurrent(legacy, 5), true); assert.equal(projectScheduleClaimCurrent(legacy, 4), false);
  assert.equal(projectScheduleClaimCurrent(updateProjectSchedule(legacy, { title: 'Renamed' }, { now }), 5), true);
  assert.equal(projectScheduleClaimCurrent(updateProjectSchedule(legacy, { task: 'Another task.' }, { now }), 5), false);
});
test('a one-shot whose time has passed can still be renamed with its rule sent again; a new past rule is refused', () => {
  const once = create({ kind: 'once', at: '2026-09-26T09:00:00+08:00' }), later = at('2026-09-27T00:00:00Z');
  const claimed = { ...once, nextRunAt: null };
  const renamed = updateProjectSchedule(claimed, { title: 'Renamed', task: claimed.task, rule: { kind: 'once', at: '2026-09-26T09:00:00+08:00' }, destinationSessionId: claimed.destinationSessionId, enabled: true }, { now: later });
  assert.deepEqual([renamed.title, renamed.nextRunAt, projectScheduleExecutionRevision(renamed)], ['Renamed', null, 1]);
  assert.throws(() => updateProjectSchedule(claimed, { rule: { kind: 'once', at: '2026-09-26T10:00:00+08:00' } }, { now: later }), /must be in the future/);
});
test('a queued window passes only when a later window opens, never when the wall clock steps back', () => {
  const daily = create({ kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }), window = '2026-09-26T01:00:00.000Z';
  assert.equal(projectScheduleWindowPassed(daily, window, at('2026-09-26T00:59:00Z')), false, 'a clock stepped back before the window');
  assert.equal(projectScheduleWindowPassed(daily, window, at('2026-09-27T00:59:59Z')), false);
  assert.equal(projectScheduleWindowPassed(daily, window, at('2026-09-27T01:00:00Z')), true);
  assert.equal(projectScheduleWindowPassed(create({ kind: 'once', at: '2026-09-26T09:00:00+08:00' }), window, at('2027-01-01T00:00:00Z')), false);
});
test('one period is the time to the rule\'s next window; a window stays open until the next one opens (a one-shot stays open)', () => {
  const daily = create({ kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }), DAY = 86400000;
  assert.equal(projectSchedulePeriodMs(daily, '2026-09-26T01:00:00.000Z'), DAY);
  assert.equal(projectScheduleWindowOpen(daily, '2026-09-26T01:00:00.000Z', at('2026-09-27T00:59:59Z')), true);
  assert.equal(projectScheduleWindowOpen(daily, '2026-09-26T01:00:00.000Z', at('2026-09-27T01:00:00Z')), false, 'the next window has opened');
  assert.equal(projectScheduleWindowOpen(daily, '2026-09-26T01:30:00.000Z', at('2026-09-26T02:00:00Z')), false, 'not a window of this rule');
  assert.equal(projectScheduleWindowOpen(daily, '2026-09-26T01:00:00.000Z', at('2026-09-26T00:00:00Z')), false, 'not open yet');
  const weekly = create({ kind: 'weekly', time: '09:00', timeZone: 'Asia/Kolkata', days: [1, 5] });
  assert.equal(projectSchedulePeriodMs(weekly, '2026-09-28T03:30:00.000Z'), 4 * DAY, 'Monday to Friday');
  assert.equal(projectSchedulePeriodMs(weekly, '2026-10-02T03:30:00.000Z'), 3 * DAY, 'Friday to Monday');
  const dst = create({ kind: 'daily', time: '09:00', timeZone: 'America/New_York' }, at('2026-10-30T00:00:00Z'));
  assert.equal(projectSchedulePeriodMs(dst, '2026-10-31T13:00:00.000Z'), DAY + 3600000, 'the day the clocks go back is 25 hours');
  const interval = create({ kind: 'interval', everyMs: 600000, anchorAt: '2026-09-26T00:00:00Z' });
  assert.equal(projectSchedulePeriodMs(interval, '2026-09-26T00:10:00.000Z'), 600000);
  assert.equal(projectScheduleWindowOpen(interval, '2026-09-26T00:10:00.000Z', at('2026-09-26T00:19:00Z')), true);
  assert.equal(projectScheduleWindowOpen(interval, '2026-09-26T00:10:00.000Z', at('2026-09-26T00:20:00Z')), false);
  const once = create({ kind: 'once', at: '2026-09-26T09:00:00+08:00' });
  assert.equal(projectSchedulePeriodMs(once, '2026-09-26T01:00:00.000Z'), null);
  assert.equal(projectScheduleWindowOpen(once, '2026-09-26T01:00:00.000Z', at('2027-01-01T00:00:00Z')), true, 'a one-shot never becomes a backlog');
  assert.deepEqual(projectScheduleView(daily).timingPolicy, { missed: 'latest-only', grace: 'one-period', whileMuted: 'paused', daylightSavingGap: 'skip', daylightSavingFold: 'first' });
});
const hostInput = (action = 'work') => ({ id: `occurrence:${action}`, action, content: 'Produce the scheduled report', reason: 'Persisted duty is due', source: { id: 'occurrence', type: 'scheduled_occurrence', summary: 'A real persisted schedule is due', at: 1000 }, hostSchedule: { key: 'occurrence', scheduleId: 'schedule', scheduleRevision: 1, destinationSessionId: 'session' } });
test('host due admission is durable, idempotent, metered and needs no router model request', async () => {
  const states = []; let calls = 0, modelCalls = 0;
  const c = new InitiativeCoordinator({ project: { id: 'p' }, provider: async function* () { modelCalls++; }, saveState: state => states.push(state), handlers: { work: async (_action, input) => { calls++; await input.reserveTokens(20); await input.reportUsage({ totalTokens: 12 }); return { summary: 'Generated actual report', usage: { totalTokens: 12 } }; } } });
  await c.enqueueHostAction(hostInput()); assert.equal(states.at(-1).actions[0].status, 'queued');
  await c.enqueueHostAction(hostInput()); assert.equal(c.state.actions.length, 1);
  await assert.rejects(c.enqueueHostAction({ ...hostInput(), content: 'Different task' }), { code: 'host_action_conflict' });
  await c.drainHostActions(); await c.idle(); assert.equal(calls, 1); assert.equal(modelCalls, 0); assert.equal(c.state.usedTokens, 12);
  await c.enqueueHostAction(hostInput()); await c.drainHostActions(); await c.idle(); assert.equal(calls, 1);
  await c.close();
});
test('host admission respects paused and budget gates; while muted a scheduled delivery goes to the host quietly (F9)', async () => {
  const shared = []; let calls = 0; const c = new InitiativeCoordinator({ handlers: { work: async () => { calls++; return { usage: { totalTokens: 0 } }; }, share: async action => { shared.push(action.id); return { usage: { totalTokens: 0 } }; } }, policy: { enabled: false, tokenBudget: 0, notificationMuted: true } });
  await c.enqueueHostAction(hostInput()); await c.drainHostActions(); assert.equal(calls, 0);
  await c.updatePolicy({ enabled: true }); await c.drainHostActions(); assert.equal(c.state.actions[0].deferredReason, 'budget_exhausted');
  // Mute pauses schedules (the host claims nothing new); a delivery of a run that had already started is quiet (inbox
  // tier): typing, quiet time and mute do not hold it, and the host's share handler files it.
  await c.enqueueHostAction(hostInput('share')); await c.drainHostActions(); await c.idle();
  assert.deepEqual(shared, ['occurrence:share']); assert.equal(calls, 0); assert.equal(c.state.actions[1].deferredReason, undefined);
  // A model share is still held by the mute unless it asked for a quiet tier.
  c.state.actions.push({ id: 'model-share', action: 'share', content: 'A finding', reason: 'Evidence', evidenceIds: ['occurrence'], revision: c.state.revision, status: 'queued', createdAt: 1000 });
  await c.drainHostActions(); assert.equal(c.state.actions.find(row => row.id === 'model-share').deferredReason, 'notification_muted'); await c.close();
});
test('while muted a claimed scheduled run that has not started waits, in tick and host drains alike; other work runs; after the unmute it starts (F9)', async () => {
  const ran = []; const c = new InitiativeCoordinator({ handlers: { work: async action => { ran.push(action.id); return { usage: { totalTokens: 0 } }; } }, policy: { notificationMuted: true } });
  await c.enqueueHostAction(hostInput()); await c.drainHostActions(); await c.tick({ decisionEnabled: false }); await c.idle();
  assert.deepEqual(ran, []); assert.equal(c.state.actions[0].status, 'queued'); assert.equal(c.state.actions[0].deferredReason, 'notification_muted');
  // Mute pauses schedules, not background work the model already admitted.
  c.state.actions.push({ id: 'model-work', action: 'work', content: 'Investigate', reason: 'Evidence', evidenceIds: ['occurrence'], revision: c.state.revision, status: 'queued', createdAt: 1000 });
  await c.tick({ decisionEnabled: false }); await c.idle(); assert.deepEqual(ran, ['model-work']);
  await c.updatePolicy({ notificationMuted: false }); await c.drainHostActions(); await c.idle();
  assert.deepEqual(ran, ['model-work', 'occurrence:work']); await c.close();
});
test('restart quarantines started host execution and never replays it', async () => {
  let calls = 0; const c = new InitiativeCoordinator({ handlers: { work: async () => { calls++; } } });
  await c.enqueueHostAction(hostInput()); const state = c.snapshot(); state.actions[0].status = 'running'; state.reservedTokens = 21;
  const restored = new InitiativeCoordinator({ state, handlers: { work: async () => { calls++; } } });
  await restored.drainHostActions(); assert.equal(calls, 0); assert.equal(restored.state.actions[0].status, 'needs_review'); assert.equal(restored.state.usedTokens, 21); assert.equal(restored.state.estimatedTokens, 21); await c.close(); await restored.close();
});
test('closing while host admission persists cannot start a late execution', async () => {
  let entered, release, calls = 0; const admitted = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const c = new InitiativeCoordinator({ handlers: { work: async () => { calls++; return { usage: { totalTokens: 0 } }; } }, saveState: async (_state, metadata) => { if (metadata?.reservationAdmission) { entered(); await held; } } });
  await c.enqueueHostAction(hostInput()); const draining = c.drainHostActions(); await admitted;
  const closing = c.close(); release(); await Promise.allSettled([draining, closing]);
  assert.equal(calls, 0); assert.equal(c.closed, true); assert.equal(c.active.size, 0);
});
