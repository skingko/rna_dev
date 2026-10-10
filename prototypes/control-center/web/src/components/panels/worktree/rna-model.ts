/**
 * 本次对话的改动, the listing (Rna's own records, with or without git): the conversation's file changes turn by turn
 * and background work's change sets run by run, newest first, each a group of files for the tree and the stacked
 * diffs. A turn's files come from its finished edit and write calls (old and new text are in their arguments; a
 * whole-file write over text that was not recorded is 已覆盖, without counts); a change set's files come from the
 * change-review API (its own before and after) or, for a set made in a background worktree, from its apply records
 * (every one of `applyIds`: files with numstat, patches read when shown; a file two records wrote shows the newer
 * one's). Until a set's files are read, the summary's paths stand in.
 */
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { BackgroundChange, BackgroundChangeFile, Item, ProjectWork } from '@/api/types'
import { worktreeApi, type ApplyDetail, type ApplyFile } from '@/api/worktree-api'
import { useApp } from '@/store/app-store'
import { useWholeHistory } from '@/store/use-whole-history'
import { loadChangeDetail, useChangeDetail } from '@/store/change-detail-store'
import { toWorkspacePath } from '@/components/preview/registry'
import { useSessionRoots } from '@/lib/session-root'
import { computeDiff, snippetDiff } from '@/lib/diff'
import { fileChange, toolUnfinished } from '@/lib/tools'
import { t } from '@/i18n'
import { groupedTree, groupFileKey, type StackFile, type StackGroup, type TreeModel } from './compare-model'
import type { RnaDiffInput } from './rna-diffs'

/** Tool calls listed under 最近的工具调用. */
export const RECENT_TOOLS = 30

interface GroupBase extends StackGroup {
  /** The turn's request (first 80 characters) or the run's title, when known. */
  title: string | null
  at: string | null
}
export interface RnaTurnGroup extends GroupBase {
  kind: 'turn'
  turnId: string
  /** The conversation's latest turn (本轮). */
  latest: boolean
  /** Every call that changed a file in the turn (审阅). */
  itemIds: string[]
}
export interface RnaChangeGroup extends GroupBase {
  kind: 'change'
  change: BackgroundChange
  /** Files of the set not listed (the summary names at most 8 until the set's files are read). */
  more: number
}
export type RnaGroup = RnaTurnGroup | RnaChangeGroup

/**
 * A change set's files as read: its own snapshots, its apply records' files (oldest first: a set made in a background
 * worktree may be applied by more than one record — its clean part, then a card's answer or a take), still being
 * read, or not readable.
 */
export type SetDetail =
  | { kind: 'snapshot'; files: BackgroundChangeFile[] }
  | { kind: 'apply'; records: { applyId: string; files: ApplyFile[]; truncated: boolean }[] }
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }

export interface RnaListing {
  groups: RnaGroup[]
  /** Every file in the tree's order: the order the diffs stack in. */
  files: StackFile[]
  /** Where each file's diff is read from, by file key. */
  inputs: Map<string, RnaDiffInput>
  tree: TreeModel
  /** The conversation's latest tool calls, newest first (最近的工具调用). */
  recent: Item[]
}

export interface RnaListingInput {
  /** The conversation's tool calls in order (none without a conversation of this project). */
  tools: readonly Item[]
  latestTurnId: string | null
  turnInfo: (turnId: string) => { title: string | null; at: string | null }
  sets: readonly BackgroundChange[]
  details: Readonly<Record<string, SetDetail | undefined>>
  /** A path as the project folder names it (relative), or null outside the conversation's folders. */
  local: (path: string) => string | null
  runTitle: (actionId: string) => string | null
}

const time = (at: string | null) => (at ? Date.parse(at) || 0 : 0)

