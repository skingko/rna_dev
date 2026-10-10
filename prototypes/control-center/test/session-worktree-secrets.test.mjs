// B8 review finding 1: a conversation running in its own worktree changes files that hold secrets (SECRET_FILES).
// Snapshots never hold them, so no apply carries them into the project folder; the user is told once per path with a
// timeline line, the model at the start of its next turn, and deleting the conversation counts them (they go to the
// trash with the worktree, never into Git). Real temporary repositories, the real engine, worktree services and
// runtime controller (helpers/turn-fixture.mjs) with a scripted model; no network, no paid model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { turnFixture, skip, read, carries } from './helpers/turn-fixture.mjs';
import { SessionDeletionService } from '../session-deletion.mjs';

const told = (f, sessionId, path) => f.sessionOf(sessionId).items.filter(item => item.kind === 'notice' && item.source === 'worktree' && item.text.includes(path) && /存放密钥/.test(item.text));
const heard = (request, path) => carries(request, 'host-worktree-sync') && JSON.stringify(request.messages).includes('never applies files that hold secrets') && JSON.stringify(request.messages).includes(path);

test('a worktree conversation\'s secret files never reach the project folder: the user and the model are told once, and deleting counts them', { skip, timeout: 180000 }, async t => {
  const f = turnFixture(t);
  const session = f.worktreeSession();
  f.model.steps.push({ text: 'ready' });
  await f.send(session.id, 'prepare');
  const S = (await f.rootOf(session.id)).root;

  // The model changes a normal file and a secret one (`*.env`: the project tools allow it, it has no leading dot).
  f.model.steps.push({ writes: [['a.txt', 'from S\n'], ['deploy/prod.env', 'TOKEN=synthetic-session\n']] }, { text: 'done' });
  const first = await f.send(session.id, 'write both');
  assert.equal(first.apply.status, 'applied');
  assert.equal(read(f.P, 'a.txt'), 'from S\n');
  assert.equal(existsSync(join(f.P, 'deploy/prod.env')), false, 'never applied');
  assert.equal(read(S, 'deploy/prod.env'), 'TOKEN=synthetic-session\n', 'it stays in the worktree');
  const [line] = told(f, session.id, 'deploy/prod.env');
  assert.ok(line, 'the user is told in the timeline'); assert.equal(line.turnId, first.id);
  assert.match(line.text, /\.rna\/worktrees\.nosync\//, 'and where the file is');
  assert.deepEqual(f.recordOf(session.id).secretNote, ['deploy/prod.env'], 'the model hears it with its next turn');

  // A secret file as the turn's only change: the apply has nothing to carry, the user is still told.
  let mark = f.model.requests.length;
  f.model.steps.push({ write: ['staging.env', 'TOKEN=synthetic-staging\n'] }, { text: 'done' });
  const second = await f.send(session.id, 'write the staging one');
  assert.ok(f.model.requests.slice(mark).some(request => heard(request, 'deploy/prod.env')), 'this turn\'s request carries the host note');
  assert.equal(existsSync(join(f.P, 'staging.env')), false);
  assert.equal(told(f, session.id, 'staging.env').length, 1);
  assert.equal(told(f, session.id, 'staging.env')[0].turnId, second.id);
  assert.equal(told(f, session.id, 'deploy/prod.env').length, 1, 'told once, not at every apply');
  assert.deepEqual(f.recordOf(session.id).secretNote, ['staging.env'], 'the model heard of prod.env once; staging.env is next');
  assert.deepEqual(f.recordOf(session.id).secretTold, ['deploy/prod.env', 'staging.env']);

  // Deleting the conversation counts both, and says they are secret files (the trash, not Git).
  const deletions = new SessionDeletionService(f.store, { sessionWorktrees: f.sessionWorktrees, worktrees: f.worktrees, intervalMs: 3600000 });
  t.after(() => deletions.close());
  const refusal = await deletions.confirmWorktree(session.id).then(() => null, error => error);
  assert.equal(refusal?.code, 'worktree_unapplied');
  assert.equal(refusal.unapplied, 2); assert.equal(refusal.secret, 2);
  assert.match(refusal.message, /2 个是存放密钥的文件|2 of them hold secrets/);

  // The user copies one over by hand: it is no longer kept apart, and no longer counted.
  mkdirSync(join(f.P, 'deploy'), { recursive: true });
  copyFileSync(join(S, 'deploy/prod.env'), join(f.P, 'deploy/prod.env'));
  mark = f.model.requests.length;
  f.model.steps.push({ text: 'nothing to do' });
  await f.send(session.id, 'look');
  assert.ok(f.model.requests.slice(mark).some(request => heard(request, 'staging.env')));
  assert.equal(f.recordOf(session.id).secretNote, undefined, 'nothing left to tell the model');
  assert.deepEqual(f.recordOf(session.id).secretTold, ['staging.env']);
  assert.deepEqual(await deletions.confirmWorktree(session.id).then(() => null, error => [error.unapplied, error.secret]), [1, 1]);
});
