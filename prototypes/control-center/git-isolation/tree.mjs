import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { engineError, verifyGitFile } from './env.mjs';
import { REFS } from './contract.mjs';

// Low-level git helpers of the merge engine (design §3). Owner: T1; internal to git-isolation/.
//
// Three places a command runs:
// - objects(): the repository's object store and refs only (`GIT_DIR=<commonDir>`, run in the common dir). No
//   working tree of the user's is read there, so no attribute file of a working tree can name a merge driver.
// - inRoot(): one root (P, S, W or B). P is the user's own folder (git finds its repository as usual); an Rna
//   worktree gets GIT_DIR and GIT_WORK_TREE from its record (RootInfo.gitDir / workTree), never from the folder.
// - both always with the engine environment (no global or system config, fixed settings, drivers turned off).
//
// Paths: a tree path is relative to the repository top; a root path is relative to the root (the project folder
// inside the worktree). They differ by the project's prefix (`sub/dir/` when P is a subfolder of the repository).

export const BIG_OUTPUT = 256 * 1024 * 1024;
export const LIST_OUTPUT = 64 * 1024 * 1024;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REF_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export const isOid = value => typeof value === 'string' && OID.test(value);
export const nullOid = context => '0'.repeat(context.oidLength ?? 40);

/** The engine options of WorkspaceGitService.run for this repository. */
const engineOf = context => ({ excludesFile: context.excludesFile ?? null, config: context.config ?? [] });

/** A command against the object store and refs (no working tree). */
export function objects(context, args, { env, input, raw, maxBytes = LIST_OUTPUT, timeoutMs = 60000 } = {}) {
  const { commonDir } = context.located;
  return context.git.run(commonDir, args, { env: { GIT_DIR: commonDir, ...env }, input, raw, maxBytes, timeoutMs, killSignal: 'SIGTERM', engine: engineOf(context) });
}

/** The folder git sees as the top of a root's working tree (P's repository top, or the worktree's folder). */
export const topOf = (context, root) => (root.isolated ? root.workTree : context.located.top);

/** GIT_DIR / GIT_WORK_TREE of an Rna worktree root (from its record); none for P. */
export const rootEnv = root => (root.isolated ? { GIT_DIR: root.gitDir, GIT_WORK_TREE: root.workTree } : {});

/**
 * A command in a root. `top: true` runs at the top of its working tree (paths are tree paths); otherwise in the
 * root itself (paths are root paths). An Rna worktree's `.git` file is checked (and put back) first.
 */
export async function inRoot(context, root, args, { top = false, env, input, raw, maxBytes = LIST_OUTPUT, timeoutMs = 60000 } = {}) {
  if (root.isolated) {
    if (!root.gitDir || !root.workTree) throw engineError('root_denied', 'An isolated root needs its gitDir and workTree from the record.');
    const checked = await verifyGitFile(root.workTree, root.gitDir);
    if (!checked.ok) throw engineError('worktree_missing', `The worktree at ${root.workTree} is missing or not a worktree.`);
    if (checked.repaired) context.onTampered?.(root);
  }
  return context.git.run(top ? topOf(context, root) : root.root, args, { env: { ...rootEnv(root), ...env }, input, raw, maxBytes, timeoutMs, killSignal: 'SIGTERM', engine: engineOf(context) });
}

/** A git result that must have succeeded, else `code` (`timeout` when it ran out of time). */
export function must(result, what, { code = 'engine_failed', timeout = 'engine_failed', allow = [0] } = {}) {
  if (result.timedOut) throw engineError(timeout, `${what} took too long.`);
  if (result.truncated) throw engineError('engine_failed', `${what} produced more output than allowed.`);
  if (!allow.includes(result.code)) throw engineError(code, `${what} failed (${result.code}): ${String(result.stderr ?? '').trim().slice(0, 500)}`);
  return result;
}

/** Tree path ↔ root path. */
export const toTree = (context, path) => `${context.located.prefix ?? ''}${path}`;
export const toRoot = (context, path) => { const prefix = context.located.prefix ?? ''; return !prefix ? path : path.startsWith(prefix) ? path.slice(prefix.length) : null; };

/** A commit or tree → its tree id. */
export async function peelTree(context, rev) {
  const result = await objects(context, ['rev-parse', '--verify', '-q', `${rev}^{tree}`]);
  const tree = result.stdout.trim();
  if (result.code !== 0 || !isOid(tree)) throw engineError('engine_failed', `Not a commit or tree: ${rev}`);
  return tree;
}

/** The empty tree of this repository's object format. */
export async function emptyTree(context) {
  if (context.emptyTree) return context.emptyTree;
  const result = must(await objects(context, ['hash-object', '-t', 'tree', '-w', '--stdin'], { input: '' }), 'hash-object');
  return context.emptyTree = result.stdout.trim();
}

