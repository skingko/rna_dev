import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bytes, fixture, git, put, read, skip, treeBytes } from './git-isolation-fixture.mjs';
import { MERGE_LABELS, REFS } from '../git-isolation/index.mjs';
import { checkWritePath, write } from '../git-isolation/writer.mjs';

// Writing a merge result (worktree design 0.63 §3.5, §13 "写入"): two CAS checks per file, all-or-nothing for the
// project folder, per file for partial writes, conflict markers never in P, the user's index never touched.

const labels = MERGE_LABELS.worker('agent-0011223344');
/** A worker worktree made from the folder now, changed by `change`, snapshotted: the apply request for it. */
async function worker(f, change, id = 'agent-0011223344') {
  const seed = await f.engine.snapshot(f.project.id, f.root);
  const w = f.worktree('worker', id, seed.commit);
  await change(w.root);
  const final = await f.engine.snapshot(f.project.id, w);
  return { w, seed, final, request: mode => ({ target: f.root, base: seed.commit, incoming: final.commit, kind: 'worker', source: { sessionId: 's1', turnId: 't1', agentId: id, worktreeId: id }, mode, labels, incomingRoot: w }) };
}

test('a clean worker apply writes into the project folder, records [before, after] and leaves the index alone', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'one\ntwo\nthree\n', 'gone.txt': 'bye\n', 'run.sh': 'echo\n' } });
  put(f.workspace, 'staged.txt', 'staged\n'); git(f.repo, 'add', 'staged.txt');
  put(f.workspace, 'mine.txt', 'the user\'s own work\n');
  const job = await worker(f, root => { put(root, 'a.txt', 'one\ntwo\nthree\nfour\n'); rmSync(join(root, 'gone.txt')); put(root, 'docs/新 文件.md', '内容\n'); symlinkSync('a.txt', join(root, 'link')); chmodSync(join(root, 'run.sh'), 0o755); });
  const index = readFileSync(join(f.repo, '.git', 'index'));
  const outcome = await f.engine.apply(f.project.id, job.request('all'));
  assert.equal(outcome.status, 'applied', JSON.stringify(outcome));
  assert.deepEqual([...outcome.written].sort(), ['a.txt', 'docs/新 文件.md', 'link', 'run.sh']);
  assert.deepEqual(outcome.removed, ['gone.txt']);
  assert.equal(outcome.verify, 'verified');
  assert.equal(read(f.workspace, 'a.txt'), 'one\ntwo\nthree\nfour\n');
  assert.equal(read(f.workspace, 'docs/新 文件.md'), '内容\n');
  assert.ok(!existsSync(join(f.workspace, 'gone.txt')));
  assert.equal(git(f.repo, 'ls-files', '-s', 'run.sh').slice(0, 6), '100644');
  assert.ok(statSync(join(f.workspace, 'run.sh')).mode & 0o100, 'the executable bit is written');
  assert.equal(read(f.workspace, 'mine.txt'), 'the user\'s own work\n', 'the user\'s uncommitted work stays');
  assert.deepEqual(readFileSync(join(f.repo, '.git', 'index')), index, 'the user\'s index is not written');
  assert.equal(git(f.repo, 'diff', '--cached', '--name-only'), 'staged.txt\n', 'nothing new is staged; what was staged stays');
  // The record: verified, its ref holds [before, after]; after = before + exactly the written paths.
  const [row] = f.applies();
  assert.deepEqual({ id: row.id, kind: row.kind, target: row.target, state: row.state, files: row.files, added: row.added, removed: row.removed }, { id: outcome.applyId, kind: 'worker', target: 'project', state: 'verified', files: 5, added: 2, removed: 1 });
  const [before, after] = git(f.repo, 'rev-list', '--parents', '-n', '1', REFS.apply(row.id)).trim().split(' ').slice(1);
  assert.equal(before, outcome.before);
  assert.deepEqual(git(f.repo, '-c', 'core.quotePath=false', 'diff-tree', '-r', '--name-only', '--no-renames', before, after).trim().split('\n').sort(), ['a.txt', 'docs/新 文件.md', 'gone.txt', 'link', 'run.sh']);
  assert.match(git(f.repo, 'cat-file', 'blob', `${before}:mine.txt`), /own work/, 'before includes the user\'s uncommitted files');
  // The same worker applied again: nothing left to do, no record.
  const again = await f.engine.apply(f.project.id, job.request('all'));
  assert.equal(again.status, 'nothing'); assert.equal(again.applyId, null); assert.equal(f.applies().length, 1);
});

test('the first CAS: a file changed after the target snapshot makes an all-mode apply start over from a fresh one', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'a1\na2\na3\na4\na5\n', 'b.txt': 'b\n' } });
  const job = await worker(f, root => put(root, 'a.txt', 'a1\na2\na3\na4\nA5\n'));
  let once = true;
  f.engine.settings.hooks = { beforeCheck: () => { if (once) { once = false; put(f.workspace, 'a.txt', 'A1\na2\na3\na4\na5\n'); } } };
  const outcome = await f.engine.apply(f.project.id, job.request('all'));
  assert.equal(outcome.status, 'applied');
  assert.equal(read(f.workspace, 'a.txt'), 'A1\na2\na3\na4\nA5\n', 'the user\'s edit is the current side of the retried merge');
  assert.equal(f.applies().length, 1, 'the raced attempt left no record');
});

