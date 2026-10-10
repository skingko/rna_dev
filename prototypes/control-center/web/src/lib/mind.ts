/**
 * Display projections for the Project Mind (Rna 学到的): lesson grouping and
 * state, commitment urgency, agenda grouping, thread continuity, inbox
 * grouping by thread and the sidebar's "needs you" hints. Pure (no store or
 * DOM access) so it is unit tested.
 */
import type { AgendaItem, Commitment, Lesson, MindCounts, MindHealth, MindThread, ProjectMind } from '@/api/mind-api'
import { intlTag, localized, t as tr } from '@/i18n'
import type { Item, PresentedFile } from '@/api/types'
import type { PacingRecord } from '@/api/communication-api'

export const LESSON_KINDS: { kind: string; label: string; hint: string }[] = localized([
  { kind: 'preference', label: '偏好', hint: '你明确表达过的做法与口味' },
  { kind: 'constraint', label: '约束', hint: '必须遵守的边界' },
  { kind: 'pitfall', label: '易错点', hint: '曾经出错、下次要先检查的地方' },
  { kind: 'success_habit', label: '成功习惯', hint: '被认可的交付里值得保留的做法' },
])
export const AGENDA_KINDS: { kind: string; label: string }[] = localized([
  { kind: 'awaiting_user', label: '等你回应' },
  { kind: 'todo', label: '待办' },
  { kind: 'open_loop', label: '未闭环' },
  { kind: 'intention', label: '打算' },
  { kind: 'idea', label: '想法' },
])
export const COMMITMENT_TRIGGERS: Record<string, string> = localized({ user_request: '你提出的请求', agent_promise: 'Rna 说过会做', failed_turn: '失败后待补' })
export const SOURCE_KINDS: Record<string, string> = localized({
  correction: '来自你的纠正', preference: '来自你的明确偏好', explicit_preference: '来自你的明确偏好', failure_review: '来自失败复盘',
  accepted_delivery: '来自被认可的交付', feedback: '来自 👍/👎 反馈', user: '你手动添加', conversation: '来自项目对话', jev: '来自对话信号',
  migration: '来自项目初始化', steering: '来自你的改进要求', approval: '来自你的认可', capture: '来自对话信号',
})
/** Every `paused(...)` code of the host's learningHealth (project-mind.mjs); a spec keeps them in step. */
export const PAUSE_REASONS: Record<string, string> = localized({
  privacy_revoked: '有会话被删除，相关证据已撤回',
  session_deletion_pending: '有会话正在删除，相关证据清理完成前暂停',
  model_unavailable: '模型不可用',
  budget_exhausted: '学习预算已用完',
  disabled: '已在设置中关闭',
  emergency: '全局急停中',
  emergency_stop: '全局急停中',
  maintenance: '维护中',
  evolution_disabled: '自主进化已由用户关闭',
  initiative_disabled: '项目主动协作已由用户关闭',
  evolution_lanes_off: '后台进化未启动',
  learning_controller_off: '后台进化未启动',
  project_not_ready: '项目尚未初始化完成',
  project_archived: '项目已归档',
  interactive_subscription_only: '当前模型只支持交互式使用',
})

const ts = (value?: string | null) => (value ? Date.parse(value) : NaN)

/** `held`: a rule Rna concluded that would replace one the user set; it waits for the user's answer and is not used. */
export type LessonState = 'active' | 'held' | 'expired' | 'superseded' | 'retired'
export function lessonState(lesson: Pick<Lesson, 'status' | 'until'>, now = Date.now()): LessonState {
  if (lesson.status === 'held') return 'held'
  if (lesson.status === 'superseded') return 'superseded'
  if (lesson.status === 'retired') return 'retired'
  const until = ts(lesson.until)
  return Number.isFinite(until) && until <= now ? 'expired' : 'active'
}

