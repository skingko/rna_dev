import { createHash } from 'node:crypto';
import { actionLabel, withoutHandles, withoutInternals } from './task-text.mjs';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';
import { STEP_KINDS, stepKind, toolKind } from './live-bus.mjs';

const fail = (message, code, status = 409) => { throw Object.assign(new Error(message), { code, status }); };
const copy = value => structuredClone(value);
const iso = value => Number.isFinite(value) ? new Date(value).toISOString() : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
// What a share or ask came to, in the user's words (C-d, F12). The handler's summary is the receipt written for the
// model (English, question ids); the host keeps an outcome code for the user's version.
const DELIVERY = {
  shared: { zh: '已发到对话里。', en: 'Posted in the conversation.' },
  notified: { zh: '已发到对话里，并发了桌面通知。', en: 'Posted in the conversation, with a desktop notification.' },
  shared_quietly: { zh: '已发到对话里，没有提醒你。', en: 'Posted in the conversation without notifying you.' },
  filed: { zh: '已放进收件箱，没有打断你。', en: 'Filed in the inbox without interrupting you.' },
  digest: { zh: '已放进收件箱，会在每日摘要里一起告诉你。', en: 'Filed in the inbox for the daily digest.' },
  held: { zh: '先记在相关话题里，下次聊到这个话题或你回来时一起告诉你。', en: 'Kept with its topic; you get it the next time the topic comes up or when you are back.' },
  fixed: { zh: '已直接修正，等你在对话里确认保留或回退。', en: 'Fixed directly; keep or revert the changes in the conversation.' },
  asked: { zh: '已在对话里提问。', en: 'Asked in the conversation.' },
  permission_granted: { zh: '需要的权限已经有了，没有再问你。', en: 'The permission was already granted, so you were not asked again.' }
};
// Actions delivered before the outcome code existed: read from how they were delivered (the host's own receipt texts,
// and the delivered message, which has its conversation item when it was posted there). A quiet delivery whose receipt
// text a scope change removed may have been held, filed or posted quietly: without its message nothing is claimed.
function deliveryOutcome(action, entry) {
  if (DELIVERY[action.deliveryOutcome]) return action.deliveryOutcome;
  const summary = String(action.resultSummary ?? '');
  if (action.action === 'ask') return summary.startsWith('The requested project permission is already granted') ? 'permission_granted' : 'asked';
  if (summary.startsWith('Held in its conversation thread')) return 'held';
  if (summary.startsWith('Handled directly')) return 'fixed';
  if (action.deliveredReach === 'inbox' && entry?.itemId) return 'shared_quietly';
  if (['inbox', 'digest'].includes(action.deliveredReach) && !summary && !entry) return null;
  return { notify: 'notified', inline: 'shared', inbox: 'filed', digest: 'digest' }[action.deliveredReach] ?? 'shared';
}
/** A completed share/ask's outcome for the task page; an outcome the user settled by hand has their own words instead.
 * `entry`: the inbox entry it delivered, when the caller has it (it tells an older quiet delivery's outcome). */
export function deliverySummary(action, language = 'zh', entry = null) {
  const outcome = ['share', 'ask'].includes(action?.action) && action.status === 'completed' && !action.resolvedAt ? deliveryOutcome(action, entry) : null;
  return outcome ? inLanguage(language, DELIVERY[outcome]) : undefined;
}
// The SDK records an action's times as epoch ms; every view the user reads gives ISO instants (layout plan H1).
const isoTimes = action => Object.fromEntries(['createdAt', 'startedAt', 'finishedAt'].filter(key => action[key] !== undefined && action[key] !== null).map(key => [key, iso(action[key]) ?? null]));
const KEPT = ['hostSchedule', 'urgency', 'deliveredReach', 'deliveryOutcome', 'cancellationReason', 'errorCode', 'failure', 'blocksExecution', 'reasonForReview', 'resolvedAt', 'resolutionOutcome', 'simulated'];
/**
 * An action revoked by a scope change (a new conversation, another model, an adopted version …) stays in the user's
 * record of what happened (F40/F53/F82), read-only. Its SDK content is a placeholder for the model and is never shown;
 * the record comes from what the host kept for the user: the job (title, instruction, handoff), the delivered message
 * and the schedule it ran for. One still waiting to be checked is always listed: it may gate the foreground (F84).
 */
