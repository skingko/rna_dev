import test from 'node:test';
import assert from 'node:assert/strict';
import { renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { turnFixture, read, put, there, skip, git, until, feedbackOf, cardOf, treeOf, carries } from './helpers/turn-fixture.mjs';
import { FEEDBACK_SOURCES, HOST_CARDS, REFS, hasMergeMarkers } from '../git-isolation/index.mjs';
import { SessionDeletionService } from '../session-deletion.mjs';

// Session worktrees and their turns (worktree design 0.63 §4.2, §7; §13 "会话与轮次"). Real temporary repositories,
// the real merge engine, a scripted model: no network, no paid model, never the user's projects.

const answer = (f, sessionId, interactionId, choice) => f.interactions.answer(sessionId, interactionId, { requestId: `answer-${randomUUID().slice(0, 8)}`, answers: [{ id: 'decision', selected: [choice] }] });
const status = root => git(root, 'status', '--porcelain', '--untracked-files=all').trim();
const sRoot = async (f, id) => (await f.rootOf(id)).root;
const markersIn = text => /^(<<<<<<<|>>>>>>>) refs\/rna\/m\//m.test(text);
/** Unapplied work lands in S the way a worker merge would put it there, while the conversation is idle. */
const intoS = async (f, id, path, content) => put(await sRoot(f, id), path, content);
/** Inside a scripted step: wait until this turn's start sync is done, so an edit of P lands after it. */
const afterSync = async (f, id) => { await f.runtime.running.get(id)?.startSync; };

test('the first turn creates the worktree, works in it and applies to the project folder; S == P afterwards and S\'s HEAD is the base', { skip }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  assert.deepEqual(Object.keys(f.sessionOf(s.id).worktree).sort(), ['id', 'state']);
  assert.equal(f.sessionOf(s.id).worktree.state, 'pending', 'nothing is created with the conversation');
  assert.equal(f.projectRow().git.worktrees.length, 0);
  await assert.rejects(f.rootOf(s.id), { code: 'worktree_pending' });
  put(f.P, 'src/app.js', 'export const a = 2;\n'); git(f.repo, 'add', 'src/app.js'); const index = git(f.repo, 'ls-files', '-s');
  f.model.steps.push({ write: ['a.txt', 'one\nTWO\nthree\n'] }, request => ({ text: `在 ${request.messages.length} 条消息后改好了。` }));
  const turn = await f.send(s.id, '改第二行');
  assert.equal(turn.status, 'completed');
  const session = f.sessionOf(s.id), record = f.recordOf(s.id), S = await f.rootOf(s.id);
  assert.equal(session.worktree.state, 'active'); assert.equal(session.workspace, f.store.state.projects[0].workspace, 'session.workspace stays the project folder');
  assert.equal(S.kind, 'session'); assert.ok(S.root.startsWith(join(f.P, '.rna', 'worktrees.nosync', 's-')));
  assert.equal(read(f.P, 'a.txt'), 'one\nTWO\nthree\n'); assert.equal(read(S.root, 'a.txt'), 'one\nTWO\nthree\n');
  assert.equal(turn.apply.status, 'applied'); assert.equal(turn.apply.applyIds.length, 1);
  const row = f.applies().find(item => item.id === turn.apply.applyIds[0]);
  assert.deepEqual([row.kind, row.target, row.state, row.source.sessionId, row.source.turnId, row.source.worktreeId], ['turn', 'project', 'verified', s.id, turn.id, record.id]);
  assert.equal(status(S.root), '', 'S\'s HEAD and index sit at the base: nothing reads as unapplied');
  assert.equal(treeOf(f.repo, record.base), treeOf(f.repo, REFS.worktree(record.id, 'base')));
  assert.equal(git(f.repo, 'ls-files', '-s'), index, 'the user\'s index is untouched');
  assert.equal(git(f.repo, 'diff', '--cached', '--name-only').trim(), 'src/app.js', 'what the user staged stays staged as it was');
  assert.equal(read(S.root, 'src/app.js'), 'export const a = 2;\n', 'the seed held the user\'s uncommitted work');
  assert.equal(turn.checkpoint, undefined, 'a worktree turn has no direct-mode checkpoint');
});

