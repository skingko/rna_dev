/**
 * Where a conversation's files are (worktree design §9, web part). A conversation that runs in its own worktree
 * works in S (`<P>/.rna/worktrees.nosync/s-…`, plus the project's prefix in its repository); every other one in the
 * project folder P (`project.workspacePath`, which stays P for worktree conversations too).
 *
 * `rootsOf` lists the roots a path a tool reported can be under, the conversation's own first: S lies inside P, so
 * a path under S read against P alone would name `.rna/worktrees.nosync/…`, which the host never serves. Reads of a
 * worktree conversation's files carry `?sessionId=` (the host resolves its root); `readSessionFor` says when.
 */
import { createContext, useContext, useMemo } from 'react'
import type { SessionMeta } from '@/api/types'
import type { RnaWorktree } from '@/api/worktree-api'
import { useApp } from '@/store/app-store'
import { sessionWorktreeRow, useIsolation, useWorktrees } from '@/store/isolation-store'
import { toWorkspacePath } from '@/components/preview/registry'

/**
 * A worktree's root: the worktree plus the project's prefix in its repository. The host's row names the worktree
 * (`path`, what the git panel's `worktree` takes); `root` names the root, which differs when the project is a
 * subfolder of its repository. An older host without `root`: the worktree itself (right at a repository's top).
 * Null when the host names neither (it cannot find the project's repository any more).
 */
export const worktreeRoot = (row: RnaWorktree): string | null => row.root || row.path

/**
 * Whether a conversation's files are read through its own worktree: it runs in one that exists. A `pending` one has
 * no folder yet (before its first turn, or restored from the archive after the worktree was cleaned up): its files
 * are the project folder's, and the host refuses a read through it (409 worktree_pending).
 */
const readsOwnCopy = (worktree: SessionMeta['worktree']) => Boolean(worktree && worktree.state !== 'pending')

interface RootFacts { projectId: string | null; project: string | null; worktreeId: string | null; isWorktree: boolean; reads: boolean }

function factsOf(sessionId: string | null | undefined): RootFacts {
  const app = useApp.getState()
  const meta = sessionId ? app.sessions[sessionId]?.meta ?? app.sessionIndex[sessionId] : undefined
  const projectId = meta?.projectId ?? null
  return { projectId, project: projectId ? app.projects[projectId]?.workspacePath ?? null : null, worktreeId: meta?.worktree?.id ?? null, isWorktree: Boolean(meta?.worktree), reads: readsOwnCopy(meta?.worktree) }
}

/** The roots of a conversation's files, its own first (S, then P); just P for a conversation in the project folder. */
export function rootsOf(sessionId: string | null | undefined): string[] {
  const facts = factsOf(sessionId)
  const roots: string[] = []
  if (facts.isWorktree && facts.projectId) {
    const row = sessionWorktreeRow(useIsolation.getState().worktrees[facts.projectId]?.data, sessionId!, facts.worktreeId)
    const root = row ? worktreeRoot(row) : null
    if (root) roots.push(root)
  }
  if (facts.project) roots.push(facts.project)
  return roots
}

/** `rootsOf` as a hook: reads the project's worktrees when the conversation has one. */
export function useSessionRoots(sessionId: string | null | undefined): string[] {
  const projectId = useApp(s => (sessionId ? s.sessions[sessionId]?.meta.projectId ?? s.sessionIndex[sessionId]?.projectId ?? null : null))
  const worktreeId = useApp(s => (sessionId ? (s.sessions[sessionId]?.meta ?? s.sessionIndex[sessionId])?.worktree?.id ?? null : null))
  const isWorktree = useApp(s => Boolean(sessionId && (s.sessions[sessionId]?.meta ?? s.sessionIndex[sessionId])?.worktree))
  const project = useApp(s => (projectId ? s.projects[projectId]?.workspacePath ?? null : null))
  const list = useWorktrees(projectId, { enabled: isWorktree }).data
  return useMemo(() => {
    const row = isWorktree && sessionId ? sessionWorktreeRow(list, sessionId, worktreeId) : null
    const root = row ? worktreeRoot(row) : null
    return [...(root ? [root] : []), ...(project ? [project] : [])]
  }, [isWorktree, sessionId, list, worktreeId, project])
}

/** The roots for a path of `projectId` seen from `sessionId` (only that conversation's own when it belongs to the project). */
export function rootsFor(projectId: string, sessionId: string | null | undefined): string[] {
  const facts = factsOf(sessionId)
  if (facts.projectId === projectId) return rootsOf(sessionId)
  const project = useApp.getState().projects[projectId]?.workspacePath
  return project ? [project] : []
}

/** A path a tool reported, relative to the conversation's root (null outside every root). */
export const sessionPath = (path: string, roots: readonly string[]) => toWorkspacePath(path, roots)

/**
 * The conversation whose root a read of `projectId`'s files goes through (`?sessionId=`): `sessionId` when it is a
 * worktree conversation of that project whose worktree exists, else null (the project folder, as before 0.63).
 */
export function readSessionFor(projectId: string, sessionId: string | null | undefined): string | null {
  const facts = factsOf(sessionId)
  return facts.reads && facts.projectId === projectId ? sessionId! : null
}
export function useReadSession(projectId: string | null | undefined, sessionId: string | null | undefined): string | null {
  return useApp(s => {
    if (!projectId || !sessionId) return null
    const meta = s.sessions[sessionId]?.meta ?? s.sessionIndex[sessionId]
    return readsOwnCopy(meta?.worktree) && meta?.projectId === projectId ? sessionId : null
  })
}

/**
 * Reads under a file preview go through this conversation's root (a Markdown document's images, the download
 * button): FilePreview provides it from its `sessionId`, null = the project folder.
 */
export const ReadSessionContext = createContext<string | null>(null)
export const useReadSessionContext = () => useContext(ReadSessionContext)
