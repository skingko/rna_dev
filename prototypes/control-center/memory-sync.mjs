import { createHash } from 'node:crypto';
import { MemorySummarySync, noteMemoryRevision, memorySummaryHealth } from './memory-summary-sync.mjs';
import { memoryMessagesOf, memoryWriteRecords, reextractMessagesOf } from './memory-checkpoints.mjs';
import { memoryEvidenceMessages, memoryEvidenceDocument, planMemoryEvidence, recoverPreparedMemoryEvidence, freezeLegacyMemoryEvidence, planEvidenceRestore, memoryEvidenceWithdrawn, settleWithdrawnMemoryEvidence, indexOnlyMemoryEvidence, reopenOutageMemoryEvidenceIndex, indexOnly } from './memory-evidence-outbox.mjs';
import { EVIDENCE_WRITE_DEADLINE_MS } from './memory-service.mjs';

const transient = new Set(['creating', 'uploading', 'committing']);
const active = new Set(['pending', 'ready', 'polling', ...transient]);
const timestamp = () => new Date().toISOString();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const acknowledged = { pollFailures: 0, code: null, upstreamStatus: null, stage: null, message: null };
// A resource whose content differs from what was written (B4) is never treated as ours to delete.
const verifiedResource = index => index?.receipt?.complete === true && index.receipt.contentVerified === true && !index.contentDiffers;
/** A resource write the host has not confirmed, checked read-only by the content hash recorded when it was sent:
 * lost mid-request ('uncertain'), or accepted with semantic/vector processing incomplete ('partial'). */
const unconfirmedWrite = index => !index?.cleanup && /^[a-f0-9]{64}$/.test(index?.contentHash ?? '') && (index.status === 'uncertain' && index.code === 'MEMORY_EVIDENCE_WRITE_UNCONFIRMED' || index.status === 'partial');
/** The write request's own deadline (writeEvidenceResource): until it passes the server may still be writing. */
const WRITE_DEADLINE_MS = EVIDENCE_WRITE_DEADLINE_MS;
/** The archive was committed (a task id came back) and only extraction ended badly: the remote session is intact,
 * so later segments of the same turn go on in it (MEM-10). */
const committedOnly = write => write.status === 'failed' && typeof write.taskId === 'string' && ['MEMORY_EXTRACTION_FAILED', 'MEMORY_TASK_EXPIRED'].includes(write.code);
/** A delivery's archive was committed (B7): its free project-resource index does not depend on extraction. */
const archiveCommitted = write => write.status === 'completed' || committedOnly(write);
/** The file itself was embedded; only directory aggregation may have been deferred or skipped (OpenViking
 * content_write: semantic 'deferred'/'skipped' with vectors 'complete' and no queue errors). */
const indexingClean = receipt => receipt?.vectorStatus === 'complete' && !Number(receipt.queueErrors) && ['complete', 'deferred', 'skipped'].includes(receipt.semanticStatus);
/** A verified resource whose semantic/vector index never completed (B1): stored and ours, but search may miss it. */
const indexIncomplete = index => index?.status === 'completed' && index.indexing?.status === 'incomplete';
/** How a settled evidence record got there: receipts nothing reads once it settled (MEM-11, compactEvidenceHistory). */
const EVIDENCE_HISTORY = Object.freeze(['tokenUsage', 'extractionCounts', 'message', 'retention', 'taskStatus', 'nextPollAt', 'pollFailures', 'batchStart', 'batchCount', 'stage', 'stageAt', 'upstreamStatus', 'archived', 'nextMessage', 'settledFrom', 'reconcile', 'recovery']);
const settledEvidence = write => ['completed', 'skipped'].includes(write?.status) && !write.appRecovery?.required && !write.reextract
  && (!write.resourceIndex || ['deleted', 'skipped'].includes(write.resourceIndex.status) || write.resourceIndex.status === 'completed' && !write.resourceIndex.cleanup && !write.resourceIndex.appRecovery?.required)
  && EVIDENCE_HISTORY.some(key => Object.hasOwn(write, key));
// Bounds for free index work that cannot converge (B1, B4, B5); each is retried with backoff until then.
const INDEX_RETRY_LIMIT = 12, REINDEX_LIMIT = 5, DIFFERS_LIMIT = 6, RECONCILE_LIMIT = 24;
/** An uncertain write's commit is looked up only after the server could still have been accepting it (B3). */
const COMMIT_SETTLE_MS = 300000;
/** OpenViking keeps a finished commit task for 24 h after it last changed: within that window a complete task listing
 * without the commit proves it never archived; beyond it, absence proves nothing. */
const COMMIT_PROOF_MS = 20 * 3600000;
const reconcileCodes = new Set(['MEMORY_WRITE_OUTCOME_UNKNOWN', 'MEMORY_COMMIT_RECEIPT_INCOMPLETE']);
/** A write left 'uncertain' by a request without a receipt, which the host can still settle by looking (B3). */
export const reconcilableWrite = write => write?.status === 'uncertain' && reconcileCodes.has(write.code) && write.reconcile?.status !== 'undeterminable';
/** The request that was in flight when an uncertain write lost its receipt. Records written before the stage was kept
 * are read from their cursors: an unacknowledged batch was uploading; a record that never uploaded was creating its
 * remote session (an empty final flush has nothing to upload, so it was committing). */
export function uncertainStage(write) {
  if (transient.has(write.stage)) return write.stage;
  if (write.code === 'MEMORY_COMMIT_RECEIPT_INCOMPLETE') return 'committing';
  if (Number.isInteger(write.batchCount) && Number.isInteger(write.batchStart) && (write.nextMessage ?? 0) === write.batchStart) return 'uploading';
  if (Number.isInteger(write.batchCount) || write.kind === 'final' && !write.sourceRefs?.length) return 'committing';
  return (write.nextMessage ?? 0) === 0 ? 'creating' : 'committing';
}
/** Records a re-extraction may redo (paid, after confirmation): nothing was extracted from them and their source is
 * intact — a failed extraction of a committed archive, or an archive proven never committed (B3). Never a delivery
 * (MEM-7): an assistant-authored message gives OpenViking nothing to extract, so it is only indexed. */
export const reextractCandidate = write => Boolean(write) && !write.blockedBy && write.sourceKind !== 'autonomous_delivery' && (write.status === 'failed' && (write.code === 'MEMORY_EXTRACTION_FAILED' && typeof write.taskId === 'string' || write.code === 'MEMORY_COMMIT_NOT_FOUND') || write.status === 'abandoned' && write.code === 'MEMORY_UPLOAD_UNCONFIRMED');

/** What a recorded sync outcome means for health (MEM-4).
 * 'unresolved': the remote state is unknown (a dispatched request without a receipt) or the record is still
 * retrying — only these degrade /api/health and endurance samples and need the user's look. Each has a resolver:
 * retries, the read-only reconciliation of uncertain writes (B3), the read-only index checks.
 * 'settled': a terminal outcome whose remote state is known (extraction failed, rejected, connection changed,
 * never dispatched, abandoned), or one no check can ever determine. It is a recorded gap and goes straight to
 * history (A2), as OpenViking's own client records a permanent loss and moves on without asking (pi sync.ts
 * droppedForever / captureGap); nothing waits for the user to acknowledge it.
 * null: nothing to report. */
export function memoryWriteResolution(write) {
  if (!write || typeof write !== 'object') return null;
  if (active.has(write.status)) return Number(write.pollFailures) > 0 ? 'unresolved' : null;
  if (['failed', 'abandoned'].includes(write.status)) return 'settled';
  // A source change is detected before the next request is sent, after every earlier one was acknowledged.
  if (write.status === 'uncertain') return write.code === 'MEMORY_SOURCE_CHANGED' || write.reconcile?.status === 'undeterminable' ? 'settled' : 'unresolved';
  return null;
}
/** The same split for a delivery's project-resource index. */
export function memoryIndexResolution(index) {
  if (!index || typeof index !== 'object') return null;
  // An unconfirmed delete of a revoked resource is retried on its own schedule; one whose source came back is checked read-only (B4).
  if (index.cleanup && ['uncertain', 'failed'].includes(index.status)) return 'unresolved';
  if (['partial', 'uncertain'].includes(index.status)) return 'unresolved';
  // A write that failed before it was sent is retried (B5), through an outage as long as it lasts.
  if (index.status === 'pending' && (Number(index.retry?.attempts) > 0 || Number(index.retry?.outages) > 0)) return 'unresolved';
  // 'failed' without cleanup: never dispatched, a confirmed rejection, or a check that cannot converge.
  if (index.status === 'failed') return 'settled';
  if (indexIncomplete(index)) return 'settled';
  // 'deleted' (withdrawn evidence whose resource was removed) and 'skipped' (withdrawn before it was written) are not losses.
  return null;
}
/** Where a record's archive and its memory diff live (A2, for X-7): OpenViking names the archive in the commit receipt
 * and again in the task result, and the diff (`memory_diff.json`: adds/updates/deletes of extracted memories) in the
 * task result once long-term extraction ran. The commit's archive wins; a diff is kept only when it is that archive's
 * own. memory-service checked both against the bound remote session. Archives disappear with their remote session, so
 * these are recorded as they arrive, never backfilled. */
const archiveProvenance = (write, receipt) => {
  const archiveUri = write.archiveUri ?? receipt.archiveUri ?? null;
  return { ...(archiveUri && !write.archiveUri ? { archiveUri } : {}),
    ...(archiveUri && receipt.memoryDiffUri === `${archiveUri}/memory_diff.json` ? { memoryDiffUri: receipt.memoryDiffUri } : {}) };
};
const backoff = (pollMs, checks, cap = 3600000, exponent = 8) => Math.min(cap, pollMs * 2 ** Math.min(Math.max(0, checks), exponent));
/** The memory service did not take the request: unreachable, timed out, not initialized, or failing with a server
 * error (memory-service request() and identity() raise these as 503; a 4xx is an answer). An outage says nothing about
 * the record, so it never counts toward a record's bound; the archive's pending stage waits the same way. */
