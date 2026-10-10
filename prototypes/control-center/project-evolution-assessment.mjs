/** Read-only presentation of immutable evaluation evidence, including old records.
 * This projection never changes acceptance gates, scores, or published state. */
import { standardOnlyBaselineChange, standardAdoptionAvailable } from './project-standard-lineage.mjs';
import { describeProjectEvaluationCase } from '../../packages/sdk/src/project-evaluation-contract.mjs';
import { PROJECT_EVALUATION_RUNTIME_HASH } from '../../packages/sdk/src/project-evolution.mjs';
const labels = {
  source_deleted: '来源会话已删除', standards_review: '修订基准对照已通过',
  ready: '评估通过', pending: '评估进行中', candidate_invalid: '候选脚本未通过',
  contract_incompatible: '兼容检查未通过', quality_rejected: '效果门槛未达到',
  baseline_blocked: '基线检查阻塞', evaluation_error: '评估未完成',
  proposal_error: '候选生成未完成', budget_blocked: '评估额度不足',
  interrupted: '评估已中断', stale: '评估基线已变化', unassessed: '未进行候选评估',
  no_change: '本轮无需变更', rrsi_screened: '进化筛选未通过',
};
// P4 RRSI gates: rejected before or after evaluation without being a failure.
const RRSI_SUMMARIES = { critic_rejected: '评测前审查发现针对用例的投机、无效编辑、超出编辑预算或重复已被证伪的假设，未花费评测。', prescreen_skipped: 'JEV 先验判断此候选不值得评测，已跳过付费评测；JEV 不能单独采用候选。', smoke_failed: '少量用例的冒烟评测未通过，未进入完整评测。', selection: '通过了冻结门槛，但提升未超过噪声带或新增用量未被收益覆盖（RRSI 选择规则）。' };
const checkLabels = { scripts: '脚本检查', deterministicCases: '任务行为检查', artifacts: '实际产物检查', domain: '任务协议与来源检查', environment: '浏览器实际交互', confirmation: '独立确认', minimumScore: '最低质量分', improvement: '改进幅度', noRegression: '逐项无退化', tokenRatio: '用量比例', completed: '完整回答', requiredTerms: '必需内容', forbiddenTerms: '禁止内容', requiredTools: '必需工具', toolErrors: '工具执行', noUncertainTools: '工具执行确定性' };
const diagnosticLabels = { output_truncated: '模型输出达到长度上限，结果被截断。', empty_response: '模型没有返回最终正文。', invalid_json: '模型返回的 JSON 不符合评估结构。', invalid_judge: '裁判没有准确评分全部冻结指标。', step_limit: '评估执行达到步骤上限，尚未完成。', provider_error: '模型请求失败，需要检查供应商连接与配置。', provider_termination: '模型服务返回了异常或不支持的结束状态，未将其作为完整结果继续评估。', provider_protocol: '模型响应中的工具调用或结束信息不完整，未执行相关工具。', http_error: '模型服务拒绝请求，需要检查状态码与配置。', incomplete_stream: '模型响应流意外结束。', total_timeout: '模型请求超过整体时限。', idle_timeout: '模型响应长时间没有继续传输。' };
const rows = value => Array.isArray(value) ? value : value?.results ?? [];
Object.assign(diagnosticLabels, { environment_unavailable: '浏览器评测环境尚不可用，尚未完成质量判断。', environment_timeout: '浏览器评测运行超时，已保留此前执行证据。', environment_receipt_limit: '浏览器评测证据超过保留上限，结果尚未完成。', evaluation_artifact_directory_invalid: '浏览器评测证据保存位置不可用，未生成完整评估结果。', evaluation_confirmation_claim_required: '独立确认的持久保留记录尚不可用，未读取确认用例。', evaluation_confirmation_consumed: '这批独立确认数据已用于之前的候选，不能反复重用为新确认。' });

