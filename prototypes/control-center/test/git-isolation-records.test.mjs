import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git, put, read, skip } from './git-isolation-fixture.mjs';
import { HOST_CARDS, IsolationEngine, LIMITS, MERGE_LABELS, REFS } from '../git-isolation/index.mjs';
import { applyRows, applyView, beginApply, retention } from '../git-isolation/records.mjs';
import { UserInteractionService } from '../user-interaction-service.mjs';

// Apply records and crash recovery (worktree design 0.63 §3.6, §5.3, §13 "记录"): a `writing` row and its pinned
// before exist before the first byte; startup recovery settles every row it finds still writing.

const labels = MERGE_LABELS.worker('agent-0011223344');
const crash = () => Object.assign(new Error('the process went away'), { code: 'test_crash' });
async function worker(f, change) {
  const seed = await f.engine.snapshot(f.project.id, f.root);
  const w = f.worktree('worker', 'agent-0011223344', seed.commit);
  await change(w.root);
  const final = await f.engine.snapshot(f.project.id, w);
  return { target: f.root, base: seed.commit, incoming: final.commit, kind: 'worker', source: { sessionId: f.project.primarySessionId, turnId: 't1', agentId: 'agent-0011223344' }, mode: 'all', labels, incomingRoot: w };
}
const FILES = { 'f1.txt': '1\n', 'f2.txt': '2\n', 'f3.txt': '3\n', 'f4.txt': '4\n' };
const change = root => { for (const name of Object.keys(FILES)) put(root, name, `${name} by the worker\n`); };
/** An apply that "dies" after `k` files: the row stays `writing`, as after a crash. */
async function crashAfter(f, k) {
  let written = 0;
  f.engine.settings.hooks = { beforeWrite: () => { if (written++ >= k) throw crash(); } };
  await assert.rejects(f.engine.apply(f.project.id, await worker(f, change)), error => error.code === 'test_crash');
  f.engine.settings.hooks = null;
  const [row] = f.applies();
  assert.equal(row.state, 'writing', 'the checkpoint row was on disk before the first byte');
  return row;
}
const restart = (f, options = {}) => new IsolationEngine(f.store, { git: f.service, ready: true, sandbox: () => true, pollMs: 20, ...options });

test('recovery: every planned file already written → verified', { skip }, async t => {
  const f = fixture(t, { files: FILES });
  f.engine.settings.hooks = { beforeVerify: () => { throw crash(); } };
  await assert.rejects(f.engine.apply(f.project.id, await worker(f, change)), error => error.code === 'test_crash');
  f.engine.settings.hooks = null;
  const outcome = await restart(f).recover();
  assert.deepEqual(outcome, { verified: [f.applies()[0].id], completed: [], interrupted: [] });
  assert.equal(f.applies()[0].state, 'verified'); assert.equal(f.applies()[0].recovered, 'verified');
});

test('recovery: some written, the rest still as before → the rest is written', { skip }, async t => {
  const f = fixture(t, { files: FILES });
  const row = await crashAfter(f, 2);
  assert.equal(read(f.workspace, 'f1.txt'), 'f1.txt by the worker\n'); assert.equal(read(f.workspace, 'f3.txt'), '3\n');
  const outcome = await restart(f).recover();
  assert.deepEqual(outcome.completed, [row.id]);
  for (const name of Object.keys(FILES)) assert.equal(read(f.workspace, name), `${name} by the worker\n`);
  assert.equal(f.applies()[0].state, 'verified'); assert.equal(f.applies()[0].recovered, 'completed');
});

test('recovery: a third content → interrupted with a card; complete writes only files still at before', { skip }, async t => {
  const f = fixture(t, { files: FILES });
  const row = await crashAfter(f, 2);
  put(f.workspace, 'f4.txt', 'the user got here first\n');
  const interactions = new UserInteractionService(f.store), engine = restart(f, { interactions });
  t.after(() => { engine.close(); interactions.close(); });
  const outcome = await engine.recover();
  assert.deepEqual(outcome.interrupted, [row.id]);
  const settled = f.applies()[0];
  assert.equal(settled.state, 'interrupted'); assert.ok(settled.card);
  const session = f.store.state.sessions.find(item => item.id === settled.card.sessionId);
  const card = session.items.find(item => item.interaction?.id === settled.card.interactionId).interaction;
  assert.equal(card.source, HOST_CARDS.interrupted.source); assert.equal(card.actionId, HOST_CARDS.interrupted.actionId(row.id));
  assert.deepEqual(card.questions[0].options.map(option => option.id), [...HOST_CARDS.interrupted.options]);
  assert.equal(applyView(settled).rollback.available, false);
  interactions.answer(session.id, card.id, { requestId: 'answer-1', answers: [{ id: 'decision', selected: ['complete'] }] });
  for (let tries = 0; tries < 200 && f.applies()[0].state === 'interrupted'; tries++) await new Promise(done => setTimeout(done, 25));
  assert.equal(f.applies()[0].state, 'verified');
  assert.equal(read(f.workspace, 'f3.txt'), 'f3.txt by the worker\n', 'a file still as before is completed');
  assert.equal(read(f.workspace, 'f4.txt'), 'the user got here first\n', 'a file changed since is left alone');
  const resolve = f.applies().find(item => item.kind === 'resolve');
  assert.ok(resolve, 'the answer wrote through a checkpoint of its own'); assert.equal(resolve.state, 'verified');
});

