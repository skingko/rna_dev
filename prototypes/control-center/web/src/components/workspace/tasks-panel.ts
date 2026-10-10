/**
 * The 后台任务 panel's entry points and its automatic opening (design 2.1,
 * 2.5, decision D4).
 *
 * Entry points — a running, queued or paused sidebar row, the strip above the
 * composer, a conversation's 查看进度, the top bar badge and the launcher card
 * — open the window's one `tasks` tab, focused on a run when they name one.
 * What the panel opens in turn (a change set, a file, a preview) goes beside
 * it (`besideType: 'tasks'`, contract P-7); a run's conversation opens in the
 * main cell at the line that reports it.
 *
 * Automatic opening: when the current project goes from no running run to
 * one, the panel shows by itself — expanded with 后台任务 in front when the
 * panels were collapsed (nothing was being read), added behind the shown tab
 * when they were open. Closing the tab or collapsing the panels while that
 * project has a run going keeps it from opening by itself there again until
 * the user opens it — an entry point, picking its tab in a strip, or undo /
 * ⇧⌘T bringing it back (remembered in this browser). A tab evicted past the
 * tab cap was not closed by the user. Other projects' runs only count on the
 * badges. 设置 → 外观 turns it off (`tasksAutoOpen`). It never
 * opens over the conversation (a phone, or a window too narrow for the two
 * side by side); the badge still counts the run.
 */
import { useEffect } from 'react'
import type { InitiativeAction } from '@/api/project-api'
import type { SessionSummary } from '@/api/types'
import { locateRun } from '@/api/client'
import { bindingMatches, computeRects, groupIds, MIN_GROUP, MIN_MAIN, tabGroupId, type LayoutState, type Size } from '@/lib/dock'
import { backgroundRuns, resolveFilter, type RunProjectInput } from '@/lib/background-runs'
import { useApp } from '@/store/app-store'
import { useTasks } from '@/store/tasks-store'
import type { SessionSlice } from '@/store/session-model'
import { selectSession } from '@/store/sync'
import { openSessionItem } from '@/store/deep-link'
import {
  activateTab, closeTab, onTabClosed, onTabPicked, openTab, panelsOpen, setPanelOpen, tabOnScreen, useSidePanel, type OpenOptions, type ScreenView, type SideTab,
  type WorkspaceCtx,
} from '@/store/side-panel-store'
import { openDock, toast, useUi } from '@/store/ui-store'
import { usePreferences } from '@/components/settings/preferences'
import { openPreviewTab } from '@/components/side-panel/open'
import { focusTimelineItem, FOCUS_TTL_MS } from '@/components/timeline/timeline-focus'
import type { TasksPanelOpenKind, TasksPanelRefs } from '@/components/panels/tasks/types'
import { t } from '@/i18n'
import { CARD_GAP } from './cells'

type TasksTab = Extract<SideTab, { type: 'tasks' }>

/* ----------------------------------------------------------- the tab */

/** The window's 后台任务 tab, when one is open. */
export function tasksTab(layout: LayoutState<SideTab> = useSidePanel.getState().layout): TasksTab | null {
  return (Object.values(layout.tabs).find(tab => tab.type === 'tasks') as TasksTab | undefined) ?? null
}

/**
 * Whether 后台任务 is on screen in `ctx`: the panels show, its group is drawn — not minimized, squeezed onto an edge
 * strip, behind a maximized or narrow-window overlay group — and shows it; on the phone sheet, it is the sheet's tab.
 * `view` is the workspace's measured size and sheet (the store's); without a size only minimize and maximize count.
 */
export function tasksShown(layout: LayoutState<SideTab>, ctx: WorkspaceCtx, view: Partial<Pick<ScreenView, 'viewport' | 'sheet'>> = {}): boolean {
  const tab = tasksTab(layout)
  return tab !== null && tabOnScreen(tab.id, { layout, ctx, viewport: view.viewport, sheet: view.sheet })
}

