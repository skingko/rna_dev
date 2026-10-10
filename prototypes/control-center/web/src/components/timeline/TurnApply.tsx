/**
 * A turn and the project folder (0.63, worktree design §5.1, §12), next to 本轮交付. A worktree conversation's turn
 * says whether its changes reached the folder — 正在应用…, 已应用 · N 个文件 · 查看 · 回退, the files that also had
 * the user's own changes, 与项目文件夹冲突，正在合并, 没有应用：N 个文件冲突 (the card above the composer decides),
 * 这一轮停下了 — and what it left out (ignored folders, a dependency manifest). A direct-mode turn of a git project
 * offers 本轮改动 N 个文件 · 回退本轮 from its checkpoint. A rollback can be undone (已回退 · 撤销). Every write is
 * two steps (TwoStepConfirm). Past retention (a checkpoint the host marks `expired`, a turn's records expired) the
 * footer says 已过期，不能回退 instead of offering a rollback the host would refuse.
 */
import { memo, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CircleAlert, GitMerge, Loader2, PackageOpen, Undo2 } from 'lucide-react'
import { worktreeApi, type RollbackResult } from '@/api/worktree-api'
import type { Interaction, Item } from '@/api/types'
import { useApp, useTurn } from '@/store/app-store'
import { toast } from '@/store/ui-store'
import { refreshIsolation, useTurnApplies } from '@/store/isolation-store'
import { hostChangedCount, useHostTurnChanges } from '@/store/turn-changes-store'
import { loadGitStatus } from '@/lib/workspace-changes'
import { conflictKindText, heldReasonText, isTurnConflictCard, turnApplyView } from '@/lib/isolation'
import { mayChangeFiles, toolKind, toolUnfinished } from '@/lib/tools'
import { Tooltip } from '@/components/ui/primitives'
import { focusTimelineItem } from './timeline-focus'
import { summarizeDeliverables } from './Deliverables'
import { TwoStepConfirm } from './TwoStepConfirm'
import { openApplyHistory } from '@/components/panels/worktree/sheets'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'

const link = 'rounded px-1 text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] disabled:opacity-40'

/**
 * This turn's conflict card still waiting above the composer (HOST_CARDS.sessionConflict, source 'worktree'): the one
 * `turn.apply.card` names, else the one whose actionId is this turn's. Read only while the footer offers 去处理, so a
 * long conversation's footers do not scan its items on every update.
 */
function useWorktreeCard(sessionId: string, turnId: string, interactionId: string | null, wanted: boolean): string | null {
  return useApp(s => {
    const slice = wanted ? s.sessions[sessionId] : undefined
    if (!slice) return null
    for (let i = slice.order.length - 1; i >= 0; i--) {
      const ix = slice.items[slice.order[i]]?.interaction as (Interaction & { actionId?: string | null }) | undefined
      if (!ix || ix.source !== 'worktree' || ix.canRespond === false || (ix.status !== 'pending' && ix.status !== 'interrupted')) continue
      if (interactionId ? ix.id === interactionId : isTurnConflictCard(ix.actionId, turnId)) return slice.order[i]
    }
    return null
  })
}

