/**
 * 记忆同步状态 (legacy settings `#memory-sync-status`): how completed
 * conversation turns and autonomous deliveries were archived to project
 * memory, per session, from `GET /api/v2/projects/:id/memory-sync`. Counts
 * are recorded sync outcomes only — archiving is not the same as producing
 * new memories, and nothing here probes or re-sends anything by itself.
 * Only unresolved outcomes (the host is still finding out) count as needing a
 * look, and they offer no action. A settled loss (MEM-4) goes straight to
 * history with nothing to click (A2, as OpenViking's own client records a
 * permanent gap); a failed extraction there can optionally be re-extracted, a
 * paid upload the user confirms first.
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowUpRight, CheckCircle2, CloudUpload, RefreshCw } from 'lucide-react'
import { memorySyncRef, supportApi, type MemorySyncIssue, type MemorySyncSession, type MemorySyncState, type MemorySyncStatus } from '@/api/support-api'
import { selectSession } from '@/store/sync'
import { useUi } from '@/store/ui-store'
import { useApp } from '@/store/app-store'
import { usePanels } from '@/components/settings/panel-store'
import { Badge, Disclosure } from '@/components/settings/form'
import { Button } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { formatDate, useLocale, useT, type TFunction } from '@/i18n'

// Only outcomes the host is still checking count here, and they settle by themselves: a notice, not an alarm.
const TONE: Record<MemorySyncState, 'danger' | 'warning' | 'success' | 'default'> = { attention: 'warning', syncing: 'warning', synced: 'success', none: 'default' }

export function memorySyncHeadline(status: MemorySyncStatus, t: TFunction) {
  const state = status.status === 'attention' ? t('部分记忆同步结果还在核对') : status.status === 'syncing' ? t('记忆正在同步') : status.status === 'synced' ? t('归档已同步') : t('尚无同步记录')
  return `${state} · ${t('{n} 轮对话已归档', { n: status.completedTurns })}`
}

export function memorySyncDetail(status: MemorySyncStatus, t: TFunction) {
  const parts = [t('对话记忆：{done} 轮归档完成，{inc} 次增量已同步，{pending} 段等待处理', { done: status.completedTurns, inc: status.incremental, pending: status.pending })]
  if (status.retained) parts.push(t('{n} 段已同步待整理', { n: status.retained }))
  if (status.attention) parts.push(t('{n} 段还在核对', { n: status.attention }))
  // Settled losses are history: counted, never asked about (A2).
  if (status.settledLoss) parts.push(t('{n} 段没有同步成功', { n: status.settledLoss }))
  const e = status.evidence
  const evidence = e.records ? t('自主交付与交互答复：{done} 项归档完成，服务回报抽取 {extracted} 条长期记忆；项目执行资料 {indexed} 项已索引、{pending} 项待索引。', { done: e.completed, extracted: e.extracted, indexed: e.indexed, pending: e.indexPending }) : ''
  return `${parts.join(t('，'))}${t('。')}${evidence ? ` ${evidence}` : ''} ${t('归档完成不等于产生新记忆。')}`
}

function stateLabel(state: MemorySyncState, t: TFunction) {
  return state === 'attention' ? t('核对中') : state === 'syncing' ? t('同步中') : state === 'synced' ? t('已同步') : t('无记录')
}

/** The project's directory-summary upkeep in plain words; nothing once it completed. A failed one is a settled gap the
 * next extraction rebuilds, never an alarm (A2). */
export function memorySummaryLine(summary: MemorySyncStatus['summary'], t: TFunction): string | null {
  if (!summary?.status || summary.status === 'completed') return null
  if (summary.status === 'failed') return t('项目摘要没有整理完整，下次提炼后会重新整理；记忆原文不受影响。')
  if (summary.status === 'uncertain' || summary.resolution === 'unresolved') return t('项目摘要的整理结果还在核对。')
  return t('项目摘要正在整理。')
}

