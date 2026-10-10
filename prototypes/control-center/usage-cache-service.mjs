import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { streamCompletion, REASONING_VALUES } from '../../packages/sdk/src/providers.mjs';
import { normalizePurpose, purposeDetail, USAGE_PURPOSES } from '../../packages/sdk/src/prompt-layers.mjs';
import { cacheTtlMs, coldAfterMs, requestContinuity, survivalSample, survivalFromSamples, SURVIVAL_MAX_AGE_MS } from '../../packages/sdk/src/cache-survival.mjs';
import { readJournalRecords } from '../../packages/sdk/src/journal.mjs';
import { createHash } from 'node:crypto';
import { windowRange, within } from './metric-windows.mjs';

/** Provider prompt-cache lifetime (ms) of a request, or null when the provider documents none; one rule with the
 * SDK's cold-break economy (packages/sdk/src/cache-survival.mjs). */
export { cacheTtlMs };
export const requestPrefixKey = (request, projectId) => prefixKeyOf(request, projectId);
const prefixKeyOf = (request, projectId) => request?.cache?.prefixHash ? createHash('sha256').update(JSON.stringify([request.cache.sessionKey ?? projectId ?? null, request.cache.prefixHash, request.model?.providerId ?? null, request.model?.modelId ?? request.model?.id ?? null])).digest('hex').slice(0, 16) : undefined;
const modelKey = row => `${row.projectId ?? ''}|${row.providerId ?? ''}|${row.modelId ?? ''}`;

// Per-request provider cache receipts tagged with a contract purpose
// (docs/specs/stream-protocol-v2.md §5). Only counts are kept: no prompt,
// output, header or credential ever reaches this ledger.
export const CACHE_WINDOWS = Object.freeze({ '1h': 3600000, '24h': 86400000, '7d': 604800000 });
export const COLD_START_MIN_INPUT = 1024;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : Math.max(0, Math.floor(Number(value) || 0));
const text = (value, max = 160) => typeof value === 'string' && value ? value.slice(0, max) : undefined;