/** Reactive `tasksShown` for the selected conversation (the top bar badge's pressed state). */
export const useTasksPanelShown = () => useSidePanel(s => tasksShown(s.layout, s.ctx, s))

/* ------------------------------------------------- not opening by itself */

export const QUIET_KEY = 'rna.tasksPanel.quiet'
/** Projects the panel no longer opens by itself in (a per-viewer convenience; kept in memory when storage is unavailable). */
let quiet: Set<string> | null = null

function quietProjects(): Set<string> {
  if (quiet) return quiet
  try {
    const value = JSON.parse(localStorage.getItem(QUIET_KEY) ?? '[]') as unknown
    quiet = new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])
  } catch { quiet = new Set() }
  return quiet
}

function setQuiet(projectId: string, value: boolean) {
  const set = quietProjects()
  if (set.has(projectId) === value) return
  if (value) set.add(projectId)
  else set.delete(projectId)
  try { localStorage.setItem(QUIET_KEY, JSON.stringify([...set])) } catch { /* private mode: for this page only */ }
}

export const isQuiet = (projectId: string) => quietProjects().has(projectId)

/** Test helper: forget the quiet projects (memory and storage). */
export function resetTasksQuiet() {
  quiet = null
  try { localStorage.removeItem(QUIET_KEY) } catch { /* ignore */ }
}

/* -------------------------------------------------------- entry points */

export interface OpenTasksOptions {
  /** A run to bring into view: a row key (`<project>:action:<id>`), an action / schedule id or a session id. */
  focusRunId?: string | null
  /** The run's (or the asking surface's) project: the panel's filter changes only when it would hide that project. */
  projectId?: string | null
}

/**
 * The user opens 后台任务 (and so, for the current project and `projectId`, wants it opening by itself again).
 * A filter that already shows the project stays; otherwise the panel follows the current project, or shows the run's.
 * @returns the tab id.
 */
export function openTasksPanel({ focusRunId = null, projectId = null }: OpenTasksOptions = {}, place: Pick<OpenOptions, 'replace' | 'target'> = {}): string {
  const { layout, ctx } = useSidePanel.getState()
  for (const id of [ctx.projectId, projectId]) if (id) setQuiet(id, false)
  const filter = tasksTab(layout)?.projectFilter
  const shown = resolveFilter(filter, ctx.projectId)
  const projectFilter = !projectId || shown === 'all' || shown === projectId ? filter : projectId === ctx.projectId ? undefined : projectId
  return openTab({ type: 'tasks', projectFilter, focusRunId }, place)
}

/**
 * The top bar badge: shows 后台任务, or hides it again — closing the tab while the panels have other tabs to show,
 * else collapsing them (the tab stays for next time).
 */
export function toggleTasksPanel(projectId?: string | null) {
  const state = useSidePanel.getState()
  const { layout, ctx } = state
  const tab = tasksTab(layout)
  if (!tab || !tasksShown(layout, ctx, state)) { openTasksPanel({ projectId }); return }
  const others = Object.values(layout.tabs).some(other => other.id !== tab.id && other.type !== 'launcher' && bindingMatches(other.binding, ctx))
  if (others) closeTab(tab.id)
  else setPanelOpen(false)
}

/* --------------------------------------------- what the panel opens */

/** The line a run reports on in its conversation, newest first: its background-work line, or a scheduled run's delivery. */
export function runLine(slice: Pick<SessionSlice, 'items' | 'order'> | undefined, ref: Pick<TasksPanelRefs['conversation'], 'actionId' | 'occurrenceKey'>): string | null {
  if (!slice || (!ref.actionId && !ref.occurrenceKey)) return null
  for (let i = slice.order.length - 1; i >= 0; i--) {
    const item = slice.items[slice.order[i]]
    if (!item) continue
    if (ref.actionId && item.initiative?.backgroundWork?.actionId === ref.actionId) return item.id
    if (ref.occurrenceKey && item.scheduleOccurrenceKey === ref.occurrenceKey) return item.id
  }
  return null
}

