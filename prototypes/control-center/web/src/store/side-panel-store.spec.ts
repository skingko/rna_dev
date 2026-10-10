import { beforeEach, describe, expect, it } from 'vitest'
import { activeTab, computeRects, getGroup, getSplit, groupIds, MAIN, tabGroupId, visibleTabs, type LayoutState } from '@/lib/dock'
import {
  MAX_TABS, activateTab, applyPreset, besideTarget, bindingFor, closeAmongTabs, closeGroup, closeOtherTabs, closeTab, closeTabsBeside, currentPane, evict, flushLayout,
  maximizeGroup, mergeV1Tab, minimizeGroup, moveGroup, moveTab, moveTabToward, naturalBinding, neighborAfterClose, nextSideOrdinal, onTabClosed, onTabPicked, openLauncher,
  openTab, placeTab, redoLayout, reopenClosedTab, resetSidePanel, resizeDivider, sanitizeTab, sanitizeV1Tab, scopeKey, serializeLayout, setContext, setPanelOpen,
  setScope, setSheet, setViewport, splitGroup, tabIdentity, tabOnScreen, togglePanel, undoLayout, updateTab, useSidePanel, type CloseCause, type SideTab,
} from './side-panel-store'
import { loadLayout } from './layout-persist'
import { closeDock, openDock } from './ui-store'

beforeEach(() => resetSidePanel())

const layout = () => useSidePanel.getState().layout
const groups = () => groupIds(layout())

