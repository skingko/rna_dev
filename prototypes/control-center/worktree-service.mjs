import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants, realpathSync, statfsSync } from 'node:fs';
import { appendFile, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, symlink, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LIMITS, MERGE_LABELS, RECORD_ID, REFS, TRASH_DIR, WORKTREE_DIR, WORKTREE_STATES, isSecretPath, worktreeName } from './git-isolation/contract.mjs';
import { notMergedOf } from './git-isolation/index.mjs';
import { sameFolder } from './git-isolation/writer.mjs';
import { laidCopies, secretChanged } from './git-isolation/snapshot.mjs';
import { registeredWorkspacePath } from './workspace-directories.mjs';
import { parseStatus, parseWorktrees } from './workspace-git-service.mjs';
import { toolPermitted } from './project-permissions.mjs';
import { interfaceLanguageOf, inLanguage } from './interface-language.mjs';
import { worktreeRecord } from './workspace-roots.mjs';

// Rna worktrees: creation, dependencies, cleanup, reconciliation and the …/worktrees routes (worktree design 0.63
// §5.3, §6.2, §6.4, §7.4, §11). Owner: T2 (bodies, and worktree-routes.mjs); the interface is the lead's contract.
//
// Every worktree lives at `<P>/.rna/worktrees.nosync/<s|w|b>-<id8>[-n]` (worktreeName), is created detached at its
// seed snapshot and locked (`git worktree add --detach --lock --reason …`, engine environment, under the repository
// lock), and is recorded in `project.git.worktrees[]`. Rna never runs `git worktree prune`. Removal: tip ref →
// unlock → ignored files Rna did not lay down move to `.rna/trash.nosync/<wtId>-<time>/` → laid-down links and
// copies removed → `git worktree remove --force` → state `removed`.
//
// Git on a worktree always runs with GIT_DIR and GIT_WORK_TREE taken from its record (design §3.1), never discovered
// from its `.git` file, which an agent working there could have changed. The engine (IsolationEngine) takes the
// repository lock itself for snapshots and pins, so those are never called while this service holds the lock; and
// create / remove / repair / rebuild / reconcile take the lock themselves, so callers never call them inside
// IsolationEngine.lock (the FIFO is not reentrant).

/**
 * @typedef {import('./git-isolation/contract.mjs').RootInfo} RootInfo
 *
 * @typedef {object} WorktreeRecord  project.git.worktrees[] (design §11)
 * @property {string} id
 * @property {'session'|'worker'|'background'|'orphan'} kind
 * @property {string} name       worktreeName(kind, owner id)
 * @property {string} dir        '.rna/worktrees.nosync/<name>' relative to P
 * @property {string} prefix     the project folder inside the repository
 * @property {{ sessionId?: string, turnId?: string, agentId?: string, actionId?: string }} owner
 * @property {string} seed       commit (REFS.worktree(id, 'seed'))
 * @property {string} [base]     session worktrees: the last sync point (REFS.worktree(id, 'base'))
 * @property {'active'|'kept'|'conflicted'|'removed'|'missing'} state
 * @property {string} createdAt
 * @property {string} [removedAt]
 * @property {{ path: string, kind: 'copy'|'link' }[]} [laid]  dependencies Rna laid down (§6.4), relative to the root
 * @property {string} [gitName]  git's own name for it under `<commonDir>/worktrees/`, when that is not `name`
 *
 * @typedef {object} WorktreeView  one row of GET /api/v2/projects/:id/worktrees (protocol §8.6)
 * @property {string} id
 * @property {string} kind
 * @property {object} owner
 * @property {string} path       absolute realpath (the git panel's `worktree=`)
 * @property {string} state
 * @property {string} createdAt
 * @property {number} [sizeBytes] from an asynchronous `du`, absent until known
 * @property {{ files: number }} pending  files that differ from its base (worker/background: seed)
 */

