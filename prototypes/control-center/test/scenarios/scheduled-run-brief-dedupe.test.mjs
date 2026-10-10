// D4 scenario (token burn T3, design P2): a daily schedule runs on three days. A scheduled run's first request used to carry
// its own task text several times: the occurrence message, the planning state (the schedule's `task`), its own receipt and
// pending job, and the earlier runs' receipts (an excerpt of their own message). Now the text is in the request once and the
// rest says where it is; what only those rows hold stays. Crosses the schedule service, the initiative's worker brief, the
// runtime's planning state, the SDK request and the schedule's stale path, all through the host's own entry points on the
// scenario clock (only the model is scripted).
//  - day 2: the task's sentinel appears exactly once across all messages of the first request; the earlier run's handoff and
//    occurrence line stay; the run's own receipt, pending job and id are absent; the planning state names its task by placeholder;
//  - day 3: the schedule is edited while the run is in flight: the run still takes the stale path (revoked, nothing delivered)
//    and the placeholder never stands over a changed task (the runtime-level follow-up is in project-initiative-background-context);
//  - a run that compacts its conversation: its occurrence message becomes a summary that does not copy the task, so the planning
//    state, restored next to the summary, carries the task whole from the first request after the compaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { SCHEDULE_TASK_PLACEHOLDER } from '../../../../packages/sdk/src/project-context.mjs';
import { EARLIER_TASK_PLACEHOLDER } from '../../project-initiative-controller.mjs';

const DAY = 86400000, MINUTE = 60000;
const SENTINEL = 'TASK_SENTINEL_5e2c', EDITED = 'EDITED_SENTINEL_81d4';
const TASK = `Daily evidence report (${SENTINEL}). ${'Read evidence.txt, report the measured result first and name the source of every number. '.repeat(10)}Keep the report factual.`;
const count = (text, needle) => text.split(needle).length - 1;
// The SDK request carries each attachment as a labelled canonical JSON array of { source, text } after the message's own text.
const contexts = row => row.request.messages.flatMap(message => (Array.isArray(message.content) ? message.content : []).flatMap(part => {
  const text = typeof part.text === 'string' ? part.text : '', at = text.indexOf('\n[{"source":');
  if (at < 0) return [];
  try { return JSON.parse(text.slice(at + 1)); } catch { return []; }
}));
/** The latest copy of one attachment in a request (a keyed context is sent again when it changes). */
const contextOf = (row, source) => contexts(row).findLast(item => item.source === source)?.text ?? null;
const delivered = world => world.project().scheduleRuntime?.occurrences?.filter(row => row.status === 'delivered') ?? [];

