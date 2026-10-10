// D4 scenario (plan B4, F9): "pause proactive messages" pauses schedules, as the settings, the schedule list and the
// model's REACH guidance say. Crosses the project settings route, the schedule service (list, edit), the initiative's
// scheduled work (claim, skip, worker, delivery) and the conversation, on the scenario clock. While muted no scheduled
// work runs and the latest due window is recorded once as skipped; after the unmute only that window runs and is
// delivered once (no backlog); a title edit while it runs leaves it alone. A run claimed before the mute that waits in
// the SDK queue does not start while muted, and a run in flight when the mute starts lands in the inbox only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';

const MINUTE = 60000, DAY = 86400000;
const project = (state, id) => state.projects.find(row => row.id === id);

test('muted: due windows are skipped (latest only) and nothing runs; unmuted: the latest window runs once; a title edit while it runs leaves it alone', async t => {
  // 2026-10-05T01:00Z is 09:00 in Shanghai; the schedule is due at 10:00 there.
  const world = await createWorld(t, { initiative: true, start: '2026-10-05T01:00:00.000Z', files: { 'evidence.txt': 'Measured result: seven verified sources.\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  const created = await world.post(`/api/projects/${world.projectId}/schedules`, { requestId: 'daily-report', title: 'Daily report', task: 'Read evidence.txt and report the measured result.', destinationSessionId: world.sessionId, rule: { kind: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' } });
  assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 300));
  const scheduleId = created.body.id;
  const muted = await world.patch(`/api/projects/${world.projectId}`, { initiative: { notificationMuted: true } });
  assert.equal(muted.status, 200, JSON.stringify(muted.body).slice(0, 300));
  await s.advanceClock(1000, { settleMs: 1500, label: 'the initiative reviews the new schedule' });
  const occurrences = () => world.project().scheduleRuntime?.occurrences ?? [];
  const delivered = () => world.session().items.filter(item => item.scheduleOccurrenceKey);

  await t.test('muted through two due windows: no scheduled run, one skipped row for the latest window, the list says paused', async () => {
    const first = await s.advanceClock(70 * MINUTE, { label: 'the first window comes due while muted', until: () => occurrences()[0]?.status === 'skipped' });
    await first.expect({
      requests: rows => assert.deepEqual(rows.filter(row => row.tag === 'background-work'), [], 'no scheduled work while muted'),
      state: state => {
        const target = project(state, world.projectId);
        assert.deepEqual(target.scheduleRuntime.occurrences.map(row => [row.scheduledAt, row.status, row.errorCode]), [['2026-10-05T02:00:00.000Z', 'skipped', 'notifications_muted']]);
        assert.equal(target.schedules[0].nextRunAt, '2026-10-06T02:00:00.000Z', 'the schedule moved on to its next window');
      },
    });
    const second = await s.advanceClock(DAY, { label: 'the next window comes due, still muted', until: () => occurrences()[0]?.scheduledAt === '2026-10-06T02:00:00.000Z' });
    await second.expect({
      requests: rows => assert.deepEqual(rows.filter(row => row.tag === 'background-work'), [], 'still nothing runs'),
      state: state => assert.deepEqual(project(state, world.projectId).scheduleRuntime.occurrences.map(row => [row.scheduledAt, row.status]), [['2026-10-06T02:00:00.000Z', 'skipped']], 'only the latest skipped window is kept'),
    });
    assert.equal(delivered().length, 0, 'nothing reached the conversation');
    const listed = await world.get(`/api/projects/${world.projectId}/schedules`);
    assert.equal(listed.body.schedules[0].pausedReason, 'notifications_muted', 'the schedule list says paused, and it is');
  });

  await t.test('unmuted: the latest window runs once and is delivered once; a title edit during the run does not revoke it', async () => {
    world.faux.script('background-work',
      async () => {
        // The run is in flight: the user renames the schedule. Its identity is the window, not the record's revision.
        const renamed = await world.patch(`/api/projects/${world.projectId}/schedules/${scheduleId}`, { title: 'Daily report (renamed)' });
        assert.equal(renamed.status, 200, JSON.stringify(renamed.body).slice(0, 300));
        return { toolCalls: [{ name: 'project_read', args: { path: 'evidence.txt' } }] };
      },
      'The measured result is seven verified sources.\nHandoff: reported the measured result from evidence.txt; nothing left.');
    const key = occurrences()[0].key;
    await world.patch(`/api/projects/${world.projectId}`, { initiative: { notificationMuted: false } });
    const resumed = await s.advanceClock(1000, { label: 'the unmute', until: () => occurrences()[0]?.status === 'delivered' });
    await resumed.expect({
      state: state => {
        const target = project(state, world.projectId), [occurrence] = target.scheduleRuntime.occurrences;
        assert.equal(target.scheduleRuntime.occurrences.length, 1, 'no backlog: one row, the resumed window');
        assert.deepEqual([occurrence.key, occurrence.status, occurrence.scheduledAt], [key, 'delivered', '2026-10-06T02:00:00.000Z']);
        assert.equal(target.schedules[0].title, 'Daily report (renamed)'); assert.equal(target.schedules[0].executionRevision, 1, 'a title is not what the run performs');
        const rows = state.sessions.find(row => row.id === world.sessionId).items.filter(item => item.scheduleOccurrenceKey === key);
        assert.equal(rows.length, 1, 'delivered once'); assert.match(rows[0].text, /seven verified sources/);
      },
      requests: rows => {
        const work = rows.filter(row => row.tag === 'background-work');
        assert.ok(work.length >= 2, 'the scheduled work ran (read, then report)');
        assert.match(work[0].wire, /Read evidence\.txt and report/);
      },
    });
    assert.equal(delivered().length, 1);
  });

  await t.test('30 quiet minutes after: no second run of the skipped windows', async () => {
    const after = await s.idle(30 * MINUTE, { stepMs: 5 * MINUTE });
    await after.expect({
      requests: rows => assert.deepEqual(rows.filter(row => row.tag === 'background-work').map(row => row.tag), [], 'no catch-up of the first skipped window'),
      state: state => assert.equal(project(state, world.projectId).scheduleRuntime.occurrences.length, 1),
    });
    assert.equal(delivered().length, 1);
  });
});

