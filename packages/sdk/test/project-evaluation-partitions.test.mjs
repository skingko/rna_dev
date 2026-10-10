import test from 'node:test';
import assert from 'node:assert/strict';
import { evolutionHash as digest } from '../src/evolution.mjs';
import { projectGenomeFixture } from './fixtures/project-genome-fixture.mjs';
import { createProjectEvaluationPartitionPlan, validateProjectEvaluationPartitionPlan, projectEvaluationPartitionCases, projectEvaluationPartitionSummary, createProjectEvaluationPhaseLedger, createProjectEvaluationConfirmationClaim, settleProjectEvaluationConfirmationClaim, validateProjectEvaluationConfirmationClaim, PROJECT_EVALUATION_PARTITION_METHOD } from '../src/project-evaluation-partitions.mjs';

const frozenAt = '2026-09-27T01:00:00.000Z';
const suite = () => projectGenomeFixture().evaluationSuite;
const assignments = () => [
  { caseId: 'prototype', partition: 'development', taskFamily: 'coding' },
  { caseId: 'empty', partition: 'selection', taskFamily: 'planning' },
  { caseId: 'evidence', partition: 'confirmation', taskFamily: 'planning' },
];
const provenance = (source = suite()) => ({ datasetId: 'private-rna-game', version: 'v1', sourceHash: digest(source.cases.filter(row => row.id === 'evidence')), reviewId: 'host-review-1', reviewedAt: '2026-09-26T01:00:00.000Z', authorship: 'independent_host_review', exposure: 'withheld' });
const plan = (source = suite()) => createProjectEvaluationPartitionPlan({ suite: source, assignments: assignments(), confirmationProvenance: provenance(source), frozenAt });
const invalid = callback => assert.throws(callback, error => error.code === 'invalid_evaluation_partition');
const receipt = (id, phase, totalTokens = 10) => ({ id, phase, completed: true, requestStarted: true, usage: { input: totalTokens - 2, output: 2, totalTokens } });

test('legacy cases stay selection-only and cannot acquire a fabricated held-out success', () => {
  const source = suite(), result = createProjectEvaluationPartitionPlan({ suite: source, frozenAt });
  assert.ok(result.assignments.every(row => row.partition === 'selection'));
  assert.deepEqual(projectEvaluationPartitionSummary(result), {
    methodId: 'project-partitions-v1', planHash: result.planHash, counts: { development: 0, selection: 3, confirmation: 0 },
    taskFamilies: [{ taskFamily: 'unclassified', development: 0, selection: 3, confirmation: 0 }],
    confirmation: { status: 'not_applicable', reason: 'independent_confirmation_not_supplied', passed: null }, statisticalClaim: 'none',
  });
  assert.deepEqual(projectEvaluationPartitionCases(result, source, 'selection'), source.cases);
  assert.deepEqual(projectEvaluationPartitionCases(result, source, 'confirmation'), []);
});

test('explicit host plan binds complete suite, exact case allocation and independently reviewed provenance', () => {
  const source = suite(), before = structuredClone(source), result = plan(source);
  assert.deepEqual(validateProjectEvaluationPartitionPlan(JSON.parse(JSON.stringify(result)), source), result);
  assert.equal(result.suiteHash, digest(source));
  assert.equal(result.confirmation.provenance.sourceHash, digest([source.cases[2]]));
  assert.deepEqual(result.assignments.map(row => row.caseHash), source.cases.map(row => digest(row)));
  assert.deepEqual(source, before);
  for (const [index, partition] of ['development', 'selection', 'confirmation'].entries()) assert.deepEqual(projectEvaluationPartitionCases(result, source, partition), [source.cases[index]]);
});

test('assignments normalize to original case order and cannot silently delete or duplicate a case', () => {
  const source = suite(), expected = plan(source);
  const reversed = createProjectEvaluationPartitionPlan({ suite: source, assignments: assignments().reverse(), confirmationProvenance: provenance(), frozenAt });
  assert.equal(reversed.planHash, expected.planHash);
  for (const bad of [[], assignments().slice(1), [...assignments(), assignments()[0]], [assignments()[0], assignments()[0], assignments()[2]], assignments().map(row => ({ ...row, caseId: 'unknown' }))]) invalid(() => createProjectEvaluationPartitionPlan({ suite: source, assignments: bad, confirmationProvenance: provenance(), frozenAt }));
});

test('development-only and confirmation-only plans cannot replace a selection comparison', () => {
  for (const partition of ['development', 'confirmation']) invalid(() => createProjectEvaluationPartitionPlan({ suite: suite(), assignments: assignments().map(row => ({ ...row, partition })), confirmationProvenance: provenance(), frozenAt }));
});

