import { projectDataset } from './dataset.mjs';
import { idfTable, salientSimilarity, messageSimilarity, clusters, persistenceMarked, isStatusReport } from './labels.mjs';

// K4 benchmark: plan §5 metrics over a normalized dataset (live state or fixture).
// Ownership (see plan §8 change log): K4 owns `learning` + `harness`; the
// `proactive` block here is the K4 baseline and is replaced by K2's block when
// a proactive-metrics provider is supplied (see metrics-route.mjs).
export const METRICS_SCHEMA = 'rna-bench-metrics/1';
export const DAY_MS = 86400000;
export const WINDOWS = Object.freeze({ '1d': DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS, all: Infinity });
export const REPLY_WINDOW_MS = 12 * 3600000, QUIET_REPLY_WINDOW_MS = 48 * 3600000, REPEAT_WINDOW_MS = 24 * 3600000;
export const REPEAT_THRESHOLD = 0.3, CORRECTION_REPEAT_THRESHOLD = 0.35, SILENCE_LOOKBACK_MS = 24 * 3600000, RETRY_SIMILARITY = 0.6;
const time = value => { const at = Date.parse(value); return Number.isFinite(at) ? at : null; };
const round = (value, digits = 3) => value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value * 10 ** digits) / 10 ** digits;
const rate = (part, whole) => whole ? round(part / whole) : null;
/** Nearest-rank percentile of numbers (null when empty). */
export function percentile(values, p) { const rows = values.filter(Number.isFinite).sort((a, b) => a - b); if (!rows.length) return null; return rows[Math.min(rows.length - 1, Math.max(0, Math.ceil(p / 100 * rows.length) - 1))]; }
const median = values => percentile(values, 50);
export function windowMs(window) { if (!(window in WINDOWS)) throw Object.assign(new Error('window must be 1d, 7d, 30d or all'), { code: 'bench_window_invalid' }); return WINDOWS[window]; }

export const REPLY_BURST_MS = 60 * 60000;
/**
 * Which proactive messages a user message answers: the latest proactive message
 * before it in the same conversation, plus others sent within REPLY_BURST_MS of
 * that one (a burst read together). Older messages in an unreplied run stay unanswered.
 */
export function creditReplies(proactive, messages) {
  const credited = new Map();
  for (const user of messages.filter(row => row.role === 'user')) {
    const before = proactive.filter(row => row.sessionId === user.sessionId && row.at < user.at && !credited.has(row.itemId));
    const last = before.at(-1); if (!last) continue;
    for (const row of before) if (time(last.at) - time(row.at) <= REPLY_BURST_MS) credited.set(row.itemId, { userItemId: user.id, at: user.at, delayMs: time(user.at) - time(row.at), labels: user.labels ?? [] });
  }
  return credited;
}
/** Outcome of one proactive message: inbox feedback > answered question > credited reply (labelled) > ignored/pending. */
export function proactiveOutcome(row, { now, inbox = [], reply = row.next } = {}) {
  const fed = inbox.find(entry => entry.itemId && entry.itemId === row.itemId || entry.actionId && entry.actionId === row.actionId);
  if (fed?.outcome) return fed.outcome;
  const quiet = row.tier === 'inbox' || row.tier === 'digest', limit = quiet ? QUIET_REPLY_WINDOW_MS : REPLY_WINDOW_MS;
  if (row.answeredAt && time(row.answeredAt) - time(row.at) <= limit) return 'acted';
  if (reply && reply.delayMs <= limit) {
    if (reply.labels?.includes('message_complaint')) return 'dismissed';
    if (reply.labels?.includes('decision') || reply.labels?.includes('approval')) return 'acted';
    return 'replied';
  }
  return now - time(row.at) > limit ? 'ignored' : 'pending';
}

/** Longest run of proactive messages with no user message in between (project-wide timeline). */
export function unrepliedChains(messages) {
  let current = [], longest = [];
  const chains = [];
  for (const row of messages) {
    if (row.role === 'user') { if (current.length) chains.push(current); current = []; continue; }
    if (row.role === 'agent' && ['proactive', 'scheduled', 'digest'].includes(row.channel)) current.push(row);
  }
  if (current.length) chains.push(current);
  for (const chain of chains) if (chain.length > longest.length) longest = chain;
  return { longest: longest.length, from: longest[0]?.at ?? null, to: longest.at(-1)?.at ?? null, chainsOver3: chains.filter(chain => chain.length > 3).length };
}

