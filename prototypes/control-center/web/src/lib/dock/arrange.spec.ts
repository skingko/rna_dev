import { describe, expect, it } from 'vitest'
import { MAIN, type LayoutOp, type LayoutState, type SplitNode } from './types'
import { applyOps } from './operations'
import { counterMint, emptyGroup, emptyLayout, getGroup, getSplit, groupIds, tabGroupId } from './tree'
import { arrange, planArrange, type ArrangeOptions } from './arrange'
import { computeRects, shareOf } from './geometry'
import { roundTrips, sound, startLayout, tab, type TestTab } from './testing'

/** row[main, g1, g2, …]: one group per entry, tabs opened in order (the last group focused last). */
function groupsOf(specs: TestTab[][]): LayoutState<TestTab> {
  let state = startLayout()
  const first = groupIds(state)[0]
  const ops: LayoutOp<TestTab>[] = []
  let previous = first
  specs.forEach((tabs, i) => {
    const id = i === 0 ? first : `g${i + 1}`
    if (i > 0) ops.push({ type: 'addGroup', groupId: id, group: emptyGroup(), at: { mode: 'edge', target: previous, axis: 'row', side: 'after', share: 0.5, splitId: `s${i}` } })
    tabs.forEach((t, index) => ops.push({ type: 'openTab', groupId: id, tab: t, index, scope: 'global' }))
    previous = id
  })
  state = applyOps(state, ops).state
  sound(state)
  return state
}

const mixed = () => groupsOf([[tab('a'), tab('f', 'file')], [tab('b', 'browser')], [tab('t', 'terminal')], [tab('k', 'tasks')]])
const options = (extra: Partial<ArrangeOptions<TestTab>> = {}): ArrangeOptions<TestTab> => ({ mint: counterMint('a-'), size: { width: 1440, height: 900 }, ...extra })

function arranged(state: LayoutState<TestTab>, preset: Parameters<typeof arrange>[1], extra: Partial<ArrangeOptions<TestTab>> = {}) {
  const change = arrange(state, preset, options(extra))
  roundTrips(state, change)
  sound(change.state)
  expect(Object.keys(change.state.tabs).filter(id => id in state.tabs).sort()).toEqual(Object.keys(state.tabs).sort())
  return change.state
}

describe('presets', () => {
  it('sidebar: every tab in one group beside the conversation, at the dock width', () => {
    const state = mixed()
    const next = arranged(state, 'sidebar')
    const root = getSplit(next, next.root)
    expect(root.children[0]).toBe(MAIN)
    expect(root.sizes[1]).toBeCloseTo(shareOf(460, 1440))
    const group = getGroup(next, root.children[1])
    expect(group.tabIds).toEqual(['a', 'f', 'b', 't', 'k'])
    expect(root.children[1]).toBe(groupIds(state)[0]) // the biggest contributor keeps its id
    expect(group.activeByScope.global).toBe('k') // the most recently focused group's choice wins
  })

  it('bottom: conversation above, one group below', () => {
    const next = arranged(mixed(), 'bottom', { dockHeight: 300 })
    const root = getSplit(next, next.root)
    expect(root.axis).toBe('column')
    expect(root.children[0]).toBe(MAIN)
    expect(root.sizes[1]).toBeCloseTo(300 / 900)
  })

  it('right-stacked: terminal and tasks go to the lower group', () => {
    const next = arranged(mixed(), 'right-stacked')
    const root = getSplit(next, next.root)
    const stack = getSplit(next, root.children[1])
    expect(stack.axis).toBe('column')
    expect(getGroup(next, stack.children[0]).tabIds).toEqual(['a', 'f', 'b'])
    expect(getGroup(next, stack.children[1]).tabIds).toEqual(['t', 'k'])
    expect(stack.sizes[0]).toBeCloseTo(2 / 3) // browser weighs 2, terminal 1
  })

  it('three-column: files on the left, the rest on the right', () => {
    const next = arranged(mixed(), 'three-column')
    const root = getSplit(next, next.root)
    expect(root.children[1]).toBe(MAIN)
    expect(getGroup(next, root.children[0]).tabIds).toEqual(['f'])
    expect(getGroup(next, root.children[2]).tabIds).toEqual(['a', 'b', 't', 'k'])
    expect(computeRects(next, { width: 1440, height: 900 }).rects[MAIN].width).toBeGreaterThanOrEqual(420)
  })

  it('an empty slot is seeded with the launcher, or left out', () => {
    const state = groupsOf([[tab('a'), tab('b', 'browser')]])
    const plain = arranged(state, 'right-stacked')
    expect(getSplit(plain, plain.root).children).toEqual([MAIN, groupIds(state)[0]])
    const seeded = arranged(state, 'right-stacked', { seed: id => tab(id, 'launcher') })
    const stack = getSplit(seeded, getSplit(seeded, seeded.root).children[1])
    expect(getGroup(seeded, stack.children[1]).tabIds.map(id => seeded.tabs[id].type)).toEqual(['launcher'])
    const left = arranged(groupsOf([[tab('f', 'file')]]), 'three-column')
    expect(getSplit(left, left.root).children[1]).toBe(MAIN)
  })

  it('shows the panel and drops a maximize', () => {
    const state = applyOps(mixed(), [{ type: 'setCollapsed', collapsed: true }, { type: 'setMaximized', groupId: 'g2' }]).state
    const next = arranged(state, 'sidebar')
    expect(next).toMatchObject({ collapsed: false, maximizedGroup: null })
  })
})

describe('fill and arrange', () => {
  it('tiles groups in columns of at most three with tasks and terminal at the bottom', () => {
    const state = mixed()
    const next = arranged(state, 'fill')
    const root = getSplit(next, next.root)
    expect(root.children[0]).toBe(MAIN)
    expect(root.sizes[0]).toBeCloseTo(0.45)
    const columns = root.children.slice(1).map(id => getSplit(next, id))
    expect(columns.map(c => c.children.map(id => getGroup(next, id).tabIds[0]))).toEqual([['a', 't'], ['b', 'k']])
    expect(columns[0].sizes).toEqual([0.6, 0.4]) // file 1.5 over terminal 1
    expect(root.sizes[2]).toBeGreaterThan(root.sizes[1]) // the browser column is wider
    for (const id of groupIds(state)) expect(tabGroupId(next, getGroup(state, id).tabIds[0])).toBe(id) // groups keep their tabs
  })

  it('keeps the conversation at 420 px on narrow screens and uses fewer columns', () => {
    const seven = groupsOf(Array.from({ length: 7 }, (_, i) => [tab(`t${i}`, i % 3 ? 'browser' : 'terminal')]))
    const wide = arranged(seven, 'fill')
    expect(getSplit(wide, wide.root).children).toHaveLength(4)
    const narrow = arranged(seven, 'fill', { size: { width: 900, height: 900 } })
    const root = getSplit(narrow, narrow.root)
    expect(root.sizes[0] * 900).toBeCloseTo(420)
    expect(root.children).toHaveLength(2)
    expect((narrow.nodes[root.children[1]] as SplitNode).children).toHaveLength(7)
  })

  it('brings minimized groups back and does nothing without groups', () => {
    const state = applyOps(mixed(), [{ type: 'setMinimized', groupId: 'g2', minimized: true }]).state
    expect(getGroup(arranged(state, 'fill'), 'g2').minimized).toBeUndefined()
    expect(planArrange(emptyLayout<TestTab>(), 'fill', options())).toEqual([])
  })
})
