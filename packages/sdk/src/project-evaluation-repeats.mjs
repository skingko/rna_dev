import { evolutionHash as hash } from './evolution.mjs';
import { validateProjectEvaluationPartitionPlan } from './project-evaluation-partitions.mjs';

const fail = message => { throw Object.assign(new Error(message), { name: 'ProjectEvaluationRepeatError', code: 'invalid_evaluation_repeat' }); };
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
const method = {
  id: 'project-selection-repeats-v1', version: 1, repeatCounts: [2, 3],
  allocation: 'fixed_before_authoring', execution: 'fresh_sessions_alternating_order',
  missing: 'incomplete_not_scored', selection: 'all_repeats_original_gates',
  confirmation: 'original_one_candidate_once', statisticalClaim: 'descriptive_only',
};
export const PROJECT_EVALUATION_REPEAT_METHOD = freeze({ ...method, hash: hash(method) });

/** Trusted host precommitment, not a candidate-controlled search knob. Persist
 * before authoring; no task bodies are exposed to the author. This does not
 * claim randomness independence, calibrated null noise, or statistical power. */
export function createProjectEvaluationRepeatPlan({ suite, partitionPlan, baselineHash, modelHash, evaluationRuntimeHash, repeatCount = 2, seed, frozenAt = new Date().toISOString() } = {}) {
  const partitions = validateProjectEvaluationPartitionPlan(partitionPlan, suite);
  if (![baselineHash, modelHash, evaluationRuntimeHash, seed].every(validHash) || ![2, 3].includes(repeatCount)) fail('Repeat plans need frozen baseline, model, runtime, seed and 2 or 3 repetitions');
  if (typeof frozenAt !== 'string' || !Number.isFinite(Date.parse(frozenAt)) || new Date(frozenAt).toISOString() !== frozenAt || frozenAt < partitions.frozenAt) fail('Repeat plan time must be canonical and follow partition allocation');
  const selected = partitions.assignments.filter(row => row.partition === 'selection');
  const trials = Array.from({ length: repeatCount }, (_, index) => selected.map(row => {
    const repeatIndex = index + 1;
    const bit = purpose => (parseInt(hash({ seed, caseId: row.caseId, purpose }).slice(0, 2), 16) + index) % 2;
    return { id: `repeat_${hash({ caseId: row.caseId, repeatIndex }).slice(0, 24)}`, caseId: row.caseId, repeatIndex,
      runOrder: bit('execution') ? ['candidate', 'baseline'] : ['baseline', 'candidate'],
      assignment: bit('judge') ? 'candidate-left' : 'baseline-left' };
  })).flat();
  const value = { schemaVersion: 1, method: PROJECT_EVALUATION_REPEAT_METHOD, frozenAt, partitionPlanHash: partitions.planHash, suiteHash: hash(suite), baselineHash, modelHash, evaluationRuntimeHash, repeatCount, seed, trials };
  return freeze({ ...value, planHash: hash(value) });
}

export function validateProjectEvaluationRepeatPlan(plan, { suite, partitionPlan, baselineHash, modelHash, evaluationRuntimeHash } = {}) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('A frozen repeat plan is required');
  const restored = createProjectEvaluationRepeatPlan({ suite, partitionPlan, baselineHash, modelHash, evaluationRuntimeHash, repeatCount: plan.repeatCount, seed: plan.seed, frozenAt: plan.frozenAt });
  if (hash(plan) !== hash(restored)) fail('Repeat plan differs from its frozen suite, allocation, policy, baseline, model or runtime');
  return restored;
}

const statistics = values => {
  if (!values.length) return { count: 0, mean: null, sampleVariance: null, sampleStdDev: null, min: null, max: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) : null;
  return { count: values.length, mean, sampleVariance: variance, sampleStdDev: variance === null ? null : Math.sqrt(variance), min: Math.min(...values), max: Math.max(...values) };
};
const gatesFor = (rows, thresholds) => {
  const weight = rows.reduce((sum, row) => sum + row.weight, 0);
  const baselineScore = rows.reduce((sum, row) => sum + row.weight * row.baselineScore, 0) / weight;
  const candidateScore = rows.reduce((sum, row) => sum + row.weight * row.candidateScore, 0) / weight;
  const tokens = side => rows.reduce((sum, row) => sum + row[side].usage.totalTokens, 0);
  const cost = { baselineTokens: tokens('baseline'), candidateTokens: tokens('candidate') };
  const gates = { deterministicCases: rows.every(row => row.candidate.passed), minimumScore: candidateScore >= thresholds.minScore, improvement: candidateScore - baselineScore >= thresholds.minImprovement, noRegression: rows.every(row => row.candidateScore + thresholds.maxRegression >= row.baselineScore), tokenRatio: cost.candidateTokens <= Math.max(1, cost.baselineTokens) * thresholds.maxTokenRatio };
  return { cases: rows.length, baselineScore, candidateScore, improvement: candidateScore - baselineScore, cost, gates, gatePassed: Object.values(gates).every(Boolean) };
};

