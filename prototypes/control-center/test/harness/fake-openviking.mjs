// D4 scenario harness: a fake OpenViking HTTP server (plan A7: mock only the network boundary). It keeps just enough
// server state to answer the host the way OpenViking does: sessions with their messages, commits as tasks, resources
// (content write/read/stat/delete, and a directory listing derived from them), search, health and readiness. Every request is recorded with its body, so a
// scenario asserts what reached memory, not what the host says it sent.
//
// Knobs (set on the returned object): `taskStatus` for new commit tasks ('completed' by default), `extracted` (memories
// a completed commit reports), `outage` (every request answers 503), `hold` (a promise every request waits on),
// `searchHits` (a function of the search body returning the resource hits).
// `fail(call)` answers a request with the status it returns (the route fails; nothing else does); `listOverride(uri)` replaces a listing.
// Extracted memories (D5, rewind): `extraction({ sessionId, session, archiveNo })` returns what a commit's long-term step
// wrote, { adds: [{ uri, body, type }], updates: [{ uri, body, type }], deletes: [{ uri, content, type }] }. The fake applies
// it to its files the way OpenViking does (a memory file is its body plus a MEMORY_FIELDS comment; events carry the session's
// event tags), writes the archive's `.done` and `memory_diff.json` (operations adds/updates/deletes, `summary.total_*`) and
// names both in the task result. `ov.memory(uri, body)` puts a memory file there, `ov.bodyOf(uri)` reads a file's body, and
// `ov.tagsOf(uri)` its tags. Deleting a session removes its files (its archives and their diffs go with it).
import http from 'node:http';

const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const ok = (res, result) => json(res, 200, { status: 'ok', result });
const notFound = res => json(res, 404, { status: 'error', error: { code: 'NOT_FOUND', message: 'not found' } });
const FIELDS = /\n\n<!--\s*MEMORY_FIELDS\b[\s\S]*?\s*-->/g;
const trailerOf = raw => /\n\n<!--\s*MEMORY_FIELDS\b[\s\S]*?\s*-->/.exec(String(raw ?? ''))?.[0] ?? '';
const bodyOf = raw => String(raw ?? '').replace(FIELDS, '').trim();
const withFields = (body, fields = { version: 1 }) => `${body}\n\n<!-- MEMORY_FIELDS\n${JSON.stringify(fields, null, 2)}\n-->`;

