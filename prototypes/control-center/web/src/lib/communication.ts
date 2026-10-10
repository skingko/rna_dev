/**
 * Display projections for P3 proactive communication: reach tiers, inbox
 * entries, reaction outcomes, daily digests and notification click routing.
 * Pure (no DOM / store access) so they are unit tested.
 */
import type { DeliveryFeedback, InboxEntry } from '@/api/communication-api'
import { t as tr, localized, intlTag } from '@/i18n'

export const TIER_LABELS: Record<string, string> = localized({ inline: '对话内', inbox: '安静送达', notify: '桌面通知', digest: '每日摘要' })
/** Short phrase for the subtle tier hint beside a proactive message. */
export const TIER_HINTS: Record<string, string> = localized({ inline: '', inbox: '已放入收件箱', notify: '已发桌面通知', digest: '每日摘要' })
const TIER_RANK: Record<string, number> = { digest: 0, inbox: 1, inline: 2, notify: 3 }
/** Every reach reason the host records (proactive-delivery capReach, the initiative controller); a spec keeps them in step. */
export const REACH_REASONS: Record<string, string> = localized({
  desktop_notifications_off: '项目未开启桌面通知',
  ask_in_conversation: '提问始终在对话中出现',
  jev_lowered: '判断模型选择了更安静的方式',
  narrator_pacing: '当时不适合打断你，先放进收件箱',
  welcome_back_overflow: '你回来时消息较多，其余放进收件箱',
  direct_handle: '已直接修正，在对话中等你确认',
  // F9: a scheduled run already started when proactive messages were paused, and a result that waited a whole period.
  notification_muted: '主动发言已暂停，定时任务的结果只放进收件箱',
  schedule_expired: '定时任务的结果等了一整个周期没能送到对话，只放在收件箱',
})
export const OUTCOME_LABELS: Record<string, string> = localized({ replied: '已回复', acted: '已采纳', dismissed: '已忽略', ignored: '无反应' })
export const OUTCOME_TONES: Record<string, 'success' | 'accent' | 'muted' | 'warning'> = { replied: 'accent', acted: 'success', dismissed: 'muted', ignored: 'warning' }

export const tierLabel = (tier?: string | null) => (tier ? TIER_LABELS[tier] ?? tier : '')

export interface EntryDisplay {
  kindLabel: string
  tierLabel: string
  status: 'unread' | 'read' | 'dismissed'
  statusLabel: string
  outcomeLabel: string | null
  outcomeTone: 'success' | 'accent' | 'muted' | 'warning' | null
  /** “请求桌面通知 · 实际对话内 · 原因” when the host or JEV lowered the tier (unlabelled codes are left out, never shown raw). */
  lowered: string | null
  /** Digest bookkeeping: waiting for / merged into the daily digest. */
  digest: string | null
  withdrawn: boolean
  canAct: boolean
}

