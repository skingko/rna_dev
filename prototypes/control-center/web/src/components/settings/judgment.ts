/**
 * JEV (judgment) presentation and PATCH body. Every decision point is built in
 * and active whenever a judge exists; the judge is picked automatically
 * (TypeSafe key → configured fast model → none). The only user settings are
 * the ones the daemon lists in `settings.editable` (`apiKey`, `fastModel`,
 * `autoModel`); `mode` / `modes` / `backend` are never sent.
 */
import type { AssessmentDisplay, DecisionEntry, DecisionKernelConfig, DecisionPointInfo, DecisionStake, JudgmentCredential } from '@/api/panels-types'
import { panelsApi } from '@/api/panels'
import { ApiError } from '@/api/transport'
import { currentLocale, t, localized, translate, type MessageKey } from '@/i18n'

/** Display names for ledger rows (points without a server title). */
export interface PointDef { id: string; name: string; help: string; recent?: boolean; limit?: string }
export const POINTS: PointDef[] = localized([
  { id: 'initiative.review', name: '主动协作', help: '对主模型提出的项目状态、沟通、等待与日程维护选项评分。' },
  { id: 'evolution.review', name: '自进化复盘', help: '对主模型提出的反馈、可复用问题与改进方向选项评分；候选版本仍须独立评估。' },
  { id: 'chat.preflight', name: '对话处理', help: '对主模型提出的当前对话处理选项评分；没有可用选项时沿用主流程。' },
  { id: 'chat.route', name: '推理档位路由', help: '会话推理为「自动」时，为每轮选择思考档位；超时或不可用时按规则与供应商默认。' },
  { id: 'delivery.reach', name: '主动消息触达', help: '主动消息准备投递时，在不高于主模型请求的方式中选择更安静的一种（每日摘要、安静送达、对话内、桌面通知）。你的回复、采纳或忽略会回填为校准标签。', recent: true, limit: '只会降低打扰程度' },
  { id: 'skill.screen', name: '基础技能筛选', help: '项目初始化时，逐个判断技能市场候选是否适合项目任务类型；高置信的直接入选，模糊的交给主模型复核一次。', recent: true, limit: '模糊候选仍由主模型复核' },
  { id: 'candidate.prescore', name: '进化候选预评', help: '对新的进化候选给出「是否可能更好」的先验，只用来决定是否值得花费评测；采用仍取决于真实评测与你的试用。', recent: true, limit: '只决定是否值得评估，不会采纳' },
])

const questionTitles: Record<string, string> = localized({ task_state: '项目状态', initiative_need: '主动协作必要性', initiative_pause: '暂缓主动协作', schedule_need: '日程维护必要性', user_satisfaction: '用户满意度', evolution_need: '自进化必要性', memory_need: '记忆调用必要性', reach_tier: '触达方式', overall_fit: '整体适配度', candidate_better: '候选可能更好', expected_gain: '预期收益',
  // Template questions that get real-outcome labels (decision-calibration-report.mjs), as the calibration panel lists them.
  needs_memory: '需要项目记忆', needs_tools: '需要用工具', clarify_needed: '需要先澄清', stop_background: '要停下后台工作', redirect_background: '要调整后台工作', skill_pick: '选用的技能', reasoning_effort: '推理档位', model_tier: '模型档位',
  needs_main_model: '需要主模型复查', evidence_relevant: '新证据相关', already_reported: '已经告诉过你', likely_action: '可能的下一步', standing: '长期意愿', on_track: '没有跑偏', reasonable_default: '有稳妥的默认做法', essential: '确实需要', addresses_origin: '针对当初的反馈', feedback_worthwhile: '值得听你意见',
  // Work in progress (PDL-2 gate v3) and the internal effort points' one question.
  in_progress_covers: '新情况属于正在进行的工作', depth: '需要的推理深度',
  // The option-B completion gate (D2, shadow): evidence_relevant is the title above.
  reports_untold: '还没告诉过你的发现或问题', names_next_step: '现在就能接着做的下一步' })