/** What started a compaction request (ledger rows of purpose compaction only). */
export const COMPACTION_TRIGGERS = Object.freeze(['idle', 'after_response', 'before_request', 'overflow', 'manual']);
/** A request's structural continuity with the session's previous served request (SDK `ledger.continuity`), validated. */
export function continuityRecord(value) {
  if (!value || typeof value !== 'object' || typeof value.continuous !== 'boolean') return undefined;
  const gapMs = Number(value.gapMs), previousPromptTokens = Number(value.previousPromptTokens);
  if (!Number.isFinite(gapMs) || gapMs < 0 || !Number.isFinite(previousPromptTokens) || previousPromptTokens < 0) return undefined;
  // `edited`: only the session's economy edits broke continuity; the part of the previous prompt before the first edit (ECON-2).
  const comparable = value.continuous === false && value.edited && typeof value.edited === 'object' ? Number(value.edited.comparableTokens) : NaN;
  return { continuous: value.continuous, gapMs: Math.round(gapMs), previousPromptTokens: Math.round(previousPromptTokens), ...(Number.isFinite(comparable) && comparable >= 0 && comparable <= previousPromptTokens ? { edited: { comparableTokens: Math.round(comparable) } } : {}), ...(value.bridged === true ? { bridged: true } : {}) };
}
const DROP_REASONS = { prefix_binding_mismatch: 'prefix', model_binding_mismatch: 'model', organization_binding_mismatch: 'organization' };
/** Anthropic preserved-thinking counts from one response's `input_transformations` (only non-zero keys), or undefined. */
export function thinkingDropCounts(items = []) {
  const counts = {};
  for (const item of Array.isArray(items) ? items : []) {
    const key = item?.type === 'thinking_mismatch_allowed' ? 'allowed' : item?.type === 'thinking_dropped' ? DROP_REASONS[item.reason] : undefined;
    if (key) counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.keys(counts).length ? counts : undefined;
}
const STOP_REASONS = new Set(['stop', 'length', 'toolUse', 'tool_use', 'error', 'aborted', 'content_filter', 'refusal', 'pause_turn']);
const DETAIL = /^[a-z][a-z0-9-]{0,39}$/;
/**
 * Normalize one request receipt. `cacheReported` false means unknown, never 0%. Optional (spec p1 effort §3.7):
 * `detail` (the raw purpose under its contract purpose: mind-capture, gene-author, decision-repair …), `reasoning`
 * (the effort sent), `reasoningTokens`, `stopReason`, `outputCap` (the request's output allowance), and for a request
 * that reported no usage: `estimated` (input from the request's estimate, output from what streamed), `aborted`,
 * `responded: false` (cancelled before its first byte). `estimatedOutput`: a request that reported usage but ended
 * before its final report (an Anthropic stream stopped mid-way reports output ≈ 1 at message_start): the output tokens
 * estimated from what streamed after the last report, already included in `output`.
 */
export function usageRecord({ at = Date.now(), purpose, projectId, sessionId, providerId, modelId, usage, prefixKey, ttlMs, cacheAligned, continuity, trigger, thinkingDropped, thinkingRecovery, keepAlive, detail, reasoning, stopReason, outputCap, estimated, aborted, responded, estimatedOutput } = {}) {
  const reported = usage?.cacheUsageReported === true, kind = normalizePurpose(purpose), linked = continuityRecord(continuity), named = typeof detail === 'string' && DETAIL.test(detail) ? detail : purposeDetail(purpose);
  return { at: new Date(at).toISOString(), purpose: kind, ...(text(projectId) ? { projectId: text(projectId) } : {}), ...(text(sessionId) ? { sessionId: text(sessionId) } : {}), ...(text(providerId) ? { providerId: text(providerId) } : {}), ...(text(modelId) ? { modelId: text(modelId) } : {}),
    input: count(usage?.input), output: count(usage?.output), cacheRead: count(usage?.cacheRead), cacheWrite: count(usage?.cacheWrite), cacheReported: reported,
    // Within the documented TTL of the previous request with the same prefix
    // (true), outside it or first (false), or no documented TTL (null).
    ...(typeof prefixKey === 'string' && /^[a-f0-9]{16}$/.test(prefixKey) ? { prefixKey } : {}), ...(Number.isSafeInteger(ttlMs) && ttlMs > 0 ? { ttlMs } : {}), ...(cacheAligned === true || cacheAligned === false || cacheAligned === null ? { cacheAligned } : {}),
    // Spec p1 compaction §A2: whether this request extended the session's previous one byte for byte, after how long, and how big that one was.
    ...(linked ? { continuity: linked } : {}), ...(kind === 'compaction' && COMPACTION_TRIGGERS.includes(trigger) ? { trigger } : {}),
    // Anthropic preserved thinking, only when something happened: blocks the API dropped (by cause) and how a
    // rejected request was recovered ('strip' resent without thinking, 'drop_block' resent with the drop setting).
    ...(thinkingDropped && typeof thinkingDropped === 'object' ? (counts => Object.keys(counts).length ? { thinkingDropped: counts } : {})(Object.fromEntries(['prefix', 'model', 'organization', 'allowed'].filter(key => Number.isSafeInteger(thinkingDropped[key]) && thinkingDropped[key] > 0).map(key => [key, thinkingDropped[key]]))) : {}),
    ...(['strip', 'drop_block'].includes(thinkingRecovery) ? { thinkingRecovery } : {}),
    // An idle prompt-cache keep-alive (cache-keepalive.mjs): a real, billed cache read, not a conversation request.
    ...(keepAlive === true ? { keepAlive: true } : {}),
    ...(named ? { detail: named } : {}), ...(REASONING_VALUES.has(reasoning) ? { reasoning } : {}), ...(Number.isSafeInteger(usage?.reasoningTokens) && usage.reasoningTokens >= 0 ? { reasoningTokens: usage.reasoningTokens } : {}),
    ...(STOP_REASONS.has(stopReason) ? { stopReason } : {}), ...(Number.isSafeInteger(outputCap) && outputCap > 0 ? { outputCap } : {}),
    ...(estimated === true ? { estimated: true } : {}), ...(aborted === true ? { aborted: true } : {}), ...(responded === false ? { responded: false } : {}),
    ...(estimated !== true && Number.isSafeInteger(estimatedOutput) && estimatedOutput > 0 ? { estimatedOutput } : {}) };
}

/**
 * Rollback safety (ACC-7). A release keeps only ledger rows whose `purpose` it knows, and its first prune rewrites the
 * file without the others. Purposes added after 0.66.0 are therefore stored under the purpose 0.66.0 itself recorded
 * those requests as (the narrator was metered as `initiative`, mind and gene calls normalized to `other`), with the
 * contract purpose in `group`; reading maps them back. An older release counts them as it always did and keeps them
 * (with `group`) through its rewrites, so nothing is lost on a rollback and later re-upgrade. Every purpose added to
 * USAGE_PURPOSES from now on needs an entry here.
 */
export const LEGACY_STORED_PURPOSES = Object.freeze({ narrator: 'initiative', mind: 'other', evolution: 'other' });
/** The row as written to the ledger file. */
export const storedUsageRow = row => Object.hasOwn(LEGACY_STORED_PURPOSES, row?.purpose) ? { ...row, purpose: LEGACY_STORED_PURPOSES[row.purpose], group: row.purpose } : row;
/** A row read from the ledger file, with its contract purpose. */
export function loadedUsageRow(row) {
  if (!row || typeof row !== 'object' || typeof row.group !== 'string') return row;
  const { group, ...rest } = row;
  return Object.hasOwn(LEGACY_STORED_PURPOSES, group) && row.purpose === LEGACY_STORED_PURPOSES[group] ? { ...rest, purpose: group } : row;
}
/** Every parseable row of a ledger file's text, with contract purposes (benchmarks read copies of it through this too). */
export const parseUsageLedger = text => String(text ?? '').split('\n').flatMap(line => { if (!line) return []; try { const row = loadedUsageRow(JSON.parse(line)); return row && typeof row === 'object' ? [row] : []; } catch { return []; } });

/**
 * Why a reported request re-billed prompt tokens its session's previous request had already sent (pi cache-stats.ts
 * detectMiss): the tokens missed are the smaller of the two prompts minus what was read from cache (for a request only
 * economy edits broke, the part of the previous prompt before the first edit), counted above pi's 1,024-token noise
 * floor. The cause comes from what the ledger knows: another model or prefix (system prompt and tools) than the
 * session's previous request, an edited or rewritten history (`continuity.continuous: false`), an idle gap at least as
 * long as the cache is known to live (documented TTL, else the learned survival), or a provider eviction (a continuous
 * request inside that time, or one keep-alive pings bridged). `unknown`: continuous, but no lifetime is known. A request
 * after a compaction or summary is new content, as pi resets at compaction; summaries themselves are not conversation
 * requests. Diagnostic only.
 */
export const MISS_REASONS = Object.freeze(['model', 'prefix', 'history_edit', 'history_rewrite', 'idle', 'eviction', 'unknown']);
export const MISS_NOISE_FLOOR_TOKENS = 1024;
const RESET_PURPOSES = new Set(['compaction', 'summary']);
export function cacheMiss(row, previous, { coldAfterMs = null } = {}) {
  const linked = row?.continuity;
  if (!linked || row.cacheReported !== true || row.keepAlive === true || CACHE_EXEMPT_PURPOSES.has(row.purpose) || RESET_PURPOSES.has(row.purpose)) return null;
  if (previous && RESET_PURPOSES.has(previous.purpose)) return null;
  const prompt = count(row.input) + count(row.cacheRead) + count(row.cacheWrite), expected = linked.continuous === false && linked.edited ? linked.edited.comparableTokens : linked.previousPromptTokens;
  const missed = Math.min(count(expected), prompt) - count(row.cacheRead);
  if (missed <= MISS_NOISE_FLOOR_TOKENS) return null;
  const changed = (a, b) => typeof a === 'string' && typeof b === 'string' && a !== b;
  const reason = previous && (changed(previous.providerId, row.providerId) || changed(previous.modelId, row.modelId)) ? 'model'
    : previous && changed(previous.prefixKey, row.prefixKey) ? 'prefix'
      : linked.continuous === false ? (linked.edited ? 'history_edit' : 'history_rewrite')
        : linked.bridged === true ? 'eviction'
          : Number.isFinite(coldAfterMs) && coldAfterMs > 0 ? (linked.gapMs >= coldAfterMs ? 'idle' : 'eviction') : 'unknown';
  return { reason, tokens: missed };
}
const validMiss = value => value && typeof value === 'object' && MISS_REASONS.includes(value.reason) && Number.isSafeInteger(value.tokens) && value.tokens > 0 ? { reason: value.reason, tokens: value.tokens } : undefined;

/** An idle compaction's session counts as returned when a foreground request of it follows within this long. */
export const IDLE_RETURN_WINDOW_MS = 7 * 86400000;
const PRUNE_BATCH_MS = 3600000;
/**
 * Outcome labels of two host actions, from the ledger alone (plan 2026-10-05 B7; they calibrate the keep-alive and
 * session.resume): a keep-alive ping `worth` when the session's next request after it was a conversation request that
 * read from cache (the ping bought that read), `wasted` when the next one was another ping, a summary or a request that
 * read nothing, `open` while nothing followed yet; an idle compaction `returned` when a conversation request of its
 * session follows within 7 days, `not_returned` once 7 days passed without one, `open` until then. `final`: the ledger
 * row is past the raw retention, so nothing more can follow (an open ping is then wasted). Returns Map row → label.
 */
export function outcomeLabels(rows, { now = Date.now(), final = new Set() } = {}) {
  const bySession = new Map(), out = new Map(), labeled = new Set();
  // Only conversations that have a ping or an idle summary need their rows in order.
  for (const row of rows) if (row.sessionId && (row.keepAlive === true || row.purpose === 'compaction' && row.trigger === 'idle')) labeled.add(row.sessionId);
  if (!labeled.size) return out;
  rows.forEach((row, index) => { if (labeled.has(row.sessionId) && !CACHE_EXEMPT_PURPOSES.has(row.purpose)) { if (!bySession.has(row.sessionId)) bySession.set(row.sessionId, []); bySession.get(row.sessionId).push(index); } });
  for (const list of bySession.values()) list.forEach((index, position) => {
    const row = rows[index];
    if (row.keepAlive === true) {
      const next = rows[list[position + 1]];
      out.set(row, !next ? (final.has(row) ? 'wasted' : 'open') : next.keepAlive !== true && next.purpose === 'foreground' && next.cacheReported === true && count(next.cacheRead) > 0 ? 'worth' : 'wasted');
    } else if (row.purpose === 'compaction' && row.trigger === 'idle') {
      const at = Date.parse(row.at);
      const returned = list.slice(position + 1).some(other => { const next = rows[other], when = Date.parse(next.at); return next.purpose === 'foreground' && next.keepAlive !== true && when > at && when <= at + IDLE_RETURN_WINDOW_MS; });
      out.set(row, returned ? 'returned' : final.has(row) || now >= at + IDLE_RETURN_WINDOW_MS ? 'not_returned' : 'open');
    }
  });
  return out;
}

/** Rollup key of a ledger row: counts are kept per local day and these fields (never the session). */
const rollupKey = row => ({ projectId: row.projectId, purpose: row.purpose, detail: row.detail, providerId: row.providerId, modelId: row.modelId, reasoning: row.reasoning, estimated: row.estimated === true, aborted: row.aborted === true, keepAlive: row.keepAlive === true, trigger: row.trigger });
/**
 * The additive numbers every usage report sums, the same for a raw row and for a rollup cell (a day's rows folded):
 * report buckets are accumulators of these, filled in one pass over the raw rows plus the rollup's cells.
 */
const NUMBERS = Object.freeze(['requests', 'reported', 'input', 'cacheRead', 'cacheWrite', 'rawInput', 'rawCacheRead', 'rawCacheWrite', 'output', 'reasoningTokens', 'lengthStops', 'covered', 'cold',
  'estimatedRequests', 'estimatedInput', 'estimatedOutput', 'partial', 'alignedSeen', 'aligned', 'outside', 'unknownTtl', 'pingWorth', 'pingWasted', 'pingOpen', 'returned', 'notReturned', 'returnOpen']);
const accumulator = () => { const acc = {}; for (const name of NUMBERS) acc[name] = 0; return acc; };
const reasoningGroup = (acc, effort) => (acc.byReasoning ??= {})[effort] ??= { requests: 0, input: 0, cacheRead: 0, output: 0, reasoningTokens: 0, estimatedInput: 0 };
const triggerGroup = (acc, trigger) => (acc.byTrigger ??= {})[COMPACTION_TRIGGERS.includes(trigger) ? trigger : 'unknown'] ??= { requests: 0, input: 0, output: 0 };
/**
 * Add one raw ledger row to an accumulator. `label`: outcomeLabels. Tokens and counts only: no price enters a report or a
 * rollup cell (the user decided on 2026-10-05 that the backend does not track real prices).
 */
function addRow(acc, row, label) {
  const reported = row.cacheReported === true, input = count(row.input), cacheRead = count(row.cacheRead), cacheWrite = count(row.cacheWrite), estimated = row.estimated === true, output = Number.isFinite(row.output) ? row.output : 0, reasoning = Number.isFinite(row.reasoningTokens) ? row.reasoningTokens : 0;
  acc.requests++; acc.rawInput += input; acc.rawCacheRead += cacheRead; acc.rawCacheWrite += cacheWrite; acc.output += output; acc.reasoningTokens += reasoning;
  if (reported) { acc.reported++; acc.input += input; acc.cacheRead += cacheRead; acc.cacheWrite += cacheWrite; if (cacheRead > 0) acc.covered++; else if (input + cacheWrite >= COLD_START_MIN_INPUT) acc.cold++; }
  if (row.stopReason === 'length') acc.lengthStops++;
  if (estimated) { acc.estimatedRequests++; acc.estimatedInput += input; acc.estimatedOutput += output; } else if (count(row.estimatedOutput) > 0) { acc.partial++; acc.estimatedOutput += count(row.estimatedOutput); }
  if (row.cacheAligned !== undefined) { acc.alignedSeen++; if (row.cacheAligned === true) acc.aligned++; else if (row.cacheAligned === false) acc.outside++; else if (row.cacheAligned === null) acc.unknownTtl++; }
  const miss = validMiss(row.miss);
  if (miss) { const value = (acc.miss ??= {})[miss.reason] ??= { n: 0, tokens: 0 }; value.n++; value.tokens += miss.tokens; }
  if (label === 'worth') acc.pingWorth++; else if (label === 'wasted') acc.pingWasted++; else if (label === 'returned') acc.returned++; else if (label === 'not_returned') acc.notReturned++; else if (label === 'open') { if (row.keepAlive === true) acc.pingOpen++; else acc.returnOpen++; }
  if (typeof row.reasoning === 'string') { const group = reasoningGroup(acc, row.reasoning); group.requests++; if (estimated) group.estimatedInput += input; else { group.input += input; group.cacheRead += cacheRead; } group.output += output; group.reasoningTokens += reasoning; }
  if (row.purpose === 'compaction') { const group = triggerGroup(acc, row.trigger); group.requests++; group.input += input; group.output += output; }
  return acc;
}
/**
 * Add one rollup cell (`k` its key, `v` its values) to an accumulator. Only the numbers this release keeps are read: a cell a
 * build before the 2026-10-05 decision folded may carry `cost`, `estimatedCost` and per-miss `amounts` (list-price cost), which are
 * ignored here, never summed or shown (and left in the file as they are until the day ages out of the rollup).
 */
function addCellTo(acc, k, v) {
  for (const name of NUMBERS) if (v[name]) acc[name] += v[name];
  for (const [reason, value] of Object.entries(v.miss ?? {})) { const target = (acc.miss ??= {})[reason] ??= { n: 0, tokens: 0 }; target.n += value?.n ?? 0; target.tokens += value?.tokens ?? 0; }
  if (typeof k.reasoning === 'string') { const group = reasoningGroup(acc, k.reasoning); group.requests += v.requests ?? 0; if (k.estimated) group.estimatedInput += v.rawInput ?? 0; else { group.input += v.rawInput ?? 0; group.cacheRead += v.rawCacheRead ?? 0; } group.output += v.output ?? 0; group.reasoningTokens += v.reasoningTokens ?? 0; }
  if (k.purpose === 'compaction') { const group = triggerGroup(acc, k.trigger); group.requests += v.requests ?? 0; group.input += v.rawInput ?? 0; group.output += v.output ?? 0; }
  return acc;
}
/** The rollup values of one row: its accumulator without zeros or what the key already says (effort, trigger). */
export function usageCellValues(row, { label } = {}) {
  const { byReasoning: _effort, byTrigger: _trigger, ...acc } = addRow(accumulator(), row, label);
  return Object.fromEntries(Object.entries(acc).filter(([, value]) => value !== 0 && value !== undefined));
}

export class UsageLedger {
  /**
   * `rollup` (a DailyRollup of kind 'usage', or null): before rows leave the 7-day ledger they are folded into it,
   * exactly once by its watermark. Tokens and counts only: no price is computed or kept.
   */
  constructor({ file, now = Date.now, retentionMs = CACHE_WINDOWS['7d'], maxRecords = 50000, survival = null, rollup = null } = {}) {
    this.file = file; this.now = now; this.retentionMs = retentionMs; this.maxRecords = maxRecords; this.rows = []; this.dropped = 0; this.lastPrefix = new Map(); this.lastModel = new Map(); this.lastSession = new Map(); this.lastPing = new Map(); this.lastCall = new Map(); this.survival = survival; this.listeners = new Set();
    this.rollup = rollup;
    if (file) {
      // Rows a build before the rollback-safe form wrote with a new purpose as is: rewritten at once in the stored form.
      let unsafe = false, folded = 0;
      const mark = rollup?.mark('usage') ?? null;
      try {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line) continue;
          try {
            const raw = JSON.parse(line), row = loadedUsageRow(raw);
            if (!row || typeof row.at !== 'string' || !USAGE_PURPOSES.includes(row.purpose)) continue;
            // Already in the rollup (its write landed before a crash or stop kept this file from being rewritten).
            if (mark !== null && Date.parse(row.at) < mark) { folded++; continue; }
            this.rows.push(row); if (Object.hasOwn(LEGACY_STORED_PURPOSES, raw.purpose)) unsafe = true;
          } catch {}
        }
      } catch {}
      // The oldest unfolded row this release left in the file is gone: an older release (a rollback) pruned rows
      // without folding them. The hole, from that row to the oldest row left (at most to the raw retention), is
      // recorded, never guessed; a quiet stretch after the watermark is not one.
      const left = rollup?.rawOldest('usage') ?? null;
      if (left !== null) { const oldest = this.rows.length ? Date.parse(this.rows[0].at) : Infinity; if (oldest > left) rollup.gap('usage', left, Math.min(oldest, this.now() - this.retentionMs)); }
      this.prune(true, unsafe || folded > 0);
      for (const row of this.rows) this.remember(row);
    }
  }
  /**
   * Host keep-alive pings (cache-keepalive.mjs, `keepAlive: true`) re-send a conversation's last request while it is
   * idle. They refresh its prompt cache (and the prefix/model times below), but they are not conversation requests:
   * - `lastSessionRequest` ignores them, so idle compaction's idle period, its once-per-period record and the
   *   session.resume buckets still count from the user's real activity; the warmth they buy is read separately
   *   (`lastKeepAlive`, `keepAlive.warmUntil`) and holds idle compaction off while the cache is warm;
   * - the next conversation request's continuity stays as the SDK computed it (pings neither break nor extend the
   *   journal's projection) but is marked `bridged`, so a gap the pings kept warm is never read as cache survival
   *   (it would push Anthropic's documented TTL out of the learned estimate and defer every cold-break economy).
   */
  remember(row) {
    const at = Date.parse(row.at); if (row.prefixKey) this.lastPrefix.set(row.prefixKey, at); this.lastModel.set(modelKey(row), at);
    if (row.keepAlive === true) { if (row.sessionId) this.lastPing.set(row.sessionId, at); return; }
    // The session's previous request for miss causes (cacheMiss): any non-ping request of it, a summary included.
    if (row.sessionId && !CACHE_EXEMPT_PURPOSES.has(row.purpose)) this.lastCall.set(row.sessionId, { purpose: row.purpose, providerId: row.providerId ?? null, modelId: row.modelId ?? null, prefixKey: row.prefixKey ?? null });
    // The session's last request that read or wrote its cache (an idle summary reads a flattened record, not the conversation's cache).
    if (row.sessionId && !CACHE_EXEMPT_PURPOSES.has(row.purpose) && row.trigger !== 'idle') this.lastSession.set(row.sessionId, { at, providerId: row.providerId ?? null, modelId: row.modelId ?? null });
  }
  /** Time of the session's latest keep-alive ping (the cache was refreshed then), or null. */
  lastKeepAlive(sessionId) { return this.lastPing.get(sessionId) ?? null; }
  /** Whether a keep-alive ping refreshed this session's cache since its last conversation request. */
  bridgedSince(sessionId) { const ping = this.lastPing.get(sessionId); return ping !== undefined && ping >= (this.lastSession.get(sessionId)?.at ?? -Infinity); }
  /** Time of the latest request of this project on this model (any purpose). */
  lastRequestAt({ projectId, providerId, modelId } = {}) { return this.lastModel.get(modelKey({ projectId, providerId, modelId })) ?? null; }
  /** The session's latest cache-bearing request (`at` = when its response ended), or null. */
  lastSessionRequest(sessionId) { const value = this.lastSession.get(sessionId); return value ? { ...value } : null; }
  /** Observe every recorded row (the idle-compaction service re-plans on them); returns the unsubscribe. */
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /**
   * Rows older than the retention (and the oldest beyond `maxRecords`) leave the ledger. With a rollup they are folded
   * first, by the cutoff instant: the rollup's watermark becomes that instant and is written (durably) before the file
   * is rewritten without them, so a crash at any point neither loses nor double-counts a row.
   */
  prune(rewrite = false, force = false) {
    let cutoff = this.now() - this.retentionMs;
    // The cap drops the oldest rows: everything older than the first row it keeps goes with them, so the cut is an instant.
    if (this.rows.length > this.maxRecords) cutoff = Math.max(cutoff, Date.parse(this.rows[this.rows.length - this.maxRecords].at));
    const before = this.rows.length, leaving = this.rows.filter(row => !(Date.parse(row.at) >= cutoff));
    if (leaving.length && this.rollup?.writable) this.foldLeaving(leaving, cutoff);
    if (leaving.length) this.rows = this.rows.filter(row => Date.parse(row.at) >= cutoff);
    this.noteOldest();
    this.dropped += before - this.rows.length;
    // Never drop raw rows from the file before the rollup holding them is on disk (rewrite flushes it first).
    if (this.file && (rewrite && (force || before !== this.rows.length) || this.dropped > 2000)) this.rewrite();
  }
  /** Fold the rows leaving the ledger into the daily rollup; their 7-day outcome windows are closed by now. */
  foldLeaving(leaving, cutoff) {
    const final = new Set(leaving), labels = outcomeLabels(this.rows, { now: this.now(), final });
    this.rollup.fold('usage', leaving.map(row => ({ at: Date.parse(row.at), key: rollupKey(row), values: usageCellValues(row, { label: labels.get(row) }) })), cutoff);
  }
  /** Tell the rollup which unfolded row is the oldest this ledger keeps (it stays in the file until it is folded). */
  noteOldest() { this.rollup?.noteRaw('usage', this.rows.length ? Date.parse(this.rows[0].at) : null); }
  /** Write the rollup if it changed (shutdown; the next rewrite does it anyway). */
  flush() { try { return this.rollup?.flush() ?? true; } catch { return false; } }
  /** Never throws into a provider stream: metering must not fail model work. */
  record(input) {
    try {
      const at = this.now(), previous = input.prefixKey ? this.lastPrefix.get(input.prefixKey) : undefined;
      const cacheAligned = input.prefixKey === undefined ? undefined : Number.isSafeInteger(input.ttlMs) && input.ttlMs > 0 ? previous !== undefined && at - previous <= input.ttlMs : null;
      const bridged = input.keepAlive !== true && input.continuity && typeof input.sessionId === 'string' && this.bridgedSince(input.sessionId);
      const row = usageRecord({ at, ...input, ...(cacheAligned !== undefined ? { cacheAligned } : {}), ...(bridged ? { continuity: { ...input.continuity, bridged: true } } : {}) });
      // Why the request missed its session's cache, decided when it is recorded (pi detectCacheMiss at message end).
      try {
        const lifetime = Number.isSafeInteger(row.ttlMs) ? row.ttlMs : row.providerId && row.modelId ? this.survival?.learned?.(CacheSurvival.key(row.providerId, row.modelId))?.coldAfterMs ?? null : null;
        const miss = row.sessionId ? cacheMiss(row, this.lastCall.get(row.sessionId), { coldAfterMs: lifetime }) : null;
        if (miss) row.miss = miss;
      } catch { /* a diagnostic never fails metering */ }
      this.rows.push(row); this.remember(row); if (this.rows.length === 1) this.noteOldest();
      try { this.survival?.observe(row); } catch { /* derived metrics never fail metering */ }
      for (const listener of this.listeners) try { listener(row); } catch { /* observers never fail metering */ }
      if (this.file) { mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }); appendFileSync(this.file, `${JSON.stringify(storedUsageRow(row))}\n`, { mode: 0o600 }); }
      // With a rollup, expired rows leave in hourly batches: one fold (and its outcome pass) per batch, not per request.
      if (this.rows.length > this.maxRecords || Date.parse(this.rows[0].at) < this.now() - this.retentionMs - (this.rollup ? PRUNE_BATCH_MS : 0)) this.prune();
      return row;
    } catch { return null; }
  }
  records({ since = 0, projectId } = {}) { return this.rows.filter(row => Date.parse(row.at) >= since && (!projectId || row.projectId === projectId)); }
  /** A deleted project's receipts leave the ledger (and, through the host, its rollup), so none is folded in later. */
  removeProject(projectId) {
    if (!projectId) return 0;
    const before = this.rows.length; this.rows = this.rows.filter(row => row.projectId !== projectId); this.noteOldest();
    const removed = before - this.rows.length;
    if (removed) this.rewrite();
    return removed;
  }
  /** Rewrite the file from memory; rows already folded leave it only once the rollup holding them is on disk. */
  rewrite() {
    if (!this.file || (this.rollup && !this.rollup.flush())) return false;
    this.dropped = 0;
    try { mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }); const temp = `${this.file}.${process.pid}.tmp`; writeFileSync(temp, this.rows.map(row => `${JSON.stringify(storedUsageRow(row))}\n`).join(''), { mode: 0o600 }); renameSync(temp, this.file); return true; } catch { return false; }
  }
}

