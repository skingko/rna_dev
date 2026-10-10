import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../store.mjs';
import { ProjectMindService, ensureMind, addCommitment, addLesson, mergeNotes, mindSource, patchMindEntry, mindContextUpdates, commitmentOverdue, commitmentPhase, restatableRequests, restartWindow, judgementLabels, selectLessons, addAgenda, resolveCommitments, applyWorkOutcomes, expiredCommitments, lastLifeAt, publicMind } from '../project-mind.mjs';
import { MIND_JUDGE_LIMITS } from '../../../packages/sdk/src/decision-templates.mjs';
import { overdueCommitments, pacingSignals, pursuedOverdue } from '../proactive-pacing.mjs';

// D4 (docs/research/reference-alignment-20261005.md §2.2 D4; mu features/memory.ts merge-before-write, headlong monolith/step:204-237):
// a commitment has one identity and a lifecycle (no fixed 4 h clock), the assistant's promise is turn.settled's verdict, the
// judgments behind a row are recorded for the user's hand to label, and the notes the rules already state are injected once.
// Judges are plain functions; no model, no JEV, no network.
const CLOCK = Date.parse('2026-10-05T01:00:00Z'), HOUR = 3600000, DAY = 24 * HOUR;
function setup(t, { decisions = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-mind-d4-')), store = new Store(join(dir, 'state.json')), clock = { value: CLOCK };
  const { project, session } = store.createProject({ name: '玄幻小说', workspace: dir });
  store.mutate(state => { Object.assign(state.projects.find(row => row.id === project.id), { simulated: false, decisionMode: 'rna-model', initialization: { status: 'ready' } }); state.sessions.find(row => row.id === session.id).simulated = false; });
  const mind = new ProjectMindService(store, { decisions, provider: null, now: () => clock.value, sweepIntervalMs: 0, notesIntervalMs: 3600000 });
  t.after(async () => { await mind.close(); rmSync(dir, { recursive: true, force: true }); });
  const current = () => store.state.projects.find(row => row.id === project.id), sessionOf = () => store.state.sessions.find(row => row.id === session.id);
  const turn = (text, { reply, status = 'completed', item = {}, verdict = null } = {}) => {
    const ids = { turnId: randomUUID(), userItemId: randomUUID() }, at = new Date(clock.value).toISOString();
    store.mutate(state => { const s = state.sessions.find(row => row.id === session.id);
      s.turns.push({ id: ids.turnId, status, userItemId: ids.userItemId, createdAt: at, completedAt: at, modelConfig: { execution: 'rna' }, simulated: false, ...(verdict ? { settledVerdict: { finished: null, complete: null, waiting: null, deferred: null, promise: null, ...verdict } } : {}) });
      s.items.push({ id: ids.userItemId, turnId: ids.turnId, kind: 'user', text, createdAt: at, simulated: false, ...item });
      if (reply) s.items.push({ id: randomUUID(), turnId: ids.turnId, kind: 'assistant', text: reply, final: true, simulated: false, createdAt: at }); });
    return ids;
  };
  const rows = () => current().mind.commitments, row = id => rows().find(entry => entry.id === id);
  return { dir, store, mind, project, session, current, sessionOf, turn, clock, rows, row };
}
const add = (f, input = {}) => { let created; f.store.mutate(state => { created = addCommitment(ensureMind(state.projects.find(entry => entry.id === f.project.id)), { request: '明天把第 12 章写完发我', trigger: 'user_request', ...input }, { now: f.clock.value }); }); return created; };
const capture = { isCorrection: false, isPreference: false, isApproval: false, pendingRequest: false, selfImprovement: false };
const judges = (modes = {}, extra = {}) => ({ enabled: point => point in modes, config: () => ({ modes }), ...extra });

test('D4 lifecycle: no due moment at creation; with no judge acting the fallback clock sets one, with the due judge acting only the evidence does', async t => {
  assert.equal(addCommitment({ commitments: [] }, { request: '写第 12 章' }).overdueAt, undefined, 'the pure writer sets no deadline unless it is given one');
  assert.ok(addCommitment({ commitments: [] }, { request: '写第 12 章', overdueAt: CLOCK + HOUR }).overdueAt, 'the user\'s own deadline is kept');
  // Nothing acts: the clock is the fallback, counted from where the window started.
  const f = setup(t), made = add(f);
  assert.equal(commitmentPhase(f.row(made.id), CLOCK), 'open');
  f.clock.value += 3 * HOUR; f.mind.sweep();
  assert.equal(f.row(made.id).overdueAt, undefined, 'not yet');
  f.clock.value += 2 * HOUR; f.mind.sweep();
  assert.equal(f.row(made.id).overdueAt, new Date(CLOCK + 4 * HOUR).toISOString(), 'four hours after the window began');
  assert.equal(f.row(made.id).dueBy, 'default'); assert.equal(commitmentPhase(f.row(made.id), f.clock.value), 'due');
  // Shadow does not act either.
  const s = setup(t, { decisions: judges({ 'commitment.due': 'shadow' }) }), shadowed = add(s);
  s.clock.value += 5 * HOUR; s.mind.sweep();
  assert.equal(s.row(shadowed.id).dueBy, 'default');
  // The due judge acts: a request is never overdue by the clock, a month on.
  const g = setup(t, { decisions: judges({ 'commitment.due': 'active' }) }), judged = add(g);
  g.clock.value += 30 * HOUR; g.mind.sweep();
  assert.equal(g.row(judged.id).overdueAt, undefined, 'the evidence decides, not a clock');
  assert.equal(commitmentOverdue(g.row(judged.id), g.clock.value), false);
});

test('D4 lifecycle: the due judge sets the due moment from the window, and a "wait" invents no deadline', async t => {
  const asked = [];
  const f = setup(t, { decisions: judges({ 'commitment.due': 'active' }, { commitmentDue: async (_project, { commitments }) => { asked.push(commitments.map(row => ({ request: row.request, createdAt: row.createdAt }))); return asked.length === 1 ? { due: [], wait: [0] } : { due: [0], wait: [] }; } }) });
  const made = add(f);
  f.clock.value += HOUR;
  await f.mind.checkDue(f.project.id);
  assert.equal(f.row(made.id).overdueAt, undefined, 'a wait with no deadline just waits'); assert.ok(f.row(made.id).dueCheckedAt);
  f.clock.value += HOUR;
  await f.mind.checkDue(f.project.id);
  assert.equal(f.row(made.id).dueBy, 'judge'); assert.equal(f.row(made.id).overdueAt, new Date(f.clock.value).toISOString());
  // A request asked for again meets the judge by where its new window started, not by when it was first made.
  f.store.mutate(state => { const entry = state.projects.find(row => row.id === f.project.id).mind.commitments[0]; restartWindow(entry); entry.continuedAt = new Date(f.clock.value).toISOString(); });
  f.clock.value += 30 * 60000; asked.length = 1;
  await f.mind.checkDue(f.project.id);
  assert.equal(asked.at(-1)[0].createdAt, new Date(CLOCK + 2 * HOUR).toISOString(), 'the window start, not the creation time');
});

test('D4 lifecycle: a request the user must answer is not owed by Rna until they speak again; the turn that waits clears any due moment', async t => {
  const calls = [];
  const f = setup(t, { decisions: judges({ 'commitment.due': 'active' }, { commitmentDue: async () => { calls.push(1); return { due: [0], wait: [] }; } }) });
  const first = f.turn('按新大纲重写第 12 章', { reply: '新大纲里 A 和 B 冲突，你选哪个？', verdict: { waiting: true, waitingForUser: true, complete: false, finished: false } });
  const made = add(f, { request: '按新大纲重写第 12 章', overdueAt: CLOCK - HOUR, source: mindSource('capture', { sessionId: f.session.id, itemId: first.userItemId, turnId: first.turnId }) });
  await f.mind.afterTurn({ sessionId: f.session.id, turnId: first.turnId });
  const waiting = f.row(made.id);
  assert.deepEqual([waiting.waitingOnUser.turnId, waiting.overdueAt], [first.turnId, undefined]);
  assert.equal(commitmentPhase(waiting, f.clock.value), 'waiting_user'); assert.equal(commitmentOverdue(waiting, f.clock.value + DAY), false);
  f.clock.value += 2 * HOUR; await f.mind.checkDue(f.project.id); f.mind.sweep();
  assert.equal(calls.length, 0, 'the due judge is not asked about a request that waits for the user'); assert.equal(f.row(made.id).overdueAt, undefined);
  // Even with a due moment on it (the user's own deadline typed in the mind page), a request that waits for the user's answer is not overdue
  // to anyone: not in the count, not for the gate (proactive-pacing), not for the fallback clock.
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).mind.commitments.find(entry => entry.id === made.id).overdueAt = new Date(CLOCK - HOUR).toISOString(); });
  assert.equal(commitmentOverdue(f.row(made.id), f.clock.value), false);
  assert.deepEqual(overdueCommitments(f.current().mind, f.clock.value), [], 'the initiative gate does not count it either');
  assert.equal(pacingSignals(f.current(), [f.sessionOf()], { now: f.clock.value }).overdueCommitments, 0);
  f.store.mutate(state => { delete state.projects.find(row => row.id === f.project.id).mind.commitments.find(entry => entry.id === made.id).overdueAt; });
  // What the models read: not to be reminded or worked on.
  const block = JSON.parse(mindContextUpdates({ commitments: [f.row(made.id)], now: f.clock.value }).find(update => update.key === 'project-mind-turn').text);
  assert.equal(block.commitments[0].waitingForUser, true); assert.match(block.states.waitingForUser, /Do not remind them/);
  // The user speaks again in that conversation: the wait is over.
  const answer = f.turn('选 A');
  await f.mind.capture({ sessionId: f.session.id, turnId: answer.turnId, route: { capture } });
  assert.equal(f.row(made.id).waitingOnUser, undefined); assert.equal(commitmentPhase(f.row(made.id), f.clock.value), 'open');
});

