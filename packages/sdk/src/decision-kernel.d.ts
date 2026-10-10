export declare const JEV_ENDPOINT: 'https://api.typesafe.ai/v1/systemone';
export declare const JEV_MODEL: 'jev-latest';
export declare const DECISION_KERNEL_VERSION: 2;
export type DecisionMode = 'off' | 'shadow' | 'active';
export type DecisionPoint = 'initiative.review' | 'evolution.review' | 'chat.preflight' | 'chat.route' | 'turn.route' | 'delivery.reach' | 'skill.screen' | 'candidate.prescore' | 'tool.risk' | 'message.check' | 'message.value' | 'memory.filter' | 'mind.judge' | 'initiative.direct';
export declare const BACKOFF_BASE_MS: 100;
export declare const BACKOFF_ATTEMPTS: 3;
export type DecisionBackend = 'typesafe' | 'llm';
export declare const DECISION_BACKENDS: readonly DecisionBackend[];
export declare const CHAT_ROUTE_TEMPLATE_VERSION: 1;
export declare const CHAT_ROUTE_BUDGET_MS: 900;
export declare const MAX_ROUTE_SKILLS: 4;
export declare const SKILL_SCREEN_TEMPLATE_VERSION: 1;
export declare const CANDIDATE_PRESCORE_TEMPLATE_VERSION: 1;
export declare const MAX_SCREEN_CANDIDATES: 8;
export interface DecisionSignals {
  taskType?: 'research' | 'coding' | 'creative' | 'analysis' | 'recurring' | 'chat';
  novelty?: number; evidenceStrength?: number; maturity?: number; load?: number; consequence?: number;
  recurring?: boolean; completed?: boolean; hasPendingWork?: boolean; explicitRequest?: boolean; duplicateEvidence?: boolean;
  dueSchedule?: boolean; unansweredQuestion?: boolean; deliveryJustCompleted?: boolean; severeFailure?: boolean;
}
export interface DecisionPolicy {
  version: 1; yes: number; no: number; confidence: number; margin: number;
  timeoutMs: number; ttlMs: number; maxStateChars: number; taskType: string;
  rationale: Record<string, number | boolean>;
}
export interface DecisionState {
  userMessage?: string; currentAction?: string;
  task?: { title?: string; goal?: string; phase?: string; summary?: string; completed?: boolean; recurring?: boolean };
  recentSummaries?: string[];
  evidence?: { id?: string; type?: string; summary?: string; novelty?: number; verified?: boolean }[];
  pending?: { work?: boolean | number; delivery?: boolean | number; questions?: boolean | number; learning?: boolean | number };
  candidate?: { summary?: string; changedAreas?: ('prompt' | 'skills' | 'tools' | 'evaluation' | 'policy' | 'memory' | 'workflow')[]; failureCount?: number };
  rhythm?: { lifecycle?: string; initiativeMode?: string; evolutionMode?: string; nextRunAt?: string | number };
}
export type DecisionNecessityKey = 'initiative_need' | 'initiative_pause' | 'schedule_need' | 'evolution_need' | 'memory_need';
export type DecisionAssessmentKey = 'task_state' | 'user_satisfaction' | DecisionNecessityKey;
export interface DecisionBooleanQuestion { type: 'boolean'; instructions: string; criteria: { true: string; false: string } }
export interface DecisionChoiceQuestion { type: 'choice'; instructions: string; criteria: Record<string, string> & { unknown: string } }
export interface DecisionSatisfactionQuestion { type: 'score'; instructions: string; criteria: [string, string] }
export type DecisionQuestion = DecisionBooleanQuestion | DecisionChoiceQuestion | DecisionSatisfactionQuestion;
/** All question prose and anchors must come from a main-model generation.
 * This schema proves structure, not provenance. The host binds an actual model
 * receipt separately; callers cannot self-attest a source/revision in the plan.
 */
