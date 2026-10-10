import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createSession } from '../../packages/sdk/src/session.mjs';
import { generateSummary, generatePlanSummary, lighterReasoning } from '../../packages/sdk/src/compaction-request.mjs';
import { historyEditMode } from '../../packages/sdk/src/cache-survival.mjs';
import { streamCompletion } from '../../packages/sdk/src/providers.mjs';
import { meteredProvider } from './usage-cache-service.mjs';
import { resolveModel } from './configuration.mjs';
import { realBudgetRemaining, reserveRealTokens, releaseRealTokens, chargeRealTokens } from './budget-service.mjs';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';
import { reasoningFor, compactionEffortInput } from './internal-reasoning.mjs';

/**
 * Idle background compaction (user decision 2026-10-04 #3; spec p1 compaction §D). A conversation idle past its model's
 * prompt-cache survival — the next turn would read its whole history uncached anyway — and holding at least half of
 * the model's context window is summarized in the background, keeping its last two turns verbatim:
 *  1. plan under a brief maintenance claim (journal open + `prepareCompaction`, writes nothing);
 *  2. generate the summary with no claim and no lock (`generateSummary`, purpose compaction, trigger idle);
 *  3. leave it in the session's sidecar (`<journal>.idle-summary.json`);
 *  4. commit it at a cold break: now (a ~0.2 s claim) when the conversation is still idle and cold, else the turn's own
 *     handle commits it at its first cold request. A user turn never waits for the summary.
 * Every condition is computed in code; nothing here is a keyword rule. The `session.resume` judgment is recorded in
 * shadow only and never gates (labels: a user turn within 7 days).
 */
export const IDLE_KEEP_USER_TURNS = 2, IDLE_CONTEXT_SHARE = 0.5, RESUME_LABEL_WINDOW_MS = 7 * 86400000;
export const idleSummaryFile = sessionFile => `${sessionFile}.idle-summary.json`;
export const idleCompactionNotice = state => inLanguage(interfaceLanguageOf(state), {
  zh: '这个对话空闲期间，已在后台把较早的上下文整理成摘要，下一轮会更快开始；原始记录和完整的工具结果都还保存在会话日志里。',
  en: 'While this conversation was idle, earlier context was summarized in the background so the next turn starts faster; the original record and full tool results are still in the conversation log.'
});
/** The summary requests of a plan in order: one, or a split turn's history and turn prefix (SDK prepareCompaction). */
const planRequests = plan => Array.isArray(plan.requests) && plan.requests.length ? plan.requests : [{ kind: 'summary', request: plan.request, maxOutputTokens: plan.maxOutputTokens }];
/**
 * The conversation's tokens as the host last measured them with its real handle (the trigger counts this measure): the
 * maintenance handle that plans the compaction has no tool catalogue and the default prompt, so the SDK needs it to
 * compare a projection with the target in the same units (prepareCompaction measuredTokens).
 */
const measuredOf = assessment => { const tokens = Math.round(Number(assessment?.tokens)); return Number.isSafeInteger(tokens) && tokens >= 1 ? tokens : null; };
const time = value => { const at = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(at) ? at : null; };
const idleBucket = ms => ms < 3 * 3600000 ? 'under_3h' : ms < 12 * 3600000 ? '3h_to_12h' : ms < 86400000 ? '12h_to_1d' : ms < 3 * 86400000 ? '1d_to_3d' : ms < 7 * 86400000 ? '3d_to_7d' : 'over_7d';
const countBucket = count => count === 0 ? 'none' : count <= 2 ? '1_to_2' : count <= 9 ? '3_to_9' : '10_or_more';
const realTurn = turn => turn && turn.source !== 'autonomy' && !turn.simulated;
/** Abort reason of `quiesce` (rewind, deletion, a manual compaction): the user is present, so the attempt is held until the next request. */
const QUIESCED = 'idle_compaction_quiesced';
const quiesced = signal => signal?.aborted === true && signal.reason?.code === QUIESCED;
const textOf = item => typeof item?.displayText === 'string' && item.displayText ? item.displayText : String(item?.text ?? '');

