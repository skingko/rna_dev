/**
 * Schedule projections, ported 1:1 from public/project-schedules-ui.js
 * (scheduleOrigin / scheduleRuleLabel / scheduleRows / delivery matching).
 */
import type { Item } from '@/api/types'
import type { Occurrence, Schedule, ScheduleRule } from '@/api/project-api'
import { t, localized, intlTag } from '@/i18n'
import { failureSentence } from './task-failure'

const time = (value?: string | null) => (value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(intlTag(), { hour12: false }) : t('未安排'))
const bounded = (value: unknown, max = 500) => (typeof value === 'string' ? value.slice(0, max) : '')
export const WEEKDAYS = localized(['一', '二', '三', '四', '五', '六', '日'])

export const PAUSED_LABELS: Record<string, string> = localized({ emergency: '全局急停', project_archived: '项目已归档', initiative_disabled: '项目主动协作已关闭', notifications_muted: '主动发言已暂停', schedule_disabled: '此日程已暂停', destination_unavailable: '投递会话不可用' })
export const OCCURRENCE_LABELS: Record<string, string> = localized({ queued: '已登记 · 等待执行', running: '正在执行', delivered: '已送达会话', failed: '执行失败', cancelled: '已取消', needs_review: '执行结果待核对', delivery_pending: '执行结束 · 等待投递', skipped: '已跳过', expired: '没能按时送达，结果已放入收件箱' })
/** Why a window was skipped (F9): it came due while proactive messages were paused, or it could not start before the next one. */
export const SKIP_LABELS: Record<string, string> = localized({ notifications_muted: '暂停主动发言期间到点，已跳过', window_passed: '没赶在下一次之前开始，已跳过' })

export function scheduleOrigin(schedule: Partial<Schedule> = {}) {
  const label = schedule.source === 'initiative' ? t('Agent 主动安排') : schedule.source === 'model-project-initialization' ? t('Agent 初始化安排') : schedule.source === 'conversation' ? t('对话中安排') : t('手动登记')
  return { label, reason: bounded(schedule.initiativeProvenance?.reason, 800), edited: schedule.userEditedAt ? t('用户调整于 {v}', { v: time(schedule.userEditedAt) }) : null }
}

export function scheduleRuleLabel(rule: Partial<ScheduleRule> = {}) {
  if (rule.kind === 'daily') return t('每天 {v} · {v2}', { v: bounded(rule.time, 5), v2: bounded(rule.timeZone, 100) })
  if (rule.kind === 'weekly') return t('每周 {v} {v2} · {v3}', { v: (rule.days ?? []).map(day => WEEKDAYS[day - 1]).filter(Boolean).join(t('、')), v2: bounded(rule.time, 5), v3: bounded(rule.timeZone, 100) })
  if (rule.kind === 'interval') return t('每 {v} 分钟', { v: Number.isSafeInteger(rule.everyMs) ? rule.everyMs! / 60000 : t('未知') })
  if (rule.kind === 'once') return t('仅一次 · {v}', { v: time(rule.at) })
  return t('日程规则未记录')
}

export interface ScheduleProjectLike {
  archivedAt?: string | null
  initiative?: { enabled?: boolean; notificationMuted?: boolean }
  schedules?: Schedule[]
  scheduleRuntime?: { occurrences?: Occurrence[] }
}
export interface SessionLike { id: string; title?: string; projectId?: string | null; archivedAt?: string | null }

export interface ScheduleRow {
  id: string; title: string; task: string; destination: string; rule: string; paused: string | null
  origin: ReturnType<typeof scheduleOrigin>; next: string; result: string; delivered: boolean
  deliveryKey: string | null; latestKey: string | null; lastStatus: string | null; history: Occurrence[]; record: Schedule
}

const byTimeDesc = (a: Occurrence, b: Occurrence) => Date.parse(b.scheduledAt) - Date.parse(a.scheduledAt)

