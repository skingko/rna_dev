import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateProjectGenomes } from '../src/project-evolution.mjs';
import { evolutionHash } from '../src/evolution.mjs';
import { createProjectEvaluationExecutionManifest } from '../src/project-evaluation-profile.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from './fixtures/project-genome.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 128000, maxOutputTokens: 4000 };
const clock = { now: '2025-06-01T01:00:00.000Z', timeZone: 'Asia/Shanghai' };
const judgeInput = request => JSON.parse(request.messages[0].content[0].text);
const judges = calls => calls.filter(row => row.systemPrompt.includes('blind evaluator'));

test('the blind judge receives exactly the same validated case clock used by both executions', async () => {
  const baseline = projectGenomeFixture(), candidate = projectGenomeFixture({ candidate: true }), calls = [];
  const clocks = [clock, { now: '2025-06-02T02:00:00.000Z', timeZone: 'UTC' }, { now: '2025-06-03T03:00:00.000Z', timeZone: 'Asia/Tokyo' }];
  baseline.evaluationSuite.cases.forEach((row, index) => { row.clock = structuredClone(clocks[index]); });
  const original = structuredClone(baseline), manifest = createProjectEvaluationExecutionManifest(baseline.evaluationSuite, model);
  const result = await evaluateProjectGenomes({ baseline, candidate, model, provider: genomeEvaluationProvider({ calls }) });
  assert.deepEqual(result.evaluationExecution, manifest); assert.equal(result.suiteHash, evolutionHash(original.evaluationSuite));
  assert.equal(calls.length, 15); assert.equal(judges(calls).length, 3); assert.equal(result.usage.totalTokens, 450);
  for (let index = 0; index < clocks.length; index++) {
    const request = judges(calls)[index], input = judgeInput(request);
    assert.deepEqual(input.hostContext, { frozenCaseClock: clocks[index] });
    assert.match(request.systemPrompt, /shared by both executions, not the current wall clock/);
    const executions = calls.filter(row => !row.systemPrompt.includes('blind evaluator') && row.messages[0].content[0].text === original.evaluationSuite.cases[index].input);
    assert.equal(executions.length, 4); assert.ok(executions.every(row => row.systemPrompt.includes(`now=${clocks[index].now}; timeZone=${clocks[index].timeZone}`)));
    assert.equal(request.judgeOutput.mode, 'native_tool');
  }
  assert.deepEqual(baseline, original); assert.equal(result.gatePassed, true);
});

test('a missing case clock is explicit null to the judge and never synthesized from wall time', async () => {
  const baseline = projectGenomeFixture(), calls = [];
  const result = await evaluateProjectGenomes({ baseline, candidate: projectGenomeFixture({ candidate: true }), model, provider: genomeEvaluationProvider({ calls }) });
  assert.ok(result.evaluationExecution.cases.every(row => !Object.hasOwn(row, 'clock')));
  assert.ok(judges(calls).every(request => {
    assert.deepEqual(judgeInput(request).hostContext, { frozenCaseClock: null });
    assert.match(request.systemPrompt, /null means no time fixture was supplied/); return true;
  }));
  assert.ok(calls.filter(row => !row.systemPrompt.includes('blind evaluator')).every(row => row.systemPrompt.includes('No current-time fixture')));
  assert.equal(calls.length, 15); assert.equal(result.requests.length, 15);
});

test('candidate clocks and caller mutation cannot replace the frozen baseline clock seen by executions or judge', async () => {
  const baseline = projectGenomeFixture(), candidate = projectGenomeFixture({ candidate: true }), calls = [];
  baseline.evaluationSuite.cases.forEach(row => { row.clock = structuredClone(clock); });
  candidate.evaluationSuite.cases.forEach(row => { row.clock = { now: '2040-01-01T00:00:00.000Z', timeZone: 'UTC' }; });
  const frozenSuiteHash = evolutionHash(baseline.evaluationSuite); let mutated = false;
  const result = await evaluateProjectGenomes({ baseline, candidate, model, provider: genomeEvaluationProvider({ calls }), onProgress: event => {
    if (event.type === 'evaluation_case_started' && !mutated) { mutated = true; baseline.evaluationSuite.cases.forEach(row => { row.clock.now = '2030-01-01T00:00:00.000Z'; }); }
  } });
  assert.equal(result.suiteHash, frozenSuiteHash); assert.equal(result.candidateStandardUsed, false);
  assert.ok(judges(calls).every(row => { assert.deepEqual(judgeInput(row).hostContext, { frozenCaseClock: clock }); return true; }));
  assert.ok(calls.filter(row => !row.systemPrompt.includes('blind evaluator')).every(row => row.systemPrompt.includes(`now=${clock.now}; timeZone=${clock.timeZone}`)));
  assert.equal(calls.length, 15); assert.equal(result.requests.filter(row => row.phase.startsWith('judge:')).length, 3);
});

test('the shared judge host context projects clock only and excludes private fixture and oracle fields', async () => {
  const baseline = projectGenomeFixture(), candidate = projectGenomeFixture({ candidate: true }), calls = [];
  baseline.evaluationSuite.cases.forEach(row => {
    row.clock = structuredClone(clock);
    row.workspace = { files: [{ path: 'report.txt', content: 'PRIVATE_FIXTURE_EXPECTED_SENTINEL' }], checks: [{ id: 'private_oracle', kind: 'text_equals', path: 'report.txt', expected: 'PRIVATE_FIXTURE_EXPECTED_SENTINEL' }] };
  });
  const result = await evaluateProjectGenomes({ baseline, candidate, model, provider: genomeEvaluationProvider({ calls }) });
  for (const request of judges(calls)) {
    const context = judgeInput(request).hostContext;
    assert.deepEqual(Object.keys(context), ['frozenCaseClock']); assert.deepEqual(context.frozenCaseClock, clock);
    assert.deepEqual(Object.keys(context.frozenCaseClock).sort(), ['now', 'timeZone']);
    assert.equal(JSON.stringify(context).includes('PRIVATE_FIXTURE_EXPECTED_SENTINEL'), false);
    assert.equal(JSON.stringify(context).includes('private_oracle'), false);
    assert.equal(Object.hasOwn(context, 'workspace'), false); assert.equal(Object.hasOwn(context, 'criteria'), false);
  }
  assert.equal(judges(calls).length, 3); assert.equal(calls.length, 15); assert.equal(result.usage.totalTokens, 450);
  assert.ok(result.details.every(row => row.baseline.checks.artifacts && row.candidate.checks.artifacts));
});
