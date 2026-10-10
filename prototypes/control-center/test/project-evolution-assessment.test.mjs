import test from 'node:test';
import assert from 'node:assert/strict';
import { describeEvolutionAssessment as describe } from '../project-evolution-assessment.mjs';
import { PROJECT_EVALUATION_RUNTIME_HASH } from '../../../packages/sdk/src/project-evolution.mjs';

const source = { id: 'candidate', simulated: false, parentVersionId: 'base', bundle: { hash: 'retained' }, evaluationRuntimeHash: PROJECT_EVALUATION_RUNTIME_HASH };
test('failed authoring offers its own frozen-input recovery without offering a nonexistent genome for reevaluation', () => {
  const version = { ...source, bundle: undefined, state: 'failed', error: { code: 'step_limit', diagnostic: { phase: 'proposal' } }, learningReviewId: 'review', learningContextHash: 'a'.repeat(64), learningIntent: { content: 'Hypothesis' } };
  const before = structuredClone(version), result = describe(version, { activeVersionId: 'base' });
  assert.equal(result.authorRetry.available, true); assert.equal(result.retry.available, false); assert.equal(result.candidateRetained, false); assert.equal(result.scoredCases, 0); assert.deepEqual(version, before);
  for (const patch of [{ sourceDeleted: true }, { contextRevoked: true }, { learningContextHash: undefined }, { learningContextHash: 'invalid' }, { learningReviewId: undefined }, { learningIntent: undefined }, { state: 'proposing' }, { state: 'interrupted' }, { proposal: {} }, { candidateHash: 'retained' }, { inputGenomeHash: 'retained' }, { error: { code: 'baseline_contract_failed' } }, { simulated: true }]) assert.equal(describe({ ...version, ...patch }, { activeVersionId: 'base' }).authorRetry.available, false);
  assert.equal(describe(version, { activeVersionId: 'another' }).authorRetry.available, false);
});
test('legacy compatibility and draft failures remain unscored without rewriting evidence', () => {
  const version = { ...source, state: 'rejected', evaluation: { gatePassed: false, evaluationComplete: false, stage: 'script_preflight', earlyStopReason: 'frozen_tool_contract_failed', scoredCases: 0, cases: 0, skippedCases: 5, gates: { scripts: false, minimumScore: null }, smoke: { passed: true, results: [{ passed: true }] }, frozenSmoke: [{ toolId: 'old_tool', passed: false, expected: 'private content', actual: 'other private content' }] } };
  const original = structuredClone(version), assessment = describe(version);
  assert.equal(assessment.category, 'contract_incompatible'); assert.equal(assessment.scoredCases, 0); assert.equal(assessment.totalCases, 5);
  assert.equal(assessment.failedChecks[0].count, 1); assert.equal(assessment.retry.available, false); assert.equal(assessment.retry.kind, 'revise'); assert.match(assessment.summary, /尚未进行质量评分/);
  assert.ok(!JSON.stringify(assessment).includes('private content')); assert.deepEqual(version, original);
  version.evaluation.smoke.results.push({ toolId: 'new_tool', passed: false });
  assert.equal(describe(version).category, 'candidate_invalid');
});
test('complete quality failure, blocked baseline and incomplete judge are different outcomes', () => {
  assert.equal(describe({ ...source, state: 'rejected', evaluation: { gatePassed: false, evaluationComplete: true, gates: { improvement: false }, scoredCases: 3 } }).category, 'quality_rejected');
  assert.equal(describe({ ...source, state: 'failed', error: { code: 'baseline_contract_failed' }, evaluationEvidence: { baselineSmoke: { results: [{ passed: false }] } } }).category, 'baseline_blocked');
  const version = { ...source, state: 'failed', error: { code: 'invalid_output', diagnostic: { phase: 'judge', kind: 'invalid_json' } }, evaluationEvidence: { totalCases: 3, cases: [{ baselineScore: .5, candidateScore: .9 }] } };
  const result = describe(version, { activeVersionId: 'base' }); assert.equal(result.category, 'evaluation_error'); assert.equal(result.stage, 'judge'); assert.equal(result.scoredCases, 1); assert.equal(result.totalCases, 3); assert.equal(result.retry.available, true);
  assert.equal(describe(version, { activeVersionId: 'different-base' }).retry.available, false);
});
test('no generated candidate, interruption and budget rejection do not fabricate a quality result', () => {
  assert.equal(describe({ id: 'draft', state: 'failed', error: { code: 'invalid_output', diagnostic: { phase: 'proposal', kind: 'invalid_json' } } }).category, 'proposal_error');
  const interrupted = describe({ id: 'draft', state: 'interrupted' }); assert.equal(interrupted.retry.kind, 'regenerate'); assert.equal(interrupted.retry.available, false);
  assert.equal(describe({ ...source, state: 'failed', error: { code: 'budget_exhausted' } }).category, 'budget_blocked');
  assert.equal(describe({ ...source, state: 'ready', evaluation: { gatePassed: true } }).retry.reason, '');
  assert.equal(describe({ ...source, state: 'evaluating' }).retry.reason, '');
});

test('artifact failures expose actual path and verifier code without raw artifact content or implying visual verification', () => {
  const version = { ...source, state: 'rejected', evaluation: { gatePassed: false, evaluationComplete: false, earlyStopReason: 'candidate_deterministic_failed', scoredCases: 0, coverage: { workspaceCases: 3, artifactChecks: 5, visualQuality: 'not_verified' }, methodologyVersion: 'rna-method-1', details: [{ id: 'build', candidate: { checks: { artifacts: false }, workspace: { artifacts: [{ content: 'private artifact text' }], checks: [{ id: 'data', path: 'out/data.json', kind: 'json_equals', passed: false, code: 'artifact_mismatch' }] } } }] } };
  const assessment = describe(version); assert.equal(assessment.category, 'quality_rejected'); assert.equal(assessment.scoredCases, 0); assert.equal(assessment.coverage.visualQuality, 'not_verified');
  assert.equal(assessment.failedChecks.find(item => item.group === 'artifact').code, 'artifact_mismatch'); assert.match(assessment.failedChecks.at(-1).label, /out\/data.json/); assert.ok(!JSON.stringify(assessment).includes('private artifact text'));
});

test('only an actual runtime change or unrecorded legacy evaluator enables explicit reevaluation of rejected retained candidates', () => {
  const candidate = { ...source, state: 'rejected', evaluation: { gatePassed: false, evaluationComplete: false, earlyStopReason: 'candidate_deterministic_failed' } };
  assert.equal(describe(candidate, { activeVersionId: 'base' }).retry.available, false);
  for (const value of ['previous-runtime-hash', undefined]) {
    const original = { ...candidate, evaluationRuntimeHash: value }, snapshot = structuredClone(original), result = describe(original, { activeVersionId: 'base' });
    assert.equal(result.runtimeChanged, true); assert.equal(result.retry.available, true); assert.equal(result.retry.kind, 'reevaluate'); assert.deepEqual(original, snapshot);
    assert.equal(describe(original, { activeVersionId: 'changed-baseline' }).retry.available, false);
  }
  assert.equal(describe({ ...candidate, evaluationRuntimeHash: 'old', error: { code: 'baseline_contract_failed' } }).retry.available, false);
});
