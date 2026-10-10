/**
 * The background tasks panel's model (design 2.1, 2.2): one pure merge of what
 * the host says about work done away from the conversation into the panel's
 * three sections — 运行中, 排队与即将运行, 已完成 (24 h).
 *
 * Sources: the project summary's `work` progress (P-1; absent on older hosts),
 * schedules and their runs, plan items a run staged or resolved (P-3), the
 * actions snapshot the sidebar reads (tasks-store; the only source of runs on
 * a host without `work`), the sessions' background subagents (P-4) and live
 * steps (P-2). Which actions are in progress, their states, titles, controls
 * and marks come from lib/tasks (aggregateTasks, sidebarTaskGroups), so the
 * panel and the sidebar's 进行中 never count differently. Everything here is
 * computed in code (no judgment calls).
 */
import type { InitiativeAction, Occurrence, Schedule } from '@/api/project-api'
import type { BackgroundChange, ProjectWork, SessionSummary, SubagentInfo, ToolCall, ToolKind, WorkRun, WorkStep } from '@/api/types'
import { ACTION_LABELS, aggregateTasks, needsUser, sidebarTaskGroups, type Settling, type TaskControl, type TaskEntry, type TaskFlag, type TaskProjectInput, type TaskState } from './tasks'
import { toolKind, toolVerb, VERBS, type ViewKind } from './tools'
import type { LiveStep } from '@/store/background-live'
import { localized, t } from '@/i18n'

/* ------------------------------------------------------------------ types */

export type RunKind = 'work' | 'scheduled' | 'learn' | 'agents' | 'other'
export type RunSection = 'attention' | 'running' | 'upcoming' | 'finished'
/** One segment of a scheduled run's 执行 → 交付. */
export type RunStage = 'pending' | 'active' | 'done' | 'failed' | 'attention' | 'stopped'
export type StepStatus = 'running' | 'succeeded' | 'failed' | 'uncertain' | 'ended'

export interface RunStepView {
  id: string
  name: string
  kind: ViewKind
  target: string | null
  /** `ended`: a later step started after it (live steps carry no outcome). */
  status: StepStatus
  at: number
  /** The step as a verb (正在编辑 / 已读取 …); empty for an ended live step, whose outcome is unknown. */
  verb: string
}

export interface RunPhase {
  /**
   * 计划项 x/y: the run's own plan items (the host's `plan`), else those of the project plan it staged or resolved
   * (P-3); null when it has none (no forced planning, D6).
   */
  plan: { done: number; total: number } | null
  /**
   * Steps (tool calls) done, failed and unconfirmed; null without the host's progress (older hosts) or before the first
   * step. No limit: the host's counts model requests, not steps.
   */
  steps: { completed: number; total: number; failed: number; uncertain: number } | null
  /** Scheduled runs: 执行 → 交付, from the occurrence's status. */
  delivery: { run: RunStage; deliver: RunStage } | null
  /** Subagent groups: per role in a fixed order (侦察 → 规划 → 实施 → 审查), once the group's agents are loaded. */
  roles: { role: string; label: string; done: number; total: number; running: number }[] | null
}

export interface BackgroundRun {
  /** Stable row key: the lib/tasks key for actions and schedules, `<project>:agents:<session>` for subagent groups. */
  key: string
  /** The action, schedule or session id. */
  id: string
  projectId: string | null
  projectName: string
  kind: RunKind
  kindLabel: string
  title: string
  section: RunSection
  state: TaskState
  stateLabel: string
  /** The lib/tasks entry behind an action or schedule row (controls, marks, the 任务 page's focus key). */
  task: TaskEntry | null
  /** ms: when the current stretch of work started, and when it ended. */
  startedAt: number | null
  endedAt: number | null
  /** ms: an upcoming run's time; otherwise the row's sort time. */
  at: number | null
  /** Short time words from lib/tasks (明天 09:00 / 5 分钟前). */
  when: string
  agents: number | null
  tokens: { total: number; estimated: boolean } | null
  model: string | null
  /** One or two lines: the outcome of a finished run, what a group is doing, a schedule's rule. */
  summary: string
  phase: RunPhase
  latest: RunStepView | null
  /** Newest first, at most `MAX_STEPS`. */
  steps: RunStepView[]
  changeId: string | null
  /** Files in its change set, when the project summary lists it. */
  changeCount: number | null
  /** The conversation it reports to (the project's main one, a schedule's destination, the group's own). */
  sessionId: string | null
  scheduleId: string | null
  occurrenceKey: string | null
  /** Subagent groups: the turn whose agents the table lists. */
  turnId: string | null
  controls: TaskControl[]
  flags: TaskFlag[]
}

