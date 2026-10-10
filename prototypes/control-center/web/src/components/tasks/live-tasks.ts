/**
 * The background work every live count reads — the sidebar's 进行中, the top
 * bar's badge, the strip above the composer — from the one list the 任务 page
 * reads too (tasks-store `useGlobalTasks`: the actions read plus the runs only
 * the host's progress lists yet, merged as the 后台任务 panel merges them), so
 * they never disagree.
 */
import { globalTaskEntries, useGlobalTasks } from '@/store/tasks-store'
import { sidebarTaskGroups, type TaskEntry } from '@/lib/tasks'

/** Every project's open work and schedules, with the runs only `summary.work` lists yet. */
export const liveTaskEntries = globalTaskEntries

/** 进行中 — running, queued and paused background actions — of one project, or of all: the number the panel header shows. */
export const activeCount = (entries: TaskEntry[], projectId?: string | null) =>
  sidebarTaskGroups(projectId ? entries.filter(entry => entry.projectId === projectId) : entries).active.length

/** Reactive: open work across projects (shared by every reader for the same store values). */
export const useLiveTasks = (): TaskEntry[] => useGlobalTasks()
