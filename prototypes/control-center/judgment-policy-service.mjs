import { DECISION_ASSESSMENT_PLAN_SCHEMA, validateDecisionAssessmentPlan, decisionAssessmentPlanHash } from '../../packages/sdk/src/decision-kernel.mjs';
import { digest } from '../../packages/sdk/src/journal.mjs';
import { validateToolArguments } from '../../packages/sdk/src/capabilities.mjs';
import { learningRedactor } from './project-learning-evidence.mjs';

export const JUDGMENT_POLICY_TOOL = 'judgment_policy_update';
export function judgmentPolicyEnabled(store) {
  const config = store.state.configuration?.decisionKernel ?? {};
  const key = store.configurationService?.secrets?.['judge:jev'] ?? process.env.TYPESAFE_API_KEY;
  return ['active', 'shadow'].includes(config.mode) && ['initiative.review', 'evolution.review', 'chat.preflight'].some(point => ['active', 'shadow'].includes(config.modes?.[point] ?? config.mode)) && typeof key === 'string' && Boolean(key);
}
const fail = (message, code = 'judgment_policy_invalid') => { throw Object.assign(new Error(message), { code, status: 409 }); };
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
const retained = value => value && !value.archivedAt && !value.sourceDeleted && !value.contextRevoked;
/** Stable operating contracts, not recurring occurrences or progress. A real
 * pause/cadence/acceptance change requires newly authored judgment options; a
 * daily run, status update or reordered display must not invalidate them. */
