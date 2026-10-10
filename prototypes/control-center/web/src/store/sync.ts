/**
 * Sync controller: bootstrap, per-session SSE subscription, frame-batched
 * event application, gap detection and resync, and user actions (writes).
 */
import { create } from 'zustand'
import { adoptLegacySession, api, clearLegacyCache, getTransport, loadBootstrap, loadCacheUsage, loadItem, loadOlderItems, loadSession, locateItem, type SendPayload } from '@/api/client'
import { ApiError, type EventSourceLike } from '@/api/transport'
import type { NotifyEvent } from '@/api/communication-api'
import type { MindEvent } from '@/api/mind-api'
import type {
  Bootstrap, DeltaEvent, HelloEvent, InboxEntry, IndexEvent, Item, ItemsRemoveEvent, ItemsUpsertEvent, ModelSelection,
  ResyncEvent, Session, SessionPage, SessionPatchEvent, SessionSummary, TurnPhaseEvent, TurnsUpsertEvent, WorkStepEvent,
} from '@/api/types'
import { WEB_PROTOCOL } from '@/api/types'
import { useApp } from './app-store'
import { recordWorkStep } from './background-live'
import {
  addOptimistic, applyDelta, createSlice, firstHeld, patchMeta, prependPage, removeItems, setPhase, upsertItems, upsertTurns, type SessionSlice,
} from './session-model'
import { fillComposer, takenBack, toast, useUi } from './ui-store'
import { isSideSession } from '@/lib/side-session'
import { t } from '@/i18n'
import { deletingProject, deletingSession } from './pending-deletes'
import { clearWorktreeChoice, loadWorktrees, newConversationWorktree, noteSession, noteTurns } from './isolation-store'

const get = useApp.getState
const set = useApp.setState

/* ------------------------------------------------------------ bootstrap */

function adoptBootstrap(bootstrap: Bootstrap) {
  // Entities being deleted in the background stay gone (pending-deletes.ts).
  const kept = bootstrap.projects.filter(p => !deletingProject(p.id))
  const projects = Object.fromEntries(kept.map(p => [p.id, p]))
  // S2: side chats (辅助对话) live in the side panel only, never in the session index.
  const listed = bootstrap.sessions.filter(s => !isSideSession(s) && !deletingSession(s.id))
  const sessionIndex = Object.fromEntries(listed.map(s => [s.id, s]))
  set({
    capabilities: bootstrap.capabilities ?? null,
    revision: bootstrap.revision,
    configuration: bootstrap.configuration ?? null,
    maintenanceHeld: Boolean(bootstrap.maintenance?.held),
    emergency: Boolean(bootstrap.emergency),
    projects,
    projectOrder: kept.map(p => p.id),
    sessionIndex,
    sessionOrder: sortSessions(listed).map(s => s.id),
  })
}

export function sortSessions(sessions: SessionSummary[]) {
  return [...sessions].sort((a, b) => (b.lastItemAt ?? b.updatedAt ?? '').localeCompare(a.lastItemAt ?? a.updatedAt ?? ''))
}

export async function startApp() {
  try {
    const { bootstrap, mode } = await loadBootstrap()
    set({ mode, status: 'ready', error: null })
    adoptBootstrap(bootstrap)
    startIndex()
    const params = new URLSearchParams(location.search)
    const remembered = params.get('session') ?? safeStorage('rna.session')
    const summary = remembered ? get().sessionIndex[remembered] : undefined
    // An archived conversation (or one in an archived project) is hidden from the sidebar and refuses
    // messages: never land in it on launch; its project, if still open, starts a new conversation.
    const owner = summary?.projectId ? get().projects[summary.projectId] : undefined
    const initial = summary && !summary.archivedAt && !owner?.archivedAt ? summary.id : null
    if (initial) await selectSession(initial)
    else {
      const linked = params.get('project') ?? (owner && !owner.archivedAt ? owner.id : null)
      const project = linked && get().projects[linked] && !get().projects[linked].archivedAt ? linked : null
      set({ selectedProjectId: project ?? get().projectOrder.find(id => !get().projects[id].archivedAt) ?? null })
    }
    void refreshCache()
  } catch (error) {
    set({ status: 'error', error: (error as Error).message, connection: 'offline' })
  }
}

