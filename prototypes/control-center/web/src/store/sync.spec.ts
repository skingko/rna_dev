import { beforeEach, describe, expect, it } from 'vitest'
import { setTransport } from '@/api/client'
import type { EventSourceLike, Transport } from '@/api/transport'
import type { Item, Session } from '@/api/types'
import { useApp } from './app-store'
import { flush, selectSession } from './sync'

const at = '2026-09-28T10:00:00.000Z'

class FakeSource implements EventSourceLike {
  readyState = 1
  onopen: ((ev: Event) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  listeners = new Map<string, ((ev: MessageEvent) => void)[]>()
  addEventListener(type: string, fn: (ev: MessageEvent) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]) }
  close() { this.readyState = 2 }
  emit(type: string, data: unknown) { for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) })) }
}

function setup(snapshot: Session, items: Record<string, Item> = {}) {
  const sources: FakeSource[] = []
  const requests: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const transport: Transport = {
    kind: 'mock',
    async request<T>(path: string): Promise<T> {
      requests.push(path)
      if (path.startsWith('/api/v2/sessions/s1/items/')) return items[path.split('/').pop()!] as T
      // The conversation opens on its tail window (B9).
      if (path === '/api/v2/sessions/s1?window=tail') { await gate; return structuredClone(snapshot) as T }
      throw new Error(`unexpected ${path}`)
    },
    openStream() { const s = new FakeSource(); sources.push(s); return s },
  }
  setTransport(transport)
  useApp.setState({ mode: 'v2', sessions: {}, sessionIndex: { s1: { id: 's1', title: 't', status: 'running' } }, selectedSessionId: null })
  return { sources, requests, release }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('session subscription ordering', () => {
  beforeEach(() => { void selectSession(null) })

  it('waits for hello, snapshots, then replays only events newer than the snapshot', async () => {
    const snapshot: Session = {
      id: 's1', title: 't', status: 'running', revision: 5,
      turns: [{ id: 't1', status: 'running', userItemId: 'u1', createdAt: at }],
      items: [{ id: 'u1', turnId: 't1', kind: 'user', text: 'hi', createdAt: at }, { id: 'a1', turnId: 't1', kind: 'assistant', text: 'Hel', createdAt: at, streaming: true }],
    }
    const { sources, requests, release } = setup(snapshot)
    await selectSession('s1')
    const source = sources[0]
    expect(requests).toEqual([]) // nothing fetched before hello
    source.emit('hello', { protocol: 2, revision: 5, seq: 100 })
    await tick()
    expect(requests).toEqual(['/api/v2/sessions/s1?window=tail'])
    // Arrive while the snapshot is in flight:
    source.emit('items.upsert', { revision: 4, sessionId: 's1', items: [{ id: 'a1', turnId: 't1', kind: 'assistant', text: 'STALE', createdAt: at }] })
    source.emit('delta', { sessionId: 's1', turnId: 't1', itemId: 'a1', block: 'text', offset: 3, append: 'lo' })
    source.emit('turns.upsert', { revision: 6, sessionId: 's1', turns: [{ id: 't1', status: 'completed', userItemId: 'u1', createdAt: at }] })
    release()
    await tick(); await tick()
    flush()
    const slice = useApp.getState().sessions.s1
    expect(slice.items.a1.text).toBe('Hello')          // stale upsert (rev 4 <= 5) dropped, delta applied
    expect(slice.turns.t1.status).toBe('completed')    // newer event replayed
    expect(slice.revision).toBe(6)
  })

  it('refetches only the gapped item, and scoped resyncs only their items', async () => {
    const snapshot: Session = {
      id: 's1', title: 't', status: 'running', revision: 1,
      turns: [{ id: 't1', status: 'running', userItemId: 'u1', createdAt: at }],
      items: [{ id: 'u1', turnId: 't1', kind: 'user', text: 'hi', createdAt: at }, { id: 'a1', turnId: 't1', kind: 'assistant', text: 'ab', createdAt: at, streaming: true }],
    }
    const fixed: Item = { id: 'a1', turnId: 't1', kind: 'assistant', text: 'abcdef', createdAt: at, streaming: true }
    const { sources, requests, release } = setup(snapshot, { a1: fixed })
    release()
    await selectSession('s1')
    sources[0].emit('hello', { protocol: 2, revision: 1, seq: 1 })
    await tick(); await tick()
    sources[0].emit('delta', { sessionId: 's1', turnId: 't1', itemId: 'a1', block: 'text', offset: 4, append: 'ef' })
    flush()
    await tick(); await tick()
    expect(requests.at(-1)).toBe('/api/v2/sessions/s1/items/a1')
    expect(useApp.getState().sessions.s1.items.a1.text).toBe('abcdef')

    sources[0].emit('resync', { reason: 'event_too_large', itemIds: ['a1'] })
    flush()
    await tick()
    expect(requests.filter(r => r === '/api/v2/sessions/s1?window=tail')).toHaveLength(1)
    expect(requests.at(-1)).toBe('/api/v2/sessions/s1/items/a1')
  })
})