test('D4 lifecycle: a pending request nobody touched for the gate\'s fourteen days ends as expired; a sign of life, or work waiting to apply, keeps it', async t => {
  const f = setup(t, { decisions: judges({ 'commitment.due': 'active' }) });
  const old = add(f, { request: '半个月前的请求' }), carried = add(f, { request: '被接着做过的请求' }), applying = add(f, { request: '等着合入的请求' });
  f.store.mutate(state => { const mind = state.projects.find(row => row.id === f.project.id).mind; mind.commitments.find(row => row.id === applying.id).awaitingApply = { actionId: 'a1', changeId: 'c1', at: new Date(CLOCK).toISOString() }; });
  f.clock.value += 13 * DAY;
  f.store.mutate(state => { const mind = state.projects.find(row => row.id === f.project.id).mind; mind.commitments.find(row => row.id === carried.id).continuedAt = new Date(f.clock.value).toISOString(); });
  f.clock.value += 2 * DAY; f.mind.sweep();
  assert.deepEqual([f.row(old.id).status, f.row(old.id).reason, f.row(old.id).dismissedBy], ['dismissed', 'expired', undefined]);
  assert.equal(commitmentPhase(f.row(old.id), f.clock.value), 'expired');
  assert.equal(f.row(carried.id).status, 'pending', 'carried on two days ago'); assert.equal(f.row(applying.id).status, 'pending', 'its settle is the apply');
});

test('MIND-5: a message the judge says asks for a pending request again joins that row — no twin — and restarts its window', async t => {
  const f = setup(t, { decisions: judges() });
  const first = f.turn('明天把第 12 章写完发我', { reply: '好的。' });
  await f.mind.capture({ sessionId: f.session.id, turnId: first.turnId, route: { capture: { ...capture, pendingRequest: true } } });
  const [made] = f.rows();
  assert.equal(made.trigger, 'user_request'); f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).mind.commitments[0].overdueAt = new Date(CLOCK + HOUR).toISOString(); state.projects.find(row => row.id === f.project.id).mind.commitments[0].invitedAt = 'x'; });
  f.clock.value += 3 * HOUR;
  // The second message: the capture offers the pending request, the judge picks it.
  const again = f.turn('还没写完吧？把第 12 章写完发我。');
  const input = f.mind.captureInput(f.sessionOf(), f.sessionOf().items.find(row => row.id === again.userItemId));
  assert.deepEqual(input.requests, [{ commitmentId: made.id, text: '明天把第 12 章写完发我' }]);
  await f.mind.capture({ sessionId: f.session.id, turnId: again.turnId, input, route: { capture: { ...capture, pendingRequest: true, restates: 0 } } });
  assert.equal(f.rows().length, 1, 'one row per request');
  const joined = f.row(made.id), item = f.sessionOf().items.find(row => row.id === again.userItemId);
  assert.equal(joined.evidence.length, 2); assert.match(joined.evidence[1].excerpt, /还没写完吧/);
  assert.deepEqual([joined.continuedBy.itemId, joined.continuedBy.via, joined.overdueAt, joined.invitedAt], [again.userItemId, 'jev', undefined, undefined], 'the window restarts: nothing due, nothing asked');
  assert.deepEqual(item.capture.continues, { commitmentId: made.id, via: 'jev' }); assert.equal(item.capture.sources.continues, 'jev');
  // The turn that works on it finishes it: the joined row settles, as a named continuation does.
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).turns.find(row => row.id === again.turnId).settledVerdict = { finished: true, complete: true, waiting: false, deferred: false, promise: null }; });
  await f.mind.afterTurn({ sessionId: f.session.id, turnId: again.turnId });
  assert.deepEqual([f.row(made.id).status, f.row(made.id).resolvedBy.turnId], ['resolved', again.turnId]);
});

