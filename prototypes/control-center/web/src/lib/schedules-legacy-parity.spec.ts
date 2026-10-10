// @ts-nocheck -- fixtures deliberately use malformed, partial and historical record shapes.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { scheduleRows, scheduleRuleLabel, scheduleOrigin, deliveredOccurrence, matchDelivery } from './schedules'
import { evaluationSuiteHash, revisionMode } from './evaluation-revision'
import { projectActivity } from './display/activity'
import { originOf } from '@/components/timeline/Messages'
import { evolutionHash } from '../../../../../packages/sdk/src/evolution.mjs'

// Ported from the host's legacy test/project-schedules-ui.test.mjs when the legacy UI was removed.
// messageOrigin -> originOf, evaluationStandardAdoptionDisplay -> revisionMode, and
// scheduleDelivery -> the DeliveryReader composition of deliveredOccurrence + matchDelivery.
const messageOrigin = item => originOf(item)
function scheduleDelivery(state, { projectId, scheduleId, occurrenceKey }) {
  const project = state.projects.find(row => row.id === projectId)
  const occurrence = project && deliveredOccurrence(project.scheduleRuntime?.occurrences ?? [], scheduleId, occurrenceKey)
  if (!occurrence) return { available: false }
  const found = state.sessions.filter(session => session.projectId === projectId)
    .flatMap(session => matchDelivery(session.items ?? [], { projectId, scheduleId, occurrence }).map(item => ({ item, session })))
  if (found.length !== 1) return { available: false }
  return { available: true, text: found[0].item.text, sessionId: found[0].session.id, sessionArchived: Boolean(found[0].session.archivedAt) }
}
const adoption = (project, version) => {
  const mode = revisionMode(project, version)
  return { available: mode?.kind === 'adopt' && mode.available, adoptedVersionId: mode?.adoptedVersionId, message: mode?.reason ?? '' }
}
const schedule = { id: 'daily', title: '日报', destinationSessionId: 's', enabled: true, nextRunAt: '2026-10-01T01:00:00Z', rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } };
const project = () => ({ id: 'p', initiative: { enabled: true }, schedules: [structuredClone(schedule)], scheduleRuntime: { occurrences: [] } });
test('registered schedule is separate from review frequency and unknown delivery never becomes a success receipt', () => {
  const p = project(); p.initiativeRuntime = { nextReviewAt: '2026-09-26T01:00:00Z' };
  assert.equal(scheduleRows({ ...p, schedules: [] }).length, 0);
  assert.match(scheduleRows(p)[0].next, /下次执行/); assert.equal(scheduleRows(p)[0].result, '尚无执行回执');
  p.scheduleRuntime.occurrences.push({ scheduleId: 'daily', scheduledAt: '2026-09-30T01:00:00Z', status: 'delivery_pending' });
  assert.match(scheduleRows(p)[0].result, /等待投递/); assert.equal(scheduleRows(p)[0].delivered, false);
  p.scheduleRuntime.occurrences[0].deliveredAt = '2026-09-30T01:05:00Z'; assert.equal(scheduleRows(p)[0].delivered, true);
});
test('paused project, mute, per-schedule pause and missing destination retain original plan without promising execution', () => {
  for (const [change, label] of [[p => p.initiative.enabled = false, /主动协作已关闭/], [p => p.initiative.notificationMuted = true, /主动发言已暂停/], [p => p.schedules[0].enabled = false, /日程已暂停/]]) { const p = project(); change(p); assert.match(scheduleRows(p)[0].next, label); assert.match(scheduleRows(p)[0].next, /原计划/); }
  assert.match(scheduleRows(project(), { emergency: true })[0].next, /全局急停/);
  assert.match(scheduleRows(project(), { sessions: [{ id: 'other', projectId: 'p' }] })[0].next, /投递会话不可用/);
});
test('failed or uncertain occurrence stays visible and is never inferred from generated report prose', () => {
  const p = project(); p.scheduleRuntime.occurrences = [{ scheduleId: 'daily', scheduledAt: '2026-09-30T01:00:00Z', status: 'failed', errorCode: 'schedule_action_failed' }, { scheduleId: 'daily', scheduledAt: '2026-09-29T01:00:00Z', status: 'delivered' }];
  // The failure stays visible in plain words; the code itself is no longer shown (UX audit F13).
  assert.match(scheduleRows(p)[0].result, /执行失败 · /); assert.doesNotMatch(scheduleRows(p)[0].result, /schedule_action_failed/); assert.equal(scheduleRows(p)[0].delivered, false);
  p.scheduleRuntime.occurrences[0].status = 'needs_review'; assert.match(scheduleRows(p)[0].result, /待核对/);
});
test('four rule displays preserve configured zone and weekday rather than claiming a task frequency from model review', () => {
  assert.match(scheduleRuleLabel(schedule.rule), /每天 09:00.*Asia\/Shanghai/);
  assert.match(scheduleRuleLabel({ kind: 'weekly', time: '10:00', timeZone: 'UTC', days: [1, 5, 7] }), /一、五、日.*UTC/);
  assert.equal(scheduleRuleLabel({ kind: 'interval', everyMs: 300000 }), '每 5 分钟'); assert.match(scheduleRuleLabel({ kind: 'once', at: '2026-10-01T01:00:00Z' }), /仅一次/);
});
test('browser standard fingerprint matches host canonical hashing for nested suites and order changes', async () => {
  const suite = { cases: [{ id: 'x', requiredTerms: ['来源'], clock: { timeZone: 'UTC', now: '2026-09-26T00:00:00.000Z' } }], thresholds: { minimumScore: .7, improvement: .05 } };
  assert.equal(await evaluationSuiteHash(suite), evolutionHash(suite)); assert.equal(await evaluationSuiteHash({ thresholds: suite.thresholds, cases: suite.cases }), evolutionHash(suite));
});
test('scheduled result has explicit durable-origin badge only when occurrence identity exists', () => {
  const item = { kind: 'assistant', source: 'initiative', simulated: false, initiative: { kind: 'scheduled' }, scheduleOccurrenceKey: 'schedule:s:hash' };
  assert.equal(messageOrigin(item).label, '定时交付'); delete item.scheduleOccurrenceKey; assert.equal(messageOrigin(item).label, '主动分享');
  assert.equal(messageOrigin({ kind: 'assistant', text: 'Scheduled report delivered' }), null);
});
test('scheduled background action label requires matching retained occurrence identity', () => {
  const p = project(); p.initiativeRuntime = { sdkState: { actions: [{ id: 'work', action: 'work', status: 'queued', hostSchedule: { key: 'occurrence' } }] } };
  assert.equal(projectActivity(p)[0].label, '自主执行');
  p.scheduleRuntime.occurrences.push({ key: 'occurrence', scheduleId: 'daily', actionId: 'work', status: 'queued' });
  assert.equal(projectActivity(p)[0].label, '定时任务');
});

