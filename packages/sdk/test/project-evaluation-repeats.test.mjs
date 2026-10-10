import test from 'node:test';
import assert from 'node:assert/strict';
import { evolutionHash as hash } from '../src/evolution.mjs';
import { createProjectEvaluationPartitionPlan, createProjectEvaluationConfirmationClaim, settleProjectEvaluationConfirmationClaim } from '../src/project-evaluation-partitions.mjs';
import { createProjectEvaluationRepeatPlan, validateProjectEvaluationRepeatPlan, summarizeProjectEvaluationRepeats } from '../src/project-evaluation-repeats.mjs';
import { evaluateProjectGenomes, PROJECT_EVALUATION_RUNTIME_HASH } from '../src/project-evolution.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from './fixtures/project-genome.mjs';

const model = { providerId: 'local-fixture', modelId: 'fixture', execution: 'rna', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 128000, maxOutputTokens: 4000, reasoning: 'off' };
function fixture(repeatCount = 2) {
  const baseline = projectGenomeFixture(), candidate = projectGenomeFixture({ candidate: true }), suite = baseline.evaluationSuite;
  const partitionPlan = createProjectEvaluationPartitionPlan({ suite, frozenAt: '2026-09-27T00:00:00.000Z', assignments: suite.cases.map((row, index) => ({ caseId: row.id, partition: ['development', 'selection', 'confirmation'][index] })), confirmationProvenance: { datasetId: 'repeat-contract', version: 'v1', reviewId: 'host-review', reviewedAt: '2026-09-26T00:00:00.000Z', sourceHash: hash([suite.cases[2]]), authorship: 'independent_host_review', exposure: 'withheld' } });
  const bindings = { suite, partitionPlan, baselineHash: hash(baseline), modelHash: hash(model), evaluationRuntimeHash: PROJECT_EVALUATION_RUNTIME_HASH };
  const repeatPlan = createProjectEvaluationRepeatPlan({ ...bindings, repeatCount, seed: '1'.repeat(64), frozenAt: '2026-09-27T00:00:00.000Z' });
  return { baseline, candidate, suite, partitionPlan, bindings, repeatPlan };
}
const rowsFor = (f, candidateScores = [.8, .9]) => f.repeatPlan.trials.map((trial, index) => ({ id: trial.id, caseId: trial.caseId, repeatIndex: trial.repeatIndex, partition: 'selection', weight: 1, baselineScore: .5, candidateScore: candidateScores[index], baseline: { passed: true, usage: { totalTokens: 100 } }, candidate: { passed: true, usage: { totalTokens: 100 } } }));
const summary = (f, rows) => summarizeProjectEvaluationRepeats({ ...f.bindings, repeatPlan: f.repeatPlan, rows });

test('fixed repeat plan binds all identities and counterbalances without exposing or repeating confirmation', () => {
  const f = fixture(), p = f.repeatPlan;
  assert.deepEqual(p.trials.map(row => row.caseId), ['case_2', 'case_2']);
  assert.notDeepEqual(p.trials[0].runOrder, p.trials[1].runOrder);
  assert.notEqual(p.trials[0].assignment, p.trials[1].assignment);
  assert.deepEqual(validateProjectEvaluationRepeatPlan(JSON.parse(JSON.stringify(p)), f.bindings), p);
  for (const key of ['baselineHash', 'modelHash', 'evaluationRuntimeHash']) assert.throws(() => validateProjectEvaluationRepeatPlan(p, { ...f.bindings, [key]: '0'.repeat(64) }), { code: 'invalid_evaluation_repeat' });
  for (const change of [q => q.repeatCount++, q => q.trials.reverse(), q => q.trials[0].assignment = q.trials[1].assignment, q => q.seed = '2'.repeat(64), q => q.frozenAt = '2026-09-28T00:00:01.000Z', q => q.extra = true]) {
    const q = structuredClone(p); change(q); assert.throws(() => validateProjectEvaluationRepeatPlan(q, f.bindings), { code: 'invalid_evaluation_repeat' });
  }
  for (const repeatCount of [0, 1, 4, 2.5]) assert.throws(() => createProjectEvaluationRepeatPlan({ ...f.bindings, repeatCount, seed: '1'.repeat(64) }), { code: 'invalid_evaluation_repeat' });
  assert.throws(() => { p.trials[0].runOrder.reverse(); }, TypeError);
});

