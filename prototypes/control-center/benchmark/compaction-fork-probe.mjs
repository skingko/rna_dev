// C5 / TC-6 paid probe (plan align-synthesis §2.2 C5; user approval 2026-10-05: one small GLM probe, 5–10 points): does
// a forked compaction request — the conversation's own system prompt, tools and projected messages plus one host
// instruction at the tail (SDK forkRequest) — read GLM's cached prefix, come back as text only, and keep the user's
// requests at least as well as the flattened summary? It runs inside the live daemon, so it uses the app's configured
// model and key without anyone reading a secrets file; the key is never read into a report, a log or a ledger row.
//
// Points come from GLM conversation journals, only from spans the live conversation has moved past (a later compaction
// replaced them), so no probe request warms the prefix the conversation's next request extends: real past automatic
// compactions GLM ran first, then large-context points. Each point is rebuilt by the SDK on a truncated COPY of the
// journal (session.compactionRequests): request A is the main request at that point (it warms the cache; skipped when
// real usage shows the live cache still warm; a reply that was cut, even by a provider_protocol failure, still counts as
// warmed when it reported its prompt), request B is the fork request, and request C is the flattened request at the same
// boundary — always on a compaction point, and on a large-context point whenever the budget allows it without taking the
// later points' planned share (a compaction point's boundary holds few requests: the first probe compared one) — sent
// fresh so fork and flat answer the same generation of the summary prompt (the summary on record was written by whatever
// prompt was current then; it is judged too, as a reference outside the gate). The live conversation is never opened for writing: no entry, no
// summary, no survival sample (the probe's ledger rows carry no session and no continuity), and its journal is only read.
//
// Safety, as the effort replay (internal-effort-replay.mjs): `approved: true` is required; the user approved one probe
// of PROBE_BUDGET_TOKENS in total, counted from reported usage (input + output + cache) and recorded with every run's
// spend in `<state>.rna/compaction-fork-probe/spend.json`; no request starts whose worst case (its input with headroom
// plus its whole output allowance) would take the spend past the budget, nor while application maintenance holds new
// work; a request's worst case reaches spend.json before the request is sent (a failed write sends nothing), and a request
// that reports no usage is charged its worst case. Every call is metered (purpose evaluation, detail
// compaction-fork-probe) and charged to the daily real-token cap. Coverage asks the SDK's summary.coverage questions (the
// ones A3 labelled) per user request and summary through the daemon's raw probe (one jev ledger row each, about 1/1000
// of the cost).
//
// Run it with `./rna compaction probe --approved` (cli-compaction.mjs). Method and results:
// docs/research/glm-compaction-fork-probe-20261005.md.
import { createReadStream, mkdirSync, mkdtempSync, openSync, writeSync, closeSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, statSync, lstatSync, chmodSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession } from '../../../packages/sdk/src/session.mjs';
import { iterateCompletion, streamCompletion, REASONING_VALUES } from '../../../packages/sdk/src/providers.mjs';
import { prepareContext } from '../../../packages/sdk/src/context.mjs';
import { MAX_SUMMARY_BYTES } from '../../../packages/sdk/src/compaction-request.mjs';
import { buildDecisionState } from '../../../packages/sdk/src/decision-state.mjs';
import { summaryCoverageTemplate, combineSummaryCoverage, wireQuestions, DECISION_THRESHOLDS } from '../../../packages/sdk/src/decision-templates.mjs';
import { resolveModel } from '../configuration.mjs';
import { sessionsLive, reasoningFor } from '../internal-reasoning.mjs';
import { meteredProvider } from '../usage-cache-service.mjs';
import { sharedPrefixFor, prefixesFor } from '../prompt-prefix-registry.mjs';
import { realBudgetRemaining, reserveRealTokens, releaseRealTokens, chargeRealTokens } from '../budget-service.mjs';

/** The user-approved probe (2026-10-05): every run together spends no more than this. */
export const PROBE_BUDGET_TOKENS = 2000000;
export const PROBE_DEFAULTS = Object.freeze({ points: 8, budgetTokens: PROBE_BUDGET_TOKENS });
/** Points in a moderate context range (estimated prompt tokens of request A), so 5–10 points fit the budget twice over
 * (A and B each read the whole context). The 09-30 compaction (773K) alone would take most of it. */
export const PROBE_CONTEXT = Object.freeze({ min: 40000, max: 300000 });
/** Request A only has to put its prompt in the cache: a small output allowance (the prompt, not max_tokens, is cached),
 * with room for the start of GLM's reasoning so the request is an ordinary one that stops at its limit. */
export const WARMUP_OUTPUT_TOKENS = 1024;
/** Planning figures for request B: the fork instruction (summary prompt and checkpoint sections) and a typical summary
 * with reasoning (live GLM compactions: 3.1K–6.9K output). The hard cap uses the whole allowance instead. */
export const FORK_INSTRUCTION_TOKENS = 2000, FORK_OUTPUT_ESTIMATE = 8192;
/** Planning figures for request C, the flattened request on a compaction point: it reads the archived span alone (no
 * system prompt, tools or retained turns), 0.59–0.60 of the context on the three recorded compactions of 1484f7e9 (38K
 * of 64K, 41K of 72K, 171K of 290K). The hard cap uses the rebuilt request's own estimate. */
export const FLAT_SHARE = 0.7, FLAT_OUTPUT_ESTIMATE = 8192;
/** A cache hit is bimodal on GLM (spec p1 compaction §0.1: none of 1,745 continuous samples between 0.1 and 0.9). */
export const FORK_HIT_RATIO = 0.9;
/** Share of the budget the plan may fill (see selectPoints). */
export const PLAN_SHARE = 0.8;
/** Coverage per summary: the newest user requests up to the boundary, one JEV call per request and summary. */
export const COVERAGE_REQUESTS = 120;
/** (c) counts as evidence only with at least this many substantive requests compared fork against flat on GLM compaction
 * points rebuilt with their own project's prompt: at A3's labelled accuracy (about 0.9 per request) one or two say little. */
export const COVERAGE_MIN_REQUESTS = 5;
const COVERAGE_CONCURRENCY = 4;
const PROBE_DETAIL = 'compaction-fork-probe';
const HEADROOM = 1.2;
const EDIT_RECORDS = new Set(['context_settle', 'context_forget', 'context_fold', 'image_offload', 'context_rewind', 'thinking_rebase']);
const fail = (message, status = 400, code = 'replay_invalid') => { throw Object.assign(new Error(message), { status, code }); };
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
const round = (value, digits = 3) => Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
const promptOf = usage => usage ? ['input', 'cacheRead', 'cacheWrite'].reduce((sum, key) => sum + Math.max(0, Number(usage[key]) || 0), 0) : null;
const tokensOf = usage => usage ? ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((sum, key) => sum + Math.max(0, Number(usage[key]) || 0), 0) : null;
const compactUsage = usage => usage ? Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoningTokens'].filter(key => Number.isFinite(usage[key])).map(key => [key, usage[key]])) : null;
/** Whether a request's reported usage shows its prompt was processed (and so cached): a positive input side. */
export const warmedByUsage = usage => Boolean(usage) && Number.isFinite(usage.input) && usage.input >= 0 && promptOf(usage) > 0;
const answersOf = (raw, questions) => Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'boolean', probability: raw?.[id]?.noul }]));
/** Runs `tasks` (functions returning promises) with at most `limit` at a time; the first rejection rejects. */
async function pool(tasks, limit) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => { while (next < tasks.length) await tasks[next++](); }));
}
/** GLM only (TC-6 is switched on per model): the probe measures what `compat.compactionFork` would do there. */
export const isGlm = model => /^glm-/i.test(String(model?.modelId ?? ''));
export const probeRoot = stateFile => join(`${stateFile}.rna`, 'compaction-fork-probe');
const SUMMARIES_FILE = /^(probe-[a-zA-Z0-9-]{1,80})\.summaries\.json$/;
const realDirectory = path => { try { const info = lstatSync(path); return info.isDirectory() && !info.isSymbolicLink(); } catch { return false; } };
/**
 * Remove the fork and flat summaries whose conversation `gone(sessionId)` says is deleted, from every
 * `<id>.summaries.json` (keyed by point id; its report `<id>.json` names each point's sessionId). Under the A3 template
 * a summary quotes the user's requests, so it goes with its conversation, like an effort capture (session-deletion.mjs).
 * A summary whose point the report does not name has no known conversation and goes too; so does a summaries file that
 * cannot be parsed. Returns the number of summaries removed; never throws.
 */
