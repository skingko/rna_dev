import { createHash, randomUUID } from 'node:crypto';
import { requestJSON } from './configuration.mjs';
import { memoryRequest } from './embedded-memory.mjs';
import { isMemoryDirectoryPlaceholder } from './memory-service.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
/** A rebuild already submitted (or whose submission is unconfirmed): followed read-only to its end. */
const IN_FLIGHT = new Set(['submitting', 'polling', 'uncertain']);
const active = new Set(['submitting', 'polling']);
/** OpenViking task states that still run (task_tracker _ACTIVE_STATUSES). */
const RUNNING_TASK = new Set(['pending', 'running', 'cancelling']);
/** What the read-only tree check says when a valid tree is not summarized as it was submitted. (A tree it cannot walk
 * — past the node limit, foreign, empty — would fail a new submission the same way, so it settles as failed.) */
const UNVERIFIED = new Set(['MEMORY_SUMMARY_LAYER_INCOMPLETE', 'MEMORY_SUMMARY_SOURCE_MISSING', 'MEMORY_SUMMARY_SOURCE_UNREADABLE']);
const within = (uri, root) => typeof uri === 'string' && (uri === root || uri.startsWith(`${root}/`)) && !/[?#%\u0000-\u001f]/u.test(uri) && !uri.split('/').some(part => part === '.' || part === '..');
const stamp = now => new Date(now).toISOString();
const messages = {
  pending: '记忆原文已提取，目录摘要等待整理。',
  submitting: '正在提交目录摘要整理；请求回执尚未确认。',
  polling: '目录摘要正在整理，原文仍可读取。',
  completed: '已核验当前项目目录摘要、概览及记忆原文。',
  failed: '目录摘要尚未整理完整；原文未被删除，不会自动重复付费重建。',
  uncertain: '目录摘要请求结果待核对；先只读核对目录，不会盲目重复提交可能已经付费的请求。',
  skipped: '目录摘要不再整体重建：OpenViking 提炼时会整理它写入的目录概览；记忆原文不受影响。'
};

/**
 * MEM-8 (2026-10-05): the whole peer-memory tree is no longer rebuilt after extractions. Measured on a copy of live
 * state (docs/research/memory-hygiene-b6-20261005.md): directory abstracts were 6 of 297 recalled passages (2.0%), all
 * date directories of `events/` that only this rebuild had written, and no model call ever read a directory L0/L1
 * (one openviking_read in all live conversations, of a file). The rebuild cost was O(tree): a recursive
 * semantic_and_vectors reindex re-embedded every record and re-aggregated every directory under a tree lock (4 m 17 s
 * at 143 nodes on the novel project) and failed for good past 500 nodes. OpenViking itself refreshes the overview of
 * every directory an extraction writes into (memory_updater), which is what its own clients rely on; none calls
 * reindex. What stays is the project's memory revision: each completed extraction that produced memories moves
 * `revision`/`sourceFingerprint` (the memory page's "content changed" signal), and the row says 'skipped'
 * (MEMORY_SUMMARY_RETIRED). A rebuild already submitted is still followed read-only to its end.
 * Called inside the Store transaction that records the completed commit; no backfill.
 */
export function noteMemoryRevision(state, projectId, write, now = Date.now()) {
  const project = state.projects.find(row => row.id === projectId);
  if (!project || !write.taskId) return;
  const current = project.memorySummary;
  if (current?.lastSourceTaskId === write.taskId) return;
  const row = current ?? { schemaVersion: 1, id: randomUUID(), revision: 0, createdAt: stamp(now) };
  row.revision = (row.revision ?? 0) + 1; row.lastSourceTaskId = write.taskId;
  row.sourceFingerprint = hash([row.sourceFingerprint ?? '', write.taskId, write.sessionId ?? null]);
  row.updatedAt = stamp(now);
  if (!IN_FLIGHT.has(row.status)) retire(row, now);
  project.memorySummary = row;
}
/** The row as 'skipped' (MEMORY_SUMMARY_RETIRED); a failure it carried is kept as `lastFailure`. */
function retire(row, now, extra = {}) {
  if (row.status === 'failed') row.lastFailure = { code: row.code ?? null, at: stamp(now), taskId: row.taskId ?? null };
  return Object.assign(row, { status: 'skipped', code: 'MEMORY_SUMMARY_RETIRED', message: messages.skipped, nextPollAt: null, pollFailures: 0, ...extra });
}

/** The same split the turn and evidence writes use (MEM-4, A2).
 * 'unresolved': the outcome is not known yet and a resolver is running — an 'uncertain' row (a submission without a
 * receipt, or a task OpenViking forgot) until the read-only tree check settles it, or a lookup that keeps failing.
 * Only these degrade /api/health.
 * 'settled': 'failed', a known gap (a tree past the node limit, a rejection, a changed connection, layers missing
 * after a completed task). The memories themselves are intact; the next pump retires the row (MEM-8).
 * null: in progress, completed or retired ('skipped'). */
export function memorySummaryResolution(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.status === 'uncertain') return 'unresolved';
  if (row.status === 'failed') return 'settled';
  return active.has(row.status) && Number(row.pollFailures) > 0 ? 'unresolved' : null;
}

