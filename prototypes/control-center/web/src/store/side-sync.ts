/**
 * S2: live subscriptions for 辅助对话 sessions shown in side-panel tabs,
 * alongside (and independent of) the main conversation's subscription in
 * `sync.ts`. Same contract: open the session stream, snapshot on the first
 * `hello`, buffer events meanwhile, then apply them through the shared
 * reducers into `useApp.sessions[sideId]`. Ref-counted per session.
 *
 * B9, as sync.ts does for the main conversation: a side chat opens on its tail window; a read of it while a slice is
 * held (the tab shown again after its stream was let go, a resync) keeps the older pages the reader had (`from`); a
 * rewind that removes all that is held reads the tail again; a reconnect that never received an event id reads again.
 */
import { api, getTransport, loadSession, type SendPayload } from '@/api/client'
import type { EventSourceLike } from '@/api/transport'
import type { DeltaEvent, InboxEntry, Item, ItemsRemoveEvent, ItemsUpsertEvent, Session, SessionPatchEvent, TurnPhaseEvent, TurnsUpsertEvent } from '@/api/types'
import { useApp } from './app-store'
import { addOptimistic, applyDelta, createSlice, firstHeld, removeItems } from './session-model'
import { reduce, type Queued } from './sync'
import { toast } from './ui-store'
import { t } from '@/i18n'

interface SideSub {
  sessionId: string
  source: EventSourceLike
  state: 'waiting' | 'loading' | 'live'
  buffer: Queued[]
  queue: Queued[]
  scheduled: boolean
  refs: number
  opened: number
  /** An event with an id arrived: a reconnect sends Last-Event-ID and resumes; before that it can only re-read. */
  sawId: boolean
}

const subs = new Map<string, SideSub>()
const get = useApp.getState
const set = useApp.setState

function adopt(session: Session) {
  set(s => ({ sessions: { ...s.sessions, [session.id]: createSlice(session, s.sessions[session.id]) } }))
}

async function snapshot(sub: SideSub) {
  sub.state = 'loading'
  try {
    const held = get().sessions[sub.sessionId]
    const session = await loadSession(sub.sessionId, 'v2', { from: held?.window ? firstHeld(held) ?? null : null })
    if (subs.get(sub.sessionId) !== sub) return
    adopt(session)
    const covered = session.revision ?? -1
    const replay = sub.buffer.splice(0).filter(e => !('data' in e) || !('revision' in e.data) || typeof e.data.revision !== 'number' || e.data.revision > covered)
    sub.state = 'live'
    for (const event of replay) push(sub, event)
  } catch (error) {
    if (subs.get(sub.sessionId) !== sub) return
    sub.state = 'live'
    toast(t('辅助对话加载失败：{message}', { message: (error as Error).message }), 'danger')
  }
}

function push(sub: SideSub, event: Queued) {
  if (sub.state !== 'live') { sub.buffer.push(event); return }
  sub.queue.push(event)
  if (sub.scheduled) return
  sub.scheduled = true
  const schedule = typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible' ? requestAnimationFrame : (fn: () => void) => setTimeout(fn, 16)
  schedule(() => flushSide(sub))
}

function flushSide(sub: SideSub) {
  sub.scheduled = false
  if (subs.get(sub.sessionId) !== sub) return
  const events = sub.queue.splice(0)
  let slice = get().sessions[sub.sessionId]
  let full = false
  for (const event of events) {
    if (event.type === 'resync') { full = true; continue }
    if (!slice) { full = true; continue }
    // A rewind that cut into history the window never held removes all that is held (in one event, or in the last of
    // a long rewind's 1,000-id chunks): read the tail again.
    if (event.type === 'remove' && slice.window?.hasMore) {
      slice = reduce(slice, event)
      if (!firstHeld(slice)) full = true
      continue
    }
    if (event.type === 'delta') {
      if (event.data.sessionId !== sub.sessionId) continue
      const result = applyDelta(slice, event.data)
      if (result.status === 'gap') { full = true; continue }
      slice = result.slice
      continue
    }
    slice = reduce(slice, event)
  }
  if (slice) set(s => ({ sessions: { ...s.sessions, [sub.sessionId]: slice! } }))
  if (full) void snapshot(sub)
}