describe('side panel tabs', () => {
  it('derives the scope from the conversation, else the project', () => {
    expect(scopeKey('s-1', 'p-1')).toBe('s:s-1')
    expect(scopeKey(null, 'p-1')).toBe('p:p-1')
    expect(scopeKey(null, null)).toBe('global')
  })

  it('opens, activates and shows the panel; reusable tabs are focused instead of duplicated', () => {
    const a = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    const b = openTab({ type: 'file', projectId: 'p', path: 'b.md' })
    expect(currentPane()).toMatchObject({ open: true, activeId: b })
    expect(openTab({ type: 'file', projectId: 'p', path: 'a.md' })).toBe(a)
    expect(currentPane().tabs).toHaveLength(2)
    expect(currentPane().activeId).toBe(a)
  })

  it('a turn’s 审阅 carries the turn and the file to open on; a later plain 审阅 clears them; both survive a reload', () => {
    openDock({ kind: 'diff', sessionId: 's', itemIds: ['e1'], turnId: 't1', focus: 'e1', focusPath: 'src/a.ts' })
    expect(currentPane().tabs[0]).toMatchObject({ type: 'review', turnId: 't1', focusPath: 'src/a.ts', focus: 'e1' })
    expect(sanitizeTab(JSON.parse(JSON.stringify(currentPane().tabs[0])))).toMatchObject({ turnId: 't1', focusPath: 'src/a.ts' })
    openDock({ kind: 'diff', sessionId: 's', itemIds: ['e2'], focus: 'e2' })
    expect(currentPane().tabs).toHaveLength(1)
    expect(currentPane().tabs[0]).toMatchObject({ itemIds: ['e2'], turnId: null, focusPath: null })
  })

  it('keeps one 审查 tab per session and updates its focus', () => {
    const id = openTab({ type: 'review', sessionId: 's', itemIds: ['x'], focus: 'x' })
    openTab({ type: 'review', sessionId: 's', itemIds: null, focus: 'y' })
    const tabs = currentPane().tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ id, itemIds: null, focus: 'y' })
  })

  it('always opens new terminals and side chats until they have host ids', () => {
    expect(tabIdentity({ type: 'terminal', projectId: 'p', terminalId: null })).toBeNull()
    expect(tabIdentity({ type: 'terminal', projectId: 'p', terminalId: 't1' })).toBe('terminal:t1')
    openTab({ type: 'terminal', projectId: 'p' })
    openTab({ type: 'terminal', projectId: 'p' })
    expect(currentPane().tabs).toHaveLength(2)
    expect(nextSideOrdinal()).toBe(1)
    openTab({ type: 'side-chat', parentSessionId: 's', ordinal: nextSideOrdinal() })
    expect(nextSideOrdinal()).toBe(2)
  })

  it('reuses keyed browser tabs (run preview) and replaces the chooser in place', () => {
    const launcher = openLauncher()
    const other = openTab({ type: 'tool', sessionId: 's', itemId: 'i' })
    activateTab(launcher)
    const browser = openTab({ type: 'browser', url: 'http://127.0.0.1:5173/', key: 'preview:p' }, { replace: launcher })
    expect(currentPane().tabs.map(t => t.id)).toEqual([browser, other])
    expect(openTab({ type: 'browser', url: 'http://127.0.0.1:5174/', key: 'preview:p', reload: 2 })).toBe(browser)
    expect(currentPane().tabs.find(t => t.id === browser)).toMatchObject({ url: 'http://127.0.0.1:5174/', reload: 2 })
    expect(openLauncher()).not.toBe(launcher)
  })

  it('closes to the right-hand neighbor, else the left; background opens keep focus', () => {
    const tabs = ['a', 'b', 'c'].map(id => ({ id, type: 'launcher' }) as SideTab)
    expect(neighborAfterClose(tabs, 'b', 'b')).toBe('c')
    expect(neighborAfterClose(tabs, 'c', 'c')).toBe('b')
    expect(neighborAfterClose(tabs, 'a', 'c')).toBe('c')
    expect(neighborAfterClose([tabs[0]], 'a', 'a')).toBeNull()
    const first = openTab({ type: 'tool', sessionId: 's', itemId: 'i' })
    openTab({ type: 'file', projectId: 'p', path: 'x' }, { background: true })
    expect(currentPane().activeId).toBe(first)
  })

  it('notifies close listeners (terminals end their host shell)', () => {
    const closed: string[] = []
    const off = onTabClosed(tab => closed.push(tab.type))
    const term = openTab({ type: 'terminal', projectId: 'p', terminalId: 't1' })
    const keep = openTab({ type: 'tool', sessionId: 's', itemId: 'i' })
    closeTab(term)
    openTab({ type: 'browser', url: '' })
    closeOtherTabs(keep)
    off()
    expect(closed).toEqual(['terminal', 'browser'])
    expect(currentPane().tabs.map(t => t.id)).toEqual([keep])
  })

  it('evicts lightweight tabs first, never the active one', () => {
    const tabs: SideTab[] = [
      { id: 'b', type: 'browser', url: '', binding: 'workspace' },
      ...Array.from({ length: MAX_TABS }, (_, i) => ({ id: `f${i}`, type: 'file', projectId: 'p', path: `${i}`, binding: 'workspace' }) as SideTab),
    ]
    const kept = evict(tabs, 'f0')
    expect(kept).toHaveLength(MAX_TABS)
    expect(kept.map(t => t.id)).toContain('b')
    expect(kept.map(t => t.id)).toContain('f0')
    expect(kept.map(t => t.id)).not.toContain('f1')
  })

  it('caps the tabs one conversation shows at MAX_TABS: lightweight ones go first, and close for real', () => {
    const closed: string[] = []
    const off = onTabClosed(tab => closed.push(tab.id))
    const browser = openTab({ type: 'browser', url: 'http://localhost:1/' })
    const files = Array.from({ length: MAX_TABS }, (_, i) => openTab({ type: 'file', projectId: 'p', path: `${i}.md` }))
    off()
    expect(currentPane().tabs).toHaveLength(MAX_TABS)
    expect(closed).toEqual([files[0]])
    expect(currentPane().tabs.map(t => t.id)).toContain(browser)
  })

  it('tells close listeners why a tab went: closed by the user, evicted past the cap, or replaced by a picked card', () => {
    const heard: [string, CloseCause][] = []
    const off = onTabClosed((tab, cause) => heard.push([tab.type, cause]))
    const tasks = openTab({ type: 'tasks' })
    for (let i = 0; i < MAX_TABS; i++) openTab({ type: 'browser', url: `http://localhost:${i + 1}/` })
    expect(heard).toEqual([['tasks', 'evicted']]) // no lightweight tab left to go first
    expect(layout().tabs[tasks]).toBeUndefined()
    const chooser = openLauncher()
    openTab({ type: 'file', projectId: 'p', path: 'a.md' }, { replace: chooser })
    // The chooser pushed one page past the cap, then the card picked in it replaced it.
    expect(heard.slice(1).map(([type, cause]) => `${type}:${cause}`).sort()).toEqual(['browser:evicted', 'launcher:replaced'])
    heard.length = 0
    const page = currentPane().tabs.find(tab => tab.type === 'browser')!
    closeTab(page.id)
    undoLayout()
    redoLayout()
    expect(heard).toEqual([['browser', 'closed'], ['browser', 'closed']])
    off()
  })

  it('tells pick listeners when the user brings a tab up: a strip pick, undo, redo or ⇧⌘T', () => {
    const picked: string[] = []
    const off = onTabPicked(tab => picked.push(tab.id))
    const a = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    const b = openTab({ type: 'tool', sessionId: 's', itemId: 'i' })
    expect(picked).toEqual([]) // opening is not picking an existing tab
    activateTab(a)
    expect(picked).toEqual([a])
    closeTab(b)
    reopenClosedTab()
    expect(picked).toEqual([a, b])
    off()
  })

  // D1: the geometry and the open/collapsed switch are global; tabs bound to a conversation only show there.
  it('shows each conversation its own tabs; the panel switch is global (D1)', () => {
    setScope('s:one')
    openTab({ type: 'tool', sessionId: 'one', itemId: 'i' })
    setScope('s:two')
    expect(currentPane().tabs).toHaveLength(0)
    expect(currentPane().open).toBe(true) // was false: v1 kept an open flag per conversation
    setScope('s:one')
    expect(currentPane().tabs).toHaveLength(1)
  })

  it('toggles and collapses without dropping tabs; reorders with moveTab', () => {
    const a = openTab({ type: 'tool', sessionId: 's', itemId: 'i' })
    const b = openTab({ type: 'file', projectId: 'p', path: 'x' })
    togglePanel()
    expect(currentPane().open).toBe(false)
    expect(currentPane().tabs).toHaveLength(2)
    setPanelOpen(true)
    moveTab(b, -1)
    expect(currentPane().tabs.map(t => t.id)).toEqual([b, a])
    updateTab(b, { path: 'y' })
    expect(currentPane().tabs[0]).toMatchObject({ type: 'file', path: 'y' })
  })

  // The session overview type is retired (design 1.1): `group` opens 审查 for the session, which `diff` already opened.
  it('maps the former dock panels to tabs', () => {
    openDock({ kind: 'tool', sessionId: 's', itemId: 'i' })
    openDock({ kind: 'diff', sessionId: 's', itemIds: ['i'], focus: 'i' })
    openDock({ kind: 'file', projectId: 'p', path: 'README.md' })
    openDock({ kind: 'group', sessionId: 's', itemIds: [] })
    expect(currentPane().tabs.map(t => t.type)).toEqual(['tool', 'review', 'file'])
    expect(currentPane().tabs[1]).toMatchObject({ itemIds: null })
    closeDock()
    expect(currentPane().open).toBe(false)
  })
})

