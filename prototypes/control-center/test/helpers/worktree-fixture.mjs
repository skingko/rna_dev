// Shared fixture for the worktree tests (design 0.63 §13 T2): real temporary git repositories under os.tmpdir(),
// git with no global or system configuration, a real Store, and a stand-in for the merge engine (T1's
// IsolationEngine) whose snapshots are real git trees and commits, so worktrees, refs and records can be checked on
// disk. Nothing here touches the user's projects, production state or the network.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store.mjs';
import { WorkspaceGitService } from '../../workspace-git-service.mjs';
import { RootResolver } from '../../workspace-roots.mjs';
import { WorktreeService } from '../../worktree-service.mjs';
import { WORKTREE_DIR, REFS } from '../../git-isolation/contract.mjs';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const IDENTITY = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];

export const gitVersionOk = (() => { try { const [major, minor] = execFileSync('git', ['--version'], { encoding: 'utf8' }).match(/(\d+)\.(\d+)/).slice(1).map(Number); return major > 2 || major === 2 && minor >= 38; } catch { return false; } })();

/** git in `cwd`, synchronously; `env` adds variables (GIT_DIR / GIT_WORK_TREE of a worktree). */
export function git(cwd, args, { env = {}, input } = {}) {
  return execFileSync('git', [...IDENTITY, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
}
export const ok = (cwd, args, options) => { try { git(cwd, args, options); return true; } catch { return false; } };
export const write = (root, path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };

/**
 * A temporary repository with one commit. `prefix`: the project folder is that subfolder of the repository.
 * Returns the repository top, the project folder P (both resolved), a Store with the project, and the services.
 */
export function fixture(t, { prefix = '', files = { 'README.md': 'hello\n', 'src/app.js': 'export const a = 1;\n' }, gitignore = 'dist/\n.env*\n.venv/\n' } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'rna-worktree-'))), top = join(directory, 'repo'), P = prefix ? join(top, prefix) : top;
  mkdirSync(P, { recursive: true });
  git(top, ['init', '-q']);
  for (const [path, text] of Object.entries(files)) write(P, path, text);
  if (gitignore !== null) write(P, '.gitignore', gitignore);
  git(top, ['add', '-A']); git(top, ['commit', '-q', '-m', 'init']);
  const store = new Store(join(directory, 'state', 'state.json'));
  const { project, session } = store.createProject({ name: 'Worktree fixture', workspace: P, initiative: { enabled: false } });
  store.mutate(state => { const row = state.projects.find(item => item.id === project.id); row.git = { sessionWorktreeDefault: false, worktrees: [], applies: [] }; row.permissions = { workspace: 'execute', background: 'read', revision: 1 }; });
  const gitService = new WorkspaceGitService(store);
  const roots = new RootResolver(store, { git: gitService });
  const engine = new FakeEngine(store, gitService);
  const worktrees = new WorktreeService(store, { git: gitService, engine, roots });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, top, P, prefix, store, project, session, git: gitService, roots, engine, worktrees };
}

/**
 * Add a worktree the way WorktreeService does, without the service (for the resolver tests): detached at HEAD,
 * locked, recorded in project.git.worktrees. `/<prefix>.rna/` is excluded first.
 */
export function addWorktree(f, { kind = 'session', id, name, owner = {}, state = 'active' } = {}) {
  const commonDir = realpathSync(join(f.top, '.git')), exclude = join(commonDir, 'info', 'exclude');
  mkdirSync(join(commonDir, 'info'), { recursive: true });
  writeFileSync(exclude, `/${f.prefix ? `${f.prefix}/` : ''}.rna/\n`, { flag: 'a' });
  const dir = `${WORKTREE_DIR}/${name}`, top = join(f.P, dir);
  mkdirSync(join(f.P, WORKTREE_DIR), { recursive: true });
  git(f.P, ['worktree', 'add', '--detach', '--lock', '--reason', 'fixture', top, 'HEAD']);
  const head = git(f.P, ['rev-parse', 'HEAD']).trim();
  const record = { id, kind, name, dir, prefix: f.prefix ? `${f.prefix}/` : '', owner, seed: head, ...(kind === 'session' ? { base: head } : {}), state, createdAt: new Date().toISOString() };
  f.store.mutate(s => { const row = s.projects.find(item => item.id === f.project.id); row.git.worktrees.push(record); });
  return { record, top: realpathSync(top), root: realpathSync(f.prefix ? join(top, f.prefix) : top), gitDir: join(commonDir, 'worktrees', name) };
}

