/**
 * Layout presets and "fill and arrange" (design 1.3 items 3–4). Each builds a
 * whole new structure from the current groups and tabs and applies it as one
 * `replaceTree` (one undo step). Group ids are reused, most recently focused
 * first, so open groups keep their identity; every tab stays open.
 *
 * - sidebar: row[main, group]  ·  bottom: column[main, group] — every tab in one group.
 * - right-stacked: row[main, column[top, bottom]] — tasks/terminal-like tabs go to the bottom.
 * - three-column: row[left, main, right] — file-like tabs go left.
 * - fill: main keeps max(420px, 45%); every group tiles the rest in columns of
 *   at most 3, sized by type weight, tasks/terminal at the bottom of a column.
 * An empty slot of a two-group preset gets `seed` (the launcher) or is left out.
 */
import { MAIN, type DockTab, type GroupNode, type LayoutNode, type LayoutOp, type LayoutState, type Mint, type NodeId, type ScopeKey, type Size, type TabId } from './types'
import { freshId, getGroup, groupIds, normalizeSizes } from './tree'
import { commit, groupsByRecency, type Change } from './actions'
import { MIN_GROUP, MIN_MAIN, shareOf } from './geometry'

export type Preset = 'sidebar' | 'bottom' | 'right-stacked' | 'three-column' | 'fill'

export interface ArrangeOptions<T extends DockTab> {
  mint: Mint
  /** Container size in pixels; shares are computed from it. */
  size: Size
  /** Side group width in pixels (today's `rna.dockWidth`); default 460. */
  dockWidth?: number
  /** Bottom group height in pixels; default 280. */
  dockHeight?: number
  /** Size weight of a tab's group; default `TAB_WEIGHTS` by type, else 1. */
  weight?: (tab: T) => number
  /** Tabs that belong at the bottom; default `BOTTOM_TYPES`. */
  bottom?: (tab: T) => boolean
  /** Tabs the three-column preset puts on the left; default `LEFT_TYPES`. */
  left?: (tab: T) => boolean
  seed?: (id: TabId) => T
}

export const TAB_WEIGHTS: Record<string, number> = { browser: 2, 'agent-browser': 2, file: 1.5, files: 1.5, terminal: 1, tasks: 1 }
export const BOTTOM_TYPES = new Set(['tasks', 'terminal'])
export const LEFT_TYPES = new Set(['file', 'files', 'worktree'])

interface Slot { id: NodeId; group: GroupNode; seeded: boolean }

/** Deal every tab into `count` slots by `slotOf`, reusing group ids and per-scope choices. */
function dealSlots<T extends DockTab>(state: LayoutState<T>, count: number, slotOf: (tab: T) => number, mint: Mint, seed?: (id: TabId) => T): Slot[] {
  const visual = groupIds(state)
  const recency = groupsByRecency(state)
  const tabIds: TabId[][] = Array.from({ length: count }, () => [])
  for (const groupId of visual) for (const tabId of getGroup(state, groupId).tabIds) tabIds[slotOf(state.tabs[tabId])].push(tabId)
  const used = new Set<NodeId>()
  return tabIds.map(ids => {
    // The group that contributed most to this slot keeps its id (ties: the more recently focused).
    const owner = [...recency].filter(id => !used.has(id)).sort((a, b) => contribution(state, b, ids) - contribution(state, a, ids))[0]
    const id = owner ?? freshId(state, mint, 'group')
    used.add(id)
    const activeByScope: Record<ScopeKey, TabId> = {}
    for (const groupId of recency) {
      for (const [scope, tabId] of Object.entries(getGroup(state, groupId).activeByScope)) {
        if (!(scope in activeByScope) && ids.includes(tabId)) activeByScope[scope] = tabId
      }
    }
    return { id, group: { kind: 'group', tabIds: ids, activeByScope }, seeded: !ids.length && Boolean(seed) }
  })
}

const contribution = <T extends DockTab>(state: LayoutState<T>, groupId: NodeId, ids: TabId[]) =>
  getGroup(state, groupId).tabIds.filter(id => ids.includes(id)).length

function groupWeight<T extends DockTab>(state: LayoutState<T>, group: GroupNode, weight: (tab: T) => number) {
  return Math.max(1, ...group.tabIds.map(id => weight(state.tabs[id])))
}

/**
 * The structure a preset produces, plus the slots that need a seeded tab.
 * @returns null when there is nothing to arrange (fill with no groups).
 */
