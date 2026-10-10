import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { getTransport, setTransport } from '@/api/client'
import type { Transport } from '@/api/transport'
import type { ProjectSummary } from '@/api/types'
import { tabGroupId } from '@/lib/dock'
import { useApp } from '@/store/app-store'
import { useUi } from '@/store/ui-store'
import {
  findTab, listSavedLayouts, openLauncher, openTab, resetSidePanel, saveLayout, setContext, setViewport, useSidePanel, type SideTab,
} from '@/store/side-panel-store'
import { MAX_SAVED_LAYOUTS } from '@/store/layout-persist'
import { resetGitStatus } from '@/lib/workspace-changes'
import { resetSurfaceRouter } from '@/store/surface-router'
import { Launcher } from '@/components/side-panel/Launcher'
import { openFromTasks } from './tasks-panel'
import { GroupStrip } from './GroupStrip'
import { groupActions, type LayoutAction, type MenuEntry } from './menus'
import { SaveLayoutDialog, suggestLayoutName } from './SaveLayoutDialog'
import { openWorktree, worktreeTab } from './worktree-open'
import { getPanel } from './registry'
import './panels'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
MotionGlobalConfig.skipAnimations = true

const transport: Transport = {
  kind: 'live',
  async request<T>(path: string): Promise<T> {
    if (path.includes('/git')) return { repo: 'none', branch: null, detached: false, upstream: null, ahead: 0, behind: 0, operation: null, files: { conflicted: [], staged: [], unstaged: [], untracked: [] } } as T
    if (path.includes('/preview')) return { status: 'stopped' } as T
    return { path: '', entries: [] } as T
  },
  openStream() { throw new Error('unused') },
}
const project = (id: string, patch: Partial<ProjectSummary> = {}) => ({ id, name: id, workspacePath: `/w/${id}`, ...patch }) as ProjectSummary

