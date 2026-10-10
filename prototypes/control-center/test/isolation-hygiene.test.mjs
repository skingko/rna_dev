// B8 isolation hygiene (plan reference-alignment-20261005 §2.2 B8; review ISO-6, ISO-8, ISO-10; mu
// kyrn/docs/features/checkpoints.md §2): secret files never reach refs/rna and never take part in a merge, private
// indexes and pre-merge pins do not leak, `git gc --auto` only on a repository Rna initialized with no commit of the
// user's, the read-only storage view, apply timings and bytes, and a worktree checkout that no longer holds the
// repository lock. Real temporary repositories, the real engine and worktree service; no network, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git, put, read, skip } from './git-isolation-fixture.mjs';
import { RootResolver } from '../workspace-roots.mjs';
import { WorktreeService } from '../worktree-service.mjs';
import { IsolationStorage, LIMITS, MERGE_LABELS, REFS, SECRET_FILES, TRASH_DIR, isSecretPath, notMergedOf } from '../git-isolation/index.mjs';
import { privateIndexPath } from '../git-isolation/snapshot.mjs';
import { applyAggregates, orphanIndexes, parseCountObjects, repositoryOwner } from '../git-isolation/storage.mjs';
import { createServer } from '../server.mjs';

const DAY = 86400000;
/** Blob ids of contents, as git would name them (`hash-object` without -w: nothing is written). */
const blobOf = (repo, content) => execFileSync('git', ['hash-object', '--stdin'], { cwd: repo, input: content, encoding: 'utf8' }).trim();
/** Every object the repository's store holds, reachable or not. */
const allObjects = repo => new Set(git(repo, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)').split('\n').filter(Boolean));
const services = f => {
  const roots = new RootResolver(f.store, { git: f.service });
  const worktrees = new WorktreeService(f.store, { git: f.service, engine: f.engine, roots });
  f.service.owners = path => worktrees.ownerOf(path);
  return { roots, worktrees };
};
const project = f => f.store.state.projects.find(row => row.id === f.project.id);

test('the secret table is mu\'s: .env and friends, keys and certificates match at any depth; examples and public keys do not', () => {
  assert.deepEqual(SECRET_FILES, ['*.env', '.env.*', '!.env.example', '!.env.sample', '!.env.template', '.envrc', '.netrc', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']);
  for (const path of ['.env', '.env.local', 'config/prod.env', '.ENV', '.envrc', 'home/.netrc', 'certs/server.pem', 'certs/server.key', 'a.p12', 'b.pfx', 'deploy/id_rsa', 'deploy/id_ed25519', 'keys.pem/notes.txt']) assert.equal(isSecretPath(path), true, path);
  for (const path of ['.env.example', '.env.sample', '.env.template', 'deploy/id_ed25519.pub', 'environment.ts', 'env/settings.json', 'README.md', 'keys/readme.txt']) assert.equal(isSecretPath(path), false, path);
});

test('secret files never enter the object store: not from P\'s snapshots, a worker\'s copy, its merge or a discard; the merge reports what the worker changed', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'one\n', 'settings/app.pem': 'COMMITTED-PEM\n', '.gitignore': 'dist/\n' } });
  const { worktrees } = services(f);
  // Untracked, not ignored: a repository that never ignored them (Rna's own git init ignores .env*; the user's may not).
  const secrets = { '.env': 'API_KEY=synthetic-env-1\n', 'config/prod.env': 'DB_PASSWORD=synthetic-prod\n', 'certs/server.key': 'SYNTHETIC KEY BODY\n', 'deploy/id_ed25519': 'SYNTHETIC SSH KEY\n' };
  for (const [path, content] of Object.entries(secrets)) put(f.workspace, path, content);
  put(f.workspace, '.env.example', 'API_KEY=\n'); put(f.workspace, 'deploy/id_ed25519.pub', 'ssh-ed25519 SYNTHETICPUB\n');
  put(f.workspace, 'settings/app.pem', 'CHANGED-PEM\n'); // a tracked secret file, changed in the folder

  // A direct-mode checkpoint of P.
  const start = await f.engine.snapshot(f.project.id, f.root, { pin: REFS.turn('t-secrets') });
  assert.deepEqual([...start.secret].sort(), ['.env', 'certs/server.key', 'config/prod.env', 'deploy/id_ed25519', 'settings/app.pem']);
  const files = git(f.repo, 'ls-tree', '-r', '--name-only', start.commit).split('\n').filter(Boolean);
  assert.deepEqual(files.sort(), ['.env.example', '.gitignore', 'a.txt', 'deploy/id_ed25519.pub', 'settings/app.pem']);
  assert.equal(git(f.repo, 'show', `${start.commit}:settings/app.pem`), 'COMMITTED-PEM\n', 'a tracked one stays at HEAD\'s version');

  // A worker's copy: made from P, the secret files laid down as they are in P (the seed left them out).
  const record = await worktrees.create(f.project.id, { kind: 'worker', owner: { sessionId: 's1', turnId: 't1', agentId: 'agent-secrets01' }, parent: f.root, label: 'Rna worker' });
  const W = join(f.workspace, record.dir), wRoot = worktrees.rootInfo(record, { workspace: f.workspace, commonDir: f.commonDir, prefix: '' });
  for (const [path, content] of Object.entries(secrets)) assert.equal(read(W, path), content, `${path} laid down`);
  assert.equal(read(W, 'settings/app.pem'), 'CHANGED-PEM\n', 'the folder\'s version, not HEAD\'s');
  assert.ok(record.laid.some(row => row.path === '.env'));
  assert.doesNotMatch(readFileSync(join(f.commonDir, 'info', 'exclude'), 'utf8'), /\.env/, 'no exclude line that would hide P\'s own .env from git status');
  assert.match(git(f.workspace, 'status', '--porcelain', '--untracked-files=all'), /\?\? \.env\n/, 'P still shows its .env');
  // The worker changes a normal file, its .env and adds a key.
  put(W, 'a.txt', 'one\ntwo by worker\n'); put(W, '.env', 'API_KEY=synthetic-env-2\n'); put(W, 'new.key', 'SYNTHETIC NEW KEY\n');
  const tip = await f.engine.snapshot(f.project.id, wRoot, { pin: REFS.worktree(record.id, 'tip') });
  assert.deepEqual([...tip.secret].sort(), ['.env', 'new.key'], 'only what the worker changed: its untouched copies are no news');
  const outcome = await f.engine.apply(f.project.id, { target: f.root, base: record.seed, incoming: tip.commit, kind: 'worker', source: { sessionId: 's1', turnId: 't1', agentId: 'agent-secrets01', worktreeId: record.id }, mode: 'partial', labels: MERGE_LABELS.worker('agent-secrets01'), incomingRoot: wRoot, notMerged: notMergedOf(tip) });
  assert.equal(outcome.status, 'applied'); assert.deepEqual(outcome.written, ['a.txt']);
  assert.deepEqual(outcome.notMerged, [{ path: '.env', reason: 'secret' }, { path: 'new.key', reason: 'secret' }]);
  assert.equal(read(f.workspace, '.env'), secrets['.env'], 'P\'s .env is never written by a merge');
  assert.equal(existsSync(join(f.workspace, 'new.key')), false);
  assert.equal(read(f.workspace, 'a.txt'), 'one\ntwo by worker\n');

  // The panel's discard of a secret file: no checkpoint could hold it, so nothing is discarded.
  await assert.rejects(f.engine.discardCheckpoint(f.project.id, [{ path: '.env', action: 'delete' }]), error => error.code === 'checkpoint_secret' && error.status === 409 && error.paths.includes('.env'));
  await assert.rejects(f.engine.discardCheckpoint(f.project.id, [{ path: 'config/', action: 'delete' }]), error => error.code === 'checkpoint_secret' && error.paths.includes('config/prod.env'));
  assert.equal(read(f.workspace, '.env'), secrets['.env']);

  // Removing W: the secret files its owner changed go to the trash, not with the folder.
  await worktrees.remove(f.project.id, record.id);
  const trash = join(f.workspace, ...TRASH_DIR.split('/')), moved = readdirSync(trash).map(name => join(trash, name));
  assert.ok(moved.some(folder => existsSync(join(folder, '.env')) && read(folder, '.env') === 'API_KEY=synthetic-env-2\n'), 'the changed .env is kept in the trash');
  assert.ok(moved.some(folder => existsSync(join(folder, 'new.key'))));

  // The acceptance check: no version of any secret file is an object of the repository, reachable or not.
  const objects = allObjects(f.repo);
  for (const content of [...Object.values(secrets), 'API_KEY=synthetic-env-2\n', 'SYNTHETIC NEW KEY\n', 'CHANGED-PEM\n']) assert.equal(objects.has(blobOf(f.repo, content)), false, `never hashed: ${content.trim()}`);
  // Controls: the snapshots did run over the files around them.
  for (const content of ['API_KEY=\n', 'ssh-ed25519 SYNTHETICPUB\n', 'one\ntwo by worker\n', 'COMMITTED-PEM\n']) assert.equal(objects.has(blobOf(f.repo, content)), true, `snapshotted: ${content.trim()}`);
});

