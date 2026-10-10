/**
 * Workspace layout store (design 1.2–1.6, WP2) on the `lib/dock` engine: one
 * global layout tree per window — the conversation is the fixed `main` cell,
 * every panel lives in a tab group that can be split, moved, minimized or
 * maximized. Each tab carries a binding (workspace / session / project) that
 * decides whether it shows for the selected conversation, so the geometry is
 * global (decision D1) while tabs still follow their conversation or project;
 * each group remembers its active tab per conversation (`activeByScope`).
 *
 * The exported API of the old per-scope side panel (openTab, closeTab,
 * findTab, updateTab, onTabClosed, togglePanel, setPanelOpen, …) keeps its
 * shape for its callers; `openTab` gains a placement `target` / `besideType`
 * (contract P-7). Layout changes are undoable; tab bodies' own updates
 * (titles, URLs, terminal ids) and focus moves are not recorded.
 *
 * Persisted as `rna.workspace.v2` (layout-persist.ts), migrated from
 * `rna.sidePanel.v1` on first load; transient fields are never written.
 * Saved layouts (保存当前布局) are kept in the same record's `presets`;
 * applying one is an undoable layout change.
 *
 * Listeners hear why a tab went (`onTabClosed`: the user closed it, or it was
 * evicted over the cap or replaced in place) and when the user brought one up
 * (`onTabPicked`: picked in a strip, or back through undo / ⇧⌘T).
 */
import { create } from 'zustand'
import type { DeviceMode } from '@/lib/browser-url'
import {
  activateTab as dockActivate, activeTab, arrange, bindingMatches, closeAmong as dockCloseAmong, closeGroup as dockCloseGroup, closeTab as dockCloseTab, closeTabs as dockCloseTabs,
  CARD_GAP, computeRects, EMPTY_HISTORY, focusGroup as dockFocusGroup, getGroup, groupIds, groupsByRecency, isFocusOp, isGroup, maximize as dockMaximize,
  minimize as dockMinimize, MIN_GROUP, MIN_MAIN, moveGroup as dockMoveGroup, moveTab as dockMoveTab, moveTabToward as dockMoveToward, neighborNode,
  openTab as dockOpenTab, push, resize as dockResize, resizeDivider as dockResizeDivider, setCollapsed, shareOf, splitGroup as dockSplitGroup,
  stepBack, stepForward, tabGroupId, tabsInScope, updateTab as dockUpdateTab, visibleTabs,
  type Binding, type Change, type Divider, type DockPolicy, type Edge, type Geometry, type History, type LayoutState, type Mint, type NodeId,
  type OpenTarget, type Preset, type Size,
} from '@/lib/dock'
import { useApp } from './app-store'
import {
  captureLayout, createLayoutWriter, guessedWidth, LAYOUT_NAME_MAX, loadLayout, MAX_SAVED_LAYOUTS, restoreLayout, sameLayoutName, savedLayouts, savedRecord,
  serializeWorkspace, storedDockWidth, V1_KEY, WORKSPACE_KEY, type SavedLayout,
} from './layout-persist'

type TabData =
  /** The "打开标签页" chooser (also what an empty group shows). */
  | { id: string; type: 'launcher' }
  | { id: string; type: 'tool'; sessionId: string; itemId: string }
  /**
   * 审查: every changed file of the session, or only `itemIds` when given (a turn's 本轮交付). `turnId`: that turn's
   * host-computed changes first (the tool calls when the host cannot say); `focusPath`: the file to open on.
   */
  | { id: string; type: 'review'; sessionId: string; itemIds?: string[] | null; focus?: string | null; turnId?: string | null; focusPath?: string | null }
  /** `sessionId` (0.63): read through that worktree conversation's own copy (absent: the project folder). */
  | { id: string; type: 'file'; projectId: string; path: string; sessionId?: string | null }
  /** 浏览器 · Rna: the conversation's agent browser, live (read-only view). */
  | { id: string; type: 'agent-browser'; sessionId: string }
  /** 审阅后台改动: one background change set (plan §4.4), file by file, with the same 预览 / 源码 / 差异 switch. */
  | { id: string; type: 'change-review'; projectId: string; changeId: string; focus?: string | null }
  /** `key` makes a tab reusable (e.g. `preview:<projectId>` for the run preview); `reload` is a transient nonce. */
  | { id: string; type: 'browser'; url: string; title?: string | null; device?: DeviceMode; key?: string | null; reload?: number }
  /** `sessionId` (0.63): the terminal starts in that worktree conversation's own copy (absent: the project folder). */
  | { id: string; type: 'terminal'; projectId: string; terminalId?: string | null; title?: string | null; sessionId?: string | null }
  | { id: string; type: 'side-chat'; parentSessionId: string; sideSessionId?: string | null; title?: string | null; ordinal: number }
  /** 后台任务 (contract P-6): one per window, filtered by project inside. */
  | { id: string; type: 'tasks'; projectFilter?: string | 'all'; focusRunId?: string | null }
  /** 文件 / 进化 / 工作区改动 as panels (phase 2): `projectId` null follows the current project; one per project (or one following). */
  | { id: string; type: 'files'; projectId?: string | null; path?: string | null }
  | { id: string; type: 'evolution'; projectId?: string | null }
  /**
   * 工作区改动 (worktree design §3.9): the comparison it shows (`WorktreeTabFields`). `source` is the old switch's name
   * (本次任务 / 未暂存 / 已暂存 / 相对上游), still accepted as a request to show that view: read with `worktreeView`,
   * and turned into the fields when a stored tab is read or the panel shows it.
   */
  | ({ id: string; type: 'worktree'; projectId?: string | null; source?: string | null } & WorktreeTabFields)

