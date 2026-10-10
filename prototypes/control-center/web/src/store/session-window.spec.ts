/**
 * B9: a conversation opens on its tail window (GET /api/v2/sessions/:id?window=tail), pages older history in front
 * (…/items?before=&limit), and deep links page back to their item (loadThrough). The stream keeps working on the window:
 * an older item it changes is not appended at the end, and a rewind past the window reads the tail again.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { setTransport } from '@/api/client'
import { PendingAskStrip } from '@/components/composer/PendingAskStrip'
import { useTimelineFocus } from '@/components/timeline/timeline-focus'
import { ApiError, type EventSourceLike, type Transport } from '@/api/transport'
import type { GitStatus } from '@/api/git-api'
import type { Item, Session, SessionPage, Turn } from '@/api/types'
import { resetGitStatus, useChangedPaths } from '@/lib/workspace-changes'
import { useApp } from './app-store'
import { createSlice, knownItem, prependPage, removeItems, upsertItems, waitingCardIds } from './session-model'
import { watchSideSession } from './side-sync'
import { flush, loadAll, loadOlder, loadThrough, selectSession } from './sync'
import { useWholeHistory } from './use-whole-history'

class FakeSource implements EventSourceLike {
  readyState = 1
  onopen: ((ev: Event) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  listeners = new Map<string, ((ev: MessageEvent) => void)[]>()
  addEventListener(type: string, fn: (ev: MessageEvent) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]) }
  close() { this.readyState = 2 }
  emit(type: string, data: unknown, lastEventId = '') { for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data), lastEventId })) }
  open() { this.onopen?.(new Event('open')) }
}

const at = (n: number) => new Date(Date.parse('2026-10-05T00:00:00Z') + n * 1000).toISOString()
/** Turn n: a user message and an answer, items created at 2n and 2n+1. */
const turnItems = (n: number): Item[] => [{ id: `u${n}`, turnId: `t${n}`, kind: 'user', text: `q${n}`, createdAt: at(2 * n) }, { id: `a${n}`, turnId: `t${n}`, kind: 'assistant', text: `a${n}`, createdAt: at(2 * n + 1) }]
const turn = (n: number): Turn => ({ id: `t${n}`, status: 'completed', userItemId: `u${n}`, createdAt: at(2 * n) })
const ALL = 40
/** The host's view of a 40-turn conversation: the tail is the last 5 turns, pages are 4 turns (8 items). */
const host = {
  /** `from` (a user item held already) reaches the window back to it, as the host does. */
  tail(from: string | null = null): Session {
    const held = from && /^u\d+$/.test(from) ? Number(from.slice(1)) : ALL, start = Math.min(35, held)
    const n = Array.from({ length: ALL - start }, (_, i) => start + i)
    return { id: 's1', title: 't', status: 'idle', revision: 7, items: n.flatMap(turnItems), turns: n.map(turn), window: { totalCount: ALL * 2, firstItemId: 'u0', hasMore: start > 0 } }
  },
  page(before: string): SessionPage {
    const end = Number(before.slice(1)), start = Math.max(0, end - 4), n = Array.from({ length: end - start }, (_, i) => start + i)
    return { revision: 7, sessionId: 's1', items: n.flatMap(turnItems), turns: n.map(turn), hasMore: start > 0, totalCount: ALL * 2 }
  },
}

