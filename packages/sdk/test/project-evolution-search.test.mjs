import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectGenomeBehaviorHash, projectEvolutionEvidenceHash, describeProjectGenomeChanges, reviewProjectEvolutionCandidate, projectEvolutionAuthorSearchContext, validateProjectEvolutionSearchPolicy } from '../src/project-evolution-search.mjs';
import { proposeProjectGenome } from '../src/project-evolution.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from './fixtures/project-genome.mjs';

const comparisonKey = 'a'.repeat(64), evidence = [{ id: 'receipt-1', summary: 'A real result was not interpreted.' }];
const model = { providerId: 'local-fixture', modelId: 'fixture', execution: 'rna', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 128000, maxOutputTokens: 4000, reasoning: 'off' };
const baseline = () => projectGenomeFixture(), candidate = () => projectGenomeFixture({ candidate: true });
const history = (overrides = {}) => ({ id: 'previous-selection', baselineBehaviorHash: projectGenomeBehaviorHash(baseline()), candidateBehaviorHash: projectGenomeBehaviorHash(candidate()), evidenceHash: projectEvolutionEvidenceHash(evidence), comparisonKey, hypothesis: 'Interpret checked evidence.', outcome: 'rejected', changedAssets: [{ kind: 'skill', id: 'evidence_review', change: 'modified' }], ...overrides });
const review = overrides => reviewProjectEvolutionCandidate({ baseline: baseline(), candidate: candidate(), evidence, hypothesis: 'Interpret checked evidence.', searchPolicy: { comparisonKey, history: [history()] }, ...overrides });
const providerFor = genome => genomeEvaluationProvider({ candidate: genome });

test('runtime identity ignores future suites, smoke expectations, harmless inventory order and counts actual shipped capabilities', () => {
  const original = baseline(), proposed = structuredClone(original);
  proposed.evaluationSuite.thresholds.minImprovement = .01; proposed.evaluationSuite.cases[0].input = 'Different future task';
  proposed.tools[0].smokeCases[0].expected = { doubled: 987 }; proposed.tools[0].name = 'Display label only';
  const diff = describeProjectGenomeChanges(original, proposed);
  assert.equal(diff.baselineBehaviorHash, diff.candidateBehaviorHash); assert.deepEqual(diff.changes, []); assert.equal(diff.changedAssetCount, 0);
  assert.equal(diff.evaluationSuiteChanged, true); assert.equal(diff.smokeContractsChanged, true);
  proposed.skills[0].instructions += ' Validate evidence.'; proposed.skills[0].resources[0].content += ' Check source.';
  for (let i = 0; i < 10; i++) proposed.skills[0].resources.push({ path: `examples/${i}.md`, content: `Example ${i}` });
  const actual = describeProjectGenomeChanges(original, proposed);
  assert.equal(actual.changedAssetCount, 1); assert.equal(actual.changes.length, 12); assert.ok(actual.changes.every(item => item.kind === 'skill' || item.kind === 'resource'));
  proposed.skills[0].resources.reverse(); assert.equal(projectGenomeBehaviorHash(proposed), actual.candidateBehaviorHash);
  assert.equal(original.skills[0].resources.length, 1);
});

test('visible skill catalog reordering is a real prompt intervention, not an identical candidate', () => {
  const original = baseline(); original.skills.push({ id: 'another_method', name: 'Another', description: 'Another useful method', instructions: 'A different procedure.', resources: [] });
  const proposed = structuredClone(original); proposed.skills.reverse();
  const result = reviewProjectEvolutionCandidate({ baseline: original, candidate: proposed, searchPolicy: { maxChangedAssets: 1 } });
  assert.equal(result.status, 'passed'); assert.equal(result.changedAssetCount, 1); assert.notEqual(result.baselineBehaviorHash, result.candidateBehaviorHash);
  assert.deepEqual(result.changes.map(({ kind, id, change }) => ({ kind, id, change })), [{ kind: 'prompt', id: 'skillCatalogOrder', change: 'modified' }]);
});

