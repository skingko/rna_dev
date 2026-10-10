import { describe, expect, it } from 'vitest'
import { MAIN, type LayoutOp, type LayoutState, type Rect } from './types'
import { applyOps } from './operations'
import { planResizeDivider } from './planner'
import { emptyGroup, emptyLayout, groupIds } from './tree'
import { computeRects, insertionIndex, MIN_GROUP, MIN_MAIN, neighborNode, STRIP, zoneInRect, type Geometry } from './geometry'
import { A, B, Q, startLayout, tab, type TestTab } from './testing'

/** row[main, g1, column[g2, g3]], each group holding one tab; g3 focused last unless told. */
function threeGroups(extra: LayoutOp<TestTab>[] = []): LayoutState<TestTab> {
  const state = startLayout()
  const g1 = groupIds(state)[0]
  return applyOps(state, [
    { type: 'openTab', groupId: g1, tab: tab('a'), index: 0, scope: 'global' },
    { type: 'addGroup', groupId: 'g2', group: emptyGroup(), at: { mode: 'edge', target: g1, axis: 'row', side: 'after', share: 0.5, splitId: 'x' } },
    { type: 'openTab', groupId: 'g2', tab: tab('b'), index: 0, scope: 'global' },
    { type: 'addGroup', groupId: 'g3', group: emptyGroup(), at: { mode: 'edge', target: 'g2', axis: 'column', side: 'after', share: 0.5, splitId: 'col' } },
    { type: 'openTab', groupId: 'g3', tab: tab('c'), index: 0, scope: 'global' },
    ...extra,
  ]).state
}

const area = (r: Rect) => r.width * r.height
/** Drawn main and groups (splits left out), sorted. */
const drawnLeaves = (state: LayoutState<TestTab>, geometry: Geometry) => Object.keys(geometry.rects).filter(id => state.nodes[id].kind !== 'split').sort()
const inside = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5

/** Drawn leaves tile the area left after strips, honour minimums, and never overlap. */
function tiles(state: LayoutState<TestTab>, geometry: Geometry, width: number, height: number) {
  const leaves = Object.keys(geometry.rects).filter(id => state.nodes[id].kind !== 'split')
  const stripArea = geometry.strips.reduce((sum, s) => sum + area(s.rect), 0)
  expect(leaves.reduce((sum, id) => sum + area(geometry.rects[id]), 0) + stripArea).toBeCloseTo(width * height, 0)
  for (const id of leaves) {
    const rect = geometry.rects[id]
    expect(inside(rect, { x: 0, y: 0, width, height })).toBe(true)
    const min = id === MAIN ? MIN_MAIN : MIN_GROUP
    expect(rect.width).toBeGreaterThanOrEqual(min.width - 1)
    expect(rect.height).toBeGreaterThanOrEqual(min.height - 1)
  }
}

