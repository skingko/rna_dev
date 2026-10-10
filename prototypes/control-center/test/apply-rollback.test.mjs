import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git, put, read, skip, treeBytes } from './git-isolation-fixture.mjs';
import { LIMITS, MERGE_LABELS, REFS } from '../git-isolation/index.mjs';
import { createApplyRoutes } from '../apply-routes.mjs';

// Rollback (worktree design 0.63 §5, §13 "回退"): three-way, two steps with a one-time token, recorded itself so it
// can be undone; the panel's discard takes a checkpoint first.

const FIVE = 'l1\nl2\nl3\nl4\nl5\n';
let workers = 0;
/** A worker made from the folder now, changed by `change`, applied into the folder: its outcome. */
async function workerApply(f, change, { turnId = 't1' } = {}) {
  const id = `agent-${String(++workers).padStart(8, '0')}`;
  const seed = await f.engine.snapshot(f.project.id, f.root);
  const w = f.worktree('worker', id, seed.commit);
  await change(w.root);
  const final = await f.engine.snapshot(f.project.id, w);
  const outcome = await f.engine.apply(f.project.id, { target: f.root, base: seed.commit, incoming: final.commit, kind: 'worker', source: { sessionId: f.project.primarySessionId, turnId, agentId: id }, mode: 'all', labels: MERGE_LABELS.worker(id), incomingRoot: w });
  assert.equal(outcome.status, 'applied', JSON.stringify(outcome));
  return outcome;
}
const row = (f, id) => f.applies().find(item => item.id === id);

test('a three-way rollback keeps later changes that do not overlap and skips the ones that do; force restores those', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': FIVE, 'b.txt': 'b\n', 'keep.txt': 'k\n' } });
  const applied = await workerApply(f, root => { put(root, 'a.txt', 'L1\nl2\nl3\nl4\nl5\n'); put(root, 'b.txt', 'b worker\n'); put(root, 'new.txt', 'new\n'); });
  // Later work in the folder: a.txt elsewhere, b.txt on the same line, another file.
  put(f.workspace, 'a.txt', 'L1\nl2\nl3\nl4\nL5 user\n'); put(f.workspace, 'b.txt', 'b user\n'); put(f.workspace, 'other.txt', 'o\n');
  const before = treeBytes(f.workspace);
  const preview = await f.engine.rollback(f.project.id, applied.applyId, {});
  assert.deepEqual(treeBytes(f.workspace), before, 'the first step changes nothing');
  assert.deepEqual(preview.files.map(file => [file.path, file.action]).sort(), [['a.txt', 'restore'], ['new.txt', 'delete']]);
  assert.deepEqual(preview.skipped, [{ path: 'b.txt', reason: 'changed_after' }]);
  assert.match(preview.confirm, /^[0-9a-f]{32}$/); assert.ok(Date.parse(preview.expiresAt) > Date.now());
  const done = await f.engine.rollback(f.project.id, applied.applyId, { confirm: preview.confirm });
  assert.deepEqual(done.restored.sort(), ['a.txt', 'new.txt']); assert.equal(done.verify, 'verified');
  assert.deepEqual(done.skipped, [{ path: 'b.txt', reason: 'changed_after' }]);
  assert.equal(read(f.workspace, 'a.txt'), 'l1\nl2\nl3\nl4\nL5 user\n', 'the later edit stays');
  assert.equal(read(f.workspace, 'b.txt'), 'b user\n'); assert.ok(!existsSync(join(f.workspace, 'new.txt'))); assert.equal(read(f.workspace, 'other.txt'), 'o\n');
  const rollback = row(f, done.applyId);
  assert.deepEqual({ kind: rollback.kind, undoes: rollback.undoes, state: rollback.state }, { kind: 'rollback', undoes: applied.applyId, state: 'verified' });
  assert.deepEqual({ state: row(f, applied.applyId).state, by: row(f, applied.applyId).rolledBackBy }, { state: 'rolled_back', by: done.applyId });
  // "Restore it anyway": the skipped file, forced at the second step, through another checkpoint.
  const second = await f.engine.rollback(f.project.id, applied.applyId, {});
  assert.deepEqual(second.files, []); assert.deepEqual(second.skipped, [{ path: 'b.txt', reason: 'changed_after' }]);
  const forced = await f.engine.rollback(f.project.id, applied.applyId, { confirm: second.confirm, force: ['b.txt'] });
  assert.deepEqual(forced.restored, ['b.txt']); assert.equal(read(f.workspace, 'b.txt'), 'b\n');
  assert.notEqual(forced.applyId, done.applyId); assert.equal(row(f, forced.applyId).kind, 'rollback');
  const [beforeForce] = git(f.repo, 'rev-list', '--parents', '-n', '1', REFS.apply(forced.applyId)).trim().split(' ').slice(1);
  assert.equal(git(f.repo, 'cat-file', 'blob', `${beforeForce}:b.txt`), 'b user\n', 'the user\'s version is in the forced rollback\'s checkpoint');
});