/** 全部改动 (merge-base → working tree), 未提交的改动 (HEAD → working tree), or 本次对话的改动 (Rna's own records). */
export type WorktreeMode = 'all' | 'uncommitted' | 'rna'
/** A 工作区改动 tab's comparison and how it reads; unset fields take the panel's defaults. */
export interface WorktreeTabFields {
  /** null: 全部改动 in a repository, else 本次对话的改动. */
  mode?: WorktreeMode | null
  /**
   * 本次对话的改动 was the user's own pick from the comparison menu: only then does it stay in a repository. A mode
   * 'rna' without it came from the old switch's default (本次任务) and gives way to the default comparison.
   */
  rnaPicked?: boolean
  /** The branch 全部改动 compares against; null: the repository's default branch. */
  base?: string | null
  /** Another worktree of the repository (its path), shown read-only; null: the conversation's own folder (the project folder). */
  target?: string | null
  /** The file tree is shown (wide panels); null: shown from 520 px of width. */
  tree?: boolean | null
  /** 按暂存状态分组 (未提交的改动 only): conflicted / staged / unstaged / untracked with stage and discard. */
  grouped?: boolean
  /** Soft-wrap long lines (default on). */
  wrap?: boolean
  /** Line numbers: the new one (default), or old and new. */
  numbers?: 'new' | 'both'
}
const WORKTREE_MODES = new Set<string>(['all', 'uncommitted', 'rna'])

/**
 * The fields an old `source` stands for (design §7): 未暂存 / 已暂存 → 未提交的改动 grouped by stage, 相对上游 → 全部改动
 * against the default branch. 本次任务 was the old switch's default, not a choice: it reads as the default comparison
 * (全部改动 in a repository, 本次对话的改动 in a plain folder).
 */
export function worktreeSourceFields(source: string | null | undefined): WorktreeTabFields | null {
  switch (source) {
    case 'rna': return { mode: null }
    case 'unstaged': case 'staged': return { mode: 'uncommitted', grouped: true }
    case 'upstream': return { mode: 'all', base: null }
    default: return null
  }
}

/** The tab's mode as it stands: 本次对话的改动 only when the user picked it (see `rnaPicked`), else unset (the default). */
export function worktreeMode(tab: Pick<WorktreeTabFields, 'mode' | 'rnaPicked'>): WorktreeMode | null {
  return tab.mode === 'rna' && tab.rnaPicked !== true ? null : tab.mode ?? null
}

/** A 工作区改动 tab's comparison as the panel reads it: its fields, with a pending old-style `source` request applied over them. */
export function worktreeView(tab: WorktreeTabFields & { source?: string | null }): WorktreeTabFields {
  const view: WorktreeTabFields = { mode: worktreeMode(tab), base: tab.base ?? null, target: tab.target ?? null, tree: tab.tree ?? null }
  if (view.mode === 'rna') view.rnaPicked = true
  if (tab.grouped !== undefined) view.grouped = tab.grouped
  if (tab.wrap !== undefined) view.wrap = tab.wrap
  if (tab.numbers) view.numbers = tab.numbers
  const requested = { ...view, ...worktreeSourceFields(tab.source) }
  if (requested.mode !== 'rna') delete requested.rnaPicked
  return requested
}

/**
 * Stored 工作区改动 fields, each checked (an unknown value takes its default); an old `source` becomes fields unless
 * `mode` is set. A stored 本次对话的改动 the user did not pick (0.62 wrote the old 本次任务 default into `mode`) is read
 * as unset from the start, so a repository opens on 全部改动 without showing the old list first.
 */
function parseWorktreeFields(tab: Record<string, unknown>): WorktreeTabFields {
  const text = (k: string) => (typeof tab[k] === 'string' && (tab[k] as string).length > 0 ? tab[k] as string : null)
  const picked = tab.rnaPicked === true
  const fields: WorktreeTabFields = {
    mode: WORKTREE_MODES.has(tab.mode as string) ? worktreeMode({ mode: tab.mode as WorktreeMode, rnaPicked: picked }) : null,
    base: text('base'),
    // A worktree's full path; the host checks it is one of the repository's before reading it.
    target: text('target'),
    tree: typeof tab.tree === 'boolean' ? tab.tree : null,
  }
  if (fields.mode === 'rna') fields.rnaPicked = true
  if (typeof tab.grouped === 'boolean') fields.grouped = tab.grouped
  if (typeof tab.wrap === 'boolean') fields.wrap = tab.wrap
  if (tab.numbers === 'new' || tab.numbers === 'both') fields.numbers = tab.numbers
  return fields.mode ? fields : { ...fields, ...worktreeSourceFields(text('source')) }
}

/** A tab plus its binding (when it shows: always, in one conversation, or in one project). */
export type SideTab = TabData & { binding: Binding }
/** A tab's own fields: what its body reads (bodies never need the binding). */
export type SideTabData = TabData
export type SideTabType = SideTab['type']
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type SideTabInput = DistributiveOmit<TabData, 'id'>
export type { Binding }

/** What the panel shows for the selected conversation: the old per-scope pane, now derived from the layout (`currentPane`). */
export interface Pane { tabs: SideTab[]; activeId: string | null; open: boolean; touched: number }
/** The selection tabs bind to. */
export interface WorkspaceCtx { sessionId: string | null; projectId: string | null }

interface SidePanelState {
  /** Current scope key (see `scopeKey`): the key of `activeByScope`. */
  scope: string
  ctx: WorkspaceCtx
  layout: LayoutState<SideTab>
  /** Undo / redo of layout changes. */
  history: History<SideTab>
  /** Workspace size in pixels as last measured by the host; null until it mounts. */
  viewport: Size | null
  /** The host shows the phone sheet (below 768 px): one strip merging every group's tabs, no tree. */
  sheet: boolean
  /** Transient: selection text a new side chat is created with, keyed by tab id. */
  seeds: Record<string, { text: string; itemId?: string | null }>
  /** Saved layouts by id, as stored (entries this version cannot read are kept as they are). */
  presets: Record<string, unknown>
}

export const STORAGE_KEY = WORKSPACE_KEY
export const V1_STORAGE_KEY = V1_KEY
/** Visible tabs per conversation; past it, lightweight tabs close first. */
export const MAX_TABS = 12
const TYPES = new Set<SideTabType>(['launcher', 'tool', 'review', 'change-review', 'agent-browser', 'file', 'browser', 'terminal', 'side-chat', 'tasks', 'files', 'evolution', 'worktree'])
/** Lightweight detail tabs are evicted first when the strip is full. */
const EPHEMERAL = new Set<SideTabType>(['launcher', 'tool', 'file'])

