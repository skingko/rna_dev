// Descriptive receipts, not a counterfactual estimate of tokens "saved".
const modes = ['off', 'shadow', 'active'];
const points = ['initiative.review', 'evolution.review', 'chat.preflight'];
const quantile = (values, q) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * q) - 1)] : null;
export function decisionPerformance(rows = []) {
  return { scope: 'recent_retained_receipts', comparison: 'not_controlled', thresholdStatus: 'heuristic_uncalibrated',
    groups: points.flatMap(point => modes.flatMap(mode => {
      const group = rows.filter(row => row.point === point && row.mode === mode), requests = group.filter(row => row.networkAttempted === true);
      if (!group.length) return [];
      const durations = requests.map(row => row.latencyMs).filter(Number.isFinite);
      const reported = requests.filter(row => Number.isFinite(row.usage?.inputTokens) && Number.isFinite(row.usage?.outputTokens));
      return [{ point, mode, observations: group.length, measuredRequests: requests.length, durationSamples: durations.length,
        p50Ms: quantile(durations, .5), p95Ms: quantile(durations, .95), reportedTokens: reported.reduce((sum, row) => sum + row.usage.inputTokens + row.usage.outputTokens, 0),
        unknownUsageRequests: requests.length - reported.length, legacyUnmeasured: group.filter(row => typeof row.networkAttempted !== 'boolean').length,
        parallel: group.filter(row => row.execution?.latencyClass === 'parallel').length,
        deferred: group.filter(row => row.disposition === 'deferred').length,
        fallback: group.filter(row => row.source === 'fallback' && !['shadow', 'off', 'shadow_budget_priority'].includes(row.reason)).length,
        budgetPrioritySkipped: group.filter(row => row.reason === 'shadow_budget_priority').length }];
    })) };
}
export function formatDecisionStatus(config = {}) {
  const labels = { off: '关闭', shadow: '仅观察（并行）', active: '采用评分' }, names = { 'initiative.review': '主动协作', 'evolution.review': '自进化', 'chat.preflight': '对话' };
  const lines = [`JEV · ${labels[config.mode] ?? '未知'} · ${config.apiKeyConfigured ? '凭据已配置' : '未配置凭据'}`, `${config.planReadyCount ?? 0} 个项目已有主模型判断选项。`];
  for (const row of config.performance?.groups ?? []) lines.push(`${names[row.point]} · ${labels[row.mode]} · 实测请求 ${row.measuredRequests} · 请求耗时 p50 ${row.p50Ms ?? '未知'} ms / p95 ${row.p95Ms ?? '未知'} ms · 已报告 ${row.reportedTokens} tokens · 用量未报告 ${row.unknownUsageRequests}${row.legacyUnmeasured ? ` · 历史未知请求 ${row.legacyUnmeasured}（用量未纳入此统计）` : ''}`);
  lines.push('仅观察评分与主流程并行；请求耗时不等于用户等待。近期记录不是同输入对照，不能据此推算节省或准确率。');
  lines.push('设置真实 token 限额时跳过仅观察评分，将额度留给实际任务。');
  return lines.join('\n');
}
