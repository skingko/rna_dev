// Adaptive pacing (proactive v2 §3.1, K2). Signal-driven, never a counter:
// there is no per-day cap and no fixed quota. Each project derives a value
// threshold from engagement, project phase, the unreplied chain and recent
// message value; a candidate message is sent only when its value clears it.
// The background wake cadence follows Headlong's ladder: a VISIBLE outcome resets it (C2: not the host admitting a
// decision; work-outcome.mjs says when something became visible), empty wakes and outcomes that came to nothing dwell
// and then back off, failures step down at once.
// Pure helpers: no IO, no model calls. `project.mind.pacing` is derived state
// (recomputable), persisted only for display, metrics and the wake ladder.
//
// Which clock owns which wake (docs/specs/project-proactive-system.md §9.1). Fixing one never stops the wakes another
// drives:
//  - rhythm lane (project-rhythm.mjs, SDK resolveProjectRhythm): whether a new decision is allowed at all (new
//    evidence, the model-assessed review interval, a live conversation). It opens and closes; it sets no time.
//  - floor ladder (wakeFloor / advanceWake here): only event_only projects, and recurring ones between occurrences, with
//    open agenda, pending requests or held messages, on WAKE_LADDER. It never fires while the coordinator could not
//    decide (PDL-4), a wake that decided nothing leaves it where it was, and only a visible outcome of an admitted
//    action resets it (C2: applyWorkOutcome, fed by work-outcome.mjs transitions).
//  - SDK review delay (InitiativeCoordinator nextReviewAt: the decision's nextReviewAfterMs with idle backoff): when an
//    open lane actually decides; a new evidence revision makes it due at once.
//  - gate delay (DecisionService deferralDelay: the gate's retryAt, and the in_progress_covers hold): how long a JEV
//    deferral of the same situation stands; the third pass of an unchanged situation goes to the main model.
// The foreground lease is not a clock: it holds decisions until the turn's own result (an evidence bound). Scheduled
// occurrences run at their own due times (project-schedules.mjs), outside all four.

const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
export const PACING_VERSION = 1;
export const AWAY_AFTER_MS = 45 * MINUTE;
export const BASE_THRESHOLD = .45;
export const THRESHOLD_RANGE = Object.freeze([.25, .9]);
/** Held (not yet told) findings at or above this value count toward anti-ratchet decay. */
export const VALUABLE_HELD = .35;
/** Quiet background wakes before an unshared finding starts lowering the bar (Headlong SHARE_HINT_EVERY). */
export const QUIET_WAKES_NUDGE = 6;
// Wake ladder for the event_only floor: level → delay. Dwell HOLD ticks per level.
export const WAKE_LADDER = Object.freeze([10 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR]);
export const WAKE_HOLD = 2;
/** How recent the user's presence or the last visible outcome must be for the project to count as in an active phase (cacheWakeAllowed). */
export const ACTIVE_WINDOW_MS = 2 * HOUR;
/** Headlong PENDING_MAX_AGE (monolith/step:204-237): a request older than this is no longer pursued by rule. */
export const PENDING_MAX_AGE_MS = 14 * DAY;

const at = value => typeof value === 'number' ? value : Date.parse(value);
/**
 * The last time something happened to a pending request (code: the newest timestamp the row holds): it was made, carried on, reopened,
 * failed, waited for the user, fell due, was restated, or the user's own hand was on it (an edit, a deadline moved: `editedBy: 'user'`;
 * the host's bookkeeping is not a sign of life). A deadline still ahead counts as a moment ahead, so such a request is never old. One
 * anchor for both ends of a request's pursuit: the gate stops pursuing it, and the mind ends it (`expiredCommitments`), PENDING_MAX_AGE_MS after.
 */
export function lastLifeAt(row) {
  const stamps = [row?.createdAt, row?.continuedAt, row?.continuedBy?.at, row?.reopened?.at, row?.failure?.at, row?.waitingOnUser?.at, row?.overdueAt, row?.editedBy === 'user' ? row.updatedAt : null, ...(Array.isArray(row?.evidence) ? row.evidence : []).map(entry => entry?.at)];
  const moments = stamps.map(at).filter(Number.isFinite);
  return moments.length ? Math.max(...moments) : 0;
}
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const round = value => Math.round(value * 1000) / 1000;
const retained = item => !item.sourceDeleted && !item.contextRevoked && item.simulated !== true;
const median = values => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1; return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
export const percentile = (values, p) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]; };
// ------------------------------------------------------- delivery ledger (F7)
const REVERT_LINES = ['-changes-revert', '-direct-revert'];
/**
 * F7: what one conversation item is to the proactive ledger, read from structure only (Headlong
 * outbound_delivery.md:137-185: the sent ledger holds the identity's own messages; status records and delivery notices
 * are not messages, and they wake nobody).
 *  'delivery'  a message the initiative sent the user: a share or scheduled delivery, a welcome-back, a digest, a
 *              learned-rule note, a question card it put up (an ask, a direct fix to keep or revert, a help request);
 *  'status'    a host line about work: a background run's line (its change-set and git text live on that line), a
 *              revert notice, a thread close;
 *  null        anything else: the user's and the foreground's items, a version_ready card, a deleted, revoked or
 *              simulated item.
 * Status rows are not unanswered messages: they never enter the unreplied chain, reading time, reply latency, votes or
 * the sent count. They are part of what the user was told (the wake gate's recentReports).
 */
