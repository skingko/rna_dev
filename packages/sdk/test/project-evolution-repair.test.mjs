import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { proposeProjectGenome, evaluateProjectGenomes } from '../src/project-evolution.mjs';
import { projectGenomeFixture, genomeEvaluationProvider, diagnosisFixture } from './fixtures/project-genome.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 64000, maxOutputTokens: 4096, reasoning: 'off' };
const proposal = genome => ({ summary: 'Improve evidence interpretation', hypothesis: 'A checked result supports a useful answer', diagnosis: diagnosisFixture(), changes: ['Improve project skills and the evidence helper'], genome });
const repair = (script, smokeRepairs = []) => ({ tools: [{ id: 'evidence_helper', script }], smokeRepairs });
function valuesProvider(values, calls, tokens = 30) { return async function* (request) { calls.push(request); const value = values[Math.min(calls.length - 1, values.length - 1)]; yield { type: 'text_delta', delta: typeof value === 'string' ? value : JSON.stringify(value) }; yield { type: 'usage', usage: { input: tokens - 10, output: 10, totalTokens: tokens } }; yield { type: 'done', stopReason: 'stop' }; }; }
async function httpFixture(t, generator) {
  const calls = [], errors = []; let sequence = 0;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.headers.authorization, 'Bearer fixture-key');
      let source = ''; for await (const chunk of request) source += chunk;
      const body = JSON.parse(source); calls.push(body); const result = await generator(body, sequence++);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: result.delta, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: result.stop || 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`); response.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); response.writeHead(500); response.end('fixture failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(errors, []); });
  return { calls, model: { ...model, baseUrl: `http://127.0.0.1:${server.address().port}/v1` } };
}
function evaluationResponse(body, index) {
  const prompt = body.messages[0].content;
  if (prompt.includes('blind evaluator')) {
    const input = JSON.parse(body.messages[1].content);
    const ratings = { ratings: input.criteria.map(item => ({ criterionId: item.id, left: input.left.answer.includes('precise') ? .9 : .5, right: input.right.answer.includes('precise') ? .9 : .5, reason: 'The response refers to the actual helper result.' })) };
    if (body.tools?.[0]?.function.name === 'submit_evaluation_ratings') return { delta: { tool_calls: [{ index: 0, id: `rating-${index}`, type: 'function', function: { name: 'submit_evaluation_ratings', arguments: JSON.stringify(ratings) } }] }, stop: 'tool_calls' };
    return { delta: { content: JSON.stringify(ratings) } };
  }
  if (!body.messages.some(item => item.role === 'tool')) return { delta: { tool_calls: [{ index: 0, id: `call-${index}`, type: 'function', function: { name: 'evidence_helper', arguments: '{"value":2}' } }] }, stop: 'tool_calls' };
  assert.match(body.messages.find(item => item.role === 'tool').content, /"doubled":4/);
  return { delta: { content: prompt.includes('CANDIDATE_AGENT') ? 'precise evidence: the actual helper returned 4, use that evidence for the decision.' : 'preliminary evidence: the actual helper returned 4.' } };
}

