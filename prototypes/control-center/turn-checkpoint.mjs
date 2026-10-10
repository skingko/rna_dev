import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS, REFS } from './git-isolation/contract.mjs';
import { toolPermitted } from './project-permissions.mjs';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';

// Direct-mode turn checkpoints (worktree design 0.63 §5.1): every git project turn that runs in the project folder
// itself can be rolled back. Owner: T4 (bodies); the interface is the lead's contract. Not gated by
// ISOLATION_READY: ships with 0.63.0.
//
// start: a snapshot of P begun at preparing_workspace, in parallel; the turn's write wait waits for it only before
// the first tool whose `effect !== 'read'` (read-only turns pay nothing). Past LIMITS.checkpointWaitMs it is
// skipped (turn.checkpoint = { state: 'skipped', reason: 'timeout' }, footer "本轮没有检查点"), never blocking the
// turn. end: a snapshot in afterTurn. REFS.turn(turnId) holds [start, end] for LIMITS.turnRefDays.
//
// A turn can take several attempts (an ask_user pause, a failure retried, a restart): the hold ref keeps one start
// for the whole turn. While an attempt runs it has one parent (the start); when it ends it has two (start, end).
// When a later attempt begins, paths that changed between the previous end and the new start were changed by
// someone else (the user, another conversation): the start takes their new content for those paths, so rolling
// the turn back never undoes them. The hold commit's message records the attempts' time windows (JSON), which
// attributable() uses to leave out other owners' apply records written during the turn.

/**
 * @typedef {object} TurnCheckpointState  turn.checkpoint (design §11)
 * @property {string} [ref]   REFS.turn(turnId), once both ends exist
 * @property {'taken'|'skipped'|'expired'} state  `expired`: the hold ref was swept after LIMITS.turnRefDays
 *   (IsolationEngine.sweep → expireCheckpoints); the turn can no longer be rolled back as a whole.
 * @property {'timeout'|'no_repository'|'snapshot_failed'|'read_only'|'expired'} [reason]
 * @property {string} [endedAt]  `taken`: when the latest attempt's end snapshot went into the hold (ISO). Each attempt
 *   of the turn (a retry, a resume) records its own, so readers of the turn's changes know an answer is stale.
 * @property {string} [expiredAt]
 *
 * @typedef {object} CheckpointHandle
 * @property {Promise<{ commit?: string, state: 'taken'|'skipped', reason?: string }>} ready  the start snapshot
 * @property {(inner?: Function) => Function} gate  the turn's write wait (createRnaRuntime toolRun.wait): before the
 *   first non-read tool, await `ready` (bounded by LIMITS.checkpointWaitMs), then defer to `inner` if given. Session
 *   worktree turns chain SessionWorktreeService.syncStart into the same wait.
 */

const HOLD = 'rna-turn-checkpoint';
const sleep = ms => new Promise(done => { const timer = setTimeout(done, Math.max(0, ms)); timer.unref?.(); });

/**
 * A write wait that waits for `wait()` before any tool that is not read-only (`effect !== 'read'`; a tool without a
 * declared effect counts as writing), then defers to `inner` when one is given. The runtime runs it in the session's
 * beforeTool hook beside the host's ToolPolicy (B1, tool-policy.mjs: the constraint gate runs in parallel, not after
 * it), so it runs before the call's durable intent: a stop while a write waits here leaves the call never
 * dispatched instead of uncertain. `wait` must settle (never reject) within its own bound.
 * @param {() => Promise<unknown>} wait
 * @param {Function} [inner]
 * @returns {Function}
 */
export function gateOn(wait, inner) {
  return input => {
    if (input?.tool?.effect === 'read') return inner?.(input);
    return Promise.resolve(wait()).catch(() => null).then(() => inner?.(input));
  };
}

/** `promise`, or undefined once `ms` passed (it never rejects). */
export function bounded(promise, ms) {
  return Promise.race([Promise.resolve(promise).catch(() => undefined), sleep(ms).then(() => undefined)]);
}

