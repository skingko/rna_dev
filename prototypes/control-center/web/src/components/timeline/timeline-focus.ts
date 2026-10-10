/**
 * Timeline scroll-to-item + highlight API. Anyone (inbox bell, digest chips,
 * search) calls `focusTimelineItem(sessionId, itemId)`; the mounted Timeline
 * for that session scrolls the containing row into view, releases bottom
 * follow and briefly highlights it. A request made before the session's rows
 * load waits (up to `FOCUS_TTL_MS`) and is consumed once the item appears.
 *
 * Use `openSessionItem()` from `@/store/deep-link` to also switch session/view.
 */
import { create } from 'zustand'
import type { Row } from '@/store/session-model'

export const FOCUS_TTL_MS = 8000

export interface TimelineFocusTarget { sessionId: string; itemId: string; nonce: number; at: number }
interface FocusState { target: TimelineFocusTarget | null }

export const useTimelineFocus = create<FocusState>(() => ({ target: null }))
let nonce = 0

export function focusTimelineItem(sessionId: string, itemId: string) {
  useTimelineFocus.setState({ target: { sessionId, itemId, nonce: ++nonce, at: Date.now() } })
}
export function clearTimelineFocus(target?: TimelineFocusTarget) {
  const current = useTimelineFocus.getState().target
  if (!target || current?.nonce === target.nonce) useTimelineFocus.setState({ target: null })
}

/** Index of the row that renders `itemId` (a turn's user/answer/step item, a standalone item, or a pending send). */
export function rowIndexForItem(rows: Row[], itemId: string, turnId?: string | null): number {
  const direct = rows.findIndex(row => {
    if (row.type === 'item') return row.itemId === itemId
    if (row.type === 'pending') return row.userItemId === itemId
    return row.userItemId === itemId || row.answerId === itemId
      || row.steps.some(step => (step.type === 'group' ? step.itemIds.includes(itemId) : step.itemId === itemId))
  })
  if (direct >= 0 || !turnId) return direct
  // Items folded into a turn without their own step (e.g. thinking) still belong to its row.
  return rows.findIndex(row => row.type === 'turn' && row.turnId === turnId)
}

/** Brief, motion-safe highlight of a rendered row (Web Animations; no stylesheet needed). */
export function flashElement(element: Element | null | undefined) {
  if (!(element instanceof HTMLElement) || typeof element.animate !== 'function') return
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  element.animate(
    [
      { boxShadow: '0 0 0 2px var(--accent)', backgroundColor: 'var(--accent-soft)', borderRadius: '12px' },
      { boxShadow: '0 0 0 2px var(--accent)', backgroundColor: 'var(--accent-soft)', borderRadius: '12px', offset: reduced ? 0.9 : 0.35 },
      { boxShadow: '0 0 0 2px transparent', backgroundColor: 'transparent', borderRadius: '12px' },
    ],
    { duration: reduced ? 1600 : 2400, easing: 'ease-out' },
  )
}
