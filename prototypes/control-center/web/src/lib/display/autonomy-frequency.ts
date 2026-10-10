import { t, localized, intlTag } from '@/i18n'
/**
 * Project rhythm frequency presets and the evolution status rows.
 * Ported from the legacy `public/autonomy-frequency.js` (behavior unchanged). Inputs are raw
 * host records, so they are loosely typed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = Record<string, any>
export const FREQUENCY_PRESETS: { id: string; label: string; values: number[] }[] = localized([
  { id: 'active', label: '积极', values: [15000, 300000, 30000, 900000] },
  { id: 'balanced', label: '均衡', values: [30000, 900000, 300000, 3600000] },
  { id: 'quiet', label: '安静', values: [300000, 3600000, 900000, 21600000] },
]);
export function frequencyValues(project: Rec): number[] {
  return [project.initiative?.reviewMinMs ?? 30000, project.initiative?.reviewMaxMs ?? 900000, project.initiative?.cooldownMs ?? 300000, project.evolution?.minIntervalMs ?? 3600000];
}
export function frequencyPreset(values: number[]) { return FREQUENCY_PRESETS.find((preset: any) => preset.values.every((value: any, index: any) => value === values[index]))?.id ?? 'custom'; }
export function durationLabel(ms: number): string { return ms === 0 ? t('不设最短间隔') : ms % 3600000 === 0 ? t('{v} 小时', { v: ms / 3600000 }) : ms % 60000 === 0 ? t('{v} 分钟', { v: ms / 60000 }) : t('{v} 秒', { v: ms / 1000 }); }
export function frequencySummary(project: Rec) { const [min, max, speech, evolution] = frequencyValues(project); return t('无新证据时复查 {v}至 {v2}；主动发言 {v3}；自动进化最短间隔 {v4}。', { v: durationLabel(min), v2: durationLabel(max), v3: durationLabel(speech), v4: durationLabel(evolution) }); }

const decisionLabels: Record<string, string> = localized({ wait: '等待', work: '后台工作', share: '主动沟通', learn: '自动学习', ask: '询问用户', schedule: '自主规划任务' });
const candidateLabels: Record<string, string> = localized({ proposing: '正在生成', evaluating: '正在评估', 'awaiting-evaluation': '等待评估', ready: '可试用', rejected: '未通过评估', failed: '生成或评估失败', interrupted: '已中断', stale: '已失效', adopted: '已采用', trial: '试用中' });
const recordedTime = (value: any, formatTime: (date: Date) => string): string | null => {
  if (value === undefined || value === null || value === '' || value === 0) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? formatTime(date) : null;
};

// A decision is model intent, and a start timestamp is not a completion receipt.
// Keep these distinct from the existing candidate assessment and trial controls.
export function evolutionStatusRows(project: Rec, { formatTime = (date: Date) => date.toLocaleString(intlTag(), { hour12: false }) }: { formatTime?: (date: Date) => string } = {}): { key: string; label: string; value: string }[] {
  const evolution = project.evolution ?? {}, runtime = project.initiativeRuntime ?? {}, decision = runtime.sdkState?.lastDecision;
  const latest = (project.versions ?? []).filter((version: any) => version.parentVersionId && version.simulated !== true)
    .reduce((found: any, version: any) => !found || (Date.parse(version.createdAt) || 0) >= (Date.parse(found.createdAt) || 0) ? version : found, null);
  const started = recordedTime(evolution.lastAutonomousStartedAt, formatTime), candidateAt = recordedTime(latest?.createdAt, formatTime);
  const next = recordedTime(runtime.nextReviewAt ?? runtime.sdkState?.nextReviewAt, formatTime);
  const decisionAt = recordedTime(decision?.at, formatTime);
  const lastLearn = (runtime.sdkState?.actions ?? []).filter((action: any) => action.action === 'learn')
    .reduce((found: any, action: any) => !found || (action.startedAt ?? action.createdAt ?? 0) >= (found.startedAt ?? found.createdAt ?? 0) ? action : found, null);
  const learningStates: Record<string, string> = { queued: t('等待调度'), running: t('正在执行'), completed: t('已结束；是否通过以候选评估为准'), failed: t('执行失败'), needs_review: t('结果需要核对'), cancelled: t('已取消') };
  const cancellationReasons: Record<string, string> = { learning_requires_new_evidence: t('宿主未开始生成：没有可用证据，或所引用证据均已用于候选评估'), host_context_changed: t('旧记录未保留足够具体的取消原因') };
  const learningOutcome = lastLearn ? `${learningStates[lastLearn.status] ?? t('状态未记录')}${lastLearn.status === 'cancelled' && lastLearn.cancellationReason ? t('；{v}', { v: cancellationReasons[lastLearn.cancellationReason] ?? t('诊断：{v}', { v: String(lastLearn.cancellationReason).slice(0, 100) }) }) : ''}` : t('尚无自动学习动作记录。');
  const reason = typeof decision?.reason === 'string' ? decision.reason.trim() : '';
  const boundedReason = reason.length > 600 ? `${reason.slice(0, 600)}…` : reason;
  const learner = project.learningRuntime?.sdkState, lastReview = learner?.reviews?.at(-1);
  const learningRows = learner ? [
    { key: 'learning-backlog', label: t('工作经验复盘'), value: t('待复盘 {length} 条 · 等待条件 {length2} 条 · 等待新证据 {length3} 条 · 待生成候选 {length4} 条。与日常任务独立调度。', { length: learner.episodes.filter((row: any) => row.status === 'pending').length, length2: learner.episodes.filter((row: any) => row.status === 'deferred').length, length3: learner.episodes.filter((row: any) => row.status === 'awaiting_evidence').length, length4: learner.episodes.filter((row: any) => row.status === 'queued_experiment').length }) },
    { key: 'learning-review', label: t('最近复盘结果'), value: lastReview ? lastReview.sourceRevoked && lastReview.status === 'interrupted' && !lastReview.statusBeforeRevocation
      ? t('来源已撤销；旧记录未保留原执行状态，不能据此判断执行是否中断。')
      : `${({ reviewing: t('正在分析真实工作记录'), deferred: t('等待具体条件'), no_change: t('本批证据暂不需要改变方法'), queued_experiment: t('已形成改进假设，等待评估名额或间隔'), executing: t('正在生成与对照评估'), completed: t('实验已结束'), failed: t('复盘失败'), interrupted: t('复盘或实验已中断') } as Record<string, string>)[lastReview.status] ?? lastReview.status}${!lastReview.sourceRevoked && lastReview.decision?.reason ? t('：{v}', { v: lastReview.decision.reason.slice(0, 600) }) : ''}${lastReview.error?.code ? t('（{code}）', { code: lastReview.error.code }) : ''}${lastReview.sourceRevoked ? t('；来源已撤销，此记录仅保留历史结果，不再参与当前判断。') : ''}` : t('已启用独立复盘，等待真实工作记录。') },
    ...(lastReview?.deferredReason ? [{ key: 'learning-prerequisite', label: t('候选等待原因'), value: ({ evolution_busy: t('当前项目已有候选正在评估，完成后继续。'), trial_in_progress: t('当前有试用版本，结束试用后继续。'), baseline_bundle_required: t('等待项目基础能力包初始化完成。'), learning_source_unavailable: t('项目来源文件暂不可读，恢复后继续；已保留改进假设。'), evolution_preflight_failed: t('候选准备检查未通过，尚未派发候选模型请求。') } as Record<string, string>)[lastReview.deferredReason] ?? String(lastReview.deferredReason).slice(0, 160) }] : []),
    { key: 'learning-limits', label: t('验证范围'), value: t('候选必须通过当前冻结评估才可试用；文字问答与脚本检查不能证明页面视觉品质。新对话继续保留，不会取消正在进行的独立评估。') },
  ] : [];
  return [
    { key: 'enabled', label: t('自动进化'), value: `${evolution.enabled === true ? t('已开启') : evolution.enabled === false ? t('已关闭') : t('尚未配置')}${project.initiative?.enabled === false ? t('；项目主动能力已暂停') : ''}` },
    { key: 'interval', label: t('尝试的最短间隔'), value: t('{v}。到期只允许再次尝试，不保证按周期生成或推送新版本。', { v: durationLabel(frequencyValues(project)[3]) }) },
    { key: 'started', label: t('最近自动学习启动'), value: started ? t('{started}；启动记录不表示候选生成或评估完成。', { started }) : t('尚无自动学习启动记录。') },
    ...learningRows,
    ...(!learner ? [{ key: 'learning-action', label: t('最近学习动作（宿主记录）'), value: learningOutcome }] : []),
    { key: 'candidate', label: t('最近候选'), value: latest ? `${candidateAt ?? t('创建时间未记录')} · ${latest.assessment?.label ?? candidateLabels[latest.state] ?? t('状态未记录')}` : t('尚无候选记录。') },
    { key: 'decision', label: t('最近模型判断（不是执行回执）'), value: decision ? `${decisionLabels[decision.action] ?? t('其他判断')}${decisionAt ? ` · ${decisionAt}` : ''}${boundedReason ? t('：{boundedReason}', { boundedReason }) : t('；未记录判断理由。')}` : t('尚无模型判断记录。') },
    { key: 'review', label: t('下次项目复查'), value: project.initiative?.enabled === false ? t('主动能力已暂停{v}。', { v: next ? t('；原计划 {next}', { next }) : '' }) : next ? t('{next}；这是项目复查计划，不是学习启动承诺，新证据可提前触发判断。', { next }) : t('尚未记录下次复查时间。') },
  ];
}