test('MIND-5: a different request on the same topic, or a judge that answered "none" or abstained, is its own request — the message that asked is never merged on a guess', async t => {
  const f = setup(t, { decisions: judges() });
  const first = f.turn('明天把第 12 章写完发我', { reply: '好的。' });
  await f.mind.capture({ sessionId: f.session.id, turnId: first.turnId, route: { capture: { ...capture, pendingRequest: true } } });
  const send = async (text, answer) => { const run = f.turn(text); await f.mind.capture({ sessionId: f.session.id, turnId: run.turnId, route: { capture: { ...capture, pendingRequest: true, ...answer } } }); return run; };
  await send('明天把第 11 章也写完发我', {});                       // JEV answered the capture and said nothing about restating: a new request
  assert.equal(f.rows().length, 2);
  await send('明天把第 12 章写完发我', {});                         // the very text again, but a judge answered: its word stands (an abstention joins nothing)
  assert.equal(f.rows().length, 3, 'no wording rule decides it once a judge answered');
  // No judge answered at all (off, shadow, unavailable): the same text sent again is the same request, a code fact.
  const f2 = setup(t);
  const a = f2.turn('明天把第 12 章写完发我'); await f2.mind.capture({ sessionId: f2.session.id, turnId: a.turnId, route: null, input: { outputs: [], threads: [], questions: [], requests: [] } });
  // (the heuristic capture reads "明天" as a pending request)
  assert.equal(f2.rows().length, 1);
  const b = f2.turn('明天  把第 12 章写完发我！'); await f2.mind.capture({ sessionId: f2.session.id, turnId: b.turnId, route: null, input: { outputs: [], threads: [], questions: [], requests: [] } });
  assert.equal(f2.rows().length, 1, 'the same words again: one row'); assert.equal(f2.rows()[0].continuedBy.via, 'same_text');
  const c = f2.turn('明天把第 11 章写完发我'); await f2.mind.capture({ sessionId: f2.session.id, turnId: c.turnId, route: null, input: { outputs: [], threads: [], questions: [], requests: [] } });
  assert.equal(f2.rows().length, 2, 'other words are another request');
});

test('MIND-5: a request settled between the question and the capture is not joined; a message that names what it continues needs no question', async t => {
  const f = setup(t, { decisions: judges() });
  const first = f.turn('明天把第 12 章写完发我', { reply: '好的。' });
  await f.mind.capture({ sessionId: f.session.id, turnId: first.turnId, route: { capture: { ...capture, pendingRequest: true } } });
  const [made] = f.rows();
  const again = f.turn('把第 12 章写完发我');
  const input = f.mind.captureInput(f.sessionOf(), f.sessionOf().items.find(row => row.id === again.userItemId));
  f.mind.resolve(f.project.id, [made.id]);
  await f.mind.capture({ sessionId: f.session.id, turnId: again.turnId, input, route: { capture: { ...capture, pendingRequest: true, restates: 0 } } });
  assert.equal(f.rows().length, 2, 'the settled request is not joined: the message is its own request');
  assert.equal(f.sessionOf().items.find(row => row.id === again.userItemId).capture.continues, undefined);
  const named = f.turn('接着完成：x', { item: { continues: { commitmentId: made.id } } });
  assert.deepEqual(f.mind.captureInput(f.sessionOf(), f.sessionOf().items.find(row => row.id === named.userItemId)).requests, [], 'it already says which');
});

test('MIND-5: with more pending requests than the question holds, the ones nearest the message are offered, newest first; the user\'s own and failed requests only', () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({ id: `c${index}`, status: 'pending', trigger: 'user_request', request: index === 2 ? '整理人物关系表' : `无关的事 ${index} 号任务`, createdAt: new Date(CLOCK + index * 60000).toISOString() }));
  rows.push({ id: 'p', status: 'pending', trigger: 'agent_promise', request: '整理人物关系表，稍后', createdAt: new Date(CLOCK + 9 * 60000).toISOString() }, { id: 'done', status: 'resolved', trigger: 'user_request', request: '整理人物关系表', createdAt: new Date(CLOCK).toISOString() });
  const picked = restatableRequests({ mind: { commitments: rows } }, '把人物关系表整理一下', { limit: 3 });
  assert.equal(picked.length, 3); assert.ok(picked.some(row => row.commitmentId === 'c2'), 'the lexical neighbour is among them');
  assert.deepEqual(picked.map(row => row.commitmentId), [...picked.map(row => row.commitmentId)].sort((a, b) => Number(b.slice(1)) - Number(a.slice(1))), 'newest first');
  assert.ok(!picked.some(row => ['p', 'done'].includes(row.commitmentId)), 'a promise of the assistant\'s own, or a settled one, is not what a message asks for again');
  assert.equal(restatableRequests({ mind: { commitments: rows.slice(0, 2) } }, '随便', { limit: 5 }).length, 2, 'no more than the limit: every one, whatever the wording');
});

test('D4 lifecycle: the card that asks about an overdue request closes when the request stops being overdue (asked again, or waiting for the user), not only when it is settled', async t => {
  const f = setup(t), closed = [];
  f.mind.invitations = { close: (sessionId, cardId, reason) => { closed.push([cardId, reason]); f.store.mutate(state => { const session = state.sessions.find(row => row.id === sessionId); session.invitations = session.invitations.filter(card => card.id !== cardId); }); } };
  const made = add(f, { overdueAt: CLOCK - HOUR }), waits = add(f, { request: '第二件', overdueAt: CLOCK - HOUR });
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).invitations = [{ id: 'card-1', kind: 'commitment', commitmentId: made.id }, { id: 'card-2', kind: 'commitment', commitmentId: waits.id }]; });
  f.mind.sweep();
  assert.deepEqual(closed, [], 'both are still overdue: their cards stay');
  // The user types the request again: the window restarts, so the first card no longer asks about anything overdue.
  f.store.mutate(state => { const mind = state.projects.find(row => row.id === f.project.id).mind, row = mind.commitments.find(entry => entry.id === made.id); restartWindow(row); row.continuedAt = new Date(CLOCK).toISOString(); });
  f.mind.sweep();
  assert.deepEqual(closed, [['card-1', 'expired']]);
  // A turn that ends waiting for the user's answer: the second card goes too.
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).mind.commitments.find(entry => entry.id === waits.id).waitingOnUser = { sessionId: f.session.id, turnId: 't', at: new Date(CLOCK).toISOString() }; });
  f.mind.sweep();
  assert.deepEqual(closed, [['card-1', 'expired'], ['card-2', 'expired']]);
});

test('MIND-4: an assistant\'s promise is turn.settled\'s verdict with the sentence that states it; wording alone, a conditional offer, or no verdict opens nothing', async t => {
  const f = setup(t);
  const promised = f.turn('跑完测试后告诉我', { reply: '测试已经启动。我会在测试结束后把失败的用例发给你。', verdict: { promise: true, finished: true, complete: true, waiting: false, promiseText: '我会在测试结束后把失败的用例发给你。' } });
  await f.mind.afterTurn({ sessionId: f.session.id, turnId: promised.turnId });
  const [promise] = f.rows();
  assert.deepEqual([promise.trigger, promise.request, promise.status, promise.source.kind, promise.overdueAt], ['agent_promise', '我会在测试结束后把失败的用例发给你。', 'pending', 'agent', undefined]);
  assert.equal(promise.evidence[0].excerpt, '我会在测试结束后把失败的用例发给你。');
  await f.mind.afterTurn({ sessionId: f.session.id, turnId: promised.turnId });
  assert.equal(f.rows().length, 1, 'once per turn');
  // The wording the retired rule read as promises, with a verdict that says it is not one (or none at all): nothing.
  for (const verdict of [{ promise: false, waiting: true }, { promise: null }, null]) {
    const run = f.turn('开始写第 13 章', { reply: '你确认大纲之后我就会开始写，稍后我会把节拍表发给你。', ...(verdict ? { verdict } : {}) });
    await f.mind.afterTurn({ sessionId: f.session.id, turnId: run.turnId });
  }
  assert.equal(f.rows().length, 1);
  // A promise made in a turn that did not complete is not recorded (a failed turn has its own row).
  const failed = f.turn('写第 14 章', { status: 'failed', reply: '我会稍后重试。', verdict: { promise: true, promiseText: '我会稍后重试。' } });
  await f.mind.afterTurn({ sessionId: f.session.id, turnId: failed.turnId });
  assert.equal(f.rows().filter(row => row.trigger === 'agent_promise').length, 1);
});

