import { randomUUID, createHash } from 'node:crypto';
import { createProjectSchedule, updateProjectSchedule, projectScheduleView } from '../../packages/sdk/src/project-schedules.mjs';
import { toolPermitted } from './project-permissions.mjs';
import { projectRhythmEvidenceKey } from './project-rhythm.mjs';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';
import { scheduleToolDescription, scheduleToolParameters, schedulePolicyReason, schedulePromptVersionOfStore } from './schedule-prompt.mjs';
import { projectUserItems, scheduleBasisCheck, citedMessageIds } from './schedule-basis.mjs';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status, code: 'invalid_project_schedule' }); };
// What the user reads when the SDK rejects a schedule (its own messages are English and terse; the dialog shows ours).
const SCHEDULE_ERRORS = [
  [/must be in the future/, { zh: '这个时间已经过去了，请选一个将来的时间。', en: 'That time has already passed. Pick a time in the future.' }],
  [/IANA time zone|Invalid time zone/, { zh: '无法识别这个时区，请填写 IANA 时区名，例如 Asia/Shanghai。', en: 'That time zone is not recognized. Use an IANA name such as Asia/Shanghai.' }],
  [/HH:mm/, { zh: '时间格式不对，请用 24 小时制 HH:mm，例如 09:00。', en: 'Use 24-hour HH:mm for the time, for example 09:00.' }],
  [/Weekly days/, { zh: '请选择每周哪几天执行（至少一天）。', en: 'Pick the days of the week to run on (at least one).' }],
  [/Interval must be/, { zh: '间隔需要在 5 分钟到 366 天之间。', en: 'The interval must be between 5 minutes and 366 days.' }],
  [/instant/, { zh: '执行时间无效，请重新选择日期和时间。', en: 'That date and time are not valid. Pick them again.' }],
  [/No occurrence could be resolved/, { zh: '在这个时区里找不到可以执行的时刻，请换一个时间。', en: 'No run time could be found in this time zone. Try another time.' }],
  [/Invalid title/, { zh: '名称不能为空，最长 160 字。', en: 'The name cannot be empty or longer than 160 characters.' }],
  [/Invalid task/, { zh: '任务内容不能为空，最长 6000 字。', en: 'The task cannot be empty or longer than 6,000 characters.' }],
  [/Invalid destination session/, { zh: '请选择要投递到的会话。', en: 'Choose the conversation to deliver to.' }],
  [/Unsupported schedule rule/, { zh: '不支持这种执行方式。', en: 'This kind of schedule is not supported.' }],
];
const SCHEDULE_ERROR = { zh: '日程没有保存：内容或执行规则无效，请检查后再试。', en: 'The schedule was not saved: its content or rule is not valid. Check it and try again.' };
/** When a run is due, as the user set it: the schedule's own time zone (once/interval rules: the app's). */
export function runTime(at, timeZone, language) {
  try {
    const options = { timeZone, day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    if (language === 'en') return new Intl.DateTimeFormat('en-US', { ...options, month: 'short' }).format(new Date(at));
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { ...options, month: 'numeric' }).formatToParts(new Date(at)).map(row => [row.type, row.value]));
    return `${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}`;
  } catch { return at; }
}
const WEEKDAYS = { zh: ['一', '二', '三', '四', '五', '六', '日'], en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] };
/** A schedule rule in plain words (每天 09:00, every Mon, Thu at 09:00 …); its time zone is named only when it is not the app's. */
export function scheduleRuleText(rule = {}, language = 'zh') {
  const en = language === 'en', local = projectScheduleDefaults().timeZone, zone = rule.timeZone && rule.timeZone !== local ? (en ? ` (${rule.timeZone})` : `（${rule.timeZone}）`) : '';
  if (rule.kind === 'daily') return en ? `daily at ${rule.time}${zone}` : `每天 ${rule.time}${zone}`;
  if (rule.kind === 'weekly') { const days = (rule.days ?? []).map(day => WEEKDAYS[en ? 'en' : 'zh'][day - 1]).filter(Boolean); return en ? `every ${days.join(', ')} at ${rule.time}${zone}` : `每周${days.join('、')} ${rule.time}${zone}`; }
  if (rule.kind === 'interval' && Number.isFinite(rule.everyMs)) {
    const [count, unit] = rule.everyMs % 86400000 === 0 ? [rule.everyMs / 86400000, en ? 'day' : '天'] : rule.everyMs % 3600000 === 0 ? [rule.everyMs / 3600000, en ? 'hour' : '小时'] : [Math.round(rule.everyMs / 60000), en ? 'minute' : '分钟'];
    return en ? `every ${count === 1 ? '' : `${count} `}${unit}${count === 1 ? '' : 's'}` : `每${count === 1 ? '' : ` ${count} `}${unit}`;
  }
  if (rule.kind === 'once') return en ? `once, ${runTime(rule.at, local, 'en')}` : `${runTime(rule.at, local, 'zh')} 一次`;
  return en ? 'on its own schedule' : '按设定的时间';
}
const RECEIPT_VERBS = { confirmed: { zh: '已确认现有', en: 'Confirmed the existing' }, create: { zh: '已自主安排', en: 'Set up' }, update: { zh: '已自主调整', en: 'Adjusted' }, delete: { zh: '已取消', en: 'Cancelled' } };
const receiptSummary = (verb, title, when, language) => inLanguage(language, { zh: `${verb.zh}任务「${title}」${when ? `；下次 ${when}` : ''}。这是任务安排回执，尚不代表工作已完成。`, en: `${verb.en} the task “${title}”${when ? `; next run ${when}` : ''}. This is a scheduling receipt; the work itself is not done yet.` });
// A planning receipt written before its next run was put in local words names it as a UTC instant ("；下次
// 2026-10-03T01:00:00.000Z。"); when read, it is worded like a new one. The stored row stays as it was.
const RAW_RECEIPT = /^(已确认现有|已自主安排|已自主调整|已取消)任务「([\s\S]*)」；下次 (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z)。这是任务安排回执，尚不代表工作已完成。$/;
/** A planning receipt as the user reads it (C2-f): an older row's next run in the schedule's own time zone and words. */
export function readableScheduleReceipt(receipt, project, language = 'zh') {
  const raw = typeof receipt?.summary === 'string' ? RAW_RECEIPT.exec(receipt.summary) : null;
  if (!raw) return receipt;
  const verb = Object.values(RECEIPT_VERBS).find(row => row.zh === raw[1]), zone = project?.schedules?.find(row => row.id === receipt.scheduleId)?.rule?.timeZone ?? projectScheduleDefaults().timeZone;
  return { ...receipt, nextRunAt: receipt.nextRunAt ?? raw[3], summary: receiptSummary(verb, raw[2], runTime(raw[3], zone, language), language) };
}
/** The project's planning receipts as the user reads them, for the projections that carry them (state, project summaries). */
export const scheduleReceiptsView = (project, language = 'zh') => (project?.scheduleManagementReceipts ?? []).map(row => readableScheduleReceipt(row, project, language));
/** Occurrence states: settled ones never change again; live ones hold their schedule's next claim. */
export const OCCURRENCE_SETTLED = Object.freeze(['delivered', 'failed', 'cancelled', 'skipped', 'expired']);
export const OCCURRENCE_LIVE = Object.freeze(['queued', 'running', 'delivery_pending', 'needs_review']);
/** Why a window was skipped: it came due while notifications were muted, or its claim could not start before the next window opened. */
export const MUTED_SKIP = 'notifications_muted', WINDOW_PASSED = 'window_passed';
/** F9 in the model's words; the settings (暂停主动发言), the schedule list and REACH_GUIDANCE say the same. */
export const SCHEDULE_MUTE_POLICY = 'While notifications are muted, schedules pause: a window that comes due is skipped, only the latest one runs after unmute (if within one period), and the result of a run already started is filed in the inbox only, not posted in the conversation.';
/**
 * Record a skipped window, keeping only the latest skipped row of its schedule (Headlong reports a missed window once:
 * an outage costs one post, not one per lost window). `row` is a queued claim's key, or a new window's row.
 */
