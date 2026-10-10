// Worktree design 0.63 §5.3, §6.2, §6.4, §7.4, §13 (T2): creating, laying down dependencies, removing, reconciling,
// repairing and rebuilding Rna's worktrees, the …/worktrees routes, and the Vite preview of a root under `.rna/`.
// Real temporary repositories (git without global or system configuration); the merge engine is the fixture's
// stand-in (real snapshots and refs), since its merges and writes are T1's and tested there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, addWorktree, git, gitVersionOk, refOf, write, REFS } from './helpers/worktree-fixture.mjs';
import { createWorktreeRoutes } from '../worktree-routes.mjs';
import { previewDeniedPatterns, viteEntryFor, escapeGlob } from '../workspace-dev-preview.mjs';
import { WORKTREE_DIR, TRASH_DIR, LIMITS } from '../git-isolation/contract.mjs';

const skip = !gitVersionOk;
const spyGit = f => { const calls = []; const run = f.git.run.bind(f.git); f.git.run = (cwd, args, options) => { calls.push(args); return run(cwd, args, options); }; return calls; };
const parent = f => ({ root: f.P, kind: 'project', isolated: false, project: f.P });
const porcelain = f => git(f.P, ['worktree', 'list', '--porcelain']);

test('create: the seed holds the parent’s uncommitted and untracked files; detached at the seed, locked, excluded, recorded', { skip }, async t => {
  const f = fixture(t), calls = spyGit(f);
  write(f.P, 'src/app.js', 'export const a = 2; // uncommitted\n'); write(f.P, 'notes/new.md', 'untracked\n');
  const record = await f.worktrees.create(f.project.id, { kind: 'worker', owner: { sessionId: f.session.id, turnId: 't1', agentId: 'agent-1a2b3c4d5e' }, parent: parent(f), label: 'Rna worker agent-1a2b3c4d5e' });
  assert.equal(record.kind, 'worker'); assert.equal(record.name, 'w-1a2b3c4d'); assert.equal(record.dir, `${WORKTREE_DIR}/w-1a2b3c4d`);
  assert.equal(record.state, 'active'); assert.equal(record.prefix, ''); assert.deepEqual(record.owner, { sessionId: f.session.id, turnId: 't1', agentId: 'agent-1a2b3c4d5e' });
  assert.deepEqual(f.store.state.projects.find(row => row.id === f.project.id).git.worktrees.map(row => row.id), [record.id]);
  const top = join(f.P, record.dir), env = { GIT_DIR: join(f.top, '.git/worktrees', record.name), GIT_WORK_TREE: top };
  assert.equal(readFileSync(join(top, 'src/app.js'), 'utf8'), 'export const a = 2; // uncommitted\n');
  assert.equal(readFileSync(join(top, 'notes/new.md'), 'utf8'), 'untracked\n');
  assert.equal(git(top, ['rev-parse', 'HEAD'], { env }).trim(), record.seed, 'HEAD is the seed');
  assert.throws(() => git(top, ['symbolic-ref', '-q', 'HEAD'], { env }), 'detached');
  assert.equal(git(top, ['status', '--porcelain'], { env }), '', 'the agent sees exactly its own changes: none yet');
  assert.equal(refOf(f.P, REFS.worktree(record.id, 'seed')), record.seed, 'seed pinned');
  assert.match(porcelain(f), new RegExp(`worktree ${top}\\nHEAD ${record.seed}\\ndetached\\nlocked Rna worker agent-1a2b3c4d5e`));
  assert.match(readFileSync(join(f.top, '.git/info/exclude'), 'utf8'), /^\/\.rna\/$/m);
  assert.equal(git(f.P, ['status', '--porcelain', '--untracked-files=all']).includes('.rna'), false, 'the worktree never shows in P');
  assert.ok(calls.some(args => args[0] === 'worktree' && args[1] === 'add' && args.includes('--detach') && args.includes('--lock')));
  assert.ok(f.engine.calls.some(call => call[0] === 'lock'), 'git add ran under the repository lock');
  // A second worker of the same agent prefix gets the next free name.
  const second = await f.worktrees.create(f.project.id, { kind: 'worker', owner: { agentId: 'agent-1a2b3c4d99' }, parent: parent(f), label: 'x' });
  assert.equal(second.name, 'w-1a2b3c4d-2');
});

