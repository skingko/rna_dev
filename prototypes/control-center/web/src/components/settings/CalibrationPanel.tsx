/**
 * JEV calibration (`GET /api/v2/decision-kernel/calibration?point=&window=`):
 * savings tiles plus a per-question reliability diagram (predicted probability
 * vs observed frequency; the diagonal is perfect calibration) with a table view.
 * Read-only: thresholds change only through code review.
 */
import { useEffect, useMemo, useState } from 'react'
import { panelsApi } from '@/api/panels'
import { ApiError } from '@/api/transport'
import type { CalibrationBucket, CalibrationReport, CalibrationWindow, DecisionKernelConfig } from '@/api/panels-types'
import { SegmentedTabs, Skeleton } from '@/components/ui/primitives'
import { useT } from '@/i18n'
import { Disclosure, Empty, Note, Select, SettingsSection } from './form'
import { describedPoints, percent, pointTitleOf, questionLabel, unscoredReasonsLine } from './judgment'

const WINDOWS: CalibrationWindow[] = ['24h', '7d', '30d', 'all']
const fixed = (value: number | null | undefined, digits = 2) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—')

export function CalibrationPanel({ config }: { config: DecisionKernelConfig }) {
  const t = useT()
  const [window, setWindow] = useState<CalibrationWindow>('7d')
  const [point, setPoint] = useState<string>('')
  const [report, setReport] = useState<CalibrationReport | null | 'unsupported'>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setError(null)
    panelsApi.calibration(point || null, window).then(next => { if (live) setReport(next) }).catch(e => {
      if (!live) return
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) setReport('unsupported')
      else setError((e as Error).message)
    })
    return () => { live = false }
  }, [point, window])
  if (report === 'unsupported') return null
  const points = describedPoints(config)
  const windowLabel: Record<CalibrationWindow, string> = { '24h': t('24 小时'), '7d': t('7 天'), '30d': t('30 天'), all: t('全部') }
  return (
    <SettingsSection title={t('校准与节省')} description={t('用真实结果回填后，检查 JEV 的概率是否可信，以及它省下了多少主模型调用。门槛只随代码评审调整。')}
      action={<SegmentedTabs<CalibrationWindow> layoutId="calibration-window" value={window} onChange={setWindow} className="rounded-lg bg-subtle p-0.5" items={WINDOWS.map(id => ({ id, label: windowLabel[id] }))} />}>
      <div className="mb-3 max-w-72">
        <Select aria-label={t('决策点')} value={point} onChange={setPoint} options={[{ value: '', label: t('全部决策点') }, ...points.map(p => ({ value: p.point, label: pointTitleOf(p) }))]} />
      </div>
      {error && <Note tone="danger">{t('校准数据读取失败：{error}', { error })}</Note>}
      {!report ? <Skeleton className="h-40 w-full rounded-xl" /> : report.decisions === 0 ? <Empty>{t('这个时间范围内还没有判断记录。')}</Empty> : <ReportBody report={report} />}
    </SettingsSection>
  )
}

function ReportBody({ report }: { report: CalibrationReport }) {
  const t = useT()
  const questions = useMemo(() => Object.entries(report.questions ?? {}).filter(([, q]) => q.buckets?.length), [report.questions])
  const [question, setQuestion] = useState('')
  const current = questions.find(([key]) => key === question) ?? questions[0]
  const label = (key: string) => questionLabel(key, questions.findIndex(([id]) => id === key))
  const tiles: [string, string][] = [
    [t('判断次数'), String(report.decisions)],
    [t('覆盖率'), percent(report.coverage)],
    [t('弃权率'), percent(report.abstainRate)],
    [t('已标注结果'), String(report.labeled)],
    [t('省去主模型调用'), String(report.savings?.mainModelCalls ?? 0)],
    [t('省去辅助调用'), String(report.savings?.auxiliaryCalls ?? 0)],
    [t('延迟 p50 / p95'), report.latency ? `${report.latency.p50 ?? '—'} / ${report.latency.p95 ?? '—'} ms` : '—'],
    ['tokens', (report.tokens ?? 0).toLocaleString()],
  ]
  return (
    <div className="space-y-4" data-calibration-report>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-xl bg-subtle px-3 py-2.5">
            <dt className="text-[11.5px] text-fg-3">{label}</dt>
            <dd className="mt-0.5 text-[15px] font-semibold tabular-nums text-fg">{value}</dd>
          </div>
        ))}
      </dl>
      {current ? (
        <div className="rounded-xl p-3 shadow-[inset_0_0_0_1px_var(--line)]">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <strong className="text-[13px] font-medium text-fg">{t('可靠性')}</strong>
            {questions.length > 1 && (
              <Select aria-label={t('判断问题')} value={current[0]} onChange={setQuestion} className="h-8 w-56 text-[12.5px]" options={questions.map(([key]) => ({ value: key, label: label(key) }))} />
            )}
            {questions.length === 1 && <span className="text-[12.5px] text-fg-3">{label(current[0])}</span>}
            <span className="ml-auto text-[12px] tabular-nums text-fg-3">{t('Brier {brier} · 已标注 {labeled} / {n}', { brier: fixed(current[1].brier, 3), labeled: current[1].labeled, n: current[1].n })}</span>
          </div>
          <ReliabilityChart buckets={current[1].buckets} label={label(current[0])} />
          <Disclosure summary={t('表格视图')} className="mt-1">
            <table className="w-full text-[12px] tabular-nums">
              <thead className="text-left text-fg-4"><tr><th className="py-1 font-medium">{t('区间')}</th><th className="py-1 text-right font-medium">n</th><th className="py-1 text-right font-medium">{t('预测')}</th><th className="py-1 text-right font-medium">{t('实际')}</th></tr></thead>
              <tbody className="text-fg-2">
                {current[1].buckets.map(b => <tr key={b.range.join('-')} className="border-t border-line-faint"><td className="py-1">{b.range[0].toFixed(1)}–{b.range[1].toFixed(1)}</td><td className="py-1 text-right">{b.n}</td><td className="py-1 text-right">{fixed(b.predicted)}</td><td className="py-1 text-right">{fixed(b.observed)}</td></tr>)}
              </tbody>
            </table>
          </Disclosure>
        </div>
      ) : <Note>{t('还没有带真实结果标签的判断问题；有标签后会显示可靠性图。消息检查、召回筛选与技能筛选暂无客观标签，只统计覆盖率与节省。')}</Note>}
      {report.unscoredReasons && Object.keys(report.unscoredReasons).length > 0 && (
        <p className="text-[12px] text-fg-4">{t('未评分原因：{list}', { list: unscoredReasonsLine(report.unscoredReasons) })}</p>
      )}
    </div>
  )
}

