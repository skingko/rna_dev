/**
 * 工作区改动 panel, L2 (layout plan §3; contract v2 §8.5; worktree design §4):
 * the project folder's git state when it is a repository. Reads — status,
 * one file's diff, the worktrees, the local branches, a base → target
 * comparison and its patches in batches — may name another worktree of the
 * same repository (`worktree`, read only). Writes are stage / unstage and the
 * two-step discard (the second request carries the `confirm` the first
 * returned, sent only on the user's second click), on the project folder
 * only. Paths are relative to the project's workspace.
 */
import { getTransport } from './client'

export type GitRepoKind = 'none' | 'main' | 'linked'
export type GitFileStatus = 'M' | 'A' | 'D' | 'R' | 'U' | '?'
export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'
export type GitUnavailable = 'workspace_missing' | 'git_missing' | 'developer_tools' | 'timed_out' | 'git_failed'
/** One changed file. `added` / `removed` are null when git gives no counts (binary, untracked, conflicted); a path ending in `/` is an untracked folder. */
export interface GitFile { path: string; oldPath?: string; status: GitFileStatus; added: number | null; removed: number | null; binary?: boolean }
export type GitSection = 'conflicted' | 'staged' | 'unstaged' | 'untracked' | 'upstream'

export interface GitStatus {
  repo: GitRepoKind
  unavailable?: GitUnavailable
  /** The host's sentence for `unavailable`, in the interface language. */
  message?: string
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  operation: GitOperation | null
  /** No commit yet. */
  initial?: boolean
  /** 'normal': too many untracked files, listed by folder; 'no': the repository is set not to show them (status.showUntrackedFiles=no). */
  untrackedMode?: 'all' | 'normal' | 'no'
  files: { conflicted: GitFile[]; staged: GitFile[]; unstaged: GitFile[]; untracked: GitFile[]; upstream?: GitFile[] }
  truncated?: boolean
}

export type GitDiffSource = 'unstaged' | 'staged' | 'upstream'
/**
 * One file's patch. `unavailable` with `reason: 'batch_too_large'` (from `patches`) means the batch ran past its cap
 * before this file: ask for it again on its own.
 */
export interface GitDiff { kind: 'patch' | 'binary' | 'truncated' | 'unavailable'; patch?: string; reason?: string; message?: string }

/** `rna`: Rna made this worktree for a conversation; `owner`: that conversation (both false / null for every worktree today). */
export interface GitWorktree { path: string; head: string | null; branch: string | null; detached: boolean; bare: boolean; main: boolean; linked: boolean; current: boolean; locked: boolean; lockedReason?: string; prunable: boolean; prunableReason?: string; rna?: boolean; owner?: string | null }
export interface GitWorktrees { repo: GitRepoKind; worktrees: GitWorktree[]; unavailable?: GitUnavailable; message?: string }

/** A local branch (refs/heads). `worktreePath`: the worktree it is checked out in; `committedAt`: its tip's commit time (ms). */
export interface GitBranch { name: string; sha: string; upstream: string | null; committedAt: number | null; worktreePath: string | null; current: boolean }
/** `default`: origin's HEAD, else init.defaultBranch, else main / master, else the current branch (null when none is a local branch). */
export interface GitBranches { repo?: GitRepoKind; unavailable?: GitUnavailable; message?: string; current: string | null; default: string | null; branches: GitBranch[] }

/**
 * The comparison's two ends: `all` is merge-base(base, HEAD) → working tree (committed, staged, unstaged and untracked
 * work); `uncommitted` is HEAD (the empty tree before the first commit) → working tree.
 */
export type GitCompareMode = 'all' | 'uncommitted'
/** Where the comparison ends: the base branch itself (`working-tree`), another branch, or a detached HEAD (`label` is its short id). */
export interface GitCompareTarget { kind: 'branch' | 'working-tree' | 'detached'; label: string }
/** A changed file of a comparison; untracked files are counted by the host (`added` null past 1 MB, or binary). */
export interface GitCompareFile { path: string; oldPath?: string; status: GitFileStatus; added: number | null; removed: number | null; binary?: boolean; untracked?: boolean }
export interface GitCompare {
  /** Absent from hosts before the comparison existed; `none` (with `unavailable`) when the folder can't be read as a repository. */
  repo?: GitRepoKind
  unavailable?: GitUnavailable
  message?: string
  mode: GitCompareMode
  /** The base branch compared against (`all`), null for `uncommitted`. */
  base: string | null
  defaultBase: string | null
  /** The commit patches start from: merge-base(base, HEAD) for `all`, HEAD for `uncommitted` (null before the first commit). */
  mergeBase: string | null
  target: GitCompareTarget | null
  files: GitCompareFile[]
  /** More files changed than were listed (3000). */
  truncated: boolean
  operation: GitOperation | null
}
export interface GitPatches { patches: { path: string; diff: GitDiff }[] }

