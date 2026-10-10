/**
 * One background run in the tasks panel (design 2.1). Running work is a card:
 * title, kind · elapsed · agents · tokens, a short summary, its progress, the
 * live step, the controls and outputs, and 代理 / 步骤 on demand. Queued,
 * upcoming and finished runs are compact rows that open into the same body.
 * Controls go through the task store (the sidebar's path); outputs open as
 * tabs through the host (`onOpenTab`).
 */
import { memo, useState, type ReactNode, type Ref } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CalendarClock, ChevronRight, Compass, FileDiff, MessageSquare, Pause, Play, Square } from 'lucide-react'
import { runElapsed, type BackgroundRun } from '@/lib/background-runs'
import { failedOpen, type TaskControl } from '@/lib/tasks'
import { formatDuration, formatTokens } from '@/lib/format'
import { useApp } from '@/store/app-store'
import { controlTask, useTasks } from '@/store/tasks-store'
import { CONTROL_LABELS, FailedAnswerButtons, openSteer, openTaskDetail, TaskFlags, TaskGlyph, TaskMenu } from '@/components/tasks/task-parts'
import { ToolIcon } from '@/components/timeline/tool-icons'
import { Button, Tooltip } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { useT, type TFunction } from '@/i18n'
import { PhaseBar } from './PhaseBar'
import { StepList } from './StepList'
import { AgentTable, agentRow, workAgentRow } from './AgentTable'
import { agentsSignature, loadSessionAgents, useGroupAgents } from './agents-store'
import type { OpenTab } from './types'

const CONTROL_ICONS: Record<TaskControl, typeof Pause> = { pause: Pause, resume: Play, stop: Square, steer: Compass }

/** kind · (project) · time · agents · tokens, as the card's second line. */
export function runMeta(run: BackgroundRun, now: number, t: TFunction, { showProject = false }: { showProject?: boolean } = {}): string[] {
  const elapsed = runElapsed(run, now)
  const time = run.task?.kind === 'schedule' ? run.when
    : run.state === 'running' ? (elapsed !== null ? formatDuration(Math.max(elapsed, 1000)) : run.stateLabel)
      : run.section === 'finished' ? [run.stateLabel, elapsed !== null ? t('用时 {v}', { v: formatDuration(Math.max(elapsed, 1000)) }) : run.when].filter(Boolean).join(' · ')
        : [run.stateLabel, run.when].filter(Boolean).join(' · ')
  return [
    run.kindLabel, showProject ? run.projectName : '', time,
    run.agents ? t('{n} 个代理', { n: run.agents }) : '',
    run.tokens ? `${run.tokens.estimated ? '≈' : ''}${formatTokens(run.tokens.total)}` : '',
  ].filter(Boolean)
}

export interface RunCardProps {
  run: BackgroundRun
  now: number
  /** `card`: running work, always open. `row`: a compact line that opens into the same body. */
  variant: 'card' | 'row'
  expanded?: boolean
  /** Called with the run's key. */
  onToggle?: (key: string) => void
  focused?: boolean
  showProject?: boolean
  onOpenTab: OpenTab
  ref?: Ref<HTMLElement>
}

