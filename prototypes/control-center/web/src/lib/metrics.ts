/**
 * The §5 "沟通与学习" metrics: definitions (label, unit, which direction is
 * better), value / delta formatting and sparkline geometry. Pure.
 */
import type { MetricKey, MetricPoint, MetricValue, ProjectMetrics } from '@/api/mind-api'
import { localized, t as tr } from '@/i18n'

export type MetricFormat = 'rate' | 'count' | 'duration' | 'ratio'
export interface MetricDef { key: MetricKey; group: 'communication' | 'learning'; label: string; hint: string; format: MetricFormat; better: 'up' | 'down' }

export const METRIC_DEFS: MetricDef[] = localized([
  { key: 'usefulShareRate', group: 'communication', label: '有用分享率', hint: '主动消息中被回复或采纳的比例', format: 'rate', better: 'up' },
  { key: 'ignoreRate', group: 'communication', label: '无反应率', hint: '主动消息在观察窗口内没有得到任何反应的比例', format: 'rate', better: 'down' },
  { key: 'dismissRate', group: 'communication', label: '忽略率', hint: '主动消息被你明确忽略或关闭的比例', format: 'rate', better: 'down' },
  { key: 'longestUnrepliedChain', group: 'communication', label: '最长未回复串', hint: '连续没有得到回应的主动消息条数', format: 'count', better: 'down' },
  { key: 'commitmentResolutionP50Ms', group: 'communication', label: '承诺解决时长 · 中位', hint: '从请求或承诺出现到解决的时间（p50）', format: 'duration', better: 'down' },
  { key: 'commitmentResolutionP90Ms', group: 'communication', label: '承诺解决时长 · p90', hint: '较慢的一成承诺花了多久', format: 'duration', better: 'down' },
  { key: 'correctionsPerTurn', group: 'learning', label: '每轮纠正次数', hint: '平均每轮对话里你纠正 Rna 的次数', format: 'ratio', better: 'down' },
  { key: 'repeatCorrectionRate', group: 'learning', label: '重复纠正率', hint: '同一类抱怨再次出现的比例', format: 'rate', better: 'down' },
  { key: 'firstAttemptAcceptance', group: 'learning', label: '首次交付接受率', hint: '第一次交付就被接受、无需返工的比例', format: 'rate', better: 'up' },
  { key: 'lessonHitRate', group: 'learning', label: '经验命中率', hint: '经验在上下文中、且之后没有被纠正的比例', format: 'rate', better: 'up' },
])

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)

export function formatDurationMs(ms: number): string {
  const min = ms / 60_000
  if (min < 1) return tr('{n} 秒', { n: Math.max(1, Math.round(ms / 1000)) })
  if (min < 60) return tr('{n} 分钟', { n: Math.round(min) })
  const h = min / 60
  if (h < 48) return tr('{n} 小时', { n: h < 10 ? Math.round(h * 10) / 10 : Math.round(h) })
  return tr('{n} 天', { n: Math.round(h / 2.4) / 10 })
}

export function formatMetric(value: number | null | undefined, format: MetricFormat): string {
  if (!finite(value)) return '—'
  switch (format) {
    case 'rate': return `${Math.round(value * 100)}%`
    case 'count': return String(Math.round(value))
    case 'ratio': return value.toFixed(2)
    case 'duration': return formatDurationMs(value)
  }
}

export interface MetricDelta { text: string; direction: 'up' | 'down' | 'flat'; tone: 'good' | 'bad' | 'neutral' }
/** Change vs the previous window: points for rates, relative % for durations, absolute otherwise. */
export function metricDelta(def: Pick<MetricDef, 'format' | 'better'>, value: number | null | undefined, previous: number | null | undefined): MetricDelta | null {
  if (!finite(value) || !finite(previous)) return null
  let diff: number
  let text: string
  if (def.format === 'rate') { diff = Math.round((value - previous) * 100); text = tr('{n} 个百分点', { n: `${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${Math.abs(diff)}` }) }
  else if (def.format === 'duration') { diff = previous ? Math.round((value - previous) / previous * 100) : 0; text = `${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${Math.abs(diff)}%` }
  else if (def.format === 'ratio') { diff = Math.round((value - previous) * 100) / 100; text = `${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${Math.abs(diff).toFixed(2)}` }
  else { diff = Math.round(value - previous); text = `${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${Math.abs(diff)}` }
  const direction = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat'
  const tone = direction === 'flat' ? 'neutral' : direction === def.better ? 'good' : 'bad'
  return { text, direction, tone }
}

export interface SeriesPoint { value: number | null; date: string | null; sample: number | null }
/** Normalize a daily series: K4 sends `{ date, value, sample }`; bare numbers (older mocks / K2) are accepted. */
export function normalizeSeries(series: (MetricPoint | number | null | undefined)[] | undefined): SeriesPoint[] {
  return (series ?? []).map(point => {
    if (point && typeof point === 'object') return { value: finite(point.value) ? point.value : null, date: typeof point.date === 'string' ? point.date : null, sample: finite(point.sample) ? point.sample : null }
    return { value: finite(point) ? point : null, date: null, sample: null }
  })
}

export interface Spark { path: string; points: { x: number; y: number; value: number; index: number }[]; last: { x: number; y: number } | null }
/**
 * Sparkline geometry in a `width × height` box (y grows down) with `pad` inset.
 * Gaps (null) break the line; a flat series sits mid-height.
 */
export function sparkline(series: (MetricPoint | number | null | undefined)[] | undefined, width: number, height: number, pad = 2): Spark {
  const values = normalizeSeries(series).map(p => p.value)
  const known = values.filter(finite)
  if (known.length === 0) return { path: '', points: [], last: null }
  const min = Math.min(...known), max = Math.max(...known)
  const span = max - min
  const n = values.length
  const x = (i: number) => (n === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (n - 1))
  const y = (v: number) => (span === 0 ? height / 2 : pad + (1 - (v - min) / span) * (height - 2 * pad))
  const points = values.flatMap((v, i) => (v === null ? [] : [{ x: round(x(i)), y: round(y(v)), value: v, index: i }]))
  let path = ''
  let prev = -2
  for (const p of points) { path += `${p.index === prev + 1 ? 'L' : 'M'}${p.x} ${p.y}`; prev = p.index }
  const last = points.at(-1) ?? null
  return { path, points, last: last ? { x: last.x, y: last.y } : null }
}
const round = (v: number) => Math.round(v * 100) / 100

export interface MetricRow { def: MetricDef; value: MetricValue | null; display: string; delta: MetricDelta | null }
export function metricRows(metrics: ProjectMetrics | null | undefined): MetricRow[] {
  return METRIC_DEFS.map(def => {
    const value = metrics?.metrics?.[def.key] ?? null
    return { def, value, display: formatMetric(value?.value, def.format), delta: metricDelta(def, value?.value, value?.previous) }
  })
}
