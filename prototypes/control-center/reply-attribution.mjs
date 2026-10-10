import { proactiveRowKind } from './proactive-pacing.mjs';
import { MAX_REPLY_CANDIDATES } from '../../packages/sdk/src/decision-templates.mjs';

// Reply attribution (P2 batch C, C3; plan §2.3 #2): which earlier message a user message is about. F3 (the delivery
// ledger settles "replied" against the wrong share) and EVO-2 (evolution credits a correction to the wrong turn) were the
// same mistake: both guessed from order, "the next message is about the last thing". Headlong's reply says which message it
// answers: `reply_to` is stamped at the transport (bin/chat:176-230), so "has this message been answered" is a fact in the
// log, and only when the sender does not say does it default to the latest unanswered inbound (B3's rule here); its backoff
// counts only a message addressed to the mind as engagement (monolith_backoff.md:186-189, the guard F7 applied to status
// lines). Rna has no transport that can stamp the user's message (the composer does not say which share it answers), so the
// target is recovered from what a model said the message reacts to:
//  1. `replyTo`, written by `attributeReply` below: the focused JEV question `reply.target`, which sees every recent
//     proactive message in full, a question card the user has not answered included (the labelled probe,
//     docs/research/jev-reply-target-probe-20261005.md: 41 of 42 right against 24 for the capture's own question, which sees the
//     newest output in full and the others in 180 characters, and never a card; the card set: no wrong pick in 57 calls);
//  2. `capture.target`, by who named it (`capture.targetSource`): `jev` and `fast_model` name an output, `heuristic` (the
//     regex fallback's "the latest output") names nothing;
//  3. nothing: the caller falls back to its order rule (the delivery ledger: B3's one-message-one-reply rule; evolution:
//     the previous turn).
// Pure helpers plus one async step; the readers decide what to do with a target (settle a share, credit a turn or a run).

const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
/** A message whose turn is still running waits this long for its capture before it is read without one (project-mind CAPTURE_AWAIT_MAX_MS: the route's budget, the fast model's own limit and the queue). */
export const CAPTURE_WAIT_MS = 120000;
/** How far back a delivery can still be what a message answers: the ledger's longest reaction window (feedbackWindowMs, 2 days). */
export const REPLY_HORIZON_MS = 2 * DAY;
/**
 * Questions that got no answer (the judge unreachable, over its cap, timed out) are asked again after these waits (the nth
 * entry follows the nth failure) and then given up: the message falls back to order. A network that is only just back (a
 * laptop waking) or a provider that is down for minutes must not spend the attempts: the pump ticks every 30 seconds, and
 * three ticks in a row would have handed an unrelated message to the order rule for good. About an hour and a half in all.
 */
export const REPLY_RETRY_MS = Object.freeze([MINUTE, 5 * MINUTE, 20 * MINUTE, HOUR]);
export const REPLY_ASK_ATTEMPTS = REPLY_RETRY_MS.length + 1;
const at = value => Date.parse(value);
const retained = item => !item.sourceDeleted && !item.contextRevoked;
const textOf = item => typeof item?.text === 'string' ? item.text : '';
/** A question card the host put in the conversation on its own (an ask, a direct fix to keep or revert): a proactive message that is not an assistant item. */
const isCard = item => item?.kind === 'question' && item.interaction?.source === 'initiative';
/** What a card shows the user, as the text a reply could answer: each question, with its options. */
export function cardText(item) {
  return (item?.interaction?.questions ?? []).map(row => {
    const options = (Array.isArray(row?.options) ? row.options : []).map(option => option?.label).filter(label => typeof label === 'string' && label.trim());
    return [typeof row?.question === 'string' && row.question.trim() ? row.question.trim() : row?.header, options.length ? `(options: ${options.join(' / ')})` : ''].filter(Boolean).join(' ');
  }).filter(Boolean).join('\n');
}

/**
 * What a message's capture says it is about, by who said so: `{ itemId, source, via: 'capture' }` for an assistant output
 * a model named (`jev`, `fast_model`); `{ itemId: null }` when JEV judged it reacts to nothing earlier; null when nothing
 * usable was said (no capture, JEV abstained, the regex fallback, or a thread: a topic, not an item).
 */
