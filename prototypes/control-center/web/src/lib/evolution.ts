/**
 * Display projections for P4 self-evolution (RRSI): verdicts, component and
 * signal labels, failure classes, the per-version RRSI record and skill
 * foundation screening. Pure, unit tested.
 */
import type { SkillScreening, VersionRecord, VersionRrsi } from '@/api/project-api'
import type { RrsiConfig, TaskType } from '@/api/evolution-api'
import { t as tr, localized } from '@/i18n'

type Tone = 'default' | 'accent' | 'success' | 'warning' | 'danger' | 'muted'

export const TASK_TYPES: { id: TaskType; label: string }[] = localized([
  { id: 'research', label: '调研' }, { id: 'coding', label: '编码' }, { id: 'creative', label: '创作' }, { id: 'design', label: '设计' },
  { id: 'analysis', label: '分析' }, { id: 'writing', label: '写作' }, { id: 'recurring', label: '周期任务' }, { id: 'data', label: '数据' },
])
export const taskTypeLabel = (id: string) => TASK_TYPES.find(t => t.id === id)?.label ?? id

export const COMPONENT_LABELS: Record<string, string> = localized({
  system_section: '系统提示段落', skill: '技能', tool_description: '工具描述', mcp_assignment: 'MCP 分配', rhythm: '节奏', communication_style: '沟通风格', evaluation_standard: '评测标准',
})
export const componentLabel = (key?: string | null) => (key ? COMPONENT_LABELS[key] ?? key : '')

const VERDICTS: Record<string, { label: string; tone: Tone }> = localized({
  accepted: { label: '评测通过', tone: 'accent' },
  trial_adopted: { label: '试用后采用', tone: 'success' },
  trial_rolled_back: { label: '试用后回退', tone: 'warning' },
  rejected: { label: '评测未通过', tone: 'muted' },
  lost: { label: '未胜出', tone: 'muted' },
  critic_rejected: { label: '审查拦下', tone: 'warning' },
  smoke_failed: { label: '冒烟未通过', tone: 'warning' },
  prescreen_skipped: { label: 'JEV 预筛跳过', tone: 'muted' },
  author_failed: { label: '候选生成失败', tone: 'danger' },
  infra_failed: { label: '运行环境失败', tone: 'danger' },
  eval_failed: { label: '评测执行失败', tone: 'danger' },
})
export const verdictDisplay = (verdict?: string | null) => (verdict ? VERDICTS[verdict] ?? { label: verdict, tone: 'default' as Tone } : { label: tr('尚未测量'), tone: 'muted' as Tone })

export const CHANGE_LABELS: Record<string, string> = localized({ added: '新增', removed: '移除', modified: '调整' })

