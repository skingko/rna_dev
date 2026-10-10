/**
 * A turn's net change in the project folder as the host computes it (`GET …/turns/:turnId/changes`): what reached the
 * user's files, file by file, instead of the turn's edit snippets added up. Read lazily, only for finished turns of
 * git projects that have `turn.apply` or `turn.checkpoint` and that could have changed a file (a call that may write,
 * or records of their own: a chat-only turn asks nothing), keyed by conversation and turn, and versioned by what can
 * still change the answer — the turn's attempt (a retry or a resume runs it again), its apply status and records, its
 * checkpoint, the states of its apply records (a rollback, or undoing one). An answer is kept for its version; a new
 * version reads again (the isolation store reads a turn's records again when the host pushes that its apply or
 * checkpoint moved, which moves the version). A read that failed, or an answer that git could not be read this time,
 * is asked again on a later mount once a short while has passed.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { worktreeApi, type ApplyRecord, type HostTurnChanges, type TurnChanges } from '@/api/worktree-api'
import type { Turn } from '@/api/types'
import { useApp } from './app-store'
import { useIsolation, useTurnApplies } from './isolation-store'

export interface TurnChangesEntry {
  /** What the answer was read for (turnChangesVersion). */
  version: string
  loading: boolean
  /** The last answer (kept while a newer version is read, so the list does not flash). */
  data: TurnChanges | null
  /** The read for `version` failed: the tool calls stay. */
  failed: boolean
  /** When a failed read, or an answer that git could not be read this time, came back (ms): asked again after RETRY_MS. */
  at?: number
}

interface TurnChangesState { entries: Record<string, TurnChangesEntry> }

export const useTurnChanges = create<TurnChangesState>(() => ({ entries: {} }))

const keyOf = (sessionId: string, turnId: string) => `${sessionId}:${turnId}`
const inflight = new Map<string, Promise<void>>()
/** Turns still at work: nothing settled to read yet. */
const LIVE = new Set(['running', 'pending', 'queued'])
/** `tools` reasons that say git could not be read this time (away, failing, too slow), not that there is no answer. */
const TRANSIENT_REASONS = new Set(['git_unavailable', 'unreadable'])
/** How long a failed or transient answer stands before a later mount asks again. */
export const RETRY_MS = 30_000

/** Whether an entry's answer is only for now: the read failed, or git could not be read. */
const transient = (entry: TurnChangesEntry) => entry.failed || (entry.data?.source === 'tools' && TRANSIENT_REASONS.has(entry.data.reason))

type VersionedTurn = Pick<Turn, 'status' | 'apply' | 'checkpoint' | 'attemptStartedAt' | 'completedAt' | 'retryHistory'>

/** What a turn's host answer depends on that can still change: its attempt included, so a retry is read again. */
export function turnChangesVersion(turn: VersionedTurn, records: readonly ApplyRecord[]): string {
  return JSON.stringify([turn.status, turn.attemptStartedAt ?? null, turn.completedAt ?? null, turn.retryHistory?.length ?? 0, turn.apply?.status ?? null, turn.apply?.applyIds ?? null, turn.checkpoint?.state ?? null, turn.checkpoint?.endedAt ?? null, records.map(row => [row.id, row.state, row.rolledBackBy ?? null])])
}

/**
 * Whether a turn has host data worth reading: a finished turn whose worktree apply reached the project folder, or a
 * direct-mode turn with a checkpoint. A pending, conflicted, skipped or expired one is answered `tools` by the host,
 * so it is not asked (its status moving to applied moves the version, and it is read then).
 */
export const turnChangesWanted = (turn: Pick<Turn, 'status' | 'apply' | 'checkpoint'> | undefined, running = false) =>
  Boolean(turn && !running && !LIVE.has(turn.status) && (turn.apply ? turn.apply.status === 'applied' : turn.checkpoint?.state === 'taken'))

/** Read one turn's changes for `version` (a read on its way is shared; an answer for this version is kept). */
export function loadTurnChanges(projectId: string, sessionId: string, turnId: string, version: string): Promise<void> {
  const key = keyOf(sessionId, turnId), entry = useTurnChanges.getState().entries[key]
  if (entry?.version === version && (entry.loading || ((entry.data || entry.failed) && !(transient(entry) && Date.now() - (entry.at ?? 0) >= RETRY_MS)))) return inflight.get(`${key}|${version}`) ?? Promise.resolve()
  const set = (next: Partial<TurnChangesEntry>) => useTurnChanges.setState(s => {
    const current = s.entries[key]
    // A newer version asked for meanwhile wins over this answer.
    if (current && current.version !== version) return {}
    const settled: TurnChangesEntry = { version, loading: false, data: current?.data ?? null, failed: false, ...next }
    return { entries: { ...s.entries, [key]: transient(settled) ? { ...settled, at: Date.now() } : settled } }
  })
  useTurnChanges.setState(s => ({ entries: { ...s.entries, [key]: { version, loading: true, data: s.entries[key]?.data ?? null, failed: false } } }))
  const request = worktreeApi.turnChanges(projectId, turnId, { sessionId }).then(
    data => set({ data, loading: false, failed: false }),
    () => set({ loading: false, failed: true }),
  ).finally(() => { inflight.delete(`${key}|${version}`) })
  inflight.set(`${key}|${version}`, request)
  return request
}