test('model-created plans expose actual provenance and only a durable receipt proves the plan was saved', () => {
  const p = project(), record = p.schedules[0];
  record.source = 'initiative'; record.initiativeProvenance = { reason: '项目还有待核验的数据，需要后续复查。' };
  assert.equal(scheduleOrigin(record).label, 'Agent 主动安排'); assert.match(scheduleRows(p)[0].origin.reason, /待核验/);
  assert.equal(scheduleOrigin({ title: 'Agent主动安排', source: 'user' }).label, '手动登记');
  p.initiativeRuntime = { sdkState: { actions: [{ id: 'planning', action: 'schedule', status: 'completed', content: '安排证据复查', resultSummary: '模型说已经安排好了' }] } };
  assert.match(projectActivity(p)[0].statusLabel, /未找到安排回执/);
  p.scheduleManagementReceipts = [{ actionId: 'planning', summary: '已保存任务；尚未执行' }];
  const activity = projectActivity(p)[0]; assert.equal(activity.label, '自主规划'); assert.equal(activity.statusLabel, '已保存任务安排'); assert.equal(activity.summary, '已保存任务；尚未执行'); assert.equal(activity.delivered, false);
});

test('standard adoption UI follows authoritative eligibility and preserves existing adoption lineage', () => {
  const v = { id: 'review', parentVersionId: 'base', state: 'rejected', evaluationRevision: { revisionHash: 'hash' }, evaluation: { gatePassed: false } }, p = { activeVersionId: 'base', versions: [v] };
  assert.equal(adoption(p, v).available, false, 'gatePassed alone does not prove a completed paired case');
  for (const gatePassed of [false, true]) assert.equal(adoption(p, { ...v, evaluation: { gatePassed }, assessment: { standardAdoption: { available: false, reason: '至少一个完整双边用例' } } }).available, false);
  assert.match(adoption(p, { ...v, assessment: { standardAdoption: { available: false, reason: '至少一个完整双边用例' } } }).message, /完整双边用例/);
  v.assessment = { standardAdoption: { available: true, reviewVersionId: 'review', revisionHash: 'hash' } };
  assert.equal(adoption(p, v).available, true);
  assert.equal(adoption(p, { ...v, assessment: { standardAdoption: { available: 'true' } } }).available, false);
  p.versions.push({ id: 'new', version: 'standard-4', standardRevision: { reviewVersionId: 'review', revisionHash: 'hash' } }); p.activeVersionId = 'new';
  const display = adoption(p, v); assert.equal(display.available, false); assert.equal(display.adoptedVersionId, 'new');
});