/** Predicted (x) vs observed (y) per probability bucket; dot area ∝ sample size; diagonal = perfect calibration. */
export function ReliabilityChart({ buckets, label }: { buckets: CalibrationBucket[]; label: string }) {
  const t = useT()
  const [hover, setHover] = useState<CalibrationBucket | null>(null)
  const size = 232, padL = 44, pad = 16, padB = 34, inner = size - padL - pad
  const x = (v: number) => padL + v * inner
  const y = (v: number) => size - padB - v * inner
  const maxN = Math.max(1, ...buckets.map(b => b.n))
  const points = buckets.filter(b => typeof b.predicted === 'number' && typeof b.observed === 'number')
  return (
    <div className="relative flex flex-wrap items-start gap-4">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={t('{label} 的可靠性图：横轴为预测概率，纵轴为实际比例', { label })} className="shrink-0 text-fg-4">
        {[0, 0.25, 0.5, 0.75, 1].map(v => (
          <g key={v}>
            <line x1={x(0)} x2={x(1)} y1={y(v)} y2={y(v)} stroke="var(--line-faint)" strokeWidth={1} />
            <text x={padL - 6} y={y(v) + 3} textAnchor="end" fontSize={9} fill="currentColor">{v}</text>
            <text x={x(v)} y={size - padB + 13} textAnchor="middle" fontSize={9} fill="currentColor">{v}</text>
          </g>
        ))}
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--line-strong)" strokeWidth={1.5} strokeDasharray="4 4" />
        {points.map(b => {
          const r = 4 + 6 * Math.sqrt(b.n / maxN)
          return (
            <g key={b.range.join('-')} onMouseEnter={() => setHover(b)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(b)} onBlur={() => setHover(null)} tabIndex={0} aria-label={t('预测 {p}，实际 {o}，{n} 次', { p: fixed(b.predicted), o: fixed(b.observed), n: b.n })}>
              <circle cx={x(b.predicted!)} cy={y(b.observed!)} r={r + 8} fill="transparent" />
              <circle cx={x(b.predicted!)} cy={y(b.observed!)} r={r} fill="var(--accent)" fillOpacity={0.85} stroke="var(--bg-elevated)" strokeWidth={2} />
            </g>
          )
        })}
        <text x={x(0.5)} y={size - 6} textAnchor="middle" fontSize={9.5} fill="currentColor">{t('预测概率')}</text>
        <text x={11} y={y(0.5)} textAnchor="middle" fontSize={9.5} fill="currentColor" transform={`rotate(-90 11 ${y(0.5)})`}>{t('实际比例')}</text>
      </svg>
      <div className="min-w-40 flex-1 text-[12px] leading-[1.6] text-fg-3">
        <p>{t('越靠近虚线，概率越可信；点越大，样本越多。')}</p>
        <p className="mt-2 min-h-[3.2em] tabular-nums text-fg-2" aria-live="polite">
          {hover ? t('区间 {range}：预测 {p}，实际 {o}（{n} 次）', { range: `${hover.range[0].toFixed(1)}–${hover.range[1].toFixed(1)}`, p: fixed(hover.predicted), o: fixed(hover.observed), n: hover.n }) : t('悬停或聚焦一个点查看数值。')}
        </p>
      </div>
    </div>
  )
}
