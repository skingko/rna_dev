import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git, put, read, skip } from './git-isolation-fixture.mjs';
import { IsolationEngine, MERGE_LABELS, USER_ONLY_CONFLICTS } from '../git-isolation/index.mjs';
import { RootResolver } from '../workspace-roots.mjs';
import { WorktreeService } from '../worktree-service.mjs';
import { turnFixture } from './helpers/turn-fixture.mjs';

// Adversarial safety review of the 0.63 isolation (design §0.3): each test reproduces a way the user's work could
// be lost or mixed, or a host guarantee bypassed, that the engine let through before its fix. Temporary repositories
// only (git-isolation-fixture: no global or system git configuration, no network, no model).

const sleep = ms => new Promise(done => setTimeout(done, ms));
const MID = 'a1b2c3d4e5f60718';
const marked = `one\n<<<<<<< refs/rna/m/${MID}/this-conversation\ntwo from the conversation\n||||||| 1234567\ntwo\n=======\ntwo from the folder\n>>>>>>> refs/rna/m/${MID}/project-folder\nthree\n`;

test('the repository lock is held by one chain at a time: work a holder only started (a store listener it woke, a timer it set) queues', { skip }, async t => {
  const fx = fixture(t), id = fx.project.id;
  let inside = 0, most = 0;
  const enter = async ms => { inside++; most = Math.max(most, inside); await sleep(ms); inside--; };
  // A listener that reacts to a mutation by taking the lock (as the background upkeep, the session watcher and the
  // interrupted-card watcher do), and a timer set inside the hold that fires after it, while someone else holds it.
  let woken, timed;
  const listener = new Promise(done => { woken = done; });
  let fired = false;
  fx.store.subscribe(() => { if (fired) return; fired = true; setImmediate(() => woken(fx.engine.lock(id, () => enter(20)))); }, { display: false });
  const first = fx.engine.lock(id, async () => {
    inside++; most = Math.max(most, inside);
    fx.store.mutate(() => {});
    const timer = new Promise(done => setTimeout(() => done(fx.engine.lock(id, () => enter(20))), 60));
    timed = timer;
    await sleep(40);
    inside--;
  });
  const second = fx.engine.lock(id, () => enter(80));
  await Promise.all([first, second]);
  await listener; await timed;
  assert.equal(most, 1, 'two holders of the same repository lock ran at once');
  // A nested call of the same chain still runs at once (no deadlock).
  assert.equal(await fx.engine.lock(id, () => fx.engine.lock(id, async () => 'nested')), 'nested');
});

test('two applies at once into P: the second merges on top of the first, nothing lost', { skip }, async t => {
  const fx = fixture(t, { files: { 'a.txt': 'one\ntwo\nthree\nfour\nfive\n' } }), id = fx.project.id;
  const seed = await fx.engine.snapshot(id, fx.root);
  const w1 = fx.worktree('worker', 'w1', seed.commit), w2 = fx.worktree('worker', 'w2', seed.commit);
  put(w1.root, 'a.txt', 'ONE\ntwo\nthree\nfour\nfive\n');
  put(w2.root, 'a.txt', 'one\ntwo\nthree\nfour\nFIVE\n');
  const [t1, t2] = await Promise.all([fx.engine.snapshot(id, w1), fx.engine.snapshot(id, w2)]);
  const apply = (w, tip, agent) => fx.engine.apply(id, { target: fx.root, base: seed.commit, incoming: tip.commit, kind: 'worker', source: { agentId: agent }, mode: 'partial', labels: MERGE_LABELS.worker(agent), incomingRoot: w });
  const outcomes = await Promise.all([apply(w1, t1, 'w1'), apply(w2, t2, 'w2')]);
  assert.deepEqual(outcomes.map(row => row.status), ['applied', 'applied']);
  assert.equal(read(fx.workspace, 'a.txt'), 'ONE\ntwo\nthree\nfour\nFIVE\n');
  assert.equal(fx.applies().filter(row => row.state === 'verified').length, 2);
});

