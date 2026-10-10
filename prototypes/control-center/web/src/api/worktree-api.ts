/**
 * Worktree isolation, apply records, rollback and git init (0.63; contract v2 §8.6–8.8; worktree design §11).
 * Every write here is two steps where it can lose work: the first request changes nothing and answers what would
 * happen plus a one-time `confirm`; the web sends that back only on the user's second click. Paths are relative to
 * the project folder. Errors arrive as ApiError with the host's `code` (worktree_unconfirmed, rollback_changed,
 * git_init_changed, …) and a message already in the interface language.
 */
import { getTransport } from './client'
import type { ConflictPath, IsolationReason, ISODate, ProjectSummary, SubagentInfo } from './types'
import type { GitDiff } from './git-api'

/* ------------------------------------------------------------------ isolation and worktrees (§8.6) */

/** Whether this project's conversations, workers and background work can run in worktrees, and why not. */
export interface Isolation { enabled: boolean; reason?: IsolationReason | (string & {}); git: string | null }
export type RnaWorktreeKind = 'session' | 'worker' | 'background' | 'orphan'
export type RnaWorktreeState = 'active' | 'kept' | 'conflicted' | 'removed' | 'missing'
/** One of Rna's worktrees. `pending.files`: files not yet in the project folder. */
export interface RnaWorktree {
  id: string
  kind: RnaWorktreeKind | (string & {})
  owner: { sessionId?: string; turnId?: string; agentId?: string; actionId?: string }
  /** Absolute (the git panel's `worktree`); null when the host cannot find the project's repository any more. */
  path: string | null
  /**
   * The folder the work happens in: the worktree plus the project's prefix in its repository (= `path` at the
   * repository's top). Absent from older hosts; null with `path`.
   */
  root?: string | null
  state: RnaWorktreeState | (string & {})
  createdAt: ISODate
  /** Measured in the background; absent until known. */
  sizeBytes?: number
  /**
   * `files`: files not yet in the project folder. `secret` (B8, absent when 0): files that hold secrets (.env, keys…)
   * its owner changed; they never merge into the project folder and move to the trash with the worktree.
   */
  pending: { files: number; secret?: number }
}
export interface RnaWorktrees { isolation: Isolation; worktrees: RnaWorktree[] }
/**
 * The first step of applying or discarding a kept / orphan / conflicted worktree. `secret` (B8): files holding secrets
 * the worktree's owner changed, never applied (a discard lists them in `files` too); `note`: the host's sentence about
 * them (interface language).
 */
export interface WorktreeActionPreview { confirm: string; expiresAt: ISODate; files: { path: string; action: 'restore' | 'delete' | 'create' | 'modify' }[]; conflicts?: ConflictPath[]; secret?: string[]; note?: string }
/** `secret` / `note` (B8): the secret files left out of the apply, or discarded, and where they went (interface language). */
export interface WorktreeActionResult { worktree: RnaWorktree; applyId?: string | null; conflicts?: ConflictPath[]; secret?: string[]; note?: string }

/* ------------------------------------------------------------------ apply records and rollback (§8.7) */

