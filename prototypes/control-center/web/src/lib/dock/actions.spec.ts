import { describe, expect, it } from 'vitest'
import { MAIN, type LayoutState } from './types'
import { activeTab, emptyLayout, getGroup, getSplit, groupIds, tabGroupId, visibleTabs } from './tree'
import {
  activateTab, closeAmong, closeGroup, closeTab, closeTabs, focusGroup, maximize, minimize, moveGroup, moveTab, moveTabToward, openTab, resize,
  setCollapsed, splitGroup, tabsInScope, toggleCollapsed, updateTab, type Change, type DockPolicy,
} from './actions'
import { A, B, Q, roundTrips, sound, startLayout, tab, testPolicy, type TestTab } from './testing'

function check<C extends Change<TestTab>>(before: LayoutState<TestTab>, change: C): C {
  roundTrips(before, change)
  sound(change.state)
  return change
}

/** Open tabs in order through `openTab` (auto target, scope A unless the tab says otherwise). */
function opened(tabs: TestTab[], policy: DockPolicy<TestTab> = testPolicy(), state = startLayout()) {
  for (const next of tabs) state = check(state, openTab(state, next, 'auto', A, policy)).state
  return state
}

/** row[main, g1, g2] with g1 = [a (tool), b (browser)], g2 = [c (terminal)]. */
function twoGroups(policy = testPolicy()) {
  let state = opened([tab('a'), tab('b', 'browser')], policy)
  const g1 = groupIds(state)[0]
  state = check(state, openTab(state, tab('c', 'terminal'), { edge: 'right', of: g1 }, A, policy)).state
  const g2 = tabGroupId(state, 'c')
  return { state, g1, g2, policy }
}

