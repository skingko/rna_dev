// 后台任务 panel, 需要你 (2026-10-03): a failed run is answered in view (接着做 only where it can work), the section's
// 全部不用了 confirms in the 任务 page's dialog, and the count drops at once.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { setTransport } from '@/api/client'
import type { RequestInit, Transport } from '@/api/transport'
import type { InitiativeAction } from '@/api/project-api'
import { useApp } from '@/store/app-store'
import { useTasks } from '@/store/tasks-store'
import { useUi } from '@/store/ui-store'
import { BackgroundTasksPanel } from './BackgroundTasksPanel'
import { CLEARED_KEY } from './useBackgroundRuns'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let calls: string[] = []
let marked = new Set<string>()
const transport: Transport = {
  kind: 'mock',
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    calls.push(`${init.method ?? 'GET'} ${path}${init.body ? ` ${JSON.stringify(init.body)}` : ''}`)
    const answered = /\/tasks\/([^/]+)$/.exec(path)
    if (answered) { marked.add(answered[1]); return { revision: 2 } as T }
    if (path.endsWith('/initiative/actions')) return { projectId: 'p', actions: actions().map(a => (marked.has(a.id) ? { ...a, attention: { acknowledgedAt: '2026-10-03T10:00:00Z' } } : a)) } as T
    return {} as T
  },
  openStream: () => { throw new Error('no streams') },
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const actions = (): InitiativeAction[] => [
  { id: 'f1', action: 'work', status: 'failed', label: '重写第 3 章', failure: { code: 'tool_timeout' }, finishedAt: ago(3_600_000), availableControls: [], controlRevision: 0 },
  { id: 'r1', action: 'work', status: 'failed', revoked: true, label: '', content: '', receipt: { label: '', status: 'failed', finishedAt: ago(7_200_000) }, availableControls: [], controlRevision: 0 },
  { id: 'rv', action: 'work', status: 'needs_review', label: '批量替换贴图引用', availableControls: [], controlRevision: 0 },
]

let root: Root, host: HTMLDivElement
beforeEach(async () => {
  setTransport(transport); calls = []; marked = new Set()
  try { localStorage.removeItem(CLEARED_KEY) } catch { /* ignore */ }
  useApp.setState({ status: 'ready', projects: { p: { id: 'p', name: '长篇', primarySessionId: 's' } }, projectOrder: ['p'], sessionIndex: { s: { id: 's', title: '主会话', status: 'idle', projectId: 'p' } }, emergency: false })
  useTasks.setState({ actions: { p: actions() }, loaded: true, busy: null, settling: {} })
  useUi.setState({ toasts: [] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => {
    root.render(createElement(Tooltip.Provider, null, createElement(BackgroundTasksPanel, { projectFilter: 'all', currentProjectId: null, onOpenTab: () => {}, onFilterChange: () => {} })))
  })
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const settle = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) })
const section = () => host.querySelector('[data-section="attention"]') as HTMLElement | null
const count = () => section()?.querySelector('button[aria-expanded]')?.textContent ?? ''
const button = (label: string, within: ParentNode = host) => [...within.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label || b.textContent === label) as HTMLButtonElement | undefined

describe('需要你 in the 后台任务 panel', () => {
  it('answers a failed run in view; a result to check keeps its menu', async () => {
    expect(count()).toBe('需要你3')
    expect(button('接着做：重写第 3 章', section()!)).toBeDefined()
    expect(button('不用了：重写第 3 章', section()!)).toBeDefined()
    expect(button('接着做：自主执行', section()!)).toBeUndefined()
    expect(button('不用了：自主执行', section()!)).toBeDefined()
    expect(button('不用了：批量替换贴图引用', section()!)).toBeUndefined()
  })

  it('drops the run from 需要你 at once when the user says 不用了', async () => {
    await act(async () => { button('不用了：重写第 3 章')!.click() })
    expect(count()).toBe('需要你2')
    await settle()
    expect(calls).toContain('POST /api/v2/projects/p/tasks/f1 {"choice":"drop"}')
    expect(count()).toBe('需要你2')
  })

  it('全部不用了 lists the failed runs to confirm, then answers each', async () => {
    await act(async () => { button('全部不用了', section()!)!.click() })
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog.textContent).toContain('这些没做完的后台工作都不用了？')
    expect(dialog.textContent).toContain('不再提醒，记录保留')
    expect(dialog.textContent).not.toContain('批量替换贴图引用')
    await act(async () => { button('不用了（2 项）', dialog)!.click() })
    await settle()
    expect(calls.filter(call => call.startsWith('POST'))).toEqual(['POST /api/v2/projects/p/tasks/f1 {"choice":"drop"}', 'POST /api/v2/projects/p/tasks/r1 {"choice":"drop"}'])
    expect(count()).toBe('需要你1')
    expect(button('全部不用了', section()!)).toBeUndefined()
  })
})
