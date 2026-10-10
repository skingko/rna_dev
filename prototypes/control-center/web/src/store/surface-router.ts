/**
 * Where 文件 and 进化 open (design 4.5, decision D5): both keep their full
 * page (the view tabs, deep links, `openMind`) and also open as workspace
 * panels, one per project — a panel following the current project counts as
 * that project's.
 *
 * `openSurface` first looks for a panel already on screen for that kind and
 * project and focuses it, so the same project is not shown twice; otherwise
 * it opens where the request asks, else where the user prefers: the view tabs
 * open the page (or the panel, once the user chose 总是在侧边面板中打开 for
 * that tab), the launcher and menus a panel. Moving between the two —
 * 在侧边面板中打开 on a view tab, 在主视图中打开 in a panel — takes the open
 * file along and leaves the place it came from.
 */
import { create } from 'zustand'
import { bindingMatches } from '@/lib/dock'
import { t } from '@/i18n'
import { useApp } from './app-store'
import { activateTab, closeTab, findTab, openTab, tabOnScreen, updateTab, useSidePanel, type OpenOptions, type ScreenView, type SideTab } from './side-panel-store'
import { selectProject } from './sync'
import { toast, useUi } from './ui-store'

export type SurfaceKind = 'files' | 'evolution'
export type SurfaceWhere = 'page' | 'panel'
/** Who asks: the view tabs (对话 / 文件视图 / 进化) open the page by default, the launcher and menus a panel. */
export type SurfaceOrigin = 'tabs' | 'launcher' | 'menu'

export const isSurfaceKind = (value: unknown): value is SurfaceKind => value === 'files' || value === 'evolution'

/** Per kind, where a view-tab click opens it (a per-viewer convenience). */
export const PREF_KEY = 'rna.surfaceWhere'

function loadPrefs(): Partial<Record<SurfaceKind, SurfaceWhere>> {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as Record<string, unknown> | null
    const prefs: Partial<Record<SurfaceKind, SurfaceWhere>> = {}
    for (const kind of ['files', 'evolution'] as const) if (raw?.[kind] === 'panel' || raw?.[kind] === 'page') prefs[kind] = raw[kind]
    return prefs
  } catch { return {} }
}

interface RouterState {
  /** Where a view-tab click opens each kind (absent: the page). */
  prefs: Partial<Record<SurfaceKind, SurfaceWhere>>
  /** A file the 文件 page selects once: a panel moved into the main view, or a caller naming a file. */
  pagePath: { projectId: string; path: string } | null
}

export const useSurfaceRouter = create<RouterState>(() => ({ prefs: loadPrefs(), pagePath: null }))

/** Where a view-tab click opens `kind`. */
export const useSurfacePreference = (kind: SurfaceKind): SurfaceWhere => useSurfaceRouter(s => s.prefs[kind] ?? 'page')

/** Remember where a view-tab click opens `kind`; null goes back to the page. */
export function setSurfacePreference(kind: SurfaceKind, where: SurfaceWhere | null) {
  const prefs = { ...useSurfaceRouter.getState().prefs }
  if (where && where !== 'page') prefs[kind] = where
  else delete prefs[kind]
  useSurfaceRouter.setState({ prefs })
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)) } catch { /* private mode: for this page only */ }
}

/** The file the 文件 page should select for `projectId`, once. */
export const usePagePath = (projectId: string) => useSurfaceRouter(s => (s.pagePath?.projectId === projectId ? s.pagePath.path : null))
export function clearPagePath() { if (useSurfaceRouter.getState().pagePath) useSurfaceRouter.setState({ pagePath: null }) }

/** The file the 文件 page shows now: it goes along when the page moves into a panel. */
let pageSelection: { projectId: string; path: string } | null = null
export function notePageSelection(projectId: string, path: string | null) {
  if (path) pageSelection = { projectId, path }
  else if (pageSelection?.projectId === projectId) pageSelection = null
}

/* ---------------------------------------------------------------- panels */

type SurfaceTab = Extract<SideTab, { type: SurfaceKind }>

/**
 * The panel showing `kind` for `projectId` in the current selection: a panel bound to it, or one following the
 * current project when that is it. One on screen first.
 */
export function surfacePanel(kind: SurfaceKind, projectId: string | null, view: ScreenView = useSidePanel.getState()): { tab: SurfaceTab; visible: boolean } | null {
  let hidden: SurfaceTab | null = null
  for (const each of Object.values(view.layout.tabs)) {
    if (each.type !== kind || !bindingMatches(each.binding, view.ctx)) continue
    const tab = each as SurfaceTab
    if ((tab.projectId ?? view.ctx.projectId) !== projectId) continue
    if (tabOnScreen(tab.id, view)) return { tab, visible: true }
    hidden ??= tab
  }
  return hidden ? { tab: hidden, visible: false } : null
}

