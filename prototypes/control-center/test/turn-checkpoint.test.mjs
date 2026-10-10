import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { turnFixture, read, put, there, skip, git, until, treeOf } from './helpers/turn-fixture.mjs';
import { REFS } from '../git-isolation/index.mjs';
import { TurnCheckpoint, gateOn, objectGit } from '../turn-checkpoint.mjs';
import { Store } from '../store.mjs';
import { WorkspaceGitService } from '../workspace-git-service.mjs';

// Direct-mode turn checkpoints (worktree design 0.63 §5.1; §13 "直接模式"): a real temporary repository, the real
// merge engine, a scripted model. No network, no paid model, never the user's projects.

const parents = (repo, ref) => git(repo, 'rev-list', '--parents', '-n', '1', ref).trim().split(' ').slice(1);

test('a direct-mode turn pins [start, end] at its turn ref and rolls back exactly its own writes', { skip }, async t => {
  const f = turnFixture(t);
  f.model.steps.push({ writes: [['a.txt', 'one\nTWO\nthree\n'], ['new.md', 'created\n']] }, { text: '好了。' });
  const turn = await f.send(f.session.id, '改');
  const { endedAt, ...checkpoint } = turn.checkpoint;
  assert.deepEqual(checkpoint, { ref: REFS.turn(turn.id), state: 'taken' });
  assert.ok(Date.parse(endedAt) >= Date.parse(turn.attemptStartedAt), 'when this attempt\'s end went into the hold');
  const [start, end] = parents(f.repo, REFS.turn(turn.id));
  assert.equal(git(f.repo, 'show', `${start}:a.txt`), 'one\ntwo\nthree\n'); assert.equal(git(f.repo, 'show', `${end}:a.txt`), 'one\nTWO\nthree\n');
  const own = await f.checkpoints.attributable(f.project.id, turn.id);
  assert.deepEqual([own.start, own.end, own.paths.sort(), own.excluded], [start, end, ['a.txt', 'new.md'], []]);
  // A later user edit elsewhere survives the rollback.
  put(f.P, 'src/app.js', 'export const a = 9;\n');
  const preview = await f.engine.rollbackTurn(f.project.id, turn.id, {});
  assert.deepEqual(preview.files.map(row => [row.path, row.action]).sort(), [['a.txt', 'restore'], ['new.md', 'delete']]);
  assert.match(preview.note, /无法区分/);
  await f.engine.rollbackTurn(f.project.id, turn.id, { confirm: preview.confirm });
  assert.equal(read(f.P, 'a.txt'), 'one\ntwo\nthree\n'); assert.equal(there(f.P, 'new.md'), false); assert.equal(read(f.P, 'src/app.js'), 'export const a = 9;\n');
  assert.equal(git(f.repo, 'status', '--porcelain', '--', 'a.txt').trim(), '', 'back to what it was');
});

test('the start snapshot is complete before the first write runs; read-only tools never wait for it', { skip }, async t => {
  const f = turnFixture(t);
  const snapshot = f.engine.snapshot.bind(f.engine), order = [];
  f.engine.snapshot = async (...args) => { await delay(400); const result = await snapshot(...args); order.push('snapshot'); return result; };
  f.model.steps.push(() => { order.push('first request'); return { write: ['a.txt', 'written\n'] }; }, { text: '好。' });
  const turn = await f.send(f.session.id, '写');
  const writeAt = f.sessionOf(f.session.id).items.find(item => item.tool?.name === 'project_write').tool.startedAt;
  assert.equal(order[0], 'first request', 'the request did not wait for the snapshot');
  const [start] = parents(f.repo, REFS.turn(turn.id));
  assert.equal(git(f.repo, 'show', `${start}:a.txt`), 'one\ntwo\nthree\n', 'the start holds the folder before the write');
  assert.ok(writeAt);
  // The gate itself: a read tool goes straight through, a write waits.
  let released = false; const wait = () => delay(200).then(() => { released = true; });
  const gate = gateOn(wait, () => 'inner');
  assert.equal(gate({ tool: { name: 'project_read', effect: 'read' } }), 'inner', 'no promise for a read tool');
  assert.equal(await gate({ tool: { name: 'project_write', effect: 'write' } }), 'inner'); assert.equal(released, true);
  assert.equal(await gateOn(wait, undefined)({ tool: { name: 'mcp_thing' } }), undefined, 'an undeclared effect counts as writing and waits too');
});

