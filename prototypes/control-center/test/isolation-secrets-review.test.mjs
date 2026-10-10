// B8 review follow-ups (P2 batch B): files that hold secrets (SECRET_FILES) never take part in a merge even when a
// tree from before B8 still names one (a conversation's base, a worker's seed, a pinned tip); the worktree panel's
// apply and discard say which secret files they leave out or move to the trash instead of dropping them silently;
// `git gc --auto` gives the repository lock back when a turn starts. Real temporary repositories, the real engine,
// worktree services and runtime controller with a scripted model; no network, no paid model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git, put, read, skip } from './git-isolation-fixture.mjs';
import { turnFixture, there } from './helpers/turn-fixture.mjs';
import { RootResolver } from '../workspace-roots.mjs';
import { WorktreeService } from '../worktree-service.mjs';
import { MERGE_LABELS, REFS, TRASH_DIR } from '../git-isolation/index.mjs';

/** A blob written into the repository's store, as a 0.68.0 snapshot did for an untracked secret file. */
const oldBlob = (repo, content) => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: content, encoding: 'utf8' }).trim();
const entry = (repo, tree, path) => git(repo, 'ls-tree', '--full-tree', tree, '--', path).trim().split(/\s+/)[2] ?? null;
const services = f => {
  const roots = new RootResolver(f.store, { git: f.service });
  const worktrees = new WorktreeService(f.store, { git: f.service, engine: f.engine, roots });
  f.service.owners = path => worktrees.ownerOf(path);
  return { roots, worktrees };
};

test('a merge never writes, deletes or conflicts on a secret file a tree from before B8 still names: the current side keeps its version, reported as not merged', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'one\n' } });
  put(f.workspace, 'certs/server.key', 'SYNTHETIC KEY\n');
  const p = await f.engine.snapshot(f.project.id, f.root);
  assert.equal(entry(f.repo, p.tree, 'certs/server.key'), null, 'P\'s snapshot leaves it out (B8)');
  const X = oldBlob(f.repo, 'SYNTHETIC KEY\n'), Y = oldBlob(f.repo, 'SYNTHETIC KEY, the copy\'s\n'), Z = oldBlob(f.repo, 'SYNTHETIC KEY, elsewhere\n'), A = oldBlob(f.repo, 'one\nby the copy\n');
  const with_ = (tree, entries) => f.engine.compose(f.project.id, tree, entries.map(([path, oid]) => (oid ? { path, mode: '100644', oid } : { path, delete: true })));
  const labels = MERGE_LABELS.worker('agent-old00001');

  // A base and current side from 0.68.0 (they took the untracked key in), an incoming side from now (it has none).
  const old = await with_(p.tree, [['certs/server.key', X]]);
  const deletion = await f.engine.merge(f.project.id, { base: old, current: old, incoming: await with_(p.tree, [['a.txt', A]]) }, { labels });
  assert.equal(deletion.clean, true);
  assert.deepEqual(deletion.writes.map(row => row.path), ['a.txt'], 'the key is not deleted');
  assert.deepEqual(deletion.notMerged, [{ path: 'certs/server.key', reason: 'secret' }]);
  assert.equal(entry(f.repo, deletion.tree, 'certs/server.key'), X, 'the result keeps the current side\'s entry');

  // Both sides changed it: no conflict (a card's "this version" would write it), the current side's version stays.
  const both = await f.engine.merge(f.project.id, { base: old, current: await with_(p.tree, [['certs/server.key', Y]]), incoming: await with_(p.tree, [['certs/server.key', Z], ['a.txt', A]]) }, { labels });
  assert.equal(both.clean, true); assert.deepEqual(both.conflicts, []);
  assert.deepEqual(both.writes.map(row => row.path), ['a.txt']);
  assert.equal(entry(f.repo, both.tree, 'certs/server.key'), Y);
  assert.deepEqual(both.notMerged, [{ path: 'certs/server.key', reason: 'secret' }]);

  // Only the incoming side has one (a pinned tip from 0.68.0), a file or inside a folder named like one: never added.
  const added = await f.engine.merge(f.project.id, { base: p.tree, current: p.tree, incoming: await with_(p.tree, [['deploy/prod.env', Z], ['slides/deck.key/Data/a.png', A]]) }, { labels });
  assert.deepEqual(added.writes, []);
  assert.deepEqual(added.notMerged.map(row => row.path).sort(), ['deploy/prod.env', 'slides/deck.key/Data/a.png']);
  assert.equal(added.tree, p.tree, 'the result is the current side');

  // Written into P (a guard: P's snapshot never holds its untracked key, so nothing there names it to delete).
  const outcome = await f.engine.apply(f.project.id, { target: f.root, base: old, incoming: await with_(p.tree, [['a.txt', A]]), kind: 'worker', source: { sessionId: 's1', turnId: 't1', agentId: 'agent-old00001' }, mode: 'all', labels });
  assert.equal(outcome.status, 'applied');
  assert.deepEqual([outcome.written, outcome.removed], [['a.txt'], []]);
  assert.equal(read(f.workspace, 'certs/server.key'), 'SYNTHETIC KEY\n');
  assert.equal(read(f.workspace, 'a.txt'), 'one\nby the copy\n');
});