test('MIND-15: each commitment a mind.judge call read carries its ledger id and question; the user\'s own hand on it labels the call, the model\'s next step never does', async t => {
  const labeled = []; let ledger = 0;
  const decisions = judges({ 'mind.judge': 'active' }, { mindJudge: async (_project, { commitments, candidate }) => candidate !== undefined ? null : ({ resolved: commitments.length > 1 ? [0] : [], ledgerId: `L${++ledger}` }), labelDecision: (id, label, options) => { labeled.push([id, label, options?.source]); return true; } });
  const f = setup(t, { decisions });
  const a = add(f, { request: '整理人物关系表' }), b = add(f, { request: '检查前十章人名' });
  // Newest first: the judge reads [b, a] and resolves the first it is shown (b).
  const run = f.turn('人物关系表如何了？', { reply: '已整理好：共 14 人。前十章人名我已核对。' });
  await f.mind.afterTurn({ sessionId: f.session.id, turnId: run.turnId });
  const resolved = f.rows().find(row => row.status === 'resolved'), kept = f.rows().find(row => row.status === 'pending');
  assert.ok(resolved && kept && resolved.id !== kept.id);
  assert.deepEqual([resolved.judgedLedgerId, resolved.judgedQuestion, resolved.resolvedBy.ledgerId], ['L1', 'resolved_0', 'L1']);
  assert.deepEqual([kept.judgedLedgerId, kept.judgedQuestion], ['L1', 'resolved_1'], 'kept pending is a decision too');
  assert.deepEqual(labeled, [], 'the call itself, and a later call, label nothing');
  const next = f.turn('谢谢', { reply: '不客气。' });
  await f.mind.afterTurn({ sessionId: f.session.id, turnId: next.turnId });
  assert.deepEqual(labeled, [], 'no label from the model\'s own next step');
  // The user reopens what the judge resolved: that is the judge being wrong.
  const labels = [];
  f.store.mutate(state => { patchMindEntry(state.projects.find(row => row.id === f.project.id), 'commitments', resolved.id, { status: 'pending' }, { now: f.clock.value, labels }); });
  assert.deepEqual(labels, [{ ledgerId: 'L1', label: 'resolved_wrong' }]);
  assert.equal(f.row(resolved.id).judgedLedgerId, undefined, 'a decision is labelled once');
  f.mind.labelJudgements(labels);
  assert.deepEqual(labeled, [['L1', 'resolved_wrong', 'outcome']], 'an outcome label: the user acted');
  // The user settles by hand what the judge kept pending: a miss. Dropping it says nothing about the judgment.
  const missed = []; f.store.mutate(state => { patchMindEntry(state.projects.find(row => row.id === f.project.id), 'commitments', kept.id, { status: 'resolved' }, { now: f.clock.value, labels: missed }); });
  assert.deepEqual(missed, [{ ledgerId: 'L2', label: 'resolved_missed' }], 'the latest call that kept it pending (the next turn read it again)');
  const dropped = add(f, { request: '另一件事' }); f.store.mutate(state => { ensureMind(state.projects.find(row => row.id === f.project.id)).commitments.find(row => row.id === dropped.id).judgedLedgerId = 'L9'; ensureMind(state.projects.find(row => row.id === f.project.id)).commitments.find(row => row.id === dropped.id).judgedQuestion = 'resolved_0'; });
  const none = []; f.store.mutate(state => { patchMindEntry(state.projects.find(row => row.id === f.project.id), 'commitments', dropped.id, { status: 'dismissed' }, { now: f.clock.value, labels: none }); });
  assert.deepEqual(none, []);
  // The pure reading, for the other collections.
  assert.deepEqual(judgementLabels('lessons', { status: 'superseded', judgedLedgerId: 'L2', judgedQuestion: 'contradicts_1' }, { status: 'active' }), [{ ledgerId: 'L2', label: 'contradicts_wrong' }]);
  assert.deepEqual(judgementLabels('lessons', { status: 'superseded', judgedLedgerId: 'L2', judgedQuestion: 'same_0' }, { status: 'retired' }), [], 'only switching a replaced lesson back on');
  assert.deepEqual(judgementLabels('agenda', { status: 'dropped', judgedLedgerId: 'L3', judgedQuestion: 'superseded_2' }, { status: 'open' }), [{ ledgerId: 'L3', label: 'superseded_wrong' }]);
  assert.deepEqual(judgementLabels('commitments', { status: 'resolved' }, { status: 'pending' }), [], 'no recorded call, no label');
  assert.equal(MIND_JUDGE_LIMITS.resolved, 8);
});

test('MIND-15: a lesson the judge replaced (a repeat, a sharper version, a contradiction) records the call, and switching it back on labels it', async t => {
  let ledger = 0;
  const f = setup(t, { decisions: judges({ 'mind.judge': 'active' }, { mindJudge: async (_project, { candidate }) => candidate === undefined ? null : ({ same: [], refines: [], contradicts: [0], applies: [], notApplies: [], resolved: [], ledgerId: `J${++ledger}` }) }) });
  let oldId, newId;
  f.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === f.project.id)); oldId = addLesson(mind, { kind: 'preference', text: '每章 3000 字以内', source: mindSource('user') }, { now: CLOCK }).id; newId = addLesson(mind, { kind: 'preference', text: '每章不少于 4000 字', source: mindSource('user') }, { now: CLOCK + 1000 }).id; });
  f.clock.value += 5000;
  await f.mind.consolidateLesson(f.project.id, newId);
  const replaced = f.current().mind.lessons.find(row => row.id === oldId);
  assert.deepEqual([replaced.status, replaced.supersededReason, replaced.judgedLedgerId, replaced.judgedQuestion], ['superseded', 'contradicts', 'J1', 'contradicts_0']);
  const labels = []; f.store.mutate(state => { patchMindEntry(state.projects.find(row => row.id === f.project.id), 'lessons', oldId, { status: 'active' }, { now: f.clock.value, labels }); });
  assert.deepEqual(labels, [{ ledgerId: 'J1', label: 'contradicts_wrong' }]);
});

