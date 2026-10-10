import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { createSession } from '../../packages/sdk/src/session.mjs';
import { digest } from '../../packages/sdk/src/journal.mjs';
import { resolveModel } from './configuration.mjs';
import { reserveRealTokens, releaseRealTokens, chargeRealTokens } from './budget-service.mjs';
import { addObservation } from './project-proactivity.mjs';
import { runtimeFailureMessage } from './runtime-errors.mjs';
import { providerDiagnostic } from '../../packages/sdk/src/provider-diagnostics.mjs';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';
import { reasoningFor, compactionEffortInput, liveModel } from './internal-reasoning.mjs';

const now = () => new Date().toISOString();
/** Command feedback the user reads (notices, progress, refusals) follows the interface language. */
const said = (state, zh, en) => inLanguage(interfaceLanguageOf(state), { zh, en });
const fail = (message, code, status = 400) => { throw Object.assign(new Error(message), { code, status }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const within = (root, target) => { const path = relative(root, target); return !path || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
const valueText = (value, label, max, optional = false) => {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail(`${label}格式不正确。`, 'invalid_command');
  return value.trim();
};
const commandIds = ['file', 'goal', 'plan', 'feedback', 'compact', 'permission', 'model', 'export'];
const safeCode = error => /^[a-z][a-z0-9_]{0,63}$/.test(error?.code) ? error.code : error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'command_cancelled' : 'command_failed';
/** Why a compaction did not finish, in words. The original history is always kept. */
const COMPACT_FAILURES = {
  context_limit: { zh: '较早的记录即使分批也放不进当前模型的上下文。可以切换上下文更大的模型后重新执行。', en: 'The earlier history does not fit the current model\'s context, even in batches. Switch to a model with a larger context and run it again.' },
  invalid_summary: { zh: '模型没有返回完整的摘要。可以重新执行。', en: 'The model did not return a complete summary. You can run it again.' },
  summary_error: { zh: '模型没有返回完整的摘要。可以重新执行。', en: 'The model did not return a complete summary. You can run it again.' },
  budget: { zh: '模型用量预算不足，这次没有执行。', en: 'The model usage budget is too low, so it did not run.' },
  busy: { zh: '会话正在运行，请等当前轮次结束后再压缩。', en: 'The conversation is running; compact it after the current turn ends.' },
  journal_locked: { zh: '会话记录正被占用，请稍后再试。', en: 'The conversation record is in use; try again in a moment.' },
  command_cancelled: { zh: '压缩已取消或超时。可以重新执行。', en: 'The compaction was cancelled or timed out. You can run it again.' },
};
/**
 * Why a compaction did not finish, in the interface language. A provider's answer (the SDK attaches its diagnostic)
 * gets the guidance a failed conversation turn gets; the compaction's own stops (a history that does not fit even in
 * batches, a cut-off summary, the budget) keep their more precise words.
 */
const failureReason = (error, code, language) => {
  const known = !error?.errorDiagnostic && Object.hasOwn(COMPACT_FAILURES, code) ? COMPACT_FAILURES[code] : null;
  if (known) return inLanguage(language, { zh: `上下文压缩未完成，原始对话已保留：${known.zh}`, en: `Context compaction did not finish; the original conversation is kept: ${known.en}` });
  // Every failure here is a compaction's, so the guidance always says the original conversation is kept.
  return runtimeFailureMessage({ errorDiagnostic: providerDiagnostic(error, 'compaction') }, language);
};
/**
 * The host's own refusals (fail) are already worded for the user and keep their status. Anything else is explained
 * in words, and the response carries the host's status (409/502), never the provider's 401/429.
 */
const commandError = (error, state) => {
  const code = safeCode(error), refusal = !error?.errorDiagnostic && Number.isInteger(error?.status) && error.status < 500;
  const message = refusal ? error.message : failureReason(error, code, interfaceLanguageOf(state)) ?? said(state, '命令未完成；原始会话保留。请检查状态后再明确重试。', 'The command did not finish; the original conversation is kept. Check its state, then retry explicitly.');
  return Object.assign(new Error(message), { code, status: refusal ? error.status : ['busy', 'journal_locked', 'uncertain_tool', 'budget'].includes(error?.code) ? 409 : 502 });
};
const interruptedCompaction = state => said(state, '上下文压缩被中断（服务重启或停止），原始对话已保留。可以重新执行。', 'Context compaction was interrupted (the service restarted or stopped); the original conversation is kept. You can run it again.');
/** Turns the compaction progress line into its outcome; false when there is none (older requests). */
function settleProgress(session, requestId, text) {
  const item = session.items?.find(row => row.kind === 'notice' && row.progress && row.commandRequestId === requestId);
  if (!item) return false;
  item.text = text; delete item.progress; item.settledAt = now(); session.updatedAt = now();
  return true;
}

// Single-session UI transcript export. No arbitrary filesystem reads, provider
// configs, credentials, nested archives or attachment bytes enter this archive.
function redactor(store) {
  const config = store.state.configuration ?? {}, service = store.configurationService;
  const secrets = new Set([...Object.values(service?.secrets ?? {}), ...(service?.secretValues?.() ?? [])].filter(value => typeof value === 'string' && value));
  for (const provider of [...config.providers ?? [], { ...config.memory, id: 'openviking' }]) {
    const secret = service?.secret(provider.id, provider); if (typeof secret === 'string' && secret) secrets.add(secret);
  }
  for (const item of [...store.state.capabilities?.tools ?? [], ...store.state.capabilities?.mcpServers ?? []]) for (const name of [...item.envNames ?? [], ...Object.values(item.envMapping ?? {}), ...Object.values(item.headerEnv ?? {})]) if (process.env[name]) secrets.add(process.env[name]);
  for (const [key, value] of Object.entries(process.env)) if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(key) && value) secrets.add(value);
  const values = [...secrets].flatMap(value => [value, encodeURIComponent(value)]).sort((a, b) => b.length - a.length);
  const clean = (value, key = '') => {
    if (/^(?:api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token|private[-_]?key|credentials|env)$/i.test(key)) return '[REDACTED]';
    if (typeof value === 'string') { for (const secret of values) value = value.split(secret).join('[REDACTED]'); return value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'); }
    if (Array.isArray(value)) return value.map(item => clean(item));
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, clean(item, name)]));
    return value;
  };
  return clean;
}
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const local = [], directory = []; let offset = 0, size = 0;
  for (const [name, text] of entries) {
    const filename = Buffer.from(name), bytes = Buffer.from(text); size += bytes.length;
    if (size > 32 * 1024 * 1024) fail('当前会话导出超过 32 MB 上限。', 'export_too_large', 413);
    const crc = crc32(bytes), head = Buffer.alloc(30), entry = Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt32LE(crc, 14); head.writeUInt32LE(bytes.length, 18); head.writeUInt32LE(bytes.length, 22); head.writeUInt16LE(filename.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(head, filename, bytes); directory.push(entry, filename); offset += head.length + filename.length + bytes.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}

export class SessionCommandService {
  constructor(store, { executor, factory = createSession, timeoutMs = 120000, decisions = null } = {}) {
    this.store = store; this.executor = executor; this.factory = factory; this.timeoutMs = timeoutMs; this.decisions = decisions; this.inflight = new Map();
    if (store.state.sessions.some(session => session.commandHistory?.some(item => item.status === 'running'))) store.mutate(state => {
      for (const session of state.sessions) for (const item of session.commandHistory ?? []) if (item.status === 'running') {
        item.status = 'interrupted'; item.code = 'command_interrupted'; item.completedAt = now();
        settleProgress(session, item.requestId, interruptedCompaction(state));
      }
    });
  }
  /** A manual summary's reasoning effort (internal-reasoning.mjs reasoningFor, purpose compaction): undefined keeps the conversation's. Never throws. */
  async summaryEffort(session, model, request, input = {}) {
    try {
      const project = (this.store.state.projects ?? []).find(row => row.id === session.projectId) ?? null;
      const live = liveModel(model, input.model);
      const routed = await reasoningFor({ decisions: this.decisions, configuration: this.store.state.configuration, project, model: live, purpose: 'compaction', call: compactionEffortInput({ historyTokens: input.estimatedInputTokens, manual: true, request: String(request?.args?.instructions ?? '').slice(0, 600) }), signal: input.signal });
      return routed.reasoning !== live.reasoning ? routed.reasoning : undefined;
    } catch { return undefined; }
  }
  session(id, state = this.store.state) {
    const session = state.sessions.find(item => item.id === id) ?? fail(said(state, '会话不存在。', 'The conversation does not exist.'), 'session_missing', 404);
    const project = state.projects.find(item => item.id === session.projectId);
    if (session.archivedAt || project?.archivedAt) fail(said(state, '请先恢复已归档会话或项目。', 'Restore the archived conversation or project first.'), 'session_archived', 409);
    return { session, project };
  }
  busy(session) { return Boolean(session.activeTurnId || session.status === 'running' || this.executor?.running?.has(session.id) || this.executor?.maintenance?.has(session.id)); }
  describe(id) {
    const { session, project } = this.session(id), busy = this.busy(session);
    return { sessionId: id, mode: session.mode === 'plan' ? 'plan' : 'build', maintenance: { running: this.executor?.maintenance?.has(id) ?? false }, commands: commandIds.map(command => {
      const reason = ['goal', 'feedback'].includes(command) && !project ? 'project_required' : ['plan', 'compact'].includes(command) && busy ? 'session_busy' : command === 'compact' && !this.executor?.runMaintenance ? 'runtime_unavailable' : null;
      return { id: command, available: !reason, ...(reason ? { reason } : {}) };
    }) };
  }
  validate(input) {
    if (!object(input) || !['plan', 'goal', 'feedback', 'compact'].includes(input.command) || !object(input.args ?? {})) fail('命令格式不正确。', 'invalid_command');
    const requestId = valueText(input.requestId, 'requestId', 128); if (!/^[A-Za-z0-9_.:-]+$/.test(requestId)) fail('requestId格式不正确。', 'invalid_command');
    const args = input.args ?? {}, command = input.command;
    let normalized;
    if (command === 'plan') { if (!['plan', 'build'].includes(args.mode)) fail('模式必须是 plan 或 build。', 'invalid_command'); normalized = { mode: args.mode }; }
    else if (command === 'compact') normalized = { instructions: valueText(args.instructions, '整理要求', 4000, true) };
    else {
      normalized = { text: valueText(args.text, '内容', command === 'goal' ? 4000 : 8000) };
      if (command === 'goal' && args.constraints !== undefined) {
        if (!Array.isArray(args.constraints) || args.constraints.length > 20) fail('约束数量不得超过20条。', 'invalid_command');
        normalized.constraints = args.constraints.map(value => valueText(value, '约束', 500));
        if (normalized.text.length + normalized.constraints.join('；').length > 7800) fail('关注与约束总长度不得超过7800字符。', 'invalid_command');
      }
      if (command === 'feedback') {
        if (args.rating !== undefined && !['positive', 'negative', 'neutral'].includes(args.rating)) fail('反馈类型不正确。', 'invalid_command');
        normalized.rating = args.rating ?? 'neutral'; if (args.itemId !== undefined) normalized.itemId = valueText(args.itemId, 'itemId', 160);
      }
    }
    return { requestId, command, args: normalized, fingerprint: digest([command, normalized]) };
  }
  async execute(id, input) {
    const request = this.validate(input), { session, project } = this.session(id), key = `${id}:${request.requestId}`, state = this.store.state;
    if (session.appRecovery?.required) fail(said(state, '此会话已从恢复点还原，请新建会话执行新指令。', 'This conversation was restored from a recovery point; start a new conversation for new commands.'), 'restore_review', 409);
    const active = this.inflight.get(key);
    if (active) { if (active.fingerprint !== request.fingerprint) fail('同一 requestId 不能执行不同命令。', 'command_conflict', 409); return active.promise; }
    const prior = session.commandHistory?.find(item => item.requestId === request.requestId);
    if (prior) {
      if (prior.fingerprint !== request.fingerprint) fail('同一 requestId 不能执行不同命令。', 'command_conflict', 409);
      if (['completed', 'noop'].includes(prior.status)) return { command: prior.command, requestId: prior.requestId, status: prior.status, result: structuredClone(prior.result), duplicate: true };
      // The same request is never run twice; say what happened to it and that a new run is the way forward.
      fail(prior.status === 'failed' && prior.message ? said(state, `${prior.message}（同一请求不会重复执行，请选择重新执行。）`, `${prior.message} (The same request is not run twice; choose to run it again.)`) : prior.status === 'interrupted' ? interruptedCompaction(state) : said(state, '此前命令未完成，请确认结果后使用新的请求重试。', 'An earlier run of this command did not finish. Check its result, then retry with a new request.'), prior.code ?? 'command_interrupted', 409);
    }
    if ((session.commandHistory?.length ?? 0) >= 2048) fail(said(state, '此会话命令回执已达上限，请创建新会话。', 'This conversation has reached its command limit; start a new conversation.'), 'command_history_full', 409);
    if (['plan', 'compact'].includes(request.command) && this.busy(session)) fail(said(state, '请完成或停止当前轮次后再执行此命令。', 'Finish or stop the current turn before running this command.'), 'session_busy', 409);
    if (['goal', 'feedback'].includes(request.command) && !project) fail(said(state, '此命令需要项目会话。', 'This command needs a project conversation.'), 'project_required', 409);
    if (request.args.itemId && !session.items.some(item => item.id === request.args.itemId)) fail(said(state, '反馈引用的消息不属于此会话。', 'The message this feedback refers to is not in this conversation.'), 'invalid_item', 400);
    if (request.command !== 'compact') return this.apply(id, request);
    if (!this.executor?.runMaintenance) fail(said(state, '真实运行时尚未启用。', 'The model runtime is not available yet.'), 'runtime_unavailable', 503);
    // Claim the per-session writer before persisting the request or awaiting I/O.
    const promise = this.executor.runMaintenance(id, signal => this.compact(id, request, signal));
    this.inflight.set(key, { promise, fingerprint: request.fingerprint });
    try { return await promise; } finally { this.inflight.delete(key); }
  }
  receipt(session, request, status, result) {
    session.commandHistory ??= [];
    let record = session.commandHistory.find(item => item.requestId === request.requestId);
    if (!record) { record = { requestId: request.requestId, command: request.command, fingerprint: request.fingerprint, createdAt: now() }; session.commandHistory.push(record); }
    Object.assign(record, { status, ...(result ? { result } : {}), ...(status !== 'running' ? { completedAt: now() } : {}) }); session.updatedAt = now();
    return { command: request.command, requestId: request.requestId, status, result };
  }
  notice(session, text) { const item = { id: randomUUID(), kind: 'notice', text, createdAt: now(), simulated: false, source: 'session-command' }; session.items.push(item); return item; }
  /** The line in the conversation while a compaction runs; it becomes the result (or the reason it stopped). */
  progress(state, session, requestId) { const item = this.notice(session, said(state, '正在用当前模型整理较早上下文，较长的对话会分几批整理；原始记录会保留。', 'Compacting earlier context with the current model; long conversations are done in batches. The original record is kept.')); Object.assign(item, { progress: true, commandRequestId: requestId }); session.updatedAt = now(); return item; }
  apply(id, request) {
    return this.store.mutate(state => {
      const { session, project } = this.session(id, state), { command, args } = request; let result;
      if (command === 'plan') { session.mode = args.mode; result = { mode: args.mode }; this.notice(session, args.mode === 'plan' ? said(state, '已进入计划模式：只读调查与讨论，写入和命令执行均停用。', 'Plan mode is on: read-only investigation and discussion; writing files and running commands are off.') : said(state, '已退出计划模式；后续轮次仍按项目已授权的权限执行。', 'Plan mode is off; later turns use the permissions the project has granted.')); }
      else {
        const notice = this.notice(session, command === 'goal' ? said(state, `项目关注已更新：${args.text}`, `Project focus updated: ${args.text}`) : said(state, `已保存项目反馈：${args.text}`, `Project feedback saved: ${args.text}`));
        if (command === 'goal') {
          project.focus = args.text;
          if (args.constraints) { project.commitments = project.commitments.filter(item => item.source !== 'user-command'); project.commitments.push(...args.constraints.map(text => ({ id: randomUUID(), text, source: 'user-command', sessionId: id, messageId: notice.id, createdAt: now(), simulated: false }))); }
        }
        const { observation } = addObservation(state, project, { kind: command === 'goal' ? 'context' : 'preference', eventId: `command-${digest([id, request.requestId])}`, text: command === 'goal' ? `用户更新项目关注：${args.text}${args.constraints?.length ? `；约束：${args.constraints.join('；')}` : ''}` : args.text, relevance: 1, data: { command, sessionId: id, messageId: notice.id, ...(args.itemId ? { itemId: args.itemId } : {}), ...(args.rating ? { rating: args.rating } : {}) } });
        observation.simulated = false; observation.source = 'user-command';
        const fact = project.facts.find(item => item.evidenceId === observation.id); if (fact) { fact.simulated = false; fact.source = 'user-command'; }
        result = { projectId: project.id, observationId: observation.id, noticeId: notice.id };
      }
      return this.receipt(session, request, 'completed', result);
    });
  }
  async compact(id, request, hostSignal) {
    const signal = AbortSignal.any([hostSignal, AbortSignal.timeout(this.timeoutMs)]), reservationKey = `command:${id}:${request.requestId}`;
    let handle, reservation = false, started = false, accountingError, projectionIdentity;
    this.store.mutate(state => this.receipt(this.session(id, state).session, request, 'running'));
    try {
      signal.throwIfAborted();
      // An idle background summary of this conversation stops first; one already prepared is used below. Keep-alive
      // pings stop too: they would refresh the history this command replaces.
      try { this.store.usageLedger?.keepAlive?.forget?.(id); } catch { /* never fails the command */ }
      await this.executor?.idleCompaction?.quiesce?.(id);
      const { session } = this.session(id), stateDir = resolve(`${this.store.file}.rna`, id);
      const file = resolve(session.runtime?.engine === 'rna' && session.runtime.sessionFile || resolve(stateDir, `${digest(id).slice(0, 24)}.rna.jsonl`));
      if (!existsSync(file)) return this.store.mutate(state => this.receipt(this.session(id, state).session, request, 'noop', { compacted: false, reason: '没有可整理的真实会话记录。' }));
      const parent = realpathSync(`${this.store.file}.rna`), root = realpathSync(stateDir), actual = realpathSync(file);
      if (!within(parent, root) || !within(root, actual) || !statSync(actual).isFile()) fail(said(this.store.state, '会话日志路径不可信。', 'The conversation log path is not trusted.'), 'invalid_path', 409);
      projectionIdentity = { sessionFile: session.runtime?.sessionFile, updatedAt: session.runtime?.updatedAt, activeTurnId: session.activeTurnId };
      const model = resolveModel(this.store.state.configuration, session.modelSelection);
      if (model.execution !== 'rna') fail(said(this.store.state, '压缩需要已配置的真实模型。', 'Compaction needs a configured real model.'), 'real_model_required', 409);
      this.store.mutate(state => this.progress(state, this.session(id, state).session, request.requestId));
      const provider = this.store.state.configuration.providers.find(item => item.id === model.providerId), apiKey = this.store.configurationService.secret(provider.id, provider);
      handle = await this.factory({ sessionId: id, projectId: session.projectId, cwd: this.executor.workspace(session), stateDir, sessionFile: actual, model, apiKey, tools: [], autoCompaction: false,
        // The summary's effort: the one internal plan (purpose compaction), as for in-turn and idle summaries.
        sideReasoning: input => this.summaryEffort(session, model, request, input),
        beforeCompletion: ({ signal: requestSignal, estimatedInputTokens, maxOutputTokens }) => {
          requestSignal.throwIfAborted(); signal.throwIfAborted();
          this.store.mutate(state => reserveRealTokens(state, reservationKey, Math.ceil(estimatedInputTokens + maxOutputTokens + 1536))); reservation = true;
        },
        onEvent: event => {
          if (event.type === 'compaction_request_start') started = true;
          if (event.type !== 'compaction_request_end' || !reservation) return;
          try {
            this.store.mutate(state => {
              const reserved = releaseRealTokens(state, reservationKey), reported = event.usageReported !== false && event.usage, amount = reported ? Number(event.usage.totalTokens) || 0 : reserved;
              chargeRealTokens(state, amount, { estimated: !reported });
              const current = state.sessions.find(item => item.id === id); if (current) { current.usage.tokens += amount; const record = current.commandHistory.find(item => item.requestId === request.requestId); if (record) record.usage = { totalTokens: (record.usage?.totalTokens ?? 0) + amount, estimated: record.usage?.estimated === true || !reported }; }
            }); reservation = false;
          } catch (error) { accountingError = error; }
        }
      });
      signal.throwIfAborted();
      // A summary prepared while the conversation was idle is the first batch (committed only on its own base, else
      // discarded) — unless the user gave a focus: that summary was made without it, so it is set aside and the
      // history itself is summarized with the focus.
      const focused = Boolean(request.args.instructions?.trim());
      const prepared = focused ? (typeof handle.discardPreparedCompaction === 'function' ? handle.discardPreparedCompaction() : { discarded: false })
        : typeof handle.commitPreparedCompaction === 'function' ? handle.commitPreparedCompaction() : { committed: false };
      let result = await handle.compact({ generate: true, signal, instructions: request.args.instructions });
      if (prepared.committed) {
        this.store.mutate(state => { const current = state.sessions.find(item => item.id === id); if (current?.context) current.context.idleCompaction = { status: 'committed', at: now(), ...(Number.isFinite(current.context.idleCompaction?.basisAt) ? { basisAt: current.context.idleCompaction.basisAt } : {}), ...(Number.isFinite(prepared.beforeTokens) ? { beforeTokens: prepared.beforeTokens } : {}), ...(Number.isFinite(prepared.afterTokens) ? { afterTokens: prepared.afterTokens } : {}), preparedId: prepared.preparedId ?? prepared.id }; });
        // Nothing newer to summarize: the result is the background summary alone, and the notice says so.
        if (!result.compacted) result = { compacted: true, archivedMessages: prepared.archivedMessages, retainedMessages: prepared.retainedMessages, background: true };
        else result = { ...result, archivedMessages: (result.archivedMessages ?? 0) + (prepared.archivedMessages ?? 0) };
      } else if (prepared.discarded || prepared.code && prepared.code !== 'none') this.store.mutate(state => { const current = state.sessions.find(item => item.id === id); if (current?.context?.idleCompaction?.status === 'prepared') current.context.idleCompaction = { ...current.context.idleCompaction, status: 'discarded', code: prepared.code, at: now() }; });
      if (accountingError) throw accountingError;
      signal.throwIfAborted();
      const snapshot = handle.snapshot();
      return this.store.mutate(state => {
        const current = this.session(id, state).session;
        if (result.compacted) {
          current.context.compactions++; current.context.tokens = snapshot.cache.estimatedInputTokens; current.context.capacity = model.contextWindow;
          // This maintenance writer deliberately has no foreground tool or
          // system catalog. Its estimate must not replace a complete runtime
          // projection or claim that automatic compaction was disabled there.
          delete current.context.usage; current.context.measurementScope = 'maintenance';
          const text = result.background ? said(state, '已使用后台空闲时准备好的摘要整理较早上下文（没有更新的内容需要再整理）；原始记录保留在会话日志中。', 'Compacted the earlier context with the summary prepared in the background while the conversation was idle (nothing newer needed summarizing); the original record stays in the conversation log.')
            : result.partial ? said(state, `已用当前模型分 ${result.batches} 批整理了大部分较早上下文；原始记录保留在会话日志中。可以再执行一次整理剩下的部分。`, `Compacted most of the earlier context with the current model in ${result.batches} batches; the original record stays in the conversation log. Run it once more to compact the rest.`)
            : result.batches ? said(state, `已用当前模型分 ${result.batches} 批整理较早上下文；原始记录保留在会话日志中。`, `Compacted the earlier context with the current model in ${result.batches} batches; the original record stays in the conversation log.`)
            : said(state, '已使用当前模型整理较早上下文；原始记录保留在会话日志中。', 'Compacted the earlier context with the current model; the original record stays in the conversation log.');
          if (!settleProgress(current, request.requestId, text)) this.notice(current, text);
        } else settleProgress(current, request.requestId, said(state, '没有完整的较早轮次需要整理。', 'There were no complete earlier turns to compact.'));
        return this.receipt(current, request, result.compacted ? 'completed' : 'noop', { compacted: result.compacted, ...(result.compacted ? { archivedMessages: result.archivedMessages, retainedMessages: result.retainedMessages } : { reason: '没有完整的较早轮次需要整理。' }) });
      });
    } catch (error) {
      const safe = commandError(error, this.store.state);
      // A host stop leaves the outcome to be checked; a timeout is a plain failure (nothing was committed).
      const interrupted = signal.aborted && signal.reason?.name !== 'TimeoutError';
      this.store.mutate(state => {
        const current = state.sessions.find(item => item.id === id), record = current?.commandHistory?.find(item => item.requestId === request.requestId);
        if (record) Object.assign(record, { status: interrupted ? 'interrupted' : 'failed', code: safe.code, ...(interrupted ? {} : { message: safe.message }), completedAt: now() });
        if (current) settleProgress(current, request.requestId, interrupted ? interruptedCompaction(state) : safe.message);
      });
      throw safe;
    } finally {
      try { await handle?.dispose(); }
      finally {
        if (reservation) this.store.mutate(state => { const amount = releaseRealTokens(state, reservationKey); if (started) chargeRealTokens(state, amount, { estimated: true }); });
        const ownsProjection = current => projectionIdentity && current?.context?.usage && current.runtime?.sessionFile === projectionIdentity.sessionFile && current.runtime?.updatedAt === projectionIdentity.updatedAt && current.activeTurnId === projectionIdentity.activeTurnId;
        if (ownsProjection(this.store.state.sessions.find(item => item.id === id))) this.store.mutate(state => {
          const current = state.sessions.find(item => item.id === id);
          if (ownsProjection(current)) delete current.context.usage;
        });
      }
    }
  }
  export(id) {
    const { session } = this.session(id), clean = redactor(this.store);
    const transcript = clean({ format: 'rna-session-transcript', version: 1, exportedAt: now(), session: { id: session.id, projectId: session.projectId, title: session.title, mode: session.mode, createdAt: session.createdAt }, items: session.items.map(item => ({ id: item.id, turnId: item.turnId, kind: item.kind, text: item.text, createdAt: item.createdAt, ...(item.tool ? { tool: { name: item.tool.name, args: item.tool.args, status: item.tool.status, output: item.tool.output } } : {}), ...(item.attachments ? { attachments: item.attachments.map(value => ({ name: value.name, mimeType: value.mimeType, size: value.size })) } : {}) })), usage: session.usage, commands: (session.commandHistory ?? []).map(({ requestId, command, status, code, createdAt, completedAt, usage }) => ({ requestId, command, status, code, createdAt, completedAt, usage })) });
    const markdown = `# ${transcript.session.title ?? 'Rna Agent'}\n\n` + transcript.items.map(item => `## ${item.kind} · ${item.createdAt ?? ''}\n\n${item.text ?? ''}${item.tool ? `\n\nTool: ${item.tool.name} (${item.tool.status})\n\n${JSON.stringify(item.tool.args ?? {}, null, 2)}\n\n${item.tool.output ?? ''}` : ''}\n`).join('\n');
    const readme = 'Rna Agent 单会话界面记录导出。包含界面消息、可见工具参数/输出与用量回执；不是原始 SDK 日志或完整执行备份。工具输出可能已被界面长度限制截断。不包含供应商设置、凭据、附件文件内容、其它会话或子任务日志。已清除已配置凭据与常见敏感字段；分享前仍请检查正文中的个人信息。\n';
    return { bytes: zip([['session.json', JSON.stringify(transcript, null, 2)], ['conversation.md', markdown], ['README.txt', readme]]), filename: `rna-session-${digest(id).slice(0, 16)}.zip`, contentType: 'application/zip' };
  }
}