const clock = (value?: string) => {
  const t = Date.parse(value ?? '')
  return Number.isFinite(t) ? new Date(t).toLocaleString(intlTag(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : ''
}

export function entryDisplay(entry: InboxEntry): EntryDisplay {
  const status = entry.status === 'dismissed' ? 'dismissed' : entry.status === 'read' ? 'read' : 'unread'
  const requested = entry.requestedTier ?? null
  const lowered = requested && requested !== entry.tier && (TIER_RANK[requested] ?? -1) > (TIER_RANK[entry.tier] ?? -1)
    ? [tr('请求{v}', { v: tierLabel(requested) }), tr('实际{v}', { v: tierLabel(entry.tier) }), ...(entry.reachReasons ?? []).flatMap(r => REACH_REASONS[r] ?? [])].join(' · ')
    : null
  const digest = entry.tier !== 'digest' ? null
    : entry.digestedAt ? tr('已并入 {v} 的每日摘要', { v: clock(entry.digestedAt) })
      : entry.heldForDigest ? tr('等待并入{v}每日摘要', { v: entry.digestAt ? tr(' {v} 的', { v: clock(entry.digestAt) }) : tr('下一次') }) : null
  const outcome = entry.feedback?.outcome ?? null
  return {
    kindLabel: entry.kind === 'ask' ? tr('主动提问') : entry.scheduled ? tr('定时交付') : tr('主动分享'),
    tierLabel: tierLabel(entry.tier),
    status,
    statusLabel: ({ unread: tr('未读'), read: tr('已读'), dismissed: tr('已忽略') } as const)[status],
    outcomeLabel: outcome ? OUTCOME_LABELS[outcome] ?? outcome : status === 'dismissed' ? null : tr('等待反应'),
    outcomeTone: outcome ? OUTCOME_TONES[outcome] ?? 'muted' : null,
    lowered,
    digest,
    withdrawn: Boolean(entry.contextRevoked || entry.sourceDeleted),
    canAct: status !== 'dismissed' && !entry.actedAt && outcome !== 'acted',
  }
}

/** The header the host writes in front of a digest, in either interface language: “今日摘要（N 条）：” / “Today's digest (N items):”, count optional. */
const DIGEST_HEADER = /^\s*(?:今日摘要(?:（\d+\s*条）)?[:：]|Today['’]s digest(?:\s*\(\d+\s*items?\))?:)\s*/i

/**
 * One daily digest (host `composeDigest`). New rows carry `initiative.lines` (the first line of each entry, in order) and these win
 * when they are a non-empty string array. Older rows only have `text`: “今日摘要（N 条）：\n1. …” / “今日摘要：…”, or the same in English.
 */
export function digestDisplay(text: string, entryIds: string[] = [], structured?: readonly unknown[] | null): { count: number; lines: string[] } {
  const given = Array.isArray(structured) && structured.every((line): line is string => typeof line === 'string') ? structured.map(line => line.trim()) : []
  if (given.some(Boolean)) return { count: Math.max(entryIds.length, given.length), lines: given }
  const body = String(text ?? '').replace(DIGEST_HEADER, '')
  const numbered = body.split('\n').map(line => line.trim()).filter(Boolean)
  const lines = numbered.length > 1 || /^\d+\.\s/.test(numbered[0] ?? '') ? numbered.map(line => line.replace(/^\d+\.\s*/, '')) : [body.trim()].filter(Boolean)
  return { count: Math.max(entryIds.length, lines.length), lines }
}

export const formatRate = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) ? '—' : `${Math.round(value * 100)}%`)

export function feedbackSummary(feedback: DeliveryFeedback) {
  const { counts } = feedback
  return {
    useful: formatRate(feedback.usefulShareRate),
    dismiss: formatRate(feedback.dismissRate),
    ignore: formatRate(feedback.ignoreRate),
    delivered: counts.delivered,
    pending: counts.pending,
    sample: feedback.settled ? tr('{settled} 条已判定', { settled: feedback.settled }) : tr('尚无已判定样本'),
    tiers: (['inline', 'inbox', 'notify', 'digest'] as const).map(tier => ({ tier, label: TIER_LABELS[tier], count: feedback.byTier?.[tier] ?? 0 })),
  }
}

/** Where a clicked desktop notification should land. */
export function notificationRoute(target: { projectId?: string | null; sessionId?: string | null; entryId?: string | null }, known: { projects: Record<string, unknown>; sessions: Record<string, { projectId?: string | null; archivedAt?: string | null } | undefined> }) {
  const session = target.sessionId ? known.sessions[target.sessionId] : undefined
  const projectId = target.projectId && known.projects[target.projectId] ? target.projectId : session?.projectId ?? null
  if (session && !session.archivedAt) return { kind: 'session' as const, sessionId: target.sessionId!, projectId, entryId: target.entryId ?? null }
  if (projectId) return { kind: 'inbox' as const, sessionId: null, projectId, entryId: target.entryId ?? null }
  return null
}
