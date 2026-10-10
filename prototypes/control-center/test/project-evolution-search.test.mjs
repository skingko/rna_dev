import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { ProjectEvolutionService } from '../test-support/marketplace-isolation.mjs';
import { createEvolutionSearchContext, createEvolutionSearchPolicy, describeEvolutionSearchOutcome } from '../project-evolution-search.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from '../../../packages/sdk/test/fixtures/project-genome.mjs';
import { evolutionSearchDisplay } from '../presentation/evolution-evidence-display.mjs';
import { formatVersionDetail } from '../cli-evaluation.mjs';
const model = { providerId: 'fixture', modelId: 'fixture', execution: 'rna', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 128000, maxOutputTokens: 4000 };
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-search-host-')), store = new Store(join(dir, 'state.json'));
  const { project } = store.createProject({ name: 'Search history integration', workspace: dir, initiative: { enabled: false } });
  const genomes = new ProjectGenomeStore(store), baseline = projectGenomeFixture(), candidate = structuredClone(baseline); candidate.systemPrompt = projectGenomeFixture({ candidate: true }).systemPrompt;
  const prepared = await genomes.prepare(project, { genome: baseline, versionId: project.activeVersionId }); await prepared.commit();
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); p.initialization = { status: 'ready' }; p.simulated = false; p.versions.find(row => row.id === p.activeVersionId).bundle = prepared.record; });
  const calls = [], service = new ProjectEvolutionService(store, { genomeStore: genomes, provider: genomeEvaluationProvider({ candidate, calls, ...options }) });
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, service, baseline, candidate, calls, projectId: project.id, project: () => store.state.projects.find(row => row.id === project.id) };
}

test('actual host author freezes policy, feeds only comparable selection history, keeps exact replay free and shares GUI/CLI facts', async t => {
  const f = await setup(t), original = f.service.provider; let authorCalls = 0;
  f.service.provider = async function* (request) {
    if (request.systemPrompt.includes('Create one improved executable project agent')) {
      authorCalls++; const input = JSON.parse(request.messages[0].content[0].text), pending = f.project().versions.at(-1);
      const audit = JSON.parse(await readFile(join(pending.artifactDir, 'search-policy.json'), 'utf8'));
      assert.equal(audit.summary.authorPolicyApplied, true); assert.equal(input.searchContext.maxChangedAssets, 4);
      assert.equal(input.searchContext.history.length, authorCalls === 1 ? 0 : 1);
      assert.doesNotMatch(JSON.stringify(input.searchContext), /baselineScore|candidateScore|hidden-answer|case_1|confirmation.*failed/);
      if (authorCalls > 1) assert.equal(input.searchContext.history[0].outcome, 'accepted');
    }
    yield* original(request);
  };
  const evidence = [{ id: 'work-one', summary: 'A confirmed workflow needs a more useful conclusion.' }];
  const first = await f.service.evolve(f.projectId, { model, evidence, learningReviewId: 'autonomous-review' });
  assert.equal(first.status, 'ready', JSON.stringify(first.version?.error)); assert.equal(first.version.searchReview.changedAssetCount, 1);
  assert.equal(first.version.searchFeedback.reason, 'selection_passed');
  const frozen = structuredClone(first.version), callCount = f.calls.length;
  assert.equal((await f.service.evolve(f.projectId, { model, evidence })).replayed, true); assert.equal(f.calls.length, callCount);
  const second = await f.service.evolve(f.projectId, { model, evidence: [{ id: 'work-two', summary: 'New actual task evidence.' }] });
  assert.equal(second.status, 'ready', JSON.stringify(second.version?.error)); assert.equal(authorCalls, 2);
  assert.notEqual(second.version.evaluationPartitions.planHash, first.version.evaluationPartitions.planHash); assert.equal(second.version.searchContext.comparisonKey, first.version.searchContext.comparisonKey);
  assert.deepEqual(second.version.searchSourceVersionIds, [first.version.id]); assert.deepEqual(f.project().versions.find(row => row.id === first.version.id), frozen);
  const view = evolutionSearchDisplay(second.version), cli = formatVersionDetail(f.project(), second.version);
  assert.ok(cli.includes(view.summary)); assert.ok(cli.includes(view.feedback)); assert.match(cli, /完整技能包/);
});

