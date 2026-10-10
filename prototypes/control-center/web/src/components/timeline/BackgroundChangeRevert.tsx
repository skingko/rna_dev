/**
 * Plan §4.4: a background change set, kept by default, can be reverted in one click (never overwriting later edits).
 * 0.63 (worktree design §8, §12): a set background work made in its own worktree (`kind: 'git'`) rolls back through
 * its apply record (`applyId`, two steps: what would be restored, then the second click), with the same button text;
 * older sets keep the DirectFix snapshot revert. A git set may also be `deferred` (done, applied after the current
 * turn of a conversation working in the project folder) or `merge_conflicted` (a card above the composer decides, or
 * the conversation it was handed to settles it). A git set applied by more than one record (`applyIds`: its clean
 * part, then a card's answer or a take) rolls them all back as one through the set's own route.
 */
import { useState } from 'react'
import { CircleAlert, Clock3, Undo2 } from 'lucide-react'
import { projectApi } from '@/api/project-api'
import { worktreeApi, type RollbackPreview, type RollbackResult } from '@/api/worktree-api'
import { useApp } from '@/store/app-store'
import { toast } from '@/store/ui-store'
import { refreshIsolation } from '@/store/isolation-store'
import { loadGitStatus } from '@/lib/workspace-changes'
import { conflictKindText, LIST_CAP } from '@/lib/isolation'
import { Button } from '@/components/ui/primitives'
import { TwoStepConfirm } from './TwoStepConfirm'
import { t } from '@/i18n'

export function BackgroundChangeRevert({ projectId, changeId, className }: { projectId: string; changeId: string; className?: string }) {
  const change = useApp(s => s.projects[projectId]?.backgroundChanges?.find(row => row.id === changeId))
  const [busy, setBusy] = useState(false)
  if (!change) return null
  if (change.status === 'deferred') {
    // Held on the user's git operation in the project folder (merge, rebase, …): applied once it ends.
    return <p className={className ?? 'mt-1.5 flex items-center gap-1.5 text-[12.5px] text-fg-3'} data-change-status="deferred"><Clock3 className="size-3.5 shrink-0" />{change.hold === 'git_operation' ? t('做完了，等项目文件夹里的 Git 操作结束后应用') : t('做完了，等这一轮对话结束后应用')}</p>
  }
  if (change.status === 'merge_conflicted') {
    const conflicts = change.conflicts ?? []
    return (
      <div className={className ?? 'mt-1.5 text-[12.5px] text-fg-3'} data-change-status="merge_conflicted">
        {/* No conflict listed: held for another reason (the project went read-only); the card says which. */}
        <p className="flex items-center gap-1.5 text-warning-text"><CircleAlert className="size-3.5 shrink-0" />{change.handedTo
          // The card was answered 让 Rna 处理: the conversation it went to merges it (agent_merge); no card waits now.
          ? (conflicts.length ? t('有 {n} 个文件和项目文件夹里的改动冲突，已交给对话处理', { n: conflicts.length }) : t('还没有应用到项目文件夹，已交给对话处理'))
          : conflicts.length ? t('有 {n} 个文件和项目文件夹里的改动冲突，等你在输入框上方的卡片里决定', { n: conflicts.length }) : t('还没有应用到项目文件夹，等你在输入框上方的卡片里决定')}</p>
        {conflicts.length > 0 && (
          <ul className="mt-0.5 space-y-0.5 pl-5">
            {conflicts.slice(0, LIST_CAP).map(row => <li key={row.path} className="flex min-w-0 gap-2"><span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-2">{row.path}</span><span className="shrink-0 text-fg-4">{conflictKindText(row.kind)}</span></li>)}
            {conflicts.length > LIST_CAP && <li className="text-fg-4">{t('还有 {n} 个文件', { n: conflicts.length - LIST_CAP })}</li>}
          </ul>
        )}
      </div>
    )
  }
  if (change.status !== 'kept') return <p className={className ?? 'mt-1.5 text-[12.5px] text-fg-4'}>{t('已回退')}</p>
  if (change.kind === 'git' && change.applyId) {
    const applyId = change.applyId
    // Several records: the set's route rolls back every one of them as one (one record: its own rollback, as before).
    const several = new Set([...(change.applyIds ?? []), applyId]).size > 1
    return (
      <div className={className ?? 'mt-2'}>
        <TwoStepConfirm title={t('回退这些修改')} confirmLabel={t('确认回退')} danger
          preview={input => (several ? projectApi.revertGitChange<RollbackPreview>(projectId, changeId, input) : worktreeApi.previewRollback(projectId, applyId, input))}
          confirm={(plan, input) => (several ? projectApi.revertGitChange<RollbackResult>(projectId, changeId, { ...input, confirm: plan.confirm }) : worktreeApi.confirmRollback(projectId, applyId, plan.confirm, input))}
          onDone={result => {
            const outcome = result as RollbackResult
            toast(outcome.skipped.length ? t('已回退 {n} 个文件；{m} 个之后又改过，没有动。', { n: outcome.restored.length, m: outcome.skipped.length }) : t('已回退 {n} 个文件。', { n: outcome.restored.length }))
            refreshIsolation(projectId)
            void loadGitStatus(projectId)
          }}
          trigger={(start, pending) => <Button size="sm" variant="secondary" disabled={pending} leading={<Undo2 className="size-3.5" />} onClick={start} data-revert-git>{t('回退这些修改')}</Button>} />
      </div>
    )
  }
  const revert = async () => {
    setBusy(true)
    try {
      const result = await projectApi.revertBackgroundChange(projectId, changeId)
      const outcome = result.outcome
      toast(outcome?.conflicts.length ? t('已回退 {n} 个文件；{m} 个之后又改过，没有动。', { n: outcome.restored.length, m: outcome.conflicts.length }) : t('已回退 {n} 个文件。', { n: outcome?.restored.length ?? change.count }))
    } catch (error) { toast((error as Error).message, 'danger') } finally { setBusy(false) }
  }
  return (
    <div className={className ?? 'mt-2'}>
      <Button size="sm" variant="secondary" disabled={busy} leading={<Undo2 className="size-3.5" />} onClick={() => void revert()}>{t('回退这些修改')}</Button>
    </div>
  )
}
