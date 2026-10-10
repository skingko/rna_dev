import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, put, skip, git as gitAt } from './git-isolation-fixture.mjs';
import { turnFixture, read, put as putIn, git as gitIn, feedbackOf, skip as turnSkip } from './helpers/turn-fixture.mjs';
import { FEEDBACK_SOURCES, MERGE_LABELS, REFS } from '../git-isolation/index.mjs';
import { createApplyRoutes } from '../apply-routes.mjs';
import { TurnCheckpoint } from '../turn-checkpoint.mjs';
import { applyProjectPermissions } from '../project-permissions.mjs';

// A turn's net change in the project folder, computed by the host (GET …/turns/:turnId/changes and …/changes/patches):
// a worktree conversation's turn from its apply records composed path by path, a direct-mode turn from its checkpoint,
// everything else answered `tools` so the web keeps adding up the tool calls. Real temporary repositories only.

const FIVE = 'l1\nl2\nl3\nl4\nl5\n';
/** A finished turn on the project's conversation, as the runtime leaves it (`fields`: apply, checkpoint, mode, status). */
const addTurn = (f, id, fields = {}) => f.store.mutate(state => { state.sessions.find(row => row.id === f.project.primarySessionId).turns.push({ id, status: 'completed', mode: 'build', createdAt: new Date().toISOString(), ...fields }); });
const setTurn = (f, id, fields) => f.store.mutate(state => { Object.assign(state.sessions.find(row => row.id === f.project.primarySessionId).turns.find(row => row.id === id), fields); });
const rows = changes => changes.files.map(file => [file.path, file.status, file.added, file.removed]);

/** A worktree conversation's S handing its work to P as `turn` records of one turn (the forward of session-worktree-service). */
async function worktreeTurn(f, turnId = 'turn-1') {
  const id = f.project.id, sessionId = f.project.primarySessionId;
  const seed = await f.engine.snapshot(id, f.root);
  const s = f.worktree('session', 'sess0001', seed.commit, { owner: { sessionId } });
  const ids = [];
  let base = seed.commit;
  const forward = async change => {
    await change(s.root);
    const tip = await f.engine.snapshot(id, s);
    const outcome = await f.engine.apply(id, { target: f.root, base, incoming: tip.commit, kind: 'turn', source: { sessionId, turnId, worktreeId: 'sess0001' }, mode: 'all', labels: MERGE_LABELS.sessionToProject() });
    assert.equal(outcome.status, 'applied', JSON.stringify(outcome));
    base = tip.commit; ids.push(outcome.applyId);
    return outcome;
  };
  return { s, seed, forward, ids, sessionId };
}

test('a worktree turn\'s records compose path by path: first before → last after, nothing for a file put back, records into S left out', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': FIVE, 'keep.txt': 'k\n' } });
  const { s, seed, forward, ids, sessionId } = await worktreeTurn(f);
  await forward(root => { put(root, 'a.txt', 'L1\nl2\nl3\nl4\nl5\n'); put(root, 'tmp.txt', 'scratch\n'); });
  await forward(root => { put(root, 'a.txt', 'L1\nl2\nL3\nl4\nl5\n'); rmSync(join(root, 'tmp.txt')); put(root, 'b.txt', 'b\n'); });
  // The user's own file in P, merged back into S as a record of the same turn written into the worktree.
  put(f.workspace, 'mine.txt', 'the user\'s\n');
  const now = await f.engine.snapshot(f.project.id, f.root);
  const back = await f.engine.apply(f.project.id, { target: s, base: seed.commit, incoming: now.commit, kind: 'turn', source: { sessionId, turnId: 'turn-1', worktreeId: 'sess0001' }, mode: 'partial', labels: MERGE_LABELS.projectToSession() });
  assert.ok(back.applyId); assert.match(f.applies().find(row => row.id === back.applyId).target, /^session:/);
  addTurn(f, 'turn-1', { apply: { status: 'applied', applyIds: [...ids] } });
  const changes = await f.engine.turnChanges(f.project.id, 'turn-1', { sessionId });
  assert.equal(changes.source, 'records');
  assert.deepEqual(changes.applyIds, ids, 'only the records into the project folder, oldest first');
  assert.deepEqual(rows(changes), [['a.txt', 'M', 2, 2], ['b.txt', 'A', 1, 0]], 'tmp.txt came and went within the turn; mine.txt is the user\'s');
  assert.ok(changes.files.every(file => !file.rolledBack && !file.changedBetween && !file.sections));
  const { patches } = await f.engine.turnPatches(f.project.id, 'turn-1', { sessionId, paths: ['a.txt', 'b.txt', 'keep.txt'] });
  assert.deepEqual(patches.map(row => [row.path, row.diff.kind]), [['a.txt', 'patch'], ['b.txt', 'patch'], ['keep.txt', 'patch']]);
  assert.match(patches[0].diff.patch, /^-l1$/m); assert.match(patches[0].diff.patch, /^\+L3$/m);
  assert.match(patches[1].diff.patch, /^\+b$/m); assert.equal(patches[2].diff.patch, '', 'a file the turn did not change has no patch');
  // The same answer without the sessionId (turn ids are unique), and only from that conversation when it is given.
  assert.deepEqual(rows(await f.engine.turnChanges(f.project.id, 'turn-1')), rows(changes));
  await assert.rejects(f.engine.turnChanges(f.project.id, 'turn-1', { sessionId: 'another' }), error => error.status === 404 && error.code === 'turn_not_found');
});

