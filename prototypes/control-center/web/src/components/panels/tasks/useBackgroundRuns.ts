/**
 * The tasks panel's view of the stores: project summaries and sessions (index
 * stream), the actions snapshot the sidebar reads, live steps and loaded
 * subagent lists, merged by lib/background-runs. Also the viewer's 清除 of
 * finished rows, kept in this browser only (a convenience, never shared).
 */
import { useCallback, useMemo, useState } from 'react'
import { useApp } from '@/store/app-store'
import { useTasks } from '@/store/tasks-store'
import { useBackgroundLive } from '@/store/background-live'
import { backgroundRuns, type BackgroundRun, type BackgroundRunsView, type RunProjectInput } from '@/lib/background-runs'
import { useSessionAgents } from './agents-store'

export const CLEARED_KEY = 'rna.tasksPanel.cleared'
/** A cleared mark outlives the 24 h list it hides by a day, then it is dropped. */
const CLEARED_TTL_MS = 48 * 3_600_000

export function readCleared(now = Date.now()): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(CLEARED_KEY) ?? '{}') as Record<string, unknown>
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && now - entry[1] < CLEARED_TTL_MS))
  } catch { return {} }
}
function writeCleared(value: Record<string, number>) {
  try { localStorage.setItem(CLEARED_KEY, JSON.stringify(value)) } catch { /* private mode: cleared for this view only */ }
}

export function useBackgroundRuns(filter: string): { view: BackgroundRunsView; loading: boolean; clear: (rows: BackgroundRun[]) => void; restore: () => void; countAll: () => number } {
  const status = useApp(s => s.status)
  const projects = useApp(s => s.projects)
  const projectOrder = useApp(s => s.projectOrder)
  const sessionIndex = useApp(s => s.sessionIndex)
  const emergency = useApp(s => s.emergency)
  const actions = useTasks(s => s.actions)
  const settling = useTasks(s => s.settling)
  const loaded = useTasks(s => s.loaded)
  const live = useBackgroundLive(s => s.steps)
  const agents = useSessionAgents(s => s.lists)
  const [cleared, setCleared] = useState(() => readCleared())

  const list = useMemo(() => projectOrder.map(id => projects[id]).filter(Boolean) as unknown as RunProjectInput[], [projects, projectOrder])
  const sessions = useMemo(() => Object.values(sessionIndex), [sessionIndex])
  // settling: answers the user just gave (不用了 / 接着做) leave 需要你 at once, as on the 任务 page and the sidebar.
  const input = useMemo(() => ({ projects: list, actions, sessions, live, agents, emergency, cleared, settling }), [list, actions, sessions, live, agents, emergency, cleared, settling])
  const view = useMemo(() => backgroundRuns({ ...input, filter }), [input, filter])
  const countAll = useCallback(() => {
    const all = backgroundRuns({ ...input, filter: 'all' })
    return all.attention.length + all.running.length + all.upcoming.length + all.finished.length
  }, [input])

  const clear = useCallback((rows: BackgroundRun[]) => {
    const now = Date.now()
    const next = { ...readCleared(now), ...Object.fromEntries(rows.map(row => [row.key, now])) }
    writeCleared(next)
    setCleared(next)
  }, [])
  const restore = useCallback(() => { writeCleared({}); setCleared({}) }, [])

  // Loading until the index has arrived and, unless the host already sent progress, the first actions read is back.
  const hasWork = list.some(project => project.work)
  return { view, loading: status !== 'ready' || (!loaded && !hasWork), clear, restore, countAll }
}
