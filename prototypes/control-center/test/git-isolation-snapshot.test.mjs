import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git, put, skip } from './git-isolation-fixture.mjs';
import { privateIndexPath } from '../git-isolation/snapshot.mjs';
import { LIMITS } from '../git-isolation/index.mjs';

// Snapshots (worktree design 0.63 §3.2, §13 "快照"): a private index, a tree and a commit on no branch; the
// user's index, HEAD, branches and refs stay exactly as they were.

const entries = (repo, tree) => Object.fromEntries(git(repo, 'ls-tree', '-r', '-z', tree).split('\0').filter(Boolean).map(line => { const [meta, path] = line.split('\t'); const [mode, , oid] = meta.split(' '); return [path, { mode, oid }]; }));
const blob = (repo, oid) => git(repo, 'cat-file', 'blob', oid);

test('a snapshot reads every kind of change and leaves the user\'s index, HEAD, branches and refs untouched', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'one\n', 'gone.txt': 'bye\n', 'run.sh': 'echo hi\n', 'docs/中文 名.md': '# 标题\n' } });
  git(f.repo, 'branch', 'feature');
  put(f.workspace, 'a.txt', 'one\ntwo\n');
  rmSync(join(f.workspace, 'gone.txt'));
  chmodSync(join(f.workspace, 'run.sh'), 0o755);
  put(f.workspace, 'new file.txt', 'new\n');
  put(f.workspace, '章节/第一章.md', '正文\n');
  symlinkSync('a.txt', join(f.workspace, 'link'));
  put(f.workspace, 'staged.txt', 'staged\n'); git(f.repo, 'add', 'staged.txt');
  const index = readFileSync(join(f.repo, '.git', 'index')), refs = git(f.repo, 'for-each-ref'), head = git(f.repo, 'rev-parse', 'HEAD'), symbolic = git(f.repo, 'symbolic-ref', 'HEAD');
  const snap = await f.engine.snapshot(f.project.id, f.root);
  assert.deepEqual(readFileSync(join(f.repo, '.git', 'index')), index, 'the user\'s index is byte for byte the same');
  assert.equal(git(f.repo, 'for-each-ref'), refs, 'no ref outside refs/rna moved (and none was added there either)');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), head); assert.equal(git(f.repo, 'symbolic-ref', 'HEAD'), symbolic);
  assert.equal(git(f.repo, 'status', '--porcelain=v1', '--', 'staged.txt'), 'A  staged.txt\n', 'what was staged stays staged');
  const tree = entries(f.repo, snap.tree);
  assert.equal(blob(f.repo, tree['a.txt'].oid), 'one\ntwo\n');
  assert.equal(tree['gone.txt'], undefined, 'a deleted file is gone from the snapshot');
  assert.equal(tree['run.sh'].mode, '100755', 'the executable bit is kept');
  assert.equal(tree.link.mode, '120000'); assert.equal(blob(f.repo, tree.link.oid), 'a.txt');
  assert.equal(blob(f.repo, tree['new file.txt'].oid), 'new\n');
  assert.equal(blob(f.repo, tree['章节/第一章.md'].oid), '正文\n');
  assert.equal(blob(f.repo, tree['docs/中文 名.md'].oid), '# 标题\n');
  assert.ok(tree['staged.txt']);
  assert.equal(git(f.repo, 'rev-parse', `${snap.commit}^`).trim(), head.trim(), 'the snapshot commit hangs off HEAD');
  assert.equal(git(f.repo, 'branch', '--contains', snap.commit).trim(), '', 'on no branch');
  assert.ok(existsSync(privateIndexPath(f.commonDir, f.workspace)), 'the private index lives in the common dir');
  // A second snapshot of an unchanged folder gives the same tree.
  assert.equal((await f.engine.snapshot(f.project.id, f.root)).tree, snap.tree);
  // Pinned on request, under refs/rna only.
  const pinned = await f.engine.snapshot(f.project.id, f.root, { pin: f.REFS.worktree('w1', 'seed') });
  assert.equal(git(f.repo, 'rev-parse', 'refs/rna/wt/w1/seed').trim(), pinned.commit);
  assert.deepEqual(git(f.repo, 'branch', '--format=%(refname)').trim().split('\n').sort(), ['refs/heads/feature', 'refs/heads/main']);
});

test('a project in a subfolder is snapshotted inside its prefix only; a repository without commits works', { skip }, async t => {
  const f = fixture(t, { prefix: 'site', files: { 'index.html': '<p>hi</p>\n' } });
  put(f.repo, 'outside.txt', 'not this project\n');
  put(f.workspace, 'page.html', 'new\n');
  const tree = entries(f.repo, (await f.engine.snapshot(f.project.id, f.root)).tree);
  assert.ok(tree['site/page.html']); assert.ok(tree['site/index.html']);
  assert.equal(tree['outside.txt'], undefined, 'untracked files outside the project folder stay out');

  const empty = fixture(t, { files: { 'draft.md': 'first words\n' }, commit: false });
  const snap = await empty.engine.snapshot(empty.project.id, empty.root);
  assert.equal(blob(empty.repo, entries(empty.repo, snap.tree)['draft.md'].oid), 'first words\n');
  assert.equal(git(empty.repo, 'rev-list', '--parents', '-n', '1', snap.commit).trim().split(' ').length, 1, 'no parent without a HEAD');
});

