import { createHash, randomUUID } from 'node:crypto';
import { createAskUserTool, validateUserQuestions, validateUserAnswers, UserInteractionError } from '../../packages/sdk/src/user-interaction.mjs';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => structuredClone(value);
const fail = (message, status = 409, code = 'interaction_unavailable') => { throw Object.assign(new UserInteractionError(message, code), { status }); };
const requestId = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value)) fail('回答需要有效的 requestId', 400, 'invalid_answer'); return value; };
const active = status => ['pending', 'interrupted'].includes(status);
const interactionRecord = row => row && ['question', 'permission'].includes(row.kind);
const resultOf = record => ({ status: record.status, answers: copy(record.answers ?? []), permissionChanged: record.permissionChanged === true });
// The full-access notice (F88): the host says what was allowed; the model's reason is a secondary, bounded quote.
const PROJECT_TOOL_NAMES = { project_read: { zh: '读文件', en: 'read files' }, project_list: { zh: '列目录', en: 'list folders' }, project_find: { zh: '找文件', en: 'find files' }, project_grep: { zh: '搜索文件内容', en: 'search files' }, project_write: { zh: '写文件', en: 'write files' }, project_edit: { zh: '改文件', en: 'edit files' }, project_exec: { zh: '运行命令', en: 'run commands' } };
/** One line, tool ids as their display names, cut at the last sentence end that fits (or the limit) with an ellipsis. */
export function reasonExcerpt(text, language, limit = 120) {
  const line = String(text ?? '').replace(/\bproject_(?:read|list|find|grep|write|edit|exec)\b/g, id => inLanguage(language, PROJECT_TOOL_NAMES[id])).replace(/\s+/g, ' ').trim();
  if (line.length <= limit) return line;
  const head = line.slice(0, limit), end = Math.max(...['。', '！', '？', '；', '. ', '! ', '? ', '; '].map(mark => head.lastIndexOf(mark)));
  // A hard cut never splits an emoji (or any character outside the BMP) between its two halves.
  const cut = end >= limit / 2 ? head.slice(0, end) : head.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '');
  return `${cut.trimEnd()}…`;
}
export function fullAccessNotice(permission, reason, language) {
  const scope = inLanguage(language, permission?.workspace === 'write' ? { zh: '修改项目文件', en: 'edit project files' } : { zh: '修改项目文件和运行命令', en: 'edit project files and run commands' });
  const background = permission?.background === 'inherit' ? inLanguage(language, { zh: '（后台工作同样适用）', en: ' (background work included)' }) : '';
  const quoted = reasonExcerpt(reason, language);
  return inLanguage(language, { zh: `已按「完全访问」自动允许${scope}${background}。${quoted ? `申请理由：“${quoted}”` : ''}`, en: `Allowed automatically under Full access: ${scope}${background}.${quoted ? ` Reason given: "${quoted}"` : ''}` });
}
const unavailable = (state, session) => !session || Boolean(session.archivedAt || state.emergency || state.projects.find(project => project.id === session.projectId)?.archivedAt);