test('D4 notes: a preference note a rule in force already states is left out of the notes block, in memory only; nothing in storage changes, and it returns with the rule gone', async t => {
  const asked = [];
  const f = setup(t, { decisions: judges({ 'mind.judge': 'active' }, { mindCovered: async (_project, { rows, rules }) => { asked.push({ rows: rows.map(row => row.text), rules: rules.map(row => row.text ?? row) }); return { covered: rows.flatMap((row, index) => /活人感/.test(row.text) ? [index] : []), ledgerId: 'C1' }; } }) });
  let ruleId;
  f.store.mutate(state => {
    const mind = ensureMind(state.projects.find(row => row.id === f.project.id));
    ruleId = addLesson(mind, { kind: 'preference', text: '行文要有活人感，别太生硬。', source: mindSource('user') }, { now: CLOCK }).id;
    addLesson(mind, { kind: 'constraint', text: '数字一律用汉字', source: mindSource('user') }, { now: CLOCK });
    mergeNotes(mind, { preferences: ['表达不要过于生硬，要有“活人感”', '行文要有活人感，别太生硬。', '每章结尾留悬念'], facts: ['用户晚上写作'] }, { now: CLOCK });
  });
  const stored = () => f.current().mind.notes.preferences.map(row => row.text);
  const block = async () => { const run = f.turn('继续写'); const updates = await f.mind.foregroundContext({ sessionId: f.session.id, turnId: run.turnId, prompt: '继续写' }); return JSON.parse(updates.find(update => update.key === 'project-mind-notes').text).notes; };
  // Before any answer: equal text is code's call (needs no judge); the others are injected as before.
  assert.deepEqual((await block()).preferences, ['表达不要过于生硬，要有“活人感”', '每章结尾留悬念'], 'the line that is the rule word for word is out; the paraphrase waits for the judge');
  await f.mind.idle();
  assert.equal(asked.length, 1, 'one batch call, off the turn\'s path'); assert.deepEqual(asked[0].rows, ['表达不要过于生硬，要有“活人感”', '每章结尾留悬念']);
  assert.deepEqual(asked[0].rules.sort(), ['数字一律用汉字', '行文要有活人感，别太生硬。'].sort(), 'asked against the rules the model reads in every request');
  const covered = await block();
  assert.deepEqual(covered.preferences, ['每章结尾留悬念'], 'the paraphrase is injected once, as the rule'); assert.deepEqual(covered.facts, ['用户晚上写作'], 'facts are not rules');
  assert.equal(stored().length, 3, 'storage is untouched: the note is still there'); assert.ok(stored().includes('表达不要过于生硬，要有“活人感”'));
  const again = await block(); await f.mind.idle();
  assert.equal(asked.length, 1, 'answered once, kept in memory');
  assert.deepEqual(again.preferences, ['每章结尾留悬念']);
  // The rule that covers it is revoked: the note is injected again (a new answer is asked for, against the rules left).
  f.store.mutate(state => { patchMindEntry(state.projects.find(row => row.id === f.project.id), 'lessons', ruleId, { status: 'retired' }, { now: f.clock.value }); });
  assert.deepEqual((await block()).preferences.slice(0, 2), ['表达不要过于生硬，要有“活人感”', '行文要有活人感，别太生硬。'], 'with the rule gone nothing covers either of them');
});

test('D4 notes: only the notes about to be injected are checked, an unanswered or failed judgment injects as before, and a rule that is not in every request covers nothing', async t => {
  const f = setup(t, { decisions: judges({ 'mind.judge': 'active' }, { mindCovered: async () => null }) });
  f.store.mutate(state => {
    const mind = ensureMind(state.projects.find(row => row.id === f.project.id));
    addLesson(mind, { kind: 'pitfall', text: '章节开头别写天气', source: mindSource('user') }, { now: CLOCK });   // a pitfall: injected only when relevant, not a standing rule
    mergeNotes(mind, { preferences: Array.from({ length: 14 }, (_, index) => `第 ${index} 条偏好`) }, { now: CLOCK });
  });
  assert.deepEqual(f.mind.uncheckedNotes(f.current(), []), [], 'no rule in force, nothing to ask against');
  assert.deepEqual(selectLessons(f.current(), '章节').always, [], 'the pitfall is not a standing rule: it is injected only when relevant');
  f.store.mutate(state => { addLesson(ensureMind(state.projects.find(row => row.id === f.project.id)), { kind: 'constraint', text: '数字一律用汉字', source: mindSource('user') }, { now: CLOCK }); });
  const standing = selectLessons(f.current(), '').always;
  assert.equal(f.mind.uncheckedNotes(f.current(), standing).length, 10, 'the last ten only: they are what the block carries');
  assert.equal(f.mind.injectedNotes(f.current(), standing).preferences.length, 10, 'a judge that did not answer changes nothing');
  assert.equal(await f.mind.refreshCoverage(f.project.id), null);
  assert.equal(f.mind.injectedNotes(f.current(), standing).preferences.length, 10);
  // No judge acting: nothing is asked, and the notes go as they are.
  const g = setup(t, { decisions: judges({}, { mindCovered: async () => { throw new Error('not asked'); } }) });
  g.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === g.project.id)); addLesson(mind, { kind: 'constraint', text: '数字一律用汉字', source: mindSource('user') }, { now: CLOCK }); mergeNotes(mind, { preferences: ['x 偏好'] }, { now: CLOCK }); });
  g.mind.coverNotes(g.current(), selectLessons(g.current(), '').always);
  await g.mind.idle();
  assert.deepEqual(g.mind.injectedNotes(g.current(), selectLessons(g.current(), '').always).preferences.map(row => row.text), ['x 偏好']);
});

// ------------------------------------------------------------------------------------------------ review of the D4 batch
const patchOf = (f, collection) => (id, input, labels = undefined) => f.store.mutate(state => { patchMindEntry(state.projects.find(row => row.id === f.project.id), collection, id, input, { now: f.clock.value, ...(labels ? { labels } : {}) }); });

test('D4 review 1: the user\'s own hand on a request is a sign of life, a deadline still ahead is never expired, and the failure text survives the end', async t => {
  const f = setup(t, { decisions: judges({ 'commitment.due': 'active' }) }), patch = patchOf(f, 'commitments');
  // A request the user reopens after it expired is not ended again by the next sweep.
  const old = add(f, { request: '半个月前的请求' });
  f.clock.value += 15 * DAY; f.mind.sweep();
  assert.deepEqual([f.row(old.id).status, f.row(old.id).reason], ['dismissed', 'expired']);
  patch(old.id, { status: 'pending' });
  assert.deepEqual([f.row(old.id).status, f.row(old.id).reason], ['pending', undefined], 'reopened: it is no longer "expired"');
  f.clock.value += 40000; f.mind.sweep();
  assert.equal(f.row(old.id).status, 'pending', 'the user just reopened it: the next sweep does not end it again');
  f.clock.value += 13 * DAY; f.mind.sweep(); assert.equal(f.row(old.id).status, 'pending');
  f.clock.value += 2 * DAY; f.mind.sweep(); assert.equal(f.row(old.id).status, 'dismissed', 'fourteen days from the user\'s hand it ends as before');
  // An old request the user edits is alive from that edit on.
  const g = setup(t, { decisions: judges({ 'commitment.due': 'active' }) }), edit = patchOf(g, 'commitments');
  const edited = add(g, { request: '旧请求' }), untouched = add(g, { request: '另一个旧请求' });
  g.clock.value += 12 * DAY; edit(edited.id, { request: '改过措辞的旧请求' });
  g.clock.value += 3 * DAY; g.mind.sweep();
  assert.equal(g.row(edited.id).status, 'pending', 'edited three days ago'); assert.equal(g.row(untouched.id).status, 'dismissed', 'nobody touched this one');
  // A deadline ahead (the user\'s own, from the mind API or moved there later) is not a request nobody touched; it counts from the day it falls due.
  const h = setup(t, { decisions: judges({ 'commitment.due': 'active' }) }), move = patchOf(h, 'commitments');
  const far = add(h, { request: '三十天后交', overdueAt: CLOCK + 30 * DAY }), moved = add(h, { request: '后来把期限改到四十天后' });
  h.clock.value += 10 * DAY; move(moved.id, { overdueAt: new Date(CLOCK + 40 * DAY).toISOString() });
  h.clock.value = CLOCK + 15 * DAY; h.mind.sweep();
  assert.deepEqual([h.row(far.id).status, h.row(moved.id).status], ['pending', 'pending'], 'both deadlines are still ahead');
  h.clock.value = CLOCK + 43 * DAY; h.mind.sweep();
  assert.deepEqual([h.row(far.id).status, h.row(moved.id).status], ['pending', 'pending'], 'thirteen days after the first one fell due');
  h.clock.value = CLOCK + 45 * DAY; h.mind.sweep();
  assert.deepEqual([h.row(far.id).status, h.row(moved.id).status], ['dismissed', 'pending'], 'fourteen days after it fell due, nobody having answered');
  // A request that failed keeps what failed when it ends, and gets it back when the user reopens it.
  const k = setup(t), reopen = patchOf(k, 'commitments');
  const failed = add(k, { request: '写第 14 章', trigger: 'failed_turn', reason: '本轮执行失败（provider_error）' });
  k.clock.value += 15 * DAY; k.mind.sweep();
  assert.deepEqual([k.row(failed.id).status, k.row(failed.id).reason, k.row(failed.id).expiredFrom], ['dismissed', 'expired', '本轮执行失败（provider_error）']);
  reopen(failed.id, { status: 'pending' });
  assert.deepEqual([k.row(failed.id).reason, k.row(failed.id).expiredFrom], ['本轮执行失败（provider_error）', undefined]);
  // The sign-of-life reading is one function for the gate and the end.
  assert.equal(lastLifeAt({ createdAt: new Date(CLOCK).toISOString(), editedBy: 'user', updatedAt: new Date(CLOCK + DAY).toISOString() }), CLOCK + DAY);
  assert.equal(lastLifeAt({ createdAt: new Date(CLOCK).toISOString(), updatedAt: new Date(CLOCK + DAY).toISOString() }), CLOCK, 'the host\'s own bookkeeping is not a sign of life');
});

