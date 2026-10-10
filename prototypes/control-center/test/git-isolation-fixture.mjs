import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Store } from '../store.mjs';
import { WorkspaceGitService } from '../workspace-git-service.mjs';
import { IsolationEngine, REFS, WORKTREE_DIR, worktreeName } from '../git-isolation/index.mjs';

// Shared set-up of the merge engine tests (test/git-isolation-*.test.mjs, test/apply-rollback.test.mjs): a temporary
// repository, a store with one project on it, and an engine with isolation allowed. Temporary folders only; the
// user's own git configuration never shapes these results.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const gitEnv = () => { const env = { ...process.env, LC_ALL: 'C' }; for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/.test(key)) delete env[key]; return env; };

/** A git command in a test repository; a last argument `{ input }` goes to its stdin. */
export const git = (cwd, ...args) => {
  const options = typeof args.at(-1) === 'object' ? args.pop() : {};
  return execFileSync('git', ['-c', 'user.name=Rna Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, env: gitEnv(), encoding: 'utf8', stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...(options.input === undefined ? {} : { input: options.input }) });
};
export const put = (root, path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
export const read = (root, path) => readFileSync(join(root, path), 'utf8');
export const bytes = (root, path) => readFileSync(join(root, path));
export const gitVersionOk = (() => { try { const [, major, minor] = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' })); return Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 38); } catch { return false; } })();
export const skip = gitVersionOk ? false : 'git 2.38 or later is needed';

/**
 * A repository at `<dir>/repo` (the project folder is `repo/<prefix>`) with `files` committed, a store with one
 * project on the folder and an engine. `commit: false` leaves the repository without commits.
 */
export function fixture(t, { files = { 'a.txt': 'one\ntwo\nthree\n' }, prefix = '', commit = true, engine: options = {} } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-iso-'))), repo = join(dir, 'repo'), workspace = prefix ? join(repo, prefix) : repo;
  mkdirSync(workspace, { recursive: true });
  git(repo, 'init', '-q');
  for (const [path, content] of Object.entries(files)) put(workspace, path, content);
  if (commit && Object.keys(files).length) { git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'first'); }
  const store = new Store(join(dir, '.state', 'state.json'));
  const { project } = store.createProject({ name: 'Iso', workspace, initiative: { enabled: false } });
  const service = new WorkspaceGitService(store);
  const engine = new IsolationEngine(store, { git: service, ready: true, sandbox: () => true, pollMs: 20, ...options });
  service.engine = engine;
  t.after(() => { engine.close(); try { store.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });
  const root = { root: workspace, kind: 'project', isolated: false, project: workspace, prefix: prefix ? `${prefix.replace(/\/$/, '')}/` : '' };
  const commonDir = join(repo, '.git');
  /** An Rna worktree of `kind` checked out at `commit` (a snapshot), registered like WorktreeService registers one. */
  const worktree = (kind, id, commit, { owner = {} } = {}) => {
    const name = worktreeName(kind, id), dir_ = join(workspace, WORKTREE_DIR, name);
    mkdirSync(dirname(dir_), { recursive: true });
    // As WorktreeService does (design §6.2 step 4): the copies are excluded from the project folder's own status.
    appendFileSync(join(commonDir, 'info', 'exclude'), `/${root.prefix}.rna/\n`);
    git(workspace, 'worktree', 'add', '--detach', '--lock', dir_, commit);
    const workTree = realpathSync(dir_), record = { id, kind, name, dir: `${WORKTREE_DIR}/${name}`, prefix: root.prefix, owner, seed: commit, state: 'active', createdAt: new Date().toISOString() };
    store.mutate(state => { const row = state.projects.find(item => item.id === project.id); row.git ??= { sessionWorktreeDefault: false, worktrees: [], applies: [] }; row.git.worktrees ??= []; row.git.worktrees.push(record); });
    return { root: join(workTree, root.prefix).replace(/\/$/, ''), kind, isolated: true, project: workspace, prefix: root.prefix, worktreeId: id, gitDir: join(commonDir, 'worktrees', name), workTree };
  };
  const refs = () => git(repo, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean);
  const applies = () => store.state.projects.find(row => row.id === project.id).git?.applies ?? [];
  return { dir, repo, workspace, store, project, service, engine, root, commonDir, worktree, refs, applies, REFS };
}

/** Everything under a folder except `.git` and `.rna`, as path → content (hex; links as `-> target`), for byte-for-byte comparisons. */
export function treeBytes(root) {
  const out = {};
  const walk = folder => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (folder === root && ['.git', '.rna'].includes(entry.name)) continue;
      const path = join(folder, entry.name), key = path.slice(root.length + 1);
      if (entry.isSymbolicLink()) out[key] = `-> ${readlinkSync(path)}`;
      else if (entry.isDirectory()) walk(path);
      else out[key] = `${(lstatSync(path).mode & 0o111) ? 'x ' : ''}${readFileSync(path).toString('hex')}`;
    }
  };
  walk(root);
  return out;
}
