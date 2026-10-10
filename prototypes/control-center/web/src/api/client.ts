/**
 * Typed client for the v2 read contract plus the existing REST write routes.
 *
 * Reads prefer /api/v2/*; when the daemon has not shipped v2 yet (404), they
 * fall back to the legacy read-only endpoints so the shell never renders blank.
 * Writes reuse the legacy routes and payloads exactly (see public/app.js).
 */
import { ApiError, fetchOrFail, liveTransport, type Transport } from './transport'
import type {
  Bootstrap, CacheUsage, Configuration, Item, ModelReasoningInfo, ModelSelection, ProjectSummary, Session, SessionPage, SessionSummary,
} from './types'
import { t } from '@/i18n'

export type ReadMode = 'v2' | 'legacy'

let transport: Transport = liveTransport
export function setTransport(next: Transport) { transport = next }
export function getTransport() { return transport }

const isMissing = (error: unknown) => error instanceof ApiError && (error.status === 404 || error.status === 405)

/* ------------------------------------------------------------------ reads */

interface LegacyState {
  revision: number
  emergency?: unknown
  maintenance?: Bootstrap['maintenance']
  configuration?: Configuration
  settings?: Record<string, unknown>
  projects: (ProjectSummary & Record<string, unknown>)[]
  sessions: Session[]
}

let legacyCache: LegacyState | null = null

function summarizeSession(session: Session): SessionSummary {
  const { items, turns, ...meta } = session
  const last = items.at(-1)
  const lastText = [...items].reverse().find(item => item.kind === 'assistant' || item.kind === 'user')
  return {
    ...meta,
    itemCount: items.length,
    lastItemAt: last?.createdAt,
    preview: lastText?.text.slice(0, 80),
    activeTurnId: session.activeTurnId ?? null,
  }
  void turns
}

function summarizeProject(project: LegacyState['projects'][number]): ProjectSummary {
  const versions = Array.isArray(project.versions) ? project.versions as { id: string; version: number; title?: string }[] : []
  const activeVersion = versions.find(v => v.id === project.activeVersionId) ?? null
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    workspacePath: project.workspacePath,
    archivedAt: project.archivedAt ?? null,
    primarySessionId: project.primarySessionId,
    permissions: project.permissions,
    rhythmStatus: project.rhythmStatus ?? null,
    plan: (project as { plan?: ProjectSummary['plan'] }).plan ?? null,
    backgroundChanges: ((project as { backgroundChanges?: { id: string; actionId: string; at: string; status: string; files?: { path: string }[] }[] }).backgroundChanges ?? []).slice(-12).map(row => ({ id: row.id, actionId: row.actionId, at: row.at, status: row.status, count: row.files?.length ?? 0, paths: (row.files ?? []).slice(0, 8).map(file => file.path) })),
    counts: {
      versions: versions.length,
      jobs: Array.isArray(project.jobs) ? project.jobs.length : 0,
      observations: Array.isArray(project.observations) ? project.observations.length : 0,
    },
    activeVersion: activeVersion ? { id: activeVersion.id, version: activeVersion.version, title: activeVersion.title } : null,
    updatedAt: project.updatedAt,
  }
}

