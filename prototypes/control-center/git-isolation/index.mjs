import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { watch as watchFolder } from 'node:fs';
import { lstat, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { basename, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { APPLY_INITIATORS, APPLY_KINDS, APPLY_TARGET, DEPENDENCY_FILES, HOST_CARDS, ISOLATION_READY, LIMITS, REFS, USER_ONLY_CONFLICTS, WORKTREE_DIR, WRITE_MODES, hasMergeMarkers, isSecretPath } from './contract.mjs';
import { customDrivers, driverOverrides, eligibility, engineError, gitVersion, globalExcludesFile, versionAtLeast, worktreeEnv } from './env.mjs';
import { commitTree, dropPrivateIndex, snapshot as takeSnapshot } from './snapshot.mjs';
import { indexEntries, liveIndexNames, orphanIndexes, ownerOf } from './storage.mjs';
import { linkEscapes, merge as mergeTrees, preview, show } from './merge.mjs';
import { checkWritePath, currentState, holds, holdsRnaMarkers, sameEntry, sweepScratch, write } from './writer.mjs';
import { applyRow, applyRows, applyView, beginApply, dropApply, gitOf, recoverApplies, retention, settleApply, summarize } from './records.mjs';
import { RollbackTokens, planRollback, recordCommits } from './rollback.mjs';
import { composeTree, diffTrees, emptyTree, lsTree, objects, peelTree, readBlobs, toRoot, toTree, updateRefs, LIST_OUTPUT } from './tree.mjs';
import { WorkspaceGitService, parseNameStatus, parseNumstat, splitPatch, withCounts, wholeLines, BINARY_PATCH, DIFF_FLAGS } from '../workspace-git-service.mjs';
import { toolPermitted } from '../project-permissions.mjs';
import { inLanguage, interfaceLanguageOf } from '../interface-language.mjs';
import { toolKind } from '../live-bus.mjs';

// The merge engine's public face (design §3, §5). Owner of the bodies: T1; the class, method names, parameters and
// return shapes are the lead's contract (CONTRACT.md). Other teams use IsolationEngine and contract.mjs only, never
// the submodules (env, snapshot, merge, writer, records, rollback, tree), whose exports are T1's to refine.
//
// One engine serves: worker W → parent root (P or S), session S → P, background B → P, the turn-start sync P → S,
// rollback, and direct-mode turn checkpoints. Every host write into a repository goes through one FIFO per
// repository (WorkspaceGitService.serial(located), shared with the panel's stage and discard). Source snapshots are
// taken outside the lock, the target's inside it, and every apply merges into the target snapshot just taken, so a
// later apply always lands on top of an earlier one.

export * from './contract.mjs';
/** Host writes into a worktree outside the engine (attachments, cleanup) re-check their folder with it (writer.mjs). */
export { sameFolder } from './writer.mjs';
/** The read-only storage view of doctor and GET /api/health (B8), and its pure catalog. */
export { IsolationStorage, STORAGE_CATALOG, STORAGE_CLEANABILITY } from './storage.mjs';

/**
 * @typedef {import('./contract.mjs').RootInfo} RootInfo
 * @typedef {import('./contract.mjs').Isolation} Isolation
 * @typedef {import('./contract.mjs').Snapshot} Snapshot
 * @typedef {import('./contract.mjs').Conflict} Conflict
 * @typedef {import('./contract.mjs').ApplyOutcome} ApplyOutcome
 * @typedef {import('./merge.mjs').MergeResult} MergeResult
 * @typedef {import('./records.mjs').ApplyRow} ApplyRow
 * @typedef {import('./rollback.mjs').RollbackPreview} RollbackPreview
 * @typedef {import('./rollback.mjs').RollbackResult} RollbackResult
 *
 * @typedef {object} ApplyRequest
 * @property {RootInfo} target       Where to write: P (kind 'project'), or S / B (markers, start sync, take).
 * @property {string} base           Merge base: a commit or tree (a worker's seed, a session's base, a record's after).
 * @property {string} incoming       The source snapshot's commit (pinned by the caller, e.g. REFS.worktree(id, 'tip')).
 * @property {'turn'|'worker'|'background'|'resolve'|'rollback'} kind
 * @property {{ sessionId?: string, turnId?: string, agentId?: string, actionId?: string, worktreeId?: string }} source
 * @property {'all'|'partial'|'markers'} mode
 * @property {{ current: string, incoming: string }} labels  MERGE_LABELS.*
 * @property {(operation: string) => void} [onWaiting]  P has a merge/rebase/… in progress: called once, then the
 *   apply waits for it to end (design §3.7 "排队"); the caller posts its timeline line.
 * @property {boolean} [hold]  Never wait for a git operation in P: throw `git_operation_in_progress` (with
 *   `operation`) before anything is written instead (review ISO-1). Every unattended write into P holds this way —
 *   a background change set, a worker's merge, a conversation's idle and hand-back applies — and is retried once the
 *   operation ends (whenProjectFree); a user's or the model's own action refuses at once. Only a conversation's
 *   turn-end apply still waits, with its timeline line and the turn's signal.
 * @property {AbortSignal} [signal]
 * @property {RootInfo} [incomingRoot]  The root `incoming` was snapshotted from: its files are checked for hard links.
 * @property {{ path: string, reason: string }[]} [notMerged]  What the source snapshot skipped (its `oversized` /
 *   `nested`), reported back in the outcome.
 * @property {boolean} [cleanOnly]  `all` mode with conflicts: write the clean part, all or nothing (the hand-back
 *   moments of design §4.2 / §4.3); without it, `all` writes nothing when anything conflicts.
 * @property {'user'|'agent'|'host'} [initiator]  A `rollback` written into S (a dropped worker): who asked for it,
 *   recorded on the row (APPLY_INITIATORS).
 *
 * @typedef {(projectId: string) => number} ExecRunning  Direct-mode project_exec runs in progress for a project
 *   (RuntimeController#execRunning, T4). Writes into P wait up to LIMITS.execIdleWaitMs for 0, then go ahead (CAS
 *   still protects them).
 * @typedef {(projectId: string, turnId: string) => Promise<{ start: string, end: string, paths: string[], excluded: { path: string, applyId: string }[] }>} Attributable
 *   TurnCheckpoint#attributable (T4): a direct-mode turn's checkpoint and the paths that are its own (design §5.1).
 */

const sleep = ms => new Promise(done => setTimeout(done, ms));
const hex = bytes => randomBytes(bytes).toString('hex');
const within = (root, path) => { const part = relative(root, path); return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };
const aborted = signal => { if (signal?.aborted) throw Object.assign(new Error('The apply was stopped.'), { name: 'AbortError', code: 'aborted' }); };
const treeChange = (context, entry) => (entry.next ? { path: toTree(context, entry.path), mode: entry.next.mode, oid: entry.next.oid } : { path: toTree(context, entry.path), delete: true });
const DAY = 86400000;
/** How long the daily sweep's `git gc --auto` may hold the repository lock before it is stopped (git cleans up after itself). */
const GC_TIMEOUT_MS = 10 * 60000;
/** At most this many of a rollback plan's skipped files are recorded on its row (row fields stay small, as `sample`). */
const SKIPPED_ON_ROW = 20;
/** The `initiator` field of an undoing record: only a known caller option is recorded (APPLY_INITIATORS). */
const initiatedBy = initiator => (APPLY_INITIATORS.includes(initiator) ? { initiator } : {});
/** The parts of an apply row's source a record undoing it keeps, so its owner (a turn, a worker, a background run) stays readable. */
const ownerSource = source => Object.fromEntries(['sessionId', 'turnId', 'agentId', 'actionId', 'worktreeId'].filter(key => typeof source?.[key] === 'string' && source[key]).map(key => [key, source[key]]));
/** What the user reads when an engine step fails under a user action (the technical message stays in `detail`). */
const HUMAN = {
  snapshot_unreadable: { zh: '有文件读不了，没法先给文件夹建检查点，所以没有改动任何文件。', en: 'Some files can’t be read, so no checkpoint of the folder could be taken and nothing was changed.' },
  snapshot_timeout: { zh: '给文件夹建检查点太慢、超时了，所以没有改动任何文件。', en: 'Taking a checkpoint of the folder took too long, so nothing was changed.' },
  engine_failed: { zh: 'Git 没能完成这次操作。', en: 'Git couldn’t complete this.' },
  write_path_denied: { zh: '有文件路径超出了项目文件夹，没有写入。', en: 'A file path is outside the project folder, so it wasn’t written.' },
  worktree_missing: { zh: '这个工作树的文件夹已经不在了。', en: 'This worktree’s folder is gone.' },
};
/** Conflict kinds take() never writes, not even on the user's word (a card answer). */
const NEVER_TAKEN = Object.freeze(['unsafe_symlink', 'submodule']);
/** The repository locks the current chain of calls holds (IsolationEngine.lock is re-entrant through it). */
const holding = new AsyncLocalStorage();

/**
 * A source snapshot's skipped paths as an ApplyRequest's `notMerged` (oversized files, repositories of their own and
 * the secret files its owner changed are never merged; the outcome reports them back).
 * @param {Snapshot} snapshot
 * @returns {{ path: string, reason: 'oversized'|'nested'|'secret' }[]}
 */
export function notMergedOf(snapshot) {
  return [...(snapshot?.oversized ?? []).map(path => ({ path, reason: 'oversized' })), ...(snapshot?.nested ?? []).map(path => ({ path, reason: 'nested' })), ...(snapshot?.secret ?? []).map(path => ({ path, reason: 'secret' }))];
}

export class IsolationEngine {
  /**
   * @param {import('../store.mjs').Store} store
   * @param {{ git?: import('../workspace-git-service.mjs').WorkspaceGitService, execRunning?: ExecRunning, attributable?: Attributable, interactions?: object, now?: () => number, ready?: boolean, sandbox?: () => boolean, pollMs?: number, execWaitMs?: number, freePollMs?: number, hooks?: object }} [options]
   *   `ready` (default ISOLATION_READY) and `sandbox` feed isolation(); `pollMs` / `execWaitMs` pace the waits
   *   before a write into P; `freePollMs` paces whenProjectFree's fallback check (default 40 × pollMs, at least 1 s);
   *   `hooks` are test seams of the writer.
   */
  constructor(store, { git = null, execRunning = () => 0, attributable = null, interactions = null, now = Date.now, ready = ISOLATION_READY, sandbox, pollMs = 250, execWaitMs = LIMITS.execIdleWaitMs, freePollMs, hooks = null } = {}) {
    Object.assign(this, { store, git, execRunning, attributable, interactions, now });
    this.settings = { ready, sandbox, pollMs, execWaitMs, freePollMs: Number.isFinite(freePollMs) && freePollMs > 0 ? freePollMs : Math.max(1000, pollMs * 40), hooks };
    /** projectId → the watch of whenProjectFree: { gitDir, callbacks: Map key → fn, watcher, timer, checking }. */
    this.freeWaits = new Map();
    /** Interrupted-apply card answers held on a git operation in P (row id), taken up again once it ends. */
    this.heldCards = new Set();
    this.tokens = new RollbackTokens({ ttlMs: LIMITS.rollbackTokenMs, now });
    this.eligible = new Map(); this.facts = new Map(); this.settling = new Set(); this.unwatch = null;
    /** turnPlan() answers for a short while (a turn's 审阅 asks for its files, then their patches one by one). */
    this.turnPlans = new Map();
    /** The directory observation (ProjectObservationService, wired by server.mjs): told about the user's undo writes. */
    this.undoWrites = null;
    /** turnPlan() computations under way, by key: a second ask waits for the first. */
    this.turnPlanRuns = new Map();
  }

  /**
   * A user's undo is about to write into the project folder (a rollback or "go back to before" the user asked for, the
   * changes panel's discard): `end(paths)` hands over what it wrote, so the folder's observation does not report the
   * undo as an unexplained change that wakes the proactive loop; the undo reaches the models as a workspace event.
   * @returns {{ end: (paths?: string[]) => Promise<void> }|null}
   */
  userUndoWrite(projectId) {
    try { return this.undoWrites?.undoWrite?.(projectId) ?? null; } catch { return null; }
  }

  say(variants) { return inLanguage(interfaceLanguageOf(this.store.state), variants); }
  fail(code, variants, extra = {}) { throw engineError(code, this.say(variants), extra); }
  gitService() { return this.git ??= new WorkspaceGitService(this.store); }
  /** Run a user action: an engine failure reaches the user in their language, the technical text in `detail`. */
  async human(work) {
    try { return await work(); }
    catch (error) { if (HUMAN[error?.code] && error.detail === undefined) { error.detail = error.message; error.message = this.say(HUMAN[error.code]); } throw error; }
  }
  projectRow(projectId) {
    const project = this.store.state.projects.find(row => row.id === projectId);
    if (!project) this.fail('project_not_found', { zh: '项目不存在。', en: 'This project no longer exists.' }, { status: 404 });
    return project;
  }

  /**
   * The user's global excludes file, read once with the ordinary environment (design §3.1) and handed to
   * WorkspaceGitService, so every `engine: true` command (other teams' too) keeps the user's global ignore rules.
   * @returns {Promise<string|null>}
   */
  async primeExcludes() {
    const git = this.gitService();
    this.excludes ??= globalExcludesFile(git);
    return git.excludesFile = await this.excludes;
  }

  /** The engine context of a project's repository (design §3.1): where it is, its drivers turned off, its facts. */
  async context(projectId) {
    const git = this.gitService(), located = await git.locateProject(projectId);
    if (located.repo === 'none') this.fail('git_unavailable', located.unavailable === 'workspace_missing' ? { zh: '项目文件夹找不到了。', en: 'The project folder can’t be found.' } : { zh: '项目文件夹不是 Git 仓库。', en: 'The project folder isn’t a Git repository.' }, { status: 409 });
    const excludesFile = await this.primeExcludes();
    const [commonDir, top] = await Promise.all([realpath(located.commonDir), realpath(located.top)]);
    const configFacts = await stat(join(commonDir, 'config')).then(info => `${info.mtimeMs}:${info.size}`, () => 'none');
    let facts = this.facts.get(commonDir);
    if (facts?.stamp !== configFacts) {
      const engine = { excludesFile: null };
      const bool = async key => { const result = await git.run(located.workspace, ['config', '--bool', '--get', key], { engine }); return result.code === 0 ? result.stdout.trim() : null; };
      const format = await git.run(located.workspace, ['rev-parse', '--show-object-format'], { engine });
      const autocrlf = await git.run(located.workspace, ['config', '--get', 'core.autocrlf'], { engine });
      facts = { stamp: configFacts, config: driverOverrides(await customDrivers(git, located)), ignoreCase: (await bool('core.ignorecase')) === 'true', fileMode: (await bool('core.filemode')) !== 'false', oidLength: format.stdout.trim() === 'sha256' ? 64 : 40, autocrlf: /^(?:true|yes|on|1)$/i.test(autocrlf.stdout.trim()) ? 'true' : autocrlf.stdout.trim() || null };
      this.facts.set(commonDir, facts);
    }
    return { git, raw: located, located: { ...located, commonDir, top }, excludesFile, config: facts.config, ignoreCase: facts.ignoreCase, fileMode: facts.fileMode, oidLength: facts.oidLength, autocrlf: facts.autocrlf, hooks: this.settings.hooks, onTampered: root => this.tampered(projectId, root) };
  }

  /** A worktree's `.git` file was changed and put back (design §3.1): one event in the state's log, and the console. */
  tampered(projectId, root) {
    console.warn(`worktree_tampered: ${root.workTree} (project ${projectId})`);
    try {
      this.store.mutate(state => {
        if (!Array.isArray(state.events)) return;
        state.events.push({ id: (state.sequence = (state.sequence ?? 0) + 1), type: 'worktree_tampered', message: this.say({ zh: 'Rna 工作树的 .git 文件被改过，已按登记改回。', en: 'An Rna worktree’s .git file was changed; it was put back from the record.' }), taskId: null, at: new Date(this.now()).toISOString(), projectId, worktreeId: root.worktreeId ?? null });
        state.events = state.events.slice(-1000);
      });
    } catch { /* the console line stays */ }
  }

  /**
   * Every three-way step (merge-tree --write-tree) needs git 2.38 (design §1 #21). Isolation is off below it, but
   * records made earlier, rollback of direct-mode turns and of the panel's discard, and the worktree panel still merge:
   * an older git gets a plain refusal (409 `git_unavailable`, reason `git_too_old`) instead of a failed merge.
   */
  async mergeCapable() {
    const git = this.gitService(), tools = await git.availability?.().catch(() => null), key = tools?.binary ?? tools?.reason ?? 'git';
    if (this.versionKey !== key) { this.versionKey = key; this.versionCheck = gitVersion(git); }
    const version = await this.versionCheck;
    if (versionAtLeast(version)) return;
    this.fail('git_unavailable', version
      ? { zh: `这一步需要 Git 2.38 或更新版本，这台电脑上的是 ${version.text}。`, en: `This needs Git 2.38 or later; this computer has ${version.text}.` }
      : { zh: 'Git 不可用。', en: 'Git isn’t available.' }, { status: 409, reason: version ? 'git_too_old' : 'git_unavailable' });
  }

  /** P as a root. */
  projectRoot(context) { return { root: context.located.workspace, kind: 'project', isolated: false, project: context.located.workspace, prefix: context.located.prefix ?? '' }; }

  /** A root must be P, or an Rna worktree of this repository inside P's worktree folder (design §9). */
  checkRoot(context, root) {
    const denied = () => this.fail('root_denied', { zh: '这个文件夹既不是项目文件夹，也不是 Rna 登记的工作树。', en: 'That folder is neither the project folder nor a worktree Rna registered.' });
    if (!root || typeof root.root !== 'string') denied();
    if (!root.isolated) { if (root.kind !== 'project' || root.root !== context.located.workspace) denied(); return root; }
    if (!['session', 'worker', 'background'].includes(root.kind) || typeof root.workTree !== 'string' || typeof root.gitDir !== 'string') denied();
    const folder = join(context.located.workspace, WORKTREE_DIR), admin = join(context.located.commonDir, 'worktrees');
    if (!within(folder, root.workTree) || root.workTree === folder || !within(admin, root.gitDir) || root.gitDir === admin) denied();
    if (join(root.workTree, context.located.prefix ?? '').replace(/\/$/, '') !== root.root.replace(/\/$/, '')) denied();
    return root;
  }

  /** `project.git.applies[].target` of a root. */
  targetOf(projectId, root) {
    if (root.kind === 'project') return APPLY_TARGET.project;
    const record = (this.store.state.projects.find(row => row.id === projectId)?.git?.worktrees ?? []).find(row => row.id === root.worktreeId);
    if (root.kind === 'session') return APPLY_TARGET.session(record?.owner?.sessionId ?? root.worktreeId);
    if (root.kind === 'background') return APPLY_TARGET.background(record?.owner?.actionId ?? root.worktreeId);
    return this.fail('root_denied', { zh: 'worker 的工作树只是合并来源，宿主不往里写。', en: 'A worker’s worktree is only a merge source; the host never writes into it.' });
  }

  /**
   * Isolation conditions of a project (design §2), cached in memory and dropped when the git version or the
   * repository changes; never stored in state.
   * @param {string} projectId
   * @returns {Promise<Isolation>}
   */
  async isolation(projectId) {
    const git = this.gitService(), located = await git.locateProject(projectId), tools = await git.availability();
    const config = located.commonDir ? await stat(join(located.commonDir, 'config')).then(info => info.mtimeMs, () => null) : null;
    // A pilot project (project.git.isolationPilot, set by the user for a real-model walk-through) is isolated before
    // the release gate opens for everyone; every other condition still applies to it.
    const pilot = this.store.state.projects.find(row => row.id === projectId)?.git?.isolationPilot === true;
    const stamp = JSON.stringify([tools.binary ?? tools.reason, located.repo, located.unavailable ?? null, located.commonDir ?? null, config, pilot]);
    const cached = this.eligible.get(projectId);
    if (cached?.stamp === stamp) return { ...cached.value };
    const value = await eligibility({ git, projectId, ready: this.settings.ready || pilot, ...(this.settings.sandbox ? { sandbox: this.settings.sandbox } : {}) });
    this.eligible.set(projectId, { stamp, value });
    return { ...value };
  }

  /**
   * Snapshot a root (design §3.2). `pin`: a ref (REFS.*) to point at the snapshot's commit.
   * @param {string} projectId
   * @param {RootInfo} root
   * @param {{ pin?: string, signal?: AbortSignal }} [options]
   * @returns {Promise<Snapshot>}
   */
  async snapshot(projectId, root, { pin, signal } = {}) {
    const context = await this.context(projectId);
    this.checkRoot(context, root);
    // An isolated root's laid-down copies (its worktree record's `laid`): an untouched one is no secret change of its
    // owner's, whatever the file it was copied from became since (B8).
    const laid = root?.isolated ? this.store.state.projects.find(row => row.id === projectId)?.git?.worktrees?.find(row => row.id === root.worktreeId)?.laid ?? null : null;
    const result = await takeSnapshot(context, root, { signal, laid });
    if (pin) await this.lock(projectId, () => updateRefs(context, [{ ref: pin, commit: result.commit }]));
    return result;
  }

  /**
   * Move or delete hidden refs in one transaction, under the repository lock.
   * @param {string} projectId
   * @param {{ ref: string, commit: string|null }[]} updates
   */
  async pin(projectId, updates) {
    const context = await this.context(projectId);
    return this.lock(projectId, () => updateRefs(context, updates));
  }

  /**
   * Forget a root that is gone (a removed worktree, review ISO-6): its private index and notes are deleted, so
   * `.git/rna/index` does not grow with every delegation. A cache: nothing else depends on it. Additive.
   * @param {string} projectId
   * @param {{ root: string }} root  the root as it was snapshotted (RootInfo.root)
   */
  async forgetRoot(projectId, root) {
    if (typeof root?.root !== 'string' || !root.root) return;
    const context = await this.context(projectId);
    await dropPrivateIndex(context.located.commonDir, root.root);
  }

  /**
   * A merge without writing (design §3.4): previews, `agent_merge` show, the "pending files" count of a worktree.
   * @param {string} projectId
   * @param {{ base: string, current: string, incoming: string }} trees
   * @param {{ labels: { current: string, incoming: string }, root?: RootInfo }} options
   * @returns {Promise<MergeResult>}
   */
  async merge(projectId, trees, { labels, root } = {}) {
    await this.mergeCapable();
    const context = await this.context(projectId);
    return mergeTrees(context, trees, { mid: hex(8), labels, root });
  }

  /**
   * A tree with root-path entries replaced (`{ path, mode, oid }`) or removed (`{ path, delete: true }`), written to
   * the object store (temporary index, nothing else touched). Additive to the contract.
   * @param {string} projectId
   * @param {string} tree  a tree or commit
   * @param {({ path: string, mode: string, oid: string }|{ path: string, delete: true })[]} entries
   * @returns {Promise<string>}  tree id
   */
  async compose(projectId, tree, entries) {
    const context = await this.context(projectId);
    const base = await objects(context, ['rev-parse', '--verify', '-q', `${tree}^{tree}`]).then(result => result.stdout.trim());
    return composeTree(context, base, entries.map(entry => (entry.delete ? { path: toTree(context, entry.path), delete: true } : { path: toTree(context, entry.path), mode: entry.mode, oid: entry.oid })));
  }

  /**
   * A session's next base after a sync or a reverse merge (design §4.2 step 3, §7.3): `current` (the project
   * folder's tree), except that the listed root paths keep their entry in `previous` (the old base), absent there →
   * absent. So a path left conflicted conflicts again next time instead of being taken over silently.
   * @param {string} projectId
   * @param {{ current: string, previous: string, paths: string[] }} input
   * @returns {Promise<string>}  tree id
   */
  async syncBase(projectId, { current, previous, paths = [] }) {
    const context = await this.context(projectId);
    const [now, before] = await Promise.all([current, previous].map(rev => objects(context, ['rev-parse', '--verify', '-q', `${rev}^{tree}`]).then(result => result.stdout.trim())));
    if (!paths.length) return now;
    const kept = await lsTree(context, before, paths.map(path => toTree(context, path)));
    return composeTree(context, now, paths.map(path => { const row = kept.get(toTree(context, path)); return row && row.type !== 'tree' ? { path: toTree(context, path), mode: row.mode, oid: row.oid } : { path: toTree(context, path), delete: true }; }));
  }

  /**
   * Before a write into P: Rna's own direct-mode commands run out (≤ execWaitMs), and no git operation is going on.
   * `hold`: a git operation in P throws `git_operation_in_progress` at once (checked first, and again after the
   * commands ran out) instead of waiting for it to end.
   */
  async waitForProject(projectId, context, { onWaiting, signal, hold = false } = {}) {
    const operation = () => context.git.operation(context.located.gitDir);
    if (hold) { const found = await operation(); if (found) throw this.operationRefused(found); }
    const deadline = Date.now() + this.settings.execWaitMs;
    while (Date.now() < deadline && (Number(this.execRunning(projectId)) || 0) > 0) { aborted(signal); await sleep(this.settings.pollMs); }
    let told = false;
    for (;;) {
      aborted(signal);
      const found = await operation();
      if (!found) return;
      if (hold) throw this.operationRefused(found);
      if (!told) { told = true; try { onWaiting?.(found); } catch { /* the caller's timeline line is best effort */ } }
      await sleep(Math.max(this.settings.pollMs, 1000));
    }
  }
  /** The refusal of a write into P held on the user's git operation there (`operation`: merge, rebase, …). */
  operationRefused(operation) {
    return engineError('git_operation_in_progress', this.say({ zh: `项目文件夹正在进行 git ${operation}，完成后再写入。`, en: `A git ${operation} is in progress in the project folder; nothing is written into it until it finishes.` }), { operation });
  }

  /**
   * The user's git operation in progress in the project folder (merge, rebase, cherry-pick, revert, bisect: the
   * markers WorkspaceGitService.operation reads), or null — null too when the project has no repository (the write
   * that follows answers that). Unattended writes into P check it before they start and hold instead of waiting
   * (review ISO-1). Additive to the contract.
   * @param {string} projectId
   * @returns {Promise<string|null>}
   */
  async projectBusy(projectId) {
    const git = this.gitService();
    let located;
    try { located = await git.locateProject(projectId); } catch { return null; }
    if (!located || located.repo === 'none' || !located.gitDir) return null;
    return (await git.operation(located.gitDir).catch(() => null)) ?? null;
  }
  /** Whether a whenProjectFree watch is waiting on this project: a git operation was seen there and has not ended yet. */
  waitingFree(projectId) { return this.freeWaits.has(projectId); }
  /**
   * Call `fn` once no git operation is in progress in the project folder (soon, when there is none now). One watch per
   * project, shared by every caller and keyed (`key`): registering the same key again replaces its callback, so a
   * retried hold never piles up callbacks. The watch is fs.watch on the repository's git directory (where the
   * operation markers live), with a check every `freePollMs` as the fallback a missed event needs; neither keeps the
   * process alive or counts as work in progress. Answers the cancel function. Additive to the contract.
   * @param {string} projectId
   * @param {string} key
   * @param {() => void} fn
   * @returns {() => void}
   */
  whenProjectFree(projectId, key, fn) {
    if (this.closed) return () => {};
    let entry = this.freeWaits.get(projectId);
    if (!entry) {
      entry = { gitDir: null, callbacks: new Map(), watcher: null, timer: null, checking: false, again: false };
      this.freeWaits.set(projectId, entry);
      void this.armFree(projectId, entry);
    }
    entry.callbacks.set(key, fn);
    return () => { if (entry.callbacks.get(key) === fn) entry.callbacks.delete(key); if (!entry.callbacks.size) this.disarmFree(projectId, entry); };
  }
  async armFree(projectId, entry) {
    try {
      const located = await this.gitService().locateProject(projectId);
      if (this.freeWaits.get(projectId) !== entry) return;
      entry.gitDir = located?.repo !== 'none' ? located?.gitDir ?? null : null;
    } catch { entry.gitDir = null; }
    if (this.freeWaits.get(projectId) !== entry) return;
    if (entry.gitDir) {
      try { entry.watcher = watchFolder(entry.gitDir, { persistent: false }, () => { void this.checkFree(projectId, entry); }); entry.watcher.on('error', () => { try { entry.watcher?.close(); } catch { /* closed */ } entry.watcher = null; }); }
      catch { entry.watcher = null; }
    }
    entry.timer = setInterval(() => { void this.checkFree(projectId, entry); }, this.settings.freePollMs);
    entry.timer.unref?.();
    void this.checkFree(projectId, entry);
  }
  async checkFree(projectId, entry) {
    if (this.freeWaits.get(projectId) !== entry) return;
    if (entry.checking) { entry.again = true; return; }
    entry.checking = true;
    let busy = true;
    try {
      // No repository (any more): nothing to wait for; the callbacks find out for themselves.
      busy = entry.gitDir ? Boolean(await this.gitService().operation(entry.gitDir)) : false;
    } catch { busy = false; }
    finally { entry.checking = false; }
    if (this.freeWaits.get(projectId) !== entry) return;
    if (busy) { if (entry.again) { entry.again = false; void this.checkFree(projectId, entry); } return; }
    const callbacks = [...entry.callbacks.values()];
    this.disarmFree(projectId, entry);
    for (const fn of callbacks) setImmediate(() => { try { fn(); } catch (error) { console.warn(`git operation ended (${projectId}): ${error.message}`); } });
  }
  disarmFree(projectId, entry) {
    if (this.freeWaits.get(projectId) === entry) this.freeWaits.delete(projectId);
    try { entry.watcher?.close(); } catch { /* closed */ }
    if (entry.timer) clearInterval(entry.timer);
    entry.watcher = null; entry.timer = null;
  }

  /**
   * Write a plan into a root as one apply record (design §3.6): before pinned and a `writing` row persisted before
   * the first byte, then the write, then the record's ref moved to [before, after] and the row settled. The caller
   * holds the repository lock. Answers null when an `all` write raced and was fully put back (nothing recorded).
   * Entries no write may carry (refusedEntries: a gitlink anywhere, an Rna merge's conflict markers into P) are left
   * out before the checkpoint and reported as conflicts; `all` without `cleanOnly` then writes nothing.
   * `skipped`: files the plan itself left out (a rollback's changed_after / conflict / unattributable files), recorded
   * on the row ahead of the ones the write skipped, so the record says what it did not undo.
   */
  async recordedWrite(context, projectId, root, before, entries, { kind, source = {}, mode, bothChanged = 0, extra = {}, cleanOnly = false, skipped: planSkipped = [] }) {
    const applyId = extra.id ?? `a${hex(8)}`, target = this.targetOf(projectId, root);
    const refused = await refusedEntries(context, root, entries, before.nested), plan = refused.length ? entries.filter(entry => !refused.some(row => row.path === entry.path)) : entries;
    const nothing = () => ({ applyId: null, outcome: { written: [], removed: [], raced: [], conflicts: refused, rolledBack: false, verify: 'verified', mismatched: [] } });
    if (refused.length && ((mode === 'all' && !cleanOnly) || !plan.length)) return nothing();
    const planned = await composeTree(context, before.tree, plan.map(entry => treeChange(context, entry)));
    // ApplyRow.ms (review ISO-8): from the record's first durable step to its settling, the write and its check included.
    const started = Date.now();
    const plannedCommit = await commitTree(context, planned, [before.commit], `Rna apply ${applyId} (planned)`);
    await updateRefs(context, [{ ref: REFS.apply(applyId), commit: await commitTree(context, planned, [before.commit, plannedCommit], `Rna apply ${applyId}`) }]);
    beginApply(this.store, projectId, { id: applyId, kind, target, source: structuredClone(source), ...summarize(plan.map(entry => ({ path: entry.path, old: entry.expect, next: entry.next }))), bothChanged, ...(root.isolated ? { targetWorktreeId: root.worktreeId } : {}), ...extra });
    // The user's own undo into the project folder: the directory observation folds these writes in (userUndoWrite).
    const undo = target === APPLY_TARGET.project && extra.initiator === 'user' ? this.userUndoWrite(projectId) : null;
    let outcome;
    try { outcome = await write(context, root, plan, { mode }); }
    catch (error) {
      await undo?.end();
      // Refused before any file changed (a path check, a blob that could not be read): nothing to record. The file
      // system refused a write part way (permissions, a full disk): settle the record now, as startup recovery would
      // (finish it, or mark it interrupted with its card), instead of leaving it `writing`. Anything else part way
      // stays `writing` for startup recovery.
      if (!error?.wrote) { await updateRefs(context, [{ ref: REFS.apply(applyId), commit: null }]).catch(() => {}); dropApply(this.store, projectId, applyId); }
      else if (error?.syscall) await this.recoverRow(projectId, applyId).catch(() => this.interruptRow(projectId, applyId));
      throw error;
    }
    await undo?.end([...outcome.written, ...outcome.removed]);
    if (refused.length) outcome.conflicts = [...refused, ...outcome.conflicts];
    const done = new Set([...outcome.written, ...outcome.removed]);
    if (!done.size) { await updateRefs(context, [{ ref: REFS.apply(applyId), commit: null }]); dropApply(this.store, projectId, applyId); return { applyId: null, outcome }; }
    const actual = plan.filter(entry => done.has(entry.path));
    const after = await composeTree(context, before.tree, actual.map(entry => treeChange(context, entry)));
    const afterCommit = await commitTree(context, after, [before.commit], `Rna apply ${applyId} (after)`);
    await updateRefs(context, [{ ref: REFS.apply(applyId), commit: await commitTree(context, after, [before.commit, afterCommit], `Rna apply ${applyId}`) }]);
    const skipped = [...planSkipped.map(row => ({ path: row.path, reason: row.reason })), ...outcome.conflicts.map(row => ({ path: row.path, reason: row.kind })), ...outcome.mismatched.map(path => ({ path, reason: 'mismatch' })), ...(outcome.stuck ?? []).map(path => ({ path, reason: 'changed_during_merge' }))];
    settleApply(this.store, projectId, applyId, { state: outcome.verify === 'verified' && !outcome.stuck ? 'verified' : 'unverified', ...summarize(actual.map(entry => ({ path: entry.path, old: entry.expect, next: entry.next }))), skipped: skipped.length ? skipped : undefined, ms: Math.max(0, Date.now() - started), ...(Number.isSafeInteger(outcome.bytes) ? { bytes: outcome.bytes } : {}) });
    return { applyId, outcome, after };
  }

  /**
   * Merge `incoming` over `base` into the target's current state and write it (design §3.4–§3.7, invariants
   * §0.3-1/2/3/4/5): for a P target, wait for ExecRunning to reach 0 (≤ LIMITS.execIdleWaitMs) and for any git
   * operation in P to end (with `hold`: refuse at once, `git_operation_in_progress`, nothing written); take the
   * repository lock; snapshot the target; merge(base, target, incoming); persist the
   * `writing` record; write in `mode`; verify; settle the record. `all`: any conflict → nothing written
   * (`conflicted`; with `cleanOnly` the clean part is written all or nothing), a CAS race → retried from a fresh
   * snapshot up to LIMITS.writeAllAttempts, then `blocked`. `partial`: the clean part written, CAS failures become
   * `changed_during_merge` conflicts. `markers`: S or B only; text conflicts written with markers. Nothing to do
   * (incoming == base, or the result equals the target) → `nothing` with no record.
   * @param {string} projectId
   * @param {ApplyRequest} request
   * @returns {Promise<ApplyOutcome>}
   */
  async apply(projectId, request) {
    const { target, mode, kind, signal } = request ?? {};
    if (!WRITE_MODES.includes(mode)) throw engineError('engine_failed', `Unknown write mode ${mode}.`);
    if (!APPLY_KINDS.includes(kind) || kind === 'user_discard') throw engineError('engine_failed', `Unknown apply kind ${kind}.`);
    if (mode === 'markers' && !['session', 'background'].includes(target?.kind)) throw engineError('markers_target_denied', 'Conflict markers are written only into a session or background worktree.');
    await this.recovering?.catch(() => {});
    await this.mergeCapable();
    const context = await this.context(projectId);
    this.checkRoot(context, target);
    for (;;) {
      if (target.kind === 'project') await this.waitForProject(projectId, context, request);
      aborted(signal);
      // A git operation that started while this apply waited for the lock: wait again outside it.
      const result = await this.lock(projectId, async () => (target.kind === 'project' && await context.git.operation(context.located.gitDir) ? null : this.applyLocked(context, projectId, request)));
      if (result) return result;
    }
  }

  async applyLocked(context, projectId, { target, base, incoming, kind, source = {}, mode, labels, incomingRoot = null, notMerged = [], cleanOnly = false, initiator }) {
    let last = null;
    for (let attempt = 1; attempt <= (mode === 'all' ? LIMITS.writeAllAttempts : 1); attempt++) {
      const before = await takeSnapshot(context, target);
      const mid = hex(8);
      const merged = await mergeTrees(context, { base, current: before.tree, incoming }, { mid, labels, root: incomingRoot, notMerged });
      const outcome = { status: 'nothing', applyId: null, mid, before: before.commit, result: merged.tree, written: [], removed: [], conflicts: merged.conflicts, notMerged: merged.notMerged, bothChanged: merged.bothChanged, verify: null, dependencies: false };
      let plan = merged.writes.map(row => ({ path: row.path, expect: row.expect ?? null, next: row.delete ? null : { mode: row.mode, oid: row.oid } }));
      if (mode === 'all' && merged.conflicts.length && !cleanOnly) return { ...outcome, status: 'conflicted' };
      if (mode === 'markers') {
        const marked = await mergeEntries(context, merged.tree, merged.conflicts.filter(row => row.kind === 'content' && row.marked).map(row => row.path));
        for (const conflict of merged.conflicts) if (conflict.kind === 'content' && conflict.marked) plan.push({ path: conflict.path, expect: conflict.current ?? null, next: { mode: marked.get(conflict.path)?.mode ?? conflict.current?.mode ?? '100644', oid: conflict.marked } });
      }
      if (!plan.length) return { ...outcome, status: merged.conflicts.length ? 'conflicted' : 'nothing' };
      const written = await this.recordedWrite(context, projectId, target, before, plan, { kind, source, mode, cleanOnly, bothChanged: merged.bothChanged, extra: initiatedBy(initiator) });
      const result = written.outcome;
      if (mode === 'all' && result.rolledBack) {
        last = { ...outcome, status: 'blocked', applyId: written.applyId, written: result.written, removed: result.removed };
        if (written.applyId) return last;
        continue;
      }
      const conflicts = [...merged.conflicts, ...result.conflicts.map(row => ({ ...row, ...entriesOf(plan, row.path) }))];
      const paths = [...result.written, ...result.removed];
      return { ...outcome, status: conflicts.length ? 'conflicted' : paths.length ? 'applied' : 'nothing', applyId: written.applyId, written: result.written, removed: result.removed, conflicts, verify: written.applyId ? result.verify : null, ...(result.mismatched.length ? { mismatched: result.mismatched } : {}), dependencies: paths.some(path => DEPENDENCY_FILES.includes(basename(path))) };
    }
    return last;
  }

  /**
   * One conflict's diff3 for `agent_merge`: `merge` previews (page omitted: LIMITS.previewBytes, cut at whole lines)
   * and `show` pages (LIMITS.showLinesPerPage lines).
   * @param {string} projectId
   * @param {Conflict} conflict  from a MergeResult or ApplyOutcome (text conflicts carry `marked`)
   * @param {{ page?: number }} [options]
   * @returns {Promise<{ text: string, truncated: boolean, page: number, pages: number }>}
   */
  async diff3(projectId, conflict, { page } = {}) {
    const context = await this.context(projectId);
    if (page === undefined || page === null) { const cut = await preview(context, conflict); return { ...cut, page: 1, pages: 1 }; }
    const paged = await show(context, conflict, { page });
    return { text: paged.text, truncated: paged.page < paged.pages, page: paged.page, pages: paged.pages };
  }

  /**
   * `agent_merge` take and the cards' "use this version" (design §4.1, §4.2, §4.3): write one side of listed
   * conflicts with CAS (side `current` writes nothing and only marks the path taken), as a `resolve` record.
   * USER_ONLY_CONFLICTS kinds are refused with `merge_take_denied` unless `byUser` (a card answer).
   * @param {string} projectId
   * @param {{ target: RootInfo, items: { conflict: Conflict, side: 'current'|'incoming' }[], source: object, byUser?: boolean, signal?: AbortSignal, onWaiting?: (operation: string) => void, hold?: boolean }} request
   *   `signal` / `onWaiting` / `hold` as for apply(): a P target waits for a git operation in progress there, or
   *   with `hold` refuses at once (`git_operation_in_progress`).
   * @returns {Promise<ApplyOutcome & { taken: string[] }>}
   */
  async take(projectId, { target, items, source = {}, byUser = false, signal, onWaiting, hold = false } = {}) {
    if (!Array.isArray(items) || !items.length || items.length > LIMITS.takeItems) throw engineError('merge_path_not_conflicted', `Take 1–${LIMITS.takeItems} conflicts at a time.`);
    for (const item of items) {
      if (!item?.conflict?.path || !['current', 'incoming'].includes(item.side)) throw engineError('merge_path_not_conflicted', 'Each take names a listed conflict and a side.');
      if (USER_ONLY_CONFLICTS.includes(item.conflict.kind) && !byUser) throw engineError('merge_take_denied', `${item.conflict.path}: a ${item.conflict.kind} conflict is left to the user.`);
    }
    await this.recovering?.catch(() => {});
    const context = await this.context(projectId);
    this.checkRoot(context, target);
    for (;;) {
      if (target.kind === 'project') await this.waitForProject(projectId, context, { signal, onWaiting, hold });
      aborted(signal);
      // A git operation that started while this take waited for the lock: wait again outside it (or refuse, `hold`).
      const result = await this.lock(projectId, async () => (target.kind === 'project' && await context.git.operation(context.located.gitDir) ? null : this.takeLocked(context, projectId, { target, items, source, signal })));
      if (result) return result;
    }
  }

  async takeLocked(context, projectId, { target, items, source, signal }) {
    aborted(signal);
    const before = await takeSnapshot(context, target), changes = [], left = [];
    for (const { conflict, side } of items) {
      if (side !== 'incoming') continue;
      // Even on the user's word, a link leaving the folder (or into .git) and a gitlink are never written: the
      // card's "this version" is about content, not about planting such an entry (it stays a conflict).
      if (NEVER_TAKEN.includes(conflict.kind)) { left.push({ path: conflict.path, kind: conflict.kind }); continue; }
      const path = toTree(context, conflict.path), incoming = conflict.incoming;
      if (!incoming) { changes.push({ path, delete: true }); continue; }
      if (incoming.mode === '040000') {
        changes.push({ path, delete: true });
        const listed = await objects(context, ['ls-tree', '-r', '-z', incoming.oid], { maxBytes: LIST_OUTPUT });
        for (const record of listed.stdout.split('\0')) { const match = /^(\d{6}) \w+ ([0-9a-f]+)\t([\s\S]*)$/.exec(record); if (match) changes.push({ path: `${path}/${match[3]}`, mode: match[1], oid: match[2] }); }
        continue;
      }
      changes.push({ path, mode: incoming.mode, oid: incoming.oid });
    }
    const desired = await composeTree(context, before.tree, changes);
    let plan = (await diffTrees(context, before.tree, desired)).map(change => ({ path: toRoot(context, change.path), expect: change.old, next: change.next })).filter(entry => entry.path !== null);
    // A side taken may carry a link of its own (an add/add, a folder of a type conflict): one that leaves the folder
    // (resolved through the links of what the folder would hold) is not written either.
    const links = plan.filter(entry => entry.next?.mode === '120000');
    if (links.length) {
      const lookups = new Map(), texts = new Map();
      const entryAt = async local => { const path = toTree(context, local); if (!lookups.has(path)) lookups.set(path, (await lsTree(context, desired, [path])).get(path) ?? null); return lookups.get(path); };
      const textOf = async oid => { if (!texts.has(oid)) texts.set(oid, (await readBlobs(context, [oid])).get(oid)?.toString('utf8') ?? ''); return texts.get(oid); };
      for (const entry of links) if (await linkEscapes(entry.path, await textOf(entry.next.oid), { entryAt, textOf })) left.push({ path: entry.path, kind: 'unsafe_symlink' });
      plan = plan.filter(entry => !left.some(row => row.path === entry.path));
    }
    const taken = items.map(item => item.conflict.path).filter(path => !left.some(row => row.path === path || row.path.startsWith(`${path}/`)));
    const base = { status: left.length ? 'conflicted' : 'nothing', applyId: null, mid: null, before: before.commit, result: desired, written: [], removed: [], conflicts: left, notMerged: [], bothChanged: 0, verify: null, dependencies: false, taken };
    if (!plan.length) return base;
    const written = await this.recordedWrite(context, projectId, target, before, plan, { kind: 'resolve', source, mode: 'partial' });
    const result = written.outcome, paths = [...result.written, ...result.removed], conflicts = [...left, ...result.conflicts.map(row => ({ ...row, ...entriesOf(plan, row.path) }))];
    return { ...base, status: conflicts.length ? 'conflicted' : 'applied', applyId: written.applyId, written: result.written, removed: result.removed, conflicts, verify: written.applyId ? result.verify : null, dependencies: paths.some(path => DEPENDENCY_FILES.includes(basename(path))), taken: taken.filter(path => !result.conflicts.some(row => row.path === path)) };
  }

  /**
   * The sha256 (lowercase hex) of a file's bytes in a root, or null when it does not exist: the `currentSha256`
   * of a conflict, which project_edit / project_write accept as `expectedHash`.
   * @param {RootInfo} root
   * @param {string} path
   * @returns {Promise<string|null>}
   */
  async fileSha256(root, path) {
    const file = await checkWritePath(root.root, path);
    try { return createHash('sha256').update(await readFile(file)).digest('hex'); }
    catch (error) { if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return null; throw error; }
  }

  /**
   * `agent_merge` resolved and the session's second finish (design §4.1, §4.2 step 6), computed by code only: each
   * listed path must differ from its `currentSha256` (or have been taken) and hold no marker line of merge `mid`
   * (hasMergeMarkers).
   * @param {string} projectId
   * @param {{ target: RootInfo, mid: string, conflicts: { path: string, currentSha256: string|null, taken?: boolean }[] }} request
   * @returns {Promise<{ resolved: boolean, remaining: { path: string, reason: 'unchanged'|'markers' }[] }>}
   */
  async resolved(projectId, { target, mid, conflicts = [] } = {}) {
    const context = await this.context(projectId);
    this.checkRoot(context, target);
    const remaining = [];
    for (const conflict of conflicts) {
      const sha = await this.fileSha256(target, conflict.path);
      if (!conflict.taken && sha === (conflict.currentSha256 ?? null)) { remaining.push({ path: conflict.path, reason: 'unchanged' }); continue; }
      if (sha === null) continue;
      const text = await readFile(join(target.root, ...conflict.path.split('/')), 'utf8').catch(() => '');
      if (hasMergeMarkers(text, mid)) remaining.push({ path: conflict.path, reason: 'markers' });
    }
    return { resolved: remaining.length === 0, remaining };
  }

  /** Validate the body of a rollback request. */
  rollbackInput(input = {}) {
    const bad = () => this.fail('rollback_request_invalid', { zh: '回退请求只能包含 paths、force 和 confirm。', en: 'A rollback request may only contain paths, force and confirm.' }, { status: 400 });
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['paths', 'force', 'confirm'].includes(key))) bad();
    const list = value => { if (value === undefined || value === null) return null; if (!Array.isArray(value) || value.length > 500 || value.some(item => typeof item !== 'string' || !item || item.length > 4096)) bad(); return [...new Set(value)].sort(); };
    if (input.confirm !== undefined && input.confirm !== null && typeof input.confirm !== 'string') bad();
    return { paths: list(input.paths), force: list(input.force) ?? [], confirm: input.confirm ?? null };
  }

  /** Rollback and discard are user actions that need the project's foreground write permission (design §5.2). */
  writableProject(projectId) {
    const project = this.projectRow(projectId);
    if (project.archivedAt) this.fail('project_archived', { zh: '项目已归档，请先恢复。', en: 'This project is archived. Restore it first.' }, { status: 409 });
    if (!toolPermitted(project, { permission: 'write' }, 'foreground')) this.fail('git_read_only', { zh: '这个项目现在是只读的，不能回退文件。可以在项目权限里改成可写。', en: 'This project is read-only, so files can’t be rolled back. You can allow writing in the project’s permissions.' }, { status: 403 });
    return project;
  }

  /**
   * POST …/applies/:applyId/rollback — two steps (design §5.2). Without `confirm`: a RollbackPreview, nothing
   * changes. With it: the rollback, recorded as kind `rollback` with `undoes`. Refused: unknown record
   * (`apply_not_found`), expired (`apply_expired`), a target other than the project folder (`apply_target_denied`),
   * a stale token (`rollback_unconfirmed`), files changed since the first step (`rollback_changed`), nothing left to
   * restore (`rollback_nothing`), git operation in progress (`git_operation_in_progress`), read-only project
   * (`git_read_only`, 403).
   * @param {string} projectId
   * @param {string} applyId
   * @param {{ paths?: string[], force?: string[], confirm?: string }} [input]
   * @param {{ initiator?: 'user'|'agent'|'host' }} [options]  who asked (recorded as the rollback's `initiator`; the
   *   routes and card answers pass 'user', the model's agent_merge drop 'agent'), never taken from `input`
   * @returns {Promise<RollbackPreview|RollbackResult>}
   */
  async rollback(projectId, applyId, input, { initiator } = {}) {
    return this.human(async () => {
      const request = this.rollbackInput(input), project = this.writableProject(projectId), row = applyRow(project, applyId);
      if (!row) this.fail('apply_not_found', { zh: '找不到这条应用记录。', en: 'That apply record can’t be found.' });
      if (row.state === 'expired') this.fail('apply_expired', { zh: '这条记录已过期，不能回退。', en: 'This record has expired and can’t be rolled back.' });
      if (row.target !== APPLY_TARGET.project) this.fail('apply_target_denied', { zh: '只有写进项目文件夹的记录可以回退。', en: 'Only records written into the project folder can be rolled back.' });
      if (['writing', 'interrupted'].includes(row.state)) this.fail('apply_blocked', { zh: '这次应用中断了，请先在卡片上选择完成或回到应用前。', en: 'This apply was interrupted. Choose complete or restore on its card first.' });
      // Rolled back already: only the files that rollback skipped can still be restored (force). A second three-way
      // rollback of the rest would take out what the user wrote again since (the same lines read as this record's).
      const forceOnly = row.state === 'rolled_back' || Boolean(row.rolledBackBy);
      // The rollback keeps the whole owner of what it undoes (a background run's actionId, a worker's agentId), so a
      // single-record background revert is not recorded with an empty source.
      return this.rollbackFlow(projectId, { key: `apply:${applyId}`, applies: [row], forceOnly, source: ownerSource(row.source), extra: { undoes: applyId, ...initiatedBy(initiator) } }, request);
    });
  }

  /**
   * POST /api/v2/projects/:id/turns/:turnId/rollback — a whole turn: a worktree session's turn rolls back its turn
   * records and the resolve records its conflict card wrote into P (take of "this conversation's version"), newest
   * first, as one rollback record; a direct-mode turn rolls back REFS.turn(turnId) limited to `attributable()` plus
   * that turn's worker and resolve records. No checkpoint → `turn_checkpoint_missing`. Same two steps and errors as
   * rollback(); the preview of a direct-mode turn carries the `note` about other writers.
   * @returns {Promise<RollbackPreview|RollbackResult>}
   */
  async rollbackTurn(projectId, turnId, input, { initiator } = {}) {
    return this.human(async () => {
      const request = this.rollbackInput(input), project = this.writableProject(projectId);
      const mine = applyRows(project, { turnId }).filter(row => row.target === APPLY_TARGET.project && row.state !== 'rolled_back');
      // A worktree session's turn: the `turn` records its hand-backs wrote, and the `resolve` records its conflict card
      // wrote (engine.take, source naming the session's worktree) — rolled back together, as direct mode's `also`.
      // A resolve that itself undid a record (an interrupted apply's "go back to before", `undoes`) is a rollback in
      // effect: rolling it back would bring that write back, so it stays out.
      const sessionTrees = new Set((project.git?.worktrees ?? []).filter(row => row.kind === 'session').map(row => row.id));
      const worktreeTurn = mine.some(row => row.kind === 'turn') || mine.some(row => row.kind === 'resolve' && sessionTrees.has(row.source?.worktreeId));
      const rows = worktreeTurn ? mine.filter(row => row.kind === 'turn' || (row.kind === 'resolve' && !row.undoes)) : [];
      const sessionId = rows[0]?.source?.sessionId ?? this.store.state.sessions.find(session => session.projectId === projectId && session.turns?.some(turn => turn.id === turnId))?.id;
      const source = { ...(sessionId ? { sessionId } : {}), turnId }, extra = { undoesTurn: turnId, ...initiatedBy(initiator) };
      if (rows.length) {
        if (rows.some(row => row.state === 'expired')) this.fail('apply_expired', { zh: '这一轮的记录已过期，不能回退。', en: 'This turn’s records have expired and can’t be rolled back.' });
        // As for one record: a write still going on, or cut off and waiting on its card, is settled first (its ref
        // holds the planned result, not what was written).
        if (rows.some(row => ['writing', 'interrupted'].includes(row.state))) this.fail('apply_blocked', { zh: '这一轮有一次应用还没完成或中断了，请先等它完成，或在卡片上选择完成或回到应用前。', en: 'An apply of this turn is still going on or was interrupted. Wait for it, or choose complete or restore on its card first.' });
        return this.rollbackFlow(projectId, { key: `turn:${turnId}`, applies: rows, source, extra }, request);
      }
      if (typeof this.attributable !== 'function') this.fail('turn_checkpoint_missing', { zh: '这一轮没有检查点，不能整轮回退。', en: 'This turn has no checkpoint, so it can’t be rolled back as a whole.' });
      const own = await this.attributable(projectId, turnId);
      if (!own?.start || !own?.end) this.fail('turn_checkpoint_missing', { zh: '这一轮没有检查点，不能整轮回退。', en: 'This turn has no checkpoint, so it can’t be rolled back as a whole.' });
      const note = this.say({ zh: '同一时间在这个文件夹里的其他写入无法区分；不想回退的文件可以取消勾选。', en: 'Other writes into this folder at the same time can’t be told apart; untick any file you want to keep.' });
      // This turn's worker merges and conflict resolutions written while it ran are inside its checkpoint: rolled back
      // with it. One written after the turn ended (a background worker that finished later) is outside [start, end]:
      // the rollback does not touch its files, so it stays in effect and can still be rolled back on its own. An
      // attempt cut off by a restart ends where the next one began.
      const windows = Array.isArray(own.windows) && own.windows.length ? own.windows : null;
      const inside = row => !windows || windows.some(([from, to], index) => { const at = Date.parse(row.at); return at >= from && at <= (to ?? windows[index + 1]?.[0] ?? Number.MAX_SAFE_INTEGER); });
      const also = applyRows(project, { turnId }).filter(row => ['worker', 'resolve'].includes(row.kind) && row.target === APPLY_TARGET.project && ['verified', 'unverified'].includes(row.state) && !row.rolledBackBy && !row.undoes && inside(row));
      return this.rollbackFlow(projectId, { key: `turn:${turnId}`, also, turn: { id: turnId, start: own.start, end: own.end, paths: own.paths ?? [], excluded: own.excluded ?? [] }, source, extra, note }, request);
    });
  }

  /**
   * Several records rolled back as one (additive; a background change set written into P by more than one apply —
   * its clean part, then a card's "background's version", a conversation's agent_merge take): every record still in
   * effect among `applyIds` that wrote into the project folder, newest first, as one rollback record that one undo
   * restores, as a worktree turn's. Records written into a worktree are not P's to roll back and are left out. Same
   * two steps and refusals as rollback(); `key` binds the token (default: the ids).
   * @param {string} projectId
   * @param {string[]} applyIds
   * @param {{ paths?: string[], force?: string[], confirm?: string }} [input]
   * @param {{ key?: string, source?: object, initiator?: 'user'|'agent'|'host' }} [options]
   * @returns {Promise<RollbackPreview|RollbackResult>}
   */
  async rollbackRecords(projectId, applyIds, input, { key, source = {}, initiator } = {}) {
    return this.human(async () => {
      const request = this.rollbackInput(input), project = this.writableProject(projectId), ids = new Set((Array.isArray(applyIds) ? applyIds : []).filter(id => typeof id === 'string'));
      const listed = applyRows(project).filter(row => ids.has(row.id));
      if (!listed.length) this.fail('apply_not_found', { zh: '找不到这些应用记录。', en: 'Those apply records can’t be found.' });
      const mine = listed.filter(row => row.target === APPLY_TARGET.project);
      if (!mine.length) this.fail('apply_target_denied', { zh: '只有写进项目文件夹的记录可以回退。', en: 'Only records written into the project folder can be rolled back.' });
      const rows = mine.filter(row => row.state !== 'rolled_back' && !row.rolledBackBy);
      if (!rows.length) this.fail('rollback_nothing', { zh: '这些改动已经回退过了。', en: 'These changes were already rolled back.' });
      if (rows.some(row => row.state === 'expired')) this.fail('apply_expired', { zh: '其中有记录已过期，不能回退。', en: 'Some of these records have expired and can’t be rolled back.' });
      if (rows.some(row => ['writing', 'interrupted'].includes(row.state))) this.fail('apply_blocked', { zh: '其中有一次应用还没完成或中断了，请先等它完成，或在卡片上选择完成或回到应用前。', en: 'One of these applies is still going on or was interrupted. Wait for it, or choose complete or restore on its card first.' });
      return this.rollbackFlow(projectId, { key: key ?? `records:${[...ids].sort().join(',')}`, applies: rows, source: structuredClone(source ?? {}), extra: initiatedBy(initiator) }, request);
    });
  }

  async rollbackFlow(projectId, { key, applies = [], also = [], turn = null, source, extra, note, forceOnly = false }, { paths, force, confirm }) {
    await this.mergeCapable();
    const context = await this.context(projectId), root = this.projectRoot(context);
    const busy = async () => { if (await context.git.operation(context.located.gitDir)) this.fail('git_operation_in_progress', { zh: '项目文件夹正在进行 Git 操作（合并、变基等），完成后再回退。', en: 'A Git operation (merge, rebase, …) is in progress in the project folder. Roll back after it finishes.' }); };
    await busy();
    if (!confirm) {
      const now = await takeSnapshot(context, root);
      const planned = await planRollback(context, { applies, turn }, { current: now.tree, paths, forceOnly });
      if (!planned.files.length && !planned.skipped.length) this.fail('rollback_nothing', { zh: '没有需要还原的文件：这些改动已经不在了。', en: 'Nothing to restore: these changes are no longer there.' });
      const token = this.tokens.issue({ projectId, key, paths, fingerprint: planned.fingerprint });
      return { ...token, files: planned.files, skipped: planned.skipped, ...(note ? { note } : {}) };
    }
    const issued = this.tokens.take(confirm);
    if (!issued || issued.projectId !== projectId || issued.key !== key || JSON.stringify(issued.paths) !== JSON.stringify(paths)) this.fail('rollback_unconfirmed', { zh: '这次确认已经失效，请重新点一次回退。', en: 'This confirmation has expired. Click roll back again.' });
    // A git operation that began since the check above refuses too: a rollback never waits for one.
    await this.waitForProject(projectId, context, { hold: true });
    return this.lock(projectId, async () => {
      await busy();
      const now = await takeSnapshot(context, root);
      const planned = await planRollback(context, { applies, turn }, { current: now.tree, paths, force, forceOnly });
      if (planned.fingerprint !== issued.fingerprint) this.fail('rollback_changed', { zh: '确认之后这些文件又变了，没有回退。请重新确认。', en: 'These files changed after you confirmed, so nothing was rolled back. Confirm again.' });
      if (!planned.plan.length) this.fail('rollback_nothing', { zh: '没有需要还原的文件。', en: 'Nothing to restore.' });
      // `partial`: the user restored only some files (`paths`); the records it undid stay in effect for the rest.
      // `skipped`: the files the plan left as they were (changed afterwards, a conflict, another writer's), on the row
      // too, so what is derived from it (the models' "the user undid X", workspace-events.mjs) does not read as a
      // complete undo while those files still carry the change. The first SKIPPED_ON_ROW; the answer lists them all.
      const written = await this.recordedWrite(context, projectId, root, now, planned.plan, { kind: 'rollback', source, mode: 'all', extra: { ...extra, ...(paths ? { partial: true } : {}) }, skipped: planned.skipped.slice(0, SKIPPED_ON_ROW) });
      if (!written.applyId || written.outcome.rolledBack) this.fail('rollback_changed', { zh: '回退时这些文件正在被改动，没有回退。请重新确认。', en: 'These files were changing during the rollback, so nothing was rolled back. Confirm again.' });
      this.store.mutate(state => {
        const rows = gitOf(state.projects.find(row => row.id === projectId)).applies;
        // Only a whole rollback settles its records: after one of some files, the rest can still be rolled back.
        for (const undone of paths ? [] : [...applies, ...also]) {
          const row = rows.find(item => item.id === undone.id);
          if (!row || row.state === 'rolled_back') continue;
          Object.assign(row, { state: 'rolled_back', rolledBackBy: written.applyId });
          // Undoing a rollback brings back what it had rolled back.
          if (row.kind === 'rollback') for (const original of rows) if (original.rolledBackBy === row.id) { delete original.rolledBackBy; original.state = 'verified'; }
        }
      });
      return { applyId: written.applyId, restored: [...written.outcome.written, ...written.outcome.removed], skipped: planned.skipped, verify: written.outcome.verify };
    });
  }

  /**
   * A record written into a worktree (S or B) that its owner rolled back there with apply(kind 'rollback'), e.g. a
   * dropped worker that was merged into a conversation's worktree: the row becomes `rolled_back` (`rolledBackBy` the
   * rollback's record when that wrote anything) and the rollback record gets `undoes`, so the history reads as it does
   * for P and a repeated drop does nothing. Records of P are settled by rollback() itself and are left alone here.
   * Additive to the contract.
   * @param {string} projectId
   * @param {string} applyId  the record rolled back
   * @param {{ by?: string|null }} [options]  the rollback's apply id (null when it wrote nothing)
   * @returns {ApplyRow|null}  the row as settled, null when there is none (or it is a record of P)
   */
  markRolledBack(projectId, applyId, { by = null } = {}) {
    const row = applyRow(this.projectRow(projectId), applyId);
    if (!row || row.target === APPLY_TARGET.project) return null;
    this.store.mutate(state => {
      const rows = gitOf(state.projects.find(item => item.id === projectId)).applies;
      const undone = rows.find(item => item.id === applyId);
      if (undone && !['rolled_back', 'expired'].includes(undone.state)) { undone.state = 'rolled_back'; if (by) undone.rolledBackBy = by; }
      const rollback = by ? rows.find(item => item.id === by) : null;
      if (rollback?.kind === 'rollback' && !rollback.undoes) rollback.undoes = applyId;
    });
    return structuredClone(applyRow(this.projectRow(projectId), applyId));
  }

  /**
   * GET /api/v2/projects/:id/applies — records newest first (protocol §8.7 `ApplyRecord`).
   * @param {string} projectId
   * @param {{ sessionId?: string, turnId?: string, limit?: number }} [filter]
   * @returns {{ applies: object[] }}
   */
  applies(projectId, { sessionId, turnId, limit = 50 } = {}) {
    const project = this.projectRow(projectId);
    return { applies: applyRows(project, { sessionId, turnId, limit: Math.max(1, Math.min(LIMITS.appliesPerProject, Number(limit) || 50)) }).map(applyView) };
  }

  /** A record that still has its checkpoint: the row, the context and its before / after commits. */
  async recordWithCommits(projectId, applyId) {
    const project = this.projectRow(projectId), row = applyRow(project, applyId);
    if (!row) this.fail('apply_not_found', { zh: '找不到这条应用记录。', en: 'That apply record can’t be found.' });
    if (row.state === 'expired') this.fail('apply_expired', { zh: '这条记录已过期。', en: 'This record has expired.' });
    const context = await this.context(projectId), commits = await recordCommits(context, applyId);
    if (!commits) this.fail('apply_expired', { zh: '这条记录的检查点已经不在了。', en: 'This record’s checkpoint is gone.' });
    return { row, context, commits };
  }

  /**
   * GET …/applies/:applyId — the record with its files (before → after, numstat).
   * @returns {Promise<object>}  protocol §8.7 `ApplyDetail`
   */
  async applyDetail(projectId, applyId) {
    return this.human(async () => {
      const { row, context, commits } = await this.recordWithCommits(projectId, applyId);
      const { files, truncated } = await this.filesBetween(context, commits.before, commits.after);
      return { ...applyView(row), paths: files, ...(truncated ? { truncated: true } : {}) };
    });
  }

  /**
   * The files that differ between two commits or trees (name-status + numstat, renames found, root paths), as an
   * ApplyDetail's `paths`. `paths` (root paths) limits it, read as literal paths.
   * @returns {Promise<{ files: { path: string, oldPath?: string, status: string, added: number|null, removed: number|null, binary?: true }[], truncated: boolean }>}
   */
  async filesBetween(context, before, after, { paths } = {}) {
    const prefix = context.located.prefix ?? '', relative = prefix ? [`--relative=${prefix}`] : [];
    const limit = paths?.length ? ['--', ...paths.map(path => toTree(context, path))] : [];
    const args = format => ['diff-tree', '-r', '-z', format, ...relative, ...DIFF_FLAGS, before, after, ...limit];
    const options = limit.length ? { env: { GIT_LITERAL_PATHSPECS: '1' } } : {};
    const [names, counts] = await Promise.all([objects(context, args('--name-status'), options), objects(context, args('--numstat'), options)]);
    const whole = result => (result.truncated ? result.stdout.slice(0, result.stdout.lastIndexOf('\0') + 1) : result.stdout);
    const files = withCounts(parseNameStatus(whole(names)), parseNumstat(whole(counts))).map(file => ({ added: null, removed: null, ...file }));
    return { files, truncated: Boolean(names.truncated || counts.truncated) };
  }

  /** The renames between two commits or trees, as filesBetween finds them: Map root path → the root path it came from. */
  async renamesBetween(context, before, after) {
    const prefix = context.located.prefix ?? '';
    const names = await objects(context, ['diff-tree', '-r', '-z', '--name-status', ...(prefix ? [`--relative=${prefix}`] : []), ...DIFF_FLAGS, before, after]);
    const whole = names.truncated ? names.stdout.slice(0, names.stdout.lastIndexOf('\0') + 1) : names.stdout;
    return new Map(parseNameStatus(whole).filter(file => file.oldPath).map(file => [file.path, file.oldPath]));
  }

  /** Validate a patches request's paths: 1–40 distinct project paths. */
  patchPaths(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 40 || paths.some(path => typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0'))) this.fail('git_paths_invalid', { zh: '一次需要 1–40 个文件。', en: 'Choose 1–40 files at a time.' }, { status: 400 });
    return [...new Set(paths)];
  }

  /**
   * GET …/applies/:applyId/patches?path= — before → after patches, cut like the panel's (splitPatch, byte caps).
   * @returns {Promise<{ patches: { path: string, diff: object }[] }>}
   */
  async applyPatches(projectId, applyId, { paths } = {}) {
    return this.human(async () => {
      const unique = this.patchPaths(paths);
      const { context, commits } = await this.recordWithCommits(projectId, applyId);
      // A renamed file's patch is the rename's: its old path goes into the pathspec with it.
      const diffs = await this.patchesBetween(context, commits.before, commits.after, unique, { oldPaths: await this.renamesBetween(context, commits.before, commits.after) });
      return { patches: unique.map(path => ({ path, diff: diffs.get(path) })) };
    });
  }

  /**
   * One `git diff before after -- paths` cut into per-path GitDiffs (splitPatch, the panel's byte and time caps): Map
   * path → GitDiff. `oldPaths` (path → the path it was renamed from) puts a renamed file's old path in the pathspec
   * too, so git pairs the two and the patch is the rename's, keyed by the new path, not the whole file added.
   */
  async patchesBetween(context, before, after, paths, { oldPaths = null } = {}) {
    const git = context.git, prefix = context.located.prefix ?? '';
    const renamed = paths.map(path => oldPaths?.get(path)).filter(path => typeof path === 'string' && path && !paths.includes(path));
    const result = await objects(context, ['-c', 'core.quotePath=false', 'diff', ...(prefix ? [`--relative=${prefix}`] : []), ...DIFF_FLAGS, '--src-prefix=a/', '--dst-prefix=b/', before, after, '--', ...[...paths, ...new Set(renamed)].map(path => toTree(context, path))], { maxBytes: git.diffMaxBytes, timeoutMs: git.diffTimeoutMs, env: { GIT_LITERAL_PATHSPECS: '1' } });
    const sections = new Map(), parts = splitPatch(result.stdout), partial = result.truncated || result.timedOut || result.code !== 0;
    parts.forEach((part, index) => { if (part.path !== null) sections.set(part.path, { patch: (sections.get(part.path)?.patch ?? '') + part.patch, cut: partial && index === parts.length - 1 }); });
    const unavailable = reason => ({ kind: 'unavailable', reason, message: this.say(reason === 'timed_out' ? { zh: 'Git 响应太慢，稍后再试。', en: 'Git took too long to answer. Try again shortly.' } : { zh: 'Git 没能读取这些改动。', en: 'Git couldn’t read these changes.' }) });
    return new Map(paths.map(path => {
      const section = sections.get(path);
      if (!section) return [path, result.timedOut ? unavailable('timed_out') : result.code !== 0 && !result.truncated ? unavailable('git_failed') : { kind: 'patch', patch: '' }];
      if (section.cut) return [path, result.truncated ? { kind: 'truncated', patch: wholeLines(section.patch) } : unavailable(result.timedOut ? 'timed_out' : 'git_failed')];
      return [path, BINARY_PATCH.test(section.patch) ? { kind: 'binary' } : { kind: 'patch', patch: section.patch }];
    }));
  }

  /**
   * GET /api/v2/projects/:id/turns/:turnId/changes?sessionId= — what one turn changed in the project folder, file by
   * file, computed by the host instead of adding up the turn's edit snippets (a snippet diff counts what the call
   * replaced, not what reached the file: a conflict merged by a continuation summed its marker lines too, and a worker's
   * merge has no edit call at all). Reads only: it never starts work and never takes the repository lock.
   * - A worktree conversation's turn whose apply is `applied`: the records rollbackTurn rolls back (its `turn` records
   *   into the project folder and the `resolve` records without `undoes`), rolled-back ones included. A path is composed
   *   across them by entry: when record k's after is record k+1's before, the file shows the first before → the last
   *   after (`source: 'records'`); otherwise someone else changed it in between, and each record is a section of its
   *   own (`changedBetween`).
   * - A direct-mode turn whose checkpoint is `taken`: start → end limited to attributable() — its worker merges and
   *   conflict resolutions inside its window are in it (`source: 'checkpoint'`); paths its write tools wrote that no
   *   snapshot holds (ignored, over the size limit) are listed in `uncovered`. A path no call or record of the turn
   *   wrote by name only changed while it ran (the user's editor, another conversation in the folder): it is left out,
   *   or — when the turn ran a call that may write files it does not name, a command say — listed with
   *   `unattributed: true`. A path the turn wrote that another owner's record also wrote while it ran cannot be told
   *   apart in the diff: it is listed in `shared` ({ path, applyId } of that record) rather than dropping out of view.
   * - Anything else answers `{ source: 'tools', reason }` and the web keeps adding up the turn's tool calls: a pending
   *   or conflicted worktree turn, no apply record, a skipped or expired checkpoint, plan mode, an archived project, no
   *   repository; git away or failing this time (`git_unavailable`, `unreadable`: not kept, asked again next time).
   * A file a rollback restored says `rolledBack`: a rollback of the whole turn wrote it, or each record of the turn that
   * wrote it was rolled back (a later record rolled back alone leaves an earlier one's part standing). A renamed file
   * is `R` with its `oldPath`, and its patch is the rename's. Unknown turn: 404 `turn_not_found`.
   * @param {string} projectId
   * @param {string} turnId
   * @param {{ sessionId?: string }} [options]
   * @returns {Promise<{ source: 'records'|'checkpoint', files: object[], applyIds?: string[], uncovered?: string[], shared?: { path: string, applyId: string }[], truncated?: true } | { source: 'tools', reason: string }>}
   */
  async turnChanges(projectId, turnId, { sessionId } = {}) {
    return this.human(async () => {
      const plan = await this.turnPlan(projectId, turnId, { sessionId });
      if (plan.source === 'tools') return { source: 'tools', reason: plan.reason };
      return { source: plan.source, files: plan.files, ...(plan.applyIds ? { applyIds: plan.applyIds } : {}), ...(plan.uncovered?.length ? { uncovered: plan.uncovered } : {}), ...(plan.shared?.length ? { shared: plan.shared } : {}), ...(plan.truncated ? { truncated: true } : {}) };
    });
  }

  /**
   * GET …/turns/:turnId/changes/patches?sessionId=&path=… — 1–40 of those files' patches: `{ path, diff }` for a
   * composed file (GitDiff, cut like applyPatches), `{ path, sections: [{ applyId, rolledBack?, diff }] }` for a file
   * someone else changed between this turn's records. A turn the host answers `tools` for: 409
   * `turn_changes_unavailable` (with `reason`).
   */
  async turnPatches(projectId, turnId, { sessionId, paths } = {}) {
    return this.human(async () => {
      const unique = this.patchPaths(paths);
      const plan = await this.turnPlan(projectId, turnId, { sessionId });
      if (plan.source === 'tools') this.fail('turn_changes_unavailable', { zh: '这一轮的改动只能从工具调用里看。', en: 'This turn’s changes can only be read from its tool calls.' }, { status: 409, reason: plan.reason });
      const composed = unique.filter(path => !plan.sections.has(path));
      const oldPaths = new Map(plan.files.filter(file => file.oldPath).map(file => [file.path, file.oldPath]));
      const diffs = composed.length ? await this.patchesBetween(plan.context, plan.before, plan.after, composed, { oldPaths }) : new Map();
      const patches = [];
      for (const path of unique) {
        const sections = plan.sections.get(path);
        if (!sections) { patches.push({ path, diff: diffs.get(path) }); continue; }
        patches.push({ path, sections: await Promise.all(sections.map(async section => ({ applyId: section.applyId, ...(section.rolledBack ? { rolledBack: true } : {}), diff: (await this.patchesBetween(plan.context, section.before, section.after, [path])).get(path) }))) });
      }
      return { patches };
    });
  }

  /**
   * What turnChanges / turnPatches answer from: `{ source: 'tools', reason }`, or the files with what their patches
   * are read between (`context`, `before` / `after` for composed files, `sections` path → [{ applyId, before, after,
   * rolledBack }] for the rest). Kept briefly in memory, keyed by everything it depends on that can still change.
   */
  async turnPlan(projectId, turnId, { sessionId } = {}) {
    const project = this.projectRow(projectId), state = this.store.state;
    const session = state.sessions.find(row => row.projectId === projectId && (!sessionId || row.id === sessionId) && row.turns?.some(turn => turn.id === turnId));
    const turn = session?.turns.find(row => row.id === turnId);
    if (!turn) this.fail('turn_not_found', { zh: '找不到这一轮。', en: 'That turn can’t be found.' }, { status: 404 });
    const tools = reason => ({ source: 'tools', reason });
    // An archived project refuses git reads; plan mode is read only; a turn still running has nothing settled to show.
    if (project.archivedAt) return tools('archived');
    if (turn.mode === 'plan') return tools('plan');
    if (['running', 'queued', 'pending'].includes(turn.status)) return tools('running');
    const rows = applyRows(project, { turnId });
    // Rollbacks still in effect that undid this turn or some of its writes (one record, or several settled as one,
    // `rolledBackBy`); an undone rollback, or one undoing a rollback, is not.
    const undoing = (project.git?.applies ?? []).filter(row => row.kind === 'rollback' && row.target === APPLY_TARGET.project && !['rolled_back', 'writing', 'interrupted'].includes(row.state) && (row.undoesTurn === turnId || rows.some(item => item.kind !== 'rollback' && (item.id === row.undoes || item.rolledBackBy === row.id))));
    // A retry or a resume runs the same turn again: its attempt (when it began and ended, its checkpoint's end) is part
    // of what the answer depends on, or a later attempt would get the earlier one's files.
    const attempt = [turn.status, turn.attemptStartedAt ?? null, turn.completedAt ?? null, turn.checkpoint?.endedAt ?? null];
    const key = JSON.stringify([projectId, turnId, ...attempt, turn.apply?.status ?? null, turn.checkpoint?.state ?? null, rows.map(row => [row.id, row.state, row.rolledBackBy ?? null]), undoing.map(row => [row.id, row.state])]);
    const kept = this.turnPlans.get(key);
    if (kept && this.now() - kept.at < TURN_PLAN_MS) return kept.plan;
    // The same question asked twice at once (本轮交付 and the footer mount together) is answered by one computation.
    const running = this.turnPlanRuns.get(key);
    if (running) return running;
    const run = this.computeTurnPlan(projectId, turnId, { project, session, turn, rows, undoing, tools }).then(plan => {
      // A git that was away or failed is asked again next time; only a settled answer is kept.
      if (plan.source === 'tools' && TRANSIENT_TURN_REASONS.includes(plan.reason)) return plan;
      for (const [old, row] of this.turnPlans) if (this.now() - row.at >= TURN_PLAN_MS || this.turnPlans.size >= 16) this.turnPlans.delete(old);
      this.turnPlans.set(key, { at: this.now(), plan });
      return plan;
    }).finally(() => this.turnPlanRuns.delete(key));
    this.turnPlanRuns.set(key, run);
    return run;
  }

  async computeTurnPlan(projectId, turnId, { project, session, turn, rows, undoing, tools }) {
    if (!turn.apply && turn.checkpoint?.state !== 'taken') return tools(turn.checkpoint ? (turn.checkpoint.state === 'expired' ? 'expired' : 'no_checkpoint') : 'no_records');
    if (turn.apply && turn.apply.status !== 'applied') return tools(['applying', 'pending', 'conflicted', 'none'].includes(turn.apply.status) ? turn.apply.status : 'unsettled');
    let context;
    try { context = await this.context(projectId); } catch (error) { if (error?.code === 'git_unavailable') return tools('git_unavailable'); throw error; }
    try {
      const undone = await this.undoneBy(context, undoing, { turnId, rows });
      return turn.apply ? await this.recordsPlan(context, { project, rows, undone, tools }) : await this.checkpointPlan(context, projectId, turnId, { project, session, turn, rows, undone, tools });
    } catch (error) {
      // A composed tree git refuses (a path that is a file in one record and a folder in another): the tool calls stay.
      if (error?.code === 'engine_failed') { console.warn(`turn changes ${turnId}: ${error.message}`); return tools('unreadable'); }
      throw error;
    }
  }

  /**
   * What the rollback records still in effect undid of this turn, path by path: path → the ids of the turn's records
   * whose change to that path a rollback that wrote it undid (`undoes`, or several settled as one, `rolledBackBy`), and
   * WHOLE_TURN when a rollback of the whole turn wrote it. A record's change counts as undone only for the paths its
   * rollback wrote (its ref, else its sample), so one record rolled back alone undoes nothing of another record's part.
   */
  async undoneBy(context, undoing, { turnId, rows }) {
    const undone = new Map();
    for (const row of undoing) {
      const ids = row.undoesTurn === turnId ? [WHOLE_TURN] : rows.filter(item => item.kind !== 'rollback' && (item.id === row.undoes || item.rolledBackBy === row.id)).map(item => item.id);
      for (const path of await this.recordPaths(context, row)) { if (!undone.has(path)) undone.set(path, new Set()); for (const id of ids) undone.get(path).add(id); }
    }
    return undone;
  }

  /** The project paths a record wrote: from its checkpoint while it has one, else its sample (and a discard's pending paths). */
  async recordPaths(context, row) {
    const commits = row.state === 'expired' ? null : await recordCommits(context, row.id);
    if (!commits) return [...new Set([...(row.sample ?? []), ...(row.pending ?? [])])];
    const paths = new Set();
    for (const change of await diffTrees(context, commits.before, commits.after)) { const local = toRoot(context, change.path); if (local !== null) paths.add(local); }
    return [...paths];
  }

  /** A worktree conversation's turn: its records into the project folder, composed path by path (see turnChanges). */
  async recordsPlan(context, { project, rows, undone, tools }) {
    // The set rollbackTurn rolls back, rolled-back records included, oldest first.
    const own = rows.filter(row => row.target === APPLY_TARGET.project && (row.kind === 'turn' || (row.kind === 'resolve' && !row.undoes))).reverse();
    if (!own.length) return tools('no_records');
    // A write still going on (or cut off) has its planned result in its ref, not what was written.
    if (own.some(row => ['writing', 'interrupted'].includes(row.state))) return tools('unsettled');
    if (own.some(row => row.state === 'expired')) return tools('expired');
    const steps = [];
    for (const row of own) {
      const commits = await recordCommits(context, row.id);
      if (!commits) return tools('expired');
      steps.push({ row, commits, changes: (await diffTrees(context, commits.before, commits.after)).filter(change => toRoot(context, change.path) !== null) });
    }
    const byPath = new Map();
    for (const step of steps) for (const change of step.changes) { if (!byPath.has(change.path)) byPath.set(change.path, []); byPath.get(change.path).push({ step, old: change.old, next: change.next }); }
    const composed = [], sectioned = [];
    for (const [path, entries] of byPath) {
      if (entries.every((entry, index) => !index || sameBlob(entries[index - 1].next, entry.old))) {
        // Written and put back within the turn: nothing reached the file.
        if (!sameBlob(entries[0].old, entries.at(-1).next)) composed.push({ path, old: entries[0].old, next: entries.at(-1).next });
      } else sectioned.push({ path: toRoot(context, path), entries });
    }
    // The composed paths' first before and last after side by side in two trees: one diff gives their counts (and
    // renames between them), one more their patches.
    const empty = await emptyTree(context);
    const [before, after] = await Promise.all(['old', 'next'].map(side => composeTree(context, empty, composed.filter(row => row[side]).map(row => ({ path: row.path, mode: row[side].mode, oid: row[side].oid })))));
    const read = composed.length ? await this.filesBetween(context, before, after) : { files: [], truncated: false };
    // A composed file is rolled back once every record of its chain had its change to it undone: a later record
    // rolled back alone leaves the earlier records' part standing.
    const chains = new Map(composed.map(row => [toRoot(context, row.path), byPath.get(row.path).map(entry => entry.step.row.id)]));
    const files = read.files.map(file => {
      const parts = [file.path, file.oldPath].filter(path => path && chains.has(path));
      return { ...file, ...(parts.length && parts.every(path => undoneAll(undone, path, chains.get(path))) ? { rolledBack: true } : {}) };
    });
    const sections = new Map();
    let truncated = read.truncated;
    for (const { path, entries } of sectioned) {
      const rowsOf = [];
      for (const entry of entries) {
        const { row, commits } = entry.step;
        const counted = await this.filesBetween(context, commits.before, commits.after, { paths: [path] });
        truncated ||= counted.truncated;
        const file = counted.files.find(item => item.path === path) ?? { path, status: !entry.old ? 'A' : !entry.next ? 'D' : 'M', added: null, removed: null };
        rowsOf.push({ applyId: row.id, at: row.at, kind: row.kind, status: file.status, added: file.added, removed: file.removed, ...(file.binary ? { binary: true } : {}), ...(undoneAll(undone, path, [row.id]) ? { rolledBack: true } : {}), before: commits.before, after: commits.after });
      }
      sections.set(path, rowsOf);
      const first = entries[0], last = entries.at(-1), counted = rowsOf.every(row => row.added !== null);
      files.push({ path, status: !first.old && last.next ? 'A' : !last.next ? 'D' : 'M', added: counted ? rowsOf.reduce((n, row) => n + row.added, 0) : null, removed: counted ? rowsOf.reduce((n, row) => n + row.removed, 0) : null,
        ...(rowsOf.some(row => row.binary) ? { binary: true } : {}), ...(rowsOf.every(row => row.rolledBack) ? { rolledBack: true } : {}), changedBetween: true,
        sections: rowsOf.map(({ before: _before, after: _after, ...row }) => row) });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { source: 'records', context, before, after, files, sections, applyIds: own.map(row => row.id), truncated };
  }

  /** A direct-mode turn: its checkpoint start → end, limited to the paths attributable() gives it (see turnChanges). */
  async checkpointPlan(context, projectId, turnId, { project, session, turn, rows, undone, tools }) {
    if (typeof this.attributable !== 'function') return tools('no_checkpoint');
    let own;
    try { own = await this.attributable(projectId, turnId); } catch (error) { if (error?.code === 'turn_checkpoint_missing') return tools('expired'); throw error; }
    if (!own?.start || !own?.end) return tools('expired');
    const [start, end] = await Promise.all([peelTree(context, own.start), peelTree(context, own.end)]);
    // Paths other owners wrote during the turn go back to their start entry, so the diff holds only the turn's own.
    const excludedRows = (own.excluded ?? []).filter((row, index, all) => all.findIndex(item => item.path === row.path) === index);
    const excluded = excludedRows.map(row => toTree(context, row.path));
    const starts = excluded.length ? await lsTree(context, start, excluded) : new Map();
    const after = excluded.length ? await composeTree(context, end, excluded.map(path => { const row = starts.get(path); return row && row.type !== 'tree' ? { path, mode: row.mode, oid: row.oid } : { path, delete: true }; })) : end;
    const mine = new Set(own.paths ?? []);
    const read = await this.filesBetween(context, start, after);
    // What the turn can be credited with: the paths its own calls wrote by name, and the paths its own records wrote
    // (a worker's merge, a conflict card's answer). A path that only changed while it ran was not necessarily its
    // work: the user's editor, another conversation in this folder. With no call that could write unnamed files (a
    // command, a delegation, any tool not known to only read), such a path is not listed at all; with one, it is
    // listed as `unattributed`.
    const touched = turnTouches(session, turn.id, project.workspace);
    const byRecord = new Map();
    for (const row of rows.filter(item => item.target === APPLY_TARGET.project && item.kind !== 'rollback' && !item.undoes)) {
      for (const path of await this.recordPaths(context, row)) { if (!byRecord.has(path)) byRecord.set(path, []); byRecord.get(path).push(row.id); }
    }
    const credited = path => Boolean(path && (touched.paths.has(path) || byRecord.has(path)));
    // Rolled back: by a rollback of the whole turn, or (a path only the turn's records wrote) each of them by its own.
    const rolledBack = path => undoneAll(undone, path, touched.paths.has(path) ? [] : byRecord.get(path) ?? []);
    const files = [];
    for (const file of read.files) {
      if (!mine.has(file.path) && !(file.oldPath && mine.has(file.oldPath))) continue;
      const ours = credited(file.path) || credited(file.oldPath);
      if (!ours && !touched.unknown) continue;
      files.push({ ...file, ...(rolledBack(file.path) ? { rolledBack: true } : {}), ...(ours ? {} : { unattributed: true }) });
    }
    // A path the turn wrote that another owner also wrote while it ran: left out of the diff (the two can't be told
    // apart there), reported so the turn's own change to it does not drop out of view.
    const shared = excludedRows.filter(row => credited(row.path)).map(row => ({ path: row.path, applyId: row.applyId })).slice(0, 100);
    // What the turn's write tools wrote that neither snapshot holds and is on disk now: ignored or over the size limit.
    const shown = new Set([...files.flatMap(file => [file.path, file.oldPath].filter(Boolean)), ...shared.map(row => row.path)]);
    const written = toolWrites(session, turn.id, project.workspace).filter(path => !shown.has(path));
    let uncovered = [];
    if (written.length) {
      const held = new Set([...(await lsTree(context, start, written.map(path => toTree(context, path)))).keys(), ...(await lsTree(context, after, written.map(path => toTree(context, path)))).keys()]);
      for (const path of written) if (!held.has(toTree(context, path)) && await lstat(join(project.workspace, ...path.split('/'))).then(info => info.isFile(), () => false)) uncovered.push(path);
      uncovered = uncovered.slice(0, 100);
    }
    return { source: 'checkpoint', context, before: start, after, files, sections: new Map(), uncovered, shared, truncated: read.truncated };
  }

  /** P, or the worktree a row wrote into (from its record), as a root. Null when that worktree is gone. */
  async rootForRow(context, project, row) {
    if (row.target === APPLY_TARGET.project) return this.projectRoot(context);
    const record = (project.git?.worktrees ?? []).find(item => item.id === row.targetWorktreeId);
    if (!record || ['removed', 'missing'].includes(record.state)) return null;
    const env = worktreeEnv(record, context.located);
    const workTree = await realpath(env.GIT_WORK_TREE).catch(() => null);
    if (!workTree) return null;
    return { root: join(workTree, context.located.prefix ?? '').replace(/\/$/, ''), kind: record.kind, isolated: true, project: context.located.workspace, prefix: context.located.prefix ?? '', worktreeId: record.id, gitDir: env.GIT_DIR, workTree };
  }

  /**
   * Daemon start (design §3.6): settle every `writing` record; post HOST_CARDS.interrupted cards. Also reads the
   * global excludes file once and starts watching those cards' answers (close() stops it).
   * @returns {Promise<{ verified: string[], completed: string[], interrupted: string[] }>}
   */
  async recover() {
    // apply() and take() wait for this, so a startup merge (an interrupted worker, an idle session's apply, a cut-off
    // background run) never writes between a crashed write and its recovery.
    this.recovering = (async () => {
      await this.primeExcludes();
      const outcome = await recoverApplies(this);
      this.watchCards();
      return outcome;
    })();
    return this.recovering;
  }

  /** Settle one `writing` row (records.recoverApplies calls this per row): 'verified' | 'completed' | 'interrupted'. */
  async recoverRow(projectId, applyId) {
    const context = await this.context(projectId);
    return this.lock(projectId, async () => {
      const project = this.projectRow(projectId), row = applyRow(project, applyId);
      if (!row || row.state !== 'writing') return 'verified';
      const root = await this.rootForRow(context, project, row), commits = await recordCommits(context, applyId);
      if (!root || !commits) return this.interruptRow(projectId, applyId, { card: Boolean(root) });
      // The user is in the middle of a merge, rebase, … in P (design §3.7: writes into P wait for it): recovery does
      // not write there now; the card decides, and its answer waits for the operation to end.
      if (root.kind === 'project' && await context.git.operation(context.located.gitDir)) return this.interruptRow(projectId, applyId);
      const [before, planned] = await Promise.all([commits.before, commits.after].map(commit => objects(context, ['rev-parse', `${commit}^{tree}`]).then(result => result.stdout.trim())));
      // A discard records its paths, not its result: what those paths hold now is what it did.
      if (row.kind === 'user_discard') {
        const now = await takeSnapshot(context, root), pending = row.pending ?? [];
        const changes = (await diffTrees(context, before, now.tree)).filter(change => { const local = toRoot(context, change.path); return local !== null && pending.some(path => local === path || (path.endsWith('/') && local.startsWith(path))); });
        await this.settleRecord(context, projectId, row.id, commits.before, before, changes, { recovered: 'verified' });
        return 'verified';
      }
      const changes = (await diffTrees(context, before, planned)).map(change => ({ ...change, local: toRoot(context, change.path) })).filter(change => change.local !== null);
      const state = await currentState(context, root, changes.map(change => change.local));
      const added = changes.filter(change => change.next).map(change => change.local);
      const atPlanned = change => holds(context, state.get(change.local).entry, change.next, change.local, added), atBefore = change => sameEntry(context, state.get(change.local).entry, change.old);
      if (changes.every(atPlanned)) { settleApply(this.store, projectId, applyId, { state: 'verified', recovered: 'verified' }); return 'verified'; }
      if (!changes.every(change => atPlanned(change) || atBefore(change))) return this.interruptRow(projectId, applyId);
      const plan = changes.filter(change => !atPlanned(change)).map(change => ({ path: change.local, expect: change.old, next: change.next }));
      const outcome = await write(context, root, plan, { mode: 'all' });
      if (outcome.rolledBack || outcome.conflicts.length) return this.interruptRow(projectId, applyId);
      settleApply(this.store, projectId, applyId, { state: outcome.verify === 'verified' ? 'verified' : 'unverified', recovered: 'completed' });
      return 'completed';
    });
  }

  /** Move a record's ref to [before, before + changes] and settle it verified. */
  async settleRecord(context, projectId, applyId, beforeCommit, beforeTree, changes, extra = {}) {
    const after = await composeTree(context, beforeTree, changes.map(change => (change.next ? { path: change.path, mode: change.next.mode, oid: change.next.oid } : { path: change.path, delete: true })));
    const afterCommit = await commitTree(context, after, [beforeCommit], `Rna apply ${applyId} (after)`);
    await updateRefs(context, [{ ref: REFS.apply(applyId), commit: await commitTree(context, after, [beforeCommit, afterCommit], `Rna apply ${applyId}`) }]);
    const local = changes.map(change => ({ ...change, path: toRoot(context, change.path) ?? change.path }));
    settleApply(this.store, projectId, applyId, { state: 'verified', pending: undefined, ...summarize(local), ...extra });
  }

  /** Mark a row interrupted and put the "上次应用中断了" card above the composer (when it has somewhere to go). */
  async interruptRow(projectId, applyId, { card = true } = {}) {
    settleApply(this.store, projectId, applyId, { state: 'interrupted', recovered: 'interrupted' });
    if (card) this.postInterruptedCard(projectId, applyId);
    return 'interrupted';
  }

  postInterruptedCard(projectId, applyId) {
    if (typeof this.interactions?.publish !== 'function') return null;
    const project = this.store.state.projects.find(row => row.id === projectId), row = applyRow(project, applyId);
    if (!project || !row) return null;
    const open = id => this.store.state.sessions.find(session => session.id === id && session.projectId === projectId && !session.archivedAt);
    const session = open(row.source?.sessionId) ?? open(project.primarySessionId) ?? this.store.state.sessions.find(item => item.projectId === projectId && !item.archivedAt);
    if (!session) return null;
    const files = row.files ?? 0;
    try {
      const record = this.interactions.publish({ sessionId: session.id, actionId: HOST_CARDS.interrupted.actionId(applyId), source: HOST_CARDS.interrupted.source, questions: [{ id: 'decision', header: this.say({ zh: '上次应用中断了', en: 'The last apply was interrupted' }),
        question: this.say({ zh: `上次往项目文件夹写入 ${files} 个文件时中断了，其中有的文件之后又被改过。要怎么处理？`, en: `Writing ${files} file(s) into the project folder was interrupted, and some of them changed afterwards. What should happen?` }),
        options: [{ id: 'complete', label: this.say({ zh: '完成应用', en: 'Complete the apply' }), description: this.say({ zh: '只写入还停在应用前的文件，之后改过的不动。', en: 'Write only the files still as they were before; files changed since stay as they are.' }) },
          { id: 'restore', label: this.say({ zh: '回到应用前', en: 'Go back to before' }), description: this.say({ zh: '只还原已经写入、之后没再改过的文件。', en: 'Restore only the files it wrote that have not changed since.' }) }], allowCustom: false }] });
      settleApply(this.store, projectId, applyId, { card: { sessionId: session.id, interactionId: record.id } });
      return record;
    } catch (error) { console.warn(`interrupted apply card ${applyId}: ${error.message}`); return null; }
  }

  /** Watch interrupted-apply cards for answers (started by recover()). Returns the unsubscribe function. */
  watchCards() {
    if (this.unwatch || typeof this.store.subscribe !== 'function') return this.unwatch;
    this.unwatch = this.store.subscribe(() => { this.settleCards().catch(error => console.warn(`interrupted apply cards: ${error.message}`)); }, { display: false });
    this.settleCards().catch(() => {});
    return this.unwatch;
  }
  close() {
    this.unwatch?.(); this.unwatch = null;
    this.closed = true;
    for (const [projectId, entry] of [...this.freeWaits]) this.disarmFree(projectId, entry);
  }

  /**
   * Answered "上次应用中断了" cards → resolveInterrupted. Projects are settled independently, so one project's wait
   * never holds another's; an answer that finds the user's git operation in the project folder is held (one timeline
   * line in the card's conversation) and carried out once the operation ends (whenProjectFree).
   */
  async settleCards() {
    const due = [];
    for (const project of this.store.state.projects) for (const row of project.git?.applies ?? []) {
      if (row.state !== 'interrupted' || !row.card || this.settling.has(row.id) || this.heldCards.has(row.id)) continue;
      const record = this.store.state.sessions.find(session => session.id === row.card.sessionId)?.items.find(item => item.interaction?.id === row.card.interactionId)?.interaction;
      const choice = record?.status === 'answered' ? record.answers?.[0]?.selected?.[0] : null;
      if (['complete', 'restore'].includes(choice)) due.push({ projectId: project.id, row, choice });
    }
    const byProject = new Map();
    for (const item of due) byProject.set(item.projectId, [...(byProject.get(item.projectId) ?? []), item]);
    await Promise.allSettled([...byProject.values()].map(async items => {
      for (const { projectId, row, choice } of items) {
        if (this.settling.has(row.id)) continue;
        this.settling.add(row.id);
        try { await this.resolveInterrupted(projectId, row.id, choice, { initiator: 'user', hold: true }); }
        catch (error) {
          if (error?.code === 'git_operation_in_progress') this.holdCard(projectId, row, error.operation);
          else console.warn(`interrupted apply ${row.id}: ${error.message}`);
        }
        finally { this.settling.delete(row.id); }
      }
    }));
  }
  /** An interrupted-apply card answer held on the user's git operation in P: one line, then taken up when it ends. */
  holdCard(projectId, row, operation) {
    this.heldCards.add(row.id);
    this.notice(row.card?.sessionId, row.source?.turnId ?? null, { zh: `项目文件夹正在进行 git ${operation}，完成后再按你的选择处理。`, en: `A git ${operation} is in progress in the project folder; your choice is carried out after it finishes.` });
    this.whenProjectFree(projectId, `interrupted:${row.id}`, () => { this.heldCards.delete(row.id); void this.settleCards().catch(error => console.warn(`interrupted apply cards: ${error.message}`)); });
  }
  /** A timeline line in a conversation (best effort), in the interface language. */
  notice(sessionId, turnId, variants) {
    if (!sessionId) return;
    try {
      this.store.mutate(state => {
        const session = state.sessions.find(row => row.id === sessionId);
        if (!session) return;
        const at = new Date(this.now()).toISOString();
        session.items.push({ id: randomUUID(), turnId: turnId ?? null, kind: 'notice', text: inLanguage(interfaceLanguageOf(state), variants), createdAt: at, simulated: false, source: 'worktree' });
        session.updatedAt = at;
      });
    } catch { /* the line is best effort */ }
  }

  /**
   * The answer to an "上次应用中断了" card: `complete` writes only paths still at before; `restore` puts back only
   * paths still at R. Each takes a checkpoint first.
   * @param {'complete'|'restore'} choice
   * @param {{ initiator?: 'user'|'agent'|'host', hold?: boolean }} [options]  `initiator`: recorded on a `restore`'s
   *   resolve record (the card's answer: 'user'); `hold`: a git operation in P refuses at once
   *   (`git_operation_in_progress`) instead of waiting for it (the card's answer holds and is retried, settleCards)
   * @returns {Promise<ApplyOutcome>}
   */
  async resolveInterrupted(projectId, applyId, choice, { initiator, hold = false } = {}) {
    return this.human(async () => {
      if (!['complete', 'restore'].includes(choice)) throw engineError('engine_failed', `Unknown choice ${choice}.`);
      const project = this.projectRow(projectId), row = applyRow(project, applyId);
      if (!row) this.fail('apply_not_found', { zh: '找不到这条应用记录。', en: 'That apply record can’t be found.' });
      if (row.state !== 'interrupted') this.fail('rollback_nothing', { zh: '这条记录已经处理过了。', en: 'This record was already settled.' });
      const context = await this.context(projectId), root = await this.rootForRow(context, project, row), commits = await recordCommits(context, applyId);
      if (!root || !commits) this.fail('worktree_missing', { zh: '这次应用写入的文件夹或检查点已经不在了。', en: 'The folder or checkpoint of this apply is gone.' });
      if (root.kind === 'project') await this.waitForProject(projectId, context, { hold });
      return this.lock(projectId, async () => {
        // One that began while this answer waited for the lock: held too (the card's answer is retried when it ends).
        if (hold && root.kind === 'project') { const operation = await context.git.operation(context.located.gitDir); if (operation) throw this.operationRefused(operation); }
        const [before, planned] = await Promise.all([commits.before, commits.after].map(commit => objects(context, ['rev-parse', `${commit}^{tree}`]).then(result => result.stdout.trim())));
        const changes = (await diffTrees(context, before, planned)).map(change => ({ ...change, local: toRoot(context, change.path) })).filter(change => change.local !== null);
        // The checkpoint: the folder as it is now, before this answer writes anything.
        const now = await takeSnapshot(context, root), state = await currentState(context, root, changes.map(change => change.local));
        const plan = choice === 'complete'
          ? changes.filter(change => sameEntry(context, state.get(change.local).entry, change.old) && !sameEntry(context, change.old, change.next)).map(change => ({ path: change.local, expect: change.old, next: change.next }))
          : changes.filter(change => sameEntry(context, state.get(change.local).entry, change.next) && !sameEntry(context, change.old, change.next)).map(change => ({ path: change.local, expect: change.next, next: change.old }));
        const base = { status: 'nothing', applyId: null, mid: null, before: now.commit, result: now.tree, written: [], removed: [], conflicts: [], notMerged: [], bothChanged: 0, verify: null, dependencies: false };
        let written = { applyId: null, outcome: { written: [], removed: [], conflicts: [], verify: null, mismatched: [] } };
        if (plan.length) written = await this.recordedWrite(context, projectId, root, now, plan, { kind: 'resolve', source: row.source ?? {}, mode: 'partial', extra: choice === 'restore' ? { undoes: applyId, ...initiatedBy(initiator) } : {} });
        settleApply(this.store, projectId, applyId, choice === 'complete' ? { state: 'verified' } : { state: 'rolled_back', ...(written.applyId ? { rolledBackBy: written.applyId } : {}) });
        const result = written.outcome;
        return { ...base, status: result.conflicts.length ? 'conflicted' : written.applyId ? 'applied' : 'nothing', applyId: written.applyId, written: result.written, removed: result.removed, conflicts: result.conflicts, verify: written.applyId ? result.verify : null };
      });
    });
  }

  /**
   * Retention (design §5.3; at start, then daily): records and their refs, turn refs past LIMITS.turnRefDays
   * (orphan refs only after 30 days too).
   * @returns {Promise<{ expired: number, refsDeleted: number }>}
   */
  async sweep({ now = this.now() } = {}) {
    let expired = 0, refsDeleted = 0, indexesDeleted = 0;
    const known = new Set(this.store.state.projects.flatMap(project => (project.git?.applies ?? []).map(row => row.id)));
    // repository → the turn ids that still have a hold ref after this sweep, and those whose ref this sweep deleted;
    // project → its repository.
    const swept = new Set(), turnHolds = new Map(), turnsSwept = new Map(), repositoryOf = new Map(), collected = [];
    // Every project's repository, archived ones too: their roots stay live for the private index sweep.
    const located = new Map();
    for (const project of this.store.state.projects) { try { located.set(project.id, await this.context(project.id)); } catch { /* no repository now */ } }
    // Each with its worktree rows: a worktree's root is as live as the project folder (liveIndexNames), so a kept
    // worker copy or an idle conversation's worktree keeps its index however long it went without a snapshot.
    const onRepository = commonDir => this.store.state.projects.filter(row => located.get(row.id)?.located.commonDir === commonDir).map(row => ({ project: row, workspace: located.get(row.id).located.workspace, prefix: located.get(row.id).located.prefix ?? '', worktrees: row.git?.worktrees ?? [] }));
    for (const project of this.store.state.projects) {
      if (project.archivedAt) continue;
      const context = located.get(project.id);
      if (!context) continue;
      repositoryOf.set(project.id, context.located.commonDir);
      const { expire } = retention(project.git?.applies ?? [], { now });
      await this.lock(project.id, async () => {
        if (expire.length) {
          await updateRefs(context, expire.map(id => ({ ref: REFS.apply(id), commit: null })));
          this.store.mutate(state => { for (const row of gitOf(state.projects.find(item => item.id === project.id)).applies) if (expire.includes(row.id)) row.state = 'expired'; });
          expired += expire.length; refsDeleted += expire.length;
        }
        // Refs of the repository (projects sharing one repository sweep it once).
        if (swept.has(context.located.commonDir)) return;
        swept.add(context.located.commonDir);
        const listed = await objects(context, ['for-each-ref', '--format=%(refname) %(committerdate:unix)', 'refs/rna/turn/', 'refs/rna/apply/', 'refs/rna/m/']);
        if (listed.code !== 0) return;
        const stale = [], kept = new Set(), gone = new Set();
        for (const line of listed.stdout.split('\n')) {
          const [ref, time] = line.trim().split(' '), age = now - Number(time) * 1000;
          if (!ref || !Number.isFinite(age)) continue;
          if (ref.startsWith('refs/rna/turn/')) { if (age > LIMITS.turnRefDays * DAY) { stale.push(ref); gone.add(ref.slice('refs/rna/turn/'.length)); } else kept.add(ref.slice('refs/rna/turn/'.length)); }
          else if (ref.startsWith('refs/rna/apply/') && !known.has(ref.slice('refs/rna/apply/'.length)) && age > LIMITS.retentionDays * DAY) stale.push(ref);
          else if (ref.startsWith('refs/rna/m/') && age > 3600000) stale.push(ref);
        }
        if (stale.length) { await updateRefs(context, stale.map(ref => ({ ref, commit: null }))); refsDeleted += stale.length; }
        turnHolds.set(context.located.commonDir, kept); turnsSwept.set(context.located.commonDir, gone);
        // Temporary files of writes a crash cut short (the writer makes them in <commonDir>/rna/tmp).
        await sweepScratch(context, { now }).catch(() => 0);
        const projects = onRepository(context.located.commonDir);
        // Private indexes no live root uses any more (review ISO-6): a crash between a worktree's removal and its
        // index's, or rows from before WorktreeService.remove() dropped them.
        indexesDeleted += await this.sweepIndexes(context, projects, { now }).catch(() => 0);
        // `git gc --auto` only on a repository Rna initialized that holds no commit of the user's (decided 2026-10-05).
        if (await this.collectGarbage(context, projects).catch(() => false)) collected.push(context.located.commonDir);
      });
    }
    return { expired, refsDeleted, indexesDeleted, collected, checkpointsExpired: this.expireCheckpoints({ turnHolds, turnsSwept, repositoryOf, now }) };
  }

  /**
   * Delete the private indexes of `<commonDir>/rna/index` whose root is no longer live (storage.mjs liveIndexNames: P
   * and every worktree not removed, of every project on the repository) and whose files are older than
   * LIMITS.retentionDays (harness cleanup.ts: exact names, regular files, by age; never a link). A cache: a root still
   * in use that lost one rebuilds it. Answers how many index files went (notes not counted). Caller holds the lock.
   */
  async sweepIndexes(context, projects, { now = this.now() } = {}) {
    const folder = join(context.located.commonDir, 'rna', 'index');
    const names = orphanIndexes({ entries: await indexEntries(context.located.commonDir), live: await liveIndexNames(projects), cutoffMs: now - LIMITS.retentionDays * DAY });
    let deleted = 0;
    for (const name of names) {
      const path = join(folder, name), info = await lstat(path).catch(() => null);
      if (!info?.isFile()) continue;
      await unlink(path).catch(() => {});
      if (!name.endsWith('.json')) deleted++;
    }
    return deleted;
  }

  /**
   * `git gc --auto` for a repository Rna initialized whose history is still Rna's first commit only (storage.mjs
   * ownerOf), in the foreground (`gc.autoDetach=false`, so the repository lock covers all of it), never pruning a
   * worktree (`gc.worktreePruneExpire=never`: Rna never prunes the user's absent worktrees). Skipped while a turn of a
   * project on it runs, and stopped when one starts meanwhile (SIGTERM: git cleans up after itself), so a turn's
   * checkpoint and hand-back, which take the same lock, never wait for a collection that can run another day. Any
   * other repository is the user's: reported in the storage view, never collected. The repository's and the user's
   * own gc settings apply (`gc.auto=0` turns it off). Caller holds the lock. Answers whether it ran to its end.
   */
  async collectGarbage(context, projects) {
    const ids = new Set(projects.map(row => row.project.id));
    const turning = () => this.store.state.sessions.some(session => ids.has(session.projectId) && session.status === 'running');
    if (turning()) return false;
    if (await ownerOf(context, projects) !== 'rna') return false;
    const stop = new AbortController(), unsubscribe = this.store.subscribe(() => { if (turning()) stop.abort(); }, { display: false });
    try {
      if (turning()) return false;
      const result = await context.git.run(context.located.top, ['-c', 'gc.autoDetach=false', '-c', 'gc.worktreePruneExpire=never', '-c', 'maintenance.auto=false', 'gc', '--auto', '--quiet'], { timeoutMs: GC_TIMEOUT_MS, killSignal: 'SIGTERM', signal: stop.signal });
      return result.code === 0 && !stop.signal.aborted;
    } finally { unsubscribe(); }
  }

  /**
   * Direct-mode turns whose hold ref this sweep deleted, or whose ref is gone and the turn is past LIMITS.turnRefDays
   * (swept earlier): turn.checkpoint becomes `{ state: 'expired', reason: 'expired' }`, so the footer stops offering
   * 回退本轮 (rollbackTurn would answer turn_checkpoint_missing). A swept ref counts whatever the turn's own dates say
   * (a turn paused and finished later keeps the date of its ref); a younger turn whose ref is missing is left as it
   * is. Answers how many turns changed.
   */
  expireCheckpoints({ turnHolds, turnsSwept = new Map(), repositoryOf, now }) {
    const cutoff = now - LIMITS.turnRefDays * DAY, due = [];
    for (const session of this.store.state.sessions) {
      const repository = repositoryOf.get(session.projectId), kept = turnHolds.get(repository), gone = turnsSwept.get(repository);
      if (!kept) continue;
      for (const turn of session.turns ?? []) {
        if (turn.checkpoint?.state !== 'taken' || kept.has(turn.id)) continue;
        const at = Date.parse(turn.completedAt ?? turn.pausedAt ?? turn.startedAt ?? turn.createdAt ?? '');
        if (gone?.has(turn.id) || (Number.isFinite(at) && at < cutoff)) due.push([session.id, turn.id]);
      }
    }
    if (!due.length) return 0;
    try {
      this.store.mutate(state => {
        for (const [sessionId, turnId] of due) {
          const turn = state.sessions.find(row => row.id === sessionId)?.turns.find(row => row.id === turnId);
          if (turn?.checkpoint?.state === 'taken') turn.checkpoint = { state: 'expired', reason: 'expired', expiredAt: new Date(now).toISOString() };
        }
      });
    } catch (error) { console.warn(`turn checkpoints: ${error.message}`); return 0; }
    return due.length;
  }

  /**
   * The checkpoint of the panel's discard (design §0.3-1, §5.1 `user_discard`): called by WorkspaceGitService.discard
   * inside the repository lock it already holds, before any file changes. Snapshots P, pins it and persists a
   * `writing` row with the discarded paths; `settle()` records what the discard actually changed.
   * @param {string} projectId
   * @param {{ path: string, action: string }[]} files  the discard plan
   * @returns {Promise<{ applyId: string, settle: () => Promise<string|null> }>}  settle: the record's id, or null when nothing changed (no record)
   */
  async discardCheckpoint(projectId, files) {
    return this.human(async () => {
      const context = await this.context(projectId), root = this.projectRoot(context);
      const before = await takeSnapshot(context, root), applyId = `a${hex(8)}`, pending = files.map(file => file.path);
      // A file over the snapshot limit is not in the checkpoint, so discarding it could never be rolled back: no
      // checkpoint, no discard (invariant §0.3-1).
      const covers = (path, file) => file === path || (path.endsWith('/') && file.startsWith(path));
      const big = (before.oversized ?? []).filter(file => pending.some(path => covers(path, file)));
      if (big.length) this.fail('checkpoint_oversized', { zh: `「${big[0]}」${big.length > 1 ? ` 等 ${big.length} 个文件` : ''}超过 100 MB，没法先建检查点，丢弃后就不能回退，所以没有丢弃任何文件。需要的话请自己删除或恢复它。`, en: `“${big[0]}”${big.length > 1 ? ` and ${big.length - 1} more` : ''} is over 100 MB, so no checkpoint can hold it and discarding couldn’t be undone; nothing was discarded. Delete or restore it yourself if you need to.` }, { paths: big.slice(0, 20) });
      // A file that holds secrets (SECRET_FILES) is never put in a checkpoint either, so the same holds (B8): a pending
      // path that is one, or a folder holding one the listing showed.
      const secrets = [...new Set([...pending.filter(path => isSecretPath(path)), ...(before.secret ?? []).filter(file => pending.some(path => covers(path, file)))])];
      if (secrets.length) this.fail('checkpoint_secret', { zh: `「${secrets[0]}」${secrets.length > 1 ? ` 等 ${secrets.length} 个文件` : ''}存放密钥一类的内容，Rna 从不把它放进检查点，丢弃后就不能回退，所以没有丢弃任何文件。需要的话请自己恢复或删除它。`, en: `“${secrets[0]}”${secrets.length > 1 ? ` and ${secrets.length - 1} more` : ''} holds secrets, which Rna never puts in a checkpoint, so discarding couldn’t be undone; nothing was discarded. Restore or delete it yourself if you need to.` }, { paths: secrets.slice(0, 20) });
      const started = Date.now();
      await updateRefs(context, [{ ref: REFS.apply(applyId), commit: await commitTree(context, before.tree, [before.commit, before.commit], `Rna apply ${applyId}`) }]);
      beginApply(this.store, projectId, { id: applyId, kind: 'user_discard', target: APPLY_TARGET.project, source: {}, files: pending.length, sample: pending.slice(0, 20), pending });
      // The discard is the user's undo: what it changes is handed to the folder's observation when it settles.
      const undo = this.userUndoWrite(projectId);
      return { applyId, settle: async () => {
        let changed = [];
        try {
          const now = await takeSnapshot(context, root);
          const changes = (await diffTrees(context, before.tree, now.tree)).filter(change => { const local = toRoot(context, change.path); return local !== null && pending.some(path => local === path || (path.endsWith('/') && local.startsWith(path))); });
          changed = changes.map(change => toRoot(context, change.path));
          if (!changes.length) { await updateRefs(context, [{ ref: REFS.apply(applyId), commit: null }]); dropApply(this.store, projectId, applyId); return null; }
          await this.settleRecord(context, projectId, applyId, before.commit, before.tree, changes, { ms: Math.max(0, Date.now() - started) });
          return applyId;
        } finally { await undo?.end(changed); }
      } };
    });
  }

  /**
   * Run `work` under the repository FIFO of the project's repository (WorkspaceGitService.serial). Worktree add /
   * remove / lock / repair, batched update-ref, git init and the panel's stage / discard all queue here.
   * @template T
   * @param {string} projectId
   * @param {() => Promise<T>} work
   * @returns {Promise<T>}
   */
  async lock(projectId, work) {
    const git = this.gitService(), located = await git.locateProject(projectId).catch(() => null);
    const queue = located?.commonDir ? located : { commonDir: `project:${projectId}` }, held = holding.getStore();
    // Re-entrant within one chain of calls: work already holding this repository's lock (a worktree created under
    // it that pins a ref, say) runs on instead of queueing behind itself. Only while that hold lasts: a timer or a
    // callback the holder started inherits this context too, and once the hold is over it queues like anyone else.
    if (held?.get(queue.commonDir)?.active) return work();
    return git.serial(queue, async () => {
      const hold = { active: true }, chain = new Map([...(held ?? [])].filter(([, row]) => row.active));
      chain.set(queue.commonDir, hold);
      try { return await holding.run(chain, work); } finally { hold.active = false; }
    });
  }
}

/**
 * Plan entries no host write may carry (invariant §0.3-3, and the integrity of the folder): a gitlink (another
 * repository's commit is never file content); anything inside another repository the target holds (`nested`, from
 * the target's snapshot: its files are in no checkpoint, so such a write could never be rolled back); and, into the
 * project folder, content holding a conflict-marker line of an Rna merge — wherever it came from (a kept worktree
 * applied from the panel, a card's "this version", a take).
 * @returns {Promise<{ path: string, kind: 'submodule'|'content' }[]>}
 */
async function refusedEntries(context, root, plan, nested = []) {
  const inside = path => nested.some(folder => path.startsWith(folder.endsWith('/') ? folder : `${folder}/`));
  const refused = plan.filter(entry => entry.next?.mode === '160000' || inside(entry.path)).map(entry => ({ path: entry.path, kind: 'submodule' }));
  if (root.kind !== 'project') return refused;
  const texts = plan.filter(entry => entry.next && !['160000', '120000'].includes(entry.next.mode) && !inside(entry.path));
  if (!texts.length) return refused;
  const blobs = await readBlobs(context, texts.map(entry => entry.next.oid));
  for (const entry of texts) if (holdsRnaMarkers(blobs.get(entry.next.oid))) refused.push({ path: entry.path, kind: 'content' });
  return refused;
}
/** How long a turn's computed changes are reused (its files, then their patches as the user opens them). */
const TURN_PLAN_MS = 60000;
/** In undoneBy's sets: a rollback of the whole turn wrote the path. */
const WHOLE_TURN = Symbol('whole turn');
/** Whether undoneBy says a path was put back: by a rollback of the whole turn, or for each of `ids` (records that wrote it). */
const undoneAll = (undone, path, ids) => { const set = undone.get(path); return Boolean(set && (set.has(WHOLE_TURN) || (ids.length && ids.every(id => set.has(id))))); };
/** `tools` answers that say git could not be read this time (away, failed, timed out), not that the turn has no host answer: never kept. */
const TRANSIENT_TURN_REASONS = Object.freeze(['git_unavailable', 'unreadable']);
/** The same tree entry (both absent, or the same blob with the same mode): record k's after chains into record k+1's before. */
const sameBlob = (a, b) => (!a && !b) || Boolean(a && b && a.oid === b.oid && a.mode === b.mode);
/** The tools that write one file by path (turn-watch WRITE_TOOLS, the SDK's project tools). */
const PATH_WRITE_TOOLS = Object.freeze(['project_write', 'project_edit']);
/**
 * Project paths the turn's own write tools wrote (succeeded calls; the path as the tool got it, relative to the
 * project folder or absolute inside it). Paths outside the folder, and `.git` / `.rna`, are left out.
 */
function toolWrites(session, turnId, workspace) {
  const found = new Set();
  for (const item of session?.items ?? []) {
    const tool = item.turnId === turnId ? item.tool : null;
    if (!tool || !PATH_WRITE_TOOLS.includes(tool.name) || !['completed', 'done', 'succeeded'].includes(tool.status)) continue;
    const path = projectPath(workspace, tool.args?.path);
    if (path) found.add(path);
  }
  return [...found];
}
/** A tool's path as a project path (relative to the folder, `/`-separated), or null outside it and for `.git` / `.rna`. */
function projectPath(workspace, input) {
  if (typeof input !== 'string' || !input || input.includes('\0')) return null;
  const local = relative(workspace, resolve(workspace, input));
  if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) return null;
  const path = local.split(sep).join('/'), first = path.split('/')[0].toLowerCase();
  return first === '.git' || first === '.rna' ? null : path;
}
/** Tool kinds (live-bus toolKind) whose calls only read: they never change a file. */
const READ_ONLY_KINDS = Object.freeze(['read', 'search', 'web_search', 'web_fetch', 'skill', 'question', 'plan']);
/**
 * What a turn's own calls say about the files it wrote: `paths` its write tools named (any outcome but failed: a
 * failed write is atomic and wrote nothing; a stopped or uncertain one may have) and its media tools reported, and
 * `unknown` when it ran a call that may write files it does not name (a command, a delegation or merge, an MCP tool,
 * any tool whose kind is not known to only read).
 */
function turnTouches(session, turnId, workspace) {
  const paths = new Set();
  let unknown = false;
  for (const item of session?.items ?? []) {
    const tool = item.turnId === turnId ? item.tool : null;
    if (!tool?.name) continue;
    if (PATH_WRITE_TOOLS.includes(tool.name)) {
      const path = tool.status === 'failed' ? null : projectPath(workspace, tool.args?.path);
      if (path) paths.add(path);
    } else if (Array.isArray(tool.files) && tool.files.length) {
      for (const file of tool.files) { const path = projectPath(workspace, file?.path); if (path) paths.add(path); }
    } else if (!READ_ONLY_KINDS.includes(toolKind(tool.name))) unknown = true;
  }
  return { paths, unknown };
}
/** Entries of a tree at root paths: Map root path → { mode, oid }. */
async function mergeEntries(context, tree, paths) {
  const found = new Map();
  if (!paths.length) return found;
  const listed = await lsTree(context, tree, paths.map(path => toTree(context, path)));
  for (const path of paths) { const row = listed.get(toTree(context, path)); if (row) found.set(path, { mode: row.mode, oid: row.oid }); }
  return found;
}
/** The current / incoming entries a plan had for a path (a CAS conflict's sides). */
function entriesOf(plan, path) {
  const entry = plan.find(row => row.path === path);
  return entry ? { ...(entry.expect ? { current: entry.expect } : {}), ...(entry.next ? { incoming: entry.next } : {}) } : {};
}
