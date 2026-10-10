// UX audit 2026-10-03, round 2: the task inspector words an unsent message as its row does, and the schedule dialog
// shows a retry in progress and the host's own reason for a refused schedule.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { setTransport } from '@/api/client'
import { ApiError, type RequestInit, type Transport } from '@/api/transport'
import { actionTask } from '@/lib/tasks'
import { useApp } from '@/store/app-store'
import { useTasks } from '@/store/tasks-store'
import { ActionInspector, ScheduleCreator } from './task-inspectors'
import { invalidateProject } from './useProjectDetail'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Handler = (path: string, init: RequestInit) => unknown
let handle: Handler = () => { throw new ApiError('offline', 503) }
const transport: Transport = {
  kind: 'mock',
  async request<T>(path: string, init: RequestInit = {}): Promise<T> { return await handle(path, init) as T },
  openStream: () => { throw new Error('no streams') },
}

let root: Root, host: HTMLDivElement
beforeEach(() => {
  setTransport(transport); invalidateProject('p')
  useApp.setState({ status: 'ready', projects: {}, sessionIndex: { s1: { id: 's1', title: '项目讨论', status: 'idle', projectId: 'p' } }, sessions: {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const render = async (element: ReactElement) => { await act(async () => { root.render(createElement(Tooltip.Provider, null, element)) }) }
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const page = () => document.body.textContent ?? ''
const button = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement | undefined

describe('an unsent message reads as its row does (F13, round 2)', () => {
  it('says why it was not sent, without the wait that came before', async () => {
    const share = { id: 's', action: 'share', status: 'cancelled', deferredReason: 'foreground_busy', cancellationReason: 'below_threshold', content: '第 21 条赛道上线' }
    handle = path => (path.startsWith('/api/v2/projects/p?') ? { id: 'p', name: 'P', jobs: [], initiativeRuntime: { sdkState: { actions: [share] } } } : { projectId: 'p', entries: [] })
    await render(createElement(ActionInspector, { task: actionTask({ id: 'p', name: 'P' }, share, Date.now(), { ended: true })! }))
    await settle()
    expect(page()).toContain('没有发送：价值低于当前门槛')
    expect(page()).not.toContain('你正在对话里工作')
  })
})

describe('a review recorded on the task page (C2-d)', () => {
  it('re-reads the actions, so the conversation\'s notice stops sending the user to review it', async () => {
    const review = { id: 'r', action: 'work', status: 'needs_review', blocksExecution: true, content: '写第 4 章' }
    const calls: string[] = []
    handle = (path, init) => {
      calls.push(`${init.method ?? 'GET'} ${path}`)
      if (path.startsWith('/api/v2/projects/p?')) return { id: 'p', name: 'P', jobs: [], initiativeRuntime: { sdkState: { actions: [review] } } }
      if (path.endsWith('/initiative/actions')) return { projectId: 'p', actions: [{ ...review, status: 'completed', blocksExecution: false }] }
      return {}
    }
    await render(createElement(ActionInspector, { task: actionTask({ id: 'p', name: 'P' }, review, Date.now(), { ended: true })! }))
    await settle()
    await act(async () => { button('核对执行结果')!.click() })
    const select = document.querySelector('[role="dialog"] select') as HTMLSelectElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'completed')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      const note = document.querySelector('[role="dialog"] textarea') as HTMLTextAreaElement
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, '第 4 章文件完整')
      note.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { button('保存核对结论')!.click() })
    await settle()
    expect(calls).toContain('POST /api/projects/p/initiative/actions/r/resolve')
    expect(calls.at(-1)).toBe('GET /api/projects/p/initiative/actions')
    expect(useTasks.getState().actions.p?.[0].status).toBe('completed')
  })
})

describe('新建日程 (F21, round 2)', () => {
  it('a retry shows the read in progress, and a second failure says it was retried', async () => {
    let fail: (error: Error) => void = () => {}
    handle = path => {
      if (path.startsWith('/api/v2/projects/p?')) return new Promise((_, reject) => { fail = reject })
      throw new ApiError('offline', 503)
    }
    await render(createElement(ScheduleCreator, { projectId: 'p', onClose: () => {} }))
    await act(async () => { fail(new ApiError('连不上 Rna 服务', 0)) })
    expect(page()).toContain('项目读取失败：连不上 Rna 服务')
    await act(async () => { button('重试')!.click() })
    expect(button('正在读取…')?.disabled).toBe(true)
    expect(page()).not.toContain('项目读取失败')
    await act(async () => { fail(new ApiError('连不上 Rna 服务', 0)) })
    expect(page()).toContain('项目读取失败：连不上 Rna 服务（已重试 1 次）')
    expect(button('重试')?.disabled).toBe(false)
  })

  it('a schedule the host refused shows the host\'s reason as written', async () => {
    handle = (path, init) => {
      if (path.startsWith('/api/v2/projects/p?')) return { id: 'p', name: 'P', primarySessionId: 's1', jobs: [] }
      if (path === '/api/projects/p/schedules' && init.method === 'POST') throw new ApiError('这个时间已经过去了，请选一个将来的时间。', 400, 'invalid_schedule')
      if (path === '/api/projects/p/schedules') return { schedules: [], occurrences: [], defaults: { time: '09:00', timeZone: 'Asia/Shanghai' } }
      throw new ApiError('offline', 503)
    }
    await render(createElement(ScheduleCreator, { projectId: 'p', onClose: () => {} }))
    await settle()
    const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await act(async () => {
      type(document.querySelector('[role="dialog"] input')!, '日报')
      type(document.querySelector('[role="dialog"] textarea')!, '整理当天的进展')
    })
    await act(async () => { button('保存日程')!.click() })
    await settle()
    expect(page()).toContain('这个时间已经过去了，请选一个将来的时间。')
    expect(page()).not.toContain('日程未保存')
  })
})