test('the second CAS: in all mode a race puts back what was written, retries, and blocks after three attempts', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'a\n', 'b.txt': 'b1\nb2\nb3\nb4\nb5\n', 'c.txt': 'c\n' } });
  const job = await worker(f, root => { put(root, 'a.txt', 'a worker\n'); put(root, 'b.txt', 'B1\nb2\nb3\nb4\nb5\n'); put(root, 'a-new.txt', 'new\n'); });
  const before = treeBytes(f.workspace);
  let edits = 0;
  // Someone keeps typing at the end of b.txt right before each rename of it: a clean merge every time, a race every time.
  f.engine.settings.hooks = { beforeRename: path => { if (path === 'b.txt') { edits++; appendFileSync(join(f.workspace, 'b.txt'), `user ${edits}\n`); } } };
  const blocked = await f.engine.apply(f.project.id, job.request('all'));
  assert.equal(blocked.status, 'blocked'); assert.equal(edits, 3, 'three attempts, each from a fresh snapshot');
  const now = treeBytes(f.workspace);
  assert.equal(now['a.txt'], before['a.txt'], 'a.txt went back byte for byte'); assert.equal(now['a-new.txt'], undefined, 'the new file was removed again');
  assert.equal(read(f.workspace, 'b.txt'), 'b1\nb2\nb3\nb4\nb5\nuser 1\nuser 2\nuser 3\n', 'the user\'s edits are never overwritten');
  assert.deepEqual(f.applies(), [], 'nothing was recorded'); assert.deepEqual(f.refs().filter(ref => ref.startsWith('refs/rna/apply/')), []);
  // Once the folder is quiet the same apply goes through, merged over the user's edits.
  f.engine.settings.hooks = null;
  const outcome = await f.engine.apply(f.project.id, job.request('all'));
  assert.equal(outcome.status, 'applied');
  assert.equal(read(f.workspace, 'b.txt'), 'B1\nb2\nb3\nb4\nb5\nuser 1\nuser 2\nuser 3\n');
  assert.equal(outcome.bothChanged, 1);
});

test('all mode writes nothing when anything conflicts, unless asked for the clean part only', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
  const job = await worker(f, root => { put(root, 'a.txt', 'a worker\n'); put(root, 'b.txt', 'b worker\n'); });
  put(f.workspace, 'b.txt', 'b user\n');
  const outcome = await f.engine.apply(f.project.id, job.request('all'));
  assert.equal(outcome.status, 'conflicted'); assert.equal(outcome.applyId, null); assert.deepEqual(outcome.written, []);
  assert.equal(read(f.workspace, 'a.txt'), 'a\n');
  const clean = await f.engine.apply(f.project.id, { ...job.request('all'), cleanOnly: true });
  assert.equal(clean.status, 'conflicted'); assert.deepEqual(clean.written, ['a.txt']); assert.deepEqual(clean.conflicts.map(row => row.path), ['b.txt']);
  assert.equal(read(f.workspace, 'b.txt'), 'b user\n', 'a conflict never writes, and never writes markers into the project folder');
});

test('partial mode writes file by file: a race becomes changed_during_merge, an ignored file in the way unexpected_file', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'a\n', 'b.txt': 'b\n', '.gitignore': 'out/\n' } });
  const job = await worker(f, root => { put(root, 'a.txt', 'a worker\n'); put(root, 'b.txt', 'b worker\n'); });
  f.engine.settings.hooks = { beforeRename: path => { if (path === 'b.txt') appendFileSync(join(f.workspace, 'b.txt'), 'typing\n'); } };
  const outcome = await f.engine.apply(f.project.id, job.request('partial'));
  assert.equal(outcome.status, 'conflicted');
  assert.deepEqual(outcome.written, ['a.txt']);
  assert.deepEqual(outcome.conflicts.map(row => [row.path, row.kind]), [['b.txt', 'changed_during_merge']]);
  assert.equal(read(f.workspace, 'b.txt'), 'b\ntyping\n');
  assert.deepEqual(f.applies()[0].skipped, [{ path: 'b.txt', reason: 'changed_during_merge' }]);
  // A file the target snapshot does not have (ignored there) but the disk does: never overwritten.
  f.engine.settings.hooks = null;
  writeFileSync(join(f.workspace, '.gitignore'), 'out/\nlocal.cfg\n');
  put(f.workspace, 'local.cfg', 'the user\'s ignored settings\n');
  // The worker un-ignores it in its copy and writes one of its own.
  const job2 = await worker(f, root => { writeFileSync(join(root, '.gitignore'), 'out/\n'); put(root, 'local.cfg', 'worker settings\n'); }, 'agent-99887766');
  const second = await f.engine.apply(f.project.id, job2.request('partial'));
  assert.deepEqual(second.conflicts.map(row => [row.path, row.kind]), [['local.cfg', 'unexpected_file']]);
  assert.equal(read(f.workspace, 'local.cfg'), 'the user\'s ignored settings\n');
});