test('only three comparable fully exercised no-gain selections narrow search; failures and changed execution identities do not', async t => {
  const f = await setup(t), first = await f.service.evolve(f.projectId, { model, evidence: [{ id: 'work', summary: 'actual evidence' }] });
  assert.equal(first.status, 'ready'); const context = first.version.searchContext;
  const rows = [1, 2, 3].map(n => { const row = structuredClone(first.version); row.id = `no-gain-${n}`; row.evaluation.selection.candidateScore = row.evaluation.selection.baselineScore; row.evaluation.selection.gatePassed = false; row.evaluation.selection.gates.improvement = false; return row; });
  const project = { versions: rows }, original = structuredClone(project);
  let search = createEvolutionSearchPolicy(project, { baseline: f.baseline, context }); assert.equal(search.policy.maxChangedAssets, 1); assert.equal(search.summary.measured, 3); assert.deepEqual(project, original);
  const broken = structuredClone(rows.at(-1)); broken.id = 'provider-failure'; broken.state = 'failed'; broken.error = { code: 'provider_error', diagnostic: { phase: 'candidate' } }; project.versions.push(broken);
  search = createEvolutionSearchPolicy(project, { baseline: f.baseline, context }); assert.equal(search.policy.maxChangedAssets, 4); assert.equal(search.policy.history.at(-1).outcome, 'incomplete');
  const unknown = structuredClone(rows[0]); unknown.id = 'missing-receipts'; delete unknown.evaluation.details[0].candidate.exposure; delete unknown.evaluation.details[1].candidate.exposure; delete unknown.evaluation.details[2].candidate.exposure;
  assert.equal(describeEvolutionSearchOutcome(unknown, f.baseline).measured, false);
  for (const field of ['modelHash', 'evaluationRuntimeHash']) {
    const changed = createEvolutionSearchContext({ baseline: f.baseline, evidence: [], modelHash: context.modelHash, evaluationRuntimeHash: context.evaluationRuntimeHash, evaluationExecution: first.version.evaluationExecution, evaluationPartitions: first.version.evaluationPartitions, [field]: 'a'.repeat(64) });
    assert.equal(createEvolutionSearchPolicy(project, { baseline: f.baseline, context: changed }).policy.history.length, 0);
  }
  const revoked = { versions: rows.map(row => ({ ...row, sourceDeleted: true })) };
  assert.equal(createEvolutionSearchPolicy(revoked, { baseline: f.baseline, context }).policy.history.length, 0);
});

test('unobserved skill changes, confirmation-only exposure and infrastructure failures never become negative method evidence', async t => {
  const f = await setup(t), version = (await f.service.evolve(f.projectId, { model, evidence: [{ id: 'one', summary: 'retained evidence' }] })).version;
  const shadow = structuredClone(version); shadow.bundle.genome.skills[0].instructions += '\nAdded procedure.';
  assert.equal(describeEvolutionSearchOutcome(shadow, f.baseline).measured, false);
  const confirmation = structuredClone(version); confirmation.evaluation.confirmation = { status: 'failed', secret: 'hidden-answer' };
  const search = createEvolutionSearchPolicy({ versions: [confirmation] }, { baseline: f.baseline, context: version.searchContext });
  assert.equal(search.policy.history[0].outcome, 'accepted'); assert.doesNotMatch(JSON.stringify(search), /hidden-answer|confirmation.*failed/);
  for (const code of ['environment_unavailable', 'provider_error']) {
    const error = { ...version, evaluation: undefined, state: 'failed', error: { code, diagnostic: { phase: 'evaluation' } } };
    assert.equal(describeEvolutionSearchOutcome(error, f.baseline).measured, false);
  }
});

test('explicit retained-candidate retry bypasses author search and creates its own immutable attempt', async t => {
  const f = await setup(t, { failJudge: true }), evidence = [{ id: 'retry-work', summary: 'A valid author followed by an invalid judge.' }];
  const first = await f.service.evolve(f.projectId, { model, evidence }); assert.equal(first.status, 'failed');
  const saved = structuredClone(first.version), retryCalls = [];
  f.service.provider = genomeEvaluationProvider({ candidate: f.candidate, calls: retryCalls });
  const retried = await f.service.evolve(f.projectId, { model, evidence, retryVersionId: first.version.id });
  assert.equal(retried.status, 'ready', JSON.stringify(retried.version?.error)); assert.notEqual(retried.version.id, first.version.id);
  assert.equal(retried.version.searchSummary.authorPolicyApplied, false); assert.deepEqual(retried.version.searchSourceVersionIds, []);
  assert.equal(retryCalls.some(request => request.systemPrompt.includes('Create one improved executable project agent')), false);
  assert.deepEqual(f.project().versions.find(row => row.id === first.version.id), saved);
});

