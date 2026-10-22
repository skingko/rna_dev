import { textHash } from './proactive-narrator.mjs';
import { conversationTimeline, unrepliedChain, longestUnrepliedChain, asksReply, learnedActiveHours, percentile, heldItems, proactiveItem } from './proactive-pacing.mjs';
import { addDays, appTimeZone, dayKeyer, dayStart, groupByDay, previousRange, windowRange, within } from './metric-windows.mjs';
import { sumValues } from './metrics-rollup.mjs';

// Proactive metrics (plan §5, K2). Computed from host state, plus the daily wake rollup when the host keeps one. K4's
// `GET /api/v2/projects/:id/metrics` loads `computeProactiveMetrics` from this module and merges its block and keyed
// cells into the one metrics object. Every window is [since, until) in local time (metric-windows.mjs): the current
// window, the one before it and each daily cell are disjoint, and the rows are grouped once, not re-filtered per cell.
const DAY = 86400000;
const iso = value => new Date(value).toISOString();
const at = value => typeof value === 'number' ? value : Date.parse(value);
const round = value => Math.round(value * 1000) / 1000;
const PROGRESS_ASK = /进展|怎么样了|进度|有什么新|有没有新|做到哪|结果呢|更新一下|\b(?:status|progress|any update|what'?s new|how is it going)\b/i;

// ------------------------------------------------------------ wake rollup
// The wake history in state keeps the last 50 wakes (about two days on a busy project), so a "7 days" view read from it
// covered about two (plan §1.2 #5). Each wake is folded into a daily rollup (kind 'wakes') as it appears; a project's
// watermark `wake:<projectId>` says which rows are in (every row older than it).
const text = (value, max) => typeof value === 'string' && value ? value.slice(0, max) : undefined;
/** Rollup key and values of one wake history row. */
export function wakeCell(projectId, row) {
  const outcome = text(row.outcome, 20) ?? 'quiet', tokens = Number.isFinite(row.tokens) ? row.tokens : null, latency = Number.isFinite(row.latencyMs) ? row.latencyMs : null;
  const prompt = row.prompt && Number.isFinite(row.prompt.shared) ? { prompt: { measured: 1, shared: row.prompt.shared, chars: row.prompt.chars ?? 0, divergedIn: { [text(row.prompt.divergedIn, 60) ?? 'none']: 1 } } } : {};
  return { at: at(row.at), key: { projectId, outcome, ...(['failed', 'deferred'].includes(outcome) && text(row.reason, 80) ? { reason: text(row.reason, 80) } : {}), ...(text(row.reasoning?.effective, 20) ? { effective: text(row.reasoning.effective, 20) } : {}), ...(text(row.reasoning?.shadow, 20) ? { shadow: text(row.reasoning.shadow, 20) } : {}),
      // C2: the tier the wake would run on (wakeTier: request | think), recorded in shadow; a row from before it has none.
      ...(text(row.tier, 12) ? { tier: text(row.tier, 12) } : {}) },
    values: { wakes: 1, ...(tokens !== null ? { tokens, tokensN: 1 } : {}), ...(Number.isFinite(row.saved) && row.saved > 0 ? { saved: row.saved } : {}), ...(latency !== null ? { latencyMs: latency, latencyN: 1 } : {}), ...prompt } };
}
const HISTORY_KEPT = 50;
/**
 * Fold the wakes of every project that are not in the rollup yet (rows at or after its watermark). Idempotent; cheap
 * when nothing changed (`seen` remembers each project's history array). A full history whose oldest row is newer than
 * the watermark lost rows the rollup never saw (an older release ran meanwhile): recorded as a gap, never guessed.
 */
export function foldWakes(rollup, state, { seen = new Map() } = {}) {
  let folded = 0;
  for (const project of state?.projects ?? []) {
    const history = project.mind?.pacing?.wake?.history;
    if (!Array.isArray(history) || !history.length || seen.get(project.id) === history) continue;
    seen.set(project.id, history);
    const source = `wake:${project.id}`, mark = rollup.mark(source), fresh = history.filter(row => Number.isFinite(at(row.at)) && (mark === null || at(row.at) >= mark));
    if (!fresh.length) continue;
    const oldest = at(history[0].at);
    if (mark !== null && history.length >= HISTORY_KEPT && oldest > mark) rollup.gap(source, mark, oldest);
    rollup.fold(source, fresh.map(row => wakeCell(project.id, row)), Math.max(...fresh.map(row => at(row.at))) + 1);
    folded += fresh.length;
  }
  return folded;
}
/** A project's wake cells inside a range: the rollup's days, plus history rows not folded yet (no rollup: the history). */
export function wakeCells(project, range, { wakes = null } = {}) {
  const history = (project.mind?.pacing?.wake?.history ?? []).filter(row => within(at(row.at), range));
  // The rollup is by local day: it serves day ranges and the unbounded one; a rolling range of hours reads the history.
  if (!wakes || !(range.days || range.since === -Infinity)) return history.map(row => wakeCell(project.id, row));
  const mark = wakes.mark(`wake:${project.id}`), live = history.filter(row => mark === null || at(row.at) >= mark).map(row => wakeCell(project.id, row));
  const days = range.days ? { firstDay: range.days[0], lastDay: range.days.at(-1) } : {};
  return [...wakes.cells({ ...days, keep: key => key.projectId === project.id }).map(cell => ({ key: cell.k, values: cell.v, day: cell.day })), ...live];
}
const WAKE_OUTCOMES = ['work', 'thought', 'deferred', 'failed', 'interrupted'];
/** The wake numbers both reports show, from cells. */
export function wakeSummary(cells) {
  const total = cells.reduce((sum, cell) => sum + (cell.values.wakes ?? 0), 0), by = outcome => cells.filter(cell => cell.key.outcome === outcome).reduce((sum, cell) => sum + (cell.values.wakes ?? 0), 0);
  const byOutcome = Object.fromEntries(WAKE_OUTCOMES.map(outcome => [outcome, by(outcome)]));
  const values = sumValues(cells.map(cell => cell.values));
  // C2: the wake mix by the tier each wake would run on (proactive-pacing.mjs wakeTier, recorded in shadow); wakes from
  // before the tier was recorded are `unrecorded`. Interrupted decisions count with their tier (their tokens were spent).
  const byTier = {};
  for (const cell of cells) byTier[cell.key.tier ?? 'unrecorded'] = (byTier[cell.key.tier ?? 'unrecorded'] ?? 0) + (cell.values.wakes ?? 0);
  return { total, byOutcome, byTier, quiet: total - WAKE_OUTCOMES.reduce((sum, outcome) => sum + byOutcome[outcome], 0), values };
}

// ------------------------------------------------------------ the proactive block
/**
 * Rows the block reads, gathered once per request: proactive messages (each with the user's previous message time, for
 * `away`), user messages, votes, inbox entries, commitments, narrator decisions.
 */
function inputs(project, sessions, { now, wakes }) {
  const mind = project.mind ?? {}, timeline = conversationTimeline(sessions), users = timeline.filter(row => row.kind === 'user'), votes = [];
  // The timeline is in time order: one pointer finds each message's latest user message at or before it.
  let last = -1;
  const sent = timeline.filter(row => row.kind === 'proactive').map(row => { while (last + 1 < users.length && users[last + 1].at <= row.at) last++; return { ...row, previousUserAt: last >= 0 ? users[last].at : null }; });
  for (const session of sessions) for (const item of session.items ?? []) if (proactiveItem(item) && Number.isFinite(at(item.createdAt)) && ['up', 'down'].includes(item.feedback?.vote)) votes.push({ at: at(item.createdAt), vote: item.feedback.vote });
  return { project, mind, timeline, sent, users, votes, now, wakes,
    activeHours: learnedActiveHours(users.filter(row => row.text).map(row => row.at), { now }),
    entries: (project.inbox ?? []).filter(row => !row.contextRevoked).map(row => ({ row, at: at(row.createdAt) })),
    commitments: (Array.isArray(mind.commitments) ? mind.commitments : []).filter(Boolean),
    decisions: (mind.pacing?.decisions ?? []).map(row => ({ row, at: at(row.at) })) };
}
/**
 * Longest run of interrupting proactive messages without a user reply, counting only messages sent inside the range (one
 * walk): B3's rule (F7: status rows and quiet-tier deliveries are not unanswered messages), bounded by the range.
 */
const longestChain = (timeline, range) => longestUnrepliedChain(timeline, { since: range.since, until: range.until });
const KINDS = Object.freeze({ sent: row => row.at, users: row => row.at, entries: entry => entry.at, votes: row => row.at, commitments: row => at(row.createdAt), decisions: entry => entry.at });
/** A range's rows when it is not made of local days (a rolling or unbounded window): one filter per kind. */
function sliceOf(data, range) {
  return { ...Object.fromEntries(Object.entries(KINDS).map(([kind, timeOf]) => [kind, data[kind].filter(row => within(timeOf(row), range))])),
    wakes: wakeCells(data.project, range, { wakes: data.wakes }), longest: longestChain(data.timeline, range) };
}
/**
 * Every row placed into its local day once (metric-windows groupByDay; one pass per kind over the given days), and the
 * longest unreplied run per day from one walk (a run restarts at the user's message and at midnight: messages of an
 * earlier day do not count in a day). Map day → that day's slice.
 */
function daySlices(data, days, timeZone) {
  const groups = Object.fromEntries(Object.entries(KINDS).map(([kind, timeOf]) => [kind, groupByDay(data[kind], days, timeOf, { timeZone })]));
  const span = { since: dayStart(days[0], timeZone), until: dayStart(addDays(days.at(-1), 1), timeZone), days }, keyOf = dayKeyer(timeZone), wakes = new Map(days.map(day => [day, []]));
  for (const cell of wakeCells(data.project, span, { wakes: data.wakes })) wakes.get(cell.day ?? keyOf(cell.at))?.push(cell);
  const longest = new Map(days.map(day => [day, 0]));
  let chain = 0, chainDay = null;
  for (const row of data.timeline) {
    if (row.kind === 'user') { chain = 0; continue; }
    if (!asksReply(row)) continue;
    const day = keyOf(row.at); if (!longest.has(day)) continue;
    if (day !== chainDay) { chain = 0; chainDay = day; }
    longest.set(day, Math.max(longest.get(day), ++chain));
  }
  return new Map(days.map(day => [day, { ...Object.fromEntries(Object.keys(KINDS).map(kind => [kind, groups[kind].get(day)])), wakes: wakes.get(day), longest: longest.get(day) }]));
}
/** The slice of several consecutive days: their groups joined (a multi-day run is walked again over the whole range). */
const joinDays = (data, slices, days, range) => ({ ...Object.fromEntries([...Object.keys(KINDS), 'wakes'].map(kind => [kind, days.flatMap(day => slices.get(day)[kind])])), longest: longestChain(data.timeline, range) });
/** The proactive block over one range [since, until), from its slice. */
function blockFor(data, range, slice) {
  const { mind, timeline, now } = data, until = Math.min(range.until, now + 1), sent = slice.sent;
  const entries = slice.entries.map(entry => entry.row);
  const settled = entries.filter(row => row.feedback), count = outcome => settled.filter(row => row.feedback.outcome === outcome).length;
  const up = slice.votes.filter(row => row.vote === 'up').length, down = slice.votes.filter(row => row.vote === 'down').length;
  const rate = (value, total) => total ? round(value / total) : null;
  const away = sent.filter(row => {
    const recordAway = row.initiative?.narrated?.context;
    if (recordAway) return recordAway.away || recordAway.night;
    return (data.activeHours.length > 0 && !data.activeHours.includes(new Date(row.at).getHours())) || row.previousUserAt === null || row.at - row.previousUserAt > 45 * 60000;
  }).length;
  const repeats = sent.filter((row, index) => sent.slice(0, index).some(prior => row.at - prior.at <= DAY && textHash(row.text) === textHash(prior.text))).length;
  const commitments = slice.commitments;
  const resolved = commitments.filter(row => row.status === 'resolved' && Number.isFinite(at(row.resolvedAt ?? row.updatedAt))).map(row => at(row.resolvedAt ?? row.updatedAt) - at(row.createdAt)).filter(value => value >= 0);
  const decisions = slice.decisions.map(entry => entry.row);
  const outcomes = Object.fromEntries(['send', 'hold', 'inbox', 'drop'].map(outcome => [outcome, decisions.filter(row => row.outcome === outcome).length]));
  // False silence: the user asked for progress while something worth saying was held or unshared.
  const asks = slice.users.filter(row => PROGRESS_ASK.test(row.text));
  const falseSilence = asks.filter(row => data.decisions.some(({ row: decision, at: decided }) => ['hold', 'inbox'].includes(decision.outcome) && decision.value >= .35 && decided < row.at - 30 * 60000 && decided > row.at - DAY
    && !data.sent.some(value => value.at > decided && value.at < row.at))).length;
  const wake = wakeSummary(slice.wakes), counted = wake.total - wake.byOutcome.interrupted;
  return {
    window: { since: Number.isFinite(range.since) ? iso(range.since) : null, until: iso(until), ms: Number.isFinite(range.since) ? until - range.since : null },
    delivered: sent.length, settled: settled.length + up + down,
    usefulShareRate: rate(count('replied') + count('acted') + up, settled.length + up + down),
    ignoreRate: rate(count('ignored'), settled.length), dismissRate: rate(count('dismissed') + down, settled.length + down),
    // F7 (B3): status rows are not in the timeline, and quiet-tier (inbox, digest) deliveries ask for no reply, so neither
    // is an unanswered message (proactive-pacing.mjs unrepliedChain / longestUnrepliedChain, the one rule).
    longestUnrepliedChain: slice.longest, currentUnrepliedChain: unrepliedChain(timeline),
    awayNightSendShare: rate(away, sent.length), repeatRate: rate(repeats, sent.length),
    commitments: { total: commitments.length, resolved: resolved.length, p50Ms: percentile(resolved, .5), p90Ms: percentile(resolved, .9), overdue: data.commitments.filter(row => row?.status === 'pending' && Number.isFinite(at(row.overdueAt)) && at(row.overdueAt) <= now).length },
    falseSilence: { progressAsks: asks.length, withUnsharedFinding: falseSilence, rate: rate(falseSilence, asks.length) },
    narrator: { decisions: decisions.length, outcomes, held: heldItems(mind).length, threads: { open: (mind.threads ?? []).filter(row => row.status === 'open').length, muted: (mind.threads ?? []).filter(row => row.status === 'muted').length, resolved: (mind.threads ?? []).filter(row => row.status === 'resolved').length } },
    pacing: { threshold: mind.pacing?.threshold ?? null, unrepliedChain: mind.pacing?.unrepliedChain ?? null, updatedAt: mind.pacing?.updatedAt ?? null },
    wakes: { count: wake.total, byOutcome: wake.byOutcome, byTier: wake.byTier, tokensPerWake: wake.values.tokensN ? Math.round(wake.values.tokens / wake.values.tokensN) : null, latencyMsPerWake: wake.values.latencyN ? Math.round(wake.values.latencyMs / wake.values.latencyN) : null,
      invalidRate: rate(wake.byOutcome.failed, counted), deferredRate: rate(wake.byOutcome.deferred, counted) },
  };
}
/**
 * Proactive metrics named per plan §5 over [since, until) (default: the last `windowMs` up to `now`; `range` from
 * metric-windows.mjs for local days). `wakes`: the daily wake rollup (else the 50-row history).
 */
export function proactiveMetrics(project, sessions, { now = Date.now(), windowMs = 7 * DAY, range, wakes = null } = {}) {
  const window = range ?? { since: windowMs === Infinity ? -Infinity : now - windowMs, until: now + 1, days: null }, data = inputs(project, sessions, { now, wakes });
  return blockFor(data, window, sliceOf(data, window));
}

/** Window names; '1d', '7d' and '30d' are whole local days ending today, 'all' reaches back without bound. */
export const WINDOWS = Object.freeze({ '1d': DAY, '7d': 7 * DAY, '30d': 30 * DAY, all: Infinity });
// K4 metric keys this block owns (same names as benchmark/metrics.mjs METRIC_KEYS) plus K2-only keys.
const CELLS = Object.freeze({
  usefulShareRate: m => [m.usefulShareRate, m.settled], ignoreRate: m => [m.ignoreRate, m.settled], dismissRate: m => [m.dismissRate, m.settled],
  longestUnrepliedChain: m => [m.longestUnrepliedChain, m.delivered], awayOrNightShare: m => [m.awayNightSendShare, m.delivered], exactRepeatRate: m => [m.repeatRate, m.delivered],
  commitmentResolutionP50Ms: m => [m.commitments.p50Ms, m.commitments.resolved], commitmentResolutionP90Ms: m => [m.commitments.p90Ms, m.commitments.resolved], overdueCommitments: m => [m.commitments.overdue, m.commitments.total],
  falseSilence: m => [m.falseSilence.withUnsharedFinding, m.falseSilence.progressAsks], falseSilenceRate: m => [m.falseSilence.rate, m.falseSilence.progressAsks],
  invalidWakeRate: m => [m.wakes.invalidRate, m.wakes.count], tokensPerWake: m => [m.wakes.tokensPerWake, m.wakes.count], latencyMsPerWake: m => [m.wakes.latencyMsPerWake, m.wakes.count],
  proactiveDelivered: m => [m.delivered, m.delivered], narratorHeld: m => [m.narrator.outcomes.hold, m.narrator.decisions], narratorDropped: m => [m.narrator.outcomes.drop, m.narrator.decisions],
});
export const PROACTIVE_METRIC_KEYS = Object.freeze(Object.keys(CELLS));
const cell = (metrics, key) => { const [value, sample] = CELLS[key](metrics); return { value: value ?? null, sample: sample ?? 0 }; };
/**
 * `{ key: { value, previous, series: [{ date, value, sample }], sample } }` plus the flat block. The window is local days
 * ending today; `previous` is the same number of days before it; each series cell is one local day, [start, next start).
 * Before 0.69 'previous' reached to now, a daily cell meant "since that day", and dates were UTC.
 */
export function proactiveMetricSeries(project, sessions, { now = Date.now(), window = '7d', windowMs, wakes = null, timeZone = appTimeZone() } = {}) {
  const name = windowMs !== undefined ? Object.keys(WINDOWS).find(key => WINDOWS[key] === windowMs) ?? '7d' : window;
  const range = windowRange(name, { now, timeZone }), data = inputs(project, sessions, { now, wakes });
  const before = name === 'all' ? null : previousRange(range, { timeZone });
  // 'all' shows its last 30 days as the series (its own totals are one unbounded slice).
  const days = range.days ?? windowRange('30d', { now, timeZone }).days;
  // One grouping pass over every day shown (the series, the window and the window before it).
  const slices = daySlices(data, [...(before?.days ?? []), ...days], timeZone), dayRange = day => ({ since: dayStart(day, timeZone), until: dayStart(addDays(day, 1), timeZone), days: [day] });
  const current = blockFor(data, range, range.days ? joinDays(data, slices, range.days, range) : sliceOf(data, range));
  const previous = before ? blockFor(data, before, joinDays(data, slices, before.days, before)) : null;
  const daily = days.map(day => ({ date: day, metrics: blockFor(data, dayRange(day), slices.get(day)) }));
  const metrics = Object.fromEntries(PROACTIVE_METRIC_KEYS.map(key => { const value = cell(current, key); return [key, { value: value.value, previous: previous ? cell(previous, key).value : null, series: daily.map(day => ({ date: day.date, ...cell(day.metrics, key) })), sample: value.sample }]; }));
  return { ...current, metrics };
}
const ARCHIVED_VIEWS = ['exclude', 'include', 'only'];
/**
 * K4 endpoint provider: `computeProactiveMetrics(state, projectId, { window, now, archived, wakes })`. `archived`:
 * the project's archived conversations are left out (`exclude`, the default), counted (`include`) or the only ones counted.
 */
export function computeProactiveMetrics(state, projectId, { window = '7d', now = Date.now(), archived = 'exclude', wakes = null, timeZone } = {}) {
  const project = state.projects?.find(row => row.id === projectId); if (!project) return null;
  if (!(window in WINDOWS)) throw Object.assign(new Error('window must be 1d, 7d, 30d or all'), { code: 'metrics_window_invalid' });
  if (!ARCHIVED_VIEWS.includes(archived)) throw Object.assign(new Error('archived must be exclude, include or only'), { code: 'archived_invalid', status: 400 });
  const sessions = (state.sessions ?? []).filter(row => row.projectId === projectId && (archived === 'include' || (archived === 'only') === Boolean(row.archivedAt)));
  return { owner: 'k2', ...proactiveMetricSeries(project, sessions, { now, window, wakes, ...(timeZone ? { timeZone } : {}) }) };
}
