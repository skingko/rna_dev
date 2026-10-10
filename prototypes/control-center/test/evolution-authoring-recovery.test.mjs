import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectGenomeFixture } from '../../../packages/sdk/test/fixtures/project-genome.mjs';
import { evolutionHash } from '../../../packages/sdk/src/evolution.mjs';
import { projectGenomeHash } from '../../../packages/sdk/src/project-genome.mjs';
import { createProjectLearningContext } from '../../../packages/sdk/src/learning-context.mjs';
import { PROJECT_EVALUATION_RUNTIME_HASH } from '../../../packages/sdk/src/project-evolution.mjs';
import { LEARNING_REFLECTION_METHOD, revokeLearningSources } from '../../../packages/sdk/src/learning.mjs';
import { ProjectLearningController } from '../project-learning-controller.mjs';
import { projectLearningEpisodes, projectLearningSourceRecords, learningHash } from '../project-learning-evidence.mjs';
import { getProjectEvolutionIdentity } from '../project-evolution-identity.mjs';
import { loadAuthoringRecoveryArtifacts, reconstructFailedAuthorInput, AUTHORING_RECOVERY_ARTIFACT_LIMITS } from '../evolution-authoring-recovery.mjs';

const clone = value => structuredClone(value);
function fixture({ stored = false } = {}) {
  const model = { providerId: 'provider', modelId: 'fixture', execution: 'rna', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 128000, maxOutputTokens: 4000, reasoning: 'off' };
  const genome = projectGenomeFixture(), hash = projectGenomeHash(genome), at = '2026-09-25T00:00:00Z';
  const project = { id: 'project', name: 'Evidence recovery', description: 'Actual retained project input', focus: 'Check completion', workspace: '/project-workspace', initialization: { status: 'ready' }, simulated: false,
    activeVersionId: 'base', trialVersionId: null, commitments: [], permissions: { workspace: 'execute', background: 'read' }, assignments: { skillIds: [], toolIds: [], mcpServerIds: [] }, versions: [{ id: 'base', bundle: { hash, genome } }], observations: [], jobs: [] };
  const session = { id: 'session', projectId: project.id, mode: 'build', turns: [{ id: 'turn', userItemId: 'user', status: 'completed', modelConfig: { execution: 'rna' }, simulated: false, completedAt: at, createdAt: at }], items: [
    { id: 'user', turnId: 'turn', kind: 'user', text: 'Check the real output before claiming it works.', simulated: false, createdAt: at },
    { id: 'tool', turnId: 'turn', kind: 'tool', simulated: false, tool: { id: 'call', name: 'project_exec', status: 'completed', args: { command: 'check' }, output: 'The check actually failed.' } },
    { id: 'assistant', turnId: 'turn', kind: 'assistant', simulated: false, text: 'The agent claimed success.' },
  ] };
  const state = { projects: [project], sessions: [session], sessionDeletions: [], configuration: { providers: [{ id: 'provider', updatedAt: at }] } };
  const sourceScope = ProjectLearningController.prototype.legacyScope.call({ store: { state } }, project, model);
  const episodes = projectLearningEpisodes(state, project, sourceScope, { since: 0 }).episodes;
  const evidence = episodes.map(row => ({ id: row.id, type: row.kind, summary: row.summary, at: Date.parse(row.at) }));
  const frozen = createProjectLearningContext({ schemaVersion: 1, evidence: projectLearningSourceRecords(state, project, episodes).evidence, files: [{ path: 'main.js', content: 'const original = true;' }] }, evidence);
  const intent = { content: 'Check the actual result before declaring completion.', reason: 'The tool receipt contradicted the narration.', evidenceIds: evidence.map(row => row.id) };
  const identity = getProjectEvolutionIdentity(project, { evidence, model, baselineHash: hash, learningContextHash: frozen.contextHash });
  const source = { id: 'failed-author', state: 'failed', simulated: false, parentVersionId: 'base', baselineHash: hash, evidenceIds: evidence.map(row => row.id), assignments: clone(project.assignments),
    ...identity, learningReviewId: 'review', learningIntent: intent, learningContextHash: frozen.contextHash, learningContextSources: frozen.inventory, error: { code: 'step_limit', diagnostic: { phase: 'proposal', kind: 'step_limit' } }, usage: { totalTokens: 123 } };
  project.versions.push(source); project.learningRuntime = { scopeHash: sourceScope, sdkState: { schemaVersion: 1, reviews: [{ id: 'review', status: 'completed', result: { status: 'failed', versionId: source.id }, sourceIds: episodes[0].sourceIds }], episodes: [], seen: [{ key: 'consumed-original', outcome: 'failed' }] } };
  const artifacts = { projectId: project.id, versionId: source.id,
    baseline: { versionId: 'base', hash, genome: clone(genome) }, frozenEvaluation: { suite: clone(genome.evaluationSuite), hash: evolutionHash(genome.evaluationSuite), evaluationRuntimeHash: source.evaluationRuntimeHash },
    learningContext: { ...clone(frozen.snapshot), contextHash: frozen.contextHash, scope: 'frozen_authoring_sources_only' },
    learningIntent: { schemaVersion: 1, status: 'unverified_hypothesis', learningIntent: clone(intent), externalEvidence: false, affectsEvidenceIdentity: false },
  };
  if (stored) { source.evidenceSnapshotHash = evolutionHash(evidence); artifacts.evidence = { schemaVersion: 1, evidenceIdentityVersion: source.evidenceIdentityVersion, evidenceHash: source.evidenceHash, evidenceFingerprints: clone(source.evidenceFingerprints), snapshotHash: source.evidenceSnapshotHash, evidence: clone(evidence) }; }
  const input = () => ({ state, projectId: project.id, versionId: source.id, artifacts, model });
  return { state, project, session, source, model, evidence, episodes, artifacts, input };
}
const errorCode = suffix => ({ code: `authoring_recovery_${suffix}` });