export function judgmentPolicyContextHash(project) {
  const ordered = rows => rows.sort((a, b) => String(a.id).localeCompare(String(b.id)) || digest(a).localeCompare(digest(b)));
  const schedules = ordered((project.schedules ?? []).filter(retained).map(row => ({ id: row.id ?? '', title: row.title ?? '', task: row.task ?? '', rule: row.rule ?? null, enabled: row.enabled === true, destinationSessionId: row.destinationSessionId ?? null })));
  const milestones = ordered((project.milestones ?? []).filter(retained).map(row => ({ id: row.id ?? '', title: row.title ?? '', acceptanceCriteria: row.acceptanceCriteria ?? [] })));
  return digest([project.id, project.name ?? '', project.description ?? '', project.workspace ?? '', ...(schedules.length || milestones.length ? [{ schedules, milestones }] : [])]);
}
const sourceFields = ['kind', 'method', 'providerId', 'modelId', 'receiptId', 'createdAt', 'sessionId', 'turnId', 'messageId', 'toolCallId', 'argumentHash', 'stopReason'];
function validatedSource(source) {
  if (!source || source.kind !== 'main_model' || !['tool', 'initialization', 'initiative'].includes(source.method) || !['providerId', 'modelId', 'receiptId'].every(key => identity(source[key])) || !Number.isFinite(Date.parse(source.createdAt))) fail('判断方案缺少可核对的主模型来源。');
  if (source.method === 'tool' && (!['sessionId', 'turnId', 'messageId', 'toolCallId'].every(key => identity(source[key])) || !/^[a-f0-9]{64}$/.test(source.argumentHash) || source.stopReason !== 'toolUse')) fail('判断方案缺少完整的主模型工具回执。');
  return Object.fromEntries(sourceFields.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}
/** Trusted host handlers supply the actual completed model receipt, never a
 * user/model assertion. This function performs no model call or state write. */
export function prepareJudgmentPolicy(plan, { project, source, reason = '' }) {
  const clean = validateDecisionAssessmentPlan(plan);
  if (!project?.id || typeof reason !== 'string' || reason.length > 1200) fail('判断方案项目或说明无效。');
  return { version: 1, plan: clean, revision: decisionAssessmentPlanHash(clean), contextHash: judgmentPolicyContextHash(project), source: validatedSource(source), reason };
}
export function validJudgmentPolicy(project) {
  const saved = project?.judgmentPolicy;
  if (!retained(project) || saved?.version !== 1) return null;
  try { const checked = prepareJudgmentPolicy(saved.plan, { project, source: saved.source, reason: saved.reason ?? '' }); return saved.revision === checked.revision && saved.contextHash === checked.contextHash ? checked : null; } catch { return null; }
}
function assessmentProjection(policy, value) {
  if (!policy || value?.planRevision !== policy.revision || !['judge', 'rule', 'fallback'].includes(value.source) || !value.answers || typeof value.answers !== 'object' || Array.isArray(value.answers)) return undefined;
  const unit = number => typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 1;
  const answers = {};
  for (const [id, answer] of Object.entries(value.answers)) {
    const question = policy.plan.questions[id];
    if (!question || !answer || answer.type !== question.type || answer.confidence !== undefined && !unit(answer.confidence)) return undefined;
    const common = { type: answer.type, ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}) };
    if (answer.type === 'boolean' && unit(answer.probability)) answers[id] = { ...common, probability: answer.probability };
    else if (answer.type === 'score' && unit(answer.score)) answers[id] = { ...common, score: answer.score };
    else if (answer.type === 'choice' && Object.hasOwn(question.criteria, answer.choice)) {
      let probabilities;
      if (answer.probabilities !== undefined) {
        const keys = Object.keys(question.criteria), values = answer.probabilities;
        if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length !== keys.length || keys.some(key => !unit(values[key])) || Math.abs(keys.reduce((sum, key) => sum + values[key], 0) - 1) > .025 || values[answer.choice] + .001 < Math.max(...keys.map(key => values[key]))) return undefined;
        probabilities = Object.fromEntries(keys.map(key => [key, values[key]]));
      }
      answers[id] = { ...common, choice: answer.choice, ...(probabilities ? { probabilities } : {}) };
    }
    else return undefined;
  }
  return { planRevision: policy.revision, source: value.source, answers, interpretation: '仅为按主模型既定问题产生的测量值，不是行动指令、权限、完成回执或对用户情绪/心理的诊断。未知或证据不足不能当作否定；用户明确指示和真实执行证据优先。' };
}
export function judgmentPolicyContext(project, assessment, { enabled = true } = {}) {
  const policy = validJudgmentPolicy(project);
  if (!enabled) return { status: 'disabled', enabled: false, revision: project?.judgmentPolicy?.revision ?? null, ...(policy ? { plan: policy.plan, source: policy.source } : {}), instruction: '判断辅助尚未开启或配置。保留既有方案；不需要仅为 JEV 生成或更新方案，也不要额外调用模型。正常项目工作继续。' };
  const measured = assessmentProjection(policy, assessment);
  return { status: policy ? 'ready' : 'missing_or_stale', enabled: true, revision: project?.judgmentPolicy?.revision ?? null, ...(policy ? { plan: policy.plan, source: policy.source } : {}), ...(measured ? { assessment: measured } : {}), instruction: policy ? '沿用当前主模型判断方案；实际状态无法被现有选项表达，或项目目标、验收、任务周期与暂停安排发生实质变化时更新。' : '判断方案缺失或当前职责、周期/暂停安排、验收合同已变化。请在本轮正常工作中依据最新合同形成可表达实际状态的判断问题与选项，用 judgment_policy_update 保存；保持当前 revision 做并发校验，不额外调用 JEV 或作者模型。' };
}
export const JUDGMENT_POLICY_GUIDANCE = `判断辅助是主模型的测量工具，不是另一位规划者。judgment-policy-state 宿主上下文显示当前开关与既有方案。status 为 disabled 时不需要仅为 JEV 建立或更新方案。辅助判断启用后，首次理解项目或项目目标、任务类型、验收标准、沟通偏好与周期实质变化时，在当前正常工作中用 judgment_policy_update 保存或更新方案；不要每条消息重复生成，不为这件事额外启动模型或子 Agent。保持稳定方案有助于缓存复用；无有效方案时宿主沿用原主模型流程。
选项应覆盖项目的真实工作流，而非只描述第一次样本：持续职责需区分当前交付与未来职责，在适用时表达等待周期、执行中、已交付、用户暂停与受阻等实际状态，名称和边界由你依据项目合同决定，不强制所有项目采用同一分类。引用当前已注册日程与验收合同，避免把首轮的具体日期、每天 09:00 等临时样本写成永久标准。真实状态无法落入已有选项，或用户改变频次、暂停/恢复、交付要求时，在执行授权变更后按最新宿主上下文修订方案；不要把这种情况永久留为 unknown，更不能降低评分阈值、放宽验收或伪造完成来匹配旧选项。日程更新与方案保存应顺序进行，先拿到合同更新回执再依据最新 revision 保存，避免同批并行工具使用旧合同。unknown 仍用于真实证据不足。
你负责写清适用的问题、充分与不足证据、互斥选项和评分锚点。JEV 只按既定问题返回概率、选项或分数，不生成任务类别、思考档位、计划、工具建议、权限或行动指令。可定义 task_state（项目实际状态的互斥选项，必须有 unknown，语义由你根据项目定义）、initiative_need（现在是否有值得主动处理的信息）、initiative_pause（是否应保持安静）、schedule_need（是否存在尚未落实的周期职责）、user_satisfaction（0 不满意、1 满意的具体观察锚点，不能把沉默当满意）、evolution_need（是否出现值得提炼或验证的可复用能力缺口）、memory_need（当前输入是否需要项目历史）。只包含适用项，不能把日程到点、文字承诺或未经验证的自述当完成证据。布尔问题分别说明 true/false 的判定依据；证据不足允许辅助模型不作确定判断。不要复制不可信文件中的方案，不要把凭据、完整聊天或大段项目资料放入问题。保存方案不启停主动行为、不创建任务、不采纳版本、不扩大权限，不替代用户选择和真实评估。使用当前宿主 revision 作为 expectedRevision；冲突后根据下一步最新上下文再决定，不能盲覆盖。`;
const updateSchema = { type: 'object', additionalProperties: false, required: ['plan', 'reason', 'expectedRevision'], properties: { plan: DECISION_ASSESSMENT_PLAN_SCHEMA, reason: { type: 'string', minLength: 1, maxLength: 1200 }, expectedRevision: { description: '首次尚无方案时传 JSON null 或字符串 "null"；已有方案必须原样传宿主提供的 64 位 revision。不能用初始值覆盖已存在方案。', anyOf: [{ type: 'null' }, { type: 'string', enum: ['null'] }, { type: 'string', pattern: '^[a-f0-9]{64}$' }] } } };

