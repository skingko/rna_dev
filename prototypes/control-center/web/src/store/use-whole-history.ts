/**
 * B9: a conversation opens on its tail window. Views that read all of it (the trajectory, the session-wide review,
 * the conversation's changes, a non-git project's file marks) hold the whole conversation while they show: they page
 * the rest in (sync.ts loadAll), and again if a later read of the conversation came without it. A view that closes or
 * stops needing it (`enabled` false) stops the paging after the page in flight.
 */
import { useEffect } from 'react'
import { useApp } from './app-store'
import { loadAll } from './sync'

export function useWholeHistory(sessionId: string | null | undefined, enabled = true) {
  const missing = useApp(s => Boolean(enabled && sessionId && s.sessions[sessionId]?.window?.hasMore))
  useEffect(() => {
    if (!missing || !sessionId) return
    const stop = new AbortController()
    void loadAll(sessionId, stop.signal)
    return () => stop.abort()
  }, [missing, sessionId])
}
