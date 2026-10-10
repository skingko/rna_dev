import test from 'node:test';
import assert from 'node:assert/strict';
import { executeProjectEvaluationCase } from '../src/index.mjs';
import { evolutionHash } from '../src/evolution.mjs';
import { scenarioGenomes, scenarioModel, scenarioProvider } from './fixtures/project-evaluation-scenarios.mjs';

test('unknown single-case identity is rejected before provider or request-admission work', async () => {
  let requests = 0, admissions = 0;
  await assert.rejects(executeProjectEvaluationCase({ genome: scenarioGenomes().baseline, caseId: 'not_registered', model: scenarioModel,
    provider: async function* () { requests++; }, requestControl: { beforeRequest() { admissions++; } },
  }), { code: 'evaluation_case_not_found' });
  assert.equal(requests, 0); assert.equal(admissions, 0);
});

test('single-case API executes actual tools once, meters requests and never issues a comparison or promotion decision', async () => {
  const calls = [], admissions = [], receipts = [], genome = scenarioGenomes().candidate;
  const execution = await executeProjectEvaluationCase({ genome, caseId: 'data', model: scenarioModel, provider: scenarioProvider({ calls }),
    requestControl: { beforeRequest: request => admissions.push(request), onUsage: receipt => receipts.push(receipt) },
  });
  assert.equal(execution.caseId, 'data'); assert.equal(execution.scope, 'single_case_execution_only'); assert.equal(execution.promotionEligible, false);
  assert.equal(execution.result.passed, true); assert.equal(execution.result.workspace.passed, true);
  assert.deepEqual(JSON.parse(execution.result.workspace.artifacts[0].content), { totalCents: 3500, count: 3, currency: 'CNY' });
  assert.equal(calls.length, 3); assert.equal(admissions.length, 3); assert.equal(receipts.length, 3); assert.equal(execution.usage.totalTokens, 39);
  assert.ok(execution.requests.every(request => request.phase === 'case:data')); assert.ok(calls.every(request => !request.systemPrompt.includes('blind evaluator')));
  for (const key of ['score', 'candidateScore', 'baselineScore', 'gatePassed', 'evaluationComplete']) assert.equal(Object.hasOwn(execution, key), false);
});

test('single-case execution freezes caller-owned model, task and artifact expectations before progress callbacks', async () => {
  const calls = [], genome = scenarioGenomes().candidate, model = { ...scenarioModel }, originalHash = evolutionHash(genome.evaluationSuite); let changed = false;
  const execution = await executeProjectEvaluationCase({ genome, caseId: 'data', model, provider: scenarioProvider({ calls }), onProgress(event) {
    if (!changed && event.type === 'model_request') { changed = true; model.maxOutputTokens = 256; genome.evaluationSuite.cases.find(row => row.id === 'data').input = '[scenario:document] different task'; genome.evaluationSuite.cases.find(row => row.id === 'data').workspace.checks[0].expected.totalCents = -1; }
  } });
  assert.equal(changed, true); assert.equal(execution.suiteHash, originalHash); assert.equal(execution.result.passed, true); assert.equal(execution.evaluationExecution.modelLimits.maxOutputTokens, 4096);
  assert.ok(calls.every(request => request.model.maxOutputTokens === 4096)); assert.equal(execution.result.workspace.artifacts[0].path, 'summary.json');
  assert.equal(genome.evaluationSuite.cases.find(row => row.id === 'data').workspace.checks[0].expected.totalCents, -1);
});