export interface BackgroundRunsView {
  /** Ended runs still waiting on the user (a result to check, a failure to answer): first, whatever their age. */
  attention: BackgroundRun[]
  running: BackgroundRun[]
  upcoming: BackgroundRun[]
  finished: BackgroundRun[]
  counts: {
    /** The sidebar's 进行中: background actions running, queued or paused (lib/tasks sidebarTaskGroups). */
    active: number
    attention: number
    running: number
    upcoming: number
    finished: number
    /** Finished rows hidden by this viewer's 清除. */
    cleared: number
  }
}

/** What the panel reads from a project summary (summaries carry schedules, their runs and the plan). */
export type RunProjectInput = TaskProjectInput & {
  primarySessionId?: string
  backgroundChanges?: BackgroundChange[]
  work?: ProjectWork | null
  /** The user's marks per action, when the project was read with them (`include=taskMarks`); the summary has none. */
  taskMarks?: Record<string, WorkRun['attention']> | null
}

export interface BackgroundRunsInput {
  projects: RunProjectInput[]
  /** tasks-store `actions` (per project; undefined = not read yet). */
  actions: Record<string, InitiativeAction[] | undefined>
  sessions: SessionSummary[]
  /** background-live steps per action id. */
  live?: Record<string, LiveStep[] | undefined>
  /** Loaded subagent lists per session id (GET /api/v2/sessions/:id/agents). */
  agents?: Record<string, SubagentInfo[] | undefined>
  emergency?: boolean
  /** 'all', or the one project shown. */
  filter: string
  /** Finished row keys this viewer cleared, with when (ms). */
  cleared?: Record<string, number>
  /** tasks-store `settling`: answers the user just gave that the host's data may not show yet. */
  settling?: Settling
  now?: number
}

/* -------------------------------------------------------------- constants */

/** 已完成 shows runs that ended within this window… */
export const FINISHED_WINDOW_MS = 24 * 3_600_000
/** …at most this many. */
export const MAX_FINISHED = 30
/** 排队与即将运行: the next runs of each project's schedules. */
export const UPCOMING_PER_PROJECT = 3
export const MAX_STEPS = 12

export const KIND_LABELS: Record<RunKind, string> = localized({ work: '后台工作', scheduled: '定时任务', learn: '学习', agents: '子任务组', other: '后台行动' })
/** Subagent roles in their working order, with short names for the group's phase line. */
export const ROLE_ORDER = ['scout', 'planner', 'worker', 'reviewer'] as const
const ROLE_SHORT: Record<string, string> = localized({ scout: '侦察', planner: '规划', worker: '实施', reviewer: '审查' })
const GROUP_STATE: Record<'running' | 'done', string> = localized({ running: '进行中', done: '已完成' })
/** Work kinds the 已完成 list keeps (a sent share or question is not background work). */
const FINISHED_KINDS = new Set(['work', 'learn'])
const LIVE_STATES = new Set<TaskState>(['running', 'paused'])
const ENDED_STATES = new Set<TaskState>(['done', 'failed', 'cancelled', 'review'])

/* ---------------------------------------------------------------- helpers */

/** A time as ms: ISO strings and epoch-ms numbers (P-5) both. */
export const toMs = (value?: string | number | null): number | null => (typeof value === 'number' ? (Number.isFinite(value) ? value : null)
  : value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null)

/** The project filter in effect: an explicit one, else the current project, else every project. */
export function resolveFilter(projectFilter: string | undefined, currentProjectId: string | null): string {
  if (projectFilter === 'all') return 'all'
  return projectFilter || currentProjectId || 'all'
}

/**
 * A run from the host's progress as the action snapshot would carry it, so lib/tasks names and classifies it — with
 * the user's marks (`attention`: the run's own, else the project's `taskMarks`), so a result they already answered is
 * not marked 需要你 again.
 */