test('a kept session worktree still holding conflict markers, applied from the worktree panel, never puts them into P', { skip }, async t => {
  const fx = fixture(t, { files: { 'a.txt': 'one\ntwo\nthree\n' } }), id = fx.project.id;
  const seed = await fx.engine.snapshot(id, fx.root);
  const S = fx.worktree('session', 's1', seed.commit, { owner: { sessionId: 'x' } });
  // The conversation was archived during a conflict continuation: S holds the reverse merge's markers, its record is kept.
  fx.store.mutate(state => { const row = state.projects.find(item => item.id === id).git.worktrees.find(item => item.id === 's1'); row.state = 'kept'; row.base = seed.commit; row.marks = [{ mid: MID, turnId: 't1', paths: ['a.txt'] }]; });
  put(S.root, 'a.txt', marked);
  put(S.root, 'b.txt', 'a clean change\n');
  const worktrees = new WorktreeService(fx.store, { git: fx.service, engine: fx.engine, roots: new RootResolver(fx.store, { git: fx.service }) });
  const preview = await worktrees.applyWorktree(id, 's1');
  const done = await worktrees.applyWorktree(id, 's1', { confirm: preview.confirm });
  assert.equal(read(fx.workspace, 'a.txt'), 'one\ntwo\nthree\n', 'conflict markers reached the project folder');
  assert.equal(read(fx.workspace, 'b.txt'), 'a clean change\n');
  assert.deepEqual(done.conflicts, [{ path: 'a.txt', kind: 'content' }]);
  assert.equal(worktrees.record(id, 's1').state, 'conflicted');
  // The engine itself refuses, whoever asks: an `all` apply writes nothing at all when one file would carry
  // markers; `partial` and `cleanOnly` write the rest and report that file.
  put(S.root, 'b.txt', 'a second change\n');
  const [now, tip] = await Promise.all([fx.engine.snapshot(id, fx.root), fx.engine.snapshot(id, S)]);
  const request = { target: fx.root, base: now.commit, incoming: tip.commit, kind: 'turn', source: {}, labels: MERGE_LABELS.sessionToProject() };
  const all = await fx.engine.apply(id, { ...request, mode: 'all' });
  assert.equal(all.status, 'conflicted');
  assert.deepEqual(all.conflicts.map(row => [row.path, row.kind]), [['a.txt', 'content']]);
  assert.equal(read(fx.workspace, 'b.txt'), 'a clean change\n');
  const partial = await fx.engine.apply(id, { ...request, mode: 'partial' });
  assert.equal(read(fx.workspace, 'a.txt'), 'one\ntwo\nthree\n', 'conflict markers reached the project folder');
  assert.equal(read(fx.workspace, 'b.txt'), 'a second change\n');
  assert.deepEqual(partial.conflicts.map(row => [row.path, row.kind]), [['a.txt', 'content']]);
  assert.deepEqual(fx.applies().find(row => row.id === partial.applyId).skipped, [{ path: 'a.txt', reason: 'content' }]);
});

test('the panel discard of a file over 100 MB is refused: no checkpoint could hold it, so it could never be rolled back', { skip }, async t => {
  const fx = fixture(t, { files: { 'a.txt': 'one\n' } }), id = fx.project.id;
  const big = join(fx.workspace, 'big.bin');
  writeFileSync(big, 'start');
  truncateSync(big, 101 * 1024 * 1024);
  const preview = await fx.service.discard(id, { paths: ['big.bin'] });
  await assert.rejects(fx.service.discard(id, { paths: ['big.bin'], confirm: preview.confirm }), error => error.code === 'checkpoint_oversized' && error.status === 409);
  assert.ok(existsSync(big), 'the oversized file was deleted without a checkpoint');
  assert.equal(fx.applies().length, 0);
  // A discard the checkpoint covers still goes ahead.
  put(fx.workspace, 'a.txt', 'changed\n');
  const small = await fx.service.discard(id, { paths: ['a.txt'] });
  const result = await fx.service.discard(id, { paths: ['a.txt'], confirm: small.confirm });
  assert.ok(result.applyId);
  assert.equal(read(fx.workspace, 'a.txt'), 'one\n');
});

