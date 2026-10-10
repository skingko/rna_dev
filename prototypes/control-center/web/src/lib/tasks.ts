/**
 * H3 global tasks: one list of the work every project is doing or has
 * scheduled — background actions (from `/initiative/actions`, which carries
 * the live control revision and available controls) and schedules (from the
 * project summary the index stream keeps current). Pure; the store loads the
 * action snapshots and the sidebar / tasks view render these entries.
 */
import type { InitiativeAction, Occurrence, Schedule } from '@/api/project-api'
import type { ProjectPlan } from '@/api/types'
import { occurrenceLabel, PAUSED_LABELS, scheduleRows, type SessionLike } from './schedules'
import { currentLocale, formatDate, localized, t as tr } from '@/i18n'
import { actionReason, failureSentence, hostFailureHandoff } from './task-failure'

export type TaskState = 'running' | 'queued' | 'paused' | 'review' | 'scheduled' | 'failed' | 'disabled' | 'done' | 'cancelled'
export type TaskControl = 'pause' | 'resume' | 'stop' | 'steer'
/** Status marks the page adds on its own, from state and time (never set by hand). */
export type TaskFlag = 'attention' | 'failed' | 'overdue' | 'fresh' | 'stopping' | 'handled'

export interface TaskEntry {
  key: string
  projectId: string
  projectName: string
  kind: 'action' | 'schedule' | 'learning' | 'plan'
  /** Actions: work / schedule (planning) / share / ask / learn. Learning: generation / forming. */
  actionKind?: string
  id: string
  title: string
  /** Kind label: 后台工作 / 定时任务 … */
  label: string
  state: TaskState
  stateLabel: string
  /** Short time hint: “5 分钟前开始” / “明天 09:00”. */
  when: string
  /** Sort key within a state (ms): next run for schedules, start time for actions. */
  at: number | null
  controls: TaskControl[]
  /** Schedules: whether the user can toggle it (pause / resume). */
  enabled?: boolean
  deliveryKey?: string | null
  summary?: string
  flags: TaskFlag[]
  /** Schedules: the rule in words (每天 09:00 …). */
  rule?: string
  /** An action from before the project's scope changed: only its receipt is kept (read-only, no content). */
  revoked?: boolean
  /** A revoked action the host kept no name for: 接着做 has nothing to carry on with (the host refuses it, task_context_revoked). */
  lost?: boolean
  /** Plan lines: their place in the plan (正在做, then 上次停在这里, then 接下来, in the plan's own order). */
  planIndex?: number
}

/**
 * What the host's action view adds to an SDK action (C-d): the decision model's one-line `title` for the user,
 * the host's `label` (title, else the schedule, else the instruction's first sentence without handles), a share or
 * ask outcome in the user's words (`userSummary`), and, for an action revoked by a scope change, `revoked` with the
 * user-facing `receipt` (its content is then a placeholder for the model and never shown).
 */
export type ActionView = InitiativeAction & {
  title?: string; label?: string; userSummary?: string; revoked?: boolean; contextRevoked?: boolean
  receipt?: { label?: string; status?: string; startedAt?: string; finishedAt?: string; handoff?: string } | null
  deferredReason?: string | null; cancellationReason?: string | null
}

export interface TaskProjectInput {
  id: string
  name: string
  archivedAt?: string | null
  simulated?: boolean
  decisionMode?: string
  initiative?: { enabled?: boolean; notificationMuted?: boolean }
  schedules?: Schedule[]
  scheduleRuntime?: { occurrences?: Occurrence[] }
  plan?: ProjectPlan | null
}