/** Purposes without a prompt cache (JEV judgments): excluded from every cache metric. */
export const CACHE_EXEMPT_PURPOSES = new Set(['jev']);
/**
 * Whether a JEV ledger row (or rollup key) is a probe judgment, a developer's raw call through
 * POST /api/v2/decision-kernel/probe, rather than a product judgment the daemon made (Z2). Rows written from 0.69 say
 * which they are: `detail: 'probe'` for the probe, `detail: 'decision'` for a decision the daemon asked for (a decision
 * point outside any project and session has no scope to show it, so the structure alone would call it a probe). Older rows
 * carry no detail: the probe never recorded a project or a session, while a decision carried its project or, outside any
 * project, its session; an older decision with neither (session.resume of a project-less conversation) reads as a probe,
 * which only its absent scope could tell apart. A rollup key has no session, so there the project alone decides.
 * Reading only: nothing is written back to old rows.
 */
export const isProbeJudgment = row => row?.detail === 'probe' || (row?.detail === undefined && !row?.projectId && !row?.sessionId);

/** The report lists this many of the largest sessions (ranked by their tokens). */
export const USAGE_RUN_LIMIT = 8;
/**
 * Where run names come from, read at report time from the state's projects (nothing is stored in the ledger): a
 * background run's session is its job (`job.id`); a scheduled one names its schedule (`job.scheduleId`, the schedule's
 * title). Returns (sessionId, projectId) -> { projectName?, kind?, scheduleId?, title? } or null.
 */
