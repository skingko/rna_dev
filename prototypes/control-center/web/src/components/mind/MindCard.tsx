/**
 * Compact “Rna 学到的” card for the project overview: health line, counts,
 * the most-used lessons (each opens in 进化's 画像 strand) and, when Rna owes
 * something overdue, a way to settle it in the conversation. Hidden on daemons
 * without the mind routes.
 */
import { useEffect } from 'react'
import { ArrowRight, Lightbulb } from 'lucide-react'
import { lessonGroups, mindCounts } from '@/lib/mind'
import { askOwed, ensureMind, openMind, useMind } from '@/store/mind-store'
import { Skeleton } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { HealthLine } from './parts'

export function MindCard({ projectId, onOpen, className }: { projectId: string; onOpen?: () => void; className?: string }) {
  const t = useT()
  const slot = useMind(s => s.projects[projectId])
  useEffect(() => { void ensureMind(projectId) }, [projectId])
  if (slot === 'unsupported') return null
  const open = (focusId?: string) => { onOpen?.(); openMind(projectId, focusId) }
  if (!slot) return <div className={cn('rounded-xl px-4 py-3 shadow-[inset_0_0_0_1px_var(--line)]', className)} aria-busy><Skeleton className="h-4 w-1/3" /><Skeleton className="mt-2.5 h-3.5 w-5/6" /></div>
  const counts = mindCounts(slot)
  const top = lessonGroups(slot.lessons).flatMap(g => g.lessons.map(l => ({ ...l, label: g.label })))
    .sort((a, b) => (b.uses?.applied ?? 0) - (a.uses?.applied ?? 0)).slice(0, 3)
  const stats: [string, number, boolean][] = [[t('经验'), counts.lessons, false], [t('议程'), counts.openAgenda, false], [t('待兑现承诺'), counts.pendingCommitments, counts.overdueCommitments > 0]]
  return (
    <section aria-label={t('Rna 学到的')} className={cn('rounded-xl px-4 py-3 shadow-[inset_0_0_0_1px_var(--line)]', className)}>
      <div className="flex items-center gap-2">
        <Lightbulb className="size-3.5 text-fg-3" strokeWidth={1.8} aria-hidden />
        <h3 className="text-[13px] font-semibold text-fg">{t('Rna 学到的')}</h3>
        <button type="button" onClick={() => open()} className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12.5px] text-accent-text outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
          {t('在进化页查看')}<ArrowRight className="size-3" aria-hidden />
        </button>
      </div>
      <HealthLine health={slot.health} lessons={counts.lessons} className="mt-1" />
      <dl className="mt-2.5 grid grid-cols-3 gap-2">
        {stats.map(([label, n, warn]) => (
          <div key={label} className="rounded-lg bg-subtle px-2.5 py-1.5">
            <dt className="truncate text-[11.5px] text-fg-3">{label}</dt>
            <dd className="text-[15px] font-semibold text-fg">{n}{warn && (
              <button type="button" title={t('进入项目对话，在输入框上方决定接着做还是不用了')} onClick={() => { onOpen?.(); void askOwed(projectId) }}
                className="ml-1.5 rounded px-0.5 text-[11.5px] font-medium text-warning-text underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{t('{n} 逾期', { n: counts.overdueCommitments })}</button>
            )}</dd>
          </div>
        ))}
      </dl>
      {top.length > 0 && (
        <ul className="mt-2.5 space-y-1">
          {top.map(l => (
            <li key={l.id}>
              <button type="button" onClick={() => open(l.id)} className="flex w-full items-baseline gap-2 rounded-md px-1 py-0.5 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
                <span className="shrink-0 text-[11.5px] text-fg-4">{l.label}</span>
                <span className="min-w-0 truncate text-[13px] text-fg-2">{l.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
