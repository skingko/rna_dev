import { FEEDBACK_SOURCES, LIMITS, MERGE_LABELS, MODEL_TEXT, REFS, TEXT_CONFLICT_KINDS, USER_ONLY_CONFLICTS, notMergedOf } from './git-isolation/index.mjs';

// Background worktrees (worktree design 0.63 §4.3, §8). Owner: T5. Background work with write access in a git project
// (initiative work, scheduled runs, directHandle) runs in its own worktree B (`b-<actionId 8>`); when it ends, the host
// applies B into the project folder P through the merge engine, so every write into P has a checkpoint first (§0.3-1),
// goes file by file with CAS (§0.3-2), and never carries a conflict marker (§0.3-3).
//
// This module holds the git side: opening (or, for a paused run, reopening) B, the run's finish hook (the same flow
// as a session's turn end, §4.2 step 3: target P, source B, base = seed; at most LIMITS.applyContinuations host
// continuations, each after a reverse merge that writes markers into B only), the end-of-run settlement (only the
// clean part when the run did not finish: failed, cancelled, stopped, step limit), the conflict card's choices, the
// change set handed to a conversation (`agent_merge({ changeId })`) and rollbacks through apply records. Lines,
// rows and cards in the conversation are the controller's (project-initiative-controller.mjs).
//
// Nothing here decides meaning: whether something conflicts, is resolved, still holds markers or may be written is
// computed by the engine and by code.

/** Marker labels of the reverse merge P → B (the run's own copy, then the project folder's changes). */
export const BACKGROUND_REVERSE_LABELS = Object.freeze({ current: 'this-background-work', incoming: 'project-folder' });
/** Labels of the restore of unresolved marked files to their version before the reverse merge. */
const RESTORE_LABELS = Object.freeze({ current: 'current', incoming: 'background-restore' });
/** How long an isolation answer is reused for the synchronous projection (the decision's contract text). */
const ISOLATION_TTL_MS = 30000;
/** Files listed on a change set's row (the rest are counted only). */
const FILES_LISTED = 200;
/** Conflicts of a change set handed to a conversation kept with their sides (agent_merge show / take need them). */
const HANDOFF_CONFLICTS = 100;
/** Secret files (B8) named on a change set's row and line at most. */
const SECRET_LISTED = 50;
/**
 * The files that hold secrets (SECRET_FILES) B's owner changed: a snapshot's `secret` (an untouched laid-down copy is
 * not one, snapshot.mjs secretChanged). No apply carries them into P and B's removal moves them to the trash
 * (WorktreeService.remove), so the outcome names them for the change set's line (B8).
 */
const secretOf = tip => [...new Set(tip?.secret ?? [])].slice(0, SECRET_LISTED);
const withSecret = (outcome, secret) => (secret.length ? { ...outcome, secret } : outcome);
const brief = conflicts => (conflicts ?? []).map(row => ({ path: row.path, kind: row.kind }));
const sides = conflict => ({ path: conflict.path, kind: conflict.kind, ...(conflict.base ? { base: conflict.base } : {}), ...(conflict.current ? { current: conflict.current } : {}), ...(conflict.incoming ? { incoming: conflict.incoming } : {}), ...(conflict.marked ? { marked: conflict.marked } : {}) });
const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
/** agent_merge({ changeId }) refused while the user's git operation runs in the project folder (model-facing, English). */
const operationRefusal = operation => failure('git_operation_in_progress', `A git ${operation ?? 'operation'} is in progress in the project folder (the user's own merge, rebase or similar), so nothing was written there. Leave this change set for now: call agent_merge again after the user finishes or aborts that operation.`, { operation: operation ?? null });
/** The engine refused a write into the project folder because of a git operation there (apply / take with `hold`). */
const heldByOperation = error => error?.code === 'git_operation_in_progress';

/**
 * @typedef {import('./git-isolation/contract.mjs').RootInfo} RootInfo
 *
 * @typedef {object} BackgroundRun  One B in use (in memory; its merge state is also kept on its worktree record, so a
 *   paused run, a restart or a card answer picks it up again).
 * @property {string} projectId
 * @property {string} actionId     owner.actionId of the record (a directHandle fix: `<actionId>-direct`)
 * @property {string} worktreeId
 * @property {RootInfo} root
 * @property {{ current: string, incoming: string }} labels  MERGE_LABELS.background(actionId)
 * @property {{ actionId: string, worktreeId: string }} source
 * @property {string} base         Merge base of what B has not applied yet (a commit; the seed at first).
 * @property {string|null} priorBase  The base before the last reverse merge (unresolved marked files go back to it).
 * @property {string|null} preMerge   B before the last reverse merge (the "background version" of those files).
 * @property {string|null} mid     The last reverse merge (its markers label refs/rna/m/<mid>/…).
 * @property {string[]} mids       Every reverse merge into this B: no file holding one of their marker lines is applied.
 * @property {{ path: string, sha: string|null }[]} marked  Files written with that merge's markers, and their sha256 then.
 * @property {{ path: string, kind: string }[]} nonText      Its other conflicts (never written; the user decides).
 * @property {number} attempts     Host continuations used for conflicts in this run (≤ LIMITS.applyContinuations).
 * @property {string[]} applyIds   Apply records written into P for this change set.
 * @property {Map<string, { path: string, deleted?: true }>} files  Files those records wrote or removed.
 * @property {boolean} unverified  A record's check after writing found a difference.
 * @property {object|null} outcome The finish hook's last answer: { status: 'applied'|'nothing'|'held'|'conflicted', … }.
 * @property {boolean} [cleanOnly] The run ended on the host's step-limit conclusion: only the clean part is applied.
 */