test('the first turn\'s worktree creation can fail; each failure gets a card offering the project folder or a retry', { skip }, async t => {
  const f = turnFixture(t);
  const create = f.worktrees.create.bind(f.worktrees);
  let failures = 2;
  f.worktrees.create = async (...args) => { if (failures-- > 0) throw Object.assign(new Error('disk said no'), { code: 'worktree_create_failed', status: 500 }); return create(...args); };
  const s = f.worktreeSession();
  f.model.steps.push({ write: ['a.txt', 'retried\n'] }, { text: '好了。' });
  const failed = await f.send(s.id, '改一下');
  assert.equal(failed.status, 'failed'); assert.equal(failed.errorCode, 'worktree_create_failed'); assert.equal(failed.autoRetry, undefined, 'no automatic retry: it is not a provider failure');
  assert.match(f.sessionOf(s.id).items.findLast(item => item.source === 'runtime-error').text, /工作树/);
  assert.equal(read(f.P, 'a.txt'), 'one\ntwo\nthree\n', 'nothing ran in the project folder instead');
  const card = cardOf(f.store, s.id, HOST_CARDS.sessionCreate.actionId(failed.id));
  assert.equal(card.source, 'worktree'); assert.deepEqual(card.questions[0].options.map(row => row.id), ['project_folder', 'retry']);
  answer(f, s.id, card.id, 'retry');
  await until(() => f.sessionOf(s.id).turns.at(-1).retryHistory?.length === 1 && f.sessionOf(s.id).turns.at(-1).status === 'failed' && !f.runtime.running.has(s.id), 'the retry, failing again');
  await f.quiet(s.id);
  const second = cardOf(f.store, s.id, HOST_CARDS.sessionCreate.actionId(failed.id));
  assert.notEqual(second.id, card.id, 'a fresh card for the second failure'); assert.equal(second.actionId, `${HOST_CARDS.sessionCreate.actionId(failed.id)}:2`);
  answer(f, s.id, second.id, 'project_folder');
  await until(() => f.sessionOf(s.id).turns.at(-1).status === 'completed', 'the turn in the project folder');
  await f.quiet(s.id);
  assert.equal(f.sessionOf(s.id).worktree, undefined, 'the conversation now works in the project folder');
  assert.equal(read(f.P, 'a.txt'), 'retried\n');
  assert.equal(f.sessionOf(s.id).turns.at(-1).checkpoint.state, 'taken', 'a direct-mode turn from now on');
});

test('retry from the create card makes the worktree and runs the turn in it', { skip }, async t => {
  const f = turnFixture(t);
  const create = f.worktrees.create.bind(f.worktrees);
  let failures = 1;
  f.worktrees.create = async (...args) => { if (failures-- > 0) throw Object.assign(new Error('busy'), { code: 'worktree_create_failed', status: 500 }); return create(...args); };
  const s = f.worktreeSession();
  f.model.steps.push({ write: ['a.txt', 'in S\n'] }, { text: '好了。' });
  const failed = await f.send(s.id, '改一下');
  const card = cardOf(f.store, s.id, HOST_CARDS.sessionCreate.actionId(failed.id));
  answer(f, s.id, card.id, 'retry');
  await until(() => f.sessionOf(s.id).turns.at(-1).status === 'completed', 'the retried turn');
  await f.quiet(s.id);
  assert.equal(f.sessionOf(s.id).worktree.state, 'active');
  assert.equal(read(await sRoot(f, s.id), 'a.txt'), 'in S\n'); assert.equal(read(f.P, 'a.txt'), 'in S\n');
  assert.equal(f.sessionOf(s.id).turns.at(-1).worktreeCreate.answered, 'retry');
});

test('turn-start sync: the project folder\'s changes reach S, a file both changed keeps S\'s version (base keeps its old entry), and the model is told', { skip }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  await f.send(s.id, '先看看');
  const before = f.recordOf(s.id).base;
  // Unapplied work in S (as a worker merge leaves it), then the user edits the project folder.
  await intoS(f, s.id, 'a.txt', 'one\nS-two\nthree\n');
  put(f.P, 'a.txt', 'one\nP-two\nthree\n'); put(f.P, 'new.txt', 'from P\n');
  const S = await sRoot(f, s.id);
  f.model.steps.push({ text: '看过了。' });
  // The end-of-turn apply conflicts (both changed line 2): the host merges P into S with markers and continues.
  f.model.steps.push(request => {
    const feedback = feedbackOf(request).find(row => row.source === FEEDBACK_SOURCES.worktreeApply);
    assert.ok(feedback, 'the continuation carries the host-worktree-apply feedback');
    const parsed = JSON.parse(feedback.text);
    assert.deepEqual(parsed.files, ['a.txt']); assert.deepEqual(parsed.nonText, []);
    assert.ok(markersIn(read(S, 'a.txt')), 'S holds the markers'); assert.ok(!markersIn(read(f.P, 'a.txt')), 'P never does');
    return { write: ['a.txt', 'one\nS-two P-two\nthree\n'] };
  }, { text: '合并好了。' });
  const turn = await f.send(s.id, '继续');
  assert.equal(read(S, 'new.txt'), 'from P\n', 'the clean part came in at turn start');
  assert.ok(f.model.requests.some(request => carries(request, 'host-worktree-sync') && JSON.stringify(request.messages).includes('also changed in the project folder')), 'the model was told which files the project folder also changed');
  assert.equal(turn.status, 'completed'); assert.equal(turn.apply.status, 'applied');
  assert.equal(read(f.P, 'a.txt'), 'one\nS-two P-two\nthree\n'); assert.equal(read(f.P, 'new.txt'), 'from P\n');
  assert.equal(turn.apply.conflict.attempts, 1);
  assert.ok(f.sessionOf(s.id).items.some(item => item.turnId === turn.id && item.kind === 'notice' && /正在合并/.test(item.text)));
  assert.notEqual(f.recordOf(s.id).base, before);
  assert.equal(status(S), '');
  assert.equal(f.recordOf(s.id).marks, undefined, 'markers resolved: nothing is remembered');
});