describe('bindings (design 1.1)', () => {
  it('binds conversation tabs to their conversation, project tabs to their project, the chooser and tasks everywhere', () => {
    expect(naturalBinding({ type: 'tool', sessionId: 's', itemId: 'i' })).toEqual({ session: 's' })
    expect(naturalBinding({ type: 'side-chat', parentSessionId: 's', ordinal: 1 })).toEqual({ session: 's' })
    expect(naturalBinding({ type: 'terminal', projectId: 'p' })).toEqual({ project: 'p' })
    expect(naturalBinding({ type: 'browser', url: '', key: 'preview:p' })).toEqual({ project: 'p' })
    expect(naturalBinding({ type: 'browser', url: '' })).toBe('workspace')
    expect(naturalBinding({ type: 'tasks' })).toBe('workspace')
    expect(naturalBinding({ type: 'launcher' })).toBe('workspace')
  })

  it('binds to the selection instead when the natural binding would hide the tab where it opens', () => {
    expect(bindingFor({ type: 'file', projectId: 'p', path: 'a' }, { sessionId: 's', projectId: 'p' })).toEqual({ project: 'p' })
    expect(bindingFor({ type: 'file', projectId: 'q', path: 'a' }, { sessionId: 's', projectId: 'p' })).toEqual({ session: 's' })
    expect(bindingFor({ type: 'file', projectId: 'q', path: 'a' }, { sessionId: null, projectId: null })).toBe('workspace')
  })

  it('a project tab follows every conversation of its project; a conversation tab stays in its conversation', () => {
    setContext({ sessionId: 'a', projectId: 'p' })
    const file = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    const tool = openTab({ type: 'tool', sessionId: 'a', itemId: 'i' })
    setContext({ sessionId: 'b', projectId: 'p' })
    expect(currentPane().tabs.map(t => t.id)).toEqual([file])
    setContext({ sessionId: 'c', projectId: 'q' })
    expect(currentPane().tabs).toEqual([])
    setContext({ sessionId: 'a', projectId: 'p' })
    expect(currentPane().tabs.map(t => t.id)).toEqual([file, tool])
  })

  it('remembers the active tab per conversation', () => {
    setContext({ sessionId: 'a', projectId: 'p' })
    const file = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    openTab({ type: 'file', projectId: 'p', path: 'b.md' })
    setContext({ sessionId: 'b', projectId: 'p' })
    activateTab(file)
    expect(currentPane().activeId).toBe(file)
    setContext({ sessionId: 'a', projectId: 'p' })
    expect(currentPane().activeId).not.toBe(file)
  })

  it('adds the tasks type (identity tasks, one per window)', () => {
    const a = openTab({ type: 'tasks', projectFilter: 'all' })
    expect(openTab({ type: 'tasks', projectFilter: 'p', focusRunId: 'r1' })).toBe(a)
    expect(layout().tabs[a]).toMatchObject({ type: 'tasks', projectFilter: 'p', focusRunId: 'r1', binding: 'workspace' })
    expect(sanitizeTab({ id: 'x', type: 'tasks' })).toMatchObject({ type: 'tasks', binding: 'workspace', focusRunId: null })
  })
})

