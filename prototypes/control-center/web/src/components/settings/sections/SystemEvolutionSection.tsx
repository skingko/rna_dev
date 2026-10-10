/**
 * 系统进化 (read-only): the cross-project aggregate of real-interaction
 * signals, tool failures, proactive-message outcomes and JEV ledger labels,
 * and the recurring problems they point at. Shared components (core prompts,
 * tool descriptions, JEV templates) change only in released versions, so
 * there is nothing for the user to adopt here.
 */
import { useEffect, useState } from 'react'
import { evolutionApi, type FailureSummary, type SystemEvolution } from '@/api/evolution-api'
import { panelsApi } from '@/api/panels'
import type { DecisionPointInfo } from '@/api/panels-types'
import { FAILURE_CLASSES, failureCauseLabel, signalLabel, signalScoreDisplay } from '@/lib/evolution'
import { useApp } from '@/store/app-store'
import { Button, Skeleton } from '@/components/ui/primitives'
import { useT, type MessageKey, type TFunction } from '@/i18n'
import { Badge, Empty, Group, Note, SettingsSection, ValueRow, formatDateTime } from '../form'
import type { SectionProps } from '../SettingsDialog'
import { pointLabel } from '../judgment'

export const SYSTEM_COMPONENT_LABELS: Record<string, MessageKey> = { core_prompt_section: '核心提示词段落', core_tool_description: '核心工具描述', jev_template: 'JEV 判断模板', communication_rule: '沟通规范' }
const componentLabel = (t: TFunction, component: string) => (SYSTEM_COMPONENT_LABELS[component] ? t(SYSTEM_COMPONENT_LABELS[component]) : component)
/** Why a tool call failed (host `toolFailureCause`); only the model's own calls count towards a recurring problem. */
export const TOOL_FAILURE_CAUSE_LABELS: Record<'call' | 'environment' | 'refused' | 'interrupted', MessageKey> = { call: '模型调用出错', environment: '外部服务或网站', refused: '规则拦截', interrupted: '被中断' }
const evidenceText = (key: string, value: unknown) => (key === 'lastAt' && typeof value === 'string' ? formatDateTime(value) : typeof value === 'object' ? JSON.stringify(value) : String(value))