test('all slots contribute paired descriptive variance, actual cost and worst regression', () => {
  const f = fixture(), result = summary(f, rowsFor(f));
  assert.equal(result.complete, true); assert.equal(result.gatePassed, true);
  assert.ok(Math.abs(result.pairedImprovement.mean - .35) < 1e-12);
  assert.ok(Math.abs(result.pairedImprovement.sampleVariance - .005) < 1e-12);
  assert.equal(result.cost.candidateTokens, 200); assert.equal(result.worstRegression, 0);
  assert.equal(result.nullNoiseCalibration, 'not_measured'); assert.equal(result.statisticalClaim, 'descriptive_only');
});

test('one excellent round cannot average away original minimum/improvement/token gates or regression', () => {
  const f = fixture();
  for (const candidateScores of [[1, .65], [1, .55], [1, .45]]) {
    const result = summary(f, rowsFor(f, candidateScores));
    assert.equal(result.gates.improvement, true); assert.equal(result.gates.repeatConsistency, false); assert.equal(result.gatePassed, false);
  }
  const rows = rowsFor(f); rows[0].candidate.usage.totalTokens = 300; rows[1].candidate.usage.totalTokens = 1;
  const result = summary(f, rows); assert.equal(result.gates.tokenRatio, true); assert.equal(result.gates.repeatConsistency, false); assert.equal(result.gatePassed, false);
});

test('missing, duplicate, foreign or retagged trials cannot yield a selected best-run score', () => {
  const f = fixture(), rows = rowsFor(f);
  for (const partial of [[], [rows[1]]]) { const result = summary(f, partial); assert.equal(result.complete, false); assert.equal(result.gatePassed, false); assert.equal(result.candidateScore, null); }
  for (const mutate of [items => items[1] = items[0], items => items[1].id = 'foreign', items => items[1].caseId = 'case_1', items => items[1].repeatIndex = 1, items => items[1].weight = 10, items => items[1].candidateScore = NaN, items => delete items[1].candidate.usage]) {
    const changed = structuredClone(rows); mutate(changed); assert.throws(() => summary(f, changed), { code: 'invalid_evaluation_repeat' });
  }
});

test('SDK executes fresh fixed repetitions and only then claims one confirmation; cost and exposure remain trial-local', async () => {
  const f = fixture(), calls = [], claims = [], settled = [], admissions = [];
  const result = await evaluateProjectGenomes({ ...f, model, provider: genomeEvaluationProvider({ calls }), requestControl: { beforeRequest: row => admissions.push(row) },
    claimConfirmation(input) { assert.equal(calls.length, 10); const value = createProjectEvaluationConfirmationClaim({ ...input, existingClaims: claims }); claims.push(value); return value; },
    settleConfirmation(claim, outcome) { settled.push(settleProjectEvaluationConfirmationClaim(claim, outcome)); },
  });
  assert.equal(calls.length, 15); assert.equal(claims.length, 1); assert.equal(settled.length, 1); assert.equal(settled[0].status, 'passed');
  assert.equal(result.gatePassed, true); assert.equal(result.selection.complete, true); assert.equal(result.selection.cases, 2);
  assert.equal(result.confirmation.cases, 1); assert.equal(result.exposure.expectedCases, 3); assert.equal(result.exposure.observedCases, 3);
  assert.deepEqual(result.details.slice(0, 2).map(row => [row.baseline.usage.totalTokens, row.candidate.usage.totalTokens]), [[60, 60], [60, 60]]);
  assert.equal(result.usage.totalTokens, 450); assert.equal(result.phaseLedger.phases.find(row => row.phase === 'paired').requests, 10); assert.equal(result.phaseLedger.phases.find(row => row.phase === 'confirmation').requests, 5);
  assert.equal(result.requests.filter(row => row.evaluationRepeat).length, 10); assert.equal(admissions.filter(row => row.evaluationRepeat).length, 10);
  for (const [index, trial] of f.repeatPlan.trials.entries()) {
    const turn = calls.slice(index * 5, index * 5 + 5); assert.equal(turn[0].systemPrompt.includes('CANDIDATE_AGENT'), trial.runOrder[0] === 'candidate');
    assert.equal(turn[0].messages.filter(row => row.role === 'user').length, 1); assert.equal(result.details[index].judgment.assignment, trial.assignment);
  }
  const judgeText = calls.filter(row => row.systemPrompt.includes('blind evaluator')).map(row => JSON.stringify(row.messages)).join('\n');
  assert.ok(!judgeText.includes(f.repeatPlan.planHash)); assert.ok(!judgeText.includes('repeatIndex'));
  await assert.rejects(evaluateProjectGenomes({ ...f, model, provider: genomeEvaluationProvider(), claimConfirmation: input => createProjectEvaluationConfirmationClaim({ ...input, existingClaims: settled }), settleConfirmation() {} }), { code: 'evaluation_confirmation_consumed' });
});

