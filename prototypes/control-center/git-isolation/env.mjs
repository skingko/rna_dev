import { lstat, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sandboxAvailable } from '../../../packages/sdk/src/workspace-exec.mjs';
import { ISOLATION_ERRORS, ISOLATION_READY, MIN_GIT_VERSION } from './contract.mjs';

// Engine environment (design §3.1) and the isolation conditions (design §2). Owner: T1.
//
// Engine git runs through WorkspaceGitService.run() with the options T1 adds there (design §3.1):
//   run(cwd, args, { maxBytes, timeoutMs, killSignal, env, input, engine, raw })
//   - env:    merged in after LOCAL_ENV is stripped
//   - input:  stdin (for --stdin, --stdin-paths, --pathspec-from-file=-)
//   - engine: true (or { excludesFile, config }) adds ENGINE_ENV and engineArgs() below
//   - raw:    stdout as a Buffer
// No git subcommand that talks to another repository ever runs here; a static test (T1) guards this directory and
// git-init-service.mjs, so keep those subcommand names out of the source, comments included.

/** No system or global config: no external filter or merge driver from them ever runs (design §1 #4). */
export const ENGINE_ENV = Object.freeze({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
/** Fixed `-c` settings of every engine command (design §3.1), after run()'s own fsmonitor/hooks settings. */
export const ENGINE_CONFIG = Object.freeze(['gc.auto=0', 'maintenance.auto=false', 'commit.gpgsign=false', 'core.untrackedCache=false', 'merge.conflictStyle=zdiff3', 'user.name=Rna Agent', 'user.email=rna@localhost']);
const DRIVER_KEY = /^(filter|merge)\.(.+)\.(clean|smudge|process|driver)$/i;

/** An engine error: `code` from ISOLATION_ERRORS (its HTTP status), a plain message (the routes add the user's language). */
export function engineError(code, message, extra = {}) {
  return Object.assign(new Error(message ?? code), { status: ISOLATION_ERRORS[code] ?? 500, code, ...extra });
}

/**
 * The user's global `core.excludesFile`, read once at daemon start with the ordinary environment
 * (`git config --global --type=path core.excludesFile`), so global ignore rules still apply to snapshots.
 * @param {import('../workspace-git-service.mjs').WorkspaceGitService} git
 * @returns {Promise<string|null>}
 */
export async function globalExcludesFile(git) {
  let home = tmpdir();
  try { home = git.home?.() ?? homedir(); } catch { /* the temporary folder will do as a working folder */ }
  try {
    const result = await git.run(home, ['config', '--global', '--type=path', '--get', 'core.excludesFile']);
    const value = result.code === 0 ? result.stdout.trim() : '';
    return value ? resolve(home, value) : null;
  } catch { return null; }
}

/**
 * `-c` arguments of an engine command: ENGINE_CONFIG, plus `core.excludesFile=<value>` when one was read, plus
 * `config` overrides (driverOverrides()).
 * @param {{ excludesFile?: string|null, config?: string[] }} [options]
 * @returns {string[]}
 */
export function engineArgs({ excludesFile = null, config = [] } = {}) {
  return [...ENGINE_CONFIG, ...(excludesFile ? [`core.excludesFile=${excludesFile}`] : []), ...config].flatMap(setting => ['-c', setting]);
}

/**
 * `git --version`, parsed. Null when git cannot run.
 * @returns {Promise<{ text: string, major: number, minor: number, patch: number }|null>}
 */
export async function gitVersion(git) {
  try {
    const tools = await git.availability?.();
    if (tools && !tools.ok) return null;
    const result = await git.run(tmpdir(), ['--version']);
    const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(result.stdout);
    if (result.code !== 0 || !match) return null;
    const [major, minor, patch = 0] = match.slice(1).map(value => Number(value ?? 0));
    return { text: `${major}.${minor}.${patch}`, major, minor, patch };
  } catch { return null; }
}

/** Whether `version` is at least `minimum` (default MIN_GIT_VERSION, 2.38.0). */
export function versionAtLeast(version, minimum = MIN_GIT_VERSION) {
  if (!version) return false;
  const have = Array.isArray(version) ? version : [version.major, version.minor, version.patch];
  for (let index = 0; index < 3; index++) {
    const a = Number(have[index] ?? 0), b = Number(minimum[index] ?? 0);
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Repository-local `filter.*.{clean,smudge,process}` and `merge.*.driver` keys (any one turns isolation off with
 * `custom_git_drivers`). Read with the engine environment, so only the repository's own config (and its includes)
 * counts.
 * @param {import('../workspace-git-service.mjs').WorkspaceGitService} git
 * @param {{ workspace: string, commonDir: string }} located  WorkspaceGitService.locateProject's answer
 * @returns {Promise<string[]>}
 */
export async function customDrivers(git, located) {
  const result = await git.run(located.workspace, ['config', '--name-only', '--get-regexp', '^(filter\\..+\\.(clean|smudge|process)|merge\\..+\\.driver)$'], { engine: { excludesFile: null } });
  if (result.code !== 0) return [];
  return [...new Set(result.stdout.split('\n').map(line => line.trim()).filter(line => DRIVER_KEY.test(line)))];
}

/**
 * `-c` overrides that keep the repository's own drivers from running in engine commands (direct-mode checkpoints
 * and rollback still work in such a repository, isolation does not): a filter's programs become empty (git then
 * stores and checks out the raw bytes) and a merge driver becomes `false`, so a path it would merge is a conflict.
 * @param {string[]} keys  customDrivers()
 * @returns {string[]}
 */
export function driverOverrides(keys) {
  const overrides = new Set();
  for (const key of keys) {
    const match = DRIVER_KEY.exec(key);
    if (!match) continue;
    const [, section, name] = match;
    if (section.toLowerCase() === 'filter') for (const setting of [`filter.${name}.clean=`, `filter.${name}.smudge=`, `filter.${name}.process=`, `filter.${name}.required=false`]) overrides.add(setting);
    else overrides.add(`merge.${name}.driver=false`);
  }
  return [...overrides];
}

/**
 * The isolation conditions of design §2, in this order: ISOLATION_READY (`not_ready`), sandboxAvailable()
 * (`sandbox_unavailable`), git runs (`git_unavailable`), git ≥ 2.38 (`git_too_old`), the folder exists
 * (`workspace_missing`), P is in a repository, main or linked, not a home dotfiles repository (`no_repository`),
 * no custom drivers (`custom_git_drivers`). A repository without commits qualifies. `ready` defaults to
 * ISOLATION_READY (tests pass true).
 * @param {{ git: import('../workspace-git-service.mjs').WorkspaceGitService, projectId: string, sandbox?: () => boolean, ready?: boolean }} input
 * @returns {Promise<import('./contract.mjs').Isolation>}
 */
export async function eligibility({ git, projectId, sandbox = sandboxAvailable, ready = ISOLATION_READY }) {
  const version = await gitVersion(git), text = version?.text ?? null;
  const off = reason => ({ enabled: false, reason, git: text });
  if (!ready) return off('not_ready');
  if (!sandbox()) return off('sandbox_unavailable');
  if (!version) return off('git_unavailable');
  if (!versionAtLeast(version)) return off('git_too_old');
  const located = await git.locateProject(projectId);
  if (located.repo === 'none') {
    if (located.unavailable === 'workspace_missing') return off('workspace_missing');
    if (located.unavailable && ['git_missing', 'developer_tools'].includes(located.unavailable)) return off('git_unavailable');
    return off('no_repository');
  }
  if ((await customDrivers(git, located)).length) return off('custom_git_drivers');
  return { enabled: true, git: text };
}

/**
 * GIT_DIR and GIT_WORK_TREE for git on an Rna worktree, taken from its record, never discovered from the folder
 * (design §0.3-6, §3.1). `record.dir` is relative to the project folder P; `record.gitName` (when git named the
 * administrative folder differently from the worktree folder) wins over `record.name`.
 * @param {{ name: string, dir: string, gitName?: string }} record  project.git.worktrees[] row
 * @param {{ commonDir: string, top: string, workspace?: string, prefix?: string }} located
 * @returns {{ GIT_DIR: string, GIT_WORK_TREE: string }}
 */
export function worktreeEnv(record, located) {
  const project = located.workspace ?? join(located.top, located.prefix ?? '');
  return { GIT_DIR: join(located.commonDir, 'worktrees', record.gitName ?? record.name), GIT_WORK_TREE: resolve(project, record.dir) };
}

/**
 * Before git runs on a worktree: `<workTree>/.git` must read `gitdir: <gitDir>`. A changed file is written back
 * and reported (`repaired: true`, logged as `worktree_tampered`). A `.git` folder in its place is never removed:
 * `ok: false`, and the caller refuses to run git there.
 * @returns {Promise<{ ok: boolean, repaired: boolean }>}
 */
export async function verifyGitFile(workTree, gitDir) {
  const file = join(workTree, '.git'), expected = `gitdir: ${gitDir}\n`;
  const folder = await stat(workTree).catch(() => null);
  if (!folder?.isDirectory()) return { ok: false, repaired: false };
  const info = await lstat(file).catch(() => null);
  if (info?.isFile() && (await readFile(file, 'utf8').catch(() => null))?.trim() === expected.trim()) return { ok: true, repaired: false };
  if (info?.isDirectory()) return { ok: false, repaired: false };
  if (info) await unlink(file).catch(() => {});
  const temporary = `${file}.rna-tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, expected, { mode: 0o644 });
  await rename(temporary, file);
  console.warn(`worktree_tampered: ${workTree}`);
  return { ok: true, repaired: true };
}
