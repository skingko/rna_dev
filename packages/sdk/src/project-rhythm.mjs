import { validateToolArguments } from './capabilities.mjs';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MAX_INSTANT = 8640000000000000 - WEEK;
const text = maxLength => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' });

/** A semantic assessment, produced as part of an existing project decision.
 * It is not permission to enable a lane, publish a message or execute a task. */
export const projectRhythmAssessmentSchema = {
  type: 'object', additionalProperties: false,
  required: ['lifecycle', 'reason', 'evidenceIds', 'scheduleIds', 'initiative', 'evolution'],
  properties: {
    lifecycle: { enum: ['active', 'recurring', 'blocked', 'complete'] },
    reason: text(2000),
    evidenceIds: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: text(300) },
    scheduleIds: { type: 'array', maxItems: 64, uniqueItems: true, items: text(100) },
    initiative: {
      type: 'object', additionalProperties: false, required: ['mode', 'reviewAfterMs'],
      properties: { mode: { enum: ['adaptive', 'event_only'] }, reviewAfterMs: { type: 'integer', minimum: 60000, maximum: WEEK } },
    },
    evolution: {
      type: 'object', additionalProperties: false, required: ['mode', 'maxPerDay', 'maxPerWeek', 'minIntervalMs'],
      properties: {
        mode: { enum: ['evidence', 'daily', 'weekly', 'off'] },
        maxPerDay: { type: 'integer', minimum: 0, maximum: 8 },
        maxPerWeek: { type: 'integer', minimum: 0, maximum: 28 },
        minIntervalMs: { type: 'integer', minimum: HOUR, maximum: WEEK },
      },
    },
  },
};

export class ProjectRhythmError extends Error {
  constructor(message, code = 'invalid_project_rhythm') { super(message); this.name = 'ProjectRhythmError'; this.code = code; }
}
const fail = message => { throw new ProjectRhythmError(message); };
const instant = (value, field) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_INSTANT) fail(`Invalid ${field}`);
  return value;
};
const optionalInstant = (value, field) => value === null ? null : instant(value, field);
const flag = (value, field) => { if (typeof value !== 'boolean') fail(`Invalid ${field}`); return value; };
const identifier = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 300;

function checkAssessment(value) {
  try { validateToolArguments(projectRhythmAssessmentSchema, value); }
  catch { fail('Project rhythm assessment does not match its declared contract'); }
}

/** Validate exact evidence and schedule references when accepting a model
 * proposal. Revalidate the host's revision before committing it. A later
 * removed schedule does not invalidate historical evidence; resolve uses the
 * current schedule records rather than trusting the assessment's references. */
export function validateProjectRhythmAssessment(value, { allowedEvidenceIds = [], schedules = [] } = {}) {
  checkAssessment(value);
  if (!Array.isArray(allowedEvidenceIds) || allowedEvidenceIds.some(id => !identifier(id)) || !Array.isArray(schedules)) fail('Invalid rhythm reference context');
  const allowed = new Set(allowedEvidenceIds), registered = new Set(schedules.map(row => row?.id));
  if (value.evidenceIds.some(id => !allowed.has(id))) fail('Project rhythm cites unavailable evidence');
  if (value.scheduleIds.some(id => !registered.has(id))) fail('Project rhythm cites an unregistered schedule');
  return structuredClone(value);
}

function scheduleSummary(schedules, now) {
  if (!Array.isArray(schedules)) fail('Invalid schedules');
  const active = [];
  const ids = new Set();
  for (const row of schedules) {
    if (!identifier(row?.id) || ids.has(row.id) || typeof row.enabled !== 'boolean') fail('Invalid schedule record');
    ids.add(row.id);
    if (!row.enabled || row.nextRunAt === null) continue;
    // Records belong to project-schedules, which already resolves calendar/DST
    // rules. Never compute a second recurrence or infer it from a task title.
    const at = typeof row.nextRunAt === 'string' ? Date.parse(row.nextRunAt) : NaN;
    instant(at, 'schedule nextRunAt');
    active.push(at);
  }
  return { activeCount: active.length, dueCount: active.filter(at => at <= now).length, nextAt: active.length ? Math.min(...active) : null };
}