/** Paraphrase repeat clusters among unscheduled proactive messages within 24h. `similar(a,b)` may be injected (e.g. JEV judgments). */
export function repeatClusters(rows, { threshold = REPEAT_THRESHOLD, similar } = {}) {
  const idf = idfTable(rows.map(row => row.text));
  const test = similar ?? ((a, b) => salientSimilarity(a.text, b.text, idf) >= threshold || messageSimilarity(a.text, b.text) >= 0.82);
  const groups = clusters(rows, test, (a, b) => Math.abs(time(a.at) - time(b.at)) <= REPEAT_WINDOW_MS);
  const repeated = groups.filter(group => group.length > 1);
  return { clusters: repeated.length, repeatedMessages: repeated.reduce((sum, group) => sum + group.length - 1, 0), largest: Math.max(0, ...repeated.map(group => group.length)) };
}
/** Pre-compute paraphrase judgments with an async JEV-like judge: judge(a, b) → boolean. Returns a sync `similar`. */
export async function jevParaphraseJudge(rows, judge, { maxPairs = 200 } = {}) {
  const verdicts = new Map(); let asked = 0;
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length && asked < maxPairs; j++) {
    if (Math.abs(time(rows[i].at) - time(rows[j].at)) > REPEAT_WINDOW_MS) continue;
    verdicts.set(`${rows[i].itemId}|${rows[j].itemId}`, Boolean(await judge(rows[i].text, rows[j].text))); asked++;
  }
  return (a, b) => verdicts.get(`${a.itemId}|${b.itemId}`) ?? verdicts.get(`${b.itemId}|${a.itemId}`) ?? false;
}

function inWindow(dataset, window, now) { const span = windowMs(window), since = span === Infinity ? -Infinity : now - span; return row => { const at = time(row.at ?? row.createdAt); return at !== null && at >= since && at <= now; }; }