test('a file someone else changed between the turn\'s records comes as one section per record (changedBetween)', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': FIVE, 'b.txt': 'b\n' } });
  const { forward, ids, sessionId } = await worktreeTurn(f);
  await forward(root => { put(root, 'a.txt', 'L1\nl2\nl3\nl4\nl5\n'); put(root, 'b.txt', 'B\n'); });
  put(f.workspace, 'a.txt', 'L1\nl2\nl3\nl4\nl5 user\n');
  await forward(root => { put(root, 'a.txt', 'L1\nl2\nL3\nl4\nl5\n'); put(root, 'b.txt', 'B2\n'); });
  addTurn(f, 'turn-1', { apply: { status: 'applied', applyIds: [...ids] } });
  const changes = await f.engine.turnChanges(f.project.id, 'turn-1', { sessionId });
  const a = changes.files.find(file => file.path === 'a.txt'), b = changes.files.find(file => file.path === 'b.txt');
  assert.deepEqual([b.status, b.added, b.removed, b.changedBetween], ['M', 1, 1, undefined], 'b.txt chains: b → B → B2 is one change');
  assert.deepEqual([a.status, a.added, a.removed, a.changedBetween], ['M', 2, 2, true]);
  assert.deepEqual(a.sections.map(row => [row.applyId, row.kind, row.status, row.added, row.removed]), [[ids[0], 'turn', 'M', 1, 1], [ids[1], 'turn', 'M', 1, 1]]);
  const { patches } = await f.engine.turnPatches(f.project.id, 'turn-1', { sessionId, paths: ['a.txt', 'b.txt'] });
  assert.equal(patches[0].diff, undefined);
  assert.deepEqual(patches[0].sections.map(row => row.applyId), ids);
  assert.match(patches[0].sections[0].diff.patch, /^\+L1$/m); assert.match(patches[0].sections[1].diff.patch, /^\+L3$/m);
  assert.doesNotMatch(patches[0].sections[1].diff.patch, /^[+-]l5 user$/m, 'the user\'s line is context, not the turn\'s');
  assert.match(patches[1].diff.patch, /^-b$/m); assert.match(patches[1].diff.patch, /^\+B2$/m);
});

test('a rolled-back turn keeps its files, marked rolledBack; undoing the rollback clears the mark', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': FIVE } });
  const { forward, ids, sessionId } = await worktreeTurn(f);
  await forward(root => put(root, 'a.txt', 'L1\nl2\nl3\nl4\nl5\n'));
  await forward(root => put(root, 'new.txt', 'n\n'));
  addTurn(f, 'turn-1', { apply: { status: 'applied', applyIds: [...ids] } });
  const before = await f.engine.turnChanges(f.project.id, 'turn-1', { sessionId });
  assert.deepEqual(rows(before), [['a.txt', 'M', 1, 1], ['new.txt', 'A', 1, 0]]);
  const preview = await f.engine.rollbackTurn(f.project.id, 'turn-1', {});
  const done = await f.engine.rollbackTurn(f.project.id, 'turn-1', { confirm: preview.confirm });
  const after = await f.engine.turnChanges(f.project.id, 'turn-1', { sessionId });
  assert.deepEqual(rows(after), rows(before), 'still listed: what the turn wrote');
  assert.ok(after.files.every(file => file.rolledBack === true));
  assert.deepEqual(after.applyIds, ids);
  const undo = await f.engine.rollback(f.project.id, done.applyId, {});
  await f.engine.rollback(f.project.id, done.applyId, { confirm: undo.confirm });
  const again = await f.engine.turnChanges(f.project.id, 'turn-1', { sessionId });
  assert.ok(again.files.every(file => !file.rolledBack), JSON.stringify(again.files));
  // One record rolled back alone: only the files it wrote.
  const single = await f.engine.rollback(f.project.id, ids[1], {});
  await f.engine.rollback(f.project.id, ids[1], { confirm: single.confirm });
  const partly = await f.engine.turnChanges(f.project.id, 'turn-1', { sessionId });
  assert.deepEqual(partly.files.map(file => [file.path, Boolean(file.rolledBack)]), [['a.txt', false], ['new.txt', true]]);
});

