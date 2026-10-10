import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../store.mjs';
import { ProjectMindService, ensureMind, addCommitment, addLesson, updatePlan, planView, stalledPlanItems, agentPromises, turnJudgedFinished, settledRequests, mindSource, MIND_SETTLE_RETRY_MS } from '../project-mind.mjs';
import { InvitationService } from '../session-invitations.mjs';
import { SessionSuggestions } from '../session-suggestions.mjs';
import { ProjectScheduleService, readableScheduleReceipt, scheduleReceiptsView } from '../project-schedule-service.mjs';
import { createMindRoutes } from '../mind-routes.mjs';

// UX audit 2026-10-03, team mind: commitments, invitations, the plan and schedule text. No model, no JEV, no network:
// judges are plain functions and the decision ledger rows are written by hand.
const CLOCK = Date.parse('2026-10-03T01:29:00Z');
function setup(t, { decisions = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-ux-mind-')), store = new Store(join(dir, 'state.json')), clock = { value: CLOCK };
  const { project, session } = store.createProject({ name: 'AI 应用调研', workspace: dir });
  store.mutate(state => { Object.assign(state.projects.find(row => row.id === project.id), { simulated: false, decisionMode: 'rna-model', initialization: { status: 'ready' } }); state.sessions.find(row => row.id === session.id).simulated = false; });
  const mind = new ProjectMindService(store, { decisions, provider: null, now: () => clock.value, sweepIntervalMs: 0, notesIntervalMs: 3600000 });
  t.after(async () => { await mind.close(); rmSync(dir, { recursive: true, force: true }); });
  const current = () => store.state.projects.find(row => row.id === project.id), sessionOf = () => store.state.sessions.find(row => row.id === session.id);
  const turn = (text, { reply, status = 'completed' } = {}) => {
    const ids = { turnId: randomUUID(), userItemId: randomUUID() }, at = new Date(clock.value).toISOString();
    store.mutate(state => { const s = state.sessions.find(row => row.id === session.id);
      s.turns.push({ id: ids.turnId, status, userItemId: ids.userItemId, createdAt: at, completedAt: at, modelConfig: { execution: 'rna' }, simulated: false });
      s.items.push({ id: ids.userItemId, turnId: ids.turnId, kind: 'user', text, createdAt: at, simulated: false });
      if (reply) s.items.push({ id: randomUUID(), turnId: ids.turnId, kind: 'assistant', text: reply, final: true, simulated: false, createdAt: at }); });
    return ids;
  };
  const settledVerdict = (turnId, complete, deferred = .1) => store.mutate(state => {
    const runtime = state.decisionKernelRuntime ??= { metrics: {}, recent: [] };
    runtime.recent.push({ id: `L-${turnId.slice(0, 6)}`, point: 'turn.settled', source: 'judge', mode: 'active', backend: 'typesafe', scope: { projectId: project.id, sessionId: session.id, turnId },
      answers: { instruction_complete: { type: 'boolean', probability: complete }, deferred_without_cause: { type: 'boolean', probability: deferred } } });
  });
  return { dir, store, mind, project, session, current, sessionOf, turn, clock, settledVerdict };
}
const pending = f => f.current().mind.commitments.filter(row => row.status === 'pending');
const JEV_STANDING_RULE = { isCorrection: false, isPreference: true, isApproval: false, pendingRequest: true, selfImprovement: false, durable: 'durable' };

test('a standing rule judged a durable preference becomes a lesson, never a request owed within four hours (F81)', async t => {
  const f = setup(t);
  const rule = f.turn('https://github.com/advisories 后续 github 安全报告只报告最严重的等级', { reply: '已更新后续日报规则：只报 Critical。' });
  await f.mind.capture({ sessionId: f.session.id, turnId: rule.turnId, route: { capture: JEV_STANDING_RULE } });
  assert.equal(pending(f).length, 0, 'no commitment: the rule is followed from now on, not owed once');
  assert.ok(f.current().mind.lessons.some(row => row.status === 'active' && /最严重的等级/.test(row.text)), 'kept as a lesson');
  // The same words read only by the wording fallback stay a request: a weak "preference" never drops a real request.
  const weak = f.turn('后续每次跑完全部测试后告诉我结果', { reply: '好的。' });
  await f.mind.capture({ sessionId: f.session.id, turnId: weak.turnId });
  assert.equal(pending(f).length, 1);
});

test('a request the same turn finished (turn.settled: complete) is settled with the turn; an unsure verdict leaves it to the mind judge (F42)', async t => {
  const calls = [];
  const f = setup(t, { decisions: { enabled: () => true, mindJudge: async (_project, input) => { calls.push(input.commitments.map(row => row.request)); return { resolved: [], same: [], contradicts: [], applies: [], notApplies: [], ledgerId: 'J1' }; } } });
  const done = f.turn('跑完全部测试后告诉我结果', { reply: '全部 212 个测试通过。' });
  await f.mind.capture({ sessionId: f.session.id, turnId: done.turnId, route: { capture: { pendingRequest: true, isPreference: false } } });
  assert.equal(pending(f).length, 1);
  f.settledVerdict(done.turnId, .95);
  assert.deepEqual(turnJudgedFinished(f.store.state, done.turnId), { ledgerId: `L-${done.turnId.slice(0, 6)}` });
  await f.mind.afterTurn({ sessionId: f.session.id, turnId: done.turnId });
  const row = f.current().mind.commitments.find(entry => entry.source?.turnId === done.turnId);
  assert.equal(row.status, 'resolved'); assert.equal(row.resolvedBy.kind, 'turn'); assert.equal(row.resolvedBy.ledgerId, `L-${done.turnId.slice(0, 6)}`);
  assert.equal(calls.length, 0, 'nothing left pending: no mind judge call');
  assert.ok(f.sessionOf().turns.find(entry => entry.id === done.turnId).mindSettledAt);
  // Not confidently complete (or postponed without cause): the request stays and the mind judge reads the turn.
  const unsure = f.turn('明天跑完回归后告诉我', { reply: '好的，明天跑。' });
  await f.mind.capture({ sessionId: f.session.id, turnId: unsure.turnId, route: { capture: { pendingRequest: true, isPreference: false } } });
  f.settledVerdict(unsure.turnId, .95, .9);
  assert.equal(turnJudgedFinished(f.store.state, unsure.turnId), null);
  await f.mind.afterTurn({ sessionId: f.session.id, turnId: unsure.turnId });
  assert.equal(pending(f).length, 1); assert.equal(calls.length, 1);
});

test('a turn is marked read by the mind only once the mind judge answered; a failed call is retried by catch-up, then given up (F42)', async t => {
  let answer = null, calls = 0;
  const f = setup(t, { decisions: { enabled: () => true, mindJudge: async () => { calls++; if (answer instanceof Error) throw answer; return answer; } } });
  f.store.mutate(state => { addCommitment(ensureMind(state.projects.find(row => row.id === f.project.id)), { request: '整理第三卷大纲', overdueAt: CLOCK + 3600000 }, { now: CLOCK - 60000 }); });
  const later = f.turn('第三卷大纲整理好了吗', { reply: '第三卷大纲已整理完成。' });
  const settledAt = () => f.sessionOf().turns.find(row => row.id === later.turnId).mindSettledAt;
  answer = new Error('jev unavailable');
  await f.mind.afterTurn({ sessionId: f.session.id, turnId: later.turnId });
  assert.equal(settledAt(), undefined, 'a failed judge call does not count as read');
  await f.mind.catchUp(f.project.id, { since: 0 });
  assert.equal(calls, 1, 'catch-up waits before trying again');
  f.clock.value += MIND_SETTLE_RETRY_MS + 1;
  answer = { resolved: [0], same: [], contradicts: [], applies: [], notApplies: [], ledgerId: 'J2' };
  await f.mind.catchUp(f.project.id, { since: 0 });
  assert.equal(calls, 2); assert.ok(settledAt()); assert.equal(pending(f).length, 0);
  // A judge that keeps failing: the turn is left as read after the last attempt (its request stays pending).
  f.store.mutate(state => { addCommitment(ensureMind(state.projects.find(row => row.id === f.project.id)), { request: '补人物表', overdueAt: CLOCK + 3600000 }, { now: f.clock.value - 60000 }); });
  const again = f.turn('人物表呢', { reply: '还在整理。' });
  answer = null;
  for (let index = 0; index < 3; index++) { await f.mind.catchUp(f.project.id, { since: 0 }); f.clock.value += MIND_SETTLE_RETRY_MS + 1; }
  assert.ok(f.sessionOf().turns.find(row => row.id === again.turnId).mindSettledAt);
  assert.equal(pending(f).length, 1);
  // No judge configured: read at once, no call.
  const quiet = setup(t, { decisions: { enabled: () => false, mindJudge: async () => { throw new Error('must not be called'); } } });
  quiet.store.mutate(state => { addCommitment(ensureMind(state.projects.find(row => row.id === quiet.project.id)), { request: '补人物表' }); });
  const turn = quiet.turn('继续', { reply: '好的。' });
  await quiet.mind.afterTurn({ sessionId: quiet.session.id, turnId: turn.turnId });
  assert.ok(quiet.sessionOf().turns.find(row => row.id === turn.turnId).mindSettledAt);
});

test('a retried judgment reads only what was owed when its turn ended; in shadow mode the turn is read after its one call (F42)', async t => {
  let calls = [], answer = null;
  const decisions = { enabled: () => true, config: () => ({ modes: { 'mind.judge': 'active' } }), mindJudge: async (_project, input) => { calls.push(input.commitments.map(row => row.request)); return answer; } };
  const f = setup(t, { decisions });
  f.store.mutate(state => { addCommitment(ensureMind(state.projects.find(row => row.id === f.project.id)), { request: '导出 X 报表', overdueAt: CLOCK + 3600000 }, { now: CLOCK - 60000 }); });
  const a = f.turn('X 报表呢', { reply: 'X 已完成。' });
  await f.mind.afterTurn({ sessionId: f.session.id, turnId: a.turnId });
  assert.deepEqual(calls, [['导出 X 报表']]);
  // Before the retry, the user asks for X again: turn A's old reply must not settle that new request.
  f.clock.value += MIND_SETTLE_RETRY_MS + 1;
  f.store.mutate(state => { addCommitment(ensureMind(state.projects.find(row => row.id === f.project.id)), { request: '再导出一次 X 报表', overdueAt: f.clock.value + 3600000 }, { now: f.clock.value }); });
  answer = { resolved: [0], same: [], contradicts: [], applies: [], notApplies: [], ledgerId: 'J9' };
  await f.mind.catchUp(f.project.id, { since: 0 });
  assert.deepEqual(calls[1], ['导出 X 报表'], 'the retry is asked about what turn A owed');
  assert.deepEqual(pending(f).map(row => row.request), ['再导出一次 X 报表']);
  // Shadow mode: the judge's answer is never acted on, so the turn is read after its one call (no retries).
  const shadow = setup(t, { decisions: { ...decisions, config: () => ({ modes: { 'mind.judge': 'shadow' } }), mindJudge: async () => { calls.push('shadow'); return null; } } });
  shadow.store.mutate(state => { addCommitment(ensureMind(state.projects.find(row => row.id === shadow.project.id)), { request: '补人物表' }, { now: CLOCK - 60000 }); });
  const turn = shadow.turn('人物表呢', { reply: '还在整理。' });
  calls = [];
  await shadow.mind.afterTurn({ sessionId: shadow.session.id, turnId: turn.turnId });
  assert.deepEqual(calls, ['shadow']); assert.ok(shadow.sessionOf().turns.find(row => row.id === turn.turnId).mindSettledAt);
  assert.equal(pending(shadow).length, 1);
});

test('a reply line ending in a colon only introduces what follows; it is not recorded as a promise (F19)', () => {
  assert.deepEqual(agentPromises('完成后会送达本轮，届时我会：\n1. 汇总结果\n2. 标出风险'), []);
  assert.deepEqual(agentPromises('稍后我会补充移动端的适配测试。'), ['稍后我会补充移动端的适配测试。']);
});

test('commitment invitations say whose words they are; carrying on an agent promise is not posted as the user\'s old request (C-f, F19)', async t => {
  const f = setup(t), posted = [];
  const inv = new InvitationService(f.store, { mind: { discussionSession: () => f.sessionOf() }, now: () => CLOCK });
  inv.post = (sessionId, text, extra = {}) => posted.push({ sessionId, text, ...extra });
  let promise, request;
  f.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === f.project.id));
    promise = addCommitment(mind, { request: '稍后我会补充移动端的适配测试。', trigger: 'agent_promise', overdueAt: CLOCK - 120000 }).id;
    request = addCommitment(mind, { request: '整理第三卷大纲', trigger: 'failed_turn', overdueAt: CLOCK - 60000 }).id; });
  assert.equal(inv.askOverdue(f.project.id).offered, 2);
  const cards = f.sessionOf().invitations.filter(row => row.kind === 'commitment');
  assert.deepEqual(cards.map(row => [row.commitmentId, row.trigger]), [[promise, 'agent_promise'], [request, 'user_request']]);
  await inv.act(f.session.id, cards[0].id, { action: 'answer', choice: 'continue' });
  await inv.act(f.session.id, cards[1].id, { action: 'answer', choice: 'continue' });
  assert.deepEqual(posted.map(row => row.text), ['接着完成你之前说要做的：稍后我会补充移动端的适配测试。', '接着完成：整理第三卷大纲']);
});

