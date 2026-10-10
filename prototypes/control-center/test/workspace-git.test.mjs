import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../server.mjs';
import { changeMaintenance, initialMaintenance, persistMaintenance } from '../application-maintenance-state.mjs';
import { WorkspaceGitService, parseNameStatus, parseNumstat, parseStatus, parseWorktrees, resolveGitOnPath } from '../workspace-git-service.mjs';

// Temporary repositories only; the user's own git configuration never shapes these results.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const gitEnv = () => { const env = { ...process.env, LC_ALL: 'C' }; for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/.test(key)) delete env[key]; return env; };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Rna', '-c', 'user.email=rna@localhost', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (root, path, content) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); };
const BINARY = Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]);

/** A repository with every kind of change: an edit, a deletion, a binary edit, a staged new file, a staged rename and an untracked file. */
function richRepository(root) {
  git(root, 'init', '-q');
  write(root, 'a.txt', 'one\ntwo\nthree\n'); write(root, 'keep.txt', 'keep\n'); write(root, 'old name.txt', 'moving\nfile\n'); write(root, 'bin.dat', BINARY); write(root, 'docs/guide.md', '# Guide\n');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'first');
  write(root, 'a.txt', 'one\nTWO\nthree\nfour\n');
  rmSync(join(root, 'keep.txt'));
  write(root, 'bin.dat', Buffer.concat([BINARY, BINARY]));
  write(root, 'staged.txt', 'new\n'); git(root, 'add', 'staged.txt');
  git(root, 'mv', 'old name.txt', 'new name.txt');
  write(root, 'notes/u.txt', 'untracked\nlines\n');
}

async function setup(t, { workspace: makeWorkspace } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'rna-git-'))), workspace = join(directory, 'workspace');
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
const byPath = rows => Object.fromEntries(rows.map(row => [row.path, row]));

test('porcelain v2, numstat and worktree parsing keep spaces, renames, binaries and the workspace prefix', () => {
  const status = ['# branch.oid abc', '# branch.head feature/x', '# branch.upstream origin/feature/x', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 h1 h1 sub/with space.txt', '2 R. N... 100644 100644 100644 h1 h1 R100 sub/new.txt', 'sub/old.txt',
    'u UU N... 100644 100644 100644 100644 h1 h2 h3 sub/c.txt', '? sub/dir/', '? outside.txt', ''].join('\0');
  const parsed = parseStatus(status, 'sub/');
  assert.deepEqual([parsed.branch, parsed.detached, parsed.upstream, parsed.ahead, parsed.behind], ['feature/x', false, 'origin/feature/x', 2, 1]);
  assert.deepEqual(parsed.unstaged, [{ path: 'with space.txt', status: 'M', added: null, removed: null }]);
  assert.deepEqual(parsed.staged, [{ path: 'new.txt', oldPath: 'old.txt', status: 'R', added: null, removed: null }]);
  assert.deepEqual(parsed.conflicted.map(row => [row.path, row.status]), [['c.txt', 'U']]);
  assert.deepEqual(parsed.untracked.map(row => row.path), ['dir/'], 'paths outside the workspace folder are dropped');
  // Renames across the workspace folder's edge: moved in reads as new, moved out as removed.
  const across = parseStatus(['2 R. N... 100644 100644 100644 h1 h1 R100 sub/in.txt', 'other/in.txt', '2 R. N... 100644 100644 100644 h1 h1 R100 other/out.txt', 'sub/out.txt', ''].join('\0'), 'sub/');
  assert.deepEqual(across.staged, [{ path: 'in.txt', status: 'A', added: null, removed: null }, { path: 'out.txt', status: 'D', added: null, removed: null }]);
  assert.equal(parseStatus('# branch.oid (initial)\0# branch.head (detached)\0').detached, true);
  // A changed submodule is an unstaged change like any other, and is also named as a submodule.
  const submodule = parseStatus(['1 .M S.M. 160000 160000 160000 h1 h1 sub/lib', '1 .M N... 100644 100644 100644 h1 h1 sub/a.txt', ''].join('\0'), 'sub/');
  assert.deepEqual([submodule.unstaged.map(row => row.path), submodule.submodules], [['lib', 'a.txt'], ['lib']]);
  const counts = parseNumstat('3\t1\ta.txt\0-\t-\tbin.dat\0' + '2\t0\t\0old.txt\0new.txt\0');
  assert.deepEqual(counts.get('a.txt'), { added: 3, removed: 1 });
  assert.deepEqual(counts.get('bin.dat'), { added: null, removed: null, binary: true });
  assert.deepEqual(counts.get('new.txt'), { added: 2, removed: 0 });
  assert.deepEqual(parseNameStatus('M\0a.txt\0R087\0old.txt\0new.txt\0D\0gone.txt\0'), [{ path: 'a.txt', status: 'M' }, { path: 'new.txt', oldPath: 'old.txt', status: 'R' }, { path: 'gone.txt', status: 'D' }]);
  const worktrees = parseWorktrees('worktree /r\nHEAD 1\nbranch refs/heads/main\n\nworktree /w\nHEAD 2\ndetached\nlocked moving\nprunable gitdir file points to non-existent location\n\n');
  assert.deepEqual(worktrees.map(row => [row.path, row.branch, row.detached, row.locked, row.lockedReason ?? null, row.prunable]), [['/r', 'main', false, false, null, false], ['/w', null, true, true, 'moving', true]]);
});

test('a repository reads as conflicted / staged / unstaged / untracked with line counts, and each file diffs', async t => {
  const f = await setup(t, { workspace: richRepository }), project = f.project();
  const status = await f.call('GET', `/api/v2/projects/${project.id}/git`);
  assert.equal(status.status, 200, JSON.stringify(status.body));
  const body = status.body;
  assert.deepEqual([body.repo, body.branch, body.detached, body.upstream, body.ahead, body.behind, body.operation, body.initial, body.untrackedMode], ['main', 'main', false, null, 0, 0, null, false, 'all']);
  assert.equal(body.unavailable, undefined); assert.equal(body.truncated, undefined);
  const staged = byPath(body.files.staged), unstaged = byPath(body.files.unstaged);
  assert.deepEqual(staged['staged.txt'], { path: 'staged.txt', status: 'A', added: 1, removed: 0 });
  assert.deepEqual(staged['new name.txt'], { path: 'new name.txt', oldPath: 'old name.txt', status: 'R', added: 0, removed: 0 });
  assert.deepEqual(unstaged['a.txt'], { path: 'a.txt', status: 'M', added: 2, removed: 1 });
  assert.deepEqual(unstaged['keep.txt'], { path: 'keep.txt', status: 'D', added: 0, removed: 1 });
  assert.deepEqual(unstaged['bin.dat'], { path: 'bin.dat', status: 'M', added: null, removed: null, binary: true });
  assert.deepEqual(body.files.untracked, [{ path: 'notes/u.txt', status: '?', added: null, removed: null }]);
  assert.deepEqual(body.files.conflicted, []);

  const diff = (source, path, extra = '') => f.call('GET', `/api/v2/projects/${project.id}/git/diff?source=${source}&path=${encodeURIComponent(path)}${extra}`);
  const edit = await diff('unstaged', 'a.txt');
  assert.equal(edit.body.kind, 'patch'); assert.match(edit.body.patch, /^-two$/m); assert.match(edit.body.patch, /^\+TWO$/m); assert.match(edit.body.patch, /^\+four$/m);
  assert.equal((await diff('unstaged', 'bin.dat')).body.kind, 'binary');
  assert.match((await diff('staged', 'staged.txt')).body.patch, /^\+new$/m);
  assert.match((await diff('staged', 'new name.txt', `&oldPath=${encodeURIComponent('old name.txt')}`)).body.patch, /rename from old name\.txt/);
  const untracked = await diff('unstaged', 'notes/u.txt');
  assert.equal(untracked.body.kind, 'patch', 'an untracked file shows whole'); assert.match(untracked.body.patch, /^\+untracked$/m);
  assert.equal((await diff('upstream', 'a.txt')).body.kind, 'unavailable', 'no upstream yet');
  const bad = await diff('somewhere', 'a.txt');
  assert.equal(bad.status, 400); assert.equal(bad.body.code, 'git_source_invalid');
});

