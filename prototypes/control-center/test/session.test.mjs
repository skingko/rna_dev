import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../store.mjs';
import { createServer } from '../server.mjs';

const run = promisify(execFile);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-forge-chat-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'state.json');
}
const sessionOf = (store, id) => store.get().sessions.find(session => session.id === id);
const advance = (store, count = 5) => { for (let i = 0; i < count; i++) store.tick(); };

test('会话可以跨轮继续，保留工具轨迹、产物和历史；演示不更改工作区', t => {
  const file = fixture(t), store = new Store(file), session = store.createSession();
  store.message(session.id, { text: '请帮我规划会话界面', requestId: 'first' });
  advance(store);
  let result = sessionOf(store, session.id);
  assert.equal(result.status, 'idle');
  assert.equal(result.activeTurnId, null);
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].status, 'completed');
  assert.equal(result.items.find(item => item.kind === 'tool').tool.status, 'succeeded');
  assert.match(result.artifacts[0].content, /模拟示例/);
  assert.match(result.artifacts[0].content, /请帮我规划会话界面/);
  const firstIds = result.items.map(item => item.id);
  store.message(session.id, { text: '加上附件和工具输出', requestId: 'second' });
  advance(store);
  result = sessionOf(new Store(file), session.id);
  assert.equal(result.turns.length, 2);
  assert.equal(result.artifacts.length, 2);
  assert.deepEqual(result.items.slice(0, firstIds.length).map(item => item.id), firstIds);
  assert.ok(result.plan.every(step => step.status === 'completed'));
});

test('中途引导在本轮边界消费，followup 只在当前轮结束后启动新轮', t => {
  const store = new Store(fixture(t)), { id } = store.createSession();
  store.message(id, { text: '执行主请求' });
  store.tick();
  const firstTurn = sessionOf(store, id).activeTurnId;
  store.message(id, { text: '下一轮再讨论配色', delivery: 'followup' });
  store.message(id, { text: '当前轮先强调可访问性', delivery: 'steer' });
  assert.equal(sessionOf(store, id).items.filter(item => item.kind === 'user').length, 1);
  store.tick();
  let result = sessionOf(store, id);
  const steering = result.items.find(item => item.text === '当前轮先强调可访问性');
  assert.equal(steering.turnId, firstTurn);
  assert.equal(steering.delivery, 'steer');
  assert.deepEqual(result.inbox.map(message => message.delivery), ['followup']);
  advance(store, 3);
  result = sessionOf(store, id);
  assert.equal(result.turns[0].status, 'completed');
  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[1].stage, 0);
  assert.equal(result.items.find(item => item.text === '下一轮再讨论配色').turnId, result.activeTurnId);
  assert.notEqual(result.activeTurnId, firstTurn);
  assert.match(result.artifacts[0].content, /当前轮先强调可访问性/);
  advance(store);
  assert.equal(sessionOf(store, id).status, 'idle');
});

test('暂停冻结轮次和队列；恢复从原阶段继续；busy send 归入 steer', t => {
  const store = new Store(fixture(t)), { id } = store.createSession();
  store.message(id, { text: '主请求' });
  advance(store, 2);
  store.controlSession(id, 'pause');
  const message = store.message(id, { text: '补充约束', delivery: 'send' });
  assert.equal(message.queued, true);
  assert.equal(message.entry.delivery, 'steer');
  const before = store.get();
  advance(store, 3);
  assert.deepEqual(store.get(), before);
  store.controlSession(id, 'resume');
  store.tick();
  assert.equal(sessionOf(store, id).turns[0].stage, 3);
  assert.equal(sessionOf(store, id).inbox.length, 0);
});

test('最终答复后到达的中途引导仍进入本轮，并更新示例产物', t => {
  const store = new Store(fixture(t)), { id } = store.createSession();
  store.message(id, { text: '初始请求' });
  advance(store, 4);
  store.message(id, { text: '完成前补充的约束', delivery: 'steer' });
  store.tick();
  const result = sessionOf(store, id);
  assert.equal(result.turns.length, 1);
  assert.match(result.artifacts.at(-1).content, /完成前补充的约束/);
  assert.equal(result.status, 'running');
  store.tick();
  assert.equal(sessionOf(store, id).status, 'idle');
});

