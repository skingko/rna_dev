import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readdir, readlink, realpath, rename, rmdir, symlink, unlink } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { WRITE_MODES } from './contract.mjs';
import { engineError } from './env.mjs';
import { inRoot, must, readBlobs, toTree, BIG_OUTPUT } from './tree.mjs';

// Writing a merge result into a root (design §3.5). Owner: T1.
//
// Only working-tree files are written: never the user's index, HEAD, branches, stash or config (D3). After a write
// the files show in `git status` as unstaged changes and what was staged stays staged. The caller holds the
// repository lock (design §3.7).

/**
 * One planned change. `expect` is what the root must hold now (oid + mode, or null for "absent"); `next` is what
 * it will hold (null deletes).
 * @typedef {{ path: string, expect: { oid: string, mode: string }|null, next: { oid: string, mode: string }|null }} PlanEntry
 *
 * @typedef {object} WriteOutcome
 * @property {string[]} written
 * @property {string[]} removed
 * @property {string[]} raced       Paths whose CAS failed (all mode: everything written was put back first).
 * @property {{ path: string, kind: 'changed_during_merge'|'unexpected_file' }[]} conflicts  partial / markers mode.
 * @property {boolean} rolledBack   all mode: a CAS failed and the written paths went back to `expect`.
 * @property {string[]} [stuck]     all mode: paths that could not be put back (they changed again meanwhile).
 * @property {'verified'|'unverified'} verify
 * @property {string[]} mismatched  Paths the post-write `hash-object` check found different.
 */

const LINK = '120000', EXEC = '100755', SUBMODULE = '160000';
const race = path => Object.assign(new Error(`${path} changed while it was being written.`), { race: true });
/** A folder on the way to `path` stopped being the real folder inside the root it was checked to be (a link swapped in
 * by a process still running there): the write is refused like a race, and logged. */
const tampered = path => { console.warn(`write_path_tampered: a folder on the way to ${path} changed while it was being written`); return Object.assign(new Error(`A folder on the way to ${path} changed while it was being written.`), { race: true, tampered: true }); };
const within = (root, path) => { const part = relative(root, path); return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };
const signature = info => (info ? [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode].join(':') : null);
const identity = info => (info ? `${info.dev}:${info.ino}` : null);
const missing = error => ['ENOENT', 'ENOTDIR'].includes(error?.code);
const lstatOrNull = path => lstat(path).catch(error => (missing(error) ? null : Promise.reject(error)));

/**
 * Whether `folder` (a lexical path at or under `root`) still resolves to exactly itself under the root's real path:
 * every segment a real folder, none a link, nothing leading out. Node has no openat / O_NOFOLLOW traversal, so a host
 * write into a worktree (where a sandboxed process the agent left running can still rename folders) re-checks this
 * right before it renames, deletes or removes anything, and again after the rename (worktree design 0.63 §0.3-6).
 * @param {string} root  the root as the write addresses it
 * @param {string} rootReal  realpath(root) when the write began
 * @param {string} folder
 * @returns {Promise<boolean>}
 */
export async function sameFolder(root, rootReal, folder) {
  if (!within(root, folder)) return false;
  const real = await realpath(folder).catch(() => null), expected = join(rootReal, relative(root, folder));
  if (real === null) return false;
  if (real === expected) return true;
  // A volume that ignores case or Unicode normalization (APFS, HFS+) answers each name as it is stored, which can
  // differ from how the plan spells it: a folder renamed in case only (git keeps the old spelling), a name a Finder
  // made in decomposed form against git's precomposed one. Still the same folder when it is inside the root, as deep,
  // every name equal but for case and normalization, and no folder on the way a link (none ever leads elsewhere).
  if (!within(rootReal, real)) return false;
  const fold = name => name.normalize('NFC').toLowerCase();
  const want = relative(rootReal, expected).split(sep).filter(Boolean), have = relative(rootReal, real).split(sep).filter(Boolean);
  if (want.length !== have.length || want.some((name, index) => fold(name) !== fold(have[index]))) return false;
  let at = root;
  for (const name of relative(root, folder).split(sep).filter(Boolean)) {
    at = join(at, name);
    const info = await lstat(at).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) return false;
  }
  return true;
}