const keptName = (project, action, job, entry, options) => actionLabel(project, { action: action.action, hostSchedule: action.hostSchedule, title: job?.title, content: job?.instruction ?? entry?.text ?? '' }, options);
const kept = row => !row.sourceDeleted && !row.contextRevoked;
/** The name of a revoked action from what the host kept for the user (its job or delivered message); '' when nothing was kept. */
export function revokedLabel(project, action, options = {}) {
  const job = project?.jobs?.find(row => row.id === action.id && kept(row));
  return keptName(project, action, job, job ? null : project?.inbox?.find(row => row.actionId === action.id && kept(row)), options);
}
function revokedView(project, action, { jobs, inbox, language }) {
  const job = jobs.get(action.id), entry = job ? null : inbox.get(action.id);
  const label = keptName(project, action, job, entry, { language });
  if (!label && action.status !== 'needs_review') return null;
  const handoff = job?.handoff ? withoutHandles(job.handoff) : undefined, summary = deliverySummary(action, language, inbox.get(action.id));
  const startedAt = iso(action.startedAt) ?? iso(job?.createdAt), finishedAt = iso(action.finishedAt) ?? iso(job?.completedAt) ?? iso(action.resolvedAt);
  const receipt = { label, status: action.status, ...(startedAt ? { startedAt } : {}), ...(finishedAt ? { finishedAt } : {}), ...(handoff ? { handoff } : {}) };
  return { id: action.id, action: action.action, status: action.status, revoked: true, label, receipt, content: '', ...(handoff ? { handoff } : {}), ...(summary ? { userSummary: summary } : {}),
    ...Object.fromEntries(KEPT.filter(key => action[key] !== undefined).map(key => [key, copy(action[key])])), controlRevision: action.controlRevision ?? 0, availableControls: [], attention: project.taskMarks?.[action.id] ?? null };
}
/**
 * The project's background actions as the user sees them (task page, sidebar, conversation controls). `label` is the
 * name to show (actionLabel); revoked actions come as read-only receipts with `revoked: true`. Callers that feed a
 * model must drop revoked rows: they belong to a previous scope.
 */
export function backgroundActionView(controller, projectId) {
  const project = controller.project(projectId);
  if (!project) fail('项目不存在', 'project_not_found', 404);
  const context = controller.contexts.get(projectId);
  const available = context && !context.closing && controller.valid(context);
  // A result from a deleted conversation is left out, unless it still waits to be checked: it holds every foreground
  // turn back, so it is listed (as a receipt) wherever that refusal points the user (C2-d).
  const language = interfaceLanguageOf(controller.store?.state), rows = (context?.coordinator.state.actions ?? project.initiativeRuntime?.sdkState?.actions ?? []).filter(action => !action.sourceDeleted || action.status === 'needs_review' && action.blocksExecution === true);
  const delivered = new Map((project.inbox ?? []).filter(row => row.actionId && kept(row)).map(row => [row.actionId, row]));
  const records = { language, jobs: new Map((project.jobs ?? []).filter(kept).map(row => [row.id, row])), inbox: delivered };
  // A scheduled run carries its occurrence's 执行 → 交付 state. The project's index row keeps only the latest, open and
  // `work`-listed occurrences (index-schema scheduleRuntimeRow); the tasks panel lists a day of finished runs from here,
  // and one whose occurrence the row left out would read as not delivered.
  const occurrences = Array.isArray(project.scheduleRuntime?.occurrences) ? project.scheduleRuntime.occurrences.filter(row => row && typeof row === 'object') : [];
  const occurrenceOf = action => {
    if (!action.hostSchedule) return {};
    const key = action.hostSchedule.key, row = occurrences.find(item => key && item.key === key) ?? occurrences.find(item => item.actionId === action.id || item.deliveryActionId === action.id);
    return { occurrence: row ? { key: row.key, status: row.status, ...(row.deliveredAt ? { deliveredAt: row.deliveredAt } : {}) } : null };
  };
  return { projectId, actions: rows.flatMap(action => {
    if (action.contextRevoked || action.sourceDeleted) { const row = revokedView(project, action, records); return row ? [{ ...row, ...occurrenceOf(action) }] : []; }
    const controls = action.controls ?? [], pending = controls.filter(row => row.status === 'pending');
    const boundary = pending.find(row => ['pause', 'cancel'].includes(row.kind));
    let availableControls = [];
    if (available && action.action === 'work' && !boundary) {
      if (['running', 'queued'].includes(action.status)) availableControls = ['pause', 'stop', 'steer'];
      else if (action.status === 'paused') availableControls = ['resume', 'stop', 'steer'];
    }
    // label: how the user knows this action (its decision's title; a scheduled run by its schedule's title, see actionLabel).
    const summary = deliverySummary(action, language, delivered.get(action.id));
    return [{ ...copy(action), ...isoTimes(action), ...occurrenceOf(action), label: actionLabel(project, action, { language }), ...(summary ? { userSummary: summary } : {}), controlRevision: action.controlRevision ?? 0, availableControls, attention: project.taskMarks?.[action.id] ?? null,
      ...(boundary && action.status === 'running' ? { controlState: boundary.kind === 'pause' ? 'pausing' : 'stopping' } : {}) }];
  }) };
}

