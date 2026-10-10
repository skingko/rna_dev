import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProjectEvolutionSearchPolicy, projectEvolutionAuthorSearchContext, projectGenomeBehaviorHash } from '../src/project-evolution-search.mjs';
import { proposeProjectGenome } from '../src/project-evolution.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from './fixtures/project-genome.mjs';

const hash = 'a'.repeat(64), model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 128000, maxOutputTokens: 4000 };
function fixture() {
  const baseline = projectGenomeFixture(), candidate = structuredClone(baseline); candidate.skills[0].instructions += '\nKeep the source scope explicit.';
  const delivery = { scope: 'selection_runtime_receipts', qualityClaim: 'none', observedExecutions: 1, expectedExecutions: 2, omittedItems: 0,
    items: [{ id: 'evidence_review', path: 'SKILL.md', catalogSubmitted: 1, resourceInventorySubmitted: 0, delivered: 0, notRequested: 1, contentNotSubmitted: 0, partialDelivery: 0, unknown: 0 }] };
  const row = { id: 'retained-selection', baselineBehaviorHash: projectGenomeBehaviorHash(baseline), candidateBehaviorHash: projectGenomeBehaviorHash(candidate), comparisonKey: hash, evidenceHash: hash,
    hypothesis: 'Use the source scope in ordinary research summaries.', outcome: 'incomplete', changedAssets: [{ kind: 'skill', id: 'evidence_review', change: 'modified' }],
    feedback: { reason: 'selection_incomplete', comparable: true, skillDelivery: delivery } };
  return { baseline, candidate, delivery, row, policy: { comparisonKey: hash, history: [row] } };
}

test('bounded delivery feedback reaches an actual author request without buying a retry or declaring a method failure', async () => {
  const f = fixture(), calls = [];
  const result = await proposeProjectGenome({ project: {}, baseline: f.baseline, evidence: [], model, maxAttempts: 1, searchPolicy: f.policy, provider: genomeEvaluationProvider({ candidate: f.candidate, calls }) });
  assert.equal(result.attempts, 1); assert.equal(calls.length, 1);
  const input = JSON.parse(calls[0].messages[0].content[0].text);
  assert.deepEqual(input.searchContext.history[0].feedback.skillDelivery, f.delivery); assert.equal(input.searchContext.history[0].outcome, 'incomplete');
  assert.match(calls[0].systemPrompt, /An unchanged trigger plus an unread revised body is an unverified intervention/);
  assert.match(calls[0].systemPrompt, /Never force loading/);
  assert.doesNotMatch(JSON.stringify(input.searchContext), /case_1|case_2|candidateScore|baselineScore|judgeText/);
});

test('copied author context cannot mutate retained delivery facts', () => {
  const f = fixture(), context = projectEvolutionAuthorSearchContext(f.policy);
  context.history[0].feedback.skillDelivery.items[0].notRequested = 0;
  assert.equal(f.delivery.items[0].notRequested, 1);
});

test('previous-context discovery facts do not become a current quality verdict', () => {
  const f = fixture(); f.row.outcome = 'not_evaluated'; f.row.feedback.comparable = false;
  const context = projectEvolutionAuthorSearchContext(f.policy); assert.equal(context.history[0].outcome, 'not_evaluated');
  assert.equal(context.history[0].feedback.skillDelivery.qualityClaim, 'none');
});

test('complete observed counts can distinguish missing receipts and resources without hiding the denominator', () => {
  const f = fixture(); f.delivery.observedExecutions = 3; f.delivery.expectedExecutions = 4;
  Object.assign(f.delivery.items[0], { catalogSubmitted: 3, delivered: 1, unknown: 1 });
  f.delivery.items.push({ id: 'evidence_review', path: 'references/guide.md', catalogSubmitted: 3, resourceInventorySubmitted: 2, delivered: 0, notRequested: 1, contentNotSubmitted: 1, partialDelivery: 1, unknown: 0 });
  assert.deepEqual(validateProjectEvolutionSearchPolicy(f.policy).history[0].feedback.skillDelivery, f.delivery);
});

test('private text, quality claims, unexplained counts and unknown assets are rejected before author dispatch', async () => {
  const mutations = [
    d => { d.judgeText = 'private answer'; }, d => { d.scope = 'confirmation'; }, d => { d.qualityClaim = 'improved'; },
    d => { d.expectedExecutions = 0; }, d => { d.observedExecutions = 0; }, d => { d.expectedExecutions = 2001; }, d => { d.omittedItems = -1; },
    d => { d.items[0].notRequested = 0; }, d => { d.items[0].delivered = 1; }, d => { d.items[0].unknown = .5; },
    d => { d.items[0].catalogSubmitted = 0; }, d => { d.items[0].resourceInventorySubmitted = 1; },
    d => { d.items[0].caseId = 'private-case'; }, d => { d.items[0].id = 'unlisted-skill'; }, d => { d.items = []; },
    d => { d.items.push(structuredClone(d.items[0])); }, d => { d.items = Array.from({ length: 33 }, (_, index) => ({ ...d.items[0], path: `references/${index}.md` })); },
  ];
  let requests = 0;
  for (const mutate of mutations) {
    const f = fixture(); mutate(f.delivery);
    await assert.rejects(proposeProjectGenome({ project: {}, baseline: f.baseline, evidence: [], model, searchPolicy: f.policy, provider: async function* () { requests++; } }), { code: 'invalid_search_policy' });
  }
  assert.equal(requests, 0);
});

test('omitted items are explicit and existing callers without discovery feedback remain unchanged', () => {
  const f = fixture(); f.delivery.omittedItems = 15;
  assert.equal(validateProjectEvolutionSearchPolicy(f.policy).history[0].feedback.skillDelivery.omittedItems, 15);
  delete f.row.feedback.skillDelivery;
  assert.equal(projectEvolutionAuthorSearchContext(f.policy).history[0].feedback.skillDelivery, undefined);
});
