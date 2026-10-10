// Stage B of the internal-effort rollout (spec p1 effort §6.3; user decision 2026-10-04: GLM routing ships only after a
// paid replay of about 30 real decisions, ≈2.5M GLM tokens, shows failure rates and behaviour do not worsen). Runs inside
// the live daemon, so it uses the app's configured model credentials without anyone reading a secrets file; it never
// changes project state: no coordinator, no project, no decision ledger row. Its spend is real and shows as such: every
// main-model call leaves a usage-ledger row (purpose `evaluation`, detail `effort-replay`, no project) and is reserved
// against, then charged to, the daily real-token cap; the JEV message check goes through the raw probe (its jev row).
//
// Approval (review RPL-7/ACC-6): `approved: true` starts one run within what is left of the approved total — the user's
// 2.5M, plus any further amount approved explicitly (`approveMore`). Every approval and each run's spend (persisted after
// every call, so a crash keeps it) are recorded in `replay/spend.json`; a start whose estimate does not fit is refused.
//
// Decisions: captured while internalReasoning.capture was on (internal-reasoning.mjs), each with its exact request
// data, the JEV-chosen effort (shadow verdict) and what the live decision at today's effort came to. Every case is
// replayed at its JEV-chosen effort; `baseline` of the lighter ones (spread over the depth classes) also at today's
// effort, giving paired lighter-vs-today comparisons on the same states. One attempt each, no repair: a first-attempt
// invalid_decision (unknown evidence above all), a message-contract violation, a truncation, the action chosen.
// Rewrites (narrator): the newest captured rewrites of flagged scheduled deliveries whose JEV effort is lighter than
// today's, each at both efforts; the revision is checked again as the live recheck does (message.check pass rate).
// Background work is not replayed here: it runs tools, so its replay needs an isolated worktree (left to a later stage);
// until then effort.work stays recorded only whatever the routing setting (internal-reasoning.mjs SHADOW_ONLY_PURPOSES).
//
// Run it with `./rna effort replay --approved` (cli-effort.mjs), which polls and writes the research report.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { decideInitiative, decisionInputEstimate } from '../../../packages/sdk/src/initiative.mjs';
import { streamCompletion } from '../../../packages/sdk/src/providers.mjs';
import { buildDecisionState } from '../../../packages/sdk/src/decision-state.mjs';
import { minimizeDecisionState, deriveDecisionPolicy } from '../../../packages/sdk/src/decision-kernel.mjs';
import { messageCheckTemplate, combineMessageCheck } from '../../../packages/sdk/src/decision-templates.mjs';
import { proactiveMessageViolations } from '../../../packages/sdk/src/proactive-message.mjs';
import { resolveModel } from '../configuration.mjs';
import { recentDeliveries, sentDigest, projectKindOf, SEMANTIC_REPAIR } from '../proactive-delivery.mjs';
import { revisionPrompt, WRITING_CONTRACT } from '../proactive-narrator.mjs';
import { EffortCapture, captureRoot, sessionsLive, ROUTABLE_PURPOSES } from '../internal-reasoning.mjs';
import { meteredProvider } from '../usage-cache-service.mjs';
import { schedulePromptVersionOfStore } from '../schedule-prompt.mjs';
import { realBudgetRemaining, reserveRealTokens, releaseRealTokens, chargeRealTokens } from '../budget-service.mjs';

/** The user-approved amount (plan §4, 2026-10-04): no run has a larger budget, and every run together spends no more
 * than it plus what was approved explicitly afterwards. */
export const REPLAY_BUDGET_TOKENS = 2500000;
export const REPLAY_DEFAULTS = Object.freeze({ cases: 30, baseline: 10, narrator: 10, budgetTokens: REPLAY_BUDGET_TOKENS, concurrency: 1 });
/** What a passing gate lets `./rna effort routing route` send (decisions and rewrites); nothing else is replayed. */
export const REPLAY_COVERS = ROUTABLE_PURPOSES;
// An output allowance nobody reported (no model resolved, no captured cap): the largest a preset declares.
const UNKNOWN_OUTPUT_CAP = 131072;
const DEPTHS = ['light', 'standard', 'deep'];
const fail = (message, status = 400, code = 'invalid_replay') => { throw Object.assign(new Error(message), { status, code }); };
const at = value => { const time = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(time) ? time : null; };
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? ''));
const round = (value, digits = 3) => Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
const mean = values => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
const wire = plan => Object.fromEntries(Object.entries(plan.questions).map(([id, question]) => [id, { ...question, type: question.type === 'boolean' ? 'noul' : question.type }]));
const answersOf = (raw, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, question.type === 'noul' ? { type: 'boolean', probability: raw?.[id]?.noul } : { type: 'choice', choice: raw?.[id]?.choice, probabilities: raw?.[id]?.probabilities }]));
const NARRATOR_SYSTEM = `You are the project agent revising your own message to the user. ${WRITING_CONTRACT}`;

/** A replayable captured decision: request data, a JEV verdict with an effort, a route plan, an outcome at today's effort. */
export function replayable(row) {
  return row?.kind === 'call' && row.purpose === 'decision' && row.request?.project && Array.isArray(row.request.events) && row.plan?.mode === 'route' && typeof row.plan.fallback === 'string'
    && typeof row.verdict?.effort === 'string' && Array.isArray(row.plan.allowed) && row.plan.allowed.includes(row.verdict.effort) && row.outcome && typeof row.outcome.status === 'string' && row.outcome.status !== 'stale';
}
/** A captured call's live outcome is a baseline for today's effort only when today's effort was what it sent: not a call
 * a route trial (routing route, an RNA_JEV_MODES trial) sent at the JEV effort (review RPL-5). */
export const cleanBaseline = row => typeof row?.sent === 'string' && row.sent === row.plan?.fallback && row.verdict?.applied !== true;
const lighter = row => row.verdict.effort !== row.plan.fallback;
/**
 * Newest first, lighter-than-today first (those are what routing would change), then the rest as baseline material.
 * Today's effort is replayed as well on `baseline` lighter cases, spread over the depth classes (each class the gate may
 * lower needs pairs of its own), the class with the newest case first, and within a class clean live baselines first.
 */
export function selectCases(rows, { cases = REPLAY_DEFAULTS.cases, baseline = REPLAY_DEFAULTS.baseline } = {}) {
  const usable = rows.filter(replayable).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const chosen = [...usable.filter(lighter), ...usable.filter(row => !lighter(row))].slice(0, Math.max(0, cases));
  const classes = new Map();
  for (const row of chosen.filter(lighter).sort((a, b) => Number(cleanBaseline(b)) - Number(cleanBaseline(a)))) { const key = row.verdict.depth ?? 'unknown'; if (!classes.has(key)) classes.set(key, []); classes.get(key).push(row); }
  const queues = [...classes.values()].sort((a, b) => String(b.reduce((m, r) => r.at > m ? r.at : m, '')).localeCompare(String(a.reduce((m, r) => r.at > m ? r.at : m, ''))));
  const paired = new Set();
  for (let round = 0; paired.size < baseline && queues.some(queue => queue.length > round); round++) for (const queue of queues) if (paired.size < baseline && queue[round]) paired.add(queue[round].id);
  return chosen.map(row => ({ row, conditions: !lighter(row) ? ['today'] : paired.has(row.id) ? ['jev', 'today'] : ['jev'] }));
}
/** The output allowance decideInitiative gives one call on `model` (its cap, bounded by the captured decisionMaxTokens);
 * without a resolved model, the captured model's cap. */
export function decisionAllowance(row, model = null) {
  const cap = positive(model?.maxOutputTokens) ?? positive(row?.outputCap), policy = positive(row?.request?.policy?.decisionMaxTokens);
  return cap ? Math.min(cap, policy ?? cap) : policy ?? UNKNOWN_OUTPUT_CAP;
}
/** The input of one replayed decision as decideInitiative estimates it: its system prompt and request text. */
function decisionInput(row) { try { return decisionInputEstimate(row.request); } catch { return Math.ceil(bytes(row.request) / 3) + 6000; } }
/** Conservative tokens of one replayed call: the recorded live decision's total (it ran at today's effort) with 10%
 * headroom, else its input with 20% headroom plus the whole output allowance. */