test('a laid-down secret copy nobody touched is no change of its owner\'s, whatever its source file became; a worker made from a conversation worktree included', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'one\n' } });
  const { worktrees } = services(f);
  const located = { workspace: f.workspace, commonDir: f.commonDir, prefix: '' };
  const trashed = id => { const trash = join(f.workspace, ...TRASH_DIR.split('/')); return existsSync(trash) ? readdirSync(trash).filter(name => name.startsWith(`${id}-`)) : []; };
  put(f.workspace, '.env', 'API_KEY=synthetic-1\n'); // neither committed nor ignored
  const worker = await worktrees.create(f.project.id, { kind: 'worker', owner: { agentId: 'agent-stale001' }, parent: f.root, label: 'w' });
  const copy = worker.laid.find(row => row.path === '.env');
  assert.ok(copy && [copy.size, copy.mtimeMs, copy.ino].every(Number.isFinite), 'the copy\'s own facts are recorded, never its bytes');
  assert.equal(JSON.stringify(worker.laid).includes('synthetic'), false);
  // The user edits P's .env while the worker runs; the worker never touches its copy.
  put(f.workspace, '.env', 'API_KEY=synthetic-user-edit\n');
  const tip = await f.engine.snapshot(f.project.id, worktrees.rootInfo(worker, located));
  assert.deepEqual(tip.secret, [], 'not the worker\'s change'); assert.deepEqual(notMergedOf(tip), []);
  await worktrees.remove(f.project.id, worker.id);
  assert.deepEqual(trashed(worker.id), [], 'a stale copy is not kept in the trash as if it were the worker\'s work');

  // A conversation worktree S changes its copy; a worker made from S gets S's version, untouched: no change of its own.
  const S = await worktrees.create(f.project.id, { kind: 'session', id: 'wt-s-secret', owner: { sessionId: 's-secret' }, parent: f.root, label: 'conversation' });
  const sRoot = worktrees.rootInfo(S, located);
  put(sRoot.root, '.env', 'API_KEY=synthetic-conversation\n');
  assert.deepEqual((await f.engine.snapshot(f.project.id, sRoot)).secret, ['.env'], 'the conversation\'s own change');
  const child = await worktrees.create(f.project.id, { kind: 'worker', owner: { sessionId: 's-secret', agentId: 'agent-child001' }, parent: sRoot, label: 'w2' });
  const cRoot = worktrees.rootInfo(child, located);
  assert.equal(read(cRoot.root, '.env'), 'API_KEY=synthetic-conversation\n', 'laid down from its parent, S');
  assert.deepEqual((await f.engine.snapshot(f.project.id, cRoot)).secret, [], 'compared with what was laid there, not with P');
  // Its own change is still its own, and goes to the trash with it.
  put(cRoot.root, '.env', 'API_KEY=synthetic-child\n');
  assert.deepEqual((await f.engine.snapshot(f.project.id, cRoot)).secret, ['.env']);
  await worktrees.remove(f.project.id, child.id);
  const [folder] = trashed(child.id);
  assert.equal(read(join(f.workspace, ...TRASH_DIR.split('/'), folder), '.env'), 'API_KEY=synthetic-child\n');
});