export function actionFromRun(run: WorkRun, marks?: RunProjectInput['taskMarks']): InitiativeAction {
  const attention = run.attention ?? marks?.[run.id] ?? null
  return {
    id: run.id, action: run.kind === 'learn' ? 'learn' : 'work', status: run.status, label: run.title,
    createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.completedAt,
    ...(run.kind === 'scheduled' ? { hostSchedule: { scheduleId: run.scheduleId, key: run.occurrenceKey } } : {}),
    ...(run.errorCode ? { errorCode: run.errorCode } : {}), ...(run.summary ? { resultSummary: run.summary } : {}),
    availableControls: [], attention,
  }
}

const workRuns = (project: RunProjectInput) => [...(project.work?.running ?? []), ...(project.work?.recent ?? [])]

/**
 * The actions each project's rows come from: the snapshot the sidebar reads, plus runs only the host's progress knows
 * yet (it arrives on the index stream before the actions are read again; a host whose actions route lists nothing).
 * An action in both keeps the snapshot's row — its status and controls are what the sidebar shows.
 */
export function mergeWorkActions(projects: RunProjectInput[], actions: Record<string, InitiativeAction[] | undefined>): Record<string, InitiativeAction[]> {
  const out: Record<string, InitiativeAction[]> = {}
  for (const project of projects) {
    const rows = [...(actions[project.id] ?? [])]
    const known = new Set(rows.map(row => row.id))
    for (const run of workRuns(project)) if (!known.has(run.id)) { rows.push(actionFromRun(run, project.taskMarks)); known.add(run.id) }
    out[project.id] = rows
  }
  return out
}

/** 计划项 x/y for one run: plan items it staged (doing / next) or resolved (done). */
export function planProgress(plan: TaskProjectInput['plan'], actionId: string): RunPhase['plan'] {
  if (!plan) return null
  const rows = [...plan.doing, ...plan.next, ...plan.done].filter(row => row.actionId === actionId)
  return rows.length ? { done: rows.filter(row => row.status === 'done').length, total: rows.length } : null
}

/**
 * 计划项 x/y: the count the host makes from the run's own plan items when it sends one (null: the run has none);
 * else, from an older host, the project plan's rows the run staged or resolved — which miss what the summary's plan
 * cut (it keeps the last few done rows only).
 */
export function runPlan(run: Pick<WorkRun, 'plan'> | undefined, plan: TaskProjectInput['plan'], actionId: string): RunPhase['plan'] {
  if (run && run.plan !== undefined) return run.plan && run.plan.total > 0 ? { done: Math.min(run.plan.done, run.plan.total), total: run.plan.total } : null
  return planProgress(plan, actionId)
}

const OCCURRENCE_STAGES: Record<string, { run: RunStage; deliver: RunStage }> = {
  queued: { run: 'pending', deliver: 'pending' }, running: { run: 'active', deliver: 'pending' },
  delivery_pending: { run: 'done', deliver: 'active' }, delivered: { run: 'done', deliver: 'done' },
  failed: { run: 'failed', deliver: 'pending' }, needs_review: { run: 'attention', deliver: 'pending' }, cancelled: { run: 'stopped', deliver: 'pending' },
  // F9: a window skipped (paused, or past its period) never ran; an expired result ran but went to the inbox instead.
  skipped: { run: 'stopped', deliver: 'pending' }, expired: { run: 'done', deliver: 'stopped' },
}
const STATE_STAGES: Partial<Record<TaskState, { run: RunStage; deliver: RunStage }>> = {
  queued: OCCURRENCE_STAGES.queued, running: OCCURRENCE_STAGES.running, paused: { run: 'stopped', deliver: 'pending' }, review: OCCURRENCE_STAGES.needs_review,
  done: { run: 'done', deliver: 'pending' }, failed: OCCURRENCE_STAGES.failed, cancelled: OCCURRENCE_STAGES.cancelled,
}
/** 执行 → 交付 of a scheduled run: its occurrence's status (queued → running → delivery_pending → delivered), else the run's own state. */
export function deliveryStages(occurrence: Pick<Occurrence, 'status' | 'deliveredAt'> | null | undefined, state: TaskState): RunPhase['delivery'] {
  if (occurrence) return occurrence.deliveredAt ? OCCURRENCE_STAGES.delivered : OCCURRENCE_STAGES[occurrence.status] ?? STATE_STAGES[state] ?? null
  return STATE_STAGES[state] ?? null
}