export const questionTitle = (key: string) => questionTitles[key] ?? key
/** Calibration lists template question ids: an unknown one reads as 判断项 N, never as the raw id. */
export const questionLabel = (key: string, index: number) => (Object.hasOwn(questionTitles, key) ? questionTitles[key] : t('判断项 {n}', { n: index + 1 }))
const score = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : null)

export function decisionAssessmentDisplay(assessment: AssessmentDisplay = {}) {
  const title = assessment.title || questionTitles[assessment.key ?? ''] || t('主模型判断项')
  if (assessment.type === 'boolean') return { title, label: assessment.optionLabel ? t('“是”选项：{optionLabel}', { optionLabel: assessment.optionLabel }) : t('“是”选项'), value: score(assessment.probability) == null ? t('未报告有效分值') : t('符合该选项的分值 {v}', { v: score(assessment.probability) }) }
  if (assessment.type === 'choice') return { title, label: assessment.optionLabel ? t('选中已有选项：{optionLabel}', { optionLabel: assessment.optionLabel }) : t('未保留所选选项名称'), value: score(assessment.score) == null ? t('未报告该选项分值') : t('选项分值 {v}', { v: score(assessment.score) }) }
  if (assessment.type === 'score') return { title, label: t('按主模型提供的评分标准'), value: score(assessment.score) == null ? t('未报告有效分值') : t('评分 {v} / 1', { v: score(assessment.score) }) }
  return { title, label: t('未记录可展示的评分类型'), value: '' }
}

const reasons: Record<string, string> = localized({ shadow_budget_priority: '已跳过观察评分，将额度留给实际任务', accepted: '已采用选项评分', shadow: '仅记录评分，由主流程决定', duplicate_evidence: '证据没有变化，沿用已有判断', abstain: '评分不足以选择，交回主模型', off: 'JEV 判断模型已关闭', unconfigured: '未配置 JEV 独立密钥', explicit_request: '用户明确请求，直接继续', main_review_required: '有待处理事项，直接进入主模型复查', circuit_open: '评分服务暂时退避，主流程继续', timeout: '选项评分超时，主流程继续', aborted: '本次评分已取消', closed: '评分服务已关闭', invalid_credentials: 'JEV 凭据无效', invalid_request: '评分请求未完成', provider_warning: '评分服务返回警告，保留主流程', connection: '评分连接未完成', auth: '评分凭据失效', payment_required: '评分服务额度不可用', rate_limited: '评分请求受限，保留主流程', missing_plan: '尚无主模型提供的判断选项，沿用主流程', invalid_plan: '主模型判断选项未通过校验，沿用主流程',
  unreachable: '评分服务连不上，主流程继续', server: '评分服务出错，主流程继续', overloaded: '评分服务繁忙，主流程继续', bad_request: '评分请求未完成', invalid_response: '评分服务返回了无法读取的结果', assessment_plan_required: '尚无判断问题，沿用主流程', nothing_actionable: '没有新情况，无需判断',
  plan_paused: '判断为暂缓，等有新情况再看', judged_idle: '判断为暂时没有要做的事', assessment_point_unconfigured: '这个判断点还没有可用的问题', invalid_assessment_plan: '判断问题未通过校验，沿用主流程', redirect_rejected: '评分服务的回应异常，主流程继续', response_limit: '评分结果过大，没有采用',
  // Rows the host writes by rule, without asking the judge: the foreground lease (PDL-2), the reviews it sends straight to
  // the main model (bypass_<signal>), and an internal effort chosen by rule or only recorded.
  foreground_lease: '前台回合进行中，等它结束再复查', bypass_due_schedule: '有日程到期，直接进入主模型复查', bypass_pending_review: '有后台结果待核对，直接进入主模型复查', bypass_unanswered_question: '有问题在等你回答，直接进入主模型复查',
  bypass_delivery_just_completed: '刚完成一项后台工作，直接进入主模型复查', bypass_severe_failure: '有失败需要诊断，直接进入主模型复查', bypass_commitment_overdue: '答应你的事已逾期，直接进入主模型复查',
  rule: '按规则选定推理档位，没有调用判断模型', shadow_routing: '只记录推理档位判断，这次仍用原档位',
  // Rows the host writes for a finished background run (D2, shadow): the route a code fact would give it; the review is made as before.
  completion_schedule_occurrence: '定时任务的结果由宿主自己送达，这样的完成不需要复查（只记录，复查照常）', completion_resolves_pending: '这项工作是在兑现你交代的事，要向你交代结果，需要复查', completion_unreported: '工作者没有留下完成汇报，需要复查', completion_needs_review: '这次运行没有顺利结束，需要核对，需要复查', completion_no_handoff: '工作者没有留下交接，没有可判断的内容，需要复查' })

