/**
 * 未提交的改动 grouped by stage (按暂存状态分组, worktree design §3.3): the
 * project folder's files by section (冲突 / 已暂存 / 未暂存 / 未跟踪). Files
 * are folded; one opens at a time and loads its diff then. The list is
 * virtualized (32 px rows, 14 rows of overscan, zcode GitPane), so a
 * repository with thousands of untracked files stays quick. Stage / unstage
 * act at once; discard asks a second time below the list and sends the
 * host's one-time confirmation only on that click (DiscardBar, also used by
 * the stacked diffs).
 */
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight, Minus, Plus, Undo2 } from 'lucide-react'
import { gitApi, type GitDiff, type GitDiscardPreview, type GitFile, type GitSection, type GitStatus } from '@/api/git-api'
import { patchLines } from '@/lib/diff'
import { loadGitStatus, setGitStatus } from '@/lib/workspace-changes'
import { toast } from '@/store/ui-store'
import { DiffView } from '@/components/diff/DiffView'
import { diffLanguage } from '@/components/diff/language'
import { Button, Skeleton, Tooltip } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { FileMenu } from './FileMenu'
import { gitRows, isLarge, SECTION_TITLE, sectionDiffSource, sectionFiles, splitPath, STATUS_LETTER, STATUS_TONE, STATUS_WORDS, type ListRow } from './model'

export const ROW_H = 32
const SECTION_H = 28
export const OVERSCAN = 14
/** Shown before "… 其余 N 行" in an opened file. */
const DIFF_PREVIEW_LINES = 400

/** A file's diff; `stale` once the status was read again (the open file reloads in place, showing the old patch meanwhile). */
type DiffState = { loading: boolean; diff?: GitDiff; error?: string; stale?: boolean }

export interface GitChangeListProps {
  projectId: string
  status: GitStatus
  workspace: string | undefined
  /** The project allows writing (stage, unstage, discard); the host checks again. */
  writable: boolean
  /** When the status was read: opened diffs are read again after a refresh. */
  readAt: number
  /** How diffs read (the panel's 自动换行 / 显示新旧两列行号). */
  wrap?: boolean
  numbers?: 'new' | 'both'
}

