import { t, localized, intlTag } from '@/i18n'
import { plainTaskText, scheduledTaskOf } from '@/lib/tasks'
import { actionReason } from '@/lib/task-failure'
/**
 * Retained action, job and delivery receipts for the tasks view.
 * Ported from the legacy `public/initiative-activity-ui.js` (behavior unchanged). Inputs are raw
 * host records, so they are loosely typed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = Record<string, any>
export interface ActivityRow {
  id: string; kind: string; label: string; status: string; statusLabel: string; active: boolean; paused?: boolean
  delivered?: boolean; deliverySessionId?: string | null; deliveryItemId?: string | null; questionStatus?: string | null; intent: string; summary: string; reason: string; detail: string; errorCode: string
  jobStatus?: string; jobStatusLabel?: string | null; at?: string | number; planSaved?: boolean; receiptAt?: string | null; controlRevision?: number
  counts: null | { total: number; completed: number; failed: number; uncertain: number }
  receipts: { toolName: string; status: string; at?: string; output: string; truncated: boolean }[]
}
// Read-only projection of retained action, job and delivery receipts. A model
// summary or a successful tool call is not proof of the overall task's quality.
const labels: Record<string, string> = localized({ work: '自主执行', learn: '候选改进', share: '主动分享', ask: '主动提问', schedule: '自主规划' });
const statuses: Record<string, string> = localized({ queued: '等待执行', running: '执行中', paused: '已暂停', completed: '已结束', failed: '未完成', cancelled: '已取消', needs_review: '结果待核对', interrupted: '已中断' });
const text = (value: any, length = 600): string => typeof value === 'string' ? value.slice(0, length) : '';
const timestamp = (value: any): number => { const n = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(n) ? n : 0; };
export const activityTime = (value: any): string => timestamp(value) ? new Date(timestamp(value)).toLocaleString(intlTag(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const visible = (row: any): boolean => row && !row.sourceDeleted && !row.contextRevoked && row.simulated !== true;
const count = (n: any): number => Number.isSafeInteger(n) && n >= 0 ? n : 0;
export function actionControlStatus(action: Rec): string {
  const pending = action.status === 'running' && [...(action.controls ?? [])].reverse().find((control: any) => control.status === 'pending' && ['pause', 'cancel'].includes(control.kind));
  return pending ? pending.kind === 'pause' ? t('正在暂停') : t('正在停止') : action.status === 'cancelled' && action.controls?.some((control: any) => control.kind === 'cancel' && control.status === 'applied') ? t('已停止') : statuses[action.status] ?? t('状态未知');
}

/** The delivery an item is, keyed `share:<actionId>` (the shared message) or `ask:<actionId>` (the question card), or null. */
export function deliveryReceipt(item: Rec, sessionId: string): [string, Rec] | null {
  if (!visible(item)) return null;
  if (item.kind === 'assistant' && item.source === 'initiative' && item.initiativeActionId) return [`share:${item.initiativeActionId}`, { at: item.createdAt, sessionId, itemId: item.id }];
  const interaction = item.interaction;
  if (item.kind === 'question' && item.source === 'interaction' && visible(interaction) && interaction.source === 'initiative' && interaction.actionId) {
    return [`ask:${interaction.actionId}`, { at: item.createdAt, sessionId, itemId: item.id, interactionId: interaction.id, questionStatus: interaction.status }];
  }
  return null;
}