const serviceOutage = error => error?.status === 503 && !(error.upstreamStatus >= 400 && error.upstreamStatus < 500);
const issueCode = code => /^[A-Z][A-Z0-9_]{0,79}$/.test(code ?? '') ? code : null;
const isoOf = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** Read-only evidence from actual synchronization outcomes, never a paid probe.
 * Unknown remote state and active retries ('unresolved') degrade health until that same record is truly resolved;
 * terminal outcomes ('settled') are history at once (A2): listed newest first, so a successful later conversation
 * never conceals an earlier missing memory, without keeping health red or asking the user for anything. Which list a
 * row is in depends on its resolution alone: `acknowledgedAt` (an earlier click, or the migration) is bookkeeping and
 * never hides an unresolved row. */
export function memorySyncHealth(state) {
  const counts = { pending: 0, inFlight: 0, polling: 0, completed: 0, retained: 0, skipped: 0, failed: 0, uncertain: 0, abandoned: 0, retrying: 0 };
  const projects = new Set((state.projects ?? []).map(project => project.id)), issues = [], settled = [];
  let total = 0, unresolved = 0, settledLoss = 0, acknowledgedLoss = 0, lastSuccessAt = null, checkpoints = 0, completedTurns = 0, retainedPending = 0, evidenceRecords = 0, evidenceCompleted = 0, evidenceExtracted = 0, evidenceIndexOnly = 0, evidenceIndexed = 0, evidenceIndexPending = 0, evidenceIndexIssues = 0, evidenceWithdrawn = 0;
  // `reextractable` reads the source, so it is worked out only for the rows that are listed.
  const note = (resolution, row, acknowledgedAt, reextractable = () => false) => {
    if (resolution === 'unresolved') { unresolved++; if (issues.length < 20) issues.push(row); return; }
    settledLoss++;
    if (acknowledgedAt) acknowledgedLoss++;
    settled.push({ row: acknowledgedAt ? { ...row, acknowledgedAt: isoOf(acknowledgedAt) } : row, reextractable });
  };
  for (const session of state.sessions ?? []) {
    if (!projects.has(session.projectId)) continue;
    for (const turn of [...(session.turns ?? []), { evidence: true }]) {
      const records = turn.evidence ? (session.memoryEvidenceOutbox ?? []).map(write => ({ id: write.id, write })) : memoryWriteRecords(turn);
      const finalSettled = records.at(-1)?.write.kind === 'final' && ['completed', 'skipped'].includes(records.at(-1).write.status);
      // A retained segment handed to a re-extraction (B2) is extracted by it, not by the turn's final commit.
      for (const { write } of records) if (write?.status === 'retained') {
        const cover = typeof write.coveredBy === 'string' ? records.find(row => row.id === write.coveredBy) : null;
        if (cover ? cover.write.status !== 'completed' : !finalSettled) retainedPending++;
      }
      if (turn.status === 'completed' && records.length && records.every(row => ['completed', 'skipped', 'retained'].includes(row.write.status)) && (turn.memoryCheckpoints?.length ? finalSettled : records.at(-1).write.status !== 'retained')) completedTurns++;
      for (const { id: checkpointId, write } of records) {
      if (!write || typeof write !== 'object') continue;
      total++;
      if (checkpointId && !turn.evidence) checkpoints++;
      // `evidenceCompleted` / `evidenceExtracted` count archives that went through extraction; a delivery has nothing to
      // archive (MEM-7) and is counted apart.
      if (turn.evidence) { evidenceRecords++; if (indexOnly(write)) evidenceIndexOnly++; else if (write.status === 'completed') { evidenceCompleted++; evidenceExtracted += Number(write.memoriesExtracted) || 0; } }
      if (turn.evidence && write.resourceIndex) {
        const index = write.resourceIndex;
        if (index.status === 'completed' && !indexIncomplete(index)) evidenceIndexed++;
        // The index runs once its archive was committed (B7), extraction aside; an archive never committed never reaches it.
        if (['pending', 'dispatching'].includes(index.status) && (archiveCommitted(write) || active.has(write.status))) evidenceIndexPending++;
        if (['partial', 'uncertain', 'failed'].includes(index.status) || indexIncomplete(index)) evidenceIndexIssues++;
        // A removed delivery document is not a fault, but never silent (MEM-1): a supersession by its own settled text is not a withdrawal.
        if (index.status === 'deleted' && index.code !== 'MEMORY_EVIDENCE_SUPERSEDED') evidenceWithdrawn++;
        const resolution = memoryIndexResolution(index);
        if (resolution) note(resolution, { projectId: session.projectId, sessionId: session.id, evidenceId: write.id, stage: index.cleanup ? 'project_resource_cleanup' : 'project_resource_index', status: index.status, code: issueCode(index.code) ?? 'MEMORY_EVIDENCE_INDEX_FAILED', updatedAt: isoOf(index.updatedAt) }, index.acknowledgedAt);
      }
      if (transient.has(write.status)) counts.inFlight++;
      else if (['pending', 'ready'].includes(write.status)) counts.pending++;
      else if (Object.hasOwn(counts, write.status) && write.status !== 'retrying') counts[write.status]++;
      if (write.status === 'completed' && Number.isFinite(Date.parse(write.updatedAt))) {
        const at = new Date(write.updatedAt).toISOString();
        if (!lastSuccessAt || at > lastSuccessAt) lastSuccessAt = at;
      }
      if (active.has(write.status) && Number(write.pollFailures) > 0) counts.retrying++;
      const resolution = memoryWriteResolution(write);
      if (!resolution) continue;
      // Re-extraction is offered on a history row only when it would upload something (B2): read-only, never thrown.
      const reextractable = () => resolution === 'settled' && reextractCandidate(write) && (() => {
        try { return (turn.evidence ? memoryEvidenceMessages(state, session.id, write) : reextractMessagesOf(session, turn, write)).length > 0; } catch { return false; }
      })();
      note(resolution, { projectId: session.projectId, sessionId: session.id, ...(turn.evidence ? { evidenceId: checkpointId } : { turnId: turn.id, ...(checkpointId ? { checkpointId } : {}) }),
        status: write.status, code: issueCode(write.code) ?? 'MEMORY_SYNC_FAILED',
        ...(Number.isInteger(write.upstreamStatus) && write.upstreamStatus >= 400 && write.upstreamStatus <= 599 ? { upstreamStatus: write.upstreamStatus } : {}),
        ...(typeof write.blockedBy === 'string' ? { blockedBy: write.blockedBy } : {}),
        updatedAt: isoOf(write.updatedAt) }, write.acknowledgedAt, reextractable);
      }
    }
  }
  // History reads newest first; rows without a time keep their order (a stable sort).
  const settledLosses = settled.map((entry, order) => ({ ...entry, order })).sort((a, b) => String(b.row.updatedAt ?? '').localeCompare(String(a.row.updatedAt ?? '')) || a.order - b.order)
    .slice(0, 20).map(({ row, reextractable }) => reextractable() ? { ...row, reextractable: true } : row);
  const summaries = memorySummaryHealth(state);
  return { status: unresolved || !summaries.healthy ? 'degraded' : counts.completed ? 'healthy' : 'not_observed', healthy: unresolved === 0 && summaries.healthy,
    evidence: 'recorded_memory_sync_outcomes', total, checkpoints, completedTurns, retainedPending, evidenceRecords, evidenceCompleted, evidenceExtracted, evidenceIndexOnly, evidenceIndexed, evidenceIndexPending, evidenceIndexIssues, evidenceWithdrawn, counts, lastSuccessAt,
    unresolved, settledLoss, acknowledged: acknowledgedLoss, issues, omittedIssues: Math.max(0, unresolved - issues.length),
    settledLosses, omittedSettledLosses: Math.max(0, settledLoss - settledLosses.length), summaries };
}

/** One time and idempotent (every start; a second run changes nothing), A2. Settled losses used to wait in the
 * attention count until the user clicked "知道了" (MEM-4); they are history now, decided by resolution alone. This
 * stamps `acknowledgedAt` on every settled write and delivery index that carries none yet, so no record kept from
 * before reads as waiting for the user. Only rows whose resolution is 'settled' are stamped: an unresolved row is
 * never touched, and a stamp could not hide one anyway (memorySyncHealth counts an unresolved row whatever it
 * carries). Sessions held for application recovery are left for a later start. Returns how many rows it stamped. */
export function stampSettledMemoryHistory(state, { now = timestamp(), dryRun = false } = {}) {
  let stamped = 0;
  const stamp = (row, resolution) => { if (resolution === 'settled' && !row.acknowledgedAt) { if (!dryRun) row.acknowledgedAt = now; stamped++; } };
  for (const session of state.sessions ?? []) {
    if (session.appRecovery?.required) continue;
    for (const write of [...(session.turns ?? []).flatMap(turn => memoryWriteRecords(turn).map(row => row.write)), ...(session.memoryEvidenceOutbox ?? [])]) {
      if (!write || typeof write !== 'object' || write.appRecovery?.required) continue;
      stamp(write, memoryWriteResolution(write));
      if (write.resourceIndex && typeof write.resourceIndex === 'object' && !write.resourceIndex.appRecovery?.required) stamp(write.resourceIndex, memoryIndexResolution(write.resourceIndex));
    }
  }
  return stamped;
}

