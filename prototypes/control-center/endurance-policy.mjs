import { createHash } from 'node:crypto';

export const ENDURANCE_POLICY_METHOD = 'observed-window-coverage-v1';
export const ENDURANCE_COVERAGE_KINDS = Object.freeze(['idle', 'foreground', 'learning', 'memory', 'model_progress', 'scheduled_delivery']);
const defaults = ['foreground', 'memory', 'model_progress'];
const stages = Object.freeze({ startup: 2, workload: 8, daily_cycle: 26 });
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const faulted = run => ['unhealthySamples', 'observedUnavailableSeconds', 'unobservedSeconds', 'daemonRestarts', 'managedHelperRestarts', 'clockDiscontinuities'].some(key => Number(run?.[key]) > 0);
const identity = value => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const profile = value => {
  if (!Array.isArray(value) || value.length > ENDURANCE_COVERAGE_KINDS.length || value.some(key => !ENDURANCE_COVERAGE_KINDS.includes(key)) || new Set(value).size !== value.length) throw new Error('耐久覆盖类型无效');
  return [...value].sort();
};
const priorSummary = run => run ? { id: /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(run.id ?? '') ? run.id : digest(run.id ?? null), status: ['running', 'stopped', 'completed'].includes(run.status) ? run.status : 'unknown', targetHours: finite(run.targetHours) ? run.targetHours : null, elapsedWallSeconds: finite(run.elapsedWallSeconds) ? run.elapsedWallSeconds : 0, observedHealthySeconds: finite(run.observedHealthySeconds) ? run.observedHealthySeconds : 0, passed: typeof run.passed === 'boolean' ? run.passed : null, faulted: faulted(run) } : null;

/** This selects one NEW immutable window. It never edits or combines old runs.
 * Missing implementation identity prevents legacy uptime from advancing stages. */
export function createEndurancePolicy({ hours, previousRuns = [], runtimeIdentity = null, requiredCoverage = defaults } = {}) {
  if (!identity(runtimeIdentity)) throw new Error('耐久实现身份必须为 SHA-256 或 null');
  if (!Array.isArray(previousRuns) || previousRuns.length > 256) throw new Error('耐久历史最多 256 项');
  const profileCoverage = profile(requiredCoverage);
  const byId = new Map();
  for (const run of previousRuns) if (run && typeof run.id === 'string') {
    const old = byId.get(run.id);
    if (!old || (Number(run.samples) || 0) >= (Number(old.samples) || 0)) byId.set(run.id, run);
  }
  const history = [...byId.values()].sort((a, b) => String(a.requestedAt ?? '').localeCompare(String(b.requestedAt ?? '')));
  const previous = history.at(-1) ?? null;
  let stage = 'startup', reason = previous ? 'history_does_not_establish_current_stage' : 'initial_observation', reviewRequired = false;
  if (hours !== undefined) {
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 8760) throw new Error('耐久观测小时数必须大于 0 且不超过 8760');
    stage = 'explicit'; reason = 'explicit_hours';
  } else if (faulted(previous)) { reason = 'prior_window_faulted'; reviewRequired = true; }
  else if (runtimeIdentity && previous?.policy) {
    let prior;
    try { prior = validateEndurancePolicy(previous.policy); } catch { /* Invalid/legacy evidence cannot advance a stage. */ }
    if (prior?.mode === 'adaptive' && prior.runtimeIdentity === runtimeIdentity && JSON.stringify(prior.profileCoverage) === JSON.stringify(profileCoverage)) {
      stage = prior.stage;
      if (previous.status === 'completed' && previous.passed === true && enduranceAssessment(previous).verdict === 'window_passed') {
        stage = prior.stage === 'startup' ? 'workload' : 'daily_cycle'; reason = prior.stage === 'daily_cycle' ? 'profile_window_observed' : 'advance_completed_stage';
      } else reason = previous.status === 'completed' ? 'coverage_not_observed' : 'prior_window_incomplete';
    }
  }
  const plan = { schemaVersion: 1, method: ENDURANCE_POLICY_METHOD, mode: hours === undefined ? 'adaptive' : 'fixed', stage,
    targetHours: hours ?? stages[stage], runtimeIdentity, profileCoverage, requiredCoverage: stage === 'startup' || stage === 'explicit' ? [] : profileCoverage,
    reason, reviewRequired, predecessor: priorSummary(previous), history: { runs: history.length, faultedRuns: history.filter(faulted).length }, automaticNextWindow: false };
  return freeze({ ...plan, hash: digest(plan) });
}

