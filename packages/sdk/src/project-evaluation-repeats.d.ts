import type { ProjectGenomeSuite, ProjectEvaluationPartitionPlan } from './index.js';

export interface ProjectEvaluationRepeatBinding {
  suite: ProjectGenomeSuite; partitionPlan: ProjectEvaluationPartitionPlan;
  baselineHash: string; modelHash: string; evaluationRuntimeHash: string;
}
export interface ProjectEvaluationRepeatTrial {
  readonly id: string; readonly caseId: string; readonly repeatIndex: number;
  readonly runOrder: readonly ['baseline', 'candidate'] | readonly ['candidate', 'baseline'];
  readonly assignment: 'candidate-left' | 'baseline-left';
}
export interface ProjectEvaluationRepeatReceipt {
  trialId: string; caseId: string; repeatIndex: number; repeatPlanHash: string;
}
export interface ProjectEvaluationRepeatPlan {
  readonly schemaVersion: 1; readonly method: typeof PROJECT_EVALUATION_REPEAT_METHOD;
  readonly frozenAt: string; readonly partitionPlanHash: string; readonly suiteHash: string;
  readonly baselineHash: string; readonly modelHash: string; readonly evaluationRuntimeHash: string;
  readonly repeatCount: 2 | 3; readonly seed: string; readonly trials: readonly ProjectEvaluationRepeatTrial[]; readonly planHash: string;
}
export interface ProjectEvaluationRepeatedMeasurement {
  id: string; caseId: string; repeatIndex: number; partition: 'selection'; weight: number;
  baselineScore: number; candidateScore: number;
  baseline: { passed: boolean; usage: { totalTokens: number } };
  candidate: { passed: boolean; usage: { totalTokens: number } };
}
export interface ProjectEvaluationRepeatStatistics {
  readonly count: number; readonly mean: number | null; readonly sampleVariance: number | null;
  readonly sampleStdDev: number | null; readonly min: number | null; readonly max: number | null;
}
export interface ProjectEvaluationRepeatResult {
  readonly cases: number; readonly baselineScore: number | null; readonly candidateScore: number | null; readonly improvement: number | null;
  readonly gates: Readonly<Record<string, boolean | null>>; readonly gatePassed: boolean; readonly complete: boolean;
  readonly cost?: { readonly baselineTokens: number; readonly candidateTokens: number };
  readonly repeatPlanHash: string; readonly expectedTrials: number; readonly observedTrials: number;
  readonly repeats: ReadonlyArray<{ readonly repeatIndex: number; readonly complete: boolean; readonly observedTrials: number; readonly expectedTrials: number; readonly baselineScore: number | null; readonly candidateScore: number | null; readonly improvement: number | null; readonly gatePassed: boolean; readonly gates?: Readonly<Record<string, boolean>>; readonly cost?: { readonly baselineTokens: number; readonly candidateTokens: number } }>;
  readonly perCase: ReadonlyArray<{ readonly caseId: string; readonly expectedTrials: number; readonly baseline: ProjectEvaluationRepeatStatistics; readonly candidate: ProjectEvaluationRepeatStatistics; readonly pairedImprovement: ProjectEvaluationRepeatStatistics }>;
  readonly pairedImprovement: ProjectEvaluationRepeatStatistics; readonly worstRegression: number | null;
  readonly statisticalClaim: 'descriptive_only'; readonly nullNoiseCalibration: 'not_measured'; readonly limitations: readonly string[];
}
export const PROJECT_EVALUATION_REPEAT_METHOD: Readonly<{ id: 'project-selection-repeats-v1'; version: 1; repeatCounts: readonly [2, 3]; allocation: 'fixed_before_authoring'; execution: 'fresh_sessions_alternating_order'; missing: 'incomplete_not_scored'; selection: 'all_repeats_original_gates'; confirmation: 'original_one_candidate_once'; statisticalClaim: 'descriptive_only'; hash: string }>;
export function createProjectEvaluationRepeatPlan(options: ProjectEvaluationRepeatBinding & { repeatCount?: 2 | 3; seed: string; frozenAt?: string }): ProjectEvaluationRepeatPlan;
export function validateProjectEvaluationRepeatPlan(plan: unknown, binding: ProjectEvaluationRepeatBinding): ProjectEvaluationRepeatPlan;
export function summarizeProjectEvaluationRepeats(options: ProjectEvaluationRepeatBinding & { repeatPlan: ProjectEvaluationRepeatPlan; rows?: readonly ProjectEvaluationRepeatedMeasurement[] }): ProjectEvaluationRepeatResult;
