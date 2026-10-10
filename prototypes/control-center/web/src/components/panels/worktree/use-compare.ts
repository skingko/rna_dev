/**
 * The comparison's file list (GET …/git/compare) for one view of the panel:
 * read when the view changes (an older answer is dropped by a generation
 * counter), again on request, and — for another worktree, which the shared
 * git status does not watch — when the window comes back into focus. The
 * project folder's own list is read again by the panel whenever its git
 * status is (window focus, a run ending, a stage or discard).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { gitApi, type GitCompare, type GitStatus } from '@/api/git-api'
import { ApiError } from '@/api/transport'
import type { CompareMode } from './compare-model'

export interface CompareRead {
  compare: GitCompare | null
  loading: boolean
  /** The read failed: the host's sentence and code (`no_common_history`, `git_base_not_found`, …). */
  error: { message: string; code?: string } | null
}

const IDLE: CompareRead = { compare: null, loading: false, error: null }
/** A focus right after a read reads nothing again. */
const FOCUS_MIN_AGE = 1500

/** `mode` null: this view lists nothing (本次对话的改动, grouping by stage, no repository). */
export function useCompare(projectId: string, mode: CompareMode | null, base: string | null, target: string | null): CompareRead & { reload: () => void } {
  const [read, setRead] = useState<CompareRead>(IDLE)
  const generation = useRef(0)
  const lastAt = useRef(0)
  const load = useCallback((fresh: boolean) => {
    const current = ++generation.current
    if (!mode) { setRead(IDLE); return }
    lastAt.current = Date.now()
    // Another comparison shows nothing of the previous one; the same one keeps its list on screen while it is read.
    setRead(state => (fresh ? { compare: null, loading: true, error: null } : { ...state, loading: true }))
    gitApi.compare(projectId, { mode, base, worktree: target }).then(
      compare => { if (generation.current === current) setRead({ compare, loading: false, error: null }) },
      (error: Error) => {
        if (generation.current !== current) return
        setRead(state => ({ compare: fresh ? null : state.compare, loading: false, error: { message: error.message, code: error instanceof ApiError ? error.code : undefined } }))
      },
    )
  }, [projectId, mode, base, target])
  useEffect(() => { load(true) }, [load])
  useEffect(() => () => { generation.current++ }, [])
  useEffect(() => {
    if (!mode || !target) return
    const onFocus = () => { if (Date.now() - lastAt.current >= FOCUS_MIN_AGE) load(false) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [mode, target, load])
  const reload = useCallback(() => load(false), [load])
  return { ...read, reload }
}

/** Where another worktree stands (the ⋯ menu's first row), read when asked. */
export function useWorktreeStatus(projectId: string, target: string | null): { status: GitStatus | null; read: () => void } {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const generation = useRef(0)
  useEffect(() => { generation.current++; setStatus(null) }, [projectId, target])
  const read = useCallback(() => {
    if (!target) return
    const current = ++generation.current
    gitApi.status(projectId, { worktree: target }).then(next => { if (generation.current === current) setStatus(next) }, () => {})
  }, [projectId, target])
  return { status, read }
}