test('nested repositories and oversized files are skipped and reported; an unreadable file fails the whole snapshot', { skip }, async t => {
  const f = fixture(t);
  mkdirSync(join(f.workspace, 'vendor', 'lib'), { recursive: true });
  git(join(f.workspace, 'vendor', 'lib'), 'init', '-q'); put(join(f.workspace, 'vendor', 'lib'), 'x.js', 'x\n');
  put(f.workspace, 'big.bin', ''); truncateSync(join(f.workspace, 'big.bin'), LIMITS.snapshotFileBytes + 1);
  put(f.workspace, '.rna/worktrees.nosync/w-1/stray.txt', 'never in a snapshot\n');
  const snap = await f.engine.snapshot(f.project.id, f.root);
  assert.deepEqual(snap.nested, ['vendor/lib/']);
  assert.deepEqual(snap.oversized, ['big.bin']);
  const tree = entries(f.repo, snap.tree);
  assert.equal(tree['big.bin'], undefined); assert.equal(tree['vendor/lib/x.js'], undefined);
  assert.ok(!Object.keys(tree).some(path => path.startsWith('.rna/')), '.rna is never snapshotted');

  put(f.workspace, 'secret.txt', 'locked\n'); chmodSync(join(f.workspace, 'secret.txt'), 0o000);
  t.after(() => { try { chmodSync(join(f.workspace, 'secret.txt'), 0o644); } catch { /* removed with the folder */ } });
  await assert.rejects(f.engine.snapshot(f.project.id, f.root), error => error.code === 'snapshot_unreadable');
  chmodSync(join(f.workspace, 'secret.txt'), 0o644);
  assert.ok(entries(f.repo, (await f.engine.snapshot(f.project.id, f.root)).tree)['secret.txt'], 'readable again, it is snapshotted');
});

test('the private index follows ignore rules: a file that becomes ignored leaves the next snapshot', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'a\n', '.gitignore': 'dist/\n' } });
  put(f.workspace, 'build.log', 'noise\n'); put(f.workspace, 'dist/out.js', 'built\n');
  let tree = entries(f.repo, (await f.engine.snapshot(f.project.id, f.root)).tree);
  assert.ok(tree['build.log']); assert.equal(tree['dist/out.js'], undefined, 'ignored files are never in a snapshot');
  writeFileSync(join(f.workspace, '.gitignore'), 'dist/\n*.log\n');
  tree = entries(f.repo, (await f.engine.snapshot(f.project.id, f.root)).tree);
  assert.equal(tree['build.log'], undefined, 'a .gitignore change rebuilds the private index');
  assert.equal(blob(f.repo, tree['.gitignore'].oid), 'dist/\n*.log\n');
  // info/exclude counts as well.
  put(f.workspace, 'notes.tmp', 'tmp\n');
  assert.ok(entries(f.repo, (await f.engine.snapshot(f.project.id, f.root)).tree)['notes.tmp']);
  writeFileSync(join(f.commonDir, 'info', 'exclude'), '*.tmp\n');
  assert.equal(entries(f.repo, (await f.engine.snapshot(f.project.id, f.root)).tree)['notes.tmp'], undefined);
  // HEAD moving (the user commits) is followed too.
  put(f.workspace, 'kept.txt', 'kept\n'); git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-q', '-m', 'second');
  const after = entries(f.repo, (await f.engine.snapshot(f.project.id, f.root)).tree);
  assert.ok(after['kept.txt']); assert.equal(after['notes.tmp'], undefined);
});

test('the private index follows HEAD even when the user committed one version of a file and kept editing it', { skip }, async t => {
  // `read-tree -m HEAD` alone refuses this ("not uptodate", exit 128): the private index is only a cache of the folder.
  const f = fixture(t, { files: { 'a.txt': 'one\n', 'b.txt': 'b\n' } });
  put(f.workspace, 'a.txt', 'edited\n');
  assert.equal(blob(f.repo, entries(f.repo, (await f.engine.snapshot(f.project.id, f.root)).tree)['a.txt'].oid), 'edited\n');
  put(f.workspace, 'a.txt', 'committed\n'); git(f.repo, 'add', 'a.txt'); git(f.repo, 'commit', '-q', '-m', 'second');
  put(f.workspace, 'a.txt', 'edited again\n');
  const tree = entries(f.repo, (await f.engine.snapshot(f.project.id, f.root)).tree);
  assert.equal(blob(f.repo, tree['a.txt'].oid), 'edited again\n', 'the folder as it is now, after HEAD moved');
  assert.equal(blob(f.repo, tree['b.txt'].oid), 'b\n');
});

test('a worktree root is snapshotted through the GIT_DIR of its record', { skip }, async t => {
  const f = fixture(t);
  const seed = await f.engine.snapshot(f.project.id, f.root);
  const w = f.worktree('worker', 'agent-0011223344', seed.commit);
  put(w.root, 'a.txt', 'changed in the copy\n'); put(w.root, 'fresh.txt', 'new\n');
  const snap = await f.engine.snapshot(f.project.id, w);
  const tree = entries(f.repo, snap.tree);
  assert.equal(blob(f.repo, tree['a.txt'].oid), 'changed in the copy\n'); assert.ok(tree['fresh.txt']);
  assert.equal(git(f.repo, 'rev-parse', `${snap.commit}^`).trim(), seed.commit, 'its parent is the worktree\'s HEAD (the seed)');
  // A root that is neither P nor a registered worktree under .rna/worktrees.nosync is refused.
  await assert.rejects(f.engine.snapshot(f.project.id, { ...w, workTree: f.dir, root: f.dir }), error => error.code === 'root_denied');
  await assert.rejects(f.engine.snapshot(f.project.id, { ...f.root, root: f.dir }), error => error.code === 'root_denied');
});
