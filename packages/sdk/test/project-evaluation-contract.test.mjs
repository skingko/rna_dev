import test from 'node:test';
import assert from 'node:assert/strict';
import { describeProjectEvaluationCase, validateProjectEvaluationClock } from '../src/project-evaluation-contract.mjs';
import { createProjectEvaluationRevision } from '../src/project-evaluation-revision.mjs';
import { createProjectEvaluationExecutionManifest, projectEvaluationEnvironmentInstructions } from '../src/project-evaluation-profile.mjs';
import { validateProjectGenome } from '../src/project-genome.mjs';
import { evaluateProjectGenomes } from '../src/project-evolution.mjs';
import { evolutionHash } from '../src/evolution.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from './fixtures/project-genome.mjs';
const model = { providerId: 'fixture', modelId: 'fixture', execution: 'rna', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 128000, maxOutputTokens: 4000, reasoning: 'off' };
const clock = { now: '2025-06-01T01:00:00.000Z', timeZone: 'Asia/Shanghai' };
const input = baseline => ({ schemaVersion: 1, sourceSuiteHash: evolutionHash(baseline.evaluationSuite), reason: 'Make the current date an explicit reproducible task fixture.', suite: { ...structuredClone(baseline.evaluationSuite), version: 'reviewed-clock', cases: baseline.evaluationSuite.cases.map(row => ({ ...structuredClone(row), clock })) } });
test('clock validates exact dates and explicit zones without consulting the host clock', () => {
  assert.deepEqual(validateProjectEvaluationClock(clock), clock); assert.equal(validateProjectEvaluationClock(undefined), undefined);
  for (const value of [null, {}, { ...clock, now: '2025-02-30T01:00:00.000Z' }, { ...clock, now: 'today' }, { ...clock, timeZone: 'Invalid/Zone' }, { ...clock, instruction: 'answer the hidden test' }]) assert.throws(() => validateProjectEvaluationClock(value), { code: 'invalid_evaluation_clock' });
  const genome = projectGenomeFixture(); genome.evaluationSuite.cases[0].clock = clock; assert.deepEqual(validateProjectGenome(genome).evaluationSuite.cases[0].clock, clock);
  const before = createProjectEvaluationExecutionManifest(genome.evaluationSuite, model); genome.evaluationSuite.cases[0].clock = { ...clock, now: '2025-06-02T01:00:00.000Z' };
  const after = createProjectEvaluationExecutionManifest(genome.evaluationSuite, model); assert.notEqual(before.sourceSuiteHash, after.sourceSuiteHash); assert.notEqual(before.effectiveExecutionHash, after.effectiveExecutionHash);
});
test('missing clocks remain explicitly unknown and hidden workspace checks never enter the environment prompt', () => {
  const text = projectEvaluationEnvironmentInstructions({ testCase: { workspace: { files: [], checks: [{ expected: 'secret-oracle' }] } }, tools: ['project_read'], execution: { maxSteps: 16, maxOutputTokens: 4096 } });
  assert.match(text, /No current-time fixture/); assert.equal(text.includes('secret-oracle'), false);
});
test('bounded diagnostics identify final-answer terms and failed arguments without revealing raw tool output or expected values', () => {
  const row = describeProjectEvaluationCase({ requiredTerms: ['可信度', '来源'], forbiddenTerms: ['fabricated'], requiredToolIds: ['write'] }, { answer: 'fabricated 来源', toolResults: [{ toolName: 'write', toolCallId: 'call1', isError: true, output: 'Invalid tool arguments: $.expectedHash: anyOf constraint failed secret-private' }, { toolName: 'write', isError: false }], workspace: { checks: [{ id: 'file', path: 'daily.md', kind: 'text_equals', code: 'mismatch', passed: false, expected: 'hidden-answer' }] } });
  assert.deepEqual(row.missingRequiredTerms, ['可信度']); assert.deepEqual(row.matchedForbiddenTerms, ['fabricated']); assert.deepEqual(row.missingRequiredToolIds, []);
  assert.equal(row.toolErrors[0].argumentPath, '$.expectedHash'); assert.equal(row.toolErrors.length, 1); assert.equal(row.termScope, 'final_answer');
  assert.equal(JSON.stringify(row).includes('secret-private'), false); assert.equal(JSON.stringify(row).includes('hidden-answer'), false);
});
test('reviewed correction cannot silently relax thresholds, execution, required tools or remove semantic requirements', () => {
  const baseline = projectGenomeFixture(), valid = input(baseline);
  for (const change of [x => x.suite.thresholds.minScore = .5, x => x.suite.execution = { maxSteps: 32, maxOutputTokens: 8192 }, x => x.suite.cases[0].requiredToolIds = [], x => x.suite.cases[0].requiredTerms = [], x => x.sourceSuiteHash = 'f'.repeat(64)]) { const draft = structuredClone(valid); change(draft); assert.throws(() => createProjectEvaluationRevision(baseline, draft), { code: 'invalid_evaluation_revision' }); }
  const draft = structuredClone(valid); draft.suite.cases[0].requiredTerms = []; draft.suite.cases[0].workspace = { files: [], checks: [{ id: 'content', path: 'report.md', kind: 'text_includes', values: ['evidence'] }] }; assert.equal(createProjectEvaluationRevision(baseline, draft).adoption, 'separate_review_required');
});
test('explicit correction applies the same clock and frozen new suite to both executions without mutating either genome', async () => {
  const baseline = projectGenomeFixture(), candidate = projectGenomeFixture({ candidate: true }), originals = structuredClone({ baseline, candidate }), calls = [], revision = createProjectEvaluationRevision(baseline, input(baseline));
  const result = await evaluateProjectGenomes({ baseline, candidate, evaluationRevision: revision, model, provider: genomeEvaluationProvider({ calls }) });
  assert.equal(result.gatePassed, true); assert.equal(result.suiteHash, revision.suiteHash); assert.equal(result.baselineHash, evolutionHash(baseline)); assert.equal(result.candidateHash, evolutionHash(candidate)); assert.equal(result.candidateStandardUsed, false); assert.deepEqual({ baseline, candidate }, originals);
  const executions = calls.filter(row => !row.systemPrompt.includes('blind evaluator')); assert.equal(executions.length, 12); assert.ok(executions.every(row => row.systemPrompt.includes(`now=${clock.now}; timeZone=${clock.timeZone}`))); assert.ok(result.details.every(row => row.baseline.diagnostics && row.candidate.diagnostics));
});
test('unreviewed candidate clock and future tests never change the baseline evaluation environment', async () => {
  const baseline = projectGenomeFixture(), candidate = projectGenomeFixture({ candidate: true }), calls = []; candidate.evaluationSuite.cases.forEach(row => row.clock = clock);
  const result = await evaluateProjectGenomes({ baseline, candidate, model, provider: genomeEvaluationProvider({ calls }) }); assert.equal(result.suiteHash, evolutionHash(baseline.evaluationSuite)); assert.ok(calls.filter(row => !row.systemPrompt.includes('blind evaluator')).every(row => row.systemPrompt.includes('No current-time fixture')));
});