export function projectActivity(project: Rec, sessions: Rec[] = []): ActivityRow[] {
  if (!project || project.simulated === true || project.decisionMode === 'demo-policy') return [];
  const jobs = new Map<string, Rec>((project.jobs ?? []).filter(visible).map((job: any) => [job.id, job]));
  const deliveries = new Map<string, Rec>();
  for (const session of sessions.filter((session: any) => session.projectId === project.id)) for (const item of session.items ?? []) {
    const receipt = deliveryReceipt(item, session.id);
    if (receipt) deliveries.set(...receipt);
  }
  const actions = (project.initiativeRuntime?.sdkState?.actions ?? []).filter((action: any) => visible(action) && labels[action.action]).map((action: any) => {
    const job = jobs.get(action.id), delivery = deliveries.get(`${action.action}:${action.id}`), planReceipt = (project.scheduleManagementReceipts ?? []).find((receipt: any) => receipt.actionId === action.id);
    const receipts = (job?.toolReceipts ?? []).filter((receipt: any) => receipt.recordedByHost === true).slice(-12).map((receipt: any) => ({ toolName: text(receipt.toolName, 100), status: text(receipt.status, 30), at: receipt.at, output: text(receipt.output, 2000), truncated: receipt.truncated === true }));
    const counts = job?.toolReceiptCounts ? Object.fromEntries(['total', 'completed', 'failed', 'uncertain'].map((key: any) => [key, count(job.toolReceiptCounts[key])])) : null;
    const communication = ['share', 'ask'].includes(action.action), active = ['queued', 'running'].includes(action.status);
    const scheduled = action.hostSchedule?.key && (project.scheduleRuntime?.occurrences ?? []).some((row: any) => row.key === action.hostSchedule.key && [row.actionId, row.deliveryActionId].includes(action.id));
    // A scheduled run's content and reason are the host's own instructions to the worker; the user reads the schedule.
    const schedule = action.hostSchedule ? (project.schedules ?? []).find((row: any) => row.id === action.hostSchedule.scheduleId) : null;
    // What this run was given (the schedule may have been edited or deleted since it ran).
    // The decision's evidence handles (E3 …) pointed into that one decision, and host record ids and tool names
    // (turn e666f3a6, project_write) mean nothing to the user: both are left out, as in the host's task names.
    const intent = action.hostSchedule && action.action === 'work' ? text(scheduledTaskOf(action) || schedule?.task, 2000) : plainTaskText(text(action.content, 2000));
    const reason = !action.hostSchedule ? plainTaskText(text(action.reason, 1200)) : action.action === 'share' ? t('定时任务做完了，结果送到它设置的对话。') : schedule ? t('到了定时任务「{title}」设定的时间。', { title: text(schedule.title, 160) }) : t('到了定时任务设定的时间。');
    const deliveryLabel = ({ pending: t('已送达 · 待回答'), answered: t('已送达 · 已回答'), cancelled: t('已送达 · 问题已取消'), interrupted: t('已送达 · 回答已中断') } as Record<string, string>)[delivery?.questionStatus] ?? t('已送达会话');
    const statusLabel = communication ? delivery ? deliveryLabel : action.status === 'cancelled' ? t('未发送 · 已取消') : active ? t('等待发送') : action.status === 'completed' ? t('已结束 · 未找到消息回执') : statuses[action.status] ?? t('状态未知') : action.action === 'schedule' && action.status === 'completed' ? planReceipt ? t('已保存任务安排') : t('已结束 · 未找到安排回执') : actionControlStatus(action);
    return { id: action.id, kind: action.action, label: scheduled ? action.action === 'share' ? t('定时交付') : t('定时任务') : labels[action.action], status: action.status, statusLabel, active, delivered: Boolean(delivery), deliverySessionId: delivery?.sessionId ?? null, deliveryItemId: delivery?.itemId ?? null, questionStatus: delivery?.questionStatus ?? null,
      // A share / ask's resultSummary is the host's receipt for the model (English, question ids); the user reads userSummary (C-d).
      intent, summary: communication ? text(action.userSummary, 6000) : text(planReceipt?.summary || action.resultSummary || job?.output, 6000), reason, planSaved: Boolean(planReceipt),
      // Codes nobody mapped yet read as a general line, never as the code (F13). What it waits for only while it waits:
      // a cancelled action keeps its last wait (the SDK clears it only when the action runs), which is not why it was cancelled.
      detail: action.status === 'queued' ? actionReason(action.deferredReason, 'deferred') : actionReason(action.cancellationReason, 'cancelled'),
      errorCode: text(action.failure?.code ?? action.errorCode ?? job?.errorCode, 120),
      jobStatus: job?.status, jobStatusLabel: job ? statuses[job.status] ?? text(job.status, 40) : null,
      at: delivery?.at ?? action.finishedAt ?? action.startedAt ?? action.createdAt ?? job?.completedAt ?? job?.createdAt,
      receiptAt: receipts.at(-1)?.at ?? null, counts, receipts, paused: action.status === 'paused', controlRevision: action.controlRevision,
    };
  });
  const learning = (project.learningRuntime?.sdkState?.reviews ?? []).filter((row: any) => !row.sourceRevoked).slice(-4).map((row: any) => ({
    id: row.id, kind: 'learning-review', label: t('自主学习'), status: row.status,
    statusLabel: ({ reviewing: t('复盘工作经验'), queued_experiment: t('等待候选评估'), executing: t('生成与评估候选'), completed: t('实验结束'), no_change: t('已复盘 · 暂不改进'), deferred: t('等待具体条件'), failed: t('复盘失败'), interrupted: t('已中断') } as Record<string, string>)[row.status] ?? row.status,
    active: ['reviewing', 'queued_experiment', 'executing'].includes(row.status), intent: text(row.decision?.intervention || row.decision?.reason || t('分析真实完成记录中的可复用经验'), 2000),
    summary: text(row.result?.summary || row.decision?.diagnosis, 6000), reason: text(row.decision?.reason, 1200), errorCode: text(row.error?.code, 120), at: row.completedAt ?? row.executionStartedAt ?? row.startedAt,
    detail: row.result?.status === 'ready' ? t('当前冻结评估通过，可查看版本并试用。') : row.result?.status === 'rejected' ? t('候选未通过评估，已保留诊断。') : t('复盘结论是待验证假设；候选是否可试用以独立评估为准。'), counts: null, receipts: [],
  }));
  return [...actions, ...learning].sort((a: any, b: any) => Number(b.active) - Number(a.active) || Number(b.paused === true) - Number(a.paused === true) || timestamp(b.at) - timestamp(a.at) || a.id.localeCompare(b.id)).slice(0, 20);
}

export function continuationLabel(turn: Rec): string {
  const value = turn?.continuation;
  if (!value || !Number.isSafeInteger(value.segments) || value.segments < 1) return '';
  // Long work continues in slices; the user only needs to know it is carrying on.
  return ({ paused: t('已暂停'), stopped: t('已停止'), failed: t('未完成') } as Record<string, string>)[turn.status]
    ?? ({ scheduled: t('正在继续'), running: t('正在继续'), completed: '' } as Record<string, string>)[value.status] ?? '';
}