/** The conversation's changed files of one turn, each once (by its path in the project), with its edits in order. */
function turnFiles(group: string, list: readonly Item[], local: RnaListingInput['local'], inputs: Map<string, RnaDiffInput>): StackFile[] {
  const rows = new Map<string, { path: string; external: boolean; added: number; removed: number; created: boolean; replaced: boolean; parts: ({ oldText: string; newText: string } | null)[] }>()
  for (const item of list) {
    const change = fileChange(item)
    if (!change?.path) continue
    const shown = local(change.path)
    const path = shown ?? change.path
    let row = rows.get(path)
    if (!row) rows.set(path, row = { path, external: shown === null, added: 0, removed: 0, created: false, replaced: false, parts: [] })
    if (!change.replaced) {
      const diff = snippetDiff(change.oldText, change.newText)
      row.added += diff.added; row.removed += diff.removed
    }
    row.created ||= change.created
    row.replaced ||= change.replaced
    row.parts.push(change.replaced ? null : { oldText: change.oldText, newText: change.newText })
  }
  return [...rows.values()].map(row => {
    const key = groupFileKey(group, row.path)
    // Written over without its earlier text (and not made in this run): no counts to show.
    const overwritten = row.replaced && !row.created
    inputs.set(key, { kind: 'edits', parts: row.parts })
    return {
      key, group, path: row.path, status: row.created ? 'A' as const : 'M' as const,
      added: overwritten ? null : row.added, removed: overwritten ? null : row.removed,
      ...(overwritten ? { overwritten: true } : {}), ...(row.external ? { external: true } : {}),
    }
  })
}

/** A change set's files: as read (snapshots or the apply record's), else the summary's paths while they are read. */
function setFiles(group: string, set: BackgroundChange, detail: SetDetail | undefined, local: RnaListingInput['local'], inputs: Map<string, RnaDiffInput>): { files: StackFile[]; more: number } {
  const place = (path: string) => local(path) ?? path
  if (detail?.kind === 'snapshot' && detail.files.length) {
    const files = detail.files.map((file): StackFile => {
      const path = place(file.path), key = groupFileKey(group, path)
      const counted = file.available && !file.binary ? computeDiff(file.before ?? '', file.after ?? '') : null
      inputs.set(key, file.available
        ? { kind: 'snapshot', before: file.before ?? '', after: file.after ?? '', binary: file.binary, truncated: file.truncated, changedSince: file.changedSince }
        : { kind: 'note', message: t('这组改动已回退或快照已过期，只能看到文件列表。') })
      return { key, group, path, status: file.created ? 'A' : file.deleted ? 'D' : 'M', added: counted?.added ?? null, removed: counted?.removed ?? null, ...(file.binary ? { binary: true } : {}) }
    })
    return { files, more: 0 }
  }
  if (detail?.kind === 'apply' && detail.records.some(record => record.files.length)) {
    // Each file once, from the newest record that wrote it (records are oldest first).
    const byPath = new Map<string, StackFile>()
    for (const record of detail.records) {
      for (const file of record.files) {
        const path = place(file.path), key = groupFileKey(group, path)
        inputs.set(key, { kind: 'apply', applyId: record.applyId, path: file.path })
        byPath.delete(path)
        byPath.set(path, { key, group, path, ...(file.oldPath ? { oldPath: place(file.oldPath) } : {}), status: file.status, added: file.added, removed: file.removed, ...(file.binary ? { binary: true } : {}) })
      }
    }
    const files = [...byPath.values()]
    return { files, more: detail.records.some(record => record.truncated) ? Math.max(0, set.count - files.length) : 0 }
  }
  // Not read (yet): the summary's paths, each waiting for the set's files or saying why they cannot be shown.
  const waiting: RnaDiffInput = detail?.kind === 'failed' ? { kind: 'note', message: detail.message }
    : set.kind === 'git' && !setApplyIds(set).length ? { kind: 'note', message: t('这组改动还没有应用到项目文件夹。') }
      : detail?.kind === 'snapshot' || detail?.kind === 'apply' ? { kind: 'note', message: t('这组改动暂时读不到。') }
        : { kind: 'loading' }
  const files = set.paths.map((raw): StackFile => {
    const path = place(raw), key = groupFileKey(group, path)
    inputs.set(key, waiting)
    return { key, group, path, status: 'M', added: null, removed: null }
  })
  return { files, more: Math.max(0, set.count - files.length) }
}

/**
 * The listing: turn groups (their changed files) and change-set groups, newest first by when the turn started or the
 * set was recorded. A turn without file changes, or a set without files, is left out.
 */
