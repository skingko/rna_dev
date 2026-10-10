// Stuck tasks (2026-10-03): plan lines get a menu, a failed run's answers are in view (接着做 only where it can work),
// and 清理… settles what is left with a checked list, progress and a plain report.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { setTransport } from '@/api/client'
import { ApiError, type RequestInit, type Transport } from '@/api/transport'
import type { InitiativeAction } from '@/api/project-api'
import { actionTask, planTasks, type TaskEntry } from '@/lib/tasks'
import { useApp } from '@/store/app-store'
import { useTasks } from '@/store/tasks-store'
import { useUi } from '@/store/ui-store'
import { Menu, MenuContent, MenuTrigger } from '@/components/ui/overlays'
import { FailedAnswerButtons, TaskMenuItems } from './task-parts'
import { CleanupDialog } from './CleanupDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let calls: string[] = []
let refuse = new Set<string>()
const transport: Transport = {
  kind: 'mock',
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    calls.push(`${init.method ?? 'GET'} ${path}${init.body ? ` ${JSON.stringify(init.body)}` : ''}`)
    if (refuse.has(path)) throw new ApiError('后台任务不存在', 404, 'task_not_found')
    return (path.endsWith('/initiative/actions') ? { projectId: 'p', actions: [] } : { revision: 1 }) as T
  },
  openStream: () => { throw new Error('no streams') },
}

