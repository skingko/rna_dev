import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { ProjectEvolutionService } from '../test-support/marketplace-isolation.mjs';
import { PROJECT_EVALUATION_RUNTIME_HASH } from '../../../packages/sdk/src/project-evolution.mjs';
import { getProjectEvolutionIdentity, getEvolutionEvidenceCoverage } from '../project-evolution-identity.mjs';
import { describeEvolutionAssessment } from '../project-evolution-assessment.mjs';
import { projectGenomeFixture, genomeEvaluationProvider, diagnosisFixture } from '../../../packages/sdk/test/fixtures/project-genome.mjs';
import { evolutionHash } from '../../../packages/sdk/src/evolution.mjs';

const model = { providerId: 'local-fixture', modelId: 'fixture', execution: 'rna', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 128000, maxOutputTokens: 4000, reasoning: 'off' };
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-evolution-service-')); const store = new Store(join(dir, 'state.json'));
  const { project } = store.createProject({ name: 'Executable evolution', workspace: dir, initiative: { enabled: false } });
  const genomes = new ProjectGenomeStore(store), prepared = await genomes.prepare(project, { genome: projectGenomeFixture(), versionId: project.activeVersionId }); await prepared.commit();
  store.mutate(state => { const current = state.projects.find(item => item.id === project.id); current.simulated = false; current.decisionMode = 'rna-model'; current.initialization = { status: 'ready' }; current.versions.find(version => version.id === current.activeVersionId).bundle = prepared.record; });
  await writeFile(join(dir, 'user-project.txt'), 'unchanged user data');
  const calls = [], service = new ProjectEvolutionService(store, { genomeStore: genomes, provider: genomeEvaluationProvider({ calls, ...options }) });
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, service, calls, projectId: project.id, baselineId: project.activeVersionId, current: () => store.state.projects.find(item => item.id === project.id) };
}

test('a subsequent author receives prior real intervention exposure without scores, frozen tasks or fabricated new evidence', async t => {
  const app = await setup(t);
  const first = await app.service.evolve(app.projectId, { model, evidence: [{ id: 'first-work-receipt', summary: 'A checked work result supports testing the method.' }] });
  assert.equal(first.status, 'ready'); assert.ok(first.version.evaluation.exposure.candidate.counts.observed > 0);
  const original = app.service.provider, fresh = [{ id: 'new-user-correction', summary: 'A later user correction reveals a distinct method gap.' }]; let authors = 0;
  app.service.provider = async function* (request) {
    if (request.systemPrompt.includes('Create one improved executable project agent')) {
      authors++; const input = JSON.parse(request.messages[0].content[0].text), prior = input.project.evaluationAudit.find(row => row.versionId === first.version.id);
      assert.ok(prior); assert.equal(prior.exposure.isExternalEvidence, false); assert.equal(prior.exposure.causalClaim, 'none');
      assert.ok(prior.exposure.unobservedTargets.some(row => row.target === 'evidence_review')); assert.ok(prior.exposure.changedAreas.some(row => row.area === 'tool_execution'));
      assert.deepEqual(input.evidence, fresh); assert.doesNotMatch(JSON.stringify(input.project.evaluationAudit), /candidateScore|baselineScore|case_1|Check project input/);
      assert.match(request.systemPrompt, /do not force every skill\/resource to load/);
    }
    yield* original(request);
  };
  const next = await app.service.evolve(app.projectId, { model, evidence: fresh }); assert.equal(next.status, 'ready'); assert.equal(authors, 1);
});

test('candidate authors read an audited frozen source snapshot with configured secrets removed, while evaluators cannot access it', async t => {
  const app = await setup(t), evidence = [{ id: 'work:source', summary: 'A tool failure was described as a completed task.' }];
  const secret = 'fixture-key/with-sensitive-value'; app.store.configurationService.secrets.fixture = secret;
  const learningContext = { schemaVersion: 1, evidence: [{ id: 'work:source', content: JSON.stringify({ status: 'failed', output: `oldText matched twice; token=${secret}` }) }], files: [{ path: 'src/task.js', content: `export const boundary = 'complete-batch'; // ${encodeURIComponent(secret)}` }] };
  const original = app.service.provider; let authorRequests = 0, verifiedAudit = false;
  app.service.provider = async function* (request) {
    assert.equal(JSON.stringify(request).includes(secret), false); assert.equal(JSON.stringify(request).includes(encodeURIComponent(secret)), false);
    if (request.systemPrompt.includes('Create one improved executable project agent')) {
      authorRequests++;
      if (!request.messages.some(message => message.role === 'toolResult')) {
        const pending = app.current().versions.at(-1), audit = JSON.parse(await readFile(join(pending.artifactDir, 'learning-context.json'), 'utf8'));
        assert.equal(pending.learningReviewId, 'review-source-fixture');
        assert.equal(audit.contextHash, pending.learningContextHash); assert.equal(audit.scope, 'frozen_authoring_sources_only');
        assert.equal(audit.evidence[0].content.includes('[REDACTED]'), true); assert.equal(audit.files[0].content.includes('[REDACTED]'), true); verifiedAudit = true;
        learningContext.files[0].content = 'external source changed after claim';
        yield { type: 'tool_call', id: 'read-frozen-source', name: 'learning_context_read', arguments: { id: 'file:src/task.js' } };
        yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: 'toolUse' }; return;
      }
      assert.match(request.messages.find(message => message.role === 'toolResult').content[0].text, /complete-batch/);
    } else assert.equal(request.tools?.some(tool => tool.name.startsWith('learning_context_')) ?? false, false);
    yield* original(request);
  };
  const result = await app.service.evolve(app.projectId, { model, evidence, learningContext, learningReviewId: 'review-source-fixture' });
  assert.equal(result.status, 'ready', JSON.stringify(result.version?.error)); assert.equal(verifiedAudit, true); assert.equal(authorRequests, 2);
  assert.equal(result.version.learningContextReads.length, 1); assert.equal(result.version.learningContextSources.length, 2); assert.equal(result.version.learningContextSources.some(row => 'content' in row), false);
  const audit = JSON.parse(await readFile(join(result.version.artifactDir, 'proposal-validation.json'), 'utf8'));
  assert.equal(audit.learningContextReads[0].contextHash, result.version.learningContextHash);
  assert.deepEqual(result.version.evaluation.suite, projectGenomeFixture().evaluationSuite); assert.equal(app.current().activeVersionId, app.baselineId);
});