describe('computeRects', () => {
  it('lays out the default sidebar with whole-pixel seams', () => {
    const state = startLayout()
    const g = computeRects(state, { width: 1440, height: 900 })
    const group = groupIds(state)[0]
    expect(g.rects[MAIN]).toEqual({ x: 0, y: 0, width: 979, height: 900 })
    expect(g.rects[group]).toEqual({ x: 979, y: 0, width: 461, height: 900 })
    expect(g.dividers).toEqual([{ split: state.root, axis: 'row', before: 0, after: 1, beforeNode: MAIN, afterNode: group, rect: { x: 979, y: 0, width: 0, height: 900 } }])
    expect(g).toMatchObject({ compact: false, overlay: null, strips: [], squeezed: [], hidden: [] })
    tiles(state, g, 1440, 900)
  })

  it('holds a group at its minimum before the conversation', () => {
    const state = startLayout()
    const g = computeRects(state, { width: 700, height: 600 })
    expect(g.rects[groupIds(state)[0]].width).toBe(260)
    expect(g.rects[MAIN].width).toBe(440)
    tiles(state, g, 700, 600)
  })

  it('falls back to one overlay group when main and a group cannot sit side by side', () => {
    const state = startLayout()
    const g = computeRects(state, { width: 650, height: 600 })
    const group = groupIds(state)[0]
    expect(g).toMatchObject({ compact: true, overlay: group, hidden: [], strips: [], squeezed: [] })
    expect(g.rects[MAIN]).toEqual({ x: 0, y: 0, width: 650, height: 600 })
    expect(g.rects[group]).toEqual(g.rects[MAIN])
  })

  it('squeezes the least recently focused groups onto an edge strip, keeping them alive', () => {
    const state = threeGroups([{ type: 'focusGroup', groupId: 'g2' }])
    const g1 = groupIds(state)[0]
    expect(state.recent).toEqual(['g2', 'g3', g1])
    const wide = computeRects(state, { width: 1000, height: 900 })
    expect(wide.squeezed).toEqual([])
    tiles(state, wide, 1000, 900)
    const narrow = computeRects(state, { width: 900, height: 900 })
    expect(narrow.squeezed).toEqual([g1])
    expect(narrow.strips).toEqual([{ edge: 'right', rect: { x: 900 - STRIP, y: 0, width: STRIP, height: 900 }, groups: [g1] }])
    expect(narrow.rects[g1]).toBeUndefined()
    expect(narrow.rects.g2.height + narrow.rects.g3.height).toBe(900)
    tiles(state, narrow, 900, 900)
    // The squeezed middle child leaves a divider between slots 0 and 2 of the root.
    expect(narrow.dividers.map(d => [d.split, d.before, d.after, d.beforeNode, d.afterNode])).toEqual([[state.root, 0, 2, MAIN, 'col'], ['col', 0, 1, 'g2', 'g3']])
    // Stacked groups need no extra width, so the next squeeze goes straight to compact.
    const tiny = computeRects(state, { width: 600, height: 900 })
    expect(tiny).toMatchObject({ compact: true, overlay: 'g2' })
    expect(tiny.hidden.sort()).toEqual([g1, 'g3'].sort())
  })

  it('squeezes by height too', () => {
    const state = applyOps(emptyLayout<TestTab>(), [
      { type: 'addGroup', groupId: 'g', group: emptyGroup(), at: { mode: 'edge', target: MAIN, axis: 'column', side: 'after', share: 0.3, splitId: 's' } },
      { type: 'openTab', groupId: 'g', tab: tab('a'), index: 0, scope: 'global' },
    ]).state
    const tall = computeRects(state, { width: 1000, height: 800 })
    expect(tall.rects.g.height).toBe(240)
    tiles(state, tall, 1000, 800)
    expect(computeRects(state, { width: 1000, height: 420 })).toMatchObject({ compact: true, overlay: 'g' })
  })

  it("puts the user's minimized groups on the strip of their side, not in `squeezed`", () => {
    const state = applyOps(threeGroups(), [
      { type: 'detach', nodeId: 'g3' },
      { type: 'attach', nodeId: 'g3', at: { mode: 'edge', target: MAIN, axis: 'row', side: 'before', share: 0.2, splitId: 'y' } },
      { type: 'setMinimized', groupId: 'g3', minimized: true },
    ]).state
    const g = computeRects(state, { width: 1400, height: 900 })
    expect(g.squeezed).toEqual([])
    expect(g.strips).toEqual([{ edge: 'left', rect: { x: 0, y: 0, width: STRIP, height: 900 }, groups: ['g3'] }])
    expect(g.rects[MAIN].x).toBe(STRIP)
    tiles(state, g, 1400, 900)
  })

  it('gives a group with nothing to show in the selection no space, keeping it in the layout', () => {
    // g2 holds only project P's tab, g3 only conversation A's: in conversation C of project Q, only g1 (a workspace tab) shows.
    const state = applyOps(threeGroups(), [
      { type: 'updateTab', tab: tab('b', 'file', { project: 'P' }) },
      { type: 'updateTab', tab: tab('c', 'tool', { session: 'A' }) },
    ]).state
    const g1 = groupIds(state)[0]
    const elsewhere = computeRects(state, { width: 1400, height: 900 }, { ctx: Q })
    expect(elsewhere.vacant.sort()).toEqual(['g2', 'g3'])
    expect(elsewhere.hidden.sort()).toEqual(['g2', 'g3'])
    expect(drawnLeaves(state, elsewhere)).toEqual([MAIN, g1].sort())
    expect(elsewhere.strips).toEqual([]) // not squeezed onto a strip either: there is nothing to bring back
    expect(elsewhere.dividers.map(d => [d.beforeNode, d.afterNode])).toEqual([[MAIN, g1]])
    tiles(state, elsewhere, 1400, 900)
    // In conversation A all three show; in B of project P, g2 does.
    expect(computeRects(state, { width: 1400, height: 900 }, { ctx: A }).vacant).toEqual([])
    expect(computeRects(state, { width: 1400, height: 900 }, { ctx: B }).vacant).toEqual(['g3'])
    // Without a selection every group counts.
    expect(computeRects(state, { width: 1400, height: 900 }).vacant).toEqual([])
    // A minimized group with nothing to show is not on a strip; a maximized one does not cover the conversation.
    const put = applyOps(state, [{ type: 'setMinimized', groupId: 'g2', minimized: true }, { type: 'setMaximized', groupId: 'g3' }]).state
    const g = computeRects(put, { width: 1400, height: 900 }, { ctx: Q })
    expect(g).toMatchObject({ strips: [], maximized: null })
    expect(drawnLeaves(put, g)).toEqual([MAIN, g1].sort())
  })

  it('keeps the most recently focused group when no group has anything to show', () => {
    const state = applyOps(threeGroups(), [
      { type: 'updateTab', tab: tab('a', 'tool', { session: 'A' }) },
      { type: 'updateTab', tab: tab('b', 'tool', { session: 'A' }) },
      { type: 'updateTab', tab: tab('c', 'tool', { session: 'A' }) },
      { type: 'focusGroup', groupId: 'g2' },
    ]).state
    const g = computeRects(state, { width: 1400, height: 900 }, { ctx: Q })
    expect(g.vacant.sort()).toEqual([groupIds(state)[0], 'g3'].sort())
    expect(drawnLeaves(state, g)).toEqual([MAIN, 'g2'].sort()) // its chooser shows
    expect(computeRects(startLayout(), { width: 1400, height: 900 }, { ctx: Q }).vacant).toEqual([]) // the lone empty group too
  })

  it('a narrow window overlays a group that has something to show', () => {
    const state = applyOps(threeGroups(), [{ type: 'updateTab', tab: tab('c', 'tool', { session: 'A' }) }]).state
    expect(state.activeGroup).toBe('g3')
    expect(computeRects(state, { width: 600, height: 900 }, { ctx: A })).toMatchObject({ compact: true, overlay: 'g3' })
    const g = computeRects(state, { width: 600, height: 900 }, { ctx: Q })
    expect(g).toMatchObject({ compact: true, overlay: 'g2' })
    expect(g.hidden.sort()).toEqual([groupIds(state)[0], 'g3'].sort())
  })

  it('collapsed, maximized and group-less layouts', () => {
    const state = threeGroups()
    const collapsed = computeRects({ ...state, collapsed: true }, { width: 1200, height: 800 })
    expect(collapsed.rects).toEqual({ [MAIN]: { x: 0, y: 0, width: 1200, height: 800 } })
    expect(collapsed.hidden).toHaveLength(3)
    const maxed = computeRects({ ...state, maximizedGroup: 'g2' }, { width: 1200, height: 800 })
    expect(maxed).toMatchObject({ maximized: 'g2', rects: { g2: { x: 0, y: 0, width: 1200, height: 800 } } })
    expect(maxed.hidden).toHaveLength(2)
    expect(computeRects(emptyLayout(), { width: 300, height: 200 }).rects).toEqual({ [MAIN]: { x: 0, y: 0, width: 300, height: 200 } })
  })
})