function safeStorage(key: string) {
  try { return localStorage.getItem(key) } catch { return null }
}

/* ------------------------------------------------------------- selection */

/**
 * One live subscription. Contract order (A1): open the stream, wait for
 * `hello`, then GET the snapshot; events that arrive meanwhile are buffered
 * and replayed, dropping persisted events whose revision the snapshot
 * already covers. Native auto-reconnects resume from Last-Event-ID (the
 * server replays or sends `resync`), so they do not refetch.
 */
interface Subscription {
  sessionId: string
  source: EventSourceLike
  state: 'waiting' | 'loading' | 'live'
  buffer: Queued[]
  opened: number
  /** An event with an id arrived: a reconnect sends Last-Event-ID and resumes; before that it can only re-read. */
  sawId: boolean
  /**
   * B9: a read of the conversation keeps the older pages the reader holds (`from`): every read after this
   * subscription's first, and the first one of a tab shown again. A conversation opened afresh reads the tail.
   */
  keep: boolean
}

let sub: Subscription | null = null

export async function selectSession(id: string | null) {
  if (!id) {
    set({ selectedSessionId: null })
    closeSessionStream()
    return
  }
  const summary = get().sessionIndex[id]
  set({ selectedSessionId: id, selectedProjectId: summary?.projectId ?? get().selectedProjectId })
  try { localStorage.setItem('rna.session', id) } catch { /* ignore */ }
  openSessionStream(id)
}

export function selectProject(projectId: string | null) {
  set({ selectedProjectId: projectId, selectedSessionId: null })
  closeSessionStream()
}

function adoptSession(session: Session) {
  set(s => ({ sessions: { ...s.sessions, [session.id]: createSlice(session, s.sessions[session.id]) } }))
}

/**
 * Snapshot (the tail window, B9) + buffered replay. Used for the first hello and for full resyncs. A read that keeps
 * what is held asks for the window from the first item held, so older pages read before come back fresh, in place.
 */
async function snapshot(target: Subscription) {
  target.state = 'loading'
  try {
    const held = target.keep ? get().sessions[target.sessionId] : undefined
    const from = held?.window ? firstHeld(held) ?? null : null
    const session = await loadSession(target.sessionId, get().mode ?? 'legacy', { from })
    if (sub !== target) return
    target.keep = true
    adoptSession(session)
    const covered = session.revision ?? -1
    const replay = target.buffer.splice(0).filter(event => !('data' in event) || !('revision' in event.data) || typeof event.data.revision !== 'number' || event.data.revision > covered)
    target.state = 'live'
    for (const event of replay) queue.push(event)
    if (queue.length) enqueue({ type: 'noop' })
  } catch (error) {
    if (sub !== target) return
    target.state = 'live'
    toast(t('会话加载失败：{message}', { message: (error as Error).message }), 'danger')
  }
}

/* --------------------------------------------------------------- streams */

let indexStream: EventSourceLike | null = null
let legacyIndexTimer: ReturnType<typeof setTimeout> | null = null

function reloadIndex() {
  legacyIndexTimer ??= setTimeout(async () => {
    legacyIndexTimer = null
    clearLegacyCache()
    try { const { bootstrap } = await loadBootstrap(); adoptBootstrap(bootstrap) } catch { /* keep last index */ }
  }, get().mode === 'legacy' ? 3000 : 50)
}

/* One index stream per browser. Every tab needs the project/session index, but
 * each EventSource holds one of the browser's few connections to this host, so
 * several open tabs used to stall every page. One tab (holding a Web Lock)
 * keeps the index stream and relays its events to the others over a
 * BroadcastChannel; when it closes, another tab takes over and catches up.
 * Session streams stay per tab and are released while a tab is hidden. */
const INDEX_EVENTS = ['hello', 'index', 'resync', 'notify', 'project.mind', 'work.step'] as const
type IndexEventType = (typeof INDEX_EVENTS)[number] | 'connection'
let relay: BroadcastChannel | null = null
let leading = false