test('D4 review 4: the gate pursues an overdue request until fourteen days after its last sign of life, the anchor the end uses', () => {
  const at = ms => new Date(CLOCK + ms).toISOString();
  // Made on day 0, carried on at day 12, judged due on day 15: due and alive, and so pursued.
  const row = { id: 'c1', status: 'pending', trigger: 'user_request', request: 'x', createdAt: at(0), continuedAt: at(12 * DAY), overdueAt: at(15 * DAY), dueBy: 'judge' };
  assert.equal(pursuedOverdue({ commitments: [row] }, { now: CLOCK + 16 * DAY }).length, 1, 'fifteen days after it was made, one day after it fell due');
  assert.deepEqual(expiredCommitments({ commitments: [row] }, CLOCK + 16 * DAY), [], 'and not ended: one anchor');
  assert.equal(pursuedOverdue({ commitments: [row] }, { now: CLOCK + 15 * DAY + 14 * DAY - 1 }).length, 1);
  const end = CLOCK + 15 * DAY + 14 * DAY + 1;
  assert.equal(pursuedOverdue({ commitments: [row] }, { now: end }).length, 0, 'fourteen days after its last sign of life: no longer pursued');
  assert.deepEqual(expiredCommitments({ commitments: [row] }, end).map(entry => entry.id), ['c1'], 'and ended at the same moment');
  // A request nobody ever touched: pursued from when it fell due, ended fourteen days after (never "pursued" past its end).
  const plain = { id: 'c2', status: 'pending', createdAt: at(0), overdueAt: at(HOUR * 4), dueBy: 'default' };
  assert.equal(pursuedOverdue({ commitments: [plain] }, { now: CLOCK + 5 * DAY }).length, 1);
  assert.equal(pursuedOverdue({ commitments: [plain] }, { now: CLOCK + 4 * HOUR + 14 * DAY + 1 }).length, 0);
});

test('D4 review 2: the due judge meets every pending request in turn, not only the first six, even one that answers "wait" for ever', async t => {
  const asked = [];
  const f = setup(t, { decisions: judges({ 'commitment.due': 'active' }, { commitmentDue: async (_project, { commitments }) => { asked.push(commitments.map(row => row.request)); return { due: [], wait: commitments.map((_, index) => index) }; } }) });
  const names = Array.from({ length: 9 }, (_, index) => `请求 ${index}`);
  for (const request of names) add(f, { request });
  f.clock.value += HOUR;
  for (let round = 0; round < 3; round++) { await f.mind.checkDue(f.project.id); f.clock.value += 30 * 60000; }
  assert.deepEqual(asked[0], names.slice(0, 6));
  assert.deepEqual(asked[1], ['请求 6', '请求 7', '请求 8', '请求 0', '请求 1', '请求 2'], 'the ones the judge has not met come first, then the ones asked longest ago');
  assert.deepEqual(asked[2], ['请求 3', '请求 4', '请求 5', '请求 0', '请求 1', '请求 2'], 'then the three asked in the first round, which nobody has asked since');
  // A judge that answers neither way still counts as having been asked: it does not hold the first six for ever.
  const g = setup(t, { decisions: judges({ 'commitment.due': 'active' }, { commitmentDue: async (_project, { commitments }) => { asked.push(commitments.map(row => row.request)); return { due: [], wait: [] }; } }) });
  asked.length = 0; for (const request of names.slice(0, 7)) add(g, { request });
  g.clock.value += HOUR; await g.mind.checkDue(g.project.id); g.clock.value += 30 * 60000; await g.mind.checkDue(g.project.id);
  assert.equal(asked[1][0], '请求 6', 'the seventh is reached although the first six never got an answer');
  assert.deepEqual(asked[1], ['请求 6', '请求 0', '请求 1', '请求 2', '请求 3', '请求 4']); assert.equal(g.rows()[5].dueCheckedAt, new Date(CLOCK + HOUR).toISOString(), 'asked once, answer or none');
  // Asking again is the point of "wait": a request that was only ever asked once is asked again before the pile is passed over.
  const h = setup(t, { decisions: judges({ 'commitment.due': 'active' }, { commitmentDue: async () => ({ due: [0], wait: [] }) }) });
  const one = add(h); h.clock.value += HOUR; await h.mind.checkDue(h.project.id);
  assert.deepEqual([h.row(one.id).dueBy, h.row(one.id).dueCheckedAt], ['judge', new Date(h.clock.value).toISOString()]);
});

