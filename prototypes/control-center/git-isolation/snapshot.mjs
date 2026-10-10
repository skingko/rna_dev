import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LIMITS, SECRET_FILES_VERSION, isSecretPath } from './contract.mjs';
import { engineError } from './env.mjs';
import { inRoot, isOid, must, objects, updateRefs, LIST_OUTPUT } from './tree.mjs';

// Snapshots (design §3.2) and pinning (§3.3). Owner: T1.
//
// A snapshot reads a root through a private index (never the user's `.git/index`), writes a tree and a commit on
// no branch, and leaves HEAD, branches, the user's index, stash and config untouched. Merges read snapshots, never
// folders (invariant §0.3-5).
//
// The private index is a cache of the last snapshot of that root, so `ls-files -m -d -o` lists only what changed
// since. It is brought back in line with the root's HEAD (`read-tree -m -i`, which keeps the file facts of entries that
// match, so only what HEAD changed is hashed again) whenever HEAD moved, an ignore file changed (info/exclude, the
// global excludes file, or any `.gitignore` the listing shows as changed), or its notes are missing: an untracked
// file added earlier that is now ignored then leaves the snapshot, and a tracked file that is ignored stays in it.
//
// Files that hold secrets (SECRET_FILES, mu checkpoints.md §2) are never hashed: a listed one is left at the private
// index's version (HEAD's for a tracked one, absent for an untracked one), so its content never enters the object
// store, no refs/rna commit reaches it and no merge, rollback or discard ever writes it. The notes carry
// SECRET_FILES_VERSION, so an index written before (or under another table) is rebuilt from HEAD once, which drops
// what an older snapshot took in.

/**
 * @typedef {object} EngineContext  What every engine function receives (built by IsolationEngine).
 * @property {import('../workspace-git-service.mjs').WorkspaceGitService} git
 * @property {{ workspace: string, top: string, gitDir: string, commonDir: string, prefix: string }} located
 * @property {string|null} excludesFile
 * @property {string[]} [config]   `-c` overrides (driverOverrides) of every engine command in this repository
 * @property {boolean} [ignoreCase] core.ignoreCase of the repository (case-insensitive volume)
 * @property {boolean} [fileMode]   core.fileMode (false: the executable bit is not tracked)
 * @property {number} [oidLength]   40 (sha1) or 64 (sha256)
 * @property {string|null} [autocrlf] core.autocrlf of the repository ('true': every text file is converted on checkout)
 * @property {(root: object) => void} [onTampered]
 */

const busy = new Map();
/** One snapshot of a root at a time (its private index has one writer). */
function exclusive(key, work) {
  const previous = busy.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  busy.set(key, next);
  return next.finally(() => { if (busy.get(key) === next) busy.delete(key); });
}
const facts = async path => { const info = await stat(path).catch(() => null); return info ? [info.size, info.mtimeMs, info.ino] : null; };
const firstSegment = path => path.split('/')[0].toLowerCase();

/**
 * The private index of a root: `$GIT_COMMON_DIR/rna/index/<first 16 hex of sha256(realpath of root)>`. A cache:
 * deletable at any time; rebuilt with `read-tree HEAD` (empty without commits) when missing or when any
 * `.gitignore` or info/exclude changed since the last snapshot.
 * @param {string} commonDir
 * @param {string} root  realpath
 * @returns {string}
 */
export function privateIndexPath(commonDir, root) {
  return join(commonDir, 'rna', 'index', createHash('sha256').update(root).digest('hex').slice(0, 16));
}

/**
 * Snapshot one root (P, S, W or B): `ls-files -z -m -d -o --exclude-standard -- .` (kept inside the prefix),
 * nested repositories (`dir/`) and files over LIMITS.snapshotFileBytes skipped and reported, SECRET_FILES left at
 * the private index's version and reported (`secret`), `.rna/` dropped,
 * `update-index -z --add --remove --stdin`, `write-tree`, `commit-tree <tree> [-p HEAD]`. All or nothing: an
 * unreadable file fails the whole snapshot (`snapshot_unreadable`); past LIMITS.snapshotTimeoutMs it fails with
 * `snapshot_timeout`. With `pin`, the commit is pinned at that ref before returning.
 * @param {EngineContext} context
 * @param {import('./contract.mjs').RootInfo} root
 * @param {{ pin?: string, signal?: AbortSignal, timeoutMs?: number, laid?: object[]|null }} [options]  `laid`: an isolated
 *   root's worktree record `laid` (its laid-down copies' facts), for telling its owner's secret changes from them
 * @returns {Promise<import('./contract.mjs').Snapshot>}
 */
