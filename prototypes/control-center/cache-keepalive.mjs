// Idle prompt-cache keep-alive for Claude conversations (Anthropic prompt-caching docs, "Choosing the TTL": while
// idle, re-send the previous request with `max_tokens: 0` shortly before the 5-minute entry expires; a cache read
// refreshes the timer and bills no output). Rna keeps the 5-minute TTL (the 1-hour write costs more than the 5-60
// minute gaps save on measured traffic, docs/research/anthropic-cache-survival-20261004.md) and pings only while it
// pays: the decision is computed from the observed return gaps of the conversation (pooled with all foreground
// conversations as a one-observation prior), never a fixed horizon, and never a model judgment.
//
// In memory only: the last request of each idle conversation, dropped as soon as a ping no longer pays, any request
// of the conversation starts (a turn, a compaction or step-limit summary, an idle summary), the host forgets it (a
// rewind, a deletion, a committed compaction), a ping is no longer permitted (`keepAliveBlocked`), or the host closes.
// Pings are metered like any request (`keepAlive: true`) and charged to the real-token budget.
import { cacheKeepAlive as sendKeepAlive } from '../../packages/sdk/src/providers.mjs';
import { anthropicFeatures } from '../../packages/sdk/src/anthropic-features.mjs';
import { promptTokens } from '../../packages/sdk/src/cache-survival.mjs';
import { cacheTtlMs, requestPrefixKey } from './usage-cache-service.mjs';
import { chargeRealTokens, realBudgetRemaining } from './budget-service.mjs';

/** Start the ping this long before the entry expires (network and prefill time). */
export const KEEP_ALIVE_LEAD_MS = 20000;
/** Anthropic 5-minute cache write multiplier; reads are priced per model (MODEL_PRICES), else 0.1x. */
const WRITE_SHARE = 1.25, DEFAULT_READ_SHARE = 0.1;

/**
 * Whether one more ping pays, from return gaps (ms, start to start). At idle time t, a ping costs one cache read of
 * the prefix (readShare) and saves the difference between a write and a read (writeShare - readShare) if the next
 * request starts within the window it buys, (t, t + ttl]. So it pays when the conditional return probability
 * h(t) = P(gap in (t, t + ttl] | gap > t) exceeds readShare / (writeShare - readShare). The session's own gaps
 * decide; the pooled foreground gaps act as one pseudo-observation, and an unseen future counts as no return.
 */
export function keepAliveDecision({ sessionGaps = [], pooledGaps = [], idleMs, ttlMs, readShare = DEFAULT_READ_SHARE, writeShare = WRITE_SHARE }) {
  const threshold = readShare / Math.max(1e-9, writeShare - readShare);
  const hazard = gaps => { const later = gaps.filter(gap => gap > idleMs); return { at: later.length, within: later.filter(gap => gap <= idleMs + ttlMs).length }; };
  const pooled = hazard(pooledGaps), own = hazard(sessionGaps);
  const prior = pooled.within / (pooled.at + 1);
  const probability = (own.within + prior) / (own.at + 1);
  return { ping: probability > threshold, probability, threshold, samples: { session: own.at, pooled: pooled.at } };
}

/** Start-to-start gaps between consecutive real requests of one conversation (keep-alive rows excluded). */
export function returnGaps(rows) {
  const times = rows.filter(row => !row.keepAlive).map(row => Date.parse(row.at)).filter(Number.isFinite).sort((a, b) => a - b);
  return times.slice(1).map((time, index) => time - times[index]);
}

/**
 * Why a ping must not be sent now, or null when it may. Read when each ping is due, from the host state: the user's
 * emergency stop, an update holding the service, a conversation that is gone, archived, being deleted or held for
 * recovery (or whose project is), a provider whose endpoint changed or whose key was removed or replaced (the entry
 * still holds the old request), and a daily real-token budget that cannot cover one more read of the prefix.
 */
