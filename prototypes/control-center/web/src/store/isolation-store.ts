/**
 * Worktree isolation on the web (0.63, worktree design §7, §11, §12): per project, whether isolation can be used
 * and Rna's worktrees (`GET …/worktrees`); per conversation, its apply records (`GET …/applies?sessionId=`); and the
 * new-conversation switch 在独立工作树中运行 until the conversation is created. Reads are shared and read again
 * when the host's pushes say they changed (`noteTurns` / `noteSession`, called by sync.ts); nothing here is ever
 * more than what the host answered.
 */
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { worktreeApi, type ApplyRecord, type RnaWorktree, type RnaWorktrees } from '@/api/worktree-api'
import { ApiError } from '@/api/transport'
import type { SessionMeta, Turn } from '@/api/types'
import { useApp } from './app-store'

export interface Loaded<T> {
  data: T | null
  loading: boolean
  /** The host's message when the last read failed. */
  error: string | null
  /** The host has no such route (an older daemon): nothing to show, nothing to offer. */
  unsupported?: boolean
  /** When the last read finished (ms); 0 before the first. */
  at: number
}

interface IsolationState {
  /** By project. */
  worktrees: Record<string, Loaded<RnaWorktrees>>
  /** By conversation: its apply records, newest first. */
  applies: Record<string, Loaded<ApplyRecord[]>>
  /** New conversation: the switch as the user moved it, by project (absent: the project's default). */
  choice: Record<string, boolean>
}

export const useIsolation = create<IsolationState>(() => ({ worktrees: {}, applies: {}, choice: {} }))

const EMPTY = { data: null, loading: false, error: null, at: 0 }
const unsupported = (error: unknown) => error instanceof ApiError && (error.status === 404 || error.status === 405 || error.status === 501)
const inflight = new Map<string, Promise<void>>()

function put(table: 'worktrees', key: string, next: Partial<Loaded<RnaWorktrees>>): void
function put(table: 'applies', key: string, next: Partial<Loaded<ApplyRecord[]>>): void
function put(table: 'worktrees' | 'applies', key: string, next: Partial<Loaded<unknown>>) {
  useIsolation.setState(s => ({ [table]: { ...s[table], [key]: { ...EMPTY, ...s[table][key], ...next } } }) as Partial<IsolationState>)
}

/** Read a project's isolation conditions and worktrees (a read on its way is shared; `minAgeMs` skips a recent one). */
export function loadWorktrees(projectId: string, { minAgeMs = 0 }: { minAgeMs?: number } = {}): Promise<void> {
  const key = `w:${projectId}`
  const running = inflight.get(key)
  if (running) return running
  const row = useIsolation.getState().worktrees[projectId]
  if (minAgeMs && row?.at && Date.now() - row.at < minAgeMs) return Promise.resolve()
  put('worktrees', projectId, { loading: true })
  const request = worktreeApi.worktrees(projectId).then(
    data => put('worktrees', projectId, { data, loading: false, error: null, unsupported: false, at: Date.now() }),
    (error: Error) => put('worktrees', projectId, { loading: false, error: error.message, unsupported: unsupported(error), at: Date.now() }),
  ).finally(() => { inflight.delete(key) })
  inflight.set(key, request)
  return request
}

/** A conversation's apply records (one read for all its turns' footers). */
export function loadApplies(projectId: string, sessionId: string): Promise<void> {
  const key = `a:${sessionId}`
  const running = inflight.get(key)
  if (running) return running
  put('applies', sessionId, { loading: true })
  const request = worktreeApi.applies(projectId, { sessionId, limit: 500 }).then(
    ({ applies }) => put('applies', sessionId, { data: applies, loading: false, error: null, unsupported: false, at: Date.now() }),
    (error: Error) => put('applies', sessionId, { loading: false, error: error.message, unsupported: unsupported(error), at: Date.now() }),
  ).finally(() => { inflight.delete(key) })
  inflight.set(key, request)
  return request
}

/** The project's isolation conditions and worktrees, read once when first asked for (and on `refresh`). */
export function useWorktrees(projectId: string | null | undefined, { enabled = true }: { enabled?: boolean } = {}): Loaded<RnaWorktrees> {
  const entry = useIsolation(s => (projectId ? s.worktrees[projectId] : undefined))
  useEffect(() => { if (projectId && enabled && !useIsolation.getState().worktrees[projectId]?.at) void loadWorktrees(projectId) }, [projectId, enabled])
  return entry ?? EMPTY
}

const NO_RECORDS: ApplyRecord[] = []
/** One turn's apply records (by `source.turnId`), oldest first; reads the conversation's records when `wanted`. */
export function useTurnApplies(projectId: string | null | undefined, sessionId: string, turnId: string, wanted: boolean): { records: ApplyRecord[]; loaded: boolean } {
  const entry = useIsolation(s => s.applies[sessionId])
  useEffect(() => { if (wanted && projectId && !useIsolation.getState().applies[sessionId]?.at) void loadApplies(projectId, sessionId) }, [wanted, projectId, sessionId])
  const records = useMemo(() => (entry?.data ? entry.data.filter(row => row.source?.turnId === turnId).reverse() : NO_RECORDS), [entry?.data, turnId])
  return { records, loaded: Boolean(entry?.at && !entry.error) }
}