const MARKER_OPEN = Buffer.from('<<<<<<< refs/rna/m/'), MARKER_CLOSE = Buffer.from('>>>>>>> refs/rna/m/');
/**
 * Whether these bytes hold a conflict-marker line of any Rna merge (a line starting `<<<<<<< refs/rna/m/` or
 * `>>>>>>> refs/rna/m/`; the labels are Rna's own hidden refs, so a user's file does not carry them by chance).
 * Such content never goes into the project folder (invariant §0.3-3), whichever path tried to carry it there.
 */
export function holdsRnaMarkers(bytes) {
  if (!bytes?.length) return false;
  for (const marker of [MARKER_OPEN, MARKER_CLOSE]) {
    for (let at = bytes.indexOf(marker); at >= 0; at = bytes.indexOf(marker, at + 1)) if (at === 0 || bytes[at - 1] === 10) return true;
  }
  return false;
}

/** The object id git gives these bytes as a blob (sha1 or sha256 by the repository's object format). */
export function blobId(bytes, length = 40) {
  return createHash(length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * Path safety (design §3.5 step 1): no absolute path, no `..`, no `.git` segment (any case), nothing under `.rna/`;
 * every parent, resolved, a real folder inside the root (WorkspaceGitService.checkPaths' rules). Throws
 * `write_path_denied` (403). `replaced`: root paths the same plan deletes first — a link there is going away (the
 * write checks again, right before it, that a real folder took its place), so it does not deny what lands under it.
 * @param {string} root  realpath
 * @param {string} path  root-relative, '/'-separated
 * @param {{ replaced?: Set<string> }} [options]
 * @returns {Promise<string>}
 */
export async function checkWritePath(root, path, { replaced = null } = {}) {
  const denied = () => { throw engineError('write_path_denied', `Writing ${JSON.stringify(path)} is not allowed.`); };
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\0\\]/.test(path) || isAbsolute(path) || path.startsWith('/')) denied();
  const segments = path.split('/');
  if (segments.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) denied();
  if (segments[0].toLowerCase() === '.rna') denied();
  // Every folder on the way that exists must be a real folder (not a link) inside the root.
  let folder = root;
  for (const [index, part] of segments.slice(0, -1).entries()) {
    folder = join(folder, part);
    const info = await lstatOrNull(folder);
    if (!info) break;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      // A file where a folder is planned is a race the CAS reports, not a denial; a link never is followed (one the
      // plan removes first is no way through: ensureFolders refuses a link still there when the write comes).
      if (info.isSymbolicLink() && !replaced?.has(segments.slice(0, index + 1).join('/'))) denied();
      break;
    }
    if (!within(root, await realpath(folder))) denied();
  }
  return join(root, ...segments);
}

/**
 * What each root path holds now: Map path → { entry: { mode, oid }|null, facts } (`entry.mode` 'tree' for a plain
 * folder). Regular files are hashed by `hash-object` in the root's working tree, so the root's attributes apply as
 * they did when the snapshot was taken.
 */
export async function currentState(context, root, paths) {
  const state = new Map(), files = [];
  for (const path of paths) {
    const file = join(root.root, ...path.split('/')), info = await lstatOrNull(file);
    if (!info) { state.set(path, { entry: null, facts: null }); continue; }
    if (info.isSymbolicLink()) { const target = await readlink(file, { encoding: 'buffer' }); state.set(path, { entry: { mode: LINK, oid: blobId(target, context.oidLength) }, facts: signature(info) }); continue; }
    if (info.isDirectory()) { const repository = await lstatOrNull(join(file, '.git')); state.set(path, { entry: { mode: repository ? SUBMODULE : 'tree', oid: '' }, facts: signature(info) }); continue; }
    if (!info.isFile()) { state.set(path, { entry: { mode: 'other', oid: '' }, facts: signature(info) }); continue; }
    state.set(path, { entry: { mode: context.fileMode !== false && info.mode & 0o111 ? EXEC : '100644', oid: null }, facts: signature(info) });
    files.push(path);
  }
  for (let start = 0; start < files.length; start += 400) {
    const chunk = files.slice(start, start + 400);
    const result = must(await inRoot(context, root, ['hash-object', '--', ...chunk.map(path => toTree(context, path))], { top: true }), 'hash-object');
    const oids = result.stdout.trim().split('\n');
    chunk.forEach((path, index) => { state.get(path).entry.oid = oids[index] ?? ''; });
  }
  return state;
}

