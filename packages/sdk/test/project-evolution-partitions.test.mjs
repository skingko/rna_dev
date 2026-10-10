import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evolutionHash as digest } from '../src/evolution.mjs';
import { evaluateProjectGenomes } from '../src/project-evolution.mjs';
import { createProjectEvaluationPartitionPlan, createProjectEvaluationConfirmationClaim, settleProjectEvaluationConfirmationClaim } from '../src/project-evaluation-partitions.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from './fixtures/project-genome.mjs';

const model = { providerId: 'local-fixture', modelId: 'fixture', execution: 'rna', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 128000, maxOutputTokens: 4000, reasoning: 'off' };
const baseline = () => projectGenomeFixture();
const candidate = () => projectGenomeFixture({ candidate: true });
function plan(source = baseline()) {
  const suite = source.evaluationSuite;
  return createProjectEvaluationPartitionPlan({ suite, frozenAt: '2026-09-27T01:00:00.000Z', assignments: [
    { caseId: 'case_1', partition: 'development', taskFamily: 'evidence' },
    { caseId: 'case_2', partition: 'selection', taskFamily: 'evidence' },
    { caseId: 'case_3', partition: 'confirmation', taskFamily: 'evidence' },
  ], confirmationProvenance: { datasetId: 'reviewed-evidence', version: 'v1', reviewId: 'independent-review', reviewedAt: '2026-09-26T01:00:00.000Z', sourceHash: digest([suite.cases[2]]), authorship: 'independent_host_review', exposure: 'withheld' } });
}
function callbacks(existing = []) {
  const claims = existing, settlements = [];
  return { claims, settlements,
    async claimConfirmation({ plan, candidateHash }) {
      const claim = createProjectEvaluationConfirmationClaim({ plan, candidateHash, existingClaims: claims });
      claims.push(claim); return claim;
    },
    async settleConfirmation(claim, outcome) {
      const settled = settleProjectEvaluationConfirmationClaim(claim, outcome);
      const index = claims.findIndex(row => row.claimHash === claim.claimHash); assert.ok(index >= 0); claims[index] = settled; settlements.push(settled);
    },
  };
}
function fixtureProvider({ calls = [], selectionFailure = false, confirmationFailure = false, confirmationError = false, confirmationDeterministicFailure = false, beforeConfirmation } = {}) {
  const ordinary = genomeEvaluationProvider(), invalidCandidate = genomeEvaluationProvider({ badCandidate: true });
  return async function* (request) {
    const judge = request.systemPrompt.includes('blind evaluator');
    const task = judge ? JSON.parse(request.messages[0].content[0].text).task : request.messages.find(row => row.role === 'user')?.content?.find(row => row.type === 'text')?.text;
    const isConfirmation = task?.includes('input 3');
    calls.push({ task, judge, candidate: request.systemPrompt.includes('CANDIDATE_AGENT') });
    if (isConfirmation) await beforeConfirmation?.();
    if (isConfirmation && confirmationError) { yield { type: 'usage', usage: { input: 11, output: 6, totalTokens: 17 } }; throw Object.assign(new Error('isolated fixture transport interruption'), { code: 'fixture_transport_failed' }); }
    if (judge && (isConfirmation ? confirmationFailure : selectionFailure)) {
      const input = JSON.parse(request.messages[0].content[0].text), scores = isConfirmation ? { candidate: .7, baseline: .9 } : { candidate: .5, baseline: .5 };
      const ratings = { ratings: input.criteria.map(row => ({ criterionId: row.id, left: input.left.answer.includes('precise') ? scores.candidate : scores.baseline, right: input.right.answer.includes('precise') ? scores.candidate : scores.baseline, reason: 'Bounded fixture rating of the retained execution.' })) };
      if (request.tools?.[0]?.name === 'submit_evaluation_ratings') { yield { type: 'tool_call', id: `rating-${calls.length}`, name: request.tools[0].name, arguments: ratings }; yield { type: 'usage', usage: { input: 20, output: 10, totalTokens: 30 } }; yield { type: 'done', stopReason: 'toolUse' }; }
      else { yield { type: 'text_delta', delta: JSON.stringify(ratings) }; yield { type: 'usage', usage: { input: 20, output: 10, totalTokens: 30 } }; yield { type: 'done', stopReason: 'stop' }; }
      return;
    }
    yield* (isConfirmation && confirmationDeterministicFailure ? invalidCandidate : ordinary)(request);
  };
}