export function scheduleRows(project: ScheduleProjectLike, { occurrences = project.scheduleRuntime?.occurrences ?? [], emergency = false, sessions = [], projectId }: { occurrences?: Occurrence[]; emergency?: boolean; sessions?: SessionLike[]; projectId?: string } = {}): ScheduleRow[] {
  return (project.schedules ?? []).map(schedule => {
    const paused = schedule.pausedReason ?? (emergency ? 'emergency'
      : project.archivedAt ? 'project_archived'
        : project.initiative?.enabled === false ? 'initiative_disabled'
          : project.initiative?.notificationMuted ? 'notifications_muted'
            : schedule.enabled === false ? 'schedule_disabled'
              : sessions.length && !sessions.some(row => row.id === schedule.destinationSessionId && (!projectId || row.projectId === projectId) && !row.archivedAt) ? 'destination_unavailable' : null)
    const history = occurrences.filter(row => row.scheduleId === schedule.id).sort(byTimeDesc)
    const latest = history[0]
    return {
      id: schedule.id, title: bounded(schedule.title, 160), task: bounded(schedule.task, 6000),
      destination: sessions.find(row => row.id === schedule.destinationSessionId)?.title ?? t('项目会话'),
      rule: scheduleRuleLabel(schedule.rule), paused, origin: scheduleOrigin(schedule),
      next: paused ? t('已暂停：{v}{v2}', { v: PAUSED_LABELS[paused] ?? bounded(paused, 100), v2: schedule.nextRunAt ? t('；原计划 {v}', { v: time(schedule.nextRunAt) }) : '' }) : schedule.nextRunAt ? t('下次执行：{v}', { v: time(schedule.nextRunAt) }) : t('暂无下一次执行'),
      result: latest ? `${time(latest.scheduledAt)} · ${occurrenceLabel(latest)}` : t('尚无执行回执'),
      delivered: Boolean(latest?.deliveredAt),
      // A delivery filed only in the inbox (deliveryItemId null) has no conversation message to open.
      deliveryKey: history.find(row => row.deliveredAt && row.key && row.deliveryItemId !== null)?.key ?? null,
      latestKey: latest?.key ?? null, lastStatus: latest?.status ?? null, history, record: schedule,
    }
  })
}

/** One schedule run in words: its state, and how it stopped in plain words (never the error code or an unknown status). */
export function occurrenceLabel(item: Pick<Occurrence, 'status' | 'deliveredAt' | 'errorCode' | 'deliveryItemId'>) {
  // A delivery the host filed in the inbox (quietly while paused, the conversation busy) has no conversation message.
  if (item.deliveredAt) return item.deliveryItemId === null ? t('已放入收件箱') : t('已送达会话')
  if (item.status === 'skipped') return (item.errorCode && SKIP_LABELS[item.errorCode]) || OCCURRENCE_LABELS.skipped
  if (item.status === 'expired') return OCCURRENCE_LABELS.expired
  const state = OCCURRENCE_LABELS[item.status] ?? t('状态未知')
  return item.errorCode ? `${state} · ${failureSentence(item.errorCode, item.status)}` : state
}

/** The single delivered, retained occurrence a delivery link points at, or null. */
export function deliveredOccurrence(occurrences: Occurrence[], scheduleId: string, occurrenceKey: string): Occurrence | null {
  const matches = occurrences.filter(row => row.key === occurrenceKey && row.scheduleId === scheduleId)
  const occurrence = matches[0]
  return matches.length === 1 && occurrence.deliveredAt && !occurrence.sourceDeleted && !occurrence.contextRevoked ? occurrence : null
}

/**
 * The durable delivery item for one occurrence (legacy scheduleDelivery):
 * exactly one retained, finished, scheduled initiative message.
 */
export function matchDelivery(items: Item[], { projectId, scheduleId, occurrence }: { projectId: string; scheduleId: string; occurrence: Occurrence }): Item[] {
  return items.filter(raw => {
    const item = raw as Item & { scheduleId?: string; projectId?: string; sourceDeleted?: boolean; contextRevoked?: boolean; deletedAt?: string }
    if (item.scheduleOccurrenceKey !== occurrence.key || item.scheduleId !== scheduleId) return false
    if (item.projectId !== projectId) return false
    if (item.kind !== 'assistant' || item.source !== 'initiative' || item.initiative?.kind !== 'scheduled') return false
    if (item.sourceDeleted || item.contextRevoked || item.deletedAt || item.simulated === true || item.streaming) return false
    if (occurrence.deliveryItemId && item.id !== occurrence.deliveryItemId) return false
    return typeof item.text === 'string' && item.text.trim().length > 0
  })
}