export function keepAliveBlocked(state, entry, { gate = null, secret = () => undefined } = {}) {
  if (state.emergency) return 'emergency';
  if (gate?.held) return 'maintenance';
  const session = state.sessions?.find(row => row.id === entry.sessionId);
  if (!session || session.archivedAt || session.appRecovery?.required) return 'session';
  if ((state.sessionDeletions ?? []).some(row => row.sessionId === session.id)) return 'deletion';
  if (session.projectId) { const project = state.projects?.find(row => row.id === session.projectId); if (!project || project.archivedAt) return 'project'; }
  const model = entry.request?.model ?? {}, provider = state.configuration?.providers?.find(row => row.id === model.providerId);
  if (!provider || provider.protocol !== model.protocol || provider.baseUrl !== model.baseUrl) return 'provider';
  let key; try { key = secret(provider); } catch { key = undefined; }
  if (typeof key !== 'string' || !key || key !== entry.request.apiKey) return 'credential';
  if (realBudgetRemaining(state) < Math.max(1, entry.promptTokens ?? 0)) return 'budget';
  return null;
}
/** A ping is a real request: its tokens count against the daily real-token budget and the conversation's usage. */
export function chargeKeepAlive(state, sessionId, usage) {
  const amount = Number(usage?.totalTokens) || promptTokens(usage) + Math.max(0, Number(usage?.output) || 0);
  if (!amount) return 0;
  chargeRealTokens(state, amount);
  const session = state.sessions?.find(row => row.id === sessionId);
  if (session?.usage) session.usage.tokens = (session.usage.tokens ?? 0) + amount;
  return amount;
}

