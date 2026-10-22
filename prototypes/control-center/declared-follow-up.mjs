import { oneLine } from '../../packages/sdk/src/proactive-message.mjs';

/**
 * A finished run declares its own follow-up (2026-10-22 study). Live, one project's scheduled report was followed every day by
 * two or three "same-day follow-up" runs, each chosen by a full decision of about 75K tokens that read the previous run's result
 * (work.completion report, 30 days: of 60 reviews that followed a completion, 36 ended in a wait, 12 in an action that left
 * nothing visible and 12 were productive; the follow-ups were narrowing the report's own list of rows still to verify). The run knows
 * what it left open better than a later review that reads six thousand characters of its reply, so it says so itself, the way it
 * already ends with a handoff line: `FOLLOW-UP: none`, or `FOLLOW-UP: <one concrete task>`.
 *
 * What the host does with a declaration (pure functions, no IO): when the only thing new since the last decision is runs that
 * declared (their completions, the delivery of a scheduled report, the files they changed) it makes the decision the review would
 * have made, without a request: the declared task is admitted as work (once, one task), or `none` is a wait that rests until the
 * schedule's next occurrence. Everything else is the model's, as before: a run that wrote no declaration, a reply that was cut
 * short, an unfinished or unconfirmed run, a run that resolves a request of the user's, any other new evidence (a user message,
 * a foreground turn, a failure), a due schedule, an overdue request, a question waiting for an answer, and a chain of declared
 * follow-ups that has run its course (FOLLOW_UP_MAX_DEPTH). Only scheduled occurrences and follow-ups that were themselves
 * declared may settle a review this way: the user is not waiting for them, and a scheduled report is delivered by the host.
 */
export const FOLLOW_UP_MAX_DEPTH = 4;
const DAY = 86400000, MINUTE = 60000;

/**
 * What the run is told about the line (fixed English: the model reads it; the line is removed before anything is delivered).
 * Appended to a scheduled occurrence's task and to the content of a declared follow-up, never to the shared system prompt.
 */
export const FOLLOW_UP_INSTRUCTION = 'Before the handoff line, add one line "FOLLOW-UP: none" when nothing in this result needs a later check today, or "FOLLOW-UP: <one concrete task>" naming exactly what to check and where (one bounded check that can finish within the day, written so a run that has not seen this one can do it). The host starts that one task and removes the line before anything is delivered; leave the line out and the project reviews this run itself, as before.';

/** Evidence that is only what the finished runs did: their completions (below), the delivery of the report, the files they changed, schedule and project state. */
const FROM_THE_RUNS = new Set(['action_completed', 'workspace_change', 'scheduled_occurrence', 'schedule_state', 'project_state']);
const retained = row => Boolean(row) && !row.sourceDeleted && !row.contextRevoked && row.simulated !== true;
const titleOf = task => oneLine(task, 80);

/** The time until the next enabled schedule's occurrence, in ms (at least a minute, at most a day), or null when there is none. */
export function untilNextRun(project, now) {
  const next = (project?.schedules ?? []).filter(row => row && row.enabled !== false && Number.isFinite(Date.parse(row.nextRunAt))).map(row => Date.parse(row.nextRunAt)).filter(at => at > now).sort((a, b) => a - b)[0];
  return next === undefined ? null : Math.min(DAY, Math.max(MINUTE, next - now));
}

/**
 * The decision the host can make from declarations alone for this unread evidence, or null (the model decides).
 * `unread`: the evidence rows no decision has read ({ id, type, at }); `actions`: the coordinator's action rows;
 * `project.jobs` holds each run's `followUp` ({ kind: 'none' } | { kind: 'task', task }) and its status.
 * Returns `{ decision, meta }`: `decision` is shaped like a model's (the coordinator validates it the same way), `meta` is
 * what the action row and the wake record keep ({ kind, from: [run ids], depth }).
 */
export function declaredFollowUp({ project, unread, actions, now = Date.now() } = {}) {
  if (!Array.isArray(unread) || !unread.length || !Array.isArray(actions)) return null;
  if (unread.some(row => !FROM_THE_RUNS.has(row?.type))) return null;
  const byEvent = new Map(actions.map(action => [`action:${action.id}:completed`, action]));
  const runs = [];
  for (const row of unread.filter(item => item.type === 'action_completed')) {
    const action = byEvent.get(row.id);
    if (!action) return null;
    // The delivery of a scheduled report is the host's own, and what it delivered is the run's.
    if (action.action === 'share' && action.hostSchedule) continue;
    if (action.action !== 'work' || !(action.hostSchedule || action.hostDeclared) || action.status !== 'completed' || (Array.isArray(action.resolves) && action.resolves.length)) return null;
    const job = (project?.jobs ?? []).find(candidate => candidate?.id === action.id && candidate.lane === 'background');
    const followUp = job?.followUp;
    if (!job || !retained(job) || job.status !== 'completed' || job.unreported === true || !followUp || !['none', 'task'].includes(followUp.kind)) return null;
    runs.push({ event: row, action, followUp, depth: Number.isInteger(action.hostDeclared?.depth) ? action.hostDeclared.depth : 0 });
  }
  if (!runs.length) return null;
  const from = runs.map(run => run.action.id), task = runs.find(run => run.followUp.kind === 'task' && typeof run.followUp.task === 'string' && run.followUp.task.trim());
  if (task) {
    if (task.depth >= FOLLOW_UP_MAX_DEPTH) return null;
    return { decision: { action: 'work', title: titleOf(task.followUp.task), reason: 'The run that just finished declared this follow-up.', evidenceIds: [task.event.id], content: `${task.followUp.task.trim()}\n\n${FOLLOW_UP_INSTRUCTION}`, nextReviewAfterMs: 10 * MINUTE }, meta: { kind: 'task', from, depth: task.depth + 1 } };
  }
  if (runs.some(run => run.followUp.kind !== 'none')) return null;
  return { decision: { action: 'wait', reason: 'The run that just finished declared no follow-up.', evidenceIds: [], content: '', nextReviewAfterMs: untilNextRun(project, now) ?? DAY }, meta: { kind: 'none', from, depth: Math.max(...runs.map(run => run.depth)) } };
}