test('selection passes before durable confirmation admission, then separate cases score under the same frozen contract', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rna-partition-claim-')); t.after(() => rm(root, { recursive: true, force: true }));
  const claims = callbacks(), calls = [], claimFile = join(root, 'claim.json'); let persisted = false;
  const result = await evaluateProjectGenomes({ baseline: baseline(), candidate: candidate(), model, partitionPlan: plan(),
    ...claims,
    async claimConfirmation(input) { assert.equal(calls.length, 5); assert.ok(calls.every(row => row.task.includes('input 2'))); const receipt = await claims.claimConfirmation(input); await writeFile(claimFile, JSON.stringify(receipt)); persisted = true; return receipt; },
    provider: fixtureProvider({ calls, beforeConfirmation: async () => { assert.equal(persisted, true); const receipt = JSON.parse(await readFile(claimFile, 'utf8')); assert.equal(receipt.status, 'claimed'); assert.equal(receipt.candidateHash, digest(candidate())); } }),
  });
  assert.equal(result.selection.gatePassed, true); assert.equal(result.confirmation.status, 'passed'); assert.equal(result.gatePassed, true);
  assert.equal(result.details.length, 2); assert.deepEqual(result.details.map(row => row.partition), ['selection', 'confirmation']);
  assert.equal(result.usage.totalTokens, 300); assert.equal(calls.length, 10); assert.equal(claims.claims.length, 1); assert.equal(claims.settlements.length, 1);
  assert.equal(claims.settlements[0].status, 'passed'); assert.equal(claims.settlements[0].resultHash, digest(result));
});

test('selection gate failure prevents confirmation reservation and all confirmation model requests', async () => {
  const calls = [], claims = callbacks();
  const result = await evaluateProjectGenomes({ baseline: baseline(), candidate: candidate(), model, partitionPlan: plan(), ...claims, provider: fixtureProvider({ calls, selectionFailure: true }) });
  assert.equal(result.gatePassed, false); assert.equal(result.selection.gatePassed, false); assert.equal(result.confirmation.status, 'skipped');
  assert.equal(result.confirmation.reason, 'selection_gates_failed'); assert.equal(result.confirmation.passed, null);
  assert.equal(calls.length, 5); assert.equal(claims.claims.length, 0); assert.equal(claims.settlements.length, 0); assert.ok(calls.every(row => row.task.includes('input 2')));
  assert.equal(result.usage.totalTokens, 150);
});

test('confirmation regression rejects a selected candidate rather than averaging away its failure', async () => {
  const calls = [], claims = callbacks();
  const result = await evaluateProjectGenomes({ baseline: baseline(), candidate: candidate(), model, partitionPlan: plan(), ...claims, provider: fixtureProvider({ calls, confirmationFailure: true }) });
  assert.equal(result.selection.candidateScore, .9); assert.equal(result.selection.baselineScore, .5); assert.equal(result.selection.gatePassed, true);
  assert.equal(result.confirmation.candidateScore, .7); assert.equal(result.confirmation.baselineScore, .9); assert.equal(result.confirmation.gates.noRegression, false);
  assert.equal(result.candidateScore, .9, 'Top-level score identifies the selection comparison, not an averaged value');
  assert.equal(result.confirmation.status, 'failed'); assert.equal(result.gates.confirmation, false); assert.equal(result.gatePassed, false);
  assert.equal(claims.settlements[0].status, 'failed'); assert.equal(result.usage.totalTokens, 300);
});

