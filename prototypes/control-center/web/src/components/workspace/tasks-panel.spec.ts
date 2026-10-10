import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { setTransport } from '@/api/client'
import { ApiError, type EventSourceLike, type Transport } from '@/api/transport'
import type { InitiativeAction } from '@/api/project-api'
import type { Item, ProjectSummary, Session, SessionSummary } from '@/api/types'
import { activeTab, getGroup, groupIds, tabGroupId } from '@/lib/dock'
import { useApp } from '@/store/app-store'
import { useTasks } from '@/store/tasks-store'
import { useUi } from '@/store/ui-store'
import { createSlice } from '@/store/session-model'
import {
  activateTab, closeTab, findTab, maximizeGroup, minimizeGroup, openTab, reopenClosedTab, resetSidePanel, setContext, setPanelOpen, setSheet, setViewport, undoLayout,
  updateTab, useSidePanel,
} from '@/store/side-panel-store'
import { usePreferences } from '@/components/settings/preferences'
import { useTimelineFocus } from '@/components/timeline/timeline-focus'
import { Launcher } from '@/components/side-panel/Launcher'
import { getPanel } from './registry'
import './panels'
import {
  isQuiet, openFromTasks, openTasksPanel, resetTasksQuiet, runLine, startTasksAutoOpen, tasksShown, tasksTab, toggleTasksPanel,
} from './tasks-panel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
MotionGlobalConfig.skipAnimations = true

const MIN = 60_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const silent: EventSourceLike = { readyState: 1, onopen: null, onerror: null, addEventListener() {}, close() {} }
const transport: Transport = {
  kind: 'mock',
  async request<T>(): Promise<T> { throw new ApiError('offline', 503) },
  openStream: () => silent,
}

const project = (id: string, name: string, extra: Partial<ProjectSummary> = {}): ProjectSummary => ({ id, name, primarySessionId: `s-${id}`, ...extra })
const sessions = (): Record<string, SessionSummary> => ({
  's-p1': { id: 's-p1', title: '主会话', status: 'idle', projectId: 'p1' },
  's-p2': { id: 's-p2', title: '另一个', status: 'idle', projectId: 'p2' },
})
const work = (id: string, status = 'running'): InitiativeAction => ({ id, action: 'work', status, label: '整理测试报告', createdAt: ago(2 * MIN), startedAt: ago(MIN), availableControls: ['pause', 'stop'], controlRevision: 1 })
const setActions = (p1: InitiativeAction[], p2: InitiativeAction[] = []) => useTasks.setState({ actions: { p1, p2 } })

const layout = () => useSidePanel.getState().layout
const ctx = () => useSidePanel.getState().ctx
const shown = () => tasksShown(layout(), ctx(), useSidePanel.getState())

beforeEach(() => {
  setTransport(transport)
  resetSidePanel()
  resetTasksQuiet()
  usePreferences.setState({ tasksAutoOpen: true })
  useApp.setState({
    status: 'ready', projects: { p1: project('p1', '水墨飞鸟'), p2: project('p2', 'Rna Agent') }, projectOrder: ['p1', 'p2'],
    sessionIndex: sessions(), sessions: {}, selectedSessionId: 's-p1', selectedProjectId: 'p1', emergency: false,
  })
  useTasks.setState({ actions: { p1: [], p2: [] }, loaded: true, busy: null })
  useUi.setState({ view: 'chat', toasts: [] })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('the 后台任务 panel registration (contract P-6)', () => {
  it('registers one workspace-bound panel titled 后台任务, and the chooser opens it', async () => {
    const def = getPanel('tasks')!
    expect(def.binding).toBe('workspace')
    expect(def.title({ id: 't', type: 'tasks', binding: 'workspace' })).toBe('后台任务')
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(Tooltip.Provider, null, createElement(Launcher, { tabId: null, sessionId: 's-p1', projectId: 'p1' }))) })
    const card = host.querySelector<HTMLButtonElement>('[data-launcher="tasks"]')!
    expect(card.textContent).toContain('后台任务')
    await act(async () => { card.click() })
    expect(shown()).toBe(true)
    act(() => root.unmount()); host.remove()
  })

  it('drops a run it was pointed at once the panel has brought it into view, however late it arrives', async () => {
    vi.useFakeTimers()
    try {
      const id = openTasksPanel({ focusRunId: 'p1:action:a1', projectId: 'p1' })
      const tab = findTab(id)!
      const host = document.createElement('div'); document.body.append(host)
      const root = createRoot(host)
      const show = (visible: boolean) => act(async () => {
        root.render(createElement(Tooltip.Provider, null, getPanel('tasks')!.render(tab, { sessionId: 's-p1', projectId: 'p1', visible, groupId: tabGroupId(layout(), id) })))
      })
      await show(true)
      expect(host.querySelector('[data-tasks-panel]')).not.toBeNull()
      // The run is not in the panel's data yet (its actions are still being read): the focus waits for it.
      await act(async () => { vi.advanceTimersByTime(5000) })
      expect(findTab(id)).toMatchObject({ focusRunId: 'p1:action:a1' })
      // It arrives while the panel is out of view: still waiting.
      await show(false)
      await act(async () => { setActions([work('a1')]) })
      await act(async () => { vi.advanceTimersByTime(1000) })
      expect(findTab(id)).toMatchObject({ focusRunId: 'p1:action:a1' })
      // On screen: opened, scrolled to, then dropped, so the same run can be pointed at again.
      await show(true)
      expect(host.querySelector('[data-run="p1:action:a1"]')?.className).toContain('line-focus')
      await act(async () => { vi.advanceTimersByTime(300) })
      expect(findTab(id)).toMatchObject({ focusRunId: null })
      act(() => root.unmount()); host.remove()
    } finally { vi.useRealTimers() }
  })
})

