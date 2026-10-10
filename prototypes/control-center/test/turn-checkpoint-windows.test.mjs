// B8 (review ISO-3, ISO-7, ISO-8): the direct-mode checkpoint's windows and the isolation timings a turn records.
// A real temporary repository, the real merge engine and a scripted model (helpers/turn-fixture.mjs); no network, no
// paid model, never the user's projects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { turnFixture, put, skip, git } from './helpers/turn-fixture.mjs';
import { REFS } from '../git-isolation/index.mjs';
import { TurnCheckpoint, objectGit } from '../turn-checkpoint.mjs';

const parents = (repo, ref) => git(repo, 'rev-list', '--parents', '-n', '1', ref).trim().split(' ').slice(1);
const windowsOf = (repo, ref) => JSON.parse(git(repo, 'log', '-1', '--format=%B', ref).trim()).windows;
/** A turn row the runtime does not run (the checkpoint is driven by hand). */
function handTurn(f, turnId) {
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).turns.push({ id: turnId, status: 'running', mode: 'build', createdAt: new Date().toISOString() }); });
  return { projectId: f.project.id, sessionId: f.session.id, turnId };
}

test('ISO-3: the end snapshot is taken under the repository lock: a host write in progress lands wholly in it', { skip }, async t => {
  const f = turnFixture(t);
  const checkpoints = new TurnCheckpoint(f.store, { engine: f.engine, git: f.git });
  const turn = handTurn(f, 'turn-iso3');
  assert.equal((await checkpoints.start(turn).ready).state, 'taken');
  // A host write into P (a worker's merge, a deferred background set) holds the lock: one file now, one after the gate.
  let release, entered;
  const gate = new Promise(done => { release = done; }), inside = new Promise(done => { entered = done; });
  const writer = f.engine.lock(f.project.id, async () => { put(f.P, 'a.txt', 'host write, first file\n'); entered(); await gate; put(f.P, 'src/app.js', 'host write, second file\n'); });
  await inside;
  let ended = false;
  const ending = checkpoints.end(turn).then(value => { ended = true; return value; });
  await delay(800);
  assert.equal(ended, false, 'the end waits for the write that holds the repository');
  release(); await writer;
  assert.equal((await ending).state, 'taken');
  const [, end] = parents(f.repo, REFS.turn('turn-iso3'));
  assert.equal(git(f.repo, 'show', `${end}:a.txt`), 'host write, first file\n');
  assert.equal(git(f.repo, 'show', `${end}:src/app.js`), 'host write, second file\n', 'never half of the write');
});

test('ISO-7: an attempt a restart cut off has its window closed where the next attempt begins', { skip }, async t => {
  const f = turnFixture(t);
  let clock = 1000;
  const turn = handTurn(f, 'turn-iso7');
  const first = new TurnCheckpoint(f.store, { engine: f.engine, git: f.git, now: () => clock });
  assert.equal((await first.start(turn).ready).state, 'taken');
  // The daemon restarts before the attempt ends: a new service, a new attempt.
  clock = 5000;
  const second = new TurnCheckpoint(f.store, { engine: f.engine, git: f.git, now: () => clock });
  assert.equal((await second.start(turn).ready).state, 'taken');
  assert.deepEqual(windowsOf(f.repo, REFS.turn('turn-iso7')), [[1000, 5000], [5000, null]]);
  put(f.P, 'a.txt', 'second attempt\n');
  clock = 9000;
  assert.equal((await second.end(turn)).state, 'taken');
  assert.deepEqual(windowsOf(f.repo, REFS.turn('turn-iso7')), [[1000, 5000], [5000, 9000]]);
});