for (const stored of [false, true]) test(`${stored ? 'stored' : 'legacy'} author recovery verifies exact evidence and never changes old results, usage or consumed identities`, () => {
  const f = fixture({ stored }), before = clone(f.state), recovered = reconstructFailedAuthorInput(f.input());
  assert.deepEqual(recovered.evidence, f.evidence); assert.deepEqual(recovered.learningContext.files, [{ path: 'main.js', content: 'const original = true;' }]);
  assert.equal(recovered.provenance.mode, stored ? 'stored_evidence' : 'reconstructed_legacy'); assert.equal(recovered.provenance.sourceVersionId, f.source.id);
  assert.equal(recovered.guard({ state: f.state, model: f.model }), true); assert.deepEqual(f.state, before);
  assert.equal(Object.isFrozen(recovered.evidence[0]), true);
  f.artifacts.learningContext.files[0].content = 'Caller changed the object'; assert.equal(recovered.learningContext.files[0].content, 'const original = true;');
  assert.equal(recovered.guard({ state: f.state, model: f.model }), true);
});

test('ordinary new conversation, messages, new work and completed retry siblings do not invalidate a frozen author retry', () => {
  const f = fixture(), recovered = reconstructFailedAuthorInput(f.input());
  f.state.sessions.push({ id: 'new-session', projectId: f.project.id, mode: 'build', turns: [], items: [{ id: 'new-message', kind: 'user', text: 'A new ordinary chat.', createdAt: '2026-09-25T01:00:00Z', simulated: false }] });
  f.project.versions.push({ id: 'new-retry', state: 'proposing', simulated: false, parentVersionId: 'base' });
  assert.equal(recovered.guard({ state: f.state, model: f.model }), true);
});

function withOldRuntime(f) {
  const oldRuntime = 'a'.repeat(64), provider = f.state.configuration.providers[0], project = f.project;
  const oldScope = learningHash([learningHash([LEARNING_REFLECTION_METHOD, oldRuntime]), project.id, project.name, project.description, project.workspace, project.focus, project.commitments, project.activeVersionId,
    project.versions[0].bundle.hash, project.trialVersionId, project.permissions, project.assignments, [], false, f.model, provider.updatedAt]);
  const episodes = projectLearningEpisodes(f.state, project, oldScope, { since: 0 }).episodes;
  const context = createProjectLearningContext({ schemaVersion: 1, evidence: projectLearningSourceRecords(f.state, project, episodes).evidence, files: f.artifacts.learningContext.files }, f.evidence);
  Object.assign(f.artifacts.learningContext, clone(context.snapshot), { contextHash: context.contextHash });
  f.source.learningContextHash = context.contextHash; f.source.learningContextSources = context.inventory; f.source.evaluationRuntimeHash = oldRuntime;
  f.artifacts.frozenEvaluation.evaluationRuntimeHash = oldRuntime;
  const identity = getProjectEvolutionIdentity(project, { evidence: f.evidence, model: f.model, baselineHash: f.source.baselineHash, learningContextHash: context.contextHash });
  const { evidenceFingerprints, inputFingerprint, legacyEvidenceHash, ...fields } = identity;
  f.source.inputFingerprint = evolutionHash({ ...fields, evaluationRuntimeHash: oldRuntime });
  f.project.learningRuntime.scopeHash = oldScope; f.project.learningRuntime.sdkState.reviews[0].sourceIds = episodes[0].sourceIds;
  return f;
}