/** Everything about a conversation that decides whether (and when) it is due, except the clock. Null when it is not a candidate. */
export function idleCompactionAssessment(state, session, { executor = null, ledger = null, survival = null, gate = null } = {}) {
  if (!session || state.settings?.idleCompaction === false || state.emergency || gate?.held) return null;
  if (session.kind === 'side' || session.archivedAt || session.appRecovery?.required || session.runtime?.engine !== 'rna' || !session.runtime?.sessionFile) return null;
  const project = session.projectId ? state.projects?.find(row => row.id === session.projectId) : null;
  if (session.projectId && (!project || project.archivedAt)) return null;
  if ((state.sessionDeletions ?? []).some(row => row.sessionId === session.id)) return null;
  if (session.status === 'running' || session.activeTurnId || executor?.running?.has(session.id) || executor?.maintenance?.has(session.id) || executor?.memorySync?.drainingSessions?.has(session.id)) return null;
  // Cheap first: a conversation the last measurement puts under half of its window is not a candidate.
  const measured = Number(session.context?.usage?.estimatedInputTokens ?? session.context?.tokens) || 0, measuredCapacity = Number(session.context?.usage?.capacity) || Number(session.context?.capacity) || 0;
  if (measuredCapacity && measured < IDLE_CONTEXT_SHARE * measuredCapacity) return null;
  if (!existsSync(session.runtime.sessionFile)) return null;
  let model; try { model = resolveModel(state.configuration, session.modelSelection); } catch { return null; }
  // An append-only Anthropic target ('rebase') still compacts: the commit is journaled with its thinking rebase. Only a
  // path declared append-only without a rebase ('none') is never compacted at idle.
  if (model.execution !== 'rna' || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0 || historyEditMode(model) === 'none') return null;
  // A key the provider grants for interactive chat only (Kimi Coding plan) never runs unattended work: such
  // conversations keep the in-turn compaction, which happens while the user is present.
  if (model.usagePolicy === 'interactive_only') return null;
  const tokens = Number(session.context?.usage?.estimatedInputTokens ?? session.context?.tokens) || 0, capacity = Number(session.context?.usage?.capacity) || model.contextWindow;
  if (tokens < IDLE_CONTEXT_SHARE * capacity) return null;
  const last = ledger?.lastSessionRequest?.(session.id)?.at ?? time(session.turns?.findLast(turn => turn.completedAt)?.completedAt);
  if (!Number.isFinite(last)) return null;
  const coldAfterMs = survival?.estimate?.(model)?.coldAfterMs ?? null;
  if (!Number.isSafeInteger(coldAfterMs) || coldAfterMs <= 0) return null;
  const record = session.context?.idleCompaction;
  // One attempt per idle period: a plan that found nothing, a discarded or failed summary waits for the next turn.
  if (record?.basisAt === last && ['skipped', 'discarded', 'failed', 'committed'].includes(record.status)) return null;
  // Host keep-alive (cache-keepalive.mjs) keeps an idle Claude conversation's cache warm without a conversation request:
  // a compaction would throw that warmth away, so the conversation is due only once the cache is cold — after the
  // keep-alive's own horizon while it holds the conversation, and a TTL after its last ping once it let go.
  const ping = ledger?.lastKeepAlive?.(session.id), warmUntil = ledger?.keepAlive?.warmUntil?.(session.id);
  const dueAt = Math.max(last + coldAfterMs, Number.isFinite(ping) ? ping + coldAfterMs : -Infinity, Number.isFinite(warmUntil) ? warmUntil : -Infinity);
  // A 'preparing' record without a generation in this process is stale (a restart): the plan loop starts it again.
  return { model, project, tokens, capacity, lastAt: last, coldAfterMs, dueAt, prepared: record?.status === 'prepared' };
}

