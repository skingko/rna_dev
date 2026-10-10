import { randomUUID } from 'node:crypto';
import { canonicalJSON, digest } from './journal.mjs';
import { DECISION_KERNEL_VERSION, decisionAssessmentPlanHash, decisionVerdict, deriveDecisionPolicy, minimizeDecisionState, validateDecisionAssessmentPlan } from './decision-kernel.mjs';

/** Measurement only: this module never calls a model or changes an agent route.
 * The host binds real model/execution receipts. Hashes establish consistency,
 * not the authenticity of a caller's claimed provenance or a causal effect. */
export const DECISION_CALIBRATION_VERSION = 1;
const MODES = ['off', 'shadow', 'active'];
const POINTS = ['initiative.review', 'evolution.review', 'chat.preflight'];
const error = code => Object.assign(new Error(`Decision calibration: ${code}`), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const same = (a, b) => canonicalJSON(a) === canonicalJSON(b);
function frozen(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value; }
function json(value, code = 'invalid_fixture') {
  // Bound JSON before canonical hashing; reject unsupported values rather than
  // silently erasing undefined/NaN/function fields and comparing different data.
  let entries = 0;
  function visit(item, depth) {
    if (++entries > 10000 || depth > 20) throw error(code);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!object(item) && !Array.isArray(item)) throw error(code);
    if (Object.getPrototypeOf(item) !== Object.prototype && !Array.isArray(item)) throw error(code);
    for (const child of Object.values(item)) visit(child, depth + 1);
  }
  visit(value, 0); const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 128000) throw error(code);
  return JSON.parse(text);
}

/** The generated plan is frozen before observing any mode's outcomes. Only the
 * returned input contains bounded task content; public reports use hashes. */
export function freezeDecisionCalibrationCase({ id: caseId, point, state = {}, signals = {}, scope = {}, fallback,
  assessmentPlan, planProvenance, models, mainInputHash, thresholdVersion, runtimeVersion, fallbackRoute,
  cacheImpact = 'none', latencyClass = 'background', cacheRegime = 'isolated-cold', knownSecrets = [] } = {}) {
  if (!id(caseId) || !POINTS.includes(point) || !id(thresholdVersion) || !id(runtimeVersion) || !id(fallbackRoute)
    || !hash(mainInputHash) || !['isolated-cold', 'isolated-warm'].includes(cacheRegime)
    || !['none', 'append-only', 'prefix-mutating'].includes(cacheImpact) || !['inline', 'parallel', 'background'].includes(latencyClass)) throw error('invalid_fixture');
  if (!object(planProvenance) || planProvenance.source !== 'main_model' || !hash(planProvenance.receiptHash)) throw error('main_model_receipt_required');
  if (!object(models) || !object(models.main) || !object(models.jev)) throw error('model_identity_required');
  for (const model of [models.main, models.jev]) if (!id(model.id) || !id(model.revision) || !id(model.provider)) throw error('model_identity_required');
  const plan = validateDecisionAssessmentPlan(assessmentPlan);
  const cleanSignals = json(signals), policy = deriveDecisionPolicy(point, cleanSignals);
  const input = { point, scope: json(scope), state: minimizeDecisionState(json(state), { maxChars: policy.maxStateChars, knownSecrets }), signals: cleanSignals,
    fallback: json(fallback ?? (point === 'chat.preflight' ? { needsMemory: true } : { review: true })), assessmentPlan: plan };
  const identity = { version: DECISION_CALIBRATION_VERSION, caseId, point, kernelVersion: DECISION_KERNEL_VERSION,
    inputHash: digest(input), planHash: decisionAssessmentPlanHash(plan), planReceiptHash: planProvenance.receiptHash,
    modelsHash: digest(json(models)), mainInputHash, policyHash: digest(policy), thresholdVersion, runtimeVersion,
    fallbackRoute, cacheImpact, latencyClass, cacheRegime };
  return frozen({ identity: { ...identity, hash: digest(identity) }, input, policy });
}

