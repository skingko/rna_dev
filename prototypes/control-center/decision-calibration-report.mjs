import { DECISION_THRESHOLDS } from '../../packages/sdk/src/decision-templates.mjs';
import { MEMORY_TOOL_DECLARATIONS } from './memory-context.mjs';
import { mineProjectSignals } from './project-interaction-signals.mjs';
import { selfLabel, selfObserved } from './decision-ledger.mjs';

// JEV calibration loop (design §3.6): ledger rows carry per-question
// predictions; real outcomes are backfilled as `observed` booleans; reports
// compare predicted probability with observed frequency. Measurement only:
// thresholds change only by a reviewed code change (DECISION_THRESHOLDS.version).
export const CALIBRATION_WINDOWS = Object.freeze({ '24h': 86400000, '7d': 604800000, '30d': 2592000000, all: Infinity });
const MEMORY_TOOLS = new Set(Object.values(MEMORY_TOOL_DECLARATIONS).map(row => row.name));
const STOP = /stop|pause|cancel|abort|halt/i, REDIRECT = /steer|redirect|message|direct|continue_with|update/i;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const engaged = value => /repl|act/.test(value) ? true : /dismiss|ignor/.test(value) ? false : undefined;
const wakeObserved = value => /^wake_needed|^defer_missed/.test(value) ? true : /^wake_unneeded|^defer_right/.test(value) ? false : undefined;
const time = value => { const parsed = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(parsed) ? parsed : null; };

/** What actually happened in a routed turn (null until the turn is terminal). */
export function observeTurnRoute(state, row, signals = []) {
  const session = state.sessions?.find(item => item.id === row.scope?.sessionId), turn = session?.turns?.find(item => item.id === row.scope?.turnId);
  if (!turn || !['completed', 'failed', 'stopped'].includes(turn.status)) return null;
  const tools = (session.items ?? []).filter(item => item.turnId === turn.id && item.tool).map(item => ({ name: item.tool.name, args: item.tool.args ?? {} })), predicted = row.predictions ?? {}, observed = {};
  const control = tools.filter(tool => tool.name === 'project_background_control').map(tool => String(tool.args.action ?? tool.args.control ?? ''));
  if (finite(predicted.needs_tools)) observed.needs_tools = tools.length > 0;
  // Recalled passages the conversation already held count as needed too (MIND-13 'already_attached': only a pointer to them was attached).
  if (finite(predicted.needs_memory)) observed.needs_memory = tools.some(tool => MEMORY_TOOLS.has(tool.name)) || (turn.memoryContext?.injectedEntries?.length ?? 0) > 0 && turn.memoryContext.execution === 'retrieved' || turn.memoryContext?.execution === 'already_attached';
  if (finite(predicted.clarify_needed)) observed.clarify_needed = tools.some(tool => tool.name === 'ask_user');
  if (finite(predicted.stop_background)) observed.stop_background = control.some(action => STOP.test(action));
  if (finite(predicted.redirect_background)) observed.redirect_background = control.some(action => REDIRECT.test(action) && !STOP.test(action));
  if (finite(predicted.skill_pick) && row.outcome?.skills?.length) observed.skill_pick = tools.some(tool => tool.name === 'skill_load' && row.outcome.skills.some(id => [tool.args.skill, tool.args.id, tool.args.name].includes(id)));
  if (finite(predicted.reasoning_effort)) {
    // A correction or retry of this turn means the chosen depth was not adequate.
    const negative = signals.some(signal => ['user_correction', 'retry'].includes(signal.kind) && signal.turnId === turn.id);
    const later = (session.turns ?? []).some(item => item.id !== turn.id && (time(item.createdAt) ?? 0) > (time(turn.createdAt) ?? 0));
    if (negative) observed.reasoning_effort = false; else if (later) observed.reasoning_effort = true;
  }
  return Object.keys(observed).length ? observed : null;
}

/** tool.admission: a chunk was needed if the model later read any of its lines back
 * through tool_output_read (a range or a search hit). Known once the turn is over. */
export function observeAdmission(state, row) {
  const session = state.sessions?.find(item => item.id === row.scope.sessionId), turn = session?.turns?.find(item => item.id === row.scope.turnId);
  if (!turn || !['completed', 'failed', 'stopped'].includes(turn.status)) return null;
  const read = [];
  for (const item of session.items ?? []) {
    if (item.tool?.name !== 'tool_output_read' || item.tool.args?.id !== row.scope.spillId || item.tool.status === 'failed') continue;
    const args = item.tool.args;
    if (args.pattern === undefined) { const start = args.offset ?? 1; read.push([start, start + (args.limit ?? 200) - 1]); }
    else for (const match of String(item.tool.output ?? '').matchAll(/^(\d+)[:-]\t/gm)) read.push([Number(match[1]), Number(match[1])]);
  }
  const observed = {};
  (row.scope.ranges ?? []).forEach((range, index) => {
    const key = `needed_${index}`;
    if (!Array.isArray(range) || !finite(row.predictions?.[key])) return;
    observed[key] = read.some(([from, to]) => from <= range[1] && to >= range[0]);
  });
  return Object.keys(observed).length ? observed : null;
}

