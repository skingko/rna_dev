import {
  prepareProjectSkillFoundation, ProjectSkillFoundationError,
  type ProjectSkillFoundationOptions, type ProjectSkillFoundationResult,
  type ProjectGenome, type ProjectGenomeSkill, type InstalledSkillProvenance,
  type ModelConfig, type ProjectReferencePolicy,
} from '@rna-agent/sdk';

declare const baseline: ProjectGenome;
declare const model: ModelConfig;
declare const installed: ProjectGenomeSkill & { source: InstalledSkillProvenance };
const sourceKind: 'installed-skill-package' = installed.source.kind;
const integrity: 'installed_snapshot' = installed.source.integrity;
void sourceKind; void integrity;
const policy: ProjectReferencePolicy & { finalizeGenome(genome: ProjectGenome): ProjectGenome } = {
  finalizeGenome: genome => genome,
  snapshot: () => ({ searches: [], references: [], failures: [], packages: [] }),
};
const options: ProjectSkillFoundationOptions = {
  project: { title: 'Existing research workspace' }, baseline, model,
  existingInstalledSkills: [installed], referencePolicy: policy,
  beforeRequest({ requestId, requestIndex, estimatedTokens, usage, signal }) {
    signal?.throwIfAborted(); void requestId; void requestIndex; void estimatedTokens; void usage;
  },
  onEvent(event) { void event.type; },
};
const result: ProjectSkillFoundationResult = await prepareProjectSkillFoundation(options);
const evaluated: false = result.evaluationPerformed;
const preserved: true = result.behaviorPreserved;
void evaluated; void preserved; void result.requests[0]?.admitted;
const failure = new ProjectSkillFoundationError('Not ready');
void failure.referenceDiscovery; void failure.requests;
// @ts-expect-error Foundation mode has no score or adoption result.
const passed: boolean = result.gatePassed;
// @ts-expect-error Host source finalization is mandatory.
await prepareProjectSkillFoundation({ project: {}, baseline, model });
// @ts-expect-error A generated skill is not a verified installed snapshot.
await prepareProjectSkillFoundation({ ...options, existingInstalledSkills: [baseline.skills[0]] });
// @ts-expect-error Installed integrity cannot claim independent Git blob verification.
const wrongIntegrity: InstalledSkillProvenance['integrity'] = 'git_blob_verified';
void passed; void wrongIntegrity;
