import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put, read, skip } from './git-isolation-fixture.mjs';
import { MERGE_LABELS } from '../git-isolation/index.mjs';
import { deriveWorkspaceEvents, turnReversion } from '../workspace-events.mjs';

// A rollback that leaves some files as they were says so on its own record (review K1-1): the engine writes the plan's
// skipped files on the rollback row, so the models' "the user undid X" (workspace-events.mjs) is partial and names
// them, instead of claiming a complete undo while those files still carry the change. Real temporary repositories.

const FIVE = 'l1\nl2\nl3\nl4\nl5\n';
const events = f => deriveWorkspaceEvents(f.store.state, f.store.state.projects.find(row => row.id === f.project.id));
const row = (f, id) => f.applies().find(item => item.id === id);

test('rollback(): a file changed after the record stays as it is, and the rollback record and its event say so', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': FIVE, 'b.txt': 'b\n' } });
  const id = f.project.id, sessionId = f.project.primarySessionId, agentId = 'agent-00000001';
  const seed = await f.engine.snapshot(id, f.root), w = f.worktree('worker', agentId, seed.commit);
  put(w.root, 'a.txt', 'L1\nl2\nl3\nl4\nl5\n'); put(w.root, 'b.txt', 'b worker\n');
  const final = await f.engine.snapshot(id, w);
  const applied = await f.engine.apply(id, { target: f.root, base: seed.commit, incoming: final.commit, kind: 'worker', source: { sessionId, turnId: 't1', agentId }, mode: 'all', labels: MERGE_LABELS.worker(agentId), incomingRoot: w });
  assert.equal(applied.status, 'applied');
  put(f.workspace, 'b.txt', 'b user\n');
  const preview = await f.engine.rollback(id, applied.applyId, {}, { initiator: 'user' });
  const done = await f.engine.rollback(id, applied.applyId, { confirm: preview.confirm }, { initiator: 'user' });
  assert.deepEqual(done.skipped, [{ path: 'b.txt', reason: 'changed_after' }]);
  assert.equal(read(f.workspace, 'b.txt'), 'b user\n');
  const record = row(f, done.applyId);
  assert.deepEqual({ kind: record.kind, initiator: record.initiator, skipped: record.skipped, partial: record.partial }, { kind: 'rollback', initiator: 'user', skipped: [{ path: 'b.txt', reason: 'changed_after' }], partial: undefined }, '`partial` stays the `paths` rollback\'s mark');
  const [event] = events(f);
  assert.deepEqual({ id: event.id, kind: event.kind, partial: event.partial, skipped: event.skipped, paths: event.paths }, { id: done.applyId, kind: 'record_rolled_back', partial: true, skipped: [{ path: 'b.txt', reason: 'changed_after' }], paths: ['a.txt'] });
  // A complete rollback records no `skipped` (nothing the derived event would have to qualify).
  const again = await f.engine.rollback(id, done.applyId, {}, { initiator: 'user' });
  const undone = await f.engine.rollback(id, done.applyId, { confirm: again.confirm }, { initiator: 'user' });
  assert.deepEqual(undone.skipped, []); assert.equal(row(f, undone.applyId).skipped, undefined);
  assert.equal(events(f).find(item => item.id === undone.applyId).partial, undefined);
});

test('rollbackTurn(): a worktree turn\'s file changed afterwards, and a direct-mode turn\'s file another writer changed, make the turn\'s undo partial', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': FIVE, 'b.txt': 'b\n' } });
  const id = f.project.id, sessionId = f.project.primarySessionId;
  // The worktree conversation's turn: two hand-backs into the project folder; b.txt then changed by the user.
  const seed = await f.engine.snapshot(id, f.root), s = f.worktree('session', 'sess0001', seed.commit, { owner: { sessionId } });
  const handBack = async (base, change) => { await change(s.root); const tip = await f.engine.snapshot(id, s); const outcome = await f.engine.apply(id, { target: f.root, base, incoming: tip.commit, kind: 'turn', source: { sessionId, turnId: 'turn-1', worktreeId: 'sess0001' }, mode: 'all', labels: MERGE_LABELS.sessionToProject() }); assert.equal(outcome.status, 'applied'); return tip.commit; };
  const first = await handBack(seed.commit, root => put(root, 'a.txt', 'L1\nl2\nl3\nl4\nl5\n'));
  await handBack(first, root => put(root, 'b.txt', 'b turn\n'));
  put(f.workspace, 'b.txt', 'b user\n');
  const preview = await f.engine.rollbackTurn(id, 'turn-1', {}, { initiator: 'user' });
  const done = await f.engine.rollbackTurn(id, 'turn-1', { confirm: preview.confirm }, { initiator: 'user' });
  assert.deepEqual(done.skipped, [{ path: 'b.txt', reason: 'changed_after' }]);
  assert.deepEqual(row(f, done.applyId).skipped, [{ path: 'b.txt', reason: 'changed_after' }]);
  const turnEvent = events(f).find(item => item.id === done.applyId);
  assert.deepEqual({ kind: turnEvent.kind, partial: turnEvent.partial, skipped: turnEvent.skipped }, { kind: 'turn_rolled_back', partial: true, skipped: [{ path: 'b.txt', reason: 'changed_after' }] });
  assert.equal(turnReversion(events(f), sessionId, 'turn-1').partial, true, 'continuity.recentTurns[].undone says partial');

  // A direct-mode turn: its checkpoint names c.txt as another writer's during the turn (unattributable).
  const start = await f.engine.snapshot(id, f.root);
  put(f.workspace, 'c.txt', 'turn made c\n'); put(f.workspace, 'd.txt', 'someone else\n');
  const end = await f.engine.snapshot(id, f.root);
  f.engine.attributable = async (projectId, turnId) => (turnId === 'turn-2' ? { start: start.commit, end: end.commit, paths: ['c.txt'], excluded: [{ path: 'd.txt', applyId: 'aother' }] } : null);
  const second = await f.engine.rollbackTurn(id, 'turn-2', {}, { initiator: 'user' });
  const direct = await f.engine.rollbackTurn(id, 'turn-2', { confirm: second.confirm }, { initiator: 'user' });
  assert.deepEqual(row(f, direct.applyId).skipped, [{ path: 'd.txt', reason: 'unattributable' }]);
  const directEvent = events(f).find(item => item.id === direct.applyId);
  assert.deepEqual({ kind: directEvent.kind, partial: directEvent.partial, skipped: directEvent.skipped }, { kind: 'turn_rolled_back', partial: true, skipped: [{ path: 'd.txt', reason: 'unattributable' }] });
});