/**
 * Entries of `tree` at the given tree paths (exact paths; a folder answers as a tree entry) → Map path → { mode,
 * type, oid }. Paths not in the tree are absent from the map.
 */
export async function lsTree(context, tree, paths) {
  const found = new Map();
  const unique = [...new Set(paths)];
  for (let start = 0; start < unique.length; start += 500) {
    const chunk = unique.slice(start, start + 500);
    const result = must(await objects(context, ['ls-tree', '-z', '--full-tree', tree, '--', ...chunk]), 'ls-tree');
    for (const record of result.stdout.split('\0')) {
      const match = /^(\d{6}) (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(record);
      if (match && chunk.includes(match[4])) found.set(match[4], { mode: match[1], type: match[2], oid: match[3] });
    }
  }
  return found;
}

/** Every blob, link and gitlink of `tree` under the tree path `folder` ('' for all), recursively. */
export async function lsTreeUnder(context, tree, folder) {
  const result = must(await objects(context, ['ls-tree', '-r', '-z', '--full-tree', tree, ...(folder ? ['--', folder] : [])]), 'ls-tree');
  const rows = [];
  for (const record of result.stdout.split('\0')) {
    const match = /^(\d{6}) (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(record);
    if (match && (!folder || match[4] === folder || match[4].startsWith(`${folder}/`))) rows.push({ path: match[4], mode: match[1], type: match[2], oid: match[3] });
  }
  return rows;
}

/** The names directly inside each tree folder ('' = the top) of `tree`: Map folder → names. */
export async function folderNames(context, tree, folders) {
  const names = new Map(), wanted = [...new Set(folders)];
  const add = (folder, name) => { if (!names.has(folder)) names.set(folder, []); names.get(folder).push(name); };
  const parse = (stdout, inside) => {
    for (const record of stdout.split('\0')) {
      const match = /^\d{6} \w+ [0-9a-f]+\t([\s\S]*)$/.exec(record);
      if (!match) continue;
      const path = match[1], slash = path.lastIndexOf('/'), folder = slash < 0 ? '' : path.slice(0, slash);
      if (inside(folder)) add(folder, path.slice(slash + 1));
    }
  };
  if (wanted.includes('')) parse(must(await objects(context, ['ls-tree', '-z', '--full-tree', tree]), 'ls-tree').stdout, folder => folder === '');
  const rest = wanted.filter(Boolean);
  for (let start = 0; start < rest.length; start += 500) {
    const chunk = rest.slice(start, start + 500), set = new Set(chunk);
    parse(must(await objects(context, ['ls-tree', '-z', '--full-tree', tree, '--', ...chunk.map(folder => `${folder}/`)]), 'ls-tree').stdout, folder => set.has(folder));
  }
  return names;
}

/**
 * `diff-tree -r -z --no-renames a b` → [{ path, status, old: { mode, oid }|null, next: { mode, oid }|null }]
 * (tree paths). `paths` limits it.
 */
export async function diffTrees(context, a, b, { paths } = {}) {
  if (a === b) return [];
  const result = must(await objects(context, ['diff-tree', '-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', a, b, ...(paths?.length ? ['--', ...paths] : [])]), 'diff-tree');
  const records = result.stdout.split('\0'), rows = [];
  for (let index = 0; index < records.length; index++) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(records[index]);
    if (!match) continue;
    const path = records[++index];
    const [, oldMode, newMode, oldOid, newOid, status] = match;
    rows.push({ path, status, old: /^0+$/.test(oldMode) ? null : { mode: oldMode, oid: oldOid }, next: /^0+$/.test(newMode) ? null : { mode: newMode, oid: newOid } });
  }
  return rows;
}

/** Run `work(env)` with a fresh temporary index in the common dir, removed afterwards. */
export async function withTemporaryIndex(context, work) {
  const folder = join(context.located.commonDir, 'rna', 'tmp');
  await mkdir(folder, { recursive: true });
  const file = join(folder, `index-${process.pid}-${randomBytes(6).toString('hex')}`);
  try { return await work({ GIT_INDEX_FILE: file }); }
  finally { await rm(file, { force: true }); await rm(`${file}.lock`, { force: true }); }
}

/**
 * `base` with `changes` applied → a tree id. A change is `{ path, mode, oid }` (add or replace) or
 * `{ path, delete: true }` (that entry, and anything under it when it is a folder in `base`). Tree paths.
 */
export async function composeTree(context, base, changes) {
  if (!changes.length) return base;
  return withTemporaryIndex(context, async env => {
    must(await objects(context, ['read-tree', base], { env }), 'read-tree');
    const removals = [], additions = [], zero = nullOid(context);
    const deleted = changes.filter(change => change.delete || !change.mode).map(change => change.path);
    if (deleted.length) {
      const folders = await lsTree(context, base, deleted);
      for (const path of deleted) {
        removals.push(path);
        if (folders.get(path)?.type === 'tree') for (const row of await lsTreeUnder(context, base, path)) removals.push(row.path);
      }
    }
    for (const change of changes) if (!(change.delete || !change.mode)) {
      // A folder replaced by a file: everything that was under it goes first.
      additions.push(change);
    }
    const replaced = await lsTree(context, base, additions.map(change => change.path));
    for (const change of additions) if (replaced.get(change.path)?.type === 'tree') for (const row of await lsTreeUnder(context, base, change.path)) removals.push(row.path);
    const lines = [...new Set(removals)].map(path => `0 ${zero}\t${path}\0`).concat(additions.map(change => `${change.mode} ${change.oid}\t${change.path}\0`));
    if (lines.length) must(await objects(context, ['update-index', '-z', '--add', '--replace', '--index-info'], { env, input: lines.join('') }), 'update-index --index-info');
    return must(await objects(context, ['write-tree'], { env }), 'write-tree').stdout.trim();
  });
}

/**
 * Point hidden refs at commits in one `update-ref --stdin` transaction. Refs must be under REFS.root with plain
 * segments; null deletes.
 */
export async function updateRefs(context, updates) {
  if (!updates.length) return;
  const lines = [];
  for (const { ref, commit } of updates) {
    if (typeof ref !== 'string' || !ref.startsWith(REFS.root) || ref.split('/').slice(2).some(segment => !REF_SEGMENT.test(segment) || segment.startsWith('.') || segment.endsWith('.lock')) || ref.includes('..')) throw engineError('engine_failed', `Not an Rna ref: ${ref}`);
    if (commit !== null && !isOid(commit)) throw engineError('engine_failed', `Not a commit id: ${commit}`);
    lines.push(commit === null ? `delete ${ref}\n` : `update ${ref} ${commit}\n`);
  }
  must(await objects(context, ['update-ref', '--stdin'], { input: lines.join('') }), 'update-ref');
}

/** Commit id a ref points at, or null. */
export async function readRef(context, ref) {
  const result = await objects(context, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  const value = result.stdout.trim();
  return result.code === 0 && isOid(value) ? value : null;
}

/** The parents of a commit, in order. */
export async function parentsOf(context, commit) {
  const result = must(await objects(context, ['rev-list', '--parents', '-n', '1', commit]), 'rev-list');
  return result.stdout.trim().split(/\s+/).slice(1);
}

/** At most this many blob bytes are read in one `cat-file --batch` (a single larger blob is read on its own). */
export const BLOB_BATCH_BYTES = 64 * 1024 * 1024;

/**
 * Raw blob bytes by id (`cat-file --batch`), Map oid → Buffer. Batches are cut by size, not count (sizes from
 * `--batch-check` first): a few files near the snapshot limit must not overflow one batch's output cap and fail the
 * whole apply.
 */
export async function readBlobs(context, oids) {
  const unique = [...new Set(oids)].filter(isOid), blobs = new Map();
  for (let start = 0; start < unique.length; start += 500) {
    const ids = unique.slice(start, start + 500), sizes = new Map();
    const checked = must(await objects(context, ['cat-file', '--batch-check'], { input: ids.map(oid => `${oid}\n`).join('') }), 'cat-file --batch-check');
    for (const line of checked.stdout.split('\n')) { const [oid, type, size] = line.split(' '); if (isOid(oid) && type && type !== 'missing') sizes.set(oid, Number(size) || 0); }
    const batches = [];
    let batch = [], bytes = 0;
    for (const oid of ids.filter(id => sizes.has(id))) {
      const size = sizes.get(oid);
      if (batch.length && bytes + size > BLOB_BATCH_BYTES) { batches.push({ ids: batch, bytes }); batch = []; bytes = 0; }
      batch.push(oid); bytes += size;
    }
    if (batch.length) batches.push({ ids: batch, bytes });
    for (const { ids: chunk, bytes: total } of batches) {
      const result = must(await objects(context, ['cat-file', '--batch'], { input: chunk.map(oid => `${oid}\n`).join(''), raw: true, maxBytes: Math.max(BIG_OUTPUT, total + chunk.length * 256 + 1024), timeoutMs: 120000 }), 'cat-file');
      parseBatch(result.stdout, (oid, bytes) => { if (oid) blobs.set(oid, bytes); });
    }
  }
  return blobs;
}

/** Parse `cat-file --batch` output: `<oid> <type> <size>\n<bytes>\n` per object (`<oid> missing\n` skipped). */
export function parseBatch(buffer, each) {
  let offset = 0, index = 0;
  while (offset < buffer.length) {
    const end = buffer.indexOf(10, offset);
    if (end < 0) break;
    const header = buffer.subarray(offset, end).toString('utf8').split(' ');
    offset = end + 1;
    if (header[1] === 'missing' || header.length < 3) { each(null, null, index++); continue; }
    const size = Number(header[2]);
    each(header[0], buffer.subarray(offset, offset + size), index++);
    offset += size + 1;
  }
}