/** Git plumbing in a repository's object store (engine environment: no global config, hooks off). */
export function objectGit(git, located) {
  // `cwd` and `env` (a work tree and an index of its own: ObjectGit#materialize) default to the object store alone.
  const run = (args, { maxBytes = 16 * 1024 * 1024, input, cwd = located.commonDir, env, signal } = {}) => git.run(cwd, args, { env: { GIT_DIR: located.commonDir, ...env }, engine: true, maxBytes, input, timeoutMs: 60000, killSignal: 'SIGTERM', ...(signal ? { signal } : {}) });
  const must = async (args, options) => {
    const result = await run(args, options);
    if (result.code !== 0) throw Object.assign(new Error(`git ${args[0]} failed: ${result.stderr.trim().slice(-300)}`), { code: 'engine_failed', status: 500 });
    return result.stdout;
  };
  return {
    run,
    /** The object a revision names, or null. */
    async resolve(rev) { const result = await run(['rev-parse', '-q', '--verify', rev]); return result.code === 0 ? result.stdout.trim() : null; },
    async tree(rev) { return (await must(['rev-parse', '--verify', '-q', `${rev}^{tree}`])).trim(); },
    async commit(tree, parents = [], message = 'Rna') { return (await must(['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', message])).trim(); },
    /** `{ tree, parents, message }` of a commit revision, or null when it does not exist. */
    async read(rev) {
      const id = await this.resolve(`${rev}^{commit}`);
      if (!id) return null;
      const text = await must(['cat-file', 'commit', id]), cut = text.indexOf('\n\n'), head = cut < 0 ? text : text.slice(0, cut);
      const lines = head.split('\n');
      return { id, tree: lines.find(line => line.startsWith('tree '))?.slice(5) ?? null, parents: lines.filter(line => line.startsWith('parent ')).map(line => line.slice(7)), message: cut < 0 ? '' : text.slice(cut + 2) };
    },
    /** Paths (relative to the project folder) that differ between two revisions. */
    async changed(from, to) {
      const prefix = located.prefix ?? '';
      const out = await must(['diff-tree', '-r', '-z', '--no-renames', '--name-only', ...(prefix ? [`--relative=${prefix}`] : []), from, to], { maxBytes: 64 * 1024 * 1024 });
      return [...new Set(out.split('\0').filter(Boolean))];
    },
    /**
     * A file's text as one revision holds it (a path relative to the project folder): its text; null when that revision
     * has no such file; undefined when it cannot be said (the revision is gone, the file is larger than `maxBytes`, or
     * git failed). The guard pass reads the file as the run began (C1), so null must mean "did not exist", never "could
     * not read".
     */
    async text(rev, path, { maxBytes = 1024 * 1024 } = {}) {
      const spec = `${rev}:${located.prefix ?? ''}${path}`;
      const size = await run(['cat-file', '-s', spec], { maxBytes: 64 });
      if (size.code !== 0) return (await run(['rev-parse', '-q', '--verify', `${rev}^{tree}`], { maxBytes: 256 })).code === 0 ? null : undefined;
      if (!(Number(size.stdout.trim()) <= maxBytes)) return undefined;
      const blob = await run(['cat-file', 'blob', spec], { maxBytes: maxBytes + 1 });
      return blob.code === 0 && !blob.truncated ? blob.stdout : undefined;
    },
    /**
     * The project folder as one revision held it, written into `dir` (an existing, empty folder): the tree a guard that
     * reads other files than its own is run against when it is asked what a file had before a run (C1). The files go in
     * through a throwaway index, so the repository's own index and refs are never touched. False when it cannot be
     * written (the revision is gone, git failed, the stop signal fired).
     */
    async materialize(rev, dir, { signal } = {}) {
      const prefix = (located.prefix ?? '').replace(/\/+$/, ''), spec = prefix ? `${rev}:${prefix}` : `${rev}^{tree}`;
      const holder = await mkdtemp(join(tmpdir(), 'rna-base-index-'));
      try {
        const result = await run(['read-tree', '-u', '--reset', spec], { cwd: dir, env: { GIT_WORK_TREE: dir, GIT_INDEX_FILE: join(holder, 'index') }, signal });
        return result.code === 0 && !result.timedOut;
      } catch (error) { if (signal?.aborted) throw error; return false; }
      finally { await rm(holder, { recursive: true, force: true }).catch(() => {}); }
    },
  };
}