export function describeEvolutionAssessment(version, { activeVersionId, project } = {}) {
  const evaluation = version.evaluation ?? {}, diagnostic = version.error?.diagnostic ?? version.evaluationEvidence?.diagnostic ?? {};
  const failedChecks = [];
  for (const [group, label] of [['baselineSmoke', '已发布基线脚本'], ['smoke', '候选自检'], ['frozenSmoke', '已发布工具兼容性']]) {
    const failed = rows(evaluation[group] ?? version.evaluationEvidence?.[group]).filter(row => row.passed === false);
    if (failed.length) failedChecks.push({ group, code: group === 'frozenSmoke' ? 'frozen_tool_contract_failed' : group === 'baselineSmoke' ? 'baseline_contract_failed' : 'candidate_smoke_failed', label, count: failed.length, toolIds: [...new Set(failed.map(row => row.toolId).filter(Boolean))], diagnostics: failed.map(row => ({ toolId: row.toolId, case: row.case, phase: row.phase ?? (row.error ? 'execution' : 'assertion'), code: row.code ?? 'output_mismatch', ...(row.line ? { line: row.line } : {}) })) });
  }
  for (const [code, passed] of Object.entries(evaluation.gates ?? {})) if (passed === false && code !== 'scripts') failedChecks.push({ group: 'gates', code, label: checkLabels[code] ?? code, count: 1, toolIds: [] });
  for (const row of evaluation.details ?? []) for (const [code, passed] of Object.entries(row.candidate?.checks ?? {})) if (passed === false) failedChecks.push({ group: 'candidate_case', code, label: `${row.id}: ${checkLabels[code] ?? code}`, count: 1, toolIds: [] });
  for (const row of evaluation.details ?? []) for (const check of row.candidate?.workspace?.checks ?? []) if (check.passed === false) failedChecks.push({ group: 'artifact', code: check.code, label: `${row.id}: ${check.path} · ${check.kind}`, count: 1, toolIds: [], checkId: check.id });
  for (const row of evaluation.details ?? []) for (const [group, label] of [['domain', '来源与协议'], ['environment', '浏览器交互']]) for (const check of row.candidate?.[group]?.checks ?? []) if (check.passed === false) failedChecks.push({ group, code: check.code, label: `${row.id}: ${label} · ${check.kind}`, count: 1, toolIds: [], checkId: check.id });
  if (version.proposalEarlyStopReason === 'unchanged_repair') failedChecks.push({ group: 'repair', code: 'unchanged_repair', label: '修复未改变候选，已停止重复调用', count: 1, toolIds: [] });
  const code = diagnostic.kind ?? version.error?.code ?? evaluation.earlyStopReason;
  const baselineFailed = failedChecks.some(row => row.group === 'baselineSmoke') || code === 'baseline_contract_failed';
  let category = 'unassessed';
  if (version.sourceDeleted || version.contextRevoked) category = 'source_deleted';
  else if (['proposing', 'evaluating'].includes(version.state)) category = 'pending';
  else if (version.state === 'interrupted') category = 'interrupted';
  else if (version.state === 'stale') category = 'stale';
  else if (version.state === 'no_change' && version.authorAbstention) category = 'no_change';
  else if (version.state === 'rejected' && (RRSI_SUMMARIES[version.error?.code] || evaluation.earlyStopReason === 'smoke_regressed' || version.rrsi?.selection?.enforced && version.rrsi.selection.admissible === false)) category = 'rrsi_screened';
  else if (baselineFailed) category = 'baseline_blocked';
  else if (version.state === 'failed') category = ['budget', 'budget_exhausted'].includes(code) ? 'budget_blocked' : ['proposal', 'script-repair'].includes(diagnostic.phase) || !version.proposal && !version.evaluationEvidence ? 'proposal_error' : 'evaluation_error';
  else if (evaluation.gatePassed === true) category = version.evaluationRevision ? 'standards_review' : 'ready';
  else if (evaluation.gatePassed === false) {
    if (code === 'candidate_smoke_failed' || failedChecks.some(row => row.group === 'smoke')) category = 'candidate_invalid';
    else if (code === 'frozen_tool_contract_failed' || failedChecks.some(row => row.group === 'frozenSmoke')) category = 'contract_incompatible';
    else category = 'quality_rejected';
  }
  const candidateRetained = Boolean(version.bundle?.hash || version.candidateHash && version.proposal);
  const standardRebaseAvailable = standardOnlyBaselineChange(project, version);
  const sameBaseline = activeVersionId === undefined || version.parentVersionId === activeVersionId;
  const recordedRuntimeHash = version.evaluationRuntimeHash ?? evaluation.evaluationRuntimeHash;
  const runtimeChanged = category !== 'no_change' && version.simulated === false && (typeof recordedRuntimeHash === 'string' ? recordedRuntimeHash !== PROJECT_EVALUATION_RUNTIME_HASH : Boolean(version.evaluation || version.evaluationEvidence));
  const recoverable = ['evaluation_error', 'budget_blocked', 'interrupted'].includes(category);
  const retryAvailable = category !== 'source_deleted' && !version.evaluationRevision && (standardRebaseAvailable || (recoverable || runtimeChanged && !['pending', 'baseline_blocked'].includes(category)) && sameBaseline) && candidateRetained;
  // This is an entry-point hint, not proof that archived bytes remain valid.
  // The host rechecks frozen source hashes and current authority before billing.
  const authorRetryAvailable = version.simulated === false && version.state === 'failed' && version.error?.diagnostic?.phase === 'proposal' && !version.sourceDeleted && !version.contextRevoked && !candidateRetained && !version.proposal && !version.candidateHash && !version.inputGenomeHash && !baselineFailed && sameBaseline && Boolean(version.learningReviewId && /^[a-f0-9]{64}$/.test(version.learningContextHash ?? '') && version.learningIntent);
  const kind = retryAvailable ? 'reevaluate' : category === 'baseline_blocked' ? 'baseline_repair' : ['candidate_invalid', 'contract_incompatible', 'quality_rejected'].includes(category) && candidateRetained ? 'revise' : ['proposal_error', 'interrupted', 'budget_blocked'].includes(category) && !candidateRetained ? 'regenerate' : 'none';
  const scoredCases = evaluation.scoredCases ?? (evaluation.details ?? version.evaluationEvidence?.cases ?? []).filter(row => Number.isFinite(row.candidateScore) && Number.isFinite(row.baselineScore)).length;
  const detailRows = evaluation.details ?? version.evaluationEvidence?.cases ?? [];
  const diagnosticRows = [...detailRows, ...(version.evaluationEvidence?.inFlightCase ? [version.evaluationEvidence.inFlightCase] : [])];
  const diagnosticCases = diagnosticRows.map(row => ({ id: row.id, ...Object.fromEntries(['baseline', 'candidate'].filter(side => row[side]).map(side => [side, describeProjectEvaluationCase(evaluation.suite?.cases?.find(item => item.id === row.id), row[side])])) }));
  const executedCases = diagnosticRows.filter(row => row.baseline || row.candidate).length;
  const totalCases = evaluation.suite?.cases?.length ?? version.evaluationEvidence?.totalCases ?? (Number.isInteger(evaluation.cases) ? evaluation.cases + (evaluation.skippedCases ?? 0) : null);
  const skippedCases = evaluation.skippedCases ?? (Number.isInteger(totalCases) ? Math.max(0, totalCases - executedCases) : null);
  const unscoredReason = scoredCases === 0 ? category === 'no_change' ? 'author_no_change' : evaluation.stage === 'deterministic_case' ? 'deterministic_checks_failed' : evaluation.stage === 'script_preflight' ? 'script_preflight_failed' : category === 'pending' ? 'pending' : 'evaluation_incomplete' : null;
  let summary = category === 'source_deleted' ? '来源会话及关联诊断原文已删除，仅保留执行与计费记录。已有项目能力文件保留；该候选不能据此新试用或采用。'
    : category === 'no_change' ? '作者复核后未发现证据充分的能力改动，已保留原因和后续关注条件；本轮没有候选质量评分。'
    : category === 'standards_review' ? '双方在显式修订的同一基准上完成对照并通过；标准尚未采用，候选不可据此试用或激活。'
    : category === 'ready' ? '当前冻结用例通过，可试用；不代表通用能力提升。'
    : category === 'contract_incompatible' ? '改进建议已保留，但工具不满足已发布版本的兼容契约；需要修订候选。'
    : category === 'candidate_invalid' ? '改进建议已保留，但生成脚本与自身检查不一致；需要修订候选。'
    : category === 'baseline_blocked' ? '已发布基线自身检查失败，无法据此判断候选优劣；须单独修复或审阅基线。'
    : category === 'quality_rejected' ? '已执行的行为或质量检查未满足全部冻结门槛；当前版本保持有效。'
    : category === 'evaluation_error' ? '模型或评估执行没有得到有效完整结果，不能据此判断候选优劣。'
    : category === 'proposal_error' ? '尚未得到可评估的候选，不能给出能力评分。'
    : category === 'budget_blocked' ? '额度未允许完成评估，已保留实际用量与证据。'
    : category === 'interrupted' ? '评估中断，保留此前执行证据；未自动重放付费请求。'
    : category === 'stale' ? '项目基线已变化，历史评估不能应用到当前版本。'
    : category === 'pending' ? '正在生成或检查候选，尚无最终结论。' : category === 'rrsi_screened' ? RRSI_SUMMARIES[version.error?.code] ?? (evaluation.earlyStopReason === 'smoke_regressed' ? RRSI_SUMMARIES.smoke_failed : RRSI_SUMMARIES.selection) : '该版本没有候选对照评估结论。';
  if (['candidate_invalid', 'contract_incompatible', 'baseline_blocked', 'quality_rejected'].includes(category) && !scoredCases) summary += ' 尚未进行质量评分。';
  if (['evaluation_error', 'proposal_error'].includes(category) && diagnosticLabels[code]) summary += ` ${diagnosticLabels[code]}`;
  if (runtimeChanged && category !== 'source_deleted') summary += ' 评估运行环境已升级；此处保留历史结果，试用前需要在新环境中重评。';
  if (version.proposalEarlyStopReason === 'unchanged_repair') summary += ' 修复返回了相同候选，已停止重复付费并保留原检查失败。';
  const deterministicRejected = category === 'quality_rejected' && (evaluation.stage === 'deterministic_case' || evaluation.earlyStopReason === 'candidate_deterministic_failed');
  if (deterministicRejected && scoredCases > 0) summary = `已完成 ${scoredCases} 个用例评分，随后任务检查未通过，整体质量评估未完成；不能据此视为整体低分。${runtimeChanged ? ' 评估运行环境已升级，历史结果保留。' : ''}`;
  return { schemaVersion: 1, category, label: category === 'no_change' && version.authorAbstention?.reason === 'insufficient_evidence' ? '等待更多证据' : deterministicRejected ? scoredCases ? '任务检查未通过（部分评分）' : '任务检查未通过（未评分）' : labels[category], summary, stage: diagnostic.phase ?? evaluation.stage ?? (version.state === 'proposing' ? 'proposal' : null), code: code ?? null,
    scoredCases, totalCases, executedCases, skippedCases, unscoredReason, diagnosticCases, failedChecks, candidateRetained, standardRebaseAvailable, runtimeChanged, evaluationRuntimeHash: version.evaluationRuntimeHash ?? evaluation.evaluationRuntimeHash ?? null, coverage: evaluation.coverage ?? null, methodologyVersion: evaluation.methodologyVersion ?? null,
    standardAdoption: { available: standardAdoptionAvailable(project, version), reviewVersionId: version.id, revisionHash: version.evaluationRevision?.revisionHash ?? null, reason: version.evaluationRevision ? '须保留至少一个完整双边用例与冻结标准证据；独立采用只更新当前基线标准，不激活候选。' : '' },
    authorRetry: { available: authorRetryAvailable, sourceVersionId: version.id, reason: authorRetryAvailable ? '核对原冻结输入后重新生成候选；保留原失败记录，新请求按实际用量计费。' : '' },
    retry: { available: retryAvailable, kind, sourceVersionId: version.id, reason: standardRebaseAvailable ? '能力不变，仅将原候选标准同步至已审阅采用的当前标准，再新建配对评估；旧版本保持。' : retryAvailable ? '显式重评原候选与原冻结基线；新建记录并重新计费，不覆盖历史结果。' : !sameBaseline && (recoverable || category === 'stale') ? '当前基线已变化，不能重放旧版本评估。' : kind === 'revise' ? '先修订候选再评估；重复执行相同失败检查不会修复任务契约或候选行为。' : kind === 'baseline_repair' ? '不能修改冻结答案来让候选通过。' : kind === 'regenerate' || category === 'evaluation_error' ? '没有可验证的原候选，需重新生成或人工修订。' : '' } };
}
