/**
 * Persistence shapes (design 1.6): the default layout, v1 → v2 migration from
 * `rna.sidePanel.v1` (per-scope panes `{ tabs, activeId, open, touched }`), and
 * a sanitizer for persisted v2 layouts. Tab parsing is the caller's (today's
 * `sanitizeTab` plus the v2 binding), so this module stays type-agnostic.
 *
 * Migration folds every scope's tabs into one right-hand group with
 * `activeByScope[scope] = pane.activeId`. Per-scope `open` flags are lost;
 * `collapsed` comes from the current scope only (decision D1).
 */
import { MAIN, type DockTab, type GroupNode, type LayoutNode, type LayoutState, type Mint, type NodeId, type ScopeKey, type TabId } from './types'
import { emptyGroup, isGroup, layoutProblems } from './tree'
import { normalizeNodes } from './planner'
import { shareOf } from './geometry'

/** v1 kept at most this many tabs per scope. */
export const V1_MAX_TABS = 12

/** row[main, group]: today's conversation | side panel, collapsed until opened. */
export function defaultLayout<T extends DockTab>(mint: Mint, share: number, collapsed = true): LayoutState<T> {
  const groupId = mint('group')
  const splitId = mint('split')
  return {
    version: 2,
    root: splitId,
    nodes: { [MAIN]: { kind: 'main' }, [groupId]: emptyGroup(), [splitId]: { kind: 'split', axis: 'row', children: [MAIN, groupId], sizes: [1 - share, share] } },
    tabs: {},
    activeGroup: groupId,
    recent: [groupId],
    collapsed,
    maximizedGroup: null,
  }
}