test('failed author finalization retains source read receipts on both the immutable failed version and private failure audit', async t => {
  const app = await setup(t), evidence = [{ id: 'author-boundary', summary: 'An actual completion boundary was missed.' }];
  const learningContext = { schemaVersion: 1, evidence: [{ id: 'author-boundary', content: 'The actual tool result was incomplete.' }], files: [{ path: 'source.js', content: 'const recorded = true;' }] };
  let calls = 0;
  app.service.provider = async function* (request) {
    calls++;
    yield { type: 'tool_call', id: `read-${calls}`, name: 'learning_context_read', arguments: { id: 'file:source.js' } };
    yield { type: 'usage', usage: { totalTokens: 12 } }; yield { type: 'done', stopReason: 'toolUse' };
  };
  const result = await app.service.evolve(app.projectId, { model, evidence, learningContext });
  assert.equal(result.status, 'failed'); assert.equal(result.version.error.code, 'step_limit'); assert.equal(calls, 6);
  assert.equal(result.version.learningContextReads.length, 5); assert.equal(result.usage.totalTokens, 72); assert.equal(result.version.proposal, undefined); assert.equal(result.version.bundle, undefined);
  const audit = JSON.parse(await readFile(join(result.version.artifactDir, 'failure.json'), 'utf8'));
  assert.deepEqual(audit.learningContextReads, result.version.learningContextReads); assert.equal(audit.requests.length, 6);
  const original = structuredClone(result.version); const duplicate = await app.service.evolve(app.projectId, { model, evidence, learningContext });
  assert.equal(duplicate.replayed, true); assert.equal(calls, 6); assert.deepEqual(app.current().versions.find(version => version.id === original.id), original); assert.equal(app.current().activeVersionId, app.baselineId);
});

test('exact frozen evidence is privately persisted before author dispatch and is independent of caller mutation', async t => {
  const app = await setup(t), evidence = [{ id: 'frozen-external', type: 'tool_result', summary: 'Original exact result', at: 123, detail: { status: 'failed', sourceIds: ['session:source'] } }], expected = structuredClone(evidence);
  const original = app.service.provider; let audit;
  app.service.provider = async function* (request) {
    if (!audit) {
      const pending = app.current().versions.at(-1), path = join(pending.artifactDir, 'evidence.json');
      audit = JSON.parse(await readFile(path, 'utf8'));
      assert.equal((await stat(path)).mode & 0o777, 0o600); assert.deepEqual(audit.evidence, expected); assert.equal(audit.snapshotHash, evolutionHash(expected)); assert.equal(audit.evidenceHash, pending.evidenceHash); assert.deepEqual(audit.evidenceFingerprints, pending.evidenceFingerprints);
      evidence[0].summary = 'Caller changed evidence after admission'; evidence[0].detail.status = 'successful';
      assert.deepEqual(JSON.parse(request.messages[0].content[0].text).evidence, expected);
    }
    yield* original(request);
  };
  const result = await app.service.evolve(app.projectId, { model, evidence }); assert.equal(result.status, 'ready');
  assert.deepEqual(JSON.parse(await readFile(join(result.version.artifactDir, 'evidence.json'), 'utf8')), audit);
});

test('source identity deduplicates reordered snapshots and admits an actual changed receipt without altering prior evaluation', async t => {
  const app = await setup(t), evidence = [{ id: 'frozen-event', summary: 'Inspect the recorded source behavior.' }];
  const learningContext = { schemaVersion: 1, evidence: [{ id: 'frozen-event', content: '{"exitCode":1}' }], files: [{ path: 'a.js', content: 'const a=1;' }, { path: 'b.js', content: 'const b=2;' }] };
  const first = await app.service.evolve(app.projectId, { model, evidence, learningContext }), calls = app.calls.length;
  assert.equal(first.status, 'ready'); const saved = structuredClone(first.version);
  learningContext.files.reverse();
  const same = await app.service.evolve(app.projectId, { model, evidence, learningContext }); assert.equal(same.replayed, true); assert.equal(app.calls.length, calls);
  learningContext.evidence[0].content = '{"exitCode":0}';
  const changed = await app.service.evolve(app.projectId, { model, evidence, learningContext }); assert.equal(changed.status, 'ready'); assert.notEqual(changed.version.learningContextHash, first.version.learningContextHash); assert.notEqual(changed.version.inputFingerprint, first.version.inputFingerprint);
  assert.deepEqual(app.current().versions.find(version => version.id === first.version.id), saved);
  const identity = getProjectEvolutionIdentity(app.current(), { model, evidence, learningContextHash: changed.version.learningContextHash }); assert.equal(identity.inputFingerprint, changed.version.inputFingerprint);
  assert.equal(getEvolutionEvidenceCoverage(app.current(), identity).hasNewEvidence, false);
});