export function proactiveRowKind(item) {
  if (!item || !retained(item)) return null;
  if (item.kind === 'question') return item.interaction?.source === 'initiative' ? 'delivery' : null;
  if (item.kind !== 'assistant' || item.source !== 'initiative' || item.initiative?.kind === 'version_ready') return null;
  const initiative = item.initiative ?? {}, key = typeof item.initiativeActionId === 'string' ? item.initiativeActionId : '';
  return initiative.backgroundWork || initiative.backgroundChange || initiative.kind === 'thread_close' || REVERT_LINES.some(suffix => key.endsWith(suffix)) ? 'status' : 'delivery';
}
/** Proactive messages (deliveries) the user could see in the conversation. */
export const proactiveItem = item => proactiveRowKind(item) === 'delivery';
/** A delivery filed at a quiet tier (inbox, digest) joins the conversation without interrupting: it asks for no reply now. */
const quietTier = item => ['inbox', 'digest'].includes(item.initiative?.reach);
/** An interrupting delivery (inline, notify, a question card): what the unreplied chain, reading time and reply latency count. */
export const asksReply = row => row.kind === 'proactive' && !row.quiet;

/** Time-ordered user and delivery rows across the project's live conversations (status rows are not messages, F7). */
export function conversationTimeline(sessions) {
  const rows = [];
  for (const session of sessions) for (const item of session.items ?? []) {
    if (!retained(item) || !Number.isFinite(at(item.createdAt))) continue;
    if (item.kind === 'user') { rows.push({ kind: 'user', at: at(item.createdAt), sessionId: session.id, text: item.text ?? '' }); continue; }
    if (proactiveRowKind(item) !== 'delivery') continue;
    if (item.kind === 'assistant') rows.push({ kind: 'proactive', at: at(item.createdAt), sessionId: session.id, itemId: item.id, text: item.text ?? '', initiative: item.initiative ?? {}, ...(quietTier(item) ? { quiet: true } : {}) });
    else {
      rows.push({ kind: 'proactive', at: at(item.createdAt), sessionId: session.id, itemId: item.id, text: (item.interaction.questions ?? []).map(row => row.question ?? '').join(' '), initiative: { kind: 'question' } });
      // An answered question card is the user's reply.
      if (item.interaction.status === 'answered' && Number.isFinite(at(item.interaction.answeredAt))) rows.push({ kind: 'user', at: at(item.interaction.answeredAt), sessionId: session.id, text: '' });
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}
/** Consecutive interrupting proactive messages since the user's last message (the "unreplied chain"); quiet-tier ones do not count. */
export function unrepliedChain(timeline, { until = Infinity } = {}) {
  let chain = 0;
  for (const row of timeline) { if (row.at > until) break; if (row.kind === 'user') chain = 0; else if (asksReply(row)) chain++; }
  return chain;
}
/** Longest such chain, counting only messages sent in [since, until) (the metrics' windows, metric-windows.mjs). */
export function longestUnrepliedChain(timeline, { since = 0, until = Infinity } = {}) {
  let chain = 0, longest = 0;
  for (const row of timeline) { if (row.at >= until) break; if (row.kind === 'user') chain = 0; else if (asksReply(row) && row.at >= since) longest = Math.max(longest, ++chain); }
  return longest;
}
/** Local hours (0–23) the user is typically active, learned from message timestamps.
 * Empty until there is enough history (≥12 messages over ≥3 days); callers treat
 * empty as "unknown", never as "always night". */
export function learnedActiveHours(times, { now = Date.now(), windowMs = 30 * DAY } = {}) {
  const recent = times.filter(time => time >= now - windowMs && time <= now);
  const days = new Set(recent.map(time => new Date(time).toDateString()));
  if (recent.length < 12 || days.size < 3) return [];
  const counts = Array(24).fill(0);
  for (const time of recent) counts[new Date(time).getHours()]++;
  const active = new Set();
  counts.forEach((count, hour) => { if (count > 0) for (const offset of [-1, 0, 1]) active.add((hour + offset + 24) % 24); });
  return [...active].sort((a, b) => a - b);
}
/** Engagement from settled inbox reactions and 👍/👎 item feedback (K1 `item.feedback`). */
export function engagementOf(project, sessions, { now = Date.now(), windowMs = 14 * DAY } = {}) {
  const rows = (project.inbox ?? []).filter(row => !row.contextRevoked && row.feedback && at(row.createdAt) >= now - windowMs);
  const count = outcome => rows.filter(row => row.feedback.outcome === outcome).length;
  const replied = count('replied'), acted = count('acted'), dismissed = count('dismissed'), ignored = count('ignored');
  let up = 0, down = 0;
  for (const session of sessions) for (const item of session.items ?? []) if (proactiveItem(item) && at(item.createdAt) >= now - windowMs) { const vote = item.feedback?.vote; if (vote === 'up') up++; else if (vote === 'down') down++; }
  const settled = replied + acted + dismissed + ignored;
  const rate = settled + up + down ? (replied + acted + up) / (settled + up + down) : null;
  // Newest settled reactions that are all "ignored": a project nobody is answering raises the bar before three reactions exist.
  let ignoredStreak = 0;
  for (const row of [...rows].sort((a, b) => at(b.createdAt) - at(a.createdAt))) { if (row.feedback.outcome === 'ignored') ignoredStreak++; else break; }
  return { settled, replied, acted, dismissed, ignored, up, down, ignoredStreak, rate: rate === null ? null : round(rate) };
}
/** Median time from an interrupting proactive message to the user's next message (same conversation). */
export function replyLatencyMs(timeline, { now = Date.now(), windowMs = 14 * DAY } = {}) {
  const latencies = [];
  timeline.forEach((row, index) => {
    if (!asksReply(row) || row.at < now - windowMs) return;
    const reply = timeline.slice(index + 1).find(next => next.kind === 'user' && next.sessionId === row.sessionId);
    if (reply && reply.at - row.at <= DAY) latencies.push(reply.at - row.at);
  });
  return median(latencies);
}
const openOf = (mind = {}) => ({
  // C4: a stale row (a revocation found it leaning on what was withdrawn) is not open work.
  agenda: (Array.isArray(mind.agenda) ? mind.agenda : []).filter(row => row && !row.stale && (row.status ?? 'open') === 'open'),
  commitments: (Array.isArray(mind.commitments) ? mind.commitments : []).filter(row => row && (row.status ?? 'pending') === 'pending'),
});
/**
 * The user's pending requests whose due time has passed (an item that only waits for its changes to be applied, or for the user's
 * answer, is not owed now): the gate's openWork count. The commitment_overdue rule pursues only `pursuedOverdue` of them.
 */
export function overdueCommitments(mind = {}, now = Date.now()) {
  return (Array.isArray(mind?.commitments) ? mind.commitments : []).filter(row => row && (row.status ?? 'pending') === 'pending' && !row.awaitingApply && !row.waitingOnUser && Number.isFinite(Date.parse(row.overdueAt)) && Date.parse(row.overdueAt) <= now);
}
/**
 * The overdue requests a wake still owes the user by rule (the initiative gate's commitment_overdue bypass). Headlong
 * monolith/step:204-237, 425-441: a pending request changes what a wake does and which tier answers, never adds wakes;
 * it is dropped from the hint after PENDING_MAX_AGE (14 days); declining it requires a thought that says why. So:
 *  - at most PENDING_MAX_AGE_MS after its last sign of life (lastLifeAt: made, carried on, fell due, edited by the user …);
 *  - not at the evidence revision a main-model decision already declined it with its stated reason
 *    (`pacing.overdueDeclined`, see declineOverdue); new evidence (another revision) makes it owed again.
 * The gate's judge still sees every overdue request in its openWork count.
 */
export function pursuedOverdue(mind = {}, { now = Date.now(), revision = null } = {}) {
  const declined = mind?.pacing?.overdueDeclined, suppressed = declined && typeof revision === 'string' && declined.revision === revision ? new Set(declined.ids ?? []) : null;
  // Anchored on the request's last sign of life, as the mind ends it (D4: a request made long ago, carried on or judged due since, is
  // pursued from then, and ended at the same moment the pursuit stops).
  return overdueCommitments(mind, now).filter(row => now - lastLifeAt(row) <= PENDING_MAX_AGE_MS && !suppressed?.has(row.id));
}
/**
 * The record of a main-model decision that saw overdue requests and chose to wait (every decision states its reason:
 * Headlong's "if you have a good reason not to this wake, append a thought saying why and what would unblock it"). It
 * suppresses the commitment_overdue bypass for those requests at that evidence revision only. Null when none was owed.
 */
export function declineOverdue(mind = {}, { now = Date.now(), revision, reason = null } = {}) {
  const owed = pursuedOverdue(mind, { now });
  if (!owed.length || typeof revision !== 'string' || !revision) return null;
  return { ids: owed.map(row => row.id).filter(Boolean).slice(0, 32), revision, at: new Date(now).toISOString(), ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim().slice(0, 300) } : {}) };
}
const heldRows = (mind, field) => (Array.isArray(mind?.threads) ? mind.threads : []).filter(thread => thread.status === 'open').flatMap(thread => (Array.isArray(thread[field]) ? thread[field] : []).map(held => ({ ...held, threadId: thread.id, threadTitle: thread.title })));
/** Messages held in their open thread (`thread.held`) for the welcome-back summary. A held question is not one of them (heldAsks). */
export function heldItems(mind = {}) { return heldRows(mind, 'held'); }
/**
 * Questions held in their open thread (F4), in their own field `thread.heldAsks`: narrated once when held, published
 * as their card when the user is here again (heldAskDue), never folded into the welcome-back text: a question is never
 * silently turned into a statement. Apart from `thread.held` so a host that predates F4 (a rollback) never reads one as
 * a held message; it re-narrates the question once its action's retry comes due instead (the ten-minute backstop).
 */
