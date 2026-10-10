import { evaluateProjectGenomes, proposeProjectGenome, PROJECT_EVALUATION_RUNTIME, type ProjectGenome, type ModelConfig, type ProjectAssetDeclarations, type ProjectEvaluationExecutionManifest } from '@rna-agent/sdk';

declare const baseline: ProjectGenome;
declare const candidate: ProjectGenome;
declare const model: ModelConfig;
const assetDeclarations: ProjectAssetDeclarations = {
  withdrawSkillResources: [{ skillId: 'design', path: 'references/obsolete.md', beforeHash: 'a'.repeat(64), reason: 'Replaced by the documented current procedure.' }],
};
const result = await evaluateProjectGenomes({ baseline, candidate, model, assetDeclarations });
const manifest: ProjectEvaluationExecutionManifest = result.evaluationExecution;
const cap: number = manifest.cases[0].execution.maxOutputTokens;
const disabled: false = PROJECT_EVALUATION_RUNTIME.sessionPolicy.autoCompaction;
const proposal = await proposeProjectGenome({ project: {}, baseline, evidence: [], model });
const provenance: string = proposal.proposal.assetChanges.baselineHash;
// @ts-expect-error A frozen comparison manifest is read-only.
manifest.cases[0].execution.maxSteps = 3;
// @ts-expect-error Withdrawals must bind an exact previous object hash.
const missingHash: ProjectAssetDeclarations = { withdrawSkills: [{ id: 'design', reason: 'Not required any more.' }] };
void [cap, disabled, provenance, missingHash];