/** Open the conversation a run reports to, at its line when the conversation has one (waiting for it to load if needed). */
export async function openRunConversation(ref: TasksPanelRefs['conversation']) {
  const line = runLine(useApp.getState().sessions[ref.sessionId], ref)
  if (line) { await openSessionItem(ref.sessionId, line); return }
  const app = useApp.getState()
  if (!app.sessionIndex[ref.sessionId]) { toast(t('这段对话已不可用。')); return }
  // B9: the line can be older than the window the page holds (or the conversation is not open): the host finds it,
  // and the deep link pages back to it. A run that posted no line yet is waited for below.
  if (ref.actionId || ref.occurrenceKey) {
    const located = await locateRun(ref.sessionId, ref).catch(() => null)
    if (located) { await openSessionItem(ref.sessionId, located); return }
  }
  if (app.selectedSessionId !== ref.sessionId) await selectSession(ref.sessionId)
  useUi.setState({ view: 'chat', sidebarOpen: false })
  if (!ref.actionId && !ref.occurrenceKey) return
  // Point at the line once the conversation's items arrive; a run that posted none just opens the conversation.
  let seen = useApp.getState().sessions[ref.sessionId]
  const stop = useApp.subscribe(state => {
    const slice = state.sessions[ref.sessionId]
    if (slice === seen) return
    seen = slice
    const id = runLine(slice, ref)
    if (!id) return
    done()
    focusTimelineItem(ref.sessionId, id)
  })
  const timer = setTimeout(() => done(), FOCUS_TTL_MS)
  function done() { stop(); clearTimeout(timer) }
}

const BESIDE: Pick<OpenOptions, 'besideType'> = { besideType: 'tasks' }

/** The panel's `onOpenTab`: a change set, a file or a preview beside the panel (design 2.1); a conversation in the main cell. */
export function openFromTasks<K extends TasksPanelOpenKind>(kind: K, ref: TasksPanelRefs[K]): void {
  if (kind === 'change') {
    const { projectId, changeId, focus } = ref as TasksPanelRefs['change']
    openDock({ kind: 'change', projectId, changeId, ...(focus ? { focus } : {}) }, BESIDE)
  } else if (kind === 'file') {
    const { projectId, path } = ref as TasksPanelRefs['file']
    openDock({ kind: 'file', projectId, path }, BESIDE)
  } else if (kind === 'preview') {
    const { projectId, url } = ref as TasksPanelRefs['preview']
    if (url) { openPreviewTab(projectId, url, BESIDE); return }
    // No address: show the project's preview if it is open (an empty address would blank it).
    const open = Object.values(useSidePanel.getState().layout.tabs).find(tab => tab.type === 'browser' && tab.key === `preview:${projectId}`)
    if (open) activateTab(open.id)
    else toast(t('这个项目的预览还没有打开。'))
  } else {
    void openRunConversation(ref as TasksPanelRefs['conversation'])
  }
}

/* ------------------------------------------------- opening by itself */

export interface RunningInput {
  projects: RunProjectInput[]
  actions: Record<string, InitiativeAction[] | undefined>
  sessions: SessionSummary[]
  emergency?: boolean
}

/** Projects with a run going now: the panel's 运行中 rows that are running (background actions and subagent groups). */
export function runningProjects(input: RunningInput): Set<string> {
  const view = backgroundRuns({ ...input, filter: 'all' })
  return new Set(view.running.filter(run => run.state === 'running' && run.projectId).map(run => run.projectId!))
}

const phone = () => typeof matchMedia === 'function' && matchMedia('(max-width: 767px)').matches

/**
 * Whether showing collapsed panels would draw a group over the conversation (a narrow window, design 1.5): like the
 * phone sheet, that would cover — and take the keyboard from — what the user is reading or typing.
 */
