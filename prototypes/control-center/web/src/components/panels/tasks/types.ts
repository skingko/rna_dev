/** What the tasks panel asks its host to open, and the panel's props (the integration registers it as the 'tasks' tab). */

export interface TasksPanelRefs {
  /** A background change set (change-review tab); `focus` = the file to show first. */
  change: { projectId: string; changeId: string; focus?: string | null }
  file: { projectId: string; path: string }
  preview: { projectId: string; url?: string | null }
  /** The conversation a run reports to; `actionId` / `occurrenceKey` name the line to scroll to when the host can find it. */
  conversation: { projectId: string | null; sessionId: string; actionId?: string | null; occurrenceKey?: string | null }
}
export type TasksPanelOpenKind = keyof TasksPanelRefs
export type OpenTab = <K extends TasksPanelOpenKind>(kind: K, ref: TasksPanelRefs[K]) => void

export interface BackgroundTasksPanelProps {
  /** 'all', a project id, or absent = follow the current project. */
  projectFilter?: string | 'all'
  /** A run to bring into view and expand: a row key (`<project>:action:<id>`), an action / schedule id or a session id. */
  focusRunId?: string | null
  /** Called with `focusRunId` once that run is in view (opened and scrolled to): the host can drop the one-off focus. */
  onFocusApplied?: (focusRunId: string) => void
  currentProjectId: string | null
  /** The panel is on screen (its group is visible and this tab active); the elapsed clock ticks only then. Default true. */
  visible?: boolean
  onOpenTab: OpenTab
  /** `undefined` = follow the current project again. */
  onFilterChange: (next: string | 'all' | undefined) => void
}
