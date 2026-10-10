import { digest } from './journal.mjs';
import { historyEditing } from './anthropic-features.mjs';

/**
 * Cache survival (spec p1 compaction §A): whether two requests of one conversation are structurally continuous,
 * and after how long an idle provider prompt cache has been observed cold. Pure functions; the host keeps samples.
 *
 * Structural continuity is enough to say "this request's projected messages extend the previous request's byte for
 * byte": the projection depends only on the journal (append-only) and on these inputs, and every edit Rna makes to
 * earlier history (compaction, fold, settle, prune, forget, image offload, history images, model or prefix change, an
 * Anthropic thinking rebase) changes one of them. No per-message digests are needed.
 */

/** Gaps under this carry no survival information (1340 of 1347 live GLM samples under a minute were warm). */
export const SURVIVAL_MIN_GAP_MS = 60000;
/** Warm when at least this share of the previous prompt was read from cache: the middle of the empty band of a bimodal distribution (0 of 1,745 live samples between 0.1 and 0.9). */
export const SURVIVAL_WARM_SHARE = 0.5;
/** Samples older than this leave the estimate (an evidence window, like the ledger's 7 days). */
export const SURVIVAL_MAX_AGE_MS = 30 * 86400000;
/**
 * An edited request (economy edits at a cold break, `continuity.edited`) is a sample only when the part of the
 * previous prompt before its first edit is at least this share of it: the conversation's own messages then dominate
 * what can be read, so a cache other conversations keep warm (system prompt, tools, seeded context) cannot pass for
 * this conversation's survival.
 */
export const SURVIVAL_EDITED_MIN_SHARE = 0.5;

/** A stable signature of the history images a request presented as text (prepareContext `imageHistory`); null when none. */
export function historyImagesSignature(history) {
  if (!history?.size) return null;
  const rows = [];
  for (const [id, marks] of history) for (const [index, mark] of marks ?? []) rows.push(`${id}:${index}:${mark?.reason ?? ''}`);
  return rows.length ? digest(rows.sort()).slice(0, 32) : null;
}

/** `prev`: the last assistant message whose usage was reported; `cur`: the new request's assistant message (same fields). */
export function structuralContinuity(prev, cur) {
  if (!prev || !cur || typeof prev.contextPrefixHash !== 'string' || !prev.contextPrefixHash) return false;
  return prev.contextPrefixHash === cur.contextPrefixHash && prev.model === cur.model && prev.provider === cur.provider
    && (prev.contextCompactionId ?? null) === (cur.contextCompactionId ?? null)
    && (prev.contextForgetSeq ?? 0) === (cur.contextForgetSeq ?? 0)
    && (prev.contextImageOffloadId ?? null) === (cur.contextImageOffloadId ?? null)
    && (prev.contextHistoryImages ?? null) === (cur.contextHistoryImages ?? null)
    // Anthropic preserved thinking: a thinking rebase strips earlier thinking blocks (anthropic-history.mjs).
    && (prev.contextThinkingFloorId ?? null) === (cur.contextThinkingFloorId ?? null);
}

/** Tokens the previous request sent (uncached input + cache read + cache write). */
export const promptTokens = usage => ['input', 'cacheRead', 'cacheWrite'].reduce((sum, key) => sum + Math.max(0, Number(usage?.[key]) || 0), 0);

/**
 * The ledger's continuity block for a request: null without a previous served request. A request that only economy
 * edits made discontinuous (the session's `contextEdits`: the previous request it extends and the share of that
 * request's prompt before the first edited message) also carries `edited.comparableTokens`, the part of the previous
 * prompt it could still read from cache.
 */
export function requestContinuity(prev, cur) {
  if (!prev || !Number.isFinite(prev.timestamp) || !Number.isFinite(cur?.timestamp)) return null;
  const continuous = structuralContinuity(prev, cur), previousPromptTokens = promptTokens(prev.usage);
  const share = !continuous && cur.contextEdits?.previousId === prev.id && prev.id ? Number(cur.contextEdits.unchangedShare) : NaN;
  return { continuous, gapMs: Math.max(0, Math.round(cur.timestamp - prev.timestamp)), previousPromptTokens, ...(share > 0 && share <= 1 ? { edited: { comparableTokens: Math.round(previousPromptTokens * share) } } : {}) };
}

/**
 * One survival sample from a continuity block and the reported cache read, or null when it carries no information.
 * An edited request (`continuity.edited`) is compared with the part of the previous prompt it left unchanged.
 */
export function survivalSample({ continuity, cacheReported, cacheRead, at } = {}) {
  // `bridged`: the host refreshed this conversation's cache during the gap (keep-alive pings), so the gap says nothing
  // about how long an idle cache survives; counting it warm would push a documented TTL out of the estimate.
  const edited = continuity?.continuous === false && Number.isFinite(Number(continuity.edited?.comparableTokens));
  if (!(continuity?.continuous === true || edited) || continuity.bridged === true || cacheReported !== true || !Number.isFinite(continuity.gapMs) || continuity.gapMs < SURVIVAL_MIN_GAP_MS) return null;
  let prompt = Number(continuity.previousPromptTokens);
  if (!Number.isFinite(prompt) || prompt <= 0) return null;
  if (edited) { const comparable = Number(continuity.edited.comparableTokens); if (comparable < SURVIVAL_EDITED_MIN_SHARE * prompt) return null; prompt = comparable; }
  const time = typeof at === 'string' ? Date.parse(at) : Number(at);
  if (!Number.isFinite(time)) return null;
  return { gapMs: Math.round(continuity.gapMs), warm: Math.max(0, Number(cacheRead) || 0) >= SURVIVAL_WARM_SHARE * prompt, prompt: Math.round(prompt), at: time };
}