test('a direct-mode turn answers from its checkpoint: its own paths only, worker merges of the turn included, rolled back when the turn was', { skip }, async t => {
  const f = fixture(t, { files: { 'src/calc.js': 'export const add = (a, b) => a + b;\n', 'b.txt': 'b\n' } });
  const id = f.project.id, sessionId = f.project.primarySessionId;
  const start = await f.engine.snapshot(id, f.root);
  // A worker of this turn merges into the folder (no edit tool call of the turn touches it); someone else writes b.txt.
  const seed = await f.engine.snapshot(id, f.root);
  const w = f.worktree('worker', 'agent-00000001', seed.commit);
  put(w.root, 'src/calc.js', 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n');
  const tip = await f.engine.snapshot(id, w);
  const merged = await f.engine.apply(id, { target: f.root, base: seed.commit, incoming: tip.commit, kind: 'worker', source: { sessionId, turnId: 'turn-2', agentId: 'agent-00000001' }, mode: 'all', labels: MERGE_LABELS.worker('agent-00000001'), incomingRoot: w });
  assert.equal(merged.status, 'applied');
  put(f.workspace, 'b.txt', 'someone else\n');
  const end = await f.engine.snapshot(id, f.root);
  f.engine.attributable = async (projectId, turnId) => (turnId === 'turn-2' ? { start: start.commit, end: end.commit, paths: ['src/calc.js'], excluded: [{ path: 'b.txt', applyId: 'aother' }] } : Promise.reject(Object.assign(new Error('none'), { status: 409, code: 'turn_checkpoint_missing' })));
  addTurn(f, 'turn-2', { checkpoint: { ref: REFS.turn('turn-2'), state: 'taken' } });
  const changes = await f.engine.turnChanges(id, 'turn-2', { sessionId });
  assert.equal(changes.source, 'checkpoint');
  assert.deepEqual(rows(changes), [['src/calc.js', 'M', 1, 0]], 'b.txt is not this turn\'s');
  assert.equal(changes.applyIds, undefined); assert.equal(changes.uncovered, undefined);
  const { patches } = await f.engine.turnPatches(id, 'turn-2', { sessionId, paths: ['src/calc.js'] });
  assert.match(patches[0].diff.patch, /^\+export const sub/m);
  const preview = await f.engine.rollbackTurn(id, 'turn-2', {});
  await f.engine.rollbackTurn(id, 'turn-2', { confirm: preview.confirm });
  const undone = await f.engine.turnChanges(id, 'turn-2', { sessionId });
  assert.deepEqual(undone.files.map(file => [file.path, file.rolledBack]), [['src/calc.js', true]]);
  // The checkpoint gone (swept) while the turn still says taken: the tool calls stay.
  f.engine.attributable = async () => Promise.reject(Object.assign(new Error('none'), { status: 409, code: 'turn_checkpoint_missing' }));
  f.engine.turnPlans.clear();
  assert.deepEqual(await f.engine.turnChanges(id, 'turn-2', { sessionId }), { source: 'tools', reason: 'expired' });
});

test('everything the host cannot answer exactly falls back to the tool calls, with why', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': FIVE } });
  const { forward, ids, sessionId } = await worktreeTurn(f);
  await forward(root => put(root, 'a.txt', 'L1\nl2\nl3\nl4\nl5\n'));
  const id = f.project.id;
  const reason = async (turnId, fields) => { setTurn(f, turnId, fields); f.engine.turnPlans.clear(); const answer = await f.engine.turnChanges(id, turnId, { sessionId }); assert.equal(answer.source, 'tools', JSON.stringify(answer)); return answer.reason; };
  addTurn(f, 'turn-1', { apply: { status: 'applied', applyIds: [...ids] } });
  assert.equal(await reason('turn-1', { apply: { status: 'pending', applyIds: [...ids], conflict: { id: 'm', paths: [{ path: 'a.txt', kind: 'content' }], attempts: 0 } } }), 'pending');
  assert.equal(await reason('turn-1', { apply: { status: 'conflicted', applyIds: [] } }), 'conflicted');
  assert.equal(await reason('turn-1', { apply: { status: 'applying', applyIds: [] } }), 'applying');
  assert.equal(await reason('turn-1', { apply: { status: 'applied', applyIds: [...ids] }, status: 'running' }), 'running');
  assert.equal(await reason('turn-1', { status: 'completed', mode: 'plan' }), 'plan');
  setTurn(f, 'turn-1', { mode: 'build' });
  // Its record expired, or still being written.
  f.store.mutate(state => { state.projects.find(row => row.id === id).git.applies.find(row => row.id === ids[0]).state = 'expired'; });
  assert.equal(await reason('turn-1', {}), 'expired');
  f.store.mutate(state => { state.projects.find(row => row.id === id).git.applies.find(row => row.id === ids[0]).state = 'writing'; });
  assert.equal(await reason('turn-1', {}), 'unsettled');
  f.store.mutate(state => { state.projects.find(row => row.id === id).git.applies.find(row => row.id === ids[0]).state = 'verified'; });
  // A turn whose conflict a later turn's apply settled has no record of its own in the project folder.
  addTurn(f, 'turn-0', { apply: { status: 'applied', applyIds: [], settledBy: 'turn-1' } });
  assert.equal(await reason('turn-0', {}), 'no_records');
  // Direct mode: no checkpoint (a non-git project's turn), a skipped one, an expired one.
  f.engine.attributable = async () => Promise.reject(Object.assign(new Error('none'), { status: 409, code: 'turn_checkpoint_missing' }));
  addTurn(f, 'turn-3', {});
  assert.equal(await reason('turn-3', {}), 'no_records');
  assert.equal(await reason('turn-3', { checkpoint: { state: 'skipped', reason: 'timeout' } }), 'no_checkpoint');
  assert.equal(await reason('turn-3', { checkpoint: { state: 'expired', reason: 'expired' } }), 'expired');
  assert.equal(await reason('turn-3', { checkpoint: { ref: REFS.turn('turn-3'), state: 'taken' } }), 'expired', 'no hold ref: the checkpoint is gone');
  await assert.rejects(f.engine.turnPatches(id, 'turn-3', { sessionId, paths: ['a.txt'] }), error => error.status === 409 && error.code === 'turn_changes_unavailable' && error.reason === 'expired');
  await assert.rejects(f.engine.turnPatches(id, 'turn-1', { sessionId, paths: [] }), error => error.status === 400 && error.code === 'git_paths_invalid');
  await assert.rejects(f.engine.turnChanges(id, 'no-such-turn', { sessionId }), error => error.status === 404 && error.code === 'turn_not_found');
  // An archived project refuses git reads.
  f.store.mutate(state => { state.projects.find(row => row.id === id).archivedAt = new Date().toISOString(); });
  assert.equal(await reason('turn-1', {}), 'archived');
  f.store.mutate(state => { state.projects.find(row => row.id === id).archivedAt = null; });
  assert.equal((await f.engine.turnChanges(id, 'turn-1', { sessionId })).source, 'records');
  // The folder is no repository any more.
  rmSync(join(f.repo, '.git'), { recursive: true, force: true });
  f.engine.turnPlans.clear();
  assert.deepEqual(await f.engine.turnChanges(id, 'turn-1', { sessionId }), { source: 'tools', reason: 'git_unavailable' });
});