export interface DecisionAssessmentPlan {
  version: 1;
  questions: Partial<Record<DecisionNecessityKey, DecisionBooleanQuestion>> & {
    task_state?: DecisionChoiceQuestion;
    /** Fixed orientation: 0 = dissatisfied; 1 = satisfied. Advisory only. */
    user_satisfaction?: DecisionSatisfactionQuestion;
  };
}
export interface DecisionScoreQuestion { type: 'score'; instructions: string; criteria: string[] }
/** Host-code template (versioned, hashed; no main-model receipt). Accepted by chat.route, skill.screen and candidate.prescore.
 * chat.route: reasoning_effort (choice incl. unknown), memory_need (boolean), up to 4 skill_<id> booleans.
 * skill.screen: up to 8 fit_<n> booleans plus an optional overall_fit score (2–5 anchors).
 * candidate.prescore: candidate_better (boolean) plus an optional expected_gain score. */
export interface DecisionHostTemplatePlan {
  version: 1; source: 'host-template'; template: 'chat.route' | 'skill.screen' | 'candidate.prescore'; templateVersion: number;
  questions: { reasoning_effort?: DecisionChoiceQuestion; memory_need?: DecisionBooleanQuestion; overall_fit?: DecisionScoreQuestion; candidate_better?: DecisionBooleanQuestion; expected_gain?: DecisionScoreQuestion; [key: string]: DecisionBooleanQuestion | DecisionChoiceQuestion | DecisionScoreQuestion | undefined };
}
export declare function validateHostTemplatePlan(value: unknown): DecisionHostTemplatePlan;
export declare function hostTemplateHash(value: unknown): string;
export declare function routeSkillKey(id: string): `skill_${string}`;
export declare function screenCandidateKey(index: number): `fit_${number}`;
export declare function skillScreenTemplate(options?: { taskTypes?: string[]; candidates?: Array<{ id?: string; name?: string }> }): DecisionHostTemplatePlan;
export declare function candidatePrescoreTemplate(): DecisionHostTemplatePlan;
export declare function chatRouteTemplate(options?: { efforts?: Array<string | { id: string; label?: string }>; memory?: boolean; skills?: Array<{ id: string; name?: string; description?: string }> }): DecisionHostTemplatePlan;
export declare const DECISION_ASSESSMENT_PLAN_SCHEMA: import('./index.js').JsonSchema;
/** Rejects all unknown fields, empty/overlong text, invalid axes and unbounded option sets. Returns a detached copy. */
export declare function validateDecisionAssessmentPlan(value: unknown): DecisionAssessmentPlan;
/** SHA-256 of canonical validated content. Never accepts caller-supplied revision/provenance. */
export declare function decisionAssessmentPlanHash(value: unknown): string;
export type DecisionAnswer = ({ type: 'boolean'; probability: number } | { type: 'choice'; choice: string; probabilities?: Record<string, number> } | { type: 'score'; score: number; probabilities?: Record<string, number> }) & { confidence?: number };
export type DecisionAnswers = Partial<Record<DecisionAssessmentKey | 'reasoning_effort' | `skill_${string}`, DecisionAnswer>>;
export interface DecisionAssessmentOutcome { planRevision: string; assessments: DecisionAnswers }
export interface DecisionResult<Fallback = { review: boolean } | { needsMemory: boolean }> {
  point: DecisionPoint; backend: DecisionBackend; mode: DecisionMode; source: 'judge' | 'fallback'; outcome: DecisionAssessmentOutcome | Fallback;
  judged?: DecisionAssessmentOutcome; reason: string; planRevision?: string;
  policy: DecisionPolicy; ledgerId: string; answers?: DecisionAnswers;
  usage: { inputTokens?: number; outputTokens?: number }; latencyMs: number;
  /** True only for the caller that started fetch, including provider failures/cancellation. Cached/coalesced callers are false. */
  networkAttempted: boolean; cached: boolean; coalesced: boolean;
}
export interface DecisionLedgerRecord {
  version: 2; id: string; at: number; point: DecisionPoint; backend: DecisionBackend; mode: DecisionMode; source: 'judge' | 'fallback'; reason: string;
  planRevision?: string; scopeDigest: string; stateDigest: string | null; policy: DecisionPolicy; latencyMs: number;
  usage: { inputTokens?: number; outputTokens?: number }; networkAttempted: boolean; cached: boolean; coalesced: boolean; answers?: DecisionAnswers;
}
export interface DecisionInput<Fallback = { review: boolean } | { needsMemory: boolean }> {
  point: DecisionPoint;
  /** Project identity + evidence / turn / schedule revision isolate reuse. Without projectId caching is disabled. */
  scope?: { projectId?: string; sessionId?: string; revision?: string | number; [key: string]: unknown };
  state?: DecisionState; signals?: DecisionSignals; fallback?: Fallback; signal?: AbortSignal;
  /** No valid applicable main-model plan means no request and unchanged fallback. */
  assessmentPlan?: DecisionAssessmentPlan | DecisionHostTemplatePlan;
  /** Host-template atomic questions sent with a main-model plan (initiative.review only). */
  supplement?: DecisionHostTemplatePlan;
}
export interface DecisionKernel {
  decide<Fallback = { review: boolean } | { needsMemory: boolean }>(input: DecisionInput<Fallback>): Promise<DecisionResult<Fallback>>;
  stats(): { requests: number; cacheHits: number; coalesced: number; fallbacks: number; failures: number; inputTokens: number; outputTokens: number; circuitOpen: boolean; circuitOpenUntil: number; cacheEntries: number; inflight: number };
  clear(): void;
  close(): void;
}
export declare function deriveDecisionPolicy(point: string, signals?: DecisionSignals): Readonly<DecisionPolicy>;
export declare function minimizeDecisionState(input?: DecisionState, options?: { maxChars?: number; knownSecrets?: string[] }): DecisionState;
export declare function decisionVerdict(answer: DecisionAnswer, policy: DecisionPolicy): boolean | number | string | undefined;
export declare function createDecisionKernel(options?: {
  apiKey?: string | (() => string | undefined | Promise<string | undefined>); endpoint?: string; model?: string;
  mode?: DecisionMode; modes?: Record<string, DecisionMode>; fetch?: typeof fetch;
  /** Nonblocking, content-free telemetry. Storage failures never change the agent path. */
  ledger?: (record: DecisionLedgerRecord) => void | Promise<void>; knownSecrets?: () => string[]; now?: () => number;
  timeoutMs?: number; maxCacheEntries?: number; failureThreshold?: number; circuitCooldownMs?: number;
  /** 'llm' requires `judge`; a judge replaces only the transport (same parser, thresholds, cache, breaker, ledger). */
  backend?: DecisionBackend; judge?: DecisionJudge; requireCredential?: boolean;
}): DecisionKernel;
/** Returns the JEV wire answer body: { answers: { id: { noul | choice+probabilities | score, confidence? } }, usage?: { input_tokens, output_tokens } }. */
export type DecisionJudge = (input: { state: DecisionState; questions: Record<string, DecisionQuestion>; signal: AbortSignal }) => Promise<unknown>;
export declare const LLM_JUDGE_PURPOSE: 'jev-llm';
export declare const LLM_JUDGE_MAX_OUTPUT_TOKENS: 512;
export declare function llmJudgeReasoning(capability?: import('./index.js').ReasoningCapability): import('./index.js').Reasoning;
export declare function createLlmDecisionJudge(options: { model: import('./index.js').ModelConfig & { reasoningCapability?: import('./index.js').ReasoningCapability }; apiKey?: import('./subscription-auth.js').ProviderCredential; provider?: import('./index.js').CompletionProvider; maxOutputTokens?: number; fetch?: typeof fetch }): DecisionJudge;