export async function loadBootstrap(): Promise<{ bootstrap: Bootstrap; mode: ReadMode }> {
  try {
    const bootstrap = await transport.request<Bootstrap>('/api/v2/bootstrap')
    return { bootstrap, mode: 'v2' }
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  const state = await transport.request<LegacyState>('/api/state')
  legacyCache = state
  return {
    mode: 'legacy',
    bootstrap: {
      protocol: 1,
      revision: state.revision,
      emergency: Boolean(state.emergency),
      maintenance: state.maintenance,
      configuration: state.configuration,
      settings: state.settings,
      projects: state.projects.map(summarizeProject),
      sessions: state.sessions.map(summarizeSession),
    },
  }
}

/**
 * Opens a conversation. v2 reads its tail window (B9: the newest whole turns, ≥50 messages and ≥2 turns, `window`
 * says whether older items exist); older history comes page by page through `loadOlderItems`. A daemon without
 * windows answers with every item and no `window`, which reads as complete. `from`: the first item already held, when
 * reading again (a resync, a tab shown again): the window reaches back to it, so pages read before stay.
 */
export async function loadSession(id: string, mode: ReadMode, { from }: { from?: string | null } = {}): Promise<Session> {
  // The read mode is settled once by bootstrap, so a v2 404 here means the
  // session itself is gone rather than the route being unavailable.
  if (mode === 'v2') return transport.request<Session>(`/api/v2/sessions/${encodeURIComponent(id)}?${new URLSearchParams({ window: 'tail', ...(from ? { from } : {}) })}`)
  const cached = legacyCache?.sessions.find(session => session.id === id)
  if (cached) return cached
  const state = await transport.request<LegacyState>('/api/state')
  legacyCache = state
  const session = state.sessions.find(s => s.id === id)
  if (!session) throw new ApiError(t('会话不存在'), 404)
  return session
}

/** Legacy mode: the per-session SSE carries the whole session on each change. */
export function adoptLegacySession(session: Session) {
  if (!legacyCache) return
  const index = legacyCache.sessions.findIndex(s => s.id === session.id)
  if (index >= 0) legacyCache.sessions[index] = session
}

/** Targeted refetch for a delta gap or an `event_too_large` resync. */
export async function loadItem(sessionId: string, itemId: string): Promise<Item | null> {
  try {
    // The daemon wraps the item (`{ revision, sessionId, item, position }`); older mocks returned it bare.
    const body = await transport.request<Item | { item: Item }>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(itemId)}`)
    return 'item' in body && body.item && typeof body.item === 'object' ? body.item : body as Item
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

/** Items just before `before` (at most `limit`, ≤200), from a turn boundary, with their turns; 404 when `before` is gone. */
export function loadOlderItems(sessionId: string, before: string, limit = 200): Promise<SessionPage> {
  return transport.request<SessionPage>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/items?${new URLSearchParams({ before, limit: String(limit) })}`)
}

/**
 * The line a background run (`actionId`) or a scheduled run (`occurrenceKey`) reported on in its conversation, found
 * by the host wherever it is (GET …/locate); null when the run posted none.
 */
