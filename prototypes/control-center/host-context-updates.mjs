// What a conversation's model can currently see of each named host context (spec p1 compaction TC-2/MIND-6), and the
// updates worth offering to the SDK on a request: only those whose latest visible copy differs, within the request
// hook's byte allowance. The SDK deduplicates by revision as well; filtering here keeps the hook's payload (which the
// SDK bounds as a whole) to what is actually new.
import { LEGACY_MIND_KEY, MIND_CONTEXT_KEYS, legacyMindTombstone } from './project-mind.mjs';
import { LEGACY_COLLABORATION_KEY, COLLABORATION_ENTRY_PREFIX, COLLABORATION_PENDING_KEY, legacyCollaborationTombstone, projectConversationUpdates } from './project-conversation-context.mjs';

/** The SDK's request-hook allowance is 256 KiB for all updates together; the host keeps a margin. */
export const HOST_UPDATE_BYTES = 240 * 1024;
const textOf = message => Array.isArray(message?.context) && message.context.length === 1 ? message.context[0] : null;
const isTurnStart = message => message?.role === 'user' && ['user', 'followUp'].includes(message.source);

/**
 * key → { source, text, scope, accumulates, visible, currentTurn } for the latest copy of each named context in a snapshot.
 * `withdrawn` (C4): key → the cut of a revocation that named it (ms). The SDK folds every copy of the key made no later than
 * the cut to one line (reason `revoked`), so a latest copy at or before it is not what the model reads: the key counts as
 * absent and the host offers its current content again. Without this the copy that was just folded would match the current
 * text, be filtered as "already visible", and the block (the project's standing rules among them) would never come back.
 */
export function visibleContext(snapshot, { withdrawn = null } = {}) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const boundary = snapshot?.compaction?.throughMessageId ? messages.findIndex(message => message.id === snapshot.compaction.throughMessageId) : -1;
  const latest = new Map(); let lastTurn = -1;
  messages.forEach((message, index) => { if (message?.contextKey) latest.set(message.contextKey, { message, index }); if (isTurnStart(message)) lastTurn = index; });
  const result = new Map();
  for (const [key, { message, index }] of latest) {
    const cut = withdrawn?.get(key);
    if (Number.isFinite(cut) && (message.timestamp ?? 0) <= cut) continue;
    const block = textOf(message), scope = message.contextScope ?? 'conversation';
    result.set(key, { source: block?.source ?? null, text: block?.text ?? null, scope, accumulates: message.contextAccumulates === true, visible: index > boundary || scope === 'conversation', currentTurn: index > lastTurn });
  }
  return result;
}

/** Updates whose latest visible copy differs (a turn-scoped note only counts within the current turn; declaring a key accumulating is a difference). */
export function freshUpdates(updates, visible) {
  return updates.filter(update => {
    const seen = visible.get(update.key);
    if (!seen || !seen.visible || seen.source !== update.source || seen.text !== update.text || (update.accumulates === true) !== (seen.accumulates === true)) return true;
    return (update.scope ?? 'conversation') === 'turn' && !seen.currentTurn;
  });
}

/** The SDK accepts at most 64 updates per request; the host keeps a margin. */
export const HOST_UPDATE_COUNT = 60;
/**
 * Keep the hook payload within the allowance: the oldest delivered-message entries go first (they are offered again).
 * A withdrawal is never dropped (MC-6): it is tiny, and without it the request would present a deleted or revoked
 * message as current.
 */
export function boundUpdates(updates, limit = HOST_UPDATE_BYTES, count = HOST_UPDATE_COUNT) {
  const kept = updates.map(({ empty: _empty, withdrawn, ...update }) => ({ update, withdrawn: withdrawn === true }));
  const size = () => Buffer.byteLength(JSON.stringify(kept.map(row => row.update)), 'utf8');
  while (kept.length > count || size() > limit) {
    const index = kept.findIndex(row => !row.withdrawn && row.update.key.startsWith(COLLABORATION_ENTRY_PREFIX));
    if (index < 0) break;
    kept.splice(index, 1);
  }
  return kept.map(row => row.update);
}

/**
 * MIND-6: the three mind blocks for this turn. A block with nothing in it is sent only to replace an earlier copy the
 * conversation holds; the rules block (which carries the instruction) rides whenever any block is sent; a
 * conversation that still holds the pre-0.66 single block gets its tombstone once.
 */
export function mindUpdates(value, visible) {
  const updates = Array.isArray(value) ? value : value ? [value] : [];
  const chosen = updates.filter(update => !update.empty || visible.has(update.key));
  if (chosen.length && !chosen.some(update => update.key === MIND_CONTEXT_KEYS.rules)) { const rules = updates.find(update => update.key === MIND_CONTEXT_KEYS.rules); if (rules) chosen.unshift(rules); }
  const legacy = visible.get(LEGACY_MIND_KEY), tombstone = legacyMindTombstone();
  if (legacy && legacy.text !== tombstone.text) chosen.push(tombstone);
  return chosen;
}

/** The collaboration handoff as per-entry updates (plus the legacy block's tombstone once). */
export function collaborationUpdates(session, project, visible) {
  const visibleKeys = [...visible].filter(([key, row]) => key.startsWith(COLLABORATION_ENTRY_PREFIX) && row.visible).map(([key]) => key);
  const updates = projectConversationUpdates(session, project, { visibleKeys, seenPending: visible.get(COLLABORATION_PENDING_KEY)?.visible === true }) ?? [];
  // The tombstone declares the legacy sliding window accumulating (FOLD-1): sent once, or once more to a conversation
  // whose tombstone predates the declaration.
  const legacy = visible.get(LEGACY_COLLABORATION_KEY), tombstone = legacyCollaborationTombstone();
  if (legacy && (legacy.text !== tombstone.text || legacy.accumulates !== true)) updates.push(tombstone);
  return updates;
}
