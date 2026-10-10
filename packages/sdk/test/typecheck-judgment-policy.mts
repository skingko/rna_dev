// Compile-only package consumer: authored questions remain separate from host
// provenance and from the auxiliary model's bounded measurement output.
import {
  DECISION_ASSESSMENT_PLAN_SCHEMA, validateDecisionAssessmentPlan,
  decisionAssessmentPlanHash, validateToolArguments, createDecisionKernel,
  bootstrapProject, getInitiativeDecisionSchema, validateInitiativeDecision,
  type DecisionAssessmentPlan, type DecisionAssessmentOutcome,
  type BootstrapOptions, type ProjectBootstrap, type BootstrapReady,
  type InitiativeDecision, type ModelConfig, type JsonSchema,
  type OfficialClaudeStatus,
} from '@rna-agent/sdk';

const plan: DecisionAssessmentPlan = {
  version: 1,
  questions: {
    task_state: { type: 'choice', instructions: 'Classify only using verified artifacts and registered due occurrences.', criteria: { unknown: 'There is no adequate observation.', researching: 'A current report still lacks primary-source verification.', awaiting_run: 'The current report is verified and the next registered occurrence is in the future.' } },
    initiative_need: { type: 'boolean', instructions: 'Does a new verified finding warrant contacting the user before the next report?', criteria: { true: 'It changes a concrete imminent user decision.', false: 'It is unchanged status or a routine future occurrence.' } },
    user_satisfaction: { type: 'score', instructions: 'Use explicit report-quality feedback; silence is not satisfaction.', criteria: ['User explicitly rejects source quality or relevance.', 'User explicitly confirms that source quality and relevance meet requirements.'] },
  },
};
const schema: JsonSchema = DECISION_ASSESSMENT_PLAN_SCHEMA;
const validated: DecisionAssessmentPlan = validateDecisionAssessmentPlan(plan);
validateToolArguments(schema, validated);
const revision: string = decisionAssessmentPlanHash(validated);

declare const model: ModelConfig;
declare const bootstrap: ProjectBootstrap;
declare const ready: BootstrapReady;
const bootstrapOptions: BootstrapOptions = { title: 'Research project', model, judgmentPolicyContext: { enabled: true } };
const generated = bootstrapProject(bootstrapOptions);
const initial: ProjectBootstrap = { ...bootstrap, judgmentPolicy: plan };
const initializedPlan: DecisionAssessmentPlan | undefined = ready.judgmentPolicy;
const decision: InitiativeDecision = { action: 'wait', reason: 'Verified current delivery; next occurrence remains scheduled.', evidenceIds: [], content: '', nextReviewAfterMs: 60000, judgmentPolicy: plan };
const project = { actionContracts: { judgment: { enabled: true, requiresAssessment: true } } };
validateToolArguments(getInitiativeDecisionSchema({ project }), decision);
validateInitiativeDecision(decision, { project });

const kernel = createDecisionKernel({ mode: 'shadow', apiKey: async () => undefined });
const outcome = await kernel.decide({ point: 'initiative.review', scope: { projectId: 'research', revision: 'receipt-1' }, assessmentPlan: plan, fallback: { review: true }, signals: { recurring: true } });
if ('assessments' in outcome.outcome) {
  const measured: DecisionAssessmentOutcome = outcome.outcome;
  const questionNames: string[] = Object.keys(measured.assessments);
  void questionNames;
}
declare const official: OfficialClaudeStatus;
const compatible: boolean | undefined = official.accountBridgeSupported;
const missingFeatures: string[] | undefined = official.unsupportedFeatures;

// @ts-expect-error Provenance is host-authored and cannot be self-attested by a model plan.
const forged: DecisionAssessmentPlan = { ...plan, source: { kind: 'main_model' } };
// @ts-expect-error A boolean question must explain both outcomes.
const oneSided: DecisionAssessmentPlan = { version: 1, questions: { memory_need: { type: 'boolean', instructions: 'Recall?', criteria: { true: 'yes' } } } };
// @ts-expect-error Task-state options require an explicit unknown option.
const forcedChoice: DecisionAssessmentPlan = { version: 1, questions: { task_state: { type: 'choice', instructions: 'State?', criteria: { completed: 'Done' } } } };
// @ts-expect-error Auxiliary assessment does not choose a thinking effort or main-model route.
outcome.outcome.reasoning;

void [revision, generated, initial, initializedPlan, compatible, missingFeatures, forged, oneSided, forcedChoice];