/*
 * summary.work (layout plan H2): background runs as the tasks panel shows them. The project summary carries them, so
 * the panel stays live from the index stream without fetching. Slim (no receipts, no output text) and stable: nothing
 * in it ticks with the clock, so an unchanged run keeps the summary's hash and StreamHub sends nothing for it.
 */
const ACTIVE_RUN = ['running', 'needs_review', 'paused', 'queued'], ENDED_RUN = ['completed', 'failed', 'cancelled', 'interrupted'];
// A job outlives its action (finished actions leave the SDK state first): the job's own status, in a run's words.
const JOB_STATUS = { running: 'running', queued: 'queued', paused: 'paused', needs_review: 'needs_review', completed: 'completed', rejected: 'completed', failed: 'failed', cancelled: 'cancelled', superseded: 'cancelled', interrupted: 'interrupted' };
const STEP_STATUS = { completed: 'succeeded', failed: 'failed', uncertain: 'uncertain' };
const RUN_NAMES = { work: { zh: '后台工作', en: 'Background work' }, scheduled: { zh: '定时任务', en: 'Scheduled task' }, learn: { zh: '学习改进', en: 'Learning' } };
export const WORK_RECENT_MS = 86400000, WORK_RECENT_LIMIT = 8, WORK_RUNNING_LIMIT = 12, WORK_BYTES = 6000;
const TITLE_LIMIT = 80, SUMMARY_LIMIT = 160, TARGET_LIMIT = 80;
const clip = (text, limit) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
/** One line in the user's words: no evidence handles, record ids or host tool names. */
const userLine = (text, limit) => clip(withoutHandles(withoutInternals(String(text ?? '').replace(/\s+/g, ' ').trim())), limit);
const count = value => Math.max(0, Number(value) || 0);
const timeOf = value => { const time = Date.parse(value ?? ''); return Number.isFinite(time) ? time : 0; };

/**
 * A job's steps by kind (steps.kinds). A run recorded before kinds were counted: its retained receipts by kind, the rest
 * as other. recordToolReceipt starts such a run's counts from here when it resumes, so the kinds keep adding up to total.
 */