function attemptsView(attempts, now, limits) {
  if (!Array.isArray(attempts)) fail('Invalid learning attempts');
  const byId = new Map();
  for (const row of attempts) {
    if (!identifier(row?.id) || !['automatic', 'manual'].includes(row.source)) fail('Invalid learning admission');
    instant(row.at, 'learning admission at');
    const previous = byId.get(row.id);
    if (previous && (previous.at !== row.at || previous.source !== row.source)) fail('Conflicting learning admission identity');
    byId.set(row.id, row);
  }
  // An admission counts even if it later fails, is cancelled or has an unknown
  // result. Clock rollback must not make already admitted work free again.
  const automatic = [...byId.values()].filter(row => row.source === 'automatic').map(row => row.at).sort((a, b) => a - b);
  const day = automatic.filter(at => at > now - DAY), week = automatic.filter(at => at > now - WEEK);
  const quota = { dayUsed: day.length, weekUsed: week.length, maxPerDay: limits?.maxPerDay ?? null, maxPerWeek: limits?.maxPerWeek ?? null, window: 'rolling' };
  // When the window frees its next slot, or null while a slot is free (never `now`: see `lane`).
  const nextCapacity = (times, limit, window) => times.length < limit ? null : times[times.length - limit] + window;
  return { quota, lastAt: automatic.at(-1) ?? null, quotaZero: Boolean(limits) && (limits.maxPerDay === 0 || limits.maxPerWeek === 0),
    dayAt: limits && limits.maxPerDay > 0 ? nextCapacity(day, limits.maxPerDay, DAY) : null, weekAt: limits && limits.maxPerWeek > 0 ? nextCapacity(week, limits.maxPerWeek, WEEK) : null };
}
// `nextAt` is a value of the recorded state, never of the clock that read it: an anchor (when the lane became or
// becomes due), or null when nothing anchors it (nothing ran yet, a quota slot is free). A due lane without an anchor
// is `nextAt: null, state: 'ready'`. Project summaries carry this result, and a clock value in them changed every
// read (a resync every 5 s while idle, stream-protocol-v2 §1).
const lane = (eligible, reason, nextAt = null, state = eligible ? 'ready' : 'sleeping') => ({ eligible, reason, nextAt, state });

/** Pure admission projection; makes no network request, timer or mutation.
 *
 * `freshEvidence` must describe a host-verified external evidence revision,
 * not a periodic tick, model thought, wait decision, or repeated observation.
 * `learningAttempts` contains one durable row per started reflection batch;
 * provider retries stay within that admission. Retain all rows from the last
 * seven days (and future rows after clock rollback) across restarts.
 *
 * Hosts must persist admission before starting a provider request and serialize
 * gate + admission. This result does not replace permissions, token budgets,
 * failure backoff, source checks or a provider's uncertain-operation barrier.
 * Existing work/delivery/reconciliation and due scheduled duties are handled
 * independently; this gate only controls new autonomous decisions/reviews.
 */
export const ENGAGED_REVIEW_MS = 3 * 60000, STEERING_GAP_MS = 20 * 60000, STEERING_DAY_CEILING = 8, MIN_ENGAGED_LEARNING_MS = 30 * 60000;
/** How the conversation scales the resting cadence. `interaction`: { lastUserAt,
 * recentUserMessages (last 6 h), steering (corrections, lasting preferences or
 * improvement requests since the last learning review) }. */