test('the panel\'s discard of a secret file answers 409 checkpoint_secret naming the files, over HTTP too', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'one\n' } });
  put(f.workspace, 'config/prod.env', 'DB_PASSWORD=synthetic-route\n');
  f.store.close();
  const app = createServer({ stateFile: f.store.file, ticks: false, runtime: false });
  await app.initializer.close();
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  t.after(() => app.close());
  const call = (path, body) => fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async response => ({ status: response.status, body: await response.json() }));
  const route = `/api/v2/projects/${f.project.id}/git/discard`;
  const preview = await call(route, { paths: ['config/'] });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const refused = await call(route, { paths: ['config/'], confirm: preview.body.confirm });
  assert.equal(refused.status, 409); assert.equal(refused.body.code, 'checkpoint_secret');
  assert.deepEqual(refused.body.paths, ['config/prod.env'], 'the body names the files, as the contract says');
  assert.equal(read(f.workspace, 'config/prod.env'), 'DB_PASSWORD=synthetic-route\n', 'nothing discarded');
});

test('a private index written before the secret table is rebuilt once: what it took in leaves the next snapshot', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'one\n' } });
  put(f.workspace, '.env', 'API_KEY=synthetic-legacy\n');
  // As an older Rna left it: .env added to the root's private index, notes without the secret table's version.
  const index = privateIndexPath(f.commonDir, f.workspace);
  mkdirSync(join(f.commonDir, 'rna', 'index'), { recursive: true });
  execFileSync('git', ['read-tree', 'HEAD'], { cwd: f.workspace, env: { ...process.env, GIT_INDEX_FILE: index } });
  execFileSync('git', ['update-index', '--add', '--', '.env'], { cwd: f.workspace, env: { ...process.env, GIT_INDEX_FILE: index } });
  const facts = path => { try { const info = statSync(path); return [info.size, info.mtimeMs, info.ino]; } catch { return null; } };
  const head = git(f.repo, 'rev-parse', 'HEAD').trim();
  writeFileSync(`${index}.json`, JSON.stringify({ head, ignores: JSON.stringify([facts(join(f.commonDir, 'info', 'exclude')), null]), tree: null, at: new Date().toISOString() }));
  const snapshot = await f.engine.snapshot(f.project.id, f.root);
  assert.equal(git(f.repo, 'ls-tree', '-r', '--name-only', snapshot.commit).split('\n').includes('.env'), false);
  assert.deepEqual(snapshot.secret, ['.env']);
});