export function capturedTarget(capture) {
  if (!capture || typeof capture !== 'object') return null;
  const source = capture.targetSource;
  if (source !== 'jev' && source !== 'fast_model') return null;
  if (capture.target === null) return source === 'jev' ? { itemId: null, source, via: 'capture' } : null;
  return capture.target?.kind === 'output' && typeof capture.target.itemId === 'string' ? { itemId: capture.target.itemId, source, via: 'capture' } : null;
}
/** The verdict `attributeReply` stored on a user message, when it has one (not an abstention, a shadow run or a failed ask). */
export function storedTarget(item) {
  const row = item?.replyTo;
  if (!row || row.source !== 'jev' || row.abstained === true || row.shadow === true || row.attempts !== undefined || !('itemId' in row)) return null;
  return { itemId: typeof row.itemId === 'string' ? row.itemId : null, source: 'jev', via: 'reply.target', ...(row.kind ? { kind: row.kind } : {}) };
}
/** The target of a user message (see the order above), or null: the caller's order rule applies. */
export const replyTargetOf = item => storedTarget(item) ?? capturedTarget(item?.capture);
/**
 * True while a user message's capture is still on its way: the project mind announced it (`announced`, ids) or its turn is the
 * conversation's running one and the capture has not landed (the stretch between admitting the message and the route, where
 * the previous turn's hand-back may be settling first). Read without it, the order rule would settle a share for good.
 */
export function captureAwaited(session, message, { announced = null, now = Date.now() } = {}) {
  if (message?.capture !== undefined) return false;
  if (announced?.has(message.id)) return true;
  const running = session?.activeTurnId && session.turns?.some(turn => turn.id === session.activeTurnId && turn.userItemId === message.id);
  return Boolean(running) && now - at(message.createdAt) < CAPTURE_WAIT_MS;
}

/** What the user was told that a message could answer, newest first (their kind, for the judge), and the latest foreground reply. */
const KIND = { scheduled: 'scheduled report', digest: 'daily digest', welcome_back: 'welcome-back summary' };
export const deliveryKindOf = item => isCard(item) ? 'question card' : KIND[item?.initiative?.kind] ?? 'finding';
/**
 * Candidates for the question `reply.target`: the proactive messages in the conversation before `userItem` that are still
 * within the ledger's longest reaction window (at most MAX_REPLY_CANDIDATES, newest first), and the assistant's latest
 * reply to the user's own request when one came after the oldest of them (so a message about that reply is not forced
 * onto a share). A question card the host asked (an ask, a direct fix to keep or revert) is one of them while the user had
 * not answered it: a typed "iOS" is a reply to it, and no capture can name it (a capture reads assistant outputs only).
 * Empty `deliveries` means there is nothing to attribute.
 */
export function replyCandidates(session, userItem, { limit = MAX_REPLY_CANDIDATES } = {}) {
  const items = session?.items ?? [], index = items.findIndex(row => row.id === userItem?.id), before = index < 0 ? [] : items.slice(0, index), time = at(userItem?.createdAt);
  const shown = row => row.kind === 'assistant' && retained(row) && !row.streaming && textOf(row).trim();
  const open = row => !['answered', 'cancelled'].includes(row.interaction.status) || at(row.interaction.answeredAt ?? row.interaction.updatedAt) > time;
  const offered = row => (shown(row) || isCard(row) && retained(row) && open(row) && cardText(row).trim()) && proactiveRowKind(row) === 'delivery';
  const horizon = Number.isFinite(time) ? time - REPLY_HORIZON_MS : -Infinity;
  const picked = before.map((row, position) => ({ row, position })).filter(({ row }) => offered(row) && at(row.createdAt) >= horizon).slice(-limit);
  const deliveries = picked.map(({ row }) => ({ id: row.id, kind: deliveryKindOf(row), text: isCard(row) ? cardText(row) : textOf(row) })).reverse();
  const oldest = picked[0]?.position ?? -1;
  const latest = oldest < 0 ? null : before.slice(oldest + 1).reverse().find(row => shown(row) && row.turnId);
  return { deliveries, latestReply: latest ? { id: latest.id, text: textOf(latest) } : null };
}
/** False while an unanswered ask is still inside its back-off: the judge was tried a moment ago and is not asked again yet. */
export function retryDue(stored, now = Date.now()) {
  if (!stored || stored.attempts === undefined) return true;
  const wait = REPLY_RETRY_MS[Math.min(Math.max(stored.attempts, 1), REPLY_RETRY_MS.length) - 1], since = at(stored.at);
  return !Number.isFinite(since) || now >= since + wait;
}
/** True while the focused question can still be asked about this message: it has candidates and no answer, shadow run or spent attempts. */
export function replyAskable(session, userItem) {
  if (!userItem || userItem.kind !== 'user' || !retained(userItem) || !textOf(userItem).trim()) return false;
  const stored = userItem.replyTo;
  if (stored && (stored.attempts === undefined || stored.attempts >= REPLY_ASK_ATTEMPTS)) return false;
  return replyCandidates(session, userItem).deliveries.length > 0;
}

