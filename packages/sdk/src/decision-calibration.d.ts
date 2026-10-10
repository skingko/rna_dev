import type { DecisionAssessmentPlan, DecisionInput, DecisionMode, DecisionPoint, DecisionPolicy, DecisionResult, DecisionSignals, DecisionState } from './decision-kernel.js';
import type { JsonValue } from './index.js';

export declare const DECISION_CALIBRATION_VERSION: 1;
export interface DecisionCalibrationModel { provider: string; id: string; revision: string; parameters?: JsonValue }
export interface DecisionCalibrationIdentity {
  version: 1; caseId: string; point: DecisionPoint; kernelVersion: number;
  inputHash: string; planHash: string; planReceiptHash: string; modelsHash: string; mainInputHash: string; policyHash: string;
  thresholdVersion: string; runtimeVersion: string; fallbackRoute: string;
  cacheImpact: 'none' | 'append-only' | 'prefix-mutating'; latencyClass: 'inline' | 'parallel' | 'background';
  cacheRegime: 'isolated-cold' | 'isolated-warm'; hash: string;
}
export interface DecisionCalibrationFixture {
  readonly identity: Readonly<DecisionCalibrationIdentity>;
  readonly input: Readonly<DecisionInput<JsonValue>> & { readonly assessmentPlan: DecisionAssessmentPlan };
  readonly policy: Readonly<DecisionPolicy>;
}
/** Deep-freezes normalized input and measured identity. Hashes attest identity,
 * not authenticity of caller-supplied provenance. No model/network calls. */
export declare function freezeDecisionCalibrationCase(options: {
  id: string; point: DecisionPoint; state?: DecisionState; signals?: DecisionSignals;
  scope?: DecisionInput['scope']; fallback?: JsonValue; assessmentPlan: DecisionAssessmentPlan;
  planProvenance: { source: 'main_model'; receiptHash: string };
  models: { main: DecisionCalibrationModel; jev: DecisionCalibrationModel };
  mainInputHash: string; thresholdVersion: string; runtimeVersion: string; fallbackRoute: string;
  cacheImpact?: DecisionCalibrationIdentity['cacheImpact']; latencyClass?: DecisionCalibrationIdentity['latencyClass'];
  cacheRegime?: DecisionCalibrationIdentity['cacheRegime']; knownSecrets?: string[];
}): DecisionCalibrationFixture;
/** inputTokens includes cached input; absent cache counts stay unknown. */
export interface DecisionCalibrationUsage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
export interface DecisionCalibrationTicket { readonly id: string; readonly caseId: string; readonly mode: DecisionMode; readonly repeat: number; readonly component: 'main' | 'jev'; readonly reservedTokens: number }
export interface DecisionCalibrationRequestReceipt extends DecisionCalibrationTicket {
  status: 'pending' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  usage: null | { inputTokens: number; outputTokens: number; cacheReadTokens: number | null; cacheWriteTokens: number | null; totalTokens: number };
  chargedTokens: number; networkAttempted: boolean | null; latencyMs: number | null; receiptHash?: string;
}
export interface DecisionCalibrationObservation {
  source: 'host_verifier' | 'human_review'; receiptHash: string; windowClosed: boolean;
  notification: { required: boolean | null; delivered: boolean | null; useful: boolean | null };
  completion: { required: boolean | null; completed: boolean | null };
}
export interface DecisionCalibrationDistribution { samples: number; p50: number | null; p95: number | null }
export interface DecisionCalibrationRatio { numerator: number; denominator: number; rate: number | null }
export interface DecisionCalibrationUsageSummary {
  admittedRequests: number; networkRequests: number; unknownUsageRequests: number; usageComplete: boolean;
  inputTokens: number; outputTokens: number; totalTokens: number; chargedBudgetTokens: number;
  cacheReadTokens: number | null; cacheHitPercent: number | null; cacheWriteTokens: number | null;
  latencyMs: DecisionCalibrationDistribution;
}
export interface DecisionCalibrationRun {
  caseId: string; mode: DecisionMode; repeat: number; identityHash: string; routeId: string; elapsedMs: number;
  decision: { source: 'judge' | 'fallback'; reason: string; latencyMs: number; cached: boolean; coalesced: boolean; networkAttempted: boolean; fallback: boolean; judgedHash: string | null };
  observation: DecisionCalibrationObservation;
  usage: { main: DecisionCalibrationUsageSummary; jev: DecisionCalibrationUsageSummary };
}
export interface DecisionCalibrationModeSummary {
  runs: number; closedObservationWindows: number; falseSilence: DecisionCalibrationRatio; usefulNotifications: DecisionCalibrationRatio; completion: DecisionCalibrationRatio;
  unknownNotificationOutcomes: number; unknownCompletionOutcomes: number;
  elapsedMs: DecisionCalibrationDistribution; decisionLatencyMs: DecisionCalibrationDistribution;
  fallbackRuns: number; cachedDecisions: number; coalescedDecisions: number;
  usage: { main: DecisionCalibrationUsageSummary; jev: DecisionCalibrationUsageSummary };
}
export interface DecisionCalibrationSnapshot {
  version: 1; fixtures: Readonly<DecisionCalibrationIdentity>[];
  budget: { tokenBudget: number; chargedTokens: number; remainingTokens: number; overrun: boolean; pendingRequests: number };
  modes: Record<DecisionMode, DecisionCalibrationModeSummary>;
  comparisons: { caseId: string; repeat: number; identityHash: string; observedModes: DecisionMode[];
    observedTokenDelta: number | null; observedLatencyDeltaMs: number | null; qualityComparable: boolean;
    claim: 'observed_matched_runs_not_causal_savings' | 'counterfactual_or_usage_unobserved' }[];
  runs: DecisionCalibrationRun[]; requests: DecisionCalibrationRequestReceipt[];
  statisticalClaim: 'none'; counterfactualSavingsClaim: 'none'; provenanceClaim: 'host_receipt_attestation_not_independent_authentication';
}
export interface DecisionCalibration {
  /** Must run before every actual request. Unknown use retains reservation. */
  admitRequest(options: { caseId: string; mode: DecisionMode; repeat?: number; component: 'main' | 'jev'; reservedTokens: number }): DecisionCalibrationTicket;
  settleRequest(requestId: string, receipt: {
    status: Exclude<DecisionCalibrationRequestReceipt['status'], 'pending'>; usage?: DecisionCalibrationUsage | null;
    networkAttempted: boolean; latencyMs: number; receiptHash: string;
  }): Readonly<DecisionCalibrationRequestReceipt>;
  recordRun(options: { caseId: string; mode: DecisionMode; repeat?: number; identityHash: string; decision: DecisionResult<unknown>;
    routeId: string; elapsedMs: number; observation: DecisionCalibrationObservation;
  }): Readonly<DecisionCalibrationRun>;
  snapshot(): Readonly<DecisionCalibrationSnapshot>;
}
export declare function createDecisionCalibration(options: { cases: readonly DecisionCalibrationFixture[]; tokenBudget: number }): DecisionCalibration;
