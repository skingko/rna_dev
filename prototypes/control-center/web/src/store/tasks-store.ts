/**
 * H3 global tasks state. Schedules ride on the project summaries (index
 * stream); background actions need `/api/projects/:id/initiative/actions`,
 * which we refetch per project whenever that project's summary signature
 * moves (debounced), so the sidebar stays live without polling.
 */
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { projectApi, type InitiativeAction } from '@/api/project-api'
import type { SessionSummary } from '@/api/types'
import { ApiError } from '@/api/transport'
import { aggregateTasks, learningTasks, planTasks, settlePlan, type LearningTreeLike, type PlanStatus, type Settling, type TaskAnswer, type TaskControl, type TaskEntry, type TaskProjectInput, type TaskSettle } from '@/lib/tasks'
import { mergeWorkActions, type RunProjectInput } from '@/lib/background-runs'
import { genesApi } from '@/api/genes-api'
import { mindApi } from '@/api/mind-api'
import { invalidateProject } from '@/components/views/useProjectDetail'
import { useApp } from './app-store'
import { toast } from './ui-store'
import { t as tr, localized } from '@/i18n'

interface TasksState {
  actions: Record<string, InitiativeAction[] | undefined>
  /** Evolution trees, only while the 任务 page is open (自主学习 rows). */
  learning: Record<string, LearningTreeLike | undefined>
  loaded: boolean
  busy: string | null
  /** The user's answers and plan changes the host's data may not show yet, by task key (lib/tasks TaskSettle). */
  settling: Settling
}

export const useTasks = create<TasksState>(() => ({ actions: {}, learning: {}, loaded: false, busy: null, settling: {} }))

const inflight = new Map<string, Promise<void>>()

/**
 * Re-read a project's actions. Calls while one read runs share it; `fresh`: after a decision the host just saved (a card
 * answered, a review recorded), a read that started before it may return the old row, so wait for it and read again.
 */
export function refreshActions(projectId: string, { fresh = false }: { fresh?: boolean } = {}): Promise<void> {
  const running = inflight.get(projectId)
  if (running) return fresh ? running.then(() => refreshActions(projectId)) : running
  const task = projectApi.actions(projectId)
    .then(snapshot => useTasks.setState(s => ({ actions: { ...s.actions, [projectId]: snapshot.actions ?? [] } })))
    .catch(error => {
      // Older daemons / demo projects: no actions route. Keep schedules visible.
      if (!(error instanceof ApiError) || error.status !== 404) console.warn('[tasks] actions', projectId, error)
      useTasks.setState(s => ({ actions: { ...s.actions, [projectId]: s.actions[projectId] ?? [] } }))
    })
    .finally(() => inflight.delete(projectId))
  inflight.set(projectId, task)
  return task
}

type SummaryLike = TaskProjectInput & { updatedAt?: string; initiativeRuntime?: { status?: string } | null; counts?: { jobs?: number; openTasks?: number } }
const signatureOf = (p: SummaryLike) => JSON.stringify([p.updatedAt, p.initiativeRuntime?.status, p.counts?.jobs, p.counts?.openTasks, p.archivedAt])

