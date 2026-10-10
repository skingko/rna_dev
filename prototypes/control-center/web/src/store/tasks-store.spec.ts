// Stuck tasks (2026-10-03): answers, plan changes and 清理… go through the tasks store — shown at once, undone if refused.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { setTransport } from '@/api/client'
import { ApiError, type RequestInit, type Transport } from '@/api/transport'
import type { InitiativeAction } from '@/api/project-api'
import type { ProjectSummary } from '@/api/types'
import { actionTask, needsUser, planTasks, type TaskEntry } from '@/lib/tasks'
import { useApp } from './app-store'
import { answerTask, clearTasks, setPlanStatus, useGlobalTasks, useTasks } from './tasks-store'
import { useUi } from './ui-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Call = { method: string; path: string; body?: unknown }
let calls: Call[] = []
let respond: (call: Call) => unknown = () => ({})
/** Requests wait here until `release` (to look at the page between click and answer). */
let held: (() => void)[] = []
let hold = false
const transport: Transport = {
  kind: 'mock',
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const call = { method: init.method ?? 'GET', path, body: init.body }
    calls.push(call)
    if (hold && call.method !== 'GET') await new Promise<void>(resolve => held.push(resolve))
    return await respond(call) as T
  },
  openStream: () => { throw new Error('no streams') },
}
const release = async () => { await act(async () => { for (const go of held.splice(0)) go(); await new Promise(resolve => setTimeout(resolve, 0)) }) }
const settle = () => act(async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) })

const failed: InitiativeAction = { id: 'f1', action: 'work', status: 'failed', label: '重写第 3 章', failure: { code: 'tool_timeout' }, availableControls: [], controlRevision: 0 }
const lost: InitiativeAction = { id: 'r1', action: 'work', status: 'failed', revoked: true, label: '', content: '', availableControls: [], controlRevision: 0 }
const project = (): ProjectSummary => ({
  id: 'p', name: '长篇',
  plan: { doing: [{ id: 'pl-a', text: 'prose_review → 复查', status: 'doing', updatedAt: '2026-09-30T08:00:00Z' }], next: [{ id: 'pl-b', text: '如实计字', status: 'next', updatedAt: '2026-10-01T08:00:00Z' }], done: [] },
})
const task = (action: InitiativeAction): TaskEntry => actionTask({ id: 'p', name: '长篇' }, action, Date.now(), { ended: true })!
const planLine = (id: string): TaskEntry => planTasks(project()).find(line => line.id === id)!

