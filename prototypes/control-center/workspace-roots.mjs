import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { WORKTREE_DIR } from './git-isolation/contract.mjs';
import { registeredWorkspacePath } from './workspace-directories.mjs';
import { interfaceLanguageOf, inLanguage } from './interface-language.mjs';

// Root resolution (worktree design 0.63 §9): which folder a conversation, a worker or a background run actually
// works in. Owner: T2 (bodies); the interface is the lead's contract (git-isolation/CONTRACT.md).
//
// `session.workspace` stays P for every session (design §1 #11): the actual root comes from here. A root is P, or a
// worktree that has a record in `project.git.worktrees`, lies under `<P>/.rna/worktrees.nosync/`, and is listed by
// `git worktree list --porcelain` of the same common dir (WorkspaceGitService.locateWorktree). Anything else is
// refused; a missing worktree folder is an error, never answered with P (invariant §0.3-6, risk §14-1).
//
// Which record a query names is read from state alone (target()); the disk and git only confirm it (rootOf). Answers
// are cached per query; every rootOf still checks that the folder is there and that state still names the same
// worktree, and peek()/current() never touch the disk, so terminals, previews and file reads can recheck on every
// state change.

/**
 * @typedef {import('./git-isolation/contract.mjs').RootInfo} RootInfo
 *
 * @typedef {object} RootQuery
 * @property {string} projectId
 * @property {string} [sessionId]  A session worktree (session.worktree.state 'active' or 'kept') → S, else P.
 * @property {string} [agentId]    A worker with `delegation.worktree` → W, else its session's root.
 * @property {string} [actionId]   A background run with a `b-` worktree → B, else P.
 *
 * @typedef {(projectId: string) => number} ExecRunning
 *   Direct-mode `project_exec` runs in progress for a project (design §3.7). Implemented by T4 as
 *   RuntimeController#execRunning(projectId), counting tool_execution_start/end of project_exec in direct-mode
 *   (non-isolated) foreground turns; wired by the lead into IsolationEngine ({ execRunning }) and into this
 *   resolver. Synchronous, never throws, 0 for an unknown project.
 */

/** ExecRunning before T4's is wired: nothing is ever running. */
export const noExecRunning = () => 0;

/** Record states a root may be answered for; `removed` and `missing` ones are gone (worktree_missing). */
const LIVE_STATES = new Set(['active', 'kept', 'conflicted']);
const within = (root, path) => { const part = relative(root, path); return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };
const keyOf = ({ projectId, sessionId, agentId, actionId } = {}) => [projectId, sessionId ?? '', agentId ?? '', actionId ?? ''].join('\0');

/** The project.git.worktrees row a worktree id names (any state), or null. */
export function worktreeRecord(project, worktreeId) {
  return (project?.git?.worktrees ?? []).find(row => row.id === worktreeId) ?? null;
}

export class RootResolver {
  /**
   * @param {import('./store.mjs').Store} store
   * @param {{ git?: import('./workspace-git-service.mjs').WorkspaceGitService, execRunning?: ExecRunning }} [options]
   */
  constructor(store, { git = null, execRunning = noExecRunning } = {}) {
    Object.assign(this, { store, git, execRunning });
    /** query key → RootInfo */
    this.cache = new Map();
  }
  say(variants) { return inLanguage(interfaceLanguageOf(this.store.state), variants); }
  fail(code, status, variants, extra = {}) { return Object.assign(new Error(this.say(variants)), { status, code, ...extra }); }

