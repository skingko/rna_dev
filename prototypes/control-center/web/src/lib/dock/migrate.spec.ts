import { describe, expect, it } from 'vitest'
import { MAIN, type Binding, type LayoutState, type ScopeKey } from './types'
import { applyOps } from './operations'
import { counterMint, getGroup, getSplit, groupIds, layoutProblems } from './tree'
import { defaultLayout, migrateV1, persistLayout, sanitizeLayout, type MigrateOptions } from './migrate'
import { shareOf } from './geometry'
import { sound, startLayout, tab, type TestTab } from './testing'

interface V1Tab extends TestTab { sessionId?: string; projectId?: string; path?: string; itemId?: string; reload?: number }

/** A stand-in for today's sanitizeTab plus the v2 binding (design 1.1). */
function parseTab(value: unknown, scope?: ScopeKey): V1Tab | null {
  const raw = value as Partial<V1Tab> | null
  if (!raw || typeof raw.id !== 'string' || typeof raw.type !== 'string') return null
  let binding: Binding
  switch (raw.type) {
    case 'launcher': case 'browser': binding = 'workspace'; break
    case 'tool': if (!raw.sessionId) return null; binding = { session: raw.sessionId }; break
    case 'file': if (!raw.projectId) return null; binding = { project: raw.projectId }; break
    default: return null // retired or unknown types (overview) are dropped
  }
  void scope
  const { reload: _reload, ...rest } = raw
  void _reload
  return { ...rest, binding } as V1Tab
}

const identity = (t: V1Tab) =>
  t.type === 'launcher' ? 'launcher' : t.type === 'tool' ? `tool:${t.sessionId}:${t.itemId}` : t.type === 'file' ? `file:${t.projectId}:${t.path}` : null

const options = (extra: Partial<MigrateOptions<V1Tab>> = {}): MigrateOptions<V1Tab> =>
  ({ parseTab, identity, scope: 's:A', mint: counterMint(), dockWidth: 460, width: 1440, ...extra })

const v1 = JSON.stringify({
  version: 1,
  panes: {
    's:A': {
      tabs: [
        { id: 'L1', type: 'launcher' },
        { id: 'T1', type: 'tool', sessionId: 'A', itemId: 'i1' },
        { id: 'F1', type: 'file', projectId: 'P', path: 'a.ts' },
        { id: 'B1', type: 'browser', url: 'http://x', reload: 4 },
        { id: 'O1', type: 'overview', sessionId: 'A' },
      ],
      activeId: 'T1', open: true, touched: 200,
    },
    's:B': {
      tabs: [
        { id: 'L2', type: 'launcher' },
        { id: 'T2', type: 'tool', sessionId: 'B', itemId: 'i2' },
        { id: 'F2', type: 'file', projectId: 'P', path: 'a.ts' },
        {},
        'junk',
      ],
      activeId: 'gone', open: false, touched: 300,
    },
    global: { tabs: 'nope' },
    'p:P': null,
  },
})

describe('v1 → v2 migration', () => {
  it('folds every scope into one right-hand group, newest scope first, deduped by identity', () => {
    const state = migrateV1(v1, options())
    const group = groupIds(state)[0]
    const root = getSplit(state, state.root)
    expect(root.children).toEqual([MAIN, group])
    expect(root.sizes[1]).toBeCloseTo(shareOf(460, 1440))
    expect(getGroup(state, group).tabIds).toEqual(['L2', 'T2', 'F2', 'T1', 'B1'])
    expect(getGroup(state, group).activeByScope).toEqual({ 's:B': 'F2', 's:A': 'T1' })
    expect(state.tabs.B1).toEqual({ id: 'B1', type: 'browser', url: 'http://x', binding: 'workspace' })
    expect(state.tabs.O1).toBeUndefined()
    expect(state.collapsed).toBe(false)
    expect(state.maximizedGroup).toBeNull()
    sound(state)
  })

  it('maps an active tab that was merged away to the tab that kept its identity', () => {
    const raw = JSON.stringify({ panes: { 's:A': { tabs: [{ id: 'F1', type: 'file', projectId: 'P', path: 'a.ts' }], activeId: 'F1', touched: 1 }, 's:B': { tabs: [{ id: 'F2', type: 'file', projectId: 'P', path: 'a.ts' }], activeId: 'F2', touched: 2 } } })
    const state = migrateV1(raw, options())
    expect(getGroup(state, groupIds(state)[0]).activeByScope).toEqual({ 's:B': 'F2', 's:A': 'F2' })
  })

  it('lets the caller merge a tab seen again in another scope into the one kept', () => {
    const raw = JSON.stringify({ panes: { 's:A': { tabs: [{ id: 'F1', type: 'file', projectId: 'P', path: 'a.ts' }], touched: 1 }, 's:B': { tabs: [{ id: 'F2', type: 'file', projectId: 'P', path: 'a.ts', note: 'b' }], touched: 2 } } })
    const merged = migrateV1(raw, options({ merge: (kept, duplicate) => ({ ...kept, seen: `${(kept as { note?: string }).note ?? '-'}+${(duplicate as { id: string }).id}` }) as V1Tab }))
    expect(Object.keys(merged.tabs)).toEqual(['F2'])
    expect(merged.tabs.F2).toMatchObject({ id: 'F2', seen: 'b+F1' })
  })

  it('takes collapsed from the current scope only', () => {
    expect(migrateV1(v1, options({ scope: 's:B' })).collapsed).toBe(true)
    expect(migrateV1(v1, options({ scope: 's:none' })).collapsed).toBe(true)
  })

  it('caps tabs per scope as v1 did, and workspace-bound tabs across scopes', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ id: `b${i}`, type: 'browser', url: `http://${i}` }))
    const raw = JSON.stringify({ panes: { 's:A': { tabs: many, touched: 2 }, 's:B': { tabs: [{ id: 'z', type: 'browser', url: 'http://z' }], touched: 1 } } })
    expect(Object.keys(migrateV1(raw, options()).tabs)).toHaveLength(12)
    expect(Object.keys(migrateV1(raw, options({ maxShared: 3 })).tabs)).toEqual(['b0', 'b1', 'b2'])
  })

  it('anything unreadable gives the default layout', () => {
    for (const raw of [null, '', '{', '[]', '{"panes":3}', 'null']) {
      const state = migrateV1(raw, options())
      expect(Object.keys(state.tabs)).toEqual([])
      expect(groupIds(state)).toHaveLength(1)
      expect(state.collapsed).toBe(true)
      expect(layoutProblems(state)).toEqual([])
    }
  })
})