/** Whether a state matches an expected entry (the executable bit only counts where the repository tracks it). */
export function sameEntry(context, have, want) {
  if (!have || !want) return !have && !want;
  if (have.oid !== want.oid) return false;
  if (have.mode === want.mode) return true;
  return context.fileMode === false && ['100644', EXEC].includes(have.mode) && ['100644', EXEC].includes(want.mode);
}

/**
 * Whether a path holds what a plan meant: sameEntry, except that a path the plan removed may now be the folder of
 * other paths the plan wrote under it (a link or file replaced by a real folder).
 * @param {string[]} written  root paths written by the same plan
 */
export function holds(context, have, want, path, written = []) {
  if (!want && have?.mode === 'tree' && written.some(other => other.startsWith(`${path}/`))) return true;
  return sameEntry(context, have, want);
}

/** Attributes that make a checkout convert a file (any value other than unspecified / unset). */
const CONVERSION = ['text', 'eol', 'crlf', 'ident', 'working-tree-encoding'];
/** Root paths whose checkout converts the bytes: every file when core.autocrlf is true, else by attributes. */
async function converted(context, root, paths) {
  if (!paths.length) return new Set();
  if (context.autocrlf === 'true') return new Set(paths);
  const result = must(await inRoot(context, root, ['check-attr', '-z', '--stdin', ...CONVERSION], { top: true, input: paths.map(path => `${toTree(context, path)}\0`).join('') }), 'check-attr');
  const fields = result.stdout.split('\0'), found = new Set();
  for (let index = 0; index + 2 < fields.length; index += 3) if (!['unspecified', 'unset'].includes(fields[index + 2])) found.add(fields[index]);
  return new Set(paths.filter(path => found.has(toTree(context, path))));
}

/**
 * The bytes each entry is written with: files with conversion attributes through `cat-file --filters --path` in
 * the root's working tree (its text and eol attributes, as a checkout would), everything else raw from
 * `cat-file --batch`. Map `${oid}\0${path}` → Buffer.
 */
async function contents(context, root, entries) {
  const out = new Map();
  const filtered = await converted(context, root, entries.filter(entry => entry.next.mode !== LINK).map(entry => entry.path));
  const raw = entries.filter(entry => !filtered.has(entry.path));
  if (raw.length) { const blobs = await readBlobs(context, raw.map(entry => entry.next.oid)); for (const entry of raw) if (blobs.has(entry.next.oid)) out.set(`${entry.next.oid}\0${entry.path}`, blobs.get(entry.next.oid)); }
  for (const entry of entries.filter(row => filtered.has(row.path))) {
    const result = must(await inRoot(context, root, ['cat-file', '--filters', `--path=${toTree(context, entry.path)}`, entry.next.oid], { top: true, raw: true, maxBytes: BIG_OUTPUT, timeoutMs: 120000 }), 'cat-file --filters');
    out.set(`${entry.next.oid}\0${entry.path}`, result.stdout);
  }
  for (const entry of entries) if (!out.has(`${entry.next.oid}\0${entry.path}`)) throw engineError('engine_failed', `The content of ${entry.path} could not be read.`);
  return out;
}

/** Folders on the way to `file`, made where missing; a file or link in the way is a race. Answers the folders made. */
async function ensureFolders(root, file) {
  const parts = relative(root, dirname(file)).split(sep).filter(Boolean), made = [];
  let folder = root;
  for (const part of parts) {
    folder = join(folder, part);
    const info = await lstatOrNull(folder);
    if (!info) { await mkdir(folder).then(() => made.push(folder), error => { if (error.code !== 'EEXIST') throw error; }); continue; }
    if (info.isSymbolicLink() || !info.isDirectory()) throw race(relative(root, file));
  }
  return made;
}
/** Take back the folders a refused write made (deepest first; only while they are empty). */
async function unmake(made) { for (const folder of [...made].reverse()) await rmdir(folder).catch(() => {}); }

/** Remove folders left empty by a delete, up to (not including) the root; never through a folder that moved. */
async function pruneFolders(root, file, rootReal = root) {
  for (let folder = dirname(file); folder !== root && within(root, folder); folder = dirname(folder)) {
    if (!(await sameFolder(root, rootReal, folder))) return;
    try { await rmdir(folder); } catch { return; }
  }
}

/**
 * Where a write's temporary files are made: `<commonDir>/rna/tmp`, a folder of the repository's git directory that no
 * sandboxed process can write to (an isolated root's sandbox denies all of P), so a refused write can always take its
 * temporary file back. Null (temporary files next to their target instead) when it cannot be made.
 */