test('ISO-7: attributable reads an open window left by an older release as rollbackTurn does: it ends where the next begins', { skip }, async t => {
  const f = turnFixture(t);
  const turn = handTurn(f, 'turn-legacy');
  const root = { root: f.P, kind: 'project', isolated: false, project: f.P, prefix: '' };
  const start = await f.engine.snapshot(f.project.id, root);
  put(f.P, 'a.txt', 'the turn\'s change\n');
  const end = await f.engine.snapshot(f.project.id, root);
  const objects = objectGit(f.git, await f.git.locateProject(f.project.id));
  const hold = await objects.commit(`${end.tree}`, [start.commit, end.commit], JSON.stringify({ kind: 'rna-turn-checkpoint', turnId: turn.turnId, windows: [[1000, null], [5000, 9000]] }));
  await f.engine.pin(f.project.id, [{ ref: REFS.turn(turn.turnId), commit: hold }]);
  f.store.mutate(state => {
    state.sessions.find(row => row.id === f.session.id).turns.find(row => row.id === turn.turnId).checkpoint = { ref: REFS.turn(turn.turnId), state: 'taken' };
    // A background set applied hours after the turn ended, touching the same file.
    const project = state.projects.find(row => row.id === f.project.id);
    project.git ??= { sessionWorktreeDefault: false, worktrees: [], applies: [] };
    project.git.applies = [...(project.git.applies ?? []), { id: 'a-later0001', kind: 'background', target: 'project', source: { actionId: 'action-later' }, state: 'verified', files: 1, added: 0, removed: 0, bothChanged: 0, sample: ['a.txt'], at: new Date(12000).toISOString() }];
  });
  const own = await f.checkpoints.attributable(f.project.id, turn.turnId);
  assert.deepEqual(own.paths, ['a.txt'], 'a write long after the turn is not "during" it');
  assert.deepEqual(own.excluded, []);
});

test('ISO-8: a direct-mode turn records how long its first write waited for the start checkpoint, the end checkpoint\'s time, and the write\'s gate wait', { skip }, async t => {
  const f = turnFixture(t);
  const snapshot = f.engine.snapshot.bind(f.engine);
  let slow = true;
  f.engine.snapshot = async (...args) => { if (slow) { slow = false; await delay(800); } return snapshot(...args); };
  f.model.steps.push({ write: ['a.txt', 'written\n'] }, { text: '好。' });
  const turn = await f.send(f.session.id, '写');
  assert.equal(turn.checkpoint.state, 'taken');
  const settled = f.sessionOf(f.session.id).turns.find(row => row.id === turn.id);
  assert.ok(settled.timing.checkpointWait >= 100, `checkpointWait ${settled.timing.checkpointWait}`);
  assert.ok(Number.isInteger(settled.timing.checkpointEnd) && settled.timing.checkpointEnd >= 0, `checkpointEnd ${settled.timing.checkpointEnd}`);
  const items = f.sessionOf(f.session.id).items.filter(item => item.turnId === turn.id && item.tool);
  const write = items.find(item => item.tool.name === 'project_write'), readItem = items.find(item => item.tool.name === 'project_read');
  assert.ok(write.tool.gateWaitMs >= 100, `gateWaitMs ${write.tool.gateWaitMs}`);
  assert.equal(readItem.tool.gateWaitMs, undefined, 'a read never waits at the gate');
});

test('ISO-8: a worktree conversation\'s turn records its start sync and the time it spent applying to the project folder', { skip }, async t => {
  const f = turnFixture(t);
  const session = f.worktreeSession();
  f.model.steps.push({ text: '准备。' });
  await f.send(session.id, '准备');
  f.model.steps.push({ write: ['a.txt', 'from the worktree\n'] }, { text: '好。' });
  const turn = await f.send(session.id, '写');
  assert.equal(turn.apply.status, 'applied');
  const settled = f.sessionOf(session.id).turns.find(row => row.id === turn.id);
  assert.ok(Number.isInteger(settled.timing.startSync) && settled.timing.startSync >= 0, `startSync ${settled.timing.startSync}`);
  assert.ok(Number.isInteger(settled.timing.applying) && settled.timing.applying >= 0, `applying ${settled.timing.applying}`);
});