const inflight = new Map();
/**
 * Asks `reply.target` about one user message and keeps the answer on the message (`replyTo`), once: a verdict
 * `{ itemId, kind: 'delivery' | 'latest_reply' | 'none' }`, an abstention or shadow run (never asked again), or the count
 * of asks the judge did not answer (asked again after REPLY_RETRY_MS, REPLY_ASK_ATTEMPTS in all, then the message falls back
 * to order). Returns what is stored, or null when nothing was asked (no candidates, judge off, nothing to read). A message
 * still inside the back-off of an unanswered ask gets the stored count back without a call. Concurrent callers share one question.
 */
export function attributeReply(store, decisions, { sessionId, itemId, mutate = fn => store.mutate(fn), now = () => Date.now(), signal } = {}) {
  const key = `${sessionId}:${itemId}`;
  if (inflight.has(key)) return inflight.get(key);
  const work = (async () => {
    if (typeof decisions?.replyTarget !== 'function' || decisions.enabled?.('reply.target') !== true) return null;
    const session = store.state.sessions.find(row => row.id === sessionId), item = session?.items.find(row => row.id === itemId);
    if (!session || !item || !replyAskable(session, item)) return item?.replyTo ?? null;
    // A question the judge did not answer waits out its back-off (REPLY_RETRY_MS) before it is asked again.
    if (!retryDue(item.replyTo, now())) return item.replyTo;
    const { deliveries, latestReply } = replyCandidates(session, item), project = store.state.projects.find(row => row.id === session.projectId);
    const answer = await decisions.replyTarget(project ?? null, { message: textOf(item), deliveries: deliveries.map(({ kind, text }) => ({ kind, text })), latestReply: latestReply?.text ?? '', signal }).catch(() => null);
    const stamp = new Date(now()).toISOString(), previous = item.replyTo?.attempts ?? 0;
    let row;
    if (!answer) row = { source: 'jev', at: stamp, attempts: previous + 1 };
    else if (answer.shadow) row = { source: 'jev', at: stamp, shadow: true };
    else if (typeof answer.target === 'number' && deliveries[answer.target]) row = { source: 'jev', at: stamp, itemId: deliveries[answer.target].id, kind: 'delivery', ...(answer.ledgerId ? { ledgerId: answer.ledgerId } : {}) };
    else if (answer.target === null) row = { source: 'jev', at: stamp, itemId: answer.other === 'latest_reply' && latestReply ? latestReply.id : null, kind: answer.other === 'latest_reply' && latestReply ? 'latest_reply' : 'none', ...(answer.ledgerId ? { ledgerId: answer.ledgerId } : {}) };
    else row = { source: 'jev', at: stamp, abstained: true, ...(answer.ledgerId ? { ledgerId: answer.ledgerId } : {}) };
    mutate(state => { const live = state.sessions.find(value => value.id === sessionId)?.items.find(value => value.id === itemId); if (live && !live.sourceDeleted) live.replyTo = row; });
    return row;
  })().finally(() => inflight.delete(key));
  inflight.set(key, work);
  return work;
}
