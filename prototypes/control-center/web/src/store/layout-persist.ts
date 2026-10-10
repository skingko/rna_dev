/**
 * Workspace layout persistence (design 1.6). `rna.workspace.v2` holds
 * `{ version: 2, windows: { main: LayoutState }, presets }`, written 120 ms
 * after the last change (the side panel's old cadence). The first load
 * without it migrates `rna.sidePanel.v1`, whose per-scope tab strips fold
 * into one right-hand group (`migrateV1`); the v1 key is left in place.
 *
 * Tab parsing is the store's: this module only reads, migrates and writes.
 *
 * Saved layouts (design 1.3 item 3, 保存当前布局) live in the record's
 * `presets`, one entry per layout: the shape around the conversation (splits
 * and their sizes) and, per group, what it held — tab types and identities,
 * plus the panels that open again when missing (`captureLayout`). Applying
 * one (`restoreLayout`) rebuilds that shape as one undoable change: every
 * open tab goes to the group that held it (by identity, else by type, else
 * the largest group), missing panels open where they were, and a group left
 * with nothing shows the chooser. Entries this version cannot read are kept
 * as written.
 */
import {
  commit, defaultLayout, freshId, getGroup, groupIds, groupsByRecency, MAIN, migrateV1, persistLayout, sanitizeLayout, shareOf, treeIds,
  type Axis, type Change, type DockTab, type LayoutNode, type LayoutOp, type LayoutState, type Mint, type NodeId, type ScopeKey, type TabId,
} from '@/lib/dock'

export const WORKSPACE_KEY = 'rna.workspace.v2'
export const V1_KEY = 'rna.sidePanel.v1'
export const DOCK_WIDTH_KEY = 'rna.dockWidth'
export const WRITE_DELAY_MS = 120
/** The window this layout belongs to (pop-out windows get their own entries in a later phase). */
export const MAIN_WINDOW = 'main'
/** Left sidebar width: the workspace is the window minus it. */
const SIDEBAR_WIDTH = 288

type Store = Pick<Storage, 'getItem' | 'setItem'>

const storage = (): Store | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** The side group's preferred width in pixels (`rna.dockWidth`, today's dock width; default 460). */
export function storedDockWidth(store: Store | null = storage()): number {
  try { return Number(store?.getItem(DOCK_WIDTH_KEY)) || 460 } catch { return 460 }
}

/** Width the workspace will roughly have before it is measured. */
export const guessedWidth = () => Math.max(700, (typeof window === 'undefined' ? 1280 : window.innerWidth) - SIDEBAR_WIDTH)

/** The v1 scope the user touched last: its `open` flag decides whether the migrated panel starts expanded. */
export function lastTouchedScope(raw: string | null): ScopeKey {
  let data: unknown = null
  try { data = raw ? JSON.parse(raw) : null } catch { return 'global' }
  const panes = record(record(data)?.panes) ?? {}
  let best: { scope: ScopeKey; touched: number } = { scope: 'global', touched: -Infinity }
  for (const [scope, value] of Object.entries(panes)) {
    const touched = Number(record(value)?.touched) || 0
    if (touched > best.touched) best = { scope, touched }
  }
  return best.scope
}

export interface LoadOptions<T extends DockTab> {
  /** Validate one persisted v2 tab (binding included); null drops it. */
  parseTab: (value: unknown) => T | null
  /** Sanitize one v1 tab and give it its v2 binding from the scope it lived in; null drops it. */
  parseV1Tab: (value: unknown, scope: ScopeKey) => T | null
  /** Tabs sharing an identity across v1 scopes become one… */
  identity: (tab: T) => string | null
  /** …shown wherever each of them showed (see `MigrateOptions.merge`). */
  mergeV1?: (kept: T, duplicate: T) => T
  mint: Mint
  dockWidth?: number
  width?: number
  store?: Store | null
}

export interface Loaded<T extends DockTab> {
  layout: LayoutState<T>
  /** Saved layouts by id, as written (see `savedLayouts`). */
  presets: Record<string, unknown>
  source: 'v2' | 'v1' | 'default'
}

