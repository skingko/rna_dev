/**
 * The embedded memory engine: project memory with no outside service (no Docker, no embedding model, no model call).
 * It answers, in this process, the same requests the host sends an OpenViking server (memory-service.mjs builds them;
 * test/harness/fake-openviking.mjs lists the surface), so recall, the memory tools, the browser, the sync queue,
 * conversation deletion and rewind run unchanged on either backend.
 *
 * What it keeps, in one SQLite file under `<state>.rna/memory/` (inside the journal root every release inventories, so
 * no new sibling of the state file exists for an older release's checkpoint to refuse):
 *   - files by `viking://` URI: delivery documents and notes under a project's resource namespace, and one "event"
 *     per committed conversation segment under its memory namespace (the segment's own words, nothing distilled);
 *   - a full-text index over them (FTS5 `bm25`): words as written, Han/kana/hangul runs as adjacent character pairs
 *     (mu store.ts and zcode read-session-context.ts cut Chinese this way; SQLite's own tokenizers give one token per
 *     unbroken run, or cannot match a two-character word);
 *   - upload sessions, their archives (`history/archive_NNN` with `memory_diff.json` and `.done`) and commit tasks.
 * A search hit carries a passage cut from the file around the query's words; a directory's abstract and overview are
 * a listing of what it holds (OpenViking's own no-model fallbacks, tiers.py). Search is by words: a paraphrase or
 * another language does not match, which is what the OpenViking backend's embeddings are for.
 * An event belongs to the upload session that committed it and goes when that session is deleted (a deleted
 * conversation's words do not stay searchable); OpenViking keeps distilled memories instead.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** The address a binding or a fingerprint records for this backend: stable across restarts, never fetched. */
export const EMBEDDED_MEMORY_ENDPOINT = 'rna-embedded://memory';
/** On a connection's headers object: the engine that answers its requests in this process. */
export const EMBEDDED_BACKEND = Symbol('rna.embedded-memory');
export const EMBEDDED_USER = 'local';
export const EMBEDDED_VERSION = 'rna-embedded-1';
const SCHEMA = 1, APPLICATION_ID = 0x524e414d; // "RNAM"
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const RUNS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}])+/gu;

/** The terms a text is indexed and searched by: lower-cased words, and each adjacent pair of a CJK run (a lone character as itself). */
export function memoryTerms(text) {
  const terms = [];
  for (const [run] of String(text ?? '').toLowerCase().matchAll(RUNS)) {
    if (!CJK.test(run)) { terms.push(run); continue; }
    const chars = Array.from(run);
    if (chars.length === 1) terms.push(run); else for (let index = 0; index + 1 < chars.length; index++) terms.push(chars[index] + chars[index + 1]);
  }
  return terms;
}
const clip = (text, limit) => { const chars = Array.from(text); return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : text; };
const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim();
/** A file's first sentence in its own words: its text below a heading, else the heading (OpenViking cuts abstracts at a sentence end, 。？！ included). */
function firstSentence(content, limit = 160) {
  const heading = /^#{1,6}\s/, lines = String(content ?? '').split('\n').map(row => row.trim()).filter(row => /[\p{L}\p{N}]/u.test(row) && !/^(?:User|Assistant):$/.test(row));
  const line = (lines.find(row => !heading.test(row)) ?? lines[0] ?? '').replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '');
  return clip((/^.*?[。！？]|^.*?[.!?](?=\s|$)/u.exec(line)?.[0] ?? line).trim(), limit);
}
/**
 * The passage of `content` that holds the most of the query's terms, in the file's own words: the window is moved to
 * the densest stretch and widened to whole lines. What recall shows for a hit, so it must say something by itself.
 */