test('private or unbound author source snapshots are rejected before any candidate or paid request', async t => {
  const app = await setup(t), before = app.current().versions.length;
  for (const learningContext of [{ schemaVersion: 1, evidence: [], files: [{ path: '.state/state.json', content: 'private' }] }, { schemaVersion: 1, evidence: [{ id: 'unknown', content: 'unsupported' }], files: [] }]) {
    await assert.rejects(app.service.evolve(app.projectId, { model, evidence: [], learningContext }), { code: 'invalid_learning_context' });
    assert.equal(app.calls.length, 0); assert.equal(app.current().versions.length, before); assert.equal(app.service.running.size, 0);
  }
});

test('a revoked source cannot be retried, newly trialled or adopted even when its historical gates passed', async t => {
  const app = await setup(t), result = await app.service.evolve(app.projectId, { model, evidence: [{ id: 'will-delete', summary: 'Evidence present during evaluation.' }] });
  assert.equal(result.status, 'ready');
  app.store.mutate(state => { const version = state.projects.find(project => project.id === app.projectId).versions.find(version => version.id === result.version.id); version.sourceDeleted = true; version.contextRevoked = true; });
  const version = app.current().versions.find(version => version.id === result.version.id), assessment = describeEvolutionAssessment(version, { activeVersionId: app.baselineId });
  assert.equal(assessment.category, 'source_deleted'); assert.equal(assessment.retry.available, false); assert.ok(version.bundle);
  assert.throws(() => app.service.retrySource(app.current(), version.id), { code: 'retry_source_deleted' });
  for (const action of ['trial', 'adopt']) assert.throws(() => app.store.version(app.projectId, version.id, action), /来源会话已删除/);
  assert.equal(app.current().activeVersionId, app.baselineId);
});

test('each model reservation and settlement share one unique durable request ID', async t => {
  const app = await setup(t), admitted = [], settled = [];
  const result = await app.service.evolve(app.projectId, { model, evidence: [{ id: 'metered', summary: 'Check actual receipts.' }], requestControl: { beforeRequest: request => admitted.push(request.id), onUsage: receipt => settled.push(receipt.id) } });
  assert.equal(result.status, 'ready'); assert.equal(admitted.length, 16); assert.equal(new Set(admitted).size, admitted.length); assert.deepEqual(settled, admitted); assert.ok(admitted.every(id => /^[a-f0-9-]{36}$/.test(id)));
});

test('learning intent is audited before author dispatch and rewording it cannot purchase another evaluation', async t => {
  const app = await setup(t), evidence = [{ id: 'checked-result', type: 'work_result', summary: 'An observed interpretation gap.' }];
  const learningIntent = { content: 'Improve the interpretation method.', reason: 'Test whether checked values are connected to decisions.', evidenceIds: ['checked-result'] };
  const ordinary = app.service.provider; let verifiedAudit = false;
  app.service.provider = async function* (request) {
    if (request.systemPrompt.includes('Create one improved executable project agent')) {
      const pending = app.current().versions.at(-1), audit = JSON.parse(await readFile(join(pending.artifactDir, 'learning-intent.json'), 'utf8'));
      assert.deepEqual(audit, { schemaVersion: 1, status: 'unverified_hypothesis', learningIntent, externalEvidence: false, affectsEvidenceIdentity: false }); verifiedAudit = true;
      assert.deepEqual(JSON.parse(request.messages[0].content[0].text).learningIntent, { ...learningIntent, status: 'unverified_hypothesis' });
    }
    yield* ordinary(request);
  };
  const first = await app.service.evolve(app.projectId, { model, evidence, learningIntent }); assert.equal(first.status, 'ready'); assert.equal(verifiedAudit, true);
  assert.deepEqual(first.version.learningIntent, learningIntent); assert.equal(first.version.inputFingerprint, getProjectEvolutionIdentity(app.current(), { model, evidence }).inputFingerprint);
  const frozen = JSON.parse(await readFile(join(first.version.artifactDir, 'frozen-evaluation.json'), 'utf8')); assert.deepEqual(frozen.suite, projectGenomeFixture().evaluationSuite);
  const count = app.calls.length, versions = app.current().versions.length, modified = { ...learningIntent, content: 'Try a differently worded improvement.', reason: 'This is another hypothesis, not new external evidence.' };
  const replay = await app.service.evolve(app.projectId, { model, evidence, learningIntent: modified });
  assert.equal(replay.replayed, true); assert.equal(replay.usage.totalTokens, 0); assert.equal(app.calls.length, count); assert.equal(app.current().versions.length, versions); assert.deepEqual(replay.version.learningIntent, learningIntent);
  const persisted = new Store(app.store.file).state.projects.find(project => project.id === app.projectId).versions.find(version => version.id === first.version.id); assert.deepEqual(persisted.learningIntent, learningIntent);
});