test('the workspace may be a folder inside the repository: paths are relative to it and changes elsewhere are left out', async t => {
  const f = await setup(t, { workspace: root => { richRepository(root); write(root, 'docs/guide.md', '# Guide\nmore\n'); write(root, 'docs/draft.md', 'draft\n'); } });
  const project = f.project(join(f.workspace, 'docs'), 'Docs');
  const body = (await f.call('GET', `/api/v2/projects/${project.id}/git`)).body;
  assert.equal(body.repo, 'main');
  assert.deepEqual(body.files.unstaged, [{ path: 'guide.md', status: 'M', added: 1, removed: 0 }]);
  assert.deepEqual(body.files.untracked.map(row => row.path), ['draft.md']);
  assert.deepEqual(body.files.staged, []);
  const staged = await f.call('POST', `/api/v2/projects/${project.id}/git/stage`, { paths: ['guide.md'] });
  assert.equal(staged.status, 200, JSON.stringify(staged.body));
  assert.deepEqual(staged.body.status.files.staged.map(row => row.path), ['guide.md']);
  assert.match(git(f.workspace, 'diff', '--cached', '--name-only'), /^docs\/guide\.md$/m);
});

test('a folder that is not a repository, and a missing folder, read as no repository', async t => {
  const f = await setup(t);
  const plain = f.project();
  const status = await f.call('GET', `/api/v2/projects/${plain.id}/git`);
  assert.equal(status.status, 200);
  assert.deepEqual({ repo: status.body.repo, unavailable: status.body.unavailable, files: status.body.files }, { repo: 'none', unavailable: undefined, files: { conflicted: [], staged: [], unstaged: [], untracked: [] } });
  assert.equal((await f.call('GET', `/api/v2/projects/${plain.id}/git/diff?source=unstaged&path=a.txt`)).body.kind, 'unavailable');
  assert.deepEqual((await f.call('GET', `/api/v2/projects/${plain.id}/git/worktrees`)).body, { repo: 'none', worktrees: [] });
  const stage = await f.call('POST', `/api/v2/projects/${plain.id}/git/stage`, { paths: ['a.txt'] });
  assert.equal(stage.status, 409); assert.equal(stage.body.code, 'git_unavailable');

  const gone = join(f.directory, 'gone'); mkdirSync(gone);
  const missing = f.project(gone, 'Gone'); rmSync(gone, { recursive: true });
  const read = await f.call('GET', `/api/v2/projects/${missing.id}/git`);
  assert.equal(read.status, 200);
  assert.equal(read.body.repo, 'none'); assert.equal(read.body.unavailable, 'workspace_missing'); assert.ok(read.body.message);
  assert.equal((await f.call('GET', '/api/v2/projects/nope/git')).status, 404);
});

test('a repository at the top of the home folder (dotfiles) is not the project’s: the folder reads as no repository', async t => {
  // The home folder kept in git, with untracked files hidden as such setups do; a project folder somewhere below it.
  const f = await setup(t, { workspace: home => {
    git(home, 'init', '-q'); git(home, 'config', 'status.showUntrackedFiles', 'no');
    write(home, '.bashrc', 'export A=1\n'); git(home, 'add', '-A'); git(home, 'commit', '-q', '-m', 'dotfiles'); write(home, '.bashrc', 'export A=2\n');
    write(home, 'projects/app/main.js', 'console.log(1)\n');
    const real = join(home, 'code', 'real'); mkdirSync(real, { recursive: true }); git(real, 'init', '-q'); write(real, 'new.txt', 'new\n'); write(real, 'pkg/inner.txt', 'inner\n');
  } });
  const home = f.workspace, link = join(f.directory, 'home-link'); symlinkSync(home, link);
  const app = f.project(join(home, 'projects', 'app'), 'App'), whole = f.project(home, 'Home'), real = f.project(join(home, 'code', 'real'), 'Real');
  const realPackage = f.project(join(home, 'code', 'real', 'pkg'), 'Package');
  // Without the home rule the project would sit in the dotfiles repository (its untracked files hidden by its setting).
  const elsewhere = await new WorkspaceGitService(f.app.store, { home: () => join(f.directory, 'someone-else') }).status(app.id);
  assert.deepEqual([elsewhere.repo, elsewhere.untrackedMode], ['main', 'no']);
  // The home folder named through a link is still the home folder.
  for (const service of [new WorkspaceGitService(f.app.store, { home: () => home }), new WorkspaceGitService(f.app.store, { home: () => link })]) {
    for (const project of [app, whole]) {
      const status = await service.status(project.id);
      assert.deepEqual({ repo: status.repo, unavailable: status.unavailable, files: status.files }, { repo: 'none', unavailable: undefined, files: { conflicted: [], staged: [], unstaged: [], untracked: [] } }, project.name);
    }
    assert.deepEqual(await service.worktrees(app.id), { repo: 'none', worktrees: [] });
    assert.equal((await service.diff(app.id, { source: 'unstaged', path: 'main.js' })).kind, 'unavailable');
    for (const action of ['stage', 'unstage', 'discard']) await assert.rejects(service[action](app.id, { paths: ['main.js'] }), error => error.status === 409 && error.code === 'git_unavailable', action);
    // A repository of its own below the home folder is read as usual, and so is a folder inside one.
    const own = await service.status(real.id);
    assert.deepEqual([own.repo, own.untrackedMode, own.files.untracked.map(row => row.path)], ['main', 'all', ['new.txt', 'pkg/inner.txt']]);
    const part = await service.status(realPackage.id);
    assert.deepEqual([part.repo, part.files.untracked.map(row => row.path)], ['main', ['inner.txt']]);
  }
  assert.equal(git(home, 'diff', '--cached', '--name-only'), '', 'nothing was staged in the home repository');
  // The routes use the daemon user's home folder.
  const saved = process.env.HOME;
  process.env.HOME = link;
  try { assert.equal((await f.call('GET', `/api/v2/projects/${app.id}/git`)).body.repo, 'none'); }
  finally { if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; }
});