/** Returns [{ id, observed }] for rows whose real outcome is now known. */
export function pendingObservations(state, rows) {
  const out = [], signalCache = new Map();
  const signalsFor = projectId => { if (!projectId) return []; if (!signalCache.has(projectId)) { try { signalCache.set(projectId, mineProjectSignals(state, projectId)); } catch { signalCache.set(projectId, []); } } return signalCache.get(projectId); };
  const versions = new Map();
  for (const project of state.projects ?? []) for (const version of project.versions ?? []) { const id = version?.rrsi?.prescore?.ledgerId; if (id) versions.set(id, { project, version }); }
  for (const source of rows) {
    if (source.observed || !source.predictions) continue;
    // PDL-7 (cross-batch constraint 3): a label is calibrated only when it comes from an outcome transition or a user
    // action (or the absence of a correction, `heuristic`). A `self` label — the main model's own next choice labelling
    // the wake it followed (DecisionService.labelWake), B3's `provisional` — is read as no label: no observation, so it
    // never reaches the Brier or the buckets. A later outcome label replaces it and is observed.
    const row = selfLabel(source.label) ? { ...source, label: undefined } : source;
    let observed = null;
    if (row.point === 'turn.route') observed = observeTurnRoute(state, row, signalsFor(row.scope?.projectId));
    else if (['delivery.reach', 'initiative.review'].includes(row.point) && row.label?.value) {
      // initiative.review: a delivery reaction (or, once C2 writes them, an outcome wake label wake_needed_<action> /
      // wake_unneeded / defer_missed / defer_right with `source: 'outcome'`) labels the wake judgment.
      const value = row.point === 'initiative.review' ? wakeObserved(row.label.value) ?? engaged(row.label.value) : engaged(row.label.value), key = row.point === 'delivery.reach' ? 'engaged' : 'needs_main_model';
      if (value !== undefined && finite(row.predictions[key])) observed = { [key]: value };
    } else if (row.point === 'message.value' && row.label?.value) {
      // A delivered message the user answered or acted on was new, relevant now and not already told; a dismissed one was not relevant now.
      const value = engaged(row.label.value);
      const implied = value === true ? { new_information: true, relevant_now: true, already_reported: false } : value === false ? { relevant_now: false } : {};
      const picked = Object.fromEntries(Object.entries(implied).filter(([key]) => finite(row.predictions[key])));
      if (Object.keys(picked).length) observed = picked;
    } else if (row.point === 'candidate.prescore' && versions.has(row.id)) {
      const { project, version } = versions.get(row.id), adopted = project.activeVersionId === version.id || ['ready', 'adopted', 'active'].includes(version.state), rejected = version.state === 'rejected';
      if (adopted || rejected) observed = Object.fromEntries(Object.keys(row.predictions).map(key => [key, key === 'may_regress_other_tasks' || key === 'exceeds_hypothesis' ? rejected : adopted]));
    } else if (row.point === 'turn.settled' && /^invite_(accepted|dismissed)$/.test(row.label?.value ?? '') && finite(row.predictions.feedback_worthwhile)) {
      // A feedback invitation the user answered was worth asking; one closed without answering was not.
      observed = { feedback_worthwhile: row.label.value === 'invite_accepted' };
    } else if (row.point === 'feedback.signal' && /^lesson_(confirmed|revoked)$/.test(row.label?.value ?? '') && finite(row.predictions.standing)) {
      // The lesson a note produced was later confirmed (a standing wish) or revoked by the user.
      observed = { standing: row.label.value === 'lesson_confirmed' };
    } else if (row.point === 'tool.admission' && row.scope?.spillId) {
      observed = observeAdmission(state, row);
    } else if (row.point === 'tool.risk' && /^risk_(allowed|denied)$/.test(row.label?.value ?? '')) observed = { risk: row.label.value === 'risk_denied' };
    else if (row.point === 'turn.drift' && /^drift_(missed|clear|confirmed)$/.test(row.label?.value ?? '') && finite(row.predictions.on_track)) {
      // On track was right when no correction followed; wrong when one did. A drift note the user then accepted says nothing (drift_steered).
      observed = { on_track: row.label.value === 'drift_clear' };
    } else if (row.point === 'ask.necessity' && /^necessity_(missed|right)$/.test(row.label?.value ?? '')) {
      // A skipped question the user then corrected was essential (and the default not reasonable); one nobody corrected was not essential.
      const missed = row.label.value === 'necessity_missed', picked = { ...(finite(row.predictions.essential) ? { essential: missed } : {}), ...(missed && finite(row.predictions.reasonable_default) ? { reasonable_default: false } : {}) };
      if (Object.keys(picked).length) observed = picked;
    } else if (row.point === 'gene.review' && /^gene_(active|missed|retired)$/.test(row.label?.value ?? '') && finite(row.predictions.addresses_origin)) {
      // A rule that held in real use addressed its origin; one corrected on the same point or retired for the opposite did not.
      observed = { addresses_origin: row.label.value === 'gene_active' };
    }
    if (observed) out.push({ id: row.id, observed });
  }
  return out;
}

