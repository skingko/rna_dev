import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { createServer } from '../server.mjs';
import { readStateFile, readStateText } from '../state-shards.mjs';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-forge-project-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'state.json');
}
const projectOf = (s, id) => s.get().projects.find(p => p.id === id);
const sessionOf = (s, id) => s.get().sessions.find(p => p.id === id);
const ticks = (s, n = 3) => { for (let i = 0; i < n; i++) s.tick(); };
const create = s => s.createProject({ initiative: { cooldownMs: 0 } });
const evidence = (s, id, kind = 'ci_failure', extra = {}) => s.observeProject(id, { kind, text: `新的 ${kind} 证据`, ...extra });
const notices = (s, id) => sessionOf(s, id).items.filter(i => i.source === 'initiative');

test('没有Goal或用户任务：项目现状触发后台检查，再自然接入同一对话', t => {
  const s = new Store(fixture(t)), { project, session } = s.createProject({ demo: true, initiative: { cooldownMs: 0 } });
  assert.equal(s.get().goals.length, 0); assert.equal(session.turns.length, 0);
  s.tick(); assert.equal(projectOf(s, project.id).jobs[0].lane, 'background');
  assert.equal(sessionOf(s, session.id).activeTurnId, null);
  ticks(s, 2);
  assert.equal(notices(s, session.id).length, 1);
  assert.equal(notices(s, session.id)[0].turnId, null);
  assert.ok(notices(s, session.id)[0].evidenceIds.length);
  assert.equal(notices(s, session.id)[0].decisionMode, 'demo-policy');
  assert.equal(s.get().goals.length, 0);
  const before = s.get(); ticks(s, 10); assert.deepEqual(s.get(), before);
});

test('不同证据直接走share/work/learn/wait分支，不要求固定阶段顺序', t => {
  for (const [kind, action] of [['ci_recovered', 'share'], ['context', 'work'], ['ci_failure', 'learn'], ['note', 'wait']]) {
    const s = new Store(fixture(t)), { project } = create(s);
    evidence(s, project.id, kind); s.tick();
    assert.equal(projectOf(s, project.id).decisions[0].action, action);
    assert.equal(s.get().goals.length, 0);
  }
});

test('相同eventId持久化去重，冲突拒绝；沉默不空转写盘或花费', t => {
  const file = fixture(t), s = new Store(file), { project, session } = create(s);
  const input = { kind: 'ci_recovered', text: '依赖恢复', eventId: 'ci-123' };
  s.observeProject(project.id, input); s.tick();
  const before = s.get(), disk = readStateText(file);
  assert.equal(s.observeProject(project.id, input).duplicate, true);
  assert.throws(() => s.observeProject(project.id, { ...input, text: '冲突' }), /同一 eventId/);
  ticks(s, 10); assert.deepEqual(s.get(), before); assert.equal(readStateText(file), disk);
  const reopened = new Store(file); reopened.tick();
  assert.equal(reopened.observeProject(project.id, input).duplicate, true);
  assert.equal(notices(reopened, session.id).length, 1);
});

test('输入状态只保留内存；用户输入时主动消息延期，结束输入才接话', t => {
  const file = fixture(t), s = new Store(file), { project, session } = create(s);
  evidence(s, project.id, 'ci_recovered');
  const disk = readStateText(file), revision = s.get().revision;
  s.presence(project.id, { sessionId: session.id, typing: true, visible: true });
  assert.equal(s.get().revision, revision); assert.equal(readStateText(file), disk);
  s.tick(); assert.equal(notices(s, session.id).length, 0);
  assert.match(projectOf(s, project.id).decisions.at(-1).reason, /正在输入/);
  const before = s.get(); ticks(s, 5); assert.deepEqual(s.get(), before);
  s.presence(project.id, { sessionId: session.id, typing: false, visible: true }); s.tick();
  assert.equal(notices(s, session.id).length, 1);
});

test('主动消息尊重输入租约到期，隐藏页面不永久阻挡协作', t => {
  const s = new Store(fixture(t)), { project, session } = create(s);
  evidence(s, project.id, 'ci_recovered');
  s.presence(project.id, { sessionId: session.id, typing: true, visible: true });
  s.presences.get(project.id).expiresAt = '2000-01-01T00:00:00.000Z';
  s.tick(); assert.equal(notices(s, session.id).length, 1);
});