export const scopeKey = (sessionId: string | null | undefined, projectId: string | null | undefined) =>
  sessionId ? `s:${sessionId}` : projectId ? `p:${projectId}` : 'global'

/* ------------------------------------------------------------- bindings */

const previewProject = (key: string | null | undefined) => (key?.startsWith('preview:') ? key.slice('preview:'.length) || null : null)

/** Where a tab belongs by its own data (design 1.1). */
export function naturalBinding(tab: SideTabInput | SideTab): Binding {
  switch (tab.type) {
    case 'launcher': case 'tasks': return 'workspace'
    case 'tool': case 'review': case 'agent-browser': return { session: tab.sessionId }
    case 'side-chat': return { session: tab.parentSessionId }
    case 'file': case 'change-review': case 'terminal': return { project: tab.projectId }
    case 'browser': { const project = previewProject(tab.key); return project ? { project } : 'workspace' }
    case 'files': case 'evolution': case 'worktree': return tab.projectId ? { project: tab.projectId } : 'workspace'
  }
}

/** The binding that shows in `ctx`: the selected conversation, else its project, else everywhere. */
const ctxBinding = (ctx: WorkspaceCtx): Binding => (ctx.sessionId ? { session: ctx.sessionId } : ctx.projectId ? { project: ctx.projectId } : 'workspace')

/** A tab's natural binding, or — when that would hide it where it is being opened — the selection's (today's per-scope strip). */
export function bindingFor(tab: SideTabInput | SideTab, ctx: WorkspaceCtx): Binding {
  const natural = naturalBinding(tab)
  return bindingMatches(natural, ctx) ? natural : ctxBinding(ctx)
}

function parseBinding(value: unknown): Binding | null {
  if (value === 'workspace') return 'workspace'
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : null
  if (typeof raw?.session === 'string' && raw.session) return { session: raw.session }
  if (typeof raw?.project === 'string' && raw.project) return { project: raw.project }
  return null
}

/** `s:<id>` / `p:<id>` / `global` → the selection it names (a conversation's project from the app index when known). */
export function ctxOfScope(scope: string): WorkspaceCtx {
  if (scope.startsWith('s:')) {
    const sessionId = scope.slice(2)
    const app = useApp.getState()
    return { sessionId, projectId: app.sessions[sessionId]?.meta.projectId ?? app.sessionIndex[sessionId]?.projectId ?? null }
  }
  if (scope.startsWith('p:')) return { sessionId: null, projectId: scope.slice(2) }
  return { sessionId: null, projectId: null }
}

/* ---------------------------------------------------------- persistence */

function sanitizeData(value: unknown): TabData | null {
  if (!value || typeof value !== 'object') return null
  const tab = value as Record<string, unknown>
  if (typeof tab.id !== 'string' || !TYPES.has(tab.type as SideTabType)) return null
  const str = (k: string) => typeof tab[k] === 'string' && (tab[k] as string).length > 0
  switch (tab.type) {
    case 'launcher': return { id: tab.id, type: 'launcher' }
    case 'tool': return str('sessionId') && str('itemId') ? { id: tab.id, type: 'tool', sessionId: tab.sessionId as string, itemId: tab.itemId as string } : null
    case 'review': return str('sessionId') ? { id: tab.id, type: 'review', sessionId: tab.sessionId as string, itemIds: Array.isArray(tab.itemIds) ? (tab.itemIds as unknown[]).filter((x): x is string => typeof x === 'string') : null, focus: str('focus') ? tab.focus as string : null, turnId: str('turnId') ? tab.turnId as string : null, focusPath: str('focusPath') ? tab.focusPath as string : null } : null
    case 'file': return str('projectId') && str('path') ? { id: tab.id, type: 'file', projectId: tab.projectId as string, path: tab.path as string, ...(str('sessionId') ? { sessionId: tab.sessionId as string } : {}) } : null
    case 'agent-browser': return str('sessionId') ? { id: tab.id, type: 'agent-browser', sessionId: tab.sessionId as string } : null
    case 'change-review': return str('projectId') && str('changeId') ? { id: tab.id, type: 'change-review', projectId: tab.projectId as string, changeId: tab.changeId as string, focus: str('focus') ? tab.focus as string : null } : null
    case 'browser': return typeof tab.url === 'string' ? { id: tab.id, type: 'browser', url: tab.url, title: str('title') ? tab.title as string : null, device: tab.device === 'mobile' ? 'mobile' : 'desktop', key: str('key') ? tab.key as string : null } : null
    case 'terminal': return str('projectId') ? { id: tab.id, type: 'terminal', projectId: tab.projectId as string, terminalId: str('terminalId') ? tab.terminalId as string : null, title: str('title') ? tab.title as string : null, ...(str('sessionId') ? { sessionId: tab.sessionId as string } : {}) } : null
    case 'side-chat': return str('parentSessionId') ? { id: tab.id, type: 'side-chat', parentSessionId: tab.parentSessionId as string, sideSessionId: str('sideSessionId') ? tab.sideSessionId as string : null, title: str('title') ? tab.title as string : null, ordinal: Number(tab.ordinal) || 1 } : null
    case 'tasks': return { id: tab.id, type: 'tasks', projectFilter: str('projectFilter') ? tab.projectFilter as string : undefined, focusRunId: str('focusRunId') ? tab.focusRunId as string : null }
    case 'files': return { id: tab.id, type: 'files', projectId: str('projectId') ? tab.projectId as string : null, path: str('path') ? tab.path as string : null }
    case 'evolution': return { id: tab.id, type: 'evolution', projectId: str('projectId') ? tab.projectId as string : null }
    case 'worktree': return { id: tab.id, type: 'worktree', projectId: str('projectId') ? tab.projectId as string : null, ...parseWorktreeFields(tab) }
  }
  return null
}

/** One persisted v2 tab: its data plus a valid binding (a missing or broken one is derived again). */
export function sanitizeTab(value: unknown): SideTab | null {
  const data = sanitizeData(value)
  if (!data) return null
  return { ...data, binding: parseBinding((value as { binding?: unknown }).binding) ?? naturalBinding(data) } as SideTab
}

