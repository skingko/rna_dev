import { describe, expect, it } from 'vitest'
import type { DecisionKernelConfig } from '@/api/panels-types'
import { activeJudge, describedPoints, diagnosticLine, editableSettings, judgeOrder, judgmentDraft, judgmentPayload, percent, pointTitleOf } from './judgment'
import { routeHints } from '@/lib/route-hints'

const config: DecisionKernelConfig = {
  backend: 'typesafe', mode: 'active', apiKeyConfigured: true, status: 'ready',
  modes: { 'turn.route': 'active', 'tool.risk': 'active' },
  fastModel: { providerId: 'glm', modelId: 'glm-air' }, autoModel: false,
  settings: { editable: ['apiKey', 'fastModel', 'autoModel'], judgeOrder: ['typesafe', 'fast_model_llm_judge', 'none'] },
  points: [
    { point: 'chat.route', title: '推理档位（旧）', stake: 'low', legacy: true, builtIn: false, mode: 'off' },
    { point: 'turn.route', title: '每轮路由', stake: 'low', mode: 'active', builtIn: true, supersedes: ['chat.route', 'chat.preflight'] },
    { point: 'tool.risk', title: '工具风险确认', stake: 'high', mode: 'active', builtIn: true },
  ],
}

describe('K2 v2 judgment settings', () => {
  it('hides superseded points and titles the rest from the server', () => {
    expect(describedPoints(config).map(p => p.point)).toEqual(['turn.route', 'tool.risk'])
    expect(pointTitleOf({ point: 'turn.route', title: '每轮路由' })).toBe('每轮路由')
  })
  it('sends only settings.editable keys, never mode/modes/backend/llmModel', () => {
    const draft = judgmentDraft(config)
    expect(draft).toEqual({ apiKey: '', fastModel: 'glm\u0000glm-air', autoModel: false })
    const body = judgmentPayload({ ...draft, apiKey: 'k', autoModel: true }, config)
    expect(body).toEqual({ fastModel: { providerId: 'glm', modelId: 'glm-air' }, autoModel: true, apiKey: 'k' })
    for (const key of ['mode', 'modes', 'backend', 'llmModel']) expect(body).not.toHaveProperty(key)
    expect(judgmentPayload({ ...draft, fastModel: '' }, config).fastModel).toBeNull()
    expect(judgmentPayload({ ...draft, apiKey: 'k' }, { settings: { editable: ['fastModel'] } })).toEqual({ fastModel: { providerId: 'glm', modelId: 'glm-air' } })
    expect([...editableSettings({ settings: { editable: ['apiKey', 'mode', 'autoModel'] } })]).toEqual(['apiKey', 'autoModel'])
  })
  it('reads the legacy llmModel as the fast model', () => {
    expect(judgmentDraft({ llmModel: { providerId: 'p', modelId: 'm' } }).fastModel).toBe('p\u0000m')
  })
  it('marks the judge answering now in the automatic order', () => {
    expect(activeJudge(config)).toBe('typesafe')
    expect(activeJudge({ backend: 'llm', status: 'ready' })).toBe('fast_model')
    expect(activeJudge({ backend: 'typesafe', status: 'not_configured' })).toBe('none')
    expect(activeJudge({ backend: 'off', status: 'off' })).toBe('none')
    expect(judgeOrder({ ...config, backend: 'llm' }).map(s => [s.step, s.active])).toEqual([['typesafe', false], ['fast_model_llm_judge', true], ['none', false]])
    expect(judgeOrder({ status: 'not_configured' }).at(-1)).toMatchObject({ step: 'none', active: true })
  })
  it('describes a diagnostic override', () => {
    expect(diagnosticLine({ diagnosticOverride: null })).toBeNull()
    expect(diagnosticLine({ diagnosticOverride: { env: { backend: 'typesafe', modes: { 'tool.risk': 'shadow' } }, saved: false } })).toContain('RNA_JEV_BACKEND=typesafe · RNA_JEV_MODES=tool.risk=shadow')
    expect(diagnosticLine({ diagnosticOverride: { env: { modes: {} }, saved: true } })).toMatch(/宿主保存/)
  })
  it('formats rates and route hints', () => {
    expect(percent(0.818)).toBe('82%')
    expect(percent(null)).toBe('—')
    expect(routeHints({ skills: ['skill-ui-review'], clarify: true }, { modelTier: 'fast' })).toEqual(['建议：小型快速模型即可完成本轮', '建议技能：ui review', '提示：先向用户澄清'])
  })
})
