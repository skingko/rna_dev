// B8: deleting a conversation whose subagent workers' copies hold changes not merged yet asks first, like a
// conversation worktree with unapplied changes (design 0.63 §5.3); confirming discards them, each copy's last state
// pinned at its tip ref. A real temporary repository and the real services (helpers/turn-fixture.mjs); no network,
// no model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { turnFixture, put, skip, git } from './helpers/turn-fixture.mjs';
import { REFS, TRASH_DIR } from '../git-isolation/index.mjs';
import { SessionDeletionService } from '../session-deletion.mjs';

/** A worker the conversation delegated, its copy made from P and changed, its merge left to the conversation. */
async function pendingWorker(f, agentId, { files = {}, merge = { status: 'pending', applyIds: [], reason: 'parent_idle' }, applied = [] } = {}) {
  const turnId = f.sessionOf(f.session.id).turns.at(-1).id;
  const parent = await f.roots.rootOf({ projectId: f.project.id });
  const record = await f.worktrees.create(f.project.id, { kind: 'worker', owner: { sessionId: f.session.id, turnId, agentId }, parent, label: `Rna worker ${agentId}` });
  for (const [path, content] of Object.entries(files)) put(join(f.P, record.dir), path, content);
  f.store.mutate(state => {
    const turn = state.sessions.find(row => row.id === f.session.id).turns.find(row => row.id === turnId);
    turn.delegations = [...(turn.delegations ?? []), { id: agentId, role: 'worker', status: 'completed', task: `Write the part of ${agentId}`, merge, mergeWork: { seed: record.seed, applied } }];
  });
  return record;
}

test('deleting a conversation with workers whose changes are not merged needs a confirmation; their copies go with it', { skip }, async t => {
  const f = turnFixture(t);
  f.model.steps.push({ text: '好。' });
  await f.send(f.session.id, '开始');
  const waiting = await pendingWorker(f, 'agent-wait0001', { files: { 'a.txt': 'worker one\n', 'notes/new.md': 'new\n' } });
  // A worker merged in part (a conflict left): only the files not merged count.
  const conflicted = await pendingWorker(f, 'agent-conf0001', { files: { 'a.txt': 'worker two\n', 'b.md': 'b\n' }, merge: { status: 'conflict', applyIds: ['a1'], conflicts: [{ path: 'a.txt', kind: 'content' }] }, applied: ['b.md'] });
  // A worker whose merge settled has nothing left to lose.
  const merged = await pendingWorker(f, 'agent-done0001', { files: { 'c.md': 'c\n' }, merge: { status: 'merged', applyIds: ['a2'], files: 1 } });
  const deletions = new SessionDeletionService(f.store, { worktrees: f.worktrees, intervalMs: 3600000 });
  t.after(() => deletions.close());

  const refusal = await deletions.confirmWorktree(f.session.id).then(() => null, error => error);
  assert.equal(refusal?.code, 'worktree_unapplied'); assert.equal(refusal.status, 409); assert.equal(refusal.unapplied, 0);
  assert.deepEqual(refusal.workers, [
    { agentId: 'agent-wait0001', worktreeId: waiting.id, files: 2, task: 'Write the part of agent-wait0001', role: 'worker' },
    { agentId: 'agent-conf0001', worktreeId: conflicted.id, files: 1, task: 'Write the part of agent-conf0001', role: 'worker' },
  ]);
  assert.match(refusal.message, /2 个子代理.*3 个文件|2 subagent.*3 file/);
  assert.deepEqual(await deletions.confirmWorktree(f.session.id, { confirm: true }), { unapplied: 0, workers: refusal.workers });

  f.store.deleteSession(f.session.id);
  assert.equal((await deletions.wait(f.session.id, 30000)).status, 'completed');
  const rows = f.projectRow().git.worktrees;
  for (const record of [waiting, conflicted, merged]) {
    assert.equal(rows.find(row => row.id === record.id).state, 'removed', `${record.id} removed`);
    assert.equal(existsSync(join(f.P, record.dir)), false);
  }
  assert.ok(git(f.repo, 'rev-parse', REFS.worktree(waiting.id, 'tip')).trim(), 'the discarded copy\'s last state stays pinned');
  assert.equal(git(f.repo, 'show', `${REFS.worktree(waiting.id, 'tip')}:a.txt`), 'worker one\n');
});