export function buildRnaListing({ tools, latestTurnId, turnInfo, sets, details, local, runTitle }: RnaListingInput): RnaListing {
  const inputs = new Map<string, RnaDiffInput>()
  const byTurn = new Map<string, Item[]>()
  for (const item of tools) {
    if (!item.tool || toolUnfinished(item.tool) || !fileChange(item)?.path) continue
    const turnId = item.turnId ?? ''
    let list = byTurn.get(turnId)
    if (!list) byTurn.set(turnId, list = [])
    list.push(item)
  }
  const groups: RnaGroup[] = []
  // Newest turn first (the conversation's order), then the sets newest first; then all of them by time.
  for (const [turnId, list] of [...byTurn].reverse()) {
    const key = `turn:${turnId}`
    const files = turnFiles(key, list, local, inputs)
    if (!files.length) continue
    const info = turnInfo(turnId)
    const latest = Boolean(turnId) && turnId === latestTurnId
    groups.push({
      kind: 'turn', key, turnId, title: info.title, at: info.at ?? list[0].createdAt ?? null, latest, itemIds: list.map(item => item.id), files,
      label: info.title ?? t('一轮对话'), tag: latest ? t('本轮') : null,
    })
  }
  for (const set of [...sets].sort((a, b) => time(b.at) - time(a.at))) {
    const key = `change:${set.id}`
    const { files, more } = setFiles(key, set, details[set.id], local, inputs)
    if (!files.length) continue
    const title = runTitle(set.actionId)
    groups.push({ kind: 'change', key, change: set, title, at: set.at, more, files, label: title ?? t('后台改动'), muted: set.status === 'reverted' })
  }
  // A stable sort: a tie (or a turn whose time is not known) keeps the order found.
  groups.sort((a, b) => time(b.at) - time(a.at))
  const tree = groupedTree(groups)
  return { groups, files: tree.order, inputs, tree, recent: tools.slice(-RECENT_TOOLS).reverse() }
}

/* ------------------------------------------------------------------ reading a set's files */

type ApplyRow = { status: 'loading' | 'ready' | 'error'; detail?: ApplyDetail; error?: string }
/** A git set's apply records, oldest first (`applyIds`; a summary from an older host names only `applyId`). */
export const setApplyIds = (set: Pick<BackgroundChange, 'applyId' | 'applyIds'>): string[] => [...new Set([...(set.applyIds ?? []), ...(set.applyId ? [set.applyId] : [])])]
/** A background-worktree set's apply record (files and numstat), read once per record. */
const useApplyFiles = create<{ rows: Record<string, ApplyRow> }>(() => ({ rows: {} }))

function loadApplyFiles(projectId: string, applyId: string) {
  const row = useApplyFiles.getState().rows[applyId]
  if (row && row.status !== 'error') return
  useApplyFiles.setState(s => ({ rows: { ...s.rows, [applyId]: { status: 'loading' } } }))
  worktreeApi.apply(projectId, applyId).then(
    detail => useApplyFiles.setState(s => ({ rows: { ...s.rows, [applyId]: { status: 'ready', detail } } })),
    (error: Error) => useApplyFiles.setState(s => ({ rows: { ...s.rows, [applyId]: { status: 'error', error: error.message } } })),
  )
}
/** Test helper. */
export function resetApplyFiles() { useApplyFiles.setState({ rows: {} }) }

/** Read the sets' files (again where a read failed): a set's own snapshots, or its apply record's files. */
export function readSetFiles(projectId: string, sets: readonly BackgroundChange[]) {
  for (const set of sets) {
    if (set.kind === 'git') { for (const applyId of setApplyIds(set)) loadApplyFiles(projectId, applyId) }
    else loadChangeDetail(projectId, set.id, set.status)
  }
}

const NONE: Record<string, never> = {}
const NO_ITEMS: Item[] = []
const NO_CHANGES: BackgroundChange[] = []