test('carrying on work whose record a scope change revoked uses its job or the card, never the placeholder; with neither, the card closes with a reason (F41, F83)', async t => {
  const f = setup(t), posted = [];
  const inv = new InvitationService(f.store, { mind: { discussionSession: () => f.sessionOf() }, now: () => CLOCK });
  inv.post = (sessionId, text, extra = {}) => posted.push({ sessionId, text, ...extra });
  const placeholder = 'Previous project scope; retained only as an action receipt.';
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).initiativeRuntime = { sdkState: { actions: [
    { id: 'act-card', action: 'work', status: 'failed', content: placeholder, contextRevoked: true },
    { id: 'act-job', action: 'work', status: 'failed', content: placeholder, contextRevoked: true },
    { id: 'act-lost', action: 'work', status: 'failed', content: placeholder, contextRevoked: true },
  ] } };
  // The user's record of a run is its job (title, instruction); a revoked job is not a record any more.
  state.projects.find(row => row.id === f.project.id).jobs = [{ id: 'act-job', title: '补完第 14 条赛道', instruction: '实现第 14 条赛道。按 E3 的报告做。' }, { id: 'act-lost', title: '旧范围里的工作', contextRevoked: true }]; });
  const card = inv.offerTask(f.session.id, { projectId: f.project.id, actionId: 'act-card', mode: 'failed', text: '实现第 13 条赛道。' });
  await inv.act(f.session.id, card.id, { action: 'answer', choice: 'continue' });
  await inv.answerTask(f.project.id, 'act-job', 'continue');
  assert.deepEqual(posted.map(row => [row.text, row.continues?.actionId]), [['接着完成：实现第 13 条赛道。', 'act-card'], ['接着完成：补完第 14 条赛道', 'act-job']]);
  assert.ok(posted.every(row => !row.text.includes('Previous project scope')));
  const lost = inv.offerTask(f.session.id, { projectId: f.project.id, actionId: 'act-lost', mode: 'failed', text: '' });
  await assert.rejects(inv.act(f.session.id, lost.id, { action: 'answer', choice: 'continue' }), error => error.status === 409 && error.code === 'task_context_revoked' && /记录已经失效/.test(error.message));
  assert.equal(posted.length, 2, 'nothing posted in the user\'s name');
  assert.equal(f.sessionOf().invitations.filter(row => row.kind === 'task').length, 0, 'the card closed');
  assert.equal(f.current().taskMarks['act-lost'].choice, 'expired'); assert.ok(f.current().taskMarks['act-lost'].acknowledgedAt);
});