export function skipOccurrence(project, row, reason, now) {
  if (!project) return null;
  project.scheduleRuntime ??= { schemaVersion: 1, occurrences: [] };
  const list = project.scheduleRuntime.occurrences, existing = typeof row === 'string' ? list.find(item => item.key === row) : null;
  if (typeof row === 'string' && existing?.status !== 'queued') return null;
  const target = existing ?? { ...row };
  project.scheduleRuntime.occurrences = list.filter(item => item === existing || !(item.scheduleId === target.scheduleId && item.status === 'skipped'));
  Object.assign(target, { status: 'skipped', errorCode: reason, skippedAt: new Date(now).toISOString() });
  if (!existing) project.scheduleRuntime.occurrences.push(target);
  return target;
}
/** The inbox note for a scheduled result that waited a whole period for delivery (F9): the result itself follows it. */
export function expiredDeliveryText(schedule, occurrence, result, language = 'zh') {
  const when = runTime(occurrence.scheduledAt, schedule.rule?.timeZone ?? projectScheduleDefaults().timeZone, language);
  return inLanguage(language, {
    zh: `「${schedule.title}」${when} 这一次的结果等了一整个周期都没能送到对话里。为了不在对话里补发过时的结果，它只放在收件箱。${result ? `\n\n${result}` : ''}`,
    en: `The result of “${schedule.title}” for ${when} waited a whole period without reaching the conversation, so it is kept here in the inbox instead of being posted late.${result ? `\n\n${result}` : ''}` });
}
const fields = ['title', 'task', 'rule', 'destinationSessionId', 'enabled'];
const copy = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const initiativeRequestHash = ({ actionId, id, schedule, reason, evidenceIds }) => hash(canonical({ actionId: actionId ?? id, schedule, reason, evidenceIds: [...(evidenceIds ?? [])].sort() }));
const purposePattern = /^[a-z0-9][a-z0-9._-]{0,99}$/;
/** The shadow basis check's fields (W2) stay in the stored receipt for the user and the maintainer; a receipt read back by the planner is as it always was. */
const modelReceipt = ({ basisCheck, basisMessageId, ...rest }) => rest;
const revisionConflict = current => Object.assign(new Error(`The schedule changed since you read it (now revision ${current}). Read it again with project_schedule_list and repeat the smallest change.`), { status: 409, code: 'schedule_revision_conflict' });
const userPaused = record => record.userPaused === true || record.userPaused === undefined && record.enabled === false && (record.lastEditedBy ?? record.source ?? 'user') !== 'initiative';
export const projectScheduleDefaults = () => ({ time: '09:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', timingSource: 'application_default' });

