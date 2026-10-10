// Stuck tasks on the 任务 page (2026-10-03): failed runs are answered from their row, plan lines are settled on hover,
// each project (and 全部项目) has 清理…, and a failed run's inspector shows what the row knows before the records load.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { setTransport } from '@/api/client'
import { ApiError, type RequestInit, type Transport } from '@/api/transport'
import type { InitiativeAction } from '@/api/project-api'
import type { ProjectSummary } from '@/api/types'
import { useApp } from '@/store/app-store'
import { useTasks } from '@/store/tasks-store'
import { useUi } from '@/store/ui-store'
import { GlobalTasksView } from './GlobalTasksView'
import { invalidateProject } from './useProjectDetail'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let calls: string[] = []
/** Paths the host refuses (a plan line it no longer has). */
let refuse = new Set<string>()
/** The project detail read (jobs, runtime) can take long on a large project: held until released. */
let detailHeld: (() => void)[] = []
const transport: Transport = {
  kind: 'mock',
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    calls.push(`${init.method ?? 'GET'} ${path}${init.body ? ` ${JSON.stringify(init.body)}` : ''}`)
    if (refuse.has(path)) throw new ApiError('条目不存在', 404, 'mind_entry_not_found')
    if (path.startsWith('/api/v2/projects/p?')) { await new Promise<void>(resolve => detailHeld.push(resolve)); return { id: 'p', name: '长篇', jobs: [], initiativeRuntime: { sdkState: { actions: [] } } } as T }
    if (path.endsWith('/initiative/actions')) return { projectId: 'p', actions: useTasks.getState().actions.p ?? [] } as T
    return {} as T
  },
  openStream: () => { throw new Error('no streams') },
}

const failed: InitiativeAction = { id: 'f1', action: 'work', status: 'failed', label: '重写第 3 章', failure: { code: 'tool_timeout' }, finishedAt: '2026-10-01T08:00:00Z', availableControls: [] }
const lost: InitiativeAction = { id: 'r1', action: 'work', status: 'failed', revoked: true, label: '', content: '', receipt: { label: '', status: 'failed', finishedAt: '2026-09-30T08:00:00Z' }, availableControls: [] }
const project = (): ProjectSummary => ({
  id: 'p', name: '长篇',
  plan: { doing: [{ id: 'pl-a', text: 'prose_review → 复查', status: 'doing', updatedAt: '2026-09-30T08:00:00Z' }], next: [{ id: 'pl-b', text: '如实计字 → 原子替换正文文件', status: 'next', updatedAt: '2026-10-01T08:00:00Z' }], done: [] },
})

let root: Root, host: HTMLDivElement
beforeEach(async () => {
  setTransport(transport); calls = []; refuse = new Set(); detailHeld = []; invalidateProject('p')
  useApp.setState({ status: 'ready', projects: { p: project(), q: { id: 'q', name: '水墨飞鸟' } }, projectOrder: ['p', 'q'], sessionIndex: {}, sessions: {}, emergency: false })
  useTasks.setState({ actions: { p: [failed, lost], q: [] }, learning: {}, loaded: true, busy: null, settling: {} })
  useUi.setState({ toasts: [], view: 'tasks', tasksTab: 'adhoc', tasksProject: 'all', tasksFocus: null })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root.render(createElement(Tooltip.Provider, null, createElement(GlobalTasksView))) })
})
afterEach(() => { for (const go of detailHeld.splice(0)) go(); act(() => root.unmount()); host.remove() })

const settle = () => act(async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) })
const group = () => host.querySelector('section[data-project-id="p"]') as HTMLElement
const line = () => host.querySelector('header p')?.textContent ?? ''
const button = (label: string, within: ParentNode = host) => [...within.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label || b.textContent === label) as HTMLButtonElement | undefined

describe('临时任务: what was stuck can be settled', () => {
  it('answers a failed run from its row, and 需要你 drops at once', async () => {
    expect(line()).toContain('需要你 2')
    expect(button('接着做：重写第 3 章')).toBeDefined()
    expect(button('不用了：重写第 3 章')).toBeDefined()
    // A run nothing was kept of: only 不用了 (the host refuses 接着做).
    expect(button('接着做：自主执行')).toBeUndefined()
    expect(button('不用了：自主执行')).toBeDefined()
    await act(async () => { button('不用了：重写第 3 章')!.click() })
    expect(line()).toContain('需要你 1')
    await settle()
    expect(calls).toContain('POST /api/v2/projects/p/tasks/f1 {"choice":"drop"}')
  })

  it('settles a plan line from its row: it leaves the open list at once, and done lines stay under 已完成', async () => {
    expect(group().textContent).toContain('prose_review → 复查')
    await act(async () => { button('不再做：prose_review → 复查')!.click() })
    expect(group().textContent).not.toContain('prose_review → 复查')
    await act(async () => { button('标记完成：如实计字 → 原子替换正文文件')!.click() })
    await settle()
    expect(calls).toEqual(expect.arrayContaining(['PATCH /api/v2/projects/p/mind/agenda/pl-a {"status":"dropped"}', 'PATCH /api/v2/projects/p/mind/agenda/pl-b {"status":"done"}']))
    expect(button('已完成 1')).toBeDefined()
  })

  it('offers 清理… per project and, under 全部项目, for all of them', async () => {
    expect(button('清理「长篇」：4 项没做完', group())).toBeDefined()
    expect(button('清理全部项目：4 项没做完')).toBeDefined()
    // A project with nothing left open has none.
    expect(host.querySelector('section[data-project-id="q"]')).toBeNull()
    await act(async () => { button('清理全部项目：4 项没做完')!.click() })
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog.textContent).toContain('清理全部项目')
    expect(dialog.querySelectorAll('input[type="checkbox"]')).toHaveLength(6)
  })

  it('opens a failed run’s inspector with its title and answers before the project records arrive', async () => {
    await act(async () => { button('重写第 3 章 · 未完成')!.click() })
    const detail = host.querySelector('aside[data-split-detail]') as HTMLElement
    expect(detail).not.toBeNull()
    expect(detail.textContent).toContain('重写第 3 章')
    expect(detail.textContent).toContain('模型服务这次没有及时响应，工作没做完。')
    expect([...detail.querySelectorAll('button')].map(b => b.textContent)).toEqual(expect.arrayContaining(['接着做', '不用了']))
    expect(detailHeld).toHaveLength(1)
  })
})

