/**
 * Plan §2.5 item 10: a message written while the app is being updated is not
 * a draft to resend by hand. It waits here (this browser) and goes out by
 * itself once the update is done and the app is back.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { api, type SendPayload } from '@/api/client'
import { useApp } from './app-store'
import { isolationEnabled } from './isolation-store'

/**
 * `continues`: a "接着完成" taken back from the queue keeps the background task it carries. `worktree` (0.63): a new
 * conversation's 在独立工作树中运行, chosen when it was written; it is created so once the app is back (when the
 * project can still use worktrees, as sendMessage checks).
 */
export interface OutboxEntry { id: string; sessionId: string | null; projectId: string | null; text: string; createdAt: string; continues?: { actionId: string }; worktree?: boolean }
const KEY = 'rna.outbox'
const load = (): OutboxEntry[] => { try { const rows = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(rows) ? rows.filter(row => row && typeof row.text === 'string' && typeof row.id === 'string') : [] } catch { return [] } }
const save = (entries: OutboxEntry[]) => { try { if (entries.length) localStorage.setItem(KEY, JSON.stringify(entries)); else localStorage.removeItem(KEY) } catch { /* in memory only */ } }

export const useOutbox = create<{ entries: OutboxEntry[]; sending: boolean }>(() => ({ entries: load(), sending: false }))

export function queueOutbox(input: { sessionId: string | null; projectId: string | null; text: string; continues?: { actionId: string }; worktree?: boolean }) {
  const entry: OutboxEntry = { id: crypto.randomUUID(), sessionId: input.sessionId, projectId: input.projectId, text: input.text, createdAt: new Date().toISOString(), ...(input.continues ? { continues: input.continues } : {}), ...(input.worktree && !input.sessionId ? { worktree: true } : {}) }
  useOutbox.setState(s => { const entries = [...s.entries, entry].slice(-20); save(entries); return { entries } })
  return entry
}
export function dropOutbox(id: string) {
  useOutbox.setState(s => { const entries = s.entries.filter(row => row.id !== id); save(entries); return { entries } })
}

/** Mount once (App): when the app is ready and no longer held for maintenance, send what waited, in order. */
export function useOutboxFlush() {
  const status = useApp(s => s.status)
  const held = useApp(s => s.maintenanceHeld)
  const count = useOutbox(s => s.entries.length)
  useEffect(() => {
    if (status !== 'ready' || held || !count || useOutbox.getState().sending) return
    useOutbox.setState({ sending: true })
    void (async () => {
      for (const entry of [...useOutbox.getState().entries]) {
        try {
          let sessionId = entry.sessionId && useApp.getState().sessionIndex[entry.sessionId] ? entry.sessionId : null
          if (!sessionId) {
            // The new conversation's worktree choice, kept with the message (dropped where isolation went away since).
            const worktree = Boolean(entry.worktree && entry.projectId && await isolationEnabled(entry.projectId))
            sessionId = (await api.createSession({ projectId: entry.projectId ?? undefined, mode: 'build', ...(worktree ? { worktree: true } : {}) })).id
          }
          // The entry id is the request id: a retry after a lost response is not sent twice.
          // A carried task never joins a running turn: it waits behind it (starts one when idle), as when it was first posted.
          const payload: SendPayload & { continues?: OutboxEntry['continues'] } = { text: entry.text, attachments: [], skillIds: [], delivery: entry.continues ? 'followup' : 'send', requestId: entry.id, ...(entry.continues ? { continues: entry.continues } : {}) }
          await api.sendMessage(sessionId, payload)
          dropOutbox(entry.id)
        } catch { break /* still held or offline: try again on the next change */ }
      }
      useOutbox.setState({ sending: false })
    })()
  }, [status, held, count])
}