let root: Root, host: HTMLDivElement
beforeEach(() => {
  setTransport(transport); calls = []; refuse = new Set()
  useTasks.setState({ actions: {}, busy: null, settling: {} })
  useApp.setState({ projects: { p: { id: 'p', name: '长篇' } }, sessionIndex: {} })
  useUi.setState({ toasts: [], view: 'tasks' })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const render = async (element: ReactElement) => { await act(async () => { root.render(createElement(Tooltip.Provider, null, element)) }) }
const settle = () => act(async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) })
const menu = async (task: TaskEntry) => {
  await render(createElement(Menu, { open: true }, createElement(MenuTrigger, null, '…'), createElement(MenuContent, null, createElement(TaskMenuItems, { task }))))
  return [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[]
}
const buttons = () => [...document.querySelectorAll('button')] as HTMLButtonElement[]
const byText = (text: string) => buttons().find(b => b.textContent === text)

const failed: InitiativeAction = { id: 'f1', action: 'work', status: 'failed', label: '重写第 3 章', failure: { code: 'tool_timeout' }, availableControls: [] }
const lost: InitiativeAction = { id: 'r1', action: 'work', status: 'failed', revoked: true, label: '', content: '', availableControls: [] }
const task = (action: InitiativeAction) => actionTask({ id: 'p', name: '长篇' }, action, Date.now(), { ended: true })!
const plan = planTasks({ id: 'p', name: '长篇', plan: { doing: [{ id: 'pl-a', text: 'prose_review → 复查', status: 'doing' }], next: [{ id: 'pl-b', text: '如实计字', status: 'next' }], done: [{ id: 'pl-c', text: '旧', status: 'done' }] } })

describe('a plan line’s menu', () => {
  it('offers 标记完成 and 不再做, which PATCH the agenda item', async () => {
    const items = await menu(plan[0])
    expect(items.map(item => item.textContent)).toEqual(['标记完成', '不再做', '查看详情与记录', '打开项目'])
    await act(async () => { items[1].click() })
    await settle()
    expect(calls).toEqual(['PATCH /api/v2/projects/p/mind/agenda/pl-a {"status":"dropped"}'])
  })

  it('a done line has nothing to settle', async () => {
    const items = await menu(plan[2])
    expect(items.map(item => item.textContent)).not.toContain('标记完成')
  })
})

describe('a failed run’s answers', () => {
  it('the menu offers 接着做 only where it can work', async () => {
    expect((await menu(task(failed))).map(item => item.textContent)).toEqual(expect.arrayContaining(['接着做', '不用了']))
    const items = (await menu(task(lost))).map(item => item.textContent)
    expect(items).toContain('不用了')
    expect(items).not.toContain('接着做')
  })

  it('shows 接着做 and 不用了 in view, and only 不用了 for a run nothing was kept of', async () => {
    await render(createElement(FailedAnswerButtons, { task: task(failed) }))
    expect(buttons().map(b => b.textContent)).toEqual(['接着做', '不用了'])
    await render(createElement(FailedAnswerButtons, { task: task(lost) }))
    expect(buttons().map(b => b.textContent)).toEqual(['不用了'])
    await render(createElement(FailedAnswerButtons, { task: task({ ...failed, attention: { acknowledgedAt: '2026-10-03T10:00:00Z' } }) }))
    expect(buttons()).toEqual([])
  })

  it('接着做 posts the answer and opens the project’s conversation; 不用了 just settles it', async () => {
    await render(createElement(FailedAnswerButtons, { task: task(failed), variant: 'inspector' }))
    await act(async () => { byText('不用了')!.click() })
    await settle()
    expect(calls[0]).toBe('POST /api/v2/projects/p/tasks/f1 {"choice":"drop"}')
    expect(useUi.getState().view).toBe('tasks')
    useTasks.setState({ settling: {} }); calls = []
    await render(createElement(FailedAnswerButtons, { task: task(failed), variant: 'inspector' }))
    await act(async () => { byText('接着做')!.click() })
    await settle()
    expect(calls[0]).toBe('POST /api/v2/projects/p/tasks/f1 {"choice":"continue"}')
    expect(useUi.getState().view).toBe('chat')
  })
})

describe('清理…', () => {
  const rows = [task(failed), task(lost), task({ ...failed, id: 'seen', attention: { acknowledgedAt: '2026-10-03T10:00:00Z' } }), ...plan]
  const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement
  const boxes = () => [...dialog().querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]

  it('lists failed work and open plan lines, grouped, all checked, saying what happens to each', async () => {
    await render(createElement(CleanupDialog, { open: true, onClose: () => {}, rows }))
    const text = dialog().textContent ?? ''
    expect(text).toContain('没做完的后台工作')
    expect(text).toContain('不再提醒，记录保留')
    expect(text).toContain('计划')
    expect(text).toContain('标记为不再做')
    // f1, r1 and their group; pl-a, pl-b and theirs. The answered run and the done line are not listed.
    expect(boxes().map(box => box.checked)).toEqual([true, true, true, true, true, true])
    expect(text).not.toContain('旧')
    expect(byText('清理 4 项')).toBeDefined()
    await act(async () => { boxes()[4].click() })
    expect(byText('清理 3 项')).toBeDefined()
    expect(boxes()[3].indeterminate).toBe(true)
  })

  it('runs the checked rows one by one, then closes with a toast when all went through', async () => {
    const onClose = vi.fn()
    await render(createElement(CleanupDialog, { open: true, onClose, rows }))
    await act(async () => { boxes()[0].click() }) // leave the failed work out
    await act(async () => { byText('清理 2 项')!.click() })
    await settle()
    expect(calls.filter(call => !call.startsWith('GET'))).toEqual([
      'PATCH /api/v2/projects/p/mind/agenda/pl-a {"status":"dropped"}',
      'PATCH /api/v2/projects/p/mind/agenda/pl-b {"status":"dropped"}',
    ])
    expect(onClose).toHaveBeenCalled()
    expect(useUi.getState().toasts.at(-1)?.text).toBe('已清理 2 项')
  })

  it('reports what did not go through, plainly, and stays open', async () => {
    refuse.add('/api/v2/projects/p/tasks/r1')
    const onClose = vi.fn()
    await render(createElement(CleanupDialog, { open: true, onClose, rows }))
    await act(async () => { byText('清理 4 项')!.click() })
    await settle()
    expect(onClose).not.toHaveBeenCalled()
    const text = dialog().textContent ?? ''
    expect(text).toContain('已清理 3 项，1 项没清理掉：')
    expect(text).toContain('后台任务不存在')
    expect(byText('关闭')).toBeDefined()
  })

  it('takes its own confirm words (the 后台任务 panel’s 全部不用了)', async () => {
    await render(createElement(CleanupDialog, { open: true, onClose: () => {}, rows: [task(failed)], confirmLabel: n => `不用了（${n} 项）` }))
    expect(byText('不用了（1 项）')).toBeDefined()
  })
})
