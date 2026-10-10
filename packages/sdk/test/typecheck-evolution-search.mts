import { proposeProjectGenome, projectGenomeBehaviorHash, projectEvolutionEvidenceHash, describeProjectGenomeChanges, reviewProjectEvolutionCandidate, projectEvolutionAuthorSearchContext, validateProjectEvolutionSearchPolicy, type ProjectGenome, type ModelConfig, type ProjectEvolutionSearchPolicy, type ProjectEvolutionSearchReview, type ProjectEvolutionSearchHistoryEntry } from '@rna-agent/sdk';

declare const baseline: ProjectGenome;
declare const candidate: ProjectGenome;
declare const model: ModelConfig;
const changes = describeProjectGenomeChanges(baseline, candidate);
const previous: ProjectEvolutionSearchHistoryEntry = { id: 'prior', baselineBehaviorHash: projectGenomeBehaviorHash(baseline), candidateBehaviorHash: projectGenomeBehaviorHash(candidate), evidenceHash: projectEvolutionEvidenceHash([{ id: 'receipt' }]), comparisonKey: 'f'.repeat(64), hypothesis: 'Interpret source evidence before concluding.', outcome: 'incomplete', changedAssets: [{ kind: 'skill', id: 'review', change: 'modified' }] };
const policy: ProjectEvolutionSearchPolicy = { maxChangedAssets: 2, comparisonKey: 'f'.repeat(64), history: [previous] };
const review: ProjectEvolutionSearchReview = reviewProjectEvolutionCandidate({ baseline, candidate, evidence: [], hypothesis: previous.hypothesis, searchPolicy: policy });
const proposal = await proposeProjectGenome({ project: {}, baseline, evidence: [], model, searchPolicy: policy });
const enforced: boolean | undefined = proposal.proposal.searchReview?.enforced;
const count: number = changes.changedAssetCount;
// @ts-expect-error Evaluation/confirmation results do not belong in author history.
const unsafe: ProjectEvolutionSearchHistoryEntry = { ...previous, confirmation: { passed: true } };
// @ts-expect-error A single measurement cannot be labelled statistically significant by this API.
const invented: ProjectEvolutionSearchHistoryEntry = { ...previous, outcome: 'proven_better' };
// @ts-expect-error Platform runtime changes are outside project capability search.
const scope: ProjectEvolutionSearchPolicy = { history: [{ ...previous, changedAssets: [{ kind: 'server', id: 'runtime', change: 'modified' }] }] };
// @ts-expect-error Search policy cannot lower existing quality gates.
await proposeProjectGenome({ project: {}, baseline, evidence: [], model, searchPolicy: { minImprovement: 0 } });
void [enforced, count, review, unsafe, invented, scope, projectEvolutionAuthorSearchContext(policy), validateProjectEvolutionSearchPolicy(policy)];
