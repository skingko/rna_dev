/**
 * Intent planning: each interaction as a pure function from the current state
 * to the ops that carry it out. Planners mint the ids their ops create but
 * apply nothing (settle reads intermediate states); no ops = nothing changes.
 *
 * Ported from DeepSeek dockkit `ui-dockkit/src/engine/{planner,constraints}.ts`
 * (MIT, Copyright (c) 2026 DeepSeek; see LICENSE-dockkit.md): split, drop
 * (five zones), place, resize and settle. Float panes and the pane budget are
 * gone; settle keeps the main node and, by default, a lone last group; the
 * divider planner works in pixels against `computeRects` minimums.
 */
import { MAIN, type Axis, type DockTab, type DropZone, type Edge, type LayoutNode, type LayoutOp, type LayoutState, type Mint, type NodeId, type ScopeKey, type Side, type TabId } from './types'
import { applyOp } from './operations'
import { emptyGroup, freshId, getGroup, getNode, getSplit, groupIds, normalizeSizes, tabGroupId } from './tree'
import type { Divider, Geometry } from './geometry'

/** Share a new group takes beside the conversation or a split. */
export const DEFAULT_SHARE = 0.32
/** Smallest share a fractional resize may leave a child. */
export const MIN_FRACTION = 0.12
/** Fraction of a node's width or height that counts as its drop edge. */
export const DOCK_EDGE_FRACTION = 0.25

/** Which drop zone a pointer at fractional (x, y) of a node sits in. */
export function zoneAt(x: number, y: number, edge = DOCK_EDGE_FRACTION): DropZone {
  let zone: DropZone = 'left'
  let distance = x
  if (1 - x < distance) { zone = 'right'; distance = 1 - x }
  if (y < distance) { zone = 'top'; distance = y }
  if (1 - y < distance) { zone = 'bottom'; distance = 1 - y }
  return distance < edge ? zone : 'center'
}

export function edgeSplit(edge: Edge): { axis: Axis; side: Side } {
  switch (edge) {
    case 'left': return { axis: 'row', side: 'before' }
    case 'right': return { axis: 'row', side: 'after' }
    case 'top': return { axis: 'column', side: 'before' }
    case 'bottom': return { axis: 'column', side: 'after' }
  }
}

/** Clamp fractions so no child falls under `minimum`; the result sums to 1. */
export function clampSizes(sizes: number[], minimum = MIN_FRACTION): number[] {
  if (!sizes.length) return []
  const floor = Math.min(minimum, 1 / sizes.length)
  const positive = sizes.map(size => (size > 0 ? size : 0))
  const total = positive.reduce((sum, size) => sum + size, 0)
  let shares = total > 0 ? positive.map(size => size / total) : positive.map(() => 1 / sizes.length)
  // Pin every share under the floor and hand the remainder to the others in
  // proportion; one that only now drops under joins the pinned set next pass.
  const pinned = new Set<number>()
  for (;;) {
    const under = shares.flatMap((share, index) => (!pinned.has(index) && share < floor ? [index] : []))
    if (!under.length) return shares
    for (const index of under) pinned.add(index)
    const remainder = 1 - pinned.size * floor
    const freeTotal = shares.reduce((sum, share, index) => (pinned.has(index) ? sum : sum + share), 0)
    shares = shares.map((share, index) => (pinned.has(index) ? floor : (share / freeTotal) * remainder))
  }
}

const shareFor = <T extends DockTab>(state: LayoutState<T>, target: NodeId, share?: number) =>
  getNode(state, target).kind === 'group' ? 0.5 : share ?? DEFAULT_SHARE

/**
 * Split a group and seat a seeded tab (the launcher) in the new half, focused.
 * @returns no ops without a seed: an empty group would only be settled away.
 */
export function planSplitGroup<T extends DockTab>(
  state: LayoutState<T>, mint: Mint, groupId: NodeId, direction: 'right' | 'down', scope: ScopeKey, seed?: (id: TabId) => T,
): LayoutOp<T>[] {
  getGroup(state, groupId)
  if (!seed) return []
  const newGroupId = freshId(state, mint, 'group')
  const splitId = freshId(state, mint, 'split')
  const { axis, side } = edgeSplit(direction === 'right' ? 'right' : 'bottom')
  return [
    { type: 'addGroup', groupId: newGroupId, group: emptyGroup(), at: { mode: 'edge', target: groupId, axis, side, share: 0.5, splitId } },
    { type: 'openTab', groupId: newGroupId, tab: seed(freshId(state, mint, 'tab')), index: 0, scope },
  ]
}

