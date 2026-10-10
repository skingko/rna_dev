import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { setTransport } from '@/api/client'
import { ApiError, type EventSourceLike, type Transport } from '@/api/transport'
import type { InitiativeAction } from '@/api/project-api'
import type { Item, ProjectSummary, SessionSummary, WorkRun } from '@/api/types'
import { backgroundRuns, type RunProjectInput } from '@/lib/background-runs'
import { aggregateTasks, sidebarTaskGroups } from '@/lib/tasks'
import { useApp } from '@/store/app-store'
import { useGlobalTasks, useTasks } from '@/store/tasks-store'
import { useUi } from '@/store/ui-store'
import { createSlice } from '@/store/session-model'
import { findTab, resetSidePanel, useSidePanel } from '@/store/side-panel-store'
import { BackgroundTasksPanel } from '@/components/panels/tasks/BackgroundTasksPanel'
import { BackgroundStrip } from '@/components/composer/BackgroundStrip'
import { ProactiveMessage } from '@/components/timeline/Messages'
import { TopBar } from '@/components/shell/TopBar'
import { resetTasksQuiet, tasksShown, tasksTab } from '@/components/workspace/tasks-panel'
import { SidebarTasks } from './SidebarTasks'
import { activeCount, liveTaskEntries } from './live-tasks'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
MotionGlobalConfig.skipAnimations = true