test('a failed run the SDK no longer lists is answered from its kept job: 不用了 settles it, 接着做 carries it on by the job\'s name', async t => {
  const f = setup(t);
  const inv = new InvitationService(f.store, { mind: { discussionSession: () => f.sessionOf() }, now: () => CLOCK });
  const posted = []; inv.post = (sessionId, text, extra = {}) => posted.push({ sessionId, text, ...extra });
  f.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id);
    project.initiativeRuntime = { sdkState: { actions: [] } };
    project.jobs = [{ id: 'job-old', status: 'failed', title: '整理第 3 章人名表', instruction: '整理第 3 章人名表。' }, { id: 'job-also', status: 'failed', title: '补全简介', instruction: '补全简介。' }, { id: 'job-gone', status: 'failed', title: '已删', sourceDeleted: true }]; });
  assert.equal((await inv.answerTask(f.project.id, 'job-old', 'drop')).choice, 'drop');
  assert.ok(f.current().taskMarks['job-old'].acknowledgedAt);
  await inv.answerTask(f.project.id, 'job-also', 'continue');
  assert.deepEqual(posted.map(row => [row.text, row.continues?.actionId]), [['接着完成：补全简介', 'job-also']]);
  await assert.rejects(inv.answerTask(f.project.id, 'job-gone', 'drop'), error => error.status === 404 && error.code === 'task_not_found');
  await assert.rejects(inv.answerTask(f.project.id, 'nothing', 'drop'), error => error.status === 404);
});