export function callEstimate(row, model = null) {
  const recorded = Number(row.outcome?.usage?.totalTokens);
  if (Number.isFinite(recorded) && recorded > 0) return Math.ceil(recorded * 11 / 10);
  return Math.ceil(decisionInput(row) * 1.2) + decisionAllowance(row, model);
}
export function replayEstimate(selection, modelOf = () => null) { return selection.reduce((sum, item) => sum + item.conditions.length * callEstimate(item.row, modelOf(item.row)), 0); }
/** The most one call can cost on `model`: its input (system prompt and request, 20% headroom) plus the whole output
 * allowance it is sent with, uncapped (review EFF-6/RPL-6). A call starts only while this still fits. */
export function callCeiling(row, model = null) { return Math.max(callEstimate(row, model), Math.ceil(decisionInput(row) * 1.2) + decisionAllowance(row, model)); }

/** A replayable captured rewrite: the flagged message and its codes, a JEV verdict with an effort, the live outcome. */
export function narratorReplayable(row) {
  return row?.kind === 'call' && row.purpose === 'narrator' && typeof row.request?.text === 'string' && Boolean(row.request.text.trim()) && Array.isArray(row.request.violations) && row.request.violations.length > 0
    && row.plan?.mode === 'route' && typeof row.plan.fallback === 'string' && typeof row.verdict?.effort === 'string' && Array.isArray(row.plan.allowed) && row.plan.allowed.includes(row.verdict.effort) && ['revised', 'kept'].includes(row.outcome?.status);
}
/** The newest rewrites whose JEV effort is lighter than today's (only those would change), each at both efforts. */
export function selectNarrator(rows, { narrator = REPLAY_DEFAULTS.narrator } = {}) {
  return rows.filter(narratorReplayable).filter(lighter).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, Math.max(0, narrator)).map(row => ({ row, conditions: ['jev', 'today'] }));
}
const narratorPrompt = request => revisionPrompt({ text: request.text, violations: request.violations, deliverable: request.deliverable ?? null, lessons: Array.isArray(request.lessons) ? request.lessons : [] });
const narratorInput = row => Math.ceil((bytes(NARRATOR_SYSTEM) + bytes(narratorPrompt(row.request))) / 3);
/** A rewrite is sent with the model's whole output allowance: the resolved model's, else the captured one's. */
const narratorCap = (row, model = null) => positive(model?.maxOutputTokens) ?? positive(row.outputCap) ?? UNKNOWN_OUTPUT_CAP;
/** One rewrite: the live one's recorded total with 10% headroom, else its input plus a quarter of the allowance. */
export function narratorEstimate(row, model = null) {
  const recorded = Number(row.outcome?.tokens);
  if (Number.isFinite(recorded) && recorded > 0) return Math.ceil(recorded * 11 / 10);
  return Math.ceil(narratorInput(row) * 1.2) + Math.ceil(narratorCap(row, model) / 4);
}
export function narratorCeiling(row, model = null) { return Math.max(narratorEstimate(row, model), Math.ceil(narratorInput(row) * 1.2) + narratorCap(row, model)); }

/** Deliveries and conversation items as they stood when the call was captured (the near-repeat check reads them). */
function asOf(project, sessions, time) {
  const before = value => (at(value) ?? Infinity) < time;
  return { project: { ...project, inbox: (project?.inbox ?? []).filter(row => before(row.createdAt)) }, sessions: sessions.map(session => ({ ...session, items: (session.items ?? []).filter(item => before(item.createdAt)) })) };
}
const emptySpend = () => ({ version: 1, approvals: [], jobs: {} });

