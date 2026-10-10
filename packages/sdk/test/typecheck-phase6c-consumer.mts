import {
  createProjectEvaluationRepeatPlan, validateProjectEvaluationRepeatPlan, summarizeProjectEvaluationRepeats,
  evaluateProjectGenomes, createSession, PROJECT_EVALUATION_REPEAT_METHOD, PROJECT_EVALUATION_RUNTIME,
  type ProjectEvaluationRepeatBinding, type ProjectEvaluationRepeatPlan, type ProjectEvaluationRepeatReceipt,
  type ProjectEvaluationRepeatedMeasurement, type ProjectEvaluationRepeatResult,
  type ProjectGenomeRequestControl, type ProjectGenomeEvolutionOptions, type ProjectGenomeEvaluation,
  type ProjectEvaluationConfirmationControl, type ProjectGenome, type SessionOptions, type JsonObject,
} from '@rna-agent/sdk';

declare const binding: ProjectEvaluationRepeatBinding;
declare const baseline: ProjectGenome;
declare const candidate: ProjectGenome;
declare const options: ProjectGenomeEvolutionOptions;
declare const sessionOptions: SessionOptions;

const repeatPlan = createProjectEvaluationRepeatPlan({ ...binding, repeatCount: 2, seed: 'a'.repeat(64) });
const restored: ProjectEvaluationRepeatPlan = validateProjectEvaluationRepeatPlan(repeatPlan, binding);
const count: 2 | 3 = restored.repeatCount;
const method: 'project-selection-repeats-v1' = PROJECT_EVALUATION_REPEAT_METHOD.id;
const planHash: string = restored.planHash;
// @ts-expect-error Repetition allocation is frozen, not an adaptive public knob.
restored.repeatCount = 3;
// @ts-expect-error Only the two preregistered allocation sizes are supported.
createProjectEvaluationRepeatPlan({ ...binding, repeatCount: 4, seed: 'b'.repeat(64) });
// @ts-expect-error An unchanged-baseline control still needs explicit model identity.
const missingBinding: ProjectEvaluationRepeatBinding = { suite: binding.suite, partitionPlan: binding.partitionPlan, baselineHash: 'a', evaluationRuntimeHash: 'b' };

const trial = restored.trials[0]!;
const receipt: ProjectEvaluationRepeatReceipt = { trialId: trial.id, caseId: trial.caseId, repeatIndex: trial.repeatIndex, repeatPlanHash: restored.planHash };
const runOrder: readonly ['baseline', 'candidate'] | readonly ['candidate', 'baseline'] = trial.runOrder;
const row: ProjectEvaluationRepeatedMeasurement = { id: trial.id, caseId: trial.caseId, repeatIndex: trial.repeatIndex, partition: 'selection', weight: 1, baselineScore: .5, candidateScore: .6, baseline: { passed: true, usage: { totalTokens: 12 } }, candidate: { passed: true, usage: { totalTokens: 14 } } };
const repeated: ProjectEvaluationRepeatResult = summarizeProjectEvaluationRepeats({ ...binding, repeatPlan, rows: [row] });
const nullableScore: number | null = repeated.candidateScore;
const nullableGate: boolean | null | undefined = repeated.gates.minimumScore;
const limitations: readonly string[] = repeated.limitations;
const claim: 'descriptive_only' = repeated.statisticalClaim;
// @ts-expect-error A measurement cannot re-label itself as hidden confirmation.
const invalidRow: ProjectEvaluationRepeatedMeasurement = { ...row, partition: 'confirmation' };

const control: ProjectGenomeRequestControl = {
  beforeRequest(input) {
    const bound: ProjectEvaluationRepeatReceipt | undefined = input.evaluationRepeat;
    if (bound) { const id: string = bound.trialId; const index: number = bound.repeatIndex; void [id, index]; }
    input.signal?.throwIfAborted();
  },
  onUsage(input) {
    const bound: ProjectEvaluationRepeatReceipt | undefined = input.evaluationRepeat;
    const cost: number = input.usage.totalTokens;
    const started: boolean = input.requestStarted;
    const conversationTurn: number | undefined = input.evaluationTurn?.turn;
    void [bound, cost, started, conversationTurn];
  },
};
const confirmationControl: ProjectEvaluationConfirmationControl = { partitionPlan: binding.partitionPlan, repeatPlan };
const evaluation: ProjectGenomeEvaluation = await evaluateProjectGenomes({ ...options, ...confirmationControl, baseline, candidate, requestControl: control });
const selection = evaluation.selection;
if (selection && 'repeatPlanHash' in selection) {
  const result: ProjectEvaluationRepeatResult = selection;
  const complete: boolean = result.complete;
  const repeatVariance: number | null = result.pairedImprovement.sampleVariance;
  void [complete, repeatVariance];
} else if (selection) {
  const score: number = selection.candidateScore;
  // @ts-expect-error Legacy one-pass results do not claim repeated coverage.
  selection.complete;
  void score;
}
const automaticCompaction: false = PROJECT_EVALUATION_RUNTIME.sessionPolicy.autoCompaction;
const frozenExecutionProfile: string = evaluation.evaluationExecution.profile.hash;

const session = await createSession(sessionOptions);
const checkpoint = session.questionCheckpoint({ runtimeMessageId: 'runtime-message-id' });
if (checkpoint) {
  const phase: 'idle' | 'tool' = checkpoint.phase;
  const file: string = checkpoint.sessionFile;
  const call: string = checkpoint.callKey;
  const toolCall: string = checkpoint.toolCallId;
  const argumentHash: string = checkpoint.argumentsHash;
  const args: JsonObject = checkpoint.arguments;
  void [phase, file, call, toolCall, argumentHash, args];
}
// @ts-expect-error Reattachment needs a concrete runtime message identity.
session.questionCheckpoint({});
// @ts-expect-error A checkpoint is read-only evidence and cannot answer the user.
session.questionCheckpoint({ runtimeMessageId: 'id', answer: 'approve' });
await session.dispose();
void [count, method, planHash, missingBinding, receipt, runOrder, nullableScore, nullableGate, limitations, claim, invalidRow, automaticCompaction, frozenExecutionProfile];