test('a finished result that needed the user can be acknowledged; it then leaves the suggestions (C-e, F46)', async t => {
  const f = setup(t);
  const inv = new InvitationService(f.store, { mind: { discussionSession: () => f.sessionOf() }, now: () => CLOCK });
  f.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id);
    project.initiativeRuntime = { sdkState: { actions: [{ id: 'act-done', action: 'work', status: 'completed', content: '核对第 8 章人名。' }, { id: 'act-failed', action: 'work', status: 'failed', content: '扩写第 9 章。' }] } };
    project.taskMarks = { 'act-done': { at: new Date(CLOCK).toISOString(), needsUser: true, alreadyReported: false } }; });
  const suggestions = new SessionSuggestions(f.store, { git: async () => [] });
  assert.deepEqual((await suggestions.state(f.current())).needsUser, ['核对第 8 章人名。']);
  assert.equal((await inv.answerTask(f.project.id, 'act-done', 'acknowledge')).choice, 'acknowledge');
  const mark = f.current().taskMarks['act-done'];
  assert.ok(mark.acknowledgedAt); assert.equal(mark.needsUser, true, 'the judgment stays; acknowledgedAt says it was seen'); assert.equal(mark.choice, 'acknowledge');
  assert.deepEqual((await suggestions.state(f.current())).needsUser, []);
  await assert.rejects(inv.answerTask(f.project.id, 'act-failed', 'acknowledge'), error => error.status === 400);
});

