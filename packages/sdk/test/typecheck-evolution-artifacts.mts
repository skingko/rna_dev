import { type ProjectArtifactCheck, type ProjectGenomeWorkspace, type ProjectEvolutionDiagnosis, type ProjectEvolutionLearningIntent, type ProjectGenomeEvaluation, type ProjectGenome, smokeProjectGenome, proposeProjectGenome, validateProjectEvolutionLearningIntent, type ModelConfig, PROJECT_EVALUATION_RUNTIME } from '@rna-agent/sdk';
import { type ProjectLearningContext, createProjectLearningContext, validateProjectLearningContext, LEARNING_CONTEXT_LIMITS, type LearningCoordinator, type LearningState } from '@rna-agent/sdk';
const syntax: ProjectArtifactCheck = { id: 'syntax', path: 'out/app.mjs', kind: 'javascript_syntax', dialect: 'module' };
const json: ProjectArtifactCheck = { id: 'data', path: 'out/data.json', kind: 'json_equals', expected: { value: 4 } };
const workspace: ProjectGenomeWorkspace = { files: [{ path: 'input.txt', content: 'input' }], checks: [syntax, json] };
// @ts-expect-error syntax requires an explicit parser dialect
const missingDialect: ProjectArtifactCheck = { id: 'syntax', path: 'app.js', kind: 'javascript_syntax' };
// @ts-expect-error the trusted validator registry does not accept shell programs
const arbitraryExecution: ProjectArtifactCheck = { id: 'execute', path: 'app.js', kind: 'shell', command: 'node app.js' };
declare const genome: ProjectGenome;
declare const model: ModelConfig;
genome.evaluationSuite.cases[0].workspace = workspace;
genome.evaluationSuite.execution = { maxSteps: 16, maxOutputTokens: 4096 };
genome.tools[0].smokeCases[0].workspace = { files: [{ path: 'rows.json', content: '[3,4]' }] };
// @ts-expect-error smoke fixtures provide input files, not candidate-controlled runtime commands
genome.tools[0].smokeCases[0].workspace = { files: [], command: 'node bypass.mjs' };
const smoke = await smokeProjectGenome(genome);
const actuallyExecuted: boolean = smoke.executed;
const applicable: boolean = smoke.applicable;
const generated = await proposeProjectGenome({ project: {}, baseline: genome, evidence: [], model });
const inheritedBaselineHash: string | undefined = generated.proposal.toolInheritance?.baselineHash;
const inheritedToolHashes: string[] | undefined = generated.proposal.toolInheritance?.tools.map(tool => tool.toolHash);
// @ts-expect-error author references must be materialized before a tool can be published
genome.tools[0] = { id: 'existing_tool', inheritFromBaseline: true };
console.log(inheritedBaselineHash, inheritedToolHashes);
const intent: ProjectEvolutionLearningIntent = { content: 'Check the reusable interpretation method.', reason: 'The observed result supports a bounded hypothesis.', evidenceIds: ['fact'] };
const checkedIntent: ProjectEvolutionLearningIntent | undefined = validateProjectEvolutionLearningIntent(intent, [{ id: 'fact' }]);
void proposeProjectGenome({ project: {}, baseline: genome, evidence: [{ id: 'fact' }], model, learningIntent: checkedIntent });
const learningContext: ProjectLearningContext = { schemaVersion: 1, evidence: [{ id: 'fact', content: '{"exitCode":1}' }], files: [{ path: 'src/main.js', content: 'export const actual = 1;' }] };
const checkedContext = validateProjectLearningContext(learningContext, [{ id: 'fact' }]);
const frozen = createProjectLearningContext(checkedContext, [{ id: 'fact' }], { onRead(receipt) { console.log(receipt.contentHash); } });
const maxSourceBytes: 1048576 = LEARNING_CONTEXT_LIMITS.totalBytes;
void proposeProjectGenome({ project: {}, baseline: genome, evidence: [{ id: 'fact' }], model, learningContext, requestControl: { beforeRequest(request) { const requestId: string = request.id; console.log(requestId); } } });
// @ts-expect-error authoring only accepts frozen data, never a supplied executor
const unsafeContext: ProjectLearningContext = { ...learningContext, execute: () => {} };
console.log(frozen?.contextHash, maxSourceBytes, unsafeContext);
declare const learning: LearningCoordinator;
declare const learningState: LearningState;
const awaitingEvidence: number = learning.health().awaitingEvidence;
learningState.episodes[0].status = 'awaiting_evidence';
learningState.episodes[0].consecutiveFailures = 3;
learningState.episodes[0].deferCount = 0;
void learning.reconcile('review-id', { status: 'retry_experiment', verifiedNoExecution: true });
// @ts-expect-error interrupted experiments require an explicit proof of no dispatch
void learning.reconcile('review-id', { status: 'retry_experiment' });
console.log(awaitingEvidence);
// @ts-expect-error learning intent cannot grant tool permissions
const intentPermission: ProjectEvolutionLearningIntent = { ...intent, permission: 'execute' };
void intentPermission;
const diagnosis: ProjectEvolutionDiagnosis = generated.proposal.diagnosis;
declare const evaluated: ProjectGenomeEvaluation;
const visualClaim: 'not_verified' = evaluated.coverage.visualQuality;
const implementationHash: string = evaluated.evaluationRuntime.implementationHash;
const nodeVersion: string = PROJECT_EVALUATION_RUNTIME.nodeVersion;
console.log(actuallyExecuted, applicable, diagnosis, visualClaim, implementationHash, nodeVersion, missingDialect, arbitraryExecution);

// Structural judge diagnostics expose paths/types, never inferred scores.
import { type ProjectEvolutionError } from "@rna-agent/sdk";
declare const judgeFailure: ProjectEvolutionError;
const missingJudgeFields: string[] | undefined = judgeFailure.evolutionDiagnostic?.missingFields;
const invalidJudgeIndex: number | undefined = judgeFailure.evolutionDiagnostic?.invalidIdTypes?.[0]?.index;
void [missingJudgeFields, invalidJudgeIndex];

import { executeProjectEvaluationCase, type ProjectEvaluationCaseExecution } from '@rna-agent/sdk';
const behavior: ProjectArtifactCheck = { id: 'increment', path: 'out/app.mjs', kind: 'javascript_function', exportName: 'increment', args: [7], expected: 8 };
// @ts-expect-error function inputs must be explicit JSON argument arrays
const invalidBehavior: ProjectArtifactCheck = { id: 'increment', path: 'out/app.mjs', kind: 'javascript_function', exportName: 'increment', args: 7, expected: 8 };
const single: ProjectEvaluationCaseExecution = await executeProjectEvaluationCase({ genome, caseId: 'web', model });
const diagnosticOnly: false = single.promotionEligible;
const singleScope: 'single_case_execution_only' = single.scope;
void [behavior, invalidBehavior, diagnosticOnly, singleScope];
