import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir as systemTmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LIMITS, SECRET_FILES, TRASH_DIR, isSecretName, isSecretPath } from './git-isolation/contract.mjs';
import { WorkspaceGitService, fail, within } from './workspace-git-service.mjs';
import { registeredWorkspacePath } from './workspace-directories.mjs';
import { toolPermitted } from './project-permissions.mjs';
import { interfaceLanguageOf, inLanguage } from './interface-language.mjs';

// Making a project folder a git repository (worktree design 0.63 §10, decision 4). Owner: T5 (bodies, and the
// `init` action on workspace-git-routes.mjs's ROUTE); the interface is the lead's contract.
//
// POST /api/v2/projects/:id/git/init — never an agent tool: the user starts it (panel empty state, project
// settings) or the assistant calls it at the user's explicit request. Needs the project's foreground write
// permission; archived projects are allowed (WorkspaceGitService.project()'s 409 is not used). The preview writes
// nothing into the project folder (the file list comes from a temporary bare repository in the OS temp folder with
// GIT_WORK_TREE=P). The confirmation runs under the repository lock, with hooks off, no signing, and no git
// subcommand that talks to another repository. Any failure moves a `.git` this run created into
// `.rna/trash.nosync/init-<time>.git` and restores `.gitignore`.
//
// What the preview lists is what git itself lists, with the user's ordinary configuration (global ignore rules
// included): the proposed lines go into the probe repository's info/exclude. That has the same effect as the block
// appended to the root `.gitignore` unless a `!` line takes part (the root `.gitignore` re-including what a proposed
// line ignores, as `!.env.example` under `.env*` does): then the proposed lines are also listed as command line
// excludes, and each path the two listings disagree on is settled by where git found its deciding rule (a deeper
// `.gitignore` keeps the first answer, anything else the second), which is how the appended block will behave. The
// confirmation still checks what `git add -A` staged against the listing and undoes everything when they differ.
//
// Which lines are proposed is a fixed lookup (marker file names, sizes, `pyvenv.cfg`, nested `.git`, the secret file
// table), never a judgment of what a file means.

/** First line of the block appended to `.gitignore` (never a rewrite of what is there). */
export const GITIGNORE_HEADER = '# Added by Rna Agent';
/** Always proposed (`.env*` as the user put it: `.env.example` included). */
export const ALWAYS_IGNORED = Object.freeze(['.DS_Store', '.env*', 'node_modules/']);
/**
 * Marker file → lines (design §10's fixed table, plus Gradle's Kotlin build file). Without a marker no build output
 * folder is ignored: a novel's `build/` or `out/` may well be content. Unity's lines are anchored at the folder
 * holding its `ProjectSettings/ProjectVersion.txt`.
 */
export const ECOSYSTEM_RULES = Object.freeze([
  { markers: ['package.json'], lines: ['dist/', 'build/', 'out/', 'coverage/', '.cache/', '.next/', '.nuxt/', '.svelte-kit/', '.vite/', '.turbo/', '.parcel-cache/', '*.log'] },
  { markers: ['pyproject.toml', 'requirements.txt'], lines: ['__pycache__/', '*.pyc', '.venv/', 'venv/', 'build/', 'dist/'] },
  { markers: ['Cargo.toml'], lines: ['target/'] },
  { markers: ['build.gradle', 'build.gradle.kts', 'pom.xml'], lines: ['build/', 'target/', '.gradle/'] },
  { markers: ['project.godot'], lines: ['.godot/', '.import/'] },
  { markers: ['ProjectSettings/ProjectVersion.txt'], anchored: true, lines: ['[Ll]ibrary/', '[Tt]emp/', '[Oo]bj/', '[Bb]uild*/', '[Ll]ogs/', '[Uu]ser[Ss]ettings/'] },
].map(rule => Object.freeze({ ...rule, markers: Object.freeze(rule.markers), lines: Object.freeze(rule.lines) })));
const VENV_FOLDERS = ['.venv', 'venv'];
/** Rna's own folder in a project (worktrees, trash): git never sees it (info/exclude, design §10 step 3). */
const RNA_EXCLUDE = '/.rna/';
const LIST_BYTES = 64 * 1024 * 1024, LIST_MS = 120000, COUNT_BYTES = 8 * 1024 * 1024, COUNT_MS = 30000, COUNT_ENTRIES = 200000, COUNT_WALK_MS = 5000;
const ADD_MS = 600000, ADD_BYTES = 64 * 1024 * 1024, STATUS_BYTES = 4 * 1024 * 1024, MAX_LINES = 2000, LINE_CHARS = 4096, MAX_PENDING = 32;
const RECONCILE_MAX = 20000, COMMAND_LINE_BYTES = 256 * 1024, STAT_CONCURRENCY = 64, LISTED = 50;
const INIT_KEYS = ['confirm', 'lines', 'identity', 'acknowledgeLarge'];
// check-ignore refuses literal pathspecs (the default of every git call here); its paths go in as `./<path>`, so a name
// starting with `:` can never read as pathspec magic, and come back the same way.
const CHECK_IGNORE_ENV = Object.freeze({ GIT_LITERAL_PATHSPECS: '0' });
const asPathspec = path => `./${path}`, fromPathspec = path => (path.startsWith('./') ? path.slice(2) : path);

const sha256 = value => createHash('sha256').update(value).digest('hex');
const records = text => text.split('\0').filter(Boolean);
const textsOf = rows => rows.map(row => row.text);
const depth = path => path.split('/').length;
const byDepth = (a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0);
const mergeLines = (...groups) => { const seen = new Set(); return groups.flat().filter(row => !seen.has(row.text) && seen.add(row.text)); };
const sameTexts = (a, b) => a.length === b.length && a.every((text, index) => text === b[index]);

/**
 * A path as an exact `.gitignore` line: anchored with a leading `/`, every character the pattern syntax reads
 * specially (`\ * ? [`, and `# !`) escaped, and spaces at either end escaped so they are not trimmed. A line break
 * (which a line can't hold) becomes `?`.
 */