export class BackgroundWorktrees {
  /**
   * @param {import('./store.mjs').Store} store
   * @param {{ engine?: import('./git-isolation/index.mjs').IsolationEngine, worktrees?: import('./worktree-service.mjs').WorktreeService, roots?: import('./workspace-roots.mjs').RootResolver, now?: () => number }} [options]
   */
  constructor(store, { engine = null, worktrees = null, roots = null, now = Date.now } = {}) {
    Object.assign(this, { store, engine, worktrees, roots, now });
    /** projectId → { enabled, at } */
    this.answers = new Map();
    /** Aborted when the controller closes: an apply waiting for the project folder (a git merge or rebase the user has
     * open, Rna's own commands still running) stops waiting instead of holding the shutdown; the B it came from stays,
     * and the next start settles it (recoverWorktrees). */
    this.stopping = new AbortController();
  }
  /** The services are wired (L at integration; tests). Without them every background run keeps 0.62's behaviour. */
  ready() { return Boolean(this.engine && this.worktrees && this.roots); }
  /**
   * The user's git operation in progress in the project folder (merge, rebase, …), or null. Nothing of a change set is
   * written into the folder, nor merged against its half-done state, while one runs: the set is held (`git_operation`)
   * and applied once it ends (review ISO-1).
   */
  async operation(projectId) { try { return (await this.engine?.projectBusy?.(projectId)) ?? null; } catch { return null; } }
  project(projectId) { return this.store.state.projects.find(row => row.id === projectId) ?? null; }

  /**
   * Whether this project's background work runs in worktrees now (design §2, via IsolationEngine.isolation). False
   * when the services are not wired, isolation is off (ISOLATION_READY, no repository, git, sandbox, drivers) or the
   * check fails.
   * @returns {Promise<boolean>}
   */
  async enabled(projectId) {
    if (!this.ready() || !this.project(projectId)) return false;
    let enabled = false;
    try { enabled = (await this.engine.isolation(projectId))?.enabled === true; } catch { enabled = false; }
    this.answers.set(projectId, { enabled, at: this.now() });
    return enabled;
  }
  /** The last answer of enabled() (synchronous; false until one was given). Refreshed in the background when stale. */
  known(projectId) {
    const answer = this.answers.get(projectId);
    if (!answer || this.now() - answer.at > ISOLATION_TTL_MS) void this.enabled(projectId).catch(() => {});
    return answer?.enabled === true;
  }

  /** The background worktree record an action owns (any state but removed), or null. */
  recordFor(projectId, actionId) {
    return (this.project(projectId)?.git?.worktrees ?? []).find(row => row.kind === 'background' && row.owner?.actionId === actionId && row.state !== 'removed') ?? null;
  }
  async projectRoot(projectId) { return this.roots.rootOf({ projectId }); }

  /**
   * B for a run: its own (a paused run resumes in the same B, design §8 `pausedWorktrees`), else a new one made from
   * P's current files (uncommitted and untracked ones included). Never falls back to P: a failure throws.
   * @param {string} projectId
   * @param {string} actionId
   * @param {{ label?: string, signal?: AbortSignal }} [options]
   * @returns {Promise<BackgroundRun>}
   */
  async open(projectId, actionId, { label, signal } = {}) {
    let record = this.recordFor(projectId, actionId);
    if (!record) {
      const parent = await this.projectRoot(projectId);
      const space = await this.worktrees.checkSpace(projectId, parent);
      if (!space.ok) throw failure('worktree_create_failed', 'Not enough free disk space for a background worktree.', { status: 507, reason: 'space', freeBytes: space.freeBytes, needBytes: space.needBytes });
      record = await this.worktrees.create(projectId, { kind: 'background', owner: { actionId }, parent, label: label ?? `Rna background ${actionId}`, signal });
    } else if (record.state !== 'active') {
      // An earlier copy of this work still waits for the user (kept, conflicted) or is gone (missing): a second one for
      // the same action would make its root ambiguous, so the run does not start.
      throw failure('worktree_create_failed', 'An earlier working copy of this background work is still kept.', { status: 409, reason: record.state });
    }
    return this.load(projectId, this.recordFor(projectId, actionId));
  }

  /** A run object for an existing record (its saved merge state included). */
  async load(projectId, record) {
    const root = await this.roots.rootOf({ projectId, actionId: record.owner.actionId });
    const saved = record.merge ?? {};
    return {
      projectId, actionId: record.owner.actionId, worktreeId: record.id, root, labels: MERGE_LABELS.background(record.owner.actionId),
      source: { actionId: record.owner.actionId, worktreeId: record.id },
      base: record.base ?? record.seed, priorBase: saved.priorBase ?? null, preMerge: saved.preMerge ?? null, mid: saved.mid ?? null, mids: [...(saved.mids ?? [])],
      marked: saved.marked ?? [], nonText: saved.nonText ?? [], attempts: saved.attempts ?? 0, applyIds: [...(saved.applyIds ?? [])],
      files: new Map((saved.files ?? []).map(row => [row.path, row])), unverified: saved.unverified === true, outcome: null,
    };
  }
  rowOf(state, projectId, worktreeId) { return state.projects.find(row => row.id === projectId)?.git?.worktrees?.find(row => row.id === worktreeId); }