export function runLabeler(projects = []) {
  const byId = new Map((Array.isArray(projects) ? projects : []).filter(project => project?.id).map(project => [project.id, project]));
  return (sessionId, projectId) => {
    const project = byId.get(projectId); if (!project) return null;
    const job = project.jobs?.find(row => row?.id === sessionId), scheduleId = text(job?.scheduleId), schedule = scheduleId ? project.schedules?.find(row => row?.id === scheduleId) : undefined;
    const projectName = text(project.name, 80), title = text(schedule?.title ?? job?.title, 120);
    return { ...(projectName ? { projectName } : {}), ...(job ? { kind: scheduleId ? 'scheduled' : 'job' } : {}), ...(scheduleId ? { scheduleId } : {}), ...(title ? { title } : {}) };
  };
}
/**
 * How an estimated row's tokens split (ACC-4). Its `input` is the whole prompt's estimate, but a provider serves the part
 * it read from its prompt cache from the cache. The assumption, stated: an estimated request's prompt split between
 * uncached input, cache read and cache write like the reported requests with the same prefix (its ledger `prefixKey`: the
 * same conversation or own prefix on the same model), else like the reported requests of the same purpose on the same
 * model in the same project, token-weighted over `reference` (the retained ledger); with neither, all of it counts as
 * uncached input (the upper bound). Only the fresh / cache-read split of a run's tokens uses this: token totals stay as
 * recorded.
 */