test('create: a session worktree pins its seed as base too; .rna already ignored adds nothing to info/exclude', { skip }, async t => {
  const f = fixture(t, { gitignore: '.rna/\n' });
  const before = readFileSync(join(f.top, '.git/info/exclude'), 'utf8');
  const record = await f.worktrees.create(f.project.id, { kind: 'session', id: 'wt-session', owner: { sessionId: f.session.id }, parent: parent(f), label: 'My conversation' });
  assert.equal(record.id, 'wt-session'); assert.equal(record.base, record.seed); assert.match(record.name, /^s-/);
  assert.equal(refOf(f.P, REFS.worktree('wt-session', 'base')), record.seed);
  assert.equal(readFileSync(join(f.top, '.git/info/exclude'), 'utf8'), before);
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).worktree = { id: 'wt-session', state: 'active' }; });
  assert.equal((await f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id })).root, join(f.P, record.dir), 'the resolver confirms what was created');
  await assert.rejects(f.worktrees.create(f.project.id, { kind: 'session', id: 'wt-session', owner: {}, parent: parent(f), label: 'again' }), { code: 'worktree_create_failed' });
});

test('create: a project in a repository subfolder excludes /<prefix>.rna/ and roots the worktree at its prefix', { skip }, async t => {
  const f = fixture(t, { prefix: 'apps/site' });
  const record = await f.worktrees.create(f.project.id, { kind: 'background', owner: { actionId: 'action-9f8e7d6c5b' }, parent: parent(f), label: 'Rna background' });
  assert.equal(record.name, 'b-action9f'); assert.equal(record.prefix, 'apps/site/');
  assert.match(readFileSync(join(f.top, '.git/info/exclude'), 'utf8'), /^\/apps\/site\/\.rna\/$/m);
  assert.ok(existsSync(join(f.P, record.dir, 'apps/site/src/app.js')));
  assert.equal((await f.roots.rootOf({ projectId: f.project.id, actionId: 'action-9f8e7d6c5b' })).root, join(f.P, record.dir, 'apps/site'));
});

test('create: isolation off is worktree_unavailable with its reason; a failure leaves nothing registered', { skip }, async t => {
  const f = fixture(t);
  f.engine.isolationAnswer = { enabled: false, reason: 'not_ready', git: '2.39' };
  await assert.rejects(f.worktrees.create(f.project.id, { kind: 'worker', owner: { agentId: 'a1' }, parent: parent(f), label: 'x' }), { code: 'worktree_unavailable', reason: 'not_ready', status: 409 });
  f.engine.isolationAnswer = { enabled: true, git: '2.39' };
  // Dependencies fail to lay down after git added the worktree: everything is taken back.
  f.worktrees.layDependencies = async () => { throw new Error('disk trouble'); };
  await assert.rejects(f.worktrees.create(f.project.id, { kind: 'worker', id: 'wt-fail', owner: { agentId: 'agent-fail0001' }, parent: parent(f), label: 'x' }), error => error.code === 'worktree_create_failed' && error.status === 500);
  assert.deepEqual(f.store.state.projects.find(row => row.id === f.project.id).git.worktrees, []);
  assert.equal(porcelain(f).includes('w-fail0001'), false, 'git has no entry for it');
  assert.equal(existsSync(join(f.P, WORKTREE_DIR, 'w-fail0001')), false);
  assert.equal(refOf(f.P, REFS.worktree('wt-fail', 'seed')), null, 'its seed ref was dropped');
});

test('checkSpace: at least max(2 GB, 2 × tracked bytes of the parent root), cached per HEAD; the listing never blocks the daemon thread (ISO-10)', { skip }, async t => {
  const f = fixture(t, { files: { 'big.bin': 'x'.repeat(5000) } });
  let free = 10 * 1024 ** 3;
  f.worktrees.statfs = () => ({ bavail: free / 4096, bsize: 4096 });
  // The first answer needs `ls-tree -r -l HEAD`: other work (here a setImmediate) runs while git lists the tree.
  let ticked = false;
  setImmediate(() => { ticked = true; });
  const pending = f.worktrees.checkSpace(f.project.id, parent(f));
  assert.ok(pending instanceof Promise, 'asynchronous');
  const answer = await pending;
  assert.equal(ticked, true, 'the event loop ran while the tracked size was read');
  assert.equal(answer.ok, true); assert.equal(answer.needBytes, LIMITS.freeSpaceMinBytes); assert.equal(answer.freeBytes, free);
  assert.equal(await f.worktrees.trackedBytes(f.P), 5000 + 'dist/\n.env*\n.venv/\n'.length, 'ls-tree -r -l HEAD summed');
  free = 1024 ** 3;
  assert.deepEqual(await f.worktrees.checkSpace(f.project.id, parent(f)), { ok: false, freeBytes: free, needBytes: LIMITS.freeSpaceMinBytes });
  f.worktrees.tracked.set(`${f.P}\0${git(f.P, ['rev-parse', 'HEAD']).trim()}`, 3 * 1024 ** 3);
  free = 5 * 1024 ** 3;
  assert.deepEqual(await f.worktrees.checkSpace(f.project.id, parent(f)), { ok: false, freeBytes: free, needBytes: 6 * 1024 ** 3 }, '2 × tracked when that is larger');
});