test('MIND-15 review 3: a label goes only to the judgment that decided the row, in the state it left it', async t => {
  let ledger = 0;
  const f = setup(t, { decisions: judges({ 'mind.judge': 'active' }, { mindJudge: async (_project, { candidate }) => candidate !== undefined ? null : ({ resolved: [], ledgerId: `K${++ledger}` }) }) }), patch = patchOf(f, 'commitments');
  const marked = (id, ledgerId = 'K1', question = 'resolved_0') => f.store.mutate(state => { Object.assign(ensureMind(state.projects.find(row => row.id === f.project.id)).commitments.find(row => row.id === id), { judgedLedgerId: ledgerId, judgedQuestion: question }); });
  const [a, b, c, d] = ['整理人物关系表', '检查前十章人名', '写章节摘要', '备份稿件'].map(request => add(f, { request }));
  // The judge read it and kept it pending; the turn's own verdict then settled it (another call's id on the resolution).
  const run = f.turn('人物关系表如何了？', { reply: '还在整理。' }); await f.mind.afterTurn({ sessionId: f.session.id, turnId: run.turnId });
  assert.equal(f.row(a.id).judgedLedgerId, 'K1');
  f.store.mutate(state => { resolveCommitments(ensureMind(state.projects.find(row => row.id === f.project.id)), [a.id], { by: { kind: 'turn', sessionId: f.session.id, turnId: run.turnId, ledgerId: 'S1' }, now: f.clock.value }); });
  assert.equal(f.row(a.id).judgedLedgerId, undefined, 'something other than the judge settled it: the judge\'s earlier "not yet" is not what the user will undo');
  let labels = []; patch(a.id, { status: 'pending' }, labels); assert.deepEqual(labels, [], 'reopening it undoes the turn verdict, not the mind judge');
  labels = []; patch(a.id, { status: 'resolved' }, labels); assert.deepEqual(labels, [], 'and settling it by hand afterwards is not a miss of a call that read an earlier state');
  // The judge settled it itself: that call is what the user undoes.
  f.store.mutate(state => { resolveCommitments(ensureMind(state.projects.find(row => row.id === f.project.id)), [b.id], { by: { kind: 'jev', ledgerId: 'K1' }, now: f.clock.value }); Object.assign(ensureMind(state.projects.find(row => row.id === f.project.id)).commitments.find(row => row.id === b.id), { judgedLedgerId: 'K1', judgedQuestion: 'resolved_1' }); });
  labels = []; patch(b.id, { status: 'pending' }, labels); assert.deepEqual(labels, [{ ledgerId: 'K1', label: 'resolved_wrong' }]);
  // The request was asked for again since the judge kept it pending: the call read an earlier ask.
  marked(c.id); f.store.mutate(state => restartWindow(ensureMind(state.projects.find(row => row.id === f.project.id)).commitments.find(row => row.id === c.id)));
  assert.deepEqual([f.row(c.id).judgedLedgerId, f.row(c.id).judgedQuestion], [undefined, undefined]);
  // It expired, the user reopened it, then settled it by hand: nothing the judge decided is still true of it.
  marked(d.id); f.clock.value += 15 * DAY; f.mind.sweep(); assert.equal(f.row(d.id).status, 'dismissed');
  labels = []; patch(d.id, { status: 'pending' }, labels); assert.deepEqual(labels, [], 'the call kept it pending; the end and the reopening were not its doing');
  labels = []; patch(d.id, { status: 'resolved' }, labels); assert.deepEqual(labels, []);
  // A plain status change always drops the marks (the judge's reading is of the row as it was).
  const e = add(f, { request: '另一件' }); marked(e.id, 'K9', 'resolved_2'); labels = []; patch(e.id, { status: 'dismissed' }, labels);
  assert.deepEqual([labels, f.row(e.id).judgedLedgerId], [[], undefined]);
  // Agenda: a work-outcome reopening is a new state too.
  f.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === f.project.id)); mind.agenda.push({ id: 'g1', kind: 'todo', text: '核对时间线', status: 'done', judgedLedgerId: 'K5', judgedQuestion: 'answered_0', resolvedBy: { kind: 'action', actionId: 'a1' }, createdAt: new Date(CLOCK).toISOString() }); applyWorkOutcomes(mind, [{ collection: 'agenda', id: 'g1', change: 'reopen', reopened: { reason: 'change_undone', actionId: 'a1' } }], { now: f.clock.value }); });
  const g1 = f.current().mind.agenda.find(row => row.id === 'g1'); assert.deepEqual([g1.status, g1.judgedLedgerId], ['open', undefined]);
  // The pure reading: wrong only when the call that decided is the one that closed the row; missed in both directions for a call that kept it open.
  assert.deepEqual(judgementLabels('commitments', { status: 'resolved', resolvedBy: { ledgerId: 'S1' }, judgedLedgerId: 'K1', judgedQuestion: 'resolved_0' }, { status: 'pending' }), []);
  assert.deepEqual(judgementLabels('agenda', { status: 'done', resolvedBy: { kind: 'capture' }, judgedLedgerId: 'K1', judgedQuestion: 'answered_0' }, { status: 'open' }), []);
  assert.deepEqual(judgementLabels('agenda', { status: 'dropped', resolvedBy: { kind: 'reconcile', ledgerId: 'K1' }, judgedLedgerId: 'K1', judgedQuestion: 'superseded_2' }, { status: 'open' }), [{ ledgerId: 'K1', label: 'superseded_wrong' }]);
  assert.deepEqual(judgementLabels('agenda', { status: 'open', judgedLedgerId: 'K2', judgedQuestion: 'answered_1' }, { status: 'done' }), [{ ledgerId: 'K2', label: 'answered_missed' }]);
  assert.deepEqual(judgementLabels('agenda', { status: 'open', judgedLedgerId: 'K2', judgedQuestion: 'answered_1' }, { status: 'dropped' }), [{ ledgerId: 'K2', label: 'superseded_missed' }], 'the same call also asked whether it was replaced');
  assert.deepEqual(judgementLabels('commitments', { status: 'pending', judgedLedgerId: 'K2', judgedQuestion: 'answered_1' }, { status: 'dismissed' }), [{ ledgerId: 'K2', label: 'superseded_missed' }]);
  assert.deepEqual(judgementLabels('commitments', { status: 'pending', judgedLedgerId: 'K2', judgedQuestion: 'resolved_1' }, { status: 'dismissed' }), [], 'the settle call never asked whether it was dropped');
});

test('MIND-5 review: a message is never joined to the request it itself made', async t => {
  const f = setup(t), empty = { outputs: [], threads: [], questions: [], requests: [] };
  // A failed turn made the message\'s own failed_turn row before the capture ran; no judge answered, and the text is its own text.
  const run = f.turn('明天把第 12 章写完发我', { status: 'failed' });
  await f.mind.afterTurn({ sessionId: f.session.id, turnId: run.turnId });
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].trigger, 'failed_turn');
  await f.mind.capture({ sessionId: f.session.id, turnId: run.turnId, route: null, input: empty });
  const [own] = f.rows(), item = f.sessionOf().items.find(row => row.id === run.userItemId);
  assert.equal(f.rows().length, 1); assert.deepEqual([own.continuedBy, own.continuedAt, own.evidence.length], [undefined, undefined, 1], 'no restarted window, no second piece of evidence');
  assert.equal(item.capture.continues, undefined, 'it does not continue itself');
  // The judge is offered the pending requests that are not this message\'s own, and a stale offer that holds it is not joined either.
  assert.deepEqual(f.mind.captureInput(f.sessionOf(), item).requests, []);
  const judge = setup(t, { decisions: judges() }), failed = judge.turn('把第 12 章写完发我', { status: 'failed' });
  await judge.mind.afterTurn({ sessionId: judge.session.id, turnId: failed.turnId });
  const own2 = judge.rows()[0];
  await judge.mind.capture({ sessionId: judge.session.id, turnId: failed.turnId, input: { ...empty, requests: [{ commitmentId: own2.id, text: own2.request }] }, route: { capture: { ...capture, pendingRequest: true, restates: 0 } } });
  assert.equal(judge.rows().length, 1); assert.equal(judge.row(own2.id).continuedBy, undefined);
});