describe('sanitizing persisted v2', () => {
  const fallback = () => defaultLayout<V1Tab>(counterMint('f-'), 0.3)
  const sanitize = (value: unknown) => sanitizeLayout(value, { parseTab: v => parseTab(v), fallback })

  function saved(): LayoutState<V1Tab> {
    const state = startLayout() as LayoutState<V1Tab>
    const group = groupIds(state)[0]
    return applyOps(state, [
      { type: 'openTab', groupId: group, tab: { ...tab('T1', 'tool', { session: 'A' }), sessionId: 'A', itemId: 'i' }, index: 0, scope: 's:A' },
      { type: 'openTab', groupId: group, tab: { ...tab('L', 'launcher') }, index: 1, scope: 's:B' },
      { type: 'setMinimized', groupId: group, minimized: true },
      { type: 'setMaximized', groupId: group },
    ]).state
  }

  it('keeps a sound layout (minus the maximize) through JSON', () => {
    const state = saved()
    const back = sanitize(JSON.parse(JSON.stringify(persistLayout(state))))
    expect(back).toEqual({ ...state, maximizedGroup: null })
  })

  it('repairs dangling children, one-child splits, bad sizes, bad tabs and stale focus', () => {
    const state = saved()
    const group = groupIds(state)[0]
    const raw = JSON.parse(JSON.stringify(state))
    raw.root = 'outer'
    raw.nodes.outer = { kind: 'split', axis: 'column', children: [state.root, 'ghost'], sizes: [1] }
    raw.nodes[state.root].sizes = [0, 'x']
    raw.nodes.junk = { kind: 'weird' }
    raw.tabs.T1.type = 'mystery'
    raw.nodes[group].tabIds.push('nope', 'L')
    raw.activeGroup = 'gone'
    raw.recent = ['gone', group, group]
    const back = sanitize(raw)
    expect(back.root).toBe(state.root)
    expect(getSplit(back, back.root).sizes).toEqual([0.5, 0.5])
    expect(getGroup(back, group).tabIds).toEqual(['L'])
    expect(getGroup(back, group).activeByScope).toEqual({ 's:B': 'L' })
    expect(back.tabs.T1).toBeUndefined()
    expect(back.recent).toEqual([group])
    expect(back.activeGroup).toBe(group)
    expect(back.maximizedGroup).toBeNull()
    expect(layoutProblems(back)).toEqual([])
  })

  it('a tree without main, with a second main, or with an orphaned group falls back, keeping the tabs', () => {
    const state = saved()
    const group = groupIds(state)[0]
    const noMain = JSON.parse(JSON.stringify(state))
    delete noMain.nodes[MAIN]
    const twoMains = JSON.parse(JSON.stringify(state))
    twoMains.nodes.other = { kind: 'main' }
    const orphan = JSON.parse(JSON.stringify(state))
    orphan.root = MAIN
    for (const raw of [noMain, twoMains, orphan]) {
      const back = sanitize(raw)
      expect(back.root).toBe(fallback().root)
      expect(Object.keys(back.tabs).sort()).toEqual(['L', 'T1'])
      expect(getGroup(back, groupIds(back)[0]).tabIds.sort()).toEqual(['L', 'T1'])
      expect(layoutProblems(back)).toEqual([])
    }
    expect(group).toBeTruthy()
  })

  it('rejects other versions and shapes', () => {
    for (const raw of [null, 3, [], { version: 1 }, { version: 2, root: 'r' }, { version: 2, nodes: {}, root: 5 }]) {
      expect(sanitize(raw)).toEqual(fallback())
    }
  })

  it('persistLayout drops the maximize and transient tab fields', () => {
    const state = applyOps(saved(), [{ type: 'updateTab', tab: { ...tab('L', 'launcher'), reload: 9 } as V1Tab }]).state
    const written = persistLayout(state, t => { const { reload: _r, ...rest } = t; void _r; return rest as V1Tab })
    expect(written.maximizedGroup).toBeNull()
    expect('reload' in written.tabs.L).toBe(false)
    expect(state.maximizedGroup).not.toBeNull()
  })
})