/** Read the saved layout: v2 when present (repaired), else migrated from v1, else the default (collapsed). */
export function loadLayout<T extends DockTab>(options: LoadOptions<T>): Loaded<T> {
  const store = options.store === undefined ? storage() : options.store
  const dockWidth = options.dockWidth ?? storedDockWidth(store)
  const width = options.width ?? guessedWidth()
  const fallback = () => defaultLayout<T>(options.mint, shareOf(dockWidth, width))
  const read = (key: string) => { try { return store?.getItem(key) ?? null } catch { return null } }
  const raw = read(WORKSPACE_KEY)
  if (raw) {
    let data: unknown = null
    try { data = JSON.parse(raw) } catch { data = null }
    const main = record(record(record(data)?.windows)?.[MAIN_WINDOW])
    if (main) {
      return { layout: sanitizeLayout(main, { parseTab: options.parseTab, fallback }), presets: record(record(data)?.presets) ?? {}, source: 'v2' }
    }
  }
  const v1 = read(V1_KEY)
  if (v1) {
    const layout = migrateV1<T>(v1, { parseTab: options.parseV1Tab, identity: options.identity, merge: options.mergeV1, scope: lastTouchedScope(v1), mint: options.mint, dockWidth, width })
    return { layout, presets: {}, source: 'v1' }
  }
  return { layout: fallback(), presets: {}, source: 'default' }
}

/** The stored record; `clean` strips a tab's transient fields (reload nonces and the like). */
export function serializeWorkspace<T extends DockTab>(layout: LayoutState<T>, clean: (tab: T) => T = tab => tab, presets: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 2, windows: { [MAIN_WINDOW]: persistLayout(layout, clean) }, presets })
}

/** Debounced writes: each `schedule` restarts the delay; `flush` writes now. Storage errors (private mode, quota) are ignored. */
export function createLayoutWriter(serialize: () => string, delay = WRITE_DELAY_MS, store: () => Store | null = storage) {
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null }
    try { store()?.setItem(WORKSPACE_KEY, serialize()) } catch { /* private mode / quota */ }
  }
  return {
    schedule() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, delay)
    },
    flush,
    cancel() { if (timer) { clearTimeout(timer); timer = null } },
  }
}

/* -------------------------------------------------------- saved layouts */

/** Saved layouts kept at most; past it, one has to go before another is saved. */
export const MAX_SAVED_LAYOUTS = 20
export const LAYOUT_NAME_MAX = 40
const SAVED_VERSION = 1

/** A group as saved: what it held, so tabs find their way back. */
export interface SavedGroup {
  kind: 'group'
  /** Types of the tabs it held, in strip order, once each. */
  types: string[]
  /** Identities of the reusable tabs it held. */
  keys: string[]
  /** Panels it held that open again when missing: their own fields (e.g. `{ type: 'tasks' }`). */
  panels: Record<string, unknown>[]
  minimized?: boolean
}
export type SavedNode = { kind: 'main' } | { kind: 'split'; axis: Axis; children: NodeId[]; sizes: number[] } | SavedGroup

/** One saved layout: the panels' shape around the conversation and what each group held. */
export interface SavedLayout {
  id: string
  name: string
  /** When it was first saved (saving again under its name keeps its place in the list). */
  savedAt: number
  root: NodeId
  nodes: Record<NodeId, SavedNode>
}

/** Names match ignoring surrounding spaces and letter case. */
export const sameLayoutName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

/** One stored entry, or null when it is not a saved layout this version can apply (kept as written, never listed). */
export function parseSavedLayout(id: string, value: unknown): SavedLayout | null {
  const data = record(value)
  const raw = record(data?.nodes)
  if (!data || !raw || data.version !== SAVED_VERSION || typeof data.name !== 'string' || !data.name.trim() || typeof data.root !== 'string') return null
  const nodes: Record<NodeId, SavedNode> = {}
  let mains = 0, groups = 0
  const walk = (nodeId: NodeId, depth: number): boolean => {
    const node = record(raw[nodeId])
    if (!node || nodeId in nodes || depth > 32) return false
    if (node.kind === 'main') { mains += 1; nodes[nodeId] = { kind: 'main' }; return nodeId === MAIN }
    if (node.kind === 'group') {
      groups += 1
      const panels = Array.isArray(node.panels) ? node.panels.filter((panel): panel is Record<string, unknown> => record(panel) !== null && typeof (panel as { type?: unknown }).type === 'string') : []
      nodes[nodeId] = { kind: 'group', types: [...new Set(strings(node.types))], keys: strings(node.keys), panels, ...(node.minimized === true ? { minimized: true } : {}) }
      return true
    }
    const children = strings(node.children)
    const sizes = Array.isArray(node.sizes) ? node.sizes : []
    if (node.kind !== 'split' || (node.axis !== 'row' && node.axis !== 'column') || !Array.isArray(node.children) || children.length < 2 || children.length !== node.children.length) return false
    if (sizes.length !== children.length || !sizes.every(size => typeof size === 'number' && Number.isFinite(size) && size > 0)) return false
    const total = (sizes as number[]).reduce((sum, size) => sum + size, 0)
    nodes[nodeId] = { kind: 'split', axis: node.axis, children, sizes: (sizes as number[]).map(size => size / total) }
    return children.every(child => walk(child, depth + 1))
  }
  if (!walk(data.root, 0) || mains !== 1 || !groups) return null
  return { id, name: data.name.trim().slice(0, LAYOUT_NAME_MAX), savedAt: Number(data.savedAt) || 0, root: data.root, nodes }
}