export function heldAsks(mind = {}) { return heldRows(mind, 'heldAsks'); }
/**
 * A question is held only while its blocker is the user's absence (pacingDecision: away, night; a question in the
 * below-threshold band is not held, it goes out as a new-thread question does). So the user's return is what releases
 * it (harness agent.ts:213-232: a latched wake is replayed when its own blocker clears): they are here, or wrote since it
 * was held (the welcome-back condition), and it is not their night or mid-typing.
 */
export function heldAskDue(held, signals) {
  if (!held || signals.night || signals.typing) return false;
  return Boolean(signals.present) || Number.isFinite(signals.lastUserAt) && signals.lastUserAt > at(held.createdAt);
}

/**
 * All pacing inputs, computed in code. `presence` is the host's live presence
 * ({ visible, typing }); `lastSeenAt` the host's last observed presence.
 */
export function pacingSignals(project, sessions, { now = Date.now(), presence = null, lastSeenAt = null, evidenceTimes = [], lifecycle = null } = {}) {
  const mind = project.mind ?? {}, timeline = conversationTimeline(sessions);
  const userTimes = timeline.filter(row => row.kind === 'user' && row.text).map(row => row.at);
  const lastUserAt = timeline.filter(row => row.kind === 'user').at(-1)?.at ?? null;
  const present = Boolean(presence?.visible);
  const seen = [lastUserAt, at(mind.pacing?.lastPresenceAt), lastSeenAt, present ? now : null].filter(Number.isFinite);
  const lastPresenceAt = seen.length ? Math.max(...seen) : null;
  const activeHours = learnedActiveHours(userTimes, { now });
  const hour = new Date(now).getHours();
  const night = !present && activeHours.length > 0 && activeHours.length < 24 && !activeHours.includes(hour);
  const away = !present && lastPresenceAt !== null && now - lastPresenceAt > AWAY_AFTER_MS;
  const open = openOf(mind), held = heldItems(mind);
  const overdue = open.commitments.filter(row => !row.waitingOnUser && Number.isFinite(at(row.overdueAt)) && at(row.overdueAt) <= now).length;
  const awaitingExternal = lifecycle === 'blocked' || open.agenda.some(row => row.kind === 'awaiting_user');
  const recent = (mind.pacing?.decisions ?? []).filter(row => row.outcome === 'send' && at(row.at) >= now - 3 * DAY).slice(-5);
  return {
    now, present, typing: Boolean(presence?.typing), lastUserAt, lastPresenceAt, activeHours, night, away,
    unrepliedChain: unrepliedChain(timeline), sinceUnrepliedMs: (() => { const last = timeline.findLast(row => row.kind === 'user' || asksReply(row)); return last?.kind === 'proactive' ? now - last.at : null; })(), engagement: engagementOf(project, sessions, { now }), replyLatencyMs: replyLatencyMs(timeline, { now }),
    conversationLive: lastUserAt !== null && now - lastUserAt <= 30 * MINUTE,
    openAgenda: open.agenda.length, pendingCommitments: open.commitments.length, overdueCommitments: overdue, awaitingExternal,
    evidenceVelocity: evidenceTimes.filter(time => time >= now - DAY).length,
    recentSentValue: recent.length ? round(recent.reduce((sum, row) => sum + (row.value ?? 0), 0) / recent.length) : null,
    // Restraint, not absence: items held only because the user was away or asleep wait for the welcome-back summary.
    heldValuable: held.filter(row => (row.value ?? 0) >= VALUABLE_HELD && !(row.reasons ?? []).some(reason => reason === 'away' || reason === 'night')).length
      + (mind.pacing?.decisions ?? []).filter(row => row.outcome === 'inbox' && (row.value ?? 0) >= VALUABLE_HELD && at(row.at) >= now - DAY).length,
    quietWakes: mind.pacing?.wake?.quietWakes ?? 0,
  };
}