let root: Root, host: HTMLDivElement, previous: Transport
beforeEach(() => {
  previous = getTransport(); setTransport(transport)
  resetSidePanel(); resetGitStatus(); resetSurfaceRouter()
  useApp.setState({
    status: 'ready', projectOrder: ['p1', 'p2'], selectedSessionId: 's1', selectedProjectId: 'p1', sessions: {},
    projects: { p1: project('p1', { backgroundChanges: [{ id: 'bg-1', actionId: 'a1', at: new Date().toISOString(), status: 'kept', count: 1, paths: ['lib/k.ts'] }] }), p2: project('p2') },
    sessionIndex: { s1: { id: 's1', title: 'S', status: 'idle', projectId: 'p1' } } as never,
  })
  setContext({ sessionId: 's1', projectId: 'p1' })
  setViewport({ width: 1400, height: 900 })
  useUi.setState({ toasts: [] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); setTransport(previous) })

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const show = async (node: ReactNode) => { await act(async () => { root.render(createElement(Tooltip.Provider, null, node)) }); await flush() }
const layout = () => useSidePanel.getState().layout
const tabsOf = (type: SideTab['type']) => Object.values(layout().tabs).filter(tab => tab.type === type)
const submenu = (entries: MenuEntry[], key: string) => (entries.find(entry => entry !== 'separator' && entry.key === key) as LayoutAction).items!
const keys = (entries: MenuEntry[]) => entries.map(entry => (entry === 'separator' ? '—' : entry.key))
const lastToast = () => useUi.getState().toasts.at(-1)

describe('布局 menu: saved layouts (design 1.3 item 3)', () => {
  it('lists the saved layouts to apply, saving the current one, and a submenu to delete one with undo', () => {
    const tasks = openTab({ type: 'tasks' })
    const group = tabGroupId(layout(), tasks)
    let asked = 0
    const menu = (saved = listSavedLayouts()) => submenu(groupActions({ groupId: group, maximized: false, canUndo: false, canRedo: false, saved, onSaveLayout: () => { asked += 1 } }), 'layout')
    expect(keys(menu())).toEqual(['preset-sidebar', 'preset-bottom', 'preset-right-stacked', 'preset-three-column', 'preset-fill', '—', 'save-layout'])
    ;(menu().at(-1) as LayoutAction).run!()
    expect(asked).toBe(1)

    const { id } = saveLayout('写作')!
    const entries = menu()
    expect(keys(entries)).toEqual(['preset-sidebar', 'preset-bottom', 'preset-right-stacked', 'preset-three-column', 'preset-fill', '—', `saved-${id}`, '—', 'save-layout', 'delete-layout'])
    const cursor = useSidePanel.getState().history.cursor
    ;(entries[6] as LayoutAction).run!()
    expect(useSidePanel.getState().history.cursor).toBe(cursor + 1)

    const remove = submenu(entries, 'delete-layout')[0] as LayoutAction
    expect(remove.label).toBe('写作')
    remove.run!()
    expect(listSavedLayouts()).toEqual([])
    expect(lastToast()?.text).toBe('已删除布局「写作」。')
    lastToast()!.action!.run()
    expect(listSavedLayouts().map(layout => layout.id)).toEqual([id])
  })

  it('a saved layout that cannot be applied says so', () => {
    const tasks = openTab({ type: 'tasks' })
    const group = tabGroupId(layout(), tasks)
    const { id } = saveLayout('坏的')!
    const saved = listSavedLayouts()
    useSidePanel.setState({ presets: {} })
    ;(submenu(groupActions({ groupId: group, maximized: false, canUndo: false, canRedo: false, saved, onSaveLayout: () => {} }), 'layout').find(entry => entry !== 'separator' && entry.key === `saved-${id}`) as LayoutAction).run!()
    expect(lastToast()).toMatchObject({ text: '这个布局没能应用。', tone: 'danger' })
  })

  it('the group menu’s 保存当前布局… asks for a name and saves under it', async () => {
    const tab = openTab({ type: 'tasks' })
    const group = tabGroupId(layout(), tab)
    await show(createElement(GroupStrip, { groupId: group, tabs: [findTab(tab)!], activeId: tab, focused: true, multi: false, edge: 'right', maximized: false, overlay: false, mobile: false }))
    await act(async () => { host.querySelector(`[data-group-menu="${group}"]`)!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })) })
    const layoutItem = document.querySelector<HTMLElement>('[data-action="layout"]')!
    await act(async () => { layoutItem.focus(); layoutItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    await flush()
    await act(async () => { document.querySelector<HTMLElement>('[data-action="save-layout"]')!.click() })
    await flush()
    const input = document.querySelector<HTMLInputElement>('[data-save-layout] input')!
    expect(input.value).toBe('布局 1')
    await act(async () => { document.querySelector<HTMLFormElement>('[data-save-layout]')!.requestSubmit() })
    await flush()
    expect(listSavedLayouts().map(layout => layout.name)).toEqual(['布局 1'])
    expect(lastToast()?.text).toBe('已保存布局「布局 1」。')
    expect(document.querySelector('[data-save-layout]')).toBeNull()
  })
})

describe('the name dialog', () => {
  const type = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]

  it('suggests the next free name, says when a name replaces a saved layout, and stops at the limit', async () => {
    openTab({ type: 'tasks' })
    saveLayout('布局 2')
    expect(suggestLayoutName(listSavedLayouts())).toBe('布局 3')
    saveLayout('布局 3')
    expect(suggestLayoutName(listSavedLayouts())).toBe('布局 4')
    let open = true
    await show(createElement(SaveLayoutDialog, { open: true, onOpenChange: next => { open = next } }))
    const input = document.querySelector<HTMLInputElement>('[data-save-layout] input')!
    await type(input, '布局 2')
    expect(document.querySelector('[data-save-layout] [role="status"]')!.textContent).toBe('已有同名的布局，保存会替换它。')
    await act(async () => { buttons().find(button => button.textContent === '替换')!.click() })
    expect(listSavedLayouts().map(layout => layout.name)).toEqual(['布局 2', '布局 3'])
    expect(open).toBe(false)

    while (listSavedLayouts().length < MAX_SAVED_LAYOUTS) saveLayout(`更多 ${listSavedLayouts().length}`)
    await show(createElement(SaveLayoutDialog, { open: false, onOpenChange: () => {} }))
    await show(createElement(SaveLayoutDialog, { open: true, onOpenChange: () => {} }))
    expect(document.querySelector('[data-save-layout] [role="status"]')!.textContent).toBe('最多保存 20 个布局。先删除一个不用的，再保存新的。')
    expect(buttons().find(button => button.textContent === '保存')!.disabled).toBe(true)
    await type(document.querySelector<HTMLInputElement>('[data-save-layout] input')!, '布局 3')
    expect(buttons().find(button => button.textContent === '替换')!.disabled).toBe(false)
  })
})