const PROTOCOL_RELOAD_KEY = 'rna.protocolReload'
/**
 * The daemon speaks another index protocol than this page was built for (it was updated while the page stayed open):
 * load the UI it serves now. At most once per protocol and tab, so a page the daemon does not serve (a dev server
 * against an older daemon) never reloads in a loop; without session storage it does not reload at all.
 */
export function protocolReload(protocol: unknown, reload: () => void = () => location.reload()): boolean {
  if (typeof protocol !== 'number' || protocol === WEB_PROTOCOL) return false
  try {
    if (sessionStorage.getItem(PROTOCOL_RELOAD_KEY) === String(protocol)) return false
    sessionStorage.setItem(PROTOCOL_RELOAD_KEY, String(protocol))
  } catch { return false }
  reload()
  return true
}

function handleIndexEvent(type: IndexEventType, data: unknown) {
  if (type === 'connection') { if (!sub) set({ connection: data as ReturnType<typeof get>['connection'] }); return }
  // Bootstrap was read before this stream opened; catch up if we missed changes. Another protocol: another UI.
  if (type === 'hello') { const hello = data as HelloEvent | null; if (hello && protocolReload(hello.protocol)) return; if (hello && hello.revision > get().revision) reloadIndex(); return }
  if (type === 'index') { if (data) applyIndex(data as IndexEvent); return }
  if (type === 'resync') { reloadIndex(); return }
  // P3: `notify` reaches every connection; only the index stream handles it (no duplicates).
  if (type === 'notify') { if (data) for (const listener of notifyListeners) listener(data as NotifyEvent); return }
  // P-2: a background work tool started (display-only, like `notify` reaching every connection; only handled here).
  if (type === 'work.step') { if (data) recordWorkStep(data as WorkStepEvent); return }
  // v2 mind: summary + counts whenever a project's mind changes.
  if (type === 'project.mind' && data) for (const listener of mindListeners) listener(data as MindEvent)
}

function startIndex() {
  const shared = get().mode !== 'legacy' && getTransport().kind === 'live' && typeof BroadcastChannel !== 'undefined' && typeof navigator !== 'undefined' && Boolean(navigator.locks)
  if (!shared) { openIndexStream(); return }
  relay?.close()
  relay = new BroadcastChannel('rna-index-stream')
  relay.onmessage = event => {
    const message = event.data as { type?: IndexEventType | 'who'; data?: unknown } | null
    // A tab that just opened asks for the stream's state; the leader answers.
    if (message?.type === 'who') { if (leading) relay?.postMessage({ type: 'connection', data: get().connection }); return }
    if (message?.type) handleIndexEvent(message.type, message.data ?? null)
  }
  relay.postMessage({ type: 'who' })
  // The lock is held for this tab's lifetime once granted; followers wait in line.
  void navigator.locks.request('rna-index-stream', () => new Promise<void>(() => { openIndexStream(true) })).catch(() => openIndexStream())
}

function openIndexStream(leader = false) {
  indexStream?.close()
  const transport = getTransport()
  const legacy = get().mode === 'legacy'
  const source = transport.openStream(legacy ? '/api/stream' : '/api/v2/stream')
  indexStream = source
  leading = leader
  const share = (type: IndexEventType, data: unknown) => { if (leader) try { relay?.postMessage({ type, data }) } catch { /* channel closed */ } }
  source.onopen = () => { set({ connection: 'online' }); share('connection', 'online') }
  source.onerror = () => { const state = source.readyState === 2 ? 'offline' : 'connecting'; set({ connection: state }); share('connection', state) }
  if (legacy) {
    source.addEventListener('state', ev => {
      const data = parse<{ revision: number }>(ev)
      // Degraded mode: refresh the (heavy) legacy index at most every few seconds.
      if (data && data.revision !== get().revision) reloadIndex()
    })
    return
  }
  for (const type of INDEX_EVENTS) source.addEventListener(type, ev => { const data = type === 'resync' ? null : parse<unknown>(ev); handleIndexEvent(type, data); share(type, data) })
}

/* A hidden tab releases its session stream after a minute and reconnects (with
 * a fresh snapshot) when it is shown again. */