/** Value bar for the next proactive message. Every factor is recorded. */
export function pacingThreshold(signals) {
  const factors = [], add = (name, delta) => { if (delta) factors.push({ name, delta: round(delta) }); };
  // One unanswered message is normal; each further one raises the bar until the user engages again.
  add('unreplied_chain', Math.min(.35, .07 * Math.max(0, signals.unrepliedChain - 1)));
  const engagement = signals.engagement ?? {};
  if ((engagement.settled ?? 0) + (engagement.up ?? 0) + (engagement.down ?? 0) >= 3 && engagement.rate !== null) add('engagement', engagement.rate < .25 ? .1 : engagement.rate > .6 ? -.08 : 0);
  // The last two or more messages went unanswered in a row: only something clearly more valuable goes out until the user reacts.
  if ((engagement.ignoredStreak ?? 0) >= 2) add('ignored_streak', engagement.ignoredStreak >= 3 ? .15 : .08);
  if (signals.replyLatencyMs !== null && signals.replyLatencyMs !== undefined) add('reply_latency', signals.replyLatencyMs < 30 * MINUTE ? -.03 : signals.replyLatencyMs > 6 * HOUR ? .05 : 0);
  if (signals.conversationLive) add('conversation_live', -.05);
  // Reading time: nobody is in the conversation and a message sent moments ago is still unanswered;
  // another one now needs more to say (a live conversation reads messages as they come).
  if (!signals.conversationLive && Number.isFinite(signals.sinceUnrepliedMs)) add('reading_time', signals.sinceUnrepliedMs < 30 * MINUTE ? .1 : signals.sinceUnrepliedMs < 2 * HOUR ? .05 : 0);
  if (signals.pendingCommitments + signals.openAgenda > 0) add('open_work', -.03);
  if (signals.overdueCommitments > 0) add('overdue_commitment', -.05);
  if (signals.awaitingExternal) add('awaiting_external', .08);
  if (signals.evidenceVelocity >= 5) add('evidence_velocity', -.03);
  if (signals.recentSentValue !== null && signals.recentSentValue !== undefined && signals.recentSentValue < BASE_THRESHOLD) add('recent_low_value', .05);
  // Anti-ratchet (Headlong share nudge): valuable findings piling up unshared
  // while wakes stay quiet lower the bar again, so learned restraint never
  // becomes permanent silence.
  if (signals.heldValuable > 0 || signals.quietWakes >= QUIET_WAKES_NUDGE) add('anti_ratchet', -Math.min(.18, .04 * signals.heldValuable + (signals.quietWakes >= QUIET_WAKES_NUDGE ? .03 * Math.floor(signals.quietWakes / QUIET_WAKES_NUDGE) : 0)));
  const threshold = clamp(BASE_THRESHOLD + factors.reduce((sum, row) => sum + row.delta, 0), ...THRESHOLD_RANGE);
  return { threshold: round(threshold), factors };
}