test('ISO-6: a removed worktree takes its private index along; the sweep deletes orphaned ones past retention and keeps live roots\' and fresh ones', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'one\n' } });
  const { worktrees } = services(f);
  const folder = join(f.commonDir, 'rna', 'index');
  const kept = await worktrees.create(f.project.id, { kind: 'worker', owner: { agentId: 'agent-kept0001' }, parent: f.root, label: 'kept' });
  const gone = await worktrees.create(f.project.id, { kind: 'background', owner: { actionId: 'action-gone0001' }, parent: f.root, label: 'gone' });
  const located = { workspace: f.workspace, commonDir: f.commonDir, prefix: '' };
  for (const record of [kept, gone]) await f.engine.snapshot(f.project.id, worktrees.rootInfo(record, located));
  const goneIndex = privateIndexPath(f.commonDir, worktrees.rootInfo(gone, located).root);
  assert.ok(existsSync(goneIndex) && existsSync(`${goneIndex}.json`));
  await worktrees.remove(f.project.id, gone.id);
  assert.equal(existsSync(goneIndex), false, 'remove() dropped the index'); assert.equal(existsSync(`${goneIndex}.json`), false);

  // Leftovers of crashes or older releases: an orphan past retention goes, a fresh orphan stays; the live roots (P,
  // the kept worktree) stay whatever their age; a file of another shape is never touched.
  const old = (Date.now() - (LIMITS.retentionDays + 1) * DAY) / 1000;
  const orphan = join(folder, 'abcdef0123456789'), fresh = join(folder, '0123456789abcdef'), stranger = join(folder, 'notes.txt');
  for (const path of [orphan, `${orphan}.json`, fresh, stranger]) writeFileSync(path, 'x');
  for (const path of [orphan, `${orphan}.json`, stranger]) utimesSync(path, old, old);
  // Index and notes both as old as the orphan's (an idle conversation worktree, a kept worker copy: no snapshot for
  // longer than the retention period), so only liveness keeps them.
  const live = [privateIndexPath(f.commonDir, f.workspace), privateIndexPath(f.commonDir, worktrees.rootInfo(kept, located).root)].flatMap(path => [path, `${path}.json`]);
  for (const path of live) { assert.ok(existsSync(path), `snapshotted: ${path}`); utimesSync(path, old, old); }
  const swept = await f.engine.sweep();
  assert.equal(swept.indexesDeleted, 1);
  assert.equal(existsSync(orphan), false); assert.equal(existsSync(`${orphan}.json`), false);
  assert.ok(existsSync(fresh), 'too fresh to tell'); assert.ok(existsSync(stranger), 'not an index name');
  for (const path of live) assert.ok(existsSync(path), `live root kept: ${path}`);
});

