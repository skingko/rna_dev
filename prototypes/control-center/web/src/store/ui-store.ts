/**
 * View state that must survive virtualization (rows unmount off-screen), so
 * disclosure state lives here keyed by stable IDs rather than in components.
 */
import { create } from 'zustand'
import type { Attachment, InboxEntry } from '@/api/types'
import { openTab, setPanelOpen, type OpenOptions } from './side-panel-store'

export type Theme = 'light' | 'dark' | 'system'
/**
 * H3: the top tabs are 对话 / 文件 / 进化. `trajectory` is the 对话/轨迹 switch
 * inside 对话; 进化 (`evolution`) is the project's gene tree; `tasks`
 * (sidebar) and `inbox` (top-bar bell) are app-level pages across projects.
 */
export type ViewTab = 'chat' | 'trajectory' | 'tasks' | 'evolution' | 'files' | 'inbox'
/** App-level pages that are not tied to the selected project's tabs. */
export const GLOBAL_VIEWS: ReadonlySet<ViewTab> = new Set(['tasks', 'inbox'])
export type DockPanel =
  | { kind: 'tool'; sessionId: string; itemId: string }
  /**
   * 审阅: `itemIds` the tool calls (the fallback), `turnId` the turn whose host-computed changes to show first,
   * `focus` a tool call and `focusPath` a file (project path) to open on.
   */
  | { kind: 'diff'; sessionId: string; itemIds: string[]; focus?: string; turnId?: string | null; focusPath?: string | null }
  | { kind: 'group'; sessionId: string; itemIds: string[] }
  /** A workspace file in the unified preview (components/preview); `path` is workspace-relative. */
  | { kind: 'file'; projectId: string; path: string; sessionId?: string | null }
  /** A background change set's files (plan §4.4), `focus` = the file to show first. */
  | { kind: 'change'; projectId: string; changeId: string; focus?: string }

export interface ToastEntry { id: number; text: string; tone?: 'default' | 'danger' | 'success'; action?: { label: string; run: () => void } }
/** A host-posted "接着完成" taken back from the queue: it goes out again as it was, its own message carrying the task it continues. */
export interface CarriedTask { text: string; continues: { actionId: string } }
export interface ComposerFill { text: string; at: number; append?: boolean; sessionId?: string; attachments?: Attachment[]; tasks?: CarriedTask[] }

interface UiState {
  theme: Theme
  view: ViewTab
  /** The user just asked to settle something above the composer (e.g. Rna 欠你 N 件事): that kind of card goes first until `until`. */
  invitationFocus: { kind: string; until: number } | null
  sidebarOpen: boolean          // mobile drawer
  /** Preferred side group width (px, desktop): the default layout and the 侧栏 preset start from it. */
  dockWidth: number
  /** Explicit user choice per turn; absent -> default (open while running). */
  processOpen: Record<string, boolean>
  disclosure: Record<string, boolean>
  toasts: ToastEntry[]
  /** `${sessionId}:${itemId}` of a sent message whose delete is still undoable. */
  deleting: string | null
  search: string
  /** One-shot composer fill, taken with takePrefill(): suggestion cards replace the text; `append` adds after it with any `attachments` and `tasks` (messages taken back on stop). `sessionId` targets one conversation. */
  prefill: ComposerFill | null
  /** Bumped when the user sends, so the timeline re-engages follow. */
  followSignal: number
  /** 任务 page: project filter (`all` = every project) and an optional delivery to open. */
  tasksProject: string
  /** 任务 page: 临时任务 (agent-initiated work, learning, planning) or 项目日程 (schedules). */
  tasksTab: TasksTab
  /** The task shown in the page's inspector (a TaskEntry key), with a delivery to open for schedules. */
  tasksFocus: { key: string; occurrenceKey?: string | null } | null
  /** Sidebar 任务 section: collapsed state and project filter. */
  tasksCollapsed: boolean
  /** A user message being edited in the composer (the conversation rewinds to it on send). */
  editing: { sessionId: string; itemId: string; text: string } | null
  taskFilter: string
  /** 收件箱 page: the project shown (null = selected project or the first with unread). */
  inboxProject: string | null
}

const storedTheme = (() => {
  try { return (localStorage.getItem('rna.theme') as Theme | null) ?? 'system' } catch { return 'system' }
})()
const storedDock = (() => {
  try { return Number(localStorage.getItem('rna.dockWidth')) || 460 } catch { return 460 }
})()

export const useUi = create<UiState>(() => ({
  editing: null,
  theme: storedTheme,
  view: 'chat',
  invitationFocus: null,
  sidebarOpen: false,
  dockWidth: storedDock,
  processOpen: {},
  disclosure: {},
  toasts: [],
  deleting: null,
  search: '',
  prefill: null,
  followSignal: 0,
  tasksProject: 'all',
  tasksTab: 'adhoc',
  tasksFocus: null,
  tasksCollapsed: (() => { try { return localStorage.getItem('rna.tasksCollapsed') === '1' } catch { return false } })(),
  taskFilter: 'all',
  inboxProject: null,
}))