test('dependencies: ignored .env files cloned, venvs linked, init-time large files cloned; node_modules left to upward resolution', { skip }, async t => {
  const f = fixture(t);
  writeFileSync(join(f.P, '.env'), 'SECRET=synthetic\n'); writeFileSync(join(f.P, '.env.local'), 'LOCAL=1\n');
  mkdirSync(join(f.P, '.venv/bin'), { recursive: true }); writeFileSync(join(f.P, '.venv/pyvenv.cfg'), 'home = /usr/bin\n');
  mkdirSync(join(f.P, 'venv')); // no pyvenv.cfg: not a venv
  mkdirSync(join(f.P, 'node_modules/pkg'), { recursive: true }); writeFileSync(join(f.P, 'node_modules/pkg/index.js'), '');
  mkdirSync(join(f.P, 'assets')); writeFileSync(join(f.P, 'assets/huge.psd'), 'pretend this is 60 MB');
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).git.init = { at: new Date().toISOString(), by: 'rna', commit: 'x', branch: 'main', largeFiles: ['assets/huge.psd', '../escape', '.git/config'] }; });
  writeFileSync(join(f.P, '.gitignore'), 'dist/\n.env*\n.venv/\nnode_modules/\nassets/huge.psd\n'); git(f.P, ['commit', '-qam', 'ignore more']);
  const record = await f.worktrees.create(f.project.id, { kind: 'worker', owner: { agentId: 'agent-deps0001' }, parent: parent(f), label: 'x' });
  const root = join(f.P, record.dir);
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'SECRET=synthetic\n');
  assert.notEqual(statSync(join(root, '.env')).ino, statSync(join(f.P, '.env')).ino, 'its own copy, not a link');
  assert.ok(existsSync(join(root, '.env.local')));
  assert.equal(lstatSync(join(root, '.venv')).isSymbolicLink(), true); assert.equal(readlinkSync(join(root, '.venv')), join(f.P, '.venv'));
  assert.equal(existsSync(join(root, 'venv')), false);
  assert.equal(existsSync(join(root, 'node_modules')), false, 'node_modules: not handled');
  assert.equal(readFileSync(join(root, 'assets/huge.psd'), 'utf8'), 'pretend this is 60 MB');
  assert.deepEqual(record.laid.map(item => `${item.kind}:${item.path}`).sort(), ['copy:.env', 'copy:.env.local', 'copy:assets/huge.psd', 'link:.venv']);
  // None of them can ride a snapshot back into P: all ignored in the worktree too (the .venv link via an exact line).
  const env = { GIT_DIR: join(f.top, '.git/worktrees', record.name), GIT_WORK_TREE: root };
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=all', '--ignored=no'], { env }), '');
  assert.match(readFileSync(join(f.top, '.git/info/exclude'), 'utf8'), /^\/\.venv$/m);
  assert.equal(git(f.P, ['status', '--porcelain', '--untracked-files=all']), '', 'P unchanged by the extra line');
  // A .env file the repository tracks comes from the checkout and is not laid down.
  const tracked = fixture(t, { files: { '.env.example': 'TRACKED=1\n' }, gitignore: '' });
  const other = await tracked.worktrees.create(tracked.project.id, { kind: 'worker', owner: { agentId: 'agent-track001' }, parent: parent(tracked), label: 'x' });
  assert.equal(readFileSync(join(tracked.P, other.dir, '.env.example'), 'utf8'), 'TRACKED=1\n'); assert.deepEqual(other.laid, []);
});