test('text attributes are applied on the way out: a crlf file stays crlf', { skip }, async t => {
  const f = fixture(t, { files: { '.gitattributes': '*.txt text eol=crlf\n', 'a.txt': 'one\r\ntwo\r\n' } });
  const job = await worker(f, root => put(root, 'a.txt', 'one\r\ntwo\r\nthree\r\n'));
  const outcome = await f.engine.apply(f.project.id, job.request('all'));
  assert.equal(outcome.status, 'applied'); assert.equal(outcome.verify, 'verified');
  assert.equal(bytes(f.workspace, 'a.txt').toString(), 'one\r\ntwo\r\nthree\r\n');
  assert.equal(git(f.repo, 'status', '--porcelain'), ' M a.txt\n');
});

test('a write that does not read back as planned is recorded unverified with the files that differ', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'a\n' } });
  const job = await worker(f, root => put(root, 'a.txt', 'worker\n'));
  f.engine.settings.hooks = { beforeVerify: () => writeFileSync(join(f.workspace, 'a.txt'), 'someone else\n') };
  const outcome = await f.engine.apply(f.project.id, job.request('all'));
  assert.equal(outcome.verify, 'unverified'); assert.deepEqual(outcome.mismatched, ['a.txt']);
  assert.equal(f.applies()[0].state, 'unverified'); assert.deepEqual(f.applies()[0].skipped, [{ path: 'a.txt', reason: 'mismatch' }]);
});

test('paths into .git, out of the root or under .rna are refused, and markers never go into the project folder', { skip }, async t => {
  const f = fixture(t);
  for (const path of ['.git/config', 'sub/.GIT/x', '../outside.txt', 'a/../../b', '/etc/passwd', '.rna/worktrees.nosync/x', '.RNA/x', '', 'a//b']) await assert.rejects(checkWritePath(f.workspace, path), error => error.code === 'write_path_denied', path);
  mkdirSync(join(f.dir, 'outside')); symlinkSync(join(f.dir, 'outside'), join(f.workspace, 'escape'));
  await assert.rejects(checkWritePath(f.workspace, 'escape/file.txt'), error => error.code === 'write_path_denied', 'a link on the way is never followed');
  assert.equal(await checkWritePath(f.workspace, 'docs/new.md'), join(f.workspace, 'docs', 'new.md'));
  const context = await f.engine.context(f.project.id);
  await assert.rejects(write(context, f.root, [{ path: 'a.txt', expect: null, next: null }], { mode: 'markers' }), error => error.code === 'markers_target_denied');
  const job = await worker(f, root => put(root, 'a.txt', 'x\n'));
  await assert.rejects(f.engine.apply(f.project.id, job.request('markers')), error => error.code === 'markers_target_denied');
  await assert.rejects(write(context, job.w, [], { mode: 'markers' }), error => error.code === 'markers_target_denied', 'a worker copy never gets markers either');
});

test('markers mode writes text conflicts with this merge\'s labels into a session worktree, and nothing else', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'a\nb\nc\n', 'pic.bin': Buffer.from([0, 1, 0]) } });
  const seed = await f.engine.snapshot(f.project.id, f.root);
  const s = f.worktree('session', 'sess0001', seed.commit, { owner: { sessionId: 'sess0001' } });
  put(s.root, 'a.txt', 'a\nSESSION\nc\n'); put(s.root, 'pic.bin', Buffer.from([0, 2, 0]));
  put(f.workspace, 'a.txt', 'a\nFOLDER\nc\n'); put(f.workspace, 'pic.bin', Buffer.from([0, 3, 0])); put(f.workspace, 'clean.txt', 'from the folder\n');
  const p = await f.engine.snapshot(f.project.id, f.root);
  const outcome = await f.engine.apply(f.project.id, { target: s, base: seed.commit, incoming: p.commit, kind: 'turn', source: { sessionId: 'sess0001', turnId: 't1' }, mode: 'markers', labels: MERGE_LABELS.reverseMarkers() });
  assert.equal(outcome.status, 'conflicted');
  assert.deepEqual([...outcome.written].sort(), ['a.txt', 'clean.txt']);
  const text = read(s.root, 'a.txt');
  assert.match(text, new RegExp(`^<<<<<<< refs/rna/m/${outcome.mid}/this-conversation$`, 'm'));
  assert.match(text, new RegExp(`^>>>>>>> refs/rna/m/${outcome.mid}/project-folder$`, 'm'));
  assert.deepEqual(bytes(s.root, 'pic.bin'), Buffer.from([0, 2, 0]), 'a binary conflict is left for the user');
  assert.equal(read(f.workspace, 'a.txt'), 'a\nFOLDER\nc\n', 'the project folder is untouched');
  assert.equal(f.applies()[0].target, 'session:sess0001');
});
