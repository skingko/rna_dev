/**
 * What background work delivered (plan §4.4), under its one-line message and in
 * the task's detail: the changed files with their line counts (the same look as
 * "本轮交付"), cards for new documents, and the one-click revert. Each file
 * opens 后台改动 in the side panel on its diff, rendered preview or source, so
 * whether to keep it can be judged from what actually changed.
 *
 * 0.63: a set background work made in its own worktree and applied (`kind:
 * 'git'`, `applyIds`) lists its files from its apply records when the host has
 * no before/after detail for it (every record: its clean part, then a card's
 * answer or a take; a file two wrote shows the newer), each opening 应用记录 on
 * its record; `deferred` and `merge_conflicted` sets say so
 * (BackgroundChangeRevert).
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { FileCode2 } from 'lucide-react'
import { worktreeApi, type ApplyFile } from '@/api/worktree-api'
import { useApp } from '@/store/app-store'
import { openDock } from '@/store/ui-store'
import { changedFiles, useBackgroundChange } from '@/store/change-detail-store'
import { openFilePreview } from '@/components/preview/open'
import { basename, dirname } from '@/lib/tools'
import { DiffStat } from './ToolViews'
import { DeliverableCard } from './Deliverables'
import { BackgroundChangeRevert } from './BackgroundChangeRevert'
import { openApplyHistory } from '@/components/panels/worktree/sheets'
import { t } from '@/i18n'

const DOC_EXT = /\.(md|mdx|txt|pdf|docx?|html?)$/i

export const BackgroundDeliverables = memo(function BackgroundDeliverables({ projectId, changeId, className }: { projectId: string; changeId: string; className?: string }) {
  const status = useApp(s => s.projects[projectId]?.backgroundChanges?.find(row => row.id === changeId)?.status ?? '')
  // The set's apply records, oldest first, as one string (a stable selector value).
  const applyIds = useApp(s => { const row = s.projects[projectId]?.backgroundChanges?.find(change => change.id === changeId); return row?.kind === 'git' && row.applyId && row.status !== 'deferred' && row.status !== 'merge_conflicted' ? [...new Set([...(row.applyIds ?? []), row.applyId])].join(' ') : '' })
  const entry = useBackgroundChange(projectId, changeId, status)
  const files = useMemo(() => changedFiles(entry?.detail), [entry?.detail])
  const review = (focus?: string) => openDock({ kind: 'change', projectId, changeId, focus })
  const created = files.filter(file => file.created && !file.deleted && file.available)
  if (!files.length && applyIds && entry?.status !== 'loading') return <AppliedFiles projectId={projectId} changeId={changeId} applyIds={applyIds} className={className} />
  if (!files.length) return entry?.status === 'loading' ? <div className={className ?? 'mt-3'}><div className="skeleton h-10 rounded-xl bg-muted" /></div> : <BackgroundChangeRevert projectId={projectId} changeId={changeId} />
  const added = files.reduce((n, f) => n + f.added, 0), removed = files.reduce((n, f) => n + f.removed, 0)
  return (
    <section className={className ?? 'mt-3'} aria-label={t('后台交付')}>
      <div className="overflow-hidden rounded-xl shadow-[inset_0_0_0_1px_var(--line)]">
        <div className="flex h-10 items-center gap-2 border-b border-line-faint px-3 text-[13px]">
          <span className="text-fg-2">{t('修改了 {count} 个文件', { count: files.length })}</span>
          <span className="font-mono text-[12px] tabular-nums">
            <span className="text-[var(--diff-add-fg)]">+{added}</span>
            <span className="ml-1 text-[var(--diff-del-fg)]">−{removed}</span>
          </span>
          <span className="flex-1" />
          <button type="button" onClick={() => review()} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg">{t('审阅全部')}</button>
        </div>
        <ul className="py-1">
          {files.map(file => (
            <li key={file.path}>
              <button type="button" onClick={() => review(file.path)} className="flex h-8 w-full items-center gap-2.5 px-3 text-left text-[13px] transition-colors hover:bg-hover">
                <FileCode2 className="size-3.5 shrink-0 text-fg-4" strokeWidth={1.7} />
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-fg">{basename(file.path)}</span>
                  {dirname(file.path) && <span className="ml-1.5 text-fg-4">{dirname(file.path)}</span>}
                </span>
                {file.binary ? <span className="text-[12px] text-fg-4">{t('二进制')}</span> : <DiffStat added={file.added} removed={file.removed} created={file.created} />}
              </button>
            </li>
          ))}
        </ul>
      </div>
      {created.length > 0 && (
        <div className="mt-2.5 grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2">
          {created.map(file => (
            <DeliverableCard key={file.path} kind={DOC_EXT.test(file.path) ? 'doc' : 'code'} title={basename(file.path)} subtitle={dirname(file.path) || t('项目根目录')} detail={file.path}
              // New documents open rendered; new code opens on what was written.
              onOpen={() => { if (DOC_EXT.test(file.path)) openFilePreview(projectId, file.path, () => review(file.path)); else review(file.path) }} />
          ))}
        </div>
      )}
      <BackgroundChangeRevert projectId={projectId} changeId={changeId} />
    </section>
  )
})

/** A git change set's files from its apply records (before → after line counts), each opening 应用记录 on its record. */
function AppliedFiles({ projectId, changeId, applyIds, className }: { projectId: string; changeId: string; applyIds: string; className?: string }) {
  const [detail, setDetail] = useState<{ paths: (ApplyFile & { applyId: string })[]; truncated: boolean } | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    setFailed(false)
    const ids = applyIds.split(' ').filter(Boolean)
    Promise.all(ids.map(id => worktreeApi.apply(projectId, id))).then(details => {
      if (!live) return
      // Each file once, from the newest record that wrote it.
      const byPath = new Map<string, ApplyFile & { applyId: string }>()
      details.forEach((one, i) => { for (const file of one.paths ?? []) { byPath.delete(file.path); byPath.set(file.path, { ...file, applyId: ids[i] }) } })
      setDetail({ paths: [...byPath.values()], truncated: details.some(one => one.truncated) })
    }, () => { if (live) setFailed(true) })
    return () => { live = false }
  }, [projectId, applyIds])
  if (failed || (detail && !detail.paths.length)) return <BackgroundChangeRevert projectId={projectId} changeId={changeId} />
  if (!detail) return <div className={className ?? 'mt-3'}><div className="skeleton h-10 rounded-xl bg-muted" /></div>
  const newest = applyIds.split(' ').filter(Boolean).at(-1)
  const review = (applyId = newest) => openApplyHistory(projectId, { focus: applyId })
  const added = detail.paths.reduce((n, f) => n + (f.added ?? 0), 0), removed = detail.paths.reduce((n, f) => n + (f.removed ?? 0), 0)
  return (
    <section className={className ?? 'mt-3'} aria-label={t('后台交付')} data-applied-files={applyIds}>
      <div className="overflow-hidden rounded-xl shadow-[inset_0_0_0_1px_var(--line)]">
        <div className="flex h-10 items-center gap-2 border-b border-line-faint px-3 text-[13px]">
          <span className="text-fg-2">{t('修改了 {count} 个文件', { count: detail.paths.length })}</span>
          <span className="font-mono text-[12px] tabular-nums">
            <span className="text-[var(--diff-add-fg)]">+{added}</span>
            <span className="ml-1 text-[var(--diff-del-fg)]">−{removed}</span>
          </span>
          <span className="flex-1" />
          <button type="button" onClick={() => review()} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg">{t('审阅全部')}</button>
        </div>
        <ul className="py-1">
          {detail.paths.map(file => (
            <li key={file.path}>
              <button type="button" onClick={() => review(file.applyId)} className="flex h-8 w-full items-center gap-2.5 px-3 text-left text-[13px] transition-colors hover:bg-hover">
                <FileCode2 className="size-3.5 shrink-0 text-fg-4" strokeWidth={1.7} />
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-fg">{basename(file.path)}</span>
                  {dirname(file.path) && <span className="ml-1.5 text-fg-4">{dirname(file.path)}</span>}
                </span>
                {file.binary || file.added === null ? <span className="text-[12px] text-fg-4">{t('二进制')}</span> : <DiffStat added={file.added} removed={file.removed ?? 0} created={file.status === 'A'} />}
              </button>
            </li>
          ))}
        </ul>
      </div>
      {detail.truncated && <p className="mt-1 text-[12px] text-fg-4">{t('文件太多，只列出了一部分。')}</p>}
      <BackgroundChangeRevert projectId={projectId} changeId={changeId} />
    </section>
  )
}