test('two links that each stay inside but together leave P are an unsafe_symlink conflict, and no card answer writes one', { skip }, async t => {
  const fx = fixture(t, { files: { 'a.txt': 'one\n', 'd/keep.txt': 'k\n' } }), id = fx.project.id;
  const seed = await fx.engine.snapshot(id, fx.root);
  const w = fx.worktree('worker', 'w1', seed.commit);
  symlinkSync('..', join(w.root, 'd', 'up'));
  symlinkSync('d/up/..', join(w.root, 'out'));
  symlinkSync('d/up/a.txt', join(w.root, 'fine'));
  const tip = await fx.engine.snapshot(id, w);
  const outcome = await fx.engine.apply(id, { target: fx.root, base: seed.commit, incoming: tip.commit, kind: 'worker', source: {}, mode: 'partial', labels: MERGE_LABELS.worker('w1'), incomingRoot: w });
  assert.ok(outcome.conflicts.some(row => row.path === 'out' && row.kind === 'unsafe_symlink'), JSON.stringify(outcome.conflicts));
  assert.throws(() => lstatSync(join(fx.workspace, 'out')), { code: 'ENOENT' });
  assert.equal(readlinkSync(join(fx.workspace, 'd', 'up')), '..');
  assert.equal(readlinkSync(join(fx.workspace, 'fine')), 'd/up/a.txt');
  // "Use this conversation's version" (take on the user's word) still never plants it.
  const conflict = outcome.conflicts.find(row => row.path === 'out');
  const taken = await fx.engine.take(id, { target: fx.root, items: [{ conflict, side: 'incoming' }], source: {}, byUser: true });
  assert.equal(taken.status, 'conflicted');
  assert.deepEqual(taken.taken, []);
  assert.throws(() => lstatSync(join(fx.workspace, 'out')), { code: 'ENOENT' });
});

test('a gitlink is never written as a file, not even when the user takes that side', { skip }, async t => {
  const fx = fixture(t, { files: { 'a.txt': 'one\n' } }), id = fx.project.id;
  const head = git(fx.repo, 'rev-parse', 'HEAD').trim();
  const conflict = { path: 'lib', kind: 'submodule', incoming: { mode: '160000', oid: head } };
  const taken = await fx.engine.take(id, { target: fx.root, items: [{ conflict, side: 'incoming' }], source: {}, byUser: true });
  assert.equal(taken.status, 'conflicted');
  assert.equal(existsSync(join(fx.workspace, 'lib')), false, 'the commit object was written as a file');
});

test('an apply carrying several files near the snapshot limit is read in size-bounded batches instead of failing', { skip }, async t => {
  const fx = fixture(t, { files: { 'a.txt': 'one\n' } }), id = fx.project.id;
  const seed = await fx.engine.snapshot(id, fx.root);
  const w = fx.worktree('worker', 'w1', seed.commit);
  mkdirSync(join(w.root, 'assets'), { recursive: true });
  for (const name of ['one.bin', 'two.bin', 'three.bin']) { const bytes = Buffer.alloc(90 * 1024 * 1024, 0x61); bytes.write(name, 0); writeFileSync(join(w.root, 'assets', name), bytes); }
  const tip = await fx.engine.snapshot(id, w);
  const outcome = await fx.engine.apply(id, { target: fx.root, base: seed.commit, incoming: tip.commit, kind: 'worker', source: {}, mode: 'partial', labels: MERGE_LABELS.worker('w1'), incomingRoot: w });
  assert.equal(outcome.status, 'applied');
  assert.deepEqual([...outcome.written].sort(), ['assets/one.bin', 'assets/three.bin', 'assets/two.bin']);
  assert.equal(lstatSync(join(fx.workspace, 'assets', 'two.bin')).size, 90 * 1024 * 1024);
  assert.equal(outcome.verify, 'verified');
});

test('a worker that replaces a folder with a file, or a linked folder with a real one, is applied whole and rolls back whole', { skip }, async t => {
  const fx = fixture(t, { files: { 'x/a.txt': 'a\n', 'store/s.txt': 's\n' }, commit: false }), id = fx.project.id;
  symlinkSync('store', join(fx.workspace, 'assets'));
  git(fx.repo, 'add', '-A'); git(fx.repo, 'commit', '-q', '-m', 'first');
  const seed = await fx.engine.snapshot(id, fx.root);
  const w = fx.worktree('worker', 'w1', seed.commit);
  rmSync(join(w.root, 'x'), { recursive: true }); writeFileSync(join(w.root, 'x'), 'now a file\n');
  rmSync(join(w.root, 'assets')); put(w.root, 'assets/b.txt', 'b\n');
  const tip = await fx.engine.snapshot(id, w);
  const outcome = await fx.engine.apply(id, { target: fx.root, base: seed.commit, incoming: tip.commit, kind: 'worker', source: {}, mode: 'partial', labels: MERGE_LABELS.worker('w1'), incomingRoot: w });
  assert.equal(outcome.status, 'applied', JSON.stringify(outcome.conflicts));
  assert.equal(outcome.verify, 'verified');
  assert.equal(read(fx.workspace, 'x'), 'now a file\n', 'the deletes went through but the file that replaces the folder was never written');
  assert.ok(lstatSync(join(fx.workspace, 'assets')).isDirectory());
  assert.equal(read(fx.workspace, 'assets/b.txt'), 'b\n');
  assert.equal(existsSync(join(fx.workspace, 'store', 'b.txt')), false, 'a write went through the link');
  assert.deepEqual(fx.applies().map(row => row.state), ['verified']);
  const preview = await fx.engine.rollback(id, outcome.applyId, {});
  const undone = await fx.engine.rollback(id, outcome.applyId, { confirm: preview.confirm });
  assert.equal(undone.verify, 'verified');
  assert.equal(read(fx.workspace, 'x/a.txt'), 'a\n');
  assert.equal(readlinkSync(join(fx.workspace, 'assets')), 'store');
  assert.equal(read(fx.workspace, 'store/s.txt'), 's\n');
});