export function GitChangeList({ projectId, status, workspace, writable, readAt, wrap = true, numbers = 'new' }: GitChangeListProps) {
  const t = useT()
  const [folded, setFolded] = useState<ReadonlySet<GitSection>>(() => new Set())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({})
  const [busy, setBusy] = useState(false)
  const [discard, setDiscard] = useState<{ paths: string[]; preview: GitDiscardPreview } | null>(null)
  const generation = useRef(0)
  const scroller = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => gitRows(status, folded), [status, folded])

  // Another project drops everything; a fresh status keeps only the open file's diff, marked stale so it reloads in
  // place (no flash back to a skeleton on every window focus). A file that left the list closes.
  useEffect(() => { generation.current++; setDiffs({}); setExpanded(null); setDiscard(null) }, [projectId])
  const seenRead = useRef(readAt)
  useEffect(() => {
    if (seenRead.current === readAt) return
    seenRead.current = readAt
    generation.current++
    setDiffs(state => { const open = expanded ? state[expanded] : undefined; return open?.diff ? { [expanded!]: { ...open, loading: false, stale: true } } : {} })
  }, [readAt]) // eslint-disable-line react-hooks/exhaustive-deps -- only a fresh status drops diffs, not opening another file
  useEffect(() => { if (expanded && !rows.some(row => row.key === expanded)) setExpanded(null) }, [rows, expanded])

  const load = useCallback((row: Extract<ListRow, { kind: 'file' }>, force = false) => {
    if (row.file.path.endsWith('/') || (!force && isLarge(row.file))) return
    const current = generation.current
    setDiffs(state => ({ ...state, [row.key]: { loading: true, diff: state[row.key]?.diff } }))
    gitApi.diff(projectId, sectionDiffSource(row.section), row.file.path, row.section === 'staged' ? row.file.oldPath : undefined).then(
      diff => { if (generation.current === current) setDiffs(state => ({ ...state, [row.key]: { loading: false, diff } })) },
      (error: Error) => { if (generation.current === current) setDiffs(state => ({ ...state, [row.key]: { loading: false, error: error.message } })) },
    )
  }, [projectId])
  const openRow = expanded ? rows.find((row): row is Extract<ListRow, { kind: 'file' }> => row.kind === 'file' && row.key === expanded) : undefined
  // A large file's diff waits for 仍然显示; once shown, it reloads like any other.
  useEffect(() => {
    const state = openRow ? diffs[openRow.key] : undefined
    if (openRow && (!state || (state.stale && !state.loading))) load(openRow, Boolean(state))
  }, [openRow, diffs, load])
  const toggle = useCallback((key: string) => setExpanded(current => (current === key ? null : key)), [])
  const fold = useCallback((section: GitSection) => setFolded(current => { const next = new Set(current); if (!next.delete(section)) next.add(section); return next }), [])

  const virtual = useVirtualizer({
    count: rows.length, getScrollElement: () => scroller.current, overscan: OVERSCAN, getItemKey: index => rows[index].key,
    estimateSize: index => (rows[index].kind === 'section' ? SECTION_H : ROW_H), initialRect: { width: 320, height: 600 },
  })
  // An opened or closed file changes its row's height: the virtualizer watches each drawn row's size (clearing its
  // sizes here would put rows back to their guess until they change size again, and they would overlap).

  const write = useCallback(async (work: () => Promise<{ status: GitStatus }>, done?: string) => {
    setBusy(true)
    try { const result = await work(); setGitStatus(projectId, result.status); if (done) toast(done) }
    // Refused or failed (the files changed since they were listed, the project became read-only): show where things stand now.
    catch (error) { toast((error as Error).message, 'danger'); void loadGitStatus(projectId) }
    finally { setBusy(false) }
  }, [projectId])
  const stage = useCallback((files: GitFile[]) => void write(() => gitApi.stage(projectId, files.map(file => file.path))), [projectId, write])
  // A staged rename leaves the index as two paths: its new name and its old one.
  const unstage = useCallback((files: GitFile[]) => void write(() => gitApi.unstage(projectId, files.flatMap(file => (file.oldPath ? [file.path, file.oldPath] : [file.path])))), [projectId, write])
  const askDiscard = useCallback(async (files: GitFile[]) => {
    setBusy(true)
    try { const paths = files.map(file => file.path); setDiscard({ paths, preview: await gitApi.previewDiscard(projectId, paths) }) }
    catch (error) { toast((error as Error).message, 'danger'); void loadGitStatus(projectId) }
    finally { setBusy(false) }
  }, [projectId])
  const confirmDiscard = () => {
    if (!discard) return
    const { paths, preview } = discard
    setDiscard(null)
    void write(() => gitApi.confirmDiscard(projectId, paths, preview.confirm), t('已丢弃 {n} 个文件的改动。', { n: preview.files.length }))
  }
  // The host's confirmation lasts two minutes; the question goes away with it.
  useEffect(() => {
    if (!discard) return
    const timer = setTimeout(() => setDiscard(null), Math.max(0, Date.parse(discard.preview.expiresAt) - Date.now()))
    return () => clearTimeout(timer)
  }, [discard])

  const notes: ReactNode[] = []
  if (status.truncated) notes.push(t('改动太多，只列出了一部分。'))
  if (status.untrackedMode === 'normal' && status.files.untracked.length) notes.push(t('未跟踪的文件太多，按文件夹列出。'))
  if (status.untrackedMode === 'no') notes.push(t('这个仓库设置为不显示未跟踪的文件，新文件不会列在这里。'))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {notes.map((note, index) => <p key={index} className="shrink-0 border-b border-line-faint px-3 py-1.5 text-[12px] text-fg-4">{note}</p>)}
      {!rows.length ? <p className="px-4 pt-8 text-center text-[12.5px] text-fg-4" data-empty="grouped">{t('没有可显示的改动')}</p> : (
        <div ref={scroller} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden outline-none" data-git-list aria-busy={busy || undefined}>
          <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
            {virtual.getVirtualItems().map(item => {
              const row = rows[item.index]
              return (
                <div key={item.key} ref={virtual.measureElement} data-index={item.index} className="absolute left-0 w-full px-1.5" style={{ top: item.start }}>
                  {row.kind === 'section'
                    ? <SectionRow row={row} files={sectionFiles(status, row.section)} writable={writable} busy={busy} onFold={fold} onStage={stage} onUnstage={unstage} onDiscard={askDiscard} />
                    : <FileRow row={row} open={expanded === row.key} state={diffs[row.key]} projectId={projectId} workspace={workspace} writable={writable && row.section !== 'upstream'} busy={busy}
                      wrap={wrap} numbers={numbers} onToggle={toggle} onLoad={load} onStage={stage} onUnstage={unstage} onDiscard={askDiscard} />}
                </div>
              )
            })}
          </div>
        </div>
      )}
      {discard && <DiscardBar key={discard.preview.confirm} preview={discard.preview} busy={busy} fallback={scroller} onCancel={() => setDiscard(null)} onConfirm={confirmDiscard} />}
    </div>
  )
}