test('suggestions name revoked results by what the host kept (their job or delivered message) and do not present the agent\'s promises as the user\'s requests (F41, F19)', async t => {
  const f = setup(t);
  f.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id), mind = ensureMind(project);
    addCommitment(mind, { request: '整理第三卷大纲', trigger: 'user_request' }); addCommitment(mind, { request: '稍后我会补充移动端的适配测试。', trigger: 'agent_promise' });
    project.initiativeRuntime = { sdkState: { actions: [
      { id: 'a1', action: 'work', status: 'completed', content: 'Previous project scope; retained only as an action receipt.', contextRevoked: true },
      { id: 'a2', action: 'share', status: 'completed', content: 'Previous project scope; retained only as an action receipt.', contextRevoked: true },
      { id: 'a3', action: 'work', status: 'completed', content: 'Previous project scope; retained only as an action receipt.', contextRevoked: true },
    ] } };
    project.jobs = [{ id: 'a3', title: '第 9 章伏笔清单', instruction: '列出第 9 章伏笔。' }];
    project.inbox = [{ id: 'i2', actionId: 'a2', kind: 'share', text: '第 8 章人名核对完了。\n细节……' }];
    project.taskMarks = { a1: { needsUser: true }, a2: { needsUser: true }, a3: { needsUser: true } }; });
  const state = await new SessionSuggestions(f.store, { git: async () => [] }).state(f.current());
  assert.deepEqual(state.needsUser, ['第 8 章人名核对完了。', '第 9 章伏笔清单']);
  assert.deepEqual(state.pendingRequests, ['整理第三卷大纲']);
});

test('a plan item left doing by background work that stopped goes back to next, marked where it left off (F85)', async t => {
  const f = setup(t);
  const actions = [{ id: 'bcc9b337', action: 'work', status: 'running' }, { id: 'live', action: 'work', status: 'running' }];
  let foreground;
  f.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id), mind = ensureMind(project);
    project.initiativeRuntime = { sdkState: { actions } };
    updatePlan(mind, [{ text: 'prose_review → prose_patch ≤6处 → 复查', status: 'doing' }], { now: CLOCK, source: mindSource('background', { actionId: 'bcc9b337' }) });
    updatePlan(mind, [{ text: '整理第三卷大纲', status: 'doing' }], { now: CLOCK, source: mindSource('background', { actionId: 'live' }) });
    foreground = updatePlan(mind, [{ text: '修复第 2 章错字', status: 'doing' }], { now: CLOCK, source: mindSource('agent', { sessionId: f.session.id }) }).doing.at(-1).id;
    // A row written before stages were attributed: its creating action is the owner.
    mind.agenda.push({ id: 'legacy', kind: 'todo', status: 'open', stage: 'doing', text: '如实计字', source: { kind: 'background', actionId: 'archived-long-ago' }, createdAt: new Date(CLOCK).toISOString(), updatedAt: new Date(CLOCK).toISOString(), evidence: [] }); });
  assert.deepEqual(stalledPlanItems(f.current()).map(row => [row.actionId, row.status]), [['archived-long-ago', 'archived']]);
  f.clock.value += 60000;
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).initiativeRuntime.sdkState.actions[0].status = 'cancelled'; });
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  const plan = planView(f.current().mind);
  assert.deepEqual(plan.doing.map(row => row.text).sort(), ['修复第 2 章错字', '整理第三卷大纲'], 'running work and the conversation\'s own items stay doing');
  const stopped = plan.next.find(row => row.text.startsWith('prose_review'));
  assert.equal(stopped.interruptedAt, new Date(CLOCK + 60000).toISOString()); assert.equal(stopped.updatedAt, new Date(CLOCK).toISOString(), 'not counted as a plan change');
  assert.ok(plan.next.some(row => row.id === 'legacy'));
  assert.ok(plan.doing.some(row => row.id === foreground));
  // Picked up again: the mark goes.
  f.store.mutate(state => { updatePlan(ensureMind(state.projects.find(row => row.id === f.project.id)), [{ id: stopped.id, status: 'doing' }], { now: f.clock.value, source: mindSource('agent', { sessionId: f.session.id }) }); });
  assert.equal(planView(f.current().mind).doing.find(row => row.id === stopped.id).interruptedAt, undefined);
});

test('a plan row written before stages were attributed and moved to doing after its creating work ended is the conversation\'s, not that work\'s (F85)', () => {
  const at = value => new Date(CLOCK + value).toISOString(), row = (id, updatedAt) => ({ id, kind: 'todo', status: 'open', stage: 'doing', text: id, source: { kind: 'background', actionId: 'x' }, createdAt: at(0), updatedAt });
  const project = { initiativeRuntime: { sdkState: { actions: [{ id: 'x', action: 'work', status: 'completed', finishedAt: CLOCK + 60000 }] } }, mind: { agenda: [row('staged-by-x', at(30000)), row('moved-later', at(120000))] } };
  assert.deepEqual(stalledPlanItems(project).map(item => item.id), ['staged-by-x']);
});