/**
 * One v1 tab: it showed only in its scope's strip, so it binds there unless its natural binding already shows there.
 * A page without a key binds to its strip's conversation too (a new one shows everywhere, but v1 showed it only there,
 * and bound to the workspace it would also count against the tabs every conversation shows). Overview tabs are retired.
 */
export function sanitizeV1Tab(value: unknown, scope: string): SideTab | null {
  const data = sanitizeData(value)
  if (!data) return null
  const ctx: WorkspaceCtx = scope.startsWith('s:') ? { sessionId: scope.slice(2), projectId: null } : scope.startsWith('p:') ? { sessionId: null, projectId: scope.slice(2) } : { sessionId: null, projectId: null }
  return { ...data, binding: data.type === 'browser' && !data.key ? ctxBinding(ctx) : bindingFor(data, ctx) } as SideTab
}

const sameBinding = (a: Binding, b: Binding) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The same tab (by identity) in several v1 strips becomes one tab: bound where it naturally belongs when the strips
 * disagree, so a project's preview or file opened in two of its conversations still shows in both.
 */
export function mergeV1Tab(kept: SideTab, duplicate: SideTab): SideTab {
  return sameBinding(kept.binding, duplicate.binding) ? kept : { ...kept, binding: naturalBinding(kept) }
}

/** Transient fields never written: the browser's reload nonce, and the run 后台任务 was asked to bring into view (a reload must not replay it). */
function cleanTab(tab: SideTab): SideTab {
  if (tab.type === 'tasks' && tab.focusRunId) return { ...tab, focusRunId: null }
  if (tab.type !== 'browser') return tab
  const { reload: _reload, ...rest } = tab
  void _reload
  return rest as SideTab
}

/** What `rna.workspace.v2` gets for this layout (with the saved layouts). */
export const serializeLayout = (layout: LayoutState<SideTab>) => serializeWorkspace(layout, cleanTab, useSidePanel.getState().presets)

/* ------------------------------------------------------------ helpers */

let seq = 0
export const newTabId = (type: SideTabType) => `${type}-${Date.now().toString(36)}-${(++seq).toString(36)}`

let mintSeq = 0
const mint: Mint = kind => `${kind === 'group' ? 'g' : kind === 'split' ? 's' : 't'}-${Date.now().toString(36)}-${(++mintSeq).toString(36)}`

/** Identity used to reuse a tab instead of opening a duplicate; null = always a new tab. */
export function tabIdentity(tab: SideTabInput | SideTab): string | null {
  switch (tab.type) {
    case 'launcher': return 'launcher'
    case 'tool': return `tool:${tab.sessionId}:${tab.itemId}`
    case 'review': return `review:${tab.sessionId}`
    // The same path in a worktree conversation's copy is another file than the project folder's.
    case 'file': return `file:${tab.projectId}:${tab.path}${tab.sessionId ? `@${tab.sessionId}` : ''}`
    case 'change-review': return `change:${tab.changeId}`
    case 'agent-browser': return `agent-browser:${tab.sessionId}`
    case 'browser': return tab.key ? `browser:${tab.key}` : null
    case 'terminal': return tab.terminalId ? `terminal:${tab.terminalId}` : null
    case 'side-chat': return tab.sideSessionId ? `side:${tab.sideSessionId}` : null
    case 'tasks': return 'tasks'
    case 'files': case 'evolution': case 'worktree': return `${tab.type}:${tab.projectId ?? 'follow'}`
  }
}

/** Drop tabs beyond MAX_TABS from a strip: ephemeral ones first, oldest first, never the active tab. */
export function evict(tabs: SideTab[], activeId: string | null): SideTab[] {
  const out = [...tabs]
  while (out.length > MAX_TABS) {
    const victim = out.find(t => t.id !== activeId && EPHEMERAL.has(t.type)) ?? out.find(t => t.id !== activeId)
    if (!victim) break
    out.splice(out.indexOf(victim), 1)
  }
  return out
}

/** Neighbor to focus after closing `id`: the tab to the right, else the left. */
export function neighborAfterClose(tabs: SideTab[], id: string, activeId: string | null): string | null {
  if (activeId !== id) return activeId
  const index = tabs.findIndex(t => t.id === id)
  const rest = tabs.filter(t => t.id !== id)
  return rest[Math.min(index, rest.length - 1)]?.id ?? null
}

/** Whether the panel area shows: not collapsed (⌥⌘B) and there is a group to show. */
export const panelsOpen = (layout: LayoutState<SideTab>) => !layout.collapsed && groupIds(layout).length > 0

/** The tab the user is looking at in `ctx`: the focused group's, else the most recent group with one. */
export function shownTab(layout: LayoutState<SideTab>, ctx: WorkspaceCtx): SideTab | null {
  for (const id of groupsByRecency(layout)) {
    const tab = activeTab(layout, id, ctx)
    if (tab) return tab
  }
  return null
}

/** Geometry of the last few reads (layout, selection and size rarely all change at once). */
let lastGeometry: { layout: LayoutState<SideTab>; ctx: WorkspaceCtx; viewport: Size; geometry: Geometry } | null = null
function geometryOf(layout: LayoutState<SideTab>, ctx: WorkspaceCtx, viewport: Size): Geometry {
  const hit = lastGeometry
  if (hit && hit.layout === layout && hit.ctx === ctx && hit.viewport === viewport) return hit.geometry
  const geometry = computeRects(layout, viewport, { ctx, gap: CARD_GAP })
  lastGeometry = { layout, ctx, viewport, geometry }
  return geometry
}

/** What decides whether a tab is on screen. */
export type ScreenView = Pick<SidePanelState, 'layout' | 'ctx'> & Partial<Pick<SidePanelState, 'viewport' | 'sheet'>>

/**
 * Whether a tab is on screen for the selection: the panels show, its group is drawn (not minimized, squeezed onto an
 * edge strip, behind a maximized or overlay group, or left out for having nothing to show) and that group shows it.
 * On the phone sheet: it is the sheet's tab. Without a measured size, only the user's minimize and maximize count.
 */
