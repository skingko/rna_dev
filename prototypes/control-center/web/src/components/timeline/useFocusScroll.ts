/**
 * Consumes `timeline-focus` requests for the mounted session: scrolls the row
 * that renders the item into view (centered), releases bottom-follow so the
 * stream does not yank the reader away, and flashes the row. An item older
 * than the tail window held (B9) is paged in first (sync.ts loadThrough).
 */
import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { useApp } from '@/store/app-store'
import { loadThrough } from '@/store/sync'
import type { Row } from '@/store/session-model'
import { FOCUS_TTL_MS, clearTimelineFocus, flashElement, rowIndexForItem, useTimelineFocus } from './timeline-focus'

export function useFocusScroll({ sessionId, rows, virtualizer, scrollRef, following }: {
  sessionId: string
  rows: Row[]
  virtualizer: Virtualizer<HTMLDivElement, Element>
  scrollRef: RefObject<HTMLDivElement | null>
  following: MutableRefObject<boolean>
}) {
  const target = useTimelineFocus(s => (s.target?.sessionId === sessionId ? s.target : null))
  // Clearing the request re-renders; the settle/highlight timers must survive that, so they only stop on unmount.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  // The request whose item is being paged in: its time limit waits for the pages.
  const paging = useRef<number | null>(null)
  useEffect(() => () => timers.current.forEach(clearTimeout), [])
  useEffect(() => {
    if (!target) return
    if (Date.now() - target.at > FOCUS_TTL_MS && paging.current !== target.nonce) { clearTimelineFocus(target); return }
    const slice = useApp.getState().sessions[sessionId]
    const turnId = slice?.items[target.itemId]?.turnId ?? null
    const index = rowIndexForItem(rows, target.itemId, turnId)
    if (index < 0) {
      // Rows not loaded yet: retried when they change. Loaded, with older history not held: page back to the item.
      if (rows.length && slice?.window?.hasMore && !slice.items[target.itemId] && paging.current !== target.nonce) {
        paging.current = target.nonce
        void loadThrough(sessionId, target.itemId).then(found => { if (!found) clearTimelineFocus(target) }, () => clearTimelineFocus(target))
      }
      return
    }
    clearTimelineFocus(target)
    following.current = false
    virtualizer.scrollToIndex(index, { align: 'center' })
    timers.current.forEach(clearTimeout)
    timers.current = [
      // Measured heights can shift the first estimate; settle, then highlight.
      setTimeout(() => virtualizer.scrollToIndex(index, { align: 'center' }), 140),
      setTimeout(() => {
        const row = scrollRef.current?.querySelector(`[data-index="${index}"]`)
        const exact = row?.querySelector(`[data-item-id="${CSS.escape(target.itemId)}"]`)
        flashElement(exact ?? row?.firstElementChild ?? row)
      }, 320),
    ]
  }, [target, rows, sessionId, virtualizer, scrollRef, following])
}
