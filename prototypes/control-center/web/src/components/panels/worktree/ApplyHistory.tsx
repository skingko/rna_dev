/**
 * 应用记录 (0.63, worktree design §3.6, §5, §12): every write Rna made into the project folder — a worktree
 * conversation's turn, a worker's merge, background work, a conflict settled, the panel's 放弃, a rollback — newest
 * first, each with its files, their patches (before → after) and a rollback: two steps (TwoStepConfirm), a
 * three-way one that leaves later changes that overlap alone. A rollback is itself a record, so it can be undone.
 * Records past retention say 已过期，不能回退. Opened from the panel's ⋯ menu, or on one record from a turn
 * footer's 查看 or a background change set.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ChevronRight, FileCode2, History, RotateCw, Undo2 } from 'lucide-react'
import { MAX_APPLY_PATCH_PATHS, worktreeApi, type ApplyDetail, type ApplyRecord, type RollbackResult } from '@/api/worktree-api'
import type { GitDiff } from '@/api/git-api'
import { useApp } from '@/store/app-store'
import { toast } from '@/store/ui-store'
import { refreshIsolation } from '@/store/isolation-store'
import { loadGitStatus } from '@/lib/workspace-changes'
import { applyKindText, applyStateText, applyTargetText, rollbackBlockedText } from '@/lib/isolation'
import { relativeTime } from '@/lib/format'
import { patchLines } from '@/lib/diff'
import { cn } from '@/lib/utils'
import { DiffView } from '@/components/diff/DiffView'
import { diffLanguage } from '@/components/diff/language'
import { DiffStat } from '@/components/timeline/ToolViews'
import { TwoStepConfirm } from '@/components/timeline/TwoStepConfirm'
import { Skeleton } from '@/components/ui/primitives'
import { useT } from '@/i18n'
import { splitPath } from './model'

const LIMIT = 100
const smallButton = 'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] disabled:opacity-40 [&_svg]:size-3'

export interface ApplyHistoryProps {
  projectId: string
  /** The conversation in front: its records can be shown alone. */
  sessionId?: string | null
  /** A record to open (and scroll to). */
  focus?: string | null
  onBack?: () => void
}