test('ISO-6: a session worktree\'s pre-merge pin goes when the worktree is removed, and with expired rows', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'one\n' } });
  const { worktrees } = services(f);
  const record = await worktrees.create(f.project.id, { kind: 'session', id: 'wt-premerge', owner: { sessionId: 's-pre' }, parent: f.root, label: 'conversation' });
  await f.engine.pin(f.project.id, [{ ref: REFS.worktree(record.id, 'premerge'), commit: record.seed }]);
  await worktrees.remove(f.project.id, record.id);
  assert.equal(f.refs().includes(REFS.worktree(record.id, 'premerge')), false, 'cleared with the worktree');
  assert.ok(f.refs().includes(REFS.worktree(record.id, 'tip')), 'its tip stays through retention');
  // A row removed before this release (premerge left behind) loses it with its other refs past retention.
  await f.engine.pin(f.project.id, [{ ref: REFS.worktree(record.id, 'premerge'), commit: record.seed }]);
  f.store.mutate(state => { const row = state.projects.find(item => item.id === f.project.id).git.worktrees.find(item => item.id === record.id); row.removedAt = new Date(Date.now() - (LIMITS.retentionDays + 1) * DAY).toISOString(); });
  await worktrees.sweep();
  assert.deepEqual(f.refs().filter(ref => ref.startsWith(`refs/rna/wt/${record.id}/`)), []);
});

/** Two packs in the repository (gc --auto with gc.autoPackLimit=1 then consolidates them). */
function twoPacks(f) {
  const objects = git(f.repo, 'rev-list', '--objects', '--all').split('\n').filter(Boolean).map(line => line.split(' ')[0]);
  const pack = ids => execFileSync('git', ['pack-objects', '-q', join(f.commonDir, 'objects', 'pack', 'pack')], { cwd: f.repo, input: `${ids.join('\n')}\n`, encoding: 'utf8' });
  pack(objects.slice(0, 1)); pack(objects.slice(1));
  git(f.repo, 'config', 'gc.autoPackLimit', '1');
}
const packs = f => readdirSync(join(f.commonDir, 'objects', 'pack')).filter(name => name.endsWith('.pack')).length;

