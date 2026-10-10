/**
 * What changed in a project's folder (layout plan §3), shared by the 工作区改动
 * panel and the Files panel's markers: git's status when the folder is a
 * repository (L2), else Rna's own records (L1) — the project's background
 * change sets and the current conversation's edits.
 *
 * The git status lives in one small store per project and is reloaded on
 * open, on window focus, when a run ends (a background run settles, a change
 * set appears or is reverted, the conversation's turn finishes) and on
 * request; concurrent loads of one project share a request.
 */
import { useEffect, useMemo, useRef } from 'react'
import { create } from 'zustand'
import { gitApi, type GitFile, type GitStatus } from '@/api/git-api'
import type { BackgroundChange, Item, Turn } from '@/api/types'
import { useApp } from '@/store/app-store'
import { useWholeHistory } from '@/store/use-whole-history'
import { toWorkspacePath } from '@/components/preview/registry'
import { fileChange, toolUnfinished } from '@/lib/tools'
import { useSessionRoots } from '@/lib/session-root'

export type ChangeKind = 'added' | 'modified' | 'deleted'

export interface GitEntry {
  status: GitStatus | null
  /** Files since the branch left its upstream (loaded only when that view is asked for). */
  upstreamFiles: GitFile[] | null
  loading: boolean
  error: string | null
  /** When the last load finished (ms). */
  at: number
}
export const useGitStatus = create<{ rows: Record<string, GitEntry> }>(() => ({ rows: {} }))

/**
 * Git answered for a repository (not a plain folder, and not a read that timed out or failed: those show Rna's
 * records). Only a repository's answer counts, so a host without the route never reads as one.
 */
export const gitReadable = (status: GitStatus | null | undefined): status is GitStatus => Boolean((status?.repo === 'main' || status?.repo === 'linked') && !status.unavailable && status.files)

const EMPTY_ENTRY: GitEntry = { status: null, upstreamFiles: null, loading: false, error: null, at: 0 }
const inflight = new Map<string, Promise<void>>()
const patch = (projectId: string, next: Partial<GitEntry>) =>
  useGitStatus.setState(s => ({ rows: { ...s.rows, [projectId]: { ...(s.rows[projectId] ?? EMPTY_ENTRY), ...next } } }))

/**
 * Read the project's git status. A load already on its way is shared; `minAgeMs` skips the read when the last one is
 * that recent (window focus right after a refresh).
 */
export function loadGitStatus(projectId: string, { upstream = false, minAgeMs = 0 }: { upstream?: boolean; minAgeMs?: number } = {}): Promise<void> {
  const key = `${projectId}\u0000${upstream ? 1 : 0}`
  const running = inflight.get(key)
  if (running) return running
  const row = useGitStatus.getState().rows[projectId]
  if (minAgeMs && row?.at && Date.now() - row.at < minAgeMs) return Promise.resolve()
  patch(projectId, { loading: true })
  const request = gitApi.status(projectId, { upstream }).then(
    status => patch(projectId, { status, loading: false, error: null, at: Date.now(), ...(upstream ? { upstreamFiles: status.files.upstream ?? [] } : {}) }),
    (error: Error) => patch(projectId, { loading: false, error: error.message, at: Date.now() }),
  ).finally(() => { inflight.delete(key) })
  inflight.set(key, request)
  return request
}
/** A write's answer carries the fresh status: take it without another read. */
export function setGitStatus(projectId: string, status: GitStatus) { patch(projectId, { status, loading: false, error: null, at: Date.now() }) }
/** Test helper. */
export function resetGitStatus() { inflight.clear(); useGitStatus.setState({ rows: {} }) }

const appliedCache = new WeakMap<Record<string, Turn>, string>()
/**
 * The conversation's writes into the project folder (0.63): each turn's apply status and records, and each
 * direct-mode turn's checkpoint state. A worktree conversation's changes reach the folder when they are applied —
 * also between turns (a worker merged while it was idle) — so that ends a run as well.
 */
export function appliedKey(turns: Record<string, Turn> | undefined): string {
  if (!turns) return ''
  let key = appliedCache.get(turns)
  if (key === undefined) {
    key = Object.values(turns).flatMap(turn => (turn.apply || turn.checkpoint ? [`${turn.id}:${turn.apply?.status ?? ''}:${turn.apply?.applyIds?.length ?? 0}:${turn.checkpoint?.state ?? ''}`] : [])).join(',')
    appliedCache.set(turns, key)
  }
  return key
}