/** Mount once (App): keeps every live project's action snapshot current. */
export function useTaskSync() {
  const status = useApp(s => s.status)
  const projects = useApp(s => s.projects)
  const signatures = useMemo(() => {
    const out: Record<string, string> = {}
    for (const p of Object.values(projects) as SummaryLike[]) if (!p.archivedAt && p.simulated !== true) out[p.id] = signatureOf(p)
    return out
  }, [projects])
  const key = JSON.stringify(signatures)
  useEffect(() => {
    if (status !== 'ready') return
    const ids = Object.keys(signatures)
    const first = !useTasks.getState().loaded
    const t = setTimeout(() => {
      void Promise.all(ids.map(id => refreshActions(id))).then(() => useTasks.setState({ loaded: true }))
    }, first ? 0 : 900)
    return () => clearTimeout(t)
  }, [status, key]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** Mount on the 任务 page: each live project's evolution record, refreshed when the project moves. */
export function useLearningSync() {
  const status = useApp(s => s.status)
  const projects = useApp(s => s.projects)
  const key = JSON.stringify(Object.values(projects as Record<string, SummaryLike>).filter(p => !p.archivedAt && p.simulated !== true).map(p => [p.id, p.updatedAt]))
  useEffect(() => {
    if (status !== 'ready') return
    const ids = (JSON.parse(key) as [string, string][]).map(([id]) => id)
    const timer = setTimeout(() => {
      for (const id of ids) void genesApi.tree(id).then(tree => useTasks.setState(s => ({ learning: { ...s.learning, [id]: tree } }))).catch(() => { /* older daemon: no evolution record */ })
    }, 300)
    return () => clearTimeout(timer)
  }, [status, key])
}

/**
 * Every project's tasks over the actions read plus the runs only the host's progress (`summary.work`) lists yet, merged
 * as lib/background-runs merges them for the 后台任务 panel — so the 任务 page, the sidebar's 进行中, the top bar's badge,
 * the strip above the composer and the panel never count differently (the actions are read about a second after the
 * progress arrives).
 */
export function globalTaskEntries(projects: RunProjectInput[], actions: Record<string, InitiativeAction[] | undefined>, opts: { emergency?: boolean; sessions?: SessionSummary[]; ended?: boolean; settling?: Settling } = {}, now = Date.now()): TaskEntry[] {
  return aggregateTasks(projects, mergeWorkActions(projects, actions), opts, now)
}

type Inputs = readonly unknown[]
/** The last list per variant, reused while its store values are the same (several readers render at once). */
const shared: Partial<Record<'live' | 'ended', { inputs: Inputs; entries: TaskEntry[] }>> = {}
function sharedEntries(key: 'live' | 'ended', inputs: Inputs, build: () => TaskEntry[]): TaskEntry[] {
  const last = shared[key]
  if (last && last.inputs.length === inputs.length && inputs.every((value, i) => value === last.inputs[i])) return last.entries
  const entries = build()
  shared[key] = { inputs, entries }
  return entries
}

/** The aggregated, ordered task list across all projects. `ended` adds finished work, the plan and 自主学习 (the 任务 page). */
export function useGlobalTasks({ ended = false }: { ended?: boolean } = {}): TaskEntry[] {
  const projects = useApp(s => s.projects)
  const projectOrder = useApp(s => s.projectOrder)
  const sessionIndex = useApp(s => s.sessionIndex)
  const emergency = useApp(s => s.emergency)
  const actions = useTasks(s => s.actions)
  const learning = useTasks(s => s.learning)
  const settling = useTasks(s => s.settling)
  const inputs = ended ? [projects, projectOrder, sessionIndex, emergency, actions, settling, learning] : [projects, projectOrder, sessionIndex, emergency, actions, settling]
  return sharedEntries(ended ? 'ended' : 'live', inputs, () => {
    const list = projectOrder.map(id => projects[id]).filter(Boolean) as unknown as RunProjectInput[]
    const tasks = globalTaskEntries(list, actions, { emergency, sessions: Object.values(sessionIndex), ended, settling })
    return ended ? [...tasks, ...settlePlan(list.flatMap(project => [...planTasks(project), ...learningTasks(project, learning[project.id])]), settling)] : tasks
  })
}

const DONE: Record<string, string> = localized({ pause: '已请求暂停，当前工具批次结束后保存进度。', resume: '已请求继续，将从保留进度接续。', stop: '已请求停止，等待当前工具批次结束。', steer: '调整已提交，将在后台工作接续时处理。' })

/** pause / resume / stop / steer a background action against its latest control revision. */
export async function controlTask(task: TaskEntry, operation: TaskControl, text?: string) {
  if (useTasks.getState().busy) return
  useTasks.setState({ busy: task.key })
  try {
    const snapshot = await projectApi.actions(task.projectId)
    const action = snapshot.actions.find(a => a.id === task.id)
    if (!action || !Number.isSafeInteger(action.controlRevision)) throw new Error(tr('后台状态已变化，请查看最新状态。'))
    if (!action.availableControls?.includes(operation)) throw new Error(tr('此行动当前不支持这项操作，请查看最新状态。'))
    const result = await projectApi.controlAction(task.projectId, task.id, { action: operation, requestId: crypto.randomUUID(), expectedRevision: action.controlRevision!, ...(text ? { text } : {}) })
    if (result?.receipt?.status === 'rejected') throw new Error(tr('这项调整未执行：{v}', { v: result.receipt.summary || tr('请查看最新执行记录。') }))
    toast(result?.action?.status === 'paused' ? tr('已暂停这项后台工作。') : result?.action?.status === 'cancelled' ? tr('已停止这项后台工作，执行记录保留。') : DONE[operation])
  } catch (error) {
    toast((error as Error).message, 'danger')
    throw error
  } finally {
    invalidateProject(task.projectId)
    useTasks.setState({ busy: null })
    void refreshActions(task.projectId)
  }
}

/** Pause or resume a schedule (the index stream carries the new summary). */
export async function toggleSchedule(task: TaskEntry) {
  if (useTasks.getState().busy || task.kind !== 'schedule') return
  useTasks.setState({ busy: task.key })
  try {
    await projectApi.updateSchedule(task.projectId, task.id, { enabled: !task.enabled })
    invalidateProject(task.projectId)
    toast(task.enabled ? tr('已暂停日程，不再安排新的执行。') : tr('已恢复日程。'))
  } catch (error) { toast(tr('日程未保存：{message}', { message: (error as Error).message }), 'danger') } finally { useTasks.setState({ busy: null }) }
}

/* ------------------------------------------------ answers, plan changes, 清理 */

function settle(key: string, value: TaskSettle | null) {
  useTasks.setState(s => {
    if (!value && !(key in s.settling)) return {}
    const settling = { ...s.settling }
    if (value) settling[key] = value
    else delete settling[key]
    return { settling }
  })
}
/** Once the actions read carries the answer, the row reads it from there. A run only the host's progress lists keeps it until the summary has it. */
function forgetAnswered(task: TaskEntry) {
  const action = useTasks.getState().actions[task.projectId]?.find(row => row.id === task.id)
  if (action?.attention?.acknowledgedAt) settle(task.key, null)
}

export type Outcome = { ok: true } | { ok: false; message: string }
const ANSWERED: Record<TaskAnswer, string> = localized({ continue: '已在项目对话里接着做', keep: '已按现在的结果算完成', acknowledge: '好，不再算作需要你。', drop: '已处理，不再提醒' })

/**
 * The user's answer on background work that waits for them (接着做 / 不用了 / 按现在的算 / 知道了), from a row, the
 * inspector, the 后台任务 panel or 清理…: it reads answered at once everywhere (the sidebar's 需要处理, the page's and the
 * panel's 需要你), and as before if the host refuses. `quiet`: no toast (清理… reports the batch); `refresh: false`: the
 * caller reads the actions again once for several answers.
 */
export async function answerTask(task: TaskEntry, choice: TaskAnswer, { quiet = false, refresh = true }: { quiet?: boolean; refresh?: boolean } = {}): Promise<Outcome> {
  settle(task.key, { kind: 'answer', choice, at: new Date().toISOString() })
  try {
    await projectApi.answerTask(task.projectId, task.id, choice)
    if (!quiet) toast(ANSWERED[choice])
    return { ok: true }
  } catch (error) {
    const message = (error as Error).message
    // A run with nothing left to carry on: the host records it answered before it refuses 接着做 (its message says so),
    // so it no longer waits on the user either way.
    const answered = error instanceof ApiError && error.code === 'task_context_revoked'
    if (!answered) settle(task.key, null)
    if (!quiet) toast(message, answered ? 'default' : 'danger')
    return { ok: false, message }
  } finally {
    // A read already running may predate this answer: read again after it (the conversation's notice reads it too).
    if (refresh) void refreshActions(task.projectId, { fresh: true }).then(() => forgetAnswered(task))
  }
}

const PLAN_SET: Record<PlanStatus, string> = localized({ done: '已标记完成。', dropped: '好，这项不做了。', open: '已放回计划。' })

/**
 * Mark a plan line done or dropped (or `open`: back where it was, the undo). The line leaves the open list at once and
 * comes back if the host refuses; the project summary brings the plan as the host has it. Done and dropped offer 撤销.
 */
export async function setPlanStatus(task: TaskEntry, status: PlanStatus, { quiet = false }: { quiet?: boolean } = {}): Promise<Outcome> {
  settle(task.key, status === 'open' ? null : { kind: 'plan', status, since: task.at, at: Date.now() })
  try {
    await mindApi.setAgendaStatus(task.projectId, task.id, status)
    invalidateProject(task.projectId)
    if (!quiet) toast(PLAN_SET[status], 'default', status === 'open' ? {} : { action: { label: tr('撤销'), run: () => void setPlanStatus(task, 'open') } })
    return { ok: true }
  } catch (error) {
    if (status !== 'open') settle(task.key, null)
    const message = (error as Error).message
    if (!quiet) toast(tr('计划没有改：{message}', { message }), 'danger')
    return { ok: false, message }
  }
}

export interface CleanupResult { cleared: TaskEntry[]; failed: { task: TaskEntry; message: string }[] }

/**
 * 清理…: settle tasks one by one — failed background work is let go (不用了: no more reminders, its record stays), plan
 * lines are dropped (不再做) — telling `onProgress` how many are through; then each project's actions are read again once.
 */
export async function clearTasks(rows: TaskEntry[], onProgress?: (done: number) => void): Promise<CleanupResult> {
  const result: CleanupResult = { cleared: [], failed: [] }
  for (const [index, task] of rows.entries()) {
    const outcome = task.kind === 'plan' ? await setPlanStatus(task, 'dropped', { quiet: true }) : await answerTask(task, 'drop', { quiet: true, refresh: false })
    if (outcome.ok) result.cleared.push(task)
    else result.failed.push({ task, message: outcome.message })
    onProgress?.(index + 1)
  }
  const touched = [...new Set(rows.filter(row => row.kind === 'action').map(row => row.projectId))]
  await Promise.all(touched.map(id => refreshActions(id, { fresh: true })))
  for (const task of result.cleared) if (task.kind === 'action') forgetAnswered(task)
  return result
}