test('remove: tip pinned, ignored files to the trash, laid files gone, git entry removed; never `worktree prune`', { skip }, async t => {
  const f = fixture(t), calls = spyGit(f);
  writeFileSync(join(f.P, '.env'), 'SECRET=synthetic\n');
  // The user's own worktree elsewhere, whose folder is not there right now (an unmounted disk): prune would drop it.
  const away = join(f.directory, 'user-worktree');
  git(f.P, ['worktree', 'add', '--detach', away, 'HEAD']); rmSync(away, { recursive: true, force: true });
  const record = await f.worktrees.create(f.project.id, { kind: 'worker', owner: { agentId: 'agent-rm000001' }, parent: parent(f), label: 'x' });
  const top = join(f.P, record.dir);
  assert.ok(existsSync(join(top, '.env')), 'a laid-down copy to clean up');
  write(top, 'src/app.js', 'export const a = 3; // the worker\n'); write(top, 'dist/bundle.js', 'built\n'); write(top, 'new.md', 'new\n');
  f.worktrees.setState(f.project.id, record.id, 'kept');
  const removed = await f.worktrees.remove(f.project.id, record.id);
  assert.equal(removed.state, 'removed'); assert.ok(removed.removedAt);
  assert.equal(existsSync(top), false);
  assert.equal(porcelain(f).includes(top), false);
  assert.ok(porcelain(f).includes(away), 'the user’s absent worktree is still registered');
  assert.equal(calls.some(args => args.includes('prune')), false, 'prune never ran');
  const tip = refOf(f.P, REFS.worktree(record.id, 'tip'));
  assert.ok(tip, 'tip pinned');
  assert.equal(git(f.P, ['show', `${tip}:src/app.js`]), 'export const a = 3; // the worker\n');
  assert.equal(git(f.P, ['show', `${tip}:new.md`]), 'new\n');
  const trash = join(f.P, TRASH_DIR), [bin] = readdirSync(trash);
  assert.match(bin, new RegExp(`^${record.id}-\\d{8}T\\d{6}$`));
  assert.equal(readFileSync(join(trash, bin, 'dist/bundle.js'), 'utf8'), 'built\n', 'ignored output kept in the trash');
  assert.equal(existsSync(join(trash, bin, '.env')), false, 'Rna’s own copy of .env is not trash');
  assert.equal(readFileSync(join(f.P, '.env'), 'utf8'), 'SECRET=synthetic\n', 'P’s .env untouched');
  assert.equal((await f.worktrees.remove(f.project.id, record.id)).state, 'removed', 'removing twice is a no-op');
  await assert.rejects(f.roots.rootOf({ projectId: f.project.id, agentId: 'x' }), { code: 'delegation_unknown' });
});

test('remove: a worktree whose folder is gone loses only its own git entry', { skip }, async t => {
  const f = fixture(t);
  const record = await f.worktrees.create(f.project.id, { kind: 'worker', owner: { agentId: 'agent-gone0001' }, parent: parent(f), label: 'x' });
  const top = join(f.P, record.dir);
  rmSync(top, { recursive: true, force: true });
  assert.ok(porcelain(f).includes(top));
  const removed = await f.worktrees.remove(f.project.id, record.id);
  assert.equal(removed.state, 'removed'); assert.equal(porcelain(f).includes(top), false);
});

test('reconcile: an unrecorded worktree becomes a kept orphan with its files pinned (never deleted); a lost one becomes missing', { skip }, async t => {
  const f = fixture(t);
  const orphan = addWorktree(f, { kind: 'worker', id: 'tmp', name: 'w-orphan01' });
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).git.worktrees = []; });
  write(orphan.top, 'src/app.js', 'orphan work\n');
  const lost = await f.worktrees.create(f.project.id, { kind: 'worker', owner: { agentId: 'agent-lost0001' }, parent: parent(f), label: 'x' });
  rmSync(join(f.P, lost.dir), { recursive: true, force: true });
  const result = await f.worktrees.reconcile(f.project.id);
  assert.deepEqual(result, { orphans: ['orphan-w-orphan01'], missing: [lost.id] });
  const row = f.worktrees.record(f.project.id, 'orphan-w-orphan01');
  assert.equal(row.kind, 'orphan'); assert.equal(row.state, 'kept'); assert.equal(row.seed, git(f.P, ['rev-parse', 'HEAD']).trim());
  const pinned = refOf(f.P, REFS.orphan('w-orphan01'));
  assert.equal(git(f.P, ['show', `${pinned}:src/app.js`]), 'orphan work\n');
  assert.ok(existsSync(orphan.top), 'never deleted automatically');
  assert.equal(f.worktrees.record(f.project.id, lost.id).state, 'missing');
  assert.deepEqual(await f.worktrees.reconcile(f.project.id), { orphans: [], missing: [] }, 'idempotent');
  // The orphan can be listed, applied or discarded by the user.
  const listed = await f.worktrees.list(f.project.id);
  assert.deepEqual(listed.worktrees.map(item => [item.id, item.kind, item.state, item.pending.files]), [[lost.id, 'worker', 'missing', 0], ['orphan-w-orphan01', 'orphan', 'kept', 1]]);
});

