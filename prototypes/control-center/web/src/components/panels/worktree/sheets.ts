/**
 * The 工作区改动 panel's two extra pages (0.63, worktree design §12): Rna 工作树 (RnaWorktrees) and 应用记录
 * (ApplyHistory), reached from its ⋯ menu — or from elsewhere: a turn footer's 查看 opens 应用记录 on that turn's
 * records, a subagent card's 查看改动 opens the worker's worktree. A request names the project; the panel showing
 * that project takes it once.
 */
import { create } from 'zustand'
import { openWorktree } from '@/components/workspace/worktree-open'
import { findTab, updateTab } from '@/store/side-panel-store'

export type PanelSheet = 'worktrees' | 'applies'
export interface SheetRequest { sheet: PanelSheet | null; focus?: string | null; sessionId?: string | null; nonce: number }

export const usePanelSheets = create<{ requests: Record<string, SheetRequest> }>(() => ({ requests: {} }))
let nonce = 0

/** Ask the panel showing `projectId` for a page (null: back to the comparison). */
export function requestSheet(projectId: string, sheet: PanelSheet | null, extra: { focus?: string | null; sessionId?: string | null } = {}) {
  usePanelSheets.setState(s => ({ requests: { ...s.requests, [projectId]: { sheet, ...extra, nonce: ++nonce } } }))
}
/** The panel took the request. */
export function takeSheet(projectId: string, request: SheetRequest) {
  usePanelSheets.setState(s => (s.requests[projectId]?.nonce === request.nonce ? { requests: Object.fromEntries(Object.entries(s.requests).filter(([key]) => key !== projectId)) } : {}))
}

/** 应用记录 in the 工作区改动 panel, on `focus` (an apply record) and, when given, one conversation's records. */
export function openApplyHistory(projectId: string, { focus, sessionId }: { focus?: string | null; sessionId?: string | null } = {}) {
  openWorktree(projectId)
  requestSheet(projectId, 'applies', { focus, sessionId })
}

/** The 工作区改动 panel on another worktree (a worker's or a conversation's), read-only, comparing what is not committed. */
export function openWorktreeAt(projectId: string, path: string) {
  const id = openWorktree(projectId)
  requestSheet(projectId, null)
  if (findTab(id)) updateTab(id, { target: path, mode: 'uncommitted', grouped: false, source: null })
}