/**
 * The learned cold gap of one provider/model: the smallest cold gap above the largest warm gap.
 * - cold samples with a prompt smaller than every warm one are dropped (under the provider's minimum cacheable size);
 * - cold samples at or below the largest warm gap (provider-side evictions) never lower the estimate;
 * - without a warm sample, or without a cold one above the warm range, there is no estimate (null).
 */
export function survivalFromSamples(samples = [], { now = Date.now(), maxAgeMs = SURVIVAL_MAX_AGE_MS } = {}) {
  const live = (Array.isArray(samples) ? samples : []).filter(row => row && Number.isFinite(row.gapMs) && row.gapMs >= 0 && Number.isFinite(row.prompt) && Number.isFinite(row.at) && now - row.at <= maxAgeMs && row.at <= now + 60000);
  const warm = live.filter(row => row.warm === true);
  if (!warm.length) return { coldAfterMs: null, warmMaxMs: null, samples: live.length };
  const minWarmPrompt = Math.min(...warm.map(row => row.prompt)), warmMaxMs = Math.max(...warm.map(row => row.gapMs));
  const cold = live.filter(row => row.warm !== true && row.prompt >= minWarmPrompt && row.gapMs > warmMaxMs);
  return { coldAfterMs: cold.length ? Math.min(...cold.map(row => row.gapMs)) : null, warmMaxMs, samples: live.length };
}

/**
 * Provider prompt-cache lifetime (ms) of a request, or null when the provider documents none (DeepSeek/GLM/Qwen/Kimi
 * are best-effort caches). Anthropic: 5 minutes, 1 hour for long retention (the rule providers.mjs applies to
 * cache_control.ttl). OpenAI: only the explicit 24h retention.
 */
export function cacheTtlMs(model, retention = model?.cacheRetention ?? 'short') {
  if (!model || retention === 'none') return null;
  if (model.protocol === 'anthropic') return retention === 'long' && model.compat?.supportsLongCacheRetention !== false ? 3600000 : 300000;
  if (model.protocol === 'openai' && retention === 'long' && model.compat?.supportsLongCacheRetention === true) return 86400000;
  return null;
}

/**
 * The one cold-gap rule (both the session's economy point and the host's idle compaction use it): the documented TTL
 * where the provider documents one (Anthropic) and no warm sample outlived it, else the learned survival
 * (`survivalFromSamples`); `coldAfterMs` null means no idle economy. Compare a gap against it with `coldBreak`
 * (anthropic-history.mjs).
 */
export function coldAfterMs(model, learned = null) {
  const documentedTtlMs = cacheTtlMs(model), warmMaxMs = learned?.warmMaxMs ?? null;
  if (documentedTtlMs !== null && (warmMaxMs ?? 0) <= documentedTtlMs) return { coldAfterMs: documentedTtlMs, warmMaxMs, documentedTtlMs, source: 'documented' };
  const value = Number.isSafeInteger(learned?.coldAfterMs) && learned.coldAfterMs > 0 ? learned.coldAfterMs : null;
  return { coldAfterMs: value, warmMaxMs, documentedTtlMs, source: value === null ? null : 'learned' };
}

/**
 * How Rna may edit earlier model history for this model (fold, settle, prune, forget at economy points; idle
 * compaction). One source of truth for Anthropic preserved thinking: `historyEditing(model)` (anthropic-features.mjs).
 * - 'free': edits commit at cold breaks (or warm, when they free a real share of the context);
 * - 'rebase': the provider-visible history is append-only between thinking rebases (anthropic-history.mjs). An edit
 *   takes effect only at or before the thinking floor, so it commits only at a rebase point: journaled together with
 *   a `thinking_rebase` (commitWithRebase: compaction, context pressure) or right after one, before any response
 *   follows the floor. There is no standalone cold-break rebase;
 * - 'none': another provider path declared itself append-only without a rebase (the flag may sit on the model, its
 *   compat block, its capabilities or the provider function): no economy edits and no idle compaction.
 */
export function historyEditMode(model, provider) {
  if (historyEditing(model) === 'append-only') return 'rebase';
  const declares = value => Boolean(value) && (value.appendOnly === true || value.historyEditing === 'none' || value.historyEdits === 'none');
  return declares(model) || declares(model?.compat) || declares(model?.capabilities) || declares(provider) || declares(provider?.meteredBase) ? 'none' : 'free';
}
/** Whether earlier history may be edited outright at a cold break (`historyEditMode` is 'free'). */
export const historyEditsAllowed = (model, provider) => historyEditMode(model, provider) === 'free';