export class EffortReplay {
  /**
   * `decisions`: the live DecisionService (raw JEV probe, secrets for redaction); `provider`: the model stream, metered
   * into `ledger` (the store's usage ledger) as purpose evaluation; `held()`: whether application maintenance holds new
   * work (no further call starts then; review RPL-9).
   */
  constructor(store, { decisions = null, provider = streamCompletion, now = Date.now, ledger = store?.usageLedger ?? null, held = () => false } = {}) {
    Object.assign(this, { store, decisions, provider, now, ledger, held: typeof held === 'function' ? held : () => false, job: null, controller: null, promise: null, inFlight: 0, sequence: 0 });
    this.capture = new EffortCapture({ stateFile: store.file, now });
  }
  get running() { return Boolean(this.promise); }
  reportDir() { return join(captureRoot(this.store.file), 'replay'); }
  spendFile() { return join(this.reportDir(), 'spend.json'); }
  rows({ projectId } = {}) { return this.capture.calls('decision', projectId ? { projectId } : {}); }
  narratorRows({ projectId } = {}) { return this.capture.calls('narrator', projectId ? { projectId } : {}); }
  /** The dry run: what would be replayed, at which efforts, the token estimate, what is left of the approval and of
   * today's real-token cap; no model call. */
  plan(input = {}) {
    const options = this.options(input), rows = this.rows(options), selection = selectCases(rows, options), narratorRows = this.narratorRows(options), rewrites = selectNarrator(narratorRows, options);
    // Each project's current model, resolved once: a row's estimate uses it when the row ran on it (else its captured cap).
    const models = new Map(), modelOf = row => { if (!models.has(row.projectId)) models.set(row.projectId, this.currentModel(row.projectId)); const model = models.get(row.projectId); return model && model.providerId === row.providerId && model.modelId === row.modelId ? model : null; };
    const narratorTotal = rewrites.reduce((sum, item) => sum + item.conditions.length * narratorEstimate(item.row, modelOf(item.row)), 0), estimate = replayEstimate(selection, modelOf) + narratorTotal;
    const calls = selection.reduce((sum, item) => sum + item.conditions.length, 0) + rewrites.reduce((sum, item) => sum + item.conditions.length, 0);
    const approval = this.approval(), daily = realBudgetRemaining(this.store.state, { now: this.now() });
    return { options, covers: [...REPLAY_COVERS], captured: rows.length, replayable: rows.filter(replayable).length, selected: selection.length, calls, estimate, withinBudget: estimate <= Math.min(options.budgetTokens, approval.remaining), approval, dailyRemaining: Number.isFinite(daily) ? daily : null,
      cases: selection.map(({ row, conditions }) => ({ id: row.id, projectId: row.projectId, at: row.at, depth: row.verdict.depth, effort: row.verdict.effort, today: row.plan.fallback, conditions, cleanBaseline: cleanBaseline(row), recorded: { status: row.outcome.status, action: row.outcome.action ?? null, code: row.outcome.code ?? null }, estimate: callEstimate(row, modelOf(row)) * conditions.length })),
      narrator: { captured: narratorRows.length, replayable: narratorRows.filter(narratorReplayable).length, selected: rewrites.length, calls: rewrites.length * 2, estimate: narratorTotal,
        cases: rewrites.map(({ row, conditions }) => ({ id: row.id, projectId: row.projectId, at: row.at, codes: row.request.violations.map(item => item.code), depth: row.verdict.depth, effort: row.verdict.effort, today: row.plan.fallback, conditions, recorded: { status: row.outcome.status, recheck: row.outcome.recheck ?? null }, estimate: narratorEstimate(row, modelOf(row)) * conditions.length })) } };
  }
  options(input = {}) {
    const integer = (value, fallback, min, max) => value === undefined ? fallback : Number.isSafeInteger(value) && value >= min && value <= max ? value : fail(`replay option out of range (${min}–${max})`);
    const options = { cases: integer(input.cases, REPLAY_DEFAULTS.cases, 0, 200), baseline: integer(input.baseline, REPLAY_DEFAULTS.baseline, 0, 200), narrator: integer(input.narrator, REPLAY_DEFAULTS.narrator, 0, 50), budgetTokens: integer(input.budgetTokens, REPLAY_DEFAULTS.budgetTokens, 1, REPLAY_BUDGET_TOKENS), concurrency: integer(input.concurrency, REPLAY_DEFAULTS.concurrency, 1, 2) };
    if (input.projectId !== undefined) { if (typeof input.projectId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.projectId)) fail('projectId 无效'); options.projectId = input.projectId; }
    return options;
  }
  /** Status; the dry-run plan is left to the caller (the daemon route skips it while a run is in progress). */
  status() { return { running: this.running, job: this.job ? structuredClone(this.job) : null, reports: this.reports(), approval: this.approval() }; }
  reports() { try { return readdirSync(this.reportDir()).filter(name => name.endsWith('.json') && name.startsWith('replay-')).map(name => name.slice(0, -5)).sort().slice(-20); } catch { return []; } }
  report(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) fail('报告 ID 无效');
    let json, markdown;
    try { json = JSON.parse(readFileSync(join(this.reportDir(), `${id}.json`), 'utf8')); markdown = readFileSync(join(this.reportDir(), `${id}.md`), 'utf8'); } catch { fail('报告不存在', 404, 'replay_report_missing'); }
    // A run whose daemon stopped without finishing it (a crash, a kill) left its last progress: it was interrupted.
    if (json.phase === 'running' && !(this.running && this.job?.id === id)) { json.phase = 'interrupted'; markdown = replayMarkdown(json); }
    return { id, json, markdown };
  }
  // ------------------------------------------------------------- approval
  /** The spend record; one that exists but cannot be read is flagged (a start then fails closed rather than forgetting
   * what earlier runs spent). */
  readSpend() {
    let text;
    try { text = readFileSync(this.spendFile(), 'utf8'); } catch (error) { return error?.code === 'ENOENT' ? emptySpend() : { ...emptySpend(), unreadable: true }; }
    try { const value = JSON.parse(text); if (value && Array.isArray(value.approvals) && value.jobs && typeof value.jobs === 'object') return value; } catch { /* flagged below */ }
    return { ...emptySpend(), unreadable: true };
  }
  writeSpend(value) {
    mkdirSync(this.reportDir(), { recursive: true, mode: 0o700 });
    const file = this.spendFile(), temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(temp, file);
  }
  /** The approved total (the user's 2.5M until it is recorded at the first start, plus every later explicit approval),
   * what every run spent (a run its daemon lost mid-call counts that call at its worst case), and what is left. */
  approval() {
    const spend = this.readSpend(), approved = spend.approvals.length ? spend.approvals.reduce((sum, row) => sum + Math.max(0, Number(row.tokens) || 0), 0) : REPLAY_BUDGET_TOKENS;
    const current = this.running ? this.job?.id : null;
    const spent = Object.entries(spend.jobs).reduce((sum, [id, row]) => sum + Math.max(0, Number(row.spentTokens) || 0) + (row.phase === 'running' && id !== current ? Math.max(0, Number(row.inFlightTokens) || 0) : 0), 0) + (current ? this.inFlight : 0);
    return { approved, spent, remaining: Math.max(0, approved - spent), approvals: spend.approvals.length, ...(spend.unreadable ? { unreadable: true } : {}) };
  }
  /**
   * Start (202): only with `approved: true`; never above the per-run limit, nor above what is left of the approved total
   * (`approveMore`: a further amount the user approved explicitly, recorded with this start), nor when the estimate does
   * not fit that or today's real-token cap.
   */
  start(input = {}) {
    if (input?.approved !== true) fail('回放会调用主模型并计费：需要 approved: true（用户已批准约 250 万 GLM token 的回放预算）。', 400, 'replay_not_approved');
    if (this.running) fail('已有回放在运行。', 409, 'replay_running');
    if (Number.isSafeInteger(input.budgetTokens) && input.budgetTokens > REPLAY_BUDGET_TOKENS) fail(`预算超过已批准的 ${REPLAY_BUDGET_TOKENS} token，拒绝开始。`, 400, 'replay_over_budget');
    if (input.approveMore !== undefined && !(Number.isSafeInteger(input.approveMore) && input.approveMore >= 1 && input.approveMore <= REPLAY_BUDGET_TOKENS)) fail(`approveMore 必须是 1–${REPLAY_BUDGET_TOKENS} 的整数（用户另行批准的 token 数）。`, 400, 'invalid_replay');
    const plan = this.plan(input);
    if (!plan.selected && !plan.narrator.selected) fail('没有可回放的捕获决策或消息改写：先开启 internalReasoning.capture，等待若干次后台决策。', 409, 'replay_no_cases');
    const before = this.approval();
    if (before.unreadable) fail('回放批准与花费记录（effort-probe/replay/spend.json）无法读取：拒绝开始，以免忘记此前的花费。', 409, 'replay_record_unreadable');
    const more = input.approveMore ?? 0, remaining = before.remaining + more, budget = Math.min(plan.options.budgetTokens, remaining);
    // The expected spend must fit this run's budget; each call is then admitted only while its worst case still fits (run()).
    if (plan.estimate > budget) {
      if (remaining < plan.options.budgetTokens) fail(`已批准的回放额度剩余 ${remaining} token（共批准 ${before.approved + more}，此前回放已用 ${before.spent}），不足估算的 ${plan.estimate}：拒绝开始。用户另行批准后用 --approve-more <token 数> 记录，或减少 cases/baseline/narrator。`, 409, 'replay_approval_spent');
      fail(`估算 ${plan.estimate} token 超过预算 ${plan.options.budgetTokens}，拒绝开始；减少 cases/baseline/narrator。`, 400, 'replay_estimate_over_budget');
    }
    // The user's daily real-token cap binds the replay like any other paid call.
    const daily = realBudgetRemaining(this.store.state, { now: this.now() });
    if (plan.estimate > daily) fail(`今天的真实模型 token 限额只剩 ${daily}，不足回放估算的 ${plan.estimate}：拒绝开始。`, 409, 'replay_daily_cap');
    const id = `replay-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`, stamp = new Date(this.now()).toISOString();
    const spend = this.readSpend();
    if (!spend.approvals.length) spend.approvals.push({ at: stamp, tokens: REPLAY_BUDGET_TOKENS, kind: 'initial', note: 'user decision 2026-10-04 (Stage B replay budget)', jobId: id });
    if (more) spend.approvals.push({ at: stamp, tokens: more, kind: 'additional', jobId: id });
    this.controller = new AbortController(); this.inFlight = 0;
    this.job = { id, phase: 'running', startedAt: stamp, options: plan.options, covers: plan.covers, budgetTokens: budget, approval: { approved: before.approved + more, spentBefore: before.spent, ...(more ? { approvedNow: more } : {}) }, estimate: plan.estimate, spentTokens: 0, done: 0, calls: plan.calls, cases: [], narrator: [] };
    spend.jobs[id] = { startedAt: stamp, budgetTokens: budget, spentTokens: 0, inFlightTokens: 0, phase: 'running', updatedAt: stamp };
    try { this.writeSpend(spend); } catch { fail('无法记录回放批准与花费，拒绝开始。', 500, 'replay_record_failed'); }
    this.promise = this.run(plan, this.controller.signal).catch(error => { this.job.phase = 'failed'; this.job.error = String(error?.message ?? error).slice(0, 300); }).finally(() => { this.promise = null; this.controller = null; this.inFlight = 0; this.write(); });
    this.write();
    return structuredClone(this.job);
  }
  cancel() { if (!this.running) return { cancelled: false }; this.controller.abort(); return { cancelled: true }; }
  async close() { this.controller?.abort(); await this.promise?.catch(() => {}); }
  /** A captured row that may no longer be sent: one of its conversations was deleted (or is being deleted), or the row
   * itself was purged or aged out (review RPL-1). Checked before every call, not only when the run started. */
  purged(row, purpose) { return !sessionsLive(this.store.state, row.sessionIds ?? []) || !this.capture.has(row.projectId, purpose, row.id); }
  async run(plan, signal) {
    const rows = new Map(this.rows(plan.options).map(row => [row.id, row])), selection = plan.cases.map(item => ({ row: rows.get(item.id), conditions: item.conditions })).filter(item => item.row);
    const rewriteRows = new Map(this.narratorRows(plan.options).map(row => [row.id, row])), rewrites = plan.narrator.cases.map(item => ({ row: rewriteRows.get(item.id), conditions: item.conditions })).filter(item => item.row);
    const queue = [...selection.flatMap(item => item.conditions.map(condition => ({ purpose: 'decision', item, condition }))), ...rewrites.flatMap(item => item.conditions.map(condition => ({ purpose: 'narrator', item, condition })))];
    const results = new Map(selection.map(item => [item.row.id, this.caseRecord(item.row)])), narrator = new Map(rewrites.map(item => [item.row.id, this.narratorRecord(item.row)]));
    this.job.cases = [...results.values()]; this.job.narrator = [...narrator.values()];
    const stop = (phase, reason) => { this.job.phase = phase; if (reason) this.job.stopReason = reason; queue.length = 0; };
    const worker = async () => {
      while (queue.length && !signal.aborted) {
        // Application maintenance waits for no replay: no further call starts while it holds new work (review RPL-9).
        if (this.held()) return stop('maintenance_stop', 'maintenance');
        const { purpose, item, condition } = queue.shift(), runs = (purpose === 'narrator' ? narrator : results).get(item.row.id).runs;
        const skip = reason => { runs[condition] = { condition, status: 'skipped', reason, tokens: 0 }; this.job.done++; this.write(); };
        if (this.purged(item.row, purpose)) { skip('purged'); continue; }
        const resolved = this.resolve(item.row);
        if (resolved.skip) { skip(resolved.skip); continue; }
        const ceiling = purpose === 'narrator' ? narratorCeiling(item.row, resolved.model) : callCeiling(item.row, resolved.model);
        // Hard budget: no call starts that could take the spend past it (its worst case: the request plus the whole
        // output allowance it is sent with), counting the calls still in flight at their worst case too.
        if (this.job.spentTokens + this.inFlight + ceiling > this.job.budgetTokens) return stop('budget_stop', 'budget');
        // …and the daily real-token cap: the worst case is reserved like every paid call's, then settled to the spend.
        const key = `replay:${this.job.id}:${++this.sequence}`;
        try { this.store.mutate(state => { reserveRealTokens(state, key, ceiling, { now: this.now() }); }); }
        catch (error) { if (error?.code === 'budget') return stop('budget_stop', 'daily_cap'); throw error; }
        this.inFlight += ceiling; this.write();
        let run = null;
        try { run = await (purpose === 'narrator' ? this.replayNarrator(item.row, condition, signal, resolved) : this.replayOne(item.row, condition, signal, resolved)); }
        finally {
          this.inFlight -= ceiling;
          // A call that threw past its own handling is charged at its worst case (never zero).
          const spent = run ? Math.max(0, run.tokens ?? 0) : ceiling, estimated = run ? run.estimated !== false : true;
          try { this.store.mutate(state => { releaseRealTokens(state, key, { now: this.now() }); chargeRealTokens(state, spent, { estimated, now: this.now() }); }); } catch { /* the reservation is charged at the next start (budget-service) */ }
          this.job.spentTokens += spent; this.job.done++;
          if (run) runs[condition] = run;
          this.write();
        }
      }
    };
    await Promise.all(Array.from({ length: plan.options.concurrency }, worker));
    if (signal.aborted) this.job.phase = 'cancelled'; else if (this.job.phase === 'running') this.job.phase = 'completed';
    this.job.finishedAt = new Date(this.now()).toISOString();
    this.job.summary = { ...summarize([...results.values()]), narrator: summarizeNarrator([...narrator.values()]) };
    // A run that stopped early (budget, cap, maintenance, cancel) measured part of the selection: no gate passes on it.
    if (this.job.phase !== 'completed') for (const gate of [this.job.summary.gate, this.job.summary.narrator.gate]) { gate.pass = false; gate.reasons = [...gate.reasons, 'run_incomplete']; }
  }
  caseRecord(row) {
    return { id: row.id, projectId: row.projectId, at: row.at, providerId: row.providerId, modelId: row.modelId, wakeSources: row.call?.facts?.wakeSources ?? null, depth: row.verdict.depth, rule: row.call?.rule ?? null, ...(row.call?.floor ? { floor: row.call.floor } : {}), jevEffort: row.verdict.effort, today: row.plan.fallback,
      recorded: { status: row.outcome.status, action: row.outcome.action ?? null, code: row.outcome.code ?? null, evidence: row.outcome.evidence ?? null, attempts: row.outcome.attempts ?? null, messageRepairs: row.outcome.messageRepairs ?? 0, tokens: row.outcome.usage?.totalTokens ?? null, latencyMs: row.outcome.latencyMs ?? null, clean: cleanBaseline(row) }, runs: {} };
  }
  narratorRecord(row) {
    const recheck = Array.isArray(row.outcome.recheck) ? row.outcome.recheck : null;
    return { id: row.id, projectId: row.projectId, at: row.at, providerId: row.providerId, modelId: row.modelId, codes: row.request.violations.map(item => item.code), depth: row.verdict.depth, rule: row.call?.rule ?? null, jevEffort: row.verdict.effort, today: row.plan.fallback,
      recorded: { status: row.outcome.status, recheck, passed: row.outcome.status === 'revised' ? recheck ? recheck.length === 0 : null : false, result: row.outcome.result ?? null, stopReason: row.outcome.stopReason ?? null, tokens: row.outcome.tokens ?? null, latencyMs: row.outcome.latencyMs ?? null, clean: cleanBaseline(row) }, runs: {} };
  }
  /** A project's background model as configured now, or null. */
  currentModel(projectId) {
    const state = this.store.state, project = state.projects.find(item => item.id === projectId);
    try { return project ? resolveModel(state.configuration, project.initiative?.modelSelection ?? null) : null; } catch { return null; }
  }
  /** The project and the model the captured call ran on (unchanged since), without its key; or why the case is skipped. */
  modelOf(row) {
    const project = this.store.state.projects.find(item => item.id === row.projectId);
    if (!project) return { skip: 'project_missing' };
    const model = this.currentModel(row.projectId);
    if (!model) return { skip: 'model_unavailable' };
    if (model.providerId !== row.providerId || model.modelId !== row.modelId || model.execution !== 'rna' || model.usagePolicy === 'interactive_only') return { skip: 'model_changed' };
    return { project, model };
  }
  /** The project, the model the captured call ran on (unchanged since) and its key; or why the case is skipped. */
  resolve(row) {
    const found = this.modelOf(row);
    if (found.skip) return found;
    const state = this.store.state, { project, model } = found, provider = state.configuration.providers.find(item => item.id === model.providerId);
    return { project, model, apiKey: this.store.configurationService.secret(provider.id, provider), sessions: state.sessions.filter(item => item.projectId === project.id && !item.archivedAt && item.kind !== 'side') };
  }
  /** The model stream, metered into the usage ledger (purpose evaluation, detail effort-replay, no project and no
   * keep-alive) and observed: reported usage (reasoning tokens too), the stop reason, what streamed, the request's
   * estimated input. */
  observe() {
    const seen = { usage: null, stopReason: null, streamed: 0, estimatedInput: null };
    const base = this.ledger ? meteredProvider(this.provider, { ledger: this.ledger, purpose: 'evaluation', keepAlive: null }) : this.provider;
    const stream = async function* (input) {
      if (Number.isFinite(input?.estimatedInputTokens)) seen.estimatedInput = Math.ceil(input.estimatedInputTokens);
      for await (const event of base({ ...input, purposeDetail: 'effort-replay' })) { if (event.type === 'usage') seen.usage = event.usage; else if (event.type === 'done') seen.stopReason = event.stopReason; else if (event.type === 'text_delta' || event.type === 'thinking_delta') seen.streamed += bytes(String(event.delta ?? '')); yield event; }
    };
    const tokens = inputTokens => seen.usage ? ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((sum, key) => sum + Math.max(0, Number(seen.usage[key]) || 0), 0) : (seen.estimatedInput ?? inputTokens) + Math.ceil(seen.streamed / 3);
    return { seen, stream, tokens };
  }
  /** One first-attempt decision on the captured request at `condition`'s effort. Never throws. */
  async replayOne(row, condition, signal, resolved = this.resolve(row)) {
    if (resolved.skip) return { condition, status: 'skipped', reason: resolved.skip, tokens: 0 };
    const { project, model, apiKey, sessions } = resolved, effort = condition === 'jev' ? row.verdict.effort : row.plan.fallback;
    const { seen, stream, tokens } = this.observe();
    // `messageChecked` false: the hook ran but the JEV part of the check could not (only the deterministic codes count).
    let violations = [], messageChecked = true;
    const captured = at(row.at) ?? this.now();
    const messageCheck = async decision => { const check = await this.messageCheck(project, sessions, decision.content, captured, signal).catch(() => null); violations = check ? [...new Set([...check.deterministic, ...(check.jev ?? [])])] : []; messageChecked = Array.isArray(check?.jev); return []; };
    const started = performance.now(), request = row.request, inputTokens = decisionInput(row);
    const base = { condition, effort, latencyMs: null, stopReason: null, usage: null, tokens: 0, estimated: false };
    const recordedAction = cleanBaseline(row) && row.outcome.status === 'decided' ? row.outcome.action : undefined;
    try {
      const outcome = await decideInitiative({ project: request.project, events: request.events, availableActions: request.availableActions, promptActions: request.promptActions, presence: request.presence ?? {}, policy: request.policy ?? {}, recentActions: request.recentActions ?? [], previousDecision: request.previousDecision ?? null,
        model, apiKey, provider: stream, signal, maxAttempts: 1, reasoning: effort, messageCheck, redactValues: this.decisions?.secrets?.() ?? [], schedulePromptVersion: schedulePromptVersionOfStore(this.store) });
      return { ...base, status: 'decided', action: outcome.decision.action, agreesWithRecorded: recordedAction === undefined ? null : outcome.decision.action === recordedAction, messageViolations: violations, messageChecked, latencyMs: Math.round(performance.now() - started), stopReason: seen.stopReason, usage: compactUsage(seen.usage), tokens: tokens(inputTokens), estimated: !seen.usage };
    } catch (error) {
      if (signal.aborted) return { ...base, status: 'cancelled', latencyMs: Math.round(performance.now() - started), tokens: tokens(inputTokens), estimated: !seen.usage };
      const categories = error?.initiativeFailure?.evidenceValidation?.categories ?? error?.evidenceValidation?.categories ?? null;
      return { ...base, status: 'failed', code: typeof error?.code === 'string' ? error.code : 'initiative_error', ...(categories ? { evidence: categories } : {}), unknownEvidence: Boolean(categories?.unknown), latencyMs: Math.round(performance.now() - started), stopReason: error?.initiativeFailure?.request?.stopReason ?? seen.stopReason, usage: compactUsage(seen.usage), tokens: tokens(inputTokens), estimated: !seen.usage };
    }
  }
  /** One rewrite of a captured flagged message at `condition`'s effort (the live prompt rebuilt from the capture), then
   * the live recheck: passed = a revision the JEV message check no longer flags (null: it could not be checked). A
   * truncated or empty rewrite does not pass (live, the flagged original is delivered then). Never throws. */
  async replayNarrator(row, condition, signal, resolved = this.resolve(row)) {
    if (resolved.skip) return { condition, status: 'skipped', reason: resolved.skip, tokens: 0 };
    const { project, model, apiKey, sessions } = resolved, effort = condition === 'jev' ? row.verdict.effort : row.plan.fallback, request = row.request;
    const prompt = narratorPrompt(request), inputTokens = Math.ceil((bytes(NARRATOR_SYSTEM) + bytes(prompt)) / 3);
    const { seen, stream, tokens } = this.observe();
    const started = performance.now(), base = { condition, effort, passed: false, latencyMs: null, stopReason: null, usage: null, tokens: 0, estimated: false };
    const ended = () => ({ latencyMs: Math.round(performance.now() - started), stopReason: seen.stopReason, usage: compactUsage(seen.usage), tokens: tokens(inputTokens), estimated: !seen.usage });
    let output = '';
    try {
      for await (const event of stream({ model: { ...model, reasoning: effort }, apiKey, systemPrompt: NARRATOR_SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: this.now() }], tools: [], signal, cache: { sessionKey: `narrator-replay:${row.projectId}`, prefixHash: 'rna-narrator-v2' }, estimatedInputTokens: inputTokens })) {
        if (event.type === 'text_delta') output += event.delta || '';
        else if (event.type === 'error') return { ...base, status: 'failed', code: 'provider_error', ...ended() };
      }
    } catch (error) {
      if (signal.aborted) return { ...base, status: 'cancelled', ...ended() };
      return { ...base, status: 'failed', code: typeof error?.code === 'string' ? error.code : 'provider_error', ...ended() };
    }
    const done = ended();
    if (seen.stopReason === 'length') return { ...base, status: 'length', ...done };
    if (!output.trim()) return { ...base, status: 'empty', ...done };
    const check = await this.messageCheck(project, sessions, output.trim(), at(row.at) ?? this.now(), signal, { deliverable: request.deliverable ?? null }).catch(() => null);
    return { ...base, status: 'revised', recheck: check?.jev ?? null, contract: check?.deterministic ?? null, passed: Array.isArray(check?.jev) ? check.jev.length === 0 : null, ...done };
  }
  /** The writing contract as the live check applies it, as of the capture: deterministic checks over deliveries before
   * it, and the JEV message.check through the raw probe (no ledger row, no state) — its codes as the live check keeps
   * them (semantic codes the deterministic checks did not already raise). `jev` is null when the probe is unavailable
   * (no key, unreachable, no answer after one retry); the deterministic codes stand either way (review RPL-12). */
  async messageCheck(project, sessions, text, time, signal, { deliverable = null } = {}) {
    signal?.throwIfAborted();
    const view = asOf(project, sessions, time);
    const deterministic = proactiveMessageViolations(text, { recent: recentDeliveries(view.project, view.sessions, { now: time, limit: 48 }) }).map(row => row.code);
    if (typeof this.decisions?.probe !== 'function') return { deterministic, jev: null };
    const kind = projectKindOf(project, { deliverable }), plan = messageCheckTemplate({ deliverable: Boolean(deliverable) }), questions = wire(plan);
    const state = minimizeDecisionState(buildDecisionState('message.check', { text, recent: sentDigest(view.project, view.sessions, { now: time, limit: 6 }), project: kind }, { now: time }), { maxChars: deriveDecisionPolicy('message.check').maxStateChars, knownSecrets: this.decisions.secrets?.() ?? [] });
    let body = null;
    for (let attempt = 0; attempt < 2 && !(body?.status === 200 && body.answers); attempt++) {
      signal?.throwIfAborted();
      try { body = await this.decisions.probe({ state, questions }); } catch { body = null; }
    }
    if (body?.status !== 200 || !body.answers) return { deterministic, jev: null };
    const known = new Set(deterministic);
    return { deterministic, jev: combineMessageCheck(answersOf(body.answers, questions)).filter(code => SEMANTIC_REPAIR[code] && !known.has(code)) };
  }
  /** The job's progress (after every call, so a crash keeps it) and its line in the spend record. */
  write() {
    if (!this.job) return;
    try {
      mkdirSync(this.reportDir(), { recursive: true, mode: 0o700 });
      writeFileSync(join(this.reportDir(), `${this.job.id}.json`), JSON.stringify(this.job, null, 2), { mode: 0o600 });
      writeFileSync(join(this.reportDir(), `${this.job.id}.md`), replayMarkdown(this.job), { mode: 0o600 });
      const spend = this.readSpend(); if (spend.unreadable) return;
      spend.jobs[this.job.id] = { ...(spend.jobs[this.job.id] ?? {}), startedAt: this.job.startedAt, budgetTokens: this.job.budgetTokens, spentTokens: this.job.spentTokens, inFlightTokens: this.inFlight, phase: this.job.phase, updatedAt: new Date(this.now()).toISOString() };
      this.writeSpend(spend);
    } catch { /* the in-memory job still answers status */ }
  }
}
const compactUsage = usage => usage ? Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoningTokens'].filter(key => Number.isFinite(usage[key])).map(key => [key, usage[key]])) : null;
const counted = run => Boolean(run) && ['decided', 'failed'].includes(run.status);
const acts = action => typeof action === 'string' && action !== 'wait';
/** A first attempt that live would have needed a repair or would have failed: a failed decision or a message-contract
 * violation (live, each costs a repair at today's effort). */