test('another conversation\'s write into the project folder during the turn is not this turn\'s', { skip }, async t => {
  const f = turnFixture(t);
  f.store.mutate(state => { state.settings.maxConcurrent = 4; });
  const other = f.worktreeSession('另一个');
  await f.send(other.id, '准备');
  let release; const hold = new Promise(done => { release = done; });
  f.model.steps.push({ write: ['a.txt', 'direct\n'] }, { hold, then: { text: '直接模式这轮完成。' } });
  f.store.message(f.session.id, { text: '直接改 a' });
  // The direct turn wrote and now waits inside its held request (both its steps taken from the shared script).
  await until(() => read(f.P, 'a.txt') === 'direct\n' && f.model.steps.length === 0, 'the direct write');
  // While the direct turn holds, the worktree conversation writes b.txt and applies it to the project folder.
  f.model.steps.unshift({ write: ['b.txt', 'from the other conversation\n'] }, { text: '另一边完成。' });
  const otherTurn = await f.send(other.id, '写 b');
  assert.equal(otherTurn.apply.status, 'applied'); assert.equal(read(f.P, 'b.txt'), 'from the other conversation\n');
  release();
  await until(() => f.sessionOf(f.session.id).turns.at(-1).checkpoint, 'the end checkpoint');
  const turn = f.sessionOf(f.session.id).turns.at(-1);
  const own = await f.checkpoints.attributable(f.project.id, turn.id);
  assert.deepEqual(own.paths, ['a.txt']);
  assert.deepEqual(own.excluded, [{ path: 'b.txt', applyId: otherTurn.apply.applyIds[0] }]);
  const preview = await f.engine.rollbackTurn(f.project.id, turn.id, {});
  assert.deepEqual(preview.files.map(row => row.path), ['a.txt']);
  assert.deepEqual(preview.skipped, [{ path: 'b.txt', reason: 'unattributable' }]);
});

test('a start snapshot slower than the limit is skipped: the turn goes on, the footer says 本轮没有检查点, no ref is left', { skip }, async t => {
  const f = turnFixture(t, { waitMs: 150 });
  const snapshot = f.engine.snapshot.bind(f.engine);
  let slow = true;
  f.engine.snapshot = async (...args) => { if (slow) { slow = false; await delay(1200); } return snapshot(...args); };
  f.model.steps.push({ write: ['a.txt', 'quick\n'] }, { text: '好。' });
  const started = Date.now();
  const turn = await f.send(f.session.id, '写');
  assert.equal(turn.status, 'completed'); assert.equal(read(f.P, 'a.txt'), 'quick\n');
  assert.deepEqual(turn.checkpoint, { state: 'skipped', reason: 'timeout' });
  assert.equal(git(f.repo, 'for-each-ref', REFS.turn(turn.id)).trim(), '');
  await assert.rejects(f.checkpoints.attributable(f.project.id, turn.id), { code: 'turn_checkpoint_missing', status: 409 });
  await assert.rejects(f.engine.rollbackTurn(f.project.id, turn.id, {}), { code: 'turn_checkpoint_missing' });
  assert.ok(Date.now() - started < 60000);
  // A later attempt of the same turn (a retry) would cover only part of it: it stays without a checkpoint.
  assert.deepEqual(await f.checkpoints.start({ projectId: f.project.id, sessionId: f.session.id, turnId: turn.id }).ready, { state: 'skipped', reason: 'timeout' });
  assert.deepEqual(await f.checkpoints.end({ projectId: f.project.id, sessionId: f.session.id, turnId: turn.id }), { state: 'skipped', reason: 'timeout' });
});

test('a turn retried after a failure keeps one start; what the user changed in between is not rolled back', { skip }, async t => {
  const f = turnFixture(t);
  f.model.steps.push({ write: ['a.txt', 'attempt one\n'] }, { fail: 'fixture provider failure' });
  const failed = await f.send(f.session.id, '写');
  assert.equal(failed.status, 'failed'); assert.equal(failed.checkpoint.state, 'taken');
  // The user edits another file between the attempts, then retries.
  put(f.P, 'src/app.js', 'export const a = 42;\n');
  f.model.steps.push({ write: ['a.txt', 'attempt two\n'] }, { text: '好。' });
  f.store.controlSession(f.session.id, 'retry');
  await until(() => f.sessionOf(f.session.id).turns.at(-1).status === 'completed', 'the retry');
  await f.quiet(f.session.id);
  const turn = f.sessionOf(f.session.id).turns.at(-1);
  assert.equal(turn.id, failed.id);
  const own = await f.checkpoints.attributable(f.project.id, turn.id);
  assert.deepEqual(own.paths, ['a.txt'], 'the user\'s edit between the attempts is not the turn\'s');
  assert.equal(git(f.repo, 'show', `${own.start}:a.txt`), 'one\ntwo\nthree\n', 'the start is the first attempt\'s');
  const preview = await f.engine.rollbackTurn(f.project.id, turn.id, {});
  await f.engine.rollbackTurn(f.project.id, turn.id, { confirm: preview.confirm });
  assert.equal(read(f.P, 'a.txt'), 'one\ntwo\nthree\n'); assert.equal(read(f.P, 'src/app.js'), 'export const a = 42;\n');
  const windows = JSON.parse(git(f.repo, 'log', '-1', '--format=%B', REFS.turn(turn.id)).trim()).windows;
  assert.equal(windows.length, 2); assert.ok(windows.every(([from, to]) => to >= from));
});