let listed: { presets: Record<string, unknown>; layouts: SavedLayout[] } | null = null
/** The saved layouts in `presets` that this version can apply, oldest first (one parse per record object). */
export function savedLayouts(presets: Record<string, unknown>): SavedLayout[] {
  if (listed?.presets === presets) return listed.layouts
  const layouts = Object.entries(presets)
    .map(([id, value]) => parseSavedLayout(id, value))
    .filter((layout): layout is SavedLayout => layout !== null)
    .sort((a, b) => a.savedAt - b.savedAt)
  listed = { presets, layouts }
  return layouts
}

/** What a saved layout is written as (its id is its key in `presets`). */
export function savedRecord(layout: Omit<SavedLayout, 'id'>): Record<string, unknown> {
  return { version: SAVED_VERSION, name: layout.name, savedAt: layout.savedAt, root: layout.root, nodes: layout.nodes }
}

export interface CaptureOptions<T extends DockTab> {
  /** Same identity → the same tab when the layout is applied (null: not reusable). */
  identity: (tab: T) => string | null
  /** A tab's own fields when it should open again with the layout (a panel, not a piece of content); else null. */
  panel: (tab: T) => Record<string, unknown> | null
}

/** The current layout as a saved one (its shape; the conversation's size; what each group holds). */
export function captureLayout<T extends DockTab>(state: LayoutState<T>, name: string, savedAt: number, options: CaptureOptions<T>): Omit<SavedLayout, 'id'> {
  const nodes: Record<NodeId, SavedNode> = {}
  for (const id of treeIds(state)) {
    const node = state.nodes[id]
    if (node.kind === 'group') {
      const tabs = node.tabIds.map(tabId => state.tabs[tabId])
      nodes[id] = {
        kind: 'group', types: [...new Set(tabs.map(tab => tab.type))],
        keys: tabs.map(options.identity).filter((key): key is string => key !== null),
        panels: tabs.map(options.panel).filter((panel): panel is Record<string, unknown> => panel !== null),
        ...(node.minimized ? { minimized: true } : {}),
      }
    } else nodes[id] = node.kind === 'split' ? { kind: 'split', axis: node.axis, children: [...node.children], sizes: [...node.sizes] } : { kind: 'main' }
  }
  return { name: name.trim().slice(0, LAYOUT_NAME_MAX), savedAt, root: state.root, nodes }
}

export interface RestoreOptions<T extends DockTab> {
  mint: Mint
  identity: (tab: T) => string | null
  /** A saved panel as a new tab (null: it no longer makes sense). */
  open: (panel: Record<string, unknown>) => T | null
  /** What a group left with nothing shows (the chooser). */
  seed: (id: TabId) => T
}

