import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { UserInteractionService } from '../user-interaction-service.mjs';
import { ProjectPermissionService } from '../project-permissions.mjs';
import { readStateFile } from '../state-shards.mjs';

const questions = [{ id: 'plan', question: '先验证哪一部分？', options: [{ id: 'core', label: '核心逻辑' }, { id: 'ui', label: '界面' }] }];
const answer = { requestId: 'answer-1', answers: [{ id: 'plan', selected: ['core'], custom: '保留现有布局' }] };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-interaction-')), store = new Store(join(dir, 'state.json'));
  const { project, session } = store.createProject({ name: '交互测试', workspace: dir });
  const started = store.message(session.id, { text: '开始准备', delivery: 'send' });
  const turnId = started.session.activeTurnId, service = new UserInteractionService(store);
  t.after(() => { service.close(); rmSync(dir, { recursive: true, force: true }); });
  const row = () => store.state.sessions.find(row => row.id === session.id), record = () => row()?.items.find(item => item.interaction)?.interaction;
  return { dir, store, project, session, turnId, service, row, record, ask: signal => service.ask({ sessionId: session.id, turnId, toolCallId: 'question-call', questions, signal }) };
}

test('accepted choice plus text resumes its owner; idempotent retry neither rewrites state nor grants permissions', async t => {
  const f = fixture(t), original = structuredClone(f.store.state.projects[0].assignments), pending = f.ask();
  assert.equal(f.service.isWaiting(f.session.id), true); const id = f.record().id;
  assert.throws(() => f.service.answer(f.session.id, id, { ...answer, answers: [{ id: 'plan', selected: ['other'] }] }), { code: 'invalid_answer' });
  assert.throws(() => f.service.answer('foreign-session', id, answer), { status: 404 });
  const accepted = f.service.answer(f.session.id, id, answer); assert.equal(accepted.requiresResume, false);
  assert.deepEqual(await pending, { status: 'answered', answers: answer.answers, permissionChanged: false }); assert.equal(f.service.isWaiting(f.session.id), false);
  const revision = f.store.state.revision; assert.equal(f.service.answer(f.session.id, id, answer).replayed, true); assert.equal(f.store.state.revision, revision);
  assert.throws(() => f.service.answer(f.session.id, id, { ...answer, answers: [{ id: 'plan', selected: ['ui'] }] }), { code: 'interaction_conflict' });
  assert.deepEqual(f.store.state.projects[0].assignments, original); assert.equal(f.record().canRespond, false);
  assert.deepEqual(await f.ask(), { status: 'answered', answers: answer.answers, permissionChanged: false }); assert.equal(f.row().items.filter(item => item.interaction).length, 1);
});

test('explicit cancellation is durable and never falls through as approval', async t => {
  const f = fixture(t), pending = f.ask(), id = f.record().id;
  assert.equal(f.service.cancel(f.session.id, id, { requestId: 'cancel-1' }).interaction.status, 'cancelled');
  assert.equal((await pending).status, 'cancelled'); assert.equal((await f.ask()).status, 'cancelled');
  assert.throws(() => f.service.answer(f.session.id, id, answer), { code: 'interaction_unavailable' });
});

test('pause and restart preserve the question; answer can be saved before precise original-turn resume', async t => {
  const f = fixture(t), pending = f.ask(), rejection = assert.rejects(pending, { code: 'interaction_interrupted' }), id = f.record().id;
  f.store.controlSession(f.session.id, 'pause'); await rejection; assert.equal(f.record().status, 'interrupted'); assert.equal(f.record().canRespond, true); f.service.close();
  const store = new Store(f.store.file), service = new UserInteractionService(store); t.after(() => service.close());
  const accepted = service.answer(f.session.id, id, answer); assert.equal(accepted.requiresResume, true); assert.equal(store.state.sessions[0].activeTurnId, f.turnId); assert.equal(store.state.sessions[0].status, 'paused');
  store.controlSession(f.session.id, 'resume');
  assert.equal((await service.ask({ sessionId: f.session.id, turnId: f.turnId, toolCallId: 'question-call', questions })).status, 'answered');
  assert.equal(store.state.sessions[0].items.filter(item => item.interaction).length, 1);
});