test('停止只结束当前轮，正在做的一步记为已停止；未消费消息及附件放回输入框；会话可继续，撤回与消费互斥', t => {
  const store = new Store(fixture(t)), { id } = store.createSession();
  store.message(id, { text: '第一轮' });
  advance(store, 2);
  const queued = store.message(id, { text: '可取回消息', delivery: 'followup', attachments: [{ name: 'design.md', size: 42 }], skillIds: ['research'] });
  const stopped = store.controlSession(id, 'stop');
  assert.equal(stopped.session.status, 'idle');
  assert.equal(stopped.session.turns[0].status, 'stopped');
  assert.equal(stopped.session.items.find(item => item.kind === 'tool').tool.status, 'cancelled');
  assert.equal(stopped.recovered[0].id, queued.entry.id);
  assert.equal(stopped.recovered[0].attachments[0].name, 'design.md');
  assert.equal(stopped.session.items.at(-1).recoveredMessages[0].text, '可取回消息');
  assert.equal(stopped.session.items.at(-1).text, '本轮已停止。还没处理的 1 条消息已放回输入框；你可以继续此会话。');
  assert.equal(stopped.session.inbox.length, 0);
  store.message(id, { text: stopped.recovered[0].text });
  const second = store.message(id, { text: '撤回编辑', delivery: 'followup' });
  assert.equal(store.removeInbox(id, second.entry.id).recovered.text, '撤回编辑');
  assert.equal(sessionOf(store, id).items.at(-1).recoveredMessages[0].text, '撤回编辑');
  assert.throws(() => store.removeInbox(id, second.entry.id), /已被消费或不存在/);
  advance(store);
  assert.equal(sessionOf(store, id).turns[1].status, 'completed');
});

test('幂等 requestId 避免重试重复提交，冲突不写入状态，重启后仍有效', t => {
  const file = fixture(t), store = new Store(file), { id } = store.createSession();
  const input = { text: '只提交一次', requestId: 'stable-request' };
  const first = store.message(id, input);
  const before = store.get();
  assert.equal(store.message(id, input).duplicate, true);
  assert.deepEqual(store.get(), before);
  assert.throws(() => store.message(id, { ...input, text: '不同内容' }), /同一 requestId/);
  assert.deepEqual(store.get(), before);
  const queued = { text: '运行中发送', requestId: 'queued-request', delivery: 'send' };
  const second = store.message(id, queued);
  assert.equal(store.message(id, queued).entry.id, second.entry.id);
  const reopened = new Store(file);
  assert.equal(reopened.message(id, input).entry.id, first.entry.id);
  assert.equal(sessionOf(reopened, id).inbox.length, 1);
});

test('服务重启保留进行中的工具和队列，并暂停等待恢复', t => {
  const file = fixture(t), store = new Store(file), { id } = store.createSession();
  store.message(id, { text: '持久化' });
  advance(store, 2);
  store.message(id, { text: '下一轮', delivery: 'followup' });
  const reopened = new Store(file), result = sessionOf(reopened, id);
  assert.equal(result.status, 'paused');
  assert.equal(result.pauseReason, 'recovery');
  assert.equal(result.turns[0].stage, 2);
  assert.equal(result.inbox.length, 1);
  const before = reopened.get().usage;
  reopened.tick();
  assert.deepEqual(reopened.get().usage, before);
  reopened.controlSession(id, 'resume');
  advance(reopened, 3);
  assert.equal(sessionOf(reopened, id).turns.length, 2);
});

