export declare const PROJECT_EVENT_INBOX_VERSION: 1;
export interface ProjectEventLimits { maxSources: number; maxPending: number; maxSummaryChars: number; maxChanges: number; maxDataBytes: number; maxStateBytes: number }
export declare const PROJECT_EVENT_LIMITS: Readonly<ProjectEventLimits>;
export declare class ProjectEventError extends Error { code: string; constructor(message: string, code?: string) }
export interface ProjectEventData {
  changes?: Array<{ path: string; change: 'created' | 'modified' | 'deleted'; sha256?: string }>;
  totalChanges?: number;
  truncated?: boolean;
}
export interface ProjectEventInput {
  sourceId: string; sourceRevision: number; sequence: number; kind: string; summary: string;
  data?: ProjectEventData; coalesceKey?: string; observedAt?: number;
}
export interface ProjectEventCoverage { firstSequence: number; lastSequence: number; observations: number }
/** External facts are untrusted context. They never grant permission or constitute a user instruction. */
export interface ProjectEvent extends ProjectEventInput {
  id: string; projectId: string; bindingId: string; sourceKind: string; contentHash: string;
  receivedAt: number; trust: 'untrusted'; instruction: false; coverage: ProjectEventCoverage;
}
export interface ProjectEventSource {
  id: string; revision: number; kind: string; revoked: boolean; sequence: number; contentHash: string | null; updatedAt: number;
}
export interface ProjectEventInboxState {
  version: 1; projectId: string; bindingId: string; revision: number; sources: ProjectEventSource[]; pending: ProjectEvent[];
  checkpoint: { receiptId: string; at: number; eventIds: string[] } | null;
}
export interface ProjectEventSourceResult {
  status: 'registered' | 'updated' | 'revoked' | 'unchanged' | 'stale' | 'backpressure'; invalidatedEventIds: string[];
}
export type ProjectEventIngestResult =
  | { status: 'accepted' | 'coalesced'; eventId: string; supersededEventId?: string; coverage: ProjectEventCoverage }
  | { status: 'duplicate' | 'stale' | 'revoked' | 'backpressure' };
export interface ProjectEventInbox {
  snapshot(): ProjectEventInboxState;
  status(): { persistence: 'confirmed' | 'uncertain'; revision: number; pending: number; sources: number; limits: ProjectEventLimits };
  pending(options?: { limit?: number }): ProjectEvent[];
  registerSource(input: { id: string; revision: number; kind: string }): Promise<ProjectEventSourceResult>;
  revokeSource(input: { id: string; revision: number }): Promise<ProjectEventSourceResult>;
  ingest(input: ProjectEventInput): Promise<ProjectEventIngestResult>;
  checkpoint(input: { eventIds: string[]; receiptId: string }): Promise<{ status: 'checkpointed' | 'unchanged'; acknowledged: string[] }>;
}
/**
 * Single-owner durable inbox. The adapter owns monotonic source sequences.
 * saveState atomically replaces the snapshot and any related scanner cursor;
 * it resolves only after durability. Rejection requires reload, not retry from
 * the old in-memory state. Retrying downstream delivery uses the same event ID.
 */
export declare function createProjectEventInbox(options: {
  projectId: string; bindingId: string; limits?: Partial<ProjectEventLimits>; state?: ProjectEventInboxState; now?: () => number;
  saveState: (state: ProjectEventInboxState, metadata: { expectedRevision: number; nextRevision: number; operation: 'register_source' | 'revoke_source' | 'ingest' | 'checkpoint' }) => void | Promise<void>;
}): ProjectEventInbox;