test('a conversation whose workers changed nothing, or merged everything, is deleted without asking', { skip }, async t => {
  const f = turnFixture(t);
  f.model.steps.push({ text: '好。' });
  await f.send(f.session.id, '开始');
  await pendingWorker(f, 'agent-idle0001');
  await pendingWorker(f, 'agent-done0002', { files: { 'c.md': 'c\n' }, merge: { status: 'merged', applyIds: ['a2'], files: 1 } });
  const deletions = new SessionDeletionService(f.store, { worktrees: f.worktrees, intervalMs: 3600000 });
  t.after(() => deletions.close());
  assert.deepEqual(await deletions.confirmWorktree(f.session.id), { unapplied: 0 });
});

test('a worker whose only unmerged change is a secret file is named too: counted, and said to go to the trash rather than Git', { skip }, async t => {
  const f = turnFixture(t);
  f.model.steps.push({ text: '好。' });
  await f.send(f.session.id, '开始');
  const keyOnly = await pendingWorker(f, 'agent-key00001', { files: { 'deploy/prod.env': 'TOKEN=synthetic-worker\n' } });
  const deletions = new SessionDeletionService(f.store, { worktrees: f.worktrees, intervalMs: 3600000 });
  t.after(() => deletions.close());
  const refusal = await deletions.confirmWorktree(f.session.id).then(() => null, error => error);
  assert.equal(refusal?.code, 'worktree_unapplied');
  assert.deepEqual(refusal.workers, [{ agentId: 'agent-key00001', worktreeId: keyOnly.id, files: 1, task: 'Write the part of agent-key00001', role: 'worker', secret: 1 }]);
  assert.equal(refusal.secret, 1);
  assert.match(refusal.message, /1 个是存放密钥的文件.*trash\.nosync|1 of them hold secrets.*trash\.nosync/);
  f.store.deleteSession(f.session.id);
  assert.equal((await deletions.wait(f.session.id, 30000)).status, 'completed');
  const trash = join(f.P, ...TRASH_DIR.split('/'));
  assert.ok(readdirSync(trash).some(name => name.startsWith(`${keyOnly.id}-`) && existsSync(join(trash, name, 'deploy/prod.env'))), 'kept in the trash, as the confirmation said');
});

test('a merged worker whose copy was kept (it did not read back as merged) is listed with those files before deleting takes it along', { skip }, async t => {
  const f = turnFixture(t);
  f.model.steps.push({ text: '好。' });
  await f.send(f.session.id, '开始');
  // Its merge settled as merged, but the read-back check found c.md different: the copy is kept for the user to look at.
  const unverified = await pendingWorker(f, 'agent-unver001', { files: { 'c.md': 'c from the worker\n', 'd.md': 'd\n' }, merge: { status: 'merged', applyIds: ['a3'], files: 2 }, applied: ['c.md', 'd.md'] });
  f.store.mutate(state => { const row = state.sessions.find(item => item.id === f.session.id).turns.flatMap(turn => turn.delegations ?? []).find(item => item.id === 'agent-unver001'); row.mergeWork.unverified = ['c.md']; });
  f.worktrees.setState(f.project.id, unverified.id, 'kept');
  // A merged worker whose copy is still there holding a secret file it changed: that file never merged.
  const keyed = await pendingWorker(f, 'agent-mkey0001', { files: { 'e.md': 'e\n', 'deploy/prod.env': 'TOKEN=synthetic-merged\n' }, merge: { status: 'merged', applyIds: ['a4'], files: 1 }, applied: ['e.md'] });
  const deletions = new SessionDeletionService(f.store, { worktrees: f.worktrees, intervalMs: 3600000 });
  t.after(() => deletions.close());
  const refusal = await deletions.confirmWorktree(f.session.id).then(() => null, error => error);
  assert.equal(refusal?.code, 'worktree_unapplied');
  assert.deepEqual(refusal.workers, [
    { agentId: 'agent-unver001', worktreeId: unverified.id, files: 1, task: 'Write the part of agent-unver001', role: 'worker' },
    { agentId: 'agent-mkey0001', worktreeId: keyed.id, files: 1, task: 'Write the part of agent-mkey0001', role: 'worker', secret: 1 },
  ]);
  assert.equal(refusal.secret, 1);
  f.store.deleteSession(f.session.id);
  assert.equal((await deletions.wait(f.session.id, 30000)).status, 'completed');
  assert.equal(f.projectRow().git.worktrees.find(row => row.id === unverified.id).state, 'removed', 'removed only after the confirmation listed it');
  assert.equal(git(f.repo, 'show', `${REFS.worktree(unverified.id, 'tip')}:c.md`), 'c from the worker\n', 'its last state stays pinned');
});
