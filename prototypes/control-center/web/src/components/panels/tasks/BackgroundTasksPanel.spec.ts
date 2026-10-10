import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { setTransport } from '@/api/client'
import type { InitiativeAction } from '@/api/project-api'
import type { RequestInit, Transport } from '@/api/transport'
import type { ProjectSummary, SessionSummary, SubagentInfo, WorkRun } from '@/api/types'
import { useApp } from '@/store/app-store'
import { useTasks } from '@/store/tasks-store'
import { useBackgroundLive } from '@/store/background-live'
import { BackgroundTasksPanel } from './BackgroundTasksPanel'
import { CLEARED_KEY } from './useBackgroundRuns'
import { resetSessionAgents } from './agents-store'
import type { BackgroundTasksPanelProps } from './types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MIN = 60_000, HOUR = 60 * MIN
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const kinds = { read: 0, search: 0, edit: 0, write: 0, command: 0, web: 0, other: 0 }
const run = (patch: Partial<WorkRun> & Pick<WorkRun, 'id'>): WorkRun => ({
  kind: 'work', title: '整理测试报告', status: 'running', createdAt: ago(4 * MIN), startedAt: ago(3 * MIN + 12_000),
  steps: { total: 24, completed: 23, failed: 1, uncertain: 0, limit: 64, kinds }, latest: null, tokens: { total: 18_200, estimated: false },
  model: { providerId: 'glm', modelId: 'glm-5.3', name: 'GLM-5.3' }, changeId: 'bg-1', ...patch,
})