  /**
   * What state alone says a query resolves to: `{ kind: 'project' }` or `{ kind, record }` (a live worktree row).
   * Throws the same errors as rootOf (project_not_found, session_not_found, delegation_unknown, worktree_pending,
   * worktree_missing). Never touches the disk.
   * @param {RootQuery} query
   * @returns {{ kind: 'project', project: object } | { kind: 'session'|'worker'|'background', record: object, project: object }}
   */
  target({ projectId, sessionId, agentId, actionId } = {}) {
    const state = this.store.state, project = state.projects.find(row => row.id === projectId);
    if (!project) throw this.fail('project_not_found', 404, { zh: '项目不存在。', en: 'This project no longer exists.' });
    const worktree = (kind, worktreeId) => {
      const record = worktreeRecord(project, worktreeId);
      if (!record || !LIVE_STATES.has(record.state)) throw this.fail('worktree_missing', 409, { zh: '这个工作树已经不在了，不会改在项目文件夹里继续。', en: 'This worktree is gone; work does not move to the project folder instead.' }, { worktreeId });
      return { kind, record, project };
    };
    const sessionRoot = id => {
      const session = state.sessions.find(row => row.id === id);
      if (!session || session.projectId !== project.id) throw this.fail('session_not_found', 404, { zh: '这个对话不属于该项目。', en: 'This conversation isn’t part of the project.' });
      if (!session.worktree) return { kind: 'project', project };
      if (session.worktree.state === 'pending') throw this.fail('worktree_pending', 409, { zh: '这个对话的工作树还没有创建，第一轮开始时创建。', en: 'This conversation’s worktree hasn’t been created yet; its first turn creates it.' }, { worktreeId: session.worktree.id });
      if (session.worktree.state === 'missing') throw this.fail('worktree_missing', 409, { zh: '这个对话的工作树已经不在了。', en: 'This conversation’s worktree is gone.' }, { worktreeId: session.worktree.id });
      return worktree('session', session.worktree.id);
    };
    if (agentId) {
      for (const session of state.sessions) {
        if (session.projectId !== project.id || (sessionId && session.id !== sessionId)) continue;
        for (const turn of session.turns ?? []) {
          const row = (turn.delegations ?? []).find(item => item.id === agentId);
          if (row) return row.worktree?.id ? worktree('worker', row.worktree.id) : sessionRoot(session.id);
        }
      }
      throw this.fail('delegation_unknown', 404, { zh: '本项目没有这个子任务。', en: 'There is no such subtask in this project.' });
    }
    if (actionId) {
      const record = (project.git?.worktrees ?? []).find(row => row.kind === 'background' && row.owner?.actionId === actionId && row.state !== 'removed');
      return record ? worktree('background', record.id) : { kind: 'project', project };
    }
    if (sessionId) return sessionRoot(sessionId);
    return { kind: 'project', project };
  }

  /** P, resolved: a real directory, or workspace_missing. */
  async projectFolder(project) {
    try {
      const folder = await realpath(registeredWorkspacePath(project.workspace));
      if ((await lstat(folder)).isDirectory()) return folder;
    } catch { /* reported below */ }
    throw this.fail('workspace_missing', 409, { zh: '项目文件夹找不到了。', en: 'The project folder can’t be found.' });
  }

  /**
   * Resolve and validate the root for a query, most specific first (agentId, actionId, sessionId, projectId).
   * The answer is cached until invalidate(); each call still checks that the cached worktree folder exists.
   * Errors (thrown with `status` and `code`): project_not_found 404, session_not_found 404, workspace_missing
   * 409 (P is gone), worktree_pending 409 (a session worktree the first turn has not created yet), worktree_missing
   * 409 (its folder is gone), root_denied 403 (not P and not a registered, listed Rna worktree).
   * @param {RootQuery} query
   * @returns {Promise<RootInfo>}
   */
  async rootOf(query) {
    const key = keyOf(query), target = this.target(query), folder = await this.projectFolder(target.project);
    if (target.kind === 'project') {
      const info = { root: folder, kind: 'project', isolated: false, project: folder };
      this.cache.set(key, info);
      return info;
    }
    const cached = this.cache.get(key);
    if (cached?.worktreeId === target.record.id && cached.project === folder) {
      const there = await lstat(cached.root).then(info => info.isDirectory(), () => false);
      if (there) return cached;
      this.cache.delete(key);
    }
    const info = await this.validate(target, folder);
    this.cache.set(key, info);
    return info;
  }