test('会话遵守模拟预算与急停；解除不自动恢复；超限不消费消息', t => {
  const store = new Store(fixture(t)), { id } = store.createSession();
  store.settings({ tokenBudget: 600 });
  store.message(id, { text: '预算测试' });
  store.message(id, { text: '边界补充', delivery: 'steer' });
  store.tick();
  assert.equal(sessionOf(store, id).pauseReason, 'budget');
  assert.equal(sessionOf(store, id).turns[0].stage, 0);
  assert.equal(sessionOf(store, id).inbox.length, 1);
  assert.equal(store.get().usage.tokens, 0);
  store.settings({ tokenBudget: 10000 });
  store.controlSession(id, 'resume');
  store.tick();
  store.emergency(true);
  assert.equal(sessionOf(store, id).pauseReason, 'emergency');
  assert.throws(() => store.controlSession(id, 'resume'), /急停/);
  store.emergency(false);
  store.tick();
  assert.equal(sessionOf(store, id).status, 'paused');
  store.controlSession(id, 'resume');
  advance(store, 4);
  assert.equal(sessionOf(store, id).status, 'idle');
});

test('v1 升级备份原始文件，保留旧任务与事件，旧任务成为历史会话', t => {
  const file = fixture(t), original = new Store(file);
  original.create({ title: '旧任务', description: '旧说明' });
  const legacy = original.get(); legacy.version = 1; delete legacy.sessions;
  const source = JSON.stringify(legacy, null, 2); writeFileSync(file, source);
  const upgraded = new Store(file).get();
  assert.equal(readFileSync(`${file}.v1-backup`, 'utf8'), source);
  assert.equal(upgraded.version, 2);
  assert.deepEqual(upgraded.tasks, legacy.tasks);
  assert.deepEqual(upgraded.events.slice(0, legacy.events.length), legacy.events);
  assert.equal(upgraded.sessions[0].sourceTaskId, legacy.tasks[0].id);
  assert.match(upgraded.sessions[0].items[0].text, /旧说明/);
  assert.equal(upgraded.sessions[0].status, 'idle');
  assert.equal(new Store(file).get().sessions.length, 1);
});

test('模式模型在轮次边界生效；整理上下文保留完整历史；示例不启动执行', t => {
  const store = new Store(fixture(t)), { id } = store.createSession({ demo: true });
  assert.equal(sessionOf(store, id).status, 'idle');
  assert.equal(sessionOf(store, id).artifacts.length, 1);
  store.updateSession(id, { mode: 'plan', model: '演示 B' });
  store.message(id, { text: '计划模式' });
  store.updateSession(id, { mode: 'build', model: '演示 C' });
  assert.equal(sessionOf(store, id).turns[1].mode, 'plan');
  assert.equal(sessionOf(store, id).turns[1].model, '演示 B');
  assert.throws(() => store.controlSession(id, 'compact'), /本轮结束/);
  advance(store);
  const before = sessionOf(store, id);
  const result = store.controlSession(id, 'compact').session;
  assert.ok(result.context.tokens < before.context.tokens);
  assert.deepEqual(result.items.slice(0, -1), before.items);
  assert.equal(result.context.compactions, 1);
});

test('HTTP 与 CLI 共享会话，队列可撤回且控制返回可编辑消息', async t => {
  const { server, store } = createServer({ stateFile: fixture(t), ticks: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const port = String(server.address().port), base = `http://127.0.0.1:${port}`;
  const request = async (path, method = 'GET', data) => {
    const response = await fetch(`${base}${path}`, { method, headers: data ? { 'content-type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  const { id } = await request('/api/sessions', 'POST', { title: '共享会话' });
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const output = await run(process.execPath, [cli, 'send', id, '来自 CLI 的消息'], { env: { ...process.env, PI_FORGE_PORT: port } });
  assert.equal(JSON.parse(output.stdout).queued, false);
  assert.equal((await request(`/api/sessions/${id}`)).items[0].text, '来自 CLI 的消息');
  const queued = await request(`/api/sessions/${id}/messages`, 'POST', { text: '稍后处理', delivery: 'followup' });
  assert.equal((await request(`/api/sessions/${id}/inbox/${queued.entry.id}`, 'DELETE', {})).recovered.text, '稍后处理');
  await request(`/api/sessions/${id}/messages`, 'POST', { text: '停止后取回', delivery: 'followup' });
  const stopped = await request(`/api/sessions/${id}/control`, 'POST', { action: 'stop' });
  assert.equal(stopped.recovered[0].text, '停止后取回');
  assert.equal(store.get().sessions[0].status, 'idle');
});
