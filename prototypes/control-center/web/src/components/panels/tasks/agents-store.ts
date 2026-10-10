/**
 * A subagent group's agents, read when its card is expanded
 * (GET /api/v2/sessions/:id/agents) and read again only when the session
 * summary's `agents` changes (P-4), so an open table follows the group without
 * polling. Reads of the same session share one request.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { projectApi } from '@/api/project-api'
import type { SessionAgentsSummary, SubagentInfo } from '@/api/types'

interface AgentsState {
  lists: Record<string, SubagentInfo[] | undefined>
  status: Record<string, 'loading' | 'ready' | 'error' | undefined>
}

export const useSessionAgents = create<AgentsState>(() => ({ lists: {}, status: {} }))

const read = new Map<string, string>()
const inflight = new Map<string, Promise<void>>()

/** What the summary says about the group; a new value means its list moved. */
export const agentsSignature = (summary: SessionAgentsSummary | null | undefined) => JSON.stringify([summary?.running ?? 0, summary?.total ?? 0, summary?.tokens ?? 0, summary?.latestTurnId ?? null])

export function loadSessionAgents(sessionId: string, signature: string): Promise<void> {
  if (read.get(sessionId) === signature && useSessionAgents.getState().status[sessionId] === 'ready') return Promise.resolve()
  const running = inflight.get(sessionId)
  if (running) return running.then(() => loadSessionAgents(sessionId, signature))
  read.set(sessionId, signature)
  useSessionAgents.setState(s => ({ status: { ...s.status, [sessionId]: s.lists[sessionId] ? 'ready' : 'loading' } }))
  const task = projectApi.agents(sessionId)
    .then(result => useSessionAgents.setState(s => ({ lists: { ...s.lists, [sessionId]: result.agents ?? [] }, status: { ...s.status, [sessionId]: 'ready' } })))
    .catch(() => { read.delete(sessionId); useSessionAgents.setState(s => ({ status: { ...s.status, [sessionId]: 'error' } })) })
    .finally(() => inflight.delete(sessionId))
  inflight.set(sessionId, task)
  return task
}

/** Keep one group's agents current while `enabled` (its card is expanded). */
export function useGroupAgents(sessionId: string | null, summary: SessionAgentsSummary | null | undefined, enabled: boolean) {
  const signature = agentsSignature(summary)
  useEffect(() => {
    if (enabled && sessionId) void loadSessionAgents(sessionId, signature)
  }, [enabled, sessionId, signature])
  const list = useSessionAgents(s => (sessionId ? s.lists[sessionId] : undefined))
  const status = useSessionAgents(s => (sessionId ? s.status[sessionId] : undefined))
  return { list, status }
}

/** Tests: forget what was read. */
export function resetSessionAgents() {
  read.clear(); inflight.clear()
  useSessionAgents.setState({ lists: {}, status: {} })
}
