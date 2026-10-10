import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { ProjectEvolutionService } from '../test-support/marketplace-isolation.mjs';
import { ProjectLearningController } from '../project-learning-controller.mjs';
import { projectLearningEpisodes, projectLearningSourceRecords } from '../project-learning-evidence.mjs';
import { resolveModel } from '../configuration.mjs';
import { learningCredentialIdentity, learningEvidenceScope, learningEvidenceScopeV2, learningLegacyScope, LEARNING_SCOPE_SCHEMA_VERSION } from '../project-learning-scope.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from '../../../packages/sdk/test/fixtures/project-genome.mjs';

async function failedAuthor(t, { scopeMode = 'legacy' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-author-recovery-service-')), store = new Store(join(dir, 'state.json'));
  const { project } = store.createProject({ name: 'Actual author recovery', workspace: dir, initiative: { enabled: false } });
  const genomes = new ProjectGenomeStore(store), prepared = await genomes.prepare(project, { genome: projectGenomeFixture(), versionId: project.activeVersionId }); await prepared.commit();
  const at = '2026-09-25T00:00:00Z';
  store.mutate(state => {
    state.configuration.providers.push({ id: 'local-fixture', name: 'Fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: ['fixture', 'another'].map(id => ({ id, name: id, contextWindow: 128000, maxOutputTokens: 4000, reasoning: ['off'] })) });
    state.configuration.defaultModel = { providerId: 'local-fixture', modelId: 'fixture', reasoning: 'off' };
    const current = state.projects.find(row => row.id === project.id); current.initialization = { status: 'ready' }; current.simulated = false;
    current.versions.find(row => row.id === current.activeVersionId).bundle = prepared.record;
    state.sessions.push({ id: 'retained-session', projectId: project.id, mode: 'build', simulated: false,
      turns: [{ id: 'retained-turn', userItemId: 'retained-user', status: 'completed', modelConfig: { execution: 'rna' }, simulated: false, completedAt: at, createdAt: at }],
      items: [{ id: 'retained-user', turnId: 'retained-turn', kind: 'user', text: 'Check the actual output.', simulated: false, createdAt: at },
        { id: 'retained-tool', turnId: 'retained-turn', kind: 'tool', simulated: false, tool: { id: 'actual-call', name: 'project_exec', status: 'completed', args: { command: 'check' }, output: 'The check failed.' } },
        { id: 'retained-assistant', turnId: 'retained-turn', kind: 'assistant', simulated: false, text: 'The agent claimed success.' }] });
  });
  const model = resolveModel(store.state.configuration, null);
  const current = () => store.state.projects.find(row => row.id === project.id), sourceSession = () => store.state.sessions.find(row => row.id === 'retained-session');
  const legacyMethodIdentity = 'f605978f11adbdbdd166774fdf132ab5726e2c03cabf3c2f345e7b0b9ac289b8';
  const evidenceScopeHash = learningEvidenceScope(store.state, current(), model, learningCredentialIdentity(store, model)), v2ScopeHash = learningEvidenceScopeV2(store.state, current(), model, learningCredentialIdentity(store, model));
  const scope = scopeMode === 'v2' ? v2ScopeHash : scopeMode === 'migrated-v2' ? learningLegacyScope(store.state, current(), model, legacyMethodIdentity) : ProjectLearningController.prototype.legacyScope.call({ store }, current(), model);
  if (scopeMode !== 'legacy') store.mutate(state => { state.projects.find(p => p.id === project.id).learningRuntime = { ...(scopeMode === 'v2' ? { scopeSchemaVersion: 2, evidenceScopeHash: v2ScopeHash } : {}), scopeHash: scope,
    sdkState: { schemaVersion: 1, episodes: [], reviews: [], seen: [], nextReviewAt: Date.now() + 86400000 } }; });
  if (scopeMode === 'migrated-v2') {
    store.mutate(state => { const p = state.projects.find(p => p.id === project.id); p.decisionMode = 'rna-model'; p.initiative.enabled = true; p.evolution.enabled = true; });
    const controller = new ProjectLearningController(store, { evolutionService: { running: new Map(), evolve: async () => { throw Error('Migration cannot run experiments'); } }, reflect: async () => { throw Error('Migration cannot call a model'); }, tickIntervalMs: 0, initialDelayMs: 100000 });
    try { const deadline = Date.now() + 6000; while (current().learningRuntime.scopeSchemaVersion !== LEARNING_SCOPE_SCHEMA_VERSION) { if (Date.now() > deadline) throw Error('Scope migration timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
    finally { await controller.close(); }
    assert.equal(current().learningRuntime.scopeHash, scope); assert.equal(current().learningRuntime.scopeMigration.verifiedSourceBoundaryHash, evidenceScopeHash);
    store.mutate(state => { state.projects.find(p => p.id === project.id).initiative.enabled = false; });
  }
  const episodes = projectLearningEpisodes(store.state, current(), scope, { since: 0 }).episodes;
  const evidence = episodes.map(row => ({ id: row.id, type: row.kind, summary: row.summary, at: Date.parse(row.at) }));
  assert.equal(evidence.length, 1);
  const learningContext = { schemaVersion: 1, evidence: projectLearningSourceRecords(store.state, current(), episodes).evidence, files: [{ path: 'src/source.js', content: 'const frozenOriginal = true;' }] };
  const learningIntent = { content: 'Verify the actual result before announcing completion.', reason: 'The receipt contradicted the answer.', evidenceIds: evidence.map(row => row.id) };
  let initialCalls = 0;
  const service = new ProjectEvolutionService(store, { genomeStore: genomes, provider: async function* () {
    yield { type: 'tool_call', id: `original-${++initialCalls}`, name: 'learning_context_read', arguments: { id: 'file:src/source.js' } };
    yield { type: 'usage', usage: { totalTokens: 12 } }; yield { type: 'done', stopReason: 'toolUse' };
  } });
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  const failed = await service.evolve(project.id, { evidence, learningContext, learningIntent, learningReviewId: 'original-review', model });
  assert.equal(failed.status, 'failed'); assert.equal(failed.version.error.code, 'step_limit'); assert.equal(initialCalls, 6);
  const source = structuredClone(failed.version), oldFiles = {};
  for (const name of ['evidence.json', 'learning-context.json', 'learning-intent.json', 'baseline.json', 'frozen-evaluation.json', 'failure.json']) oldFiles[name] = await readFile(join(source.artifactDir, name), 'utf8');
  const calls = []; service.provider = genomeEvaluationProvider({ calls });
  // Committed store state is immutable; fixtures edit it through mutate().
  const edit = change => store.mutate(state => { change(state.projects.find(row => row.id === project.id), state.sessions.find(row => row.id === 'retained-session'), state); });
  return { dir, store, service, current, sourceSession, edit, projectId: project.id, source, oldFiles, evidence, calls,
    retry: options => service.regenerateAuthor(project.id, { retryAuthorVersionId: source.id, model, ...options }),
    assertOriginal: async () => { assert.deepEqual(current().versions.find(row => row.id === source.id), source); for (const [name, content] of Object.entries(oldFiles)) assert.equal(await readFile(join(source.artifactDir, name), 'utf8'), content); } };
}

test('explicit failed-author recovery reuses exact original inputs and evaluates a separate candidate without replaying or replacing the old failure', async t => {
  const app = await failedAuthor(t), original = app.service.provider; let checked = false;
  await writeFile(join(app.dir, 'source.js'), 'current workspace content is not the frozen source');
  app.edit((_, session) => { session.items.push({ id: 'new-message', kind: 'user', text: 'An ordinary new message', simulated: false }); });
  app.service.provider = async function* (request) {
    if (!checked) {
      checked = true; const version = app.current().versions.at(-1);
      assert.equal(version.source, 'explicit-authoring-retry'); assert.equal(version.retryOfVersionId, app.source.id); assert.equal(version.retryOfLearningReviewId, 'original-review');
      const context = JSON.parse(await readFile(join(version.artifactDir, 'learning-context.json'), 'utf8'));
      assert.equal(context.files[0].content, 'const frozenOriginal = true;'); assert.deepEqual(JSON.parse(request.messages[0].content[0].text).evidence, app.evidence);
    }
    yield* original(request);
  };
  const result = await app.retry(); assert.equal(result.status, 'ready', JSON.stringify(result.version?.error)); assert.equal(app.calls.length, 16); assert.equal(result.usage.totalTokens, 480);
  assert.notEqual(result.version.id, app.source.id); assert.equal(result.version.learningReviewId, undefined); assert.equal(result.version.authoringRecovery.mode, 'stored_evidence');
  assert.equal(result.version.learningContextHash, app.source.learningContextHash); assert.equal(result.version.evidenceSnapshotHash, app.source.evidenceSnapshotHash);
  assert.equal(app.current().activeVersionId, app.source.parentVersionId); assert.equal(result.version.evaluation.suite.version, 'frozen-v1'); await app.assertOriginal();
  const replay = await app.retry(); assert.equal(replay.replayed, true); assert.equal(replay.version.id, result.version.id); assert.equal(app.calls.length, 16); assert.equal(replay.usage.totalTokens, 0);
});

for (const scopeMode of ['v2', 'migrated-v2']) test(`${scopeMode} author failure and explicit retry preserve the evidence namespace across execution revisions`, async t => {
  const app = await failedAuthor(t, { scopeMode }), namespace = app.current().learningRuntime.scopeHash;
  if (scopeMode === 'migrated-v2') assert.notEqual(namespace, app.current().learningRuntime.evidenceScopeHash);
  const result = await app.retry(); assert.equal(result.status, 'ready', JSON.stringify(result.version?.error)); assert.equal(app.calls.length, 16);
  assert.equal(result.version.authoringRecovery.sourceScopeKind, 'stable-evidence-v2'); assert.equal(result.version.authoringRecovery.sourceScopeHash, namespace);
  assert.equal(result.version.learningContextHash, app.source.learningContextHash); assert.equal(app.current().learningRuntime.scopeHash, namespace); await app.assertOriginal();
});

for (const invalidation of ['missing-proof', 'changed-proof-boundary', 'changed-permission']) test(`migrated v2 author recovery rejects ${invalidation} before dispatch`, async t => {
  const app = await failedAuthor(t, { scopeMode: 'migrated-v2' });
  app.edit(project => {
    if (invalidation === 'missing-proof') delete project.learningRuntime.scopeMigration;
    else if (invalidation === 'changed-proof-boundary') project.learningRuntime.scopeMigration.verifiedSourceBoundaryHash = 'a'.repeat(64);
    else project.permissions.background = project.permissions.background === 'read' ? 'execute' : 'read';
  });
  await assert.rejects(app.retry(), error => error.code === 'authoring_recovery_context_changed' && error.usage.totalTokens === 0); assert.equal(app.calls.length, 0); await app.assertOriginal();
});

test('v2 current credentials are checked again after admission, without relying on a stale provider timestamp', async t => {
  const app = await failedAuthor(t, { scopeMode: 'v2' }), settled = [];
  const result = await app.retry({ requestControl: { beforeRequest: () => app.store.configurationService.writeSecret('local-fixture', { apiKey: 'rotated-fixture-secret' }), onUsage: receipt => settled.push(receipt) } });
  assert.equal(result.status, 'failed'); assert.equal(result.version.error.code, 'author_retry_context_changed'); assert.equal(app.calls.length, 0); assert.equal(result.usage.totalTokens, 0);
  assert.equal(settled.length, 1); assert.equal(settled[0].cancelledBeforeSend, true); await app.assertOriginal();
});

for (const kind of ['tampered-artifact', 'revoked-permission', 'already-aborted']) test(`author recovery rejects ${kind} before dispatch with explicit zero usage`, async t => {
  const app = await failedAuthor(t), count = app.current().versions.length, options = {};
  if (kind === 'tampered-artifact') { const path = join(app.source.artifactDir, 'evidence.json'), data = JSON.parse(await readFile(path, 'utf8')); data.evidence[0].summary = 'tampered'; await writeFile(path, JSON.stringify(data)); }
  else if (kind === 'revoked-permission') app.edit(project => { project.permissions.workspace = project.permissions.workspace === 'read' ? 'execute' : 'read'; });
  else { const controller = new AbortController(); controller.abort(); options.signal = controller.signal; }
  await assert.rejects(app.retry(options), error => { assert.equal(error.usage.totalTokens, 0); assert.ok(error.code); return true; });
  assert.equal(app.calls.length, 0); assert.equal(app.current().versions.length, count);
});

test('a source revoked during request admission never reaches the provider and preserves the original failure', async t => {
  const app = await failedAuthor(t); let admissions = 0; const settled = [];
  const result = await app.retry({ requestControl: { beforeRequest: async () => { admissions++; app.edit((_, session) => { session.sourceDeleted = true; }); }, onUsage: receipt => settled.push(receipt) } });
  assert.equal(result.status, 'failed'); assert.equal(result.version.error.code, 'author_retry_context_changed'); assert.equal(admissions, 1); assert.equal(app.calls.length, 0); assert.equal(result.usage.totalTokens, 0);
  assert.equal(settled.length, 1); assert.equal(settled[0].usage.totalTokens, 0); assert.equal(settled[0].requestStarted, false); assert.equal(settled[0].cancelledBeforeSend, true);
  await app.assertOriginal();
});

for (const selection of ['default', 'project']) test(`a ${selection} model selection changed during admission prevents the paid request and releases its reservation`, async t => {
  const app = await failedAuthor(t), settled = [];
  const result = await app.retry({ requestControl: { beforeRequest: () => {
    app.edit((project, _, state) => {
      if (selection === 'default') state.configuration.defaultModel.modelId = 'another';
      else project.initiative.modelSelection = { providerId: 'local-fixture', modelId: 'another', reasoning: 'off' };
    });
  }, onUsage: receipt => settled.push(receipt) } });
  assert.equal(result.status, 'failed'); assert.equal(result.version.error.code, 'author_retry_context_changed'); assert.equal(app.calls.length, 0); assert.equal(result.usage.totalTokens, 0);
  assert.equal(settled.length, 1); assert.equal(settled[0].usage.totalTokens, 0); await app.assertOriginal();
});

test('a source revoked after one actual research request stops further paid calls and retains that usage and read audit', async t => {
  const app = await failedAuthor(t); let dispatched = 0;
  app.service.provider = async function* () {
    dispatched++; yield { type: 'tool_call', id: 'retry-read', name: 'learning_context_read', arguments: { id: 'file:src/source.js' } };
    yield { type: 'usage', usage: { totalTokens: 31 } }; app.edit((_, session) => { session.sourceDeleted = true; }); yield { type: 'done', stopReason: 'toolUse' };
  };
  const result = await app.retry(); assert.equal(result.status, 'failed'); assert.equal(result.version.error.code, 'author_retry_context_changed'); assert.equal(dispatched, 1); assert.equal(result.usage.totalTokens, 31); assert.equal(result.version.learningContextReads.length, 1);
  assert.equal(result.version.bundle, undefined); assert.equal(result.version.proposal, undefined); await app.assertOriginal();
});

test('a source revoked after the final evaluator response cannot publish or activate the candidate', async t => {
  const app = await failedAuthor(t), original = app.service.provider; let dispatched = 0;
  app.service.provider = async function* (request) {
    dispatched++; yield* original(request); if (dispatched === 16) app.edit((_, session) => { session.sourceDeleted = true; });
  };
  const result = await app.retry(); assert.equal(dispatched, 16); assert.equal(result.status, 'stale'); assert.equal(result.usage.totalTokens, 480); assert.equal(result.version.bundle, undefined);
  assert.equal(app.current().activeVersionId, app.source.parentVersionId); await app.assertOriginal();
});