test('a write refused before any file changed leaves no `writing` record behind for startup recovery to "complete"', { skip }, async t => {
  const fx = fixture(t, { files: { 'a.txt': 'one\n' } }), id = fx.project.id;
  const head = git(fx.repo, 'rev-parse', 'HEAD:a.txt').trim();
  const conflict = { path: '.rna/planted.txt', kind: 'content', incoming: { mode: '100644', oid: head } };
  await assert.rejects(fx.engine.take(id, { target: fx.root, items: [{ conflict, side: 'incoming' }], source: {} }), { code: 'write_path_denied' });
  assert.deepEqual(fx.applies(), []);
  assert.equal(fx.refs().filter(ref => ref.startsWith('refs/rna/apply/')).length, 0);
});

test('a merge never writes inside another repository the project folder holds: it is in no checkpoint, so it could not be rolled back', { skip }, async t => {
  const fx = fixture(t, { files: { 'a.txt': 'one\n' } }), id = fx.project.id;
  put(fx.workspace, 'vendor/lib/own.js', 'theirs\n');
  git(join(fx.workspace, 'vendor', 'lib'), 'init', '-q');
  const seed = await fx.engine.snapshot(id, fx.root);
  assert.deepEqual(seed.nested, ['vendor/lib/']);
  const w = fx.worktree('worker', 'w1', seed.commit);
  put(w.root, 'vendor/lib/patch.js', 'planted\n');
  put(w.root, 'a.txt', 'two\n');
  const tip = await fx.engine.snapshot(id, w);
  const outcome = await fx.engine.apply(id, { target: fx.root, base: seed.commit, incoming: tip.commit, kind: 'worker', source: {}, mode: 'partial', labels: MERGE_LABELS.worker('w1'), incomingRoot: w });
  assert.deepEqual(outcome.written, ['a.txt']);
  assert.deepEqual(outcome.conflicts.map(row => [row.path, row.kind]), [['vendor/lib/patch.js', 'submodule']]);
  assert.equal(existsSync(join(fx.workspace, 'vendor', 'lib', 'patch.js')), false);
  assert.equal(read(fx.workspace, 'vendor/lib/own.js'), 'theirs\n');
});

test('rollback after later edits: a record rolled back once is not rolled back again over the user\'s new work, and a rollback of some files leaves the rest open', { skip }, async t => {
  const fx = fixture(t, { files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } }), id = fx.project.id;
  const seed = await fx.engine.snapshot(id, fx.root);
  const w = fx.worktree('worker', 'w1', seed.commit);
  put(w.root, 'a.txt', 'a\nfrom the worker\n');
  put(w.root, 'b.txt', 'b\nfrom the worker\n');
  const tip = await fx.engine.snapshot(id, w);
  const merged = await fx.engine.apply(id, { target: fx.root, base: seed.commit, incoming: tip.commit, kind: 'worker', source: {}, mode: 'partial', labels: MERGE_LABELS.worker('w1'), incomingRoot: w });
  // Only a.txt is rolled back (the user unticked b.txt): the record stays open for b.txt.
  const some = await fx.engine.rollback(id, merged.applyId, { paths: ['a.txt'] });
  const partial = await fx.engine.rollback(id, merged.applyId, { paths: ['a.txt'], confirm: some.confirm }, { initiator: 'user' });
  assert.equal(read(fx.workspace, 'a.txt'), 'a\n');
  assert.equal(fx.applies().find(row => row.id === merged.applyId).state, 'verified');
  // The record says it undid only some files (what the models are told), and who asked.
  assert.deepEqual([fx.applies().find(row => row.id === partial.applyId).partial, fx.applies().find(row => row.id === partial.applyId).initiator], [true, 'user']);
  const rest = await fx.engine.rollback(id, merged.applyId, {});
  assert.deepEqual(rest.files.map(row => row.path), ['b.txt']);
  const whole = await fx.engine.rollback(id, merged.applyId, { confirm: rest.confirm });
  assert.equal(read(fx.workspace, 'b.txt'), 'b\n');
  assert.equal(fx.applies().find(row => row.id === whole.applyId).partial, undefined);
  assert.equal(fx.applies().find(row => row.id === merged.applyId).state, 'rolled_back');
  // The user writes the same line again by hand: a second rollback of the record must not take it out.
  put(fx.workspace, 'b.txt', 'b\nfrom the worker\n');
  await assert.rejects(fx.engine.rollback(id, merged.applyId, {}), { code: 'rollback_nothing' });
  assert.equal(read(fx.workspace, 'b.txt'), 'b\nfrom the worker\n');
});

