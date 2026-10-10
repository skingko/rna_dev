import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../server.mjs';
import { WorkspaceGitService } from '../workspace-git-service.mjs';
import { WorkspaceGitCompare, countLines, defaultBranch, newFilePatch, parseBranches, parseUnmerged, quoteName, splitPatch, unquoteName } from '../workspace-git-compare.mjs';

// Temporary repositories only; the user's own git configuration never shapes these results.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const gitEnv = () => { const env = { ...process.env, LC_ALL: 'C' }; for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/.test(key)) delete env[key]; return env; };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Rna', '-c', 'user.email=rna@localhost', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (root, path, content) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); };
const BINARY = Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]);
const hasGit = spawnSync('git', ['--version']).status === 0;
/** What git itself prints for a new file (`--no-index` exits 1 when the files differ). */
const noIndex = (cwd, path) => spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--', '/dev/null', path], { cwd, env: gitEnv(), encoding: 'utf8' }).stdout;

async function setup(t, { workspace: makeWorkspace } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'rna-git-compare-'))), workspace = join(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  makeWorkspace?.(workspace, directory);
  const app = createServer({ stateFile: join(directory, '.state', 'state.json'), ticks: false, runtime: false });
  await app.initializer.close();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = (path = workspace, name = 'Git') => app.store.createProject({ name, workspace: path, initiative: { enabled: false } }).project;
  const port = app.server.address().port;
  const call = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { app, directory, workspace, project, call };
}
const query = params => new URLSearchParams(params.flatMap(([key, values]) => [values].flat().filter(value => value !== undefined).map(value => [key, value]))).toString();
/** A compare service whose git runs are recorded. */
function recorded(store, options) {
  const service = new WorkspaceGitService(store, options), compare = new WorkspaceGitCompare(service), runs = [], run = service.run.bind(service);
  service.run = (cwd, args, more) => { runs.push(args); return run(cwd, args, more); };
  return { service, compare, runs, diffs: () => runs.filter(args => args.includes('diff')) };
}

/**
 * A branch `rna/feature` (no upstream) off `main`, with every kind of change since: a commit on the branch, an
 * unstaged edit, a deletion, a binary edit, a staged new file, a staged rename, a Chinese name with a space, and
 * untracked files (text without a final newline, empty, binary). `main` moved on after the branch left it.
 */
