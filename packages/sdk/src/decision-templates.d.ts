import type { DecisionHostTemplatePlan } from './decision-kernel.js';
export type DecisionStake = 'floor' | 'low' | 'medium' | 'high' | number;
export declare const DECISION_THRESHOLDS: Readonly<{ version: 1; floor: number; low: number; medium: number; high: number; llmOffset: number; skillGate: number; skillFits: number; points: Readonly<Record<string, Readonly<Record<string, unknown>>>> }>;
export function stakeThreshold(stake: DecisionStake, backend?: 'typesafe' | 'llm'): number;
export function noulConfidence(probability: number): number;
export function answerConfidence(answer: unknown): number;
export function stakeVerdict(answer: unknown, stake: DecisionStake, backend?: 'typesafe' | 'llm'): boolean | string | number | undefined;
export declare const TURN_ROUTE_TEMPLATE_VERSION: 1; export declare const TURN_ROUTE_BUDGET_MS: 900; export declare const MAX_ROUTE_CATALOG: 254;
export declare const SKILL_SCREEN_TEMPLATE_V2: 2; export declare const DELIVERY_REACH_TEMPLATE_V2: 2; export declare const CANDIDATE_PRESCORE_TEMPLATE_V2: 2;
export declare const MESSAGE_CHECK_TEMPLATE_VERSION: 1; export declare const INITIATIVE_GATE_TEMPLATE_VERSION: 1; export declare const TOOL_RISK_TEMPLATE_VERSION: 1; export declare const MEMORY_FILTER_TEMPLATE_VERSION: 1; export declare const MAX_MEMORY_PASSAGES: 16;
export declare const SKILL_GATES: Readonly<Record<string, string>>; export declare const INITIATIVE_ACTIONS: readonly string[]; export declare const MESSAGE_CHECK_CODES: Readonly<Record<string, string>>;
export declare const TEMPLATE_SPECS: Readonly<Record<string, unknown>>;
export function skillOptionKeys(skills?: { id?: string; name?: string }[]): string[];
export function screenOptionKey(index: number): string; export function fitsKey(index: number): string; export function relevantKey(index: number): string;
export function turnRouteTemplate(options?: { efforts?: (string | { id: string; label?: string })[]; memory?: boolean; tools?: boolean; skills?: { id: string; name?: string; description?: string }[]; background?: boolean; fastModel?: unknown; capture?: unknown; rulebook?: { lessons?: number; methods?: number } | null }): DecisionHostTemplatePlan;
export function skillScreenWideTemplate(options?: { candidates?: { name?: string; description?: string }[] }): DecisionHostTemplatePlan | null;
export function skillScreenVerifyTemplate(options?: { shortlist?: { name?: string; description?: string; body?: string }[] }): DecisionHostTemplatePlan | null;
export function deliveryReachAtomicTemplate(): DecisionHostTemplatePlan;
export function messageCheckTemplate(): DecisionHostTemplatePlan;
export function candidatePrescoreAtomicTemplate(): DecisionHostTemplatePlan;
export function initiativeGateTemplate(): DecisionHostTemplatePlan;
export function toolRiskTemplate(): DecisionHostTemplatePlan;
export declare const WORK_COVERAGE_TEMPLATE_VERSION: number;
export declare const WORK_COVERAGE_RECEIPTS: 5;
export declare const WORK_COVERAGE_CHANGES: 8;
export function coverKey(index: number): string;
export function touchKey(index: number): string;
/** work.coverage: checks_only plus one covers_<i> per receipt and one touches_<j> per change. */
export function workCoverageTemplate(options?: { receipts?: number; changes?: number }): DecisionHostTemplatePlan;
/** covered only with a confident checks_only, a confident covering receipt and every later change confidently not touching it; `standing` receipts (running/queued work) are never outdated. */
/** A work.coverage receipt as combineWorkCoverage reads it: `at` when it ended (or began, while standing), `from` when it began, `owner` the host's id for whoever ran it, `checkedAt` when its last check ran (its own file changes after it outdate it), else `ownLater` whether it changed files after its last check, `snapshot` whether it worked on a copy taken when it began. */
export interface WorkCoverageReceipt { at?: number; from?: number; standing?: boolean; owner?: string; checkedAt?: number; ownLater?: boolean; snapshot?: boolean }
/** A work.coverage change: `owner` the host's id for whoever made it (absent when unknown), `files` whether it changed project files. */
export interface WorkCoverageChange { at?: number; owner?: string; files?: boolean }
export function coverageLater(receipt: WorkCoverageReceipt, change: WorkCoverageChange): boolean;
export function combineWorkCoverage(answers?: Record<string, unknown>, options?: { receipts?: WorkCoverageReceipt[]; changes?: WorkCoverageChange[]; backend?: string }): { covered: boolean; receipt?: number; reason?: 'not_checks_only' | 'not_covered' | 'changed_since' };
export function memoryFilterTemplate(options?: { count?: number }): DecisionHostTemplatePlan | null;
export function specTemplate(plan: unknown): boolean;
export function validateSpecTemplate(plan: unknown): DecisionHostTemplatePlan | null;
export function lintDecisionTemplate(plan: unknown, options?: { point?: string; dynamicCriteria?: string[] }): { id: string; problem: string }[];
export function combineTurnRoute(answers?: Record<string, unknown>, options?: Record<string, unknown>): Record<string, unknown>;
export function turnRouteHints(outcome?: Record<string, unknown>): { hints: string[]; note: string } | null;
export function combineReach(answers?: Record<string, unknown>, options?: { maxTier?: string; backend?: string }): { tier: string; lowered: boolean; engagement: number };
export function combineMessageCheck(answers?: Record<string, unknown>, options?: { backend?: string }): string[];
export function combinePrescore(answers?: Record<string, unknown>, options?: { backend?: string }): { probability: number; better?: boolean; expectedGain?: number };
export function combineInitiativeGate(answers?: Record<string, unknown>, options?: { backend?: string }): { wake?: boolean; likelyAction?: string; wakeProbability: number };
export function combineToolRisk(answers?: Record<string, unknown>, options?: { backend?: string; flags?: string[] }): { confirm: boolean; risk: number; reasons: string[] };
export function combineMemoryFilter(answers?: Record<string, unknown>, options?: { count?: number; backend?: string }): { keep: number[]; dropped: number };
export function combineScreenWide(answers?: Record<string, unknown>, options?: { count?: number; backend?: string }): { gate: number; open: boolean; shortlist: number[]; rejectRest: boolean };
export function combineScreenVerify(answers?: Record<string, unknown>, options?: { count?: number; backend?: string }): { fits: number[]; verdicts: (boolean | undefined)[]; rejectedAll: boolean };
export declare const EFFORT_TEMPLATE_VERSION: 1;
export type EffortPurpose = 'decision' | 'work' | 'narrator' | 'setup' | 'compaction';
export type EffortDepth = 'light' | 'standard' | 'deep';
/** effort.<purpose>: one choice question `depth` (light / standard / deep / unknown), situations ordered by reasoning needed. */
export function effortTemplate(purpose: EffortPurpose): DecisionHostTemplatePlan;
/** null when unanswered or unknown is most likely; light at its tier, standard when light+standard reach theirs, else deep. */
export function combineEffortDepth(answers?: Record<string, unknown>, options?: { backend?: 'typesafe' | 'llm'; point?: string }): EffortDepth | null;