test('crash recovery never writes into P while the user is in the middle of a rebase: the row waits on its card', { skip }, async t => {
  const files = { 'f1.txt': '1\n', 'f2.txt': '2\n', 'f3.txt': '3\n' };
  const fx = fixture(t, { files }), id = fx.project.id;
  const seed = await fx.engine.snapshot(id, fx.root);
  const w = fx.worktree('worker', 'w1', seed.commit);
  for (const name of Object.keys(files)) put(w.root, name, `${name} by the worker\n`);
  const tip = await fx.engine.snapshot(id, w);
  let count = 0;
  fx.engine.settings.hooks = { beforeWrite: () => { if (count++ >= 1) throw Object.assign(new Error('the process went away'), { code: 'test_crash' }); } };
  await assert.rejects(fx.engine.apply(id, { target: fx.root, base: seed.commit, incoming: tip.commit, kind: 'worker', source: {}, mode: 'all', labels: MERGE_LABELS.worker('w1'), incomingRoot: w }), { code: 'test_crash' });
  fx.engine.settings.hooks = null;
  assert.equal(fx.applies()[0].state, 'writing');
  mkdirSync(join(fx.commonDir, 'rebase-merge'));
  const engine = new IsolationEngine(fx.store, { git: fx.service, ready: true, sandbox: () => true, pollMs: 20 });
  t.after(() => engine.close());
  const outcome = await engine.recover();
  assert.deepEqual(outcome.interrupted, [fx.applies()[0].id]);
  assert.equal(read(fx.workspace, 'f2.txt'), '2\n', 'recovery wrote into the folder during the rebase');
  assert.equal(read(fx.workspace, 'f3.txt'), '3\n');
  rmSync(join(fx.commonDir, 'rebase-merge'), { recursive: true });
  await engine.resolveInterrupted(id, fx.applies()[0].id, 'complete');
  for (const name of Object.keys(files)) assert.equal(read(fx.workspace, name), `${name} by the worker\n`);
});

test('git older than 2.38: checkpoints and the panel discard still work, merges and rollbacks are refused plainly', { skip }, async t => {
  const fx = fixture(t, { files: { 'a.txt': 'one\n' } }), id = fx.project.id;
  // git 2.37 as it answers: its version, and an unknown option for merge-tree --write-tree.
  const run = fx.service.run.bind(fx.service);
  fx.service.run = async (cwd, args, options) => {
    if (args[0] === '--version') return { code: 0, stdout: 'git version 2.37.3\n', stderr: '' };
    if (args.includes('merge-tree')) return { code: 129, stdout: '', stderr: "error: unknown option `write-tree'\n" };
    return run(cwd, args, options);
  };
  assert.equal((await fx.engine.isolation(id)).reason, 'git_too_old');
  put(fx.workspace, 'a.txt', 'changed\n');
  const step = await fx.service.discard(id, { paths: ['a.txt'] });
  const discarded = await fx.service.discard(id, { paths: ['a.txt'], confirm: step.confirm });
  assert.ok(discarded.applyId, 'the discard still takes its checkpoint');
  await assert.rejects(fx.engine.rollback(id, discarded.applyId, {}), error => error.code === 'git_unavailable' && error.reason === 'git_too_old' && /2\.38/.test(error.message));
  const seed = await fx.engine.snapshot(id, fx.root);
  await assert.rejects(fx.engine.apply(id, { target: fx.root, base: seed.commit, incoming: seed.commit, kind: 'worker', source: {}, mode: 'partial', labels: MERGE_LABELS.worker('w1') }), { code: 'git_unavailable' });
  assert.equal(read(fx.workspace, 'a.txt'), 'one\n');
});