function dropSummaries(stateFile, gone) {
  const root = probeRoot(stateFile);
  if (!realDirectory(`${stateFile}.rna`) || !realDirectory(root)) return 0;
  let removed = 0, names = [];
  try { names = readdirSync(root); } catch { return 0; }
  for (const name of names) {
    const match = SUMMARIES_FILE.exec(name); if (!match) continue;
    const file = join(root, name);
    try {
      let summaries;
      try { summaries = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') continue; rmSync(file, { force: true }); removed++; continue; }
      if (!summaries || typeof summaries !== 'object' || Array.isArray(summaries)) { rmSync(file, { force: true }); removed++; continue; }
      let points = [];
      try { points = JSON.parse(readFileSync(join(root, `${match[1]}.json`), 'utf8')).points ?? []; } catch { /* no report: no point has a known conversation */ }
      const owners = new Map((Array.isArray(points) ? points : []).map(point => [point?.id, point?.sessionId]));
      const drop = Object.keys(summaries).filter(id => { const sessionId = owners.get(id); return typeof sessionId !== 'string' || gone(sessionId); });
      if (!drop.length) continue;
      for (const id of drop) delete summaries[id];
      if (Object.keys(summaries).length) { const temp = `${file}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(summaries, null, 2), { mode: 0o600 }); renameSync(temp, file); }
      else rmSync(file, { force: true });
      removed += drop.length;
    } catch { /* the next sweep retries this file */ }
  }
  return removed;
}
/** A deleted conversation: its probe summaries go with it (session-deletion.mjs, beside purgeEffortCaptures). */
export const purgeProbeSummaries = (stateFile, sessionId) => typeof sessionId === 'string' && sessionId ? dropSummaries(stateFile, id => id === sessionId) : 0;
/** The retention sweep (at start and daily): every summary whose conversation is no longer in `state` (deleted, or
 * deleting), including one written after its deletion's purge. */
export const pruneProbeSummaries = (stateFile, { state } = {}) => state ? dropSummaries(stateFile, id => !sessionsLive(state, [id])) : 0;
/** A request's worst case: its input with headroom plus its whole output allowance. */
const ceilingOf = (request, allowance) => Math.ceil(request.estimatedInputTokens * HEADROOM) + allowance;
const emptySpend = () => ({ version: 1, approvals: [], jobs: {} });
/**
 * The provider-visible prefix (system prompt, tool declarations) a point is rebuilt with. A journal records the
 * messages, not the prompt or the tools; the runtime publishes them (prompt-prefix-registry) at every request. The
 * project's own on that model when published since the daemon started (`project`); else the newest other project's on
 * that model (`other_project`: the same app layers and global tools, another project's norms and tools — a stand-in
 * the report flags); else none.
 */
export function publishedPrefix(projectId, model) {
  const own = sharedPrefixFor(projectId, model);
  if (own) return { ...own, source: 'project' };
  const other = prefixesFor(model).find(row => row.projectId !== projectId);
  return other ? { ...other, source: 'other_project', fromProjectId: other.projectId } : null;
}
function redact(value, secrets) {
  if (typeof value === 'string') { let text = value; for (const secret of secrets) text = text.split(secret).join('[REDACTED]'); return text; }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]));
  return value;
}

/**
 * One streaming pass over a conversation journal: the automatic compactions it records (manual and idle ones are not
 * forked) and its served requests, each with the model that served the conversation then, its size from reported
 * usage and what a later check needs (the recorded request digest and prefix hash). Read-only; a torn last line is
 * skipped. `closedBefore`: the record of the newest compaction whose boundary is still in the conversation (replay's
 * rule: a rewind that drops a boundary drops that compaction) — the live conversation's projection starts from that
 * summary, so it extends no prefix built before it; null without one.
 */
export async function scanJournal(file) {
  const compactions = [], requests = [], open = new Map();
  // `groups`: served requests since the last compaction boundary (or a rewind): each closes one complete group, and an
  // automatic candidate needs more than the two it keeps (automaticCompactionCandidate), so fewer than three has none.
  let header = null, model = null, lastServed = null, edits = 0, pending = null, groups = 0;
  // The conversation's messages in replay order (session.mjs replay), to see which boundaries a rewind removed.
  const order = [], present = new Set(); let boundaries = [];
  const note = message => { if (typeof message?.id === 'string' && !present.has(message.id)) { present.add(message.id); order.push(message.id); } };
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let record; try { record = JSON.parse(line); } catch { continue; }
    const { type, data = {} } = record, seq = record.seq;
    if (type === 'session_header') header = { sessionId: data.sessionId, projectId: data.projectId ?? null };
    else if (type === 'message' || type === 'inbox_claimed' || type === 'tool_completed' || type === 'finish_review') note(data.message);
    else if (type === 'request_started') {
      if (data.model?.modelId) model = { providerId: data.model.providerId, modelId: data.model.modelId, protocol: data.model.protocol ?? model?.protocol, reasoning: data.model.reasoning };
      open.set(data.requestId, { seq, at: record.time, startedAt: Number.isFinite(data.message?.timestamp) ? data.message.timestamp : Date.parse(record.time), model: model && { ...model }, contextDigest: data.contextDigest ?? null, prefixHash: data.cache?.prefixHash ?? data.message?.contextPrefixHash ?? null, prefixTokens: positive(data.message?.contextPrefixTokens), purpose: data.purpose ?? null, groups });
    } else if (type === 'request_completed') {
      const started = open.get(data.requestId); open.delete(data.requestId);
      const message = data.message;
      if (data.discarded !== true) note(message);
      if (!started || data.discarded === true || message?.usageReported !== true || ['error', 'aborted'].includes(message.stopReason)) continue;
      const served = { ...started, promptTokens: promptOf(message.usage) };
      if (!started.purpose) requests.push(served);
      lastServed = served; edits = 0; groups++;
    } else if (type === 'model_change') model = { providerId: data.to?.providerId, modelId: data.to?.modelId, protocol: model?.protocol, reasoning: model?.reasoning };
    else if (EDIT_RECORDS.has(type)) {
      edits++;
      if (type === 'context_rewind') {
        groups = 0;
        const cut = order.indexOf(data.beforeMessageId);
        if (cut >= 0) { for (const id of order.splice(cut)) present.delete(id); boundaries = boundaries.filter(row => present.has(row.throughMessageId)); }
      }
    }
    else if (type === 'compaction_request_started') pending = { seq, requestId: data.requestId, model: model && { providerId: model.providerId, modelId: model.modelId } };
    else if (type === 'compaction_request_completed') { if (pending?.requestId === data.requestId) pending = null; }
    else if (type === 'context_compaction') {
      if (data.automatic === true && data.trigger !== 'idle' && !data.preparedId && pending && typeof data.summary === 'string' && typeof data.throughMessageId === 'string')
        compactions.push({ seq: pending.seq, compactionSeq: seq, compactionId: data.id, at: record.time, throughMessageId: data.throughMessageId, trigger: data.trigger ?? null, beforeTokens: positive(data.beforeTokens), archivedMessages: data.archivedMessages ?? null, flatModel: pending.model, flatSummaryChars: data.summary.length, lastServed, editsSinceServed: edits });
      if (typeof data.throughMessageId === 'string') boundaries.push({ seq, throughMessageId: data.throughMessageId });
      groups = 0;
    }
  }
  return { header, compactions, requests, closedBefore: boundaries.at(-1)?.seq ?? null };
}

/**
 * The candidate points of one journal: GLM conversation state, a size in range, in a span the live conversation has
 * moved past (before `closedBefore`): a point in its current span would warm the very prefix its next request
 * extends, and that request would then read the probe's warmth as cache survival (a warm sample over a long gap).
 * A compaction point is one GLM ran; a compaction another model ran on a GLM conversation (1484f7e9's third: the
 * model had just switched to GPT, whose window chose the boundary) is a large-context point at the same state.
 * `size` is request A's prompt as recorded.
 */
export function journalPoints(scan, { sessionId, projectId }, range = PROBE_CONTEXT) {
  const within = size => Number.isFinite(size) && size >= range.min && size <= range.max;
  const closed = seq => Number.isFinite(scan.closedBefore) && seq < scan.closedBefore;
  const compactions = [], demoted = [];
  for (const row of scan.compactions) {
    if (!row.lastServed || !isGlm(row.lastServed.model) || !closed(row.seq)) continue;
    const size = row.beforeTokens ?? row.lastServed.promptTokens;
    if (!within(size)) continue;
    const reference = { prefixHash: row.lastServed.prefixHash, prefixTokens: row.lastServed.prefixTokens, promptTokens: row.lastServed.promptTokens, startedAt: row.lastServed.startedAt };
    if (isGlm(row.flatModel)) compactions.push({ id: `${sessionId.slice(0, 8)}-c${row.seq}`, kind: 'compaction', sessionId, projectId, seq: row.seq, at: row.at, size, model: row.lastServed.model, reference,
      compaction: { seq: row.compactionSeq, id: row.compactionId, throughMessageId: row.throughMessageId, trigger: row.trigger, archivedMessages: row.archivedMessages, flatModel: row.flatModel, flatSummaryChars: row.flatSummaryChars, editsSinceServed: row.editsSinceServed } });
    else demoted.push({ id: `${sessionId.slice(0, 8)}-r${row.seq}`, kind: 'context', sessionId, projectId, seq: row.seq, at: row.at, size, model: row.lastServed.model, reference: { ...reference, contextDigest: null },
      demoted: { compactionId: row.compactionId, model: row.flatModel?.modelId ?? null } });
  }
  const requests = scan.requests.filter(row => isGlm(row.model) && within(row.promptTokens) && row.groups >= 3 && closed(row.seq)).map(row => ({ id: `${sessionId.slice(0, 8)}-r${row.seq}`, kind: 'context', sessionId, projectId, seq: row.seq, at: row.at, size: row.promptTokens, model: row.model,
    reference: { prefixHash: row.prefixHash, prefixTokens: row.prefixTokens, promptTokens: row.promptTokens, startedAt: row.startedAt, contextDigest: row.contextDigest } }));
  return { compactions, requests: [...demoted, ...requests] };
}

/** Planning tokens of request C on a compaction point (FLAT_SHARE of the context and a typical summary). */
export const flatEstimate = point => Math.ceil(point.size * FLAT_SHARE) + FLAT_OUTPUT_ESTIMATE;
/** Tokens of one point, for planning: A (unless the live cache is warm), B with a typical summary, and C on a compaction point. */
export function pointEstimate(point) {
  const input = Math.max(1, Math.ceil(point.size + (point.prefixDelta ?? 0)));
  return (point.warm ? 0 : input + WARMUP_OUTPUT_TOKENS) + input + FORK_INSTRUCTION_TOKENS + FORK_OUTPUT_ESTIMATE + (point.kind === 'compaction' ? flatEstimate(point) : 0);
}

/**
 * Real past automatic compactions first (newest first), then large-context points spread over four size bands
 * (round robin, newest first, one per session and band before a second), each only while the plan's estimate still
 * fits PLAN_SHARE of the budget: a point's worst case (input headroom, the whole output allowance) is about 1.25–1.4× its
 * estimate, and the hard cap stops before a request whose worst case would not fit. A large-context point of a session
 * closer than 15% in size to one already chosen is skipped (two recorded compactions are always distinct points).
 */
export function selectPoints({ compactions = [], requests = [] }, { points = PROBE_DEFAULTS.points, budgetTokens = PROBE_DEFAULTS.budgetTokens, range = PROBE_CONTEXT } = {}) {
  const chosen = [], budget = Math.floor(budgetTokens * PLAN_SHARE); let total = 0;
  const near = row => row.kind !== 'compaction' && chosen.some(item => item.sessionId === row.sessionId && Math.abs(item.size - row.size) <= 0.15 * Math.max(item.size, row.size));
  const take = row => { const estimate = pointEstimate(row); if (chosen.length >= points || total + estimate > budget || near(row)) return false; chosen.push({ ...row, estimate }); total += estimate; return true; };
  for (const row of [...compactions].sort((a, b) => String(b.at).localeCompare(String(a.at)))) take(row);
  const ratio = (range.max / range.min) ** (1 / 4), bands = Array.from({ length: 4 }, () => []);
  for (const row of [...requests].sort((a, b) => String(b.at).localeCompare(String(a.at)))) bands[Math.min(3, Math.floor(Math.log(row.size / range.min) / Math.log(ratio)))].push(row);
  for (let progress = true; progress && chosen.length < points;) {
    progress = false;
    for (const band of bands) {
      if (chosen.length >= points) break;
      const index = band.findIndex(row => !chosen.some(item => item.sessionId === row.sessionId && pointBand(item, range) === pointBand(row, range)) && !near(row) && total + pointEstimate(row) <= budget);
      const fallback = index >= 0 ? index : band.findIndex(row => !near(row) && total + pointEstimate(row) <= budget);
      if (fallback >= 0) { const [row] = band.splice(fallback, 1); if (take(row)) progress = true; }
    }
  }
  return { points: chosen, estimate: total };
}
const pointBand = (row, range) => Math.min(3, Math.floor(Math.log(row.size / range.min) / Math.log((range.max / range.min) ** (1 / 4))));

export class CompactionForkProbe {
  /**
   * `decisions`: the live DecisionService (raw JEV probe for coverage, secrets for redaction); `provider`: the model
   * stream, metered into `ledger` as purpose evaluation; `held()`: whether application maintenance holds new work;
   * `prefixFor(projectId, model)`: the project's provider-visible prefix (system prompt, tool declarations, cache scope)
   * as its runtime last published it (prompt-prefix-registry): the journal records messages, not the prompt or tools.
   */
  constructor(store, { decisions = null, provider = streamCompletion, now = Date.now, ledger = store?.usageLedger ?? null, held = () => false, prefixFor = publishedPrefix, range = PROBE_CONTEXT } = {}) {
    Object.assign(this, { store, decisions, provider, now, ledger, held: typeof held === 'function' ? held : () => false, prefixFor, range, job: null, controller: null, promise: null, inFlight: 0, sequence: 0, scans: new Map(), summaries: {} });
    // A journal copy a killed daemon left behind (materialize's cleanup never ran): nothing runs yet in this process.
    if (store?.file) this.clearScratch();
  }
  get running() { return Boolean(this.promise); }
  reportDir() { return probeRoot(this.store.file); }
  spendFile() { return join(this.reportDir(), 'spend.json'); }
  /** Where a point's journal copy lives while it is rebuilt: inside the probe's private folder, cleared at start. */
  scratchDir() { return join(this.reportDir(), 'scratch'); }
  clearScratch() { try { rmSync(this.scratchDir(), { recursive: true, force: true }); } catch { /* the next start tries again */ } }
  options(input = {}) {
    const integer = (value, fallback, min, max) => value === undefined ? fallback : Number.isSafeInteger(value) && value >= min && value <= max ? value : fail(`探针参数超出范围（${min}–${max}）`);
    const options = { points: integer(input.points, PROBE_DEFAULTS.points, 1, 10), budgetTokens: integer(input.budgetTokens, PROBE_DEFAULTS.budgetTokens, 1, PROBE_BUDGET_TOKENS) };
    if (input.projectId !== undefined) { if (typeof input.projectId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.projectId)) fail('projectId 无效'); options.projectId = input.projectId; }
    return options;
  }
  /** Conversation journals of live sessions (a deleted or deleting conversation is never read). */
  journals({ projectId } = {}) {
    const state = this.store.state, root = resolve(`${this.store.file}.rna`), out = [];
    for (const session of state.sessions ?? []) {
      if (session.kind === 'side' || projectId && session.projectId !== projectId || !sessionsLive(state, [session.id])) continue;
      const folder = join(root, session.id);
      let files = [];
      const recorded = session.runtime?.engine === 'rna' && typeof session.runtime.sessionFile === 'string' ? resolve(session.runtime.sessionFile) : null;
      if (recorded && dirname(recorded) === folder) files = [recorded];
      else try { files = readdirSync(folder).filter(name => name.endsWith('.rna.jsonl')).map(name => join(folder, name)); } catch { files = []; }
      for (const file of files) { try { if (statSync(file).isFile()) out.push({ sessionId: session.id, projectId: session.projectId ?? null, file }); } catch { /* gone */ } }
    }
    return out;
  }
  async scan(file) {
    const info = statSync(file), cached = this.scans.get(file);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.result;
    const result = await scanJournal(file);
    this.scans.set(file, { size: info.size, mtimeMs: info.mtimeMs, result });
    return result;
  }
  /** The configured model a point's conversation ran on (provider and model still configured, executable here), with the
   * recorded reasoning; null otherwise. Never its key. */
  modelFor(recorded) {
    if (!recorded?.providerId || !recorded?.modelId) return null;
    let model; try { model = resolveModel(this.store.state.configuration, { providerId: recorded.providerId, modelId: recorded.modelId }); } catch { return null; }
    if (model.execution !== 'rna' || model.usagePolicy === 'interactive_only' || model.protocol !== 'openai' && model.protocol !== 'anthropic') return null;
    return REASONING_VALUES.has(recorded.reasoning) ? { ...model, reasoning: recorded.reasoning } : model;
  }
  prefixOf(projectId, model) { try { const prefix = model ? this.prefixFor(projectId, model) : null; return prefix && typeof prefix.systemPrompt === 'string' && Array.isArray(prefix.tools) ? prefix : null; } catch { return null; } }
  /** Whether real usage shows the cache of `startedAt`'s request still warm: inside the largest gap the learned survival
   * saw warm for this model (warmMaxMs), never on a guess. */
  fresh(model, startedAt) {
    let learned = null; try { learned = this.ledger?.survival?.estimate?.(model) ?? null; } catch { learned = null; }
    return Number.isFinite(startedAt) && Number.isFinite(learned?.warmMaxMs) && this.now() - startedAt < learned.warmMaxMs;
  }
  /** The dry run: candidate points, the chosen ones with their estimates, the approval and the daily cap; no model call. */
  async plan(input = {}) { const { selection, ...plan } = await this.preview(input); return plan; }
  async preview(input = {}) {
    const options = this.options(input), compactions = [], requests = [], waiting = new Map();
    let journals = 0;
    // One model and prefix lookup per project and model (a journal holds thousands of served requests).
    const lookups = new Map(), lookup = point => {
      const key = [point.projectId, point.model.providerId, point.model.modelId, point.model.reasoning].join('|');
      if (!lookups.has(key)) { const model = this.modelFor(point.model), prefix = this.prefixOf(point.projectId, model); lookups.set(key, { model, prefix, prefixTokens: prefix ? prepareContext({ systemPrompt: prefix.systemPrompt, tools: prefix.tools }).prefixTokens : null }); }
      return lookups.get(key);
    };
    for (const journal of this.journals(options)) {
      let scan; try { scan = await this.scan(journal.file); } catch { continue; }
      journals++;
      const found = journalPoints(scan, journal, this.range);
      for (const point of [...found.compactions, ...found.requests]) {
        const { model, prefix, prefixTokens } = lookup(point);
        if (!model) continue;
        if (!prefix) { const key = `${point.projectId}|${model.modelId}`; waiting.set(key, { projectId: point.projectId, modelId: model.modelId, points: (waiting.get(key)?.points ?? 0) + 1 }); continue; }
        const enriched = { ...point, prefixSource: prefix.source ?? 'project', prefixFrom: prefix.fromProjectId ?? null, prefixDelta: point.reference.prefixTokens ? prefixTokens - point.reference.prefixTokens : 0, warm: point.kind === 'context' && Boolean(point.reference.contextDigest) && prefix.source !== 'other_project' && this.fresh(model, point.reference.startedAt) };
        (point.kind === 'compaction' ? compactions : requests).push(enriched);
      }
    }
    // Chosen within this run's budget and what is left of the approval, so a smaller budget probes fewer points.
    const approval = this.approval(), daily = realBudgetRemaining(this.store.state, { now: this.now() });
    const selection = selectPoints({ compactions, requests }, { points: options.points, budgetTokens: Math.min(options.budgetTokens, approval.remaining), range: this.range });
    const calls = selection.points.reduce((sum, point) => sum + (point.warm ? 0 : 1) + 1 + (point.kind === 'compaction' ? 1 : 0), 0);
    // Points rebuilt with another project's prefix answer (a) only: the text-only and coverage answers depend on the
    // prompt and tools, so they count for the gate only on the project's own (any request on GLM in that project publishes it).
    const borrowed = new Map();
    for (const point of selection.points.filter(row => row.prefixSource === 'other_project')) borrowed.set(point.projectId, { projectId: point.projectId, fromProjectId: point.prefixFrom, points: (borrowed.get(point.projectId)?.points ?? 0) + 1 });
    return { options, range: { ...this.range }, journals, candidates: { compactions: compactions.length, context: requests.length }, selected: selection.points.length, calls, estimate: selection.estimate,
      withinBudget: selection.estimate <= Math.min(options.budgetTokens, approval.remaining), approval, dailyRemaining: Number.isFinite(daily) ? daily : null,
      // Points with no published prefix on their model at all: any request on that model (a conversation turn or a
      // background run, in any project) publishes one; the journal alone does not hold the system prompt and tools.
      prefixMissing: [...waiting.values()], prefixBorrowed: [...borrowed.values()],
      points: selection.points.map(point => ({ id: point.id, kind: point.kind, sessionId: point.sessionId, projectId: point.projectId, at: point.at, model: point.model.modelId, size: point.size, prefix: point.prefixSource, prefixDelta: point.prefixDelta, warm: point.warm,
        ...(point.compaction ? { compaction: { id: point.compaction.id, trigger: point.compaction.trigger, archivedMessages: point.compaction.archivedMessages, flatModel: point.compaction.flatModel?.modelId ?? null, flatSummaryChars: point.compaction.flatSummaryChars, editsSinceServed: point.compaction.editsSinceServed } } : {}),
        ...(point.demoted ? { demoted: { ...point.demoted } } : {}),
        estimate: point.estimate, requests: { warmup: point.warm ? 0 : Math.ceil(point.size + point.prefixDelta) + WARMUP_OUTPUT_TOKENS, fork: Math.ceil(point.size + point.prefixDelta) + FORK_INSTRUCTION_TOKENS + FORK_OUTPUT_ESTIMATE, ...(point.kind === 'compaction' ? { flat: flatEstimate(point) } : {}) } })),
      selection };
  }
  /** Status; the dry-run plan is left to the caller. */
  status() { return { running: this.running, job: this.job ? structuredClone(this.job) : null, reports: this.reports(), approval: this.approval() }; }
  reports() { try { return readdirSync(this.reportDir()).filter(name => /^probe-.*\.json$/.test(name) && !name.endsWith('.summaries.json')).map(name => name.slice(0, -5)).sort().slice(-20); } catch { return []; } }
  report(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) fail('报告 ID 无效');
    let json, markdown;
    try { json = JSON.parse(readFileSync(join(this.reportDir(), `${id}.json`), 'utf8')); markdown = readFileSync(join(this.reportDir(), `${id}.md`), 'utf8'); } catch { fail('报告不存在', 404, 'replay_report_missing'); }
    if (json.phase === 'running' && !(this.running && this.job?.id === id)) { json.phase = 'interrupted'; markdown = probeMarkdown(json); }
    return { id, json, markdown };
  }
  // ------------------------------------------------------------- approval
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
  /** The approved total, what every run spent (a run its daemon lost mid-call counts that call at its worst case), and what is left. */
  approval() {
    const spend = this.readSpend(), approved = spend.approvals.length ? spend.approvals.reduce((sum, row) => sum + Math.max(0, Number(row.tokens) || 0), 0) : PROBE_BUDGET_TOKENS;
    const current = this.running ? this.job?.id : null;
    const spent = Object.entries(spend.jobs).reduce((sum, [id, row]) => sum + Math.max(0, Number(row.spentTokens) || 0) + (row.phase === 'running' && id !== current ? Math.max(0, Number(row.inFlightTokens) || 0) : 0), 0) + (current ? this.inFlight : 0);
    return { approved, spent, remaining: Math.max(0, approved - spent), approvals: spend.approvals.length, ...(spend.unreadable ? { unreadable: true } : {}) };
  }
  /** Start (202) with `approved: true`, within what is left of the approved total, today's real-token cap and the run's budget. */
  async start(input = {}) {
    if (input?.approved !== true) fail(`探针会调用 GLM 主模型并计费：需要 approved: true（用户已批准一次 5–10 个点、共 ${PROBE_BUDGET_TOKENS} token 的小额探测）。`, 400, 'replay_not_approved');
    if (this.running) fail('已有压缩分叉探针在运行。', 409, 'replay_running');
    if (Number.isSafeInteger(input.budgetTokens) && input.budgetTokens > PROBE_BUDGET_TOKENS) fail(`预算超过已批准的 ${PROBE_BUDGET_TOKENS} token，拒绝开始。`, 400, 'replay_over_budget');
    const unreadable = () => fail('探针批准与花费记录（compaction-fork-probe/spend.json）无法读取：拒绝开始，以免忘记此前的花费。', 409, 'replay_record_unreadable');
    if (this.approval().unreadable) unreadable();
    const plan = await this.preview(input);
    if (this.running) fail('已有压缩分叉探针在运行。', 409, 'replay_running');
    // What is left of the approval, read after the preview's await: a run that spent and ended meanwhile counts. From
    // here to `this.promise` nothing awaits, so no other start can slip in between.
    const before = this.approval();
    if (before.unreadable) unreadable();
    if (!plan.selected) fail(plan.candidates.compactions + plan.candidates.context ? `预算内放不下任何一个点（单次预算 ${plan.options.budgetTokens}，已批准额度剩余 ${before.remaining}）：拒绝开始。` : plan.prefixMissing.length ? '没有可探测的点：守护进程启动后还没有任何项目在 GLM 上发出过请求，没有可用的提示前缀（系统提示与工具声明不在会话日志里）。等一次后台工作或进行一轮对话后再预览。' : '没有可探测的 GLM 点（需要上下文在范围内的 GLM 会话）。', 409, 'replay_no_points');
    const budget = Math.min(plan.options.budgetTokens, before.remaining);
    if (plan.estimate > budget) {
      if (before.remaining < plan.options.budgetTokens) fail(`已批准的探针额度剩余 ${before.remaining} token（共批准 ${before.approved}，此前已用 ${before.spent}），不足估算的 ${plan.estimate}：拒绝开始；减少 --points。`, 409, 'replay_approval_spent');
      fail(`估算 ${plan.estimate} token 超过预算 ${plan.options.budgetTokens}，拒绝开始；减少 --points。`, 400, 'replay_estimate_over_budget');
    }
    const daily = realBudgetRemaining(this.store.state, { now: this.now() });
    if (plan.estimate > daily) fail(`今天的真实模型 token 限额只剩 ${daily}，不足探针估算的 ${plan.estimate}：拒绝开始。`, 409, 'replay_daily_cap');
    const id = `probe-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`, stamp = new Date(this.now()).toISOString();
    const spend = this.readSpend();
    if (!spend.approvals.length) spend.approvals.push({ at: stamp, tokens: PROBE_BUDGET_TOKENS, kind: 'initial', note: 'user decision 2026-10-05 (C5 GLM compaction-fork probe, 5–10 points)', jobId: id });
    this.clearScratch();
    this.controller = new AbortController(); this.inFlight = 0; this.summaries = {};
    this.job = { id, phase: 'running', startedAt: stamp, options: plan.options, range: plan.range, budgetTokens: budget, approval: { approved: before.approved, spentBefore: before.spent }, estimate: plan.estimate, spentTokens: 0, jevTokens: 0, done: 0, calls: plan.calls,
      points: plan.selection.points.map(point => this.pointRecord(point)) };
    spend.jobs[id] = { startedAt: stamp, budgetTokens: budget, spentTokens: 0, inFlightTokens: 0, phase: 'running', updatedAt: stamp };
    try { this.writeSpend(spend); } catch { fail('无法记录探针批准与花费，拒绝开始。', 500, 'replay_record_failed'); }
    const points = plan.selection.points;
    this.promise = this.run(points, this.controller.signal).catch(error => { this.job.phase = 'failed'; this.job.error = String(error?.message ?? error).slice(0, 300); }).finally(() => { this.promise = null; this.controller = null; this.inFlight = 0; this.finish(); this.write(); });
    this.write();
    return structuredClone(this.job);
  }
  cancel() { if (!this.running) return { cancelled: false }; this.controller.abort(); return { cancelled: true }; }
  async close() { this.controller?.abort(); await this.promise?.catch(() => {}); }
  pointRecord(point) {
    return { id: point.id, kind: point.kind, sessionId: point.sessionId, projectId: point.projectId, at: point.at, model: { providerId: point.model.providerId, modelId: point.model.modelId, reasoning: point.model.reasoning ?? null }, size: point.size, estimate: point.estimate, prefix: { source: point.prefixSource ?? 'project' },
      ...(point.compaction ? { compaction: { id: point.compaction.id, trigger: point.compaction.trigger, archivedMessages: point.compaction.archivedMessages, flatModel: point.compaction.flatModel?.modelId ?? null, flatSummaryChars: point.compaction.flatSummaryChars, editsSinceServed: point.compaction.editsSinceServed } } : {}),
      ...(point.demoted ? { demoted: { ...point.demoted } } : {}),
      status: 'pending', warmup: null, fork: null, flat: null, coverage: null, tokens: 0 };
  }
  finish() {
    if (!this.job) return;
    if (this.job.phase === 'running') this.job.phase = 'completed';
    this.job.finishedAt = new Date(this.now()).toISOString();
    this.job.summary = summarizeProbe(this.job);
  }
  async run(points, signal) {
    const records = new Map(this.job.points.map(row => [row.id, row]));
    const stop = (phase, reason) => { this.job.phase = phase; this.job.stopReason = reason; };
    for (const [index, point] of points.entries()) {
      if (signal.aborted) break;
      const record = records.get(point.id);
      // What the points still to come are planned to cost: an optional request (the flat request C on a large-context
      // point) is sent only when it leaves them their share of the budget.
      const later = points.slice(index + 1).reduce((sum, row) => sum + (Number(row.estimate) || 0), 0);
      const outcome = await this.probePoint(point, record, signal, { later });
      this.write();
      if (outcome?.stop) { stop(outcome.stop, outcome.reason); break; }
    }
    if (signal.aborted && this.job.phase === 'running') this.job.phase = 'cancelled';
    for (const record of records.values()) if (record.status === 'pending' || record.status === 'running') record.status = this.job.phase === 'running' ? 'skipped' : 'not_run';
  }
  /** The point's live conversation, model, prefix and key, or why it is skipped. */
  resolvePoint(point) {
    if (!sessionsLive(this.store.state, [point.sessionId])) return { skip: 'session_deleted' };
    const model = this.modelFor(point.model);
    if (!model) return { skip: 'model_unavailable' };
    const prefix = this.prefixOf(point.projectId, model);
    if (!prefix) return { skip: 'prefix_unavailable' };
    const provider = this.store.state.configuration.providers.find(row => row.id === model.providerId);
    const apiKey = provider ? this.store.configurationService.secret(provider.id, provider) : null;
    if (!apiKey) return { skip: 'key_missing' };
    const journal = this.journals({ projectId: point.projectId }).find(row => row.sessionId === point.sessionId);
    if (!journal) return { skip: 'journal_missing' };
    return { model, prefix, apiKey, journal };
  }
  /**
   * The requests at a point, built by the SDK on a truncated copy of the journal (records before the point's own
   * request record), and the summary on record for a compaction point. The copy lives in a private folder under the
   * probe's own (scratchDir, cleared at construction and at every start, so a copy a killed daemon left behind does not
   * stay), removed before this returns; the live journal is only read.
   */
  async materialize(point, { model, prefix, journal }) {
    mkdirSync(this.scratchDir(), { recursive: true, mode: 0o700 });
    // Real path: the journal must lie within its state directory, and the state folder may sit behind a symlink (macOS).
    const dir = realpathSync(mkdtempSync(join(this.scratchDir(), 'point-'))); chmodSync(dir, 0o700);
    const copy = join(dir, 'point.jsonl');
    let session = null;
    try {
      let header = null, recorded = null, buffer = '', written = 0;
      const fd = openSync(copy, 'w', 0o600), input = createReadStream(journal.file, { encoding: 'utf8' }), lines = createInterface({ input, crlfDelay: Infinity });
      try {
        // Whole records before the point's own request record (a journal record line starts with its sequence number).
        for await (const line of lines) {
          const seq = Number(/^\{"seq":(\d+),/.exec(line)?.[1] ?? NaN);
          if (!Number.isSafeInteger(seq)) continue;
          if (seq < point.seq) {
            if (seq === 1) { try { header = JSON.parse(line).data; } catch { header = null; } }
            buffer += `${line}\n`; written++;
            if (buffer.length > 1 << 20) { writeSync(fd, buffer); buffer = ''; }
            continue;
          }
          if (point.compaction && seq === point.compaction.seq) { try { const data = JSON.parse(line).data; recorded = { summary: typeof data?.summary === 'string' ? data.summary : null, sourceDigest: data?.sourceDigest ?? null }; } catch { recorded = null; } }
          if (!point.compaction || seq >= point.compaction.seq) break;
        }
        if (buffer) writeSync(fd, buffer);
      } finally { lines.close(); input.destroy(); closeSync(fd); }
      if (!header?.sessionId || !written) return { skip: 'journal_unreadable' };
      const tools = prefix.tools.map(tool => ({ ...tool, execute: async () => { throw new Error('The compaction-fork probe never runs a tool.'); } }));
      // The conversation's own cache scope (rna-runtime: project:<id>), whichever project's prefix stands in.
      const cacheScope = header.projectId ? `project:${header.projectId}` : prefix.cacheScope;
      session = await createSession({ sessionId: header.sessionId, projectId: header.projectId ?? undefined, cwd: dir, stateDir: dir, sessionFile: copy, model, systemPrompt: prefix.systemPrompt, tools, ...(cacheScope ? { cacheScope } : {}),
        autoCompaction: false, preparedCompactionFile: join(dir, 'none.json'), redactValues: this.decisions?.secrets?.() ?? [], provider: async function* () { throw new Error('The probe sends its requests itself.'); } });
      const requests = session.compactionRequests({ throughMessageId: point.compaction?.throughMessageId ?? null });
      return { requests, recorded };
    } finally {
      await session?.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }
  async probePoint(point, record, signal, { later = 0 } = {}) {
    record.status = 'running';
    const skip = reason => { record.status = 'skipped'; record.reason = reason; return null; };
    if (this.held()) return { stop: 'maintenance_stop', reason: 'maintenance' };
    const resolved = this.resolvePoint(point);
    if (resolved.skip) return skip(resolved.skip);
    let built;
    try { built = await this.materialize(point, resolved); } catch (error) { if (signal.aborted) return null; return skip(`rebuild_failed:${String(error?.code ?? error?.message ?? 'error').slice(0, 60)}`); }
    if (built.skip) return skip(built.skip);
    if (!built.requests) return skip('no_candidate');
    const { requests, recorded } = built, { model, apiKey } = resolved, { main, fork, flat } = requests;
    if (!fork.fits) return skip('window');
    // (c) fork and flat at the same boundary, both sent now: always on a compaction point GLM ran (the recorded boundary),
    // and on a large-context point (the boundary the next automatic compaction would pick) whenever the budget allows
    // it without taking the later points' planned share — one compaction point alone holds too few requests to reach
    // COVERAGE_MIN_REQUESTS (the first probe compared one).
    const required = point.kind === 'compaction';
    // The rebuilt main request against the live one: equal when the published prefix still matches the recorded one.
    const live = point.kind === 'context' ? { requestDigestMatches: main.contextDigest === point.reference.contextDigest } : { prefixMatches: main.cache.prefixHash === point.reference.prefixHash, continuous: requests.lastServed?.continuous === true, sourceDigestMatches: recorded?.sourceDigest ? requests.candidate.sourceDigest === recorded.sourceDigest : null };
    const warm = point.kind === 'context' ? live.requestDigestMatches && this.fresh(model, point.reference.startedAt) : live.continuous && this.fresh(model, requests.lastServed?.timestamp);
    const sameStart = JSON.stringify(fork.messages.slice(0, main.messages.length)) === JSON.stringify(main.messages) && fork.systemPrompt === main.systemPrompt && JSON.stringify(fork.tools) === JSON.stringify(main.tools);
    Object.assign(record, { prefix: { source: resolved.prefix.source ?? 'project', ...(resolved.prefix.fromProjectId ? { fromProjectId: resolved.prefix.fromProjectId } : {}) }, live, rebuilt: { mainEstimate: main.estimatedInputTokens, forkEstimate: fork.estimatedInputTokens, flatEstimate: flat.estimatedInputTokens, prefixIdentical: sameStart, archivedMessages: requests.candidate.archivedMessages, userRequests: requests.requests?.length ?? 0, toolChoice: fork.toolChoice ?? null } });
    // Output allowances as live compaction sets them (summarize): the configured maximum, bounded by the window's room.
    const allowance = request => Math.max(1, Math.min(model.maxOutputTokens ?? 2048, model.contextWindow - request.estimatedInputTokens));
    const forkAllowance = allowance(fork), flatAllowance = allowance(flat);
    const ceilingA = warm ? 0 : ceilingOf(main, WARMUP_OUTPUT_TOKENS), ceilingB = ceilingOf(fork, forkAllowance), ceilingFlat = ceilingOf(flat, flatAllowance);
    const fits = (ceilings, reserve = 0) => this.job.spentTokens + this.inFlight + ceilings + reserve <= this.job.budgetTokens;
    // Hard cap: no request of a point starts unless all of them still fit at their worst case (a warm-up whose fork
    // cannot follow is waste, and so is a fork without the flat request its comparison needs). On a large-context point
    // the flat request is optional: it goes out only when it also leaves the later points their planned estimates.
    let compare = required || fits(ceilingA + ceilingB + ceilingFlat, later), ceilingC = compare ? ceilingFlat : 0;
    if (!fits(ceilingA + ceilingB + ceilingC)) { record.status = 'not_run'; record.reason = 'budget'; return { stop: 'budget_stop', reason: 'budget' }; }
    if (warm) record.warmup = { status: 'skipped_warm', reference: point.kind === 'context' ? 'live request' : 'last served request', promptTokens: point.reference.promptTokens ?? promptOf(requests.lastServed?.usage) };
    else {
      const sent = await this.send(main, { model, apiKey, maxOutputTokens: WARMUP_OUTPUT_TOKENS, ceiling: ceilingA, signal, tag: 'warmup' });
      // The warm-up's own answer is never kept: only its usage, stop reason and timing.
      if (sent.result) { delete sent.result.text; sent.result.toolCalls = sent.result.toolCalls.length; }
      if (sent.stop) { record.status = sent.stop === 'cancelled' ? 'cancelled' : 'not_run'; record.reason = sent.reason; return sent.stop === 'cancelled' ? null : { stop: sent.stop, reason: sent.reason }; }
      record.tokens += sent.result.tokens;
      // The warm-up only has to put its prompt in the cache, and the provider reports the prompt it processed whether or not
      // the answer came out clean: a reply cut inside a reasoning or tool turn (the 1024-token allowance; the SDK reports
      // provider_protocol) still warmed it, so request B goes out. A failure with no reported prompt, or a cancellation,
      // warmed nothing.
      const warmed = sent.result.status === 'completed' || sent.result.status === 'failed' && !signal.aborted && warmedByUsage(sent.result.usage);
      record.warmup = { ...sent.result, warmed };
      if (!warmed) { record.status = signal.aborted ? 'cancelled' : 'failed'; record.reason = `warmup_${sent.result.code ?? sent.result.status}`; return null; }
    }
    // A warm-up that cost more than its estimate may leave the rest without room: stop before it, never after.
    // (An optional flat request is dropped, not the run, when the warm-up's cost leaves room for the fork alone.)
    if (!required && compare && !fits(ceilingB + ceilingC, later) && fits(ceilingB)) { compare = false; ceilingC = 0; }
    if (!fits(ceilingB + ceilingC)) { record.status = 'not_run'; record.reason = 'budget'; return { stop: 'budget_stop', reason: 'budget' }; }
    const sent = await this.send(fork, { model, apiKey, maxOutputTokens: forkAllowance, ceiling: ceilingB, signal, tag: 'fork' });
    if (sent.stop) { record.status = sent.stop === 'cancelled' ? 'cancelled' : 'not_run'; record.reason = sent.reason; return sent.stop === 'cancelled' ? null : { stop: sent.stop, reason: sent.reason }; }
    const result = sent.result; record.tokens += result.tokens;
    const shared = record.warmup?.status === 'skipped_warm' ? record.warmup.promptTokens : promptOf(record.warmup?.usage);
    const cached = result.usage && Number.isFinite(result.usage.cacheRead) ? result.usage.cacheRead : null;
    const rejection = rejectionOf(result);
    record.fork = { status: result.status, ...(result.code ? { code: result.code } : {}), stopReason: result.stopReason, usage: result.usage, estimated: result.estimated, tokens: result.tokens, ceiling: result.ceiling, latencyMs: result.latencyMs,
      sharedPrefixTokens: shared ?? null, cachedTokens: cached, hitRatio: shared && cached !== null ? round(cached / shared) : null,
      toolCalls: result.toolCalls.length, toolNames: [...new Set(result.toolCalls.map(call => call.name))].slice(0, 8), textOnly: result.status === 'completed' && !result.toolCalls.length, summaryChars: result.text.length, accepted: rejection === null, rejection };
    if (result.text.trim()) this.summaries[point.id] = { fork: result.text };
    if (result.status !== 'completed') { record.status = signal.aborted ? 'cancelled' : 'failed'; record.reason = `fork_${result.code ?? result.status}`; return null; }
    // B may have cost more than its ceiling (a reported usage over the estimate), so the room the pre-check left for C is
    // read again against what has actually been spent: C starts only if its worst case still fits the budget, like A and B.
    // An optional C is dropped and the run goes on; the one a compaction point's comparison needs stops the run.
    if (compare && !fits(ceilingC)) {
      if (required) { record.flat = { status: 'not_run', reason: 'budget' }; record.status = 'completed'; record.reason = 'flat_budget'; return { stop: 'budget_stop', reason: 'budget' }; }
      compare = false;
    }
    if (compare) {
      // Request C: the flattened record at the same boundary, with the effort live compaction gives it (internal work:
      // the provider default where usable; compaction is a shadow-only purpose, so no JEV verdict is applied).
      let effort = null; try { effort = (await reasoningFor({ decisions: null, configuration: this.store.state.configuration, project: null, model, purpose: 'compaction' })).reasoning; } catch { effort = null; }
      const flatModel = REASONING_VALUES.has(effort) ? { ...model, reasoning: effort } : model;
      const sentC = await this.send(flat, { model: flatModel, apiKey, maxOutputTokens: flatAllowance, ceiling: ceilingC, signal, tag: 'flat' });
      if (sentC.stop) { record.flat = { status: 'not_run', reason: sentC.reason }; record.status = sentC.stop === 'cancelled' ? 'cancelled' : 'completed'; record.reason = `flat_${sentC.reason}`; return sentC.stop === 'cancelled' ? null : { stop: sentC.stop, reason: sentC.reason }; }
      const answer = sentC.result, flatRejection = rejectionOf(answer); record.tokens += answer.tokens;
      record.flat = { status: answer.status, ...(answer.code ? { code: answer.code } : {}), stopReason: answer.stopReason, usage: answer.usage, estimated: answer.estimated, tokens: answer.tokens, ceiling: answer.ceiling, latencyMs: answer.latencyMs, reasoning: flatModel.reasoning ?? null, summaryChars: answer.text.length, accepted: flatRejection === null, rejection: flatRejection };
      if (answer.text.trim()) this.summaries[point.id] = { ...this.summaries[point.id], flat: answer.text };
      // Only summaries live compaction would commit are compared (a rejected one falls back or fails there).
      record.coverage = await this.coverage(requests.requests, { fork: rejection === null ? result.text : null, flat: flatRejection === null ? answer.text : null, recorded: recorded?.summary ?? null }, signal);
    }
    record.status = 'completed';
    return null;
  }
  /** The model stream, metered (purpose evaluation, detail compaction-fork-probe, no project, no session, no keep-alive:
   * neither the conversation's warmth nor the learned survival hears of it) and observed. */
  observe() {
    const seen = { usage: null, stopReason: null, streamed: 0, estimatedInput: null, sent: false };
    const base = this.ledger ? meteredProvider(this.provider, { ledger: this.ledger, purpose: 'evaluation', keepAlive: null }) : this.provider;
    const stream = async function* (input) {
      seen.sent = true;
      if (Number.isFinite(input?.estimatedInputTokens)) seen.estimatedInput = Math.ceil(input.estimatedInputTokens);
      for await (const event of base({ ...input, purposeDetail: PROBE_DETAIL })) { if (event.type === 'usage') seen.usage = event.usage; else if (event.type === 'done') seen.stopReason = event.stopReason; else if (event.type === 'text_delta' || event.type === 'thinking_delta') seen.streamed += Buffer.byteLength(String(event.delta ?? '')); yield event; }
    };
    return { seen, stream };
  }
  /**
   * One request: reserved at its worst case against the daily cap and recorded in spend.json before it is sent — a
   * reservation that cannot be recorded (a full disk, an unreadable file) sends nothing, so a crash or a failed write can
   * never hand the approval out a second time. Then charged: reported usage, or its worst case when the request went out
   * and reported none (a provider may bill a stream the client gave up on); the ledger and the daily cap keep their estimate.
   */
  async send(request, { model, apiKey, maxOutputTokens, ceiling, signal, tag }) {
    if (signal.aborted) return { stop: 'cancelled', reason: 'cancelled' };
    if (this.held()) return { stop: 'maintenance_stop', reason: 'maintenance' };
    const key = `fork-probe:${this.job.id}:${++this.sequence}`;
    try { this.store.mutate(state => { reserveRealTokens(state, key, ceiling, { now: this.now() }); }); }
    catch (error) { if (error?.code === 'budget') return { stop: 'budget_stop', reason: 'daily_cap' }; throw error; }
    this.inFlight += ceiling;
    try { this.recordSpend(); }
    catch {
      this.inFlight -= ceiling;
      try { this.store.mutate(state => { releaseRealTokens(state, key, { now: this.now() }); }); } catch { /* charged at the next start (budget-service) */ }
      return { stop: 'record_failed', reason: 'record_failed' };
    }
    this.writeReports();
    const { seen, stream } = this.observe(), started = performance.now();
    let text = '', toolCalls = [], status = 'completed', code = null;
    try {
      for await (const event of iterateCompletion(stream, { model, apiKey, systemPrompt: request.systemPrompt, messages: request.messages, tools: request.tools, ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}), maxOutputTokens, signal, cache: request.cache, estimatedInputTokens: request.estimatedInputTokens })) {
        if (event.type === 'text_delta') text += String(event.delta ?? '');
        else if (event.type === 'tool_call') toolCalls.push({ name: String(event.name ?? event.toolCall?.name ?? '') });
      }
    } catch (error) { status = signal.aborted ? 'cancelled' : 'failed'; code = signal.aborted ? 'cancelled' : typeof error?.code === 'string' ? error.code : 'provider_error'; }
    const estimate = seen.usage ? tokensOf(seen.usage) : (seen.estimatedInput ?? request.estimatedInputTokens ?? 0) + Math.ceil(seen.streamed / 3);
    const charged = seen.usage ? estimate : seen.sent ? ceiling : 0;
    this.inFlight -= ceiling;
    try { this.store.mutate(state => { releaseRealTokens(state, key, { now: this.now() }); chargeRealTokens(state, estimate, { estimated: !seen.usage, now: this.now() }); }); } catch { /* the reservation is charged at the next start (budget-service) */ }
    this.job.spentTokens += charged; this.job.done++;
    // A failed write here leaves this request on record at its worst case; the next request's record must succeed first.
    try { this.recordSpend(); } catch { /* see above */ }
    const secrets = this.decisions?.secrets?.() ?? [];
    return { result: { tag, status, ...(code ? { code } : {}), stopReason: seen.stopReason, usage: compactUsage(seen.usage), estimated: !seen.usage, tokens: charged, ...(seen.usage ? {} : { estimatedTokens: estimate }), ceiling, promptTokens: promptOf(seen.usage), latencyMs: Math.round(performance.now() - started), text: redact(text, [apiKey, ...secrets].filter(Boolean)), toolCalls } };
  }
  /**
   * Coverage of each summary over the user's requests up to the boundary (SDK compactionRequests.requests): A3's
   * summary.coverage questions on one checkpoint and one request per call, through the raw probe, at the labelled
   * thresholds. A request counts when it asks for something of its own (substantive, judged beside the fork's
   * checkpoint, else the flat one's); fork and flat are compared request by request (losses: kept by flat, not by
   * fork). The summary on record is judged as a reference only.
   */
  async coverage(requests, summaries, signal) {
    const rows = (requests ?? []).filter(row => typeof row?.text === 'string' && row.text.trim()).slice(-COVERAGE_REQUESTS);
    const thresholds = { ...DECISION_THRESHOLDS.points['summary.coverage'] };
    const empty = extra => ({ requests: rows.length, substantive: 0, compared: 0, fork: null, flat: null, recorded: null, losses: 0, gains: 0, atLeastAsGood: null, thresholds, rows: [], ...extra });
    // No message of the user's own before the boundary (tool work only): nothing for a summary to keep.
    if (!rows.length) return empty({ reason: 'no_user_request' });
    const names = ['fork', 'flat', 'recorded'].filter(name => typeof summaries[name] === 'string' && summaries[name].trim());
    if (typeof this.decisions?.probe !== 'function') return empty({ unchecked: 'no_judge' });
    if (!names.includes('fork') || !names.includes('flat')) return empty({ unchecked: 'summary_rejected' });
    const secrets = this.decisions.secrets?.() ?? [], questions = wireQuestions(summaryCoverageTemplate());
    const judged = rows.map(row => ({ id: row.id, inSpan: row.inSpan === true, p: {}, kept: {}, substantive: {} }));
    const ask = async (index, name) => {
      signal.throwIfAborted();
      const state = redact(buildDecisionState('summary.coverage', { checkpoint: summaries[name], request: rows[index].text }), secrets);
      let body = null;
      for (let attempt = 0; attempt < 2 && !(body?.status === 200 && body.answers); attempt++) { try { body = await this.decisions.probe({ state, questions }); } catch { body = null; } }
      if (body?.status !== 200 || !body.answers) return;
      this.job.jevTokens += Math.max(0, Number(body.usage?.input_tokens) || 0) + Math.max(0, Number(body.usage?.output_tokens) || 0);
      const verdict = combineSummaryCoverage(answersOf(body.answers, questions));
      if (verdict.kept !== null) { judged[index].p[name] = verdict.probabilities.kept; judged[index].kept[name] = verdict.kept; }
      if (verdict.substantive !== null) judged[index].substantive[name] = { p: verdict.probabilities.substantive, counts: verdict.substantive };
    };
    try { await pool(rows.flatMap((_, index) => names.map(name => () => ask(index, name))), COVERAGE_CONCURRENCY); }
    catch { return empty({ unchecked: signal.aborted ? 'cancelled' : 'judge_failed' }); }
    const vote = row => row.substantive.fork ?? row.substantive.flat ?? row.substantive.recorded ?? null;
    const substantive = judged.filter(row => vote(row)?.counts === true);
    const tally = name => names.includes(name) ? { answered: substantive.filter(row => name in row.kept).length, kept: substantive.filter(row => row.kept[name] === true).length } : null;
    const compared = substantive.filter(row => 'fork' in row.kept && 'flat' in row.kept);
    const complete = judged.every(row => vote(row) !== null) && compared.length === substantive.length;
    const losses = compared.filter(row => row.kept.flat && !row.kept.fork).length, gains = compared.filter(row => row.kept.fork && !row.kept.flat).length;
    return { requests: rows.length, substantive: substantive.length, compared: compared.length, fork: tally('fork'), flat: tally('flat'), recorded: tally('recorded'), losses, gains,
      atLeastAsGood: complete && substantive.length ? gains >= losses : null, thresholds, ...(complete && !substantive.length ? { reason: 'no_substantive_request' } : {}),
      rows: judged.map(row => ({ id: row.id, inSpan: row.inSpan, substantive: round(vote(row)?.p ?? null), fork: round(row.p.fork ?? null), flat: round(row.p.flat ?? null), recorded: round(row.p.recorded ?? null) })) };
  }
  /** This job's spend line (spent, the worst case in flight, phase) into spend.json; throws when it cannot be recorded. */
  recordSpend() {
    const spend = this.readSpend();
    if (spend.unreadable) throw Object.assign(new Error('The probe spend record is unreadable.'), { code: 'record_unreadable' });
    spend.jobs[this.job.id] = { ...(spend.jobs[this.job.id] ?? {}), startedAt: this.job.startedAt, budgetTokens: this.job.budgetTokens, spentTokens: this.job.spentTokens, inFlightTokens: this.inFlight, phase: this.job.phase, updatedAt: new Date(this.now()).toISOString() };
    this.writeSpend(spend);
  }
  /** The spend line first, then progress (a crash keeps it) and the fork summaries beside it (never in the report). */
  write() {
    if (!this.job) return;
    try { this.recordSpend(); } catch { /* send() refuses the next request until it can be recorded */ }
    this.writeReports();
  }
  writeReports() {
    if (!this.job) return;
    try {
      mkdirSync(this.reportDir(), { recursive: true, mode: 0o700 });
      writeFileSync(join(this.reportDir(), `${this.job.id}.json`), JSON.stringify(this.job, null, 2), { mode: 0o600 });
      writeFileSync(join(this.reportDir(), `${this.job.id}.md`), probeMarkdown(this.job), { mode: 0o600 });
      // A conversation deleted while its point was probed: its deletion already purged the file, so its summaries
      // are not written back.
      const owners = new Map(this.job.points.map(point => [point.id, point.sessionId]));
      for (const id of Object.keys(this.summaries)) if (!sessionsLive(this.store.state, [owners.get(id)])) delete this.summaries[id];
      const file = join(this.reportDir(), `${this.job.id}.summaries.json`);
      if (Object.keys(this.summaries).length) writeFileSync(file, JSON.stringify(this.summaries, null, 2), { mode: 0o600 });
      else rmSync(file, { force: true });
    } catch { /* the in-memory job still answers status */ }
  }
}
/** What live compaction would do with an answer (generateSummary): a tool call, a truncation, no text or an oversized
 * one is rejected (a fork falls back once to the flattened record). */
const rejectionOf = result => result.status !== 'completed' ? result.code ?? result.status : result.toolCalls.length ? 'tool_call' : result.stopReason === 'length' ? 'truncated' : !result.text.trim() ? 'empty' : Buffer.byteLength(result.text) > MAX_SUMMARY_BYTES ? 'too_large' : null;

/**
 * The answers over every measured point and the gate for switching `compat.compactionFork` on for GLM:
 * - (a) cache: every measured fork reads at least FORK_HIT_RATIO of its shared prefix (A's prompt), on any point —
 *   A and B share whichever prefix stands in;
 * - (b) text only: no fork calls a tool or is otherwise rejected, on any point; and at least one fork was measured with
 *   its own project's prompt and tools (a stand-in prefix shows nothing about what the real ones invite);
 * - (c) coverage on GLM compaction points and on large-context points where the flat request was sent too: no compared point where the fork keeps fewer substantive requests than
 *   the flat summary, every point with requests compared, and at least COVERAGE_MIN_REQUESTS substantive requests
 *   compared on points with their own project's prefix;
 * - nothing failed or was skipped, and the run completed.
 */
export function summarizeProbe(job) {
  const points = job.points ?? [], measured = points.filter(row => row.fork && row.fork.status === 'completed');
  const own = row => row.prefix?.source !== 'other_project';
  const ratios = measured.map(row => row.fork.hitRatio).filter(Number.isFinite).sort((a, b) => a - b);
  const cache = { points: ratios.length, median: ratios.length ? ratios[Math.floor((ratios.length - 1) / 2)] : null, min: ratios.length ? ratios[0] : null, hits: ratios.filter(value => value >= FORK_HIT_RATIO).length, unmeasured: measured.length - ratios.length };
  const text = { points: measured.length, own: measured.filter(own).length, textOnly: measured.filter(row => row.fork.textOnly).length, toolCalls: measured.filter(row => row.fork.toolCalls > 0).length, rejected: measured.filter(row => !row.fork.accepted).length, rejections: Object.fromEntries([...new Set(measured.map(row => row.fork.rejection).filter(Boolean))].map(code => [code, measured.filter(row => row.fork.rejection === code).length])) };
  const prefix = { project: measured.filter(own).length, otherProject: measured.filter(row => !own(row)).length };
  // Points where fork and flat answer the same boundary: every compaction point, and a large-context point the flat request was sent on too.
  const compactions = measured.filter(row => row.kind === 'compaction' || row.kind === 'context' && row.coverage);
  const nothing = row => ['no_user_request', 'no_substantive_request'].includes(row.coverage?.reason);
  const judgeable = compactions.filter(row => !nothing(row)), compared = judgeable.filter(row => typeof row.coverage?.atLeastAsGood === 'boolean'), evidence = compared.filter(own);
  const sum = (rows, key) => rows.reduce((total, row) => total + (Number(row.coverage?.[key]) || 0), 0);
  const coverage = { points: compactions.length, own: compactions.filter(own).length, nothingToCompare: compactions.length - judgeable.length, compared: compared.length, atLeastAsGood: compared.filter(row => row.coverage.atLeastAsGood).length,
    requests: sum(evidence, 'compared'), losses: sum(compared, 'losses'), gains: sum(compared, 'gains'), minRequests: COVERAGE_MIN_REQUESTS, demoted: points.filter(row => row.demoted).length };
  const reasons = [...(measured.length ? [] : ['no_measured_points']), ...(cache.unmeasured ? ['cache_unmeasured'] : []), ...(ratios.some(value => value < FORK_HIT_RATIO) ? ['cache_miss'] : []),
    ...(text.toolCalls ? ['tool_calls'] : []), ...(text.rejected > text.toolCalls ? ['rejected_summary'] : []), ...(measured.length && !text.own ? ['text_only_unproven'] : []),
    ...(compared.length < judgeable.length ? ['coverage_unchecked'] : []), ...(coverage.atLeastAsGood < compared.length ? ['coverage_lower'] : []), ...(coverage.requests < COVERAGE_MIN_REQUESTS ? ['coverage_insufficient'] : []),
    ...(points.some(row => row.status === 'failed') ? ['point_failed'] : []), ...(points.some(row => row.status === 'skipped') ? ['point_skipped'] : []), ...(job.phase !== 'completed' ? ['run_incomplete'] : [])];
  return { cache, text, coverage, prefix, spent: { tokens: job.spentTokens ?? 0, jevTokens: job.jevTokens ?? 0 }, gate: { pass: reasons.length === 0, reasons, hitRatio: FORK_HIT_RATIO } };
}
const GATE_REASONS = { no_measured_points: 'no point was measured', cache_unmeasured: 'a fork reported no cache usage or its warm-up reported no prompt size', cache_miss: `a fork read less than ${FORK_HIT_RATIO} of its shared prefix from cache`,
  tool_calls: 'a fork called a tool', rejected_summary: 'a fork summary was truncated, empty or too large', text_only_unproven: 'no fork was measured with its own project\'s prompt and tools',
  coverage_unchecked: 'coverage could not be judged on every compaction point', coverage_lower: 'a fork summary kept fewer user requests than the flat one',
  coverage_insufficient: `fewer than ${COVERAGE_MIN_REQUESTS} substantive user requests were compared fork against flat on GLM points with their own project's prompt`,
  point_failed: 'a warm-up or fork request failed', point_skipped: 'a selected point was skipped (see its reason)', run_incomplete: 'the run stopped before every point was probed' };
const cell = value => value === null || value === undefined ? '–' : String(value);
const kept = (tally, of) => tally ? `${tally.kept}/${of}` : 'unchecked';
/** The research report: per-point numbers and aggregates, never prompts or model text (the fork and flat summaries sit
 * in `<id>.summaries.json` beside it, private to the state directory). */
export function probeMarkdown(job) {
  const s = job.summary;
  const rows = (job.points ?? []).map(row => {
    const f = row.fork, w = row.warmup, c = row.coverage, flat = row.flat;
    const warm = !w ? '–' : w.status === 'skipped_warm' ? 'live cache' : w.status === 'completed' ? `sent (${cell(w.promptTokens)})` : w.warmed ? `sent (${cell(w.promptTokens)}; ${cell(w.code ?? w.status)}, warmed)` : w.status;
    const coverage = !c ? '–' : c.reason === 'no_user_request' ? 'no user request' : c.reason === 'no_substantive_request' ? 'no substantive request' : c.unchecked ? `unchecked (${c.unchecked})`
      : `${kept(c.fork, c.substantive)} / ${kept(c.flat, c.substantive)} (−${c.losses} +${c.gains}) / ${kept(c.recorded, c.substantive)}`;
    const flatCell = !flat ? '–' : flat.status === 'not_run' ? `not run (${flat.reason})` : `${cell(flat.stopReason)}${flat.rejection ? ` / ${flat.rejection}` : ''}, ${cell(flat.summaryChars)} chars`;
    const status = row.status === 'completed' && !row.reason ? '' : ` **${row.status}${row.reason ? `: ${row.reason}` : ''}**`;
    const kind = `${row.kind}${row.demoted ? ` (compaction ${row.demoted.compactionId?.slice(0, 8) ?? ''} by ${row.demoted.model ?? 'another model'})` : ''}${row.prefix?.source === 'other_project' ? ', stand-in prefix' : ''}`;
    return `| ${row.id}${status} | ${kind} | ${row.sessionId.slice(0, 8)} | ${String(row.at).slice(0, 16)} | ${cell(row.size)} | ${warm} | ${cell(f?.sharedPrefixTokens)} | ${cell(f?.cachedTokens)} | ${cell(f?.hitRatio)} | ${f ? `${f.toolCalls}${f.toolNames?.length ? ` (${f.toolNames.join(', ')})` : ''}` : '–'} | ${f ? `${cell(f.stopReason)}${f.rejection ? ` / ${f.rejection}` : ''}` : '–'} | ${cell(f?.summaryChars)} | ${flatCell} | ${coverage} | ${row.tokens ?? 0} |`;
  });
  const next = !s ? null : job.phase !== 'completed' ? `the run did not complete (${job.phase}): no decision; \`compat.compactionFork\` stays off for GLM.` : s.gate.pass ? 'switch `compat.compactionFork` on for GLM (C5).' : `keep \`compat.compactionFork\` off for GLM: ${s.gate.reasons.map(reason => GATE_REASONS[reason] ?? reason).join('; ')}.`;
  return [`# GLM compaction-fork probe (C5) — ${job.id}`, '',
    ...(next ? [`- **Next:** ${next}`] : []),
    `- Phase: ${job.phase}${job.stopReason ? ` (${job.stopReason})` : ''}${job.error ? ` (${job.error})` : ''}; started ${job.startedAt}${job.finishedAt ? `, finished ${job.finishedAt}` : ''}.`,
    `- Budget ${job.budgetTokens} tokens (approved in total ${job.approval?.approved ?? '–'}, spent before this run ${job.approval?.spentBefore ?? '–'}); estimate ${job.estimate}; spent ${job.spentTokens} (input + output + cache, as reported; a request that reported nothing is charged its worst case; usage ledger purpose evaluation / ${PROBE_DETAIL}, charged to the daily real-token cap); JEV ${job.jevTokens ?? 0}. Requests ${job.done}/${job.calls}.`,
    `- Request A rebuilds the main request at the point (SDK projection of the journal with the project's current prompt and tools) and warms the cache; request B is the SDK fork request; on a compaction point request C is the SDK flattened request at the same boundary (on a large-context point too, when the budget allows). Context range ${job.range?.min ?? PROBE_CONTEXT.min}–${job.range?.max ?? PROBE_CONTEXT.max} tokens.`, '',
    ...(s ? ['## Answers', '',
      `- (a) Cache: ${s.cache.hits}/${s.cache.points} forks read at least ${FORK_HIT_RATIO} of the shared prefix; median hit ratio ${cell(s.cache.median)}, lowest ${cell(s.cache.min)}${s.cache.unmeasured ? `; ${s.cache.unmeasured} unmeasured` : ''}.`,
      `- (b) Text only: ${s.text.textOnly}/${s.text.points} (${s.text.own ?? 0} with their own project's prompt and tools); tool calls on ${s.text.toolCalls}; rejected by the live checks ${s.text.rejected}${Object.keys(s.text.rejections).length ? ` (${Object.entries(s.text.rejections).map(([code, count]) => `${code} ${count}`).join(', ')})` : ''}.`,
      `- (c) Coverage (GLM compaction points and large-context points the flat request was sent on, fork vs a fresh flat request at the same boundary): fork kept at least as many substantive requests on ${s.coverage.atLeastAsGood}/${s.coverage.compared} compared points (${s.coverage.points} compaction points${s.coverage.nothingToCompare ? `, ${s.coverage.nothingToCompare} with nothing to compare` : ''}); ${s.coverage.requests} substantive requests compared with the project's own prompt (at least ${s.coverage.minRequests} needed); fork lost ${s.coverage.losses} and gained ${s.coverage.gains} against flat. Kept = P ≥ ${DECISION_THRESHOLDS.points['summary.coverage'].kept} and substantive = P ≥ ${DECISION_THRESHOLDS.points['summary.coverage'].substantive} (A3's labelled thresholds); the column also gives the summary on record, a reference outside the gate.${s.coverage.demoted ? ` ${s.coverage.demoted} recorded compactions another model ran count as large-context points.` : ''}`,
      ...(s.prefix?.otherProject ? [`- Prefix: ${s.prefix.otherProject} of ${s.prefix.project + s.prefix.otherProject} points were rebuilt with another project's published prompt and tools (none of their own was published since the daemon started): they answer (a) only.`] : []),
      `- **Gate:** ${s.gate.pass ? 'pass' : `not passed (${s.gate.reasons.map(reason => GATE_REASONS[reason] ?? reason).join('; ')})`}.`, ''] : []),
    '## Points', '',
    '| point | kind | session | at | context | warm-up (prompt) | shared prefix | cached | hit ratio | tool calls | stop / rejection | summary chars | flat request | coverage fork / flat (−lost +gained) / on record | tokens |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|', ...rows, ''].join('\n');
}