describe('entry points (design 2.5)', () => {
  it('opens the panel focused on a run, keeping a filter that shows it and otherwise showing its project', () => {
    const id = openTasksPanel({ focusRunId: 'p1:action:a1', projectId: 'p1' })
    expect(findTab(id)).toMatchObject({ type: 'tasks', focusRunId: 'p1:action:a1', projectFilter: undefined })
    expect(shown()).toBe(true)
    // A run of another project: the panel shows that project.
    openTasksPanel({ focusRunId: 'p2:action:b1', projectId: 'p2' })
    expect(findTab(id)).toMatchObject({ focusRunId: 'p2:action:b1', projectFilter: 'p2' })
    // Back to a run of the current project: it follows the current project again.
    openTasksPanel({ focusRunId: 'p1:action:a1', projectId: 'p1' })
    expect(findTab(id)).toMatchObject({ projectFilter: undefined })
    // 全部 already shows every project.
    updateTab(id, { projectFilter: 'all' })
    openTasksPanel({ focusRunId: 'p2:action:b1', projectId: 'p2' })
    expect(findTab(id)).toMatchObject({ projectFilter: 'all', focusRunId: 'p2:action:b1' })
    expect(Object.values(layout().tabs).filter(tab => tab.type === 'tasks')).toHaveLength(1)
  })

  it('the badge toggle shows the panel, then collapses it when nothing else is open, and closes only its tab when something is', () => {
    toggleTasksPanel('p1')
    expect(shown()).toBe(true)
    toggleTasksPanel('p1')
    expect(layout().collapsed).toBe(true)
    expect(tasksTab()).not.toBeNull()
    toggleTasksPanel('p1')
    expect(shown()).toBe(true)
    expect(layout().collapsed).toBe(false)

    const page = openTab({ type: 'browser', url: 'http://localhost:5173/' })
    toggleTasksPanel('p1')
    expect(shown()).toBe(true)
    toggleTasksPanel('p1')
    expect(tasksTab()).toBeNull()
    expect(layout().collapsed).toBe(false)
    const group = tabGroupId(layout(), page)
    expect(activeTab(layout(), group, ctx())?.id).toBe(page)
  })
})

describe('on screen or not (the badge)', () => {
  it('a tasks tab in a squeezed, minimized or covered group is not shown, and the badge brings it forward', () => {
    setViewport({ width: 1000, height: 800 })
    const tasks = openTasksPanel()
    const holder = tabGroupId(layout(), tasks)
    const b = openTab({ type: 'file', projectId: 'p1', path: 'b.md' }, { target: { edge: 'right', of: holder } })
    openTab({ type: 'file', projectId: 'p1', path: 'c.md' }, { target: { edge: 'right', of: tabGroupId(layout(), b) } })
    // 420 + 3 × 260 > 1000: the group focused longest ago, the tasks one, is on the edge strip.
    expect(shown()).toBe(false)
    expect(tasksShown(layout(), ctx())).toBe(true) // without the size, only minimize and maximize would count
    toggleTasksPanel('p1') // the badge shows it rather than closing what the user cannot see
    expect(shown()).toBe(true)
    expect(findTab(tasks)).toBeDefined()
    minimizeGroup(holder)
    expect(shown()).toBe(false)
    toggleTasksPanel('p1')
    expect(shown()).toBe(true)
    // A narrow window shows one group over the conversation: the others are not on screen.
    setViewport({ width: 600, height: 800 })
    expect(shown()).toBe(true)
    activateTab(b)
    expect(shown()).toBe(false)
  })

  it('on the phone sheet, 后台任务 is shown when it is the sheet’s tab', () => {
    setSheet(true)
    const tasks = openTasksPanel()
    expect(shown()).toBe(true)
    openTab({ type: 'file', projectId: 'p1', path: 'a.md' }, { target: { edge: 'bottom', of: tabGroupId(layout(), tasks) } })
    expect(shown()).toBe(false)
    setSheet(false)
  })

  it('behind another group’s maximize it is not shown — unless that group has nothing to show here', () => {
    setViewport({ width: 1400, height: 900 })
    setContext({ sessionId: 's-p1', projectId: 'p1' })
    const tasks = openTasksPanel()
    const change = openTab({ type: 'change-review', projectId: 'p1', changeId: 'bg-1' }, { target: { edge: 'right', of: tabGroupId(layout(), tasks) } })
    maximizeGroup(tabGroupId(layout(), change))
    expect(shown()).toBe(false)
    // In p2 the change set's group has nothing to show: it takes no space and covers nothing.
    setContext({ sessionId: 's-p2', projectId: 'p2' })
    expect(shown()).toBe(true)
  })
})