  /**
   * A worktree record's root, confirmed: under `<P>/.rna/worktrees.nosync/` once resolved, its folder there, and
   * listed by git for the same repository with the project's folder inside it (locateWorktree).
   */
  async validate({ kind, record, project }, folder) {
    const missing = () => this.fail('worktree_missing', 409, { zh: '这个工作树的文件夹已经不在了，不会改在项目文件夹里继续。', en: 'This worktree’s folder is gone; work does not move to the project folder instead.' }, { worktreeId: record.id });
    const denied = () => this.fail('root_denied', 403, { zh: '这个文件夹不是本项目登记的 Rna 工作树。', en: 'That folder isn’t one of this project’s registered Rna worktrees.' }, { worktreeId: record.id });
    const base = join(folder, ...WORKTREE_DIR.split('/'));
    if (typeof record.dir !== 'string' || typeof record.name !== 'string' || record.dir !== `${WORKTREE_DIR}/${record.name}` || !/^[A-Za-z0-9_-]{1,80}$/.test(record.name) || (record.gitName !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(record.gitName))) throw denied();
    const lexical = join(folder, ...record.dir.split('/'));
    let top;
    try { top = await realpath(lexical); } catch { throw missing(); }
    // The `.rna` folders on the way must not lead elsewhere (a link swapped in).
    if (top !== lexical || !within(await realpath(base).catch(() => base), top) || top === base) throw denied();
    if (!this.git) throw denied();
    const located = await this.git.locateProject(project.id);
    if (located.repo === 'none') throw located.unavailable === 'workspace_missing' ? this.fail('workspace_missing', 409, { zh: '项目文件夹找不到了。', en: 'The project folder can’t be found.' }) : denied();
    if (await realpath(located.workspace).catch(() => null) !== folder) throw denied();
    let answered;
    try { answered = await this.git.locateWorktree(located, top); }
    catch (error) { if (error.status === 403 || error.code === 'git_worktree_denied') throw denied(); throw error; }
    if (answered.repo === 'none') throw answered.unavailable === 'workspace_missing' ? missing() : denied();
    if (answered.worktree !== top || !within(top, answered.workspace)) throw denied();
    // GIT_DIR comes from the record (design §3.1): git must have filed this worktree under the record's name (or the
    // `gitName` WorktreeService noted when git chose another).
    const commonDir = await realpath(located.commonDir), gitDir = join(commonDir, 'worktrees', record.gitName ?? record.name);
    if (await realpath(answered.gitDir).catch(() => null) !== gitDir) throw denied();
    return { root: answered.workspace, kind, isolated: true, project: folder, prefix: located.prefix ?? '', worktreeId: record.id, gitDir, workTree: top };
  }

  /**
   * The last answer rootOf() gave for this query, without touching the disk (sync callers inside a turn that
   * already awaited rootOf at preparing_workspace). Null when not resolved yet, or when state names another root now.
   * @param {RootQuery} query
   * @returns {RootInfo|null}
   */
  peek(query) {
    const cached = this.cache.get(keyOf(query));
    return cached && this.current(query, cached) ? cached : null;
  }

  /**
   * Whether state still resolves `query` to the root `info` describes (same kind and worktree), without touching the
   * disk: terminals, previews and file reads recheck this on every state change.
   * @param {RootQuery} query
   * @param {{ kind: string, worktreeId?: string }} info
   */
  current(query, info) {
    try {
      const target = this.target(query);
      return target.kind === 'project' ? info?.kind === 'project' : info?.kind === target.kind && info.worktreeId === target.record.id;
    } catch { return false; }
  }

  /**
   * Drop cached answers: after a worktree is created, removed or repaired, after a project folder moved
   * (design §7.4), or when a session's worktree state changes.
   * @param {{ projectId?: string, sessionId?: string, worktreeId?: string }} [scope]  none: everything
   */
  invalidate({ projectId, sessionId, worktreeId } = {}) {
    if (!projectId && !sessionId && !worktreeId) { this.cache.clear(); return; }
    for (const [key, info] of this.cache) {
      const [project, session] = key.split('\0');
      if ((projectId && project === projectId) || (sessionId && session === sessionId) || (worktreeId && info.worktreeId === worktreeId)) this.cache.delete(key);
    }
  }
}