/** The windows a hold commit's message records ([[startMs, endMs|null], …]); empty when it is not one of ours. */
function holdWindows(message) {
  try { const value = JSON.parse(String(message).trim()); return value?.kind === HOLD && Array.isArray(value.windows) ? value.windows.filter(row => Array.isArray(row) && Number.isFinite(row[0])) : []; } catch { return []; }
}
const holdMessage = (turnId, windows) => JSON.stringify({ kind: HOLD, turnId, windows });
/**
 * Windows with every open one but the last closed where the next one begins; with `at`, the last open one is closed
 * there too (the start of the attempt that follows it).
 */
function closeOpen(windows, at) {
  return windows.map(([from, to], index) => [from, Number.isFinite(to) ? to : Number.isFinite(windows[index + 1]?.[0]) ? windows[index + 1][0] : Number.isFinite(at) ? Math.max(from, at) : null]);
}

export class TurnCheckpoint {
  /**
   * @param {import('./store.mjs').Store} store
   * @param {{ engine?: import('./git-isolation/index.mjs').IsolationEngine, roots?: import('./workspace-roots.mjs').RootResolver, git?: import('./workspace-git-service.mjs').WorkspaceGitService, now?: () => number, waitMs?: number }} [options]
   *   `git` defaults to the engine's WorkspaceGitService.
   */
  constructor(store, { engine = null, roots = null, git = null, now = Date.now, waitMs } = {}) {
    Object.assign(this, { store, engine, roots, now, waitMs });
    this.git = git;
    /** turn id → the running attempt's handle */
    this.handles = new Map();
  }
  say(variants) { return inLanguage(interfaceLanguageOf(this.store.state), variants); }
  gitService() { return this.git ?? this.engine?.gitService?.() ?? null; }
  limit() { return Number.isFinite(this.waitMs) ? this.waitMs : LIMITS.checkpointWaitMs; }
  missing() {
    return Object.assign(new Error(this.say({ zh: '这一轮没有检查点，不能整轮回退。', en: 'This turn has no checkpoint, so it can’t be rolled back as a whole.' })), { status: 409, code: 'turn_checkpoint_missing' });
  }

  /**
   * Begin the start snapshot of a direct-mode turn (non-git projects, plan mode and worktree sessions: an immediate
   * `skipped` handle with no snapshot).
   * @param {{ projectId: string, sessionId: string, turnId: string, onWait?: (ms: number) => void }} turn
   *   `onWait`: told how long a write actually waited at the gate for the start snapshot (turn.timing.checkpointWait,
   *   review ISO-8); not called when the snapshot was ready already.
   * @returns {CheckpointHandle}
   */
  start({ projectId, sessionId, turnId, onWait = null }) {
    const state = this.store.state, project = state.projects.find(row => row.id === projectId), session = state.sessions.find(row => row.id === sessionId);
    const row = session?.turns.find(item => item.id === turnId);
    const handle = { projectId, sessionId, turnId, startedAt: this.now(), settled: false, timedOut: false, result: null, onWait };
    const skip = (reason, record) => { handle.result = { state: 'skipped', reason, record }; handle.settled = true; handle.ready = Promise.resolve(handle.result); };
    if (!this.engine || !project || !session || !row) skip('no_repository', false);
    // Not this checkpoint's turns: worktree sessions (turn.apply), plan mode and side chats (read only).
    else if (session.worktree || session.kind === 'side' || row.mode === 'plan') skip('read_only', false);
    else if (!toolPermitted(project, { permission: 'write' }, 'foreground')) skip('read_only', true);
    // An earlier attempt of this turn wrote without a checkpoint: a later start would cover only part of the turn.
    else if (row.checkpoint?.state === 'skipped' && ['timeout', 'snapshot_failed'].includes(row.checkpoint.reason)) skip(row.checkpoint.reason, true);
    else {
      handle.ready = this.capture(handle).catch(error => ({ state: 'skipped', reason: error?.code === 'snapshot_timeout' ? 'timeout' : 'snapshot_failed', record: true, error }));
      void handle.ready.then(result => { handle.result = result; handle.settled = true; });
    }
    handle.gate = inner => gateOn(() => this.wait(handle), inner);
    this.handles.set(turnId, handle);
    return { ready: handle.ready.then(({ commit, state, reason }) => ({ ...(commit ? { commit } : {}), state, ...(reason ? { reason } : {}) })), gate: handle.gate };
  }