const HIDDEN_RELEASE_MS = 60_000
let hiddenTimer: ReturnType<typeof setTimeout> | null = null
let released: string | null = null
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenTimer ??= setTimeout(() => { hiddenTimer = null; if (sub && document.visibilityState === 'hidden') { released = sub.sessionId; closeSessionStream() } }, HIDDEN_RELEASE_MS)
    return
  }
  if (hiddenTimer) { clearTimeout(hiddenTimer); hiddenTimer = null }
  // The same conversation, still on screen: its read keeps the older pages the reader had (B9).
  if (released && get().selectedSessionId === released) openSessionStream(released, { keep: true })
  released = null
})

const mindListeners = new Set<(event: MindEvent) => void>()
/** Subscribe to `project.mind` events (index stream). */
export function onProjectMind(listener: (event: MindEvent) => void) {
  mindListeners.add(listener)
  return () => { mindListeners.delete(listener) }
}

const notifyListeners = new Set<(event: NotifyEvent) => void>()
/** Subscribe to `notify` events (desktop-notification tier deliveries). */
export function onNotify(listener: (event: NotifyEvent) => void) {
  notifyListeners.add(listener)
  return () => { notifyListeners.delete(listener) }
}

/** A conversation's worktree appeared, went or changed state (`session.worktree`, 0.63). */
const worktreeMoved = (before: SessionSummary['worktree'], after: SessionSummary['worktree']) => (before?.id ?? null) !== (after?.id ?? null) || (before?.state ?? null) !== (after?.state ?? null)

export function applyIndex(data: IndexEvent) {
  set(s => {
    const projects = { ...s.projects }
    const sessionIndex = { ...s.sessionIndex }
    let projectOrder = s.projectOrder
    for (const p of data.projects ?? []) { if (deletingProject(p.id)) continue; if (!projects[p.id]) projectOrder = [...projectOrder, p.id]; projects[p.id] = p }
    for (const row of data.sessions ?? []) {
      if (isSideSession(row) || deletingSession(row.id)) continue
      // 0.63: a conversation's worktree created, lost or kept: the project's worktree list is read again.
      if ('worktree' in row && worktreeMoved(sessionIndex[row.id]?.worktree, row.worktree)) noteSession(row.projectId ?? sessionIndex[row.id]?.projectId, { worktree: row.worktree })
      sessionIndex[row.id] = { ...sessionIndex[row.id], ...row }
    }
    for (const id of data.removed?.projects ?? []) delete projects[id]
    for (const id of data.removed?.sessions ?? []) delete sessionIndex[id]
    projectOrder = projectOrder.filter(id => projects[id])
    return {
      revision: data.revision, projects, projectOrder, sessionIndex, sessionOrder: sortSessions(Object.values(sessionIndex)).map(x => x.id),
      ...(data.configuration ? { configuration: data.configuration } : {}),
      ...(data.maintenance !== undefined ? { maintenanceHeld: Boolean(data.maintenance?.held) } : {}),
      ...(data.emergency !== undefined ? { emergency: Boolean(data.emergency) } : {}),
    }
  })
}

function closeSessionStream() {
  sub?.source.close()
  sub = null
  queue.length = 0
}

function openSessionStream(sessionId: string, { keep = false }: { keep?: boolean } = {}) {
  if (sub?.sessionId === sessionId) return
  closeSessionStream()
  const transport = getTransport()
  const legacy = get().mode === 'legacy'
  const source = transport.openStream(legacy ? `/api/stream?session=${encodeURIComponent(sessionId)}` : `/api/v2/stream?session=${encodeURIComponent(sessionId)}`)
  const current: Subscription = { sessionId, source, state: legacy ? 'live' : 'waiting', buffer: [], opened: 0, sawId: false, keep }
  sub = current
  source.onopen = () => { current.opened++; set({ connection: 'online' }) }
  source.onerror = () => set({ connection: source.readyState === 2 ? 'offline' : 'connecting' })

  if (legacy) {
    // The legacy per-session stream carries the complete session on every change.
    if (!get().sessions[sessionId]) void loadSession(sessionId, 'legacy').then(adoptSession).catch(() => {})
    source.addEventListener('state', ev => {
      const data = parse<{ revision: number; session?: Session }>(ev)
      if (!data?.session) return
      adoptLegacySession(data.session)
      enqueue({ type: 'legacy', session: data.session })
    })
    return
  }

  const on = <T,>(type: string, wrap: (data: T) => Queued) =>
    source.addEventListener(type, ev => { if (ev.lastEventId) current.sawId = true; const data = parse<T>(ev); if (data) enqueue(wrap(data)) })
  source.addEventListener('hello', () => {
    // First connection: take the snapshot now. Reconnects resume via Last-Event-ID; one that never received an id
    // sends none, so the host cannot replay what it missed: read again.
    if (current.opened <= 1 || current.state === 'waiting' || !current.sawId) void snapshot(current)
  })
  on<SessionPatchEvent>('session.patch', data => ({ type: 'patch', data }))
  on<ItemsUpsertEvent>('items.upsert', data => ({ type: 'upsert', data }))
  on<ItemsRemoveEvent>('items.remove', data => ({ type: 'remove', data }))
  on<TurnsUpsertEvent>('turns.upsert', data => ({ type: 'turns', data }))
  on<DeltaEvent>('delta', data => ({ type: 'delta', data }))
  on<TurnPhaseEvent>('turn.phase', data => ({ type: 'phase', data }))
  on<ResyncEvent>('resync', data => ({ type: 'resync', data }))
  on<IndexEvent>('index', data => { applyIndex(data); return { type: 'noop' } })
}

