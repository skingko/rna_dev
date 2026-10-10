import { beforeEach, describe, expect, it } from 'vitest'
import { getGroup, getSplit, groupIds, layoutProblems, MAIN, tabGroupId } from '@/lib/dock'
import { LAYOUT_NAME_MAX, loadLayout, MAX_SAVED_LAYOUTS, parseSavedLayout, savedLayouts, WORKSPACE_KEY } from './layout-persist'
import {
  applyPreset, applySavedLayout, closeTab, deleteSavedLayout, flushLayout, listSavedLayouts, mergeV1Tab, moveTabToward, onTabPicked, openTab, resetSidePanel,
  restoreSavedLayout, sanitizeTab, sanitizeV1Tab, saveLayout, setContext, setViewport, tabIdentity, undoLayout, useSidePanel, type SideTab,
} from './side-panel-store'

beforeEach(() => {
  resetSidePanel()
  setViewport({ width: 1400, height: 900 })
  setContext({ sessionId: 's1', projectId: 'p1' })
})

const layout = () => useSidePanel.getState().layout
const groups = () => groupIds(layout())
const typesIn = (groupId: string) => getGroup(layout(), groupId).tabIds.map(id => layout().tabs[id].type)
const groupOf = (tabId: string) => tabGroupId(layout(), tabId)
const ofType = (type: string) => Object.values(layout().tabs).filter(tab => tab.type === type)