describe('placement (P-7)', () => {
  it('opens into an explicit group or onto an edge of any node', () => {
    const a = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    const first = tabGroupId(layout(), a)
    const below = openTab({ type: 'terminal', projectId: 'p' }, { target: { edge: 'bottom', of: MAIN } })
    const column = Object.values(layout().nodes).find(node => node.kind === 'split' && node.axis === 'column')
    expect(column).toMatchObject({ children: [MAIN, tabGroupId(layout(), below)] })
    const into = openTab({ type: 'file', projectId: 'p', path: 'b.md' }, { target: first })
    expect(tabGroupId(layout(), into)).toBe(first)
  })

  it('besideType: an adjacent group, else 40/60 below a tall holder, else beside it, else into it', () => {
    const tasks = openTab({ type: 'tasks' })
    const holder = tabGroupId(layout(), tasks)
    expect(besideTarget(layout(), 'nope', useSidePanel.getState().ctx, null)).toBeNull()
    expect(besideTarget(layout(), 'tasks', useSidePanel.getState().ctx, { width: 1400, height: 900 })).toEqual({ edge: 'bottom', of: holder, share: 0.6 })
    expect(besideTarget(layout(), 'tasks', useSidePanel.getState().ctx, { width: 1600, height: 500 })).toEqual({ edge: 'right', of: holder })
    expect(besideTarget(layout(), 'tasks', useSidePanel.getState().ctx, { width: 800, height: 500 })).toBe(holder)

    setViewport({ width: 1400, height: 900 })
    const change = openTab({ type: 'change-review', projectId: 'p', changeId: 'c1' }, { besideType: 'tasks' })
    const placed = tabGroupId(layout(), change)
    expect(placed).not.toBe(holder)
    const split = Object.values(layout().nodes).find(node => node.kind === 'split' && node.children.includes(placed))
    expect(split).toMatchObject({ axis: 'column', children: [holder, placed], sizes: [0.4, 0.6] })
    // Now the holder has a neighbour: later previews join it.
    const file = openTab({ type: 'file', projectId: 'p', path: 'a.md' }, { besideType: 'tasks' })
    expect(tabGroupId(layout(), file)).toBe(placed)
  })

  it('opens the chooser per group: "+" reuses that group’s chooser only', () => {
    const a = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    const g1 = tabGroupId(layout(), a)
    splitGroup(g1, 'right')
    const g2 = groups().find(id => id !== g1)!
    const seeded = getGroup(layout(), g2).tabIds[0]
    expect(layout().tabs[seeded].type).toBe('launcher')
    expect(openLauncher(g2)).toBe(seeded)
    const l1 = openLauncher(g1)
    expect(l1).not.toBe(seeded)
    expect(tabGroupId(layout(), l1)).toBe(g1)
  })
})