export function arrangeTree<T extends DockTab>(state: LayoutState<T>, preset: Preset, options: ArrangeOptions<T>): { root: NodeId; nodes: Record<NodeId, LayoutNode>; seeds: NodeId[] } | null {
  const { mint, size } = options
  const weight = options.weight ?? ((tab: T) => TAB_WEIGHTS[tab.type] ?? 1)
  const bottom = options.bottom ?? ((tab: T) => BOTTOM_TYPES.has(tab.type))
  const left = options.left ?? ((tab: T) => LEFT_TYPES.has(tab.type))
  const nodes: Record<NodeId, LayoutNode> = { [MAIN]: { kind: 'main' } }
  const split = (axis: 'row' | 'column', children: NodeId[], sizes: number[]): NodeId => {
    if (children.length === 1) return children[0]
    const id = freshId({ ...state, nodes: { ...state.nodes, ...nodes } }, mint, 'split')
    nodes[id] = { kind: 'split', axis, children, sizes: normalizeSizes(sizes) }
    return id
  }
  const side = shareOf(options.dockWidth ?? 460, size.width)

  if (preset === 'fill') {
    const groups = groupIds(state)
    if (!groups.length) return null
    const mainShare = Math.min(0.9, Math.max(MIN_MAIN.width / Math.max(1, size.width), 0.45))
    const room = Math.max(1, Math.floor(((1 - mainShare) * size.width) / MIN_GROUP.width))
    const cols = Math.max(1, Math.min(Math.ceil(groups.length / 3), room))
    const rows = Array.from({ length: cols }, (_, c) => Math.floor(groups.length / cols) + (c < groups.length % cols ? 1 : 0))
    const isBottom = (id: NodeId) => {
      const ids = getGroup(state, id).tabIds
      return ids.length > 0 && ids.every(tabId => bottom(state.tabs[tabId]))
    }
    const bottoms = groups.filter(isBottom), tops = groups.filter(id => !isBottom(id))
    const cells: (NodeId | null)[][] = rows.map(count => Array<NodeId | null>(count).fill(null))
    // Bottom-loving groups fill each column's lowest free cell in turn; the rest fill from the top.
    let b = 0
    for (let depth = 1; b < bottoms.length; depth++) {
      for (let c = 0; c < cols && b < bottoms.length; c++) if (depth <= rows[c]) cells[c][rows[c] - depth] = bottoms[b++]
    }
    let t = 0
    for (const column of cells) for (let i = 0; i < column.length; i++) if (column[i] === null) column[i] = tops[t++]
    const weights = new Map(groups.map(id => [id, groupWeight(state, getGroup(state, id), weight)]))
    for (const id of groups) {
      const group: GroupNode = { ...getGroup(state, id) }
      delete group.minimized
      nodes[id] = group
    }
    const columns = cells.map(column => split('column', column as NodeId[], column.map(id => weights.get(id!)!)))
    const colWeights = cells.map(column => Math.max(...column.map(id => weights.get(id!)!)))
    const total = colWeights.reduce((sum, w) => sum + w, 0)
    const root = split('row', [MAIN, ...columns], [mainShare, ...colWeights.map(w => ((1 - mainShare) * w) / total)])
    return { root, nodes, seeds: [] }
  }

  const count = preset === 'right-stacked' || preset === 'three-column' ? 2 : 1
  const slotOf = (tab: T) => (preset === 'right-stacked' ? (bottom(tab) ? 1 : 0) : preset === 'three-column' ? (left(tab) ? 0 : 1) : 0)
  let slots = dealSlots(state, count, slotOf, mint, options.seed)
  // Keep at least one slot so the panel keeps a group; drop other empty, unseeded ones.
  const keep = slots.filter(slot => slot.group.tabIds.length || slot.seeded)
  slots = keep.length ? keep : slots.slice(0, 1)
  for (const slot of slots) nodes[slot.id] = slot.group
  const seeds = slots.filter(slot => slot.seeded).map(slot => slot.id)
  const ids = slots.map(slot => slot.id)

  if (preset === 'bottom') {
    const below = shareOf(options.dockHeight ?? 280, size.height, MIN_GROUP.height, MIN_MAIN.height)
    return { root: split('column', [MAIN, ids[0]], [1 - below, below]), nodes, seeds }
  }
  if (preset === 'three-column' && slots.length === 2) {
    const leftShare = shareOf((options.dockWidth ?? 460) * 0.8, size.width)
    const sides = Math.min(leftShare + side, 1 - Math.max(0.3, Math.min(0.6, MIN_MAIN.width / Math.max(1, size.width))))
    const scale = sides / (leftShare + side)
    return { root: split('row', [ids[0], MAIN, ids[1]], [leftShare * scale, 1 - sides, side * scale]), nodes, seeds }
  }
  if (preset === 'three-column' && slots[0].group.tabIds.some(id => left(state.tabs[id]))) {
    return { root: split('row', [ids[0], MAIN], [side, 1 - side]), nodes, seeds }
  }
  const stack = preset === 'right-stacked' && slots.length === 2
    ? split('column', ids, slots.map(slot => (slot.seeded ? 1 : groupWeight(state, slot.group, weight))))
    : ids[0]
  return { root: split('row', [MAIN, stack], [1 - side, side]), nodes, seeds }
}

/** The ops a preset takes: the new structure, seeded launchers, and showing the panel. */
export function planArrange<T extends DockTab>(state: LayoutState<T>, preset: Preset, options: ArrangeOptions<T>): LayoutOp<T>[] {
  const tree = arrangeTree(state, preset, options)
  if (!tree) return []
  const ops: LayoutOp<T>[] = []
  if (state.maximizedGroup !== null) ops.push({ type: 'setMaximized', groupId: null })
  ops.push({ type: 'replaceTree', root: tree.root, nodes: tree.nodes })
  const taken = { ...state, nodes: { ...state.nodes, ...tree.nodes } }
  for (const groupId of tree.seeds) {
    if (options.seed) ops.push({ type: 'insertTab', groupId, tab: options.seed(freshId(taken, options.mint, 'tab')), index: 0 })
  }
  if (state.collapsed) ops.push({ type: 'setCollapsed', collapsed: false })
  return ops
}

/** Apply a preset as one change (one undo step). */
export function arrange<T extends DockTab>(state: LayoutState<T>, preset: Preset, options: ArrangeOptions<T>): Change<T> {
  return commit(state, planArrange(state, preset, options))
}