test('status.showUntrackedFiles=no is honoured: untracked files are reported as not shown and never discarded', async t => {
  const f = await setup(t, { workspace: root => { richRepository(root); git(root, 'config', 'status.showUntrackedFiles', 'no'); } }), project = f.project();
  const service = new WorkspaceGitService(f.app.store), modes = [], run = service.run.bind(service);
  service.run = (cwd, args, options) => { const mode = args.find(arg => arg.startsWith('--untracked-files=')); if (args[0] === 'status' && mode) modes.push(mode.split('=')[1]); return run(cwd, args, options); };
  const status = await service.status(project.id);
  assert.equal(status.untrackedMode, 'no');
  assert.deepEqual(status.files.untracked, []);
  assert.ok(byPath(status.files.unstaged)['a.txt']); assert.ok(byPath(status.files.staged)['staged.txt']);
  assert.deepEqual(modes, ['no'], 'the setting is not overridden');
  const served = (await f.call('GET', `/api/v2/projects/${project.id}/git`)).body;
  assert.deepEqual([served.untrackedMode, served.files.untracked], ['no', []]);
  // Nothing the panel can't show is deleted.
  for (const paths of [['notes/u.txt'], ['notes/']]) {
    const refused = await f.call('POST', `/api/v2/projects/${project.id}/git/discard`, { paths });
    assert.equal(refused.status, 409, paths[0]); assert.equal(refused.body.code, 'git_discard_nothing', paths[0]);
  }
  assert.ok(existsSync(join(f.workspace, 'notes/u.txt')));
  const preview = await f.call('POST', `/api/v2/projects/${project.id}/git/discard`, { paths: ['a.txt', 'notes/u.txt'] });
  assert.deepEqual(preview.body.files, [{ path: 'a.txt', action: 'restore' }]);
  // The setting is read on every request: `normal` (and unset) list files one by one as before.
  git(f.workspace, 'config', 'status.showUntrackedFiles', 'normal');
  const normal = await service.status(project.id);
  assert.deepEqual([normal.untrackedMode, normal.files.untracked.map(row => row.path)], ['all', ['notes/u.txt']]);
  git(f.workspace, 'config', '--unset', 'status.showUntrackedFiles');
  assert.equal((await service.status(project.id)).untrackedMode, 'all');
  // Newer git also takes a boolean: false turns untracked files off.
  const boolean = new WorkspaceGitService(f.app.store), booleanModes = [], booleanRun = boolean.run.bind(boolean);
  boolean.run = (cwd, args, options) => {
    if (args[0] === 'config') return Promise.resolve({ code: 0, stdout: 'false\n', stderr: '', truncated: false, timedOut: false });
    const mode = args.find(arg => arg.startsWith('--untracked-files=')); if (args[0] === 'status' && mode) booleanModes.push(mode.split('=')[1]);
    return booleanRun(cwd, args, options);
  };
  assert.deepEqual([(await boolean.status(project.id)).untrackedMode, booleanModes], ['no', ['no']]);
  // The value is read the way git reads it: any false boolean, in any case, an empty value included, hides them;
  // a true one, or the bare key, lists them.
  const located = await service.locate(project.id);
  for (const [value, mode] of [['No', 'no'], ['OFF', 'no'], ['0', 'no'], ['', 'no'], ['true', 'all'], ['all', 'all']]) {
    git(f.workspace, 'config', 'status.showUntrackedFiles', value);
    assert.equal(await service.untrackedMode(located), mode, JSON.stringify(value));
  }
  git(f.workspace, 'config', '--unset-all', 'status.showUntrackedFiles');
  appendFileSync(join(f.workspace, '.git', 'config'), '[status]\n\tshowUntrackedFiles\n');
  assert.equal(await service.untrackedMode(located), 'all', 'the bare key');
  git(f.workspace, 'config', '--unset-all', 'status.showUntrackedFiles');
  // Git without `--type=bool-or-str` refuses the option: the raw value is read instead.
  git(f.workspace, 'config', 'status.showUntrackedFiles', 'no');
  const older = new WorkspaceGitService(f.app.store), olderRun = older.run.bind(older);
  older.run = (cwd, args, options) => args.includes('--type=bool-or-str') ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: unrecognized --type argument, bool-or-str', truncated: false, timedOut: false }) : olderRun(cwd, args, options);
  const olderStatus = await older.status(project.id);
  assert.deepEqual([olderStatus.untrackedMode, olderStatus.files.untracked], ['no', []]);
  await assert.rejects(older.discard(project.id, { paths: ['notes/u.txt'] }), error => error.code === 'git_discard_nothing');
  git(f.workspace, 'config', '--unset-all', 'status.showUntrackedFiles');
  // A setting that can't be read: the panel still lists files, but discarding never guesses that they are shown.
  const unread = new WorkspaceGitService(f.app.store), unreadRun = unread.run.bind(unread);
  unread.run = (cwd, args, options) => args[0] === 'config' ? Promise.resolve({ code: null, stdout: '', stderr: '', truncated: false, timedOut: true }) : unreadRun(cwd, args, options);
  assert.deepEqual((await unread.status(project.id)).files.untracked.map(row => row.path), ['notes/u.txt']);
  await assert.rejects(unread.discard(project.id, { paths: ['notes/u.txt'] }), error => error.status === 409 && error.code === 'git_write_failed');
  assert.ok(existsSync(join(f.workspace, 'notes/u.txt')));
});