test('restore puts back only files still as the interrupted apply left them', { skip }, async t => {
  const f = fixture(t, { files: FILES });
  const row = await crashAfter(f, 2);
  put(f.workspace, 'f1.txt', 'edited after the crash\n'); put(f.workspace, 'f4.txt', 'and another\n');
  const engine = restart(f);
  await engine.recover();
  assert.equal(f.applies().find(item => item.id === row.id).state, 'interrupted');
  // The card's answer (settleCards) passes initiator 'user': the "go back to before" is the user's undo.
  const outcome = await engine.resolveInterrupted(f.project.id, row.id, 'restore', { initiator: 'user' });
  assert.equal(outcome.status, 'applied'); assert.deepEqual(outcome.written, ['f2.txt']);
  const resolve = f.applies().find(item => item.id === outcome.applyId);
  assert.deepEqual([resolve.kind, resolve.undoes, resolve.initiator], ['resolve', row.id, 'user']);
  assert.equal(read(f.workspace, 'f2.txt'), '2\n'); assert.equal(read(f.workspace, 'f1.txt'), 'edited after the crash\n');
  assert.equal(read(f.workspace, 'f3.txt'), '3\n'); assert.equal(read(f.workspace, 'f4.txt'), 'and another\n');
  const original = f.applies().find(item => item.id === row.id);
  assert.equal(original.state, 'rolled_back'); assert.equal(original.rolledBackBy, outcome.applyId);
  await assert.rejects(engine.resolveInterrupted(f.project.id, row.id, 'restore'), error => error.code === 'rollback_nothing');
});

test('after holds exactly what was written: a partial write that lost a race records the rest only', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
  const request = await worker(f, root => { put(root, 'a.txt', 'A\n'); put(root, 'b.txt', 'B\n'); });
  f.engine.settings.hooks = { beforeRename: path => { if (path === 'b.txt') writeFileSync(join(f.workspace, 'b.txt'), 'typing\n'); } };
  const outcome = await f.engine.apply(f.project.id, { ...request, mode: 'partial' });
  const [before, after] = git(f.repo, 'rev-list', '--parents', '-n', '1', REFS.apply(outcome.applyId)).trim().split(' ').slice(1);
  assert.equal(git(f.repo, 'diff-tree', '-r', '--name-only', before, after), 'a.txt\n');
  assert.deepEqual({ files: f.applies()[0].files, sample: f.applies()[0].sample }, { files: 1, sample: ['a.txt'] });
});

test('rows: newest first, filtered by session and turn, capped, and the view says whether a rollback is offered', () => {
  const rows = [{ id: 'a1', at: '2026-10-01T00:00:00Z', source: { sessionId: 's1', turnId: 't1' }, state: 'verified', target: 'project' }, { id: 'a2', at: '2026-10-02T00:00:00Z', source: { sessionId: 's2', turnId: 't2' }, state: 'expired', target: 'project' }, { id: 'a3', at: '2026-10-03T00:00:00Z', source: { sessionId: 's1', turnId: 't3' }, state: 'verified', target: 'session:s1', targetWorktreeId: 'w', pending: ['x'] }];
  const project = { git: { applies: rows } };
  assert.deepEqual(applyRows(project).map(row => row.id), ['a3', 'a2', 'a1']);
  assert.deepEqual(applyRows(project, { sessionId: 's1' }).map(row => row.id), ['a3', 'a1']);
  assert.deepEqual(applyRows(project, { turnId: 't2' }).map(row => row.id), ['a2']);
  assert.deepEqual(applyRows(project, { limit: 1 }).map(row => row.id), ['a3']);
  assert.deepEqual(applyView(rows[0]).rollback, { available: true });
  assert.deepEqual(applyView(rows[1]).rollback, { available: false, reason: 'expired' });
  assert.deepEqual(applyView(rows[2]).rollback, { available: false, reason: 'target' });
  assert.equal('pending' in applyView(rows[2]), false); assert.equal('targetWorktreeId' in applyView(rows[2]), false);
});

