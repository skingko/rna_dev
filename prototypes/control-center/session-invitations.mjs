import { randomUUID } from 'node:crypto';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';
import { commitmentOverdue, restartWindow } from './project-mind.mjs';
import { actionLabel } from './task-text.mjs';
import { revokedLabel } from './project-background-controls.mjs';
import { guardsOf } from './project-genes.mjs';
import { guardScript } from './tool-policy.mjs';
import { pauseVerdict, deliveriesOf } from './schedule-attention.mjs';

// Light invitations shown above the composer (plan 2026-09-30 §2.1): things
// about how we work together that the user may answer or close, never a
// blocking question. They live on the session, so every open window sees the
// same queue and one answer removes it everywhere. The client decides when to
// show one (only to a user who is there); the host decides what is worth
// asking (JEV) and records every outcome as a label.
export const INVITATION_KINDS = Object.freeze(['feedback', 'lesson', 'gene', 'commitment', 'schedule', 'task', 'schedule_pause']);
/** Kinds that ask the user to decide something (they do not lapse with the next message; plan §2.1.1). */
export const DECISION_KINDS = Object.freeze(['lesson', 'gene', 'commitment', 'schedule', 'task', 'schedule_pause']);
/** Failed background work judged per presence (each at most once: judged stale → closed, otherwise asked). */
export const TASK_JUDGE_LIMIT = 4;
/** A schedule is suggested at most once a day per project, from requests made on at least this many days. */
export const SUGGEST_EVERY_MS = 24 * 3600000, SUGGEST_MIN_DAYS = 3, SUGGEST_WINDOW_MS = 14 * 86400000;
/** A decision invitation left open this long is judged again (invite.stale) once the user is back. */
export const STALE_AFTER_MS = 24 * 3600000;
export const INVITATION_OUTCOMES = Object.freeze(['answered', 'dismissed', 'expired']);
const OPEN_LIMIT = 8, HISTORY_LIMIT = 100;
const iso = value => new Date(value).toISOString();
const fail = (message, status = 400, code = 'invalid_invitation') => Object.assign(new Error(message), { status, code });
/**
 * The name of background work whose record a scope change revoked (or whose conversation was deleted). Its SDK content
 * is a placeholder for the model and never a name: the name comes from what the host kept for the user, the job of that
 * run (its title, else its instruction) or the message it delivered (revokedLabel, as on the task page). Empty when
 * nothing readable is left.
 */
export function revokedTaskLabel(project, action, { language = 'zh', limit = 120, quoted = false } = {}) {
  return action ? revokedLabel(project, action, { language, limit, quoted }) : '';
}
const revoked = action => Boolean(action?.contextRevoked || action?.sourceDeleted);
/** What the invite.stale judge is told a pause card asks (English, as the judge's other texts are). */
const pauseText = (title, count) => `Pause the scheduled task “${title}”, whose last ${count} results nobody opened`;

/** Queue an invitation unless the same subject was already offered in this
 * session: one thing is asked at most once, whatever the answer was. */
export function offerInvitation(session, { kind, subject, ...fields }, { now = Date.now() } = {}) {
  if (!INVITATION_KINDS.includes(kind) || typeof subject !== 'string' || !subject) throw fail('未知的邀请类型');
  session.invitations ??= []; session.invitationHistory ??= [];
  if (session.invitations.some(row => row.subject === subject) || session.invitationHistory.some(row => row.subject === subject)) return null;
  // Feedback is only ever about the latest reply.
  if (kind === 'feedback') for (const row of session.invitations.filter(item => item.kind === 'feedback')) closeInvitation(session, row.id, 'expired', { now });
  const row = { id: randomUUID(), kind, subject, createdAt: iso(now), ...fields };
  session.invitations.push(row);
  while (session.invitations.length > OPEN_LIMIT) closeInvitation(session, session.invitations[0].id, 'expired', { now });
  return row;
}

/** Remove an open invitation and keep a short, content-free receipt. */
export function closeInvitation(session, id, outcome, { now = Date.now() } = {}) {
  if (!INVITATION_OUTCOMES.includes(outcome)) throw fail('未知的邀请结果');
  const row = session.invitations?.find(item => item.id === id);
  if (!row) return null;
  session.invitations = session.invitations.filter(item => item.id !== id);
  session.invitationHistory = [...(session.invitationHistory ?? []), { id: row.id, kind: row.kind, subject: row.subject, outcome, createdAt: row.createdAt, closedAt: iso(now), ...(row.ledgerId ? { ledgerId: row.ledgerId } : {}) }].slice(-HISTORY_LIMIT);
  return row;
}

/** How the user treated the latest feedback asks in a project (answered / dismissed / lapsed / still open), oldest first. */
export function recentFeedbackAsks(state, projectId, { limit = 6 } = {}) {
  const rows = [];
  for (const session of (state?.sessions ?? []).filter(row => row.projectId === projectId)) {
    for (const row of session.invitationHistory ?? []) if (row.kind === 'feedback') rows.push({ outcome: row.outcome, at: row.closedAt ?? row.createdAt });
    for (const row of session.invitations ?? []) if (row.kind === 'feedback') rows.push({ outcome: 'open', at: row.createdAt });
  }
  return rows.sort((a, b) => Date.parse(a.at ?? 0) - Date.parse(b.at ?? 0)).slice(-limit);
}

/** A new user message moves the conversation on: feedback invitations lapse, and so does a decision the user was
 * shown and went past (they chose to write instead). Each is asked once; what it was about stays where it lives
 * (the lesson stays unconfirmed, the promise stays owed in the sidebar, the task on the task page). */
export function expireFeedbackInvitations(session, { now = Date.now() } = {}) {
  for (const row of (session.invitations ?? []).filter(item => item.kind === 'feedback' || item.shownAt && DECISION_KINDS.includes(item.kind))) closeInvitation(session, row.id, 'expired', { now });
}