export class IdleCompactionService {
  constructor(store, { executor = null, ledger = store.usageLedger ?? null, survival = ledger?.survival ?? null, decisions = null, gate = null, factory = createSession, provider = streamCompletion, now = Date.now, keepUserTurns = IDLE_KEEP_USER_TURNS, redactValues = () => [] } = {}) {
    Object.assign(this, { store, executor, ledger, survival, decisions, gate, factory, provider, now, keepUserTurns, redactValues });
    /** session id → { controller, promise } of a generation or commit in progress (one generation at a time). */
    this.inFlight = new Map(); this.closed = false; this.timer = null; this.scheduled = null;
  }
  start() {
    if (this.unsubscribe || this.closed) return this;
    const store = this.store.subscribe(() => this.replan(), { display: false }), ledger = this.ledger?.subscribe?.(() => this.replan());
    this.unsubscribe = () => { store?.(); ledger?.(); };
    this.replan();
    return this;
  }
  replan() { if (this.closed || this.scheduled) return; this.scheduled = setImmediate(() => { this.scheduled = null; try { this.plan(); } catch { /* planning never throws into the store */ } }); }
  /** One timer for the earliest due conversation; due ones start (one generation at a time), others wait. */
  plan() {
    clearTimeout(this.timer); this.timer = null;
    if (this.closed) return;
    const state = this.store.state, now = this.now(), options = { executor: this.executor, ledger: this.ledger, survival: this.survival, gate: this.gate };
    this.labelResumes(state, now);
    // A generation for a conversation that stopped qualifying (emergency, maintenance gate, archive, deletion) is aborted; a running turn is not a reason.
    for (const [id, entry] of this.inFlight) {
      const session = state.sessions.find(row => row.id === id);
      if (entry.kind === 'generate' && (!session || state.emergency || this.gate?.held || session.archivedAt || state.settings?.idleCompaction === false || (state.sessionDeletions ?? []).some(row => row.sessionId === id))) entry.controller.abort(new Error('Idle compaction no longer applies.'));
    }
    let earliest = Infinity, next = null;
    for (const session of state.sessions ?? []) {
      if (this.inFlight.has(session.id)) continue;
      const assessment = idleCompactionAssessment(state, session, options);
      if (!assessment) continue;
      if (assessment.dueAt > now) { earliest = Math.min(earliest, assessment.dueAt); continue; }
      if (!next || assessment.dueAt < next.assessment.dueAt) next = { session, assessment };
    }
    const generating = [...this.inFlight.values()].some(entry => entry.kind === 'generate');
    if (next && (next.assessment.prepared || !generating)) this.start1(next.session.id, next.assessment);
    if (Number.isFinite(earliest)) { this.timer = setTimeout(() => this.replan(), Math.min(2147483647, Math.max(0, earliest - now) + 50)); this.timer.unref?.(); }
  }
  start1(sessionId, assessment) {
    const entry = { kind: assessment.prepared ? 'commit' : 'generate', controller: new AbortController(), promise: null };
    this.inFlight.set(sessionId, entry);
    entry.promise = (assessment.prepared ? this.commit(sessionId, assessment, entry.controller.signal) : this.generate(sessionId, assessment, entry.controller.signal))
      .catch(error => this.settleUnexpected(sessionId, entry, assessment, error)).finally(() => { if (this.inFlight.get(sessionId) === entry) this.inFlight.delete(sessionId); this.replan(); });
    return entry.promise;
  }
  /**
   * Backstop: an attempt that threw past its own handling (a store or file write after a paid summary) ends this idle
   * period, so the replan in start1's finally cannot start another paid generation for the same basis.
   */
  settleUnexpected(sessionId, entry, assessment, error) {
    if (entry.controller.signal.aborted) return;
    try {
      const preparedId = this.session(sessionId)?.context?.idleCompaction?.preparedId;
      this.record(sessionId, { status: 'failed', code: String(error?.code ?? (entry.kind === 'commit' ? 'commit_error' : 'summary_error')).slice(0, 80), basisAt: assessment.lastAt, ...(preparedId ? { preparedId } : {}) });
    } catch { /* the store cannot record it either; a generation records 'preparing' before it pays, which fails the same way */ }
  }
  session(id) { return this.store.state.sessions.find(row => row.id === id); }
  record(sessionId, value) {
    this.store.mutate(state => { const session = state.sessions.find(row => row.id === sessionId); if (!session) return; session.context ??= { tokens: 0, capacity: 0, compactions: 0 }; const resume = session.context.idleCompaction?.resume; session.context.idleCompaction = { ...value, at: new Date(this.now()).toISOString(), ...(resume ? { resume } : {}) }; });
  }
  stateDir(session) { return resolve(`${this.store.file}.rna`, session.id); }
  async open(session, model) {
    return this.factory({ sessionId: session.id, projectId: session.projectId, cwd: this.stateDir(session), stateDir: this.stateDir(session), sessionFile: session.runtime.sessionFile, model, tools: [], autoCompaction: false });
  }
  apiKey(model) { const provider = this.store.state.configuration.providers.find(row => row.id === model.providerId); return provider ? this.store.configurationService?.secret?.(provider.id, provider) : undefined; }
  async generate(sessionId, assessment, signal) {
    const { model, lastAt: basisAt } = assessment;
    let session = this.session(sessionId), plan = null, claimed = null;
    // 1. Plan: a brief claim on the idle conversation (a turn arriving now aborts it and runs at once).
    try {
      await this.executor.runMaintenance(sessionId, async claim => {
        claimed = claim;
        const handle = await this.open(session, model);
        try { claim.throwIfAborted(); signal.throwIfAborted(); plan = handle.prepareCompaction({ keepUserTurns: this.keepUserTurns, targetTokens: Math.max(1, Math.floor(IDLE_CONTEXT_SHARE * (assessment.capacity || model.contextWindow))), measuredTokens: measuredOf(assessment) }); } finally { await handle.dispose(); }
      });
    } catch (error) {
      // Busy (a turn or another claim) or interrupted: the next plan pass decides again — except a quiesce (rewind,
      // manual compaction), which holds this idle period. Anything else is recorded for this idle period, so a journal
      // that cannot be opened is not reopened on every store change.
      if (quiesced(signal)) this.record(sessionId, { status: 'skipped', code: 'interrupted', basisAt });
      else if (!signal.aborted && !claimed?.aborted && error?.code !== 'session_busy') this.record(sessionId, { status: 'failed', code: String(error?.code ?? 'plan_error').slice(0, 80), basisAt });
      return;
    }
    if (!plan) { this.record(sessionId, { status: 'skipped', code: 'nothing_to_compact', basisAt }); return; }
    // Every request of the plan (a split turn adds the turn prefix's own) must fit what is left of the real-token budget.
    const affordable = () => realBudgetRemaining(this.store.state) > planRequests(plan).reduce((sum, entry) => sum + entry.request.estimatedInputTokens + entry.maxOutputTokens, 0);
    if (!affordable()) { this.record(sessionId, { status: 'skipped', code: 'budget', basisAt }); return; }
    // 2. session.resume, shadow only: recorded with its ledger id, labeled later; never gates (the user's rule applies).
    void this.judgeResume(sessionId, assessment, signal).catch(() => null);
    // 3. Generate with no claim held: the conversation stays free for a turn the whole time. Internal work (user
    //    decision 2; spec p1 effort, purpose compaction): the internal plan's effort (summaryEffort) — the provider
    //    default where it is usable and no deeper than the chat's choice, else the chat's own effort while the JEV route
    //    only records; a summary truncated at the output limit is asked once more one effort step lower before it fails.
    //    A split turn (the retained turns alone keep the conversation over the idle trigger) is two requests, the history's
    //    and the turn prefix's, joined into one checkpoint; a retry after a failure re-sends only the request that failed.
    let requestId = randomUUID(), reasoning = await this.summaryEffort(session, model, plan, signal), result = null;
    const paid = new Map();
    this.record(sessionId, { status: 'preparing', requestId, basisAt, beforeTokens: plan.beforeTokens });
    for (let attempt = 0; !result; attempt++) {
      try { result = await generatePlanSummary({ plan, done: paid, run: (entry, index) => this.summarize(sessionId, session, { ...model, reasoning }, entry, index === 0 ? requestId : randomUUID(), signal) }); requestId = result.requestId ?? requestId; }
      catch (error) {
        const lighter = attempt === 0 && error?.truncated === true && !signal.aborted ? lighterReasoning(model, reasoning) : null;
        if (lighter && affordable()) { reasoning = lighter; requestId = randomUUID(); this.record(sessionId, { status: 'preparing', requestId, basisAt, beforeTokens: plan.beforeTokens, retry: 'length' }); continue; }
        if (signal.aborted) this.record(sessionId, { status: 'skipped', code: 'interrupted', ...(quiesced(signal) ? { basisAt } : {}) });
        else this.record(sessionId, { status: 'failed', code: String(error?.code ?? 'summary_error').slice(0, 80), basisAt, ...(error?.truncated === true ? { truncated: true } : {}) });
        return;
      }
    }
    // 4. Hand-over: the sidecar next to the journal (inside the session's own folder; deletion purges it with the folder).
    //    The summary is paid for: a failure to hand it over ends this idle period instead of paying for it again.
    let prepared, file, temp;
    try {
      session = this.session(sessionId);
      if (!session?.runtime?.sessionFile) return;
      prepared = { id: `idle-${requestId}`, sessionId, trigger: 'idle', previousCompactionId: plan.previousCompactionId, throughMessageId: plan.throughMessageId, sourceDigest: plan.sourceDigest, summary: result.summary, archivedMessages: plan.archivedMessages, retainedMessages: plan.retainedMessages, requestId, usage: result.usage, usageReported: result.usageReported, model: plan.model, startedAt: result.startedAt, completedAt: result.completedAt, beforeTokens: plan.beforeTokens };
      file = idleSummaryFile(session.runtime.sessionFile); temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(prepared), { mode: 0o600 }); renameSync(temp, file);
    } catch (error) {
      try { if (temp && existsSync(temp)) unlinkSync(temp); } catch { /* it cannot be removed either; the next write replaces it */ }
      this.record(sessionId, { status: 'failed', code: String(error?.code ?? 'sidecar_write').slice(0, 80), basisAt });
      return;
    }
    this.record(sessionId, { status: 'prepared', requestId, preparedId: prepared.id, basisAt, beforeTokens: plan.beforeTokens });
    // 5. Commit at a cold break.
    const fresh = idleCompactionAssessment(this.store.state, this.session(sessionId), { executor: null, ledger: this.ledger, survival: this.survival, gate: this.gate });
    const live = this.executor?.running?.get(sessionId);
    if (live?.handle?.offerCompaction) { try { if (live.handle.offerCompaction(prepared)) unlinkSync(file); } catch { /* the sidecar waits for the next open */ } return; }
    if (live || !fresh) return; // a turn is starting (it consumes the sidecar at open), or the conversation no longer qualifies
    if (fresh.dueAt <= this.now()) await this.commit(sessionId, fresh, signal);
  }
  /** One summary request with its real-token reservation; charges what it used (reported, else its estimate once started). */
  async summarize(sessionId, session, model, plan, requestId, signal) {
    const reservationKey = `idle-compaction:${sessionId}:${requestId}`, receipt = {};
    let reserved = false;
    try {
      this.store.mutate(state => reserveRealTokens(state, reservationKey, Math.ceil(plan.request.estimatedInputTokens + plan.maxOutputTokens + 1536))); reserved = true;
      const provider = meteredProvider(this.provider, { ledger: this.ledger, purpose: 'compaction', projectId: session.projectId, sessionId });
      return await generateSummary({ provider, model, apiKey: this.apiKey(model), request: plan.request, maxOutputTokens: plan.maxOutputTokens, signal, redactValues: this.redactValues(), ledger: { trigger: 'idle' }, requestId, receipt, estimatedInputTokens: plan.request.estimatedInputTokens });
    } finally {
      if (reserved) this.store.mutate(state => {
        // PDL-3: an unreported summary is charged its estimated input plus what streamed, never more than the reservation.
        const held = releaseRealTokens(state, reservationKey), reported = receipt.usageReported === true, amount = reported ? Number(receipt.usage?.totalTokens) || 0 : receipt.startedAt ? Math.min(held, Math.ceil(plan.request.estimatedInputTokens) + Math.ceil((receipt.streamedBytes ?? 0) / 3)) : 0;
        if (amount) chargeRealTokens(state, amount, { estimated: !reported });
        const current = state.sessions.find(row => row.id === sessionId); if (current?.usage && amount) current.usage.tokens = (current.usage.tokens ?? 0) + amount;
      });
    }
  }
  /** The prepared summary goes in now through a brief claim, when the conversation is idle and its cache is cold. */
  async commit(sessionId, assessment, signal) {
    const session = this.session(sessionId);
    if (!session || this.now() < assessment.dueAt) return;
    let outcome = null, snapshot = null, claimed = null;
    try {
      await this.executor.runMaintenance(sessionId, async claim => {
        claimed = claim;
        const handle = await this.open(session, assessment.model);
        try { claim.throwIfAborted(); signal?.throwIfAborted(); outcome = handle.commitPreparedCompaction(); snapshot = handle.snapshot(); } finally { await handle.dispose(); }
      });
    } catch (error) {
      // A turn took the conversation: its own handle commits the summary at its cold request. Any other failure stops
      // the retries for this idle period; the summary waits in the sidecar or journal for the next turn's cold request.
      if (!signal?.aborted && !claimed?.aborted && error?.code !== 'session_busy') this.record(sessionId, { status: 'failed', code: String(error?.code ?? 'commit_error').slice(0, 80), basisAt: assessment.lastAt, ...(this.session(sessionId)?.context?.idleCompaction?.preparedId ? { preparedId: this.session(sessionId).context.idleCompaction.preparedId } : {}) });
      return;
    }
    if (!outcome) return;
    if (!outcome.committed) {
      // `none`: a turn's handle already committed or discarded it (its events updated the record).
      if (this.session(sessionId)?.context?.idleCompaction?.status === 'prepared') this.record(sessionId, { status: 'discarded', code: outcome.code, basisAt: assessment.lastAt });
      return;
    }
    this.applyCommitted(sessionId, outcome, { estimatedInputTokens: snapshot?.cache?.estimatedInputTokens, basisAt: assessment.lastAt });
  }
  /** Store side of a committed idle summary (also called by the runtime for a commit inside a turn). */
  applyCommitted(sessionId, result, { estimatedInputTokens, basisAt, notice = true } = {}) {
    // The committed summary replaces the history a keep-alive entry would re-send.
    try { this.ledger?.keepAlive?.forget?.(sessionId); } catch { /* never fails the commit */ }
    this.store.mutate(state => {
      const session = state.sessions.find(row => row.id === sessionId); if (!session) return;
      session.context ??= { tokens: 0, capacity: 0, compactions: 0 };
      if (result?.id && session.context.lastCompactionId === result.id) return;
      session.context.compactions = (session.context.compactions ?? 0) + 1; if (result?.id) session.context.lastCompactionId = result.id;
      if (Number.isFinite(estimatedInputTokens)) session.context.tokens = estimatedInputTokens;
      // A maintenance writer has no foreground tool catalog: its estimate must not replace a full runtime projection.
      delete session.context.usage; session.context.measurementScope = 'maintenance';
      session.context.idleCompaction = { status: 'committed', at: new Date(this.now()).toISOString(), ...(Number.isFinite(basisAt) ? { basisAt } : {}), ...(Number.isFinite(result?.beforeTokens) ? { beforeTokens: result.beforeTokens } : {}), ...(Number.isFinite(result?.afterTokens) ? { afterTokens: result.afterTokens } : {}), ...(result?.preparedId ? { preparedId: result.preparedId } : {}), ...(session.context.idleCompaction?.resume ? { resume: session.context.idleCompaction.resume } : {}) };
      if (notice) session.items.push({ id: randomUUID(), kind: 'notice', text: idleCompactionNotice(state), createdAt: new Date(this.now()).toISOString(), simulated: false, source: 'idle-compaction' });
    });
  }
  /** The idle summary's reasoning effort (internal-reasoning.mjs reasoningFor, purpose compaction, on the SDK's
   * internalReasoningPlan): the provider default where it is usable, never above the conversation's level, and today's
   * effort while the JEV route only records (compaction is shadow-only). Never throws: a failure keeps the model's. */
  async summaryEffort(session, model, plan, signal) {
    try {
      const project = (this.store.state.projects ?? []).find(row => row.id === session.projectId) ?? null, lastUser = session.items?.findLast(item => item.kind === 'user');
      const routed = await reasoningFor({ decisions: this.decisions, configuration: this.store.state.configuration, project, model, purpose: 'compaction', call: compactionEffortInput({ historyTokens: plan.request.estimatedInputTokens, manual: false, request: textOf(lastUser).slice(0, 600) }), signal });
      return typeof routed?.reasoning === 'string' ? routed.reasoning : model.reasoning;
    } catch { return model.reasoning; }
  }
  /** session.resume in shadow: the idle conversation's last exchange and activity, as buckets computed here. */
  async judgeResume(sessionId, assessment, signal) {
    if (typeof this.decisions?.sessionResume !== 'function') return null;
    const state = this.store.state, session = this.session(sessionId), project = assessment.project, now = this.now();
    const week = now - RESUME_LABEL_WINDOW_MS, turnsSince = row => (row.turns ?? []).filter(turn => realTurn(turn) && (time(turn.createdAt) ?? 0) >= week).length;
    const siblings = (state.sessions ?? []).filter(row => row.projectId === session.projectId && row.kind !== 'side' && !row.archivedAt);
    const latest = siblings.reduce((best, row) => (time(row.updatedAt) ?? 0) > (time(best?.updatedAt) ?? 0) ? row : best, null);
    const lastUser = session.items?.findLast(item => item.kind === 'user'), lastReply = session.items?.findLast(item => item.kind === 'assistant' && !item.streaming);
    const plan = (project?.mind?.agenda ?? []).filter(row => row.kind === 'todo' && row.status === 'open' && !row.stale && row.source?.sessionId === sessionId).slice(0, 4).map(row => row.text);
    const verdict = await this.decisions.sessionResume(project, { state: { sessionId, idle: idleBucket(now - assessment.lastAt), conversationTurns: countBucket(turnsSince(session)), latest: latest?.id === sessionId, projectTurns: countBucket(siblings.reduce((sum, row) => sum + turnsSince(row), 0)), lastUserMessage: textOf(lastUser).slice(0, 600), lastReply: textOf(lastReply).slice(-400), plan }, signal });
    if (!verdict?.ledgerId) return null;
    this.store.mutate(state => { const current = state.sessions.find(row => row.id === sessionId); if (current?.context?.idleCompaction) current.context.idleCompaction.resume = { ledgerId: verdict.ledgerId, likely: verdict.likely === true, at: new Date(now).toISOString() }; });
    return verdict;
  }
  /** Automatic labels for session.resume: a user turn within 7 days of the judgment (returned), else not_returned. */
  labelResumes(state, now) {
    if (typeof this.decisions?.labelDecision !== 'function') return;
    for (const session of state.sessions ?? []) {
      const resume = session.context?.idleCompaction?.resume, at = time(resume?.at);
      if (!resume?.ledgerId || resume.labeled || !Number.isFinite(at)) continue;
      const returned = (session.turns ?? []).some(turn => realTurn(turn) && (time(turn.createdAt) ?? 0) > at && (time(turn.createdAt) ?? 0) <= at + RESUME_LABEL_WINDOW_MS);
      if (!returned && now < at + RESUME_LABEL_WINDOW_MS) continue;
      try { this.decisions.labelDecision(resume.ledgerId, returned ? 'returned' : 'not_returned'); } catch { /* the ledger row may have aged out */ }
      this.store.mutate(next => { const row = next.sessions.find(item => item.id === session.id)?.context?.idleCompaction?.resume; if (row) row.labeled = returned ? 'returned' : 'not_returned'; });
    }
  }
  /** Rewind, deletion, a manual compaction: stop this conversation's generation or commit and wait for it. */
  async quiesce(sessionId, { hold = true } = {}) {
    const entry = this.inFlight.get(sessionId);
    if (!entry) return;
    // `hold`: the user acted on this conversation, so the attempt waits for its next request. A shutdown does not:
    // the next start plans the same idle period again.
    entry.controller.abort(Object.assign(new Error('Idle compaction stopped for this conversation.'), hold ? { code: QUIESCED } : {}));
    await entry.promise?.catch(() => {});
  }
  async close() {
    this.closed = true; clearTimeout(this.timer); clearImmediate(this.scheduled); this.scheduled = null; this.unsubscribe?.();
    await Promise.allSettled([...this.inFlight.keys()].map(id => this.quiesce(id, { hold: false })));
  }
}

/** Read a sidecar a host left for a session (tests and the manual compaction path); null when absent or unreadable. */
export function readIdleSummary(sessionFile) {
  const file = idleSummaryFile(sessionFile);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