function parse<T>(ev: MessageEvent): T | null {
  try { return JSON.parse(ev.data) as T } catch { return null }
}

/* ------------------------------------------------ frame-batched apply */

export type Queued =
  | { type: 'patch'; data: SessionPatchEvent }
  | { type: 'upsert'; data: ItemsUpsertEvent }
  | { type: 'remove'; data: ItemsRemoveEvent }
  | { type: 'turns'; data: TurnsUpsertEvent }
  | { type: 'delta'; data: DeltaEvent }
  | { type: 'phase'; data: TurnPhaseEvent }
  | { type: 'resync'; data: ResyncEvent }
  | { type: 'legacy'; session: Session }
  | { type: 'noop' }

const queue: Queued[] = []
let scheduled = false

function enqueue(event: Queued) {
  if (sub && sub.state !== 'live' && event.type !== 'legacy') {
    sub.buffer.push(event)
    return
  }
  queue.push(event)
  if (scheduled) return
  scheduled = true
  // One store commit per frame no matter how many deltas arrived.
  const schedule = typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible'
    ? requestAnimationFrame
    : (fn: () => void) => setTimeout(fn, 16)
  schedule(flush)
}

export function flush() {
  scheduled = false
  const current = sub
  if (!current || queue.length === 0) { queue.length = 0; return }
  const sessionId = current.sessionId
  const events = queue.splice(0)
  let slice = get().sessions[sessionId]
  let legacySession: Session | null = null
  const gaps = new Set<string>()
  let full = false
  let index = false
  for (const event of events) {
    if (event.type === 'legacy') { legacySession = event.session; continue }
    if (event.type === 'noop') continue
    // 0.63: apply records and worktrees the host changed are read again where they are shown (isolation-store).
    if (event.type === 'turns' && slice) noteTurns(sessionId, slice.meta.projectId, event.data.turns, slice.turns)
    if (event.type === 'patch' && slice && 'worktree' in event.data.fields && worktreeMoved(slice.meta.worktree, event.data.fields.worktree)) noteSession(slice.meta.projectId, event.data.fields)
    if (event.type === 'resync') {
      const d = event.data ?? {}
      if (d.projectIds?.length || d.sessionIds?.length) index = true
      if (d.itemIds?.length && !d.turnIds?.length && !d.fields?.length) d.itemIds.forEach(id => gaps.add(id))
      else if (!d.projectIds?.length && !d.sessionIds?.length) full = true
      continue
    }
    if (!slice) { full = true; continue }
    // B9: a rewind that cut into history the window never held removes all that is held, in one event or in the last
    // of the 1,000-id chunks a long rewind arrives in (that one may name only held items): read the tail again.
    if (event.type === 'remove' && slice.window?.hasMore) {
      slice = reduce(slice, event)
      if (!firstHeld(slice)) full = true
      continue
    }
    if (event.type === 'delta') {
      if (event.data.sessionId !== sessionId) continue
      const result = applyDelta(slice, event.data)
      // A gap (offset beyond local text) refetches just that item.
      if (result.status === 'gap') { gaps.add(event.data.itemId); continue }
      slice = result.slice
      continue
    }
    slice = reduce(slice, event)
  }
  if (legacySession) { adoptSession(legacySession); return }
  if (slice) set(s => ({ sessions: { ...s.sessions, [sessionId]: slice! } }))
  if (index) reloadIndex()
  if (full) void snapshot(current)
  else if (gaps.size) void refetchItems(current, [...gaps])
}