/** Each set's files as read so far (read when the sets change; `version` of a snapshot set is its status, as 审阅 reads it). */
export function useSetDetails(projectId: string, sets: readonly BackgroundChange[], enabled: boolean): Record<string, SetDetail | undefined> {
  const wanted = enabled ? sets : NO_CHANGES
  const signature = wanted.map(set => `${set.id}:${set.status}:${setApplyIds(set).join(',')}`).join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `signature` names the sets and their states
  useEffect(() => { readSetFiles(projectId, wanted) }, [projectId, signature])
  const snapshots = useChangeDetail(useShallow(s => (wanted.length ? Object.fromEntries(wanted.filter(set => set.kind !== 'git').map(set => [set.id, s.rows[set.id]])) : NONE)))
  const applies = useApplyFiles(useShallow(s => (wanted.length ? Object.fromEntries(wanted.flatMap(set => (set.kind === 'git' ? setApplyIds(set).map(id => [id, s.rows[id]]) : []))) : NONE)))
  return useMemo(() => {
    const out: Record<string, SetDetail | undefined> = {}
    for (const set of wanted) {
      if (set.kind === 'git') {
        const ids = setApplyIds(set), rows = ids.map(id => applies[id])
        const failed = rows.find(row => row?.status === 'error')
        out[set.id] = !ids.length ? undefined
          : failed ? { kind: 'failed', message: failed.error ?? t('这组改动暂时读不到。') }
            : rows.every(row => row?.detail) ? { kind: 'apply', records: ids.map((applyId, i) => ({ applyId, files: rows[i]!.detail!.paths ?? [], truncated: Boolean(rows[i]!.detail!.truncated) })) }
              : rows.some(Boolean) ? { kind: 'loading' } : undefined
        continue
      }
      const row = snapshots[set.id]
      out[set.id] = row?.detail ? { kind: 'snapshot', files: row.detail.files ?? [] }
        : row?.status === 'error' ? { kind: 'failed', message: row.error ?? t('这组改动暂时读不到。') } : row ? { kind: 'loading' } : undefined
    }
    return out
  }, [wanted, snapshots, applies]) // eslint-disable-line react-hooks/exhaustive-deps -- `wanted` follows `sets`
}

/* ------------------------------------------------------------------ the hook */

/** The title background work gave the run behind a change set, when the summary still lists it. */
const runTitleIn = (work: ProjectWork | null | undefined, actionId: string) => [...(work?.running ?? []), ...(work?.recent ?? [])].find(run => run.id === actionId)?.title ?? null

/**
 * 本次对话的改动 for a project and its selected conversation (null: background work only). `enabled` false (another
 * view shows): nothing is read and the listing is empty.
 */
export function useRnaListing(projectId: string, sessionId: string | null, workspace: string | undefined, enabled: boolean): RnaListing {
  const own = enabled ? sessionId : null
  // Every edit of the conversation: older turns than the timeline's window are paged in (B9).
  useWholeHistory(own)
  const tools = useApp(useShallow(s => {
    const slice = own ? s.sessions[own] : undefined
    return slice ? slice.order.map(id => slice.items[id]).filter((item): item is Item => Boolean(item?.tool)) : NO_ITEMS
  }))
  const turns = useApp(s => (own ? s.sessions[own]?.turns : undefined))
  // The conversation's latest turn: the one its last entry belongs to.
  const latestTurnId = useApp(s => { const slice = own ? s.sessions[own] : undefined, last = slice?.order.at(-1); return (last && slice?.items[last]?.turnId) || null })
  const sets = useApp(s => (enabled ? s.projects[projectId]?.backgroundChanges ?? NO_CHANGES : NO_CHANGES))
  // The runs' titles only (background work's summary changes with every step it takes).
  const titles = useApp(useShallow(s => sets.map(set => runTitleIn(s.projects[projectId]?.work, set.actionId))))
  const details = useSetDetails(projectId, sets, enabled)
  // 0.63: a worktree conversation's edits are under its own copy first, then the project folder.
  const sessionRoots = useSessionRoots(own)
  const roots = useMemo(() => (own && sessionRoots.length ? sessionRoots : workspace ? [workspace] : []), [own, sessionRoots, workspace])
  return useMemo(() => buildRnaListing({
    tools, latestTurnId, sets, details, runTitle: actionId => titles[sets.findIndex(set => set.actionId === actionId)] ?? null,
    local: path => toWorkspacePath(path, roots),
    turnInfo: turnId => {
      const turn = turns?.[turnId]
      const user = turn?.userItemId && own ? useApp.getState().sessions[own]?.items[turn.userItemId] : undefined
      return { title: user?.text?.replace(/\s+/g, ' ').trim().slice(0, 80) || null, at: turn?.createdAt ?? null }
    },
  }), [tools, latestTurnId, sets, details, titles, roots, turns, own])
}
