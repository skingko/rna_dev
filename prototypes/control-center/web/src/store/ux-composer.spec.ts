/**
 * UX audit 2026-10-03, composer (store side): one-shot composer fills (F1),
 * stop puts the taken-back queue into the draft, a host-posted 接着完成 with the
 * task it carries (F30), the cache meter is read again (F50), and launch never
 * reopens an archived conversation (F56).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTransport, setTransport } from '@/api/client'
import type { EventSourceLike, Transport } from '@/api/transport'
import type { Bootstrap } from '@/api/types'
import { useApp } from './app-store'
import { fillComposer, takePrefill, useUi } from './ui-store'
import { CACHE_REFRESH_MS, archiveSession, controlSession, refreshCacheSoon, selectSession, sendMessage, startApp } from './sync'

class FakeSource implements EventSourceLike {
  readyState = 1
  onopen: ((ev: Event) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  addEventListener() {}
  close() { this.readyState = 2 }
}

const at = '2026-10-03T10:00:00.000Z'
let requests: string[] = []
let bodies: Record<string, unknown>[] = []
let routes: Record<string, unknown> = {}
let previous: Transport

beforeEach(async () => {
  previous = getTransport(); requests = []; bodies = []; routes = {}
  setTransport({
    kind: 'mock',
    async request<T>(path: string, init?: { body?: unknown }): Promise<T> {
      requests.push(path)
      if (path.endsWith('/messages')) bodies.push(init?.body as Record<string, unknown>)
      const route = Object.keys(routes).find(prefix => path.startsWith(prefix))
      if (route) return structuredClone(routes[route]) as T
      if (path.startsWith('/api/v2/sessions/')) return new Promise<T>(() => {})
      return null as T
    },
    openStream() { return new FakeSource() },
  })
  localStorage.clear()
  await selectSession(null)
  useUi.setState({ prefill: null })
  useApp.setState({ mode: 'v2', sessions: {}, sessionIndex: {}, projects: {}, projectOrder: [], selectedSessionId: null, selectedProjectId: null, cache: null })
})
afterEach(() => { setTransport(previous); vi.useRealTimers() })

describe('composer fill', () => {
  it('is taken once', () => {
    fillComposer('梳理项目现状')
    expect(takePrefill()?.text).toBe('梳理项目现状')
    expect(takePrefill()).toBeNull()
  })
})

describe('stop', () => {
  it('puts the user\'s queued messages, with their files, into that conversation\'s composer (F30)', async () => {
    useApp.setState({ sessionIndex: { s1: { id: 's1', title: 't', status: 'running' } } })
    await selectSession('s1')
    routes['/api/sessions/s1/control'] = { recovered: [
      { id: 'm1', text: '把按钮改成蓝色', delivery: 'steer', attachments: [] },
      { id: 'm2', text: 'Subagent result for the model', delivery: 'steer', source: 'subagent', attachments: [] },
      { id: 'm3', text: '', delivery: 'followup', attachments: [{ id: 'a1', name: 'shot.png', type: 'image/png', size: 9 }] },
    ] }
    await controlSession('stop')
    const fill = takePrefill()
    expect(fill).toMatchObject({ text: '把按钮改成蓝色', append: true, sessionId: 's1', attachments: [{ id: 'a1', name: 'shot.png' }] })
    expect(useUi.getState().toasts.at(-1)?.text).toBe('本轮已停止，未消费消息已取回草稿。')
  })

  it('brings a 接着完成 the host posted back with the task it carries, never as plain text in the draft', async () => {
    useApp.setState({ sessionIndex: { s1: { id: 's1', title: 't', status: 'running' } } })
    await selectSession('s1')
    routes['/api/sessions/s1/control'] = { recovered: [
      { id: 'm1', text: '把按钮改成蓝色', delivery: 'steer', attachments: [] },
      { id: 'm2', text: '接着完成：整理第三章', delivery: 'followup', continues: { actionId: 'act-1' }, attachments: [] },
    ] }
    await controlSession('stop')
    expect(takePrefill()).toMatchObject({ text: '把按钮改成蓝色', append: true, sessionId: 's1', tasks: [{ text: '接着完成：整理第三章', continues: { actionId: 'act-1' } }] })
  })

  it('sends a carried task again with the message', async () => {
    useApp.setState({ sessionIndex: { s1: { id: 's1', title: 't', status: 'idle' } } })
    await selectSession('s1')
    routes['/api/sessions/s1/messages'] = {}
    await sendMessage('接着完成：整理第三章', { delivery: 'followup', continues: { actionId: 'act-1' } })
    await sendMessage('普通的话')
    expect(bodies).toMatchObject([{ text: '接着完成：整理第三章', delivery: 'followup', continues: { actionId: 'act-1' } }, { text: '普通的话' }])
    expect(bodies[1]).not.toHaveProperty('continues')
  })

  it('says nothing was taken back when only a subagent result was queued', async () => {
    useApp.setState({ sessionIndex: { s1: { id: 's1', title: 't', status: 'running' } } })
    await selectSession('s1')
    routes['/api/sessions/s1/control'] = { recovered: [{ id: 'm2', text: 'Subagent result', source: 'subagent', attachments: [] }] }
    await controlSession('stop')
    expect(takePrefill()).toBeNull()
    expect(useUi.getState().toasts.at(-1)?.text).toBe('本轮已停止，可以继续这段对话。')
  })
})

describe('new conversation', () => {
  it('tells the composer which conversation was created before switching to it', async () => {
    useApp.setState({ selectedProjectId: 'p1' })
    routes['/api/sessions/s-new/messages'] = {}
    routes['/api/sessions'] = { id: 's-new', title: '新会话', status: 'idle', projectId: 'p1', items: [], turns: [], createdAt: at }
    const seen: (string | null)[] = []
    await sendMessage('hi', { onCreated: id => seen.push(id, useApp.getState().selectedSessionId) })
    expect(seen).toEqual(['s-new', null])
    expect(useApp.getState().selectedSessionId).toBe('s-new')
  })
})

describe('cache meter refresh (F50)', () => {
  it('reads again for another project at once, and at most every 30 s for the same one', async () => {
    vi.useFakeTimers()
    const cacheReads = () => requests.filter(path => path.startsWith('/api/v2/usage/cache')).length
    useApp.setState({ selectedProjectId: 'pa' })
    refreshCacheSoon()
    expect(cacheReads()).toBe(1)
    refreshCacheSoon(); refreshCacheSoon()
    expect(cacheReads()).toBe(1)
    await vi.advanceTimersByTimeAsync(CACHE_REFRESH_MS)
    expect(cacheReads()).toBe(2)
    useApp.setState({ selectedProjectId: 'pb' })
    refreshCacheSoon()
    expect(cacheReads()).toBe(3)
    expect(requests.at(-1)).toContain('projectId=pb')
  })

  it('drops a slower answer for the project the user already left', async () => {
    let answer!: (value: unknown) => void
    setTransport({ kind: 'mock', request: <T,>() => new Promise<T>(resolve => { answer = resolve as (value: unknown) => void }), openStream: () => new FakeSource() })
    useApp.setState({ selectedProjectId: 'pc' })
    refreshCacheSoon()
    useApp.setState({ selectedProjectId: 'pd' })
    answer({ window: '24h', overall: { requests: 3 } })
    await Promise.resolve(); await Promise.resolve()
    expect(useApp.getState().cache).toBeNull()
  })
})

describe('launch (F56)', () => {
  const bootstrap = (archived: { session?: boolean; project?: boolean }): Bootstrap => ({
    protocol: 2, revision: 1,
    projects: [
      { id: 'p-old', name: 'Old', archivedAt: archived.project ? at : null },
      { id: 'p-other', name: 'Other', archivedAt: null },
    ],
    sessions: [{ id: 's-old', title: 'x', status: 'idle', projectId: 'p-old', archivedAt: archived.session ? at : null }],
  } as Bootstrap)

  it('does not reopen a remembered conversation that was archived; its project starts a new one', async () => {
    routes['/api/v2/bootstrap'] = bootstrap({ session: true })
    localStorage.setItem('rna.session', 's-old')
    await startApp()
    expect(useApp.getState().selectedSessionId).toBeNull()
    expect(useApp.getState().selectedProjectId).toBe('p-old')
  })

  it('does not reopen a conversation of an archived project', async () => {
    routes['/api/v2/bootstrap'] = bootstrap({ project: true })
    localStorage.setItem('rna.session', 's-old')
    await startApp()
    expect(useApp.getState().selectedSessionId).toBeNull()
    expect(useApp.getState().selectedProjectId).toBe('p-other')
  })

  it('still reopens a remembered open conversation', async () => {
    routes['/api/v2/bootstrap'] = bootstrap({})
    localStorage.setItem('rna.session', 's-old')
    await startApp()
    expect(useApp.getState().selectedSessionId).toBe('s-old')
  })

  it('forgets the remembered conversation when it is archived', async () => {
    useApp.setState({ sessionIndex: { s1: { id: 's1', title: 't', status: 'idle' } } })
    await selectSession('s1')
    routes['/api/sessions/s1'] = { id: 's1', title: 't', status: 'idle', items: [], turns: [] }
    await archiveSession('s1')
    expect(localStorage.getItem('rna.session')).toBeNull()
    expect(useApp.getState().selectedSessionId).toBeNull()
  })
})
