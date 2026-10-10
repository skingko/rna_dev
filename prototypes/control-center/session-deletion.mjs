import { lstatSync, rmSync } from 'node:fs';
import { purgeEffortCaptures } from './internal-reasoning.mjs';
import { purgeProbeSummaries } from './benchmark/compaction-fork-probe.mjs';
import { purgeScheduleReplayReports } from './benchmark/schedule-text-replay.mjs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { syncDirectory } from './durable-files.mjs';
import { captureSessionEvidence, discoverSessionEvidence, scrubSessionEvidence, purgeSessionEvidenceFiles, removableEntry, removeBlockedEntry, rebuiltSessionEvidence } from './session-evidence-cleanup.mjs';
import { memoryWriteRecords } from './memory-checkpoints.mjs';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';
import { EVIDENCE_WRITE_DEADLINE_MS } from './memory-service.mjs';
import { removeProjectRunFiles } from './project-files.mjs';
import { LIMITS, isSecretPath } from './git-isolation/contract.mjs';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
const stamp = () => new Date().toISOString();
const fail = code => { throw Object.assign(new Error(code), { code }); };
const errorCode = (error, fallback) => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : fallback;

/**
 * Blockers that never clear on their own (review X-1): the record moves to `blocked` ("needs your decision") and
 * waits for the user, or for a change in what blocked it, instead of backing off forever as if the service were
 * down. The value groups codes that share one explanation. Everything else (the memory service unreachable, a writer
 * still settling, a file changing while read, an evidence write inside its deadline) is retried on a timer.
 */
export const DECISION_CODES = Object.freeze({
  SESSION_BACKGROUND_EXECUTION_UNCONFIRMED: 'execution',
  SESSION_EVIDENCE_READ_LIMIT: 'too_large',
  SESSION_EVIDENCE_STORAGE_UNSAFE: 'unsafe', SESSION_STORAGE_ROOT_UNSAFE: 'unsafe',
  SESSION_EVIDENCE_JOURNAL_UNKNOWN: 'damaged', SESSION_EVIDENCE_JOURNAL_INVALID: 'damaged', SESSION_EVIDENCE_JOURNAL_IDENTITY: 'damaged', SESSION_EVIDENCE_ARCHIVE_UNKNOWN: 'damaged', SESSION_EVIDENCE_ARCHIVE_INVALID: 'damaged',
  SESSION_EVIDENCE_CONTEXT_INVALID: 'damaged', SESSION_EVIDENCE_IDENTITY_INVALID: 'damaged', SESSION_EVIDENCE_CAPTURE_MISSING: 'damaged', INVALID_SESSION_ID: 'damaged',
  MEMORY_CLEANUP_CONNECTION_CHANGED: 'memory_changed', MEMORY_CLEANUP_IDENTITY_CHANGED: 'memory_changed', MEMORY_EVIDENCE_SCOPE_CHANGED: 'memory_changed',
  MEMORY_CLEANUP_IDENTITY_UNVERIFIED: 'memory_mismatch', MEMORY_EVIDENCE_IDENTITY_UNVERIFIED: 'memory_mismatch', MEMORY_CLEANUP_TASK_IDENTITY_UNVERIFIED: 'memory_mismatch', MEMORY_CLEANUP_AUTOCOMMIT_ACTIVE: 'memory_mismatch',
  MEMORY_EVIDENCE_CONTENT_DIFFERS: 'memory_differs',
});
/**
 * The decision a blocked record offers the user (review D2-3), one per record, taken through
 * POST /api/session-deletions/:id/decide { choice }:
 * - `release_runs` (execution): delete the unconfirmed runs' records without confirming their outcome;
 * - `remove_entry` (too_large, unsafe, damaged): remove the one run record cleanup cannot read, without reading it
 *   (a link is removed itself, never what it points to);
 * - `read_all` (too_large, the limit of one pass): read every record this time;
 * - `rebuild` (damaged, the deletion record itself): capture the conversation's evidence again from its identity;
 * - `keep_remote` (memory_*): leave the remote records that cannot be confirmed, and finish.
 * null: nothing to decide in the app (a link in place of a whole run records folder is fixed by the user, then retried).
 */