describe('openTab placement (design 1.6)', () => {
  it('with no group, creates the default right-hand group beside the conversation', () => {
    const state = emptyLayout<TestTab>()
    const change = check(state, openTab(state, tab('a'), 'auto', A, testPolicy()))
    const root = getSplit(change.state, change.state.root)
    expect(root.children[0]).toBe(MAIN)
    expect(root.sizes[1]).toBeCloseTo(0.32)
    const group = root.children[1]
    expect(getGroup(change.state, group).tabIds).toEqual(['a'])
    expect(change.state.activeGroup).toBe(group)
    expect(change.tabId).toBe('a')
  })

  it('goes to the most recently focused group', () => {
    const { state, g1, policy } = twoGroups()
    const focused = check(state, focusGroup(state, g1)).state
    expect(tabGroupId(check(focused, openTab(focused, tab('d', 'review'), 'auto', A, policy)).state, 'd')).toBe(g1)
  })

  it('prefers a group already holding that type over the focused one', () => {
    const { state, g1, g2, policy } = twoGroups()
    expect(state.activeGroup).toBe(g2)
    expect(tabGroupId(openTab(state, tab('d', 'browser'), 'auto', A, policy).state, 'd')).toBe(g1)
  })

  it('focuses an open tab with the same identity and takes the new fields', () => {
    const policy = testPolicy()
    const state = opened([tab('a', 'tool', 'workspace', { key: 'k', title: 'old' }), tab('b')], policy)
    const change = check(state, openTab(state, tab('z', 'tool', 'workspace', { key: 'k', title: 'new' }), 'auto', A, policy))
    expect(change.tabId).toBe('a')
    expect(change.state.tabs.z).toBeUndefined()
    expect(change.state.tabs.a.title).toBe('new')
    expect(activeTab(change.state, groupIds(change.state)[0], A)?.id).toBe('a')
    const again = openTab(change.state, tab('z', 'tool', 'workspace', { key: 'k', title: 'new' }), 'auto', A, policy)
    expect(again.ops).toEqual([]) // already shown and identical: nothing to do
    expect(again.state).toBe(change.state)
  })

  it('opens into an explicit group, or a new group on an edge of any node', () => {
    const { state, g1, policy } = twoGroups()
    expect(tabGroupId(check(state, openTab(state, tab('d'), g1, A, policy)).state, 'd')).toBe(g1)
    expect(tabGroupId(openTab(state, tab('d'), 'stale-id', A, policy).state, 'd')).toBe(g1) // falls back to auto (same type)
    expect(tabGroupId(openTab(state, tab('d'), { edge: 'left', of: 'gone' }, A, policy).state, 'd')).toBe(g1)
    const again = check(state, openTab(state, tab('a', 'tool', 'workspace', { title: 'same id' }), 'auto', A, policy))
    expect(again.tabId).toBe('a')
    expect(again.state.tabs.a.title).toBe('same id')
    const below = check(state, openTab(state, tab('d', 'tasks'), { edge: 'bottom', of: MAIN }, A, policy)).state
    const column = Object.values(below.nodes).find(node => node.kind === 'split' && node.axis === 'column')
    expect(column).toMatchObject({ children: [MAIN, tabGroupId(below, 'd')] })
  })

  it('an edge target may give the new group its share of the slot (the tasks panel’s 40/60 split)', () => {
    const { state, g1, policy } = twoGroups()
    const below = check(state, openTab(state, tab('d', 'file'), { edge: 'bottom', of: g1, share: 0.6 }, A, policy)).state
    const column = Object.values(below.nodes).find(node => node.kind === 'split' && node.axis === 'column')
    expect(column).toMatchObject({ children: [g1, tabGroupId(below, 'd')], sizes: [0.4, 0.6] })
    const half = openTab(state, tab('d', 'file'), { edge: 'bottom', of: g1, share: 1 }, A, policy).state // out of range: the default half
    expect(Object.values(half.nodes).find(node => node.kind === 'split' && node.axis === 'column')).toMatchObject({ sizes: [0.5, 0.5] })
  })

  it('a per-axis policy share sizes groups beside the conversation by width and above or below it by height', () => {
    const policy = testPolicy({ share: { row: 0.3, column: 0.25 } })
    const state = opened([tab('a')], policy, emptyLayout<TestTab>())
    expect(getSplit(state, state.root).sizes[1]).toBeCloseTo(0.3)
    const below = check(state, moveTab(state, 'a', { edge: 'bottom', of: MAIN }, A, { ...policy, seed: id => tab(id, 'launcher') })).state
    const column = Object.values(below.nodes).find(node => node.kind === 'split' && node.axis === 'column')
    expect(column).toMatchObject({ children: [MAIN, tabGroupId(below, 'a')] })
    expect((column as { sizes: number[] }).sizes[1]).toBeCloseTo(0.25)
    const moved = check(state, moveGroup(state, groupIds(state)[0], 'top', policy)).state
    expect(getSplit(moved, moved.root)).toMatchObject({ axis: 'column', children: [groupIds(state)[0], MAIN], sizes: [0.25, 0.75] })
  })

  it('replaces a tab in place (a launcher card) and reports it closed', () => {
    const policy = testPolicy()
    const state = opened([tab('a'), tab('l', 'launcher'), tab('b')], policy)
    const change = check(state, openTab(state, tab('t', 'terminal'), 'auto', A, policy, { replace: 'l' }))
    expect(getGroup(change.state, groupIds(change.state)[0]).tabIds).toEqual(['a', 't', 'b'])
    expect(change.closed.map(t => t.id)).toEqual(['l'])
  })

  it('opens in the background without stealing the shown tab, but still shows the panel', () => {
    const policy = testPolicy()
    const base = opened([tab('a')], policy)
    const state = check(base, setCollapsed(base, true)).state
    const change = check(state, openTab(state, tab('b'), 'auto', A, policy, { background: true }))
    expect(activeTab(change.state, groupIds(change.state)[0], A)?.id).toBe('a')
    expect(change.state.collapsed).toBe(false)
  })

  it('opens in the background without making the new tab the one a scope that never picked one falls back to', () => {
    const policy = testPolicy()
    const state = opened([tab('a')], policy)
    const group = groupIds(state)[0]
    // Conversation B never chose a tab in this group: it shows the last one, `a`.
    expect(getGroup(state, group).activeByScope).not.toHaveProperty('s:B')
    const change = check(state, openTab(state, tab('b'), 'auto', B, policy, { background: true }))
    expect(activeTab(change.state, group, B)?.id).toBe('a')
    expect(visibleTabs(change.state, group, B).map(t => t.id)).toEqual(['a', 'b'])
  })

  it('reveals its group: clears another maximize and restores it from the strip', () => {
    const { state, g1, g2, policy } = twoGroups()
    const hidden = check(state, minimize(state, g1)).state
    const maxed = check(hidden, maximize(hidden, g2)).state
    const change = check(maxed, openTab(maxed, tab('d', 'browser'), 'auto', A, policy))
    expect(change.state.maximizedGroup).toBeNull()
    expect(getGroup(change.state, g1).minimized).toBeUndefined()
  })

  it('caps the visible tabs per scope: lightweight first, never an active tab or the new one', () => {
    const policy = testPolicy({ cap: { max: 3, lightweight: t => t.type === 'tool' } })
    const mine = { session: 'A' }
    let state = opened([tab('t1', 'tool', mine), tab('t2', 'terminal', mine), tab('t3', 'tool', mine)], policy)
    let change = check(state, openTab(state, tab('t4', 'browser', mine), 'auto', A, policy))
    expect(change.closed.map(t => t.id)).toEqual(['t1'])
    state = change.state
    change = check(state, openTab(state, tab('t5', 'terminal', mine), 'auto', A, policy))
    expect(change.closed.map(t => t.id)).toEqual(['t3'])
    state = change.state
    change = check(state, openTab(state, tab('t6', 'terminal', mine), 'auto', A, policy))
    expect(change.closed.map(t => t.id)).toEqual(['t2'])
    // Another conversation's tabs neither count nor get evicted.
    state = change.state
    change = check(state, openTab(state, tab('x', 'tool', { session: 'B' }), 'auto', B, policy))
    expect(change.closed).toEqual([])
    expect(tabsInScope(change.state, A).map(t => t.id)).toEqual(['t4', 't5', 't6'])
  })
})