test('retention keeps 30 days, then the newest 50; the store keeps at most 500 rows', { skip }, async t => {
  const now = Date.parse('2026-10-04T00:00:00Z'), day = 86400000;
  const rows = Array.from({ length: 60 }, (_, index) => ({ id: `r${index}`, at: new Date(now - (index < 5 ? index : 31 + index) * day).toISOString(), state: index === 59 ? 'writing' : 'verified' }));
  const { expire } = retention(rows, { now });
  assert.equal(expire.length, 9, 'the 10 oldest are past 50; the one still writing is never expired');
  assert.ok(!expire.includes('r59')); assert.ok(!expire.includes('r0'));
  assert.deepEqual(retention(rows.slice(0, 50), { now }).expire, [], 'within the newest 50 nothing expires');

  const f = fixture(t);
  f.store.mutate(state => { const project = state.projects.find(item => item.id === f.project.id); project.git = { sessionWorktreeDefault: false, worktrees: [], applies: Array.from({ length: LIMITS.appliesPerProject }, (_, index) => ({ id: `b${index}`, kind: 'worker', target: 'project', source: {}, state: index === 0 ? 'interrupted' : 'verified', at: new Date(now - index * 1000).toISOString() })) }; });
  for (const id of ['n1', 'n2']) beginApply(f.store, f.project.id, { id, kind: 'worker', target: 'project', source: {} });
  const ids = f.applies().map(row => row.id);
  assert.equal(ids.length, LIMITS.appliesPerProject, 'past the cap the oldest settled rows go');
  assert.ok(ids.includes('b0'), 'an interrupted row is never dropped'); assert.ok(!ids.includes('b1') && !ids.includes('b2')); assert.ok(ids.includes('n1') && ids.includes('n2'));
});

test('sweep expires old records with their refs and drops stale turn, orphan and merge refs', { skip }, async t => {
  const f = fixture(t);
  const day = 86400000, now = Date.now();
  const commitAt = (date, message) => { process.env.GIT_COMMITTER_DATE = date; try { return git(f.repo, 'commit-tree', 'HEAD^{tree}', '-m', message).trim(); } finally { delete process.env.GIT_COMMITTER_DATE; } };
  const old = commitAt(new Date(now - 40 * day).toISOString(), 'old'), fresh = commitAt(new Date(now - 2 * day).toISOString(), 'fresh');
  for (let index = 0; index < 52; index++) beginApply(f.store, f.project.id, { id: `x${index}`, kind: 'worker', target: 'project', source: {} });
  f.store.mutate(state => { for (const [index, row] of state.projects.find(item => item.id === f.project.id).git.applies.entries()) Object.assign(row, { state: 'verified', at: new Date(now - (index + 31) * day).toISOString() }); });
  for (const [ref, commit] of [[REFS.apply('x0'), fresh], [REFS.apply('x51'), fresh], [REFS.apply('orphan-old'), old], [REFS.apply('orphan-new'), fresh], [REFS.turn('t-old'), old], [REFS.turn('t-new'), fresh], [REFS.merge('abcdef01', 'current'), old]]) git(f.repo, 'update-ref', ref, commit);
  const result = await f.engine.sweep({ now });
  assert.equal(result.expired, 2, 'the two oldest of 52 rows past 30 days');
  const states = Object.fromEntries(f.applies().map(row => [row.id, row.state]));
  assert.equal(states.x51, 'expired'); assert.equal(states.x50, 'expired'); assert.equal(states.x0, 'verified');
  const refs = f.refs();
  assert.ok(!refs.includes(REFS.apply('x51')), 'an expired record loses its ref'); assert.ok(refs.includes(REFS.apply('x0')));
  assert.ok(!refs.includes(REFS.apply('orphan-old'))); assert.ok(refs.includes(REFS.apply('orphan-new')), 'an orphan ref younger than 30 days stays');
  assert.ok(!refs.includes(REFS.turn('t-old'))); assert.ok(refs.includes(REFS.turn('t-new')));
  assert.ok(!refs.some(ref => ref.startsWith('refs/rna/m/')), 'merge labels left by a crash go');
  assert.ok(existsSync(f.workspace));
});

test('a write the file system refuses part way is settled at once, not left writing', { skip }, async t => {
  const f = fixture(t, { files: FILES });
  let calls = 0;
  f.engine.settings.hooks = { beforeWrite: path => { if (path === 'f3.txt' && calls++ === 0) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES', syscall: 'open' }); } };
  await assert.rejects(f.engine.apply(f.project.id, await worker(f, change)), error => error.code === 'EACCES');
  f.engine.settings.hooks = null;
  const [row] = f.applies();
  assert.equal(row.state, 'verified', 'the rest was finished right away'); assert.equal(row.recovered, 'completed');
  for (const name of Object.keys(FILES)) assert.equal(read(f.workspace, name), `${name} by the worker\n`);
});