/** All slots must be present exactly once. Partial data has descriptive rows
 * but never a partial-denominator score or a passing gate. Original gates are
 * applied to EACH complete repetition as well as the pooled mean. A mean gain
 * cannot hide a regression, expensive run, or failed repetition. */
export function summarizeProjectEvaluationRepeats({ repeatPlan, suite, partitionPlan, baselineHash, modelHash, evaluationRuntimeHash, rows = [] } = {}) {
  const plan = validateProjectEvaluationRepeatPlan(repeatPlan, { suite, partitionPlan, baselineHash, modelHash, evaluationRuntimeHash });
  if (!Array.isArray(rows) || rows.length > plan.trials.length) fail('Repeated measurements exceed their fixed allocation');
  const seen = new Set();
  for (const row of rows) {
    const trial = plan.trials.find(item => item.id === row?.id), testCase = suite.cases.find(item => item.id === trial?.caseId);
    if (!trial || seen.has(row.id) || row.caseId !== trial.caseId || row.repeatIndex !== trial.repeatIndex || row.partition !== 'selection' || row.weight !== testCase.weight) fail('Unexpected, duplicate or wrongly bound repeated measurement');
    seen.add(row.id);
    for (const side of ['baseline', 'candidate']) if (!Number.isFinite(row[`${side}Score`]) || row[`${side}Score`] < 0 || row[`${side}Score`] > 1 || typeof row[side]?.passed !== 'boolean' || !Number.isSafeInteger(row[side]?.usage?.totalTokens) || row[side].usage.totalTokens < 0) fail('Repeated measurements require real bounded scores, deterministic receipts and metered costs');
  }
  const expectedPerRepeat = plan.trials.length / plan.repeatCount;
  const repeats = Array.from({ length: plan.repeatCount }, (_, index) => {
    const repeatIndex = index + 1, items = rows.filter(row => row.repeatIndex === repeatIndex), complete = items.length === expectedPerRepeat;
    return { repeatIndex, complete, observedTrials: items.length, expectedTrials: expectedPerRepeat, ...(complete ? gatesFor(items, suite.thresholds) : { baselineScore: null, candidateScore: null, improvement: null, gatePassed: false }) };
  });
  const complete = rows.length === plan.trials.length;
  const perCase = partitionPlan.assignments.filter(row => row.partition === 'selection').map(item => {
    const items = rows.filter(row => row.caseId === item.caseId);
    return { caseId: item.caseId, expectedTrials: plan.repeatCount, baseline: statistics(items.map(row => row.baselineScore)), candidate: statistics(items.map(row => row.candidateScore)), pairedImprovement: statistics(items.map(row => row.candidateScore - row.baselineScore)) };
  });
  const scored = complete ? gatesFor(rows, suite.thresholds) : { cases: rows.length, baselineScore: null, candidateScore: null, improvement: null, gates: { deterministicCases: null, minimumScore: null, improvement: null, noRegression: null, tokenRatio: null } };
  const gates = { ...scored.gates, repeatComplete: complete, repeatConsistency: complete && repeats.every(row => row.gatePassed) };
  return freeze({ ...scored, gates, gatePassed: Object.values(gates).every(value => value === true), complete, repeatPlanHash: plan.planHash, expectedTrials: plan.trials.length, observedTrials: rows.length, repeats, perCase,
    pairedImprovement: statistics(repeats.filter(row => row.complete).map(row => row.improvement)),
    worstRegression: rows.length ? Math.max(0, ...rows.map(row => row.baselineScore - row.candidateScore)) : null,
    statisticalClaim: 'descriptive_only', nullNoiseCalibration: 'not_measured',
    limitations: ['Repeated observations of the same frozen tasks do not add independent task coverage.', 'Variance includes model execution and judge variation; it does not identify either component or calibrate unchanged-baseline noise.', 'All original gates apply to every complete repetition; no best run, adaptive sample size or threshold relaxation is permitted.', 'Independent confirmation, when supplied, remains a separate one-time test.'] });
}