  /** Wait for a handle's start snapshot within LIMITS.checkpointWaitMs of its start; past that it is skipped. */
  async wait(handle) {
    if (handle.settled) return;
    const began = Date.now();
    await bounded(handle.ready, handle.startedAt + this.limit() - this.now());
    if (!handle.settled) handle.timedOut = true;
    try { handle.onWait?.(Date.now() - began); } catch { /* timing is best effort */ }
  }

  /** The start snapshot of one attempt, pinned at REFS.turn(turnId) as a hold with one parent (the turn's start). */
  async capture(handle) {
    const git = this.gitService(), located = await git.locateProject(handle.projectId);
    if (located.repo === 'none') return { state: 'skipped', reason: 'no_repository', record: false };
    const objects = objectGit(git, located), ref = REFS.turn(handle.turnId);
    const root = { root: located.workspace, kind: 'project', isolated: false, project: located.workspace, prefix: located.prefix ?? '' };
    // Under the repository lock: a host write into P (another conversation's apply, a background run, a rollback) is
    // either wholly before the start or wholly after it, never half in it; one after it is excluded by its record.
    const take = () => this.engine.snapshot(handle.projectId, root);
    const [previous, snapshot] = await Promise.all([objects.read(ref), typeof this.engine.lock === 'function' ? this.engine.lock(handle.projectId, take) : take()]);
    let start = snapshot.commit, windows = [];
    if (previous) {
      windows = holdWindows(previous.message);
      if (previous.parents.length >= 2) {
        // A previous attempt ended: what changed between its end and now was not this turn's work.
        const [first, end] = previous.parents, gap = await objects.changed(end, snapshot.commit);
        start = gap.length ? await objects.commit(await this.engine.syncBase(handle.projectId, { current: first, previous: snapshot.commit, paths: gap }), [snapshot.commit], 'Rna turn start') : first;
      } else if (previous.parents.length === 1) start = previous.parents[0]; // an attempt cut off by a restart: its start stands
    }
    if (handle.timedOut) return { state: 'skipped', reason: 'timeout', record: true };
    // An attempt a restart cut off left its window open; it ended no later than this one began (review ISO-7), so
    // both readers of the windows (attributable, rollbackTurn's inside) see the same, closed, span.
    windows = closeOpen(windows, handle.startedAt);
    windows = [...windows, [handle.startedAt, null]].slice(-20);
    const hold = await objects.commit(`${start}^{tree}`, [start], holdMessage(handle.turnId, windows));
    await this.engine.pin(handle.projectId, [{ ref, commit: hold }]);
    return { commit: start, state: 'taken', record: true, root, located };
  }

