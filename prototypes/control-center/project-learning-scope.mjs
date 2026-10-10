import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Pure boundary projections shared by the live controller and frozen author
// recovery. None of these helpers starts a controller or writes project state.
//
// G9 (plan v2 §4): a privacy boundary is separate from context drift.
// - Privacy: the project identity and workspace. Changing them revokes old
//   frozen source text. Archived/deleted sessions revoke only their own
//   sources (`session:<id>`), never the whole backlog.
// - Drift: model, endpoint, credential, permissions, assignments, active
//   version, SDK/method revision, project wording, plan mode. Drift annotates
//   episodes (`contextDrift: [...]`) and re-reviews queued decisions; it never
//   revokes evidence.
export const LEARNING_SCOPE_SCHEMA_VERSION = 3;
export const DRIFT_COMPONENTS = Object.freeze(['model', 'credential', 'permissions', 'assignments', 'activeVersion', 'method', 'project', 'planMode']);

/** Pre-v3 source boundary (kept to reproduce legacy and v2 scopes). */
export function learningSourceBoundary(state, project) {
  const sessions = state.sessions.filter(row => row.projectId === project.id && row.kind !== 'side');
  return [project.id, project.name, project.description, project.workspace, project.focus, project.commitments, project.activeVersionId, project.versions?.find(row => row.id === project.activeVersionId)?.bundle?.hash, project.trialVersionId, project.permissions, project.assignments,
    sessions.filter(row => row.archivedAt).map(row => row.id).sort(), sessions.some(row => !row.archivedAt && row.mode === 'plan')];
}
export function learningPrivacyBoundary(_state, project) { return [project.id, project.workspace]; }

export function learningLegacyScope(state, project, model, methodIdentity) {
  const provider = state.configuration.providers.find(row => row.id === model.providerId);
  return hash([methodIdentity, ...learningSourceBoundary(state, project), model, provider?.updatedAt]);
}

// Resolve through the trusted host credential service. Only this one-way
// identity crosses into pure recovery; the secret is never persisted there.
export function learningCredentialIdentity(store, model) {
  const provider = store.state.configuration.providers.find(row => row.id === model.providerId);
  if (provider?.authMode === 'subscription') return hash([provider.id, store.configurationService.credentialRevision(provider.id)]);
  return hash([provider?.apiKeyEnv ?? '', provider ? store.configurationService.secret(provider.id, provider) : null]);
}

/** v3 evidence scope: privacy boundary only. */
export function learningEvidenceScope(state, project, model, credentialIdentity) {
  if (typeof credentialIdentity !== 'string' || !digest(credentialIdentity)) throw new TypeError('A host-resolved credential identity is required');
  return hash(['learning-evidence-v3', ...learningPrivacyBoundary(state, project)]);
}
/** v2 evidence scope (model- and permission-coupled); migration only. */
export function learningEvidenceScopeV2(state, project, model, credentialIdentity) {
  if (typeof credentialIdentity !== 'string' || !digest(credentialIdentity)) throw new TypeError('A host-resolved credential identity is required');
  const identity = { providerId: model.providerId, protocol: model.protocol, baseUrl: model.baseUrl, modelId: model.modelId, execution: model.execution };
  return hash(['learning-evidence-v2', ...learningSourceBoundary(state, project), identity, credentialIdentity]);
}