export function estimatedSplit(reference = []) {
  const byPrefix = new Map(), byPurpose = new Map();
  const add = (map, key, row) => { const sum = map.get(key) ?? { input: 0, cacheRead: 0, cacheWrite: 0 }; sum.input += count(row.input); sum.cacheRead += count(row.cacheRead); sum.cacheWrite += count(row.cacheWrite); map.set(key, sum); };
  // Keep-alive pings re-read a prefix that is warm by construction: they would overstate what a real request reads.
  for (const row of reference) if (row?.cacheReported === true && row.estimated !== true && row.keepAlive !== true) { if (row.prefixKey) add(byPrefix, row.prefixKey, row); add(byPurpose, `${row.purpose}|${modelKey(row)}`, row); }
  return row => {
    if (row?.estimated !== true) return row;
    const mix = row.prefixKey && byPrefix.get(row.prefixKey) || byPurpose.get(`${row.purpose}|${modelKey(row)}`), prompt = count(row.input), whole = mix ? mix.input + mix.cacheRead + mix.cacheWrite : 0;
    if (!whole || !prompt) return row;
    const cacheRead = Math.round(prompt * mix.cacheRead / whole), cacheWrite = Math.min(prompt - cacheRead, Math.round(prompt * mix.cacheWrite / whole));
    return { ...row, input: prompt - cacheRead - cacheWrite, cacheRead, cacheWrite };
  };
}
/** Misses by cause: how many and the tokens re-billed. */
const missesOf = values => {
  if (!values.miss) return undefined;
  const byReason = Object.fromEntries(MISS_REASONS.filter(reason => values.miss[reason]).map(reason => [reason, { count: values.miss[reason].n ?? 0, tokens: values.miss[reason].tokens ?? 0 }]));
  return { count: Object.values(byReason).reduce((sum, row) => sum + row.count, 0), tokens: Object.values(byReason).reduce((sum, row) => sum + row.tokens, 0), byReason };
};
/**
 * One report bucket from an accumulator (raw rows and rollup days alike), in the contract's shape (§5): output over
 * every row (estimated ones included), the reasoning part when reported, truncations, the estimated rows (aborted or
 * unreported requests, outside the hit rate; `partial`: reported requests whose output past their last report was
 * estimated, that part counted in `output`), and per reasoning effort sent (spec p1 effort §3.7) with the estimated
 * rows' input apart from the reported input.
 */
const bucket = v => {
  const n = name => v[name] ?? 0, byReasoning = v.byReasoning ?? {};
  const denominator = n('input') + n('cacheRead') + n('cacheWrite'), misses = missesOf(v);
  return { requests: n('requests'), input: n('input'), cacheRead: n('cacheRead'), cacheWrite: n('cacheWrite'), output: n('output'), reasoningTokens: n('reasoningTokens'), lengthStops: n('lengthStops'),
    estimated: { requests: n('estimatedRequests'), input: n('estimatedInput'), output: n('estimatedOutput'), ...(n('partial') ? { partial: n('partial') } : {}) }, ...(Object.keys(byReasoning).length ? { byReasoning } : {}),
    // Token-weighted, never an average of per-request percentages.
    hitRate: denominator ? n('cacheRead') / denominator : null,
    coverage: n('reported') ? n('covered') / n('reported') : null,
    coldStarts: n('cold'),
    unreported: n('requests') - n('reported'),
    ...(n('alignedSeen') ? { cacheAligned: { aligned: n('aligned'), outside: n('outside'), unknownTtl: n('unknownTtl') } } : {}),
    // Why requests re-billed what their session had already sent (cacheMiss), only when some did.
    ...(misses ? { misses } : {}) };
};
/** Windows of the usage report: '1h' and '24h' roll; '7d', '30d' and '90d' are whole local days ending today. */
export const USAGE_WINDOWS = Object.freeze(['1h', '24h', '7d', '30d', '90d']);
const ARCHIVED = Object.freeze(['include', 'exclude', 'only']);
/**
 * `archived` (plan B7; zcode lists archived tasks as an explicit kind): `include`, `exclude` or `only`, against the ids
 * in `archivedProjects`. Usage includes them by default (what was spent was spent). Rows without a project are never archived.
 */
export const archivedFilter = (archived = 'include', archivedProjects = new Set()) => {
  if (!ARCHIVED.includes(archived)) throw Object.assign(new Error('archived must be include, exclude or only'), { status: 400, code: 'archived_invalid' });
  return projectId => archived === 'include' ? true : archivedProjects.has(projectId) ? archived === 'only' : archived === 'exclude';
};
/**
 * GET /api/v2/usage/cache aggregation (contract §5), over [since, until) (metric-windows.mjs). Raw rows cover the
 * ledger's 7 days; the days before the rollup's watermark come from the daily rollup (`rollup`), so a 90-day report reads
 * no raw row older than a week. `reference`: the rows estimated requests are split from (estimatedSplit; the whole
 * retained ledger, so a row's split does not depend on the window), default `rows`; the outcome labels read it too.
 * Read-time only, nothing stored (Z1/Z2): `judge` splits JEV judgments into product ones and probes (isProbeJudgment);
 * `runs` lists the largest sessions of the raw ledger by their tokens (the rollup keeps no session, so a window reaching into
 * it lists the raw part), each with its cache reads apart from the fresh tokens, named through `runLabel(sessionId, projectId)`
 * (runLabeler). No price enters `runs` or `judge`: the report counts tokens, it does not weigh them.
 */