test('a conflict continues the turn at most twice; leftover markers never reach P; the card\'s "this conversation" takes the version from before the markers', { skip }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  const S = await sRoot(f, s.id);
  // The model changes line 2 while the user changes it in the project folder.
  f.model.steps.push(async () => { await afterSync(f, s.id); put(f.P, 'a.txt', 'one\nuser-two\nthree\n'); return { write: ['a.txt', 'one\nmodel-two\nthree\n'] }; },
    { text: '改好了。' }, { text: '还是没处理。' }, { text: '仍然没处理。' });
  const turn = await f.send(s.id, '改第二行');
  assert.equal(turn.status, 'completed');
  assert.equal(turn.apply.status, 'conflicted'); assert.equal(turn.apply.conflict.attempts, 2, 'two continuations, then the user decides');
  assert.equal(f.model.requests.filter(request => feedbackOf(request).some(row => row.source === FEEDBACK_SOURCES.worktreeApply)).length, 2);
  assert.equal(read(f.P, 'a.txt'), 'one\nuser-two\nthree\n', 'P untouched');
  assert.ok(markersIn(read(S, 'a.txt')), 'the markers stay in S');
  const card = cardOf(f.store, s.id, HOST_CARDS.sessionConflict.actionId(turn.id));
  assert.deepEqual(card.questions[0].options.map(row => row.id), ['rna', 'conversation', 'project', 'later']);
  assert.equal(card.source, 'worktree'); assert.deepEqual(turn.apply.card.interactionId, card.id);
  // A hand-back now (an idle apply) leaves the marked file out.
  await f.sessionWorktrees.applyIdle(s.id);
  assert.equal(read(f.P, 'a.txt'), 'one\nuser-two\nthree\n');
  const records = f.applies().length;
  answer(f, s.id, card.id, 'conversation');
  await until(() => f.sessionOf(s.id).turns.find(row => row.id === turn.id).apply.status === 'applied', 'the card answer');
  await f.quiet(s.id);
  assert.equal(read(f.P, 'a.txt'), 'one\nmodel-two\nthree\n', 'the conversation\'s version from before the markers');
  assert.ok(!markersIn(read(f.P, 'a.txt'))); assert.ok(!markersIn(read(S, 'a.txt')));
  assert.equal(read(S, 'a.txt'), read(f.P, 'a.txt'));
  const written = f.applies().slice(records).filter(row => row.target === 'project');
  assert.ok(written.length >= 1 && written.every(row => ['verified', 'unverified'].includes(row.state)), 'every write into P is a record with its checkpoint');
  // …and can be rolled back.
  const preview = await f.engine.rollbackTurn(f.project.id, turn.id, {});
  await f.engine.rollbackTurn(f.project.id, turn.id, { confirm: preview.confirm });
  assert.equal(read(f.P, 'a.txt'), 'one\nuser-two\nthree\n');
});

test('the card\'s "project folder" checkpoints S first, then applies the rest; "later" keeps it pending', { skip }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  const S = await sRoot(f, s.id);
  f.model.steps.push(async () => { await afterSync(f, s.id); put(f.P, 'a.txt', 'one\nuser-two\nthree\n'); return { writes: [['a.txt', 'one\nmodel-two\nthree\n'], ['b.txt', 'model only\n']] }; },
    { text: '好了。' }, { text: '好了。' }, { text: '好了。' });
  const turn = await f.send(s.id, '改');
  assert.equal(turn.apply.status, 'conflicted');
  assert.equal(there(f.P, 'b.txt'), false, 'a finish conflict applies nothing');
  await f.sessionWorktrees.answerConflict(s.id, turn.id, 'later');
  assert.equal(f.sessionOf(s.id).turns.find(row => row.id === turn.id).apply.status, 'pending');
  const sessionRecords = f.applies().filter(row => row.target === `session:${s.id}`).length;
  await f.sessionWorktrees.answerConflict(s.id, turn.id, 'project');
  const after = f.sessionOf(s.id).turns.find(row => row.id === turn.id).apply;
  assert.equal(after.status, 'applied');
  assert.equal(read(f.P, 'a.txt'), 'one\nuser-two\nthree\n'); assert.equal(read(S, 'a.txt'), 'one\nuser-two\nthree\n');
  assert.equal(read(f.P, 'b.txt'), 'model only\n', 'the rest of the conversation\'s work applied');
  assert.ok(f.applies().filter(row => row.target === `session:${s.id}`).length > sessionRecords, 'S was checkpointed before it took P\'s version');
  assert.equal(status(S), '');
});