test('an intent citing unknown evidence cannot create a candidate, reserve usage or contact a provider', async t => {
  const app = await setup(t), count = app.current().versions.length; let admissions = 0;
  await assert.rejects(app.service.evolve(app.projectId, { model, evidence: [{ id: 'allowed' }], learningIntent: { content: 'Improve a method.', reason: 'Claimed support.', evidenceIds: ['invented'] }, requestControl: { beforeRequest() { admissions++; } } }), { code: 'invalid_learning_intent' });
  assert.equal(app.calls.length, 0); assert.equal(admissions, 0); assert.equal(app.current().versions.length, count); assert.equal(app.service.running.size, 0);
});
test('autonomous evolution generates and executes scripts, persists comparison evidence, and publishes only a ready immutable version', async t => {
  const app = await setup(t), result = await app.service.evolve(app.projectId, { evidence: [{ id: 'human-observation', summary: 'Need precise actionable evidence' }], model, tokenBudget: null });
  assert.equal(result.status, 'ready', JSON.stringify(result.version?.error)); assert.equal(result.version.evaluation.gatePassed, true); assert.equal(result.version.bundle.genome.systemPrompt.startsWith('CANDIDATE_AGENT'), true);
  assert.equal(result.usage.totalTokens, 480); assert.equal(app.calls.length, 16); assert.equal(app.current().activeVersionId, app.baselineId); assert.equal(app.current().trialVersionId, null);
  assert.deepEqual(result.version.proposal.diagnosis, diagnosisFixture()); assert.equal(result.version.assessment.coverage.workspaceCases, 0);
  assert.equal(result.version.evaluationRuntimeHash, PROJECT_EVALUATION_RUNTIME_HASH); assert.equal(result.version.evaluation.evaluationRuntimeHash, PROJECT_EVALUATION_RUNTIME_HASH);
  assert.equal(app.current().evolution.lastEvaluatedAt, result.version.evaluation.completedAt);
  const report = JSON.parse(await readFile(join(result.version.artifactDir, 'evaluation.json'), 'utf8')); assert.equal(report.cases, 3); assert.ok(report.details.every(row => row.candidate.toolResults.length === 1));
  assert.match(await readFile(join(result.version.bundle.dir, 'tools', 'evidence_helper.mjs'), 'utf8'), /const doubled/); assert.equal(await readFile(join(app.dir, 'user-project.txt'), 'utf8'), 'unchanged user data');
  const before = app.calls.length, replay = await app.service.evolve(app.projectId, { evidence: [{ id: 'human-observation', summary: 'Need precise actionable evidence' }], model }); assert.equal(replay.replayed, true); assert.equal(app.calls.length, before);
});

test('failed reference auditing retains actual proposal usage and cannot publish or continue paid comparison', async t => {
  const app = await setup(t); let calls = 0;
  const original = app.service.provider; app.service.provider = async function* (options) { calls++; yield* original(options); };
  app.service.marketplaces = { authoring: () => ({ tools: [], context: () => undefined, snapshot: () => { throw new Error('fixture audit unavailable'); } }) };
  const result = await app.service.evolve(app.projectId, { evidence: [{ id: 'audit-source', summary: 'Improve source checking' }], model });
  assert.equal(result.status, 'failed'); assert.equal(result.version.error.code, 'reference_audit_failed'); assert.equal(calls, 1); assert.equal(result.usage.totalTokens, 30); assert.equal(result.version.bundle, undefined); assert.equal(app.current().activeVersionId, app.baselineId);
  assert.equal(app.current().evolution.lastEvaluatedAt, null, 'a proposal without actual evaluation is not an evaluation receipt');
});
test('manual edits use the same frozen baseline evaluator and failed gates retain files without allowing trial', async t => {
  const app = await setup(t, { badCandidate: true }), result = await app.service.evolve(app.projectId, { genome: projectGenomeFixture({ candidate: true }), summary: 'Edited candidate', model });
  assert.equal(result.status, 'rejected'); assert.equal(result.version.evaluation.gatePassed, false); assert.equal(result.version.bundle.genome.systemPrompt.startsWith('CANDIDATE_AGENT'), true); assert.ok(await readFile(join(result.version.artifactDir, 'evaluation.json')));
  assert.equal(app.current().activeVersionId, app.baselineId); assert.throws(() => app.store.version(app.projectId, result.version.id, 'trial'));
  assert.equal(app.calls.length, 4, 'Manual edits stop before judging the first deterministically failing pair'); assert.equal(result.version.evaluation.skippedCases, 2);
  assert.equal(app.current().evolution.lastEvaluatedAt, result.version.evaluation.completedAt, 'a real rejected evaluation is still an evaluation');
});
test('provider/judge failure persists failed version and evidence, never marks an unevaluated candidate ready', async t => {
  const app = await setup(t, { failJudge: true }), result = await app.service.evolve(app.projectId, { model, evidence: [{ id: 'failure-case' }] });
  assert.equal(result.status, 'failed'); assert.equal(result.version.bundle, undefined); assert.equal(result.version.evaluation, null); assert.ok(result.usage.totalTokens > 0);
  const failed = JSON.parse(await readFile(join(result.version.artifactDir, 'failure.json'), 'utf8')); assert.equal(failed.code, 'invalid_judge'); assert.deepEqual(failed.diagnostic.missingCriterionIds, ['evidence']); assert.equal(app.current().activeVersionId, app.baselineId);
  assert.equal(result.version.assessment.category, 'evaluation_error'); assert.equal(result.version.assessment.stage, 'judge'); assert.equal(result.version.assessment.retry.available, true);
  assert.equal(app.current().evolution.lastEvaluatedAt, null, 'an invalid judge is not a completed evaluation');
});