export function aggregateCacheUsage(rows, { window = '24h', projectId, now = Date.now(), survival = null, modelFor, reference = rows, rollup = null, timeZone, archived = 'include', archivedProjects = new Set(), runLabel = null } = {}) {
  if (!USAGE_WINDOWS.includes(window)) throw Object.assign(new Error(`window must be ${USAGE_WINDOWS.join(', ')}`), { status: 400 });
  const range = windowRange(window, { now, ...(timeZone ? { timeZone } : {}) }), keepProject = archivedFilter(archived, archivedProjects);
  const labels = outcomeLabels(reference, { now });
  // One pass: each row (and each rollup cell) goes to its accumulators. JEV judgments have no prompt cache: they never
  // enter cache statistics (hit rate, coverage, cold starts, unreported counts) and are reported under `judge`.
  // Keep-alive pings (cache-keepalive.mjs) re-read an idle conversation's prefix: they are not conversation requests, so
  // they stay out of every cache metric and `latest`, and are reported under `keepAlive`.
  const overall = accumulator(), judged = accumulator(), judgedProduct = accumulator(), judgedProbe = accumulator(), pinged = accumulator(), groups = new Map();
  const target = (purpose, keepAlive, probe) => CACHE_EXEMPT_PURPOSES.has(purpose) ? [judged, probe ? judgedProbe : judgedProduct] : keepAlive === true ? [pinged] : [overall, groups.get(purpose) ?? (groups.set(purpose, accumulator()), groups.get(purpose))];
  // Sessions of the raw ledger, kept beside the accumulators (never in them, so nothing of it reaches a rollup cell).
  const sessions = new Map();
  let split = null;
  const splitOf = row => row.estimated === true ? (split ??= estimatedSplit(reference))(row) : row;
  let last = null;
  // Closed days already folded: everything in the rollup is older than its watermark, every raw row is not.
  const mark = rollup?.mark('usage') ?? null, fromRollup = Boolean(rollup && range.days && mark !== null && range.since < mark);
  if (fromRollup) for (const cell of rollup.cells({ firstDay: range.days[0], lastDay: range.days.at(-1), keep: key => (!projectId || key.projectId === projectId) && keepProject(key.projectId) })) for (const acc of target(cell.k.purpose, cell.k.keepAlive, isProbeJudgment(cell.k))) addCellTo(acc, cell.k, cell.v);
  for (const row of rows) {
    if (!within(Date.parse(row.at), range) || (projectId && row.projectId !== projectId) || !keepProject(row.projectId)) continue;
    const label = labels.get(row), accs = target(row.purpose, row.keepAlive, isProbeJudgment(row));
    for (const acc of accs) addRow(acc, row, label);
    if (accs[0] === overall && row.cacheReported) last = row;
    // A conversation request of a session (not a JEV judgment, not a keep-alive ping: accs[0] is `overall` for exactly those) belongs to a run.
    if (accs[0] === overall && row.sessionId) {
      const run = sessions.get(row.sessionId) ?? sessions.set(row.sessionId, { sessionId: row.sessionId, projectId: row.projectId, requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, tokens: 0, purposes: new Map(), firstAt: row.at, lastAt: row.at }).get(row.sessionId);
      // A request that reported no usage has its whole prompt estimate as `input`; its tokens are split as the cache statistics split them (estimatedSplit: like the reported requests of its prefix), so its prompt is not all counted as fresh. The total is as recorded.
      const part = splitOf(row), tokens = count(part.input) + count(part.cacheRead) + count(part.cacheWrite) + count(part.output);
      run.requests++; run.input += count(part.input); run.cacheRead += count(part.cacheRead); run.cacheWrite += count(part.cacheWrite); run.output += count(part.output); run.tokens += tokens;
      run.purposes.set(row.purpose, (run.purposes.get(row.purpose) ?? 0) + tokens); if (row.at < run.firstAt) run.firstAt = row.at; if (row.at > run.lastAt) run.lastAt = row.at;
    }
  }
  const byPurpose = {};
  for (const purpose of USAGE_PURPOSES) { if (CACHE_EXEMPT_PURPOSES.has(purpose)) continue; const acc = groups.get(purpose); if (acc?.requests) byPurpose[purpose] = bucket(acc); }
  // Compaction requests by what started them (an idle summary, a deferred or blocking trigger, an overflow, the user).
  if (byPurpose.compaction) byPurpose.compaction.byTrigger = groups.get('compaction').byTrigger ?? {};
  const rate = (part, whole) => whole ? Math.round(part / whole * 1000) / 1000 : null;
  // Did the conversation of an idle summary come back within 7 days (outcomeLabels): calibrates session.resume.
  const idle = groups.get('compaction') ?? accumulator();
  const idleCompaction = idle.returned || idle.notReturned || idle.returnOpen ? { returned: idle.returned, notReturned: idle.notReturned, open: idle.returnOpen, returnRate: rate(idle.returned, idle.returned + idle.notReturned) } : null;
  const total = last ? last.input + last.cacheRead + last.cacheWrite : 0;
  // Product judgments (the daemon's own decisions) apart from probes (isProbeJudgment): the probe endpoint is a developer's tool and can dwarf the product's own calls.
  const judgedPart = acc => ({ requests: acc.requests, input: acc.rawInput, output: acc.output });
  const judge = judged.requests ? { requests: judged.requests, input: judged.rawInput, output: judged.output, product: judgedPart(judgedProduct), probe: judgedPart(judgedProbe) } : null;
  // The largest runs: by the tokens of the session (input + cache read + cache write + output), the purpose that carried most of them names it.
  const runs = [...sessions.values()].sort((a, b) => b.tokens - a.tokens || b.requests - a.requests).slice(0, USAGE_RUN_LIMIT).map(run => {
    const named = typeof runLabel === 'function' ? (() => { try { return runLabel(run.sessionId, run.projectId) ?? {}; } catch { return {}; } })() : {};
    return { sessionId: run.sessionId, purpose: [...run.purposes].sort((a, b) => b[1] - a[1])[0][0], ...(run.projectId ? { projectId: run.projectId } : {}), ...named, requests: run.requests, tokens: run.tokens, input: run.input, cacheRead: run.cacheRead, cacheWrite: run.cacheWrite, output: run.output, firstAt: run.firstAt, lastAt: run.lastAt };
  });
  // Did a ping pay (the next request of its conversation read the cache it kept warm): calibrates the keep-alive.
  const keepAlive = pinged.requests ? { requests: pinged.requests, input: pinged.rawInput, cacheRead: pinged.rawCacheRead, cacheWrite: pinged.rawCacheWrite,
    outcomes: { worth: pinged.pingWorth, wasted: pinged.pingWasted, open: pinged.pingOpen, worthRate: rate(pinged.pingWorth, pinged.pingWorth + pinged.pingWasted) } } : null;
  return { window, ...(projectId ? { projectId } : {}), since: Number.isFinite(range.since) ? new Date(range.since).toISOString() : null, until: new Date(range.until).toISOString(), ...(archived !== 'include' ? { archived } : {}),
    overall: bucket(overall), byPurpose, runs, ...(judge ? { judge } : {}), ...(keepAlive ? { keepAlive } : {}), ...(idleCompaction ? { idleCompaction } : {}), latest: last ? { purpose: last.purpose, hitRate: total ? last.cacheRead / total : null, at: last.at } : null,
    ...(fromRollup ? { rollup: { firstDay: rollup.firstDay(), through: new Date(mark).toISOString(), ...(rollup.gaps.some(gap => gap.source === 'usage') ? { gaps: rollup.gaps.filter(gap => gap.source === 'usage') } : {}) } } : {}),
    // A rollup a later release wrote (a rollback) is not read: a window reaching past the raw week says so, never fills in.
    ...(!fromRollup && rollup?.readOnly && range.since < now - CACHE_WINDOWS['7d'] ? { rollup: { unavailable: rollup.readOnly } } : {}),
    ...(survival ? { cacheSurvival: survival.report(modelFor) } : {}) };
}
/** `projects`: the state's projects, for `archived`. */
export function cacheUsageResponse(ledger, searchParams, { now = Date.now(), modelFor, projects = [], timeZone } = {}) {
  const window = searchParams.get('window') || '24h', projectId = searchParams.get('projectId') || undefined, archived = searchParams.get('archived') || 'include';
  if (projectId && (projectId.length > 160 || /[\u0000-\u001f]/.test(projectId))) throw Object.assign(new Error('invalid projectId'), { status: 400 });
  const archivedProjects = new Set(projects.filter(row => row?.archivedAt).map(row => row.id)), reference = ledger ? ledger.records({ since: 0, projectId }) : [];
  return aggregateCacheUsage(reference, { window, projectId, now, survival: ledger?.survival ?? null, modelFor, rollup: ledger?.rollup ?? null, timeZone, archived, archivedProjects, reference, runLabel: runLabeler(projects) });
}

/**
 * Events the SDK yields before a provider accepted the request: an HTTP rejection about to be re-sent (`retry`, after
 * a 429/5xx) and the preserved-thinking recoveries after a 400. None is an answer: a request that ends after only these
 * was rejected, never billed, and is not recorded (ACC-1), like a request rejected without a retry.
 */
export const PRE_RESPONSE_EVENTS = new Set(['retry', 'thinking_rebase', 'thinking_recovery']);
/** Failure codes of a request that never reached an answer and was never billed: a local refusal before sending
 * (buildRequest validation) and the provider's HTTP rejection (streamCompletion, after its retries). */
