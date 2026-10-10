/** Project rhythm (legacy createAdaptiveRhythmCard), fed by the shared display projection. */
import { adaptiveRhythmDisplay, rhythmChangesAt } from '@/lib/display/rhythm'
import { useNowUntil } from '@/hooks/useNow'
import type { ProjectDetail } from '@/api/project-api'
import { DefinitionList, Disclosure } from './kit'
import { evolutionRowValue, useEvolutionLanes } from './EvolutionObservability'
import { t } from '@/i18n'

export function RhythmCard({ project, compact = false }: { project: ProjectDetail; compact?: boolean }) {
  // 项目交付 reads the schedules' next runs against the clock: re-render when the next one passes (rows carry no clock).
  const now = useNowUntil(at => rhythmChangesAt(project, at))
  const d = adaptiveRhythmDisplay(project, now)
  // EVO-12: the gene lanes' own state, not the retired whole-genome learning lane's quota ("no candidate guaranteed").
  const lanes = useEvolutionLanes(project.id)
  return (
    <section aria-label={t('当前项目节奏')} className="rounded-xl bg-subtle px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
        <strong className="text-[13.5px] font-semibold text-fg">{d.title}</strong>
      </div>
      <p className="mt-1 line-clamp-3 text-[13px] leading-[1.7] text-fg-3">{d.reason}</p>
      {d.available && (
        <>
          <div className="mt-3">
            <DefinitionList rows={[[t('主动沟通'), d.initiative], [t('进化'), evolutionRowValue(project.evolution?.enabled === false, d.evolution, lanes)], [t('项目交付'), d.schedule]]} />
          </div>
          {!compact || d.blocker || d.history.length || d.modelReason ? (
            <Disclosure className="mt-3 bg-base" summary={t('节奏依据与最近调整{v}', { v: d.assessedAt ? ` · ${d.assessedAt}` : '' })}>
              {d.blocker && (
                <>
                  <p className="font-medium text-fg">{t('当前后台阻塞')}</p>
                  {d.blocker.pendingCount ? <p>{t('{pendingCount} 项会话清理待完成，已尝试 {v} 次。{v2}', { pendingCount: d.blocker.pendingCount, v: d.blocker.attempts ?? 0, v2: d.blocker.retryAt ? t('下次检查 {retryAt}。', { retryAt: d.blocker.retryAt }) : '' })}</p> : null}
                  {d.blocker.causes?.map(cause => <p key={cause}>{cause}</p>)}
                </>
              )}
              <p className="font-medium text-fg">{t('系统调度依据')}</p>
              <p>{t('主动判断：{initiativeReason}', { initiativeReason: d.initiativeReason })}</p>
              {d.modelReason && (
                <>
                  <p className="font-medium text-fg">{d.control === 'manual' ? t('最近模型判断（历史依据）') : t('模型判断')}</p>
                  <p className="whitespace-pre-wrap">{d.modelReason}</p>
                </>
              )}
              {d.history.map((row, i) => (
                <div key={i} className="border-t border-line-faint pt-2">
                  <small className="text-[12px] text-fg-3">{[row.at, row.stage, row.initiative, row.evolution].filter(Boolean).join(' · ')}</small>
                  <p>{row.reason || t('本次调整未保留文字说明')}</p>
                </div>
              ))}
              {!d.history.length && <p className="text-fg-3">{t('尚无模型调整记录。')}</p>}
            </Disclosure>
          ) : null}
        </>
      )}
    </section>
  )
}