export function ApplyHistory({ projectId, sessionId = null, focus = null, onBack }: ApplyHistoryProps) {
  const t = useT()
  const [own, setOwn] = useState(Boolean(sessionId))
  const [rows, setRows] = useState<ApplyRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(focus)
  useEffect(() => { if (focus) setOpen(focus) }, [focus])
  const scope = own && sessionId ? sessionId : null
  const read = useCallback(() => {
    setError(null)
    return worktreeApi.applies(projectId, { sessionId: scope, limit: LIMIT }).then(({ applies }) => setRows(applies), (e: Error) => setError(e.message))
  }, [projectId, scope])
  useEffect(() => { setRows(null); void read() }, [read])
  // A record asked for from elsewhere (a background change set's files) may not be this conversation's: shown anyway.
  const widened = useRef<string | null>(null)
  useEffect(() => {
    if (!focus || !own || !rows || widened.current === focus || rows.some(row => row.id === focus)) return
    widened.current = focus
    setOwn(false)
  }, [focus, own, rows])
  const done = (result: unknown) => {
    const outcome = result as RollbackResult
    toast(outcome.skipped?.length ? t('已还原 {n} 个文件；{m} 个之后又改过，没有动。', { n: outcome.restored.length, m: outcome.skipped.length }) : t('已还原 {n} 个文件。', { n: outcome.restored?.length ?? 0 }), 'success')
    void read()
    refreshIsolation(projectId)
    void loadGitStatus(projectId)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-apply-history>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line-faint px-1.5 text-[12.5px]">
        {onBack && <button type="button" onClick={onBack} aria-label={t('返回改动')} className={smallButton}><ArrowLeft className="!size-3.5" /></button>}
        <History className="size-3.5 shrink-0 text-fg-4" aria-hidden />
        <span className="font-medium text-fg">{t('应用记录')}</span>
        <span className="flex-1" />
        {sessionId && (
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-fg-3">
            <input type="checkbox" checked={own} onChange={e => setOwn(e.target.checked)} className="size-3.5 accent-[var(--accent)]" />
            {t('只看这个对话')}
          </label>
        )}
        <button type="button" onClick={() => void read()} aria-label={t('刷新')} className={smallButton}><RotateCw className="!size-3.5" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-8 pt-1">
        {error && <p className="px-1.5 py-3 text-[12.5px] text-danger">{error}</p>}
        {!rows && !error && <div className="space-y-2 px-1.5 pt-2" aria-hidden>{[0, 1, 2].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>}
        {rows && !rows.length && <p className="mx-auto max-w-[300px] px-4 pt-[clamp(32px,10vh,80px)] text-center text-[12.5px] leading-[1.6] text-fg-3">{t('还没有写进项目文件夹的记录。Rna 每次把改动写进项目文件夹前都会先留一条记录，可以在这里回退。')}</p>}
        {rows?.map(row => (
          <RecordRow key={row.id} projectId={projectId} row={row} redo={row.kind === 'rollback' && Boolean(row.undoes && rows.some(other => other.id === row.undoes && other.kind === 'rollback'))}
            open={open === row.id} onToggle={() => setOpen(current => (current === row.id ? null : row.id))} onDone={done} focused={focus === row.id} />
        ))}
        {rows && rows.length >= LIMIT && <p className="px-1.5 pt-2 text-[12px] text-fg-4">{t('只列出最近的 {n} 条。', { n: LIMIT })}</p>}
      </div>
    </div>
  )
}

/**
 * One record. `redo`: it undid a rollback (撤销回退), so rolling it back rolls the original back again (再次回退); a
 * plain rollback's own rollback is 撤销回退; any other write's is 回退.
 */
function RecordRow({ projectId, row, redo, open, onToggle, onDone, focused }: { projectId: string; row: ApplyRecord; redo: boolean; open: boolean; onToggle: () => void; onDone: (result: unknown) => void; focused: boolean }) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (focused) ref.current?.scrollIntoView?.({ block: 'nearest' }) }, [focused])
  const title = useApp(s => (row.source?.sessionId ? s.sessionIndex[row.source.sessionId]?.title ?? null : null))
  const state = applyStateText(row.state)
  const undoing = row.kind === 'rollback' && !redo
  return (
    <div ref={ref} className={cn('mb-1 rounded-lg px-1.5 pb-1 shadow-[inset_0_0_0_1px_var(--line-faint)]', focused && 'shadow-[inset_0_0_0_1px_var(--line-focus)]')} data-apply={row.id} data-apply-state={row.state}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md text-left text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
        <ChevronRight className={cn('size-3 shrink-0 text-fg-4 transition-transform duration-200', open && 'rotate-90')} aria-hidden />
        <span className="shrink-0 font-medium text-fg-2">{redo ? t('撤销回退') : applyKindText(row.kind)}</span>
        <span className="min-w-0 flex-1 truncate text-fg-4" title={title ?? undefined}>{title ?? row.sample.slice(0, 3).join(', ')}</span>
        <span className="shrink-0 tabular-nums text-fg-4">{t('{count} 个文件', { count: row.files })} · {relativeTime(row.at)}</span>
      </button>
      <div className="flex flex-wrap items-center gap-x-2 pl-[18px] text-[12px] text-fg-4">
        {/* A write into a worktree (a conversation's sync, a merge back): kept for crash recovery, not the project folder. */}
        {applyTargetText(row.target) && <span data-apply-target>{applyTargetText(row.target)}</span>}
        {state && <span className={row.state === 'unverified' || row.state === 'interrupted' ? 'text-warning-text' : undefined}>{state}</span>}
        {row.bothChanged > 0 && <span>{t('{n} 个文件同时有你的改动', { n: row.bothChanged })}</span>}
        {(row.skipped?.length ?? 0) > 0 && <span title={row.skipped!.map(item => item.path).join('\n')}>{t('{n} 个文件没有写入', { n: row.skipped!.length })}</span>}
        <span className="flex-1" />
        {row.rollback.available ? (
          <TwoStepConfirm title={undoing ? t('撤销这次回退') : redo ? t('再次回退这些改动') : t('回退这次写入')} confirmLabel={undoing ? t('确认撤销') : t('确认回退')} danger={!undoing}
            preview={input => worktreeApi.previewRollback(projectId, row.id, input)}
            confirm={(plan, input) => worktreeApi.confirmRollback(projectId, row.id, plan.confirm, input)} onDone={onDone} className="w-full basis-full"
            trigger={(start, busy) => <button type="button" className={smallButton} disabled={busy} onClick={start} data-apply-rollback><Undo2 />{undoing ? t('撤销回退') : redo ? t('再次回退') : t('回退')}</button>} />
        ) : row.state !== 'rolled_back' && row.state !== 'expired' ? <span>{rollbackBlockedText(row.rollback.reason)}</span> : null}
      </div>
      {open && <RecordFiles projectId={projectId} applyId={row.id} />}
    </div>
  )
}