test('gc: `git gc --auto` runs under the lock only on a repository Rna initialized that holds no commit of the user\'s', { skip }, async t => {
  // Rna's git init, nothing committed since: collected.
  const rna = fixture(t, { files: { 'a.txt': 'one\n' } });
  rna.store.mutate(state => { state.projects.find(row => row.id === rna.project.id).git = { sessionWorktreeDefault: false, worktrees: [], applies: [], init: { at: new Date().toISOString(), by: 'rna', commit: git(rna.repo, 'rev-parse', 'HEAD').trim(), branch: 'main' } }; });
  twoPacks(rna);
  assert.equal(packs(rna), 2);
  const swept = await rna.engine.sweep();
  assert.deepEqual(swept.collected, [rna.commonDir]);
  assert.equal(packs(rna), 1, 'gc --auto consolidated the packs');
  assert.equal(git(rna.repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1);

  // The same repository after the user committed: the user's, reported only.
  const user = fixture(t, { files: { 'a.txt': 'one\n' } });
  const first = git(user.repo, 'rev-parse', 'HEAD').trim();
  put(user.workspace, 'b.txt', 'mine\n'); git(user.repo, 'add', '-A'); git(user.repo, 'commit', '-q', '-m', 'the user\'s');
  user.store.mutate(state => { state.projects.find(row => row.id === user.project.id).git = { sessionWorktreeDefault: false, worktrees: [], applies: [], init: { at: new Date().toISOString(), by: 'rna', commit: first, branch: 'main' } }; });
  twoPacks(user);
  const untouched = await user.engine.sweep();
  assert.deepEqual(untouched.collected, []);
  assert.equal(packs(user), 2, 'never collected');
  // A repository Rna never initialized: the user's too.
  const plain = fixture(t, { files: { 'a.txt': 'one\n' } });
  twoPacks(plain);
  assert.deepEqual((await plain.engine.sweep()).collected, []);
  assert.equal(packs(plain), 2);
});

test('gc is skipped while a turn of a project on the repository runs', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'one\n' } });
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).git = { sessionWorktreeDefault: false, worktrees: [], applies: [], init: { at: new Date().toISOString(), by: 'rna', commit: git(f.repo, 'rev-parse', 'HEAD').trim(), branch: 'main' } }; });
  twoPacks(f);
  const session = f.store.state.sessions.find(row => row.projectId === f.project.id);
  f.store.mutate(state => { state.sessions.find(row => row.id === session.id).status = 'running'; });
  assert.deepEqual((await f.engine.sweep()).collected, []);
  assert.equal(packs(f), 2);
});

test('storage: owner, orphan indexes, count-objects and apply aggregates are pure functions of the facts', () => {
  assert.equal(repositoryOwner({ inits: [{ by: 'rna', commit: 'c1', workspace: '/p' }], top: '/p', reachable: ['c1'] }), 'rna');
  assert.equal(repositoryOwner({ inits: [{ by: 'rna', commit: 'c1', workspace: '/p' }], top: '/p', reachable: ['c2', 'c1'] }), 'user', 'a commit of the user\'s');
  assert.equal(repositoryOwner({ inits: [{ by: 'rna', commit: 'c1', workspace: '/p/sub' }], top: '/p', reachable: ['c1'] }), 'user', 'initialized elsewhere');
  assert.equal(repositoryOwner({ inits: [], top: '/p', reachable: ['c1'] }), 'user');
  assert.equal(repositoryOwner({ inits: [{ by: 'rna', commit: 'c1', workspace: '/p' }], top: '/p', reachable: null }), 'user', 'unreadable: the user\'s');
  const entries = [{ name: 'aaaaaaaaaaaaaaaa', file: true, mtimeMs: 1 }, { name: 'aaaaaaaaaaaaaaaa.json', file: true, mtimeMs: 1 }, { name: 'bbbbbbbbbbbbbbbb', file: true, mtimeMs: 1 }, { name: 'cccccccccccccccc', file: true, mtimeMs: 1 }, { name: 'cccccccccccccccc.json', file: true, mtimeMs: 50 }, { name: 'dddddddddddddddd', file: false, mtimeMs: 1 }, { name: 'stray', file: true, mtimeMs: 1 }];
  assert.deepEqual(orphanIndexes({ entries, live: new Set(['bbbbbbbbbbbbbbbb']), cutoffMs: 10 }), ['aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa.json']);
  assert.deepEqual(parseCountObjects('count: 3\nsize: 12\nin-pack: 40\npacks: 2\nsize-pack: 100\nprune-packable: 0\ngarbage: 0\nsize-garbage: 0\n'), { looseObjects: 3, looseBytes: 12 * 1024, packedObjects: 40, packs: 2, packBytes: 100 * 1024, garbageBytes: 0 });
  assert.deepEqual(applyAggregates([{ kind: 'worker', state: 'verified', ms: 10, bytes: 5 }, { kind: 'worker', state: 'verified', ms: 30, bytes: 7 }, { kind: 'worker', state: 'writing' }, { kind: 'turn', state: 'interrupted' }]), { byKind: { worker: { count: 3, timed: 2, p50Ms: 10, p95Ms: 30, bytes: 12 }, turn: { count: 1, timed: 0, p50Ms: null, p95Ms: null, bytes: 0 } }, writing: 1, interrupted: 1 });
});

