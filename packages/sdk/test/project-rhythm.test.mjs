import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRhythmAssessmentSchema, validateProjectRhythmAssessment, resolveProjectRhythm, ProjectRhythmError } from '../src/project-rhythm.mjs';
import { createProjectSchedule, projectScheduleDue } from '../src/project-schedules.mjs';

const HOUR = 3600000, DAY = 24 * HOUR, WEEK = 7 * DAY;
const NOW = Date.parse('2026-09-26T04:00:00Z');
function assessment(patch = {}) {
  const base = { lifecycle: 'active', reason: 'The current project has a verified unfinished deliverable.', evidenceIds: ['event-1'], scheduleIds: [], initiative: { mode: 'adaptive', reviewAfterMs: HOUR }, evolution: { mode: 'evidence', maxPerDay: 2, maxPerWeek: 7, minIntervalMs: HOUR } };
  return { ...base, ...patch, initiative: { ...base.initiative, ...patch.initiative }, evolution: { ...base.evolution, ...patch.evolution } };
}
const resolve = patch => resolveProjectRhythm({ now: NOW, assessment: assessment(), ...patch });
const admission = (id, at, source = 'automatic', status = 'failed') => ({ id, at, source, status });
const recurringSchedule = (patch = {}) => ({ id: 'daily-report', enabled: true, nextRunAt: new Date(NOW + 20 * HOUR).toISOString(), ...patch });

test('strict assessment preserves exact evidence and schedule identity without interpreting the project name', () => {
  const value = assessment({ lifecycle: 'recurring', reason: '游戏工作台 is a daily reporting responsibility by verified description, not by its name.', scheduleIds: ['daily-report'] });
  const checked = validateProjectRhythmAssessment(value, { allowedEvidenceIds: ['event-1'], schedules: [recurringSchedule()] });
  assert.deepEqual(checked, value); assert.notEqual(checked, value);
  checked.initiative.mode = 'event_only'; assert.equal(value.initiative.mode, 'adaptive');
  assert.equal(projectRhythmAssessmentSchema.additionalProperties, false);
});

test('acceptance rejects fabricated evidence, a receipt substituted for evidence, and guessed schedule ids', () => {
  for (const value of [assessment({ evidenceIds: ['invented'] }), assessment({ evidenceIds: ['receipt-event-1'] }), assessment({ scheduleIds: ['invented'] })]) {
    assert.throws(() => validateProjectRhythmAssessment(value, { allowedEvidenceIds: ['event-1'], schedules: [] }), ProjectRhythmError);
  }
});

test('assessment rejects unbounded or malformed policy rather than silently substituting defaults', () => {
  for (const value of [assessment({ lifecycle: 'unknown' }), assessment({ reason: ' ' }), assessment({ evidenceIds: [] }), assessment({ evidenceIds: ['event-1', 'event-1'] }), assessment({ enabled: true }), assessment({ initiative: { mode: 'off' } }), assessment({ initiative: { reviewAfterMs: 1 } }), assessment({ evolution: { maxPerDay: 9 } }), assessment({ evolution: { maxPerWeek: 29 } }), assessment({ evolution: { minIntervalMs: 0 } })]) {
    assert.throws(() => validateProjectRhythmAssessment(value, { allowedEvidenceIds: ['event-1'] }), ProjectRhythmError);
  }
});

test('auto without an assessment admits ordinary initiative understanding but holds paid learning', () => {
  const value = resolve({ assessment: null, hasPendingLearning: true });
  assert.equal(value.assessmentRequired, true);
  assert.equal(value.initiative.eligible, true); assert.equal(value.initiative.reason, 'assessment_required');
  assert.equal(value.evolution.eligible, false); assert.equal(value.evolution.reason, 'assessment_required');
});

test('manual control does not apply a model assessment or invent adaptive limits', () => {
  const value = resolve({ control: 'manual', assessment: assessment({ lifecycle: 'complete', evolution: { mode: 'off', maxPerDay: 0, maxPerWeek: 0 } }), hasPendingLearning: true });
  assert.equal(value.initiative.reason, 'manual_control'); assert.equal(value.evolution.reason, 'manual_control');
  assert.equal(value.initiative.eligible, true); assert.equal(value.evolution.eligible, true);
  assert.equal(value.evolution.quota.maxPerDay, null); assert.equal(value.assessmentRequired, false);
});

