import { describe, expect, it } from 'vitest'
import { MAIN, type LayoutOp, type LayoutState } from './types'
import { applyOp, applyOps } from './operations'
import { emptyGroup, emptyLayout, getGroup, getSplit, groupIds, layoutProblems } from './tree'
import { opRoundTrips, sound, startLayout, tab, type TestTab } from './testing'

/** row[main, g1, column[g2, g3]] with tabs t1 (g1), t2 + t3 (g2), t4 (g3). */
function richLayout(): LayoutState<TestTab> {
  let state = startLayout()
  const g1 = groupIds(state)[0]
  const ops: LayoutOp<TestTab>[] = [
    { type: 'openTab', groupId: g1, tab: tab('t1'), index: 0, scope: 's:A' },
    { type: 'addGroup', groupId: 'g2', group: emptyGroup(), at: { mode: 'edge', target: g1, axis: 'row', side: 'after', share: 0.5, splitId: 'x' } },
    { type: 'openTab', groupId: 'g2', tab: tab('t2', 'browser'), index: 0, scope: 's:A' },
    { type: 'openTab', groupId: 'g2', tab: tab('t3', 'terminal', { project: 'P' }), index: 1, scope: 's:B' },
    { type: 'addGroup', groupId: 'g3', group: emptyGroup(), at: { mode: 'edge', target: 'g2', axis: 'column', side: 'after', share: 0.5, splitId: 'c1' } },
    { type: 'openTab', groupId: 'g3', tab: tab('t4', 'tasks'), index: 0, scope: 's:A' },
  ]
  state = applyOps(state, ops).state
  sound(state)
  return state
}