/** Proactive block (K4 baseline; K2 may supersede it). */
export function proactiveMetrics(dataset, { window = '7d', now = Date.parse(dataset.now) || Date.now(), similar } = {}) {
  const keep = inWindow(dataset, window, now), rows = dataset.proactive.filter(keep), unscheduled = rows.filter(row => !row.scheduled);
  const counts = { messages: rows.length, unscheduled: unscheduled.length, scheduled: rows.length - unscheduled.length, replied: 0, acted: 0, dismissed: 0, ignored: 0, pending: 0 };
  const outcomes = new Map(), credited = creditReplies(dataset.proactive, dataset.messages);
  for (const row of rows) { const outcome = proactiveOutcome(row, { now, inbox: dataset.inbox, reply: credited.get(row.itemId) ?? null }); outcomes.set(row.itemId, outcome); counts[outcome]++; }
  const settled = counts.replied + counts.acted + counts.dismissed + counts.ignored;
  // Useful = acted, or replied without the reply being a correction of the agent.
  const useful = rows.filter(row => outcomes.get(row.itemId) === 'acted' || outcomes.get(row.itemId) === 'replied' && !(credited.get(row.itemId)?.labels ?? []).includes('correction')).length;
  const chains = unrepliedChains(dataset.messages.filter(keep));
  const repeats = repeatClusters(unscheduled, { similar });
  const commitments = dataset.commitments.filter(row => keep({ at: row.createdAt }));
  const resolution = commitments.filter(row => row.resolvedAt).map(row => time(row.resolvedAt) - time(row.createdAt));
  const overdue = commitments.filter(row => row.resolvedAt ? time(row.resolvedAt) > time(row.overdueAt) : row.status === 'pending' && now > time(row.overdueAt)).length;
  // False silence: the user asks for progress while completed background work exists that no proactive message has reported since it finished.
  const progress = dataset.messages.filter(row => keep(row) && row.role === 'user' && row.labels?.includes('progress_query'));
  const falseSilence = progress.filter(query => dataset.backgroundWork.some(job => job.status === 'completed' && !job.scheduled && job.completedAt && job.completedAt < query.at && time(query.at) - time(job.completedAt) <= SILENCE_LOOKBACK_MS
    && !dataset.proactive.some(p => p.at >= job.completedAt && p.at < query.at))).length;
  const wakes = dataset.decisions.filter(row => keep(row)), failures = dataset.wakeFailures.filter(row => keep(row) && row.phase === 'decision');
  const usage = dataset.usage.filter(row => keep(row) && row.purpose === 'initiative' && row.input + row.output + row.cacheRead > 0), reported = usage.filter(row => row.cacheReported);
  const invalid = failures.filter(row => ['invalid_decision', 'message_contract', 'invalid_output', 'parse'].includes(row.code)).length;
  const inputSide = reported.reduce((sum, row) => sum + row.input + row.cacheRead, 0);
  return {
    counts, settled, usefulShareRate: rate(useful, settled), replyRate: rate(counts.replied, settled), actRate: rate(counts.acted, settled), ignoreRate: rate(counts.ignored, settled), dismissRate: rate(counts.dismissed, settled),
    longestUnrepliedChain: chains.longest, longestUnrepliedChainSpan: { from: chains.from, to: chains.to }, unrepliedChainsOver3: chains.chainsOver3,
    awayShare: rate(unscheduled.filter(row => row.presence.away).length, unscheduled.length), nightShare: rate(unscheduled.filter(row => row.presence.night).length, unscheduled.length), awayOrNightShare: rate(unscheduled.filter(row => row.presence.away || row.presence.night).length, unscheduled.length),
    repeatRate: rate(repeats.repeatedMessages, unscheduled.length), repeatClusters: repeats.clusters,
    statusReportShare: rate(rows.filter(row => isStatusReport(row.text)).length, rows.length),
    medianChars: median(unscheduled.map(row => row.chars)), medianScheduledChars: median(rows.filter(row => row.scheduled).map(row => row.chars)),
    fileMentionShare: rate(rows.filter(row => row.shape.fileMentions > 0).length, rows.length), hashMentionShare: rate(rows.filter(row => row.shape.hashMentions > 0).length, rows.length), addendumShare: rate(unscheduled.filter(row => row.shape.addendum).length, unscheduled.length),
    commitments: { total: commitments.length, source: commitments[0]?.source ?? null, resolved: resolution.length, p50Ms: median(resolution), p90Ms: percentile(resolution, 90), overdue, pending: commitments.filter(row => !row.resolvedAt && row.status === 'pending').length },
    falseSilence: { progressQueries: progress.length, silentWithFindings: falseSilence },
    wakes: { decisions: wakes.length, byAction: wakes.reduce((out, row) => ({ ...out, [row.action]: (out[row.action] ?? 0) + 1 }), {}), decisionFailures: failures.length, invalidRate: rate(invalid, wakes.length + failures.length),
      ledgerRows: usage.length, tokensPerWake: usage.length ? Math.round(median(usage.map(row => row.input + row.output + row.cacheRead))) : null, meanTokensPerWake: usage.length ? Math.round(usage.reduce((sum, row) => sum + row.input + row.output + row.cacheRead, 0) / usage.length) : null,
      cacheReadShare: inputSide ? round(reported.reduce((sum, row) => sum + row.cacheRead, 0) / inputSide) : null, latencyMsP50: median(usage.map(row => row.durationMs).filter(Number.isFinite)) },
  };
}

