import test from 'node:test';
import assert from 'node:assert/strict';
import { initialScheduleIntent } from '../project-schedule-intent.mjs';

const proposal = (requestEvidence, kind = 'daily') => ({ requestEvidence, rule: { kind } });
test('initial schedule checks the full user requirement, preserving negative exceptions and cadence changes', () => {
  assert.equal(initialScheduleIntent(proposal('每天推送'), { description: '仅本次，不要每天推送' }).allowed, false);
  assert.equal(initialScheduleIntent(proposal('每天报告'), { description: '每天报告，不要虚构事实' }).allowed, true);
  assert.equal(initialScheduleIntent(proposal('每日'), { description: '不要每日，改为每周' }).allowed, false);
  assert.equal(initialScheduleIntent(proposal('每周', 'weekly'), { description: '不要每日，改为每周' }).allowed, true);
  assert.equal(initialScheduleIntent(proposal('daily'), { description: 'Please do not schedule daily reports; this is one-time only.' }).allowed, false);
  assert.equal(initialScheduleIntent(proposal('明天提醒一次', 'once'), { description: '明天提醒一次，仅本次，不要重复任务。' }).allowed, true);
  assert.equal(initialScheduleIntent(proposal('每日研究'), { description: '每日研究', userMessages: [{ id: 'later', text: '仅本次，不要每天推送。' }] }).allowed, false);
  for (const suffix of ['Do not schedule.', 'Do not schedule!', 'Do not schedule anything.']) assert.equal(initialScheduleIntent(proposal('每天报告'), { description: `每天报告。${suffix}` }).allowed, false);
  assert.equal(initialScheduleIntent(proposal('每天报告'), { description: '一次性研究', userMessages: [] }).code, 'schedule_user_source_missing');
  const source = initialScheduleIntent(proposal('每天报告'), { description: '每天报告，不要虚构事实' });
  assert.match(source.sourceHash, /^[a-f0-9]{64}$/); assert.equal(source.sourceExcerpt, '每天报告，不要虚构事实');
  assert.equal(source.interpretation, 'model_proposed_user_requirement');
});