describe('cards with a gap (design 1.4)', () => {
  const GAP = 8
  const leavesOf = (state: LayoutState<TestTab>, geometry: Geometry) => Object.keys(geometry.rects).filter(id => state.nodes[id].kind !== 'split')
  const overlap = (a: Rect, b: Rect) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0
  /** Distance between two rectangles that sit side by side or one above the other (0 when they touch). */
  const spacing = (a: Rect, b: Rect) => Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), b.y - (a.y + a.height), a.y - (b.y + b.height))

  /** No two leaves overlap, neighbours keep the gap, groups keep it from the edges, and minimums hold. */
  function cards(state: LayoutState<TestTab>, geometry: Geometry, width: number, height: number) {
    const leaves = leavesOf(state, geometry)
    const frame = { x: GAP, y: GAP, width: width - 2 * GAP, height: height - 2 * GAP }
    for (const id of leaves) {
      const rect = geometry.rects[id]
      expect(inside(rect, frame)).toBe(true)
      const min = id === MAIN ? MIN_MAIN : MIN_GROUP
      expect(rect.width).toBeGreaterThanOrEqual(min.width - 1)
      expect(rect.height).toBeGreaterThanOrEqual(min.height - 1)
      for (const other of leaves) if (other !== id) expect(overlap(rect, geometry.rects[other])).toBe(false)
    }
    for (const divider of geometry.dividers) {
      const before = geometry.rects[divider.beforeNode], after = geometry.rects[divider.afterNode]
      expect(spacing(before, after)).toBe(GAP)
      // The seam runs down the middle of the gap.
      if (divider.axis === 'row') expect(divider.rect.x).toBe(before.x + before.width + GAP / 2)
      else expect(divider.rect.y).toBe(before.y + before.height + GAP / 2)
    }
  }

  it('keeps the sidebar card apart from the conversation and the edges; the conversation is drawn out to them', () => {
    const state = startLayout()
    const g = computeRects(state, { width: 1440, height: 900 }, { gap: GAP })
    const group = groupIds(state)[0]
    expect(g.gap).toBe(GAP)
    expect(g.rects[group]).toMatchObject({ y: GAP, height: 900 - 2 * GAP })
    expect(g.rects[group].x + g.rects[group].width).toBe(1440 - GAP)
    expect(g.rects[MAIN].x + g.rects[MAIN].width + GAP).toBe(g.rects[group].x)
    expect(g.mainCell).toEqual({ x: 0, y: 0, width: g.rects[MAIN].x + g.rects[MAIN].width, height: 900 })
    cards(state, g, 1440, 900)
    // Without a gap nothing changes: tiles sharing their edges, the conversation drawn where it is laid out.
    const plain = computeRects(state, { width: 1440, height: 900 })
    expect(plain.mainCell).toEqual(plain.rects[MAIN])
    expect(plain.gap).toBe(0)
  })

  it('counts the gaps toward the minimums: squeezing and the overlay come that much sooner', () => {
    const state = startLayout()
    const fits = MIN_MAIN.width + MIN_GROUP.width + 3 * GAP
    expect(computeRects(state, { width: fits, height: 600 }, { gap: GAP }).compact).toBe(false)
    expect(computeRects(state, { width: fits - 1, height: 600 }, { gap: GAP }).compact).toBe(true)
    cards(state, computeRects(state, { width: fits, height: 600 }, { gap: GAP }), fits, 600)

    const three = threeGroups([{ type: 'focusGroup', groupId: 'g2' }])
    expect(computeRects(three, { width: 960, height: 900 }).squeezed).toEqual([])
    const squeezed = computeRects(three, { width: 960, height: 900 }, { gap: GAP })
    expect(squeezed.squeezed).toEqual([groupIds(three)[0]]) // 420 + 260 + 260 fits, not with the two gaps and the margins
    // On the strip's side the cards keep their margin from the strip, the conversation reaches the frame.
    const strip = squeezed.strips[0].rect
    for (const id of ['g2', 'g3']) expect(squeezed.rects[id].x + squeezed.rects[id].width).toBe(strip.x - GAP)
    expect(squeezed.mainCell.x).toBe(0)
  })

  it('lays out nested splits as cards that never overlap', () => {
    const state = threeGroups()
    for (const size of [{ width: 1400, height: 900 }, { width: 1240, height: 700 }, { width: 2400, height: 1200 }]) {
      const g = computeRects(state, size, { gap: GAP })
      expect(g.squeezed).toEqual([])
      cards(state, g, size.width, size.height)
    }
  })

  it('a divider drag follows the pointer exactly across the gap', () => {
    const state = threeGroups()
    const size = { width: 2400, height: 900 }
    const geometry = computeRects(state, size, { gap: GAP })
    expect(geometry.dividers).toHaveLength(3)
    for (const divider of geometry.dividers) {
      const resized = applyOps(state, planResizeDivider(state, geometry, divider, 40)).state
      const after = computeRects(resized, size, { gap: GAP })
      const along = (g: Geometry, id: string) => (divider.axis === 'row' ? g.rects[id].width : g.rects[id].height)
      expect(along(after, divider.beforeNode) - along(geometry, divider.beforeNode)).toBeCloseTo(40, 0)
      expect(along(after, divider.afterNode) - along(geometry, divider.afterNode)).toBeCloseTo(-40, 0)
    }
  })

  it('a maximized or overlay card keeps its margin; the conversation underneath stays whole', () => {
    const state = threeGroups()
    const maxed = computeRects({ ...state, maximizedGroup: 'g2' }, { width: 1200, height: 800 }, { gap: GAP })
    expect(maxed.rects.g2).toEqual({ x: GAP, y: GAP, width: 1200 - 2 * GAP, height: 800 - 2 * GAP })
    expect(maxed.mainCell).toEqual({ x: 0, y: 0, width: 1200, height: 800 })
    const narrow = computeRects(startLayout(), { width: 620, height: 600 }, { gap: GAP })
    expect(narrow.compact).toBe(true)
    expect(narrow.rects[narrow.overlay!]).toEqual({ x: GAP, y: GAP, width: 620 - 2 * GAP, height: 600 - 2 * GAP })
    // Every group put away: the conversation alone fills the frame, no margin.
    const away = applyOps(state, groupIds(state).map(groupId => ({ type: 'setMinimized' as const, groupId, minimized: true }))).state
    const alone = computeRects(away, { width: 1200, height: 800 }, { gap: GAP })
    expect(alone.rects[MAIN]).toEqual(alone.mainCell)
    expect(alone.rects[MAIN]).toEqual({ x: 0, y: 0, width: 1200 - STRIP, height: 800 })
  })
})