test('repair after the project folder moved: git entries follow, the resolver answers the new place', { skip }, async t => {
  const f = fixture(t);
  const record = await f.worktrees.create(f.project.id, { kind: 'session', id: 'wt-s', owner: { sessionId: f.session.id }, parent: parent(f), label: 'x' });
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).worktree = { id: 'wt-s', state: 'active' }; });
  const moved = join(f.directory, 'moved-repo');
  renameSync(f.top, moved);
  f.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.workspace = moved; state.sessions.find(row => row.id === f.session.id).workspace = moved; });
  f.roots.invalidate({ projectId: f.project.id });
  await assert.rejects(f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id }), { code: 'root_denied' }, 'git still points at the old place');
  const repaired = await f.worktrees.repair(f.project.id);
  assert.deepEqual(repaired, { repaired: ['wt-s'], missing: [] });
  assert.equal((await f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id })).root, join(moved, record.dir));
  assert.ok(git(moved, ['worktree', 'list', '--porcelain']).includes(join(moved, record.dir)));
});

test('rebuild a lost session worktree from its tip: the files come back, HEAD is the base, unapplied work reads as changes', { skip }, async t => {
  const f = fixture(t);
  const record = await f.worktrees.create(f.project.id, { kind: 'session', id: 'wt-s', owner: { sessionId: f.session.id }, parent: parent(f), label: 'x' });
  const top = join(f.P, record.dir);
  write(top, 'src/app.js', 'unapplied\n');
  await f.engine.snapshot(f.project.id, f.worktrees.rootInfo(record, await f.worktrees.located(f.project.id)), { pin: REFS.worktree('wt-s', 'tip') });
  rmSync(top, { recursive: true, force: true });
  f.worktrees.setState(f.project.id, 'wt-s', 'missing');
  const rebuilt = await f.worktrees.rebuild(f.project.id, 'wt-s', { from: 'tip' });
  assert.equal(rebuilt.state, 'active');
  assert.equal(readFileSync(join(top, 'src/app.js'), 'utf8'), 'unapplied\n');
  const env = { GIT_DIR: join(f.top, '.git/worktrees', record.name), GIT_WORK_TREE: top };
  assert.equal(git(top, ['rev-parse', 'HEAD'], { env }).trim(), record.base);
  assert.match(git(top, ['status', '--porcelain'], { env }), /^ M src\/app\.js$/m);
  assert.match(porcelain(f), /locked Rna session/);
  // From the project folder: a fresh copy of P, seed and base moved there.
  rmSync(top, { recursive: true, force: true });
  write(f.P, 'src/app.js', 'P now\n');
  const fresh = await f.worktrees.rebuild(f.project.id, 'wt-s', { from: 'project' });
  assert.equal(readFileSync(join(top, 'src/app.js'), 'utf8'), 'P now\n'); assert.equal(fresh.base, fresh.seed); assert.notEqual(fresh.seed, record.seed);
  await assert.rejects(f.worktrees.rebuild(f.project.id, 'wt-s', { from: 'tip' }), { code: 'worktree_create_failed' }, 'its folder is there');
});

