import { t, localized } from '@/i18n'
/**
 * Cosmetic projections of retained host receipts (ported from the legacy
 * `public/evolution-evidence-display.js`; behavior kept byte-for-byte). Never
 * infer discovery, installation, or an evaluation result from model prose.
 * Inputs are raw host records, so they are loosely typed; outputs are typed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = Record<string, any>
export interface ChangeCategory { key: string; label: string; changed: boolean; status: string; added: { id: string; name?: string }[]; updated: { id: string; name?: string }[]; removed: { id: string; name?: string }[]; counts: { added: number; updated: number; removed: number } }
export interface EvaluationMethodDisplay {
  summary: string; recorded: boolean; counts: null | { development?: number | null; selection?: number | null; confirmation?: number | null }
  phases: { id: string; label: string; status: string; statusLabel: string; requests: number | null; tokens: number | null }[]
  confirmation: { status: string; label: string; passed: boolean | null }; enhanced: null | { summary: string; limitation: string }
  domains: { id: string; label: string; declared: number | null; executed: number; passed: number; limitation: string }[]
  exposure: null | { summary: string; limitation: string; rows: { kind: string; target: string; status: string; label: string }[] }
  environmentUnavailable?: boolean; requests: number | null; tokens: number | null
}
export interface ReferenceDiscoveryDisplay {
  status: string; label: string; inheritedFromVersionId?: string | null; activation?: string; activationLabel?: string
  packages?: { name: string; provider: string; commit: string; packageHash: string; fileCount: number; sourceUrl: string | null; includedInVersion?: boolean; activationLabel?: string }[]
  searchCoverage?: { provider: string; status?: string; label: string; supported: number | null; unsupported: number | null }[]
  sources: { provider: string; id: string; path?: string; commit?: string | null; contentHash?: string | null; sourceUrl?: string | null; licenseReview?: string }[]
  failures: { operation: string; code: string }[]
}
export interface VersionChangeSummary { kind: string; summary: string; tags: string[]; baselineVersionId: string | null; baselineLabel: string | null; categories: ChangeCategory[]; comparisonAvailable: boolean }
const safeCount = (n: any): number | null => Number.isSafeInteger(n) && n >= 0 ? n : null;
const text = (value: any, max = 500): string => typeof value === 'string' ? value.slice(0, max) : '';
const retained = (row: any): boolean => row && !row.sourceDeleted && !row.contextRevoked && row.simulated !== true;
const timestamp = (row: any): number => Number.isFinite(Date.parse(row.createdAt)) ? Date.parse(row.createdAt) : 0;
/** Retained records, not lifetime counters or an inferred adoption rate. Retries
 * remain separate attempts; deleted evidence and standards-only revisions do not
 * become successful capability candidates. */