export const RunCard = memo(function RunCard({ run, now, variant, expanded = false, onToggle, focused, showProject, onOpenTab, ref }: RunCardProps) {
  const t = useT()
  const busy = useTasks(s => run.task !== null && s.busy === run.task.key)
  const parts = runMeta(run, now, t, { showProject })
  const meta = parts.join(' · ')
  const open = variant === 'card' || expanded
  const menu = run.task && <TaskMenu task={run.task} className="opacity-70 hover:opacity-100 data-[state=open]:opacity-100" />

  if (variant === 'card') return (
    <article ref={ref} data-run={run.key} aria-label={run.title}
      className={cn('rounded-xl bg-elevated px-3 pb-2 pt-2.5 shadow-[0_0_0_0.5px_var(--line-strong),var(--shadow-xs)] transition-[box-shadow,opacity] duration-300', focused && 'shadow-[0_0_0_1.5px_var(--line-focus),var(--shadow-xs)]', busy && 'opacity-70')}>
      <header className="flex min-w-0 items-start gap-2">
        <TaskGlyph state={run.state} className="mt-[2px]" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13.5px] font-medium leading-5 text-fg" title={run.title}>{run.title}</h3>
          {/* Wraps instead of cutting off the time and usage when the panel is narrow. */}
          <p className="flex flex-wrap gap-x-1 text-[12px] leading-[18px] tabular-nums text-fg-3" title={tokensTitle(run, t)}>
            {parts.map((part, i) => <span key={i} className="min-w-0 truncate">{i > 0 && <span className="mr-1 text-fg-4" aria-hidden>·</span>}{part}</span>)}
          </p>
        </div>
        <TaskFlags flags={run.flags} className="mt-px" />
        {menu}
      </header>
      {run.summary && <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-[1.6] text-fg-2">{run.summary}</p>}
      <RunBody run={run} now={now} onOpenTab={onOpenTab} focused={focused} />
    </article>
  )

  return (
    <article ref={ref} data-run={run.key} aria-label={run.title}
      className={cn('rounded-lg transition-[background-color,box-shadow] duration-300', open ? 'bg-subtle' : 'hover:bg-hover focus-within:bg-hover', focused && 'shadow-[0_0_0_1.5px_var(--line-focus)]', busy && 'opacity-70')}>
      <div className="flex min-w-0 items-start">
        <button type="button" onClick={() => onToggle?.(run.key)} aria-expanded={open}
          className="group/row flex min-w-0 flex-1 items-start gap-2 rounded-lg py-1.5 pl-2 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
          <span className="relative mt-[2px] grid size-4 shrink-0 place-items-center">
            {run.task?.kind === 'schedule' ? <CalendarClock className="size-[14px] text-fg-3" strokeWidth={1.8} /> : <TaskGlyph state={run.state} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cn('min-w-0 truncate text-[13px] leading-5', run.state === 'cancelled' ? 'text-fg-3' : 'text-fg-2 group-hover/row:text-fg')}>{run.title}</span>
              <TaskFlags flags={run.flags} />
            </span>
            <span className="block truncate text-[12px] leading-[18px] tabular-nums text-fg-4" title={tokensTitle(run, t)}>
              {meta}{!open && run.summary ? <span className="text-fg-3"> · {run.summary}</span> : null}
            </span>
          </span>
          <ChevronRight className={cn('mt-[3px] size-3.5 shrink-0 text-fg-4 opacity-0 transition-[transform,opacity] duration-200 group-hover/row:opacity-100 group-focus-visible/row:opacity-100', open && 'rotate-90 opacity-100')} aria-hidden />
        </button>
        {menu && <span className="pr-1 pt-1">{menu}</span>}
      </div>
      {/* 需要你: a failed run is answered in view — 接着做 where it can work, and 不用了 (the 任务 page's buttons). */}
      {run.section === 'attention' && run.task && failedOpen(run.task) && <FailedAnswerButtons task={run.task} className="-mt-1 pb-1 pl-7" />}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="body" className="overflow-hidden" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}>
            <div className="px-2 pb-2 pl-8">
              {run.summary && <p className="line-clamp-4 text-[12.5px] leading-[1.6] text-fg-2">{run.summary}</p>}
              <RunBody run={run} now={now} onOpenTab={onOpenTab} focused={focused} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  )
})

const tokensTitle = (run: BackgroundRun, t: TFunction) => (run.tokens ? t('用量 {v} tokens{v2}', { v: formatTokens(run.tokens.total), v2: run.tokens.estimated ? t('（估算）') : '' }) : undefined)