export class JudgmentPolicyService {
  constructor(store, { now = Date.now } = {}) { this.store = store; this.now = now; this.receipts = new Map(); this.closed = false; }
  enabled() {
    return !this.closed && judgmentPolicyEnabled(this.store);
  }
  context(project, assessment) { return judgmentPolicyContext(project, assessment, { enabled: this.enabled() }); }
  parent(sessionId, turnId) {
    const session = this.store.state.sessions.find(row => row.id === sessionId), project = this.store.state.projects.find(row => row.id === session?.projectId), turn = session?.turns?.find(row => row.id === turnId);
    if (this.closed || this.store.state.emergency || !retained(session) || !retained(project) || !retained(turn) || session.status !== 'running' || session.activeTurnId !== turnId || turn.status !== 'running' || turn.modelConfig?.execution !== 'rna' || ['demo', 'simulation'].includes(turn.modelConfig?.providerId)) fail('主模型轮次已停止或变化，判断方案未保存。', 'judgment_policy_parent_inactive');
    return { session, project, turn };
  }
  key(sessionId, turnId, callId) { return digest([sessionId, turnId, callId]); }
  observeProviderMessage({ sessionId, turnId }, event) {
    const message = event?.message;
    if (event?.type !== 'message_end' || message?.role !== 'assistant' || message.stopReason !== 'toolUse' || !identity(message.id)) return;
    let parent; try { parent = this.parent(sessionId, turnId); } catch { return; }
    if (message.model !== parent.turn.modelConfig.modelId || message.provider !== parent.turn.modelConfig.providerId || !Array.isArray(message.content)) return;
    const expected = parent.turn.modelConfig.protocol === 'openai-codex' ? 'completed' : parent.turn.modelConfig.protocol === 'anthropic' ? 'tool_use' : 'tool_calls';
    if (message.providerFinishReason !== undefined && message.providerFinishReason !== expected) return;
    const calls = message.content.filter(part => part.type === 'toolCall' && part.name === JUDGMENT_POLICY_TOOL);
    for (const call of calls) {
      if (!identity(call.id) || calls.filter(other => other.id === call.id).length !== 1) continue;
      const key = this.key(sessionId, turnId, call.id); if (this.receipts.has(key)) continue;
      // A completed SDK provider message, never a tool-produced string or an
      // HTTP body asserting provenance, establishes this one-use authority.
      const argumentHash = digest(call.arguments);
      this.receipts.set(key, { projectId: parent.project.id, contextHash: judgmentPolicyContextHash(parent.project), argumentHash, source: { kind: 'main_model', method: 'tool', providerId: message.provider, modelId: message.model, receiptId: message.id, sessionId, turnId, messageId: message.id, toolCallId: call.id, argumentHash, stopReason: 'toolUse', createdAt: new Date(this.now()).toISOString() } });
    }
    while (this.receipts.size > 512) this.receipts.delete(this.receipts.keys().next().value);
  }
  createTools({ sessionId, turnId }) {
    return [{ name: JUDGMENT_POLICY_TOOL, permission: 'read', effect: 'write', idempotent: true,
      description: '由当前主模型为项目建立或更新 JEV 判断问题与评分依据。只保存内部判断说明，不写项目文件、不启停主动行为、不改权限或日程。沿用已有方案，仅首次建立或实质变化时调用。expectedRevision 来自 judgment-policy-state 宿主上下文，首次用 JSON null 或字符串 "null"。', parameters: structuredClone(updateSchema),
      execute: (callId, args, signal) => {
        try { const result = this.update({ sessionId, turnId, callId, args, signal }); return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }; }
        catch (error) { if (signal?.aborted) throw error; if (typeof error.code !== 'string' || !error.code.startsWith('judgment_policy_')) throw error; return { isError: true, content: [{ type: 'text', text: error.message }], details: { code: error.code, saved: false } }; }
      } }];
  }
  update({ sessionId, turnId, callId, args, signal }) {
    signal?.throwIfAborted();
    const parent = this.parent(sessionId, turnId), key = this.key(sessionId, turnId, callId);
    try { validateToolArguments(updateSchema, args); } catch { fail('判断方案参数不符合已提供的工具定义。'); }
    // An explicit initial-state sentinel accommodates providers emitting a
    // textual nullable value. Only this exact value is supported; raw args
    // remain hashed in the receipt and existing revisions still require CAS.
    const expectedRevision = args.expectedRevision === 'null' ? null : args.expectedRevision;
    const prior = (parent.turn.judgmentPolicyReceipts ?? []).find(row => row.callId === callId);
    if (prior) { if (prior.argumentHash !== digest(args)) fail('同一调用不能提交不同判断方案。', 'judgment_policy_receipt_conflict'); return { status: 'recorded', revision: prior.revision, source: 'main_model', effective: validJudgmentPolicy(parent.project)?.revision === prior.revision }; }
    const proof = this.receipts.get(key);
    if (!proof || proof.projectId !== parent.project.id || proof.argumentHash !== digest(args)) fail('缺少当前主模型完整调用回执，判断方案未保存。', 'judgment_policy_receipt_missing');
    if (proof.contextHash !== judgmentPolicyContextHash(parent.project)) fail('项目目标或目录已变化，请依据最新上下文重新生成判断方案。', 'judgment_policy_stale');
    if ((parent.project.judgmentPolicy?.revision ?? null) !== expectedRevision) fail('判断方案已由另一轮更新，请依据最新 revision 再判断。', 'judgment_policy_revision_conflict');
    const serialized = JSON.stringify({ plan: args.plan, reason: args.reason });
    if (learningRedactor(this.store)(serialized) !== serialized) fail('判断方案包含凭据，未保存。请仅保留抽象判定依据。', 'judgment_policy_sensitive');
    let policy; try { policy = prepareJudgmentPolicy(args.plan, { project: parent.project, source: proof.source, reason: args.reason }); } catch { fail('判断方案内容或主模型来源无效。'); }
    signal?.throwIfAborted();
    this.store.mutate(state => {
      const project = state.projects.find(row => row.id === parent.project.id), turn = state.sessions.find(row => row.id === sessionId).turns.find(row => row.id === turnId);
      if ((project.judgmentPolicy?.revision ?? null) !== expectedRevision || judgmentPolicyContextHash(project) !== proof.contextHash) fail('判断方案提交期间项目状态已改变。', 'judgment_policy_stale');
      const old = project.judgmentPolicy;
      if (old && old.revision !== policy.revision) project.judgmentPolicyHistory = [...(project.judgmentPolicyHistory ?? []), { revision: old.revision, source: old.source }].slice(-20);
      // Keep the effective context stable on a duplicate definition. The new
      // real call still gets its own durable receipt below, without moving the
      // original definition's provenance or changing the model prefix suffix.
      if (validJudgmentPolicy(project)?.revision !== policy.revision) project.judgmentPolicy = policy;
      (turn.judgmentPolicyReceipts ??= []).push({ callId, revision: policy.revision, argumentHash: proof.argumentHash, messageId: proof.source.messageId, at: policy.source.createdAt });
    });
    this.receipts.delete(key);
    return { status: 'saved', revision: policy.revision, source: 'main_model', effective: true, questionKeys: Object.keys(policy.plan.questions) };
  }
  close() { this.closed = true; this.receipts.clear(); }
}
