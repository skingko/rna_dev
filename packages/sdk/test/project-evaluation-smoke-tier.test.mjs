import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateProjectGenomes } from '../src/project-evolution.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from './fixtures/project-genome.mjs';

// P4 RRSI tier: the first <=3 selection cases are the smoke tier of the same
// paired evaluation; a regression there stops before the remaining cases.
const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 4000, reasoning: 'off' };
const widen = genome => { const suite = genome.evaluationSuite; while (suite.cases.length < 5) suite.cases.push({ ...structuredClone(suite.cases[0]), id: `extra_${suite.cases.length}`, input: `Check project edge input ${suite.cases.length} with verified evidence.` }); return genome; };

test('a regressing candidate stops after the smoke cases without buying the rest', async () => {
  // The fixture judge prefers "precise" answers, which only the CANDIDATE_AGENT prompt produces;
  // swapping roles makes the candidate regress against a stronger baseline.
  const strong = widen(projectGenomeFixture({ candidate: true })), weak = widen(projectGenomeFixture()); weak.evaluationSuite = structuredClone(strong.evaluationSuite);
  const smokeCaseIds = strong.evaluationSuite.cases.slice(1, 4).map(row => row.id), events = [];
  const calls = [], result = await evaluateProjectGenomes({ baseline: strong, candidate: weak, model, provider: genomeEvaluationProvider({ calls }), smokeCaseIds, smokeBand: 0.01, onProgress: row => events.push(row) });
  assert.equal(result.gatePassed, false); assert.equal(result.earlyStopReason, 'smoke_regressed'); assert.equal(result.stage, 'smoke');
  assert.deepEqual(result.rrsiSmoke.caseIds, smokeCaseIds); assert.equal(result.rrsiSmoke.passed, false); assert.equal(result.scoredCases, 3); assert.equal(result.skippedCases, 2);
  const started = events.filter(row => row.type === 'evaluation_case_started').map(row => row.caseId); assert.deepEqual(started, smokeCaseIds, 'smoke cases run first and nothing else is bought');
  // An improving candidate passes the smoke gate and completes the full evaluation with no duplicated requests.
  const full = [], improved = await evaluateProjectGenomes({ baseline: weak, candidate: strong, model, provider: genomeEvaluationProvider({ calls: full }), smokeCaseIds, smokeBand: 0.01 });
  assert.equal(improved.rrsiSmoke.passed, true); assert.equal(improved.cases, 5); assert.equal(improved.evaluationComplete, true);
  const plain = []; await evaluateProjectGenomes({ baseline: weak, candidate: strong, model, provider: genomeEvaluationProvider({ calls: plain }) });
  assert.equal(full.length, plain.length);
});