async function scratchOf(context) {
  const commonDir = context?.located?.commonDir;
  if (!commonDir) return null;
  const folder = join(commonDir, 'rna', 'tmp');
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    return (await realpath(folder)) === folder && (await lstat(folder)).isDirectory() ? folder : null;
  } catch { return null; }
}

/** Temporary files a crash left in `<commonDir>/rna/tmp` (older than `olderThanMs`) go; answers how many. */
export async function sweepScratch(context, { now = Date.now(), olderThanMs = 86400000 } = {}) {
  const commonDir = context?.located?.commonDir;
  if (!commonDir) return 0;
  const folder = join(commonDir, 'rna', 'tmp');
  if ((await realpath(folder).catch(() => null)) !== folder) return 0;
  let removed = 0;
  for (const name of await readdir(folder).catch(() => [])) {
    if (!name.startsWith('.rna-tmp-')) continue;
    const file = join(folder, name), info = await lstatOrNull(file).catch(() => null);
    if (!info || info.isDirectory() || info.mtimeMs > now - olderThanMs) continue;
    await unlink(file).then(() => { removed++; }, () => {});
  }
  return removed;
}

/**
 * Write one entry with the second CAS: the file must still have the facts recorded at the first CAS (or still be
 * absent) right before the rename. Answers the facts of what was written.
 *
 * The folder the entry lands in is checked right before the rename (and before a delete) to still be the real folder
 * inside the root it was (sameFolder), and the temporary file to still be the one written; a folder swapped for a link
 * since is refused as a race (`tampered`) and the temporary file is removed. A file that did not exist is placed with
 * link() rather than rename(), so it never replaces anything that appeared there meanwhile. After the rename the check
 * runs again: a file that landed elsewhere (a swap in the last instant) is taken back out and the write refused.
 * @param {{ root: string, rootReal: string, scratch: string|null, hooks?: object }} where
 */
async function writeOne(where, entry, file, bytes, facts) {
  const { root, rootReal = root, scratch = null, hooks } = where;
  await hooks?.beforeWrite?.(entry.path);
  const parent = dirname(file), holds = () => sameFolder(root, rootReal, parent);
  const before = await lstatOrNull(file);
  if (signature(before) !== facts) throw race(entry.path);
  if (!entry.next) {
    if (!before) return null;
    // A delete through a folder swapped for a link would remove a file somewhere else.
    if (!(await holds())) throw tampered(entry.path);
    await unlink(file);
    await pruneFolders(root, file, rootReal);
    return null;
  }
  const made = await ensureFolders(root, file);
  if (!(await holds())) { await unmake(made); throw tampered(entry.path); }
  const name = `.rna-tmp-${randomBytes(6).toString('hex')}`;
  let temporary = join(scratch ?? parent, name), id = null, placed = false;
  // `id` is the temporary file's identity from the moment it exists, so a failure part way still takes it back.
  const create = async at => {
    if (entry.next.mode === LINK) { await symlink(bytes.toString('utf8'), at); id = identity(await lstat(at)); return; }
    const exec = entry.next.mode === EXEC, existing = before?.isFile() ? before.mode & 0o777 : null;
    const mode = existing === null ? (exec ? 0o755 : 0o644) : exec ? existing | ((existing & 0o444) >> 2) : existing & 0o666;
    const handle = await open(at, 'wx', mode);
    try { id = identity(await handle.stat()); await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await chmod(at, mode);
  };
  // A file absent before is linked into place (never replaces what appeared meanwhile); a link, or a file replacing
  // another, is renamed. Across volumes (the git directory elsewhere) the temporary file moves next to its target.
  const put = async at => {
    if (facts || entry.next.mode === LINK) return rename(at, file);
    try { await link(at, file); }
    catch (error) {
      // A volume without hard links: rename, once the path is still free.
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'ENOSYS'].includes(error.code)) throw error;
      if (await lstatOrNull(file)) throw race(entry.path);
      return rename(at, file);
    }
    await unlink(at).catch(() => {});
  };
  try {
    await create(temporary);
    // Second CAS, as close to the rename as it can be.
    await hooks?.beforeRename?.(entry.path);
    if (signature(await lstatOrNull(file)) !== facts) throw race(entry.path);
    // Right before it: the folder is still the real one inside the root, and the temporary file is the one written.
    if (!(await holds()) || identity(await lstatOrNull(temporary)) !== id) throw tampered(entry.path);
    await hooks?.beforePlace?.(entry.path);
    try { await put(temporary); }
    catch (error) {
      if (error.code !== 'EXDEV' || !scratch) throw error;
      await unlink(temporary).catch(() => {});
      temporary = join(parent, name); id = null;
      await create(temporary);
      if (!(await holds()) || identity(await lstatOrNull(temporary)) !== id) throw tampered(entry.path);
      await put(temporary);
    }
    placed = true;
  } catch (error) {
    if (!placed && id !== null && identity(await lstatOrNull(temporary).catch(() => null)) === id) await unlink(temporary).catch(() => {});
    await unmake(made);
    throw error;
  }
  // After it: still the same folder. Otherwise the rename went through a link swapped in at the last instant: the file
  // is taken back out of wherever that link leads (when it is still the one written) and the write refused. (A file
  // replaced right after in the real folder is the post-write check's to report, as before.)
  const landed = await lstatOrNull(file);
  if (!(await holds())) {
    if (identity(landed) === id) await unlink(file).catch(() => {});
    throw tampered(entry.path);
  }
  return signature(landed);
}