export function tabOnScreen(id: string, { layout, ctx, viewport = null, sheet = false }: ScreenView): boolean {
  if (!layout.tabs[id] || !panelsOpen(layout)) return false
  if (sheet) return shownTab(layout, ctx)?.id === id
  const groupId = tabGroupId(layout, id)
  if (viewport) { if (!geometryOf(layout, ctx, viewport).rects[groupId]) return false }
  else if (getGroup(layout, groupId).minimized || (layout.maximizedGroup !== null && layout.maximizedGroup !== groupId)) return false
  return activeTab(layout, groupId, ctx)?.id === id
}

function initial(): Pick<SidePanelState, 'layout' | 'history' | 'presets'> {
  const loaded = loadLayout<SideTab>({ parseTab: sanitizeTab, parseV1Tab: sanitizeV1Tab, identity: tabIdentity, mergeV1: mergeV1Tab, mint })
  return { layout: loaded.layout, history: EMPTY_HISTORY, presets: loaded.presets }
}

const start = initial()
export const useSidePanel = create<SidePanelState>(() => ({
  scope: 'global', ctx: { sessionId: null, projectId: null }, ...start, viewport: null, sheet: false, seeds: {},
}))

const get = useSidePanel.getState
const set = useSidePanel.setState

const writer = createLayoutWriter(() => serializeLayout(get().layout))
useSidePanel.subscribe((state, prev) => { if (state.layout !== prev.layout || state.presets !== prev.presets) writer.schedule() })

/* ------------------------------------------------------- applying changes */

/** A launcher is per group (the "+" of each strip), so it is never reused across groups. */
const reusable = (tab: SideTab) => (tab.type === 'launcher' ? null : tabIdentity(tab))

function policy(): DockPolicy<SideTab> {
  const viewport = get().viewport
  return {
    mint,
    identity: reusable,
    cap: { max: MAX_TABS, lightweight: tab => EPHEMERAL.has(tab.type) },
    seed: id => ({ id, type: 'launcher', binding: 'workspace' }),
    share: sideShares(viewport),
  }
}

/** Shares of a new group beside the conversation: the preferred side width across, a 280 px panel above or below. */
export function sideShares(viewport: Size | null): { row: number; column: number } {
  return {
    row: shareOf(storedDockWidth(), viewport?.width ?? guessedWidth()),
    column: shareOf(280, viewport?.height ?? 800, MIN_GROUP.height, MIN_MAIN.height),
  }
}

/**
 * Why a tab went: `closed` by the user (a close, 关闭整组, undo or redo), `evicted` past the tab cap by an open, or
 * `replaced` by the card picked in its place.
 */
export type CloseCause = 'closed' | 'evicted' | 'replaced'
const closeListeners = new Set<(tab: SideTab, cause: CloseCause) => void>()
/** Called for every tab that closes, with why (e.g. to end its host terminal whatever the cause). */
export function onTabClosed(listener: (tab: SideTab, cause: CloseCause) => void) {
  closeListeners.add(listener)
  return () => { closeListeners.delete(listener) }
}
function notifyClosed(tabs: SideTab[], cause: (tab: SideTab) => CloseCause = () => 'closed') {
  if (!tabs.length) return
  for (const tab of tabs) for (const listener of closeListeners) listener(tab, cause(tab))
  set(s => {
    if (!tabs.some(tab => tab.id in s.seeds)) return {}
    const seeds = { ...s.seeds }
    for (const tab of tabs) delete seeds[tab.id]
    return { seeds }
  })
}

const pickListeners = new Set<(tab: SideTab) => void>()
/** Called when the user brings a tab up: picks it in a strip (or with the keyboard), or gets it back with undo, redo or ⇧⌘T. */
export function onTabPicked(listener: (tab: SideTab) => void) {
  pickListeners.add(listener)
  return () => { pickListeners.delete(listener) }
}
function notifyPicked(tabs: SideTab[]) {
  for (const tab of tabs) for (const listener of pickListeners) listener(tab)
}

function setLayout(layout: LayoutState<SideTab>, history?: History<SideTab>) {
  set(s => ({ layout, history: history ?? s.history }))
}

/**
 * Apply one change. Recorded for undo unless it only moves focus or `quiet`
 * (a tab body's own update: undoing a terminal id or a page title would only
 * break the tab). `cause` says why the tabs it removed went (default: closed).
 */
function apply<C extends Change<SideTab>>(change: C, quiet = false, cause?: (tab: SideTab) => CloseCause): C {
  if (!change.ops.length) return change
  const record = !quiet && change.ops.some(op => !isFocusOp(op))
  setLayout(change.state, record ? push(get().history, change) : undefined)
  notifyClosed(change.closed, cause)
  return change
}

const layout = () => get().layout
const ctx = () => get().ctx

/* ------------------------------------------------------------ selection */

/** Follow the selected conversation (or project page): which tabs show, and whose active tab each group shows. */
export function setContext(next: WorkspaceCtx) {
  const current = get().ctx
  if (current.sessionId === next.sessionId && current.projectId === next.projectId) return
  set({ ctx: { sessionId: next.sessionId, projectId: next.projectId }, scope: scopeKey(next.sessionId, next.projectId) })
}

/** Select by scope key (tests and older callers). */
export function setScope(scope: string) { if (get().scope !== scope) setContext(ctxOfScope(scope)) }

/** The host reports the workspace size (presets, placement and new-group shares read it). */
export function setViewport(size: Size) {
  const current = get().viewport
  if (current && current.width === size.width && current.height === size.height) return
  set({ viewport: { width: size.width, height: size.height } })
}

/** The host shows (or stops showing) the phone sheet. */
export function setSheet(sheet: boolean) { if (get().sheet !== sheet) set({ sheet }) }

/** The selected conversation's merged strip (old API): every tab that shows, the one in front, whether panels show. */
export function currentPane(): Pane {
  const { layout: state, ctx: selection } = get()
  return { tabs: tabsInScope(state, selection), activeId: shownTab(state, selection)?.id ?? null, open: panelsOpen(state), touched: 0 }
}

