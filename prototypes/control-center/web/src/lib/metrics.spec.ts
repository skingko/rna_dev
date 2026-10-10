import { describe, expect, it } from 'vitest'
import { formatMetric, metricDelta, metricRows, normalizeSeries, sparkline } from './metrics'

describe('metrics formatting', () => {
  it('formats rates, counts, ratios and durations; missing is a dash', () => {
    expect(formatMetric(0.364, 'rate')).toBe('36%')
    expect(formatMetric(3, 'count')).toBe('3')
    expect(formatMetric(0.4812, 'ratio')).toBe('0.48')
    expect(formatMetric(1.9 * 3_600_000, 'duration')).toBe('1.9 小时')
    expect(formatMetric(25 * 60_000, 'duration')).toBe('25 分钟')
    expect(formatMetric(72 * 3_600_000, 'duration')).toBe('3 天')
    expect(formatMetric(null, 'rate')).toBe('—')
    expect(formatMetric(Number.NaN, 'count')).toBe('—')
  })
  it('colors the delta by whether the direction is better, not by sign', () => {
    expect(metricDelta({ format: 'rate', better: 'up' }, 0.36, 0.31)).toEqual({ text: '+5 个百分点', direction: 'up', tone: 'good' })
    expect(metricDelta({ format: 'rate', better: 'down' }, 0.36, 0.31)).toMatchObject({ direction: 'up', tone: 'bad' })
    expect(metricDelta({ format: 'duration', better: 'down' }, 90, 120)).toEqual({ text: '−25%', direction: 'down', tone: 'good' })
    expect(metricDelta({ format: 'count', better: 'down' }, 3, 3)).toEqual({ text: '±0', direction: 'flat', tone: 'neutral' })
    expect(metricDelta({ format: 'ratio', better: 'down' }, 0.48, null)).toBeNull()
  })
  it('builds rows for every defined metric, tolerating a sparse payload', () => {
    const rows = metricRows({ projectId: 'p', window: '7d', metrics: { usefulShareRate: { value: 0.5, previous: 0.4 } } })
    expect(rows).toHaveLength(10)
    expect(rows.find(r => r.def.key === 'usefulShareRate')).toMatchObject({ display: '50%', delta: { tone: 'good' } })
    expect(rows.find(r => r.def.key === 'lessonHitRate')).toMatchObject({ display: '—', delta: null, value: null })
  })
})

describe('sparkline', () => {
  it('maps values into the box with y growing down and breaks on gaps', () => {
    const s = sparkline([0, 1, null, 0.5], 100, 20, 0)
    expect(s.points.map(p => [p.x, p.y])).toEqual([[0, 20], [33.33, 0], [100, 10]])
    expect(s.path).toBe('M0 20L33.33 0M100 10')
    expect(s.last).toEqual({ x: 100, y: 10 })
  })
  it('reads K4 series points ({ date, value, sample }) and bare numbers alike', () => {
    const points = [{ date: '2026-09-26', value: 0, sample: 4 }, { date: '2026-09-27', value: null, sample: 0 }, { date: '2026-09-28', value: 1, sample: 2 }]
    expect(sparkline(points, 100, 20, 0).path).toBe('M0 20M100 0')
    expect(normalizeSeries(points)[2]).toEqual({ value: 1, date: '2026-09-28', sample: 2 })
    expect(normalizeSeries([0.5, null, { value: Number.NaN }])).toEqual([{ value: 0.5, date: null, sample: null }, { value: null, date: null, sample: null }, { value: null, date: null, sample: null }])
    expect(normalizeSeries(undefined)).toEqual([])
  })
  it('centers a flat series and handles empty input', () => {
    expect(sparkline([2, 2], 10, 10, 0).points.map(p => p.y)).toEqual([5, 5])
    expect(sparkline([], 10, 10)).toEqual({ path: '', points: [], last: null })
    expect(sparkline([null, null], 10, 10).last).toBeNull()
  })
})
