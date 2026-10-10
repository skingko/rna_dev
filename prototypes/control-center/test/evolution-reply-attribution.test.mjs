import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stream, GUARD_ANSWER, setup, keepsRule } from './helpers/gene-fixture.mjs';
import { createMindEntry } from '../project-mind.mjs';
import { GUARD_AUTHOR_SYSTEM, PATCH_AUTHOR_SYSTEM } from '../gene-evolution-service.mjs';

// P2 batch C3 (EVO-2; plan §2.3 #2): evolution credits what a user message says (a correction, an approval) to the turn or
// the run the message is about, not to the turn before it. headlong reply_to. A correction to a scheduled report used to be
// counted against whatever foreground turn came before it. Judges and models are stubs.
const REPORT = '每日报告：今天核对了 7 个来源，其中 2 个没有找到原文。', TASK = '核对资料来源并写每日报告。';
const PATCH_ANSWER = { skillId: 'project-workflow', title: '先核对报告数字', summary: '报告里的数字写之前先和来源核对。', section: '- 报告里每个数字都要能在来源里找到。\n- 写完报告后再核对一遍数字。', when: '写报告', expectation: '数字不再出错' };

async function withGuard(t) {
  const f = await setup(t, (input, res) => {
    const system = input.messages.find(row => row.role === 'system')?.content ?? '';
    if (system.includes(GUARD_AUTHOR_SYSTEM.slice(0, 60))) return stream(res, JSON.stringify(GUARD_ANSWER));
    if (system.includes(PATCH_AUTHOR_SYSTEM.slice(0, 60))) return stream(res, JSON.stringify(PATCH_ANSWER));
    stream(res, 'ok');
  });
  f.app.genes.enabled = true;
  let lessonId;
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); lessonId = createMindEntry(project, 'lessons', { text: '正文里不得出现“守夜”字样。', kind: 'constraint' }).id; });
  f.app.genes.decisions = { geneRoute: async () => ({ guard: true, everyWrite: true, method: false }), geneReview: async () => ({ pass: true, problems: [] }) };
  keepsRule(f.workspace);
  assert.equal((await f.app.genes.routeLesson(f.current(), f.current().mind.lessons.find(row => row.id === lessonId))).outcome, 'active');
  const guard = () => f.current().genes.genes.find(row => row.id === 'guard:guard_nightwatch');
  const conversation = () => f.app.store.state.sessions.find(row => row.id === f.session.id);
  // A foreground turn (request, reply); the guard ran on its writes (it is a rule "used" in it).
  const turn = (text, { used = false, capture = null } = {}) => {
    const turnId = randomUUID(), userItemId = randomUUID(), replyId = randomUUID(), at = new Date().toISOString();
    f.app.store.mutate(state => { const s = state.sessions.find(row => row.id === f.session.id); s.turns.push({ id: turnId, status: 'completed', userItemId, createdAt: at, completedAt: at, modelConfig: { execution: 'rna' }, simulated: false }); s.items.push({ id: userItemId, turnId, kind: 'user', text, createdAt: at, simulated: false, ...(capture ? { capture } : {}) }); s.items.push({ id: replyId, turnId, kind: 'assistant', text: `回复：${text}`, final: true, createdAt: at, simulated: false }); });
    if (used) f.app.genes.genes.record(f.project.id, 'guard:guard_nightwatch', row => { row.turns = [...(row.turns ?? []), turnId]; });
    return { turnId, userItemId, replyId };
  };
  // A scheduled report delivered into the conversation: no turn, an action id and its schedule.
  const report = ({ scheduleId = 'sch1' } = {}) => {
    const id = randomUUID(), at = new Date().toISOString();
    f.app.store.mutate(state => {
      const target = state.projects.find(row => row.id === f.project.id); target.schedules = [...(target.schedules ?? []), { id: scheduleId, title: '每日报告', task: TASK }];
      state.sessions.find(row => row.id === f.session.id).items.push({ id, turnId: null, kind: 'assistant', text: REPORT, createdAt: at, simulated: false, source: 'initiative', initiativeActionId: 'act-run-1', scheduleId, scheduleOccurrenceKey: `${scheduleId}:2026-10-05T02:00:00.000Z`, initiative: { kind: 'scheduled', reach: 'inline' } });
    });
    return id;
  };
  const labels = []; f.app.genes.decisions.labelDecision = (id, label) => { labels.push([id, label]); return true; };
  return { ...f, guard, conversation, turn, report, labels };
}
const target = itemId => ({ kind: 'output', itemId });

