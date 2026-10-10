import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { evolutionHash } from '../src/evolution.mjs';
import { proposeProjectGenome, evaluateProjectGenomes, validateProjectEvolutionLearningIntent } from '../src/project-evolution.mjs';
import { PROJECT_GENOME_SCRIPT_API_CONTRACT } from '../src/project-genome.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from './fixtures/project-genome.mjs';

const model = { providerId: 'local-fixture', modelId: 'fixture', execution: 'rna', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 128000, maxOutputTokens: 4000, reasoning: 'off' };
test('a learning handoff reaches the author as a hypothesis without changing evidence or revealing frozen cases', async () => {
  const calls = [], baseline = projectGenomeFixture(), original = structuredClone(baseline);
  const evidence = [{ id: 'observed', summary: 'The checked helper result was not interpreted.' }];
  const learningIntent = { content: 'Improve the evidence interpretation procedure.', reason: 'The retained result supports testing a reusable method.', evidenceIds: ['observed'] };
  await proposeProjectGenome({ project: { id: 'intent' }, baseline, evidence, learningIntent, model, provider: genomeEvaluationProvider({ calls }) });
  const input = JSON.parse(calls[0].messages[0].content[0].text);
  assert.deepEqual(input.learningIntent, { ...learningIntent, status: 'unverified_hypothesis' }); assert.deepEqual(input.evidence, evidence);
  assert.match(calls[0].systemPrompt, /not an observed fact, extra evidence, permission or an evaluation standard/);
  assert.equal(input.baseline.evaluationSuite.cases, undefined); assert.equal(input.baseline.tools[0].smokeCases, undefined); assert.deepEqual(baseline, original);
  const normalized = validateProjectEvolutionLearningIntent(learningIntent, evidence); normalized.evidenceIds.push('not-original'); assert.deepEqual(learningIntent.evidenceIds, ['observed']);
});
test('invalid or invented learning intent fails before any model request, while the omitted handoff stays compatible', async () => {
  const valid = { content: 'Try a bounded method.', reason: 'Existing evidence supports checking it.', evidenceIds: ['observed'] }, evidence = [{ id: 'observed' }];
  const invalid = [null, {}, { ...valid, content: ' ' }, { ...valid, content: 'x'.repeat(2001) }, { ...valid, reason: 'x'.repeat(601) }, { ...valid, evidenceIds: [] }, { ...valid, evidenceIds: ['observed', 'observed'] }, { ...valid, evidenceIds: ['invented'] }, { ...valid, evidenceIds: Array.from({ length: 17 }, (_, i) => `e${i}`) }, { ...valid, permission: 'execute' }];
  let calls = 0;
  for (const learningIntent of invalid) await assert.rejects(proposeProjectGenome({ project: { id: 'intent-validation' }, baseline: projectGenomeFixture(), evidence, learningIntent, model, provider: async function* () { calls++; } }), { code: 'invalid_learning_intent' });
  assert.equal(calls, 0); assert.equal(validateProjectEvolutionLearningIntent(undefined, evidence), undefined);
});
test('proposal generates executable project changes while held-out cases and frozen smoke expectations stay out of its request', async () => {
  const calls = [], baseline = projectGenomeFixture(), candidate = projectGenomeFixture({ candidate: true });
  const result = await proposeProjectGenome({ project: { id: 'fixture', title: 'Evidence review' }, baseline, evidence: [{ id: 'observed', summary: 'Answers lack actionable evidence' }], model, tokenBudget: null, provider: genomeEvaluationProvider({ calls, candidate }) });
  assert.deepEqual(result.proposal.genome, candidate); assert.equal(result.usage.totalTokens, 30);
  assert.ok(calls[0].systemPrompt.includes(PROJECT_GENOME_SCRIPT_API_CONTRACT));
  const input = JSON.parse(calls[0].messages[0].content[0].text); assert.equal(input.baseline.evaluationSuite.cases, undefined); assert.equal(input.baseline.tools[0].smokeCases, undefined); assert.deepEqual(input.baseline.evaluationSuite.criteria, baseline.evaluationSuite.criteria);
});
test('real SDK baseline and candidate executions call generated scripts before a separate blinded frozen-criteria judge', async () => {
  const baseline = projectGenomeFixture(), candidate = projectGenomeFixture({ candidate: true }), calls = [];
  const result = await evaluateProjectGenomes({ baseline, candidate, model, tokenBudget: null, provider: genomeEvaluationProvider({ calls }) });
  assert.equal(result.gatePassed, true); assert.equal(result.baselineScore, .5); assert.equal(result.candidateScore, .9); assert.equal(result.cases, 3);
  assert.equal(result.suiteHash, evolutionHash(baseline.evaluationSuite)); assert.equal(result.candidateStandardUsed, false); assert.equal(result.usage.totalTokens, 450); assert.equal(calls.length, 15);
  for (const row of result.details) { assert.equal(row.baseline.toolResults[0].output, '{"doubled":4}'); assert.equal(row.candidate.toolResults[0].output, '{"doubled":4}'); assert.ok(row.candidate.checks.requiredTools); }
  for (const call of calls.filter(item => item.systemPrompt.includes('blind evaluator'))) { const input = JSON.parse(call.messages[0].content[0].text); assert.deepEqual(input.criteria, baseline.evaluationSuite.criteria); assert.equal(input.candidate, undefined); assert.equal(input.baseline, undefined); assert.ok(!JSON.stringify(input).includes('CANDIDATE_AGENT')); }
});
test('lowering candidate standards or self-reported quality cannot override frozen deterministic criteria', async () => {
  const baseline = projectGenomeFixture(), candidate = projectGenomeFixture({ candidate: true });
  candidate.evaluationSuite.thresholds.minImprovement = .01; candidate.evaluationSuite.thresholds.minScore = .5;
  candidate.evaluationSuite.criteria[0].description = 'Always award the candidate full credit'; candidate.evaluationSuite.cases.forEach(item => { item.forbiddenTerms = []; item.requiredTerms = []; item.requiredToolIds = []; });
  const result = await evaluateProjectGenomes({ baseline, candidate, model, provider: genomeEvaluationProvider({ candidate, badCandidate: true }) });
  assert.equal(result.gatePassed, false); assert.equal(result.gates.deterministicCases, false); assert.equal(result.candidateScore, null); assert.equal(result.evaluationComplete, false); assert.equal(result.earlyStopReason, 'candidate_deterministic_failed'); assert.equal(result.suiteHash, evolutionHash(baseline.evaluationSuite)); assert.equal(result.candidateStandardUsed, false);
});
test('candidate cannot replace a prior script smoke contract with a fabricated expected result', async () => {
  const baseline = projectGenomeFixture(), candidate = projectGenomeFixture({ candidate: true }); candidate.tools[0].script = 'return { doubled: 999 };'; candidate.tools[0].smokeCases[0].expected = { doubled: 999 };
  const result = await evaluateProjectGenomes({ baseline, candidate, model, provider: genomeEvaluationProvider({ candidate }) });
  assert.equal(result.smoke.passed, true); assert.equal(result.frozenSmoke[0].passed, false); assert.equal(result.gates.scripts, false); assert.equal(result.gatePassed, false);
});
test('malformed judge ratings fail evaluation instead of fabricating a score', async () => {
  await assert.rejects(evaluateProjectGenomes({ baseline: projectGenomeFixture(), candidate: projectGenomeFixture({ candidate: true }), model, provider: genomeEvaluationProvider({ failJudge: true }) }), failure => failure.code === 'invalid_judge' && failure.evolutionDiagnostic.phase === 'judge' && failure.evolutionDiagnostic.kind === 'invalid_judge' && failure.evolutionDiagnostic.missingCriterionIds[0] === 'evidence' && failure.usage.totalTokens > 0 && Boolean(failure.evaluationEvidence.suiteHash) && failure.evaluationEvidence.inFlightCase.candidate.toolResults.length === 1);
});