test('routes: list, then two-step apply and discard of kept / conflicted / orphan worktrees only', { skip }, async t => {
  const f = fixture(t);
  const body = async req => req.body;
  const handle = createWorktreeRoutes({ store: f.store, body, worktrees: f.worktrees });
  const call = async (method, path, input) => { let answer; const handled = await handle({ method, body: input }, { pathname: path, url: new URL(`http://x${path}`), send: (status, payload) => { answer = { status, body: payload }; } }); return handled ? answer : null; };
  const base = `/api/v2/projects/${f.project.id}/worktrees`;
  assert.equal(await call('GET', '/api/v2/projects/x/git'), null, 'other routes fall through');
  const record = await f.worktrees.create(f.project.id, { kind: 'worker', owner: { sessionId: f.session.id, agentId: 'agent-route001' }, parent: parent(f), label: 'x' });
  const top = join(f.P, record.dir);
  write(top, 'src/app.js', 'worker\n');
  const listed = await call('GET', base);
  assert.equal(listed.status, 200); assert.deepEqual(listed.body.isolation, { enabled: true, git: 'fixture' });
  assert.deepEqual(listed.body.worktrees.map(row => [row.id, row.kind, row.path, row.state, row.pending.files]), [[record.id, 'worker', top, 'active', 1]]);
  // Still in use: refused.
  assert.equal((await call('POST', `${base}/${record.id}/apply`, {})).body.code, 'worktree_active');
  f.worktrees.setState(f.project.id, record.id, 'kept');
  f.engine.mergeResult = { ...f.engine.mergeResult, writes: [{ path: 'src/app.js', mode: '100644', oid: 'x' }, { path: 'gone.txt', delete: true }, { path: 'brand-new.txt', mode: '100644', oid: 'y' }], conflicts: [{ path: 'README.md', kind: 'content' }] };
  const preview = await call('POST', `${base}/${record.id}/apply`, {});
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.files, [{ path: 'src/app.js', action: 'modify' }, { path: 'gone.txt', action: 'delete' }, { path: 'brand-new.txt', action: 'create' }]);
  assert.deepEqual(preview.body.conflicts, [{ path: 'README.md', kind: 'content' }]);
  const merged = f.engine.calls.find(call => call[0] === 'merge');
  assert.equal(merged[1].base, record.seed); assert.deepEqual(merged[2], { current: 'current', incoming: 'incoming-worker-route001' });
  assert.equal((await call('POST', `${base}/${record.id}/apply`, { confirm: 'stale' })).body.code, 'worktree_unconfirmed');
  // Changed between the steps: refused.
  write(top, 'src/app.js', 'worker, later\n');
  assert.equal((await call('POST', `${base}/${record.id}/apply`, { confirm: preview.body.confirm })).body.code, 'worktree_changed');
  // Conflicts left: kept as conflicted, the worktree stays.
  const second = await call('POST', `${base}/${record.id}/apply`, {});
  f.engine.applyOutcome = { ...f.engine.applyOutcome, status: 'conflicted', applyId: 'apply-2', conflicts: [{ path: 'README.md', kind: 'content' }] };
  const conflicted = await call('POST', `${base}/${record.id}/apply`, { confirm: second.body.confirm });
  assert.equal(conflicted.status, 200); assert.equal(conflicted.body.worktree.state, 'conflicted'); assert.equal(conflicted.body.applyId, 'apply-2');
  assert.deepEqual(conflicted.body.conflicts, [{ path: 'README.md', kind: 'content' }]);
  const applied = f.engine.calls.filter(call => call[0] === 'apply').at(-1)[1];
  assert.deepEqual([applied.target, applied.mode, applied.cleanOnly, applied.kind, applied.base, applied.source.worktreeId, applied.source.agentId, applied.incomingRoot.worktreeId], ['project', 'all', true, 'worker', record.seed, record.id, 'agent-route001', record.id]);
  assert.ok(existsSync(top));
  // Clean and verified: applied, then the worktree is removed.
  const third = await call('POST', `${base}/${record.id}/apply`, {});
  f.engine.applyOutcome = { ...f.engine.applyOutcome, status: 'applied', applyId: 'apply-3', conflicts: [], verify: 'verified' };
  const done = await call('POST', `${base}/${record.id}/apply`, { confirm: third.body.confirm });
  assert.equal(done.body.worktree.state, 'removed'); assert.equal(done.body.applyId, 'apply-3'); assert.equal(existsSync(top), false);
  assert.equal((await call('POST', `${base}/${record.id}/apply`, {})).body.code, 'worktree_not_found');
  // Discard: lists what would be dropped, then removes; the tip stays pinned.
  const other = await f.worktrees.create(f.project.id, { kind: 'worker', owner: { agentId: 'agent-drop0001' }, parent: parent(f), label: 'x' });
  write(join(f.P, other.dir), 'src/app.js', 'dropped\n'); write(join(f.P, other.dir), 'added.md', 'a\n'); rmSync(join(f.P, other.dir, 'README.md'));
  f.worktrees.setState(f.project.id, other.id, 'conflicted');
  const drop = await call('POST', `${base}/${other.id}/discard`, {});
  assert.deepEqual(drop.body.files.sort((a, b) => (a.path < b.path ? -1 : 1)), [{ path: 'README.md', action: 'delete' }, { path: 'added.md', action: 'create' }, { path: 'src/app.js', action: 'modify' }]);
  assert.equal((await call('POST', `${base}/${other.id}/apply`, { confirm: drop.body.confirm })).body.code, 'worktree_unconfirmed', 'a discard token does not apply');
  const drop2 = await call('POST', `${base}/${other.id}/discard`, {});
  const gone = await call('POST', `${base}/${other.id}/discard`, { confirm: drop2.body.confirm });
  assert.equal(gone.body.worktree.state, 'removed'); assert.equal(existsSync(join(f.P, other.dir)), false);
  assert.equal(git(f.P, ['show', `${refOf(f.P, REFS.worktree(other.id, 'tip'))}:src/app.js`]), 'dropped\n');
  // Read-only projects cannot apply or discard; unknown keys are refused.
  const third2 = await f.worktrees.create(f.project.id, { kind: 'worker', owner: { agentId: 'agent-ro000001' }, parent: parent(f), label: 'x' });
  f.worktrees.setState(f.project.id, third2.id, 'kept');
  assert.equal((await call('POST', `${base}/${third2.id}/apply`, { paths: [] })).body.code, 'worktree_request_invalid');
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).permissions.workspace = 'read'; });
  assert.deepEqual([(await call('POST', `${base}/${third2.id}/discard`, {})).status, (await call('POST', `${base}/${third2.id}/discard`, {})).body.code], [403, 'git_read_only']);
  const missing = await call('POST', `${base}/nope/apply`, {});
  assert.deepEqual([missing.status, missing.body.code, missing.body.worktreeId], [404, 'worktree_not_found', 'nope']);
});

