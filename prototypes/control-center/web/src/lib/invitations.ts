/**
 * Composer invitations (plan 2026-09-30 §2.1, §2.1.1): which one to show, and
 * whether the user is there to see it. The host decides what is worth asking;
 * this decides when. Nothing here is shown to someone who is away, busy
 * typing, or has something more important above the composer.
 */
import { useEffect, useState } from 'react'
import type { Invitation } from '@/api/types'

/** Active = the window is visible and the user did something within this window. */
export const ACTIVE_WINDOW_MS = 10 * 60_000
const KINDS = new Set(['feedback', 'lesson', 'gene', 'commitment', 'schedule', 'task'])
/** Feedback concerns the reply just read, so it goes first; a lesson, then an evolution decision, can wait their turn. */
const ORDER: Record<string, number> = { feedback: 0, task: 1, commitment: 1, lesson: 2, gene: 3, schedule: 4 }

export interface InvitationGate {
  /** The session is idle (no turn running, paused or failed). */
  idle: boolean
  /** Something more important sits above the composer (maintenance, emergency stop, recovery, an open question card). */
  blocked: boolean
  /** The composer holds a draft: the user's words come first. */
  typing: boolean
  /** The user is there (visible and recently active). */
  engaged: boolean
}

/** `prefer`: a kind the user just asked to settle (it goes before the usual order). */
export function pickInvitation(list: Invitation[] | undefined, gate: InvitationGate, prefer: string | null = null): Invitation | null {
  if (!list?.length || !gate.idle || gate.blocked || gate.typing || !gate.engaged) return null
  const rank = (row: Invitation) => (prefer && row.kind === prefer ? -1 : ORDER[row.kind] ?? 9)
  return [...list].filter(row => KINDS.has(row.kind)).sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt))[0] ?? null
}

export function isEngaged({ visible, lastActivityAt, now }: { visible: boolean; lastActivityAt: number; now: number }) {
  return visible && now - lastActivityAt <= ACTIVE_WINDOW_MS
}

/* Presence, measured locally: any pointer, key, wheel or focus inside the app
 * counts as activity (focus events are captured, so returning to the composer
 * counts too). Subscribers are only told when the engaged state may change. */
let lastActivityAt = Date.now()
const listeners = new Set<() => void>()
const notify = () => { for (const listener of listeners) listener() }
function mark() {
  const quiet = Date.now() - lastActivityAt > 5000
  lastActivityAt = Date.now()
  if (quiet) notify()
}
if (typeof window !== 'undefined') {
  for (const type of ['pointerdown', 'keydown', 'wheel', 'focus']) window.addEventListener(type, mark, { capture: true, passive: true })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') lastActivityAt = Date.now(); notify() })
}

/** Is the user here right now? Re-evaluated on activity, visibility and once a minute. */
export function useEngaged(): boolean {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = () => setNow(Date.now())
    listeners.add(tick)
    const timer = window.setInterval(tick, 60_000)
    return () => { listeners.delete(tick); window.clearInterval(timer) }
  }, [])
  return isEngaged({ visible: typeof document === 'undefined' || document.visibilityState === 'visible', lastActivityAt, now })
}
