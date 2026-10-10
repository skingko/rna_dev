import { createHash } from 'node:crypto';

export class ProjectScheduleError extends Error {
  constructor(message, code = 'invalid_schedule') { super(message); this.name = 'ProjectScheduleError'; this.code = code; }
}
const fail = message => { throw new ProjectScheduleError(message); };
const DAY = 86400000;
export const projectScheduleRuleSchema = {
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['kind', 'time', 'timeZone'], properties: { kind: { const: 'daily' }, time: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' }, timeZone: { type: 'string', minLength: 1, maxLength: 100 } } },
    { type: 'object', additionalProperties: false, required: ['kind', 'time', 'timeZone', 'days'], properties: { kind: { const: 'weekly' }, time: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' }, timeZone: { type: 'string', minLength: 1, maxLength: 100 }, days: { type: 'array', minItems: 1, maxItems: 7, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 7 } } } },
    { type: 'object', additionalProperties: false, required: ['kind', 'everyMs'], properties: { kind: { const: 'interval' }, everyMs: { type: 'integer', minimum: 300000, maximum: 31622400000 }, anchorAt: { type: 'string', description: 'Explicit-offset ISO instant; defaults to now plus interval.' } } },
    { type: 'object', additionalProperties: false, required: ['kind', 'at'], properties: { kind: { const: 'once' }, at: { type: 'string', description: 'Future ISO instant with an explicit numeric offset or Z.' } } }
  ]
};
export const projectScheduleInputSchema = { type: 'object', additionalProperties: false, required: ['title', 'task', 'rule'], properties: {
  title: { type: 'string', minLength: 1, maxLength: 160 }, task: { type: 'string', minLength: 1, maxLength: 6000 }, rule: projectScheduleRuleSchema,
  destinationSessionId: { type: 'string', minLength: 1, maxLength: 160 }, enabled: { type: 'boolean' }
} };
const formatters = new Map();
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('Schedule contains unknown fields');
}
function text(value, label, limit) { if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > limit) fail(`Invalid ${label}`); return value; }
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) fail('A schedule instant needs an explicit time zone');
  const parsed = Date.parse(value); if (!Number.isSafeInteger(parsed)) fail('Invalid schedule instant');
  // Date.parse normalizes impossible dates such as February 30.
  const day = value.slice(0, 10), local = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(local.getTime()) || local.toISOString().slice(0, 10) !== day || +value.slice(11, 13) > 23 || +value.slice(14, 16) > 59 || +value.slice(17, 19) > 59) fail('Invalid calendar instant');
  return new Date(parsed).toISOString();
}
function zone(value) {
  text(value, 'time zone', 100);
  if (value !== 'UTC' && !/^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/.test(value)) fail('Use an IANA time zone');
  try { return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone; } catch { fail('Unknown IANA time zone'); }
}
function formatter(timeZone) {
  if (!formatters.has(timeZone)) { if (formatters.size >= 64) formatters.delete(formatters.keys().next().value); formatters.set(timeZone, new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })); }
  return formatters.get(timeZone);
}
function parts(epoch, timeZone) { return Object.fromEntries(formatter(timeZone).formatToParts(epoch).filter(p => p.type !== 'literal').map(p => [p.type, p.value])); }
function localDay(epoch, timeZone) { const p = parts(epoch, timeZone); return `${p.year}-${p.month}-${p.day}`; }
function shiftedDay(day, offset) { return new Date(Date.parse(`${day}T12:00:00.000Z`) + offset * DAY).toISOString().slice(0, 10); }
// Offset samples cover both sides of a DST transition. Gaps are skipped; folds
// choose the earlier instant, so a repeated wall-clock minute fires only once.
function wallInstant(day, time, timeZone) {
  const desired = Date.parse(`${day}T${time}:00.000Z`), offsets = new Set();
  for (const delta of [-2, -1, 0, 1, 2]) {
    const sample = desired + delta * DAY, p = parts(sample, timeZone);
    offsets.add(Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`) - sample);
  }
  const candidates = [];
  for (const offset of offsets) { const epoch = desired - offset, p = parts(epoch, timeZone); if (`${p.year}-${p.month}-${p.day}` === day && `${p.hour}:${p.minute}` === time) candidates.push(epoch); }
  return candidates.length ? Math.min(...candidates) : null;
}
function allowedDay(rule, day) { const d = new Date(`${day}T12:00:00Z`).getUTCDay() || 7; return rule.kind !== 'weekly' || rule.days.includes(d); }
function calendarTarget(rule, now, direction) {
  const day = localDay(now, rule.timeZone);
  for (let i = 0; i <= 15; i++) { const date = shiftedDay(day, i * direction); if (!allowedDay(rule, date)) continue; const epoch = wallInstant(date, rule.time, rule.timeZone); if (epoch !== null && (direction > 0 ? epoch > now : epoch <= now)) return epoch; }
  fail('No occurrence could be resolved in this time zone');
}
function normalizeRule(rule, now) {
  if (rule?.kind === 'daily' || rule?.kind === 'weekly') {
    object(rule, ['kind', 'time', 'timeZone', ...(rule.kind === 'weekly' ? ['days'] : [])]);
    if (typeof rule.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(rule.time)) fail('Use HH:mm in 24-hour time');
    const result = { kind: rule.kind, time: rule.time, timeZone: zone(rule.timeZone) };
    if (rule.kind === 'weekly') { if (!Array.isArray(rule.days) || !rule.days.length || rule.days.length > 7 || rule.days.some(d => !Number.isInteger(d) || d < 1 || d > 7) || new Set(rule.days).size !== rule.days.length) fail('Weekly days must be unique ISO weekdays 1..7'); result.days = [...rule.days].sort((a, b) => a - b); }
    return result;
  }
  if (rule?.kind === 'interval') {
    object(rule, ['kind', 'everyMs', 'anchorAt']);
    if (!Number.isSafeInteger(rule.everyMs) || rule.everyMs < 300000 || rule.everyMs > 366 * DAY) fail('Interval must be from 5 minutes to 366 days');
    return { kind: 'interval', everyMs: rule.everyMs, anchorAt: rule.anchorAt === undefined ? new Date(now + rule.everyMs).toISOString() : instant(rule.anchorAt) };
  }
  if (rule?.kind === 'once') { object(rule, ['kind', 'at']); return { kind: 'once', at: instant(rule.at) }; }
  fail('Unsupported schedule rule');
}
function next(rule, now) {
  if (rule.kind === 'once') return Date.parse(rule.at) > now ? rule.at : null;
  if (rule.kind === 'interval') { const anchor = Date.parse(rule.anchorAt); return new Date(anchor > now ? anchor : anchor + (Math.floor((now - anchor) / rule.everyMs) + 1) * rule.everyMs).toISOString(); }
  return new Date(calendarTarget(rule, now, 1)).toISOString();
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sameRule = (a, b) => Boolean(a && b) && JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
/** Whether `epoch` is a window of the rule (one of its due instants). */
function windowOf(rule, epoch) {
  if (rule.kind === 'once') return Date.parse(rule.at) === epoch;
  if (rule.kind === 'interval') { const anchor = Date.parse(rule.anchorAt); return epoch >= anchor && (epoch - anchor) % rule.everyMs === 0; }
  try { return calendarTarget(rule, epoch, -1) === epoch; } catch { return false; }
}
/**
 * The record revision at which what an occurrence performs last changed: its task, time rule and destination, and
 * whether it may run at all. A title edit leaves it as it is, so a running or due occurrence survives it (Headlong's
 * window key `<goal>/<date>-<HHMM>` survives edits, scheduled_goals.md:79-108). It is a revision of the record, the
 * number every claim carries (`scheduleRevision`, also on claims made before it existed), so one comparison serves all
 * claims. `executionRevisionAt` is the revision this code last wrote it at: a record saved before it existed, or
 * edited since by an older version (a rollback, which keeps fields it does not know and moves `revision`), reads its
 * `revision`, since anything may have changed.
 */
export const projectScheduleExecutionRevision = record => Number.isSafeInteger(record?.executionRevision) && record.executionRevisionAt === record.revision ? record.executionRevision : record?.revision;
/** Whether a claim made at record revision `scheduleRevision` is still current: nothing it performs changed since. */
export const projectScheduleClaimCurrent = (record, scheduleRevision) => Number.isSafeInteger(scheduleRevision) && Number.isSafeInteger(record?.revision)
  && scheduleRevision <= record.revision && scheduleRevision >= projectScheduleExecutionRevision(record);
/**
 * One period of an occurrence: from its window to the rule's next window, in ms; null for a one-shot, which has no
 * later window. It is the grace of a window nobody ran or delivered yet (Headlong's 'missed, let it go' after a grace,
 * common.sh:244-289): after it the next window has opened and the old one is no longer worth posting.
 */
export function projectSchedulePeriodMs(record, scheduledAt) {
  const epoch = Date.parse(scheduledAt);
  if (!Number.isFinite(epoch) || !record?.rule) return null;
  try { const end = next(record.rule, epoch); return end ? Date.parse(end) - epoch : null; } catch { return null; }
}
/**
 * Whether a later window of the rule has opened since `scheduledAt` (one period has gone by), so `scheduledAt` is
 * no longer the latest one (harness schedule.md:96, a cold or busy session contributes only its latest occurrence).
 * A one-shot never passes; a wall clock stepped back before `scheduledAt` does not pass it either.
 */
export function projectScheduleWindowPassed(record, scheduledAt, now = Date.now()) {
  const epoch = Date.parse(scheduledAt), period = projectSchedulePeriodMs(record, scheduledAt);
  return Number.isFinite(epoch) && period !== null && epoch + period <= now;
}
/**
 * Whether `scheduledAt` is still the latest open window of the record's rule at `now`: a window of the current rule
 * that has opened, with no later one opened since. A one-shot stays open; it can never become a backlog.
 */
export function projectScheduleWindowOpen(record, scheduledAt, now = Date.now()) {
  const epoch = Date.parse(scheduledAt);
  if (!Number.isFinite(epoch) || !record?.rule || epoch > now || !windowOf(record.rule, epoch)) return false;
  return !projectScheduleWindowPassed(record, scheduledAt, now);
}
export function createProjectSchedule(input, { now = Date.now() } = {}) {
  object(input, ['id', 'title', 'task', 'rule', 'destinationSessionId', 'enabled']);
  if (!Number.isSafeInteger(now) || now < 0) fail('Invalid scheduling clock');
  const id = text(input.id, 'id', 100), title = text(input.title, 'title', 160), task = text(input.task, 'task', 6000), destinationSessionId = text(input.destinationSessionId, 'destination session', 160);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) fail('Invalid schedule id');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('enabled must be boolean');
  const rule = normalizeRule(input.rule, now), nextRunAt = next(rule, now);
  if (!nextRunAt) fail('One-shot schedule must be in the future');
  return { schemaVersion: 1, id, title, task, rule, destinationSessionId, enabled: input.enabled !== false, revision: 1, executionRevision: 1, executionRevisionAt: 1, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), nextRunAt };
}
export function updateProjectSchedule(record, patch, { now = Date.now() } = {}) {
  object(patch, ['title', 'task', 'rule', 'destinationSessionId', 'enabled']);
  for (const key of Object.keys(patch)) if (patch[key] === null || patch[key] === undefined) fail(`Invalid ${key}`);
  const value = { ...record, ...patch }, rule = normalizeRule(value.rule, now);
  text(value.title, 'title', 160); text(value.task, 'task', 6000); text(value.destinationSessionId, 'destination session', 160);
  if (typeof value.enabled !== 'boolean' || !Number.isSafeInteger(now) || now < 0) fail('Invalid schedule update');
  // Only what an occurrence performs moves the execution revision (a title edit never revokes a running one). An
  // unchanged rule keeps its stored due instant, so an edit never silently skips a window that is due but unclaimed;
  // a new rule, or switching the schedule off or on, starts from now (no catch-up of what a pause skipped).
  let before = rule;
  if (patch.rule !== undefined) try { before = normalizeRule(record.rule, now); } catch { before = null; }
  const ruleChanged = !sameRule(rule, before), enabledChanged = value.enabled !== record.enabled;
  const executionChanged = ruleChanged || enabledChanged || value.task !== record.task || value.destinationSessionId !== record.destinationSessionId;
  const nextRunAt = ruleChanged || enabledChanged || record.nextRunAt === undefined ? next(rule, now) : record.nextRunAt;
  // Only a new rule must lie ahead: renaming a one-shot whose time has passed (its rule sent again unchanged) is fine.
  if (ruleChanged && !nextRunAt) fail('One-shot schedule must be in the future');
  const revision = record.revision + 1, executionRevision = executionChanged ? revision : projectScheduleExecutionRevision(record);
  return { ...value, rule, nextRunAt, revision, executionRevision, executionRevisionAt: revision, updatedAt: new Date(now).toISOString() };
}
export function projectScheduleDue(record, now = Date.now()) {
  if (!record.enabled || !record.nextRunAt || Date.parse(record.nextRunAt) > now) return null;
  const rule = record.rule, first = Date.parse(record.nextRunAt);
  const latest = rule.kind === 'once' ? Date.parse(rule.at) : rule.kind === 'interval' ? Date.parse(rule.anchorAt) + Math.floor((now - Date.parse(rule.anchorAt)) / rule.everyMs) * rule.everyMs : calendarTarget(rule, now, -1);
  if (latest < first) return null;
  const scheduledAt = new Date(latest).toISOString();
  // The key names the window, not the record's revision: schedule id + scheduledAt (Headlong's `<goal>/<date>-<HHMM>`).
  const key = `schedule:${record.id}:${createHash('sha256').update(JSON.stringify([record.id, scheduledAt])).digest('hex').slice(0, 24)}`;
  return { key, scheduledAt, nextRunAt: next(rule, now), coalescedFrom: latest > first ? record.nextRunAt : null };
}
export function projectScheduleView(record, now = Date.now()) {
  return { ...structuredClone(record), state: !record.enabled ? 'paused' : !record.nextRunAt ? 'finished' : Date.parse(record.nextRunAt) <= now ? 'due' : 'scheduled', deliveryMode: 'project-conversation', timingPolicy: { missed: 'latest-only', grace: 'one-period', whileMuted: 'paused', daylightSavingGap: 'skip', daylightSavingFold: 'first' } };
}