test('a project in a subfolder of its repository speaks in its own paths, sections and patches included', { skip }, async t => {
  const f = fixture(t, { prefix: 'site', files: { 'page.html': '<p>1</p>\n', 'css/a.css': 'a{}\n' } });
  const { forward, ids, sessionId } = await worktreeTurn(f);
  await forward(root => { put(root, 'page.html', '<p>2</p>\n'); put(root, 'css/a.css', 'a{color:red}\n'); });
  put(f.workspace, 'css/a.css', 'a{color:red}\nb{}\n');
  await forward(root => { put(root, 'page.html', '<p>3</p>\n'); put(root, 'css/a.css', 'x{}\na{color:red}\n'); });
  addTurn(f, 'turn-1', { apply: { status: 'applied', applyIds: [...ids] } });
  const changes = await f.engine.turnChanges(f.project.id, 'turn-1', { sessionId });
  assert.deepEqual(changes.files.map(file => [file.path, file.added, file.removed, Boolean(file.changedBetween)]), [['css/a.css', 2, 1, true], ['page.html', 1, 1, false]]);
  const { patches } = await f.engine.turnPatches(f.project.id, 'turn-1', { sessionId, paths: ['page.html', 'css/a.css'] });
  assert.match(patches[0].diff.patch, /^-<p>1<\/p>$/m); assert.match(patches[0].diff.patch, /^\+<p>3<\/p>$/m);
  assert.match(patches[1].sections[1].diff.patch, /^\+x\{\}$/m);
});

test('routes: GET …/turns/:turnId/changes and …/changes/patches; rollback stays POST only', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'one\n' } });
  const { forward, ids, sessionId } = await worktreeTurn(f);
  await forward(root => { put(root, 'a.txt', 'one\ntwo\n'); put(root, 'b c.txt', 'spaced\n'); });
  addTurn(f, 'turn-1', { apply: { status: 'applied', applyIds: [...ids] } });
  const routes = createApplyRoutes({ store: f.store, body: async req => req.body ?? {}, engine: f.engine });
  const call = async (method, path, body) => {
    let answer = null;
    const url = new URL(`http://localhost${path}`);
    const handled = await routes({ method, body }, { pathname: url.pathname, url, send: (status, payload) => { answer = { status, body: payload }; } });
    return handled ? answer : null;
  };
  const base = `/api/v2/projects/${f.project.id}/turns/turn-1`;
  const changes = await call('GET', `${base}/changes?sessionId=${sessionId}`);
  assert.equal(changes.status, 200);
  assert.deepEqual(rows(changes.body), [['a.txt', 'M', 1, 0], ['b c.txt', 'A', 1, 0]]);
  const patches = await call('GET', `${base}/changes/patches?sessionId=${sessionId}&path=a.txt&path=${encodeURIComponent('b c.txt')}`);
  assert.equal(patches.status, 200); assert.match(patches.body.patches[0].diff.patch, /^\+two$/m); assert.match(patches.body.patches[1].diff.patch, /^\+spaced$/m);
  assert.deepEqual([(await call('GET', `${base}/changes/patches`)).body.code], ['git_paths_invalid']);
  assert.deepEqual([(await call('GET', `${base}/changes?sessionId=${encodeURIComponent('bad id')}`)).status], [400]);
  const missing = await call('GET', `/api/v2/projects/${f.project.id}/turns/no-turn/changes`);
  assert.deepEqual([missing.status, missing.body.code], [404, 'turn_not_found']);
  addTurn(f, 'turn-2', { checkpoint: { state: 'skipped', reason: 'timeout' } });
  assert.deepEqual((await call('GET', `/api/v2/projects/${f.project.id}/turns/turn-2/changes`)).body, { source: 'tools', reason: 'no_checkpoint' });
  const refused = await call('GET', `/api/v2/projects/${f.project.id}/turns/turn-2/changes/patches?path=a.txt`);
  assert.deepEqual([refused.status, refused.body.code, refused.body.reason], [409, 'turn_changes_unavailable', 'no_checkpoint']);
  assert.equal(await call('POST', `${base}/changes`, {}), null, 'reads only');
  assert.equal(await call('GET', `${base}/rollback`), null, 'rollback stays POST');
  assert.equal(await call('GET', `${base}/changes/other`), null);
});