test('a complete 127-resource marketplace skill is one capability unit and provenance changes do not manufacture behavior', () => {
  const original = baseline(), proposed = structuredClone(original), hash = text => createHash('sha256').update(text).digest('hex');
  const files = [{ path: 'SKILL.md', content: 'Reusable inspection method.' }, ...Array.from({ length: 127 }, (_, i) => ({ path: i === 0 ? 'LICENSE' : `references/${i}.md`, content: `Retained source ${i}` }))];
  const manifest = files.map(({ path, content }) => ({ path, contentHash: hash(content), bytes: Buffer.byteLength(content) }));
  proposed.skills.push({ id: 'market_inspection', name: 'Inspection', description: 'A complete acquired package', instructions: files[0].content, resources: files.slice(1), source: { kind: 'marketplace-package', provider: 'skills-sh', id: 'owner/repo/inspection', repository: 'owner/repo', commit: '1'.repeat(40), subdirectory: 'skills/inspection', sourceUrl: 'https://example.test/source', catalogUrl: 'https://example.test/catalog', packageHash: hash(JSON.stringify(manifest)), acquiredAt: '2026-09-28T00:00:00Z', reason: 'A reusable source method', compatibility: 'Read-only inspection procedure', licenseReview: 'preserved_not_legal_approval', licensePaths: ['LICENSE'], files: manifest } });
  const result = reviewProjectEvolutionCandidate({ baseline: original, candidate: proposed, searchPolicy: { maxChangedAssets: 1 } });
  assert.equal(result.status, 'passed'); assert.equal(result.changedAssetCount, 1); assert.equal(result.changes.length, 1);
  const existing = structuredClone(proposed); proposed.skills[1].source.acquiredAt = '2026-09-29T00:00:00Z';
  assert.equal(projectGenomeBehaviorHash(existing), projectGenomeBehaviorHash(proposed));
});

test('only fully measured identical candidates under exact comparison and evidence identities are redundant', () => {
  assert.deepEqual(review().duplicateCandidateIds, ['previous-selection']);
  for (const changed of [{ outcome: 'incomplete' }, { outcome: 'not_evaluated' }, { comparisonKey: 'b'.repeat(64) }, { baselineBehaviorHash: 'b'.repeat(64) }, { candidateBehaviorHash: 'b'.repeat(64) }, { evidenceHash: 'b'.repeat(64) }]) {
    const result = review({ searchPolicy: { comparisonKey, history: [history(changed)] } });
    assert.equal(result.status, 'passed', JSON.stringify(changed)); assert.deepEqual(result.duplicateCandidateIds, []);
  }
  assert.equal(review({ searchPolicy: { history: [history()] } }).status, 'passed');
  assert.equal(review({ evidence: [{ ...evidence[0], summary: 'New observed outcome.' }] }).status, 'passed');
  assert.equal(review({ searchPolicy: { comparisonKey, history: [history({ outcome: 'accepted' })] } }).status, 'rejected');
});

test('repeated hypothesis wording is an advisory, never a quality verdict or similarity ban', () => {
  const proposed = candidate(); proposed.skills[0].instructions += ' Cross-check against an independent source.';
  const result = review({ candidate: proposed, hypothesis: '  INTERPRET   checked evidence.  ' });
  assert.deepEqual(result.repeatedHypothesisIds, ['previous-selection']); assert.equal(result.status, 'passed');
  const rows = [history({ outcome: 'incomplete' })], context = projectEvolutionAuthorSearchContext({ comparisonKey, maxChangedAssets: 2, history: rows });
  assert.equal(context.history[0].outcome, 'incomplete'); assert.match(context.historyMeaning, /accepted does not mean independent confirmation or user adoption/);
  assert.ok(!JSON.stringify(context).includes(comparisonKey)); assert.ok(!JSON.stringify(context).includes(rows[0].candidateBehaviorHash));
  context.history[0].changedAssets[0].id = 'modified'; assert.equal(rows[0].changedAssets[0].id, 'evidence_review');
});

test('evidence order does not create new evidence; changed admitted content does', () => {
  const source = [{ id: 'a', content: 'One' }, { id: 'b', content: 'Two' }];
  assert.equal(projectEvolutionEvidenceHash(source), projectEvolutionEvidenceHash([...source].reverse()));
  assert.notEqual(projectEvolutionEvidenceHash(source), projectEvolutionEvidenceHash([{ id: 'a', content: 'Changed' }, source[1]]));
});