test('an untracked folder that is a separate repository is never deleted: refused alone, kept beside other files', async t => {
  const nested = (root, path) => { mkdirSync(join(root, path), { recursive: true }); git(join(root, path), 'init', '-q'); write(join(root, path), 'inside.txt', 'keep me\n'); };
  const f = await setup(t, { workspace: root => { richRepository(root); nested(root, 'inner'); nested(root, 'clone'); } }), project = f.project();
  const url = `/api/v2/projects/${project.id}/git/discard`;
  const listed = (await f.call('GET', `/api/v2/projects/${project.id}/git`)).body.files.untracked.map(row => row.path);
  assert.deepEqual(listed, ['clone/', 'inner/', 'notes/u.txt'], 'git lists another repository as its folder');
  const alone = await f.call('POST', url, { paths: ['inner/'] });
  assert.equal(alone.status, 409); assert.equal(alone.body.code, 'git_discard_repository'); assert.match(alone.body.error, /inner\//);
  const both = await f.call('POST', url, { paths: ['inner/', 'clone/'] });
  assert.equal(both.body.code, 'git_discard_repository'); assert.match(both.body.error, /clone\//);
  // Beside other files: they are discarded, the repository is listed as kept, never as discarded.
  const preview = await f.call('POST', url, { paths: ['inner/', 'notes/u.txt'] });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual([preview.body.files, preview.body.kept], [[{ path: 'notes/u.txt', action: 'delete' }], [{ path: 'inner/', reason: 'repository' }]]);
  const done = await f.call('POST', url, { paths: ['inner/', 'notes/u.txt'], confirm: preview.body.confirm });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.discarded, done.body.kept], [[{ path: 'notes/u.txt', action: 'delete' }], [{ path: 'inner/', reason: 'repository' }]]);
  assert.equal(existsSync(join(f.workspace, 'notes/u.txt')), false);
  assert.equal(readFileSync(join(f.workspace, 'inner/inside.txt'), 'utf8'), 'keep me\n'); assert.ok(existsSync(join(f.workspace, 'inner/.git/HEAD')));
  assert.deepEqual(done.body.status.files.untracked.map(row => row.path), ['clone/', 'inner/']);
  // A plain discard keeps its old shape: no `kept` when there is nothing to keep.
  assert.equal((await f.call('POST', url, { paths: ['a.txt'] })).body.kept, undefined);

  // Listed by folder: a repository deeper inside one is kept and the rest of the folder goes; a folder holding only
  // repositories is refused like one.
  nested(f.workspace, 'vendor/lib'); write(f.workspace, 'vendor/loose.txt', 'loose\n'); nested(f.workspace, 'only/lib');
  const service = new WorkspaceGitService(f.app.store); service.collapsed.add(f.workspace);
  assert.deepEqual((await service.status(project.id)).files.untracked.map(row => row.path), ['clone/', 'inner/', 'only/', 'vendor/']);
  const folder = await service.discard(project.id, { paths: ['vendor/'] });
  assert.deepEqual([folder.files, folder.kept], [[{ path: 'vendor/', action: 'delete' }], [{ path: 'vendor/lib/', reason: 'repository' }]]);
  const cleaned = await service.discard(project.id, { paths: ['vendor/'], confirm: folder.confirm });
  assert.deepEqual(cleaned.kept, [{ path: 'vendor/lib/', reason: 'repository' }]);
  assert.equal(existsSync(join(f.workspace, 'vendor/loose.txt')), false);
  assert.equal(readFileSync(join(f.workspace, 'vendor/lib/inside.txt'), 'utf8'), 'keep me\n');
  await assert.rejects(service.discard(project.id, { paths: ['only/'] }), error => error.status === 409 && error.code === 'git_discard_repository' && /only\/lib\//.test(error.message));
  assert.ok(existsSync(join(f.workspace, 'only/lib/inside.txt')));
});

test('staging refuses an untracked folder that is a repository of its own (it would become a gitlink no clone can fill)', async t => {
  const nested = (root, path) => { mkdirSync(join(root, path), { recursive: true }); git(join(root, path), 'init', '-q'); write(join(root, path), 'inside.txt', 'keep me\n'); };
  const f = await setup(t, { workspace: root => { richRepository(root); nested(root, 'inner'); nested(root, 'vendor/lib'); write(root, 'vendor/loose.txt', 'loose\n'); } }), project = f.project();
  const url = `/api/v2/projects/${project.id}/git/stage`, staged = () => git(f.workspace, 'diff', '--cached', '--name-only').trim(), before = staged();
  for (const paths of [['inner/'], ['vendor/'], ['notes/u.txt', 'inner/']]) {
    const refused = await f.call('POST', url, { paths });
    assert.equal(refused.status, 409, JSON.stringify(paths)); assert.equal(refused.body.code, 'git_stage_repository'); assert.match(refused.body.error, /单独的 Git 仓库/);
  }
  assert.equal(staged(), before, 'nothing was staged by a refused request');
  const plain = await f.call('POST', url, { paths: ['notes/u.txt'] });
  assert.equal(plain.status, 200, JSON.stringify(plain.body)); assert.deepEqual(plain.body.staged, ['notes/u.txt']);
});

test('a submodule and worktrees inside the folder are kept too, in a folder inside the repository, even with submodule.recurse', async t => {
  const f = await setup(t, { workspace: (root, directory) => {
    const lib = join(directory, 'lib'); mkdirSync(lib); git(lib, 'init', '-q'); write(lib, 'l.txt', 'l\n'); git(lib, 'add', '-A'); git(lib, 'commit', '-q', '-m', 'l');
    git(root, 'init', '-q'); write(root, 'app/a.txt', 'a\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'a');
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'app/sub'); git(root, 'commit', '-q', '-m', 'sub');
    // A linked worktree of this repository inside the folder, and one of another repository.
    git(root, 'worktree', 'add', '-q', join(root, 'app', '.worktrees', 'feature'), '-b', 'feature');
    git(lib, 'worktree', 'add', '-q', join(root, 'app', 'other'), '-b', 'other');
    // Recursing into submodules is a common global setting: a checkout of `app/sub` would then reset the work inside it.
    git(root, 'config', 'submodule.recurse', 'true');
    write(root, 'app/sub/l.txt', 'l\nwork in progress\n'); write(root, 'app/a.txt', 'edited\n'); write(root, 'app/notes.txt', 'new\n');
  } });
  const project = f.project(join(f.workspace, 'app'), 'App'), url = `/api/v2/projects/${project.id}/git/discard`;
  const listed = (await f.call('GET', `/api/v2/projects/${project.id}/git`)).body.files;
  assert.deepEqual([listed.unstaged.map(row => row.path).sort(), listed.untracked.map(row => row.path)], [['a.txt', 'sub'], ['.worktrees/feature/', 'notes.txt', 'other/']]);
  const alone = await f.call('POST', url, { paths: ['sub'] });
  assert.deepEqual([alone.status, alone.body.code], [409, 'git_discard_repository']); assert.match(alone.body.error, /sub/);
  assert.equal((await f.call('POST', url, { paths: ['other/', '.worktrees/feature/'] })).body.code, 'git_discard_repository');
  const paths = ['.worktrees/feature/', 'a.txt', 'notes.txt', 'other/', 'sub'];
  const preview = await f.call('POST', url, { paths });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.files, [{ path: 'a.txt', action: 'restore' }, { path: 'notes.txt', action: 'delete' }]);
  assert.deepEqual(preview.body.kept, [{ path: 'sub', reason: 'repository' }, { path: '.worktrees/feature/', reason: 'repository' }, { path: 'other/', reason: 'repository' }]);
  // Work going on in a kept repository between the two clicks doesn't stop the discard of the rest.
  write(f.workspace, 'app/other/started.txt', 'busy\n');
  const done = await f.call('POST', url, { paths, confirm: preview.body.confirm });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.discarded, done.body.kept], [preview.body.files, preview.body.kept]);
  assert.equal(readFileSync(join(f.workspace, 'app/a.txt'), 'utf8'), 'a\n'); assert.equal(existsSync(join(f.workspace, 'app/notes.txt')), false);
  assert.equal(readFileSync(join(f.workspace, 'app/sub/l.txt'), 'utf8'), 'l\nwork in progress\n', 'the work inside the submodule stays');
  for (const kept of ['app/.worktrees/feature/app/a.txt', 'app/other/l.txt', 'app/other/started.txt']) assert.ok(existsSync(join(f.workspace, kept)), kept);
});