export const ACTION_LABELS: Record<string, string> = localized({ work: '自主执行', learn: '候选改进', share: '主动分享', ask: '主动提问', schedule: '规划', learning: '自主学习', plan: '计划' })
const PLAN_LABELS: Record<string, string> = localized({ doing: '正在做', next: '接下来', stopped: '上次停在这里', done: '已完成' })
/** A plan line; one moved back to next by stopped background work carries when it stopped (host planView). */
type PlanRow = ProjectPlan['next'][number] & { interruptedAt?: string | null }
const STATE_LABELS: Record<TaskState, string> = localized({ running: '进行中', queued: '排队中', paused: '已暂停', review: '待核对', scheduled: '已排期', failed: '未完成', disabled: '已停用', done: '已完成', cancelled: '已取消' })
const RANK: Record<TaskState, number> = { running: 0, review: 1, queued: 2, paused: 3, failed: 4, scheduled: 5, disabled: 6, done: 7, cancelled: 8 }
/** A result this recent is marked 新结果. */
export const FRESH_MS = 6 * 3_600_000
const CONTROLS: TaskControl[] = ['pause', 'resume', 'stop', 'steer']

/** A time as ms. The host sends live action times as epoch-ms numbers and receipt / plan times as ISO strings. */
const ms = (value?: string | number | null) => (typeof value === 'number' ? (Number.isFinite(value) ? value : null)
  : value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null)
const pad = (n: number) => String(n).padStart(2, '0')

/** Compact future / past time for a sidebar row. */
export function whenLabel(at: number | null, now = Date.now()): string {
  if (at === null) return ''
  const d = new Date(at)
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const diff = at - now
  if (diff < 0) {
    const ago = -diff
    if (ago < 60_000) return tr('刚刚')
    if (ago < 3_600_000) return tr('{v} 分钟前', { v: Math.floor(ago / 60_000) })
    if (ago < 86_400_000) return tr('{v} 小时前', { v: Math.floor(ago / 3_600_000) })
  } else if (diff < 3_600_000) return tr('{v} 分钟后', { v: Math.max(1, Math.round(diff / 60_000)) })
  const day = (t: number) => new Date(t).toDateString()
  if (day(at) === day(now)) return tr('今天 {clock}', { clock })
  if (day(at) === day(now + 86_400_000)) return tr('明天 {clock}', { clock })
  if (day(at) === day(now - 86_400_000)) return tr('昨天 {clock}', { clock })
  return `${formatDate(d, currentLocale(), { month: 'short', day: 'numeric' })} ${clock}`
}