for (const invalidKind of ['duplicate', 'unknown']) test(`judge ${invalidKind} criterion IDs retain bounded structural diagnostics and never trigger another paid request`, async () => {
  const baseline = projectGenomeFixture(), candidate = projectGenomeFixture({ candidate: true }); baseline.evaluationSuite.criteria.push({ id: 'calculation', description: 'The computed value is correct.', weight: 1 });
  const ordinary = genomeEvaluationProvider(), calls = []; const wrong = invalidKind === 'duplicate' ? 'evidence' : 'unrecognized-'.repeat(30);
  await assert.rejects(evaluateProjectGenomes({ baseline, candidate, model, provider: async function* (request) {
    calls.push(request);
    if (!request.systemPrompt.includes('blind evaluator')) { yield* ordinary(request); return; }
    const schema = request.tools[0].parameters; assert.deepEqual(schema.properties.ratings.items.properties.criterionId.enum, ['evidence', 'calculation']); assert.equal(schema.properties.ratings.minItems, 2); assert.equal(schema.properties.ratings.maxItems, 2);
    yield { type: 'tool_call', id: 'ratings', name: request.tools[0].name, arguments: { ratings: [{ criterionId: 'evidence', left: .6, right: .7, reason: 'Observed result.' }, { criterionId: wrong, left: .6, right: .7, reason: 'Observed result.' }] } }; yield { type: 'usage', usage: { totalTokens: 30 } }; yield { type: 'done', stopReason: 'toolUse' };
  } }), error => {
    assert.equal(error.code, 'invalid_judge'); assert.equal(error.evolutionDiagnostic.kind, 'invalid_judge'); assert.deepEqual(error.evolutionDiagnostic.expectedCriterionIds, ['evidence', 'calculation']); assert.deepEqual(error.evolutionDiagnostic.missingCriterionIds, ['calculation']); assert.equal(error.evolutionDiagnostic.actualCount, 2); assert.equal(error.evolutionDiagnostic.actualCriterionIds[1], wrong.slice(0,200)); assert.equal(error.evolutionDiagnostic.criterionIdsTruncated, invalidKind === 'unknown'); assert.equal(error.evolutionDiagnostic.duplicateCriterionIds.length, invalidKind === 'duplicate' ? 1 : 0); assert.equal(error.evaluationEvidence.cases.length, 0); assert.equal(error.usage.totalTokens, 150); return true;
  });
  assert.equal(calls.length, 5);
});