test('development cases never trigger paired execution or provider requests', async () => {
  const original = baseline(), next = candidate();
  original.evaluationSuite.cases[0].input = 'PRIVATE_DEVELOPMENT_TASK_NEVER_EXECUTE';
  const calls = [];
  const result = await evaluateProjectGenomes({ baseline: original, candidate: next, model, partitionPlan: plan(original), ...callbacks(), provider: fixtureProvider({ calls }) });
  assert.equal(calls.length, 10); assert.equal(calls.some(row => row.task.includes('PRIVATE_DEVELOPMENT_TASK_NEVER_EXECUTE')), false);
  assert.deepEqual(result.details.map(row => row.id), ['case_2', 'case_3']); assert.equal(result.partitionSummary.counts.development, 1);
});

test('missing durable callbacks rejects confirmation after selection without a confirmation request', async () => {
  const calls = [];
  await assert.rejects(evaluateProjectGenomes({ baseline: baseline(), candidate: candidate(), model, partitionPlan: plan(), provider: fixtureProvider({ calls }) }), error => {
    assert.equal(error.code, 'evaluation_confirmation_claim_required'); assert.equal(error.usage.totalTokens, 150); assert.equal(error.evaluationEvidence.selection.gatePassed, true); return true;
  });
  assert.equal(calls.length, 5); assert.ok(calls.every(row => row.task.includes('input 2')));
});

test('already consumed confirmation rejects a new evaluation without replaying any confirmation request', async () => {
  const consumed = createProjectEvaluationConfirmationClaim({ plan: plan(), candidateHash: digest(candidate()) }), claims = callbacks([consumed]), calls = [];
  await assert.rejects(evaluateProjectGenomes({ baseline: baseline(), candidate: candidate(), model, partitionPlan: plan(), ...claims, provider: fixtureProvider({ calls }) }), error => {
    assert.equal(error.code, 'evaluation_confirmation_consumed'); assert.equal(error.requests.length, 5); assert.equal(error.usage.totalTokens, 150); return true;
  });
  assert.equal(calls.length, 5); assert.equal(claims.claims.length, 1); assert.equal(claims.settlements.length, 0);
});

test('confirmation transport interruption preserves selection, partial cost and a consumed interrupted claim', async () => {
  const calls = [], claims = callbacks();
  await assert.rejects(evaluateProjectGenomes({ baseline: baseline(), candidate: candidate(), model, partitionPlan: plan(), ...claims, provider: fixtureProvider({ calls, confirmationError: true }) }), error => {
    assert.equal(error.code, 'fixture_transport_failed'); assert.equal(error.usage.totalTokens, 167); assert.equal(error.requests.length, 6);
    assert.equal(error.evaluationEvidence.selection.gatePassed, true); assert.equal(error.evaluationEvidence.cases.length, 1); assert.equal(error.evaluationEvidence.inFlightCase.id, 'case_3');
    const ledger = error.evaluationEvidence.phaseLedger; assert.equal(ledger.usage.totalTokens, 167); assert.equal(ledger.phases.find(row => row.phase === 'confirmation').status, 'interrupted');
    assert.equal(ledger.phases.find(row => row.phase === 'paired').usage.totalTokens, 150); assert.equal(ledger.phases.find(row => row.phase === 'confirmation').usage.totalTokens, 17); return true;
  });
  assert.equal(calls.length, 6); assert.equal(claims.settlements.length, 1); assert.equal(claims.settlements[0].status, 'interrupted');
});

test('failed confirmation deterministic checks skip its judge and retain unscored execution evidence', async () => {
  const calls = [], claims = callbacks();
  const result = await evaluateProjectGenomes({ baseline: baseline(), candidate: candidate(), model, partitionPlan: plan(), ...claims, provider: fixtureProvider({ calls, confirmationDeterministicFailure: true }) });
  assert.equal(result.gatePassed, false); assert.equal(result.evaluationComplete, false); assert.equal(result.selection.gatePassed, true); assert.equal(result.confirmation.status, 'failed');
  assert.equal(result.earlyStopReason, 'candidate_deterministic_failed'); assert.equal(result.details.at(-1).judgmentSkipped, true); assert.equal(result.details.at(-1).candidateScore, null);
  assert.equal(calls.filter(row => row.task.includes('input 3') && row.judge).length, 0); assert.equal(result.usage.totalTokens, 270); assert.equal(claims.settlements[0].status, 'failed');
});