export function jobStepKinds(job) {
  const kinds = Object.fromEntries(STEP_KINDS.map(key => [key, 0]));
  if (job?.toolKindCounts) { for (const key of STEP_KINDS) kinds[key] = count(job.toolKindCounts[key]); return kinds; }
  const receipts = Array.isArray(job?.toolReceipts) ? job.toolReceipts : [];
  for (const row of receipts) kinds[stepKind(row.toolName)]++;
  kinds.other += Math.max(0, count(job?.toolReceiptCounts?.total) - receipts.length);
  return kinds;
}
function runSteps(job) {
  const counts = job?.toolReceiptCounts ?? {};
  // limit: the run's step cap as recorded when it started (none for scheduled or learning runs, or before it started).
  // It is not on total's scale: the cap counts model requests and starts again with each resumption, while total,
  // completed, failed and uncertain count tool calls over the whole run (a request may call several tools, or none).
  return { total: count(counts.total), completed: count(counts.completed), failed: count(counts.failed), uncertain: count(counts.uncertain), limit: Number.isInteger(job?.stepLimit) ? job.stepLimit : null, kinds: jobStepKinds(job) };
}
// The last finished step. The step running now is the live `work.step` event, which is never stored.
function latestStep(job) {
  const last = Array.isArray(job?.toolReceipts) ? job.toolReceipts.at(-1) : null;
  if (!last?.toolName || !iso(last.at)) return null;
  return { name: String(last.toolName).slice(0, 128), kind: toolKind(last.toolName), target: typeof last.target === 'string' && last.target ? clip(last.target, TARGET_LIMIT) : null, status: STEP_STATUS[last.status] ?? 'uncertain', at: iso(last.at) };
}
// Tokens so far, a paused run's earlier part included (priorUsage); estimated when any request went unreported.
function runTokens(job) {
  const parts = [job?.priorUsage, job?.usage];
  return { total: parts.reduce((sum, row) => sum + count(row?.totalTokens), 0), estimated: parts.some(row => count(row?.estimatedTokens) > 0 || row?.estimated === true) };
}
const runModel = job => typeof job?.model?.providerId === 'string' && typeof job.model.modelId === 'string' ? { providerId: job.model.providerId, modelId: job.model.modelId, name: String(job.model.name ?? job.model.modelId) } : null;
/**
 * Each run's plan items (plan: { done, total }): the working plan's todo rows it staged (doing, next) or finished. A row
 * staged by one run and finished by another counts for both; a dropped row counts for none. Built once per summary.
 */
function runPlans(mind) {
  const plans = new Map();
  for (const row of mind?.agenda ?? []) {
    if (row?.kind !== 'todo' || !['open', 'done'].includes(row.status)) continue;
    // resolvedBy names the run that finished a done row; an open row's is left from before it was reopened.
    const owners = new Set([row.stagedBy?.actionId, row.status === 'done' ? row.resolvedBy?.actionId : undefined].filter(id => typeof id === 'string' && id));
    for (const id of owners) { const plan = plans.get(id) ?? { done: 0, total: 0 }; plan.total++; if (row.status === 'done') plan.done++; plans.set(id, plan); }
  }
  return plans;
}
// The applied stop of a run cancelled while it was not running (queued, or paused at a checkpoint): the SDK records its
// time on the control (settledAt), not on the action.
const cancelledAt = action => action?.status === 'cancelled' ? action.controls?.findLast(row => row.kind === 'cancel' && row.status === 'applied')?.settledAt : undefined;