test('no checkpoint where none belongs: plan mode, worktree sessions, folders that are not git repositories; read-only projects say why', { skip }, async t => {
  const f = turnFixture(t);
  f.store.updateSession(f.session.id, { mode: 'plan' });
  f.model.steps.push({ text: '只读。' });
  const plan = await f.send(f.session.id, '看看');
  assert.equal(plan.checkpoint, undefined);
  f.store.updateSession(f.session.id, { mode: 'build' });
  const s = f.worktreeSession();
  f.model.steps.push({ text: '好。' });
  assert.equal((await f.send(s.id, '看看')).checkpoint, undefined);
  // Read-only project: recorded as skipped (read_only), no snapshot.
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).permissions.workspace = 'read'; });
  f.model.steps.push({ text: '只读项目。' });
  const readOnly = await f.send(f.session.id, '看看');
  assert.deepEqual(readOnly.checkpoint, { state: 'skipped', reason: 'read_only' });
  // A folder without git.
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'rna-turns-plain-')));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  writeFileSync(join(plain, 'notes.md'), 'x\n');
  const store = new Store(join(plain, '.state', 'state.json'));
  const { project, session } = store.createProject({ name: 'Plain', workspace: plain, initiative: { enabled: false } });
  const checkpoints = new TurnCheckpoint(store, { engine: f.engine, git: new WorkspaceGitService(store) });
  store.mutate(state => { const row = state.sessions.find(item => item.id === session.id); row.turns.push({ id: 'turn-plain', status: 'running', mode: 'build', createdAt: new Date().toISOString() }); });
  const handle = checkpoints.start({ projectId: project.id, sessionId: session.id, turnId: 'turn-plain' });
  assert.deepEqual(await handle.ready, { state: 'skipped', reason: 'no_repository' });
  assert.equal(await checkpoints.end({ projectId: project.id, sessionId: session.id, turnId: 'turn-plain' }), null);
  assert.equal(store.state.sessions.find(item => item.id === session.id).turns[0].checkpoint, undefined, 'nothing to show for a folder without git');
});

test('attributable refuses a turn without a checkpoint', { skip }, async t => {
  const f = turnFixture(t);
  await assert.rejects(f.checkpoints.attributable(f.project.id, 'no-such-turn'), { code: 'turn_checkpoint_missing' });
  await assert.rejects(f.checkpoints.attributable('no-such-project', 'x'), { code: 'project_not_found' });
  // A turn whose checkpoint was skipped has none, even if a hold ref exists.
  f.model.steps.push({ write: ['a.txt', 'x\n'] }, { text: '好。' });
  const turn = await f.send(f.session.id, '写');
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).turns.find(row => row.id === turn.id).checkpoint = { state: 'skipped', reason: 'snapshot_failed' }; });
  await assert.rejects(f.checkpoints.attributable(f.project.id, turn.id), { code: 'turn_checkpoint_missing' });
  assert.ok(treeOf(f.repo, REFS.turn(turn.id)));
});

