import { beforeEach, describe, expect, it } from 'vitest'
import { setTransport } from '@/api/client'
import { ApiError, type EventSourceLike, type RequestInit, type Transport } from '@/api/transport'
import type { InboxEntry } from '@/api/communication-api'
import { usePanels } from '@/components/settings/panel-store'
import { useApp } from './app-store'
import { openInboxEntry, openSessionItem } from './deep-link'
import { appSettled, openNotificationTarget, useInbox } from './inbox-store'
import { askOwed } from './mind-store'
import { selectSession } from './sync'
import { useUi } from './ui-store'

const at = '2026-10-03T10:00:00.000Z'
const stub: EventSourceLike = { readyState: 1, onopen: null, onerror: null, addEventListener() {}, close() {} }

function transport(routes: Record<string, (init: RequestInit) => unknown>, calls: string[] = []): Transport {
  return {
    kind: 'mock',
    async request<T>(path: string, init: RequestInit = {}): Promise<T> {
      const key = `${init.method ?? 'GET'} ${path}`
      calls.push(key)
      const route = Object.keys(routes).find(k => key.startsWith(k))
      if (!route) throw new ApiError('missing', 404)
      return routes[route](init) as T
    },
    openStream: () => stub,
  }
}

const entry = (patch: Partial<InboxEntry> = {}): InboxEntry => ({ id: 'e1', kind: 'share', tier: 'inline', text: 'news', createdAt: at, status: 'unread', feedback: null, sessionId: 's-other', ...patch })
const toasts = () => useUi.getState().toasts.map(t => t.text)

beforeEach(async () => {
  await selectSession(null)
  useUi.setState({ view: 'inbox', toasts: [], inboxProject: null, invitationFocus: null })
  useInbox.setState({ projects: {}, focus: null, busy: null })
  usePanels.setState({ archive: null })
  useApp.setState({
    status: 'ready', mode: 'v2', emergency: false, maintenanceHeld: false,
    projects: { p: { id: 'p', name: 'P' }, old: { id: 'old', name: 'Old', archivedAt: at } },
    sessionIndex: {
      's-here': { id: 's-here', title: 'here', status: 'idle', projectId: 'p' },
      's-other': { id: 's-other', title: 'other', status: 'idle', projectId: 'p' },
      's-archived': { id: 's-archived', title: 'archived', status: 'idle', projectId: 'p', archivedAt: at },
      's-in-old': { id: 's-in-old', title: 'old', status: 'idle', projectId: 'old' },
    },
    sessions: {}, selectedSessionId: 's-here', selectedProjectId: 'p',
  })
})

describe('inbox deep links (UX audit F3, F24, F52)', () => {
  it('opens the conversation and says so when the delivered message is gone', async () => {
    setTransport(transport({ 'GET /api/v2/projects/p/inbox/e1': () => ({ projectId: 'p', entry: entry({ itemId: 'gone' }), location: null, digest: null, now: at }) }))
    expect(await openInboxEntry('p', 'e1')).toBeNull()
    expect(useApp.getState().selectedSessionId).toBe('s-other')
    expect(useUi.getState().view).toBe('chat')
    expect(toasts()).toEqual(['原消息已不在对话中，已打开它所在的会话。'])
  })

  it('opens the conversation of an inbox-only entry without a warning', async () => {
    setTransport(transport({ 'GET /api/v2/projects/p/inbox/e1': () => ({ projectId: 'p', entry: entry({ tier: 'inbox' }), location: null, digest: null, now: at }) }))
    await openInboxEntry('p', 'e1')
    expect(useApp.getState().selectedSessionId).toBe('s-other')
    expect(useUi.getState().view).toBe('chat')
    expect(toasts()).toEqual([])
  })
})