test('a paths entry of the wrong type is a malformed request (400), whatever the project allows', async t => {
  const f = await setup(t, { workspace: richRepository }), project = f.project();
  const before = git(f.workspace, 'diff', '--cached', '--name-only');
  const check = async label => {
    for (const action of ['stage', 'unstage', 'discard']) {
      for (const paths of [[5], [null], [{}], [['a.txt']], ['a.txt', 7], [''], 'a.txt', { 0: 'a.txt' }]) {
        const refused = await f.call('POST', `/api/v2/projects/${project.id}/git/${action}`, { paths });
        assert.equal(refused.status, 400, `${label} ${action} ${JSON.stringify(paths)}`); assert.equal(refused.body.code, 'git_paths_invalid'); assert.ok(refused.body.error);
      }
    }
  };
  await check('writable');
  // A well-formed path outside the folder is still refused as such.
  const outside = await f.call('POST', `/api/v2/projects/${project.id}/git/stage`, { paths: ['a.txt', '../x'] });
  assert.deepEqual([outside.status, outside.body.code], [403, 'git_path_denied']);
  f.app.permissions.update(project.id, { workspace: 'read', background: 'read' });
  await check('read-only');
  assert.equal(git(f.workspace, 'diff', '--cached', '--name-only'), before, 'nothing was staged');
  assert.equal((await f.call('POST', '/api/v2/projects/nope/git/stage', { paths: [5] })).status, 404);
});

test('stage and unstage need write permission and move files between the groups, before and after the first commit', async t => {
  const f = await setup(t, { workspace: richRepository }), project = f.project();
  const stage = await f.call('POST', `/api/v2/projects/${project.id}/git/stage`, { paths: ['a.txt', 'notes/u.txt', 'keep.txt'] });
  assert.equal(stage.status, 200, JSON.stringify(stage.body));
  const staged = byPath(stage.body.status.files.staged);
  assert.equal(staged['a.txt'].status, 'M'); assert.equal(staged['notes/u.txt'].status, 'A'); assert.equal(staged['keep.txt'].status, 'D');
  assert.deepEqual(stage.body.status.files.untracked, []);
  const unstage = await f.call('POST', `/api/v2/projects/${project.id}/git/unstage`, { paths: ['a.txt', 'new name.txt', 'old name.txt'] });
  assert.equal(unstage.status, 200, JSON.stringify(unstage.body));
  assert.ok(byPath(unstage.body.status.files.unstaged)['a.txt']);
  assert.equal(byPath(unstage.body.status.files.staged)['a.txt'], undefined);
  assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), 'one\nTWO\nthree\nfour\n', 'unstaging never touches the file');
  assert.equal((await f.call('POST', `/api/v2/projects/${project.id}/git/stage`, { paths: ['a.txt'], confirm: 'x' })).status, 400);
  assert.equal((await f.call('POST', `/api/v2/projects/${project.id}/git/stage`, { paths: [] })).body.code, 'git_paths_invalid');

  // Read-only: reads still work, every write is refused and nothing changes.
  f.app.permissions.update(project.id, { workspace: 'read', background: 'read' });
  assert.equal((await f.call('GET', `/api/v2/projects/${project.id}/git`)).status, 200);
  for (const action of ['stage', 'unstage', 'discard']) {
    const refused = await f.call('POST', `/api/v2/projects/${project.id}/git/${action}`, { paths: ['a.txt'] });
    assert.equal(refused.status, 403, action); assert.equal(refused.body.code, 'git_read_only'); assert.ok(refused.body.error);
  }
  assert.doesNotMatch(git(f.workspace, 'diff', '--cached', '--name-only'), /^a\.txt$/m);

  const fresh = join(f.directory, 'fresh'); mkdirSync(fresh); git(fresh, 'init', '-q'); write(fresh, 'first.txt', 'x\n'); write(fresh, 'second.txt', 'y\n');
  const initial = f.project(fresh, 'Fresh');
  const added = await f.call('POST', `/api/v2/projects/${initial.id}/git/stage`, { paths: ['first.txt'] });
  assert.equal(added.body.status.initial, true); assert.deepEqual(added.body.status.files.staged.map(row => row.path), ['first.txt']);
  // A path that was never staged is skipped, as `reset` skips it after the first commit.
  const removed = await f.call('POST', `/api/v2/projects/${initial.id}/git/unstage`, { paths: ['first.txt', 'second.txt'] });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.deepEqual(removed.body.status.files.untracked.map(row => row.path), ['first.txt', 'second.txt']);
});

test('while maintenance holds, the git state stays readable and every git write waits', async t => {
  const f = await setup(t, { workspace: richRepository }), project = f.project(), stateFile = join(f.directory, '.state', 'state.json');
  const row = persistMaintenance(stateFile, initialMaintenance('backup', {}, randomUUID(), {})); f.app.maintenanceGate.refresh();
  assert.equal(f.app.maintenanceGate.held, true);
  assert.equal((await f.call('GET', `/api/v2/projects/${project.id}/git`)).status, 200);
  assert.equal((await f.call('GET', `/api/v2/projects/${project.id}/git/diff?source=unstaged&path=a.txt`)).body.kind, 'patch');
  for (const action of ['stage', 'unstage', 'discard']) {
    const held = await f.call('POST', `/api/v2/projects/${project.id}/git/${action}`, { paths: ['a.txt'] });
    assert.equal(held.status, 503, action); assert.equal(held.body.code, 'maintenance_held', action);
  }
  assert.doesNotMatch(git(f.workspace, 'diff', '--cached', '--name-only'), /^a\.txt$/m);
  await changeMaintenance(stateFile, row.id, value => ({ ...value, held: false, phase: 'cancelled' })); f.app.maintenanceGate.refresh();
});

