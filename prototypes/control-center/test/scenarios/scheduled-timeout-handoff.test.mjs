// D4 scenario (W1, token-burn study 2026-10-05): a scheduled run the action deadline stops. The 30-minute deadline
// recorded its cause as "the project context changed or a stop instruction arrived" in the job's handoff and output (two
// real jobs on the novel project, 2026-10-02), and the next decision read that as the reason. Now the handoff names the
// limit (the minutes come from the deadline in force), what stays and what to do next; the job's status and error code are
// what they were.
// Crosses the schedule service and its occurrence, the initiative's tick and its action deadline (the SDK's own timer),
// the worker (its model request still running at the deadline), the job record and the decision request. The deadline is
// set short (the controller's actionTimeoutMs, the SDK policy's actionTimeoutMs: 2 s) and the worker's model request
// outlasts it; only the model, JEV and the clock are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';

const MINUTE = 60000, FALSE_REASON = /项目上下文变化或收到停止指令|收到新的项目上下文或暂停指令|context changed|stop instruction/;

async function dueSchedule(t, { language } = {}) {
  // 2026-10-05T01:00Z is 09:00 in Shanghai; the schedule is due at 10:00 there.
  const world = await createWorld(t, { initiative: true, git: false, start: '2026-10-05T01:00:00.000Z', files: { 'evidence.txt': 'Measured result: seven verified sources.\n' } });
  if (language) world.store.mutate(state => { state.settings.interfaceLanguage = language; });
  const controller = world.app.projectInitiative;
  controller.actionTimeoutMs = 2000; for (const context of controller.contexts.values()) context.coordinator.policy.actionTimeoutMs = 2000;
  const created = await world.post(`/api/projects/${world.projectId}/schedules`, { requestId: 'daily-report', title: 'Daily report', task: 'Read evidence.txt and report the measured result.', destinationSessionId: world.sessionId, rule: { kind: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' } });
  assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 300));
  const s = scenario(world);
  await s.advanceClock(1000, { settleMs: 1500, label: 'the initiative reviews the new schedule' });
  // The occurrence's worker: its first model request outlasts the deadline.
  world.faux.script('background-work', { delayMs: 15000, text: 'The measured result is seven verified sources.\nHandoff: reported it.' });
  const scheduled = () => world.project().jobs.find(job => job.id.startsWith('schedule-work-') && job.completedAt);
  await s.advanceClock(65 * MINUTE, { label: 'the schedule comes due', until: scheduled });
  return { world, s, job: scheduled() };
}

test('a scheduled run the deadline stopped says so: the limit in its handoff and output, the status and error code unchanged', async t => {
  const { world, s, job } = await dueSchedule(t);
  assert.equal(job.status, 'cancelled'); assert.equal(job.errorCode, 'action_timeout'); assert.equal(job.failure.code, 'action_timeout');
  assert.match(job.handoff, /^已到 2 秒时限被停止：.+；时限前完成的操作保留，不会自动重跑；下一步把剩余部分拆小再做。$/);
  assert.equal(job.output, '这项后台工作到 2 秒时限被停止；时限前完成的操作和结果保留，不会自动重跑。');
  assert.doesNotMatch(job.handoff + job.output, FALSE_REASON);
  // The deadline's own record is untouched: the action row says why, as before.
  assert.equal(world.project().initiativeRuntime.sdkState.actions.find(action => action.id === job.id)?.errorCode, 'action_timeout');

  // No decision request carries the old reason. (Whether the action row also carries the handoff depends on whether the
  // worker's failure reached the coordinator before it recorded the deadline; work-deadline-handoff.test.mjs holds that
  // channel. The row's failure always says the deadline: "Host action deadline exceeded".)
  const action = world.project().initiativeRuntime.sdkState.actions.find(row => row.id === job.id);
  assert.ok(action.handoff === undefined || action.handoff === job.handoff, 'a handoff on the action row is this one');
  await s.idle(10 * MINUTE, { stepMs: 5 * MINUTE, settleMs: 150 });
  for (const row of world.faux.of('initiative')) assert.doesNotMatch(row.wire, FALSE_REASON, 'no decision reads the old reason');
  assert.ok(world.faux.of('initiative').length >= 2, 'decisions ran after the schedule was created and after the run');
});

test('in English the same run says the limit in English', async t => {
  const { job } = await dueSchedule(t, { language: 'en' });
  assert.equal(job.status, 'cancelled'); assert.equal(job.errorCode, 'action_timeout');
  assert.match(job.handoff, /^Stopped at the 2-second limit: .+; what was done before the limit stays and is not rerun; next, split the remainder into smaller steps\.$/);
  assert.equal(job.output, 'This background work was stopped at the 2-second limit; what it completed before then is kept and is not rerun.');
});
