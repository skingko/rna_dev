import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from '../server.mjs';

const run = promisify(execFile), cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const questions = [{ id: 'direction', question: '先做哪一部分？', options: [{ id: 'logic', label: '运行逻辑' }, { id: 'ui', label: '界面' }] }];
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-interaction-cli-'));
  const app = createServer({ stateFile: join(dir, 'state.json'), ticks: false, runtime: false, initiative: false });
  await app.initializer.close(); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const { project, session } = app.store.createProject({ name: 'CLI 交互', workspace: dir });
  app.permissions.update(project.id, { workspace: 'read', background: 'read' });
  const env = { ...process.env, RNA_AGENT_PORT: String(app.server.address().port) };
  const invoke = (...args) => run(process.execPath, [cli, ...args], { env, timeout: 15000 });
  const json = async (...args) => JSON.parse((await invoke(...args)).stdout);
  let sequence = 0;
  const publish = (input = {}) => app.interactions.publishInitiative({ projectId: project.id, sessionId: session.id, actionId: `cli-${++sequence}`, questions, ...input });
  const file = (value, name = 'answer.json') => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value)); return path; };
  return { ...app, project, session, invoke, json, publish, file };
}
test('CLI shows stable question/option IDs, submits supplemental answers from a file and safely retries', async t => {
  const f = await fixture(t), question = f.publish();
  const listed = await f.json('questions', f.session.id);
  assert.equal(listed.interactions[0].id, question.id); assert.equal(listed.interactions[0].questions[0].options[0].id, 'logic');
  const path = f.file({ answers: [{ id: 'direction', selected: ['logic'], custom: '保持已有布局' }] });
  const answer = await f.json('answer', f.session.id, question.id, '--answers-file', path);
  assert.equal(answer.interaction.status, 'answered'); assert.equal(answer.interaction.answers[0].custom, '保持已有布局');
  const revision = f.store.state.revision;
  assert.equal((await f.json('answer', f.session.id, question.id, '--answers-file', path)).replayed, true);
  assert.equal(f.store.state.revision, revision); assert.equal(f.permissions.get(f.project.id).settings.workspace, 'read');
  const changed = f.file({ answers: [{ id: 'direction', selected: ['ui'] }] }, 'changed.json');
  await assert.rejects(f.invoke('answer', f.session.id, question.id, '--answers-file', changed), error => error.code === 1);
});
test('CLI cancellation is durable and idempotent; chat prints complete interaction IDs and offered option IDs', async t => {
  const f = await fixture(t), question = f.publish();
  const chat = f.invoke('chat', f.session.id); chat.child.stdin.end('/quit\n');
  const { stdout } = await chat; assert.ok(stdout.includes(question.id)); assert.match(stdout, /问题 direction/); assert.match(stdout, /logic · 运行逻辑/); assert.match(stdout, /answer <会话ID>/);
  assert.equal((await f.json('cancel-question', f.session.id, question.id)).interaction.status, 'cancelled');
  assert.equal((await f.json('cancel-question', f.session.id, question.id)).replayed, true);
  assert.equal((await f.json('questions', f.session.id)).interactions[0].canRespond, false);
});
test('CLI fixed permission card and explicit settings update use the same real project grant/revoke policy', async t => {
  const f = await fixture(t), request = f.permissions.request(f.project.id, { workspace: 'execute', background: 'inherit', reason: '运行本项目测试' });
  const question = f.publish(request);
  assert.equal((await f.json('permissions', f.project.id)).effective.background, 'read');
  const path = f.file({ answers: [{ id: 'permission', selected: ['allow'] }] });
  assert.equal((await f.json('answer', f.session.id, question.id, '--answers-file', path)).interaction.permissionChanged, true);
  const granted = await f.json('permissions', f.project.id); assert.equal(granted.effective.background, 'execute');
  assert.ok(f.store.state.projects.find(project => project.id === f.project.id).assignments.toolIds.includes('project_exec'));
  const revoked = await f.json('permissions-set', f.project.id, '--workspace', 'write', '--background', 'read');
  assert.deepEqual(revoked.settings, { workspace: 'write', background: 'read' }); assert.equal(revoked.effective.background, 'read');
  assert.ok(!f.store.state.projects.find(project => project.id === f.project.id).assignments.toolIds.includes('project_exec'));
});
test('CLI rejects inline authority fields, unknown choices, wrong ownership and incomplete scope without granting', async t => {
  const f = await fixture(t), question = f.publish(), other = f.store.createSession({ title: '另一会话', projectId: f.project.id });
  const good = f.file({ answers: [{ id: 'direction', selected: ['logic'] }] });
  const injected = f.file({ answers: [{ id: 'direction', selected: ['logic'] }], workspace: 'execute' }, 'bad.json');
  const unknown = f.file({ answers: [{ id: 'direction', selected: ['missing'] }] }, 'unknown.json');
  for (const args of [
    ['answer', f.session.id, question.id],
    ['answer', f.session.id, question.id, '--answers-file', injected],
    ['answer', f.session.id, question.id, '--answers-file', unknown],
    ['answer', other.id, question.id, '--answers-file', good],
    ['answer', f.session.id, question.id, '--answers-file', good, '--request-id', '../bad'],
    ['permissions-set', f.project.id, '--workspace', 'execute'],
    ['permissions-set', f.project.id, '--workspace', 'execute', '--background', 'all'],
    ['cancel-question', f.session.id, question.id, '--answers-file', good]
  ]) await assert.rejects(f.invoke(...args), error => error.code === 1 && /Rna Agent:/.test(error.stderr));
  assert.equal(f.interactions.lookup(f.session.id, question.id).record.status, 'pending');
  assert.deepEqual(f.permissions.get(f.project.id).settings, { workspace: 'read', background: 'read' });
});
