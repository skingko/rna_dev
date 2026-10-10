import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { createServer } from '../server.mjs';
import { readStateFile } from '../state-shards.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-forge-autonomy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'state.json');
}
const goalOf = (store, id) => store.get().goals.find(g => g.id === id);
const sessionOf = (store, id) => store.get().sessions.find(s => s.id === id);
const advance = (store, id) => { store.controlGoal(id, { action: 'advance' }); store.tick(); };
function untilStage(store, id, stage) {
  for (let i = 0; i < 30; i++) {
    const goal = goalOf(store, id);
    if (goal.stage === stage && goal.status === 'scheduled') return;
    advance(store, id);
  }
  throw new Error(`未到达 ${stage}`);
}

test('完整自主目标经过等待、失败、候选评测与晋升验收；每次由新自主轮次触发', t => {
  const store = new Store(fixture(t)), { goal, session } = store.createAutonomyDemo();
  assert.equal(goal.status, 'scheduled');
  for (let i = 0; i < 20 && goalOf(store, goal.id).status !== 'completed'; i++) advance(store, goal.id);
  const result = goalOf(store, goal.id), conversation = sessionOf(store, session.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.runCount, 7);
  assert.equal(result.nextWakeAt, null);
  assert.equal(result.budget.spentUsd, 0.168);
  assert.equal(result.budget.tokens, 8680);
  assert.equal(result.evaluation.baseline, 75);
  assert.equal(result.evaluation.score, 100);
  assert.equal(result.evaluation.gatePassed, true);
  assert.ok(result.acceptance.every(check => check.passed));
  const candidate = store.get().candidates.find(c => c.id === result.candidateId);
  assert.equal(candidate.state, 'promoted');
  assert.equal(candidate.version, result.policyVersion);
  assert.equal(conversation.status, 'idle');
  assert.equal(conversation.items.filter(item => item.kind === 'user').length, 0);
  assert.equal(conversation.turns.length, 7);
  assert.ok(conversation.turns.every(turn => turn.source === 'autonomy' && turn.userItemId === null && turn.status === 'completed'));
  assert.equal(conversation.turns[1].trigger.kind, 'event');
  assert.equal(conversation.artifacts.length, 4);
  assert.ok(conversation.items.at(-1).artifactIds.length);
  const after = store.get(); store.tick(); assert.deepEqual(store.get(), after);
});

test('等待不空转或记账；手动信号持久化去重，重复不创建运行', t => {
  const file = fixture(t), store = new Store(file), { goal } = store.createAutonomyDemo();
  advance(store, goal.id); advance(store, goal.id);
  assert.equal(goalOf(store, goal.id).status, 'waiting');
  const before = store.get(); store.tick(); assert.deepEqual(store.get(), before);
  store.controlGoal(goal.id, { action: 'signal', eventId: 'ci-event-1' });
  const signalled = goalOf(store, goal.id);
  assert.equal(signalled.status, 'scheduled');
  assert.equal(signalled.runCount, 1);
  assert.equal(store.controlGoal(goal.id, { action: 'signal', eventId: 'ci-event-1' }).duplicate, true);
  assert.equal(goalOf(store, goal.id).receipts.length, 1);
  assert.equal(goalOf(store, goal.id).history.filter(row => row.type === 'signal').length, 1);
  const reopened = new Store(file);
  assert.equal(reopened.controlGoal(goal.id, { action: 'signal', eventId: 'ci-event-1' }).duplicate, true);
  assert.equal(goalOf(reopened, goal.id).status, 'paused');
});

test('暂停等待不能被信号或推进绕过；恢复后消费既有事件', t => {
  const store = new Store(fixture(t)), { goal } = store.createAutonomyDemo();
  advance(store, goal.id); advance(store, goal.id);
  store.controlGoal(goal.id, { action: 'pause' });
  store.controlGoal(goal.id, { action: 'signal', eventId: 'paused-ready' });
  assert.throws(() => store.controlGoal(goal.id, { action: 'advance' }), /暂停或已结束/);
  const before = store.get(); store.tick(); assert.deepEqual(store.get(), before);
  assert.equal(goalOf(store, goal.id).pauseReason, 'manual');
  store.controlGoal(goal.id, { action: 'resume' }); store.tick();
  assert.equal(goalOf(store, goal.id).status, 'running');
  assert.equal(goalOf(store, goal.id).runCount, 2);
});