export function exactPattern(path, { folder = false } = {}) {
  let text = String(path).replace(/[\\*?[#!]/g, char => `\\${char}`).replace(/[\r\n]/g, '?');
  text = text.replace(/^ +| +$/g, spaces => '\\ '.repeat(spaces.length));
  return `/${text}${folder ? '/' : ''}`;
}

/** Ecosystem lines for the marker files in a listing (the shallowest marker is named). */
export function ecosystemLines(paths) {
  const files = paths.filter(path => !path.endsWith('/'));
  return mergeLines(ECOSYSTEM_RULES.flatMap(rule => {
    const found = files.filter(path => rule.markers.some(marker => path === marker || path.endsWith(`/${marker}`))).sort(byDepth);
    if (!found.length) return [];
    if (!rule.anchored) return rule.lines.map(text => ({ text, rule: 'ecosystem', marker: found[0] }));
    return found.flatMap(path => {
      const marker = rule.markers.find(name => path === name || path.endsWith(`/${name}`)), prefix = path.slice(0, path.length - marker.length);
      const anchor = prefix ? exactPattern(prefix.slice(0, -1), { folder: true }) : '/';
      return rule.lines.map(text => ({ text: `${anchor}${text}`, rule: 'ecosystem', marker: path }));
    });
  }));
}

/** Whether one name matches one SECRET_FILES rule (`*.x`, `x*` or an exact name; never a `!` rule), ignoring case. */
const secretRuleMatches = (rule, name) => {
  const lower = name.toLowerCase();
  if (rule.startsWith('*.')) return lower.endsWith(rule.slice(1));
  if (rule.endsWith('*')) return lower.startsWith(rule.slice(0, -1)) && lower.length > rule.length - 1;
  return lower === rule;
};

/**
 * Lines for the files that hold secrets in a listing (B8, SECRET_FILES: mu checkpoints.md §2): the table's own rules
 * that match a name of a listed file, in table order. Such a file is never in a snapshot, so it stays out of the first
 * commit too: no `refs/rna` commit, all of which descend from it, then reaches its content. The `!` exceptions
 * (`.env.example` …) are no secret files, so they are never proposed; `.env*` stays as it is.
 */
export function secretLines(paths) {
  const rules = SECRET_FILES.filter(rule => !rule.startsWith('!')), found = new Map();
  for (const path of paths) {
    if (path.endsWith('/') || !isSecretPath(path)) continue;
    for (const name of path.split('/').filter(isSecretName)) for (const rule of rules) if (!found.has(rule) && secretRuleMatches(rule, name)) found.set(rule, path);
  }
  return rules.filter(rule => found.has(rule)).map(text => ({ text, rule: 'secret', path: found.get(text) }));
}

/** `.venv` / `venv` folders that hold a `pyvenv.cfg` (a Python virtual environment), whatever marker files exist. */
export function venvLines(paths) {
  const folders = paths.filter(path => path.endsWith('/pyvenv.cfg')).map(path => path.slice(0, -'/pyvenv.cfg'.length)).filter(folder => VENV_FOLDERS.includes(folder.split('/').at(-1)));
  return [...new Set(folders)].sort().map(folder => ({ text: exactPattern(folder, { folder: true }), rule: 'venv', path: `${folder}/` }));
}

/**
 * The project's folder made a git repository, in two steps (design §10). See the module comment.
 *
 * @typedef {object} GitInitLine  one proposed `.gitignore` line
 * @property {string} text
 * @property {'always'|'ecosystem'|'secret'|'venv'|'large'|'nested'|'user'} rule  GITIGNORE_RULES
 * @property {string} [marker]   ecosystem: the marker file that added it (package.json, Cargo.toml, …)
 * @property {number} [count]    files this line ignores (left out when counting them would take too long)
 * @property {number} [bytes]
 *
 * @typedef {object} GitInitPreview  the first step (no `confirm`)
 * @property {string} confirm    one-time token bound to the fingerprint, LIMITS.gitInitTokenMs (30 min)
 * @property {string} expiresAt
 * @property {string} folder     P
 * @property {string} branch     global init.defaultBranch, else main
 * @property {{ name: string, email: string }|null} identity  global user.name / user.email; null → identityRequired
 * @property {boolean} identityRequired
 * @property {{ exists: boolean, lines: GitInitLine[] }} gitignore  only an appended "# Added by Rna Agent" block, never a rewrite
 * @property {{ count: number, bytes: number, largest: { path: string, bytes: number }[] }} files  what the first commit holds (largest: LIMITS.initLargestListed)
 * @property {{ path: string, bytes: number }[]} largeFiles  ≥ LIMITS.initLargeFileBytes, ignored by exact path
 * @property {string[]} nested    repositories of their own, ignored as `/path/`
 * @property {boolean} needsAcknowledge  over LIMITS.initConfirmFiles files or LIMITS.initConfirmBytes bytes
 * @property {boolean} icloud    the folder is probably synced by iCloud Drive (a fact check, not a guess)
 * @property {{ top: string, kind: 'dotfiles'|'ignored' }} [outer]  an outer repository that does not count
 *
 * @typedef {object} GitInitResult  the second step
 * @property {string} commit
 * @property {string} branch
 * @property {number} files
 * @property {{ path: string, bytes: number }[]} largeFiles
 * @property {'clean'|'changed'} status   `changed`: files changed while it ran (listed)
 * @property {string[]} [changed]
 */
export class GitInitService {
  /**
   * @param {import('./store.mjs').Store} store
   * @param {{ git?: import('./workspace-git-service.mjs').WorkspaceGitService, home?: () => string, tmpdir?: () => string, now?: () => number, appRoot?: string, limits?: typeof LIMITS }} [options]
   *   `git`: share the routes' instance, so the confirmation takes the same repository lock (`serial`) as the
   *   panel's writes and the merge engine. `appRoot`: the app's own folder (default: the enclosing `.app`, else this
   *   host's folder). `limits`: LIMITS by default (tests lower the file counts).
   */
  constructor(store, { git = null, home, tmpdir, now = Date.now, appRoot, limits = LIMITS } = {}) {
    Object.assign(this, { store, git, home, tmpdir, now, appRoot, limits });
    /** Unanswered previews: token → { projectId, fingerprint, expiresAt, identityRequired, needsAcknowledge }. */
    this.pending = new Map();
  }
  get service() { return this.git ??= new WorkspaceGitService(this.store, this.home ? { home: this.home } : {}); }
  say(variants) { return inLanguage(interfaceLanguageOf(this.store.state), variants); }
  homeFolder() { try { return (this.home ?? homedir)(); } catch { return null; } }

  /**
   * The route's entry: no `confirm` → preview(); with it → confirm().
   * @param {string} projectId
   * @param {{ confirm?: string, lines?: string[], identity?: { name: string, email: string }, acknowledgeLarge?: boolean }} input
   * @returns {Promise<GitInitPreview|GitInitResult>}
   */
  async init(projectId, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !INIT_KEYS.includes(key))) fail(this.say({ zh: '请求只能包含 confirm、lines、identity 和 acknowledgeLarge。', en: 'The request may only contain confirm, lines, identity and acknowledgeLarge.' }), 400, 'git_request_invalid');
    return input.confirm === undefined || input.confirm === null ? this.preview(projectId, { lines: input.lines }) : this.confirm(projectId, input);
  }

  /**
   * Refused: the folder is missing (`workspace_missing`), is `/`, home or above it, or inside Rna's state folder or
   * app bundle (`git_init_folder_denied`); already has `.git` (`git_init_already`); lies inside another repository
   * that is not a home dotfiles repository and does not ignore it (`git_init_inside_repo`, with `repository`);
   * over LIMITS.initMaxFiles files (`git_init_too_many_files`). `lines`: the user's edited `.gitignore` lines
   * (`git_init_lines_invalid` when malformed).
   * @param {string} projectId
   * @param {{ lines?: string[] }} [input]
   * @returns {Promise<GitInitPreview>}
   */
  async preview(projectId, { lines } = {}) {
    const project = this.writableProject(projectId), edited = this.linesOf(lines);
    const plan = await this.plan(project, { lines: edited });
    this.sweep();
    const token = randomBytes(16).toString('hex'), expiresAt = this.now() + this.limits.gitInitTokenMs;
    if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value);
    this.pending.set(token, { projectId, fingerprint: plan.fingerprint, expiresAt, identityRequired: plan.identityRequired, needsAcknowledge: plan.needsAcknowledge });
    return {
      confirm: token, expiresAt: new Date(expiresAt).toISOString(), folder: plan.folder, branch: plan.branch, identity: plan.identity, identityRequired: plan.identityRequired,
      gitignore: { exists: plan.gitignore.exists, lines: plan.lines }, files: { count: plan.count, bytes: plan.bytes, largest: plan.largest },
      largeFiles: plan.largeFiles, nested: plan.nested, needsAcknowledge: plan.needsAcknowledge, icloud: plan.icloud, ...(plan.outer ? { outer: plan.outer } : {}),
    };
  }

  /**
   * Redo the listing; a different fingerprint → `git_init_changed`; then `git init -q -b <branch>`, the
   * `.gitignore` block, `/.rna/` in `.git/info/exclude`, `git add -A` whose `diff --cached --name-only -z` must equal
   * the listing, `commit --no-verify` (message by interface language: 初始提交（由 Rna Agent 创建） / Initial commit
   * (created by Rna Agent)), `status --porcelain` checked; records `project.git.init = { at, by: 'rna', commit,
   * branch, largeFiles }`. Errors: git_init_unconfirmed, git_init_changed, git_init_large_unacknowledged,
   * git_init_identity_required, git_init_identity_invalid, git_init_failed (everything undone, differences listed).
   * A token survives the two answers the user can fix in place (identity, acknowledgeLarge); any other answer uses it up.
   * @param {string} projectId
   * @param {{ confirm: string, lines?: string[], identity?: { name: string, email: string }, acknowledgeLarge?: boolean }} input
   * @returns {Promise<GitInitResult>}
   */
  async confirm(projectId, { confirm, lines, identity, acknowledgeLarge } = {}) {
    const project = this.writableProject(projectId), edited = this.linesOf(lines), chosen = this.identityOf(identity);
    if (acknowledgeLarge !== undefined && typeof acknowledgeLarge !== 'boolean') fail(this.say({ zh: 'acknowledgeLarge 只能是 true 或 false。', en: 'acknowledgeLarge can only be true or false.' }), 400, 'git_request_invalid');
    this.sweep();
    const row = typeof confirm === 'string' ? this.pending.get(confirm) : null;
    if (!row || row.projectId !== projectId) fail(this.say({ zh: '这次确认已经失效，请重新预览一次。', en: 'This confirmation has expired. Preview again.' }), 409, 'git_init_unconfirmed');
    if (row.identityRequired && !chosen) fail(this.identityMissing(), 400, 'git_init_identity_required');
    if (row.needsAcknowledge && acknowledgeLarge !== true) fail(this.say({ zh: '第一次提交的文件很多，需要你确认后才能继续。', en: 'The first commit holds a lot of files; confirm that you want them all before continuing.' }), 409, 'git_init_large_unacknowledged');
    this.pending.delete(confirm);
    const folder = await this.folderOf(project);
    return this.service.serial({ commonDir: join(folder, '.git') }, async () => {
      const plan = await this.plan(project, { lines: edited });
      if (plan.fingerprint !== row.fingerprint) fail(this.say({ zh: '预览之后文件夹里的文件变了，没有初始化。请重新预览。', en: 'Files in the folder changed after the preview, so nothing was done. Preview again.' }), 409, 'git_init_changed');
      const author = chosen ?? plan.identity;
      if (!author) fail(this.identityMissing(), 400, 'git_init_identity_required');
      return this.execute(project, plan, { author, local: Boolean(chosen) });
    });
  }

  // ------------------------------------------------------------------ checks

  writableProject(projectId) {
    const project = this.store.state.projects.find(row => row.id === projectId);
    if (!project) fail(this.say({ zh: '项目不存在。', en: 'This project no longer exists.' }), 404, 'project_not_found');
    if (!toolPermitted(project, { permission: 'write' }, 'foreground')) fail(this.say({ zh: '这个项目现在是只读的，不能把它的文件夹变成 Git 仓库。可以在项目权限里改成可写。', en: 'This project is read-only, so its folder can’t be made a Git repository. You can allow writing in the project’s permissions.' }), 403, 'git_read_only');
    return project;
  }
  identityMissing() {
    return this.say({ zh: '这台电脑还没有设置 Git 身份（user.name 和 user.email）。请填写第一次提交使用的名字和邮箱，它们只保存在这个仓库里。', en: 'This computer has no Git identity (user.name and user.email) yet. Enter the name and email for the first commit; they are saved in this repository only.' });
  }
  /** The user's edited lines: null (use the proposal), or 0–2000 distinct one-line texts in their order. */
  linesOf(lines) {
    if (lines === undefined || lines === null) return null;
    const invalid = () => fail(this.say({ zh: '.gitignore 的每一行都要是不为空、不含换行的文字。', en: 'Each .gitignore line must be non-empty text without line breaks.' }), 400, 'git_init_lines_invalid');
    if (!Array.isArray(lines) || lines.length > MAX_LINES) invalid();
    for (const line of lines) if (typeof line !== 'string' || !line.trim() || line.length > LINE_CHARS || /[\0\r\n]/.test(line)) invalid();
    return [...new Set(lines)];
  }
  /** A commit identity from the request: null when absent, `git_init_identity_invalid` when malformed. */
  identityOf(identity) {
    if (identity === undefined || identity === null) return null;
    const invalid = () => fail(this.say({ zh: '名字或邮箱的格式不对：名字不能含 < > 或换行，邮箱要像 name@example.com。', en: 'The name or email isn’t valid: a name can’t hold < > or line breaks, and an email looks like name@example.com.' }), 400, 'git_init_identity_invalid');
    if (typeof identity !== 'object' || Array.isArray(identity) || Object.keys(identity).some(key => !['name', 'email'].includes(key)) || typeof identity.name !== 'string' || typeof identity.email !== 'string') invalid();
    const name = identity.name.trim(), email = identity.email.trim();
    if (!name || name.length > 200 || /[<>\0\r\n]/.test(name) || !/[\p{L}\p{N}]/u.test(name)) invalid();
    if (email.length > 254 || !/^[^\s<>@]+@[^\s<>@]+$/u.test(email)) invalid();
    return { name, email };
  }
  /** P, resolved, after every refusal that needs no git (design §10 preview step 1). */
  async folderOf(project) {
    let folder;
    try { folder = await realpath(registeredWorkspacePath(project.workspace)); if (!(await stat(folder)).isDirectory()) throw new Error(); }
    catch { fail(this.say({ zh: '项目文件夹找不到了。', en: 'The project folder can’t be found.' }), 409, 'workspace_missing'); }
    const denied = variants => fail(this.say(variants), 403, 'git_init_folder_denied');
    const home = this.homeFolder(), realHome = home && isAbsolute(home) ? await realpath(home).catch(() => resolve(home)) : null;
    if (folder === sep || dirname(folder) === folder || (realHome && within(folder, realHome))) denied({ zh: '根目录、个人文件夹和它的上级文件夹不能变成 Git 仓库。', en: 'The root folder, your home folder and the folders above it can’t be made a Git repository.' });
    // Rna's state (credentials included) never ends up in a commit, and its own files are not a project.
    const state = this.store.file ? await realpath(dirname(this.store.file)).catch(() => resolve(dirname(this.store.file))) : null;
    const app = await realpath(this.appRoot ?? defaultAppRoot()).catch(() => null);
    if ((state && (within(state, folder) || within(folder, state))) || (app && within(app, folder))) denied({ zh: '这个文件夹在 Rna 自己的数据或应用文件夹里（或包含它们），不能变成 Git 仓库。', en: 'This folder is inside (or holds) Rna’s own data or app folder, so it can’t be made a Git repository.' });
    if (await lstat(join(folder, '.git')).then(() => true, () => false)) fail(this.say({ zh: '这个文件夹已经是 Git 仓库了。', en: 'This folder is already a Git repository.' }), 409, 'git_init_already');
    return folder;
  }
  /** One git command, git missing answered as 503 `git_unavailable`. */
  async exec(cwd, args, options) {
    try { return await this.service.run(cwd, args, options); }
    catch (error) {
      if (error.gitUnavailable === 'workspace_missing') fail(this.say({ zh: '项目文件夹找不到了。', en: 'The project folder can’t be found.' }), 409, 'workspace_missing');
      if (error.gitUnavailable) fail(this.service.unavailable(error.gitUnavailable).message, 503, 'git_unavailable');
      throw error;
    }
  }
  gitFailed(result, variants) {
    throw Object.assign(new Error(this.say(variants)), { status: 500, code: 'git_init_failed', details: { ...(result?.stderr ? { git: result.stderr.trim().slice(-600) } : {}), ...(result?.timedOut ? { timedOut: true } : {}) } });
  }
  /**
   * The repository around P, if any (design §10 preview step 1): none; a home dotfiles repository or one that ignores
   * P (allowed, named in the preview); anything else refused with `git_init_inside_repo`.
   */
  async outerRepository(folder) {
    const found = await this.exec(folder, ['rev-parse', '--show-toplevel']);
    if (found.code !== 0) {
      if (/not a git repository/i.test(found.stderr)) return null;
      this.gitFailed(found, { zh: 'Git 没能判断这个文件夹是否在另一个仓库里。', en: 'Git couldn’t tell whether this folder is inside another repository.' });
    }
    const top = found.stdout.trim(), realTop = await realpath(top).catch(() => top), home = this.homeFolder();
    if (home && isAbsolute(home) && realTop === await realpath(home).catch(() => null)) return { top: realTop, kind: 'dotfiles' };
    if (!within(realTop, folder) || realTop === folder) return null;
    const path = relative(realTop, folder).split(sep).join('/');
    // Files of P the outer repository already tracks keep P inside it, whatever its ignore rules say.
    const [ignored, tracked] = await Promise.all([this.exec(realTop, ['check-ignore', '-q', '--', asPathspec(path)], { env: CHECK_IGNORE_ENV }), this.exec(realTop, ['ls-files', '-z', '--cached', '--', path], { maxBytes: 64 * 1024 })]);
    if (ignored.code === 0 && tracked.code === 0 && !tracked.stdout && !tracked.truncated) return { top: realTop, kind: 'ignored' };
    if (ignored.code === 0 || ignored.code === 1) {
      throw Object.assign(new Error(this.say({ zh: `这个文件夹在另一个 Git 仓库（${realTop}）里面。要让它有自己的仓库，请先在那个仓库里忽略它。`, en: `This folder is inside another Git repository (${realTop}). To give it a repository of its own, ignore it in that repository first.` })), { status: 409, code: 'git_init_inside_repo', details: { repository: realTop } });
    }
    this.gitFailed(ignored, { zh: 'Git 没能判断这个文件夹是否在另一个仓库里。', en: 'Git couldn’t tell whether this folder is inside another repository.' });
  }
  /**
   * The `.gitignore` at the top of P. Git doesn't read one that is a link (since 2.32), so a block appended through
   * one would not count: refused, as is one that is not a file.
   */
  async existingGitignore(folder) {
    const path = join(folder, '.gitignore'), info = await lstat(path).catch(() => null);
    if (!info) return { exists: false, path, content: null, mode: 0o644 };
    if (!info.isFile()) fail(this.say({ zh: '这个文件夹里的 .gitignore 不是普通文件（是链接或文件夹），Git 不会读取它。请先把它换成普通文件。', en: 'The .gitignore in this folder isn’t a plain file (it is a link or a folder), so Git won’t read it. Replace it with a plain file first.' }), 403, 'git_init_folder_denied');
    return { exists: true, path, content: await readFile(path), mode: info.mode & 0o777 };
  }
  /** Global user.name / user.email, read with the ordinary environment; null when either is missing. */
  async globalIdentity(folder) {
    const [name, email] = await Promise.all(['user.name', 'user.email'].map(key => this.globalValue(folder, key)));
    return name && email ? { name, email } : null;
  }
  async globalValue(folder, key) {
    const result = await this.exec(folder, ['config', '--global', '--includes', '--get', key]);
    const value = result.code === 0 ? result.stdout.replace(/\r?\n$/, '').trim() : '';
    return value || null;
  }
  /** Global init.defaultBranch when it is a valid branch name, else main. */
  async defaultBranch(folder) {
    const configured = await this.globalValue(folder, 'init.defaultBranch');
    if (!configured || configured.startsWith('-') || configured.includes('@{')) return 'main';
    const checked = await this.exec(folder, ['check-ref-format', '--branch', configured]);
    return checked.code === 0 && checked.stdout.trim() === configured ? configured : 'main';
  }
  /** Under iCloud Drive, or under Desktop / Documents while "Desktop & Documents" syncing exists (design §10 step 6). */
  async icloud(folder) {
    const home = this.homeFolder();
    if (!home || !isAbsolute(home)) return false;
    const realHome = await realpath(home).catch(() => resolve(home)), under = part => within(join(realHome, part), folder);
    if (under('Library/Mobile Documents') || under('Library/CloudStorage')) return true;
    return (under('Documents') || under('Desktop')) && existsSync(join(realHome, 'Library/Mobile Documents/com~apple~CloudDocs/Documents'));
  }

  // ------------------------------------------------------------------ the listing

  /**
   * Everything both steps compute: the proposal (or the user's lines), what the first commit would hold, and the
   * fingerprint the token binds. Nothing is written into P.
   */
  async plan(project, { lines = null } = {}) {
    const folder = await this.folderOf(project), tools = await this.service.availability();
    if (!tools.ok) fail(this.service.unavailable(tools.reason).message, 503, 'git_unavailable');
    const outer = await this.outerRepository(folder), gitignore = await this.existingGitignore(folder);
    const [identity, branch, icloud] = await Promise.all([this.globalIdentity(folder), this.defaultBranch(folder), this.icloud(folder)]);
    const probe = await this.probe(folder, gitignore);
    try {
      let proposal = ALWAYS_IGNORED.map(text => ({ text, rule: 'always' })), listed = await probe.list(textsOf(proposal));
      const ecosystem = ecosystemLines(listed);
      if (ecosystem.length) { proposal = mergeLines(proposal, ecosystem); listed = await probe.list(textsOf(proposal)); }
      // Files that hold secrets (B8): the table's rules for the ones listed, then an exact line for any a rule's case
      // missed on a volume that tells case apart.
      const secret = secretLines(listed);
      if (secret.length) { proposal = mergeLines(proposal, secret); listed = await probe.list(textsOf(proposal)); }
      const unmatched = listed.filter(path => !path.endsWith('/') && isSecretPath(path)).sort().map(path => ({ text: exactPattern(path), rule: 'secret', path }));
      if (unmatched.length) { proposal = mergeLines(proposal, unmatched); listed = await probe.list(textsOf(proposal)); }
      const facts = await this.facts(folder, listed);
      const large = listed.filter(path => facts.get(path)?.file && facts.get(path).size >= this.limits.initLargeFileBytes).sort()
        .map(path => ({ text: exactPattern(path), rule: 'large', path, size: facts.get(path).size }));
      const nested = listed.filter(path => path.endsWith('/')).sort().map(path => ({ text: exactPattern(path.slice(0, -1), { folder: true }), rule: 'nested', path }));
      const extra = [...venvLines(listed), ...large, ...nested];
      if (extra.length) { proposal = mergeLines(proposal, extra); listed = await probe.list(textsOf(proposal)); }
      let chosen = proposal;
      if (lines) {
        const proposed = new Map(proposal.map(row => [row.text, row]));
        chosen = lines.map(text => proposed.get(text) ?? { text, rule: 'user' });
        if (!sameTexts(lines, textsOf(proposal))) listed = await probe.list(lines);
      }
      // A repository of its own would be committed as a bare gitlink nobody can clone (stage refuses it too).
      const repository = listed.find(path => path.endsWith('/'));
      if (repository) fail(this.say({ zh: `「${repository.slice(0, -1)}」是单独的 Git 仓库，需要在 .gitignore 里保留忽略它的那一行。`, en: `“${repository.slice(0, -1)}” is a Git repository of its own; keep the .gitignore line that ignores it.` }), 400, 'git_init_lines_invalid');
      await this.facts(folder, listed, facts);
      const counts = await probe.counts(textsOf(chosen));
      return this.summary({ folder, outer, icloud, identity, branch, gitignore, chosen, counts, listed, facts });
    } finally { await probe.close(); }
  }
  summary({ folder, outer, icloud, identity, branch, gitignore, chosen, counts, listed, facts }) {
    const block = chosen.length ? `${GITIGNORE_HEADER}\n${chosen.map(row => `${row.text}\n`).join('')}` : '';
    const original = gitignore.content ?? Buffer.alloc(0), separator = !gitignore.exists || !original.length ? '' : original.at(-1) === 0x0a ? '\n' : '\n\n';
    const content = block ? Buffer.concat([original, Buffer.from(`${separator}${block}`)]) : null;
    const expected = new Set(listed);
    if (content && !gitignore.exists) expected.add('.gitignore');
    const sizes = listed.map(path => ({ path, bytes: facts.get(path)?.size ?? 0 }));
    const count = expected.size, bytes = sizes.reduce((sum, row) => sum + row.bytes, 0) + (content ? content.length - original.length : 0);
    if (count > this.limits.initMaxFiles) fail(this.say({ zh: `第一次提交会有 ${count} 个文件，超过了 ${this.limits.initMaxFiles} 个的上限。请先在 .gitignore 里忽略不需要的文件夹。`, en: `The first commit would hold ${count} files, over the limit of ${this.limits.initMaxFiles}. Ignore the folders you don’t need in .gitignore first.` }), 409, 'git_init_too_many_files');
    const lines = chosen.map((row, index) => ({ text: row.text, rule: row.rule, ...(row.marker ? { marker: row.marker } : {}), ...(counts?.[index] ? counts[index] : {}) }));
    const fingerprint = sha256(JSON.stringify([folder, branch, identity, gitignore.exists ? sha256(original) : null, block, listed.map(path => { const fact = facts.get(path); return [path, fact?.size ?? null, fact?.mtimeMs ?? null]; })]));
    return {
      folder, outer, icloud, identity, identityRequired: !identity, branch, gitignore, block, content, expected, lines, count, bytes, fingerprint,
      largest: sizes.filter(row => !row.path.endsWith('/')).sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : 1)).slice(0, this.limits.initLargestListed),
      largeFiles: chosen.filter(row => row.rule === 'large').map(row => ({ path: row.path, bytes: row.size })),
      nested: chosen.filter(row => row.rule === 'nested').map(row => row.path),
      needsAcknowledge: count > this.limits.initConfirmFiles || bytes > this.limits.initConfirmBytes,
    };
  }
  /** lstat facts (size, mtime, regular file?) for listed paths not yet known; a path that vanished maps to null. */
  async facts(folder, paths, known = new Map()) {
    const missing = paths.filter(path => !known.has(path));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, missing.length) }, async () => {
      while (next < missing.length) {
        const path = missing[next++], info = await lstat(join(folder, path)).catch(() => null);
        known.set(path, info ? { size: info.isDirectory() ? 0 : info.size, mtimeMs: info.mtimeMs, file: info.isFile() } : null);
      }
    }));
    return known;
  }
  /** A temporary bare repository in the OS temp folder whose work tree is P: git lists P without touching it. */
  async probe(folder, gitignore) {
    const dir = await realpath(await mkdtemp(join((this.tmpdir ?? systemTmpdir)(), 'rna-git-init-')));
    try {
      const gitDir = join(dir, 'probe.git'), made = await this.exec(dir, ['init', '--bare', '-q', gitDir]);
      if (made.code !== 0) this.gitFailed(made, { zh: 'Git 没能在临时文件夹里列出文件。', en: 'Git couldn’t list the files from a temporary folder.' });
      // The user's template may bring info/exclude lines; the real `git init` will copy the same ones.
      const excludePath = join(gitDir, 'info', 'exclude');
      await mkdir(dirname(excludePath), { recursive: true });
      let template = await readFile(excludePath, 'utf8').catch(() => '');
      if (template && !template.endsWith('\n')) template += '\n';
      return new Probe(this, { dir, gitDir, excludePath, template, folder, gitignore });
    } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  }

  // ------------------------------------------------------------------ the confirmation

  /** design §10 confirmation steps 2–7; any failure before the commit exists is undone (`undo`). */
  async execute(project, plan, { author, local }) {
    const { folder } = plan, startedAt = Date.now(), env = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
    const write = (args, options = {}) => this.exec(folder, args, { timeoutMs: this.service.writeTimeoutMs, killSignal: 'SIGTERM', ...options });
    let stage = 'init', written = null;
    try {
      const made = await write(['init', '-q', '-b', plan.branch]);
      if (made.code !== 0) this.gitFailed(made, { zh: 'Git 没能创建仓库', en: 'Git couldn’t create the repository' });
      if (!(await lstat(join(folder, '.git')).catch(() => null))?.isDirectory()) this.gitFailed(null, { zh: 'Git 没有创建 .git 文件夹', en: 'Git didn’t create a .git folder' });
      stage = 'gitignore';
      if (plan.content) {
        // Compare-and-swap: a .gitignore that appeared, or changed, since the listing is never overwritten.
        const current = await readFile(plan.gitignore.path).catch(error => (error.code === 'ENOENT' ? null : Promise.reject(error)));
        if (plan.gitignore.exists ? !current?.equals(plan.gitignore.content) : current !== null) this.gitFailed(null, { zh: '.gitignore 在这期间被改动了', en: '.gitignore changed meanwhile' });
        await (plan.gitignore.exists ? replaceFile(plan.gitignore.path, plan.content, plan.gitignore.mode) : createFile(plan.gitignore.path, plan.content, plan.gitignore.mode));
        written = plan.content;
      }
      stage = 'exclude';
      await appendExclude(join(folder, '.git', 'info', 'exclude'));
      if (local) {
        stage = 'identity';
        for (const [key, value] of [['user.name', author.name], ['user.email', author.email]]) {
          const saved = await write(['config', '--local', key, value]);
          if (saved.code !== 0) this.gitFailed(saved, { zh: 'Git 没能保存提交身份', en: 'Git couldn’t save the commit identity' });
        }
      }
      stage = 'add';
      const added = await write(['add', '-A'], { timeoutMs: ADD_MS, maxBytes: ADD_BYTES });
      if (added.code !== 0) this.gitFailed(added, { zh: 'Git 没能把文件加入第一次提交', en: 'Git couldn’t add the files to the first commit' });
      stage = 'compare';
      const staged = await this.exec(folder, ['diff', '--cached', '--name-only', '--no-renames', '-z'], { maxBytes: LIST_BYTES, timeoutMs: LIST_MS });
      if (staged.code !== 0 || staged.truncated) this.gitFailed(staged, { zh: 'Git 没能列出加入的文件', en: 'Git couldn’t list the added files' });
      const actual = new Set(records(staged.stdout)), unexpected = [...actual].filter(path => !plan.expected.has(path)).sort(), missing = [...plan.expected].filter(path => !actual.has(path)).sort();
      if (unexpected.length || missing.length) {
        throw Object.assign(new Error(this.say({ zh: `加入的文件和预览不一致（多了 ${unexpected.length} 个，少了 ${missing.length} 个）`, en: `The added files differ from the preview (${unexpected.length} more, ${missing.length} missing)` })), { status: 500, code: 'git_init_failed', details: { differences: { unexpected: unexpected.slice(0, LISTED), missing: missing.slice(0, LISTED), ...(unexpected.length > LISTED || missing.length > LISTED ? { truncated: true } : {}) } } });
      }
      stage = 'commit';
      const message = this.say({ zh: '初始提交（由 Rna Agent 创建）', en: 'Initial commit (created by Rna Agent)' });
      const committed = await write(['-c', 'commit.gpgsign=false', '-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-q', '--no-verify', '--allow-empty', '-m', message], { timeoutMs: ADD_MS, maxBytes: ADD_BYTES, env });
      if (committed.code !== 0) this.gitFailed(committed, { zh: 'Git 没能完成第一次提交', en: 'Git couldn’t make the first commit' });
    } catch (error) {
      const undone = await this.undo(folder, { startedAt, gitignore: plan.gitignore, written });
      const reason = error.status ? error.message.replace(/[。.]$/, '') : this.say({ zh: '出了意外', en: 'Something unexpected happened' });
      throw Object.assign(new Error(this.say({ zh: `初始化没有完成：${reason}。${undone.text.zh}`, en: `The folder wasn’t made a Git repository: ${reason}. ${undone.text.en}` })), {
        status: 500, code: 'git_init_failed', cause: error, details: { stage, ...(error.details ?? {}), undone: undone.result },
      });
    }
    // The commit exists from here on: nothing is undone any more, what follows is reported as it is.
    const head = await this.exec(folder, ['rev-parse', '--verify', '-q', 'HEAD']), commit = head.code === 0 ? head.stdout.trim() : null;
    const status = await this.exec(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { maxBytes: STATUS_BYTES, timeoutMs: LIST_MS });
    const changed = status.code === 0 ? [...new Set(changedPaths(status.stdout))].sort() : [];
    const largeFiles = plan.largeFiles;
    try {
      this.store.mutate(state => {
        const row = state.projects.find(item => item.id === project.id);
        if (row) row.git = { sessionWorktreeDefault: false, worktrees: [], applies: [], ...(row.git ?? {}), init: { at: new Date().toISOString(), by: 'rna', commit, branch: plan.branch, largeFiles: largeFiles.map(file => file.path) } };
      });
    } catch (error) { console.error('git init record:', error.message); }
    return { commit, branch: plan.branch, files: plan.count, largeFiles, status: changed.length || status.code !== 0 ? 'changed' : 'clean', ...(changed.length ? { changed: changed.slice(0, 200) } : {}) };
  }
  /**
   * Put P back as it was (design §10 "任何一步失败"): a `.git` proven to be this run's (a folder born after the start
   * with no ref and no packed ref) moves to `.rna/trash.nosync/init-<time>.git`, never deleted; `.gitignore` goes
   * back to its old bytes (or the file this run created is removed) when nobody changed it since.
   */
  async undo(folder, { startedAt, gitignore, written }) {
    const result = { git: 'none', gitignore: 'unchanged' };
    const gitDir = join(folder, '.git'), info = await lstat(gitDir).catch(() => null);
    if (info) {
      result.git = 'kept';
      try {
        if (info.isDirectory() && info.birthtimeMs >= startedAt - 1000 && !(await hasRefs(gitDir))) {
          const trash = await trashFolder(folder);
          if (trash) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            let name = `init-${stamp}.git`;
            for (let n = 2; existsSync(join(trash, name)); n++) name = `init-${stamp}-${n}.git`;
            await rename(gitDir, join(trash, name));
            Object.assign(result, { git: 'trash', trash: `${TRASH_DIR}/${name}` });
          }
        }
      } catch (error) { console.error('git init undo:', error.message); }
    }
    if (written) {
      result.gitignore = 'kept';
      try {
        const now = await readFile(gitignore.path).catch(() => null);
        if (now && now.equals(written)) {
          if (gitignore.exists) { await replaceFile(gitignore.path, gitignore.content, gitignore.mode); result.gitignore = 'restored'; }
          else { await unlink(gitignore.path); result.gitignore = 'removed'; }
        }
      } catch (error) { console.error('git init undo:', error.message); }
    }
    const git = { trash: { zh: `.git 已移到 ${result.trash}`, en: `.git was moved to ${result.trash}` }, kept: { zh: '.git 无法确认是这次创建的，留在原处', en: '.git was left in place because it couldn’t be confirmed as this run’s' }, none: { zh: '', en: '' } }[result.git];
    const file = { restored: { zh: '.gitignore 已恢复原样', en: '.gitignore was restored' }, removed: { zh: '这次新建的 .gitignore 已移除', en: 'the .gitignore this run created was removed' }, kept: { zh: '.gitignore 在这期间被改过，保留现状', en: '.gitignore changed meanwhile and was left as it is' }, unchanged: { zh: '', en: '' } }[result.gitignore];
    const zh = [git.zh, file.zh].filter(Boolean).join('，'), en = [git.en, file.en].filter(Boolean).join('; ');
    return { result, text: { zh: zh ? `${zh}。` : '', en: en ? `${en[0].toUpperCase()}${en.slice(1)}.` : '' } };
  }
  /** Drops expired preview tokens. */
  sweep() { for (const [token, row] of this.pending) if (row.expiresAt <= this.now()) this.pending.delete(token); }
}

