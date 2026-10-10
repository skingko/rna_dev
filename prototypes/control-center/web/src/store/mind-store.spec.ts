import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setTransport } from '@/api/client'
import { ApiError, type RequestInit, type Transport } from '@/api/transport'
import type { ProjectMind } from '@/api/mind-api'
import { useApp } from './app-store'
import { applyMindEvent, deleteMindEntry, ensureMind, loadMind, mindOf, patchMindEntry, useMind } from './mind-store'

const at = '2026-09-28T10:00:00.000Z'
const mind = (): ProjectMind => ({
  projectId: 'p', lessons: [{ id: 'l1', kind: 'preference', text: 'short', status: 'active', createdAt: at }],
  agenda: [{ id: 'a1', kind: 'todo', text: 'do', status: 'open', createdAt: at }],
  commitments: [{ id: 'c1', request: 'fix', trigger: 'user_request', status: 'pending', overdueAt: '2020-01-01T00:00:00.000Z', createdAt: at }],
  threads: [], notes: { facts: [{ id: 'n1', text: 'fact', createdAt: at }], preferences: [] }, health: { learning: 'running' },
})

type Handler = (init: RequestInit) => unknown
function transport(routes: Record<string, Handler>, calls: string[] = []): Transport {
  return {
    kind: 'mock',
    async request<T>(path: string, init: RequestInit = {}): Promise<T> {
      const key = `${init.method ?? 'GET'} ${path}`
      calls.push(key)
      const route = Object.keys(routes).find(k => key.startsWith(k))
      if (!route) throw new ApiError('missing', 404)
      return routes[route](init) as T
    },
    openStream: () => { throw new Error('no streams') },
  }
}

beforeEach(() => {
  useMind.setState({ projects: {}, errors: {}, focus: null, busy: null })
  useApp.setState({ projects: { p: { id: 'p', name: 'P', counts: {} } } })
})

describe('mind store', () => {
  it('loads the mind, mirrors derived counts into the project summary and dedupes ensure()', async () => {
    const calls: string[] = []
    setTransport(transport({ 'GET /api/v2/projects/p/mind': () => mind() }, calls))
    await Promise.all([ensureMind('p'), ensureMind('p')])
    await ensureMind('p')
    expect(calls).toEqual(['GET /api/v2/projects/p/mind'])
    expect(mindOf('p')?.lessons).toHaveLength(1)
    expect(useApp.getState().projects.p.counts).toMatchObject({ lessons: 1, openAgenda: 1, pendingCommitments: 1, overdueCommitments: 1 })
  })

  it('marks older daemons unsupported', async () => {
    setTransport(transport({}))
    await loadMind('p')
    expect(useMind.getState().projects.p).toBe('unsupported')
    expect(mindOf('p')).toBeNull()
  })

  it('applies a PATCH optimistically and adopts the server entry', async () => {
    let seen: unknown = null
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    setTransport(transport({
      'GET /api/v2/projects/p/mind': () => mind(),
      'PATCH /api/v2/projects/p/mind/commitments/c1': async init => { seen = init.body; await gate; return { entry: { ...mind().commitments[0], status: 'resolved', resolvedBy: 'user' } } },
    }))
    await loadMind('p')
    const pending = patchMindEntry('p', 'commitments', 'c1', { status: 'resolved' })
    expect(mindOf('p')?.commitments[0].status).toBe('resolved')
    expect(useApp.getState().projects.p.counts).toMatchObject({ pendingCommitments: 0, overdueCommitments: 0 })
    release()
    expect(await pending).toBe(true)
    expect(seen).toEqual({ status: 'resolved' })
    expect(mindOf('p')?.commitments[0].resolvedBy).toBe('user')
  })

  it('rolls back a failed edit', async () => {
    setTransport(transport({
      'GET /api/v2/projects/p/mind': () => mind(),
      'PATCH /api/v2/projects/p/mind/lessons/l1': () => { throw new ApiError('nope', 500) },
    }))
    await loadMind('p')
    expect(await patchMindEntry('p', 'lessons', 'l1', { status: 'retired' })).toBe(false)
    expect(mindOf('p')?.lessons[0].status).toBe('active')
  })

  it('deletes notes from either list and restores them on failure', async () => {
    let fail = false
    setTransport(transport({
      'GET /api/v2/projects/p/mind': () => mind(),
      'DELETE /api/v2/projects/p/mind/notes/n1': () => { if (fail) throw new ApiError('nope', 500); return { ok: true } },
    }))
    await loadMind('p')
    fail = true
    expect(await deleteMindEntry('p', 'notes', 'n1')).toBe(false)
    expect(mindOf('p')?.notes.facts).toHaveLength(1)
    fail = false
    expect(await deleteMindEntry('p', 'notes', 'n1')).toBe(true)
    expect(mindOf('p')?.notes.facts).toHaveLength(0)
  })

  it('applies project.mind summaries: counts at once, a debounced refetch when loaded', async () => {
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      setTransport(transport({ 'GET /api/v2/projects/p/mind': () => mind() }, calls))
      applyMindEvent({ projectId: 'p', counts: { lessons: 4, overdueCommitments: 2 } })
      expect(useApp.getState().projects.p.counts).toMatchObject({ lessons: 4, overdueCommitments: 2 })
      await vi.runAllTimersAsync()
      expect(calls).toEqual([]) // never requested → no fetch
      await loadMind('p')
      applyMindEvent({ projectId: 'p', health: { learning: 'paused', reason: 'x' } })
      applyMindEvent({ projectId: 'p' })
      expect(mindOf('p')?.health).toEqual({ learning: 'paused', reason: 'x' })
      await vi.runAllTimersAsync()
      expect(calls).toEqual(['GET /api/v2/projects/p/mind', 'GET /api/v2/projects/p/mind'])
    } finally { vi.useRealTimers() }
  })
})