export type ApplyKind = 'turn' | 'worker' | 'background' | 'resolve' | 'rollback' | 'user_discard'
export type ApplyState = 'writing' | 'verified' | 'unverified' | 'interrupted' | 'rolled_back' | 'expired'
/** One write into the project folder (or, for crash recovery only, into a worktree: `target` is then not `project`). */
export interface ApplyRecord {
  id: string
  kind: ApplyKind | (string & {})
  target: 'project' | (string & {})
  source: { sessionId?: string; turnId?: string; agentId?: string; actionId?: string; worktreeId?: string }
  state: ApplyState | (string & {})
  files: number
  added: number
  removed: number
  bothChanged: number
  /** Up to 20 of its paths. */
  sample: string[]
  skipped?: { path: string; reason: string }[]
  at: ISODate
  /** A rollback: the record it undid. */
  undoes?: string | null
  /** A whole turn's rollback (POST …/turns/:turnId/rollback): that turn. A rollback of one record alone has none. */
  undoesTurn?: string | null
  /** The rollback that undid this record. */
  rolledBackBy?: string | null
  /** Whether it can be rolled back now (`reason`: expired, rolled_back, target, interrupted). */
  rollback: { available: boolean; reason?: string }
}
export interface ApplyFile { path: string; oldPath?: string; status: 'A' | 'M' | 'D' | 'R'; added: number | null; removed: number | null; binary?: boolean }
export interface ApplyDetail extends ApplyRecord { paths: ApplyFile[]; truncated?: boolean }
/** The first step of a rollback: what each path would do; `skipped` paths changed since and are left alone unless forced. */
export interface RollbackPreview {
  confirm: string
  expiresAt: ISODate
  files: { path: string; action: 'restore' | 'delete' | 'recreate' }[]
  skipped: { path: string; reason: 'changed_after' | 'conflict' | 'unattributable' | (string & {}) }[]
  /** Direct-mode turns: other writes into the folder at the same time cannot be told apart (host text, interface language). */
  note?: string
}
export interface RollbackResult { applyId: string; restored: string[]; skipped: { path: string; reason: string }[]; verify: 'verified' | 'unverified' }
export interface RollbackInput { paths?: string[]; force?: string[] }

/* ------------------------------------------------------------------ a turn's net change (§8.7, host-computed) */

/** One record's part of a file someone else changed between this turn's records (its own before → after). */
export interface TurnChangeSection { applyId: string; at: ISODate; kind: ApplyKind | (string & {}); status: ApplyFile['status']; added: number | null; removed: number | null; binary?: boolean; rolledBack?: boolean }
/**
 * A file the turn changed in the project folder, first before → last after across its records. `rolledBack`: a
 * rollback still in effect restored it (every record of the turn that wrote it, or the whole turn). `changedBetween`:
 * someone else changed it between the turn's records, so each record is a section of its own (`sections`; the counts
 * are theirs added up). `unattributed` (direct mode): it changed while the turn ran but no call or record of the turn
 * wrote it by name — the turn ran a command or another tool that may have, or the user or another conversation did.
 */
export interface TurnChangeFile extends ApplyFile { rolledBack?: boolean; changedBetween?: boolean; sections?: TurnChangeSection[]; unattributed?: boolean }
/**
 * `GET …/turns/:turnId/changes`: `records` (a worktree conversation's turn, from its apply records into the project
 * folder) or `checkpoint` (a direct-mode turn, start → end of its own paths; `uncovered`: files its write tools wrote
 * that no snapshot holds, ignored or too big; `shared`: files it wrote that another owner's record also wrote while it
 * ran, which the diff cannot tell apart). `tools`: the host cannot say exactly (`reason`: pending, conflicted,
 * no_records, no_checkpoint, expired, plan, archived, running, git_unavailable, …) — the turn's tool calls are added
 * up instead.
 */
export type TurnChanges =
  | { source: 'records' | 'checkpoint'; files: TurnChangeFile[]; applyIds?: string[]; uncovered?: string[]; shared?: { path: string; applyId: string }[]; truncated?: boolean }
  | { source: 'tools'; reason: string }
export type HostTurnChanges = Extract<TurnChanges, { files: TurnChangeFile[] }>
/** One file's patch: `diff` for a composed file, `sections` (one per record, oldest first) for a file changed between them. */
export interface TurnPatch { path: string; diff?: GitDiff; sections?: { applyId: string; rolledBack?: boolean; diff: GitDiff }[] }

/* ------------------------------------------------------------------ a worker's merge (subagent card) */