test('HTTP proposal repairs a genuinely executed broken script before the full SDK tool/judge comparison', async t => {
  const baseline = projectGenomeFixture(), broken = projectGenomeFixture({ candidate: true }); broken.tools[0].script = 'return {doubled: input.value + 1};';
  const fixture = await httpFixture(t, (body, index) => {
    if (index === 0) return { delta: { content: JSON.stringify(proposal(broken)) } };
    if (index === 1) {
      const input = JSON.parse(body.messages[1].content); assert.equal(input.diagnostics.smoke.results[0].actual.doubled, 3); assert.equal(input.diagnostics.smoke.results[0].expected.doubled, 4);
      assert.equal(input.baseline.tools[0].smokeCases, undefined); assert.equal(input.baseline.evaluationSuite.cases, undefined); assert.deepEqual(input.diagnostics.frozenContractFailures, [{ toolId: 'evidence_helper', code: 'output_mismatch' }]);
      return { delta: { content: JSON.stringify(repair('return {doubled: input.value * 2};')) } };
    }
    return evaluationResponse(body, index);
  });
  const result = await proposeProjectGenome({ project: { id: 'real-http-loop' }, baseline, evidence: [{ id: 'external-observation' }], model: fixture.model, apiKey: 'fixture-key' });
  assert.equal(result.attempts, 2); assert.equal(result.usage.totalTokens, 60); assert.equal(result.repairEvidence[0].validation.passed, false); assert.equal(result.repairEvidence[1].validation.passed, true); assert.equal(result.repairEvidence[0].after.tools[0].script, broken.tools[0].script);
  const evaluation = await evaluateProjectGenomes({ baseline, candidate: result.proposal.genome, model: fixture.model, apiKey: 'fixture-key' });
  assert.equal(evaluation.gatePassed, true); assert.equal(evaluation.evaluationComplete, true); assert.equal(evaluation.usage.totalTokens, 450); assert.equal(fixture.calls.length, 17); assert.equal(evaluation.scoredCases, 3);
});
test('HTTP exhausted script repair stops at three requests and does not spend on any comparison or judge', async t => {
  const broken = projectGenomeFixture({ candidate: true }); broken.tools[0].script = 'return {doubled: 99};';
  const fixture = await httpFixture(t, (_body, index) => ({ delta: { content: JSON.stringify(index === 0 ? proposal(broken) : repair(`return {doubled: ${99 + index}};`)) } }));
  const result = await proposeProjectGenome({ project: { id: 'bounded' }, baseline: projectGenomeFixture(), evidence: [], model: fixture.model, apiKey: 'fixture-key' });
  assert.equal(result.attempts, 3); assert.equal(result.usage.totalTokens, 90); assert.equal(result.validation.passed, false);
  const evaluation = await evaluateProjectGenomes({ baseline: projectGenomeFixture(), candidate: result.proposal.genome, model: fixture.model, apiKey: 'fixture-key' });
  assert.equal(fixture.calls.length, 3); assert.equal(evaluation.stage, 'script_preflight'); assert.equal(evaluation.earlyStopReason, 'candidate_smoke_failed'); assert.equal(evaluation.candidateScore, null); assert.equal(evaluation.gates.improvement, null); assert.equal(evaluation.skippedCases, 3); assert.equal(evaluation.requests.length, 0); assert.equal(evaluation.usage.totalTokens, 0);
});

test('HTTP unchanged repair stops at two actual requests and preserves the first real syntax diagnostic', async t => {
  const broken = projectGenomeFixture({ candidate: true }); broken.tools[0].script = 'async function(input, api) { return { doubled: input.value * 2 }; }';
  const fixture = await httpFixture(t, (body, index) => {
    if (index === 0) return { delta: { content: JSON.stringify(proposal(broken)) } };
    assert.equal(index, 1, 'No third request is permitted for an unchanged repair');
    const input = JSON.parse(body.messages[1].content);
    assert.equal(input.candidate.tools[0].script, broken.tools[0].script); assert.equal(input.diagnostics.smoke.results[0].code, 'script_syntax'); assert.equal(input.diagnostics.smoke.results[0].phase, 'compile'); assert.equal(input.diagnostics.smoke.results[0].line, 1); assert.match(input.diagnostics.smoke.results[0].error, /Function statements require a function name/);
    assert.match(body.messages[0].content, /Valid complete script value/); assert.match(body.messages[0].content, /Invalid script value/); assert.match(body.messages[0].content, /does NOT create data.txt/);
    return { delta: { content: JSON.stringify(repair(broken.tools[0].script)) } };
  });
  const result = await proposeProjectGenome({ project: { id: 'same-syntax-error' }, baseline: projectGenomeFixture(), evidence: [], model: fixture.model, apiKey: 'fixture-key' });
  assert.equal(fixture.calls.length, 2); assert.equal(result.attempts, 2); assert.equal(result.usage.totalTokens, 60); assert.equal(result.earlyStopReason, 'unchanged_repair'); assert.equal(result.validation.passed, false);
  assert.deepEqual(result.validation, result.repairEvidence[0].validation); assert.deepEqual(result.repairEvidence[1].validation, result.repairEvidence[0].validation); assert.equal(result.repairEvidence[1].error.code, 'unchanged_repair'); assert.deepEqual(result.proposal.genome, broken);
});