test('ownerOf marks Rna’s worktrees for the git panel', { skip }, async t => {
  const f = fixture(t);
  const record = await f.worktrees.create(f.project.id, { kind: 'worker', owner: { sessionId: f.session.id, agentId: 'agent-own00001' }, parent: parent(f), label: 'x' });
  assert.deepEqual(f.worktrees.ownerOf(join(f.P, record.dir)), { rna: true, owner: f.session.id, kind: 'worker', worktreeId: record.id });
  assert.deepEqual(f.worktrees.ownerOf(f.P), { rna: false, owner: null });
});

test('sweep: removed rows and their refs after 30 days, trash after 7 days, only inside the trash folder', { skip }, async t => {
  const f = fixture(t), day = 86400000;
  const record = await f.worktrees.create(f.project.id, { kind: 'worker', owner: { agentId: 'agent-sweep001' }, parent: parent(f), label: 'x' });
  write(join(f.P, record.dir), 'dist/out.js', 'x\n');
  await f.worktrees.remove(f.project.id, record.id);
  const now = Date.now();
  assert.deepEqual(await f.worktrees.sweep({ now }), { rows: 0, trash: 0 }, 'nothing old yet');
  const bin = join(f.P, TRASH_DIR), [entry] = readdirSync(bin), old = (now - 8 * day) / 1000;
  utimesSync(join(bin, entry), old, old);
  const outside = join(f.directory, 'outside-keep'); mkdirSync(outside); utimesSync(outside, old, old);
  assert.deepEqual(await f.worktrees.sweep({ now }), { rows: 0, trash: 1 });
  assert.equal(existsSync(join(bin, entry)), false); assert.ok(existsSync(outside));
  assert.ok(refOf(f.P, REFS.worktree(record.id, 'tip')));
  assert.deepEqual(await f.worktrees.sweep({ now: now + 31 * day }), { rows: 1, trash: 0 });
  assert.equal(f.worktrees.record(f.project.id, record.id), null);
  assert.equal(refOf(f.P, REFS.worktree(record.id, 'tip')), null); assert.equal(refOf(f.P, REFS.worktree(record.id, 'seed')), null);
});

// §9 "Vite 预览的禁止规则": Vite matches fs.deny against absolute paths, so the rules start at the root.
const picomatchPath = fileURLToPath(new URL('../web/node_modules/picomatch/index.js', import.meta.url));
test('Vite preview under .rna/: files of the root are served, private ones and nested .rna stay denied', { skip: !existsSync(picomatchPath) }, async t => {
  const { default: picomatch } = await import(picomatchPath);
  const root = '/Users/x/Documents/独立开发项目/Ai 应用调研项目 (copy)/.rna/worktrees.nosync/s-1a2b3c4d';
  // The same options Vite builds its fsDenyGlob with.
  const denied = patterns => picomatch(patterns.map(pattern => (pattern.includes('/') ? pattern : `**/${pattern}`)), { matchBase: false, nocase: true, dot: true });
  const rooted = denied(previewDeniedPatterns(root, ['/state/state.json']));
  assert.equal(rooted(`${root}/index.html`), false); assert.equal(rooted(`${root}/src/main.ts`), false);
  assert.equal(rooted(`${root}/.env`), true); assert.equal(rooted(`${root}/sub/.env.local`), true); assert.equal(rooted(`${root}/.git`), true, 'the .git link file too');
  assert.equal(rooted(`${root}/.git/config`), true); assert.equal(rooted(`${root}/sub/.rna/worktrees.nosync/other/x.js`), true); assert.equal(rooted(`${root}/keys/id_rsa`), true);
  assert.equal(rooted('/state/state.json.rna/journal'), true);
  // The 0.62 rules denied every file of such a root.
  const old = denied(['**/.env', ...['.git', '.rna'].map(name => `**/${name}/**`)]);
  assert.equal(old(`${root}/index.html`), true);
  assert.equal(escapeGlob('/a (b)/c*[d]'), '/a \\(b\\)/c\\*\\[d\\]');
  // Vite itself resolves from the project folder P, as Node does from a worktree (no node_modules of its own).
  const f = fixture(t);
  const record = await f.worktrees.create(f.project.id, { kind: 'session', id: 'wt-vite', owner: { sessionId: f.session.id }, parent: parent(f), label: 'x' });
  const S = join(f.P, record.dir);
  write(f.P, 'node_modules/vite/dist/node/index.js', 'export {}\n');
  assert.equal(await viteEntryFor({ root: S, project: f.P, directory: join(S, 'src') }), join(f.P, 'node_modules/vite/dist/node/index.js'));
  assert.equal(await viteEntryFor({ root: f.P, project: f.P, directory: join(f.P, 'src') }), null, 'in P itself only the previewed folder’s own node_modules counts, as before');
  assert.equal(await viteEntryFor({ root: f.P, project: f.P, directory: f.P }), join(f.P, 'node_modules/vite/dist/node/index.js'));
});

