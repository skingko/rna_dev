import { beforeEach, describe, expect, it } from 'vitest'
import { setTransport } from '@/api/client'
import { ApiError, type EventSourceLike, type Transport } from '@/api/transport'
import { activeTab, tabGroupId } from '@/lib/dock'
import { useApp } from './app-store'
import { useUi } from './ui-store'
import { findTab, openTab, resetSidePanel, splitGroup, tabOnScreen, useSidePanel } from './side-panel-store'
import {
  notePageSelection, notePanelSelection, openSurface, PREF_KEY, resetSurfaceRouter, setSurfacePreference, showInMainView, surfacePanel, useSurfaceRouter,
} from './surface-router'

const silent: EventSourceLike = { readyState: 1, onopen: null, onerror: null, addEventListener() {}, close() {} }
const transport: Transport = { kind: 'mock', async request<T>(): Promise<T> { throw new ApiError('offline', 503) }, openStream: () => silent }

const layout = () => useSidePanel.getState().layout
const onScreen = (id: string) => tabOnScreen(id, useSidePanel.getState())
const surfaceTabs = (type: 'files' | 'evolution') => Object.values(layout().tabs).filter(tab => tab.type === type)
const toasts = () => useUi.getState().toasts

beforeEach(() => {
  setTransport(transport)
  resetSidePanel()
  resetSurfaceRouter()
  useApp.setState({
    status: 'ready', projects: { p1: { id: 'p1', name: '水墨飞鸟' }, p2: { id: 'p2', name: 'Rna Agent' } }, projectOrder: ['p1', 'p2'],
    sessionIndex: { 's-p1': { id: 's-p1', title: '主会话', status: 'idle', projectId: 'p1' } }, sessions: {}, selectedSessionId: 's-p1', selectedProjectId: 'p1',
  })
  useUi.setState({ view: 'chat', toasts: [] })
})

