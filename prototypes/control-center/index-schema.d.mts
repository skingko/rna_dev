// Types of index-schema.mjs for the web (web/src/api/types.ts imports the field names from here). Keep each list
// identical to the module's: web/src/api/index-contract.spec.ts compares them at runtime.

export declare const INDEX_PROTOCOL: 3;

export declare const SESSION_SUMMARY_FIELDS: readonly [
  'id', 'title', 'projectId', 'kind', 'parentSessionId', 'status', 'pauseReason', 'mode', 'model', 'modelSelection', 'modelConfig',
  'context', 'usage', 'activeTurnId', 'plan', 'createdAt', 'updatedAt', 'archivedAt', 'simulated', 'sideChat', 'invitations',
  'worktree', 'appRecovery', 'runtime',
  'itemCount', 'lastItemAt', 'preview', 'inboxCount', 'waiting', 'lastInitiativeAt', 'agents', 'memoryEvidence',
];
export declare const PROJECT_SUMMARY_FIELDS: readonly [
  'id', 'name', 'description', 'workspacePath', 'createdAt', 'updatedAt', 'archivedAt', 'primarySessionId', 'permissions',
  'decisionMode', 'simulated', 'focus', 'taskTypes', 'initiative', 'evolution', 'rhythm', 'memory', 'activeVersionId', 'trialVersionId',
  'activeVersion', 'counts', 'genesForming', 'initialization', 'skillFoundation', 'memorySummary', 'rhythmStatus', 'initiativeRuntime',
  'schedules', 'scheduleRuntime', 'plan', 'work', 'backgroundChanges', 'git',
];
export declare const ARCHIVED_PROJECT_SUMMARY_FIELDS: readonly [
  'id', 'name', 'description', 'workspacePath', 'createdAt', 'updatedAt', 'archivedAt', 'primarySessionId', 'permissions',
  'decisionMode', 'simulated', 'counts',
];
export declare const MEMORY_SUMMARY_FIELDS: readonly ['status', 'message', 'code', 'updatedAt'];
export declare const INITIALIZATION_FIELDS: readonly ['status', 'phase', 'attempt', 'maxAttempts', 'message', 'diagnostic', 'requestedAt', 'startedAt', 'completedAt'];
export declare const SKILL_FOUNDATION_FIELDS: readonly ['status', 'attemptedAt', 'completedAt'];
export declare const INITIATIVE_RUNTIME_FIELDS: readonly ['status', 'availability'];
export declare const SCHEDULE_FIELDS: readonly ['id', 'title', 'enabled', 'rule', 'destinationSessionId', 'nextRunAt', 'pausedReason', 'source', 'userEditedAt'];
export declare const OCCURRENCE_FIELDS: readonly ['key', 'scheduleId', 'scheduledAt', 'status', 'deliveredAt', 'deliveryItemId', 'errorCode', 'actionId', 'deliveryActionId', 'sourceDeleted', 'contextRevoked'];
export declare const RHYTHM_LANE_FIELDS: readonly ['eligible', 'reason', 'nextAt', 'state', 'quota'];
export declare const RHYTHM_SCHEDULE_FIELDS: readonly ['activeCount', 'nextAt'];
export declare const RHYTHM_HISTORY_FIELDS: readonly ['at', 'lifecycle', 'reason', 'initiativeMode', 'evolutionMode'];
export declare const RHYTHM_HISTORY_ROWS: 5;
export declare const RHYTHM_REASON_CHARS: 800;

export type SessionSummaryField = (typeof SESSION_SUMMARY_FIELDS)[number];
export type ProjectSummaryField = (typeof PROJECT_SUMMARY_FIELDS)[number];
export type ArchivedProjectSummaryField = (typeof ARCHIVED_PROJECT_SUMMARY_FIELDS)[number];
export type MemorySummaryField = (typeof MEMORY_SUMMARY_FIELDS)[number];
export type InitializationField = (typeof INITIALIZATION_FIELDS)[number];
export type SkillFoundationField = (typeof SKILL_FOUNDATION_FIELDS)[number];
export type InitiativeRuntimeField = (typeof INITIATIVE_RUNTIME_FIELDS)[number];
export type ScheduleField = (typeof SCHEDULE_FIELDS)[number];
export type OccurrenceField = (typeof OCCURRENCE_FIELDS)[number];

export declare function pick<T extends object, K extends string>(source: T | null | undefined, fields: readonly K[]): Partial<Record<K, unknown>> | null;
export declare function rhythmStatusRow(status: unknown): Record<string, unknown> | null;
export declare function scheduleRuntimeRow(runtime: unknown, options?: { runKeys?: readonly (string | null | undefined)[]; runActions?: readonly (string | null | undefined)[] }): { occurrences: Record<string, unknown>[] } | null;
