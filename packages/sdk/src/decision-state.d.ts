export declare const DECISION_STATE_VERSION: 1;
export interface DecisionTextFeatures { language: 'none' | 'chinese' | 'english' | 'mixed' | 'other'; length: string; hasCode: boolean; hasPath: boolean; hasUrl: boolean; isQuestion: boolean; intents: string[] }
export function textFeatures(text: unknown): DecisionTextFeatures;
export function lengthBucket(chars: number): 'empty' | 'very_short' | 'short' | 'medium' | 'long' | 'very_long';
export function recencyBucket(ms: number): 'never' | 'just_now' | 'recent' | 'earlier_today' | 'within_a_day' | 'this_week' | 'stale';
export function countBucket(count: number): 'none' | 'one' | 'few' | 'many';
export function commandFeatures(text: unknown, options?: { workspace?: string }): { flags: string[]; placement: 'mentions_outside_workspace' | 'inside_workspace_only' | 'relative_paths_only'; length: string };
export declare const DECISION_STATE_ROOTS: Readonly<Record<string, readonly string[]>>;
export declare const UNTRUSTED_STATE_PATHS: readonly string[];
export function buildDecisionState(point: string, input?: Record<string, unknown>, options?: { now?: number }): Record<string, unknown>;
/** work.coverage bounds (one question per receipt and per change). */
/** mind.judge revocation rows: at most this many sources per row, each at most this many characters (the caller chooses which). */
export declare const MIND_ROW_SOURCES: 8;
export declare const MIND_ROW_SOURCE_CHARS: 400;
export declare const WORK_COVERAGE_RECEIPTS: 5;
export declare const WORK_COVERAGE_CHANGES: 8;
export declare const WORK_COVERAGE_CHECKS: 6;
/** work.coverage string budget per receipt: each check line is clipped to WORK_COVERAGE_CHECK_LINE, the newest lines are kept while they fit WORK_COVERAGE_CHECK_CHARS. */
export declare const WORK_COVERAGE_CHECK_LINE: 200;
export declare const WORK_COVERAGE_CHECK_CHARS: 600;
/** Internal reasoning-effort points, one per purpose family (spec p1 effort §3.3). */
export declare const EFFORT_POINTS: readonly ['effort.decision', 'effort.work', 'effort.narrator', 'effort.setup', 'effort.compaction'];
/** Facts as the effort judge reads them: at most 16 keys, booleans as yes/no, short words and buckets, lists of at most 8 words; numbers dropped. */
export function effortFacts(facts: unknown): Record<string, string | string[]>;