test('fixed repetitions finish despite a scored loss; no early success or new confirmation when any repeat fails', async () => {
  const f = fixture(), ordinary = genomeEvaluationProvider(), calls = []; let judges = 0, claims = 0;
  const result = await evaluateProjectGenomes({ ...f, model, claimConfirmation() { claims++; }, settleConfirmation() {}, provider: async function* (request) {
    calls.push(request);
    if (request.systemPrompt.includes('blind evaluator') && ++judges === 2) {
      yield { type: 'tool_call', id: 'bad-second', name: request.tools[0].name, arguments: { ratings: [{ criterionId: 'evidence', left: .5, right: .5, reason: 'Second independent run did not improve.' }] } };
      yield { type: 'usage', usage: { totalTokens: 30 } }; yield { type: 'done', stopReason: 'toolUse' }; return;
    }
    yield* ordinary(request);
  } });
  assert.equal(calls.length, 10); assert.equal(judges, 2); assert.equal(claims, 0); assert.equal(result.selection.complete, true); assert.equal(result.selection.gatePassed, false); assert.equal(result.confirmation.status, 'skipped');
});

test('second repeat interruption preserves actual costs and incomplete evidence, without a score or confirmation', async () => {
  const f = fixture(), calls = []; let claims = 0;
  await assert.rejects(evaluateProjectGenomes({ ...f, model, provider: genomeEvaluationProvider({ calls }), claimConfirmation() { claims++; }, settleConfirmation() {}, requestControl: { beforeRequest() { if (calls.length >= 6) throw Object.assign(new Error('bounded budget'), { code: 'budget_exhausted' }); } } }), failure => {
    assert.equal(failure.code, 'budget_exhausted'); assert.equal(failure.requests.length, 6); assert.equal(failure.usage.totalTokens, 180);
    assert.equal(failure.evaluationEvidence.selection.complete, false); assert.equal(failure.evaluationEvidence.selection.candidateScore, null);
    assert.equal(failure.evaluationEvidence.repeatPlan.planHash, f.repeatPlan.planHash); assert.equal(failure.evaluationEvidence.inFlightCase.repeatIndex, 2);
    return true;
  });
  assert.equal(calls.length, 6); assert.equal(claims, 0);
});

test('mismatched repeat identity rejects before model admission or confirmation', async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(evaluateProjectGenomes({ ...f, model: { ...model, reasoning: 'low' }, provider: async function* () { calls++; } }), { code: 'invalid_evaluation_repeat' });
  assert.equal(calls, 0);
});

test('three frozen repeats continue after an early scored failure and retain it rather than choosing the last successes', async () => {
  const f = fixture(3), ordinary = genomeEvaluationProvider(), calls = []; let judges = 0;
  const result = await evaluateProjectGenomes({ ...f, model, provider: async function* (request) {
    calls.push(request);
    if (request.systemPrompt.includes('blind evaluator') && ++judges === 1) {
      yield { type: 'tool_call', id: 'lost-first', name: request.tools[0].name, arguments: { ratings: [{ criterionId: 'evidence', left: .5, right: .5, reason: 'First run lacks observed improvement.' }] } };
      yield { type: 'usage', usage: { totalTokens: 30 } }; yield { type: 'done', stopReason: 'toolUse' }; return;
    }
    yield* ordinary(request);
  } });
  assert.equal(judges, 3); assert.equal(calls.length, 15); assert.equal(result.selection.observedTrials, 3);
  assert.deepEqual(result.selection.repeats.map(row => row.gatePassed), [false, true, true]);
  assert.equal(result.gatePassed, false); assert.equal(result.confirmation.status, 'skipped');
});