const ink = (): ProjectSummary => ({
  id: 'p-ink', name: '水墨飞鸟', primarySessionId: 's-ink',
  plan: { doing: [{ id: 'i1', text: '核对', status: 'doing', actionId: 'a1' }], next: [], done: [{ id: 'i0', text: '修复', status: 'done', actionId: 'a1' }] },
  backgroundChanges: [{ id: 'bg-1', actionId: 'a1', at: ago(MIN), status: 'kept', count: 4, paths: ['src/report.ts'] }],
  work: {
    running: [run({ id: 'a1' })],
    recent: [run({ id: 'done-1', title: '整理周报', status: 'completed', startedAt: ago(2 * HOUR), completedAt: ago(HOUR + 58 * MIN), summary: '周报已整理好，缺 E2E 结果。', changeId: null })],
  },
  ...({ initiative: { enabled: true }, schedules: [{ id: 'daily', title: '晨报', task: 't', enabled: true, rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' }, nextRunAt: new Date(Date.now() + 5 * HOUR).toISOString(), destinationSessionId: 's-ink' }], scheduleRuntime: { occurrences: [] } } as object),
})
const agentProject = (): ProjectSummary => ({ id: 'p-agent', name: 'Rna Agent', primarySessionId: 's-agent' })
const sessions = (): Record<string, SessionSummary> => ({
  's-ink': { id: 's-ink', title: '主会话', status: 'idle', projectId: 'p-ink' },
  's-agent': { id: 's-agent', title: '联调', status: 'idle', projectId: 'p-agent' },
  's-research': { id: 's-research', title: '调研竞品', status: 'running', projectId: 'p-ink', lastItemAt: ago(MIN), agents: { running: 1, total: 3, tokens: 41_000, latestTurnId: 't2' } },
})
const actions = (): Record<string, InitiativeAction[]> => ({
  'p-ink': [{ id: 'a1', action: 'work', status: 'running', label: '整理测试报告', availableControls: ['pause', 'stop', 'steer'], controlRevision: 3 }],
  'p-agent': [{ id: 'q1', action: 'work', status: 'queued', label: '复核字段命名', createdAt: ago(MIN) }],
})
const groupAgents: SubagentInfo[] = [
  { agentId: 'x1', role: 'scout', task: '盘点竞品', status: 'completed', turnId: 't2', startedAt: ago(100_000), endedAt: ago(60_000), usage: { totalTokens: 9000 }, model: { providerId: 'k', modelId: 'k3', name: 'Kimi K3' } },
  { agentId: 'x2', role: 'worker', task: '实现对比表', status: 'running', turnId: 't2', startedAt: ago(40_000), usage: { totalTokens: 12_000, estimated: true } },
  { agentId: 'x3', role: 'reviewer', task: '审阅结论', status: 'failed', turnId: 't2', startedAt: ago(30_000), endedAt: ago(10_000) },
  { agentId: 'old', role: 'scout', task: '上一轮', status: 'completed', turnId: 't1' },
]

let calls: string[] = []
const transport: Transport = {
  kind: 'mock',
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    calls.push(`${init.method ?? 'GET'} ${path}${init.body ? ` ${JSON.stringify(init.body)}` : ''}`)
    if (path === '/api/projects/p-ink/initiative/actions') return { projectId: 'p-ink', actions: actions()['p-ink'] } as T
    if (path.includes('/control')) return { receipt: { status: 'accepted' }, action: { status: 'paused' } } as T
    if (path === '/api/v2/sessions/s-research/agents') return { sessionId: 's-research', revision: 1, agents: groupAgents } as T
    return {} as T
  },
  openStream: () => { throw new Error('no streams') },
}

let root: Root, host: HTMLDivElement
const opened: unknown[][] = [], filters: unknown[] = []
beforeEach(() => {
  setTransport(transport); calls = []; opened.length = 0; filters.length = 0
  try { localStorage.removeItem(CLEARED_KEY) } catch { /* ignore */ }
  resetSessionAgents()
  useApp.setState({ status: 'ready', projects: { 'p-ink': ink(), 'p-agent': agentProject() }, projectOrder: ['p-ink', 'p-agent'], sessionIndex: sessions(), emergency: false })
  useTasks.setState({ actions: actions(), loaded: true, busy: null })
  useBackgroundLive.setState({ steps: { a1: [{ toolCallId: 'c9', name: 'project_edit', kind: 'edit', target: 'src/report.ts', at: ago(2000), projectId: 'p-ink' }] } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })

const render = async (props: Partial<BackgroundTasksPanelProps> = {}) => {
  const all: BackgroundTasksPanelProps = { currentProjectId: 'p-ink', projectFilter: 'all', onOpenTab: (kind, ref) => { opened.push([kind, ref]) }, onFilterChange: next => { filters.push(next) }, ...props }
  await act(async () => { root.render(createElement(Tooltip.Provider, null, createElement(BackgroundTasksPanel, all))) })
}
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const text = () => host.textContent ?? ''
const section = (id: string) => host.querySelector(`[data-section="${id}"]`) as HTMLElement | null
const card = (key: string) => host.querySelector(`[data-run="${key}"]`) as HTMLElement
const button = (scope: ParentNode, label: string | RegExp) => [...scope.querySelectorAll('button')].find(b => (typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? ''))) as HTMLButtonElement | undefined
/** A card's second line (kind · project · time · agents · tokens), as the user reads it. */
const metaOf = (el: HTMLElement) => [...el.querySelector('header p')!.children].map(part => part.textContent!.replace(/^·/, '')).join(' · ')
const click = async (el: HTMLElement | undefined) => { expect(el).toBeDefined(); await act(async () => { el!.click() }); await settle() }

describe('background tasks panel', () => {
  it('shows the three sections, with the sidebar’s 进行中 count in the header', async () => {
    await render()
    expect(host.querySelector('h2')?.textContent).toBe('后台任务')
    expect(host.querySelector('[aria-label="2 项进行中"]')).not.toBeNull()
    expect(section('running')?.textContent).toContain('运行中2')
    expect(section('upcoming')?.textContent).toContain('排队与即将运行2')
    expect(section('finished')?.textContent).toContain('已完成1· 近 24 小时')
  })

  it('a running card: kind · elapsed · agents · tokens, progress, the live step and its controls', async () => {
    await render()
    const a1 = card('p-ink:action:a1')
    expect(a1.textContent).toContain('整理测试报告')
    expect(metaOf(a1)).toMatch(/^后台工作 · 水墨飞鸟 · 3m1[0-9]s · 1 个代理 · 18k$/)
    expect(a1.querySelector('[aria-label="计划项完成 1/2"]')?.textContent).toContain('1/2')
    expect(a1.querySelector('[data-steps]')?.textContent).toBe('已做 23 步·失败 1') // no "of 64": the host's limit counts model requests
    expect(a1.textContent).not.toContain('/64')
    expect(a1.textContent).toContain('正在编辑src/report.ts')
    expect(['暂停', '停止', '调整方向', '改动 4 个文件', '打开会话'].every(label => button(a1, label))).toBe(true)
  })

  it('opens the change set and the conversation through the host', async () => {
    await render()
    const a1 = card('p-ink:action:a1')
    await click(button(a1, '改动 4 个文件'))
    await click(button(a1, '打开会话'))
    expect(opened).toEqual([
      ['change', { projectId: 'p-ink', changeId: 'bg-1' }],
      ['conversation', { projectId: 'p-ink', sessionId: 's-ink', actionId: 'a1', occurrenceKey: null }],
    ])
  })

  it('pauses through the same control path as the sidebar (latest revision first)', async () => {
    await render()
    await click(button(card('p-ink:action:a1'), '暂停'))
    expect(calls[0]).toBe('GET /api/projects/p-ink/initiative/actions')
    expect(calls[1]).toMatch(/^POST \/api\/projects\/p-ink\/initiative\/actions\/a1\/control \{"action":"pause","requestId":"[^"]+","expectedRevision":3\}$/)
  })

  it('switches between the current project and all projects', async () => {
    await render()
    await click(button(host, '当前项目'))
    expect(filters).toEqual([undefined])
    await render({ projectFilter: undefined })
    expect(card('p-agent:action:q1')).toBeNull()
    expect(host.querySelector('[aria-label="1 项进行中"]')).not.toBeNull()
    await click(button(host, '全部'))
    expect(filters.at(-1)).toBe('all')
    // A project other than the current one, pinned: the switch names it.
    await render({ projectFilter: 'p-agent' })
    expect(button(host, 'Rna Agent')).toBeDefined()
    expect(card('p-agent:action:q1')).not.toBeNull()
  })

  it('lists queued work and upcoming schedule runs as rows that open into their actions', async () => {
    await render()
    const daily = card('p-ink:schedule:daily')
    expect(daily.textContent).toContain('晨报')
    expect(daily.textContent).toContain('定时任务')
    const toggle = daily.querySelector('button[aria-expanded]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(button(daily, '日程设置')).toBeDefined()
    expect(card('p-agent:action:q1').textContent).toContain('后台工作 · Rna Agent · 排队中 · 1 分钟前')
  })

  it('shows finished work with its result, and 清除 hides it on this device only', async () => {
    await render()
    const done = card('p-ink:action:done-1')
    expect(done.textContent).toContain('整理周报')
    expect(done.textContent).toContain('周报已整理好，缺 E2E 结果。')
    expect(done.textContent).toMatch(/已完成 · 用时 2m0[0-9]s/)
    await click(button(section('finished')!, '清除'))
    expect(section('finished')).toBeNull()
    expect(Object.keys(JSON.parse(localStorage.getItem(CLEARED_KEY) ?? '{}'))).toEqual(['p-ink:action:done-1'])
    // Shown again from the panel menu.
    const trigger = host.querySelector('[aria-label="后台任务选项"]') as HTMLButtonElement
    await act(async () => { trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })) })
    const restore = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === '显示已清除的 1 项') as HTMLElement
    await click(restore)
    expect(card('p-ink:action:done-1')).not.toBeNull()
  })

  it('a subagent group lists its latest turn’s agents when opened', async () => {
    await render()
    const group = card('p-ink:agents:s-research')
    expect(metaOf(group)).toBe('子任务组 · 水墨飞鸟 · 进行中 · 3 个代理 · 41k')
    expect(calls.some(call => call.includes('/agents'))).toBe(false)
    await click(button(group, /^代理/))
    expect(calls).toContain('GET /api/v2/sessions/s-research/agents')
    const rows = [...group.querySelectorAll('[role="row"]')].slice(1).map(row => row.textContent)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('项目侦察盘点竞品')
    expect(rows[0]).toContain('Kimi K3')
    expect(rows[0]).toContain('已完成')
    expect(rows[1]).toContain('≈12k')
    expect(rows[2]).toContain('未完成')
    // Its phase line, once loaded: 侦察 1/1 · 实施 0/1 · 审查 0/1.
    expect(group.textContent).toContain('侦察1/1')
  })

  it('a work card’s agents row is its executor; its steps list the latest steps', async () => {
    await render()
    const a1 = card('p-ink:action:a1')
    await click(button(a1, /^代理/))
    expect(a1.querySelector('[role="table"]')?.textContent).toContain('后台执行')
    await click(button(a1, /^步骤/))
    expect(a1.querySelector('ol[aria-label="最近的步骤"]')?.textContent).toContain('正在编辑src/report.ts')
  })

  it('brings a focused run into view, opened and outlined', async () => {
    await render({ focusRunId: 'done-1' })
    await settle()
    const done = card('p-ink:action:done-1')
    expect(done.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true')
    expect(done.className).toContain('line-focus')
  })

  it('fades the outline on its own, also when the host drops the focus before it has faded', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await render({ focusRunId: 'done-1' })
    expect(card('p-ink:action:done-1').className).toContain('line-focus')
    await act(async () => { vi.advanceTimersByTime(500) })
    await render({ focusRunId: null }) // the integration lets go of a one-off focus
    expect(card('p-ink:action:done-1').className).toContain('line-focus')
    await act(async () => { vi.advanceTimersByTime(2_000) })
    expect(card('p-ink:action:done-1').className).not.toContain('line-focus')
  })

  it('says when there is nothing, and offers the other projects', async () => {
    useApp.setState({ projects: { 'p-ink': { ...ink(), work: null, backgroundChanges: [], ...({ schedules: [] } as object) }, 'p-agent': agentProject() }, sessionIndex: { 's-ink': sessions()['s-ink'] } })
    useTasks.setState({ actions: { 'p-ink': [], 'p-agent': actions()['p-agent'] } })
    await render({ projectFilter: undefined })
    expect(text()).toContain('水墨飞鸟 现在没有后台任务')
    await click(button(host, '查看全部项目（1）'))
    expect(filters).toEqual(['all'])
  })

  it('shows a skeleton while the first data is on its way', async () => {
    useApp.setState({ status: 'loading', projects: {}, projectOrder: [], sessionIndex: {} })
    useTasks.setState({ actions: {}, loaded: false })
    await render()
    expect(host.querySelector('[aria-busy="true"] .skeleton')).not.toBeNull()
  })

  it('ticks the elapsed time only while the panel is visible', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    await render({ visible: true })
    const meta = () => metaOf(card('p-ink:action:a1'))
    const before = meta()
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(meta()).not.toBe(before)
    await render({ visible: false })
    const hidden = meta()
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(meta()).toBe(hidden)
  })
})
