/**
 * H4 read endpoints (contract v2 §1): session cleanup receipts, per-project
 * memory sync status, inbox deep links (entry location, item position and
 * digest ↔ entries mapping) and the system evolution proposal list. Every read
 * returns `null` on daemons that predate the route (404/405) so callers can
 * hide the feature instead of failing.
 */
import { getTransport } from './client'
import { ApiError } from './transport'
import type { InboxEntry } from './communication-api'
import type { Item } from './types'

const enc = encodeURIComponent
const missing = (error: unknown) => error instanceof ApiError && (error.status === 404 || error.status === 405)
async function optional<T>(path: string): Promise<T | null> {
  try { return await getTransport().request<T>(path) } catch (error) { if (missing(error)) return null; throw error }
}

/* ------------------------------------------------ session cleanup receipts */

export interface SessionDeletion {
  sessionId: string; projectId: string | null
  /** blocked: waits for the user's decision (`decision` names which one, `notice` says why in the interface language). */
  status: 'pending' | 'completed' | 'recovery_review' | 'blocked' | string
  localStatus: 'pending' | 'completed' | string
  /** kept_by_user: remote records the user chose to keep (`keep_remote`). */
  remoteStatus: 'pending' | 'completed' | 'not_required' | 'kept_by_user' | string
  createdAt: string | null; updatedAt: string | null; completedAt: string | null
  code: string | null; retryAt: string | null; attempts: number
  decision?: 'execution' | 'too_large' | 'unsafe' | 'damaged' | 'memory_changed' | 'memory_mismatch' | 'memory_differs' | string | null
  /**
   * What the user can decide on a blocked cleanup (POST /api/session-deletions/:id/decide { choice }), or null when
   * nothing is to decide in the app. Older hosts send none.
   */
  choice?: DeletionChoice | string | null
  notice?: string | null
}
export type DeletionChoice = 'release_runs' | 'remove_entry' | 'read_all' | 'rebuild' | 'keep_remote'

/* ---------------------------------------------------------- memory sync */

export type MemorySyncState = 'attention' | 'syncing' | 'synced' | 'none'
export interface MemorySyncEvidence { records: number; completed: number; extracted: number; indexed: number; indexPending: number; indexIssues: number; initializedAt?: string | null }
/**
 * `message`: the host's readable line for the issue, in the interface language (older hosts send only `code`).
 * `resolution`: 'unresolved' (the host is still finding out; no action) or 'settled' (a known loss, listed under
 * history with nothing to acknowledge; a failed extraction can be re-extracted); `actions` lists what this record allows.
 * Older hosts send neither, and may still offer 'acknowledge'.
 */
export type MemorySyncAction = 'acknowledge' | 'reextract'
export interface MemorySyncIssue {
  status: string; code: string; message?: string; turnId?: string; checkpointId?: string; evidenceId?: string; stage?: string; upstreamStatus?: number; updatedAt?: string | null
  resolution?: 'unresolved' | 'settled'; actions?: MemorySyncAction[]; acknowledgedAt?: string | null; blockedBy?: string
}
export interface MemorySyncSession {
  sessionId: string; title: string; archivedAt: string | null; status: MemorySyncState
  turns: number; completedTurns: number; writes: number; incremental: number; pending: number; attention: number; retained: number
  unresolved?: number; settledLoss?: number; acknowledged?: number
  evidence: MemorySyncEvidence; lastSuccessAt: string | null; issues: MemorySyncIssue[]
  /** Settled losses, newest first, kept so a later success never hides them. */
  history?: MemorySyncIssue[]
}
export interface MemorySyncStatus {
  projectId: string; status: MemorySyncState; health: 'healthy' | 'degraded' | 'not_observed' | string
  completedTurns: number; incremental: number; pending: number; attention: number; retained: number
  unresolved?: number; settledLoss?: number; acknowledged?: number
  evidence: MemorySyncEvidence; counts: Record<string, number>; lastSuccessAt: string | null
  summary: { status: string | null; resolution?: 'unresolved' | 'settled' | null; updatedAt: string | null; completedAt: string | null; code: string | null } | null
  sessions: MemorySyncSession[]; revision?: number
}
/** Names one recorded outcome: a turn (or one of its checkpoints) or a delivery (or its resource index, by `stage`). */
export interface MemorySyncRecordRef { sessionId: string; turnId?: string; checkpointId?: string; evidenceId?: string; stage?: string }
export const memorySyncRef = (sessionId: string, issue: MemorySyncIssue): MemorySyncRecordRef => issue.evidenceId
  ? { sessionId, evidenceId: issue.evidenceId, ...(issue.stage ? { stage: issue.stage } : {}) }
  : { sessionId, turnId: issue.turnId, ...(issue.checkpointId ? { checkpointId: issue.checkpointId } : {}) }