export type AgentMergeAction = 'merge' | 'drop' | 'handoff'
/** `merge`: the host merges again (pending / conflicted workers); `handoff`: a host-written turn asks Rna to settle it. */
export interface AgentMergeResult { subagent: SubagentInfo; applied?: string[]; conflicts?: ConflictPath[]; turnId?: string | null }
/** The first step of dropping a worker whose changes were already merged (a rollback of that merge). */
export interface AgentDropPreview { confirm: string; expiresAt: ISODate; files: RollbackPreview['files']; skipped: RollbackPreview['skipped'] }

/* ------------------------------------------------------------------ git init (§8.8) */

export type GitIgnoreRule = 'always' | 'ecosystem' | 'secret' | 'venv' | 'large' | 'nested' | 'user'
export interface GitInitLine { text: string; rule: GitIgnoreRule | (string & {}); marker?: string; count?: number; bytes?: number }
export interface GitIdentity { name: string; email: string }
export interface GitInitPreview {
  confirm: string
  expiresAt: ISODate
  folder: string
  branch: string
  identity: GitIdentity | null
  identityRequired: boolean
  /** `exists`: a `.gitignore` is there already; only a block marked "# Added by Rna Agent" is appended. */
  gitignore: { exists: boolean; lines: GitInitLine[] }
  files: { count: number; bytes: number; largest: { path: string; bytes: number }[] }
  largeFiles: { path: string; bytes: number }[]
  nested: string[]
  /** Past 20 000 files or 2 GB: the confirmation must carry `acknowledgeLarge`. */
  needsAcknowledge: boolean
  /** The folder is probably synced by iCloud Drive. */
  icloud: boolean
  /** An outer repository that does not count (a home dotfiles repository, or one that ignores this folder). */
  outer?: { top: string; kind: 'dotfiles' | 'ignored' } | null
}
export interface GitInitResult { commit: string; branch: string; files: number; largeFiles: { path: string; bytes: number }[]; status: 'clean' | 'changed'; changed?: string[] }
export interface GitInitConfirm { lines?: string[]; identity?: GitIdentity; acknowledgeLarge?: boolean }

/* ------------------------------------------------------------------ client */