export const DELETION_CHOICES = Object.freeze(['release_runs', 'remove_entry', 'read_all', 'rebuild', 'keep_remote']);
export function deletionChoice(record) {
  if (record?.status !== 'blocked') return null;
  const group = DECISION_CODES[record.code];
  if (group === 'execution') return Array.isArray(record.blockedActionIds) && record.blockedActionIds.some(safeId) ? 'release_runs' : null;
  if (['memory_changed', 'memory_mismatch', 'memory_differs'].includes(group)) return 'keep_remote';
  if (group === 'too_large' && record.blockedLimit === 'cumulative') return 'read_all';
  if (['too_large', 'unsafe', 'damaged'].includes(group) && removableEntry(record.blockedEntry)) return 'remove_entry';
  if (group === 'damaged' && record.blockedScope === 'record') return 'rebuild';
  return null;
}
// What each blocked record says, by its decision group and the choice it offers (the button's words are quoted).
const DECISION_TEXT = {
  execution: {
    release_runs: { zh: '一项后台工作有一步操作没能确认是否完成，它的运行记录要等你核对后才能删除。请在项目的后台工作里确认它的结果，确认后清理会自动继续；也可以点“不核对，直接删除”，运行记录随对话删除，那一步是否完成将无法再核对。', en: 'A background task has a step whose outcome was never confirmed, and its run record is kept until you check it. Confirm its result in the project’s background work; cleanup then continues on its own. Or choose “Delete without checking”: the run record goes with the conversation, and that step can no longer be checked.' },
    null: { zh: '一项后台工作有一步操作没能确认是否完成，它的运行记录要等你核对后才能删除。请在项目的后台工作里确认它的结果，确认后清理会自动继续。', en: 'A background task has a step whose outcome was never confirmed, and its run record is kept until you check it. Confirm its result in the project’s background work; cleanup then continues on its own.' },
  },
  too_large: {
    remove_entry: { zh: '有一份运行记录超出了清理能安全读取的大小，无法核对它是否属于这个对话。点“删除这份记录”会不读取直接删除它，然后继续清理。', en: 'A run record is larger than cleanup can safely read, so it cannot be checked against this conversation. “Delete this record” removes it without reading it, then cleanup continues.' },
    read_all: { zh: '这个项目的运行记录总量超出了清理一次能读取的上限。点“全部读取”会在这次清理中不设总量上限，读完后继续清理（可能需要一些时间）。', en: 'This project’s run records are more than cleanup reads in one pass. “Read them all” lifts that limit for this cleanup and continues (it may take a while).' },
    null: { zh: '有一份运行记录超出了清理能安全读取的大小，无法核对，所以没有删除。', en: 'A run record is larger than cleanup can safely read, so it could not be checked and was not deleted.' },
  },
  unsafe: {
    remove_entry: { zh: '运行记录的文件夹里有链接，或有在别处也被引用的文件，清理不会顺着它们删除。点“删除这份记录”只删除这一个链接或文件名本身（它指向的内容不受影响），然后继续清理。', en: 'The run records folder contains a link, or a file that is also linked from elsewhere; cleanup does not follow them. “Delete this record” removes only that one link or file name (what it points to is untouched), then cleanup continues.' },
    null: { zh: '运行记录的文件夹里有链接，或有在别处也被引用的文件，清理不会顺着它们删除。检查这个文件夹后再点“重试清理”。', en: 'The run records folder contains a link, or a file that is also linked from elsewhere; cleanup does not follow them. Check the folder, then retry the cleanup.' },
  },
  damaged: {
    remove_entry: { zh: '有运行记录或归档已损坏或无法识别，清理无法确认它属于哪个对话。点“删除这份记录”会不读取直接删除它，然后继续清理。', en: 'A run record or archive is damaged or unrecognized, so cleanup cannot tell which conversation it belongs to. “Delete this record” removes it without reading it, then cleanup continues.' },
    rebuild: { zh: '这次删除的清理记录已损坏。点“重建清理记录”会按这个对话的标识重新查找相关数据，然后继续清理。', en: 'This deletion’s cleanup record is damaged. “Rebuild the record” looks up the conversation’s data again by its identity, then cleanup continues.' },
    null: { zh: '有运行记录或归档已损坏或无法识别，清理无法确认它属于哪个对话，所以没有删除。', en: 'A run record or archive is damaged or unrecognized, so cleanup cannot tell which conversation it belongs to and did not delete it.' },
  },
  memory_changed: { keep_remote: { zh: '记忆服务的地址、密钥或账号在删除之后变了，无法确认远端记录属于这次删除。恢复原来的记忆服务设置后会自动继续；也可以点“保留远端记录”，不再删除它们，结束这次清理。', en: 'The memory service address, key or account changed after the deletion, so the remote records cannot be confirmed as this conversation’s. Restore the earlier memory settings and cleanup continues on its own, or choose “Keep the remote records” to stop deleting them and finish.' } },
  memory_mismatch: { keep_remote: { zh: '远端的对话记录与删除时记下的身份对不上，所以没有删除。点“保留远端记录”会不再删除它，结束这次清理。', en: 'The remote conversation record does not match the identity recorded at deletion, so it was not deleted. “Keep the remote records” stops trying to delete it and finishes the cleanup.' } },
  memory_differs: { keep_remote: { zh: '远端的一份证据文件已不是当初写入的内容，无法确认归属，所以没有删除。点“保留远端记录”会不再删除它，结束这次清理。', en: 'A remote evidence file no longer holds what was written, so it cannot be confirmed as this conversation’s and was not deleted. “Keep the remote records” stops trying to delete it and finishes the cleanup.' } },
};
/**
 * The explanation of a blocked cleanup in the interface language (null for a code that is not a decision): `record`
 * (or a code alone) — with a record, the text names the decision it offers.
 */