function setup({ pageGate, git }: { pageGate?: () => Promise<void> | undefined; git?: () => Promise<GitStatus> } = {}) {
  const sources: FakeSource[] = [], requests: string[] = []
  const transport: Transport = {
    kind: 'mock',
    async request<T>(path: string): Promise<T> {
      requests.push(path)
      const url = new URL(path, 'http://x')
      if (url.pathname === '/api/v2/sessions/s1' && url.searchParams.get('window') === 'tail') return host.tail(url.searchParams.get('from')) as T
      if (url.pathname === '/api/v2/projects/p1/git' && git) return await git() as T
      if (url.pathname === '/api/v2/sessions/s1/items') {
        await pageGate?.()
        const before = url.searchParams.get('before')!
        if (before === 'gone') throw new ApiError('条目不存在', 404)
        return host.page(before) as T
      }
      const item = url.pathname.match(/^\/api\/v2\/sessions\/s1\/items\/(\w+)$/)
      if (item) { const n = Number(item[1].slice(1)); if (!(n >= 0 && n < ALL)) throw new ApiError('条目不存在', 404); return { item: turnItems(n)[0], position: { index: 2 * n, count: ALL * 2 } } as T }
      throw new Error(`unexpected ${path}`)
    },
    openStream() { const s = new FakeSource(); sources.push(s); return s },
  }
  setTransport(transport)
  useApp.setState({ mode: 'v2', sessions: {}, sessionIndex: { s1: { id: 's1', title: 't', status: 'idle' } }, selectedSessionId: null })
  return { sources, requests }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const settle = async () => { for (let i = 0; i < 6; i++) await tick() }
const slice = () => useApp.getState().sessions.s1
async function open() {
  const f = setup()
  await selectSession('s1')
  f.sources[0].emit('hello', { protocol: 3, revision: 7, seq: 1 })
  await settle()
  return f
}

describe('session window model', () => {
  it('an older item the stream changes is held aside, and the page that brings it in keeps the newer version', () => {
    const base = createSlice(host.tail())
    expect(base.window?.hasMore).toBe(true)
    const older = { ...turnItems(3)[1], text: 'edited after the page was read' }
    const next = upsertItems(base, [older, { id: 'n1', kind: 'assistant', text: 'new', createdAt: at(999) }], 9)
    expect(next.order.at(-1)).toBe('n1')
    expect(next.items.a3).toBeUndefined()
    expect(next.outside?.a3.revision).toBe(9)
    const paged = prependPage(next, host.page('u4'))
    expect(paged.order.slice(0, 8)).toEqual(['u0', 'a0', 'u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
    expect(paged.items.a3.text).toBe('edited after the page was read')
    expect(paged.window).toMatchObject({ hasMore: false, totalCount: ALL * 2 })
    expect(paged.structure.rows[0]).toMatchObject({ type: 'turn', turnId: 't0', userItemId: 'u0' })
  })

  it('a conversation held whole appends what the stream sends, as before', () => {
    const whole = createSlice({ ...host.tail(), window: undefined })
    expect(upsertItems(whole, [turnItems(1)[0]]).order.at(-1)).toBe('u1')
  })

  it('a card older than the window that still waits is known, answered in place, and shown when its page comes', () => {
    const ask: Item = { id: 'ask', kind: 'question', text: '', createdAt: at(5), interaction: { id: 'i1', kind: 'question', status: 'pending', questions: [{ question: 'Which ending?' }] } } as Item
    const held = { ...turnItems(39)[0], id: 'hq', interaction: { id: 'i2', kind: 'permission', status: 'pending' } } as Item
    const base = createSlice({ ...host.tail(), items: [...host.tail().items, held], pinned: [ask] })
    expect(base.order).not.toContain('ask')
    expect(waitingCardIds(base)).toEqual(['ask', 'hq'])
    expect(knownItem(base, 'ask')?.interaction?.status).toBe('pending')
    // Answered from another tab: the stream's version replaces it aside (even one stamped later than the window's
    // first item), and it stops waiting.
    const answered = upsertItems(base, [{ ...ask, createdAt: at(999), interaction: { ...ask.interaction!, status: 'answered' } }], 9)
    expect(answered.order).not.toContain('ask')
    expect(waitingCardIds(answered)).toEqual(['hq'])
    // A rewind that removes it forgets it.
    expect(waitingCardIds(removeItems(base, ['ask']))).toEqual(['hq'])
    // Its page brings it into the timeline, the newer version winning.
    const withPage = prependPage(answered, { ...host.page('u4'), items: [ask, ...host.page('u4').items] })
    expect(withPage.order[0]).toBe('ask'); expect(withPage.items.ask.interaction?.status).toBe('answered'); expect(withPage.outside?.ask).toBeUndefined()
  })

  it('the composer strip points at a waiting card older than the window, and its button asks for it', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const ask = { id: 'ask', kind: 'question', text: '', createdAt: at(5), interaction: { id: 'i1', kind: 'question', status: 'pending', questions: [{ question: 'Which ending?' }] } } as Item
    useApp.setState({ sessions: { s1: createSlice({ ...host.tail(), pinned: [ask] }) } })
    useTimelineFocus.setState({ target: null })
    const element = document.createElement('div'); document.body.append(element)
    const root = createRoot(element)
    await act(async () => { root.render(createElement(PendingAskStrip, { sessionId: 's1' })) })
    expect(element.textContent).toContain('Which ending?')
    act(() => { element.querySelector('button')!.click() })
    expect(useTimelineFocus.getState().target).toMatchObject({ sessionId: 's1', itemId: 'ask' })
    act(() => root.unmount()); element.remove()
  })
})

describe('session window sync', () => {
  beforeEach(() => { void selectSession(null) })

  it('opens on the tail window and pages older history in front, one read at a time', async () => {
    const f = await open()
    expect(f.requests).toEqual(['/api/v2/sessions/s1?window=tail'])
    expect(slice().order[0]).toBe('u35')
    const [first, again] = [loadOlder('s1'), loadOlder('s1')]
    expect(await first).toBe(true); expect(await again).toBe(true)
    expect(f.requests.filter(path => path.includes('/items?'))).toEqual(['/api/v2/sessions/s1/items?before=u35&limit=200'])
    expect(slice().order.slice(0, 2)).toEqual(['u31', 'a31'])
    expect(slice().window?.hasMore).toBe(true)
  })

  it('a deep link pages back until its item is held; an item the host does not know reads no page', async () => {
    const f = await open()
    expect(await loadThrough('s1', 'u10')).toBe(true)
    expect(slice().items.u10).toBeTruthy()
    const pages = f.requests.filter(path => path.includes('/items?')).length
    expect(pages).toBe(7) // 35 → 31 → 27 → 23 → 19 → 15 → 11 → 7
    expect(await loadThrough('s1', 'u99')).toBe(false)
    expect(f.requests.filter(path => path.includes('/items?')).length).toBe(pages)
  })

  it('a rewind that removes everything held and more reads the tail again', async () => {
    const f = await open()
    const held = slice().order
    f.sources[0].emit('items.remove', { revision: 8, sessionId: 's1', ids: ['u20', 'a20', ...held] }, '10')
    flush(); await settle()
    expect(f.requests.filter(path => path.includes('?window=tail'))).toHaveLength(2)
    // A removal inside the window is applied in place.
    f.sources[0].emit('items.remove', { revision: 9, sessionId: 's1', ids: ['a39'] }, '11')
    flush(); await settle()
    expect(f.requests.filter(path => path.includes('?window=tail'))).toHaveLength(2)
  })

  it('a long rewind arriving in chunks reads the tail again when its last chunk names only held items', async () => {
    const f = await open()
    const held = slice().order
    // 1,000 ids: older items the page never held and two it holds; then the rest, all held.
    const older = Array.from({ length: 998 }, (_, i) => `old${i}`)
    f.sources[0].emit('items.remove', { revision: 8, sessionId: 's1', ids: [...older, ...held.slice(0, 2)] }, '10')
    flush(); await settle()
    expect(f.requests.filter(path => path.includes('?window=tail'))).toHaveLength(1)
    f.sources[0].emit('items.remove', { revision: 8, sessionId: 's1', ids: held.slice(2) }, '11')
    flush(); await settle()
    expect(f.requests.filter(path => path.includes('?window=tail'))).toHaveLength(2)
    expect(slice().order.length).toBeGreaterThan(0)
  })

  it('a re-read keeps the older pages the reader holds; opening the conversation afresh reads the tail', async () => {
    const f = await open()
    await loadOlder('s1'); await loadOlder('s1')
    expect(slice().order[0]).toBe('u27')
    f.sources[0].emit('resync', { reason: 'backlog' }, '20')
    flush(); await settle()
    expect(f.requests.at(-1)).toBe('/api/v2/sessions/s1?window=tail&from=u27')
    expect(slice().order[0]).toBe('u27'); expect(slice().window?.hasMore).toBe(true)
    // Another conversation, then back: a fresh open.
    await selectSession(null); await selectSession('s1')
    f.sources.at(-1)!.emit('hello', { protocol: 3, revision: 7, seq: 30 })
    await settle()
    expect(f.requests.at(-1)).toBe('/api/v2/sessions/s1?window=tail')
    expect(slice().order[0]).toBe('u35')
  })

  it('views that read the whole conversation page all of it in', async () => {
    const f = await open()
    expect(await loadAll('s1')).toBe(true)
    expect(slice().order[0]).toBe('u0'); expect(slice().order).toHaveLength(ALL * 2); expect(slice().window?.hasMore).toBe(false)
    expect(f.requests.filter(path => path.includes('/items?'))).toHaveLength(9)
    expect(await loadAll('s1')).toBe(true)
    expect(f.requests.filter(path => path.includes('/items?'))).toHaveLength(9)
  })

  it('a view holding the whole conversation pages it in while it shows, and not when it is off', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const f = await open()
    const element = document.createElement('div'); document.body.append(element)
    const root = createRoot(element)
    const View = ({ enabled }: { enabled: boolean }) => { useWholeHistory('s1', enabled); return null }
    await act(async () => { root.render(createElement(View, { enabled: false })) })
    await settle()
    expect(f.requests.filter(path => path.includes('/items?'))).toHaveLength(0)
    await act(async () => { root.render(createElement(View, { enabled: true })) })
    for (let i = 0; i < 20 && slice().window?.hasMore; i++) await act(async () => { await settle() })
    expect(slice().order[0]).toBe('u0'); expect(slice().window?.hasMore).toBe(false)
    act(() => root.unmount()); element.remove()
  })

  it('a view that closes stops paging after the page in flight', async () => {
    let release: () => void = () => {}
    const f = setup({ pageGate: () => new Promise<void>(resolve => { release = resolve }) })
    await selectSession('s1')
    f.sources[0].emit('hello', { protocol: 3, revision: 7, seq: 1 })
    await settle()
    const stop = new AbortController()
    const all = loadAll('s1', stop.signal)
    await settle()
    expect(f.requests.filter(path => path.includes('/items?'))).toHaveLength(1)
    stop.abort(); release(); await settle()
    expect(f.requests.filter(path => path.includes('/items?'))).toHaveLength(1)
    release()
    expect(await all).toBe(false)
    expect(slice().order[0]).toBe('u31')
  })

  it('a page read before a removal does not bring the removed line back', async () => {
    let release: () => void = () => {}
    const f = setup({ pageGate: () => new Promise<void>(resolve => { release = resolve }) })
    await selectSession('s1')
    f.sources[0].emit('hello', { protocol: 3, revision: 7, seq: 1 })
    await settle()
    const older = loadOlder('s1')
    await settle()
    // A background run is withdrawn while the page (read at revision 7) is on its way: its line, in that page, goes.
    f.sources[0].emit('items.remove', { revision: 8, sessionId: 's1', ids: ['a33'] }, '10')
    flush()
    release()
    expect(await older).toBe(true)
    expect(slice().order.slice(0, 8)).toEqual(['u31', 'a31', 'u32', 'a32', 'u33', 'u34', 'a34', 'u35'])
    expect(slice().items.a33).toBeUndefined()
  })

  it('a page that lands after a full read replaced the slice is dropped and read again from the new first item', async () => {
    let gate: Promise<void> | undefined, release: () => void = () => {}
    const f = setup({ pageGate: () => gate })
    await selectSession('s1')
    f.sources[0].emit('hello', { protocol: 3, revision: 7, seq: 1 })
    await settle()
    gate = new Promise<void>(resolve => { release = resolve })
    const older = loadOlder('s1')
    await settle()
    // A resync reads the conversation again while the page is on its way; the page from before it does not land on it.
    gate = undefined
    f.sources[0].emit('resync', { reason: 'backlog' }, '20')
    flush(); await settle()
    const epoch = slice().epoch
    release()
    expect(await older).toBe(true)
    expect(slice().epoch).toBe(epoch)
    expect(f.requests.filter(path => path.includes('/items?'))).toEqual(['/api/v2/sessions/s1/items?before=u35&limit=200', '/api/v2/sessions/s1/items?before=u35&limit=200'])
    expect(slice().order.slice(0, 2)).toEqual(['u31', 'a31'])
  })

  it('a page whose anchor was removed meanwhile reads the tail again', async () => {
    const f = await open()
    useApp.setState(s => ({ sessions: { ...s.sessions, s1: { ...s.sessions.s1, order: ['gone', ...s.sessions.s1.order], items: { ...s.sessions.s1.items, gone: { id: 'gone', kind: 'user', text: 'x', createdAt: at(1) } } } } }))
    expect(await loadOlder('s1')).toBe(false)
    await settle()
    expect(f.requests.filter(path => path.includes('?window=tail'))).toHaveLength(2)
  })

  it('a reconnect that never received an event id reads again; one that did resumes', async () => {
    const f = await open()
    const source = f.sources[0]
    source.open(); source.open() // the native reconnect
    source.emit('hello', { protocol: 3, revision: 7, seq: 2 })
    await settle()
    expect(f.requests.filter(path => path.includes('?window=tail'))).toHaveLength(2)
    source.emit('turns.upsert', { revision: 8, sessionId: 's1', turns: [turn(39)] }, '12')
    flush()
    source.open()
    source.emit('hello', { protocol: 3, revision: 8, seq: 13 })
    await settle()
    expect(f.requests.filter(path => path.includes('?window=tail'))).toHaveLength(2)
  })
})

describe('file marks without git (B9 review)', () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const repo: GitStatus = { repo: 'main', branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0, operation: null, files: { conflicted: [], staged: [], unstaged: [], untracked: [] } }
  let element: HTMLDivElement, root: ReturnType<typeof createRoot>
  beforeEach(() => { void selectSession(null); resetGitStatus(); element = document.createElement('div'); document.body.append(element); root = createRoot(element) })
  afterEach(() => { act(() => root.unmount()); element.remove() })
  const Marks = () => { useChangedPaths('p1', 's1'); return null }
  async function mount(git: () => Promise<GitStatus>) {
    const f = setup({ git })
    useApp.setState({ projects: { p1: { id: 'p1', name: 'P', workspacePath: '/w/p1' } }, sessionIndex: { s1: { id: 's1', title: 't', status: 'idle', projectId: 'p1' } } })
    await selectSession('s1')
    f.sources[0].emit('hello', { protocol: 3, revision: 7, seq: 1 })
    await settle()
    await act(async () => { root.render(createElement(Marks)) })
    return f
  }
  const pages = (f: { requests: string[] }) => f.requests.filter(path => path.includes('/items?')).length

  it('a repository pages nothing in, also while its first git read is on its way', async () => {
    let answer: (status: GitStatus) => void = () => {}
    const f = await mount(() => new Promise<GitStatus>(resolve => { answer = resolve }))
    await act(async () => { await settle() })
    expect(f.requests).toContain('/api/v2/projects/p1/git')
    expect(pages(f)).toBe(0)
    await act(async () => { answer(repo); await settle() })
    expect(pages(f)).toBe(0)
    expect(slice().window?.hasMore).toBe(true)
  })

  it('a plain folder pages the conversation in once git has said so', async () => {
    const f = await mount(async () => ({ ...repo, repo: 'none' }))
    for (let i = 0; i < 20 && slice().window?.hasMore; i++) await act(async () => { await settle() })
    expect(pages(f)).toBe(9)
    expect(slice().window?.hasMore).toBe(false)
  })
})