test('canonical evidence receipts survive restart and changed meaning can run once without timestamp/order billing loops', async t => {
  const app = await setup(t, { badCandidate: true });
  const evidence = [{ id: 'a', type: 'feedback', summary: 'An externally observed error.', at: 100 }, { id: 'b', type: 'tool_result', summary: 'Independent execution evidence.', at: 200 }];
  const first = await app.service.evolve(app.projectId, { model, evidence }); assert.equal(first.status, 'rejected');
  const identity = getProjectEvolutionIdentity(app.current(), { model, evidence }), calls = app.calls.length, evaluatedAt = app.current().evolution.lastEvaluatedAt;
  assert.equal(first.version.inputFingerprint, identity.inputFingerprint); assert.equal(first.version.evidenceIdentityVersion, 1); assert.deepEqual(first.version.evidenceFingerprints, identity.evidenceFingerprints);
  const repeated = await app.service.evolve(app.projectId, { model, evidence: [{ ...evidence[1], at: 9000 }, { ...evidence[0], at: 9999 }, { ...evidence[0], at: 9999 }] });
  assert.equal(repeated.replayed, true); assert.equal(repeated.usage.totalTokens, 0); assert.equal(app.calls.length, calls); assert.equal(app.current().evolution.lastEvaluatedAt, evaluatedAt);
  const reloaded = new Store(app.store.file), persisted = reloaded.state.projects.find(p => p.id === app.projectId);
  assert.equal(getEvolutionEvidenceCoverage(persisted, getProjectEvolutionIdentity(persisted, { model, evidence: [evidence[0]] })).hasNewEvidence, false);
  const changed = [{ ...evidence[0], summary: 'A new check established that the prerequisite has recovered.' }, evidence[1]];
  assert.equal(getEvolutionEvidenceCoverage(app.current(), getProjectEvolutionIdentity(app.current(), { model, evidence: changed })).hasNewEvidence, true);
  const next = await app.service.evolve(app.projectId, { model, evidence: changed }); assert.equal(next.status, 'rejected'); assert.notEqual(next.version.id, first.version.id); assert.ok(app.calls.length > calls);
  const after = app.calls.length, duplicate = await app.service.evolve(app.projectId, { model, evidence: changed.toReversed() });
  assert.equal(duplicate.replayed, true); assert.equal(app.calls.length, after); assert.equal(getEvolutionEvidenceCoverage(app.current(), getProjectEvolutionIdentity(app.current(), { model, evidence: changed })).hasNewEvidence, false);
});

test('explicit retry re-evaluates the same hashed candidate and frozen baseline in a new record', async t => {
  const app = await setup(t, { failJudge: true }), first = await app.service.evolve(app.projectId, { model });
  const original = structuredClone(first.version), calls = [];
  app.service.provider = genomeEvaluationProvider({ calls });
  const retried = await app.service.evolve(app.projectId, { model, retryVersionId: first.version.id });
  assert.equal(retried.status, 'ready'); assert.equal(retried.version.retryOfVersionId, first.version.id);
  assert.equal(retried.version.candidateHash, original.candidateHash); assert.equal(retried.version.baselineHash, original.baselineHash);
  assert.equal(calls.length, 15); assert.ok(!calls.some(request => request.systemPrompt.includes('Create one improved')));
  assert.deepEqual(app.current().versions.find(version => version.id === first.version.id), original);
  assert.equal(app.current().activeVersionId, app.baselineId);
});
test('retry refuses changed candidate artifacts, stale baseline and deterministic failure without model calls', async t => {
  const app = await setup(t, { failJudge: true }), first = await app.service.evolve(app.projectId, { model });
  app.service.provider = async function* () { assert.fail('Invalid retry must not contact a provider'); };
  const path = join(first.version.artifactDir, 'proposal.json'), proposal = JSON.parse(await readFile(path, 'utf8')); proposal.genome.systemPrompt += ' changed'; await writeFile(path, JSON.stringify(proposal));
  await assert.rejects(app.service.evolve(app.projectId, { model, retryVersionId: first.version.id }), { code: 'retry_evidence_changed' });
  app.store.mutate(state => { const version = state.projects.find(p => p.id === app.projectId).versions.find(v => v.id === first.version.id); version.baselineHash = 'changed'; });
  await assert.rejects(app.service.evolve(app.projectId, { model, retryVersionId: first.version.id }), { code: 'retry_baseline_changed' });
  const rejected = { ...originalFailure(), id: 'rejected', parentVersionId: app.baselineId };
  assert.throws(() => app.service.retrySource({ ...app.current(), versions: [rejected] }, 'rejected'), { code: 'retry_unavailable' });
  function originalFailure() { return { simulated: false, state: 'rejected', evaluationRuntimeHash: PROJECT_EVALUATION_RUNTIME_HASH, bundle: { hash: 'retained' }, evaluation: { gatePassed: false, earlyStopReason: 'candidate_smoke_failed' } }; }
});

test('changed evaluator is one new input, never a false replay or an unbounded same-runtime retry', async t => {
  const app = await setup(t), genome = projectGenomeFixture({ candidate: true }), first = await app.service.evolve(app.projectId, { genome, model });
  app.store.mutate(state => { const version = state.projects.find(p => p.id === app.projectId).versions.find(v => v.id === first.version.id); version.evaluationRuntimeHash = 'previous-runtime'; version.evaluation.evaluationRuntimeHash = 'previous-runtime'; });
  const old = structuredClone(app.current().versions.find(v => v.id === first.version.id)), before = app.calls.length;
  const next = await app.service.evolve(app.projectId, { genome, model }); assert.equal(next.replayed, undefined); assert.notEqual(next.version.id, first.version.id); assert.equal(next.version.evaluationRuntimeHash, PROJECT_EVALUATION_RUNTIME_HASH); assert.equal(app.calls.length, before + 15);
  const frozen = JSON.parse(await readFile(join(next.version.artifactDir, 'frozen-evaluation.json'), 'utf8')); assert.equal(frozen.evaluationRuntimeHash, PROJECT_EVALUATION_RUNTIME_HASH);
  const repeat = await app.service.evolve(app.projectId, { genome, model }); assert.equal(repeat.replayed, true); assert.equal(app.calls.length, before + 15);
  assert.deepEqual(app.current().versions.find(v => v.id === first.version.id), old);
});