// Completed real turns and SDK-confirmed settled checkpoints are atomically
// enrolled by Store. No pre-existing conversations are backfilled. The outbox
// stores immutable source references/cursors/receipts, not another transcript.
export class MemorySync {
  constructor(store, { now = Date.now, pollMs = 15000 } = {}) {
    this.store = store; this.now = now; this.pollMs = pollMs; this.running = new Map(); this.closed = false;
    this.abort = new AbortController(); this.errors = 0; this.runningSessions = new Map(); this.drainingSessions = new Set(); this.drainHolds = new Map(); this.cursor = 0;
    this.summarySync = new MemorySummarySync(store, { now, pollMs });
    this.historyStamped = false; this.stampHistory();
    this.enrollEvidence(true);
    this.unsubscribe = store.subscribe(() => { if (!this.closed) this.enrollEvidence(); }, { display: false });
  }
  /** The history migration (stampSettledMemoryHistory), once per start: held back, like evidence enrolment, while
   * maintenance or the memory recovery barrier holds writes, and run by the first pump after that. */
  stampHistory() {
    if (this.historyStamped || this.store.maintenanceHeld || (this.store.state.applicationRecovery?.barriers?.memory && this.store.state.configuration.memory.autoStore !== true)) return;
    this.historyStamped = true;
    const now = new Date(this.now()).toISOString();
    if (stampSettledMemoryHistory(this.store.state, { now, dryRun: true })) this.store.mutate(state => { stampSettledMemoryHistory(state, { now }); });
  }
  /** MEM-11: a settled evidence record's receipts of how it got there (usage, retries, stages, messages) move to the
   * content-addressed history archive (Store.archiveRecords), named by `history`; what deletion, cleanup, rewind,
   * re-extraction and the memory page read stays (identity, source refs, remote session and task, archive, counts,
   * resource index). Settled: completed or skipped, with a resource index that is done or none. On the live copy of
   * 2026-10-05 these fields were 62 KB of the 411 KB of evidence records (memory-hygiene-b6-20261005.md). */
  compactEvidenceHistory() {
    const rows = [];
    for (const session of this.store.state.sessions) {
      if (session.appRecovery?.required || this.drainingSessions.has(session.id)) continue;
      for (const write of session.memoryEvidenceOutbox ?? []) if (settledEvidence(write) && !this.running.has(`evidence:${write.id}`)) rows.push({ sessionId: session.id, projectId: session.projectId, write });
    }
    if (!rows.length) return;
    const references = new Map();
    for (const projectId of new Set(rows.map(row => row.projectId))) {
      const own = rows.filter(row => row.projectId === projectId);
      if (!/^[a-zA-Z0-9_-]{1,160}$/.test(projectId ?? '')) continue;
      const refs = this.store.archiveRecords(`memory/${projectId}/evidence`, own.map(({ sessionId, write }) => ({ id: write.id, sessionId, fields: Object.fromEntries(EVIDENCE_HISTORY.filter(key => Object.hasOwn(write, key)).map(key => [key, write[key]])) })));
      own.forEach((row, index) => references.set(row.write.id, refs[index]));
    }
    if (references.size) this.store.mutate(state => {
      for (const session of state.sessions) for (const write of session.memoryEvidenceOutbox ?? []) {
        if (!references.has(write.id) || !settledEvidence(write)) continue;
        for (const key of EVIDENCE_HISTORY) delete write[key];
        write.archivedHistory = [...(Array.isArray(write.archivedHistory) ? write.archivedHistory : []), references.get(write.id)].slice(-4);
      }
    });
  }
  /** MEM-11: a project's binding is marked 'deleted' only once its remote session was removed for a deleted
   * conversation (session-deletion settleBinding), and that conversation's deletion record holds its own copy. The
   * project copy then serves nothing (no record of a live conversation names it) and is dropped, with one exception:
   * memoryService.scopes() searches the project's peer memories only while some binding on that endpoint and namespace
   * exists, and extracted memories outlive the conversation they came from (deletion keeps them). The newest deleted
   * binding stays when no other binding proves the same scope. */
  pruneBindings() {
    const live = state => new Set(state.sessions.flatMap(session => [...session.turns.flatMap(turn => memoryWriteRecords(turn).map(row => row.write?.sessionId)), ...(session.memoryEvidenceOutbox ?? []).map(write => write.sessionId)]).filter(Boolean));
    const scope = binding => binding.isolation === 'project-peer-v1' ? JSON.stringify([binding.endpoint ?? null, binding.namespace ?? null]) : null;
    const removable = (project, used) => {
      const rows = project.memorySessions ?? [], candidates = rows.filter(binding => binding.status === 'deleted' && !used.has(binding.sessionId) && !binding.pendingRequests?.length);
      if (!candidates.length) return [];
      const proven = new Set(rows.filter(binding => !candidates.includes(binding)).map(scope)), spared = new Set();
      for (const binding of candidates.toReversed()) { const key = scope(binding); if (key && !proven.has(key)) { proven.add(key); spared.add(binding); } }
      return candidates.filter(binding => !spared.has(binding));
    };
    if (!this.store.state.projects.some(project => project.memorySessions?.some(binding => binding.status === 'deleted'))) return;
    const used = live(this.store.state);
    if (!this.store.state.projects.some(project => removable(project, used).length)) return;
    this.store.mutate(state => { const current = live(state); for (const project of state.projects) { const drop = new Set(removable(project, current)); if (drop.size) project.memorySessions = project.memorySessions.filter(binding => !drop.has(binding)); } });
  }
  enrollEvidence(bootstrap = false) {
    if (this.store.maintenanceHeld || (this.store.state.applicationRecovery?.barriers?.memory && this.store.state.configuration.memory.autoStore !== true)) return;
    if (this.enrolling) return;
    this.enrolling = true;
    try {
    const plans = [], migrations = [], restores = [];
    for (const session of this.store.state.sessions) {
      const project = this.store.state.projects.find(row => row.id === session.projectId);
      if (session.appRecovery?.required || this.drainingSessions.has(session.id) || !project) continue;
      for (const write of session.memoryEvidenceOutbox ?? []) {
        // Idempotent: a record matches at most once, and its patch no longer matches. A delivery enrolled before MEM-7
        // that has sent nothing yet goes index-only.
        const patch = freezeLegacyMemoryEvidence(this.store.state, session, write) ?? settleWithdrawnMemoryEvidence(this.store.state, session, write, timestamp()) ?? indexOnlyMemoryEvidence(write, timestamp()) ?? reopenOutageMemoryEvidenceIndex(write, timestamp());
        if (patch) migrations.push({ sessionId: session.id, id: write.id, patch });
      }
      // Delivery documents deleted because initiative scope drift read as a revocation are indexed again (MEM-1); it runs
      // again only when a document was deleted since, or the connection changed (planEvidenceRestore, MIG-2). The archive
      // is checked before the connection fingerprint is computed: this runs on every store mutation. An archived
      // conversation or project is restored once it is unarchived (MIG-1).
      const restore = session.memoryEvidenceOutbox?.length && !session.archivedAt && !project.archivedAt ? planEvidenceRestore(this.store.state, session, { connectionFingerprint: this.store.memoryService.connectionFingerprint(session.projectId), now: this.now() }) : null;
      if (restore) restores.push({ sessionId: session.id, restore });
      const plan = planMemoryEvidence(this.store.state, session, { connectionFingerprint: session.memoryEvidenceState ? this.store.memoryService.connectionFingerprint(session.projectId) : null, namespace: this.store.memoryService.remote(session.projectId).namespace, now: this.now(), bootstrap });
      if (plan) plans.push({ sessionId: session.id, plan });
    }
    if (plans.length || migrations.length || restores.length) this.store.mutate(state => {
      for (const row of migrations) {
        const write = state.sessions.find(session => session.id === row.sessionId)?.memoryEvidenceOutbox?.find(write => write.id === row.id);
        if (write) Object.assign(write, row.patch);
      }
      for (const { sessionId, plan } of plans) {
      const session = state.sessions.find(row => row.id === sessionId); if (!session) continue;
      session.memoryEvidenceState = plan.state;
      for (const { id, by } of plan.superseded ?? []) { const write = session.memoryEvidenceOutbox?.find(row => row.id === id); if (write) write.supersededBy = by; }
      if (plan.records.length) { session.memoryEvidenceOutbox ??= []; session.memoryEvidenceOutbox.push(...plan.records); }
    }
      for (const { sessionId, restore } of restores) {
        const session = state.sessions.find(row => row.id === sessionId); if (!session?.memoryEvidenceState) continue;
        for (const { id, resourceIndex } of restore.restore) { const write = session.memoryEvidenceOutbox?.find(row => row.id === id); if (write?.resourceIndex?.status === 'deleted') write.resourceIndex = { ...resourceIndex, updatedAt: timestamp() }; }
        session.memoryEvidenceState = { ...session.memoryEvidenceState, scopeRestore: restore.marker };
      } });
    } finally { this.enrolling = false; }
  }
  patch(sessionId, turnId, patch, checkpointId = null, evidenceId = null) {
    if (!this.store.state.sessions.some(session => session.id === sessionId)) return;
    return this.store.mutate(state => {
      const session = state.sessions.find(session => session.id === sessionId), turn = session?.turns.find(turn => turn.id === turnId);
      if (turn || evidenceId) {
        const record = evidenceId ? session?.memoryEvidenceOutbox?.find(row => row.id === evidenceId) : checkpointId ? turn.memoryCheckpoints?.find(row => row.id === checkpointId) : turn.memoryWrite;
        if (!record) return;
        const newlyCompleted = record.status === 'polling' && patch.status === 'completed';
        Object.assign(record, patch, { updatedAt: timestamp() });
        // New peer memories (a count from the task, or a non-empty memory diff when only the archive's marker settled
        // it): the project's memory revision moves, which tells the memory page its content changed (MEM-8). A diff is
        // written even when extraction changed nothing, so its presence alone moves nothing.
        if (newlyCompleted && (patch.memoriesExtracted > 0 || patch.memoriesExtracted === undefined && patch.settledBy?.memoryChanges > 0)) {
          const session = state.sessions.find(session => session.id === sessionId);
          noteMemoryRevision(state, session.projectId, record, this.now());
        }
      }
    });
  }
  pump() {
    if (this.closed || this.store.maintenanceHeld || (this.store.state.applicationRecovery?.barriers?.memory && this.store.state.configuration.memory.autoStore !== true)) return [];
    this.stampHistory();
    this.pruneBindings();
    this.compactEvidenceHistory();
    this.enrollEvidence();
    const started = this.summarySync.pump(), sessions = this.store.state.sessions;
    const start = (key, sessionId, run) => {
      const job = Promise.resolve().then(run).catch(() => { this.errors++; }).finally(() => { this.running.delete(key); this.runningSessions.delete(key); });
      this.runningSessions.set(key, sessionId); this.running.set(key, job); started.push(job);
    };
    // Conversations take turns for the two slots (MIG-1): each pass starts after the last conversation that got one, so a
    // conversation whose records keep coming back eligible can never hold both slots ahead of the others for good.
    for (let offset = 0, origin = this.cursor % Math.max(1, sessions.length); offset < sessions.length; offset++) {
      const position = (origin + offset) % sessions.length, session = sessions[position], before = started.length;
      if (session.appRecovery?.required || this.drainingSessions.has(session.id)) continue;
      const project = this.store.state.projects.find(project => project.id === session.projectId);
      if (!project) continue;
      const paused = Boolean(this.store.state.emergency || session.archivedAt || project.archivedAt || this.store.state.configuration.memory.autoStore === false);
      for (const turn of session.turns) {
        // Segments of a turn go in order. A segment whose archive was committed lets the next one go on; an unknown
        // remote state ('uncertain', in flight) holds the rest; a terminal outcome ends the pending rest the same way.
        const records = memoryWriteRecords(turn), at = records.findIndex(row => !['completed', 'skipped', 'retained'].includes(row.write.status) && !committedOnly(row.write));
        const record = records[at];
        if (!record) continue;
        const { id: checkpointId, write } = record;
        // A settled 'uncertain' (a source change before anything of it was sent, or an outcome no check can determine)
        // ends the pending rest like any other terminal outcome (MEM-10, B6).
        if (['failed', 'abandoned'].includes(write.status) || write.status === 'uncertain' && memoryWriteResolution(write) === 'settled') {
          const blocked = records.slice(at + 1).filter(row => row.id && row.write.status === 'pending' && !row.write.sessionId);
          if (blocked.length && !this.running.has(turn.id)) this.blockSuccessors(session.id, turn.id, checkpointId, write, blocked.map(row => row.id));
          continue;
        }
        if (this.running.has(turn.id) || this.running.size >= 2) continue;
        // Read-only: looking up what became of a write without a receipt runs even while writes are paused (B3).
        if (reconcilableWrite(write)) {
          if (this.now() >= (write.reconcile?.nextCheckAt ?? 0)) start(turn.id, session.id, () => this.reconcile(session.id, turn.id, checkpointId));
          continue;
        }
        if (!checkpointId && turn.status !== 'completed' || !active.has(write.status) || this.now() < (write.nextPollAt ?? 0)) continue;
        // Observe existing tasks even while writes are disabled or archived.
        if (write.status !== 'polling' && paused) continue;
        start(turn.id, session.id, () => this.advance(session.id, turn.id, checkpointId));
      }
      for (const write of session.memoryEvidenceOutbox ?? []) {
        const key = `evidence:${write.id}`;
        if (!this.running.has(key) && !paused) {
          const recovery = recoverPreparedMemoryEvidence(this.store.state, session, write, this.store.memoryService.connectionFingerprint(session.projectId));
          if (recovery) { this.patch(session.id, null, recovery, null, write.id); continue; }
        }
        if (archiveCommitted(write) && write.resourceIndex) {
          const index = write.resourceIndex;
          // indexEvidence returns at once for these: never let them take a slot.
          if (write.appRecovery?.required || index.appRecovery?.required) continue;
          let revoked = false; try { memoryEvidenceDocument(this.store.state, session.id, write); } catch (error) { revoked = error.code === 'MEMORY_SOURCE_CHANGED'; }
          // An unconfirmed or partial write is checked read-only even when its source was revoked: a match becomes a
          // verified resource, which the next pass then deletes; confirmed absent needs nothing more. A write is sent
          // only while writes are allowed (MIG-1): a paused one would return at once and take a slot on every pass.
          // A cleanup whose source came back is checked read-only too (B4).
          const eligible = index.status === 'pending' && !paused || index.status === 'dispatching' || index.status !== 'deleted' && revoked && verifiedResource(index)
            || unconfirmedWrite(index) || !revoked && index.cleanup && ['failed', 'uncertain'].includes(index.status);
          if (eligible && this.now() >= (index.cleanup?.nextCheckAt ?? index.verify?.nextCheckAt ?? index.retry?.nextCheckAt ?? 0) && !this.running.has(key) && this.running.size < 2)
            start(key, session.id, () => this.indexEvidence(session.id, write.id));
          continue;
        }
        if (this.running.has(key) || this.running.size >= 2) continue;
        if (reconcilableWrite(write)) {
          if (this.now() >= (write.reconcile?.nextCheckAt ?? 0)) start(key, session.id, () => this.reconcile(session.id, null, null, write.id));
          continue;
        }
        if (!active.has(write.status) || this.now() < (write.nextPollAt ?? 0)) continue;
        if (write.status !== 'polling' && paused) continue;
        start(key, session.id, () => this.advance(session.id, null, null, write.id));
      }
      if (started.length > before) this.cursor = position + 1;
    }
    return started;
  }
  /** Pending later segments of a turn whose earlier segment ended terminally share its outcome (MEM-10): they were
   * never sent, and leaving them pending would show the turn as syncing forever. */
  blockSuccessors(sessionId, turnId, checkpointId, predecessor, ids) {
    const blockedBy = checkpointId ?? predecessor.id ?? 'memoryWrite', code = issueCode(predecessor.code) ?? 'MEMORY_SYNC_FAILED';
    this.store.mutate(state => {
      const turn = state.sessions.find(row => row.id === sessionId)?.turns.find(row => row.id === turnId);
      for (const record of turn?.memoryCheckpoints ?? []) if (ids.includes(record.id) && record.status === 'pending' && !record.sessionId)
        Object.assign(record, { status: 'failed', code, blockedBy, nextPollAt: null, message: '同一轮较早的一段没有同步成功，这一段没有发送。', updatedAt: timestamp() });
    });
  }
  async indexEvidence(sessionId, evidenceId) {
    const session = this.store.state.sessions.find(row => row.id === sessionId), write = session?.memoryEvidenceOutbox?.find(row => row.id === evidenceId);
    if (session?.appRecovery?.required || write?.appRecovery?.required || write?.resourceIndex?.appRecovery?.required || !write?.resourceIndex) return;
    const index = write.resourceIndex, projectId = session.projectId, service = this.store.memoryService;
    const patch = changes => this.store.mutate(state => {
      const current = state.sessions.find(row => row.id === sessionId)?.memoryEvidenceOutbox?.find(row => row.id === evidenceId)?.resourceIndex;
      if (current) Object.assign(current, changes, { updatedAt: timestamp() });
      // A dispatched write may settle after the conversation was removed.
      for (const tombstone of state.sessionDeletions ?? []) if (tombstone.sessionId === sessionId) for (const row of tombstone.evidenceResources ?? []) if (row.evidenceId === evidenceId) Object.assign(row, changes, { updatedAt: timestamp() });
    });
    // Replaces the whole index (keys that no longer apply are dropped). Used only while the conversation exists (its
    // source verifies), so no deletion tombstone can hold this record.
    const replace = next => this.store.mutate(state => {
      const record = state.sessions.find(row => row.id === sessionId)?.memoryEvidenceOutbox?.find(row => row.id === evidenceId);
      if (record?.resourceIndex) record.resourceIndex = { ...next, updatedAt: timestamp() };
    });
    const live = () => { try { memoryEvidenceDocument(this.store.state, sessionId, write); return true; } catch (error) { if (error.code === 'MEMORY_SOURCE_CHANGED') return false; throw error; } };
    const nextCheck = checks => this.now() + backoff(this.pollMs, checks - 1);
    // A document written again at the same deterministic URI (mode create): embedding only, nothing extracted again.
    const fresh = (reason, extra = {}) => ({ status: 'pending', namespace: index.namespace, uri: index.uri, connectionFingerprint: index.connectionFingerprint, mode: 'create', ...extra,
      restore: { reason, at: timestamp(), previous: { status: index.status, code: index.code ?? null, receipt: index.receipt ?? null } } });
    if (index.status === 'deleted') return;
    if (verifiedResource(index)) {
      let revoked;
      try { revoked = !live(); } catch { return; }
      if (!revoked) {
        // A cleanup whose source came back (B4): look at what the service holds, read-only, instead of deleting.
        if (index.cleanup && ['failed', 'uncertain'].includes(index.status)) await this.restoreCleanedIndex(sessionId, index, { patch, replace, fresh, nextCheck });
        return;
      }
      // Retain the original successful write receipt. Cleanup is a separate
      // operation: failed DELETE is never evidence of a rejected create.
      const resource = { ...index, evidenceId, sourceHash: write.sourceRefs[0].sourceHash };
      const record = { sessionId, projectId, evidenceResources: [resource] };
      const legacy = !index.cleanup && index.status !== 'completed';
      const cleanup = { ...(index.cleanup ?? {}), ...(legacy ? { legacyDiagnostic: { status: index.status, code: index.code ?? null, confirmedRejected: index.confirmedRejected === true } } : {}),
        status: 'checking', checks: (index.cleanup?.checks ?? 0) + 1, startedAt: index.cleanup?.startedAt ?? timestamp() };
      const firstDelete = index.status === 'completed' && !index.cleanup;
      if (firstDelete) { cleanup.status = 'deleting'; cleanup.dispatchedAt = timestamp(); }
      patch({ status: 'uncertain', confirmedRejected: false, code: 'MEMORY_EVIDENCE_DELETE_UNCONFIRMED', cleanup });
      try {
        const input = { signal: this.abort.signal, guard: () => {
          try { memoryEvidenceDocument(this.store.state, sessionId, write); } catch (error) { if (error.code === 'MEMORY_SOURCE_CHANGED') return; throw error; }
          throw Object.assign(new Error('Source no longer revoked'), { code: 'MEMORY_EVIDENCE_CLEANUP_PAUSED' });
        } };
        const receipt = firstDelete ? await service.deleteEvidenceResource(record, resource, input) : await service.reconcileEvidenceResource(record, resource, input);
        this.abort.signal.throwIfAborted();
        let restored = false; if (receipt.deleted) try { restored = live(); } catch { /* the session or its project is gone: deleted stands */ }
        // The source came back while the DELETE was in flight (B4): the removal happened, so the document is written again.
        if (restored) replace(fresh('source_restored_during_cleanup', { cleanupHistory: [...(index.cleanupHistory ?? []), { ...cleanup, status: 'deleted', receipt, completedAt: timestamp() }].slice(-5) }));
        else if (receipt.deleted) patch({ status: 'deleted', code: this.store.state.sessions.find(row => row.id === sessionId)?.memoryEvidenceOutbox?.find(row => row.id === evidenceId)?.supersededBy ? 'MEMORY_EVIDENCE_SUPERSEDED' : 'MEMORY_SOURCE_CHANGED', cleanup: { ...cleanup, status: 'deleted', receipt, nextCheckAt: null, completedAt: timestamp() } });
        else patch({ status: 'failed', code: 'MEMORY_EVIDENCE_DELETE_UNCONFIRMED', cleanup: { ...cleanup, status: 'unconfirmed', reconciliation: receipt.reconciliation, nextCheckAt: this.now() + Math.min(3600000, this.pollMs * 2 ** Math.min(cleanup.checks - 1, 8)) } });
      } catch (error) {
        const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code ?? '') ? error.code : 'MEMORY_EVIDENCE_DELETE_UNCONFIRMED';
        patch({ status: 'failed', code, cleanup: { ...cleanup, status: 'unconfirmed', code,
          ...(Number.isInteger(error.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}),
          ...(error.upstreamCode ? { upstreamCode: error.upstreamCode } : {}),
          nextCheckAt: this.now() + Math.min(3600000, this.pollMs * 2 ** Math.min(cleanup.checks - 1, 8)) } });
      }
      return;
    }
    // Settle an unconfirmed write by what the service actually holds, without writing anything:
    // the exact content sent → completed; confirmed absent → sent again; otherwise it stays unconfirmed.
    // A 'partial' write returned its receipt, so the server is no longer writing it: no deadline to wait for.
    if (unconfirmedWrite(index)) {
      const checks = (index.verify?.checks ?? 0) + 1, later = { checks, nextCheckAt: nextCheck(checks) };
      if (index.status === 'uncertain' && this.now() < Date.parse(index.dispatchedAt ?? 0) + WRITE_DEADLINE_MS) { patch({ verify: { ...later, status: 'waiting_deadline' } }); return; }
      let found; try { found = await service.verifyEvidenceWrite(projectId, index, { signal: this.abort.signal }); } catch { patch({ verify: { ...later, status: 'unreachable' } }); return; }
      if (found.state === 'matches') {
        const receipt = { ...(index.receipt ?? {}), userId: index.userId, contentHash: index.contentHash, uri: index.uri, contentVerified: true, complete: true, reconciliation: found.reconciliation };
        const verified = { checks, status: 'verified', at: timestamp() };
        let revoked = false; try { revoked = !live(); } catch { /* the session is going away: settle by the content alone */ }
        // The content is ours. A revoked source keeps today's path: a verified resource, which the next pass deletes.
        // A lost write ('uncertain') says nothing about its indexing. A 'partial' one is complete when only directory
        // aggregation was deferred; otherwise its semantic/vector index is rebuilt in place (B1), never written again.
        if (revoked || index.status === 'uncertain') patch({ status: 'completed', code: null, receipt: { ...receipt, indexing: 'not_confirmed' }, verify: verified });
        else if (indexingClean(index.receipt)) patch({ status: 'completed', code: null, receipt, indexing: { status: 'complete', at: verified.at }, verify: verified });
        else await this.reindexPartial(sessionId, index, { patch, receipt, verified, later });
      } else if (found.state === 'missing') patch({ status: 'pending', code: null, verify: { checks, status: 'absent', at: timestamp(), reconciliation: found.reconciliation } });
      // Another identity, key or namespace answers now (B4): nothing here can ever be checked again.
      else if (found.state === 'scope_changed') patch({ status: 'failed', code: 'MEMORY_EVIDENCE_SCOPE_CHANGED', verify: { checks, status: found.state, at: timestamp() } });
      // Something else is stored at this URI: never ours to delete; settled once it keeps differing.
      else if (found.state === 'differs' && checks >= DIFFERS_LIMIT) patch({ status: 'failed', code: 'MEMORY_EVIDENCE_CONTENT_DIFFERS', contentDiffers: true, verify: { checks, status: found.state, at: timestamp(), reconciliation: found.reconciliation } });
      else patch({ verify: { ...later, status: found.state } });
      return;
    }
    if (!['pending', 'dispatching'].includes(index.status)) return;
    if (index.status === 'dispatching') { patch({ status: 'uncertain', code: 'MEMORY_EVIDENCE_WRITE_UNCONFIRMED' }); return; }
    let dispatched = false, writeReceiptReceived = false;
    const source = () => memoryEvidenceDocument(this.store.state, sessionId, write);
    const guard = () => {
      this.abort.signal.throwIfAborted();
      const current = this.store.state.sessions.find(row => row.id === sessionId), project = this.store.state.projects.find(row => row.id === projectId);
      if (!current || !project || this.drainingSessions.has(sessionId) || current.archivedAt || project.archivedAt || this.store.state.emergency || this.store.state.configuration.memory.autoStore === false) throw Object.assign(new Error('Paused'), { code: 'MEMORY_SYNC_PAUSED' });
      if (service.connectionFingerprint(projectId) !== index.connectionFingerprint) throw Object.assign(new Error('Scope changed'), { code: 'MEMORY_EVIDENCE_SCOPE_CHANGED' });
      source();
    };
    try {
      guard();
      const receipt = await service.writeEvidenceResource(projectId, sessionId, write, { signal: this.abort.signal,
        onDispatch: metadata => { guard(); dispatched = true; patch({ status: 'dispatching', ...metadata, dispatchedAt: timestamp(), ...(index.retry ? { retry: null } : {}) }); },
        onReceipt: receipt => { writeReceiptReceived = true; patch({ receipt }); } });
      patch({ status: receipt.complete ? 'completed' : 'partial', receipt, code: receipt.complete ? null : 'MEMORY_EVIDENCE_INDEX_INCOMPLETE', ...(index.retry ? { retry: null } : {}) });
    } catch (error) {
      if (error.code === 'MEMORY_SYNC_PAUSED' && !dispatched || this.abort.signal.aborted && !dispatched) return;
      // Its line was rewritten after it settled and the new text enrolled as its own record (MEM-3): nothing was sent.
      if (error.code === 'MEMORY_SOURCE_CHANGED' && !dispatched && this.store.state.sessions.find(row => row.id === sessionId)?.memoryEvidenceOutbox?.find(row => row.id === evidenceId)?.supersededBy) { patch({ status: 'skipped', code: 'MEMORY_EVIDENCE_SUPERSEDED' }); return; }
      // Withdrawn before anything was written (MEM-5): nothing to index, nothing lost.
      if (!dispatched && error.code === 'MEMORY_SOURCE_CHANGED' && memoryEvidenceWithdrawn(this.store.state, sessionId, write)) { patch({ status: 'skipped', code: 'MEMORY_SOURCE_WITHDRAWN' }); return; }
      // Failed before anything was sent (B5): a free write, retried with backoff like the archive's pending stage. Only
      // the service was asked (its status), so an outage waits as long as it lasts; any other failure settles as a loss
      // once it never got through.
      if (!dispatched && !['MEMORY_SOURCE_CHANGED', 'MEMORY_EVIDENCE_SCOPE_CHANGED'].includes(error.code) && !(error.upstreamStatus >= 400 && error.upstreamStatus < 500)) {
        const outage = serviceOutage(error), attempts = (index.retry?.attempts ?? 0) + (outage ? 0 : 1), outages = (index.retry?.outages ?? 0) + (outage ? 1 : 0);
        if (outage || attempts < INDEX_RETRY_LIMIT) { patch({ status: 'pending', code: 'MEMORY_CONNECTION_UNAVAILABLE', retry: { attempts, outages, nextCheckAt: this.now() + backoff(this.pollMs, attempts + outages), at: timestamp() } }); return; }
        patch({ status: 'failed', code: 'MEMORY_EVIDENCE_INDEX_FAILED', retry: { attempts, outages, nextCheckAt: null, exhaustedAt: timestamp() } }); return;
      }
      const knownRejection = !writeReceiptReceived && error.upstreamStatus >= 400 && error.upstreamStatus < 500;
      patch({ status: dispatched && !knownRejection ? 'uncertain' : 'failed', ...(knownRejection ? { confirmedRejected: true } : {}), code: error.code === 'MEMORY_SOURCE_CHANGED' ? error.code : error.code === 'MEMORY_EVIDENCE_SCOPE_CHANGED' ? error.code : dispatched && !knownRejection ? 'MEMORY_EVIDENCE_WRITE_UNCONFIRMED' : 'MEMORY_EVIDENCE_INDEX_FAILED' });
    }
  }
  /** A 'partial' delivery document whose exact content the service holds, but whose semantic/vector processing did
   * not complete (B1): rebuild its index in place. 'completed' only on a clean rebuild; until then it stays 'partial'
   * (unresolved) with backoff; a refusal or REINDEX_LIMIT failed rebuilds (an outage is not one) settle it as a verified resource whose
   * indexing is incomplete — a listed loss the user can acknowledge. Never written or extracted again. */
  async reindexPartial(sessionId, index, { patch, receipt, verified, later }) {
    const session = this.store.state.sessions.find(row => row.id === sessionId), project = this.store.state.projects.find(row => row.id === session?.projectId);
    if (!session || !project || this.drainingSessions.has(sessionId) || session.archivedAt || project.archivedAt || this.store.state.emergency || this.store.state.configuration.memory.autoStore === false) { patch({ verify: { ...later, status: 'reindex_paused' } }); return; }
    const attempts = (index.reindex?.attempts ?? 0) + 1;
    let result = null, upstreamStatus = null, outage = false;
    try { result = await this.store.memoryService.reindexEvidenceResource(session.projectId, index, { signal: this.abort.signal }); }
    catch (error) {
      if (this.abort.signal.aborted) return;
      upstreamStatus = Number.isInteger(error.upstreamStatus) ? error.upstreamStatus : null;
      // The rebuild itself may fail for this document; it is an outage only when the service's status fails too.
      outage = serviceOutage(error) && !await this.store.memoryService.reachable(session.projectId, { signal: this.abort.signal });
      if (this.abort.signal.aborted) return;
    }
    if (outage) { patch({ verify: { ...later, status: 'reindex_unreachable' } }); return; }
    const reindex = { attempts, at: timestamp(), ...(result ? { receipt: result } : {}), ...(upstreamStatus ? { upstreamStatus } : {}) };
    if (result?.complete) { patch({ status: 'completed', code: null, receipt, indexing: { status: 'complete', reindexed: true, at: reindex.at }, reindex, verify: verified }); return; }
    // A busy rebuild of the same URI (409), a timeout or a rate limit is retried; any other 4xx is a refusal.
    const refused = upstreamStatus >= 400 && upstreamStatus < 500 && ![408, 409, 429].includes(upstreamStatus);
    if (refused || attempts >= REINDEX_LIMIT) { patch({ status: 'completed', code: 'MEMORY_EVIDENCE_INDEX_INCOMPLETE', receipt, indexing: { status: 'incomplete', reason: refused ? 'reindex_refused' : 'reindex_exhausted', at: reindex.at }, reindex, verify: verified }); return; }
    patch({ reindex, verify: { ...later, status: 'reindex_incomplete' } });
  }
  /** A delivery document whose cleanup was stopped because its source came back (B4), checked read-only: the exact
   * content is still there → 'completed' again with its original receipt; confirmed absent (the DELETE took effect)
   * → written again at the same URI; another scope → settled; other content → settled once it keeps differing. */
  async restoreCleanedIndex(sessionId, index, { patch, replace, fresh, nextCheck }) {
    const checks = (index.cleanup.restoreChecks ?? 0) + 1, target = { ...index, contentHash: index.contentHash ?? index.receipt?.contentHash, userId: index.userId ?? index.receipt?.userId };
    let found; try { found = await this.store.memoryService.verifyEvidenceWrite(this.store.state.sessions.find(row => row.id === sessionId).projectId, target, { signal: this.abort.signal }); }
    catch { if (this.abort.signal.aborted) return; patch({ cleanup: { ...index.cleanup, restoreChecks: checks, nextCheckAt: nextCheck(checks) } }); return; }
    const { cleanup, ...rest } = index, at = timestamp();
    const cleanupHistory = [...(index.cleanupHistory ?? []), { ...cleanup, status: 'stopped', outcome: found.state, stoppedAt: at }].slice(-5);
    if (found.state === 'matches') replace({ ...rest, status: 'completed', code: indexIncomplete({ ...rest, status: 'completed' }) ? 'MEMORY_EVIDENCE_INDEX_INCOMPLETE' : null, confirmedRejected: false, cleanupHistory, verify: { checks, status: 'verified', at, reconciliation: found.reconciliation } });
    else if (found.state === 'missing') replace(fresh('source_restored_after_cleanup', { cleanupHistory }));
    else if (found.state === 'scope_changed') replace({ ...rest, status: 'failed', code: 'MEMORY_EVIDENCE_SCOPE_CHANGED', cleanupHistory, verify: { checks, status: found.state, at } });
    else if (checks >= DIFFERS_LIMIT) replace({ ...rest, status: 'failed', code: 'MEMORY_EVIDENCE_CONTENT_DIFFERS', contentDiffers: true, cleanupHistory, verify: { checks, status: found.state, at, reconciliation: found.reconciliation } });
    else patch({ cleanup: { ...index.cleanup, restoreChecks: checks, nextCheckAt: nextCheck(checks) } });
  }
  async advance(sessionId, turnId, checkpointId = null, evidenceId = null) {
    if (this.store.state.sessions.find(row => row.id === sessionId)?.appRecovery?.required) return;
    const session = this.store.state.sessions.find(session => session.id === sessionId), turn = session?.turns.find(turn => turn.id === turnId);
    if (!session || !turn && !evidenceId) return;
    const latest = () => { const session = this.store.state.sessions.find(session => session.id === sessionId), turn = session?.turns.find(turn => turn.id === turnId); return evidenceId ? session?.memoryEvidenceOutbox?.find(row => row.id === evidenceId) : checkpointId ? turn?.memoryCheckpoints?.find(row => row.id === checkpointId) : turn?.memoryWrite; };
    const patch = value => this.patch(sessionId, turnId, value, checkpointId, evidenceId);
    let write = latest();
    if (!write) return;
    // A re-extraction that covers retained segments uploads them first (B2); every other record uploads its own
    // messages. A remote session keeps the message list it was started with: one started by a version that uploaded
    // only the record's own messages (a rollback mid-way) goes on with those, so the cursor never points elsewhere.
    const currentTurn = () => this.store.state.sessions.find(row => row.id === sessionId)?.turns.find(row => row.id === turnId) ?? turn;
    let covered = !evidenceId && Array.isArray(write.reextract?.covers) && write.reextract.covers.length > 0;
    if (covered && write.sessionId && Number.isInteger(write.messageCount)) {
      try { covered = reextractMessagesOf(this.store.state.sessions.find(row => row.id === sessionId), currentTurn(), write).length === write.messageCount; } catch { /* the source check below reports it */ }
    }
    const sourceMessages = () => {
      if (evidenceId) return memoryEvidenceMessages(this.store.state, sessionId, write);
      const current = this.store.state.sessions.find(row => row.id === sessionId);
      return covered ? reextractMessagesOf(current, currentTurn(), write) : memoryMessagesOf(current, turn, write);
    };
    if (transient.has(write.status)) {
      // The stage and when it was sent decide how the reconciliation settles it (B3).
      // Records sent before the dispatch time was kept have no proof window (stageAt null).
      patch({ status: 'uncertain', code: 'MEMORY_WRITE_OUTCOME_UNKNOWN', stage: write.status, stageAt: write.stageAt ?? null, message: '上次记忆请求没有持久回执，需核对远端会话；系统不会重复上传或提交。' }); return;
    }
    const service = this.store.memoryService;
    let stage = write.status;
    // Closing never cuts a request that was already sent (B3): its bounded response is awaited and recorded, as a
    // drain does. Anything not yet sent is aborted.
    const { signal, dispose } = this.requestSignal(() => transient.has(stage)), dispatchTime = () => new Date(this.now()).toISOString(), stageAt = () => latest()?.stageAt ?? null;
    const guard = (mutation = true) => {
      this.abort.signal.throwIfAborted();
      const current = this.store.state.sessions.find(row => row.id === sessionId), project = this.store.state.projects.find(row => row.id === session.projectId);
      if (this.closed || !current || !project || this.drainingSessions.has(sessionId) || mutation && (current.archivedAt || project.archivedAt || this.store.state.emergency || this.store.state.configuration.memory.autoStore === false)) throw Object.assign(new Error('Memory synchronization paused'), { code: 'MEMORY_SYNC_PAUSED' });
      if (write.connectionFingerprint && service.connectionFingerprint(session.projectId) !== write.connectionFingerprint) throw Object.assign(new Error('Memory connection changed'), { code: 'MEMORY_CONNECTION_CHANGED' });
    };
    try {
      guard(write.status !== 'polling');
      if (write.status === 'polling') {
        let receipt;
        try { receipt = await service.sessionTask(session.projectId, write.sessionId, write.taskId, { signal }); }
        catch (error) {
          // OpenViking keeps a finished task for a limited time (24 h completed, 7 d failed); its archive's markers stay.
          if (error.upstreamStatus === 404 && error.upstreamCode === 'NOT_FOUND') { await this.settleFromArchive(session, write, patch, signal); return; }
          throw error;
        }
        const task = receipt.result, status = task?.status;
        if (status === 'completed') {
          const counts = task.result?.memories_extracted ?? {};
          patch({ ...acknowledged, ...archiveProvenance(write, receipt), status: 'completed', taskStatus: status, memoriesExtracted: Object.values(counts).reduce((sum, count) => sum + (Number.isFinite(count) && count > 0 ? count : 0), 0), extractionCounts: counts, tokenUsage: task.result?.token_usage ?? null, nextPollAt: null, message: '对话已归档，记忆抽取任务已完成；抽取数量以服务回执为准。' });
        } else if (['failed', 'cancelled'].includes(status)) patch({ ...archiveProvenance(write, receipt), status: 'failed', taskStatus: status, code: 'MEMORY_EXTRACTION_FAILED', tokenUsage: task.result?.token_usage ?? null, nextPollAt: null, message: '对话已归档，但远端记忆抽取未成功；没有自动重复付费提取。' });
        else if (['pending', 'running', 'cancelling'].includes(status)) patch({ ...acknowledged, taskStatus: status, nextPollAt: this.now() + this.pollMs });
        else throw new Error('Unknown task status');
        return;
      }
      const messages = sourceMessages(), hash = digest(messages);
      if (!messages.length && write.kind !== 'final' || !evidenceId && !checkpointId && !messages.some(message => message.role === 'user')) { patch({ status: 'skipped', code: 'NO_USER_MESSAGES' }); return; }
      // A covering re-extraction checked each segment against its own frozen hash; its record keeps its own hash.
      if (write.sourceHash && !covered && write.sourceHash !== hash) { patch({ status: 'uncertain', code: 'MEMORY_SOURCE_CHANGED', message: '待同步的对话内容发生变化，需核对已上传部分后再继续。' }); return; }
      // A re-extraction the user asked for goes to a fresh remote session as a full archive.
      if (checkpointId && !write.sessionId && !write.reextract) {
        const records = turn.memoryCheckpoints ?? [], index = records.findIndex(row => row.id === checkpointId);
        const previous = records.slice(0, index).findLast(row => row.sessionId);
        if (previous) {
          // A single remote session preserves OpenViking's previous archive
          // overview/working memory without uploading earlier messages again.
          // The pump admits this segment only after every predecessor settled.
          if (previous.connectionFingerprint !== write.connectionFingerprint) throw Object.assign(new Error('Memory connection changed'), { code: 'MEMORY_CONNECTION_CHANGED' });
          patch({ sessionId: previous.sessionId }); write = latest();
        }
      }
      if (!write.sessionId) {
        await service.identity(service.remote(session.projectId), { signal });
        guard();
        patch({ ...(covered ? {} : { sourceHash: hash }), nextMessage: 0, messageCount: messages.length });
        // Working memory only where a later commit in this remote session reads it: a turn's incremental checkpoints
        // (their turn-budget retention). A single commit — a turn without checkpoints, an answered card, a
        // re-extraction into a fresh session — never reads it.
        const workingMemory = Boolean(checkpointId && write.kind === 'incremental' && !write.reextract);
        // D5: the turn this archive belongs to rides on the remote session (events it extracts are tagged with it).
        const binding = await service.createSession(session.projectId, { sourceSessionId: sessionId, ...(turnId && !evidenceId ? { turnId } : {}), workingMemory, signal, onPrepared: binding => patch({ sessionId: binding.sessionId }), onDispatch: () => { guard(); stage = 'creating'; patch({ status: stage, stageAt: dispatchTime() }); } });
        patch({ ...acknowledged, status: 'ready', sessionId: binding.sessionId, nextPollAt: null });
        stage = 'ready';
      }
      guard(); write = latest();
      while ((write.nextMessage ?? 0) < messages.length) {
        guard();
        // A queued immutable source may be edited/removed during network IO.
        // Never upload its old snapshot or silently enroll changed text again.
        sourceMessages();
        const start = write.nextMessage ?? 0, batch = []; let size = 0;
        for (const message of messages.slice(start)) { const length = JSON.stringify(message).length; if (batch.length && (size + length > 45000 || batch.length >= 50)) break; batch.push(message); size += length; }
        await service.sessionMessages(session.projectId, write.sessionId, { messages: batch, signal, onDispatch: () => { guard(); sourceMessages(); stage = 'uploading'; patch({ status: stage, batchStart: start, batchCount: batch.length, stageAt: dispatchTime() }); } });
        patch({ ...acknowledged, status: 'ready', nextMessage: start + batch.length, nextPollAt: null });
        stage = 'ready';
        guard(); write = latest();
      }
      guard();
      sourceMessages();
      const incremental = Boolean(checkpointId && write.kind === 'incremental' && !write.reextract);
      const committed = await service.sessionCommit(session.projectId, write.sessionId, { signal, checkpoint: incremental, onDispatch: () => { guard(); sourceMessages(); stage = 'committing'; patch({ status: stage, stageAt: dispatchTime() }); } });
      const retentionReceipt = checkpointId ? { retainedEstimatedTokens: Number.isFinite(committed.result?.estimated_active_tokens) ? committed.result.estimated_active_tokens : null, retentionBudgetExceeded: typeof committed.result?.budget_exceeded === 'boolean' ? committed.result.budget_exceeded : null } : {};
      if (committed.result?.task_id) patch({ ...acknowledged, ...retentionReceipt, status: 'polling', taskId: committed.result.task_id, archived: committed.result.archived === true, ...(committed.archiveUri ? { archiveUri: committed.archiveUri } : {}), nextPollAt: this.now() + this.pollMs, message: '对话已提交，正在等待真实记忆抽取。' });
      else if (committed.result?.status === 'skipped' && committed.result?.archived === false) {
        const retained = incremental && committed.result?.reason === 'all_within_keep_window';
        patch({ ...acknowledged, ...retentionReceipt, status: retained ? 'retained' : 'skipped', code: retained ? 'MEMORY_RETAINED_FOR_NEXT_COMMIT' : 'MEMORY_COMMIT_SKIPPED', message: retained ? '新增对话已同步，暂保留在远端活动上下文；尚未抽取新记忆。' : '服务没有产生新的归档或抽取任务。' });
      }
      else patch({ status: 'uncertain', code: 'MEMORY_COMMIT_RECEIPT_INCOMPLETE', stage: 'committing', stageAt: stageAt(), message: '提交回执缺少可跟踪的提取任务；未将其标记为记忆已保存。' });
    } catch (error) {
      if ((error.code === 'MEMORY_SYNC_PAUSED' || this.abort.signal.aborted || signal.aborted || this.closed) && !transient.has(stage)) return;
      if (error.code === 'MEMORY_SOURCE_CHANGED') {
        // Raised only before the next request is sent, so what reached the service is known (MEM-5): uploaded
        // messages that will never be committed, or nothing at all.
        const current = latest() ?? write;
        if (current?.supersededBy && !current.nextMessage && !current.batchCount && !current.taskId && !transient.has(stage)) {
          // Superseded by its own settled text before anything was sent (MEM-3): nothing to reconcile.
          patch({ status: 'skipped', code: 'MEMORY_EVIDENCE_SUPERSEDED', message: null });
        } else if ((current.nextMessage ?? 0) > 0) patch({ status: 'abandoned', code: error.code, nextPollAt: null, message: '对话在上传途中被修改或撤回；已上传的部分不会提交，也不会从中提炼记忆。' });
        else if (this.sourceWithdrawn(sessionId, turnId, current, evidenceId)) {
          const index = evidenceId && current.resourceIndex && !current.resourceIndex.dispatchedAt && current.resourceIndex.status === 'pending' ? { resourceIndex: { ...current.resourceIndex, status: 'skipped', code: 'MEMORY_SOURCE_WITHDRAWN', updatedAt: timestamp() } } : {};
          patch({ status: 'skipped', code: 'MEMORY_SOURCE_WITHDRAWN', nextPollAt: null, message: '内容在同步前已撤回，没有上传。', ...index });
        } else patch({ status: 'uncertain', code: error.code, message: '待同步的对话内容发生变化，需核对已上传部分后再继续；未重新提取或重传。' });
      } else if (error.code === 'MEMORY_CONNECTION_CHANGED') {
        patch({ status: 'failed', code: error.code, message: '记忆连接、凭据或项目范围已改变；旧同步记录没有发送到新服务。' });
      } else if (stage === 'pending' || stage === 'ready' && error.status !== 409 && error.status !== 403) {
        const failures = (write.pollFailures ?? 0) + 1;
        patch({ status: stage, pollFailures: failures, nextPollAt: this.now() + Math.min(300000, this.pollMs * 2 ** Math.min(failures, 5)), code: 'MEMORY_CONNECTION_UNAVAILABLE', message: '记忆服务暂不可用；已确认的进度保留，稍后重试尚未发出的请求。' });
      } else if (stage === 'polling') {
        const failures = (write.pollFailures ?? 0) + 1;
        patch({ status: 'polling', pollFailures: failures, nextPollAt: this.now() + Math.min(300000, this.pollMs * 2 ** Math.min(failures, 5)), code: 'MEMORY_TASK_LOOKUP_FAILED', message: '记忆任务状态暂不可查询，稍后继续核对；没有重复提交。' });
      } else {
        // HTTP 4xx is a known rejection. Transport errors and 5xx may occur
        // after acceptance; source_message_ids is provenance, NOT idempotency.
        const rejected = error.upstreamStatus >= 400 && error.upstreamStatus < 500 || error.status === 409 || error.status === 403;
        patch({ status: rejected ? 'failed' : 'uncertain', code: rejected ? 'MEMORY_WRITE_REJECTED' : 'MEMORY_WRITE_OUTCOME_UNKNOWN', stage, ...(rejected ? {} : { stageAt: stageAt() }), ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}), message: rejected ? '记忆服务拒绝了同步请求；对话仍保留，未重复发送。' : '记忆同步请求的结果尚不能确认；对话仍保留，系统不会盲目重复上传或提交。' });
      }
    } finally { dispose(); }
  }
  /**
   * A polled task OpenViking no longer has (NOT_FOUND: completed tasks are kept 24 h, failed ones 7 d) is settled from
   * its archive, read-only, the way OpenViking's own pi client does (DESIGN.md "Runtime flow" 6; Session.
   * _archive_terminal_state): `.done`, written last once phase 2 completed → completed; `.failed.json` → the extraction
   * failed (a paid re-extraction stays optional). Only with no archive recorded (a commit from before A2) or neither
   * marker present does it stay "cannot tell" (MEMORY_TASK_EXPIRED). A lookup that fails throws: the caller retries it
   * like a failed task poll. How many memories a marker-settled archive produced is not known (the count lived in the
   * task result); its memory diff is recorded when the archive has one.
   */
  async settleFromArchive(session, write, patch, signal) {
    const expired = { taskStatus: 'task_expired', pollFailures: 0, nextPollAt: null };
    if (!write.archiveUri) { patch({ ...expired, status: 'failed', code: 'MEMORY_TASK_EXPIRED', message: '对话已归档，但提炼任务在读取结果前已过期；无法确认是否提炼出记忆，不会自动重做。' }); return; }
    const archive = await this.store.memoryService.archiveState(session.projectId, write.sessionId, write.archiveUri, { signal });
    const settledBy = { marker: archive.marker ?? null, state: archive.state, at: archive.checkedAt, ...(Object.hasOwn(archive, 'memoryChanges') ? { memoryChanges: archive.memoryChanges } : {}) };
    if (archive.state === 'completed') patch({ ...acknowledged, ...expired, status: 'completed', settledBy, ...(archive.memoryDiffUri && !write.memoryDiffUri ? { memoryDiffUri: archive.memoryDiffUri } : {}), message: '对话已归档，记忆抽取已完成（按归档完成标记核对）。' });
    else if (archive.state === 'failed') patch({ ...expired, status: 'failed', code: 'MEMORY_EXTRACTION_FAILED', settledBy, message: '对话已归档，但远端记忆抽取未成功（按归档失败标记核对）；没有自动重复付费提取。' });
    else patch({ ...expired, status: 'failed', code: 'MEMORY_TASK_EXPIRED', settledBy, message: '对话已归档，但提炼任务在读取结果前已过期，归档也没有完成或失败标记；无法确认是否提炼出记忆，不会自动重做。' });
  }
  /** A signal for one record's requests: closing aborts it unless a request is in flight (`inFlight()`), whose bounded
   * response is then awaited instead (B3). Every later step checks `this.closed` before it sends anything. */
  requestSignal(inFlight) {
    const controller = new AbortController(), stop = () => { if (!inFlight()) controller.abort(this.abort.signal.reason); };
    if (this.abort.signal.aborted) controller.abort(this.abort.signal.reason);
    else this.abort.signal.addEventListener('abort', stop, { once: true });
    return { signal: controller.signal, dispose: () => this.abort.signal.removeEventListener('abort', stop) };
  }
  /**
   * Settle a write left 'uncertain' by a request whose receipt was lost (B3), by what the stage proves and, for a
   * commit, by a read-only look at the remote session's commit tasks. Nothing is uploaded or committed here.
   * - creating: nothing of the record was sent, so it starts again in a fresh remote session (the old one, empty or
   *   never created, stays bound for deletion).
   * - uploading: the batch may or may not have been appended; uncommitted messages are never extracted → abandoned.
   * - committing: a commit task no record holds is this commit → adopted and polled. A complete listing without one,
   *   within the window OpenViking keeps finished tasks, proves it never archived: an incremental segment's messages
   *   stay in the live context for the next commit ('retained'); anything else is a known loss that can be extracted
   *   again (MEMORY_COMMIT_NOT_FOUND). Outside that window, with several unknown tasks, or once the remote can no longer
   *   be checked, the outcome cannot be determined: it is settled as such, for the user to acknowledge.
   */
  async reconcile(sessionId, turnId, checkpointId = null, evidenceId = null) {
    const latest = () => { const session = this.store.state.sessions.find(row => row.id === sessionId), turn = session?.turns.find(row => row.id === turnId); return evidenceId ? session?.memoryEvidenceOutbox?.find(row => row.id === evidenceId) : checkpointId ? turn?.memoryCheckpoints?.find(row => row.id === checkpointId) : turn?.memoryWrite; };
    const session = this.store.state.sessions.find(row => row.id === sessionId), write = latest();
    if (!session || session.appRecovery?.required || !reconcilableWrite(write)) return;
    const patch = value => this.patch(sessionId, turnId, value, checkpointId, evidenceId);
    const stage = uncertainStage(write), checks = (write.reconcile?.checks ?? 0) + 1, at = new Date(this.now()).toISOString();
    const outcome = (result, extra = {}) => ({ checks, stage, result, previousCode: write.code, at, ...extra });
    const undeterminable = result => patch({ reconcile: { status: 'undeterminable', ...outcome(result) }, nextPollAt: null });
    if (stage === 'creating') {
      patch({ status: 'pending', code: null, message: null, stage: null, sessionId: undefined, nextMessage: 0, nextPollAt: null, pollFailures: 0, upstreamStatus: null,
        reconcile: { status: 'settled', ...outcome('restarted_in_fresh_session', { previousSessionId: write.sessionId ?? null }) } });
      return;
    }
    if (stage === 'uploading') {
      patch({ status: 'abandoned', code: 'MEMORY_UPLOAD_UNCONFIRMED', nextPollAt: null, message: '上传这一段时没有收到确认；已上传的部分不会提交，也不会从中提炼记忆。',
        reconcile: { status: 'settled', ...outcome('upload_unconfirmed') } });
      return;
    }
    const since = Date.parse(write.stageAt ?? '');
    if (Number.isFinite(since) && this.now() < since + COMMIT_SETTLE_MS) { patch({ reconcile: { status: 'waiting', checks: write.reconcile?.checks ?? 0, nextCheckAt: since + COMMIT_SETTLE_MS } }); return; }
    if (typeof write.sessionId !== 'string' || !write.sessionId) { undeterminable('no_remote_session'); return; }
    const service = this.store.memoryService;
    let listing;
    try {
      if (write.connectionFingerprint && service.connectionFingerprint(session.projectId) !== write.connectionFingerprint) { undeterminable('connection_changed'); return; }
      listing = await service.sessionCommitTasks(session.projectId, write.sessionId, { signal: this.abort.signal });
    } catch (error) {
      if (this.abort.signal.aborted) return;
      // The binding or the authenticated identity no longer matches: this session can never be checked again.
      if ([403, 404, 409].includes(error.status) || error.upstreamStatus >= 400 && error.upstreamStatus < 500) { undeterminable('remote_unverifiable'); return; }
      if (checks >= RECONCILE_LIMIT) { undeterminable('remote_unreachable'); return; }
      patch({ reconcile: { status: 'unreachable', checks, at, nextCheckAt: this.now() + backoff(this.pollMs, checks) } }); return;
    }
    // Every task id a record of this remote session holds, current or replaced by a re-extraction.
    const claimed = new Set();
    for (const row of this.store.state.sessions) if (row.projectId === session.projectId)
      for (const record of [...row.turns.flatMap(turn => memoryWriteRecords(turn).map(entry => entry.write)), ...(row.memoryEvidenceOutbox ?? [])]) {
        if (record?.sessionId === write.sessionId && typeof record.taskId === 'string') claimed.add(record.taskId);
        for (const previous of record?.reextract?.previous ?? []) if (previous.sessionId === write.sessionId && typeof previous.taskId === 'string') claimed.add(previous.taskId);
      }
    const unknown = listing.tasks.filter(task => !claimed.has(task.taskId));
    if (unknown.length === 1) {
      const [{ taskId }] = unknown;
      service.updateSessionBinding(session.projectId, write.sessionId, binding => { binding.taskIds ??= []; if (!binding.taskIds.includes(taskId)) binding.taskIds.push(taskId); });
      patch({ ...acknowledged, status: 'polling', taskId, archived: true, nextPollAt: this.now(), message: '核对到这次提交已被接受，正在等待记忆抽取结果。', reconcile: { status: 'settled', ...outcome('commit_found', { taskId }) } });
      return;
    }
    if (unknown.length > 1) { undeterminable('commit_ambiguous'); return; }
    if (!Number.isFinite(since) || this.now() >= since + COMMIT_PROOF_MS) { undeterminable('commit_not_provable'); return; }
    if (checkpointId && write.kind === 'incremental' && !write.reextract) {
      patch({ ...acknowledged, status: 'retained', code: 'MEMORY_RETAINED_FOR_NEXT_COMMIT', message: '核对确认这一段没有归档，仍保留在远端活动上下文，由下一次提交一并归档。', reconcile: { status: 'settled', ...outcome('commit_not_found') } });
      return;
    }
    patch({ status: 'failed', code: 'MEMORY_COMMIT_NOT_FOUND', nextPollAt: null, message: '核对确认这一段已上传但没有归档，也没有提炼记忆。', reconcile: { status: 'settled', ...outcome('commit_not_found') } });
  }
  /** The source of a record is gone (its conversation, turn or items removed or privacy-scrubbed), as opposed to
   * still there with different text. */
  sourceWithdrawn(sessionId, turnId, write, evidenceId) {
    if (evidenceId) return memoryEvidenceWithdrawn(this.store.state, sessionId, write);
    const session = this.store.state.sessions.find(row => row.id === sessionId), turn = session?.turns.find(row => row.id === turnId);
    if (!turn) return true;
    const present = id => session.items.some(item => item.id === id && !item.sourceDeleted && !item.deletedAt && !item.contextRevoked);
    return Array.isArray(write.sourceRefs) ? write.sourceRefs.some(ref => !present(ref.itemId)) : !session.items.some(item => item.turnId === turnId && present(item.id));
  }
  /** Hold a conversation's memory writes while it is deleted or rewound. Each drain is released by the session
   * disappearing (deletion) or by resumeSession (a rewind, once its mutation is done); holds are counted, so one
   * caller's release cannot reopen a conversation another caller still holds. */
  async drainSession(sessionId) {
    this.drainingSessions.add(sessionId); this.drainHolds.set(sessionId, (this.drainHolds.get(sessionId) ?? 0) + 1);
    // Do not abort already dispatched writes: consume their bounded response
    // and retain create/commit receipts in the durable deletion record.
    await Promise.allSettled([...this.running].filter(([turnId]) => this.runningSessions.get(turnId) === sessionId).map(([, job]) => job));
    if (!this.store.state.sessions.some(session => session.id === sessionId)) { this.drainingSessions.delete(sessionId); this.drainHolds.delete(sessionId); }
  }
  resumeSession(sessionId) {
    const holds = (this.drainHolds.get(sessionId) ?? 1) - 1;
    if (holds > 0) { this.drainHolds.set(sessionId, holds); return; }
    this.drainHolds.delete(sessionId); this.drainingSessions.delete(sessionId);
  }
  async close() { this.closed = true; this.unsubscribe?.(); this.abort.abort(); await Promise.allSettled([...this.running.values(), this.summarySync.close()]); }
}