/**
 * Candidate value in 0..1 from the judge's atomic probabilities. There are no
 * host text rules: without a judge every probability is unknown (0.5), so the
 * value is neutral and pacing alone (presence, night, unreplied chain, reading
 * time, engagement) decides.
 */
export function candidateValue(probabilities) {
  const p = id => Number.isFinite(probabilities?.[id]) ? probabilities[id] : .5;
  const urgency = Math.max(p('time_sensitive'), p('needs_user_decision'));
  const value = (.35 * p('new_information') + .2 * p('continues_open_thread_or_commitment') + .2 * p('relevant_now') + .25 * urgency) * (1 - .85 * (Number.isFinite(probabilities?.already_reported) ? probabilities.already_reported : 0));
  return round(clamp(value, 0, 1));
}
/** Only time-sensitive items interrupt an away or sleeping user; a question can wait for them too. */
export const timeSensitive = probabilities => (probabilities?.time_sensitive ?? 0) >= .6;

/**
 * send (inline now) | hold (in its thread, for a batch or a welcome-back
 * summary) | inbox (filed quietly) | drop. Scheduled deliverables were
 * requested by the user and always send; muted threads never deliver.
 */
export function pacingDecision({ value, threshold, probabilities = {}, signals, kind = 'share', scheduled = false, muted = false, reported = false, duplicate = false, continuing = false }) {
  const reasons = [];
  if (muted) return { outcome: 'drop', reasons: ['thread_muted'] };
  if (scheduled) return { outcome: 'send', reasons: ['scheduled_deliverable'] };
  if (duplicate) return { outcome: 'drop', reasons: ['exact_duplicate'] };
  if (reported) return { outcome: 'drop', reasons: ['already_reported'] };
  const urgent = timeSensitive(probabilities, kind);
  if (!urgent && (signals.night || signals.away)) {
    reasons.push(signals.night ? 'night' : 'away');
    return { outcome: value >= threshold - .25 ? 'hold' : 'drop', reasons: value >= threshold - .25 ? reasons : [...reasons, 'below_threshold'] };
  }
  if (value >= threshold) return { outcome: 'send', reasons: urgent ? ['time_sensitive'] : ['above_threshold'] };
  // Only a share folds into its continuing thread. A question in the band goes out as a new-thread question does
  // (system-review F4: its outcome does not depend on the thread), so a question is held only for the user's absence,
  // which their return releases (heldAskDue); before, it was held and re-narrated every ten minutes.
  if (value >= threshold - .2) return { outcome: continuing && kind !== 'ask' ? 'hold' : 'inbox', reasons: ['below_threshold_band'] };
  return { outcome: 'drop', reasons: ['below_threshold'] };
}

/** Durable, recomputable pacing snapshot for `project.mind.pacing`. */
export function derivePacing(previous = {}, signals, threshold) {
  return { ...previous, version: PACING_VERSION, threshold: threshold.threshold, factors: threshold.factors, unrepliedChain: signals.unrepliedChain,
    engagement: signals.engagement, replyLatencyMs: signals.replyLatencyMs, lastPresenceAt: signals.lastPresenceAt ? new Date(signals.lastPresenceAt).toISOString() : previous.lastPresenceAt ?? null,
    activeHours: signals.activeHours, away: signals.away, night: signals.night, updatedAt: new Date(signals.now).toISOString() };
}
export const PACING_DECISIONS_KEPT = 40;
export function recordPacingDecision(pacing, row) { pacing.decisions = [...(pacing.decisions ?? []), row].slice(-PACING_DECISIONS_KEPT); return pacing; }