/** Open the cross-project 任务 page, optionally filtered to one project / delivery. */
export type TasksTab = 'adhoc' | 'schedules'
export function openTasks(projectId: string = 'all', focus: UiState['tasksFocus'] = null, tab?: TasksTab) {
  const next = tab ?? (focus ? (focus.key.includes(':schedule:') ? 'schedules' : 'adhoc') : undefined)
  useUi.setState({ view: 'tasks', tasksProject: projectId, tasksFocus: focus, sidebarOpen: false, ...(next ? { tasksTab: next } : {}) })
}
export function openInbox(projectId: string | null = null) {
  useUi.setState({ view: 'inbox', inboxProject: projectId, sidebarOpen: false })
}
export function setTasksCollapsed(collapsed: boolean) {
  try { localStorage.setItem('rna.tasksCollapsed', collapsed ? '1' : '0') } catch { /* ignore */ }
  useUi.setState({ tasksCollapsed: collapsed })
}

/** Put text in the composer (see `prefill`). */
export function fillComposer(text: string, options: Omit<ComposerFill, 'text' | 'at'> = {}) {
  useUi.setState({ prefill: { text, at: Date.now(), ...options } })
}
/** Take the pending fill once: a composer mounted later (the dock after the first send) must not replay it. */
export function takePrefill() {
  const fill = useUi.getState().prefill
  if (fill) useUi.setState({ prefill: null })
  return fill
}
/**
 * Queued messages coming back into the composer (stop, 取回编辑): the user's own text and files go after the draft;
 * a host-posted "接着完成" keeps the background task it continues (`continues`), so it comes back as itself, never as
 * plain text. A subagent's queued result was written for the model, not by the user: it is not a draft.
 */
export function takenBack(entries: InboxEntry[]): Omit<ComposerFill, 'at' | 'sessionId'> | null {
  const own = entries.filter(entry => entry.source !== 'subagent')
  const linked = (entry: InboxEntry) => Boolean(entry.continues?.actionId && entry.text?.trim())
  const tasks = own.filter(linked).map(entry => ({ text: entry.text.trim(), continues: { actionId: entry.continues!.actionId } }))
  const plain = own.filter(entry => !linked(entry))
  const text = plain.map(entry => entry.text?.trim()).filter(Boolean).join('\n\n')
  const attachments = plain.flatMap(entry => (entry.attachments ?? []).filter(a => a.id))
  return text || attachments.length || tasks.length ? { text, append: true, attachments, tasks } : null
}

let toastSeq = 0
export function toast(text: string, tone: ToastEntry['tone'] = 'default', { action, durationMs = 3600 }: { action?: ToastEntry['action']; durationMs?: number } = {}) {
  const id = ++toastSeq
  const close = () => useUi.setState(s => ({ toasts: s.toasts.filter(t => t.id !== id) }))
  useUi.setState(s => ({ toasts: [...s.toasts.slice(-2), { id, text, tone, ...(action ? { action: { label: action.label, run: () => { close(); action.run() } } } : {}) }] }))
  setTimeout(close, durationMs)
  return close
}

/** Messages being deleted: faded for a few seconds while the delete can still be undone. */
export const DELETE_UNDO_MS = 5000

export function setTheme(theme: Theme) {
  try { localStorage.setItem('rna.theme', theme) } catch { /* private mode */ }
  useUi.setState({ theme })
}

export function toggleDisclosure(key: string, fallback = false) {
  useUi.setState(s => ({ disclosure: { ...s.disclosure, [key]: !(s.disclosure[key] ?? fallback) } }))
}

export function setProcessOpen(turnId: string, open: boolean) {
  useUi.setState(s => ({ processOpen: { ...s.processOpen, [turnId]: open } }))
}

/**
 * Former dock panels open as workspace tabs (S2): tool detail, 审查 (review),
 * file preview and background changes reuse their tab when already open. The
 * retired session overview (`group`) opens 审查 for those items (design 1.1).
 * `options` place the tab (contract P-7).
 */
export function openDock(panel: DockPanel, options: Pick<OpenOptions, 'target' | 'besideType' | 'background'> = {}) {
  if (panel.kind === 'tool') openTab({ type: 'tool', sessionId: panel.sessionId, itemId: panel.itemId }, options)
  // Every field is set (null when absent): a reused 审阅 tab must not keep the last turn or file.
  else if (panel.kind === 'diff') openTab({ type: 'review', sessionId: panel.sessionId, itemIds: panel.itemIds, focus: panel.focus ?? null, turnId: panel.turnId ?? null, focusPath: panel.focusPath ?? null }, options)
  else if (panel.kind === 'file') openTab({ type: 'file', projectId: panel.projectId, path: panel.path, ...(panel.sessionId ? { sessionId: panel.sessionId } : {}) }, options)
  else if (panel.kind === 'change') openTab({ type: 'change-review', projectId: panel.projectId, changeId: panel.changeId, focus: panel.focus ?? null }, options)
  else openTab({ type: 'review', sessionId: panel.sessionId, itemIds: panel.itemIds.length ? panel.itemIds : null, focus: null, turnId: null, focusPath: null }, options)
}
/** Collapse the panels (their tabs stay). */
export function closeDock() { setPanelOpen(false) }
export function setDockWidth(width: number) {
  useUi.setState({ dockWidth: width })
  try { localStorage.setItem('rna.dockWidth', String(Math.round(width))) } catch { /* ignore */ }
}