test('a conversation worktree made before B8 keeps its secret file through the next start sync and apply', { skip, timeout: 180000 }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  f.model.steps.push({ text: 'ok' });
  const first = await f.send(s.id, 'start');
  await f.quiet(s.id);
  const record = f.recordOf(s.id), S = (await f.rootOf(s.id)).root;
  // As 0.68.0 left it: P's untracked, non-ignored server.key was in P's snapshot, so S's base and HEAD hold it.
  put(f.P, 'certs/server.key', 'SYNTHETIC KEY\n');
  const blob = oldBlob(f.repo, 'SYNTHETIC KEY\n'), idx = join(f.dir, 'tmp-index'), env = { ...process.env, GIT_INDEX_FILE: idx };
  execFileSync('git', ['read-tree', record.base], { cwd: f.repo, env });
  execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},certs/server.key`], { cwd: f.repo, env });
  const tree = execFileSync('git', ['write-tree'], { cwd: f.repo, env, encoding: 'utf8' }).trim();
  const base = execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit-tree', tree, '-p', record.base, '-m', 'old base'], { cwd: f.repo, encoding: 'utf8' }).trim();
  await f.engine.pin(f.project.id, [{ ref: REFS.worktree(record.id, 'base'), commit: base }]);
  f.store.mutate(state => { state.projects[0].git.worktrees.find(row => row.id === record.id).base = base; });
  const wenv = { ...process.env, GIT_DIR: join(f.repo, '.git', 'worktrees', record.gitName ?? record.name), GIT_WORK_TREE: S };
  execFileSync('git', ['update-ref', '--no-deref', 'HEAD', base], { cwd: S, env: wenv });
  execFileSync('git', ['read-tree', base], { cwd: S, env: wenv });
  put(S, 'certs/server.key', 'SYNTHETIC KEY\n');

  const synced = await f.sessionWorktrees.syncStart(s.id, { turnId: first.id });
  assert.equal(synced.status, 'clean');
  assert.equal(there(S, 'certs/server.key'), true, 'the start sync does not delete it from the worktree');
  assert.equal(read(S, 'certs/server.key'), 'SYNTHETIC KEY\n');

  // A turn that changes a normal file: the apply into P carries that, and neither copy of the key moves.
  f.model.steps.push({ write: ['a.txt', 'from S\n'] }, { text: 'done' });
  const second = await f.send(s.id, 'write');
  assert.equal(second.apply.status, 'applied');
  assert.equal(read(f.P, 'a.txt'), 'from S\n');
  assert.equal(read(f.P, 'certs/server.key'), 'SYNTHETIC KEY\n');
  assert.equal(read(S, 'certs/server.key'), 'SYNTHETIC KEY\n');
});

test('the worktree panel names the secret files a kept worktree\'s owner changed: counted apart, listed by apply and discard, and where they went', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'one\n' } });
  const { worktrees } = services(f);
  put(f.workspace, '.env', 'API_KEY=synthetic-1\n'); put(f.workspace, 'certs/dev.pem', 'SYNTHETIC PEM\n');
  const make = async agentId => { const record = await worktrees.create(f.project.id, { kind: 'worker', owner: { sessionId: 's1', agentId }, parent: f.root, label: agentId }); worktrees.setState(f.project.id, record.id, 'kept'); return record; };
  const rowOf = async id => (await worktrees.list(f.project.id)).worktrees.find(row => row.id === id);
  const trash = join(f.workspace, ...TRASH_DIR.split('/'));
  const trashed = (id, path) => existsSync(trash) && readdirSync(trash).some(name => name.startsWith(`${id}-`) && existsSync(join(trash, name, path)));

  // Only .env changed (the laid-down certs/dev.pem untouched): nothing to apply, one secret file.
  const keyOnly = await make('agent-key00001');
  put(join(f.workspace, keyOnly.dir), '.env', 'API_KEY=synthetic-worker\n');
  assert.deepEqual((await rowOf(keyOnly.id)).pending, { files: 0, secret: 1 });
  const preview = await worktrees.discardWorktree(f.project.id, keyOnly.id, {});
  assert.deepEqual(preview.files, [{ path: '.env', action: 'modify' }]);
  assert.deepEqual(preview.secret, ['.env']);
  assert.match(preview.note, /\.env/); assert.match(preview.note, /\.rna\/trash\.nosync/);
  const discarded = await worktrees.discardWorktree(f.project.id, keyOnly.id, { confirm: preview.confirm });
  assert.equal(discarded.worktree.state, 'removed');
  assert.deepEqual(discarded.secret, ['.env']); assert.match(discarded.note, /\.rna\/trash\.nosync/);
  assert.ok(trashed(keyOnly.id, '.env'), 'it is in the trash, as said');
  assert.equal(read(f.workspace, '.env'), 'API_KEY=synthetic-1\n', 'P\'s own .env is untouched');

  // A normal file and .env: the apply writes the first, names the second, and the worktree takes it to the trash.
  const both = await make('agent-both0001');
  put(join(f.workspace, both.dir), 'a.txt', 'one\nby the worker\n'); put(join(f.workspace, both.dir), '.env', 'API_KEY=synthetic-both\n');
  assert.deepEqual((await rowOf(both.id)).pending, { files: 1, secret: 1 });
  const plan = await worktrees.applyWorktree(f.project.id, both.id, {});
  assert.deepEqual(plan.files, [{ path: 'a.txt', action: 'modify' }], 'what is written into P');
  assert.deepEqual(plan.secret, ['.env']); assert.match(plan.note, /\.env/);
  const applied = await worktrees.applyWorktree(f.project.id, both.id, { confirm: plan.confirm });
  assert.equal(applied.worktree.state, 'removed');
  assert.deepEqual(applied.secret, ['.env']); assert.match(applied.note, /\.rna\/trash\.nosync/);
  assert.equal(read(f.workspace, 'a.txt'), 'one\nby the worker\n');
  assert.equal(read(f.workspace, '.env'), 'API_KEY=synthetic-1\n');
  assert.ok(trashed(both.id, '.env'));

  // Nothing secret changed: no extra field anywhere.
  const plain = await make('agent-plain001');
  put(join(f.workspace, plain.dir), 'b.txt', 'b\n');
  assert.deepEqual((await rowOf(plain.id)).pending, { files: 1 });
  const plainPlan = await worktrees.discardWorktree(f.project.id, plain.id, {});
  assert.equal('secret' in plainPlan || 'note' in plainPlan, false);
});

test('git gc --auto on an Rna-owned repository stops when a turn of a project on it starts, so the turn never waits for it', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'one\n' } });
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).git = { sessionWorktreeDefault: false, worktrees: [], applies: [], init: { at: new Date().toISOString(), by: 'rna', commit: git(f.repo, 'rev-parse', 'HEAD').trim(), branch: 'main' } }; });
  // A collection that would run for a long while: it ends only when its signal stops it (or after 20 s).
  const run = f.service.run.bind(f.service);
  let started = null;
  f.service.run = (cwd, args, options = {}) => {
    if (!args.includes('gc')) return run(cwd, args, options);
    return new Promise(resolve => {
      started?.();
      const timer = setTimeout(() => resolve({ code: 0, stdout: '', stderr: '', truncated: false, timedOut: false }), 20000);
      options.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve({ code: null, stdout: '', stderr: '', truncated: false, timedOut: true }); });
    });
  };
  const began = new Promise(resolve => { started = resolve; });
  const sweep = f.engine.sweep();
  await began;
  const session = f.store.state.sessions.find(row => row.projectId === f.project.id);
  const at = Date.now();
  f.store.mutate(state => { state.sessions.find(row => row.id === session.id).status = 'running'; });
  // The turn's checkpoint pin takes the same repository lock.
  await f.engine.pin(f.project.id, [{ ref: REFS.turn('t-after-gc'), commit: git(f.repo, 'rev-parse', 'HEAD').trim() }]);
  assert.ok(Date.now() - at < 5000, `the lock came back at once (${Date.now() - at} ms)`);
  assert.deepEqual((await sweep).collected, [], 'a stopped collection is not reported as collected');
});