  /** Keep a run's merge state on its record (and its base pinned at REFS.worktree(id, 'base')). */
  async persist(bg) {
    const merge = { attempts: bg.attempts, mid: bg.mid, mids: bg.mids, marked: bg.marked, nonText: bg.nonText, priorBase: bg.priorBase, preMerge: bg.preMerge, applyIds: bg.applyIds, files: [...bg.files.values()].slice(0, FILES_LISTED), ...(bg.unverified ? { unverified: true } : {}) };
    this.store.mutate(state => { const row = this.rowOf(state, bg.projectId, bg.worktreeId); if (row) { row.base = bg.base; row.merge = structuredClone(merge); } });
    await this.engine.pin(bg.projectId, [{ ref: REFS.worktree(bg.worktreeId, 'base'), commit: bg.base }]);
  }

  /** B's files now, pinned as its tip. */
  async tip(bg, signal) { return this.engine.snapshot(bg.projectId, bg.root, { pin: REFS.worktree(bg.worktreeId, 'tip'), signal }); }
  /** The tree of a commit or tree. */
  async treeOf(projectId, rev) { return this.engine.compose(projectId, rev, []); }
  /**
   * A commit holding `tree` (a base must be a commit so a ref can pin it); `parents` keep earlier states reachable
   * through it (the base before a reverse merge, B before it), so one ref pins them all.
   */
  async commitOf(projectId, tree, parents = []) {
    const git = this.engine.gitService(), root = await this.projectRoot(projectId);
    const result = await git.run(root.root, ['commit-tree', tree, ...[...new Set(parents.filter(Boolean))].flatMap(parent => ['-p', parent]), '-m', 'Rna background merge base'], { engine: true, timeoutMs: 30000 });
    const commit = result.stdout.trim();
    if (result.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) throw failure('engine_failed', `commit-tree failed: ${result.stderr.trim().slice(-300)}`);
    return commit;
  }
  /** Whether B has nothing beyond its base. */
  async unchanged(bg, tip) { return tip.tree === await this.treeOf(bg.projectId, bg.base); }