describe('side chats on the tail window (B9 review)', () => {
  beforeEach(() => { void selectSession(null) })
  // A released side chat keeps its stream for a 1.5 s grace period: the next test starts after it is gone.
  afterEach(async () => { await new Promise(resolve => setTimeout(resolve, 1600)) })

  async function openSide() {
    const f = setup()
    useApp.setState({ sessionIndex: {} })
    const release = watchSideSession('s1')
    f.sources[0].emit('hello', { protocol: 3, revision: 7, seq: 1 })
    await settle()
    return { ...f, release }
  }
  const tails = (f: { requests: string[] }) => f.requests.filter(path => path.includes('?window=tail'))

  it('shown again after its stream was let go, it keeps the older pages the reader holds', async () => {
    const f = await openSide()
    await loadOlder('s1')
    expect(slice().order[0]).toBe('u31')
    f.release()
    await new Promise(resolve => setTimeout(resolve, 1600))
    const again = watchSideSession('s1')
    f.sources.at(-1)!.emit('hello', { protocol: 3, revision: 7, seq: 9 })
    await settle()
    expect(tails(f).at(-1)).toBe('/api/v2/sessions/s1?window=tail&from=u31')
    expect(slice().order[0]).toBe('u31')
    again()
  })

  it('a rewind past its window reads the tail again', async () => {
    const f = await openSide()
    const held = slice().order
    f.sources[0].emit('items.remove', { revision: 8, sessionId: 's1', ids: ['u20', 'a20', ...held] }, '10')
    await settle(); await new Promise(resolve => setTimeout(resolve, 20)); await settle()
    expect(tails(f)).toHaveLength(2)
    expect(slice().order.length).toBeGreaterThan(0)
    f.release()
  })

  it('a reconnect that never received an event id reads again', async () => {
    const f = await openSide()
    const source = f.sources[0]
    source.open(); source.open()
    source.emit('hello', { protocol: 3, revision: 7, seq: 2 })
    await settle()
    expect(tails(f)).toHaveLength(2)
    f.release()
  })
})