/** Points that score options from the main model's plan; every other point asks the host's built-in template questions. */
const PLAN_POINTS = new Set(['initiative.review', 'evolution.review', 'chat.preflight'])
export const reasonLabel = (reason?: string, fallback = t('已记录选项评分结果')) => (Object.hasOwn(reasons, reason ?? '') ? reasons[reason!] : fallback)
/** Calibration's unscored reasons in one line: reasons with the same name are added up, and every reason without a
 * name is counted once under 其他原因, last. */
export function unscoredReasonsLine(counts: Record<string, number>) {
  const other = t('其他原因'), named = new Map<string, number>()
  for (const [reason, n] of Object.entries(counts)) { const label = reasonLabel(reason, other); named.set(label, (named.get(label) ?? 0) + n) }
  return [...named].sort(([a], [b]) => Number(a === other) - Number(b === other)).map(([label, n]) => `${label} ${n}`).join(' · ')
}

export function decisionEntryDisplay(entry: DecisionEntry) {
  // Only a plan-based row without its plan revision predates option sources; template rows never carry one.
  const template = Boolean(entry.point && !PLAN_POINTS.has(entry.point))
  const legacy = !template && entry.source === 'judge' && entry.reason === 'accepted' && !entry.planRevision
  return {
    template,
    source: legacy ? t('JEV 历史记录') : ({ judge: template ? t('JEV 判断') : t('JEV 选项评分'), rule: t('系统调度规则'), fallback: t('主流程继续') } as Record<string, string>)[entry.source ?? ''] ?? t('系统记录'),
    reason: legacy ? t('旧版判断记录 · 未保存主模型选项来源') : template && entry.reason === 'accepted' ? t('已采用判断') : reasonLabel(entry.reason),
    // Most template rows record the point itself as disposition (already the title); only real outcomes are shown.
    disposition: ({ deferred: t('暂缓普通复查'), main_review: t('继续主模型复查'), cancelled: t('评分已取消，结果未用于执行'), stale: t('项目状态已变化，结果不再采用'), chat_preflight: t('对话选项评分'), mind_judge: t('经验去重与召回筛选'), mind_reconcile: t('核对待办与承诺') } as Record<string, string>)[entry.disposition ?? ''] ?? '',
  }
}

export const pointName = (point?: string) => POINTS.find(p => p.id === point)?.name ?? t('选项评分')
/** A ledger row's point by the host's title (`config.points`), else the built-in names, never the raw id. */
export function pointLabel(point: string | undefined, points: Pick<DecisionPointInfo, 'point' | 'title'>[] = []) {
  const info = points.find(p => p.point === point)
  return info?.title ? pointTitleOf(info) : POINTS.find(p => p.id === point)?.name ?? (point ? t('其他判断') : t('选项评分'))
}

