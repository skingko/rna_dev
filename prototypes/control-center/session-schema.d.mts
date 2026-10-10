// Types of session-schema.mjs for the web (web/src/api/session-contract.spec.ts compares the web's Session and Turn
// types with these lists). Keep each list identical to the module's: the contract spec compares them at runtime.

export declare const SESSION_FIELDS: readonly [
  'id', 'title', 'projectId', 'kind', 'parentSessionId', 'status', 'pauseReason', 'mode', 'model', 'modelSelection', 'modelConfig',
  'context', 'usage', 'activeTurnId', 'workspace', 'inbox', 'plan', 'createdAt', 'updatedAt', 'archivedAt', 'simulated', 'runtime',
  'appRecovery', 'sideChat', 'sideContext', 'invitations', 'worktree',
];
export declare const TURN_FIELDS: readonly [
  'id', 'status', 'source', 'mode', 'model', 'createdAt', 'startedAt', 'firstTokenAt', 'completedAt', 'userItemId', 'modelConfig',
  'timing', 'usage', 'activeMs', 'attemptStartedAt', 'pausedAt', 'retryHistory', 'autoRetry', 'errorCode', 'blockingActionId',
  'blockingDraining', 'apply', 'checkpoint', 'route',
];
export declare const TAIL_WINDOW: { readonly minMessages: 50; readonly minTurns: 2; readonly maxMessages: 500 };
export declare const PAGE_LIMIT: 200;

export type SessionField = (typeof SESSION_FIELDS)[number];
export type TurnField = (typeof TURN_FIELDS)[number];

export declare function sessionMeta<T extends object>(session: T): Partial<Record<SessionField, unknown>>;
export declare function turnView<T extends object>(turn: T): Partial<Record<TurnField, unknown>>;
export declare function waitingForUser(item: { interaction?: { status?: string; canRespond?: boolean } | null } | null | undefined): boolean;
export declare function turnBoundaries(items: readonly { turnId?: string | null }[]): { bounds: Uint8Array; referenced: Set<string> };
export declare function tailStart(items: readonly { kind?: string; turnId?: string | null }[], window?: { minMessages: number; minTurns: number; maxMessages: number }, bounds?: Uint8Array): number;
export declare function pageStart(items: readonly { turnId?: string | null }[], end: number, limit?: number, bounds?: Uint8Array): number;