/**
 * The listing in the probe repository (see the module comment). `list(lines)` answers the paths `git add -A` would
 * stage with `lines` appended to the root `.gitignore`: files, links, and `dir/` for a repository of its own.
 */
class Probe {
  constructor(service, { dir, gitDir, excludePath, template, folder, gitignore }) {
    Object.assign(this, { service, dir, gitDir, excludePath, template, folder, gitignore });
    this.offset = template.split('\n').length - 1;
    this.env = { GIT_DIR: gitDir, GIT_WORK_TREE: folder };
  }
  run(args, options = {}) { return this.service.exec(this.folder, args, { env: this.env, ...options }); }
  async exclude(lines) { await writeFile(this.excludePath, `${this.template}${RNA_EXCLUDE}\n${lines.map(line => `${line}\n`).join('')}`); }
  async others(extra = []) {
    const result = await this.run(['ls-files', '-z', '-o', '--exclude-standard', ...extra], { maxBytes: LIST_BYTES, timeoutMs: LIST_MS });
    if (result.truncated) {
      const count = records(result.stdout.slice(0, result.stdout.lastIndexOf('\0') + 1)).length;
      if (count > this.service.limits.initMaxFiles) fail(this.service.say({ zh: `这个文件夹的文件超过了 ${this.service.limits.initMaxFiles} 个的上限。请先在 .gitignore 里忽略不需要的文件夹。`, en: `This folder holds more than ${this.service.limits.initMaxFiles} files. Ignore the folders you don’t need in .gitignore first.` }), 409, 'git_init_too_many_files');
    }
    if (result.code !== 0 || result.truncated) this.service.gitFailed(result, result.timedOut ? { zh: '列出文件用的时间太长了', en: 'Listing the files took too long' } : { zh: 'Git 没能列出这个文件夹里的文件', en: 'Git couldn’t list the files in this folder' });
    return [...new Set(records(result.stdout))].sort();
  }
  async list(lines) {
    await this.exclude(lines);
    const listed = await this.others();
    const negation = lines.some(line => line.startsWith('!')) || String(this.gitignore.content ?? '').split(/\r?\n/).some(line => line.startsWith('!'));
    if (!negation || lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 4, 0) > COMMAND_LINE_BYTES) return listed;
    // As git reads a file: `#` lines are comments and unescaped trailing spaces are dropped (`-x` does neither).
    const patterns = lines.filter(line => !line.startsWith('#')).map(line => line.replace(/(?<!\\) +$/, '')).filter(Boolean);
    const commandLine = await this.others(patterns.flatMap(line => ['-x', line]));
    const first = new Set(listed), second = new Set(commandLine);
    const onlyFirst = listed.filter(path => !second.has(path)), onlySecond = commandLine.filter(path => !first.has(path));
    if (!onlyFirst.length && !onlySecond.length) return listed;
    if (onlyFirst.length + onlySecond.length > RECONCILE_MAX) return listed;
    const chain = path => { const parts = path.replace(/\/$/, '').split('/'); return parts.map((_, index) => parts.slice(0, index + 1).join('/')); };
    const sources = await this.checkIgnore([...new Set([...onlyFirst, ...onlySecond].flatMap(chain))]);
    // A deeper `.gitignore` outranks the root one, so where one decided, the appended block changes nothing.
    const deeper = path => chain(path).some(part => { const source = sources.get(part)?.source; return Boolean(source) && !isAbsolute(source) && source !== '.gitignore'; });
    const kept = new Set(listed);
    for (const path of onlyFirst) if (!deeper(path)) kept.delete(path);
    for (const path of onlySecond) if (!deeper(path)) kept.add(path);
    return [...kept].sort();
  }
  /** `check-ignore -v -n`: path → the rule git decided it by ({ source, line, pattern }), for paths any rule matched. */
  async checkIgnore(paths) {
    const found = new Map();
    if (!paths.length) return found;
    const result = await this.run(['check-ignore', '-v', '-n', '-z', '--stdin'], { env: { ...this.env, ...CHECK_IGNORE_ENV }, input: `${paths.map(asPathspec).join('\0')}\0`, maxBytes: LIST_BYTES, timeoutMs: COUNT_MS });
    if ((result.code !== 0 && result.code !== 1) || result.truncated) this.service.gitFailed(result, { zh: 'Git 没能核对忽略规则', en: 'Git couldn’t check the ignore rules' });
    const fields = result.stdout.split('\0');
    for (let index = 0; index + 3 < fields.length; index += 4) {
      const [source, line, pattern, path] = fields.slice(index, index + 4);
      if (source) found.set(fromPathspec(path), { source, line: Number(line), pattern });
    }
    return found;
  }
  /**
   * Files and bytes each line ignores: the ignored entries (whole folders where git stops), the line git decided
   * each by, then a bounded walk. null when the folder is too big to count quickly; a line whose folders could not
   * be walked in time gets no numbers.
   */
  async counts(lines) {
    await this.exclude(lines);
    const listed = await this.run(['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory'], { maxBytes: COUNT_BYTES, timeoutMs: COUNT_MS });
    if (listed.code !== 0 || listed.truncated || listed.timedOut) return null;
    const entries = records(listed.stdout);
    if (entries.length > RECONCILE_MAX) return null;
    const sources = await this.checkIgnore(entries.map(entry => entry.replace(/\/$/, '')));
    const totals = lines.map(() => ({ count: 0, bytes: 0 })), budget = { entries: COUNT_ENTRIES, deadline: Date.now() + COUNT_WALK_MS };
    for (const entry of entries) {
      const hit = sources.get(entry.replace(/\/$/, ''));
      if (!hit || hit.source !== this.excludePath) continue;
      const index = hit.line - this.offset - 2;
      if (index < 0 || index >= lines.length || !totals[index]) continue;
      const sum = await measure(join(this.folder, entry), budget);
      if (!sum) { totals[index] = null; continue; }
      totals[index].count += sum.count; totals[index].bytes += sum.bytes;
    }
    return totals;
  }
  close() { return rm(this.dir, { recursive: true, force: true }); }
}

