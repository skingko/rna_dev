/**
 * Background change sets as the work left them (plan §4.4), fetched when a
 * message or task that points at one is shown, and reused by its review tab.
 * `version` is the set's status, so a revert reloads it.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import type { BackgroundChangeDetail } from '@/api/types'
import { projectApi } from '@/api/project-api'
import { computeDiff } from '@/lib/diff'

type Entry = { version: string; status: 'loading' | 'ready' | 'error'; detail?: BackgroundChangeDetail; error?: string }
export const useChangeDetail = create<{ rows: Record<string, Entry> }>(() => ({ rows: {} }))

export function loadChangeDetail(projectId: string, changeId: string, version = '') {
  const row = useChangeDetail.getState().rows[changeId]
  if (row && row.version === version && row.status !== 'error') return
  useChangeDetail.setState(s => ({ rows: { ...s.rows, [changeId]: { version, status: 'loading', detail: row?.detail } } }))
  projectApi.backgroundChange(projectId, changeId).then(
    detail => useChangeDetail.setState(s => ({ rows: { ...s.rows, [changeId]: { version, status: 'ready', detail } } })),
    (error: Error) => useChangeDetail.setState(s => ({ rows: { ...s.rows, [changeId]: { version, status: 'error', detail: row?.detail, error: error.message } } })),
  )
}

export function useBackgroundChange(projectId: string | null, changeId: string, version = ''): Entry | undefined {
  useEffect(() => { if (projectId) loadChangeDetail(projectId, changeId, version) }, [projectId, changeId, version])
  return useChangeDetail(s => s.rows[changeId])
}

export interface ChangedFile { path: string; added: number; removed: number; created: boolean; deleted: boolean; binary: boolean; available: boolean; changedSince: boolean; truncated: boolean }

/** Per-file line counts of a change set (the same diff the review shows). */
export function changedFiles(detail: BackgroundChangeDetail | undefined): ChangedFile[] {
  return (detail?.files ?? []).map(file => {
    const diff = file.available && !file.binary ? computeDiff(file.before ?? '', file.after ?? '') : null
    return { path: file.path, added: diff?.added ?? 0, removed: diff?.removed ?? 0, created: file.created, deleted: file.deleted, binary: file.binary, available: file.available, changedSince: file.changedSince, truncated: file.truncated }
  })
}