test('invalid or overbroad historical fields fail before any author request', async () => {
  const invalid = [null, { maxChangedAssets: 0 }, { maxChangedAssets: 1.5 }, { comparisonKey: 'unbound' }, { confirmation: {} }, { history: [history({ confirmation: 'secret' })] }, { history: [history({ score: .9 })] }, { history: [history(), history()] }, { history: Array.from({ length: 41 }, (_, i) => history({ id: `${i}` })) }, { history: [history({ changedAssets: [{ kind: 'platform', id: 'server', change: 'modified' }] })] }];
  let calls = 0;
  for (const searchPolicy of invalid) await assert.rejects(proposeProjectGenome({ project: {}, baseline: baseline(), model, evidence, searchPolicy, provider: async function* () { calls++; } }), { code: 'invalid_search_policy' });
  assert.equal(calls, 0); assert.equal(validateProjectEvolutionSearchPolicy(undefined), undefined);
});

test('scope review catches a bundled candidate despite a single claimed change and repairs within the same author budget', async () => {
  const narrowed = baseline(); narrowed.skills[0].instructions += ' Interpret the checked result before reporting.';
  const calls = [], events = [];
  const result = await proposeProjectGenome({ project: { id: 'scope' }, baseline: baseline(), model, evidence, searchPolicy: { maxChangedAssets: 1 }, maxAttempts: 2,
    provider: async function* (request) { calls.push(request); yield* providerFor(calls.length === 1 ? candidate() : narrowed)(request); }, onProgress: event => events.push(event) });
  assert.equal(result.attempts, 2); assert.equal(result.proposal.searchReview.changedAssetCount, 1); assert.equal(result.validation.passed, true);
  assert.deepEqual(events.filter(row => row.type === 'proposal_search_review').map(row => row.status), ['rejected', 'passed']);
  assert.equal(result.repairEvidence[0].error.code, 'search_policy_failed'); assert.equal(result.repairEvidence[0].validation, undefined);
  const input = JSON.parse(calls[1].messages[0].content[0].text); assert.match(input.previousError, /changes 3 capability units/);
  assert.equal(input.baseline.evaluationSuite.cases, undefined); assert.equal(input.baseline.tools[0].smokeCases, undefined);
  assert.equal(result.requests.length, 2); assert.equal(result.usage.totalTokens, 60);
});

test('evaluation-only proposals receive explicit no-runtime feedback with policy, while legacy suite authoring stays compatible', async () => {
  const suiteOnly = baseline(); suiteOnly.evaluationSuite.version = 'future-revision';
  await assert.rejects(proposeProjectGenome({ project: {}, baseline: baseline(), model, evidence, searchPolicy: {}, maxAttempts: 1, provider: providerFor(suiteOnly) }), error => {
    assert.equal(error.code, 'search_policy_failed'); assert.deepEqual(error.searchReview.reasons, ['no_behavior_change']); assert.match(error.message, /Only evaluation standards/); assert.equal(error.requests.length, 1); return true;
  });
  const oldCaller = await proposeProjectGenome({ project: {}, baseline: baseline(), model, evidence, maxAttempts: 1, provider: providerFor(suiteOnly) });
  assert.equal(oldCaller.validation.passed, true); assert.equal(oldCaller.proposal.searchReview.enforced, false); assert.equal(oldCaller.proposal.searchReview.status, 'rejected');
});

test('duplicate measured implementation is rejected even when the author rewrites the hypothesis', async () => {
  const calls = [];
  await assert.rejects(proposeProjectGenome({ project: {}, baseline: baseline(), model, evidence, searchPolicy: { comparisonKey, history: [history()] }, maxAttempts: 1, provider: genomeEvaluationProvider({ calls }) }), error => {
    assert.equal(error.code, 'search_policy_failed'); assert.deepEqual(error.searchReview.duplicateCandidateIds, ['previous-selection']); assert.deepEqual(error.searchReview.repeatedHypothesisIds, []); return true;
  });
  assert.equal(calls.length, 1);
});

test('script repair is rechecked against history before an identical measured candidate can reach evaluation', async () => {
  const broken = candidate(); broken.tools[0].script = 'return { doubled: 123 };';
  const events = [];
  await assert.rejects(proposeProjectGenome({ project: {}, baseline: baseline(), model, evidence, searchPolicy: { comparisonKey, history: [history()] }, maxAttempts: 2, onProgress: event => events.push(event), provider: async function* (request) {
    if (request.systemPrompt.startsWith('Repair only')) {
      yield { type: 'text_delta', delta: JSON.stringify({ tools: [{ id: 'evidence_helper', script: candidate().tools[0].script }], smokeRepairs: [] }) }; yield { type: 'usage', usage: { totalTokens: 13 } }; yield { type: 'done', stopReason: 'stop' };
    } else yield* providerFor(broken)(request);
  } }), error => {
    assert.equal(error.code, 'search_policy_failed'); assert.deepEqual(error.searchReview.duplicateCandidateIds, ['previous-selection']); assert.equal(error.requests.length, 2); return true;
  });
  const checks = events.filter(row => row.type === 'proposal_search_review'); assert.deepEqual(checks.map(row => row.status), ['passed', 'rejected']);
  assert.equal(events.filter(row => row.type === 'proposal_validation' && row.validation).length, 1);
});