export function passageFor(content, terms, limit = 360) {
  const text = String(content ?? ''), lower = text.toLowerCase(), hits = [];
  for (const term of new Set(terms)) for (let at = lower.indexOf(term); at >= 0 && hits.length < 4000; at = lower.indexOf(term, at + term.length)) hits.push([at, term]);
  if (!hits.length) return clip(oneLine(text), limit);
  hits.sort((a, b) => a[0] - b[0]);
  let best = { start: hits[0][0], distinct: 0, count: 0 };
  for (let left = 0, right = 0; left < hits.length; left++) {
    while (right < hits.length && hits[right][0] - hits[left][0] <= limit) right++;
    const distinct = new Set(hits.slice(left, right).map(row => row[1])).size, count = right - left;
    if (distinct > best.distinct || distinct === best.distinct && count > best.count) best = { start: hits[left][0], distinct, count };
  }
  // Start at the line that holds the first match, unless that line alone is longer than the passage.
  const lineStart = text.lastIndexOf('\n', best.start) + 1, start = best.start - lineStart > limit / 3 ? Math.max(lineStart, best.start - Math.floor(limit / 4)) : lineStart;
  const passage = oneLine(text.slice(start, start + limit * 2));
  return `${start > 0 && start !== lineStart ? '…' : ''}${clip(passage, limit)}`;
}