describe('what the panel opens (design 2.1 placement)', () => {
  it('opens a change set and a file beside the panel, never over it', () => {
    setViewport({ width: 1400, height: 900 })
    const tasks = openTasksPanel()
    const holder = tabGroupId(layout(), tasks)
    openFromTasks('change', { projectId: 'p1', changeId: 'bg-1', focus: 'src/report.ts' })
    const change = Object.values(layout().tabs).find(tab => tab.type === 'change-review')!
    expect(change).toMatchObject({ projectId: 'p1', changeId: 'bg-1', focus: 'src/report.ts' })
    expect(tabGroupId(layout(), change.id)).not.toBe(holder)
    expect(shown()).toBe(true)
    openFromTasks('file', { projectId: 'p1', path: 'docs/周报.md' })
    const file = Object.values(layout().tabs).find(tab => tab.type === 'file')!
    expect(tabGroupId(layout(), file.id)).toBe(tabGroupId(layout(), change.id))
    expect(shown()).toBe(true)
  })

  it('opens a preview by its address in the project preview tab, and says so when there is none', () => {
    openTasksPanel()
    openFromTasks('preview', { projectId: 'p1', url: null })
    expect(useUi.getState().toasts.map(toast => toast.text)).toContain('这个项目的预览还没有打开。')
    openFromTasks('preview', { projectId: 'p1', url: 'http://127.0.0.1:5173/' })
    expect(Object.values(layout().tabs).find(tab => tab.type === 'browser')).toMatchObject({ key: 'preview:p1', url: 'http://127.0.0.1:5173/' })
  })

  it('opens the conversation at the line that reports the run', async () => {
    const line: Item = { id: 'line-1', turnId: null, kind: 'assistant', source: 'initiative', text: '在后台整理测试报告', createdAt: ago(MIN), initiative: { backgroundWork: { actionId: 'a1', status: 'running' } } }
    const session: Session = { id: 's-p1', title: '主会话', status: 'idle', projectId: 'p1', items: [line], turns: [], revision: 1 }
    useApp.setState({ sessions: { 's-p1': createSlice(session) } })
    useUi.setState({ view: 'files' })
    await act(async () => { openFromTasks('conversation', { projectId: 'p1', sessionId: 's-p1', actionId: 'a1' }) })
    expect(useTimelineFocus.getState().target).toMatchObject({ sessionId: 's-p1', itemId: 'line-1' })
    expect(useUi.getState().view).toBe('chat')
  })

  it('opens a conversation that is not loaded yet, then points at the line once its items arrive', async () => {
    useTimelineFocus.setState({ target: null })
    await act(async () => { openFromTasks('conversation', { projectId: 'p2', sessionId: 's-p2', actionId: null, occurrenceKey: 'daily@2026-10-03' }) })
    expect(useApp.getState().selectedSessionId).toBe('s-p2')
    expect(useTimelineFocus.getState().target).toBeNull()
    const delivery: Item = { id: 'delivery-1', turnId: null, kind: 'assistant', source: 'initiative', text: '晨报', createdAt: ago(MIN), scheduleOccurrenceKey: 'daily@2026-10-03' }
    useApp.setState({ sessions: { 's-p2': createSlice({ id: 's-p2', title: '另一个', status: 'idle', projectId: 'p2', items: [delivery], turns: [], revision: 1 }) } })
    expect(useTimelineFocus.getState().target).toMatchObject({ sessionId: 's-p2', itemId: 'delivery-1' })
  })

  it('a line older than the window the page holds is found by the host, and the deep link pages back to it (B9)', async () => {
    useTimelineFocus.setState({ target: null })
    const asked: string[] = []
    setTransport({ ...transport, async request<T>(path: string): Promise<T> { asked.push(path); if (path.startsWith('/api/v2/sessions/s-p1/locate?')) return { itemId: 'line-old', position: { index: 3, count: 900 } } as T; throw new ApiError('offline', 503) } })
    const recent: Item = { id: 'recent', turnId: 't9', kind: 'user', text: '继续', createdAt: ago(MIN) }
    useApp.setState({ sessions: { 's-p1': createSlice({ id: 's-p1', title: '主会话', status: 'idle', projectId: 'p1', items: [recent], turns: [], revision: 1, window: { totalCount: 900, firstItemId: 'first', hasMore: true } }) } })
    await act(async () => { openFromTasks('conversation', { projectId: 'p1', sessionId: 's-p1', actionId: 'a-old' }) })
    expect(asked).toContain('/api/v2/sessions/s-p1/locate?actionId=a-old')
    expect(useTimelineFocus.getState().target).toMatchObject({ sessionId: 's-p1', itemId: 'line-old' })
  })

  it('finds a run line newest first, by action or by scheduled occurrence', () => {
    const item = (id: string, extra: Partial<Item>): Item => ({ id, turnId: null, kind: 'assistant', text: '', createdAt: ago(MIN), ...extra })
    const slice = {
      order: ['x', 'y', 'z'],
      items: {
        x: item('x', { initiative: { backgroundWork: { actionId: 'a1', status: 'done' } } }),
        y: item('y', { scheduleOccurrenceKey: 'k1' }),
        z: item('z', { initiative: { backgroundWork: { actionId: 'a1', status: 'running' } } }),
      },
    }
    expect(runLine(slice, { actionId: 'a1' })).toBe('z')
    expect(runLine(slice, { occurrenceKey: 'k1' })).toBe('y')
    expect(runLine(slice, { actionId: 'nope' })).toBeNull()
    expect(runLine(slice, {})).toBeNull()
    expect(runLine(undefined, { actionId: 'a1' })).toBeNull()
  })
})