test('a non-text conflict is never overwritten silently: no continuation, P untouched, the user decides', { skip }, async t => {
  const f = turnFixture(t, { files: { 'cover.bin': Buffer.from([0, 1, 2, 3, 0, 9]) } });
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  const S = await sRoot(f, s.id);
  writeFileSync(join(S, 'cover.bin'), Buffer.from([0, 7, 7, 7, 0, 1]));
  writeFileSync(join(f.P, 'cover.bin'), Buffer.from([0, 5, 5, 5, 0, 2]));
  f.model.steps.push({ text: '看过了。' });
  const turn = await f.send(s.id, '看看');
  assert.equal(turn.apply.status, 'conflicted');
  assert.equal(turn.apply.conflict.paths[0].path, 'cover.bin'); assert.notEqual(turn.apply.conflict.paths[0].kind, 'content');
  assert.equal(f.model.requests.filter(request => feedbackOf(request).length).length, 0, 'nothing the model could merge: no continuation');
  assert.deepEqual([...read(f.P, 'cover.bin')].map(char => char.charCodeAt(0)), [0, 5, 5, 5, 0, 2]);
  assert.deepEqual([...read(S, 'cover.bin')].map(char => char.charCodeAt(0)), [0, 7, 7, 7, 0, 1]);
  // The next turn's start sync keeps S's version and the next finish conflicts again rather than taking it over.
  f.model.steps.push({ text: '没动。' });
  const next = await f.send(s.id, '别的事');
  assert.equal(next.apply.status, 'conflicted');
  assert.deepEqual([...read(f.P, 'cover.bin')].map(char => char.charCodeAt(0)), [0, 5, 5, 5, 0, 2]);
});

test('"let Rna handle it" starts a host turn carrying the conflict for the model', { skip }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  f.model.steps.push(async () => { await afterSync(f, s.id); put(f.P, 'a.txt', 'one\nuser\nthree\n'); return { write: ['a.txt', 'one\nmodel\nthree\n'] }; }, { text: '1' }, { text: '2' }, { text: '3' });
  const turn = await f.send(s.id, '改');
  assert.equal(turn.apply.status, 'conflicted');
  const S = await sRoot(f, s.id);
  f.model.steps.push(request => {
    assert.ok(carries(request, FEEDBACK_SOURCES.worktreeApply), 'the host turn carries the conflict as context');
    return { write: ['a.txt', 'one\nmodel and user\nthree\n'] };
  }, { text: '处理好了。' });
  const turns = f.sessionOf(s.id).turns.length;
  answer(f, s.id, cardOf(f.store, s.id, HOST_CARDS.sessionConflict.actionId(turn.id)).id, 'rna');
  await until(() => f.sessionOf(s.id).turns.length === turns + 1 && f.sessionOf(s.id).turns.at(-1).status === 'completed', 'the host turn');
  await f.quiet(s.id);
  const host = f.sessionOf(s.id).turns.at(-1), item = f.sessionOf(s.id).items.find(row => row.id === host.userItemId);
  assert.equal(item.source, 'host-worktree'); assert.match(item.text, /冲突/);
  assert.equal(read(f.P, 'a.txt'), 'one\nmodel and user\nthree\n'); assert.equal(read(S, 'a.txt'), read(f.P, 'a.txt'));
  assert.equal(f.sessionOf(s.id).turns.find(row => row.id === turn.id).apply.status, 'applied', 'the earlier turn\'s conflict is settled by the later apply');
});

