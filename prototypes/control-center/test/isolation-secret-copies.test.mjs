// B8: the secret files Rna lays down into a worktree (they never ride a snapshot) are copies, not the worktree's own
// work: the worktrees panel does not count them as pending, and deleting the project still removes a worktree whose
// only difference is such a copy — while one whose copy the worker changed keeps it. Real temporary repositories, the
// real services (helpers/turn-fixture.mjs); no network, no model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { turnFixture, skip } from './helpers/turn-fixture.mjs';

test('laid-down secret copies are never pending in the panel, and a worktree holding only them is removed with its project', { skip, timeout: 90000 }, async t => {
  const f = turnFixture(t);
  writeFileSync(join(f.P, '.env'), 'API_KEY=synthetic-copy\n'); // neither committed nor ignored
  const parent = await f.roots.rootOf({ projectId: f.project.id });
  const clean = await f.worktrees.create(f.project.id, { kind: 'worker', id: 'w-copy-only', owner: { agentId: 'agent-copyonly' }, parent, label: 'Rna worker' });
  const changed = await f.worktrees.create(f.project.id, { kind: 'worker', id: 'w-copy-changed', owner: { agentId: 'agent-copychanged' }, parent, label: 'Rna worker' });
  const cleanTop = join(f.P, clean.dir), changedTop = join(f.P, changed.dir);
  assert.equal(readFileSync(join(cleanTop, '.env'), 'utf8'), 'API_KEY=synthetic-copy\n', 'laid down from P');
  writeFileSync(join(changedTop, '.env'), 'API_KEY=synthetic-rotated\n');
  const listed = await f.worktrees.list(f.project.id);
  assert.deepEqual(listed.worktrees.map(row => [row.id, row.pending.files]).sort(), [['w-copy-changed', 0], ['w-copy-only', 0]], 'a secret file never merges, so it is never pending');
  f.store.deleteProject(f.project.id);
  const released = await f.worktrees.releases.get(f.project.id);
  assert.deepEqual(released.removed, ['w-copy-only'], 'only a copy of P\'s file: nothing of its own to keep');
  assert.deepEqual(released.unlocked, ['w-copy-changed'], 'a changed copy is the worker\'s: left on disk');
  assert.equal(existsSync(cleanTop), false);
  assert.equal(readFileSync(join(changedTop, '.env'), 'utf8'), 'API_KEY=synthetic-rotated\n');
  assert.equal(readFileSync(join(f.P, '.env'), 'utf8'), 'API_KEY=synthetic-copy\n', 'the project folder\'s own file is untouched');
});