let root: Root, host: HTMLDivElement
let seen: TaskEntry[] = []
function Probe() { seen = useGlobalTasks({ ended: true }); return null }
beforeEach(() => {
  setTransport(transport); calls = []; held = []; hold = false
  respond = call => (call.path.endsWith('/initiative/actions') ? { projectId: 'p', actions: useTasks.getState().actions.p ?? [] } : {})
  useApp.setState({ status: 'ready', projects: { p: project() }, projectOrder: ['p'], sessionIndex: {}, emergency: false })
  useTasks.setState({ actions: { p: [failed, lost] }, learning: {}, loaded: true, busy: null, settling: {} })
  useUi.setState({ toasts: [] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root.render(createElement(Probe)))
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const waiting = () => seen.filter(needsUser).map(row => row.id)
const openPlan = () => seen.filter(row => row.kind === 'plan' && row.state !== 'done').map(row => row.id)
const toasts = () => useUi.getState().toasts

describe('answerTask', () => {
  it('leaves 需要你 before the host answers, posts the choice and reads the actions again', async () => {
    expect(waiting().sort()).toEqual(['f1', 'r1'])
    hold = true
    let done: Promise<unknown> = Promise.resolve()
    await act(async () => { done = answerTask(task(failed), 'drop') })
    expect(waiting()).toEqual(['r1'])
    respond = call => (call.path.endsWith('/initiative/actions') ? { projectId: 'p', actions: [{ ...failed, attention: { acknowledgedAt: '2026-10-03T10:00:00Z' } }, lost] } : { revision: 2 })
    await release(); await done; await settle()
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual(['POST /api/v2/projects/p/tasks/f1', 'GET /api/projects/p/initiative/actions'])
    expect(calls[0].body).toEqual({ choice: 'drop' })
    expect(toasts().at(-1)?.text).toBe('已处理，不再提醒')
    expect(waiting()).toEqual(['r1'])
    // The actions read carries the answer now: the store no longer needs its own copy.
    expect(useTasks.getState().settling).toEqual({})
  })

  it('puts the row back and says why when the host refuses', async () => {
    respond = call => { if (call.method === 'POST') throw new ApiError('后台任务不存在', 404, 'task_not_found'); return { projectId: 'p', actions: [failed, lost] } }
    let outcome: unknown
    await act(async () => { outcome = await answerTask(task(failed), 'drop') })
    await settle()
    expect(outcome).toEqual({ ok: false, message: '后台任务不存在' })
    expect(waiting().sort()).toEqual(['f1', 'r1'])
    expect(toasts().at(-1)).toMatchObject({ text: '后台任务不存在', tone: 'danger' })
  })

  it('keeps a run with nothing left to carry on answered when the host refuses 接着做 after marking it', async () => {
    respond = call => { if (call.method === 'POST') throw new ApiError('这项后台工作的记录已经失效，没法接着做了。可以直接在对话里说要做什么。', 409, 'task_context_revoked'); return { projectId: 'p', actions: [failed, lost] } }
    await act(async () => { await answerTask(task(lost), 'continue') })
    await settle()
    expect(waiting()).toEqual(['f1'])
    expect(toasts().at(-1)).toMatchObject({ tone: 'default' })
  })
})

describe('setPlanStatus', () => {
  it('takes a line off the open plan at once, PATCHes its status and offers 撤销', async () => {
    expect(openPlan()).toEqual(['pl-a', 'pl-b'])
    hold = true
    let done: Promise<unknown> = Promise.resolve()
    await act(async () => { done = setPlanStatus(planLine('pl-a'), 'dropped') })
    expect(openPlan()).toEqual(['pl-b'])
    await release(); await done
    expect(calls).toEqual([{ method: 'PATCH', path: '/api/v2/projects/p/mind/agenda/pl-a', body: { status: 'dropped' } }])
    const undo = toasts().at(-1)!
    expect(undo).toMatchObject({ text: '好，这项不做了。', action: { label: '撤销' } })
    hold = false
    await act(async () => { undo.action!.run(); await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(calls.at(-1)).toEqual({ method: 'PATCH', path: '/api/v2/projects/p/mind/agenda/pl-a', body: { status: 'open' } })
    expect(openPlan()).toEqual(['pl-a', 'pl-b'])
  })

  it('reads a line marked done under 已完成 until the summary has it', async () => {
    await act(async () => { await setPlanStatus(planLine('pl-b'), 'done') })
    expect(seen.find(row => row.id === 'pl-b')).toMatchObject({ state: 'done', stateLabel: '已完成' })
    expect(toasts().at(-1)?.text).toBe('已标记完成。')
    // The summary catches up (the row moved to done with a new time): the summary's row is shown.
    act(() => useApp.setState({ projects: { p: { ...project(), plan: { doing: project().plan!.doing, next: [], done: [{ id: 'pl-b', text: '如实计字', status: 'done', updatedAt: '2026-10-03T10:00:00Z' }] } } } }))
    expect(seen.filter(row => row.id === 'pl-b')).toHaveLength(1)
  })

  it('puts the line back when the host refuses', async () => {
    respond = () => { throw new ApiError('条目不存在', 404) }
    await act(async () => { await setPlanStatus(planLine('pl-a'), 'done') })
    expect(openPlan()).toEqual(['pl-a', 'pl-b'])
    expect(toasts().at(-1)).toMatchObject({ text: '计划没有改：条目不存在', tone: 'danger' })
  })
})

describe('clearTasks', () => {
  it('settles rows one by one with progress, reports what failed and reads each project’s actions once', async () => {
    respond = call => {
      if (call.path.endsWith('/tasks/r1')) throw new ApiError('后台任务不存在', 404, 'task_not_found')
      return call.path.endsWith('/initiative/actions') ? { projectId: 'p', actions: [{ ...failed, attention: { acknowledgedAt: '2026-10-03T10:00:00Z' } }, lost] } : {}
    }
    const progress: number[] = []
    let result: Awaited<ReturnType<typeof clearTasks>> | null = null
    await act(async () => { result = await clearTasks([task(failed), task(lost), planLine('pl-a')], done => progress.push(done)) })
    await settle()
    expect(calls.map(call => `${call.method} ${call.path} ${JSON.stringify(call.body ?? null)}`)).toEqual([
      'POST /api/v2/projects/p/tasks/f1 {"choice":"drop"}',
      'POST /api/v2/projects/p/tasks/r1 {"choice":"drop"}',
      'PATCH /api/v2/projects/p/mind/agenda/pl-a {"status":"dropped"}',
      'GET /api/projects/p/initiative/actions null',
    ])
    expect(progress).toEqual([1, 2, 3])
    expect(result!.cleared.map(row => row.id)).toEqual(['f1', 'pl-a'])
    expect(result!.failed).toEqual([{ task: expect.objectContaining({ id: 'r1' }), message: '后台任务不存在' }])
    // No toast per row: the dialog reports the batch.
    expect(toasts()).toEqual([])
    expect(waiting()).toEqual(['r1'])
    expect(openPlan()).toEqual(['pl-b'])
  })

  it('waits for each row before the next', async () => {
    hold = true
    let done: Promise<unknown> = Promise.resolve()
    await act(async () => { done = clearTasks([task(failed), planLine('pl-a')]) })
    expect(calls.map(call => call.path)).toEqual(['/api/v2/projects/p/tasks/f1'])
    await release()
    expect(calls.map(call => call.path)).toEqual(['/api/v2/projects/p/tasks/f1', '/api/v2/projects/p/mind/agenda/pl-a'])
    await release(); await done
  })
})