test('hand-backs without a finish apply only the clean part: stop, failure, and a question waiting for the user', { skip }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  const S = await sRoot(f, s.id);
  // Stop.
  let release; const hold = new Promise(done => { release = done; });
  f.model.steps.push({ write: ['a.txt', 'stopped work\n'] }, { hold, then: { text: 'late' } });
  f.store.message(s.id, { text: '写' });
  // The held request is in flight (both steps taken), so the stop lands inside the turn and no step is left for the next one.
  await until(() => there(S, 'a.txt') && read(S, 'a.txt') === 'stopped work\n' && f.model.steps.length === 0, 'the write in S');
  f.store.controlSession(s.id, 'stop'); release();
  await until(() => f.sessionOf(s.id).turns.at(-1).status === 'stopped', 'stop');
  await f.quiet(s.id);
  assert.equal(read(f.P, 'a.txt'), 'stopped work\n'); assert.equal(f.sessionOf(s.id).turns.at(-1).apply.status, 'applied');
  // Failure.
  f.model.steps.push({ write: ['b.txt', 'failed work\n'] }, { fail: 'fixture provider failure' });
  const failed = await f.send(s.id, '再写');
  assert.equal(failed.status, 'failed'); assert.equal(read(f.P, 'b.txt'), 'failed work\n'); assert.equal(failed.apply.status, 'applied');
  // A question card: the clean part goes in while the turn waits for the answer.
  f.model.steps.push({ write: ['c.txt', 'before asking\n'] }, { ask: [{ id: 'q', question: '继续吗？', options: [{ id: 'yes', label: '继续' }] }] }, { text: '好。' });
  f.store.message(s.id, { text: '问我' });
  await until(() => there(f.P, 'c.txt'), 'the apply while the card waits');
  assert.equal(f.sessionOf(s.id).status, 'running', 'the turn is still waiting on the card');
  const question = f.sessionOf(s.id).items.findLast(item => item.interaction?.source === 'tool').interaction;
  f.interactions.answer(s.id, question.id, { requestId: 'answer-q', answers: [{ id: 'q', selected: ['yes'] }] });
  await until(() => f.sessionOf(s.id).turns.at(-1).status === 'completed', 'the answered turn');
  await f.quiet(s.id);
  assert.equal(f.sessionOf(s.id).turns.at(-1).apply.status, 'applied');
});

test('a hand-back with a conflict applies the clean part and leaves the rest pending with the card', { skip }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  f.model.steps.push(async () => { await afterSync(f, s.id); put(f.P, 'a.txt', 'one\nuser\nthree\n'); return { writes: [['a.txt', 'one\nmodel\nthree\n'], ['d.txt', 'clean\n']] }; }, { fail: 'fixture provider failure' });
  const turn = await f.send(s.id, '改');
  assert.equal(turn.status, 'failed');
  assert.equal(read(f.P, 'd.txt'), 'clean\n'); assert.equal(read(f.P, 'a.txt'), 'one\nuser\nthree\n');
  assert.equal(turn.apply.status, 'pending'); assert.deepEqual(turn.apply.conflict.paths.map(row => row.path), ['a.txt']);
  assert.ok(cardOf(f.store, s.id, HOST_CARDS.sessionConflict.actionId(turn.id)));
  assert.equal(f.model.requests.filter(request => feedbackOf(request).length).length, 0, 'no continuation at a hand-back');
});

test('the uncertain-tool recovery pause applies nothing; plan mode and side chats skip every step', { skip }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  const S = await sRoot(f, s.id), turn = f.sessionOf(s.id).turns.at(-1);
  put(S, 'r.txt', 'unconfirmed\n');
  assert.equal(await f.sessionWorktrees.applyOnHandBack(s.id, { turnId: turn.id, reason: 'interaction', recoveryPause: true }), turn.apply);
  assert.equal(there(f.P, 'r.txt'), false);
  // The runtime's own decision: a turn paused for recovery hands nothing back.
  f.store.mutate(state => { const session = state.sessions.find(row => row.id === s.id); session.status = 'paused'; session.pauseReason = 'recovery'; session.activeTurnId = turn.id; session.turns.find(row => row.id === turn.id).status = 'paused'; });
  await f.runtime.afterTurn({ sessionId: s.id, turnId: turn.id, root: await f.rootOf(s.id), projectId: f.project.id, handBack: 'recovery' });
  assert.equal(there(f.P, 'r.txt'), false);
  f.store.mutate(state => { const session = state.sessions.find(row => row.id === s.id); session.status = 'idle'; session.pauseReason = null; session.activeTurnId = null; session.turns.find(row => row.id === turn.id).status = 'completed'; });
  // A side chat reads in the parent's worktree.
  const side = f.store.createSideChat(s.id, {});
  const root = await f.runtime.turnRoot({ memoryAbort: new AbortController() }, f.sessionOf(side.id), { id: 'x', mode: 'plan' }, f.projectRow());
  assert.equal(root.worktreeId, f.recordOf(s.id).id);
  // Plan mode: nothing applied at its end.
  f.store.updateSession(s.id, { mode: 'plan' });
  f.model.steps.push({ text: '只看看。' });
  const plan = await f.send(s.id, '看看');
  assert.equal(plan.apply, undefined); assert.equal(there(f.P, 'r.txt'), false);
});