test('explicit user lane disable wins over every semantic mode, fresh evidence and manual control', () => {
  for (const control of ['auto', 'manual']) for (const lifecycle of ['active', 'recurring', 'blocked', 'complete']) {
    const value = resolve({ control, assessment: assessment({ lifecycle }), initiativeEnabled: false, evolutionEnabled: false, freshEvidence: true, hasPendingLearning: true });
    assert.equal(value.initiative.reason, 'user_disabled'); assert.equal(value.evolution.reason, 'user_disabled');
    assert.equal(value.initiative.eligible, false); assert.equal(value.evolution.eligible, false);
    assert.equal(value.effective.initiativeEnabled, false); assert.equal(value.effective.evolutionEnabled, false);
  }
});

test('an evolution-off assessment cannot be bypassed by newly pending evidence', () => {
  const value = resolve({ assessment: assessment({ evolution: { mode: 'off' } }), freshEvidence: true, hasPendingLearning: true });
  assert.equal(value.initiative.eligible, true); assert.equal(value.evolution.reason, 'adaptive_evolution_off');
  assert.equal(value.effective.evolutionEnabled, false);
});

test('active initiative uses the previous review anchor, not each scheduler tick', () => {
  const early = resolve({ lastInitiativeAt: NOW - HOUR + 1 });
  assert.equal(early.initiative.eligible, false); assert.equal(early.initiative.nextAt, NOW + 1);
  const due = resolve({ lastInitiativeAt: NOW - HOUR });
  assert.equal(due.initiative.eligible, true); assert.equal(due.initiative.reason, 'review_due');
  assert.equal(resolve({ lastInitiativeAt: 0 }).initiative.eligible, true);
});

test('a verified fresh external revision wakes active initiative ahead of its timer', () => {
  const value = resolve({ freshEvidence: true, lastInitiativeAt: NOW });
  assert.equal(value.initiative.eligible, true); assert.equal(value.initiative.reason, 'new_evidence');
});

test('event-only, completed and blocked projects stay dormant at arbitrary later ticks', () => {
  for (const value of [assessment({ initiative: { mode: 'event_only' } }), assessment({ lifecycle: 'complete' }), assessment({ lifecycle: 'blocked' })]) {
    for (let day = 0; day < 30; day++) {
      const result = resolve({ assessment: value, now: NOW + day * DAY, lastInitiativeAt: NOW - WEEK });
      assert.equal(result.initiative.eligible, false); assert.equal(result.initiative.nextAt, null);
    }
    assert.equal(resolve({ assessment: value, freshEvidence: true }).initiative.reason, 'new_evidence');
  }
});

test('recurring tasks never create generic review calls just because their delivery time is due', () => {
  for (const offset of [-HOUR, 0, HOUR]) {
    const nextRunAt = new Date(NOW + offset).toISOString();
    const value = resolve({ assessment: assessment({ lifecycle: 'recurring', scheduleIds: ['daily-report'] }), schedules: [recurringSchedule({ nextRunAt })] });
    assert.equal(value.initiative.eligible, false); assert.equal(value.initiative.reason, 'awaiting_scheduled_work');
    assert.equal(value.initiative.nextAt, NOW + offset); assert.equal(value.schedule.dueCount, offset <= 0 ? 1 : 0);
  }
});

test('actual project-schedules occurrence stays independent of an asleep or disabled initiative lane', () => {
  const task = createProjectSchedule({ id: 'daily-report', title: 'One daily report', task: 'Research and deliver one report.', destinationSessionId: 'conversation', rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }, { now: NOW - DAY });
  const occurrence = projectScheduleDue(task, NOW);
  assert.ok(occurrence);
  const value = resolve({ assessment: assessment({ lifecycle: 'recurring', scheduleIds: [task.id] }), schedules: [task], initiativeEnabled: false });
  assert.equal(value.initiative.eligible, false); assert.equal(value.schedule.dueCount, 1);
  assert.deepEqual(projectScheduleDue(task, NOW), occurrence);
});

test('recurring schedule pause, removal and completion are visible and do not resurrect the duty', () => {
  for (const schedules of [[], [recurringSchedule({ enabled: false })], [recurringSchedule({ nextRunAt: null })]]) {
    const value = resolve({ assessment: assessment({ lifecycle: 'recurring', scheduleIds: ['daily-report'] }), schedules });
    assert.equal(value.schedule.activeCount, 0); assert.equal(value.initiative.reason, 'recurring_schedule_missing');
    assert.equal(value.initiative.eligible, false); assert.equal(value.initiative.nextAt, null);
  }
});