// Plan 2026-10-05 §2.2 C1: the guard pass at a turn's end reads what the turn changed so far, while its checkpoint is open.
test('progress: a turn\'s changes so far, taken mid-turn: a command\'s write counts, another owner\'s apply does not, and read() is the file as the turn found it', { skip }, async t => {
  const f = turnFixture(t);
  f.store.mutate(state => { state.settings.maxConcurrent = 4; });
  const other = f.worktreeSession('另一个');
  await f.send(other.id, '准备');
  let release; const hold = new Promise(done => { release = done; });
  f.model.steps.push({ write: ['a.txt', 'direct\n'] }, { hold, then: { text: '直接模式这轮完成。' } });
  f.store.message(f.session.id, { text: '直接改 a' });
  await until(() => read(f.P, 'a.txt') === 'direct\n' && f.model.steps.length === 0, 'the direct write');
  const turnId = f.sessionOf(f.session.id).activeTurnId;
  // A write no tool hook saw (a shell command), and another conversation's apply into the project folder meanwhile.
  put(f.P, 'cmd/new.md', 'from a command\n');
  f.model.steps.unshift({ write: ['b.txt', 'from the other conversation\n'] }, { text: '另一边完成。' });
  const otherTurn = await f.send(other.id, '写 b');
  const refs = git(f.repo, 'for-each-ref', '--format=%(refname)').trim().split('\n').sort();
  const progress = await f.checkpoints.progress(f.project.id, turnId);
  assert.deepEqual(progress.paths.sort(), ['a.txt', 'cmd/new.md'], 'the command\'s file is the turn\'s; the other conversation\'s b.txt is not');
  assert.deepEqual(progress.excluded, [{ path: 'b.txt', applyId: otherTurn.apply.applyIds[0] }]);
  assert.equal(await progress.read('a.txt'), 'one\ntwo\nthree\n', 'a file as the turn found it, not as it is now');
  assert.equal(await progress.read('cmd/new.md'), null, 'a file the turn created did not exist');
  assert.equal(await progress.read('src/app.js'), 'export const a = 1;\n');
  assert.deepEqual(git(f.repo, 'for-each-ref', '--format=%(refname)').trim().split('\n').sort(), refs, 'the mid-turn snapshot is pinned by no ref');
  release();
  await until(() => f.sessionOf(f.session.id).turns.at(-1).checkpoint, 'the end checkpoint');
  assert.equal(await f.checkpoints.progress(f.project.id, turnId), null, 'a turn that ended has nothing in progress');
  assert.deepEqual((await f.checkpoints.attributable(f.project.id, turnId)).paths.sort(), ['a.txt', 'cmd/new.md'], 'attributable() reads as before');
  assert.equal(await f.checkpoints.progress(f.project.id, 'no-such-turn'), null);
});

test('ObjectGit#text: a file as a revision holds it (with the project folder inside a repository), null when it is not there, undefined when it cannot be said', { skip }, async t => {
  const f = turnFixture(t, { prefix: 'app' });
  const objects = objectGit(f.git, await f.git.locateProject(f.project.id)), head = git(f.repo, 'rev-parse', 'HEAD').trim();
  assert.equal(await objects.text(head, 'a.txt'), 'one\ntwo\nthree\n');
  assert.equal(await objects.text(head, 'src/app.js'), 'export const a = 1;\n');
  assert.equal(await objects.text(head, 'nope.txt'), null, 'the revision has no such file');
  assert.equal(await objects.text('0'.repeat(40), 'a.txt'), undefined, 'a revision that is gone says nothing');
  assert.equal(await objects.text(head, 'a.txt', { maxBytes: 4 }), undefined, 'larger than the bound');
});

test('ObjectGit#materialize: the project folder as a revision held it, written into a folder of its own through a throwaway index; the repository is left as it was', { skip }, async t => {
  for (const prefix of ['', 'app']) {
    const f = turnFixture(t, { prefix, files: { 'a.txt': 'one\ntwo\nthree\n', 'src/app.js': 'export const a = 1;\n', 'notes/rules.md': 'forbidden\n' } });
    const objects = objectGit(f.git, await f.git.locateProject(f.project.id)), head = git(f.repo, 'rev-parse', 'HEAD').trim();
    const repository = () => ({ refs: git(f.repo, 'for-each-ref'), index: git(f.repo, 'ls-files', '-s') }), before = repository();
    // The working copy moves on after the revision; the folder written is the revision's.
    put(f.P, 'a.txt', 'changed\n'); put(f.P, 'notes/rules.md', 'something else\n'); put(f.P, 'later.md', 'not in the revision\n');
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-materialize-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(await objects.materialize(head, dir), true, `prefix ${JSON.stringify(prefix)}`);
    assert.equal(read(dir, 'a.txt'), 'one\ntwo\nthree\n'); assert.equal(read(dir, 'src/app.js'), 'export const a = 1;\n'); assert.equal(read(dir, 'notes/rules.md'), 'forbidden\n');
    assert.equal(there(dir, 'later.md'), false, 'a file the revision does not hold is not there'); assert.equal(there(dir, '.git'), false, 'no repository metadata comes along');
    assert.deepEqual(repository(), before, 'refs and the repository\'s own index are as they were');
    const gone = realpathSync(mkdtempSync(join(tmpdir(), 'rna-materialize-'))); t.after(() => rmSync(gone, { recursive: true, force: true }));
    assert.equal(await objects.materialize('0'.repeat(40), gone), false, 'a revision that is gone writes nothing'); assert.equal(there(gone, 'a.txt'), false);
  }
});