/** Learning block (K4-owned). */
export function learningMetrics(dataset, { window = '7d', now = Date.parse(dataset.now) || Date.now() } = {}) {
  const keep = inWindow(dataset, window, now);
  const users = dataset.messages.filter(row => row.role === 'user' && keep(row));
  const turns = dataset.turns.filter(row => keep({ at: row.createdAt }));
  const corrections = users.filter(row => row.labels?.includes('correction'));
  // Repeat correction: same manual topic, or explicit persistence marker, or salient-text similarity to an earlier correction.
  const idf = idfTable(dataset.messages.filter(row => row.role === 'user').map(row => row.text));
  const allCorrections = dataset.messages.filter(row => row.role === 'user' && row.labels?.includes('correction'));
  const repeated = corrections.filter(row => { const earlier = allCorrections.filter(other => other.at < row.at); return earlier.length > 0 && (row.topic && earlier.some(other => other.topic === row.topic) || !row.topic && (persistenceMarked(row.text) || earlier.some(other => salientSimilarity(other.text, row.text, idf) >= CORRECTION_REPEAT_THRESHOLD))); });
  // First-attempt acceptance: a completed turn whose next user message (same session) is neither a correction nor a retry of the same request.
  const userById = new Map(dataset.messages.filter(row => row.role === 'user').map(row => [row.id, row]));
  const judged = [], accepted = [];
  for (const turn of turns.filter(row => row.status === 'completed' && row.userItemId)) {
    const request = userById.get(turn.userItemId), next = dataset.messages.find(row => row.role === 'user' && row.sessionId === turn.sessionId && row.at > (turn.completedAt ?? turn.createdAt));
    if (!request || !next) continue;
    judged.push(turn);
    const retry = messageSimilarity(next.text, request.text) >= 0.8;
    if (!next.labels?.includes('correction') && !retry) accepted.push(turn);
  }
  // Retry: runtime re-attempts, or a user message repeating the previous request in the same conversation (dataset-only, so live and fixture scores agree).
  const repeatedRequest = row => { const request = userById.get(row.userItemId); if (!request) return false; const previous = dataset.messages.filter(other => other.role === 'user' && other.sessionId === request.sessionId && other.at < request.at).at(-1); return Boolean(previous) && messageSimilarity(previous.text, request.text) >= RETRY_SIMILARITY; };
  const retries = turns.filter(row => row.runtimeAttempts > 1 || repeatedRequest(row)).length;
  const aborts = turns.filter(row => row.status === 'stopped').length;
  const toolCalls = turns.reduce((sum, row) => sum + row.toolCalls, 0), toolFailures = turns.reduce((sum, row) => sum + row.toolFailures, 0);
  const lessons = dataset.mind?.lessons ?? null;
  const lessonUses = lessons ? lessons.reduce((sum, row) => ({ applied: sum.applied + (row.uses?.applied ?? 0), contradicted: sum.contradicted + (row.uses?.contradicted ?? 0), recalled: sum.recalled + (row.uses?.recalled ?? 0) }), { applied: 0, contradicted: 0, recalled: 0 }) : null;
  return {
    turns: turns.length, userMessages: users.length, corrections: corrections.length, correctionsPerTurn: rate(corrections.length, turns.length),
    repeatCorrectionRate: rate(repeated.length, corrections.length), repeatCorrections: repeated.length,
    firstAttemptAcceptance: rate(accepted.length, judged.length), judgedTurns: judged.length, acceptedTurns: accepted.length,
    retriesPerTurn: rate(retries, turns.length), failedTurnRate: rate(turns.filter(row => row.status === 'failed').length, turns.length), abortsPerTurn: rate(aborts, turns.length), failedTurns: turns.filter(row => row.status === 'failed').length,
    toolFailureRate: rate(toolFailures, toolCalls), toolCalls,
    tokensPerAcceptedDeliverable: accepted.length ? Math.round(accepted.reduce((sum, row) => sum + row.tokens, 0) / accepted.length) : null,
    minutesPerAcceptedDeliverable: accepted.length ? round(median(accepted.map(row => row.durationMs).filter(Number.isFinite)) / 60000, 1) : null,
    preferences: users.filter(row => row.labels?.includes('preference')).length, messageComplaints: users.filter(row => row.labels?.includes('message_complaint')).length,
    lessonHitRate: lessonUses ? rate(lessonUses.applied, lessonUses.applied + lessonUses.contradicted) : null, lessonSample: lessonUses ? lessonUses.applied + lessonUses.contradicted : 0, lessons: lessons ? lessons.length : null,
    evolution: dataset.evolution,
  };
}

