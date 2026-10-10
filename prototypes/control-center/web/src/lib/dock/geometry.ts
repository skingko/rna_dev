/**
 * Pixel geometry for the workspace host (design 1.4/1.5): one rectangle per
 * drawn node, dividers, and edge strips. Pure; the host measures its container
 * and positions stable cells from the result.
 *
 * When space is short the least recently focused groups are squeezed onto an
 * edge strip (never destroyed, and back as soon as they fit); when not even the
 * conversation plus one group fits, the result is `compact` and the host draws
 * one overlay group over the conversation. Given the selection (`ctx`), a group
 * with no tab to show there takes no space at all (it stays in the layout for
 * the conversations it has tabs for), unless every group is in that case.
 *
 * With a `gap`, groups are cards: neighbours sit `gap` apart and the drawn area
 * is inset by `gap` from the frame, so a group never touches the window's edge
 * or the conversation. The gaps count toward the minimums (they decide when a
 * group is squeezed), the rectangles are the cards themselves, and the
 * conversation is drawn reaching back over the margin (`mainCell`).
 *
 * `zoneInRect` / `insertionIndex` are ported from DeepSeek dockkit
 * `ui-dockkit/src/engine/geometry.ts` (MIT, Copyright (c) 2026 DeepSeek; see
 * LICENSE-dockkit.md).
 */
import { MAIN, type Axis, type DockTab, type DropZone, type Edge, type LayoutState, type NodeId, type Rect, type ScopeCtx, type Size } from './types'
import { getGroup, getNode, groupIds, isGroup, normalizeSizes, treeIds, visibleTabs } from './tree'
import { DEFAULT_SHARE, DOCK_EDGE_FRACTION, zoneAt } from './planner'

/** The workspace draws groups as cards this many pixels apart (and from the frame); every caller that predicts what
 * the host draws (placement, what is on screen) passes it as `gap`. */
export const CARD_GAP = 8
export const MIN_MAIN: Size = { width: 420, height: 320 }
export const MIN_GROUP: Size = { width: 260, height: 140 }
/** Thickness of an edge strip of minimized groups. */
export const STRIP = 36

/** A pixel extent as a share of `total`, held so both sides keep their minimums where possible. */
export function shareOf(px: number, total: number, minPx = MIN_GROUP.width, otherMinPx = MIN_MAIN.width): number {
  if (!(total > 0)) return DEFAULT_SHARE
  const low = Math.min(minPx / total, 0.5), high = Math.max(low, 1 - otherMinPx / total)
  return Math.min(0.85, Math.max(0.1, Math.min(high, Math.max(low, px / total))))
}

export interface Divider {
  split: NodeId
  axis: Axis
  /** Indexes into the split's `children` (not always adjacent: a squeezed child may sit between). */
  before: number
  after: number
  /** Drawn nodes on either side (a one-child remainder shows as its child). */
  beforeNode: NodeId
  afterNode: NodeId
  /** The seam: zero width (row) or zero height (column). */
  rect: Rect
}

export interface Strip { edge: Edge; rect: Rect; groups: NodeId[] }

export interface Geometry {
  /** Drawn nodes: main, shown groups, splits with two or more shown children. */
  rects: Record<NodeId, Rect>
  minimums: Record<NodeId, Size>
  dividers: Divider[]
  strips: Strip[]
  /** Groups the space rule put on a strip (the user's own minimized groups are not listed). */
  squeezed: NodeId[]
  /** Groups not drawn at all (collapsed, behind a maximized group, compact, or vacant). */
  hidden: NodeId[]
  /** Groups with no tab to show in `ctx` (another project's change set, another conversation's tools): not drawn. */
  vacant: NodeId[]
  /** Too small for the conversation beside one group: draw `overlay` over main. */
  compact: boolean
  overlay: NodeId | null
  maximized: NodeId | null
  /** Where the conversation is drawn: its rectangle reaching over the margin to the frame edges it touches (the same without a gap). */
  mainCell: Rect
  /** The gap the rectangles were laid out with. */
  gap: number
}

export interface GeometryOptions {
  main?: Size
  group?: Size
  strip?: number
  /** Pixels between neighbouring cells and around the groups (cards); default 0 (tiles sharing their edges). */
  gap?: number
  /** The selection: groups with no tab to show in it take no space (see `vacantGroups`). Without it every group counts. */
  ctx?: ScopeCtx
}

const EPS = 1e-6

const insetRect = (rect: Rect, by: number): Rect =>
  ({ x: rect.x + by, y: rect.y + by, width: Math.max(0, rect.width - 2 * by), height: Math.max(0, rect.height - 2 * by) })

