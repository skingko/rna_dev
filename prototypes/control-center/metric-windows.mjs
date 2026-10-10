// Metric windows (plan 2026-10-05 B7). Every window a report reads is half-open, [since, until), in the app's local time
// zone, and grouped in one pass: the day boundaries of a window are computed once and each row is placed by its time,
// never by re-filtering the whole set per cell (harness session-stats folds the whole log once; zcode localTtft buckets
// once). Hour windows roll ('1h', '24h'); day windows ('1d', '7d', '30d', '90d', `days=N`) are whole local days ending
// with today, so "7 days" is today and the six days before it.
const DAY = 86400000;
const formatters = new Map();
const formatter = timeZone => {
  let value = formatters.get(timeZone);
  if (!value) { value = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); formatters.set(timeZone, value); }
  return value;
};
/** The app's time zone: the one the process runs in (as project schedules default to). */
export const appTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const wall = (ms, timeZone) => {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms)).filter(row => row.type !== 'literal').map(row => [row.type, Number(row.value)]));
  return parts;
};
/** Offset (ms) of the zone's wall clock from UTC at an instant. */
const offsetAt = (ms, timeZone) => { const p = wall(ms, timeZone); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000; };
const pad = value => String(value).padStart(2, '0');
/** 'YYYY-MM-DD' of an instant in the zone. */
export function localDay(ms, timeZone = appTimeZone()) { const p = wall(ms, timeZone); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; }
const parseDay = day => { const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day)); if (!match) throw Object.assign(new Error(`invalid day ${day}`), { status: 400 }); return [Number(match[1]), Number(match[2]), Number(match[3])]; };
/** The instant a local day starts (its first millisecond), DST included. */
export function dayStart(day, timeZone = appTimeZone()) {
  const [year, month, date] = parseDay(day), guess = Date.UTC(year, month - 1, date);
  let at = guess - offsetAt(guess, timeZone);
  // A DST change between the guess and the answer moves the offset once; settle on the offset at the answer.
  at = guess - offsetAt(at, timeZone);
  return at;
}
/** The local day `n` days after `day` (negative goes back). */
export function addDays(day, n) { const [year, month, date] = parseDay(day), value = new Date(Date.UTC(year, month - 1, date + n)); return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`; }
/** Local days from `first` to `last`, both included. */
export function dayRange(first, last) { const out = []; for (let day = first; day <= last && out.length < 4000; day = addDays(day, 1)) out.push(day); return out; }

export const HOUR_WINDOWS = Object.freeze({ '1h': 3600000, '24h': DAY });
export const DAY_WINDOWS = Object.freeze({ '1d': 1, '7d': 7, '30d': 30, '90d': 90 });
/**
 * `{ since, until, days }` of a named window at `now`: hour windows roll, [now - span, now]; day windows are the last
 * `n` local days, [start of the first, start of tomorrow), with `days` listing them oldest first. `'all'` reaches back
 * without bound. `{ days: n }` is the same as an 'nd' window.
 */
export function windowRange(window, { now = Date.now(), timeZone = appTimeZone() } = {}) {
  if (typeof window === 'object' && window && Number.isInteger(window.days)) return dayWindow(window.days, { now, timeZone });
  if (Object.hasOwn(HOUR_WINDOWS, window)) return { window, since: now - HOUR_WINDOWS[window], until: now + 1, days: null, rolling: true };
  if (Object.hasOwn(DAY_WINDOWS, window)) return { window, ...dayWindow(DAY_WINDOWS[window], { now, timeZone }) };
  if (window === 'all') { const today = localDay(now, timeZone); return { window, since: -Infinity, until: dayStart(addDays(today, 1), timeZone), days: null, rolling: false }; }
  throw Object.assign(new Error(`unknown window ${window}`), { status: 400 });
}
function dayWindow(n, { now, timeZone }) {
  const count = Math.max(1, Math.min(400, Math.floor(n))), today = localDay(now, timeZone), first = addDays(today, -(count - 1));
  return { since: dayStart(first, timeZone), until: dayStart(addDays(today, 1), timeZone), days: dayRange(first, today), rolling: false };
}
/** The window just before `range`, of the same length: [since - span, since) (day windows: the n days before). */
export function previousRange(range, { timeZone = appTimeZone() } = {}) {
  if (!Number.isFinite(range.since)) return null;
  if (range.days) { const first = addDays(range.days[0], -range.days.length), last = addDays(range.days[0], -1); return { since: dayStart(first, timeZone), until: range.since, days: dayRange(first, last), rolling: false }; }
  return { since: range.since - (range.until - 1 - range.since), until: range.since, days: null, rolling: true };
}
/**
 * One grouping pass: `rows` placed into `days` (local) by `timeOf(row)`; rows outside the days are dropped. Returns a
 * Map day → rows. The boundaries are computed once; rows need not be sorted.
 */
export function groupByDay(rows, days, timeOf, { timeZone = appTimeZone() } = {}) {
  const starts = days.map(day => dayStart(day, timeZone)), end = days.length ? dayStart(addDays(days.at(-1), 1), timeZone) : -Infinity, out = new Map(days.map(day => [day, []]));
  for (const row of rows) {
    const at = timeOf(row); if (!Number.isFinite(at) || at < starts[0] || at >= end) continue;
    let low = 0, high = starts.length - 1;
    while (low < high) { const mid = (low + high + 1) >> 1; if (starts[mid] <= at) low = mid; else high = mid - 1; }
    out.get(days[low]).push(row);
  }
  return out;
}
/** Local day of each of many instants, computing each day's bounds once (rows of one day share one Intl call). */
export function dayKeyer(timeZone = appTimeZone()) {
  let from = Infinity, to = -Infinity, key = null;
  return ms => {
    if (ms >= from && ms < to) return key;
    key = localDay(ms, timeZone); from = dayStart(key, timeZone); to = dayStart(addDays(key, 1), timeZone);
    return key;
  };
}
/** Whether an instant is inside a range. */
export const within = (at, range) => Number.isFinite(at) && at >= range.since && at < range.until;