describe('bindings and per-scope active tabs', () => {
  it('a group shows only the tabs bound to the selected conversation or project', () => {
    const policy = testPolicy()
    let state = startLayout()
    for (const [next, ctx] of [
      [tab('w', 'launcher'), A], [tab('a', 'tool', { session: 'A' }), A], [tab('b', 'tool', { session: 'B' }), B],
      [tab('p', 'terminal', { project: 'P' }), A], [tab('q', 'terminal', { project: 'Q' }), Q],
    ] as const) state = check(state, openTab(state, next, 'auto', ctx, policy)).state
    const group = groupIds(state)[0]
    expect(visibleTabs(state, group, A).map(t => t.id)).toEqual(['w', 'a', 'p'])
    expect(visibleTabs(state, group, B).map(t => t.id)).toEqual(['w', 'b', 'p'])
    expect(visibleTabs(state, group, Q).map(t => t.id)).toEqual(['w', 'q'])
    expect(visibleTabs(state, group, {}).map(t => t.id)).toEqual(['w'])
    expect(activeTab(state, group, A)?.id).toBe('p')
    expect(activeTab(state, group, B)?.id).toBe('b')
    expect(activeTab(state, group, Q)?.id).toBe('q')
    // A scope that never chose falls back to its last visible tab.
    expect(activeTab(state, group, { projectId: 'P' })?.id).toBe('p')
    state = check(state, activateTab(state, 'w', B)).state
    expect(activeTab(state, group, B)?.id).toBe('w')
    expect(activeTab(state, group, A)?.id).toBe('p')
  })
})