test('D4 review: a preference note the user wrote is never dropped for an agent-learned paraphrase, and a cached "covered" answer is not used once the judge no longer acts', async t => {
  const modes = { 'mind.judge': 'active' };
  const f = setup(t, { decisions: judges(modes, { mindCovered: async (_project, { rows }) => ({ covered: rows.map((_, index) => index), ledgerId: 'C1' }) }) });
  f.store.mutate(state => {
    const mind = ensureMind(state.projects.find(row => row.id === f.project.id));
    addLesson(mind, { kind: 'preference', text: '行文要有活人感，别太生硬。', source: mindSource('user') }, { now: CLOCK });
    mergeNotes(mind, { preferences: ['写得别太僵硬，要像真人说话'] }, { now: CLOCK, source: mindSource('model') });
    mergeNotes(mind, { preferences: ['我希望文字读起来自然、不刻板'] }, { now: CLOCK, source: mindSource('user', { from: 'mind_api' }) });
    mergeNotes(mind, { preferences: ['行文要有活人感，别太生硬。'] }, { now: CLOCK + 1, source: mindSource('user', { from: 'mind_api' }) });
  });
  const texts = () => f.mind.injectedNotes(f.current(), selectLessons(f.current(), '').always).preferences.map(row => row.text);
  assert.deepEqual(f.mind.uncheckedNotes(f.current(), selectLessons(f.current(), '').always).map(row => row.text), ['写得别太僵硬，要像真人说话'], 'only the learned note is put to the judge: the user\'s own words are not');
  await f.mind.refreshCoverage(f.project.id);
  assert.deepEqual(texts(), ['我希望文字读起来自然、不刻板'], 'the learned paraphrase is covered; the user\'s own note stays unless it is the rule word for word');
  // The judge stops acting (shadow): what it once answered is not read any more.
  modes['mind.judge'] = 'shadow';
  assert.deepEqual(texts(), ['写得别太僵硬，要像真人说话', '我希望文字读起来自然、不刻板'], 'a cached answer of a judge that no longer acts changes nothing');
});

test('D4 review: the mind page shows where a request is in its lifecycle', () => {
  const at = ms => new Date(CLOCK + ms).toISOString();
  const project = { id: 'p', mind: { schemaVersion: 1, lessons: [], agenda: [], threads: [], notes: { facts: [], preferences: [] }, commitments: [
    { id: 'open', status: 'pending', request: 'a', createdAt: at(0) }, { id: 'due', status: 'pending', request: 'b', createdAt: at(0), overdueAt: at(HOUR) },
    { id: 'wait', status: 'pending', request: 'c', createdAt: at(0), waitingOnUser: { at: at(0) } }, { id: 'gone', status: 'dismissed', reason: 'expired', request: 'd', createdAt: at(0) }] } };
  const view = publicMind(project, { now: CLOCK + 2 * HOUR, status: 'all' });
  assert.deepEqual(view.commitments.map(row => [row.id, row.phase]), [['open', 'open'], ['due', 'due'], ['wait', 'waiting_user'], ['gone', 'expired']]);
});

test('D4 review: a request is left unowed only by the confident reading of "waiting on the user"; the medium one keeps it owed', async t => {
  const f = setup(t), sure = f.turn('按新大纲重写第 12 章', { reply: '新大纲里 A 和 B 冲突，你选哪个？', verdict: { waiting: true, waitingForUser: true, complete: false, finished: false } });
  const doubtful = f.turn('把第 13 章也改了', { reply: '可能需要你确认一下人名，确认后我继续。', verdict: { waiting: true, waitingForUser: null, complete: false, finished: false } });
  const ref = run => mindSource('capture', { sessionId: f.session.id, itemId: run.userItemId, turnId: run.turnId });
  const a = add(f, { request: '按新大纲重写第 12 章', source: ref(sure) }), b = add(f, { request: '把第 13 章也改了', source: ref(doubtful) });
  await f.mind.afterTurn({ sessionId: f.session.id, turnId: sure.turnId }); await f.mind.afterTurn({ sessionId: f.session.id, turnId: doubtful.turnId });
  assert.equal(f.row(a.id).waitingOnUser.turnId, sure.turnId); assert.equal(f.row(b.id).waitingOnUser, undefined, 'a doubtful "waiting" hides nothing');
});

test('MIND-15 review: a row dropped for capacity carries no judgment: reopening it labels nothing', async t => {
  const f = setup(t), first = add(f, { request: '最早的请求' });
  f.store.mutate(state => { Object.assign(ensureMind(state.projects.find(row => row.id === f.project.id)).commitments.find(row => row.id === first.id), { judgedLedgerId: 'K1', judgedQuestion: 'resolved_0' }); });
  for (let index = 0; index < 50; index++) add(f, { request: `请求 ${index}` });
  assert.deepEqual([f.row(first.id)?.status, f.row(first.id)?.reason, f.row(first.id)?.judgedLedgerId], ['dismissed', 'capacity', undefined], 'the cap dismissed the oldest');
  const labels = []; f.store.mutate(state => { patchMindEntry(state.projects.find(row => row.id === f.project.id), 'commitments', first.id, { status: 'pending' }, { now: f.clock.value, labels }); });
  assert.deepEqual(labels, []);
  // The same for the plan's agenda.
  f.store.mutate(state => {
    const mind = ensureMind(state.projects.find(row => row.id === f.project.id)), old = addAgenda(mind, { kind: 'todo', text: '最早的事项' }, { now: CLOCK });
    Object.assign(old, { judgedLedgerId: 'K2', judgedQuestion: 'answered_0' });
    for (let index = 0; index < 40; index++) addAgenda(mind, { kind: 'todo', text: `事项 ${index}` }, { now: CLOCK + 1 });
  });
  const dropped = f.current().mind.agenda.find(row => row.text === '最早的事项');
  assert.deepEqual([dropped.status, dropped.reason, dropped.judgedLedgerId], ['dropped', 'capacity', undefined]);
});

test('D4 review: an answer the judge gave about a note the assistant learned does not hide the same words once the user wrote them themselves', async t => {
  const f = setup(t, { decisions: judges({ 'mind.judge': 'active' }, { mindCovered: async (_project, { rows }) => ({ covered: rows.map((_, index) => index), ledgerId: 'C1' }) }) });
  let learned;
  f.store.mutate(state => {
    const mind = ensureMind(state.projects.find(row => row.id === f.project.id));
    addLesson(mind, { kind: 'preference', text: '行文要有活人感，别太生硬。', source: mindSource('user') }, { now: CLOCK });
    mergeNotes(mind, { preferences: ['写得别太僵硬，要像真人说话'] }, { now: CLOCK, source: mindSource('model') }); learned = mind.notes.preferences[0].id;
  });
  const always = () => selectLessons(f.current(), '').always, texts = () => f.mind.injectedNotes(f.current(), always()).preferences.map(row => row.text);
  await f.mind.refreshCoverage(f.project.id);
  assert.deepEqual(texts(), [], 'the learned paraphrase is covered');
  // The user deletes it and writes the very same words themselves: the cached answer was about the assistant\'s note.
  f.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === f.project.id)); mind.notes.preferences = mind.notes.preferences.filter(row => row.id !== learned); mergeNotes(mind, { preferences: ['写得别太僵硬，要像真人说话'] }, { now: CLOCK + 1000, source: mindSource('user', { from: 'mind_api' }) }); });
  assert.deepEqual(texts(), ['写得别太僵硬，要像真人说话'], 'the user\'s own note is their word, whatever was once answered about the same text');
});
