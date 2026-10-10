import { randomUUID, createHash } from 'node:crypto';
import { requestJSON } from './configuration.mjs';
import { checkpointRetention } from './memory-checkpoints.mjs';
import { memoryEvidenceDocument } from './memory-evidence-outbox.mjs';
import { recentMemory, memoryEntryKind } from './memory-browser-index.mjs';
import { memoryEntryPresentation } from './memory-entry-presentation.mjs';
import { EmbeddedMemory, EMBEDDED_BACKEND, EMBEDDED_MEMORY_ENDPOINT, MEMORY_BACKENDS, memoryRequest } from './embedded-memory.mjs';

const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
const text = (value, label, max, empty = false) => { if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) fail(`${label} 必须为有效文本（最多 ${max} 字符）`); return value.trim(); };
const projectOf = (state, id) => state.projects.find(p => p.id === id) ?? fail('项目不存在', 404);
export const memoryNamespace = project => project.memory?.namespace ?? `viking://resources/projects/${project.id}`;
export function validateNamespace(value) {
  const uri = text(value, '项目记忆命名空间', 1200).replace(/\/+$/, '');
  if (!/^viking:\/\/(?:resources|user)\/[A-Za-z0-9_./-]+$/.test(uri) || uri.split('/').some(part => part === '..' || part === '.') || uri.split('/').length < 5) fail('命名空间必须是独立的 viking://resources/... 或 user/... 子目录');
  return uri;
}
function options(config, input = {}) {
  const level = input.level;
  if (level !== undefined && !['L0', 'L1', 'L2'].includes(level)) fail('记忆层级必须为 L0/L1/L2');
  const limit = input.limit === undefined ? config.limit : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('检索上限必须为 1–100');
  return { level, limit };
}
const levelOf = value => [0, 1, 2, '0', '1', '2', 'L0', 'L1', 'L2'].includes(value) ? `L${String(value).replace(/^L/, '')}` : null;
const semanticURI = uri => uri.replace(/\/\.(?:abstract|overview)\.md$/, '');
// VikingFS renders these exact sentinels for absent directory sidecars. Match
// the whole response and its own URI; authored prose mentioning the phrase or
// quoting another URI remains content. This never runs on a raw L2 file read.
export function isMemoryDirectoryPlaceholder(content, uri) {
  const value = content.trim().replace(/\r\n/g, '\n');
  return value === `# ${uri} [Directory abstract is not ready]` || value === `# ${uri}\n\n[Directory overview is not ready]`;
}
const integer = (value, label, fallback, min, max) => {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) fail(`${label} 必须为 ${min}–${max} 的整数`);
  return result;
};
// Conservative, deterministic estimate; this is not a provider tokenizer.
export function estimateMemoryTokens(value) {
  return Math.ceil(Buffer.byteLength(value, 'utf8') / 3);
}
function candidate(row) {
  const level = levelOf(row.level), directory = level === 'L0' || level === 'L1', leaf = level === 'L2';
  const expandUri = directory ? semanticURI(row.uri) : row.uri;
  const abstract = typeof row.abstract === 'string' ? row.abstract : '';
  const summaryStatus = abstract.trim() && !isMemoryDirectoryPlaceholder(abstract, semanticURI(row.uri)) ? 'ready' : 'unavailable', summary = summaryStatus === 'ready' ? abstract : '';
  return { id: row.uri, uri: row.uri, expandUri, title: expandUri.split('/').at(-1), summary, content: summary, summaryStatus, score: Number.isFinite(row.score) ? row.score : null, source: 'openviking', level, isLeaf: leaf ? true : directory ? false : null, isDirectory: directory ? true : leaf ? false : null, availableReads: directory ? ['L0', 'L1'] : leaf ? ['L2'] : [], simulated: false };
}
export const within = (uri, namespace) => typeof uri === 'string' && (uri === namespace || uri.startsWith(`${namespace}/`)) && !uri.split('/').some(part => part === '..' || part === '.') && !/[?#%\u0000-\u001f]/u.test(uri);
const compareMemoryEntries = (a, b) => {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  const time = (Date.parse(b.modifiedAt) || 0) - (Date.parse(a.modifiedAt) || 0);
  if (time) return time;
  for (const [left, right] of [[a.title.toLowerCase(), b.title.toLowerCase()], [a.title, b.title], [a.uri, b.uri]]) {
    if (left < right) return -1; if (left > right) return 1;
  }
  return 0;
};
function resultOf(response) { if (response?.status !== 'ok') fail('OpenViking 未确认请求成功，请检查服务日志', 503); return response.result; }
function remoteId(value) { const id = text(value, 'OpenViking 会话 ID', 160); if (!/^[A-Za-z0-9_-]+$/.test(id)) fail('OpenViking 会话 ID 格式错误'); return id; }
const cleanupError = code => Object.assign(new Error(code), { code, status: 503 });
/** The tag every event memory extracted from one turn's remote session carries (OpenViking lower-cases tags and allows one `=`; a turn id is a UUID). */
const TURN_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const TURN_TAG_KEY = 'rna_turn';
export const turnTag = turnId => `${TURN_TAG_KEY}=${String(turnId).toLowerCase()}`;
/** An archive named by a commit or task result (OpenViking `<session uri>/history/archive_NNN`, session.py commit
 * phase 1 and the phase-2 task result), only when it is one of this bound session's own archives; anything else is
 * not recorded. Kept for the rewind and settling work that reads the archive's markers and memory_diff (A2, X-7). */
function archiveUriOf(binding, sessionId, value) {
  const prefix = `viking://user/${binding?.userId}/sessions/${sessionId}/history/archive_`;
  return typeof binding?.userId === 'string' && typeof value === 'string' && value.startsWith(prefix) && /^\d{1,9}$/.test(value.slice(prefix.length)) ? value : null;
}
/** An evidence write request's own deadline (writeEvidenceResource): until it passes the server may still be writing. */
export const EVIDENCE_WRITE_DEADLINE_MS = 315000;
const parentOf = uri => uri.slice(0, uri.lastIndexOf('/'));
/**
 * MEM-6: OpenViking's `rm` with wait=true refreshes the semantic summary of the removed file's parent directory with the
 * deletion as its change, waits for it, and reports `semantic_root_uri` and `semantic_status` (fs_service.rm:
 * 'complete' once the refresh ran without semantic errors; 'deferred' when the freshness planner only marked the
 * directory pending, 'queued' without wait, 'failed' on queue errors). Kept only when it names the deleted resource's own
 * parent directory. Ancestors above it are refreshed only best-effort (semantic_processor parent propagation), so the
 * receipt proves nothing about them.
 */
function semanticReceipt(resourceUri, result) {
  const rootUri = typeof result?.semantic_root_uri === 'string' ? result.semantic_root_uri.replace(/\/+$/, '') : null, status = result?.semantic_status;
  return rootUri && rootUri === parentOf(resourceUri) && ['complete', 'deferred', 'queued', 'failed'].includes(status) ? { semantic: { rootUri, status } } : {};
}
/** Whether a delivery document's DELETE receipt proves that `directory`'s L0/L1 were regenerated without it (MEM-6). */
export const rebuiltWithout = (index, directory) => index?.status === 'deleted' && index.cleanup?.receipt?.semantic?.status === 'complete' && index.cleanup.receipt.semantic.rootUri === directory && parentOf(index.uri ?? '') === directory;
/** The largest memory diff archiveState reads: half of requestJSON's 2 MB response cap, since JSON escaping of the
 * indented file can double its bytes in the response. */
export const MEMORY_DIFF_READ_BYTES = 1024 * 1024;
/** How many memories one archive's `memory_diff.json` adds, updates or deletes (its `summary.total_*`, else the
 * operation lists, as OpenViking's _make_memory_diff writes both); null when the text is not such a diff. */
export function memoryDiffChanges(text) {
  let diff; try { diff = typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
  if (!diff || typeof diff !== 'object' || Array.isArray(diff)) return null;
  const keys = [['total_adds', 'adds'], ['total_updates', 'updates'], ['total_deletes', 'deletes']], summary = diff.summary, operations = diff.operations;
  if (summary && typeof summary === 'object' && keys.every(([key]) => Number.isSafeInteger(summary[key]) && summary[key] >= 0)) return keys.reduce((sum, [key]) => sum + summary[key], 0);
  if (operations && typeof operations === 'object' && keys.every(([, key]) => Array.isArray(operations[key]))) return keys.reduce((sum, [, key]) => sum + operations[key].length, 0);
  return null;
}
/** Content identity of one recalled passage as attached: the dedup key with its URI (MIND-13). */
export const passageHash = summary => createHash('sha256').update(String(summary ?? '')).digest('hex');
/** Fixed model-visible note for passages left out because the conversation already holds them unchanged (MIND-13).
 * A compaction the host cannot foresee at recall time (one forced later in the turn, or after an overflow) may take that
 * earlier attachment out of the context: the note names the read that brings the passage back. */
export const ALREADY_ATTACHED_NOTE = 'Matched again; their unchanged text is in an earlier project-memory attachment of this conversation. If that attachment is no longer in your context, read these URIs with openviking_read.';
/**
 * Packs recall candidates into `budgetTokens` (estimateMemoryTokens of the serialized rows), in rank order. Source
 * identity and expansion metadata are always kept; only the summary excerpt of a row that does not fit is clipped.
 * `exclude` (MIND-13): a Map uri → Set of passageHash already attached to the conversation. Such a candidate is skipped
 * only when both its URI and the hash of its full summary match; the budget it would have used goes to the next fresh
 * candidates. Each skipped candidate that would have been attached without the exclusion leaves a pointer (its URI)
 * instead, and the pointers' cost comes out of the budget first.
 */
export function packMemoryRecall(candidates, budgetTokens, { exclude = null } = {}) {
  const duplicate = entry => Boolean(exclude?.get(entry.uri)?.has(passageHash(entry.summary)));
  const pack = (rows, wrap = list => list) => {
    const entries = []; let truncated = false;
    for (const entry of rows) {
      // Always preserve source identity and expansion metadata. Clip only the
      // excerpt, never a serialized JSON document or a source URI.
      const row = { uri: entry.uri, expandUri: entry.expandUri, level: entry.level, isLeaf: entry.isLeaf, availableReads: entry.availableReads, summary: entry.summary, truncated: false };
      const available = Array.from(row.summary);
      const packed = summary => JSON.stringify(wrap([...entries, { ...row, summary }]));
      if (estimateMemoryTokens(packed(row.summary)) > budgetTokens) {
        row.truncated = true;
        if (estimateMemoryTokens(packed('')) > budgetTokens) { truncated = true; continue; }
        let lo = 0, hi = available.length;
        while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (estimateMemoryTokens(packed(available.slice(0, mid).join(''))) <= budgetTokens) lo = mid; else hi = mid - 1; }
        row.summary = available.slice(0, lo).join(''); truncated = true;
      }
      entries.push(row);
    }
    return { entries, truncated };
  };
  if (!exclude?.size || !candidates.some(duplicate)) {
    const { entries, truncated } = pack(candidates);
    return { entries, truncated, alreadyAttached: [], content: entries.length ? JSON.stringify(entries) : '' };
  }
  // What would have been attached without the exclusion: those of it already attached leave a pointer.
  const shown = new Set(pack(candidates).entries.map(row => row.uri));
  const alreadyAttached = candidates.filter(entry => shown.has(entry.uri) && duplicate(entry)).map(entry => entry.uri);
  const { entries, truncated } = pack(candidates.filter(entry => !duplicate(entry)), list => recallAttachment(list, alreadyAttached));
  return { entries, truncated, alreadyAttached, content: entries.length || alreadyAttached.length ? memoryRecallContent(entries, alreadyAttached) : '' };
}
const recallAttachment = (entries, alreadyAttached = []) => ({ strategy: 'progressive', entries, ...(alreadyAttached.length ? { alreadyAttached: { note: ALREADY_ATTACHED_NOTE, uris: alreadyAttached } } : {}) });
/** The project-memory attachment text after the host reshaped a recall (filter, trim, pointers). */
export const memoryRecallContent = (entries, alreadyAttached = []) => JSON.stringify(recallAttachment(entries, alreadyAttached));
export function memoryHealthDiagnostic(value) {
  if (!value || !['health', 'authentication', 'readiness'].includes(value.phase)) return undefined;
  const diagnostic = { phase: value.phase };
  if (Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0) diagnostic.elapsedMs = Math.min(86400000, Math.round(value.elapsedMs));
  if (typeof value.timeout === 'boolean') diagnostic.timeout = value.timeout;
  if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) diagnostic.httpStatus = value.httpStatus;
  return diagnostic;
}
const fingerprint = remote => createHash('sha256').update(JSON.stringify([remote.config.endpoint, remote.headers['X-API-Key'] ?? '', remote.namespace])).digest('hex');
async function request(url, input) {
  const embedded = Boolean(input?.headers?.[EMBEDDED_BACKEND]);
  try { return await memoryRequest(requestJSON, url, input); }
  catch (error) { const unavailable = new Error(embedded ? `本地记忆未完成请求：${error.message}。` : `OpenViking 不可用：${error.message}。不会回退到本地记忆。`); unavailable.status = 503; unavailable.upstreamStatus = error.upstreamStatus; if (error.upstreamCode) unavailable.upstreamCode = error.upstreamCode; throw unavailable; }
}
/** The embedded engine's file for a state file: inside the journal root, which every release's checkpoint already inventories. */
export const embeddedMemoryFile = stateFile => `${stateFile}.rna/memory/embedded.sqlite`;
export class MemoryService {
  constructor(store) { this.store = store; this.identities = new Map(); this.embeddedMemory = null; }
  /** 'openviking' (a server) or 'embedded' (this process); results and health name the one in use. */
  get backend() { return this.store?.state?.configuration?.memory?.backend === 'embedded' ? 'embedded' : 'openviking'; }
  close() { this.embeddedMemory?.close(); this.embeddedMemory = null; }
  /**
   * The configured backend's connection: its settings and the headers every request carries. For the embedded engine
   * the address is its fixed name (what bindings and fingerprints record), no key is sent, and the headers carry the
   * engine itself, which answers in this process (memoryRequest).
   */
  connection(actorPeerId) {
    const config = structuredClone(this.store.state.configuration.memory);
    if (!MEMORY_BACKENDS.includes(config.backend)) fail('当前记忆配置尚未迁移；请重启服务', 503);
    if (config.backend !== 'embedded') { const key = this.store.configurationService.secret('openviking', config); return { config, headers: { ...(key ? { 'X-API-Key': key } : {}), 'X-OpenViking-Actor-Peer': actorPeerId } }; }
    if (typeof this.store.file !== 'string' || !this.store.file) fail('本地记忆需要状态文件；当前环境不可用', 503);
    this.embeddedMemory ??= new EmbeddedMemory(embeddedMemoryFile(this.store.file));
    return { config: { ...config, endpoint: EMBEDDED_MEMORY_ENDPOINT, apiKeyEnv: '' }, headers: { 'X-OpenViking-Actor-Peer': actorPeerId, [EMBEDDED_BACKEND]: this.embeddedMemory } };
  }
  remote(projectId) {
    const project = projectOf(this.store.state, projectId), actorPeerId = `forge-${project.id}`;
    return { namespace: memoryNamespace(project), actorPeerId, ...this.connection(actorPeerId) };
  }
  connectionFingerprint(projectId) { return fingerprint(this.remote(projectId)); }
  presentEntries(projectId, entries) {
    const namespace = memoryNamespace(projectOf(this.store.state, projectId));
    return entries.filter(row => this.evidenceResourceVisible(projectId, row.uri))
      .map(row => memoryEntryPresentation(this.store.state, projectId, namespace, row)).filter(Boolean);
  }
  evidenceResourceVisible(projectId, uri) {
    const project = projectOf(this.store.state, projectId), namespace = memoryNamespace(project), root = `${namespace}/rna-execution-evidence`, canonical = semanticURI(uri);
    const branch = within(canonical, root), ancestor = within(root, canonical) && within(canonical, namespace);
    if (!branch && !ancestor) return true;
    // A document whose own DELETE receipt says OpenViking regenerated this directory's summary without it (MEM-6) no
    // longer taints this directory; the directories above it still do.
    const related = this.store.state.sessions.filter(session => session.projectId === projectId).flatMap(session => (session.memoryEvidenceOutbox ?? []).filter(write => write.resourceIndex?.uri && within(write.resourceIndex.uri, canonical) && !rebuiltWithout(write.resourceIndex, canonical)).map(write => ({ session, write })));
    // Generated ancestor summaries can retain revoked text after file deletion.
    // Neither a DELETE receipt nor an unrelated refresh proves them clean.
    if ((this.store.state.sessionDeletions ?? []).some(record => record.projectId === projectId && [...(record.evidenceResources ?? []), ...(record.evidenceResourceRevocations ?? [])].some(row => within(row.uri, canonical)))) return false;
    if (!related.length) return !branch;
    return related.every(({ session, write }) => { try { return write.resourceIndex.status === 'completed' && typeof memoryEvidenceDocument(this.store.state, session.id, write) === 'string'; } catch { return false; } });
  }
  async writeEvidenceResource(projectId, sessionId, write, input = {}) {
    const remote = this.remote(projectId), index = write.resourceIndex;
    if (!/^viking:\/\/(?:resources\/|user\/[^/]+\/(?:resources\/|peers\/[^/]+\/resources\/))/.test(`${remote.namespace}/`)) throw cleanupError('MEMORY_EVIDENCE_SCOPE_CHANGED');
    if (index?.uri !== `${remote.namespace}/rna-execution-evidence/${sessionId}/${write.sourceRefs?.[0]?.sourceHash}.md` || index.connectionFingerprint !== fingerprint(remote)) throw cleanupError('MEMORY_EVIDENCE_SCOPE_CHANGED');
    const content = memoryEvidenceDocument(this.store.state, sessionId, write), contentHash = createHash('sha256').update(content).digest('hex');
    const userId = await this.identity(remote, { signal: input.signal });
    input.onDispatch?.({ userId, contentHash });
    const result = resultOf(await request(`${remote.config.endpoint}/api/v1/content/write`, { method: 'POST', headers: remote.headers, signal: input.signal,
      body: { uri: index.uri, content, mode: 'create', wait: true, timeout: 300, processing_mode: 'semantic_and_vectors' }, timeoutMs: EVIDENCE_WRITE_DEADLINE_MS }));
    const receipt = { userId, contentHash, uri: result?.uri, mode: result?.mode, writtenBytes: result?.written_bytes, contentUpdated: result?.content_updated === true, semanticStatus: result?.semantic_status, vectorStatus: result?.vector_status,
      queueErrors: ['Semantic', 'Embedding'].reduce((sum, kind) => sum + (Number(result?.queue_status?.[kind]?.error_count) || 0), 0), receivedAt: new Date().toISOString() };
    input.onReceipt?.(receipt);
    if (receipt.uri !== index.uri || receipt.mode !== 'create' || !receipt.contentUpdated || receipt.writtenBytes !== Buffer.byteLength(content) || receipt.semanticStatus !== 'complete' || receipt.vectorStatus !== 'complete' || receipt.queueErrors) return { ...receipt, complete: false, contentVerified: false };
    const actual = resultOf(await request(`${remote.config.endpoint}/api/v1/content/read?${new URLSearchParams({ uri: index.uri, offset: '0', limit: '-1', raw: 'true' })}`, { headers: remote.headers, signal: input.signal, timeoutMs: 15000 }));
    const contentVerified = typeof actual === 'string' && createHash('sha256').update(actual).digest('hex') === contentHash;
    return { ...receipt, contentVerified, complete: contentVerified };
  }
  /**
   * A write whose outcome was never confirmed (the host stopped mid-request): look at what the
   * service holds at that URI, read-only. 'matches' = exactly the content that was sent;
   * 'missing' = the service confirms nothing is there; anything else stays unconfirmed.
   */
  async verifyEvidenceWrite(projectId, index, input = {}) {
    const remote = this.remote(projectId), checkedAt = () => new Date().toISOString();
    if (index.connectionFingerprint !== fingerprint(remote) || typeof index.uri !== 'string' || !index.uri.startsWith(`${remote.namespace}/rna-execution-evidence/`) || !/^[a-f0-9]{64}$/.test(index.contentHash ?? '')) return { state: 'scope_changed' };
    if (await this.identity(remote, { signal: input.signal }) !== index.userId) return { state: 'scope_changed' };
    try { resultOf(await request(`${remote.config.endpoint}/api/v1/fs/stat?${new URLSearchParams({ uri: index.uri })}`, { headers: remote.headers, signal: input.signal, timeoutMs: 15000, captureErrorCode: true })); }
    catch (error) {
      if (error.upstreamStatus === 404 && error.upstreamCode === 'NOT_FOUND') return { state: 'missing', reconciliation: { method: 'GET', route: '/api/v1/fs/stat', result: 'not_found', checkedAt: checkedAt() } };
      throw error;
    }
    const actual = resultOf(await request(`${remote.config.endpoint}/api/v1/content/read?${new URLSearchParams({ uri: index.uri, offset: '0', limit: '-1', raw: 'true' })}`, { headers: remote.headers, signal: input.signal, timeoutMs: 15000 }));
    const matches = typeof actual === 'string' && createHash('sha256').update(actual).digest('hex') === index.contentHash;
    return { state: matches ? 'matches' : 'differs', reconciliation: { method: 'GET', route: '/api/v1/content/read', result: matches ? 'content_matches' : 'content_differs', checkedAt: checkedAt() } };
  }
  /**
   * Rebuild the semantic and vector index of one delivery document in place (B1), for a write whose receipt reported
   * that processing incomplete and whose exact content verifyEvidenceWrite found. The file itself is not written and
   * nothing is extracted. `complete` only for a finished rebuild of exactly this file with no failed records.
   */
  async reindexEvidenceResource(projectId, index, input = {}) {
    const remote = this.remote(projectId);
    if (index.connectionFingerprint !== fingerprint(remote) || typeof index.uri !== 'string' || !index.uri.startsWith(`${remote.namespace}/rna-execution-evidence/`)) throw cleanupError('MEMORY_EVIDENCE_SCOPE_CHANGED');
    const result = resultOf(await request(`${remote.config.endpoint}/api/v1/content/reindex`, { method: 'POST', headers: remote.headers, signal: input.signal,
      body: { uri: index.uri, mode: 'semantic_and_vectors', recursive: false, wait: true }, timeoutMs: EVIDENCE_WRITE_DEADLINE_MS }));
    const receipt = { status: typeof result?.status === 'string' ? result.status.slice(0, 32) : null, uri: result?.uri === index.uri ? index.uri : null, mode: result?.mode === 'semantic_and_vectors' ? result.mode : null,
      objectType: typeof result?.object_type === 'string' ? result.object_type.slice(0, 32) : null, rebuiltRecords: Number.isInteger(result?.rebuilt_records) ? result.rebuilt_records : null,
      failedRecords: Number.isInteger(result?.failed_records) ? result.failed_records : null, receivedAt: new Date().toISOString() };
    return { ...receipt, complete: receipt.status === 'completed' && receipt.uri === index.uri && receipt.mode === 'semantic_and_vectors' && receipt.objectType === 'resource' && receipt.failedRecords === 0 };
  }
  /**
   * Read-only (B3): every session_commit task OpenViking holds for one bound remote session, all pages, as
   * `{ tasks: [{ taskId, status }] }`. Throws when the binding, endpoint or authenticated identity no longer matches
   * (status 404/409: it can never be checked again) or when the listing is incomplete or malformed (503).
   */
  async sessionCommitTasks(projectId, sessionId, input = {}) {
    const remote = this.sessionBinding(projectId, sessionId), { config, headers, binding } = remote;
    if (await this.identity(remote, { signal: input.signal, fresh: true }) !== binding.userId) fail('OpenViking 用户身份已改变；不能核对原记忆会话', 409);
    const tasks = []; let cursor;
    for (let page = 0; page < 5; page++) {
      const params = new URLSearchParams({ task_type: 'session_commit', resource_id: sessionId, pagination: 'cursor', limit: '200', ...(cursor ? { cursor } : {}) });
      const list = resultOf(await request(`${config.endpoint}/api/v1/tasks?${params}`, { headers, signal: input.signal, timeoutMs: 15000 }));
      if (!Array.isArray(list?.items) || typeof list.has_more !== 'boolean') fail('OpenViking 任务列表结构不兼容', 503);
      for (const task of list.items) {
        if (typeof task?.task_id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(task.task_id) || task.task_type !== 'session_commit' || task.resource_id !== sessionId) fail('OpenViking 任务列表含有不属于此会话的任务', 503);
        tasks.push({ taskId: task.task_id, status: typeof task.status === 'string' ? task.status.slice(0, 32) : null });
      }
      if (!list.has_more) return { tasks };
      if (typeof list.next_cursor !== 'string' || !list.next_cursor || list.next_cursor === cursor) fail('OpenViking 任务列表分页无效', 503);
      cursor = list.next_cursor;
    }
    fail('OpenViking 任务列表过长，不能完整核对', 503);
  }
  /**
   * The pinned remote for removing a deleted conversation's evidence resource. A confirmed write proves ownership by
   * its receipt; with `unconfirmed` (a write whose outcome was never confirmed: 'uncertain', or 'partial' = stored but
   * not fully indexed) the identity and content hash recorded when it was sent stand in, and only the read-only
   * verifyDeletedEvidence may follow (X-4).
   */
  async evidenceCleanupRemote(record, resource, input = {}) {
    const unconfirmed = input.unconfirmed === true, userId = unconfirmed ? resource.userId : resource.receipt?.userId;
    if (!unconfirmed && (resource.receipt?.complete !== true || resource.receipt?.contentVerified !== true)) throw cleanupError('MEMORY_EVIDENCE_WRITE_UNCONFIRMED');
    if (unconfirmed && (typeof userId !== 'string' || !userId || !/^[a-f0-9]{64}$/.test(resource.contentHash ?? '') || !resource.dispatchedAt)) throw cleanupError('MEMORY_EVIDENCE_WRITE_UNCONFIRMED');
    if (!record.evidenceResources?.some(row => row.uri === resource.uri && row.sourceHash === resource.sourceHash) || !/^[a-f0-9]{64}$/.test(resource.sourceHash ?? '') || resource.uri !== `${resource.namespace}/rna-execution-evidence/${record.sessionId}/${resource.sourceHash}.md`) throw cleanupError('MEMORY_EVIDENCE_IDENTITY_UNVERIFIED');
    if (validateNamespace(resource.namespace) !== resource.namespace) throw cleanupError('MEMORY_EVIDENCE_IDENTITY_UNVERIFIED');
    remoteId(record.sessionId); remoteId(record.projectId);
    const pinned = () => {
      input.signal?.throwIfAborted();
      input.guard?.();
      const project = this.store.state.projects.find(row => row.id === record.projectId);
      const { config, headers } = this.connection(`forge-${record.projectId}`);
      const remote = { config, namespace: resource.namespace, headers };
      if (project && memoryNamespace(project) !== resource.namespace || fingerprint(remote) !== resource.connectionFingerprint) throw cleanupError('MEMORY_EVIDENCE_SCOPE_CHANGED');
      return remote;
    };
    const remote = pinned();
    if (await this.identity(remote, { signal: input.signal, fresh: true }) !== userId) throw cleanupError('MEMORY_EVIDENCE_SCOPE_CHANGED');
    pinned(); return { remote, guard: pinned };
  }
  /**
   * A deleted conversation's evidence resource whose write was never confirmed, after the write deadline: what the
   * service holds at that URI, read-only. 'matches' = exactly the content sent (ownership proven, it may be deleted);
   * 'missing' = the service confirms nothing is there; 'differs' = something else is there (never deleted).
   */
  async verifyDeletedEvidence(record, resource, input = {}) {
    const { remote, guard } = await this.evidenceCleanupRemote(record, resource, { ...input, unconfirmed: true }), checkedAt = () => new Date().toISOString();
    try { resultOf(await request(`${remote.config.endpoint}/api/v1/fs/stat?${new URLSearchParams({ uri: resource.uri })}`, { headers: remote.headers, signal: input.signal, timeoutMs: 15000, captureErrorCode: true })); }
    catch (error) {
      guard();
      if (error.upstreamStatus === 404 && error.upstreamCode === 'NOT_FOUND') return { state: 'missing', reconciliation: { method: 'GET', route: '/api/v1/fs/stat', result: 'not_found', checkedAt: checkedAt() } };
      throw error;
    }
    guard();
    const actual = resultOf(await request(`${remote.config.endpoint}/api/v1/content/read?${new URLSearchParams({ uri: resource.uri, offset: '0', limit: '-1', raw: 'true' })}`, { headers: remote.headers, signal: input.signal, timeoutMs: 15000 }));
    guard();
    const matches = typeof actual === 'string' && createHash('sha256').update(actual).digest('hex') === resource.contentHash;
    return { state: matches ? 'matches' : 'differs', reconciliation: { method: 'GET', route: '/api/v1/content/read', result: matches ? 'content_matches' : 'content_differs', checkedAt: checkedAt() } };
  }
  /** DELETE a deleted conversation's unconfirmed evidence resource that verifyDeletedEvidence found to hold exactly what was sent.
   * The guard runs before the DELETE; once the service confirmed it, the removal happened and is reported as such (B4). */
  async deleteVerifiedEvidence(record, resource, input = {}) {
    const { remote, guard } = await this.evidenceCleanupRemote(record, resource, { ...input, unconfirmed: true });
    let result;
    try {
      result = resultOf(await request(`${remote.config.endpoint}/api/v1/fs?${new URLSearchParams({ uri: resource.uri, recursive: 'false', wait: 'true', timeout: '30' })}`, { method: 'DELETE', headers: remote.headers, signal: input.signal, timeoutMs: 45000 }));
      if (result?.uri !== resource.uri) throw cleanupError('MEMORY_EVIDENCE_DELETE_UNCONFIRMED');
    } catch (error) { guard(); throw error; }
    return { uri: resource.uri, deleted: true, ...semanticReceipt(resource.uri, result) };
  }
  async reconcileEvidenceResource(record, resource, input = {}) {
    const { remote, guard } = await this.evidenceCleanupRemote(record, resource, input);
    try {
      resultOf(await request(`${remote.config.endpoint}/api/v1/fs/stat?${new URLSearchParams({ uri: resource.uri })}`, { headers: remote.headers, signal: input.signal, timeoutMs: 15000, captureErrorCode: true }));
      guard();
      return { uri: resource.uri, deleted: false, reconciliation: { method: 'GET', route: '/api/v1/fs/stat', result: 'exists', checkedAt: new Date().toISOString(), connectionFingerprint: resource.connectionFingerprint, userId: resource.receipt.userId } };
    } catch (error) {
      guard();
      if (error.upstreamStatus !== 404 || error.upstreamCode !== 'NOT_FOUND') throw error;
      return { uri: resource.uri, deleted: true, reconciliation: { method: 'GET', route: '/api/v1/fs/stat', result: 'not_found', upstreamStatus: 404, upstreamCode: 'NOT_FOUND', checkedAt: new Date().toISOString(), connectionFingerprint: resource.connectionFingerprint, userId: resource.receipt.userId } };
    }
  }
  async deleteEvidenceResource(record, resource, input = {}) {
    // An earlier delete may already have taken effect. Never replay it merely
    // because a later semantic refresh failed, including legacy failed rows.
    if (resource.status !== 'completed' || resource.cleanup) {
      const receipt = await this.reconcileEvidenceResource(record, resource, input);
      if (!receipt.deleted) throw cleanupError('MEMORY_EVIDENCE_DELETE_UNCONFIRMED');
      return receipt;
    }
    const { remote, guard } = await this.evidenceCleanupRemote(record, resource, input);
    const { config } = remote;
    let result;
    try {
      result = resultOf(await request(`${config.endpoint}/api/v1/fs?${new URLSearchParams({ uri: resource.uri, recursive: 'false', wait: 'true', timeout: '30' })}`, { method: 'DELETE', headers: remote.headers, signal: input.signal, timeoutMs: 45000 }));
      if (result?.uri !== resource.uri) throw cleanupError('MEMORY_EVIDENCE_DELETE_UNCONFIRMED');
    } catch (error) { guard(); throw error; }
    // The guard ran before the DELETE (evidenceCleanupRemote). A confirmed removal is reported even when the source
    // came back meanwhile (B4): the caller then writes it again instead of believing the removal was stopped. The
    // parent directory's refresh receipt rides along (MEM-6).
    return { uri: resource.uri, deleted: true, ...semanticReceipt(resource.uri, result) };
  }
  updateSessionBinding(projectId, sessionId, update) {
    this.store.mutate(state => {
      const binding = state.projects.find(project => project.id === projectId)?.memorySessions?.find(row => row.sessionId === sessionId);
      if (binding) update(binding);
      // A dispatched create/commit may settle after local deletion. Its durable
      // tombstone must receive the late receipt even if the project is gone.
      for (const record of state.sessionDeletions ?? []) if (record.projectId === projectId) {
        const removed = record.bindings.find(row => row.sessionId === sessionId);
        if (removed) update(removed);
      }
    });
  }
  async dispatchSessionMutation(projectId, sessionId, url, input) {
    const requestId = randomUUID();
    this.store.mutate(state => {
      if (state.sessionDeletions?.some(record => record.bindings.some(binding => binding.sessionId === sessionId))) throw cleanupError('MEMORY_CLEANUP_SOURCE_DELETED');
      const binding = projectOf(state, projectId).memorySessions?.find(row => row.sessionId === sessionId) ?? fail('远端记忆会话已不存在', 404);
      binding.pendingRequests ??= []; binding.pendingRequests.push({ id: requestId, status: 'inflight' });
    });
    const settle = uncertain => this.updateSessionBinding(projectId, sessionId, binding => {
      if (uncertain) { const pending = binding.pendingRequests?.find(row => row.id === requestId); if (pending) pending.status = 'uncertain'; }
      else binding.pendingRequests = (binding.pendingRequests ?? []).filter(row => row.id !== requestId);
    });
    try { const result = resultOf(await request(url, input)); settle(false); return result; }
    catch (error) { settle(!(error.upstreamStatus >= 400 && error.upstreamStatus < 500)); throw error; }
  }
  /**
   * The identity-checked, pinned view of one bound remote session that every cleanup of it works through: a deleted
   * conversation (deleteSessionArchive) and a rewind (D5: reading the archives' memory diffs, rolling memories back).
   * The binding must be the one the record names, on the connection and account it was created on; `call(path, method,
   * { body, timeoutMs })` goes only to that endpoint with that identity (re-checked before each request) and returns the
   * response's `result`. Throws MEMORY_CLEANUP_* codes.
   */
  async sessionCleanupRemote(record, binding, signal) {
    const id = remoteId(binding?.sessionId), actorPeerId = `forge-${remoteId(record.projectId)}`; remoteId(record.sessionId);
    if (!record.bindings?.some(row => row.sessionId === id && row.userId === binding.userId && row.namespace === binding.namespace && row.endpoint === binding.endpoint) || binding.isolation !== 'project-peer-v1' || binding.actorPeerId !== actorPeerId || binding.sourceSessionId && binding.sourceSessionId !== record.sessionId || validateNamespace(binding.namespace) !== binding.namespace || !Array.isArray(binding.taskIds)) throw cleanupError('MEMORY_CLEANUP_IDENTITY_UNVERIFIED');
    const pinnedRemote = () => {
      const { config, headers } = this.connection(actorPeerId);
      const remote = { config, namespace: binding.namespace, actorPeerId, headers };
      if (config.endpoint !== binding.endpoint || fingerprint(remote) !== record.connectionFingerprint || binding.connectionFingerprint && binding.connectionFingerprint !== record.connectionFingerprint) throw cleanupError('MEMORY_CLEANUP_CONNECTION_CHANGED');
      return remote;
    };
    const remote = pinnedRemote();
    if (binding.pendingRequests?.length || binding.cleanupOutcomeUnknown) throw cleanupError('MEMORY_CLEANUP_WRITE_UNCONFIRMED');
    if (await this.identity(remote, { signal, fresh: true }) !== binding.userId || binding.memoryNamespace !== `viking://user/${binding.userId}/peers/${actorPeerId}/memories`) throw cleanupError('MEMORY_CLEANUP_IDENTITY_CHANGED');
    const call = async (path, method = 'GET', { body, timeoutMs = 15000 } = {}) => { const current = pinnedRemote(); return resultOf(await request(`${current.config.endpoint}/api/v1/${path}`, { method, headers: current.headers, signal, timeoutMs, ...(body === undefined ? {} : { body }) })); };
    return { id, call, signal, userId: binding.userId, memoryNamespace: binding.memoryNamespace, sessionUri: `viking://user/${binding.userId}/sessions/${id}` };
  }
  /**
   * Deletes one bound remote session of a deleted conversation (the memories extracted from it stay) after every
   * commit task of it ended. `beforeDelete({ call, sessionUri, memoryNamespace, … })` (D5, a rewind) runs once the tasks
   * ended and before the session, with its archives and their memory diffs, goes: what it returns is reported as
   * `rollback`; when it throws the session is NOT deleted (a retry finds the archives again).
   */
  async deleteSessionArchive(record, binding, input = {}) {
    try {
      const deadline = AbortSignal.timeout(input.deadlineMs ?? 30000), signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
      const remote = await this.sessionCleanupRemote(record, binding, signal), { id, call } = remote;
      try {
        const session = await call(`sessions/${id}`);
        if (session?.session_id !== id || session.uri?.replace(/\/+$/, '') !== `viking://user/${binding.userId}/sessions/${id}` || session.user?.user_id !== binding.userId) throw cleanupError('MEMORY_CLEANUP_IDENTITY_UNVERIFIED');
        if (session.auto_commit_policy != null) throw cleanupError('MEMORY_CLEANUP_AUTOCOMMIT_ACTIVE');
      } catch (error) { if (error.upstreamStatus !== 404) throw error; }
      const tasks = new Map(); let cursor, complete = false;
      // Discover commits whose acceptance receipt was lost. A known task list
      // alone cannot prove that an ambiguous commit is no longer writing.
      for (let page = 0; page < 5; page++) {
        const params = new URLSearchParams({ task_type: 'session_commit', resource_id: id, pagination: 'cursor', limit: '200', ...(cursor ? { cursor } : {}) });
        const list = await call(`tasks?${params}`);
        if (!Array.isArray(list?.items) || typeof list.has_more !== 'boolean') throw cleanupError('MEMORY_CLEANUP_TASKS_UNVERIFIED');
        for (const task of list.items) tasks.set(remoteId(task.task_id), task);
        if (!list.has_more) { complete = true; break; }
        if (typeof list.next_cursor !== 'string' || !list.next_cursor || list.next_cursor === cursor) throw cleanupError('MEMORY_CLEANUP_TASKS_UNVERIFIED');
        cursor = list.next_cursor;
      }
      if (!complete || binding.taskIds.length > 1000) throw cleanupError('MEMORY_CLEANUP_TASKS_UNVERIFIED');
      for (const taskId of binding.taskIds) if (!tasks.has(remoteId(taskId))) {
        try { tasks.set(taskId, await call(`tasks/${taskId}`)); } catch (error) { if (error.upstreamStatus !== 404) throw error; }
      }
      const verifyTask = (task, taskId) => {
        if (task?.task_id !== taskId || task.task_type !== 'session_commit' || task.resource_id !== id || task.result?.session_id && task.result.session_id !== id) throw cleanupError('MEMORY_CLEANUP_TASK_IDENTITY_UNVERIFIED');
        if (!['pending', 'running', 'cancelling', 'completed', 'failed', 'cancelled'].includes(task.status)) throw cleanupError('MEMORY_CLEANUP_TASKS_UNVERIFIED');
        return ['completed', 'failed', 'cancelled'].includes(task.status);
      };
      for (const [taskId, task] of tasks) {
        if (verifyTask(task, taskId)) continue;
        if (task.status !== 'cancelling') {
          try { verifyTask(await call(`tasks/${taskId}/cancel`, 'POST'), taskId); }
          catch (error) { if (error.upstreamStatus !== 409) throw error; }
        }
        if (!verifyTask(await call(`tasks/${taskId}`), taskId)) throw cleanupError('MEMORY_CLEANUP_TASK_PENDING');
      }
      const rollback = typeof input.beforeDelete === 'function' ? await input.beforeDelete(remote) : undefined;
      try {
        const result = await call(`sessions/${id}`, 'DELETE');
        if (result?.session_id !== id) throw cleanupError('MEMORY_CLEANUP_DELETE_UNCONFIRMED');
      } catch (error) { if (error.upstreamStatus !== 404) throw error; }
      return { sessionId: id, deleted: true, memoriesPreserved: true, resourcesPreserved: true, ...(rollback === undefined ? {} : { rollback }) };
    } catch (error) {
      if (/^MEMORY_CLEANUP_[A-Z_]+$/.test(error.code ?? '')) throw error;
      throw cleanupError('MEMORY_CLEANUP_UNAVAILABLE');
    }
  }
  /**
   * Read-only look at one bound remote session through the same identity checks (the rewind's dry run, D5):
   * `inspect({ call, sessionUri, memoryNamespace, … })` may only read. No task is cancelled and nothing is deleted.
   */
  async inspectSession(record, binding, input = {}) {
    try {
      const deadline = AbortSignal.timeout(input.deadlineMs ?? 30000), signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
      return await input.inspect(await this.sessionCleanupRemote(record, binding, signal));
    } catch (error) {
      if (/^MEMORY_CLEANUP_[A-Z_]+$/.test(error.code ?? '')) throw error;
      throw cleanupError('MEMORY_CLEANUP_UNAVAILABLE');
    }
  }
  async identity(remote, input = {}) {
    const key = createHash('sha256').update(JSON.stringify([remote.config.endpoint, remote.headers['X-API-Key'] ?? ''])).digest('hex');
    const cached = this.identities.get(key);
    if (!input.fresh && cached && cached.expiresAt > Date.now()) return cached.userId;
    const status = resultOf(await request(`${remote.config.endpoint}/api/v1/system/status`, { headers: remote.headers, signal: input.signal }));
    const userId = status?.user;
    if (status?.initialized !== true || typeof userId !== 'string' || !/^[A-Za-z0-9_.@-]+$/.test(userId) || ['.', '..'].includes(userId) || (userId.match(/@/g) ?? []).length > 1) fail('OpenViking 未返回可验证的用户身份；不能确定项目记忆范围', 503);
    this.identities.clear(); this.identities.set(key, { userId, expiresAt: Date.now() + 60000 });
    return userId;
  }
  /** Whether the service answers its status now (one free read): tells an outage from the failure of one request. */
  async reachable(projectId, input = {}) {
    try { await this.identity(this.remote(projectId), { fresh: true, signal: input.signal }); return true; } catch { return false; }
  }
  async scopes(projectId, input = {}) {
    const remote = this.remote(projectId);
    // A project with no extraction session has no peer memories yet. Keep
    // resource-only setups usable without inventing an authenticated user id.
    const bound = projectOf(this.store.state, projectId).memorySessions?.some(binding => binding.isolation === 'project-peer-v1' && binding.endpoint === remote.config.endpoint && binding.namespace === remote.namespace);
    if (!bound) return { ...remote, scopes: [remote.namespace] };
    const userId = await this.identity(remote, input), memoryNamespace = `viking://user/${userId}/peers/${remote.actorPeerId}/memories`;
    return { ...remote, userId, memoryNamespace, scopes: [remote.namespace, memoryNamespace] };
  }
  async list(projectId, input = {}) {
    if (input.query?.trim()) return this.search(projectId, input);
    return this.browse(projectId, input);
  }
  async health(projectId) {
    return this.healthRemote(this.remote(projectId));
  }
  async healthRemote({ config, headers }, input = {}) {
    const probe = async (phase, operation) => {
      const started = performance.now();
      try { return await operation(); }
      catch (error) {
        const timeout = input.signal?.aborted ? input.signal.reason?.name === 'TimeoutError' : error.upstreamStatus ? false : undefined;
        error.memoryDiagnostic = memoryHealthDiagnostic({ phase, elapsedMs: performance.now() - started, timeout, httpStatus: error.upstreamStatus });
        throw error;
      }
    };
    const health = await probe('health', async () => {
      const health = await request(`${config.endpoint}/health`, { headers, signal: input.signal });
      if (health?.status !== 'ok' || health.healthy !== true) fail(headers?.[EMBEDDED_BACKEND] ? '本地记忆未报告健康状态' : 'OpenViking 未报告健康状态；不会回退到本地记忆', 503);
      return health;
    });
    await probe('authentication', async () => {
      const status = resultOf(await request(`${config.endpoint}/api/v1/system/status`, { headers, signal: input.signal }));
      if (status?.initialized !== true) fail('OpenViking 尚未初始化完成；不会回退到本地记忆', 503);
    });
    // /health only proves HTTP liveness; /system/status proves authenticated
    // initialization. Neither checks the embedding provider. Do not copy raw
    // readiness diagnostics into status: upstream errors may contain secrets.
    let readiness;
    try {
      const report = await probe('readiness', () => request(`${config.endpoint}/ready`, { headers, signal: input.signal }));
      const checks = report?.checks;
      const agfs = checks?.agfs;
      const filesystemReady = agfs === 'ok' || (agfs?.status === 'ok' && agfs?.checks?.filesystem === 'ok');
      const vectorReady = checks?.vectordb === 'ok', embeddingReady = checks?.embedding === 'ok';
      const verified = report?.status === 'ready' && filesystemReady && vectorReady && embeddingReady;
      readiness = { status: verified ? 'ready' : 'not_ready', supported: true,
        filesystem: filesystemReady ? 'ready' : 'not_verified', vectorStore: vectorReady ? 'ready' : 'not_verified',
        embedding: embeddingReady ? 'ready' : 'not_verified', vlm: 'not_verified', semanticQuality: 'not_assessed',
        ...(verified ? {} : { reason: 'DEPENDENCY_READINESS_NOT_CONFIRMED' }) };
    } catch (error) {
      if (input.signal?.aborted && input.signal.reason && typeof input.signal.reason === 'object' && Object.isExtensible(input.signal.reason)) input.signal.reason.memoryDiagnostic = error.memoryDiagnostic;
      input.signal?.throwIfAborted();
      const unsupported = [404, 405].includes(error.upstreamStatus);
      readiness = { status: unsupported ? 'not_supported' : 'not_ready', supported: !unsupported,
        filesystem: 'not_verified', vectorStore: 'not_verified', embedding: 'not_verified', vlm: 'not_verified', semanticQuality: 'not_assessed',
        reason: unsupported ? 'READINESS_ENDPOINT_NOT_SUPPORTED' : 'READINESS_REQUEST_FAILED',
        ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}), diagnostic: error.memoryDiagnostic };
    }
    // The embedded engine searches by words: it has no vector store, embedding model or summarising model to be ready.
    if (headers?.[EMBEDDED_BACKEND] && readiness.status === 'ready') readiness = { ...readiness, vectorStore: 'not_used', embedding: 'not_used', vlm: 'not_used', semanticQuality: 'keyword_only' };
    return { backend: MEMORY_BACKENDS.includes(config?.backend) ? config.backend : this.backend, connected: true, authenticated: true, initialized: true,
      liveness: { status: 'alive' }, ready: readiness.status === 'ready', readiness,
      version: typeof health.version === 'string' ? health.version : null, checkedAt: new Date().toISOString(), simulated: false };
  }
  async initialize(projectId) {
    return this.initializeRemote(this.remote(projectId), projectOf(this.store.state, projectId));
  }
  async initializeRemote(remote, project, input = {}) {
    const { namespace, config, headers } = remote;
    try {
      resultOf(await request(`${config.endpoint}/api/v1/fs/mkdir`, { method: 'POST', headers, body: { uri: namespace, description: project.description || project.name }, signal: input.signal }));
    } catch (error) {
      if (error.upstreamStatus !== 409) throw error;
      await this.browseRemote(remote, { signal: input.signal });
      return { backend: this.backend, namespace, initialized: true, existed: true, simulated: false };
    }
    return { backend: this.backend, namespace, initialized: true, existed: false, simulated: false };
  }
  async write(projectId, id, input = {}, remove = false) {
    if (remove) fail('当前不开放远端记忆删除', 405);
    const { namespace, config, headers } = this.remote(projectId);
    const uri = input.uri ?? (id ? `${namespace}/${remoteId(id)}.md` : `${namespace}/${randomUUID()}.md`);
    if (uri === namespace || !within(uri, namespace)) fail('只能写入当前项目命名空间内的文件', 403);
    const content = text(input.content, '记忆内容', 30000), title = input.title === undefined ? null : text(input.title, '记忆标题', 160);
    const mode = input.mode ?? (id ? 'replace' : 'create');
    if (!['create', 'replace', 'append', 'upsert'].includes(mode)) fail('写入方式必须为 create、replace、append 或 upsert');
    const written = title && mode === 'create' ? `# ${title}\n\n${content}` : content;
    if (within(uri, `${namespace}/rna-execution-evidence`)) fail('执行资料由来源同步队列管理，不能覆盖原始回执', 403);
    const result = resultOf(await request(`${config.endpoint}/api/v1/content/write`, { method: 'POST', headers, body: { uri, content: written, mode, wait: false }, timeoutMs: 15000 }));
    return { backend: this.backend, namespace, uri, mode, accepted: true, semanticStatus: result?.semantic_status ?? 'pending', result, simulated: false };
  }
  async search(projectId, input = {}) {
    const remote = await this.scopes(projectId, input), { namespace, scopes, config, headers } = remote, { level, limit } = options(config, input);
    const query = text(input.query, '搜索内容', 1000);
    const responses = await Promise.all(scopes.map(async scope => {
      const response = resultOf(await request(`${config.endpoint}/api/v1/search/find`, { method: 'POST', headers, body: { query, target_uri: scope, limit, ...(level ? { level: level.slice(1) } : {}), read_content: false }, signal: input.signal }));
      if (!response || typeof response !== 'object') fail('OpenViking 搜索响应结构不兼容', 503);
      return ['memories', 'resources', 'skills'].flatMap(key => Array.isArray(response[key]) ? response[key] : []).filter(row => row && row.access !== 'denied' && within(row.uri, scope) && this.evidenceResourceVisible(projectId, row.uri));
    }));
    const seen = new Set();
    const hits = responses.flat().sort((a, b) => (Number.isFinite(b.score) ? b.score : -Infinity) - (Number.isFinite(a.score) ? a.score : -Infinity)).filter(row => { if (seen.has(row.uri)) return false; seen.add(row.uri); return true; });
    const entries = this.presentEntries(projectId, hits.slice(0, limit).map(row => ({ ...candidate(row), kind: memoryEntryKind(row.uri, remote) })));
    return { backend: this.backend, namespace, scopes, entries, total: entries.length, selection: level ?? 'all', ...(level ? { level } : {}), strategy: 'progressive', simulated: false };
  }
  async recall(projectId, input = {}) {
    const remote = this.remote(projectId), configured = remote.config.contextBudget ?? 2048;
    const budgetTokens = Math.min(configured, integer(input.budgetTokens, '本轮记忆预算', configured, 0, 16000));
    const empty = { backend: this.backend, namespace: remote.namespace, strategy: 'progressive', stage: 'summaries', entries: [], content: '', estimatedTokens: 0, budgetTokens, truncated: false, candidateCount: 0, simulated: false };
    if (remote.config.autoRecall === false) return { ...empty, status: 'disabled' };
    if (!budgetTokens) return { ...empty, status: 'budget-exhausted' };
    text(input.query, '搜索内容', 1000); options(remote.config, { limit: input.limit });
    input.signal?.throwIfAborted();
    // This is also the authenticated first-use project-root setup. Do not hide
    // wrong endpoints, missing child directories, or failed credentials as empty.
    await this.browse(projectId, { limit: 1, signal: input.signal });
    input.signal?.throwIfAborted();
    const found = await this.search(projectId, { query: input.query, limit: input.limit, signal: input.signal });
    const seen = new Set(), candidates = found.entries.filter(entry => { if (entry.summaryStatus !== 'ready' || seen.has(entry.expandUri)) return false; seen.add(entry.expandUri); return true; });
    // MIND-13: passages the conversation already holds unchanged give their budget to the next candidates.
    const exclude = input.exclude instanceof Map ? input.exclude : null;
    const { entries, truncated, alreadyAttached, content } = packMemoryRecall(candidates, budgetTokens, { exclude });
    const fresh = candidates.length - (exclude?.size ? candidates.filter(entry => exclude.get(entry.uri)?.has(passageHash(entry.summary))).length : 0);
    // `candidates` (every ready candidate, full summaries) lets a caller that learns what is already attached only later
    // (a turn-start prefetch) pack again without another search.
    return { ...empty, entries, content, estimatedTokens: estimateMemoryTokens(content), truncated: truncated || entries.length < fresh, candidateCount: candidates.length, candidates: candidates.map(({ uri, expandUri, level, isLeaf, availableReads, summary }) => ({ uri, expandUri, level, isLeaf, availableReads, summary })),
      ...(alreadyAttached.length ? { alreadyAttached } : {}), status: entries.length ? 'ready' : alreadyAttached.length ? 'already-attached' : candidates.length ? 'budget-exhausted' : 'empty' };
  }
  async browse(projectId, input = {}) {
    const remote = await this.scopes(projectId, input), project = projectOf(this.store.state, projectId);
    if (input.view !== undefined && !['recent', 'directory'].includes(input.view)) fail('记忆浏览视图必须为 recent 或 directory');
    if (input.view === 'recent') return recentMemory(this, projectId, input, remote);
    const describe = result => {
      const entries = this.presentEntries(projectId, result.entries.map(row => ({ ...row, kind: memoryEntryKind(row.uri, remote) })));
      return { ...result, view: 'directory', entries, total: entries.length, pageCounts: { directories: entries.filter(row => row.isDirectory).length, files: entries.filter(row => row.isLeaf).length } };
    };
    if (input.uri && input.uri !== remote.namespace && remote.memoryNamespace && within(input.uri, remote.memoryNamespace)) return describe(await this.browseRemote({ ...remote, namespace: remote.memoryNamespace }, input));
    const { limit } = options(remote.config, input), offset = integer(input.offset, '目录起始位置', 0, 0, 10000);
    const mergedRoot = (input.uri ?? remote.namespace) === remote.namespace && remote.memoryNamespace;
    // Fetch enough sorted entries from each scope to derive the exact global
    // page. Applying offset separately to each scope would skip valid entries.
    const prefix = mergedRoot ? { offset: 0, limit: offset + limit + 1 } : undefined;
    let result;
    try { result = await this.browseRemote(remote, input, prefix); }
    catch (error) {
      // Only a missing current-project root is eligible for first-use setup.
      // Authenticate the actual service before creating anything; wrong API
      // endpoints, unavailable services and missing child directories stay errors.
      if (error.upstreamStatus !== 404 || (input.uri ?? remote.namespace) !== remote.namespace) throw error;
      input.signal?.throwIfAborted();
      await this.healthRemote(remote, input);
      await this.initializeRemote(remote, project, input);
      result = await this.browseRemote(remote, input, prefix);
    }
    if ((input.uri ?? remote.namespace) === remote.namespace && remote.memoryNamespace) {
      let scopeOverflow = result.hasMore;
      try {
        // The UI explicitly sends the resource root. Peer memories are a
        // separate authenticated root; never reuse that resource URI here.
        const extracted = await this.browseRemote({ ...remote, namespace: remote.memoryNamespace }, { ...input, uri: remote.memoryNamespace }, prefix);
        result.entries = [...result.entries, ...extracted.entries];
        scopeOverflow ||= extracted.hasMore;
      } catch (error) { if (error.upstreamStatus !== 404) throw error; /* No extraction has created this peer root yet. */ }
      result.entries = [...new Map(result.entries.map(entry => [entry.uri, entry])).values()].sort(compareMemoryEntries);
      const hasMore = scopeOverflow || result.entries.length > offset + limit;
      result.entries = result.entries.slice(offset, offset + limit);
      Object.assign(result, { total: result.entries.length, offset, limit, hasMore, nextOffset: hasMore && offset + result.entries.length <= 10000 ? offset + result.entries.length : null, paginationLimited: hasMore && offset + result.entries.length > 10000 });
    }
    result.entries = result.entries.filter(entry => this.evidenceResourceVisible(projectId, entry.uri)); result.total = result.entries.length;
    return describe(result);
  }
  async browseRemote({ namespace, config, headers }, input = {}, prefix) {
    const limit = prefix?.limit ?? options(config, input).limit, offset = prefix?.offset ?? integer(input.offset, '目录起始位置', 0, 0, 10000), uri = input.uri ?? namespace;
    if (!within(uri, namespace)) fail('只能浏览当前项目命名空间内的记忆', 403);
    // OpenViking sorts directories/files separately; equal mtimes use a
    // case-insensitive then original-name tie break before offset is applied.
    const values = new URLSearchParams({ uri, output: 'original', node_limit: String(limit + 1), offset: String(offset), recursive: 'false', sort_by: 'mtime', sort_order: 'desc' });
    const rows = resultOf(await request(`${config.endpoint}/api/v1/fs/ls?${values}`, { headers, signal: input.signal }));
    if (!Array.isArray(rows)) fail('OpenViking 目录响应结构不兼容', 503);
    const entries = rows.slice(0, limit).filter(row => row && row.access !== 'denied' && within(row.uri, namespace)).map(row => ({ id: row.uri, uri: row.uri, expandUri: row.uri, title: String(row.name ?? row.uri.split('/').at(-1)), isDirectory: row.isDir === true, isLeaf: row.isDir === false, availableReads: row.isDir === true ? ['L0', 'L1'] : row.isDir === false ? ['L2'] : [], size: Number(row.size) || 0, modifiedAt: Number.isFinite(Date.parse(row.modTime)) ? new Date(row.modTime).toISOString() : null, source: 'openviking' }));
    const hasMore = rows.length > limit;
    return { backend: this.backend, namespace, uri, entries, total: entries.length, offset, limit, hasMore, nextOffset: hasMore && offset + limit <= 10000 ? offset + limit : null, paginationLimited: hasMore && offset + limit > 10000, sort: { by: 'mtime', order: 'desc' }, strategy: 'progressive', simulated: false };
  }
  async read(projectId, input = {}) {
    const { namespace, scopes, config, headers } = await this.scopes(projectId, input), level = options(config, { level: input.level }).level ?? 'L2';
    const requestedUri = text(input.uri, '记忆 URI', 2000);
    let uri = requestedUri;
    if (!this.evidenceResourceVisible(projectId, uri)) fail('执行资料的来源不可用，不能读取已撤销或待核对的记录', 403);
    if (!scopes.some(scope => within(uri, scope))) fail('只能读取当前项目命名空间内的记忆', 403);
    const offset = integer(input.offset, '读取起始行', 0, 0, 1000000), limit = integer(input.limit, '读取行数', 200, 1, 500), maxChars = integer(input.maxChars, '读取字符上限', 16000, 256, 64000);
    if (level !== 'L2') {
      uri = semanticURI(uri);
      if (uri === requestedUri) {
        const info = resultOf(await request(`${config.endpoint}/api/v1/fs/stat?${new URLSearchParams({ uri })}`, { headers, signal: input.signal }));
        if (!info || typeof info !== 'object' || typeof info.isDir !== 'boolean') fail('OpenViking 文件信息响应结构不兼容', 503);
        if (!info.isDir) uri = uri.slice(0, uri.lastIndexOf('/'));
      }
      if (!scopes.some(scope => within(uri, scope))) fail('只能读取当前项目命名空间内的目录摘要', 403);
      if (!this.evidenceResourceVisible(projectId, uri)) fail('执行资料目录含未确认或已撤销来源，暂不能读取摘要', 403);
    }
    const method = { L0: 'abstract', L1: 'overview', L2: 'read' }[level], params = new URLSearchParams({ uri });
    if (level === 'L2') { params.set('offset', String(offset)); params.set('limit', String(limit)); }
    let content;
    try { content = resultOf(await request(`${config.endpoint}/api/v1/content/${method}?${params}`, { headers, signal: input.signal })); }
    catch (error) {
      if (level !== 'L2' && error.upstreamStatus === 404) {
        error.message = `此目录尚无可读取的${level === 'L0' ? '摘要' : '概览'}，可能尚未生成或已被移除。`;
        error.status = 404; error.code = 'MEMORY_LAYER_UNAVAILABLE';
      }
      throw error;
    }
    if (typeof content !== 'string') fail('OpenViking 内容响应结构不兼容', 503);
    if (level !== 'L2' && !content.trim()) throw Object.assign(new Error(`此目录尚无可读取的${level === 'L0' ? '摘要' : '概览'}，可能尚未生成或内容为空。`), { status: 404, code: 'MEMORY_LAYER_UNAVAILABLE', upstreamStatus: 200 });
    if (level !== 'L2' && isMemoryDirectoryPlaceholder(content, uri)) throw Object.assign(new Error('目录摘要尚未生成，可浏览目录读取原文。'), { status: 404, code: 'MEMORY_LAYER_UNAVAILABLE', upstreamStatus: 200 });
    const characters = Array.from(content), clipped = characters.slice(0, maxChars).join(''), returnedLines = content ? content.split('\n').length - Number(content.endsWith('\n')) : 0;
    return { backend: this.backend, namespace, requestedUri, uri, level, content: clipped, source: 'openviking', scope: level === 'L2' ? 'file' : 'directory', truncated: characters.length > maxChars, estimatedTokens: estimateMemoryTokens(clipped), ...(level === 'L2' ? { offset, limit, returnedLines, possiblyMore: returnedLines >= limit, nextOffset: characters.length > maxChars ? null : returnedLines >= limit ? offset + returnedLines : null } : {}), maxChars, simulated: false };
  }
  sessionBinding(projectId, sessionId) {
    const project = projectOf(this.store.state, projectId), remote = this.remote(projectId);
    const binding = project.memorySessions?.find(s => s.sessionId === remoteId(sessionId)) ?? fail('OpenViking 会话不属于当前项目', 404);
    if (binding.endpoint !== remote.config.endpoint) fail('此会话属于之前的 OpenViking 服务；请恢复原地址或创建新会话', 409);
    if (binding.isolation !== 'project-peer-v1' || binding.actorPeerId !== remote.actorPeerId || binding.namespace !== remote.namespace) fail('此会话未采用当前项目的隔离范围；请创建新的记忆会话', 409);
    if (binding.status !== 'ready') fail('远端记忆会话创建结果尚待确认；不能继续写入', 409);
    return { ...remote, binding };
  }
  async createSession(projectId, input = {}) {
    const remote = this.remote(projectId), { config, headers, actorPeerId, namespace } = remote;
    if (input.sourceSessionId !== undefined && !this.store.state.sessions.some(s => s.id === input.sourceSessionId && s.projectId === projectId)) fail('源会话不属于当前项目', 403);
    const userId = await this.identity(remote, input), sessionId = `rna-${randomUUID()}`;
    // D5 (X-7): the turn this remote session archives. Event memories are append-only, so the tag is what finds them again
    // when a rewind removes the turn (`rna_turn=<id>` on every event this session extracts). Only a turn of the source
    // conversation is named: the HTTP route passes its body through, and a tag must never point at another conversation's turn.
    const turnId = typeof input.turnId === 'string' && TURN_ID.test(input.turnId) && this.store.state.sessions.some(row => row.id === input.sourceSessionId && row.projectId === projectId && row.turns?.some(turn => turn.id === input.turnId)) ? input.turnId : null;
    const binding = { sessionId, endpoint: config.endpoint, actorPeerId, namespace, userId, memoryNamespace: `viking://user/${userId}/peers/${actorPeerId}/memories`, isolation: 'project-peer-v1', status: 'creating', sourceSessionId: input.sourceSessionId ?? null, ...(turnId ? { turnId } : {}), connectionFingerprint: fingerprint(remote), createdAt: new Date().toISOString(), taskIds: [] };
    this.store.mutate(state => { const project = projectOf(state, projectId); if (input.sourceSessionId !== undefined && !state.sessions.some(session => session.id === input.sourceSessionId && session.projectId === projectId)) fail('源会话已删除；没有发送远端创建请求', 409); project.memorySessions ??= []; project.memorySessions.push(binding); });
    input.onPrepared?.(binding);
    input.onDispatch?.();
    // Working memory (OpenViking's per-archive summary and the previous archive's overview) is read only by a later
    // commit in the same remote session: the turn-budget retention of incremental checkpoints. A session with a single
    // commit (most turns, every answered card) paid for a summary nothing reads, so it is on only when asked for.
    const result = await this.dispatchSessionMutation(projectId, sessionId, `${config.endpoint}/api/v1/sessions`, { method: 'POST', headers, signal: input.signal, body: { session_id: sessionId, auto_commit_policy: null, memory_policy: { self: { enabled: false }, peer: { enabled: true }, working_memory: { enabled: input.workingMemory === true } }, memory_extraction_config: { events: { tags: [`project=${projectId}`, ...(turnId ? [turnTag(turnId)] : [])] } } } });
    if (result?.session_id !== sessionId) fail('OpenViking 返回了不匹配的会话 ID', 503);
    if (result.uri && result.uri.replace(/\/+$/, '') !== `viking://user/${userId}/sessions/${sessionId}` || result.user?.user_id && result.user.user_id !== userId) fail('OpenViking 返回的会话归属与已验证用户不符', 503);
    this.updateSessionBinding(projectId, sessionId, row => { row.status = 'ready'; });
    binding.status = 'ready';
    return { backend: this.backend, projectId, ...binding, autoCommit: false, simulated: false };
  }
  async sessionMessages(projectId, sessionId, input = {}) {
    const remote = this.sessionBinding(projectId, sessionId), { config, headers, actorPeerId } = remote;
    if (await this.identity(remote, { ...input, fresh: true }) !== remote.binding.userId) fail('OpenViking 用户身份已改变；不能向原记忆会话继续写入', 409);
    if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 100) fail('会话写入需要 1–100 条消息');
    const messages = input.messages.map(message => {
      if (!['user', 'assistant'].includes(message?.role)) fail('会话消息角色必须为 user 或 assistant');
      // Session service intentionally removes actor headers. Ownership MUST be
      // assigned on user messages; caller-supplied peer ids are never trusted.
      text(message.content, '会话消息', 16000);
      const row = { role: message.role, content: message.content, ...(message.role === 'user' ? { peer_id: actorPeerId } : {}) };
      if (message.sourceMessageId !== undefined) row.source_message_ids = [text(message.sourceMessageId, '消息来源 ID', 160)];
      return row;
    });
    if (JSON.stringify(messages).length > 60000) fail('会话消息批次内容过大');
    input.onDispatch?.();
    const result = await this.dispatchSessionMutation(projectId, sessionId, `${config.endpoint}/api/v1/sessions/${sessionId}/messages/batch`, { method: 'POST', headers, signal: input.signal, body: { messages }, timeoutMs: 15000 });
    return { backend: this.backend, projectId, sessionId, accepted: true, result, simulated: false };
  }
  async sessionCommit(projectId, sessionId, input = {}) {
    const remote = this.sessionBinding(projectId, sessionId), { config, headers } = remote, keep = input.keepRecentCount ?? 0;
    if (await this.identity(remote, { ...input, fresh: true }) !== remote.binding.userId) fail('OpenViking 用户身份已改变；不能提交原记忆会话', 409);
    if (!Number.isInteger(keep) || keep < 0 || keep > 1000) fail('保留消息数必须为 0–1000 的整数');
    input.onDispatch?.();
    const result = await this.dispatchSessionMutation(projectId, sessionId, `${config.endpoint}/api/v1/sessions/${sessionId}/commit`, { method: 'POST', headers, signal: input.signal, body: { keep_recent_count: keep, ...(input.checkpoint === true ? checkpointRetention : {}) }, timeoutMs: 15000 });
    if (typeof result?.task_id === 'string') this.updateSessionBinding(projectId, sessionId, binding => { if (!binding.taskIds.includes(result.task_id)) binding.taskIds.push(result.task_id); });
    return { backend: this.backend, projectId, sessionId, result, archiveUri: archiveUriOf(remote.binding, sessionId, result?.archive_uri), message: result?.task_id ? '会话归档请求已返回；记忆提取仍需查询后台任务结果。' : 'OpenViking 已返回提交结果；请按结果确认是否有新记忆。', simulated: false };
  }
  async sessionTask(projectId, sessionId, taskId, input = {}) {
    const remote = this.sessionBinding(projectId, sessionId), { config, headers, binding } = remote;
    if (await this.identity(remote, input) !== binding.userId) fail('OpenViking 用户身份已改变；不能查询原记忆任务', 409);
    if (!binding.taskIds.includes(taskId)) fail('提取任务不属于当前项目会话', 404);
    // The service's own NOT_FOUND code (task expired or forgotten) is kept so the caller can tell it from a bare 404.
    const result = resultOf(await request(`${config.endpoint}/api/v1/tasks/${encodeURIComponent(taskId)}`, { headers, signal: input.signal, captureErrorCode: true }));
    if (result?.result?.session_id && result.result.session_id !== sessionId) fail('OpenViking 返回的任务归属与项目会话不符', 503);
    const archiveUri = archiveUriOf(binding, sessionId, result?.result?.archive_uri), diff = result?.result?.memory_diff_uri;
    return { backend: this.backend, projectId, sessionId, taskId, result, archiveUri, memoryDiffUri: archiveUri && diff === `${archiveUri}/memory_diff.json` ? diff : null, simulated: false };
  }
  /**
   * Read-only: the terminal state of one archive of a bound remote session, from the markers OpenViking itself reads
   * (Session._archive_terminal_state): `.done` is written last once commit phase 2 completed, `.failed.json` once it
   * failed for good. 'pending' while neither exists. Unlike task records (completed ones expire after 24 h, failed ones
   * after 7 d), the markers never expire, so an archive outlives its task (pi client getArchiveState, DESIGN.md
   * "Runtime flow" 6). Throws when the service cannot be asked; a 404 is only "this marker is not there".
   * For a completed archive it also reports whether its `memory_diff.json` exists (A2, for X-7) and how many memories
   * that diff adds, updates or deletes (`memoryChanges`): OpenViking writes the diff whenever long-term extraction ran,
   * an empty one included (compressor_v3 _write_final_memory_diff, `summary.total_*`), so its presence alone says
   * nothing changed. null when the diff cannot be parsed or is too large to read in one response.
   */
  async archiveState(projectId, sessionId, archiveUri, input = {}) {
    const remote = this.sessionBinding(projectId, sessionId), { config, headers, binding } = remote;
    if (archiveUriOf(binding, sessionId, archiveUri) !== archiveUri) fail('归档不属于当前项目会话', 404);
    if (await this.identity(remote, input) !== binding.userId) fail('OpenViking 用户身份已改变；不能核对原记忆归档', 409);
    // The file's content (content/read) or status (fs/stat), or undefined when it is not there.
    const get = async (path, file) => {
      try { return resultOf(await request(`${config.endpoint}/api/v1/${path}?${new URLSearchParams({ uri: `${archiveUri}/${file}` })}`, { headers, signal: input.signal, timeoutMs: 15000, captureErrorCode: true })); }
      catch (error) { if (error.upstreamStatus === 404) return undefined; throw error; }
    };
    const present = async file => await get('content/read', file) !== undefined;
    const checkedAt = () => new Date().toISOString();
    if (await present('.done')) {
      const stat = await get('fs/stat', 'memory_diff.json');
      if (stat === undefined) return { state: 'completed', marker: '.done', memoryDiffUri: null, checkedAt: checkedAt() };
      // Read only a diff the response cap can carry; a larger one is counted as unknown.
      const diff = Number.isSafeInteger(stat?.size) && stat.size <= MEMORY_DIFF_READ_BYTES ? await get('content/read', 'memory_diff.json') : undefined;
      return { state: 'completed', marker: '.done', memoryDiffUri: `${archiveUri}/memory_diff.json`, memoryChanges: diff === undefined ? null : memoryDiffChanges(diff), checkedAt: checkedAt() };
    }
    if (await present('.failed.json')) return { state: 'failed', marker: '.failed.json', checkedAt: checkedAt() };
    return { state: 'pending', checkedAt: checkedAt() };
  }
}