/**
 * Put a tab at a strip slot: a reorder inside its own group, else a move.
 * @param index - caret slot counted over the chips as drawn, the dragged chip included.
 */
export function planPlaceTab<T extends DockTab>(state: LayoutState<T>, tabId: TabId, groupId: NodeId, index: number, scope: ScopeKey | null): LayoutOp<T>[] {
  const sourceId = tabGroupId(state, tabId)
  getGroup(state, groupId)
  if (sourceId === groupId) {
    // `reorderTab` indexes the strip without the tab: a caret past the chip counts the slot it vacates.
    const from = getGroup(state, sourceId).tabIds.indexOf(tabId)
    const to = index > from ? index - 1 : index
    return to === from ? [] : [{ type: 'reorderTab', tabId, index: to }]
  }
  return [{ type: 'moveTab', tabId, groupId, index, scope }]
}

/**
 * Resolve a tab release on a node: the centre of a group moves the tab in; an
 * edge of any node (group, main, split) splits it and seats the tab in the new
 * group. A group's only tab released on that group's own edge needs `seed` to
 * backfill it, otherwise nothing changes (the result would equal the start).
 */
export function planDropTab<T extends DockTab>(
  state: LayoutState<T>, mint: Mint, tabId: TabId, targetId: NodeId, zone: DropZone, scope: ScopeKey | null,
  options: { seed?: (id: TabId) => T; share?: number } = {},
): LayoutOp<T>[] {
  const sourceId = tabGroupId(state, tabId)
  const target = getNode(state, targetId)
  if (zone === 'center') {
    if (target.kind !== 'group' || targetId === sourceId) return []
    return [{ type: 'moveTab', tabId, groupId: targetId, index: target.tabIds.length, scope }]
  }
  const vacates = targetId === sourceId && getGroup(state, sourceId).tabIds.length === 1
  if (vacates && !options.seed) return []
  const { axis, side } = edgeSplit(zone)
  const groupId = freshId(state, mint, 'group')
  const splitId = freshId(state, mint, 'split')
  const ops: LayoutOp<T>[] = [{ type: 'addGroup', groupId, group: emptyGroup(), at: { mode: 'edge', target: targetId, axis, side, share: shareFor(state, targetId, options.share), splitId } }]
  if (vacates && options.seed) ops.push({ type: 'insertTab', groupId: sourceId, tab: options.seed(freshId(state, mint, 'tab')), index: 1 })
  ops.push({ type: 'moveTab', tabId, groupId, index: 0, scope })
  return ops
}

/** Record the net sizes of a divider drag, clamped to a fractional minimum. */
export function planResizeSplit<T extends DockTab>(splitId: NodeId, sizes: number[], minimum = MIN_FRACTION): LayoutOp<T>[] {
  return [{ type: 'resize', splitId, sizes: clampSizes(sizes, minimum) }]
}

/**
 * A divider drag in pixels: the two children beside the divider absorb the
 * move, each held at its pixel minimum (from `computeRects`); every other
 * child keeps its share exactly.
 */
export function planResizeDivider<T extends DockTab>(state: LayoutState<T>, geometry: Geometry, divider: Divider, deltaPx: number): LayoutOp<T>[] {
  const split = getSplit(state, divider.split)
  const row = divider.axis === 'row'
  const along = (id: NodeId) => (row ? geometry.rects[id]?.width : geometry.rects[id]?.height) ?? 0
  const min = (id: NodeId) => (row ? geometry.minimums[id]?.width : geometry.minimums[id]?.height) ?? 0
  const before = along(divider.beforeNode), after = along(divider.afterNode)
  const low = Math.min(0, min(divider.beforeNode) - before), high = Math.max(0, after - min(divider.afterNode))
  const delta = Math.max(low, Math.min(high, deltaPx))
  if (!delta || !(before + after > 0)) return []
  const pair = split.sizes[divider.before] + split.sizes[divider.after]
  const first = (pair * (before + delta)) / (before + after)
  if (!(first > 0) || !(pair - first > 0)) return []
  const sizes = [...split.sizes]
  sizes[divider.before] = first
  sizes[divider.after] = pair - first
  return [{ type: 'resize', splitId: divider.split, sizes }]
}