export interface LessonGroup { kind: string; label: string; hint: string; lessons: Lesson[] }
/** Lessons by kind in a fixed order (unknown kinds last); most-used first within a kind. */
export function lessonGroups(lessons: Lesson[], { inactive = false, now = Date.now() }: { inactive?: boolean; now?: number } = {}): LessonGroup[] {
  const visible = lessons.filter(l => inactive || lessonState(l, now) === 'active')
  const known = LESSON_KINDS.map(k => k.kind)
  const extra = [...new Set(visible.map(l => l.kind).filter(k => !known.includes(k)))]
  const score = (l: Lesson) => (lessonState(l, now) === 'active' ? 1e9 : 0) + (l.uses?.applied ?? 0) * 1000 + (l.uses?.recalled ?? 0) + ts(l.updatedAt ?? l.createdAt) / 1e13
  return [...LESSON_KINDS, ...extra.map(kind => ({ kind, label: kind, hint: '' }))]
    .map(k => ({ ...k, lessons: visible.filter(l => l.kind === k.kind).sort((a, b) => score(b) - score(a)) }))
    .filter(g => g.lessons.length > 0)
}

export type CommitmentState = 'overdue' | 'pending' | 'resolved' | 'dismissed'
export function commitmentState(c: Pick<Commitment, 'status' | 'overdueAt'>, now = Date.now()): CommitmentState {
  if (c.status === 'resolved') return 'resolved'
  if (c.status === 'dismissed') return 'dismissed'
  const due = ts(c.overdueAt)
  return Number.isFinite(due) && due <= now ? 'overdue' : 'pending'
}
/** Overdue first (longest overdue on top), then pending by due time, then closed (newest first). */
export function sortCommitments(list: Commitment[], now = Date.now()): Commitment[] {
  const rank = { overdue: 0, pending: 1, resolved: 2, dismissed: 2 } as const
  return [...list].sort((a, b) => {
    const ra = rank[commitmentState(a, now)], rb = rank[commitmentState(b, now)]
    if (ra !== rb) return ra - rb
    if (ra < 2) return (ts(a.overdueAt) || Infinity) - (ts(b.overdueAt) || Infinity)
    return ts(b.updatedAt ?? b.createdAt) - ts(a.updatedAt ?? a.createdAt)
  })
}

export interface AgendaGroup { kind: string; label: string; items: AgendaItem[] }
export function agendaGroups(agenda: AgendaItem[]): AgendaGroup[] {
  const open = agenda.filter(a => a.status === 'open')
  const known = AGENDA_KINDS.map(k => k.kind)
  const extra = [...new Set(open.map(a => a.kind).filter(k => !known.includes(k)))]
  return [...AGENDA_KINDS, ...extra.map(kind => ({ kind, label: kind }))]
    .map(k => ({ ...k, items: open.filter(a => a.kind === k.kind).sort((a, b) => (ts(a.until) || Infinity) - (ts(b.until) || Infinity)) }))
    .filter(g => g.items.length > 0)
}

export function mindCounts(mind: Pick<ProjectMind, 'lessons' | 'agenda' | 'commitments'>, now = Date.now()): Required<MindCounts> {
  const pending = mind.commitments.filter(c => ['pending', 'overdue'].includes(commitmentState(c, now)))
  return {
    lessons: mind.lessons.filter(l => lessonState(l, now) === 'active').length,
    openAgenda: mind.agenda.filter(a => a.status === 'open').length,
    pendingCommitments: pending.length,
    overdueCommitments: pending.filter(c => commitmentState(c, now) === 'overdue').length,
  }
}

export function healthLine(health?: MindHealth | null): { paused: boolean; reason: string | null } {
  if (!health || health.learning !== 'paused') return { paused: false, reason: null }
  return { paused: true, reason: health.reason ? PAUSE_REASONS[health.reason] ?? health.reason : null }
}

/* -------------------------------------------------------------- threads */

/** The thread an item belongs to: the host's hint first, then the thread that lists the item. */
export function threadForItem(threads: MindThread[] | undefined, itemId: string, hint?: string | null): MindThread | null {
  if (!threads?.length) return null
  if (hint) { const byId = threads.find(t => t.id === hint); if (byId) return byId }
  return threads.find(t => t.messageItemIds.includes(itemId)) ?? null
}