test('new frozen author sources preserve diagnostic history without claiming exact comparability or duplicate identity', async t => {
  const f = await setup(t), evidence = [{ id: 'shared-evidence', summary: 'A work receipt was retained.' }];
  const source = content => ({ schemaVersion: 1, evidence: [{ id: evidence[0].id, content }], files: [] });
  const first = await f.service.evolve(f.projectId, { model, evidence, learningContext: source('Actual original tool receipt.') });
  assert.equal(first.status, 'ready'); const original = f.service.provider; let seen = false;
  f.service.provider = async function* (request) {
    if (request.systemPrompt.includes('Create one improved executable project agent')) {
      const input = JSON.parse(request.messages[0].content[0].text); assert.equal(input.searchContext.history.length, 1);
      assert.equal(input.searchContext.history[0].outcome, 'not_evaluated'); seen = true;
    }
    yield* original(request);
  };
  const next = await f.service.evolve(f.projectId, { model, evidence, learningContext: source('A corrected tool receipt, new source bytes.') });
  assert.equal(next.status, 'ready', JSON.stringify(next.version?.error)); assert.equal(seen, true);
  assert.notEqual(next.version.searchContext.comparisonKey, first.version.searchContext.comparisonKey);
  assert.equal(next.version.searchContext.feedbackKey, first.version.searchContext.feedbackKey);
  assert.equal(next.version.searchSummary.maxChangedAssets, 4); assert.equal(next.version.searchSummary.measured, 0);
});

test('bounded author history retains measured attempts ahead of a wall of errors without removing durable versions', async t => {
  const f = await setup(t), first = (await f.service.evolve(f.projectId, { model, evidence: [{ id: 'observed', summary: 'Retained external receipt.' }] })).version;
  const rows = Array.from({ length: 12 }, (_, n) => ({ ...structuredClone(first), id: `measured-${n}` }));
  for (let n = 0; n < 40; n++) rows.push({ ...structuredClone(first), id: `error-${n}`, state: 'failed', error: { code: 'provider_error', diagnostic: { phase: 'candidate' } } });
  const project = { versions: rows }, before = structuredClone(project), result = createEvolutionSearchPolicy(project, { baseline: f.baseline, context: first.searchContext });
  assert.equal(result.policy.history.length, 12); assert.equal(result.policy.history.filter(row => row.outcome === 'accepted').length, 8);
  assert.equal(result.summary.historyTotal, 52); assert.equal(result.summary.historyOmitted, 40); assert.deepEqual(project, before);
});

test('an over-broad author draft retains search review and usage without buying a paired evaluation', async t => {
  const f = await setup(t), candidate = structuredClone(f.candidate), calls = [];
  for (let n = 0; n < 4; n++) candidate.skills.push({ ...structuredClone(candidate.skills[0]), id: `extra_${n}` });
  f.service.provider = genomeEvaluationProvider({ candidate, calls });
  const result = await f.service.evolve(f.projectId, { model, evidence: [{ id: 'broad', summary: 'A single method gap.' }] });
  assert.equal(result.status, 'failed'); assert.equal(result.version.searchReview.status, 'rejected');
  assert.ok(result.version.searchReview.reasons.includes('asset_scope_exceeded')); assert.equal(result.version.searchFeedback.measured, false);
  assert.ok(result.usage.totalTokens > 0); assert.ok(calls.every(request => request.systemPrompt.includes('Create one improved executable project agent')));
  assert.match(evolutionSearchDisplay(result.version).review, /改动范围超过本轮约束/);
});