test('explicit retry under a changed evaluator keeps rejected genome and baseline hashes and preserves prior failure', async t => {
  const app = await setup(t, { badCandidate: true }), first = await app.service.evolve(app.projectId, { genome: projectGenomeFixture({ candidate: true }), model }); assert.equal(first.status, 'rejected');
  app.store.mutate(state => { const version = state.projects.find(p => p.id === app.projectId).versions.find(v => v.id === first.version.id); version.evaluationRuntimeHash = 'previous-runtime'; version.evaluation.evaluationRuntimeHash = 'previous-runtime'; });
  const previous = structuredClone(app.current().versions.find(v => v.id === first.version.id)), calls = []; app.service.provider = genomeEvaluationProvider({ calls });
  const result = await app.service.evolve(app.projectId, { model, retryVersionId: first.version.id }); assert.equal(result.status, 'ready'); assert.equal(result.version.priorEvaluationRuntimeHash, 'previous-runtime'); assert.equal(result.version.evaluationRuntimeHash, PROJECT_EVALUATION_RUNTIME_HASH);
  assert.equal(result.version.candidateHash, previous.candidateHash); assert.equal(result.version.baselineHash, previous.baselineHash); assert.equal(calls.length, 15); assert.deepEqual(app.current().versions.find(v => v.id === first.version.id), previous);
});
test('late guard rejection preserves evidence and cannot publish a ready bundle or change the baseline', async t => {
  const app = await setup(t); let allowed = true;
  const result = await app.service.evolve(app.projectId, { model, genome: projectGenomeFixture({ candidate: true }), commitGuard: () => allowed, onProgress: event => { if (event.type === 'evaluation_case_completed' && event.case.id === 'case_3') allowed = false; } });
  assert.equal(result.status, 'stale'); assert.equal(result.version.bundle, undefined); assert.equal(app.current().activeVersionId, app.baselineId); assert.equal(app.current().trialVersionId, null);
});

test('restart marks only unfinished real evolution interrupted, retains trace and never repeats model calls', async t => {
  const app = await setup(t), traceFile = join(app.dir, 'retained-evolution-trace.jsonl');
  await writeFile(traceFile, '{"type":"evaluation_executions_completed"}\n');
  app.store.mutate(state => {
    const current = state.projects.find(row => row.id === app.projectId);
    for (const [id, status, simulated] of [['pending-proposal', 'proposing', false], ['pending-evaluation', 'evaluating', false], ['finished-ready', 'ready', false], ['finished-rejected', 'rejected', false], ['demo-pending', 'evaluating', true]]) current.versions.push({ id, state: status, simulated, artifactDir: traceFile });
    current.evolution.request = { id: 'old-manual-request', status: 'running', startedAt: '2026-01-01T00:00:00.000Z' };
  });
  const reloaded = new Store(app.store.file), service = new ProjectEvolutionService(reloaded, { provider: async function* () { assert.fail('Restart must never dispatch a provider'); } });
  t.after(() => service.close());
  const project = reloaded.state.projects.find(row => row.id === app.projectId), states = Object.fromEntries(project.versions.map(version => [version.id, version.state]));
  assert.equal(states['pending-proposal'], 'interrupted'); assert.equal(states['pending-evaluation'], 'interrupted');
  assert.equal(states['finished-ready'], 'ready'); assert.equal(states['finished-rejected'], 'rejected'); assert.equal(states['demo-pending'], 'evaluating');
  assert.equal(project.evolution.request.status, 'interrupted'); assert.equal(project.activeVersionId, app.baselineId);
  assert.match(await readFile(traceFile, 'utf8'), /evaluation_executions_completed/); assert.equal(service.running.size, 0); assert.equal(app.calls.length, 0);
});

test('failed evidence is idempotent across restart, while explicit retry, changed model or new external evidence can run again', async t => {
  const app = await setup(t, { badCandidate: true }), evidence = [{ id: 'external-feedback', summary: 'A user observed missing evidence.' }];
  const first = await app.service.evolve(app.projectId, { model, evidence }); assert.equal(first.status, 'rejected'); assert.equal(app.calls.length, 5);
  const versionCount = app.current().versions.length, calls = app.calls.length;
  const duplicate = await app.service.evolve(app.projectId, { model, evidence }); assert.equal(duplicate.replayed, true); assert.equal(duplicate.version.id, first.version.id); assert.equal(duplicate.usage.totalTokens, 0); assert.equal(app.calls.length, calls); assert.equal(app.current().versions.length, versionCount);
  const reloaded = new Store(app.store.file), afterRestart = new ProjectEvolutionService(reloaded, { provider: async function* () { assert.fail('Restart and unchanged external evidence must not create another model bill'); } }); t.after(() => afterRestart.close());
  const reloadedResult = await afterRestart.evolve(app.projectId, { model, evidence }); assert.equal(reloadedResult.replayed, true); assert.equal(reloadedResult.version.id, first.version.id);
  const retried = await app.service.evolve(app.projectId, { model, evidence, retryFailed: true }); assert.equal(retried.status, 'rejected'); assert.notEqual(retried.version.id, first.version.id); assert.equal(app.calls.length, calls + 5);
  const modelChange = await app.service.evolve(app.projectId, { model: { ...model, modelId: 'different-model' }, evidence }); assert.notEqual(modelChange.version.id, retried.version.id); assert.equal(app.calls.length, calls + 10);
  const newEvidence = await app.service.evolve(app.projectId, { model, evidence: [...evidence, { id: 'new-user-feedback', summary: 'A new externally observed failure.' }] }); assert.notEqual(newEvidence.version.id, retried.version.id); assert.equal(app.calls.length, calls + 15);
});
test('bounded candidate repair artifacts survive rejection without duplicate charges or changing the active bundle', async t => {
  const app = await setup(t), candidate = projectGenomeFixture({ candidate: true }); candidate.tools[0].script = 'return {doubled:99};'; let requests = 0;
  app.service.provider = async function* (request) {
    requests++;
    const result = request.systemPrompt.includes('Create one improved') ? { summary: 'Broken draft', hypothesis: 'Candidate behavior should improve', diagnosis: diagnosisFixture(), changes: ['Change helper'], genome: candidate } : { tools: [{ id: 'evidence_helper', script: candidate.tools[0].script }], smokeRepairs: [] };
    yield { type: 'text_delta', delta: JSON.stringify(result) }; yield { type: 'usage', usage: { input: 20, output: 10, totalTokens: 30 } }; yield { type: 'done', stopReason: 'stop' };
  };
  const result = await app.service.evolve(app.projectId, { model, evidence: [{ id: 'script-failure' }] });
  assert.equal(result.status, 'rejected'); assert.equal(requests, 2); assert.equal(result.usage.totalTokens, 60); assert.equal(result.version.proposalAttempts, 2); assert.equal(result.version.proposalEarlyStopReason, 'unchanged_repair'); assert.equal(result.version.evaluation.candidateScore, null); assert.equal(result.version.evaluation.requests.length, 0); assert.equal(app.current().activeVersionId, app.baselineId);
  const audit = JSON.parse(await readFile(join(result.version.artifactDir, 'proposal-validation.json'), 'utf8')); assert.equal(audit.repairEvidence.length, 2); assert.equal(audit.earlyStopReason, 'unchanged_repair'); assert.equal(audit.repairEvidence[0].validation.smoke.results[0].actual.doubled, 99); assert.equal(audit.repairEvidence[1].validation.frozenSmoke[0].passed, false); assert.equal(audit.repairEvidence[1].error.code, 'unchanged_repair');
  const saved = JSON.parse(await readFile(join(result.version.artifactDir, 'result.json'), 'utf8')); assert.equal(saved.requests.length, 2); assert.equal(saved.usage.totalTokens, 60); assert.equal(result.version.repairEvidence[0].after, undefined, 'full drafts stay in private artifacts instead of expanding the public state');
  assert.ok(result.version.assessment.failedChecks.some(item => item.code === 'unchanged_repair')); assert.match(result.version.assessment.summary, /相同候选/);
  assert.equal(result.version.evaluation.stage, 'script_preflight'); assert.equal(result.version.evaluation.evaluationComplete, false);
  assert.equal(app.current().evolution.lastEvaluatedAt, result.version.evaluation.completedAt, 'script checks really ran, without claiming a quality score');
});