test('a rollback can be undone, which brings the rolled-back record back', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'a\n' } });
  const applied = await workerApply(f, root => put(root, 'a.txt', 'worker\n'));
  const preview = await f.engine.rollback(f.project.id, applied.applyId, {});
  const done = await f.engine.rollback(f.project.id, applied.applyId, { confirm: preview.confirm });
  assert.equal(read(f.workspace, 'a.txt'), 'a\n');
  const undo = await f.engine.rollback(f.project.id, done.applyId, {});
  assert.deepEqual(undo.files, [{ path: 'a.txt', action: 'restore' }]);
  const undone = await f.engine.rollback(f.project.id, done.applyId, { confirm: undo.confirm });
  assert.equal(read(f.workspace, 'a.txt'), 'worker\n');
  assert.equal(row(f, done.applyId).state, 'rolled_back'); assert.equal(row(f, done.applyId).rolledBackBy, undone.applyId);
  assert.equal(row(f, applied.applyId).state, 'verified'); assert.equal(row(f, applied.applyId).rolledBackBy, undefined);
  const view = f.engine.applies(f.project.id).applies;
  assert.deepEqual(view.map(item => item.kind), ['rollback', 'rollback', 'worker'], 'newest first');
  assert.deepEqual(view.map(item => item.rollback.available), [true, false, true]);
});

test('refusals: stale, reused or mismatched tokens, files changed between steps, expired records, other targets, read-only projects, nothing left', { skip }, async t => {
  let clock = Date.now();
  const f = fixture(t, { files: { 'a.txt': 'a\n', 'b.txt': 'b\n' }, engine: { now: () => clock } });
  const applied = await workerApply(f, root => { put(root, 'a.txt', 'worker a\n'); put(root, 'b.txt', 'worker b\n'); });
  const code = async (promise, expected) => assert.rejects(promise, error => { assert.equal(error.code, expected, error.message); return true; });
  // A token lapses after two minutes.
  let preview = await f.engine.rollback(f.project.id, applied.applyId, {});
  clock += LIMITS.rollbackTokenMs + 1;
  await code(f.engine.rollback(f.project.id, applied.applyId, { confirm: preview.confirm }), 'rollback_unconfirmed');
  // One use only, and only for what it was issued for.
  preview = await f.engine.rollback(f.project.id, applied.applyId, { paths: ['a.txt'] });
  assert.deepEqual(preview.files, [{ path: 'a.txt', action: 'restore' }], 'paths limit the rollback');
  await code(f.engine.rollback(f.project.id, applied.applyId, { confirm: preview.confirm }), 'rollback_unconfirmed');
  await code(f.engine.rollback(f.project.id, applied.applyId, { confirm: preview.confirm, paths: ['a.txt'] }), 'rollback_unconfirmed');
  // A file changed between the steps.
  preview = await f.engine.rollback(f.project.id, applied.applyId, {});
  put(f.workspace, 'a.txt', 'typed meanwhile\n');
  await code(f.engine.rollback(f.project.id, applied.applyId, { confirm: preview.confirm }), 'rollback_changed');
  assert.equal(read(f.workspace, 'b.txt'), 'worker b\n', 'nothing was rolled back');
  // Bad requests, unknown and expired records, other targets.
  await code(f.engine.rollback(f.project.id, applied.applyId, { paths: 'a.txt' }), 'rollback_request_invalid');
  await code(f.engine.rollback(f.project.id, applied.applyId, { also: 1 }), 'rollback_request_invalid');
  await code(f.engine.rollback(f.project.id, 'a0000000000000000', {}), 'apply_not_found');
  f.store.mutate(state => { const rows = state.projects.find(item => item.id === f.project.id).git.applies; rows.push({ ...rows[0], id: 'aexpired', state: 'expired' }, { ...rows[0], id: 'asession', target: 'session:s1' }); });
  await code(f.engine.rollback(f.project.id, 'aexpired', {}), 'apply_expired');
  await code(f.engine.rollback(f.project.id, 'asession', {}), 'apply_target_denied');
  await code(f.engine.applyDetail(f.project.id, 'aexpired'), 'apply_expired');
  // Nothing left: everything it wrote is gone already.
  put(f.workspace, 'a.txt', 'a\n'); put(f.workspace, 'b.txt', 'b\n');
  await code(f.engine.rollback(f.project.id, applied.applyId, {}), 'rollback_nothing');
  // A read-only project.
  f.store.mutate(state => { state.projects.find(item => item.id === f.project.id).permissions.workspace = 'read'; });
  await assert.rejects(f.engine.rollback(f.project.id, applied.applyId, {}), error => error.status === 403 && error.code === 'git_read_only');
});