test('subjectOf: the turn a message targets, the run, something else, or by order when nothing was said', async t => {
  const f = await withGuard(t);
  const first = f.turn('写第 1 章'), second = f.turn('写第 2 章'), reportId = f.report();
  const session = f.conversation(), previous = session.turns.find(row => row.id === second.turnId), subject = (message, prev = previous) => f.app.genes.subjectOf(session, message, prev);
  assert.deepEqual([subject({}).kind, subject({}).turn.id, subject({}).by], ['turn', second.turnId, 'order'], 'no capture: the order rule');
  assert.equal(subject({ capture: { target: target(first.replyId), targetSource: 'heuristic' } }).by, 'order', 'the regex fallback names nothing');
  assert.equal(subject({ capture: { target: null, targetSource: 'jev' } }).by, 'order', 'JEV is sure it reacts to nothing earlier: nothing says which turn it corrects, the order rule stands');
  const older = subject({ capture: { target: target(first.replyId), targetSource: 'jev' } });
  assert.deepEqual([older.kind, older.turn.id, older.by, older.source], ['turn', first.turnId, 'capture', 'jev'], 'an older turn\'s reply');
  const run = subject({ capture: { target: target(reportId), targetSource: 'fast_model' } });
  assert.deepEqual([run.kind, run.actionId, run.scheduleId, run.itemId, run.by], ['run', 'act-run-1', 'sch1', reportId, 'capture']);
  assert.equal(run.occurrenceKey, 'sch1:2026-10-05T02:00:00.000Z');
  const focused = subject({ replyTo: { source: 'jev', itemId: reportId, kind: 'delivery' }, capture: { target: target(first.replyId), targetSource: 'jev' } });
  assert.deepEqual([focused.kind, focused.by], ['run', 'reply.target'], 'the focused question outranks the capture');
  assert.equal(subject({ capture: { target: target('gone'), targetSource: 'jev' } }).kind, 'other', 'an item that is not there');
  assert.equal(subject({ replyTo: { source: 'jev', itemId: first.replyId, kind: 'latest_reply' } }).turn.id, first.turnId);
});

test('EVO-2 (the acceptance): a correction to a scheduled report is credited to its run; the foreground turn before it keeps its rules uncorrected', async t => {
  const f = await withGuard(t);
  const judged = [];
  f.app.genes.decisions.mindJudge = async (_project, input) => { judged.push(input); return { same: [0], contradicts: [], applies: [], resolved: [] }; };
  const reviews = [];
  f.app.genes.decisions.turnReview = async (_project, input) => { reviews.push(input); return { review: false }; };
  const first = f.turn('写第 3 章', { used: true }), reportId = f.report();
  const text = '这个报告里的数字不对，应该是 9 个来源', record = { correction: true, target: target(reportId), targetSource: 'jev' }, correcting = f.turn(text, { capture: record });
  const outcome = await f.app.genes.afterCapture({ projectId: f.project.id, sessionId: f.session.id, turnId: correcting.turnId, record, text, targetText: REPORT });
  assert.equal(outcome.subject, 'run'); assert.equal(outcome.used, 0, 'the foreground turn\'s guard is not the report\'s');
  assert.deepEqual(judged, [], 'so no rule is judged against the correction');
  assert.equal(f.guard().stats?.missed ?? 0, 0, 'before C3 the guard was "corrected on the same point" by a message about a report');
  assert.equal(f.current().genes.funnel.B.credited_run, 1);
  // Lane B reviews the report it was about: the schedule's task is the request, the delivered report the reply.
  const [row] = f.current().genes.reviews;
  assert.deepEqual([row.turnId, row.targetItemId, row.run.scheduleId, row.run.actionId], [null, reportId, 'sch1', 'act-run-1']);
  assert.equal(row.reply, undefined, 'the report is read from the conversation when it is reviewed');
  await f.app.genes.jobs.shift()();
  assert.deepEqual([reviews[0].request, reviews[0].reply, reviews[0].correction], [TASK, REPORT, text], 'not the foreground request');
  assert.equal(first.turnId === row.turnId, false);
  // Lane C: the run is the corrected one; the foreground turn has no outcome (nobody reacted to it).
  const outcomes = f.app.genes.contrastOutcomes(f.current());
  assert.deepEqual(outcomes.map(item => [item.outcome, item.run?.scheduleId ?? null, item.source.turnId ?? null]), [['corrected', 'sch1', null]], 'before C3: the foreground turn, corrected');
  assert.deepEqual([outcomes[0].request, outcomes[0].reply, outcomes[0].correction], [TASK, REPORT, text]);
  assert.deepEqual(outcomes[0].source.itemId, correcting.userItemId, 'the quote is the user\'s message: deleting it takes the quote off the rule');
});

