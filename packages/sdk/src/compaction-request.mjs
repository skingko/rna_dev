import { randomUUID } from 'node:crypto';
import { iterateCompletion, streamCompletion } from './providers.mjs';
import { defaultReasoningUsable, internalReasoningPlan, stepDownReasoning } from './reasoning-effort.mjs';
import { joinSplitSummary } from './split-turn.mjs';

/** A summary that cannot replace history: a tool call, truncation, no text, or over the size limit. The original history stays. `truncated`: the provider stopped at the output limit. */
export class SummaryError extends Error {
  constructor(message, code = 'invalid_summary', { truncated = false } = {}) { super(message); this.name = 'SummaryError'; this.code = code; if (truncated) this.truncated = true; }
}
export const MAX_SUMMARY_BYTES = 128 * 1024;
/** The provider's own default is usable for internal work when it is not its deepest level (one definition: reasoning-effort.mjs). */
export { defaultReasoningUsable };
/**
 * Reasoning for a flattened summary request when the host gives none (user decision 2: internal calls stop inheriting
 * the chat's `max`; spec p1 effort §3.1): the internal plan (internalReasoningPlan, setting 'auto') — the provider
 * default where it is usable and not deeper than the chat's choice, else the conversation's own effort (a lighter route
 * is the host's JEV judgment). A model with no reasoning on the wire keeps none.
 */
export function summaryReasoning(model) {
  if (model?.reasoning === undefined) return undefined;
  const plan = internalReasoningPlan(model);
  return plan.mode === 'fixed' ? plan.effort : plan.fallback;
}
/** One effort step below `reasoning` on this model (a summary truncated at the output limit is asked once more), or null. */
export function lighterReasoning(model, reasoning = model?.reasoning) {
  return stepDownReasoning({ ...model, reasoning }) ?? null;
}
const blankUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costStatus: 'unpriced' });
function redactor(values) {
  const secrets = [...new Set((values ?? []).filter(value => typeof value === 'string' && value).flatMap(value => [value, encodeURIComponent(value)]))].sort((a, b) => b.length - a.length);
  return text => { let value = String(text ?? ''); for (const secret of secrets) value = value.split(secret).join('[REDACTED]'); return value; };
}

/**
 * One summary request, streamed (spec p1 compaction §C3). Session compaction and the host's detached idle compaction
 * both use it. `request`: `{ systemPrompt, messages, cache }` (see summaryRequestFor). `ledger` rides on the provider
 * request for the host's metering (`{ trigger }`); providers ignore it. `receipt` (optional) is filled as the stream
 * goes, so a caller can account for a failed request's usage; a failure also carries it as `error.receipt`.
 */
export async function generateSummary({ provider = streamCompletion, model, apiKey, request, tools = [], toolChoice, maxOutputTokens, signal, redactValues = [], redact, ledger, purpose = 'compaction', requestId = randomUUID(), receipt = {}, estimatedInputTokens } = {}) {
  if (!model?.modelId || !model?.providerId || !request?.systemPrompt || !Array.isArray(request.messages)) throw new SummaryError('A configured model and a summary request are required.', 'invalid_options');
  const clean = typeof redact === 'function' ? redact : redactor([apiKey, ...redactValues]);
  Object.assign(receipt, { requestId, usage: blankUsage(), usageReported: false, startedAt: Date.now() });
  let summary = '', complete = false;
  try {
    // `tools` only for a request that shares the conversation's cached prefix (compaction fork); a summary never runs a tool.
    for await (const event of iterateCompletion(provider, { model: { ...structuredClone(model), ...(Number.isInteger(maxOutputTokens) ? { maxOutputTokens } : {}) }, apiKey, systemPrompt: request.systemPrompt, messages: request.messages, tools, ...(toolChoice ? { toolChoice } : {}), purpose, signal, cache: request.cache, ...(ledger ? { ledger } : {}), ...(Number.isFinite(estimatedInputTokens) ? { estimatedInputTokens } : {}) })) {
      // What streamed (summary and reasoning): the output part of an unreported request's estimate.
      if (event.type === 'text_delta' || event.type === 'thinking_delta') receipt.streamedBytes = (receipt.streamedBytes ?? 0) + Buffer.byteLength(String(event.delta ?? ''));
      if (event.type === 'text_delta') summary += clean(String(event.delta ?? ''));
      else if (event.type === 'tool_call') throw new SummaryError('Summary unexpectedly requested a tool; original history retained.');
      else if (event.type === 'usage') { receipt.usageReported = true; receipt.usage.cacheUsageReported = event.usage?.cacheUsageReported === true; for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) if (Number.isFinite(event.usage?.[key]) && event.usage[key] >= 0) receipt.usage[key] = event.usage[key]; }
      else if (event.type === 'done') { if (event.stopReason === 'length') throw new SummaryError('Summary was truncated; original history retained.', 'invalid_summary', { truncated: true }); complete = true; }
      if (Buffer.byteLength(summary) > MAX_SUMMARY_BYTES) throw new SummaryError('Summary exceeded size limit.');
    }
    signal?.throwIfAborted();
    if (!complete || !summary.trim()) throw new SummaryError('Provider did not complete a factual summary; original history retained.');
    receipt.completedAt = Date.now();
    return { summary, usage: receipt.usage, usageReported: receipt.usageReported, requestId, startedAt: receipt.startedAt, completedAt: receipt.completedAt };
  } catch (error) {
    receipt.completedAt = Date.now();
    try { error.receipt = { ...receipt }; } catch {}
    throw error;
  }
}

/**
 * The summary of an idle plan (`session.prepareCompaction()`): every entry of `plan.requests` in order, each through
 * `run(entry, index)` (the host's one summary request: reservation, metering, retries; it returns what generateSummary
 * returns), and the texts joined — one `summary` request is the summary itself; a split plan's `history` and `turn_prefix`
 * become one checkpoint (joinSplitSummary; with no history request the previous summary, `plan.baseSummary`, stands in).
 * `done` (a Map index → result) keeps the requests already paid for when the caller retries after a failure of a later
 * one. Usage is summed; `usageReported` only when every request reported; `requestId` is the first request's.
 */
export async function generatePlanSummary({ plan, run, done = new Map() } = {}) {
  const entries = Array.isArray(plan?.requests) && plan.requests.length ? plan.requests : [{ kind: 'summary', request: plan?.request, maxOutputTokens: plan?.maxOutputTokens }];
  if (typeof run !== 'function') throw new SummaryError('A summary runner is required.', 'invalid_options');
  const results = [];
  for (let index = 0; index < entries.length; index++) {
    if (!done.has(index)) done.set(index, await run(entries[index], index));
    results.push(done.get(index));
  }
  if (entries.length === 1 && entries[0].kind === 'summary') return results[0];
  const text = kind => results[entries.findIndex(entry => entry.kind === kind)]?.summary ?? null;
  const summary = joinSplitSummary({ history: text('history') ?? plan.baseSummary ?? null, turnPrefix: text('turn_prefix') ?? '' });
  if (Buffer.byteLength(summary) > MAX_SUMMARY_BYTES) throw new SummaryError('Summary exceeded size limit.');
  const usage = blankUsage();
  for (const result of results) for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) usage[key] += Math.max(0, Number(result.usage?.[key]) || 0);
  usage.cacheUsageReported = results.every(result => result.usage?.cacheUsageReported === true);
  return { summary, usage, usageReported: results.every(result => result.usageReported === true), requestId: results[0].requestId, requestIds: results.map(result => result.requestId), startedAt: results[0].startedAt, completedAt: results.at(-1).completedAt };
}