/** `rect` grown from the edges it shares with `inner` out to those of `outer`. */
function reach(rect: Rect, inner: Rect, outer: Rect): Rect {
  const near = (a: number, b: number) => Math.abs(a - b) < EPS
  const left = near(rect.x, inner.x) ? outer.x : rect.x
  const top = near(rect.y, inner.y) ? outer.y : rect.y
  const right = near(rect.x + rect.width, inner.x + inner.width) ? outer.x + outer.width : rect.x + rect.width
  const bottom = near(rect.y + rect.height, inner.y + inner.height) ? outer.y + outer.height : rect.y + rect.height
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Fractional rects of every node in the unit square (no minimums). */
export function unitRects<T extends DockTab>(state: LayoutState<T>): Record<NodeId, Rect> {
  const out: Record<NodeId, Rect> = {}
  const walk = (id: NodeId, rect: Rect) => {
    out[id] = rect
    const node = getNode(state, id)
    if (node.kind !== 'split') return
    let offset = 0
    node.children.forEach((child, i) => {
      const size = node.sizes[i]
      walk(child, node.axis === 'row'
        ? { x: rect.x + offset * rect.width, y: rect.y, width: size * rect.width, height: rect.height }
        : { x: rect.x, y: rect.y + offset * rect.height, width: rect.width, height: size * rect.height })
      offset += size
    })
  }
  walk(state.root, { x: 0, y: 0, width: 1, height: 1 })
  return out
}

function edgeOf(unit: Record<NodeId, Rect>, id: NodeId): Edge {
  const g = unit[id], m = unit[MAIN]
  if (g.x >= m.x + m.width - EPS) return 'right'
  if (g.x + g.width <= m.x + EPS) return 'left'
  if (g.y >= m.y + m.height - EPS) return 'bottom'
  if (g.y + g.height <= m.y + EPS) return 'top'
  return 'right'
}

/**
 * The nearest node on `edge` of `from` that overlaps it across that edge:
 * where "move focus / move tab to the left group" goes. Minimized groups are
 * skipped; main counts only with `includeMain`.
 */
export function neighborNode<T extends DockTab>(state: LayoutState<T>, from: NodeId, edge: Edge, options: { includeMain?: boolean } = {}): NodeId | null {
  const unit = unitRects(state)
  const r = unit[from]
  if (!r) return null
  let best: { id: NodeId; gap: number; overlap: number } | null = null
  for (const id of treeIds(state)) {
    const node = state.nodes[id]
    if (id === from || node.kind === 'split' || (node.kind === 'main' && !options.includeMain) || (node.kind === 'group' && node.minimized)) continue
    const c = unit[id]
    const horizontal = edge === 'left' || edge === 'right'
    const gap = edge === 'right' ? c.x - (r.x + r.width) : edge === 'left' ? r.x - (c.x + c.width) : edge === 'bottom' ? c.y - (r.y + r.height) : r.y - (c.y + c.height)
    const overlap = horizontal
      ? Math.min(r.y + r.height, c.y + c.height) - Math.max(r.y, c.y)
      : Math.min(r.x + r.width, c.x + c.width) - Math.max(r.x, c.x)
    if (gap < -EPS || overlap <= EPS) continue
    if (!best || gap < best.gap - EPS || (Math.abs(gap - best.gap) <= EPS && overlap > best.overlap + EPS)) best = { id, gap, overlap }
  }
  return best?.id ?? null
}

/** The structure drawn once `drop` groups are taken out: a split left with one child shows as that child. */
type View =
  | { id: NodeId; kind: 'leaf' }
  | { id: NodeId; kind: 'split'; axis: Axis; children: View[]; slots: number[]; sizes: number[] }

function prune<T extends DockTab>(state: LayoutState<T>, id: NodeId, drop: Set<NodeId>): View | null {
  const node = getNode(state, id)
  if (node.kind !== 'split') return node.kind === 'group' && drop.has(id) ? null : { id, kind: 'leaf' }
  const kept: { view: View; slot: number; size: number }[] = []
  node.children.forEach((child, slot) => {
    const view = prune(state, child, drop)
    if (view) kept.push({ view, slot, size: node.sizes[slot] })
  })
  if (kept.length < 2) return kept[0]?.view ?? null
  return { id, kind: 'split', axis: node.axis, children: kept.map(k => k.view), slots: kept.map(k => k.slot), sizes: normalizeSizes(kept.map(k => k.size)) }
}

/** Split `extent` by `weights`, holding each part at its minimum; parts under it take it and the rest share what remains. */
function distribute(extent: number, weights: number[], mins: number[]): number[] {
  const need = mins.reduce((sum, min) => sum + min, 0)
  if (need >= extent) return mins.map(min => (need > 0 ? (min * extent) / need : extent / mins.length))
  const pinned = new Set<number>()
  let out = weights.map(weight => weight * extent)
  for (;;) {
    const under = out.flatMap((value, i) => (!pinned.has(i) && value < mins[i] - EPS ? [i] : []))
    if (!under.length) return out
    for (const i of under) pinned.add(i)
    const remainder = extent - [...pinned].reduce((sum, i) => sum + mins[i], 0)
    const free = weights.reduce((sum, weight, i) => (pinned.has(i) ? sum : sum + weight), 0)
    out = weights.map((weight, i) => (pinned.has(i) ? mins[i] : (weight / free) * remainder))
  }
}

/**
 * Groups with no tab to show in `ctx`: an empty chooser there would only take space. When every group is in that case,
 * the most recently focused one is kept (it shows the chooser, so open panels never show nothing).
 */
export function vacantGroups<T extends DockTab>(state: LayoutState<T>, ctx: ScopeCtx | undefined, groups: NodeId[] = groupIds(state)): NodeId[] {
  if (!ctx) return []
  const vacant = groups.filter(id => !visibleTabs(state, id, ctx).length)
  if (vacant.length < groups.length) return vacant
  const keep = [state.activeGroup, ...state.recent, ...groups].find(id => id !== null && groups.includes(id))
  return vacant.filter(id => id !== keep)
}

/**
 * Rectangles for `size` (container pixels, origin 0,0).
 * Minimums default to main 420×320 and group 260×140; with a `gap`, they are
 * the cards' and the gaps come on top.
 */
export function computeRects<T extends DockTab>(state: LayoutState<T>, size: Size, options: GeometryOptions = {}): Geometry {
  const mins = { main: options.main ?? MIN_MAIN, group: options.group ?? MIN_GROUP }
  const strip = options.strip ?? STRIP
  const gap = Math.max(0, options.gap ?? 0)
  const full: Rect = { x: 0, y: 0, width: size.width, height: size.height }
  const groups = groupIds(state)
  const geometry: Geometry = {
    rects: { [MAIN]: full }, minimums: { [MAIN]: mins.main }, dividers: [], strips: [], squeezed: [], hidden: [], vacant: [], compact: false, overlay: null, maximized: null,
    mainCell: full, gap,
  }
  if (!groups.length || state.collapsed) return { ...geometry, hidden: groups }
  const vacant = vacantGroups(state, options.ctx, groups)
  geometry.vacant = vacant
  // A maximized group with nothing to show here does not cover the conversation (it does again where it has tabs).
  if (isGroup(state, state.maximizedGroup) && !vacant.includes(state.maximizedGroup)) {
    const id = state.maximizedGroup
    return { ...geometry, rects: { [MAIN]: full, [id]: insetRect(full, gap) }, minimums: { [MAIN]: mins.main, [id]: mins.group }, hidden: groups.filter(g => g !== id), maximized: id }
  }

  const live = groups.filter(id => !vacant.includes(id))
  const userMinimized = live.filter(id => getGroup(state, id).minimized)
  const drop = new Set([...vacant, ...userMinimized])
  const recency = state.recent.filter(id => live.includes(id))
  // Least recently focused first: never-focused groups (farthest first), then the oldest focused.
  const squeezeOrder = [...live.filter(id => !recency.includes(id)).reverse(), ...[...recency].reverse()]
  const unit = unitRects(state)
  const memo = new Map<NodeId, Size>()
  const minOf = (view: View): Size => {
    const cached = memo.get(view.id)
    if (cached) return cached
    let result: Size
    if (view.kind === 'leaf') result = view.id === MAIN ? mins.main : mins.group
    else {
      const parts = view.children.map(minOf)
      const gaps = gap * (parts.length - 1)
      result = view.axis === 'row'
        ? { width: parts.reduce((sum, p) => sum + p.width, 0) + gaps, height: Math.max(...parts.map(p => p.height)) }
        : { width: Math.max(...parts.map(p => p.width)), height: parts.reduce((sum, p) => sum + p.height, 0) + gaps }
    }
    memo.set(view.id, result)
    return result
  }
  const frame = () => {
    const edges: Record<Edge, NodeId[]> = { left: [], right: [], top: [], bottom: [] }
    for (const id of live) if (drop.has(id)) edges[edgeOf(unit, id)].push(id)
    const left = edges.left.length ? strip : 0, right = edges.right.length ? strip : 0
    const top = edges.top.length ? strip : 0, bottom = edges.bottom.length ? strip : 0
    const inner: Rect = { x: left, y: top, width: Math.max(0, size.width - left - right), height: Math.max(0, size.height - top - bottom) }
    const strips: Strip[] = []
    if (left) strips.push({ edge: 'left', rect: { x: 0, y: 0, width: strip, height: size.height }, groups: edges.left })
    if (right) strips.push({ edge: 'right', rect: { x: size.width - strip, y: 0, width: strip, height: size.height }, groups: edges.right })
    if (top) strips.push({ edge: 'top', rect: { x: left, y: 0, width: inner.width, height: strip }, groups: edges.top })
    if (bottom) strips.push({ edge: 'bottom', rect: { x: left, y: size.height - strip, width: inner.width, height: strip }, groups: edges.bottom })
    return { inner, strips }
  }
  // Cards keep `gap` from the frame's edges; the conversation alone fills it.
  const area = (view: View, inner: Rect) => (view.kind === 'leaf' ? inner : insetRect(inner, gap))

  let view = prune(state, state.root, drop)!
  let { inner, strips } = frame()
  for (;;) {
    memo.clear()
    const need = minOf(view)
    const room = area(view, inner)
    if (need.width <= room.width + EPS && need.height <= room.height + EPS) break
    const next = squeezeOrder.find(id => !drop.has(id))
    if (next === undefined) break
    drop.add(next)
    geometry.squeezed.push(next)
    view = prune(state, state.root, drop)!
    ;({ inner, strips } = frame())
  }

  if (geometry.squeezed.length && groups.every(id => drop.has(id))) {
    const overlay = [state.activeGroup, ...state.recent, ...groups].find((id): id is NodeId => id !== null && live.includes(id) && !userMinimized.includes(id))!
    return { ...geometry, rects: { [MAIN]: full, [overlay]: insetRect(full, gap) }, minimums: { [MAIN]: mins.main, [overlay]: mins.group }, squeezed: [], hidden: groups.filter(id => id !== overlay), compact: true, overlay }
  }

  geometry.hidden = [...vacant]
  geometry.rects = {}
  geometry.minimums = {}
  geometry.strips = strips
  const place = (node: View, rect: Rect) => {
    geometry.rects[node.id] = rect
    geometry.minimums[node.id] = minOf(node)
    if (node.kind === 'leaf') return
    const row = node.axis === 'row'
    const start = row ? rect.x : rect.y, extent = row ? rect.width : rect.height
    const count = node.children.length
    const extents = distribute(Math.max(0, extent - gap * (count - 1)), node.sizes, node.children.map(child => (row ? minOf(child).width : minOf(child).height)))
    // Round inner boundaries so neighbours keep whole-pixel edges (and gaps).
    let acc = 0
    const spans = extents.map((part, i) => {
      const a = i === 0 ? start : Math.round(start + acc + i * gap)
      acc += part
      return [a, i === count - 1 ? start + extent : Math.round(start + acc + i * gap)] as const
    })
    node.children.forEach((child, i) => {
      const [a, b] = spans[i]
      place(child, row ? { x: a, y: rect.y, width: b - a, height: rect.height } : { x: rect.x, y: a, width: rect.width, height: b - a })
      if (i < count - 1) {
        // The seam runs down the middle of the gap.
        const seam = (b + spans[i + 1][0]) / 2
        geometry.dividers.push({
          split: node.id, axis: node.axis, before: node.slots[i], after: node.slots[i + 1], beforeNode: child.id, afterNode: node.children[i + 1].id,
          rect: row ? { x: seam, y: rect.y, width: 0, height: rect.height } : { x: rect.x, y: seam, width: rect.width, height: 0 },
        })
      }
    })
  }
  memo.clear()
  const room = area(view, inner)
  place(view, room)
  geometry.mainCell = reach(geometry.rects[MAIN], room, inner)
  return geometry
}

/** Drop zone of a point relative to one node's rectangle. */
export function zoneInRect(rect: Rect, x: number, y: number, edge = DOCK_EDGE_FRACTION): DropZone {
  if (!(rect.width > 0) || !(rect.height > 0)) return 'center'
  return zoneAt((x - rect.x) / rect.width, (y - rect.y) / rect.height, edge)
}

/** Slot a tab would take in a strip, by comparing the pointer with each chip's midpoint. */
export function insertionIndex(tabRects: Rect[], x: number): number {
  let index = 0
  for (const rect of tabRects) {
    if (x < rect.x + rect.width / 2) break
    index += 1
  }
  return index
}