test('deterministic failure on a later repeat cannot become a best-run result or consume confirmation', async () => {
  const f = fixture(), ordinary = genomeEvaluationProvider(), bad = genomeEvaluationProvider({ badCandidate: true }), calls = []; let claims = 0;
  const result = await evaluateProjectGenomes({ ...f, model, claimConfirmation() { claims++; }, settleConfirmation() {}, provider: async function* (request) {
    const second = calls.length >= 5; calls.push(request); yield* (second ? bad : ordinary)(request);
  } });
  assert.equal(calls.length, 9); assert.equal(claims, 0); assert.equal(result.evaluationComplete, false);
  assert.equal(result.selection.complete, false); assert.equal(result.selection.candidateScore, null);
  assert.equal(result.details.at(-1).repeatIndex, 2); assert.equal(result.details.at(-1).judgmentSkipped, true);
  assert.equal(result.usage.totalTokens, 270); assert.equal(result.confirmation.status, 'skipped');
  assert.equal(result.phaseLedger.phases.find(row => row.phase === 'confirmation').status, 'skipped');
});

test('opt-in conversation semantics reach every repeated judge with real turn identities and no extra judge calls', async () => {
  const f = fixture();
  for (const genome of [f.baseline, f.candidate]) { genome.evaluationSuite.cases[1].followUps = [{ input: 'Explain the same evidence, without claiming additional execution.' }]; genome.evaluationSuite.cases[1].reviewConversation = true; }
  f.partitionPlan = createProjectEvaluationPartitionPlan({ suite: f.suite, frozenAt: f.partitionPlan.frozenAt, assignments: f.partitionPlan.assignments.map(({ caseHash, ...row }) => row), confirmationProvenance: f.partitionPlan.confirmation.provenance });
  f.repeatPlan = createProjectEvaluationRepeatPlan({ ...f.bindings, suite: f.suite, partitionPlan: f.partitionPlan, baselineHash: hash(f.baseline), seed: '1'.repeat(64), frozenAt: f.partitionPlan.frozenAt });
  const calls = [], ordinary = genomeEvaluationProvider();
  const result = await evaluateProjectGenomes({ ...f, model, provider: async function* (request) {
    calls.push(request);
    for await (const event of ordinary(request)) {
      if (request.systemPrompt.includes('blind evaluator') && event.type === 'tool_call') {
        const input = JSON.parse(request.messages[0].content[0].text), evidence = input.hostContext.conversationEvidence;
        if (evidence) {
          assert.ok(request.tools[0].parameters.required.includes('conversationReview'));
          assert.match(request.systemPrompt, /A later correction does not erase an earlier mistake/);
          event.arguments.conversationReview = Object.fromEntries(['left', 'right'].map(side => [side, { coverage: 'complete', limitations: 'Bounded fixture assessment, not verified truth.', turns: evidence.sides[side].turns.map(turn => ({ turn: turn.turn, answerId: turn.answerId, assessment: 'no_material_issue_found', reason: 'Actual supplied answer remains within the task evidence.', issues: [] })) }]));
        }
      }
      yield event;
    }
  }, claimConfirmation: input => createProjectEvaluationConfirmationClaim(input), settleConfirmation() {} });
  assert.equal(calls.filter(row => row.systemPrompt.includes('blind evaluator')).length, 3);
  assert.equal(result.coverage.conversationReviewedCases, 2);
  assert.equal(result.coverage.plannedMeasurements, 3); assert.equal(result.coverage.selectionRepeats, 2);
  for (const row of result.details.slice(0, 2)) {
    assert.equal(row.judgment.conversationReview.left.turns.length, 2); assert.equal(row.judgment.evidence.conversation.turns, 2);
    assert.equal(row.judgment.evidence.conversation.scope, 'host_text_identity_verified_semantics_model_assessed');
    assert.equal(row.judgment.evidence.conversation.units, undefined);
    assert.equal(row.baseline.turns.reduce((sum, turn) => sum + turn.usage.totalTokens, 0), row.baseline.usage.totalTokens);
  }
});
