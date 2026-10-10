/**
 * Connection budget (design 1.8, P1): the daemon speaks HTTP/1.1, so a page
 * gets about six live connections. A kept-alive body that streams (terminal,
 * agent browser, side chat) keeps its stream while shown and for a grace
 * period after it is hidden — switching back right away stays instant — then
 * lets it close, and resumes when shown again (a terminal from its last
 * sequence, a side chat from a fresh snapshot).
 */
import { useEffect, useState } from 'react'

export const STREAM_GRACE_MS = 30_000

/** Whether a body's live stream should be open now. */
export function useStreamWhileVisible(visible: boolean, grace = STREAM_GRACE_MS): boolean {
  const [lingering, setLingering] = useState(visible)
  useEffect(() => {
    if (visible) { setLingering(true); return }
    const timer = setTimeout(() => setLingering(false), grace)
    return () => clearTimeout(timer)
  }, [visible, grace])
  return visible || lingering
}

/**
 * Whether the user is typing outside `within` (the composer, a field, another editor). A body that the layout shows
 * without the user picking it — panels expanding, a run opening 后台任务, a conversation switch — must not take the
 * keyboard from there: keys meant for a message would land in a shell.
 */
export function typingElsewhere(within: Element | null | undefined): boolean {
  const active = typeof document === 'undefined' ? null : document.activeElement
  if (!(active instanceof HTMLElement) || active === document.body || within?.contains(active)) return false
  return Boolean(active.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'))
}