test('ISO-8: an apply record carries how long its write took and the bytes it wrote', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'one\n' } });
  const now = await f.engine.snapshot(f.project.id, f.root);
  const blob = blobOf(f.repo, 'twelve bytes');
  execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.repo, input: 'twelve bytes' });
  const incoming = await f.engine.compose(f.project.id, now.commit, [{ path: 'b.txt', mode: '100644', oid: blob }]);
  const outcome = await f.engine.apply(f.project.id, { target: f.root, base: now.commit, incoming, kind: 'worker', source: { agentId: 'agent-ms' }, mode: 'partial', labels: MERGE_LABELS.worker('agent-ms') });
  const row = f.applies().find(item => item.id === outcome.applyId);
  assert.ok(Number.isInteger(row.ms) && row.ms >= 0, `ms: ${row.ms}`);
  assert.equal(row.bytes, 'twelve bytes'.length);
});

test('ISO-10: git adds a worktree under the repository lock without checking it out; the files are checked out after the lock is released', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'one\n', 'src/b.js': 'export const b = 1;\n', '.gitattributes': '*.txt text eol=crlf\n' } });
  const { worktrees } = services(f);
  const calls = [], lock = f.engine.lock.bind(f.engine);
  let held = 0;
  f.engine.lock = async (projectId, work) => lock(projectId, async () => { held++; try { return await work(); } finally { held--; } });
  const run = f.service.run.bind(f.service);
  f.service.run = (cwd, args, options) => { calls.push({ args, locked: held > 0 }); return run(cwd, args, options); };
  const record = await worktrees.create(f.project.id, { kind: 'worker', owner: { agentId: 'agent-lock0001' }, parent: f.root, label: 'lock' });
  const add = calls.find(call => call.args[0] === 'worktree' && call.args[1] === 'add'), fill = calls.find(call => call.args[0] === 'read-tree' && call.args.includes('-u'));
  assert.ok(add?.locked && add.args.includes('--no-checkout'), 'git\'s own entry under the lock, no checkout');
  assert.ok(fill && !fill.locked, 'the checkout outside it');
  const W = join(f.workspace, record.dir);
  assert.equal(readFileSync(join(W, 'a.txt'), 'utf8'), 'one\r\n', 'the same checkout: attributes applied');
  assert.equal(read(W, 'src/b.js'), 'export const b = 1;\n');
  const env = { GIT_DIR: join(f.commonDir, 'worktrees', record.name), GIT_WORK_TREE: W };
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: W, env: { ...process.env, ...env }, encoding: 'utf8' }), '', 'the agent sees no change of its own');
});

test('storage view: what isolation keeps, by repository and project, read only', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'one\n' } });
  const { worktrees } = services(f);
  const record = await worktrees.create(f.project.id, { kind: 'worker', owner: { agentId: 'agent-view0001' }, parent: f.root, label: 'view' });
  await f.engine.snapshot(f.project.id, f.root, { pin: REFS.turn('t-view') });
  const storage = new IsolationStorage({ store: f.store, engine: f.engine, worktrees });
  assert.equal(storage.view().at, null, 'nothing computed yet: never waited for');
  const view = await storage.refresh();
  const [repository] = view.repositories;
  assert.equal(repository.repository, f.commonDir); assert.equal(repository.owner, 'user');
  assert.equal(repository.objects.cleanability, 'none', 'the user\'s object store is reported, never cleaned');
  assert.equal(repository.hiddenRefs.turn, 1); assert.ok(repository.hiddenRefs.worktree >= 1);
  assert.ok(repository.privateIndexes.files >= 1); assert.equal(repository.privateIndexes.orphaned, 0);
  const [row] = view.projects;
  assert.deepEqual(row.worktrees.counts, { worker: { active: 1 } });
  assert.equal(row.trash.cleanability, 'auto'); assert.equal(row.worktrees.cleanability, 'confirm');
  assert.equal(storage.view(), view, 'cached');
  assert.ok(lstatSync(join(f.workspace, record.dir)).isDirectory(), 'nothing removed by the view');
});