export function expandingCovers(layout: LayoutState<SideTab>, viewport: Size | null, ctx?: WorkspaceCtx): boolean {
  if (!viewport || panelsOpen(layout)) return false
  // As the workspace lays groups out: cards with their gaps (a new group beside the conversation needs three).
  if (!groupIds(layout).length) return viewport.width < MIN_MAIN.width + MIN_GROUP.width + 3 * CARD_GAP || viewport.height < MIN_MAIN.height + 2 * CARD_GAP
  return computeRects({ ...layout, collapsed: false }, viewport, { ctx, gap: CARD_GAP }).compact
}

/** Show 后台任务 for `projectId`'s new run, unless turned off, quieted, on a phone or a window too narrow to show it beside the conversation, already shown, or a maximized panel holds the user's attention. */
function openByItself(projectId: string) {
  if (!usePreferences.getState().tasksAutoOpen || isQuiet(projectId) || phone()) return
  const state = useSidePanel.getState()
  const { layout, ctx, viewport } = state
  if (tasksShown(layout, ctx, state) || expandingCovers(layout, viewport, ctx)) return
  const tab = tasksTab(layout)
  if (layout.maximizedGroup !== null && !(tab && tabGroupId(layout, tab.id) === layout.maximizedGroup)) return
  const shown = resolveFilter(tab?.projectFilter, ctx.projectId)
  // A panel pinned to another project goes back to following the current one, which the run belongs to.
  const projectFilter = shown === 'all' || shown === projectId ? tab?.projectFilter : undefined
  openTab({ type: 'tasks', projectFilter }, { background: panelsOpen(layout) })
}

/**
 * Watch the stores: open 后台任务 when the current project's first run starts; quiet a project whose panel the user
 * closed or collapsed while its run was going, and un-quiet it when the user picks the tab in a strip or brings it back
 * (undo, ⇧⌘T). The first settled look (index and actions read) is the baseline, so loading the app or switching
 * projects mid-run opens nothing.
 * @returns stop watching.
 */
export function startTasksAutoOpen(): () => void {
  let settled = false
  let running = new Set<string>()
  const check = () => {
    const app = useApp.getState(), tasks = useTasks.getState()
    const projects = app.projectOrder.map(id => app.projects[id]).filter(Boolean) as unknown as RunProjectInput[]
    if (app.status !== 'ready' || !(tasks.loaded || projects.some(project => project.work))) return
    const next = runningProjects({ projects, actions: tasks.actions, sessions: Object.values(app.sessionIndex), emergency: app.emergency })
    const current = useSidePanel.getState().ctx.projectId
    const started = settled && current !== null && next.has(current) && !running.has(current)
    running = next
    settled = true
    if (started) openByItself(current)
  }
  const quietIfRunning = () => {
    const current = useSidePanel.getState().ctx.projectId
    if (current && running.has(current)) setQuiet(current, true)
  }
  const offApp = useApp.subscribe((s, prev) => {
    if (s.status !== prev.status || s.projects !== prev.projects || s.projectOrder !== prev.projectOrder || s.sessionIndex !== prev.sessionIndex || s.emergency !== prev.emergency) check()
  })
  const offTasks = useTasks.subscribe((s, prev) => { if (s.actions !== prev.actions || s.loaded !== prev.loaded) check() })
  // Only the user's close counts: a tab evicted past the cap, or replaced, was not dismissed.
  const offClosed = onTabClosed((tab, cause) => { if (tab.type === 'tasks' && cause === 'closed') quietIfRunning() })
  const offPicked = onTabPicked(tab => {
    const current = useSidePanel.getState().ctx.projectId
    if (tab.type === 'tasks' && current) setQuiet(current, false)
  })
  const offLayout = useSidePanel.subscribe((s, prev) => { if (s.layout.collapsed && !prev.layout.collapsed) quietIfRunning() })
  check()
  return () => { offApp(); offTasks(); offClosed(); offPicked(); offLayout() }
}

/** Mount once (App). */
export function useTasksAutoOpen() {
  useEffect(() => startTasksAutoOpen(), [])
}