describe('closing', () => {
  it('the right neighbour (else the left) takes over a closed active tab', () => {
    const policy = testPolicy()
    let state = opened([tab('a'), tab('b'), tab('c')], policy)
    state = check(state, activateTab(state, 'b', A)).state
    state = check(state, closeTab(state, 'b', A, policy)).state
    expect(activeTab(state, groupIds(state)[0], A)?.id).toBe('c')
    state = check(state, closeTab(state, 'c', A, policy)).state
    expect(activeTab(state, groupIds(state)[0], A)?.id).toBe('a')
    expect(closeTab(state, 'gone', A, policy).ops).toEqual([])
  })

  it('closing the last tab keeps the lone group as the empty panel, unless told otherwise', () => {
    const state = opened([tab('a')])
    const kept = check(state, closeTab(state, 'a', A, testPolicy()))
    expect(groupIds(kept.state)).toHaveLength(1)
    expect(kept.closed.map(t => t.id)).toEqual(['a'])
    const gone = check(state, closeTab(state, 'a', A, testPolicy({ keepLastGroup: false })))
    expect(gone.state.root).toBe(MAIN)
  })

  it('a second group goes away with its last tab', () => {
    const { state, g2, policy } = twoGroups()
    const change = check(state, closeTab(state, 'c', A, policy))
    expect(change.state.nodes[g2]).toBeUndefined()
    expect(getSplit(change.state, change.state.root).children).toHaveLength(2)
  })

  it('close others / left / right / all act on the tabs shown in this scope only', () => {
    const policy = testPolicy()
    let state = opened([tab('a'), tab('b'), tab('c'), tab('d')], policy)
    state = check(state, openTab(state, tab('x', 'tool', { session: 'B' }), 'auto', B, policy)).state
    const group = groupIds(state)[0]
    const left = check(state, closeTabs(state, 'c', 'left', A, policy))
    expect(left.closed.map(t => t.id)).toEqual(['a', 'b'])
    const right = check(state, closeTabs(state, 'b', 'right', A, policy))
    expect(right.closed.map(t => t.id)).toEqual(['c', 'd'])
    expect(activeTab(right.state, group, A)?.id).toBe('b')
    const others = check(state, closeTabs(state, 'b', 'others', A, policy))
    expect(visibleTabs(others.state, group, A).map(t => t.id)).toEqual(['b'])
    expect(activeTab(others.state, group, A)?.id).toBe('b')
    const all = check(state, closeTabs(state, 'b', 'all', A, policy))
    expect(Object.keys(all.state.tabs)).toEqual(['x'])
    expect(closeTabs(state, 'a', 'left', A, policy).ops).toEqual([])
  })

  it('close others / left / right / all over a merged strip act on what that strip lists, across groups', () => {
    // The strip lists g1's a, b then g2's c (groups in visual order); it shows c (g2 focused last).
    const { state, g1, g2, policy } = twoGroups()
    const listed = tabsInScope(state, A).map(t => t.id)
    expect(listed).toEqual(['a', 'b', 'c'])
    const shown = activeTab(state, g2, A)!.id
    expect(shown).toBe('c')
    const left = check(state, closeAmong(state, 'c', 'left', listed, shown, A, policy))
    expect(left.closed.map(t => t.id)).toEqual(['a', 'b']) // another group's tabs, as the strip showed them
    expect(left.state.activeGroup).toBe(g2)
    const right = check(state, closeAmong(state, 'b', 'right', listed, shown, A, policy))
    expect(right.closed.map(t => t.id)).toEqual(['c'])
    expect(right.state.nodes[g2]).toBeUndefined() // a group left empty goes
    expect(right.state.activeGroup).toBe(g1) // the shown tab closed: the anchor takes over
    expect(activeTab(right.state, g1, A)?.id).toBe('b')
    const others = check(state, closeAmong(state, 'a', 'others', listed, shown, A, policy))
    expect(Object.keys(others.state.tabs)).toEqual(['a'])
    expect(others.state.activeGroup).toBe(g1)
    const all = check(state, closeAmong(state, 'b', 'all', listed, shown, A, policy))
    expect(Object.keys(all.state.tabs)).toEqual([])
    // Nothing to close, or an anchor the strip does not list: no change.
    expect(closeAmong(state, 'a', 'left', listed, shown, A, policy).ops).toEqual([])
    expect(closeAmong(state, 'a', 'others', ['a'], shown, A, policy).ops).toEqual([])
    expect(closeAmong(state, 'zz', 'all', listed, shown, A, policy).ops).toEqual([])
  })

  it('closeGroup closes every tab in every scope and removes the group', () => {
    const { state, g1, policy } = twoGroups()
    const withB = check(state, openTab(state, tab('x', 'browser', { session: 'B' }), g1, B, policy)).state
    const change = check(withB, closeGroup(withB, g1, policy))
    expect(change.closed.map(t => t.id).sort()).toEqual(['a', 'b', 'x'])
    expect(change.state.nodes[g1]).toBeUndefined()
    const last = check(change.state, closeGroup(change.state, groupIds(change.state)[0], policy))
    expect(last.state.root).toBe(MAIN)
  })

  it('closeGroup from a conversation closes what it shows there; what shows elsewhere moves to another group, or keeps the only one hidden', () => {
    const { state, g1, g2, policy } = twoGroups()
    const elsewhere = check(state, openTab(state, tab('x', 'terminal', { project: 'Q' }), g1, Q, policy)).state
    const change = check(elsewhere, closeGroup(elsewhere, g1, policy, A))
    expect(change.closed.map(t => t.id).sort()).toEqual(['a', 'b']) // Q's terminal was not A's to close
    expect(change.state.nodes[g1]).toBeUndefined()
    expect(getGroup(change.state, g2).tabIds).toEqual(['c', 'x'])
    expect(activeTab(change.state, g2, A)?.id).toBe('c') // moved without changing what A shows
    // The only group: A's tabs close, Q's stays and the panels hide.
    const single = check(change.state, closeGroup(change.state, g2, policy, A))
    expect(single.closed.map(t => t.id)).toEqual(['c'])
    expect(getGroup(single.state, g2).tabIds).toEqual(['x'])
    expect(single.state.collapsed).toBe(true)
  })
})

