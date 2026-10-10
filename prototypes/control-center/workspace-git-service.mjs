import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { registeredWorkspacePath } from './workspace-directories.mjs';
import { toolPermitted } from './project-permissions.mjs';
import { interfaceLanguageOf, inLanguage } from './interface-language.mjs';
import { ENGINE_ENV, engineArgs } from './git-isolation/env.mjs';

// 工作区改动 panel, L2 (layout plan §3): the project folder's git state, read
// and staged, never committed (D3). Every call is `execFile` (no shell) in the
// project's workspace, with locks, prompts and ambient config turned off, a
// timeout and an output cap (harness workspace-changes/git.ts, zcode
// gitCliRepo.ts). Paths are always relative to the project's workspace, which
// may be a subfolder of the repository. Discarding needs a second, explicit
// confirmation and is never offered as an agent tool. A repository at the top of
// the home folder (dotfiles kept in git) is not the project's: the folder reads
// as no repository, so the panel shows Rna's own records instead of every file
// under the home folder as new. Reads may name another worktree of the same
// repository (`worktree`); writes act on the project folder only. Branches,
// the base → target comparison and batched patches: workspace-git-compare.mjs.

const STATUS_BYTES = 512 * 1024, DIFF_BYTES = 1024 * 1024, COMMAND_MS = 15000, DIFF_MS = 20000, WRITE_MS = 60000;
const MAX_PATHS = 500, DISCARD_TTL_MS = 120000, TOOLS_RECHECK_MS = 60000, MAX_PENDING_DISCARDS = 32, FOLDER_LIST_BYTES = 4 * 1024 * 1024;
// Variables a parent git process (a hook that launched the daemon) would leak into ours, pointing at its repository,
// and pathspec or attribute switches that would change what our paths mean (any of the pathspec ones next to
// GIT_LITERAL_PATHSPECS makes every command fail). GIT_CEILING_DIRECTORIES stays: it only stops the search for
// a repository early, never points git at another one.
const LOCAL_ENV = ['GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_GRAFT_FILE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_INTERNAL_SUPER_PREFIX', 'GIT_NAMESPACE', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX', 'GIT_REPLACE_REF_BASE', 'GIT_SHALLOW_FILE', 'GIT_WORK_TREE',
  'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS', 'GIT_ATTR_SOURCE'];
const OPERATIONS = [['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect']];
// Diff flags shared by every patch and count: no configured external diff or text conversion program runs.
export const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--find-renames'];
// The whole file as context (展开 N 行): past a few million lines the patch is over its byte cap anyway.
export const FULL_CONTEXT = '--unified=10000000';
const STATUS_CHAR = { M: 'M', T: 'M', A: 'A', C: 'A', D: 'D', R: 'R', U: 'U' };
// `status.showUntrackedFiles` turned off: `no`, or (git 2.46+) any false boolean, which `--type=bool-or-str` reads as `false`.
const UNTRACKED_OFF = /^(?:no|false|off|0)$/i;

export const fail = (message, status = 400, code) => { throw Object.assign(new Error(message), { status, ...(code ? { code } : {}) }); };
export const within = (root, path) => { const part = relative(root, path); return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };
const sorted = paths => [...paths].sort();

/**
 * The first `git` file in an absolute PATH folder (null: none). Empty and
 * relative entries are skipped: execFile resolves them against the project
 * folder it runs in, so a `git` file committed there would run instead.
 */