export function reduce(slice: SessionSlice, event: Queued): SessionSlice {
  switch (event.type) {
    case 'delta': return event.data.sessionId === slice.meta.id ? applyDelta(slice, event.data).slice : slice
    case 'upsert': return { ...upsertItems(slice, event.data.items, event.data.revision), revision: Math.max(slice.revision, event.data.revision) }
    case 'remove': return { ...removeItems(slice, event.data.ids, event.data.revision), revision: Math.max(slice.revision, event.data.revision) }
    case 'turns': return { ...upsertTurns(slice, event.data.turns), revision: Math.max(slice.revision, event.data.revision) }
    case 'patch': return { ...patchMeta(slice, event.data.fields), revision: Math.max(slice.revision, event.data.revision) }
    case 'phase': return setPhase(slice, event.data.turnId, { phase: event.data.phase, at: event.data.at, ...(event.data.preparing ? { preparing: true } : {}) })
    default: return slice
  }
}

/* ------------------------------------------------- older history (B9) */

/** Conversations reading a page of older history right now (the timeline shows it at the top). */
export const useOlderHistory = create<{ loading: Record<string, boolean> }>(() => ({ loading: {} }))
const olderLoads = new Map<string, Promise<boolean>>()
const setOlderLoading = (sessionId: string, loading: boolean) => useOlderHistory.setState(s => ({ loading: { ...s.loading, [sessionId]: loading } }))

/**
 * Reads the page of older items just before the first one held (GET …/items?before=, zcode rows/range) and puts it in
 * front. One read per conversation at a time; resolves whether anything came. If the anchor is gone (a rewind removed
 * it meanwhile) the tail is read again. A page that no longer fits when it lands — a full read of the conversation
 * replaced the slice (harness loadThrough: a window replacement discards buffered pages), or the stream removed the
 * anchor — is dropped and read again from the new first item.
 */
export function loadOlder(sessionId: string): Promise<boolean> {
  const running = olderLoads.get(sessionId)
  if (running) return running
  const slice = get().sessions[sessionId]
  if (!slice?.window?.hasMore || !firstHeld(slice) || get().mode === 'legacy') return Promise.resolve(false)
  setOlderLoading(sessionId, true)
  const task = readOlder(sessionId).finally(() => { olderLoads.delete(sessionId); setOlderLoading(sessionId, false) })
  olderLoads.set(sessionId, task)
  return task
}

async function readOlder(sessionId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const slice = get().sessions[sessionId], before = slice ? firstHeld(slice) : undefined
    if (!slice?.window?.hasMore || !before) return false
    let page: SessionPage
    try { page = await loadOlderItems(sessionId, before) } catch (error) {
      if (error instanceof ApiError && error.status === 404 && sub?.sessionId === sessionId) void snapshot(sub)
      else toast(t('更早的消息加载失败：{message}', { message: (error as Error).message }), 'danger')
      return false
    }
    let fits = null as boolean | null
    set(s => {
      const current = s.sessions[sessionId]
      if (!current) { fits = false; return {} }
      if (firstHeld(current) !== before || current.epoch !== slice.epoch) return {}
      fits = true
      return { sessions: { ...s.sessions, [sessionId]: prependPage(current, page) } }
    })
    if (fits !== null) return fits
  }
  return false
}

/**
 * Deep links (harness loadThrough): pages older history in until `itemId` is held. Resolves whether it is; an item
 * that is not in the conversation (the host says so) reads nothing.
 */