const bucketOf = value => Math.min(9, Math.floor(value * 10));
const percentile = (values, q) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]; };
/** Reliability buckets, coverage, abstain rate and savings for one point (or all). */
export function calibrationReport(rows, { point, window = '7d', now = Date.now() } = {}) {
  const span = CALIBRATION_WINDOWS[window] ?? CALIBRATION_WINDOWS['7d'], selected = rows.filter(row => (!point || row.point === point) && row.at >= now - span && row.disposition !== 'cancelled');
  const scored = selected.filter(row => row.answers || row.predictions || row.scored), decided = scored.filter(row => row.decided === true), applied = selected.filter(row => row.applied === true);
  const questions = {};
  // PDL-7: an observation a self label gave (an older release's backfill took them from its own wake labels) is not one.
  const observationOf = row => selfObserved(row) ? null : row.observed ?? null;
  for (const row of selected) for (const [key, predicted] of Object.entries(row.predictions ?? {})) {
    if (!finite(predicted)) continue;
    const entry = questions[key] ??= { n: 0, labeled: 0, brierSum: 0, buckets: Array.from({ length: 10 }, (_, index) => ({ range: [index / 10, (index + 1) / 10], n: 0, predictedSum: 0, observedSum: 0 })) };
    entry.n++;
    const observed = observationOf(row)?.[key]; if (typeof observed !== 'boolean') continue;
    const bucket = entry.buckets[bucketOf(predicted)]; entry.labeled++; bucket.n++; bucket.predictedSum += predicted; bucket.observedSum += observed ? 1 : 0; entry.brierSum += (predicted - (observed ? 1 : 0)) ** 2;
  }
  const reasons = {}; for (const row of selected.filter(row => !row.answers && !row.scored)) reasons[row.reason ?? 'unknown'] = (reasons[row.reason ?? 'unknown'] ?? 0) + 1;
  const savings = selected.reduce((sum, row) => ({ mainModelCalls: sum.mainModelCalls + (row.savings?.mainModelCalls ?? 0), auxiliaryCalls: sum.auxiliaryCalls + (row.savings?.auxiliaryCalls ?? 0), latencyMs: sum.latencyMs + (row.savings?.latencyMs ?? 0) }), { mainModelCalls: 0, auxiliaryCalls: 0, latencyMs: 0 });
  const latencies = selected.filter(row => row.networkAttempted && finite(row.latencyMs)).map(row => row.latencyMs);
  return { point: point ?? null, window: CALIBRATION_WINDOWS[window] ? window : '7d', thresholdsVersion: DECISION_THRESHOLDS.version, thresholdChanges: 'manual',
    decisions: selected.length, scored: scored.length, decided: decided.length, applied: applied.length, labeled: selected.filter(row => observationOf(row)).length,
    coverage: scored.length ? Math.round(decided.length / scored.length * 1000) / 1000 : null, abstainRate: scored.length ? Math.round((scored.length - decided.length) / scored.length * 1000) / 1000 : null,
    unscoredReasons: reasons, modes: selected.reduce((out, row) => ({ ...out, [row.mode ?? 'unknown']: (out[row.mode ?? 'unknown'] ?? 0) + 1 }), {}),
    latency: { p50: percentile(latencies, .5), p95: percentile(latencies, .95) }, tokens: selected.reduce((sum, row) => sum + (row.usage?.inputTokens ?? 0) + (row.usage?.outputTokens ?? 0), 0), savings,
    questions: Object.fromEntries(Object.entries(questions).map(([key, entry]) => [key, { n: entry.n, labeled: entry.labeled, brier: entry.labeled ? Math.round(entry.brierSum / entry.labeled * 10000) / 10000 : null,
      buckets: entry.buckets.filter(bucket => bucket.n).map(bucket => ({ range: bucket.range, n: bucket.n, predicted: Math.round(bucket.predictedSum / bucket.n * 1000) / 1000, observed: Math.round(bucket.observedSum / bucket.n * 1000) / 1000 })) }])) };
}