describe('group operations', () => {
  function twoGroups() {
    const a = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    const b = openTab({ type: 'browser', url: 'http://localhost:2/' })
    const g1 = tabGroupId(layout(), a)
    moveTabToward(b, 'right')
    const g2 = tabGroupId(layout(), b)
    return { a, b, g1, g2 }
  }

  it('moves a tab toward a side, splitting when nothing is there, and into the neighbour when something is', () => {
    const { a, g1, g2 } = twoGroups()
    expect(g2).not.toBe(g1)
    moveTabToward(a, 'right')
    expect(tabGroupId(layout(), a)).toBe(g2)
    expect(groups()).toEqual([g2]) // the emptied group settles away
  })

  it('drops a tab into a strip slot of another group, or reorders it in its own', () => {
    const { a, b, g1, g2 } = twoGroups()
    const c = openTab({ type: 'file', projectId: 'p', path: 'c.md' }, { target: g1 })
    placeTab(b, g1, 0)
    expect(getGroup(layout(), g1).tabIds).toEqual([b, a, c])
    expect(layout().nodes[g2]).toBeUndefined()
    placeTab(b, g1, 3)
    expect(getGroup(layout(), g1).tabIds).toEqual([a, c, b])
  })

  it('moves a whole group to an edge of the conversation, minimizes, maximizes and closes it', () => {
    const closed: string[] = []
    const off = onTabClosed(tab => closed.push(tab.id))
    const { b, g2 } = twoGroups()
    moveGroup(g2, 'left')
    expect(getSplit(layout(), layout().root).children[0]).toBe(g2)
    minimizeGroup(g2)
    expect(getGroup(layout(), g2).minimized).toBe(true)
    maximizeGroup(g2)
    expect(layout().maximizedGroup).toBe(g2)
    expect(getGroup(layout(), g2).minimized).toBeUndefined()
    maximizeGroup(g2)
    expect(layout().maximizedGroup).toBeNull()
    closeGroup(g2)
    off()
    expect(layout().nodes[g2]).toBeUndefined()
    expect(closed).toEqual([b])
  })

  it('a tab moved out of a maximized group, or a group split off it, shows: the maximize gives way; a reorder keeps it', () => {
    const a = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    const b = openTab({ type: 'file', projectId: 'p', path: 'b.md' })
    const c = openTab({ type: 'file', projectId: 'p', path: 'c.md' })
    const g1 = tabGroupId(layout(), a)
    maximizeGroup(g1)
    placeTab(a, g1, 2)
    expect(layout().maximizedGroup).toBe(g1)
    moveTabToward(b, 'right')
    expect(layout().maximizedGroup).toBeNull()
    expect(tabGroupId(layout(), b)).not.toBe(g1)
    maximizeGroup(g1)
    splitGroup(g1, 'down')
    expect(layout().maximizedGroup).toBeNull()
    expect(groups()).toHaveLength(3)
    undoLayout()
    expect(layout().maximizedGroup).toBe(g1) // one step: the split and the maximize it ended
    expect(tabGroupId(layout(), c)).toBe(g1)
  })

  it('关闭整组 closes the tabs this conversation shows, never another project’s terminal it cannot see', () => {
    const closed: string[] = []
    const off = onTabClosed(tab => closed.push(tab.id))
    setContext({ sessionId: 'a', projectId: 'p' })
    const file = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    const g1 = tabGroupId(layout(), file)
    const other = openTab({ type: 'browser', url: 'http://localhost:1/' }, { target: { edge: 'right', of: g1 } })
    setContext({ sessionId: 'q1', projectId: 'q' })
    const shell = openTab({ type: 'terminal', projectId: 'q', terminalId: 'host-q', title: 'zsh' }, { target: g1 })
    setContext({ sessionId: 'a', projectId: 'p' })
    closeGroup(g1)
    off()
    expect(closed).toEqual([file])
    expect(tabGroupId(layout(), shell)).toBe(tabGroupId(layout(), other))
    undoLayout()
    expect(tabGroupId(layout(), shell)).toBe(g1)
  })

  it('opening the panel with no group left shows the chooser', () => {
    const a = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    closeGroup(tabGroupId(layout(), a))
    expect(groups()).toEqual([])
    expect(currentPane().open).toBe(false)
    togglePanel()
    expect(currentPane().open).toBe(true)
    expect(currentPane().tabs.map(t => t.type)).toEqual(['launcher'])
  })

  it('applies presets as one undo step', () => {
    setViewport({ width: 1400, height: 900 })
    openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    openTab({ type: 'terminal', projectId: 'p' })
    applyPreset('right-stacked')
    const stacked = groups()
    expect(stacked).toHaveLength(2)
    expect(getGroup(layout(), stacked[1]).tabIds.map(id => layout().tabs[id].type)).toEqual(['terminal'])
    applyPreset('bottom')
    expect(getSplit(layout(), layout().root)).toMatchObject({ axis: 'column', children: [MAIN, groups()[0]] })
    undoLayout()
    expect(groups()).toEqual(stacked)
  })
})

describe('undo', () => {
  it('undoes and redoes layout changes; tab bodies’ own updates and focus moves are not steps', () => {
    const a = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    const b = openTab({ type: 'browser', url: 'http://localhost:2/' })
    moveTabToward(b, 'right')
    updateTab(b, { title: 'Page' })
    activateTab(a)
    expect(groups()).toHaveLength(2)
    expect(undoLayout()).toBe(true)
    expect(groups()).toHaveLength(1)
    expect(layout().tabs[b]).toMatchObject({ title: 'Page' })
    expect(redoLayout()).toBe(true)
    expect(groups()).toHaveLength(2)
  })

  it('⌘⇧T reopens the tab closed last; a terminal comes back with a fresh shell', () => {
    const closed: string[] = []
    const off = onTabClosed(tab => closed.push(tab.id))
    const term = openTab({ type: 'terminal', projectId: 'p', terminalId: 'host-1', title: 'zsh' })
    openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    expect(reopenClosedTab()).toBe(false) // the last change opened a tab
    // Nor when the open closed something on its way: undoing it would close the tab just picked.
    const chooser = openLauncher()
    const picked = openTab({ type: 'file', projectId: 'p', path: 'b.md' }, { replace: chooser })
    expect(reopenClosedTab()).toBe(false)
    expect(layout().tabs[picked]).toBeDefined()
    closed.length = 0
    closeTab(term)
    expect(reopenClosedTab()).toBe(true)
    expect(layout().tabs[term]).toMatchObject({ type: 'terminal', terminalId: null, title: null })
    redoLayout()
    off()
    expect(closed).toEqual([term, term])
  })

  it('drops a history that no longer fits the layout instead of breaking it', () => {
    const a = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    // A layout replaced from outside (another reset) leaves the recorded ops pointing at nothing.
    useSidePanel.setState({ layout: { ...layout(), tabs: {}, nodes: { [MAIN]: { kind: 'main' } }, root: MAIN, activeGroup: null, recent: [] } })
    expect(undoLayout()).toBe(false)
    expect(useSidePanel.getState().history.entries).toEqual([])
    expect(findMissing(a)).toBe(true)
  })
})