test('requests the record already settles are resolved on the sweep, and their cards close: the live standing-rule shape (C2-f, F42/F81)', async t => {
  const f = setup(t), posted = [];
  const inv = new InvitationService(f.store, { mind: { discussionSession: () => f.sessionOf() }, now: () => f.clock.value });
  inv.post = (sessionId, text) => posted.push(text);
  f.mind.invitations = inv;
  // Live, 2026-10-03: commitment 74a4f023 (the GitHub-advisory rule) stayed owed beside lesson e25b1dc0, a preference
  // captured from the same message fcca1f9e, both written before the capture kept standing rules out of commitments.
  const itemId = 'fcca1f9e-5a8b-4d02-9c3e-6b1f0a7d2e41', turnId = 'b7c1d2e3-0000-4000-8000-000000000001', sessionId = f.session.id;
  const finishedTurn = 'b7c1d2e3-0000-4000-8000-000000000002', openTurn = 'b7c1d2e3-0000-4000-8000-000000000003';
  let rule, done, still, promise;
  f.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === f.project.id));
    rule = addCommitment(mind, { request: 'https://github.com/advisories 后续 github 安全报告只报告最严重的等级', trigger: 'user_request', overdueAt: CLOCK - 3600000, source: mindSource('capture', { sessionId, itemId, turnId }), evidence: [{ sessionId, itemId, turnId, excerpt: '…', at: new Date(CLOCK - 5 * 3600000).toISOString() }] }, { now: CLOCK - 5 * 3600000 });
    rule.id = '74a4f023-9d1e-4c55-8f0b-2a6c3e5d7f90';
    const lesson = addLesson(mind, { kind: 'preference', text: 'GitHub 安全报告只报最严重的等级（Critical）。', source: mindSource('preference', { sessionId, itemId, turnId }), evidence: [{ sessionId, itemId, turnId, excerpt: '…' }] }, { now: CLOCK - 5 * 3600000 });
    lesson.id = 'e25b1dc0-3f4a-4b6c-8d7e-9f0a1b2c3d4e';
    done = addCommitment(mind, { request: '跑完全部测试后告诉我结果', trigger: 'user_request', source: mindSource('capture', { sessionId, itemId: 'a1b2c3d4-0000-4000-8000-00000000000a', turnId: finishedTurn }) }, { now: CLOCK - 3600000 }).id;
    still = addCommitment(mind, { request: '明天把第 3 章扩写到 3000 字', trigger: 'user_request', source: mindSource('capture', { sessionId, itemId: 'a1b2c3d4-0000-4000-8000-00000000000b', turnId: openTurn }) }, { now: CLOCK - 3600000 }).id;
    promise = addCommitment(mind, { request: '稍后我会补充移动端的适配测试。', trigger: 'agent_promise', source: mindSource('agent', { sessionId, turnId: finishedTurn }) }, { now: CLOCK - 3600000 }).id; });
  f.settledVerdict(finishedTurn, .95);
  // The owed card the user was shown (Rna 欠你 1 件事), still open.
  assert.equal(inv.offerOverdue(f.project.id)?.commitmentId, rule.id);
  assert.deepEqual(settledRequests(f.store.state, f.current()).map(row => [row.id, row.by.kind, row.by.ledgerId ?? null]), [[rule.id, 'reconcile', null], [done, 'reconcile', `L-${finishedTurn.slice(0, 6)}`]]);
  f.mind.sweep();
  const byId = id => f.current().mind.commitments.find(row => row.id === id);
  assert.equal(byId(rule.id).status, 'resolved'); assert.equal(byId(rule.id).resolvedBy.kind, 'reconcile'); assert.equal(byId(rule.id).resolvedBy.itemId, itemId);
  assert.equal(byId(done).status, 'resolved');
  assert.equal(byId(still).status, 'pending', 'no recorded judgment settles it: still owed');
  assert.equal(byId(promise).status, 'pending', 'the agent\'s own promises are not the capture\'s');
  assert.equal(f.sessionOf().invitations.filter(row => row.kind === 'commitment').length, 0, 'its card closed');
  assert.equal(f.sessionOf().invitationHistory.at(-1).outcome, 'expired');
  assert.equal(posted.length, 0);
  // A rule that ends (until) is a temporary preference, not a standing rule: its request stays owed.
  f.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === f.project.id));
    const item = 'a1b2c3d4-0000-4000-8000-00000000000c';
    addCommitment(mind, { request: '这周先别发日报', trigger: 'user_request', source: mindSource('capture', { sessionId, itemId: item, turnId }) }, { now: CLOCK });
    addLesson(mind, { kind: 'preference', text: '这周不发日报。', until: new Date(CLOCK + 7 * 86400000).toISOString(), source: mindSource('preference', { sessionId, itemId: item, turnId }) }, { now: CLOCK }); });
  assert.deepEqual(settledRequests(f.store.state, f.current()), []);
});

