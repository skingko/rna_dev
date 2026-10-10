import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
const questions = [{ id: 'next', question: '先检查哪一部分？', options: [{ id: 'runtime', label: '运行逻辑' }, { id: 'ui', label: '交互界面' }] }];
async function until(check) { const deadline = Date.now() + 5000; while (!check()) { if (Date.now() > deadline) throw new Error('Interaction fixture did not reach expected state'); await delay(10); } }
async function fixture(t, permission = false) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-proactive-question-')); let calls = 0;
  const app = createServer({ stateFile: join(dir, 'state.json'), ticks: false, runtime: false, initiative: true, initiativeOptions: { tickIntervalMs: 0, initialDelayMs: 0, decisionProvider: async function* (request) {
    calls++; const input = JSON.parse(request.messages[0].content[0].text);
    assert.ok(input.availableActions.includes('ask')); assert.equal(input.hostActionContracts.ask.enabled, true);
    const answerEvidence = input.events.find(event => event.type === 'user_message');
    const output = answerEvidence ? { action: 'wait', reason: 'The actual structured answer is now evidence.', evidenceIds: [answerEvidence.id], content: '', nextReviewAfterMs: 60000 } : { action: 'ask', reason: 'A concrete choice blocks the next useful step.', evidenceIds: [input.events[0].id], content: '请确认这一步', nextReviewAfterMs: 60000, ...(permission ? { permissionRequest: { workspace: 'execute', background: 'inherit', reason: '在项目目录运行已提出的测试' } } : { questions }) };
    yield { type: 'text_delta', delta: JSON.stringify(output) }; yield { type: 'usage', usage: { totalTokens: 20 } }; yield { type: 'done' };
  } } });
  await app.initializer.close(); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const provider = app.store.configurationService.provider(null, { name: 'Local fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 2048, reasoning: ['off'] }] });
  app.store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = app.store.createProject({ rhythm: { control: 'manual' }, name: '结构化主动确认', workspace: dir, initiative: { cooldownMs: 0 } });
  app.store.mutate(state => { const row = state.projects.find(row => row.id === project.id); Object.assign(row, { decisionMode: 'rna-model', simulated: false, initialization: { status: 'ready' }, permissions: { workspace: 'read', background: 'read', revision: 1 } }); });
  const record = () => app.store.state.sessions.find(row => row.id === session.id).items.find(item => item.interaction)?.interaction;
  await until(() => record()?.status === 'pending'); await until(() => app.projectInitiative.contexts.get(project.id)?.coordinator.active.size === 0);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const respond = async input => { const response = await fetch(`${base}/api/sessions/${session.id}/interactions/${record().id}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); return { status: response.status, body: await response.json() }; };
  return { ...app, project, session, record, respond, calls: () => calls };
}
test('autonomous decision creates an interactive card without holding a worker; answer becomes actual external evidence', async t => {
  const f = await fixture(t); assert.equal(f.calls(), 1); assert.equal(f.record().source, 'initiative'); assert.equal(f.interactions.isWaiting(f.session.id), false);
  const invalid = await f.respond({ requestId: 'invalid', answers: [{ id: 'next', selected: ['missing'] }] }); assert.equal(invalid.status, 400);
  const result = await f.respond({ requestId: 'answer', answers: [{ id: 'next', selected: ['runtime'], custom: '保留原布局' }] }); assert.equal(result.status, 200);
  await until(() => f.calls() === 2); assert.equal(f.record().status, 'answered'); assert.equal(f.permissions.get(f.project.id).settings.workspace, 'read');
  const state = f.store.state.projects.find(row => row.id === f.project.id).initiativeRuntime.sdkState; assert.equal(state.events.filter(row => row.type === 'action_completed').length, 0);
});
test('autonomous permission requests use host-generated scope choices and only explicit allow changes permissions', async t => {
  const f = await fixture(t, true); assert.equal(f.record().kind, 'permission'); assert.deepEqual(f.record().questions[0].options.map(option => option.id), ['allow', 'deny']); assert.equal(f.permissions.get(f.project.id).effective.background, 'read');
  const response = await f.respond({ requestId: 'grant', answers: [{ id: 'permission', selected: ['allow'] }] }); assert.equal(response.status, 200); assert.equal(response.body.interaction.permissionChanged, true); assert.equal(f.permissions.get(f.project.id).effective.background, 'execute');
  await until(() => f.calls() >= 2); assert.equal(f.record().status, 'answered');
});
test('host restart retains communication outcomes for review without treating a delivered question as an unknown external execution', async t => {
  const f = await fixture(t); await f.projectInitiative.close();
  f.store.mutate(state => { const saved = state.projects.find(project => project.id === f.project.id).initiativeRuntime.sdkState;
    saved.actions = [{ id: 'pending-question', action: 'ask', status: 'running' }, { id: 'pending-work', action: 'work', status: 'running' }];
  });
  const host = { store: f.store, now: Date.now, mutate: fn => f.store.mutate(fn) };
  ProjectInitiativeController.prototype.recover.call(host);
  const actions = f.store.state.projects.find(project => project.id === f.project.id).initiativeRuntime.sdkState.actions;
  assert.equal(actions[0].status, 'needs_review'); assert.equal(actions[0].blocksExecution, false);
  assert.equal(actions[1].status, 'needs_review'); assert.equal(actions[1].blocksExecution, true);
  assert.equal(f.record().status, 'pending'); assert.equal(f.record().canRespond, true);
});
