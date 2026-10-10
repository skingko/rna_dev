/**
 * Rna 工作树 (0.63, worktree design §5.3, §12): the worktrees Rna made in this project — a conversation's, a
 * worker's, background work's, and ones found without a record — with whose they are, their state, age, size and
 * how many files have not reached the project folder. Each can be looked at in the 工作区改动 panel (read-only);
 * a kept, conflicted or unrecorded one can be applied (only what merges cleanly; a checkpoint first) or discarded,
 * both in two steps. Also whether isolation can be used here, and why not. The panel's ⋯ menu opens it; the
 * project settings show the kept ones.
 */
import { useEffect } from 'react'
import { ArrowLeft, Bot, Clock3, GitFork, MessageSquareText, RotateCw, ShieldCheck, ShieldOff, Trash2, Upload } from 'lucide-react'
import { worktreeApi, type RnaWorktree, type WorktreeActionResult } from '@/api/worktree-api'
import { useApp } from '@/store/app-store'
import { toast } from '@/store/ui-store'
import { loadWorktrees, refreshIsolation, useWorktrees } from '@/store/isolation-store'
import { loadGitStatus } from '@/lib/workspace-changes'
import { isolationReasonText, settleable, worktreeKindText, worktreeStateText } from '@/lib/isolation'
import { relativeTime } from '@/lib/format'
import { formatBytes } from '@/components/preview/registry'
import { TwoStepConfirm } from '@/components/timeline/TwoStepConfirm'
import { Skeleton } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'

const smallButton = 'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] disabled:opacity-40 [&_svg]:size-3'
const KIND_ICON = { session: MessageSquareText, worker: Bot, background: Clock3, orphan: GitFork } as Record<string, typeof GitFork>

export interface RnaWorktreesProps {
  projectId: string
  /** `kept`: only the ones waiting on the user (kept, conflicted, unrecorded, missing) — the project settings' list. */
  filter?: 'all' | 'kept'
  /** Show this worktree in the 工作区改动 panel (absent: no 查看). */
  onView?: (path: string) => void
  onBack?: () => void
  className?: string
}

export function RnaWorktrees({ projectId, filter = 'all', onView, onBack, className }: RnaWorktreesProps) {
  const t = useT()
  const entry = useWorktrees(projectId)
  // Read again when shown (sizes are measured in the background, states move between visits).
  useEffect(() => { void loadWorktrees(projectId, { minAgeMs: 2000 }) }, [projectId])
  const isolation = entry.data?.isolation
  const rows = (entry.data?.worktrees ?? []).filter(row => row.state !== 'removed' && (filter === 'all' || settleable(row) || row.state === 'missing'))
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)} data-rna-worktrees={filter}>
      {filter === 'all' && (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line-faint px-1.5 text-[12.5px]">
          {onBack && <button type="button" onClick={onBack} aria-label={t('返回改动')} className={smallButton}><ArrowLeft className="!size-3.5" /></button>}
          <GitFork className="size-3.5 shrink-0 text-fg-4" aria-hidden />
          <span className="font-medium text-fg">{t('Rna 工作树')}</span>
          <span className="flex-1" />
          <button type="button" onClick={() => void loadWorktrees(projectId)} aria-label={t('刷新')} className={smallButton}><RotateCw className={cn('!size-3.5', entry.loading && 'animate-spin')} /></button>
        </div>
      )}
      <div className={cn('min-h-0 flex-1', filter === 'all' && 'overflow-y-auto px-1.5 pb-8 pt-1')}>
        {entry.unsupported ? <p className="px-1.5 py-3 text-[12.5px] text-fg-3">{t('当前的 Rna 服务暂不支持工作树隔离。')}</p>
          : entry.error && !entry.data ? <p className="px-1.5 py-3 text-[12.5px] text-danger">{entry.error}</p>
            : !entry.data ? <div className="space-y-2 px-1.5 pt-2" aria-hidden>{[0, 1].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
              : (
                <>
                  {isolation && (
                    <p className={cn('flex items-start gap-1.5 px-1.5 py-1.5 text-[12px] leading-[1.55]', isolation.enabled ? 'text-fg-3' : 'text-fg-4')} data-isolation={isolation.enabled ? 'on' : isolation.reason ?? 'off'}>
                      {isolation.enabled ? <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" /> : <ShieldOff className="mt-0.5 size-3.5 shrink-0" />}
                      <span>{isolation.enabled ? t('可以使用工作树隔离：对话、子代理和后台工作在自己的副本里改文件，再合并回项目文件夹。') : t('工作树隔离没有开启：{reason}。', { reason: isolationReasonText(isolation.reason) })}</span>
                    </p>
                  )}
                  {!rows.length && <p className="px-1.5 py-2 text-[12.5px] text-fg-4">{filter === 'kept' ? t('没有保留的工作树。') : t('还没有 Rna 工作树。')}</p>}
                  {rows.map(row => <WorktreeRow key={row.id} projectId={projectId} row={row} onView={onView} />)}
                  <p className="px-1.5 pt-2 text-[12px] leading-[1.55] text-fg-4">{t('工作树放在项目文件夹的 .rna/worktrees.nosync 里，iCloud 不会同步。如果项目的开发工具（如 jest、vitest、tsc）扫描到了它们，在这些工具的排除项里加上 .rna。')}</p>
                </>
              )}
      </div>
    </div>
  )
}

