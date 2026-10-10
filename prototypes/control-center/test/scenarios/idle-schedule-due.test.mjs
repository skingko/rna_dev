// D4 scenario (plan A7): a project idles with a browser tab open while a daily schedule comes due. Crosses the
// schedule service, the initiative's tick, wake ladder and scheduled work (worker + delivery), the stream hub's poll
// and the web client's loading rules, all on the scenario clock. While idle, the only model calls are the wake
// ladder's decision reviews, nothing reaches the conversation and every index event is explained by a state change;
// the due occurrence runs once and is delivered once; idle afterwards adds nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { WAKE_LADDER, WAKE_HOLD } from '../../proactive-pacing.mjs';

const MINUTE = 60000;
/** Wakes the ladder allows in `ms` of quiet: each level's delay, WAKE_HOLD times, from the bottom (proactive-pacing.mjs). */
const ladderWakes = ms => { let at = 0, count = 0; for (const delay of WAKE_LADDER) for (let hold = 0; hold < WAKE_HOLD; hold++) { at += delay; if (at <= ms) count++; } return count; };
const describe = frames => frames.map(frame => `${frame.stream} ${frame.event} ${JSON.stringify(frame.data).slice(0, 160)}`);

test('idle with a schedule due: only ladder wakes until it is due, one run and one delivery, nothing more after', async t => {
  // 2026-10-05T01:00Z is 09:00 in Shanghai; the schedule is due at 10:00 there.
  const world = await createWorld(t, { initiative: true, start: '2026-10-05T01:00:00.000Z', files: { 'evidence.txt': 'Measured result: seven verified sources.\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  const created = await world.post(`/api/projects/${world.projectId}/schedules`, { requestId: 'daily-report', title: 'Daily report', task: 'Read evidence.txt and report the measured result.', destinationSessionId: world.sessionId, rule: { kind: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' } });
  assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 300));
  assert.equal(created.body.nextRunAt, '2026-10-05T02:00:00.000Z');
  // The tab is open on the conversation the report goes to; the initiative reviews the new schedule first.
  const tab = await world.browser({ sessionId: world.sessionId });
  await until(() => tab.gets.length >= 2, 'the tab to load');
  await s.advanceClock(1000, { settleMs: 1500, label: 'the initiative reviews the new schedule' });
  const items = () => world.session().items.length;
  let due;

  await t.test('55 quiet minutes before it is due: ladder reviews only, nothing on screen without a state change', async () => {
    const before = items();
    const quiet = await s.idle(55 * MINUTE, { stepMs: 5 * MINUTE });
    await quiet.expect({
      frames: () => assert.deepEqual(describe(quiet.unexplained()), [], 'every index event while idle comes with a state change'),
      requests: rows => {
        assert.deepEqual([...new Set(rows.map(row => row.tag))].filter(tag => tag !== 'initiative'), [], 'idle asks the model only for the wake ladder\'s reviews');
        assert.ok(rows.length <= ladderWakes(55 * MINUTE), `${rows.length} decision reviews in 55 quiet minutes (ladder allows ${ladderWakes(55 * MINUTE)})`);
      },
      state: state => assert.equal(state.projects.find(row => row.id === world.projectId).scheduleRuntime?.occurrences?.length ?? 0, 0, 'nothing ran before the due time'),
    });
    assert.equal(items(), before, 'nothing reached the conversation');
    assert.equal(tab.bootstrapGets(quiet.at), 0, 'the open tab never reloaded the bootstrap');
  });

  await t.test('due: the occurrence runs once and is delivered once to the chosen conversation', async () => {
    world.faux.script('background-work',
      { toolCalls: [{ name: 'project_read', args: { path: 'evidence.txt' } }] },
      'The measured result is seven verified sources.\nHandoff: reported the measured result from evidence.txt; nothing left.');
    const delivered = () => world.project().scheduleRuntime?.occurrences?.find(row => row.status === 'delivered');
    due = await s.advanceClock(10 * MINUTE, { label: 'the schedule comes due', until: delivered });
    await due.expect({
      state: state => {
        const project = state.projects.find(row => row.id === world.projectId), [occurrence] = project.scheduleRuntime.occurrences;
        assert.equal(project.scheduleRuntime.occurrences.length, 1);
        assert.equal(occurrence.status, 'delivered');
        assert.equal(project.schedules[0].nextRunAt, '2026-10-06T02:00:00.000Z', 'the next run is tomorrow');
        const rows = state.sessions.find(row => row.id === world.sessionId).items.filter(item => item.scheduleOccurrenceKey === occurrence.key);
        assert.equal(rows.length, 1, 'delivered once, to the chosen conversation');
        assert.match(rows[0].text, /seven verified sources/);
      },
      requests: rows => {
        const work = rows.filter(row => row.tag === 'background-work');
        assert.ok(work.length >= 2, 'the scheduled work ran (read, then report)');
        assert.match(work[0].wire, /Read evidence\.txt and report/, 'with the schedule\'s task');
      },
      frames: frames => assert.ok(frames.some(frame => frame.event === 'items.upsert' && frame.data.items.some(item => item.scheduleOccurrenceKey)), 'the open tab received the delivery'),
    });
  });

  // Whether the stream's poll sees the due instant before the initiative changes state is a race: when it did, the
  // project row changed with no new revision (rhythmStatus.schedule.dueCount 0 → 1, derived from the clock; the row now
  // carries the anchors only). The gate in index-gates.test.mjs ("…a schedule coming due…") checks it deterministically.
  await t.test('due: every index event comes with a state change', () => {
    assert.ok(due, 'the due step ran');
    assert.deepEqual(describe(due.unexplained()), []);
  });

  await t.test('30 quiet minutes after the delivery: no second run, no second delivery', async () => {
    const delivery = items();
    const after = await s.idle(30 * MINUTE, { stepMs: 5 * MINUTE });
    await after.expect({
      frames: () => assert.deepEqual(describe(after.unexplained()), [], 'index events only with state changes'),
      requests: rows => assert.deepEqual(rows.filter(row => row.tag !== 'initiative').map(row => row.tag), [], 'no second run of the same occurrence'),
      state: state => assert.equal(state.projects.find(row => row.id === world.projectId).scheduleRuntime.occurrences.length, 1),
    });
    assert.equal(items(), delivery, 'and no second delivery');
  });
});