/** The marked block a reverse merge left in a file (from its `<<<<<<<` line through its `>>>>>>>` line). */
const markedBlock = text => { const start = text.indexOf('<<<<<<< '), end = text.indexOf('\n', text.indexOf('>>>>>>> ', start)); return text.slice(start, end + 1); };

test('a worktree turn whose hand-back conflicted and a continuation merged shows the net lines, never the marker lines', { skip: turnSkip }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  const S = (await f.rootOf(s.id)).root;
  let continued = false;
  // The model adds three lines under line 2 while the user changes line 2 in the project folder: the hand-back
  // conflicts, the host merges P into S with markers and continues; the model merges them by hand. Other host
  // continuations (a delivery observation) are answered with text.
  const reply = request => {
    const text = read(S, 'a.txt');
    if (!feedbackOf(request).some(row => row.source === FEEDBACK_SOURCES.worktreeApply) || !text.includes('<<<<<<< ')) return { text: '好了。' };
    continued = true;
    return { edit: ['a.txt', markedBlock(text), 'TWO\nx1\nx2\nx3\n'] };
  };
  f.model.steps.push(async () => { await f.runtime.running.get(s.id)?.startSync; putIn(f.P, 'a.txt', 'one\nTWO\nthree\n'); return { edit: ['a.txt', 'two\n', 'two\nx1\nx2\nx3\n'] }; }, ...Array(8).fill(reply));
  const turn = await f.send(s.id, '在第二行后加三行');
  assert.equal(turn.apply.status, 'applied', JSON.stringify([turn.status, turn.apply]));
  assert.ok(continued, 'the continuation carried the merge feedback');
  assert.equal(read(f.P, 'a.txt'), 'one\nTWO\nx1\nx2\nx3\nthree\n');
  // Two records of this turn: the markers into S (crash recovery only), the merged file into P.
  const records = f.applies().filter(row => row.source?.turnId === turn.id);
  assert.ok(records.some(row => row.target.startsWith('session:')), JSON.stringify(records));
  const changes = await f.engine.turnChanges(f.project.id, turn.id, { sessionId: s.id });
  assert.equal(changes.source, 'records');
  assert.deepEqual(changes.applyIds, turn.apply.applyIds);
  assert.deepEqual(rows(changes), [['a.txt', 'M', 3, 0]], 'what reached the project folder: three lines, no markers');
  const { patches } = await f.engine.turnPatches(f.project.id, turn.id, { sessionId: s.id, paths: ['a.txt'] });
  assert.match(patches[0].diff.patch, /^\+x3$/m); assert.doesNotMatch(patches[0].diff.patch, /<<<<<<<|>>>>>>>|=======/);
});