/* -------------------------------------------------------------- pushes */

const timers = new Map<string, ReturnType<typeof setTimeout>>()
function soon(key: string, run: () => void, ms = 250) {
  const pending = timers.get(key)
  if (pending) clearTimeout(pending)
  timers.set(key, setTimeout(() => { timers.delete(key); run() }, ms))
}

const applyKey = (turn: Pick<Turn, 'apply' | 'checkpoint'> | undefined) => `${JSON.stringify(turn?.apply ?? null)}|${JSON.stringify(turn?.checkpoint ?? null)}`

/**
 * Turns changed (sync.ts): a turn whose apply or checkpoint moved reads its conversation's records again, when they
 * were read. `before`: the turns as they were, so a turn pushed for anything else (its usage, a subagent's row) reads
 * nothing.
 */
export function noteTurns(sessionId: string, projectId: string | null | undefined, turns: (Pick<Turn, 'apply' | 'checkpoint'> & { id?: string })[], before?: Record<string, Pick<Turn, 'apply' | 'checkpoint'>>) {
  const moved = (turn: (typeof turns)[number]) => (turn.apply !== undefined || turn.checkpoint !== undefined) && (!before || !turn.id || applyKey(turn) !== applyKey(before[turn.id]))
  if (!projectId || !turns.some(moved)) return
  if (!useIsolation.getState().applies[sessionId]?.at) return
  soon(`a:${sessionId}`, () => void loadApplies(projectId, sessionId))
}

/** A conversation's fields changed (sync.ts): its worktree's state moving reads the project's worktrees again, when they were read. */
export function noteSession(projectId: string | null | undefined, fields: Partial<SessionMeta>) {
  if (!projectId || !('worktree' in fields)) return
  if (!useIsolation.getState().worktrees[projectId]?.at) return
  soon(`w:${projectId}`, () => void loadWorktrees(projectId))
}

/** Something this window did changed the project's worktrees or records (an apply, a rollback, a discard, git init). */
export function refreshIsolation(projectId: string, sessionId?: string | null) {
  void loadWorktrees(projectId)
  const sessions = useIsolation.getState().applies
  for (const id of sessionId ? [sessionId] : Object.keys(sessions)) if (sessions[id]?.at) void loadApplies(projectId, id)
}

/* ---------------------------------------------------- new conversation */

/** The switch's value for a new conversation of `projectId`: the user's choice, else the project's default. */
export function worktreeChoice(projectId: string | null | undefined): boolean {
  if (!projectId) return false
  const chosen = useIsolation.getState().choice[projectId]
  return chosen ?? Boolean(useApp.getState().projects[projectId]?.git?.sessionWorktreeDefault)
}
export function useWorktreeChoice(projectId: string | null | undefined): boolean {
  const chosen = useIsolation(s => (projectId ? s.choice[projectId] : undefined))
  const fallback = useApp(s => Boolean(projectId && s.projects[projectId]?.git?.sessionWorktreeDefault))
  return projectId ? chosen ?? fallback : false
}
export function setWorktreeChoice(projectId: string, value: boolean) {
  useIsolation.setState(s => ({ choice: { ...s.choice, [projectId]: value } }))
}
/** The conversation was created: the next new one starts from the project's default again. */
export function clearWorktreeChoice(projectId: string) {
  useIsolation.setState(s => {
    if (!(projectId in s.choice)) return {}
    const { [projectId]: _, ...rest } = s.choice
    return { choice: rest }
  })
}

/**
 * Whether the conversation about to be created runs in its own worktree. A switch that is on is checked against
 * isolation first (read when not known yet), so a project whose isolation went away since never fails the first
 * message with 409 `worktree_unavailable`.
 */
export async function newConversationWorktree(projectId: string | null | undefined): Promise<boolean> {
  if (!projectId || !worktreeChoice(projectId)) return false
  return isolationEnabled(projectId)
}
/** Whether the project's conversations can run in their own worktree now (read when not known yet). */
export async function isolationEnabled(projectId: string): Promise<boolean> {
  if (!useIsolation.getState().worktrees[projectId]?.data) await loadWorktrees(projectId)
  return Boolean(useIsolation.getState().worktrees[projectId]?.data?.isolation.enabled)
}

/* ----------------------------------------------------------- lookups */

/** The worktree record a conversation runs in (by `session.worktree.id`, else by owner), once the project's list is read. */
export function sessionWorktreeRow(list: RnaWorktrees | null | undefined, sessionId: string, worktreeId?: string | null): RnaWorktree | null {
  if (!list) return null
  return list.worktrees.find(row => (worktreeId && row.id === worktreeId)) ?? list.worktrees.find(row => row.kind === 'session' && row.owner?.sessionId === sessionId && row.state !== 'removed') ?? null
}

/** Test helper. */
export function resetIsolation() {
  inflight.clear()
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  useIsolation.setState({ worktrees: {}, applies: {}, choice: {} })
}
