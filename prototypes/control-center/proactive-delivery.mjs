import { deriveProjectTaskTypes } from '../../packages/sdk/src/skill-foundation-screen.mjs';
import { randomUUID } from 'node:crypto';
import { REACH_TIERS, reachRank, lowerReach, proactiveMessageViolations, oneLine } from '../../packages/sdk/src/proactive-message.mjs';
import { proactiveRowKind } from './proactive-pacing.mjs';
import { replyTargetOf, replyAskable, attributeReply, captureAwaited } from './reply-attribution.mjs';

// Durable proactive delivery ledger ("inbox"), tiered reach and user-reaction
// feedback (P3). Every proactive share/ask/digest delivery gets one entry on
// project.inbox, whatever its tier. Entries are receipts: they never grant
// work, and their feedback labels are observations, not instructions.

export const INBOX_LIMIT = 200;
export const DIGEST_DEFAULT_HOUR = 9;
const DAY = 86400000;
/** Reaction window: interrupting tiers are answered soon or not at all; quiet tiers are read later. */
export const feedbackWindowMs = tier => tier === 'inbox' || tier === 'digest' ? 2 * DAY : 12 * 3600000;
const outcomes = ['replied', 'acted', 'dismissed', 'ignored'];
const iso = value => new Date(value).toISOString();
const at = value => Date.parse(value);
const excerpt = (value, limit) => { const text = String(value ?? ''); return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`; };
const retained = item => !item.sourceDeleted && !item.contextRevoked;

/** Host caps on the main model's requested tier. Only ever lowers. */
export function capReach(project, { requested, kind = 'share' } = {}) {
  const reasons = [];
  let tier = REACH_TIERS.includes(requested) ? requested : 'inline';
  // A question card lives in the conversation; its tier only decides notify.
  if (kind === 'ask' && tier !== 'notify') { if (tier !== 'inline') reasons.push('ask_in_conversation'); tier = 'inline'; }
  if (tier === 'notify' && project.initiative?.desktopNotifications !== true) { tier = 'inline'; reasons.push('desktop_notifications_off'); }
  return { requested: REACH_TIERS.includes(requested) ? requested : null, tier, reasons };
}
export { lowerReach, reachRank };

/**
 * What the user was told in the last 24 hours: the inbox ledger plus conversation receipts it does not hold (pre-ledger
 * messages, and the host's status lines about background work, kind 'status' by the F7 classifier: told, not sent).
 */
export function recentDeliveries(project, sessions, { now = Date.now(), windowMs = DAY, limit = 12 } = {}) {
  const since = now - windowMs, rows = [], known = new Set(), live = new Set(sessions.map(session => session.id));
  for (const entry of project.inbox ?? []) {
    // A message delivered into a now archived/deleted conversation is revoked context.
    if (!(at(entry.createdAt) >= since) || entry.contextRevoked || entry.sessionId && !live.has(entry.sessionId)) continue;
    known.add(entry.actionId);
    rows.push({ at: entry.createdAt, kind: entry.kind, tier: entry.tier, text: entry.text, status: entry.status, outcome: entry.feedback?.outcome ?? 'pending' });
  }
  for (const session of sessions) for (const item of session.items ?? []) {
    if (item.source !== 'initiative' || !item.initiativeActionId || known.has(item.initiativeActionId) || !retained(item) || !(at(item.createdAt) >= since)) continue;
    rows.push({ at: item.createdAt, kind: proactiveRowKind(item) === 'status' ? 'status' : 'share', tier: 'inline', text: item.text, status: 'delivered', outcome: 'unknown' });
  }
  return rows.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-limit);
}
/** Model-facing digest: bounded, no identifiers. */
export const sentDigest = (project, sessions, options) => recentDeliveries(project, sessions, options).map(row => ({ at: row.at, tier: row.tier, reaction: row.outcome, message: excerpt(row.text, 400) }));

/** Contract check against what was actually delivered in the last 24h. */
export function messageViolations(project, sessions, text, { now = Date.now() } = {}) {
  return proactiveMessageViolations(text, { recent: recentDeliveries(project, sessions, { now, limit: 48 }) });
}
export const SEMANTIC_REPAIR = {
  status_ping: 'This reads as a status update, not a finding. Share only a concrete new result, or choose wait.',
  near_duplicate: 'This mainly repeats something already delivered recently. Share only genuinely new information, or choose wait.',
  result_not_first: 'Lead with the result or the question in the first sentence; move background after it.',
  internal_id: 'Keep only the file names, paths or identifiers this user needs to act on or open; describe the rest in plain words.',
  describes_instead_of_delivering: 'Deliver the requested content itself (what the user asked to receive), not an account of producing it.',
};
/** Project kind for the judge: task types and, for a scheduled delivery, the user's stated deliverable. */
export const projectKindOf = (project, { deliverable = null } = {}) => ({ title: project?.name, taskTypes: deriveProjectTaskTypes({ title: project?.name, description: project?.description, focus: project?.focus, taskTypes: project?.taskTypes }), ...(deliverable ? { deliverable } : {}) });
export const MESSAGE_CHECK_BUDGET_MS = 3000;
/** Exact-duplicate suppression plus the JEV message.check (built in whenever
 * a judge backend exists). A flagged message earns its author one revision. */
export async function checkedMessageViolations(project, sessions, text, { now = Date.now(), decisions, signal, deliverable = null } = {}) {
  const violations = messageViolations(project, sessions, text, { now });
  if (!decisions?.enabled?.('message.check') || typeof decisions.messageCheck !== 'function') return violations;
  let timer;
  const recent = sentDigest(project, sessions, { now, limit: 6 });
  const codes = await Promise.race([Promise.resolve().then(() => decisions.messageCheck(project, { text, recent, signal, kind: projectKindOf(project, { deliverable }) })).catch(() => []), new Promise(resolve => { timer = setTimeout(() => resolve([]), MESSAGE_CHECK_BUDGET_MS); })]).finally(() => clearTimeout(timer));
  const known = new Set(violations.map(row => row.code));
  return [...violations, ...(Array.isArray(codes) ? codes : []).filter(code => SEMANTIC_REPAIR[code] && !known.has(code)).map(code => ({ code, repair: SEMANTIC_REPAIR[code], source: 'jev' }))];
}
/**
 * The JEV codes of a revised message, as the check above keeps them (semantic codes the deterministic checks did not
 * already raise), or null when it was not checked: the judge off or in shadow, no verdict, an error or the budget
 * elapsed. The recheck only measures (a rewrite's pass rate, an effort's label), so "unchecked" must never read as
 * "clean" (review EFF-7).
 */
export async function messageRecheck(project, sessions, text, { now = Date.now(), decisions, signal, deliverable = null } = {}) {
  if (!decisions?.enabled?.('message.check') || typeof decisions.messageCheck !== 'function') return null;
  let timer;
  const recent = sentDigest(project, sessions, { now, limit: 6 }), known = new Set(messageViolations(project, sessions, text, { now }).map(row => row.code));
  const codes = await Promise.race([Promise.resolve().then(() => decisions.messageCheck(project, { text, recent, signal, kind: projectKindOf(project, { deliverable }), verdict: true })).catch(() => null), new Promise(resolve => { timer = setTimeout(() => resolve(null), MESSAGE_CHECK_BUDGET_MS); })]).finally(() => clearTimeout(timer));
  return Array.isArray(codes) ? codes.filter(code => SEMANTIC_REPAIR[code] && !known.has(code)) : null;
}

export function recordDelivery(project, { actionId, kind = 'share', tier, requested = null, reasons = [], text, sessionId = null, itemId = null, interactionId = null, ledgerIds = [], scheduled = false, now = Date.now() }) {
  project.inbox ??= [];
  const entry = { id: randomUUID(), actionId, kind, tier, requestedTier: requested, reachReasons: [...reasons], text: String(text ?? ''), sessionId, itemId, ...(interactionId ? { interactionId } : {}), createdAt: iso(now), status: 'unread',
    ...(tier === 'digest' ? { heldForDigest: true } : {}), ...(ledgerIds.length ? { ledgerIds: [...new Set(ledgerIds)] } : {}), ...(scheduled ? { scheduled: true } : {}), feedback: null };
  project.inbox.push(entry);
  return entry;
}
/** Oldest settled entries beyond the hot limit move to immutable archive records. */
export function trimInbox(store, project) {
  const rows = project.inbox ?? [];
  if (rows.length <= INBOX_LIMIT) return;
  const removable = rows.filter(row => row.feedback && !row.heldForDigest).slice(0, rows.length - INBOX_LIMIT);
  if (!removable.length) return;
  store.archiveRecords(`inbox/${project.id}`, removable);
  const ids = new Set(removable.map(row => row.id));
  project.inbox = rows.filter(row => !ids.has(row.id));
}

export function inboxView(project, { status, limit = 50, now = Date.now() } = {}) {
  const rows = (project.inbox ?? []).filter(row => !row.contextRevoked && (!status || status === 'all' || (status === 'active' ? row.status !== 'dismissed' : row.status === status)));
  const size = Math.max(1, Math.min(200, Number.parseInt(limit, 10) || 50));
  return { projectId: project.id, unread: (project.inbox ?? []).filter(row => !row.contextRevoked && row.status === 'unread').length, total: rows.length,
    entries: rows.slice(-size).reverse().map(row => ({ ...structuredClone(row), ...(row.heldForDigest ? { digestAt: iso(nextDigestAt(at(row.createdAt), project.initiative?.digestHour)) } : {}) })), now: iso(now) };
}
/**
 * Where an inbox entry can be opened: the delivered assistant message
 * (inline/notify), the question card (ask), or the daily digest that merged it.
 * `location` is null for inbox-only entries or when the conversation is gone.
 * The digest side lists its sibling entry ids, so either end maps to the other.
 */
export function inboxEntryLocation(project, entry, sessions, { now = Date.now() } = {}) {
  const view = { ...structuredClone(entry), ...(entry.heldForDigest ? { digestAt: iso(nextDigestAt(at(entry.createdAt), project.initiative?.digestHour)) } : {}) };
  const locate = (sessionId, match, kind) => {
    const session = sessionId ? sessions.find(row => row.id === sessionId && row.projectId === project.id) : null;
    const index = session ? session.items.findIndex(match) : -1;
    if (index < 0) return null;
    const item = session.items[index];
    return { kind, sessionId: session.id, itemId: item.id, turnId: item.turnId ?? null, index, count: session.items.length, sessionArchived: Boolean(session.archivedAt) };
  };
  const location = (entry.itemId && locate(entry.sessionId, item => item.id === entry.itemId, 'message'))
    || (entry.interactionId && locate(entry.sessionId, item => item.interaction?.id === entry.interactionId, 'question'))
    || (entry.digestItemId && locate(entry.digestSessionId ?? entry.sessionId, item => item.id === entry.digestItemId, 'digest'))
    || null;
  const digestItem = entry.digestItemId ? sessions.find(row => row.id === (entry.digestSessionId ?? entry.sessionId))?.items.find(item => item.id === entry.digestItemId) : null;
  const digest = entry.digestItemId ? { itemId: entry.digestItemId, sessionId: entry.digestSessionId ?? entry.sessionId ?? null, entryIds: Array.isArray(digestItem?.initiative?.entryIds) ? [...digestItem.initiative.entryIds] : (project.inbox ?? []).filter(row => row.digestItemId === entry.digestItemId).map(row => row.id) } : null;
  return { projectId: project.id, entry: view, location, digest, now: iso(now) };
}
const inboxError = (message, status, code) => Object.assign(new Error(message), { status, code });
/** read | dismiss | act. Idempotent; dismiss is final. Returns the entry. */
export function applyInboxAction(project, entryId, action, { now = Date.now() } = {}) {
  if (!['read', 'dismiss', 'act'].includes(action)) throw inboxError('action 必须为 read、dismiss 或 act', 400, 'invalid_inbox_action');
  const entry = (project.inbox ?? []).find(row => row.id === entryId && !row.contextRevoked);
  if (!entry) throw inboxError('收件箱中没有这条消息', 404, 'inbox_entry_not_found');
  const stamp = iso(now);
  if (entry.status === 'unread') { entry.status = 'read'; entry.readAt = stamp; }
  if (action === 'dismiss' && entry.status !== 'dismissed') { entry.status = 'dismissed'; entry.dismissedAt = stamp; entry.heldForDigest = false; }
  if (action === 'act') entry.actedAt ??= stamp;
  return entry;
}

/**
 * Entries whose message or question card sits in a conversation the user has in front (reading presence) are read
 * there: the bell stops counting what the user already saw in the chat. Reading is not a reaction, so no feedback
 * outcome is set. Returns the ids it marked; writes only when there is something to mark.
 */
export function readSeenInConversation(store, projectId, sessionId, { now = Date.now() } = {}) {
  const seen = state => {
    const project = state.projects.find(row => row.id === projectId), session = state.sessions.find(row => row.id === sessionId && row.projectId === projectId && !row.archivedAt);
    if (!project || !session) return [];
    const items = new Set((session.items ?? []).filter(item => !item.sourceDeleted).map(item => item.id)), cards = new Set((session.items ?? []).map(item => item.interaction?.id).filter(Boolean));
    return (project.inbox ?? []).filter(row => row.status === 'unread' && !row.contextRevoked && row.sessionId === sessionId && at(row.createdAt) <= now && (items.has(row.itemId) || cards.has(row.interactionId)));
  };
  if (!seen(store.state).length) return [];
  const ids = [];
  store.mutate(state => { const project = state.projects.find(row => row.id === projectId); for (const row of seen(state)) { applyInboxAction(project, row.id, 'read', { now }); row.readVia = 'conversation'; ids.push(row.id); } });
  return ids;
}
/** The conversation item a delivery reached: entries a digest merged share its message, so one reply answers them together. */
const deliveredMessage = entry => entry.tier === 'digest' && entry.digestItemId ? `digest:${entry.digestItemId}` : entry.itemId ? `item:${entry.itemId}` : entry.interactionId ? `card:${entry.interactionId}` : `entry:${entry.id}`;
/** The conversation item a reply to this delivery is a reply to (what `capture.target` and `replyTo` name): the assistant message, the digest, or the question card (`card`, its item); null for an inbox-only entry. */
const deliveredItemId = (entry, card = null) => (entry.tier === 'digest' && entry.digestItemId ? entry.digestItemId : entry.itemId) ?? card?.id ?? null;
/** The delivery a user message most plausibly answers when nobody says (B3's order rule): the latest one the user could see. */
const latestRow = rows => rows.reduce((best, row) => row.visibleAt > best.visibleAt || row.visibleAt === best.visibleAt && at(row.entry.createdAt) > at(best.entry.createdAt) ? row : best);
const latestCard = rows => { const cards = rows.filter(row => row.card); return cards.length ? latestRow(cards) : null; };
/**
 * First observed reaction per entry within its window: dismissed, acted
 * (answered question / explicit act), replied (a user message in that
 * conversation after it was visible), else ignored once the window closes.
 * Returns entries whose feedback was settled by this call, in ledger order (`scanFeedback` also says what it waits for).
 *
 * Which message a reply answers is attributed, not guessed from order (C3, plan §2.3 #2; Headlong stamps `reply_to` at the
 * transport so "answered" is a fact, bin/chat:176-230, and counts only a message addressed to it as engagement,
 * monolith_backoff.md:186-189; Rna recovers the target from a model instead). A user message's target (reply-attribution.mjs
 * `replyTargetOf`: the focused JEV question `reply.target`, else `capture.target` by who named it) decides:
 *  - it names a delivered message: that message's entries (a digest's together) are replied, by this message;
 *  - it names something else (a foreground reply, an older share outside the window) or nothing at all (JEV is sure the
 *    message reacts to nothing earlier): no delivery is replied by it. One unrelated morning message used to settle every
 *    overnight share as replied; B3's transitional rule still let it settle the latest one;
 *  - a question card (an ask, a direct fix to keep or revert) is a delivered message too, and the focused question is offered it.
 *    The capture is not (it reads assistant outputs): when its verdict is only "reacts to nothing earlier", a pending card is
 *    read by the order rule below (the card alone; the shares stay unsettled), as before C3 (review F1);
 *  - it names nothing because nobody could tell (no capture, no answer): B3's transitional rule, Headlong's default
 *    (`reply_to` is the latest unanswered inbound): the latest delivered message of its conversation that was visible
 *    before it, inside its window and not answered yet.
 * A message answers at most one delivered message either way. Messages that already answered an entry
 * (`feedback.replyItemId`; before it, the reply's time in that conversation) answer nothing else.
 *
 * A message still waiting for its capture (`awaiting`: ids the project mind announced, or its turn is the running one) or for
 * the focused question (`judging`, and it can still be asked) is not read yet, and nothing after it in that conversation is:
 * settling it by the fallback now would be final.
 */
export function scanFeedback(project, sessions, { now = Date.now(), awaiting = null, judging = false } = {}) {
  const settled = new Set(), pending = [];
  const settle = (entry, outcome, when, reply = null) => { entry.feedback = { outcome, at: when, windowMs: feedbackWindowMs(entry.tier), ...(reply ? { replyItemId: reply.id, ...(reply.via ? { replyVia: reply.via } : {}) } : {}) }; settled.add(entry); };
  const waiting = new Map();
  for (const entry of project.inbox ?? []) {
    if (entry.feedback || entry.contextRevoked) continue;
    const start = at(entry.createdAt), visibleAt = entry.tier === 'inbox' ? at(entry.readAt) : entry.tier === 'digest' ? at(entry.digestedAt) : start, end = start + feedbackWindowMs(entry.tier);
    let outcome, when;
    if (entry.dismissedAt && at(entry.dismissedAt) <= end) { outcome = 'dismissed'; when = entry.dismissedAt; }
    const card = entry.interactionId ? sessions.find(row => row.id === entry.sessionId)?.items.find(item => item.interaction?.id === entry.interactionId) : null, question = card?.interaction ?? null;
    if (!outcome && question?.status === 'answered' && at(question.answeredAt) <= end) { outcome = 'acted'; when = question.answeredAt; }
    else if (!outcome && question?.status === 'cancelled') { outcome = 'dismissed'; when = question.answeredAt ?? iso(now); }
    if (!outcome && entry.actedAt && at(entry.actedAt) <= end) { outcome = 'acted'; when = entry.actedAt; }
    if (outcome) { settle(entry, outcome, when); continue; }
    // A reply, if any, is attributed below, per conversation; without one the entry is ignored once its window closes.
    const sessionId = entry.tier === 'digest' ? entry.digestSessionId ?? entry.sessionId : entry.sessionId;
    if (Number.isFinite(visibleAt) && sessionId) { const rows = waiting.get(sessionId) ?? []; rows.push({ entry, visibleAt, end, message: deliveredMessage(entry), itemId: deliveredItemId(entry, card), ...(card && !entry.itemId ? { card: true } : {}) }); waiting.set(sessionId, rows); }
    else if (now > end && !entry.heldForDigest) settle(entry, 'ignored', iso(end));
  }
  for (const [sessionId, rows] of waiting) {
    const session = sessions.find(row => row.id === sessionId);
    const replied = (project.inbox ?? []).filter(row => row.feedback?.outcome === 'replied' && (row.tier === 'digest' ? row.digestSessionId ?? row.sessionId : row.sessionId) === sessionId);
    const answered = new Set(replied.map(row => row.feedback.replyItemId).filter(Boolean)), answeredAt = new Set(replied.filter(row => !row.feedback.replyItemId).map(row => row.feedback.at));
    const messages = (session?.items ?? []).filter(item => item.kind === 'user' && retained(item) && Number.isFinite(at(item.createdAt)) && !answered.has(item.id) && !answeredAt.has(item.createdAt)).sort((a, b) => at(a.createdAt) - at(b.createdAt));
    let open = rows, unread = [];
    for (const [position, message] of messages.entries()) {
      const time = at(message.createdAt), visible = open.filter(row => row.visibleAt < time && time <= row.end);
      if (!visible.length) continue;
      const hold = captureAwaited(session, message, { announced: awaiting, now }) ? 'capture' : judging && replyAskable(session, message) ? 'judgement' : null;
      if (hold) { pending.push({ sessionId, itemId: message.id, reason: hold }); unread = messages.slice(position); break; }
      const target = replyTargetOf(message);
      let group, via;
      if (target) {
        // The message says what it answers. A delivered message among the visible ones is replied; anything else is not one of them.
        const hit = target.itemId ? visible.filter(row => row.itemId === target.itemId) : [];
        group = open.filter(row => hit.some(value => value.message === row.message)); via = target.via;
        // A capture reads assistant outputs: it never saw a question card, so its "reacts to nothing earlier" is no word on one
        // (the focused question did see them). A card nobody else could place is read by the order rule, as before C3.
        if (!target.itemId && target.via === 'capture') { const card = latestCard(visible); if (card) { group = open.filter(row => row.message === card.message); via = 'order'; } }
      } else {
        const latest = latestRow(visible);
        group = open.filter(row => row.message === latest.message); via = 'order';
      }
      for (const row of group) settle(row.entry, 'replied', message.createdAt, { id: message.id, via });
      open = open.filter(row => !group.includes(row));
    }
    // A window that closed while a message that could still answer it waits is not over yet.
    const unsettled = row => unread.some(message => row.visibleAt < at(message.createdAt) && at(message.createdAt) <= row.end);
    for (const row of open) if (now > row.end && !row.entry.heldForDigest && !unsettled(row)) settle(row.entry, 'ignored', iso(row.end));
  }
  return { settled: (project.inbox ?? []).filter(entry => settled.has(entry)), pending };
}
export const settleFeedback = (project, sessions, options) => scanFeedback(project, sessions, options).settled;
export const feedbackLabel = outcome => outcomes.includes(outcome) ? `delivery_${outcome}` : null;

/**
 * Settle reactions durably (write-free when nothing changed) and backfill JEV
 * ledger labels for calibration. Returns the settled entries.
 */
export function settleDeliveryFeedback(store, projectId, { decisions, now = Date.now(), mutate = fn => store.mutate(fn) } = {}) {
  const project = store.state.projects.find(row => row.id === projectId);
  if (!project?.inbox?.some(row => !row.feedback && !row.contextRevoked)) return [];
  const sessionsOf = state => state.sessions.filter(row => row.projectId === projectId && !row.archivedAt && row.kind !== 'side');
  // Messages whose capture is still on its way, or that the focused question has not read yet, are not settled by order now.
  const options = { now, awaiting: store.mind?.capturesAwaited?.() ?? null, judging: decisions?.enabled?.('reply.target') === true };
  if (!settleFeedback({ inbox: structuredClone(project.inbox) }, sessionsOf(store.state), options).length) return [];
  let settled = [];
  mutate(state => { const target = state.projects.find(row => row.id === projectId); if (target) settled = structuredClone(settleFeedback(target, sessionsOf(state), options)); });
  for (const entry of settled) for (const id of entry.ledgerIds ?? []) { try { decisions?.labelDecision?.(id, feedbackLabel(entry.feedback.outcome)); } catch { /* calibration labels never block delivery state */ } }
  return settled;
}
/** Questions asked in one pass: one per waiting message, in order, so a conversation's later messages read the answers of the earlier. */
const ATTRIBUTION_ROUNDS = 8;
/**
 * The async half of reply detection (C3): asks the focused question `reply.target` for each user message the ledger is
 * waiting on (reply-attribution.mjs `attributeReply`, once per message, kept on the message), then settles. Messages whose
 * capture is still on its way wait for it. Returns the entries settled. Nothing is asked when the judge is off.
 */
export async function attributeReplies(store, projectId, { decisions, now = Date.now(), mutate = fn => store.mutate(fn), signal } = {}) {
  if (decisions?.enabled?.('reply.target') !== true) return [];
  const sessionsOf = state => state.sessions.filter(row => row.projectId === projectId && !row.archivedAt && row.kind !== 'side');
  for (let round = 0; round < ATTRIBUTION_ROUNDS; round++) {
    const project = store.state.projects.find(row => row.id === projectId);
    if (!project?.inbox?.some(row => !row.feedback && !row.contextRevoked)) break;
    const { pending } = scanFeedback({ inbox: structuredClone(project.inbox) }, sessionsOf(store.state), { now, awaiting: store.mind?.capturesAwaited?.() ?? null, judging: true });
    const asks = pending.filter(row => row.reason === 'judgement');
    if (!asks.length) break;
    const answers = await Promise.all(asks.map(row => attributeReply(store, decisions, { sessionId: row.sessionId, itemId: row.itemId, mutate, now: () => now, signal })));
    signal?.throwIfAborted();
    // A question the judge did not answer is asked again on the next pass (the pump's), not straight away.
    if (answers.some(row => !row || row.attempts !== undefined)) break;
  }
  return settleDeliveryFeedback(store, projectId, { decisions, now, mutate });
}

/** Useful-share rate, dismiss rate and friends over settled entries in the window. */
export function deliveryMetrics(project, { now = Date.now(), windowMs = 7 * DAY } = {}) {
  const rows = (project.inbox ?? []).filter(row => !row.contextRevoked && at(row.createdAt) >= now - windowMs);
  const counts = { delivered: rows.length, pending: 0, replied: 0, acted: 0, dismissed: 0, ignored: 0 };
  const byTier = Object.fromEntries(REACH_TIERS.map(tier => [tier, 0]));
  for (const row of rows) { counts[row.feedback?.outcome ?? 'pending']++; byTier[row.tier] = (byTier[row.tier] ?? 0) + 1; }
  const settled = counts.replied + counts.acted + counts.dismissed + counts.ignored, rate = value => settled ? Math.round(value / settled * 1000) / 1000 : null;
  return { projectId: project.id, windowMs, since: iso(now - windowMs), counts, byTier, settled,
    usefulShareRate: rate(counts.replied + counts.acted), replyRate: rate(counts.replied), actRate: rate(counts.acted), dismissRate: rate(counts.dismissed), ignoreRate: rate(counts.ignored),
    lowered: rows.filter(row => row.requestedTier && reachRank(row.tier) < reachRank(row.requestedTier)).length };
}
/** Compact reaction signals for evolution/JEV consumers (no message text). */
export function deliveryFeedbackSignals(project, { limit = 50 } = {}) {
  return (project.inbox ?? []).filter(row => row.feedback && !row.contextRevoked).slice(-limit).map(row => ({ entryId: row.id, actionId: row.actionId, kind: row.kind, tier: row.tier, requestedTier: row.requestedTier, deliveredAt: row.createdAt, outcome: row.feedback.outcome, observedAt: row.feedback.at }));
}

/** Next local digest time at or after `from`. */
export function nextDigestAt(from, hour = DIGEST_DEFAULT_HOUR) {
  const target = new Date(from), h = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DIGEST_DEFAULT_HOUR;
  target.setHours(h, 0, 0, 0);
  if (target.getTime() < from) target.setDate(target.getDate() + 1);
  return target.getTime();
}
export const digestDue = (project, now) => (project.inbox ?? []).filter(row => row.heldForDigest && !row.contextRevoked && row.status !== 'dismissed' && nextDigestAt(at(row.createdAt), project.initiative?.digestHour) <= now);
/** One digest line: the first sentence of a held finding (or its first 280 characters). Shared by `composeDigest` and `digestLines`. */
const digestFirst = text => { const line = oneLine(text, 600); const end = line.search(/[。！？!?]|\.(\s|$)/); return end > 0 && end < 280 ? line.slice(0, end + 1) : excerpt(line, 280); };
/** Each entry's digest line exactly as `composeDigest` renders it, in order: the structured `initiative.lines` clients render without parsing the header. */
export const digestLines = entries => entries.map(row => digestFirst(row.text));
/** Host-authored digest text: first sentence of each held finding, in order. Follows the interface language (default Chinese). */
export function composeDigest(entries, language = 'zh') {
  const lines = digestLines(entries), en = language === 'en';
  return lines.length === 1 ? `${en ? 'Today\'s digest: ' : '今日摘要：'}${lines[0]}`
    : `${en ? `Today's digest (${lines.length} items):` : `今日摘要（${lines.length} 条）：`}\n${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}`;
}