test('only runtime can change: exact scope under the old runtime is required even with verified evidence', () => {
  const f = withOldRuntime(fixture()), oldRuntime = f.source.evaluationRuntimeHash;
  const recovered = reconstructFailedAuthorInput(f.input()); assert.notEqual(oldRuntime, PROJECT_EVALUATION_RUNTIME_HASH);
  assert.equal(recovered.provenance.sourceRuntimeHash, oldRuntime); assert.equal(recovered.guard({ state: f.state, model: f.model }), true);
  f.project.permissions.background = 'execute'; assert.equal(recovered.guard({ state: f.state, model: f.model }), false);
});

test('explicit recovery revalidates a runtime-retired review without erasing its actual revocation audit', () => {
  const f = withOldRuntime(fixture()), runtime = f.project.learningRuntime;
  runtime.sdkState = revokeLearningSources(runtime.sdkState, [`scope:${runtime.scopeHash}`], 'project_scope_changed');
  assert.equal(runtime.sdkState.reviews[0].sourceRevoked, true); assert.equal(runtime.sdkState.reviews[0].revocationReason, 'project_scope_changed');
  const before = clone(f.state), result = reconstructFailedAuthorInput(f.input());
  assert.equal(result.provenance.revalidatedScopeAfterRuntimeChange, true); assert.equal(result.guard({ state: f.state, model: f.model }), true); assert.deepEqual(f.state, before);
});

for (const [label, mutate] of [
  ['actual session deletion', f => { f.session.sourceDeleted = true; }],
  ['changed permission', f => { f.project.permissions.background = 'execute'; }],
  ['other revocation reason', f => { f.project.learningRuntime.sdkState.reviews[0].revocationReason = 'session_deleted'; }],
  ['removed source version', f => { f.source.versionDeleted = true; }],
  ['changed provider revision', f => { f.state.configuration.providers[0].updatedAt = '2026-09-26T00:00:00Z'; }],
]) test(`runtime scope retirement cannot waive ${label}`, () => {
  const f = withOldRuntime(fixture()), runtime = f.project.learningRuntime;
  runtime.sdkState = revokeLearningSources(runtime.sdkState, [`scope:${runtime.scopeHash}`], 'project_scope_changed'); mutate(f);
  assert.throws(() => reconstructFailedAuthorInput(f.input()), error => error.code?.startsWith('authoring_recovery_'));
});

test('a same-runtime scope revocation is not mistaken for the narrow runtime retirement exception', () => {
  const f = fixture(), runtime = f.project.learningRuntime;
  runtime.sdkState = revokeLearningSources(runtime.sdkState, [`scope:${runtime.scopeHash}`], 'project_scope_changed');
  assert.throws(() => reconstructFailedAuthorInput(f.input()), errorCode('source_unavailable'));
});