/** Durable intent is separate from model review cadence. The initiative host
 * claims occurrences and owns execution; CRUD never executes a task itself. */
export class ProjectScheduleService {
  constructor(store, { now = Date.now } = {}) { this.store = store; this.now = now; }
  say(variants) { return inLanguage(interfaceLanguageOf(this.store.state), variants); }
  /** An SDK rejection as text the user can act on, in the interface language (the original stays as `detail`). */
  rejected(error) {
    if (error?.name !== 'ProjectScheduleError') { if (error && typeof error === 'object') error.status ??= 400; return error; }
    return Object.assign(new Error(this.say(SCHEDULE_ERRORS.find(([pattern]) => pattern.test(error.message))?.[1] ?? SCHEDULE_ERROR)), { status: 400, code: error.code ?? 'invalid_schedule', detail: error.message });
  }
  project(id, state = this.store.state) { return state.projects.find(project => project.id === id) ?? fail(this.say({ zh: '项目不存在', en: 'The project does not exist.' }), 404); }
  mutable(project) { if (project.archivedAt) fail(this.say({ zh: '项目已归档，请先恢复项目。', en: 'The project is archived. Restore it first.' }), 409); }
  destination(project, id, state = this.store.state) {
    const session = state.sessions.find(session => session.id === id && session.projectId === project.id && !session.archivedAt);
    if (!session) fail(this.say({ zh: '投递会话必须是当前项目中未归档的会话。', en: 'Deliver to a conversation of this project that is not archived.' }), 409);
    return session.id;
  }
  list(projectId) {
    const project = this.project(projectId), at = this.now();
    const pausedReason = this.store.state.emergency ? 'emergency' : project.archivedAt ? 'project_archived' : project.initiative?.enabled !== true ? 'initiative_disabled' : project.initiative?.notificationMuted ? 'notifications_muted' : null;
    return { schedules: (project.schedules ?? []).map(record => ({ ...projectScheduleView(record, at), ...copy(record), pausedReason: pausedReason ?? (!record.enabled ? 'schedule_disabled' : !this.store.state.sessions.some(session => session.id === record.destinationSessionId && session.projectId === project.id && !session.archivedAt) ? 'destination_unavailable' : null) })), occurrences: copy(project.scheduleRuntime?.occurrences ?? []), defaults: projectScheduleDefaults() };
  }
  /** Model-facing commitments, including human interventions. This is planning
   * evidence; it never grants the eventual worker extra tools or permissions. */
  agentView(projectId) {
    const project = this.project(projectId), view = this.list(projectId);
    return { defaults: view.defaults,
      destinations: this.store.state.sessions.filter(session => session.projectId === projectId && !session.archivedAt && session.kind !== 'side').map(session => ({ id: session.id, title: session.title, primary: session.id === project.primarySessionId })),
      // `taskBasis` (the shadow check's record of the user's words behind the last task change) is for the user's page and the
      // maintainer: shown to the planner it would be one more earlier change to cite as precedent (S3 RC-3).
      schedules: view.schedules.map(({ creationRequestHash, taskBasis, ...record }) => record),
      cancelled: (project.scheduleCreationReceipts ?? []).filter(row => row.deletedAt).slice(-64).map(row => ({ id: row.id, purposeKey: row.purposeKey, title: row.title, deletedAt: row.deletedAt, deletedBy: row.deletedBy ?? 'user' })),
      policy: { initiativeMayManage: !this.store.state.emergency && !project.archivedAt && project.initiative?.enabled === true,
        reason: schedulePolicyReason(schedulePromptVersionOfStore(this.store)),
        maxSchedules: 32, externalDelivery: false } };
  }
  initiativeReceipt(projectId, actionId) { const project = this.project(projectId), receipt = (project.scheduleManagementReceipts ?? []).find(row => row.actionId === actionId); return receipt && copy(readableScheduleReceipt(modelReceipt(receipt), project, interfaceLanguageOf(this.store.state))); }
  reconcileInitiativeAction(projectId, action) {
    const receipt = this.initiativeReceipt(projectId, action.id ?? action.actionId);
    return receipt?.requestHash === initiativeRequestHash(action) ? receipt : null;
  }
  applyInitiativeAction(projectId, { actionId, schedule, reason, evidenceIds, evidence = [], signal } = {}) {
    signal?.throwIfAborted();
    if (typeof actionId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(actionId) || typeof reason !== 'string' || !reason.trim() || reason.length > 2000 || !Array.isArray(evidenceIds) || !evidenceIds.length || evidenceIds.length > 50 || evidenceIds.some(id => typeof id !== 'string' || id.length > 160) || new Set(evidenceIds).size !== evidenceIds.length) fail('自主任务必须关联真实行动、理由和证据。');
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule) || !['create', 'update', 'delete'].includes(schedule.operation)) fail('无效的自主任务操作。');
    const allowed = schedule.operation === 'create' ? ['operation', 'purposeKey', ...fields] : ['operation', 'id', 'expectedRevision', ...(schedule.operation === 'update' ? [...fields, 'basis'] : [])];
    if (Object.keys(schedule).some(key => !allowed.includes(key))) fail('自主任务操作包含无效字段。');
    // `basis` (update only): the user's words behind a change of task, checked and recorded below; it is not a schedule field.
    if (schedule.basis !== undefined && (typeof schedule.basis !== 'string' || schedule.basis.length > 1000)) fail('schedule.basis must be text of at most 1000 characters.');
    if (schedule.operation === 'create' && (typeof schedule.purposeKey !== 'string' || !purposePattern.test(schedule.purposeKey) || ['title', 'task', 'rule', 'destinationSessionId'].some(key => schedule[key] === undefined))) fail('自主任务必须包含稳定职责标识和完整计划。');
    if (schedule.operation !== 'create' && (typeof schedule.id !== 'string' || !Number.isSafeInteger(schedule.expectedRevision) || schedule.expectedRevision < 1)) fail('调整任务必须引用当前版本。');
    const input = Object.fromEntries(fields.filter(key => Object.hasOwn(schedule, key)).map(key => [key, copy(schedule[key])]));
    if (schedule.operation === 'update' && !Object.keys(input).length) fail('请提供实际的任务调整。');
    const requestHash = initiativeRequestHash({ actionId, schedule, reason, evidenceIds });
    return this.store.mutate(state => {
      signal?.throwIfAborted();
      const project = this.project(projectId, state); this.mutable(project);
      // The accepted decision already understood this source revision. Its
      // own schedule metadata is a committed effect, not fresh outside input.
      // Capture the comparison before changing anything in this transaction;
      // a user arrival/edit since the decision must remain unconsumed.
      const beforeKey = projectRhythmEvidenceKey(state, project);
      const acknowledgeMaintenance = Boolean(project.rhythmRuntime?.assessment && project.rhythmRuntime.evidenceKey === beforeKey);
      const prior = (project.scheduleManagementReceipts ?? []).find(row => row.actionId === actionId);
      if (prior) { if (prior.requestHash !== requestHash) fail('同一自主行动不能改变已提交的任务操作。', 409); return readableScheduleReceipt(modelReceipt(prior), project, interfaceLanguageOf(state)); }
      if (state.emergency || project.initiative?.enabled !== true) fail('主动协作已暂停，任务未修改。', 409);
      if ((project.scheduleManagementReceipts ?? []).length >= 4096) fail('自主任务行动记录已满，未删除审计记录。', 409);
      const sources = evidenceIds.map(id => evidence.find(row => row.id === id && !row.sourceDeleted && !row.contextRevoked));
      if (sources.some(row => !row)) fail('自主任务的来源证据已不可用。', 409);
      const at = new Date(this.now()).toISOString(), provenance = { actionId, reason: reason.trim(), evidenceIds: copy(evidenceIds), sources: sources.map(row => ({ id: row.id, type: row.type, at: row.at ?? row.createdAt, hash: hash(canonical(row)) })), decidedAt: at };
      let record, alreadyRegistered = false, basisCheck = null;
      if (schedule.operation === 'create') {
        if ((project.scheduleCreationReceipts ?? []).some(row => row.purposeKey === schedule.purposeKey && row.deletedAt)) fail('此职责已被取消，不能由自主行动重新创建。', 409);
        record = (project.schedules ?? []).find(row => row.purposeKey === schedule.purposeKey);
        if (record) {
          if (hash(canonical(Object.fromEntries(Object.keys(input).map(key => [key, record[key]])))) !== hash(canonical(input))) fail('此职责已有任务；请读取当前版本后调整原任务。', 409);
          alreadyRegistered = true;
        } else {
          if ((project.schedules ?? []).length >= 32 || (project.scheduleCreationReceipts ?? []).length >= 4096) fail('项目任务或创建记录已达到保留上限。', 409);
          this.destination(project, input.destinationSessionId, state);
          try { record = createProjectSchedule({ ...input, id: `schedule-${hash([projectId, 'initiative', actionId]).slice(0, 32)}` }, { now: this.now() }); } catch (error) { throw this.rejected(error); }
          Object.assign(record, { purposeKey: schedule.purposeKey, source: 'initiative', lastEditedBy: 'initiative', initiativeProvenance: provenance });
          project.schedules ??= []; project.schedules.push(record);
          project.scheduleCreationReceipts ??= []; project.scheduleCreationReceipts.push({ id: record.id, purposeKey: record.purposeKey, title: record.title, source: 'initiative', createdAt: record.createdAt });
        }
      } else {
        const index = (project.schedules ?? []).findIndex(row => row.id === schedule.id); if (index < 0) fail('原任务已删除，不会重新创建。', 409);
        record = project.schedules[index];
        if (record.revision !== schedule.expectedRevision) fail('任务已被修改，请依据最新版本重新决定。', 409);
        if (schedule.operation === 'update') {
          if (input.enabled === true && userPaused(record)) fail('此任务已由用户暂停，自主行动不能恢复。', 409);
          if (input.destinationSessionId !== undefined) this.destination(project, input.destinationSessionId, state);
          const before = record;
          try { record = { ...record, ...updateProjectSchedule(record, input, { now: this.now() }), userPaused: userPaused(record), lastEditedBy: 'initiative', initiativeProvenance: provenance }; } catch (error) { throw this.rejected(error); }
          // Shadow check (W2, design2 §7): whose words are behind a changed task. Recorded in the receipt, never a reason to refuse;
          // only the user messages this decision cites count. A task another author changed no longer carries the earlier record.
          if (input.task !== undefined && input.task !== before.task) { basisCheck = scheduleBasisCheck({ basis: schedule.basis, items: projectUserItems(state, projectId), referenced: citedMessageIds(evidenceIds) }); delete record.taskBasis; }
          project.schedules[index] = record;
        } else {
          project.scheduleCreationReceipts ??= [];
          let tombstone = project.scheduleCreationReceipts.find(row => row.id === record.id);
          if (!tombstone) { tombstone = { id: record.id, createdAt: record.createdAt }; project.scheduleCreationReceipts.push(tombstone); }
          Object.assign(tombstone, { purposeKey: record.purposeKey, title: record.title, deletedAt: at, deletedBy: 'initiative', reason: reason.trim() });
          project.schedules.splice(index, 1);
        }
      }
      // The next run is read as the user set it (the schedule's time zone), never as a UTC instant; the instant itself is `nextRunAt`.
      const language = interfaceLanguageOf(state), next = schedule.operation !== 'delete' && record.nextRunAt ? record.nextRunAt : null;
      const when = next ? runTime(next, record.rule?.timeZone ?? projectScheduleDefaults().timeZone, language) : '';
      const verb = RECEIPT_VERBS[alreadyRegistered ? 'confirmed' : schedule.operation];
      const result = { actionId, requestHash, operation: schedule.operation, scheduleId: record.id, purposeKey: record.purposeKey, revision: record.revision, committedAt: at, alreadyRegistered, ...(next ? { nextRunAt: next } : {}),
        summary: receiptSummary(verb, record.title, when, language) };
      project.scheduleManagementReceipts ??= []; project.scheduleManagementReceipts.push(basisCheck ? { ...result, basisCheck: basisCheck.check, ...(basisCheck.messageId ? { basisMessageId: basisCheck.messageId } : {}) } : result); project.updatedAt = at;
      if (acknowledgeMaintenance) {
        project.rhythmRuntime.evidenceKey = projectRhythmEvidenceKey(state, project);
        project.rhythmRuntime.lastMaintenance = { actionId, scheduleId: record.id, at };
      }
      return result;
    });
  }
  create(projectId, input, { requestId, source = 'user', sessionId } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) fail(this.say({ zh: '日程包含无效字段。', en: 'The schedule has fields that are not allowed.' }));
    const project = this.project(projectId); this.mutable(project);
    const destinationSessionId = this.destination(project, input.destinationSessionId ?? sessionId ?? project.primarySessionId);
    const args = { ...copy(input), destinationSessionId }, requestHash = hash(args);
    const id = requestId ? `schedule-${hash([projectId, source, requestId]).slice(0, 32)}` : randomUUID();
    const existing = (project.schedules ?? []).find(row => row.id === id);
    if (existing) { if (existing.creationRequestHash !== requestHash) fail(this.say({ zh: '相同请求标识不能创建不同日程。', en: 'The same request id cannot create a different schedule.' }), 409); return copy(existing); }
    if ((project.scheduleCreationReceipts ?? []).some(row => row.id === id)) fail(this.say({ zh: '此创建请求对应的日程已删除，不会重新启用。请使用新的请求标识。', en: 'The schedule this request created was deleted and will not come back. Use a new request id.' }), 409);
    if ((project.scheduleRuntime?.occurrences ?? []).some(row => row.scheduleId === id)) fail(this.say({ zh: '此日程请求已结束或删除，请使用新的请求标识。', en: 'This schedule request has ended or was deleted. Use a new request id.' }), 409);
    if ((project.schedules ?? []).length >= 32) fail(this.say({ zh: '每个项目最多可保存 32 项日程，请先删除不再需要的。', en: 'A project can keep at most 32 schedules. Delete ones you no longer need first.' }), 409);
    if ((project.scheduleCreationReceipts ?? []).length >= 4096) fail(this.say({ zh: '日程创建请求记录已达到保留上限，未清除旧记录或重新执行旧请求。', en: 'The record of schedule requests is full; no old record was removed and no old request was run again.' }), 409);
    let record;
    try { record = createProjectSchedule({ ...args, id }, { now: this.now() }); } catch (error) { throw this.rejected(error); }
    record.source = source; record.lastEditedBy = source === 'initiative' ? 'initiative' : 'user'; record.userPaused = record.lastEditedBy === 'user' && record.enabled === false; record.creationRequestHash = requestHash;
    return this.store.mutate(state => {
      const target = this.project(projectId, state); this.mutable(target); this.destination(target, destinationSessionId, state);
      target.schedules ??= []; target.schedules.push(record); target.updatedAt = new Date(this.now()).toISOString();
      target.scheduleCreationReceipts ??= []; target.scheduleCreationReceipts.push({ id, title: record.title, source, requestHash, createdAt: record.createdAt });
      return record;
    });
  }
  /**
   * `conversation`: the foreground model's `project_schedule` tool (the user's page and API call it without). It may send
   * `expectedRevision` (the update fails when the task moved on since it read it) and, with a changed task, `basis` (the
   * user's words; the shadow check records, in `taskBasis`, whether they are a quote of a user message, and never refuses).
   * Whoever calls it, the edit is recorded as the user's (`lastEditedBy`), as it always was.
   */
  update(projectId, id, input, conversation = null) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).some(key => !fields.includes(key))) fail(this.say({ zh: '请提供有效的日程修改。', en: 'Send a valid change to the schedule.' }));
    return this.store.mutate(state => {
      const project = this.project(projectId, state); this.mutable(project);
      const index = (project.schedules ?? []).findIndex(row => row.id === id); if (index < 0) fail(this.say({ zh: '日程不存在', en: 'The schedule does not exist.' }), 404);
      const before = project.schedules[index];
      if (conversation?.expectedRevision !== undefined && before.revision !== conversation.expectedRevision) throw revisionConflict(before.revision);
      if (input.destinationSessionId !== undefined) this.destination(project, input.destinationSessionId, state);
      try { project.schedules[index] = { ...before, ...updateProjectSchedule(before, input, { now: this.now() }), ...(input.enabled === undefined ? {} : { userPaused: !input.enabled }), lastEditedBy: 'user', userEditedAt: new Date(this.now()).toISOString() }; } catch (error) { throw this.rejected(error); }
      // Shadow check (W2): a record of the user's words behind a changed task. A task changed by the page or the API no longer carries the earlier one.
      if (input.task !== undefined && input.task !== before.task) {
        if (conversation) { const check = scheduleBasisCheck({ basis: conversation.basis, items: projectUserItems(state, projectId) }); project.schedules[index].taskBasis = { ...check, by: 'conversation', at: new Date(this.now()).toISOString() }; }
        else delete project.schedules[index].taskBasis;
      }
      project.updatedAt = new Date(this.now()).toISOString(); return project.schedules[index];
    });
  }
  remove(projectId, id) {
    return this.store.mutate(state => {
      const project = this.project(projectId, state); this.mutable(project);
      if (!(project.schedules ?? []).some(row => row.id === id)) fail(this.say({ zh: '日程不存在', en: 'The schedule does not exist.' }), 404);
      project.scheduleCreationReceipts ??= [];
      let receipt = project.scheduleCreationReceipts.find(row => row.id === id);
      if (!receipt) { const original = project.schedules.find(row => row.id === id); receipt = { id, source: original.source, createdAt: original.createdAt }; project.scheduleCreationReceipts.push(receipt); }
      const original = project.schedules.find(row => row.id === id);
      Object.assign(receipt, { purposeKey: original.purposeKey, title: original.title, deletedBy: 'user', deletedAt: new Date(this.now()).toISOString() });
      project.schedules = project.schedules.filter(row => row.id !== id); project.updatedAt = new Date(this.now()).toISOString();
      return { deleted: true, scheduleId: id };
    });
  }
  createTools({ projectId, sessionId }) {
    if (!projectId) return [];
    // The tool's texts follow the schedulePromptVersion setting as of this turn (schedule-prompt.mjs); v1 is the text it always had.
    const version = schedulePromptVersionOfStore(this.store);
    const run = (operation, signal) => {
      signal?.throwIfAborted();
      try { const value = operation(); return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.status ? error.message : 'The schedule was not saved; check the rule and the current state.' }], details: { code: error.code ?? 'invalid_project_schedule' } }; }
    };
    // The shadow check's record (taskBasis) is for the user's page: the model reads its tasks as it always did.
    const modelRecord = ({ taskBasis, ...record }) => record;
    return [{ name: 'project_schedule_list', permission: 'read', effect: 'read', idempotent: true,
      description: 'Show the real persistent schedules of the project, their next run times and the result of each run and delivery. No record means nothing is registered yet; the time of a proactive review is not a task schedule.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: (_id, _args, signal) => run(() => { const view = this.list(projectId); return { ...view, schedules: view.schedules.map(modelRecord) }; }, signal) },
    { name: 'project_schedule', permission: 'write', effect: 'write', idempotent: false,
      description: scheduleToolDescription(version),
      parameters: scheduleToolParameters(version),
      execute: (callId, args, signal) => run(() => {
        const project = this.project(projectId);
        if (!toolPermitted(project, { permission: 'write' }, 'foreground')) fail('当前项目为只读，日程未修改。', 403);
        // `basis` and `expectedRevision` are declared under v2 only, and accepted under either version (never part of the schedule fields).
        const { action, id, basis, expectedRevision, ...input } = args;
        if (basis !== undefined && (typeof basis !== 'string' || basis.length > 1000)) fail('basis must be text of at most 1000 characters.');
        if (expectedRevision !== undefined && !(Number.isSafeInteger(expectedRevision) && expectedRevision >= 1)) fail('expectedRevision must be a revision number from project_schedule_list.');
        if (action === 'create' && id === undefined) return this.create(projectId, input, { requestId: callId, source: 'conversation', sessionId });
        if (action === 'update' && id) return modelRecord(this.update(projectId, id, input, { basis, expectedRevision }));
        if (action === 'delete' && id && !Object.keys(input).length) return this.remove(projectId, id);
        fail('create 不接受 id；update/delete 必须提供 id，delete 不接受其他字段。');
      }, signal) }];
  }
}