export function useMemorySync(projectId: string, revision: string) {
  const [status, setStatus] = useState<MemorySyncStatus | null | 'unsupported'>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    supportApi.memorySync(projectId).then(next => { if (live) { setStatus(next ?? 'unsupported'); setError(null) } }).catch(e => { if (live) setError((e as Error).message) })
    return () => { live = false }
  }, [projectId, revision, tick])
  // While writes are in flight, refresh occasionally so the panel settles by itself.
  const syncing = status && status !== 'unsupported' && status.status === 'syncing'
  useEffect(() => {
    if (!syncing) return
    const timer = setInterval(() => setTick(n => n + 1), 8000)
    return () => clearInterval(timer)
  }, [syncing])
  return { status, error, reload: () => setTick(n => n + 1) }
}

export function MemorySyncPanel({ projectId, revision = '' }: { projectId: string; revision?: string }) {
  const t = useT()
  const { status, error, reload } = useMemorySync(projectId, revision)
  if (status === 'unsupported' || (status && status.status === 'none')) return null
  if (!status) return error ? <p className="text-[12px] text-danger">{t('记忆同步状态读取失败：{error}', { error })}</p> : null
  const Icon = status.status === 'attention' ? AlertTriangle : status.status === 'syncing' ? CloudUpload : CheckCircle2
  const summaryLine = memorySummaryLine(status.summary, t)
  return (
    <Disclosure
      summary={<span className="inline-flex items-center gap-1.5"><Icon className={cn('size-3.5', status.status === 'attention' && 'text-warning')} />{memorySyncHeadline(status, t)}</span>}
      meta={status.sessions.length ? t('{n} 个会话', { n: status.sessions.length }) : undefined}
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[12.5px] leading-[1.6] text-fg-3" data-memory-sync-detail>{memorySyncDetail(status, t)}</p>
        <button type="button" onClick={reload} aria-label={t('刷新同步状态')} title={t('刷新同步状态')} className="grid size-6 shrink-0 place-items-center rounded-md text-fg-4 hover:bg-hover hover:text-fg"><RefreshCw className="size-3.5" /></button>
      </div>
      {summaryLine && <p className="mt-1 text-[12px] text-fg-4" title={status.summary?.code ?? undefined} data-memory-summary={status.summary?.status ?? ''}>{summaryLine}</p>}
      <ul className="mt-2 divide-y divide-line-faint overflow-hidden rounded-lg shadow-[inset_0_0_0_1px_var(--line)]" aria-label={t('各会话同步状态')}>
        {status.sessions.map(row => <SessionRow key={row.sessionId} row={row} projectId={projectId} onChanged={reload} />)}
      </ul>
    </Disclosure>
  )
}

/** One outcome the host is still checking: it settles by itself, so there is nothing to do about it. */
function IssueRow({ issue }: { issue: MemorySyncIssue }) {
  const t = useT()
  const locale = useLocale()
  return (
    <p className="mt-0.5 text-[12px] leading-[1.5] text-fg-3" title={`${issue.code}${issue.upstreamStatus ? ` · HTTP ${issue.upstreamStatus}` : ''}`} data-memory-sync-issue={issue.code}>
      {issue.message || t('这一段没有同步成功。')}{issue.updatedAt ? <span className="text-fg-4"> · {formatDate(issue.updatedAt, locale)}</span> : null}
    </p>
  )
}

/** One settled loss, kept as history. A failed extraction can optionally be extracted again: paid, so the first click
 * asks the host what would be uploaded and the second confirms it. */