const ok = result => ({ status: 200, body: { status: 'ok', result } });
const refuse = (status, code, message) => ({ status, body: { status: 'error', error: { code, message } } });
const notFound = () => refuse(404, 'NOT_FOUND', 'not found');
const validUri = uri => typeof uri === 'string' && /^viking:\/\/[^/]+\/./.test(uri) && uri.length <= 2000 && !uri.split('/').some(part => part === '..' || part === '.') && !/[?#%\u0000-\u001f]/u.test(uri);
const parentOf = uri => uri.slice(0, uri.lastIndexOf('/'));
const iso = ms => new Date(ms).toISOString();
const two = number => String(number).padStart(2, '0');

/** The memory backends a configuration may name: an OpenViking server, or this engine. */
export const MEMORY_BACKENDS = Object.freeze(['openviking', 'embedded']);
/**
 * One request to the memory backend a connection names: its headers carry the embedded engine when that is the
 * backend, otherwise the request goes to the OpenViking server at `url`. `remote` is the function used for a server
 * (requestJSON), passed in so this module stays free of the host's HTTP code.
 */
export const memoryRequest = (remote, url, input) => (input?.headers?.[EMBEDDED_BACKEND] ? input.headers[EMBEDDED_BACKEND].request(url, input) : remote(url, input));

export class EmbeddedMemory {
  /** `file`: the SQLite file (its folder is made on first use). `now` is a seam for tests. */
  constructor(file, { now = Date.now } = {}) { this.file = file; this.now = now; this.db = null; this.opening = null; }
  async open() {
    if (this.db) return this.db;
    return this.opening ??= (async () => {
      const { DatabaseSync } = await import('node:sqlite');
      if (this.file !== ':memory:') mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(this.file);
      // Conversations are in this file: readable by its owner only, like the state file beside it.
      if (this.file !== ':memory:') chmodSync(this.file, 0o600);
      const application = db.prepare('pragma application_id').get().application_id, version = db.prepare('pragma user_version').get().user_version;
      // Another program's database, or a later schema, is never written into.
      if (version > SCHEMA || application !== 0 && application !== APPLICATION_ID) { db.close(); throw Object.assign(new Error('The embedded memory file was written by another program or a newer version; it is left as it is.'), { code: 'EMBEDDED_MEMORY_SCHEMA' }); }
      db.exec(`pragma application_id = ${APPLICATION_ID}; pragma journal_mode = delete; pragma synchronous = full;
        create table if not exists files(id integer primary key, uri text not null unique, content text not null, tags text not null default '[]', owner text, mtime integer not null);
        create index if not exists files_owner on files(owner);
        create table if not exists dirs(uri text primary key, description text, mtime integer not null);
        create virtual table if not exists search using fts5(terms, tokenize = 'unicode61');
        create table if not exists sessions(id text primary key, body text not null, pending text not null default '[]', commits integer not null default 0, created integer not null);
        create table if not exists tasks(id text primary key, type text not null, resource text not null, status text not null, result text not null, created integer not null);
        create index if not exists tasks_resource on tasks(resource);
        pragma user_version = ${SCHEMA};`);
      this.db = db; return db;
    })().finally(() => { this.opening = null; });
  }
  close() { try { this.db?.close(); } catch { /* already closed */ } this.db = null; }

  /**
   * What `requestJSON` does for a remote service, answered here: the parsed body of a 2xx answer, else an error with
   * the answer's status as `upstreamStatus` and, when asked for, its error code as `upstreamCode`.
   */
  async request(url, { method = 'GET', headers, body, signal, captureErrorCode = false } = {}) {
    signal?.throwIfAborted();
    const parsed = new URL(url.replace(EMBEDDED_MEMORY_ENDPOINT, 'http://embedded')), actor = headers?.['X-OpenViking-Actor-Peer'];
    let answer, db = null;
    try {
      db = await this.open();
      // A changing request is one transaction: a file and its index row, or an archive with its event, diff and marker.
      if (method !== 'GET') db.exec('begin immediate');
      answer = this.handle(db, method, parsed.pathname, parsed.searchParams, body ?? null, typeof actor === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(actor) ? actor : null);
      if (method !== 'GET') db.exec(answer.status >= 200 && answer.status < 300 ? 'commit' : 'rollback');
    } catch (cause) {
      if (method !== 'GET') try { db?.exec('rollback'); } catch { /* no transaction was open */ }
      answer = refuse(500, 'EMBEDDED_MEMORY_FAILED', cause?.code === 'EMBEDDED_MEMORY_SCHEMA' ? cause.message : 'The embedded memory store could not complete the request.');
    }
    if (answer.status >= 200 && answer.status < 300) return answer.body;
    const error = new Error(`本地记忆未完成请求（${answer.status}）`); error.status = 502; error.upstreamStatus = answer.status;
    if (captureErrorCode && typeof answer.body?.error?.code === 'string') error.upstreamCode = answer.body.error.code;
    throw error;
  }

  // ------------------------------------------------------------------------------------------------ files
  file_(db, uri) { return db.prepare('select id, uri, content, tags, owner, mtime from files where uri = ?').get(uri); }
  under(db, directory, columns = 'uri, length(cast(content as blob)) as size, mtime, tags') { return db.prepare(`select ${columns} from files where uri >= ? and uri < ? order by uri`).all(`${directory}/`, `${directory}0`); }
  isDirectory(db, uri) { return Boolean(db.prepare('select 1 from dirs where uri = ?').get(uri) ?? db.prepare('select 1 from files where uri >= ? and uri < ? limit 1').get(`${uri}/`, `${uri}0`)); }
  /** Session internals (archives, their markers and diffs) are files, but nothing a search should find. */
  searchable(uri) { return !/^viking:\/\/user\/[^/]+\/sessions\//.test(uri); }
  put(db, uri, content, { tags = null, owner = null } = {}) {
    const existing = this.file_(db, uri), at = this.now();
    if (existing) { db.prepare('update files set content = ?, mtime = ?, tags = coalesce(?, tags), owner = coalesce(?, owner) where id = ?').run(content, at, tags ? JSON.stringify(tags) : null, owner, existing.id); db.prepare('delete from search where rowid = ?').run(existing.id); }
    else db.prepare('insert into files(uri, content, tags, owner, mtime) values(?, ?, ?, ?, ?)').run(uri, content, JSON.stringify(tags ?? []), owner, at);
    const id = existing?.id ?? this.file_(db, uri).id;
    if (this.searchable(uri)) db.prepare('insert into search(rowid, terms) values(?, ?)').run(id, memoryTerms(`${uri.split('/').at(-1).replace(/\.md$/i, '')}\n${content}`).join(' '));
    return id;
  }
  remove(db, uri) { const row = this.file_(db, uri); if (!row) return false; db.prepare('delete from search where rowid = ?').run(row.id); db.prepare('delete from files where id = ?').run(row.id); return true; }
  /** The immediate children of a directory: the folders its files' paths imply (or `mkdir` made) and its own files. */
  children(db, directory) {
    const rows = new Map(), prefix = `${directory}/`;
    for (const file of this.under(db, directory)) {
      const rest = file.uri.slice(prefix.length), name = rest.split('/')[0], uri = `${prefix}${name}`, isDir = rest.includes('/'), seen = rows.get(uri);
      if (!seen) rows.set(uri, { uri, name, isDir, size: isDir ? 0 : file.size, mtime: file.mtime, tags: isDir ? [] : JSON.parse(file.tags) });
      else if (file.mtime > seen.mtime) seen.mtime = file.mtime;
    }
    for (const row of db.prepare('select uri, mtime from dirs where uri >= ? and uri < ?').all(prefix, `${directory}0`)) {
      const name = row.uri.slice(prefix.length).split('/')[0], uri = `${prefix}${name}`;
      if (!rows.has(uri)) rows.set(uri, { uri, name, isDir: true, size: 0, mtime: row.mtime, tags: [] });
    }
    // Folders first, each group newest first, then by name (the order OpenViking lists in).
    return [...rows.values()].sort((a, b) => Number(b.isDir) - Number(a.isDir) || b.mtime - a.mtime || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.name < b.name ? -1 : 1));
  }
  /** A directory's abstract (L0) and overview (L1): what it holds, said from the entries themselves. */
  directoryText(db, uri, level) {
    const children = this.children(db, uri); if (!children.length) return null;
    const name = uri.split('/').at(-1), files = children.filter(row => !row.isDir), folders = children.length - files.length;
    const count = `${files.length} file${files.length === 1 ? '' : 's'}${folders ? `, ${folders} folder${folders === 1 ? '' : 's'}` : ''}`;
    const said = row => (row.isDir ? `${row.name}/` : firstSentence(this.file_(db, row.uri)?.content) || row.name.replace(/\.md$/i, ''));
    if (level === 0) return clip(`${name}: ${count}. ${children.slice(0, 6).map(said).join('; ')}`, 256);
    return clip(`# ${name}\n\n${count}, newest first.\n\n${children.slice(0, 60).map(row => `- ${row.isDir ? `${row.name}/ (folder)` : `${row.name}: ${said(row)}`}`).join('\n')}${children.length > 60 ? `\n- … ${children.length - 60} more` : ''}`, 4000);
  }

  // ------------------------------------------------------------------------------------------------ search
  /** Files under `scope` that share words with `query`, best first: { uri, level: 2, abstract, score }. */
  find(db, query, scope, limit) {
    const terms = [...new Set(memoryTerms(query))].slice(0, 64);
    if (!terms.length) return [];
    const rows = db.prepare(`select f.uri as uri, f.content as content, bm25(search) as rank from search join files f on f.id = search.rowid
      where search match ? and f.uri >= ? and f.uri < ? order by rank limit ?`).all(terms.map(term => `"${term}"`).join(' OR '), `${scope}/`, `${scope}0`, Math.min(200, limit * 4));
    const hits = [];
    for (const row of rows) {
      const lower = `${row.uri.split('/').at(-1)}\n${row.content}`.toLowerCase(), matched = terms.filter(term => lower.includes(term)).length;
      // One shared word out of many is how any two texts in the same language look alike.
      if (matched < Math.min(2, terms.length)) continue;
      const strength = -row.rank;
      hits.push({ uri: row.uri, level: 2, abstract: passageFor(row.content, terms), score: Number((strength / (strength + 6) * 0.5 + matched / terms.length * 0.5).toFixed(4)) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ------------------------------------------------------------------------------------------------ sessions
  sessionUri(id) { return `viking://user/${EMBEDDED_USER}/sessions/${id}`; }
  /** A committed segment as one event: its own words, the user's first line as its title. */
  eventOf(messages, at) {
    const first = messages.find(row => row.role === 'user') ?? messages[0], title = clip(oneLine(String(first?.content ?? '').split('\n').find(line => line.trim()) ?? '') || 'Conversation', 80);
    const body = messages.map(row => `${row.role === 'user' ? 'User' : 'Assistant'}:\n${String(row.content ?? '').trim()}`).join('\n\n');
    const day = new Date(at), slug = Array.from(title.replace(/[\\/?#%\u0000-\u001f:*"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 36).join('').replace(/[ .]+$/g, '').replace(/ /g, '-') || 'conversation';
    return { path: `events/${day.getUTCFullYear()}/${two(day.getUTCMonth() + 1)}/${two(day.getUTCDate())}/${two(day.getUTCHours())}${two(day.getUTCMinutes())}-${slug}`, text: `# ${title}\n\n${body}` };
  }
  commit(db, id, session) {
    const pending = JSON.parse(session.pending);
    if (!pending.length) return ok({ status: 'skipped', archived: false, reason: 'no_messages' });
    const number = session.commits + 1, at = this.now(), settings = JSON.parse(session.body), archive = `${this.sessionUri(id)}/history/archive_${String(number).padStart(3, '0')}`;
    const peer = settings.peer ?? pending.find(row => typeof row.peer_id === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(row.peer_id))?.peer_id ?? 'peer';
    const event = this.eventOf(pending, at), tags = (settings.memory_extraction_config?.events?.tags ?? []).filter(tag => typeof tag === 'string').map(tag => tag.toLowerCase());
    let uri = `viking://user/${EMBEDDED_USER}/peers/${peer}/memories/${event.path}.md`;
    for (let copy = 2; this.file_(db, uri); copy++) uri = `viking://user/${EMBEDDED_USER}/peers/${peer}/memories/${event.path}-${copy}.md`;
    const task = { task_id: `task-${id}-${number}`, task_type: 'session_commit', resource_id: id, status: 'completed', created_at: iso(at),
      result: { session_id: id, archive_uri: archive, memory_diff_uri: `${archive}/memory_diff.json`, memories_extracted: { events: 1 }, token_usage: { total: { total_tokens: 0 } } } };
    const diff = { archive_uri: archive, trace_id: null, extracted_at: iso(at), operations: { adds: [{ uri, memory_type: 'events', after: event.text }], updates: [], deletes: [] }, skipped_operations: [], summary: { total_adds: 1, total_updates: 0, total_deletes: 0, total_skipped: 0 } };
    this.put(db, uri, event.text, { tags, owner: id });
    this.put(db, `${archive}/messages.jsonl`, pending.map(row => JSON.stringify(row)).join('\n'), { owner: id });
    this.put(db, `${archive}/memory_diff.json`, JSON.stringify(diff, null, 2), { owner: id });
    this.put(db, `${archive}/.done`, '{}', { owner: id });   // the marker is written last, as OpenViking does
    db.prepare('insert or replace into tasks(id, type, resource, status, result, created) values(?, ?, ?, ?, ?, ?)').run(task.task_id, task.task_type, id, task.status, JSON.stringify(task), at);
    db.prepare("update sessions set pending = '[]', commits = ? where id = ?").run(number, id);
    return ok({ status: 'accepted', archived: true, task_id: task.task_id, archive_uri: archive });
  }

  // ------------------------------------------------------------------------------------------------ routes
  handle(db, method, path, query, body, actor = null) {
    if (path === '/health') return { status: 200, body: { status: 'ok', healthy: true, version: EMBEDDED_VERSION } };
    if (path === '/ready') return { status: 200, body: { status: 'ready', checks: { agfs: 'ok', vectordb: 'ok', embedding: 'ok' } } };
    if (!path.startsWith('/api/v1/')) return notFound();
    const route = path.slice('/api/v1/'.length), parts = route.split('/'), uri = query.get('uri');
    if (route === 'system/status') return ok({ initialized: true, user: EMBEDDED_USER });

    if (route === 'fs/mkdir' && method === 'POST') {
      if (!validUri(body?.uri)) return refuse(400, 'INVALID_URI', 'invalid uri');
      if (this.isDirectory(db, body.uri)) return refuse(409, 'ALREADY_EXISTS', 'directory exists');
      db.prepare('insert into dirs(uri, description, mtime) values(?, ?, ?)').run(body.uri, typeof body.description === 'string' ? body.description.slice(0, 2000) : null, this.now());
      return ok({ uri: body.uri });
    }
    if (route === 'fs/ls' && method === 'GET') {
      if (!validUri(uri)) return refuse(400, 'INVALID_URI', 'invalid uri');
      if (!this.isDirectory(db, uri)) return notFound();
      const wanted = query.getAll('tags').map(tag => tag.toLowerCase()), withTags = query.get('include_tags') === 'true';
      const limit = Math.max(1, Math.min(10000, Number(query.get('node_limit')) || 1000)), offset = Math.max(0, Number(query.get('offset')) || 0);
      const shape = row => ({ uri: row.uri, name: row.name ?? row.uri.split('/').at(-1), isDir: row.isDir === true, size: row.size ?? 0, modTime: iso(row.mtime), ...(withTags ? { tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags ?? [] } : {}) });
      // Recursive, or filtered by tag: the files themselves (tags are on files only).
      if (query.get('recursive') === 'true' || wanted.length) {
        const files = this.under(db, uri).filter(row => (query.get('recursive') === 'true' || !row.uri.slice(uri.length + 1).includes('/')) && wanted.every(tag => JSON.parse(row.tags).includes(tag)));
        return ok(files.sort((a, b) => b.mtime - a.mtime).slice(offset, offset + limit).map(shape));
      }
      return ok(this.children(db, uri).slice(offset, offset + limit).map(shape));
    }
    if (route === 'fs/stat' && method === 'GET') {
      const file = validUri(uri) ? this.file_(db, uri) : null;
      if (file) return ok({ uri, isDir: false, size: Buffer.byteLength(file.content), modTime: iso(file.mtime) });
      return validUri(uri) && this.isDirectory(db, uri) ? ok({ uri, isDir: true, size: 0 }) : notFound();
    }
    if (route === 'fs' && method === 'DELETE') {
      if (!validUri(uri) || !this.remove(db, uri)) return notFound();
      // The parent's abstract and overview are computed from what it holds, so they are current the moment the file is gone.
      return ok({ uri, semantic_root_uri: parentOf(uri), semantic_status: 'complete' });
    }

    if (route === 'content/write' && method === 'POST') {
      const mode = body?.mode ?? 'upsert';
      if (!validUri(body?.uri) || typeof body.content !== 'string' || body.content.includes('\0') || !['create', 'replace', 'append', 'upsert'].includes(mode)) return refuse(400, 'INVALID_ARGUMENT', 'invalid write');
      const existing = this.file_(db, body.uri);
      if (mode === 'create' && existing) return refuse(409, 'ALREADY_EXISTS', 'file exists');
      if (mode === 'replace' && !existing) return notFound();
      if (this.isDirectory(db, body.uri)) return refuse(409, 'IS_DIRECTORY', 'uri is a directory');
      this.put(db, body.uri, mode === 'append' && existing ? `${existing.content}${body.content}` : body.content);
      return ok({ uri: body.uri, mode, written_bytes: Buffer.byteLength(body.content), content_updated: true, semantic_status: 'complete', vector_status: 'complete', queue_status: { Semantic: { error_count: 0 }, Embedding: { error_count: 0 } } });
    }
    if (route === 'content/read' && method === 'GET') {
      const file = validUri(uri) ? this.file_(db, uri) : null; if (!file) return notFound();
      const offset = Math.max(0, Number(query.get('offset')) || 0), limit = Number(query.get('limit') ?? -1);
      if (offset === 0 && !(limit > 0)) return ok(file.content);
      return ok(file.content.split('\n').slice(offset, limit > 0 ? offset + limit : undefined).join('\n'));
    }
    if ((route === 'content/abstract' || route === 'content/overview') && method === 'GET') {
      const text = validUri(uri) && this.isDirectory(db, uri) ? this.directoryText(db, uri, route === 'content/abstract' ? 0 : 1) : null;
      return text === null ? notFound() : ok(text);
    }
    if (route === 'content/reindex' && method === 'POST') {
      const file = validUri(body?.uri) ? this.file_(db, body.uri) : null; if (!file) return notFound();
      this.put(db, file.uri, file.content);
      return ok({ status: 'completed', uri: file.uri, mode: body.mode, object_type: 'resource', scanned_records: 1, rebuilt_records: 1, failed_records: 0 });
    }
    if ((route === 'search/find' || route === 'search') && method === 'POST') {
      if (typeof body?.query !== 'string' || !validUri(body.target_uri)) return refuse(400, 'INVALID_ARGUMENT', 'invalid search');
      // A level filter of 0 or 1 asks for directory records, which only an embedding index has.
      const hits = body.level === undefined || String(body.level) === '2' ? this.find(db, body.query, body.target_uri, Math.max(1, Math.min(100, Number(body.limit) || 10))) : [];
      const memories = hits.filter(row => /^viking:\/\/user\/[^/]+\/(?:peers\/[^/]+\/)?memories\//.test(row.uri));
      return ok({ memories, resources: hits.filter(row => !memories.includes(row)), skills: [], total: hits.length });
    }

    if (route === 'sessions' && method === 'POST') {
      const id = body?.session_id;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) return refuse(400, 'INVALID_ARGUMENT', 'invalid session id');
      if (db.prepare('select 1 from sessions where id = ?').get(id)) return refuse(409, 'ALREADY_EXISTS', 'session exists');
      db.prepare('insert into sessions(id, body, created) values(?, ?, ?)').run(id, JSON.stringify({ ...body, ...(actor ? { peer: actor } : {}) }), this.now());
      return ok({ session_id: id, uri: this.sessionUri(id), user: { user_id: EMBEDDED_USER } });
    }
    if (parts[0] === 'sessions' && parts[1]) {
      const id = decodeURIComponent(parts[1]), session = db.prepare('select id, body, pending, commits from sessions where id = ?').get(id);
      if (!session) return notFound();
      if (parts[2] === 'messages' && parts[3] === 'batch' && method === 'POST') {
        const messages = Array.isArray(body?.messages) ? body.messages.filter(row => row && ['user', 'assistant'].includes(row.role) && typeof row.content === 'string') : [];
        if (!messages.length || messages.length !== body.messages.length) return refuse(400, 'INVALID_ARGUMENT', 'invalid messages');
        db.prepare('update sessions set pending = ? where id = ?').run(JSON.stringify([...JSON.parse(session.pending), ...messages]), id);
        return ok({ added: messages.length });
      }
      if (parts[2] === 'commit' && method === 'POST') return this.commit(db, id, session);
      if (parts.length === 2 && method === 'GET') return ok({ session_id: id, uri: this.sessionUri(id), user: { user_id: EMBEDDED_USER }, auto_commit_policy: null, message_count: JSON.parse(session.pending).length });
      if (parts.length === 2 && method === 'DELETE') {
        // Its archives and the events they produced go with it; the events are the conversation's own words.
        for (const row of db.prepare('select uri from files where owner = ?').all(id)) this.remove(db, row.uri);
        for (const row of this.under(db, this.sessionUri(id), 'uri')) this.remove(db, row.uri);
        db.prepare('delete from tasks where resource = ?').run(id); db.prepare('delete from sessions where id = ?').run(id);
        return ok({ session_id: id });
      }
      return notFound();
    }

    if (route === 'tasks' && method === 'GET') {
      const type = query.get('task_type'), resource = query.get('resource_id');
      const items = db.prepare('select result from tasks where (? is null or type = ?) and (? is null or resource = ?) order by created').all(type, type, resource, resource).map(row => JSON.parse(row.result));
      return ok({ items, has_more: false, next_cursor: null });
    }
    if (parts[0] === 'tasks' && parts[1]) {
      const row = db.prepare('select result from tasks where id = ?').get(decodeURIComponent(parts[1])); if (!row) return notFound();
      // A commit is finished by the time its task exists, so there is nothing to cancel.
      if (parts[2] === 'cancel') return method === 'POST' ? refuse(409, 'TASK_FINISHED', 'task already finished') : notFound();
      return ok(JSON.parse(row.result));
    }
    return notFound();
  }
}