test('delivery result can wake a recurring project exactly when host marks a fresh evidence revision', () => {
  const base = { assessment: assessment({ lifecycle: 'recurring' }), schedules: [recurringSchedule()] };
  assert.equal(resolve({ ...base, freshEvidence: true }).initiative.reason, 'new_evidence');
  assert.equal(resolve(base).initiative.eligible, false);
});

test('schedule projection picks the actual earliest enabled nextRunAt', () => {
  const value = resolve({ schedules: [recurringSchedule(), recurringSchedule({ id: 'paused', enabled: false, nextRunAt: new Date(NOW - DAY).toISOString() }), recurringSchedule({ id: 'earliest', nextRunAt: new Date(NOW + HOUR).toISOString() })] });
  assert.deepEqual(value.schedule, { activeCount: 2, dueCount: 0, nextAt: NOW + HOUR });
});

test('no unreviewed evidence means no paid learning regardless of daily or weekly timer expiry', () => {
  for (const mode of ['evidence', 'daily', 'weekly']) {
    const value = resolve({ assessment: assessment({ evolution: { mode } }), freshEvidence: true, lastLearningAt: NOW - 2 * WEEK });
    assert.equal(value.evolution.reason, 'no_unreviewed_evidence'); assert.equal(value.evolution.nextAt, null);
  }
});

test('first actual unreviewed batch may start without an artificial initial day/week delay', () => {
  for (const mode of ['evidence', 'daily', 'weekly']) {
    const value = resolve({ assessment: assessment({ evolution: { mode } }), hasPendingLearning: true });
    assert.equal(value.evolution.eligible, true); assert.equal(value.evolution.state, 'ready'); assert.equal(value.evolution.nextAt, null, 'due with nothing anchoring it');
  }
});

// A5: project summaries carry this projection; a lane that is due must read the same at every later tick, or each
// read of an idle project changed its summary (live: a resync every 5 s from `nextAt = now`).
test('a due lane holds a value of the recorded state, never the reading clock', () => {
  const steering = { lastUserAt: NOW - 60000, recentUserMessages: 2, steering: 1 };
  const cases = {
    'review due, never reviewed': { hasPendingLearning: true },
    'review due after its interval': { lastInitiativeAt: NOW - 2 * HOUR, lastLearningAt: NOW - 2 * DAY, hasPendingLearning: true },
    'conversation live, never reviewed': { interaction: { lastUserAt: NOW - 60000, recentUserMessages: 1, steering: 0 } },
    'steering, never learned': { interaction: steering, hasPendingLearning: true },
    'learning due while a quota slot is free': { learningAttempts: [admission('old', NOW - 3 * DAY)], hasPendingLearning: true },
  };
  for (const [name, input] of Object.entries(cases)) {
    const first = resolve(input), later = resolve({ ...input, now: NOW + 6000 }), much = resolve({ ...input, now: NOW + 60000 });
    assert.deepEqual(later, first, name); assert.deepEqual(much, first, name);
    for (const lane of [first.initiative, first.evolution]) if (lane.eligible) assert.ok(lane.nextAt === null || lane.nextAt <= NOW, `${name}: ${JSON.stringify(lane)}`);
  }
  // Unanchored and due: no instant at all; anchored and due: the anchor.
  assert.deepEqual([resolve({}).initiative.nextAt, resolve({}).initiative.state], [null, 'ready']);
  assert.equal(resolve({ lastInitiativeAt: NOW - 2 * HOUR }).initiative.nextAt, NOW - HOUR);
  assert.equal(resolve({ learningAttempts: [admission('old', NOW - 3 * DAY)], hasPendingLearning: true }).evolution.nextAt, NOW - 3 * DAY + HOUR);
});

test('daily and weekly semantics enforce elapsed cadence even when count limits allow more', () => {
  for (const [mode, interval] of [['daily', DAY], ['weekly', WEEK]]) {
    const input = { assessment: assessment({ evolution: { mode, maxPerDay: 8, maxPerWeek: 28 } }), hasPendingLearning: true, freshEvidence: true, lastLearningAt: NOW - interval + 1 };
    const before = resolve(input); assert.equal(before.evolution.eligible, false); assert.equal(before.evolution.nextAt, NOW + 1);
    assert.equal(resolve({ ...input, now: NOW + 1 }).evolution.eligible, true);
  }
});

test('minimum interval and admission anchor cannot be bypassed by new evidence or forgotten lastLearningAt', () => {
  const value = resolve({ hasPendingLearning: true, freshEvidence: true, lastLearningAt: NOW - WEEK, learningAttempts: [admission('latest', NOW - HOUR + 10)] });
  assert.equal(value.evolution.eligible, false); assert.equal(value.evolution.nextAt, NOW + 10);
  assert.equal(value.evolution.reason, 'learning_interval');
});