/** Harness block: provenance and data coverage (K4-owned). */
export function harnessMetrics(dataset, { window, now }) {
  return { window, now: new Date(now).toISOString(), timeZone: dataset.timeZone, schema: METRICS_SCHEMA, dataset: dataset.schema,
    coverage: { messages: dataset.messages.length, decisions: dataset.decisions.length, archivedDecisions: dataset.decisions.filter(row => row.origin === 'archive').length, wakeFailures: dataset.wakeFailures.length, usageRows: dataset.usage.length, commitmentsSource: dataset.mind?.commitments ? 'mind' : 'heuristic', labelsManual: dataset.messages.filter(row => row.labelSource === 'manual').length },
    notes: [dataset.usage.some(row => Number.isFinite(row.durationMs)) ? null : 'per-wake latency is not recorded in the usage ledger (latencyMsP50 = null)', dataset.mind ? null : 'project.mind absent: commitments are heuristic episodes; lesson hit-rate unavailable'].filter(Boolean) };
}

// Keyed view for the UI (K3): metrics[key] = { value, previous, series, sample }.
// value = this window, previous = the window before it, series = one point per
// day ({ date, value, sample }), sample = the denominator (n) behind value.
export const METRIC_KEYS = Object.freeze({
  usefulShareRate: ['proactive', p => p.usefulShareRate, p => p.settled],
  replyRate: ['proactive', p => p.replyRate, p => p.settled],
  ignoreRate: ['proactive', p => p.ignoreRate, p => p.settled],
  dismissRate: ['proactive', p => p.dismissRate, p => p.settled],
  longestUnrepliedChain: ['proactive', p => p.longestUnrepliedChain, p => p.counts?.messages ?? 0],
  awayOrNightShare: ['proactive', p => p.awayOrNightShare, p => p.counts?.unscheduled ?? 0],
  nightShare: ['proactive', p => p.nightShare, p => p.counts?.unscheduled ?? 0],
  repeatRate: ['proactive', p => p.repeatRate, p => p.counts?.unscheduled ?? 0],
  statusReportShare: ['proactive', p => p.statusReportShare, p => p.counts?.messages ?? 0],
  medianMessageChars: ['proactive', p => p.medianChars, p => p.counts?.unscheduled ?? 0],
  commitmentResolutionP50Ms: ['proactive', p => p.commitments?.p50Ms ?? null, p => p.commitments?.resolved ?? 0],
  commitmentResolutionP90Ms: ['proactive', p => p.commitments?.p90Ms ?? null, p => p.commitments?.resolved ?? 0],
  overdueCommitments: ['proactive', p => p.commitments?.overdue ?? null, p => p.commitments?.total ?? 0],
  falseSilence: ['proactive', p => p.falseSilence?.silentWithFindings ?? null, p => p.falseSilence?.progressQueries ?? 0],
  invalidWakeRate: ['proactive', p => p.wakes?.invalidRate ?? null, p => (p.wakes?.decisions ?? 0) + (p.wakes?.decisionFailures ?? 0)],
  tokensPerWake: ['proactive', p => p.wakes?.tokensPerWake ?? null, p => p.wakes?.ledgerRows ?? 0],
  cacheReadShare: ['proactive', p => p.wakes?.cacheReadShare ?? null, p => p.wakes?.ledgerRows ?? 0],
  correctionsPerTurn: ['learning', l => l.correctionsPerTurn, l => l.turns],
  repeatCorrectionRate: ['learning', l => l.repeatCorrectionRate, l => l.corrections],
  firstAttemptAcceptance: ['learning', l => l.firstAttemptAcceptance, l => l.judgedTurns],
  retriesPerTurn: ['learning', l => l.retriesPerTurn, l => l.turns],
  abortsPerTurn: ['learning', l => l.abortsPerTurn, l => l.turns],
  toolFailureRate: ['learning', l => l.toolFailureRate, l => l.toolCalls],
  tokensPerAcceptedDeliverable: ['learning', l => l.tokensPerAcceptedDeliverable, l => l.acceptedTurns ?? 0],
  lessonHitRate: ['learning', l => l.lessonHitRate, l => l.lessonSample ?? 0],
});
const pick = (blocks, key) => { const [block, value, sample] = METRIC_KEYS[key], source = blocks[block]; return source ? { value: value(source) ?? null, sample: sample(source) ?? 0 } : { value: null, sample: 0 }; };
// K2 may return a keyed map ({ metrics: { key: {...} } }) and/or flat values; flat numbers become keyed entries.
function providerKeys(block) {
  const out = {};
  for (const [key, entry] of Object.entries(block?.metrics ?? {})) if (entry && typeof entry === 'object') out[key] = { value: entry.value ?? null, previous: entry.previous ?? null, series: Array.isArray(entry.series) ? entry.series : [], sample: entry.sample ?? null };
  for (const key of Object.keys(METRIC_KEYS)) if (METRIC_KEYS[key][0] === 'proactive' && !out[key] && typeof block?.[key] === 'number') out[key] = { value: block[key], previous: null, series: [], sample: null };
  return out;
}