export function interactionPace(interaction, now = Date.now()) {
  const recent = Number.isFinite(interaction?.recentUserMessages) ? Math.max(0, interaction.recentUserMessages) : 0;
  const steering = Number.isFinite(interaction?.steering) ? Math.max(0, interaction.steering) : 0;
  const live = Number.isFinite(interaction?.lastUserAt) && now - interaction.lastUserAt <= 30 * 60000;
  const speed = Math.min(8, 1 + recent / 6);
  return { live, steering, speed, extraPerDay: Math.floor(recent / 8), extraPerWeek: Math.floor(recent / 4) };
}
export function resolveProjectRhythm({
  assessment = null, schedules = [], now = Date.now(), initiativeEnabled = true,
  evolutionEnabled = true, control = 'auto', freshEvidence = false,
  hasPendingLearning = false, lastInitiativeAt = null, lastLearningAt = null,
  learningAttempts = [], interaction = null,
} = {}) {
  instant(now, 'clock'); optionalInstant(lastInitiativeAt, 'lastInitiativeAt'); optionalInstant(lastLearningAt, 'lastLearningAt');
  flag(initiativeEnabled, 'initiativeEnabled'); flag(evolutionEnabled, 'evolutionEnabled'); flag(freshEvidence, 'freshEvidence'); flag(hasPendingLearning, 'hasPendingLearning');
  if (!['auto', 'manual'].includes(control)) fail('Invalid rhythm control');
  if (assessment !== null) checkAssessment(assessment);
  const schedule = scheduleSummary(schedules, now);
  // The assessment sets a baseline for quiet periods; live conversation scales it (Headlong: engagement resets the pace).
  const pace = interactionPace(interaction, now);
  const limits = control === 'auto' && assessment?.evolution ? { ...assessment.evolution, maxPerDay: Math.min(8, assessment.evolution.maxPerDay + pace.extraPerDay), maxPerWeek: Math.min(28, assessment.evolution.maxPerWeek + pace.extraPerWeek) } : null;
  const attempts = attemptsView(learningAttempts, now, limits);
  const due = at => at === null || now >= at;
  const result = {
    control, lifecycle: assessment?.lifecycle ?? 'unknown', assessmentRequired: control === 'auto' && assessment === null,
    effective: { initiativeEnabled, evolutionEnabled: evolutionEnabled && (control === 'manual' || assessment?.evolution.mode !== 'off') },
    schedule, initiative: null, evolution: null,
  };

  if (!initiativeEnabled) result.initiative = lane(false, 'user_disabled', null, 'disabled');
  else if (control === 'manual') result.initiative = lane(true, 'manual_control');
  else if (assessment === null) result.initiative = lane(true, 'assessment_required');
  else if (freshEvidence) result.initiative = lane(true, 'new_evidence');
  else if (pace.live && assessment.lifecycle !== 'complete') {
    // While the user is talking, the collaborator follows up within minutes whatever the resting cadence.
    const nextAt = lastInitiativeAt === null ? null : lastInitiativeAt + Math.min(ENGAGED_REVIEW_MS, assessment.initiative.reviewAfterMs);
    result.initiative = due(nextAt) ? lane(true, 'conversation_live', nextAt) : lane(false, 'conversation_follow_up', nextAt);
  }
  else if (assessment.lifecycle === 'recurring') result.initiative = lane(false, schedule.activeCount ? 'awaiting_scheduled_work' : 'recurring_schedule_missing', schedule.nextAt);
  else if (assessment.lifecycle === 'complete') result.initiative = lane(false, 'project_complete');
  else if (assessment.lifecycle === 'blocked') result.initiative = lane(false, 'awaiting_changed_prerequisite');
  else if (assessment.initiative.mode === 'event_only') result.initiative = lane(false, 'awaiting_evidence', schedule.nextAt);
  else {
    const nextAt = lastInitiativeAt === null ? null : lastInitiativeAt + assessment.initiative.reviewAfterMs;
    result.initiative = due(nextAt) ? lane(true, 'review_due', nextAt) : lane(false, 'review_interval', nextAt);
  }

  if (!evolutionEnabled) result.evolution = lane(false, 'user_disabled', null, 'disabled');
  else if (control === 'manual') result.evolution = lane(true, 'manual_control');
  else if (assessment === null) result.evolution = lane(false, 'assessment_required');
  else if (assessment.evolution.mode === 'off') result.evolution = lane(false, 'adaptive_evolution_off', null, 'disabled');
  else if (!hasPendingLearning) result.evolution = lane(false, 'no_unreviewed_evidence');
  else if (pace.steering > 0 && attempts.quota.dayUsed < STEERING_DAY_CEILING) {
    // The user corrected, set a lasting preference or asked for an improvement: learn from it soon, not on the resting cadence.
    const nextAt = attempts.lastAt === null ? null : attempts.lastAt + STEERING_GAP_MS;
    result.evolution = lane(due(nextAt), due(nextAt) ? 'user_steering' : 'steering_gap', nextAt);
  }
  else if (attempts.quotaZero) result.evolution = lane(false, 'automatic_review_quota_zero', null, 'disabled');
  else {
    const policy = assessment.evolution;
    const cadence = Math.max(Math.round(policy.minIntervalMs / pace.speed), MIN_ENGAGED_LEARNING_MS, policy.mode === 'daily' ? Math.round(DAY / pace.speed) : policy.mode === 'weekly' ? Math.round(WEEK / pace.speed) : 0);
    const anchors = [lastLearningAt, attempts.lastAt].filter(at => at !== null);
    // The latest of what still holds it back: the cadence after the last review, and each quota window's next free slot.
    const waits = [anchors.length ? Math.max(...anchors) + cadence : null, attempts.dayAt, attempts.weekAt].filter(at => at !== null);
    const nextAt = waits.length ? Math.max(...waits) : null;
    const reason = due(nextAt) ? 'learning_due'
      : nextAt === attempts.weekAt ? 'weekly_review_quota'
      : nextAt === attempts.dayAt ? 'daily_review_quota' : 'learning_interval';
    result.evolution = lane(due(nextAt), reason, nextAt);
  }
  result.evolution.quota = attempts.quota;
  return result;
}
