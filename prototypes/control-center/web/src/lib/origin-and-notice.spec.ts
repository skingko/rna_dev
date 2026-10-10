// @ts-nocheck -- fixtures deliberately use partial and historical record shapes.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { originOf } from '@/components/timeline/Messages'
import { webToolNotice } from './tools'

// Ported from the host's legacy test/conversation-display.test.mjs (messageOrigin) and
// test/web-tool-display.test.mjs (webToolNotice) when the legacy UI was removed.
test('proactive share and evolution labels require recorded initiative source, not matching prose', () => {
  assert.equal(originOf({ kind: 'assistant', text: '我主动研究并完成了项目进化', versionId: 'v' }), null);
  assert.equal(originOf({ kind: 'assistant', source: 'initiative', initiative: { kind: 'insight' } }).label, '主动分享');
  assert.equal(originOf({ kind: 'assistant', source: 'initiative', initiative: { kind: 'version_ready' } }).label, '版本建议');
});
test('revoked origins are not restyled as current proactive messages', () => {
  for (const item of [{ kind: 'assistant', source: 'initiative', contextRevoked: true }, { kind: 'assistant', source: 'initiative', sourceDeleted: true }]) assert.equal(originOf(item), null);
});
test('durable web_search notice shows fixed copy for the host receipt only', () => {
  assert.match(webToolNotice({ name: 'web_search', status: 'succeeded', output: 'x'.repeat(64000), notice: { kind: 'web_time_filter_not_applied' } }), /未按时间筛选.*核对发布日期/);
  for (const tool of [{ name: 'web_search', status: 'failed', notice: { kind: 'web_time_filter_not_applied' } }, { name: 'web_fetch', status: 'succeeded', notice: { kind: 'web_time_filter_not_applied' } }, { name: 'web_search', status: 'succeeded', notice: { kind: 'other' } }]) assert.equal(webToolNotice(tool), null);
});
test('historical complete receipts show fixed copy but arbitrary snippet prose and malformed output cannot impersonate metadata', () => {
  const tool = output => ({ name: 'web_search', status: 'succeeded', output });
  const value = { ok: true, provider: 'fastcrw', operation: 'search', filterApplied: false, filterStatus: 'not_applied', notice: 'PRIVATE_PROVIDER_DETAIL', results: [] };
  assert.match(webToolNotice(tool(JSON.stringify(value))), /时间筛选暂不可用/);
  for (const output of ['PRIVATE_PROVIDER_DETAIL filterApplied:false', JSON.stringify({ ok: true, results: [value] }), JSON.stringify({ ...value, ok: false }), '{', 'x'.repeat(64001)]) assert.equal(webToolNotice(tool(output)), null);
  assert.equal(webToolNotice({ ...tool(JSON.stringify(value)), status: 'running' }), null); assert.equal(webToolNotice({ ...tool(JSON.stringify(value)), name: 'web_fetch' }), null);
});

test('the line a scheduled run posts while it works is badged as the user\'s scheduled task, not as an unprompted share', () => {
  const base = { id: 'w', kind: 'assistant', text: '后台开始做：定时任务「每日 AI 日报」', source: 'initiative', createdAt: '2026-10-03T01:00:00.000Z' } as any
  assert.equal(originOf({ ...base, initiative: { kind: 'insight', scheduledWork: true, backgroundWork: { actionId: 'a', status: 'running' } } })?.label, '定时任务')
  assert.equal(originOf({ ...base, initiative: { kind: 'insight', backgroundWork: { actionId: 'a', status: 'running' } } })?.label, '主动分享')
  // Its tooltip follows the run: under way, then what it did.
  assert.match(originOf({ ...base, initiative: { kind: 'insight', scheduledWork: true, backgroundWork: { actionId: 'a', status: 'running' } } })!.description, /正在后台运行/)
  assert.match(originOf({ ...base, initiative: { kind: 'insight', scheduledWork: true, backgroundWork: { actionId: 'a', status: 'done' } } })!.description, /这次在后台做的工作/)
})

