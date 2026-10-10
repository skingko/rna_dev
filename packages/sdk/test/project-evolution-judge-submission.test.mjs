import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateProjectGenomes } from '../src/project-evolution.mjs';
import { evolutionHash } from '../src/evolution.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from './fixtures/project-genome.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 128000, maxOutputTokens: 4000 };

test('the third malformed native rating preserves two real prior cases, exact missing-field diagnostics and all actual fees without rejudging', async () => {
  const baseline = projectGenomeFixture(), candidate = projectGenomeFixture({ candidate: true }), before = structuredClone(baseline), ordinary = genomeEvaluationProvider();
  const calls = [], receipts = [], progress = []; let judges = 0;
  await assert.rejects(evaluateProjectGenomes({ baseline, candidate, model, onProgress: e => progress.push(e), requestControl: { onUsage: row => receipts.push(row) }, provider: async function* (request) {
    calls.push(request);
    if (!request.systemPrompt.includes('blind evaluator') || ++judges < 3) { yield* ordinary(request); return; }
    assert.equal(request.tools.length, 1); assert.equal(request.tools[0].name, 'submit_evaluation_ratings');
    yield { type: 'tool_call', id: 'missing-id-final-case', name: request.tools[0].name, arguments: { ratings: [{ left: .4, right: .7, reason: 'Actual unverified rating lacks the required identifier.' }] } };
    yield { type: 'usage', usage: { totalTokens: 20 } }; yield { type: 'usage', usage: { totalTokens: 30 } };
    yield { type: 'done', stopReason: 'toolUse', providerFinishReason: 'tool_calls' };
  } }), error => {
    assert.equal(error.code, 'invalid_judge'); assert.equal(error.evaluationEvidence.cases.length, 2);
    assert.equal(error.evaluationEvidence.simulated, false);
    assert.equal(error.evaluationEvidence.baselineHash, evolutionHash(baseline));
    assert.equal(error.evaluationEvidence.candidateHash, evolutionHash(candidate));
    assert.ok(error.evaluationEvidence.cases.every(row => row.baselineScore === .5 && row.candidateScore === .9));
    assert.equal(error.evaluationEvidence.inFlightCase.id, 'case_3');
    assert.deepEqual(error.evolutionDiagnostic.missingFields, ['$.ratings[0].criterionId']); assert.deepEqual(error.evolutionDiagnostic.missingCriterionIds, ['evidence']);
    assert.equal(error.evolutionDiagnostic.actualCount, 1); assert.deepEqual(error.evolutionDiagnostic.actualCriterionIds, []);
    assert.equal(error.evolutionDiagnostic.stopReason, 'toolUse'); assert.equal(error.evolutionDiagnostic.providerFinishReason, 'tool_calls');
    assert.equal(error.usage.totalTokens, 450); assert.equal(error.usage.estimatedTokens, 0); assert.equal(error.requests.length, 15);
    const judgeRequests = error.requests.filter(row => row.phase.startsWith('judge:')); assert.equal(judgeRequests.length, 3);
    assert.ok(judgeRequests.every(row => row.judgeOutput.mode === 'native_tool' && row.judgeOutput.evidenceCount === 2 && row.completed));
    return true;
  });
  assert.equal(calls.length, 15); assert.equal(judges, 3); assert.equal(receipts.reduce((sum, row) => sum + row.usage.totalTokens, 0), 450);
  assert.equal(progress.filter(e => e.type === 'judge_output_captured').length, 2); assert.deepEqual(baseline, before);
});

for (const mode of ['usage_failure', 'cancel_after_settlement']) test(`${mode} prevents accepting the staged native judge while preserving its one actual bill`, async () => {
  const ordinary = genomeEvaluationProvider(), abort = new AbortController(), receipts = [], progress = []; let calls = 0;
  await assert.rejects(evaluateProjectGenomes({ baseline: projectGenomeFixture(), candidate: projectGenomeFixture({ candidate: true }), model, signal: abort.signal, onProgress: e => progress.push(e), provider: async function* (request) { calls++; yield* ordinary(request); }, requestControl: { onUsage: receipt => {
    receipts.push(receipt); if (!receipt.phase.startsWith('judge:')) return;
    if (mode === 'usage_failure') throw Object.assign(Error('actual bill settlement failed'), { code: 'usage_sink_failed' });
    abort.abort();
  } } }), error => {
    assert.equal(error.usage.totalTokens, 150); assert.equal(error.requests.length, 5); assert.equal(error.evaluationEvidence.cases.length, 0);
    assert.equal(error.code ?? error.name, mode === 'usage_failure' ? 'usage_sink_failed' : 20); return true;
  });
  assert.equal(calls, 5); assert.equal(receipts.length, 5); assert.equal(progress.some(e => e.type === 'judge_output_captured'), false);
});

test('failed tool results alone do not establish native delivery capability and the judge preserves its text contract', async () => {
  const baseline = projectGenomeFixture(), candidate = projectGenomeFixture({ candidate: true });
  baseline.evaluationSuite.cases = baseline.evaluationSuite.cases.map(row => ({ ...row, requiredToolIds: [] }));
  const judgeModes = [];
  await evaluateProjectGenomes({ baseline, candidate, model, provider: async function* (request) {
    const judge = request.systemPrompt.includes('blind evaluator'), old = request.systemPrompt.includes('BASELINE_AGENT');
    if (judge) { judgeModes.push(request.judgeOutput.mode); assert.deepEqual(request.tools, []); yield { type: 'text_delta', delta: JSON.stringify({ ratings: [{ criterionId: 'evidence', left: .5, right: .5, reason: 'Actual comparison includes a failed baseline tool.' }] }) }; }
    else if (old && !request.messages.some(row => row.role === 'toolResult')) { yield { type: 'tool_call', id: 'invalid-helper', name: 'evidence_helper', arguments: { value: 'invalid schema value' } }; yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: 'toolUse' }; return; }
    else yield { type: 'text_delta', delta: 'Evidence remains limited.' };
    yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: 'stop' };
  } });
  assert.deepEqual(judgeModes, ['text', 'text', 'text']);
});