describe('layout ops and their inverses', () => {
  it('addGroup beside a node in a same-axis parent halves its slot', () => {
    const state = startLayout()
    const g1 = groupIds(state)[0]
    const next = opRoundTrips(state, [{ type: 'addGroup', groupId: 'g2', group: emptyGroup(), at: { mode: 'edge', target: g1, axis: 'row', side: 'before', share: 0.5, splitId: 'unused' } }])
    const root = getSplit(next, next.root)
    expect(root.children).toEqual([MAIN, 'g2', g1])
    expect(root.sizes[1]).toBeCloseTo(0.16)
    expect(root.sizes[2]).toBeCloseTo(0.16)
    expect(next.nodes.unused).toBeUndefined()
  })

  it('addGroup across the parent axis wraps the target in a new split', () => {
    const state = startLayout()
    const g1 = groupIds(state)[0]
    const next = opRoundTrips(state, [{ type: 'addGroup', groupId: 'g2', group: emptyGroup(), at: { mode: 'edge', target: g1, axis: 'column', side: 'after', share: 0.4, splitId: 'c' } }])
    expect(getSplit(next, 'c')).toEqual({ kind: 'split', axis: 'column', children: [g1, 'g2'], sizes: [0.6, 0.4] })
    expect(getSplit(next, next.root).children).toEqual([MAIN, 'c'])
  })

  it('addGroup on the outer edge of a same-axis split joins it instead of nesting', () => {
    const state = startLayout()
    const next = opRoundTrips(state, [{ type: 'addGroup', groupId: 'g2', group: emptyGroup(), at: { mode: 'edge', target: state.root, axis: 'row', side: 'before', share: 0.2, splitId: 'n' } }])
    const root = getSplit(next, next.root)
    expect(root.children[0]).toBe('g2')
    expect(root.sizes[0]).toBeCloseTo(0.2)
    expect(root.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
    expect(next.nodes.n).toBeUndefined()
  })

  it('addGroup beside a lone main wraps the root', () => {
    const next = opRoundTrips(emptyLayout<TestTab>(), [{ type: 'addGroup', groupId: 'g', group: emptyGroup(), at: { mode: 'edge', target: MAIN, axis: 'column', side: 'after', share: 0.3, splitId: 's' } }])
    expect(next.root).toBe('s')
    expect(getSplit(next, 's').children).toEqual([MAIN, 'g'])
  })

  it('merge drops an empty group and collapses a two-child split', () => {
    const state = applyOp(richLayout(), { type: 'closeTab', tabId: 't4' }).state
    const next = opRoundTrips(state, [{ type: 'merge', groupId: 'g3' }])
    expect(next.nodes.c1).toBeUndefined()
    expect(getSplit(next, next.root).children).toContain('g2')
    sound(next)
  })

  it('merge from a three-child split renormalizes, and undo restores sizes verbatim', () => {
    const state = applyOps(richLayout(), [{ type: 'closeTab', tabId: 't1' }]).state
    const g1 = groupIds(state)[0]
    const next = opRoundTrips(state, [{ type: 'merge', groupId: g1 }])
    const root = getSplit(next, next.root)
    expect(root.children).toEqual([MAIN, 'c1'])
    expect(root.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })

  it('merge reseats focus and clears a maximize on the merged group', () => {
    let state = richLayout()
    state = applyOps(state, [{ type: 'closeTab', tabId: 't4' }, { type: 'focusGroup', groupId: 'g3' }, { type: 'setMaximized', groupId: 'g3' }]).state
    const next = opRoundTrips(state, [{ type: 'merge', groupId: 'g3' }])
    expect(next.maximizedGroup).toBeNull()
    expect(next.activeGroup).toBe(next.recent[0])
    expect(next.recent).not.toContain('g3')
  })

  it('refuses to merge a group with tabs, or anything that is not a group', () => {
    const state = richLayout()
    expect(() => applyOp(state, { type: 'merge', groupId: 'g2' })).toThrow(/empty/)
    expect(() => applyOp(state, { type: 'merge', groupId: MAIN })).toThrow(/not a group/)
    expect(() => applyOp(state, { type: 'merge', groupId: 'c1' })).toThrow(/not a group/)
  })

  it('main can never be detached', () => {
    expect(() => applyOp(richLayout(), { type: 'detach', nodeId: MAIN })).toThrow(/main/)
  })

  it('detach + attach moves a node, and the pair undoes exactly', () => {
    const state = richLayout()
    const next = opRoundTrips(state, [
      { type: 'detach', nodeId: 'g3' },
      { type: 'attach', nodeId: 'g3', at: { mode: 'edge', target: MAIN, axis: 'column', side: 'after', share: 0.3, splitId: 'b' } },
    ])
    expect(getSplit(next, 'b').children).toEqual([MAIN, 'g3'])
    expect(next.nodes.c1).toBeUndefined()
    sound(next)
  })

  it('attach refuses a node already in the tree and a target outside it', () => {
    const state = richLayout()
    expect(() => applyOp(state, { type: 'attach', nodeId: 'g3', at: { mode: 'edge', target: MAIN, axis: 'row', side: 'after', share: 0.3, splitId: 'z' } })).toThrow(/already in the tree/)
    const detached = applyOp(state, { type: 'detach', nodeId: 'g3' }).state
    expect(() => applyOp(detached, { type: 'attach', nodeId: 'g3', at: { mode: 'edge', target: 'g3', axis: 'row', side: 'after', share: 0.3, splitId: 'z' } })).toThrow(/not in the tree/)
  })

  it('openTab focuses the tab for one scope only', () => {
    const state = richLayout()
    const next = opRoundTrips(state, [{ type: 'openTab', groupId: 'g2', tab: tab('t5'), index: 0, scope: 's:Z' }])
    expect(getGroup(next, 'g2').tabIds).toEqual(['t5', 't2', 't3'])
    expect(getGroup(next, 'g2').activeByScope).toMatchObject({ 's:A': 't2', 's:B': 't3', 's:Z': 't5' })
    expect(next.activeGroup).toBe('g2')
    expect(next.recent[0]).toBe('g2')
    expect(() => applyOp(next, { type: 'openTab', groupId: 'g2', tab: tab('t5'), index: 0, scope: 's:Z' })).toThrow(/exists/)
  })

  it('insertTab adds without moving focus', () => {
    const state = richLayout()
    const next = opRoundTrips(state, [{ type: 'insertTab', groupId: 'g2', tab: tab('t5'), index: 9 }])
    expect(getGroup(next, 'g2').tabIds).toEqual(['t2', 't3', 't5'])
    expect(getGroup(next, 'g2').activeByScope).toEqual(getGroup(state, 'g2').activeByScope)
    expect(next.activeGroup).toBe(state.activeGroup)
  })

  it('closeTab removes the record and every scope pointing at it', () => {
    const state = richLayout()
    const next = opRoundTrips(state, [{ type: 'closeTab', tabId: 't3' }])
    expect(next.tabs.t3).toBeUndefined()
    expect(getGroup(next, 'g2').activeByScope).toEqual({ 's:A': 't2' })
  })

  it('moveTab moves between groups, with and without focus', () => {
    const state = richLayout()
    const focused = opRoundTrips(state, [{ type: 'moveTab', tabId: 't2', groupId: 'g3', index: 0, scope: 's:A' }])
    expect(getGroup(focused, 'g3').tabIds).toEqual(['t2', 't4'])
    expect(getGroup(focused, 'g3').activeByScope['s:A']).toBe('t2')
    expect(getGroup(focused, 'g2').activeByScope['s:A']).toBeUndefined()
    expect(focused.activeGroup).toBe('g3')
    const quiet = opRoundTrips(state, [{ type: 'moveTab', tabId: 't2', groupId: 'g3', index: 5, scope: null }])
    expect(quiet.activeGroup).toBe(state.activeGroup)
    expect(() => applyOp(state, { type: 'moveTab', tabId: 't2', groupId: 'g2', index: 0, scope: null })).toThrow(/reorderTab/)
  })

  it('reorderTab, updateTab, focus ops, resize and flags round-trip', () => {
    const state = richLayout()
    const g1 = groupIds(state)[0]
    const next = opRoundTrips(state, [
      { type: 'reorderTab', tabId: 't3', index: 0 },
      { type: 'updateTab', tab: { ...tab('t2', 'browser'), title: 'Docs' } },
      { type: 'focusTab', tabId: 't1', scope: 's:B' },
      { type: 'focusGroup', groupId: 'g3' },
      { type: 'setActive', groupId: 'g2', scope: 's:A', tabId: null },
      { type: 'setActive', groupId: 'g2', scope: 's:Q', tabId: 't3' },
      { type: 'resize', splitId: state.root, sizes: [2, 1, 1] },
      { type: 'setCollapsed', collapsed: true },
      { type: 'setMaximized', groupId: 'g2' },
      { type: 'setMinimized', groupId: g1, minimized: true },
    ])
    expect(getGroup(next, 'g2').tabIds).toEqual(['t3', 't2'])
    expect(next.tabs.t2.title).toBe('Docs')
    expect(getGroup(next, g1).activeByScope['s:B']).toBe('t1')
    expect(next.recent.slice(0, 2)).toEqual(['g3', g1])
    expect(getGroup(next, 'g2').activeByScope).toEqual({ 's:B': 't3', 's:Q': 't3' })
    expect(getSplit(next, next.root).sizes).toEqual([0.5, 0.25, 0.25])
    expect(next).toMatchObject({ collapsed: true, maximizedGroup: 'g2' })
    expect(getGroup(next, g1).minimized).toBe(true)
  })

  it('unminimizing deletes the flag so records compare equal again', () => {
    const state = richLayout()
    const g1 = groupIds(state)[0]
    const next = applyOps(state, [{ type: 'setMinimized', groupId: g1, minimized: true }, { type: 'setMinimized', groupId: g1, minimized: false }]).state
    expect('minimized' in getGroup(next, g1)).toBe(false)
  })

  it('rejects bad resizes and setActive on a foreign tab', () => {
    const state = richLayout()
    expect(() => applyOp(state, { type: 'resize', splitId: state.root, sizes: [1, 1] })).toThrow(/match/)
    expect(() => applyOp(state, { type: 'resize', splitId: state.root, sizes: [1, 0, 1] })).toThrow(/above zero/)
    expect(() => applyOp(state, { type: 'setActive', groupId: 'g2', scope: 's:A', tabId: 't4' })).toThrow(/not in/)
  })

  it('replaceTree swaps the structure and undoes to the old one', () => {
    const state = richLayout()
    const g1 = groupIds(state)[0]
    const nodes = {
      [MAIN]: { kind: 'main' as const },
      [g1]: state.nodes[g1], g2: state.nodes.g2, g3: state.nodes.g3,
      r: { kind: 'split' as const, axis: 'row' as const, children: [g1, MAIN, 'col'], sizes: [0.25, 0.5, 0.25] },
      col: { kind: 'split' as const, axis: 'column' as const, children: ['g2', 'g3'], sizes: [0.5, 0.5] },
    }
    const next = opRoundTrips(state, [{ type: 'replaceTree', root: 'r', nodes }])
    expect(next.root).toBe('r')
    sound(next)
  })

  it('replaceTree refuses trees that lose main or a tab', () => {
    const state = richLayout()
    const g1 = groupIds(state)[0]
    expect(() => applyOp(state, { type: 'replaceTree', root: g1, nodes: { [g1]: state.nodes[g1] } })).toThrow(/main|tab/)
    expect(() => applyOp(state, {
      type: 'replaceTree', root: 'r',
      nodes: { [MAIN]: { kind: 'main' }, [g1]: state.nodes[g1], r: { kind: 'split', axis: 'row', children: [MAIN, g1], sizes: [0.5, 0.5] } },
    })).toThrow(/no group/)
  })

  it('replaceTree reseats focus fields on groups that disappeared', () => {
    let state = richLayout()
    state = applyOps(state, [{ type: 'closeTab', tabId: 't4' }, { type: 'focusGroup', groupId: 'g3' }, { type: 'setMaximized', groupId: 'g3' }]).state
    const g1 = groupIds(state)[0]
    const nodes = {
      [MAIN]: { kind: 'main' as const }, [g1]: state.nodes[g1], g2: state.nodes.g2,
      r: { kind: 'split' as const, axis: 'row' as const, children: [MAIN, g1, 'g2'], sizes: [0.5, 0.25, 0.25] },
    }
    const next = opRoundTrips(state, [{ type: 'replaceTree', root: 'r', nodes }])
    expect(next.maximizedGroup).toBeNull()
    expect(next.recent).not.toContain('g3')
    expect(layoutProblems(next)).toEqual([])
  })

  it('restoreFocus round-trips on its own', () => {
    const state = richLayout()
    const g1 = groupIds(state)[0]
    const next = opRoundTrips(state, [{ type: 'restoreFocus', activeGroup: g1, recent: [g1, 'g3'], maximizedGroup: 'g2', groups: { g2: { 's:Q': 't3' } } }])
    expect(next).toMatchObject({ activeGroup: g1, recent: [g1, 'g3'], maximizedGroup: 'g2' })
    expect(getGroup(next, 'g2').activeByScope).toEqual({ 's:Q': 't3' })
  })

  it('restoreFocus refuses groups that do not exist', () => {
    expect(() => applyOp(richLayout(), { type: 'restoreFocus', activeGroup: 'nope', recent: [], maximizedGroup: null, groups: {} })).toThrow(/unknown node/)
  })
})
