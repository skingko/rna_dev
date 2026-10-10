/** The web's isolation state (0.63): the new-conversation switch, shared reads, and reads again on the host's pushes. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setTransport } from '@/api/client'
import { ApiError, type RequestInit, type Transport } from '@/api/transport'
import type { RnaWorktrees } from '@/api/worktree-api'
import type { Session } from '@/api/types'
import { useApp } from './app-store'
import { loadApplies, loadWorktrees, newConversationWorktree, noteSession, noteTurns, resetIsolation, setWorktreeChoice, useIsolation, worktreeChoice } from './isolation-store'
import { applyIndex, reduce, sendMessage } from './sync'
import { createSlice } from './session-model'

let calls: string[] = []
let isolation: RnaWorktrees['isolation'] = { enabled: true, git: '2.39.5' }
let created: Record<string, unknown> | null = null
const transport: Transport = {
  kind: 'mock',
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    calls.push(`${init.method ?? 'GET'} ${path}`)
    if (path.endsWith('/worktrees')) return { isolation, worktrees: [] } as T
    if (path.includes('/applies')) return { applies: [] } as T
    if (path === '/api/sessions') {
      created = init.body as Record<string, unknown>
      if (created.worktree && !isolation.enabled) throw new ApiError('不可用', 409, 'worktree_unavailable')
      return { id: 's-new', title: '新会话', status: 'idle', projectId: 'p1', items: [], turns: [], ...(created.worktree ? { worktree: { id: 'wt-1', state: 'pending' } } : {}) } as T
    }
    if (path.endsWith('/messages')) return { queued: false } as T
    if (path.startsWith('/api/v2/sessions/')) return { id: 's-new', title: '新会话', status: 'idle', projectId: 'p1', items: [], turns: [] } as T
    return {} as T
  },
  openStream: () => ({ readyState: 1, onopen: null, onerror: null, addEventListener: () => {}, close: () => {} }),
}
const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

beforeEach(() => {
  calls = []; created = null; isolation = { enabled: true, git: '2.39.5' }
  resetIsolation(); setTransport(transport)
  useApp.setState({ mode: 'v2', projects: { p1: { id: 'p1', name: 'P', workspacePath: '/p', git: { sessionWorktreeDefault: false } } }, sessions: {}, sessionIndex: {}, sessionOrder: [], selectedProjectId: 'p1', selectedSessionId: null })
})
afterEach(() => resetIsolation())

describe('the new-conversation switch', () => {
  it('starts at the project’s default, follows the user’s choice, and is cleared once the conversation exists', async () => {
    expect(worktreeChoice('p1')).toBe(false)
    useApp.setState(s => ({ projects: { ...s.projects, p1: { ...s.projects.p1, git: { sessionWorktreeDefault: true } } } }))
    expect(worktreeChoice('p1')).toBe(true)
    setWorktreeChoice('p1', false)
    expect(worktreeChoice('p1')).toBe(false)
    setWorktreeChoice('p1', true)
    await sendMessage('改一下')
    expect(created).toMatchObject({ projectId: 'p1', worktree: true })
    // The next new conversation starts from the default again.
    expect(useIsolation.getState().choice).toEqual({})
  })

  it('a switch that is off sends no worktree field at all', async () => {
    await sendMessage('改一下')
    expect(created).not.toHaveProperty('worktree')
    expect(calls.some(call => call.endsWith('/worktrees'))).toBe(false)
  })

  it('a switch that is on is checked against isolation first: never a 409 on the first message', async () => {
    isolation = { enabled: false, reason: 'no_repository', git: '2.39.5' }
    setWorktreeChoice('p1', true)
    expect(await newConversationWorktree('p1')).toBe(false)
    await sendMessage('改一下')
    expect(created).not.toHaveProperty('worktree')
    expect(calls.filter(call => call.endsWith('/worktrees'))).toHaveLength(1)
  })
  it('isolation gone since it was read: the 409 reads it again, so the switch then says why', async () => {
    setWorktreeChoice('p1', true)
    await loadWorktrees('p1')
    isolation = { enabled: false, reason: 'no_repository', git: '2.39.5' }
    await expect(sendMessage('改一下')).rejects.toMatchObject({ code: 'worktree_unavailable' })
    await wait(0)
    expect(calls.filter(call => call.endsWith('/worktrees'))).toHaveLength(2)
    expect(useIsolation.getState().worktrees.p1.data?.isolation).toMatchObject({ enabled: false, reason: 'no_repository' })
  })
})

describe('shared reads, read again on pushes', () => {
  it('loads a project’s worktrees once at a time', async () => {
    await Promise.all([loadWorktrees('p1'), loadWorktrees('p1')])
    expect(calls.filter(call => call.endsWith('/worktrees'))).toHaveLength(1)
    await loadWorktrees('p1', { minAgeMs: 60_000 })
    expect(calls.filter(call => call.endsWith('/worktrees'))).toHaveLength(1)
  })

  it('an older host without the route: unsupported, not an error to show', async () => {
    setTransport({ ...transport, request: async () => { throw new ApiError('not found', 404) } })
    await loadWorktrees('p1')
    expect(useIsolation.getState().worktrees.p1).toMatchObject({ unsupported: true, data: null })
  })

  it('a turn’s apply or checkpoint moving reads the conversation’s records again — only when they were read', async () => {
    noteTurns('s1', 'p1', [{ apply: { status: 'applied', applyIds: ['a'] } }])
    await wait(300)
    expect(calls.filter(call => call.includes('/applies'))).toHaveLength(0)
    await loadApplies('p1', 's1')
    noteTurns('s1', 'p1', [{}])
    noteTurns('s1', 'p1', [{ apply: { status: 'applied', applyIds: ['a'] } }])
    noteTurns('s1', 'p1', [{ checkpoint: { state: 'taken' } }])
    await wait(300)
    expect(calls.filter(call => call.includes('/applies'))).toEqual(['GET /api/v2/projects/p1/applies?sessionId=s1&limit=500', 'GET /api/v2/projects/p1/applies?sessionId=s1&limit=500'])
    // A turn pushed for anything else (its usage, a subagent's row) with the same apply and checkpoint reads nothing.
    const before = { t1: { apply: { status: 'applied', applyIds: ['a'] }, checkpoint: null } }
    noteTurns('s1', 'p1', [{ id: 't1', apply: { status: 'applied', applyIds: ['a'] }, checkpoint: null }], before)
    await wait(300)
    expect(calls.filter(call => call.includes('/applies'))).toHaveLength(2)
    noteTurns('s1', 'p1', [{ id: 't1', apply: { status: 'applied', applyIds: ['a', 'b'] } }], before)
    await wait(300)
    expect(calls.filter(call => call.includes('/applies'))).toHaveLength(3)
  })

  it('sync passes turns and worktree changes on: a session’s worktree moving reads the worktrees again', async () => {
    await loadWorktrees('p1')
    noteSession('p1', { title: 'x' })
    await wait(300)
    expect(calls.filter(call => call.endsWith('/worktrees'))).toHaveLength(1)
    // Through the index stream: the same state twice reads once.
    applyIndex({ revision: 2, sessions: [{ id: 's1', title: 'S', status: 'idle', projectId: 'p1', worktree: { id: 'wt-1', state: 'active' } }] })
    applyIndex({ revision: 3, sessions: [{ id: 's1', title: 'S', status: 'idle', projectId: 'p1', worktree: { id: 'wt-1', state: 'active' } }] })
    await wait(300)
    expect(calls.filter(call => call.endsWith('/worktrees'))).toHaveLength(2)
    // Turns reduced from the session stream carry the apply fields through.
    const slice = createSlice({ id: 's1', title: 'S', status: 'idle', projectId: 'p1', items: [], turns: [] } as unknown as Session)
    const next = reduce(slice, { type: 'turns', data: { revision: 2, sessionId: 's1', turns: [{ id: 't1', status: 'completed', apply: { status: 'applied', applyIds: ['a'] } }] } })
    expect(next.turns.t1.apply).toEqual({ status: 'applied', applyIds: ['a'] })
  })
})