function featureRepository(root) {
  git(root, 'init', '-q');
  write(root, 'a.txt', 'one\ntwo\nthree\n'); write(root, 'keep.txt', 'keep\n'); write(root, 'old name.txt', 'moving\nfile\nwith\nlines\n'); write(root, 'bin.dat', BINARY); write(root, '文档/说明 1.md', '第一行\n');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'first');
  git(root, 'checkout', '-q', '-b', 'rna/feature');
  write(root, 'committed.txt', 'on the branch\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'branch work');
  git(root, 'checkout', '-q', 'main'); write(root, 'main-only.txt', 'later on main\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'main moves'); git(root, 'checkout', '-q', 'rna/feature');
  write(root, 'a.txt', 'one\nTWO\nthree\nfour\n');
  rmSync(join(root, 'keep.txt'));
  write(root, 'bin.dat', Buffer.concat([BINARY, BINARY]));
  write(root, 'staged.txt', 'new\n'); git(root, 'add', 'staged.txt');
  git(root, 'mv', 'old name.txt', 'new name.txt');
  write(root, '文档/说明 1.md', '第一行\n第二行\n');
  write(root, 'notes/新 文件.txt', '你好\n世界'); write(root, 'notes/empty.txt', ''); write(root, 'notes/blob.bin', BINARY);
}
const ALL_FILES = [
  { path: 'a.txt', status: 'M', added: 2, removed: 1 },
  { path: 'bin.dat', status: 'M', added: null, removed: null, binary: true },
  { path: 'committed.txt', status: 'A', added: 1, removed: 0 },
  { path: 'keep.txt', status: 'D', added: 0, removed: 1 },
  { path: 'new name.txt', oldPath: 'old name.txt', status: 'R', added: 0, removed: 0 },
  { path: 'notes/blob.bin', status: '?', added: null, removed: null, binary: true, untracked: true },
  { path: 'notes/empty.txt', status: '?', added: 0, removed: 0, untracked: true },
  { path: 'notes/新 文件.txt', status: '?', added: 2, removed: 0, untracked: true },
  { path: 'staged.txt', status: 'A', added: 1, removed: 0 },
  { path: '文档/说明 1.md', status: 'M', added: 1, removed: 0 },
];

test('branch lines, the default branch, quoting, patch splitting and line counts', () => {
  const rows = parseBranches(['refs/heads/main\0origin/main\0' + 'a'.repeat(40) + '\x001790000000\0/r', 'refs/heads/rna/x\0\0' + 'b'.repeat(40) + '\x001790000001\0', 'refs/tags/v1\0\0' + 'c'.repeat(40) + '\x001\0', ''].join('\n'), 'rna/x');
  assert.deepEqual(rows, [
    { name: 'main', sha: 'a'.repeat(40), upstream: 'origin/main', committedAt: 1790000000000, worktreePath: '/r', current: false },
    { name: 'rna/x', sha: 'b'.repeat(40), upstream: null, committedAt: 1790000001000, worktreePath: null, current: true },
  ]);
  const names = new Set(['main', 'master', 'trunk', 'rna/x']);
  assert.equal(defaultBranch(names, { remoteHead: 'trunk', configured: 'master', current: 'rna/x' }), 'trunk');
  assert.equal(defaultBranch(names, { remoteHead: 'gone', configured: 'master' }), 'master', 'a default that is not a local branch is skipped');
  assert.equal(defaultBranch(new Set(['master', 'x']), { current: 'x' }), 'master');
  assert.equal(defaultBranch(new Set(['x', 'y']), { current: 'y' }), 'y');
  assert.equal(defaultBranch(new Set(['x']), {}), null);
  // Quoting as git does with core.quotePath=false: only control characters, quotes and backslashes.
  for (const name of ['plain.txt', '新 文件.txt', 'we"ird\\name\t\x01.txt', 'line\nbreak']) {
    const quoted = quoteName(`b/${name}`);
    if (!/[\x00-\x1f"\\]/.test(name)) { assert.equal(quoted, `b/${name}`, name); continue; }
    assert.deepEqual(unquoteName(`${quoted} rest`), { name: `b/${name}`, rest: ' rest' }, name);
  }
  assert.equal(quoteName('a/we"ird.txt'), '"a/we\\"ird.txt"');
  assert.equal(unquoteName('"a/\\346\\226\\260.txt"').name, 'a/新.txt', 'octal escapes are UTF-8 bytes');
  assert.equal(unquoteName('"unterminated'), null);
  const patch = [
    'diff --git a/x y.txt b/x y.txt', 'index 1..2 100644', '--- a/x y.txt\t', '+++ b/x y.txt\t', '@@ -1 +1 @@', '-diff --git a/fake b/fake', '+b',
    'diff --git "a/we\\"ird.txt" "b/we\\"ird.txt"', 'new file mode 100644', '--- /dev/null', '+++ "b/we\\"ird.txt"', '@@ -0,0 +1 @@', '+q',
    'diff --git a/old.txt b/new b.txt', 'similarity index 100%', 'rename from old.txt', 'rename to new b.txt',
    'diff --git a/cut', ''].join('\n');
  assert.deepEqual(splitPatch(patch).map(row => row.path), ['x y.txt', 'we"ird.txt', 'new b.txt', null]);
  assert.ok(splitPatch(patch)[0].patch.endsWith('+b\n'));
  assert.deepEqual(splitPatch(''), []);
  assert.deepEqual([countLines(Buffer.from('')), countLines(Buffer.from('a')), countLines(Buffer.from('a\n')), countLines(Buffer.from('a\nb')), countLines(Buffer.from('\n\n'))], [0, 1, 1, 2, 2]);
  assert.equal(newFilePatch('cut.txt', Buffer.from('one\ntwo\npart'), { complete: false }), 'diff --git a/cut.txt b/cut.txt\nnew file mode 100644\n--- /dev/null\n+++ b/cut.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n');
});

test('all changes: merge-base(base, HEAD) → working tree, committed, staged, unstaged and untracked together', { skip: !hasGit }, async t => {
  const f = await setup(t, { workspace: featureRepository }), project = f.project(), url = `/api/v2/projects/${project.id}/git`;
  const mergeBase = git(f.workspace, 'merge-base', 'main', 'HEAD').trim(), head = git(f.workspace, 'rev-parse', 'HEAD').trim();
  const all = await f.call('GET', `${url}/compare?mode=all`);
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.deepEqual({ ...all.body, files: undefined }, { repo: 'main', mode: 'all', base: 'main', defaultBase: 'main', mergeBase, target: { kind: 'branch', label: 'rna/feature' }, files: undefined, truncated: false, operation: null });
  assert.deepEqual(all.body.files, ALL_FILES, 'main’s own later commit is not part of the branch’s changes');
  assert.deepEqual((await f.call('GET', `${url}/compare`)).body, all.body, 'all is the default mode, against the default branch');
  // Uncommitted: HEAD → working tree; the branch's commit drops out, the untracked files stay.
  const uncommitted = (await f.call('GET', `${url}/compare?mode=uncommitted&base=main`)).body;
  assert.deepEqual([uncommitted.mode, uncommitted.base, uncommitted.defaultBase, uncommitted.mergeBase, uncommitted.target], ['uncommitted', null, 'main', head, { kind: 'branch', label: 'rna/feature' }]);
  assert.deepEqual(uncommitted.files, ALL_FILES.filter(row => row.path !== 'committed.txt'));
  // Against the branch itself: the target is the working tree.
  const self = (await f.call('GET', `${url}/compare?${query([['mode', 'all'], ['base', 'rna/feature']])}`)).body;
  assert.deepEqual([self.base, self.mergeBase, self.target], ['rna/feature', head, { kind: 'working-tree', label: 'rna/feature' }]);

  // One git diff for a batch; untracked files are written in code exactly as git writes them.
  const { compare, diffs } = recorded(f.app.store);
  const paths = ['a.txt', 'bin.dat', 'committed.txt', 'keep.txt', 'new name.txt', 'notes/blob.bin', 'notes/empty.txt', 'notes/新 文件.txt', 'staged.txt', '文档/说明 1.md', 'never-changed.txt'];
  const { patches } = await compare.patches(project.id, { base: mergeBase, paths, oldPaths: ['old name.txt'] });
  assert.equal(diffs().length, 1, 'one git diff call for the whole batch');
  const by = Object.fromEntries(patches.map(row => [row.path, row.diff]));
  assert.deepEqual(patches.map(row => row.path), paths, 'in the order asked');
  assert.match(by['a.txt'].patch, /^-two$/m); assert.match(by['a.txt'].patch, /^\+four$/m); assert.doesNotMatch(by['a.txt'].patch, /diff --git a\/bin\.dat/);
  assert.deepEqual([by['bin.dat'], by['notes/blob.bin']], [{ kind: 'binary' }, { kind: 'binary' }]);
  assert.match(by['committed.txt'].patch, /^\+on the branch$/m);
  assert.match(by['keep.txt'].patch, /^deleted file mode/m);
  assert.match(by['new name.txt'].patch, /^rename from old name\.txt$/m, 'the old name pairs the move');
  assert.match(by['文档/说明 1.md'].patch, /^\+第二行$/m);
  assert.match(by['staged.txt'].patch, /^\+new$/m);
  for (const path of ['notes/empty.txt', 'notes/新 文件.txt']) assert.equal(by[path].patch, noIndex(f.workspace, path), path);
  assert.deepEqual(by['never-changed.txt'], { kind: 'patch', patch: '' });
  // The same through the route, with repeated path and oldPath parameters.
  const served = await f.call('GET', `${url}/patches?${query([['base', mergeBase], ['path', ['new name.txt', 'notes/新 文件.txt']], ['oldPath', 'old name.txt']])}`);
  assert.equal(served.status, 200, JSON.stringify(served.body));
  assert.deepEqual(served.body.patches.map(row => [row.path, row.diff.kind]), [['new name.txt', 'patch'], ['notes/新 文件.txt', 'patch']]);
  assert.match(served.body.patches[0].diff.patch, /rename to new name\.txt/);
  // Uncommitted patches start at HEAD.
  const sinceHead = await f.call('GET', `${url}/patches?${query([['base', 'HEAD'], ['path', ['committed.txt', 'a.txt']]])}`);
  assert.deepEqual(sinceHead.body.patches.map(row => [row.path, row.diff.patch === '']), [['committed.txt', true], ['a.txt', false]]);
});

test('untracked files written in code match git byte for byte: no final newline, empty, executable, quotes, links', { skip: !hasGit }, async t => {
  const f = await setup(t, { workspace: root => {
    git(root, 'init', '-q'); write(root, 'base.txt', 'x\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'a');
    write(root, 'plain.txt', 'a\nb\n'); write(root, 'one line', 'only'); write(root, 'empty', ''); write(root, 'run.sh', '#!/bin/sh\necho hi\n'); chmodSync(join(root, 'run.sh'), 0o755);
    write(root, 'we"ird\tname.txt', 'q\n'); write(root, '文档/新 文件.md', '你好\r\nwindows\r\n'); write(root, 'line\nbreak "q" x.txt', 'n\n');
  } });
  const project = f.project(), compare = new WorkspaceGitCompare(new WorkspaceGitService(f.app.store));
  const paths = ['plain.txt', 'one line', 'empty', 'run.sh', 'we"ird\tname.txt', '文档/新 文件.md', 'line\nbreak "q" x.txt'];
  const { patches } = await compare.patches(project.id, { base: 'HEAD', paths });
  for (const { path, diff } of patches) assert.deepEqual(diff, { kind: 'patch', patch: noIndex(f.workspace, path) }, path);
  const counts = Object.fromEntries((await compare.compare(project.id, { mode: 'uncommitted' })).files.map(row => [row.path, row.added]));
  assert.deepEqual(counts, { empty: 0, 'line\nbreak "q" x.txt': 1, 'one line': 1, 'plain.txt': 2, 'run.sh': 2, 'we"ird\tname.txt': 1, '文档/新 文件.md': 2 });
  // A new link: what git would show once it is staged (the path it points to), never the file there.
  write(f.directory, 'outside/secret.txt', 'top secret\n'); symlinkSync(join(f.directory, 'outside', 'secret.txt'), join(f.workspace, 'leak'));
  const link = (await compare.patches(project.id, { base: 'HEAD', paths: ['leak'] })).patches[0].diff;
  git(f.workspace, 'add', 'leak');
  assert.equal(link.patch, git(f.workspace, 'diff', '--cached', '--no-color', '--', 'leak'));
  assert.doesNotMatch(link.patch, /top secret/);
});

test('detached HEAD, a repository with no commit yet, and a base with no history in common', { skip: !hasGit }, async t => {
  const f = await setup(t, { workspace: featureRepository }), project = f.project(), url = `/api/v2/projects/${project.id}/git`;
  // Detached: the target is the short commit id.
  const head = git(f.workspace, 'rev-parse', 'HEAD').trim();
  git(f.workspace, 'stash', '-q', '--include-untracked'); git(f.workspace, 'checkout', '-q', '--detach', 'HEAD');
  const detached = (await f.call('GET', `${url}/compare`)).body;
  assert.deepEqual([detached.base, detached.target, detached.files.map(row => row.path)], ['main', { kind: 'detached', label: head.slice(0, 7) }, ['committed.txt']]);
  assert.equal((await f.call('GET', `${url}/branches`)).body.current, null);
  // No common history: an orphan branch.
  git(f.workspace, 'checkout', '-q', '--orphan', 'lone'); git(f.workspace, 'rm', '-rq', '--cached', '.'); git(f.workspace, 'clean', '-fdq');
  write(f.workspace, 'z.txt', 'z\n'); git(f.workspace, 'add', 'z.txt'); git(f.workspace, 'commit', '-q', '-m', 'lone');
  const unrelated = await f.call('GET', `${url}/compare?mode=all&base=main`);
  assert.deepEqual([unrelated.status, unrelated.body.code], [409, 'no_common_history']); assert.match(unrelated.body.error, /main/);
  assert.equal((await f.call('GET', `${url}/compare?mode=uncommitted`)).status, 200, 'uncommitted needs no base');

  // Before the first commit: everything starts from the empty tree.
  const fresh = join(f.directory, 'fresh'); mkdirSync(fresh); git(fresh, 'init', '-q');
  write(fresh, 'staged.txt', 'staged\n'); git(fresh, 'add', 'staged.txt'); write(fresh, 'loose.txt', 'loose\nlines\n');
  const initial = f.project(fresh, 'Fresh'), freshUrl = `/api/v2/projects/${initial.id}/git`;
  for (const mode of ['all', 'uncommitted']) {
    const body = (await f.call('GET', `${freshUrl}/compare?mode=${mode}`)).body;
    assert.deepEqual([body.base, body.defaultBase, body.mergeBase, body.target], [null, null, null, { kind: 'branch', label: 'main' }], mode);
    assert.deepEqual(body.files, [{ path: 'loose.txt', status: '?', added: 2, removed: 0, untracked: true }, { path: 'staged.txt', status: 'A', added: 1, removed: 0 }], mode);
  }
  assert.deepEqual((await f.call('GET', `${freshUrl}/branches`)).body, { repo: 'main', current: 'main', default: null, branches: [] });
  const patches = (await f.call('GET', `${freshUrl}/patches?${query([['base', 'HEAD'], ['path', ['staged.txt', 'loose.txt']]])}`)).body.patches;
  assert.match(patches[0].diff.patch, /^new file mode 100644$/m); assert.match(patches[0].diff.patch, /^\+staged$/m);
  assert.equal(patches[1].diff.patch, noIndex(fresh, 'loose.txt'));
});

test('branches: local branches only, upstream, worktree, commit time and the default branch in its order of preference', { skip: !hasGit }, async t => {
  const started = Math.floor(Date.now() / 1000) * 1000;
  const f = await setup(t, { workspace: (root, directory) => {
    const origin = join(directory, 'origin.git'); git(directory, 'init', '-q', '--bare', origin);
    git(root, 'init', '-q'); write(root, 'a.txt', 'a\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'a');
    git(root, 'branch', 'trunk'); git(root, 'remote', 'add', 'origin', origin); git(root, 'push', '-q', '-u', 'origin', 'main', 'trunk');
    git(root, 'worktree', 'add', '-q', join(directory, 'side'), '-b', 'rna/side');
    git(root, 'tag', 'v1');
  } });
  const project = f.project(), url = `/api/v2/projects/${project.id}/git`, side = join(f.directory, 'side');
  const body = (await f.call('GET', `${url}/branches`)).body;
  assert.deepEqual([body.repo, body.current, body.default], ['main', 'main', 'main']);
  assert.deepEqual(body.branches.map(row => [row.name, row.upstream, row.worktreePath, row.current]), [['main', 'origin/main', f.workspace, true], ['rna/side', null, side, false], ['trunk', 'origin/trunk', null, false]]);
  for (const row of body.branches) { assert.match(row.sha, /^[0-9a-f]{40}$/); assert.ok(row.committedAt >= started - 1000 && row.committedAt <= Date.now() + 1000, String(row.committedAt)); }
  // origin's HEAD comes first, then init.defaultBranch, then main / master, then the current branch.
  git(f.workspace, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  assert.equal((await f.call('GET', `${url}/branches`)).body.default, 'trunk');
  git(f.workspace, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'); git(f.workspace, 'config', 'init.defaultBranch', 'trunk');
  assert.equal((await f.call('GET', `${url}/branches`)).body.default, 'trunk');
  git(f.workspace, 'config', 'init.defaultBranch', 'missing');
  assert.equal((await f.call('GET', `${url}/branches`)).body.default, 'main');
  git(f.workspace, 'branch', '-m', 'main', 'work');
  assert.deepEqual([(await f.call('GET', `${url}/branches`)).body.default, (await f.call('GET', `${url}/compare`)).body.target], ['work', { kind: 'working-tree', label: 'work' }], 'no main or master: the current branch');
  // Seen from the other worktree: its own current branch.
  const seen = (await f.call('GET', `${url}/branches?worktree=${encodeURIComponent(side)}`)).body;
  assert.deepEqual([seen.repo, seen.current, seen.branches.find(row => row.current).name], ['linked', 'rna/side', 'rna/side']);
  // Worktrees say whether Rna made them and for which conversation (none yet).
  const worktrees = (await f.call('GET', `${url}/worktrees`)).body.worktrees;
  assert.deepEqual(worktrees.map(row => [row.branch, row.rna, row.owner]), [['work', false, null], ['rna/side', false, null]]);
  // A folder that is no repository, and one that is gone.
  mkdirSync(join(f.directory, 'plain')); mkdirSync(join(f.directory, 'gone'));
  const none = f.project(join(f.directory, 'plain'), 'None'), missing = f.project(join(f.directory, 'gone'), 'Gone');
  rmSync(join(f.directory, 'gone'), { recursive: true });
  assert.deepEqual((await f.call('GET', `/api/v2/projects/${none.id}/git/branches`)).body, { repo: 'none', current: null, default: null, branches: [] });
  assert.deepEqual((await f.call('GET', `/api/v2/projects/${none.id}/git/compare`)).body, { repo: 'none', mode: 'all', base: null, defaultBase: null, mergeBase: null, target: null, files: [], truncated: false, operation: null });
  assert.equal((await f.call('GET', `/api/v2/projects/${none.id}/git/patches?base=HEAD&path=a.txt`)).body.patches[0].diff.kind, 'unavailable');
  assert.equal((await f.call('GET', `/api/v2/projects/${missing.id}/git/compare`)).body.unavailable, 'workspace_missing');
});

test('another worktree of the repository can be read, never written, and only one git lists for this repository', { skip: !hasGit }, async t => {
  const f = await setup(t, { workspace: (root, directory) => {
    git(root, 'init', '-q'); write(root, 'app/a.txt', 'a\n'); write(root, 'app/b.txt', 'b\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'a');
    git(root, 'worktree', 'add', '-q', join(directory, 'linked'), '-b', 'rna/linked');
    git(root, 'worktree', 'add', '-q', join(directory, 'doomed'), '-b', 'rna/doomed');
    write(join(directory, 'linked'), 'app/a.txt', 'a\nlinked edit\n'); write(join(directory, 'linked'), 'app/new.txt', 'new\n'); write(join(directory, 'linked'), 'top.txt', 'outside the project folder\n');
    write(root, 'app/b.txt', 'b\nproject edit\n');
    // Another repository, a link to it, and a link to the linked worktree.
    const other = join(directory, 'other'); mkdirSync(other); git(other, 'init', '-q'); mkdirSync(join(other, 'app')); write(other, 'app/secret.txt', 'secret\n');
    symlinkSync(join(directory, 'linked'), join(directory, 'via-link'));
  } });
  const project = f.project(join(f.workspace, 'app'), 'App'), url = `/api/v2/projects/${project.id}/git`, linked = join(f.directory, 'linked');
  const at = (path, worktree, extra = []) => f.call('GET', `${url}${path}?${query([['worktree', worktree], ...extra])}`);
  // The project folder's place inside the other worktree: paths stay relative to it, the rest is left out.
  const compared = (await at('/compare', linked, [['mode', 'all']])).body;
  assert.deepEqual([compared.repo, compared.base, compared.target], ['linked', 'main', { kind: 'branch', label: 'rna/linked' }]);
  assert.deepEqual(compared.files.map(row => [row.path, row.status]), [['a.txt', 'M'], ['new.txt', '?']]);
  assert.deepEqual((await at('', linked)).body.files.unstaged.map(row => row.path), ['a.txt']);
  assert.match((await at('/diff', linked, [['source', 'unstaged'], ['path', 'a.txt']])).body.patch, /^\+linked edit$/m);
  const patch = (await at('/patches', linked, [['base', compared.mergeBase], ['path', ['a.txt', 'new.txt']]])).body.patches;
  assert.match(patch[0].diff.patch, /^\+linked edit$/m); assert.equal(patch[1].diff.patch, noIndex(join(linked, 'app'), 'new.txt'));
  // Named through a link it is the same worktree; the project's own folder is the project.
  assert.deepEqual((await at('/compare', join(f.directory, 'via-link'))).body.files, compared.files);
  assert.deepEqual((await at('/compare', f.workspace)).body.files.map(row => row.path), ['b.txt']);
  // Refused: a relative path, a folder git doesn't list for this repository, a path inside a worktree, another repository.
  assert.deepEqual([(await at('/compare', 'linked')).status, (await at('/compare', 'linked')).body.code], [400, 'git_worktree_invalid']);
  for (const path of [join(f.directory, 'other'), join(linked, 'app'), '/', join(f.directory, 'nowhere')]) {
    const refused = await at('/compare', path);
    assert.deepEqual([refused.status, refused.body.code], [403, 'git_worktree_denied'], path);
    assert.equal((await at('', path)).status, 403, path);
  }
  // A listed worktree swapped for a link to another repository is refused, though both sides resolve alike.
  const doomed = join(f.directory, 'doomed');
  rmSync(doomed, { recursive: true, force: true }); symlinkSync(join(f.directory, 'other'), doomed);
  for (const path of [doomed, join(f.directory, 'other')]) assert.deepEqual([(await at('/compare', path)).status, (await at('/patches', path, [['base', 'HEAD'], ['path', 'secret.txt']])).status], [403, 403], path);
  // A listed worktree whose folder is gone reads as a missing folder; a write naming it is still one to another worktree.
  rmSync(doomed);
  const gone = (await at('/compare', doomed)).body;
  assert.deepEqual([gone.repo, gone.unavailable], ['none', 'workspace_missing']);
  const goneWrite = await f.call('POST', `${url}/stage?${query([['worktree', doomed]])}`, { paths: ['a.txt'] });
  assert.deepEqual([goneWrite.status, goneWrite.body.code], [403, 'git_worktree_read_only']);
  // Writes act on the project folder only.
  for (const action of ['stage', 'unstage', 'discard']) {
    const refused = await f.call('POST', `${url}/${action}?${query([['worktree', linked]])}`, { paths: ['a.txt'] });
    assert.deepEqual([refused.status, refused.body.code], [403, 'git_worktree_read_only'], action);
  }
  assert.equal(git(linked, 'diff', '--cached', '--name-only'), '', 'nothing was staged in the other worktree');
  const own = await f.call('POST', `${url}/stage?${query([['worktree', f.workspace]])}`, { paths: ['b.txt'] });
  assert.equal(own.status, 200, JSON.stringify(own.body)); assert.deepEqual(own.body.staged, ['b.txt']);
});

test('requests that would reach past the comparison are refused before git sees them', { skip: !hasGit }, async t => {
  const f = await setup(t, { workspace: featureRepository }), project = f.project(), url = `/api/v2/projects/${project.id}/git`;
  const mergeBase = git(f.workspace, 'merge-base', 'main', 'HEAD').trim();
  for (const base of ['--output=x', 'nope', 'origin/main', 'HEAD~1', 'v1']) {
    const refused = await f.call('GET', `${url}/compare?${query([['mode', 'all'], ['base', base]])}`);
    assert.deepEqual([refused.status, refused.body.code], [404, 'git_base_not_found'], base);
  }
  assert.equal(existsSync(join(f.workspace, 'x')), false, 'no option reached git');
  assert.deepEqual([(await f.call('GET', `${url}/compare?mode=everything`)).status, (await f.call('GET', `${url}/compare?mode=everything`)).body.code], [400, 'git_mode_invalid']);
  for (const base of ['--output=x', 'main', 'HEAD~1', mergeBase.slice(0, 12), `${mergeBase}^{tree}`, '']) {
    for (const path of ['patches', 'diff']) {
      const refused = await f.call('GET', `${url}/${path}?${query([['source', 'compare'], ['base', base], ['path', 'a.txt']])}`);
      assert.deepEqual([refused.status, refused.body.code], [400, 'git_base_invalid'], `${path} ${base}`);
    }
  }
  const missing = await f.call('GET', `${url}/patches?${query([['base', 'f'.repeat(40)], ['path', 'a.txt']])}`);
  assert.deepEqual([missing.status, missing.body.code], [404, 'git_base_not_found']);
  const tree = git(f.workspace, 'rev-parse', `${mergeBase}^{tree}`).trim();
  assert.equal((await f.call('GET', `${url}/patches?${query([['base', tree], ['path', 'a.txt']])}`)).body.code, 'git_base_not_found', 'a tree is not a commit');
  // Paths: 1–40 per batch, inside the folder.
  const many = Array.from({ length: 41 }, (_, index) => `f${index}.txt`);
  assert.deepEqual([(await f.call('GET', `${url}/patches?${query([['base', mergeBase], ['path', many]])}`)).body.code, (await f.call('GET', `${url}/patches?base=${mergeBase}`)).body.code], ['git_paths_invalid', 'git_paths_invalid']);
  for (const path of ['../outside.txt', '-p', '.git/config', '/etc/passwd']) {
    assert.equal((await f.call('GET', `${url}/patches?${query([['base', mergeBase], ['path', path]])}`)).status, 403, path);
    assert.equal((await f.call('GET', `${url}/patches?${query([['base', mergeBase], ['path', 'a.txt'], ['oldPath', path]])}`)).status, 403, `old ${path}`);
    assert.equal((await f.call('GET', `${url}/diff?${query([['source', 'compare'], ['base', mergeBase], ['path', path]])}`)).status, 403, path);
  }
  assert.equal((await f.call('GET', `${url}/diff?${query([['source', 'compare'], ['base', mergeBase], ['path', 'a.txt'], ['context', '5']])}`)).body.code, 'git_context_invalid');
  assert.equal((await f.call('GET', '/api/v2/projects/nope/git/compare')).status, 404);
});

test('reading the comparison takes no lock and never rewrites the index', { skip: !hasGit }, async t => {
  const f = await setup(t, { workspace: featureRepository }), project = f.project(), index = join(f.workspace, '.git', 'index');
  // Timestamps moved on unchanged tracked files: a plain `git diff` would rewrite the index under index.lock to record them.
  const later = new Date(Date.now() + 60000);
  for (const path of ['committed.txt', 'staged.txt', 'new name.txt']) utimesSync(join(f.workspace, path), later, later);
  const before = statSync(index).mtimeMs, { compare, runs } = recorded(f.app.store);
  const first = compare.compare(project.id, { mode: 'all' });
  assert.equal(compare.compare(project.id, { mode: 'all', base: '' }), first, 'the same comparison asked twice at once runs once');
  const listing = await first;
  await compare.compare(project.id, { mode: 'uncommitted' });
  await compare.branches(project.id);
  await compare.patches(project.id, { base: listing.mergeBase, paths: listing.files.map(row => row.path) });
  await compare.diff(project.id, { base: 'HEAD', path: 'committed.txt', context: 'all' });
  assert.equal(statSync(index).mtimeMs, before, 'the index was not rewritten by a read');
  assert.equal(existsSync(`${index}.lock`), false);
  const commands = new Set(runs.map(args => args.find(arg => !arg.startsWith('-') && !arg.includes('='))));
  for (const command of commands) assert.ok(['diff', 'ls-files', 'for-each-ref', 'symbolic-ref', 'config', 'rev-parse', 'merge-base', 'cat-file', 'hash-object'].includes(command), command);
});

test('expanding a file shows it whole, and a patch batch past its cap is marked file by file', { skip: !hasGit }, async t => {
  const lines = Array.from({ length: 60 }, (_, index) => `line ${index}`);
  const f = await setup(t, { workspace: root => {
    git(root, 'init', '-q'); write(root, 'long.txt', `${lines.join('\n')}\n`);
    for (const name of ['p1.txt', 'p2.txt', 'p3.txt']) write(root, name, `${'x'.repeat(40)}\n`.repeat(20));
    git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'a');
    write(root, 'long.txt', `${lines.map((line, index) => (index === 30 ? 'changed' : line)).join('\n')}\n`);
    for (const name of ['p1.txt', 'p2.txt', 'p3.txt']) write(root, name, `${'y'.repeat(40)}\n`.repeat(20));
    write(root, 'u1.txt', `${'u'.repeat(40)}\n`.repeat(20)); write(root, 'u2.bin', Buffer.concat([BINARY, Buffer.alloc(5000, 66)]));
  } });
  const project = f.project(), url = `/api/v2/projects/${project.id}/git`;
  const short = (await f.call('GET', `${url}/diff?source=compare&base=HEAD&path=long.txt`)).body;
  const whole = (await f.call('GET', `${url}/diff?source=compare&base=HEAD&path=long.txt&context=all`)).body;
  assert.doesNotMatch(short.patch, /^ line 0$/m); assert.match(whole.patch, /^ line 0$/m); assert.match(whole.patch, /^ line 59$/m); assert.match(whole.patch, /^\+changed$/m);
  assert.match((await f.call('GET', `${url}/diff?source=unstaged&path=long.txt&context=all`)).body.patch, /^ line 0$/m, 'the other sources expand too');
  // A 2 KB cap: p1 fits, p2 is cut on whole lines, p3 never came, and the untracked text file has no room left; a
  // binary one takes no room, so it still comes.
  const compare = new WorkspaceGitCompare(new WorkspaceGitService(f.app.store, { diffMaxBytes: 2048 }));
  const { patches } = await compare.patches(project.id, { base: 'HEAD', paths: ['p1.txt', 'p2.txt', 'p3.txt', 'u1.txt', 'u2.bin'] });
  const kinds = patches.map(row => [row.path, row.diff.kind, row.diff.reason ?? null]);
  assert.deepEqual(kinds, [['p1.txt', 'patch', null], ['p2.txt', 'truncated', null], ['p3.txt', 'unavailable', 'batch_too_large'], ['u1.txt', 'unavailable', 'batch_too_large'], ['u2.bin', 'binary', null]]);
  assert.ok(patches[1].diff.patch.endsWith('\n')); assert.ok(patches[2].diff.message);
  // Alone, each file comes back, cut at the cap when it is bigger.
  const alone = (await compare.patches(project.id, { base: 'HEAD', paths: ['u1.txt'] })).patches[0].diff;
  assert.equal(alone.kind, 'patch');
  const big = new WorkspaceGitCompare(new WorkspaceGitService(f.app.store, { diffMaxBytes: 300 }));
  const cut = (await big.patches(project.id, { base: 'HEAD', paths: ['u1.txt'] })).patches[0].diff;
  assert.equal(cut.kind, 'truncated'); assert.ok(cut.patch.endsWith('\n')); assert.doesNotMatch(cut.patch, /^index /m);
  assert.equal(cut.patch.split('\n').filter(line => line.startsWith('+u')).length, 7, 'the whole lines of the first 300 bytes (41 each)');
});

test('untracked files past 1 MB, binary ones, a counting budget and a listing past its cap', { skip: !hasGit }, async t => {
  const f = await setup(t, { workspace: root => {
    git(root, 'init', '-q'); write(root, 'a.txt', 'a\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'a');
    write(root, 'huge.log', 'line\n'.repeat(260000)); write(root, 'huge.bin', Buffer.concat([Buffer.from([0]), Buffer.alloc(1100000, 65)]));
    write(root, 'small.txt', 'one\ntwo\n');
    const nested = join(root, 'inner'); mkdirSync(nested); git(nested, 'init', '-q'); write(nested, 'x.txt', 'x\n');
  } });
  const project = f.project(), compare = new WorkspaceGitCompare(new WorkspaceGitService(f.app.store));
  const files = (await compare.compare(project.id, { mode: 'uncommitted' })).files;
  assert.deepEqual(files, [
    { path: 'huge.bin', status: '?', added: null, removed: null, binary: true, untracked: true },
    { path: 'huge.log', status: '?', added: null, removed: 0, untracked: true },
    { path: 'inner/', status: '?', added: null, removed: null, untracked: true },
    { path: 'small.txt', status: '?', added: 2, removed: 0, untracked: true },
  ]);
  assert.equal(compare.counts.size, 3, 'counts are remembered');
  const nested = (await compare.patches(project.id, { base: 'HEAD', paths: ['inner/'] })).patches[0].diff;
  assert.deepEqual([nested.kind, nested.reason], ['unavailable', 'repository']);
  // Past the counting budget, the rest are listed without counts.
  const thrifty = new WorkspaceGitCompare(new WorkspaceGitService(f.app.store), { countBudget: 8000 });
  assert.deepEqual((await thrifty.compare(project.id, { mode: 'uncommitted' })).files.map(row => [row.path, row.added]), [['huge.bin', null], ['huge.log', null], ['inner/', null], ['small.txt', null]]);
  // Past the file cap the listing is cut and says so.
  const capped = await new WorkspaceGitCompare(new WorkspaceGitService(f.app.store), { maxFiles: 2 }).compare(project.id, { mode: 'uncommitted' });
  assert.deepEqual([capped.truncated, capped.files.length], [true, 2]);
  // A tracked listing past the output cap keeps whole records only.
  for (let index = 0; index < 60; index++) write(f.workspace, `generated/file-${String(index).padStart(3, '0')}-with-a-long-name.txt`, 'x');
  git(f.workspace, 'add', 'generated');
  const tight = await new WorkspaceGitCompare(new WorkspaceGitService(f.app.store, { statusMaxBytes: 1024 })).compare(project.id, { mode: 'uncommitted' });
  assert.equal(tight.truncated, true);
  assert.ok(tight.files.filter(row => row.path.startsWith('generated/')).every(row => /^generated\/file-\d{3}-with-a-long-name\.txt$/.test(row.path) && row.status === 'A'));
  // The repository's own status.showUntrackedFiles=no hides untracked files here too.
  git(f.workspace, 'config', 'status.showUntrackedFiles', 'no');
  assert.equal((await compare.compare(project.id, { mode: 'uncommitted' })).files.some(row => row.untracked), false);
});

test('files whose timestamps moved but whose content did not are no change, text or binary; real edits stay', { skip: !hasGit }, async t => {
  const f = await setup(t, { workspace: root => {
    git(root, 'init', '-q');
    for (const name of ['touched.txt', 'edited.txt', 'back.txt', 'mode.sh']) write(root, name, `${name}\n`);
    for (const name of ['touched.bin', 'edited.bin', 'back.bin']) write(root, name, BINARY);
    git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'a');
    // Staged, then put back in the working tree: base → working tree has nothing to show for these two.
    write(root, 'back.txt', 'staged\n'); write(root, 'back.bin', Buffer.concat([BINARY, BINARY])); git(root, 'add', '-A');
    write(root, 'back.txt', 'back.txt\n'); write(root, 'back.bin', BINARY);
    const later = new Date(Date.now() + 60000);
    for (const name of ['touched.txt', 'touched.bin']) utimesSync(join(root, name), later, later);
    write(root, 'edited.txt', 'edited.txt\nmore\n'); write(root, 'edited.bin', Buffer.concat([BINARY, Buffer.from([9])])); chmodSync(join(root, 'mode.sh'), 0o755);
  } });
  const project = f.project(), index = join(f.workspace, '.git', 'index'), before = statSync(index).mtimeMs;
  const { compare, service } = recorded(f.app.store);
  const listed = (await compare.compare(project.id, { mode: 'uncommitted' })).files;
  assert.deepEqual(listed, [
    { added: null, removed: null, path: 'edited.bin', status: 'M', binary: true },
    { added: 1, removed: 0, path: 'edited.txt', status: 'M' },
    { added: 0, removed: 0, path: 'mode.sh', status: 'M' },
  ]);
  // The upstream view reads the same listing.
  assert.deepEqual((await service.changedFiles(f.workspace, 'HEAD')).files.map(row => row.path), ['edited.bin', 'edited.txt', 'mode.sh']);
  assert.equal(statSync(index).mtimeMs, before, 'checking content did not refresh the index');
  assert.equal(existsSync(`${index}.lock`), false);
});

test('conflicted files are U in both modes, also one whose working copy matches the start', { skip: !hasGit }, async t => {
  const f = await setup(t, { workspace: root => {
    git(root, 'init', '-q');
    write(root, 'both.txt', 'base\n'); write(root, 'ours-kept.txt', 'base\n'); write(root, 'theirs-kept.txt', 'base\n'); write(root, 'calm.txt', 'calm\n');
    git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
    git(root, 'checkout', '-q', '-b', 'side');
    write(root, 'both.txt', 'side\n'); git(root, 'rm', '-q', 'ours-kept.txt'); write(root, 'theirs-kept.txt', 'side\n'); write(root, 'added.txt', 'side\n');
    git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'side');
    git(root, 'checkout', '-q', 'main'); git(root, 'checkout', '-q', '-b', 'rna/work');
    write(root, 'both.txt', 'work\n'); write(root, 'ours-kept.txt', 'work\n'); git(root, 'rm', '-q', 'theirs-kept.txt'); write(root, 'added.txt', 'work\n');
    git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'work');
    spawnSync('git', ['-c', 'user.name=Rna', '-c', 'user.email=rna@localhost', 'merge', 'side'], { cwd: root, env: gitEnv() });
    write(root, 'calm.txt', 'calm\nedit\n');
  } });
  const project = f.project(), url = `/api/v2/projects/${project.id}/git`;
  for (const mode of ['uncommitted', 'all']) {
    const body = (await f.call('GET', `${url}/compare?mode=${mode}`)).body;
    assert.equal(body.operation, 'merge', mode);
    const rows = Object.fromEntries(body.files.map(row => [row.path, row.status]));
    // `ours-kept.txt` (changed here, deleted there) still holds this branch's text: `git diff HEAD` has nothing for it.
    assert.deepEqual(rows, { 'added.txt': 'U', 'both.txt': 'U', 'calm.txt': 'M', 'ours-kept.txt': 'U', 'theirs-kept.txt': 'U' }, mode);
  }
  const head = (await f.call('GET', `${url}/patches?${query([['base', 'HEAD'], ['path', ['both.txt', 'ours-kept.txt']]])}`)).body.patches;
  assert.match(head[0].diff.patch, /^\+<<<<<<< HEAD$/m);
  assert.deepEqual(head[1].diff, { kind: 'patch', patch: '' });
  assert.deepEqual([...parseUnmerged('100644 a 1\tx y\x00100644 b 2\tx y\x00100644 c 3\tnew\nline\x00')], ['x y', 'new\nline']);
});

test('a batch whose git diff stopped early never passes off its last section as whole; a failed listing is not "no change"', { skip: !hasGit }, async t => {
  const f = await setup(t, { workspace: root => {
    git(root, 'init', '-q'); for (const name of ['a.txt', 'b.txt', 'c.txt']) write(root, name, 'one\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'a');
    for (const name of ['a.txt', 'b.txt', 'c.txt']) write(root, name, 'one\ntwo\n');
    // Prefix settings the batch overrides: sections are still found by name.
    git(root, 'config', 'diff.noprefix', 'true'); git(root, 'config', 'diff.mnemonicPrefix', 'true');
  } });
  const project = f.project(), service = new WorkspaceGitService(f.app.store), compare = new WorkspaceGitCompare(service), run = service.run.bind(service);
  const whole = (await compare.patches(project.id, { base: 'HEAD', paths: ['a.txt', 'b.txt', 'c.txt'] })).patches;
  assert.deepEqual(whole.map(row => [row.path, row.diff.kind]), [['a.txt', 'patch'], ['b.txt', 'patch'], ['c.txt', 'patch']]);
  assert.match(whole[1].diff.patch, /^diff --git a\/b\.txt b\/b\.txt$/m);
  // The time limit (or a failure) hit while b.txt was being written: a.txt is whole, b.txt and c.txt are not known.
  const cutAt = whole[0].diff.patch + whole[1].diff.patch.slice(0, whole[1].diff.patch.indexOf('@@'));
  for (const [stop, reason] of [[{ code: null, timedOut: true }, 'timed_out'], [{ code: 128, timedOut: false }, 'git_failed']]) {
    service.run = (cwd, args, more) => (args.includes('--src-prefix=a/') ? Promise.resolve({ stdout: cutAt, stderr: '', truncated: false, ...stop }) : run(cwd, args, more));
    const { patches } = await compare.patches(project.id, { base: 'HEAD', paths: ['a.txt', 'b.txt', 'c.txt'] });
    assert.deepEqual(patches.map(row => [row.path, row.diff.kind, row.diff.reason ?? null]), [['a.txt', 'patch', null], ['b.txt', 'unavailable', reason], ['c.txt', 'unavailable', reason]], reason);
  }
  // The untracked listing failed: a path git's diff said nothing about is unknown, not unchanged.
  write(f.workspace, 'new.txt', 'new\n');
  service.run = (cwd, args, more) => (args.includes('--others') ? Promise.resolve({ code: 128, stdout: '', stderr: '', truncated: false, timedOut: false }) : run(cwd, args, more));
  const { patches } = await compare.patches(project.id, { base: 'HEAD', paths: ['a.txt', 'new.txt'] });
  assert.deepEqual(patches.map(row => [row.path, row.diff.kind, row.diff.reason ?? null]), [['a.txt', 'patch', null], ['new.txt', 'unavailable', 'git_failed']]);
});
