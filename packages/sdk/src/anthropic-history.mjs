// History policy for Anthropic preserved thinking (docs: preserved thinking, "the conversation check").
//
// A thinking block is valid only while the top-level system prompt, the set of tools and every message before it
// are byte-identical to the request that produced it, and while the blocks before it form an unbroken chain. Rna
// keeps the Anthropic projection append-only and moves one durable marker, the thinking floor, forward instead:
// a journaled `thinking_rebase {throughMessageId}` removes every thinking / redacted-thinking block at or before
// that message from Anthropic requests (removing a leading run of blocks is valid; a removed block never comes
// back). History economies (settle, prune, fold, history-image flips) apply on an append-only target only to
// messages at or before the floor, so they take effect at the next rebase instead of rewriting a warm prefix.
//
// Other history-editing code consults `appendOnlyActive(model)` (or `historyEditing(model)` from
// anthropic-features.mjs) and, when it must change the projection at once, journals through `commitWithRebase`.
import { randomUUID } from 'node:crypto';
import { historyEditing } from './anthropic-features.mjs';

/** Why the floor moved. The first five are the only rebase points on an append-only target. */
export const THINKING_REBASE_REASONS = Object.freeze(['compaction', 'image_budget', 'context_pressure', 'prefix_changed', 'binding_rejected', 'binding_dropped', 'invalid_signature', 'revoked']);
/** Lead of an appended system-prompt revision (model-facing, English like the other host leads). */
export const SYSTEM_PROMPT_UPDATE_LEAD = '[Operator system prompt revised. From here on this text replaces the original system prompt in full; where they differ, follow this version.]';
export const SYSTEM_PROMPT_SOURCE = 'system-prompt';

/** True when provider-visible history for this model must stay append-only between rebases. */
export const appendOnlyActive = model => historyEditing(model) === 'append-only';

/** Index of the floor message in `messages`, or -1 (no floor, or the message is gone). */
export const floorIndexOf = (messages, floorId) => typeof floorId === 'string' && floorId ? messages.findIndex(message => message.id === floorId) : -1;

/** Assistant message ids whose thinking an Anthropic request omits (at or before the floor). */
export function thinkingStripSet(messages, floorId) {
  const end = floorIndexOf(messages, floorId), ids = new Set();
  for (let index = 0; index <= end; index++) if (messages[index].role === 'assistant') ids.add(messages[index].id);
  return ids;
}

/** A cold break: the provider cache has expired since the last request started (exported for idle-time work). */
export function coldBreak({ lastRequestStartedAt, now = Date.now(), ttlMs } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  return !Number.isFinite(lastRequestStartedAt) || now - lastRequestStartedAt >= ttlMs;
}

/** Apply a replayed or new `thinking_rebase` record: the floor only moves forward. */
export function applyThinkingRebase(state, data) {
  if (!data || typeof data.throughMessageId !== 'string' || !THINKING_REBASE_REASONS.includes(data.reason)) return false;
  const next = floorIndexOf(state.messages, data.throughMessageId);
  if (next < 0) return false;
  if (floorIndexOf(state.messages, state.thinkingFloor?.throughMessageId) > next) return false;
  state.thinkingFloor = { id: data.id, throughMessageId: data.throughMessageId, reason: data.reason };
  return true;
}

/** After a rewind dropped the floor message, the floor stays at the last remaining message: nothing is put back. */
export function clampThinkingFloor(state, droppedIds) {
  if (!state.thinkingFloor || !droppedIds.has(state.thinkingFloor.throughMessageId)) return;
  const last = state.messages.at(-1);
  state.thinkingFloor = last ? { ...state.thinkingFloor, throughMessageId: last.id, clamped: true } : null;
}

/**
 * Journal `records` (each `[type, data]`) and the rebase that makes them valid on Anthropic, in one synchronous
 * step: a crash cannot keep a projection change without its rebase. The floor moves to `throughMessageId`
 * (default: the newest message). Returns the rebase record data, or null when there is no message to rebase to.
 */
export function commitWithRebase(append, state, { reason, records = [], throughMessageId = state.messages.at(-1)?.id, requestId } = {}) {
  if (!THINKING_REBASE_REASONS.includes(reason)) throw new Error(`Unknown thinking rebase reason: ${reason}`);
  for (const [type, data] of records) append(type, data);
  if (typeof throughMessageId !== 'string') return null;
  const data = { id: randomUUID(), throughMessageId, reason, ...(requestId ? { requestId } : {}), at: Date.now() };
  append('thinking_rebase', data);
  applyThinkingRebase(state, data);
  return data;
}

/** A partial response (aborted, failed or interjected) never replays its reasoning: unsigned thinking is not sent
 * and redacted blocks are dropped, so the assistant message keeps only what was said. */
export function unsignIncomplete(message) {
  if (!Array.isArray(message?.content)) return message;
  message.content = message.content.filter(part => part.type !== 'redactedThinking').map(part => {
    if (part.type !== 'thinking' || part.signature === undefined) return part;
    const { signature, ...rest } = part; return rest;
  });
  return message;
}