const findMissing = (id: string) => !(id in layout().tabs)

describe('persistence', () => {
  it('never writes the run 后台任务 was asked to bring into view (a reload must not replay it)', () => {
    openTab({ type: 'tasks', focusRunId: 'p:action:a1' })
    const raw = serializeLayout(layout())
    expect(raw).toContain('"tasks"')
    expect(raw).not.toContain('p:action:a1')
  })

  it('round-trips the layout without transient fields and repairs damage', () => {
    openTab({ type: 'browser', url: 'http://localhost:3000/', key: 'preview:p', reload: 99, device: 'mobile' })
    openTab({ type: 'terminal', projectId: 'p', terminalId: 't1', title: 'zsh' })
    const raw = serializeLayout(layout())
    expect(raw).not.toContain('"reload"')
    const store = { getItem: (key: string) => (key === 'rna.workspace.v2' ? raw : null), setItem() {} }
    const loaded = loadLayout<SideTab>({ parseTab: sanitizeTab, parseV1Tab: sanitizeV1Tab, identity: tabIdentity, mint: k => `${k}-x`, store })
    expect(loaded.source).toBe('v2')
    expect(Object.values(loaded.layout.tabs)).toEqual([
      expect.objectContaining({ type: 'browser', url: 'http://localhost:3000/', key: 'preview:p', device: 'mobile', binding: 'workspace' }),
      expect.objectContaining({ type: 'terminal', projectId: 'p', terminalId: 't1', title: 'zsh' }),
    ])
    expect(loaded.layout.collapsed).toBe(false)

    const broken = JSON.parse(raw)
    const group = Object.keys(broken.windows.main.nodes).find(id => broken.windows.main.nodes[id].kind === 'group')!
    broken.windows.main.tabs.bad = { id: 'bad', type: 'nope' }
    broken.windows.main.nodes[group].tabIds.push('bad', 'ghost')
    const repaired = loadLayout<SideTab>({ parseTab: sanitizeTab, parseV1Tab: sanitizeV1Tab, identity: tabIdentity, mint: k => `${k}-x`, store: { getItem: () => JSON.stringify(broken), setItem() {} } })
    expect(Object.keys(repaired.layout.tabs)).toHaveLength(2)
  })

  it('migrates v1 per-scope strips into one group: overview dropped, conversation tabs bound to their conversation (design 1.6)', () => {
    const v1 = JSON.stringify({
      version: 1,
      panes: {
        's:A': { tabs: [{ id: 'T1', type: 'tool', sessionId: 'A', itemId: 'i' }, { id: 'O1', type: 'overview', sessionId: 'A' }, { id: 'F1', type: 'file', projectId: 'P', path: 'a.md' }], activeId: 'F1', open: true, touched: 300 },
        's:B': { tabs: [{ id: 'B1', type: 'browser', url: 'http://x/', reload: 3 }, { id: 'nope' }], activeId: 'B1', open: false, touched: 100 },
      },
    })
    const store = { getItem: (key: string) => (key === 'rna.sidePanel.v1' ? v1 : null), setItem() {} }
    const { layout: migrated, source } = loadLayout<SideTab>({ parseTab: sanitizeTab, parseV1Tab: sanitizeV1Tab, identity: tabIdentity, mint: k => `${k}-m`, store, width: 1400 })
    expect(source).toBe('v1')
    expect(Object.keys(migrated.tabs).sort()).toEqual(['B1', 'F1', 'T1'])
    expect(migrated.tabs.T1.binding).toEqual({ session: 'A' })
    expect(migrated.tabs.F1.binding).toEqual({ session: 'A' }) // it only showed in A's strip
    expect(migrated.tabs.B1.binding).toEqual({ session: 'B' }) // a page without a key showed only in B's strip
    expect(migrated.collapsed).toBe(false) // A, the scope touched last, was open
    const group = groupIds(migrated)[0]
    expect(getGroup(migrated, group).activeByScope).toEqual({ 's:A': 'F1', 's:B': 'B1' })
    expect(sanitizeV1Tab({ id: 'O', type: 'overview', sessionId: 'A' }, 's:A')).toBeNull()
  })

  it('carries every page without a key over, each staying with the conversation it was open in', () => {
    const pages = (scope: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${scope}-${i}`, type: 'browser', url: `http://localhost:${i + 1}/` }))
    const v1 = JSON.stringify({
      version: 1,
      panes: {
        's:A': { tabs: pages('A', 12), activeId: 'A-11', open: true, touched: 300 },
        's:B': { tabs: pages('B', 10), activeId: 'B-0', open: true, touched: 200 },
        global: { tabs: pages('G', 2), activeId: 'G-0', open: false, touched: 100 },
      },
    })
    const store = { getItem: (key: string) => (key === 'rna.sidePanel.v1' ? v1 : null), setItem() {} }
    const { layout: migrated } = loadLayout<SideTab>({ parseTab: sanitizeTab, parseV1Tab: sanitizeV1Tab, identity: tabIdentity, mergeV1: mergeV1Tab, mint: k => `${k}-m`, store, width: 1400 })
    expect(Object.keys(migrated.tabs)).toHaveLength(24) // was 12: every page bound to the workspace counted against one cap
    expect(migrated.tabs['A-3'].binding).toEqual({ session: 'A' })
    expect(migrated.tabs['B-9'].binding).toEqual({ session: 'B' })
    expect(migrated.tabs['G-1'].binding).toBe('workspace') // the strip outside any conversation showed everywhere
    const group = groupIds(migrated)[0]
    expect(visibleTabs(migrated, group, { sessionId: 'A', projectId: 'P' })).toHaveLength(14) // its 12 and the 2 shown everywhere
    expect(visibleTabs(migrated, group, { sessionId: 'B', projectId: 'P' }).map(tab => tab.id)).not.toContain('A-0')
  })

  it('migrates a tab open in several conversations’ strips as one tab that still shows in each of them', () => {
    const preview = (id: string) => ({ id, type: 'browser', url: 'http://localhost:5173/', key: 'preview:P' })
    const v1 = JSON.stringify({
      version: 1,
      panes: {
        's:A': { tabs: [preview('PA'), { id: 'FA', type: 'file', projectId: 'P', path: 'a.md' }], activeId: 'PA', open: true, touched: 300 },
        's:B': { tabs: [preview('PB'), { id: 'FB', type: 'file', projectId: 'P', path: 'a.md' }, { id: 'GB', type: 'file', projectId: 'P', path: 'b.md' }], activeId: 'FB', open: true, touched: 200 },
      },
    })
    const store = { getItem: (key: string) => (key === 'rna.sidePanel.v1' ? v1 : null), setItem() {} }
    const { layout: migrated } = loadLayout<SideTab>({ parseTab: sanitizeTab, parseV1Tab: sanitizeV1Tab, identity: tabIdentity, mergeV1: mergeV1Tab, mint: k => `${k}-m`, store, width: 1400 })
    expect(Object.keys(migrated.tabs).sort()).toEqual(['FA', 'GB', 'PA'])
    expect(migrated.tabs.PA.binding).toEqual({ project: 'P' }) // open in both strips: shown in both conversations
    expect(migrated.tabs.FA.binding).toEqual({ project: 'P' })
    expect(migrated.tabs.GB.binding).toEqual({ session: 'B' }) // only in B's strip: still only there
    const group = groupIds(migrated)[0]
    expect(getGroup(migrated, group).activeByScope).toEqual({ 's:A': 'PA', 's:B': 'FA' })
    const inB = visibleTabs(migrated, group, { sessionId: 'B', projectId: 'P' }).map(tab => tab.id)
    expect(inB).toEqual(['PA', 'FA', 'GB'])
    expect(activeTab(migrated, group, { sessionId: 'B', projectId: 'P' })?.id).toBe('FA')
  })

  it('writes rna.workspace.v2 after changes', async () => {
    localStorage.removeItem('rna.workspace.v2')
    openTab({ type: 'tool', sessionId: 's', itemId: 'i' })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(localStorage.getItem('rna.workspace.v2')).toContain('"tool"')
    openTab({ type: 'file', projectId: 'p', path: 'z.md' })
    flushLayout()
    expect(localStorage.getItem('rna.workspace.v2')).toContain('z.md')
  })
})

it('the tab menu closes the tabs to the left, to the right, or all of them', () => {
  resetSidePanel()
  const ids = ['a.md', 'b.md', 'c.md', 'd.md'].map(path => openTab({ type: 'file', projectId: 'p', path }))
  activateTab(ids[0]!)
  const closed: string[] = []; const off = onTabClosed(tab => closed.push(tab.id))
  closeTabsBeside(ids[2]!, 'left')
  expect(currentPane().tabs.map(tab => tab.id)).toEqual([ids[2], ids[3]])
  expect(currentPane().activeId).toBe(ids[2]) // the active tab was closed: the one clicked takes over
  closeTabsBeside(ids[2]!, 'right')
  expect(currentPane().tabs.map(tab => tab.id)).toEqual([ids[2]])
  closeTabsBeside(ids[2]!, 'right') // nothing to the right: no change
  expect(currentPane().tabs).toHaveLength(1)
  closeTabsBeside(ids[2]!, 'all')
  expect(currentPane().tabs).toEqual([]); expect(currentPane().activeId).toBe(null)
  expect(closed.sort()).toEqual([...ids].sort())
  off()
})

it('keeps every geometry computable after a session of operations', () => {
  setViewport({ width: 1200, height: 800 })
  const a = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
  const t = openTab({ type: 'terminal', projectId: 'p' }, { target: { edge: 'bottom', of: MAIN } })
  splitGroup(tabGroupId(layout(), a), 'down')
  moveTabToward(t, 'top')
  applyPreset('fill')
  const geometry = computeRects(layout() as LayoutState, { width: 1200, height: 800 })
  expect(geometry.rects[MAIN].width).toBeGreaterThanOrEqual(420)
  for (const id of groups()) expect(geometry.rects[id] ?? geometry.squeezed.includes(id)).toBeTruthy()
})

it('drops a divider drag whose split went away meanwhile', () => {
  setViewport({ width: 1200, height: 800 })
  const a = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
  const geometry = computeRects(layout() as LayoutState, { width: 1200, height: 800 })
  const divider = geometry.dividers[0]
  closeGroup(tabGroupId(layout(), a))
  const before = layout()
  resizeDivider(geometry, divider, -40)
  expect(layout()).toBe(before)
})

it('the merged strip closes among the tabs it shows, across groups', () => {
  resetSidePanel()
  setContext({ sessionId: 's', projectId: 'p' })
  const a = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
  const b = openTab({ type: 'file', projectId: 'p', path: 'b.md' })
  const c = openTab({ type: 'tool', sessionId: 's', itemId: 'i' }, { target: { edge: 'bottom', of: tabGroupId(layout(), a) } })
  const listed = currentPane().tabs.map(tab => tab.id)
  expect(listed).toEqual([a, b, c])
  closeAmongTabs(b, 'right', listed, c)
  expect(currentPane().tabs.map(tab => tab.id)).toEqual([a, b])
  expect(currentPane().activeId).toBe(b) // the shown tab closed: the one picked takes over
  closeAmongTabs(b, 'others', [a, b], b)
  expect(currentPane().tabs.map(tab => tab.id)).toEqual([b])
})

it('says whether a tab is on screen: drawn group, the tab it shows, the phone sheet', () => {
  resetSidePanel()
  setContext({ sessionId: 's', projectId: 'p' })
  const view = () => useSidePanel.getState()
  const a = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
  const g1 = tabGroupId(layout(), a)
  const b = openTab({ type: 'file', projectId: 'p', path: 'b.md' }, { target: { edge: 'right', of: g1 } })
  const c = openTab({ type: 'file', projectId: 'p', path: 'c.md' }, { target: { edge: 'right', of: tabGroupId(layout(), b) } })
  expect(tabOnScreen(a, view())).toBe(true) // no size known yet: only minimize and maximize count
  setViewport({ width: 1040, height: 800 }) // 420 + 3 × 260 (plus the gaps between cards) > 1040: the oldest group (a's) is squeezed
  expect(tabOnScreen(a, view())).toBe(false)
  expect([b, c].map(id => tabOnScreen(id, view()))).toEqual([true, true])
  setViewport({ width: 600, height: 800 }) // too narrow for two: only the focused group, over the conversation
  expect([a, b, c].map(id => tabOnScreen(id, view()))).toEqual([false, false, true])
  setSheet(true) // the phone sheet shows the focused group's tab
  expect([a, b, c].map(id => tabOnScreen(id, view()))).toEqual([false, false, true])
  activateTab(a)
  expect([a, b, c].map(id => tabOnScreen(id, view()))).toEqual([true, false, false])
  setPanelOpen(false)
  expect(tabOnScreen(a, view())).toBe(false)
})
