import { evolutionHash } from '../../packages/sdk/src/evolution.mjs';
import { projectGenomeBehaviorHash, projectEvolutionEvidenceHash, describeProjectGenomeChanges } from '../../packages/sdk/src/project-evolution-search.mjs';
import { createProjectEvaluationExposurePlan, summarizeProjectEvaluationExposure } from '../../packages/sdk/src/project-evaluation-exposure.mjs';
import { describeEvolutionSkillDelivery, readEvolutionSkillDeliveryDiagnostic } from './project-skill-discovery-feedback.mjs';

const list = value => Array.isArray(value) ? value : [];
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const retained = row => row?.simulated === false && !row.sourceDeleted && !row.contextRevoked && row.state !== 'stale';
const selectionGates = ['deterministicCases', 'minimumScore', 'improvement', 'noRegression', 'tokenRatio'];
const hostExecution = () => ({ node: process.versions.node, v8: process.versions.v8, platform: process.platform, arch: process.arch });

/** A search identity is intentionally separate from paid-request admission.
 * Historical feedback cannot itself make otherwise identical evidence new. */
export function createEvolutionSearchContext({ baseline, evidence, modelHash, evaluationRuntimeHash, evaluationExecution, evaluationPartitions, learningContextHash } = {}) {
  const baselineBehaviorHash = projectGenomeBehaviorHash(baseline);
  const feedbackIdentity = { baselineBehaviorHash, modelHash, evaluationRuntimeHash, executionHash: evaluationExecution.manifestHash,
    suiteHash: evaluationPartitions.suiteHash, partitionHash: evolutionHash({ method: evaluationPartitions.method, assignments: evaluationPartitions.assignments, suiteHash: evaluationPartitions.suiteHash, confirmation: evaluationPartitions.confirmation }), hostExecution: hostExecution() };
  const identity = { ...feedbackIdentity, learningContextHash: learningContextHash ?? null };
  return { schemaVersion: 1, method: 'host-bounded-search-v1', ...identity, feedbackKey: evolutionHash(feedbackIdentity), comparisonKey: evolutionHash(identity), evidenceHash: projectEvolutionEvidenceHash(evidence) };
}

/** Selection feedback only. Confirmation answers, scores and even its result
 * are deliberately absent: subsequent authoring must not learn hidden tasks. */
export function describeEvolutionSearchOutcome(version, baseline) {
  const e = version.evaluation ?? version.evaluationEvidence ?? {}, diagnostic = version.error?.diagnostic ?? {}, stage = diagnostic.phase ?? e.stage ?? 'unrecorded';
  const skillDelivery = describeEvolutionSkillDelivery(version, baseline);
  const deliveryDiagnostic = skillDelivery ? { skillDelivery } : {};
  const none = (reason, outcome = 'incomplete') => ({ outcome, measured: false, reason, stage, ...deliveryDiagnostic });
  if (!retained(version)) return none('source_unavailable', 'not_evaluated');
  if (version.state === 'no_change') return none('author_no_change', 'not_evaluated');
  if (['proposing', 'evaluating'].includes(version.state)) return none('in_progress', 'not_evaluated');
  const candidate = version.bundle?.genome;
  if (!candidate) return none(['proposal', 'script-repair'].includes(stage) ? 'author_incomplete' : 'candidate_not_retained', 'not_evaluated');
  if (e.stage === 'script_preflight') return none('preflight_incomplete', 'not_evaluated');
  if (['provider_error', 'http_error', 'provider_termination', 'provider_protocol', 'incomplete_stream', 'total_timeout', 'idle_timeout'].includes(version.error?.code)) return none('provider_incomplete');
  const selection = e.selection, plan = version.evaluationPartitions, ids = list(plan?.assignments).filter(row => row.partition === 'selection').map(row => row.caseId);
  const details = list(e.details ?? e.cases).filter(row => ids.includes(row.id) && row.partition === 'selection');
  if (e.simulated !== false || e.baselineHash !== version.baselineHash || e.candidateHash !== version.bundle?.hash || e.suiteHash !== plan?.suiteHash
    || e.evaluationRuntimeHash !== version.evaluationRuntimeHash || e.evaluationExecution?.manifestHash !== version.evaluationExecution?.manifestHash) return none('execution_identity_unverified');
  if (!selection || !ids.length || selection.cases !== ids.length || details.length !== ids.length || new Set(details.map(row => row.id)).size !== ids.length
    || typeof selection.gatePassed !== 'boolean'
    || !Number.isFinite(selection.baselineScore) || !Number.isFinite(selection.candidateScore)
    || details.some(row => !Number.isFinite(row.baselineScore) || !Number.isFinite(row.candidateScore) || row.baseline?.passed !== true || row.candidate?.passed !== true)) return none('selection_incomplete');
  // Browser identity is acquired only after an actual probe. Until a future
  // invocation has the same probe identity, it must not prune an old candidate.
  if (e.environmentIdentity) return none('environment_identity_not_preflighted');
  let exposure;
  try { exposure = summarizeProjectEvaluationExposure({ plan: createProjectEvaluationExposurePlan({ baseline, candidate }), cases: details, expectedCaseIds: ids }); }
  catch { return none('exposure_unverified'); }
  const applicable = exposure.candidate.changes.filter(row => ['request_context', 'skill_content', 'tool_execution'].includes(row.mode) && row.change !== 'removed');
  const delivery = { required: applicable.length, observed: applicable.filter(row => row.status === 'observed').length,
    unobserved: applicable.filter(row => row.status === 'unobserved').length, unknown: applicable.filter(row => !['observed', 'unobserved'].includes(row.status)).length };
  if (!applicable.length || applicable.some(row => row.status !== 'observed')) return { ...none('changes_not_exercised'), exposure: delivery };
  const accepted = selection.gatePassed === true;
  return { outcome: accepted ? 'accepted' : 'rejected', measured: true,
    reason: accepted ? 'selection_passed' : selection.candidateScore <= selection.baselineScore ? 'selection_no_gain' : 'selection_constraints_failed', stage: 'selection',
    failedGates: selectionGates.filter(gate => selection.gates?.[gate] === false), exposure: delivery, ...deliveryDiagnostic };
}