for (const [label, mutate] of [
  ['permissions', f => { f.project.permissions.workspace = 'read'; }],
  ['model', f => { f.model.maxOutputTokens++; }],
  ['provider revision', f => { f.state.configuration.providers[0].updatedAt = '2026-09-26T00:00:00Z'; }],
  ['baseline', f => { f.project.activeVersionId = 'another'; }],
  ['baseline bytes', f => { f.project.versions[0].bundle.genome.systemPrompt += 'changed'; }],
  ['workspace', f => { f.project.workspace = '/another-workspace'; }],
  ['source deletion', f => { f.session.sourceDeleted = true; }],
  ['source archive', f => { f.session.archivedAt = '2026-09-26T00:00:00Z'; }],
  ['source transfer', f => { f.session.projectId = 'another-project'; }],
  ['deletion barrier', f => { f.state.sessionDeletions.push({ projectId: f.project.id, localStatus: 'pending' }); }],
  ['revoked version', f => { f.source.contextRevoked = true; }],
  ['revoked review', f => { f.project.learningRuntime.sdkState.reviews[0].sourceRevoked = true; }],
  ['changed summary source', f => { f.session.items[1].tool.output = 'The host check changed.'; }],
  ['changed original timestamp', f => { f.session.turns[0].completedAt = '2026-09-26T00:00:00Z'; }],
  ['retained candidate', f => { f.source.candidateHash = 'b'.repeat(64); }],
]) test(`recovery refuses ${label}, and the same change revokes an already returned guard`, () => {
  const f = fixture({ stored: !label.startsWith('changed ') }), recovered = reconstructFailedAuthorInput(f.input()); mutate(f);
  assert.throws(() => reconstructFailedAuthorInput(f.input()), error => error.code?.startsWith('authoring_recovery_'));
  assert.equal(recovered.guard({ state: f.state, model: f.model }), false);
});

test('stored exact evidence survives later progress of the same turn while source revocation still cancels it', () => {
  const f = fixture({ stored: true }), recovered = reconstructFailedAuthorInput(f.input());
  f.session.turns[0].completedAt = '2026-09-26T00:00:00Z'; f.session.turns[0].runtimeAttempts = 2;
  f.session.items[1].tool.output = 'The later check succeeded.';
  const retry = reconstructFailedAuthorInput(f.input()); assert.deepEqual(retry.evidence, f.evidence);
  assert.equal(recovered.guard({ state: f.state, model: f.model }), true);
  f.session.items[1].sourceDeleted = true;
  assert.equal(recovered.guard({ state: f.state, model: f.model }), false);
  assert.throws(() => reconstructFailedAuthorInput(f.input()), errorCode('source_unavailable'));
});

for (const [label, mutate] of [
  ['frozen file', f => { f.artifacts.learningContext.files[0].content = 'Tampered frozen file'; }],
  ['raw source record', f => { f.artifacts.learningContext.evidence[0].content += ' '; }],
  ['frozen baseline', f => { f.artifacts.baseline.genome.systemPrompt += 'tamper'; }],
  ['frozen evaluation oracle', f => { f.artifacts.frozenEvaluation.suite.cases[0].input = 'tamper'; }],
  ['original intent', f => { f.artifacts.learningIntent.learningIntent.content = 'Changed hypothesis'; }],
  ['semantic fingerprint', f => { f.source.evidenceFingerprints[0].summaryHash = 'b'.repeat(64); }],
  ['stored evidence body', f => { f.artifacts.evidence.evidence[0].summary = 'Changed summary'; }],
  ['stored timestamp', f => { f.artifacts.evidence.evidence[0].at++; f.artifacts.evidence.snapshotHash = evolutionHash(f.artifacts.evidence.evidence); }],
  ['missing saved evidence', f => { delete f.artifacts.evidence; }],
  ['missing scope metadata', f => { const body = JSON.parse(f.artifacts.learningContext.evidence[0].content); delete body.episode.sourceIds; f.artifacts.learningContext.evidence[0].content = JSON.stringify(body); }],
]) test(`recovery rejects ${label} instead of silently falling back to guessed or newer inputs`, () => {
  const f = fixture({ stored: true }); mutate(f);
  assert.throws(() => reconstructFailedAuthorInput(f.input()), error => error.code?.startsWith('authoring_recovery_'));
});

async function disk(t, { stored = false } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'rna-author-recovery-')), root = await realpath(temporary);
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const f = fixture({ stored }), rootDir = join(root, 'evolution'), dir = join(rootDir, f.project.id, f.source.id); await mkdir(dir, { recursive: true });
  const names = { baseline: 'baseline.json', frozenEvaluation: 'frozen-evaluation.json', learningContext: 'learning-context.json', learningIntent: 'learning-intent.json', evidence: 'evidence.json' };
  for (const [key, name] of Object.entries(names)) if (f.artifacts[key]) await writeFile(join(dir, name), JSON.stringify(f.artifacts[key]), { mode: 0o600 });
  f.source.artifactDir = dir;
  return { ...f, root, rootDir, dir, options: { rootDir, projectId: f.project.id, versionId: f.source.id } };
}