export const formatDelta = (value?: number | null, digits = 3) => (typeof value === 'number' && Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(digits)}` : '—')
export const formatScore = (value?: number | null, digits = 3) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—')

export const SIGNAL_LABELS: Record<string, string> = localized({
  user_correction: '用户纠正', retry: '重试', aborted_turn: '中止的轮次', tool_failure: '工具失败', overlong_turn: '过长轮次', proactive_outcome: '主动消息结果', deliverable: '交付物',
})
export const signalLabel = (kind: string) => SIGNAL_LABELS[kind] ?? kind
/** Neutral 0.5; below means real interactions mostly signal problems. */
export function signalScoreDisplay(score: { score: number | null; signals: number; negatives?: number } | null | undefined) {
  if (!score || score.score === null || !Number.isFinite(score.score)) return { value: '—', label: tr('真实信号不足'), tone: 'muted' as Tone }
  const v = score.score
  return { value: v.toFixed(2), label: v >= 0.6 ? tr('真实交互整体顺利') : v <= 0.4 ? tr('真实交互中问题偏多') : tr('接近中性（0.5）'), tone: (v >= 0.6 ? 'success' : v <= 0.4 ? 'warning' : 'default') as Tone }
}

export const FAILURE_CLASSES: Record<string, { label: string; help: string }> = localized({
  infra: { label: '基础设施', help: '供应商连接、运行环境或服务生命周期问题；不说明方法本身好坏。' },
  author: { label: '候选生成', help: '提议模型没有交付有效候选（输出格式、步数上限、引用未提供的证据等）。' },
  eval: { label: '评测执行', help: '配对执行或盲评裁判没有给出可用测量。' },
})
const CAUSES: Record<string, string> = localized({
  provider_connection: '供应商连接', author_output_format: '候选输出格式', author_step_limit: '候选生成步数上限', author_unsupported_evidence: '引用未提供的证据',
  critic_rejected: '评测前审查拦下', judge_output_schema: '裁判输出结构', eval_execution_step_limit: '评测执行步数上限',
})
export const failureCauseLabel = (cause: string) => CAUSES[cause] ?? (cause.startsWith('interrupted_') ? tr('中断 · {v}', { v: cause.slice(12) }) : cause)

const TIERS: Record<string, string> = localized({ critic: '评测前审查', prescreen: 'JEV 预筛', smoke: '冒烟评测', full: '完整评测' })
const TIER_STATUS: Record<string, { label: string; tone: Tone }> = localized({ passed: { label: '通过', tone: 'success' }, failed: { label: '未通过', tone: 'warning' }, skipped: { label: '跳过', tone: 'muted' } })
const CRITIC_CODES: Record<string, string> = localized({
  no_edit: '没有实际组件变化', budget_exceeded: '超出本轮编辑预算', credential: '疑似包含凭据', case_leakage: '复制了评测用例（针对用例投机）', grader_gaming: '针对评分机制投机',
  unbounded_work: '无退出条件的循环或重试', inert_edit: '声称修改但内容未变', falsified_hypothesis: '重复已被证伪的假设', exploration_required: '停滞期必须尝试未测过的组件',
})

export interface RrsiVersionDisplay {
  round: string
  budget: string
  edits: { key: string; component: string; change: string; hypothesis: string }[]
  overBudget: boolean
  tiers: { tier: string; label: string; status: string; tone: Tone; detail: string }[]
  critic: { verdict: string; reasons: string[] } | null
  prescore: string | null
  selection: { admissible: string; tone: Tone; reason: string; deltas: string } | null
  blend: string
  noise: { calibrated: boolean; label: string }
  screened: boolean
}

/** Version-detail view of `version.rrsi` (plus assessment category). */
export function rrsiVersionDisplay(version: Pick<VersionRecord, 'rrsi' | 'assessment' | 'state'>, config?: Partial<RrsiConfig> | null): RrsiVersionDisplay | null {
  const r: VersionRrsi | null | undefined = version.rrsi
  const screened = version.assessment?.category === 'rrsi_screened'
  if (!r && !screened) return null
  const wReal = config?.wReal ?? 0.8, wJev = config?.wJev ?? 0.2
  const edits = (r?.edits ?? []).map(e => ({ key: e.key, component: componentLabel(e.component), change: CHANGE_LABELS[e.change ?? ''] ?? e.change ?? tr('调整'), hypothesis: e.hypothesis ?? '' }))
  const selection = r?.selection ?? null
  const delta = selection?.delta
  const calibrated = Boolean(selection?.enforced)
  const blended = selection?.blended ?? null
  return {
    round: typeof r?.round === 'number' ? tr('第 {v} 轮', { v: r.round + 1 }) : tr('未记录轮次'),
    budget: typeof r?.editBudget === 'number' ? tr('本轮最多 {editBudget} 个组件编辑', { editBudget: r.editBudget }) : tr('未记录编辑预算'),
    edits,
    overBudget: typeof r?.editBudget === 'number' && edits.length > r.editBudget,
    tiers: (r?.tiers ?? []).map(t => ({
      tier: t.tier, label: TIERS[t.tier] ?? t.tier, status: TIER_STATUS[t.status]?.label ?? t.status, tone: TIER_STATUS[t.status]?.tone ?? 'default',
      detail: [t.reason ? (CRITIC_CODES[t.reason] ?? t.reason) : '', Array.isArray(t.cases) ? tr('{length} 个用例', { length: t.cases.length }) : typeof t.cases === 'number' ? tr('{cases} 个用例', { cases: t.cases }) : ''].filter(Boolean).join(' · '),
    })),
    critic: r?.critic ? { verdict: r.critic.verdict === 'reject' ? tr('拦下') : r.critic.verdict === 'accept' ? tr('通过') : r.critic.verdict ?? tr('未记录'), reasons: (r.critic.reasons ?? []).map(x => CRITIC_CODES[x.code ?? ''] ?? x.message ?? x.code ?? '') .filter(Boolean) } : null,
    prescore: r?.prescore ? (r.prescore.source !== 'judge' || r.prescore.better === null || r.prescore.better === undefined ? tr('JEV 未给出可信先验，照常评测') : r.prescore.better ? tr('JEV 认为可能更好{v}，进入评测', { v: typeof r.prescore.probability === 'number' ? tr('（{v}%）', { v: Math.round(r.prescore.probability * 100) }) : '' }) : tr('JEV 认为不太可能更好，跳过付费评测')) : null,
    selection: selection ? {
      admissible: selection.admissible ? tr('通过选择规则') : tr('未通过选择规则'),
      tone: selection.admissible ? 'success' : 'warning',
      reason: selection.reason ?? '',
      deltas: `ΔS ${formatDelta(selection.deltaS)} · ΔC ${typeof selection.deltaC === 'number' ? `${formatDelta(selection.deltaC * 100, 1)}%` : '—'}${typeof delta === 'number' ? tr(' · 噪声带 δ {v}', { v: delta.toFixed(3) }) : ''}`,
    } : null,
    blend: blended && typeof blended.score === 'number'
      ? tr('混合得分 {v} = {v2} × 真实回放 {v3} + {v4} × JEV {v5}', { v: blended.score.toFixed(3), v2: Math.round((blended.weights?.real ?? wReal) * 100) / 100, v3: formatScore(blended.real), v4: Math.round((blended.weights?.jev ?? wJev) * 100) / 100, v5: formatScore(blended.jev) })
      : tr('得分 = {wReal} × 真实交互/回放 + {wJev} × JEV 对比分；真实用例不足 {v} 个时不产生混合分，以冻结评测为准', { wReal, wJev, v: config?.minRealCases ?? 3 }),
    noise: calibrated
      ? { calibrated: true, label: tr('噪声带已校准{v}，选择规则强制执行', { v: typeof delta === 'number' ? tr('（δ = {v}）', { v: delta.toFixed(3) }) : '' }) }
      : { calibrated: false, label: tr('噪声带尚未校准 · 选择规则仅作参考（advisory until calibrated）') },
    screened,
  }
}

export interface ScreeningDisplay {
  summary: string
  review: string
  areas: { id: string; taskType: string; query: string; total: number; fit: number; reviewFit: number; rejected: number; ambiguous: number; source: string; selected: string[]; gap: string | null }[]
}
const GAPS: Record<string, string> = localized({ screened_out: '候选均被筛掉', no_results: '市场没有结果', unavailable: '市场暂不可用', incompatible: '候选不兼容' })
const SOURCES: Record<string, string> = localized({ judge: 'JEV 快速筛选', fallback: '未启用 JEV · 全部交主模型复核', unavailable: 'JEV 不可用 · 交主模型复核', review: '主模型复核' })

/** `project.skillFoundation.screening` → per-area fit / rejected / ambiguous counts. */
export function screeningDisplay(screening: SkillScreening | null | undefined): ScreeningDisplay | null {
  if (!screening?.areas?.length) return null
  const areas = screening.areas.map(a => {
    const fit = a.fit ?? 0, reviewFit = a.reviewFit ?? 0, rejected = a.rejected ?? 0
    return {
      id: a.id, taskType: taskTypeLabel(a.taskType ?? ''), query: a.query ?? '', total: a.candidates ?? 0, fit, reviewFit, rejected,
      ambiguous: Math.max(0, (a.candidates ?? 0) - fit - reviewFit - rejected),
      source: SOURCES[a.screenSource ?? ''] ?? a.screenSource ?? tr('未记录'),
      selected: (a.selected ?? []).map(s => s.skillId),
      gap: a.gap ? GAPS[a.gap] ?? a.gap : null,
    }
  })
  const total = areas.reduce((n, a) => n + a.total, 0)
  const selected = areas.reduce((n, a) => n + a.selected.length, 0)
  const review = screening.review
  return {
    summary: tr('市场候选 {total} 个 · 入选 {selected} 个 · 任务类型 {v}', { total, selected, v: (screening.taskTypes ?? []).map(taskTypeLabel).join(tr('、')) || tr('自动推断') }),
    review: !review ? tr('没有模糊候选，无需主模型复核') : review.status === 'completed' ? tr('{v} 个模糊候选已由主模型复核', { v: review.candidates ?? 0 }) : review.status === 'failed' ? tr('主模型复核未完成（{v}），模糊候选未入选', { v: review.code ?? tr('未知原因') }) : tr('主模型复核结果无效，模糊候选未入选', {  }),
    areas,
  }
}