test('开始前检查目标与全局预算，预算调整不自动恢复，轮数限制同样生效', t => {
  const store = new Store(fixture(t)), { goal } = store.createAutonomyDemo({ budget: 0.01, maxRuns: 1 });
  store.tick();
  assert.equal(goalOf(store, goal.id).pauseReason, 'budget');
  assert.equal(goalOf(store, goal.id).budget.spentUsd, 0);
  store.controlGoal(goal.id, { action: 'budget', limitUsd: 1 });
  assert.equal(goalOf(store, goal.id).status, 'paused');
  store.controlGoal(goal.id, { action: 'resume' }); store.tick();
  advance(store, goal.id); advance(store, goal.id);
  assert.equal(goalOf(store, goal.id).pauseReason, 'budget');
  assert.equal(goalOf(store, goal.id).runCount, 1);
  assert.equal(goalOf(store, goal.id).budget.spentUsd, 0.024);
  assert.throws(() => store.controlGoal(goal.id, { action: 'budget', limitUsd: 0.001 }), /不能低于/);
  store.controlGoal(goal.id, { action: 'budget', maxRuns: 10 });
  store.settings({ tokenBudget: 1240 });
  store.controlGoal(goal.id, { action: 'resume' }); store.tick();
  assert.equal(goalOf(store, goal.id).pauseReason, 'budget');
  assert.equal(goalOf(store, goal.id).runCount, 1);
});

test('中途暂停和重启恢复同一自主轮次，不重复记账；排队目标重启也不偷跑', t => {
  const file = fixture(t), store = new Store(file), { goal, session } = store.createAutonomyDemo();
  store.tick();
  const active = sessionOf(store, session.id).activeTurnId;
  const queued = store.createAutonomyDemo();
  store.controlGoal(goal.id, { action: 'pause' });
  store.controlGoal(goal.id, { action: 'resume' });
  assert.equal(goalOf(store, goal.id).runCount, 1);
  const reopened = new Store(file);
  assert.equal(goalOf(reopened, goal.id).pauseReason, 'recovery');
  assert.equal(goalOf(reopened, queued.goal.id).pauseReason, 'recovery');
  const before = reopened.get(); reopened.tick(); assert.deepEqual(reopened.get(), before);
  reopened.controlGoal(goal.id, { action: 'resume' }); advance(reopened, goal.id);
  assert.equal(sessionOf(reopened, session.id).turns[0].id, active);
  assert.equal(goalOf(reopened, goal.id).runCount, 1);
  assert.equal(goalOf(reopened, goal.id).budget.spentUsd, 0.024);
  assert.equal(goalOf(reopened, goal.id).status, 'waiting');
});

test('急停覆盖等待目标，解除不自启；取消停止调度与当前工具', t => {
  const store = new Store(fixture(t)), { goal, session } = store.createAutonomyDemo();
  advance(store, goal.id); advance(store, goal.id);
  store.emergency(true);
  assert.equal(goalOf(store, goal.id).status, 'paused');
  store.controlGoal(goal.id, { action: 'signal', eventId: 'during-emergency' });
  assert.throws(() => store.controlGoal(goal.id, { action: 'resume' }), /急停/);
  store.emergency(false); store.tick();
  assert.equal(goalOf(store, goal.id).status, 'paused');
  store.controlGoal(goal.id, { action: 'resume' }); store.tick();
  store.controlGoal(goal.id, { action: 'cancel' });
  assert.equal(goalOf(store, goal.id).status, 'cancelled');
  assert.equal(sessionOf(store, session.id).status, 'idle');
  assert.equal(sessionOf(store, session.id).turns.at(-1).status, 'stopped');
  assert.equal(sessionOf(store, session.id).items.findLast(i => i.kind === 'tool').tool.status, 'failed');
  assert.throws(() => store.controlGoal(goal.id, { action: 'signal' }), /目标已结束/);
  const before = store.get(); store.tick(); assert.deepEqual(store.get(), before);
});

test('用户插话先暂停自主目标且保留输入；停止轮次不能偷偷再次唤醒', t => {
  const store = new Store(fixture(t)), { goal, session } = store.createAutonomyDemo();
  store.tick();
  store.message(session.id, { text: '先解释目前遇到的依赖', requestId: 'takeover-1' });
  let conversation = sessionOf(store, session.id);
  assert.equal(goalOf(store, goal.id).status, 'paused');
  assert.equal(conversation.turns[0].status, 'stopped');
  assert.equal(conversation.turns.length, 2);
  assert.equal(conversation.items.findLast(i => i.kind === 'user').text, '先解释目前遇到的依赖');
  for (let i = 0; i < 5; i++) store.tick();
  assert.equal(sessionOf(store, session.id).status, 'idle');
  assert.equal(goalOf(store, goal.id).runCount, 1);
  store.controlGoal(goal.id, { action: 'resume' }); store.tick();
  store.controlSession(session.id, 'stop');
  assert.equal(goalOf(store, goal.id).status, 'paused');
  assert.equal(sessionOf(store, session.id).status, 'idle');
  const before = store.get(); store.tick(); assert.deepEqual(store.get(), before);
});