describe('清理… on the page: the dialog outlives the rows it settles', () => {
  // An open dialog (a closed one may still be fading out).
  const dialog = () => document.querySelector('[role="dialog"][data-state="open"]') as HTMLElement | null
  const inDialog = (label: string) => [...(dialog()?.querySelectorAll('button') ?? [])].find(b => b.textContent === label) as HTMLButtonElement

  it('with every row checked, stays open through the last one and reports a line the host refused', async () => {
    refuse.add('/api/v2/projects/p/mind/agenda/pl-b')
    await act(async () => { button('清理「长篇」：4 项没做完', group())!.click() })
    await act(async () => { inDialog('清理 4 项').click() })
    await settle()
    expect(dialog()?.textContent).toContain('已清理 3 项，1 项没清理掉')
    expect(dialog()?.textContent).toContain('如实计字 → 原子替换正文文件')
    // The refused line is back in the list; the failed runs no longer wait on the user.
    expect(group().textContent).toContain('如实计字 → 原子替换正文文件')
    expect(line()).not.toContain('需要你')
    await act(async () => { inDialog('关闭').click() })
    expect(dialog()).toBeNull()
  })

  it('keeps the report when settling empties the project’s group', async () => {
    useApp.setState(s => ({ projects: { ...s.projects, q: { id: 'q', name: '水墨飞鸟', plan: { doing: [], next: [{ id: 'q-1', text: '补齐设定集', status: 'next', updatedAt: '2026-10-01T08:00:00Z' }], done: [] } } } }))
    await settle()
    const q = () => host.querySelector('section[data-project-id="q"]') as HTMLElement | null
    refuse.add('/api/v2/projects/q/mind/agenda/q-1')
    await act(async () => { button('清理「水墨飞鸟」：1 项没做完', q()!)!.click() })
    await act(async () => { inDialog('清理 1 项').click() })
    await settle()
    expect(dialog()?.textContent).toContain('已清理 0 项，1 项没清理掉')
    expect(q()?.textContent).toContain('补齐设定集')
  })

  it('closes with a toast once everything under 全部项目 went through', async () => {
    await act(async () => { button('清理全部项目：4 项没做完')!.click() })
    await act(async () => { inDialog('清理 4 项').click() })
    await settle()
    expect(dialog()).toBeNull()
    expect(useUi.getState().toasts.at(-1)?.text).toBe('已清理 4 项')
    expect(button('清理全部项目：4 项没做完')).toBeUndefined()
  })
})

describe('a plan line’s inspector', () => {
  const detail = () => host.querySelector('aside[data-split-detail]') as HTMLElement
  const detailButton = (label: string) => [...detail().querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement

  it('settles the line from the inspector, which then shows it done', async () => {
    await act(async () => { button('如实计字 → 原子替换正文文件 · 接下来')!.click() })
    await act(async () => { detailButton('标记完成').click() })
    expect(detail().textContent).toContain('已完成')
    expect(detailButton('标记完成')).toBeUndefined()
    await settle()
    expect(calls).toContain('PATCH /api/v2/projects/p/mind/agenda/pl-b {"status":"done"}')
  })

  it('is not held by an earlier change the plan has moved past (the agent put the line back since)', async () => {
    // The user marked it done on 09-29; the agent reopened it on 09-30 (the summary's row is newer than that change).
    await act(async () => { useTasks.setState({ settling: { 'p:plan:pl-a': { kind: 'plan', status: 'done', since: Date.parse('2026-09-29T08:00:00Z'), at: Date.parse('2026-09-29T09:00:00Z') } } }) })
    await act(async () => { button('prose_review → 复查 · 正在做')!.click() })
    expect(detailButton('标记完成').disabled).toBe(false)
    expect(detailButton('不再做').disabled).toBe(false)
  })
})
