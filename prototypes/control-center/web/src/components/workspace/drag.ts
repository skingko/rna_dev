/**
 * Where a dragged tab would land (design 1.3): a slot in a group's strip, the
 * centre of another group (move in), or one of the four edges of a group or
 * of the conversation (split there). Pure: the host passes the geometry and
 * the strip chips' rectangles, in container coordinates. The gaps between
 * cards take nothing.
 */
import { DEFAULT_SHARE, edgeSplit, insertionIndex, MAIN, zoneInRect, type Axis, type DropZone, type Edge, type Geometry, type Rect } from '@/lib/dock'
import { bodyRect } from './cells'

export const TAB_MIME = 'application/x-rna-tab'

export type DropTarget =
  /** `slot` counts the chips as drawn, the dragged one included; `caret` marks it. */
  | { kind: 'strip'; groupId: string; slot: number; caret: Rect }
  /** `highlight` is where the tab (or the new group) would go. */
  | { kind: 'zone'; nodeId: string; zone: DropZone; highlight: Rect }

export interface DropQuery {
  geometry: Geometry
  /** Main plus the groups drawn now (splits excluded). */
  leaves: { id: string; kind: 'main' | 'group' }[]
  strip: number
  /** Chip rectangles of a group's strip, in strip order. */
  chips: (groupId: string) => Rect[]
  /** The dragged tab's group. */
  source: string
  /** Share a new group takes beside the conversation along an axis (the store's policy); default 0.32. */
  mainShare?: (axis: Axis) => number
}

/**
 * What a drag can land on: the conversation and the drawn groups. A maximized or overlay group covers the
 * conversation, which then offers nothing (its rectangle would catch a drop meant for the group's own strip).
 */
export function dropLeaves(drawn: string[], covered: boolean): DropQuery['leaves'] {
  return [...(covered ? [] : [{ id: MAIN, kind: 'main' as const }]), ...drawn.map(id => ({ id, kind: 'group' as const }))]
}

const inside = (rect: Rect, x: number, y: number) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height

/** The part of `rect` a new group on `edge` would take. */
export function edgeHighlight(rect: Rect, edge: Edge, share: number): Rect {
  switch (edge) {
    case 'left': return { ...rect, width: rect.width * share }
    case 'right': return { ...rect, x: rect.x + rect.width * (1 - share), width: rect.width * share }
    case 'top': return { ...rect, height: rect.height * share }
    case 'bottom': return { ...rect, y: rect.y + rect.height * (1 - share), height: rect.height * share }
  }
}

/** The drop target under (x, y), or null where a release changes nothing. */
export function dropTargetAt(query: DropQuery, x: number, y: number): DropTarget | null {
  for (const leaf of query.leaves) {
    // The conversation as drawn (over the cards' margin), so a drop at the window's edge still splits it.
    const rect = leaf.kind === 'main' ? query.geometry.mainCell : query.geometry.rects[leaf.id]
    if (!rect || !inside(rect, x, y)) continue
    if (leaf.kind === 'group' && y < rect.y + query.strip) {
      const chips = query.chips(leaf.id)
      const slot = insertionIndex(chips, x)
      const at = chips[slot]?.x ?? (chips.length ? chips.at(-1)!.x + chips.at(-1)!.width : rect.x + 8)
      return { kind: 'strip', groupId: leaf.id, slot, caret: { x: at - 1, y: rect.y + 6, width: 2, height: query.strip - 12 } }
    }
    const body = leaf.kind === 'group' ? bodyRect(rect, query.strip) : rect
    const zone = zoneInRect(body, x, y)
    if (zone === 'center') {
      if (leaf.kind === 'main' || leaf.id === query.source) return null
      return { kind: 'zone', nodeId: leaf.id, zone, highlight: body }
    }
    const share = leaf.kind === 'group' ? 0.5 : query.mainShare?.(edgeSplit(zone).axis) ?? DEFAULT_SHARE
    return { kind: 'zone', nodeId: leaf.id, zone, highlight: edgeHighlight(body, zone, share) }
  }
  return null
}