function deliveryFixture() {
  const project = { id: 'p', schedules: [{ ...schedule, destinationSessionId: 'new-session' }], scheduleRuntime: { occurrences: [
    { key: 'older', scheduleId: 'daily', scheduledAt: '2026-09-26T01:00:00Z', deliveredAt: '2026-09-26T01:02:00Z', deliveryItemId: 'report-old' },
    { key: 'latest', scheduleId: 'daily', scheduledAt: '2026-09-27T01:00:00Z', deliveredAt: '2026-09-27T01:02:00Z', deliveryItemId: 'report-new' },
  ] } };
  const item = (id, key, text) => ({ id, kind: 'assistant', source: 'initiative', simulated: false, initiative: { kind: 'scheduled' }, scheduleId: 'daily', scheduleOccurrenceKey: key, projectId: 'p', text });
  return { projects: [project], sessions: [
    { id: 'old-session', projectId: 'p', title: '原投递会话', items: [item('report-old', 'older', '第一天交付'), item('report-new', 'latest', '第二天交付')] },
    { id: 'new-session', projectId: 'p', title: '新投递会话', items: [{ id: 'unrelated', kind: 'assistant', text: '无关回答' }] },
  ] };
}
const deliveryIdentity = { projectId: 'p', scheduleId: 'daily', occurrenceKey: 'older' };
test('task delivery resolves the selected occurrence, not the latest answer or edited destination', () => {
  const state = deliveryFixture(), result = scheduleDelivery(state, deliveryIdentity);
  assert.equal(result.available, true); assert.equal(result.text, '第一天交付'); assert.equal(result.sessionId, 'old-session');
  assert.equal(scheduleDelivery(state, { ...deliveryIdentity, occurrenceKey: 'latest' }).text, '第二天交付');
  assert.equal(scheduleRows(state.projects[0])[0].deliveryKey, 'latest');
  state.projects[0].scheduleRuntime.occurrences.push({ key: 'failed', scheduleId: 'daily', scheduledAt: '2026-09-28T01:00:00Z', status: 'failed' });
  const row = scheduleRows(state.projects[0])[0]; assert.equal(row.delivered, false); assert.equal(row.deliveryKey, 'latest'); assert.equal(row.latestKey, 'failed');
});
test('archiving retains read-only delivery while deleting its source never falls back to another report', () => {
  const state = deliveryFixture(); state.sessions[0].archivedAt = '2026-09-27T02:00:00Z';
  assert.equal(scheduleDelivery(state, deliveryIdentity).sessionArchived, true);
  state.sessions[0].items.shift(); const missing = scheduleDelivery(state, deliveryIdentity); assert.equal(missing.available, false); assert.equal(missing.text, undefined);
});
test('delivery requires a matching retained host receipt, not a model promise or reused identity', () => {
  for (const mutate of [
    s => s.projects[0].scheduleRuntime.occurrences[0].deliveryItemId = 'report-new',
    s => delete s.projects[0].scheduleRuntime.occurrences[0].deliveredAt,
    s => s.sessions[0].items[0].scheduleId = 'other',
    s => s.sessions[0].items[0].projectId = 'other',
    s => s.sessions[0].projectId = 'other',
    s => s.projects[0].scheduleRuntime.occurrences.push({ ...s.projects[0].scheduleRuntime.occurrences[0] }),
    s => s.sessions[0].items.push({ ...s.sessions[0].items[0] }),
  ]) { const state = deliveryFixture(); mutate(state); assert.equal(scheduleDelivery(state, deliveryIdentity).available, false); }
  const state = deliveryFixture(); delete state.projects[0].scheduleRuntime.occurrences[0].deliveryItemId;
  assert.equal(scheduleDelivery(state, deliveryIdentity).text, '第一天交付', 'exact unique occurrence association remains valid before optional item ID was persisted');
});
test('source revocation and non-delivery items never remain readable after state refresh', () => {
  for (const mutation of [{ sourceDeleted: true }, { contextRevoked: true }, { deletedAt: '2026-09-27' }, { simulated: true }, { streaming: true }, { kind: 'tool' }, { source: 'conversation' }, { initiative: { kind: 'insight' } }]) {
    const state = deliveryFixture(); assert.equal(scheduleDelivery(state, deliveryIdentity).available, true);
    Object.assign(state.sessions[0].items[0], mutation); const result = scheduleDelivery(state, deliveryIdentity); assert.equal(result.available, false); assert.equal(result.text, undefined);
  }
});