test('切换会话时隐藏的旧presence不覆盖primary，可见的新presence优先primary投递', t => {
  const s = new Store(fixture(t)), { project, session: previous } = create(s);
  const current = s.createSession({ projectId: project.id });
  s.mutate(state => { state.projects.find(item => item.id === project.id).primarySessionId = current.id; });
  // The former conversation may still hold an unexpired lease while its view is hidden.
  s.presence(project.id, { sessionId: previous.id, typing: true, visible: false });
  evidence(s, project.id, 'ci_recovered'); s.tick();
  assert.equal(notices(s, previous.id).length, 0);
  assert.equal(notices(s, current.id).length, 1);

  // A visible view must win even if the stored fallback still names another conversation.
  s.mutate(state => { state.projects.find(item => item.id === project.id).primarySessionId = previous.id; });
  s.presence(project.id, { sessionId: current.id, typing: false, visible: true });
  evidence(s, project.id, 'ci_recovered'); s.tick();
  assert.equal(notices(s, previous.id).length, 0);
  assert.equal(notices(s, current.id).length, 2);
});

test('后台研究不占用户回复通道；用户插话和steer照常消费，主动消息延后', t => {
  const s = new Store(fixture(t)), { project, session } = create(s);
  evidence(s, project.id, 'context'); s.tick();
  const response = s.message(session.id, { text: '先讨论界面', requestId: 'talk' });
  assert.equal(response.queued, false);
  s.message(session.id, { text: '也考虑移动端', delivery: 'steer' });
  s.tick();
  const current = sessionOf(s, session.id);
  assert.equal(current.turns[0].stage, 1);
  assert.equal(current.turns[0].steering.length, 1);
  assert.equal(projectOf(s, project.id).jobs[0].status, 'completed');
  assert.equal(notices(s, session.id).length, 0);
  ticks(s, 5);
  assert.equal(sessionOf(s, session.id).turns[0].status, 'completed');
  assert.equal(notices(s, session.id).length, 1);
  assert.equal(projectOf(s, project.id).observations.filter(o => o.kind === 'conversation').length, 2);
});

test('演示项目只读它的一句演示偏好；其余短语不再改焦点、加承诺或停主动', t => {
  const s = new Store(fixture(t)), { project, session } = create(s);
  s.message(session.id, { text: '先给结论' }); ticks(s, 6);
  assert.ok(projectOf(s, project.id).versions.some(v => v.policy.concise));
  assert.ok(projectOf(s, project.id).observations.some(o => o.kind === 'preference' && o.data.parser === 'demo-explicit-phrase'));
  const { focus, initiative } = projectOf(s, project.id);
  for (const text of ['先别改', '关注稳定性', '别打扰', '暂停后台', '继续主动']) s.message(session.id, { text });
  const after = projectOf(s, project.id);
  assert.equal(after.commitments.length, 0); assert.equal(after.focus, focus);
  assert.equal(after.initiative.enabled, initiative.enabled); assert.equal(after.initiative.quietUntil ?? null, initiative.quietUntil ?? null);
  assert.ok(after.observations.filter(o => o.data?.messageId).slice(-5).every(o => o.kind === 'conversation' && o.data.parser === 'message'));
});

// Review X-8: on a real project the demo-era phrases are plain conversation. They never overwrite the focus, add a
// hidden commitment, disable proactive work or start a fixed quiet period (all of which also rotated the scope).
test('real projects take every message as conversation evidence, whatever its wording', t => {
  const s = new Store(fixture(t)), { project, session } = create(s);
  s.mutate(state => { const p = state.projects.find(row => row.id === project.id); p.decisionMode = 'rna-model'; p.simulated = false; p.focus = '用户确认的焦点'; p.initiative.enabled = true; p.initiative.quietUntil = null; });
  for (const text of ['先给结论', '先别改', '关注稳定性', '别打扰', '暂停后台', '继续主动']) s.message(session.id, { text, delivery: 'followup' });
  const after = projectOf(s, project.id);
  assert.equal(after.focus, '用户确认的焦点'); assert.equal(after.commitments.length, 0);
  assert.equal(after.initiative.enabled, true); assert.equal(after.initiative.quietUntil, null);
  const said = after.observations.filter(o => o.data?.messageId);
  assert.equal(said.length, 6); assert.ok(said.every(o => o.kind === 'conversation' && o.relevance === 0.6 && o.data.parser === 'message'));
});