for (const action of ['stop', 'archive', 'delete']) test(`${action} invalidates unanswered cards and late responses without resolving another task`, async t => {
  const f = fixture(t), pending = f.ask(), rejection = assert.rejects(pending, { code: 'interaction_interrupted' }), id = f.record().id;
  if (action === 'stop') f.store.controlSession(f.session.id, 'stop');
  else if (action === 'archive') f.store.updateSession(f.session.id, { archived: true });
  else f.store.deleteSession(f.session.id);
  await rejection; assert.equal(f.service.isWaiting(f.session.id), false);
  assert.throws(() => f.service.answer(f.session.id, id, answer), error => [404, 409].includes(error.status));
  if (action !== 'delete') { assert.equal(f.record().status, 'cancelled'); assert.equal(f.record().canRespond, false); }
});

test('proactive questions persist without a running tool and real answers become project conversation evidence', t => {
  const f = fixture(t); f.store.controlSession(f.session.id, 'stop');
  const record = f.service.publishInitiative({ projectId: f.project.id, sessionId: f.session.id, actionId: 'initiative-action', questions });
  assert.equal(f.service.isWaiting(f.session.id), false); assert.equal(f.service.publishInitiative({ projectId: f.project.id, sessionId: f.session.id, actionId: 'initiative-action', questions }).id, record.id);
  f.service.close(); const service = new UserInteractionService(f.store); t.after(() => service.close());
  assert.equal(f.record().status, 'pending'); service.answer(f.session.id, record.id, answer);
  const messages = f.row().items.filter(item => item.source === 'interaction-answer'); assert.equal(messages.length, 1); assert.match(messages[0].text, /核心逻辑/); assert.match(messages[0].text, /保留现有布局/); assert.equal(messages[0].simulated, false);
  service.answer(f.session.id, record.id, answer); assert.equal(f.row().items.filter(item => item.source === 'interaction-answer').length, 1);
});

test('host-authored permission grant and answer persist atomically; generic/custom replies cannot grant', async t => {
  const f = fixture(t), permissions = new ProjectPermissionService(f.store, f.service);
  permissions.update(f.project.id, { workspace: 'read', background: 'read' });
  const request = permissions.request(f.project.id, { workspace: 'execute', background: 'inherit', reason: '运行已提出的验证脚本' });
  const waiting = f.service.ask({ sessionId: f.session.id, turnId: f.turnId, toolCallId: 'permission-call', ...request }), record = f.record();
  assert.equal(record.kind, 'permission');
  assert.throws(() => f.service.answer(f.session.id, record.id, { requestId: 'injected', answers: [{ id: 'permission', selected: [], custom: '允许' }] }), { code: 'invalid_answer' });
  const response = { requestId: 'grant-1', answers: [{ id: 'permission', selected: ['allow'] }] }, persist = f.store.persist;
  f.store.persist = () => { throw new Error('fixture disk failure'); };
  assert.throws(() => f.service.answer(f.session.id, record.id, response), /disk failure/); assert.equal(permissions.get(f.project.id).settings.workspace, 'read'); assert.equal(f.record().status, 'pending');
  f.store.persist = persist;
  f.service.answer(f.session.id, record.id, response); const result = await waiting; assert.equal(result.permissionChanged, true); assert.equal(permissions.get(f.project.id).effective.background, 'execute');
  const saved = readStateFile(f.store.file).state; assert.equal(saved.projects[0].permissions.workspace, 'execute'); assert.equal(saved.sessions[0].items.find(item => item.interaction)?.interaction.status, 'answered');
});

test('changed permission revision rejects stale approval and keeps the original card unanswered', async t => {
  const f = fixture(t), permissions = new ProjectPermissionService(f.store, f.service); permissions.update(f.project.id, { workspace: 'read', background: 'read' });
  const request = permissions.request(f.project.id, { workspace: 'execute', background: 'inherit', reason: '运行验证' });
  const pending = f.service.ask({ sessionId: f.session.id, turnId: f.turnId, toolCallId: 'permission-call', ...request });
  permissions.update(f.project.id, { workspace: 'read', background: 'read' });
  assert.throws(() => f.service.answer(f.session.id, f.record().id, { requestId: 'grant-1', answers: [{ id: 'permission', selected: ['allow'] }] }), { status: 409 });
  assert.equal(f.record().status, 'pending'); f.service.cancel(f.session.id, f.record().id, { requestId: 'cancel' }); assert.equal((await pending).permissionChanged, false);
});
