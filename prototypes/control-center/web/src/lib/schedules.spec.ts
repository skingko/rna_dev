import { describe, expect, it } from 'vitest'
import type { Item } from '@/api/types'
import { PAUSED_LABELS, matchDelivery, occurrenceLabel, scheduleRows, scheduleRuleLabel } from './schedules'
import { deliveryStages } from './background-runs'
import { actionReason } from './task-failure'
import { REACH_REASONS } from './communication'

describe('schedule projections', () => {
  it('names the mute as the settings toggle does (暂停主动发言) wherever it is the reason, and says where a paused schedule\'s result went (F9)', () => {
    expect(PAUSED_LABELS.notifications_muted).toBe('主动发言已暂停')
    expect(actionReason('notification_muted', 'deferred')).toBe('主动发言已暂停')
    expect(REACH_REASONS.notification_muted).toBe('主动发言已暂停，定时任务的结果只放进收件箱')
  })
  it('says what happened to a window while proactive messages were paused (F9), never the code', () => {
    expect(occurrenceLabel({ status: 'skipped', errorCode: 'notifications_muted' })).toBe('暂停主动发言期间到点，已跳过')
    expect(occurrenceLabel({ status: 'skipped', errorCode: 'window_passed' })).toBe('没赶在下一次之前开始，已跳过')
    expect(occurrenceLabel({ status: 'skipped', errorCode: 'future_code' })).toBe('已跳过')
    expect(occurrenceLabel({ status: 'expired', errorCode: 'delivery_expired' })).toBe('没能按时送达，结果已放入收件箱')
    expect(occurrenceLabel({ status: 'delivered', deliveredAt: '2026-10-05T01:00:00Z', deliveryItemId: null })).toBe('已放入收件箱')
    expect(occurrenceLabel({ status: 'delivered', deliveredAt: '2026-10-05T01:00:00Z', deliveryItemId: 'm1' })).toBe('已送达会话')
    expect(occurrenceLabel({ status: 'delivered', deliveredAt: '2026-10-05T01:00:00Z' })).toBe('已送达会话')
    expect(occurrenceLabel({ status: 'failed', errorCode: 'provider_timeout' })).toMatch(/^执行失败 · /)
    const rows = scheduleRows({ schedules: [{ id: 'daily', title: 'D', task: 'T', enabled: true, rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' }, destinationSessionId: 's', nextRunAt: null } as never], scheduleRuntime: { occurrences: [
      { key: 'inbox-only', scheduleId: 'daily', scheduledAt: '2026-10-05T09:00:00Z', status: 'delivered', deliveredAt: '2026-10-05T09:30:00Z', deliveryItemId: null },
      { key: 'in-chat', scheduleId: 'daily', scheduledAt: '2026-10-04T09:00:00Z', status: 'delivered', deliveredAt: '2026-10-04T09:30:00Z', deliveryItemId: 'm1' }] } })
    expect(rows[0].deliveryKey).toBe('in-chat')
    expect(deliveryStages({ status: 'skipped' }, 'scheduled')).toEqual({ run: 'stopped', deliver: 'pending' })
    expect(deliveryStages({ status: 'expired' }, 'scheduled')).toEqual({ run: 'done', deliver: 'stopped' })
  })
  it('labels rules like the legacy UI', () => {
    expect(scheduleRuleLabel({ kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' })).toBe('每天 09:00 · Asia/Shanghai')
    expect(scheduleRuleLabel({ kind: 'weekly', days: [1, 3], time: '10:30', timeZone: 'UTC' })).toBe('每周 一、三 10:30 · UTC')
    expect(scheduleRuleLabel({ kind: 'interval', everyMs: 30 * 60000 })).toBe('每 30 分钟')
  })
  it('derives pause reasons and the latest delivered occurrence', () => {
    const project = {
      initiative: { enabled: true },
      schedules: [{ id: 'a', title: 'A', task: 't', enabled: true, rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' }, destinationSessionId: 's1' }],
      scheduleRuntime: { occurrences: [
        { key: 'k2', scheduleId: 'a', scheduledAt: '2026-09-28T01:00:00Z', status: 'failed', errorCode: 'timeout' },
        { key: 'k1', scheduleId: 'a', scheduledAt: '2026-09-27T01:00:00Z', status: 'delivered', deliveredAt: '2026-09-27T01:02:00Z' },
      ] },
    }
    const [row] = scheduleRows(project, { sessions: [{ id: 's1', title: '项目讨论', projectId: 'p' }], projectId: 'p' })
    expect(row.paused).toBeNull()
    expect(row.destination).toBe('项目讨论')
    expect(row.latestKey).toBe('k2')
    expect(row.deliveryKey).toBe('k1')
    // How the run stopped, in plain words; the code stays in the diagnostics (UX audit F13).
    expect(row.result).toContain('执行失败 · 模型服务这次没有及时响应，工作没做完。')
    expect(row.result).not.toContain('timeout')
    expect(scheduleRows(project, { emergency: true })[0].paused).toBe('emergency')
    expect(scheduleRows(project, { sessions: [{ id: 'other', projectId: 'p' }], projectId: 'p' })[0].paused).toBe('destination_unavailable')
  })
  it('matches exactly the retained scheduled delivery', () => {
    const base = { kind: 'assistant', source: 'initiative', initiative: { kind: 'scheduled' }, scheduleOccurrenceKey: 'k1', createdAt: '', text: '报告' }
    const items = [
      { ...base, id: 'd1', scheduleId: 'a', projectId: 'p' },
      { ...base, id: 'd2', scheduleId: 'a', projectId: 'p', streaming: true },
      { ...base, id: 'd3', scheduleId: 'b', projectId: 'p' },
    ] as unknown as Item[]
    expect(matchDelivery(items, { projectId: 'p', scheduleId: 'a', occurrence: { key: 'k1', scheduleId: 'a', scheduledAt: '', status: 'delivered', deliveredAt: 'x' } }).map(i => i.id)).toEqual(['d1'])
  })
})
