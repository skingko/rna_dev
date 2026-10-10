import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { FEEDBACK_SOURCES, HOST_CARDS, LIMITS, MERGE_LABELS, MODEL_TEXT, REFS, TEXT_CONFLICT_KINDS, notMergedOf, sameFolder } from './git-isolation/index.mjs';
import { toolPermitted } from './project-permissions.mjs';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';
import { objectGit } from './turn-checkpoint.mjs';

// Session worktrees (optional, off by default): created on the first turn, synced at each turn start, applied to
// the project folder every time control returns to the user (worktree design 0.63 §4.2, §7). Owner: T4 (bodies);
// the interface is the lead's contract (git-isolation/CONTRACT.md).
//
// `session.worktree = { id, state }` is set when the session is created with `worktree: true` (state 'pending');
// no field = direct mode. `session.workspace` stays P. Plan mode and side chats (read only) skip every step here.
//
// One rule holds the bookkeeping together: the worktree record's `base` is the project folder's content S was last
// synced to, so `S − base` is exactly what this conversation has not applied yet. Every step keeps it so:
// - forward (S → P): merge(base, P, S) written into P with all-or-nothing CAS, one `turn` apply record;
// - converge (P → S): merge(base, S, P) written into S in `partial` mode; base := P's tree, except that paths left
//   conflicted keep their old base entry (they conflict again next time instead of being taken over silently);
//   S's HEAD moves to base, so `git diff` in S (and the 0.62 panel) shows exactly the unapplied work.
// The turn-start sync is a converge; a clean forward is followed by a converge (S == P afterwards). Conflict markers
// are written only into S (the reverse merge), and a forward never carries a file that still holds the markers of
// an open conflict of this conversation (they are checked with hasMergeMarkers through the engine first).
//
// Operations of one conversation run one at a time (a per-session queue); repository writes queue in the engine's
// FIFO. Cards: HOST_CARDS.sessionConflict / sessionCreate, answered through the store (watch()).

/**
 * @typedef {import('./git-isolation/contract.mjs').RootInfo} RootInfo
 * @typedef {import('./git-isolation/contract.mjs').Conflict} Conflict
 *
 * @typedef {object} TurnApply  turn.apply (design §11)
 * @property {'none'|'applying'|'applied'|'conflicted'|'pending'} status
 * @property {string[]} applyIds
 * @property {number} [bothChanged]
 * @property {{ id: string, preMerge: string, paths: { path: string, kind: string }[], attempts: number }} [conflict]
 * @property {string[]} [ignoredNew]   Ignored folders the worktree has that P lacks (e.g. dist/): never applied.
 * @property {boolean} [dependencies] A DEPENDENCY_FILES name was applied: "项目文件夹需要重新安装".
 * @property {{ interactionId: string, actionId: string, answered?: string }} [card]  The conflict card (additive).
 * @property {string} [settledBy]     A later turn whose apply settled this turn's conflict (additive).
 * @property {'read_only'|'archived'|'blocked'|'aborted'} [reason]  Why a pending apply waits (additive).
 *
 * @typedef {object} FinishStep  What applyAtFinish answers hostFinish (SDK finish protocol).
 * @property {'none'|'applied'|'continue'|'conflicted'} outcome  `continue`: run another host continuation with `feedback`.
 * @property {{ source: 'host-worktree-apply', text: string }} [feedback]  MODEL_TEXT.worktreeApplyFeedback(...)
 * @property {TurnApply} apply
 */

const text = kind => TEXT_CONFLICT_KINDS.includes(kind);
/** At most this many secret paths of a conversation are kept on its worktree record, and shown in one timeline line (B8). */
const SECRET_PATHS = 50, SECRET_SHOWN = 10;
const pathsOf = conflicts => conflicts.map(row => ({ path: row.path, kind: row.kind }));
const within = (root, path) => { const part = relative(root, path); return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };
const exists = path => lstat(path).then(() => true, () => false);