export function validateEndurancePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('耐久计划无效');
  const allowed = ['schemaVersion', 'method', 'mode', 'stage', 'targetHours', 'runtimeIdentity', 'profileCoverage', 'requiredCoverage', 'reason', 'reviewRequired', 'predecessor', 'history', 'automaticNextWindow', 'hash'];
  if (Object.keys(value).length !== allowed.length || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('耐久计划字段无效');
  const copy = structuredClone(value), { hash, ...body } = copy;
  if (value.schemaVersion !== 1 || value.method !== ENDURANCE_POLICY_METHOD || !['fixed', 'adaptive'].includes(value.mode) || !identity(value.runtimeIdentity) || typeof value.reviewRequired !== 'boolean' || value.automaticNextWindow !== false || hash !== digest(body)) throw new Error('耐久计划身份无效');
  if (!finite(value.targetHours) || value.targetHours <= 0 || value.targetHours > 8760 || value.mode === 'fixed' && value.stage !== 'explicit' || value.mode === 'adaptive' && stages[value.stage] !== value.targetHours) throw new Error('耐久计划目标无效');
  const selected = profile(value.profileCoverage), required = profile(value.requiredCoverage);
  if (JSON.stringify(selected) !== JSON.stringify(value.profileCoverage) || JSON.stringify(required) !== JSON.stringify(value.requiredCoverage) || JSON.stringify(required) !== JSON.stringify(value.stage === 'startup' || value.stage === 'explicit' ? [] : selected)) throw new Error('耐久计划覆盖要求无效');
  if (!['explicit_hours', 'initial_observation', 'history_does_not_establish_current_stage', 'prior_window_faulted', 'profile_window_observed', 'advance_completed_stage', 'coverage_not_observed', 'prior_window_incomplete'].includes(value.reason) || !count(value.history?.runs) || !count(value.history?.faultedRuns) || value.history.faultedRuns > value.history.runs || Object.keys(value.history).sort().join(',') !== 'faultedRuns,runs') throw new Error('耐久计划依据无效');
  if (value.predecessor && (Object.keys(value.predecessor).sort().join(',') !== 'elapsedWallSeconds,faulted,id,observedHealthySeconds,passed,status,targetHours' || typeof value.predecessor.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value.predecessor.id) || !['running', 'stopped', 'completed', 'unknown'].includes(value.predecessor.status) || typeof value.predecessor.faulted !== 'boolean' || !(value.predecessor.passed === null || typeof value.predecessor.passed === 'boolean') || !(value.predecessor.targetHours === null || finite(value.predecessor.targetHours)) || !finite(value.predecessor.elapsedWallSeconds) || !finite(value.predecessor.observedHealthySeconds))) throw new Error('耐久计划历史摘要无效');
  return freeze(copy);
}

export function createEnduranceCoverage() {
  return { schemaVersion: 1, samples: 0, kinds: Object.fromEntries(ENDURANCE_COVERAGE_KINDS.map(key => [key, { availableSamples: 0, observedSamples: 0, healthyObservedSamples: 0 }])), recoveredTransitions: 0, usageCounterResets: 0, scheduledCounterResets: 0 };
}

// Admit meaningful changes between regular interval samples without logging
// every health field or treating a provider's reserved budget as real progress.
export function enduranceCoverageObservationKey(sample) {
  const work = sample?.workload ?? {}, activity = keys => keys.some(key => count(work[key])) ? keys.some(key => count(work[key]) && work[key] > 0) : null;
  return JSON.stringify({ foreground: activity(['activeSessions', 'activeExecutions']), learning: activity(['learningReviews', 'evaluations']), memory: activity(['memoryOperations']),
    activeWork: typeof work.activeWork === 'boolean' ? work.activeWork : null,
    reported: count(work.tokenUsage?.reported) ? work.tokenUsage.reported : null,
    memoryCompleted: count(sample?.dependencies?.memory?.sync?.counts?.completed) ? sample.dependencies.memory.sync.counts.completed : null,
    scheduledCompleted: count(work.completedScheduledOccurrences) ? work.completedScheduledOccurrences : null });
}

/** Samples establish observed activity, not successful delivery or sustained
 * throughput. Only explicit cumulative completion deltas establish deliveries. */