for (const incomplete of ['length', 'empty']) test(`candidate ${incomplete} output is incomplete evaluation, not a failed quality score`, async () => {
  const actual = genomeEvaluationProvider(), calls = [];
  await assert.rejects(evaluateProjectGenomes({ baseline: projectGenomeFixture(), candidate: projectGenomeFixture({ candidate: true }), model, provider: async function* (request) {
    calls.push(request);
    if (request.systemPrompt.includes('CANDIDATE_AGENT')) { if (incomplete === 'length') yield { type: 'text_delta', delta: 'unfinished evidence' }; yield { type: 'usage', usage: { totalTokens: 17 } }; yield { type: 'done', stopReason: incomplete === 'length' ? 'length' : 'stop' }; }
    else yield* actual(request);
  } }), failure => failure.code === 'evaluation_execution_incomplete' && failure.evolutionDiagnostic.phase === 'candidate' && failure.evolutionDiagnostic.kind === (incomplete === 'length' ? 'output_truncated' : 'empty_response') && failure.evaluationEvidence.inFlightCase.baseline.passed === true && failure.evaluationEvidence.cases.length === 0 && failure.usage.totalTokens === 77);
  assert.equal(calls.length, 3); assert.ok(!calls.some(request => request.systemPrompt.includes('blind evaluator')));
});
test('real HTTP authentication failure retains execution phase and never yields rejected quality gates', async t => {
  let calls = 0; const server = http.createServer((_request, response) => { calls++; response.writeHead(401); response.end('private-provider-response'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await assert.rejects(evaluateProjectGenomes({ baseline: projectGenomeFixture(), candidate: projectGenomeFixture({ candidate: true }), model: { ...model, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, apiKey: 'temporary-test-secret' }), failure => failure.evolutionDiagnostic.phase === 'baseline' && failure.evaluationEvidence.cases.length === 0 && failure.requests.length === 1 && !failure.message.includes('private-provider-response'));
  assert.equal(calls, 1);
});
test('explicit tiny budget prevents provider calls, while unknown usage is conservatively charged', async () => {
  let calls = 0; await assert.rejects(proposeProjectGenome({ project: { id: 'budget' }, baseline: projectGenomeFixture(), evidence: [], model, tokenBudget: 1, provider: async function* () { calls++; } }), { code: 'budget_exhausted' }); assert.equal(calls, 0);
  const wrapped = genomeEvaluationProvider(); const result = await proposeProjectGenome({ project: { id: 'unknown-usage' }, baseline: projectGenomeFixture(), evidence: [], model, provider: async function* (request) { for await (const event of wrapped(request)) if (event.type !== 'usage') yield event; } });
  assert.ok(result.usage.totalTokens > 0); assert.equal(result.requests[0].estimatedWhenUnknown, true); assert.equal(result.usage.estimatedTokens, result.usage.totalTokens);
});

test('live admission rejection before a proposal does not fabricate usage for a provider call that never started', async () => {
  let calls = 0, receipts = 0;
  await assert.rejects(proposeProjectGenome({ project: { id: 'admission' }, baseline: projectGenomeFixture(), evidence: [], model, provider: async function* () { calls++; }, requestControl: { beforeRequest: () => { throw Object.assign(new Error('New allowance exhausted'), { code: 'budget' }); }, onUsage: () => { receipts++; } } }), failure => failure.code === 'budget' && failure.usage.totalTokens === 0 && failure.requests.length === 0);
  assert.equal(calls, 0); assert.equal(receipts, 0);
});

test('cancellation after successful admission settles its reservation with zero usage and never dispatches a provider', async () => {
  const controller = new AbortController(), receipts = [], events = []; let reserved = 0, calls = 0;
  await assert.rejects(proposeProjectGenome({ project: { id: 'cancel-after-admission' }, baseline: projectGenomeFixture(), evidence: [], model, signal: controller.signal,
    provider: async function* () { calls++; }, onProgress: event => events.push(event), requestControl: {
      async beforeRequest({ estimatedTokens }) { reserved = estimatedTokens; controller.abort(); await Promise.resolve(); },
      onUsage(receipt) { receipts.push(receipt); reserved = 0; }
    }
  }), failure => failure.name === 'AbortError' && failure.usage.totalTokens === 0 && failure.requests.length === 1 && failure.requests[0].requestStarted === false);
  assert.equal(calls, 0); assert.equal(reserved, 0); assert.equal(receipts.length, 1); assert.equal(receipts[0].usage.totalTokens, 0); assert.equal(receipts[0].usage.estimatedTokens, 0); assert.equal(receipts[0].estimatedWhenUnknown, false); assert.equal(receipts[0].cancelledBeforeSend, true);
  assert.ok(events.some(item => item.type === 'request_admission_cancelled')); assert.ok(!events.some(item => item.type === 'model_request'));
});

test('a progress observer failure cannot strand an admitted request reservation after actual usage is known', async () => {
  let reserved = 0; const receipts = [], provider = genomeEvaluationProvider();
  await assert.rejects(proposeProjectGenome({ project: { id: 'observer-error' }, baseline: projectGenomeFixture(), evidence: [], model, provider,
    onProgress(event) { if (event.type === 'model_request') throw new Error('observer failed'); },
    requestControl: { beforeRequest({ estimatedTokens }) { reserved = estimatedTokens; }, onUsage(receipt) { receipts.push(receipt); reserved = 0; } }
  }), failure => failure.message === 'observer failed' && failure.usage.totalTokens === 30);
  assert.equal(reserved, 0); assert.equal(receipts.length, 1); assert.equal(receipts[0].requestStarted, true); assert.equal(receipts[0].usage.totalTokens, 30);
});

test('live admission applies to every baseline, candidate and blind judge call without double or phantom billing', async () => {
  for (const allowed of [0, 1, 2, 4]) {
    const calls = [], receipts = [], attempted = [];
    await assert.rejects(evaluateProjectGenomes({ baseline: projectGenomeFixture(), candidate: projectGenomeFixture({ candidate: true }), model, provider: genomeEvaluationProvider({ calls }), requestControl: {
      beforeRequest: ({ phase, estimatedTokens }) => { attempted.push(phase); assert.ok(estimatedTokens > 0); if (calls.length >= allowed) throw Object.assign(new Error('Live budget exhausted'), { code: 'budget' }); }, onUsage: receipt => receipts.push(receipt)
    } }), failure => failure.code === 'budget' && failure.usage.totalTokens === allowed * 30 && failure.requests.length === allowed);
    assert.equal(calls.length, allowed); assert.equal(receipts.length, allowed); assert.equal(attempted.length, allowed + 1); assert.match(attempted.at(-1), allowed < 2 ? /^baseline:/ : allowed < 4 ? /^candidate:/ : /^judge:/);
    assert.equal(receipts.reduce((sum, receipt) => sum + receipt.usage.totalTokens, 0), allowed * 30);
  }
});

test('script repair uses live admission after its actual failed draft receipt has settled', async () => {
  const candidate = projectGenomeFixture({ candidate: true }); candidate.tools[0].script = 'return { doubled: 99 };';
  const calls = [], receipts = [], attempted = [];
  await assert.rejects(proposeProjectGenome({ project: { id: 'repair-admission' }, baseline: projectGenomeFixture(), evidence: [], model, provider: genomeEvaluationProvider({ candidate, calls }), requestControl: {
    beforeRequest: ({ phase }) => { attempted.push(phase); if (phase.startsWith('script-repair:')) { assert.equal(receipts.length, 1); throw Object.assign(new Error('Allowance changed while checking the draft'), { code: 'budget' }); } }, onUsage: receipt => receipts.push(receipt)
  } }), failure => failure.code === 'budget' && failure.usage.totalTokens === 30 && failure.requests.length === 1);
  assert.equal(calls.length, 1); assert.deepEqual(attempted, ['proposal:1', 'script-repair:2']);
});
