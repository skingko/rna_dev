import { describe, expect, it } from 'vitest'
import { MAIN, type LayoutState } from './types'
import { applyOps } from './operations'
import { counterMint, emptyGroup, getGroup, getSplit, groupIds, tabGroupId } from './tree'
import { clampSizes, edgeSplit, normalizeNodes, planDropTab, planPlaceTab, planResizeDivider, planSettle, zoneAt } from './planner'
import { computeRects } from './geometry'
import { opRoundTrips, sound, startLayout, tab, type TestTab } from './testing'

/** row[main, g1, g2]: g1 holds a, b; g2 holds c. */
function twoGroups(): { state: LayoutState<TestTab>; g1: string } {
  let state = startLayout()
  const g1 = groupIds(state)[0]
  state = applyOps(state, [
    { type: 'openTab', groupId: g1, tab: tab('a'), index: 0, scope: 's:A' },
    { type: 'openTab', groupId: g1, tab: tab('b'), index: 1, scope: 's:A' },
    { type: 'addGroup', groupId: 'g2', group: emptyGroup(), at: { mode: 'edge', target: g1, axis: 'row', side: 'after', share: 0.5, splitId: 'x' } },
    { type: 'openTab', groupId: 'g2', tab: tab('c'), index: 0, scope: 's:A' },
  ]).state
  return { state, g1 }
}

describe('drop zones', () => {
  it('maps a pointer to the nearest edge band, else the centre', () => {
    expect(zoneAt(0.5, 0.5)).toBe('center')
    expect(zoneAt(0.05, 0.5)).toBe('left')
    expect(zoneAt(0.95, 0.5)).toBe('right')
    expect(zoneAt(0.5, 0.1)).toBe('top')
    expect(zoneAt(0.5, 0.9)).toBe('bottom')
    expect(zoneAt(0.3, 0.5)).toBe('center')
    expect(edgeSplit('left')).toEqual({ axis: 'row', side: 'before' })
    expect(edgeSplit('bottom')).toEqual({ axis: 'column', side: 'after' })
  })

  it('centre moves the tab into another group; its own group, main or a split take nothing', () => {
    const { state, g1 } = twoGroups()
    const mint = counterMint()
    expect(planDropTab(state, mint, 'a', 'g2', 'center', 's:A')).toEqual([{ type: 'moveTab', tabId: 'a', groupId: 'g2', index: 1, scope: 's:A' }])
    expect(planDropTab(state, mint, 'a', g1, 'center', 's:A')).toEqual([])
    expect(planDropTab(state, mint, 'a', MAIN, 'center', 's:A')).toEqual([])
    expect(planDropTab(state, mint, 'a', state.root, 'center', 's:A')).toEqual([])
  })

  it.each([
    ['left', 'row', 0],
    ['right', 'row', 1],
    ['top', 'column', 0],
    ['bottom', 'column', 1],
  ] as const)('the %s edge of a group splits it there', (zone, axis, at) => {
    const { state } = twoGroups()
    const ops = planDropTab(state, counterMint(), 'a', 'g2', zone, 's:A')
    const next = opRoundTrips(state, ops)
    const group = tabGroupId(next, 'a')
    expect(group).not.toBe('g2')
    if (axis === 'row') {
      const root = getSplit(next, next.root)
      expect(root.children.indexOf(group) - root.children.indexOf('g2')).toBe(at ? 1 : -1)
    } else {
      const wrap = Object.values(next.nodes).find(node => node.kind === 'split' && node.axis === 'column')
      expect(wrap).toMatchObject({ children: at ? ['g2', group] : [group, 'g2'], sizes: [0.5, 0.5] })
    }
    expect(getGroup(next, group).activeByScope['s:A']).toBe('a')
    sound(next)
  })

  it('an edge of main or the whole root splits there with the default share', () => {
    const { state } = twoGroups()
    const below = opRoundTrips(state, planDropTab(state, counterMint(), 'c', MAIN, 'bottom', 's:A'))
    const column = Object.values(below.nodes).find(node => node.kind === 'split' && node.axis === 'column')
    expect(column).toMatchObject({ children: [MAIN, tabGroupId(below, 'c')] })
    expect((column as { sizes: number[] }).sizes[1]).toBeCloseTo(0.32)
    const outer = opRoundTrips(state, planDropTab(state, counterMint(), 'a', state.root, 'left', 's:A', { share: 0.2 }))
    expect(getSplit(outer, outer.root).children[0]).toBe(tabGroupId(outer, 'a'))
    expect(getSplit(outer, outer.root).sizes[0]).toBeCloseTo(0.2)
  })

  it("a group's only tab dropped on its own edge needs a seed to backfill", () => {
    const { state } = twoGroups()
    expect(planDropTab(state, counterMint(), 'c', 'g2', 'right', 's:A')).toEqual([])
    const ops = planDropTab(state, counterMint(), 'c', 'g2', 'right', 's:A', { seed: id => tab(id, 'launcher') })
    const next = opRoundTrips(state, ops)
    expect(getGroup(next, 'g2').tabIds).toHaveLength(1)
    expect(next.tabs[getGroup(next, 'g2').tabIds[0]].type).toBe('launcher')
    expect(tabGroupId(next, 'c')).not.toBe('g2')
  })

  it('minted ids skip ids the layout already uses', () => {
    const { state, g1 } = twoGroups()
    const taken = [g1, 'g2', 'a', 'fresh-group']
    let n = 0
    const ops = planDropTab(state, () => taken[n++] ?? `id-${n}`, 'a', 'g2', 'top', 's:A')
    expect(ops[0]).toMatchObject({ type: 'addGroup', groupId: 'fresh-group' })
    expect((ops[0] as { at: { splitId: string } }).at.splitId).toBe('id-5')
  })
})