export function deletionDecisionText(record, language) {
  const row = typeof record === 'string' ? { code: record } : record, group = DECISION_CODES[row?.code];
  if (!group) return null;
  const texts = DECISION_TEXT[group], choice = typeof record === 'string' ? null : deletionChoice(row);
  return inLanguage(language, texts[choice] ?? texts.null ?? Object.values(texts)[0]);
}
const hashOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/**
 * What a blocked record waits on (review D2-1, X6, D2-5), and nothing else: a change retries it; so do a service start
 * and the user's retry or decision.
 * - execution: the rows of the runs it names (their status and who resolved them);
 * - memory_*: the memory settings and the connection they reach (endpoint, key and namespace, as the fingerprint the
 *   record keeps; the key itself never enters the hash input in clear: `fingerprint` hashes it);
 * - too_large, unsafe, damaged: nothing in state clears them.
 * The project's existence counts for all of them.
 * @param {{ fingerprint?: (projectId: string) => string | null }} [options]
 */
export function blockedKey(state, record, { fingerprint = null } = {}) {
  const project = state.projects?.find(row => row.id === record.projectId), group = DECISION_CODES[record.code] ?? null;
  let waits = group;
  if (group === 'execution') {
    const named = Array.isArray(record.blockedActionIds) && record.blockedActionIds.length ? record.blockedActionIds : [...(record.evidence?.actionIds ?? []), ...(record.evidence?.journalActionIds ?? [])];
    const ids = new Set(named.filter(safeId));
    waits = [...(project?.initiativeRuntime?.sdkState?.actions ?? []), ...(project?.jobs ?? [])].filter(row => ids.has(row?.id)).map(row => [row.id, row.status ?? null, row.resolvedAt ?? null, row.resolutionSource ?? null]);
  } else if (['memory_changed', 'memory_mismatch', 'memory_differs'].includes(group)) {
    let connection = null; try { connection = record.projectId && fingerprint ? fingerprint(record.projectId) ?? null : null; } catch { connection = null; }
    waits = [state.configuration?.memory ?? null, connection];
  }
  return hashOf([Boolean(project), group, waits]);
}
const verifiedResource = row => row?.receipt?.complete === true && row.receipt.contentVerified === true;
// A record leaving `blocked` drops what described its blocker.
const UNBLOCKED = Object.freeze({ blockedAt: undefined, blockedKey: undefined, blockedActionIds: undefined, blockedEntry: undefined, blockedLimit: undefined, blockedScope: undefined });
export function deletionRecord(store, session, state = store.state) {
  if (!safeId(session.id)) fail('INVALID_SESSION_ID');
  const project = state.projects.find(project => project.id === session.projectId);
  const writes = [...session.turns.flatMap(turn => memoryWriteRecords(turn).map(row => row.write)), ...(session.memoryEvidenceOutbox ?? [])];
  const turnRemotes = new Set(writes.map(write => write.sessionId).filter(Boolean));
  const bindings = (project?.memorySessions ?? []).filter(binding => binding.sourceSessionId === session.id || turnRemotes.has(binding.sessionId)).map(binding => structuredClone(binding));
  for (const binding of bindings) if (!Object.hasOwn(binding, 'pendingRequests') && writes.some(write => write.sessionId === binding.sessionId && ['creating', 'uploading', 'committing', 'uncertain'].includes(write.status))) binding.cleanupOutcomeUnknown = true;
  return { sessionId: session.id, projectId: session.projectId ?? null, status: 'pending', createdAt: stamp(),
    localStatus: 'pending', remoteStatus: bindings.length ? 'pending' : 'not_required', bindings, evidence: captureSessionEvidence(state, session),
    evidenceResources: (session.memoryEvidenceOutbox ?? []).filter(write => write.resourceIndex?.dispatchedAt && (!write.resourceIndex.confirmedRejected || write.resourceIndex.receipt?.complete === true && write.resourceIndex.receipt.contentVerified === true) && write.resourceIndex.status !== 'deleted').map(write => ({ ...structuredClone(write.resourceIndex), evidenceId: write.id, sourceHash: write.sourceRefs[0].sourceHash })),
    evidenceResourceRevocations: (session.memoryEvidenceOutbox ?? []).filter(write => write.resourceIndex?.dispatchedAt && (!write.resourceIndex.confirmedRejected || write.resourceIndex.receipt?.complete === true && write.resourceIndex.receipt.contentVerified === true)).map(write => ({ uri: write.resourceIndex.uri, namespace: write.resourceIndex.namespace, sourceHash: write.sourceRefs[0].sourceHash })),
    connectionFingerprint: bindings.length ? store.memoryService.connectionFingerprint(project.id) : null, attempts: 0 };
}
/**
 * Public projection of cleanup receipts (identities and statuses only; never bindings, evidence or URIs). A blocked
 * record also says which decision it waits on (`decision`, a DECISION_CODES group) and why (`notice`, in the
 * interface language).
 */