/**
 * Files and bytes under a path (links not followed, `.git` folders skipped), STAT_CONCURRENCY entries at a time;
 * null once the budget (entries, deadline) runs out.
 */
function measure(path, budget) {
  const queue = [path];
  let count = 0, bytes = 0, active = 0, over = false;
  return new Promise(done => {
    const settle = () => { if (!active && (over || !queue.length)) done(over ? null : { count, bytes }); };
    const step = () => {
      while (queue.length && active < STAT_CONCURRENCY && !over) {
        if (--budget.entries < 0 || Date.now() > budget.deadline) { over = true; break; }
        const current = queue.pop();
        active++;
        lstat(current).then(async info => {
          if (!info.isDirectory()) { count++; bytes += info.size; return; }
          const names = (await readdir(current).catch(() => [])).filter(name => name !== '.git');
          queue.splice(queue.length, 0, ...names.map(name => join(current, name)));
        }).catch(() => {}).finally(() => { active--; step(); });
      }
      settle();
    };
    step();
  });
}
/** Paths named by `status --porcelain=v1 -z` (a rename's second record is its old path). */
function changedPaths(text) {
  const paths = new Set(), fields = text.split('\0');
  for (let index = 0; index < fields.length; index++) {
    const record = fields[index];
    if (record.length < 4) continue;
    paths.add(record.slice(3));
    if (record[0] === 'R' || record[0] === 'C') paths.add(fields[++index]);
  }
  paths.delete(undefined); paths.delete('');
  return [...paths];
}
/** Whether a git folder holds any ref (loose or packed): one with none has no commit this run could lose. */
async function hasRefs(gitDir) {
  const packed = await readFile(join(gitDir, 'packed-refs'), 'utf8').catch(() => '');
  if (packed.split('\n').some(line => line && !line.startsWith('#'))) return true;
  const stack = [join(gitDir, 'refs')];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) return true;
      stack.splice(stack.length, 0, join(current, entry.name));
    }
  }
  return false;
}
/** `<P>/.rna/trash.nosync`, made if needed; null when a link (or anything but folders) is in the way. */
async function trashFolder(folder) {
  let current = folder;
  for (const part of TRASH_DIR.split('/')) {
    current = join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info) await mkdir(current, { mode: 0o755 });
    else if (!info.isDirectory()) return null;
  }
  return within(folder, await realpath(current)) ? current : null;
}
/** `/.rna/` added to the new repository's info/exclude (Rna's worktrees and trash stay out of git). */
async function appendExclude(path) {
  await mkdir(dirname(path), { recursive: true });
  const current = await readFile(path, 'utf8').catch(() => '');
  await writeFile(path, `${current}${current && !current.endsWith('\n') ? '\n' : ''}# Rna Agent keeps its working copies and trash here\n${RNA_EXCLUDE}\n`);
}
/** A file's new bytes in a temporary file beside it (fsynced, with `mode`), handed to `place`, removed if not placed. */
async function viaTemporary(path, content, mode, place) {
  const temp = join(dirname(path), `.rna-tmp-${randomBytes(6).toString('hex')}`);
  let handle = await open(temp, 'wx', mode), placed = false;
  try {
    await handle.writeFile(content); await handle.sync(); await handle.close(); handle = null;
    await chmod(temp, mode); placed = await place(temp);
  } finally {
    await handle?.close().catch(() => {});
    if (!placed) await unlink(temp).catch(() => {});
  }
}
/** Replace a file's bytes atomically (rename over it), keeping its permission bits. */
const replaceFile = (path, content, mode) => viaTemporary(path, content, mode, async temp => { await rename(temp, path); return true; });
/** Create a file that must not exist yet: a hard link fails when something took the name meanwhile. */
const createFile = (path, content, mode) => viaTemporary(path, content, mode, async temp => { await link(temp, path); return false; });
/** The app's own folder: the `.app` this host runs from, or (from a checkout) the host's folder. */
function defaultAppRoot() {
  const parts = import.meta.dirname.split(sep), app = parts.findIndex(part => part.endsWith('.app'));
  return app > 0 ? parts.slice(0, app + 1).join(sep) : import.meta.dirname;
}