export async function loadThrough(sessionId: string, itemId: string): Promise<boolean> {
  const held = () => Boolean(get().sessions[sessionId]?.items[itemId])
  if (held() || !get().sessions[sessionId]?.window?.hasMore) return held()
  const position = await locateItem(sessionId, itemId).catch(() => null)
  if (!position) return held()
  // Each page brings at least one item (fewer than 200 when it starts at a turn boundary): never more pages than items.
  for (let pages = position.count; pages > 0 && !held() && get().sessions[sessionId]?.window?.hasMore; pages--) {
    if (!await loadOlder(sessionId)) break
  }
  return held()
}

/**
 * Views that read the whole conversation (the trajectory, the session-wide review, its file changes) page all of it
 * in: older pages until none is left, or until `signal` aborts (the view closed: no page after the one in flight).
 * Resolves whether everything is held.
 */
export async function loadAll(sessionId: string, signal?: AbortSignal): Promise<boolean> {
  const more = () => Boolean(get().sessions[sessionId]?.window?.hasMore)
  // Each page brings at least one item: never more pages than items.
  for (let pages = get().sessions[sessionId]?.window?.totalCount ?? 0; pages > 0 && more() && !signal?.aborted; pages--) {
    if (!await loadOlder(sessionId)) break
  }
  return !more()
}

async function refetchItems(target: Subscription, itemIds: string[]) {
  try {
    const items = (await Promise.all(itemIds.map(id => loadItem(target.sessionId, id)))).filter((i): i is Item => Boolean(i))
    if (sub !== target) return
    set(s => {
      const slice = s.sessions[target.sessionId]
      return slice ? { sessions: { ...s.sessions, [target.sessionId]: upsertItems(slice, items, slice.revision) } } : {}
    })
  } catch {
    if (sub === target) void snapshot(target)
  }
}

/* --------------------------------------------------------------- writes */

/* Cache meter (ComposerMeters): read at launch, again when the selected project changes, and after
 * turns end, at most every 30 s per project; a refresh asked for inside that window runs at its end. */
export const CACHE_REFRESH_MS = 30_000
let cacheRead: { projectId: string | null; at: number } | null = null
let cacheTimer: ReturnType<typeof setTimeout> | null = null

export async function refreshCache() {
  const projectId = get().selectedProjectId ?? null
  cacheRead = { projectId, at: Date.now() }
  if (cacheTimer) { clearTimeout(cacheTimer); cacheTimer = null }
  try {
    const cache = await loadCacheUsage('24h', projectId ?? undefined)
    // A slower answer for the project the user just left must not replace the current one.
    if ((get().selectedProjectId ?? null) === projectId) set({ cache })
  } catch { /* optional */ }
}

export function refreshCacheSoon() {
  const projectId = get().selectedProjectId ?? null
  if (!cacheRead || cacheRead.projectId !== projectId) { void refreshCache(); return }
  cacheTimer ??= setTimeout(() => { cacheTimer = null; void refreshCache() }, Math.max(0, cacheRead.at + CACHE_REFRESH_MS - Date.now()))
}

/** `continues`: the background task a "接着完成" taken back from the queue carries, sent again with it.
 * `sessionId`: the conversation it goes to when not the one in front (the user switched away while it was sending). */
