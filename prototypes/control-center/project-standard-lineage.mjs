import { evolutionHash } from '../../packages/sdk/src/evolution.mjs';
/** A standard-only baseline transition grants no permission to rebase behavior.
 * Disk artifacts are checked again by the service before any paid evaluation. */
export function standardOnlyBaselineChange(project, source) {
  const current = project?.versions?.find(item => item.id === project.activeVersionId), prior = project?.versions?.find(item => item.id === source?.parentVersionId);
  const migration = current?.standardRevision;
  const capabilities = genome => evolutionHash({ systemPrompt: genome.systemPrompt, skills: genome.skills, tools: genome.tools });
  return Boolean(source && !source.sourceDeleted && !source.contextRevoked && !source.evaluationRevision && source.candidateHash && !['proposing', 'evaluating'].includes(source.state) && migration && migration.sourceBaselineVersionId === source.parentVersionId && migration.sourceBaselineHash === source.baselineHash && prior?.bundle?.hash === source.baselineHash && current.bundle?.genome && prior.bundle?.genome && capabilities(current.bundle.genome) === migration.unchangedCapabilitiesHash && capabilities(prior.bundle.genome) === migration.unchangedCapabilitiesHash);
}

export function standardAdoptionAvailable(project, review) {
  const source = project?.versions?.find(item => item.id === review?.retryOfVersionId);
  return Boolean(project && !project.archivedAt && project.initialization?.status === 'ready' && !project.trialVersionId && review
    && ['reviewed', 'rejected'].includes(review.state) && review.parentVersionId === project.activeVersionId && !review.sourceDeleted && !review.contextRevoked
    && /^[a-f0-9]{64}$/.test(review.evaluationRevision?.revisionHash ?? '') && typeof review.evaluation?.gatePassed === 'boolean'
    && review.evaluation.details?.some(row => row.baseline?.checks?.completed === true && row.candidate?.checks?.completed === true)
    && source && !source.sourceDeleted && !source.contextRevoked);
}
