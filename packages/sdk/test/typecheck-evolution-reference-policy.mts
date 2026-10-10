import {
  proposeProjectGenome, ProjectEvolutionError, SkillMarketplaceClient,
  type ProjectReferencePolicy, type ProjectReferenceDiscovery, type ProjectGenomeProposalOptions,
  type SkillMarketplaceSearchCoverage,
} from '@rna-agent/sdk';

const policy: ProjectReferencePolicy = {
  async beforeNoChange({ abstention, stage, signal, message }) {
    signal?.throwIfAborted();
    const reason: 'no_method_gap' | 'insufficient_evidence' = abstention.reason;
    const boundary: 'before_finish' | 'finalize' = stage;
    void reason; void boundary; void message;
    return undefined;
  },
  snapshot: () => ({ searches: [], references: [], failures: [], packages: [] }),
};
declare const options: ProjectGenomeProposalOptions;
const result = await proposeProjectGenome({ ...options, allowAbstention: true, referencePolicy: policy });
const receipt: ProjectReferenceDiscovery | undefined = result.referenceDiscovery;
const installed: false | undefined = receipt?.installed;
const failure = new ProjectEvolutionError('Example');
const failureReceipt: ProjectReferenceDiscovery | undefined = failure.referenceDiscovery;
void installed; void failureReceipt;
const search = await new SkillMarketplaceClient().search({ query: 'research' });
const coverage: SkillMarketplaceSearchCoverage = search.coverage;
const status: 'complete' | 'partial' | 'unsupported' | 'empty' = coverage.status;
void status;
// @ts-expect-error A stop hook cannot manufacture a ready or adopted result.
const invalid: ProjectReferencePolicy = { beforeNoChange: () => ({ accepted: true }) };
// @ts-expect-error Discovery metadata never carries source bodies.
const sourceBody: string = receipt?.sources?.[0]?.content;
void invalid; void sourceBody;