describe('工作区改动 entry points', () => {
  it('the launcher card opens the changes panel following the project, or brings up the one already showing it', async () => {
    const chooser = openLauncher()
    await show(createElement(Launcher, { tabId: chooser, sessionId: 's1', projectId: 'p1' }))
    const card = host.querySelector<HTMLButtonElement>('[data-launcher="worktree"]')!
    expect(card.textContent).toContain('工作区改动')
    await act(async () => { card.click() })
    expect(findTab(chooser)).toBeUndefined()
    expect(tabsOf('worktree')).toEqual([expect.objectContaining({ projectId: null, binding: 'workspace' })])

    const following = tabsOf('worktree')[0].id
    expect(openWorktree(null)).toBe(following)
    // Another project gets a panel bound to it, brought up (with the source asked for) instead of a second one.
    expect(worktreeTab('p2')).toBeNull()
    const bound = openWorktree('p2')
    expect(findTab(bound)).toMatchObject({ projectId: 'p2' })
    expect(openWorktree('p2', { source: 'rna' })).toBe(bound)
    expect(findTab(bound)).toMatchObject({ source: 'rna' })
    expect(tabsOf('worktree')).toHaveLength(2)

    await show(createElement(Launcher, { tabId: null, sessionId: null, projectId: null }))
    expect(host.querySelector<HTMLButtonElement>('[data-launcher="worktree"]')!.disabled).toBe(true)
  })

  it('本次任务 opens a change set beside the changes panel, the same tab the 后台任务 panel’s 改动 opens', async () => {
    // 本次对话的改动 stacks its diffs in a virtual list: the scroll boxes get a size so its sections (and labels) draw.
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return this.matches('[data-stacked-diff], [data-change-tree]') ? 600 : 0 } })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const h = this.matches('[data-stacked-diff], [data-change-tree]') ? 600 : 0
      return { x: 0, y: 0, top: 0, left: 0, right: 900, bottom: h, width: 900, height: h, toJSON: () => ({}) } as DOMRect
    })
    try { await changeSetReview() } finally { if (height) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height); vi.restoreAllMocks() }
  })

  async function changeSetReview() {
    const changes = openTab({ type: 'worktree', projectId: null })
    const group = tabGroupId(layout(), changes)
    await show(getPanel('worktree')!.render(findTab(changes)!, { sessionId: 's1', projectId: 'p1', visible: true, groupId: group }))
    const set = host.querySelector('[data-change-set="bg-1"]')!
    await act(async () => { [...set.querySelectorAll('button')].find(button => button.textContent === '审阅')!.click() })
    const [review] = tabsOf('change-review')
    expect(review).toMatchObject({ projectId: 'p1', changeId: 'bg-1' })
    expect(tabGroupId(layout(), review.id)).not.toBe(group)
    expect(tabGroupId(layout(), changes)).toBe(group)

    // The 后台任务 panel's 改动 for that run brings the same tab up rather than a second one.
    openTab({ type: 'tasks' }, { target: group })
    openFromTasks('change', { projectId: 'p1', changeId: 'bg-1' })
    expect(tabsOf('change-review')).toHaveLength(1)
    expect(useSidePanel.getState().layout.activeGroup).toBe(tabGroupId(layout(), review.id))
  }

  it('“show in Files” from a changed file goes through the surface router: beside the changes, or to the Files panel already open', async () => {
    const { revealInFiles } = await import('@/components/panels/worktree/FileMenu')
    const changes = openTab({ type: 'worktree', projectId: null })
    revealInFiles('p1', 'src/app.ts')
    const [files] = tabsOf('files')
    expect(files).toMatchObject({ projectId: null, path: 'src/app.ts' })
    expect(tabGroupId(layout(), files.id)).not.toBe(tabGroupId(layout(), changes))
    revealInFiles('p1', 'docs/')
    expect(tabsOf('files')).toEqual([expect.objectContaining({ id: files.id, path: 'docs' })])
  })
})