const enc = encodeURIComponent
const project = (projectId: string) => `/api/v2/projects/${enc(projectId)}`
/** `?a=1&b=2` from the defined entries (repeated keys for arrays), or '' when none is. */
function query(params: Record<string, string | number | string[] | null | undefined>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    for (const one of Array.isArray(value) ? value : [value]) if (one !== undefined && one !== null && one !== '') parts.push(`${key}=${enc(String(one))}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}
const post = <T,>(path: string, body: unknown) => getTransport().request<T>(path, { method: 'POST', body })

/** At most this many paths go in one `applyPatches` request (as the git panel's batches). */
export const MAX_APPLY_PATCH_PATHS = 40

export const worktreeApi = {
  /** Isolation conditions and Rna's worktrees of a project. */
  worktrees: (projectId: string) => getTransport().request<RnaWorktrees>(`${project(projectId)}/worktrees`),
  previewWorktreeApply: (projectId: string, worktreeId: string) => post<WorktreeActionPreview>(`${project(projectId)}/worktrees/${enc(worktreeId)}/apply`, {}),
  confirmWorktreeApply: (projectId: string, worktreeId: string, confirm: string) => post<WorktreeActionResult>(`${project(projectId)}/worktrees/${enc(worktreeId)}/apply`, { confirm }),
  previewWorktreeDiscard: (projectId: string, worktreeId: string) => post<WorktreeActionPreview>(`${project(projectId)}/worktrees/${enc(worktreeId)}/discard`, {}),
  confirmWorktreeDiscard: (projectId: string, worktreeId: string, confirm: string) => post<WorktreeActionResult>(`${project(projectId)}/worktrees/${enc(worktreeId)}/discard`, { confirm }),

  /** Apply records, newest first; `sessionId` / `turnId` narrow them to one conversation or turn. */
  applies: (projectId: string, { sessionId, turnId, limit }: { sessionId?: string | null; turnId?: string | null; limit?: number } = {}) =>
    getTransport().request<{ applies: ApplyRecord[] }>(`${project(projectId)}/applies${query({ sessionId, turnId, limit })}`),
  apply: (projectId: string, applyId: string) => getTransport().request<ApplyDetail>(`${project(projectId)}/applies/${enc(applyId)}`),
  /** Up to {@link MAX_APPLY_PATCH_PATHS} files' before → after patches. */
  applyPatches: (projectId: string, applyId: string, paths: string[]) =>
    getTransport().request<{ patches: { path: string; diff: GitDiff }[] }>(`${project(projectId)}/applies/${enc(applyId)}/patches${query({ path: paths })}`),
  previewRollback: (projectId: string, applyId: string, input: RollbackInput = {}) => post<RollbackPreview>(`${project(projectId)}/applies/${enc(applyId)}/rollback`, input),
  confirmRollback: (projectId: string, applyId: string, confirm: string, input: RollbackInput = {}) => post<RollbackResult>(`${project(projectId)}/applies/${enc(applyId)}/rollback`, { ...input, confirm }),
  /** A whole turn: a worktree session's turn records, or a direct-mode turn's checkpoint. */
  previewTurnRollback: (projectId: string, turnId: string, input: RollbackInput = {}) => post<RollbackPreview>(`${project(projectId)}/turns/${enc(turnId)}/rollback`, input),
  confirmTurnRollback: (projectId: string, turnId: string, confirm: string, input: RollbackInput = {}) => post<RollbackResult>(`${project(projectId)}/turns/${enc(turnId)}/rollback`, { ...input, confirm }),
  /** What one turn changed in the project folder, per file, as the host computes it (or `tools`). */
  turnChanges: (projectId: string, turnId: string, { sessionId }: { sessionId?: string | null } = {}) =>
    getTransport().request<TurnChanges>(`${project(projectId)}/turns/${enc(turnId)}/changes${query({ sessionId })}`),
  /** Up to {@link MAX_APPLY_PATCH_PATHS} of those files' patches. */
  turnPatches: (projectId: string, turnId: string, paths: string[], { sessionId }: { sessionId?: string | null } = {}) =>
    getTransport().request<{ patches: TurnPatch[] }>(`${project(projectId)}/turns/${enc(turnId)}/changes/patches${query({ sessionId, path: paths })}`),

  /** Subagent card buttons: 合并 (merge), 让 Rna 处理 (handoff). */
  agentMerge: (sessionId: string, agentId: string, action: 'merge' | 'handoff') =>
    post<AgentMergeResult>(`/api/v2/sessions/${enc(sessionId)}/agents/${enc(agentId)}/merge`, { action }),
  /** 丢弃, first step: what would be undone (an unmerged worker answers with empty `files`). */
  previewAgentDrop: (sessionId: string, agentId: string) => post<AgentDropPreview>(`/api/v2/sessions/${enc(sessionId)}/agents/${enc(agentId)}/merge`, { action: 'drop' }),
  confirmAgentDrop: (sessionId: string, agentId: string, confirm: string) => post<AgentMergeResult>(`/api/v2/sessions/${enc(sessionId)}/agents/${enc(agentId)}/merge`, { action: 'drop', confirm }),

  /** Make the project folder a git repository: the preview writes nothing; `lines` are the user's edited `.gitignore` lines. */
  previewGitInit: (projectId: string, { lines }: { lines?: string[] } = {}) => post<GitInitPreview>(`${project(projectId)}/git/init`, lines ? { lines } : {}),
  confirmGitInit: (projectId: string, confirm: string, input: GitInitConfirm = {}) => post<GitInitResult>(`${project(projectId)}/git/init`, { ...input, confirm }),

  /** Whether new conversations of this project start in their own worktree. */
  setSessionWorktreeDefault: (projectId: string, value: boolean) =>
    getTransport().request<ProjectSummary>(`/api/projects/${enc(projectId)}`, { method: 'PATCH', body: { git: { sessionWorktreeDefault: value } } }),
}