test('a correction that names an older turn is credited to that turn, with the in-between turn left unjudged', async t => {
  const f = await withGuard(t);
  f.app.genes.decisions.mindJudge = async () => ({ same: [0], contradicts: [], applies: [], resolved: [] });
  f.app.genes.decisions.turnReview = async () => ({ review: false });
  const first = f.turn('写第 1 章', { used: true }); f.turn('写第 2 章');
  const text = '第一章里的人名不对', record = { correction: true, target: target(first.replyId), targetSource: 'jev' }, third = f.turn(text, { capture: record });
  const outcome = await f.app.genes.afterCapture({ projectId: f.project.id, sessionId: f.session.id, turnId: third.turnId, record, text });
  assert.deepEqual(outcome.missed, ['guard:guard_nightwatch'], 'the first turn\'s rule was corrected on the same point'); assert.equal(outcome.creditedTurn, first.turnId);
  assert.equal(f.current().genes.funnel.B.credited_other_turn, 1);
  assert.equal(f.current().genes.reviews[0].turnId, first.turnId); assert.equal(f.current().genes.reviews[0].targetItemId, first.replyId);
  // Lane C: the first turn was corrected by the third message; the second was not reacted to (before C3: "accepted" by the third).
  const outcomes = f.app.genes.contrastOutcomes(f.current());
  assert.deepEqual(outcomes.map(item => [item.source.turnId, item.outcome]), [[first.turnId, 'corrected']]);
});

test('without a named target nothing changes: the previous turn is credited, as before', async t => {
  const f = await withGuard(t);
  f.app.genes.decisions.mindJudge = async () => ({ same: [0], contradicts: [], applies: [], resolved: [] });
  f.app.genes.decisions.turnReview = async () => ({ review: false });
  const previous = [];
  for (const [index, record] of [{ correction: true }, { correction: true, target: target('x'), targetSource: 'heuristic' }, { correction: true, target: null, targetSource: 'jev' }].entries()) {
    const before = f.turn(`写第 ${index + 1} 章`, { used: true }), text = `人名又不对了 ${index}`, next = f.turn(text, { capture: record });
    const outcome = await f.app.genes.afterCapture({ projectId: f.project.id, sessionId: f.session.id, turnId: next.turnId, record, text });
    assert.deepEqual(outcome.missed, ['guard:guard_nightwatch'], JSON.stringify(record)); assert.equal(outcome.creditedTurn, undefined); assert.equal(outcome.subject, undefined);
    previous.push(before.turnId);
  }
  assert.equal(f.current().genes.reviews.every(row => row.run === undefined && previous.includes(row.turnId)), true, 'every review is of the turn before the message');
  const outcomes = f.app.genes.contrastOutcomes(f.current());
  assert.deepEqual(previous.map(id => outcomes.find(item => item.source.turnId === id)?.outcome), ['corrected', 'corrected', 'corrected'], 'lane C reads them by order');
});

