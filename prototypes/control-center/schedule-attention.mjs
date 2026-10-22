import { projectSchedulePeriodMs } from '../../packages/sdk/src/project-schedules.mjs';
import { conversationTimeline } from './proactive-pacing.mjs';

// Does anyone read what a schedule delivers? A registered schedule is the user's own instruction, so the system never
// stops one; when a run of its results went unread while the user was away, it asks once (the `schedule_pause`
// invitation) and only the user's answer changes `enabled`. Everything here is read from structure, in code: which result
// reached which inbox entry, whether it was opened or answered, how long the oldest unread one has waited, whether the
// user wrote anything since. Nothing is judged from text (AGENTS.md: compute in code what code can compute).
//
// Measured on the live project whose daily 09:00 research report went unread after 2026-10-17 (21 deliveries, 2026-09-29
// to 10-21): up to then the user read a result within its own day, or came back after at most 2 unread days (10-11 and
// 10-12, read on 10-13) and read them all; "ignored" (no reply within the window) was the outcome of 19 of the last 20
// results although most were read, so a missing reply says nothing about a report and only an unread result counts.
// The unread run at the end was 4 results and 4 days long. Hence a run of at least MIN_RUN unread results whose oldest has
// waited AWAY_MIN_MS, above the longest run the user has ever come back from, and above any run they said keep to.
const DAY = 86400000;
/** Unread results in a row before a pause is worth asking about at all (the longest absence the live user returned from: 2). */
export const MIN_RUN = 3;
/** The oldest unread result has waited at least this long (a schedule that fires often is not "away" after a few runs). */
export const AWAY_MIN_MS = 2 * DAY;
/** A result is read once the user has opened it; a vote, a reply, an answer or a dismissal also settles it. */
const REPLIED = new Set(['replied', 'acted', 'dismissed']);
const at = value => Date.parse(value);
/** What the user did about one delivered result: 'responded' (reply, answer, vote, dismissal, or an edit of the schedule
 * itself after it arrived: switching it back on, changing its time), 'prompt' (read within one period), 'late' (read only
 * after a whole period: they had been away), 'unread' (still not opened, and a whole period old), 'pending' (not opened
 * yet, less than a period old: too early to say). `editedAt`: when the user last edited the schedule. */
export function attentionOf({ entry, item = null, deliveredAt, period, now, editedAt = NaN }) {
  if (entry?.status === 'dismissed' || entry?.actedAt || REPLIED.has(entry?.feedback?.outcome) || item?.feedback?.vote === 'up' || item?.feedback?.vote === 'down') return 'responded';
  const created = at(entry?.createdAt ?? deliveredAt), read = at(entry?.readAt);
  if (Number.isFinite(read)) return read - created < period ? 'prompt' : 'late';
  if (created < editedAt) return 'responded';
  return now - created >= period ? 'unread' : 'pending';
}
/**
 * The results a schedule delivered, oldest first, each with what the user did about it. A result joins its inbox entry by the
 * delivery action (a quiet delivery by its entry id); a result with no entry (archived, never filed) is left out.
 */
export function deliveriesOf(project, schedule, sessions, { now = Date.now() } = {}) {
  const byAction = new Map(), byId = new Map(), items = new Map();
  for (const row of project.inbox ?? []) if (!row.contextRevoked) { byId.set(row.id, row); byAction.set(row.actionId, row); }
  for (const session of sessions) for (const item of session.items ?? []) if (item.scheduleId === schedule.id) items.set(item.id, item);
  const rows = [];
  for (const occurrence of project.scheduleRuntime?.occurrences ?? []) {
    if (occurrence.scheduleId !== schedule.id || occurrence.status !== 'delivered') continue;
    const entry = byAction.get(occurrence.deliveryActionId) ?? byId.get(occurrence.deliveryInboxId);
    const period = projectSchedulePeriodMs(schedule, occurrence.scheduledAt);
    if (!entry || period === null) continue;
    rows.push({ key: occurrence.key, at: entry.createdAt, entryId: entry.id, state: attentionOf({ entry, item: items.get(occurrence.deliveryItemId ?? entry.itemId), deliveredAt: occurrence.deliveredAt, period, now, editedAt: at(schedule.userEditedAt) }) });
  }
  return rows.sort((a, b) => at(a.at) - at(b.at));
}
/**
 * The unread run at the end of the deliveries (newest back to the last result the user opened or answered; results too new to
 * say are passed over) and the longest run of late reads before it: absences the user came back from by reading everything.
 */
export function runsOf(deliveries) {
  let run = [], resolved = 0, late = 0, ended = false;
  for (const row of [...deliveries].reverse()) {
    if (!ended) { if (row.state === 'unread') { run.push(row); continue; } if (row.state === 'pending') continue; ended = true; }
    if (row.state === 'late') resolved = Math.max(resolved, ++late); else if (row.state !== 'pending') late = 0;
  }
  run = run.reverse();
  return { run, count: run.length, since: run[0]?.at ?? null, last: run.at(-1)?.at ?? null, resolved };
}
/** Has the user written (or answered a card) in the project since `since`? The timeline holds only the user's and the initiative's messages. */
const wroteSince = (sessions, since) => conversationTimeline(sessions).some(row => row.kind === 'user' && row.at > since);
/**
 * Whether to ask about pausing `schedule` now, and what the card says. `prior` is `project.schedulePauseAsks[schedule.id]`:
 * what an earlier ask got. Refusing (an answer of "keep", or closing the card) is evidence that the user wants these results
 * even unread: the next run must be twice as long as the one they refused; a card that only lapsed lets the same run be
 * asked again after MIN_RUN more unread results. Nothing here is a fixed number of asks: the bar rises with the evidence.
 * Returns { ask: false, why } or { ask: true, count, since, last, required }.
 */
export function pauseVerdict(project, schedule, sessions, { now = Date.now() } = {}) {
  if (!schedule?.enabled || schedule.rule?.kind === 'once') return { ask: false, why: 'not_recurring' };
  const { count, since, last, resolved } = runsOf(deliveriesOf(project, schedule, sessions, { now }));
  const prior = project.schedulePauseAsks?.[schedule.id] ?? null;
  let required = Math.max(MIN_RUN, resolved + 1);
  if (prior?.refusedRun) required = Math.max(required, prior.refusedRun * 2);
  if (prior && prior.since === since && prior.outcome === 'asked') required = Math.max(required, prior.run + MIN_RUN);
  if (count < required) return { ask: false, why: 'run_too_short', count, required };
  const waited = now - at(since);
  if (!(waited >= AWAY_MIN_MS)) return { ask: false, why: 'not_away_long_enough', count, required };
  if (wroteSince(sessions, at(since))) return { ask: false, why: 'user_wrote_since', count, required };
  return { ask: true, count, since, last, required };
}
