/**
 * A run's latest steps (design 2.1, "最近 12 步"): what kind of step, what it
 * did or is doing, its outcome when known, and when. Live starts carry no
 * outcome, so an earlier live step shows only its target — never a guessed
 * 已完成.
 */
import { memo } from 'react'
import { CircleHelp, Loader2, X } from 'lucide-react'
import type { RunStepView } from '@/lib/background-runs'
import { ToolIcon } from '@/components/timeline/tool-icons'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useT, type TFunction } from '@/i18n'

/** How long ago, to the second under a minute (steps come seconds apart). */
export function stepAgo(at: number, now: number, t: TFunction): string {
  const diff = Math.max(0, now - at)
  if (diff < 5_000) return t('刚刚')
  if (diff < 60_000) return t('{n} 秒前', { n: Math.floor(diff / 1000) })
  return relativeTime(new Date(at).toISOString(), now)
}

export const StepList = memo(function StepList({ steps, now, className }: { steps: RunStepView[]; now: number; className?: string }) {
  const t = useT()
  if (!steps.length) return <p className={cn('px-1 py-1.5 text-[12px] text-fg-4', className)}>{t('还没有步骤记录')}</p>
  return (
    <ol className={cn('space-y-px', className)} aria-label={t('最近的步骤')}>
      {steps.map(step => (
        <li key={step.id} className="flex h-6 min-w-0 items-center gap-2 rounded-md px-1 text-[12px] leading-5">
          <ToolIcon kind={step.kind} className={cn('size-3.5 shrink-0', step.status === 'running' ? 'text-accent-text' : 'text-fg-4')} />
          <span className="min-w-0 flex-1 truncate">
            {step.verb && <span className={cn('mr-1.5', step.status === 'running' ? 'text-fg' : step.status === 'failed' ? 'text-danger' : 'text-fg-2')}>{step.verb}</span>}
            <span className={step.verb ? 'text-fg-3' : 'text-fg-2'}>{step.target}</span>
          </span>
          {step.status === 'running' && <Loader2 className="spin size-3 shrink-0 text-accent-text" aria-label={t('进行中')} />}
          {step.status === 'failed' && <X className="size-3 shrink-0 text-danger" strokeWidth={2.4} aria-label={t('失败')} />}
          {step.status === 'uncertain' && <CircleHelp className="size-3 shrink-0 text-warning-text" aria-label={t('未确认')} />}
          <span className="w-[4.5em] shrink-0 text-right tabular-nums text-fg-4">{stepAgo(step.at, now, t)}</span>
        </li>
      ))}
    </ol>
  )
})