  /**
   * One apply of B into P (design §4.3): `all`, or `all` + cleanOnly at a hand-back; records what it wrote. A file of B
   * still holding a marker line of one of its reverse merges is never written (invariant §0.3-3): with cleanOnly it
   * is left out and reported as a conflict, otherwise nothing is written. It never waits for the user's git operation
   * in P: one going on (or starting before the write) answers `{ status: 'held', reason: 'git_operation', operation }`
   * with nothing written.
   */
  async apply(bg, tip, { cleanOnly = false, base = bg.base, signal: given } = {}) {
    const signal = given ? AbortSignal.any([given, this.stopping.signal]) : this.stopping.signal;
    const target = await this.projectRoot(bg.projectId);
    const strays = await this.strayMarkers(bg, tip, base), stray = strays.map(path => ({ path, kind: 'content' }));
    if (strays.length && !cleanOnly) return { status: 'conflicted', applyId: null, written: [], removed: [], conflicts: stray, notMerged: [], bothChanged: 0, verify: null, dependencies: false };
    const incoming = strays.length ? await this.engine.syncBase(bg.projectId, { current: tip.commit, previous: base, paths: strays }) : tip.commit;
    let outcome;
    try { outcome = await this.engine.apply(bg.projectId, { target, base, incoming, kind: 'background', source: bg.source, mode: 'all', cleanOnly, labels: bg.labels, incomingRoot: bg.root, notMerged: notMergedOf(tip), signal, hold: true }); }
    catch (error) { if (heldByOperation(error)) return { status: 'held', reason: 'git_operation', operation: error.operation ?? null, applyId: null, written: [], removed: [], conflicts: [], notMerged: [], bothChanged: 0, verify: null, dependencies: false }; throw error; }
    this.note(bg, outcome);
    // Everything B had is in P now: what B holds is the base of anything it does next.
    if (['applied', 'nothing'].includes(outcome.status) && !outcome.conflicts?.length && !strays.length) bg.base = tip.commit;
    await this.persist(bg);
    return strays.length ? { ...outcome, status: outcome.status === 'blocked' ? 'blocked' : 'conflicted', conflicts: [...(outcome.conflicts ?? []), ...stray] } : outcome;
  }
  /** Paths B changed between two states (root paths, relative to the project folder). */
  async changedPaths(bg, from, to) {
    const root = await this.projectRoot(bg.projectId);
    const result = await this.engine.gitService().run(root.root, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', '--relative', from, to], { engine: true, maxBytes: 64 * 1024 * 1024, timeoutMs: 60000 });
    if (result.code !== 0 || result.truncated) throw failure('engine_failed', `diff-tree failed: ${result.stderr.trim().slice(-300)}`);
    return result.stdout.split('\0').filter(Boolean);
  }
  /**
   * Files B changed since `base` that hold a marker line of one of its reverse merges (hasMergeMarkers, through
   * IsolationEngine.resolved): they are never applied to P. Only a B that had a reverse merge can hold one.
   */
  async strayMarkers(bg, tip, base = bg.base) {
    if (!bg.mids.length) return [];
    const paths = await this.changedPaths(bg, base, tip.commit);
    if (!paths.length) return [];
    const found = new Set();
    for (const mid of bg.mids) {
      const check = await this.engine.resolved(bg.projectId, { target: bg.root, mid, conflicts: paths.map(path => ({ path, currentSha256: null, taken: true })) });
      for (const row of check.remaining) found.add(row.path);
    }
    return [...found];
  }
  note(bg, outcome) {
    if (outcome.applyId && !bg.applyIds.includes(outcome.applyId)) bg.applyIds.push(outcome.applyId);
    for (const path of outcome.written ?? []) bg.files.set(path, { path });
    for (const path of outcome.removed ?? []) bg.files.set(path, { path, deleted: true });
    if (outcome.verify === 'unverified') bg.unverified = true;
  }
  feedback(mid, files, nonText) { return { feedback: [{ source: FEEDBACK_SOURCES.worktreeApply, text: MODEL_TEXT.worktreeApplyFeedback({ mid, files, nonText }) }] }; }

  /**
   * The run's finish hook (SDK beforeFinish → createRnaRuntime hostFinish; design §4.2 step 3 for B → P). Answers
   * undefined (finish accepted) or `{ feedback }` (one more host continuation). The outcome is left on `bg.outcome`.
   * - Markers of the last reverse merge still in a file (or the file untouched): not applied; another continuation
   *   if one is left, else `conflicted`.
   * - `hold()` names why P must not be written now: 'deferred' (a direct-mode foreground turn holds the project
   *   folder, plan mode, maintenance) — the merge is still checked so a conflict is resolved inside the run — or
   *   'read_only' (no write access now): `held`. The user's git operation in P (merge, rebase, …) holds it as
   *   `git_operation`, found by code before anything is merged against the folder or written into it: the run
   *   finishes at once and its change set waits (review ISO-1).
   * - Clean → applied (`all` mode, one apply record). Conflicts with a continuation left → reverse merge P → B
   *   written with markers into B only, base := P's tree (non-text conflicts keep the old base), feedback
   *   MODEL_TEXT.worktreeApplyFeedback. Otherwise `conflicted` (P untouched).
   * @param {BackgroundRun} bg
   * @param {{ message?: object, remainingContinuations?: number, signal?: AbortSignal }} input
   * @param {{ hold?: () => (null|'deferred'|'read_only'), onMerging?: (files: string[]) => void }} [options]
   */
  async finish(bg, { message, remainingContinuations = 0, signal } = {}, { hold = () => null, onMerging } = {}) {
    // The host's step-limit conclusion is not a finish the run reached: only the clean part is applied (design §4.3).
    const stepLimit = message?.source === 'step-limit-summary';
    if (stepLimit) bg.cleanOnly = true;
    const canContinue = () => !stepLimit && remainingContinuations > 0 && bg.attempts < LIMITS.applyContinuations;
    if (bg.marked.length) {
      const check = await this.engine.resolved(bg.projectId, { target: bg.root, mid: bg.mid, conflicts: bg.marked.map(row => ({ path: row.path, currentSha256: row.sha })) });
      if (!check.resolved) {
        const files = check.remaining.map(row => row.path);
        if (canContinue()) { bg.attempts++; await this.persist(bg); return this.feedback(bg.mid, files, bg.nonText.map(row => row.path)); }
        bg.outcome = { status: 'conflicted', conflicts: [...files.map(path => ({ path, kind: 'content' })), ...bg.nonText] };
        return undefined;
      }
      bg.marked = []; bg.mid = null;
      await this.persist(bg);
    }
    const tip = await this.tip(bg, signal);
    if (await this.unchanged(bg, tip)) { bg.outcome = { status: bg.applyIds.length ? 'applied' : 'nothing' }; return undefined; }
    // A marker line of an earlier reverse merge left in any other file: not applied either (§0.3-3).
    const strays = await this.strayMarkers(bg, tip);
    if (strays.length) {
      if (canContinue()) { bg.attempts++; await this.persist(bg); return this.feedback(bg.mids.at(-1), strays, bg.nonText.map(row => row.path)); }
      bg.outcome = { status: 'conflicted', conflicts: [...strays.map(path => ({ path, kind: 'content' })), ...bg.nonText] };
      return undefined;
    }
    const held = hold();
    if (held === 'read_only') { bg.outcome = { status: 'held', reason: held }; return undefined; }
    // The user's merge / rebase / … in P: its files may be half merged, so the run neither merges against them nor
    // writes into them; the change set waits for the operation to end.
    const operation = await this.operation(bg.projectId);
    if (operation) { bg.outcome = { status: 'held', reason: 'git_operation', operation }; return undefined; }
    let conflicts;
    if (held) {
      const current = await this.engine.snapshot(bg.projectId, await this.projectRoot(bg.projectId), { signal });
      const merged = await this.engine.merge(bg.projectId, { base: bg.base, current: current.commit, incoming: tip.commit }, { labels: bg.labels, root: bg.root });
      if (!merged.conflicts.length) { bg.outcome = { status: 'held', reason: held }; return undefined; }
      conflicts = merged.conflicts;
    } else {
      const outcome = await this.apply(bg, tip, { cleanOnly: bg.cleanOnly === true, signal });
      if (outcome.status === 'held') { bg.outcome = { status: 'held', reason: outcome.reason, operation: outcome.operation }; return undefined; }
      if (outcome.status === 'blocked') { bg.outcome = { status: 'held', reason: 'blocked' }; return undefined; }
      if (outcome.status !== 'conflicted') { bg.outcome = { status: bg.applyIds.length ? 'applied' : 'nothing' }; return undefined; }
      conflicts = outcome.conflicts;
    }
    if (!canContinue()) { bg.outcome = { status: 'conflicted', conflicts: brief(conflicts) }; return undefined; }
    const merged = await this.reverseMerge(bg, tip, { signal });
    if (!merged.marked.length) { bg.outcome = { status: 'conflicted', conflicts: merged.nonText }; return undefined; }
    bg.attempts++;
    await this.persist(bg);
    try { onMerging?.(merged.marked); } catch { /* the line is a courtesy */ }
    return this.feedback(bg.mid, merged.marked, merged.nonText.map(row => row.path));
  }

  /**
   * P's changes merged into B, text conflicts written with markers (markers mode: B only). B before it is kept
   * (`preMerge`), the old base too (`priorBase`); the new base is P's tree except that paths not written keep their
   * old base entry, so they conflict again instead of being taken over silently (design §4.2 step 3).
   */
  async reverseMerge(bg, tip, { signal } = {}) {
    const current = await this.engine.snapshot(bg.projectId, await this.projectRoot(bg.projectId), { signal });
    let outcome;
    try { outcome = await this.engine.apply(bg.projectId, { target: bg.root, base: bg.base, incoming: current.commit, kind: 'background', source: bg.source, mode: 'markers', labels: BACKGROUND_REVERSE_LABELS, signal }); }
    catch (error) {
      // Stopped part way: whatever it wrote into B goes back to B as it was, so no marker of an unknown merge stays there.
      try { const now = await this.tip(bg); await this.engine.apply(bg.projectId, { target: bg.root, base: now.commit, incoming: tip.commit, kind: 'resolve', source: bg.source, mode: 'partial', labels: RESTORE_LABELS }); } catch { /* the error below stands */ }
      throw error;
    }
    const written = new Set(outcome.written ?? []);
    const marked = outcome.conflicts.filter(row => TEXT_CONFLICT_KINDS.includes(row.kind) && row.marked && written.has(row.path)).map(row => row.path);
    const nonText = brief(outcome.conflicts.filter(row => !marked.includes(row.path)));
    const tree = await this.engine.syncBase(bg.projectId, { current: current.commit, previous: bg.base, paths: nonText.map(row => row.path) });
    bg.priorBase = bg.base; bg.preMerge = tip.commit;
    bg.base = await this.commitOf(bg.projectId, tree, [bg.priorBase, bg.preMerge]);
    bg.mid = outcome.mid; bg.mids = [...bg.mids, outcome.mid];
    bg.marked = await Promise.all(marked.map(async path => ({ path, sha: await this.engine.fileSha256(bg.root, path) })));
    bg.nonText = nonText;
    return { marked, nonText };
  }

  /**
   * Files that still hold the last reverse merge's markers when the run is over go back to their version before it
   * (preMerge), and their base back to the old one: B never keeps markers once nobody is resolving them, so every
   * later apply (the card, agent_merge, the worktree panel) reads B's own work and conflicts there again.
   * @returns {Promise<string[]>}  the restored paths
   */
  async restoreMarked(bg) {
    if (!bg.marked.length) return [];
    const check = await this.engine.resolved(bg.projectId, { target: bg.root, mid: bg.mid, conflicts: bg.marked.map(row => ({ path: row.path, currentSha256: row.sha })) });
    const unresolved = check.remaining.map(row => row.path);
    bg.marked = []; bg.mid = null;
    if (unresolved.length && bg.preMerge && bg.priorBase) {
      const tip = await this.tip(bg);
      const incoming = await this.engine.syncBase(bg.projectId, { current: tip.commit, previous: bg.preMerge, paths: unresolved });
      await this.engine.apply(bg.projectId, { target: bg.root, base: tip.commit, incoming, kind: 'resolve', source: bg.source, mode: 'partial', labels: RESTORE_LABELS });
      const tree = await this.engine.syncBase(bg.projectId, { current: bg.base, previous: bg.priorBase, paths: unresolved });
      bg.base = await this.commitOf(bg.projectId, tree, [bg.base]);
      bg.nonText = [...bg.nonText.filter(row => !unresolved.includes(row.path)), ...unresolved.map(path => ({ path, kind: 'content' }))];
    }
    await this.persist(bg);
    return unresolved;
  }

  /**
   * Other files of B holding a marker line of its reverse merges, once the run is over: put back to their base
   * version in B (a recorded write into B), so no later apply from B — the card, agent_merge, the worktree panel —
   * can carry one into P (§0.3-3). Answers those paths; they are reported as not applied.
   */
  async neutralizeStrays(bg) {
    const tip = await this.tip(bg), strays = await this.strayMarkers(bg, tip);
    if (!strays.length) return [];
    const incoming = await this.engine.syncBase(bg.projectId, { current: tip.commit, previous: bg.base, paths: strays });
    await this.engine.apply(bg.projectId, { target: bg.root, base: tip.commit, incoming, kind: 'resolve', source: bg.source, mode: 'partial', labels: RESTORE_LABELS });
    await this.persist(bg);
    return strays;
  }

  /**
   * The end of a run (design §4.3): a run that finished settles what its finish hook found; one that did not
   * (failed, cancelled, stopped, a step limit without a finish) applies only the clean part. Marker lines left in B
   * are taken out of it first and their files reported as conflicts. `hold()` as in finish().
   * `secret`: the files that hold secrets B's owner changed (B8), whatever the status: never applied, so the line names them.
   * @param {BackgroundRun} bg
   * @param {{ completed: boolean, hold?: () => (null|'deferred'|'read_only') }} options
   * @returns {Promise<{ status: 'nothing'|'applied'|'held'|'conflicted', reason?: string, conflicts?: object[], cleanOnly?: boolean, secret?: string[] }>}
   */
  async settle(bg, { completed, hold = () => null }) {
    await this.restoreMarked(bg);
    const stray = (await this.neutralizeStrays(bg)).map(path => ({ path, kind: 'content' }));
    const tip = await this.tip(bg);
    return withSecret(await this.settleTip(bg, tip, stray, { completed, hold }), secretOf(tip));
  }
  async settleTip(bg, tip, stray, { completed, hold }) {
    const withStray = outcome => (!stray.length ? outcome : outcome.status === 'held' ? { ...outcome, conflicts: stray } : { status: 'conflicted', conflicts: [...(outcome.conflicts ?? []), ...stray] });
    if (await this.unchanged(bg, tip)) return withStray({ status: bg.applyIds.length ? 'applied' : 'nothing' });
    const cleanOnly = !completed || bg.cleanOnly === true;
    // The user's git operation in P: nothing is merged against its half-done files or written into them now; the set
    // is held and settled again once the operation ends (a write-access hold, read_only, goes to the card instead).
    if (hold() !== 'read_only') {
      const operation = await this.operation(bg.projectId);
      if (operation) return withStray({ status: 'held', reason: 'git_operation', operation, cleanOnly });
    }
    if (!cleanOnly && (bg.outcome?.status === 'conflicted' || stray.length)) {
      // The hook ran out of continuations: P stays untouched and the card decides (design §4.3 "仍有冲突").
      const current = await this.engine.snapshot(bg.projectId, await this.projectRoot(bg.projectId));
      const merged = await this.engine.merge(bg.projectId, { base: bg.base, current: current.commit, incoming: tip.commit }, { labels: bg.labels, root: bg.root });
      if (merged.conflicts.length || stray.length) return { status: 'conflicted', conflicts: [...brief(merged.conflicts), ...stray] };
      return this.settleApply(bg, tip, { cleanOnly: false, hold });
    }
    return withStray(await this.settleApply(bg, tip, { cleanOnly, hold }));
  }
  async settleApply(bg, tip, { cleanOnly, hold }) {
    const held = hold();
    if (held) return { status: 'held', reason: held, cleanOnly };
    const operation = await this.operation(bg.projectId);
    if (operation) return { status: 'held', reason: 'git_operation', operation, cleanOnly };
    const outcome = await this.apply(bg, tip, { cleanOnly });
    if (outcome.status === 'held') return { status: 'held', reason: outcome.reason, operation: outcome.operation, cleanOnly };
    if (outcome.status === 'blocked') return { status: 'held', reason: 'blocked', cleanOnly };
    if (outcome.conflicts?.length) return { status: 'conflicted', conflicts: brief(outcome.conflicts) };
    return { status: bg.applyIds.length ? 'applied' : 'nothing' };
  }

  /**
   * "只应用不冲突的文件": the clean part, all or nothing; conflicting files keep P's version. The user's git operation
   * in P answers `{ status: 'held', reason: 'git_operation', operation }` with nothing written (the card's answer is
   * carried out once it ends), as for applyBackground.
   */
  async applyClean(bg) {
    const tip = await this.tip(bg), secret = secretOf(tip);
    if (await this.unchanged(bg, tip)) return withSecret({ status: 'nothing', conflicts: [] }, secret);
    const operation = await this.operation(bg.projectId);
    if (operation) return { status: 'held', reason: 'git_operation', operation, conflicts: [] };
    const outcome = await this.apply(bg, tip, { cleanOnly: true });
    return withSecret({ status: outcome.status, conflicts: brief(outcome.conflicts), ...(outcome.status === 'held' ? { reason: outcome.reason, operation: outcome.operation } : {}) }, secret);
  }

  /**
   * "冲突文件用后台的版本": B's version wins where it conflicts. The base of each conflicted path becomes P's entry
   * now, so B's change applies as a clean change, with the usual record and CAS (a file that moves again meanwhile
   * conflicts and stays). Conflicts left to the user (submodule, links leaving the project, case-only names, hard
   * links) are never written.
   */
  async applyBackground(bg) {
    const tip = await this.tip(bg), secret = secretOf(tip);
    if (await this.unchanged(bg, tip)) return withSecret({ status: 'nothing', conflicts: [] }, secret);
    const operation = await this.operation(bg.projectId);
    if (operation) return { status: 'held', reason: 'git_operation', operation, conflicts: [] };
    const current = await this.engine.snapshot(bg.projectId, await this.projectRoot(bg.projectId));
    const merged = await this.engine.merge(bg.projectId, { base: bg.base, current: current.commit, incoming: tip.commit }, { labels: bg.labels, root: bg.root });
    const paths = merged.conflicts.filter(row => !USER_ONLY_CONFLICTS.includes(row.kind)).map(row => row.path);
    const base = paths.length ? await this.engine.syncBase(bg.projectId, { current: bg.base, previous: current.commit, paths }) : bg.base;
    const outcome = await this.apply(bg, tip, { cleanOnly: true, base });
    return withSecret({ status: outcome.status, conflicts: brief(outcome.conflicts), ...(outcome.status === 'held' ? { reason: outcome.reason, operation: outcome.operation } : {}) }, secret);
  }

  /** Remove B (its tip pinned first, ignored files to the trash: WorktreeService.remove). */
  async close(bg) {
    await this.worktrees.remove(bg.projectId, bg.worktreeId);
  }
  /** Let the user act on B from the worktree panel (apply or discard there). */
  release(bg, state = 'conflicted') { try { this.worktrees.setState(bg.projectId, bg.worktreeId, state); } catch { /* the record may be gone */ } }

  /**
   * Roll back apply records newest first, each three-way (design §5.2): later changes that do not overlap stay,
   * overlapping files are skipped. Used where the user already confirmed (the directHandle card's 回退, agent_merge
   * drop), so both steps run here. `initiator` is recorded on each rollback: 'user' for the card, 'agent' for the
   * model's agent_merge drop. A record written into a conversation's own worktree S (the set merged there with
   * agent_merge) is rolled back inside S the way a dropped worker's is (BuiltinAgentService.rollbackMerges: a
   * `rollback` apply into S from the record's after back to its before, partial) and settled with markRolledBack, so
   * that conversation's next apply carries the rollback into the project folder instead of the dropped files (review
   * ISO-2). Records written anywhere else are not the set's to undo, and neither is a record of a conversation that no
   * longer has its own worktree (it works in the project folder now: its copy reached the project folder with that
   * conversation's own apply): its files are reported `failed` and nothing is written (review C5). `signal` (the
   * turn's) stops a rollback inside S that waits. The user's git operation in the project folder stops it with
   * `git_operation_in_progress` (records rolled back until then stay rolled back).
   * @param {{ initiator?: 'user'|'agent'|'host', signal?: AbortSignal }} [options]
   * @returns {Promise<{ restored: string[], conflicts: string[], failed: string[], session: string[] }>}  `session`: the
   *   paths restored inside a conversation's worktree (in `restored` too)
   */
  async rollback(projectId, applyIds, { initiator, signal } = {}) {
    const restored = [], conflicts = [], failed = [], session = [];
    const rows = this.project(projectId)?.git?.applies ?? [];
    for (const applyId of [...applyIds].reverse()) {
      const row = rows.find(item => item.id === applyId);
      if (!row || ['rolled_back'].includes(row.state)) continue;
      if (row.target !== 'project') {
        const sessionId = typeof row.target === 'string' && row.target.startsWith('session:') ? row.target.slice('session:'.length) : null;
        if (!sessionId || row.state === 'expired' || row.rolledBackBy || !['verified', 'unverified'].includes(row.state)) continue;
        try {
          const target = await this.roots.rootOf({ projectId, sessionId });
          // Only inside that conversation's own worktree, never the project folder its root resolves to without one.
          if (target.kind !== 'session') { failed.push(...(row.sample ?? [])); continue; }
          const outcome = await this.engine.apply(projectId, { target, base: `${REFS.apply(row.id)}^2`, incoming: `${REFS.apply(row.id)}^1`, kind: 'rollback', source: structuredClone(row.source ?? {}), mode: 'partial', labels: MERGE_LABELS.rollback(row.id), initiator, ...(signal ? { signal } : {}) });
          const paths = [...(outcome.written ?? []), ...(outcome.removed ?? [])];
          restored.push(...paths); session.push(...paths); conflicts.push(...(outcome.conflicts ?? []).map(item => item.path));
          // Settled as a rollback of P settles its record; everything skipped and nothing written leaves it in effect.
          if (outcome.applyId || (outcome.status === 'nothing' && !outcome.conflicts?.length)) this.engine.markRolledBack?.(projectId, row.id, { by: outcome.applyId ?? null });
        } catch (error) { if (signal?.aborted) throw error; failed.push(...(row.sample ?? [])); }
        continue;
      }
      for (let attempt = 1; ; attempt++) {
        try {
          const preview = await this.engine.rollback(projectId, applyId, {}, { initiator });
          const result = await this.engine.rollback(projectId, applyId, { confirm: preview.confirm }, { initiator });
          restored.push(...result.restored); conflicts.push(...(result.skipped ?? []).map(item => item.path));
        } catch (error) {
          if (heldByOperation(error)) throw error;
          if (error?.code === 'rollback_changed' && attempt < 2) continue;
          if (error?.code === 'rollback_nothing') conflicts.push(...(row.sample ?? []));
          else failed.push(...(row.sample ?? []));
        }
        break;
      }
    }
    return { restored: [...new Set(restored)], conflicts: [...new Set(conflicts)], failed: [...new Set(failed)], session: [...new Set(session)] };
  }

  /**
   * A change set handed to a conversation (`agent_merge({ changeId })`, design §4.1 actions over §4.3): merge into
   * the conversation's root (P, or its session worktree S) in `partial` mode; show / take / resolved / drop on the
   * conflicts that merge listed. Answers the agent_merge result JSON and the next `handoff` state; throws
   * `{ code }` refusals. A merge, take or drop that would write into the project folder while the user's git
   * operation runs there is refused at once (`git_operation_in_progress`), never waited on; `signal` (the turn's)
   * stops what does wait (Rna's own commands running out).
   * @param {BackgroundRun} bg
   * @param {{ sessionId: string, action: string, path?: string, page?: number, take?: { path: string, side: string }[], handoff?: object, signal?: AbortSignal }} request
   * @returns {Promise<{ result: object, handoff: object|null, settled?: 'merged'|'dropped' }>}
   */
  async handoff(bg, { sessionId, action = 'merge', path, page, take, handoff = null, signal: given = null }) {
    const projectId = bg.projectId, target = await this.roots.rootOf({ projectId, sessionId });
    const signal = given ? AbortSignal.any([given, this.stopping.signal]) : this.stopping.signal;
    const refuseWhileBusy = async () => { const operation = await this.operation(projectId); if (operation) throw operationRefusal(operation); };
    const held = error => { if (heldByOperation(error)) throw operationRefusal(error.operation); throw error; };
    const conflictOf = wanted => { const row = handoff?.conflicts?.find(item => item.path === wanted); if (!row) throw failure('merge_path_not_conflicted', `${wanted} is not in the conflict list of this change set; call agent_merge with action merge first.`); return row; };
    const view = async conflict => {
      const row = { path: conflict.path, kind: conflict.kind, currentSha256: conflict.currentSha256 ?? null, ...(USER_ONLY_CONFLICTS.includes(conflict.kind) ? { userOnly: true } : {}) };
      if (!USER_ONLY_CONFLICTS.includes(conflict.kind)) try { const preview = await this.engine.diff3(projectId, conflict); row.preview = preview.text; row.truncated = preview.truncated === true; } catch { /* no preview for this kind */ }
      return row;
    };
    if (action === 'merge') {
      if (target.kind === 'project') await refuseWhileBusy();
      const tip = await this.tip(bg), strays = await this.strayMarkers(bg, tip);
      const incoming = strays.length ? await this.engine.syncBase(projectId, { current: tip.commit, previous: bg.base, paths: strays }) : tip.commit;
      const outcome = await this.engine.apply(projectId, { target, base: bg.base, incoming, kind: 'background', source: { ...bg.source, sessionId }, mode: 'partial', labels: bg.labels, incomingRoot: bg.root, notMerged: notMergedOf(tip), signal, hold: true }).catch(held);
      if (target.kind === 'project') this.note(bg, outcome);
      else if (outcome.applyId) bg.applyIds.push(outcome.applyId);
      await this.persist(bg);
      const conflicts = await Promise.all(outcome.conflicts.slice(0, HANDOFF_CONFLICTS).map(async conflict => ({ ...sides(conflict), currentSha256: await this.engine.fileSha256(target, conflict.path) })));
      const applied = [...(outcome.written ?? []), ...(outcome.removed ?? [])];
      const notes = [...(outcome.dependencies ? ['Dependency manifests changed; the project folder may need its dependencies reinstalled.'] : []), ...(outcome.conflicts.length > HANDOFF_CONFLICTS ? [`Only the first ${HANDOFF_CONFLICTS} of ${outcome.conflicts.length} conflicts are listed.`] : []), ...(target.kind === 'session' ? ['These changes were merged into this conversation\'s own copy; they reach the project folder when the turn ends.'] : []), ...(strays.length ? [`Left out: the background copy of ${strays.join(', ')} still holds conflict markers, so the host did not merge ${strays.length === 1 ? 'it' : 'them'}.`] : [])];
      const result = { status: conflicts.length ? 'conflict' : applied.length ? 'merged' : 'nothing', applied, conflicts: await Promise.all(conflicts.map(view)), notMerged: outcome.notMerged ?? [], notes };
      if (!conflicts.length) return { result, handoff: null, settled: 'merged' };
      return { result, handoff: { sessionId, target: target.kind, mid: outcome.mid, conflicts } };
    }
    if (action === 'show') {
      if (!path) throw failure('merge_path_not_conflicted', 'show needs a path from the conflict list.');
      const conflict = conflictOf(path), shown = await this.engine.diff3(projectId, conflict, { page: page ?? 1 });
      return { result: { path, kind: conflict.kind, page: shown.page, pages: shown.pages, text: shown.text }, handoff };
    }
    if (action === 'take') {
      if (!Array.isArray(take) || !take.length) throw failure('merge_path_not_conflicted', 'take needs paths from the conflict list and a side for each.');
      const items = take.map(item => ({ conflict: conflictOf(item.path), side: item.side }));
      if (target.kind === 'project') await refuseWhileBusy();
      const outcome = await this.engine.take(projectId, { target, items, source: { ...bg.source, sessionId }, signal, hold: true }).catch(held);
      if (outcome.applyId) bg.applyIds.push(outcome.applyId);
      if (target.kind === 'project') for (const path of [...outcome.written, ...outcome.removed]) bg.files.set(path, { path });
      await this.persist(bg);
      const taken = new Set(outcome.taken ?? []);
      const next = { ...handoff, conflicts: handoff.conflicts.map(row => (taken.has(row.path) ? { ...row, taken: true } : row)) };
      const remaining = next.conflicts.filter(row => !row.taken);
      return { result: { status: remaining.length ? 'conflict' : 'merged', taken: take.filter(item => taken.has(item.path)).map(item => ({ path: item.path, side: item.side })), applied: [...outcome.written, ...outcome.removed], conflicts: await Promise.all(remaining.map(view)) }, handoff: next };
    }
    if (action === 'resolved') {
      if (!handoff) throw failure('merge_unresolved', 'Nothing to check yet: call agent_merge with action merge first.');
      const check = await this.engine.resolved(projectId, { target, mid: handoff.mid, conflicts: handoff.conflicts.map(row => ({ path: row.path, currentSha256: row.currentSha256 ?? null, taken: row.taken === true })) });
      if (!check.resolved) return { result: { status: 'conflict', remaining: check.remaining }, handoff };
      return { result: { status: 'merged' }, handoff: null, settled: 'merged' };
    }
    if (action === 'drop') {
      // A rollback of what reached the project folder is a write there: refused while the user's git operation runs.
      const written = new Set(bg.applyIds), inP = (this.project(projectId)?.git?.applies ?? []).some(row => written.has(row.id) && row.target === 'project' && row.state !== 'rolled_back');
      if (inP) await refuseWhileBusy();
      // agent_merge reaches handoff() only from the model's own tool call: its drop is the model's, not the user's.
      const undone = await this.rollback(projectId, bg.applyIds, { initiator: 'agent', signal }).catch(held);
      // What was merged into this conversation's own copy is rolled back there (review ISO-2): the copy reaches the
      // project folder at the turn end without it.
      const notes = undone.session.length ? ['What this change set had merged into this conversation\'s own copy was rolled back there; the project folder gets that copy at the turn end, without these changes.'] : [];
      return { result: { status: 'dropped', restored: undone.restored, skipped: [...undone.conflicts.map(path => ({ path, reason: 'changed_after' })), ...undone.failed.map(path => ({ path, reason: 'failed' }))], ...(notes.length ? { notes } : {}) }, handoff: null, settled: 'dropped' };
    }
    throw failure('merge_unknown', `Unknown action ${action}.`);
  }
}