function workRun(project, { id, action, job, occurrence, language, changes, plans, now }) {
  const hostSchedule = action?.hostSchedule ?? (job?.scheduleId ? { scheduleId: job.scheduleId, key: job.occurrenceKey } : occurrence ? { scheduleId: occurrence.scheduleId, key: occurrence.key } : null);
  const learn = action ? action.action === 'learn' : job?.kind === 'evolution', kind = learn ? 'learn' : hostSchedule ? 'scheduled' : 'work';
  const status = action ? action.status : job ? JOB_STATUS[job.status] : 'queued', ended = ENDED_RUN.includes(status);
  if (!ended && !ACTIVE_RUN.includes(status)) return null;
  // An action without a job never started: still queued, or cancelled before it started (a run that started and was
  // stopped has its job, or at least its finish time).
  const unstarted = !job && (status === 'queued' || status === 'cancelled' && !iso(action?.finishedAt));
  // One cancelled before it started ended when it was stopped; when the SDK cancelled it itself (a scope change, a revoked
  // schedule) it recorded no time, and its last dispatch attempt, else its creation, stands in. Nothing ticks once it ended.
  const completedAt = ended ? iso(action?.finishedAt) ?? iso(action?.resolvedAt) ?? iso(cancelledAt(action)) ?? iso(job?.resolvedAt) ?? iso(job?.completedAt) ?? (unstarted ? iso(action?.startedAt) ?? iso(action?.createdAt) : undefined) : undefined;
  // A run that did not finish within the last day is not listed, so it is not named either: the summary is rebuilt on
  // every change, and a project keeps a few hundred finished actions and jobs.
  if (ended && !(completedAt && now - timeOf(completedAt) < WORK_RECENT_MS)) return null;
  // Named as on the task page (actionLabel); a revoked action from what the host kept for the user (revokedLabel).
  const revoked = action?.contextRevoked || action?.sourceDeleted, options = { language, limit: TITLE_LIMIT, bare: true };
  const name = revoked ? revokedLabel(project, action, options) : actionLabel(project, action ?? { action: learn ? 'learn' : 'work', ...(hostSchedule ? { hostSchedule } : {}), title: job?.title, content: job?.instruction ?? '' }, options);
  if (revoked && !name && status !== 'needs_review') return null;
  const createdAt = iso(action?.createdAt) ?? iso(job?.createdAt) ?? iso(occurrence?.claimedAt);
  if (!createdAt) return null;
  // The job starts once per run; the action's own startedAt moves on every resume. An action that never started has no
  // start: its startedAt is a dispatch the host put off (a scheduled run while the conversation works, retried every
  // second), which would tick the summary and read as elapsed time.
  const startedAt = iso(job?.createdAt) ?? (unstarted ? undefined : iso(action?.startedAt)), resumedAt = iso(job?.resumedAt), plan = plans.get(id);
  const run = { id, kind, title: name || inLanguage(language, RUN_NAMES[kind]), status, createdAt, ...(startedAt ? { startedAt } : {}), ...(resumedAt ? { resumedAt } : {}), ...(completedAt ? { completedAt } : {}),
    ...(hostSchedule?.scheduleId ? { scheduleId: hostSchedule.scheduleId } : {}), ...(hostSchedule?.key ? { occurrenceKey: hostSchedule.key } : {}),
    // latest: a completed run reads by its result (summary); a live, stopped or failed one by its last step.
    steps: runSteps(job), plan: plan ? { ...plan } : null, latest: status === 'completed' ? null : latestStep(job), tokens: runTokens(job), model: runModel(job), changeId: changes.get(id) ?? null,
    // The user's marks on it (needs you / answered / seen), so a result they already settled is not flagged again.
    ...(project.taskMarks?.[id] ? { attention: copy(project.taskMarks[id]) } : {}) };
  // A finished run's one line: the worker's handoff, written for the user. A stop or failure is its code instead (the
  // host's own handoff there is for the model), and so is a result the user settled by hand or one never reported.
  if (status === 'completed' && kind !== 'learn' && !job?.unreported && !action?.resolvedAt && !job?.resolvedAt) { const summary = userLine(job?.handoff ?? action?.handoff, SUMMARY_LIMIT); if (summary) run.summary = summary; }
  if (ended && status !== 'completed') { const code = action?.failure?.code ?? action?.errorCode ?? job?.failure?.code ?? job?.errorCode ?? (status === 'cancelled' ? action?.cancellationReason : undefined); if (typeof code === 'string' && code) run.errorCode = code.slice(0, 64); }
  return run;
}
/**
 * The project's background runs for the tasks panel (P-1): `running` (live, then waiting for review, paused, queued;
 * newest first within each, except queued runs: oldest first, the order they run) and `recent` (finished within 24 h,
 * newest first, at most 8). Built from the SDK actions with their jobs, jobs whose action was archived, and claimed
 * schedule occurrences not yet started. The whole field stays within WORK_BYTES: past it the oldest finished runs go
 * first, then the last-ranked live ones (so of a long queue, the runs next to execute stay).
 */