// ------------------------------------------------------------ wake cadence
const delayFor = level => WAKE_LADDER[clamp(level, 0, WAKE_LADDER.length - 1)];
/**
 * event_only (and recurring between occurrences) is a floor, not a full stop:
 * while open agenda, pending commitments or held thread items exist, the
 * background may still wake on the ladder. Returns { eligible, reason, nextAt }.
 */
export function wakeFloor(project, rhythm, { now = Date.now() } = {}) {
  if (rhythm?.initiative?.eligible) return { eligible: false, reason: 'rhythm_eligible' };
  if (!['awaiting_evidence', 'awaiting_scheduled_work', 'recurring_schedule_missing'].includes(rhythm?.initiative?.reason)) return { eligible: false, reason: 'not_floor_state' };
  const mind = project.mind ?? {}, open = openOf(mind), held = heldItems(mind).length;
  if (!open.agenda.length && !open.commitments.length && !held) return { eligible: false, reason: 'nothing_open' };
  const wake = mind.pacing?.wake ?? {};
  const nextAt = Number.isFinite(at(wake.nextAt)) ? at(wake.nextAt) : (Number.isFinite(at(wake.lastAt)) ? at(wake.lastAt) : now - delayFor(0)) + delayFor(wake.level ?? 0);
  return { eligible: now >= nextAt, reason: now >= nextAt ? 'open_work_floor' : 'floor_interval', nextAt, open: { agenda: open.agenda.length, commitments: open.commitments.length, held } };
}
/**
 * Headlong backoff after a review (monolith_backoff.md:168-173): an empty wake dwells WAKE_HOLD ticks, then descends; a
 * failed review descends at once. An empty wake is a paid 'thought' (the main model chose wait, or decided something the
 * host did not admit: an exact duplicate, covered work) or a JEV 'deferred'. Every outcome rests on the full ladder:
 * Headlong caps thought-only rests lower (THOUGHT_CAP, monolith/step:52-57) because its thoughts are cheap think-tier
 * ticks, while Rna's thought is a paid main-model decision, so a gentler ceiling for it made paid waits twice as frequent
 * as cheap deferrals at the bottom. `quietWakes` counts paid waits only (Headlong counts spontaneous model wakes,
 * monolith/step:239-253): a JEV deferral is not a model wake, and a wake that reached no decision is no wake at all
 * (wakeOutcome: null).
 *
 * C2 (option C; Headlong's 2026-08-24 revision, monolith/step:357-373 and 582-586): a decision the host admitted ('work':
 * any non-wait action) does not reset the ladder. Headlong resets only when a VISIBLE step was appended (found by
 * comparing the last step id before and after the run); admitting a decision is only a promise. The row records it as
 * `pending` (with the action it started, `actionId`); level, ticks and the quiet count stay as they were, and the timer
 * re-arms at the level's delay (bounded: the floor only runs with open work). The ladder moves when the action's
 * outcome does (applyWorkOutcome, from the work-outcome.mjs transitions): visible resets it; nothing visible, an undo or
 * a failure steps it down.
 * `saved`: on a 'deferred' wake that rested on the last wait's own rest (reason `unchanged_since_wait`), the request it did not send.
 * `tier`, `gate`: what a row also records (wakeTier: the shadow tier; the judgment rows the wake came from).
 */