function open(sessionId: string): SideSub {
  const source = getTransport().openStream(`/api/v2/stream?session=${encodeURIComponent(sessionId)}`)
  const sub: SideSub = { sessionId, source, state: 'waiting', buffer: [], queue: [], scheduled: false, refs: 0, opened: 0, sawId: false }
  source.onopen = () => { sub.opened++ }
  const on = <T,>(type: string, wrap: (data: T) => Queued) => source.addEventListener(type, ev => {
    if (ev.lastEventId) sub.sawId = true
    try { push(sub, wrap(JSON.parse(ev.data) as T)) } catch { /* malformed frame */ }
  })
  // A reconnect resumes via Last-Event-ID; one that never received an id sends none, so the host cannot replay what it
  // missed: read again.
  source.addEventListener('hello', () => { if (sub.opened <= 1 || sub.state === 'waiting' || !sub.sawId) void snapshot(sub) })
  on<SessionPatchEvent>('session.patch', data => ({ type: 'patch', data }))
  on<ItemsUpsertEvent>('items.upsert', data => ({ type: 'upsert', data }))
  on<ItemsRemoveEvent>('items.remove', data => ({ type: 'remove', data }))
  on<TurnsUpsertEvent>('turns.upsert', data => ({ type: 'turns', data }))
  on<DeltaEvent>('delta', data => ({ type: 'delta', data }))
  on<TurnPhaseEvent>('turn.phase', data => ({ type: 'phase', data }))
  on<Record<string, unknown>>('resync', data => ({ type: 'resync', data }))
  return sub
}

/** Keep a side session live while a tab shows it. Returns the release function. */
export function watchSideSession(sessionId: string): () => void {
  let sub = subs.get(sessionId)
  if (!sub) { sub = open(sessionId); subs.set(sessionId, sub) }
  sub.refs++
  const held = sub
  return () => {
    held.refs--
    // Short grace period so a tab switch / StrictMode remount does not reconnect.
    setTimeout(() => {
      if (held.refs > 0 || subs.get(sessionId) !== held) return
      held.source.close()
      subs.delete(sessionId)
    }, 1500)
  }
}

/** Send in a side chat (optimistic echo like the main composer). */
export async function sendSideMessage(sessionId: string, text: string) {
  const requestId = crypto.randomUUID()
  const slice = get().sessions[sessionId]
  const running = Boolean(slice && slice.meta.status !== 'idle')
  const delivery: SendPayload['delivery'] = running ? 'steer' : 'send'
  const optimistic: Item | null = delivery === 'send' ? { id: `optimistic:${requestId}`, kind: 'user', text, createdAt: new Date().toISOString(), optimistic: true, turnId: null } : null
  if (optimistic && slice) set(s => ({ sessions: { ...s.sessions, [sessionId]: addOptimistic(s.sessions[sessionId], optimistic) } }))
  try {
    await api.sendMessage(sessionId, { text, attachments: [], skillIds: [], delivery, requestId })
  } catch (error) {
    if (optimistic && get().sessions[sessionId]) set(s => ({ sessions: { ...s.sessions, [sessionId]: removeItems(s.sessions[sessionId], [optimistic.id]) } }))
    throw error
  }
}

/** Stops the side chat's turn; returns the text of its queued messages the turn never took (they go back into its input). */
export async function stopSideSession(sessionId: string): Promise<string> {
  const result = await api.control(sessionId, 'stop')
  return ((result?.recovered ?? []) as InboxEntry[]).filter(entry => entry.source !== 'subagent').map(entry => entry.text?.trim()).filter(Boolean).join('\n\n')
}