export function evolutionFunnelDisplay(project: Rec = {}) {
  const rows = array(project.versions).filter((row: any) => retained(row) && !row.deletedAt && row.parentVersionId && !row.evaluationRevision && !['skill-foundation', 'adopted-evaluation-standard', 'reviewed-evaluation-revision'].includes(row.source));
  const stopped = rows.filter((row: any) => row.state === 'no_change' && row.authorAbstention).length;
  const candidates = rows.filter((row: any) => row.candidateGenerated !== false && row.state !== 'no_change' && (row.bundle?.hash || row.candidateHash || row.proposal?.genome));
  const measured = candidates.filter((row: any) => row.evaluation?.evaluationComplete === true);
  const passed = measured.filter((row: any) => row.evaluation.gatePassed === true);
  const adopted = candidates.filter((row: any) => row.adoptedAt && Number.isFinite(Date.parse(row.adoptedAt)));
  return { attempts: rows.length, stopped, generated: candidates.length, measured: measured.length, passed: passed.length, adopted: adopted.length,
    summary: t('当前保留记录：{length} 次进化尝试 · {stopped} 次复核后无需变更 · {length2} 个已生成候选 · {length3} 次完整评估 · {length4} 次通过门槛 · {length5} 次已采用。', { length: rows.length, stopped, length2: candidates.length, length3: measured.length, length4: passed.length, length5: adopted.length }),
    limitation: t('按保留记录统计；重评单独计数，基础能力版本、标准修订与删除来源不计入能力候选。无需变更不是评估通过；可试用也不等于已采用。') };
}
export function skillSourceDisplay(skill: Rec = {}): { kind: string; label: string; detail: string; installationId?: string; manifestId?: string } {
  const source = skill.source;
  if (source?.kind === 'installed-skill-package') return { kind: source.kind, label: t('已安装技能快照'), installationId: text(source.installationId, 100), manifestId: text(source.manifestId, 100), detail: t('原安装 {v}；核对本地安装快照，不代表全部资源经过远端 Git blob 校验。', { v: text(source.installationId, 100) || t('未记录') }) };
  if (source?.kind === 'marketplace-package') return { kind: source.kind, label: t('市场原包'), detail: t('固定提交 {v}；获取来源不代表已验证收益。', { v: /^[a-f0-9]{40}$/i.test(source.commit ?? '') ? source.commit.slice(0, 12) : t('未记录') }) };
  return { kind: source ? 'unknown' : 'project-authored', label: source ? t('来源待核对') : t('项目自创技能'), detail: source ? t('尚无可识别的来源凭据。') : t('由项目能力版本保存的方法。') };
}
export function skillFoundationDisplay(project: Rec = {}) {
  const f = project.skillFoundation;
  if (!retained(project) || f?.schemaVersion !== 1 || !['ready', 'partial', 'preparing', 'failed', 'stale'].includes(f.status)) return null;
  const labels: Record<string, string> = { pending: t('待补齐'), selected: t('已选择来源'), deferred: t('保留缺口') };
  const coverage = array(f.coverage).slice(0, 20).map((row: any) => ({ id: text(row.id, 100), description: text(row.description, 500), query: text(row.query, 160), status: Object.hasOwn(labels, row.status) ? row.status : 'pending', skillIds: array(row.skillIds).map((id: any) => text(id, 100)), reasonCode: text(row.reasonCode, 100), reason: text(row.reason, 1000), label: labels[row.status] ?? t('待核对') }));
  const selected = coverage.filter((row: any) => row.status === 'selected').length, deferred = coverage.filter((row: any) => row.status === 'deferred').length, pending = coverage.filter((row: any) => row.status === 'pending').length, sourceCount = safeCount(f.sourceCount);
  const summary = ({ ready: t('基础能力已就绪：{v} 项来源技能，覆盖 {selected}/{length} 项能力。', { v: sourceCount ?? t('未记录数量的'), selected, length: coverage.length }), partial: t('基础能力已部分配置：{v} 项来源技能，{deferred} 项缺口{v2}。', { v: sourceCount ?? t('未记录数量的'), deferred, v2: pending ? t('、{pending} 项待补齐', { pending }) : '' }), preparing: t('正在整理基础技能，当前项目版本保持可用。'), failed: t('基础技能整理未完成，已有版本保留；可展开查看原因。'), stale: t('项目或技能来源已变化，基础能力记录待重新核对。') } as Record<string, string>)[f.status];
  return { status: f.status, summary, sourceCount, selected, deferred, pending, coverage,
    imports: array(f.imports).slice(0, 30).map((row: any) => ({ name: text(row.name || row.manifestId || row.skillId, 200), installationId: text(row.installationId, 100), status: text(row.status, 100) })),
    diagnostics: array(f.diagnostics).slice(0, 20).map((row: any) => typeof row === 'string' ? { code: text(row, 100), message: '' } : { code: text(row.code, 100), message: text(row.message, 500) }),
    limitation: t('基础能力整理与收益评测分别记录；技能已保存不等于效果提升，不计入进化采纳率。') };
}
export function referenceDiscoveryDisplay(project: Rec, version: Rec): ReferenceDiscoveryDisplay | null {
  if (!retained(version)) return null;
  let source: Rec = version, record: Rec | undefined, inheritedFromVersionId: string | null = null;
  const seen = new Set();
  while (source && retained(source) && !seen.has(source.id) && seen.size < 32) {
    seen.add(source.id);
    record = source.referenceDiscovery ?? (project.initialization?.versionId === source.id ? project.initialization.referenceDiscovery : null);
    if (record) { inheritedFromVersionId = source.id !== version.id ? source.id : record.inheritedFromVersionId ?? null; break; }
    source = (project.versions ?? []).find((row: any) => row.id === source.retryOfVersionId);
  }
  if (!record) return { status: 'unknown', label: t('未保留市场检索回执，不能从候选说明判断是否检索或安装。'), sources: [], failures: [] };
  const sources = (record.sources ?? []).slice(0, 20).map((row: any) => ({ provider: text(row.provider, 40), id: text(row.id), commit: /^[a-f0-9]{40}$/i.test(row.commit ?? '') ? row.commit : null, path: text(row.path, 400), contentHash: /^[a-f0-9]{64}$/i.test(row.contentHash ?? '') ? row.contentHash : null, sourceUrl: publicSourceUrl(row.sourceUrl), licenseReview: text(row.licenseReview, 100) }));
  const failures = (record.failures ?? []).slice(0, 12).map((row: any) => ({ operation: text(row.operation, 40), code: text(row.code, 100) }));
  const searches = Array.isArray(record.searches) ? record.searches.length : safeCount(record.searches), filesRead = safeCount(record.filesRead);
  const searchCoverageLabels: Record<string, string> = { complete: t('本页解析完成'), partial: t('部分结果可解析'), unsupported: t('来源存在但格式不支持'), empty: t('本次搜索返回空结果') };
  const searchCoverage = array(record.searchCoverage ?? (Array.isArray(record.searches) ? record.searches : [])).map((row: any) => ({ provider: text(row.provider, 40), status: row.coverage?.status, label: searchCoverageLabels[row.coverage?.status] ?? t('搜索覆盖未记录'), supported: safeCount(row.coverage?.supportedCount), unsupported: safeCount(row.coverage?.unsupportedCount) }));
  const packages = (record.packages ?? []).filter((row: any) => /^[a-f0-9]{40}$/i.test(row.commit ?? '') && /^[a-f0-9]{64}$/i.test(row.packageHash ?? '')).map((row: any) => ({ name: text(row.name || row.skillId), provider: text(row.provider, 40), commit: row.commit, packageHash: row.packageHash, fileCount: row.files?.length ?? 0, sourceUrl: publicSourceUrl(row.sourceUrl) }));
  const disposition = record.disposition;
  const activation = project.trialVersionId === version.id ? 'trial' : project.activeVersionId === version.id ? 'active' : 'inactive';
  const activationLabel = activation === 'trial' ? t('已包含在当前试用版本；执行时仍遵循项目授权。') : activation === 'active' ? t('已包含在当前项目版本；执行时仍遵循项目授权。') : version.source === 'skill-foundation' ? t('保存在此基础能力版本；当前是否使用以项目版本选择为准。') : t('保存在此候选，尚未在当前项目版本启用。');
  for (const pkg of packages) { pkg.includedInVersion = array(version.bundle?.genome?.skills).some((skill: any) => skill.source?.kind === 'marketplace-package' && skill.source.packageHash === pkg.packageHash); pkg.activationLabel = pkg.includedInVersion ? activationLabel : t('获取回执已保留；此版本尚无对应技能包保存记录，不能据此宣称已启用。'); }
  const packageLabel = packages.length ? t('已获取 {length} 个完整技能包。{v}', { length: packages.length, v: packages.every((pkg: any) => pkg.includedInVersion) ? activationLabel : t('保存与启用情况以版本内的实际技能包为准。') }) : disposition?.status === 'existing_package_reused' ? t('沿用版本已有的来源技能包。') : record.installed === false ? t('此环节仅参考与适配，没有安装这些来源。') : t('安装情况须以独立安装回执为准。');
  return { status: 'recorded', inheritedFromVersionId, sources, failures, packages, searchCoverage, activation, activationLabel,
    label: t('{v}公开搜索 {v2} 次 · 固定版本文件读取 {v3} 次。{packageLabel}{v4}{v5}', { v: inheritedFromVersionId ? t('沿用原候选参考记录，本次未重新检索。') : '', v2: searches ?? t('未记录'), v3: filesRead ?? t('未记录'), packageLabel, v4: disposition?.reason ? t(' 选择依据：{v}', { v: text(disposition.reason, 500) }) : '', v5: failures.length ? t(' {length} 次检索或读取未完成。', { length: failures.length }) : '' }) };
}
function publicSourceUrl(value: any): string | null {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function installedProjectSkills(project: Rec, capabilities: Rec = {}) {
  const assigned = new Set<string>(project.assignments?.skillIds ?? []), seen = new Set<string>(), rows: Rec[] = [];
  for (const installation of capabilities.installations ?? []) {
    if (installation.status !== 'installed') continue;
    for (const entry of installation.entries ?? []) {
      if (entry.kind !== 'skills' || seen.has(entry.id) || installation.projectId !== project.id && !assigned.has(entry.id)) continue;
      const skill = (capabilities.skills ?? []).find((row: any) => row.id === entry.id && row.installationId === installation.installationId);
      if (!skill) continue; seen.add(entry.id);
      rows.push({ id: text(entry.id, 200), installationId: text(installation.installationId, 100), name: text(skill.name || entry.id, 200), assigned: assigned.has(entry.id), enabled: skill.enabled !== false, trusted: skill.trusted !== false,
        status: skill.trusted === false ? t('已安装，授权已撤销') : skill.enabled === false ? t('已停用，当前未启用或未分配') : assigned.has(entry.id) ? t('已安装并分配给此项目') : t('已安装，当前未启用或未分配'), createdAt: installation.createdAt,
        sources: (installation.sources ?? []).map((row: any) => ({ type: text(row.type, 40), commit: /^[a-f0-9]{40}$/i.test(row.commit ?? '') ? row.commit : null })) });
    }
  }
  return rows;
}
export function projectExternalSkillsDisplay(project: Rec = {}, capabilities: Rec = {}) {
  const effective = array(project.versions).find((v: any) => v.id === (project.trialVersionId ?? project.activeVersionId) && retained(v) && !v.deletedAt && !['withdrawn', 'superseded'].includes(v.status));
  const packaged = array(effective?.bundle?.genome?.skills).filter((skill: any) => ['marketplace-package', 'installed-skill-package'].includes(skill.source?.kind));
  const rows: Rec[] = [], merged = new Set<string>(), seen = new Set<string>(), installations = array(capabilities.installations), manifests = array(capabilities.skills);
  for (const skill of packaged) {
    if (seen.has(skill.id)) continue; seen.add(skill.id);
    const source = skillSourceDisplay(skill), identity = source.kind === 'installed-skill-package' ? `${source.installationId}:${source.manifestId}` : null;
    if (identity) merged.add(identity);
    const originals = identity ? manifests.filter((row: any) => row.id === source.manifestId) : [];
    const original = originals.length === 1 && originals[0].installationId === source.installationId && !originals[0].generated && originals[0].managed !== 'project-genome' ? originals[0] : null;
    const receipts = identity ? installations.filter((row: any) => row.installationId === source.installationId) : [];
    const installation = receipts.length === 1 ? receipts[0] : null;
    const selectedManifest = manifests.find((row: any) => row.projectId === project.id && row.versionId === effective.id && row.localId === skill.id);
    const originStatus = !identity ? '' : installation?.status === 'removed' ? t('原安装已注销，快照不可用') : installation?.status !== 'installed' || array(installation.entries).filter((row: any) => row.kind === 'skills' && row.id === source.manifestId).length !== 1 || !original ? t('原安装回执或配置不可用，快照不可用') : original.trusted !== true ? t('原安装未获授权或授权已撤销，快照不可用') : original.enabled !== true ? t('原安装已停用，快照不可用') : !array(project.assignments?.skillIds).includes(original.id) ? t('原安装未分配给此项目，快照不可用') : t('原安装仍已分配且授权有效；使用时仍需核对文件');
    const unavailable = originStatus.includes('不可用') || originStatus.includes('unavailable') || selectedManifest?.trusted === false || selectedManifest?.enabled === false;
    const inclusion = project.trialVersionId === effective.id ? t('当前试用版本已包含') : t('当前项目版本已包含');
    const status = selectedManifest?.trusted === false ? t('{inclusion} · 版本技能授权已撤销', { inclusion }) : selectedManifest?.enabled === false ? t('{inclusion} · 版本技能已停用', { inclusion }) : unavailable ? t('{inclusion} · 当前不可用', { inclusion }) : inclusion;
    rows.push({ id: skill.id, name: text(skill.name || skill.id, 200), kind: source.kind, sourceLabel: source.label, detail: source.detail, installationId: source.installationId, status, originStatus, unavailable });
  }
  for (const row of installedProjectSkills(project, capabilities)) if (!merged.has(`${row.installationId}:${row.id}`)) rows.push({ ...row, kind: 'external-installation', sourceLabel: t('外部安装'), detail: row.sources.map((source: any) => source.commit ? t('安装回执提交 {v}', { v: source.commit.slice(0, 12) }) : t('{v} · 未记录提交', { v: source.type || t('来源') })).join(t('；')) });
  return { count: rows.length, rows };
}
export function evaluationProgressDisplay(version: Rec) {
  const a = version.assessment ?? {}, e = version.evaluation ?? {}, scored = safeCount(a.scoredCases ?? e.scoredCases), total = safeCount(a.totalCases);
  const executed = safeCount(a.executedCases ?? e.cases), skipped = safeCount(a.skippedCases ?? e.skippedCases);
  return { scored, total, executed, skipped,
    label: t('{v}{v2}{v3}{v4}。{v5}', { v: scored === 0 ? t('尚未进行质量评分') : scored === null ? t('质量评分数量未记录') : t('已完成 {scored} 个用例的质量评分', { scored }), v2: total === null ? '' : t('（共 {total} 个用例）', { total }), v3: executed === null ? '' : t(' · 已执行 {executed} 个', { executed }), v4: skipped === null ? '' : t(' · 未执行 {skipped} 个', { skipped }), v5: scored === 0 ? t('未评分不等于质量得分为 0。') : '' }) };
}

const evaluationPhaseLabels: Record<string, string> = localized({ author: '候选生成', preflight: '脚本与兼容检查', deterministic: '产物与行为检查', paired: '双边质量对照', confirmation: '独立确认' });
const evaluationStatusLabels: Record<string, string> = localized({ not_started: '尚未开始', running: '进行中', passed: '通过', failed: '未通过', interrupted: '未完成', skipped: '未执行', not_applicable: '未提供', observed_requests: '已记录请求，结论待确认', unrecorded: '未记录' });
const array = (value: any): any[] => Array.isArray(value) ? value : [];
const searchFeedbackLabels: Record<string, string> = localized({ author_no_change: '作者复核认为当前证据不足以支持能力变更；保留判断，等待新证据。', source_unavailable: '来源已撤销，不用于后续搜索。', in_progress: '候选仍在执行，尚无搜索结论。', author_incomplete: '候选生成未完成，不代表方法无效。', candidate_not_retained: '尚无完整候选，不判断方法收益。', preflight_incomplete: '脚本或兼容检查未完成，尚未判断质量。', provider_incomplete: '模型请求未完成，不能作为方法无效的证据。', selection_incomplete: '对照未完整完成，不作为无收益证据。', environment_identity_not_preflighted: '执行环境尚不能与下一次核对，保留结果但不据此阻止重试。', exposure_unverified: '改动触达回执不足，暂不判断方法收益。', changes_not_exercised: '用例未使用全部改动，先检查技能发现与任务匹配；不据此删除能力。', selection_passed: '当前筛选通过；试用资格仍以完整评估为准。', selection_no_gain: '完整筛选未测得正收益，保留方法与记录供后续分析。', selection_constraints_failed: '测得分差但未满足全部筛选约束，尚不能采用。' });
export function evolutionSearchDisplay(version: Rec = {}) {
  if (!retained(version) || version.source === 'skill-foundation' || version.searchSummary?.schemaVersion !== 1 || version.searchSummary.method !== 'host-bounded-search-v1') return null;
  const s = version.searchSummary, limit = safeCount(s.maxChangedAssets), review = version.searchReview;
  const reviewReasons: Record<string, string> = { no_behavior_change: t('尚未形成实际运行能力改动'), asset_scope_exceeded: t('改动范围超过本轮约束'), duplicate_measured_candidate: t('相同候选与证据已有完整筛选记录') };
  const summary = s.authorPolicyApplied === false ? t('本次沿用提交的候选进行评估，未重新生成能力。') : s.mode === 'focused' ? t('本轮聚焦 {v} 个能力单元，检查此前未测出收益的改法。', { v: limit ?? t('少量') }) : t('本轮最多调整 {v} 个相关能力单元，减少无关改动。', { v: limit ?? t('少量') });
  return { summary, feedback: ['interrupted', 'stale'].includes(version.state) ? t('本次执行已中断或来源发生变化，保留回执，不作为方法无效的证据。') : version.searchFeedback?.reason === 'execution_identity_unverified' ? t('历史执行身份不完整，保留诊断但不据此判断或阻止下一候选。') : searchFeedbackLabels[version.searchFeedback?.reason] ?? t('完成执行后记录反馈；未完成不等于无收益。'),
    history: t('同一模型与评估条件：{v} 次有完整触达的筛选，{v2} 次尚不足以比较收益。作者本次参考 {v3} 条摘要；完整历史保留。', { v: safeCount(s.measured) ?? t('未记录'), v2: safeCount(s.unmeasured) ?? t('未记录'), v3: safeCount(s.historyIncluded) ?? t('未记录') }),
    review: review?.schemaVersion === 1 ? t('实际修改 {v} 个能力单元{v2}。{v3}', { v: safeCount(review.changedAssetCount) ?? t('未记录'), v2: array(review.repeatedHypothesisIds).length ? t('；{length} 次相似假设仅作提醒', { length: array(review.repeatedHypothesisIds).length }) : '', v3: review.enforced && review.status === 'rejected' ? array(review.reasons).map((reason: any) => reviewReasons[reason]).filter(Boolean).join(t('；')) + t('。') : '' }) : null,
    limitation: t('提示词、完整技能包（含资源）和工具分别计数；这是工程启发式，不是原子编辑数或能力评分。原评估门槛、独立确认和用户试用流程保持。确认结果不反馈给候选作者。') };
}
/** One read-only projection for GUI and CLI. Counts are fixture coverage and
 * observed receipts, never independent proof of quality or live-world success. */
export function evaluationMethodDisplay(version: Rec = {}): EvaluationMethodDisplay | null {
  if (!retained(version)) return null;
  if (version.source === 'skill-foundation') return { summary: t('基础能力版本 · 未作收益评测，不计入进化采纳率。'), phases: [], domains: [], enhanced: null, exposure: null, recorded: false, counts: null, requests: null, tokens: null, confirmation: { status: 'not_applicable', label: t('基础能力整理不代表收益已经验证。'), passed: null } };
  const e = version.evaluation ?? version.evaluationEvidence ?? {}, ledger = version.operationPhaseLedger ?? e.phaseLedger, partitions = e.partitionSummary;
  const phaseRows = ledger?.schemaVersion === 1 ? array(ledger.phases) : [];
  const phases = Object.entries(evaluationPhaseLabels).map(([id, label]: any) => {
    const row: any = phaseRows.find((item: any) => item?.phase === id), status = Object.hasOwn(evaluationStatusLabels, row?.status ?? '') ? row.status : 'unrecorded';
    return { id, label: id === 'author' && version.state === 'no_change' ? t('作者复核') : label, status, statusLabel: evaluationStatusLabels[status], requests: safeCount(row?.requests), tokens: safeCount(row?.usage?.totalTokens) };
  });
  const missingConfirmation = partitions?.confirmation?.status === 'not_applicable' || e.confirmation?.status === 'not_applicable';
  const confirmation = missingConfirmation ? { status: 'not_applicable', label: t('未提供独立确认数据；当前结论仅适用于现有任务用例。'), passed: null }
    : e.confirmation?.status === 'passed' && e.confirmation.passed === true ? { status: 'passed', label: t('独立确认已通过；仍限于本次冻结的任务范围。'), passed: true }
      : e.confirmation?.status === 'failed' ? { status: 'failed', label: t('独立确认未通过，候选未获采用资格。'), passed: false }
        : { status: e.confirmation?.status === 'skipped' ? 'skipped' : 'unrecorded', label: e.confirmation?.status === 'skipped' ? t('前序评估未通过，尚未执行独立确认。') : t('尚无独立确认结论。'), passed: null };
  if (missingConfirmation) { const row = phases.find((item: any) => item.id === 'confirmation')!; row.status = 'not_applicable'; row.statusLabel = evaluationStatusLabels.not_applicable; }
  const collected = [...array(e.details ?? e.cases), ...(e.inFlightCase ? [e.inFlightCase] : [])], rows = [...new Map(collected.filter((row: any) => row && typeof row.id === 'string').map((row: any) => [row.id, row])).values()];
  const suiteCases = array(e.suite?.cases), coverage = e.coverage ?? version.assessment?.coverage ?? {};
  const domains = [
    { id: 'research', label: t('研究来源与引用'), key: 'researchCases', match: (row: any) => row.domain?.executionClaim === 'frozen_source_metadata_quote_provenance_only', receipt: (row: any) => row.domain, declared: (row: any) => row.domain?.kind === 'research', limitation: t('只核对冻结来源的日期、元数据与引用出处；不代表已联网查证事实或判断语义真实性。') },
    { id: 'automation', label: t('自动化协议'), key: 'automationCases', match: (row: any) => row.domain?.executionClaim === 'isolated_protocol_fixture_state_only', receipt: (row: any) => row.domain, declared: (row: any) => row.domain?.kind === 'automation', limitation: t('核对隔离协议中的提交、幂等与故障恢复；不代表外部服务已真实交付。') },
    { id: 'browser', label: t('浏览器交互'), key: 'browserCases', match: (row: any) => row.environment?.applicable === true, receipt: (row: any) => row.environment, declared: (row: any) => row.environment?.kind === 'browser', limitation: t('运行固定的本地浏览器交互并记录错误；不代表美观度、任意网站或通用可用性已通过。') },
  ].map((domain: any) => {
    const attempts = rows.map((row: any) => row.candidate).filter((row: any) => row && domain.match(row));
    const declared = safeCount(coverage[domain.key]) ?? (suiteCases.length ? suiteCases.filter(domain.declared).length : null);
    return { id: domain.id, label: domain.label, declared, executed: attempts.length, passed: attempts.filter((row: any) => domain.receipt(row).passed === true).length, limitation: domain.limitation };
  }).filter((row: any) => (row.declared ?? 0) > 0 || row.executed > 0);
  const errorCode = version.error?.code ?? e.diagnostic?.kind, environmentUnavailable = ['environment_unavailable', 'environment_timeout', 'environment_receipt_limit', 'evaluation_artifact_directory_invalid'].includes(errorCode);
  const summary = environmentUnavailable ? t('评估环境未完成准备或运行，候选已保留，尚无完整质量结论。')
    : e.gatePassed === true ? confirmation.passed ? t('当前任务对照与独立确认均已通过。') : t('当前任务对照已通过，尚无独立确认结论。')
      : version.assessment?.label ? t('{v}。', { v: text(version.assessment.label, 70) }) : ['proposing', 'evaluating'].includes(version.state) ? t('正在检查候选，完成后会给出结论。') : t('尚无完整评估结论。');
  const enhanced = ['visualJudgedCases', 'researchReviewedCases', 'multiTurnCases', 'userTurns'].some((key: any) => safeCount(coverage[key]) !== null) ? {
    visual: safeCount(coverage.visualJudgedCases), sources: safeCount(coverage.researchReviewedCases), plannedCases: safeCount(coverage.multiTurnCases), plannedTurns: safeCount(coverage.userTurns),
    summary: t('已完成像素对照 {v} 个用例 · 已完成来源主张复核 {v2} 个用例；多轮计划 {v3} 个用例、共 {v4} 轮输入。', { v: safeCount(coverage.visualJudgedCases) ?? t('未记录'), v2: safeCount(coverage.researchReviewedCases) ?? t('未记录'), v3: safeCount(coverage.multiTurnCases) ?? t('未记录'), v4: safeCount(coverage.userTurns) ?? t('未记录') }),
    limitation: t('已完成数含筛选与已运行的独立确认；引用核对证明出处，语义判断来自模型。多轮计划数不代表全部完成，逐轮执行和用量以回执为准。') } : null;
  return { summary, phases, confirmation, domains, enhanced, exposure: evaluationExposureDisplay(e.exposure), environmentUnavailable, recorded: phaseRows.length > 0,
    counts: partitions?.counts ? Object.fromEntries(['development', 'selection', 'confirmation'].map((key: any) => [key, safeCount(partitions.counts[key])])) : null,
    requests: safeCount(ledger?.requestCount), tokens: safeCount(ledger?.usage?.totalTokens) };
}
export function evaluationExposureDisplay(exposure: Rec) {
  if (exposure?.method !== 'host-intervention-exposure-v1' || exposure.schemaVersion !== 1 || !Array.isArray(exposure.candidate?.changes)) return null;
  const labels: Record<string, string> = { system_prompt: t('项目提示词'), skill_instructions: t('技能正文'), skill_resource: t('技能资源'), skill_catalog: t('技能说明'), skill_catalog_order: t('技能目录顺序'), tool_declaration: t('工具接口'), tool_script: t('工具脚本'), tool_permission: t('工具权限'), tool_catalog_order: t('工具目录顺序'), evaluation_suite: t('评估标准'), skill_source: t('技能来源'), tool_label: t('工具名称'), tool_smoke_cases: t('工具自检') };
  const rows = exposure.candidate.changes.filter((row: any) => row && typeof row === 'object').slice(0, 200).map((row: any) => ({ kind: labels[row.kind] ?? t('能力改动'), target: text(row.target, 200), status: ['observed', 'unobserved', 'not_applicable'].includes(row.status) ? row.status : 'unknown',
    label: row.status === 'observed' ? row.mode === 'tool_execution' ? t('已由工具实际执行') : t('内容已送入模型请求') : row.status === 'unobserved' ? t('这些用例未使用此改动') : row.status === 'not_applicable' ? t('属于元数据或后续评估标准') : t('回执不足，尚不能确认') }));
  const count = (status: string) => rows.filter((row: any) => row.status === status).length;
  return { rows, summary: t('候选改动：{v} 项已进入请求或执行，{v2} 项未使用，{v3} 项待确认。', { v: count('observed'), v2: count('unobserved'), v3: count('unknown') }),
    limitation: t('送入模型或执行工具不代表改动提升了质量。未使用的技能不能凭分数变化判断有效；不会为测试强制加载所有技能。') };
}
export function retryRelations(project: Rec, version: Rec) {
  const versions = (project.versions ?? []).filter(retained);
  const source = versions.find((row: any) => row.id === version.retryOfVersionId);
  const retries = versions.filter((row: any) => row.retryOfVersionId === version.id).sort((a: any, b: any) => timestamp(b) - timestamp(a));
  return { source: source ? { id: source.id, label: source.assessment?.label ?? source.state } : null,
    retries: retries.map((row: any) => ({ id: row.id, label: row.assessment?.label ?? row.state, createdAt: row.createdAt })) };
}

const actionNames: Record<string, string> = localized({ share: '主动沟通', work: '后台研究', learn: '自主进化', wait: '保持安静', ask: '主动提问', schedule: '自主规划任务' });
const actionSummaries: Record<string, string> = localized({
  share: '计划向你分享项目的新进展。', work: '计划在后台继续研究项目。',
  learn: '计划复盘项目能力，判断是否需要改进。', wait: '当前选择保持安静，等待值得跟进的新变化。',
  ask: '有需要你判断或补充的信息。', schedule: '计划安排或调整项目的定时任务。'
});
const unavailable = (row: any): boolean => !row || row.sourceDeleted || row.contextRevoked || ['withdrawn', 'superseded'].includes(row.status);
const plain = (value: any): string => typeof value === 'string' ? value
  .replace(/```[\s\S]*?(?:```|$)/g, ' ')
  .replace(/!?(?:\[([^\]]+)\])\([^)]*\)/g, '$1')
  .replace(/<[^>]*>/g, '').replace(/`+([^`]+)`+/g, '$1')
  .replace(/(\*\*|__)([^\n]+?)\1/g, '$2')
  .replace(/(^|\s)([_*])([^\n]+?)\2(?=\s|[，。；：！？,.!?;:]|$)/g, '$1$3')
  .replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim() : '';

const bracketPairs: Record<string, string> = localized({ '(': ')', '（': '）', '[': ']', '【': '】' });
function clausesOutsideBrackets(value: string, separators: string) {
  const rows: string[] = [], stack: string[] = []; let start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (bracketPairs[char]) stack.push(bracketPairs[char]);
    else if (char === stack.at(-1)) stack.pop();
    if (!stack.length && (separators.includes(char) || char === '.' && /\s/.test(value[i + 1] ?? ''))) { rows.push(value.slice(start, i + 1).trim()); start = i + 1; }
  }
  if (start < value.length) rows.push(value.slice(start).trim());
  return rows.filter(Boolean);
}
function balanced(value: string) {
  const stack: string[] = [];
  for (const char of value) {
    if (bracketPairs[char]) stack.push(bracketPairs[char]);
    else if (Object.values(bracketPairs).includes(char) && stack.pop() !== char) return false;
  }
  return !stack.length;
}
const internalClause = (value: string) => /检查点维护|维护回执|(?:本次|此次)唤醒|(?:唤醒|回执).*触发|\brevision\s*\d|\bno_change\b/i.test(value)
  || /\b(?=[a-f\d]{7,40}\b)(?=[a-f\d]*[a-f])[a-f\d]+\b/i.test(value) && /提交|修复|commit|hash/i.test(value);
const qualification = (value: string) => /^(?:但|不过|然而|仍|尚|并未|并不|不代表|不等于|仅|只|而非|除非|否则)/.test(value);

// Extract an existing readable clause; never derive an execution result from a
// decision's rationale. Full, unchanged evidence belongs in the detail reader.
function conciseSentence(value: any, { authored = false, max = 88 }: { authored?: boolean; max?: number } = {}): string {
  let clean = plain(value)
    .replace(/[（(]\s*(?=[a-f\d]{7,64}\s*[)）])(?=[a-f\d]*[a-f])(?=[a-f\d]*\d)[a-f\d]{7,64}\s*[)）]/gi, '')
    .replace(/\b[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\b/gi, '')
    .replace(/\s+([，。；：！？])/g, '$1').trim();
  if (!clean) return '';
  // Drop a redundant execution-preparation lead-in only when the following
  // clause itself states the project outcome. No status is inferred here.
  if (!authored) clean = clean.replace(/^run\s*前准备已全部闭环\s*[：:]\s*/i, '');
  const sentences = clausesOutsideBrackets(clean, authored ? t('。！？!?') : t('。！？!?；;'));
  for (let i = 0; i < sentences.length; i++) {
    let sentence = sentences[i];
    if (!authored && internalClause(sentence)) continue;
    // A qualification belongs with its claim, even after a semicolon.
    while (qualification(sentences[i + 1] ?? '')) sentence += sentences[++i];
    if (!balanced(sentence)) continue;
    if ([...sentence].length <= max) return sentence.replace(/[；;]$/, '。');
    const clauses = clausesOutsideBrackets(sentence, t('，,'));
    let first = clauses[0];
    while (qualification(clauses[1] ?? '')) { first += clauses[1]; clauses.splice(1, 1); }
    if (first !== sentence && [...first].length >= 8 && [...first].length <= max && balanced(first)) return first.replace(/[，,]$/, '。');
    // Do not cut through parentheses, numeric constraints, or a negation to
    // satisfy a length target. The action fallback remains truthful and brief.
    if (authored && [...sentence].length <= 160) return sentence;
  }
  return '';
}

export function observationSummary(record: Rec, { kind = 'observation' }: { kind?: string } = {}): { summary: string; source: string; label: string; isModelJudgment: boolean } {
  const isModelJudgment = kind === 'decision';
  const label = record?.simulated ? t('演示记录') : isModelJudgment ? actionNames[record?.action] ?? t('主动判断') : record?.kind === 'workspace_change' ? t('目录变化') : t('项目观察');
  if (unavailable(record)) return { summary: t('这条记录已撤回或不再可用。'), source: 'unavailable', label, isModelJudgment };
  for (const field of ['summary', 'title', ...(isModelJudgment ? ['reason', 'text'] : ['text', 'reason'])]) {
    const summary = conciseSentence(record[field], { authored: field === 'summary' || field === 'title' });
    if (summary) return { summary, source: field, label, isModelJudgment };
  }
  return { summary: isModelJudgment ? actionSummaries[record.action] ?? t('已记录一次项目判断，点击查看依据。') : t('已记录一条项目观察，点击查看内容。'), source: 'fallback', label, isModelJudgment };
}

const object = (value: any): boolean => value && typeof value === 'object' && !Array.isArray(value);
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key: any) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
const equal = (left: any, right: any) => canonical(left) === canonical(right);
const assignmentSelection = (value: any) => object(value) ? Object.fromEntries(['skillIds', 'toolIds', 'mcpServerIds'].filter((key: any) => value[key] !== undefined).map((key: any) => [key, Array.isArray(value[key]) ? [...value[key]].sort() : value[key]])) : value;
const names = (rows: any[]) => rows.map((row: any) => ({ id: row.id, name: plain(row.name || row.id) }));
const emptyCounts = () => ({ added: 0, updated: 0, removed: 0 });
const validCollection = (rows: any): boolean => Array.isArray(rows) && rows.every((row: any) => object(row) && typeof row.id === 'string' && row.id) && new Set(rows.map((row: any) => row.id)).size === rows.length;
function category(key: string, label: string, before?: any, after?: any): ChangeCategory {
  const changed = !equal(before, after);
  return { key, label, changed, status: changed ? 'changed' : 'unchanged', added: [], updated: [], removed: [], counts: emptyCounts() };
}
function collectionCategory(key: string, label: string, before: any, after: any, { initial = false } = {}): ChangeCategory {
  if (!validCollection(before) || !validCollection(after)) return { ...category(key, label), changed: false, status: 'unknown' };
  const previous = new Map(before.map((row: any) => [row.id, row])), next = new Map(after.map((row: any) => [row.id, row]));
  const added = names(after.filter((row: any) => !previous.has(row.id))), removed = names(before.filter((row: any) => !next.has(row.id)));
  const updated = names(after.filter((row: any) => previous.has(row.id) && !equal(previous.get(row.id), row)));
  const changed = Boolean(added.length || updated.length || removed.length);
  return { key, label, changed, status: initial ? 'initial' : changed ? 'changed' : 'unchanged', added, updated, removed, counts: { added: added.length, updated: updated.length, removed: removed.length } };
}
function genomeComparable(version: Rec): Rec | null {
  const genome = version?.bundle?.genome;
  return object(genome) && typeof genome.systemPrompt === 'string' && validCollection(genome.skills) && validCollection(genome.tools) && object(genome.evaluationSuite) ? genome : null;
}
const versionName = (version: Rec) => typeof version?.version === 'string' && version.version ? version.version.startsWith('candidate-') ? t('候选 {v}', { v: version.version.slice(10) }) : `v${version.version}` : t('父版本');
function comparableGenome(genome: Rec) {
  return { ...genome, skills: [...genome.skills].sort((a: any, b: any) => String(a.id).localeCompare(String(b.id))), tools: [...genome.tools].sort((a: any, b: any) => String(a.id).localeCompare(String(b.id))) };
}
function changeLabel(row: Rec) {
  if (!['skills', 'tools'].includes(row.key)) return row.label;
  return t('{label}（{v}）', { label: row.label, v: [['added', t('新增')], ['updated', t('调整')], ['removed', t('移除')]].filter(([key]: any) => row.counts[key]).map(([key, label]: any) => t('{label} {v} 项', { label, v: row.counts[key] })).join(t('、')) });
}

/** Content changes are separate from quality scores and adoption. Parent lineage
 * is immutable: a different current active version must never replace it. */
export function versionChangeSummary(project: Rec, version: Rec): VersionChangeSummary {
  const baselineVersionId = version?.parentVersionId ?? version?.baseVersionId ?? version?.bundle?.parentVersionId ?? null;
  const unknown = (summary: string): VersionChangeSummary => ({ kind: 'unknown', summary, baselineVersionId, baselineLabel: null, categories: [], tags: [t('变化待确认')], comparisonAvailable: false });
  if (unavailable(version)) return unknown(t('版本记录已撤回或不再可用。'));
  if (version.simulated === true) return { ...unknown(t('演示版本，不能据此判断真实能力变化。')), tags: [t('演示记录')] };
  if (version.source === 'skill-foundation') return { kind: 'foundation', summary: t('整理并保存项目基础技能，未作收益评测；不计入进化采纳率。'), baselineVersionId, baselineLabel: null, categories: [], tags: [t('基础能力版本'), t('未作收益评测')], comparisonAvailable: false };
  if (version.state === 'no_change' && version.authorAbstention) return { kind: 'review', summary: t('已完成证据复核，未生成新的能力包；当前项目能力保持。'), baselineVersionId, baselineLabel: null, categories: [], tags: [t('复核记录'), t('无能力变更')], comparisonAvailable: false };
  const genome = genomeComparable(version);
  if (!genome) return unknown(t('尚无完整能力包，暂时无法确认改动范围。'));
  const versions = project?.versions ?? [], baseline = versions.find((row: any) => row.id === baselineVersionId);
  const retrySource = versions.find((row: any) => row.id === version.retryOfVersionId && retained(row));
  const sourceGenome = genomeComparable(retrySource);
  const sameCandidate = sourceGenome && equal(comparableGenome(genome), comparableGenome(sourceGenome)) && equal(version.policy, retrySource.policy) && equal(assignmentSelection(version.assignments), assignmentSelection(retrySource.assignments));
  const initial = !baselineVersionId && !version.retryOfVersionId && (version.state === 'baseline' || project?.initialization?.versionId === version.id);
  if (initial) {
    const categories: ChangeCategory[] = [
      { ...category('systemPrompt', t('提示词')), changed: false, status: 'initial' },
      collectionCategory('skills', t('技能'), [], genome.skills, { initial: true }),
      collectionCategory('tools', t('工具'), [], genome.tools, { initial: true }),
      { ...category('evaluationSuite', t('评估标准')), changed: false, status: 'initial' }
    ];
    return { kind: 'initial', summary: t('建立初始能力：提示词、{length} 项技能、{length2} 个工具及评估标准。', { length: genome.skills.length, length2: genome.tools.length }), baselineVersionId: null, baselineLabel: null, categories, tags: [t('初始能力')], comparisonAvailable: false };
  }
  const previous = !unavailable(baseline) && retained(baseline) ? genomeComparable(baseline) : null;
  if (!previous) return sameCandidate
    ? { ...unknown(t('重新评估原候选；父版本内容不完整，无法核对能力差异。')), kind: 'reevaluation', tags: [t('重新评估')] }
    : unknown(t('父版本内容不完整，暂时无法确认能力差异。'));
  const categories: ChangeCategory[] = [
    category('systemPrompt', t('提示词'), previous.systemPrompt, genome.systemPrompt),
    collectionCategory('skills', t('技能'), previous.skills, genome.skills),
    collectionCategory('tools', t('工具'), previous.tools, genome.tools),
    category('evaluationSuite', t('评估标准'), previous.evaluationSuite, genome.evaluationSuite)
  ];
  // Some retained versions also carry explicit behavior policies/assignments.
  // These are shown separately; evaluation receipts, hashes and prose are not
  // capability changes and must never turn a retry into an "improvement".
  for (const [key, label] of [['policy', t('行为策略')], ['assignments', t('能力分配')]]) {
    if (version[key] !== undefined && baseline[key] !== undefined) categories.push(category(key, label, key === 'assignments' ? assignmentSelection(baseline[key]) : baseline[key], key === 'assignments' ? assignmentSelection(version[key]) : version[key]));
  }
  const changed = categories.filter((row: any) => row.changed), incomplete = categories.some((row: any) => row.status === 'unknown');
  const kind = sameCandidate ? 'reevaluation' : incomplete ? 'unknown' : changed.length ? 'changed' : 'unchanged';
  const summary = sameCandidate ? t('重新评估已有候选，未修改原候选的提示词、技能或工具。')
    : incomplete ? t('部分能力记录不完整，无法完整核对改动范围。')
    : changed.length ? t('调整{v}。', { v: changed.map(changeLabel).join(t('、')) }) : t('与父版本相比，未发现已记录的能力内容变化。');
  return { kind, summary, baselineVersionId, baselineLabel: versionName(baseline), categories, tags: sameCandidate ? [t('重新评估')] : changed.length ? changed.map((row: any) => row.label) : incomplete ? [t('变化待确认')] : [t('无能力变更')], comparisonAvailable: !incomplete };
}

/** Model-authored stopping rationale is not a quality verdict or a new timer. */
export function authorAbstentionDisplay(version: Rec) {
  if (!retained(version) || version.state !== 'no_change' || !version.authorAbstention) return null;
  const review = version.authorAbstention;
  return { label: review.reason === 'insufficient_evidence' ? t('等待更多证据') : t('本轮无需变更'), summary: text(review.summary, 600), explanation: text(review.explanation, 4000),
    revisitWhen: array(review.revisitWhen).slice(0, 4).map((row: any) => text(row.description, 800)).filter(Boolean),
    limitation: t('这是作者基于当前证据的判断，不是候选质量评分。后续关注条件不会自动新建定时任务或重复评估。') };
}

/** Explain the frozen numerical contract without rewriting it or treating a
 * single model rating as a statistical estimate of general capability. */
export function evaluationBenefitDisplay(version: Rec) {
  if (!retained(version) || version.source === 'skill-foundation') return null;
  const e = version.evaluation, base = e?.selection?.baselineScore ?? e?.baselineScore, next = e?.selection?.candidateScore ?? e?.candidateScore;
  const required = e?.suite?.thresholds?.minImprovement;
  if (e?.evaluationComplete !== true || ![base, next, required].every((value: any) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)) return null;
  const gain = next - base, ceilingLimited = base + required > 1 + 1e-12;
  return { baselineScore: base, candidateScore: next, gain, required, ceilingLimited,
    summary: t('本次评分 {v} → {v2}；分差 {v3}{v4}，冻结门槛要求至少 +{v5}。', { v: base.toFixed(4), v2: next.toFixed(4), v3: gain >= 0 ? '+' : '', v4: gain.toFixed(4), v5: required.toFixed(4) }),
    limitation: ceilingLimited ? t('基线得分下的剩余空间不足以满足此绝对提升门槛；需要独立审阅未来评估标准，当前结果和门槛保持。') : t('这是当前冻结用例的一次配对结果；还需结合行为检查、回归、用量和独立确认，不能只看分差。') };
}