test('older planning receipts read their next run in local plain time when read; the stored row stays (C2-f, F16)', () => {
  const project = { schedules: [{ id: 's1', rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }], scheduleManagementReceipts: [
    { actionId: 'old', scheduleId: 's1', summary: '已自主安排任务「每日 AI 新闻与应用调研」；下次 2026-10-03T01:00:00.000Z。这是任务安排回执，尚不代表工作已完成。' },
    { actionId: 'gone', scheduleId: 'deleted', summary: '已自主调整任务「周报」；下次 2026-10-05T01:00:00.000Z。这是任务安排回执，尚不代表工作已完成。' },
    { actionId: 'new', scheduleId: 's1', nextRunAt: '2026-10-03T01:00:00.000Z', summary: '已自主安排任务「每日 AI 新闻与应用调研」；下次 10月3日 09:00。这是任务安排回执，尚不代表工作已完成。' },
    { actionId: 'cancel', scheduleId: 's1', summary: '已取消任务「每日 AI 新闻与应用调研」。这是任务安排回执，尚不代表工作已完成。' }] };
  const before = structuredClone(project), [old, gone, fresh, cancel] = scheduleReceiptsView(project);
  assert.equal(old.summary, '已自主安排任务「每日 AI 新闻与应用调研」；下次 10月3日 09:00。这是任务安排回执，尚不代表工作已完成。'); assert.equal(old.nextRunAt, '2026-10-03T01:00:00.000Z');
  assert.match(gone.summary, /^已自主调整任务「周报」；下次 10月5日 \d\d:00。/, 'a deleted schedule: the app\'s own time zone');
  assert.equal(fresh, project.scheduleManagementReceipts[2]); assert.equal(cancel, project.scheduleManagementReceipts[3]);
  assert.equal(readableScheduleReceipt(project.scheduleManagementReceipts[0], project, 'en').summary, 'Set up the task “每日 AI 新闻与应用调研”; next run Oct 3, 09:00. This is a scheduling receipt; the work itself is not done yet.');
  assert.deepEqual(project, before, 'read time only');
});

test('a card answered in the user\'s name waits behind a running turn, never steering it (C2-c)', async t => {
  const f = setup(t);
  const inv = new InvitationService(f.store, { mind: { discussionSession: () => f.sessionOf() }, now: () => CLOCK });
  f.store.mutate(state => { addCommitment(ensureMind(state.projects.find(row => row.id === f.project.id)), { request: '整理第三卷大纲', overdueAt: CLOCK - 60000 }, { now: CLOCK - 7200000 }); });
  inv.offerOverdue(f.project.id);
  f.store.message(f.session.id, { text: '先写第 3 章' });
  assert.ok(f.sessionOf().activeTurnId, 'a turn is running');
  const card = f.sessionOf().invitations.find(row => row.kind === 'commitment');
  await inv.act(f.session.id, card.id, { action: 'answer', choice: 'continue' });
  assert.deepEqual(f.sessionOf().inbox.map(row => [row.delivery, row.text]), [['followup', '接着完成：整理第三卷大纲']]);
});

test('a revoked result that still holds the foreground back gets a review card named as the task page names it (C2-d, F84)', async t => {
  const f = setup(t);
  const inv = new InvitationService(f.store, { mind: { discussionSession: () => f.sessionOf() }, now: () => CLOCK });
  const placeholder = 'Previous project scope; retained only as an action receipt.';
  f.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id);
    project.initiativeRuntime = { sdkState: { actions: [
      { id: 'old-review', action: 'work', status: 'needs_review', blocksExecution: true, contextRevoked: true, content: placeholder, startedAt: CLOCK - 7200000 },
      { id: 'old-failed', action: 'work', status: 'failed', contextRevoked: true, content: placeholder, finishedAt: CLOCK - 60000 },
      { id: 'quiet-review', action: 'work', status: 'needs_review', blocksExecution: false, contextRevoked: true, content: placeholder, startedAt: CLOCK - 60000 }] } };
    project.jobs = [{ id: 'old-review', instruction: '批量替换旧贴图引用。用 project_write 改 E3 的路径。', status: 'needs_review', lane: 'background' }, { id: 'old-failed', title: '扩写第 9 章', status: 'failed', lane: 'background' }]; });
  const card = await inv.offerTaskAttention(f.project.id);
  assert.equal(card.actionId, 'old-review'); assert.equal(card.mode, 'review'); assert.equal(card.text, '批量替换旧贴图引用。');
  assert.equal(await inv.offerTaskAttention(f.project.id), null, 'a revoked failure or a review that blocks nothing is not asked about again');
  // Nothing readable kept: a plain name, never the placeholder.
  f.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.jobs = []; project.initiativeRuntime.sdkState.actions.push({ id: 'unnamed', action: 'work', status: 'needs_review', blocksExecution: true, contextRevoked: true, content: placeholder, startedAt: CLOCK }); });
  assert.equal((await inv.offerTaskAttention(f.project.id)).text, '之前的一项工作');
});

