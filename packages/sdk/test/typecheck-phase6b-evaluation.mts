import { executeProjectEvaluationCase, type ProjectGenomeCase, type ProjectGenomeFollowUp, type BrowserEvaluationEnvironment, type ProjectGenome, type ModelConfig, type ProjectEvaluationCaseExecution } from '@rna-agent/sdk';

declare const genome: ProjectGenome;
declare const model: ModelConfig;
const followUp: ProjectGenomeFollowUp = { input: 'Apply the correction and preserve existing constraints.', artifactChecks: [{ id: 'kept-currency', kind: 'json_equals', path: 'report.json', expected: { currency: 'USD' } }] };
const environment: BrowserEvaluationEnvironment = { kind: 'browser', entry: 'index.html', viewport: { width: 800, height: 600 }, steps: [], screenshot: true, visualReview: true };
const testCase: ProjectGenomeCase = { id: 'conversation', input: 'Create the report.', requiredTerms: [], forbiddenTerms: [], requiredToolIds: [], weight: 1, followUps: [followUp], environment };
const execution: ProjectEvaluationCaseExecution = await executeProjectEvaluationCase({ genome, caseId: testCase.id, model });
const notPromotable: false = execution.promotionEligible;
// @ts-expect-error Visual review is an explicit boolean contract.
const invalidVisual: BrowserEvaluationEnvironment = { ...environment, visualReview: 'required' };
// @ts-expect-error A follow-up cannot replace the supplied model or evaluation standard.
const invalidFollowUp: ProjectGenomeFollowUp = { ...followUp, modelId: 'easier-judge' };
void [notPromotable, invalidVisual, invalidFollowUp];