test('random or author-generated split without reviewed confirmation data is rejected', () => {
  for (const confirmationProvenance of [undefined, {}, { ...provenance(), authorship: 'candidate_authored' }, { ...provenance(), authorship: 'random_split' }, { ...provenance(), exposure: 'author_visible' }, { ...provenance(), sourceHash: '0'.repeat(64) }, { ...provenance(), reviewedAt: '2026-09-28T01:00:00.000Z' }]) invalid(() => createProjectEvaluationPartitionPlan({ suite: suite(), assignments: assignments(), confirmationProvenance, frozenAt }));
});

test('renaming or changing weight cannot make the same task independent across partitions', () => {
  const source = suite();
  source.cases[2] = { ...structuredClone(source.cases[0]), id: 'evidence', weight: 2 };
  invalid(() => createProjectEvaluationPartitionPlan({ suite: source, assignments: assignments(), confirmationProvenance: provenance(source), frozenAt }));
  const samePartition = createProjectEvaluationPartitionPlan({ suite: source, frozenAt });
  assert.equal(samePartition.assignments.length, 3, 'Legacy duplicate selection cases are not retroactively rewritten');
});

test('suite, thresholds, case checks, execution and time changes invalidate restoration', () => {
  const original = suite(), result = plan(original);
  for (const mutate of [s => { s.cases[1].input += ' changed'; }, s => { s.thresholds.minScore = 0.5; }, s => { s.criteria[0].description += ' changed'; }, s => { s.execution = { maxSteps: 4, maxOutputTokens: 512 }; }]) {
    const source = structuredClone(original); mutate(source); invalid(() => validateProjectEvaluationPartitionPlan(result, source));
  }
  for (const mutate of [p => { p.assignments[0].caseHash = '0'.repeat(64); }, p => { p.assignments[0].partition = 'selection'; }, p => { p.frozenAt = '2026-09-27T02:00:00.000Z'; }, p => { p.confirmation.provenance.reviewId = 'another-review'; }, p => { p.method.confirmationReuse = 'repeat_until_pass'; }]) {
    const changed = structuredClone(result); mutate(changed); invalid(() => validateProjectEvaluationPartitionPlan(changed, original));
  }
});

test('plan and policy are recursively immutable and case reads are detached copies', () => {
  const source = suite(), result = plan(source);
  assert.throws(() => { result.assignments[0].partition = 'selection'; }, TypeError);
  assert.throws(() => { result.confirmation.provenance.exposure = 'visible'; }, TypeError);
  assert.throws(() => { PROJECT_EVALUATION_PARTITION_METHOD.order.push('development'); }, TypeError);
  const detached = projectEvaluationPartitionCases(result, source, 'confirmation'); detached[0].input = 'rewritten';
  assert.equal(projectEvaluationPartitionCases(result, source, 'confirmation')[0].input, source.cases[2].input);
});

test('public summaries retain declared family coverage but no private task, ID, dataset, or expected result', () => {
  const source = suite(); source.cases[2].input = 'PRIVATE_TASK'; source.cases[2].requiredTerms = ['PRIVATE_EXPECTED'];
  const summary = projectEvaluationPartitionSummary(plan(source)), serialized = JSON.stringify(summary);
  assert.deepEqual(summary.taskFamilies, [ { taskFamily: 'coding', development: 1, selection: 0, confirmation: 0 }, { taskFamily: 'planning', development: 0, selection: 1, confirmation: 1 } ]);
  for (const forbidden of ['PRIVATE_TASK', 'PRIVATE_EXPECTED', 'evidence', 'host-review-1', 'private-rna-game']) assert.equal(serialized.includes(forbidden), false);
  assert.equal(summary.confirmation.passed, null);
});

test('malformed cases, metadata, identities and canonical dates fail before model work', () => {
  for (const source of [null, {}, { cases: [] }, { cases: [{ id: 'bad case' }] }, { cases: [suite().cases[0], suite().cases[0]] }, { cases: Array.from({ length: 13 }, (_, index) => ({ id: `case_${index}` })) }]) invalid(() => createProjectEvaluationPartitionPlan({ suite: source, frozenAt }));
  for (const time of ['2026-09-27', '2026-09-27T01:00:00Z', '2026-02-30T01:00:00.000Z', 1, null]) invalid(() => createProjectEvaluationPartitionPlan({ suite: suite(), frozenAt: time }));
  for (const changes of [{ partition: 'hidden' }, { taskFamily: '' }, { taskFamily: 'x'.repeat(81) }, { input: 'unexpected' }]) invalid(() => createProjectEvaluationPartitionPlan({ suite: suite(), assignments: assignments().map((row, index) => index ? row : { ...row, ...changes }), confirmationProvenance: provenance(), frozenAt }));
  invalid(() => createProjectEvaluationPartitionPlan({ suite: suite(), confirmationProvenance: provenance(), frozenAt }));
  invalid(() => projectEvaluationPartitionCases(plan(), suite(), 'unknown'));
  invalid(() => validateProjectEvaluationPartitionPlan({ ...plan(), schemaVersion: 2 }, suite()));
  invalid(() => projectEvaluationPartitionSummary({ ...plan(), planHash: '0'.repeat(64) }));
});