test('the task routes settle a seen result (acknowledge) end to end, and a refusal keeps its code (C2-e, F83)', async t => {
  const f = setup(t);
  const inv = new InvitationService(f.store, { mind: { discussionSession: () => f.sessionOf() }, now: () => CLOCK });
  f.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id);
    project.initiativeRuntime = { sdkState: { actions: [{ id: 'act-done', action: 'work', status: 'completed', title: '核对第 8 章人名', content: '核对第 8 章人名。' }, { id: 'act-lost', action: 'work', status: 'failed', contextRevoked: true, content: 'Previous project scope; retained only as an action receipt.' }] } };
    project.taskMarks = { 'act-done': { needsUser: true } }; });
  const handle = createMindRoutes({ store: f.store, body: async req => req.body, mind: f.mind, invitations: inv });
  const call = async (path, body) => { let sent; await handle({ method: 'POST', body }, { pathname: path, url: new URL(`http://127.0.0.1${path}`), send: (status, value) => { sent = { status, value }; } }); return sent; };
  const answered = await call(`/api/v2/projects/${f.project.id}/tasks/act-done`, { choice: 'acknowledge' });
  assert.equal(answered.status, 200); assert.equal(answered.value.choice, 'acknowledge');
  assert.ok(f.current().taskMarks['act-done'].acknowledgedAt); assert.equal(f.current().taskMarks['act-done'].needsUser, true);
  await assert.rejects(call(`/api/v2/projects/${f.project.id}/tasks/act-lost`, { choice: 'continue' }), error => error.status === 409 && error.code === 'task_context_revoked' && /记录已经失效/.test(error.message));
});


test('schedule rejections read as user text in the interface language (C-i, F21)', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-ux-mind-schedule-')), store = new Store(join(dir, 'state.json')), at = Date.parse('2026-10-03T02:00:00Z');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { project } = store.createProject({ name: 'Research', workspace: dir }), service = new ProjectScheduleService(store, { now: () => at });
  const draft = { title: '每日调研', task: '核查一手来源。', rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } };
  const reject = (input, pattern) => assert.throws(() => service.create(project.id, { ...draft, ...input }), error => error.status === 400 && pattern.test(error.message) && typeof error.detail === 'string');
  reject({ rule: { kind: 'once', at: '2026-10-02T09:00:00+08:00' } }, /这个时间已经过去了/);
  reject({ rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shangai' } }, /无法识别这个时区/);
  reject({ rule: { kind: 'daily', time: '9点', timeZone: 'Asia/Shanghai' } }, /HH:mm/);
  reject({ rule: { kind: 'weekly', time: '09:00', timeZone: 'Asia/Shanghai', days: [] } }, /每周哪几天/);
  reject({ rule: { kind: 'interval', everyMs: 1000 } }, /5 分钟到 366 天/);
  reject({ rule: { kind: 'once', at: '2026-10-09 09:00' } }, /执行时间无效/);
  reject({ title: ' ' }, /名称不能为空/);
  reject({ rule: { kind: 'monthly' } }, /不支持这种执行方式/);
  store.mutate(state => { state.settings.interfaceLanguage = 'en'; });
  reject({ rule: { kind: 'once', at: '2026-10-02T09:00:00+08:00' } }, /^That time has already passed/);
  store.mutate(state => { state.projects.find(row => row.id === project.id).schedules = Array.from({ length: 32 }, (_, index) => ({ id: `s${index}` })); });
  assert.throws(() => service.create(project.id, draft), error => error.status === 409 && /at most 32 schedules/.test(error.message));
});

test('the planning receipt names the next run as the user set it, not as a UTC instant (F16)', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-ux-mind-receipt-')), store = new Store(join(dir, 'state.json')), at = Date.parse('2026-10-02T02:00:00Z');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { project, session } = store.createProject({ name: '研究项目', workspace: dir });
  store.mutate(state => { state.projects.find(row => row.id === project.id).initiative.enabled = true; });
  const service = new ProjectScheduleService(store, { now: () => at }), evidence = [{ id: 'e1', type: 'project_context', summary: '每天早上交付 AI 新闻。' }];
  const action = id => ({ actionId: id, reason: '用户要求每日交付。', evidenceIds: ['e1'], evidence, schedule: { operation: 'create', purposeKey: `daily-${id}`, title: '每日 AI 新闻与应用调研', task: '整理 AI 新闻。', destinationSessionId: session.id, rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } } });
  const zh = service.applyInitiativeAction(project.id, action('a1'));
  assert.equal(zh.nextRunAt, '2026-10-03T01:00:00.000Z');
  assert.match(zh.summary, /已自主安排任务「每日 AI 新闻与应用调研」；下次 10月3日 09:00。这是任务安排回执，尚不代表工作已完成。/);
  assert.doesNotMatch(zh.summary, /T01:00|Z/);
  store.mutate(state => { state.settings.interfaceLanguage = 'en'; });
  const en = service.applyInitiativeAction(project.id, action('a2'));
  assert.match(en.summary, /^Set up the task “每日 AI 新闻与应用调研”; next run Oct 3, 09:00\. This is a scheduling receipt/);
});