test('an approval of a delivered report is the run\'s outcome; a message that is neither says nothing about it', async t => {
  const f = await withGuard(t);
  const reportId = f.report(), liked = f.turn('这个报告很好', { capture: { approval: true, correction: false, target: target(reportId), targetSource: 'jev' } });
  f.turn('另外，写第 5 章', { capture: { approval: false, correction: false, target: target(reportId), targetSource: 'jev' } });
  const outcomes = f.app.genes.contrastOutcomes(f.current());
  assert.deepEqual(outcomes.map(item => [item.outcome, item.run?.scheduleId]), [['approved', 'sch1']]);
  // A thumbs-up on the report credits no foreground turn's rules (it would have counted the turn before as accepted).
  const outcome = await f.app.genes.afterCapture({ projectId: f.project.id, sessionId: f.session.id, turnId: liked.turnId, record: { correction: false, approval: true, target: target(reportId), targetSource: 'jev' }, text: '这个报告很好' });
  assert.equal(outcome.used, 0);
});

test('a review of a delivery whose schedule is gone still reads the report; one whose report is deleted goes with it', async t => {
  const f = await withGuard(t);
  f.app.genes.decisions.turnReview = async () => ({ review: false });
  const reportId = f.report(), text = '数字不对', message = f.turn(text);
  await f.app.genes.afterCapture({ projectId: f.project.id, sessionId: f.session.id, turnId: message.turnId, record: { correction: true, target: target(reportId), targetSource: 'jev' }, text });
  const [row] = f.current().genes.reviews;
  f.app.store.mutate(state => { state.projects.find(item => item.id === f.project.id).schedules = []; });
  assert.deepEqual([f.app.genes.reviewTexts(row).request, f.app.genes.reviewTexts(row).reply], ['', REPORT]);
  f.app.store.mutate(state => { const items = state.sessions.find(item => item.id === f.session.id).items; items.splice(items.findIndex(item => item.id === reportId), 1); });
  assert.equal(f.app.genes.reviewTexts(row), null, 'its source is gone: the review is dropped when it comes up');
});

test('MIND-12 (lane C): a reacting message JEV could not call a correction or not gives no outcome, an approval it carried included', async t => {
  // A turn: the message after it is an approval whose correction is unknown (null). Before this was read as "approved".
  const f = await withGuard(t);
  const first = f.turn('写第 1 章'), second = f.turn('不错', { capture: { correction: null, approval: true } });
  assert.deepEqual(f.app.genes.contrastOutcomes(f.current()), [], 'neither a clean turn nor an approved one: unknown');
  // A message that is clearly not a correction and approves is the turn's approval, and one that says neither is an acceptance.
  f.app.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).items.find(row => row.id === second.userItemId).capture = { correction: false, approval: true }; });
  assert.deepEqual(f.app.genes.contrastOutcomes(f.current()).map(item => [item.source.turnId, item.outcome]), [[first.turnId, 'approved']]);
  f.app.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).items.find(row => row.id === second.userItemId).capture = { correction: false, approval: false }; });
  assert.deepEqual(f.app.genes.contrastOutcomes(f.current()).map(item => [item.source.turnId, item.outcome]), [[first.turnId, 'accepted']]);
  // A run: the same message about a delivered report is the run's outcome only when its correction is known.
  const g = await withGuard(t);
  const reportId = g.report(), liked = g.turn('这个报告不错', { capture: { correction: null, approval: true, target: target(reportId), targetSource: 'jev' } });
  assert.deepEqual(g.app.genes.contrastOutcomes(g.current()), [], 'unknown: no run row either');
  g.app.store.mutate(state => { state.sessions.find(row => row.id === g.session.id).items.find(row => row.id === liked.userItemId).capture.correction = false; });
  assert.deepEqual(g.app.genes.contrastOutcomes(g.current()).map(item => [item.outcome, item.run?.scheduleId]), [['approved', 'sch1']]);
});
