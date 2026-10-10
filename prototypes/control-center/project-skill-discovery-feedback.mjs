import { evolutionHash } from '../../packages/sdk/src/evolution.mjs';
import { createProjectEvaluationExposurePlan } from '../../packages/sdk/src/project-evaluation-exposure.mjs';
import { validateProjectEvaluationPartitionPlan } from '../../packages/sdk/src/project-evaluation-partitions.mjs';
import { validateProjectEvaluationRepeatPlan } from '../../packages/sdk/src/project-evaluation-repeats.mjs';
import { describeProjectGenomeChanges, projectGenomeBehaviorHash } from '../../packages/sdk/src/project-evolution-search.mjs';
import { validateProjectGenome } from '../../packages/sdk/src/project-genome.mjs';

const list = value => Array.isArray(value) ? value : [];
const same = (a, b) => evolutionHash(a) === evolutionHash(b);
const eligible = version => version.simulated === false && !version.sourceDeleted && !version.contextRevoked && version.state !== 'stale';
const binding = version => ({ versionId: version.id, baselineHash: version.baselineHash, candidateHash: version.candidateHash ?? version.bundle?.hash,
  evidenceHash: version.evidenceHash, modelHash: version.modelHash, comparisonKey: version.searchContext?.comparisonKey, partitionPlanHash: version.evaluationPartitions?.planHash,
  repeatPlanHash: version.evaluationRepeatPlan?.planHash ?? null, executionHash: version.evaluationExecution?.manifestHash,
  runtimeHash: version.evaluationRuntimeHash, receiptHash: evolutionHash(version.evaluation ?? version.evaluationEvidence ?? null) });

/** A failed draft is not a committed capability bundle. Retain only its public
 * search identity and delivery facts while the actual candidate is in memory.
 * The receipt hash binds the summary to the original unscored failure record.
 */
export function createEvolutionSkillDeliveryDiagnostic(version, baseline, candidate) {
  const valid = validateProjectGenome(candidate), candidateHash = evolutionHash(valid);
  if (!eligible(version) || version.candidateHash !== candidateHash) return undefined;
  const skillDelivery = projectSkillDelivery(version, baseline, valid, candidateHash);
  if (!skillDelivery) return undefined;
  const identity = binding(version);
  if (Object.entries(identity).some(([key, value]) => key !== 'repeatPlanHash' && (typeof value !== 'string' || !value))) return undefined;
  const units = new Map();
  for (const { kind, id, change } of describeProjectGenomeChanges(baseline, valid).changes) {
    const unitKind = kind === 'resource' ? 'skill' : kind, key = `${unitKind}:${id}`;
    if (!units.has(key)) units.set(key, { kind: unitKind, id, change: kind === 'resource' ? 'modified' : change });
  }
  const value = { schemaVersion: 1, binding: identity, baselineBehaviorHash: projectGenomeBehaviorHash(baseline), candidateBehaviorHash: projectGenomeBehaviorHash(valid), changedAssets: [...units.values()].slice(0, 32), skillDelivery };
  return { ...value, digest: evolutionHash(value) };
}

export function readEvolutionSkillDeliveryDiagnostic(version, baseline) {
  if (!eligible(version)) return undefined;
  const value = version.skillDeliveryDiagnostic;
  if (!value || value.schemaVersion !== 1) return undefined;
  const { digest, ...body } = value;
  try {
    if (digest !== evolutionHash(body) || !same(value.binding, binding(version)) || value.baselineBehaviorHash !== projectGenomeBehaviorHash(baseline)
      || !/^[a-f0-9]{64}$/.test(value.candidateBehaviorHash) || !Array.isArray(value.changedAssets) || !value.skillDelivery) return undefined;
    return structuredClone(value);
  } catch { return undefined; }
}

/** Engineering feedback from retained selection executions, independently of
 * their quality verdict. No task text, judge data or confirmation observation
 * crosses this projection. The caller supplies host-owned version receipts.
 */
export function describeEvolutionSkillDelivery(version, baseline) {
  if (!eligible(version)) return undefined;
  if (!version.bundle?.genome) return readEvolutionSkillDeliveryDiagnostic(version, baseline)?.skillDelivery;
  return projectSkillDelivery(version, baseline, version.bundle.genome, version.bundle.hash);
}