/* -------------------------------------------------------------- opening */

export interface OpenOptions {
  /** Open for this scope instead of the selected one (its active tab and binding). */
  scope?: string
  /** Replace this tab in place (the launcher a card was picked from). */
  replace?: string | null
  /** Open without switching to it (the panel still shows). */
  background?: boolean
  /** Where a new tab goes: `auto` (design 1.6), a group id, or a new group on an edge of a node (P-7). */
  target?: OpenTarget
  /** Place next to the group showing a tab of this type (design 2.1: previews the tasks panel opens). */
  besideType?: string
}

/**
 * Design 2.1 placement beside the group holding `type`: an adjacent group,
 * else a 40/60 split below it when it is at least 600 px tall, else a split to
 * its right when it is wide enough for two groups, else that group itself.
 * @returns null when no group holds that type.
 */
export function besideTarget(state: LayoutState<SideTab>, type: string, selection: WorkspaceCtx, viewport: Size | null): OpenTarget | null {
  const order = groupsByRecency(state)
  const holder = order.find(id => visibleTabs(state, id, selection).some(tab => tab.type === type))
    ?? order.find(id => getGroup(state, id).tabIds.some(tabId => state.tabs[tabId]?.type === type))
  if (!holder) return null
  for (const edge of ['bottom', 'right', 'top', 'left'] as const) {
    const neighbor = neighborNode(state, holder, edge)
    if (neighbor && isGroup(state, neighbor)) return neighbor
  }
  const rect = viewport ? computeRects(state, viewport, { ctx: selection, gap: CARD_GAP }).rects[holder] : undefined
  if (!rect) return { edge: 'right', of: holder }
  if (rect.height >= 600) return { edge: 'bottom', of: holder, share: 0.6 }
  if (rect.width >= 2 * MIN_GROUP.width) return { edge: 'right', of: holder }
  return holder
}

/**
 * Open (or re-focus) a tab and show the panel.
 * @returns the id of the opened or reused tab.
 */
export function openTab(input: SideTabInput, options: OpenOptions = {}): string {
  const selection = options.scope ? ctxOfScope(options.scope) : ctx()
  const tab = { ...input, id: newTabId(input.type), binding: bindingFor(input, selection) } as SideTab
  const target = (options.besideType ? besideTarget(layout(), options.besideType, selection, get().viewport) : null) ?? options.target ?? 'auto'
  const replace = options.replace ?? null
  const change = dockOpenTab(layout(), tab, target, selection, policy(), { background: options.background, replace })
  // What an open closes on its way is never the user closing it: the chooser it replaced, tabs past the cap.
  apply(change, false, closed => (closed.id === replace ? 'replaced' : 'evicted'))
  return change.tabId
}

/** Show the chooser in a group (default: the focused one): re-focus its launcher or add one. */
export function openLauncher(groupId?: string | null) {
  const state = layout()
  const group = groupId && isGroup(state, groupId) ? groupId : groupsByRecency(state)[0]
  const existing = group ? visibleTabs(state, group, ctx()).find(tab => tab.type === 'launcher') : undefined
  if (existing) { activateTab(existing.id); return existing.id }
  return openTab({ type: 'launcher' }, { target: group ?? 'auto' })
}

/** The user shows a tab (a strip click, the keyboard): in its group for the selected conversation, its group focused, the panel shown. */
export function activateTab(id: string, scope?: string) {
  apply(dockActivate(layout(), id, scope ? ctxOfScope(scope) : ctx()))
  const tab = layout().tabs[id]
  if (tab) notifyPicked([tab])
}

/* -------------------------------------------------------------- closing */

export function closeTab(id: string, scope?: string) {
  apply(dockCloseTab(layout(), id, scope ? ctxOfScope(scope) : ctx(), policy()))
}

export function closeOtherTabs(id: string, scope?: string) {
  apply(dockCloseTabs(layout(), id, 'others', scope ? ctxOfScope(scope) : ctx(), policy()))
}

/** The tab context menu, over the tabs its group shows: every tab, or those to the left / right of `id`. The active tab survives unless closed; then `id` takes over. */
export function closeTabsBeside(id: string, side: 'left' | 'right' | 'all', scope?: string) {
  apply(dockCloseTabs(layout(), id, side, scope ? ctxOfScope(scope) : ctx(), policy()))
}

/**
 * The merged strip's (phone sheet, narrow window) 关闭其他 / 左侧 / 右侧 / 全部: over `listed`, the tabs that strip
 * shows across groups; `shownId` is the one it shows.
 */
export function closeAmongTabs(id: string, side: 'others' | 'left' | 'right' | 'all', listed: string[], shownId: string | null) {
  apply(dockCloseAmong(layout(), id, side, listed, shownId, ctx(), policy()))
}

/** 关闭整组: the tabs the group shows for the selected conversation; tabs that show elsewhere move to another group, or keep the only one (dock `closeGroup`). */
export function closeGroup(groupId: string) { apply(dockCloseGroup(layout(), groupId, policy(), ctx())) }

/* ------------------------------------------------------------- updating */

/** A tab body's own update (title, URL, terminal id): not an undo step. */
export function updateTab(id: string, patch: Partial<SideTabInput>, _scope?: string) {
  void _scope
  apply(dockUpdateTab(layout(), id, patch as Partial<SideTab>), true)
}

export function findTab(id: string): SideTab | undefined { return layout().tabs[id] }

export function setSeed(tabId: string, seed: { text: string; itemId?: string | null } | null) {
  set(s => {
    const seeds = { ...s.seeds }
    if (seed) seeds[tabId] = seed
    else delete seeds[tabId]
    return { seeds }
  })
}

/** Next ordinal for a new 辅助对话 in this conversation ("辅助对话 2"). */
export function nextSideOrdinal(scope?: string) {
  const tabs = tabsInScope(layout(), scope ? ctxOfScope(scope) : ctx())
  return tabs.reduce((n, t) => (t.type === 'side-chat' ? Math.max(n, t.ordinal) : n), 0) + 1
}

/* ------------------------------------------------------- showing / hiding */

