/**
 * P3 proactive communication: the project inbox (every proactive delivery
 * leaves one durable entry whatever its reach tier) and delivery feedback.
 * Contract: docs/specs/stream-protocol-v2.md §1 “项目收件箱与主动消息反馈”.
 * Older daemons answer 404; reads then resolve to `null` so the UI can hide.
 */
import { getTransport } from './client'
import { ApiError } from './transport'
import type { ISODate, PresentedFile } from './types'

export type ReachTier = 'inline' | 'inbox' | 'notify' | 'digest'
export type InboxStatus = 'unread' | 'read' | 'dismissed'
export type FeedbackOutcome = 'replied' | 'acted' | 'dismissed' | 'ignored'
export type InboxFilter = 'active' | 'all' | 'unread' | 'read' | 'dismissed'
export type FeedbackWindow = '24h' | '7d' | '30d'

export interface InboxEntry {
  id: string
  actionId?: string
  kind: 'share' | 'ask' | string
  tier: ReachTier | string
  requestedTier?: ReachTier | string | null
  reachReasons?: string[]
  text: string
  sessionId?: string | null
  itemId?: string | null
  interactionId?: string
  createdAt: ISODate
  status: InboxStatus | string
  readAt?: ISODate
  dismissedAt?: ISODate
  actedAt?: ISODate
  heldForDigest?: boolean
  digestAt?: ISODate
  digestedAt?: ISODate
  digestItemId?: string
  digestSessionId?: string | null
  notifiedAt?: ISODate
  scheduled?: boolean
  feedback?: { outcome: FeedbackOutcome | string; at: ISODate; windowMs?: number } | null
  contextRevoked?: boolean
  sourceDeleted?: boolean
  /** v2 mind: the conversation thread this delivery belongs to. */
  threadId?: string | null
  /** K2: a welcome-back receipt spans several threads. */
  threadIds?: string[]
  /** K2 pacing decision behind the delivery tier: one `outcome` + documented `reasons[]` codes. */
  pacing?: PacingRecord | null
  /** K2 v2: files the agent presented with this message. */
  deliverables?: PresentedFile[]
}

export interface PacingRecord { outcome?: 'send' | 'hold' | 'inbox' | 'drop' | string; reasons?: string[]; value?: number | null; threshold?: number | null; at?: ISODate; kind?: string; threadId?: string | null }

export interface InboxList { projectId: string; unread: number; total: number; entries: InboxEntry[]; now?: ISODate; revision?: number }
export interface InboxActionResult { entry: InboxEntry; unread: number; revision?: number }

export interface DeliveryFeedback {
  projectId?: string
  window: FeedbackWindow | string
  since?: ISODate
  counts: { delivered: number; pending: number; replied: number; acted: number; dismissed: number; ignored: number }
  byTier?: Partial<Record<ReachTier, number>>
  settled: number
  usefulShareRate: number | null
  replyRate: number | null
  actRate: number | null
  dismissRate: number | null
  ignoreRate: number | null
  lowered?: number
  recent?: { entryId: string; actionId?: string; kind: string; tier: string; requestedTier?: string | null; deliveredAt: ISODate; outcome: string; observedAt?: ISODate }[]
  revision?: number
}

/** `notify` SSE event (index stream): desktop-notification tier delivery. */
export interface NotifyEvent { projectId: string; entryId: string; sessionId: string | null; title: string; body: string; at: ISODate }

const enc = encodeURIComponent
const req = <T,>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown) =>
  getTransport().request<T>(path, { method, ...(body === undefined ? {} : { body }) })
export const isUnsupported = (error: unknown) => error instanceof ApiError && (error.status === 404 || error.status === 405)

/** `null` when the daemon predates P3 (route missing). */
async function optional<T>(run: () => Promise<T>): Promise<T | null> {
  try { return await run() } catch (error) { if (isUnsupported(error)) return null; throw error }
}

export const communicationApi = {
  inbox: (projectId: string, status: InboxFilter = 'active', limit = 50) =>
    optional(() => req<InboxList>(`/api/v2/projects/${enc(projectId)}/inbox?status=${status}&limit=${limit}`)),
  act: (projectId: string, entryId: string, action: 'read' | 'dismiss' | 'act') =>
    req<InboxActionResult>(`/api/v2/projects/${enc(projectId)}/inbox/${enc(entryId)}`, 'POST', { action }),
  readAll: (projectId: string) => req<InboxList>(`/api/v2/projects/${enc(projectId)}/inbox/read-all`, 'POST', {}),
  feedback: (projectId: string, window: FeedbackWindow = '7d') =>
    optional(() => req<DeliveryFeedback>(`/api/v2/projects/${enc(projectId)}/delivery-feedback?window=${window}`)),
}