  /**
   * The end snapshot and the hold ref; records turn.checkpoint.
   * @param {{ projectId: string, sessionId: string, turnId: string }} turn
   * @returns {Promise<TurnCheckpointState|null>}  null when this turn has no checkpoint to record
   */
  async end({ projectId, sessionId, turnId }) {
    const began = Date.now(), timing = () => ({ checkpointEnd: Math.max(0, Date.now() - began) });
    const handle = this.handles.get(turnId);
    this.handles.delete(turnId);
    if (!handle) return null;
    let result = handle.timedOut ? { state: 'skipped', reason: 'timeout', record: true } : await handle.ready;
    if (handle.timedOut && result.state === 'taken') result = { state: 'skipped', reason: 'timeout', record: true };
    if (!result.record) return null;
    if (result.state !== 'taken') {
      // A start that came too late (or failed) covers nothing: no hold ref may suggest otherwise.
      if (result.reason === 'timeout' || result.reason === 'snapshot_failed') await this.drop(projectId, turnId);
      return this.record(sessionId, turnId, { state: 'skipped', reason: result.reason });
    }
    try {
      const git = this.gitService(), objects = objectGit(git, result.located), ref = REFS.turn(turnId);
      // Under the repository lock, as the start is (review ISO-3): a host write into P (a worker's merge, a deferred
      // background set) is either wholly before the end snapshot, with its record's `at` inside the window, or wholly
      // after both — never half in the snapshot while counted as during the turn. The engine's pin is re-entrant.
      const close = async () => {
        const end = await this.engine.snapshot(projectId, result.root), hold = await objects.read(ref);
        const windows = closeOpen(holdWindows(hold?.message), null), endedAt = this.now();
        if (windows.length) windows[windows.length - 1] = [windows.at(-1)[0], endedAt];
        const commit = await objects.commit(end.tree, [result.commit, end.commit], holdMessage(turnId, windows.length ? windows : [[handle.startedAt, endedAt]]));
        await this.engine.pin(projectId, [{ ref, commit }]);
        return endedAt;
      };
      const endedAt = typeof this.engine.lock === 'function' ? await this.engine.lock(projectId, close) : await close();
      // `endedAt`: this attempt's end is in the hold. A later attempt of the turn (a retry, a resume) records its own,
      // so what was read of the turn's changes for an earlier attempt is read again.
      return this.record(sessionId, turnId, { ref, state: 'taken', endedAt: new Date(endedAt).toISOString() }, timing());
    } catch (error) {
      console.warn(`turn checkpoint ${turnId}: ${error.message}`);
      await this.drop(projectId, turnId);
      return this.record(sessionId, turnId, { state: 'skipped', reason: 'snapshot_failed' }, timing());
    }
  }
  async drop(projectId, turnId) { await this.engine?.pin(projectId, [{ ref: REFS.turn(turnId), commit: null }]).catch(() => {}); }
  /**
   * turn.checkpoint, written whatever the turn's status is now; `timing` (turn.timing.checkpointEnd, review ISO-8: how
   * long the end snapshot and the hold took) rides the same state write.
   */
  record(sessionId, turnId, checkpoint, timing = null) {
    try {
      this.store.mutate(state => { const turn = state.sessions.find(row => row.id === sessionId)?.turns.find(row => row.id === turnId); if (turn) { turn.checkpoint = { ...checkpoint }; if (timing) turn.timing = { ...turn.timing, ...timing }; } });
    } catch { /* the conversation is gone */ }
    return checkpoint;
  }