/** A fingerprint of "a run ended": finished background runs, change sets and their state, the conversation's applies, and whether it is mid-turn. */
function useSettleKey(projectId: string | null, sessionId: string | null): string {
  const recent = useApp(s => (projectId ? s.projects[projectId]?.work?.recent : undefined))
  const changes = useApp(s => (projectId ? s.projects[projectId]?.backgroundChanges : undefined))
  const running = useApp(s => Boolean(sessionId && s.sessionIndex[sessionId]?.status === 'running'))
  const applied = useApp(s => (sessionId ? appliedKey(s.sessions[sessionId]?.turns) : ''))
  return useMemo(() => `${(recent ?? []).map(run => `${run.id}:${run.status}`).join(',')}|${(changes ?? []).map(row => `${row.id}:${row.status}`).join(',')}|${applied}|${running ? 'busy' : 'idle'}`, [recent, changes, applied, running])
}

/**
 * Keep a project's git status current while something shows it: read on mount, on window focus, and when a run ends
 * (never while one is only progressing, and not when a turn starts).
 */
export function useGitWatch(projectId: string | null, sessionId: string | null, { upstream = false, enabled = true }: { upstream?: boolean; enabled?: boolean } = {}) {
  const active = Boolean(projectId && enabled)
  useEffect(() => { if (active) void loadGitStatus(projectId!, { upstream }) }, [active, projectId, upstream])
  useEffect(() => {
    if (!active) return
    const onFocus = () => { void loadGitStatus(projectId!, { upstream, minAgeMs: 1500 }) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [active, projectId, upstream])
  const settle = useSettleKey(projectId, sessionId)
  const previous = useRef(settle)
  useEffect(() => {
    const before = previous.current
    previous.current = settle
    if (!active || before === settle || settle.endsWith('|busy')) return
    void loadGitStatus(projectId!, { upstream })
  }, [settle, active, projectId, upstream])
}

/* ------------------------------------------------------------ markers */

const EMPTY_MAP: ReadonlyMap<string, ChangeKind> = new Map()
const NO_ITEMS: Record<string, Item> = {}
const NO_ORDER: string[] = []

/** How a git row reads on a file: new (staged new or untracked), removed from disk, or otherwise changed. */
export function gitChangeKind(file: GitFile): ChangeKind {
  return file.status === 'A' || file.status === '?' || file.status === 'R' ? 'added' : file.status === 'D' ? 'deleted' : 'modified'
}

/** Workspace path → change, from git's groups: what is on disk (unstaged) wins over the index, except that a new file stays new. */
export function changesFromGit(status: GitStatus): [string, ChangeKind][] {
  const out = new Map<string, ChangeKind>()
  const put = (file: GitFile) => {
    const path = file.path.replace(/\/$/, ''), kind = gitChangeKind(file), current = out.get(path)
    out.set(path, !current || kind === 'deleted' ? kind : current === 'added' || kind === 'added' ? 'added' : 'modified')
  }
  status.files.staged.forEach(put); status.files.conflicted.forEach(put); status.files.unstaged.forEach(put); status.files.untracked.forEach(put)
  return [...out]
}

/**
 * Workspace path → change, from Rna's records: kept background change sets, then the conversation's own edits and
 * writes. `workspace`: the project folder, or a conversation's roots (lib/session-root `rootsOf`, its worktree first).
 */
export function changesFromRecords(changes: BackgroundChange[] | undefined, items: Record<string, Item>, order: string[], workspace: string | readonly string[] | undefined): [string, ChangeKind][] {
  const out = new Map<string, ChangeKind>()
  for (const set of changes ?? []) if (set.status === 'kept') for (const path of set.paths) { const local = toWorkspacePath(path, workspace); if (local && !out.has(local)) out.set(local, 'modified') }
  for (const id of order) {
    const item = items[id]
    if (!item?.tool || toolUnfinished(item.tool)) continue
    const change = fileChange(item), local = change?.path ? toWorkspacePath(change.path, workspace) : null
    if (local && change) out.set(local, change.created || out.get(local) === 'added' ? 'added' : 'modified')
  }
  return [...out]
}

const KIND_OF: Record<string, ChangeKind> = { a: 'added', m: 'modified', d: 'deleted' }
/** Entries as one string (kind letter + path, NUL-separated): equal content, equal string. */
const encode = (entries: [string, ChangeKind][]) => entries.map(([path, kind]) => `${kind[0]}${path}`).join('\u0000')
const decode = (key: string): [string, ChangeKind][] => (key ? key.split('\u0000').map(part => [part.slice(1), KIND_OF[part[0]]]) : [])

const editsCache = new WeakMap<Record<string, Item>, { order: string[]; workspace: string; key: string }>()
/**
 * The conversation's finished file edits, encoded: read inside a store selector, so a streaming delta that changes
 * none of them re-renders nothing (one pass over the conversation per change of its items, none otherwise).
 */
function sessionEdits(items: Record<string, Item>, order: string[], roots: readonly string[]): string {
  const workspace = roots.join('\u0000')
  const hit = editsCache.get(items)
  if (hit && hit.order === order && hit.workspace === workspace) return hit.key
  const key = encode(changesFromRecords(undefined, items, order, roots))
  editsCache.set(items, { order, workspace, key })
  return key
}

/**
 * Changed files of a project, keyed by workspace-relative path: git's status when the folder is a repository, else
 * Rna's records (background change sets plus the given conversation's edits). The map keeps its identity while its
 * content is unchanged, and streaming deltas do not re-render the caller.
 */
export function useChangedPaths(projectId: string | null, sessionId: string | null): ReadonlyMap<string, ChangeKind> {
  useGitWatch(projectId, sessionId)
  const status = useGitStatus(s => (projectId ? s.rows[projectId]?.status : undefined))
  // A read of the folder's git state has finished (the row exists from the moment the first read starts).
  const answered = useGitStatus(s => Boolean(projectId && (s.rows[projectId]?.at ?? 0) > 0))
  const git = gitReadable(status) ? status : null
  const changes = useApp(s => (projectId && !git ? s.projects[projectId]?.backgroundChanges : undefined))
  const workspace = useApp(s => (projectId ? s.projects[projectId]?.workspacePath : undefined))
  // The conversation's edits are under its own root (a worktree conversation's copy first).
  const sessionRoots = useSessionRoots(sessionId)
  const own = useApp(s => Boolean(projectId && sessionId && (s.sessions[sessionId]?.meta.projectId ?? s.sessionIndex[sessionId]?.projectId) === projectId))
  const roots = useMemo(() => (own ? sessionRoots : workspace ? [workspace] : []), [own, sessionRoots, workspace])
  // Without git (a finished read that is not a repository's answer), the marks come from every edit of the
  // conversation: older turns than the timeline's window are paged in (B9). Not while the first read is on its way: a
  // repository would page the whole conversation in for nothing.
  useWholeHistory(sessionId, Boolean(projectId && own && answered && !git))
  const edits = useApp(s => { const slice = projectId && sessionId && !git ? s.sessions[sessionId] : undefined; return slice ? sessionEdits(slice.items, slice.order, roots) : '' })
  // The conversation's edits override the change sets' marks (as changesFromRecords merges them).
  const entries = useMemo(() => {
    if (!projectId) return []
    if (git) return changesFromGit(git)
    const merged = new Map(changesFromRecords(changes, NO_ITEMS, NO_ORDER, workspace))
    for (const [path, kind] of decode(edits)) merged.set(path, kind)
    return [...merged]
  }, [projectId, git, changes, edits, workspace])
  const cached = useRef<{ key: string; map: ReadonlyMap<string, ChangeKind> }>({ key: '', map: EMPTY_MAP })
  const key = encode(entries)
  if (cached.current.key !== key) cached.current = { key, map: entries.length ? new Map(entries) : EMPTY_MAP }
  return cached.current.map
}

const folderCache = new WeakMap<ReadonlyMap<string, ChangeKind>, ReadonlySet<string>>()
/** Every folder above a changed file (a folder shows that something inside it changed); cached per map. */
export function changedFolders(map: ReadonlyMap<string, ChangeKind>): ReadonlySet<string> {
  let folders = folderCache.get(map)
  if (!folders) {
    const set = new Set<string>()
    for (const path of map.keys()) for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) { const folder = path.slice(0, at); if (set.has(folder)) break; set.add(folder) }
    folderCache.set(map, folders = set)
  }
  return folders
}