test('ledger distinguishes successful requests, host quality stages, confirmation and deterministic cost', () => {
  const result = createProjectEvaluationPhaseLedger({ plan: plan(), requests: [receipt('author1', 'proposal:1', 20), receipt('repair1', 'script-repair:1', 30), receipt('select-b', 'baseline:empty'), receipt('select-c', 'candidate:empty'), receipt('select-j', 'judge:empty'), receipt('confirm-b', 'baseline:evidence'), receipt('confirm-c', 'candidate:evidence'), receipt('confirm-j', 'judge:evidence')], stages: [{ phase: 'author', status: 'passed' }, { phase: 'preflight', status: 'passed' }, { phase: 'deterministic', status: 'passed' }, { phase: 'paired', status: 'passed' }, { phase: 'confirmation', status: 'failed', reason: 'minimum_improvement_not_met' }] });
  assert.equal(result.requestCount, 8); assert.equal(result.usage.totalTokens, 110); assert.equal(result.qualityClaim, 'none');
  assert.equal(result.phases.find(row => row.phase === 'author').usage.totalTokens, 50);
  assert.equal(result.phases.find(row => row.phase === 'paired').usage.totalTokens, 30);
  assert.equal(result.phases.find(row => row.phase === 'confirmation').status, 'failed');
  assert.equal(result.phases.find(row => row.phase === 'confirmation').completedRequests, 3);
  assert.equal(result.phases.find(row => row.phase === 'deterministic').usage.totalTokens, 0);
});

test('ledger never infers a passed evaluation from a completed model request or missing confirmation', () => {
  const result = createProjectEvaluationPhaseLedger({ plan: createProjectEvaluationPartitionPlan({ suite: suite(), frozenAt }), requests: [receipt('one', 'baseline:empty')] });
  assert.equal(result.phases.find(row => row.phase === 'paired').status, 'observed_requests');
  assert.equal(result.phases.find(row => row.phase === 'confirmation').status, 'not_applicable');
  assert.equal(result.phases.find(row => row.phase === 'author').status, 'not_started');
});

test('ledger counts identical retry receipts once, rejects conflicting receipts and preserves unclassified usage', () => {
  const row = receipt('same-id', 'proposal:1', 10);
  const result = createProjectEvaluationPhaseLedger({ requests: [row, structuredClone(row), receipt('unknown', 'future-phase', 20)] });
  assert.equal(result.requestCount, 2); assert.equal(result.usage.totalTokens, 30); assert.equal(result.unmatched.usage.totalTokens, 20);
  invalid(() => createProjectEvaluationPhaseLedger({ requests: [row, { ...row, completed: false }] }));
});

test('ledger cancellation-before-send records zero dispatch and phase failure independently of billing', () => {
  const cancelled = { ...receipt('cancelled', 'proposal:1', 2), requestStarted: false, completed: false, usage: {} };
  const unknownBill = { ...receipt('unknown-bill', 'proposal:2', 100), completed: false, usage: { estimatedTokens: 100, totalTokens: 100 } };
  const result = createProjectEvaluationPhaseLedger({ requests: [cancelled, unknownBill], stages: [{ phase: 'author', status: 'interrupted', reason: 'cancelled' }] });
  const author = result.phases.find(row => row.phase === 'author');
  assert.equal(author.requests, 2); assert.equal(author.startedRequests, 1); assert.equal(author.completedRequests, 0);
  assert.equal(author.usage.estimatedTokens, 100); assert.equal(author.status, 'interrupted');
});