function usageValue(value) {
  if (!object(value)) return null;
  if (!count(value.inputTokens) || !count(value.outputTokens) || !Number.isSafeInteger(value.inputTokens + value.outputTokens)) throw error('invalid_usage');
  for (const key of ['cacheReadTokens', 'cacheWriteTokens']) if (value[key] !== undefined && (!count(value[key]) || value[key] > value.inputTokens)) throw error('invalid_usage');
  if (value.cacheReadTokens !== undefined && value.cacheWriteTokens !== undefined && value.cacheReadTokens + value.cacheWriteTokens > value.inputTokens) throw error('invalid_usage');
  // inputTokens includes cached input. Adapters must normalize provider-specific
  // uncached input + cacheRead + cacheWrite once, never sum a total twice.
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens,
    cacheReadTokens: value.cacheReadTokens ?? null, cacheWriteTokens: value.cacheWriteTokens ?? null,
    totalTokens: value.inputTokens + value.outputTokens };
}
const percentile = (values, quantile) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * quantile) - 1)] : null;
const distribution = values => ({ samples: values.length, p50: percentile(values, .5), p95: percentile(values, .95) });
const ratio = (numerator, denominator) => ({ numerator, denominator, rate: denominator ? numerator / denominator : null });
const runKey = (caseId, mode, repeat) => canonicalJSON([caseId, mode, repeat]);
const qualityObserved = row => row.observation.windowClosed && row.observation.notification.required !== null
  && row.observation.notification.delivered !== null && (row.observation.notification.delivered === false || row.observation.notification.useful !== null)
  && row.observation.completion.required !== null && (row.observation.completion.required === false || row.observation.completion.completed !== null);
function usageSummary(requests) {
  const observed = requests.filter(row => row.status !== 'pending' && row.usage !== null);
  const network = requests.filter(row => row.networkAttempted === true);
  const unknown = requests.filter(row => row.status === 'pending' || row.usage === null && row.networkAttempted !== false);
  const inputTokens = observed.reduce((sum, row) => sum + row.usage.inputTokens, 0);
  const cacheComplete = network.every(row => row.usage?.cacheReadTokens !== null && row.usage?.cacheReadTokens !== undefined);
  return { admittedRequests: requests.length, networkRequests: network.length, unknownUsageRequests: unknown.length,
    usageComplete: unknown.length === 0, inputTokens, outputTokens: observed.reduce((sum, row) => sum + row.usage.outputTokens, 0),
    totalTokens: observed.reduce((sum, row) => sum + row.usage.totalTokens, 0),
    chargedBudgetTokens: requests.reduce((sum, row) => sum + row.chargedTokens, 0),
    cacheReadTokens: cacheComplete ? observed.reduce((sum, row) => sum + (row.usage.cacheReadTokens ?? 0), 0) : null,
    cacheHitPercent: cacheComplete && inputTokens > 0 ? observed.reduce((sum, row) => sum + (row.usage.cacheReadTokens ?? 0), 0) / inputTokens * 100 : null,
    cacheWriteTokens: network.every(row => row.usage?.cacheWriteTokens !== null && row.usage?.cacheWriteTokens !== undefined) ? observed.reduce((sum, row) => sum + (row.usage.cacheWriteTokens ?? 0), 0) : null,
    latencyMs: distribution(network.filter(row => finite(row.latencyMs)).map(row => row.latencyMs)) };
}

/** Admission is a permit to the host, not a network proxy. Reserve an upper
 * bound before every request, including failed requests. Unknown usage keeps
 * its full reservation; observed overruns block subsequent admissions. */