export type MemoryReextractStep =
  | { status: 'confirm_required'; paid: true; confirm: string; messages: number; characters: number }
  | { status: 'queued'; paid: true; messages: number; characters: number; sync: MemorySyncStatus; revision: number }

/* ------------------------------------------------------------ deep links */

export interface InboxLocation { kind: 'message' | 'question' | 'digest'; sessionId: string; itemId: string; turnId: string | null; index: number; count: number; sessionArchived: boolean }
export interface InboxEntryLookup { projectId: string; entry: InboxEntry; location: InboxLocation | null; digest: { itemId: string; sessionId: string | null; entryIds: string[] } | null; now: string; revision?: number }
export interface ItemLookup {
  revision: number; sessionId: string; item: Item
  position?: { index: number; count: number; turnId: string | null }
  inboxEntries?: { id: string; kind: string; tier: string; status: string; relation: 'message' | 'question' | 'digest'; createdAt: string }[]
  digest?: { entryIds: string[] }
}

/* -------------------------------------------------- system evolution */

export interface SystemProposal {
  schemaVersion: number; id: string; createdAt: string; status: 'proposed' | string; autoAdopt: false; adoption: string
  target: { component: string; key: string; evidence?: Record<string, unknown>; hypothesis?: string } | null
  note: string | null; evidence?: { signalKinds?: Record<string, number>; projects?: number }
}

export const supportApi = {
  sessionDeletions: () => optional<{ revision: number; deletions: SessionDeletion[] }>('/api/v2/session-deletions'),
  memorySync: (projectId: string) => optional<MemorySyncStatus>(`/api/v2/projects/${enc(projectId)}/memory-sync`),
  /** Compatibility only: settled losses are history without it (A2); this stamps acknowledgedAt. */
  acknowledgeMemorySync: (projectId: string, records: MemorySyncRecordRef[]) => getTransport().request<{ acknowledged: number; sync: MemorySyncStatus; revision: number }>(`/api/v2/projects/${enc(projectId)}/memory-sync/acknowledge`, { method: 'POST', body: { records } }),
  /** Paid, two steps: without `confirm` nothing changes and the answer says what would be uploaded. */
  reextractMemorySync: (projectId: string, record: MemorySyncRecordRef, confirm?: string) => getTransport().request<MemoryReextractStep>(`/api/v2/projects/${enc(projectId)}/memory-sync/reextract`, { method: 'POST', body: { ...record, ...(confirm ? { confirm } : {}) } }),
  inboxEntry: (projectId: string, entryId: string) => optional<InboxEntryLookup>(`/api/v2/projects/${enc(projectId)}/inbox/${enc(entryId)}`),
  item: (sessionId: string, itemId: string) => optional<ItemLookup>(`/api/v2/sessions/${enc(sessionId)}/items/${enc(itemId)}`),
  /** Legacy write route (app.js): re-run model project initialization. */
  initialize: (projectId: string) => getTransport().request<unknown>(`/api/projects/${enc(projectId)}/initialize`, { method: 'POST', body: {} }),
  systemProposals: (limit = 50) => optional<{ total: number; proposals: SystemProposal[]; autoAdopt: false }>(`/api/v2/evolution/system/proposals?limit=${limit}`),
}