/** The user-editable judgment settings (`settings.editable`). */
export interface JudgmentDraft {
  apiKey: string
  /** `${providerId}\u0000${modelId}` or '' (the fast model is also the LLM judge). */
  fastModel: string
  /** 自动选择模型 (per-turn fast model switch; default off). */
  autoModel: boolean
}
export type EditableSetting = keyof JudgmentDraft
const DEFAULT_EDITABLE: EditableSetting[] = ['apiKey', 'fastModel', 'autoModel']
/** What this daemon lets the user change (older daemons: the K2 v2 defaults). */
export function editableSettings(config: Pick<DecisionKernelConfig, 'settings'>): Set<EditableSetting> {
  const listed = config.settings?.editable
  return new Set((listed ?? DEFAULT_EDITABLE).filter((key): key is EditableSetting => (DEFAULT_EDITABLE as string[]).includes(key)))
}

const modelKey = (model?: { providerId: string; modelId: string } | null) => (model ? `${model.providerId}\u0000${model.modelId}` : '')
export function judgmentDraft(config: DecisionKernelConfig): JudgmentDraft {
  // `llmModel` is only a legacy alias of the fast model.
  return { apiKey: '', fastModel: modelKey(config.fastModel ?? config.llmModel), autoModel: config.autoModel === true }
}

/** PATCH body: only editable keys; never `mode`, `modes`, `backend` or `llmModel`. */
export function judgmentPayload(draft: JudgmentDraft, config: Pick<DecisionKernelConfig, 'settings'> = {}) {
  const editable = editableSettings(config)
  return {
    ...(editable.has('fastModel') ? { fastModel: fastModelOf(draft.fastModel) } : {}),
    ...(editable.has('autoModel') ? { autoModel: draft.autoModel } : {}),
    ...(editable.has('apiKey') && draft.apiKey ? { apiKey: draft.apiKey } : {}),
  }
}

export type ActiveJudge = 'typesafe' | 'fast_model' | 'none'
/** Which judge answers the built-in points right now (from the daemon's effective backend + status). */
export function activeJudge(config: Pick<DecisionKernelConfig, 'backend' | 'status'>): ActiveJudge {
  if (config.status !== 'ready') return 'none'
  return config.backend === 'typesafe' ? 'typesafe' : config.backend === 'llm' ? 'fast_model' : 'none'
}
const ORDER_TO_JUDGE: Record<string, ActiveJudge> = { typesafe: 'typesafe', fast_model_llm_judge: 'fast_model', none: 'none' }
/** `settings.judgeOrder` (TypeSafe → 快速模型 → 无), each step marked when it is the one answering now. */
export function judgeOrder(config: Pick<DecisionKernelConfig, 'settings' | 'backend' | 'status'>) {
  const active = activeJudge(config)
  return (config.settings?.judgeOrder ?? ['typesafe', 'fast_model_llm_judge', 'none']).map(step => ({ step, judge: ORDER_TO_JUDGE[step] ?? null, active: ORDER_TO_JUDGE[step] === active }))
}
export const JUDGE_LABELS: Record<ActiveJudge, MessageKey> = { typesafe: 'TypeSafe JEV', fast_model: '快速模型', none: '无' }
export const JUDGE_HINTS: Record<ActiveJudge, MessageKey> = { typesafe: '已保存 JEV 独立密钥时使用', fast_model: '没有密钥时，用已选的快速模型按同一模板判断（门槛 +0.1）', none: '都没有时只按节奏与主流程运行' }

/** Diagnostic override set outside the UI (environment / host), described in one line; null when absent. */
export function diagnosticLine(config: Pick<DecisionKernelConfig, 'diagnosticOverride'>): string | null {
  const o = config.diagnosticOverride
  if (!o) return null
  const env = o.env ?? {}
  const parts = [env.mode ? `RNA_JEV_MODE=${env.mode}` : '', env.backend ? `RNA_JEV_BACKEND=${env.backend}` : '', Object.keys(env.modes ?? {}).length ? `RNA_JEV_MODES=${Object.entries(env.modes ?? {}).map(([p, m]) => `${p}=${m}`).join(',')}` : ''].filter(Boolean)
  return parts.length ? t('诊断覆盖生效中（环境变量，只读）：{v}', { v: parts.join(' · ') }) : o.saved ? t('诊断覆盖生效中（宿主保存的诊断配置，只读）。') : null
}