test('paths outside the workspace, option-like paths and .git are refused before git runs', async t => {
  const f = await setup(t, { workspace: (root, directory) => {
    richRepository(root); mkdirSync(join(directory, 'outside')); writeFileSync(join(directory, 'outside', 'secret.txt'), 'top secret\n');
    symlinkSync(join(directory, 'outside'), join(root, 'escape')); symlinkSync('.git', join(root, 'meta')); symlinkSync(join(directory, 'outside', 'secret.txt'), join(root, 'leak'));
  } });
  const project = f.project();
  for (const path of ['../outside/secret.txt', '/etc/passwd', '-A', '--all', 'notes/../../outside/secret.txt', './a.txt', 'notes//u.txt', '.git/config', '.GIT/config', 'meta/config', 'escape/secret.txt', 'a.txt\\x', 'notes/']) {
    const refused = await f.call('POST', `/api/v2/projects/${project.id}/git/stage`, { paths: ['a.txt', path] });
    if (path === 'notes/') { assert.equal(refused.status, 200, 'a trailing slash names an untracked folder'); git(f.workspace, 'reset', '-q', '--', 'a.txt', 'notes'); continue; }
    assert.equal(refused.status, 403, path); assert.equal(refused.body.code, 'git_path_denied', path);
    const diff = await f.call('GET', `/api/v2/projects/${project.id}/git/diff?source=unstaged&path=${encodeURIComponent(path)}`);
    assert.equal(diff.status, 403, path);
  }
  assert.equal(git(f.workspace, 'diff', '--cached', '--name-only', '--no-renames').split('\n').filter(Boolean).sort().join(','), 'new name.txt,old name.txt,staged.txt', 'nothing was staged by a refused request');
  assert.equal((await f.call('POST', `/api/v2/projects/${project.id}/git/stage`, { paths: ['a.txt'], extra: 1 })).status, 400);
  // A new link inside the folder shows where it points, never the file it points to.
  const link = await f.call('GET', `/api/v2/projects/${project.id}/git/diff?source=unstaged&path=leak`);
  assert.equal(link.body.kind, 'patch'); assert.match(link.body.patch, /^new file mode 120000$/m);
  assert.ok(link.body.patch.includes(`\n+${join(f.directory, 'outside', 'secret.txt')}\n`)); assert.doesNotMatch(link.body.patch, /top secret/);
  const nameless = await f.call('GET', `/api/v2/projects/${project.id}/git/diff?source=unstaged`);
  assert.equal(nameless.status, 400); assert.equal(nameless.body.code, 'git_paths_invalid');
});