test('a scheduled run\'s first request carries its task once and keeps earlier handoffs; an edit mid-run never hides under the placeholder and the run still goes stale', async t => {
  // 2026-10-05T01:00Z is 09:00 in Shanghai; the schedule is due at 10:00 there.
  const world = await createWorld(t, { initiative: true, start: '2026-10-05T01:00:00.000Z', files: { 'evidence.txt': 'Measured result: seven verified sources.\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world), work = () => world.faux.of('background-work');
  const created = await world.post(`/api/projects/${world.projectId}/schedules`, { requestId: 'daily-report', title: 'Daily report', task: TASK, destinationSessionId: world.sessionId, rule: { kind: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' } });
  assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 300));
  await s.advanceClock(1000, { settleMs: 1500, label: 'the initiative reviews the new schedule' });
  const scheduleId = created.body.id;
  const reading = { toolCalls: [{ name: 'project_read', args: { path: 'evidence.txt' } }] };
  let dayOne, dayTwo;

  await t.test('day 1 (the first run): the task is in the request, the schedule is the only place the planning state holds it', async () => {
    world.faux.script('background-work', reading, 'Day one: the measured result is seven verified sources.\nHandoff: DAY_ONE_HANDOFF_9b1 reported the measured result from evidence.txt; nothing left.');
    const step = await s.advanceClock(2 * 60 * MINUTE, { label: 'day 1 comes due', until: () => delivered(world).length === 1 });
    dayOne = world.project().initiativeRuntime.sdkState.actions.find(action => action.hostSchedule && action.action === 'work');
    await step.expect({ requests: rows => {
      const first = rows.find(row => row.tag === 'background-work');
      assert.equal(count(first.wire, SENTINEL), 1, 'a first run: the task in the request once');
      assert.equal(JSON.parse(contextOf(first, 'project-planning-state')).schedules[0].task, SCHEDULE_TASK_PLACEHOLDER);
    } });
    assert.ok(dayOne?.handoff?.includes('DAY_ONE_HANDOFF_9b1'), 'the run left its handoff');
  });

  await t.test('day 2: one copy of the task; the earlier run\'s handoff and occurrence line stay; the run\'s own receipt, job and id are gone', async () => {
    const before = work().length;
    world.faux.script('background-work', reading, 'Day two: still seven verified sources, nothing new.\nHandoff: DAY_TWO_HANDOFF_4c7 confirmed the result again; nothing left.');
    dayTwo = await s.advanceClock(DAY, { label: 'day 2 comes due', until: () => delivered(world).length === 2 });
    await dayTwo.expect({ requests: () => {
      const first = work()[before];
      assert.ok(first, 'the second run asked the model');
      assert.equal(count(first.wire, SENTINEL), 1, 'the sentinel of the task is in the request exactly once, across every message');
      // The planning state says where its task is; its other fields are the schedule's.
      const planning = JSON.parse(contextOf(first, 'project-planning-state'));
      assert.equal(planning.schedules.length, 1); assert.equal(planning.schedules[0].id, scheduleId);
      assert.equal(planning.schedules[0].task, SCHEDULE_TASK_PLACEHOLDER);
      assert.deepEqual(planning.schedules[0].rule, { kind: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' });
      const evidence = JSON.parse(contextOf(first, 'project-evidence')), receipts = evidence.project.continuity.actionReceipts;
      // The earlier run: its handoff and what ran stay, its occurrence line stays, its copy of the task is a statement.
      const earlier = receipts.find(row => row.actionId === dayOne.id);
      assert.ok(earlier, 'the earlier run has its receipt');
      assert.match(earlier.handoff, /DAY_ONE_HANDOFF_9b1/);
      assert.match(earlier.intent, /^Scheduled occurrence schedule:[^\n]+\nDue: 2026-10-05T02:00:00\.000Z\nTime rule: /);
      assert.ok(earlier.intent.endsWith(EARLIER_TASK_PLACEHOLDER), 'its task excerpt is replaced by the statement');
      assert.equal(earlier.status, 'completed');
      // The run's own receipt, pending job and id.
      const own = world.project().initiativeRuntime.sdkState.actions.filter(action => action.hostSchedule && action.id !== dayOne.id && action.action === 'work').at(-1);
      assert.ok(own, 'the second run\'s action exists');
      assert.deepEqual(receipts.filter(row => row.status === 'running'), [], 'no receipt of a run still running (its own)');
      assert.ok(!receipts.some(row => row.actionId === own.id));
      assert.deepEqual(evidence.project.pendingJobs, [], 'its own pending job is not repeated');
      assert.equal(count(first.wire, own.id), 0, 'its id is nowhere in the request');
      // The run asked for the file and delivered its report.
      assert.equal(work().length - before >= 2, true);
    } });
    assert.match(world.session().items.findLast(item => item.scheduleOccurrenceKey).text, /Day two/);
  });

  await t.test('day 3: the schedule is edited while the run is in flight; the run still goes stale and no request shows the placeholder over the edit', async () => {
    const before = work().length;
    let release; const gate = new Promise(resolve => { release = resolve; });
    world.faux.script('background-work', { hold: gate, then: reading }, 'Day three: this report must not be delivered.\nHandoff: DAY_THREE_HANDOFF_7e0 reported; nothing left.');
    const step = await s.step('day 3 comes due, the task is edited in flight', async () => {
      world.clock.advance(DAY); world.tick();
      await until(() => work().length === before + 1, 'the third run\'s first request');
      const edit = await world.patch(`/api/projects/${world.projectId}/schedules/${scheduleId}`, { task: `${TASK} ${EDITED}: also list every source that could not be opened.` });
      assert.equal(edit.status, 200, JSON.stringify(edit.body).slice(0, 300));
      release();
      return until(() => { const row = world.project().scheduleRuntime.occurrences.at(-1); return row?.scheduledAt === '2026-10-07T02:00:00.000Z' && ['cancelled', 'needs_review', 'failed', 'delivered'].includes(row.status) ? row : null; }, 'the revoked run to settle');
    });
    await step.expect({ requests: () => {
      const [first, ...later] = work().slice(before);
      assert.equal(count(first.wire, SENTINEL), 1, 'its first request: the task once, as on day 2');
      assert.equal(JSON.parse(contextOf(first, 'project-planning-state')).schedules[0].task, SCHEDULE_TASK_PLACEHOLDER);
      // The host revokes a run whose task changed at once, so it normally asks no more; if a request did follow the edit,
      // its planning state is the schedule as it is, the whole new text, never the placeholder over a changed task.
      for (const row of later) { const planning = JSON.parse(contextOf(row, 'project-planning-state')); assert.match(planning.schedules[0].task, new RegExp(EDITED)); assert.notEqual(planning.schedules[0].task, SCHEDULE_TASK_PLACEHOLDER); }
    } });
    const occurrence = step.outcome;
    assert.notEqual(occurrence.status, 'delivered', 'a run whose task changed is not delivered');
    assert.equal(occurrence.errorCode, 'schedule_revoked');
    assert.equal(delivered(world).length, 2, 'only days 1 and 2 reached the conversation');
    assert.ok(!world.session().items.some(item => /DAY_THREE|must not be delivered/.test(item.text ?? '')), 'nothing of the revoked run is in the conversation');
  });
});

test('a scheduled run that compacts its conversation still has its task: the planning state carries it whole once the occurrence message is a summary', async t => {
  // A window the run's own reads overflow after a few steps (the first request is about 19.6K estimated tokens).
  const world = await createWorld(t, { initiative: true, start: '2026-10-05T01:00:00.000Z', model: { contextWindow: 26000, maxOutputTokens: 2000 }, files: { 'big.txt': 'line of evidence text that is long enough to matter. '.repeat(900), '.gitignore': 'dist/\n' } });
  const s = scenario(world), work = () => world.faux.of('background-work');
  const created = await world.post(`/api/projects/${world.projectId}/schedules`, { requestId: 'daily-report', title: 'Daily report', task: TASK, destinationSessionId: world.sessionId, rule: { kind: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' } });
  assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 300));
  await s.advanceClock(1000, { settleMs: 1500, label: 'the initiative reviews the new schedule' });
  // Read the big file until the conversation compacts; the checkpoint (a request without tools) does not copy the task, the way its prompt asks.
  world.faux.on('background-work', request => (request.tools ?? []).length === 0 ? '## User requests\n- [in progress] produce the daily evidence report\n## Progress\n- read big.txt several times'
    : JSON.stringify(request.messages).includes('Prior conversation summary') ? 'The report is written.\nHandoff: COMPACTED_RUN_HANDOFF_3d8 read big.txt and reported; nothing left.'
    : { toolCalls: [{ name: 'project_read', args: { path: 'big.txt' } }] });
  const step = await s.advanceClock(2 * 60 * MINUTE, { label: 'the run comes due and compacts', until: () => delivered(world).length === 1 });
  await step.expect({ requests: () => {
    const runs = work().filter(row => (row.request.tools ?? []).length > 0), summaries = work().filter(row => (row.request.tools ?? []).length === 0);
    const compacted = row => row.wire.includes('Prior conversation summary'), before = runs.filter(row => !compacted(row)), after = runs.filter(compacted);
    assert.ok(summaries.length >= 1 && before.length >= 2 && after.length >= 1, `the run compacted: ${before.length} requests before, ${summaries.length} checkpoints, ${after.length} after`);
    for (const row of before) { assert.equal(count(row.wire, SENTINEL), 1, 'before the compaction: the task once, in the occurrence message'); assert.equal(JSON.parse(contextOf(row, 'project-planning-state')).schedules[0].task, SCHEDULE_TASK_PLACEHOLDER); }
    assert.equal(count(summaries[0].wire, SENTINEL) >= 1, true, 'the checkpoint request is given the whole conversation');
    // After it the occurrence message is the summary: the latest planning state holds the task, whole, and it is in the request once.
    for (const row of after) { assert.equal(JSON.parse(contextOf(row, 'project-planning-state')).schedules[0].task, TASK, 'the planning state carries the task whole'); assert.equal(count(row.wire, SENTINEL), 1, 'the task is in the request once'); }
  } });
  assert.match(world.session().items.findLast(item => item.scheduleOccurrenceKey).text, /The report is written/);
});