test('the panel\'s discard takes a user_discard checkpoint first, and rolling it back brings the edits back', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
  put(f.workspace, 'a.txt', 'my edit\n'); put(f.workspace, 'scratch.txt', 'new notes\n'); put(f.workspace, 'b.txt', 'kept edit\n');
  const plan = await f.service.discard(f.project.id, { paths: ['a.txt', 'scratch.txt'] });
  assert.deepEqual(f.applies(), [], 'the first step records nothing');
  const result = await f.service.discard(f.project.id, { paths: ['a.txt', 'scratch.txt'], confirm: plan.confirm });
  assert.equal(read(f.workspace, 'a.txt'), 'a\n'); assert.ok(!existsSync(join(f.workspace, 'scratch.txt')));
  const [record] = f.applies();
  assert.equal(result.applyId, record.id);
  assert.deepEqual({ kind: record.kind, state: record.state, files: record.files, pending: record.pending }, { kind: 'user_discard', state: 'verified', files: 2, pending: undefined });
  const preview = await f.engine.rollback(f.project.id, record.id, {});
  assert.deepEqual(preview.files.map(file => [file.path, file.action]).sort(), [['a.txt', 'restore'], ['scratch.txt', 'recreate']]);
  await f.engine.rollback(f.project.id, record.id, { confirm: preview.confirm });
  assert.equal(read(f.workspace, 'a.txt'), 'my edit\n'); assert.equal(read(f.workspace, 'scratch.txt'), 'new notes\n'); assert.equal(read(f.workspace, 'b.txt'), 'kept edit\n');
});

test('a worktree session\'s turn rolls back all its turn records, newest first', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': FIVE } });
  const id = f.project.id, sessionId = f.project.primarySessionId;
  const seed = await f.engine.snapshot(id, f.root);
  const s = f.worktree('session', 'sess0001', seed.commit, { owner: { sessionId } });
  const apply = async (base, change) => { await change(s.root); const tip = await f.engine.snapshot(id, s); const outcome = await f.engine.apply(id, { target: f.root, base, incoming: tip.commit, kind: 'turn', source: { sessionId, turnId: 'turn-1', worktreeId: 'sess0001' }, mode: 'all', labels: MERGE_LABELS.sessionToProject() }); assert.equal(outcome.status, 'applied'); return tip.commit; };
  const first = await apply(seed.commit, root => put(root, 'a.txt', 'L1\nl2\nl3\nl4\nl5\n'));
  await apply(first, root => { put(root, 'a.txt', 'L1\nl2\nL3\nl4\nl5\n'); put(root, 'b.txt', 'b\n'); });
  put(f.workspace, 'a.txt', 'L1\nl2\nL3\nl4\nl5 user\n');
  const preview = await f.engine.rollbackTurn(id, 'turn-1', {});
  assert.deepEqual(preview.files.map(file => [file.path, file.action]).sort(), [['a.txt', 'restore'], ['b.txt', 'delete']]);
  assert.equal(preview.note, undefined);
  const done = await f.engine.rollbackTurn(id, 'turn-1', { confirm: preview.confirm });
  assert.equal(read(f.workspace, 'a.txt'), 'l1\nl2\nl3\nl4\nl5 user\n'); assert.ok(!existsSync(join(f.workspace, 'b.txt')));
  assert.equal(row(f, done.applyId).undoesTurn, 'turn-1');
  assert.ok(f.applies().filter(item => item.kind === 'turn').every(item => item.state === 'rolled_back'));
});