/** Proactive + learning blocks for one window ending at `now`. */
export function metricBlocks(dataset, { window = '7d', now = Date.parse(dataset.now) || Date.now(), similar } = {}) {
  windowMs(window);
  return { proactive: proactiveMetrics(dataset, { window, now, similar }), learning: learningMetrics(dataset, { window, now }) };
}
/** Keyed metrics with the previous window and a daily series ('all' → last 30 days, previous = null). */
export function keyedMetrics(dataset, { window = '7d', now = Date.parse(dataset.now) || Date.now(), similar, current } = {}) {
  const span = windowMs(window), blocks = current ?? metricBlocks(dataset, { window, now, similar });
  const previous = span === Infinity ? null : metricBlocks(dataset, { window, now: now - span, similar });
  const days = span === Infinity ? 30 : Math.max(1, Math.round(span / DAY_MS));
  const daily = Array.from({ length: days }, (_, index) => { const end = now - (days - 1 - index) * DAY_MS; return { date: new Date(end - 1).toISOString().slice(0, 10), blocks: metricBlocks(dataset, { window: '1d', now: end, similar }) }; });
  return Object.fromEntries(Object.keys(METRIC_KEYS).map(key => { const value = pick(blocks, key); return [key, { value: value.value, previous: previous ? pick(previous, key).value : null, series: daily.map(day => ({ date: day.date, ...pick(day.blocks, key) })), sample: value.sample }]; }));
}

/** Metrics over a dataset; `proactiveOverride` (K2 block) replaces the baseline proactive block and its keyed entries. */
export function datasetMetrics(dataset, { window = '7d', now = Date.parse(dataset.now) || Date.now(), similar, proactiveOverride, keyed = true } = {}) {
  const blocks = metricBlocks(dataset, { window, now, similar });
  const metrics = keyed ? { ...keyedMetrics(dataset, { window, now, similar, current: blocks }), ...(proactiveOverride ? providerKeys(proactiveOverride) : {}) } : undefined;
  const { metrics: _keyed, ...override } = proactiveOverride ?? {};
  return { schema: METRICS_SCHEMA, projectId: dataset.projectId, name: dataset.name, window, generatedAt: new Date(now).toISOString(), ...(metrics ? { metrics } : {}),
    proactive: proactiveOverride ? override : blocks.proactive, learning: blocks.learning, harness: harnessMetrics(dataset, { window, now }),
    owners: { proactive: proactiveOverride ? 'k2' : 'k4-baseline', learning: 'k4', harness: 'k4' } };
}

/**
 * Plan §8 endpoint body: metrics for one project from live host state.
 * options: { now, side (archive/ledger, see dataset.projectSideData), labels, proactiveProvider, keyed }
 * proactiveProvider(state, projectId, { window, now }) → K2's block (optionally with a keyed `metrics` map) or null.
 */
export function computeProjectMetrics(state, projectId, window = '7d', { now = Date.now(), side, labels, proactiveProvider, keyed = true } = {}) {
  const dataset = projectDataset(state, projectId, { side, labels, now });
  let proactiveOverride = null;
  if (typeof proactiveProvider === 'function') { try { proactiveOverride = proactiveProvider(state, projectId, { window, now }) ?? null; } catch { proactiveOverride = null; } }
  const result = datasetMetrics(dataset, { window, now, proactiveOverride, keyed });
  if (proactiveOverride) result.proactiveBaseline = proactiveMetrics(dataset, { window, now });
  return result;
}