export class SessionWorktreeService {
  /**
   * @param {import('./store.mjs').Store} store
   * @param {{ engine?: import('./git-isolation/index.mjs').IsolationEngine, worktrees?: import('./worktree-service.mjs').WorktreeService, roots?: import('./workspace-roots.mjs').RootResolver, interactions?: object, git?: object, now?: () => number }} [options]
   *   `git` (WorkspaceGitService) defaults to the engine's.
   */
  constructor(store, { engine = null, worktrees = null, roots = null, interactions = null, git = null, now = Date.now } = {}) {
    Object.assign(this, { store, engine, worktrees, roots, interactions, now });
    this.git = git;
    /** session id → the tail of its queue */
    this.queues = new Map();
    /** session id → AbortController of an idle apply that a starting turn may cut short */
    this.idle = new Map();
    this.answering = new Set(); this.archiving = new Set(); this.archived = new Set(); this.unwatch = null; this.scanning = false; this.folders = new Map();
    /** Conflict-card answers (interaction ids) held on the user's git operation in P: taken up again once it ends. */
    this.heldAnswers = new Set();
    /** Aborted by close(): a card answer waiting for the user's git operation in P lets shutdown go on. */
    this.closing = new AbortController();
  }
  say(variants) { return inLanguage(interfaceLanguageOf(this.store.state), variants); }
  fail(code, status, variants, extra = {}) { return Object.assign(new Error(this.say(variants)), { status, code, ...extra }); }
  gitService() { return this.git ?? this.engine?.gitService?.() ?? null; }
  session(sessionId) { return this.store.state.sessions.find(row => row.id === sessionId) ?? null; }
  projectOf(session) { return this.store.state.projects.find(row => row.id === session?.projectId) ?? null; }
  recordOf(project, worktreeId) { return (project?.git?.worktrees ?? []).find(row => row.id === worktreeId) ?? null; }
  turnOf(sessionId, turnId) { return this.session(sessionId)?.turns.find(row => row.id === turnId) ?? null; }
  /** Run `work` after everything queued for this conversation. */
  serial(sessionId, work) {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    const tail = next.catch(() => {});
    this.queues.set(sessionId, tail);
    void tail.then(() => { if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId); });
    return next;
  }
  /** Mutate one turn's apply state (whatever the turn's status is). */
  setApply(sessionId, turnId, change) {
    let value = null;
    try {
      this.store.mutate(state => {
        const turn = state.sessions.find(row => row.id === sessionId)?.turns.find(row => row.id === turnId);
        if (!turn) return;
        turn.apply = change({ status: 'none', applyIds: [], ...structuredClone(turn.apply ?? {}) });
        value = structuredClone(turn.apply);
      });
    } catch { /* the conversation is gone */ }
    return value;
  }
  notice(sessionId, turnId, variants) {
    try { this.store.mutate(state => { const session = state.sessions.find(row => row.id === sessionId); if (session) { session.items.push({ id: randomUUID(), turnId: turnId ?? null, kind: 'notice', text: inLanguage(interfaceLanguageOf(state), variants), createdAt: new Date(this.now()).toISOString(), simulated: false, source: 'worktree' }); session.updatedAt = new Date(this.now()).toISOString(); } }); } catch { /* best effort */ }
  }
  setSessionWorktree(sessionId, change) {
    this.store.mutate(state => { const session = state.sessions.find(row => row.id === sessionId); if (session?.worktree) { const next = change(structuredClone(session.worktree)); if (next) session.worktree = next; else delete session.worktree; } });
    this.roots?.invalidate?.({ sessionId });
  }
  setRecord(projectId, worktreeId, change) {
    this.store.mutate(state => { const row = state.projects.find(item => item.id === projectId)?.git?.worktrees?.find(item => item.id === worktreeId); if (row) change(row); });
  }

  /**
   * Everything one operation on a conversation's worktree needs, resolved and validated now: the session, its
   * project, the worktree record, S and P as roots, git. Null when the session has no live worktree.
   */
  async context(sessionId) {
    const session = this.session(sessionId), project = this.projectOf(session);
    if (!session?.worktree || !project || session.worktree.state === 'pending' || !this.roots || !this.engine) return null;
    const record = this.recordOf(project, session.worktree.id);
    if (!record || record.state === 'removed') return null;
    const [S, P] = await Promise.all([this.roots.rootOf({ projectId: project.id, sessionId }), this.roots.rootOf({ projectId: project.id })]);
    const git = this.gitService(), located = await git.locateProject(project.id);
    if (located.repo === 'none') return null;
    return { session, project, projectId: project.id, sessionId, record, S, P, git, located, objects: objectGit(git, located) };
  }
  source(ctx, turnId) { return { sessionId: ctx.sessionId, ...(turnId ? { turnId } : {}), worktreeId: ctx.record.id }; }

  /**
   * First turn, preparing_workspace (design §7.2): create S (prefix `s-`, lock reason = session title, seed = base)
   * if still 'pending', and answer its root. Failure: the turn fails with errorCode `worktree_create_failed` and the
   * HOST_CARDS.sessionCreate card (project_folder | retry). A lost S: repair, then rebuild (§7.4); tools never run
   * in a folder that does not exist.
   * @param {string} sessionId
   * @param {{ turnId: string, signal?: AbortSignal }} options
   * @returns {Promise<RootInfo>}
   */
  async ensure(sessionId, { turnId, signal } = {}) {
    this.watch();
    // A turn starting now supersedes an idle apply still waiting for the project folder: it applies at its own end.
    this.idle.get(sessionId)?.abort();
    return this.serial(sessionId, async () => {
      const session = this.session(sessionId), project = this.projectOf(session);
      if (!session || !project) throw this.fail('session_not_found', 404, { zh: '这个对话不在了。', en: 'This conversation no longer exists.' });
      if (!this.roots) throw this.fail('worktree_pending', 409, { zh: '这个对话的工作树还没准备好。', en: 'This conversation’s worktree isn’t ready.' });
      if (!session.worktree) return this.roots.rootOf({ projectId: project.id, sessionId });
      if (session.worktree.state === 'pending') return this.create(session, project, { turnId, signal });
      let root;
      try { root = await this.roots.rootOf({ projectId: project.id, sessionId }); }
      catch (error) { if (error.code !== 'worktree_missing') throw error; root = await this.rebuildLost(session, project, { turnId }); }
      // A kept worktree (its conversation was archived, then restored) is in use again.
      if (session.worktree.state !== 'active') this.setSessionWorktree(sessionId, row => ({ ...row, state: 'active' }));
      const record = this.recordOf(this.projectOf(this.session(sessionId)), session.worktree.id);
      if (record && record.state !== 'active') this.worktrees?.setState?.(project.id, record.id, 'active');
      return root;
    });
  }
  async create(session, project, { turnId, signal }) {
    const id = session.worktree.id;
    try {
      if (!this.worktrees) throw this.fail('worktree_unavailable', 409, { zh: '这个项目现在不能使用独立工作树。', en: 'This project can’t use separate worktrees right now.' }, { reason: 'not_ready' });
      const parent = await this.roots.rootOf({ projectId: project.id });
      await this.worktrees.create(project.id, { kind: 'session', id, owner: { sessionId: session.id }, parent, label: `Rna conversation: ${String(session.title ?? '').slice(0, 120)}`, signal });
      this.setSessionWorktree(session.id, row => ({ ...row, state: 'active' }));
      this.roots.invalidate({ sessionId: session.id });
      return await this.roots.rootOf({ projectId: project.id, sessionId: session.id });
    } catch (error) {
      if (signal?.aborted) throw error;
      const reason = error.reason ?? error.code ?? null;
      this.postCreateCard(session.id, turnId);
      throw Object.assign(this.fail('worktree_create_failed', 500, reason === 'not_ready' || error.code === 'worktree_unavailable'
        ? { zh: '这个对话要在独立工作树里运行，但这个项目现在不能使用独立工作树，所以这一轮没有开始。可以在输入框上方选择改在项目文件夹里继续，或者重试。', en: 'This conversation runs in its own worktree, but the project can’t use separate worktrees right now, so this turn didn’t start. Above the composer you can continue in the project folder instead, or retry.' }
        : { zh: '没能为这个对话创建独立工作树，所以这一轮没有开始。可以在输入框上方选择改在项目文件夹里继续，或者重试。', en: 'The worktree for this conversation couldn’t be created, so this turn didn’t start. Above the composer you can continue in the project folder instead, or retry.' }), { ...(reason ? { reason } : {}), cause: error, detail: error.detail ?? error.message });
    }
  }
  /** A worktree folder that is gone (design §7.4): repair; else rebuild from P (nothing unapplied) or from its tip. */
  async rebuildLost(session, project, { turnId } = {}) {
    const id = session.worktree.id, query = { projectId: project.id, sessionId: session.id };
    const missing = () => { this.setSessionWorktree(session.id, row => ({ ...row, state: 'missing' })); return this.fail('worktree_missing', 409, { zh: '这个对话的工作树不见了，也没能重建，所以这一轮没有开始；不会改在项目文件夹里继续。', en: 'This conversation’s worktree is gone and couldn’t be rebuilt, so this turn didn’t start; it won’t continue in the project folder instead.' }, { worktreeId: id }); };
    if (!this.worktrees) throw missing();
    // 1. `git worktree repair` (a moved folder); the conversation names its worktree again if that found it.
    try {
      const repaired = await this.worktrees.repair(project.id);
      this.roots.invalidate({ projectId: project.id });
      if (repaired.repaired.includes(id)) { this.setSessionWorktree(session.id, row => ({ ...row, state: 'active' })); return await this.roots.rootOf(query); }
    } catch (error) { if (!['worktree_missing', 'worktree_repair_failed', 'worktree_unavailable'].includes(error.code)) throw error; }
    const record = this.worktrees.record(project.id, id);
    if (!record || record.state === 'removed') throw missing();
    let from = 'project';
    try {
      const git = this.gitService(), located = await git.locateProject(project.id), objects = objectGit(git, located);
      const tip = await objects.resolve(`${REFS.worktree(id, 'tip')}^{tree}`), base = await objects.resolve(`${record.base ?? record.seed}^{tree}`);
      if (tip && tip !== base) from = 'tip';
      await this.worktrees.rebuild(project.id, id, { from });
    } catch (error) { console.warn(`session worktree ${id}: rebuild failed: ${error.message}`); throw missing(); }
    this.roots.invalidate({ sessionId: session.id });
    this.notice(session.id, turnId, from === 'tip'
      ? { zh: '这个对话的工作树不见了，已按最后一次快照重建，还没应用的改动都在。', en: 'This conversation’s worktree was gone; it was rebuilt from its last snapshot, with the changes not applied yet.' }
      : { zh: '这个对话的工作树不见了，已从项目文件夹重建。', en: 'This conversation’s worktree was gone; it was rebuilt from the project folder.' });
    this.setSessionWorktree(session.id, row => ({ ...row, state: 'active' }));
    return this.roots.rootOf(query);
  }

  /**
   * P → S (design §7.3, and after every clean apply): merge(base, S, P) written into S in `partial` mode; base :=
   * P's tree except that paths left conflicted keep their old entry; S's HEAD → base.
   * `force`: paths whose S version is dropped for P's (the card's "project folder's version", and after "this
   * conversation's version" was written into P).
   */
  async converge(ctx, { turnId, signal, force = [] } = {}) {
    const { engine } = this, record = this.recordOf(this.projectOf(this.session(ctx.sessionId)), ctx.record.id) ?? ctx.record;
    const project = await engine.snapshot(ctx.projectId, ctx.P, { signal });
    let base = record.base ?? record.seed;
    if (force.length) base = await engine.syncBase(ctx.projectId, { current: base, previous: (await engine.snapshot(ctx.projectId, ctx.S, { signal })).commit, paths: force });
    const outcome = await engine.apply(ctx.projectId, { target: ctx.S, base, incoming: project.commit, kind: 'turn', source: this.source(ctx, turnId), mode: 'partial', labels: MERGE_LABELS.projectToSession(), signal });
    const next = await engine.syncBase(ctx.projectId, { current: project.commit, previous: base, paths: outcome.conflicts.map(row => row.path) });
    await this.moveBase(ctx, next, project.commit);
    return { outcome, conflicts: outcome.conflicts };
  }
  /** base := tree (a commit on no branch, parent: the project folder's snapshot); S's HEAD and index follow it. */
  async moveBase(ctx, tree, parent) {
    const current = this.recordOf(this.projectOf(this.session(ctx.sessionId)), ctx.record.id);
    if (current?.base && await ctx.objects.resolve(`${current.base}^{tree}`) === tree) return current.base;
    const commit = await ctx.objects.commit(tree, [parent], 'Rna conversation base');
    await this.engine.lock(ctx.projectId, async () => {
      await this.engine.pin(ctx.projectId, [{ ref: REFS.worktree(ctx.record.id, 'base'), commit }]);
      this.setRecord(ctx.projectId, ctx.record.id, row => { row.base = commit; });
      // Git on the worktree takes GIT_DIR / GIT_WORK_TREE from the record, never from its `.git` file.
      const env = { GIT_DIR: ctx.S.gitDir, GIT_WORK_TREE: ctx.S.workTree }, run = args => ctx.git.run(ctx.S.workTree, args, { env, engine: true, timeoutMs: 60000, killSignal: 'SIGTERM' });
      const head = async target => { const moved = await run(['update-ref', '--no-deref', 'HEAD', target]); if (moved.code === 0) { await run(['read-tree', target]); await run(['update-index', '-q', '--refresh']); } return moved.code === 0; };
      // HEAD is only the agent's view (`git diff` shows the unapplied work); merges read the record's base. The
      // engine's private index of S follows HEAD (it rebuilds with `read-tree -m`, which refuses a file that changed
      // since its last snapshot), so it is brought up to date just before the move and rebuilt just after; when it
      // cannot follow, HEAD goes back where it was.
      try {
        const previous = (await run(['rev-parse', '-q', '--verify', 'HEAD'])).stdout.trim();
        await this.engine.snapshot(ctx.projectId, ctx.S);
        if (await head(commit)) {
          try { await this.engine.snapshot(ctx.projectId, ctx.S); }
          catch (error) { if (previous) await head(previous); console.warn(`session worktree ${ctx.record.id}: HEAD kept at the previous base: ${error.message}`); }
        }
      } catch (error) { console.warn(`session worktree ${ctx.record.id}: HEAD not moved: ${error.message}`); }
    });
    return commit;
  }
  /**
   * S → P: merge(base, P, S) written into P (`all`; `cleanOnly` writes the clean part at a hand-back). Paths that
   * still hold an open conflict's markers are left out (their S version is replaced by base's). Answers the
   * engine's ApplyOutcome plus `snapshot` (S, pinned at its tip), or `{ status: 'nothing' }` when S is at base.
   */
  async forward(ctx, { turnId, cleanOnly = false, exclude = [], signal, onWaiting, hold = false, incoming: given = null } = {}) {
    const { engine } = this, record = this.recordOf(this.projectOf(this.session(ctx.sessionId)), ctx.record.id) ?? ctx.record, base = record.base ?? record.seed;
    const snapshot = await engine.snapshot(ctx.projectId, ctx.S, { pin: REFS.worktree(ctx.record.id, 'tip'), signal });
    if (!given && snapshot.tree === await ctx.objects.tree(base)) return { status: 'nothing', applyId: null, conflicts: [], written: [], removed: [], snapshot };
    if (!toolPermitted(ctx.project, { permission: 'write' }, 'foreground') || ctx.project.archivedAt) return { status: 'held', reason: ctx.project.archivedAt ? 'archived' : 'read_only', applyId: null, conflicts: [], written: [], removed: [], snapshot };
    let incoming = given ?? snapshot.commit;
    if (exclude.length) incoming = await engine.syncBase(ctx.projectId, { current: incoming, previous: base, paths: exclude });
    // `hold`: the user's git operation in P is not waited for (review ISO-1); the apply answers held `git_operation`.
    let outcome;
    try { outcome = await engine.apply(ctx.projectId, { target: ctx.P, base, incoming, kind: 'turn', source: this.source(ctx, turnId), mode: 'all', cleanOnly, labels: MERGE_LABELS.sessionToProject(), incomingRoot: ctx.S, notMerged: notMergedOf(snapshot), signal, onWaiting: operation => onWaiting?.(operation), ...(hold ? { hold: true } : {}) }); }
    catch (error) { if (hold && error?.code === 'git_operation_in_progress') return { status: 'held', reason: 'git_operation', operation: error.operation ?? null, applyId: null, conflicts: [], written: [], removed: [], snapshot }; throw error; }
    return { ...outcome, snapshot };
  }
  /**
   * A conversation's apply held on the user's git operation in the project folder (review ISO-1): one timeline line
   * when the hold begins (`before`: the turn's apply until now), and the apply runs again once the operation ends
   * (applyIdle: only while no turn runs; a turn's own end applies everything anyway). Nothing waits meanwhile.
   */
  heldOnOperation(ctx, turnId, operation, before) {
    if (before?.reason !== 'git_operation') this.waiting(ctx.sessionId, turnId, operation ?? 'operation');
    try { this.engine?.whenProjectFree?.(ctx.projectId, `session:${ctx.sessionId}`, () => { void this.applyIdle(ctx.sessionId); }); } catch { /* the next hand-back applies it */ }
  }
  /**
   * Text paths of this conversation's open conflicts that still hold that merge's markers in S
   * (`[{ mid, turnId, paths }]`), computed by code (hasMergeMarkers via IsolationEngine.resolved).
   */
  async openMarkers(ctx) {
    const record = this.recordOf(this.projectOf(this.session(ctx.sessionId)), ctx.record.id) ?? ctx.record, found = [];
    for (const mark of record.marks ?? []) {
      if (!/^[a-f0-9]{8,32}$/.test(mark.mid ?? '') || !mark.paths?.length) continue;
      const checked = await this.engine.resolved(ctx.projectId, { target: ctx.S, mid: mark.mid, conflicts: mark.paths.map(path => ({ path, currentSha256: null, taken: true })) });
      const paths = checked.remaining.filter(row => row.reason === 'markers').map(row => row.path);
      if (paths.length) found.push({ ...mark, paths });
    }
    // Merges whose markers are all gone are forgotten.
    if (found.length !== (record.marks ?? []).length) this.setRecord(ctx.projectId, ctx.record.id, row => { row.marks = found.length ? found.map(item => ({ ...item })) : undefined; if (!row.marks) delete row.marks; });
    return found;
  }
  /** Remember that merge `mid` wrote conflict markers into these files of S (until they are gone). */
  addMarks(ctx, mark) {
    this.setRecord(ctx.projectId, ctx.record.id, row => { row.marks = [...(row.marks ?? []).filter(item => item.mid !== mark.mid), mark].slice(-16); });
  }
  /**
   * A full apply (all of S is in P now: applied with no conflict left, or S at its base) settles the other turns'
   * applies still open: their conflicts, and applies left `pending` (or `applying`, cut off) without one, whatever
   * held them (the user's git operation, read only, blocked, stopped): S carried their changes into P with this one, so
   * none still waits (reviews C3, X3) and none keeps a line promising an apply of its own. `conflicts: false` leaves
   * open conflicts to their card (a hand-back that found nothing to apply).
   */
  settleOpen(sessionId, turnId, { conflicts = true } = {}) {
    try {
      this.store.mutate(state => {
        for (const turn of state.sessions.find(row => row.id === sessionId)?.turns ?? []) {
          const apply = turn.apply;
          if (turn.id === turnId || !apply || !(apply.conflict ? (conflicts ? ['conflicted', 'pending'] : []) : ['pending', 'applying']).includes(apply.status)) continue;
          apply.status = 'applied'; apply.settledBy = turnId ?? null; delete apply.reason;
        }
      });
    } catch { /* gone */ }
  }
  /** Ignored entries S has that P lacks (dist/, a build output), never applied: the footer names them. */
  async ignoredNew(ctx) {
    try {
      const env = { GIT_DIR: ctx.S.gitDir, GIT_WORK_TREE: ctx.S.workTree };
      const listed = await ctx.git.run(ctx.S.root, ['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory', '--', '.'], { env, engine: true, maxBytes: 4 * 1024 * 1024 });
      if (listed.code !== 0) return [];
      const laid = new Set((ctx.record.laid ?? []).map(row => row.path.split('/')[0])), tops = new Map();
      for (const entry of listed.stdout.split('\0').filter(Boolean)) {
        const [first, ...rest] = entry.split('/'), name = rest.length ? `${first}/` : first;
        if (!first || ['.rna', '.git'].includes(first) || laid.has(first) || tops.has(first)) continue;
        tops.set(first, name);
      }
      const out = [];
      for (const [first, name] of tops) { if (out.length >= 10) break; if (!(await exists(join(ctx.P.root, first)))) out.push(name); }
      return out;
    } catch { return []; }
  }
  /** Pin the conversation's files before the reverse merge (or a conflict card): "这个对话的版本" comes from here. */
  async pinPreMerge(ctx, commit) {
    await this.engine.pin(ctx.projectId, [{ ref: REFS.worktree(ctx.record.id, 'premerge'), commit }]);
    return commit;
  }

  /**
   * Turn-start sync P → S (design §7.3): merge(base, S, P) written into S in `partial` mode; conflicted paths keep
   * S's version and the new base keeps their old entries; S's HEAD moves to the new base; ignored attachments of
   * this turn are copied into S. Must finish before the first non-read tool (same gate as the direct-mode start
   * snapshot, TurnCheckpoint.gate).
   * @param {string} sessionId
   * @param {{ turnId: string, signal?: AbortSignal }} options
   * @returns {Promise<{ status: 'clean'|'partial'|'skipped', conflicts: { path: string, kind: string }[], context?: string, feedback?: { source: string, text: string } }>}
   *   `context`: MODEL_TEXT.startSyncConflicts(paths), attached as host context when there were conflicts.
   *   `feedback` (additive): files of this conversation that still hold conflict markers, as the host-worktree-apply text.
   */
  async syncStart(sessionId, { turnId, signal } = {}) {
    return this.serial(sessionId, async () => {
      let ctx;
      try { ctx = await this.context(sessionId); } catch (error) { console.warn(`session worktree sync ${sessionId}: ${error.message}`); return { status: 'skipped', conflicts: [] }; }
      if (!ctx) return { status: 'skipped', conflicts: [] };
      try {
        const { conflicts } = await this.converge(ctx, { turnId, signal });
        await this.copyAttachments(ctx, turnId);
        const marked = await this.openMarkers(ctx).catch(() => []);
        const rows = pathsOf(conflicts);
        return { status: rows.length ? 'partial' : 'clean', conflicts: rows,
          ...(rows.length ? { context: MODEL_TEXT.startSyncConflicts(rows.map(row => row.path)) } : {}),
          ...(marked.length ? { feedback: { source: FEEDBACK_SOURCES.worktreeApply, text: MODEL_TEXT.worktreeApplyFeedback({ mid: marked.at(-1).mid, files: [...new Set(marked.flatMap(row => row.paths))], nonText: [] }) } } : {}) };
      } catch (error) {
        if (signal?.aborted) return { status: 'skipped', conflicts: [] };
        console.warn(`session worktree sync ${sessionId}: ${error.message}`);
        return { status: 'skipped', conflicts: [] };
      }
    });
  }
  /** This turn's uploads live in P's attachments/ folder; one P ignores never reaches S by merge, so it is copied. */
  async copyAttachments(ctx, turnId) {
    const session = this.session(ctx.sessionId), turn = session?.turns.find(row => row.id === turnId);
    const item = session?.items.find(row => row.id === turn?.userItemId);
    for (const attachment of item?.attachments ?? []) {
      const path = attachment?.workspacePath;
      if (typeof path !== 'string' || !path || path.split('/').some(part => !part || part === '..' || part === '.' || ['.git', '.rna'].includes(part.toLowerCase()))) continue;
      const from = join(ctx.P.root, ...path.split('/')), to = join(ctx.S.root, ...path.split('/'));
      if (!within(ctx.S.root, to) || await exists(to)) continue;
      try {
        const real = await realpath(from);
        if (!within(ctx.P.root, real) || !(await lstat(real)).isFile()) continue;
        // S is where the agent works (a process it left running may still rename folders there): the folder the copy
        // lands in must be the real one inside S right before the copy and right after it (sameFolder), never a link
        // leading elsewhere; a copy that landed elsewhere is taken back out.
        const rootReal = await realpath(ctx.S.root), folder = dirname(to);
        await mkdir(folder, { recursive: true });
        if (!(await sameFolder(ctx.S.root, rootReal, folder))) continue;
        await copyFile(real, to, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
        if (!(await sameFolder(ctx.S.root, rootReal, folder))) { await unlink(to).catch(() => {}); console.warn(`session worktree ${ctx.record.id}: a folder of ${path} changed during the copy; it was taken back`); }
      } catch { /* the attachment stays readable through attachment_read */ }
    }
  }

  /**
   * Turn end step 3 (design §4.2; hostFinish → finishTurn, after the worker reminder and settleTurn, independent of
   * decisions): snapshot S; nothing new → `none`. Clean → write P (`all`, kind 'turn'), write P's side back into S
   * (`partial`), base := R, move S's HEAD → `applied`. Conflicted with fewer than LIMITS.applyContinuations
   * attempts this turn → pin preMerge, reverse merge with markers into S (MERGE_LABELS.reverseMarkers), base := P's
   * tree keeping old entries for non-text conflicts, timeline notice → `continue` with feedback. A second finish
   * whose files still hold this merge's markers counts as an attempt and is not applied. Out of attempts (or out of
   * the SDK's shared continuations) → `conflicted`, P untouched, HOST_CARDS.sessionConflict card.
   *
   * Additive: only non-text conflicts left (nothing the model can merge) → `conflicted` at once. Options
   * `onApplying` (the turn's phase), `onWaiting` (a git operation in P), `signal`. The turn's own finish keeps waiting
   * for a git operation in P with its line, stopped by the turn's signal (Stop); `hold` (a hand-back after the turn,
   * runtime-controller afterTurn) answers `pending` with reason `git_operation` at once instead, applied once the
   * operation ends (review ISO-1).
   * @param {string} sessionId
   * @param {{ turnId: string, continuationsLeft: number, signal?: AbortSignal, onApplying?: () => void, onWaiting?: (operation: string) => void, hold?: boolean }} options
   * @returns {Promise<FinishStep>}
   */
  async applyAtFinish(sessionId, { turnId, continuationsLeft = 0, signal, onApplying, onWaiting, hold = false } = {}) {
    return this.serial(sessionId, async () => {
      const ctx = await this.context(sessionId);
      if (!ctx) return { outcome: 'none', apply: this.turnOf(sessionId, turnId)?.apply ?? { status: 'none', applyIds: [] } };
      const current = this.turnOf(sessionId, turnId)?.apply ?? { status: 'none', applyIds: [] };
      const attempts = current.conflict?.attempts ?? 0, canContinue = attempts < LIMITS.applyContinuations && continuationsLeft > 0;
      // Markers of an open conflict still in S: never applied; the model gets another go while it may.
      const marked = await this.openMarkers(ctx);
      if (marked.length) {
        const files = [...new Set(marked.flatMap(row => row.paths))], mid = marked.at(-1).mid, fallback = { id: mid, preMerge: marked.at(-1).preMerge ?? null, paths: files.map(path => ({ path, kind: 'content' })) };
        if (canContinue) {
          const apply = this.setApply(sessionId, turnId, value => ({ ...value, status: 'none', conflict: { ...(value.conflict ?? fallback), attempts: attempts + 1 } }));
          return { outcome: 'continue', feedback: { source: FEEDBACK_SOURCES.worktreeApply, text: MODEL_TEXT.worktreeApplyFeedback({ mid, files, nonText: [] }) }, apply };
        }
        return this.conflicted(ctx, turnId, { conflict: { ...(current.conflict ?? fallback), attempts } });
      }
      onApplying?.();
      this.setApply(sessionId, turnId, value => ({ ...value, status: 'applying' }));
      let result;
      try { result = await this.forward(ctx, { turnId, signal, onWaiting, hold }); }
      catch (error) { this.setApply(sessionId, turnId, value => ({ ...value, status: value.applyIds.length ? 'applied' : 'pending', reason: signal?.aborted ? 'aborted' : 'blocked' })); throw error; }
      this.keptSecrets(ctx, turnId, result.snapshot);
      if (result.status === 'nothing') {
        // S is at its base: nothing of this conversation is unapplied, so earlier open conflicts are moot.
        this.settleOpen(sessionId, turnId);
        return { outcome: 'none', apply: this.setApply(sessionId, turnId, value => { const next = { ...value, status: value.applyIds.length ? 'applied' : 'none' }; if (value.conflict && next.status === 'none') delete next.conflict; return next; }) };
      }
      if (result.status === 'held' || result.status === 'blocked') {
        if (result.reason === 'git_operation') this.heldOnOperation(ctx, turnId, result.operation, current);
        return { outcome: 'none', apply: this.setApply(sessionId, turnId, value => ({ ...value, status: 'pending', reason: result.reason ?? 'blocked' })) };
      }
      if (result.status === 'applied') return { outcome: 'applied', apply: await this.applied(ctx, turnId, result, { finish: true }) };
      // Conflicted: nothing was written into P.
      const textual = result.conflicts.filter(row => text(row.kind)), others = result.conflicts.filter(row => !text(row.kind));
      if (!canContinue || !textual.length) {
        await this.pinPreMerge(ctx, result.snapshot.commit);
        return this.conflicted(ctx, turnId, { conflict: { id: result.mid, preMerge: result.snapshot.commit, paths: pathsOf(result.conflicts), attempts } });
      }
      // Reverse merge: the project folder's side goes into S, text conflicts with markers; the turn continues.
      const preMerge = await this.pinPreMerge(ctx, result.snapshot.commit);
      const record = this.recordOf(this.projectOf(this.session(sessionId)), ctx.record.id) ?? ctx.record, base = record.base ?? record.seed;
      const reverse = await this.engine.apply(ctx.projectId, { target: ctx.S, base, incoming: result.before, kind: 'turn', source: this.source(ctx, turnId), mode: 'markers', labels: MERGE_LABELS.reverseMarkers(), signal });
      const markedPaths = reverse.conflicts.filter(row => text(row.kind) && reverse.written.includes(row.path)).map(row => row.path);
      const left = reverse.conflicts.filter(row => !markedPaths.includes(row.path));
      await this.moveBase(ctx, await this.engine.syncBase(ctx.projectId, { current: result.before, previous: base, paths: left.map(row => row.path) }), result.before);
      if (!markedPaths.length) return this.conflicted(ctx, turnId, { conflict: { id: result.mid, preMerge, paths: pathsOf(result.conflicts), attempts } });
      this.addMarks(ctx, { mid: reverse.mid, turnId, paths: markedPaths, preMerge });
      this.notice(sessionId, turnId, { zh: '项目文件夹里这些文件也被改过，正在合并…', en: 'These files were also changed in the project folder; merging them…' });
      const conflict = { id: reverse.mid, preMerge, paths: pathsOf(reverse.conflicts.length ? reverse.conflicts : result.conflicts), attempts: attempts + 1 };
      const apply = this.setApply(sessionId, turnId, value => ({ ...value, status: 'none', conflict }));
      return { outcome: 'continue', feedback: { source: FEEDBACK_SOURCES.worktreeApply, text: MODEL_TEXT.worktreeApplyFeedback({ mid: reverse.mid, files: markedPaths, nonText: pathsOf(left.length ? left : others) }) }, apply };
    });
  }
  /**
   * Files that hold secrets (SECRET_FILES) this conversation changed in S (B8): snapshots never hold them, so no apply
   * carries them into P (S's snapshot `secret`: its owner's changes, snapshot.mjs secretChanged). The user is told
   * once per path with a timeline line (where they are, and that S's removal moves them to the trash), the model with
   * its next request (secretNoteUpdate, MODEL_TEXT.sessionSecretKept). The worktree record
   * keeps the paths told (`secretTold`: told again only after one left, e.g. the user copied it over) and those the
   * model has yet to hear (`secretNote`).
   * @param {object} ctx
   * @param {string} turnId
   * @param {import('./git-isolation/contract.mjs').Snapshot} [snapshot]  S's snapshot of this apply
   */
  keptSecrets(ctx, turnId, snapshot) {
    if (!Array.isArray(snapshot?.secret)) return;
    const kept = [...new Set(snapshot.secret)].slice(0, SECRET_PATHS);
    const record = this.recordOf(this.projectOf(this.session(ctx.sessionId)), ctx.record.id) ?? ctx.record;
    const told = new Set(record.secretTold ?? []), fresh = kept.filter(path => !told.has(path));
    if (!fresh.length && kept.length === told.size) return;
    this.setRecord(ctx.projectId, ctx.record.id, row => {
      if (kept.length) row.secretTold = kept; else delete row.secretTold;
      const note = [...new Set([...(row.secretNote ?? []).filter(path => kept.includes(path)), ...fresh])];
      if (note.length) row.secretNote = note; else delete row.secretNote;
    });
    if (!fresh.length) return;
    const shown = fresh.slice(0, SECRET_SHOWN), more = fresh.length - shown.length, where = relative(ctx.P.root, ctx.S.root) || '.';
    this.notice(ctx.sessionId, turnId, {
      zh: `这些文件存放密钥，Rna 从不把它们从这个对话的工作树应用到项目文件夹：${shown.join('、')}${more ? ` 等 ${fresh.length} 个` : ''}。改动只在工作树里（项目文件夹下的 ${where}），需要的话请自己复制过去。工作树被清理时（例如删除这个对话），它们会移到项目文件夹的 .rna/trash.nosync，保留 ${LIMITS.trashDays} 天。`,
      en: `These files hold secrets, which Rna never applies from this conversation’s worktree to the project folder: ${shown.join(', ')}${more ? ` and ${more} more` : ''}. The changes are only in the worktree (${where} in the project folder); copy them over yourself if you need them. When the worktree is cleaned up (for example when the conversation is deleted), they move to the project folder’s .rna/trash.nosync for ${LIMITS.trashDays} days.`,
    });
  }
  /**
   * The model's half of keptSecrets: what it has yet to hear (paths still kept) as one host context update for the
   * request being built (runtime-controller's request hook), taken once: the record forgets it. Read from the record
   * when the request is built, so it rides the first request after the apply that found them, never lost to a turn
   * whose requests all went out before its start sync finished. Null when there is nothing to tell, and for a side chat.
   * @param {string} sessionId
   * @param {string} turnId  the turn whose request carries it
   * @returns {{ key: string, source: string, scope: 'turn', text: string }|null}
   */
  secretNoteUpdate(sessionId, turnId) {
    const session = this.session(sessionId);
    if (!session?.worktree || session.kind === 'side') return null;
    const record = this.recordOf(this.projectOf(session), session.worktree.id);
    if (!record?.secretNote?.length) return null;
    const told = new Set(record.secretTold ?? []), paths = record.secretNote.filter(path => told.has(path));
    this.setRecord(session.projectId, record.id, row => { delete row.secretNote; });
    return paths.length ? { key: `worktree-secrets:${turnId}`, source: 'host-worktree-sync', scope: 'turn', text: MODEL_TEXT.sessionSecretKept(paths) } : null;
  }
  /** A write into P went through: record it on the turn, bring P's side into S, and settle open conflicts. */
  async applied(ctx, turnId, result, { finish = false, partial = [] } = {}) {
    let converged = null;
    try { converged = await this.converge(ctx, { turnId }); } catch (error) { console.warn(`session worktree ${ctx.record.id}: converge failed: ${error.message}`); }
    const ignored = finish ? await this.ignoredNew(ctx) : [];
    const conflicts = [...(result.conflicts ?? []), ...partial];
    if (!conflicts.length) this.settleOpen(ctx.sessionId, turnId);
    if (!conflicts.length) await this.engine.pin(ctx.projectId, [{ ref: REFS.worktree(ctx.record.id, 'premerge'), commit: null }]).catch(() => {});
    void converged;
    return this.setApply(ctx.sessionId, turnId, value => {
      const next = { ...value, status: conflicts.length ? 'pending' : 'applied', applyIds: [...new Set([...value.applyIds, ...(result.applyId ? [result.applyId] : [])])] };
      delete next.reason;
      if (Number.isFinite(result.bothChanged) && result.bothChanged) next.bothChanged = (value.bothChanged ?? 0) + result.bothChanged;
      if (ignored.length) next.ignoredNew = ignored;
      if (result.dependencies) next.dependencies = true;
      if (conflicts.length) next.conflict = { id: result.mid, preMerge: result.snapshot?.commit ?? value.conflict?.preMerge ?? null, paths: pathsOf(conflicts), attempts: value.conflict?.attempts ?? 0 };
      return next;
    });
  }
  /** P untouched, the turn ends; the user decides on the card. */
  async conflicted(ctx, turnId, { conflict }) {
    const apply = this.setApply(ctx.sessionId, turnId, value => ({ ...value, status: 'conflicted', conflict }));
    const card = this.postConflictCard(ctx.sessionId, turnId, conflict.paths);
    return { outcome: 'conflicted', apply: card ? this.setApply(ctx.sessionId, turnId, value => ({ ...value, card })) : apply };
  }

  /**
   * Control returns without a finish (design §4.2 "其他交还控制权的时刻", run()'s finally → afterTurn): ask_user
   * pause, user stop, failure. Only the clean part is applied (`all`); a conflict → `pending` + the card, no
   * continuation. Skipped when this hand-back already applied, and for the uncertain-tool recovery pause
   * (`recoveryPause: true`). Additive options: `signal` (a turn starting now cuts a wait short), `onWaiting`. The
   * user's git operation in P is never waited for here: `pending` with reason `git_operation`, one line, and the
   * apply runs again once the operation ends (review ISO-1).
   * @param {string} sessionId
   * @param {{ turnId: string, reason: 'interaction'|'cancelled'|'failed', recoveryPause?: boolean, signal?: AbortSignal, onWaiting?: (operation: string) => void }} options
   * @returns {Promise<TurnApply>}
   */
  async applyOnHandBack(sessionId, { turnId, reason, recoveryPause = false, signal, onWaiting } = {}) {
    void reason;
    if (recoveryPause) return this.turnOf(sessionId, turnId)?.apply ?? null;
    return this.serial(sessionId, () => this.cleanApply(sessionId, turnId, { signal, onWaiting, hold: true }));
  }
  /**
   * The clean part of S → P (markers of open conflicts left out); conflicts → `pending` and the card. `hold`: the
   * user's git operation in P → `pending` with reason `git_operation` at once (heldOnOperation), never waited for.
   */
  async cleanApply(sessionId, turnId, { signal, onWaiting, hold = false } = {}) {
    const ctx = await this.context(sessionId);
    if (!ctx || !turnId) return null;
    const marked = await this.openMarkers(ctx), exclude = [...new Set(marked.flatMap(row => row.paths))];
    const before = this.turnOf(sessionId, turnId)?.apply;
    this.setApply(sessionId, turnId, value => ({ ...value, status: 'applying' }));
    let result;
    try { result = await this.forward(ctx, { turnId, cleanOnly: true, exclude, signal, onWaiting, hold }); }
    catch (error) {
      if (!signal?.aborted) console.warn(`session worktree ${ctx.record.id}: apply failed: ${error.message}`);
      return this.setApply(sessionId, turnId, value => ({ ...value, status: before?.status && before.status !== 'applying' ? before.status : 'pending', reason: signal?.aborted ? 'aborted' : 'blocked' }));
    }
    this.keptSecrets(ctx, turnId, result.snapshot);
    if (result.status === 'nothing') {
      if (exclude.length) return this.setApply(sessionId, turnId, value => ({ ...value, status: 'pending' }));
      // S is at its base with no markers open: all of it is in P (a later turn or the worktree panel applied it). Holds
      // of this turn and of the others without an open conflict are over (review C3); open conflicts stay with their card.
      this.settleOpen(sessionId, turnId, { conflicts: false });
      return this.setApply(sessionId, turnId, value => {
        if (before?.status && !['applying', 'none'].includes(before.status) && !(before.status === 'pending' && !value.conflict)) return { ...value, status: before.status };
        const next = { ...value, status: value.applyIds.length ? 'applied' : 'none' }; delete next.reason; return next;
      });
    }
    if (result.status === 'held' || result.status === 'blocked') {
      if (result.reason === 'git_operation') this.heldOnOperation(ctx, turnId, result.operation, before);
      return this.setApply(sessionId, turnId, value => ({ ...value, status: 'pending', reason: result.reason ?? 'blocked' }));
    }
    const still = exclude.map(path => ({ path, kind: 'content' })).filter(row => !(result.conflicts ?? []).some(item => item.path === row.path));
    if (result.applyId) {
      const apply = await this.applied(ctx, turnId, result, { finish: true, partial: still });
      if (apply?.status === 'pending') return this.withCard(ctx, turnId, apply);
      return apply;
    }
    // Conflicted and nothing clean to write.
    await this.pinPreMerge(ctx, result.snapshot.commit);
    const apply = this.setApply(sessionId, turnId, value => ({ ...value, status: 'pending', conflict: { id: result.mid, preMerge: result.snapshot.commit, paths: pathsOf([...result.conflicts, ...still]), attempts: value.conflict?.attempts ?? 0 } }));
    return this.withCard(ctx, turnId, apply);
  }
  withCard(ctx, turnId, apply) {
    const card = this.postConflictCard(ctx.sessionId, turnId, apply.conflict?.paths ?? []);
    return card ? this.setApply(ctx.sessionId, turnId, value => ({ ...value, card })) : apply;
  }

  /**
   * Idle apply (design §4.2 "空闲时", §4.1 step 4): at daemon start, and after any write into S outside a turn
   * (a worker merged while the session is idle — T3 calls this). Clean part only; null when S has nothing new or
   * a turn is running. The apply is recorded on the conversation's last turn.
   * @returns {Promise<TurnApply|null>}
   */
  async applyIdle(sessionId) {
    const busy = () => { const session = this.session(sessionId); return !session || session.activeTurnId || session.status === 'running' || session.archivedAt || !session.worktree || session.worktree.state === 'pending'; };
    if (busy()) return null;
    const controller = new AbortController();
    this.idle.get(sessionId)?.abort(); this.idle.set(sessionId, controller);
    try {
      return await this.serial(sessionId, async () => {
        if (busy() || controller.signal.aborted) return null;
        const turnId = this.session(sessionId)?.turns.at(-1)?.id;
        const before = this.turnOf(sessionId, turnId)?.apply ?? null;
        // Never waits for the user's git operation in P: held (`git_operation`) and applied again once it ends.
        const apply = await this.cleanApply(sessionId, turnId, { signal: controller.signal, hold: true });
        return apply && JSON.stringify(apply) !== JSON.stringify(before) ? apply : null;
      });
    } catch (error) { console.warn(`session worktree idle apply ${sessionId}: ${error.message}`); return null; }
    finally { if (this.idle.get(sessionId) === controller) this.idle.delete(sessionId); }
  }
  /**
   * The timeline line while P has a git operation in progress (design §3.7), in the interface language; once per turn
   * and operation (a turn-end wait cut short by Stop, then its hand-back held, say the same thing once).
   */
  waiting(sessionId, turnId, operation) {
    const variants = { zh: `项目文件夹正在进行 git ${operation}，完成后再应用。`, en: `A git ${operation} is in progress in the project folder; the changes are applied after it finishes.` };
    const text = inLanguage(interfaceLanguageOf(this.store.state), variants);
    if (this.session(sessionId)?.items?.some(item => item.kind === 'notice' && item.source === 'worktree' && (item.turnId ?? null) === (turnId ?? null) && item.text === text)) return;
    this.notice(sessionId, turnId, variants);
  }

  /**
   * The answer to a HOST_CARDS.sessionConflict card: rna | conversation | project | later. conversation takes
   * preMerge's version of the conflicted files (never markers) after a checkpoint of P; project takes P's after a
   * checkpoint of S; rna opens a host-written turn; later keeps `pending`.
   * The latest open conflict of the conversation is the one decided (an older card answers for the same files).
   * While P has a git merge / rebase / … in progress the answer is not carried out and never waited for (review
   * ISO-1): it throws `git_operation_in_progress` (with `operation`) before anything is written, and react() holds
   * the answer with one timeline line (`waiting()`) and takes it up again once the operation ends. An operation that
   * begins part way stops it the same way (each write already made is noted on the turn). close() (shutdown,
   * maintenance) stops what does wait (`signal`, additive: a caller's own signal joins it); a stopped answer throws
   * AbortError.
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<TurnApply>}
   */
  async answerConflict(sessionId, turnId, choice, { signal: given } = {}) {
    if (!HOST_CARDS.sessionConflict.options.includes(choice)) throw this.fail('worktree_request_invalid', 400, { zh: '没有这个选项。', en: 'There is no such option.' });
    const open = () => [...(this.session(sessionId)?.turns ?? [])].reverse().find(turn => turn.apply?.conflict && ['conflicted', 'pending'].includes(turn.apply.status)) ?? null;
    if (choice === 'rna') {
      const target = open();
      if (!target) return this.turnOf(sessionId, turnId)?.apply ?? null;
      this.hostTurn(sessionId, target);
      return target.apply;
    }
    const signal = given ? AbortSignal.any([this.closing.signal, given]) : this.closing.signal;
    return this.serial(sessionId, async () => {
      signal.throwIfAborted();
      const target = open();
      if (!target) return this.turnOf(sessionId, turnId)?.apply ?? null;
      if (choice === 'later') return this.setApply(sessionId, target.id, value => ({ ...value, status: 'pending' }));
      const ctx = await this.context(sessionId);
      if (!ctx) return target.apply;
      // The user's git operation in P: neither folder is touched (its files may be half merged); held by react().
      const operation = await this.engine.projectBusy?.(ctx.projectId);
      if (operation) throw this.engine.operationRefused(operation);
      const held = result => { if (result.reason === 'git_operation') throw this.engine.operationRefused(result.operation ?? 'operation'); return this.setApply(sessionId, target.id, value => ({ ...value, status: 'pending', reason: result.reason })); };
      const conflict = target.apply.conflict, paths = (conflict.paths ?? []).map(row => row.path);
      const source = this.source(ctx, target.id), ids = [];
      // Each write is noted on the turn at once, so an answer stopped part way (shutdown) still lists what it wrote.
      const note = applyId => { ids.push(applyId); this.setApply(sessionId, target.id, value => ({ ...value, applyIds: [...new Set([...value.applyIds, applyId])] })); };
      const marks = await this.openMarkers(ctx);
      if (choice === 'conversation') {
        // The conversation's version of each conflicted file, from preMerge (taken before any marker was written).
        const preMerge = conflict.preMerge ?? marks.find(row => row.mid === conflict.id)?.preMerge ?? null, fromPre = preMerge ? paths : [];
        const now = await this.engine.snapshot(ctx.projectId, ctx.S, { pin: REFS.worktree(ctx.record.id, 'tip'), signal });
        const incoming = fromPre.length ? await this.engine.syncBase(ctx.projectId, { current: now.commit, previous: preMerge, paths: fromPre }) : now.commit;
        // Anything that still holds markers and has no preMerge version stays out of the project folder.
        const exclude = [...new Set(marks.flatMap(row => row.paths))].filter(path => !fromPre.includes(path));
        const result = await this.forward(ctx, { turnId: target.id, cleanOnly: true, incoming, exclude, signal, hold: true });
        if (result.status === 'held') return held(result);
        if (result.applyId) note(result.applyId);
        let refused = [];
        if (result.conflicts?.length) {
          const taken = await this.engine.take(ctx.projectId, { target: ctx.P, items: result.conflicts.map(row => ({ conflict: row, side: 'incoming' })), source, byUser: true, signal, hold: true });
          if (taken.applyId) note(taken.applyId);
          // What the engine would not write even on the user's word (a link leaving the folder, a gitlink, a file
          // that changed meanwhile) stays this conversation's and stays open: S keeps its version, the card stays.
          refused = taken.conflicts ?? [];
        }
        const kept = new Set(refused.map(row => row.path));
        await this.converge(ctx, { turnId: target.id, force: paths.filter(path => !kept.has(path)), signal });
        if (refused.length) return this.setApply(sessionId, target.id, value => ({ ...value, status: 'pending', applyIds: [...new Set([...value.applyIds, ...ids])], conflict: { ...value.conflict, paths: pathsOf(refused) } }));
      } else {
        // The project folder's version: S takes it first (a checkpoint of S), then the rest of S applies.
        await this.converge(ctx, { turnId: target.id, force: paths, signal });
        const exclude = [...new Set((await this.openMarkers(ctx)).flatMap(row => row.paths))];
        const result = await this.forward(ctx, { turnId: target.id, cleanOnly: true, exclude, signal, hold: true });
        if (result.status === 'held') return held(result);
        if (result.applyId) note(result.applyId);
        if (result.conflicts?.length) return this.setApply(sessionId, target.id, value => ({ ...value, status: 'pending', applyIds: [...new Set([...value.applyIds, ...ids])], conflict: { ...value.conflict, id: result.mid, paths: pathsOf(result.conflicts) } }));
        await this.converge(ctx, { turnId: target.id, signal });
      }
      this.settleOpen(sessionId, target.id);
      await this.engine.pin(ctx.projectId, [{ ref: REFS.worktree(ctx.record.id, 'premerge'), commit: null }]).catch(() => {});
      return this.setApply(sessionId, target.id, value => { const next = { ...value, status: 'applied', applyIds: [...new Set([...value.applyIds, ...ids])] }; delete next.reason; return next; });
    });
  }
  /** "让 Rna 再处理": a turn the host starts with the conflict as context (idle conversations only). */
  hostTurn(sessionId, target) {
    const conflict = target.apply.conflict, files = (conflict.paths ?? []).map(row => row.path);
    const textFiles = (conflict.paths ?? []).filter(row => text(row.kind)).map(row => row.path), nonText = (conflict.paths ?? []).filter(row => !text(row.kind));
    const list = files.slice(0, 8).join(this.say({ zh: '、', en: ', ' })) + (files.length > 8 ? this.say({ zh: ` 等 ${files.length} 个文件`, en: ` and ${files.length - 8} more` }) : '');
    try {
      return this.store.hostTurn?.(sessionId, {
        text: this.say({ zh: `请处理这个对话与项目文件夹的冲突：${list}。保留双方的意图，处理完再结束。`, en: `Please resolve the conflicts between this conversation and the project folder: ${list}. Keep both sides’ intent, then finish.` }),
        source: 'host-worktree',
        context: [{ source: FEEDBACK_SOURCES.worktreeApply, text: MODEL_TEXT.worktreeApplyFeedback({ mid: conflict.id, files: textFiles, nonText: pathsOf(nonText) }) }],
      }) ?? null;
    } catch (error) { console.warn(`session worktree host turn ${sessionId}: ${error.message}`); return null; }
  }

  /** The answer to a HOST_CARDS.sessionCreate card: project_folder drops session.worktree; retry re-runs the turn. */
  async answerCreate(sessionId, turnId, choice) {
    if (!HOST_CARDS.sessionCreate.options.includes(choice)) throw this.fail('worktree_request_invalid', 400, { zh: '没有这个选项。', en: 'There is no such option.' });
    const session = this.session(sessionId);
    if (!session) return { worktree: null, retried: false };
    if (choice === 'project_folder' && session.worktree?.state === 'pending') this.setSessionWorktree(sessionId, () => null);
    const current = this.session(sessionId), last = current?.turns.at(-1);
    let retried = false;
    if (current?.status === 'idle' && !current.activeTurnId && last?.id === turnId && last.status === 'failed') {
      try { this.store.controlSession(sessionId, 'retry'); retried = true; } catch { /* the conversation moved on */ }
    }
    return { worktree: this.session(sessionId)?.worktree ?? null, retried };
  }

  /**
   * Session archived (design §5.3): S at base → removed; otherwise one clean apply, and if anything is left S
   * becomes 'kept'. The user's git operation in P holds it (`held`, additive): archived again once it ends.
   * @returns {Promise<{ state: 'removed'|'kept'|'none'|'held' }>}
   */
  async archive(sessionId) {
    return this.serial(sessionId, async () => {
      let ctx;
      try { ctx = await this.context(sessionId); } catch { return { state: 'none' }; }
      if (!ctx) return { state: 'none' };
      const atBase = async () => {
        const record = this.recordOf(this.projectOf(this.session(sessionId)), ctx.record.id) ?? ctx.record;
        const snapshot = await this.engine.snapshot(ctx.projectId, ctx.S, { pin: REFS.worktree(ctx.record.id, 'tip') });
        return snapshot.tree === await ctx.objects.tree(record.base ?? record.seed);
      };
      if (!(await atBase())) {
        const turnId = this.session(sessionId)?.turns.at(-1)?.id;
        const apply = turnId ? await this.cleanApply(sessionId, turnId, { hold: true }).catch(() => null) : null;
        // The user's git operation in P: the archive's apply is not waited for; it runs again once that ends.
        if (apply?.status === 'pending' && apply.reason === 'git_operation') {
          try { this.engine?.whenProjectFree?.(ctx.projectId, `archive:${sessionId}`, () => { this.archived.delete(sessionId); this.scan(); }); } catch { /* the next start archives it */ }
          return { state: 'held' };
        }
        if (!(await atBase())) {
          this.worktrees?.setState?.(ctx.projectId, ctx.record.id, 'kept');
          this.setSessionWorktree(sessionId, row => ({ ...row, state: 'kept' }));
          return { state: 'kept' };
        }
      }
      await this.worktrees.remove(ctx.projectId, ctx.record.id);
      await this.engine.pin(ctx.projectId, [{ ref: REFS.worktree(ctx.record.id, 'premerge'), commit: null }]).catch(() => {});
      // Restored later, the conversation gets a fresh copy of the project folder on its next turn.
      this.setSessionWorktree(sessionId, row => ({ ...row, state: 'pending' }));
      return { state: 'removed' };
    });
  }

  /**
   * Before deleting a session (session-deletion.mjs): how many files S holds that P does not; > 0 requires the
   * user's explicit confirmation. Secret files this conversation changed (B8) count too, though no apply could carry
   * them: `secret` says how many of them there are (they go to the trash with S, not into Git).
   * @returns {Promise<{ unapplied: number, secret?: number }>}
   */
  async unapplied(sessionId) {
    const session = this.session(sessionId), project = this.projectOf(session);
    if (!session?.worktree || session.worktree.state === 'pending' || !project || !this.engine) return { unapplied: 0 };
    const record = this.recordOf(project, session.worktree.id);
    if (!record || record.state === 'removed') return { unapplied: 0 };
    const git = this.gitService(), located = await git.locateProject(project.id);
    if (located.repo === 'none') return { unapplied: 0 };
    const objects = objectGit(git, located), base = record.base ?? record.seed;
    let files, secret = 0;
    try {
      const S = await this.roots.rootOf({ projectId: project.id, sessionId }), snapshot = await this.engine.snapshot(project.id, S);
      files = await objects.changed(base, snapshot.commit);
      secret = new Set(snapshot.secret ?? []).size;
    } catch {
      // The folder is gone: its last snapshot tells.
      const tip = await objects.resolve(`${REFS.worktree(record.id, 'tip')}^{commit}`);
      files = tip ? await objects.changed(base, tip) : [];
    }
    return { unapplied: files.length + secret, ...(secret ? { secret } : {}) };
  }

  /**
   * Startup (additive; the lead calls it once the engine recovered): watch cards, archives and moved project
   * folders, archive conversations archived while the daemon was down, and apply what idle conversations have not
   * applied yet.
   * @returns {Promise<{ applied: string[], archived: string[] }>}
   */
  async recover() {
    this.watch();
    // Cards answered while the daemon was down (or whose answer a shutdown stopped) are taken up now.
    this.scan();
    const applied = [], archived = [], byProject = new Map();
    for (const session of [...this.store.state.sessions]) {
      if (!session.worktree || session.worktree.state === 'pending') continue;
      byProject.set(session.projectId, [...(byProject.get(session.projectId) ?? []), session]);
    }
    // Projects go on independently (review ISO-1): one project's slow or held apply never holds another's start.
    await Promise.allSettled([...byProject.values()].map(async sessions => {
      for (const session of sessions) {
        if (session.archivedAt) { if (session.worktree.state === 'active') { await this.archive(session.id).catch(() => null); archived.push(session.id); } continue; }
        if (await this.applyIdle(session.id).catch(() => null)) applied.push(session.id);
      }
    }));
    return { applied, archived };
  }
  /** Watch the store for answered cards, archived conversations and moved project folders. */
  watch() {
    if (this.unwatch || typeof this.store.subscribe !== 'function') return this.unwatch;
    for (const project of this.store.state.projects) this.folders.set(project.id, project.workspace);
    this.unwatch = this.store.subscribe(() => this.scan(), { display: false });
    return this.unwatch;
  }
  close() {
    this.unwatch?.(); this.unwatch = null;
    // Answers held on a git operation are taken up again by the next recover() (their cards are rescanned).
    this.heldAnswers.clear();
    for (const controller of this.idle.values()) controller.abort();
    // Card answers still waiting (a git merge / rebase in P) stop; their cards are answered again at the next start.
    this.closing.abort(); this.closing = new AbortController();
  }
  scan() {
    if (this.scanning) return;
    this.scanning = true;
    setImmediate(() => { this.scanning = false; this.react().catch(error => console.warn(`session worktrees: ${error.message}`)); });
  }
  async react() {
    const state = this.store.state;
    for (const project of state.projects) {
      const before = this.folders.get(project.id);
      this.folders.set(project.id, project.workspace);
      // The project folder moved (design §7.4): every Rna worktree in it is repaired, cached roots dropped.
      if (before !== undefined && before !== project.workspace && (project.git?.worktrees ?? []).some(row => row.state !== 'removed')) {
        this.roots?.invalidate?.({ projectId: project.id });
        await this.worktrees?.repair?.(project.id).catch(error => console.warn(`worktree repair ${project.id}: ${error.message}`));
      }
    }
    for (const session of state.sessions) {
      if (!session.worktree) continue;
      if (!session.archivedAt) this.archived.delete(session.id);
      if (session.archivedAt && session.worktree.state === 'active' && !this.archiving.has(session.id) && !this.archived.has(session.id)) {
        this.archiving.add(session.id); this.archived.add(session.id);
        void this.archive(session.id).catch(() => null).finally(() => this.archiving.delete(session.id));
      }
      for (const turn of session.turns.slice(-20)) {
        const card = turn.apply?.card, create = turn.worktreeCreate;
        for (const [entry, kind] of [[card, 'conflict'], [create, 'create']]) {
          // Closed meanwhile (shutdown): nothing new starts; the next start's recover() takes the cards up.
          if (!this.unwatch) return;
          if (!entry?.interactionId || entry.answered || this.answering.has(entry.interactionId) || this.heldAnswers.has(entry.interactionId)) continue;
          const record = session.items.find(item => item.interaction?.id === entry.interactionId)?.interaction;
          const choice = record?.status === 'answered' ? record.answers?.[0]?.selected?.[0] : null;
          if (!choice) continue;
          this.answering.add(entry.interactionId);
          try {
            this.markAnswered(session.id, turn.id, kind, choice);
            if (kind === 'conflict') await this.answerConflict(session.id, turn.id, choice);
            else await this.answerCreate(session.id, turn.id, choice);
          } catch (error) {
            // The user's git operation in P: the answer is held — one line, then taken up again once it ends.
            if (error?.code === 'git_operation_in_progress') { this.markAnswered(session.id, turn.id, kind, undefined); this.holdAnswer(session, turn.id, entry.interactionId, error.operation); }
            // Stopped by shutdown while it waited: the answer is taken up again at the next start.
            else if (error?.name === 'AbortError' || error?.code === 'aborted') this.markAnswered(session.id, turn.id, kind, undefined);
            else console.warn(`session worktree card ${entry.interactionId}: ${error.message}`);
          }
          finally { this.answering.delete(entry.interactionId); }
        }
      }
    }
  }
  /** A card answer held on the user's git operation in P: one timeline line; carried out once the operation ends. */
  holdAnswer(session, turnId, interactionId, operation) {
    this.heldAnswers.add(interactionId);
    this.waiting(session.id, turnId, operation ?? 'operation');
    const free = () => { this.heldAnswers.delete(interactionId); this.scan(); };
    try { if (typeof this.engine?.whenProjectFree === 'function') this.engine.whenProjectFree(session.projectId, `answer:${interactionId}`, free); else free(); } catch { free(); }
  }
  markAnswered(sessionId, turnId, kind, choice) {
    this.store.mutate(state => {
      const turn = state.sessions.find(row => row.id === sessionId)?.turns.find(row => row.id === turnId);
      const entry = kind === 'conflict' ? turn?.apply?.card : turn?.worktreeCreate;
      if (!entry) return;
      if (choice === undefined) delete entry.answered; else entry.answered = choice;
    });
  }

  /** HOST_CARDS.sessionConflict above the composer (one per turn; a later one in the same turn gets `:<n>`). */
  postConflictCard(sessionId, turnId, paths = []) {
    if (typeof this.interactions?.publish !== 'function') return null;
    this.watch();
    const turn = this.turnOf(sessionId, turnId), previous = turn?.apply?.card;
    const pending = previous && !previous.answered ? this.session(sessionId)?.items.find(item => item.interaction?.id === previous.interactionId)?.interaction : null;
    if (pending && ['pending', 'interrupted'].includes(pending.status)) return previous;
    // Answered, but the answer is still to be carried out (taken up now, or after a shutdown stopped it): that answer
    // decides these files, so no second card is posted for them (it would stay waiting once the answer settles them).
    const decided = previous && this.session(sessionId)?.items.find(item => item.interaction?.id === previous.interactionId)?.interaction;
    if (decided?.status === 'answered' && (!previous.answered || this.answering.has(previous.interactionId))) return previous;
    const base = HOST_CARDS.sessionConflict.actionId(turnId), actionId = previous ? `${base}:${(Number(/:(\d+)$/.exec(previous.actionId ?? '')?.[1]) || 1) + 1}` : base;
    const names = paths.map(row => row.path), list = names.slice(0, 12).join('\n');
    try {
      const record = this.interactions.publish({ sessionId, actionId, source: HOST_CARDS.sessionConflict.source, questions: [{ id: 'decision', header: this.say({ zh: '与项目文件夹冲突', en: 'Conflicts with the project folder' }),
        question: this.say({ zh: `这个对话改过的 ${names.length} 个文件，在项目文件夹里也被改过，还没有应用。要怎么处理？`, en: `${names.length} file(s) this conversation changed were also changed in the project folder, so they were not applied. What should happen?` }),
        ...(list ? { detail: `${list}${names.length > 12 ? this.say({ zh: `\n…还有 ${names.length - 12} 个`, en: `\n…and ${names.length - 12} more` }) : ''}` } : {}),
        options: [
          { id: 'rna', label: this.say({ zh: '让 Rna 再处理', en: 'Let Rna handle it' }), description: this.say({ zh: '再开一轮，由 Rna 合并这些文件。', en: 'Start another turn in which Rna merges these files.' }) },
          { id: 'conversation', label: this.say({ zh: '这些文件用这个对话的版本', en: 'Use this conversation’s version' }), description: this.say({ zh: '先给项目文件夹建检查点，可以回退。', en: 'The project folder gets a checkpoint first, so this can be rolled back.' }) },
          { id: 'project', label: this.say({ zh: '这些文件用项目文件夹的版本', en: 'Use the project folder’s version' }), description: this.say({ zh: '这个对话里对这些文件的改动会被替换；替换前先建检查点。', en: 'This conversation’s changes to these files are replaced; a checkpoint is taken first.' }) },
          { id: 'later', label: this.say({ zh: '稍后', en: 'Later' }), description: this.say({ zh: '下次交还给你时再试。', en: 'Try again the next time control comes back to you.' }) },
        ], allowCustom: false }] });
      return { interactionId: record.id, actionId };
    } catch (error) { console.warn(`session worktree conflict card ${sessionId}: ${error.message}`); return null; }
  }
  /** HOST_CARDS.sessionCreate: the worktree could not be created for this turn. */
  postCreateCard(sessionId, turnId) {
    if (typeof this.interactions?.publish !== 'function' || !turnId) return null;
    this.watch();
    // One card per failure: a retried turn that fails again gets a fresh one (`:<n>`) once the last was answered.
    const previous = this.turnOf(sessionId, turnId)?.worktreeCreate, base = HOST_CARDS.sessionCreate.actionId(turnId);
    const open = previous && !previous.answered ? this.session(sessionId)?.items.find(item => item.interaction?.id === previous.interactionId)?.interaction : null;
    if (open && ['pending', 'interrupted'].includes(open.status)) return open;
    const actionId = previous ? `${base}:${(Number(/:(\d+)$/.exec(previous.actionId ?? '')?.[1]) || 1) + 1}` : base;
    try {
      const record = this.interactions.publish({ sessionId, actionId, source: HOST_CARDS.sessionCreate.source, questions: [{ id: 'decision', header: this.say({ zh: '没能创建独立工作树', en: 'The worktree couldn’t be created' }),
        question: this.say({ zh: '这个对话要在独立工作树里运行，但没能创建工作树。要怎么继续？', en: 'This conversation runs in its own worktree, but the worktree couldn’t be created. How should it continue?' }),
        options: [
          { id: 'project_folder', label: this.say({ zh: '改在项目文件夹里继续', en: 'Continue in the project folder' }), description: this.say({ zh: '这个对话以后直接改项目文件夹里的文件。', en: 'From now on this conversation changes the project folder’s files directly.' }) },
          { id: 'retry', label: this.say({ zh: '重试', en: 'Retry' }), description: this.say({ zh: '再试一次创建工作树。', en: 'Try creating the worktree again.' }) },
        ], allowCustom: false }] });
      this.store.mutate(state => { const turn = state.sessions.find(row => row.id === sessionId)?.turns.find(row => row.id === turnId); if (turn) turn.worktreeCreate = { interactionId: record.id, actionId }; });
      return record;
    } catch (error) { console.warn(`session worktree create card ${sessionId}: ${error.message}`); return null; }
  }
}