const actionButton = 'grid size-6 shrink-0 place-items-center rounded-md text-fg-3 outline-none transition-colors hover:bg-active hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] disabled:opacity-40'

function SectionRow({ row, files, writable, busy, onFold, onStage, onUnstage, onDiscard }: {
  row: Extract<ListRow, { kind: 'section' }>; files: GitFile[]; writable: boolean; busy: boolean
  onFold: (section: GitSection) => void; onStage: (files: GitFile[]) => void; onUnstage: (files: GitFile[]) => void; onDiscard: (files: GitFile[]) => void
}) {
  const t = useT()
  const canStage = writable && (row.section === 'unstaged' || row.section === 'untracked')
  return (
    <div className="group/s flex h-7 items-center gap-1 pl-0.5 pr-0.5" data-section={row.section}>
      <button type="button" onClick={() => onFold(row.section)} aria-expanded={!row.folded}
        className="flex min-w-0 items-center gap-1 rounded-md text-[12px] font-medium text-fg-3 outline-none transition-colors hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
        <ChevronRight className={cn('size-3 text-fg-4 transition-transform duration-200', !row.folded && 'rotate-90')} aria-hidden />
        <span className="truncate">{t(SECTION_TITLE[row.section])}</span>
        <span className="font-normal tabular-nums text-fg-4">{row.count}</span>
      </button>
      <span className="flex-1" />
      {canStage && (
        <>
          <Tooltip content={t('全部丢弃')}><button type="button" disabled={busy} onClick={() => onDiscard(files)} aria-label={t('丢弃这一组的全部改动')} className={actionButton}><Undo2 className="size-3.5" /></button></Tooltip>
          <Tooltip content={t('全部暂存')}><button type="button" disabled={busy} onClick={() => onStage(files)} aria-label={t('暂存这一组的全部文件')} className={actionButton}><Plus className="size-3.5" /></button></Tooltip>
        </>
      )}
      {writable && row.section === 'staged' && (
        <Tooltip content={t('全部取消暂存')}><button type="button" disabled={busy} onClick={() => onUnstage(files)} aria-label={t('取消暂存全部文件')} className={actionButton}><Minus className="size-3.5" /></button></Tooltip>
      )}
    </div>
  )
}