/**
 * Write `plan` into `root` with two CAS checks per file (hash-object + type/mode before, lstat dev/ino/size/
 * mtime/ctime unchanged right before the rename), content from `cat-file --filters --path` for paths with text
 * conversion attributes and `cat-file --batch` otherwise, same-folder `.rna-tmp-<random>` + fsync + rename,
 * links made the same way, emptied parent folders removed after deletes, and a `hash-object --stdin-paths` check
 * afterwards. `markers` mode is refused (`markers_target_denied`) unless root.kind is `session` or `background`.
 * @param {import('./snapshot.mjs').EngineContext} context
 * @param {import('./contract.mjs').RootInfo} root
 * @param {PlanEntry[]} plan
 * @param {{ mode: 'all'|'partial'|'markers' }} options
 * @returns {Promise<WriteOutcome>}
 */
export async function write(context, root, plan, options = {}) {
  const progress = { wrote: false };
  try { return await writePlan(context, root, plan, options, progress); }
  catch (error) {
    // Whether any file may have changed: the caller drops a record nothing was written under, and settles one that
    // was (startup recovery's way) instead of leaving it `writing`.
    if (progress.wrote && error && typeof error === 'object') error.wrote = true;
    throw error;
  }
}

async function writePlan(context, root, plan, { mode } = {}, progress = {}) {
  if (!WRITE_MODES.includes(mode)) throw engineError('engine_failed', `Unknown write mode ${mode}.`);
  // Conflict markers never reach the project folder or a worker's copy (invariant §0.3-3).
  if (mode === 'markers' && !['session', 'background'].includes(root?.kind)) throw engineError('markers_target_denied', 'Conflict markers are written only into a session or background worktree.');
  const outcome = { written: [], removed: [], raced: [], conflicts: [], rolledBack: false, verify: 'verified', mismatched: [] };
  if (!plan.length) return outcome;
  const files = new Map(), replaced = new Set(plan.filter(entry => !entry.next).map(entry => entry.path));
  for (const entry of plan) files.set(entry.path, await checkWritePath(root.root, entry.path, { replaced }));
  // First CAS: what each path holds now against what the merge read.
  await context.hooks?.beforeCheck?.(plan.map(entry => entry.path));
  const state = await currentState(context, root, plan.map(entry => entry.path));
  const ready = [], emptied = path => plan.some(other => !other.next && other.path.startsWith(`${path}/`));
  for (const entry of plan) {
    const now = state.get(entry.path);
    if (sameEntry(context, now.entry, entry.expect)) { ready.push(entry); continue; }
    // A plain folder where a file or link is meant to land, emptied by this plan's own deletes first: it must be gone
    // by the time the write comes (second CAS against "absent"); anything left in it (an ignored file) keeps it there.
    if (!entry.expect && entry.next && now.entry?.mode === 'tree' && emptied(entry.path)) { now.facts = null; ready.push(entry); continue; }
    outcome.raced.push(entry.path);
    outcome.conflicts.push({ path: entry.path, kind: !entry.expect && state.get(entry.path).entry ? 'unexpected_file' : 'changed_during_merge' });
  }
  if (mode === 'all' && outcome.raced.length) { outcome.conflicts = []; outcome.rolledBack = true; return outcome; }
  // Content no write may carry: a gitlink (another repository's commit, never file content) anywhere, and into the
  // project folder a conflict-marker line of an Rna merge (invariant §0.3-3). Such an entry is a conflict and is not
  // written; in `all` mode nothing is written at all.
  const gitlinks = ready.filter(entry => entry.next?.mode === SUBMODULE);
  const bytes = await contents(context, root, ready.filter(entry => entry.next && entry.next.mode !== SUBMODULE));
  const marked = root.kind === 'project' ? ready.filter(entry => entry.next && entry.next.mode !== LINK && entry.next.mode !== SUBMODULE && holdsRnaMarkers(bytes.get(`${entry.next.oid}\0${entry.path}`))) : [];
  if (gitlinks.length || marked.length) {
    for (const entry of gitlinks) outcome.conflicts.push({ path: entry.path, kind: 'submodule' });
    for (const entry of marked) outcome.conflicts.push({ path: entry.path, kind: 'content' });
    if (mode === 'all') return outcome;
    const refused = new Set([...gitlinks, ...marked]);
    for (let index = ready.length - 1; index >= 0; index--) if (refused.has(ready[index])) ready.splice(index, 1);
  }
  await context.hooks?.afterCheck?.(ready.map(entry => entry.path));
  // Deletes first (deepest first, so a folder can give way to a file), then writes (shallowest first).
  const depth = path => path.split('/').length;
  const order = [...ready.filter(entry => !entry.next).sort((a, b) => depth(b.path) - depth(a.path)), ...ready.filter(entry => entry.next).sort((a, b) => depth(a.path) - depth(b.path))];
  const done = [];
  // The root as it resolves now: every folder a write goes through must still resolve to itself under it (sameFolder).
  const where = { root: root.root, rootReal: await realpath(root.root), scratch: order.some(entry => entry.next) ? await scratchOf(context) : null, hooks: context.hooks };
  progress.wrote = order.length > 0;
  for (const entry of order) {
    try {
      const facts = await writeOne(where, entry, files.get(entry.path), entry.next ? bytes.get(`${entry.next.oid}\0${entry.path}`) : null, state.get(entry.path).facts);
      done.push({ entry, facts });
      (entry.next ? outcome.written : outcome.removed).push(entry.path);
    } catch (error) {
      if (!error.race && !['EISDIR', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(error.code)) throw error;
      outcome.raced.push(entry.path);
      if (error.tampered) (outcome.tampered ??= []).push(entry.path);
      if (mode === 'all') { await putBack(context, root, done, files, outcome, where); return outcome; }
      outcome.conflicts.push({ path: entry.path, kind: 'changed_during_merge' });
    }
  }
  // Content bytes this write put on disk (ApplyRow.bytes, review ISO-8).
  outcome.bytes = done.reduce((sum, { entry }) => sum + (entry.next ? bytes.get(`${entry.next.oid}\0${entry.path}`)?.length ?? 0 : 0), 0);
  // Check what was written against what was meant.
  await context.hooks?.beforeVerify?.([...outcome.written, ...outcome.removed]);
  const touched = [...outcome.written, ...outcome.removed], after = await currentState(context, root, touched);
  for (const { entry } of done) if (!holds(context, after.get(entry.path).entry, entry.next, entry.path, outcome.written)) outcome.mismatched.push(entry.path);
  if (outcome.mismatched.length) outcome.verify = 'unverified';
  return outcome;
}

/** all mode after a race: every path written goes back to what it held, if it still holds what was written. */
async function putBack(context, root, done, files, outcome, where) {
  outcome.rolledBack = true;
  const back = done.map(({ entry, facts }) => ({ entry: { path: entry.path, expect: entry.next, next: entry.expect }, facts }));
  const bytes = await contents(context, root, back.filter(row => row.entry.next).map(row => row.entry));
  const stuck = [], quiet = { ...where, hooks: null };
  for (const { entry, facts } of back.reverse()) {
    try { await writeOne(quiet, entry, files.get(entry.path), entry.next ? bytes.get(`${entry.next.oid}\0${entry.path}`) : null, facts); }
    catch (error) { if (!error.race && !['EISDIR', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(error.code)) throw error; stuck.push(entry.path); }
  }
  outcome.written = outcome.written.filter(path => stuck.includes(path));
  outcome.removed = outcome.removed.filter(path => stuck.includes(path));
  if (stuck.length) outcome.stuck = stuck;
}