export const UNBILLED_FAILURES = new Set(['configuration', 'invalid_output_contract', 'unsupported_output_contract', 'http_error', 'redirect_rejected', 'thinking_binding']);
/**
 * Output tokens past a request's last usage report (ACC-2): the bytes that streamed after it, three per token (the
 * PDL-3 estimate). 0 for a request that completed (its last report is final). Anthropic reports usage at message_start
 * (output ≈ 1) and the real output only at the end, so a stream stopped mid-way would otherwise keep output ≈ 1.
 */
export const unreportedOutput = ({ completed = false, streamed = 0, streamedAtReport = 0 } = {}) => completed ? 0 : Math.ceil(Math.max(0, streamed - streamedAtReport) / 3);

/** Wrap a completion provider so each request leaves one purpose-tagged
 * receipt. A request with no usage event is recorded as unreported, never 0.
 * `meteredBase` lets the SDK keep its local pre-request validation. */
export function meteredProvider(base, { ledger, purpose, projectId, sessionId, keepAlive = ledger?.keepAlive } = {}) {
  base ??= streamCompletion;
  if (!ledger) return base;
  const wrapped = async function* (request) {
    let usage = null, responded = false, transformations = [], thinkingRecovery, completed = false, stopReason, streamed = 0, streamedAtReport = 0, backoffUntil = 0;
    // Cancelled before it was handed over: nothing was sent, so nothing is recorded.
    const cancelledBefore = request?.signal?.aborted === true;
    const effective = purpose => ['compaction', 'summary'].includes(request?.purpose) ? request.purpose : purpose;
    try { keepAlive?.requestStarted?.({ sessionId, projectId, purpose: effective(purpose), request }); } catch { /* keep-alive never fails model work */ }
    try {
      for await (const event of base(request)) {
        if (!PRE_RESPONSE_EVENTS.has(event?.type)) responded = true;
        if (event?.type === 'usage') { usage = event.usage; streamedAtReport = streamed; }
        else if (event?.type === 'input_transformations' && Array.isArray(event.items)) transformations.push(...event.items);
        else if (event?.type === 'thinking_rebase') thinkingRecovery = 'strip';
        else if (event?.type === 'thinking_recovery' && event.recovery === 'drop_block') thinkingRecovery = 'drop_block';
        else if (event?.type === 'text_delta' || event?.type === 'thinking_delta') streamed += Buffer.byteLength(typeof event.delta === 'string' ? event.delta : '');
        else if (event?.type === 'tool_call') streamed += Buffer.byteLength(JSON.stringify(event.arguments ?? event.toolCall?.arguments ?? {}));
        else if (event?.type === 'done') { completed = true; stopReason = event.stopReason; }
        yield event;
        // The SDK waits `delayMs` from here before re-sending the rejected request: a stop in that wait finds nothing in flight.
        if (event?.type === 'retry') backoffUntil = Date.now() + Math.max(0, Number(event.delayMs) || 0);
      }
    } finally {
      const prefixKey = prefixKeyOf(request, projectId), ttlMs = cacheTtlMs(request?.model, request?.cache?.retention);
      // The SDK's request metadata (`request.ledger`): continuity for every session request, the trigger of a compaction.
      const meta = request?.ledger && typeof request.ledger === 'object' ? request.ledger : {};
      // PDL-3/TC-6: a request that reported no usage (aborted mid-stream, cancelled after it was sent, a provider that
      // sends none) is recorded with an estimate (flagged), never as zero and never dropped. A local refusal or an HTTP
      // rejection (neither answered nor cancelled) was never billed and is not recorded; nor is a stop while the SDK
      // waited to re-send a rejected request (nothing was in flight).
      const aborted = !completed && request?.signal?.aborted === true && !cancelledBefore, waiting = aborted && !responded && !usage && backoffUntil > Date.now();
      if ((responded || usage || aborted) && !waiting) {
        const estimate = usage ? null : { input: Number.isFinite(request?.estimatedInputTokens) ? Math.max(0, Math.ceil(request.estimatedInputTokens)) : inputEstimate(request), output: Math.ceil(streamed / 3), cacheRead: 0, cacheWrite: 0, cacheUsageReported: false };
        // Reported, but the request ended before its final report: what streamed after the last report is estimated output.
        const extra = usage ? unreportedOutput({ completed, streamed, streamedAtReport }) : 0, settled = usage && extra ? { ...usage, output: count(usage.output) + extra } : usage;
        ledger.record({ purpose: effective(purpose), projectId, sessionId, providerId: request?.model?.providerId, modelId: request?.model?.modelId ?? request?.model?.id, usage: settled ?? estimate, ...(prefixKey ? { prefixKey, ttlMs } : {}), ...(meta.continuity ? { continuity: meta.continuity } : {}), ...(meta.trigger ? { trigger: meta.trigger } : {}), thinkingDropped: thinkingDropCounts(transformations), thinkingRecovery,
          detail: request?.purposeDetail ?? purposeDetail(effective(purpose)), reasoning: request?.model?.reasoning, stopReason, outputCap: request?.maxOutputTokens ?? request?.model?.maxOutputTokens, ...(estimate ? { estimated: true } : {}), ...(extra ? { estimatedOutput: extra } : {}), ...(aborted ? { aborted: true } : {}), ...(!responded ? { responded: false } : {}) });
      }
      // The keep-alive sizes its entry from the reported usage only, never from the estimate above.
      try { keepAlive?.requestSettled?.({ sessionId, projectId, purpose: effective(purpose), request, completed, usage, recovered: Boolean(thinkingRecovery) }); } catch { /* keep-alive never fails model work */ }
    }
  };
  wrapped.meteredBase = base.meteredBase ?? base;
  return wrapped;
}
/** Estimated input tokens of a request that reported none: its UTF-8 bytes over three (system prompt, messages, tools). */
function inputEstimate(request) {
  try { return Math.ceil(Buffer.byteLength(JSON.stringify([request?.systemPrompt ?? '', request?.messages ?? [], request?.tools?.length ? request.tools.map(tool => [tool.name, tool.description, tool.parameters]) : []])) / 3); } catch { return 0; }
}
/** Provider for hosts that keep their own injected provider: meter when a
 * ledger exists on the store, otherwise return the provider unchanged. */
export const purposeProvider = (store, provider, purpose, meta = {}) => store?.usageLedger ? meteredProvider(provider, { ledger: store.usageLedger, purpose, ...meta }) : provider;

/**
 * Where the learned survival lives: inside the conversation-journal root `<state>.rna`, which every release since
 * 0.21 inventories. A new top-level `<state>.<name>` sibling would be rejected (checkpoint_unknown_sidecar) by the
 * checkpoint of a release rolled back to that predates it (0.43.0 trap); the samples are derived from those journals.
 */
export const cacheSurvivalFile = stateFile => join(`${stateFile}.rna`, 'usage-cache-survival.json');
/** The sibling an unreleased 0.66 build wrote; read once, then removed, so a rollback to 0.65.0 finds no unknown sidecar. */
export const legacyCacheSurvivalFile = stateFile => `${stateFile}.usage-cache.survival.json`;
/**
 * Learned prompt-cache survival per provider/model (spec p1 compaction §A3). Samples are derived observations from
 * continuous requests after an idle gap of at least a minute: warm when at least half of the previous prompt was read
 * from cache. Kept 30 days in `<state>.rna/usage-cache-survival.json` (cacheSurvivalFile).
 * The estimate is the documented TTL when one exists and no warm sample outlived it, else the smallest cold gap above
 * the largest warm gap (provider-side evictions below it never lower the estimate); null means no idle economy.
 */