test('tampered frozen plan or changed suite is refused before provider dispatch or confirmation callbacks', async () => {
  for (const mode of ['changed-plan', 'changed-suite']) {
    const original = baseline(), frozen = structuredClone(plan(original)), calls = []; let claimCalls = 0;
    if (mode === 'changed-plan') frozen.assignments[0].partition = 'selection'; else original.evaluationSuite.thresholds.minScore = .5;
    await assert.rejects(evaluateProjectGenomes({ baseline: original, candidate: candidate(), model, partitionPlan: frozen, provider: fixtureProvider({ calls }), claimConfirmation: async () => { claimCalls++; }, settleConfirmation: async () => {} }), { code: 'invalid_evaluation_partition' });
    assert.equal(calls.length, 0); assert.equal(claimCalls, 0);
  }
});

test('default legacy comparison keeps all three cases, original gates and cost, with confirmation explicitly absent', async () => {
  const calls = [];
  const result = await evaluateProjectGenomes({ baseline: baseline(), candidate: candidate(), model, provider: fixtureProvider({ calls }) });
  assert.equal(result.gatePassed, true); assert.equal(result.baselineScore, .5); assert.equal(result.candidateScore, .9); assert.equal(result.cases, 3);
  assert.equal(result.usage.totalTokens, 450); assert.equal(calls.length, 15); assert.equal(result.confirmation.status, 'not_applicable'); assert.equal(result.confirmation.passed, null);
  assert.equal(Object.hasOwn(result.gates, 'confirmation'), false); assert.equal(result.phaseLedger.phases.find(row => row.phase === 'confirmation').status, 'not_applicable');
});

test('a corrupted claim cannot admit confirmation even when the shallow candidate and plan fields match', async () => {
  const calls = [];
  await assert.rejects(evaluateProjectGenomes({ baseline: baseline(), candidate: candidate(), model, partitionPlan: plan(), provider: fixtureProvider({ calls }),
    claimConfirmation: async input => ({ ...createProjectEvaluationConfirmationClaim(input), claimHash: '0'.repeat(64) }), settleConfirmation: async () => {},
  }), error => ['invalid_evaluation_partition', 'evaluation_confirmation_claim_invalid'].includes(error.code));
  assert.equal(calls.length, 5);
});

test('cancellation after persisted confirmation admission consumes its tasks without sending a confirmation request', async () => {
  const controller = new AbortController(), claims = callbacks(), calls = [];
  await assert.rejects(evaluateProjectGenomes({ baseline: baseline(), candidate: candidate(), model, partitionPlan: plan(), ...claims, signal: controller.signal, provider: fixtureProvider({ calls }),
    async claimConfirmation(input) { const claim = await claims.claimConfirmation(input); controller.abort(); return claim; },
  }), error => {
    assert.equal(error.name, 'AbortError', `${error.name}:${error.code}:${error.message}`); assert.equal(error.usage.totalTokens, 150); assert.equal(error.evaluationEvidence.selection.gatePassed, true);
    assert.ok(error.evaluationEvidence.phaseLedger.phases.every(row => row.status !== 'running'), 'A terminated evaluation cannot leave an active phase in its final ledger'); return true;
  });
  assert.equal(calls.length, 5); assert.equal(claims.settlements[0].status, 'interrupted');
});

test('failed durable settlement prevents a successful return and retains all measured confirmation cost', async () => {
  const claims = callbacks(), calls = [];
  await assert.rejects(evaluateProjectGenomes({ baseline: baseline(), candidate: candidate(), model, partitionPlan: plan(), ...claims, provider: fixtureProvider({ calls }),
    async settleConfirmation() { throw Object.assign(new Error('fixture storage commit unavailable'), { code: 'fixture_persist_failed' }); },
  }), error => {
    assert.equal(error.code, 'fixture_persist_failed'); assert.equal(error.usage.totalTokens, 300); assert.equal(error.requests.length, 10); assert.equal(error.evaluationEvidence.cases.length, 2); assert.equal(error.confirmationSettlementError, 'fixture_persist_failed'); return true;
  });
  assert.equal(calls.length, 10); assert.equal(claims.claims[0].status, 'claimed', 'An unknown settlement never frees the reserved task set');
});