/** The first step of a discard: what would happen to each path, and the one-time token the second click sends back. */
/** `kept`: folders in the request that are repositories of their own (nested repositories, submodules); never discarded here. */
export interface GitDiscardPreview { confirm: string; expiresAt: string; files: { path: string; action: 'restore' | 'delete' }[]; kept?: { path: string; reason: 'repository' }[] }

/** At most this many paths go in one `patches` request (the host refuses more). */
export const MAX_PATCH_PATHS = 40

const enc = encodeURIComponent
const base = (projectId: string) => `/api/v2/projects/${enc(projectId)}/git`
/** `?a=1&b=2` from the defined entries (repeated keys for arrays), or '' when none is. */
function query(params: Record<string, string | string[] | null | undefined>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    for (const one of Array.isArray(value) ? value : [value]) if (one !== undefined && one !== null && one !== '') parts.push(`${key}=${enc(one)}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

export const gitApi = {
  status: (projectId: string, { upstream = false, worktree }: { upstream?: boolean; worktree?: string | null } = {}) =>
    getTransport().request<GitStatus>(`${base(projectId)}${query({ include: upstream ? 'upstream' : null, worktree })}`),
  diff: (projectId: string, source: GitDiffSource, path: string, oldPath?: string) =>
    getTransport().request<GitDiff>(`${base(projectId)}/diff?source=${source}&path=${enc(path)}${oldPath ? `&oldPath=${enc(oldPath)}` : ''}`),
  worktrees: (projectId: string) => getTransport().request<GitWorktrees>(`${base(projectId)}/worktrees`),
  branches: (projectId: string, { worktree }: { worktree?: string | null } = {}) =>
    getTransport().request<GitBranches>(`${base(projectId)}/branches${query({ worktree })}`),
  /** `base`: a listed branch (null: the default branch); only `all` reads it. */
  compare: (projectId: string, { mode, base: branch, worktree }: { mode: GitCompareMode; base?: string | null; worktree?: string | null }) =>
    getTransport().request<GitCompare>(`${base(projectId)}/compare${query({ mode, base: mode === 'all' ? branch : null, worktree })}`),
  /** Up to {@link MAX_PATCH_PATHS} files' patches from `from` (the comparison's mergeBase, or HEAD for uncommitted work). `oldPaths`: moved files' old names. */
  patches: (projectId: string, { from, paths, oldPaths = [], worktree }: { from: string; paths: string[]; oldPaths?: string[]; worktree?: string | null }) =>
    getTransport().request<GitPatches>(`${base(projectId)}/patches${query({ base: from, worktree, path: paths, oldPath: oldPaths })}`),
  /** One file of a comparison; `context: 'all'` gives the whole file around the changes (展开 N 行). */
  compareDiff: (projectId: string, { from, path, oldPath, context, worktree }: { from: string; path: string; oldPath?: string; context?: 'all'; worktree?: string | null }) =>
    getTransport().request<GitDiff>(`${base(projectId)}/diff${query({ source: 'compare', base: from, path, oldPath, context, worktree })}`),
  stage: (projectId: string, paths: string[]) => getTransport().request<{ staged: string[]; status: GitStatus }>(`${base(projectId)}/stage`, { method: 'POST', body: { paths } }),
  unstage: (projectId: string, paths: string[]) => getTransport().request<{ unstaged: string[]; status: GitStatus }>(`${base(projectId)}/unstage`, { method: 'POST', body: { paths } }),
  previewDiscard: (projectId: string, paths: string[]) => getTransport().request<GitDiscardPreview>(`${base(projectId)}/discard`, { method: 'POST', body: { paths } }),
  confirmDiscard: (projectId: string, paths: string[], confirm: string) =>
    getTransport().request<{ discarded: GitDiscardPreview['files']; kept?: GitDiscardPreview['kept']; status: GitStatus }>(`${base(projectId)}/discard`, { method: 'POST', body: { paths, confirm } }),
}