describe('moving', () => {
  it('moves into another group, reorders within one, and splits on an edge', () => {
    const { state, g1, g2, policy } = twoGroups()
    const into = check(state, moveTab(state, 'a', g2, A, policy))
    expect(getGroup(into.state, g2).tabIds).toEqual(['c', 'a'])
    expect(activeTab(into.state, g2, A)?.id).toBe('a')
    const reordered = check(state, moveTab(state, 'b', g1, A, policy, 0))
    expect(getGroup(reordered.state, g1).tabIds).toEqual(['b', 'a'])
    expect(moveTab(state, 'b', g1, A, policy).ops).toEqual([])
    const split = check(state, moveTab(state, 'b', { edge: 'top', of: g2 }, A, policy))
    const column = Object.values(split.state.nodes).find(node => node.kind === 'split' && node.axis === 'column')
    expect(column).toMatchObject({ children: [tabGroupId(split.state, 'b'), g2] })
    expect(moveTab(state, 'b', 'nope', A, policy).ops).toEqual([])
  })

  it('moving the last tab out of a group settles the group away', () => {
    const { state, g1, g2, policy } = twoGroups()
    const change = check(state, moveTab(state, 'c', g1, A, policy))
    expect(change.state.nodes[g2]).toBeUndefined()
    expect(change.closed).toEqual([])
  })

  it('move toward a side: into the neighbouring group, else a new one split off there', () => {
    const { state, g1, g2, policy } = twoGroups()
    expect(tabGroupId(check(state, moveTabToward(state, 'a', 'right', A, policy)).state, 'a')).toBe(g2)
    const leftward = check(state, moveTabToward(state, 'a', 'left', A, policy)).state
    const root = getSplit(leftward, leftward.root)
    expect(root.children.indexOf(tabGroupId(leftward, 'a'))).toBe(root.children.indexOf(g1) - 1)
    const down = check(state, moveTabToward(state, 'a', 'bottom', A, policy)).state
    expect(Object.values(down.nodes).find(node => node.kind === 'split' && node.axis === 'column')).toMatchObject({ children: [g1, tabGroupId(down, 'a')] })
    // A group's only tab has nowhere to go below it unless a launcher backfills the group.
    expect(moveTabToward(state, 'c', 'bottom', A, policy).ops).toEqual([])
    const seeded = check(state, moveTabToward(state, 'c', 'bottom', A, testPolicy({ seed: id => tab(id, 'launcher') }))).state
    expect(visibleTabs(seeded, g2, A).map(t => t.type)).toEqual(['launcher'])
    expect(tabGroupId(seeded, 'c')).not.toBe(g2)
  })

  it('moveGroup hangs a group on any edge of the conversation', () => {
    const { state, g2, policy } = twoGroups()
    const bottom = check(state, moveGroup(state, g2, 'bottom', policy)).state
    const column = Object.values(bottom.nodes).find(node => node.kind === 'split' && node.axis === 'column')
    expect(column).toMatchObject({ children: [MAIN, g2] })
    const left = check(bottom, moveGroup(bottom, g2, 'left', policy)).state
    const row = getSplit(left, left.root)
    expect(row.children.indexOf(g2)).toBe(row.children.indexOf(MAIN) - 1)
    expect(moveGroup(left, g2, 'left', policy).ops).toEqual([])
    const top = check(left, moveGroup(left, g2, 'top', policy)).state
    expect(Object.values(top.nodes).find(node => node.kind === 'split' && node.axis === 'column')).toMatchObject({ children: [g2, MAIN] })
  })

  it('moving a maximized group restores it in the same change, so one undo puts both back', () => {
    const { state, g2, policy } = twoGroups()
    const big = check(state, maximize(state, g2)).state
    expect(big.maximizedGroup).toBe(g2)
    const moved = check(big, moveGroup(big, g2, 'bottom', policy))
    expect(moved.state.maximizedGroup).toBeNull()
    expect(Object.values(moved.state.nodes).find(node => node.kind === 'split' && node.axis === 'column')).toMatchObject({ children: [MAIN, g2] })
  })

  it('splitGroup moves a tab into a new group, or opens a seeded one', () => {
    const { state, g1, policy } = twoGroups()
    const moved = check(state, splitGroup(state, g1, 'down', A, policy, 'b')).state
    expect(Object.values(moved.nodes).find(node => node.kind === 'split' && node.axis === 'column')).toMatchObject({ children: [g1, tabGroupId(moved, 'b')] })
    expect(splitGroup(state, g1, 'right', A, policy).ops).toEqual([])
    const seeded = testPolicy({ seed: id => tab(id, 'launcher') })
    const fresh = check(state, splitGroup(state, g1, 'right', A, seeded))
    const added = groupIds(fresh.state).find(id => !groupIds(state).includes(id))!
    expect(visibleTabs(fresh.state, added, A).map(t => t.type)).toEqual(['launcher'])
    expect(fresh.state.activeGroup).toBe(added)
  })
})