/**
 * The merge engine's surface WorktreeService uses, standing in for T1's IsolationEngine: snapshots through a
 * temporary index (`read-tree HEAD`, `add -A`, `write-tree`, `commit-tree`, never the user's index), refs pinned with
 * update-ref, a FIFO lock. merge / apply answer what a test sets (`mergeResult`, `applyOutcome`) and record calls.
 */
export class FakeEngine {
  constructor(store, git) {
    Object.assign(this, { store, git });
    this.calls = []; this.queue = Promise.resolve(); this.isolationAnswer = { enabled: true, git: 'fixture' };
    this.mergeResult = { clean: true, mid: 'a1b2c3d4', tree: '', labels: {}, writes: [], conflicts: [], notMerged: [], bothChanged: 0 };
    this.applyOutcome = { status: 'applied', applyId: 'apply-1', mid: 'a1b2c3d4', before: '', result: '', written: [], removed: [], conflicts: [], notMerged: [], bothChanged: 0, verify: 'verified', dependencies: false };
  }
  projectFolder(projectId) { return realpathSync(this.store.state.projects.find(row => row.id === projectId).workspace); }
  async isolation(projectId) { this.calls.push(['isolation', projectId]); return this.isolationAnswer; }
  async lock(projectId, work) { this.calls.push(['lock', projectId]); const next = this.queue.catch(() => {}).then(work); this.queue = next; return next; }
  async snapshot(projectId, root, { pin } = {}) {
    this.calls.push(['snapshot', root.kind, root.root, pin ?? null]);
    const index = join(mkdtempSync(join(tmpdir(), 'rna-fake-index-')), 'index');
    const env = { GIT_INDEX_FILE: index, ...(root.isolated ? { GIT_DIR: root.gitDir, GIT_WORK_TREE: root.workTree } : {}) };
    try {
      const head = ok(root.root, ['rev-parse', '-q', '--verify', 'HEAD'], { env }) ? git(root.root, ['rev-parse', 'HEAD'], { env }).trim() : null;
      git(root.root, head ? ['read-tree', head] : ['read-tree', '--empty'], { env });
      git(root.root, ['add', '-A', '--', '.'], { env });
      const tree = git(root.root, ['write-tree'], { env }).trim();
      const commit = git(root.root, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'snapshot'], { env }).trim();
      if (pin) git(this.projectFolder(projectId), ['update-ref', pin, commit]);
      return { tree, commit, nested: [], oversized: [] };
    } finally { rmSync(join(index, '..'), { recursive: true, force: true }); }
  }
  async pin(projectId, updates) {
    this.calls.push(['pin', updates.map(row => [row.ref, row.commit])]);
    for (const { ref, commit } of updates) git(this.projectFolder(projectId), commit ? ['update-ref', ref, commit] : ['update-ref', '-d', ref]);
  }
  async merge(projectId, trees, options) { this.calls.push(['merge', trees, options.labels]); return structuredClone(this.mergeResult); }
  async apply(projectId, request) { this.calls.push(['apply', { ...request, target: request.target.kind }]); return structuredClone(this.applyOutcome); }
}

export const refOf = (cwd, ref) => (ok(cwd, ['rev-parse', '-q', '--verify', ref]) ? git(cwd, ['rev-parse', ref]).trim() : null);
export { REFS };