  /**
   * The paths a direct-mode turn may roll back (design §5.1): paths changed between start and end, minus paths
   * written in that interval by apply records of other owners (`source.turnId` not this turn). IsolationEngine
   * receives this as its `attributable` option for rollbackTurn.
   * @param {string} projectId
   * @param {string} turnId
   * @returns {Promise<{ start: string, end: string, paths: string[], excluded: { path: string, applyId: string }[] }>}
   *   `turn_checkpoint_missing` (409) when the turn has none.
   */
  async attributable(projectId, turnId) {
    const state = this.store.state, project = state.projects.find(row => row.id === projectId);
    if (!project) throw Object.assign(new Error(this.say({ zh: '项目不存在。', en: 'This project no longer exists.' })), { status: 404, code: 'project_not_found' });
    const row = state.sessions.filter(session => session.projectId === projectId).flatMap(session => session.turns).find(turn => turn.id === turnId);
    // A turn whose checkpoint was skipped (or a worktree session's turn) has none, whatever a ref says.
    if (row && row.checkpoint?.state !== 'taken') throw this.missing();
    const git = this.gitService(), located = await git.locateProject(projectId);
    if (located.repo === 'none') throw this.missing();
    const objects = objectGit(git, located), hold = await objects.read(REFS.turn(turnId));
    const windows = holdWindows(hold?.message);
    if (!hold || hold.parents.length < 2 || !windows.length) throw this.missing();
    const [start, end] = hold.parents;
    return this.ownPaths(project, turnId, objects, { start, end, windows });
  }
  /**
   * The paths a direct-mode turn has changed so far (C1, the guard pass at the end of a turn): attributable()'s answer
   * with the project folder as it is now as the end, taken in a snapshot no ref keeps. The turn's checkpoint is still
   * open, so its hold ref has one parent, the start. `read(path)` is a file's text at that start, the baseline a
   * guard's old hits are counted against (ObjectGit#text); `materialize(dir)` writes the whole folder as of that start
   * (ObjectGit#materialize), what a guard that reads other files is run against for the same baseline. Null when the
   * turn has no checkpoint taken.
   * It has attributable()'s limit, which rollbackTurn states too: only what another owner's apply record wrote during
   * the turn's attempts is left out, so a file the user changes in an editor while the turn runs, which no record
   * says anything about, cannot be told from the turn's own.
   * @param {string} projectId
   * @param {string} turnId
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<{ start: string, end: string, paths: string[], excluded: { path: string, applyId: string }[], read: (path: string) => Promise<string|null|undefined>, materialize: (dir: string, options?: { signal?: AbortSignal }) => Promise<boolean> } | null>}
   */
  async progress(projectId, turnId, { signal } = {}) {
    const handle = this.handles.get(turnId);
    if (!handle || handle.timedOut) return null;
    // The start snapshot is normally long done (a turn that ran a command waited for it at the gate); a slow one is
    // waited for within the same bound as the gate's, never longer.
    await this.wait(handle);
    const result = handle.settled && !handle.timedOut ? handle.result : null;
    if (!result || result.state !== 'taken' || !result.root || !result.located) return null;
    const project = this.store.state.projects.find(row => row.id === projectId);
    if (!project) return null;
    const objects = objectGit(this.gitService(), result.located), hold = await objects.read(REFS.turn(turnId));
    const windows = holdWindows(hold?.message);
    if (!hold || !hold.parents.length || !windows.length) return null;
    // Under the repository lock, as the checkpoint's own snapshots are: a host write into the project folder (a
    // worker's merge, another conversation's apply) is wholly before this snapshot or wholly after it.
    const take = () => this.engine.snapshot(projectId, result.root, { signal });
    const end = typeof this.engine.lock === 'function' ? await this.engine.lock(projectId, take) : await take();
    const start = hold.parents[0], own = await this.ownPaths(project, turnId, objects, { start, end: end.commit, windows });
    return { ...own, read: path => objects.text(start, path), materialize: (dir, options) => objects.materialize(start, dir, options) };
  }
  /**
   * attributable()'s body: the paths changed between `start` and `end`, minus those another owner's apply record wrote
   * during one of the turn's attempt windows (an apply the user or another conversation made through the host). Other
   * writes into the folder meanwhile (an editor, another process) leave no record and are not told apart: the limit
   * rollbackTurn states to the user.
   */
  async ownPaths(project, turnId, objects, { start, end, windows }) {
    const changed = await objects.changed(start, end), own = new Set(changed);
    const spans = windows.map(([from, to]) => [from, Number.isFinite(to) ? to : null]);
    // Nothing changed (a turn that only read or talked): no other owner's record needs reading.
    if (!changed.length) return { start, end, paths: [], excluded: [], windows: spans };
    // An open window (an attempt a restart cut off, recorded before capture() closed them) ends where the next one
    // begins, as rollbackTurn's inside() reads it (review ISO-7); only the last one may still be open.
    const during = at => windows.some(([from, to], index) => at >= from && at <= (to ?? windows[index + 1]?.[0] ?? Number.MAX_SAFE_INTEGER));
    const others = (project.git?.applies ?? []).filter(item => item.target === 'project' && item.source?.turnId !== turnId && during(Date.parse(item.at)));
    const excluded = [];
    for (const other of others) {
      for (const path of await this.writtenBy(project.id, other)) if (own.has(path) && !excluded.some(item => item.path === path)) excluded.push({ path, applyId: other.id });
    }
    const out = new Set(excluded.map(item => item.path));
    // windows (additive): when the turn's attempts ran, so the rollback marks only the records written inside them.
    return { start, end, paths: changed.filter(path => !out.has(path)), excluded, windows: spans };
  }
  /** The paths an apply record wrote (its full list while its checkpoint exists, else its sample). */
  async writtenBy(projectId, row) {
    try { const detail = await this.engine.applyDetail(projectId, row.id); return detail.paths.map(item => item.path); }
    catch { return [...(row.sample ?? []), ...(row.pending ?? [])]; }
  }
}