describe('placing tabs in a strip', () => {
  it('reorders within a group counting the dragged chip, and moves across groups', () => {
    const { state, g1 } = twoGroups()
    expect(planPlaceTab(state, 'a', g1, 0, 's:A')).toEqual([])
    expect(planPlaceTab(state, 'a', g1, 1, 's:A')).toEqual([])
    expect(planPlaceTab(state, 'a', g1, 2, 's:A')).toEqual([{ type: 'reorderTab', tabId: 'a', index: 1 }])
    expect(planPlaceTab(state, 'b', g1, 0, 's:A')).toEqual([{ type: 'reorderTab', tabId: 'b', index: 0 }])
    expect(planPlaceTab(state, 'a', 'g2', 0, null)).toEqual([{ type: 'moveTab', tabId: 'a', groupId: 'g2', index: 0, scope: null }])
  })
})

describe('resizing', () => {
  it('clamps fractions to a minimum share', () => {
    const sizes = clampSizes([0.02, 0.49, 0.49], 0.12)
    expect(sizes[0]).toBeCloseTo(0.12)
    expect(sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
    expect(clampSizes([0, 0])).toEqual([0.5, 0.5])
  })

  it('a divider drag moves only its two neighbours and stops at their pixel minimums', () => {
    const { state } = twoGroups()
    const size = { width: 2400, height: 900 }
    const geometry = computeRects(state, size)
    const divider = geometry.dividers.find(d => d.beforeNode === MAIN)!
    const grow = planResizeDivider(state, geometry, divider, -100)
    const sizes = (grow[0] as { sizes: number[] }).sizes
    const before = getSplit(state, state.root).sizes
    expect(sizes[2]).toBe(before[2])
    expect(sizes[0] + sizes[1]).toBeCloseTo(before[0] + before[1])
    expect(computeRects(applyOps(state, grow).state, size).rects[MAIN].width).toBeCloseTo(geometry.rects[MAIN].width - 100, 0)
    // Far past the group's minimum: the group stops at 260 px.
    const next = applyOps(state, planResizeDivider(state, geometry, divider, 5000)).state
    expect(computeRects(next, size).rects[divider.afterNode].width).toBeCloseTo(260, 0)
    // Already at the minimum: nothing more to give.
    const pinned = computeRects(next, size)
    expect(planResizeDivider(next, pinned, pinned.dividers.find(d => d.beforeNode === MAIN)!, 50)).toEqual([])
    expect(planResizeDivider(state, geometry, divider, 0)).toEqual([])
  })
})

describe('settle', () => {
  it('merges every empty group but never main', () => {
    const { state, g1 } = twoGroups()
    const emptied = applyOps(state, [{ type: 'closeTab', tabId: 'c' }]).state
    const ops = planSettle(emptied, counterMint())
    expect(ops).toEqual([{ type: 'merge', groupId: 'g2' }])
    const next = opRoundTrips(emptied, ops)
    expect(groupIds(next)).toEqual([g1])
    expect(next.nodes[MAIN]).toEqual({ kind: 'main' })
  })

  it('keeps a lone last group by default, seeds it on request, or lets it go', () => {
    const { state } = twoGroups()
    const empty = applyOps(state, [{ type: 'closeTab', tabId: 'a' }, { type: 'closeTab', tabId: 'b' }, { type: 'closeTab', tabId: 'c' }, { type: 'focusGroup', groupId: 'g2' }]).state
    const kept = applyOps(empty, planSettle(empty, counterMint())).state
    expect(groupIds(kept)).toEqual(['g2'])
    sound(kept)
    const seeded = applyOps(empty, planSettle(empty, counterMint(), { seed: id => tab(id, 'launcher') })).state
    expect(Object.values(seeded.tabs).map(t => t.type)).toEqual(['launcher'])
    const gone = opRoundTrips(empty, planSettle(empty, counterMint(), { keepLast: false }))
    expect(gone.root).toBe(MAIN)
    expect(gone.activeGroup).toBeNull()
  })

  it('collapses single-child and childless splits', () => {
    const { state, g1 } = twoGroups()
    const nodes = Object.fromEntries(Object.entries(state.nodes).filter(([id]) => id !== state.root))
    const broken: LayoutState<TestTab> = {
      ...state,
      root: 'r',
      nodes: {
        ...nodes,
        r: { kind: 'split', axis: 'row', children: [MAIN, 'one'], sizes: [0.6, 0.4] },
        one: { kind: 'split', axis: 'column', children: ['two'], sizes: [1] },
        two: { kind: 'split', axis: 'row', children: [g1, 'g2'], sizes: [0.5, 0.5] },
      },
    }
    const ops = planSettle(broken, counterMint())
    expect(ops[0].type).toBe('replaceTree')
    const next = opRoundTrips(broken, ops)
    expect(getSplit(next, 'r').children).toEqual([MAIN, 'two'])
    expect(next.nodes.one).toBeUndefined()
    sound(next)
  })

  it('normalizeNodes reports already-normal trees unchanged', () => {
    const { state } = twoGroups()
    const normal = normalizeNodes(state.root, state.nodes)
    expect(normal.changed).toBe(false)
    expect(normal.nodes).toEqual(state.nodes)
    expect(normalizeNodes('missing', state.nodes)).toMatchObject({ root: null, changed: true })
  })
})
