import { describe, expect, it } from 'vitest'
import { failureCauseLabel, formatDelta, rrsiVersionDisplay, screeningDisplay, signalScoreDisplay, verdictDisplay } from './evolution'
import { classifyFailures } from '@/mock/p34-routes'

describe('rrsi version display', () => {
  it('is absent without rrsi data', () => {
    expect(rrsiVersionDisplay({ state: 'ready' })).toBeNull()
  })
  it('shows budget, tiers, blend and the advisory noise band until calibrated', () => {
    const d = rrsiVersionDisplay({ state: 'ready', rrsi: {
      round: 2, editBudget: 1,
      edits: [{ key: 'skill:a', component: 'skill', change: 'added', hypothesis: 'h' }, { key: 'rhythm', component: 'rhythm' }],
      tiers: [{ tier: 'critic', status: 'passed' }, { tier: 'smoke', status: 'failed', cases: 3 }],
      prescore: { source: 'judge', better: false },
      selection: { admissible: false, enforced: false, reason: 'r', deltaS: 0.004, deltaC: 0.1, delta: null, blended: { score: null, sufficientReal: false } },
    } })!
    expect(d.round).toBe('第 3 轮')
    expect(d.overBudget).toBe(true)
    expect(d.edits[0]).toMatchObject({ component: '技能', change: '新增' })
    expect(d.tiers.map(t => `${t.label}:${t.status}`)).toEqual(['评测前审查:通过', '冒烟评测:未通过'])
    expect(d.tiers[1].detail).toBe('3 个用例')
    expect(d.prescore).toContain('跳过付费评测')
    expect(d.selection).toMatchObject({ admissible: '未通过选择规则', deltas: 'ΔS +0.004 · ΔC +10.0%' })
    expect(d.blend).toContain('0.8 × 真实交互/回放 + 0.2 × JEV')
    expect(d.noise).toMatchObject({ calibrated: false })
    expect(d.noise.label).toContain('advisory until calibrated')
  })
  it('uses the measured blend and enforced selection', () => {
    const d = rrsiVersionDisplay({ state: 'active', rrsi: { selection: { admissible: true, enforced: true, delta: 0.021, blended: { score: 0.781, real: 0.77, jev: 0.8, weights: { real: 0.8, jev: 0.2 } } } } })!
    expect(d.blend).toBe('混合得分 0.781 = 0.8 × 真实回放 0.770 + 0.2 × JEV 0.800')
    expect(d.noise.label).toContain('δ = 0.021')
  })
  it('flags rrsi_screened from the assessment category', () => {
    expect(rrsiVersionDisplay({ state: 'rejected', assessment: { category: 'rrsi_screened' }, rrsi: { tiers: [{ tier: 'critic', status: 'failed', reason: 'case_leakage' }] } })).toMatchObject({ screened: true, tiers: [{ detail: '复制了评测用例（针对用例投机）' }] })
  })
})

describe('labels', () => {
  it('maps verdicts, deltas, signals and causes', () => {
    expect(verdictDisplay('trial_adopted')).toEqual({ label: '试用后采用', tone: 'success' })
    expect(verdictDisplay(null).label).toBe('尚未测量')
    expect(formatDelta(-0.0451)).toBe('-0.045')
    expect(signalScoreDisplay({ score: null, signals: 0 }).value).toBe('—')
    expect(signalScoreDisplay({ score: 0.3, signals: 4 }).tone).toBe('warning')
    expect(failureCauseLabel('author_output_format')).toBe('候选输出格式')
    expect(failureCauseLabel('interrupted_closed')).toBe('中断 · closed')
  })
})

describe('skill screening', () => {
  it('derives ambiguous counts and review status', () => {
    const d = screeningDisplay({ taskTypes: ['coding'], review: { status: 'completed', candidates: 2 }, areas: [{ id: 'a', taskType: 'coding', candidates: 8, fit: 2, reviewFit: 1, rejected: 4, selected: [{ skillId: 's1' }], screenSource: 'judge' }, { id: 'b', candidates: 0, gap: 'screened_out' }] })!
    expect(d.summary).toBe('市场候选 8 个 · 入选 1 个 · 任务类型 编码')
    expect(d.areas[0]).toMatchObject({ ambiguous: 1, source: 'JEV 快速筛选', selected: ['s1'] })
    expect(d.areas[1].gap).toBe('候选均被筛掉')
    expect(d.review).toBe('2 个模糊候选已由主模型复核')
    expect(screeningDisplay(null)).toBeNull()
  })
})

describe('mock failure classification', () => {
  it('matches the host classes for common shapes', () => {
    const out = classifyFailures([{ id: 'p', versions: [
      { id: 'a', state: 'failed', simulated: false, error: { code: 'invalid_submission', diagnostic: { phase: 'proposal', kind: 'invalid_json' } } },
      { id: 'b', state: 'interrupted', simulated: false, error: { code: 'closed' } },
      { id: 'c', state: 'ready', simulated: false },
    ] }])
    expect(out).toMatchObject({ total: 2, byClass: { author: 1, infra: 1 }, byCause: { author_output_format: 1, closed: 1 }, versionStates: { failed: 1, interrupted: 1, ready: 1 } })
  })
})