export type { JudgmentCredential }
/** Whether the saved TypeSafe key works (host `credential`; absent on older daemons). */
export const credentialOf = (config: DecisionKernelConfig) => config.credential ?? null

/** `unchecked`: the check ran but says nothing about the key (no TypeSafe judge to ask, or JEV answered with another error). */
export type KeyCheck = JudgmentCredential['state'] | 'unreachable' | 'unsupported' | 'unchecked'
/** One minimal JEV call right after a key is saved (JEV is cheap): the host asks it and marks the key. */
export async function checkJudgmentKey(): Promise<KeyCheck> {
  try {
    const out = await panelsApi.checkJudgmentKey()
    const state = out.credential?.state
    return state && state !== 'unverified' ? state : out.status === 401 || out.status === 403 ? 'invalid' : out.status === 402 ? 'payment_required' : out.status >= 200 && out.status < 300 ? 'valid' : 'unchecked'
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0
    // An older daemon rejects the check body (400) or has no probe route.
    if ([400, 404, 405].includes(status)) return 'unsupported'
    // Only a JEV the host could not reach (502), or no answer from the host at all, means "can't reach JEV";
    // 409 means there is no TypeSafe judge to ask (the fast model judges).
    return status === 502 || status === 0 ? 'unreachable' : 'unchecked'
  }
}
export function keyCheckStatus(check: KeyCheck): { text: string; tone: 'default' | 'saved' | 'error' } {
  if (check === 'valid') return { text: t('已保存 JEV 设置 · 密钥可用'), tone: 'saved' }
  if (check === 'invalid') return { text: t('已保存，但 JEV 拒绝了这个密钥。请检查后重新粘贴。'), tone: 'error' }
  if (check === 'payment_required') return { text: t('已保存，但这个 JEV 账户的额度不可用。'), tone: 'error' }
  if (check === 'unreachable') return { text: t('已保存 JEV 设置 · 暂时连不上 JEV，下一次判断时再确认密钥。'), tone: 'default' }
  return { text: t('已保存 JEV 设置'), tone: 'saved' }
}

export function judgmentStatus(config: DecisionKernelConfig) {
  const counters = t('{v} 次请求 · {v2} 次复用 · {v3} 次回退', { v: config.metrics?.requests ?? 0, v2: config.metrics?.cacheHits ?? 0, v3: config.metrics?.fallbacks ?? 0 })
  const judge = activeJudge(config), credential = credentialOf(config)?.state
  // A refused key still reads as configured: every judgment falls back until it is replaced.
  if (judge === 'typesafe' && credential === 'invalid') return { tone: 'danger' as const, text: t('JEV 密钥无效：TypeSafe 拒绝了已保存的密钥，判断点都在回退，主动消息只按节奏送达。请在下方「JEV 独立 API Key」重新粘贴有效的密钥。') }
  if (judge === 'typesafe' && credential === 'payment_required') return { tone: 'warning' as const, text: t('JEV 额度不可用：TypeSafe 账户需要充值或升级，判断点都在回退。处理后不用重新保存，下一次判断成功就会恢复。') }
  if (judge === 'typesafe') return { tone: 'success' as const, text: t('判断点均已内置启用 · TypeSafe JEV · {counters}', { counters }) }
  if (judge === 'fast_model') return { tone: 'success' as const, text: t('判断点均已内置启用 · 使用快速模型判断 · {counters}', { counters }) }
  return { tone: 'default' as const, text: t('尚未配置判断：保存 JEV 密钥或选择快速模型后自动启用。在此之前主动消息只按节奏送达，主模型继续负责判断与执行。') }
}