const KNOWN_KINDS = new Set<string>(Object.keys(VERBS))
const asCall = (step: { name: string; kind: string; target: string | null }, status: string): ToolCall => ({
  name: step.name, ...(KNOWN_KINDS.has(step.kind) ? { kind: step.kind as ToolKind } : {}), ...(step.target ? { target: step.target } : {}), status,
})
/** A step as a verb (lib/tools): a started step without a target still reads 正在…, never 准备…. */
export function stepVerb(step: { name: string; kind: string; target: string | null }, status: StepStatus): string {
  if (status === 'ended') return ''
  const call = asCall(step, status)
  return status === 'running' && !step.target ? VERBS[toolKind(call)].running : toolVerb(call)
}
const stepView = (step: { name: string; kind: string; target: string | null }, status: StepStatus, at: number, id: string): RunStepView => ({
  id, name: step.name, kind: toolKind(asCall(step, status)), target: step.target, status, at, verb: stepVerb(step, status),
})

/**
 * The latest steps of one run, newest first: live starts (P-2) and the host's recorded latest step (with its outcome).
 * A live step is running only while it is the newest and the run is running; an earlier one has ended.
 */
export function runSteps(latest: WorkStep | null | undefined, live: LiveStep[] | undefined, running: boolean): RunStepView[] {
  const recorded = latest && toMs(latest.at) !== null ? latest : null
  const out: RunStepView[] = []
  const rows = [...(live ?? [])].sort((a, b) => (toMs(b.at) ?? 0) - (toMs(a.at) ?? 0))
  let recordedUsed = false
  rows.forEach((step, index) => {
    const at = toMs(step.at) ?? 0
    // The same step the host recorded (same tool and target, started within 2 s): its outcome is known.
    if (recorded && !recordedUsed && recorded.name === step.name && (recorded.target ?? null) === step.target && Math.abs((toMs(recorded.at) ?? 0) - at) < 2000) {
      recordedUsed = true
      out.push(stepView(recorded, recorded.status === 'running' && !(index === 0 && running) ? 'ended' : recorded.status, at, step.toolCallId))
      return
    }
    out.push(stepView(step, index === 0 && running ? 'running' : 'ended', at, step.toolCallId))
  })
  if (recorded && !recordedUsed) {
    const at = toMs(recorded.at)!
    const newer = out.some(row => row.at > at)
    out.push(stepView(recorded, recorded.status === 'running' && (newer || !running) ? 'ended' : recorded.status, at, `latest:${recorded.at}`))
  }
  return out.sort((a, b) => b.at - a.at).slice(0, MAX_STEPS)
}

/** A group's agents: the latest delegating turn's, in role order then start time. */
export function groupAgents(agents: SubagentInfo[] | undefined, turnId: string | null): SubagentInfo[] {
  const rows = (agents ?? []).filter(row => !turnId || row.turnId === turnId)
  const rank = (role?: string) => { const i = ROLE_ORDER.indexOf(role as typeof ROLE_ORDER[number]); return i < 0 ? ROLE_ORDER.length : i }
  return rows.sort((a, b) => rank(a.role) - rank(b.role) || (toMs(a.startedAt) ?? 0) - (toMs(b.startedAt) ?? 0))
}

/** 侦察 2/2 · 实施 1/2 · 审查 0/1: per role, finished (completed) of all, in working order. */
export function rolePhase(agents: SubagentInfo[]): RunPhase['roles'] {
  if (!agents.length) return null
  const roles = new Map<string, { role: string; label: string; done: number; total: number; running: number }>()
  for (const agent of agents) {
    const role = agent.role ?? 'other'
    const row = roles.get(role) ?? { role, label: ROLE_SHORT[role] || agent.roleName || t('其他'), done: 0, total: 0, running: 0 }
    row.total++
    if (agent.status === 'completed') row.done++
    if (agent.status === 'running') row.running++
    roles.set(role, row)
  }
  return [...roles.values()]
}