/** Durable questions belong to one conversation/tool call. Answers never alter permissions. */
export class UserInteractionService {
  constructor(store, { onPermissionAnswer } = {}) {
    this.store = store; this.waiters = new Map(); this.closed = false; this.writing = false; this.onPermissionAnswer = onPermissionAnswer;
    const recover = store.state.sessions.some(session => session.items.some(item => interactionRecord(item.interaction) && item.interaction.source === 'tool' && item.interaction.status === 'pending'));
    if (recover) this.mutate(state => { for (const session of state.sessions) for (const item of session.items) if (interactionRecord(item.interaction) && item.interaction.source === 'tool' && item.interaction.status === 'pending') Object.assign(item.interaction, { status: 'interrupted', interruptReason: 'runtime_restarted', canRespond: true }); });
    this.unsubscribe = store.subscribe(() => { if (!this.writing) this.reconcile(); }, { display: false }); this.reconcile();
  }
  mutate(fn) { this.writing = true; try { return this.store.mutate(fn); } finally { this.writing = false; } }
  setPermissionHandler(handler) { if (typeof handler !== 'function') throw new TypeError('Permission answer handler must be a synchronous function'); this.onPermissionAnswer = handler; }
  isWaiting(sessionId) { return [...this.waiters.values()].some(waiter => waiter.sessionId === sessionId); }
  questionMatches(record, checkpoint) {
    if (record?.kind !== 'question' || record.source !== 'tool' || record.toolCallId !== checkpoint?.toolCallId) return false;
    try { return record.fingerprint === hash([validateUserQuestions(checkpoint.arguments), null]); } catch { return false; }
  }
  lookup(sessionId, id, state = this.store.state) {
    const session = state.sessions.find(session => session.id === sessionId);
    const item = session?.items.find(item => interactionRecord(item.interaction) && item.interaction.id === id);
    if (!item) fail('问题不属于此会话或已被删除', 404, 'interaction_not_found');
    return { session, item, record: item.interaction };
  }
  valid(state, session, record) { return !unavailable(state, session) && (record.source !== 'tool' || session.activeTurnId === record.turnId); }
  createTools({ sessionId, turnId }) { return [createAskUserTool({ ask: input => this.ask({ ...input, sessionId, turnId }) })]; }
  publish({ sessionId, turnId = null, toolCallId = null, actionId = null, source, questions, metadata, ledgerId = null }) {
    if (this.closed) fail('交互服务已关闭', 503);
    if (metadata && (metadata.kind !== 'permission' || !metadata.permission || typeof metadata.permission !== 'object' || Array.isArray(metadata.permission))) fail('无效的宿主权限请求', 400);
    let normalized; try { normalized = validateUserQuestions({ questions }); } catch (error) { fail(error.message, 400, error.code); }
    const fingerprint = hash([normalized, metadata ?? null]);
    const id = hash([sessionId, source, turnId, toolCallId, actionId]);
    const session = this.store.state.sessions.find(session => session.id === sessionId);
    if (unavailable(this.store.state, session) || source === 'tool' && session.activeTurnId !== turnId) fail('原会话或任务已经不可继续');
    const old = session.items.find(item => item.interaction?.id === id)?.interaction;
    if (old) { if (old.fingerprint !== fingerprint) fail('相同问题请求不能替换问题内容', 409, 'interaction_conflict'); return copy(old); }
    return this.mutate(state => {
      const current = state.sessions.find(session => session.id === sessionId), now = new Date().toISOString();
      const record = { kind: metadata?.kind ?? 'question', ...(metadata ? { permission: copy(metadata.permission) } : {}), id, source, status: 'pending', canRespond: true, questions: normalized, fingerprint, turnId, toolCallId, actionId, createdAt: now, ...(ledgerId ? { ledgerId } : {}) };
      current.items.push({ id: randomUUID(), kind: 'question', text: '', turnId, createdAt: now, simulated: false, source: 'interaction', interaction: record }); current.updatedAt = now;
      return record;
    });
  }
  publishInitiative({ projectId, sessionId, actionId, questions, metadata }) {
    const session = this.store.state.sessions.find(session => session.id === sessionId);
    if (session?.projectId !== projectId || typeof actionId !== 'string' || !actionId) fail('主动问题没有有效的项目会话');
    return this.publish({ sessionId, actionId, source: 'initiative', questions, metadata });
  }
  async ask({ sessionId, turnId, toolCallId, questions, signal, metadata }) {
    if (signal?.aborted) throw new UserInteractionError('等待用户已中断', 'interaction_interrupted');
    if (typeof turnId !== 'string' || !turnId || typeof toolCallId !== 'string' || !toolCallId || toolCallId.length > 300) fail('结构化提问需要原任务和工具调用身份', 400);
    // ask.necessity: a question with a careful, easily changed default is not put to the user
    // (never a permission request, never one already on screen); the model states its default instead.
    const existing = this.store.state.sessions.find(row => row.id === sessionId)?.items.some(item => item.interaction?.toolCallId === toolCallId && item.interaction.source === 'tool');
    let necessityLedger = null;
    if (!metadata && !existing && typeof this.necessity === 'function') {
      let skip = false, ledgerId = null;
      try { const judged = await this.necessity({ sessionId, turnId, questions, signal }); skip = judged && typeof judged === 'object' ? judged.verdict : judged; ledgerId = judged && typeof judged === 'object' ? judged.ledgerId ?? null : null; } catch { skip = false; }
      necessityLedger = ledgerId;
      if (signal?.aborted) throw new UserInteractionError('等待用户已中断', 'interaction_interrupted');
      // A question not put to the user stays on the turn: the user's next message labels the judgment (a correction = it should have been asked).
      if ((skip === true || skip === 'known') && ledgerId) this.mutate(state => { const turn = state.sessions.find(row => row.id === sessionId)?.turns.find(row => row.id === turnId); if (turn) turn.judgments = [...(turn.judgments ?? []), { point: 'ask.necessity', ledgerId, skipped: skip === 'known' ? 'known' : 'default' }].slice(-8); });
      if (skip === 'known') return { status: 'not_asked', reason: 'known' };
      if (skip === true) return { status: 'not_asked' };
    }
    let record = this.publish({ sessionId, turnId, toolCallId, source: 'tool', questions, metadata, ledgerId: necessityLedger });
    if (!active(record.status)) return resultOf(record);
    if (this.waiters.has(record.id)) fail('此问题已由原工具调用等待', 409, 'interaction_conflict');
    const current = this.lookup(sessionId, record.id);
    if (current.session.status !== 'running') throw new UserInteractionError('原任务尚未恢复', 'interaction_interrupted');
    if (record.status === 'interrupted') record = this.mutate(state => { const row = this.lookup(sessionId, record.id, state).record; Object.assign(row, { status: 'pending', canRespond: true }); delete row.interruptReason; return row; });
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        try { this.interrupt(sessionId, record.id, 'task_interrupted'); }
        catch (error) { this.settle(record.id, error); }
      };
      this.waiters.set(record.id, { sessionId, resolve, reject, signal, onAbort });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
  settle(id, error, value) {
    const waiter = this.waiters.get(id); if (!waiter) return;
    this.waiters.delete(id); waiter.signal?.removeEventListener('abort', waiter.onAbort);
    if (error) waiter.reject(error); else waiter.resolve(value);
  }
  interrupt(sessionId, id, reason) {
    const found = this.lookup(sessionId, id);
    if (!active(found.record.status)) { this.settle(id, null, resultOf(found.record)); return; }
    const valid = this.valid(this.store.state, found.session, found.record);
    this.mutate(state => { const row = this.lookup(sessionId, id, state).record; Object.assign(row, { status: valid ? 'interrupted' : 'cancelled', canRespond: valid, ...(valid ? { interruptReason: reason } : { cancelReason: reason }), updatedAt: new Date().toISOString() }); });
    this.settle(id, new UserInteractionError('等待用户已中断；原问题和已确认答复仍保留', 'interaction_interrupted'));
  }
  reconcile() {
    if (this.closed || this.writing) return;
    const changes = [];
    for (const session of this.store.state.sessions) for (const item of session.items) {
      const row = item.interaction; if (!interactionRecord(row) || !active(row.status)) continue;
      if (!this.valid(this.store.state, session, row)) changes.push({ sessionId: session.id, id: row.id, status: 'cancelled', reason: 'session_or_task_unavailable' });
      else if (row.source === 'tool' && row.status === 'pending' && session.status !== 'running') changes.push({ sessionId: session.id, id: row.id, status: 'interrupted', reason: 'task_paused' });
    }
    if (changes.length) this.mutate(state => { for (const change of changes) { const row = this.lookup(change.sessionId, change.id, state).record; Object.assign(row, { status: change.status, canRespond: change.status === 'interrupted', updatedAt: new Date().toISOString(), ...(change.status === 'cancelled' ? { cancelReason: change.reason } : { interruptReason: change.reason }) }); } });
    for (const [id, waiter] of [...this.waiters]) {
      let found; try { found = this.lookup(waiter.sessionId, id); } catch { this.settle(id, new UserInteractionError('原会话已被删除', 'interaction_interrupted')); continue; }
      if (found.record.status === 'interrupted' || found.record.status === 'cancelled') this.settle(id, new UserInteractionError('原问题等待已中断', 'interaction_interrupted'));
    }
  }
  /**
   * answer.match (plan §2.5 item 12): the user typed a message while a question card was open. When
   * JEV is confident the message answers every question, the card is marked answered with those
   * choices (the waiting task continues; the model does not ask again). Permission requests are never
   * answered this way.
   */
  async matchMessage(sessionId, { text, itemId = null } = {}) {
    if (this.closed || typeof this.decisions?.answerMatch !== 'function' || typeof text !== 'string' || !text.trim()) return [];
    const session = this.store.state.sessions.find(row => row.id === sessionId);
    const open = (session?.items ?? []).filter(item => item.interaction?.kind === 'question' && active(item.interaction.status) && item.interaction.canRespond !== false && this.valid(this.store.state, session, item.interaction)).slice(-2);
    const project = this.store.state.projects.find(row => row.id === session?.projectId) ?? null, answered = [];
    for (const item of open) {
      const record = item.interaction;
      const judged = await this.decisions.answerMatch(project, { message: text, questions: record.questions }).catch(() => null);
      if (!judged || judged.picks.length !== record.questions.length || judged.picks.some(pick => pick === null)) continue;
      const answers = record.questions.map((question, index) => {
        const pick = judged.picks[index], option = Number.isInteger(pick) ? question.options?.[pick] : null;
        return option ? { id: question.id, selected: [option.id] } : question.allowCustom === false ? null : { id: question.id, selected: [], custom: text.trim().slice(0, 4000) };
      });
      if (answers.some(row => !row)) continue;
      try { this.respond(sessionId, record.id, { requestId: `message-${(itemId ?? randomUUID()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120)}`, answers }, false, { via: 'message' }); answered.push(record.id); } catch { /* the card moved on meanwhile */ }
    }
    return answered;
  }
  answer(sessionId, id, input = {}) { return this.respond(sessionId, id, input, false); }
  cancel(sessionId, id, input = {}) { return this.respond(sessionId, id, input, true); }
  respond(sessionId, id, input, cancel, { via = 'card' } = {}) {
    if (this.closed) fail('交互服务已关闭', 503);
    const key = requestId(input.requestId), found = this.lookup(sessionId, id);
    let answers; try { answers = cancel ? [] : validateUserAnswers(found.record.questions, input.answers); } catch (error) { fail(error.message, 400, error.code); }
    if (Object.keys(input).some(key => !(cancel ? ['requestId'] : ['requestId', 'answers']).includes(key))) fail('回答不能附带权限或其他操作', 400, 'invalid_answer');
    const fingerprint = hash([cancel, answers]);
    if (found.record.responseRequestId === key) {
      if (found.record.responseFingerprint !== fingerprint) fail('相同 requestId 对应了不同答复', 409, 'interaction_conflict');
      return { interaction: copy(found.record), requiresResume: found.record.source === 'tool' && found.session.status === 'paused' && found.session.activeTurnId === found.record.turnId, replayed: true };
    }
    if (!active(found.record.status) || !this.valid(this.store.state, found.session, found.record)) fail('问题已结束或原任务不可继续', 409);
    const record = this.mutate(state => {
      const { session, record } = this.lookup(sessionId, id, state), now = new Date().toISOString();
      if (record.kind === 'permission') {
        if (typeof this.onPermissionAnswer !== 'function') fail('此权限请求缺少宿主校验器，不能应用答复', 503);
        const result = this.onPermissionAnswer({ state, session, interaction: copy(record), answers: copy(answers), cancel });
        if (result && typeof result.then === 'function') throw new TypeError('Permission answer handlers must be synchronous');
        record.permissionChanged = result?.permissionChanged === true;
      }
      Object.assign(record, { status: cancel ? 'cancelled' : 'answered', canRespond: false, answers, answeredAt: now, responseRequestId: key, responseFingerprint: fingerprint, ...(cancel ? { cancelReason: 'user_cancelled' } : {}), ...(via === 'message' ? { answeredVia: 'message' } : via === 'full-access' ? { answeredVia: 'full-access' } : {}) });
      // Allowed because the project is at 完全访问: a host notice says so; it is not presented as the user's answer.
      if (via === 'full-access') session.items.push({ id: randomUUID(), kind: 'notice', text: fullAccessNotice(record.permission, record.permission?.reason, interfaceLanguageOf(state)), turnId: record.turnId ?? null, createdAt: now, simulated: false, source: 'full-access', interactionId: id });
      // Answered by the user's own message: that message is already in the conversation, so no echo item.
      else if (record.source === 'initiative' && via !== 'message') {
        const text = cancel ? '已取消这次结构化问题；没有选择或授权任何操作。' : record.questions.map(question => { const answer = answers.find(answer => answer.id === question.id); return `${question.question}\n${answer.selected.map(id => question.options.find(option => option.id === id).label).join('；')}${answer.custom ? `\n补充：${answer.custom}` : ''}`; }).join('\n\n');
        session.items.push({ id: randomUUID(), kind: 'user', text, turnId: null, createdAt: now, simulated: false, source: 'interaction-answer', interactionId: id });
      }
      session.updatedAt = now; return record;
    });
    this.settle(id, null, resultOf(record));
    // Label loop (plan §3.4): the judgment that decided to ask learns how the card ended.
    if (record.ledgerId && via !== 'full-access') try { this.decisions?.labelDecision?.(record.ledgerId, cancel ? 'asked_cancelled' : via === 'message' ? 'asked_answered_in_text' : 'asked_answered'); } catch {}
    return { interaction: record, requiresResume: record.source === 'tool' && found.session.status === 'paused', replayed: false };
  }
  close() {
    if (this.closed) return; this.unsubscribe();
    for (const [id, waiter] of [...this.waiters]) { try { this.interrupt(waiter.sessionId, id, 'runtime_closed'); } catch (error) { this.settle(id, error); } }
    this.closed = true;
  }
}