describe('saved layouts (design 1.3 item 3)', () => {
  it('bring the saved shape back as one undo step, every open tab where its kind was', () => {
    const tasks = openTab({ type: 'tasks' })
    const files = openTab({ type: 'files', projectId: null })
    applyPreset('three-column')
    expect(typesIn(groups()[0])).toEqual(['files'])
    const saved = saveLayout('写作')!
    expect(saved).toMatchObject({ replaced: false })
    expect(listSavedLayouts().map(entry => entry.name)).toEqual(['写作'])

    applyPreset('sidebar')
    const terminal = openTab({ type: 'terminal', projectId: 'p1' })
    expect(groups()).toHaveLength(1)
    const [kept] = groups()
    const before = layout()
    expect(applySavedLayout(saved.id)).toBe(true)
    expect(layoutProblems(layout(), true)).toEqual([])
    expect(getSplit(layout(), layout().root).children).toEqual([groupOf(files), MAIN, groupOf(tasks)])
    // The terminal's kind was nowhere in the saved layout: it goes to the largest group.
    expect(groupOf(terminal)).toBe(groupOf(tasks))
    // An open group keeps its id, so focus and per-conversation choices carry over.
    expect(groups()).toContain(kept)
    expect(layout().collapsed).toBe(false)
    undoLayout()
    expect(layout()).toEqual(before)
  })

  it('open the panels they had that are missing, never twice, and give a group left empty the chooser', () => {
    const tasks = openTab({ type: 'tasks' })
    const worktree = openTab({ type: 'worktree', projectId: null, source: 'rna' })
    moveTabToward(worktree, 'bottom')
    const browser = openTab({ type: 'browser', url: 'http://localhost:3/' }, { target: { edge: 'right', of: groupOf(tasks) } })
    expect(groups()).toHaveLength(3)
    const saved = saveLayout('审阅')!
    closeTab(worktree); closeTab(browser)
    const review = openTab({ type: 'review', sessionId: 's1' })
    const picked: string[] = []
    const off = onTabPicked(tab => picked.push(tab.type))
    try { expect(applySavedLayout(saved.id)).toBe(true) } finally { off() }
    expect(groups()).toHaveLength(3)
    expect(ofType('tasks')).toHaveLength(1)
    const reopened = ofType('worktree')
    expect(reopened).toHaveLength(1)
    // The old `source` it was opened with comes back as the comparison it stood for (worktree design §7): 本次任务 was
    // the old default, so the default comparison.
    expect(reopened[0]).toMatchObject({ projectId: null, mode: null, binding: 'workspace' })
    expect(reopened[0]).not.toHaveProperty('source')
    expect(groupOf(reopened[0].id)).not.toBe(groupOf(tasks))
    expect(picked).toEqual(['worktree'])
    // The browser is content, not a panel: its group gets the chooser instead.
    const empty = groups().find(id => typesIn(id).includes('launcher'))!
    expect(typesIn(empty)).toEqual(['launcher'])
    expect(groupOf(review)).not.toBe(empty)
    expect(layoutProblems(layout(), true)).toEqual([])
  })

  it('a reusable tab goes back to the very group that held it, others of its kind to the first group that had that kind', () => {
    const page = openTab({ type: 'browser', url: 'http://localhost:1/' })
    const preview = openTab({ type: 'browser', url: 'http://127.0.0.1:5173/', key: 'preview:p1' })
    moveTabToward(preview, 'bottom')
    const saved = saveLayout('预览')!
    applyPreset('sidebar')
    const other = openTab({ type: 'browser', url: 'http://localhost:2/' })
    applySavedLayout(saved.id)
    const stack = getSplit(layout(), getSplit(layout(), layout().root).children[1])
    expect(stack.axis).toBe('column')
    expect(groupOf(preview)).toBe(stack.children[1])
    expect(groupOf(page)).toBe(stack.children[0])
    expect(groupOf(other)).toBe(stack.children[0])
  })

  it('saving under a name already used replaces that layout in place; names are trimmed; at most 20 are kept', () => {
    const tasks = openTab({ type: 'tasks' })
    const a = saveLayout('布局 A')!
    saveLayout('布局 B')
    moveTabToward(openTab({ type: 'files', projectId: null }), 'bottom')
    expect(saveLayout('  布局 a ')).toEqual({ id: a.id, replaced: true })
    expect(listSavedLayouts().map(entry => entry.name)).toEqual(['布局 a', '布局 B'])
    expect(Object.values(listSavedLayouts()[0].nodes).filter(node => node.kind === 'group')).toHaveLength(2)
    expect(saveLayout('   ')).toBeNull()
    expect(saveLayout('x'.repeat(80))!.id).toBeTruthy()
    expect(listSavedLayouts().at(-1)!.name).toHaveLength(LAYOUT_NAME_MAX)
    while (listSavedLayouts().length < MAX_SAVED_LAYOUTS) saveLayout(`更多 ${listSavedLayouts().length}`)
    expect(saveLayout('再多一个')).toBeNull()
    expect(saveLayout('布局 B')).toMatchObject({ replaced: true })
    closeTab(tasks)
  })

  it('are kept in rna.workspace.v2’s presets with whatever this version cannot read; a delete can be undone', () => {
    localStorage.removeItem(WORKSPACE_KEY)
    openTab({ type: 'tasks' })
    const { id } = saveLayout('晨间')!
    useSidePanel.setState(s => ({ presets: { ...s.presets, later: { version: 9, name: '新格式' } } }))
    flushLayout()
    const stored = JSON.parse(localStorage.getItem(WORKSPACE_KEY)!) as { presets: Record<string, unknown> }
    expect(stored.presets[id]).toMatchObject({ version: 1, name: '晨间' })
    expect(stored.presets.later).toEqual({ version: 9, name: '新格式' })
    const loaded = loadLayout<SideTab>({ parseTab: sanitizeTab, parseV1Tab: sanitizeV1Tab, identity: tabIdentity, mergeV1: mergeV1Tab, mint: kind => `${kind}-x` })
    expect(savedLayouts(loaded.presets).map(entry => [entry.id, entry.name])).toEqual([[id, '晨间']])

    const removed = deleteSavedLayout(id)
    expect(listSavedLayouts()).toEqual([])
    expect(deleteSavedLayout(id)).toBeUndefined()
    expect(applySavedLayout(id)).toBe(false)
    restoreSavedLayout(id, removed)
    expect(listSavedLayouts().map(entry => entry.name)).toEqual(['晨间'])
    expect(useSidePanel.getState().presets.later).toEqual({ version: 9, name: '新格式' })
  })

  it('only well-formed entries are listed; sizes are normalized', () => {
    const group = { kind: 'group', types: ['tasks'], keys: ['tasks'], panels: [{ type: 'tasks' }] }
    const good = { version: 1, name: ' 好 ', savedAt: 3, root: 's', nodes: { s: { kind: 'split', axis: 'row', children: ['main', 'g'], sizes: [3, 1] }, main: { kind: 'main' }, g: group } }
    expect(parseSavedLayout('id', good)).toMatchObject({ id: 'id', name: '好', savedAt: 3, nodes: { s: { sizes: [0.75, 0.25] } } })
    const broken = [
      { ...good, version: 2 },
      { ...good, name: ' ' },
      { ...good, nodes: { ...good.nodes, main: undefined } },
      { ...good, nodes: { ...good.nodes, s: { kind: 'split', axis: 'row', children: ['main'], sizes: [1] } } },
      { ...good, nodes: { ...good.nodes, s: { kind: 'split', axis: 'row', children: ['main', 'g'], sizes: [1] } } },
      { ...good, nodes: { ...good.nodes, s: { kind: 'split', axis: 'row', children: ['main', 's'], sizes: [1, 1] } } },
      { ...good, root: 'main', nodes: { main: { kind: 'main' } } },
      { ...good, nodes: { ...good.nodes, s: { kind: 'split', axis: 'row', children: ['main', 'g', 'h'], sizes: [1, 1, 1] }, h: { kind: 'main' } } },
    ]
    for (const value of broken) expect(parseSavedLayout('id', value)).toBeNull()
    expect(savedLayouts({ a: good, b: broken[0], c: { ...good, savedAt: 1, name: '早' } }).map(entry => entry.name)).toEqual(['早', '好'])
  })
})