/** How long it has run (running) or ran (ended); null while queued, paused or without times. */
export function runElapsed(run: Pick<BackgroundRun, 'state' | 'startedAt' | 'endedAt'>, now: number): number | null {
  if (run.startedAt === null) return null
  if (run.state === 'running') return Math.max(0, (run.endedAt ?? now) - run.startedAt)
  return run.endedAt !== null ? Math.max(0, run.endedAt - run.startedAt) : null
}

/** Whether anything shown is live (the panel's clock ticks only then). */
export const anyLive = (view: Pick<BackgroundRunsView, 'running'>) => view.running.some(run => run.state === 'running')

/** The row a sidebar entry, a conversation line or a deep link points at: by row key, action / schedule id or session id. */
export function findRun(view: BackgroundRunsView, ref: string | null | undefined): BackgroundRun | null {
  if (!ref) return null
  const rows = [...view.attention, ...view.running, ...view.upcoming, ...view.finished]
  return rows.find(run => run.key === ref) ?? rows.find(run => run.id === ref) ?? null
}

/* ------------------------------------------------------------------ build */

const runKind = (action: Pick<InitiativeAction, 'action' | 'hostSchedule'>): RunKind => (action.hostSchedule ? 'scheduled' : action.action === 'work' ? 'work' : action.action === 'learn' ? 'learn' : 'other')

function actionRun(project: RunProjectInput, entry: TaskEntry, action: InitiativeAction | undefined, live: LiveStep[] | undefined, sessions: Set<string>): BackgroundRun {
  const run = workRuns(project).find(row => row.id === entry.id)
  const kind = action ? runKind(action) : 'other'
  const scheduleId = action?.hostSchedule?.scheduleId ?? run?.scheduleId ?? null
  const occurrenceKey = action?.hostSchedule?.key ?? run?.occurrenceKey ?? null
  const schedule: Schedule | undefined = scheduleId ? project.schedules?.find(row => row.id === scheduleId) : undefined
  const ended = ENDED_STATES.has(entry.state)
  // The current stretch: since it was last resumed while running; the whole run once it ended. A run that ended
  // without starting (cancelled while queued) has none: no elapsed time, no executor.
  const startedAt = toMs(ended ? undefined : run?.resumedAt) ?? toMs(run?.startedAt ?? action?.startedAt ?? action?.receipt?.startedAt)
    ?? (entry.state === 'queued' || ended ? null : toMs(run?.createdAt ?? action?.createdAt))
  const endedAt = ended ? toMs(run?.completedAt ?? action?.finishedAt ?? action?.receipt?.finishedAt) : null
  const steps = runSteps(run?.latest, live, entry.state === 'running')
  const change = project.backgroundChanges?.find(row => (run?.changeId ? row.id === run.changeId : row.actionId === entry.id))
  // The index row keeps the latest, open and `work`-listed occurrences; an older finished run's comes with its action.
  const occurrence = kind === 'scheduled' ? project.scheduleRuntime?.occurrences?.find(row => (occurrenceKey && row.key === occurrenceKey) || row.actionId === entry.id) ?? action?.occurrence ?? undefined : undefined
  const destination = schedule?.destinationSessionId && sessions.has(schedule.destinationSessionId) ? schedule.destinationSessionId : null
  const primary = project.primarySessionId && sessions.has(project.primarySessionId) ? project.primarySessionId : null
  const started = entry.state !== 'queued' && !(ended && startedAt === null)
  return {
    key: entry.key, id: entry.id, projectId: project.id, projectName: project.name, kind,
    kindLabel: kind === 'other' ? ACTION_LABELS[entry.actionKind ?? ''] ?? KIND_LABELS.other : KIND_LABELS[kind],
    // A scheduled run reads as its schedule (the kind label already says 定时任务).
    title: (kind === 'scheduled' && schedule?.title?.replace(/\s+/g, ' ').trim()) || entry.title,
    section: LIVE_STATES.has(entry.state) ? 'running' : entry.state === 'queued' ? 'upcoming' : 'finished',
    state: entry.state, stateLabel: entry.stateLabel, task: entry,
    startedAt, endedAt, at: endedAt ?? entry.at, when: entry.when,
    agents: started && (kind === 'work' || kind === 'scheduled' || kind === 'learn') ? 1 : null,
    tokens: run && run.tokens.total > 0 ? { total: run.tokens.total, estimated: run.tokens.estimated } : null,
    model: run?.model?.name || null,
    summary: (ended ? run?.summary || entry.summary : entry.summary) ?? '',
    phase: {
      plan: runPlan(run, project.plan, entry.id),
      steps: run && started && (run.steps.total > 0 || entry.state === 'running') ? { completed: run.steps.completed, total: run.steps.total, failed: run.steps.failed, uncertain: run.steps.uncertain } : null,
      delivery: kind === 'scheduled' ? deliveryStages(occurrence, entry.state) : null,
      roles: null,
    },
    latest: LIVE_STATES.has(entry.state) ? steps[0] ?? null : null, steps,
    changeId: run?.changeId ?? change?.id ?? null, changeCount: change?.count ?? null,
    sessionId: kind === 'scheduled' ? destination ?? primary : primary,
    scheduleId, occurrenceKey, turnId: null,
    controls: entry.controls, flags: entry.flags,
  }
}