/** Shown / answered / dismissed / lapsed counts per kind (developer metrics, plan §2.7). */
export function invitationMetrics(sessions) {
  const out = {};
  for (const session of sessions) for (const row of [...(session.invitationHistory ?? []), ...(session.invitations ?? []).map(item => ({ ...item, outcome: 'open' }))]) {
    const entry = out[row.kind] ??= { offered: 0, answered: 0, dismissed: 0, expired: 0, open: 0 };
    entry.offered++; entry[row.outcome] = (entry[row.outcome] ?? 0) + 1;
  }
  return out;
}

export class InvitationService {
  constructor(store, { decisions = null, mind = null, genes = null, schedules = null, now = Date.now } = {}) { Object.assign(this, { store, decisions, mind, genes, schedules, now }); this.rejudging = new Set(); this.taskJudging = new Set(); this.suggested = new Map(); this.pausing = new Set(); this.pauseJudged = new Set(); }
  say(variants) { return inLanguage(interfaceLanguageOf(this.store.state), variants); }
  offer(sessionId, fields) { let offered = null; this.store.mutate(state => { const session = state.sessions.find(row => row.id === sessionId); if (session && !session.archivedAt) offered = offerInvitation(session, fields, { now: this.now() }); }); return offered; }
  /** A message on the user's behalf after they chose an action in an invitation (their click, their words). It is a
   * follow-up (C2-c): with a turn running it waits until that turn ends, and never steers the work in flight. */
  post(sessionId, text, extra = {}) { return this.store.message(sessionId, { text, requestId: randomUUID(), ...extra, delivery: 'followup' }); }
  session(sessionId) { return this.store.state.sessions.find(row => row.id === sessionId) ?? (() => { throw fail('会话不存在', 404, 'session_not_found'); })(); }
  /** Close one open invitation (the thing it asked about was settled elsewhere). */
  close(sessionId, invitationId, outcome = 'expired') { let closed = null; this.store.mutate(state => { const session = state.sessions.find(row => row.id === sessionId); if (session) closed = closeInvitation(session, invitationId, outcome, { now: this.now() }); }); return Boolean(closed); }
  label(row, value) { if (row?.ledgerId) try { this.decisions?.labelDecision(row.ledgerId, value); } catch {} }
  /** turn.settled judged the reply worth an opinion: ask once, lightly. */
  offerFeedback(sessionId, { itemId, turnId, ledgerId = null }) {
    let offered = null;
    this.store.mutate(state => { const session = state.sessions.find(row => row.id === sessionId); if (session && !session.archivedAt) offered = offerInvitation(session, { kind: 'feedback', subject: `feedback:${itemId}`, itemId, ...(turnId ? { turnId } : {}), ...(ledgerId ? { ledgerId } : {}) }, { now: this.now() }); });
    return offered;
  }
  /** A learned lesson the user should confirm, in the project's current conversation. `conflictText`: the user's rule a
   * held lesson would replace (reason conflicts_user_lesson), named on the card. */
  offerLesson(sessionId, { projectId, lessonId, text, lessonKind, reason = null, conflictText = null }) {
    let offered = null;
    this.store.mutate(state => { const session = state.sessions.find(row => row.id === sessionId); if (session && !session.archivedAt) offered = offerInvitation(session, { kind: 'lesson', subject: `lesson:${lessonId}`, projectId, lessonId, text: String(text).slice(0, 400), lessonKind: lessonKind ?? null, ...(typeof reason === 'string' && reason ? { reason } : {}), ...(typeof conflictText === 'string' && conflictText.trim() ? { conflictText: conflictText.trim().slice(0, 400) } : {}) }, { now: this.now() }); });
    return offered;
  }
  /** An evolution decision for the user (retire an unused skill or a check that never caught anything). */
  offerGene(sessionId, { projectId, geneId, action = 'retire', title, usage = null, runs = null, total = null, files = null, reason = null, ledgerId = null }) {
    let offered = null;
    this.store.mutate(state => { const session = state.sessions.find(row => row.id === sessionId); if (session && !session.archivedAt) offered = offerInvitation(session, { kind: 'gene', subject: `${action}:${geneId}`, projectId, geneId, action, title: String(title ?? '').slice(0, 120), ...(usage ? { usage } : {}), ...(Number.isSafeInteger(runs) ? { runs } : {}), ...(Number.isSafeInteger(total) ? { total } : {}), ...(Number.isSafeInteger(files) ? { files } : {}), ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim().slice(0, 200) } : {}), ...(ledgerId ? { ledgerId } : {}) }, { now: this.now() }); });
    return offered;
  }
  /** A pending request past its time: keep going, or drop it (plan §2.1: 承诺逾期). */
  /** One overdue promise, asked in the conversation. `cycle` (its due time) lets a promise that is overdue again be asked again.
   * `trigger` says whose words it is: the user's request (also one whose turn failed) or the agent's own promise. */
  offerCommitment(sessionId, { projectId, commitmentId, request, cycle = '', trigger = 'user_request' }) {
    return this.offer(sessionId, { kind: 'commitment', subject: `commitment:${commitmentId}${cycle ? `:${cycle}` : ''}`, projectId, commitmentId, trigger: trigger === 'agent_promise' ? 'agent_promise' : 'user_request', text: String(request ?? '').slice(0, 300) });
  }
  /**
   * The user asked to settle what Rna owes them (the sidebar's "Rna 欠你 N 件事"): every overdue promise without an
   * open card gets one above the composer of the project conversation, whether or not it was asked before.
   * Returns the conversation to open, so the decision is made there.
   */
  askOverdue(projectId) {
    const project = this.store.state.projects.find(row => row.id === projectId), session = this.mind?.discussionSession?.(projectId);
    if (!project || !session) return { sessionId: session?.id ?? null, overdue: 0, offered: 0 };
    const due = (project.mind?.commitments ?? []).filter(row => commitmentOverdue(row, this.now())).slice(0, 3), at = new Date(this.now()).toISOString();
    const open = new Set((this.store.state.sessions.find(row => row.id === session.id)?.invitations ?? []).filter(row => row.kind === 'commitment').map(row => row.commitmentId));
    let offered = 0;
    for (const row of due) {
      if (open.has(row.id)) continue;
      if (this.offerCommitment(session.id, { projectId, commitmentId: row.id, request: row.request, trigger: row.trigger, cycle: `${row.overdueAt}:ask:${this.now()}` })) offered++;
      try { this.store.mutate(state => { const item = state.projects.find(entry => entry.id === projectId)?.mind?.commitments?.find(entry => entry.id === row.id); if (item) item.invitedAt = at; }); } catch {}
    }
    return { sessionId: session.id, overdue: due.length, offered };
  }
  /** A recurring request worth a schedule (JEV schedule.suggest); nothing is created unless the user accepts. */
  offerSchedule(sessionId, { projectId, title, task, time, timeZone, ledgerId = null }) {
    return this.offer(sessionId, { kind: 'schedule', subject: `schedule:${String(task).slice(0, 120)}`, projectId, title: String(title).slice(0, 60), text: String(task).slice(0, 600), time, timeZone, ...(ledgerId ? { ledgerId } : {}) });
  }
  /** The user is here (visible presence): stale decisions are judged again, an overdue request may be raised, and once a day a schedule may be suggested.
   * `sessionId`: the conversation they have in front. The schedule check comes first and reads the inbox before this
   * report's own reading marks (server.mjs marks the conversation read right after this call returns its promise). */
  async onPresence(projectId, { sessionId = null } = {}) {
    let pausing = null;
    try { const candidate = this.pauseCandidate(projectId, sessionId); if (candidate) pausing = this.offerSchedulePause(candidate).catch(() => null); } catch { /* the other checks below still run */ }
    const folded = [...await this.rejudgeStale(projectId).catch(() => []), ...await this.refoldTasks(projectId).catch(() => [])];
    this.offerOverdue(projectId);
    await this.offerTaskAttention(projectId).catch(() => null);
    // Questions the agent has been waiting on for a day or more are asked now, in one card, while the user is here.
    const asked = await Promise.resolve(this.mind?.askOpenQuestions?.(projectId)).catch(() => null);
    const suggested = await this.suggestSchedule(projectId).catch(() => null);
    const pause = await pausing;
    return { folded, suggested, ...(asked ? { asked } : {}), ...(pause ? { pause } : {}) };
  }
  /** Background work that needs the user (failed, or an outcome only they can confirm), asked here instead of on the task page. */
  offerTask(sessionId, { projectId, actionId, mode, text }) {
    return this.offer(sessionId, { kind: 'task', subject: `task:${actionId}`, projectId, actionId, mode, text: String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) });
  }
  /**
   * One piece of background work that needs the user, newest first. A failure is first judged
   * (JEV invite.stale) against what happened after it — later background work and the conversation;
   * one that later work or the user already settled is closed quietly instead of asked about.
   * Work from before a scope change (or from a deleted conversation) is not asked about again, except a result
   * still waiting to be checked that holds every foreground turn back (C2-d): it is named as the task page names it.
   */
  async offerTaskAttention(projectId) {
    const project = this.store.state.projects.find(row => row.id === projectId), session = this.mind?.discussionSession?.(projectId);
    if (!project || !session || project.archivedAt || this.taskJudging.has(projectId)) return null;
    const marks = project.taskMarks ?? {}, actions = project.initiativeRuntime?.sdkState?.actions ?? [], language = interfaceLanguageOf(this.store.state);
    const when = row => Date.parse(row.finishedAt ?? row.startedAt ?? row.createdAt ?? 0) || 0;
    const blocking = action => action.status === 'needs_review' && action.blocksExecution === true;
    const due = actions.filter(action => action.action === 'work' && ['needs_review', 'failed'].includes(action.status) && (!revoked(action) || blocking(action)) && !marks[action.id]?.invitedAt && !marks[action.id]?.acknowledgedAt)
      .sort((a, b) => when(b) - when(a));
    // The card quotes the name (后台“{text}”…); a revoked record with nothing readable left still gets a plain one.
    const name = action => revoked(action) ? revokedTaskLabel(project, action, { limit: 80, language, quoted: true }) || this.say({ zh: '之前的一项工作', en: 'an earlier task' }) : actionLabel(project, action, { limit: 80, language, quoted: true });
    if (!due.length) return null;
    this.taskJudging.add(projectId);
    try {
      for (const action of due.slice(0, TASK_JUDGE_LIMIT)) {
        if (action.status === 'failed' && typeof this.decisions?.inviteStale === 'function') {
          const verdict = await this.judgeTaskStale(project, action);
          if (verdict?.stale) { this.markTask(projectId, action.id, { acknowledgedAt: new Date(this.now()).toISOString(), choice: 'superseded', ...(verdict.ledgerId ? { ledgerId: verdict.ledgerId } : {}) }); continue; }
        }
        const offered = this.offerTask(session.id, { projectId, actionId: action.id, mode: action.status === 'needs_review' ? 'review' : 'failed', text: name(action) });
        this.markTask(projectId, action.id, { invitedAt: new Date(this.now()).toISOString() });
        return offered;
      }
      return null;
    } finally { this.taskJudging.delete(projectId); }
  }
  /** JEV invite.stale on a failed task: what happened after it (later background work and the conversation).
   * A revoked record's instruction was replaced by a placeholder: it is named as the user knew it (or by `text`, the card's line). */
  judgeTaskStale(project, action, { text } = {}) {
    const actions = project.initiativeRuntime?.sdkState?.actions ?? [], when = row => Date.parse(row.finishedAt ?? row.startedAt ?? row.createdAt ?? 0) || 0, after = when(action);
    const task = row => revoked(row) ? revokedTaskLabel(project, row, { limit: 300 }) : row.content ?? '';
    const since = [
      ...actions.filter(row => row.id !== action.id && when(row) > after && ['completed', 'failed', 'cancelled'].includes(row.status) && task(row))
        .map(row => ({ at: when(row), role: 'background work', text: `${row.status}: ${task(row)}${row.resultSummary ? ` → ${row.resultSummary}` : ''}` })),
      ...this.store.state.sessions.filter(row => row.projectId === project.id && !row.archivedAt).flatMap(row => row.items ?? [])
        .filter(item => ['user', 'assistant'].includes(item.kind) && typeof item.text === 'string' && item.text.trim() && Date.parse(item.createdAt ?? 0) > after)
        .map(item => ({ at: Date.parse(item.createdAt), role: item.kind, text: item.text })),
    ].sort((a, b) => a.at - b.at).slice(-8).map(({ role, text }) => ({ role, text }));
    return this.decisions.inviteStale(project, { kind: 'task', text: `Retry background work that did not finish (${action.errorCode ?? 'failed'}): ${text ?? task(action)}`, createdAt: action.finishedAt ?? action.startedAt, conversation: since }).catch(() => null);
  }
  /**
   * A "not finished, carry on?" card asked before later background work completed may be answered by that work
   * (the same step redone, or the goal reached another way). When work has completed since the card was last
   * judged, the same judge looks again; a superseded card closes quietly. Unconfirmed outcomes stay the user's call.
   */
  async refoldTasks(projectId) {
    const project = this.store.state.projects.find(row => row.id === projectId);
    if (!project || typeof this.decisions?.inviteStale !== 'function' || this.taskJudging.has(projectId)) return [];
    const actions = project.initiativeRuntime?.sdkState?.actions ?? [], when = row => Date.parse(row.finishedAt ?? row.startedAt ?? row.createdAt ?? 0) || 0;
    const latest = Math.max(0, ...actions.filter(row => row.action === 'work' && row.status === 'completed').map(when));
    const open = this.store.state.sessions.filter(row => row.projectId === projectId && !row.archivedAt).flatMap(session => (session.invitations ?? [])
      .filter(row => row.kind === 'task' && row.mode !== 'review' && latest > Date.parse(row.rejudgedAt ?? row.createdAt ?? 0)).map(row => ({ session, row })));
    if (!open.length) return [];
    this.taskJudging.add(projectId);
    const folded = [];
    try {
      for (const { session, row } of open.slice(0, TASK_JUDGE_LIMIT)) {
        const action = actions.find(item => item.id === row.actionId);
        const verdict = action?.status === 'failed' ? await this.judgeTaskStale(project, action, revoked(action) ? { text: revokedTaskLabel(project, action, { limit: 300 }) || row.text } : {}) : { stale: !action || action.status === 'completed' };
        const at = new Date(this.now()).toISOString();
        this.store.mutate(state => { const live = state.sessions.find(item => item.id === session.id)?.invitations?.find(item => item.id === row.id); if (live) live.rejudgedAt = at; });
        if (!verdict?.stale) continue;
        this.store.mutate(state => closeInvitation(state.sessions.find(item => item.id === session.id), row.id, 'expired', { now: this.now() }));
        this.markTask(projectId, row.actionId, { acknowledgedAt: at, choice: 'superseded', ...(verdict.ledgerId ? { ledgerId: verdict.ledgerId } : {}) });
        folded.push(row.id);
      }
    } finally { this.taskJudging.delete(projectId); }
    return folded;
  }
  markTask(projectId, actionId, fields) {
    try { this.store.mutate(state => { const project = state.projects.find(row => row.id === projectId); if (!project) return; project.taskMarks = { ...(project.taskMarks ?? {}), [actionId]: { at: new Date(this.now()).toISOString(), ...(project.taskMarks?.[actionId] ?? {}), ...fields } }; }); } catch {}
  }
  /**
   * The user's call on background work (from the strip above the composer or the task menu):
   * failed → continue (asked again in the conversation, in their name) | drop;
   * unconfirmed outcome → keep (count it as done as it is now) | drop (do not continue; what was done stays);
   * finished → acknowledge (a result that needed the user has been seen).
   * Either way it stops asking for them; any open invitation about it closes.
   * Work whose record a scope change revoked (or whose conversation was deleted) is named by what the host kept for the
   * user (revokedTaskLabel) or by the card the user answered, never by the placeholder that replaced its instruction.
   */
  async answerTask(projectId, actionId, choice, { sessionId = null } = {}) {
    const project = this.store.state.projects.find(row => row.id === projectId);
    // A run the SDK no longer lists (its record was compacted away) is still the user's while its job is kept: the task
    // page and the panel show it from the job, so it is answered the same way, named by the job.
    const job = project?.jobs?.find(row => row.id === actionId && !row.sourceDeleted);
    const action = project?.initiativeRuntime?.sdkState?.actions?.find(row => row.id === actionId)
      ?? (job ? { id: actionId, action: 'work', status: job.status === 'completed' ? 'completed' : 'failed', title: job.title, content: job.instruction ?? '', ...(job.contextRevoked ? { contextRevoked: true } : {}) } : null);
    if (!action) throw fail('后台任务不存在', 404, 'task_not_found');
    const review = action.status === 'needs_review', choices = review ? ['keep', 'drop'] : action.status === 'completed' ? ['continue', 'drop', 'acknowledge'] : ['continue', 'drop'];
    if (!choices.includes(choice)) throw fail(`choice 必须为 ${choices.join(' 或 ')}`);
    const cards = () => this.store.state.sessions.filter(row => row.projectId === projectId && row.invitations?.some(item => item.subject === `task:${actionId}`));
    const card = cards()[0]?.invitations.find(item => item.subject === `task:${actionId}`);
    const language = interfaceLanguageOf(this.store.state);
    const line = revoked(action) ? revokedTaskLabel(project, action, { language }) || String(card?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) : actionLabel(project, action, { limit: 120, language });
    if (review) {
      if (!this.initiative?.resolveAction) throw fail('主动协作控制器未启用', 503, 'initiative_unavailable');
      await this.initiative.resolveAction(projectId, actionId, { status: choice === 'keep' ? 'completed' : 'cancelled',
        summary: choice === 'keep' ? '用户确认：按现在的结果算完成。' : '用户选择不再继续；已经做了的保留（可在后台改动里回退），剩下的不做。' });
    }
    const target = !review && choice === 'continue' ? sessionId ?? this.mind?.discussionSession?.(projectId)?.id : null;
    if (!review && choice === 'continue' && !target) throw fail('项目没有可用的会话', 409, 'session_unavailable');
    // Nothing readable is left to carry on with: the card closes and the user is told to say it in their own words.
    const lost = Boolean(target) && !line;
    this.markTask(projectId, actionId, { acknowledgedAt: new Date(this.now()).toISOString(), choice: lost ? 'expired' : choice });
    // Answered before the message below goes out in the user's name (a message lets the invitations they went past lapse).
    for (const session of cards()) {
      const row = session.invitations.find(item => item.subject === `task:${actionId}`);
      this.store.mutate(state => closeInvitation(state.sessions.find(item => item.id === session.id), row.id, lost ? 'expired' : 'answered', { now: this.now() }));
    }
    if (lost) throw fail(this.say({ zh: '这项后台工作的记录已经失效，没法接着做了。可以直接在对话里说要做什么。', en: 'The record of this background work is no longer available, so it cannot be continued. Say in the conversation what you want done.' }), 409, 'task_context_revoked');
    // One line in the user's name; the turn receives the whole task through `continues`.
    if (target) this.post(target, this.say({ zh: `接着完成：${line}`, en: `Carry on with: ${line}` }), { continues: { actionId } });
    return { projectId, actionId, choice, revision: this.store.state.revision };
  }
  offerOverdue(projectId) {
    const project = this.store.state.projects.find(row => row.id === projectId), session = this.mind?.discussionSession?.(projectId);
    const due = (project?.mind?.commitments ?? []).find(row => commitmentOverdue(row, this.now()) && !row.invitedAt);
    if (!due || !session) return null;
    const offered = this.offerCommitment(session.id, { projectId, commitmentId: due.id, request: due.request, trigger: due.trigger, cycle: due.overdueAt });
    try { this.store.mutate(state => { const row = state.projects.find(item => item.id === projectId)?.mind?.commitments?.find(item => item.id === due.id); if (row) row.invitedAt = new Date(this.now()).toISOString(); }); } catch {}
    return offered;
  }
  async suggestSchedule(projectId) {
    if (typeof this.decisions?.scheduleSuggest !== 'function' || !this.schedules || this.now() - (this.suggested.get(projectId) ?? 0) < SUGGEST_EVERY_MS) return null;
    this.suggested.set(projectId, this.now());
    const project = this.store.state.projects.find(row => row.id === projectId), session = this.mind?.discussionSession?.(projectId);
    if (!project || !session || (project.schedules ?? []).length >= 8) return null;
    let defaults; try { defaults = this.schedules.agentView(projectId).defaults; } catch { defaults = { time: '09:00', timeZone: 'Asia/Shanghai' }; }
    const zone = defaults?.timeZone ?? 'Asia/Shanghai', since = this.now() - SUGGEST_WINDOW_MS;
    const parts = at => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long', hour: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at)).map(row => [row.type, row.value]));
    const requests = this.store.state.sessions.filter(row => row.projectId === projectId && !row.archivedAt).flatMap(row => row.items ?? []).filter(item => item.kind === 'user' && (!item.source || item.source === 'user') && typeof item.text === 'string' && item.text.trim() && Date.parse(item.createdAt ?? 0) > since)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(-12).map(item => { const at = parts(Date.parse(item.createdAt)); const hour = Number(at.hour); return { text: item.text.trim(), createdAt: item.createdAt, date: `${at.year}-${at.month}-${at.day}`, hour, day: at.weekday.toLowerCase(), time: hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening' }; });
    if (new Set(requests.map(row => row.date)).size < SUGGEST_MIN_DAYS) return null;
    const judged = await this.decisions.scheduleSuggest(project, { requests: requests.map(({ text, day, time }) => ({ text, day, time })) });
    if (!judged?.suggest || !Number.isInteger(judged.index)) return null;
    const chosen = requests[judged.index];
    if ((project.schedules ?? []).some(row => row.task?.trim() === chosen.text)) return null;
    const title = chosen.text.split('\n')[0].slice(0, 24);
    return this.offerSchedule(session.id, { projectId, title, task: chosen.text, time: `${String(chosen.hour).padStart(2, '0')}:00`, timeZone: zone, ledgerId: judged.ledgerId ?? null });
  }
  /** A schedule whose last results nobody opened: asked once whether to pause it. Nothing is paused unless the user says so. */
  offerPause(sessionId, { projectId, scheduleId, title, count, since, ledgerId = null }) {
    return this.offer(sessionId, { kind: 'schedule_pause', subject: `schedule_pause:${scheduleId}:${since}:${count}`, projectId, scheduleId, title: String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60), count, since, ...(ledgerId ? { ledgerId } : {}) });
  }
  /** The project's conversations a card can sit in (not archived, not a side chat). */
  liveSessions(projectId, state = this.store.state) { return state.sessions.filter(row => row.projectId === projectId && !row.archivedAt && row.kind !== 'side'); }
  /**
   * The user is here and a schedule's last results went unread while they were away (schedule-attention.mjs pauseVerdict,
   * all read from structure). Cards that no longer apply are closed first (the schedule is gone or off, or the user answered
   * a result that arrived after the card did). One schedule is asked about at a time, the longest run first, in the
   * conversation they have in front (else the project's current one). Synchronous on purpose: it reads the inbox before the
   * reading marks of the presence report that triggered it. Returns the candidate, or null.
   */
  pauseCandidate(projectId, sessionId = null) {
    const project = this.store.state.projects.find(row => row.id === projectId);
    if (!project || project.archivedAt || this.pausing.has(projectId)) return null;
    const sessions = this.liveSessions(projectId), now = this.now(), open = () => sessions.some(row => row.invitations?.some(item => item.kind === 'schedule_pause'));
    if (!project.schedules?.length && !open()) return null;
    for (const session of sessions) for (const card of (session.invitations ?? []).filter(item => item.kind === 'schedule_pause')) {
      const schedule = project.schedules?.find(row => row.id === card.scheduleId);
      const answeredSince = schedule?.enabled && deliveriesOf(project, schedule, sessions, { now }).some(row => row.state === 'responded' && Date.parse(row.at) > Date.parse(card.createdAt));
      if (!schedule?.enabled || answeredSince) this.close(session.id, card.id, 'expired');
    }
    // One question at a time: the next schedule is asked about once this card is answered.
    if (this.liveSessions(projectId).some(row => row.invitations?.some(item => item.kind === 'schedule_pause'))) return null;
    const asks = (project.schedules ?? []).map(schedule => ({ schedule, verdict: pauseVerdict(project, schedule, sessions, { now }) })).filter(row => row.verdict.ask).sort((a, b) => b.verdict.count - a.verdict.count);
    if (!asks.length) return null;
    const front = sessionId ? sessions.find(row => row.id === sessionId) : null, target = front ?? this.mind?.discussionSession?.(projectId);
    return target ? { projectId, sessionId: target.id, ...asks[0] } : null;
  }
  /**
   * The card for a candidate. Whether to ask is code; the one thing code cannot read is whether the user already said, in
   * words, that the results should keep coming unread ("keep it running, I'll read them when I'm back"): JEV invite.stale
   * judges that from their latest messages (12 labelled cases: stale at p ≤ .24, every other conversation ≥ .40; see
   * docs/research/schedule-pause-invitation-20261022.md), a veto only: no judge or no verdict asks. A vetoed state is not
   * judged again until the run grows. The record in `project.schedulePauseAsks` is what a refusal leaves behind.
   */
  async offerSchedulePause({ projectId, sessionId, schedule, verdict }) {
    const key = `${schedule.id}:${verdict.since}:${verdict.count}`;
    if (this.pauseJudged.has(key) || this.pausing.has(projectId)) return null;
    this.pausing.add(projectId);
    try {
      let ledgerId = null;
      if (typeof this.decisions?.inviteStale === 'function') {
        const project = this.store.state.projects.find(row => row.id === projectId);
        const said = this.liveSessions(projectId).flatMap(row => row.items ?? []).filter(item => item.kind === 'user' && typeof item.text === 'string' && item.text.trim() && !item.simulated).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(-8).map(item => ({ role: 'user', text: item.text }));
        const judged = await this.decisions.inviteStale(project, { kind: 'schedule_pause', text: pauseText(schedule.title, verdict.count), createdAt: new Date(this.now()).toISOString(), conversation: said }).catch(() => null);
        if (judged?.stale) { if (this.pauseJudged.size > 200) this.pauseJudged.clear(); this.pauseJudged.add(key); this.label(judged, 'folded'); return null; }
        ledgerId = judged?.ledgerId ?? null;
      }
      // The state may have moved during the judgment: ask only about a schedule that is still on and while no pause card is open.
      const live = this.store.state.projects.find(row => row.id === projectId), now = this.now();
      if (!live?.schedules?.find(row => row.id === schedule.id)?.enabled || this.liveSessions(projectId).some(row => row.invitations?.some(item => item.kind === 'schedule_pause'))) return null;
      const offered = this.offerPause(sessionId, { projectId, scheduleId: schedule.id, title: schedule.title, count: verdict.count, since: verdict.since, ledgerId });
      if (offered) this.store.mutate(state => { const target = state.projects.find(row => row.id === projectId); if (target) target.schedulePauseAsks = { ...(target.schedulePauseAsks ?? {}), [schedule.id]: { ...(target.schedulePauseAsks?.[schedule.id] ?? {}), at: new Date(now).toISOString(), since: verdict.since, run: verdict.count, outcome: 'asked' } }; });
      return offered;
    } finally { this.pausing.delete(projectId); }
  }
  /** What the user's answer to a pause card leaves in the project: a refusal (keep, or closing the card) raises the bar for the next ask to twice the run they refused. */
  notePauseAnswer(row, outcome) {
    this.store.mutate(state => {
      const project = state.projects.find(item => item.id === row.projectId), prior = project?.schedulePauseAsks?.[row.scheduleId];
      if (!project) return;
      const refused = outcome === 'declined' || outcome === 'dismissed';
      project.schedulePauseAsks = { ...(project.schedulePauseAsks ?? {}), [row.scheduleId]: { ...(prior ?? { since: row.since, run: row.count }), outcome, answeredAt: new Date(this.now()).toISOString(), ...(refused ? { refusedRun: Math.max(prior?.refusedRun ?? 0, row.count ?? 0) } : {}) } };
    });
  }
  /** The user is back (visible presence): decision invitations left open for over a day are judged
   * again (JEV invite.stale) against what was said since; ones that no longer matter are folded away.
   * Each invitation is re-judged at most once a day. */
  async rejudgeStale(projectId) {
    if (this.rejudging.has(projectId) || typeof this.decisions?.inviteStale !== 'function') return [];
    const now = this.now(), project = this.store.state.projects.find(row => row.id === projectId);
    const due = this.store.state.sessions.filter(row => row.projectId === projectId && !row.archivedAt).flatMap(session => (session.invitations ?? []).filter(row => DECISION_KINDS.includes(row.kind) && now - Date.parse(row.createdAt) > STALE_AFTER_MS && now - Date.parse(row.rejudgedAt ?? 0) > STALE_AFTER_MS).map(row => ({ session, row })));
    if (!due.length || !project) return [];
    this.rejudging.add(projectId);
    const folded = [];
    try {
      for (const { session, row } of due.slice(0, 4)) {
        const conversation = (session.items ?? []).filter(item => ['user', 'assistant'].includes(item.kind) && Date.parse(item.createdAt ?? 0) > Date.parse(row.createdAt) && typeof item.text === 'string' && item.text.trim()).slice(-8).map(item => ({ role: item.kind, text: item.text }));
        const text = row.kind === 'lesson' ? `Confirm the learned rule: ${row.text}` : row.kind === 'commitment' ? `Keep working on the earlier request: ${row.text}` : row.kind === 'task' ? (row.mode === 'review' ? `Confirm the outcome of interrupted background work: ${row.text}` : `Retry background work that did not finish: ${row.text}`) : row.kind === 'schedule' ? `Run this every day at ${row.time}: ${row.text}` : row.kind === 'schedule_pause' ? pauseText(row.title, row.count) : row.action === 'fix_hits' ? `Fix the ${row.total} existing hits of the check "${row.title}"` : `Retire the ${row.usage === 'never_caught' || String(row.geneId ?? '').startsWith('guard:') ? 'check' : 'skill'} "${row.title}"`;
        const verdict = await this.decisions.inviteStale(project, { kind: row.kind, text, createdAt: row.createdAt, conversation }).catch(() => null);
        this.store.mutate(state => { const live = state.sessions.find(item => item.id === session.id)?.invitations?.find(item => item.id === row.id); if (live) live.rejudgedAt = new Date(this.now()).toISOString(); });
        if (verdict?.stale) { this.store.mutate(state => closeInvitation(state.sessions.find(item => item.id === session.id), row.id, 'expired', { now: this.now() })); if (verdict.ledgerId) this.label({ ledgerId: verdict.ledgerId }, 'folded'); folded.push(row.id); }
      }
    } finally { this.rejudging.delete(projectId); }
    return folded;
  }
  /** A vote on a reply (from the strip or the message footer) answers its feedback invitation. */
  answeredFeedback(sessionId, itemId) {
    const session = this.store.state.sessions.find(row => row.id === sessionId), row = session?.invitations?.find(item => item.kind === 'feedback' && item.itemId === itemId);
    if (!row) return false;
    this.store.mutate(state => closeInvitation(state.sessions.find(item => item.id === sessionId), row.id, 'answered', { now: this.now() }));
    this.label(row, 'invite_accepted');
    return true;
  }
  /** POST /api/v2/sessions/:id/invitations/:invitationId
   * { action: 'shown' } (the strip put it in front of the user; the next message they send instead lets it lapse)
   * | { action: 'dismiss' } | { action: 'answer', choice: 'confirm'|'revoke'|'rewrite', text? } (lesson)
   * | { action: 'answer', choice: 'retire'|'keep' } (gene) | { action: 'answer', choice: 'pause'|'keep' } (schedule_pause). */
  async act(sessionId, invitationId, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['action', 'choice', 'text'].includes(key)) || !['shown', 'dismiss', 'answer'].includes(input.action)) throw fail('请求只能包含 action（shown、dismiss 或 answer）以及 choice、text');
    const row = this.session(sessionId).invitations?.find(item => item.id === invitationId);
    if (!row) return { sessionId, invitationId, closed: false, revision: this.store.state.revision };
    if (input.action === 'shown') {
      if (!row.shownAt) this.store.mutate(state => { const live = state.sessions.find(item => item.id === sessionId)?.invitations?.find(item => item.id === invitationId); if (live && !live.shownAt) live.shownAt = new Date(this.now()).toISOString(); });
      return { sessionId, invitationId, closed: false, shown: true, revision: this.store.state.revision };
    }
    if (input.action === 'dismiss') {
      this.store.mutate(state => closeInvitation(state.sessions.find(item => item.id === sessionId), invitationId, 'dismissed', { now: this.now() }));
      this.label(row, 'invite_dismissed');
      if (row.kind === 'lesson') this.mind?.answerLessonInvitation(row.projectId, row.lessonId, { choice: 'dismiss', sessionId });
      if (row.kind === 'schedule_pause') this.notePauseAnswer(row, 'dismissed');
      return { sessionId, invitationId, closed: true, outcome: 'dismissed', revision: this.store.state.revision };
    }
    const answered = label => { this.store.mutate(state => closeInvitation(state.sessions.find(item => item.id === sessionId), invitationId, 'answered', { now: this.now() })); this.label(row, label); return { sessionId, invitationId, closed: true, outcome: 'answered', revision: this.store.state.revision }; };
    const expect = choices => { if (!choices.includes(input.choice) || input.text !== undefined) throw fail(`choice 必须为 ${choices.join(' 或 ')}`); };
    if (row.kind === 'gene' && row.action === 'fix_hits') {
      expect(['fix', 'later']);
      const result = answered(input.choice === 'fix' ? 'fix_accepted' : 'fix_later');
      // "Fix": from now on this check's hits already in a file are the agent's to fix too (B1 baseline, tool-policy.mjs),
      // for the script the user saw them from (a revised check finds other hits, which nobody agreed to fix). "Later"
      // withdraws an earlier acceptance of this check.
      try {
        const project = this.store.state.projects.find(item => item.id === row.projectId), entry = input.choice === 'fix' && project ? guardsOf(project).find(item => item.gene.id === row.geneId) : null;
        const accepted = entry ? { at: new Date(this.now()).toISOString(), script: guardScript(entry.tool) } : null;
        this.genes?.genes?.record?.(row.projectId, row.geneId, gene => { if (accepted) gene.fixHitsAccepted = accepted; else delete gene.fixHitsAccepted; });
      } catch { /* the fix request below still goes out */ }
      if (input.choice === 'fix') this.post(sessionId, this.say({ zh: `按检查「${row.title}」把现有文件里发现的 ${row.total ?? ''} 处问题改掉。`, en: `Fix the ${row.total ?? ''} problems the check “${row.title}” found in existing files.` }));
      return result;
    }
    if (row.kind === 'gene') {
      expect(['retire', 'keep']);
      if (!this.genes) throw fail('进化服务未启用', 503, 'genes_unavailable');
      await this.genes.answerRetirement(row.projectId, row.geneId, input.choice);
      return answered(input.choice === 'retire' ? 'retire_accepted' : 'retire_declined');
    }
    if (row.kind === 'commitment') {
      expect(['continue', 'drop']);
      const result = answered(input.choice === 'continue' ? 'commitment_continue' : 'commitment_drop');
      if (input.choice === 'continue') {
        // The agent's own promise is posted as theirs to keep, not as something the user once asked for. The message names
        // the commitment it continues (MIND-5): the mind links it to that row instead of capturing a twin request.
        this.post(sessionId, row.trigger === 'agent_promise' ? this.say({ zh: `接着完成你之前说要做的：${row.text}`, en: `Carry on with what you said you would do: ${row.text}` }) : this.say({ zh: `接着完成：${row.text}`, en: `Carry on with: ${row.text}` }), { continues: { commitmentId: row.commitmentId } });
        // Carrying on starts a new window (D4): the promise stops counting as overdue, and is asked about again only when the evidence (or, with
        // no judge acting, the fallback clock) says it runs late again.
        this.store.mutate(state => { const item = state.projects.find(project => project.id === row.projectId)?.mind?.commitments?.find(entry => entry.id === row.commitmentId); if (item && item.status === 'pending') { const at = new Date(this.now()).toISOString(); restartWindow(item); Object.assign(item, { continuedAt: at, updatedAt: at }); } });
      }
      else this.store.mutate(state => { const item = state.projects.find(project => project.id === row.projectId)?.mind?.commitments?.find(entry => entry.id === row.commitmentId); if (item && item.status === 'pending') Object.assign(item, { status: 'dismissed', reason: 'user_dropped', updatedAt: new Date(this.now()).toISOString() }); });
      return result;
    }
    if (row.kind === 'task') {
      expect(row.mode === 'review' ? ['keep', 'drop'] : ['continue', 'drop']);
      await this.answerTask(row.projectId, row.actionId, input.choice, { sessionId });
      return { sessionId, invitationId, closed: true, outcome: 'answered', revision: this.store.state.revision };
    }
    if (row.kind === 'schedule') {
      expect(['accept', 'decline']);
      if (input.choice === 'accept') {
        if (!this.schedules) throw fail('日程服务未启用', 503, 'schedules_unavailable');
        this.schedules.create(row.projectId, { title: row.title, task: row.text, rule: { kind: 'daily', time: row.time, timeZone: row.timeZone }, enabled: true, destinationSessionId: sessionId }, { requestId: row.id, source: 'user', sessionId });
      }
      return answered(input.choice === 'accept' ? 'schedule_accepted' : 'schedule_declined');
    }
    if (row.kind === 'schedule_pause') {
      expect(['pause', 'keep']);
      if (input.choice === 'pause') {
        if (!this.schedules) throw fail('日程服务未启用', 503, 'schedules_unavailable');
        // Only `enabled` changes, as a pause from the schedule page does (the user's own edit): the task, rule and destination stay as written.
        if (this.store.state.projects.find(item => item.id === row.projectId)?.schedules?.find(item => item.id === row.scheduleId)?.enabled) this.schedules.update(row.projectId, row.scheduleId, { enabled: false });
      }
      this.notePauseAnswer(row, input.choice === 'pause' ? 'accepted' : 'declined');
      return answered(input.choice === 'pause' ? 'schedule_pause_accepted' : 'schedule_pause_declined');
    }
    if (row.kind !== 'lesson') throw fail('这条邀请通过评价回复来回答');
    if (!['confirm', 'revoke', 'rewrite'].includes(input.choice) || input.choice === 'rewrite' && (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 1000) || input.choice !== 'rewrite' && input.text !== undefined) throw fail('choice 必须为 confirm、revoke 或 rewrite（rewrite 需要 1–1000 字的 text）');
    if (!this.mind) throw fail('项目心智服务未启用', 503, 'mind_unavailable');
    this.mind.answerLessonInvitation(row.projectId, row.lessonId, { choice: input.choice, ...(input.text ? { text: input.text.trim() } : {}), sessionId });
    this.store.mutate(state => closeInvitation(state.sessions.find(item => item.id === sessionId), invitationId, 'answered', { now: this.now() }));
    return { sessionId, invitationId, closed: true, outcome: 'answered', revision: this.store.state.revision };
  }
}