/** Show or hide every panel group (decision D1: one switch for the window). Opening with no group shows the chooser. */
export function setPanelOpen(open: boolean, _scope?: string) {
  void _scope
  if (open && !groupIds(layout()).length) { openLauncher(); return }
  apply(setCollapsed(layout(), !open))
}

/** ⌥⌘B: toggle the panels. */
export function togglePanel(_scope?: string) {
  void _scope
  setPanelOpen(!panelsOpen(layout()))
}

/** Reactive: whether panels show (the top bar's toggle). */
export const usePanelsOpen = () => useSidePanel(s => !s.layout.collapsed && Object.values(s.layout.nodes).some(node => node.kind === 'group'))

/** Maximize a group over the conversation; the same group (or null) restores. Not persisted. */
export function maximizeGroup(groupId: string | null) { apply(dockMaximize(layout(), groupId)) }

/** Old wide-mode switch: maximize the focused group, or restore. */
export function setMaximized(maximized: boolean) {
  const state = layout()
  maximizeGroup(maximized ? state.activeGroup ?? groupsByRecency(state)[0] ?? null : null)
}

/** Minimize a group to its edge strip, or bring it back. */
export function minimizeGroup(groupId: string, minimized = true) { apply(dockMinimize(layout(), groupId, minimized)) }

/** Focus moves are not undo steps. */
export function focusGroup(groupId: string) { apply(dockFocusGroup(layout(), groupId)) }

/* --------------------------------------------------------------- moving */

/** Keyboard reordering (Alt+←/→ on a focused tab): past the neighbouring tab its group shows. */
export function moveTab(id: string, delta: number, scope?: string) {
  const state = layout()
  if (!state.tabs[id]) return
  const selection = scope ? ctxOfScope(scope) : ctx()
  const groupId = tabGroupId(state, id)
  const visible = visibleTabs(state, groupId, selection)
  const from = visible.findIndex(tab => tab.id === id)
  const to = Math.max(0, Math.min(visible.length - 1, from + delta))
  if (from < 0 || from === to) return
  const ids = getGroup(state, groupId).tabIds
  const anchor = ids.indexOf(visible[to].id)
  apply(dockMoveTab(state, id, groupId, selection, policy(), to > from ? anchor + 1 : anchor))
}

/**
 * Drop a tab at a strip slot of a group (`slot` counts the chips the group
 * shows, the dragged one included): a reorder in its own group, else a move.
 */
export function placeTab(id: string, groupId: string, slot: number) {
  const state = layout()
  if (!state.tabs[id] || !isGroup(state, groupId)) return
  const visible = visibleTabs(state, groupId, ctx())
  const ids = getGroup(state, groupId).tabIds
  const index = slot < visible.length ? ids.indexOf(visible[slot].id) : visible.length ? ids.indexOf(visible.at(-1)!.id) + 1 : ids.length
  apply(dockMoveTab(state, id, groupId, ctx(), policy(), index))
}

/** Move a tab into a group, or to an edge of any node (group, conversation, split), splitting it. */
export function moveTabTo(id: string, to: NodeId | { edge: Edge; of: NodeId }) {
  apply(dockMoveTab(layout(), id, to, ctx(), policy()))
}

/** 移到左/右/上/下侧的组: the neighbouring group on that side, or a new one split off there. */
export function moveTabToward(id: string, edge: Edge) { apply(dockMoveToward(layout(), id, edge, ctx(), policy())) }

/** 向右拆分 / 向下拆分: with `tabId`, that tab moves into the new group; without, the new group opens the chooser. */
export function splitGroup(groupId: string, direction: 'right' | 'down', tabId?: string) {
  apply(dockSplitGroup(layout(), groupId, direction, ctx(), policy(), tabId))
}

/** Hang a whole group on an edge of the conversation. */
export function moveGroup(groupId: string, edge: Edge) { apply(dockMoveGroup(layout(), groupId, edge, policy())) }

/** Set a split's sizes (fractions). */
export function resizeSplit(splitId: string, sizes: number[]) { apply(dockResize(layout(), splitId, sizes)) }

/** A finished divider drag of `deltaPx` against the geometry it started from (dropped if that split changed meanwhile). */
export function resizeDivider(geometry: Geometry, divider: Divider, deltaPx: number) {
  const split = layout().nodes[divider.split]
  if (split?.kind !== 'split' || Math.max(divider.before, divider.after) >= split.children.length) return
  apply(dockResizeDivider(layout(), geometry, divider, deltaPx))
}

/** Layout presets (侧栏 / 底部 / 右侧上下 / 三栏 / 填充并排列) as one undo step. */
export function applyPreset(preset: Preset) {
  const viewport = get().viewport ?? { width: guessedWidth(), height: 800 }
  apply(arrange(layout(), preset, { mint, size: viewport, dockWidth: storedDockWidth(), seed: policy().seed }))
}

/* -------------------------------------------------------- saved layouts */

/** Panels a saved layout opens again when missing: places to look at, not content (a terminal would start a shell). */
function savedPanel(tab: SideTab): Record<string, unknown> | null {
  switch (tab.type) {
    case 'tasks': return { type: 'tasks', ...(tab.projectFilter ? { projectFilter: tab.projectFilter } : {}) }
    case 'files': case 'evolution': return { type: tab.type, projectId: tab.projectId ?? null }
    // A panel that follows the current project keeps its view (mode, tree, wrap) but not a branch or worktree of the
    // project it was saved in: applied in another project, those would not exist there.
    case 'worktree': { const view = worktreeView(tab); return { type: 'worktree', projectId: tab.projectId ?? null, ...view, ...(tab.projectId ? {} : { base: null, target: null }) } }
    default: return null
  }
}
const SAVED_PANELS = new Set<string>(['tasks', 'files', 'evolution', 'worktree'])

/** A saved panel as a new tab for the selection (bound as `openTab` binds it). */
function reopen(panel: Record<string, unknown>): SideTab | null {
  const type = panel.type
  if (typeof type !== 'string' || !SAVED_PANELS.has(type)) return null
  const data = sanitizeData({ ...panel, id: newTabId(type as SideTabType) })
  return data ? { ...data, binding: bindingFor(data, ctx()) } as SideTab : null
}