/** Progress, the live step, controls and outputs, then 代理 / 步骤 on demand. */
function RunBody({ run, now, onOpenTab, focused }: { run: BackgroundRun; now: number; onOpenTab: OpenTab; focused?: boolean }) {
  const t = useT()
  const live = run.state === 'running'
  const [shown, setShown] = useState<'agents' | 'steps' | null>(focused && run.kind === 'agents' ? 'agents' : null)
  const agentsSummary = useApp(s => (run.kind === 'agents' && run.sessionId ? s.sessionIndex[run.sessionId]?.agents : undefined))
  const group = useGroupAgents(run.kind === 'agents' ? run.sessionId : null, agentsSummary, shown === 'agents')
  const hasAgents = run.kind === 'agents' || run.agents !== null
  const hasSteps = run.kind !== 'agents' && (run.steps.length > 0 || live)
  const toggle = (id: 'agents' | 'steps') => setShown(current => (current === id ? null : id))
  const rows = run.kind === 'agents'
    ? (group.list ?? []).filter(agent => !run.turnId || agent.turnId === run.turnId).map(agent => agentRow(agent, now))
    : [workAgentRow(run, now, t('后台执行'))]

  return (
    <>
      <PhaseBar phase={run.phase} live={live} className="mt-2" />
      {run.latest && (
        <p className="mt-2 flex h-5 min-w-0 items-center gap-1.5 text-[12.5px]" aria-live="polite">
          <ToolIcon kind={run.latest.kind} className={cn('size-3.5 shrink-0', live ? 'text-accent-text' : 'text-fg-4')} />
          {run.latest.verb && <span className={cn('shrink-0', live ? 'text-shimmer text-fg-2' : 'text-fg-3')}>{run.latest.verb}</span>}
          <span className="min-w-0 truncate text-fg-3" title={run.latest.target ?? undefined}>{run.latest.target}</span>
        </p>
      )}
      <RunActions run={run} onOpenTab={onOpenTab} />
      {(hasAgents || hasSteps) && (
        <div className="mt-1 flex items-center gap-1">
          {hasAgents && <Disclosure open={shown === 'agents'} onClick={() => toggle('agents')} label={t('代理')} count={run.agents} />}
          {hasSteps && <Disclosure open={shown === 'steps'} onClick={() => toggle('steps')} label={t('步骤')} count={run.steps.length || null} />}
        </div>
      )}
      <AnimatePresence initial={false}>
        {shown && (
          <motion.div key={shown} className="overflow-hidden" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}>
            <div className="mt-1 rounded-lg bg-inset px-1.5 py-1 shadow-[inset_0_0_0_1px_var(--line-faint)]">
              {shown === 'agents'
                ? <AgentTable rows={rows} loading={run.kind === 'agents' && group.status !== 'ready' && group.status !== 'error'} error={group.status === 'error'}
                    onRetry={() => { if (run.sessionId) void loadSessionAgents(run.sessionId, agentsSignature(agentsSummary)) }} />
                : <StepList steps={run.steps} now={now} />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

function Disclosure({ open, onClick, label, count }: { open: boolean; onClick: () => void; label: string; count: number | null }) {
  return (
    <button type="button" onClick={onClick} aria-expanded={open}
      className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
      <ChevronRight className={cn('size-3 transition-transform duration-200', open && 'rotate-90')} aria-hidden />
      {label}
      {count ? <span className="tabular-nums text-fg-4">{count}</span> : null}
    </button>
  )
}

const ACTION = 'h-6 gap-1 px-2 text-[12px] font-normal shadow-[inset_0_0_0_1px_var(--line)] [&_svg]:size-3'

function RunActions({ run, onOpenTab }: { run: BackgroundRun; onOpenTab: OpenTab }) {
  const t = useT()
  const anyBusy = useTasks(s => s.busy !== null)
  const task = run.task
  const buttons: ReactNode[] = []
  if (task?.kind === 'action') for (const op of run.controls) {
    const Icon = CONTROL_ICONS[op]
    buttons.push(
      <Button key={op} size="sm" variant="ghost" disabled={anyBusy} leading={<Icon />} className={cn(ACTION, op === 'stop' && 'hover:bg-danger-soft hover:text-danger')}
        aria-label={t('{label}：{title}', { label: CONTROL_LABELS[op], title: run.title })}
        onClick={() => { if (op === 'steer') openSteer(task); else void controlTask(task, op).catch(() => { /* toasted */ }) }}>
        {CONTROL_LABELS[op]}
      </Button>,
    )
  }
  if (run.changeId && run.projectId) {
    const { projectId, changeId } = run
    buttons.push(
      <Button key="changes" size="sm" variant="ghost" leading={<FileDiff />} className={ACTION} onClick={() => onOpenTab('change', { projectId, changeId })}>
        {run.changeCount ? t('改动 {n} 个文件', { n: run.changeCount }) : t('查看改动')}
      </Button>,
    )
  }
  if (run.sessionId && run.task?.kind !== 'schedule') {
    const sessionId = run.sessionId
    // A finished scheduled run's result is its delivery in the conversation.
    const label = run.kind === 'scheduled' && run.section === 'finished' ? t('查看结果') : t('打开会话')
    buttons.push(
      <Button key="conversation" size="sm" variant="ghost" leading={<MessageSquare />} className={ACTION}
        onClick={() => onOpenTab('conversation', { projectId: run.projectId, sessionId, actionId: run.kind === 'agents' ? null : run.id, occurrenceKey: run.occurrenceKey })}>
        {label}
      </Button>,
    )
  }
  // A schedule is edited on the 任务 page (design 2.5).
  if (task?.kind === 'schedule') buttons.push(
    <Tooltip key="schedule" content={t('在任务页查看和修改这个日程')}>
      <Button size="sm" variant="ghost" leading={<CalendarClock />} className={ACTION} onClick={() => openTaskDetail(task)}>{t('日程设置')}</Button>
    </Tooltip>,
  )
  if (!buttons.length) return null
  return <div className="mt-2 flex flex-wrap items-center gap-1">{buttons}</div>
}