test('search cannot silently withdraw an adopted skill or lower frozen tool compatibility', async () => {
  const invalid = candidate(); invalid.skills = [{ id: 'new_skill', name: 'New', description: 'Unrelated method', instructions: 'Use another procedure.', resources: [] }];
  await assert.rejects(proposeProjectGenome({ project: {}, baseline: baseline(), model, evidence, searchPolicy: { maxChangedAssets: 4 }, maxAttempts: 1, provider: providerFor(invalid) }), error => error.code === 'invalid_genome' && /skill|withdraw/i.test(error.message));
  const broken = candidate(); broken.tools[0].script = 'return { doubled: 123 };'; broken.tools[0].smokeCases[0].expected = { doubled: 123 };
  const result = await proposeProjectGenome({ project: {}, baseline: baseline(), model, evidence, searchPolicy: { maxChangedAssets: 4 }, maxAttempts: 1, provider: providerFor(broken) });
  assert.equal(result.proposal.searchReview.status, 'passed'); assert.equal(result.validation.passed, false); assert.equal(result.validation.frozenSmoke[0].passed, false);
});

test('bounded failure categories reach the author without scores, task identities or inferred causal claims', async () => {
  const feedback = { reason: 'selection_constraints_failed', comparable: true, failedGates: ['improvement', 'tokenRatio'], exposure: { required: 2, observed: 2, unobserved: 0, unknown: 0 } };
  const policy = { history: [history({ feedback })] }, calls = [];
  await proposeProjectGenome({ project: {}, baseline: baseline(), model, evidence, searchPolicy: policy, maxAttempts: 1, provider: genomeEvaluationProvider({ calls }) });
  const context = JSON.parse(calls[0].messages[0].content[0].text).searchContext;
  assert.deepEqual(context.history[0].feedback, feedback);
  assert.doesNotMatch(JSON.stringify(context), /baselineScore|candidateScore|case_1|judgment|confidenceInterval/);
  context.history[0].feedback.failedGates.push('noRegression'); assert.deepEqual(policy.history[0].feedback.failedGates, ['improvement', 'tokenRatio']);
  assert.match(calls[0].systemPrompt, /do not force all skills to load/i);
});

test('unobserved and changed-context feedback remain diagnostics instead of negative current quality evidence', () => {
  const unloaded = history({ outcome: 'incomplete', feedback: { reason: 'changes_not_exercised', comparable: true, exposure: { required: 1, observed: 0, unobserved: 1, unknown: 0 } } });
  const changed = history({ id: 'changed', outcome: 'not_evaluated', feedback: { reason: 'selection_no_gain', comparable: false, failedGates: ['improvement'] } });
  const context = projectEvolutionAuthorSearchContext({ history: [unloaded, changed] });
  assert.equal(context.history[0].outcome, 'incomplete'); assert.equal(context.history[1].feedback.comparable, false);
  assert.match(context.historyMeaning, /cannot falsify the current method/);
});

test('feedback rejects arbitrary judge text, private gates, inconsistent delivery totals and invented certainty before dispatch', async () => {
  const invalid = [
    { reason: 'selection_passed', comparable: true },
    { reason: 'selection_no_gain', comparable: false },
    { reason: 'selection_no_gain', comparable: true, failedGates: ['confirmation'] },
    { reason: 'selection_no_gain', comparable: true, judgeText: 'private answer' },
    { reason: 'selection_no_gain', comparable: true, failedGates: ['improvement', 'improvement'] },
    { reason: 'selection_no_gain', comparable: true, exposure: { required: 2, observed: 2, unobserved: 1, unknown: 0 } },
    { reason: 'statistically_proven_bad', comparable: true },
  ];
  let calls = 0;
  for (const feedback of invalid) await assert.rejects(proposeProjectGenome({ project: {}, baseline: baseline(), model, evidence, searchPolicy: { history: [history({ feedback })] }, provider: async function* () { calls++; } }), { code: 'invalid_search_policy' });
  assert.equal(calls, 0);
});
