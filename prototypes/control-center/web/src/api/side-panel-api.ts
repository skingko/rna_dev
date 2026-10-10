/**
 * S2 side panel contract (implemented by the host line S1; mocked in
 * `mock/terminal-routes.ts` and `mock/server.ts`). Every call degrades: a 404/405 from an
 * older daemon becomes `unsupported` so the UI can explain instead of fail.
 */
import { getTransport } from './client'
import { ApiError } from './transport'
import type { Item, SessionSummary } from './types'

const enc = encodeURIComponent
const req = <T,>(path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown) =>
  getTransport().request<T>(path, { method, ...(body === undefined ? {} : { body }) })

/** True when the host does not implement the route (older daemon). */
export const isUnsupported = (error: unknown) => error instanceof ApiError && (error.status === 404 || error.status === 405 || error.status === 501)

/* ------------------------------------------------------------- terminal */

export type TerminalExitReason = 'permission' | 'idle' | 'closed' | 'daemon_stopped' | string

export interface TerminalExitEvent { id?: string; code?: number | null; signal?: string | null; reason?: TerminalExitReason | null; at?: string }

/** Host `Terminal` (spec §8.1); every field but `id` optional so older/mock hosts still fit. */
export interface TerminalInfo {
  id: string
  projectId?: string
  title?: string | null
  /** Absolute working directory. */
  cwd?: string | null
  shell?: string | null
  /** `pty` or `fallback` (`script(1)`: no resize, limited full-screen apps). */
  capability?: 'pty' | 'fallback' | string | null
  cols?: number
  rows?: number
  status?: 'running' | 'exited' | string
  exit?: TerminalExitEvent | null
  seq?: number
  /** Mock/older hosts. */
  exited?: boolean
}

/** SSE `hello`: the terminal plus how the buffer is replayed (`reset` = clear the screen first). */
export interface TerminalHello extends TerminalInfo { oldestSeq?: number; replay?: 'full' | 'partial' | 'reset' }

export interface TerminalDataEvent { seq: number; b64: string }

export const terminalApi = {
  /** `sessionId` (0.63): start in that worktree conversation's own copy instead of the project folder. */
  create: (projectId: string, size: { cols: number; rows: number }, sessionId?: string | null) => req<TerminalInfo>(`/api/v2/projects/${enc(projectId)}/terminals`, 'POST', sessionId ? { ...size, sessionId } : size),
  list: (projectId: string) => req<{ projectId?: string; capability?: string; terminals: TerminalInfo[] } | TerminalInfo[]>(`/api/v2/projects/${enc(projectId)}/terminals`)
    .then(body => (Array.isArray(body) ? body : body.terminals ?? [])),
  input: (terminalId: string, b64: string) => req(`/api/v2/terminals/${enc(terminalId)}/input`, 'POST', { b64 }),
  get: (terminalId: string) => req<TerminalInfo>(`/api/v2/terminals/${enc(terminalId)}`),
  resize: (terminalId: string, size: { cols: number; rows: number }) => req<{ resized?: boolean }>(`/api/v2/terminals/${enc(terminalId)}/resize`, 'POST', size),
  remove: (terminalId: string) => req(`/api/v2/terminals/${enc(terminalId)}`, 'DELETE'),
  /**
   * SSE: `hello`, `data {seq, b64}`, `exit {code, signal}`. Native reconnects
   * send Last-Event-ID; a fresh stream passes `lastEventId` so the host can
   * replay what this view has not seen (0 = the whole scrollback buffer).
   */
  streamPath: (terminalId: string, lastSeq: number) => `/api/v2/terminals/${enc(terminalId)}/stream${lastSeq > 0 ? `?lastEventId=${lastSeq}` : ''}`,
}

/* ------------------------------------------------------------ side chat */

export const sideChatApi = {
  create: (sessionId: string, selection?: { text: string; itemId?: string | null } | null) =>
    req<SessionSummary>(`/api/v2/sessions/${enc(sessionId)}/side-chats`, 'POST', selection ? { selection } : {}),
  list: (sessionId: string) => req<{ parentSessionId?: string; sideChats: SessionSummary[] } | SessionSummary[]>(`/api/v2/sessions/${enc(sessionId)}/side-chats`)
    .then(body => (Array.isArray(body) ? body : body.sideChats ?? [])),
  /** Add one finished side-chat answer to the parent conversation as a quiet `notice` (idempotent per item). */
  promote: (sideSessionId: string, itemId: string) => req<{ parentSessionId: string; item: Item; duplicate: boolean }>(`/api/v2/sessions/${enc(sideSessionId)}/side-chats/promote`, 'POST', { itemId }),
}

/* ------------------------------------------------------------ base64 */

/** UTF-8 string -> base64 (terminal input). */
export function encodeB64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** base64 -> bytes (terminal output is written to xterm as bytes so split UTF-8 sequences survive). */
export function decodeB64(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