export function memorySummaryHealth(state) {
  const rows = (state.projects ?? []).filter(project => project.memorySummary).map(project => ({ projectId: project.id, ...project.memorySummary }));
  const listed = row => ({ projectId: row.projectId, status: row.status, code: row.code, updatedAt: row.updatedAt });
  const issues = rows.filter(row => memorySummaryResolution(row) === 'unresolved'), settled = rows.filter(row => memorySummaryResolution(row) === 'settled');
  return { healthy: issues.length === 0, total: rows.length,
    counts: Object.fromEntries(['pending', 'submitting', 'polling', 'completed', 'failed', 'uncertain', 'skipped'].map(status => [status, rows.filter(row => row.status === status).length])),
    issues: issues.slice(0, 20).map(listed), omittedIssues: Math.max(0, issues.length - 20),
    settled: settled.slice(0, 20).map(listed), omittedSettled: Math.max(0, settled.length - 20) };
}

/** Follows, read-only, a whole-tree rebuild submitted before MEM-8 (one at a time) and retires rows still waiting to
 * submit one. Nothing is submitted any more (noteMemoryRevision). OpenViking owns semantic-model usage; this is not
 * charged as an invented chat receipt. */
export class MemorySummarySync {
  constructor(store, { now = Date.now, pollMs = 15000, maxNodes = 500, timeoutMs = 15000, verificationTimeoutMs = 120000 } = {}) {
    this.store = store; this.now = now; this.pollMs = pollMs; this.maxNodes = maxNodes; this.timeoutMs = timeoutMs; this.verificationTimeoutMs = verificationTimeoutMs;
    this.closed = false; this.running = null; this.cursor = 0;
    this.unsubscribe = store.subscribe(() => { if (this.running && !this.store.state.projects.some(project => project.id === this.running.projectId)) this.running.abort.abort(); });
  }
  record(projectId) { return this.store.state.projects.find(row => row.id === projectId)?.memorySummary; }
  patch(projectId, id, patch) {
    if (this.record(projectId)?.id !== id) return;
    this.store.mutate(state => { const row = state.projects.find(project => project.id === projectId)?.memorySummary; if (row?.id === id) Object.assign(row, patch, { updatedAt: stamp(this.now()) }); });
  }
  allowed(projectId) {
    const project = this.store.state.projects.find(row => row.id === projectId);
    return project && !project.archivedAt && !this.store.state.emergency && this.store.state.configuration.memory.autoStore !== false;
  }
  pump() {
    if (this.store.maintenanceHeld || (this.store.state.applicationRecovery?.barriers?.memory && this.store.state.configuration.memory.autoStore !== true)) return [];
    if (this.closed || this.running) return [];
    const projects = this.store.state.projects, count = projects.length;
    // A row still waiting to submit a whole-tree rebuild, or left failed by one, is retired without a request (MEM-8).
    const retiring = row => ['pending', 'failed'].includes(row?.status) && !row.appRecovery?.required;
    const waiting = projects.filter(project => retiring(project.memorySummary)).map(project => project.id);
    if (waiting.length) this.store.mutate(state => { for (const project of state.projects) if (waiting.includes(project.id) && retiring(project.memorySummary)) retire(project.memorySummary, this.now(), { updatedAt: stamp(this.now()) }); });
    for (let offset = 0; offset < count; offset++) {
      const index = (this.cursor + offset) % count, project = projects[index], row = project.memorySummary;
      // An 'uncertain' row is settled by a read-only look at the tree, allowed even while writes are paused.
      if (!row || row.appRecovery?.required || !active.has(row.status) && row.status !== 'uncertain' || this.now() < (row.nextPollAt ?? 0)) continue;
      const operation = { projectId: project.id, abort: new AbortController(), promise: null };
      this.running = operation; this.cursor = (index + 1) % count;
      operation.promise = Promise.resolve().then(() => this.advance(project.id, row.id, operation.abort.signal)).catch(() => {}).finally(() => { if (this.running === operation) this.running = null; });
      return [operation.promise];
    }
    return [];
  }
  async advance(projectId, id, signal) {
    let row = this.record(projectId); if (row?.id !== id || row?.appRecovery?.required) return;
    // A submission a restart cut off may still be reaching the server: look a poll interval later, not at once.
    if (row.status === 'submitting') { this.patch(projectId, id, { status: 'uncertain', code: 'MEMORY_SUMMARY_OUTCOME_UNKNOWN', message: messages.uncertain, nextPollAt: this.now() + this.pollMs }); return; }
    let stage = row.status;
    const service = this.store.memoryService;
    const guard = (mutation = false) => {
      signal.throwIfAborted();
      const current = this.record(projectId);
      if (this.closed || current?.id !== id) throw fail('MEMORY_SUMMARY_STOPPED');
      if (service.connectionFingerprint(projectId) !== row.connectionFingerprint) throw fail('MEMORY_SUMMARY_CONNECTION_CHANGED');
      const remote = service.remote(projectId);
      if (remote.config.endpoint !== row.endpoint || remote.actorPeerId !== row.actorPeerId) throw fail('MEMORY_SUMMARY_CONNECTION_CHANGED');
      if (row.schemaVersion !== 1 || row.actorPeerId !== `forge-${projectId}` || row.uri !== `viking://user/${row.userId}/peers/${remote.actorPeerId}/memories` || !within(row.uri, row.uri)) throw fail('MEMORY_SUMMARY_IDENTITY_UNVERIFIED');
      if (mutation && !this.allowed(projectId)) throw fail('MEMORY_SUMMARY_PAUSED');
      return remote;
    };
    const call = async (path, { method = 'GET', body, requestSignal = signal } = {}) => {
      const remote = guard(method !== 'GET');
      const response = await memoryRequest(requestJSON, `${remote.config.endpoint}/api/v1/${path}`, { method, body, headers: remote.headers, signal: requestSignal, timeoutMs: this.timeoutMs });
      guard(); if (response?.status !== 'ok') throw fail('MEMORY_SUMMARY_RESPONSE_INVALID'); return response.result;
    };
    const tree = async requestSignal => {
      const directories = new Set([row.uri]), files = new Set();
      // OpenViking's recursive ls defaults to three levels; its HTTP router
      // does not expose level_limit. Events live below events/year/month/day.
      // Visit each directory explicitly so a shallow listing cannot certify
      // that all memory sources and layers have been verified.
      const queue = [row.uri];
      for (let index = 0; index < queue.length; index++) {
        const uri = queue[index];
        const rows = await call(`fs/ls?${new URLSearchParams({ uri, recursive: 'false', output: 'original', node_limit: String(this.maxNodes + 1) })}`, { requestSignal });
        if (!Array.isArray(rows)) throw fail('MEMORY_SUMMARY_TREE_INVALID');
        if (rows.length > this.maxNodes) throw fail('MEMORY_SUMMARY_TREE_LIMIT');
        for (const entry of rows) {
          if (!entry || entry.access === 'denied' || !within(entry.uri, uri) || typeof entry.isDir !== 'boolean' || entry.uri === uri) throw fail('MEMORY_SUMMARY_TREE_INVALID');
          if (entry.uri.split('/').slice(row.uri.split('/').length).some(part => part.startsWith('.'))) continue;
          if ((entry.isDir ? files : directories).has(entry.uri)) throw fail('MEMORY_SUMMARY_TREE_INVALID');
          if (entry.isDir && !directories.has(entry.uri)) queue.push(entry.uri);
          (entry.isDir ? directories : files).add(entry.uri);
          if (directories.size - 1 + files.size > this.maxNodes) throw fail('MEMORY_SUMMARY_TREE_LIMIT');
        }
      }
      if (!files.size) throw fail('MEMORY_SUMMARY_NO_SOURCE_FILES');
      return { directories: [...directories].sort(), files: [...files].sort() };
    };
    // Read-only proof that the tree is summarized: every source it was submitted with is still there, every directory
    // has a real L0 and L1, and every original is readable.
    const verify = async () => {
      const verificationSignal = AbortSignal.any([signal, AbortSignal.timeout(this.verificationTimeoutMs)]);
      const found = await tree(verificationSignal);
      if (!Array.isArray(row.expectedFiles) || row.expectedFiles.some(uri => !found.files.includes(uri))) throw fail('MEMORY_SUMMARY_SOURCE_MISSING');
      for (const uri of found.directories) for (const layer of ['abstract', 'overview']) {
        let content;
        try { content = await call(`content/${layer}?${new URLSearchParams({ uri })}`, { requestSignal: verificationSignal }); }
        catch (error) { if (error.upstreamStatus === 404) throw fail('MEMORY_SUMMARY_LAYER_INCOMPLETE'); throw error; }
        if (typeof content !== 'string' || !content.trim() || isMemoryDirectoryPlaceholder(content, uri)) throw fail('MEMORY_SUMMARY_LAYER_INCOMPLETE');
      }
      for (const uri of found.files) {
        const content = await call(`content/read?${new URLSearchParams({ uri, offset: '0', limit: '1' })}`, { requestSignal: verificationSignal });
        // A readable original may legitimately begin with an empty line. Its
        // presence/identity, not a non-empty first-line preview, is the gate.
        if (typeof content !== 'string') throw fail('MEMORY_SUMMARY_SOURCE_UNREADABLE');
      }
      guard();
      return found;
    };
    // Read-only: the reindex OpenViking is running on this tree, if any, from its task list (as memory-service reads
    // session commits). It runs one reindex per tree (reindex_executor create_if_no_running, 409 CONFLICT for another),
    // so this is the one a lost receipt or a 409 points at. undefined: the server does not list tasks (404).
    const runningReindex = async () => {
      let cursor;
      for (let page = 0; page < 5; page++) {
        const params = new URLSearchParams({ task_type: 'admin_reindex', resource_id: row.uri, pagination: 'cursor', limit: '200', ...(cursor ? { cursor } : {}) });
        let list;
        try { list = await call(`tasks?${params}`); } catch (error) { if (error.upstreamStatus === 404) return undefined; throw error; }
        if (!Array.isArray(list?.items) || typeof list.has_more !== 'boolean') throw fail('MEMORY_SUMMARY_TASKS_INVALID');
        for (const task of list.items) {
          if (task?.task_type !== 'admin_reindex' || task.resource_id !== row.uri || typeof task.task_id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(task.task_id)) throw fail('MEMORY_SUMMARY_TASKS_INVALID');
          if (RUNNING_TASK.has(task.status)) return task;
        }
        if (!list.has_more) return null;
        if (typeof list.next_cursor !== 'string' || !list.next_cursor || list.next_cursor === cursor) throw fail('MEMORY_SUMMARY_TASKS_INVALID');
        cursor = list.next_cursor;
      }
      throw fail('MEMORY_SUMMARY_TASKS_INVALID');
    };
    // The followed rebuild verified: 'completed' when no extraction came after its submission, else the row retires
    // (MEM-8: the later memories are not rebuilt into the tree).
    const complete = (found, extra) => {
      const current = this.record(projectId), more = current.revision > row.targetRevision;
      const settled = { pollFailures: 0, conflicts: 0, taskStatus: 'completed', nextPollAt: null,
        completedAt: stamp(this.now()), verifiedRevision: row.targetRevision, verifiedFingerprint: row.targetFingerprint,
        verification: { directories: found.directories.length, files: found.files.length, layers: found.directories.length * 2, manifestFingerprint: hash(found), at: stamp(this.now()) }, ...extra };
      this.patch(projectId, id, more ? { ...retire({ status: 'polling' }, this.now()), ...settled } : { status: 'completed', message: messages.completed, code: null, ...settled });
    };
    // Not summarized as submitted (MEM-8): nothing is submitted again; the row retires and keeps what was found.
    const unverified = previousVerification => this.patch(projectId, id, { ...retire({ status: 'polling' }, this.now()), adoptedTaskId: null, previousVerification: { ...previousVerification, at: stamp(this.now()) } });
    if (!IN_FLIGHT.has(stage)) return;
    try {
      const remote = guard();
      if (await service.identity(remote, { signal, fresh: true }) !== row.userId) throw fail('MEMORY_SUMMARY_IDENTITY_CHANGED');
      guard();
      // A submission whose receipt was lost, a task OpenViking forgot, or a 409 (A2): settled by looking, never by
      // submitting again blind. A reindex still running on the tree is followed to its end (its layers are not rebuilt
      // yet, and older ones would pass the tree check early); with none, the tree decides: summarized → completed,
      // otherwise the row retires (MEM-8).
      if (stage === 'uncertain') {
        const running = await runningReindex();
        if (running) {
          this.patch(projectId, id, { status: 'polling', message: messages.polling, taskId: running.task_id, adoptedTaskId: running.task_id, taskStatus: running.status, code: null, pollFailures: 0, conflicts: 0, nextPollAt: this.now() + this.pollMs,
            adoptedFrom: { status: 'uncertain', code: row.code ?? null, taskId: row.taskId ?? null, at: stamp(this.now()) } });
          return;
        }
        complete(await verify(), { taskStatus: null, settledFrom: { status: 'uncertain', code: row.code ?? null, taskId: row.taskId ?? null, at: stamp(this.now()) } }); return;
      }
      if (typeof row.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(row.taskId)) throw fail('MEMORY_SUMMARY_TASK_IDENTITY_INVALID');
      let task;
      try { task = await call(`tasks/${encodeURIComponent(row.taskId)}`); }
      catch (error) { if (error.upstreamStatus === 404) throw fail('MEMORY_SUMMARY_TASK_EXPIRED'); throw error; }
      if (task?.task_id !== row.taskId || task.task_type !== 'admin_reindex' || task.resource_id !== row.uri) throw fail('MEMORY_SUMMARY_TASK_IDENTITY_INVALID');
      if (['pending', 'running', 'cancelling'].includes(task.status)) { this.patch(projectId, id, { taskStatus: task.status, code: null, pollFailures: 0, nextPollAt: this.now() + this.pollMs }); return; }
      if (['failed', 'cancelled'].includes(task.status)) throw fail('MEMORY_SUMMARY_TASK_FAILED');
      if (task.status !== 'completed' || task.result?.status !== 'completed' || task.result.uri !== row.uri || task.result.mode !== 'semantic_and_vectors' || task.result.object_type !== 'memory' || task.result.failed_records !== 0) throw fail('MEMORY_SUMMARY_TASK_RESULT_INVALID');
      complete(await verify(), { result: { scannedRecords: task.result.scanned_records, rebuiltRecords: task.result.rebuilt_records, failedRecords: task.result.failed_records } });
    } catch (error) {
      if (this.record(projectId)?.id !== id) return;
      if (signal.aborted || this.closed || error.code === 'MEMORY_SUMMARY_PAUSED') return;
      // Not summarized (or not checkable as submitted): the earlier request owns nothing provable.
      if (stage === 'uncertain' && UNVERIFIED.has(error.code)) { unverified({ taskId: row.taskId ?? null, revision: row.targetRevision ?? null, code: error.code, from: row.code ?? null }); return; }
      // A followed reindex (not one this row's receipt named) did not leave the tree as this row submitted it.
      if (stage === 'polling' && row.adoptedTaskId && row.adoptedTaskId === row.taskId && UNVERIFIED.has(error.code)) { unverified({ taskId: row.taskId, revision: row.targetRevision ?? null, code: error.code, adopted: true }); return; }
      // A new completed extraction may have added unaggregated directories or merged/deleted a prior memory while this
      // revision was rebuilding: no success is claimed for the unverified revision.
      if (stage === 'polling' && this.record(projectId).revision > row.targetRevision && ['MEMORY_SUMMARY_LAYER_INCOMPLETE', 'MEMORY_SUMMARY_SOURCE_MISSING'].includes(error.code)) {
        unverified({ taskId: row.taskId, revision: row.targetRevision, code: error.code, supersededByRevision: this.record(projectId).revision }); return;
      }
      if (stage === 'polling' && error.code === 'MEMORY_SUMMARY_TASK_EXPIRED') {
        this.patch(projectId, id, { status: 'uncertain', code: 'MEMORY_SUMMARY_TASK_EXPIRED', message: messages.uncertain, nextPollAt: this.now() + this.pollMs }); return;
      }
      if (String(error.code ?? '').startsWith('MEMORY_SUMMARY_')) {
        this.patch(projectId, id, { status: 'failed', code: error.code, message: messages.failed, nextPollAt: null }); return;
      }
      // An unreachable server leaves an 'uncertain' row as it was (its own code kept) and looks again later.
      const failures = (this.record(projectId).pollFailures ?? 0) + 1;
      this.patch(projectId, id, { status: stage, code: stage === 'uncertain' ? row.code : 'MEMORY_SUMMARY_LOOKUP_FAILED', pollFailures: failures,
        message: '目录摘要状态暂不可读取，稍后继续核对；没有重复付费提交。', nextPollAt: this.now() + Math.min(300000, this.pollMs * 2 ** Math.min(failures, 5)) });
    }
  }
  async close() { this.closed = true; this.unsubscribe(); this.running?.abort.abort(); await this.running?.promise; }
}
