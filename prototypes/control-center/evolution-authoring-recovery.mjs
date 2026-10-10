import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { evolutionHash } from '../../packages/sdk/src/evolution.mjs';
import { projectGenomeHash, validateProjectGenome } from '../../packages/sdk/src/project-genome.mjs';
import { createProjectLearningContext } from '../../packages/sdk/src/learning-context.mjs';
import { LEARNING_REFLECTION_METHOD } from '../../packages/sdk/src/learning.mjs';
import { validateProjectEvolutionLearningIntent, PROJECT_EVALUATION_RUNTIME_HASH } from '../../packages/sdk/src/project-evolution.mjs';
import { EVOLUTION_EVIDENCE_IDENTITY_VERSION, getProjectEvolutionIdentity } from './project-evolution-identity.mjs';
import { learningHash, projectLearningEpisodes } from './project-learning-evidence.mjs';
import { learningLegacyScope, learningEvidenceScope, learningEvidenceScopeV2, learningNamespaceMatches, LEARNING_SCOPE_SCHEMA_VERSION } from './project-learning-scope.mjs';

const fail = (code, message = 'The original authoring input cannot be verified; no request was started.') => Object.assign(new Error(message), { code: `authoring_recovery_${code}`, status: 409 });
const requireThat = (condition, code) => { if (!condition) throw fail(code); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => evolutionHash(a ?? null) === evolutionHash(b ?? null);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const retained = row => row && !row.sourceDeleted && !row.versionDeleted && !row.contextRevoked && !row.archivedAt;
const clone = value => structuredClone(value);

export const AUTHORING_RECOVERY_ARTIFACT_LIMITS = Object.freeze({
  'baseline.json': 1048576, 'frozen-evaluation.json': 1048576,
  'learning-context.json': 4194304, 'learning-intent.json': 65536, 'evidence.json': 786432,
});

/** The supplied root is a host-managed location, never a model-provided path.
 * Its trusted ancestors may use a system alias such as /var -> /private/var;
 * the root itself, project/version and each file cannot be symlinks. No scan,
 * journal read, model request or write is performed. */
export async function loadAuthoringRecoveryArtifacts({ rootDir, projectId, versionId, signal } = {}) {
  requireThat(typeof rootDir === 'string' && isAbsolute(rootDir) && resolve(rootDir) === rootDir && identifier(projectId) && identifier(versionId), 'unsafe_path');
  let canonicalRoot;
  try { requireThat((await lstat(rootDir)).isDirectory() && !(await lstat(rootDir)).isSymbolicLink(), 'unsafe_path'); canonicalRoot = await realpath(rootDir); }
  catch (error) { if (signal?.aborted) throw signal.reason; if (String(error?.code).startsWith('authoring_recovery_')) throw error; throw fail('artifact_unavailable'); }
  const directories = [canonicalRoot, join(canonicalRoot, projectId), join(canonicalRoot, projectId, versionId)], identities = [];
  const checkDirectories = async (record = false) => {
    signal?.throwIfAborted(); const requested = await lstat(rootDir);
    requireThat(requested.isDirectory() && !requested.isSymbolicLink() && await realpath(rootDir) === canonicalRoot, 'unsafe_path');
    for (let index = 0; index < directories.length; index++) {
      signal?.throwIfAborted();
      const path = directories[index], info = await lstat(path);
      requireThat(info.isDirectory() && !info.isSymbolicLink() && await realpath(path) === path, 'unsafe_path');
      if (record) identities[index] = { dev: info.dev, ino: info.ino };
      else requireThat(info.dev === identities[index].dev && info.ino === identities[index].ino, 'artifact_changed');
    }
    requireThat(requested.dev === identities[0].dev && requested.ino === identities[0].ino, 'artifact_changed');
  };
  const dir = directories[2], read = async (name, optional = false) => {
    await checkDirectories(); let handle;
    try {
      const path = join(dir, name); let expected;
      try { expected = await lstat(path); } catch (error) { if (optional && error.code === 'ENOENT') return undefined; throw error; }
      requireThat(expected.isFile() && !expected.isSymbolicLink() && await realpath(path) === path, 'unsafe_path');
      requireThat(expected.size <= AUTHORING_RECOVERY_ARTIFACT_LIMITS[name], 'oversized');
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat();
      requireThat(before.isFile() && before.dev === expected.dev && before.ino === expected.ino && before.size === expected.size, 'artifact_changed');
      const buffer = Buffer.alloc(before.size + 1); let used = 0;
      while (used < buffer.length) { signal?.throwIfAborted(); const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used); if (!bytesRead) break; used += bytesRead; }
      const after = await handle.stat(), current = await lstat(path);
      requireThat(used === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs
        && current.dev === before.dev && current.ino === before.ino && current.size === before.size && await realpath(path) === path, 'artifact_changed');
      await checkDirectories();
      let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used))); } catch { throw fail('invalid_artifact'); }
      requireThat(object(value), 'invalid_artifact'); return value;
    } finally { await handle?.close(); }
  };
  try {
    await checkDirectories(true);
    // A proposal on disk is a retained candidate even if its state projection
    // was lost. Regeneration must never silently replace that recovery path.
    try { await lstat(join(dir, 'proposal.json')); throw fail('candidate_retained'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const baseline = await read('baseline.json'), frozenEvaluation = await read('frozen-evaluation.json');
    const learningContext = await read('learning-context.json'), learningIntent = await read('learning-intent.json'), evidence = await read('evidence.json', true);
    await checkDirectories(); signal?.throwIfAborted();
    return { projectId, versionId, dir, requestedDir: join(rootDir, projectId, versionId), baseline, frozenEvaluation, learningContext, learningIntent, ...(evidence ? { evidence } : {}) };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (String(error?.code).startsWith('authoring_recovery_')) throw error;
    throw fail(['ELOOP', 'ENOTDIR'].includes(error?.code) ? 'unsafe_path' : 'artifact_unavailable');
  }
}

/** Reproduce the known v1 host scope with the recorded runtime identity. This
 * intentionally does not waive other scope fields when the runtime changes.
 * A changed reflection method/scope algorithm cannot be guessed backwards. */
function recordedRuntimeScope(state, project, model, runtimeHash) {
  return learningLegacyScope(state, project, model, learningHash([LEARNING_REFLECTION_METHOD, runtimeHash]));
}

function retainedFrozenSource(state, project, episode, document) {
  const source = document.source;
  if (!source || source.status !== 'retained_source') return false;
  if (episode.kind === 'work_result') {
    const action = project.initiativeRuntime?.sdkState?.actions?.find(row => row.id === source.actionId), job = project.jobs?.find(row => row.id === source.actionId);
    return retained(action) && action.action === 'work' && action.simulated !== true && retained(job) && job.simulated === false
      && !(job.toolReceipts ?? []).some(row => row.sourceDeleted || row.contextRevoked);
  }
  const session = state.sessions.find(row => row.id === source.sessionId && row.projectId === project.id && episode.sourceIds.includes(`session:${row.id}`));
  if (!retained(session)) return false;
  if (episode.kind === 'conversation_result') {
    const turn = session.turns?.find(row => row.id === source.turnId);
    return retained(turn) && turn.modelConfig?.execution === 'rna' && turn.simulated !== true
      && !(session.items ?? []).some(row => row.turnId === turn.id && (row.sourceDeleted || row.contextRevoked || row.interaction?.sourceDeleted || row.interaction?.contextRevoked));
  }
  const first = document.records?.[0]; let record;
  // Structured answer records are bounded and normally complete. Without their
  // exact source identity, refuse to infer a deleted card from a text fragment.
  if (!first || first.truncated || typeof first.content !== 'string') return false;
  try { record = JSON.parse(first.content); } catch { return false; }
  if (record.kind === 'structured_user_answer') {
    const card = session.items?.find(row => row.interaction?.id === record.interactionId), answer = card?.interaction;
    return retained(card) && retained(answer) && card.simulated === false && answer.status === 'answered'
      && !(session.items ?? []).some(row => row.interactionId === record.interactionId && (row.sourceDeleted || row.contextRevoked));
  }
  const item = session.items?.find(row => row.id === record.itemId);
  if (!retained(item) || item.simulated !== false) return false;
  if (record.kind === 'consumed_adjustment') return item.kind === 'user' && item.delivery === 'steer' && session.turns?.some(row => row.id === record.turnId && retained(row) && row.modelConfig?.execution === 'rna' && row.steering?.includes(item.id));
  if (record.kind === 'explicit_user_feedback') return project.observations?.some(row => retained(row) && row.simulated === false && row.source === 'user-command' && row.data?.command === 'feedback' && row.data.sessionId === session.id && row.data.messageId === item.id);
  return false;
}

function verifyInput({ state, projectId, versionId, artifacts, model, credentialIdentity, redact = value => value }) {
  requireThat(object(state) && Array.isArray(state.projects) && Array.isArray(state.sessions) && identifier(projectId) && identifier(versionId), 'invalid_input');
  requireThat(object(model) && model.execution !== 'simulation' && model.providerId !== 'demo' && model.modelId, 'model_changed');
  const project = state.projects.find(row => row.id === projectId), source = project?.versions?.find(row => row.id === versionId);
  requireThat(retained(project) && project.initialization?.status === 'ready' && !project.trialVersionId, 'project_changed');
  requireThat(retained(source) && source.simulated === false && source.state === 'failed', 'source_unavailable');
  requireThat(!source.bundle && !source.proposal && !source.candidateHash && !source.inputGenomeHash && source.error?.diagnostic?.phase === 'proposal', 'candidate_retained');
  requireThat(!(state.sessionDeletions ?? []).some(row => row.projectId === projectId && row.localStatus !== 'completed'), 'source_unavailable');
  requireThat(object(artifacts) && artifacts.projectId === projectId && artifacts.versionId === versionId, 'invalid_artifact');
  if (artifacts.dir && source.artifactDir) requireThat([artifacts.dir, artifacts.requestedDir].includes(source.artifactDir), 'unsafe_path');
  requireThat(source.evidenceIdentityVersion === EVOLUTION_EVIDENCE_IDENTITY_VERSION && digest(source.evaluationRuntimeHash) && digest(source.modelHash)
    && digest(source.learningContextHash) && digest(source.baselineHash) && digest(source.inputFingerprint), 'missing_provenance');
  const ids = source.evidenceIds;
  requireThat(Array.isArray(ids) && ids.length > 0 && ids.length <= 32 && ids.every(id => typeof id === 'string' && id.length <= 300) && new Set(ids).size === ids.length, 'missing_provenance');
  const baseline = project.versions.find(row => row.id === project.activeVersionId);
  requireThat(project.activeVersionId === source.parentVersionId && baseline?.bundle?.hash === source.baselineHash, 'baseline_changed');
  const baselineArtifact = artifacts.baseline, evaluation = artifacts.frozenEvaluation;
  requireThat(baselineArtifact?.versionId === source.parentVersionId && baselineArtifact.hash === source.baselineHash && object(evaluation), 'baseline_changed');
  let genome; try { genome = validateProjectGenome(baselineArtifact.genome); } catch { throw fail('invalid_artifact'); }
  requireThat(projectGenomeHash(genome) === source.baselineHash && (!baseline.bundle.genome || projectGenomeHash(baseline.bundle.genome) === source.baselineHash), 'baseline_changed');
  requireThat(same(evaluation.suite, genome.evaluationSuite) && evolutionHash(evaluation.suite) === evaluation.hash && evaluation.evaluationRuntimeHash === source.evaluationRuntimeHash, 'baseline_changed');
  requireThat(same(project.assignments, source.assignments), 'context_changed');

  const raw = artifacts.learningContext;
  requireThat(object(raw) && raw.schemaVersion === 1 && raw.contextHash === source.learningContextHash && raw.scope === 'frozen_authoring_sources_only' && Array.isArray(raw.evidence) && raw.evidence.length === ids.length, 'artifact_changed');
  const metadata = new Map(), documents = new Map(), scopes = new Set();
  for (const row of raw.evidence) {
    requireThat(object(row) && typeof row.id === 'string' && ids.includes(row.id) && !metadata.has(row.id) && typeof row.content === 'string' && Buffer.byteLength(row.content) <= 128000, 'artifact_changed');
    let content; try { content = JSON.parse(row.content); } catch { throw fail('missing_provenance'); }
    const episode = content.episode;
    requireThat(object(episode) && episode.id === row.id && digest(episode.fingerprint) && ['conversation_result', 'work_result', 'user_feedback'].includes(episode.kind)
      && typeof episode.at === 'string' && Number.isFinite(Date.parse(episode.at)) && Array.isArray(episode.sourceIds) && episode.sourceIds.length > 1 && episode.sourceIds.length <= 64, 'missing_provenance');
    requireThat(new Set(episode.sourceIds).size === episode.sourceIds.length && episode.sourceIds.every(id => typeof id === 'string' && /^(?:session:|scope:)/u.test(id)), 'missing_provenance');
    const scopeIds = episode.sourceIds.filter(id => id.startsWith('scope:')); requireThat(scopeIds.length === 1 && digest(scopeIds[0].slice(6)), 'missing_provenance'); scopes.add(scopeIds[0].slice(6));
    const sessionIds = episode.sourceIds.filter(id => id.startsWith('session:'));
    requireThat(sessionIds.length > 0 && sessionIds.every(id => state.sessions.some(session => `session:${session.id}` === id && session.projectId === projectId && retained(session))), 'source_unavailable');
    metadata.set(row.id, episode); documents.set(row.id, content);
  }
  requireThat(scopes.size === 1, 'missing_provenance'); const sourceScopeHash = [...scopes][0];
  const runtime = project.learningRuntime;
  // v2 namespaces intentionally outlive an SDK runtime. Never substitute the
  // new execution revision for the namespace in frozen episode fingerprints.
  // A matching stored namespace alone is insufficient: the host must supply
  // today's resolved credential proof and every source boundary is recomputed.
  const stableNamespace = [2, LEARNING_SCOPE_SCHEMA_VERSION].includes(runtime?.scopeSchemaVersion) && runtime.scopeHash === sourceScopeHash;
  if (stableNamespace) {
    // v3 learning tolerates drift, but an author replay still requires the
    // strict v2 boundary (model, credential, permissions) recorded by the controller.
    requireThat(digest(credentialIdentity) && (runtime.scopeSchemaVersion === 2 ? learningNamespaceMatches(runtime, learningEvidenceScopeV2(state, project, model, credentialIdentity))
      : learningNamespaceMatches(runtime, learningEvidenceScope(state, project, model, credentialIdentity)) && runtime.strictScopeHash === learningEvidenceScopeV2(state, project, model, credentialIdentity)), 'context_changed');
  }
  else requireThat(recordedRuntimeScope(state, project, model, source.evaluationRuntimeHash) === sourceScopeHash, 'context_changed');
  const review = project.learningRuntime?.sdkState?.reviews?.find(row => row.id === source.learningReviewId);
  // A new runtime retires the old lane's review text. Explicit author recovery
  // may revalidate its separate immutable artifacts only after the complete
  // original scope matched above. This proves current authorization, not that
  // permissions never changed in between. Source deletion is never waived.
  const revalidatedScopeAfterRuntimeChange = Boolean(!stableNamespace && review?.sourceRevoked && review.revocationReason === 'project_scope_changed' && source.evaluationRuntimeHash !== PROJECT_EVALUATION_RUNTIME_HASH);
  if (review?.sourceRevoked) requireThat(revalidatedScopeAfterRuntimeChange, 'source_unavailable');

  for (const id of ids) requireThat(retainedFrozenSource(state, project, metadata.get(id), documents.get(id)), 'source_unavailable');
  let evidence, mode;
  if (artifacts.evidence !== undefined) {
    const saved = artifacts.evidence;
    requireThat(object(saved) && saved.schemaVersion === 1 && saved.evidenceIdentityVersion === source.evidenceIdentityVersion && Array.isArray(saved.evidence)
      && saved.evidence.length === ids.length && digest(saved.snapshotHash) && saved.snapshotHash === source.evidenceSnapshotHash && evolutionHash(saved.evidence) === saved.snapshotHash
      && saved.evidenceHash === source.evidenceHash && same(saved.evidenceFingerprints, source.evidenceFingerprints), 'artifact_changed');
    evidence = clone(saved.evidence); mode = 'stored_evidence';
  } else {
    requireThat(source.evidenceSnapshotHash === undefined, 'artifact_unavailable');
    // Only legacy input without a saved evidence snapshot needs reconstruction
    // from current records. A changed occurrence/summary is not guessed back.
    const projected = projectLearningEpisodes(state, project, sourceScopeHash, { since: 0, redact }).episodes;
    const selected = ids.map(id => projected.find(row => row.id === id));
    for (let index = 0; index < selected.length; index++) {
      const row = selected[index], original = metadata.get(ids[index]);
      requireThat(row && row.kind === original.kind && row.at === original.at && same(row.sourceIds, original.sourceIds) && row.fingerprint === original.fingerprint, 'source_changed');
    }
    evidence = selected.map(row => ({ id: row.id, type: row.kind, summary: row.summary, at: Date.parse(row.at) })); mode = 'reconstructed_legacy';
  }
  requireThat(Buffer.byteLength(JSON.stringify(evidence)) <= AUTHORING_RECOVERY_ARTIFACT_LIMITS['evidence.json'], 'oversized');
  requireThat(new Set(evidence.map(row => row?.id)).size === ids.length && evidence.every(row => {
    const episode = metadata.get(row?.id); return episode && row.type === episode.kind && typeof row.summary === 'string' && row.summary.length <= 6000 && row.at === Date.parse(episode.at)
      && learningHash([sourceScopeHash, row.id, row.summary]) === episode.fingerprint;
  }), 'artifact_changed');
  let context;
  try { context = createProjectLearningContext({ schemaVersion: 1, evidence: raw.evidence, files: raw.files }, evidence); } catch { throw fail('artifact_changed'); }
  requireThat(context.contextHash === source.learningContextHash && (!source.learningContextSources || same(context.inventory, source.learningContextSources)), 'artifact_changed');
  const identity = getProjectEvolutionIdentity(project, { evidence, model, baselineHash: source.baselineHash, learningContextHash: context.contextHash });
  requireThat(identity.modelHash === source.modelHash, 'model_changed');
  requireThat(identity.evidenceHash === source.evidenceHash && same(identity.evidenceFingerprints, source.evidenceFingerprints), 'source_changed');
  const originalIdentity = { evidenceIdentityVersion: identity.evidenceIdentityVersion, baselineVersionId: identity.baselineVersionId, baselineHash: identity.baselineHash,
    evaluationRuntimeHash: source.evaluationRuntimeHash, modelHash: identity.modelHash, evidenceHash: identity.evidenceHash, inputGenomeHash: identity.inputGenomeHash, learningContextHash: identity.learningContextHash };
  requireThat(evolutionHash(originalIdentity) === source.inputFingerprint, 'artifact_changed');
  const intentArtifact = artifacts.learningIntent; let learningIntent;
  requireThat(intentArtifact?.schemaVersion === 1 && intentArtifact.status === 'unverified_hypothesis' && intentArtifact.externalEvidence === false && intentArtifact.affectsEvidenceIdentity === false, 'artifact_changed');
  try { learningIntent = validateProjectEvolutionLearningIntent(intentArtifact.learningIntent, evidence); } catch { throw fail('artifact_changed'); }
  requireThat(learningIntent && same(learningIntent, source.learningIntent), 'artifact_changed');
  const provenance = { schemaVersion: 1, mode, sourceVersionId: source.id, sourceReviewId: source.learningReviewId ?? null, sourceBaselineVersionId: source.parentVersionId,
    sourceBaselineHash: source.baselineHash, sourceEvidenceHash: source.evidenceHash, sourceEvidenceSnapshotHash: evolutionHash(evidence), sourceLearningContextHash: source.learningContextHash,
    sourceRuntimeHash: source.evaluationRuntimeHash, sourceInputFingerprint: source.inputFingerprint, sourceScopeHash, sourceScopeKind: stableNamespace ? 'stable-evidence-v2' : 'legacy-runtime-v1', recoveredEvidenceCount: evidence.length, revalidatedScopeAfterRuntimeChange };
  return { evidence, learningContext: context.snapshot, learningIntent, provenance };
}

function immutable(value) { if (value && typeof value === 'object') { Object.values(value).forEach(immutable); Object.freeze(value); } return value; }

/** Pure recovery and a pure commit guard. It never resurrects consumed learning
 * episodes, touches the old result/usage, refreshes frozen files or executes an
 * old tool. The owner creates a new request/version with explicit retry lineage.
 * Recheck the guard at admission and commit, with the current model and state. */
export function reconstructFailedAuthorInput({ state, projectId, versionId, artifacts, model, credentialIdentity, redact = value => value } = {}) {
  const frozenArtifacts = immutable(clone(artifacts));
  const recovered = verifyInput({ state, projectId, versionId, artifacts: frozenArtifacts, model, credentialIdentity, redact });
  const originalProof = evolutionHash(recovered.provenance);
  return Object.freeze({ ...immutable(recovered), guard({ state: currentState, model: currentModel, credentialIdentity: currentCredentialIdentity, redact: currentRedact = redact } = {}) {
    try { const current = verifyInput({ state: currentState, projectId, versionId, artifacts: frozenArtifacts, model: currentModel, credentialIdentity: currentCredentialIdentity, redact: currentRedact }); return evolutionHash(current.provenance) === originalProof; }
    catch { return false; }
  } });
}
