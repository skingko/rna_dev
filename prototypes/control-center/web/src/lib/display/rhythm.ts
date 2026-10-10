import { t, localized, intlTag } from '@/i18n'
/**
 * Read-only projection of the host's admitted project rhythm.
 * Ported from the legacy `public/adaptive-autonomy-display.js` (behavior unchanged). Inputs are raw
 * host records, so they are loosely typed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = Record<string, any>
export interface RhythmDisplay {
  available: boolean; control: string; title: string; reason: string; lifecycle?: string; modelReason?: string
  initiative?: string; initiativeReason?: string; evolution?: string; evolutionReason?: string; quota?: string; schedule?: string
  /** `causes`: the blocker in plain words; `diagnostics`: the host's raw codes, for support only. */
  blocker?: { reason?: string; pendingCount?: number; attempts?: number; retryAt?: string | null; causes?: string[]; diagnostics?: string[]; /** @deprecated never set; render `causes`. */ codes?: string[] }
  assessedAt?: string | null
  history: { at: string | null; stage: string; reason: string; initiative: string; evolution: string }[]
}
// A read-only projection of the host's admitted rhythm. It never infers a
// finished project from an assistant message or changes the user's switches.
const stages: Record<string, string> = localized({ active: '持续推进', recurring: '周期交付', blocked: '等待条件', complete: '阶段已完成' });
const nextTime = (value: any): string | null => {
  const epoch = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(epoch) && epoch > 0 ? new Date(epoch).toLocaleString(intlTag(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : null;
};
const bounded = (value: any, max = 800): string => typeof value === 'string' ? value.slice(0, max) : '';
/** Labels for every lane reason `resolveProjectRhythm` (packages/sdk/src/project-rhythm.mjs) can return; a spec keeps them in step. */
export const RHYTHM_REASONS: Record<string, string> = localized({
  user_disabled: '用户已关闭此项能力', manual_control: '按人工设置的频率运行',
  initiative_disabled: '项目主动协作已由用户关闭', evolution_disabled: '自主进化已由用户关闭', emergency: '全局已急停', project_archived: '项目已归档',
  assessment_required: '等待根据最新项目证据调整节奏', new_evidence: '有新的项目证据', event_only: '等待新的项目证据', event_only_wait: '等待新的项目证据',
  project_complete: '当前阶段已完成，等待新需求或反馈', project_blocked: '等待可推进的新条件', no_new_evidence: '暂无新的可复盘证据',
  review_interval: '尚未到复查时刻', min_interval: '尚未到最早复盘时刻', daily_quota: '已达到滚动 24 小时复盘上限', weekly_quota: '已达到滚动 7 天复盘上限',
  evolution_off: '当前项目状态暂不需要自动进化', schedule_due: '项目日程已到执行时间', schedule_wait: '等待下一次项目日程',
  awaiting_scheduled_work: '交付由项目日程执行，期间不重复调用模型复查', recurring_schedule_missing: '识别为周期交付，但尚未登记可执行日程',
  awaiting_changed_prerequisite: '等待阻塞条件发生变化', awaiting_evidence: '等待新的项目证据', review_due: '已到项目复查时刻',
  adaptive_evolution_off: '模型依据当前项目状态暂停自动复盘', no_unreviewed_evidence: '暂无尚未复盘的新证据', automatic_review_quota_zero: '自动复盘额度为零',
  learning_due: '已有新证据且已到可复盘时刻', learning_interval: '尚未到最早复盘时刻', daily_review_quota: '已达到滚动 24 小时复盘上限', weekly_review_quota: '已达到滚动 7 天复盘上限',
  conversation_live: '你正在对话，现在就跟进', conversation_follow_up: '你正在对话，几分钟内会跟进',
  user_steering: '你刚纠正或提出了改进，现在据此复盘', steering_gap: '你刚纠正或提出了改进，稍后据此复盘',
});
/** Host admission waits (project-initiative-availability.mjs) in the interface language; the host's own text is the fallback. */
const ADMISSION: Record<string, { title: string; message: string }> = localized({
  real_project_required: { title: '等待真实项目初始化', message: '项目尚未启用真实模型协作。' },
  initialization_pending: { title: '等待项目初始化', message: '项目能力初始化尚未完成，后台协作等待就绪。' },
  session_cleanup_pending: { title: '后台暂缓 · 会话清理待完成', message: '会话关联数据仍在清理，主动协作、定时交付与自动进化暂缓。清理完成后按原设置继续。' },
  interactive_subscription_only: { title: '后台等待可用模型', message: '当前模型仅支持交互式使用，请为后台协作选择支持自动运行的模型。' },
  model_unavailable: { title: '后台等待可用模型', message: '项目后台模型配置不可用，请检查已选择的提供商、模型与推理档位。' },
  real_model_required: { title: '后台等待真实模型', message: '后台协作需要已配置的真实模型。' },
});
/** Session-cleanup blocker codes as plain causes; the raw codes stay in `diagnostics`. */
const CLEANUP_CAUSES: Record<string, string> = localized({
  SESSION_EVIDENCE_JOURNAL_UNKNOWN: '有一份后台记录无法识别，等待核对后继续清理',
  SESSION_BACKGROUND_CLEANUP_PENDING: '后台任务还在收尾，结束后继续清理',
  SESSION_CLEANUP_PENDING: '会话清理还没完成',
  SESSION_EVIDENCE_SCAN_LIMIT: '关联记录较多，正在分批清理',
  SESSION_EVIDENCE_INVALID_PATH: '有一条关联记录的位置无效，等待核对',
  SESSION_EVIDENCE_LINK_UNSAFE: '有一条关联记录是不安全的链接，等待核对',
  SESSION_CLEANUP_DECISION: '有一项会话清理需要你决定，详情在「已归档」里',
});
export function rhythmReason(value: any): string { return RHYTHM_REASONS[value] ?? (value ? t('调度依据：{v}', { v: bounded(value, 120) }) : t('等待运行状态更新')); }
function blockerOf(admission: Rec): NonNullable<RhythmDisplay['blocker']> {
  const { codes, ...details } = admission.details ?? {}, raw: string[] = Array.isArray(codes) ? codes.filter((code: unknown) => typeof code === 'string') : [];
  const causes = [...new Set(raw.map(code => CLEANUP_CAUSES[code] ?? CLEANUP_CAUSES.SESSION_CLEANUP_PENDING))];
  return { reason: admission.reason, ...details, retryAt: nextTime(details.retryAt), ...(causes.length ? { causes, diagnostics: raw } : {}) };
}
const epochOf = (value: any): number | null => {
  const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
};
/** The next runs the host recorded for the project's enabled schedules (`schedules[].nextRunAt`); null without schedules. */
const scheduledRuns = (project: Rec): number[] | null => Array.isArray(project.schedules)
  ? project.schedules.filter((row: any) => row?.enabled === true && row.nextRunAt != null).map((row: any) => epochOf(row.nextRunAt)).filter((at: number | null): at is number => at !== null)
  : null;
/**
 * Schedules whose next run the clock has passed (as the SDK's `schedule.dueCount` counts them). The index row carries
 * the anchors (`schedules[].nextRunAt`), not this count, so a schedule coming due changes no row (stream-protocol-v2 §1):
 * it is counted when the card renders. A record without `schedules` keeps the count its host made.
 */
export function dueScheduleCount(project: Rec = {}, now = Date.now()): number {
  const runs = scheduledRuns(project);
  if (runs) return runs.filter(at => at <= now).length;
  const count = project.rhythmStatus?.schedule?.dueCount;
  return typeof count === 'number' && count > 0 ? count : 0;
}
/** When the card's text next changes by the clock alone: the earliest scheduled run still ahead of `now`, or null. */
export function rhythmChangesAt(project: Rec = {}, now = Date.now()): number | null {
  const ahead = (scheduledRuns(project) ?? []).filter(at => at > now);
  return ahead.length ? Math.min(...ahead) : null;
}
export function adaptiveRhythmDisplay(project: Rec = {}, now = Date.now()): RhythmDisplay {
  const status = project.rhythmStatus, control = status?.control ?? project.rhythm?.control ?? 'auto';
  if (!status) return { available: false, control, title: control === 'manual' ? t('手动固定节奏') : t('自动适配 · 等待项目判断'), reason: t('项目节奏状态尚未同步。'), history: [] };
  const a = status.assessment, initiative = status.initiative ?? {}, evolution = status.evolution ?? {}, schedule = status.schedule ?? {}, quota = evolution.quota;
  const hardOff = project.initiative?.enabled === false, evolutionOff = project.evolution?.enabled === false;
  const admission = project.initiativeRuntime?.availability, blocked = !hardOff && admission?.state === 'blocked';
  const known = blocked ? ADMISSION[admission.reason] : undefined, blockedTitle = known?.title ?? (bounded(admission?.title, 120) || t('后台暂缓')), blockedMessage = known?.message ?? bounded(admission?.message);
  const title = hardOff ? t('主动协作已关闭') : blocked ? blockedTitle : control === 'manual' ? t('手动固定节奏') : status.assessmentRequired ? t('自动适配 · 正在等待判断') : t('自动适配 · {v}', { v: stages[status.lifecycle] ?? t('关注项目') });
  const initiativeAt = nextTime(initiative.nextAt), evolutionAt = nextTime(evolution.nextAt), scheduledAt = nextTime(schedule.nextAt);
  const dueCount = dueScheduleCount(project, now);
  const evolutionMode = ({ evidence: t('有新证据时复盘'), daily: t('按日复盘'), weekly: t('按周复盘'), off: t('暂不自动复盘') } as Record<string, string>)[a?.evolution?.mode];
  const quotaLabel = control === 'auto' && a && quota ? t('滚动 24 小时 {v}/{v2} 次 · 滚动 7 天 {v3}/{v4} 次', { v: quota.dayUsed ?? 0, v2: quota.maxPerDay ?? '—', v3: quota.weekUsed ?? 0, v4: quota.maxPerWeek ?? '—' }) : '';
  return { available: true, control, title, lifecycle: stages[status.lifecycle] ?? t('待判断'),
    modelReason: bounded(a?.reason, 8000),
    // The model's rationale is scheduling input written for the host (field names, revisions): it stays under 模型判断, the headline is the host's reason.
    reason: blocked ? blockedMessage : control === 'manual' ? t('使用已保存的固定频率，新的项目事件仍可唤醒判断。') : rhythmReason(initiative.reason),
    initiative: hardOff ? t('主动协作已关闭') : blocked ? t('暂缓，等待后台条件恢复') : status.effective?.initiativeEnabled === false ? t('当前暂停普通复查') : control === 'manual' ? t('按手动频率复查项目') : initiative.reason === 'awaiting_scheduled_work' ? t('交付间隙保持安静 · 日程照常执行') : initiative.reason === 'recurring_schedule_missing' ? t('周期交付尚未安排日程') : initiative.eligible ? t('可根据项目状态行动') : a?.initiative?.mode === 'event_only' ? t('等待新证据再判断') : initiativeAt ? t('下次复查 {initiativeAt}', { initiativeAt }) : t('等待新的项目变化'),
    initiativeReason: blocked ? blockedMessage : rhythmReason(initiative.reason),
    evolution: evolutionOff ? t('自主进化已关闭') : blocked ? t('暂缓，已保存的复盘节奏保留') : status.effective?.evolutionEnabled === false ? t('当前暂停自动复盘') : control === 'manual' ? t('按手动频率与项目证据复盘') : [evolutionMode || t('根据证据安排复盘'), evolution.eligible ? t('当前可复盘') : evolutionAt ? t('最早 {evolutionAt}', { evolutionAt }) : t('等待新证据或条件')].join(' · '),
    evolutionReason: blocked ? blockedMessage : rhythmReason(evolution.reason), quota: quotaLabel,
    schedule: blocked && schedule.activeCount > 0 ? t('日程暂缓{v}', { v: scheduledAt ? t(' · 原计划 {scheduledAt}', { scheduledAt }) : '' }) : dueCount > 0 ? t('{dueCount} 项日程到期，等待执行或投递', { dueCount }) : scheduledAt ? t('下次任务 {scheduledAt}', { scheduledAt }) : schedule.activeCount > 0 ? t('项目日程已登记，等待调度状态更新') : t('暂无定时任务'),
    ...(blocked ? { blocker: blockerOf(admission) } : {}),
    assessedAt: nextTime(status.assessedAt),
    history: (status.history ?? []).slice(-5).reverse().map((row: any) => ({ at: nextTime(row.at), stage: stages[row.lifecycle] ?? t('项目节奏'), reason: bounded(row.reason), initiative: ({ adaptive: t('适时复查'), event_only: t('仅新证据唤醒') } as Record<string, string>)[row.initiativeMode] ?? '', evolution: ({ evidence: t('证据驱动复盘'), daily: t('按日复盘'), weekly: t('按周复盘'), off: t('暂停自动复盘') } as Record<string, string>)[row.evolutionMode] ?? '' })) };
}