describe('focus, flags and sizes', () => {
  it('maximize toggles, unminimizes and expands; minimize drops a maximize', () => {
    const { state, g1 } = twoGroups()
    const folded = check(state, toggleCollapsed(state)).state
    const collapsed = check(folded, minimize(folded, g1)).state
    const maxed = check(collapsed, maximize(collapsed, g1)).state
    expect(maxed).toMatchObject({ maximizedGroup: g1, collapsed: false })
    expect(getGroup(maxed, g1).minimized).toBeUndefined()
    expect(check(maxed, maximize(maxed, g1)).state.maximizedGroup).toBeNull()
    expect(check(maxed, minimize(maxed, g1)).state.maximizedGroup).toBeNull()
    expect(minimize(state, g1, false).ops).toEqual([])
    expect(maximize(state, 'nope').ops).toEqual([])
  })

  it('activateTab focuses the group and brings it back from the strip', () => {
    const { state, g1 } = twoGroups()
    const hidden = check(state, minimize(state, g1)).state
    const shown = check(hidden, activateTab(hidden, 'a', A)).state
    expect(shown.activeGroup).toBe(g1)
    expect(activeTab(shown, g1, A)?.id).toBe('a')
    expect(getGroup(shown, g1).minimized).toBeUndefined()
  })

  it('updateTab patches fields but keeps id and type', () => {
    const { state } = twoGroups()
    const change = check(state, updateTab(state, 'b', { title: 'Docs', id: 'zzz', type: 'tool' }))
    expect(change.state.tabs.b).toMatchObject({ id: 'b', type: 'browser', title: 'Docs' })
    expect(updateTab(change.state, 'b', { title: 'Docs' }).ops).toEqual([])
  })

  it('resize clamps to the minimum fraction', () => {
    const { state } = twoGroups()
    const change = check(state, resize(state, state.root, [0.98, 0.01, 0.01]))
    expect(Math.min(...getSplit(change.state, change.state.root).sizes)).toBeCloseTo(0.12)
    expect(resize(state, MAIN, [1]).ops).toEqual([])
  })
})