export const TurnApplyLine = memo(function TurnApplyLine({ sessionId, turnId, running, toolIds }: { sessionId: string; turnId: string; running: boolean; toolIds: string[] }) {
  const t = useT()
  const turn = useTurn(sessionId, turnId)
  const projectId = useApp(s => s.sessions[sessionId]?.meta.projectId ?? s.sessionIndex[sessionId]?.projectId ?? null)
  const items = useApp(useShallow(s => toolIds.map(id => s.sessions[sessionId]?.items[id]).filter((i): i is Item => Boolean(i?.tool))))
  const { changed, commands, mayWrite } = useMemo(() => ({
    changed: summarizeDeliverables(items).changed.length,
    commands: items.some(item => toolKind(item.tool!) === 'command' && !toolUnfinished(item.tool!)),
    mayWrite: items.some(item => mayChangeFiles(item.tool!)),
  }), [items])
  const wanted = Boolean(turn && !running && (turn.apply || turn.checkpoint))
  const { records, loaded } = useTurnApplies(projectId, sessionId, turnId, wanted)
  // The host's count of files the turn changed in the project folder (worker merges included), still standing.
  const host = useHostTurnChanges(sessionId, turnId, { running, mayWrite })
  const hostChanged = host.changes ? hostChangedCount(host.changes) : null
  const computed = turn ? turnApplyView({ turn, running, records, loaded, changed, commands, hostChanged }) : null
  // While the host's count is read, no count that would change a moment later: 已应用 without its number, and a
  // direct-mode turn's line (本轮改动 N 个文件 or 本轮执行过命令, or nothing) once the count is known.
  const view = computed && host.state === 'loading' ? (computed.kind === 'applied' ? { ...computed, files: null } : ['none', 'checkpoint', 'checkpoint_expired', 'no_checkpoint'].includes(computed.kind) ? { kind: 'none' as const } : computed) : computed
  const apply = turn?.apply
  const card = useWorktreeCard(sessionId, turnId, apply?.card?.interactionId ?? null, view?.kind === 'conflicted' || view?.kind === 'pending')
  if (!turn || !projectId || !view) return null
  const extras = !running && apply && (apply.ignoredNew?.length || apply.dependencies)
  if (view.kind === 'none' && !extras) return null

  const settled = (result: unknown) => {
    const outcome = result as Partial<RollbackResult> | null
    const restored = outcome?.restored?.length ?? 0, skipped = outcome?.skipped?.length ?? 0
    toast(skipped ? t('已还原 {n} 个文件；{m} 个之后又改过，没有动。', { n: restored, m: skipped }) : t('已还原 {n} 个文件。', { n: restored }), 'success')
    refreshIsolation(projectId, sessionId)
    void loadGitStatus(projectId)
  }
  const goToCard = card ? <button type="button" className={cn(link, 'text-accent-text')} onClick={() => focusTimelineItem(sessionId, card)}>{t('去处理')}</button> : null
  const held = view.kind === 'pending' ? heldReasonText(view.reason) : null
  const conflictTitle = (paths: { path: string; kind: string }[]) => paths.map(row => `${row.path} · ${conflictKindText(row.kind)}`).join('\n')

  return (
    <div className="mt-2 text-[12.5px] leading-[1.6] text-fg-3" data-turn-apply={view.kind}>
      {view.kind === 'applying' && <p className="flex items-center gap-1.5"><Loader2 className="size-3.5 spin" />{t('正在应用到项目文件夹…')}</p>}
      {view.kind === 'merging' && <p className="flex items-center gap-1.5 text-warning-text"><GitMerge className="size-3.5" />{t('与项目文件夹冲突，正在合并')}</p>}
      {view.kind === 'conflicted' && (
        <p className="flex flex-wrap items-center gap-1 text-warning-text">
          <CircleAlert className="size-3.5" />
          <Tooltip content={<span className="whitespace-pre-line">{conflictTitle(view.paths)}</span>}><span tabIndex={0} className="cursor-default rounded outline-none focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{t('没有应用：{n} 个文件冲突', { n: view.files })}</span></Tooltip>
          {goToCard}
        </p>
      )}
      {view.kind === 'pending' && (
        <p className="flex flex-wrap items-center gap-1">
          <span>{held ? t('{reason}，改动还在工作树里', { reason: held }) : t('这一轮停下了，改动还在工作树里')}</span>
          {view.files > 0 && <Tooltip content={<span className="whitespace-pre-line">{conflictTitle(view.paths)}</span>}><span tabIndex={0} className="cursor-default rounded text-warning-text outline-none focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{t('{n} 个文件冲突', { n: view.files })}</span></Tooltip>}
          {goToCard ?? <span className="text-fg-4">{t('下次交还给你时再应用')}</span>}
        </p>
      )}
      {view.kind === 'applied' && (
        <>
          <TwoStepConfirm title={t('回退这一轮写进项目文件夹的改动')} confirmLabel={t('确认回退')} danger
            preview={input => worktreeApi.previewTurnRollback(projectId, turnId, input)}
            confirm={(plan, input) => worktreeApi.confirmTurnRollback(projectId, turnId, plan.confirm, input)} onDone={settled}
            trigger={(start, busy) => (
              <p className="flex flex-wrap items-center gap-1">
                <span>{view.files === null ? t('已应用到项目文件夹') : t('已应用到项目文件夹 · {n} 个文件', { n: view.files })}</span>
                <span aria-hidden>·</span>
                <button type="button" className={link} onClick={() => openApplyHistory(projectId, { focus: view.applyIds.at(-1), sessionId })}>{t('查看')}</button>
                <span aria-hidden>·</span>
                {view.expired
                  ? <Expired />
                  : <button type="button" className={link} disabled={busy} onClick={start}>{t('回退')}</button>}
              </p>
            )} />
          {view.bothChanged > 0 && <p className="text-fg-4">{t('其中 {n} 个文件同时有你在项目文件夹里的改动', { n: view.bothChanged })}</p>}
        </>
      )}
      {view.kind === 'rolled_back' && (
        <TwoStepConfirm title={t('撤销回退：重新写回这些改动')} confirmLabel={t('确认撤销')}
          preview={input => (view.undo ? worktreeApi.previewRollback(projectId, view.undo, input) : Promise.reject(new Error(t('找不到这次回退的记录。'))))}
          confirm={(plan, input) => worktreeApi.confirmRollback(projectId, view.undo!, plan.confirm, input)} onDone={settled}
          trigger={(start, busy) => (
            <>
              <p className="flex items-center gap-1">
                <Undo2 className="size-3.5" /><span>{t('已回退')}</span>
                {view.undo && <><span aria-hidden>·</span><button type="button" className={link} disabled={busy} onClick={start}>{t('撤销')}</button></>}
              </p>
              {view.left.length > 0 && (
                <p className="flex flex-wrap items-center gap-1 text-fg-4" data-turn-apply-left>
                  <span>{t('处理冲突时写入的 {n} 条记录没有一起回退', { n: view.left.length })}</span>
                  <span aria-hidden>·</span>
                  <button type="button" className={link} onClick={() => openApplyHistory(projectId, { focus: view.left.at(-1), sessionId })}>{t('查看')}</button>
                </p>
              )}
            </>
          )} />
      )}
      {view.kind === 'checkpoint' && (
        <TwoStepConfirm title={t('回退本轮的改动')} confirmLabel={t('确认回退')} danger selectable
          preview={input => worktreeApi.previewTurnRollback(projectId, turnId, input)}
          confirm={(plan, input) => worktreeApi.confirmTurnRollback(projectId, turnId, plan.confirm, input)} onDone={settled}
          trigger={(start, busy) => (
            <p className="flex items-center gap-1">
              <span>{view.files ? t('本轮改动 {n} 个文件', { n: view.files }) : t('本轮执行过命令')}</span>
              <span aria-hidden>·</span>
              <button type="button" className={link} disabled={busy} onClick={start} data-turn-rollback>{t('回退本轮')}</button>
            </p>
          )} />
      )}
      {view.kind === 'checkpoint_expired' && (
        <p className="flex flex-wrap items-center gap-1" data-turn-checkpoint="expired">
          <span>{view.files ? t('本轮改动 {n} 个文件', { n: view.files }) : t('本轮执行过命令')}</span>
          <span aria-hidden>·</span>
          <Expired />
        </p>
      )}
      {view.kind === 'no_checkpoint' && (
        <Tooltip content={view.reason === 'timeout' ? t('本轮开始时的快照超过 60 秒没完成，跳过了。') : t('本轮开始时没能留下快照。')}>
          <p tabIndex={0} className="w-fit cursor-default rounded text-fg-4 outline-none focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{t('本轮没有检查点')}</p>
        </Tooltip>
      )}
      {!running && apply?.ignoredNew?.length ? <p className="text-fg-4">{t('工作树里有未应用的被忽略文件：{dirs}', { dirs: apply.ignoredNew.join(', ') })}</p> : null}
      {!running && apply?.dependencies && <p className="flex items-center gap-1.5 text-fg-4"><PackageOpen className="size-3.5" />{t('依赖清单变了，项目文件夹需要重新安装')}</p>}
    </div>
  )
})

/** Past retention (turn checkpoints and apply records are kept 30 days): no rollback any more, and why. */
function Expired() {
  const t = useT()
  return (
    <Tooltip content={t('检查点只保留 30 天，这一轮的已经清理了。')}>
      <span tabIndex={0} className="cursor-default rounded text-fg-4 outline-none focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]" data-turn-expired>{t('已过期，不能回退')}</span>
    </Tooltip>
  )
}