export function backgroundWorkView(project, { now = Date.now(), language = 'zh' } = {}) {
  const actions = project?.initiativeRuntime?.sdkState?.actions ?? [], occurrences = project?.scheduleRuntime?.occurrences ?? [];
  const jobs = new Map((project?.jobs ?? []).filter(row => kept(row) && row.simulated !== true && row.lane === 'background').map(row => [row.id, row]));
  // A run's change set: its latest one.
  const changes = new Map((project?.backgroundChanges ?? []).filter(row => row?.id && row.actionId).map(row => [row.actionId, row.id])), plans = runPlans(project?.mind);
  const claimed = new Map(occurrences.filter(row => row?.actionId).map(row => [row.actionId, row])), runs = [], seen = new Set();
  const add = (id, input) => { seen.add(id); const run = workRun(project, { id, occurrence: claimed.get(id) ?? null, ...input, language, changes, plans, now }); if (run) runs.push(run); };
  for (const action of actions) {
    if (!['work', 'learn'].includes(action.action) || action.simulated === true || seen.has(action.id)) continue;
    // A result from a deleted conversation is left out unless it still waits to be checked (as on the task page).
    if (action.sourceDeleted && !(action.status === 'needs_review' && action.blocksExecution === true)) { seen.add(action.id); continue; }
    add(action.id, { action, job: jobs.get(action.id) });
  }
  for (const job of jobs.values()) if (!seen.has(job.id) && ['research', 'evolution'].includes(job.kind)) add(job.id, { job });
  // An occurrence claimed while the foreground was busy: queued before it becomes an action.
  for (const occurrence of occurrences) if (occurrence.status === 'queued' && occurrence.actionId && !seen.has(occurrence.actionId)) add(occurrence.actionId, { occurrence });
  // The SDK dispatches queued actions in the order they were created: the oldest queued run is the next to execute.
  const since = run => timeOf(run.resumedAt ?? run.startedAt ?? run.createdAt), rank = run => ACTIVE_RUN.indexOf(run.status);
  const order = (a, b) => a.status === 'queued' ? timeOf(a.createdAt) - timeOf(b.createdAt) : since(b) - since(a);
  const running = runs.filter(run => ACTIVE_RUN.includes(run.status)).sort((a, b) => rank(a) - rank(b) || order(a, b) || a.id.localeCompare(b.id)).slice(0, WORK_RUNNING_LIMIT);
  const recent = runs.filter(run => run.completedAt && now - timeOf(run.completedAt) < WORK_RECENT_MS).sort((a, b) => timeOf(b.completedAt) - timeOf(a.completedAt) || a.id.localeCompare(b.id)).slice(0, WORK_RECENT_LIMIT);
  const work = { running, recent };
  while ((recent.length || running.length) && Buffer.byteLength(JSON.stringify(work)) > WORK_BYTES) (recent.length ? recent : running).pop();
  return work;
}