const clip = (line: string, max: number) => (line.length > max ? `${line.slice(0, max - 1)}…` : line)
function firstLine(text: string | undefined, max = 90) {
  return clip(String(text ?? '').split('\n').map(s => s.replace(/\*\*|__|`/g, '').replace(/^[#>\s-]+/, '').trim()).find(Boolean) ?? '', max)
}

/**
 * Text without the decision's evidence handles (E1, E16 …), which only meant something inside that one decision.
 * Port of the host's task-text.mjs withoutHandles (kept identical; the spec compares them).
 */
const ONE_HANDLE = '(?<![A-Za-z0-9_])E\\d{1,3}(?![0-9A-Za-z_])', HANDLE_LIST = `${ONE_HANDLE}(?:(?:\\s*[,，、/]\\s*|\\s+(?:and|or)\\s+|\\s*[和与及或]\\s*)${ONE_HANDLE})*` // i18n-ignore: a handle pattern, not UI text
const HANDLE = new RegExp(`\\s?(?:(?<![A-Za-z0-9_])(?:from|in|on|at|by|with|per|see|of)\\s+(?=${HANDLE_LIST}\\s*(?:[.,;:!?)）。，；：！？]|$)))?(?:(?:根据|按照|依据|基于|参考|参照|依照|结合)\\s*(?=${HANDLE_LIST}(?!\\s*的)))?${HANDLE_LIST}\\s?`, 'g') // i18n-ignore: a handle pattern, not UI text
// Spacing around a removed handle, id or tool name: keep one space only between Latin words.
const rejoin = (match: string, offset: number, whole: string) => /[A-Za-z0-9]/.test(whole[offset - 1] ?? '') && /[A-Za-z0-9]/.test(whole[offset + match.length] ?? '') ? ' ' : ''
// A bracket left empty goes with the space before it ("output (E2)." reads "output.").
export function withoutHandles(text: string | null | undefined): string {
  return String(text ?? '').replace(HANDLE, rejoin).replace(/[ \t]{2,}/g, ' ').replace(/[ \t]*(?:（[\s,，、/]*）|\([\s,，、/]*\))/g, '').replace(/(?<=[\u3400-\u9fff]) (?=[「『“（【])/gu, '').trim()
}
/**
 * Text without host record ids and host tool names (project_history, mcp__…), which mean nothing to the user. Port of
 * the host's task-text.mjs withoutInternals (kept identical; the spec compares them), so a host too old to send `label`
 * still names its tasks in plain words. A record id is a UUID anywhere, or a hex hash right after the record it names
 * ("turn e666f3a6", "动作 007c353e"): a bare hex-looking word is an ordinary word (decade1, cafe1234, a colour code).
 * A named English id takes its name and a preposition left pointing at nothing with it; words inside a path or file
 * name (project_notes.md, out/3fa9b2c1.png) are left alone.
 */
const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', HEX_ID = `(?:${UUID}|(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40})`, ID_END = '(?![A-Za-z0-9_/-]|\\.[A-Za-z0-9])'
const NAMED_ID = `(?<![A-Za-z0-9_./-])(?:turn|[Aa]ction|[Jj]ob|run|[Ss]ession|[Ii]tem)\\s?[:#]?\\s?${HEX_ID}`
const DANGLING = `(?<![A-Za-z0-9_./-])(?:for|of|in|on|from|at|to|by|with|about)\\s(?=${NAMED_ID}${ID_END}(?:\\s*[.,;:!?)）。，；：！？]|\\s*$|\\s(?:and|or|then|but)\\b))` // i18n-ignore: an id pattern, not UI text
const RECORD_ID = new RegExp(`\\s?(?:(?:${DANGLING})?${NAMED_ID}|(?<=(?:动作|行动|任务|会话|回合|轮次|消息|条目)\\s?[:：#]?\\s?)${HEX_ID}|(?<![A-Za-z0-9_./-])${UUID})${ID_END}\\s?`, 'g') // i18n-ignore: an id pattern, not UI text
const TOOL_NAME = /\s?(?<![A-Za-z0-9_./-])(?:mcp__[\w-]+|(?:project|memory|openviking|marketplace|capability|skill|schedule)_[a-z0-9_]+)(?![A-Za-z0-9_/-]|\.[A-Za-z0-9])\s?/g
// Quotes a removed tool name leaves empty go with the space before them ('Check "skill_load" output' reads 'Check output').
export function withoutInternals(text: string | null | undefined): string {
  return String(text ?? '').replace(RECORD_ID, rejoin).replace(TOOL_NAME, rejoin).replace(/[ \t]*(?:""|''|“”|‘’|「」|『』|``)/g, '')
}
/** Text as the user reads it (the host's cleanLine, line by line so a long instruction keeps its lines): no handles, ids or tool names. */
export const plainTaskText = (text: string | null | undefined) => withoutHandles(String(text ?? '').split('\n').map(withoutInternals).join('\n'))

/**
 * How a background action is named. A scheduled run is named by the schedule the user set up: its content is the
 * host's own instruction to the worker (occurrence key, due time, rule JSON) and showed verbatim before (2026-10-03).
 */
// The host's scheduled work instruction: "Scheduled occurrence …\nDue: …\nTime rule: …\n\n<the schedule's task>\n\nProduce the requested deliverable …".
const SCHEDULED_TAIL = '\n\nProduce the requested deliverable'
/** The task a scheduled run was given, as it stood when it ran (the schedule may have changed or gone since). */
export function scheduledTaskOf(action: { hostSchedule?: unknown; content?: string }): string {
  const content = String(action.content ?? '')
  if (!action.hostSchedule || !content.startsWith('Scheduled occurrence ')) return ''
  const head = content.indexOf('\n\n'), tail = content.indexOf(SCHEDULED_TAIL, head + 2)
  return head < 0 ? '' : content.slice(head + 2, tail < 0 ? undefined : tail).trim()
}

export function actionTitle(project: { schedules?: Schedule[] }, action: Pick<ActionView, 'hostSchedule' | 'content' | 'title' | 'label' | 'receipt' | 'revoked' | 'contextRevoked'>, max = 90): string {
  if (action.hostSchedule) {
    // A schedule deleted since: name the run by the task it was given.
    const title = project.schedules?.find(s => s.id === action.hostSchedule?.scheduleId)?.title?.replace(/\s+/g, ' ').trim() || firstLine(scheduledTaskOf(action), max)
    return title ? tr('定时任务「{title}」', { title: clip(title, max) }) : tr('定时任务')
  }
  // The host's name for it (C-d): its label is the decision's title already cleaned of ids and tool names, which the
  // raw title is not (the SDK strips only evidence handles). A host without labels gets its title cleaned here.
  // A revoked action's content is a placeholder for the model, never a name.
  const named = (action.label || plainTaskText(action.title?.replace(/\s+/g, ' ')) || action.receipt?.label || '').replace(/\s+/g, ' ').trim()
  if (named) return clip(named, max)
  return action.revoked || action.contextRevoked ? '' : firstLine(plainTaskText(action.content), max)
}

const LIVE: Record<string, TaskState> = { running: 'running', queued: 'queued', paused: 'paused', needs_review: 'review' }
const ENDED: Record<string, TaskState> = { completed: 'done', failed: 'failed', interrupted: 'failed', cancelled: 'cancelled' }

/** Live action times arrive as epoch-ms numbers (the SDK's own records), a revoked row's only in its ISO `receipt`. */
type ActionInput = ActionView & { createdAt?: string | number; startedAt?: string | number; finishedAt?: string | number; simulated?: boolean }
const COMMUNICATION = new Set(['share', 'ask'])

/** The one line under a task: how it stopped, what a share / ask came to, or the run's handoff. */
function actionSummary(action: ActionInput, state: TaskState): string | undefined {
  // An unsent share / ask was not stopped work: say it was not sent, and why (F13).
  if (COMMUNICATION.has(action.action) && state === 'cancelled') {
    const reason = actionReason(action.cancellationReason, 'cancelled')
    return reason ? tr('没有发送：{reason}', { reason }) : tr('这条消息没有发送。')
  }
  if (state === 'failed' || state === 'cancelled') return failureSentence(action.failure?.code ?? action.errorCode, action.status)
  // A share / ask's resultSummary is the host's receipt for the model (English, question ids): only the user's version.
  if (COMMUNICATION.has(action.action)) return action.userSummary || undefined
  const handoff = action.handoff ?? action.receipt?.handoff
  return (handoff && !hostFailureHandoff(handoff) ? handoff : undefined) ?? action.resultSummary
}

/** One background action as a task. Ended ones (done, failed, cancelled) only with `ended` (the 任务 page; the sidebar keeps live work). */
export function actionTask(project: TaskProjectInput, action: ActionInput, now = Date.now(), { ended = false }: { ended?: boolean } = {}): TaskEntry | null {
  if (action.simulated === true) return null
  const state: TaskState | null = LIVE[action.status] ?? (ended ? ENDED[action.status] ?? null : null)
  if (!state) return null
  const finished = ms(action.finishedAt ?? action.receipt?.finishedAt)
  const started = ms(action.startedAt ?? action.receipt?.startedAt)
  const at = state === 'done' || state === 'failed' || state === 'cancelled' ? finished ?? started ?? ms(action.createdAt) : started ?? ms(action.createdAt)
  const label = ACTION_LABELS[action.action] ?? tr('后台行动')
  const pending = (action.controls ?? []).filter(c => c.status === 'pending')
  const stopping = state === 'running' && pending.some(c => c.kind === 'pause' || c.kind === 'cancel')
  const flags: TaskFlag[] = []
  // Answered from the conversation (接着做 / 不用了 / 按现在的算): no longer waiting for the user.
  const handled = Boolean(action.attention?.acknowledgedAt)
  if (state === 'review' && !handled) flags.push('attention')
  if (state === 'failed') flags.push(handled ? 'handled' : 'failed')
  if (stopping) flags.push('stopping')
  // A finished result JEV (message.value) says needs the user is marked 需要你 until they say 知道了 (C-e); one already told to them is not 新结果.
  if (state === 'done' && action.attention?.needsUser && !handled) flags.push('attention')
  if (state === 'done' && finished !== null && now - finished < FRESH_MS && !action.attention?.alreadyReported) flags.push('fresh')
  return {
    key: `${project.id}:action:${action.id}`, projectId: project.id, projectName: project.name, kind: 'action', actionKind: action.action, id: action.id,
    title: actionTitle(project, action) || label, label, state,
    stateLabel: pending.length && state === 'running' ? tr('处理控制请求') : STATE_LABELS[state],
    when: state === 'review' ? tr('需要核对结果') : whenLabel(at, now),
    at, controls: CONTROLS.filter(op => action.availableControls?.includes(op)),
    summary: actionSummary(action, state), flags,
    ...(action.revoked || action.contextRevoked ? { revoked: true, ...(action.label?.trim() || action.receipt?.label?.trim() ? {} : { lost: true }) } : {}),
  }
}

/**
 * 计划: the project's working plan (doing, next, recently done), maintained by the agent in the conversation and in the background.
 * A plan's 正在做 is what the agent last wrote down, not live work (it outlives the run that wrote it), so it is never
 * 'running': no live ring, not counted as 进行中 (live, 2026-10-03: a stale 正在做 read as background work in progress).
 */
export function planTasks(project: TaskProjectInput, now = Date.now()): TaskEntry[] {
  const plan = project.plan
  if (!plan || project.archivedAt || project.simulated === true) return []
  const state: Record<string, TaskState> = { doing: 'scheduled', next: 'scheduled', done: 'done' }
  // A next line that background work was doing when it stopped (`interruptedAt`) is where that work left off: it reads
  // 上次停在这里 and comes right after 正在做. `planIndex` keeps this order on the page (they share one state).
  const stopped = (row: PlanRow) => row.status === 'next' && Boolean(row.interruptedAt)
  const next = [...plan.next.filter(stopped), ...plan.next.filter(row => !stopped(row))]
  return [...plan.doing, ...next, ...plan.done].filter(row => state[row.status]).map((row, planIndex) => {
    const at = ms(row.updatedAt ?? null)
    const stage = stopped(row) ? PLAN_LABELS.stopped : PLAN_LABELS[row.status]
    return { key: `${project.id}:plan:${row.id}`, projectId: project.id, projectName: project.name, kind: 'plan' as const, actionKind: row.status, id: row.id,
      title: row.text, label: ACTION_LABELS.plan, state: state[row.status], stateLabel: stage ?? row.status, when: row.status === 'done' ? whenLabel(at, now) : stage ?? '', at, controls: [], flags: [] as TaskFlag[], planIndex }
  })
}

/** 自主学习: each evolution generation is a finished piece of learning; genes still being formed are running. */
export interface LearningTreeLike {
  generations?: { n: number; at: string; summary: string; trigger?: string | null }[]
  strands?: { layer: string; genes: { id: string; title: string; summary: string; status: string; updatedAt?: string | null; createdAt?: string | null }[] }[]
}
export function learningTasks(project: TaskProjectInput, tree: LearningTreeLike | null | undefined, now = Date.now()): TaskEntry[] {
  if (!tree || project.archivedAt || project.simulated === true) return []
  const label = ACTION_LABELS.learning
  const forming = (tree.strands ?? []).flatMap(row => row.genes).filter(gene => gene.status === 'proposed' || gene.status === 'testing').map(gene => {
    const at = ms(gene.updatedAt) ?? ms(gene.createdAt)
    return { key: `${project.id}:learning:${gene.id}`, projectId: project.id, projectName: project.name, kind: 'learning' as const, actionKind: 'forming', id: gene.id,
      title: gene.title, label, state: 'running' as TaskState, stateLabel: tr('正在形成'), when: whenLabel(at, now), at, controls: [], summary: gene.summary, flags: [] as TaskFlag[] }
  })
  const done = (tree.generations ?? []).slice(0, 12).map(row => {
    const at = ms(row.at)
    return { key: `${project.id}:learning:gen-${row.n}`, projectId: project.id, projectName: project.name, kind: 'learning' as const, actionKind: 'generation', id: `gen-${row.n}`,
      title: row.summary || tr('第 {n} 代', { n: row.n }), label, state: 'done' as TaskState, stateLabel: STATE_LABELS.done, when: whenLabel(at, now), at, controls: [],
      summary: tr('第 {n} 代', { n: row.n }), flags: (at !== null && now - at < FRESH_MS ? ['fresh'] : []) as TaskFlag[] }
  })
  return [...forming, ...done]
}

export function scheduleTasks(project: TaskProjectInput, opts: { emergency?: boolean; sessions?: SessionLike[] } = {}, now = Date.now()): TaskEntry[] {
  return scheduleRows(project, { emergency: opts.emergency, sessions: opts.sessions ?? [], projectId: project.id }).map(row => {
    const next = ms(row.record.nextRunAt)
    const state: TaskState = row.lastStatus === 'running' ? 'running'
      : row.lastStatus === 'needs_review' ? 'review'
        : row.paused ? 'disabled'
          : row.lastStatus === 'failed' && !next ? 'failed' : 'scheduled'
    const flags: TaskFlag[] = []
    if (state === 'review') flags.push('attention')
    if (row.lastStatus === 'failed') flags.push('failed')
    if (state === 'scheduled' && next !== null && next < now - 5 * 60_000) flags.push('overdue')
    const delivered = ms(row.history.find(item => item.deliveredAt)?.deliveredAt ?? null)
    if (delivered !== null && now - delivered < FRESH_MS) flags.push('fresh')
    return {
      key: `${project.id}:schedule:${row.id}`, projectId: project.id, projectName: project.name, kind: 'schedule' as const, id: row.id,
      title: row.title || tr('定时任务'), label: tr('定时任务'), state, flags, rule: row.rule,
      stateLabel: state === 'disabled' ? (row.record.enabled === false ? tr('已暂停') : (row.paused && PAUSED_LABELS[row.paused]) || row.paused || tr('已暂停')) : STATE_LABELS[state],
      when: state === 'running' ? tr('正在执行') : state === 'disabled' ? row.rule : next ? whenLabel(next, now) : row.rule,
      at: next, controls: [], enabled: row.record.enabled !== false, deliveryKey: row.deliveryKey,
      summary: row.rule,
    }
  })
}

/**
 * Every project's tasks, ordered: running, review, queued, paused, failed, next scheduled, disabled. `settling`: the
 * user's answers the host's data may not show yet (tasks-store), read as the host will record them.
 */
export function aggregateTasks(projects: TaskProjectInput[], actions: Record<string, InitiativeAction[] | undefined>, opts: { emergency?: boolean; sessions?: SessionLike[]; ended?: boolean; settling?: Settling } = {}, now = Date.now()): TaskEntry[] {
  const out: TaskEntry[] = []
  for (const project of projects) {
    if (project.archivedAt || project.simulated === true || project.decisionMode === 'demo-policy') continue
    for (const action of actions[project.id] ?? []) {
      const settle = opts.settling?.[`${project.id}:action:${action.id}`]
      const entry = actionTask(project, settle?.kind === 'answer' ? answeredAction(action, settle) : action, now, { ended: opts.ended })
      if (entry) out.push(entry)
    }
    out.push(...scheduleTasks(project, opts, now))
  }
  return out.sort((a, b) => RANK[a.state] - RANK[b.state]
    || (a.state === 'scheduled' ? (a.at ?? Infinity) - (b.at ?? Infinity) : (b.at ?? 0) - (a.at ?? 0))
    || a.key.localeCompare(b.key))
}

/**
 * Waiting on the user: what its row marks 需要你 (to review and not yet answered, a result not yet seen), or failed and
 * not yet answered. A review already answered from the conversation carries no mark, so it is not counted either.
 */
export const needsUser = (e: TaskEntry) => e.flags.includes('attention') || e.state === 'failed' && !e.flags.includes('handled')

/* ------------------------------------------------ answers, plan changes, 清理 */

/** The user's answers on background work that waits for them (the host's answerTask choices). */
export type TaskAnswer = 'continue' | 'drop' | 'keep' | 'acknowledge'
/** A plan line's status as the user sets it (the mind agenda's PATCH). */
export type PlanStatus = 'open' | 'done' | 'dropped'

/**
 * A change the user just made, shown at once and kept until the host's data says the same (tasks-store `settling`, by
 * task key): an answer (`at`: when), or a plan line marked done or dropped — applied while that line still reads as it
 * did then (`since`: its updatedAt as ms when the user changed it; `at`: when, ms).
 */
export type TaskSettle = { kind: 'answer'; choice: TaskAnswer; at: string } | { kind: 'plan'; status: 'done' | 'dropped'; since: number | null; at: number }
export type Settling = Record<string, TaskSettle>

/**
 * What the user can answer on a task that waits for them, as the host takes it (answerTask): a result to check is kept
 * or dropped, a failed run is carried on or let go, a result marked 需要你 is seen. 接着做 only where it can work: a revoked
 * run the host kept no name for has nothing to carry on with, and the host refuses it.
 */
export function taskAnswers(task: TaskEntry): TaskAnswer[] {
  if (task.kind !== 'action') return []
  if (task.state === 'review') return ['keep', 'drop']
  if (task.state === 'failed' && !task.flags.includes('handled')) return task.lost ? ['drop'] : ['continue', 'drop']
  if (task.state === 'done' && task.flags.includes('attention')) return ['acknowledge']
  return []
}

/** A failed run still waiting on the user: its row and inspector carry 不用了 (and 接着做 where it can work) in view. */
export const failedOpen = (task: TaskEntry) => task.kind === 'action' && task.state === 'failed' && taskAnswers(task).includes('drop')
/** A plan line still ahead (正在做, 上次停在这里, 接下来): it can be marked done or dropped. */
export const planOpen = (task: TaskEntry) => task.kind === 'plan' && task.state !== 'done'

/** An action as the host records the user's answer: answered (acknowledgedAt); a result to check kept (completed) or dropped (cancelled). */
export function answeredAction<A extends InitiativeAction>(action: A, settle: Extract<TaskSettle, { kind: 'answer' }>): A {
  const review = action.status === 'needs_review' && (settle.choice === 'keep' || settle.choice === 'drop')
  if (action.attention?.acknowledgedAt && !review) return action
  return {
    ...action, ...(review ? { status: settle.choice === 'keep' ? 'completed' : 'cancelled', availableControls: [] } : {}),
    attention: { ...action.attention, acknowledgedAt: action.attention?.acknowledgedAt ?? settle.at },
  }
}

/** Plan lines with the user's changes the project summary may not carry yet: one marked done reads 已完成, a dropped one is gone. */
export function settlePlan(entries: TaskEntry[], settling: Settling, now = Date.now()): TaskEntry[] {
  if (!Object.values(settling).some(settle => settle.kind === 'plan')) return entries
  return entries.flatMap(entry => {
    const settle = entry.kind === 'plan' ? settling[entry.key] : undefined
    // Only while the line still reads as it did when the user changed it: once the summary has it, the summary wins.
    if (settle?.kind !== 'plan' || entry.state === 'done' || settle.since !== entry.at) return [entry]
    if (settle.status === 'dropped') return []
    // Done when the user said so: never a time ahead, also read within the same millisecond.
    return [{ ...entry, state: 'done' as const, actionKind: 'done', stateLabel: PLAN_LABELS.done, at: settle.at, when: whenLabel(settle.at, Math.max(now, settle.at + 1)) }]
  })
}

/**
 * What 清理… settles among some tasks: failed background work still waiting on the user, and the plan's open lines —
 * each project's together (as the tasks list the projects), in the plan's order.
 */
export function cleanupRows(entries: TaskEntry[]): { actions: TaskEntry[]; plan: TaskEntry[] } {
  const place = new Map<string, number>()
  for (const entry of entries) if (!place.has(entry.projectId)) place.set(entry.projectId, place.size)
  const byPlan = (a: TaskEntry, b: TaskEntry) => place.get(a.projectId)! - place.get(b.projectId)! || byOpen(a, b)
  return { actions: entries.filter(failedOpen).sort(byOpen), plan: entries.filter(planOpen).sort(byPlan) }
}

/** Counts for the sidebar header: live work vs. everything. */
export function taskCounts(entries: TaskEntry[]) {
  return {
    active: entries.filter(e => e.state === 'running' || e.state === 'queued').length,
    attention: entries.filter(needsUser).length,
    total: entries.length,
  }
}

/** Sidebar split: live background work vs. recurring schedules. Ended work
 * (to review, failed) has already been reported in the conversation and
 * stays only on the full 任务 page, so the sidebar never piles up. */
export function sidebarTaskGroups(entries: TaskEntry[]) {
  return {
    active: entries.filter(e => e.kind === 'action' && (e.state === 'running' || e.state === 'queued' || e.state === 'paused')),
    schedules: entries.filter(e => e.kind === 'schedule' && e.state !== 'failed'),
  }
}

/* ------------------------------------------------ 项目日程: forecast buckets */

export type ScheduleBucket = 'attention' | 'now' | 'today' | 'tomorrow' | 'week' | 'later' | 'paused'
export const SCHEDULE_BUCKETS: ScheduleBucket[] = ['attention', 'now', 'today', 'tomorrow', 'week', 'later', 'paused']
export const BUCKET_LABELS: Record<ScheduleBucket, string> = localized({ attention: '需要处理', now: '正在执行', today: '今天', tomorrow: '明天', week: '七天内', later: '以后', paused: '已暂停' })

/** Where a schedule sits on the forecast: by its next run, with problems and pauses apart. */
export function scheduleBucket(task: TaskEntry, now = Date.now()): ScheduleBucket {
  if (task.state === 'running') return 'now'
  if ((task.state === 'review' || task.state === 'failed') && !task.flags.includes('handled') || task.flags.includes('overdue')) return 'attention'
  if (task.state === 'disabled') return 'paused'
  if (task.at === null) return 'later'
  const day = (value: number) => new Date(value).toDateString()
  if (day(task.at) === day(now)) return 'today'
  if (day(task.at) === day(now + 86_400_000)) return 'tomorrow'
  if (task.at - now < 7 * 86_400_000) return 'week'
  return 'later'
}

/** Ended for the 临时任务 list: done or cancelled (unless it still needs the user), or failed and already answered. */
export const taskEnded = (entry: TaskEntry) => (entry.state === 'done' || entry.state === 'cancelled') && !entry.flags.includes('attention')
  || entry.state === 'failed' && entry.flags.includes('handled')

/** 临时任务 split: what is still open (live, to review, failed and unanswered) and what has ended. */
export function adhocSplit(entries: TaskEntry[]) {
  return { open: entries.filter(entry => !taskEnded(entry)), ended: entries.filter(taskEnded) }
}

/** 临时任务's open rows in a project: to review first, then live work, failed, paused, queued and the plan. */
const OPEN_RANK: Record<TaskState, number> = { review: 0, running: 1, failed: 2, paused: 3, queued: 4, scheduled: 5, disabled: 6, done: 7, cancelled: 8 }
// Plan lines (正在做, 上次停在这里, 接下来) share one state: they keep the plan's own order, not the latest edit's.
export const byOpen = (a: TaskEntry, b: TaskEntry) => OPEN_RANK[a.state] - OPEN_RANK[b.state]
  || (a.planIndex !== undefined && b.planIndex !== undefined ? a.planIndex - b.planIndex : (b.at ?? 0) - (a.at ?? 0)) || a.key.localeCompare(b.key)

/** What a count badge counts: open work, not the agent's plan entries (a plan line is not work in progress). */
export const badgeCount = (entries: TaskEntry[]) => entries.filter(entry => entry.kind !== 'plan' && !taskEnded(entry)).length

/* ------------------------------------------------ 项目日程: run records */

/** One schedule run in words: its state, and how it stopped in plain words (never the error code). */
export const occurrenceText = (item: Pick<Occurrence, 'status' | 'deliveredAt' | 'errorCode'>): string => occurrenceLabel(item)