test('失败自动生成并评测候选，更优时提醒一次，不自动覆盖项目基线', t => {
  const file = fixture(t), s = new Store(file), { project, session } = create(s);
  evidence(s, project.id); ticks(s);
  const updated = projectOf(s, project.id), version = updated.versions[1];
  assert.equal(version.state, 'ready'); assert.equal(version.evaluation.gatePassed, true);
  assert.equal(updated.activeVersionId, project.activeVersionId); assert.equal(updated.trialVersionId, null);
  assert.equal(notices(s, session.id)[0].versionId, version.id);
  assert.equal(notices(s, session.id)[0].initiative.kind, 'version_ready');
  assert.ok(version.notifiedAt);
  const reopened = new Store(file); ticks(reopened, 8);
  assert.equal(notices(reopened, session.id).filter(i => i.versionId === version.id).length, 1);
});

test('没有提升的候选拒绝试用并保持安静，不每次强行宣称进化成功', t => {
  const s = new Store(fixture(t)), { project, session } = create(s);
  evidence(s, project.id, 'ci_failure', { data: { variant: 'noop' } }); ticks(s);
  const version = projectOf(s, project.id).versions[1];
  assert.equal(version.state, 'rejected'); assert.equal(version.evaluation.gatePassed, false);
  assert.equal(notices(s, session.id).length, 0);
  assert.throws(() => s.version(project.id, version.id, 'trial'), /更优/);
});

test('版本提醒在输入中延期；重启保留待投递证据且不会重复评测', t => {
  const file = fixture(t), s = new Store(file), { project, session } = create(s);
  s.presence(project.id, { sessionId: session.id, typing: true, visible: true });
  evidence(s, project.id); ticks(s);
  assert.equal(projectOf(s, project.id).versions[1].state, 'ready');
  assert.equal(notices(s, session.id).length, 0);
  const reopened = new Store(file); reopened.tick();
  assert.equal(projectOf(reopened, project.id).versions.length, 2);
  assert.equal(notices(reopened, session.id).length, 1);
  reopened.tick(); assert.equal(notices(reopened, session.id).length, 1);
});

test('试用改变项目规则检查，回滚恢复；项目隔离且已启动轮次绑定原版本', t => {
  const s = new Store(fixture(t)), a = create(s), b = create(s);
  const sample = { signal: true, revision: false, smoke: true };
  evidence(s, a.project.id); ticks(s);
  const version = projectOf(s, a.project.id).versions[1];
  s.message(a.session.id, { text: '先看当前策略' });
  const firstTurn = sessionOf(s, a.session.id).turns[0];
  s.version(a.project.id, version.id, 'trial');
  assert.equal(s.projectCheck(a.project.id, sample).reuse, false);
  assert.equal(s.projectCheck(b.project.id, sample).reuse, true);
  assert.equal(sessionOf(s, a.session.id).turns[0].versionId, firstTurn.versionId);
  s.controlSession(a.session.id, 'stop'); s.message(a.session.id, { text: '测试新版' });
  assert.equal(sessionOf(s, a.session.id).turns[1].versionId, version.id);
  s.version(a.project.id, version.id, 'rollback'); assert.equal(s.projectCheck(a.project.id, sample).reuse, true);
  s.version(a.project.id, version.id, 'trial'); s.version(a.project.id, version.id, 'adopt');
  assert.equal(projectOf(s, a.project.id).activeVersionId, version.id);
  assert.throws(() => s.version(b.project.id, version.id, 'trial'), /不存在/);
});