const firstAttemptFailed = run => run.status === 'failed' || (run.messageViolations?.length ?? 0) > 0;
/** The recorded live decision's first attempt failed: it failed, was repaired, or was retried (attempts > 1). */
const recordedFirstAttemptFailed = recorded => recorded.status === 'failed' || recorded.messageRepairs > 0 || recorded.attempts > 1;

/**
 * Lighter vs today's effort on the same states (cases with both runs): failures, unknown evidence, message-contract
 * violations, and the action — agreement with the recorded live decision (clean baselines only), and lost initiative
 * (the live decision worked, shared or asked; the run waited). `worse` names every measure on which the lighter runs
 * did worse than today's.
 */
export function pairedComparison(rows) {
  const pairs = rows.filter(row => counted(row.runs?.jev) && counted(row.runs?.today));
  const side = name => { const runs = pairs.map(row => row.runs[name]); return { failures: runs.filter(run => run.status === 'failed').length, unknownEvidence: runs.filter(run => run.unknownEvidence).length, messageContract: runs.filter(run => run.status === 'decided' && run.messageViolations?.length).length, messageUnchecked: runs.filter(run => run.status === 'decided' && run.messageChecked === false).length }; };
  const reference = pairs.filter(row => row.recorded?.clean && row.recorded.status === 'decided' && typeof row.recorded.action === 'string');
  const agrees = name => reference.filter(row => row.runs[name].status === 'decided' && row.runs[name].action === row.recorded.action).length;
  const waited = name => reference.filter(row => acts(row.recorded.action) && row.runs[name].status === 'decided' && row.runs[name].action === 'wait').length;
  const jev = side('jev'), today = side('today'), agreement = { cases: reference.length, jev: agrees('jev'), today: agrees('today') }, lostInitiative = { jev: waited('jev'), today: waited('today') };
  const worse = [...(jev.failures > today.failures ? ['failures'] : []), ...(jev.unknownEvidence > today.unknownEvidence ? ['unknown_evidence'] : []), ...(jev.messageContract > today.messageContract ? ['message_contract'] : []),
    ...(agreement.jev < agreement.today ? ['agreement'] : []), ...(lostInitiative.jev > lostInitiative.today ? ['lost_initiative'] : [])];
  return { cases: pairs.length, jev, today, agreement, lostInitiative,
    sameAction: pairs.filter(row => row.runs.jev.status === 'decided' && row.runs.today.status === 'decided' && row.runs.jev.action === row.runs.today.action).length,
    jevFailedOnly: pairs.filter(row => row.runs.jev.status === 'failed' && row.runs.today.status !== 'failed').length, todayFailedOnly: pairs.filter(row => row.runs.today.status === 'failed' && row.runs.jev.status !== 'failed').length,
    jevWaitedOnly: pairs.filter(row => row.runs.jev.action === 'wait' && acts(row.runs.today.action)).length, todayWaitedOnly: pairs.filter(row => row.runs.today.action === 'wait' && acts(row.runs.jev.action)).length, worse };
}
/** Every lighter run against its own recorded live first attempt (at today's effort, clean baselines only). */
function recordedComparison(rows) {
  const cases = rows.filter(row => counted(row.runs?.jev) && row.recorded?.clean && ['decided', 'failed'].includes(row.recorded.status));
  return { cases: cases.length, jevFailures: cases.filter(row => firstAttemptFailed(row.runs.jev)).length, recordedFailures: cases.filter(row => recordedFirstAttemptFailed(row.recorded)).length, messageUnchecked: cases.filter(row => row.runs.jev.status === 'decided' && row.runs.jev.messageChecked === false).length };
}