test('after the user prunes the repository (`git gc --prune=now`), checkpoints and the panel discard keep working', { skip }, async t => {
  const fx = fixture(t, { files: { 'a.txt': 'one\n' } }), id = fx.project.id;
  put(fx.workspace, 'notes.txt', 'my untracked notes\n');
  const first = await fx.engine.snapshot(id, fx.root);
  // The private index names the notes' blob, which no ref holds: git's own maintenance removes it.
  git(fx.repo, 'gc', '-q', '--prune=now');
  const second = await fx.engine.snapshot(id, fx.root);
  assert.equal(second.tree, first.tree);
  put(fx.workspace, 'a.txt', 'changed\n');
  const step = await fx.service.discard(id, { paths: ['a.txt'] });
  const done = await fx.service.discard(id, { paths: ['a.txt'], confirm: step.confirm });
  assert.ok(done.applyId, 'no checkpoint could be taken, so nothing could be discarded');
  assert.equal(read(fx.workspace, 'notes.txt'), 'my untracked notes\n');
});

test('agent_merge take of a both-added conflict never writes the incoming side\'s link when it leaves the folder', { skip }, async t => {
  const fx = fixture(t, { files: { 'a.txt': 'one\n' } }), id = fx.project.id;
  const seed = await fx.engine.snapshot(id, fx.root);
  const w = fx.worktree('worker', 'w1', seed.commit);
  symlinkSync('../../../outside', join(w.root, 'x'));
  put(fx.workspace, 'x', 'the user made this file meanwhile\n');
  const tip = await fx.engine.snapshot(id, w);
  const outcome = await fx.engine.apply(id, { target: fx.root, base: seed.commit, incoming: tip.commit, kind: 'worker', source: {}, mode: 'partial', labels: MERGE_LABELS.worker('w1'), incomingRoot: w });
  const conflict = outcome.conflicts.find(row => row.path === 'x');
  // Both sides added `x` (a file here, a link there): a kind the model may take (design §4.1, not user-only); the side
  // it takes is a link out of the project folder.
  assert.ok(conflict && !USER_ONLY_CONFLICTS.includes(conflict.kind), JSON.stringify(outcome.conflicts));
  const taken = await fx.engine.take(id, { target: fx.root, items: [{ conflict, side: 'incoming' }], source: {} });
  assert.equal(taken.status, 'conflicted');
  assert.deepEqual(taken.conflicts.map(row => [row.path, row.kind]), [['x', 'unsafe_symlink']]);
  assert.deepEqual(taken.taken, []);
  assert.equal(read(fx.workspace, 'x'), 'the user made this file meanwhile\n');
  assert.equal(lstatSync(join(fx.workspace, 'x')).isSymbolicLink(), false);
});

test('the session card\'s "this conversation\'s version" leaves a refused entry open instead of dropping it from S', { skip }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  const S = (await f.rootOf(s.id)).root;
  // Unapplied in S: a link out of the folder; meanwhile the user made a file of that name in P.
  symlinkSync('../../../../outside', join(S, 'x'));
  put(f.P, 'x', 'the user made this\n');
  const pending = await f.sessionWorktrees.applyIdle(s.id);
  assert.equal(pending?.status, 'pending', JSON.stringify(pending));
  const turnId = f.sessionOf(s.id).turns.at(-1).id;
  await f.sessionWorktrees.answerConflict(s.id, turnId, 'conversation');
  assert.equal(lstatSync(join(f.P, 'x')).isSymbolicLink(), false, 'a link out of the folder was planted in P');
  assert.equal(read(f.P, 'x'), 'the user made this\n');
  assert.ok(lstatSync(join(S, 'x')).isSymbolicLink(), 'the conversation\'s entry was dropped from its worktree');
  const apply = f.sessionOf(s.id).turns.find(row => row.id === turnId).apply;
  assert.equal(apply.status, 'pending');
  assert.deepEqual(apply.conflict.paths.map(row => row.path), ['x']);
});