/**
 * Rebuild the reachable structure: drop dangling and repeated references and
 * childless splits, collapse one-child splits into their child, and repair
 * sizes. `changed` is false when the input was already normal.
 */
export function normalizeNodes(root: NodeId, nodes: Record<NodeId, LayoutNode>): { root: NodeId | null; nodes: Record<NodeId, LayoutNode>; changed: boolean } {
  const out: Record<NodeId, LayoutNode> = {}
  const seen = new Set<NodeId>()
  let changed = false
  const visit = (id: NodeId): NodeId | null => {
    const node = nodes[id]
    if (!node || seen.has(id)) { changed = true; return null }
    seen.add(id)
    if (node.kind !== 'split') { out[id] = node; return id }
    const kept: { id: NodeId; size: number }[] = []
    node.children.forEach((child, index) => {
      const visited = visit(child)
      if (visited !== null) kept.push({ id: visited, size: node.sizes[index] })
    })
    if (kept.length < 2) { changed = true; return kept[0]?.id ?? null }
    const valid = node.sizes.length === node.children.length && kept.every(entry => entry.size > 0 && Number.isFinite(entry.size))
    const sizes = normalizeSizes(valid ? kept.map(entry => entry.size) : kept.map(() => 1))
    const same = kept.length === node.children.length && kept.every((entry, i) => entry.id === node.children[i]) && sizes.every((size, i) => size === node.sizes[i])
    if (!same) changed = true
    out[id] = same ? node : { ...node, children: kept.map(entry => entry.id), sizes }
    return id
  }
  const next = visit(root)
  if (next !== root || Object.keys(out).length !== Object.keys(nodes).length) changed = true
  return { root: next, nodes: out, changed }
}

/**
 * Keep the tree tidy after an intent: collapse single-child splits, then merge
 * away every empty group, innermost first. The main node is never touched.
 * With `keepLast` (the default) a group that is the only one left stays, empty,
 * as the panel's skeleton (today's empty panel shows the launcher), and `seed`
 * fills it; without, the layout may settle to the conversation alone.
 * @returns follow-up ops that continue the intent (record both as one entry).
 */
export function planSettle<T extends DockTab>(
  state: LayoutState<T>, mint: Mint, options: { seed?: (id: TabId) => T; keepLast?: boolean } = {},
): LayoutOp<T>[] {
  const keepLast = options.keepLast ?? true
  const ops: LayoutOp<T>[] = []
  let current = state
  const push = (op: LayoutOp<T>) => { ops.push(op); current = applyOp(current, op).state }
  const normal = normalizeNodes(current.root, current.nodes)
  if (normal.changed && normal.root !== null) push({ type: 'replaceTree', root: normal.root, nodes: normal.nodes })
  for (;;) {
    const groups = groupIds(current)
    const empty = groups.filter(id => !getGroup(current, id).tabIds.length)
    if (!empty.length) break
    const keep = keepLast && empty.length === groups.length
      ? [...current.recent, ...groups].find(id => empty.includes(id)) ?? null
      : null
    const victim = empty.find(id => id !== keep)
    if (victim === undefined) break
    push({ type: 'merge', groupId: victim })
  }
  const groups = groupIds(current)
  if (options.seed && keepLast && groups.length === 1 && !getGroup(current, groups[0]).tabIds.length) {
    push({ type: 'insertTab', groupId: groups[0], tab: options.seed(freshId(current, mint, 'tab')), index: 0 })
  }
  return ops
}

/** Whether `groupId` already sits on `edge` of the conversation, directly beside it. */
export function besideMain<T extends DockTab>(state: LayoutState<T>, groupId: NodeId, edge: Edge): boolean {
  const { axis, side } = edgeSplit(edge)
  for (const node of Object.values(state.nodes)) {
    if (node.kind !== 'split' || node.axis !== axis) continue
    const main = node.children.indexOf(MAIN)
    if (main >= 0) return node.children.indexOf(groupId) === main + (side === 'after' ? 1 : -1)
  }
  return false
}
