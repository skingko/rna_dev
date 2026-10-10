import { evaluationMethodDisplay, evolutionSearchDisplay, authorAbstentionDisplay, evaluationBenefitDisplay, evolutionFunnelDisplay } from './presentation/evolution-evidence-display.mjs';

// Project/model text is untrusted terminal data. Preserve readable content while
// stripping terminal control sequences and multiline layout manipulation.
const plain = (value, limit = 140) => String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
const list = value => Array.isArray(value) ? value : [];
const amount = value => value === null || value === undefined ? '未记录' : Number(value).toLocaleString('zh-CN');
function stateLabel(project, version) {
  if (project.trialVersionId === version.id) return '试用中';
  if (project.activeVersionId === version.id) return '当前版本';
  return plain(version.assessment?.label ?? ({ no_change: '无需变更', proposing: '生成中', evaluating: '评估中', ready: '可试用', rejected: '未通过', failed: '未完成', interrupted: '已中断', stale: '基线已变化' })[version.state] ?? version.state ?? '未评估', 40);
}
export function formatVersionList(project) {
  const versions = list(project.versions);
  const lines = [`${plain(project.name ?? project.title ?? project.id)} · ${versions.length} 条版本与复核记录`, evolutionFunnelDisplay(project).summary];
  for (const version of versions) {
    const method = evaluationMethodDisplay(version), title = plain(version.summary ?? version.title ?? version.label ?? version.id, 90);
    lines.push(`${plain(version.id, 160)}  [${stateLabel(project, version)}]  ${title}`);
    if (method?.environmentUnavailable || version.evaluation?.gatePassed === true) lines.push(`  ${plain(method?.summary, 160)}`);
  }
  if (!versions.length) lines.push('还没有版本记录。');
  lines.push(`详情：rna version ${plain(project.id, 160)} <版本ID>；机器读取：rna versions ${plain(project.id, 160)} --json`);
  return lines.join('\n');
}
export function formatVersionDetail(project, version) {
  const method = evaluationMethodDisplay(version), lines = [`${plain(version.id, 160)} · ${stateLabel(project, version)}`, plain(version.summary ?? version.title ?? version.label ?? '', 500)];
  const review = authorAbstentionDisplay(version), benefit = evaluationBenefitDisplay(version);
  if (review) lines.push('', review.label, plain(review.explanation, 4000), ...review.revisitWhen.map(value => `后续关注：${plain(value, 800)}`), review.limitation);
  if (benefit) lines.push('', benefit.summary, benefit.limitation);
  if (method) {
    lines.push(plain(method.summary, 1200), '', '评测过程');
    for (const row of method.phases) lines.push(`  ${row.label} · ${row.statusLabel} · 请求 ${amount(row.requests)} · tokens ${amount(row.tokens)}`);
    lines.push(method.confirmation.label);
    if (method.enhanced) lines.push(method.enhanced.summary, method.enhanced.limitation);
    if (method.counts) lines.push(`开发用例 ${amount(method.counts.development)} · 对照用例 ${amount(method.counts.selection)} · 独立确认 ${amount(method.counts.confirmation)}`);
    for (const row of method.domains) lines.push('', `${row.label} · 覆盖 ${amount(row.declared)} · 保留执行回执 ${row.executed} · 其中通过 ${row.passed}`, row.limitation);
    if (method.exposure) { lines.push('', method.exposure.summary); for (const row of method.exposure.rows) lines.push(`  ${plain(row.kind)} · ${plain(row.target)} · ${row.label}`); lines.push(method.exposure.limitation); }
  }
  if (version.assessment?.summary) lines.push('', plain(version.assessment.summary, 1200));
  const search = evolutionSearchDisplay(version);
  if (search) lines.push('', '候选搜索与反馈', search.summary, search.feedback, search.history, ...(search.review ? [search.review] : []), search.limitation);
  if (version.error?.code) lines.push(`诊断：${plain(version.error.code, 160)}`);
  for (const check of list(version.assessment?.failedChecks).slice(0, 24)) lines.push(`  ${plain(check.label, 200)} · ${plain(check.code, 100)}`);
  if (version.assessment?.retry?.reason) lines.push(plain(version.assessment.retry.reason, 500));
  lines.push('', `完整记录：rna version ${plain(project.id, 160)} ${plain(version.id, 160)} --json`);
  return lines.join('\n');
}