export async function controlBackgroundAction(controller, projectId, actionId, input = {}, { beforeCommit, sourceSessionId } = {}) {
  const { action, text, requestId, expectedRevision } = input;
  if (Object.keys(input).some(key => !['action', 'text', 'requestId', 'expectedRevision'].includes(key)) || !['pause', 'resume', 'stop', 'steer'].includes(action)
    || typeof requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(requestId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    ) fail('后台控制请求无效：需要合法 action、requestId 和非负整数 expectedRevision。', 'invalid_control', 400);
  if (action === 'steer' && (typeof text !== 'string' || !text.trim() || text.length > 4000 || text.includes('\0'))) fail('steer 必须提供非空 text（最多 4000 字符）；这是要送入原后台会话的新方向。', 'invalid_control', 400);
  if (action !== 'steer' && text !== undefined) fail('pause、resume、stop 必须省略 text 字段。请保留 actionId、action、expectedRevision，移除 text 后重试；尚未保存或执行本请求。', 'invalid_control', 400);
  if (controller.closed) fail('主动协作控制器已关闭', 'closed', 503);
  if (!controller.project(projectId)) fail('项目不存在', 'project_not_found', 404);
  // The ordinary host pump restores the durable coordinator. Never create a
  // second owner or make a disabled/archived project execute to handle an RPC.
  if (!controller.contexts.has(projectId)) { await controller.pendingPump; if (!controller.contexts.has(projectId)) await controller.pump(); }
  const context = controller.contexts.get(projectId);
  if (!context || context.closing || !controller.valid(context)) fail('项目后台暂不可用，请查看项目状态', 'background_unavailable');
  let receipt;
  try { receipt = await context.coordinator.requestActionControl(actionId, { id: requestId, kind: action === 'stop' ? 'cancel' : action, expectedRevision, ...(action === 'steer' ? { instruction: text.trim() } : {}), ...(sourceSessionId ? { sourceSessionId } : {}) }, { beforeCommit: () => { if (!controller.valid(context) || context.closing) fail('项目后台状态已改变', 'background_unavailable'); beforeCommit?.(); } }); }
  catch (failure) { if (!failure.status) failure.status = ['invalid_control', 'invalid_options'].includes(failure.code) ? 400 : 409; throw failure; }
  // Persisted mailbox acknowledgement is independent of runtime delivery.
  // Failure or disconnect here leaves a retryable command, not a lost input.
  void controller.flushActionControls(context, actionId).catch(failure => { context.lastControlError = failure.code ?? 'control_delivery_failed'; controller.schedule(); });
  controller.schedule();
  return { action: backgroundActionView(controller, projectId).actions.find(row => row.id === actionId), receipt };
}

export function backgroundControlTools(controller, { projectId, sessionId, turnId }) {
  const assertSource = () => {
    const session = controller.store.state.sessions.find(row => row.id === sessionId && row.projectId === projectId && !row.archivedAt);
    if (!session || !session.turns.some(row => row.id === turnId && row.status === 'running')) fail('当前对话已结束或被撤销', 'background_source_revoked');
  };
  const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  return [{ name: 'project_background_list', permission: 'read', effect: 'read', idempotent: true,
    description: 'Show the background actions of the current project, their real progress and the available controls. An ordinary follow-up question does not need to stop an investigation; read here when progress is needed, and a result summary still has to be checked against tool evidence.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async (_id, _args, signal) => {
      signal?.throwIfAborted(); assertSource();
      // Revoked rows are the user's record of a previous scope, not this model's context.
      const actions = backgroundActionView(controller, projectId).actions.filter(row => !row.revoked), active = actions.filter(row => ['queued', 'running', 'paused', 'needs_review'].includes(row.status));
      const selected = [...active.slice(-16), ...actions.filter(row => !active.includes(row)).slice(-4)];
      return result({ projectId, omitted: actions.length - selected.length, actions: selected.map(row => {
        const job = controller.project(projectId)?.jobs?.find(job => job.id === row.id);
        return { id: row.id, action: row.action, status: row.status, label: row.label, content: row.content?.slice(0, 800), resultSummary: row.resultSummary?.slice(0, 1200), controlRevision: row.controlRevision, availableControls: row.availableControls, controlState: row.controlState,
          toolReceiptCounts: job?.toolReceiptCounts, latestTool: job?.toolReceipts?.at(-1)?.toolName,
          controls: (row.controls ?? []).slice(-4).map(({ id, kind, status }) => ({ id, kind, status })) };
      }), meaning: 'Worker summaries are not execution proof. Tool counts describe actual host receipts, not task completion. Pending controls are not yet settled.' });
    }
  }, { name: 'project_background_control', permission: 'read', effect: 'write', idempotent: true,
    description: 'Control one existing background action according to the intent, expressed by the user in the current conversation, to stop, pause, continue or change direction. Call list first to get actionId and controlRevision. pause/resume/stop pass only actionId, action and expectedRevision and must omit text (do not use text to write a reason). Only steer must attach text to add a direction; it creates no new action and widens no permission; when the user only asks about progress, do not control the action. A receipt of pending only means saved; applied means the boundary was confirmed; do not claim success for a failure or needs_review.',
    parameters: { type: 'object', properties: { actionId: { type: 'string' }, action: { type: 'string', enum: ['pause', 'resume', 'stop', 'steer'] }, expectedRevision: { type: 'integer', minimum: 0 }, text: { type: 'string', description: 'Required only for action=steer: the new direction. For pause, resume or stop, OMIT this field entirely; do not include a reason here.', minLength: 1, maxLength: 4000 } }, required: ['actionId', 'action', 'expectedRevision'], additionalProperties: false },
    execute: async (toolCallId, args, signal) => {
      signal?.throwIfAborted(); assertSource();
      const requestId = `foreground-${createHash('sha256').update(JSON.stringify([sessionId, turnId, toolCallId])).digest('hex')}`;
      const { actionId, ...input } = args;
      return result(await controlBackgroundAction(controller, projectId, actionId, { ...input, requestId }, { sourceSessionId: sessionId, beforeCommit: () => { signal?.throwIfAborted(); assertSource(); } }));
    }
  }];
}