/* ------------------------------------------------ H5 decision points */

const fastModelOf = (value: string) => { const [providerId, modelId] = value.split('\u0000'); return providerId && modelId ? { providerId, modelId } : null }

export const STAKE_LABELS: Record<DecisionStake, MessageKey> = { low: '低影响', medium: '中影响', high: '高影响' }
/** Readable purpose per point (the server's `effect` is an English engineering summary). */
const POINT_EFFECTS: Record<string, string> = localized({
  'turn.route': '每轮一次判断：推理档位、是否跳过记忆召回，以及技能、后台停止/改向、先澄清等尾部提示。替代旧的推理档位与记忆预判。',
  'chat.route': '旧版推理档位路由，已由「每轮路由」取代。',
  'chat.preflight': '旧版记忆预判，已由「每轮路由」取代。',
  'initiative.review': '依据主模型计划决定是否推迟后台复核（有界推迟）。',
  'initiative.gate': '宿主提出的原子问题决定唤醒还是等待，随后台复核同一请求（有界推迟）。',
  'work.coverage': '后台想做一项工作时，先判断它是不是在重复刚做过（或正在做）的检查：同一处、同样的文件和行为都已经查过，之后也没有相关变化，就不再开跑，下一次决策会知道原因；有任何不确定都照常开跑。',
  'work.completion': '后台工作做完后，判断它引发的那次主模型复查能不能省掉：交接里没有还没告诉你的问题，也没有现在就能开始的下一步。目前只记录、不拦截，复查照常进行；之后与复查实际带来的结果对照（./rna judge completion）。',
  'evolution.review': '推迟一次进化复核（有界推迟）。',
  'delivery.reach': '把主动消息的触达方式调得更安静，只降不升。',
  'message.check': '按写作规范与项目类型检查主动消息；有问题时由 Agent 自己改写一次。',
  'message.value': '判断主动消息是新信息还是已说过、延续哪个话题、此刻是否相关或紧急；发送、暂存、收件箱或丢弃由代码结合沟通节奏决定。',
  'mind.judge': '经验去重与取代、筛选召回的经验、结清待完成的承诺；经验在进化页的画像里查看与撤销，逾期的承诺会在对话里问你。',
  'initiative.direct': '后台结论里只有明确、客观的错误（错字、人名数字不一致、记录失真）时，直接修正并在对话里让你确认保留或一键回退；创作、风格和方向上的选择仍然先问你。',
  'turn.settled': '每轮结束时判断你交代的事做完没有：没做完、也不缺你的信息，就接着做完，不用你再说一遍“继续”；只是为了拖到以后才建的日程会撤掉；回复里有值得听你意见的取舍时，才在输入框上方轻轻问一句。',
  'gene.route': '记下一条经验后判断它该变成什么：能用程序检查的约束变成写文件后自动运行的守卫，改变做法的写进技能，其余只留在画像里。',
  'gene.review': '新基因进入项目前的复审：是否针对当初的反馈、是否只改一处、与现有基因是否冲突、给你看的那句话是否属实。',
  'feedback.signal': '你给回复写的评价：是以后都要照做的长期意愿，还是只针对这一条；前者记成经验并判断类别（偏好、约束、易错点、好做法），后者只留在这条回复上。',
  'guard.triage': '自动检查发现命中时，逐处判断是真问题还是误报；只有很确定是误报的才不交给模型处理。误报多于真命中的检查会退回试用。',
  'turn.review': '你纠正了一次回复后，判断这是不是会反复出现的做法问题、现有做法里有没有覆盖；是才花一次模型调用，把它写成技能里的一条做法，先试用。',
  'invite.stale': '你离开一天以上回来时，把还没回答的确认类邀请再判一次：对话已经说清或已经没必要问的，就收起来。',
  'standard.link': '新的自动检查加入时，判断它在验证项目的哪一条验收标准，在进化页标出来。',
  'gene.consolidate': '新增一条做法或自动检查前，先和同类的已有条目比一比：讲的是新东西就新增；和某一条讲的是同一件事、又有补充，就把那一条改写成包含新内容的一条（旧的退下，改写没通过试用会恢复）；只是换个说法重复，就不再新增。',
  'skill.retire': '一个月没用过的技能、运行很多次从没发现问题的检查，先判断按最近的工作是否确实不再需要；很确定才在输入框上方问你要不要停用。',
  'answer.match': '你没点选择卡、直接在输入框里回答时，判断这条消息是否回答了卡上的每个问题；很确定才把卡标为已答，模型不会再问一遍。权限申请从不这样处理。',
  'lesson.applied': '每次回复后，判断召回的经验里哪些这次真的照做了；只有照做的才算“用过”。你反馈形成的经验第一次被照做时，回复下方会有一行很轻的说明，之后不再重复。',
  'diagnostics.delivery': '改完代码后宿主会跑一遍诊断：错误一律交给模型修；警告只有判断为可能出问题、影响你的需求时才交给模型，风格类的不打扰。',
  'schedule.suggest': '你连续几天都让它做同一件事时，判断这是不是固定要做的事；是的话在输入框上方问你要不要每天自动做，从不擅自创建。',
  'tool.constraint': '写文件之前，判断这次写入会不会违反你说过的约束；很确定会违反才拦下，并告诉模型原因让它改。同一个文件被拦两次后放行，由模型说明理由。',
  'turn.drift': '长任务每做几步，判断最近的步骤还在不在为你的请求服务；明显跑偏时把请求重新摆到模型面前。',
  'turn.rewind': '同一个失败连续出现三次，判断这条路是不是走不通；很确定是死路时，把从第一次失败起改过的文件恢复原样，并让模型换一种做法。',
  'plan.better': '后台想提议换一种做法时，判断你选的做法是否确实明显更差；很确定不更差就不打扰你。',
  'commitment.due': '你交代但还没完成的事，按对话里的情况判断是否该推进或说明进度，不再只按固定四小时。',
  'share.resolved': '你回复了一条主动消息后，判断这个话题是否已经结束；很确定结束就收起来，不再追问。',
  'reply.target': '你发来的消息可能是在回复最近的某条主动消息时，判断回复的是哪一条（或都不是，或是在回复最近一次普通回复）；回复只算给被回复的那一条，进化也把纠正记给它真正针对的那一轮或那次后台运行。',
  'attention.now': '你正在连续对话、专注做事时，不急的主动消息先放着，等自然停顿再说。',
  'evidence.select': '学习复盘前先看这批对话片段里哪些真有可学的（出错、被你纠正、反复卡住、被你夸），平平常常的片段直接略过，复盘更省也更勤。',
  'context.forget': '对话隔了很久再继续（缓存已失效）、或长任务上下文快满时，先判断哪些早先的工具结果已经被后面的工作取代（比如文件读过又改写了），换成一行占位；不够再写摘要，细节丢得更少。',
  'session.resume': '空闲的对话在后台整理成摘要之前，判断你会不会回来继续；目前只记录、不拦截，用来校准（之后 7 天内你回来过就算“回来了”）。',
  'effort.decision': '后台每次做主动决策前，按这次唤醒的情况选推理强度，不超过对话档位：没有新情况、也没有待处理的事时用最低档；有待办请求、要写计划或复盘失败时用最高档；其余由判断决定。智谱 GLM 等默认即最高档的模型目前只记录、仍按原档位发送。',
  'effort.work': '后台工作和子任务开始前，按任务内容选推理强度，不超过对话档位：只读核对用低档，内容已说清的修改用中档，需要创作、设计或查原因的用最高档。智谱 GLM 等目前只记录，等后台工作专门的回放验证之后才生效。',
  'effort.narrator': '主动消息被检查标出问题、由助手自己改写时，按标出的问题选推理强度：删改措辞用低档，调整顺序用中档，需要判断取舍时用最高档。智谱 GLM 等目前只记录。',
  'effort.setup': '项目初始化时按项目描述选推理强度；目前只记录，等专门的验证之后才生效。',
  'effort.compaction': '整理长对话的摘要时，按历史的多少和内容选推理强度；目前只记录，等专门的验证之后才生效。',
  'capability.disclosure': '新对话开始时，判断项目里的哪些外部工具服务这次明显用不上，先收进按需加载器（照样能用）；一旦用到，下一轮就重新直接带上。',
  'notes.worth': '定期整理关于你的笔记前，先判断最近的消息里有没有新的个人情况或明确偏好；没有就跳过这次整理，省一次模型调用。',
  'ask.necessity': '模型想弹出选择卡问你时，先判断有没有稳妥、以后容易改的默认选项；有就直接按默认做下去，并用一句话说明选了什么，你随时可以改。权限申请从不跳过。',
  'input.interjection': '回复还在写时你又发来消息：如果这条消息改变或取消了正在写的内容，就立刻停下按你说的来，否则等这一步写完再接上。',
  'tool.admission': '工具输出太长时，完整内容另存，只留开头和结尾；这里在后台判断被省略的部分哪些真正需要，先只记录不生效，用于校准。',
  'memory.filter': '丢弃判定为无关的召回段落；超时则保留全部。',
  'skill.screen': '在主模型复核前，对技能市场候选判定适合 / 拒绝。',
  'candidate.prescore': '判断进化候选是否值得付费评测；永远不会直接采纳。',
  'tool.risk': '完全权限下的高风险调用先请你确认；从不放宽权限。',
})
export const pointTitleOf = (info: Pick<DecisionPointInfo, 'point' | 'title'>) => (info.title ? translate(currentLocale(), info.title as MessageKey) : pointName(info.point))
/** Effort points the routing setting can switch on (`./rna effort routing route`): on GLM-like models they then send. */
const ROUTED_EFFECTS: Record<string, string> = localized({
  'effort.decision': '后台每次做主动决策前，按这次唤醒的情况选推理强度，不超过对话档位：没有新情况、也没有待处理的事时用最低档；有待办请求、要写计划或复盘失败时用最高档；其余由判断决定。付费回放验证通过后已开启：智谱 GLM 等默认即最高档的模型也按所选档位发送。',
  'effort.narrator': '主动消息被检查标出问题、由助手自己改写时，按标出的问题选推理强度：删改措辞用低档，调整顺序用中档，需要判断取舍时用最高档。付费回放验证通过后已开启：智谱 GLM 等也按所选档位发送。',
})
/** The internal-reasoning setting a point's effect text depends on (configuration.internalReasoning). */
export interface EffortRouting { routing?: 'shadow' | 'route'; purposes?: string[] }
/** A point's readable purpose; the routable effort points say whether GLM-like models send the chosen effort now. */
export const pointEffectOf = (info: Pick<DecisionPointInfo, 'point' | 'effect'>, internal?: EffortRouting | null) => {
  const purpose = info.point.startsWith('effort.') ? info.point.slice('effort.'.length) : null
  const routed = Boolean(purpose && internal?.routing === 'route' && (internal.purposes ?? ['decision', 'narrator']).includes(purpose))
  return (routed ? ROUTED_EFFECTS[info.point] : undefined) ?? POINT_EFFECTS[info.point] ?? info.effect ?? ''
}

/** Visible points: superseded (legacy) points are not shown at all. */
export function describedPoints(config: DecisionKernelConfig): DecisionPointInfo[] {
  return (config.points ?? []).filter(p => !p.legacy && p.builtIn !== false)
}

export const percent = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—')