export function advanceWake(wake = {}, outcome, { now = Date.now(), tokens = null, latencyMs = null, floor = false, reason = null, prompt = null, reasoning = null, actionId = null, tier = null, gate = null, saved = null } = {}) {
  let level = wake.level ?? 0, ticks = wake.ticksAtLevel ?? 0, quietWakes = wake.quietWakes ?? 0;
  // The decision's reasoning effort (internal reasoning): what it ran at and where that came from.
  const effort = reasoning && typeof reasoning === 'object' && typeof reasoning.effective === 'string' ? { reasoning: { effective: reasoning.effective.slice(0, 20), source: typeof reasoning.source === 'string' ? reasoning.source.slice(0, 30) : 'configured', ...(reasoning.shadow?.effort ? { shadow: String(reasoning.shadow.effort).slice(0, 20) } : {}) } } : {};
  // What C2 adds to a row: the tier computed from facts (shadow: nothing reads it), the action the decision admitted and
  // the judgment rows it came from (the wake judgment and the deferrals of the same situation), so a later outcome finds them.
  const extra = {
    ...(tier && WAKE_TIERS.includes(tier.tier) ? { tier: tier.tier, ...(Array.isArray(tier.facts) && tier.facts.length ? { tierFacts: tier.facts.filter(fact => typeof fact === 'string').map(fact => fact.slice(0, 30)).slice(0, 8) } : {}) } : {}),
    ...(typeof actionId === 'string' && actionId ? { actionId: actionId.slice(0, 160) } : {}),
    // A deferred wake that kept the rest its last wait asked for: the decision request it did not send, in estimated tokens (`saved`).
    ...(Number.isFinite(saved) && saved > 0 ? { saved: Math.round(saved) } : {}),
    ...(gate && (typeof gate.ledgerId === 'string' || gate.deferred?.length) ? { gate: { ...(typeof gate.ledgerId === 'string' ? { ledgerId: gate.ledgerId } : {}), ...(Array.isArray(gate.deferred) && gate.deferred.length ? { deferred: gate.deferred.filter(id => typeof id === 'string').slice(0, 8) } : {}) } } : {}),
  };
  // A decision superseded by new evidence or a stop (its tokens are spent) is history only: it never moves the ladder,
  // the next review time, the quiet count or the last outcome the gate reads; the new evidence wakes the next review.
  if (outcome === 'interrupted') {
    const record = { at: new Date(now).toISOString(), outcome, floor, ...(typeof reason === 'string' && reason ? { reason: reason.slice(0, 80) } : {}), ...(Number.isFinite(tokens) ? { tokens } : {}), ...(Number.isFinite(latencyMs) ? { latencyMs } : {}), ...effort, ...extra };
    return { ...wake, history: [...(wake.history ?? []), record].slice(-50) };
  }
  if (outcome === 'work') { /* admitted, not visible yet: level, ticks and the quiet count stay (C2) */ }
  else if (outcome === 'failed') { level = Math.min(WAKE_LADDER.length - 1, level + 1); ticks = 0; }
  else { ticks++; if (outcome === 'thought') quietWakes++; if (ticks >= WAKE_HOLD) { level = Math.min(WAKE_LADDER.length - 1, level + 1); ticks = 0; } }
  const delay = delayFor(level);
  // A failed wake keeps its reason so later review can tell an upgrade, a provider error and a real fault apart.
  // `prompt`: the decision request's size and how much of it repeated the previous request (a cache-prefix measurement).
  const record = { at: new Date(now).toISOString(), outcome, floor, ...(outcome === 'work' ? { pending: true } : {}), ...(typeof reason === 'string' && reason ? { reason: reason.slice(0, 80) } : {}), ...(Number.isFinite(tokens) ? { tokens } : {}), ...(Number.isFinite(latencyMs) ? { latencyMs } : {}),
    ...(prompt?.measured ? { prompt: { chars: (prompt.systemChars ?? 0) + (prompt.textChars ?? 0), shared: prompt.sharedRatio, divergedIn: String(prompt.divergedIn ?? 'none').slice(0, 60),
      // Which system prompt the decision used (the project's shared agent prefix or its own) and a short fingerprint,
      // so a 'system' divergence can be told apart: no prefix yet (restart), another model, or a changed project prompt.
      ...(prompt.prefix ? { prefix: prompt.prefix } : {}), ...(typeof prompt.systemHash === 'string' ? { systemHash: prompt.systemHash } : {}) } } : {}),
    // A judgment plan the model wrote on a wake that did not accept one (the SDK dropped it), with what it cost.
    ...(prompt?.judgmentPolicyDropped ? { judgmentPolicyDropped: { outputTokens: Number.isFinite(prompt.judgmentPolicyDropped.outputTokens) ? prompt.judgmentPolicyDropped.outputTokens : 0 } } : {}), ...effort, ...extra };
  // `...wake` keeps what the ladder also holds (the last visible outcome's time, which only applyWorkOutcome moves).
  return { ...wake, level, ticksAtLevel: ticks, quietWakes, lastAt: new Date(now).toISOString(), nextAt: new Date(now + delay).toISOString(), lastOutcome: outcome, history: [...(wake.history ?? []), record].slice(-50) };
}
/**
 * The ladder's step when an action a wake admitted reaches an outcome (a work-outcome.mjs transition `to`): Headlong's
 * backoff decision (monolith/step:582-615) read from what happened, not from what was admitted.
 *  - visible: something happened outside the head (a change kept in the project folder, a message that reached the user,
 *    a schedule made): level 0, ticks 0, quiet count 0, and `lastVisibleAt` (what cacheWakeAllowed reads);
 *  - none, undone: nothing visible came of it (a run that changed nothing and told nobody, a message the narrator
 *    dropped, a change the user took back): a thought (dwell WAKE_HOLD ticks, then descend; a paid wait is quiet);
 *  - failed: descend at once (a failed review's step);
 *  - pending: nothing (the admission left the ladder alone);
 *  - a `neutral` none (work-outcome.mjs: a cancellation the user, a restart or a scope change caused, which says nothing
 *    about whether the wake was needed): nothing, as an interrupted decision is never a quiet wake. A scope change that
 *    cancels a dozen queued actions is not a dozen empty wakes.
 * Pure. `now` re-arms the timer at the new level's delay (the transition's own time may be days old).
 */