function scheduleRun(project: RunProjectInput, entry: TaskEntry): BackgroundRun {
  const schedule = project.schedules?.find(row => row.id === entry.id)
  return {
    key: entry.key, id: entry.id, projectId: project.id, projectName: project.name, kind: 'scheduled', kindLabel: KIND_LABELS.scheduled,
    title: entry.title, section: 'upcoming', state: entry.state, stateLabel: entry.stateLabel, task: entry,
    startedAt: null, endedAt: null, at: entry.at, when: entry.when, agents: null, tokens: null, model: null, summary: entry.rule ?? '',
    phase: { plan: null, steps: null, delivery: null, roles: null }, latest: null, steps: [], changeId: null, changeCount: null,
    // Marks about its last run (新结果, 未完成) belong to that run, not to the next one; only 已错过 is about this one.
    sessionId: schedule?.destinationSessionId ?? null, scheduleId: entry.id, occurrenceKey: null, turnId: null, controls: [], flags: entry.flags.filter(flag => flag === 'overdue'),
  }
}

function groupRun(session: SessionSummary, project: RunProjectInput | undefined, details: SubagentInfo[] | undefined, now: number): BackgroundRun {
  const summary = session.agents!
  const running = summary.running > 0
  const agents = groupAgents(details, summary.latestTurnId)
  const starts = agents.map(row => toMs(row.startedAt)).filter((v): v is number => v !== null)
  const ends = agents.map(row => toMs(row.endedAt)).filter((v): v is number => v !== null)
  const startedAt = starts.length ? Math.min(...starts) : null
  const endedAt = !running && ends.length ? Math.max(...ends) : null
  const current = agents.find(row => row.status === 'running')
  const last = [...agents].reverse().find(row => row.summary)
  const line = running
    ? current?.task || t('{running} 个子代理进行中，共 {total} 个', { running: summary.running, total: summary.total })
    : last?.summary || (summary.total > 1 ? t('{total} 个子代理都已结束', { total: summary.total }) : t('子代理已结束'))
  const at = endedAt ?? toMs(session.lastItemAt ?? session.updatedAt) ?? now
  return {
    key: `${session.projectId ?? 'none'}:agents:${session.id}`, id: session.id, projectId: session.projectId ?? null, projectName: project?.name ?? '',
    kind: 'agents', kindLabel: KIND_LABELS.agents, title: session.title || KIND_LABELS.agents,
    section: running ? 'running' : 'finished', state: running ? 'running' : 'done', stateLabel: GROUP_STATE[running ? 'running' : 'done'], task: null,
    startedAt, endedAt, at, when: '', agents: summary.total, tokens: summary.tokens > 0 ? { total: summary.tokens, estimated: agents.some(row => row.usage?.estimated) } : null,
    model: agents.find(row => row.model?.name)?.model?.name ?? null,
    summary: line.replace(/\s+/g, ' ').trim(),
    phase: { plan: null, steps: null, delivery: null, roles: rolePhase(agents) },
    latest: null, steps: [], changeId: null, changeCount: null, sessionId: session.id, scheduleId: null, occurrenceKey: null,
    turnId: summary.latestTurnId, controls: [], flags: [],
  }
}