export interface ThreadPosition { index: number; total: number; earlier: string[]; continues: boolean; latest: boolean }
/** Where a message sits in its thread (unknown items count as the newest). */
export function threadPosition(thread: Pick<MindThread, 'messageItemIds'>, itemId: string): ThreadPosition {
  const ids = thread.messageItemIds
  const found = ids.indexOf(itemId)
  const index = found >= 0 ? found : ids.length
  const total = found >= 0 ? ids.length : ids.length + 1
  return { index, total, earlier: ids.slice(0, index), continues: index > 0, latest: index === total - 1 }
}

export interface ThreadGroup<E> { key: string; thread: MindThread | null; entries: E[] }
/**
 * Group newest-first inbox entries by thread. A thread group sits where its
 * newest entry would; entries without a thread stay single, in order.
 */
export function groupByThread<E extends { id: string; itemId?: string | null; threadId?: string | null }>(entries: E[], threads: MindThread[] | undefined): ThreadGroup<E>[] {
  const groups: ThreadGroup<E>[] = []
  const byThread = new Map<string, ThreadGroup<E>>()
  for (const entry of entries) {
    const thread = entry.threadId || entry.itemId ? threadForItem(threads, entry.itemId ?? '', entry.threadId) : null
    const threadKey = thread?.id ?? entry.threadId ?? null
    if (!threadKey) { groups.push({ key: `entry:${entry.id}`, thread: null, entries: [entry] }); continue }
    const existing = byThread.get(threadKey)
    if (existing) { existing.entries.push(entry); continue }
    const group: ThreadGroup<E> = { key: `thread:${threadKey}`, thread, entries: [entry] }
    byThread.set(threadKey, group)
    groups.push(group)
  }
  return groups
}

/* ------------------------------------------------------- sidebar hints */

export interface MindHint { key: string; projectId: string; projectName: string; kind: 'overdue'; id: string; text: string; since: string | null }
/**
 * Overdue commitments (things Rna promised), longest overdue first. The
 * sidebar 任务 section folds them into one quiet "Rna 欠你 N 件事" row; agenda
 * items (questions, intentions) never appear there — open questions are
 * answered in the mind panel or on their question card in the conversation.
 */
export function mindHints(minds: Record<string, ProjectMind | null | undefined>, projectNames: Record<string, string>, now = Date.now()): MindHint[] {
  const overdue: MindHint[] = []
  for (const [projectId, mind] of Object.entries(minds)) {
    if (!mind || !(projectId in projectNames)) continue
    const projectName = projectNames[projectId]
    for (const c of mind.commitments) if (commitmentState(c, now) === 'overdue') overdue.push({ key: `c:${projectId}:${c.id}`, projectId, projectName, kind: 'overdue', id: c.id, text: c.request, since: c.overdueAt ?? null })
  }
  return overdue.sort((a, b) => ts(a.since) - ts(b.since))
}
/** Where the "Rna 欠你 N 件事" row leads: the project with the most overdue commitments. */
export function owedSummary(hints: MindHint[]): { count: number; projectId: string | null } {
  const per = new Map<string, number>()
  for (const hint of hints) per.set(hint.projectId, (per.get(hint.projectId) ?? 0) + 1)
  const projectId = [...per].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  return { count: hints.length, projectId }
}

