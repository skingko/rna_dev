/**
 * Which global panel is open. Settings is addressable (`#settings/models`, and
 * the legacy `?settings=models` query is honored once on load) so it behaves
 * like an in-app route; the other panels are plain modal state.
 */
import { create } from 'zustand'

export type SettingsTab = 'general' | 'models' | 'memory' | 'autonomy' | 'judgment' | 'evolution' | 'webtools' | 'updates' | 'usage' | 'about'
export const SETTINGS_TABS: SettingsTab[] = ['general', 'models', 'memory', 'autonomy', 'judgment', 'evolution', 'webtools', 'updates', 'usage', 'about']

export type EntityKind = 'project' | 'session'
/** `git` (0.63): 工作树与 Git — the new-conversation worktree default, kept worktrees, git init. */
export type ProjectSettingsTab = 'overview' | 'settings' | 'git'
/** A subagent worker's copy whose changes are not merged yet (B8): the host lists them when it refuses a deletion. */
export interface UnmergedWorker { agentId: string | null; worktreeId: string; files: number; task?: string; role?: string; secret?: number }
/**
 * `unapplied` (0.63): the host refused to delete a conversation whose worktree holds that many unapplied files;
 * `workers` (B8): …or whose subagent workers' copies hold changes not merged yet. Asked again with them. `secret`
 * (B8): how many of all those files hold secrets (never in Git: they go to the project's trash instead).
 */
export interface EntityTarget { kind: EntityKind; id: string; unapplied?: number; workers?: UnmergedWorker[]; secret?: number }

interface PanelState {
  settings: SettingsTab | null
  memory: { projectId: string | null } | null
  capabilities: { projectId: string | null; tab: 'installed' | 'market' | 'install' } | null
  archive: 'projects' | 'sessions' | null
  newProject: boolean
  permissions: string | null
  /** H4 项目概览与设置. */
  projectSettings: { projectId: string; tab: ProjectSettingsTab } | null
  rename: EntityTarget | null
  remove: EntityTarget | null
}

export const usePanels = create<PanelState>(() => ({
  settings: null,
  memory: null,
  capabilities: null,
  archive: null,
  newProject: false,
  permissions: null,
  projectSettings: null,
  rename: null,
  remove: null,
}))

const set = usePanels.setState

function writeHash(tab: SettingsTab | null) {
  const next = tab ? `#settings/${tab}` : ''
  if (location.hash === next || (!tab && !location.hash.startsWith('#settings'))) return
  history.replaceState(null, '', `${location.pathname}${location.search}${next}`)
}

export function openSettings(tab: SettingsTab = 'general') { set({ settings: tab }); writeHash(tab) }
export function closeSettings() { set({ settings: null }); writeHash(null) }
export function openMemory(projectId: string | null) { set({ memory: { projectId } }) }
export function openCapabilities(projectId: string | null, tab: 'installed' | 'market' | 'install' = 'installed') { set({ capabilities: { projectId, tab } }) }
export function openArchive(tab: 'projects' | 'sessions' = 'projects') { set({ archive: tab }) }
export function openNewProject() { set({ newProject: true }) }
export function openPermissions(projectId: string) { set({ permissions: projectId }) }
export function openProjectSettings(projectId: string, tab: ProjectSettingsTab = 'overview') { set({ projectSettings: { projectId, tab } }) }
export function openRename(target: EntityTarget) { set({ rename: target }) }
export function openDelete(target: EntityTarget) { set({ remove: target }) }

/** Hash / legacy query routing, read once at startup and on hash changes. */
export function routeFromLocation() {
  const hash = /^#settings(?:\/([a-z]+))?$/.exec(location.hash)
  if (hash) { set({ settings: SETTINGS_TABS.includes(hash[1] as SettingsTab) ? hash[1] as SettingsTab : 'general' }); return }
  const legacy = new URLSearchParams(location.search).get('settings')
  if (legacy) { set({ settings: legacy === 'models' || SETTINGS_TABS.includes(legacy as SettingsTab) ? legacy as SettingsTab : 'general' }); return }
  // `?demo=proactive` opens the project picker (it offers the demo strategy).
  if (new URLSearchParams(location.search).get('demo') === 'proactive') set({ newProject: true })
}