test('a run claimed before the mute waits in the queue until the unmute; a run in flight when the mute starts goes to the inbox only', async t => {
  const world = await createWorld(t, { initiative: true, start: '2026-10-05T01:00:00.000Z', files: { 'evidence.txt': 'Measured result: seven verified sources.\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  const created = await world.post(`/api/projects/${world.projectId}/schedules`, { requestId: 'daily-report', title: 'Daily report', task: 'Read evidence.txt and report the measured result.', destinationSessionId: world.sessionId, rule: { kind: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' } });
  assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 300));
  // No allowance yet: the due window is claimed and handed to the SDK queue, where it waits.
  const limited = await world.patch(`/api/projects/${world.projectId}`, { initiative: { tokenBudget: 0 } });
  assert.equal(limited.status, 200, JSON.stringify(limited.body).slice(0, 300));
  await s.advanceClock(1000, { settleMs: 1500, label: 'the initiative reviews the new schedule' });
  const occurrences = () => world.project().scheduleRuntime?.occurrences ?? [];
  const queued = () => world.project().initiativeRuntime?.sdkState?.actions?.find(row => row.id === occurrences()[0]?.actionId);
  const delivered = () => world.session().items.filter(item => item.scheduleOccurrenceKey);
  const claimed = await s.advanceClock(61 * MINUTE, { label: 'due without allowance', until: () => queued()?.deferredReason === 'budget_exhausted' });
  await claimed.expect({
    requests: rows => assert.deepEqual(rows.filter(row => row.tag === 'background-work'), [], 'waiting on the allowance'),
    state: state => assert.deepEqual(project(state, world.projectId).scheduleRuntime.occurrences.map(row => [row.scheduledAt, row.status]), [['2026-10-05T02:00:00.000Z', 'queued']]),
  });

  await t.test('muted, then the allowance is back: the claimed run does not start', async () => {
    await world.patch(`/api/projects/${world.projectId}`, { initiative: { notificationMuted: true } });
    await world.patch(`/api/projects/${world.projectId}`, { initiative: { tokenBudget: null } });
    const held = await s.advanceClock(5 * MINUTE, { label: 'the allowance is back while muted', until: () => queued()?.deferredReason === 'notification_muted' });
    await held.expect({ requests: rows => assert.deepEqual(rows.filter(row => row.tag === 'background-work'), [], 'nothing runs while muted') });
    const later = await s.idle(20 * MINUTE, { stepMs: 5 * MINUTE });
    await later.expect({
      requests: rows => assert.deepEqual(rows.filter(row => row.tag === 'background-work'), [], 'still nothing'),
      state: state => assert.deepEqual(project(state, world.projectId).scheduleRuntime.occurrences.map(row => row.status), ['queued'], 'the claim keeps its window'),
    });
    assert.equal(delivered().length, 0);
  });

  await t.test('unmuted: it runs; muted again while it runs: the result is filed in the inbox only, also after the next unmute', async () => {
    world.faux.script('background-work',
      async () => {
        // The run is in flight: the user pauses proactive messages again.
        const again = await world.patch(`/api/projects/${world.projectId}`, { initiative: { notificationMuted: true } });
        assert.equal(again.status, 200, JSON.stringify(again.body).slice(0, 300));
        return { toolCalls: [{ name: 'project_read', args: { path: 'evidence.txt' } }] };
      },
      'The measured result is seven verified sources.\nHandoff: reported the measured result from evidence.txt; nothing left.');
    const key = occurrences()[0].key;
    await world.patch(`/api/projects/${world.projectId}`, { initiative: { notificationMuted: false } });
    const ran = await s.advanceClock(1000, { label: 'the unmute', until: () => occurrences()[0]?.status === 'delivered' });
    await ran.expect({
      requests: rows => assert.ok(rows.filter(row => row.tag === 'background-work').length >= 2, 'the scheduled work ran (read, then report)'),
      state: state => {
        const target = project(state, world.projectId), [occurrence] = target.scheduleRuntime.occurrences;
        assert.deepEqual([occurrence.key, occurrence.status, occurrence.deliveryItemId], [key, 'delivered', null]);
        const entry = target.inbox.find(row => row.id === occurrence.deliveryInboxId);
        assert.deepEqual([entry.tier, entry.reachReasons, entry.scheduled, entry.itemId], ['inbox', ['notification_muted'], true, null]);
        assert.match(entry.text, /seven verified sources/);
        assert.equal(state.sessions.find(row => row.id === world.sessionId).items.filter(item => item.scheduleOccurrenceKey === key).length, 0, 'not posted into the conversation');
      },
    });
    await world.patch(`/api/projects/${world.projectId}`, { initiative: { notificationMuted: false } });
    const after = await s.idle(10 * MINUTE, { stepMs: 5 * MINUTE });
    await after.expect({ state: state => assert.equal(project(state, world.projectId).inbox.find(row => row.actionId === project(state, world.projectId).scheduleRuntime.occurrences[0].deliveryActionId).itemId, null, 'never posted late') });
    assert.equal(delivered().length, 0);
  });
});