export function resolveGitOnPath(env = process.env, platform = process.platform) {
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, platform === 'win32' ? 'git.exe' : 'git');
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}
const realOrSelf = path => { try { return realpathSync(path); } catch { return path; } };
/** `xcode-select -p`, or null when no developer directory is selected (never starts the installer). */
function xcodeSelectPath() {
  return new Promise(done => execFile('/usr/bin/xcode-select', ['-p'], { timeout: 3000, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => done(error ? null : String(stdout).trim() || null)));
}

/**
 * Records of `git status --porcelain=v2 --branch -z`, paths made relative to
 * the workspace (`prefix` is its folder in the repository). `submodules` lists
 * the changed paths that are submodules (`S…` in the record).
 */
export function parseStatus(text, prefix = '') {
  const result = { oid: null, branch: null, detached: false, upstream: null, ahead: 0, behind: 0, conflicted: [], staged: [], unstaged: [], untracked: [], submodules: [] };
  const records = text.split('\0');
  const local = path => (!prefix ? path : path.startsWith(prefix) ? path.slice(prefix.length) : null);
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' '), value = rest.join(' ');
      if (key === 'branch.oid') result.oid = value;
      else if (key === 'branch.head') { result.detached = value === '(detached)'; result.branch = result.detached ? null : value; }
      else if (key === 'branch.upstream') result.upstream = value;
      else if (key === 'branch.ab') { const match = /^\+(\d+) -(\d+)$/.exec(value); if (match) { result.ahead = Number(match[1]); result.behind = Number(match[2]); } }
      continue;
    }
    const fields = record.split(' ');
    if (fields[0] === '?') { const path = local(record.slice(2)); if (path) result.untracked.push({ path, status: '?', added: null, removed: null }); continue; }
    if (fields[0] === 'u') { const path = local(fields.slice(10).join(' ')); if (path) result.conflicted.push({ path, status: 'U', added: null, removed: null }); continue; }
    if (fields[0] !== '1' && fields[0] !== '2') continue;
    const renamed = fields[0] === '2', [x, y] = fields[1];
    const path = local(fields.slice(renamed ? 9 : 8).join(' '));
    const original = renamed ? records[++index] : null;
    // Seen from the workspace folder, a file moved in from outside it is new, and one moved out of it is gone.
    const oldPath = renamed && original ? local(original) : null;
    if (!path) { if (oldPath && x !== '.') result.staged.push({ path: oldPath, status: 'D', added: null, removed: null }); continue; }
    if (fields[2]?.startsWith('S')) result.submodules.push(path);
    if (x !== '.') result.staged.push({ path, ...(oldPath ? { oldPath } : {}), status: x === 'R' && renamed ? (oldPath ? 'R' : 'A') : STATUS_CHAR[x] ?? 'M', added: null, removed: null });
    if (y !== '.') result.unstaged.push({ path, status: STATUS_CHAR[y] === 'R' ? 'M' : STATUS_CHAR[y] ?? 'M', added: null, removed: null });
  }
  return result;
}
/** `git diff --numstat -z` → path → counts (`binary` when git reports "-"). */
export function parseNumstat(text) {
  const counts = new Map(), records = text.split('\0');
  for (let index = 0; index < records.length; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[index]);
    if (!match) continue;
    let path = match[3];
    if (!path) { index += 2; path = records[index] ?? ''; }
    if (!path) continue;
    const binary = match[1] === '-' && match[2] === '-';
    counts.set(path, binary ? { added: null, removed: null, binary: true } : { added: Number(match[1]), removed: Number(match[2]) });
  }
  return counts;
}
/** `git diff --name-status -z` → rows with status letters (renames carry their old path). */
export function parseNameStatus(text) {
  const rows = [], records = text.split('\0');
  for (let index = 0; index < records.length; index++) {
    const code = records[index];
    if (!code || !/^[A-Z]\d*$/.test(code)) continue;
    if (code[0] === 'R' || code[0] === 'C') { const oldPath = records[++index], path = records[++index]; if (path) rows.push({ path, ...(code[0] === 'R' ? { oldPath } : {}), status: code[0] === 'R' ? 'R' : 'A' }); continue; }
    const path = records[++index];
    if (path) rows.push({ path, status: STATUS_CHAR[code[0]] ?? 'M' });
  }
  return rows;
}
/** `git worktree list --porcelain` blocks. */
export function parseWorktrees(text) {
  return text.split('\n\n').map(block => block.split('\n').filter(Boolean)).filter(lines => lines.length).map(lines => {
    const row = { path: null, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
    for (const line of lines) {
      const [key, ...rest] = line.split(' '), value = rest.join(' ');
      if (key === 'worktree') row.path = value;
      else if (key === 'HEAD') row.head = value;
      else if (key === 'branch') row.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'detached') row.detached = true;
      else if (key === 'bare') row.bare = true;
      else if (key === 'locked') { row.locked = true; if (value) row.lockedReason = value; }
      else if (key === 'prunable') { row.prunable = true; if (value) row.prunableReason = value; }
    }
    return row;
  }).filter(row => row.path);
}
export const withCounts = (rows, counts) => rows.map(row => { const count = counts.get(row.path); return count ? { ...row, ...count } : row; });
/** A patch cut at the cap ends on its last whole line. */
export const wholeLines = text => { const end = text.lastIndexOf('\n'); return end < 0 ? '' : text.slice(0, end + 1); };
export const BINARY_PATCH = /^(?:Binary files .* differ|GIT binary patch)$/m;
const LETTERS = { 7: 'a', 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r', 34: '"', 92: '\\' };
const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
/** A name as git prints it with core.quotePath=false: double-quoted and C-escaped when it holds a control character, `"` or `\`. */
export function quoteName(name) {
  if (!/[\x00-\x1f\x7f"\\]/.test(name)) return name;
  let quoted = '"';
  for (const char of name) {
    const code = char.codePointAt(0);
    quoted += LETTERS[code] ? `\\${LETTERS[code]}` : code < 0x20 || code === 0x7f ? `\\${code.toString(8).padStart(3, '0')}` : char;
  }
  return `${quoted}"`;
}
/** A C-quoted name at the start of `text` (octal escapes are bytes of UTF-8): `{ name, rest }`, or null. */
export function unquoteName(text) {
  if (text[0] !== '"') return null;
  const bytes = [];
  for (let index = 1; index < text.length;) {
    const char = text[index];
    if (char === '"') return { name: Buffer.from(bytes).toString('utf8'), rest: text.slice(index + 1) };
    if (char === '\\') {
      const octal = text.slice(index + 1, index + 4), next = text[index + 1];
      if (/^[0-7]{3}$/.test(octal)) { bytes.push(parseInt(octal, 8)); index += 4; continue; }
      if (next !== undefined && next in ESCAPES) { bytes.push(ESCAPES[next]); index += 2; continue; }
      return null;
    }
    const piece = String.fromCodePoint(text.codePointAt(index));
    bytes.push(...Buffer.from(piece, 'utf8')); index += piece.length;
  }
  return null;
}
const plainOrQuoted = text => (text.startsWith('"') ? unquoteName(text)?.name ?? null : text);
/**
 * The path a `diff --git` section is about (its new name), or null when the
 * header can't be read (cut off at the cap). A moved file names itself on
 * its `rename to` / `copy to` line; otherwise both sides of the header carry
 * the same path, quoted alike, so a name with spaces splits in the middle.
 */
function sectionPath(section) {
  const end = section.indexOf('\n');
  if (end < 0) return null;
  const header = section.slice('diff --git '.length, end);
  for (let start = end + 1; start > 0 && start < section.length;) {
    const stop = section.indexOf('\n', start), line = section.slice(start, stop < 0 ? undefined : stop);
    if (/^(?:@@|--- |\+\+\+ |Binary files |GIT binary patch)/.test(line)) break;
    const moved = /^(?:rename|copy) to (.*)$/.exec(line);
    if (moved) return plainOrQuoted(moved[1]);
    start = stop + 1;
  }
  if (header.startsWith('"')) {
    const first = unquoteName(header), second = first?.rest.startsWith(' ') ? unquoteName(first.rest.slice(1)) : null;
    return second?.name.startsWith('b/') ? second.name.slice(2) : null;
  }
  const half = (header.length - 1) / 2;
  if (!Number.isInteger(half) || header[half] !== ' ') return null;
  const a = header.slice(0, half), b = header.slice(half + 1);
  return a.startsWith('a/') && b.startsWith('b/') && a.slice(2) === b.slice(2) ? b.slice(2) : null;
}
/** One `git diff` output (prefixes a/ and b/) → its sections in order, `{ path, patch }` (path null when unreadable). */
export function splitPatch(text) {
  const sections = [];
  for (let start = text.startsWith('diff --git ') ? 0 : text.indexOf('\ndiff --git ') + 1 || -1; start >= 0 && start < text.length;) {
    const next = text.indexOf('\ndiff --git ', start), patch = text.slice(start, next < 0 ? text.length : next + 1);
    sections.push({ path: sectionPath(patch), patch });
    start = next < 0 ? -1 : next + 1;
  }
  return sections;
}

export class WorkspaceGitService {
  /**
   * `owners` (worktree design 0.63 §12): realPath → { rna, owner }, who a worktree belongs to (WorktreeService#ownerOf,
   * wired by the lead). `engine`: the merge engine (IsolationEngine), so a discard takes its `user_discard` checkpoint
   * before any file changes (invariant §0.3-1).
   */
  constructor(store, { git = 'git', platform = process.platform, resolveGit = resolveGitOnPath, developerDirectory = xcodeSelectPath, home = homedir, timeoutMs = COMMAND_MS, statusMaxBytes = STATUS_BYTES, diffMaxBytes = DIFF_BYTES, diffTimeoutMs = DIFF_MS, writeTimeoutMs = WRITE_MS, discardTtlMs = DISCARD_TTL_MS, now = Date.now, owners = null, engine = null } = {}) {
    Object.assign(this, { store, git, platform, resolveGit, developerDirectory, home, timeoutMs, statusMaxBytes, diffMaxBytes, diffTimeoutMs, writeTimeoutMs, discardTtlMs, now, owners, engine });
    /** Repositories whose detailed untracked listing overflowed once: listed by folder from then on (zcode). */
    this.collapsed = new Set();
    this.inflight = new Map(); this.queues = new Map(); this.pending = new Map(); this.tools = null;
  }
  say(variants) { return inLanguage(interfaceLanguageOf(this.store.state), variants); }
  project(id) {
    const project = this.store.state.projects.find(row => row.id === id);
    if (!project) fail(this.say({ zh: '项目不存在。', en: 'This project no longer exists.' }), 404, 'project_not_found');
    if (project.archivedAt) fail(this.say({ zh: '项目已归档，请先恢复。', en: 'This project is archived. Restore it first.' }), 409, 'project_archived');
    return project;
  }
  unavailable(reason) {
    const message = {
      workspace_missing: { zh: '项目文件夹找不到了。', en: 'The project folder can’t be found.' },
      git_missing: { zh: '这台电脑上没有可用的 Git。', en: 'Git isn’t available on this computer.' },
      developer_tools: { zh: '这台 Mac 还没有安装开发者命令行工具，Git 暂时不可用。', en: 'This Mac doesn’t have the command line developer tools yet, so Git isn’t available.' },
      timed_out: { zh: 'Git 响应太慢，稍后再试。', en: 'Git took too long to answer. Try again shortly.' },
      git_failed: { zh: 'Git 没能读取这个文件夹。', en: 'Git couldn’t read this folder.' },
    }[reason];
    return { reason, message: this.say(message) };
  }
  /**
   * Whether git can run without side effects, and the absolute path it runs
   * from (never looked up from the project folder). On macOS the
   * /usr/bin/git stub opens the "install developer tools" prompt when no
   * developer directory is set, so that case is reported instead of run.
   * Rechecked after a minute so installing the tools later is noticed.
   */
  async availability() {
    if (this.tools && (this.tools.ok || this.now() - this.tools.at < TOOLS_RECHECK_MS)) return this.tools;
    let ok = true, reason = null;
    const binary = isAbsolute(this.git) ? this.git : this.resolveGit();
    if (!binary) { ok = false; reason = 'git_missing'; }
    else if (this.platform === 'darwin' && realOrSelf(binary) === '/usr/bin/git') {
      const developer = await this.developerDirectory();
      if (!developer || !existsSync(join(developer, 'usr/bin/git'))) { ok = false; reason = 'developer_tools'; }
    }
    return this.tools = { ok, reason, at: this.now(), ...(ok ? { binary } : {}) };
  }
  /**
   * One git command. A nonzero exit is a result, not an exception; only a
   * missing executable (or folder) throws. Reads take no lock (status skips
   * its optional refresh; `diff` would otherwise rewrite the index under
   * index.lock whenever a file's timestamps moved), so cutting one off at its
   * time limit with SIGKILL leaves nothing behind. Writes are stopped with
   * SIGTERM instead, on which git removes its index.lock.
   *
   * Merge engine options (worktree design 0.63 §3.1): `env` is merged in after
   * the parent's repository variables are stripped (GIT_DIR / GIT_WORK_TREE /
   * GIT_INDEX_FILE of a record, never discovered); `input` goes to stdin;
   * `raw` answers stdout as a Buffer (blob bytes); `engine` (true, or
   * `{ excludesFile, config }`) adds the engine environment: no global or
   * system config, fixed `-c` settings, the user's global excludes file read
   * once at start, and `config` overrides (repository drivers turned off).
   */
  run(cwd, args, { maxBytes = this.statusMaxBytes, timeoutMs = this.timeoutMs, killSignal = 'SIGKILL', env: extra, input, engine = false, raw = false, signal } = {}) {
    const binary = this.tools?.binary ?? (isAbsolute(this.git) ? this.git : this.resolveGit());
    if (!binary) return Promise.reject(Object.assign(new Error('git missing'), { gitUnavailable: 'git_missing' }));
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (LOCAL_ENV.includes(name) || name.startsWith('GIT_TRACE')) delete env[name];
    Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '0', GIT_LITERAL_PATHSPECS: '1', GIT_PAGER: 'cat', PAGER: 'cat', LC_ALL: 'C' }, extra ?? {}, engine ? ENGINE_ENV : {});
    const settings = engine ? engineArgs({ excludesFile: engine === true ? this.excludesFile ?? null : engine.excludesFile ?? null, config: engine === true ? [] : engine.config ?? [] }) : [];
    // No fsmonitor daemon and no repository hooks (a file checkout runs post-checkout): a click in the panel never runs the repository's own programs.
    // Never into submodules either: with `submodule.recurse` set, a file checkout would reset the work inside one.
    return new Promise((done, reject) => {
      // `signal` (optional): stops the command with `killSignal` (an engine's `git gc` a turn's start overtakes).
      const child = execFile(binary, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.autoRefreshIndex=false', '-c', 'submodule.recurse=false', ...settings, ...args], { cwd, env, timeout: timeoutMs, maxBuffer: maxBytes, encoding: 'buffer', killSignal, windowsHide: true, ...(signal ? { signal } : {}) }, (error, stdout, stderr) => {
        // Node reports a missing working folder the same way as a missing program: only the latter marks git missing.
        if (error?.code === 'ENOENT' && error.syscall?.startsWith('spawn') && !existsSync(cwd)) return reject(Object.assign(new Error('workspace missing'), { gitUnavailable: 'workspace_missing' }));
        if (error?.code === 'ENOENT' && error.syscall?.startsWith('spawn')) { this.tools = { ok: false, reason: 'git_missing', at: this.now() }; return reject(Object.assign(new Error('git missing'), { gitUnavailable: 'git_missing' })); }
        const truncated = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', timedOut = Boolean(error?.killed && !truncated);
        const bytes = Buffer.from(stdout ?? '');
        done({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout: raw ? bytes : bytes.toString('utf8'), stderr: Buffer.from(stderr ?? '').toString('utf8').slice(-2000), truncated, timedOut });
      });
      // A command that exits before reading all of its input closes the pipe: its exit code tells what happened.
      child.stdin?.on('error', () => {});
      if (input !== undefined && input !== null) child.stdin?.end(input); else child.stdin?.end();
    });
  }
  /**
   * The project's workspace and the repository around it (`repo: 'none'` when
   * there is none, with `unavailable` when it can't be told). With `worktree`,
   * the same folder inside another worktree of that repository (read only;
   * `located.worktree` is then its real path).
   */
  async locate(projectId, { worktree } = {}) {
    if (worktree === undefined || worktree === null || worktree === '') return this.locateProject(projectId);
    if (typeof worktree !== 'string' || worktree.length > 4096 || worktree.includes('\0') || !isAbsolute(worktree)) fail(this.say({ zh: '工作树要用完整的文件夹路径。', en: 'A worktree is named by its full folder path.' }), 400, 'git_worktree_invalid');
    const located = await this.locateProject(projectId);
    if (located.repo === 'none') return located;
    try { return await this.locateWorktree(located, worktree); }
    catch (error) { if (error.gitUnavailable) return { project: located.project, repo: 'none', unavailable: error.gitUnavailable }; throw error; }
  }
  /**
   * Another worktree is accepted only when git lists it for this repository
   * (both sides resolved), and the project's folder inside it answers as the
   * same repository, the same worktree and the same folder: a listed path
   * that was swapped for a link to somewhere else, or a project folder that
   * is a link out of the worktree, is refused.
   */
  async locateWorktree(located, requested) {
    const { project } = located, denied = () => fail(this.say({ zh: '这个文件夹不是本项目仓库的工作树。', en: 'That folder isn’t a worktree of this project’s repository.' }), 403, 'git_worktree_denied');
    const [wanted, top] = await Promise.all([realpath(requested).catch(() => null), realpath(located.top).catch(() => located.top)]);
    if (wanted === top) return located;
    // Still another worktree (`worktree` set), so a write naming it is refused as one, not as a missing project folder.
    const missing = { project, repo: 'none', unavailable: 'workspace_missing', worktree: wanted ?? resolve(requested) };
    const listed = await this.run(located.workspace, ['worktree', 'list', '--porcelain']);
    if (listed.timedOut) return { project, repo: 'none', unavailable: 'timed_out' };
    if (listed.code !== 0) return { project, repo: 'none', unavailable: 'git_failed' };
    const rows = parseWorktrees(listed.stdout).filter(row => !row.bare);
    const canonical = await Promise.all(rows.map(row => realpath(row.path).catch(() => null)));
    if (wanted === null || !canonical.includes(wanted)) {
      // A listed worktree whose folder is gone (prunable) reads as a missing folder, not as a stranger.
      if (rows.some((row, index) => canonical[index] === null && resolve(row.path) === resolve(requested))) return missing;
      denied();
    }
    let workspace;
    try { workspace = await realpath(join(wanted, located.prefix)); if (!(await stat(workspace)).isDirectory()) throw new Error(); }
    catch { return missing; }
    if (!within(wanted, workspace)) denied();
    const found = await this.run(workspace, ['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--show-prefix']);
    if (found.timedOut) return { project, repo: 'none', unavailable: 'timed_out' };
    if (found.code !== 0) denied();
    const [inside, foundTop, gitDir, common, prefix = ''] = found.stdout.split('\n'), commonDir = resolve(workspace, common);
    const [realTop, realCommon, ownCommon, realGitDir] = await Promise.all([foundTop, commonDir, located.commonDir, gitDir].map(path => realpath(path).catch(() => null)));
    if (inside !== 'true' || realTop !== wanted || !realCommon || realCommon !== ownCommon || prefix !== located.prefix) denied();
    return { project, workspace, top: foundTop, gitDir, commonDir, prefix, repo: realGitDir !== realCommon ? 'linked' : 'main', worktree: wanted };
  }
  async locateProject(projectId) {
    const project = this.project(projectId);
    let workspace;
    try { workspace = await realpath(registeredWorkspacePath(project.workspace)); if (!(await stat(workspace)).isDirectory()) throw new Error(); }
    catch { return { project, repo: 'none', unavailable: 'workspace_missing' }; }
    const tools = await this.availability();
    if (!tools.ok) return { project, workspace, repo: 'none', unavailable: tools.reason };
    let found;
    try { found = await this.run(workspace, ['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--show-prefix']); }
    catch (error) { return { project, workspace, repo: 'none', unavailable: error.gitUnavailable ?? 'git_failed' }; }
    if (found.timedOut) return { project, workspace, repo: 'none', unavailable: 'timed_out' };
    if (found.code !== 0) return /not a git repository/i.test(found.stderr) ? { project, workspace, repo: 'none' } : { project, workspace, repo: 'none', unavailable: 'git_failed' };
    const [inside, top, gitDir, common, prefix = ''] = found.stdout.split('\n');
    if (inside !== 'true' || await this.homeRepository(top)) return { project, workspace, repo: 'none' };
    const commonDir = resolve(workspace, common);
    let linked = false;
    try { linked = await realpath(gitDir) !== await realpath(commonDir); } catch { /* reported as the main worktree */ }
    return { project, workspace, top, gitDir, commonDir, prefix, repo: linked ? 'linked' : 'main' };
  }
  /** Whether the repository's top level is the home folder (both resolved): a dotfiles repository, not the project's. */
  async homeRepository(top) {
    let home;
    try { home = this.home(); } catch { return false; }
    if (!home || !isAbsolute(home)) return false;
    const [real, realHome] = await Promise.all([realpath(top).catch(() => top), realpath(home).catch(() => null)]);
    return realHome !== null && real === realHome;
  }
  /**
   * How untracked files are listed: `no` when the repository's own
   * `status.showUntrackedFiles` turns them off (honoured, never overridden),
   * otherwise one by one until a listing overflowed once, then by folder.
   * The value is read as git reads it (`--type=bool-or-str`: newer git takes
   * any false boolean, an empty value included); git without that type
   * refuses the option, and the raw value is read instead. `strict` (a
   * discard plan) refuses when the setting can't be read at all, rather than
   * list files the panel may not show.
   */
  async untrackedMode(located, { strict = false } = {}) {
    const read = type => this.run(located.workspace, ['config', ...type, '--get', 'status.showUntrackedFiles']);
    const answered = result => result.code === 0 || result.code === 1;
    let setting = await read(['--type=bool-or-str']);
    if (!setting.timedOut && !answered(setting)) setting = await read([]);
    if (setting.code === 0 && UNTRACKED_OFF.test(setting.stdout.trim())) return 'no';
    if (strict && !answered(setting)) fail(this.say({ zh: 'Git 没能读取这些文件的状态。', en: 'Git couldn’t read the state of these files.' }), 409, 'git_write_failed');
    return this.collapsed.has(located.top) ? 'normal' : 'all';
  }
  async operation(gitDir) {
    for (const [marker, name] of OPERATIONS) if (await lstat(join(gitDir, marker)).then(() => true, () => false)) return name;
    return null;
  }
  /** GET /api/v2/projects/:id/git[?worktree=] — branch, upstream, operation in progress and the four groups of changed files. */
  status(projectId, { upstream = false, worktree } = {}) {
    const key = `${projectId}\0${upstream ? 1 : 0}\0${worktree ?? ''}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const request = this.readStatus(projectId, { upstream, worktree }).finally(() => { if (this.inflight.get(key) === request) this.inflight.delete(key); });
    this.inflight.set(key, request);
    return request;
  }
  empty(repo, unavailable) {
    return { repo, ...(unavailable ? { unavailable, message: this.unavailable(unavailable).message } : {}), branch: null, detached: false, upstream: null, ahead: 0, behind: 0, operation: null, files: { conflicted: [], staged: [], unstaged: [], untracked: [] } };
  }
  async readStatus(projectId, { upstream: withUpstream, worktree }) {
    const located = await this.locate(projectId, { worktree });
    if (located.repo === 'none') return this.empty('none', located.unavailable);
    try {
      const cwd = located.workspace, setting = this.untrackedMode(located);
      const statusArgs = untracked => ['status', '--porcelain=v2', '--branch', '-z', `--untracked-files=${untracked}`, '--', '.'];
      // The counts start at once; only the status waits for the repository's untracked setting.
      let [status, worktree, index, operation, mode] = await Promise.all([
        setting.then(listed => this.run(cwd, statusArgs(listed))),
        this.run(cwd, ['diff', '--numstat', '-z', '--relative', ...DIFF_FLAGS]),
        this.run(cwd, ['diff', '--cached', '--numstat', '-z', '--relative', ...DIFF_FLAGS]),
        this.operation(located.gitDir),
        setting,
      ]);
      // Too many untracked files to list one by one (past the cap, or past the time limit walking untracked folders):
      // list their folders instead, and keep doing so for this repository.
      if ((status.truncated || status.timedOut) && mode === 'all') { this.collapsed.add(located.top); status = await this.run(cwd, statusArgs('normal')); }
      if (status.timedOut) return this.empty(located.repo, 'timed_out');
      if (status.code !== 0 && !status.truncated) return this.empty(located.repo, 'git_failed');
      const parsed = parseStatus(status.truncated ? status.stdout.slice(0, status.stdout.lastIndexOf('\0') + 1) : status.stdout, located.prefix);
      const worktreeCounts = parseNumstat(worktree.stdout), indexCounts = parseNumstat(index.stdout);
      const files = { conflicted: parsed.conflicted, staged: withCounts(parsed.staged, indexCounts), unstaged: withCounts(parsed.unstaged, worktreeCounts), untracked: parsed.untracked };
      if (withUpstream) files.upstream = parsed.upstream ? await this.upstreamFiles(cwd) : [];
      const truncated = status.truncated || worktree.truncated || index.truncated;
      return { repo: located.repo, branch: parsed.branch, detached: parsed.detached, upstream: parsed.upstream, ahead: parsed.ahead, behind: parsed.behind, operation,
        initial: parsed.oid === '(initial)', untrackedMode: mode === 'no' ? 'no' : this.collapsed.has(located.top) ? 'normal' : 'all', files, ...(truncated ? { truncated: true } : {}) };
    } catch (error) { if (error.gitUnavailable) return this.empty('none', error.gitUnavailable); throw error; }
  }
  /** Where this branch and its upstream parted. */
  async upstreamBase(cwd) {
    const base = await this.run(cwd, ['merge-base', '@{upstream}', 'HEAD']);
    return base.code === 0 ? base.stdout.trim() || null : null;
  }
  /** Files changed since the branch left its upstream, uncommitted edits included (tracked files only). */
  async upstreamFiles(cwd) {
    const base = await this.upstreamBase(cwd);
    return base ? (await this.changedFiles(cwd, base)).files : [];
  }
  /**
   * Tracked files that differ between `base` (a commit, or the empty tree)
   * and the working tree: committed, staged and unstaged changes together,
   * with their counts. Past the output cap only whole records are kept
   * (`truncated`). The upstream view and the compare view both read this.
   *
   * Reads never refresh the index, so `git diff <commit>` names every file
   * whose timestamps moved since the index last looked (touched, rewritten
   * unchanged, edited and put back) as modified; `git status` checks such
   * files' content, this listing does it itself. A text file with no count
   * record has no change; a binary one is always counted `-`, so it stays
   * only when git writes it a section (`Binary files … differ` comes only
   * when the bytes differ).
   */
  async changedFiles(cwd, base) {
    const args = format => ['diff', '-z', format, '--relative', ...DIFF_FLAGS, '--end-of-options', base, '--'];
    const [names, counts] = await Promise.all([this.run(cwd, args('--name-status')), this.run(cwd, args('--numstat'))]);
    const whole = result => (result.truncated ? result.stdout.slice(0, result.stdout.lastIndexOf('\0') + 1) : result.stdout);
    const numbers = parseNumstat(whole(counts));
    let rows = parseNameStatus(whole(names));
    if (counts.code === 0 && !counts.truncated) {
      rows = rows.filter(row => row.status !== 'M' || numbers.has(row.path));
      const binary = rows.filter(row => row.status === 'M' && numbers.get(row.path).binary).map(row => row.path);
      if (binary.length && binary.length <= MAX_PATHS) {
        const shown = await this.run(cwd, ['-c', 'core.quotePath=false', 'diff', '--relative', ...DIFF_FLAGS, '--src-prefix=a/', '--dst-prefix=b/', '--end-of-options', base, '--', ...binary]);
        if (shown.code === 0 && !shown.truncated) {
          const differ = new Set(splitPatch(shown.stdout).map(part => part.path)), checked = new Set(binary);
          rows = rows.filter(row => !checked.has(row.path) || differ.has(row.path));
        }
      }
    }
    const files = withCounts(rows, numbers).map(row => ({ added: null, removed: null, ...row }));
    const timedOut = names.timedOut || counts.timedOut;
    return { files, truncated: names.truncated || counts.truncated, timedOut, failed: !timedOut && [names, counts].some(result => result.code !== 0 && !result.truncated) };
  }
  /**
   * The shape of a request's `paths`: 1–500 (or `max`) non-empty strings. A
   * malformed request is a 400 `git_paths_invalid` whatever the project's
   * state; only a well-formed path that would reach outside the folder is a 403.
   */
  pathList(input, { max = MAX_PATHS } = {}) {
    if (!Array.isArray(input) || !input.length || input.length > max) fail(this.say({ zh: `一次需要 1–${max} 个文件。`, en: `Choose 1–${max} files at a time.` }), 400, 'git_paths_invalid');
    if (input.some(raw => typeof raw !== 'string' || !raw)) fail(this.say({ zh: '每个文件路径都要是不为空的文字。', en: 'Each file path must be non-empty text.' }), 400, 'git_paths_invalid');
    return input;
  }
  /**
   * Paths from the web, relative to the workspace: no absolute path, no `.` /
   * `..` / empty segment, no `.git`, nothing that reads as an option, and
   * inside the workspace once the folders on the way are resolved (the last
   * segment is not followed: git stores a symlink, it does not read through
   * it). A trailing `/` names an untracked folder (folder listing mode).
   */
  async checkPaths(located, input, { folders = false, max } = {}) {
    this.pathList(input, { max });
    const denied = () => fail(this.say({ zh: '文件路径超出了项目文件夹。', en: 'That file path is outside the project folder.' }), 403, 'git_path_denied');
    const paths = [];
    for (const raw of input) {
      if (raw.length > 4096 || /[\0\\]/.test(raw) || isAbsolute(raw) || raw.startsWith('-')) denied();
      const folder = raw.endsWith('/'), path = folder ? raw.slice(0, -1) : raw;
      if (folder && !folders) denied();
      const segments = path.split('/');
      if (segments.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) denied();
      // The nearest existing folder on the way, resolved, must stay inside the workspace, and not lead into a `.git` folder through a link.
      let parent = resolve(located.workspace, ...segments.slice(0, -1)), rest = '';
      for (;;) {
        try { parent = join(await realpath(parent), rest); break; }
        catch { if (parent === located.workspace || !within(located.workspace, parent)) denied(); rest = join(basename(parent), rest); parent = dirname(parent); }
      }
      if (!within(located.workspace, join(parent, segments.at(-1))) || relative(located.workspace, parent).split(sep).some(part => part.toLowerCase() === '.git')) denied();
      paths.push(raw);
    }
    return [...new Set(paths)];
  }
  /** `context`: absent for git's usual three lines, `all` for the whole file (展开 N 行). */
  contextFlags(context) {
    if (context === undefined || context === null || context === '') return [];
    if (context !== 'all') fail(this.say({ zh: '上下文只能是 all（整个文件）。', en: 'Context can only be all (the whole file).' }), 400, 'git_context_invalid');
    return [FULL_CONTEXT];
  }
  /** GET …/git/diff?source=unstaged|staged|upstream&path=[&context=all][&worktree=] — one file's patch, capped at 1 MB and 20 s. */
  async diff(projectId, { source, path, oldPath, context, worktree } = {}) {
    if (!['unstaged', 'staged', 'upstream'].includes(source)) fail(this.say({ zh: '不认识的改动来源。', en: 'Unknown source of changes.' }), 400, 'git_source_invalid');
    if (typeof path !== 'string' || !path) fail(this.say({ zh: '请选择一个文件。', en: 'Choose a file.' }), 400, 'git_paths_invalid');
    const lines = this.contextFlags(context);
    const located = await this.locate(projectId, { worktree });
    if (located.repo === 'none') return { kind: 'unavailable', ...this.unavailable(located.unavailable ?? 'git_failed') };
    const [file] = await this.checkPaths(located, [path]), old = oldPath ? (await this.checkPaths(located, [oldPath]))[0] : null;
    const cwd = located.workspace, paths = old && old !== file ? [old, file] : [file], limits = { maxBytes: this.diffMaxBytes, timeoutMs: this.diffTimeoutMs };
    try {
      let result;
      if (source === 'upstream') {
        const base = await this.upstreamBase(cwd);
        if (!base) return { kind: 'unavailable', reason: 'no_upstream', message: this.say({ zh: '这个分支没有上游。', en: 'This branch has no upstream.' }) };
        result = await this.run(cwd, ['diff', '--relative', ...DIFF_FLAGS, ...lines, base, '--', ...paths], limits);
      } else result = await this.run(cwd, ['diff', '--relative', ...DIFF_FLAGS, ...lines, ...(source === 'staged' ? ['--cached'] : []), '--', ...paths], limits);
      // An untracked file has no unstaged diff against the index: show it whole.
      if (source === 'unstaged' && result.code === 0 && !result.stdout && !file.endsWith('/')) {
        const listed = await this.run(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', file]);
        if (listed.stdout.split('\0').includes(file)) {
          // A new link shows the path it points to, as git shows a tracked one. `--no-index` is never handed a link:
          // newer git follows one named on its command line, which would show a file from outside the folder.
          const target = (await lstat(join(cwd, file)).catch(() => null))?.isSymbolicLink() ? await readlink(join(cwd, file)).catch(() => null) : null;
          if (target !== null) return { kind: 'patch', patch: `diff --git a/${file} b/${file}\nnew file mode 120000\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+${target}\n\\ No newline at end of file\n` };
          result = await this.run(cwd, ['diff', '--no-index', ...DIFF_FLAGS, '--', '/dev/null', file], limits);
        }
      }
      if (result.timedOut) return { kind: 'unavailable', ...this.unavailable('timed_out') };
      if (result.truncated) return { kind: 'truncated', patch: wholeLines(result.stdout) };
      // `--no-index` exits 1 when the files differ.
      if (result.code !== 0 && !(result.code === 1 && result.stdout)) return { kind: 'unavailable', ...this.unavailable('git_failed') };
      return BINARY_PATCH.test(result.stdout) ? { kind: 'binary' } : { kind: 'patch', patch: result.stdout };
    } catch (error) { if (error.gitUnavailable) return { kind: 'unavailable', ...this.unavailable(error.gitUnavailable) }; throw error; }
  }
  /**
   * GET …/git/worktrees — every worktree of the repository: this one, the
   * main one, linked, locked and prunable ones, each with whether Rna made it
   * (`rna`) and the conversation it belongs to (`owner`).
   */
  async worktrees(projectId) {
    const located = await this.locate(projectId);
    if (located.repo === 'none') return { repo: 'none', ...(located.unavailable ? { unavailable: located.unavailable, message: this.unavailable(located.unavailable).message } : {}), worktrees: [] };
    const listed = await this.run(located.workspace, ['worktree', 'list', '--porcelain']).catch(error => { if (error.gitUnavailable) return null; throw error; });
    if (!listed || listed.code !== 0) return { repo: located.repo, worktrees: [], unavailable: 'git_failed', message: this.unavailable('git_failed').message };
    const top = await realpath(located.top).catch(() => located.top);
    const rows = parseWorktrees(listed.stdout);
    const canonical = await Promise.all(rows.map(row => realpath(row.path).catch(() => row.path)));
    return { repo: located.repo, worktrees: rows.map((row, index) => ({ ...row, main: index === 0, linked: index > 0, current: canonical[index] === top, ...this.worktreeOwner(canonical[index]) })) };
  }
  /** Who a worktree belongs to: the injected registry lookup (`owners`); without one, none is Rna's and none has an owner. */
  worktreeOwner(path) {
    if (typeof this.owners !== 'function') return { rna: false, owner: null };
    try { const found = this.owners(path); return { rna: found?.rna === true, owner: found?.owner ?? null }; } catch { return { rna: false, owner: null }; }
  }
  /**
   * Writes need the project's write permission, as every other mutating
   * project route does, and act on the project's own folder only: another
   * worktree of the repository is read only.
   */
  async writable(projectId, { worktree } = {}) {
    const located = await this.locate(projectId, { worktree });
    if (located.worktree) fail(this.say({ zh: '其他工作树只能查看，暂存和丢弃只作用于项目文件夹。', en: 'Other worktrees are read only; staging and discarding act on the project folder only.' }), 403, 'git_worktree_read_only');
    if (!toolPermitted(located.project, { permission: 'write' }, 'foreground')) fail(this.say({ zh: '这个项目现在是只读的，不能改动暂存区或文件。可以在项目权限里改成可写。', en: 'This project is read-only, so staging and discarding are off. You can allow writing in the project’s permissions.' }), 403, 'git_read_only');
    if (located.repo === 'none') fail(located.unavailable ? this.unavailable(located.unavailable).message : this.say({ zh: '项目文件夹不是 Git 仓库。', en: 'The project folder isn’t a Git repository.' }), 409, 'git_unavailable');
    return located;
  }
  /** Git's index is single-writer: one write at a time per repository. */
  serial(located, work) {
    const key = located.commonDir, previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.queues.set(key, next);
    return next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); });
  }
  async write(located, args, message) {
    const result = await this.run(located.workspace, args, { timeoutMs: this.writeTimeoutMs, killSignal: 'SIGTERM' }).catch(error => { if (error.gitUnavailable) fail(this.unavailable(error.gitUnavailable).message, 503, 'git_unavailable'); throw error; });
    if (result.code !== 0) fail(this.say(message), result.timedOut ? 504 : 409, 'git_write_failed');
  }
  /** POST …/git/stage { paths } */
  async stage(projectId, { paths } = {}, { worktree } = {}) {
    this.project(projectId); this.pathList(paths);
    const located = await this.writable(projectId, { worktree }), checked = await this.checkPaths(located, paths, { folders: true });
    await this.serial(located, async () => {
      // An untracked folder that is a repository of its own would be added as a bare gitlink with no .gitmodules entry
      // (git only warns), leaving a commit others cannot clone properly: refused, as discard keeps such folders.
      const listed = await this.run(located.workspace, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...checked], { maxBytes: FOLDER_LIST_BYTES });
      const repositories = listed.code === 0 ? listed.stdout.split('\0').filter(entry => entry.endsWith('/')) : [];
      if (repositories.length) fail(this.say({ zh: `「${repositories[0].replace(/\/$/, '')}」是单独的 Git 仓库，不能在这里暂存；需要的话请把它作为子模块添加。`, en: `“${repositories[0].replace(/\/$/, '')}” is a separate Git repository and can’t be staged here; add it as a submodule if you need it.` }), 409, 'git_stage_repository');
      await this.write(located, ['add', '--', ...checked], { zh: 'Git 没能暂存这些文件。', en: 'Git couldn’t stage these files.' });
    });
    return { staged: checked, status: await this.readStatus(projectId, { upstream: false }) };
  }
  /** POST …/git/unstage { paths } — back to unstaged; the files themselves are untouched. */
  async unstage(projectId, { paths } = {}, { worktree } = {}) {
    this.project(projectId); this.pathList(paths);
    const located = await this.writable(projectId, { worktree }), checked = await this.checkPaths(located, paths, { folders: true });
    await this.serial(located, async () => {
      // Before the first commit there is no HEAD to reset to: the paths simply leave the index (one that is not staged is
      // skipped, as `reset` skips it).
      const head = await this.run(located.workspace, ['rev-parse', '--verify', '-q', 'HEAD']);
      await this.write(located, head.code === 0 ? ['reset', '-q', '--', ...checked] : ['rm', '-q', '--cached', '-r', '-f', '--ignore-unmatch', '--', ...checked], { zh: 'Git 没能取消暂存这些文件。', en: 'Git couldn’t unstage these files.' });
    });
    return { unstaged: checked, status: await this.readStatus(projectId, { upstream: false }) };
  }
  /**
   * What discarding would do to each path right now (`files`), the separate
   * repositories that stay (`kept`), and a fingerprint of their current state.
   */
  async discardPlan(located, paths) {
    // Listed as the panel lists them: by folder once this repository's untracked files overflowed the cap, and not at
    // all when the repository's own setting hides them (nothing the panel can't show is deleted).
    const status = await this.run(located.workspace, ['status', '--porcelain=v2', '-z', `--untracked-files=${await this.untrackedMode(located, { strict: true })}`, '--', ...paths]);
    if (status.code !== 0 || status.truncated) fail(this.say({ zh: 'Git 没能读取这些文件的状态。', en: 'Git couldn’t read the state of these files.' }), 409, 'git_write_failed');
    const parsed = parseStatus(status.stdout, located.prefix);
    const inside = (row, path) => row.path === path || (path.endsWith('/') && row.path.startsWith(path));
    const files = [], kept = new Map();
    const keptOnly = () => {
      const [first, ...more] = kept.keys();
      fail(more.length
        ? this.say({ zh: `「${first}」等 ${kept.size} 个文件夹是单独的 Git 仓库，不会在这里丢弃。`, en: `“${first}” and ${more.length} more folders are separate Git repositories, so they aren’t discarded here.` })
        : this.say({ zh: `「${first}」是单独的 Git 仓库，不会在这里丢弃。`, en: `“${first}” is a separate Git repository, so it isn’t discarded here.` }), 409, 'git_discard_repository');
    };
    for (const path of paths) {
      if (parsed.conflicted.some(row => inside(row, path))) fail(this.say({ zh: `「${path}」有冲突，不能在这里丢弃。`, en: `“${path}” has conflicts and can’t be discarded here.` }), 409, 'git_discard_conflicted');
      // A folder names untracked files only: discarding it deletes what is new inside and never restores tracked files through it.
      if (parsed.untracked.some(row => inside(row, path))) files.push({ path, action: 'delete' });
      else if (!path.endsWith('/') && parsed.unstaged.some(row => row.path === path)) {
        // A submodule's changes live in its own repository: a checkout of it changes nothing there (or, recursing,
        // would reset the work inside it), so it is kept like any other repository.
        if (parsed.submodules.includes(path)) kept.set(path, { path, reason: 'repository' });
        else files.push({ path, action: 'restore' });
      }
    }
    if (!files.length) { if (kept.size) keptOnly(); fail(this.say({ zh: '这些文件没有可以丢弃的未暂存改动。', en: 'These files have no unstaged changes to discard.' }), 409, 'git_discard_nothing'); }
    // A folder listed whole hides its contents from the status line and its own timestamps miss files added deeper
    // down: its untracked files are listed by name, so one that appears between the two steps is noticed.
    const folders = files.filter(file => file.path.endsWith('/')).map(file => file.path);
    const listed = folders.length ? await this.run(located.workspace, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...folders], { maxBytes: FOLDER_LIST_BYTES }) : null;
    if (listed && listed.code !== 0 && !listed.truncated) fail(this.say({ zh: 'Git 没能读取这些文件的状态。', en: 'Git couldn’t read the state of these files.' }), 409, 'git_write_failed');
    // Another repository inside an untracked folder (a clone, a submodule not yet added) is listed as its folder, with a
    // trailing `/`. `git clean` with a single -f skips it, so it is reported as kept, never as discarded, and a folder
    // that holds nothing else drops out of the plan. (Past the listing cap git still skips one it did not name here.)
    const entries = listed ? (listed.truncated ? listed.stdout.slice(0, listed.stdout.lastIndexOf('\0') + 1) : listed.stdout).split('\0').filter(Boolean) : [];
    const planned = files.filter(file => {
      if (!file.path.endsWith('/')) return true;
      const under = entries.filter(entry => entry.startsWith(file.path)), repositories = under.filter(entry => entry.endsWith('/'));
      for (const path of repositories) kept.set(path, { path, reason: 'repository' });
      return !repositories.length || under.length > repositories.length;
    });
    if (!planned.length) keptOnly();
    // File facts only for what will be touched: work going on inside a kept repository moves its folder's timestamps,
    // which must not make the second step fail. A folder that stops being a repository changes the listings instead.
    const facts = await Promise.all(planned.map(async file => { const info = await lstat(join(located.workspace, file.path)).catch(() => null); return [file.path, file.action, info ? [info.size, info.mtimeMs, info.ctimeMs, info.ino] : null]; }));
    return { files: planned, kept: [...kept.values()], fingerprint: createHash('sha256').update(JSON.stringify([status.stdout, facts, listed?.stdout ?? null])).digest('hex') };
  }
  /**
   * POST …/git/discard — two explicit steps. Without `confirm` nothing
   * changes: the answer lists what would be restored or deleted and carries a
   * one-time token (2 min). The web sends it back only on the user's second
   * click; the files must still be exactly as they were when listed. Separate
   * repositories (untracked folders that are one, submodules) are listed as
   * `kept` and never touched; a request that names nothing else is refused at
   * the first step.
   */
  async discard(projectId, { paths, confirm } = {}, { worktree } = {}) {
    this.project(projectId); this.pathList(paths);
    const located = await this.writable(projectId, { worktree }), checked = sorted(await this.checkPaths(located, paths, { folders: true }));
    for (const [token, row] of this.pending) if (row.expiresAt <= this.now()) this.pending.delete(token);
    if (confirm === undefined || confirm === null) {
      const plan = await this.discardPlan(located, checked);
      const token = randomBytes(16).toString('hex'), expiresAt = this.now() + this.discardTtlMs;
      // Unanswered questions are few; past the cap the oldest one lapses.
      if (this.pending.size >= MAX_PENDING_DISCARDS) this.pending.delete(this.pending.keys().next().value);
      this.pending.set(token, { projectId, paths: checked, fingerprint: plan.fingerprint, expiresAt });
      return { confirm: token, expiresAt: new Date(expiresAt).toISOString(), files: plan.files, ...(plan.kept.length ? { kept: plan.kept } : {}) };
    }
    const row = typeof confirm === 'string' ? this.pending.get(confirm) : null;
    if (row) this.pending.delete(confirm);
    if (!row || row.projectId !== projectId || row.expiresAt <= this.now() || JSON.stringify(row.paths) !== JSON.stringify(checked)) fail(this.say({ zh: '这次确认已经失效，请重新点一次丢弃。', en: 'This confirmation has expired. Click discard again.' }), 409, 'git_discard_unconfirmed');
    return this.serial(located, async () => {
      const plan = await this.discardPlan(located, checked);
      if (plan.fingerprint !== row.fingerprint) fail(this.say({ zh: '确认之后这些文件又变了，没有丢弃。请重新确认。', en: 'These files changed after you confirmed, so nothing was discarded. Confirm again.' }), 409, 'git_discard_changed');
      const restore = plan.files.filter(file => file.action === 'restore').map(file => file.path), remove = plan.files.filter(file => file.action === 'delete').map(file => file.path);
      // A checkpoint before any file changes (worktree design 0.63 §0.3-1): the discard is a `user_discard` apply
      // record that can be rolled back. No checkpoint, no discard.
      const checkpoint = this.engine ? await this.engine.discardCheckpoint(projectId, plan.files) : null;
      let applyId = null;
      try {
        // Tracked files go back to their staged (or committed) content; new files are removed.
        if (restore.length) await this.write(located, ['checkout', '-q', '--', ...restore], { zh: 'Git 没能恢复这些文件。', en: 'Git couldn’t restore these files.' });
        if (remove.length) await this.write(located, ['clean', '-f', '-q', ...(remove.some(path => path.endsWith('/')) ? ['-d'] : []), '--', ...remove], { zh: 'Git 没能删除这些新文件。', en: 'Git couldn’t remove these new files.' });
      } finally {
        // The record of what changed; if even that fails, the row stays `writing` and startup recovery settles it.
        try { applyId = (await checkpoint?.settle()) ?? null; } catch (error) { console.warn(`discard checkpoint ${checkpoint.applyId}: ${error.message}`); applyId = checkpoint.applyId; }
      }
      return { discarded: plan.files, ...(applyId ? { applyId } : {}), ...(plan.kept.length ? { kept: plan.kept } : {}), status: await this.readStatus(projectId, { upstream: false }) };
    });
  }
}
