/**
 * Who is doing a run's work (design 2.1 "代理 | 模型 | Tokens | 用时 | 完成"):
 * a subagent group lists each delegated agent (role and task, model, tokens,
 * time, status); background work is one row, its executor. A table when the
 * panel is wide, two-line rows when it is narrow (container query).
 */
import { memo } from 'react'
import type { SubagentInfo } from '@/api/types'
import { runElapsed, toMs, type BackgroundRun } from '@/lib/background-runs'
import { formatDuration, formatTokens } from '@/lib/format'
import { subagentRoleName, subagentStatusLabel } from '@/components/timeline/SubagentCard'
import { Skeleton } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'

export interface AgentRow { id: string; role: string; task: string; model: string | null; tokens: number | null; estimated: boolean; elapsed: number | null; status: string; statusLabel: string; running: boolean }

const TONE: Record<string, string> = { running: 'text-accent-text', completed: 'text-success', failed: 'text-danger', cancelled: 'text-warning-text', interrupted: 'text-warning-text' }

/** One delegated agent as a table row. */
export function agentRow(agent: SubagentInfo, now: number): AgentRow {
  const start = toMs(agent.startedAt), end = toMs(agent.endedAt)
  const running = agent.status === 'running'
  return {
    id: agent.agentId, role: subagentRoleName(agent), task: (agent.task ?? '').replace(/\s+/g, ' ').trim(), model: agent.model?.name ?? null,
    tokens: agent.usage?.totalTokens || null, estimated: Boolean(agent.usage?.estimated),
    elapsed: start === null ? null : Math.max(0, (running ? now : end ?? now) - start), status: agent.status, statusLabel: subagentStatusLabel(agent.status), running,
  }
}

const GRID = '@[480px]/tasks:grid @[480px]/tasks:grid-cols-[minmax(0,1fr)_minmax(4.5rem,7.5rem)_3.75rem_3.75rem_4.5rem] @[480px]/tasks:items-center @[480px]/tasks:gap-x-3'

export const AgentTable = memo(function AgentTable({ rows, loading, error, onRetry, className }: { rows: AgentRow[]; loading?: boolean; error?: boolean; onRetry?: () => void; className?: string }) {
  const t = useT()
  if (loading && !rows.length) return <div className={cn('space-y-2 px-1 py-1.5', className)} aria-busy><Skeleton className="h-3.5 w-4/5" /><Skeleton className="h-3.5 w-3/5" /></div>
  if (error && !rows.length) return (
    <p className={cn('flex items-center gap-2 px-1 py-1.5 text-[12px] text-fg-3', className)}>
      {t('没能读取子代理列表。')}
      {onRetry && <button type="button" onClick={onRetry} className="rounded px-1 text-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{t('重试')}</button>}
    </p>
  )
  if (!rows.length) return <p className={cn('px-1 py-1.5 text-[12px] text-fg-4', className)}>{t('暂无子代理')}</p>
  return (
    <div role="table" aria-label={t('代理')} className={cn('text-[12px]', className)}>
      <div role="row" className={cn('hidden px-1 pb-1 text-[11.5px] text-fg-4', GRID)}>
        <span role="columnheader">{t('代理')}</span>
        <span role="columnheader">{t('模型')}</span>
        <span role="columnheader" className="text-right">{t('用量')}</span>
        <span role="columnheader" className="text-right">{t('用时')}</span>
        <span role="columnheader" className="text-right">{t('状态')}</span>
      </div>
      {rows.map(row => (
        <div key={row.id} role="row" className={cn('rounded-md px-1 py-1 leading-5 hover:bg-hover', GRID)}>
          <span role="cell" className="flex min-w-0 items-baseline gap-1.5">
            <span className={cn('shrink-0 font-medium', row.running ? 'text-fg' : 'text-fg-2')}>{row.role}</span>
            {row.task && <span className="min-w-0 truncate text-fg-3" title={row.task}>{row.task}</span>}
          </span>
          {/* Narrow: the numbers share a second line. */}
          <span className="flex min-w-0 items-center gap-2 text-fg-3 tabular-nums @[480px]/tasks:contents">
            <span role="cell" className="min-w-0 truncate">{row.model ?? '—'}</span>
            <span role="cell" className="@[480px]/tasks:text-right">{row.tokens ? `${row.estimated ? '≈' : ''}${formatTokens(row.tokens)}` : '—'}</span>
            <span role="cell" className="@[480px]/tasks:text-right">{row.elapsed !== null ? formatDuration(Math.max(row.elapsed, 1000)) : '—'}</span>
            <span role="cell" className={cn('ml-auto @[480px]/tasks:ml-0 @[480px]/tasks:text-right', TONE[row.status] ?? 'text-fg-3')}>{row.statusLabel}</span>
          </span>
        </div>
      ))}
    </div>
  )
})

/** Background work's one executor row (design 2.2: 1 行"后台执行"). */
export function workAgentRow(run: BackgroundRun, now: number, label: string): AgentRow {
  const status = run.state === 'running' ? 'running' : run.state === 'done' ? 'completed' : run.state === 'failed' ? 'failed' : run.state === 'cancelled' ? 'cancelled' : run.state
  return { id: run.key, role: label, task: '', model: run.model, tokens: run.tokens?.total ?? null, estimated: Boolean(run.tokens?.estimated), elapsed: runElapsed(run, now), status, statusLabel: run.stateLabel, running: run.state === 'running' }
}