test('malformed usage, duplicate stages and overlarge accounting inputs cannot produce a ledger', () => {
  for (const amount of [-1, NaN, Infinity, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) invalid(() => createProjectEvaluationPhaseLedger({ requests: [{ ...receipt('one', 'proposal:1'), usage: { totalTokens: amount } }] }));
  for (const stages of [[{ phase: 'bogus', status: 'passed' }], [{ phase: 'paired', status: 'done' }], [{ phase: 'paired', status: 'passed' }, { phase: 'paired', status: 'failed' }]]) invalid(() => createProjectEvaluationPhaseLedger({ stages }));
  invalid(() => createProjectEvaluationPhaseLedger({ requests: Array.from({ length: 10001 }, (_, index) => receipt(String(index), 'proposal:1')) }));
});

const candidateHash = digest({ systemPrompt: 'candidate' });
const claimedAt = '2026-09-27T01:00:01.000Z';
const settledAt = '2026-09-27T01:10:00.000Z';
const reserve = (frozen = plan(), existingClaims = []) => createProjectEvaluationConfirmationClaim({ plan: frozen, candidateHash, claimedAt, existingClaims });

test('one-shot confirmation claim binds candidate, full suite, plan and data identity before execution', () => {
  const frozen = plan(), claim = reserve(frozen);
  assert.equal(claim.status, 'claimed'); assert.equal(claim.planHash, frozen.planHash); assert.equal(claim.suiteHash, frozen.suiteHash);
  assert.equal(claim.confirmationDataHash, frozen.confirmation.dataHash); assert.equal(claim.candidateHash, candidateHash);
  const { claimHash, ...contents } = claim; assert.equal(claimHash, digest(contents));
  assert.throws(() => { claim.candidateHash = '0'.repeat(64); }, TypeError);
});

test('a consumed claim blocks both the same candidate and another candidate even before settlement', () => {
  const frozen = plan(), claim = reserve(frozen);
  for (const nextCandidate of [candidateHash, digest({ systemPrompt: 'different' })]) assert.throws(() => createProjectEvaluationConfirmationClaim({ plan: frozen, candidateHash: nextCandidate, existingClaims: [JSON.parse(JSON.stringify(claim))], claimedAt }), error => error.code === 'evaluation_confirmation_consumed');
});

test('failure, success and interruption never release a reserved confirmation set', () => {
  const frozen = plan();
  for (const status of ['failed', 'passed', 'interrupted']) {
    const settled = settleProjectEvaluationConfirmationClaim(reserve(frozen), { status, settledAt, resultHash: digest({ result: status }), reason: status === 'passed' ? null : 'host_observed_failure' });
    assert.equal(settled.status, status);
    assert.throws(() => reserve(frozen, [settled]), error => error.code === 'evaluation_confirmation_consumed');
  }
});

test('recreated plans, new review labels, case renames and weights cannot recycle confirmation data', () => {
  const original = reserve();
  const source = suite(); source.cases[2].id = 'fresh_label'; source.cases[2].weight = 2;
  const renamed = assignments().map(row => row.caseId === 'evidence' ? { ...row, caseId: 'fresh_label' } : row);
  const frozen = createProjectEvaluationPartitionPlan({ suite: source, assignments: renamed, frozenAt: '2026-09-27T01:00:00.999Z', confirmationProvenance: { ...provenance(), version: 'renamed', reviewId: 'second-review', sourceHash: digest([source.cases[2]]) } });
  assert.notEqual(frozen.planHash, original.planHash); assert.notEqual(frozen.suiteHash, original.suiteHash);
  assert.equal(frozen.confirmation.dataHash, original.confirmationDataHash);
  assert.throws(() => reserve(frozen, [original]), error => error.code === 'evaluation_confirmation_consumed');
});

test('adding fresh tasks around consumed confirmation data does not make the old task reusable', () => {
  const original = reserve(), source = suite(); source.cases.push({ ...structuredClone(source.cases[2]), id: 'new_task', input: 'A fresh independently reviewed task.' });
  const frozen = createProjectEvaluationPartitionPlan({ suite: source, assignments: [...assignments(), { caseId: 'new_task', partition: 'confirmation' }], confirmationProvenance: { ...provenance(), sourceHash: digest(source.cases.slice(2)) }, frozenAt });
  assert.notEqual(frozen.confirmation.dataHash, original.confirmationDataHash);
  assert.throws(() => reserve(frozen, [original]), error => error.code === 'evaluation_confirmation_consumed');
});

test('changed private answer checks cannot disguise an already consumed task', () => {
  const original = reserve(), source = suite(); source.cases[2].requiredTerms = ['different-oracle']; source.cases[2].forbiddenTerms.push('extra');
  const frozen = plan(source);
  assert.notEqual(frozen.suiteHash, original.suiteHash); assert.equal(frozen.confirmation.dataHash, original.confirmationDataHash);
  assert.throws(() => reserve(frozen, [original]), error => error.code === 'evaluation_confirmation_consumed');
  source.cases[2].input = source.cases[0].input;
  invalid(() => plan(source));
});

test('terminal settlements are byte-identity idempotent but cannot be revised from failure to success', () => {
  const claim = reserve(), input = { status: 'failed', settledAt, resultHash: digest({ result: 'below-gate' }), reason: 'no_improvement' };
  const settled = settleProjectEvaluationConfirmationClaim(claim, input);
  assert.deepEqual(settleProjectEvaluationConfirmationClaim(settled, input), settled);
  assert.throws(() => settleProjectEvaluationConfirmationClaim(settled, { ...input, status: 'passed' }), error => error.code === 'evaluation_confirmation_settled');
  assert.throws(() => settleProjectEvaluationConfirmationClaim(settled, { ...input, reason: 'new_narrative' }), error => error.code === 'evaluation_confirmation_settled');
});

test('a newly reviewed different task can be reserved while preserving the complete old claim history', () => {
  const original = reserve(), source = suite(); source.cases[2].input = '独立新任务：请给出另一个问题的可验证交付步骤。';
  const next = plan(source), claim = reserve(next, [original]);
  assert.notEqual(claim.confirmationDataHash, original.confirmationDataHash); assert.equal(claim.status, 'claimed');
});

test('claims reject unavailable confirmation, forged receipts, invalid outcomes and settlement before reservation', () => {
  assert.throws(() => reserve(createProjectEvaluationPartitionPlan({ suite: suite(), frozenAt })), error => error.code === 'evaluation_confirmation_unavailable');
  invalid(() => createProjectEvaluationConfirmationClaim({ plan: plan(), candidateHash: 'bad', claimedAt }));
  invalid(() => createProjectEvaluationConfirmationClaim({ plan: plan(), candidateHash, claimedAt: '2026-09-26T01:00:00.000Z' }));
  invalid(() => reserve(plan(), [{ ...reserve(), candidateHash: '0'.repeat(64) }]));
  for (const status of ['passed', 'claimed', 'unknown']) invalid(() => settleProjectEvaluationConfirmationClaim(reserve(), { status, settledAt }));
  invalid(() => settleProjectEvaluationConfirmationClaim(reserve(), { status: 'failed', settledAt: frozenAt }));
  const forged = settleProjectEvaluationConfirmationClaim(reserve(), { status: 'failed', settledAt });
  invalid(() => reserve(plan(), [{ ...forged, reason: 'changed-after-settlement' }]));
});

test('legacy confirmation cannot receive a passed, failed or interrupted execution phase', () => {
  const frozen = createProjectEvaluationPartitionPlan({ suite: suite(), frozenAt });
  for (const status of ['passed', 'failed', 'interrupted']) invalid(() => createProjectEvaluationPhaseLedger({ plan: frozen, stages: [{ phase: 'confirmation', status }] }));
});

test('serialized claim validation binds its complete receipt to the expected plan and candidate', () => {
  const frozen = plan(), original = reserve(frozen), restored = validateProjectEvaluationConfirmationClaim(JSON.parse(JSON.stringify(original)), { plan: frozen, candidateHash });
  assert.deepEqual(restored, original); assert.notEqual(restored, original); assert.ok(Object.isFrozen(restored));
  invalid(() => validateProjectEvaluationConfirmationClaim({ ...original, claimHash: '0'.repeat(64) }, { plan: frozen, candidateHash }));
  assert.throws(() => validateProjectEvaluationConfirmationClaim(original, { plan: frozen, candidateHash: '0'.repeat(64) }), error => error.code === 'evaluation_confirmation_claim_invalid');
  const source = suite(); source.cases[2].input += ' genuinely different source';
  assert.throws(() => validateProjectEvaluationConfirmationClaim(original, { plan: plan(source), candidateHash }), error => error.code === 'evaluation_confirmation_claim_invalid');
});

test('string-like arrays cannot stand in for trusted identifiers and hashes', () => {
  invalid(() => createProjectEvaluationPartitionPlan({ suite: { ...suite(), cases: [{ ...suite().cases[0], id: ['prototype'] }] }, frozenAt }));
  invalid(() => createProjectEvaluationConfirmationClaim({ plan: plan(), candidateHash: [candidateHash], claimedAt }));
  invalid(() => settleProjectEvaluationConfirmationClaim(reserve(), { status: 'passed', settledAt, resultHash: [candidateHash] }));
  invalid(() => createProjectEvaluationPhaseLedger({ plan: { ...plan(), assignments: null } }));
});