test('a direct-mode turn rolls back its own paths from its checkpoint, says other writers can\'t be told apart, and needs one', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
  const id = f.project.id;
  await assert.rejects(f.engine.rollbackTurn(id, 'turn-x', {}), error => error.code === 'turn_checkpoint_missing');
  const start = await f.engine.snapshot(id, f.root);
  put(f.workspace, 'a.txt', 'turn wrote a\n'); put(f.workspace, 'c.txt', 'turn made c\n'); put(f.workspace, 'b.txt', 'someone else\n');
  const merged = await workerApply(f, root => put(root, 'w.txt', 'a worker of this turn\n'), { turnId: 'turn-2' });
  const end = await f.engine.snapshot(id, f.root);
  f.engine.attributable = async (projectId, turnId) => (turnId === 'turn-2' ? { start: start.commit, end: end.commit, paths: ['a.txt', 'c.txt', 'w.txt'], excluded: [{ path: 'b.txt', applyId: 'aother' }] } : Promise.reject(Object.assign(new Error('none'), { status: 409, code: 'turn_checkpoint_missing' })));
  const preview = await f.engine.rollbackTurn(id, 'turn-2', {});
  assert.match(preview.note, /无法区分/);
  assert.deepEqual(preview.files.map(file => [file.path, file.action]).sort(), [['a.txt', 'restore'], ['c.txt', 'delete'], ['w.txt', 'delete']]);
  assert.deepEqual(preview.skipped, [{ path: 'b.txt', reason: 'unattributable' }]);
  const done = await f.engine.rollbackTurn(id, 'turn-2', { confirm: preview.confirm });
  assert.equal(read(f.workspace, 'a.txt'), 'a\n'); assert.ok(!existsSync(join(f.workspace, 'c.txt'))); assert.equal(read(f.workspace, 'b.txt'), 'someone else\n');
  assert.deepEqual(row(f, done.applyId).source, { turnId: 'turn-2' }); assert.equal(row(f, done.applyId).undoesTurn, 'turn-2');
  assert.equal(row(f, merged.applyId).state, 'rolled_back', 'the turn\'s worker merge went with it'); assert.equal(row(f, merged.applyId).rolledBackBy, done.applyId);
  // Undoing the turn's rollback brings the worker merge back too.
  const undo = await f.engine.rollback(id, done.applyId, {});
  await f.engine.rollback(id, done.applyId, { confirm: undo.confirm });
  assert.equal(read(f.workspace, 'w.txt'), 'a worker of this turn\n'); assert.equal(read(f.workspace, 'a.txt'), 'turn wrote a\n');
  assert.equal(row(f, merged.applyId).state, 'verified'); assert.equal(row(f, merged.applyId).rolledBackBy, undefined);
  await assert.rejects(f.engine.rollbackTurn(id, 'turn-3', {}), error => error.code === 'turn_checkpoint_missing');
});