/** A host answer that lists files (`records` / `checkpoint`), or null for `tools`, a failed read or an older host's shape. */
export function hostFiles(data: TurnChanges | null | undefined): HostTurnChanges | null {
  return data && (data.source === 'records' || data.source === 'checkpoint') && Array.isArray(data.files) ? data : null
}

/**
 * How many files the host credits the turn with that still stand (the footer's count): its files not rolled back,
 * leaving out those that only changed while it ran (`unattributed`), plus the edited files no snapshot holds
 * (`uncovered`) and the files another owner also wrote meanwhile (`shared`), which are the turn's too.
 */
export function hostChangedCount(changes: HostTurnChanges): number {
  const listed = new Set(changes.files.map(file => file.path))
  const extra = new Set([...(changes.uncovered ?? []), ...(changes.shared ?? []).map(row => row.path)].filter(path => !listed.has(path)))
  return changes.files.filter(file => !file.rolledBack && !file.unattributed).length + extra.size
}

export interface HostTurnView {
  /** The host's files for this turn, when it answered with them (possibly for an older version while a newer is read). */
  changes: HostTurnChanges | null
  /**
   * `host`: `changes` is the answer; `loading`: asked, nothing to show yet (callers show nothing rather than numbers
   * that change a moment later); `tools`: the host has no exact answer (or the read failed, or the turn has nothing to
   * ask about) — add up the tool calls.
   */
  state: 'host' | 'loading' | 'tools'
}

/**
 * One turn's host-computed changes, read when the turn is finished and has an apply or a checkpoint (and its records
 * were read, so the version is known). `running`: the caller knows the turn still runs. `mayWrite`: the turn ran a call
 * that may change files (see mayChangeFiles); without one, and with no apply records of its own, it changed nothing
 * the host could add, so nothing is asked — an answer already read for it is still used.
 */
export function useHostTurnChanges(sessionId: string, turnId: string | null | undefined, { running = false, mayWrite = true }: { running?: boolean; mayWrite?: boolean } = {}): HostTurnView {
  const turn = useApp(s => (turnId ? s.sessions[sessionId]?.turns[turnId] : undefined))
  const projectId = useApp(s => s.sessions[sessionId]?.meta?.projectId ?? s.sessionIndex[sessionId]?.projectId ?? null)
  const wanted = Boolean(turnId && projectId && turnChangesWanted(turn, running))
  const { records, loaded } = useTurnApplies(projectId, sessionId, turnId ?? '', wanted)
  // A worktree turn's apply names its records; a direct-mode turn's worker merges are records of the turn.
  const ask = wanted && (mayWrite || Boolean(turn?.apply?.applyIds?.length) || records.length > 0)
  // The records could not be read (an older host, the daemon away): no version to ask for, the tool calls stay.
  const unread = useIsolation(s => Boolean(s.applies[sessionId]?.error))
  const version = wanted && loaded && turn ? turnChangesVersion(turn, records) : null
  const entry = useTurnChanges(s => (turnId ? s.entries[keyOf(sessionId, turnId)] : undefined))
  useEffect(() => { if (ask && version && projectId && turnId) void loadTurnChanges(projectId, sessionId, turnId, version) }, [ask, version, projectId, sessionId, turnId])
  if (!wanted || !turnId || (unread && !version)) return { changes: null, state: 'tools' }
  const changes = hostFiles(entry?.data)
  if (!ask && entry?.version !== version) return { changes: null, state: 'tools' }
  if (entry?.version === version && !entry.loading) return changes ? { changes, state: 'host' } : { changes: null, state: 'tools' }
  // Still reading (or the records not read yet): an earlier answer stays up meanwhile.
  return changes ? { changes, state: 'host' } : { changes: null, state: 'loading' }
}

/** Test helper. */
export function resetTurnChanges() {
  inflight.clear()
  useTurnChanges.setState({ entries: {} })
}