export interface MigrateOptions<T extends DockTab> {
  /** Sanitize one v1 tab and give it its v2 binding; null drops it (unparsable, or a retired type such as overview). */
  parseTab: (value: unknown, scope: ScopeKey) => T | null
  /** Tabs sharing an identity across scopes become one (e.g. one launcher, one terminal per id). */
  identity?: (tab: T) => string | null
  /**
   * The tab kept for an identity seen again in another scope (`duplicate`, as parsed there): what it becomes, so it
   * still shows where both did (e.g. a wider binding). Default: kept as first parsed (newest scope).
   */
  merge?: (kept: T, duplicate: T) => T
  /** The selected scope: its `open` flag becomes `!collapsed`. */
  scope: ScopeKey
  mint: Mint
  /** Old `rna.dockWidth` in pixels and the width it is a share of. */
  dockWidth: number
  width: number
  /** Workspace-bound tabs show in every scope, so at most this many carry over (newest scopes first); default 12. */
  maxShared?: number
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** Fold the v1 per-scope panes into the default layout's one group. */
export function migrateV1<T extends DockTab>(raw: string | null, options: MigrateOptions<T>): LayoutState<T> {
  const share = shareOf(options.dockWidth, options.width)
  let data: unknown = null
  try { data = raw ? JSON.parse(raw) : null } catch { data = null }
  const panes = record(record(data)?.panes)
  if (!panes) return defaultLayout(options.mint, share)
  const scopes = Object.entries(panes)
    .map(([scope, value]) => [scope, record(value)] as const)
    .filter((entry): entry is readonly [string, Record<string, unknown>] => Boolean(entry[1]) && Array.isArray(entry[1]!.tabs))
    .sort((a, b) => (Number(b[1].touched) || 0) - (Number(a[1].touched) || 0))
  const tabs: Record<TabId, T> = {}
  const tabIds: TabId[] = []
  const activeByScope: Record<ScopeKey, TabId> = {}
  const byIdentity = new Map<string, TabId>()
  const maxShared = options.maxShared ?? V1_MAX_TABS
  let shared = 0
  for (const [scope, pane] of scopes) {
    const local = new Map<TabId, TabId>()
    for (const value of (pane.tabs as unknown[]).slice(0, V1_MAX_TABS)) {
      const tab = options.parseTab(value, scope)
      if (!tab) continue
      const key = options.identity?.(tab) ?? null
      const kept = key === null ? undefined : byIdentity.get(key)
      if (kept) {
        if (options.merge) tabs[kept] = { ...options.merge(tabs[kept], tab), id: kept }
        local.set(tab.id, kept)
        continue
      }
      if (tabs[tab.id]) continue
      if (tab.binding === 'workspace' && shared++ >= maxShared) continue
      tabs[tab.id] = tab
      tabIds.push(tab.id)
      if (key !== null) byIdentity.set(key, tab.id)
      local.set(tab.id, tab.id)
    }
    const chosen = (typeof pane.activeId === 'string' ? local.get(pane.activeId) : undefined) ?? [...local.values()].at(-1)
    if (chosen) activeByScope[scope] = chosen
  }
  const state = defaultLayout<T>(options.mint, share, !record(panes[options.scope])?.open)
  const groupId = state.activeGroup!
  return { ...state, tabs, nodes: { ...state.nodes, [groupId]: { kind: 'group', tabIds, activeByScope } } }
}

export interface SanitizeOptions<T extends DockTab> {
  /** Validate one persisted tab; null drops it. */
  parseTab: (value: unknown) => T | null
  /** The layout a broken tree is replaced with (its first group receives the surviving tabs). */
  fallback: () => LayoutState<T>
}

/**
 * Validate a persisted v2 layout. Repairable damage (dangling or repeated
 * children, one-child splits, bad sizes, unknown or duplicated tabs, stale
 * focus) is repaired; a tree that loses main or a group falls back to the
 * default layout with every surviving tab in its group. Never maximized.
 */
export function sanitizeLayout<T extends DockTab>(value: unknown, options: SanitizeOptions<T>): LayoutState<T> {
  const data = record(value)
  const rawNodes = record(data?.nodes)
  if (!data || data.version !== 2 || !rawNodes || typeof data.root !== 'string') return options.fallback()
  const tabs: Record<TabId, T> = {}
  for (const [id, raw] of Object.entries(record(data.tabs) ?? {})) {
    const tab = options.parseTab(raw)
    if (tab && tab.id === id) tabs[id] = tab
  }
  const claimed = new Set<TabId>()
  const nodes: Record<NodeId, LayoutNode> = {}
  let broken = false
  for (const [id, raw] of Object.entries(rawNodes)) {
    const node = record(raw)
    if (node?.kind === 'main') {
      if (id === MAIN) nodes[id] = { kind: 'main' }
      else broken = true
    } else if (node?.kind === 'group') {
      const ids: TabId[] = []
      for (const tabId of Array.isArray(node.tabIds) ? node.tabIds : []) {
        // First group wins a tab listed twice, within one group or across groups.
        if (typeof tabId === 'string' && tabs[tabId] && !claimed.has(tabId)) { claimed.add(tabId); ids.push(tabId) }
      }
      const active = Object.entries(record(node.activeByScope) ?? {}).filter((entry): entry is [ScopeKey, TabId] => typeof entry[1] === 'string' && ids.includes(entry[1]))
      const group: GroupNode = { kind: 'group', tabIds: ids, activeByScope: Object.fromEntries(active) }
      if (node.minimized === true) group.minimized = true
      nodes[id] = group
    } else if (node?.kind === 'split' && (node.axis === 'row' || node.axis === 'column') && Array.isArray(node.children)) {
      const children = node.children.filter((child): child is NodeId => typeof child === 'string')
      const sizes = Array.isArray(node.sizes) && node.sizes.length === children.length && node.sizes.every(size => typeof size === 'number' && size > 0 && Number.isFinite(size))
        ? node.sizes as number[]
        : children.map(() => 1)
      nodes[id] = { kind: 'split', axis: node.axis, children, sizes }
    }
  }
  const pick = (ids: Set<TabId>) => Object.fromEntries(Object.entries(tabs).filter(([id]) => ids.has(id)))
  const groupsBefore = Object.keys(nodes).filter(id => nodes[id].kind === 'group')
  const normal = normalizeNodes(data.root, nodes)
  const lost = groupsBefore.some(id => !normal.nodes[id])
  const placed = new Set(Object.values(normal.nodes).flatMap(node => (node.kind === 'group' ? node.tabIds : [])))
  const recent = Array.isArray(data.recent) ? [...new Set(data.recent.filter((id): id is NodeId => typeof id === 'string'))] : []
  const candidate: LayoutState<T> = {
    version: 2,
    root: normal.root ?? MAIN,
    nodes: normal.nodes,
    tabs: pick(placed),
    activeGroup: typeof data.activeGroup === 'string' ? data.activeGroup : null,
    recent,
    collapsed: data.collapsed === true,
    maximizedGroup: null,
  }
  candidate.recent = candidate.recent.filter(id => isGroup(candidate, id))
  if (!isGroup(candidate, candidate.activeGroup)) candidate.activeGroup = candidate.recent[0] ?? null
  if (!broken && !lost && normal.root !== null && !layoutProblems(candidate).length) return candidate

  // A broken tree: keep the tabs, not the shape.
  const fallback = options.fallback()
  const target = Object.keys(fallback.nodes).find(id => fallback.nodes[id].kind === 'group')
  if (!target) return fallback
  const order = [...claimed]
  const group = fallback.nodes[target] as GroupNode
  return { ...fallback, collapsed: data.collapsed === true, tabs: { ...fallback.tabs, ...pick(claimed) }, nodes: { ...fallback.nodes, [target]: { ...group, tabIds: [...group.tabIds, ...order.filter(id => !group.tabIds.includes(id))] } } }
}

/** What is written: never maximized; `clean` strips a tab's transient fields. */
export function persistLayout<T extends DockTab>(state: LayoutState<T>, clean: (tab: T) => T = tab => tab): LayoutState<T> {
  return { ...state, maximizedGroup: null, tabs: Object.fromEntries(Object.entries(state.tabs).map(([id, tab]) => [id, clean(tab)])) }
}