function HistoryRow({ issue, projectId, sessionId, onChanged }: { issue: MemorySyncIssue; projectId: string; sessionId: string; onChanged: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<{ confirm: string; messages: number; characters: number } | null>(null)
  const ref = memorySyncRef(sessionId, issue)
  const reextract = async () => {
    setBusy(true); setError(null)
    try {
      if (!plan) { const step = await supportApi.reextractMemorySync(projectId, ref); if (step.status === 'confirm_required') setPlan({ confirm: step.confirm, messages: step.messages, characters: step.characters }); return }
      await supportApi.reextractMemorySync(projectId, ref, plan.confirm); setPlan(null); onChanged()
    } catch (e) { setError((e as Error).message); setPlan(null) } finally { setBusy(false) }
  }
  return (
    <div className="mt-0.5">
      <p className="text-[12px] leading-[1.5] text-fg-4" title={`${issue.code}${issue.upstreamStatus ? ` · HTTP ${issue.upstreamStatus}` : ''}`} data-memory-sync-history={issue.code}>
        {issue.message || t('这一段没有同步成功。')}{issue.updatedAt ? ` · ${formatDate(issue.updatedAt, locale)}` : ''}
        {!plan && issue.actions?.includes('reextract') && (
          <button type="button" disabled={busy} onClick={() => void reextract()} className="ml-1.5 rounded px-1 text-accent-text hover:bg-hover disabled:opacity-50" data-memory-sync-action="reextract">{t('重新提炼（付费）')}</button>
        )}
      </p>
      {plan && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5" data-memory-sync-confirm>
          <span className="text-[12px] text-fg-2">{t('重新提炼会再上传这一段（{messages} 条消息，{characters} 字），并再付一次提炼费用。', { messages: plan.messages, characters: plan.characters })}</span>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void reextract()}>{t('确认重新提炼')}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPlan(null)}>{t('取消')}</Button>
        </div>
      )}
      {error && <p className="mt-0.5 text-[12px] text-danger" role="alert">{error}</p>}
    </div>
  )
}

function SessionRow({ row, projectId, onChanged }: { row: MemorySyncSession; projectId: string; onChanged: () => void }) {
  const t = useT()
  const locale = useLocale()
  const exists = useApp(s => Boolean(s.sessionIndex[row.sessionId]))
  const open = () => {
    usePanels.setState({ memory: null })
    void selectSession(row.sessionId)
    useUi.setState({ view: 'chat' })
  }
  const counts = [
    t('{n} 轮归档', { n: row.completedTurns }),
    row.incremental ? t('{n} 次增量', { n: row.incremental }) : null,
    row.pending ? t('{n} 段等待', { n: row.pending }) : null,
    row.attention ? t('{n} 段还在核对', { n: row.attention }) : null,
    row.settledLoss ? t('{n} 段未同步', { n: row.settledLoss }) : null,
    row.evidence.records ? t('交付资料 {done}/{total}', { done: row.evidence.completed, total: row.evidence.records }) : null,
  ].filter(Boolean).join(' · ')
  return (
    <li className="flex items-start gap-3 px-3 py-2 text-[12.5px]" data-memory-sync-session={row.sessionId}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-fg">{row.title || t('未命名会话')}</span>
          <Badge tone={TONE[row.status]}>{stateLabel(row.status, t)}</Badge>
          {row.archivedAt && <span className="text-[11.5px] text-fg-4">{t('已归档')}</span>}
        </div>
        <p className="mt-0.5 text-fg-3">{counts}{row.lastSuccessAt ? ` · ${t('最近同步 {time}', { time: formatDate(row.lastSuccessAt, locale) })}` : ''}</p>
        {row.issues.map((issue, i) => <IssueRow key={`${i}:${issue.turnId ?? issue.evidenceId ?? ''}:${issue.checkpointId ?? issue.stage ?? ''}`} issue={issue} />)}
        {row.history?.map((issue, i) => <HistoryRow key={`history:${i}:${issue.turnId ?? issue.evidenceId ?? ''}:${issue.checkpointId ?? issue.stage ?? ''}`} issue={issue} projectId={projectId} sessionId={row.sessionId} onChanged={onChanged} />)}
      </div>
      {exists && !row.archivedAt && (
        <button type="button" onClick={open} className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-accent-text hover:bg-hover">
          {t('打开会话')}<ArrowUpRight className="size-3" />
        </button>
      )}
    </li>
  )
}