export default function SystemEvolutionSection(_: SectionProps) {
  const t = useT()
  const [data, setData] = useState<SystemEvolution | null | 'unsupported'>(null)
  const [failures, setFailures] = useState<FailureSummary | null>(null)
  // Point titles come from the judgment settings contract (the host's `points[].title`).
  const [points, setPoints] = useState<DecisionPointInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const projects = useApp(s => s.projects)
  const load = async () => {
    try {
      const [system, fail, judgment] = await Promise.all([evolutionApi.system(), evolutionApi.systemFailures().catch(() => null), panelsApi.decisionKernel().catch(() => null)])
      setData(system ?? 'unsupported'); setFailures(fail); setPoints(judgment?.points ?? []); setError(null)
    } catch (e) { setError((e as Error).message) }
  }
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <Note tone="danger" action={<Button size="sm" onClick={() => void load()}>{t('重试')}</Button>}>{t('系统进化汇总暂不可用：{error}', { error })}</Note>
  if (data === 'unsupported') return <Empty>{t('当前本地服务版本尚不提供系统进化汇总。升级后，这里会汇总各项目的真实信号，并列出可提议改进的通用组件。')}</Empty>
  if (!data) return <div className="space-y-3"><Skeleton className="h-12 w-full rounded-lg" /><Skeleton className="h-40 w-full rounded-xl" /></div>

  const kinds = Object.entries(data.signalKinds).filter(([, n]) => n > 0)
  const tools = Object.entries(data.toolFailures).sort((a, b) => b[1] - a[1]).slice(0, 8)
  const causes = data.toolFailureCauses
  const ledger = Object.entries(data.jevLedger)
  return (
    <>
      <p className="mb-4 text-[12.5px] leading-[1.65] text-fg-3">{t('每个项目是独立的 Agent，各自进化。这里汇总所有项目的真实信号（工具失败、被忽略的主动消息、JEV 判断结果），用于改进通用组件（{components}）；这些改进随新版本发布，只读，无需你操作。', { components: data.components.map(c => componentLabel(t, c)).join(t('、')) })}</p>
      <SettingsSection title={t('反复出现的问题')} description={t('由跨项目信号自动归纳；证据不足时不会出现。它们用于改进之后发布的新版本，不需要你操作。')}>
        {data.targets.length ? (
          <div className="space-y-2">
            {data.targets.map(target => (
              <div key={target.key} className="rounded-xl px-4 py-3 shadow-[inset_0_0_0_1px_var(--line)]">
                <div className="flex flex-wrap items-center gap-2"><Badge tone="accent">{componentLabel(t, target.component)}</Badge><code className="truncate font-mono text-[11.5px] text-fg-4">{target.key}</code></div>
                <p className="mt-1.5 text-[13px] leading-[1.65] text-fg-2">{target.hypothesis}</p>
                {target.evidence && <p className="mt-1 text-[12px] text-fg-4">{t('证据：{list}', { list: Object.entries(target.evidence).map(([k, v]) => `${k} ${evidenceText(k, v)}`).join(' · ') })}</p>}
              </div>
            ))}
          </div>
        ) : <Empty>{t('目前没有达到阈值的系统级目标（例如同一工具失败 ≥ 3 次、主动消息忽略多于回复、多个项目中频繁纠正）。')}</Empty>}
      </SettingsSection>

      <SettingsSection title={t('各项目真实信号')} description={t('交互得分 0.5 为中性；回放用例约 25% 留出，只用于泛化检验。')}>
        {data.projects.length ? (
          <div className="overflow-hidden rounded-lg shadow-[0_0_0_1px_var(--line)]">
            <table className="w-full text-[12px] tabular-nums">
              <thead className="bg-subtle text-left text-fg-4"><tr><th className="px-3 py-1.5 font-medium">{t('项目')}</th><th className="px-3 py-1.5 text-right font-medium">{t('得分')}</th><th className="px-3 py-1.5 text-right font-medium">{t('信号')}</th><th className="px-3 py-1.5 text-right font-medium">{t('回放 · 留出')}</th></tr></thead>
              <tbody className="text-fg-2">
                {data.projects.map(p => (
                  <tr key={p.projectId} className="border-t border-line-faint">
                    <td className="max-w-48 truncate px-3 py-1.5">{projects[p.projectId]?.name ?? t('项目')}</td>
                    <td className="px-3 py-1.5 text-right">{signalScoreDisplay(p.score).value}</td>
                    <td className="px-3 py-1.5 text-right">{p.score.signals}</td>
                    <td className="px-3 py-1.5 text-right">{p.replayCases} · {p.heldOut}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>{t('还没有可汇总的真实项目。')}</Empty>}
        {kinds.length > 0 && <p className="mt-2 text-[12px] leading-[1.7] text-fg-3">{t('信号类型：{list}', { list: kinds.map(([k, n]) => `${signalLabel(k)} ${n}`).join(' · ') })}</p>}
        <p className="mt-1 text-[12px] leading-[1.7] text-fg-3">{t('主动消息结果：回复 {replied} · 采纳 {acted} · 忽略 {dismissed}', { replied: data.proactive.replied ?? 0, acted: data.proactive.acted ?? 0, dismissed: data.proactive.dismissed ?? 0 })}</p>
        {tools.length > 0 && !causes && <p className="mt-1 text-[12px] leading-[1.7] text-fg-3">{t('工具失败：{list}', { list: tools.map(([k, n]) => `${k} ${n}`).join(' · ') })}</p>}
        {tools.length > 0 && causes && (
          <div className="mt-3">
            <p className="mb-1.5 text-[12px] leading-[1.7] text-fg-3">{t('工具失败按原因分开统计。只有“模型调用出错”说明工具的用法说明可能不够清楚，会计入上面的反复出现的问题；外部服务故障、规则拦截和被中断不算。')}</p>
            <div className="overflow-hidden rounded-lg shadow-[0_0_0_1px_var(--line)]">
              <table className="w-full text-[12px] tabular-nums">
                <thead className="bg-subtle text-left text-fg-4"><tr><th className="px-3 py-1.5 font-medium">{t('工具')}</th>{(['call', 'environment', 'refused', 'interrupted'] as const).map(cause => <th key={cause} className="px-3 py-1.5 text-right font-medium">{t(TOOL_FAILURE_CAUSE_LABELS[cause])}</th>)}<th className="px-3 py-1.5 text-right font-medium">{t('最近一次')}</th></tr></thead>
                <tbody className="text-fg-2">
                  {tools.map(([tool, total]) => {
                    const row = causes[tool]
                    return (
                      <tr key={tool} className="border-t border-line-faint">
                        <td className="max-w-56 truncate px-3 py-1.5 font-mono text-[11.5px]">{tool}</td>
                        {(['call', 'environment', 'refused', 'interrupted'] as const).map(cause => <td key={cause} className={cause === 'call' && row?.call ? 'px-3 py-1.5 text-right text-fg' : 'px-3 py-1.5 text-right text-fg-4'}>{row ? row[cause] : cause === 'call' ? total : 0}</td>)}
                        <td className="px-3 py-1.5 text-right text-fg-3">{row?.lastAt ? formatDateTime(row.lastAt) : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t('JEV 判断记录')} description={t('已带真实结果标签的判断可用于校准模板阈值（≥ 5 个标签时出现在候选目标中）。')}>
        {ledger.length ? (
          <Group>{ledger.map(([point, row]) => <ValueRow key={point} label={pointLabel(point, points)} value={t('{decisions} 次判断 · {judged} 次评分 · {labeled} 个标签', { decisions: row.decisions, judged: row.judged, labeled: row.labeled })} />)}</Group>
        ) : <Empty>{t('尚无近期判断记录。')}</Empty>}
      </SettingsSection>

      {failures && (
        <SettingsSection title={t('进化失败分类（全部项目）')} description={t('基础设施失败不说明方法好坏，也不会证伪假设。')}>
          <Group>
            {(['infra', 'author', 'eval'] as const).map(k => <ValueRow key={k} label={FAILURE_CLASSES[k].label} value={failures.byClass[k] ?? 0} />)}
          </Group>
          {Object.keys(failures.byCause).length > 0 && <p className="mt-2 text-[12px] leading-[1.7] text-fg-3">{Object.entries(failures.byCause).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${failureCauseLabel(c)} ${n}`).join(' · ')}</p>}
        </SettingsSection>
      )}

    </>
  )
}