export function applyWorkOutcome(wake = {}, transition, { now = Date.now() } = {}) {
  const to = transition?.to;
  if (transition?.neutral === true) return wake;
  let level = wake.level ?? 0, ticks = wake.ticksAtLevel ?? 0, quietWakes = wake.quietWakes ?? 0, visible = {};
  if (to === 'visible') {
    level = 0; ticks = 0; quietWakes = 0;
    const when = at(transition.at);
    visible = { lastVisibleAt: new Date(Number.isFinite(when) ? Math.min(when, now) : now).toISOString(), ...(typeof transition.actionId === 'string' ? { lastVisibleActionId: transition.actionId } : {}) };
  } else if (to === 'failed') { level = Math.min(WAKE_LADDER.length - 1, level + 1); ticks = 0; }
  else if (to === 'none' || to === 'undone') { ticks++; quietWakes++; if (ticks >= WAKE_HOLD) { level = Math.min(WAKE_LADDER.length - 1, level + 1); ticks = 0; } }
  else return wake;
  return { ...wake, level, ticksAtLevel: ticks, quietWakes, nextAt: new Date(now + delayFor(level)).toISOString(), ...visible };
}
/** Which model tier a wake would run on (Headlong monolith/step:425-441), the two tiers there are. */
export const WAKE_TIERS = Object.freeze(['request', 'think']);
/** The facts that make a wake a request-tier wake (codes; wakeTier). */
export const WAKE_TIER_FACTS = Object.freeze(['conversation_outcome', 'proactive_reply', 'open_commitment', 'overdue_commitment', 'failure_review', 'answered_card']);
/**
 * C2, shadow only: the tier a wake would be answered on, computed in code from facts, never judged (AGENTS.md: compute in
 * code what code can compute; the plan: no JEV routing). Headlong picks it from two facts (monolith/step:425-441: a
 * reactive wake, or one with an open pending request, runs on the request model; every other wake, 700 to 900 of about
 * a thousand a day, runs on the think model) and measured that the expensive model's share fell 70-80%. Rna's facts:
 *  - conversation_outcome: a foreground turn's result is evidence for this wake (the reactive wake);
 *  - proactive_reply: a user message that targets one of the initiative's own items (`capture.target`, named by JEV or
 *    the fast model: the regex fallback's guess is not a fact);
 *  - open_commitment, overdue_commitment: a request of the user's is still owed;
 *  - failure_review: the wake reviews a failure;
 *  - answered_card: a card the initiative put up was answered.
 * Everything else (the floor, a timer, a review that is due, a post-work wake that owes no request) is the think tier.
 * It is only recorded on the wake row: nothing reads it to route, lower an effort or pick a model (a cheaper model is a
 * quality change that needs the GLM replay the user deferred), so the wake mix is measured before it is acted on.
 * @param {Partial<Record<'conversationOutcome'|'proactiveReply'|'openCommitment'|'overdueCommitment'|'failureReview'|'answeredCard', boolean>>} facts
 */
export function wakeTier(facts = {}) {
  const present = [facts.conversationOutcome && 'conversation_outcome', facts.proactiveReply && 'proactive_reply', facts.openCommitment && 'open_commitment', facts.overdueCommitment && 'overdue_commitment', facts.failureReview && 'failure_review', facts.answeredCard && 'answered_card'].filter(Boolean);
  return { tier: present.length ? 'request' : 'think', facts: present };
}
/** A share resets the quiet-wake nudge (the Headlong hint counter resets when it fires or a share goes out). */
export const noteShared = (wake = {}) => ({ ...wake, quietWakes: 0 });
/**
 * PDL-4: a floor wake that fired but reached no decision (the coordinator found the request too large for the budget
 * left, or work started in the same drain) is a no-op (Headlong monolith_backoff.md:173, 261-265): level, ticks, the
 * quiet count, the last outcome and the history stay as they were. Only its timer re-arms at the current level's delay,
 * so the floor is not tried again on every pump.
 */
export const rearmWake = (wake = {}, { now = Date.now() } = {}) => ({ ...wake, nextAt: new Date(now + delayFor(wake.level ?? 0)).toISOString() });
/**
 * Cache-aligned early wake (J2 hook) as one pacing input: an idle periodic
 * review may run early while the provider still caches the prefix only when
 * the project is in an active phase (recent real work, open agenda or
 * commitments, or the user seen recently) and it is not the user's night.
 * Deep backoff or night keeps the model's own interval.
 * "Recent real work" is the latest VISIBLE outcome (`wake.lastVisibleAt`, written by applyWorkOutcome; C2), within the
 * window the user's own presence counts for here: a decision the host merely admitted (the old `lastOutcome === 'work'`)
 * is a promise, and a run that came to nothing is not activity.
 */
export function cacheWakeAllowed(project, rhythm, { now = Date.now() } = {}) {
  const mind = project?.mind, pacing = mind?.pacing;
  if (!pacing || pacing.night || rhythm?.initiative?.eligible === false && rhythm?.initiative?.reason !== 'review_interval') return false;
  const open = openOf(mind), seen = at(pacing.lastPresenceAt), visible = at(pacing.wake?.lastVisibleAt);
  return (pacing.wake?.level ?? 0) <= 1 && (open.agenda.length + open.commitments.length > 0 || Number.isFinite(seen) && now - seen <= ACTIVE_WINDOW_MS || Number.isFinite(visible) && now - visible <= ACTIVE_WINDOW_MS);
}
