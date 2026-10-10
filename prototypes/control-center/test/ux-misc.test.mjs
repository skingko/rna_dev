import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../server.mjs';
import { initialMaintenance, persistMaintenance, changeMaintenance } from '../application-maintenance-state.mjs';

test('maintenance holds writes but keeps the file tree, file contents, raw images and schedules readable', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-ux-misc-')), stateFile = join(dir, 'state.json'), workspace = join(dir, 'work');
  await mkdir(workspace); await writeFile(join(workspace, 'notes.md'), '# 笔记\n'); await writeFile(join(workspace, 'cover.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const app = createServer({ stateFile, ticks: false, runtime: false, initiative: false });
  await app.initializer.close();
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.server.address().port}`, { project, session } = app.store.createProject({ name: 'Reads', workspace });
  const row = persistMaintenance(stateFile, initialMaintenance('backup', {}, randomUUID(), {})); app.maintenanceGate.refresh();
  assert.equal(app.maintenanceGate.held, true);
  for (const path of [`/api/projects/${project.id}/files?path=`, `/api/projects/${project.id}/file?path=notes.md`, `/api/projects/${project.id}/file/raw?path=cover.png`, `/api/projects/${project.id}/schedules`, `/api/projects/${project.id}/permissions`, `/api/sessions/${session.id}/commands`]) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 200, path); await response.arrayBuffer();
  }
  assert.equal((await (await fetch(`${url}/api/projects/${project.id}/file?path=notes.md`)).json()).content, '# 笔记\n');
  const write = await fetch(`${url}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'draft' }) });
  assert.equal(write.status, 503); assert.equal((await write.json()).code, 'maintenance_held');
  assert.equal((await (await fetch(`${url}/api/health`)).json()).workload.admittedHttp, 0);
  await changeMaintenance(stateFile, row.id, value => ({ ...value, held: false, phase: 'cancelled' })); app.maintenanceGate.refresh();
});

test('memory sync history rows carry a readable line in the interface language next to their code', async () => {
  const { projectMemorySyncStatus } = await import('../memory-sync-status.mjs');
  const project = { id: 'p' }, sessions = [{ id: 's', projectId: 'p', turns: [
    { id: 'a', status: 'completed', memoryWrite: { status: 'failed', code: 'MEMORY_EXTRACTION_FAILED', updatedAt: '2026-10-01T00:00:00Z' } },
    { id: 'b', status: 'completed', memoryWrite: { status: 'uncertain', code: 'MEMORY_SOURCE_CHANGED' } },
    { id: 'c', status: 'completed', memoryWrite: { status: 'failed', code: 'MEMORY_SOMETHING_NEW' } },
  ] }];
  // All three are settled: history rows (A2), still with their readable line.
  const zh = projectMemorySyncStatus({ projects: [project], sessions }, project).sessions[0].history;
  assert.deepEqual(zh.map(issue => issue.code), ['MEMORY_EXTRACTION_FAILED', 'MEMORY_SOURCE_CHANGED', 'MEMORY_SOMETHING_NEW']);
  assert.match(zh[0].message, /记忆提炼没有成功.*原文不受影响/); assert.match(zh[1].message, /修改或撤回/); assert.equal(zh[2].message, '这一段没有同步成功。');
  for (const issue of zh) assert.doesNotMatch(issue.message, /MEMORY_/);
  const en = projectMemorySyncStatus({ projects: [project], sessions, settings: { interfaceLanguage: 'en' } }, project).sessions[0].history;
  assert.match(en[0].message, /^This turn was archived/); assert.equal(en[2].message, 'This part did not sync.');
  const delivery = projectMemorySyncStatus({ projects: [project], sessions: [{ id: 'd', projectId: 'p', turns: [], memoryEvidenceOutbox: [{ id: 'e', status: 'uncertain', code: 'MEMORY_SOURCE_CHANGED' }] }] }, project).sessions[0].history[0];
  assert.equal(delivery.evidenceId, 'e'); assert.match(delivery.message, /^这份交付/);
});

test('every failure code memory sync records has its own readable line; a rejected write says the service refused it', async () => {
  const { readFile } = await import('node:fs/promises');
  const { projectMemorySyncStatus } = await import('../memory-sync-status.mjs');
  // Codes memory-sync writes on a write or its index, plus the one memory-service's evidence cleanup throws that it records as is.
  const source = `${await readFile(new URL('../memory-sync.mjs', import.meta.url), 'utf8')}\n'MEMORY_EVIDENCE_IDENTITY_UNVERIFIED'`;
  // Settled outcomes, not issues: skipped and retained writes never reach the list.
  const settled = new Set(['MEMORY_COMMIT_SKIPPED', 'MEMORY_RETAINED_FOR_NEXT_COMMIT']);
  const codes = [...new Set(source.match(/'MEMORY_[A-Z_]+'/g).map(code => code.slice(1, -1)))].filter(code => !settled.has(code));
  assert.ok(codes.length >= 15, codes.join());
  const project = { id: 'p' }, issue = (code, language, evidence = false) => projectMemorySyncStatus({ projects: [project], settings: { interfaceLanguage: language }, sessions: [evidence
    ? { id: 's', projectId: 'p', turns: [], memoryEvidenceOutbox: [{ id: 'e', status: 'failed', code }] }
    : { id: 's', projectId: 'p', turns: [{ id: 't', status: 'completed', memoryWrite: { status: 'failed', code } }] }] }, project).sessions[0].history[0].message;
  for (const code of codes.filter(code => code !== 'MEMORY_SYNC_FAILED')) for (const language of ['zh', 'en']) assert.notEqual(issue(code, language), language === 'zh' ? '这一段没有同步成功。' : 'This part did not sync.', `${code} (${language})`);
  assert.equal(issue('MEMORY_SYNC_FAILED', 'zh'), '这一段没有同步成功。', 'the default code is the plain line');
  assert.equal(issue('MEMORY_WRITE_REJECTED', 'zh'), '记忆服务拒绝了同步请求；对话仍保留，未重复发送。');
  assert.equal(issue('MEMORY_WRITE_REJECTED', 'en', true), 'The memory service refused to sync this delivery; the delivery is kept and it was not sent again.');
});
