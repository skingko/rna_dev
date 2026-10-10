import type { ProjectGenome } from './index.js';

export declare const PROJECT_EVALUATION_EXPOSURE_METHOD: 'host-intervention-exposure-v1';
export type ProjectEvaluationExposureSide = 'baseline' | 'candidate';
export type ProjectEvaluationExposureStatus = 'observed' | 'unobserved' | 'unknown' | 'not_applicable';
export type ProjectEvaluationExposureMode = 'request_context' | 'skill_content' | 'tool_execution' | 'host_metadata' | 'host_validation' | 'future_evaluation_standard';
export type ProjectEvaluationExposureKind = 'system_prompt' | 'skill_catalog_order' | 'skill_catalog' | 'skill_instructions' | 'skill_resource' | 'skill_source' | 'tool_catalog_order' | 'tool_declaration' | 'tool_script' | 'tool_permission' | 'tool_label' | 'tool_smoke_cases' | 'evaluation_suite';
export interface ProjectEvaluationExposureSpan { readonly start: number; readonly end: number; readonly scope: 'entire_added_or_removed_content' | 'entire_remaining_content_after_deletion' | 'changed_region_envelope' }
export interface ProjectEvaluationExposureBinding { readonly present: boolean; readonly hash: string | null; readonly span?: ProjectEvaluationExposureSpan }
export interface ProjectEvaluationExposureChange {
  readonly id: string; readonly kind: ProjectEvaluationExposureKind; readonly target: string; readonly mode: ProjectEvaluationExposureMode;
  readonly change: 'added' | 'modified' | 'removed'; readonly baseline: ProjectEvaluationExposureBinding; readonly candidate: ProjectEvaluationExposureBinding;
  readonly skillId?: string; readonly path?: string; readonly toolId?: string;
}
export interface ProjectEvaluationExposurePlan {
  readonly schemaVersion: 1; readonly method: typeof PROJECT_EVALUATION_EXPOSURE_METHOD; readonly baselineHash: string; readonly candidateHash: string;
  readonly changes: ReadonlyArray<ProjectEvaluationExposureChange>; readonly planHash: string;
}
export interface ProjectEvaluationExposureToolCall { id: string; name: string; arguments: Record<string, unknown> }
export interface ProjectEvaluationExposureToolReceipt {
  toolCallId: string; toolName: string; isError?: boolean; uncertain?: boolean; output?: string; content?: ReadonlyArray<{ type: string; text?: string }>;
  validationReceipt?: { source: string; neverExecuted?: boolean; code?: string; argumentPath?: string };
}
export interface ProjectEvaluationExposureExecution {
  calls?: ReadonlyArray<ProjectEvaluationExposureToolCall>; toolResults?: ReadonlyArray<ProjectEvaluationExposureToolReceipt>;
  /** Host-captured results from actual subsequent provider requests. Missing
   * delivery evidence cannot establish whether skill bytes reached the model. */
  submittedToolResults?: ReadonlyArray<ProjectEvaluationExposureToolReceipt>;
}
export interface ProjectEvaluationExposureObservation {
  readonly id: string; readonly kind: ProjectEvaluationExposureKind; readonly target: string; readonly mode: ProjectEvaluationExposureMode;
  readonly change: 'added' | 'modified' | 'removed'; readonly planned: true; readonly present: boolean; readonly contentHash: string | null;
  readonly status: ProjectEvaluationExposureStatus; readonly reason: string; readonly callIds?: ReadonlyArray<string>;
  readonly attemptedCalls?: number; readonly validationRejectedCalls?: number; readonly inventoryObserved?: boolean;
  readonly coverage?: { readonly unit: 'utf16_code_units'; readonly target: ProjectEvaluationExposureSpan; readonly ranges: ReadonlyArray<{ readonly start: number; readonly end: number }>; readonly deliveredUnits: number; readonly totalUnits: number; readonly completeBody: boolean };
}
export type ProjectEvaluationExposureCounts = Readonly<Record<ProjectEvaluationExposureStatus, number>>;
export interface ProjectEvaluationExposure {
  readonly schemaVersion: 1; readonly method: typeof PROJECT_EVALUATION_EXPOSURE_METHOD; readonly planHash: string; readonly genomeHash: string;
  readonly side: ProjectEvaluationExposureSide; readonly contextExposed: boolean; readonly receiptsComplete: boolean; readonly planned: number;
  readonly counts: ProjectEvaluationExposureCounts; readonly changes: ReadonlyArray<ProjectEvaluationExposureObservation>; readonly limits: ReadonlyArray<string>;
}
export interface ProjectEvaluationExposureCase { id: string; baseline?: { exposure?: ProjectEvaluationExposure }; candidate?: { exposure?: ProjectEvaluationExposure } }
export interface ProjectEvaluationExposureSummaryChange {
  readonly id: string; readonly kind: ProjectEvaluationExposureKind; readonly target: string; readonly mode: ProjectEvaluationExposureMode;
  readonly change: 'added' | 'modified' | 'removed'; readonly status: ProjectEvaluationExposureStatus;
  readonly observations: ReadonlyArray<{ readonly caseId: string; readonly status: ProjectEvaluationExposureStatus; readonly reason: string }>;
}
export interface ProjectEvaluationExposureSummarySide { readonly counts: ProjectEvaluationExposureCounts; readonly changes: ReadonlyArray<ProjectEvaluationExposureSummaryChange> }
export interface ProjectEvaluationExposureSummary {
  readonly schemaVersion: 1; readonly method: typeof PROJECT_EVALUATION_EXPOSURE_METHOD; readonly plan: ProjectEvaluationExposurePlan;
  readonly expectedCases: number; readonly observedCases: number; readonly baseline: ProjectEvaluationExposureSummarySide; readonly candidate: ProjectEvaluationExposureSummarySide;
  readonly causalClaim: 'none'; readonly qualityGateChanged: false;
}
export declare function createProjectEvaluationExposurePlan(input: { baseline: ProjectGenome; candidate: ProjectGenome }): ProjectEvaluationExposurePlan;
export declare function observeProjectEvaluationExposure(input: {
  plan: ProjectEvaluationExposurePlan; genome: ProjectGenome; side: ProjectEvaluationExposureSide; execution?: ProjectEvaluationExposureExecution;
  /** True only when the host submitted the ordinary runCase model context. */
  contextExposed?: boolean;
  /** True only for a complete host inventory, not an old/truncated failure log. */
  receiptsComplete?: boolean;
}): ProjectEvaluationExposure;
export declare function summarizeProjectEvaluationExposure(input: { plan: ProjectEvaluationExposurePlan; cases?: ReadonlyArray<ProjectEvaluationExposureCase>; expectedCaseIds?: ReadonlyArray<string> }): ProjectEvaluationExposureSummary;
