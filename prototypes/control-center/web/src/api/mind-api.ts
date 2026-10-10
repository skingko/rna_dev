/**
 * Project Mind (proactive-evolution v2, docs/planning/proactive-evolution-v2-20260929.md §8):
 * lessons, agenda, commitments, findings, threads, user notes, pacing and
 * learning health, plus per-message 👍/👎 feedback and the §5 metrics.
 *
 * Every read resolves to `null` on daemons that predate these routes (404/405)
 * so the UI can hide the surface instead of erroring. Fields beyond the §8
 * table are optional and tolerated when absent.
 */
import { getTransport } from './client'
import { isUnsupported } from './communication-api'
import type { ISODate, Question } from './types'

export type MindCollection = 'lessons' | 'agenda' | 'commitments' | 'threads' | 'notes'

export interface MindSource { kind: string; sessionId?: string | null; itemId?: string | null; turnId?: string | null }
interface MindBase { id: string; createdAt: ISODate; updatedAt?: ISODate; source?: MindSource | null }

export type LessonKind = 'preference' | 'constraint' | 'pitfall' | 'success_habit'
/** `held`: an assistant-concluded lesson that would replace a user's one, waiting for the user's answer (not used). */
export type LessonStatus = 'active' | 'held' | 'superseded' | 'retired'
export interface Lesson extends MindBase {
  kind: LessonKind | string
  text: string
  scope?: 'project' | 'user' | string
  taskTypes?: string[]
  evidence?: (string | { excerpt?: string; text?: string; sessionId?: string; itemId?: string; turnId?: string })[]
  status: LessonStatus | string
  supersededBy?: string | null
  until?: ISODate | null
  uses?: { recalled?: number; applied?: number; contradicted?: number }
  /** The judge wants the user to confirm or correct this lesson; it is asked as a card in the conversation. */
  needsConfirmation?: boolean
  /** Why it is asked about (never_applied, conflicts_user_lesson). */
  confirmReason?: string
  /** conflicts_user_lesson: the user's lessons this one would replace. */
  conflictsWith?: string[]
  confirmedAt?: ISODate | null
  interaction?: { sessionId: string; interactionId: string; itemId?: string; askedAt?: ISODate; settledAt?: ISODate } | null
  question?: { status: string; canRespond: boolean; questions: Question[] } | null
}

export type AgendaKind = 'intention' | 'todo' | 'awaiting_user' | 'open_loop' | 'idea'
export interface AgendaItem extends MindBase {
  kind: AgendaKind | string
  text: string
  until?: ISODate | null
  status: 'open' | 'done' | 'dropped' | string
  threadId?: string | null
  /** The judge found this item needs the user (a question blocking work, or a plan only the user can continue/finish/drop); such items also get a question card. */
  blocking?: boolean
  /** The question card posted in the project conversation for a blocking item. */
  interaction?: { sessionId: string; interactionId: string; itemId?: string; askedAt?: ISODate } | null
  /** Live questions of that card (answerable in place when `canRespond`). */
  question?: { status: string; canRespond: boolean; questions: Question[] } | null
  answer?: string | null
  resolvedBy?: { kind: string; sessionId?: string; itemId?: string; at?: ISODate } | null
  reason?: string | null
  evidence?: unknown[]
}

export interface Commitment extends MindBase {
  request: string
  trigger: 'user_request' | 'agent_promise' | 'failed_turn' | string
  overdueAt?: ISODate | null
  status: 'pending' | 'resolved' | 'dismissed' | string
  resolvedBy?: { kind: string; sessionId?: string; turnId?: string; itemId?: string; ledgerId?: string; at?: string } | null
  reason?: string | null
}

export interface Finding extends MindBase { topicKey: string; summary: string; firstSharedAt?: ISODate; lastSharedAt?: ISODate; lastEvidenceHash?: string; threadId?: string | null; shareCount?: number; lastItemId?: string | null }

export interface ThreadReactions { replied?: number; acted?: number; dismissed?: number; ignored?: number; up?: number; down?: number }
export interface MindThread extends MindBase {
  title: string
  status: 'open' | 'resolved' | 'muted' | string
  messageItemIds: string[]
  lastMessageAt?: ISODate | null
  reactions?: ThreadReactions
  /** Optional: the session each message lives in (lets history link across sessions). */
  messageSessions?: Record<string, string>
  /** K2 narrator: latest one-line summary shared on this thread. */
  lastSummary?: string | null
  entryIds?: string[]
  awaitingUser?: boolean
  resolvedAt?: ISODate | null
}

export interface UserNote extends MindBase { text: string }
export interface MindNotes { facts: UserNote[]; preferences: UserNote[]; updatedAt?: ISODate }

export interface MindPacing { threshold?: number; unrepliedChain?: number; engagement?: number; lastPresenceAt?: ISODate | null; activeHours?: number[]; updatedAt?: ISODate }
export interface MindHealth { learning: 'running' | 'paused' | string; reason?: string | null }

export interface ProjectMind {
  projectId: string
  revision?: number
  updatedAt?: ISODate
  lessons: Lesson[]
  agenda: AgendaItem[]
  commitments: Commitment[]
  findings?: Finding[]
  threads: MindThread[]
  notes: MindNotes
  pacing?: MindPacing | null
  health?: MindHealth | null
}