test('a genuinely changed but still failing repair can use the third bounded request to fix the implementation', async () => {
  const broken = projectGenomeFixture({ candidate: true }); broken.tools[0].script = 'return {doubled: 99};'; const calls = [];
  const result = await proposeProjectGenome({ project: { id: 'changing-repair' }, baseline: projectGenomeFixture(), evidence: [], model, provider: valuesProvider([proposal(broken), repair('return {doubled: input.value + 1};'), repair('return {doubled: input.value * 2};')], calls) });
  assert.equal(calls.length, 3); assert.equal(result.attempts, 3); assert.equal(result.validation.passed, true); assert.equal(result.earlyStopReason, undefined); assert.equal(result.repairEvidence[1].validation.passed, false); assert.equal(result.repairEvidence[2].validation.passed, true);
});
test('candidate-authored arithmetic correction is audited but cannot alter the released oracle', async () => {
  const baseline = projectGenomeFixture(), draft = projectGenomeFixture({ candidate: true }); draft.tools[0].smokeCases[0].expected = { doubled: 5 };
  const original = structuredClone(baseline), calls = [];
  const result = await proposeProjectGenome({ project: { id: 'correct-draft' }, baseline, evidence: [], model, provider: valuesProvider([proposal(draft), repair(draft.tools[0].script, [{ toolId: 'evidence_helper', caseIndex: 0, expected: { doubled: 4 }, reason: 'The contract multiplies the integer input by two: 2 × 2 = 4, not 5.' }])], calls) });
  assert.equal(result.validation.passed, true); assert.equal(result.repairEvidence[1].expectationChanges[0].verification, 'model_explanation_not_independent_proof'); assert.deepEqual(baseline, original);
  const incompatible = projectGenomeFixture({ candidate: true }); incompatible.tools[0].script = 'return {doubled:99};'; const calls2 = [];
  const invalid = await proposeProjectGenome({ project: { id: 'wrong-oracle' }, baseline, evidence: [], model, provider: valuesProvider([proposal(incompatible), repair(incompatible.tools[0].script, [{ toolId: 'evidence_helper', caseIndex: 0, expected: { doubled: 99 }, reason: 'A proposed replacement rule would always emit ninety-nine regardless of the input.' }]), repair(incompatible.tools[0].script)], calls2) });
  assert.equal(invalid.validation.smoke.passed, true); assert.equal(invalid.validation.frozenSmoke[0].passed, false); assert.equal(invalid.validation.passed, false); assert.equal(calls2.length, 3); assert.deepEqual(baseline, original);
  const evaluation = await evaluateProjectGenomes({ baseline, candidate: invalid.proposal.genome, model, provider: async function* () { assert.fail('Frozen contract failure must not request a score'); } }); assert.equal(evaluation.earlyStopReason, 'frozen_tool_contract_failed');
});
test('a released implementation that fails its own oracle requires a separate repair and spends zero model tokens', async () => {
  const baseline = projectGenomeFixture(); baseline.tools[0].script = 'return {doubled:99};';
  await assert.rejects(proposeProjectGenome({ project: { id: 'bad-release' }, baseline, evidence: [], model, provider: async function* () { assert.fail('Baseline failure is local'); } }), error => error.code === 'baseline_contract_failed' && error.usage.totalTokens === 0 && error.evaluationEvidence.baselineSmoke.results[0].actual.doubled === 99);
});
test('cancel after local diagnostic never sends a repair and keeps the actually reported usage', async () => {
  const controller = new AbortController(), calls = [], draft = projectGenomeFixture({ candidate: true }); draft.tools[0].script = 'return {doubled:99};';
  await assert.rejects(proposeProjectGenome({ project: { id: 'cancel' }, baseline: projectGenomeFixture(), evidence: [], model, provider: valuesProvider([proposal(draft)], calls), signal: controller.signal, onProgress: event => { if (event.type === 'proposal_validation') controller.abort(); } }), error => error.name === 'AbortError' && error.usage.totalTokens === 30 && error.repairEvidence.length === 1); assert.equal(calls.length, 1);
});
test('remaining budget is checked before each repair and a malformed proposal has a bounded retry', async () => {
  const calls = [], draft = projectGenomeFixture({ candidate: true }); draft.tools[0].script = 'return {doubled:99};';
  let reserve;
  await assert.rejects(proposeProjectGenome({ project: { id: 'budget' }, baseline: projectGenomeFixture(), evidence: [], model, provider: valuesProvider([proposal(draft)], []), requestControl: { beforeRequest: input => { reserve = input.estimatedTokens; throw new Error('admission-sizing-only'); } } }), /admission-sizing-only/);
  await assert.rejects(proposeProjectGenome({ project: { id: 'budget' }, baseline: projectGenomeFixture(), evidence: [], model, tokenBudget: reserve + 1, provider: valuesProvider([proposal(draft)], calls, reserve) }), error => error.code === 'budget_exhausted' && error.usage.totalTokens === reserve); assert.equal(calls.length, 1);
  const calls2 = []; const result = await proposeProjectGenome({ project: { id: 'parse-repair' }, baseline: projectGenomeFixture(), evidence: [], model, provider: valuesProvider(['{"genome":', proposal(projectGenomeFixture({ candidate: true }))], calls2) }); assert.equal(result.attempts, 2); assert.equal(result.repairEvidence[0].draft, '{"genome":'); assert.equal(result.validation.passed, true);
  const calls3 = []; await assert.rejects(proposeProjectGenome({ project: { id: 'never-valid' }, baseline: projectGenomeFixture(), evidence: [], model, provider: valuesProvider(['bad-json'], calls3) }), error => error.code === 'invalid_output' && error.usage.totalTokens === 90 && error.repairEvidence.length === 3); assert.equal(calls3.length, 3);
});
test('a patch cannot drop cases, change inputs, rename tools, permissions, or the evaluation suite', async () => {
  const draft = projectGenomeFixture({ candidate: true }); draft.tools[0].script = 'return {doubled:99};'; const calls = [];
  const patch = repair('return {doubled:99};'); patch.tools[0].smokeCases = [{ input: { value: 0 }, expected: { doubled: 99 } }];
  const result = await proposeProjectGenome({ project: { id: 'no-erasure' }, baseline: projectGenomeFixture(), evidence: [], model, provider: valuesProvider([proposal(draft), patch], calls) });
  assert.equal(result.validation.passed, false); assert.deepEqual(result.proposal.genome, draft); assert.equal(calls.length, 3); assert.equal(result.repairEvidence[1].error.code, 'invalid_output');
});
test('deterministic failure skips its judge and all following cases without fabricating an aggregate score', async () => {
  const calls = []; const result = await evaluateProjectGenomes({ baseline: projectGenomeFixture(), candidate: projectGenomeFixture({ candidate: true }), model, provider: genomeEvaluationProvider({ calls, badCandidate: true }) });
  assert.equal(calls.length, 4); assert.equal(result.stage, 'deterministic_case'); assert.equal(result.cases, 1); assert.equal(result.scoredCases, 0); assert.equal(result.skippedCases, 2); assert.equal(result.candidateScore, null); assert.equal(result.details[0].judgmentSkipped, true); assert.equal(result.gates.deterministicCases, false);
});
test('bounded repair can restore old input compatibility after a new parameter was incorrectly made required', async () => {
  const baseline = projectGenomeFixture(), draft = projectGenomeFixture({ candidate: true }), tool = draft.tools[0], calls = [];
  tool.parameters.properties.scale = { type: 'integer' }; tool.parameters.required.push('scale'); tool.smokeCases[0].input.scale = 2; tool.script = 'return {doubled: input.value * (input.scale ?? 2)};';
  const parameters = structuredClone(tool.parameters); parameters.required = ['value']; const patch = repair(tool.script); patch.tools[0].parameters = parameters;
  const result = await proposeProjectGenome({ project: { id: 'schema-compatibility' }, baseline, evidence: [], model, provider: valuesProvider([proposal(draft), patch], calls) });
  assert.equal(result.repairEvidence[0].validation.smoke.passed, true); assert.match(result.repairEvidence[0].validation.frozenSmoke[0].error, /missing required property scale/); assert.equal(result.validation.passed, true); assert.equal(calls.length, 2); assert.deepEqual(result.proposal.genome.tools[0].smokeCases, tool.smokeCases); assert.deepEqual(baseline.tools[0].parameters.required, ['value']);
});