// The seam with T1's engine: the real IsolationEngine (release gate forced open for the test) snapshots, pins, locks
// and applies; this service creates, lays down, lists, applies a kept worktree into P and removes it.
test('with the real merge engine: create from P with uncommitted work, apply a kept worker back, remove it', { skip }, async t => {
  const { IsolationEngine } = await import('../git-isolation/index.mjs');
  const f = fixture(t);
  const engine = new IsolationEngine(f.store, { git: f.git, ready: true, sandbox: () => true, pollMs: 5 });
  f.worktrees.engine = engine;
  write(f.P, 'notes/user.md', 'the user’s own draft\n');
  const record = await f.worktrees.create(f.project.id, { kind: 'worker', owner: { sessionId: f.session.id, agentId: 'agent-real0001' }, parent: parent(f), label: 'Rna worker agent-real0001' });
  const top = join(f.P, record.dir);
  assert.equal(readFileSync(join(top, 'notes/user.md'), 'utf8'), 'the user’s own draft\n', 'the seed holds untracked work');
  write(top, 'src/app.js', 'export const a = 42; // worker\n'); write(top, 'docs/new.md', 'from the worker\n');
  write(f.P, 'notes/user.md', 'the user’s own draft, edited meanwhile\n');
  f.worktrees.setState(f.project.id, record.id, 'kept');
  const listed = await f.worktrees.list(f.project.id);
  assert.equal(listed.worktrees[0].pending.files, 2);
  const preview = await f.worktrees.applyWorktree(f.project.id, record.id, {});
  assert.deepEqual(preview.files.map(row => `${row.action}:${row.path}`).sort(), ['create:docs/new.md', 'modify:src/app.js']);
  assert.deepEqual(preview.conflicts, []);
  const done = await f.worktrees.applyWorktree(f.project.id, record.id, { confirm: preview.confirm });
  assert.ok(done.applyId); assert.equal(done.worktree.state, 'removed');
  assert.equal(readFileSync(join(f.P, 'src/app.js'), 'utf8'), 'export const a = 42; // worker\n');
  assert.equal(readFileSync(join(f.P, 'docs/new.md'), 'utf8'), 'from the worker\n');
  assert.equal(readFileSync(join(f.P, 'notes/user.md'), 'utf8'), 'the user’s own draft, edited meanwhile\n', 'the user’s edit is kept');
  assert.equal(existsSync(top), false);
  assert.ok(refOf(f.P, REFS.worktree(record.id, 'tip')));
  assert.ok(refOf(f.P, REFS.apply(done.applyId)), 'the apply has its checkpoint');
  // A kept worktree that conflicts: the clean part goes in, the conflicting file stays, the worktree is kept.
  const second = await f.worktrees.create(f.project.id, { kind: 'worker', owner: { agentId: 'agent-real0002' }, parent: parent(f), label: 'x' });
  write(join(f.P, second.dir), 'README.md', 'worker README\n'); write(join(f.P, second.dir), 'clean.md', 'clean\n');
  write(f.P, 'README.md', 'user README\n');
  f.worktrees.setState(f.project.id, second.id, 'kept');
  const ask = await f.worktrees.applyWorktree(f.project.id, second.id, {});
  assert.deepEqual(ask.conflicts.map(row => row.path), ['README.md']);
  const partly = await f.worktrees.applyWorktree(f.project.id, second.id, { confirm: ask.confirm });
  assert.equal(partly.worktree.state, 'conflicted'); assert.deepEqual(partly.conflicts.map(row => row.path), ['README.md']);
  assert.equal(readFileSync(join(f.P, 'clean.md'), 'utf8'), 'clean\n');
  assert.equal(readFileSync(join(f.P, 'README.md'), 'utf8'), 'user README\n', 'no conflict marker, the user’s side untouched');
  assert.ok(existsSync(join(f.P, second.dir)));
});