test('a direct-mode turn whose only write was a worker merge shows it; tool writes no snapshot holds are uncovered', { skip: turnSkip }, async t => {
  const f = turnFixture(t);
  const sessionId = f.session.id, hashed = join(f.dir, 'blob.txt');
  // Inside the turn, after its start snapshot: a worker of this turn merges into the project folder. The turn itself
  // calls no edit or write tool (as agent_merge show / take did in the live turn this reproduces).
  f.model.steps.push(async () => {
    const turnId = f.sessionOf(sessionId).activeTurnId;
    await f.checkpoints.handles.get(turnId)?.ready;
    const P = await f.roots.rootOf({ projectId: f.project.id }), seed = await f.engine.snapshot(f.project.id, P);
    writeFileSync(hashed, 'export const a = 1;\nexport const b = 2;\n');
    const oid = gitIn(f.repo, 'hash-object', '-w', hashed).trim();
    const incoming = await f.engine.compose(f.project.id, seed.commit, [{ path: 'src/app.js', mode: '100644', oid }]);
    const merged = await f.engine.apply(f.project.id, { target: P, base: seed.commit, incoming, kind: 'worker', source: { sessionId, turnId, agentId: 'agent-00000001' }, mode: 'all', labels: MERGE_LABELS.worker('agent-00000001') });
    assert.equal(merged.status, 'applied', JSON.stringify(merged));
    return { text: '子代理的改动合并好了。' };
  });
  const turn = await f.send(sessionId, '合并子代理');
  assert.equal(turn.checkpoint.state, 'taken');
  assert.equal(f.sessionOf(sessionId).items.filter(item => item.turnId === turn.id && item.tool).length, 0, 'no tool call: the tool-derived view has nothing');
  const changes = await f.engine.turnChanges(f.project.id, turn.id, { sessionId });
  assert.equal(changes.source, 'checkpoint');
  assert.deepEqual(rows(changes), [['src/app.js', 'M', 1, 0]]);
  // A turn that writes an ignored file (dist/ is ignored) and a tracked one.
  f.model.steps.push({ writes: [['dist/bundle.js', 'bundled\n'], ['a.txt', 'one\ntwo\nthree\nfour\n']] }, { text: '好了。' });
  const second = await f.send(sessionId, '构建');
  const written = await f.engine.turnChanges(f.project.id, second.id, { sessionId });
  assert.deepEqual(rows(written), [['a.txt', 'M', 1, 0]]);
  assert.deepEqual(written.uncovered, ['dist/bundle.js'], 'written by a tool, in no snapshot');
  assert.equal(read(f.P, 'dist/bundle.js'), 'bundled\n');
});

/**
 * A direct-mode turn on the engine fixture with a real TurnCheckpoint (its start, end and attributable()), wired into
 * the engine as the runtime wires it. `attempt(change)` runs one attempt: start, `change()` (it writes files and adds
 * the turn's tool calls), the status the attempt ends with, end. A clock that always moves keeps attempts apart.
 */
function directTurn(f, turnId = 'turn-d') {
  const id = f.project.id, sessionId = f.project.primarySessionId;
  f.store.mutate(state => applyProjectPermissions(state, id, { workspace: 'execute', background: 'read' }));
  let tick = Date.now();
  const checkpoints = new TurnCheckpoint(f.store, { engine: f.engine, git: f.service, now: () => (tick = Math.max(Date.now(), tick + 1)) });
  f.engine.attributable = (projectId, turn) => checkpoints.attributable(projectId, turn);
  addTurn(f, turnId, { status: 'running', attemptStartedAt: new Date().toISOString() });
  let calls = 0;
  /** One tool call of the turn, as the runtime records it. */
  const call = (name, args, status = 'succeeded') => f.store.mutate(state => { state.sessions.find(row => row.id === sessionId).items.push({ id: `item-${turnId}-${++calls}`, kind: 'tool', turnId, createdAt: new Date().toISOString(), tool: { id: `call-${calls}`, name, args, status } }); });
  const attempt = async (change, { status = 'completed', beforeEnd = null } = {}) => {
    setTurn(f, turnId, { status: 'running', attemptStartedAt: new Date(checkpoints.now()).toISOString(), completedAt: undefined });
    const handle = checkpoints.start({ projectId: id, sessionId, turnId });
    assert.equal((await handle.ready).state, 'taken');
    await change();
    setTurn(f, turnId, { status, completedAt: new Date(checkpoints.now()).toISOString() });
    await beforeEnd?.();
    return checkpoints.end({ projectId: id, sessionId, turnId });
  };
  return { id, sessionId, turnId, checkpoints, call, attempt, changes: () => f.engine.turnChanges(id, turnId, { sessionId }) };
}

test('a retried direct-mode turn answers for its latest attempt, also when it was read between the attempts and before the end was recorded', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': FIVE, 'b.txt': 'b\n' } });
  const d = directTurn(f);
  // Attempt 1 writes a.txt and fails; its changes are read (and kept).
  const first = await d.attempt(async () => { put(f.workspace, 'a.txt', 'L1\nl2\nl3\nl4\nl5\n'); d.call('project_write', { path: 'a.txt' }); }, { status: 'failed' });
  assert.equal(first.state, 'taken'); assert.match(first.endedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(rows(await d.changes()), [['a.txt', 'M', 1, 1]]);
  // Attempt 2 (an auto-retry within the minute the answer is kept) writes b.txt; it is read once its status says
  // completed, before its end went into the hold, and again after.
  let early = null;
  const second = await d.attempt(async () => { put(f.workspace, 'b.txt', 'B\n'); d.call('project_edit', { path: 'b.txt', oldText: 'b', newText: 'B' }); }, { beforeEnd: async () => { early = await d.changes(); } });
  assert.notEqual(second.endedAt, first.endedAt, 'each attempt records its own end');
  assert.notDeepEqual(early.files?.map(file => file.path), ['a.txt'], 'not attempt 1\'s answer for attempt 2');
  const latest = await d.changes();
  assert.deepEqual(rows(latest), [['a.txt', 'M', 1, 1], ['b.txt', 'M', 1, 1]]);
  const { patches } = await f.engine.turnPatches(d.id, d.turnId, { sessionId: d.sessionId, paths: ['b.txt'] });
  assert.match(patches[0].diff.patch, /^\+B$/m, 'the new attempt\'s file has its patch');
});