test('discard takes two explicit steps, refuses a stale or reused confirmation, and never discards a file that changed in between', async t => {
  const f = await setup(t, { workspace: (root, directory) => {
    richRepository(root);
    // A file checkout runs post-checkout; the panel's must not.
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(root, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch '${join(directory, 'hook-ran')}'\n`, { mode: 0o755 });
  } }), project = f.project();
  const url = `/api/v2/projects/${project.id}/git/discard`;
  const preview = await f.call('POST', url, { paths: ['notes/u.txt', 'a.txt'] });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.match(preview.body.confirm, /^[a-f0-9]{32}$/); assert.ok(Date.parse(preview.body.expiresAt) > Date.now());
  assert.deepEqual(preview.body.files, [{ path: 'a.txt', action: 'restore' }, { path: 'notes/u.txt', action: 'delete' }]);
  assert.ok(existsSync(join(f.workspace, 'notes/u.txt')), 'the first step changes nothing');
  assert.equal((await f.call('POST', url, { paths: ['a.txt', 'notes/u.txt'], confirm: 'f'.repeat(32) })).body.code, 'git_discard_unconfirmed');
  assert.equal((await f.call('POST', url, { paths: ['a.txt'], confirm: preview.body.confirm })).body.code, 'git_discard_unconfirmed', 'a different set of files is not what was confirmed');
  // The token was spent by that mismatch; a new preview, then an edit before the second click.
  const second = await f.call('POST', url, { paths: ['a.txt', 'notes/u.txt'] });
  write(f.workspace, 'a.txt', 'edited again after the preview\n');
  const changed = await f.call('POST', url, { paths: ['a.txt', 'notes/u.txt'], confirm: second.body.confirm });
  assert.equal(changed.status, 409); assert.equal(changed.body.code, 'git_discard_changed');
  assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), 'edited again after the preview\n');
  const third = await f.call('POST', url, { paths: ['a.txt', 'notes/u.txt'] });
  const done = await f.call('POST', url, { paths: ['notes/u.txt', 'a.txt'], confirm: third.body.confirm });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n');
  assert.equal(existsSync(join(f.workspace, 'notes/u.txt')), false);
  assert.equal(byPath(done.body.status.files.unstaged)['a.txt'], undefined);
  assert.equal(existsSync(join(f.directory, 'hook-ran')), false, 'the repository’s post-checkout hook did not run');
  assert.equal((await f.call('POST', url, { paths: ['a.txt', 'notes/u.txt'], confirm: third.body.confirm })).body.code, 'git_discard_unconfirmed', 'a confirmation is used once');
  const nothing = await f.call('POST', url, { paths: ['staged.txt'] });
  assert.equal(nothing.status, 409); assert.equal(nothing.body.code, 'git_discard_nothing', 'staged-only changes are not discarded');
  assert.ok(existsSync(join(f.workspace, 'staged.txt')));
  // A folder names untracked files only; a tracked file inside it is never restored through the folder.
  write(f.workspace, 'docs/guide.md', '# Guide\nedited\n');
  assert.equal((await f.call('POST', url, { paths: ['docs/'] })).body.code, 'git_discard_nothing');
  assert.equal(readFileSync(join(f.workspace, 'docs/guide.md'), 'utf8'), '# Guide\nedited\n');

  // Expiry: a confirmation older than its time to live is refused.
  const service = new WorkspaceGitService(f.app.store, { discardTtlMs: 1000, now: () => clock }); let clock = Date.now();
  write(f.workspace, 'a.txt', 'again\n');
  const expiring = await service.discard(project.id, { paths: ['a.txt'] });
  clock += 2000;
  await assert.rejects(service.discard(project.id, { paths: ['a.txt'], confirm: expiring.confirm }), error => error.code === 'git_discard_unconfirmed');
  // Unanswered questions are capped: past 32 the oldest lapses, the newest still works.
  const tokens = [];
  for (let index = 0; index < 33; index++) tokens.push((await service.discard(project.id, { paths: ['a.txt'] })).confirm);
  assert.equal(service.pending.size, 32);
  await assert.rejects(service.discard(project.id, { paths: ['a.txt'], confirm: tokens[0] }), error => error.code === 'git_discard_unconfirmed');
  await service.discard(project.id, { paths: ['a.txt'], confirm: tokens.at(-1) });
  assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n');
});

test('a merge in progress shows its conflicts and operation; a conflicted file is never discarded', async t => {
  const f = await setup(t, { workspace: root => {
    git(root, 'init', '-q'); write(root, 'c.txt', 'base\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
    git(root, 'checkout', '-q', '-b', 'other'); write(root, 'c.txt', 'other\n'); git(root, 'commit', '-q', '-am', 'other');
    git(root, 'checkout', '-q', 'main'); write(root, 'c.txt', 'mine\n'); git(root, 'commit', '-q', '-am', 'mine');
    try { git(root, 'merge', '-q', 'other'); } catch { /* the conflict is the point */ }
  } });
  const project = f.project(), body = (await f.call('GET', `/api/v2/projects/${project.id}/git`)).body;
  assert.equal(body.operation, 'merge');
  assert.deepEqual(body.files.conflicted, [{ path: 'c.txt', status: 'U', added: null, removed: null }]);
  const refused = await f.call('POST', `/api/v2/projects/${project.id}/git/discard`, { paths: ['c.txt'] });
  assert.equal(refused.status, 409); assert.equal(refused.body.code, 'git_discard_conflicted');
});

test('ahead / behind against the upstream, files since the branch left it, and linked worktrees', async t => {
  const f = await setup(t, { workspace: (root, directory) => {
    const origin = join(directory, 'origin.git'); git(directory, 'init', '-q', '--bare', origin);
    git(root, 'init', '-q'); write(root, 'a.txt', 'a\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'a');
    git(root, 'remote', 'add', 'origin', origin); git(root, 'push', '-q', '-u', 'origin', 'main');
    write(root, 'b.txt', 'b\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'b');
    write(root, 'a.txt', 'a\nmore\n');
    git(root, 'worktree', 'add', '-q', join(directory, 'linked'), '-b', 'side');
  } });
  const project = f.project();
  const body = (await f.call('GET', `/api/v2/projects/${project.id}/git?include=upstream`)).body;
  assert.deepEqual([body.upstream, body.ahead, body.behind], ['origin/main', 1, 0]);
  assert.deepEqual(body.files.upstream.map(row => [row.path, row.status, row.added]).sort(), [['a.txt', 'M', 1], ['b.txt', 'A', 1]]);
  assert.equal((await f.call('GET', `/api/v2/projects/${project.id}/git`)).body.files.upstream, undefined, 'only when asked');
  assert.match((await f.call('GET', `/api/v2/projects/${project.id}/git/diff?source=upstream&path=b.txt`)).body.patch, /^\+b$/m);

  const main = (await f.call('GET', `/api/v2/projects/${project.id}/git/worktrees`)).body;
  assert.equal(main.repo, 'main');
  assert.deepEqual(main.worktrees.map(row => [row.branch, row.main, row.linked, row.current]), [['main', true, false, true], ['side', false, true, false]]);
  assert.deepEqual(main.worktrees.map(row => [row.rna, row.owner]), [[false, null], [false, null]], 'Rna makes no worktree for a conversation yet');
  const linked = f.project(join(f.directory, 'linked'), 'Linked');
  const status = (await f.call('GET', `/api/v2/projects/${linked.id}/git`)).body;
  assert.equal(status.repo, 'linked'); assert.equal(status.branch, 'side');
  assert.deepEqual((await f.call('GET', `/api/v2/projects/${linked.id}/git/worktrees`)).body.worktrees.map(row => row.current), [false, true]);
});

test('too many untracked files: the listing falls back to folders and remembers that for the repository', async t => {
  const f = await setup(t, { workspace: root => {
    git(root, 'init', '-q'); write(root, 'a.txt', 'a\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'a'); write(root, 'a.txt', 'b\n');
    for (let index = 0; index < 80; index++) write(root, `generated/file-${String(index).padStart(3, '0')}-with-a-long-name.txt`, 'x');
  } });
  const project = f.project(), service = new WorkspaceGitService(f.app.store, { statusMaxBytes: 2048 });
  const modes = [], run = service.run.bind(service);
  service.run = (cwd, args, options) => { const mode = args.find(arg => arg.startsWith('--untracked-files=')); if (args[0] === 'status' && mode) modes.push(mode.split('=')[1]); return run(cwd, args, options); };
  const first = await service.status(project.id);
  assert.equal(first.untrackedMode, 'normal'); assert.equal(first.truncated, undefined);
  assert.deepEqual(first.files.untracked.map(row => row.path), ['generated/']);
  assert.deepEqual(first.files.unstaged.map(row => row.path), ['a.txt']);
  const second = await service.status(project.id);
  assert.equal(second.untrackedMode, 'normal');
  assert.deepEqual(modes, ['all', 'normal', 'normal'], 'the detailed listing is not tried again');
  // The folder entry can be discarded as a whole; a file that appears deeper inside it between the two steps
  // (the folder's status line and its own timestamps stay the same) is noticed and nothing is deleted.
  write(f.workspace, 'generated/deep/early.txt', 'y');
  const early = await service.discard(project.id, { paths: ['generated/'] });
  assert.deepEqual(early.files, [{ path: 'generated/', action: 'delete' }]);
  write(f.workspace, 'generated/deep/late.txt', 'late');
  await assert.rejects(service.discard(project.id, { paths: ['generated/'], confirm: early.confirm }), error => error.code === 'git_discard_changed');
  assert.ok(existsSync(join(f.workspace, 'generated/deep/late.txt')));
  const preview = await service.discard(project.id, { paths: ['generated/'] });
  await service.discard(project.id, { paths: ['generated/'], confirm: preview.confirm });
  assert.equal(existsSync(join(f.workspace, 'generated')), false);

  // Walking untracked folders past the time limit falls back the same way; a status that still times out says so.
  const slow = new WorkspaceGitService(f.app.store), slowModes = [], slowRun = slow.run.bind(slow);
  let stillSlow = false;
  slow.run = async (cwd, args, options) => {
    const mode = args.find(arg => arg.startsWith('--untracked-files='))?.split('=')[1];
    if (args[0] === 'status' && mode) { slowModes.push(mode); if (mode === 'all' || stillSlow) return { code: null, stdout: '', stderr: '', truncated: false, timedOut: true }; }
    return slowRun(cwd, args, options);
  };
  write(f.workspace, 'generated/again.txt', 'z');
  const fallback = await slow.status(project.id);
  assert.deepEqual([fallback.untrackedMode, fallback.unavailable], ['normal', undefined]);
  assert.deepEqual(fallback.files.untracked.map(row => row.path), ['generated/']);
  stillSlow = true;
  const timedOut = await slow.status(project.id);
  assert.deepEqual([timedOut.repo, timedOut.unavailable], ['main', 'timed_out']); assert.ok(timedOut.message);
  assert.deepEqual(slowModes, ['all', 'normal', 'normal']);
});

test('git missing, or the macOS stub without developer tools, reports git as unavailable without running it', async t => {
  const f = await setup(t, { workspace: richRepository }), project = f.project();
  let ran = 0;
  const stub = new WorkspaceGitService(f.app.store, { platform: 'darwin', resolveGit: () => '/usr/bin/git', developerDirectory: async () => null });
  stub.run = () => { ran++; throw new Error('must not run'); };
  const status = await stub.status(project.id);
  assert.deepEqual([status.repo, status.unavailable], ['none', 'developer_tools']); assert.ok(status.message);
  assert.equal((await stub.diff(project.id, { source: 'unstaged', path: 'a.txt' })).kind, 'unavailable');
  await assert.rejects(stub.stage(project.id, { paths: ['a.txt'] }), error => error.status === 409 && error.code === 'git_unavailable');
  const emptyTools = new WorkspaceGitService(f.app.store, { platform: 'darwin', resolveGit: () => '/usr/bin/git', developerDirectory: async () => join(f.directory, 'no-tools') });
  emptyTools.run = stub.run;
  assert.equal((await emptyTools.status(project.id)).unavailable, 'developer_tools');
  assert.equal(ran, 0);
  const missing = await new WorkspaceGitService(f.app.store, { platform: 'linux', git: join(f.directory, 'no-such-git') }).status(project.id);
  assert.deepEqual([missing.repo, missing.unavailable], ['none', 'git_missing']);
  const noneOnPath = await new WorkspaceGitService(f.app.store, { platform: 'darwin', resolveGit: () => null }).status(project.id);
  assert.equal(noneOnPath.unavailable, 'git_missing');
  // A folder that vanished under a running request fails like a missing folder and never marks git itself missing.
  const working = new WorkspaceGitService(f.app.store);
  assert.equal((await working.availability()).ok, true);
  await assert.rejects(working.run(join(f.directory, 'vanished'), ['status']), error => error.gitUnavailable === 'workspace_missing');
  assert.equal(working.tools.ok, true);
  assert.equal((await working.status(project.id)).repo, 'main');
});

test('git runs from an absolute PATH folder, never the project folder, and ignores the daemon’s own git variables', async t => {
  const f = await setup(t, { workspace: (root, directory) => {
    richRepository(root);
    // A program named git at the top of the repository, and a second repository the inherited variables point at.
    writeFileSync(join(root, 'git'), `#!/bin/sh\ntouch '${join(directory, 'impostor-ran')}'\nexit 1\n`, { mode: 0o755 });
    const other = join(directory, 'other'); mkdirSync(other); git(other, 'init', '-q'); write(other, 'decoy.txt', 'decoy\n');
  } });
  const project = f.project(), other = join(f.directory, 'other');
  const bin = join(f.directory, 'bin'); mkdirSync(bin); writeFileSync(join(bin, 'git'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(resolveGitOnPath({ PATH: `.:relative/bin::${bin}` }), join(bin, 'git'), 'empty and relative PATH entries are skipped');
  assert.equal(resolveGitOnPath({ PATH: `.::${f.directory}` }), null);
  const saved = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  Object.assign(process.env, { PATH: `:.:${saved.PATH}`, GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(f.directory, 'stray-index'),
    GIT_ICASE_PATHSPECS: '1', GIT_TRACE: join(f.directory, 'trace.log'), GIT_TRACE2_EVENT: join(f.directory, 'trace2.log') });
  const service = new WorkspaceGitService(f.app.store), status = await service.status(project.id);
  const diff = await service.diff(project.id, { source: 'unstaged', path: 'a.txt' });
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  assert.equal(status.unavailable, undefined, JSON.stringify(status));
  assert.deepEqual([status.repo, status.branch], ['main', 'main']);
  assert.ok(byPath(status.files.unstaged)['a.txt']); assert.ok(byPath(status.files.staged)['staged.txt']);
  assert.ok(byPath(status.files.untracked)['git'], 'the impostor is just an untracked file');
  assert.equal(byPath(status.files.untracked)['decoy.txt'], undefined);
  assert.match(diff.patch, /^\+TWO$/m);
  for (const left of ['impostor-ran', 'stray-index', 'trace.log', 'trace2.log']) assert.equal(existsSync(join(f.directory, left)), false, left);
});

test('reading never rewrites the index, and a write cut off at its time limit is stopped so git removes its lock', async t => {
  const f = await setup(t, { workspace: richRepository }), project = f.project(), index = join(f.workspace, '.git', 'index');
  // Timestamps moved on unchanged tracked files: a plain `git diff` would rewrite the index under index.lock to record them.
  const later = new Date(Date.now() + 60000);
  for (const path of ['docs/guide.md', 'new name.txt']) utimesSync(join(f.workspace, path), later, later);
  const before = statSync(index).mtimeMs, service = new WorkspaceGitService(f.app.store);
  assert.ok(byPath((await service.status(project.id)).files.unstaged)['a.txt']);
  await service.diff(project.id, { source: 'unstaged', path: 'docs/guide.md' });
  assert.equal(statSync(index).mtimeMs, before, 'the index was not rewritten by a read');
  // Writes go out with SIGTERM (git removes index.lock on it; SIGKILL would leave the lock and block every later write).
  const signals = [], run = service.run.bind(service);
  service.run = (cwd, args, options = {}) => { signals.push([args[0], options.killSignal ?? 'SIGKILL']); return run(cwd, args, options); };
  await service.stage(project.id, { paths: ['a.txt'] });
  assert.deepEqual(signals.filter(([command]) => command === 'add'), [['add', 'SIGTERM']]);
  const marker = join(f.directory, 'cleaned-up'), slowGit = join(f.directory, 'slow-git');
  writeFileSync(slowGit, `#!/bin/sh\ntrap 'kill $child; touch "${marker}"; exit 143' TERM\nsleep 5 >/dev/null 2>&1 &\nchild=$!\nwait $child\n`, { mode: 0o755 });
  const slow = new WorkspaceGitService(f.app.store, { git: slowGit, platform: 'linux' });
  const cut = await slow.run(f.workspace, ['add', '--', 'a.txt'], { timeoutMs: 1500, killSignal: 'SIGTERM' });
  assert.equal(cut.timedOut, true); assert.ok(existsSync(marker), 'the command got the chance to clean up');
});

test('a patch over the cap comes back truncated on whole lines', async t => {
  const f = await setup(t, { workspace: root => { git(root, 'init', '-q'); write(root, 'big.txt', 'x\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'a'); write(root, 'big.txt', Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')); } });
  const project = f.project(), service = new WorkspaceGitService(f.app.store, { diffMaxBytes: 1024 });
  const diff = await service.diff(project.id, { source: 'unstaged', path: 'big.txt' });
  assert.equal(diff.kind, 'truncated'); assert.ok(diff.patch.length <= 1024 && diff.patch.endsWith('\n'));
});

test('names in Chinese and with spaces come through as written, in the status, the diff and staging', async t => {
  const f = await setup(t, { workspace: root => {
    git(root, 'init', '-q'); write(root, '文档/说明 1.md', '第一行\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'a');
    write(root, '文档/说明 1.md', '第一行\n第二行\n'); write(root, '新 文件.txt', '你好\n');
  } });
  const project = f.project(), body = (await f.call('GET', `/api/v2/projects/${project.id}/git`)).body;
  assert.deepEqual(body.files.unstaged, [{ path: '文档/说明 1.md', status: 'M', added: 1, removed: 0 }]);
  assert.deepEqual(body.files.untracked.map(row => row.path), ['新 文件.txt']);
  const diff = path => f.call('GET', `/api/v2/projects/${project.id}/git/diff?source=unstaged&path=${encodeURIComponent(path)}`);
  assert.match((await diff('文档/说明 1.md')).body.patch, /^\+第二行$/m);
  assert.match((await diff('新 文件.txt')).body.patch, /^\+你好$/m);
  const staged = await f.call('POST', `/api/v2/projects/${project.id}/git/stage`, { paths: ['新 文件.txt', '文档/说明 1.md'] });
  assert.deepEqual(staged.body.status.files.staged.map(row => [row.path, row.status]).sort(), [['文档/说明 1.md', 'M'], ['新 文件.txt', 'A']]);
});
