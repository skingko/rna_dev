import { beforeEach, describe, expect, it } from 'vitest'
import { setTransport } from '@/api/client'
import { ApiError, type Transport } from '@/api/transport'
import type { InboxEntry } from '@/api/communication-api'
import { useApp } from './app-store'
import { inboxAction, loadInbox, useInbox } from './inbox-store'

const at = '2026-09-28T10:00:00.000Z'
const entries: InboxEntry[] = [
  { id: 'a', kind: 'share', tier: 'inbox', text: 'A', createdAt: at, status: 'unread', feedback: null },
  { id: 'b', kind: 'share', tier: 'inline', text: 'B', createdAt: at, status: 'read', feedback: null },
]

function transport(routes: Record<string, (body: unknown) => unknown>): Transport {
  return {
    kind: 'mock',
    async request<T>(path: string, init: { body?: unknown } = {}): Promise<T> {
      const key = Object.keys(routes).find(k => path.startsWith(k))
      if (!key) throw new ApiError('missing', 404)
      return routes[key](init.body) as T
    },
    openStream: () => { throw new Error('no streams') },
  }
}

beforeEach(() => {
  useInbox.setState({ projects: {}, focus: null, busy: null })
  useApp.setState({ projects: { p: { id: 'p', name: 'P', counts: { inbox: 2, inboxUnread: 1 } } } })
})

describe('inbox store', () => {
  it('loads entries and marks the project unsupported on older daemons', async () => {
    setTransport(transport({ '/api/v2/projects/p/inbox': () => ({ projectId: 'p', unread: 1, total: 2, entries }) }))
    await loadInbox('p')
    expect(useInbox.getState().projects.p.list).toMatchObject({ total: 2 })
    setTransport(transport({}))
    await loadInbox('p')
    expect(useInbox.getState().projects.p.list).toBe('unsupported')
  })
  it('dismiss removes the entry from the active list and mirrors the unread count', async () => {
    setTransport(transport({
      '/api/v2/projects/p/inbox/a': body => ({ entry: { ...entries[0], status: 'dismissed', action: body }, unread: 0 }),
      '/api/v2/projects/p/inbox': () => ({ projectId: 'p', unread: 1, total: 2, entries }),
    }))
    await loadInbox('p')
    await inboxAction('p', 'a', 'dismiss')
    const list = useInbox.getState().projects.p.list
    expect(list !== 'unsupported' && list?.entries.map(e => e.id)).toEqual(['b'])
    expect(useApp.getState().projects.p.counts?.inboxUnread).toBe(0)
  })
})