/** The saved layouts this version can apply, oldest first. */
export const listSavedLayouts = (): SavedLayout[] => savedLayouts(get().presets)
/** Reactive `listSavedLayouts` (the 布局 menu). */
export const useSavedLayouts = (): SavedLayout[] => savedLayouts(useSidePanel(s => s.presets))

/**
 * 保存当前布局: keep the current shape under `name`; a layout already saved under that name is replaced in place.
 * @returns its id, or null when there is nothing to save (no name, no group) or MAX_SAVED_LAYOUTS are kept already.
 */
export function saveLayout(name: string): { id: string; replaced: boolean } | null {
  const clean = name.trim().slice(0, LAYOUT_NAME_MAX)
  const state = layout()
  if (!clean || !groupIds(state).length) return null
  const saved = listSavedLayouts()
  const same = saved.find(entry => sameLayoutName(entry.name, clean))
  if (!same && saved.length >= MAX_SAVED_LAYOUTS) return null
  const id = same?.id ?? `layout-${Date.now().toString(36)}-${(++seq).toString(36)}`
  const value = savedRecord(captureLayout(state, clean, same?.savedAt ?? Date.now(), { identity: reusable, panel: savedPanel }))
  set(s => ({ presets: { ...s.presets, [id]: value } }))
  return { id, replaced: Boolean(same) }
}

/**
 * Apply a saved layout as one undo step: open tabs go back where their kind was, missing panels open, empty groups
 * show the chooser, and the panels show.
 * @returns false when it is not there or cannot be applied.
 */
export function applySavedLayout(id: string): boolean {
  const saved = listSavedLayouts().find(entry => entry.id === id)
  if (!saved) return false
  const before = layout()
  let change: Change<SideTab>
  try {
    change = restoreLayout(before, saved, { mint, identity: reusable, open: reopen, seed: policy().seed! })
  } catch { return false }
  apply(change)
  // The user brought these up (e.g. 后台任务 opens by itself again for the current project).
  notifyPicked(Object.values(change.state.tabs).filter(tab => !(tab.id in before.tabs) && tab.type !== 'launcher'))
  return true
}

/**
 * Forget a saved layout.
 * @returns what was stored, for `restoreSavedLayout` (undo), or undefined when there was none.
 */
export function deleteSavedLayout(id: string): unknown {
  const presets = get().presets
  if (!(id in presets)) return undefined
  const { [id]: removed, ...rest } = presets
  set({ presets: rest })
  return removed
}

/** Put a deleted saved layout back (its place in the list comes from when it was saved). */
export function restoreSavedLayout(id: string, value: unknown) {
  if (value !== undefined) set(s => ({ presets: { ...s.presets, [id]: value } }))
}

/* ----------------------------------------------------------------- undo */

/** Apply an undo / redo step: closed tabs are reported; a terminal that comes back starts a fresh shell (its old one ended on close). */
function settleStep(before: LayoutState<SideTab>, step: { state: LayoutState<SideTab>; history: History<SideTab> }) {
  let next = step.state
  for (const tab of Object.values(next.tabs)) {
    if (tab.id in before.tabs || tab.type !== 'terminal' || !tab.terminalId) continue
    next = { ...next, tabs: { ...next.tabs, [tab.id]: { ...tab, terminalId: null, title: null } } }
  }
  setLayout(next, step.history)
  notifyClosed(Object.values(before.tabs).filter(tab => !(tab.id in next.tabs)))
  notifyPicked(Object.values(next.tabs).filter(tab => !(tab.id in before.tabs)))
}

function step(direction: 'back' | 'forward'): boolean {
  const { history, layout: before } = get()
  let stepped: ReturnType<typeof stepBack<SideTab>>
  try {
    stepped = direction === 'back' ? stepBack(history, before) : stepForward(history, before)
  } catch {
    // The layout moved on in a way the recorded ops no longer fit: start a fresh history.
    set({ history: EMPTY_HISTORY })
    return false
  }
  if (!stepped) return false
  settleStep(before, stepped)
  return true
}

export const undoLayout = () => step('back')
export const redoLayout = () => step('forward')
export const useCanUndo = () => useSidePanel(s => s.history.cursor > 0)
export const useCanRedo = () => useSidePanel(s => s.history.cursor < s.history.entries.length)

/**
 * ⌘⇧T: reopen the tab closed last, when closing was the last layout change. An open that closed something on the
 * way (the chooser it replaced, a tab over the cap) is not a close: undoing it would close the tab just opened.
 */
export function reopenClosedTab(): boolean {
  const { history } = get()
  const last = history.entries[history.cursor - 1]
  if (!last?.ops.some(op => op.type === 'closeTab') || last.ops.some(op => op.type === 'openTab' || op.type === 'insertTab')) return false
  return undoLayout()
}

/* ---------------------------------------------------------- app binding */

/** The selection from the app store: the conversation and its project (else the project page). */
function appCtx(): WorkspaceCtx {
  const s = useApp.getState()
  const sessionId = s.selectedSessionId
  const projectId = (sessionId ? s.sessions[sessionId]?.meta.projectId ?? s.sessionIndex[sessionId]?.projectId : null) ?? s.selectedProjectId ?? null
  return { sessionId, projectId }
}
setContext(appCtx())
useApp.subscribe(() => setContext(appCtx()))

/** Test helper: reset to a clean state (the given layout, or the default collapsed one). */
export function resetSidePanel(next?: LayoutState<SideTab>) {
  writer.cancel()
  const fresh = next ?? loadLayout<SideTab>({ parseTab: sanitizeTab, parseV1Tab: sanitizeV1Tab, identity: tabIdentity, mergeV1: mergeV1Tab, mint, store: null }).layout
  set({ scope: 'global', ctx: { sessionId: null, projectId: null }, layout: fresh, history: EMPTY_HISTORY, viewport: null, sheet: false, seeds: {}, presets: {} })
}

/** Write the layout now (tests, and before the page unloads). */
export const flushLayout = () => writer.flush()
if (typeof window !== 'undefined') window.addEventListener('pagehide', flushLayout)