/** Per condition: valid share, invalid_decision (unknown evidence above all), message-contract violations, truncations,
 * action agreement with the recorded decision, tokens and latency; paired lighter-vs-today on the same states; the gate. */
export function summarize(cases) {
  // `policy`: each case at the effort routing would send (the lighter run, or today's where JEV kept today's effort).
  const runOf = (row, name) => name === 'policy' ? row.jevEffort === row.today ? row.runs.today : row.runs.jev : row.runs[name];
  const condition = name => {
    const runs = cases.map(row => runOf(row, name)).filter(counted);
    const failed = runs.filter(run => run.status === 'failed'), decided = runs.filter(run => run.status === 'decided');
    const agreeing = decided.filter(run => run.agreesWithRecorded !== null && run.agreesWithRecorded !== undefined);
    return { runs: runs.length, valid: decided.length, failureRate: runs.length ? round(failed.length / runs.length) : null,
      invalidDecision: failed.filter(run => run.code === 'invalid_decision').length, unknownEvidence: failed.filter(run => run.unknownEvidence).length, lengthStops: runs.filter(run => run.stopReason === 'length').length,
      messageContract: decided.filter(run => run.messageViolations?.length).length, messageUnchecked: decided.filter(run => run.messageChecked === false).length, otherFailures: failed.filter(run => run.code !== 'invalid_decision').length,
      agreementWithRecorded: agreeing.length ? round(agreeing.filter(run => run.agreesWithRecorded).length / agreeing.length) : null,
      meanOutput: mean(runs.map(run => run.usage?.output).filter(Number.isFinite)), meanReasoningTokens: mean(runs.map(run => run.usage?.reasoningTokens).filter(Number.isFinite)), meanTokens: mean(runs.map(run => run.tokens).filter(Number.isFinite)), meanLatencyMs: mean(runs.map(run => run.latencyMs).filter(Number.isFinite)) };
  };
  // Recorded live decisions that ran at today's effort (a route trial's are no baseline); their first attempt failed when
  // it failed, was repaired or was retried.
  const recorded = cases.filter(row => row.recorded.clean && (row.recorded.status === 'decided' || row.recorded.status === 'failed'));
  const recordedFailure = recorded.length ? round(recorded.filter(row => recordedFirstAttemptFailed(row.recorded)).length / recorded.length) : null;
  const byDepth = {}, classesNotToLower = [];
  for (const depth of [...DEPTHS, ...new Set(cases.map(row => row.depth).filter(depth => !DEPTHS.includes(depth)))]) {
    const rows = cases.filter(row => row.depth === depth); if (!rows.length) continue;
    const paired = pairedComparison(rows), versus = recordedComparison(rows), lowered = rows.some(row => counted(row.runs.jev));
    byDepth[depth] = { cases: rows.length, jev: summarizeSubset(rows, 'jev'), today: summarizeSubset(rows, 'today'), paired, recorded: versus };
    // A class with lighter runs is lowered only on paired evidence that it does no worse (不准确就不降): no pairs, a
    // worse paired measure, or more first-attempt failures than its recorded live decisions keep it at today's effort.
    if (lowered && (!paired.cases || paired.worse.length || versus.jevFailures > versus.recordedFailures)) classesNotToLower.push(depth);
  }
  const jev = condition('jev'), today = condition('today'), policy = condition('policy'), paired = pairedComparison(cases), versus = recordedComparison(cases);
  // Gate (plan §3 P1-4: 不准确就不降; spec §6.3 Stage B; review EFF-1/RPL-3), on paired cases against a clean baseline:
  // the lighter runs may not fail more often, cite unknown evidence more often, break the writing contract more often,
  // agree less often with the recorded live decision or wait where it acted more often than today's runs on the same
  // states; every lighter run may not fail its first attempt more often than its recorded live decision did; the
  // message check must have been complete; and no depth class may be one not to lower (no per-class switch exists).
  const reasons = [...(jev.runs ? [] : ['no_lighter_runs']), ...(paired.cases ? [] : ['no_paired_baseline']), ...(paired.cases && !paired.agreement.cases ? ['no_clean_recorded_baseline'] : []),
    ...paired.worse.map(measure => `worse_${measure}`), ...(versus.jevFailures > versus.recordedFailures ? ['more_first_attempt_failures_than_recorded'] : []),
    ...(paired.jev.messageUnchecked || paired.today.messageUnchecked || versus.messageUnchecked ? ['message_check_incomplete'] : []), ...(classesNotToLower.length ? ['class_not_to_lower'] : [])];
  const gate = { pass: reasons.length === 0, reasons, classesNotToLower, covers: 'decision' };
  return { jev, today, policy, recorded: { cases: recorded.length, failureOrRepairRate: recordedFailure, firstAttempt: versus }, paired, byDepth, gate };
}
function summarizeSubset(rows, name) {
  const runs = rows.map(row => row.runs[name]).filter(counted);
  if (!runs.length) return null;
  const failed = runs.filter(run => run.status === 'failed');
  return { runs: runs.length, failureRate: round(failed.length / runs.length), unknownEvidence: failed.filter(run => run.unknownEvidence).length, messageContract: runs.filter(run => run.messageViolations?.length).length, meanOutput: Math.round(runs.reduce((sum, run) => sum + (run.usage?.output ?? 0), 0) / runs.length) };
}
/** Rewrites per condition: the recheck pass rate (a truncated, empty or failed rewrite counts as not passed; a revision
 * the probe could not check is left out and counted), truncations, tokens and latency; paired on the same messages; the
 * gate. */