/** The ops that rebuild `saved` around the open tabs (see the module comment). */
export function planSavedLayout<T extends DockTab>(state: LayoutState<T>, saved: SavedLayout, options: RestoreOptions<T>): LayoutOp<T>[] {
  // Saved groups in visual order, with the share of the workspace each one had.
  const order: NodeId[] = []
  const area = new Map<NodeId, number>()
  const measure = (id: NodeId, share: number) => {
    const node = saved.nodes[id]
    if (node.kind === 'group') { order.push(id); area.set(id, share) }
    else if (node.kind === 'split') node.children.forEach((child, index) => measure(child, share * node.sizes[index]))
  }
  measure(saved.root, 1)
  const group = (id: NodeId) => saved.nodes[id] as SavedGroup
  const byKey = new Map<string, NodeId>(), byType = new Map<string, NodeId>()
  for (const id of order) {
    for (const key of group(id).keys) if (!byKey.has(key)) byKey.set(key, id)
    for (const type of group(id).types) if (!byType.has(type)) byType.set(type, id)
  }
  const largest = [...order].sort((a, b) => Number(Boolean(group(a).minimized)) - Number(Boolean(group(b).minimized)) || area.get(b)! - area.get(a)!)[0]

  // Every open tab goes where its identity (else its type) was, else to the largest group.
  const dealt = new Map<NodeId, TabId[]>(order.map(id => [id, []]))
  for (const groupId of groupIds(state)) {
    for (const tabId of getGroup(state, groupId).tabIds) {
      const tab = state.tabs[tabId], key = options.identity(tab)
      dealt.get((key !== null ? byKey.get(key) : undefined) ?? byType.get(tab.type) ?? largest)!.push(tabId)
    }
  }

  // The open group that gives a saved group most of its tabs keeps its id (ties: the more recently focused).
  const nodes: Record<NodeId, LayoutNode> = { [MAIN]: { kind: 'main' } }
  const taken = () => ({ ...state, nodes: { ...state.nodes, ...nodes } })
  const recency = groupsByRecency(state), used = new Set<NodeId>(), ids = new Map<NodeId, NodeId>()
  for (const savedId of order) {
    const tabIds = dealt.get(savedId)!
    const gives = (id: NodeId) => getGroup(state, id).tabIds.filter(tabId => tabIds.includes(tabId)).length
    const owner = recency.filter(id => !used.has(id)).sort((a, b) => gives(b) - gives(a))[0]
    const id = owner ?? freshId(taken(), options.mint, 'group')
    used.add(id)
    ids.set(savedId, id)
    const activeByScope: Record<ScopeKey, TabId> = {}
    for (const from of recency) {
      for (const [scope, tabId] of Object.entries(getGroup(state, from).activeByScope)) if (!(scope in activeByScope) && tabIds.includes(tabId)) activeByScope[scope] = tabId
    }
    nodes[id] = { kind: 'group', tabIds, activeByScope, ...(group(savedId).minimized ? { minimized: true } : {}) }
  }
  const build = (savedId: NodeId): NodeId => {
    const node = saved.nodes[savedId]
    if (node.kind === 'main') return MAIN
    if (node.kind === 'group') return ids.get(savedId)!
    const id = freshId(taken(), options.mint, 'split')
    nodes[id] = { kind: 'split', axis: node.axis, children: [], sizes: [] } // holds the id while its children are built
    nodes[id] = { kind: 'split', axis: node.axis, children: node.children.map(build), sizes: [...node.sizes] }
    return id
  }
  const root = build(saved.root)

  const ops: LayoutOp<T>[] = []
  if (state.maximizedGroup !== null) ops.push({ type: 'setMaximized', groupId: null })
  ops.push({ type: 'replaceTree', root, nodes })
  // Panels the layout had and the window lacks open where they were; a group still empty gets the chooser.
  const present = new Set(Object.values(state.tabs).map(options.identity).filter((key): key is string => key !== null))
  const tabIds = new Set(Object.keys(state.tabs))
  const freeTabId = () => {
    for (let tries = 0; tries < 10_000; tries++) { const id = options.mint('tab'); if (!tabIds.has(id) && !(id in nodes) && !(id in state.nodes)) return id }
    throw new Error('layout: the mint keeps returning ids in use')
  }
  for (const savedId of order) {
    const groupId = ids.get(savedId)!
    let count = dealt.get(savedId)!.length
    for (const panel of group(savedId).panels) {
      const tab = options.open(panel)
      const key = tab ? options.identity(tab) : null
      if (!tab || tabIds.has(tab.id) || (key !== null && present.has(key))) continue
      if (key !== null) present.add(key)
      tabIds.add(tab.id)
      ops.push({ type: 'insertTab', groupId, tab, index: count++ })
    }
    if (!count) {
      const seed = options.seed(freeTabId())
      tabIds.add(seed.id)
      ops.push({ type: 'insertTab', groupId, tab: seed, index: 0 })
    }
  }
  if (state.collapsed) ops.push({ type: 'setCollapsed', collapsed: false })
  return ops
}

/** Apply a saved layout as one change (one undo step). */
export function restoreLayout<T extends DockTab>(state: LayoutState<T>, saved: SavedLayout, options: RestoreOptions<T>): Change<T> {
  return commit(state, planSavedLayout(state, saved, options))
}