const DAY_MS = 86400000, SIZE_TTL_MS = 10 * 60000, MAX_PENDING = 32, MAX_NAMES = 50;
/** Rows of these states are still on disk (or should be); `removed` rows are history. */
const ON_DISK = new Set(['active', 'kept', 'conflicted', 'missing']);
/** Apply and discard of the routes: only for work nobody is using any more (design §11). */
const SETTLED = new Set(['kept', 'conflicted']);
/** `.env` files at the top of P (design §6.4): copied when ignored. */
const ENV_FILE = /^\.env(?:\..+)?$/;
const VENV_DIRS = ['.venv', 'venv'];
/** At most this many files that hold secrets are laid down into one worktree (a cap on a folder full of keys). */
const MAX_SECRET_FILES = 200;
/** Paths of secret files the panel's answers carry, and how many of them its sentences name. */
const SECRET_LISTED = 50, SECRET_SHOWN = 10;
const within = (root, path) => { const part = relative(root, path); return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };
const iso = ms => new Date(ms).toISOString();
const stamp = ms => iso(ms).replace(/[-:]/g, '').replace(/\..+$/, '');
const exists = path => lstat(path).then(() => true, () => false);
/** A path as an exact .gitignore pattern: wildcards, a leading # or !, and trailing spaces escaped. */
export const gitignoreLiteral = path => String(path).replace(/[\\*?[\]]/g, '\\$&').replace(/^([#!])/, '\\$1').replace(/ +$/, spaces => spaces.replace(/ /g, '\\ '));
const ownerId = (kind, owner, id) => (kind === 'worker' ? owner?.agentId : kind === 'background' ? owner?.actionId : owner?.sessionId) ?? id;
/** The secret files a worktree's owner changed, from a snapshot of it (Snapshot.secret), at most SECRET_LISTED. */
const secretsOf = tip => [...new Set(tip?.secret ?? [])].slice(0, SECRET_LISTED);

/** Whether bytes hold a line starting with an Rna merge's conflict marker label (`<<<<<<< refs/rna/m/`, `>>>>>>> refs/rna/m/`). */
export function holdsRnaMarkers(bytes) {
  for (const marker of ['<<<<<<< refs/rna/m/', '>>>>>>> refs/rna/m/']) {
    for (let at = bytes.indexOf(marker); at >= 0; at = bytes.indexOf(marker, at + 1)) if (at === 0 || bytes[at - 1] === 0x0a) return true;
  }
  return false;
}

/**
 * Whether a root-relative path of a worktree is a secret file Rna laid down (B8) that is still a copy, not work of the
 * worktree's own: untouched since it was laid down, or holding the project folder's bytes (snapshot.mjs secretChanged).
 */
async function laidUnchanged(record, root, workspace, path) {
  if (!isSecretPath(path) || !(record.laid ?? []).some(item => item.path === path && item.kind === 'copy')) return false;
  const exists = await lstat(join(root, ...path.split('/'))).then(info => info.isFile(), () => false);
  return exists && !(await secretChanged({ root, project: workspace }, path, laidCopies(record.laid).get(path)));
}

export class WorktreeService {
  /**
   * @param {import('./store.mjs').Store} store
   * @param {{ git?: object, engine?: import('./git-isolation/index.mjs').IsolationEngine, roots?: import('./workspace-roots.mjs').RootResolver, now?: () => number, statfs?: typeof statfsSync }} [options]
   */
  constructor(store, { git = null, engine = null, roots = null, now = Date.now, statfs = statfsSync } = {}) {
    Object.assign(this, { store, git, engine, roots, now, statfs });
    /** confirm token → { action, projectId, worktreeId, tree, expiresAt } */
    this.pending = new Map();
    /** worktree id → { bytes, at } (asynchronous du) and the ones being measured */
    this.sizes = new Map(); this.measuring = new Set();
    /** `<root>\0<HEAD>` → tracked bytes (checkSpace) */
    this.tracked = new Map();
    /** project id → P realpath, for ownerOf (a sync question asked per worktree row of the git panel) */
    this.folders = new Map();
    /** project id → the release of a deleted project's worktrees (releaseProject), while it runs */
    this.releases = new Map();
    // A project deleted from Rna leaves its folder, and with it Rna's worktrees there: they are released at once.
    this.offProjectDeleted = typeof store?.onProjectDeleted === 'function' ? store.onProjectDeleted(project => this.releaseProject(project)) : null;
  }
  say(variants) { return inLanguage(interfaceLanguageOf(this.store.state), variants); }
  fail(code, status, variants, extra = {}) { return Object.assign(new Error(this.say(variants)), { status, code, ...extra }); }
  project(projectId) {
    const project = this.store.state.projects.find(row => row.id === projectId);
    if (!project) throw this.fail('project_not_found', 404, { zh: '项目不存在。', en: 'This project no longer exists.' });
    return project;
  }
  rows(projectId) { return this.store.state.projects.find(row => row.id === projectId)?.git?.worktrees ?? []; }
  /** @returns {WorktreeRecord|null} */
  record(projectId, worktreeId) { const row = worktreeRecord(this.store.state.projects.find(item => item.id === projectId), worktreeId); return row ? structuredClone(row) : null; }
  /** Change one record in state (and drop the resolver's answers for it). */
  update(projectId, worktreeId, change) {
    if (!this.rows(projectId).some(row => row.id === worktreeId)) return null;
    const { updated } = this.store.mutate(state => {
      const row = state.projects.find(item => item.id === projectId)?.git?.worktrees?.find(item => item.id === worktreeId);
      if (row) change(row);
      return { updated: row ? structuredClone(row) : null };
    });
    this.roots?.invalidate?.({ worktreeId });
    return updated;
  }
  async located(projectId) {
    if (!this.git) throw this.fail('worktree_unavailable', 409, { zh: 'Git 不可用。', en: 'Git isn’t available.' }, { reason: 'git_unavailable' });
    const located = await this.git.locateProject(projectId);
    if (located.repo === 'none') throw this.fail('worktree_unavailable', 409, { zh: '项目文件夹不是 Git 仓库，或现在读不了。', en: 'The project folder isn’t a Git repository, or can’t be read right now.' }, { reason: located.unavailable === 'workspace_missing' ? 'workspace_missing' : 'no_repository' });
    const [workspace, commonDir] = await Promise.all([realpath(located.workspace), realpath(located.commonDir)]);
    return { ...located, workspace, commonDir, prefix: located.prefix ?? '' };
  }
  /** Git under the repository's FIFO: the engine's lock when there is one, else the panel's serial queue. */
  lock(projectId, located, work) {
    if (this.engine) return this.engine.lock(projectId, work);
    return this.git.serial(located, work);
  }
  /** One git command; a failure is thrown as `code` with git's message kept for the log. */
  async gitIn(cwd, args, { env, input, engine = true, code = 'worktree_create_failed', allow = [0], timeoutMs = 60000, maxBytes = 64 * 1024 * 1024 } = {}) {
    const result = await this.git.run(cwd, args, { env, input, engine, timeoutMs, maxBytes, killSignal: 'SIGTERM' });
    if (!allow.includes(result.code)) throw Object.assign(this.fail(code, code === 'worktree_create_failed' ? 500 : 409, { zh: 'Git 没能完成工作树操作。', en: 'Git couldn’t complete the worktree operation.' }), { detail: `${args[0]} ${args[1] ?? ''}: ${result.stderr.trim().slice(-400)}`, timedOut: result.timedOut });
    return result;
  }
  paths(record, located) {
    const top = join(located.workspace, ...record.dir.split('/'));
    return { top, root: located.prefix ? join(top, ...located.prefix.split('/').filter(Boolean)) : top, gitDir: join(located.commonDir, 'worktrees', record.gitName ?? record.name) };
  }
  /** RootInfo of a record (git always gets GIT_DIR / GIT_WORK_TREE from it). */
  rootInfo(record, located) {
    const { top, root, gitDir } = this.paths(record, located);
    return { root, kind: record.kind === 'orphan' ? 'worker' : record.kind, isolated: true, project: located.workspace, prefix: located.prefix, worktreeId: record.id, gitDir, workTree: top };
  }
  projectRoot(located) { return { root: located.workspace, kind: 'project', isolated: false, project: located.workspace, prefix: located.prefix }; }
  envOf(record, located) { const { top, gitDir } = this.paths(record, located); return { GIT_DIR: gitDir, GIT_WORK_TREE: top }; }

  /**
   * Space check before agent_delegate returns (design §6.2 step 1): statfs of P must show at least
   * max(LIMITS.freeSpaceMinBytes, LIMITS.freeSpaceTrackedFactor × tracked size of the parent root), the tracked
   * size summed from `ls-tree -r -l HEAD` and cached per HEAD. Asynchronous (review ISO-10): the listing of a large
   * repository never blocks the daemon thread, so streams and live turns keep running while it is read.
   * @param {string} projectId
   * @param {RootInfo} parent
   * @returns {Promise<{ ok: boolean, freeBytes: number, needBytes: number }>}
   */
  async checkSpace(projectId, parent) {
    const project = this.project(projectId);
    let folder = parent?.project;
    if (!folder) try { folder = realpathSync(registeredWorkspacePath(project.workspace)); } catch { folder = null; }
    let freeBytes = 0;
    try { const disk = this.statfs(folder); freeBytes = disk.bavail * disk.bsize; } catch { /* unknown space is no space */ }
    const needBytes = Math.max(LIMITS.freeSpaceMinBytes, LIMITS.freeSpaceTrackedFactor * await this.trackedBytes(parent?.root ?? folder, parent?.isolated ? { GIT_DIR: parent.gitDir, GIT_WORK_TREE: parent.workTree } : {}));
    return { ok: freeBytes >= needBytes, freeBytes, needBytes };
  }
  /** Bytes of the files HEAD tracks under `cwd` (ls-tree lists the folder it runs in), cached per HEAD. */
  async trackedBytes(cwd, extra = {}) {
    if (!cwd || !this.git) return 0;
    const git = (args, maxBytes) => this.git.run(cwd, args, { env: extra, engine: true, timeoutMs: 15000, maxBytes }).then(result => (result.code === 0 && !result.truncated && !result.timedOut ? result.stdout : null), () => null);
    const head = (await git(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], 4096))?.trim();
    if (!head) return 0;
    const key = `${cwd}\0${head}`;
    if (this.tracked.has(key)) return this.tracked.get(key);
    const listed = await git(['ls-tree', '-r', '-l', '-z', 'HEAD'], 512 * 1024 * 1024);
    if (listed === null) return 0;
    let total = 0;
    for (const entry of listed.split('\0')) {
      const size = /^\d+ \w+ [0-9a-f]+ +(\d+)\t/.exec(entry)?.[1];
      if (size) total += Number(size);
    }
    if (this.tracked.size > 64) this.tracked.clear();
    this.tracked.set(key, total);
    return total;
  }

  /**
   * Create a worktree (design §6.2 steps 2–6, §7.2): seed = snapshot(parent) pinned at REFS.worktree(id, 'seed')
   * (a session's seed is also its base), `worktree add --detach --lock`, `/<prefix>.rna/` in info/exclude unless
   * already ignored, dependencies laid down (§6.4: `.env*` cloned with `cp -c`, `.venv`/`venv` holding pyvenv.cfg
   * linked, init-time large files cloned), record appended. Isolation off → `worktree_unavailable` (with `reason`);
   * any failure → `worktree_create_failed` (a worker's caller reports `delegation_worktree_failed`), with nothing
   * left registered.
   * @param {string} projectId
   * @param {{ kind: 'session'|'worker'|'background', id?: string, owner: WorktreeRecord['owner'], parent: RootInfo, label: string, signal?: AbortSignal }} input
   *   `id`: the record id to use (a session's worktree id is assigned when the session is created); `label`: the lock reason.
   * @returns {Promise<WorktreeRecord>}
   */
  async create(projectId, { kind, id = randomUUID(), owner = {}, parent, label, signal } = {}) {
    this.project(projectId);
    if (!['session', 'worker', 'background'].includes(kind)) throw new TypeError(`Unknown worktree kind ${kind}.`);
    if (typeof id !== 'string' || !RECORD_ID.test(id)) throw new TypeError('A worktree id is letters, digits, - and _.');
    if (!parent?.root) throw new TypeError('A worktree is made from a parent root.');
    const live = worktreeRecord(this.project(projectId), id);
    if (live && live.state !== 'removed') throw this.fail('worktree_create_failed', 500, { zh: '这个工作树已经存在。', en: 'This worktree already exists.' }, { worktreeId: id });
    if (!this.engine) throw this.fail('worktree_unavailable', 409, { zh: '这个项目现在不能使用独立工作树。', en: 'This project can’t use separate worktrees right now.' }, { reason: 'not_ready' });
    const isolation = await this.engine.isolation(projectId);
    if (!isolation.enabled) throw this.fail('worktree_unavailable', 409, { zh: '这个项目现在不能使用独立工作树。', en: 'This project can’t use separate worktrees right now.' }, { reason: isolation.reason });
    const located = await this.located(projectId), refs = [REFS.worktree(id, 'seed'), ...(kind === 'session' ? [REFS.worktree(id, 'base')] : [])];
    let added = null, pinned = false;
    try {
      signal?.throwIfAborted();
      await this.excludeRna(projectId, located);
      // The parent's current files, uncommitted and untracked ones included, pinned before anything else happens.
      const seed = await this.engine.snapshot(projectId, parent, { pin: refs[0], signal });
      pinned = true;
      if (kind === 'session') await this.engine.pin(projectId, [{ ref: refs[1], commit: seed.commit }]);
      signal?.throwIfAborted();
      const reason = String(label ?? `Rna ${kind} ${ownerId(kind, owner, id)}`).replace(/[\r\n\0]+/g, ' ').slice(0, 200);
      // Under the repository lock only git's own entry is made (`--no-checkout`); the files are checked out after it,
      // into the new folder alone (review ISO-10): a large checkout no longer holds every turn checkpoint, apply and
      // rollback of the repository in the queue behind it.
      added = await this.lock(projectId, located, async () => {
        const record = await this.freeName(kind, ownerId(kind, owner, id), located);
        const { top, gitDir } = this.paths(record, located);
        await mkdir(dirname(top), { recursive: true });
        await this.gitIn(located.workspace, ['worktree', 'add', '--no-checkout', '--detach', '--lock', '--reason', reason, top, seed.commit]);
        const filed = await this.adminDirOf(located, top);
        return { ...record, top, ...(filed && filed !== gitDir ? { gitName: basename(filed) } : {}) };
      });
      signal?.throwIfAborted();
      await this.checkout(added, located, seed.commit);
      signal?.throwIfAborted();
      const record = { id, kind, name: added.name, dir: added.dir, prefix: located.prefix, owner: { ...owner }, seed: seed.commit, ...(kind === 'session' ? { base: seed.commit } : {}), state: 'active', createdAt: iso(this.now()), ...(added.gitName ? { gitName: added.gitName } : {}) };
      record.laid = await this.layDependencies(projectId, record, located, { parent });
      const saved = this.store.mutate(state => {
        const project = state.projects.find(row => row.id === projectId);
        if (!project) throw this.fail('project_not_found', 404, { zh: '项目不存在。', en: 'This project no longer exists.' });
        project.git ??= { sessionWorktreeDefault: false, worktrees: [], applies: [] };
        project.git.worktrees ??= [];
        project.git.worktrees = project.git.worktrees.filter(row => row.id !== id);
        project.git.worktrees.push(record);
        return structuredClone(record);
      });
      this.roots?.invalidate?.({ projectId });
      return saved;
    } catch (error) {
      // Nothing stays registered: the folder and git's own entry go, and the refs pinned for it are dropped.
      if (added) await this.lock(projectId, located, async () => {
        await this.gitIn(located.workspace, ['worktree', 'unlock', added.top], { allow: [0, 128] }).catch(() => {});
        await this.gitIn(located.workspace, ['worktree', 'remove', '--force', added.top], { allow: [0, 128] }).catch(() => {});
      }).catch(() => {});
      if (pinned) await this.engine.pin(projectId, refs.map(ref => ({ ref, commit: null }))).catch(() => {});
      if (signal?.aborted && error === signal.reason) throw error;
      if (error.code === 'worktree_unavailable' || error.code === 'project_not_found') throw error;
      throw Object.assign(this.fail('worktree_create_failed', 500, { zh: '没能创建工作树。', en: 'The worktree couldn’t be created.' }), { cause: error, detail: error.detail ?? error.code ?? error.message });
    }
  }
  /**
   * Fill a worktree git added with `--no-checkout`: `read-tree -u --reset <seed>` under the record's GIT_DIR and
   * GIT_WORK_TREE, outside the repository lock — it writes only the new folder and its own index (the same checkout
   * `worktree add` would have made: attributes, line endings, modes).
   */
  async checkout(added, located, commit) {
    const { gitDir } = this.paths(added, located);
    await this.gitIn(added.top, ['read-tree', '-u', '--reset', commit], { env: { GIT_DIR: gitDir, GIT_WORK_TREE: added.top } });
  }
  /** A folder name nobody uses: no folder there, and no git entry of that name (so git files it under the same name). */
  async freeName(kind, id, located) {
    const taken = new Set(this.rows(located.project.id).filter(row => row.state !== 'removed').map(row => row.name));
    for (let n = 1; n <= MAX_NAMES; n++) {
      const name = worktreeName(kind, id, n), dir = `${WORKTREE_DIR}/${name}`;
      if (taken.has(name) || await exists(join(located.workspace, ...dir.split('/'))) || await exists(join(located.commonDir, 'worktrees', name))) continue;
      return { name, dir };
    }
    throw this.fail('worktree_create_failed', 500, { zh: '工作树文件夹的名字都被占用了。', en: 'Every worktree folder name is taken.' });
  }
  /** Git's entry for a worktree path: the `<commonDir>/worktrees/<x>` whose `gitdir` file points at `<top>/.git`. */
  async adminDirOf(located, top) {
    const folder = join(located.commonDir, 'worktrees'), wanted = join(top, '.git');
    for (const name of await readdir(folder).catch(() => [])) {
      const pointed = (await readFile(join(folder, name, 'gitdir'), 'utf8').catch(() => '')).trim();
      if (pointed && (pointed === wanted || await realpath(dirname(pointed)).then(path => join(path, '.git') === wanted, () => false))) return join(folder, name);
    }
    return null;
  }
  /** `/<prefix>.rna/` in `$GIT_COMMON_DIR/info/exclude` unless `.rna` is ignored already (design §6.2 step 4). */
  async excludeRna(projectId, located) {
    await mkdir(join(located.workspace, '.rna'), { recursive: true });
    // check-ignore refuses literal pathspecs (run() sets them for every other command).
    const ignored = () => this.git.run(located.workspace, ['check-ignore', '-q', '.rna'], { env: { GIT_LITERAL_PATHSPECS: '0' } }).then(result => result.code === 0);
    if (await ignored()) return;
    await this.lock(projectId, located, async () => {
      if (await ignored()) return;
      const file = join(located.commonDir, 'info', 'exclude'), before = await readFile(file, 'utf8').catch(() => '');
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, `${before && !before.endsWith('\n') ? '\n' : ''}# Rna Agent worktrees and trash (never committed)\n/${located.prefix}.rna/\n`);
    });
  }
  /**
   * Dependencies and ignored files a worktree needs (design §6.4, fixed tables, looked up by code): ignored `.env*`
   * files at the top of P cloned (`cp -c`: an APFS clone, its own copy), `.venv` / `venv` folders holding pyvenv.cfg
   * linked (writes through the link land in P and the sandbox refuses them), files git init left out for their size
   * cloned. node_modules is left alone: resolution walks up from the worktree to P's. Files that hold secrets
   * (SECRET_FILES) never ride the seed snapshot (B8), so the parent root's own — untracked, or changed since its HEAD —
   * are cloned from its folder as they are now (`parent`: the root the worktree was made from; P when absent); each
   * such copy's entry also records the copy's `size`, `mtimeMs` and `ino` as made (never its bytes).
   * @returns {Promise<{ path: string, kind: 'copy'|'link', size?: number, mtimeMs?: number, ino?: number }[]>}  relative to the root
   */
  async layDependencies(projectId, record, located, { parent = null } = {}) {
    const { root } = this.paths(record, located), P = located.workspace, laid = [], secrets = new Set();
    // Only what P itself ignores is laid down (never a file the repository tracks or would track).
    const ignoredIn = async (cwd, names, env = {}) => {
      if (!names.length) return new Set();
      const result = await this.git.run(cwd, ['check-ignore', '-z', '--stdin'], { input: `${names.join('\0')}\0`, env: { GIT_LITERAL_PATHSPECS: '0', ...env } });
      return new Set(result.stdout.split('\0').filter(Boolean));
    };
    const rootReal = await realpath(root).catch(() => root);
    const clone = async (from, path) => {
      const target = join(root, ...path.split('/'));
      if (await exists(target)) return;
      const info = await lstat(from).catch(() => null);
      if (!info?.isFile()) return;
      await mkdir(dirname(target), { recursive: true });
      // Only into a real folder of the worktree (a rebuilt worktree may meet a process still running from before).
      if (!(await sameFolder(root, rootReal, dirname(target)))) return;
      // An APFS clone where the volume has them (macOS `cp -c`), an ordinary copy elsewhere.
      await copyFile(from, target, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
      laid.push({ path, kind: 'copy' });
    };
    const top = await readdir(P, { withFileTypes: true }).catch(() => []);
    const envs = top.filter(entry => entry.isFile() && ENV_FILE.test(entry.name)).map(entry => entry.name);
    for (const name of await ignoredIn(P, envs)) if (envs.includes(name)) await clone(join(P, name), name);
    // The parent's secret files the seed left out, as the listing of a snapshot sees them (not ignored: untracked, or
    // changed since HEAD). One the checkout holds at HEAD's version is replaced by the parent's current file.
    const from = parent?.root ?? P, fromEnv = parent?.isolated ? { GIT_DIR: parent.gitDir, GIT_WORK_TREE: parent.workTree } : {};
    const listed = await this.git.run(from, ['ls-files', '-z', '-m', '-o', '--exclude-standard', '--', '.'], { env: fromEnv, engine: true, maxBytes: 64 * 1024 * 1024 }).catch(() => null);
    const secretPaths = listed?.code === 0 ? [...new Set(listed.stdout.split('\0').filter(Boolean))].filter(path => !path.endsWith('/') && path.split('/')[0].toLowerCase() !== '.rna' && isSecretPath(path)).slice(0, MAX_SECRET_FILES) : [];
    for (const path of secretPaths) {
      const source = join(from, ...path.split('/')), info = await lstat(source).catch(() => null);
      if (!info?.isFile() || info.size > LIMITS.snapshotFileBytes) continue;
      const target = join(root, ...path.split('/'));
      if (await exists(target)) {
        if (!(await sameFolder(root, rootReal, dirname(target))) || !(await lstat(target).then(row => row.isFile(), () => false))) continue;
        await unlink(target);
      }
      const before = laid.length;
      await clone(source, path);
      if (laid.length === before) continue;
      secrets.add(path);
      // The copy's own facts as made (never its bytes): a snapshot tells an untouched copy from its owner's change by
      // them (snapshot.mjs secretChanged), whatever the parent's file becomes meanwhile.
      const made = await lstat(target).catch(() => null);
      if (made?.isFile()) Object.assign(laid.at(-1), { size: made.size, mtimeMs: made.mtimeMs, ino: made.ino });
    }
    const venvs = [];
    for (const name of VENV_DIRS) {
      const folder = join(P, name);
      if (await lstat(folder).then(info => info.isDirectory(), () => false) && await exists(join(folder, 'pyvenv.cfg')) && !(await exists(join(root, name)))) venvs.push(name);
    }
    for (const name of await ignoredIn(P, venvs)) {
      if (!venvs.includes(name)) continue;
      await symlink(join(P, name), join(root, name));
      laid.push({ path: name, kind: 'link' });
    }
    const project = this.store.state.projects.find(row => row.id === projectId), large = [];
    for (const path of project?.git?.init?.largeFiles ?? []) {
      const relativePath = String(path).replace(/^\/+/, '');
      if (!relativePath || relativePath.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || part.toLowerCase() === '.rna')) continue;
      const from = join(P, ...relativePath.split('/'));
      if (within(P, from)) large.push(relativePath);
    }
    for (const path of await ignoredIn(P, large)) {
      if (!large.includes(path)) continue;
      const real = await realpath(join(P, ...path.split('/'))).catch(() => null);
      if (real && within(P, real)) await clone(real, path);
    }
    // In the worktree they must be ignored too, or a snapshot would carry them into P. A link is not a folder, so
    // `.venv/` in .gitignore does not cover the link: such paths get an exact `/<prefix><path>` line in info/exclude
    // (P ignores them already, so P is unchanged).
    // A secret file P does not ignore gets no line: the line would hide P's own file from `git status` too, and
    // snapshots of the worktree leave it out anyway.
    const excludable = laid.filter(item => !secrets.has(item.path));
    if (excludable.length) {
      const env = this.envOf(record, located), covered = await ignoredIn(root, excludable.map(item => item.path), env);
      const missing = excludable.map(item => item.path).filter(path => !covered.has(path));
      if (missing.length) await this.lock(projectId, located, async () => {
        const file = join(located.commonDir, 'info', 'exclude'), before = await readFile(file, 'utf8').catch(() => '');
        const lines = missing.map(path => `/${gitignoreLiteral(`${located.prefix}${path}`)}`).filter(line => !before.split('\n').includes(line));
        if (lines.length) await appendFile(file, `${before && !before.endsWith('\n') ? '\n' : ''}# Rna Agent: files laid down in worktrees (ignored in the project folder too)\n${lines.join('\n')}\n`);
      });
    }
    return laid;
  }

  /**
   * Remove a worktree (design §5.3 order). `state` of the record afterwards: 'removed'.
   * @returns {Promise<WorktreeRecord>}
   */
  async remove(projectId, worktreeId) {
    const record = this.record(projectId, worktreeId);
    if (!record) throw this.fail('worktree_not_found', 404, { zh: '没有这个工作树。', en: 'There is no such worktree.' }, { worktreeId });
    if (record.state === 'removed') return record;
    const located = await this.located(projectId), { top, root, gitDir } = this.paths(record, located), env = this.envOf(record, located);
    const there = await lstat(top).then(info => info.isDirectory(), () => false);
    let saved = [], secrets = [];
    // Its root as snapshots named it (lexical and resolved): its private index goes with it (review ISO-6).
    const roots = [...new Set([root, await realpath(root).catch(() => root)])];
    if (there) {
      // 1. The last state of its files, pinned: nothing is removed without a checkpoint.
      const tip = await this.engine.snapshot(projectId, this.rootInfo(record, located), { pin: REFS.worktree(record.id, 'tip') });
      saved = [...(tip.nested ?? []), ...(tip.oversized ?? [])];
      // Secret files its owner changed are in no snapshot (B8): they go to the trash too, laid-down copies included.
      secrets = tip.secret ?? [];
    }
    await this.lock(projectId, located, async () => {
      // 2. Unlocked, so git will remove it.
      await this.gitIn(located.workspace, ['worktree', 'unlock', top], { allow: [0, 128], code: 'worktree_remove_failed' });
      if (there) {
        // 3. Files the snapshot does not hold (ignored ones Rna did not lay down, other repositories, oversized files)
        //    move to the trash instead of being deleted with the folder.
        const laid = new Set((record.laid ?? []).map(item => `${located.prefix}${item.path}`));
        const ignored = await this.gitIn(top, ['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory'], { env, code: 'worktree_remove_failed' });
        const keep = [...[...ignored.stdout.split('\0').filter(Boolean).map(path => path.replace(/\/$/, '')), ...saved.map(path => `${located.prefix}${path}`.replace(/\/$/, ''))]
          .filter(path => !laid.has(path)), ...secrets.map(path => `${located.prefix}${path}`.replace(/\/$/, ''))].filter(path => path.split('/')[0] !== '.git');
        // A process the agent left running there may still rename folders: every move and delete below first checks
        // that the folder it goes through is still the real one inside the worktree (sameFolder), never a link swapped
        // in that would carry a file of the project folder off to the trash.
        const topReal = await realpath(top);
        if (keep.length) {
          const trash = join(located.workspace, ...TRASH_DIR.split('/'), `${record.id}-${stamp(this.now())}`);
          for (const path of [...new Set(keep)]) {
            const from = join(top, ...path.split('/')), to = join(trash, ...path.split('/'));
            if (!within(top, from) || !(await exists(from)) || !(await sameFolder(top, topReal, dirname(from)))) continue;
            await mkdir(dirname(to), { recursive: true });
            await rename(from, to);
          }
        }
        // 4. The links and copies Rna laid down.
        for (const item of record.laid ?? []) {
          const path = join(root, ...item.path.split('/'));
          if (within(root, path) && await sameFolder(top, topReal, dirname(path))) await unlink(path).catch(() => {});
        }
        // 5. The worktree itself (never `worktree prune`: that would drop the user's own absent worktrees too).
        await this.gitIn(located.workspace, ['worktree', 'remove', '--force', top], { code: 'worktree_remove_failed' });
      } else {
        // The folder is gone already: only git's own entry for it is left, and only that entry goes.
        const filed = await this.adminDirOf(located, top);
        if (filed && filed === gitDir && within(join(located.commonDir, 'worktrees'), filed)) await rm(filed, { recursive: true, force: true });
      }
    });
    this.sizes.delete(record.id);
    // Its snapshot cache (a cache: deletable at any time), and a removed conversation worktree's pre-merge pin, which
    // only its own conflict card read.
    for (const path of roots) await this.engine.forgetRoot?.(projectId, { root: path }).catch(() => {});
    if (record.kind === 'session') await this.engine.pin(projectId, [{ ref: REFS.worktree(record.id, 'premerge'), commit: null }]).catch(() => {});
    const removed = this.update(projectId, record.id, row => { row.state = 'removed'; row.removedAt = iso(this.now()); });
    // A conversation whose own worktree is gone this way (the panel applied or discarded it while the conversation was
    // archived) starts again from the project folder on its next turn, as after archiving (design §5.3); it would
    // otherwise name a removed worktree and fail every turn.
    if (record.kind === 'session') {
      this.store.mutate(state => { for (const session of state.sessions) if (session.worktree?.id === record.id && session.worktree.state !== 'pending') session.worktree = { ...session.worktree, state: 'pending' }; });
      this.roots?.invalidate?.({ worktreeId: record.id });
    }
    return removed;
  }

  /**
   * A project deleted from Rna (store.deleteProject; its folder and files stay): its records are gone, so its worktrees
   * are handed back to the user's git now. One with nothing unapplied (`git status` against its base / seed is clean)
   * and no ignored files of its own is removed (its laid-down links and copies first); any other — or one whose
   * folder is gone — is only unlocked: its work stays on disk, the user's own `git worktree remove` / `prune` can now
   * act on it, and if the folder is added to Rna again reconciliation lists it as an orphan to apply or discard. Its
   * hidden refs stay. Never throws; answers what it did (`releases` holds the promise while it runs).
   * @param {{ id: string, workspace: string, git?: { worktrees?: WorktreeRecord[] } | null }} project  the row as it was
   * @returns {Promise<{ removed: string[], unlocked: string[], failed: string[] }>}
   */
  releaseProject(project) {
    const rows = (project?.git?.worktrees ?? []).filter(row => row && row.state !== 'removed' && typeof row.dir === 'string' && typeof row.name === 'string');
    if (!rows.length || !this.git) return Promise.resolve({ removed: [], unlocked: [], failed: [] });
    const work = this.releaseRows(project, rows).catch(error => { console.warn(`worktrees of deleted project ${project.id}: ${error.message}`); return { removed: [], unlocked: [], failed: rows.map(row => row.id) }; });
    this.releases.set(project.id, work);
    void work.finally(() => { if (this.releases.get(project.id) === work) this.releases.delete(project.id); });
    return work;
  }
  async releaseRows(project, rows) {
    const done = { removed: [], unlocked: [], failed: [] };
    let workspace;
    try { workspace = await realpath(registeredWorkspacePath(project.workspace)); } catch { return done; }
    const found = await this.git.run(workspace, ['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--git-common-dir', '--show-prefix']);
    if (found.code !== 0) return done;
    const [inside, , common, prefix = ''] = found.stdout.split('\n');
    if (inside !== 'true') return done;
    // The same FIFO key the project had (WorkspaceGitService.locateProject's commonDir), so no other write of the
    // repository runs in between.
    const queue = { commonDir: resolve(workspace, common) }, commonDir = await realpath(queue.commonDir).catch(() => null);
    if (!commonDir) return done;
    const located = { workspace, commonDir, prefix, project: { id: project.id } };
    const base = join(workspace, ...WORKTREE_DIR.split('/'));
    await this.git.serial(queue, async () => {
      for (const record of rows) {
        const { top, root, gitDir } = this.paths(record, located), env = { GIT_DIR: gitDir, GIT_WORK_TREE: top };
        const git = (args, options = {}) => this.git.run(workspace, args, { engine: true, timeoutMs: 60000, killSignal: 'SIGTERM', ...options });
        try {
          // Only folders under Rna's own worktree folder, as the record says (never a path state alone could point elsewhere).
          if (dirname(top) !== base || record.dir !== `${WORKTREE_DIR}/${record.name}`) { done.failed.push(record.id); continue; }
          const topReal = await realpath(top).catch(() => null), there = topReal === top && await lstat(top).then(info => info.isDirectory(), () => false);
          let clean = false;
          if (there) {
            const status = await this.git.run(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', '.'], { env, engine: true, timeoutMs: 60000 });
            const laid = new Set((record.laid ?? []).map(item => `${located.prefix}${item.path}`));
            const ignored = await this.git.run(top, ['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory'], { env, engine: true, timeoutMs: 60000 });
            const own = ignored.code === 0 ? ignored.stdout.split('\0').filter(Boolean).map(path => path.replace(/\/$/, '')).filter(path => !laid.has(path) && path.split('/')[0] !== '.git') : null;
            // A secret file Rna laid down from P that still matches P's file is no work of the worktree's own (B8).
            const parsed = status.code === 0 ? parseStatus(status.stdout, located.prefix) : null;
            const changes = parsed ? [...parsed.conflicted, ...parsed.staged, ...parsed.unstaged, ...parsed.untracked].map(row => row.path) : null;
            const dirty = changes === null ? null : (await Promise.all(changes.map(async path => (await laidUnchanged(record, root, workspace, path) ? null : path)))).filter(Boolean);
            clean = dirty !== null && !dirty.length && own !== null && !own.length;
          }
          await git(['worktree', 'unlock', top]);
          if (!clean) { done.unlocked.push(record.id); continue; }
          for (const item of record.laid ?? []) {
            const path = join(root, ...item.path.split('/'));
            if (within(root, path) && await sameFolder(top, topReal, dirname(path))) await unlink(path).catch(() => {});
          }
          const removed = await git(['worktree', 'remove', '--force', top]);
          (removed.code === 0 ? done.removed : done.unlocked).push(record.id);
        } catch (error) { console.warn(`worktree ${record.id} of deleted project ${project.id}: ${error.message}`); done.failed.push(record.id); }
      }
    });
    return done;
  }

  /**
   * What a worktree holds that its base does not (B8: a conversation's deletion lists its workers' unmerged changes):
   * the files that differ between baseOf(record) and a fresh tip snapshot, pinned as its tip like the panel's discard
   * preview, and the secret files its owner changed (in no snapshot, never merged: they go to the trash with the
   * copy; `secret` counts them). 0 for a removed or missing one. Never throws for a worktree that can't be read:
   * `{ files: 0, unreadable }`.
   * @returns {Promise<{ files: number, paths?: string[], secret?: number, missing?: true, unreadable?: true }>}  `paths` relative to the project folder
   */
  async unmerged(projectId, worktreeId) {
    const record = this.record(projectId, worktreeId);
    if (!record || record.state === 'removed' || !this.engine) return { files: 0 };
    try {
      const located = await this.located(projectId);
      if (!(await lstat(this.paths(record, located).top).then(info => info.isDirectory(), () => false))) return { files: 0, missing: true };
      const tip = await this.tip(projectId, record, located);
      const changed = await this.git.run(located.workspace, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', '--relative', this.baseOf(record), tip.commit], { engine: true, maxBytes: 64 * 1024 * 1024 });
      if (changed.code !== 0 || changed.truncated) return { files: 0, unreadable: true };
      const paths = changed.stdout.split('\0').filter(Boolean), secret = [...new Set(tip.secret ?? [])].filter(path => !paths.includes(path));
      return { files: paths.length + secret.length, paths: [...paths, ...secret], ...(secret.length ? { secret: secret.length } : {}) };
    } catch { return { files: 0, unreadable: true }; }
  }

  /** Set a record's state ('active'|'kept'|'conflicted'|'missing'); invalidates the resolver for it. */
  setState(projectId, worktreeId, state) {
    if (!WORKTREE_STATES.includes(state) || state === 'removed') throw new TypeError(`A worktree state is one of ${WORKTREE_STATES.filter(item => item !== 'removed').join(', ')} (removal goes through remove()).`);
    const updated = this.update(projectId, worktreeId, row => { row.state = state; });
    if (!updated) throw this.fail('worktree_not_found', 404, { zh: '没有这个工作树。', en: 'There is no such worktree.' }, { worktreeId });
    return updated;
  }

  /**
   * Who a worktree path belongs to: WorkspaceGitService.worktreeOwner is injected with this (T1 replaces the 0.62
   * placeholder), so GET …/git/worktrees marks Rna's.
   * @param {string} path  realpath
   * @returns {{ rna: boolean, owner: string|null, kind?: string, worktreeId?: string }}
   */
  ownerOf(path) {
    if (typeof path !== 'string' || !path) return { rna: false, owner: null };
    for (const project of this.store.state.projects) {
      const rows = (project.git?.worktrees ?? []).filter(row => row.state !== 'removed');
      if (!rows.length) continue;
      let folder = this.folders.get(project.id);
      if (!folder || folder.workspace !== project.workspace) {
        try { folder = { workspace: project.workspace, path: realpathSync(registeredWorkspacePath(project.workspace)) }; } catch { continue; }
        this.folders.set(project.id, folder);
      }
      const row = rows.find(item => join(folder.path, ...item.dir.split('/')) === path);
      if (row) return { rna: true, owner: row.owner?.sessionId ?? null, kind: row.kind, worktreeId: row.id };
    }
    return { rna: false, owner: null };
  }

  /** A row of GET …/worktrees. */
  async view(record, located) {
    const { top, root } = this.paths(record, located), there = ON_DISK.has(record.state) && await lstat(top).then(info => info.isDirectory(), () => false);
    let files = 0, secret = 0;
    if (there) {
      // HEAD of a worker or background worktree is its seed and a session's is its base: what status shows is pending.
      const status = await this.git.run(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', '.'], { env: this.envOf(record, located), engine: true }).catch(() => null);
      if (status?.code === 0) {
        const parsed = parseStatus(status.stdout, located.prefix), paths = new Set([...parsed.conflicted, ...parsed.staged, ...parsed.unstaged, ...parsed.untracked].map(row => row.path));
        // Files that hold secrets never merge (B8): they are not pending but counted apart (`secret`), only the ones the
        // worktree's owner changed (snapshot.mjs secretChanged: not a laid-down copy nobody touched, not P's bytes).
        files = [...paths].filter(path => !isSecretPath(path)).length;
        secret = (await this.ownSecrets(record, root, located.workspace, [...paths].filter(path => isSecretPath(path)))).length;
      }
      this.measure(record.id, top);
    }
    const size = this.sizes.get(record.id);
    // `root`: the folder the work happens in (the worktree plus the project's prefix in its repository); the web maps paths with it.
    return { id: record.id, kind: record.kind, owner: { ...record.owner }, path: there ? await realpath(top).catch(() => top) : top, root: there ? await realpath(root).catch(() => root) : root, state: record.state, createdAt: record.createdAt, ...(size ? { sizeBytes: size.bytes } : {}), pending: { files, ...(secret ? { secret } : {}) } };
  }
  /** The secret paths (root-relative) among `paths` that are the worktree owner's own change (snapshot.mjs secretChanged). */
  async ownSecrets(record, root, workspace, paths) {
    const copies = laidCopies(record.laid), out = [];
    for (const path of paths) if (await secretChanged({ root, project: workspace }, path, copies.get(path)).catch(() => true)) out.push(path);
    return out;
  }
  /**
   * The panel's sentence (interface language) about the secret files a worktree's owner changed (B8): they are in no
   * snapshot, so an apply never carries them into the project folder, and they move to the trash with the worktree.
   * `when`: 'apply' (the first step of an apply), 'applied' (the worktree was removed after it), 'kept' (it stays,
   * conflicted), 'discard' (the first step of a discard), 'discarded'.
   */
  secretNote(paths, when) {
    const shown = paths.slice(0, SECRET_SHOWN), more = paths.length - shown.length, days = LIMITS.trashDays;
    const zh = `${shown.join('、')}${more ? ` 等 ${paths.length} 个` : ''}`, en = `${shown.join(', ')}${more ? ` and ${more} more` : ''}`;
    return this.say({
      apply: { zh: `这些文件存放密钥，Rna 从不把它们应用到项目文件夹：${zh}。应用完、工作树删除时，它们移到项目文件夹的 .rna/trash.nosync，保留 ${days} 天；需要的话请先自己复制过去。`, en: `These files hold secrets, which Rna never applies to the project folder: ${en}. When the worktree is removed after applying, they move to the project folder’s .rna/trash.nosync for ${days} days; copy them over yourself first if you need them.` },
      applied: { zh: `存放密钥的文件没有应用，已随工作树移到项目文件夹的 .rna/trash.nosync，保留 ${days} 天：${zh}。`, en: `Files that hold secrets were not applied; they moved with the worktree to the project folder’s .rna/trash.nosync for ${days} days: ${en}.` },
      kept: { zh: `存放密钥的文件没有应用，仍在工作树里：${zh}。`, en: `Files that hold secrets were not applied; they are still in the worktree: ${en}.` },
      discard: { zh: `这些文件存放密钥，不在任何检查点里：丢弃时它们移到项目文件夹的 .rna/trash.nosync，保留 ${days} 天：${zh}。`, en: `These files hold secrets and are in no checkpoint: discarding moves them to the project folder’s .rna/trash.nosync for ${days} days: ${en}.` },
      discarded: { zh: `存放密钥的文件已移到项目文件夹的 .rna/trash.nosync，保留 ${days} 天：${zh}。`, en: `Files that hold secrets moved to the project folder’s .rna/trash.nosync for ${days} days: ${en}.` },
    }[when]);
  }
  /** `du -sk` in the background; the next list shows the size. */
  measure(id, path) {
    const known = this.sizes.get(id);
    if (this.measuring.has(id) || (known && this.now() - known.at < SIZE_TTL_MS)) return;
    this.measuring.add(id);
    execFile('/usr/bin/du', ['-sk', path], { timeout: 60000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      this.measuring.delete(id);
      const kib = Number(String(stdout ?? '').split('\t')[0]);
      if (!error && Number.isFinite(kib)) this.sizes.set(id, { bytes: kib * 1024, at: this.now() });
    });
  }

  /**
   * GET /api/v2/projects/:id/worktrees.
   * @returns {Promise<{ isolation: import('./git-isolation/contract.mjs').Isolation, worktrees: WorktreeView[] }>}
   */
  async list(projectId) {
    this.project(projectId);
    const isolation = this.engine ? await this.engine.isolation(projectId) : { enabled: false, reason: 'not_ready', git: null };
    const rows = this.rows(projectId).filter(row => row.state !== 'removed');
    if (!rows.length) return { isolation, worktrees: [] };
    let located;
    try { located = await this.located(projectId); }
    catch { located = null; }
    if (!located) return { isolation, worktrees: rows.map(row => ({ id: row.id, kind: row.kind, owner: { ...row.owner }, path: null, state: row.state, createdAt: row.createdAt, pending: { files: 0 } })) };
    return { isolation, worktrees: await Promise.all(rows.map(row => this.view(row, located))) };
  }

  /** A kept / conflicted / orphan worktree the routes may act on, with its folder there. */
  async settled(projectId, worktreeId) {
    const project = this.project(projectId), record = this.record(projectId, worktreeId);
    if (!record || record.state === 'removed') throw this.fail('worktree_not_found', 404, { zh: '没有这个工作树。', en: 'There is no such worktree.' }, { worktreeId });
    if (record.state === 'missing') throw this.fail('worktree_missing', 409, { zh: '这个工作树的文件夹已经不在了。', en: 'This worktree’s folder is gone.' }, { worktreeId });
    if (record.kind !== 'orphan' && !SETTLED.has(record.state)) throw this.fail('worktree_active', 409, { zh: '这个工作树还在使用中（对话、子任务或后台工作），现在不能应用或丢弃。', en: 'This worktree is still in use (by a conversation, a subtask or background work), so it can’t be applied or discarded now.' }, { worktreeId });
    // A worker's W whose delegation still waits for a merge (pending, conflict): its card and agent_merge settle it,
    // so the record keeps its apply records and its state; applied or discarded here, the card would go on offering
    // 合并 / 丢弃 for changes already in the project folder or gone (and a discard there would undo nothing). Once
    // the delegation is gone (its conversation deleted) the panel is the way to settle it.
    if (record.kind === 'worker' && ['pending', 'conflict'].includes(this.delegationOf(record)?.merge?.status)) throw this.fail('worktree_worker_pending', 409, { zh: '这个子代理的改动还在对话里它的卡片上等待处理，请在卡片上合并或丢弃。', en: 'This subagent’s changes are waiting on its card in the conversation; merge or discard them there.' }, { worktreeId });
    if (!toolPermitted(project, { permission: 'write' }, 'foreground')) throw this.fail('git_read_only', 403, { zh: '这个项目现在是只读的，不能应用或丢弃工作树。可以在项目权限里改成可写。', en: 'This project is read-only, so worktrees can’t be applied or discarded. You can allow writing in the project’s permissions.' });
    const located = await this.located(projectId);
    if (!(await lstat(this.paths(record, located).top).then(info => info.isDirectory(), () => false))) throw this.fail('worktree_missing', 409, { zh: '这个工作树的文件夹已经不在了。', en: 'This worktree’s folder is gone.' }, { worktreeId });
    return { record, located };
  }
  /** The delegation a worker's W belongs to (its owner), while its conversation still has it; else null. */
  delegationOf(record) {
    const owner = record?.owner ?? {}, session = this.store.state.sessions.find(row => row.id === owner.sessionId);
    if (!session || !owner.agentId) return null;
    for (const turn of session.turns ?? []) { if (owner.turnId && turn.id !== owner.turnId) continue; const row = (turn.delegations ?? []).find(item => item.id === owner.agentId); if (row) return row; }
    return null;
  }
  /** The merge base of a worktree's own changes: a session's last sync point, otherwise its seed. */
  // A background worktree keeps its own base too (background-worktree.mjs: after an apply, a reverse merge or a restore):
  // merging over the seed would bring back project-folder changes it took in that the user has undone since.
  baseOf(record) { return ['session', 'background'].includes(record.kind) ? record.base ?? record.seed : record.seed; }
  labelsOf(record) {
    const kind = record.kind === 'orphan' ? { s: 'session', w: 'worker', b: 'background' }[record.name[0]] ?? 'worker' : record.kind;
    if (kind === 'session') return { kind: 'turn', labels: MERGE_LABELS.sessionToProject() };
    if (kind === 'background') return { kind: 'background', labels: MERGE_LABELS.background(record.owner?.actionId ?? record.name.slice(2)) };
    return { kind: 'worker', labels: MERGE_LABELS.worker(record.owner?.agentId ?? record.name.slice(2)) };
  }
  token(action, projectId, worktreeId, tree) {
    for (const [key, row] of this.pending) if (row.expiresAt <= this.now()) this.pending.delete(key);
    if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value);
    const confirm = randomBytes(16).toString('hex'), expiresAt = this.now() + LIMITS.worktreeTokenMs;
    this.pending.set(confirm, { action, projectId, worktreeId, tree, expiresAt });
    return { confirm, expiresAt: iso(expiresAt) };
  }
  redeem(action, projectId, worktreeId, confirm) {
    const row = typeof confirm === 'string' ? this.pending.get(confirm) : null;
    if (row) this.pending.delete(confirm);
    if (!row || row.action !== action || row.projectId !== projectId || row.worktreeId !== worktreeId || row.expiresAt <= this.now()) throw this.fail('worktree_unconfirmed', 409, { zh: '这次确认已经失效，请重新操作一次。', en: 'This confirmation has expired. Try again.' }, { worktreeId });
    return row;
  }
  /** The worktree's files now, pinned as its tip; a second step whose worktree moved since the first is refused. */
  async tip(projectId, record, located, expected) {
    const tip = await this.engine.snapshot(projectId, this.rootInfo(record, located), { pin: REFS.worktree(record.id, 'tip') });
    if (expected !== undefined && tip.tree !== expected) throw this.fail('worktree_changed', 409, { zh: '确认之后这个工作树里的文件又变了，没有执行。请重新确认。', en: 'Files in this worktree changed after you confirmed, so nothing was done. Confirm again.' }, { worktreeId: record.id });
    return tip;
  }
  checkInput(input) {
    if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'confirm'))) throw this.fail('worktree_request_invalid', 400, { zh: '请求只能包含 confirm。', en: 'The request may only contain confirm.' });
    return input?.confirm;
  }

  /**
   * POST …/worktrees/:wtId/apply — for `kept`, `orphan` and `conflicted` worktrees, two steps: without `confirm`
   * `{ confirm, expiresAt, files: [{ path, action }], conflicts: [{ path, kind }] }`; with it the clean part is
   * applied to P (`all` with `cleanOnly`, IsolationEngine.apply) → `{ worktree: WorktreeView, applyId, conflicts }`.
   * Applied without conflicts and verified → the worktree is removed; conflicts left → it is kept as `conflicted`.
   * Secret files its owner changed (B8) are never applied: both steps name them (`secret`, at most SECRET_LISTED, and
   * `note`, interface language: they go to the trash with the worktree, or stay in it).
   * Errors: worktree_not_found, worktree_active (still in use by a turn, worker or run), worktree_unconfirmed,
   * worktree_changed, git_read_only, git_operation_in_progress (the user's merge, rebase, … in the project folder).
   */
  async applyWorktree(projectId, worktreeId, input) {
    const confirm = this.checkInput(input);
    const { record, located } = await this.settled(projectId, worktreeId), { kind, labels } = this.labelsOf(record), base = this.baseOf(record);
    if (confirm === undefined || confirm === null) {
      const [tip, current] = await Promise.all([this.tip(projectId, record, located), this.engine.snapshot(projectId, this.projectRoot(located))]);
      const { incoming, marked } = await this.withoutMarkers(projectId, record, located, base, tip);
      const merged = await this.engine.merge(projectId, { base, current: current.commit, incoming }, { labels, root: this.rootInfo(record, located) });
      const listed = await this.existing(located.workspace, merged.writes.map(row => row.path));
      // Secret files the owner changed (B8): never written into P; named apart, with where they go (`note`).
      const secret = secretsOf(tip);
      return { ...this.token('apply', projectId, record.id, tip.tree),
        files: merged.writes.map(row => ({ path: row.path, action: row.delete ? 'delete' : listed.has(row.path) ? 'modify' : 'create' })),
        conflicts: [...merged.conflicts.map(item => ({ path: item.path, kind: item.kind })), ...marked],
        ...(secret.length ? { secret, note: this.secretNote(secret, 'apply') } : {}) };
    }
    const row = this.redeem('apply', projectId, record.id, confirm);
    const tip = await this.tip(projectId, record, located, row.tree);
    // Only the clean part, all or nothing (`cleanOnly`); what conflicts stays in the worktree, which is kept as conflicted.
    // A file still holding an Rna merge's conflict markers (a conversation's reverse merge nobody resolved) is never
    // part of it (invariant §0.3-3): it stays in the worktree as a conflict.
    const notMerged = notMergedOf(tip);
    const { incoming, marked } = await this.withoutMarkers(projectId, record, located, base, tip);
    // The user's own git operation in the project folder refuses at once (409 git_operation_in_progress, as a rollback
    // does) instead of holding the request until the operation ends (review ISO-1).
    const outcome = await this.engine.apply(projectId, { target: this.projectRoot(located), base, incoming, kind, source: { ...record.owner, worktreeId: record.id }, mode: 'all', cleanOnly: true, labels, incomingRoot: this.rootInfo(record, located), notMerged, hold: true });
    const conflicts = [...(outcome.conflicts ?? []).map(item => ({ path: item.path, kind: item.kind })), ...marked.filter(item => !(outcome.conflicts ?? []).some(other => other.path === item.path))];
    const done = ['applied', 'nothing'].includes(outcome.status) && !conflicts.length && outcome.verify !== 'unverified';
    const after = done ? await this.remove(projectId, record.id) : outcome.status === 'conflicted' || conflicts.length ? this.setState(projectId, record.id, 'conflicted') : this.record(projectId, record.id);
    const secret = secretsOf(tip);
    return { worktree: await this.view(after, located), applyId: outcome.applyId ?? null, ...(conflicts.length ? { conflicts } : {}),
      ...(secret.length ? { secret, note: this.secretNote(secret, after?.state === 'removed' ? 'applied' : 'kept') } : {}) };
  }
  /**
   * A worktree's changes without the files that hold an Rna merge's conflict marker line (`<<<<<<< refs/rna/m/…` or
   * `>>>>>>> refs/rna/m/…`, any merge: a kept conversation's unresolved reverse merge, an orphan's): `incoming` is
   * the tip with those paths as they were at `base`, so no apply from the panel carries a marker into P (invariant
   * §0.3-3); `marked` lists them as content conflicts. Computed by code from the files' bytes.
   */
  async withoutMarkers(projectId, record, located, base, tip) {
    const changed = await this.git.run(located.workspace, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', '--relative', base, tip.commit], { engine: true, maxBytes: 64 * 1024 * 1024 });
    if (changed.code !== 0 || changed.truncated) throw this.fail('engine_failed', 500, { zh: 'Git 没能列出这个工作树的改动。', en: 'Git couldn’t list this worktree’s changes.' }, { worktreeId: record.id });
    const root = this.rootInfo(record, located).root, paths = changed.stdout.split('\0').filter(Boolean), marked = [];
    for (const path of paths) {
      const file = join(root, ...path.split('/'));
      const info = await lstat(file).catch(() => null);
      if (!info?.isFile() || info.size > LIMITS.snapshotFileBytes) continue;
      if (holdsRnaMarkers(await readFile(file).catch(() => Buffer.alloc(0)))) marked.push({ path, kind: 'content' });
    }
    if (!marked.length) return { incoming: tip.commit, marked };
    return { incoming: await this.engine.syncBase(projectId, { current: tip.commit, previous: base, paths: marked.map(item => item.path) }), marked };
  }
  /** Which of these paths exist in the folder now (preview actions only). */
  async existing(folder, paths) {
    const found = new Set();
    await Promise.all(paths.map(async path => { if (await exists(join(folder, ...path.split('/')))) found.add(path); }));
    return found;
  }

  /**
   * POST …/worktrees/:wtId/discard — two steps like apply; the second removes the worktree (its tip ref stays
   * through retention) → `{ worktree: WorktreeView }`. Secret files its owner changed (B8) are in no snapshot: the
   * first step lists them in `files` too, both steps carry `secret` and, for the ones still there (they go to the
   * trash), `note`.
   */
  async discardWorktree(projectId, worktreeId, input) {
    const confirm = this.checkInput(input);
    const { record, located } = await this.settled(projectId, worktreeId);
    if (confirm === undefined || confirm === null) {
      const tip = await this.tip(projectId, record, located);
      const changed = await this.git.run(located.workspace, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', '--relative', this.baseOf(record), tip.commit], { engine: true, maxBytes: 64 * 1024 * 1024 });
      const records = changed.code === 0 ? changed.stdout.split('\0') : [], files = [];
      for (let index = 0; index + 1 < records.length; index += 2) if (records[index]) files.push({ path: records[index + 1], action: records[index] === 'A' ? 'create' : records[index] === 'D' ? 'delete' : 'modify' });
      // Secret files the owner changed are discarded too (B8): listed with the rest; the ones still in the worktree go
      // to the trash, not into a checkpoint (`secret`, `note`).
      const root = this.rootInfo(record, located).root, secret = secretsOf(tip), moved = [];
      for (const path of secret) {
        if (files.some(file => file.path === path)) continue;
        const [mine, theirs] = await Promise.all([exists(join(root, ...path.split('/'))), exists(join(located.workspace, ...path.split('/')))]);
        files.push({ path, action: !mine ? 'delete' : theirs ? 'modify' : 'create' });
        if (mine) moved.push(path);
      }
      return { ...this.token('discard', projectId, record.id, tip.tree), files, ...(secret.length ? { secret } : {}), ...(moved.length ? { note: this.secretNote(moved, 'discard') } : {}) };
    }
    const row = this.redeem('discard', projectId, record.id, confirm);
    const tip = await this.tip(projectId, record, located, row.tree);
    const root = this.rootInfo(record, located).root, secret = secretsOf(tip), moved = [];
    for (const path of secret) if (await exists(join(root, ...path.split('/')))) moved.push(path);
    const removed = await this.remove(projectId, record.id);
    return { worktree: await this.view(removed, located), ...(secret.length ? { secret } : {}), ...(moved.length ? { note: this.secretNote(moved, 'discarded') } : {}) };
  }

  /**
   * `git worktree repair` for Rna's worktrees of a project (after its folder moved, design §7.4; a lost session
   * worktree, §7.4 step 1), then resolver invalidation.
   * @returns {Promise<{ repaired: string[], missing: string[] }>}
   */
  async repair(projectId) {
    const located = await this.located(projectId), rows = this.rows(projectId).filter(row => ON_DISK.has(row.state)), repaired = [], missing = [];
    const present = [];
    for (const row of rows) (await lstat(this.paths(row, located).top).then(info => info.isDirectory(), () => false) ? present : missing).push(row);
    if (present.length) await this.lock(projectId, located, () => this.gitIn(located.workspace, ['worktree', 'repair', ...present.map(row => this.paths(row, located).top)], { code: 'worktree_repair_failed', allow: [0, 1] }));
    for (const row of present) {
      repaired.push(row.id);
      if (row.state === 'missing') this.update(projectId, row.id, item => { item.state = item.kind === 'orphan' ? 'kept' : 'active'; });
    }
    for (const row of missing) { if (row.state !== 'missing') this.update(projectId, row.id, item => { item.state = 'missing'; }); }
    this.roots?.invalidate?.({ projectId });
    return { repaired, missing: missing.map(row => row.id) };
  }

  /**
   * Re-create a lost worktree at the same record id (design §7.4 step 2): from P (`from: 'project'`) or from its
   * tip (`from: 'tip'`).
   * @returns {Promise<WorktreeRecord>}
   */
  async rebuild(projectId, worktreeId, { from } = {}) {
    if (!['project', 'tip'].includes(from)) throw new TypeError("rebuild needs from: 'project' or 'tip'.");
    const record = this.record(projectId, worktreeId);
    if (!record || record.state === 'removed' || record.kind === 'orphan') throw this.fail('worktree_not_found', 404, { zh: '没有这个工作树。', en: 'There is no such worktree.' }, { worktreeId });
    const located = await this.located(projectId), { top } = this.paths(record, located);
    if (await exists(top)) throw this.fail('worktree_create_failed', 500, { zh: '这个工作树的文件夹还在，不需要重建。', en: 'This worktree’s folder is still there; it doesn’t need rebuilding.' }, { worktreeId });
    let checkout, head, seed = record.seed, base = record.base;
    if (from === 'project') {
      const snapshot = await this.engine.snapshot(projectId, this.projectRoot(located), { pin: REFS.worktree(record.id, 'seed') });
      checkout = head = seed = snapshot.commit;
      if (record.kind === 'session') { base = snapshot.commit; await this.engine.pin(projectId, [{ ref: REFS.worktree(record.id, 'base'), commit: base }]); }
    } else {
      const tip = await this.git.run(located.workspace, ['rev-parse', '-q', '--verify', `${REFS.worktree(record.id, 'tip')}^{commit}`], { engine: true });
      if (tip.code !== 0) throw this.fail('worktree_create_failed', 500, { zh: '这个工作树没有可以重建的快照。', en: 'This worktree has no snapshot to rebuild from.' }, { worktreeId });
      checkout = tip.stdout.trim(); head = this.baseOf(record);
    }
    const reason = `Rna ${record.kind} ${ownerId(record.kind, record.owner, record.id)}`;
    const gitName = await this.lock(projectId, located, async () => {
      await this.gitIn(located.workspace, ['worktree', 'unlock', top], { allow: [0, 128] }).catch(() => {});
      await mkdir(dirname(top), { recursive: true });
      await this.gitIn(located.workspace, ['worktree', 'add', '--force', '--detach', '--lock', '--reason', reason, top, checkout]);
      const filed = await this.adminDirOf(located, top);
      const name = filed && basename(filed) !== record.name ? basename(filed) : undefined;
      const env = { GIT_DIR: filed ?? join(located.commonDir, 'worktrees', record.name), GIT_WORK_TREE: top };
      if (head !== checkout) {
        // The files are the tip; HEAD and the index go to the base, so what is not applied yet reads as uncommitted changes.
        await this.gitIn(top, ['update-ref', '--no-deref', 'HEAD', head], { env });
        await this.gitIn(top, ['read-tree', head], { env });
        await this.gitIn(top, ['update-index', '--refresh', '-q'], { env, allow: [0, 1] });
      }
      return name;
    });
    const rebuilt = { ...record, gitName, seed, ...(base ? { base } : {}) };
    if (!gitName) delete rebuilt.gitName;
    const laid = await this.layDependencies(projectId, rebuilt, located);
    return this.update(projectId, record.id, row => { row.state = 'active'; row.seed = seed; if (base) row.base = base; row.laid = laid; if (gitName) row.gitName = gitName; else delete row.gitName; });
  }

  /**
   * Startup reconciliation (design §5.3): an unrecorded worktree under WORKTREE_DIR is snapshotted to
   * REFS.orphan(name) and recorded as kind 'orphan' (never deleted automatically); a recorded one whose folder is
   * gone becomes 'missing'.
   * @returns {Promise<{ orphans: string[], missing: string[] }>}
   */
  async reconcile(projectId) {
    const orphans = [], missing = [];
    let located;
    try { located = await this.located(projectId); } catch { return { orphans, missing }; }
    const listed = await this.git.run(located.workspace, ['worktree', 'list', '--porcelain']);
    if (listed.code !== 0) return { orphans, missing };
    const base = join(located.workspace, ...WORKTREE_DIR.split('/')), rows = this.rows(projectId);
    for (const row of parseWorktrees(listed.stdout)) {
      const top = await realpath(row.path).catch(() => null);
      if (!top || dirname(top) !== base || row.bare) continue;
      const name = basename(top);
      if (rows.some(item => item.state !== 'removed' && item.dir === `${WORKTREE_DIR}/${name}`) || !/^[A-Za-z0-9_-]{1,72}$/.test(name)) continue;
      const filed = await this.adminDirOf(located, top);
      if (!filed) continue;
      const record = { id: `orphan-${name}`, kind: 'orphan', name, dir: `${WORKTREE_DIR}/${name}`, prefix: located.prefix, owner: {}, seed: row.head, state: 'kept', createdAt: iso(this.now()), ...(basename(filed) !== name ? { gitName: basename(filed) } : {}) };
      // Its files are pinned before anything else: an orphan is never deleted without the user.
      await this.engine.snapshot(projectId, this.rootInfo(record, located), { pin: REFS.orphan(name) });
      this.store.mutate(state => {
        const project = state.projects.find(item => item.id === projectId);
        project.git ??= { sessionWorktreeDefault: false, worktrees: [], applies: [] };
        project.git.worktrees = [...(project.git.worktrees ?? []).filter(item => item.id !== record.id), record];
      });
      orphans.push(record.id);
    }
    for (const row of this.rows(projectId)) {
      if (!['active', 'kept', 'conflicted'].includes(row.state)) continue;
      if (await lstat(this.paths(row, located).top).then(info => info.isDirectory(), () => false)) continue;
      this.update(projectId, row.id, item => { item.state = 'missing'; });
      missing.push(row.id);
    }
    if (orphans.length || missing.length) this.roots?.invalidate?.({ projectId });
    return { orphans, missing };
  }

  /**
   * Daily cleanup: `removed` rows past 30 days, trash past LIMITS.trashDays (realpath-checked to stay inside
   * TRASH_DIR).
   * @returns {Promise<{ rows: number, trash: number }>}
   */
  async sweep({ now = this.now() } = {}) {
    let rows = 0, trash = 0;
    for (const project of this.store.state.projects) {
      const expired = (project.git?.worktrees ?? []).filter(row => row.state === 'removed' && Date.parse(row.removedAt ?? '') <= now - LIMITS.retentionDays * DAY_MS);
      if (expired.length) {
        // Their refs (seed, base, tip) go with the rows: the retention period is over.
        if (this.engine) await this.engine.pin(project.id, expired.flatMap(row => ['seed', 'base', 'tip', 'premerge'].map(which => ({ ref: REFS.worktree(row.id, which), commit: null })))).catch(() => {});
        const ids = new Set(expired.map(row => row.id));
        this.store.mutate(state => { const target = state.projects.find(item => item.id === project.id); if (target?.git?.worktrees) target.git.worktrees = target.git.worktrees.filter(row => !ids.has(row.id)); });
        rows += ids.size;
      }
      let folder;
      try { folder = await realpath(registeredWorkspacePath(project.workspace)); } catch { continue; }
      const lexical = join(folder, ...TRASH_DIR.split('/')), bin = await realpath(lexical).catch(() => null);
      // A trash folder that resolves anywhere else (a link swapped in) is never emptied.
      if (!bin || bin !== lexical) continue;
      for (const name of await readdir(bin).catch(() => [])) {
        const entry = join(bin, name), info = await lstat(entry).catch(() => null);
        if (!info || info.mtimeMs > now - LIMITS.trashDays * DAY_MS) continue;
        if (dirname(entry) !== bin || !within(bin, entry) || entry === bin) continue;
        await rm(entry, { recursive: true, force: true });
        trash++;
      }
      await rmdir(bin).catch(() => {});
    }
    return { rows, trash };
  }
}