const byStart = (a: BackgroundRun, b: BackgroundRun) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.key.localeCompare(b.key)
const byQueue = (a: BackgroundRun, b: BackgroundRun) => (a.kind === 'scheduled' && a.task?.kind === 'schedule' ? 1 : 0) - (b.kind === 'scheduled' && b.task?.kind === 'schedule' ? 1 : 0) || (a.at ?? Infinity) - (b.at ?? Infinity) || a.key.localeCompare(b.key)
const byEnd = (a: BackgroundRun, b: BackgroundRun) => (b.at ?? 0) - (a.at ?? 0) || a.key.localeCompare(b.key)

/** The panel's three sections for the projects in `filter`. */
export function backgroundRuns(input: BackgroundRunsInput): BackgroundRunsView {
  const now = input.now ?? Date.now()
  const projects = input.projects.filter(project => input.filter === 'all' || project.id === input.filter)
  const byId = new Map(projects.map(project => [project.id, project]))
  const merged = mergeWorkActions(projects, input.actions)
  // lib/tasks decides which projects count, each action's state, title, controls and marks — as for the sidebar.
  const entries = aggregateTasks(projects, merged, { emergency: input.emergency, sessions: input.sessions, ended: true, settling: input.settling }, now)
  const sessionIds = new Set(input.sessions.filter(row => !row.archivedAt).map(row => row.id))

  const attention: BackgroundRun[] = [], running: BackgroundRun[] = [], upcoming: BackgroundRun[] = [], finished: BackgroundRun[] = []
  const nextRuns = new Map<string, BackgroundRun[]>()
  for (const entry of entries) {
    const project = byId.get(entry.projectId)!
    if (entry.kind === 'schedule') {
      if (entry.state !== 'scheduled' || entry.at === null) continue
      nextRuns.set(project.id, [...(nextRuns.get(project.id) ?? []), scheduleRun(project, entry)])
      continue
    }
    if (entry.kind !== 'action') continue
    const action = merged[project.id]?.find(row => row.id === entry.id)
    const run = actionRun(project, entry, action, input.live?.[entry.id], sessionIds)
    if (run.section === 'running') running.push(run)
    else if (run.section === 'upcoming') upcoming.push(run)
    // Not done until the user has looked: it waits at the top, not among the results of the last day.
    else if (needsUser(entry)) attention.push({ ...run, section: 'attention' })
    else if (FINISHED_KINDS.has(entry.actionKind ?? '') && run.at !== null && now - run.at <= FINISHED_WINDOW_MS) finished.push(run)
  }
  for (const rows of nextRuns.values()) upcoming.push(...rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).slice(0, UPCOMING_PER_PROJECT))

  // Subagent groups (P-4): live ones, and ones that ended within the window. A conversation outside a project shows
  // under 全部 only; one in a project shows when lib/tasks would list that project's work (same rule as aggregateTasks).
  for (const session of input.sessions) {
    const agents = session.agents
    if (!agents || !(agents.total > 0) || session.archivedAt || session.kind === 'side') continue
    const project = session.projectId ? byId.get(session.projectId) : undefined
    if (session.projectId ? !project || project.archivedAt || project.simulated === true || project.decisionMode === 'demo-policy' : input.filter !== 'all') continue
    const run = groupRun(session, project, input.agents?.[session.id], now)
    if (run.section === 'running') running.push(run)
    else if (run.at !== null && now - run.at <= FINISHED_WINDOW_MS) finished.push(run)
  }

  // 清除 hides what ended before it was pressed, never what still needs the user.
  const cleared = input.cleared ?? {}
  const shown = finished.filter(run => !(run.key in cleared && (run.at ?? 0) <= cleared[run.key] && !(run.task && needsUser(run.task))))
  return {
    attention: attention.sort(byEnd),
    running: running.sort(byStart),
    upcoming: upcoming.sort(byQueue),
    finished: shown.sort(byEnd).slice(0, MAX_FINISHED),
    counts: {
      active: sidebarTaskGroups(entries).active.length,
      attention: attention.length, running: running.length, upcoming: upcoming.length, finished: Math.min(shown.length, MAX_FINISHED), cleared: finished.length - shown.length,
    },
  }
}