test('routes: list, detail, patches and both rollbacks answer like the protocol says', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'one\n', 'gone.txt': 'g\n' } });
  const applied = await workerApply(f, root => { put(root, 'a.txt', 'one\ntwo\n'); rmSync(join(root, 'gone.txt')); put(root, 'fresh.txt', 'f\n'); });
  const routes = createApplyRoutes({ store: f.store, body: async req => req.body ?? {}, engine: f.engine });
  const call = async (method, path, body) => {
    let answer = null;
    const url = new URL(`http://localhost${path}`);
    const handled = await routes({ method, body }, { pathname: url.pathname, url, send: (status, payload) => { answer = { status, body: payload }; } });
    return handled ? answer : null;
  };
  const base = `/api/v2/projects/${f.project.id}`;
  const list = await call('GET', `${base}/applies?limit=10&sessionId=${f.project.primarySessionId}`);
  assert.equal(list.status, 200); assert.deepEqual(list.body.applies.map(item => [item.id, item.kind, item.rollback.available]), [[applied.applyId, 'worker', true]]);
  assert.equal((await call('GET', `${base}/applies?limit=0`)).status, 400);
  const detail = await call('GET', `${base}/applies/${applied.applyId}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.paths.map(item => [item.path, item.status, item.added, item.removed]).sort(), [['a.txt', 'M', 1, 0], ['fresh.txt', 'A', 1, 0], ['gone.txt', 'D', 0, 1]]);
  const patches = await call('GET', `${base}/applies/${applied.applyId}/patches?path=a.txt&path=fresh.txt`);
  assert.equal(patches.status, 200); assert.equal(patches.body.patches[0].diff.kind, 'patch'); assert.match(patches.body.patches[0].diff.patch, /^\+two$/m);
  assert.equal((await call('GET', `${base}/applies/${applied.applyId}/patches`)).body.code, 'git_paths_invalid');
  const missing = await call('GET', `${base}/applies/a0000000000000000`);
  assert.deepEqual([missing.status, missing.body.code], [404, 'apply_not_found']);
  const first = await call('POST', `${base}/applies/${applied.applyId}/rollback`, {});
  assert.equal(first.status, 200); assert.ok(first.body.confirm);
  const second = await call('POST', `${base}/applies/${applied.applyId}/rollback`, { confirm: first.body.confirm });
  assert.equal(second.status, 200); assert.equal(read(f.workspace, 'a.txt'), 'one\n');
  const stale = await call('POST', `${base}/applies/${applied.applyId}/rollback`, { confirm: first.body.confirm });
  assert.deepEqual([stale.status, stale.body.code], [409, 'rollback_unconfirmed']);
  const turn = await call('POST', `${base}/turns/no-such-turn/rollback`, {});
  assert.deepEqual([turn.status, turn.body.code], [409, 'turn_checkpoint_missing']);
  assert.equal(await call('GET', `${base}/git`), null, 'other routes fall through');
  assert.equal(await call('GET', `${base}/turns/x/rollback`), null);
});

test('no checkpoint, no discard: when the folder can\'t be snapshotted the panel\'s discard changes nothing', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'a\n' } });
  put(f.workspace, 'a.txt', 'my edit\n'); put(f.workspace, 'locked.txt', 'x\n');
  chmodSync(join(f.workspace, 'locked.txt'), 0o000);
  t.after(() => { try { chmodSync(join(f.workspace, 'locked.txt'), 0o644); } catch { /* gone with the folder */ } });
  const plan = await f.service.discard(f.project.id, { paths: ['a.txt'] });
  await assert.rejects(f.service.discard(f.project.id, { paths: ['a.txt'], confirm: plan.confirm }), error => error.code === 'snapshot_unreadable');
  assert.equal(read(f.workspace, 'a.txt'), 'my edit\n'); assert.deepEqual(f.applies(), []);
});

test('a project in a subfolder of its repository: applies, details and rollbacks speak in the project\'s own paths', { skip }, async t => {
  const f = fixture(t, { prefix: 'site', files: { 'page.html': '<p>1</p>\n' } });
  put(f.repo, 'README.md', 'outside the project\n'); git(f.repo, 'add', 'README.md'); git(f.repo, 'commit', '-q', '-m', 'readme');
  const applied = await workerApply(f, root => { put(root, 'page.html', '<p>2</p>\n'); put(root, 'css/site.css', 'p{}\n'); });
  assert.deepEqual([...applied.written].sort(), ['css/site.css', 'page.html']);
  assert.equal(read(f.workspace, 'css/site.css'), 'p{}\n'); assert.equal(read(f.repo, 'README.md'), 'outside the project\n');
  const detail = await f.engine.applyDetail(f.project.id, applied.applyId);
  assert.deepEqual(detail.paths.map(item => item.path).sort(), ['css/site.css', 'page.html']);
  const patches = await f.engine.applyPatches(f.project.id, applied.applyId, { paths: ['page.html'] });
  assert.match(patches.patches[0].diff.patch, /^\+<p>2<\/p>$/m);
  const preview = await f.engine.rollback(f.project.id, applied.applyId, {});
  assert.deepEqual(preview.files.map(file => file.path).sort(), ['css/site.css', 'page.html']);
  await f.engine.rollback(f.project.id, applied.applyId, { confirm: preview.confirm });
  assert.equal(read(f.workspace, 'page.html'), '<p>1</p>\n'); assert.ok(!existsSync(join(f.workspace, 'css')), 'an emptied folder goes too');
});