export class CacheSurvival {
  constructor({ file, legacyFile = null, now = Date.now, maxAgeMs = SURVIVAL_MAX_AGE_MS, debounceMs = 2000, maxSamples = 4000 } = {}) {
    Object.assign(this, { file, legacyFile, now, maxAgeMs, debounceMs, maxSamples, models: new Map(), backfilledAt: null, timer: null, dirty: false });
    const load = path => {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      if (saved?.version !== 1) return false;
      this.backfilledAt = typeof saved.backfilledAt === 'string' ? saved.backfilledAt : null;
      for (const [key, rows] of Object.entries(saved.models ?? {})) if (Array.isArray(rows)) this.models.set(key, rows.filter(row => Number.isFinite(row?.gapMs) && typeof row.warm === 'boolean' && Number.isFinite(row.prompt) && Number.isFinite(row.at)));
      return true;
    };
    let loaded = false;
    if (file) try { loaded = load(file); } catch { /* absent or unreadable: start empty (the backfill rebuilds it) */ }
    // A legacy sibling moves into the file at the first flush and is then removed (or just removed when the file exists).
    if (file && legacyFile && existsSync(legacyFile)) {
      if (!loaded) try { load(legacyFile); } catch { /* unreadable: the backfill rebuilds it */ }
      this.dirty = true; this.schedule();
    }
  }
  static key(providerId, modelId) { return `${providerId ?? ''}|${modelId ?? ''}`; }
  add(key, sample) {
    if (!sample) return false;
    const rows = this.models.get(key) ?? [], cutoff = this.now() - this.maxAgeMs;
    rows.push(sample);
    this.models.set(key, rows.filter(row => row.at >= cutoff).slice(-this.maxSamples));
    this.dirty = true; this.schedule();
    return true;
  }
  /** A ledger row of a continuous request: one sample, or nothing. */
  observe(row) { if (!row?.providerId || !row?.modelId) return false; return this.add(CacheSurvival.key(row.providerId, row.modelId), survivalSample({ continuity: row.continuity, cacheReported: row.cacheReported, cacheRead: row.cacheRead, at: row.at })); }
  learned(key) { return survivalFromSamples(this.models.get(key) ?? [], { now: this.now(), maxAgeMs: this.maxAgeMs }); }
  /** `{ coldAfterMs, warmMaxMs, documentedTtlMs, samples, source }` for a model config; coldAfterMs null = no estimate. */
  estimate(model) {
    if (!model?.providerId || !model?.modelId) return { coldAfterMs: null, warmMaxMs: null, documentedTtlMs: null, samples: 0, source: null };
    // The one cold-gap rule (SDK coldAfterMs): Anthropic's documented TTL, the learned survival elsewhere.
    const learned = this.learned(CacheSurvival.key(model.providerId, model.modelId));
    return { ...learned, ...coldAfterMs(model, learned) };
  }
  /** Per provider/model, for GET /api/v2/usage/cache; `modelFor(providerId, modelId)` supplies the configured model so documented TTLs apply. */
  report(modelFor = () => null) {
    return Object.fromEntries([...this.models.keys()].sort().map(key => {
      const [providerId, ...rest] = key.split('|'), modelId = rest.join('|'), model = modelFor(providerId, modelId);
      const value = model ? this.estimate({ ...model, providerId, modelId }) : { ...this.learned(key), documentedTtlMs: null };
      return [key, { coldAfterMs: value.coldAfterMs, warmMaxMs: value.warmMaxMs, documentedTtlMs: value.documentedTtlMs ?? null, samples: value.samples, source: value.source ?? (value.coldAfterMs === null ? null : 'learned') }];
    }));
  }
  schedule() { if (!this.file || this.timer) return; this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.debounceMs); this.timer.unref?.(); }
  flush() {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, backfilledAt: this.backfilledAt, models: Object.fromEntries(this.models) }), { mode: 0o600 }); renameSync(temp, this.file);
    } catch { this.dirty = true; return; }
    if (this.legacyFile) {
      const name = basename(this.legacyFile), temps = (() => { try { return readdirSync(dirname(this.legacyFile)).filter(entry => entry.startsWith(`${name}.`) && /^\.\d+\.tmp$/.test(entry.slice(name.length))); } catch { return []; } })();
      for (const path of [this.legacyFile, ...temps.map(entry => join(dirname(this.legacyFile), entry))]) try { unlinkSync(path); } catch { /* already gone */ }
      this.legacyFile = null;
    }
  }
  close() { clearTimeout(this.timer); this.timer = null; this.flush(); }
  /**
   * One-time backfill from the foreground session journals (`<state>.rna/<sessionId>/*.rna.jsonl`; background runs
   * under `initiative/` are skipped): consecutive served requests, read-only and without a lock, yielding to the event
   * loop every 20 ms. Rewinds drop the rewound messages, as replay does.
   *
   * Keep-alive pings are not journaled, so a gap they kept warm looks like cache survival (observe() drops such a gap
   * through the ledger's `bridged` mark). From the `ledger`: a gap with a ping of that conversation in it is bridged;
   * a gap longer than a 5-minute Anthropic TTL (the only one pinged) that starts before the ledger's oldest row cannot
   * be checked and is left out too — the documented TTL stands.
   */
  async backfill({ stateFile, signal, force = false, ledger = null } = {}) {
    if (!stateFile || this.backfilledAt && !force) return { journals: 0, samples: 0, skipped: true };
    const root = `${stateFile}.rna`; let journals = 0, samples = 0, slice = performance.now();
    const pings = new Map(); let coveredFrom = Infinity;
    for (const row of ledger?.records?.({ since: 0 }) ?? []) {
      const at = Date.parse(row.at); if (!Number.isFinite(at)) continue;
      coveredFrom = Math.min(coveredFrom, at);
      if (row.keepAlive === true && row.sessionId) { if (!pings.has(row.sessionId)) pings.set(row.sessionId, []); pings.get(row.sessionId).push(at); }
    }
    const bridged = (sessionId, ttlMs, from, to) => (pings.get(sessionId) ?? []).some(at => at > from && at < to) || ttlMs === 300000 && to - from > ttlMs && from < coveredFrom;
    const pause = async () => { if (performance.now() - slice > 20) { await new Promise(resolve => setImmediate(resolve)); slice = performance.now(); signal?.throwIfAborted(); } };
    // Conversation folders only: background runs live under initiative/, effort captures under effort-probe/, durable
    // metrics under metrics/, and this estimate's own file sits beside them.
    let sessions = []; try { sessions = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !['initiative', 'effort-probe', 'metrics'].includes(entry.name)).map(entry => entry.name); } catch { sessions = []; }
    for (const session of sessions) {
      let files = []; try { files = readdirSync(join(root, session)).filter(name => name.endsWith('.rna.jsonl')).map(name => join(root, session, name)).filter(path => statSync(path).isFile()); } catch { files = []; }
      for (const file of files) {
        journals++;
        try {
          const messages = [], ids = new Set(), ttls = new Map();
          const note = message => { if (message?.id && !ids.has(message.id)) { ids.add(message.id); messages.push({ id: message.id, assistant: message.role === 'assistant' ? message : null }); } };
          for (const { type, data } of readJournalRecords(file, { verify: false, wantEvent: () => false })) {
            await pause();
            if (type === 'message' || type === 'inbox_claimed' || type === 'tool_completed' || type === 'finish_review') { if (data?.message) note(data.message); continue; }
            if (type === 'request_started') { if (data?.requestId && data.model?.protocol) ttls.set(data.requestId, cacheTtlMs({ protocol: data.model.protocol }, data.cache?.retention ?? 'short')); continue; }
            if (type === 'context_rewind') { const cut = messages.findIndex(row => row.id === data?.beforeMessageId); if (cut >= 0) for (const row of messages.splice(cut)) ids.delete(row.id); continue; }
            if (type !== 'request_completed' || data?.discarded === true || !data?.message) continue;
            const message = data.message, previous = messages.findLast(row => row.assistant?.usageReported === true && row.assistant.contextPrefixHash)?.assistant;
            if (message.usageReported === true && message.contextPrefixHash && message.provider && message.model) {
              const continuity = requestContinuity(previous, message);
              const marked = continuity && bridged(session, ttls.get(data.requestId) ?? null, previous.timestamp, message.timestamp) ? { ...continuity, bridged: true } : continuity;
              const sample = survivalSample({ continuity: marked, cacheReported: message.usage?.cacheUsageReported === true, cacheRead: message.usage?.cacheRead, at: message.timestamp });
              if (this.add(CacheSurvival.key(message.provider, message.model), sample)) samples++;
            }
            note(message);
          }
        } catch (error) { if (signal?.aborted) throw error; /* one unreadable journal never blocks the others */ }
      }
    }
    this.backfilledAt = new Date(this.now()).toISOString(); this.dirty = true; this.flush();
    return { journals, samples };
  }
}