export function createEvolutionSearchPolicy(project, { baseline, context, redact = value => value } = {}) {
  const diagnostics = [], history = [];
  for (const version of list(project.versions)) {
    if (!retained(version) || version.evaluationRevision || version.standardRevision || version.searchContext?.feedbackKey !== context.feedbackKey) continue;
    const source = version.searchContext, candidate = version.bundle?.genome, deliveryDiagnostic = candidate ? undefined : readEvolutionSkillDeliveryDiagnostic(version, baseline);
    const outcome = describeEvolutionSearchOutcome(version, baseline);
    const comparable = source.comparisonKey === context.comparisonKey;
    diagnostics.push({ versionId: version.id, ...outcome, comparable });
    // An unfinished author still has a durable diagnostic, but no candidate
    // identity. Do not invent one just to fill the SDK's history schema.
    if ((!candidate && !deliveryDiagnostic) || !hash(source?.evidenceHash) || !version.proposal?.hypothesis?.trim()) continue;
    const units = new Map();
    for (const { kind, id, change } of candidate ? describeProjectGenomeChanges(baseline, candidate).changes : deliveryDiagnostic.changedAssets) {
      const unitKind = kind === 'resource' ? 'skill' : kind;
      const key = `${unitKind}:${id}`; if (!units.has(key)) units.set(key, { kind: unitKind, id, change: kind === 'resource' ? 'modified' : change });
    }
    history.push({ id: version.id, baselineBehaviorHash: context.baselineBehaviorHash, candidateBehaviorHash: candidate ? projectGenomeBehaviorHash(candidate) : deliveryDiagnostic.candidateBehaviorHash, evidenceHash: source.evidenceHash,
      comparisonKey: source.comparisonKey, hypothesis: redact(String(version.proposal.hypothesis).slice(0, 320)), outcome: comparable ? outcome.outcome : 'not_evaluated',
      changedAssets: [...units.values()].slice(0, 32), feedback: { reason: outcome.reason, comparable,
        ...(outcome.failedGates ? { failedGates: outcome.failedGates } : {}), ...(outcome.exposure ? { exposure: outcome.exposure } : {}), ...(outcome.skillDelivery ? { skillDelivery: outcome.skillDelivery } : {}) } });
  }
  const tail = diagnostics.slice(-3), narrowed = tail.length === 3 && tail.every(row => row.comparable && row.measured && row.reason === 'selection_no_gain');
  const measured = row => ['accepted', 'rejected'].includes(row.outcome);
  const includedIds = new Set([...history.filter(measured).slice(-8), ...history.filter(row => !measured(row)).slice(-4)].map(row => row.id));
  const policy = { maxChangedAssets: narrowed ? 1 : 4, comparisonKey: context.comparisonKey, history: history.filter(row => includedIds.has(row.id)) };
  const summary = { schemaVersion: 1, method: context.method, maxChangedAssets: policy.maxChangedAssets, mode: narrowed ? 'focused' : 'bounded',
    reason: narrowed ? 'three_comparable_measured_no_gain' : 'bounded_related_change', historyTotal: diagnostics.length, historyIncluded: policy.history.length, historyOmitted: diagnostics.length - policy.history.length,
    measured: diagnostics.filter(row => row.comparable && row.measured).length, unmeasured: diagnostics.filter(row => !row.comparable || !row.measured).length,
    recentFeedback: diagnostics.slice(-8), heuristic: true, qualityGatesChanged: false, confirmationFeedbackIncluded: false };
  return { policy, summary, sourceVersionIds: policy.history.map(row => row.id) };
}