export async function createFakeOpenViking({ user = 'scenario-user' } = {}) {
  const ov = {
    user, calls: [], sessions: new Map(), deletedSessions: [], tasks: new Map(), resources: new Map(), deletedResources: [],
    taskStatus: 'completed', extracted: 1, outage: false, hold: null, tags: new Map(), extraction: null,
    /** A memory file at `uri` holding `body` (its MEMORY_FIELDS comment is the one OpenViking renders). */
    memory(uri, body, tags) { ov.resources.set(uri, withFields(body)); if (tags) ov.tags.set(uri, tags); },
    bodyOf: uri => ov.resources.has(uri) ? bodyOf(ov.resources.get(uri)) : null,
    tagsOf: uri => ov.tags.get(uri) ?? [],
    /** Every request that is not a GET: what the host changed in OpenViking. */
    writes: () => ov.calls.filter(call => call.method !== 'GET'),
    /** Calls whose path matches (a string prefix or a RegExp), optionally of one method. */
    of(path, method) { return ov.calls.filter(call => (typeof path === 'string' ? call.path.startsWith(path) : path.test(call.path)) && (!method || call.method === method)); },
  };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://openviking.fake'), path = url.pathname, parts = path.split('/');
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = { unreadable: true }; }
    ov.calls.push({ at: Date.now(), method: req.method, path, query: Object.fromEntries(url.searchParams), body });
    if (ov.hold) await ov.hold;
    if (ov.outage) return json(res, 503, { status: 'error', error: { code: 'UNAVAILABLE' } });
    // `fail(call)`: a status to answer this request with (a scenario's way to break one route, e.g. the deletion of a memory file).
    const failed = ov.fail?.({ method: req.method, path, query: Object.fromEntries(url.searchParams), body }); if (failed) return json(res, failed, { status: 'error', error: { code: 'INJECTED_FAILURE' } });
    if (path === '/health') return json(res, 200, { status: 'ok', healthy: true, version: 'fake-openviking' });
    if (path === '/ready') return json(res, 200, { status: 'ready', checks: { agfs: 'ok', vectordb: 'ok', embedding: 'ok' } });
    if (path === '/api/v1/system/status') return ok(res, { initialized: true, user: ov.user });
    if (path === '/api/v1/models') return ok(res, { models: [] });
    // Sessions: create, read, delete, messages, commit.
    if (path === '/api/v1/sessions' && req.method === 'POST') { ov.sessions.set(body.session_id, { body, messages: [], commits: 0 }); return ok(res, { session_id: body.session_id }); }
    if (path.startsWith('/api/v1/sessions/')) {
      const id = decodeURIComponent(parts[4]), session = ov.sessions.get(id);
      if (path.endsWith('/messages/batch')) { if (!session) return notFound(res); session.messages.push(...(body?.messages ?? [])); return ok(res, { added: body?.messages?.length ?? 0 }); }
      if (path.endsWith('/commit')) {
        if (!session) return notFound(res);
        session.commits++;
        const task = { task_id: `task-${id}-${session.commits}`, task_type: 'session_commit', resource_id: id, status: ov.taskStatus, result: { session_id: id, memories_extracted: { events: ov.extracted }, token_usage: { total: { total_tokens: 20 } } } };
        ov.tasks.set(task.task_id, task);
        const archiveUri = `viking://user/${ov.user}/sessions/${id}/history/archive_${session.commits}`;
        if (ov.extraction && ov.taskStatus === 'completed') {
          // The long-term step: memories are written, then the diff, then the marker (`.done` last).
          const plan = ov.extraction({ sessionId: id, session, archiveNo: session.commits }) ?? {}, tags = session.body?.memory_extraction_config?.events?.tags ?? [];
          const adds = [], updates = [], deletes = [];
          for (const row of plan.adds ?? []) { ov.resources.set(row.uri, withFields(row.body)); if (row.uri.includes('/events/') && tags.length) ov.tags.set(row.uri, tags.map(tag => tag.toLowerCase())); adds.push({ uri: row.uri, memory_type: row.type ?? 'preferences', after: row.body }); }
          for (const row of plan.updates ?? []) { const before = bodyOf(ov.resources.get(row.uri)); ov.resources.set(row.uri, withFields(row.body, { version: 2 })); updates.push({ uri: row.uri, memory_type: row.type ?? 'preferences', before, after: row.body }); }
          for (const row of plan.deletes ?? []) { ov.resources.delete(row.uri); deletes.push({ uri: row.uri, memory_type: row.type ?? 'preferences', deleted_content: row.content ?? '' }); }
          const diff = { archive_uri: archiveUri, trace_id: null, extracted_at: new Date().toISOString(), operations: { adds, updates, deletes }, skipped_operations: [], summary: { total_adds: adds.length, total_updates: updates.length, total_deletes: deletes.length, total_skipped: 0 } };
          ov.resources.set(`${archiveUri}/memory_diff.json`, JSON.stringify(diff, null, 2)); ov.resources.set(`${archiveUri}/.done`, '{}');
          Object.assign(task.result, { archive_uri: archiveUri, memory_diff_uri: `${archiveUri}/memory_diff.json` });
        }
        return ok(res, { status: 'accepted', archived: true, task_id: task.task_id, archive_uri: archiveUri });
      }
      if (parts.length === 5) {
        if (!session) return notFound(res);
        if (req.method === 'DELETE') {
          ov.sessions.delete(id); ov.deletedSessions.push(id);
          for (const uri of [...ov.resources.keys()]) if (uri.startsWith(`viking://user/${ov.user}/sessions/${id}/`)) ov.resources.delete(uri);
          return ok(res, { session_id: id });
        }
        return ok(res, { session_id: id, uri: `viking://user/${ov.user}/sessions/${id}`, user: { user_id: ov.user }, auto_commit_policy: null, message_count: session.messages.length });
      }
    }
    if (path === '/api/v1/tasks') return ok(res, { items: [...ov.tasks.values()].filter(task => !url.searchParams.get('resource_id') || task.resource_id === url.searchParams.get('resource_id')), has_more: false, next_cursor: null });
    if (path.startsWith('/api/v1/tasks/')) { const task = ov.tasks.get(decodeURIComponent(parts[4])); if (!task) return notFound(res); if (path.endsWith('/cancel')) task.status = 'cancelled'; return ok(res, task); }
    // Resources.
    if (path === '/api/v1/content/write') { ov.resources.set(body.uri, body.uri.includes('/memories/') && body.mode === 'replace' && ov.resources.has(body.uri) ? `${body.content}${trailerOf(ov.resources.get(body.uri))}` : body.content); return ok(res, { uri: body.uri, mode: body.mode, written_bytes: Buffer.byteLength(String(body.content ?? '')), content_updated: true, semantic_status: 'complete', vector_status: 'complete', queue_status: { Semantic: { error_count: 0 }, Embedding: { error_count: 0 } } }); }
    if (path === '/api/v1/content/read') { const uri = url.searchParams.get('uri'); return ov.resources.has(uri) ? ok(res, url.searchParams.get('raw') === 'true' || !uri.includes('/memories/') ? ov.resources.get(uri) : bodyOf(ov.resources.get(uri))) : notFound(res); }
    if (path === '/api/v1/content/reindex') return ok(res, { status: 'completed', uri: body?.uri, object_type: 'resource', mode: body?.mode, scanned_records: 1, rebuilt_records: 1, failed_records: 0 });
    if (path === '/api/v1/fs/stat') { const uri = url.searchParams.get('uri'); return ov.resources.has(uri) ? ok(res, { uri, isDir: false, size: Buffer.byteLength(String(ov.resources.get(uri) ?? '')) }) : notFound(res); }
    if (path === '/api/v1/fs' && req.method === 'DELETE') { const uri = url.searchParams.get('uri'); ov.resources.delete(uri); ov.deletedResources.push(uri); return ok(res, { uri }); }
    if (path === '/api/v1/fs/mkdir') return ok(res, { uri: body?.uri });
    // A non-recursive listing of the resources held under `uri`: its files, and the directories their paths imply.
    if (path === '/api/v1/fs/ls') {
      // `listOverride(uri)`: the rows a listing answers instead of the real ones (a listing that misses what exists).
      const override = ov.listOverride?.(url.searchParams.get('uri')); if (override) return ok(res, override);
      const prefix = `${url.searchParams.get('uri')}/`, rows = new Map(), wanted = url.searchParams.getAll('tags').map(tag => tag.toLowerCase());
      // Recursive and/or tag-filtered: the matching files (OpenViking lists tagged entries from the vector index).
      if (url.searchParams.get('recursive') === 'true' || wanted.length) {
        const files = [...ov.resources].filter(([uri]) => uri.startsWith(prefix) && (url.searchParams.get('recursive') === 'true' || !uri.slice(prefix.length).includes('/')) && wanted.every(tag => (ov.tags.get(uri) ?? []).includes(tag)));
        return ok(res, files.map(([uri, content]) => ({ uri, name: uri.split('/').at(-1), isDir: false, size: Buffer.byteLength(String(content ?? '')), modTime: new Date().toISOString(), ...(url.searchParams.get('include_tags') === 'true' ? { tags: ov.tags.get(uri) ?? [] } : {}) })));
      }
      for (const [uri, content] of ov.resources) if (uri.startsWith(prefix)) {
        const rest = uri.slice(prefix.length), name = rest.split('/')[0], child = `${prefix}${name}`, isDir = rest.includes('/');
        if (!rows.has(child)) rows.set(child, { uri: child, name, isDir, size: isDir ? 0 : Buffer.byteLength(String(content ?? '')), modTime: new Date().toISOString() });
      }
      return ok(res, [...rows.values()]);
    }
    // `searchHits(body)`: the resources a search of one scope finds (none by default).
    if (path === '/api/v1/search/find' || path === '/api/v1/search') { const resources = ov.searchHits?.(body) ?? []; return ok(res, { memories: [], resources, skills: [], total: resources.length }); }
    return notFound(res);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  ov.endpoint = `http://127.0.0.1:${server.address().port}`;
  ov.close = async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); };
  return ov;
}