test('failed, unknown and cancelled admissions still consume the automatic rolling day quota', () => {
  for (const status of ['failed', 'unknown', 'cancelled', 'no_change', 'completed']) {
    const value = resolve({ hasPendingLearning: true, freshEvidence: true, learningAttempts: [admission('a', NOW - 3 * HOUR, 'automatic', status), admission('b', NOW - 2 * HOUR, 'automatic', status)] });
    assert.equal(value.evolution.reason, 'daily_review_quota'); assert.equal(value.evolution.nextAt, NOW + 21 * HOUR);
    assert.equal(value.evolution.quota.dayUsed, 2); assert.equal(value.evolution.eligible, false);
  }
});

test('weekly quota applies when all daily admissions have aged out', () => {
  const value = resolve({ assessment: assessment({ evolution: { maxPerWeek: 2 } }), hasPendingLearning: true, learningAttempts: [admission('a', NOW - 6 * DAY), admission('b', NOW - 2 * DAY)] });
  assert.equal(value.evolution.reason, 'weekly_review_quota'); assert.equal(value.evolution.nextAt, NOW + DAY);
  assert.equal(value.evolution.quota.dayUsed, 0); assert.equal(value.evolution.quota.weekUsed, 2);
});

test('quota release waits for enough old admissions after a policy reduces the limit', () => {
  const value = resolve({ assessment: assessment({ evolution: { maxPerDay: 1 } }), hasPendingLearning: true, learningAttempts: [admission('a', NOW - 4 * HOUR), admission('b', NOW - 3 * HOUR), admission('c', NOW - 2 * HOUR)] });
  assert.equal(value.evolution.nextAt, NOW + 22 * HOUR);
});

test('quota windows expire exactly at 24 hours / 7 days instead of local midnight', () => {
  const attempts = [admission('day', NOW - DAY), admission('week', NOW - WEEK)];
  const value = resolve({ hasPendingLearning: true, learningAttempts: attempts });
  assert.equal(value.evolution.eligible, true); assert.equal(value.evolution.quota.dayUsed, 0); assert.equal(value.evolution.quota.weekUsed, 1);
  const before = resolve({ now: NOW - 1, hasPendingLearning: true, learningAttempts: attempts });
  assert.equal(before.evolution.quota.dayUsed, 1); assert.equal(before.evolution.quota.weekUsed, 2);
  assert.equal(value.evolution.quota.window, 'rolling');
});

test('manual evaluations remain visible input but cannot consume automatic quotas or set its admission clock', () => {
  const value = resolve({ hasPendingLearning: true, learningAttempts: [admission('manual', NOW, 'manual')] });
  assert.equal(value.evolution.eligible, true); assert.equal(value.evolution.quota.dayUsed, 0); assert.equal(value.evolution.quota.weekUsed, 0);
});

test('transport retries sharing a batch identity count once, while conflicting identities fail closed', () => {
  const first = admission('batch', NOW - 2 * HOUR);
  const value = resolve({ hasPendingLearning: true, learningAttempts: [first, { ...first, status: 'completed' }] });
  assert.equal(value.evolution.quota.dayUsed, 1);
  assert.throws(() => resolve({ learningAttempts: [first, { ...first, at: NOW }] }), ProjectRhythmError);
  assert.throws(() => resolve({ learningAttempts: [first, { ...first, source: 'manual' }] }), ProjectRhythmError);
});

test('zero automatic quotas wait indefinitely and are not bypassed by fresh evidence', () => {
  for (const evolution of [{ maxPerDay: 0 }, { maxPerWeek: 0 }]) {
    const value = resolve({ assessment: assessment({ evolution }), hasPendingLearning: true, freshEvidence: true });
    assert.equal(value.evolution.reason, 'automatic_review_quota_zero'); assert.equal(value.evolution.nextAt, null); assert.equal(value.evolution.eligible, false);
  }
});

test('completion can still learn once from pending final delivery evidence without manufacturing new work', () => {
  const value = resolve({ assessment: assessment({ lifecycle: 'complete' }), hasPendingLearning: true });
  assert.equal(value.initiative.eligible, false); assert.equal(value.evolution.eligible, true);
  assert.equal(resolve({ assessment: assessment({ lifecycle: 'complete' }) }).evolution.reason, 'no_unreviewed_evidence');
});