test('search history revoked during admission releases the accepted reservation without dispatching a provider request', async t => {
  const f = await setup(t), first = await f.service.evolve(f.projectId, { model, evidence: [{ id: 'original', summary: 'First real retained receipt.' }] });
  assert.equal(first.status, 'ready'); const calls = f.calls.length, settled = []; let admissions = 0;
  const result = await f.service.evolve(f.projectId, { model, evidence: [{ id: 'new', summary: 'Another external work result.' }], requestControl: {
    beforeRequest: () => { admissions++; f.store.mutate(state => { state.projects.find(row => row.id === f.projectId).versions.find(row => row.id === first.version.id).contextRevoked = true; }); },
    onUsage: row => settled.push(row),
  } });
  assert.equal(result.status, 'failed'); assert.equal(result.version.error.code, 'search_source_revoked');
  assert.equal(admissions, 1); assert.equal(f.calls.length, calls); assert.equal(result.usage.totalTokens, 0);
  assert.equal(settled.length, 1); assert.equal(settled[0].cancelledBeforeSend, true); assert.equal(settled[0].requestStarted, false);
  assert.equal(result.version.bundle, undefined); assert.equal(result.version.proposal, undefined);
});

test('aggregate selection constraints and delivery reach future authors while confirmation and rubric data remain private', async t => {
  const f = await setup(t), version = (await f.service.evolve(f.projectId, { model, evidence: [{ id: 'selection-work', summary: 'A real completed work receipt.' }] })).version;
  const historical = structuredClone(version);
  historical.evaluation.selection.candidateScore = historical.evaluation.selection.baselineScore + .04;
  historical.evaluation.selection.gatePassed = false;
  historical.evaluation.selection.gates.improvement = false;
  historical.evaluation.selection.gates.tokenRatio = false;
  historical.evaluation.selection.gates['private-case-id'] = false;
  historical.evaluation.confirmation = { passed: false, reason: 'private-confirmation-answer' };
  const before = structuredClone(historical);
  const search = createEvolutionSearchPolicy({ versions: [historical] }, { baseline: f.baseline, context: version.searchContext });
  assert.deepEqual(search.policy.history[0].feedback.failedGates, ['improvement', 'tokenRatio']);
  assert.equal(search.policy.history[0].feedback.reason, 'selection_constraints_failed');
  assert.equal(search.policy.history[0].feedback.exposure.observed, search.policy.history[0].feedback.exposure.required);
  assert.doesNotMatch(JSON.stringify(search), /baselineScore|candidateScore|private-case-id|private-confirmation-answer/);
  assert.deepEqual(historical, before);
  const changed = createEvolutionSearchPolicy({ versions: [historical] }, { baseline: f.baseline, context: { ...version.searchContext, comparisonKey: 'f'.repeat(64) } });
  assert.equal(changed.policy.history[0].outcome, 'not_evaluated'); assert.equal(changed.policy.history[0].feedback.comparable, false);
});

test('a naturally unread changed skill produces a delivery diagnostic rather than a negative method judgment', async t => {
  const f = await setup(t); f.candidate.systemPrompt = f.baseline.systemPrompt;
  f.candidate.skills[0].instructions += '\nAn additional checked interpretation procedure.';
  const result = await f.service.evolve(f.projectId, { model, evidence: [{ id: 'unread-work', summary: 'The next ordinary task may benefit from a source review.' }] });
  assert.equal(result.status, 'rejected', JSON.stringify(result.version?.error));
  const feedback = createEvolutionSearchPolicy({ versions: [result.version] }, { baseline: f.baseline, context: result.version.searchContext }).policy.history[0].feedback;
  assert.equal(feedback.reason, 'changes_not_exercised'); assert.equal(feedback.failedGates, undefined);
  assert.equal(feedback.exposure.observed, 0); assert.equal(feedback.exposure.unobserved, 1);
  assert.equal(result.version.searchFeedback.measured, false);
});

test('author abstention contributes a separate diagnostic without inventing candidate or measured history', async t => {
  const f = await setup(t), version = (await f.service.evolve(f.projectId, { model, evidence: [{ id: 'old-work', summary: 'A checked earlier work receipt.' }] })).version;
  const stopped = { ...structuredClone(version), id: 'author-stop', state: 'no_change', bundle: undefined, proposal: undefined, evaluation: undefined, authorAbstention: { reason: 'insufficient_evidence' } };
  const result = createEvolutionSearchPolicy({ versions: [stopped] }, { baseline: f.baseline, context: version.searchContext });
  assert.equal(result.policy.history.length, 0); assert.equal(result.summary.historyTotal, 1); assert.equal(result.summary.measured, 0);
  assert.equal(result.summary.recentFeedback[0].reason, 'author_no_change');
  assert.equal(result.summary.recentFeedback[0].outcome, 'not_evaluated');
});