test('the turn ends in this order: the unmerged-worker reminder (once), turn.settled, then the apply — which needs no decisions', { skip }, async t => {
  const rows = [{ agentId: 'agent-1', role: 'worker', task: 'x', turnId: 't', status: 'conflict', conflicts: [{ path: 'a.txt', kind: 'content' }] }];
  const builtin = { pendingMerges: () => rows, createTools: () => [] };
  let settles = 0;
  const decisions = { chat: async () => null, settled: async () => (settles++ === 0 ? { continue: true, unfinished: true } : { continue: false }) };
  const f = turnFixture(t, { runtime: { builtinAgentService: builtin, decisionService: decisions } });
  const s = f.worktreeSession(), seen = [];
  // Each request notes which host feedback it carries and what the project folder holds at that moment.
  const step = request => { const sources = feedbackOf(request).map(row => row.source); seen.push({ sources, P: read(f.P, 'a.txt') }); return sources.includes('host-turn-settled') ? { write: ['a.txt', 'v2\n'] } : { text: `第 ${seen.length} 次。` }; };
  f.model.steps.push({ write: ['a.txt', 'v1\n'] }, ...Array.from({ length: 6 }, () => step));
  const turn = await f.send(s.id, '做');
  assert.equal(turn.status, 'completed');
  assert.equal(turn.mergeReminded, true); assert.equal(turn.settle.continued, 1);
  const reminder = seen.findIndex(row => row.sources.includes(FEEDBACK_SOURCES.workerMerge)), settled = seen.findIndex(row => row.sources.includes('host-turn-settled'));
  assert.ok(reminder >= 0 && settled > reminder, 'the reminder comes first, then turn.settled');
  assert.equal(seen.filter(row => row.sources.includes(FEEDBACK_SOURCES.workerMerge)).length, 1, 'the reminder is given once per turn');
  assert.ok(seen.every(row => row.P === 'one\ntwo\nthree\n'), 'nothing reaches the project folder before the turn really ends');
  assert.equal(read(f.P, 'a.txt'), 'v2\n'); assert.equal(turn.apply.applyIds.length, 1, 'applied once, last');
});

test('a branch gets its own worktree from the project folder; the original\'s unapplied work stays behind', { skip }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  f.model.steps.push({ text: '好。' });
  await f.send(s.id, '开始');
  await intoS(f, s.id, 'unapplied.txt', 'only in the original\n');
  const message = f.sessionOf(s.id).items.find(item => item.kind === 'assistant');
  const fork = f.store.forkSession(s.id, message.id);
  assert.equal(fork.worktree.state, 'pending'); assert.notEqual(fork.worktree.id, f.sessionOf(s.id).worktree.id);
  assert.match(f.sessionOf(fork.id).items.find(item => item.source === 'worktree').text, /不会带过来/);
  f.model.steps.push({ text: '分支。' });
  await f.send(fork.id, '分支里做');
  const forkRoot = await sRoot(f, fork.id);
  assert.notEqual(forkRoot, await sRoot(f, s.id));
  assert.equal(there(forkRoot, 'unapplied.txt'), false);
});

test('archiving: a worktree with nothing unapplied is removed; one with work that cannot apply is kept', { skip }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  const record = f.recordOf(s.id);
  f.store.updateSession(s.id, { archived: true });
  await until(() => f.projectRow().git.worktrees.find(row => row.id === record.id)?.state === 'removed' && f.sessionOf(s.id).worktree.state === 'pending', 'removal');
  assert.equal(f.sessionOf(s.id).worktree.state, 'pending', 'restored later, it starts from the project folder again');
  const k = f.worktreeSession('保留');
  await f.send(k.id, '开始');
  const S = await sRoot(f, k.id);
  put(S, 'a.txt', 'one\nS\nthree\n'); put(f.P, 'a.txt', 'one\nP\nthree\n'); put(S, 'clean.txt', 'clean\n');
  f.store.updateSession(k.id, { archived: true });
  await until(() => f.sessionOf(k.id).worktree.state === 'kept', 'kept');
  assert.equal(f.recordOf(k.id).state, 'kept');
  assert.equal(read(f.P, 'clean.txt'), 'clean\n', 'one clean apply first'); assert.equal(read(f.P, 'a.txt'), 'one\nP\nthree\n');
});