test('候选不能越过评测门禁，通用晋升接口不能改写自主目标候选', t => {
  const store = new Store(fixture(t)), { goal } = store.createAutonomyDemo();
  untilStage(store, goal.id, 'evaluate');
  const candidateId = goalOf(store, goal.id).candidateId;
  assert.equal(store.get().candidates.find(c => c.id === candidateId).state, 'draft');
  assert.throws(() => store.candidate(candidateId, 'promote'), /不能通过通用操作/);
  // Corrupt only the synthetic candidate to exercise a genuine negative gate.
  store.mutate(state => { state.candidates.find(c => c.id === candidateId).guard = 'invalid'; });
  advance(store, goal.id); advance(store, goal.id);
  assert.equal(goalOf(store, goal.id).evaluation.gatePassed, false);
  advance(store, goal.id); advance(store, goal.id);
  assert.equal(goalOf(store, goal.id).status, 'paused');
  assert.equal(goalOf(store, goal.id).pauseReason, 'gate');
  assert.equal(goalOf(store, goal.id).policyVersion, 'demo-guard-v1');
});

test('用户轮次尚未结束就恢复目标，不抢占唯一执行槽或阻塞用户回复', t => {
  const store = new Store(fixture(t)), { goal, session } = store.createAutonomyDemo();
  store.message(session.id, { text: '先讨论方案' });
  store.controlGoal(goal.id, { action: 'resume' });
  for (let i = 0; i < 5; i++) advance(store, goal.id);
  assert.equal(sessionOf(store, session.id).turns[0].status, 'completed');
  assert.equal(goalOf(store, goal.id).runCount, 0);
  advance(store, goal.id);
  assert.equal(goalOf(store, goal.id).runCount, 1);
  assert.equal(sessionOf(store, session.id).turns[1].source, 'autonomy');
});

test('多个自主目标尊重并行上限，未到期的当前运行仍占用执行槽', t => {
  const store = new Store(fixture(t)), first = store.createAutonomyDemo(), second = store.createAutonomyDemo();
  store.tick();
  assert.equal(goalOf(store, first.goal.id).status, 'running');
  assert.equal(goalOf(store, second.goal.id).runCount, 0);
  store.tick();
  assert.equal(goalOf(store, second.goal.id).runCount, 0);
  advance(store, first.goal.id);
  assert.equal(goalOf(store, first.goal.id).status, 'waiting');
  assert.equal(goalOf(store, second.goal.id).status, 'running');
  assert.equal(store.get().goals.filter(g => g.status === 'running').length, 1);
});

test('旧v2状态只增加goals集合，既有任务和会话不被覆盖', t => {
  const file = fixture(t), store = new Store(file), session = store.createSession({ demo: true });
  const old = store.get(); delete old.goals; writeFileSync(file, JSON.stringify(old));
  const reopened = new Store(file);
  assert.deepEqual(reopened.get().goals, []);
  assert.deepEqual(reopened.get().sessions[0], session);
  assert.equal(readStateFile(file).state.version, 2);
  reopened.createAutonomyDemo();
  assert.equal(reopened.get().sessions.length, 2);
  assert.deepEqual(sessionOf(reopened, session.id), session);
});

test('HTTP创建后无浏览器和后续请求也由真实daemon timer推进', async t => {
  const { server, store } = createServer({ stateFile: fixture(t), ticks: true, tickIntervalMs: 25 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/autonomy/demos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 201);
  const { goal } = await response.json();
  for (let i = 0; i < 40 && goalOf(store, goal.id).runCount === 0; i++) await delay(25);
  assert.equal(goalOf(store, goal.id).runCount, 1);
  assert.equal(goalOf(store, goal.id).status, 'running');
  // No HTTP request or manual store.tick is used for this natural completion.
  for (let i = 0; i < 150 && goalOf(store, goal.id).status === 'running'; i++) await delay(25);
  assert.equal(goalOf(store, goal.id).status, 'waiting');
  assert.equal(goalOf(store, goal.id).budget.spentUsd, 0.024);
});