function projectSkillDelivery(version, baseline, candidate, candidateHash) {
  const evaluation = version.evaluation ?? version.evaluationEvidence;
  if (!evaluation || evaluation.simulated !== false || !version.evaluationExecution?.manifestHash
    || evaluation.baselineHash !== version.baselineHash || evaluation.candidateHash !== candidateHash
    || evaluation.evaluationRuntimeHash !== version.evaluationRuntimeHash
    || evaluation.evaluationExecution?.manifestHash !== version.evaluationExecution.manifestHash) return undefined;
  let plan, partitions, slots;
  try {
    plan = createProjectEvaluationExposurePlan({ baseline, candidate });
    partitions = validateProjectEvaluationPartitionPlan(version.evaluationPartitions, baseline.evaluationSuite);
    if (plan.baselineHash !== version.baselineHash || plan.candidateHash !== candidateHash || evaluation.suiteHash !== partitions.suiteHash) return undefined;
    slots = partitions.assignments.filter(row => row.partition === 'selection').map(row => ({ id: row.caseId }));
    // An evaluation report cannot attest its own precommitment. Ordinary host
    // evolution currently has no repeat plan; explicit future callers must
    // retain one separately before these repeated receipts become admissible.
    if (evaluation.repeatPlan || version.evaluationRepeatPlan) {
      if (!evaluation.repeatPlan || !version.evaluationRepeatPlan) return undefined;
      const repeats = validateProjectEvaluationRepeatPlan(version.evaluationRepeatPlan, { suite: baseline.evaluationSuite,
        partitionPlan: partitions, baselineHash: version.baselineHash, modelHash: version.modelHash, evaluationRuntimeHash: version.evaluationRuntimeHash });
      if (!same(evaluation.repeatPlan, repeats)) return undefined;
      slots = repeats.trials.map(({ id, caseId, repeatIndex }) => ({ id, caseId, repeatIndex }));
    }
  } catch { return undefined; } // Old, revoked or mismatched evidence stays absent.
  const changes = plan.changes.filter(row => row.mode === 'skill_content' && row.candidate.present);
  if (!changes.length || !slots.length || slots.length > 2000) return undefined;
  const seen = new Set(), executions = [];
  const details = [...list(evaluation.details ?? evaluation.cases)];
  if (evaluation.inFlightCase && !details.some(row => row.id === evaluation.inFlightCase.id)) details.push(evaluation.inFlightCase);
  for (const detail of details.filter(row => row.partition === 'selection')) {
    const slot = slots.find(row => row.id === detail.id);
    if (!slot || seen.has(detail.id) || slot.caseId !== undefined && (detail.caseId !== slot.caseId || detail.repeatIndex !== slot.repeatIndex)) return undefined;
    seen.add(detail.id);
    const receipt = detail.candidate?.exposure;
    if (!receipt) continue;
    if (receipt.planHash !== plan.planHash || receipt.genomeHash !== plan.candidateHash || receipt.side !== 'candidate'
      || receipt.method !== plan.method || typeof receipt.contextExposed !== 'boolean' || typeof receipt.receiptsComplete !== 'boolean') return undefined;
    const rows = list(receipt.changes);
    if (new Set(rows.map(row => row.id)).size !== rows.length) return undefined;
    for (const change of changes) {
      const row = rows.find(item => item.id === change.id);
      if (row && (row.kind !== change.kind || row.target !== change.target || row.mode !== change.mode || row.contentHash !== change.candidate.hash)) return undefined;
    }
    executions.push(receipt);
  }
  if (!executions.length) return undefined;
  const items = changes.slice(0, 32).map(change => {
    const item = { id: change.skillId, path: change.path, catalogSubmitted: 0, resourceInventorySubmitted: 0,
      delivered: 0, notRequested: 0, contentNotSubmitted: 0, partialDelivery: 0, unknown: 0 };
    for (const receipt of executions) {
      const row = receipt.changes.find(value => value.id === change.id);
      if (receipt.contextExposed) item.catalogSubmitted++;
      if (change.path !== 'SKILL.md' && row?.inventoryObserved === true) item.resourceInventorySubmitted++;
      if (row?.status === 'observed' && row.reason === 'verified_content_covers_change') item.delivered++;
      else if (receipt.contextExposed && receipt.receiptsComplete && row?.status === 'unobserved' && row.attemptedCalls === 0 && row.reason === 'changed_content_not_delivered') item.notRequested++;
      else if (row?.status === 'unobserved' && row.reason === 'tool_content_not_in_submitted_request' && row.attemptedCalls > 0) item.contentNotSubmitted++;
      else if (row?.status === 'unknown' && row.reason === 'only_partial_change_region_delivered' && row.attemptedCalls > 0) item.partialDelivery++;
      else item.unknown++;
    }
    return item;
  });
  return { scope: 'selection_runtime_receipts', qualityClaim: 'none', observedExecutions: executions.length, expectedExecutions: slots.length, omittedItems: Math.max(0, changes.length - items.length), items };
}