describe('opening 文件 and 进化 (design 4.5)', () => {
  it('a view tab opens the page when no panel shows it', () => {
    expect(openSurface('files', 'p1', { from: 'tabs' })).toEqual({ where: 'page', tabId: null })
    expect(useUi.getState().view).toBe('files')
    expect(surfaceTabs('files')).toHaveLength(0)
  })

  it('the launcher and menus open a panel following the current project; another project gets its own', () => {
    const { where, tabId } = openSurface('evolution', 'p1', { from: 'launcher' })
    expect(where).toBe('panel')
    expect(findTab(tabId!)).toMatchObject({ type: 'evolution', projectId: null })
    expect(useUi.getState().view).toBe('chat')
    const other = openSurface('evolution', 'p2').tabId!
    expect(other).not.toBe(tabId)
    expect(findTab(other)).toMatchObject({ type: 'evolution', projectId: 'p2' })
  })

  it('a panel on screen comes forward instead of a second copy, and a view-tab click says where it is', () => {
    const tabId = openSurface('files', 'p1').tabId!
    expect(onScreen(tabId)).toBe(true)
    expect(openSurface('files', 'p1', { from: 'tabs' })).toEqual({ where: 'panel', tabId })
    expect(useUi.getState().view).toBe('chat')
    expect(toasts().map(toast => toast.text)).toEqual(['文件已经在侧边面板中显示。'])
    // The toast's way to the page: the page takes over, the panel closes.
    toasts()[0].action!.run()
    expect(useUi.getState().view).toBe('files')
    expect(findTab(tabId)).toBeUndefined()
  })

  it('an explicit page request opens the page even with the panel on screen', () => {
    const tabId = openSurface('evolution', 'p1').tabId!
    expect(openSurface('evolution', 'p1', { where: 'page' })).toEqual({ where: 'page', tabId: null })
    expect(useUi.getState().view).toBe('evolution')
    expect(findTab(tabId)).toBeDefined()
  })

  it('brings a hidden panel of the project back rather than opening a duplicate', () => {
    const tabId = openSurface('files', 'p1').tabId!
    openTab({ type: 'browser', url: 'http://127.0.0.1:5999/', key: null })
    expect(onScreen(tabId)).toBe(false)
    expect(surfacePanel('files', 'p1')).toMatchObject({ tab: { id: tabId }, visible: false })
    // From the view tab: a hidden panel does not count, the page opens.
    expect(openSurface('files', 'p1', { from: 'tabs' }).where).toBe('page')
    useUi.setState({ view: 'chat' })
    expect(openSurface('files', 'p1', { where: 'panel', path: 'src/a.md' })).toEqual({ where: 'panel', tabId })
    expect(onScreen(tabId)).toBe(true)
    expect(findTab(tabId)).toMatchObject({ path: 'src/a.md' })
    expect(surfaceTabs('files')).toHaveLength(1)
  })

  it('the chooser a card was picked from gives way to the panel already showing', () => {
    const tabId = openSurface('files', 'p1').tabId!
    const group = tabGroupId(layout(), tabId)
    splitGroup(group, 'right')
    const chooser = activeTab(layout(), layout().activeGroup!, useSidePanel.getState().ctx)!
    expect(chooser.type).toBe('launcher')
    openSurface('files', 'p1', { from: 'launcher', place: { replace: chooser.id } })
    expect(findTab(chooser.id)).toBeUndefined()
    expect(onScreen(tabId)).toBe(true)
    expect(surfaceTabs('files')).toHaveLength(1)
  })

  it('remembers that view-tab clicks open the panel, and can go back to the page', () => {
    setSurfacePreference('files', 'panel')
    expect(JSON.parse(localStorage.getItem(PREF_KEY)!)).toEqual({ files: 'panel' })
    const { where, tabId } = openSurface('files', 'p1', { from: 'tabs' })
    expect(where).toBe('panel')
    expect(findTab(tabId!)).toMatchObject({ type: 'files', projectId: null })
    expect(useUi.getState().view).toBe('chat')
    // 进化 keeps its own default.
    expect(openSurface('evolution', 'p1', { from: 'tabs' }).where).toBe('page')
    setSurfacePreference('files', null)
    expect(JSON.parse(localStorage.getItem(PREF_KEY)!)).toEqual({})
    expect(useSurfaceRouter.getState().prefs).toEqual({})
  })

  it('moving the page into a panel takes its open file along and returns the main view to the conversation', () => {
    useUi.setState({ view: 'files' })
    notePageSelection('p1', 'docs/plan.md')
    const { tabId } = openSurface('files', 'p1', { where: 'panel', from: 'tabs' })
    expect(findTab(tabId!)).toMatchObject({ type: 'files', projectId: null, path: 'docs/plan.md' })
    expect(useUi.getState().view).toBe('chat')
  })

  it('moving the page into a panel already on screen: that panel takes the file and the page gives way, no toast', () => {
    const tabId = openSurface('files', 'p1').tabId!
    useUi.setState({ view: 'files' })
    notePageSelection('p1', 'docs/plan.md')
    expect(openSurface('files', 'p1', { where: 'panel', from: 'tabs' })).toEqual({ where: 'panel', tabId })
    expect(findTab(tabId)).toMatchObject({ path: 'docs/plan.md' })
    expect(useUi.getState().view).toBe('chat')
    expect(toasts()).toHaveLength(0)
    expect(surfaceTabs('files')).toHaveLength(1)
  })

  it('the view tab’s toast hands the panel’s open file to the page', () => {
    const tabId = openSurface('files', 'p1').tabId!
    notePanelSelection(tabId, 'src/main.ts')
    openSurface('files', 'p1', { from: 'tabs' })
    toasts()[0].action!.run()
    expect(findTab(tabId)).toBeUndefined()
    expect(useUi.getState().view).toBe('files')
    expect(useSurfaceRouter.getState().pagePath).toEqual({ projectId: 'p1', path: 'src/main.ts' })
  })

  it('在主视图中打开 closes the panel and hands its file to the page', () => {
    const tabId = openSurface('files', 'p1').tabId!
    showInMainView(tabId, 'docs/b.md')
    expect(findTab(tabId)).toBeUndefined()
    expect(useUi.getState().view).toBe('files')
    expect(useSurfaceRouter.getState().pagePath).toEqual({ projectId: 'p1', path: 'docs/b.md' })
  })

  it('a page for another project selects that project first', () => {
    openSurface('evolution', 'p2', { where: 'page' })
    expect(useApp.getState()).toMatchObject({ selectedProjectId: 'p2', selectedSessionId: null })
    expect(useUi.getState().view).toBe('evolution')
    // A panel bound to p2 moved into the main view does the same.
    useApp.setState({ selectedSessionId: 's-p1', selectedProjectId: 'p1' })
    const tabId = openSurface('files', 'p2').tabId!
    expect(findTab(tabId)).toMatchObject({ projectId: 'p2' })
    showInMainView(tabId)
    expect(useApp.getState().selectedProjectId).toBe('p2')
    expect(useUi.getState().view).toBe('files')
  })
})