export class CacheKeepAlive {
  /**
   * `enabled()`: whether pings may run at all (read when scheduling and again when a ping is due); `allowed(entry)`:
   * whether this conversation's ping may be sent now (keepAliveBlocked); `charge({ sessionId, projectId, usage })`:
   * account a sent ping.
   */
  constructor({ ledger, pricing = () => null, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, send = sendKeepAlive, leadMs = KEEP_ALIVE_LEAD_MS, enabled = () => true, allowed = () => true, charge = () => {} } = {}) {
    Object.assign(this, { ledger, pricing, now, setTimer, clearTimer, send, leadMs, enabled, allowed, charge });
    this.sessions = new Map(); this.started = new Map(); this.closed = false;
  }
  eligible({ sessionId, purpose, request }) {
    if (this.closed || purpose !== 'foreground' || typeof sessionId !== 'string' || !sessionId || request?.model?.protocol !== 'anthropic') return false;
    if (!anthropicFeatures(request.model).official || request.cache?.retention === 'none') return false;
    return cacheTtlMs(request.model, request.cache?.retention) === 300000;
  }
  /**
   * Any request of the conversation supersedes its idle entry: a turn extends or replaces it, and a summary (deferred,
   * manual, step-limit or idle) means the next request no longer starts from the pinged prefix. Only a completed
   * foreground request leaves a new entry.
   */
  requestStarted({ sessionId, purpose, request }) {
    if (!sessionId) return;
    this.forget(sessionId);
    if (this.eligible({ sessionId, purpose, request })) this.started.set(request, this.now());
  }
  /** `recovered`: the provider re-sent the request without some thinking (binding recovery): the body held here is not what the cache holds. */
  requestSettled({ sessionId, projectId, purpose, request, completed, usage, recovered = false }) {
    const startedAt = this.started.get(request); this.started.delete(request);
    if (!completed || recovered || startedAt === undefined || !this.eligible({ sessionId, purpose, request })) return;
    const entry = { sessionId, projectId, request, startedAt, refreshedAt: startedAt, ttlMs: cacheTtlMs(request.model, request.cache?.retention), promptTokens: promptTokens(usage), timer: null };
    // A response that streamed past the entry's lifetime (counted from the request start) left it cold: a ping now
    // would be a full write priced as a read. Only the next real request writes it again.
    if (this.expiring(entry)) return;
    this.sessions.set(sessionId, entry); this.schedule(entry);
  }
  /** Less than half the lead remains before the entry expires: a ping would not reliably land while it is warm. */
  expiring(entry) { return this.now() > entry.refreshedAt + entry.ttlMs - this.leadMs / 2; }
  /** Drop this conversation's entry (rewind, deletion, a committed compaction): its prefix is no longer the next request's. */
  forget(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    this.clearTimer(entry.timer); this.sessions.delete(sessionId);
    return true;
  }
  schedule(entry) {
    if (this.closed || !this.enabled()) { this.sessions.delete(entry.sessionId); return; }
    const delay = Math.max(0, entry.refreshedAt + entry.ttlMs - this.leadMs - this.now());
    entry.timer = this.setTimer(() => { void this.fire(entry.sessionId, entry); }, delay);
    entry.timer?.unref?.();
  }
  readShare(model) {
    const found = this.pricing({ providerId: model.providerId, modelId: model.modelId }), entry = found?.entry ?? found;
    return entry && entry.input > 0 && Number.isFinite(entry.cacheRead) ? entry.cacheRead / entry.input : DEFAULT_READ_SHARE;
  }
  gaps(sessionId) {
    const rows = this.ledger?.records?.({ since: 0 }) ?? [], foreground = rows.filter(row => row.purpose === 'foreground' && row.sessionId);
    const bySession = new Map();
    for (const row of foreground) { if (!bySession.has(row.sessionId)) bySession.set(row.sessionId, []); bySession.get(row.sessionId).push(row); }
    return { sessionGaps: returnGaps(bySession.get(sessionId) ?? []), pooledGaps: [...bySession.values()].flatMap(returnGaps) };
  }
  decide(entry) {
    return keepAliveDecision({ ...this.gaps(entry.sessionId), idleMs: this.now() - entry.startedAt, ttlMs: entry.ttlMs, readShare: this.readShare(entry.request.model) });
  }
  async fire(sessionId, entry) {
    if (this.closed || this.sessions.get(sessionId) !== entry) return;
    // Everything that could have changed while the timer ran is read again: an emergency stop, an update, a deleted or
    // archived conversation, a removed key, the budget, and a timer that fired too late to land before expiry.
    let permitted = false;
    try { permitted = this.enabled() && this.allowed(entry) && !this.expiring(entry); } catch { permitted = false; }
    if (!permitted) { this.forget(sessionId); return; }
    const decision = this.decide(entry);
    if (!decision.ping) { this.sessions.delete(sessionId); return; }
    entry.refreshedAt = this.now();
    try {
      const { usage } = await this.send({ ...entry.request, signal: AbortSignal.timeout(60000) });
      const prefixKey = requestPrefixKey(entry.request, entry.projectId);
      this.ledger?.record?.({ purpose: 'foreground', projectId: entry.projectId, sessionId, providerId: entry.request.model.providerId, modelId: entry.request.model.modelId, usage, keepAlive: true, ...(prefixKey ? { prefixKey, ttlMs: entry.ttlMs } : {}) });
      try { this.charge({ sessionId, projectId: entry.projectId, usage }); } catch { /* accounting never stops the keep-alive bookkeeping */ }
    } catch { if (this.sessions.get(sessionId) === entry) this.sessions.delete(sessionId); return; }
    if (this.sessions.get(sessionId) === entry) this.schedule(entry);
  }
  /** Until when this conversation's prompt cache is expected warm (last request or ping start + TTL), or null. */
  warmUntil(sessionId) { const entry = this.sessions.get(sessionId); return entry ? entry.refreshedAt + entry.ttlMs : null; }
  close() { this.closed = true; for (const entry of this.sessions.values()) this.clearTimer(entry.timer); this.sessions.clear(); this.started.clear(); }
}
