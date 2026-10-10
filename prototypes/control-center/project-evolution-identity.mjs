import { evolutionHash } from '../../packages/sdk/src/evolution.mjs';
import { PROJECT_EVALUATION_RUNTIME_HASH } from '../../packages/sdk/src/project-evolution.mjs';

export const EVOLUTION_EVIDENCE_IDENTITY_VERSION = 1;
const terminal = new Set(['ready', 'rejected', 'failed', 'interrupted', 'no_change']);
const string = value => typeof value === 'string' ? value : '';

/** No IO, credentials, mutable timestamps or proposal text in an experiment's
 * admission identity. Model changes and changed external evidence are inputs;
 * reordered observations, repeated rows and refreshed timestamps are not. */
export function getProjectEvolutionIdentity(project, { evidence = [], model, inputGenomeHash = null, baselineHash, learningContextHash, evaluationPartitionIdentity } = {}) {
  if (!project || !Array.isArray(evidence) || !model) throw new TypeError('Project, evidence array and model are required');
  const baseline = project.versions?.find(version => version.id === project.activeVersionId);
  const rows = new Map();
  for (const event of evidence) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('Invalid evolution evidence');
    const semantic = { id: string(event.id), type: string(event.type ?? event.kind), summary: string(event.summary ?? event.text) };
    const fingerprint = evolutionHash(semantic);
    rows.set(fingerprint, { id: semantic.id, type: semantic.type, summaryHash: evolutionHash(semantic.summary), fingerprint });
  }
  const evidenceFingerprints = [...rows.values()].sort((a, b) => a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0);
  const modelHash = evolutionHash({ providerId: model.providerId, modelId: model.modelId ?? model.id, protocol: model.protocol, baseUrl: model.baseUrl, reasoning: model.reasoning, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, compat: model.compat });
  if (learningContextHash !== undefined && !/^[a-f0-9]{64}$/.test(learningContextHash)) throw new TypeError('Learning context hash must identify canonical frozen source bytes');
  if (evaluationPartitionIdentity !== undefined && !/^[a-f0-9]{64}$/.test(evaluationPartitionIdentity)) throw new TypeError('Evaluation partition identity must identify a frozen method');
  const identity = { ...(evaluationPartitionIdentity ? { evaluationPartitionIdentity } : {}), evidenceIdentityVersion: EVOLUTION_EVIDENCE_IDENTITY_VERSION, baselineVersionId: project.activeVersionId, baselineHash: baselineHash ?? baseline?.bundle?.hash ?? null, evaluationRuntimeHash: PROJECT_EVALUATION_RUNTIME_HASH, modelHash, evidenceHash: evolutionHash(evidenceFingerprints), inputGenomeHash, ...(learningContextHash === undefined ? {} : { learningContextHash }) };
  return { ...identity, inputFingerprint: evolutionHash(identity), evidenceFingerprints, legacyEvidenceHash: evolutionHash(evidence) };
}

function sameContext(version, identity) {
  return version.simulated === false && !version.sourceDeleted && !version.contextRevoked && version.parentVersionId === identity.baselineVersionId && version.baselineHash === identity.baselineHash && version.evaluationRuntimeHash === identity.evaluationRuntimeHash && version.modelHash === identity.modelHash && (version.inputGenomeHash ?? null) === identity.inputGenomeHash && (version.learningContextHash ?? null) === (identity.learningContextHash ?? null) && (version.evaluationPartitionIdentity ?? null) === (identity.evaluationPartitionIdentity ?? null);
}

/** Exact replay uses the same policy as the evaluator. Old receipts without
 * canonical evidence may match their original exact batch, but never claim a
 * different model/runtime or semantic subset was already tried. */
export function findMatchingEvolutionAttempt(project, identity, { retryFailed = false } = {}) {
  return project.versions?.findLast(version => sameContext(version, identity) && (version.state === 'ready' || !retryFailed && terminal.has(version.state)) && (
    version.evidenceIdentityVersion === EVOLUTION_EVIDENCE_IDENTITY_VERSION
      ? version.inputFingerprint === identity.inputFingerprint
      : version.evidenceIdentityVersion == null && version.evidenceHash === identity.legacyEvidenceHash
  ));
}

/** Autonomous admission can decline a pure subset of evidence already tried
 * under exactly the same execution conditions. Only hashed evidence receipts
 * are inspected; no user text is read from archives or treated as new work. */
export function getEvolutionEvidenceCoverage(project, identity) {
  const wanted = new Set(identity.evidenceFingerprints.map(row => row.fingerprint)), seen = new Set(), matchingAttemptIds = [];
  for (const version of project.versions ?? []) {
    if (!sameContext(version, identity) || !terminal.has(version.state) || version.evidenceIdentityVersion !== EVOLUTION_EVIDENCE_IDENTITY_VERSION || !Array.isArray(version.evidenceFingerprints)) continue;
    let intersects = false;
    for (const row of version.evidenceFingerprints) if (wanted.has(row.fingerprint)) { seen.add(row.fingerprint); intersects = true; }
    if (intersects) matchingAttemptIds.push(version.id);
  }
  const covered = identity.evidenceFingerprints.filter(row => seen.has(row.fingerprint)), uncovered = identity.evidenceFingerprints.filter(row => !seen.has(row.fingerprint));
  return { hasNewEvidence: uncovered.length > 0, coveredEvidenceIds: [...new Set(covered.map(row => row.id))], uncoveredEvidenceIds: [...new Set(uncovered.map(row => row.id))], coveredEvidenceCount: covered.length, uncoveredEvidenceCount: uncovered.length, matchingAttemptIds };
}