test('a direct-mode turn is credited only with what its calls and records wrote: a file the user changed meanwhile is left out, or marked when a command ran', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': FIVE, 'README.md': 'readme\n' } });
  const d = directTurn(f);
  await d.attempt(async () => {
    put(f.workspace, 'a.txt', 'L1\nl2\nl3\nl4\nl5\n'); d.call('project_edit', { path: 'a.txt', oldText: 'l1', newText: 'L1' });
    // The user's editor, while the turn runs: no call and no record of the turn.
    put(f.workspace, 'README.md', 'readme, edited by the user\n');
    // A write that failed names a path but wrote nothing: it credits nothing.
    put(f.workspace, 'notes.md', 'the user\'s new note\n'); d.call('project_write', { path: 'notes.md' }, 'failed');
  });
  const answer = await d.changes();
  assert.deepEqual(rows(answer), [['a.txt', 'M', 1, 1]], 'README.md and notes.md are not the turn\'s');
  assert.ok(answer.files.every(file => !file.unattributed));
  // The same turn had also run a command: it may have changed files it never named, so they are listed, marked.
  d.call('project_exec', { command: 'npm run format' });
  f.engine.turnPlans.clear();
  const marked = await d.changes();
  assert.deepEqual(marked.files.map(file => [file.path, Boolean(file.unattributed)]), [['README.md', true], ['a.txt', false], ['notes.md', true]]);
  // A rollback of the whole turn still covers every path of its checkpoint (as its preview says).
  const preview = await f.engine.rollbackTurn(d.id, d.turnId, {});
  assert.deepEqual(preview.files.map(row => row.path).sort(), ['README.md', 'a.txt', 'notes.md']);
});

test('a file the turn wrote that another owner also wrote while it ran stays in view as shared, never silently dropped', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': FIVE, 'b.txt': 'b\n' } });
  const d = directTurn(f);
  let other = null;
  await d.attempt(async () => {
    put(f.workspace, 'a.txt', 'L1\nl2\nl3\nl4\nl5\n'); d.call('project_edit', { path: 'a.txt', oldText: 'l1', newText: 'L1' });
    put(f.workspace, 'b.txt', 'B\n'); d.call('project_write', { path: 'b.txt' });
    // Another conversation's change lands in the folder during the turn, on another line of a.txt.
    const seed = await f.engine.snapshot(d.id, f.root);
    const oid = gitAt(f.repo, 'hash-object', '-w', '--stdin', { input: 'L1\nl2\nl3\nl4\nL5 elsewhere\n' }).trim();
    const incoming = await f.engine.compose(d.id, seed.commit, [{ path: 'a.txt', mode: '100644', oid }]);
    const outcome = await f.engine.apply(d.id, { target: f.root, base: seed.commit, incoming, kind: 'turn', source: { sessionId: 'another', turnId: 'turn-other' }, mode: 'all', labels: MERGE_LABELS.sessionToProject() });
    assert.equal(outcome.status, 'applied', JSON.stringify(outcome));
    other = outcome.applyId;
  });
  const answer = await d.changes();
  assert.deepEqual(rows(answer), [['b.txt', 'M', 1, 1]], 'a.txt can\'t be told apart in the diff');
  assert.deepEqual(answer.shared, [{ path: 'a.txt', applyId: other }]);
  assert.equal(answer.uncovered, undefined, 'a shared file is in the snapshots: not uncovered');
});