export function summarizeNarrator(cases) {
  const condition = name => {
    const runs = cases.map(row => row.runs[name]).filter(run => run && ['revised', 'length', 'empty', 'failed'].includes(run.status)), checked = runs.filter(run => run.passed !== null);
    return { runs: runs.length, revised: runs.filter(run => run.status === 'revised').length, checked: checked.length, unchecked: runs.length - checked.length, passRate: checked.length ? round(checked.filter(run => run.passed).length / checked.length) : null,
      lengthStops: runs.filter(run => run.status === 'length').length, failures: runs.filter(run => run.status === 'failed' || run.status === 'empty').length,
      meanOutput: mean(runs.map(run => run.usage?.output).filter(Number.isFinite)), meanReasoningTokens: mean(runs.map(run => run.usage?.reasoningTokens).filter(Number.isFinite)), meanTokens: mean(runs.map(run => run.tokens).filter(Number.isFinite)), meanLatencyMs: mean(runs.map(run => run.latencyMs).filter(Number.isFinite)) };
  };
  const jev = condition('jev'), today = condition('today'), recorded = cases.filter(row => row.recorded.passed !== null && row.recorded.clean !== false);
  const pairs = cases.filter(row => typeof row.runs.jev?.passed === 'boolean' && typeof row.runs.today?.passed === 'boolean');
  const recordedPass = recorded.length ? round(recorded.filter(row => row.recorded.passed).length / recorded.length) : null;
  const paired = { cases: pairs.length, bothPassed: pairs.filter(row => row.runs.jev.passed && row.runs.today.passed).length, jevFailedOnly: pairs.filter(row => !row.runs.jev.passed && row.runs.today.passed).length, todayFailedOnly: pairs.filter(row => row.runs.jev.passed && !row.runs.today.passed).length };
  // Gate (不准确就不降): on the same messages the lighter rewrites fail the recheck no more often than today's, pass it at
  // least as often overall and truncate no more often; every revision was checked.
  const reasons = [...(jev.runs ? [] : ['no_lighter_runs']), ...(paired.cases ? [] : ['no_paired_baseline']), ...(paired.jevFailedOnly > paired.todayFailedOnly ? ['worse_recheck'] : []),
    ...(jev.passRate !== null && worse(today.runs ? today.passRate : recordedPass, jev.passRate) ? ['lower_pass_rate'] : []), ...(jev.lengthStops > today.lengthStops ? ['more_truncations'] : []), ...(jev.unchecked || today.unchecked ? ['recheck_incomplete'] : [])];
  return { cases: cases.length, jev, today, recorded: { cases: recorded.length, passRate: recordedPass }, paired, gate: { pass: reasons.length === 0, reasons, covers: 'narrator' } };
}
const worse = (a, b) => a !== null && b !== null && a > b;
const GATE_REASONS = { no_lighter_runs: 'no lighter run', no_paired_baseline: "no paired run at today's effort", no_clean_recorded_baseline: 'no paired case with a clean recorded live decision',
  worse_failures: 'more failed decisions', worse_unknown_evidence: 'more unknown-evidence citations', worse_message_contract: 'more message-contract violations', worse_agreement: 'less agreement with the recorded decision',
  worse_lost_initiative: 'waited more often where the recorded decision acted', more_first_attempt_failures_than_recorded: 'more first-attempt failures than the recorded live decisions',
  message_check_incomplete: 'message check incomplete (JEV unavailable)', class_not_to_lower: 'a depth class may not be lowered', worse_recheck: 'more rewrites failed the recheck', lower_pass_rate: 'lower recheck pass rate',
  more_truncations: 'more truncations', recheck_incomplete: 'recheck incomplete (JEV unavailable)', run_incomplete: 'the run stopped before every call was made' };