test('deleting a conversation with unapplied work needs a confirmation; its worktree goes with it', { skip }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  await intoS(f, s.id, 'a.txt', 'unapplied\n'); await intoS(f, s.id, 'x.txt', 'new\n');
  assert.deepEqual(await f.sessionWorktrees.unapplied(s.id), { unapplied: 2 });
  const deletions = new SessionDeletionService(f.store, { sessionWorktrees: f.sessionWorktrees, worktrees: f.worktrees, intervalMs: 3600000 });
  t.after(() => deletions.close());
  await assert.rejects(deletions.confirmWorktree(s.id), error => error.code === 'worktree_unapplied' && error.status === 409 && error.unapplied === 2 && /2/.test(error.message));
  assert.deepEqual(await deletions.confirmWorktree(s.id, { confirm: true }), { unapplied: 2 });
  assert.deepEqual(await deletions.confirmWorktree(f.session.id), { unapplied: 0 }, 'a direct-mode conversation passes');
  const record = f.recordOf(s.id);
  f.store.deleteSession(s.id);
  const result = await deletions.wait(s.id, 20000);
  assert.equal(result.status, 'completed');
  const row = f.projectRow().git.worktrees.find(item => item.id === record.id);
  assert.equal(row.state, 'removed'); assert.ok(git(f.repo, 'rev-parse', REFS.worktree(record.id, 'tip')).trim(), 'its last state stays pinned');
});

test('a lost worktree is rebuilt: from the project folder when nothing was unapplied, from its tip otherwise', { skip }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  let S = await sRoot(f, s.id);
  rmSync(S, { recursive: true, force: true });
  f.model.steps.push({ text: '还在。' });
  const turn = await f.send(s.id, '继续');
  assert.equal(turn.status, 'completed');
  assert.match(f.sessionOf(s.id).items.filter(item => item.source === 'worktree').at(-1).text, /从项目文件夹重建/);
  S = await sRoot(f, s.id);
  assert.equal(read(S, 'a.txt'), 'one\ntwo\nthree\n');
  // Unapplied work at its last snapshot, then the folder disappears.
  put(S, 'tip.txt', 'kept in the tip\n');
  await f.engine.snapshot(f.project.id, await f.rootOf(s.id), { pin: REFS.worktree(f.recordOf(s.id).id, 'tip') });
  rmSync(S, { recursive: true, force: true });
  f.model.steps.push({ text: '回来了。' });
  await f.send(s.id, '再继续');
  assert.match(f.sessionOf(s.id).items.filter(item => item.source === 'worktree').at(-1).text, /最后一次快照/);
  assert.equal(read(f.P, 'tip.txt'), 'kept in the tip\n', 'the rebuilt work applied at the end of the turn');
});

test('moving the project folder repairs the worktrees and the conversation goes on in its own copy', { skip }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  const moved = join(f.dir, 'moved');
  renameSync(f.repo, moved);
  f.store.updateProject(f.project.id, { workspace: moved });
  await until(async () => { try { return (await f.rootOf(s.id)).root.startsWith(moved); } catch { return false; } }, 'the repaired worktree');
  f.model.steps.push({ write: ['a.txt', 'after the move\n'] }, { text: '好。' });
  const turn = await f.send(s.id, '继续');
  assert.equal(turn.apply.status, 'applied'); assert.equal(read(moved, 'a.txt'), 'after the move\n');
});

test('execRunning counts direct-mode project_exec runs only', { skip }, async t => {
  const f = turnFixture(t);
  let peak = 0;
  const watch = setInterval(() => { peak = Math.max(peak, f.runtime.execRunning(f.project.id)); }, 5);
  t.after(() => clearInterval(watch));
  f.model.steps.push({ exec: 'sleep 1' }, { text: '跑完了。' });
  await f.send(f.session.id, '跑命令');
  assert.equal(peak, 1); assert.equal(f.runtime.execRunning(f.project.id), 0);
  assert.equal(f.runtime.execRunning('unknown-project'), 0);
  const s = f.worktreeSession();
  peak = 0;
  f.model.steps.push({ exec: 'sleep 1' }, { text: '跑完了。' });
  await f.send(s.id, '在工作树里跑命令');
  assert.equal(peak, 0, 'an isolated root never counts');
});