describe('neighbours and pointer helpers', () => {
  it('finds the nearest group on a side', () => {
    const state = threeGroups()
    const g1 = groupIds(state)[0]
    expect(neighborNode(state, g1, 'right')).toBe('g2')
    expect(neighborNode(state, 'g2', 'bottom')).toBe('g3')
    expect(neighborNode(state, 'g3', 'left')).toBe(g1)
    expect(neighborNode(state, g1, 'left')).toBeNull()
    expect(neighborNode(state, g1, 'left', { includeMain: true })).toBe(MAIN)
    expect(neighborNode(state, MAIN, 'right')).toBe(g1)
    const hidden = applyOps(state, [{ type: 'setMinimized', groupId: 'g2', minimized: true }]).state
    expect(neighborNode(hidden, g1, 'right')).toBe('g3')
  })

  it('resolves drop zones in a rectangle and strip slots', () => {
    const rect = { x: 100, y: 100, width: 200, height: 100 }
    expect(zoneInRect(rect, 200, 150)).toBe('center')
    expect(zoneInRect(rect, 105, 150)).toBe('left')
    expect(zoneInRect(rect, 200, 195)).toBe('bottom')
    expect(zoneInRect({ ...rect, width: 0 }, 0, 0)).toBe('center')
    const chips = [{ x: 0, y: 0, width: 50, height: 20 }, { x: 50, y: 0, width: 50, height: 20 }]
    expect([10, 30, 80, 120].map(x => insertionIndex(chips, x))).toEqual([0, 1, 2, 2])
  })
})