const MIN = 60_000, HOUR = 60 * MIN
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const kinds = { read: 0, search: 0, edit: 0, write: 0, command: 0, web: 0, other: 0 }
const run = (patch: Partial<WorkRun> & Pick<WorkRun, 'id'>): WorkRun => ({
  kind: 'work', title: '核对字段命名', status: 'running', createdAt: ago(3 * MIN), startedAt: ago(2 * MIN),
  steps: { total: 3, completed: 2, failed: 0, uncertain: 0, limit: 64, kinds }, latest: null, tokens: { total: 1200, estimated: false }, model: null, changeId: null, ...patch,
})
const schedule = { id: 'daily', title: '晨报', task: '整理晨报', enabled: true, rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' }, nextRunAt: new Date(Date.now() + 5 * HOUR).toISOString(), destinationSessionId: 's-p1' }
/** p1 has a run only its progress (`work`) lists so far, besides the actions the sidebar reads. */
const projects = (): Record<string, ProjectSummary> => ({
  p1: { id: 'p1', name: '水墨飞鸟', primarySessionId: 's-p1', work: { running: [run({ id: 'w1' })], recent: [] }, ...({ initiative: { enabled: true }, schedules: [schedule], scheduleRuntime: { occurrences: [] } } as object) },
  p2: { id: 'p2', name: 'Rna Agent', primarySessionId: 's-p2' },
})
const sessions = (): Record<string, SessionSummary> => ({
  's-p1': { id: 's-p1', title: '主会话', status: 'idle', projectId: 'p1' },
  's-p2': { id: 's-p2', title: '联调', status: 'idle', projectId: 'p2' },
})
const action = (id: string, status: string, label: string): InitiativeAction => ({ id, action: 'work', status, label, createdAt: ago(4 * MIN), startedAt: status === 'queued' ? undefined : ago(3 * MIN), availableControls: status === 'running' ? ['pause', 'stop'] : [], controlRevision: 1 })
const actions = (): Record<string, InitiativeAction[]> => ({
  p1: [action('a1', 'running', '整理测试报告'), action('q1', 'queued', '复核第 9 章')],
  p2: [action('b1', 'paused', '补全接口文档')],
})

const silent: EventSourceLike = { readyState: 1, onopen: null, onerror: null, addEventListener() {}, close() {} }
const transport: Transport = { kind: 'mock', async request<T>(): Promise<T> { throw new ApiError('offline', 503) }, openStream: () => silent }

let root: Root, host: HTMLDivElement
beforeEach(() => {
  setTransport(transport)
  resetSidePanel()
  resetTasksQuiet()
  useApp.setState({ status: 'ready', projects: projects(), projectOrder: ['p1', 'p2'], sessionIndex: sessions(), sessions: {}, selectedSessionId: 's-p1', selectedProjectId: 'p1', emergency: false })
  useTasks.setState({ actions: actions(), loaded: true, busy: null })
  useUi.setState({ view: 'chat', taskFilter: 'all', tasksCollapsed: false, search: '' })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const render = async (...elements: ReactNode[]) => {
  await act(async () => { root.render(createElement(Tooltip.Provider, null, ...elements)) })
}
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy()
  await act(async () => { (element as HTMLElement).click() })
}
const button = (scope: ParentNode, text: string) => [...scope.querySelectorAll('button')].find(b => b.textContent?.trim() === text)
const shown = () => tasksShown(useSidePanel.getState().layout, useSidePanel.getState().ctx)

describe('one count of work in progress (design 2.1)', () => {
  it('counts what the panel counts: the actions read plus the runs only the host progress lists yet', () => {
    const list = ['p1', 'p2'].map(id => projects()[id]) as unknown as RunProjectInput[]
    const entries = liveTaskEntries(list, actions(), { sessions: Object.values(sessions()) })
    for (const filter of ['p1', 'p2', 'all']) {
      const panel = backgroundRuns({ projects: list, actions: actions(), sessions: Object.values(sessions()), filter }).counts.active
      expect(activeCount(entries, filter === 'all' ? null : filter)).toBe(panel)
    }
    expect(activeCount(entries, 'p1')).toBe(3)
    // The actions alone would miss w1 (read again about a second after the progress arrives).
    expect(sidebarTaskGroups(aggregateTasks(list, actions()).filter(entry => entry.projectId === 'p1')).active).toHaveLength(2)
  })

  it('the 任务 page lists the runs only the host progress knows yet, as the sidebar does', async () => {
    const seen: Record<string, string[]> = {}
    const Probe = ({ ended }: { ended: boolean }) => {
      seen[String(ended)] = useGlobalTasks({ ended }).filter(entry => entry.kind === 'action').map(entry => entry.id)
      return null
    }
    await render(createElement(Probe, { ended: true }), createElement(Probe, { ended: false }))
    expect(seen.true).toContain('w1')
    expect(seen.false).toContain('w1')
    expect(activeCount(liveSnapshot(), 'p1')).toBe(3)
  })

  it('the sidebar, the top bar badge and the panel show the same number', async () => {
    useUi.setState({ taskFilter: 'p1' })
    await render(
      createElement('div', { 'data-probe': 'sidebar' }, createElement(SidebarTasks)),
      createElement('div', { 'data-probe': 'top' }, createElement(TopBar)),
      createElement('div', { 'data-probe': 'panel' }, createElement(BackgroundTasksPanel, { currentProjectId: 'p1', onOpenTab: () => {}, onFilterChange: () => {} })),
    )
    const probe = (id: string) => host.querySelector(`[data-probe="${id}"]`)!
    expect(probe('sidebar').querySelector('[aria-label="3 项进行中"]')).not.toBeNull()
    expect(probe('panel').querySelector('[aria-label="3 项进行中"]')).not.toBeNull()
    const badge = probe('top').querySelector('[data-tasks-badge]')!
    expect(badge.textContent).toContain('项目在后台工作')
    expect(badge.textContent).toContain('3 项进行中')
  })
})

describe('one count of what waits on the user', () => {
  it('the sidebar\'s 需要处理 badge and the panel\'s 需要你 count the same runs, an unanswered failure included', async () => {
    useTasks.setState({ actions: { ...actions(), p1: [...actions().p1, action('r1', 'needs_review', '核对第 8 章'), { ...action('f1', 'failed', '导出截图'), finishedAt: ago(26 * HOUR) } as InitiativeAction] } })
    useUi.setState({ taskFilter: 'p1' })
    await render(
      createElement('div', { 'data-probe': 'sidebar' }, createElement(SidebarTasks)),
      createElement('div', { 'data-probe': 'panel' }, createElement(BackgroundTasksPanel, { currentProjectId: 'p1', onOpenTab: () => {}, onFilterChange: () => {} })),
    )
    const probe = (id: string) => host.querySelector(`[data-probe="${id}"]`)!
    expect(probe('sidebar').querySelector('[aria-label="2 项需要处理 · 在任务页查看"]')).not.toBeNull()
    expect(probe('panel').textContent).toMatch(/需要你\s*2/)
  })
})

describe('the top bar badge toggles 后台任务 (design 2.5)', () => {
  it('shows the panel on the current project, then hides it again', async () => {
    await render(createElement(TopBar))
    const badge = () => host.querySelector<HTMLButtonElement>('[data-tasks-badge]')!
    expect(badge().getAttribute('aria-pressed')).toBe('false')
    await click(badge())
    expect(shown()).toBe(true)
    expect(badge().getAttribute('aria-pressed')).toBe('true')
    await click(badge())
    expect(useSidePanel.getState().layout.collapsed).toBe(true)
    expect(badge().getAttribute('aria-pressed')).toBe('false')
  })

  it('names queued or paused work without saying it is working, and is absent when there is none', async () => {
    useApp.setState({ selectedSessionId: 's-p2', selectedProjectId: 'p2' })
    await render(createElement(TopBar))
    const badge = host.querySelector('[data-tasks-badge]')!
    expect(badge.textContent).not.toContain('项目在后台工作')
    expect(badge.textContent).toContain('后台任务')
    expect(badge.textContent).toContain('1 项进行中')
    await act(async () => { useTasks.setState({ actions: { ...actions(), p2: [] } }) })
    expect(host.querySelector('[data-tasks-badge]')).toBeNull()
  })
})

describe('entry points open the run in the panel (design 2.5)', () => {
  it('a running, queued or paused sidebar row focuses its card; a schedule still opens the 任务 page', async () => {
    await render(createElement(SidebarTasks))
    const row = (title: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.includes(title))
    await click(row('整理测试报告'))
    const tab = tasksTab()!
    expect(tab).toMatchObject({ focusRunId: 'p1:action:a1' })
    expect(shown()).toBe(true)
    expect(useUi.getState().view).toBe('chat')

    await click(row('补全接口文档'))
    expect(findTab(tab.id)).toMatchObject({ focusRunId: 'p2:action:b1', projectFilter: 'p2' })

    await click([...host.querySelectorAll('[role="tab"]')].find(b => b.textContent?.includes('日程')))
    await click(row('晨报'))
    expect(useUi.getState()).toMatchObject({ view: 'tasks', tasksTab: 'schedules', tasksFocus: { key: 'p1:schedule:daily' } })
  })

  it('查看 in the strip above the composer focuses the running card', async () => {
    await render(createElement(BackgroundStrip, { projectId: 'p1', turnRunning: false }))
    // The newest run leads the strip: here one only the host progress lists so far.
    expect(host.textContent).toContain('核对字段命名（另有 1 项）')
    await click(button(host, '查看'))
    expect(tasksTab()).toMatchObject({ focusRunId: 'p1:action:w1', projectFilter: undefined })
    expect(shown()).toBe(true)
    expect(useUi.getState().view).toBe('chat')
  })

  it('查看进度 on a conversation line focuses its run', async () => {
    const line: Item = { id: 'line-1', turnId: null, kind: 'assistant', source: 'initiative', text: '在后台整理测试报告。', createdAt: ago(MIN), initiative: { kind: 'share', backgroundWork: { actionId: 'a1', status: 'running' } } }
    useApp.setState({ sessions: { 's-p1': createSlice({ id: 's-p1', title: '主会话', status: 'idle', projectId: 'p1', items: [line], turns: [], revision: 1 }) } })
    await render(createElement(ProactiveMessage, { sessionId: 's-p1', itemId: 'line-1' }))
    await click(button(host, '查看进度'))
    expect(tasksTab()).toMatchObject({ focusRunId: 'p1:action:a1' })
    expect(shown()).toBe(true)
    expect(useUi.getState().view).toBe('chat')
  })
})

/** The live list outside React: the same pure merge the hook reads. */
function liveSnapshot() {
  const app = useApp.getState()
  const list = app.projectOrder.map(id => app.projects[id]) as unknown as RunProjectInput[]
  return liveTaskEntries(list, useTasks.getState().actions, { sessions: Object.values(app.sessionIndex) })
}
