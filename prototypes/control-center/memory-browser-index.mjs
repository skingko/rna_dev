// Read-only navigation metadata. This bounded, short-lived cache is not a
// memory store: no text, embeddings, model calls or extraction writes occur.
import { createHash } from 'node:crypto';
import { requestJSON } from './configuration.mjs';
import { memoryRequest } from './embedded-memory.mjs';

const MAX_NODES = 500, MAX_REQUESTS = 128, TTL_MS = 30000;
const within = (uri, root) => typeof uri === 'string' && uri.startsWith(`${root}/`) && !uri.split('/').some(part => part === '..' || part === '.') && !/[?#%\u0000-\u001f]/u.test(uri);
const compare = (a, b) => (Date.parse(b.modifiedAt) || 0) - (Date.parse(a.modifiedAt) || 0) || (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0);
const failure = (message, status) => Object.assign(new Error(message), { status });

export function memoryEntryKind(uri, remote) { return remote.memoryNamespace && (uri === remote.memoryNamespace || within(uri, remote.memoryNamespace)) ? 'memory' : 'resource'; }

export async function recentMemory(service, projectId, input, remote) {
  const limit = Number(input.limit ?? remote.config.limit), offset = Number(input.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10000) throw failure('记忆分页参数超出范围', 400);
  const filter = input.filter ?? 'all';
  if (!['all', 'memory', 'resource'].includes(filter)) throw failure('记忆筛选必须为 all、memory 或 resource', 400);
  if (input.uri && input.uri !== remote.namespace) throw failure('最近记忆视图仅支持当前项目根目录', 400);
  input.signal?.throwIfAborted();
  const project = service.store.state.projects.find(row => row.id === projectId);
  const revision = [project?.memorySummary?.sourceFingerprint, project?.memorySummary?.revision,
    ...(service.store.state.sessions ?? []).filter(row => row.projectId === projectId).flatMap(row => (row.memoryEvidenceOutbox ?? []).map(write => [write.id, write.resourceIndex?.status, write.resourceIndex?.updatedAt]))];
  const connection = service.connectionFingerprint(projectId);
  const guard = () => { input.signal?.throwIfAborted(); if (service.connectionFingerprint(projectId) !== connection) throw failure('记忆连接已变更，请刷新', 409); };
  const key = createHash('sha256').update(JSON.stringify([connection, remote.scopes, revision])).digest('hex');
  service.browseSnapshots ??= new Map();
  const cached = service.browseSnapshots.get(key);
  let snapshot = input.refresh !== true && input.refresh !== 'true' && cached?.expiresAt > Date.now() ? cached : null;
  if (!snapshot) {
    const deadline = AbortSignal.timeout(20000), signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    const queue = remote.scopes.map(uri => ({ uri, root: uri, offset: 0 })), seen = new Set(remote.scopes), entries = new Map(), directories = new Set(), warnings = new Set();
    let nodes = 0, requests = 0, successfulRoots = 0, missingRootHealth;
    while (queue.length && nodes < MAX_NODES && requests < MAX_REQUESTS && !deadline.aborted) {
      const batch = queue.splice(0, Math.min(4, MAX_REQUESTS - requests)); requests += batch.length;
      const results = await Promise.allSettled(batch.map(async item => {
        guard();
        const values = new URLSearchParams({ uri: item.uri, output: 'original', recursive: 'false', offset: String(item.offset), node_limit: '101', sort_by: 'mtime', sort_order: 'desc' });
        const response = await memoryRequest(requestJSON, `${remote.config.endpoint}/api/v1/fs/ls?${values}`, { headers: remote.headers, signal });
        if (response?.status !== 'ok' || !Array.isArray(response.result)) throw failure('记忆目录响应无效', 503);
        return response.result;
      }));
      guard();
      for (let index = 0; index < results.length; index++) {
        const result = results[index], item = batch[index];
        if (result.status === 'rejected') {
          if (result.reason?.upstreamStatus === 404 && item.uri === item.root && item.offset === 0) {
            // A missing API route also returns 404. Authenticate the actual
            // service before interpreting missing roots as an empty project.
            // Share one probe across concurrently requested roots in this scan;
            // ordinary successful listings never incur an extra health request.
            missingRootHealth ??= service.healthRemote(remote, { signal });
            await missingRootHealth; guard(); successfulRoots++; continue;
          }
          warnings.add(deadline.aborted ? 'MEMORY_INDEX_TIMEOUT' : 'MEMORY_INDEX_DIRECTORY_UNAVAILABLE'); continue;
        }
        if (item.uri === item.root && item.offset === 0) successfulRoots++;
        const rows = result.value;
        for (const row of rows.slice(0, 100)) {
          if (!row || row.access === 'denied' || typeof row.isDir !== 'boolean' || !within(row.uri, item.uri) || row.uri.slice(item.uri.length + 1).includes('/')) { warnings.add('MEMORY_INDEX_ENTRY_UNAVAILABLE'); continue; }
          if (row.uri.slice(item.root.length + 1).split('/').some(part => part.startsWith('.'))) continue;
          if (seen.has(row.uri)) continue;
          if (nodes >= MAX_NODES) { warnings.add('MEMORY_INDEX_SCAN_LIMIT'); break; }
          seen.add(row.uri); nodes++;
          if (row.isDir) { directories.add(row.uri); queue.push({ uri: row.uri, root: item.root, offset: 0 }); continue; }
          const kind = memoryEntryKind(row.uri, remote), relative = row.uri.slice(item.root.length + 1);
          entries.set(row.uri, { id: row.uri, uri: row.uri, expandUri: row.uri, title: String(row.name ?? row.uri.split('/').at(-1)), isDirectory: false, isLeaf: true, availableReads: ['L2'],
            size: Number(row.size) || 0, modifiedAt: Number.isFinite(Date.parse(row.modTime)) ? new Date(row.modTime).toISOString() : null,
            source: 'openviking', kind, category: kind === 'memory' ? relative.split('/')[0] : 'resources', path: relative });
        }
        if (rows.length > 100) queue.push({ ...item, offset: item.offset + 100 });
      }
    }
    if (queue.length) warnings.add(deadline.aborted ? 'MEMORY_INDEX_TIMEOUT' : 'MEMORY_INDEX_SCAN_LIMIT');
    if (!successfulRoots && !entries.size) throw failure('暂时无法浏览项目记忆，请稍后重试', 503);
    snapshot = { entries: [...entries.values()].sort(compare), directories: [...directories], checkedAt: new Date().toISOString(), warnings: [...warnings], expiresAt: Date.now() + TTL_MS };
    // A partial response must be retried on the next visit instead of caching
    // an unavailable branch as a successful empty collection.
    if (!warnings.size) {
      for (const [oldKey, value] of service.browseSnapshots) if (value.expiresAt <= Date.now() || oldKey !== key && service.browseSnapshots.size >= 8) service.browseSnapshots.delete(oldKey);
      service.browseSnapshots.set(key, snapshot);
    }
  }
  // Visibility is evaluated on every request, including cached pagination:
  // revoked source summaries cannot leak a deleted execution document. Safe
  // leaf files remain discoverable even while an ancestor summary is stale.
  guard();
  const entries = snapshot.entries.filter(row => service.evidenceResourceVisible(projectId, row.uri));
  const matching = filter === 'all' ? entries : entries.filter(row => row.kind === filter);
  const page = service.presentEntries(projectId, matching.slice(offset, offset + limit)), hasMore = matching.length > offset + limit;
  return { backend: remote.config.backend ?? 'openviking', namespace: remote.namespace, uri: remote.namespace, view: 'recent', filter, matchingFiles: matching.length, entries: page, total: page.length, offset, limit,
    hasMore, nextOffset: hasMore ? offset + limit : null, paginationLimited: false, strategy: 'progressive', simulated: false,
    sort: { by: 'mtime', order: 'desc' }, warnings: snapshot.warnings.map(code => ({ code })), scanLimited: snapshot.warnings.includes('MEMORY_INDEX_SCAN_LIMIT'),
    collection: { memoryFiles: entries.filter(row => row.kind === 'memory').length, resourceFiles: entries.filter(row => row.kind === 'resource').length,
      directories: snapshot.directories.length, complete: snapshot.warnings.length === 0, checkedAt: snapshot.checkedAt, scanLimit: MAX_NODES },
    pageCounts: { directories: 0, files: page.length } };
}
