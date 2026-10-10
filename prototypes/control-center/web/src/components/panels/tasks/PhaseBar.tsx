/**
 * A run's progress (design 2.1, D6): 计划项 x/y as segments, the steps done
 * with failures marked, a scheduled run's 执行 → 交付, a subagent group's
 * roles in working order. Each part shows only when its data exists; nothing
 * is estimated. Steps have no "of n": the host's step limit counts model
 * requests while its steps are tool calls (one request can make several), so
 * no fraction or bar of the two would mean anything.
 */
import { memo, type ReactNode } from 'react'
import { ArrowRight, Check, Minus, X } from 'lucide-react'
import type { RunPhase, RunStage } from '@/lib/background-runs'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'

/** Up to this many plan items draw as separate segments; more draw as one bar. */
const SEGMENTS = 12

export const hasPhase = (phase: RunPhase) => Boolean(phase.plan || phase.steps || phase.delivery || phase.roles)

export const PhaseBar = memo(function PhaseBar({ phase, live, className }: { phase: RunPhase; live: boolean; className?: string }) {
  const t = useT()
  if (!hasPhase(phase)) return null
  const fill = live ? 'bg-accent' : 'bg-fg-3'
  return (
    <div className={cn('grid gap-x-5 gap-y-1.5 @[420px]/tasks:grid-cols-2', className)}>
      {phase.plan && (
        <Row label={t('计划项')} value={`${phase.plan.done}/${phase.plan.total}`} aria={t('计划项完成 {done}/{total}', { done: phase.plan.done, total: phase.plan.total })}>
          {phase.plan.total <= SEGMENTS
            ? <span className="flex flex-1 gap-[3px]">{Array.from({ length: phase.plan.total }, (_, i) => <span key={i} className={cn('h-1.5 flex-1 rounded-full', i < phase.plan!.done ? fill : 'bg-[var(--line-strong)]')} />)}</span>
            : <Track ratio={phase.plan.done / phase.plan.total} fill={fill} />}
        </Row>
      )}
      {phase.steps && (
        <p className="flex h-5 min-w-0 items-center gap-1 truncate text-[12px] tabular-nums text-fg-3" data-steps>
          <span className="text-fg-2">{t('已做 {n} 步', { n: phase.steps.completed })}</span>
          {phase.steps.failed > 0 && <><span className="text-fg-4" aria-hidden>·</span><span className="text-danger">{t('失败 {n}', { n: phase.steps.failed })}</span></>}
          {phase.steps.uncertain > 0 && <><span className="text-fg-4" aria-hidden>·</span><span className="text-warning-text">{t('{n} 步未确认', { n: phase.steps.uncertain })}</span></>}
        </p>
      )}
      {phase.delivery && (
        <div className="flex h-5 items-center gap-1.5 text-[12px] text-fg-3" aria-label={t('执行，然后交付')}>
          <Stage stage={phase.delivery.run} label={t('执行')} />
          <ArrowRight className="size-3 text-fg-4" aria-hidden />
          <Stage stage={phase.delivery.deliver} label={t('交付')} />
        </div>
      )}
      {phase.roles && (
        <div className="flex min-w-0 flex-wrap items-center gap-1 @[420px]/tasks:col-span-2">
          {phase.roles.map(role => (
            <span key={role.role} className={cn('inline-flex h-5 items-center gap-1 rounded-[5px] bg-subtle px-1.5 text-[11.5px] tabular-nums', role.running ? 'text-accent-text' : role.done === role.total ? 'text-fg-3' : 'text-fg-2')}>
              {role.running > 0 && <span className="size-1 animate-pulse rounded-full bg-accent" aria-hidden />}
              {role.label}<span className="text-fg-4">{role.done}/{role.total}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
})

function Row({ label, value, aria, children }: { label: string; value: ReactNode; aria: string; children: ReactNode }) {
  return (
    <div className="flex h-5 min-w-0 items-center gap-2 text-[12px]" role="group" aria-label={aria}>
      <span className="w-[3.5em] shrink-0 text-fg-3">{label}</span>
      {children}
      <span className="shrink-0 tabular-nums text-fg-2">{value}</span>
    </div>
  )
}

function Track({ ratio, fill }: { ratio: number; fill: string }) {
  const done = Math.min(1, Math.max(0, ratio))
  return (
    <span className="relative flex h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-[var(--line-strong)]">
      <span className={cn('h-full transition-[width] duration-500 ease-out', fill)} style={{ width: `${done * 100}%` }} />
    </span>
  )
}

const STAGE_TONE: Record<RunStage, string> = {
  pending: 'text-fg-4', active: 'text-accent-text', done: 'text-fg-2', failed: 'text-danger', attention: 'text-warning-text', stopped: 'text-fg-4',
}
function Stage({ stage, label }: { stage: RunStage; label: string }) {
  const icon = stage === 'done' ? <Check className="size-3 text-success" strokeWidth={2.4} />
    : stage === 'failed' ? <X className="size-3" strokeWidth={2.4} />
      : stage === 'stopped' ? <Minus className="size-3" strokeWidth={2.4} />
        : stage === 'attention' ? <span className="text-[11px] font-bold leading-none">!</span>
          : stage === 'active' ? <span className="size-1.5 animate-pulse rounded-full bg-accent" />
            : <span className="size-1.5 rounded-full shadow-[inset_0_0_0_1px_var(--color-fg-4)]" />
  return <span className={cn('inline-flex items-center gap-1', STAGE_TONE[stage])} data-stage={stage}><span className="grid size-3 place-items-center" aria-hidden>{icon}</span>{label}</span>
}
