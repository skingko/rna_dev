import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { atomicWrite, syncDirectory } from './durable-files.mjs';
import { isCommitted } from './state-draft.mjs';

/* Sharded application state. `state.json` is a small manifest; all content
 * lives in immutable, content-addressed nodes under `state.json.d/`: node
 * files, plus (formatVersion 2) a commit log named by the manifest. A large
 * state commits a generation by appending one checksummed log record with its
 * new nodes and root, then one fsync; a checkpoint later turns live log nodes
 * into files and atomically replaces the manifest with a new, empty log. A
 * crash never exposes a mixed generation: readers apply only complete,
 * verified records. Nodes unreachable from the committed root are deleted
 * only after commit.
 *
 * Node files: `{"v":<json>,"p":[[path,ref],...]}` where each path addresses a
 * position in v holding a placeholder equal to ref. A string ref is replaced
 * by the decoded child; an array of refs by the concatenation of those chunk
 * nodes (a large array). The root node is embedded in the manifest. Large
 * containers are split bottom-up by serialized size; large arrays are cut with
 * content-defined boundaries (element id hash) so appends, front trims and
 * in-place edits rewrite only the chunks they touch. */
export const STATE_SHARD_FORMAT = 'rna-sharded-state';
// Below INLINE the whole state lives in the manifest's root node: one file,
// the same two fsyncs as a monolithic write, and fsync latency (not bytes)
// dominates at that size. Larger states are split into nodes.
export const INLINE_LIMIT = 256 * 1024;
const SPLIT = 16 * 1024, MEDIUM = 2 * 1024, ELEMENT = 8 * 1024, CHUNK = 16 * 1024, MAX_CHUNK = 4 * CHUNK, MAX_DEPTH = 5;
const HASH = /^[a-f0-9]{64}$/, NODE = /^[a-f0-9]{64}\.json$/, LOG = /^log-\d+-[a-f0-9]{8}\.jsonl$/;
export const shardDirectory = file => `${file}.d`;
const sha = text => createHash('sha256').update(text).digest('hex');
const corrupt = message => Object.assign(new Error(`分片状态损坏：${message}`), { code: 'STATE_SHARD_CORRUPT' });
export const isShardManifest = value => Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.format === STATE_SHARD_FORMAT);
function fnv(text) { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }

// Every node registration is logged (even a repeat within one generation) so a
// cached subtree can re-register exactly the nodes it produced.
function register(e, content, hash) {
  e.log.push([content, hash]);
  if (e.contents.has(content)) return hash;
  if (!e.known.has(content)) e.fresh.push([hash, content]);
  e.contents.set(content, hash); e.size += content.length;
  return hash;
}
function store(e, content) { return register(e, content, e.contents.get(content) ?? e.known.get(content) ?? sha(content)); }
function seal(e, json, start, end = e.refs.length) {
  const depth = e.path.length, own = e.refs.splice(start, end - start).map(([path, hash]) => [path.slice(depth), hash]); e.lastRefs = own;
  return store(e, `{"v":${json},"p":${JSON.stringify(own)}}`);
}
function ref(e, target) { e.refs.push([[...e.path], target]); return e.placeholder = JSON.stringify(target); }
// Committed state is immutable (state-draft.mjs), so an unchanged subtree is
// the identical object: its serialized part, the refs and nodes it produced,
// its chunk spans, the node its parent sealed it into and the array chunks it
// starts are all reused instead of re-stringified and re-hashed.
function replay(e, hit) {
  for (const [path, hash] of hit.refs) e.refs.push([[...e.path, ...path], hash]);
  for (const [content, hash] of hit.nodes) register(e, content, hash);
  for (const [path, span] of hit.spans) { const absolute = [...e.path, ...path]; e.nextSpans.set(absolute.join('\u0000'), span); e.spanLog.push([absolute, span]); }
  if (hit.placeholder) e.placeholder = hit.part;
  return hit.part;
}
// Seal child i of the container at e.path into its own node (a large element
// of a large array, or a medium field of a large object).
function sealChild(e, value, key, part, start, end) {
  const moved = e.refs.splice(end), cached = e.cache && isCommitted(value) ? e.cache.nodes.get(value) : undefined;
  e.path.push(key);
  let hash;
  if (cached && cached.depth === e.path.length) { e.refs.splice(start); hash = register(e, cached.content, cached.hash); }
  else {
    const from = e.log.length; hash = seal(e, part, start);
    if (e.cache && isCommitted(value)) { const [content] = e.log[from]; e.cache.nodes.set(value, { depth: e.path.length, content, hash }); }
  }
  e.refs.push([[...e.path], hash]); e.path.pop();
  for (const row of moved) e.refs.push(row);
  return `"${hash}"`;
}
function chunked(e, value, parts, start) {
  const all = e.refs.splice(start), depth = e.path.length, key = e.path.join('\u0000');
  let total = 0; for (const part of parts) total += part.length + 1;
  // Expected elements per chunk is a power of two with hysteresis, so slow
  // average-size drift does not move every boundary on each write.
  const ideal = 2 ** Math.max(0, Math.min(12, Math.round(Math.log2(Math.max(1, CHUNK * value.length / total)))));
  let span = e.spans.get(key); if (!span || ideal >= span * 4 || ideal * 4 <= span) span = ideal; e.nextSpans.set(key, span); e.spanLog.push([[...e.path], span]);
  const hashes = [], chunks = e.cache?.chunks; let from = 0, bytes = 0, r = 0;
  for (let i = 0; i < value.length; i++) {
    bytes += parts[i].length + 1;
    const item = value[i], id = item && typeof item === 'object' && typeof item.id === 'string' ? item.id : parts[i].length > 256 ? `${parts[i].length}:${parts[i].slice(0, 256)}` : parts[i];
    if (i === value.length - 1 || fnv(id) % span === 0 || bytes >= MAX_CHUNK) {
      const own = []; while (r < all.length && all[r][0][depth] <= i) { const [path, hash] = all[r++]; own.push([[path[depth] - from, ...path.slice(depth + 1)], hash]); }
      // A chunk of the same committed elements (by identity) at the same depth
      // has the same content.
      const first = value[from], cached = chunks && isCommitted(first) ? chunks.get(first) : undefined;
      if (cached && cached.depth === depth && cached.items.length === i + 1 - from && cached.items.every((row, k) => row === value[from + k])) hashes.push(register(e, cached.content, cached.hash));
      else {
        const content = `{"v":[${parts.slice(from, i + 1).join(',')}],"p":${JSON.stringify(own)}}`, hash = store(e, content);
        if (chunks && isCommitted(first)) { const items = value.slice(from, i + 1); if (items.every(isCommitted)) chunks.set(first, { depth, items, content, hash }); }
        hashes.push(hash);
      }
      from = i + 1; bytes = 0;
    }
  }
  return hashes;
}
// Byte-for-byte JSON.stringify semantics for plain data, splitting as it goes.
function serialize(e, value, depth, element = false) {
  if (value === null || typeof value !== 'object' || depth >= MAX_DEPTH || typeof value.toJSON === 'function') return JSON.stringify(value);
  const cacheable = e.cache && depth > 0 && isCommitted(value);
  if (cacheable) { const hit = e.cache.parts.get(value); if (hit && hit.depth === depth) return replay(e, hit); }
  const start = e.refs.length, logStart = e.log.length, spanStart = e.spanLog.length;
  const part = serializeContainer(e, value, depth, start);
  // Array elements and subtrees that produced nodes are cached; other fields
  // are covered by their parent's cached part.
  if (cacheable && part !== undefined && (e.refs.length > start || element && part.length >= 256)) {
    const base = e.path.length;
    e.cache.parts.set(value, { depth, part, placeholder: e.placeholder === part, refs: e.refs.slice(start).map(([path, hash]) => [path.slice(base), hash]), nodes: e.log.slice(logStart), spans: e.spanLog.slice(spanStart).map(([path, span]) => [path.slice(base), span]) });
  }
  return part;
}
function serializeContainer(e, value, depth, start) {
  if (Array.isArray(value)) {
    const parts = new Array(value.length), starts = new Array(value.length); let size = 2;
    const refs = new Array(value.length);
    for (let i = 0; i < value.length; i++) { starts[i] = e.refs.length; e.placeholder = null; e.path.push(i); parts[i] = serialize(e, value[i], depth + 1, true) ?? 'null'; e.path.pop(); refs[i] = parts[i] === e.placeholder; size += parts[i].length + 1; }
    if (depth === 0 || size <= SPLIT) return `[${parts.join(',')}]`;
    // Large elements of a large array are nodes of their own (a project or a
    // session inside its list), so chunks stay small and edits stay local.
    for (let i = parts.length - 1; i >= 0; i--) {
      if (refs[i] || parts[i].length < ELEMENT || (parts[i][0] !== '{' && parts[i][0] !== '[')) continue;
      const before = parts[i].length;
      parts[i] = sealChild(e, value[i], i, parts[i], starts[i], i + 1 < starts.length ? starts[i + 1] : e.refs.length);
      size += parts[i].length - before;
    }
    // Few large elements: the list of their references stays inline. (The
    // joined length is size - 1: n parts need n - 1 commas.)
    if (size - 1 <= SPLIT) return `[${parts.join(',')}]`;
    return ref(e, value.length > 1 ? chunked(e, value, parts, start) : seal(e, `[${parts.join(',')}]`, start));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return JSON.stringify(value);
  const keys = [], parts = [], starts = [], refs = []; let size = 2;
  for (const key of Object.keys(value)) {
    const from = e.refs.length; e.placeholder = null; e.path.push(key); const part = serialize(e, value[key], depth + 1); e.path.pop();
    if (part !== undefined) { keys.push(key); parts.push(part); starts.push(from); refs.push(part === e.placeholder); size += key.length + part.length + 4; }
  }
  // A large object keeps only small fields inline: every medium container
  // child becomes its own node, so one field edit rewrites only that field.
  if (size > SPLIT) for (let i = parts.length - 1; i >= 0; i--) {
    if (refs[i] || parts[i].length < MEDIUM || (parts[i][0] !== '{' && parts[i][0] !== '[')) continue;
    parts[i] = sealChild(e, value[keys[i]], keys[i], parts[i], starts[i], i + 1 < starts.length ? starts[i + 1] : e.refs.length);
  }
  const json = `{${parts.map((part, i) => `${JSON.stringify(keys[i])}:${part}`).join(',')}}`;
  if (depth === 0 || json.length <= SPLIT) return json;
  return ref(e, seal(e, json, start));
}
/** Cross-generation encoder cache for committed (immutable) state objects. */
export const encoderCache = () => ({ parts: new WeakMap(), nodes: new WeakMap(), chunks: new WeakMap() });
/** Encode a state into nodes. `known` maps committed node content to hash;
 * only content missing from it is returned in `fresh` (needs writing). With a
 * `cache`, committed subtrees unchanged since an earlier encode are reused. */
export function encodeState(state, { known = new Map(), spans = new Map(), cache = null } = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('State must be an object');
  const e = { known, spans, nextSpans: new Map(), contents: new Map(), fresh: [], refs: [], path: [], size: 0, log: [], spanLog: [], cache };
  const json = serialize(e, state, 0);
  // The root changes on every write (revision); it is embedded in the
  // manifest, so a small state commits with the same two fsyncs as before.
  const root = seal(e, json, 0), rootContent = `{"v":${json},"p":${JSON.stringify(e.lastRefs)}}`;
  return { root, rootContent, contents: e.contents, fresh: e.fresh.filter(([hash]) => hash !== root), spans: e.nextSpans, size: e.size };
}

function inlinePlan(json, known) {
  const content = `{"v":${json},"p":[]}`, hash = known.get(content) ?? sha(content);
  return { root: hash, rootContent: content, contents: new Map([[content, hash]]), fresh: [], spans: new Map(), size: content.length, inline: true };
}
function readNode(directory, hash, contents, embedded, logged) {
  if (!HASH.test(hash ?? '')) throw corrupt('节点引用无效');
  let content = embedded?.get(hash);
  if (content === undefined) content = logged?.get(hash);
  if (content === undefined) try { content = readFileSync(join(directory, `${hash}.json`), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') throw Object.assign(corrupt(`缺少节点 ${hash.slice(0, 12)}`), { missing: true }); throw error; }
  if (sha(content) !== hash) throw corrupt(`节点校验失败 ${hash.slice(0, 12)}`);
  contents.set(content, hash);
  return content;
}
function decodeNode(directory, hash, contents, embedded, depth = 0, logged = null) {
  if (depth > 64) throw corrupt('节点层级过深');
  let node; try { node = JSON.parse(readNode(directory, hash, contents, embedded, logged)); } catch (error) { if (error.code) throw error; throw corrupt('节点不是有效 JSON'); }
  if (!node || !Object.hasOwn(node, 'v') || !Array.isArray(node.p)) throw corrupt('节点结构无效');
  const value = node.v;
  for (const entry of node.p) {
    const [path, child] = Array.isArray(entry) ? entry : [];
    if (!Array.isArray(path) || !path.length) throw corrupt('节点路径无效');
    let parent = value; for (const key of path.slice(0, -1)) parent = parent?.[key];
    const last = path.at(-1);
    const held = parent?.[last];
    if (!parent || typeof parent !== 'object' || (Array.isArray(child) ? !Array.isArray(held) || held.length !== child.length || held.some((hash, i) => hash !== child[i]) : held !== child)) throw corrupt('节点路径与占位不一致');
    if (!Array.isArray(child)) { parent[last] = decodeNode(directory, child, contents, embedded, depth + 1, logged); continue; }
    const out = [];
    for (const hash of child) { const part = decodeNode(directory, hash, contents, embedded, depth + 1, logged); if (!Array.isArray(part)) throw corrupt('数组分块无效'); for (const item of part) out.push(item); }
    parent[last] = out;
  }
  return value;
}
function manifestOf(raw) {
  let parsed; try { parsed = JSON.parse(raw); } catch (error) { throw Object.assign(new Error(`状态文件不是有效 JSON：${error.message}`), { code: 'STATE_INVALID_JSON' }); }
  if (isShardManifest(parsed) && (![1, 2].includes(parsed.formatVersion) || (parsed.formatVersion === 2) !== LOG.test(parsed.log ?? '') || !HASH.test(parsed.root ?? '') || !Number.isSafeInteger(parsed.generation) || (parsed.rootNode !== undefined && typeof parsed.rootNode !== 'string'))) throw corrupt('清单格式不受支持');
  return parsed;
}
/* Commit log. Line: `<json> <sha256(json)>\n`, json = { generation, version,
 * revision, committedAt, root, rootNode, nodes: [[hash, content], ...] } with
 * generations consecutive from the manifest's. Only a final line without its
 * newline is a torn (uncommitted) append; any other invalid line is corrupt. */
function readLog(directory, manifest) {
  let text; try { text = readFileSync(join(directory, manifest.log), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') throw Object.assign(corrupt('缺少状态日志'), { missing: true }); throw error; }
  const nodes = new Map(); let head = manifest, records = 0;
  for (let at = 0; ;) {
    const end = text.indexOf('\n', at); if (end < 0) break;
    const line = text.slice(at, end), split = line.lastIndexOf(' '), body = line.slice(0, split); at = end + 1;
    if (split < 0 || sha(body) !== line.slice(split + 1)) throw corrupt(`状态日志校验失败（第 ${records + 1} 条）`);
    let record; try { record = JSON.parse(body); } catch { throw corrupt('状态日志不是有效 JSON'); }
    if (!record || record.generation !== head.generation + 1 || !HASH.test(record.root ?? '') || typeof record.rootNode !== 'string' || !Array.isArray(record.nodes)) throw corrupt('状态日志记录无效');
    for (const row of record.nodes) { if (!Array.isArray(row) || !HASH.test(row[0] ?? '') || typeof row[1] !== 'string') throw corrupt('状态日志节点无效'); nodes.set(row[0], row[1]); }
    head = record; records++;
  }
  return { head, nodes, records, bytes: Buffer.byteLength(text) };
}
/** Read a state file in either layout. Returns null when absent, otherwise
 * `{ state, legacy, manifest, contents, root, generation, logged }` where
 * `logged` maps live node hashes held only by the commit log to content.
 * Retries when a concurrent writer checkpoints and collects mid-read. */
export function readStateFile(file, { attempts = 4 } = {}) {
  let previous = null;
  for (let attempt = 1; ; attempt++) {
    let raw; try { raw = readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const parsed = manifestOf(raw);
    if (!isShardManifest(parsed)) return { state: parsed, legacy: true, manifest: null, contents: new Map() };
    try {
      const directory = shardDirectory(file), log = parsed.log ? readLog(directory, parsed) : null, head = log?.head ?? parsed;
      const contents = new Map(), embedded = new Map(head.rootNode === undefined ? [] : [[head.root, head.rootNode]]);
      const state = decodeNode(directory, head.root, contents, embedded, 0, log?.nodes);
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw corrupt('根节点不是对象');
      const logged = new Map(); if (log) for (const hash of contents.values()) if (log.nodes.has(hash)) logged.set(hash, log.nodes.get(hash));
      return { state, legacy: false, manifest: parsed, contents, root: head.root, generation: head.generation, logged, log: log && { name: parsed.log, records: log.records, bytes: log.bytes } };
    } catch (error) {
      if (!error.missing || attempt >= attempts || raw === previous) throw error;
      previous = raw;
    }
  }
}
/** Serialized application state (compact JSON) regardless of layout. */
export function readStateText(file) { const loaded = readStateFile(file); return loaded ? JSON.stringify(loaded.state) : null; }
/** Every file under the node directory the committed generation needs
 * (node files and the commit log; relative names). */
export function reachableShardFiles(file) {
  const loaded = readStateFile(file);
  if (loaded?.legacy !== false) return [];
  return [...[...new Set(loaded.contents.values())].filter(hash => hash !== loaded.root && !loaded.logged.has(hash)).map(hash => `${hash}.json`), ...(loaded.manifest.log ? [loaded.manifest.log] : [])].sort();
}
function writeNode(path, content) {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`; let fd, done = false;
  try { fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, content); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, path); done = true; }
  finally { if (fd !== undefined) closeSync(fd); if (!done) try { unlinkSync(temp); } catch { /* original error wins */ } }
}
// A checkpoint rewrites the manifest and starts an empty log once the log
// holds this much; a purge (deleted content) or the first commit after a load
// checkpoints immediately.
export const LOG_LIMIT = 8 * 1024 * 1024, LOG_RECORDS = 4096;

/* Writer. A large state commits by appending one record (its fresh nodes and
 * root) to the commit log and one fsync; the manifest is rewritten only at a
 * checkpoint, which first makes every live log-held node a node file. Inline
 * (small) states keep the single atomic manifest write (formatVersion 1). */
export class ShardedStateFile {
  constructor(file) {
    this.file = file; this.directory = shardDirectory(file);
    this.contents = new Map(); this.spans = new Map(); this.sizes = new Map(); this.generation = 0; this.root = null; this.size = null; this.hooks = {};
    this.cache = encoderCache(); this.log = null; this.logged = new Map(); this.logBytes = 0; this.logRecords = 0; this.checkpointNext = true;
  }
  /** Load either layout. A missing manifest beside populated shards fails
   * closed instead of starting fresh and collecting the only copy. */
  load() {
    const loaded = readStateFile(this.file);
    if (!loaded) {
      let entries = []; try { entries = readdirSync(this.directory).filter(name => NODE.test(name) || LOG.test(name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (entries.length) throw corrupt('缺少状态清单，但分片目录仍有内容；已停止以避免覆盖');
      return null;
    }
    if (!loaded.legacy) {
      this.contents = loaded.contents; this.generation = loaded.generation; this.root = loaded.root; this.size = 0; this.log = loaded.manifest.log ?? null; this.logged = loaded.logged;
      for (const [content, hash] of this.contents) { this.sizes.set(hash, Buffer.byteLength(content)); this.size += content.length; }
    }
    // The first commit of a writer always checkpoints: it drops a torn log
    // tail and every dead log record before appending again.
    this.checkpointNext = true;
    return loaded;
  }
  plan(state) {
    if (this.size === null || this.size <= INLINE_LIMIT) {
      const json = JSON.stringify(state);
      if (typeof json === 'string' && json.length <= INLINE_LIMIT) return inlinePlan(json, this.contents);
    }
    const plan = encodeState(state, { known: this.contents, spans: this.spans, cache: this.cache });
    // A state that shrank below the split thresholds encodes to its root
    // alone: the same content as the inline layout, committed as such.
    if (plan.contents.size === 1 && plan.size <= INLINE_LIMIT) plan.inline = true;
    return plan;
  }
  /** Commit a plan. A thrown error carries `committed` when the new
   * generation is already visible on disk. `purge` checkpoints so that no
   * superseded content (a deleted session) survives in the log. */
  commit(plan, state, { purge = false } = {}) {
    if (plan.inline || purge || this.checkpointNext || !this.log || this.logBytes >= LOG_LIMIT || this.logRecords >= LOG_RECORDS) return this.checkpoint(plan, state);
    return this.append(plan, state);
  }
  sizesFor(plan, fresh) {
    const sizes = new Map(); let bytes = 0;
    for (const hash of plan.contents.values()) { if (hash === plan.root) continue; const size = this.sizes.get(hash) ?? fresh.get(hash) ?? 0; sizes.set(hash, size); bytes += size; }
    return { sizes, bytes };
  }
  adopt(plan, sizes) {
    const previous = { contents: this.contents, root: this.root };
    this.contents = plan.contents; this.root = plan.root; this.spans = plan.spans; this.sizes = sizes; this.size = plan.size; this.generation++;
    return previous;
  }
  append(plan, state) {
    const fresh = new Map(plan.fresh.map(([hash, content]) => [hash, Buffer.byteLength(content)])), { sizes, bytes } = this.sizesFor(plan, fresh);
    const body = JSON.stringify({ generation: this.generation + 1, version: state.version, revision: state.revision, committedAt: new Date().toISOString(), root: plan.root, rootNode: plan.rootContent, nodes: plan.fresh });
    const line = Buffer.from(`${body} ${sha(body)}\n`);
    this.hooks.beforeCommit?.(plan);
    let fd, visible = false;
    try {
      fd = openSync(join(this.directory, this.log), 'a');
      for (let offset = 0; offset < line.length;) { const count = writeSync(fd, line, offset, line.length - offset); if (!count) throw Object.assign(new Error('状态日志写入没有进展'), { code: 'EIO' }); offset += count; }
      visible = true; fsyncSync(fd);
    } catch (error) {
      // A partial line is a torn tail (ignored by readers); a complete one is
      // visible even if its fsync failed. Either way the writer latches.
      error.committed = visible; if (visible) this.adoptAppend(plan, sizes, line.length);
      throw error;
    } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* the commit outcome is already decided */ } }
    const previous = this.adoptAppend(plan, sizes, line.length);
    this.collect(previous);
    return { written: line.length, files: 1, bytes, nodes: plan.contents.size, fsyncs: 1, log: true };
  }
  adoptAppend(plan, sizes, bytes) {
    const previous = this.adopt(plan, sizes), live = new Set(plan.contents.values());
    for (const [hash, content] of plan.fresh) this.logged.set(hash, content);
    for (const hash of this.logged.keys()) if (!live.has(hash)) this.logged.delete(hash);
    this.logBytes += bytes; this.logRecords++;
    return previous;
  }
  /** Make every live node a file, then atomically replace the manifest with a
   * fresh empty log. An inline state, or a `final` checkpoint (clean service
   * stop), has no log: formatVersion 1, which earlier releases also read. */
  checkpoint(plan, state, { final = false } = {}) {
    const writes = new Map(plan.fresh);
    for (const hash of plan.contents.values()) if (hash !== plan.root && this.logged.has(hash)) writes.set(hash, this.logged.get(hash));
    const log = plan.inline || final ? null : `log-${this.generation + 1}-${randomUUID().slice(0, 8)}.jsonl`;
    let fsyncs = 0;
    // A newly created node directory is made durable in its parent before any
    // manifest can reference it.
    if ((writes.size || log) && !existsSync(this.directory)) { mkdirSync(this.directory, { mode: 0o700 }); syncDirectory(dirname(this.file)); fsyncs++; }
    let written = 0; const fresh = new Map();
    if (log) { const fd = openSync(join(this.directory, log), 'wx', 0o600); closeSync(fd); }
    for (const [hash, content] of writes) { writeNode(join(this.directory, `${hash}.json`), content); const size = Buffer.byteLength(content); fresh.set(hash, size); written += size; fsyncs++; }
    if (writes.size || log) { syncDirectory(this.directory); fsyncs++; }
    this.hooks.beforeManifest?.(plan);
    const { sizes, bytes } = this.sizesFor(plan, fresh);
    const manifest = JSON.stringify({ format: STATE_SHARD_FORMAT, formatVersion: log ? 2 : 1, version: state.version, revision: state.revision, generation: this.generation + 1, root: plan.root, nodes: plan.contents.size, bytes, committedAt: new Date().toISOString(), rootNode: plan.rootContent, ...(log ? { log } : {}) });
    const oldLog = this.log;
    const adopt = () => { const previous = this.adopt(plan, sizes); this.log = log; this.logged = new Map(); this.logBytes = 0; this.logRecords = 0; this.checkpointNext = false; return previous; };
    try { atomicWrite(this.file, manifest); }
    catch (error) { if (error.committed) adopt(); else if (log) try { unlinkSync(join(this.directory, log)); } catch { /* swept */ } throw error; }
    const previous = adopt();
    if (oldLog && oldLog !== log) try { unlinkSync(join(this.directory, oldLog)); } catch { /* swept on next start */ }
    this.collect(previous);
    return { written: written + Buffer.byteLength(manifest), files: writes.size + 1, bytes: bytes + Buffer.byteLength(manifest), nodes: plan.contents.size, fsyncs: fsyncs + 2, log: false };
  }
  write(state, options) { return this.commit(this.plan(state), state, options); }
  /** Delete node files of the superseded generation. Failures leave orphans for sweep(). */
  collect(previous) {
    const live = this.files();
    for (const hash of new Set(previous.contents.values())) if (hash !== previous.root && !live.has(hash)) try { unlinkSync(join(this.directory, `${hash}.json`)); } catch { /* log-held, or swept on next start */ }
  }
  /** Offline/startup garbage collection: remove every unreachable node, stale log and temp file. */
  files() { const live = new Set(this.contents.values()); live.delete(this.root); return live; }
  sweep() {
    const live = this.files(); let removed = 0;
    let names = []; try { names = readdirSync(this.directory); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    for (const name of names) {
      if (NODE.test(name) ? live.has(name.slice(0, 64)) : LOG.test(name) ? name === this.log : !/^[a-f0-9]{64}\.json\.tmp-/.test(name)) continue;
      try { if (lstatSync(join(this.directory, name)).isFile()) { unlinkSync(join(this.directory, name)); removed++; } } catch { /* retried next start */ }
    }
    return removed;
  }
}
/** Legacy monolithic backups kept until the sharded generation verifies. */
export function legacyStateBackups(file) {
  const prefix = `${basename(file)}.legacy-`;
  try { return readdirSync(dirname(file)).filter(name => name.startsWith(prefix)).map(name => join(dirname(file), name)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
/** Offline writer (recovery, restore staging): checkpoint a whole state and,
 * with `sweep`, remove every node the new generation does not reference. */
export function writeStateFile(file, state, { sweep = true } = {}) {
  const shards = new ShardedStateFile(file);
  try { shards.load(); } catch (error) { if (error.code !== 'STATE_SHARD_CORRUPT' && error.code !== 'STATE_INVALID_JSON') throw error; }
  const result = shards.checkpoint(shards.plan(state), state);
  if (sweep) shards.sweep();
  return result;
}