export function recordEnduranceCoverage(coverage, sample, previous, { continuity = true } = {}) {
  const next = structuredClone(coverage ?? createEnduranceCoverage()), work = sample.workload ?? {}, old = previous?.workload ?? {};
  const active = keys => keys.some(key => count(work[key]) && work[key] > 0), available = keys => keys.some(key => count(work[key]));
  const signals = {
    foreground: { available: available(['activeSessions', 'activeExecutions']), observed: active(['activeSessions', 'activeExecutions']) },
    learning: { available: available(['learningReviews', 'evaluations']), observed: active(['learningReviews', 'evaluations']) },
    memory: { available: count(work.memoryOperations), observed: count(work.memoryOperations) && work.memoryOperations > 0 },
    idle: { available: typeof work.activeWork === 'boolean', observed: work.activeWork === false && !active(['activeSessions', 'activeExecutions', 'learningReviews', 'evaluations', 'memoryOperations', 'initializations', 'deletionOperations']) },
    model_progress: { available: count(work.tokenUsage?.reported), observed: false },
    scheduled_delivery: { available: count(work.completedScheduledOccurrences), observed: false },
  };
  const delta = (a, b, kind, resetKey) => {
    if (!count(a) || !count(b)) return;
    if (a < b) next[resetKey]++;
    else if (continuity && a > b) { signals[kind].observed = true; signals[kind].healthyEvidence = previous?.healthy === true; }
  };
  delta(work.tokenUsage?.reported, old.tokenUsage?.reported, 'model_progress', 'usageCounterResets');
  delta(work.completedScheduledOccurrences, old.completedScheduledOccurrences, 'scheduled_delivery', 'scheduledCounterResets');
  const memoryCompleted = sample.dependencies?.memory?.sync?.counts?.completed, previousCompleted = previous?.dependencies?.memory?.sync?.counts?.completed;
  if (count(memoryCompleted)) signals.memory.available = true;
  if (continuity && count(memoryCompleted) && count(previousCompleted) && memoryCompleted > previousCompleted) { signals.memory.observed = true; if (!active(['memoryOperations'])) signals.memory.healthyEvidence = previous?.healthy === true; }
  next.samples++;
  for (const [kind, signal] of Object.entries(signals)) {
    const row = next.kinds[kind];
    if (signal.available) row.availableSamples++;
    if (signal.observed) { row.observedSamples++; if (sample.healthy === true && signal.healthyEvidence !== false) row.healthyObservedSamples++; }
  }
  if (sample.healthy === true && previous?.healthy === false) next.recoveredTransitions++;
  return next;
}

export function enduranceAssessment(run) {
  const policy = run?.policy ? validateEndurancePolicy(run.policy) : null;
  const requirements = policy?.requiredCoverage ?? [];
  const coverage = Object.fromEntries(ENDURANCE_COVERAGE_KINDS.map(kind => { const row = run?.coverage?.kinds?.[kind]; return [kind, !row?.availableSamples ? 'unknown' : row.healthyObservedSamples > 0 ? 'observed_healthy' : row.observedSamples > 0 ? 'observed_degraded' : 'not_observed']; }));
  const missingCoverage = requirements.filter(kind => coverage[kind] !== 'observed_healthy');
  const temporalComplete = run?.status === 'completed' && finite(run?.elapsedWallSeconds) && run.elapsedWallSeconds >= run.targetSeconds;
  const availabilityPassed = temporalComplete ? !faulted(run) && run.observedHealthySeconds >= run.targetSeconds : null;
  const coverageSatisfied = missingCoverage.length === 0;
  const verdict = run?.status === 'running' ? 'observing' : run?.status === 'stopped' ? 'stopped' : !temporalComplete ? 'not_started' : !availabilityPassed ? 'window_failed' : !coverageSatisfied ? 'coverage_incomplete' : 'window_passed';
  return { schemaVersion: 1, method: ENDURANCE_POLICY_METHOD, mode: policy?.mode ?? 'fixed', stage: policy?.stage ?? 'legacy_explicit', verdict,
    targetHours: run?.targetHours ?? null, elapsedWallSeconds: run?.elapsedWallSeconds ?? 0, observedHealthySeconds: run?.observedHealthySeconds ?? 0, unobservedSeconds: run?.unobservedSeconds ?? 0,
    availabilityPassed, coverageSatisfied, coverage, missingCoverage, historicalFaultsRetained: faulted(run), scope: policy?.stage === 'startup' ? 'startup_availability_only' : 'one_observed_window_only',
    isolatedFaultTestsContributeSeconds: 0, lifetimeAcceptance: false };
}

/** Recommendations are advisory; calling this never starts, stops, extends or
 * rewrites a run. An explicit --hours remains an explicit fixed contract. */
export function recommendNextEnduranceWindow(run) {
  const assessment = enduranceAssessment(run);
  if (run?.status === 'running') return { action: 'finish_current_window', nextHours: null, reason: 'immutable_running_target', currentTargetHours: run.targetHours };
  if (!run?.policy || run.policy.mode === 'fixed') return { action: 'operator_choice', nextHours: null, reason: 'explicit_hours_respected' };
  const plan = createEndurancePolicy({ previousRuns: [run], runtimeIdentity: run.policy.runtimeIdentity, requiredCoverage: run.policy.profileCoverage });
  if (assessment.verdict === 'window_passed' && run.policy.stage === 'daily_cycle') return { action: 'window_evidence_sufficient', nextHours: null, reason: 'profile_window_observed_not_lifetime_proof' };
  return { action: plan.reviewRequired ? 'review_fault_before_next_window' : assessment.verdict === 'coverage_incomplete' ? 'observe_missing_workload' : 'new_window_available', nextHours: plan.targetHours, reason: plan.reason, missingCoverage: assessment.missingCoverage, requiresExplicitStart: true };
}