test('项目预算阻止学习且不丢证据；提高预算后继续，免打扰和冷却不会刷日志', t => {
  const s = new Store(fixture(t)), { project, session } = create(s);
  s.updateProject(project.id, { initiative: { budgetUsd: 0 } }); evidence(s, project.id); s.tick();
  assert.equal(projectOf(s, project.id).initiative.spentUsd, 0);
  assert.equal(projectOf(s, project.id).jobs.length, 0);
  const before = s.get(); ticks(s, 3); assert.deepEqual(s.get(), before);
  s.updateProject(project.id, { initiative: { budgetUsd: 0.5, quietUntil: new Date(Date.now() + 60000).toISOString() } }); s.tick();
  assert.equal(projectOf(s, project.id).jobs.length, 0);
  s.updateProject(project.id, { initiative: { quietUntil: null } }); ticks(s);
  assert.equal(notices(s, session.id).length, 1);
  s.updateProject(project.id, { initiative: { cooldownMs: 60000 } }); evidence(s, project.id, 'ci_recovered'); s.tick();
  assert.equal(notices(s, session.id).length, 1);
  assert.match(projectOf(s, project.id).decisions.at(-1).reason, /冷却/);
});

// UX audit 2026-10-03 item 19 (F62, contract C-h): lifting the stop brings back the proactive work it switched off.
test('全局预算、token和急停仍约束后台；解除急停自动恢复急停关掉的项目', t => {
  const s = new Store(fixture(t)), { project } = create(s);
  evidence(s, project.id); s.settings({ tokenBudget: 100 }); s.tick();
  assert.equal(projectOf(s, project.id).jobs.length, 0);
  s.settings({ tokenBudget: 100000 }); s.emergency(true); s.tick();
  assert.equal(projectOf(s, project.id).initiative.enabled, false); assert.equal(projectOf(s, project.id).initiative.pausedByEmergency, true);
  assert.equal(projectOf(s, project.id).jobs.length, 0);
  assert.throws(() => s.updateProject(project.id, { initiative: { enabled: true } }), /急停/);
  s.emergency(false);
  assert.equal(projectOf(s, project.id).initiative.enabled, true); assert.equal(projectOf(s, project.id).initiative.pausedByEmergency, undefined);
  s.tick();
  assert.equal(projectOf(s, project.id).jobs.length, 1);
});

test('新增项目会话共享项目上下文；跨项目presence和非法参数不写盘', t => {
  const s = new Store(fixture(t)), a = create(s), b = create(s);
  const next = s.createSession({ projectId: a.project.id });
  assert.equal(next.projectId, a.project.id); assert.ok(projectOf(s, a.project.id).sessionIds.includes(next.id));
  const before = s.get();
  assert.throws(() => s.presence(a.project.id, { sessionId: b.session.id, typing: true, visible: true }), /不属于/);
  assert.throws(() => s.observeProject(a.project.id, { kind: 'invented', text: 'x' }), /观察类型/);
  assert.throws(() => s.projectCheck(a.project.id, { signal: 'yes', revision: true, smoke: true }), /布尔/);
  assert.deepEqual(s.get(), before);
});

test('旧v2状态增加项目字段时备份原字节，不为旧会话隐式安排自主任务', t => {
  const file = fixture(t), s = new Store(file), session = s.createSession();
  const old = s.get(); delete old.projects; const bytes = JSON.stringify(old); writeFileSync(file, bytes);
  const reopened = new Store(file);
  assert.equal(readFileSync(`${file}.before-projects-backup`, 'utf8'), bytes);
  assert.deepEqual(reopened.get().projects, []); assert.deepEqual(sessionOf(reopened, session.id), session);
});