const FileRow = memo(function FileRow({ row, open, state, projectId, workspace, writable, busy, wrap, numbers, onToggle, onLoad, onStage, onUnstage, onDiscard }: {
  row: Extract<ListRow, { kind: 'file' }>; open: boolean; state: DiffState | undefined; projectId: string; workspace: string | undefined; writable: boolean; busy: boolean
  wrap: boolean; numbers: 'new' | 'both'
  onToggle: (key: string) => void; onLoad: (row: Extract<ListRow, { kind: 'file' }>, force?: boolean) => void
  onStage: (files: GitFile[]) => void; onUnstage: (files: GitFile[]) => void; onDiscard: (files: GitFile[]) => void
}) {
  const t = useT()
  const { file, section } = row
  const { name, dir } = splitPath(file.path)
  const large = isLarge(file) || state?.diff?.kind === 'truncated'
  const actions = writable && section !== 'conflicted'
  return (
    <div data-file={file.path} data-section={section}>
      <FileMenu path={file.path} workspace={workspace} projectId={projectId} deleted={file.status === 'D' && section !== 'upstream'}>
        <div className={cn('group/row flex h-8 items-center gap-1 rounded-md pr-1 transition-colors hover:bg-hover', open && 'bg-subtle')}>
          <button type="button" onClick={() => onToggle(row.key)} aria-expanded={open} title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
            className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md pl-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
            <ChevronRight className={cn('size-3 shrink-0 text-fg-4 transition-transform duration-200', open && 'rotate-90')} aria-hidden />
            <span className={cn('w-3.5 shrink-0 text-center font-mono text-[11.5px] font-semibold', STATUS_TONE[file.status])} aria-label={t(STATUS_WORDS[file.status])}>{STATUS_LETTER[file.status]}</span>
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
              <span className={cn('min-w-0 max-w-full shrink-0 truncate text-[13px] text-fg', file.status === 'D' && 'line-through decoration-fg-4')}>{name}</span>
              {dir && <span className="min-w-0 flex-1 truncate text-[12px] text-fg-4">{dir}</span>}
            </span>
            <span className={cn('shrink-0', actions && 'group-hover/row:hidden group-focus-within/row:hidden')}><FileStat file={file} large={large} /></span>
          </button>
          {actions && (
            <span className="hidden shrink-0 items-center group-hover/row:flex group-focus-within/row:flex">
              {(section === 'unstaged' || section === 'untracked') && (
                <>
                  <Tooltip content={t('丢弃改动')}><button type="button" disabled={busy} onClick={() => onDiscard([file])} aria-label={t('丢弃「{name}」的改动', { name })} className={actionButton}><Undo2 className="size-3.5" /></button></Tooltip>
                  <Tooltip content={t('暂存')}><button type="button" disabled={busy} onClick={() => onStage([file])} aria-label={t('暂存「{name}」', { name })} className={actionButton}><Plus className="size-3.5" /></button></Tooltip>
                </>
              )}
              {section === 'staged' && <Tooltip content={t('取消暂存')}><button type="button" disabled={busy} onClick={() => onUnstage([file])} aria-label={t('取消暂存「{name}」', { name })} className={actionButton}><Minus className="size-3.5" /></button></Tooltip>}
            </span>
          )}
        </div>
      </FileMenu>
      {open && <div className="pb-2 pl-5 pr-0.5 pt-0.5"><DiffBody row={row} state={state} projectId={projectId} wrap={wrap} numbers={numbers} onLoad={onLoad} /></div>}
    </div>
  )
})

function FileStat({ file, large }: { file: GitFile; large: boolean }) {
  const t = useT()
  if (file.binary) return <span className="text-[11.5px] text-fg-4">{t('二进制')}</span>
  if (large) return <span className="text-[11.5px] text-fg-4">{t('过大')}</span>
  if (file.added === null || file.removed === null) return file.status === '?' ? <span className="text-[11.5px] text-fg-4">{file.path.endsWith('/') ? t('文件夹') : t('新文件')}</span> : null
  // Only removals (a deleted file) read as −N alone; otherwise +N, then −N when there is any.
  return (
    <span className="font-mono text-[11.5px] tabular-nums">
      {(file.added > 0 || file.removed === 0) && <span className="text-[var(--diff-add-fg)]">+{file.added}</span>}
      {file.removed > 0 && <span className={cn('text-[var(--diff-del-fg)]', file.added > 0 && 'ml-1')}>−{file.removed}</span>}
    </span>
  )
}