describe('opening by itself (decision D4)', () => {
  let stop: () => void = () => {}
  const start = () => { stop = startTasksAutoOpen() }
  afterEach(() => stop())

  it('shows 后台任务 in front when the current project starts its first run and the panels were collapsed', () => {
    start()
    expect(layout().collapsed).toBe(true)
    setActions([work('a1')])
    expect(shown()).toBe(true)
    expect(layout().collapsed).toBe(false)
  })

  it('adds it behind the shown tab when the panels are open', () => {
    start()
    const page = openTab({ type: 'browser', url: 'http://localhost:5173/' })
    setActions([work('a1')])
    const tab = tasksTab()!
    expect(tab).not.toBeNull()
    const group = tabGroupId(layout(), tab.id)
    expect(getGroup(layout(), group).tabIds).toContain(page)
    expect(activeTab(layout(), group, ctx())?.id).toBe(page)
  })

  it('does nothing for runs going when it starts watching, for another project, or for a run that keeps going', () => {
    setActions([work('a1')])
    start()
    expect(tasksTab()).toBeNull()
    setActions([work('a1')], [work('b1')])
    expect(tasksTab()).toBeNull()
    // Switching to a project mid-run is not a start either.
    useApp.setState({ selectedSessionId: 's-p2', selectedProjectId: 'p2' })
    setActions([work('a1')], [work('b1'), work('b2')])
    expect(tasksTab()).toBeNull()
  })

  it('waits for the first read of the actions before taking its baseline', () => {
    useTasks.setState({ loaded: false })
    start()
    setActions([work('a1')])
    useTasks.setState({ loaded: true })
    expect(tasksTab()).toBeNull()
  })

  it('counts a subagent group of the current project as a run', () => {
    start()
    useApp.setState({ sessionIndex: { ...sessions(), 's-p1': { ...sessions()['s-p1'], agents: { running: 2, total: 3, tokens: 1200, latestTurnId: 't1' } } } })
    expect(shown()).toBe(true)
  })

  it('stays closed for a project whose panel the user closed during its run, until the user opens it', () => {
    start()
    setActions([work('a1')])
    closeTab(tasksTab()!.id)
    expect(isQuiet('p1')).toBe(true)
    setActions([work('a1', 'completed')])
    setActions([work('a1', 'completed'), work('a2')])
    expect(tasksTab()).toBeNull()
    // Another project is unaffected.
    useApp.setState({ selectedSessionId: 's-p2', selectedProjectId: 'p2' })
    setActions([work('a1', 'completed'), work('a2')], [work('b1')])
    expect(shown()).toBe(true)

    // The user opens it in p1: it opens by itself there again (closing it after the run ended does not quiet it).
    useApp.setState({ selectedSessionId: 's-p1', selectedProjectId: 'p1' })
    openTasksPanel()
    expect(isQuiet('p1')).toBe(false)
    setActions([work('a1', 'completed'), work('a2', 'completed')], [work('b1')])
    closeTab(tasksTab()!.id)
    expect(isQuiet('p1')).toBe(false)
    setActions([work('a3')], [work('b1')])
    expect(shown()).toBe(true)
  })

  it('a tab evicted past the tab cap was not closed by the user: the project stays unquieted', () => {
    start()
    setActions([work('a1')])
    const tasks = tasksTab()!.id
    for (let i = 0; i < 12; i++) openTab({ type: 'browser', url: `http://localhost:${5100 + i}/` })
    expect(findTab(tasks)).toBeUndefined()
    expect(isQuiet('p1')).toBe(false)
  })

  it('picking the 后台任务 tab in a strip, or bringing it back with ⇧⌘T, counts as the user opening it again', () => {
    start()
    setActions([work('a1')])
    const tasks = tasksTab()!.id
    openTab({ type: 'browser', url: 'http://localhost:5173/' })
    setPanelOpen(false)
    expect(isQuiet('p1')).toBe(true)
    activateTab(tasks) // a strip click
    expect(isQuiet('p1')).toBe(false)

    closeTab(tasks)
    expect(isQuiet('p1')).toBe(true)
    expect(reopenClosedTab()).toBe(true)
    expect(tasksTab()?.id).toBe(tasks)
    expect(isQuiet('p1')).toBe(false)
    closeTab(tasks)
    expect(isQuiet('p1')).toBe(true)
    undoLayout()
    expect(isQuiet('p1')).toBe(false)
  })

  it('collapsing the panels during the run quiets the project too', () => {
    start()
    setActions([work('a1')])
    expect(shown()).toBe(true)
    setPanelOpen(false)
    expect(isQuiet('p1')).toBe(true)
    setActions([])
    setActions([work('a2')])
    expect(layout().collapsed).toBe(true)
  })

  it('a panel pinned to another project follows the current one again', () => {
    const id = openTasksPanel({ projectId: 'p2', focusRunId: 'p2:action:b1' })
    expect(findTab(id)).toMatchObject({ projectFilter: 'p2' })
    setPanelOpen(false)
    start()
    setActions([work('a1')])
    expect(shown()).toBe(true)
    expect(findTab(id)).toMatchObject({ projectFilter: undefined })
  })

  it('leaves a maximized panel alone', () => {
    start()
    const page = openTab({ type: 'browser', url: 'http://localhost:5173/' })
    maximizeGroup(tabGroupId(layout(), page))
    setActions([work('a1')])
    expect(tasksTab()).toBeNull()
    expect(layout().maximizedGroup).not.toBeNull()
  })

  it('is turned off by the setting, and does not open on a phone', () => {
    usePreferences.setState({ tasksAutoOpen: false })
    start()
    setActions([work('a1')])
    expect(tasksTab()).toBeNull()

    usePreferences.setState({ tasksAutoOpen: true })
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-width: 767px'), media: query, addEventListener() {}, removeEventListener() {} }))
    setActions([])
    setActions([work('a2')])
    expect(tasksTab()).toBeNull()
    expect(groupIds(layout())).toHaveLength(1)
  })

  it('does not open over the conversation in a window too narrow for both side by side', () => {
    start()
    setViewport({ width: 620, height: 800 }) // 420 + 260 do not fit: the panel would cover the conversation
    setActions([work('a1')])
    expect(tasksTab()).toBeNull()
    expect(layout().collapsed).toBe(true)
    // Already open there, it is added behind what shows (nothing new covers anything).
    const page = openTab({ type: 'browser', url: 'http://localhost:5173/' })
    setActions([])
    setActions([work('a2')])
    expect(tasksTab()).not.toBeNull()
    expect(activeTab(layout(), tabGroupId(layout(), page), ctx())?.id).toBe(page)
    // Wide enough again: it opens by itself as usual.
    closeTab(tasksTab()!.id)
    setPanelOpen(false)
    resetTasksQuiet()
    setViewport({ width: 1200, height: 800 })
    setActions([])
    setActions([work('a3')])
    expect(shown()).toBe(true)
  })
})