test('store: the worktree choice is made when the conversation is created, never switched later; project.git defaults and its one setting', { skip }, async t => {
  const f = turnFixture(t);
  assert.deepEqual(f.projectRow().git, { sessionWorktreeDefault: false, worktrees: [], applies: [] });
  assert.throws(() => f.store.createSession({ projectId: f.project.id, worktree: 'yes' }), /worktree/);
  assert.throws(() => f.store.createSession({ worktree: true }), /项目/);
  const plain = f.store.createSession({ projectId: f.project.id });
  assert.equal(plain.worktree, undefined);
  const s = f.worktreeSession();
  assert.match(s.worktree.id, /^[A-Za-z0-9_-]{1,80}$/);
  assert.throws(() => f.store.updateSession(s.id, { worktree: false }), error => error.status === 409);
  assert.throws(() => f.store.updateSession(plain.id, { worktree: true }), error => error.status === 409);
  assert.equal(f.store.updateProject(f.project.id, { git: { sessionWorktreeDefault: true } }).git.sessionWorktreeDefault, true);
  for (const bad of [{ sessionWorktreeDefault: 'on' }, { sessionWorktreeDefault: true, worktrees: [] }, [], null]) assert.throws(() => f.store.updateProject(f.project.id, { git: bad }), /sessionWorktreeDefault/);
  // Load defaults for state written before 0.63.
  f.store.mutate(state => { delete state.projects.find(row => row.id === f.project.id).git; });
  const { Store } = await import('../store.mjs');
  await f.store.flush?.();
  const again = new Store(f.store.file);
  t.after(() => again.close?.());
  assert.deepEqual(again.state.projects.find(row => row.id === f.project.id).git, { sessionWorktreeDefault: false, worktrees: [], applies: [] });
  const hostTurn = () => f.store.hostTurn(plain.id, { text: 'x', source: 'host-worktree', context: [{ source: 'host-worktree-apply', text: '{}' }] });
  const started = hostTurn();
  assert.equal(f.store.state.sessions.find(row => row.id === plain.id).items.find(item => item.id === started.itemId).hostContext[0].source, 'host-worktree-apply');
  assert.throws(hostTurn, error => error.status === 409, 'a running conversation gets no host turn');
  await delay(0);
});

test('the footer facts: ignored output left in S, a dependency manifest applied, files both sides changed', { skip }, async t => {
  const f = turnFixture(t, { files: { 'a.txt': 'one\ntwo\nthree\n', 'package.json': '{ "name": "x" }\n' } });
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  f.model.steps.push(async () => { await f.runtime.running.get(s.id)?.startSync; put(f.P, 'a.txt', 'one\ntwo\nthree\nuser line\n'); return { writes: [['dist/out.js', 'built\n'], ['package.json', '{ "name": "y" }\n'], ['a.txt', 'model line\none\ntwo\nthree\n']] }; }, { text: '构建好了。' });
  const turn = await f.send(s.id, '构建');
  assert.equal(turn.apply.status, 'applied');
  assert.deepEqual(turn.apply.ignoredNew, ['dist/'], 'ignored output stays in the worktree, and the footer says so');
  assert.equal(there(f.P, 'dist/out.js'), false);
  assert.equal(turn.apply.dependencies, true);
  assert.equal(turn.apply.bothChanged, 1);
  assert.equal(read(f.P, 'a.txt'), 'model line\none\ntwo\nthree\nuser line\n', 'both sides kept where they do not overlap');
});

test('an idle conversation applies what reached its worktree outside a turn (a worker merge); startup does the same', { skip }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  const first = await f.send(s.id, '开始');
  await intoS(f, s.id, 'worker.txt', 'merged by a worker\n');
  const apply = await f.sessionWorktrees.applyIdle(s.id);
  assert.equal(apply.status, 'applied'); assert.equal(read(f.P, 'worker.txt'), 'merged by a worker\n');
  assert.equal(f.sessionOf(s.id).turns.at(-1).id, first.id); assert.ok(f.sessionOf(s.id).turns.at(-1).apply.applyIds.length >= 1, 'recorded on the conversation\'s last turn');
  assert.equal(await f.sessionWorktrees.applyIdle(s.id), null, 'nothing new: nothing to report');
  assert.equal(await f.sessionWorktrees.applyIdle('no-such-session'), null);
  await intoS(f, s.id, 'later.txt', 'after a restart\n');
  const recovered = await f.sessionWorktrees.recover();
  assert.deepEqual(recovered.applied, [s.id]); assert.equal(read(f.P, 'later.txt'), 'after a restart\n');
});

test('an upload the project folder ignores is copied into the worktree at turn start', { skip }, async t => {
  const f = turnFixture(t, { gitignore: 'dist/\nattachments/\n' });
  const s = f.worktreeSession();
  const first = await f.send(s.id, '开始');
  put(f.P, 'attachments/brief.md', '需求\n');
  f.store.mutate(state => { const session = state.sessions.find(row => row.id === s.id); session.items.find(item => item.id === first.userItemId).attachments = [{ id: 'att-1', name: 'brief.md', workspacePath: 'attachments/brief.md' }, { id: 'att-2', name: 'x', workspacePath: '../escape.md' }]; });
  const result = await f.sessionWorktrees.syncStart(s.id, { turnId: first.id });
  assert.equal(result.status, 'clean');
  const S = await sRoot(f, s.id);
  assert.equal(read(S, 'attachments/brief.md'), '需求\n'); assert.equal(there(join(S, '..'), 'escape.md'), false);
});