function DiffBody({ row, state, projectId, wrap, numbers, onLoad }: { row: Extract<ListRow, { kind: 'file' }>; state: DiffState | undefined; projectId: string; wrap: boolean; numbers: 'new' | 'both'; onLoad: (row: Extract<ListRow, { kind: 'file' }>, force?: boolean) => void }) {
  const t = useT()
  const patch = state?.diff?.patch
  const parsed = useMemo(() => (patch ? patchLines(patch) : null), [patch])
  const note = (text: string) => <p className="rounded-lg bg-subtle px-3 py-2 text-[12.5px] leading-[1.55] text-fg-3">{text}</p>
  if (row.file.path.endsWith('/')) return note(t('这是一个未跟踪的文件夹，里面的文件没有一个个列出。'))
  if (!state) {
    if (!isLarge(row.file)) return null
    return (
      <div className="rounded-lg bg-subtle px-3 py-2 text-[12.5px] text-fg-3">
        {t('改动有 {n} 行，显示出来可能会慢。', { n: (row.file.added ?? 0) + (row.file.removed ?? 0) })}
        <button type="button" onClick={() => onLoad(row, true)} className="ml-2 rounded px-1 text-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{t('仍然显示')}</button>
      </div>
    )
  }
  if (state.loading && !state.diff) return <div className="space-y-1.5 py-1" aria-label={t('正在读取…')}><Skeleton className="h-3 w-4/5" /><Skeleton className="h-3 w-3/5" /><Skeleton className="h-3 w-2/3" /></div>
  if (state.error) return note(state.error)
  const diff = state.diff
  if (!diff) return null
  if (diff.kind === 'binary') return note(t('二进制文件，不显示差异。'))
  if (diff.kind === 'unavailable') return note(diff.message ?? t('这个文件的差异暂时读不到。'))
  if (!parsed?.lines.length) return note(t('没有可显示的文字改动（可能只改了文件权限）。'))
  return (
    <>
      {diff.kind === 'truncated' && <p className="mb-1.5 text-[12px] text-fg-4">{t('改动太大，只显示前一部分。')}</p>}
      <div className="overflow-hidden rounded-lg bg-inset shadow-[inset_0_0_0_1px_var(--line-faint)]">
        <DiffView lines={parsed.lines} lineNumbers={numbers} wrap={wrap} language={diffLanguage(row.file.path)} changeBar maxLines={DIFF_PREVIEW_LINES} capKey={`gitdiff:${projectId}:${row.key}`} />
      </div>
    </>
  )
}

/**
 * The second question of a discard. It takes the keyboard on its safe answer (取消), Esc cancels without the key
 * reaching the workspace, and the keyboard goes back where it was (else to the list) once it is answered.
 */
export function DiscardBar({ preview, busy, fallback, onCancel, onConfirm }: { preview: GitDiscardPreview; busy: boolean; fallback: RefObject<HTMLElement | null>; onCancel: () => void; onConfirm: () => void }) {
  const t = useT()
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancel.current?.focus({ preventScroll: true })
    return () => {
      const active = document.activeElement
      if (active && active !== document.body) return
      ;(before?.isConnected ? before : fallback.current)?.focus({ preventScroll: true })
    }
  }, [fallback])
  const id = useId()
  const restore = preview.files.filter(file => file.action === 'restore').length, remove = preview.files.length - restore
  const title = preview.files.length === 1 ? t('丢弃「{name}」的改动？', { name: splitPath(preview.files[0].path).name }) : t('丢弃 {n} 个文件的改动？', { n: preview.files.length })
  const detail = restore && remove ? t('{restore} 个文件会回到上次暂存或提交时的样子，{remove} 个新文件会被删除。', { restore, remove })
    : remove ? t('新文件会被删除。') : t('文件会回到上次暂存或提交时的样子。')
  // Repositories of their own inside the selection (nested repositories, submodules) are left as they are.
  const kept = preview.kept?.length ? t('{names} 是单独的 Git 仓库，不会被丢弃。', { names: preview.kept.map(row => `「${splitPath(row.path.replace(/\/$/, '')).name}」`).join('、') }) : ''
  return (
    <div role="alertdialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-detail`} data-discard-confirm
      onKeyDown={e => { if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); onCancel() } }}
      className="shrink-0 border-t border-line-faint bg-elevated px-3 py-2.5 shadow-[0_-6px_16px_-12px_rgb(0_0_0/0.25)]">
      <p id={`${id}-title`} className="text-[13px] font-medium text-fg">{title}</p>
      <p id={`${id}-detail`} className="mt-0.5 text-[12px] leading-[1.55] text-fg-3">{[detail, kept, t('这一步不能撤销。')].filter(Boolean).join(' ')}</p>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <Button ref={cancel} size="sm" variant="ghost" onClick={onCancel}>{t('取消')}</Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={onConfirm} data-confirm-discard>{t('确认丢弃')}</Button>
      </div>
    </div>
  )
}