test('explicit tool inheritance retains audited provenance while published bundles contain only complete validated tools', async t => {
  const app = await setup(t), baseline = projectGenomeFixture(), candidate = projectGenomeFixture({ candidate: true });
  candidate.tools = [{ id: 'evidence_helper', inheritFromBaseline: true }]; delete candidate.evaluationSuite;
  app.service.provider = genomeEvaluationProvider({ candidate, calls: app.calls });
  const result = await app.service.evolve(app.projectId, { model, evidence: [{ id: 'method-only-change', summary: 'Interpret the checked evidence before suggesting the next decision.' }] });
  assert.equal(result.status, 'ready'); assert.equal(app.current().activeVersionId, app.baselineId);
  const provenance = { baselineHash: evolutionHash(baseline), tools: [{ id: 'evidence_helper', toolHash: evolutionHash(baseline.tools[0]) }] };
  assert.deepEqual(result.version.proposal.toolInheritance, provenance); assert.deepEqual(result.version.repairEvidence[0].toolInheritance, provenance);
  const proposal = JSON.parse(await readFile(join(result.version.artifactDir, 'proposal.json'), 'utf8'));
  assert.deepEqual(proposal.toolInheritance, provenance); assert.deepEqual(proposal.genome.tools, baseline.tools);
  const bundle = await app.service.genomes.read(app.projectId, result.version.id);
  assert.deepEqual(bundle.genome.tools, baseline.tools); assert.equal(JSON.stringify(bundle.genome).includes('inheritFromBaseline'), false);
  const trace = (await readFile(join(result.version.artifactDir, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(trace.some(row => row.type === 'proposal_tool_inheritance' && row.baselineHash === provenance.baselineHash && row.tools[0].toolHash === provenance.tools[0].toolHash));
  const reloaded = new Store(app.store.file), saved = reloaded.state.projects.find(project => project.id === app.projectId).versions.find(version => version.id === result.version.id);
  assert.deepEqual(saved.proposal.toolInheritance, provenance);
});

test('completed empty author responses retain precise terminal diagnostics and all bounded paid attempts in private failure and trace', async t => {
  const app = await setup(t), evidence = [{ id: 'terminal-source', summary: 'A completed tool result needs interpretation.' }];
  const learningContext = { schemaVersion: 1, evidence: [{ id: 'terminal-source', content: 'The actual observation is recorded.' }], files: [{ path: 'observed.js', content: 'const complete = false;' }] };
  let calls = 0;
  app.service.provider = async function* (request) {
    calls++;
    if (request.tools.length) yield { type: 'tool_call', id: `read-${calls}`, name: 'learning_context_read', arguments: { id: 'file:observed.js' } };
    else { yield { type: 'thinking_delta', delta: 'PRIVATE_THINKING_NOT_A_DIAGNOSTIC' }; yield { type: 'text_delta', delta: ' \n' }; }
    yield { type: 'usage', usage: { input: 10, output: 3, totalTokens: 13 } }; yield { type: 'done', stopReason: request.tools.length ? 'toolUse' : 'stop' };
  };
  const result = await app.service.evolve(app.projectId, { model, evidence, learningContext });
  assert.equal(result.status, 'failed'); assert.equal(calls, 18); assert.equal(result.usage.totalTokens, 234); assert.equal(result.version.error.code, 'invalid_output');
  assert.equal(result.version.error.diagnostic.kind, 'empty_response'); assert.equal(result.version.error.diagnostic.stopReason, 'stop'); assert.equal(result.version.error.diagnostic.responseDiagnostic.outputBytes, 2);
  assert.equal(result.version.bundle, undefined); assert.equal(result.version.proposal, undefined); assert.equal(result.version.learningContextReads.length, 15); assert.equal(app.current().activeVersionId, app.baselineId);
  const failure = JSON.parse(await readFile(join(result.version.artifactDir, 'failure.json'), 'utf8'));
  assert.deepEqual(failure.diagnostic, result.version.error.diagnostic); assert.equal(failure.requests.length, 18); assert.equal(failure.repairEvidence.length, 3); assert.equal(failure.usage.totalTokens, 234);
  const trace = (await readFile(join(result.version.artifactDir, 'trace.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  const diagnostics = trace.filter(row => row.type === 'structured_output_failure');
  assert.equal(diagnostics.length, 3); assert.equal(new Set(diagnostics.map(row => row.diagnostic.requestId)).size, 3);
  assert.ok(diagnostics.every(row => row.diagnostic.completed && row.diagnostic.toolCallCount === 0 && row.diagnostic.stopReason === 'stop' && row.diagnostic.outputBytes === 2));
  assert.equal(JSON.stringify(diagnostics).includes('PRIVATE_THINKING'), false); assert.deepEqual(diagnostics.at(-1).diagnostic, failure.diagnostic.responseDiagnostic);
  const saved = structuredClone(result.version), duplicate = await app.service.evolve(app.projectId, { model, evidence, learningContext });
  assert.equal(duplicate.replayed, true); assert.equal(calls, 18); assert.equal(duplicate.usage.totalTokens, 0); assert.deepEqual(app.current().versions.find(row => row.id === saved.id), saved);
});

test('early author prose is checked within the original allowance and each host format feedback is durably audited', async t => {
  const app = await setup(t), evidence = [{ id: 'format-source', summary: 'Check that the author completes its structured proposal.' }];
  const learningContext = { schemaVersion: 1, evidence: [{ id: 'format-source', content: 'A recorded interpretation gap.' }], files: [] };
  const ordinary = app.service.provider; let authorCalls = 0;
  app.service.provider = async function* (request) {
    if (request.systemPrompt.includes('Create one improved executable project agent')) {
      authorCalls++;
      if (authorCalls <= 5) { yield { type: 'text_delta', delta: 'PRIVATE_PROSE_NOT_A_COMPLETE_PROPOSAL' }; yield { type: 'usage', usage: { totalTokens: 13 } }; yield { type: 'done', stopReason: 'stop' }; return; }
      assert.equal(authorCalls, 6); assert.deepEqual(request.tools, []);
      const feedback = request.messages.filter(row => row.source === 'finish-feedback'); assert.equal(feedback.length, 5);
      assert.ok(feedback.every(row => row.context === undefined && row.content.some(part => part.type === 'text' && part.text.includes('host:author-output-contract'))), 'Provider messages receive the prepared context text, not the raw journal context field');
    }
    yield* ordinary(request);
  };
  const result = await app.service.evolve(app.projectId, { model, evidence, learningContext });
  assert.equal(result.status, 'ready', JSON.stringify(result.version.error)); assert.equal(authorCalls, 6); assert.equal(result.version.proposalAttempts, 1); assert.equal(app.current().activeVersionId, app.baselineId);
  const trace = (await readFile(join(result.version.artifactDir, 'trace.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  const feedback = trace.filter(row => row.type === 'author_format_feedback');
  assert.deepEqual(feedback.map(row => row.continuations), [1, 2, 3, 4, 5]); assert.equal(new Set(feedback.map(row => row.messageId)).size, 5); assert.equal(JSON.stringify(feedback).includes('PRIVATE_PROSE'), false);
  assert.equal(trace.filter(row => row.type === 'model_request' && row.phase === 'proposal:1').length, 6);
  const audit = JSON.parse(await readFile(join(result.version.artifactDir, 'result.json'), 'utf8')); assert.equal(audit.requests.filter(row => row.phase === 'proposal:1').length, 6);
});

test('HTTP provider termination retains raw reason and actual usage in failed version trace without format retries', async t => {
  const { createServer } = await import('node:http'), { streamCompletion } = await import('../../../packages/sdk/src/providers.mjs');
  const app = await setup(t); let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk; calls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '{"plausible":"candidate"}' }, finish_reason: 'insufficient_system_resource' }], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  app.service.provider = streamCompletion;
  const result = await app.service.evolve(app.projectId, { model: { ...model, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, evidence: [{ id: 'wire-termination', summary: 'A recorded work result needs review.' }], learningContext: { schemaVersion: 1, evidence: [], files: [] } });
  assert.equal(result.status, 'failed'); assert.equal(calls, 1); assert.equal(result.usage.totalTokens, 13); assert.equal(result.version.error.code, 'provider_termination'); assert.equal(result.version.error.diagnostic.providerFinishReason, 'insufficient_system_resource'); assert.equal(result.version.bundle, undefined); assert.equal(app.current().activeVersionId, app.baselineId);
  const failure = JSON.parse(await readFile(join(result.version.artifactDir, 'failure.json'), 'utf8'));
  assert.deepEqual(failure.diagnostic, result.version.error.diagnostic); assert.equal(failure.requests.length, 1); assert.equal(failure.requests[0].completed, false); assert.equal(failure.requests[0].usageReported, true); assert.equal(failure.requests[0].providerFinishReason, 'insufficient_system_resource'); assert.equal(failure.usage.totalTokens, 13);
  const trace = (await readFile(join(result.version.artifactDir, 'trace.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  const receipt = trace.find(row => row.type === 'model_request'); assert.equal(receipt.providerFinishReason, 'insufficient_system_resource'); assert.equal(receipt.completed, false); assert.equal(receipt.usage.totalTokens, 13); assert.equal(trace.some(row => row.type === 'structured_output_failure'), false);
});