function WorktreeRow({ projectId, row, onView }: { projectId: string; row: RnaWorktree; onView?: (path: string) => void }) {
  const t = useT()
  const owner = useApp(s => (row.owner?.sessionId ? s.sessionIndex[row.owner.sessionId]?.title ?? null : null))
  const Icon = KIND_ICON[row.kind] ?? GitFork
  // The host's sentence about secret files left out or moved to the trash (B8) follows the outcome.
  const settled = (message: string, result?: unknown) => {
    const note = (result as WorktreeActionResult | undefined)?.note
    toast(!note ? message : /[。！？]$/.test(message) ? `${message}${note}` : `${message} ${note}`, 'success'); refreshIsolation(projectId); void loadGitStatus(projectId)
  }
  // The host names no folder when it cannot find the project's repository any more: nothing to look at then.
  const path = row.path
  const who = owner ?? (row.owner?.agentId ? t('子代理 {id}', { id: row.owner.agentId.slice(0, 8) }) : row.owner?.actionId ? t('后台工作 {id}', { id: row.owner.actionId.slice(0, 8) }) : path?.split('/').pop() || row.id)
  return (
    <div className="mb-1 rounded-lg px-1.5 py-1 shadow-[inset_0_0_0_1px_var(--line-faint)]" data-worktree-row={row.id} data-worktree-state={row.state}>
      <div className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
        <Icon className="size-3.5 shrink-0 text-fg-4" aria-hidden />
        <span className="shrink-0 font-medium text-fg-2">{worktreeKindText(row.kind)}</span>
        <span className="min-w-0 flex-1 truncate text-fg-3" title={path ?? undefined}>{who}</span>
        <span className={cn('shrink-0 text-[12px]', row.state === 'conflicted' || row.state === 'missing' ? 'text-warning-text' : 'text-fg-4')}>{worktreeStateText(row.state)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 pl-5 text-[12px] text-fg-4">
        <span>{relativeTime(row.createdAt)}</span>
        {row.sizeBytes !== undefined && <span>{formatBytes(row.sizeBytes)}</span>}
        {row.pending.files > 0 && <span className="text-fg-3">{t('{n} 个文件还没应用到项目文件夹', { n: row.pending.files })}</span>}
        {(row.pending.secret ?? 0) > 0 && <span className="text-fg-3" data-worktree-secret>{t('{n} 个存放密钥的文件不会应用，只在工作树里', { n: row.pending.secret ?? 0 })}</span>}
        <span className="flex-1" />
        {onView && path && row.state !== 'missing' && <button type="button" className={smallButton} onClick={() => onView(path)} data-worktree-view>{t('查看')}</button>}
        {settleable(row) && (
          <>
            <TwoStepConfirm title={t('把这个工作树的改动应用到项目文件夹')} confirmLabel={t('确认应用')} className="w-full basis-full"
              emptyText={t('没有要应用的改动。')}
              preview={() => worktreeApi.previewWorktreeApply(projectId, row.id)}
              confirm={plan => worktreeApi.confirmWorktreeApply(projectId, row.id, plan.confirm)}
              onDone={result => { const conflicts = (result as { conflicts?: unknown[] }).conflicts?.length ?? 0; settled(conflicts ? t('已应用不冲突的文件；{n} 个文件仍有冲突。', { n: conflicts }) : t('已应用到项目文件夹。'), result) }}
              trigger={(start, busy) => <button type="button" className={smallButton} disabled={busy} onClick={start} data-worktree-apply><Upload />{t('应用')}</button>} />
            <TwoStepConfirm title={t('丢弃这个工作树和它还没应用的改动')} confirmLabel={t('确认丢弃')} danger className="w-full basis-full"
              emptyText={t('工作树会删除；被忽略的文件先移进回收站。')}
              preview={() => worktreeApi.previewWorktreeDiscard(projectId, row.id)}
              confirm={plan => worktreeApi.confirmWorktreeDiscard(projectId, row.id, plan.confirm)}
              onDone={result => settled(t('已丢弃这个工作树。'), result)}
              trigger={(start, busy) => <button type="button" className={smallButton} disabled={busy} onClick={start} data-worktree-discard><Trash2 />{t('丢弃')}</button>} />
          </>
        )}
      </div>
    </div>
  )
}
