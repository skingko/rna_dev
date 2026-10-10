import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../store.mjs';
import { ProjectScheduleService } from '../project-schedule-service.mjs';
import { createServer } from '../server.mjs';

const at = Date.parse('2026-09-26T02:00:00Z');
const draft = { title: '每日调研', task: '核查一手来源，更新项目日报并在本会话报告结果。', rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-schedules-')), file = join(dir, 'state.json'), store = new Store(file);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { project, session } = store.createProject({ name: 'Research', workspace: dir });
  return { dir, file, store, project, session, service: new ProjectScheduleService(store, { now: () => at }) };
}

test('project schedule creation persists through restart with unique request identity, destination validation and no execution', t => {
  const f = fixture(t), input = structuredClone(draft), saved = f.service.create(f.project.id, input, { requestId: 'daily-request' });
  assert.equal(saved.nextRunAt, '2026-09-27T01:00:00.000Z');
  assert.equal(saved.destinationSessionId, f.session.id);
  assert.deepEqual(f.service.create(f.project.id, input, { requestId: 'daily-request' }), saved);
  assert.throws(() => f.service.create(f.project.id, { ...input, task: 'changed' }, { requestId: 'daily-request' }), /相同请求/);
  const second = f.store.createProject({ name: 'Other', workspace: f.dir });
  assert.throws(() => f.service.create(f.project.id, { ...input, destinationSessionId: second.session.id }), /当前项目/);
  const restored = new Store(f.file), view = new ProjectScheduleService(restored, { now: () => at }).list(f.project.id);
  assert.equal(view.schedules.length, 1); assert.equal(view.schedules[0].state, 'scheduled'); assert.deepEqual(view.occurrences, []);
  assert.equal(restored.state.sessions.find(row => row.id === f.session.id).turns.length, 0);
  assert.deepEqual(input, draft);
  f.service.remove(f.project.id, saved.id);
  const afterDeletion = new ProjectScheduleService(new Store(f.file), { now: () => at });
  assert.throws(() => afterDeletion.create(f.project.id, input, { requestId: 'daily-request' }), /已删除/);
  assert.equal(afterDeletion.list(f.project.id).schedules.length, 0, 'an old request must not resurrect a cancelled schedule after restart');
});

test('schedule tool obeys actual write permissions, bounded schema and explicit lifecycle without granting background execution', async t => {
  const f = fixture(t);
  f.store.mutate(state => { state.projects[0].permissions = { workspace: 'read', background: 'read' }; });
  const tools = f.service.createTools({ projectId: f.project.id, sessionId: f.session.id }), write = tools.find(tool => tool.name === 'project_schedule');
  assert.equal((await write.execute('create-1', { action: 'create', ...draft })).isError, true);
  assert.equal(f.service.list(f.project.id).schedules.length, 0);
  f.store.mutate(state => { state.projects[0].permissions.workspace = 'write'; });
  const saved = JSON.parse((await write.execute('create-1', { action: 'create', ...draft })).content[0].text);
  assert.equal(saved.destinationSessionId, f.session.id);
  const paused = f.service.update(f.project.id, saved.id, { enabled: false }); assert.equal(paused.enabled, false); assert.equal(paused.revision, 2);
  assert.equal(f.store.state.projects[0].permissions.background, 'read');
  assert.throws(() => f.service.update(f.project.id, saved.id, { nextRunAt: '2026-09-26T02:01:00Z' }), /有效/);
  assert.throws(() => f.service.update(f.project.id, saved.id, { rule: { kind: 'daily', time: '25:00', timeZone: 'Asia/Shanghai' } }), /HH:mm/);
  assert.equal(f.service.remove(f.project.id, saved.id).deleted, true); assert.equal(f.service.list(f.project.id).schedules.length, 0);
});

test('HTTP and CLI expose one persistent schedule lifecycle and do not run a model or synthesize a user turn', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-schedule-cli-'));
  const app = createServer({ stateFile: join(dir, 'state.json'), ticks: false, runtime: false }); await app.initializer.close();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.server.closeAllConnections(); await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const { project, session } = app.store.createProject({ name: 'Weekly review', workspace: dir });
  const file = join(dir, 'schedule.json'); writeFileSync(file, JSON.stringify({ ...draft, rule: { kind: 'weekly', days: [1, 5], time: '10:30', timeZone: 'Europe/London' } }));
  const run = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, [join(import.meta.dirname, '../cli.mjs'), 'schedule', project.id, ...args], { env: { ...process.env, RNA_AGENT_PORT: String(app.server.address().port) }, timeout: 10000 })).stdout);
  const saved = await run('create', '--file', file, '--request-id', 'cli-once');
  assert.equal((await run('create', '--file', file, '--request-id', 'cli-once')).id, saved.id);
  assert.equal((await run('list')).schedules.length, 1);
  assert.equal((await run('pause', saved.id)).enabled, false);
  assert.equal((await run('resume', saved.id)).enabled, true);
  assert.equal((await run('delete', saved.id)).deleted, true);
  assert.equal((await run('list')).schedules.length, 0);
  assert.equal(app.store.state.sessions.find(row => row.id === session.id).turns.length, 0);
});