test('clock rollback preserves future admissions and does not produce a free retry', () => {
  const value = resolve({ hasPendingLearning: true, learningAttempts: [admission('future-a', NOW + HOUR), admission('future-b', NOW + 2 * HOUR)], lastInitiativeAt: NOW + HOUR });
  assert.equal(value.evolution.quota.dayUsed, 2); assert.equal(value.evolution.nextAt, NOW + DAY + HOUR);
  assert.equal(value.initiative.eligible, false); assert.equal(value.initiative.nextAt, NOW + 2 * HOUR);
});

test('malformed host clocks, booleans, admissions and schedule projections are explicit errors', () => {
  for (const patch of [{ now: NaN }, { now: -1 }, { now: 1.5 }, { lastLearningAt: '2026-09-26' }, { control: 'automatic' }, { freshEvidence: 1 }, { initiativeEnabled: null }, { learningAttempts: [admission('x', NOW, 'timer')] }, { schedules: [recurringSchedule({ nextRunAt: 'not-a-date' })] }, { schedules: [recurringSchedule(), recurringSchedule()] }]) assert.throws(() => resolve(patch), ProjectRhythmError);
});

test('repeated pure projections never mutate assessments, admissions or schedule facts', () => {
  const input = { assessment: assessment({ lifecycle: 'recurring' }), schedules: [recurringSchedule()], learningAttempts: [admission('a', NOW - HOUR)], hasPendingLearning: true };
  const before = structuredClone(input);
  const first = resolve(input), second = resolve(input);
  assert.deepEqual(first, second); assert.deepEqual(input, before);
  first.evolution.quota.dayUsed = 999;
  assert.deepEqual(resolve(input), second);
});

test('the live conversation sets the pace: quick follow-ups, faster learning, steering learns within minutes', async () => {
  const { resolveProjectRhythm, interactionPace, ENGAGED_REVIEW_MS, STEERING_GAP_MS } = await import('../src/project-rhythm.mjs');
  const HOUR = 3600000, now = Date.parse('2026-09-30T10:00:00Z');
  const assessment = { lifecycle: 'active', reason: 'r', evidenceIds: ['e'], scheduleIds: [], initiative: { mode: 'adaptive', reviewAfterMs: 30 * 60000 }, evolution: { mode: 'evidence', maxPerDay: 1, maxPerWeek: 2, minIntervalMs: 24 * HOUR } };
  const attempt = at => ({ id: `a${at}`, at, source: 'automatic', status: 'completed' });
  const quiet = resolveProjectRhythm({ assessment, now, hasPendingLearning: true, lastInitiativeAt: now - 5 * 60000, learningAttempts: [attempt(now - 2 * HOUR)] });
  assert.equal(quiet.initiative.reason, 'review_interval'); assert.equal(quiet.evolution.eligible, false);
  const talking = { lastUserAt: now - 2 * 60000, recentUserMessages: 24, steering: 0 };
  const live = resolveProjectRhythm({ assessment, now, hasPendingLearning: true, lastInitiativeAt: now - 5 * 60000, learningAttempts: [attempt(now - 2 * HOUR)], interaction: talking });
  assert.equal(live.initiative.reason, 'conversation_live'); assert.equal(ENGAGED_REVIEW_MS, 3 * 60000);
  assert.equal(live.evolution.quota.maxPerDay, 4, 'frequent messages raise the daily limit');
  assert.equal(live.evolution.eligible, false, '24 h / speed 5 = 4.8 h since the last review has not passed');
  assert.equal(resolveProjectRhythm({ assessment, now, hasPendingLearning: true, learningAttempts: [attempt(now - 5 * HOUR)], interaction: talking }).evolution.eligible, true);
  const steered = resolveProjectRhythm({ assessment, now, hasPendingLearning: true, learningAttempts: [attempt(now - 25 * 60000)], interaction: { ...talking, steering: 1 } });
  assert.deepEqual([steered.evolution.eligible, steered.evolution.reason], [true, 'user_steering']);
  const tooSoon = resolveProjectRhythm({ assessment, now, hasPendingLearning: true, learningAttempts: [attempt(now - 5 * 60000)], interaction: { ...talking, steering: 1 } });
  assert.deepEqual([tooSoon.evolution.eligible, tooSoon.evolution.nextAt], [false, now - 5 * 60000 + STEERING_GAP_MS]);
  assert.equal(resolveProjectRhythm({ assessment, now, hasPendingLearning: false, interaction: { ...talking, steering: 3 } }).evolution.reason, 'no_unreviewed_evidence', 'no evidence, no review');
  assert.deepEqual(interactionPace(null, now), { live: false, steering: 0, speed: 1, extraPerDay: 0, extraPerWeek: 0 });
});