/** One record's files (before → after), each opening its patch. */
function RecordFiles({ projectId, applyId }: { projectId: string; applyId: string }) {
  const t = useT()
  const [detail, setDetail] = useState<ApplyDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState<string | null>(null)
  const [patches, setPatches] = useState<Record<string, GitDiff>>({})
  useEffect(() => {
    let live = true
    worktreeApi.apply(projectId, applyId).then(next => { if (live) setDetail(next) }, (e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [projectId, applyId])
  // The first files' patches come in one request when the record opens (as the git panel's batches).
  const first = useMemo(() => detail?.paths.slice(0, MAX_APPLY_PATCH_PATHS).map(file => file.path) ?? [], [detail])
  const show = (path: string) => {
    setShown(current => (current === path ? null : path))
    if (patches[path]) return
    const batch = first.includes(path) ? first.filter(p => !patches[p]) : [path]
    worktreeApi.applyPatches(projectId, applyId, batch).then(({ patches: rows }) => setPatches(current => ({ ...current, ...Object.fromEntries(rows.map(row => [row.path, row.diff])) })), (e: Error) => toast(e.message, 'danger'))
  }
  if (error) return <p className="px-1.5 py-2 text-[12px] text-danger">{error}</p>
  if (!detail) return <div className="px-1.5 py-2" aria-hidden><Skeleton className="h-6 w-full" /></div>
  return (
    <ul className="pb-1 pt-1" data-apply-files>
      {detail.paths.map(file => {
        const { name, dir } = splitPath(file.path)
        const diff = patches[file.path]
        return (
          <li key={file.path}>
            <button type="button" onClick={() => show(file.path)} aria-expanded={shown === file.path} title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-[12.5px] outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]" data-path={file.path}>
              <FileCode2 className="size-3.5 shrink-0 text-fg-4" strokeWidth={1.7} />
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
                <span className="min-w-0 max-w-full shrink-0 truncate text-fg">{name}</span>
                {dir && <span className="min-w-0 flex-1 truncate text-[12px] text-fg-4">{dir}</span>}
              </span>
              {file.binary || file.added === null ? <span className="shrink-0 text-[12px] text-fg-4">{t('二进制')}</span> : <DiffStat added={file.added} removed={file.removed ?? 0} created={file.status === 'A'} />}
            </button>
            {shown === file.path && (
              <div className="mx-1.5 mb-1.5 overflow-hidden rounded-lg bg-inset shadow-[inset_0_0_0_1px_var(--line-faint)]">
                {!diff ? <div className="p-2" aria-hidden><Skeleton className="h-4 w-2/3" /></div>
                  : diff.kind === 'patch' && diff.patch ? <DiffView lines={patchLines(diff.patch).lines} lineNumbers="new" language={diffLanguage(file.path)} />
                    : <p className="px-3 py-2 text-[12px] text-fg-4">{diff.kind === 'binary' ? t('二进制文件，不显示差异。') : diff.message ?? t('这个文件的差异暂时读不到。')}</p>}
              </div>
            )}
          </li>
        )
      })}
      {detail.truncated && <li className="px-1.5 pt-0.5 text-[12px] text-fg-4">{t('文件太多，只列出了一部分。')}</li>}
    </ul>
  )
}