const reasonText = reasons => reasons.map(reason => GATE_REASONS[reason] ?? reason).join('; ');
/** The research report: aggregates and per-case rows (ids, efforts, outcomes, tokens), never prompts or model text. */
export function replayMarkdown(job) {
  const s = job.summary, line = (label, row) => row ? `| ${label} | ${row.runs} | ${row.valid} | ${row.failureRate ?? '–'} | ${row.invalidDecision} | ${row.unknownEvidence} | ${row.messageContract}${row.messageUnchecked ? ` (${row.messageUnchecked} unchecked)` : ''} | ${row.lengthStops} | ${row.agreementWithRecorded ?? '–'} | ${row.meanOutput ?? '–'} | ${row.meanReasoningTokens ?? '–'} | ${row.meanTokens ?? '–'} | ${row.meanLatencyMs ?? '–'} |` : '';
  const rows = (job.cases ?? []).map(row => { const run = name => { const r = row.runs[name]; return !r ? '–' : r.status === 'decided' ? `${r.action}${r.messageViolations?.length ? ` (msg: ${r.messageViolations.join('/')})` : ''}${r.messageChecked === false ? ' (msg unchecked)' : ''}` : r.status === 'failed' ? `**${r.code}**${r.unknownEvidence ? ' (unknown evidence)' : ''}${r.stopReason === 'length' ? ' (length)' : ''}` : r.status === 'skipped' ? `skipped (${r.reason})` : r.status; }; const tokens = name => row.runs[name]?.tokens ?? '–';
    return `| ${row.id.slice(0, 8)} | ${String(row.at).slice(0, 16)} | ${(row.wakeSources ?? []).join(', ')} | ${row.depth}${row.rule ? ' (rule)' : ''}${row.floor ? ` (≥ ${row.floor})` : ''} | ${row.jevEffort} / ${row.today} | ${row.recorded.status === 'decided' ? row.recorded.action : row.recorded.code ?? row.recorded.status}${row.recorded.clean === false ? ' (route trial: no baseline)' : ''} | ${run('jev')} | ${run('today')} | ${tokens('jev')} / ${tokens('today')} |`; });
  const n = s?.narrator, nline = (label, row) => `| ${label} | ${row.runs} | ${row.revised} | ${row.passRate ?? '–'}${row.unchecked ? ` (${row.unchecked} unchecked)` : ''} | ${row.lengthStops} | ${row.failures} | ${row.meanOutput ?? '–'} | ${row.meanReasoningTokens ?? '–'} | ${row.meanTokens ?? '–'} | ${row.meanLatencyMs ?? '–'} |`;
  const nrows = (job.narrator ?? []).map(row => { const run = name => { const r = row.runs[name]; return !r ? '–' : r.status === 'revised' ? r.passed === null ? 'revised (unchecked)' : r.passed ? 'passed' : `flagged: ${(r.recheck ?? []).join('/')}` : r.status === 'skipped' ? `skipped (${r.reason})` : r.status; };
    const recorded = row.recorded.status === 'kept' ? `kept${row.recorded.result ? ` (${row.recorded.result})` : ''}` : row.recorded.passed === null ? 'revised (unchecked)' : row.recorded.passed ? 'passed' : `flagged: ${(row.recorded.recheck ?? []).join('/')}`;
    return `| ${row.id.slice(0, 8)} | ${String(row.at).slice(0, 16)} | ${row.codes.join(', ')} | ${row.depth ?? '–'}${row.rule ? ' (rule)' : ''} | ${row.jevEffort} / ${row.today} | ${recorded} | ${run('jev')} | ${run('today')} | ${row.runs.jev?.tokens ?? '–'} / ${row.runs.today?.tokens ?? '–'} |`; });
  const p = s?.paired, gateLine = (gate, purpose, routeOk) => gate.pass ? `pass — ${routeOk}` : `not passed (${reasonText(gate.reasons)}) — keep effort.${purpose} in shadow`;
  // What routing the gates allow (only a completed run decides anything).
  const passed = s && job.phase === 'completed' ? [...(s.gate.pass ? ['decision'] : []), ...(n?.gate?.pass ? ['narrator'] : [])] : [];
  const next = !s ? null : job.phase !== 'completed' ? `the run did not complete (${job.phase}): no gate decision; routing stays as it is.` : passed.length ? `\`./rna effort routing route --purposes ${passed.join(',')}\` (only the purposes whose gate passed).` : 'no gate passed: keep `./rna effort routing shadow`.';
  return [`# Internal effort replay (Stage B) — ${job.id}`, '',
    ...(next ? [`- **Next:** ${next}`] : []),
    `- Phase: ${job.phase}${job.stopReason ? ` (${job.stopReason})` : ''}${job.error ? ` (${job.error})` : ''}; started ${job.startedAt}${job.finishedAt ? `, finished ${job.finishedAt}` : ''}.`,
    `- Budget ${job.budgetTokens ?? job.options?.budgetTokens} tokens (approved in total ${job.approval?.approved ?? '–'}, spent before this run ${job.approval?.spentBefore ?? '–'}); estimate ${job.estimate}; spent ${job.spentTokens} (input + output + cache, as reported; estimated when unreported; usage ledger purpose evaluation / effort-replay, charged to the daily real-token cap). Calls ${job.done}/${job.calls}.`,
    `- Covers ${(job.covers ?? REPLAY_COVERS).join(' and ')} only: background work and subtasks (effort.work), setup and compaction stay recorded only whatever this report says.`,
    `- One first attempt per run, no repair; message contract checked as of each capture (deterministic checks + JEV message.check via the raw probe).`, '',
    ...(s ? ['## Decisions', '', '| condition | runs | valid | failure rate | invalid_decision | unknown evidence | message contract | length | agrees with recorded | mean output | mean reasoning | mean tokens | mean latency ms |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
      line('JEV-chosen effort (lighter cases)', s.jev), line("today's effort", s.today), line('routed policy (every case at its JEV effort)', s.policy), '',
      `Recorded live decisions at today's effort (clean baselines; with repair): ${s.recorded.cases} cases, first-attempt failure-or-repair rate ${s.recorded.failureOrRepairRate ?? '–'}. Lighter runs on those states: ${s.recorded.firstAttempt.jevFailures} first-attempt failures (incl. message contract) vs ${s.recorded.firstAttempt.recordedFailures} recorded, over ${s.recorded.firstAttempt.cases} cases.`,
      `Paired on the same states: ${p.cases}; failed ${p.jev.failures} lighter / ${p.today.failures} today; unknown evidence ${p.jev.unknownEvidence} / ${p.today.unknownEvidence}; message contract ${p.jev.messageContract} / ${p.today.messageContract}; agrees with the recorded decision ${p.agreement.jev} / ${p.agreement.today} of ${p.agreement.cases}; waited where it acted ${p.lostInitiative.jev} / ${p.lostInitiative.today}; same action ${p.sameAction}; only the lighter run waited while today's acted ${p.jevWaitedOnly}, the reverse ${p.todayWaitedOnly}.`, '',
      '| depth | cases | paired | JEV failure rate | today failure rate | failed (paired) lighter / today | unknown evidence (paired) | message contract (paired) | agrees with recorded (paired) | waited where it acted (paired) | JEV mean output | today mean output | lower? |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
      ...Object.entries(s.byDepth).map(([depth, row]) => `| ${depth} | ${row.cases} | ${row.paired.cases} | ${row.jev?.failureRate ?? '–'} | ${row.today?.failureRate ?? '–'} | ${row.paired.jev.failures} / ${row.paired.today.failures} | ${row.paired.jev.unknownEvidence} / ${row.paired.today.unknownEvidence} | ${row.paired.jev.messageContract} / ${row.paired.today.messageContract} | ${row.paired.agreement.jev} / ${row.paired.agreement.today} of ${row.paired.agreement.cases} | ${row.paired.lostInitiative.jev} / ${row.paired.lostInitiative.today} | ${row.jev?.meanOutput ?? '–'} | ${row.today?.meanOutput ?? '–'} | ${s.gate.classesNotToLower.includes(depth) ? 'no' : row.jev ? 'yes' : '–'} |`), '',
      `**Gate (decisions):** ${gateLine(s.gate, 'decision', "the lighter effort did no worse than today's on the same states")}.`, ''] : []),
    '### Decision cases', '', '| case | captured | wake sources | depth | JEV / today effort | recorded | JEV run | today run | tokens JEV / today |', '|---|---|---|---|---|---|---|---|---|', ...rows, '',
    ...(n && n.cases ? ['## Message rewrites (narrator)', '', '| condition | runs | revised | recheck pass rate | length | failed or empty | mean output | mean reasoning | mean tokens | mean latency ms |', '|---|---|---|---|---|---|---|---|---|---|',
      nline('JEV-chosen effort', n.jev), nline("today's effort", n.today), '',
      `Recorded live rewrites (today's effort): ${n.recorded.cases} checked, pass rate ${n.recorded.passRate ?? '–'}. Paired: ${n.paired.cases}; both passed ${n.paired.bothPassed}; only the lighter one failed ${n.paired.jevFailedOnly}; only today's failed ${n.paired.todayFailedOnly}.`, '',
      `**Gate (rewrites):** ${gateLine(n.gate, 'narrator', 'the lighter rewrites passed the recheck at least as often')}.`, '',
      '### Rewrite cases', '', '| case | captured | flagged | depth | JEV / today effort | recorded | JEV run | today run | tokens JEV / today |', '|---|---|---|---|---|---|---|---|---|', ...nrows, ''] : [])].join('\n');
}
