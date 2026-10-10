import { proposeProjectGenome, projectEvolutionAuthorSearchContext, type ProjectGenomeProposalOptions, type ProjectGenomeProposalResult, type ProjectGenomeAbstentionResult, type ProjectEvolutionAbstention, type ProjectEvolutionSearchFeedback } from '@rna-agent/sdk';

declare const options: ProjectGenomeProposalOptions;
declare const dynamicSetting: boolean;
const legacy: ProjectGenomeProposalResult = await proposeProjectGenome(options);
const explicitLegacy: ProjectGenomeProposalResult = await proposeProjectGenome({ ...options, allowAbstention: false });
const legacyGenome = legacy.proposal.genome;
const result = await proposeProjectGenome({ ...options, allowAbstention: dynamicSetting });
if (result.status === 'no_change') {
  const stop: ProjectGenomeAbstentionResult = result;
  const judgment: ProjectEvolutionAbstention = stop.abstention;
  const unvalidated: null = stop.validation;
  // @ts-expect-error An author stop does not contain a publishable genome.
  result.proposal.genome;
  void [judgment, unvalidated];
} else {
  const proposal: ProjectGenomeProposalResult = result;
  void proposal.proposal.genome;
}
const enabled = await proposeProjectGenome({ ...options, allowAbstention: true });
// @ts-expect-error Opt-in callers must distinguish a candidate from no_change.
enabled.proposal.genome;
// @ts-expect-error Provider failures must never be encoded as model abstention reasons.
const invalidReason: ProjectEvolutionAbstention['reason'] = 'provider_error';
// @ts-expect-error Wake conditions do not create timers or user permission.
const invalidWake: ProjectEvolutionAbstention['revisitWhen'][number] = { condition: 'new_work_evidence', description: 'New receipt', nextRunAt: '2030-01-01' };
const feedback: ProjectEvolutionSearchFeedback = { reason: 'changes_not_exercised', comparable: true, exposure: { required: 1, observed: 0, unobserved: 1, unknown: 0 } };
// @ts-expect-error Confirmation outcomes must not enter future author feedback.
const unsafeFeedback: ProjectEvolutionSearchFeedback = { reason: 'selection_no_gain', comparable: true, failedGates: ['confirmation'] };
// @ts-expect-error Arbitrary grader prose is not part of aggregate search feedback.
const leakedFeedback: ProjectEvolutionSearchFeedback = { reason: 'selection_no_gain', comparable: true, judgeText: 'hidden answer' };
void [explicitLegacy, legacyGenome, invalidReason, invalidWake, feedback, unsafeFeedback, leakedFeedback, projectEvolutionAuthorSearchContext()];