const span = (ms: number) => {
  const min = Math.max(1, Math.round(ms / 60_000))
  if (min < 60) return tr('{n} 分钟', { n: min })
  const h = Math.round(min / 60)
  if (h < 48) return tr('{n} 小时', { n: h })
  return tr('{n} 天', { n: Math.round(h / 24) })
}
/** “已逾期 3 小时” / “2 小时后到期” for commitments and agenda `until`. */
export function dueLabel(iso: string | null | undefined, now = Date.now()): { text: string; overdue: boolean } | null {
  const at = ts(iso)
  if (!Number.isFinite(at)) return null
  return at <= now ? { text: tr('已逾期 {v}', { v: span(now - at) }), overdue: true } : { text: tr('{v}后到期', { v: span(at - now) }), overdue: false }
}
/** “有效至 10月18日” / “10月18日 已过期”. */
export function untilLabel(iso: string | null | undefined, now = Date.now()): string | null {
  const at = ts(iso)
  if (!Number.isFinite(at)) return null
  const date = new Date(at).toLocaleDateString(intlTag(), { month: 'short', day: 'numeric' })
  return at <= now ? tr('{v} 已过期', { v: date }) : tr('有效至 {v}', { v: date })
}

/* ------------------------------------------------- K2 narrator outputs */

export interface WelcomeBackRow { threadId: string | null; title: string | null; text: string; thread: MindThread | null; deliverables: PresentedFile[] }
/**
 * “你不在时的进展”: rendered straight from the host's structured
 * `initiative.topics` (display order) and `overflowCount`. Older items without
 * topics fall back to their plain text; nothing is inferred from the wording.
 */
export function welcomeBackDisplay(initiative: Item['initiative'], text: string, threads: MindThread[] = []): { topics: WelcomeBackRow[]; filed: number; fallback: string | null } {
  const topics = Array.isArray(initiative?.topics) ? initiative.topics.filter(topic => topic && typeof topic.text === 'string') : []
  if (!topics.length) return { topics: [], filed: 0, fallback: String(text ?? '') }
  const overflow = Number(initiative?.overflowCount)
  return {
    topics: topics.map(topic => ({ threadId: topic.threadId ?? null, title: topic.title || null, text: topic.text, thread: threads.find(th => th.id === topic.threadId) ?? null, deliverables: Array.isArray(topic.deliverables) ? topic.deliverables : [] })),
    filed: Number.isFinite(overflow) && overflow > 0 ? overflow : 0,
    fallback: null,
  }
}

export const PACING_OUTCOMES: Record<string, string> = localized({ send: '立即在对话中发送', inbox: '放进收件箱', hold: '并入话题稍后一起说', drop: '不发送' })
/** The documented `pacing.reasons[]` codes (docs/specs/stream-protocol-v2.md, K2 v2). */
export const PACING_REASONS: Record<string, string> = localized({
  above_threshold: '价值超过当前门槛',
  time_sensitive: '时间敏感',
  below_threshold_band: '价值略低于当前门槛，不值得打断你',
  below_threshold: '价值低于当前门槛',
  away: '你暂时不在',
  night: '夜间不打扰',
  already_reported: '之前已经告诉过你',
  exact_duplicate: '与已发出的消息完全相同',
  thread_muted: '这个话题已静音',
  scheduled_deliverable: '定时交付',
  welcome_back: '你回来后的汇总',
  welcome_back_overflow: '回来后的汇总只列最重要的话题，其余放进收件箱',
  held_released: '你不在时暂存的问题，在你回来后发出',
})
/** “为什么放进收件箱”: `pacing.outcome` + documented reason codes in words, with value vs threshold when known. */
export function pacingDisplay(pacing: PacingRecord | null | undefined) {
  if (!pacing) return null
  const outcome = pacing.outcome ? PACING_OUTCOMES[pacing.outcome] ?? null : null
  const reasons = [...new Set(pacing.reasons ?? [])].flatMap(code => (code in PACING_REASONS ? [PACING_REASONS[code]] : []))
  const score = typeof pacing.value === 'number' && typeof pacing.threshold === 'number'
    ? tr('价值 {value} · 门槛 {threshold}', { value: pacing.value.toFixed(2), threshold: pacing.threshold.toFixed(2) }) : null
  if (!outcome && !reasons.length) return null
  return { outcome, reasons, score }
}

/** Plain one-line text for chips and bell rows. */
export const plainText = (text: string) => text.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>[\]]/g, '').replace(/\(https?:[^)]*\)/g, '').replace(/\s+/g, ' ').trim()