test('HTTP无持续浏览器请求也会主动接话；presence接口不落盘', async t => {
  const file = fixture(t), { server, store } = createServer({ stateFile: file, tickIntervalMs: 25 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, data, method = 'POST') => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); assert.ok(r.ok); return r.json(); };
  const { project, session } = await request('/api/projects', { demo: true, initiative: { cooldownMs: 0 } });
  for (let i = 0; i < 40 && !notices(store, session.id).length; i++) await delay(25);
  assert.equal(notices(store, session.id).length, 1); assert.equal(store.get().goals.length, 0);
  const disk = readStateText(file);
  await request(`/api/projects/${project.id}/presence`, { sessionId: session.id, typing: true, visible: true });
  assert.equal(readStateText(file), disk);
  await request(`/api/projects/${project.id}/observations`, { kind: 'ci_failure', text: '缓存复用验证失败', eventId: 'http-failure' });
  for (let i = 0; i < 40 && projectOf(store, project.id).versions.length < 2; i++) await delay(25);
  const version = projectOf(store, project.id).versions[1];
  await request(`/api/projects/${project.id}/versions/${version.id}/control`, { action: 'trial' });
  const check = await request(`/api/projects/${project.id}/checks`, { signal: true, revision: false, smoke: true });
  assert.equal(check.reuse, false);
});

test('没有可投递会话时保留主动结论与预算，后续绑定会话才发送', t => {
  const s = new Store(fixture(t)), { project } = create(s);
  s.mutate(state => { state.sessions = []; state.projects[0].sessionIds = []; state.projects[0].primarySessionId = null; });
  evidence(s, project.id, 'ci_recovered'); s.tick();
  assert.equal(projectOf(s, project.id).initiative.spentUsd, 0);
  assert.equal(projectOf(s, project.id).observations[0].status, 'pending');
  assert.match(projectOf(s, project.id).decisions.at(-1).reason, /没有可投递/);
  const session = s.createSession({ projectId: project.id }); s.tick();
  assert.equal(notices(s, session.id).length, 1);
});

test('用户改变项目焦点后，旧后台研究不能覆盖或推送过时建议', t => {
  const s = new Store(fixture(t)), { project, session } = create(s);
  evidence(s, project.id, 'context'); s.tick();
  s.updateProject(project.id, { focus: '先解决稳定性' }); s.tick();
  assert.equal(projectOf(s, project.id).jobs[0].status, 'superseded');
  assert.equal(notices(s, session.id).length, 0);
  ticks(s); assert.match(notices(s, session.id)[0].text, /先解决稳定性/);
});

test('取回未消费队列偏好不会错误触发自主进化', t => {
  const s = new Store(fixture(t)), { project, session } = create(s);
  s.message(session.id, { text: '先讨论方案' });
  const pending = s.message(session.id, { text: '先给结论', delivery: 'followup' }); s.tick();
  assert.equal(projectOf(s, project.id).jobs.length, 0);
  s.removeInbox(session.id, pending.entry.id); ticks(s, 6);
  assert.equal(projectOf(s, project.id).versions.length, 1);
  assert.equal(projectOf(s, project.id).observations.find(o => o.data.messageId === pending.entry.id).status, 'withdrawn');
});

test('后台评测固定基线；用户采用其他新版后不能试用过时候选', t => {
  const s = new Store(fixture(t)), { project } = create(s);
  evidence(s, project.id, 'preference'); ticks(s);
  const first = projectOf(s, project.id).versions[1];
  evidence(s, project.id, 'ci_failure'); s.tick();
  const job = projectOf(s, project.id).jobs[1]; assert.equal(job.baseVersionId, project.activeVersionId);
  s.version(project.id, first.id, 'trial'); s.version(project.id, first.id, 'adopt'); s.tick();
  const stale = projectOf(s, project.id).versions[2];
  assert.equal(stale.state, 'stale'); assert.equal(stale.parentVersionId, project.activeVersionId);
  assert.throws(() => s.version(project.id, stale.id, 'trial'), /更优/);
});

test('reading presence (visible, not typing) outlasts a typing report so a slow heartbeat keeps the user present', t => {
  const s = new Store(fixture(t)), { project, session } = create(s);
  const ttl = input => { const saved = s.presence(project.id, { sessionId: session.id, ...input }); return Date.parse(saved.expiresAt) - Date.parse(saved.at); };
  const near = (value, expected) => assert.ok(Math.abs(value - expected) < 1000, `${value} ≈ ${expected}`);
  near(ttl({ typing: true, visible: true }), 10000);
  near(ttl({ typing: false, visible: true }), 45000);
  near(ttl({ typing: false, visible: false }), 10000);
});