test('bounded artifact loader returns exact original inputs and never writes or accepts caller-selected file names', async t => {
  const f = await disk(t, { stored: true }), before = await readFile(join(f.dir, 'evidence.json'));
  const artifacts = await loadAuthoringRecoveryArtifacts(f.options), result = reconstructFailedAuthorInput({ ...f.input(), artifacts });
  assert.deepEqual(result.evidence, f.evidence); assert.equal(result.provenance.mode, 'stored_evidence');
  assert.deepEqual(await readFile(join(f.dir, 'evidence.json')), before);
  await assert.rejects(loadAuthoringRecoveryArtifacts({ ...f.options, versionId: '../other' }), errorCode('unsafe_path'));
  await assert.rejects(loadAuthoringRecoveryArtifacts({ ...f.options, rootDir: 'relative' }), errorCode('unsafe_path'));
});

test('trusted host root may use an ancestor alias while its actual root and all descendants stay canonical and bound', async t => {
  const f = await disk(t), parentAlias = join(f.root, 'host-parent-alias'); await symlink(f.root, parentAlias);
  const aliasRoot = join(parentAlias, 'evolution'); f.source.artifactDir = join(aliasRoot, f.project.id, f.source.id);
  const artifacts = await loadAuthoringRecoveryArtifacts({ ...f.options, rootDir: aliasRoot });
  assert.equal(artifacts.dir, f.dir); assert.equal(artifacts.requestedDir, f.source.artifactDir);
  assert.equal(reconstructFailedAuthorInput({ ...f.input(), artifacts }).guard({ state: f.state, model: f.model }), true);
});

for (const component of ['root', 'project', 'version', 'file']) test(`artifact loader refuses a ${component} symlink`, async t => {
  const f = await disk(t);
  if (component === 'file') { const path = join(f.dir, 'learning-context.json'), other = join(f.root, 'copy.json'); await writeFile(other, await readFile(path)); await rm(path); await symlink(other, path); }
  else {
    const original = component === 'root' ? f.rootDir : component === 'project' ? join(f.rootDir, f.project.id) : f.dir;
    const alias = component === 'root' ? join(f.root, 'alias') : component === 'project' ? join(f.rootDir, 'alias') : join(f.rootDir, f.project.id, 'alias');
    await symlink(original, alias);
    if (component === 'root') f.options.rootDir = alias; else if (component === 'project') f.options.projectId = 'alias'; else f.options.versionId = 'alias';
  }
  await assert.rejects(loadAuthoringRecoveryArtifacts(f.options), errorCode('unsafe_path'));
});

test('artifact loader refuses oversized, non-regular, invalid UTF-8 and retained proposal inputs before parsing or dispatch', async t => {
  const f = await disk(t), path = join(f.dir, 'learning-intent.json');
  await writeFile(path, 'x'.repeat(AUTHORING_RECOVERY_ARTIFACT_LIMITS['learning-intent.json'] + 1));
  await assert.rejects(loadAuthoringRecoveryArtifacts(f.options), errorCode('oversized'));
  await rm(path); await mkdir(path); await assert.rejects(loadAuthoringRecoveryArtifacts(f.options), errorCode('unsafe_path'));
  await rm(path, { recursive: true }); await writeFile(path, Buffer.from([123, 255, 125])); await assert.rejects(loadAuthoringRecoveryArtifacts(f.options), errorCode('invalid_artifact'));
  await writeFile(path, JSON.stringify(f.artifacts.learningIntent)); await writeFile(join(f.dir, 'proposal.json'), '{}');
  await assert.rejects(loadAuthoringRecoveryArtifacts(f.options), errorCode('candidate_retained'));
});

test('artifact loader honors abort and does not convert a missing required artifact into a legacy reconstruction', async t => {
  const f = await disk(t), controller = new AbortController(); controller.abort();
  await assert.rejects(loadAuthoringRecoveryArtifacts({ ...f.options, signal: controller.signal }), { name: 'AbortError' });
  await rm(join(f.dir, 'learning-context.json')); await assert.rejects(loadAuthoringRecoveryArtifacts(f.options), errorCode('artifact_unavailable'));
});