/* ---------------------------------------------------------------- opening */

export interface OpenSurfaceOptions {
  /** Where to open; absent, the request's origin and the user's preference decide. */
  where?: SurfaceWhere
  /** 文件: a project file to select. */
  path?: string | null
  from?: SurfaceOrigin
  /** A new panel's placement (the launcher's chooser tab or group). */
  place?: Pick<OpenOptions, 'replace' | 'target'>
}

export interface SurfaceResult { where: SurfaceWhere; tabId: string | null }

/** The project the main view shows (the selected conversation's, else the selected project). */
function pageProject(): string | null {
  const app = useApp.getState()
  return app.selectedSessionId ? app.sessionIndex[app.selectedSessionId]?.projectId ?? app.selectedProjectId : app.selectedProjectId
}

function openPage(kind: SurfaceKind, projectId: string | null, path: string | null) {
  if (projectId && projectId !== pageProject()) selectProject(projectId)
  if (projectId && path) useSurfaceRouter.setState({ pagePath: { projectId, path } })
  useUi.setState({ view: kind, sidebarOpen: false })
}

/** Bring an existing panel up (and a file into it); a chooser the request came from gives way. */
function focusPanel(tab: SurfaceTab, path: string | null, place: OpenSurfaceOptions['place']): SurfaceResult {
  activateTab(tab.id)
  if (path && tab.type === 'files') updateTab(tab.id, { path })
  if (place?.replace && place.replace !== tab.id && findTab(place.replace)) closeTab(place.replace)
  return { where: 'panel', tabId: tab.id }
}

/**
 * Open 文件 or 进化 for a project (null: none selected; the page and a following panel say so).
 * @returns where it opened and, for a panel, its tab id.
 */
export function openSurface(kind: SurfaceKind, projectId: string | null, options: OpenSurfaceOptions = {}): SurfaceResult {
  const from = options.from ?? 'menu'
  let path = kind === 'files' ? options.path ?? null : null
  const found = options.where === 'page' ? null : surfacePanel(kind, projectId)
  // A panel on screen is where it shows; otherwise the request, else the origin and the user's preference decide.
  const where = found?.visible ? 'panel' : options.where ?? (from === 'tabs' ? useSurfaceRouter.getState().prefs[kind] ?? 'page' : 'panel')
  if (where === 'page') { openPage(kind, projectId, path); return { where, tabId: null } }

  // Moving the page into a panel (one already on screen included): the page's open file goes along, and the main view
  // goes back to the conversation.
  const moving = from === 'tabs' && useUi.getState().view === kind && projectId === pageProject()
  if (moving && kind === 'files' && !path && pageSelection?.projectId === projectId) path = pageSelection.path
  let tabId: string
  if (found) tabId = focusPanel(found.tab, path, options.place).tabId!
  else {
    const following = projectId === null || projectId === useSidePanel.getState().ctx.projectId
    const bound = following ? null : projectId
    tabId = kind === 'files'
      ? openTab({ type: 'files', projectId: bound, ...(path ? { path } : {}) }, options.place)
      : openTab({ type: 'evolution', projectId: bound }, options.place)
  }
  if (moving) useUi.setState({ view: 'chat' })
  else if (found?.visible && from === 'tabs' && !options.where) {
    // The view tab was clicked and the main view did not change: say where it is, with the way to the page.
    toast(kind === 'files' ? t('文件已经在侧边面板中显示。') : t('进化已经在侧边面板中显示。'), 'default', { action: { label: t('在主视图中打开'), run: () => showInMainView(found.tab.id) } })
  }
  return { where: 'panel', tabId }
}

/** The file each 文件 panel shows (by tab id), so 在主视图中打开 from elsewhere (the toast above) takes it along. */
const panelSelection = new Map<string, string>()
export function notePanelSelection(tabId: string, path: string | null) {
  if (path) panelSelection.set(tabId, path)
  else panelSelection.delete(tabId)
}

/** A panel's 在主视图中打开: the page takes over (with the panel's open file) and the panel closes. */
export function showInMainView(tabId: string, path: string | null = null) {
  const tab = findTab(tabId)
  if (!tab || !isSurfaceKind(tab.type)) return
  const projectId = (tab as SurfaceTab).projectId ?? useSidePanel.getState().ctx.projectId
  const shown = path ?? (tab.type === 'files' ? panelSelection.get(tabId) ?? null : null)
  closeTab(tabId)
  panelSelection.delete(tabId)
  openSurface(tab.type, projectId, { where: 'page', path: shown })
}

/** Test helper: forget preferences and pending page selections. */
export function resetSurfaceRouter() {
  pageSelection = null
  panelSelection.clear()
  try { localStorage.removeItem(PREF_KEY) } catch { /* ignore */ }
  useSurfaceRouter.setState({ prefs: {}, pagePath: null })
}