test('a composed file is rolled back only once every record of its chain was; a renamed file\'s patch is the rename', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': FIVE, 'old.js': Array.from({ length: 20 }, (_, i) => `line ${i + 1}\n`).join('') } });
  const { forward, ids, sessionId } = await worktreeTurn(f);
  await forward(root => put(root, 'a.txt', 'L1\nl2\nl3\nl4\nl5\n'));
  await forward(root => {
    put(root, 'a.txt', 'L1\nl2\nL3\nl4\nl5\n');
    rmSync(join(root, 'old.js'));
    put(root, 'new.js', Array.from({ length: 20 }, (_, i) => (i === 9 ? 'line ten, changed\n' : `line ${i + 1}\n`)).join(''));
  });
  addTurn(f, 'turn-1', { apply: { status: 'applied', applyIds: [...ids] } });
  const changes = await f.engine.turnChanges(f.project.id, 'turn-1', { sessionId });
  assert.deepEqual(changes.files.map(file => [file.path, file.oldPath ?? null, file.status, file.added, file.removed]), [['a.txt', null, 'M', 2, 2], ['new.js', 'old.js', 'R', 1, 1]]);
  // The rename's patch: the one changed line under a rename header, not twenty lines added.
  const { patches } = await f.engine.turnPatches(f.project.id, 'turn-1', { sessionId, paths: ['new.js'] });
  assert.match(patches[0].diff.patch, /^rename from old\.js$/m); assert.match(patches[0].diff.patch, /^rename to new\.js$/m);
  assert.deepEqual(patches[0].diff.patch.split('\n').filter(line => /^[+-](?![+-])/.test(line)), ['-line 10', '+line ten, changed']);
  // The record's own patches (应用记录) read the rename the same way.
  const record = await f.engine.applyPatches(f.project.id, ids[1], { paths: ['new.js'] });
  assert.match(record.patches[0].diff.patch, /^rename from old\.js$/m);
  // Record 2 rolled back alone: a.txt is back at record 1's after (L1 still stands), so it is not rolled back.
  const single = await f.engine.rollback(f.project.id, ids[1], {});
  await f.engine.rollback(f.project.id, ids[1], { confirm: single.confirm });
  assert.equal(read(f.workspace, 'a.txt'), 'L1\nl2\nl3\nl4\nl5\n');
  const partly = await f.engine.turnChanges(f.project.id, 'turn-1', { sessionId });
  assert.deepEqual(partly.files.map(file => [file.path, Boolean(file.rolledBack)]), [['a.txt', false], ['new.js', true]]);
  // Record 1 rolled back too: now every record of a.txt's chain is undone.
  const rest = await f.engine.rollback(f.project.id, ids[0], {});
  await f.engine.rollback(f.project.id, ids[0], { confirm: rest.confirm });
  const all = await f.engine.turnChanges(f.project.id, 'turn-1', { sessionId });
  assert.deepEqual(all.files.map(file => [file.path, Boolean(file.rolledBack)]), [['a.txt', true], ['new.js', true]]);
});

test('a direct-mode turn whose checkpoint shows no change reads no other owner\'s records', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': FIVE } });
  const d = directTurn(f);
  // A hold whose start and end are two commits of the same tree (an attempt that wrote and put back, say), with
  // another owner's record inside its window.
  const at = Date.now(), tree = gitAt(f.repo, 'rev-parse', 'HEAD^{tree}').trim();
  const [start, end] = ['start', 'end'].map(message => gitAt(f.repo, 'commit-tree', tree, '-m', message).trim());
  const hold = gitAt(f.repo, 'commit-tree', tree, '-p', start, '-p', end, '-m', JSON.stringify({ kind: 'rna-turn-checkpoint', turnId: d.turnId, windows: [[at - 60000, at]] })).trim();
  gitAt(f.repo, 'update-ref', REFS.turn(d.turnId), hold);
  setTurn(f, d.turnId, { status: 'completed', completedAt: new Date(at).toISOString(), checkpoint: { ref: REFS.turn(d.turnId), state: 'taken', endedAt: new Date(at).toISOString() } });
  f.store.mutate(state => { const project = state.projects.find(row => row.id === d.id); project.git ??= { sessionWorktreeDefault: false, worktrees: [], applies: [] }; project.git.applies ??= []; project.git.applies.unshift({ id: 'aother0000000001', kind: 'background', target: 'project', source: { actionId: 'act-1' }, state: 'verified', files: 1, added: 0, removed: 0, bothChanged: 0, sample: ['a.txt'], at: new Date(at - 1000).toISOString() }); });
  const detail = f.engine.applyDetail.bind(f.engine);
  let read = 0;
  f.engine.applyDetail = (...args) => { read++; return detail(...args); };
  const own = await d.checkpoints.attributable(d.id, d.turnId);
  assert.deepEqual([own.start, own.end, own.paths, own.excluded], [start, end, [], []]);
  assert.deepEqual(await d.changes(), { source: 'checkpoint', files: [] });
  assert.equal(read, 0);
});

test('turn plans: one computation for two asks at once; git away is never kept', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': FIVE } });
  const { forward, ids, sessionId } = await worktreeTurn(f);
  await forward(root => put(root, 'a.txt', 'L1\nl2\nl3\nl4\nl5\n'));
  addTurn(f, 'turn-1', { apply: { status: 'applied', applyIds: [...ids] } });
  const compute = f.engine.computeTurnPlan.bind(f.engine);
  let computed = 0;
  f.engine.computeTurnPlan = (...args) => { computed++; return compute(...args); };
  const [one, two] = await Promise.all([f.engine.turnChanges(f.project.id, 'turn-1', { sessionId }), f.engine.turnPatches(f.project.id, 'turn-1', { sessionId, paths: ['a.txt'] })]);
  assert.equal(computed, 1);
  assert.deepEqual(rows(one), [['a.txt', 'M', 1, 1]]); assert.match(two.patches[0].diff.patch, /^\+L1$/m);
  rmSync(join(f.repo, '.git'), { recursive: true, force: true });
  f.engine.turnPlans.clear();
  assert.deepEqual(await f.engine.turnChanges(f.project.id, 'turn-1', { sessionId }), { source: 'tools', reason: 'git_unavailable' });
  assert.equal(f.engine.turnPlans.size, 0, 'asked again next time');
  assert.equal(f.engine.turnPlanRuns.size, 0);
});
