/**
 * When this browser last looked at each conversation, for the sidebar's
 * "new proactive message" dot (plan §2.4: the dot marks only what needs you
 * and new proactive messages, never each background step).
 * A conversation is seen while it is open in a visible window.
 */
import { create } from 'zustand'
import { useApp } from './app-store'

const KEY = 'rna.seen'
const read = (): { baseline: number; at: Record<string, number> } => {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (value && typeof value.baseline === 'number' && value.at && typeof value.at === 'object') return value
  } catch { /* private mode or damaged entry */ }
  // First run: everything before now counts as seen, so an upgrade does not light up every conversation.
  return { baseline: Date.now(), at: {} }
}

export const useSeen = create(read)

export function markSeen(sessionId: string) {
  const now = Date.now()
  useSeen.setState(s => ({ at: { ...s.at, [sessionId]: now } }))
  try { localStorage.setItem(KEY, JSON.stringify(useSeen.getState())) } catch { /* ignore */ }
}

/** A proactive message arrived after this browser last looked at the conversation. */
export const isUnseen = (lastInitiativeAt: string | null | undefined, seenAt: number) => Boolean(lastInitiativeAt) && Date.parse(lastInitiativeAt as string) > seenAt

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible'
const markOpen = () => { const id = useApp.getState().selectedSessionId; if (id && visible()) markSeen(id) }

// The open conversation stays seen: on switching to it, when a new message lands in it, and when the window comes back.
useApp.subscribe((state, previous) => {
  const id = state.selectedSessionId
  if (!id) return
  if (id !== previous.selectedSessionId || state.sessionIndex[id]?.lastInitiativeAt !== previous.sessionIndex[id]?.lastInitiativeAt) markOpen()
})
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', markOpen)