export async function snapshot(context, root, { pin, signal, timeoutMs = LIMITS.snapshotTimeoutMs, laid = null } = {}) {
  const info = await stat(root.root).catch(() => null);
  if (!info?.isDirectory()) throw engineError(root.isolated ? 'worktree_missing' : 'snapshot_unreadable', `The folder ${root.root} is missing.`);
  const index = privateIndexPath(context.located.commonDir, root.root), deadline = Date.now() + timeoutMs;
  const left = () => { if (signal?.aborted) throw Object.assign(new Error('The snapshot was stopped.'), { name: 'AbortError', code: 'aborted' }); const ms = deadline - Date.now(); if (ms <= 0) throw engineError('snapshot_timeout', 'The snapshot took too long.'); return ms; };
  const run = (args, options = {}) => inRoot(context, root, args, { ...options, env: { GIT_INDEX_FILE: index, ...options.env }, timeoutMs: left() });
  const result = await exclusive(index, async () => {
    await mkdir(dirname(index), { recursive: true });
    const headResult = await run(['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
    const head = headResult.code === 0 && isOid(headResult.stdout.trim()) ? headResult.stdout.trim() : null;
    const notes = await readFile(`${index}.json`, 'utf8').then(JSON.parse).catch(() => null);
    const ignores = JSON.stringify([await facts(join(context.located.commonDir, 'info', 'exclude')), context.excludesFile ? await facts(context.excludesFile) : null, { secrets: SECRET_FILES_VERSION }]);
    const exists = Boolean(await lstat(index).catch(() => null));
    const rebuild = async () => {
      if (!head) must(await run(['read-tree', '--empty']), 'read-tree', { timeout: 'snapshot_timeout' });
      // `-i`: the private index is only a cache of the root, so the folder never has to be "up to date" with it; without
      // it git refuses (exit 128, "not uptodate") a path HEAD changed whose file also changed since the last snapshot.
      else must(await run(['read-tree', ...(await lstat(index).catch(() => null) ? ['-m', '-i'] : []), head]), 'read-tree', { timeout: 'snapshot_timeout' });
    };
    if (!exists || !notes || notes.head !== head || notes.ignores !== ignores) await rebuild();
    let rebuilt = !exists || !notes || notes.head !== head || notes.ignores !== ignores, fresh = false;
    for (;;) {
      // Fresh file facts first, so a file that was touched but not changed is not listed (and not hashed) again.
      must(await run(['update-index', '-q', '--refresh'], { top: true }), 'update-index --refresh', { allow: [0, 1], timeout: 'snapshot_timeout' });
      const listed = must(await run(['ls-files', '-z', '-m', '-d', '-o', '--exclude-standard', '--', '.'], { maxBytes: LIST_OUTPUT }), 'ls-files', { timeout: 'snapshot_timeout' });
      const paths = [...new Set(listed.stdout.split('\0').filter(Boolean))];
      // An ignore file changed since the last snapshot: what it now ignores must leave the private index first.
      if (!rebuilt && paths.some(path => path.split('/').at(-1) === '.gitignore')) { await rebuild(); rebuilt = true; continue; }
      const nested = [], oversized = [], update = [], remove = [], secret = [];
      for (const path of paths) {
        if (firstSegment(path) === '.rna') continue;
        // Never hashed, never removed: the private index keeps what it holds for it (HEAD's version, or nothing).
        if (isSecretPath(path)) { secret.push(path); continue; }
        if (path.endsWith('/')) { nested.push(path); continue; }
        left();
        const file = await lstat(join(root.root, path)).catch(error => (error.code === 'ENOENT' || error.code === 'ENOTDIR' ? null : Promise.reject(engineError('snapshot_unreadable', `${path}: ${error.message}`))));
        // A folder where a file was: gone from the snapshot. A submodule (a folder with its own `.git`) stays as it is.
        if (file?.isDirectory() && await lstat(join(root.root, path, '.git')).then(() => true, () => false)) { nested.push(`${path}/`); continue; }
        if (!file || file.isDirectory()) { remove.push(path); continue; }
        if (file.isFile() && file.size > LIMITS.snapshotFileBytes) { oversized.push(path); continue; }
        update.push(path);
      }
      if (remove.length) must(await run(['update-index', '-z', '--force-remove', '--stdin'], { input: remove.map(path => `${path}\0`).join('') }), 'update-index --force-remove', { code: 'snapshot_unreadable', timeout: 'snapshot_timeout' });
      if (update.length) must(await run(['update-index', '-z', '--add', '--remove', '--replace', '--stdin'], { input: update.map(path => `${path}\0`).join('') }), 'update-index', { code: 'snapshot_unreadable', timeout: 'snapshot_timeout' });
      const written = await run(['write-tree']);
      // The private index is no gc root of git's: after the user's `git gc --prune=now` (or an expiry), an entry may
      // name a blob that is gone and every later write-tree fails. The cache is thrown away and rebuilt once (files
      // are hashed again); only a second failure is an error.
      if (written.code !== 0 && !written.timedOut && !fresh) {
        fresh = true; rebuilt = true;
        await rm(index, { force: true }); await rm(`${index}.json`, { force: true });
        await rebuild();
        continue;
      }
      const tree = must(written, 'write-tree', { timeout: 'snapshot_timeout' }).stdout.trim();
      const commit = await commitTree(context, tree, head ? [head] : []);
      const temporary = `${index}.json.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ head, ignores, tree, at: new Date().toISOString() }));
      await rename(temporary, `${index}.json`);
      return { tree, commit, nested, oversized, secret };
    }
  });
  // An isolated root (S, W, B) reports only the secret files its owner changed (secretChanged): a copy Rna laid down
  // there (WorktreeService.layDependencies, `laid`: the worktree record's) that nobody touched is no news to a merge's
  // notMerged, whatever its source file became since.
  if (root.isolated && result.secret.length) {
    const copies = laidCopies(laid), changed = [];
    for (const path of result.secret) if (await secretChanged(root, path, copies.get(path))) changed.push(path);
    result.secret = changed;
  }
  if (pin) await updateRefs(context, [{ ref: pin, commit: result.commit }]);
  return result;
}

/**
 * The facts a laid-down copy was recorded with (WorktreeService.layDependencies: size, mtime and inode of the copy right
 * after it was made; never its bytes), by root-relative path. Entries without them (older records) are left out.
 * @param {{ path: string, kind: string, size?: number, mtimeMs?: number, ino?: number }[]|null} laid
 * @returns {Map<string, { size: number, mtimeMs: number, ino: number }>}
 */
export function laidCopies(laid) {
  const out = new Map();
  for (const item of Array.isArray(laid) ? laid : []) {
    if (item?.kind === 'copy' && typeof item.path === 'string' && [item.size, item.mtimeMs, item.ino].every(Number.isFinite)) out.set(item.path, item);
  }
  return out;
}

/**
 * Whether a secret path of an isolated root is its owner's change (B8, read only, compared in memory, never hashed):
 * not when the file is still the copy Rna laid down (`copy`: its recorded size, mtime and inode all unchanged), so a
 * copy nobody touched is no change even after the user edited the source file, and not when it holds the same bytes as
 * the project folder's file at the same path (nothing to tell: a rewrite that changed nothing, or the user copied it
 * over); missing on both sides is no change either. A folder entry (`dir/`) always counts.
 * @param {import('./contract.mjs').RootInfo} root
 * @param {string} path  root-relative
 * @param {{ size: number, mtimeMs: number, ino: number }} [copy]
 */
export async function secretChanged(root, path, copy = null) {
  if (path.endsWith('/')) return true;
  const here = join(root.root, ...path.split('/')), mine = await lstat(here).catch(() => null);
  if (copy && mine?.isFile() && mine.size === copy.size && mine.mtimeMs === copy.mtimeMs && mine.ino === copy.ino) return false;
  if (!root.project) return true;
  const there = join(root.project, ...path.split('/')), theirs = await lstat(there).catch(() => null);
  if (!mine && !theirs) return false;
  if (!mine?.isFile() || !theirs?.isFile() || mine.size !== theirs.size || mine.size > LIMITS.snapshotFileBytes) return true;
  const [a, b] = await Promise.all([readFile(here).catch(() => null), readFile(there).catch(() => null)]);
  return !a || !b || !a.equals(b);
}

/**
 * Delete a root's private index and its notes (a removed worktree's, review ISO-6). A cache: nothing depends on it.
 * @param {string} commonDir  realpath
 * @param {string} root       realpath
 */
export async function dropPrivateIndex(commonDir, root) {
  const index = privateIndexPath(commonDir, root);
  await exclusive(index, async () => { await rm(index, { force: true }); await rm(`${index}.json`, { force: true }); });
}

/** Names of private index files and their notes (`<16 hex>`, `<16 hex>.json`): nothing else in rna/index is touched. */
export const PRIVATE_INDEX_NAME = /^[0-9a-f]{16}(?:\.json)?$/;

/**
 * `commit-tree` with Rna's identity, unsigned, on no branch.
 * @param {EngineContext} context
 * @param {string} tree
 * @param {string[]} [parents]
 * @returns {Promise<string>}  commit id
 */
export async function commitTree(context, tree, parents = [], message = 'Rna snapshot') {
  const result = must(await objects(context, ['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', message]), 'commit-tree');
  return result.stdout.trim();
}

/**
 * Point hidden refs at commits in one `update-ref --stdin` transaction (caller holds the repository lock).
 * Refs must start with REFS.root.
 * @param {EngineContext} context
 * @param {{ ref: string, commit: string|null }[]} updates  null deletes the ref
 */
export async function pin(context, updates) { return updateRefs(context, updates); }
