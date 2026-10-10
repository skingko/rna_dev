import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeProjectGenome } from '../src/project-evolution.mjs';
import { projectGenomeFixture, diagnosisFixture } from './fixtures/project-genome.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 4096, reasoning: 'off' };
const proposal = genome => ({ summary: 'Repair the evidence method', hypothesis: 'A precise procedure improves evidence handling', diagnosis: diagnosisFixture(), changes: ['Improve the method'], genome });
function draft() {
  const genome = projectGenomeFixture({ candidate: true }); delete genome.evaluationSuite;
  return proposal(genome);
}
const input = request => JSON.parse(request.messages[0].content[0].text);
function provider(values, calls) {
  return async function* (request) {
    calls.push(request); const value = values[Math.min(calls.length - 1, values.length - 1)];
    yield { type: 'text_delta', delta: typeof value === 'string' ? value : JSON.stringify(value) };
    yield { type: 'usage', usage: { input: 10, output: 5, totalTokens: 15 } };
    yield { type: 'done', stopReason: 'stop' };
  };
}
const options = (baseline, values, calls, extra = {}) => ({ project: { id: 'fixture' }, baseline, evidence: [], model, provider: provider(values, calls), ...extra });

test('ordinary malformed JSON returns the bounded rejected draft and validation reason to the same author operation', async () => {
  const calls = [], baseline = projectGenomeFixture(), good = draft(), broken = JSON.stringify(good).slice(0, -1);
  const result = await proposeProjectGenome(options(baseline, [broken, good], calls));
  assert.equal(calls.length, 2); assert.equal(result.validation.passed, true);
  const retry = input(calls[1]); assert.equal(retry.previousDraft, broken);
  assert.equal(retry.previousDraftStatus, 'unverified_model_authored_repair_data'); assert.match(retry.previousError, /Invalid evolution JSON/);
  assert.deepEqual(result.proposal.genome.evaluationSuite, baseline.evaluationSuite);
  assert.equal(result.usage.totalTokens, 30); assert.equal(result.requests.length, 2);
});

test('semantic inheritance failure preserves the authored inventory for targeted repair without expanding it into source assets', async () => {
  const calls = [], baseline = projectGenomeFixture(), first = draft(), repaired = draft();
  first.genome.skills = [{ id: baseline.skills[0].id, inheritFromBaseline: true }];
  first.genome.tools = [{ id: 'unknown_tool', inheritFromBaseline: true }];
  repaired.genome.skills = structuredClone(first.genome.skills);
  repaired.genome.tools = [{ id: baseline.tools[0].id, inheritFromBaseline: true }];
  const result = await proposeProjectGenome(options(baseline, [first, repaired], calls));
  assert.equal(result.validation.passed, true); assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(input(calls[1]).previousDraft), first);
  assert.deepEqual(result.proposal.genome.skills, baseline.skills);
  assert.deepEqual(result.proposal.genome.tools, baseline.tools);
});

test('failure after host suite injection never returns hidden cases, frozen smoke inputs or inherited resources in the author draft', async () => {
  const calls = [], baseline = projectGenomeFixture(), first = draft(), fixed = draft();
  baseline.evaluationSuite.cases[0].input = 'SECRET_FROZEN_CASE_DO_NOT_REVEAL';
  baseline.skills[0].resources[0].content = 'SECRET_FROZEN_RESOURCE';
  baseline.tools[0].smokeCases[0] = { input: { value: 23 }, expected: { doubled: 46 } };
  for (const value of [first, fixed]) {
    value.genome.skills = [{ id: baseline.skills[0].id, inheritFromBaseline: true }];
    value.genome.tools = [{ id: baseline.tools[0].id, inheritFromBaseline: true }];
  }
  first.diagnosis.evidenceIds = ['invented-evidence'];
  const result = await proposeProjectGenome(options(baseline, [first, fixed], calls));
  const retry = input(calls[1]), retained = JSON.parse(retry.previousDraft);
  assert.equal(result.validation.passed, true); assert.equal(calls.length, 2);
  assert.deepEqual(retained, first); assert.equal(retained.genome.evaluationSuite, undefined);
  assert.equal(retained.genome.skills[0].resources, undefined); assert.equal(retained.genome.tools[0].smokeCases, undefined);
  assert.ok(!JSON.stringify(calls).includes('SECRET_FROZEN_CASE_DO_NOT_REVEAL'));
  assert.ok(!retry.previousDraft.includes('SECRET_FROZEN_RESOURCE'));
  assert.deepEqual(result.proposal.genome.evaluationSuite, baseline.evaluationSuite);
  assert.deepEqual(result.proposal.genome.tools[0].smokeCases, baseline.tools[0].smokeCases);
});

test('persistent contract failure stays within three attempts and retains all billed requests without generating evaluation scores', async () => {
  const calls = [], events = [], baseline = projectGenomeFixture(), original = structuredClone(baseline);
  await assert.rejects(proposeProjectGenome(options(baseline, ['{"notFinished":'], calls, { onProgress: event => events.push(event) })), error => {
    assert.equal(error.code, 'invalid_output'); assert.equal(error.requests.length, 3); assert.equal(error.usage.totalTokens, 45);
    assert.equal(error.repairEvidence.length, 3); assert.equal(error.evaluationEvidence, undefined); return true;
  });
  assert.equal(calls.length, 3); assert.equal(events.filter(row => row.type === 'proposal_repair').length, 2);
  for (const call of calls.slice(1)) assert.equal(input(call).previousDraft, '{"notFinished":');
  assert.deepEqual(baseline, original);
});