export function createDecisionCalibration({ cases, tokenBudget } = {}) {
  if (!Array.isArray(cases) || !cases.length || cases.length > 1000 || !count(tokenBudget) || tokenBudget === 0 || tokenBudget > 1e12) throw error('invalid_experiment');
  const fixtures = new Map(), requests = new Map(), runs = new Map();
  for (const fixture of cases) {
    const copy = json(fixture), identity = copy.identity;
    if (!identity || !hash(identity.hash) || !id(identity.caseId) || fixtures.has(identity.caseId)
      || identity.version !== DECISION_CALIBRATION_VERSION || identity.kernelVersion !== DECISION_KERNEL_VERSION) throw error('invalid_fixture');
    const { hash: claimed, ...body } = identity;
    if (digest(body) !== claimed || digest(copy.input) !== identity.inputHash || digest(copy.policy) !== identity.policyHash
      || decisionAssessmentPlanHash(copy.input.assessmentPlan) !== identity.planHash || !same(deriveDecisionPolicy(copy.input.point, copy.input.signals), copy.policy)) throw error('fixture_changed');
    fixtures.set(identity.caseId, frozen(copy));
  }
  let overrun = false;
  const budgetUsed = () => [...requests.values()].reduce((sum, row) => sum + row.chargedTokens, 0);
  function target(caseId, mode, repeat) {
    if (!fixtures.has(caseId) || !MODES.includes(mode) || !count(repeat) || repeat > 10000) throw error('invalid_run');
    return { fixture: fixtures.get(caseId), key: runKey(caseId, mode, repeat) };
  }
  function admitRequest({ caseId, mode, repeat = 0, component, reservedTokens } = {}) {
    const { key } = target(caseId, mode, repeat);
    if (!['main', 'jev'].includes(component) || !count(reservedTokens) || reservedTokens === 0 || reservedTokens > 1e9) throw error('invalid_reservation');
    if (mode === 'off' && component === 'jev') throw error('off_cannot_call_jev');
    if (runs.has(key)) throw error('run_already_recorded');
    if (overrun || budgetUsed() + reservedTokens > tokenBudget) throw error('budget_exhausted');
    if (requests.size >= 10000) throw error('request_limit');
    const ticket = { id: randomUUID(), caseId, mode, repeat, component, reservedTokens };
    requests.set(ticket.id, { ...ticket, status: 'pending', usage: null, chargedTokens: reservedTokens, networkAttempted: null, latencyMs: null });
    return frozen(ticket);
  }
  function settleRequest(requestId, { status, usage, networkAttempted, latencyMs, receiptHash } = {}) {
    const row = requests.get(requestId);
    if (!row || row.status !== 'pending') throw error('request_already_settled_or_unknown');
    if (!['completed', 'failed', 'cancelled', 'unknown'].includes(status) || typeof networkAttempted !== 'boolean' || !finite(latencyMs) || !hash(receiptHash)) throw error('invalid_request_receipt');
    const normalized = usage === undefined || usage === null ? null : usageValue(usage);
    if (normalized?.totalTokens > 1e9) throw error('invalid_usage');
    if (!networkAttempted && normalized?.totalTokens > 0) throw error('nonnetwork_usage');
    Object.assign(row, { status, usage: networkAttempted ? normalized : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, networkAttempted, latencyMs, receiptHash,
      chargedTokens: networkAttempted ? normalized?.totalTokens ?? row.reservedTokens : 0 });
    if (row.chargedTokens > row.reservedTokens || budgetUsed() > tokenBudget) overrun = true;
    return frozen(structuredClone(row));
  }
  function recordRun({ caseId, mode, repeat = 0, identityHash, decision, routeId, elapsedMs, observation } = {}) {
    const { fixture, key } = target(caseId, mode, repeat);
    if (runs.has(key)) throw error('run_already_recorded');
    if (identityHash !== fixture.identity.hash) throw error('fixture_changed');
    if (!object(decision) || decision.point !== fixture.input.point || decision.mode !== mode || !['fallback', 'judge'].includes(decision.source)
      || !same(decision.policy, fixture.policy) || !finite(decision.latencyMs) || !id(routeId) || !finite(elapsedMs)
      || decision.planRevision !== undefined && decision.planRevision !== fixture.identity.planHash) throw error('decision_identity_mismatch');
    const protectedReview = fixture.input.point !== 'chat.preflight' && ['explicitRequest', 'dueSchedule', 'severeFailure', 'deliveryJustCompleted', 'unansweredQuestion'].some(name => fixture.input.signals[name] === true);
    if (decision.source === 'judge') {
      let accepted = false;
      try {
        accepted = decision.planRevision === fixture.identity.planHash && decision.judged?.planRevision === fixture.identity.planHash
          && same(decision.outcome, decision.judged) && object(decision.judged.assessments)
          && Object.entries(decision.judged.assessments).some(([name, answer]) => fixture.input.assessmentPlan.questions[name]?.type === answer?.type && decisionVerdict(answer, fixture.policy) !== undefined);
      } catch { /* Malformed/unknown assessments cannot justify a changed path. */ }
      if (!accepted) throw error('invalid_judged_receipt');
    }
    if ((mode !== 'active' || decision.source === 'fallback' || !decision.judged || protectedReview)
      && (decision.source !== 'fallback' || routeId !== fixture.identity.fallbackRoute || !same(decision.outcome, fixture.input.fallback))) throw error('fallback_path_changed');
    const related = [...requests.values()].filter(row => runKey(row.caseId, row.mode, row.repeat) === key);
    if (related.some(row => row.status === 'pending')) throw error('request_receipt_pending');
    if (decision.networkAttempted === true && !related.some(row => row.component === 'jev' && row.networkAttempted)) throw error('jev_request_not_accounted');
    if (mode === 'off' && (decision.networkAttempted === true || decision.cached === true || decision.coalesced === true)) throw error('off_cannot_call_jev');
    if (!object(observation) || !['host_verifier', 'human_review'].includes(observation.source) || !hash(observation.receiptHash)
      || typeof observation.windowClosed !== 'boolean' || !object(observation.notification) || !object(observation.completion)) throw error('outcome_receipt_required');
    for (const value of [observation.notification.required, observation.notification.delivered, observation.notification.useful, observation.completion.required, observation.completion.completed]) if (value !== null && typeof value !== 'boolean') throw error('invalid_observation');
    if (observation.notification.useful !== null && observation.notification.delivered !== true) throw error('invalid_observation');
    const row = { caseId, mode, repeat, identityHash, routeId, elapsedMs,
      decision: { source: decision.source, reason: id(decision.reason) ? decision.reason : 'unknown', latencyMs: decision.latencyMs,
        cached: decision.cached === true, coalesced: decision.coalesced === true, networkAttempted: decision.networkAttempted === true, fallback: decision.source === 'fallback',
        // No answers, candidate prose, outcome payload or raw state in reports.
        judgedHash: decision.judged ? digest(json(decision.judged)) : null },
      observation: { source: observation.source, receiptHash: observation.receiptHash, windowClosed: observation.windowClosed,
        notification: { required: observation.notification.required, delivered: observation.notification.delivered, useful: observation.notification.useful },
        completion: { required: observation.completion.required, completed: observation.completion.completed } },
      usage: { main: usageSummary(related.filter(item => item.component === 'main')), jev: usageSummary(related.filter(item => item.component === 'jev')) } };
    runs.set(key, frozen(row)); return frozen(structuredClone(row));
  }
  function snapshot() {
    const rows = [...runs.values()], modeSummaries = {};
    for (const mode of MODES) {
      const group = rows.filter(row => row.mode === mode), closed = group.filter(row => row.observation.windowClosed);
      const notification = closed.filter(row => row.observation.notification.required === true && row.observation.notification.delivered !== null);
      const delivered = closed.filter(row => row.observation.notification.delivered === true && row.observation.notification.useful !== null);
      const completion = closed.filter(row => row.observation.completion.required === true && row.observation.completion.completed !== null);
      modeSummaries[mode] = { runs: group.length, closedObservationWindows: closed.length,
        falseSilence: ratio(notification.filter(row => row.observation.notification.delivered === false).length, notification.length),
        usefulNotifications: ratio(delivered.filter(row => row.observation.notification.useful === true).length, delivered.length),
        completion: ratio(completion.filter(row => row.observation.completion.completed === true).length, completion.length),
        unknownNotificationOutcomes: group.filter(row => !row.observation.windowClosed || row.observation.notification.required === null || row.observation.notification.delivered === null || row.observation.notification.delivered === true && row.observation.notification.useful === null).length,
        unknownCompletionOutcomes: group.filter(row => !row.observation.windowClosed || row.observation.completion.required === null || row.observation.completion.required === true && row.observation.completion.completed === null).length,
        elapsedMs: distribution(group.map(row => row.elapsedMs)), decisionLatencyMs: distribution(group.map(row => row.decision.latencyMs)),
        fallbackRuns: group.filter(row => row.decision.fallback).length, cachedDecisions: group.filter(row => row.decision.cached).length,
        coalescedDecisions: group.filter(row => row.decision.coalesced).length,
        usage: { main: usageSummary([...requests.values()].filter(row => row.mode === mode && row.component === 'main')), jev: usageSummary([...requests.values()].filter(row => row.mode === mode && row.component === 'jev')) } };
    }
    const comparisons = [];
    for (const off of rows.filter(row => row.mode === 'off')) {
      const active = runs.get(runKey(off.caseId, 'active', off.repeat)), shadow = runs.get(runKey(off.caseId, 'shadow', off.repeat));
      const complete = active && [off, active].every(row => row.usage.main.usageComplete && row.usage.jev.usageComplete);
      const tokens = row => row.usage.main.totalTokens + row.usage.jev.totalTokens;
      comparisons.push({ caseId: off.caseId, repeat: off.repeat, identityHash: off.identityHash, observedModes: ['off', ...(shadow ? ['shadow'] : []), ...(active ? ['active'] : [])],
        observedTokenDelta: complete ? tokens(off) - tokens(active) : null,
        observedLatencyDeltaMs: active ? off.elapsedMs - active.elapsedMs : null,
        qualityComparable: !!active && qualityObserved(off) && qualityObserved(active)
          && off.observation.notification.required === active.observation.notification.required && off.observation.completion.required === active.observation.completion.required,
        claim: complete ? 'observed_matched_runs_not_causal_savings' : 'counterfactual_or_usage_unobserved' });
    }
    return frozen({ version: DECISION_CALIBRATION_VERSION, fixtures: [...fixtures.values()].map(row => row.identity),
      budget: { tokenBudget, chargedTokens: budgetUsed(), remainingTokens: Math.max(0, tokenBudget - budgetUsed()), overrun, pendingRequests: [...requests.values()].filter(row => row.status === 'pending').length },
      modes: modeSummaries, comparisons, runs: structuredClone(rows), requests: structuredClone([...requests.values()]),
      statisticalClaim: 'none', counterfactualSavingsClaim: 'none', provenanceClaim: 'host_receipt_attestation_not_independent_authentication' });
  }
  return Object.freeze({ admitRequest, settleRequest, recordRun, snapshot });
}