describe('archived conversations (UX audit F55)', () => {
  it('does not open an archived session from a thread link; offers the archive instead', async () => {
    useUi.setState({ view: 'chat' })
    expect(await openSessionItem('s-archived', 'i1')).toBe(false)
    expect(useApp.getState().selectedSessionId).toBe('s-here')
    const last = useUi.getState().toasts.at(-1)!
    expect(last.text).toBe('这段对话已归档，恢复后才能在里面继续。')
    last.action!.run()
    expect(usePanels.getState().archive).toBe('sessions')
  })

  it('treats a session of an archived project the same way', async () => {
    expect(await openSessionItem('s-in-old', 'i1')).toBe(false)
    expect(toasts()).toEqual(['这段对话所在的项目已归档，恢复后才能在里面继续。'])
  })

  it('keeps a bell entry of an archived session in the inbox, highlighted', async () => {
    useUi.setState({ view: 'files' })
    setTransport(transport({ 'GET /api/v2/projects/p/inbox/e1': () => ({ projectId: 'p', entry: entry({ sessionId: 's-archived', itemId: 'i1' }), location: { kind: 'message', sessionId: 's-archived', itemId: 'i1', turnId: null, index: 0, count: 1, sessionArchived: true }, digest: null, now: at }) }))
    await openInboxEntry('p', 'e1')
    expect(useApp.getState().selectedSessionId).toBe('s-here')
    expect(useUi.getState()).toMatchObject({ view: 'inbox', inboxProject: 'p' })
    expect(useInbox.getState().focus).toEqual({ projectId: 'p', entryId: 'e1' })
    expect(toasts()).toEqual(['这段对话已归档，恢复后才能在里面继续。'])
  })

  it('checks the entry\'s own conversation too when the located one cannot open (round 2)', async () => {
    useUi.setState({ view: 'files' })
    setTransport(transport({ 'GET /api/v2/projects/p/inbox/e1': () => ({ projectId: 'p', entry: entry({ sessionId: 's-archived', itemId: 'i1' }), location: { kind: 'digest', sessionId: 's-deleted-digest', itemId: 'd1', turnId: null, index: 0, count: 1 }, digest: null, now: at }) }))
    await openInboxEntry('p', 'e1')
    expect(useApp.getState().selectedSessionId).toBe('s-here')
    expect(useUi.getState()).toMatchObject({ view: 'inbox', inboxProject: 'p' })
    expect(useInbox.getState().focus).toEqual({ projectId: 'p', entryId: 'e1' })
    expect(toasts().at(-1)).toBe('这段对话已归档，恢复后才能在里面继续。')
  })
})

describe('desktop notification before the app is ready (UX audit C1)', () => {
  it('waits for the bootstrap, then opens the conversation instead of calling the project gone', async () => {
    const calls: string[] = []
    setTransport(transport({ 'POST /api/v2/projects/p/inbox/e1': () => ({ entry: entry({ status: 'read' }), unread: 0 }), 'GET /api/v2/projects/p/inbox/e1': () => null }, calls))
    const loaded = useApp.getState()
    useApp.setState({ status: 'loading', projects: {}, sessionIndex: {}, selectedSessionId: null })
    useUi.setState({ view: 'files' })
    const opening = openNotificationTarget({ projectId: 'p', sessionId: 's-other', entryId: 'e1' })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(toasts()).toEqual([])
    // startApp: ready, then the bootstrap and the remembered conversation in the same task.
    useApp.setState({ status: 'ready' })
    useApp.setState({ projects: loaded.projects, sessionIndex: loaded.sessionIndex })
    await selectSession('s-here')
    await opening
    expect(toasts()).toEqual([])
    expect(useApp.getState().selectedSessionId).toBe('s-other')
    expect(useUi.getState().view).toBe('chat')
    expect(calls).toContain('POST /api/v2/projects/p/inbox/e1')
  })

  it('gives up quietly when the bootstrap fails', async () => {
    useApp.setState({ status: 'loading' })
    const settled = appSettled()
    useApp.setState({ status: 'error' })
    expect(await settled).toBe(false)
  })
})

describe('Rna 欠你 N 件事 (UX audit F43)', () => {
  it('says when the cards will be asked if an emergency stop holds them', async () => {
    setTransport(transport({ 'POST /api/v2/projects/p/mind/commitments/ask': () => ({ sessionId: 's-other', overdue: 2, offered: 0 }) }))
    useApp.setState({ emergency: true })
    await askOwed('p')
    expect(useApp.getState().selectedSessionId).toBe('s-other')
    expect(useUi.getState().invitationFocus?.kind).toBe('commitment')
    expect(toasts()).toEqual(['急停或更新结束后，会在输入框上方逐件问你。'])
  })

  it('says the cards wait while the conversation is paused (round 2)', async () => {
    setTransport(transport({ 'POST /api/v2/projects/p/mind/commitments/ask': () => ({ sessionId: 's-other', overdue: 1, offered: 0 }) }))
    useApp.setState(s => ({ sessionIndex: { ...s.sessionIndex, 's-other': { ...s.sessionIndex['s-other'], status: 'paused' } } }))
    await askOwed('p')
    expect(useApp.getState().selectedSessionId).toBe('s-other')
    expect(toasts()).toEqual(['这段对话暂停着，恢复后会在输入框上方逐件问你。'])
  })

  it('opens the conversation without a hint when the cards can show (a draft no longer hides them)', async () => {
    setTransport(transport({ 'POST /api/v2/projects/p/mind/commitments/ask': () => ({ sessionId: 's-other', overdue: 1, offered: 1 }) }))
    await askOwed('p')
    expect(useUi.getState()).toMatchObject({ view: 'chat', invitationFocus: { kind: 'commitment' } })
    expect(toasts()).toEqual([])
  })
})