export interface MindCounts { lessons?: number; openAgenda?: number; pendingCommitments?: number; overdueCommitments?: number }
/** SSE `project.mind` (index stream): a summary, not the whole mind. */
export interface MindEvent { projectId: string; revision?: number; counts?: MindCounts; health?: MindHealth | null; changed?: MindCollection[]; updatedAt?: ISODate }

export type FeedbackVote = 'up' | 'down' | null
export interface ItemFeedback { vote: FeedbackVote; comment?: string | null; at?: ISODate }

export type MetricsWindow = '7d' | '30d'
export type MetricKey =
  | 'usefulShareRate' | 'ignoreRate' | 'dismissRate' | 'longestUnrepliedChain'
  | 'commitmentResolutionP50Ms' | 'commitmentResolutionP90Ms' | 'overdueCommitments'
  | 'correctionsPerTurn' | 'repeatCorrectionRate' | 'firstAttemptAcceptance' | 'lessonHitRate'
export interface MetricValue {
  value: number | null
  /** Same metric over the preceding window of equal length. */
  previous?: number | null
  /** Oldest first, one point per day (K4: `{ date, value, sample }`; bare numbers tolerated). */
  series?: (MetricPoint | number | null)[]
  /** Denominator behind a rate (turns, deliveries, recalls…). */
  sample?: number | null
}
/** One daily bucket: `date` is `YYYY-MM-DD` (UTC day ending the bucket). */
export interface MetricPoint { date?: string; value: number | null; sample?: number | null }
export interface ProjectMetrics {
  schema?: string
  projectId: string
  window: MetricsWindow | string
  since?: ISODate
  generatedAt?: ISODate
  bucket?: 'day' | string
  metrics: Partial<Record<MetricKey, MetricValue>> & Record<string, MetricValue | undefined>
  /** Raw blocks behind the keyed view (K4 baseline / K2 override); not rendered directly. */
  proactive?: Record<string, unknown> | null
  learning?: Record<string, unknown> | null
  harness?: Record<string, unknown> | null
  owners?: Record<string, string>
  providers?: Record<string, string>
}

const enc = encodeURIComponent
const req = <T,>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET', body?: unknown) =>
  getTransport().request<T>(path, { method, ...(body === undefined ? {} : { body }) })
async function optional<T>(run: () => Promise<T>): Promise<T | null> {
  try { return await run() } catch (error) { if (isUnsupported(error)) return null; throw error }
}
const base = (projectId: string) => `/api/v2/projects/${enc(projectId)}`
/** PATCH/DELETE answer either the entry or `{ entry }`; normalize. */
const unwrap = <T,>(body: unknown): T | null => (body && typeof body === 'object' ? (('entry' in body ? (body as { entry: T }).entry : body) as T) : null)

export const mindApi = {
  get: (projectId: string) => optional(() => req<ProjectMind>(`${base(projectId)}/mind`)),
  patch: async <T,>(projectId: string, collection: MindCollection, entryId: string, patch: Record<string, unknown>) =>
    unwrap<T>(await req<unknown>(`${base(projectId)}/mind/${collection}/${enc(entryId)}`, 'PATCH', patch)),
  /**
   * Set an agenda item's status — a plan line too (the plan is the agenda's todo items): `done`, `dropped`, or `open`
   * to put it back where it was (the host keeps its stage). Recorded as the user's call (resolvedBy: user).
   */
  setAgendaStatus: async (projectId: string, entryId: string, status: 'open' | 'done' | 'dropped') =>
    unwrap<AgendaItem>(await req<unknown>(`${base(projectId)}/mind/agenda/${enc(entryId)}`, 'PATCH', { status })),
  remove: (projectId: string, collection: MindCollection, entryId: string) =>
    req<unknown>(`${base(projectId)}/mind/${collection}/${enc(entryId)}`, 'DELETE', {}),
  metrics: (projectId: string, window: MetricsWindow = '7d') => optional(() => req<ProjectMetrics>(`${base(projectId)}/metrics?window=${window}`)),
  /** Answer an awaiting_user agenda item without a question card (recorded in the conversation, closes the item). */
  /** Overdue promises are asked above the composer of the project conversation; returns that conversation. */
  askOwed: (projectId: string) => req<{ sessionId: string | null; overdue: number; offered: number }>(`${base(projectId)}/mind/commitments/ask`, 'POST', {}),
  answerAgenda: async (projectId: string, entryId: string, text: string) => unwrap<AgendaItem>(await req<unknown>(`${base(projectId)}/mind/agenda/${enc(entryId)}/answer`, 'POST', { text })),
  feedback: (sessionId: string, itemId: string, body: { vote: FeedbackVote; comment?: string }) =>
    req<{ feedback?: ItemFeedback } | null>(`/api/v2/sessions/${enc(sessionId)}/items/${enc(itemId)}/feedback`, 'POST', body),
  /** Close (`dismiss`) or answer a composer invitation; a lesson answer confirms, retires or rewrites it. */
  invitation: (sessionId: string, invitationId: string, body: { action: 'shown' } | { action: 'dismiss' } | { action: 'answer'; choice: 'confirm' | 'revoke' | 'rewrite'; text?: string } | { action: 'answer'; choice: 'retire' | 'keep' | 'fix' | 'later' | 'continue' | 'drop' | 'accept' | 'decline' }) =>
    req<{ closed: boolean; outcome?: string }>(`/api/v2/sessions/${enc(sessionId)}/invitations/${enc(invitationId)}`, 'POST', body),
}