export function publicSessionDeletions(state) {
  const language = interfaceLanguageOf(state);
  return (state.sessionDeletions ?? []).map(record => { const { sessionId, projectId, status, localStatus, remoteStatus, createdAt, updatedAt, completedAt, code, retryAt, attempts } = record; return { sessionId, projectId: projectId ?? null, status, localStatus, remoteStatus, createdAt: createdAt ?? null, updatedAt: updatedAt ?? null, completedAt: completedAt ?? null, code: code ?? null, retryAt: retryAt ?? null, attempts: Number.isInteger(attempts) ? attempts : 0,
    ...(status === 'blocked' ? blockedView(record, language) : {}) }; });
}
/** A blocked record's `decision` (its DECISION_CODES group), `choice` (what the user can decide, or null) and `notice`. */
function blockedView(record, language) { return { decision: DECISION_CODES[record.code] ?? null, choice: deletionChoice(record), notice: deletionDecisionText(record, language) }; }
export function queueDeletion(state, record) {
  state.sessionDeletions ??= [];
  if (!state.sessionDeletions.some(row => row.sessionId === record.sessionId)) state.sessionDeletions.push(record);
}
export function purgeSessionFiles(stateFile, sessionId) {
  if (!safeId(sessionId)) fail('INVALID_SESSION_ID');
  let removedDirectories = 0;
  // Only app-owned session roots are eligible. Never use workspace, artifact
  // attachment paths or an arbitrary runtime.sessionFile supplied by state.
  for (const suffix of ['.rna', '.pi']) {
    const root = resolve(`${stateFile}${suffix}`), path = resolve(root, sessionId);
    let stat; try { stat = lstatSync(root); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('SESSION_STORAGE_ROOT_UNSAFE');
    try { lstatSync(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    // rm never follows a symlink at this child or inside its tree.
    rmSync(path, { recursive: true, force: true }); syncDirectory(root); removedDirectories++;
  }
  return { removedDirectories };
}

/** Durable deletion receipts contain identities, never conversation text.
 * Writers settle before unlink, preventing late callbacks recreating journals.
 * Unavailable remote storage is reported and retried, never called deleted.
 * A blocker that can never clear on its own (DECISION_CODES) stops the timer
 * and waits, visibly, for the user's decision. */
export class SessionDeletionService {
  /**
   * `sessionWorktrees` / `worktrees` (worktree design 0.63 §5.3): a conversation running in its own worktree is
   * deleted only after the user confirmed the changes it has not applied (confirmWorktree), and its worktree is
   * removed with it (its last state stays pinned at its tip ref through the retention period).
   */
  constructor(store, { executor, projectInitiative, projectLearning, capabilityService, sessionWorktrees = null, worktrees = null, intervalMs = 15000, now = Date.now, readLimits = undefined } = {}) {
    this.readLimits = readLimits; this.store = store; this.executor = executor; this.projectInitiative = projectInitiative; this.projectLearning = projectLearning; this.capabilityService = capabilityService; this.sessionWorktrees = sessionWorktrees; this.worktrees = worktrees; this.running = new Map(); this.closed = false;
    // Blocked records are looked at again once per service start (a newer release may read what blocked them).
    this.now = now; this.revisited = new Set(); this.releasing = new Map();
    this.unsubscribe = store.subscribe(() => this.schedule(), { display: false });
    this.timer = setInterval(() => this.schedule(), intervalMs); this.timer.unref(); this.schedule();
  }
  schedule() {
    if (this.closed || this.scheduled || this.store.maintenanceHeld) return; this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false; if (this.closed || this.store.maintenanceHeld) return;
      for (const record of this.store.state.sessionDeletions ?? []) {
        if (this.running.size >= 2) break;
        if (['completed', 'recovery_review'].includes(record.status) || this.running.has(record.sessionId)) continue;
        if (record.status === 'blocked') { if (this.blockedDue(record)) void this.clean(record.sessionId, { retry: true }); continue; }
        if (!record.retryAt || Date.parse(record.retryAt) <= this.now()) void this.clean(record.sessionId);
      }
    });
  }
  /** A blocked record runs again on a service start, when what it waits on changed (blockedKey), or on the user's retry or decision. */
  blockedDue(record) { return !this.revisited.has(record.sessionId) || record.blockedKey !== this.blockedKey(record); }
  /**
   * Before DELETE /api/sessions/:id (and its side chats): a conversation whose worktree holds changes the project
   * folder does not have, or whose subagent workers' copies hold changes not merged yet (B8: a worker left pending,
   * in conflict, or still running), needs `confirm: true` (design 0.63 §5.3). Throws 409 `worktree_unapplied` with
   * `unapplied` (the number of the worktree's files) and `workers` (`[{ agentId, worktreeId, files, task?, role?,
   * secret? }]`) otherwise. Conversations with neither pass. Confirming discards them: their copies are removed with
   * the conversation, each one's last state pinned at its tip ref through the retention period. Files that hold secrets
   * the conversation or a worker changed (B8) are counted too, though they never merge; `secret` (absent when 0) says
   * how many of all the files counted are such, which are in no snapshot and go to the trash with their copy instead.
   * @param {string} sessionId
   * @param {{ confirm?: boolean }} [options]
   * @returns {Promise<{ unapplied: number, secret?: number, workers?: { agentId: string|null, worktreeId: string, files: number, task?: string, role?: string, secret?: number }[] }>}
   */
  async confirmWorktree(sessionId, { confirm = false } = {}) {
    const session = this.store.state.sessions.find(row => row.id === sessionId);
    let unapplied = 0, own = 0;
    if (session?.worktree && this.sessionWorktrees) { try { ({ unapplied, secret: own = 0 } = await this.sessionWorktrees.unapplied(sessionId)); } catch { unapplied = 0; own = 0; } }
    const workers = await this.unmergedWorkers(sessionId), secret = own + workers.reduce((sum, row) => sum + (row.secret ?? 0), 0);
    if ((unapplied > 0 || workers.length) && confirm !== true) {
      const say = variants => inLanguage(interfaceLanguageOf(this.store.state), variants), files = workers.reduce((sum, row) => sum + row.files, 0);
      const parts = [
        ...(unapplied > 0 ? [say({ zh: `这个对话的工作树里还有 ${unapplied} 个文件的改动没有应用到项目文件夹。`, en: `This conversation’s worktree has changes to ${unapplied} file(s) not applied to the project folder.` })] : []),
        ...(workers.length ? [say({ zh: `它的 ${workers.length} 个子代理的副本里还有 ${files} 个文件的改动没有合并。`, en: `Its ${workers.length} subagent copy(ies) hold changes to ${files} file(s) not merged yet.` })] : []),
        say({ zh: '确认删除后这些改动会丢弃（最后的状态在 Git 里保留 30 天）。', en: 'Deleting discards them (their last state stays in Git for 30 days).' }),
        ...(secret ? [say({ zh: `其中 ${secret} 个是存放密钥的文件，不进 Git：删除后移到项目文件夹的 .rna/trash.nosync，保留 ${LIMITS.trashDays} 天。`, en: `${secret} of them hold secrets and are never kept in Git: deleting moves them to the project folder’s .rna/trash.nosync for ${LIMITS.trashDays} days.` })] : []),
      ];
      throw Object.assign(new Error(parts.join(say({ zh: '', en: ' ' }))), { status: 409, code: 'worktree_unapplied', unapplied, workers, ...(secret ? { secret } : {}) });
    }
    return { unapplied, ...(workers.length ? { workers } : {}), ...(secret ? { secret } : {}) };
  }
  /**
   * The conversation's workers whose copy (W) still holds changes its merge did not bring into the parent's files:
   * every worker worktree it owns that is not removed, unless its delegation's merge was dropped or had nothing (or
   * shared the root); files counted from the copy's base to a fresh tip, minus the ones a partial merge applied, plus
   * the secret files the worker changed (`secret`: how many; WorktreeService.unmerged). A merged worker whose copy is
   * still there (kept because the read-back check failed, `mergeWork.unverified`, or not removed) counts only what the
   * merge did not settle: the files that did not read back as merged and its secret files. removeWorktree takes every
   * one of these copies with the conversation, so none goes unlisted.
   */
  async unmergedWorkers(sessionId) {
    if (typeof this.worktrees?.unmerged !== 'function') return [];
    const session = this.store.state.sessions.find(row => row.id === sessionId), out = [];
    const delegationOf = agentId => (session?.turns ?? []).flatMap(turn => turn.delegations ?? []).find(row => row.id === agentId) ?? null;
    for (const project of this.store.state.projects) for (const row of project.git?.worktrees ?? []) {
      if (row.kind !== 'worker' || row.owner?.sessionId !== sessionId || row.state === 'removed') continue;
      const delegation = delegationOf(row.owner?.agentId), status = delegation?.merge?.status;
      if (['dropped', 'nothing', 'shared_root'].includes(status)) continue;
      let found = { files: 0 };
      try { found = await this.worktrees.unmerged(project.id, row.id); } catch { found = { files: 0 }; }
      const applied = new Set(delegation?.mergeWork?.applied ?? []), unverified = new Set(delegation?.mergeWork?.unverified ?? []);
      // Merged: what reached the parent is settled (its applied list is capped, so it is not subtracted here).
      const left = status === 'merged' ? path => unverified.has(path) || isSecretPath(path) : path => !applied.has(path);
      const files = Array.isArray(found.paths) ? found.paths.filter(left).length : status === 'merged' ? found.secret ?? 0 : found.files;
      if (files > 0) out.push({ agentId: row.owner?.agentId ?? null, worktreeId: row.id, files, ...(typeof delegation?.task === 'string' && delegation.task.trim() ? { task: delegation.task.replace(/\s+/g, ' ').trim().slice(0, 80) } : {}), ...(typeof delegation?.role === 'string' ? { role: delegation.role } : {}), ...(found.secret > 0 ? { secret: found.secret } : {}) });
    }
    return out;
  }
  /**
   * The deleted conversation's session worktree goes too, and so do its workers' copies (B8: their unmerged changes
   * were confirmed with the deletion, or there were none); each tip pinned first by WorktreeService.remove.
   */
  async removeWorktree(id) {
    if (!this.worktrees) return;
    for (const project of this.store.state.projects) for (const row of project.git?.worktrees ?? []) {
      if (!['session', 'worker'].includes(row.kind) || row.owner?.sessionId !== id || row.state === 'removed') continue;
      try { await this.worktrees.remove(project.id, row.id); }
      catch { try { this.worktrees.setState(project.id, row.id, 'kept'); } catch { /* listed under Rna worktrees for the user */ } }
    }
  }
  record(id) { return this.store.state.sessionDeletions?.find(row => row.sessionId === id); }
  patch(id, changes) { return this.store.mutate(state => { const row = state.sessionDeletions.find(row => row.sessionId === id); if (!row) return; Object.assign(row, changes, { updatedAt: stamp() }); for (const [key, value] of Object.entries(changes)) if (value === undefined) delete row[key]; return row; }); }
  status(id) {
    const row = this.record(id); if (!row) return null;
    return { status: row.status, localStatus: row.localStatus, remoteStatus: row.remoteStatus, code: row.code ?? null, retryAt: row.retryAt ?? null,
      ...(row.status === 'blocked' ? blockedView(row, interfaceLanguageOf(this.store.state)) : {}) };
  }
  /** blockedKey with this service's view of the memory connection. */
  blockedKey(record, state = this.store.state) { return blockedKey(state, record, { fingerprint: projectId => this.store.memoryService?.connectionFingerprint(projectId) ?? null }); }
  /**
   * The user's decision on a blocked cleanup (review D2-3): `choice` must be the one the record offers
   * (deletionChoice), so a stale page cannot apply another. The record is changed as decided and cleaned again
   * (now, or on the next pass when two cleanups already run). Throws 404 `cleanup_not_found`, 409
   * `cleanup_decision_unavailable` or 409 `cleanup_running`; returns the cleanup job, or the status when it waits.
   * @param {string} id the deleted conversation's id
   * @param {string} choice
   */
  decide(id, choice) {
    const say = variants => inLanguage(interfaceLanguageOf(this.store.state), variants);
    const record = this.record(id);
    if (!record) throw Object.assign(new Error(say({ zh: '清理记录不存在。', en: 'There is no such cleanup record.' })), { status: 404, code: 'cleanup_not_found' });
    if (this.running.has(id)) throw Object.assign(new Error(say({ zh: '这项清理正在进行，请稍后再试。', en: 'This cleanup is running; try again shortly.' })), { status: 409, code: 'cleanup_running' });
    const offered = deletionChoice(record);
    if (!DELETION_CHOICES.includes(choice) || offered !== choice) throw Object.assign(new Error(say({ zh: '这项清理现在不需要这个决定，请刷新后再看。', en: 'This cleanup does not offer that decision now; refresh and look again.' })), { status: 409, code: 'cleanup_decision_unavailable', choice: offered });
    const at = stamp(), decision = { choice, code: record.code, at };
    this.store.mutate(state => {
      const row = state.sessionDeletions.find(entry => entry.sessionId === id); if (!row) return;
      if (choice === 'release_runs') {
        // The user releases these runs: their records go without a confirmed outcome (resolvedActionIds is what
        // discovery and purge accept as resolved); the live rows keep whatever review they still need.
        const ids = row.blockedActionIds.filter(safeId);
        row.evidence = { ...row.evidence, resolvedActionIds: [...new Set([...(row.evidence?.resolvedActionIds ?? []), ...ids])], userReleasedActionIds: [...new Set([...(row.evidence?.userReleasedActionIds ?? []), ...ids])] };
        decision.actionIds = ids;
      } else if (choice === 'remove_entry') { row.removeEntry = structuredClone(row.blockedEntry); decision.entry = structuredClone(row.blockedEntry); }
      else if (choice === 'read_all') row.readLimit = 'none';
      else if (choice === 'rebuild') row.evidence = rebuiltSessionEvidence(row);
      else if (choice === 'keep_remote') {
        for (const resource of row.evidenceResources ?? []) if (resource.deletionStatus === 'blocked') Object.assign(resource, { deletionStatus: 'kept_by_user', keptAt: at });
        for (const binding of row.bindings ?? []) if (binding.deletionStatus === 'blocked') Object.assign(binding, { deletionStatus: 'kept_by_user', keptAt: at });
      }
      row.decisions = [...(Array.isArray(row.decisions) ? row.decisions : []), decision].slice(-20);
    });
    // Due again whatever its key says: a pass that cannot start now (two already run) takes it next.
    this.revisited.delete(id);
    return this.clean(id, { retry: true });
  }
  async clean(id, { retry = false } = {}) {
    if (this.running.has(id)) return this.running.get(id);
    const record = this.record(id);
    if (!record || record.status === 'completed' || this.closed || this.store.maintenanceHeld) return this.status(id);
    if (!retry && ['recovery_review', 'blocked'].includes(record.status)) return this.status(id);
    if (!retry && record.retryAt && Date.parse(record.retryAt) > this.now()) return this.status(id);
    // HTTP wait/retry callers share the same bound as the background pump.
    if (this.running.size >= 2) return this.status(id);
    if (record.projectId && [...this.running.keys()].some(key => this.record(key)?.projectId === record.projectId)) return this.status(id);
    const job = this.perform(id).finally(() => { this.running.delete(id); this.releaseProjectFiles(this.record(id)?.projectId); this.schedule(); }); this.running.set(id, job); return job;
  }
  async perform(id) {
    this.revisited.add(id);
    try {
      // Writers are settled (and a project's background coordinator closed) only while local files are still to go:
      // the remote steps never touch them, and a rerun for a remote blocker must not stop the live project's work
      // each time (review D2-1).
      if (this.record(id).localStatus !== 'completed') {
        const context = this.executor?.running.get(id);
        if (context) { context.cancelled = true; context.memoryAbort?.abort(); await context.handle?.abort(); await context.runPromise; }
        if (this.executor?.drainMaintenance) await this.executor.drainMaintenance(id);
        if (this.executor?.builtinAgentService) await this.executor.builtinAgentService.drainSession(id);
        await this.executor?.memorySync?.drainSession(id);
        await this.capabilityService?.drainSession(id);
        await this.projectInitiative?.drainDeletedSession(this.record(id));
        await this.projectLearning?.drainDeletedSession(this.record(id));
      }
      if (this.store.state.sessions.some(session => session.id === id)) fail('SESSION_STILL_EXISTS');
      let record = this.record(id);
      if (record.localStatus !== 'completed') {
        await this.removeWorktree(id);
        // The user decided to remove the run record cleanup could not read (D2-3): it goes now, with the writers settled.
        if (record.removeEntry) {
          await removeBlockedEntry(this.store.file, record.removeEntry);
          const removed = record.removeEntry;
          this.store.mutate(state => { const row = state.sessionDeletions.find(entry => entry.sessionId === id); if (!row) return; delete row.removeEntry; row.removedEntries = [...(row.removedEntries ?? []), { ...removed, at: stamp() }].slice(-20); });
          record = this.record(id);
        }
        const evidence = await discoverSessionEvidence(this.store.file, record, { state: this.store.state, limits: this.readLimits });
        this.store.mutate(state => { const row = state.sessionDeletions.find(row => row.sessionId === id); row.evidence = evidence; scrubSessionEvidence(state, row); }, { purge: true });
        record = this.record(id);
        const related = await purgeSessionEvidenceFiles(this.store.file, record, { writersSettled: true, limits: this.readLimits });
        const result = purgeSessionFiles(this.store.file, id);
        // Captured internal calls that carried this conversation's content (opt-in effort probe data) go with it.
        const captures = purgeEffortCaptures(this.store.file, id);
        // So do the compaction-fork probe's summaries of it (they quote the user's requests).
        const summaries = purgeProbeSummaries(this.store.file, id);
        // And the schedule-text replay's reports that replayed it (they hold the model's proposed task and the words it quoted).
        const replays = purgeScheduleReplayReports(this.store.file, id);
        this.patch(id, { localStatus: 'completed', ...result, ...related, ...(captures ? { removedCaptures: captures } : {}), ...(summaries ? { removedProbeSummaries: summaries } : {}), ...(replays ? { removedScheduleReplays: replays } : {}) });
      }
      // Remote steps settle one by one (X-4): an evidence resource that cannot be removed yet never holds back another
      // one or the conversation archive; each keeps its own status, and the record settles once every one did.
      record = this.record(id);
      const failures = [];
      // Settled: deleted, or kept on the user's decision (D2-3).
      const settled = row => ['completed', 'kept_by_user'].includes(row.deletionStatus);
      for (const resource of record.evidenceResources ?? []) if (!settled(resource)) { const failure = await this.settleEvidence(id, resource.uri); if (failure) failures.push(failure); }
      for (const binding of record.bindings ?? []) if (!settled(binding)) { const failure = await this.settleBinding(id, binding.sessionId); if (failure) failures.push(failure); }
      const first = failures.find(row => !row.blocked) ?? failures[0];
      if (first) fail(first.code);
      record = this.record(id);
      const kept = [...(record.evidenceResources ?? []), ...(record.bindings ?? [])].some(row => row.deletionStatus === 'kept_by_user');
      this.patch(id, { status: 'completed', remoteStatus: kept ? 'kept_by_user' : record.bindings.length ? 'completed' : 'not_required', code: null, retryAt: null, completedAt: stamp(), ...UNBLOCKED });
    } catch (error) {
      const record = this.record(id), attempts = (record.attempts ?? 0) + 1, code = errorCode(error, 'SESSION_CLEANUP_UNAVAILABLE');
      if (Object.hasOwn(DECISION_CODES, code)) {
        // What blocked it, as the decision needs it (identities only, never content).
        const actionIds = code === 'SESSION_BACKGROUND_EXECUTION_UNCONFIRMED' && Array.isArray(error.actionIds) ? [...new Set(error.actionIds.filter(safeId))].slice(0, 200) : undefined;
        const details = { blockedActionIds: actionIds?.length ? actionIds : undefined, blockedEntry: removableEntry(error.entry) ? { root: error.entry.root, path: error.entry.path } : undefined, blockedLimit: error.limit === 'cumulative' ? 'cumulative' : undefined, blockedScope: error.scope === 'record' ? 'record' : undefined };
        const next = { ...record, ...details, code };
        this.patch(id, { status: 'blocked', attempts, code, retryAt: null, blockedAt: record.status === 'blocked' && record.code === code ? record.blockedAt ?? stamp() : stamp(), ...details, blockedKey: this.blockedKey(next) });
      } else this.patch(id, { status: 'pending', attempts, code, retryAt: new Date(this.now() + Math.min(300000, 15000 * 2 ** Math.min(attempts - 1, 5))).toISOString(), ...UNBLOCKED });
    }
    return this.status(id);
  }
  /**
   * One evidence resource of a deleted conversation. A confirmed write is deleted (or reconciled) as before. A write
   * whose outcome was never confirmed ('uncertain', or 'partial': stored but not fully indexed) is looked at,
   * read-only, once its write deadline passed: exactly the content sent → deleted; confirmed absent → done; anything
   * else → blocked (MEMORY_EVIDENCE_CONTENT_DIFFERS). Returns null when it settled, else { code, blocked }.
   */
  async settleEvidence(id, uri) {
    const record = this.record(id), resource = record.evidenceResources.find(row => row.uri === uri);
    const save = changes => this.store.mutate(state => { const row = state.sessionDeletions.find(row => row.sessionId === id)?.evidenceResources?.find(row => row.uri === uri); if (row) Object.assign(row, changes, { deletionUpdatedAt: stamp() }); });
    try {
      let receipt;
      if (verifiedResource(resource) || !['uncertain', 'partial', 'dispatching'].includes(resource.status)) receipt = await this.store.memoryService.deleteEvidenceResource(record, resource);
      else {
        if (this.now() < Date.parse(resource.dispatchedAt ?? 0) + EVIDENCE_WRITE_DEADLINE_MS) fail('MEMORY_EVIDENCE_WRITE_PENDING');
        const found = await this.store.memoryService.verifyDeletedEvidence(record, resource);
        if (found.state === 'differs') fail('MEMORY_EVIDENCE_CONTENT_DIFFERS');
        receipt = { ...(found.state === 'missing' ? { uri, deleted: true } : await this.store.memoryService.deleteVerifiedEvidence(record, resource)), reconciliation: found.reconciliation };
      }
      save({ deletionStatus: 'completed', deletionCode: null, ...(receipt?.reconciliation ? { deletionReconciliation: receipt.reconciliation } : {}) });
      return null;
    } catch (error) {
      const code = errorCode(error, 'SESSION_CLEANUP_UNAVAILABLE'), blocked = Object.hasOwn(DECISION_CODES, code);
      save({ deletionStatus: blocked ? 'blocked' : 'pending', deletionCode: code, deletionAttempts: (resource.deletionAttempts ?? 0) + 1 });
      return { code, blocked };
    }
  }
  /** One OpenViking conversation archive of a deleted conversation; returns null when it settled, else { code, blocked }. */
  async settleBinding(id, sessionId) {
    const record = this.record(id), binding = record.bindings.find(row => row.sessionId === sessionId);
    try {
      await this.store.memoryService.deleteSessionArchive(record, binding);
      this.store.mutate(state => {
        const row = state.sessionDeletions.find(row => row.sessionId === id), target = row.bindings.find(value => value.sessionId === sessionId);
        Object.assign(target, { deletionStatus: 'completed', deletionCode: null });
        const existing = state.projects.find(project => project.id === row.projectId)?.memorySessions?.find(value => value.sessionId === sessionId);
        if (existing) { existing.status = 'deleted'; existing.deletedAt = stamp(); existing.sourceSessionId = null; }
      });
      return null;
    } catch (error) {
      const code = errorCode(error, 'SESSION_CLEANUP_UNAVAILABLE'), blocked = Object.hasOwn(DECISION_CODES, code);
      this.store.mutate(state => { const target = state.sessionDeletions.find(row => row.sessionId === id)?.bindings?.find(value => value.sessionId === sessionId); if (target) Object.assign(target, { deletionStatus: blocked ? 'blocked' : 'pending', deletionCode: code, deletionAttempts: (target.deletionAttempts ?? 0) + 1 }); });
      return { code, blocked };
    }
  }
  /**
   * A deleted project's run files (X-3) go once every one of its conversation deletions settled (completed, or
   * blocked waiting for the user) and none is running: until then their cleanup reads the journals linked to them.
   */
  releaseProjectFiles(projectId) {
    if (!projectId || this.closed || this.releasing.has(projectId) || this.store.state.projects.some(project => project.id === projectId)) return;
    const records = (this.store.state.sessionDeletions ?? []).filter(row => row.projectId === projectId);
    if (records.some(row => !['completed', 'blocked'].includes(row.status) || this.running.has(row.sessionId))) return;
    const job = removeProjectRunFiles(this.store.file, projectId).catch(() => []).finally(() => this.releasing.delete(projectId));
    this.releasing.set(projectId, job);
  }
  async wait(id, timeoutMs = 10000) {
    let timer, unsubscribe, queuedDone;
    const queued = new Promise(resolve => { queuedDone = resolve; });
    const settled = status => !status || ['completed', 'blocked'].includes(status.status) || status.code && status.retryAt;
    const observe = () => { const status = this.status(id); if (settled(status)) queuedDone(status); };
    unsubscribe = this.store.subscribe(observe);
    try {
      const clean = this.clean(id).then(status => { observe(); return settled(status) ? status : queued; });
      return await Promise.race([clean, new Promise(resolve => { timer = setTimeout(() => resolve(this.status(id)), timeoutMs); timer.unref(); })]);
    } finally { clearTimeout(timer); unsubscribe(); }
  }
  async close() { this.closed = true; clearInterval(this.timer); this.unsubscribe(); await Promise.allSettled([...this.running.values(), ...this.releasing.values()]); }
}