export async function locateRun(sessionId: string, ref: { actionId?: string | null; occurrenceKey?: string | null }): Promise<string | null> {
  const query = new URLSearchParams({ ...(ref.actionId ? { actionId: ref.actionId } : {}), ...(ref.occurrenceKey ? { occurrenceKey: ref.occurrenceKey } : {}) })
  try {
    const body = await transport.request<{ itemId?: string }>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/locate?${query}`)
    return body?.itemId ?? null
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

/** Where an item sits in its conversation (`index` of `count`), or null when it is not there. */
export async function locateItem(sessionId: string, itemId: string): Promise<{ index: number; count: number } | null> {
  try {
    const body = await transport.request<{ position?: { index: number; count: number } }>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(itemId)}`)
    return body?.position ?? null
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

export async function loadModelReasoning(providerId: string, modelId: string): Promise<ModelReasoningInfo | null> {
  try {
    return await transport.request<ModelReasoningInfo>(`/api/v2/models/${encodeURIComponent(providerId)}/${encodeURIComponent(modelId)}/reasoning`)
  } catch {
    return null
  }
}

export async function loadCacheUsage(window: '1h' | '24h' | '7d' = '24h', projectId?: string): Promise<CacheUsage | null> {
  try {
    const query = new URLSearchParams({ window, ...(projectId ? { projectId } : {}) })
    return await transport.request<CacheUsage>(`/api/v2/usage/cache?${query}`)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

export function clearLegacyCache() { legacyCache = null }

/* ----------------------------------------------------------------- writes */

export interface SendPayload {
  text: string
  attachments?: unknown[]
  skillIds?: string[]
  delivery: 'send' | 'steer' | 'followup'
  requestId: string
}

export const api = {
  /** `worktree`: 在独立工作树中运行 (0.63), chosen at creation only; 409 `worktree_unavailable` (with `reason`) when isolation is off. */
  createSession: (input: { projectId?: string; mode?: string; modelSelection?: ModelSelection; model?: string; worktree?: boolean }) =>
    transport.request<Session>('/api/sessions', { method: 'POST', body: input }),
  sendMessage: (sessionId: string, payload: SendPayload) =>
    transport.request<{ queued?: boolean; itemId?: string }>(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: payload }),
  control: (sessionId: string, action: 'stop' | 'pause' | 'resume' | 'retry') =>
    transport.request<{ recovered?: { text: string }[] }>(`/api/sessions/${sessionId}/control`, { method: 'POST', body: { action } }),
  patchSession: (sessionId: string, input: Record<string, unknown>) =>
    transport.request<Session>(`/api/sessions/${sessionId}`, { method: 'PATCH', body: input }),
  patchProject: (projectId: string, input: Record<string, unknown>) =>
    transport.request<ProjectSummary>(`/api/projects/${projectId}`, { method: 'PATCH', body: input }),
  withdrawInbox: (sessionId: string, entryId: string) =>
    transport.request<{ recovered: { text: string } }>(`/api/sessions/${sessionId}/inbox/${entryId}`, { method: 'DELETE', body: {} }),
  answer: (sessionId: string, interactionId: string, body: { requestId: string; answers: { id: string; selected: string[]; custom?: string }[] }) =>
    transport.request<{ requiresResume?: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}/answer`, { method: 'POST', body }),
  cancelQuestion: (sessionId: string, interactionId: string, requestId: string) =>
    transport.request(`/api/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}/cancel`, { method: 'POST', body: { requestId } }),
  getPermissions: (projectId: string) =>
    transport.request<{ settings: { workspace: string; background: string } }>(`/api/projects/${projectId}/permissions`),
  setPermissions: (projectId: string, workspace: string, background: string) =>
    transport.request(`/api/projects/${projectId}/permissions`, { method: 'PATCH', body: { workspace, background } }),
  /** Rewind the conversation to just before a user message (edit/delete); the host clears the model context after it too. */
  /** Plan §4.5: a new conversation that starts from this message; the original stays. */
  forkSession: (sessionId: string, itemId: string) => transport.request<{ id: string; title?: string }>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/fork`, { method: 'POST', body: { itemId } }),
  rewindItem: (sessionId: string, itemId: string, reason: 'user_edit' | 'user_delete') =>
    transport.request<{ removedItems: number; removedTurns: number; withdrawn: number }>(`/api/sessions/${sessionId}/items/${encodeURIComponent(itemId)}/rewind`, { method: 'POST', body: { reason } }),
  /** Streams the file itself (no base64, no size cap); the host answers { attachment }. */
  uploadAttachment: async (sessionId: string, file: File, signal?: AbortSignal) => {
    const res = await fetchOrFail(`/api/sessions/${sessionId}/attachments?name=${encodeURIComponent(file.name)}${file.type ? `&type=${encodeURIComponent(file.type)}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal })
    const value = await res.json().catch(() => null) as { attachment?: { id: string; name: string; type: string; size: number }; error?: string; code?: string } | null
    if (!res.ok || !value?.attachment) throw new ApiError(value?.error ?? t('请求失败 ({status})', { status: res.status }), res.status, value?.code)
    return value.attachment
  },
  presence: (projectId: string, sessionId: string, { typing, visible, expectedReceiptId }: { typing: boolean; visible: boolean; expectedReceiptId?: string | null }) =>
    transport.request<{ receiptId?: string } | null>(`/api/projects/${projectId}/presence`, { method: 'POST', body: { sessionId, typing, visible, ...(expectedReceiptId !== undefined ? { expectedReceiptId } : {}) } }),
}