export async function sendMessage(text: string, options: { sessionId?: string; delivery?: 'send' | 'steer' | 'followup'; mode?: string; modelSelection?: ModelSelection | null; attachments?: unknown[]; skillIds?: string[]; continues?: { actionId: string }; prepareAttachments?: (sessionId: string) => Promise<unknown[]>; onCreated?: (sessionId: string) => void } = {}) {
  let sessionId = options.sessionId ?? get().selectedSessionId
  const requestId = crypto.randomUUID()
  if (!sessionId) {
    const projectId = get().selectedProjectId ?? undefined
    // 在独立工作树中运行 (ComposerMenu): chosen for this new conversation only, never switched later.
    const worktree = await newConversationWorktree(projectId)
    const created = await api.createSession({ projectId, mode: options.mode ?? 'build', ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}), ...(worktree ? { worktree: true } : {}) })
      .catch((error: unknown) => {
        // Isolation went away since it was read (409 worktree_unavailable): read it again, so the switch says why.
        if (projectId && error instanceof ApiError && error.code === 'worktree_unavailable') void loadWorktrees(projectId)
        throw error
      })
    if (projectId) clearWorktreeChoice(projectId)
    set(s => ({
      sessionIndex: { ...s.sessionIndex, [created.id]: { ...created, itemCount: 0 } },
      sessionOrder: [created.id, ...s.sessionOrder],
      sessions: { ...s.sessions, [created.id]: createSlice({ ...created, items: created.items ?? [], turns: created.turns ?? [] }) },
    }))
    sessionId = created.id
    // Told before the switch, so the composer keeps the files and skills being sent with this message.
    options.onCreated?.(created.id)
    await selectSession(created.id)
  }
  // Files picked before the conversation existed upload now that it does.
  const uploaded = options.prepareAttachments ? await options.prepareAttachments(sessionId) : []
  const slice = get().sessions[sessionId]
  const running = slice && slice.meta.status !== 'idle'
  const delivery = options.delivery ?? (running ? 'steer' : 'send')
  const optimistic: Item | null = delivery === 'send'
    ? { id: `optimistic:${requestId}`, kind: 'user', text, createdAt: new Date().toISOString(), optimistic: true, turnId: null }
    : null
  if (optimistic && slice) set(s => ({ sessions: { ...s.sessions, [sessionId!]: addOptimistic(s.sessions[sessionId!], optimistic) } }))
  useUi.setState(s => ({ followSignal: s.followSignal + 1 }))
  const payload: SendPayload & { continues?: { actionId: string } } = { text, attachments: [...(options.attachments ?? []), ...uploaded], skillIds: options.skillIds ?? [], delivery, requestId, ...(options.continues ? { continues: options.continues } : {}) }
  try {
    const result = await api.sendMessage(sessionId, payload)
    if (result?.queued) toast(delivery === 'followup' ? t('已排队：当前轮次完成后开始。') : t('已接收：下一个步骤边界加入当前轮次。'))
    if (get().mode === 'legacy') { /* the legacy session stream will echo the new state */ }
  } catch (error) {
    if (optimistic) set(s => ({ sessions: { ...s.sessions, [sessionId!]: removeItems(s.sessions[sessionId!], [optimistic.id]) } }))
    throw error
  }
}

export async function controlSession(action: 'stop' | 'pause' | 'resume' | 'retry') {
  const id = get().selectedSessionId
  if (!id) return
  const result = await api.control(id, action)
  if (action === 'stop') {
    // Queued messages the turn never took come back into this conversation's composer, files and carried tasks included.
    const fill = takenBack((result?.recovered ?? []) as InboxEntry[])
    if (fill) { const { text, ...rest } = fill; fillComposer(text, { ...rest, sessionId: id }) }
    toast(fill ? t('本轮已停止，未消费消息已取回草稿。') : t('本轮已停止，可以继续这段对话。'))
  }
  return result
}

export async function updateSession(input: Record<string, unknown>) {
  const id = get().selectedSessionId
  if (!id) return
  const result = await api.patchSession(id, input)
  if (result) {
    set(s => {
      const slice = s.sessions[id]
      const fields = { title: result.title, mode: result.mode, model: result.model, modelSelection: result.modelSelection, modelConfig: result.modelConfig }
      return {
        sessions: slice ? { ...s.sessions, [id]: patchMeta(slice, fields) } : s.sessions,
        sessionIndex: { ...s.sessionIndex, [id]: { ...s.sessionIndex[id], ...fields } },
      }
    })
  }
}

export async function renameSession(id: string, title: string) {
  await api.patchSession(id, { title })
  set(s => ({
    sessionIndex: { ...s.sessionIndex, [id]: { ...s.sessionIndex[id], title } },
    sessions: s.sessions[id] ? { ...s.sessions, [id]: patchMeta(s.sessions[id], { title }) } : s.sessions,
  }))
}

export async function archiveSession(id: string) {
  await api.patchSession(id, { archived: true })
  set(s => ({ sessionIndex: { ...s.sessionIndex, [id]: { ...s.sessionIndex[id], archivedAt: new Date().toISOString() } } }))
  if (safeStorage('rna.session') === id) try { localStorage.removeItem('rna.session') } catch { /* ignore */ }
  if (get().selectedSessionId === id) await selectSession(null)
  toast(t('已归档，记录和草稿已保留。可在「已归档」中恢复。'))
}