export function learningNamespaceMatches(runtime, evidenceScopeHash) {
  if (!digest(runtime?.scopeHash)) return false;
  if (![2, LEARNING_SCOPE_SCHEMA_VERSION].includes(runtime.scopeSchemaVersion) || runtime.evidenceScopeHash !== evidenceScopeHash) return false;
  // v3 keeps an older namespace only with the proof the controller wrote when
  // it migrated a consistent v2 runtime (or a verified legacy scope).
  if (runtime.scopeSchemaVersion === LEARNING_SCOPE_SCHEMA_VERSION && runtime.scopeHash !== evidenceScopeHash && runtime.scopeMigration?.from === 'evidence-scope-v2')
    return runtime.scopeMigration.verifiedScopeHash === runtime.scopeHash && runtime.scopeMigration.verifiedSourceBoundaryHash === evidenceScopeHash;
  if (runtime.scopeHash === evidenceScopeHash) return true;
  // A controller writes this proof atomically after reproducing the complete
  // legacy scope. Its authorized method identity is historical, not today's
  // SDK revision. The current credential/source boundary still has to match.
  const proof = runtime.scopeMigration;
  return proof?.from === 'legacy-method-coupled-v1' && digest(proof.verifiedLegacyMethodIdentity)
    && proof.verifiedScopeHash === runtime.scopeHash && proof.verifiedSourceBoundaryHash === evidenceScopeHash;
}
/** A persisted v2 runtime that was internally consistent (its own proof). */
export function learningV2Consistent(runtime) {
  if (runtime?.scopeSchemaVersion !== 2 || !digest(runtime.scopeHash) || !digest(runtime.evidenceScopeHash)) return false;
  if (runtime.scopeHash === runtime.evidenceScopeHash) return true;
  const proof = runtime.scopeMigration;
  return proof?.from === 'legacy-method-coupled-v1' && digest(proof.verifiedLegacyMethodIdentity) && proof.verifiedScopeHash === runtime.scopeHash && proof.verifiedSourceBoundaryHash === runtime.evidenceScopeHash;
}

/** Named drift identities; compare two with learningDriftComponents(). */
export function learningDriftIdentity(state, project, model, credentialIdentity, methodIdentity) {
  const sessions = state.sessions.filter(row => row.projectId === project.id && !row.archivedAt && row.kind !== 'side');
  return { model: hash([model.providerId, model.protocol, model.baseUrl, model.modelId, model.execution]), credential: hash(credentialIdentity ?? null), permissions: hash(project.permissions ?? null), assignments: hash(project.assignments ?? null),
    activeVersion: hash([project.activeVersionId ?? null, project.versions?.find(row => row.id === project.activeVersionId)?.bundle?.hash ?? null, project.trialVersionId ?? null]), method: hash(methodIdentity ?? null),
    project: hash([project.name, project.description, project.focus, project.commitments ?? null]), planMode: hash(sessions.some(row => row.mode === 'plan')) };
}
export function learningDriftComponents(previous, current) {
  if (!previous || typeof previous !== 'object') return [];
  return DRIFT_COMPONENTS.filter(key => previous[key] !== current[key]);
}
/** Annotates unsettled episodes and non-terminal reviews with drift labels. */
export function annotateLearningDrift(sdkState, components) {
  if (!sdkState || !components.length) return sdkState;
  const next = structuredClone(sdkState), merge = row => { row.contextDrift = [...new Set([...(Array.isArray(row.contextDrift) ? row.contextDrift : []), ...components])]; };
  for (const episode of next.episodes ?? []) merge(episode);
  for (const review of next.reviews ?? []) if (!['no_change', 'completed', 'failed'].includes(review.status) && !review.sourceRevoked) merge(review);
  return next;
}

export const archivedLearningSources = (state, project) => state.sessions.filter(row => row.projectId === project.id && row.archivedAt).map(row => `session:${row.id}`).sort();
/** v3 execution revision: privacy + archived sessions + drift + method + resolved model. */
export function learningExecutionScope(state, project, model, methodIdentity, credentialIdentity) {
  const provider = state.configuration.providers.find(row => row.id === model.providerId);
  return hash(['learning-execution-v3', learningEvidenceScope(state, project, model, credentialIdentity), archivedLearningSources(state, project), learningDriftIdentity(state, project, model, credentialIdentity, methodIdentity), methodIdentity, model, provider?.updatedAt]);
}
/** v2 execution revision; reproduces receipts written before v3. */
export function learningExecutionScopeV2(state, project, model, methodIdentity, credentialIdentity) {
  const provider = state.configuration.providers.find(row => row.id === model.providerId);
  return hash(['learning-execution-v2', learningEvidenceScopeV2(state, project, model, credentialIdentity), methodIdentity, model, provider?.updatedAt]);
}
