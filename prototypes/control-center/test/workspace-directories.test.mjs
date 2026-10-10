import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from '../server.mjs';

const run = promisify(execFile), cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
async function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-workspaces-'))), path = join(dir, 'game'); mkdirSync(path);
  const app = createServer({ stateFile: join(dir, 'state.json'), ticks: false, runtime: false }); await app.initializer.close();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (route, input = {}, options = {}) => { const response = await fetch(`${base}/api${route}`, { method: options.method ?? 'POST', headers: { 'Content-Type': 'application/json', ...options.headers }, body: JSON.stringify(input) }); return { status: response.status, value: await response.json() }; };
  return { ...app, dir, path, call, base };
}

test('opening a real directory preserves its project/session identity across aliases and restart', async t => {
  const { store, dir, path, call } = await fixture(t), link = join(dir, 'alias'); symlinkSync(path, link);
  const created = await call('/workspaces/open', { workspace: path, name: '游戏开发工作台', description: '保留游戏的设计目标与背景' });
  assert.equal(created.status, 202); assert.equal(created.value.reused, false); assert.equal(created.value.project.workspace, path); assert.equal(created.value.project.initialization.status, 'queued');
  const { project, session } = created.value;
  store.mutate(state => { state.projects.find(p => p.id === project.id).customPrompt = 'Existing user project prompt'; });
  const before = structuredClone(store.state), revision = store.state.revision;
  for (const workspace of [path + '/', join(path, '..', 'game'), link]) {
    const value = await call('/workspaces/open', { workspace, name: 'Should not rename', description: 'Should not replace' });
    assert.equal(value.status, 200); assert.equal(value.value.project.id, project.id); assert.equal(value.value.session.id, session.id); assert.equal(value.value.project.customPrompt, 'Existing user project prompt');
  }
  assert.equal(store.state.revision, revision); assert.deepEqual(store.state, before);
  const { Store } = await import('../store.mjs'), reopened = new Store(store.file).openWorkspace({ workspace: link }); assert.equal(reopened.project.id, project.id); assert.equal(reopened.session.id, session.id);
});

test('different directories with the same basename remain distinct and sessions inherit canonical cwd', async t => {
  const { dir, path, call, store } = await fixture(t); const other = join(dir, 'other', 'game'); mkdirSync(other, { recursive: true });
  const a = (await call('/workspaces/open', { workspace: path })).value, b = (await call('/workspaces/open', { workspace: other })).value;
  assert.equal(a.project.name, 'game'); assert.equal(b.project.name, 'game'); assert.notEqual(a.project.id, b.project.id);
  const session = store.createSession({ projectId: a.project.id }); assert.equal(session.workspace, path);
  assert.throws(() => store.updateSession(session.id, { workspace: other }), /项目内会话/);
  assert.throws(() => store.updateProject(a.project.id, { workspace: other }), /已属于其他项目/);
});

test('real directory names ending in whitespace retain exact identity through create, update and reopen', async t => {
  const { dir, call, store } = await fixture(t), path = join(dir, 'game '), moved = join(dir, 'game  '); mkdirSync(path); mkdirSync(moved);
  const { project, session } = (await call('/workspaces/open', { workspace: path })).value;
  assert.equal(project.workspace, path); assert.equal(session.workspace, path);
  assert.equal((await call('/workspaces/open', { workspace: path })).value.project.id, project.id);
  store.updateProject(project.id, { workspace: moved }); assert.equal(store.state.projects[0].workspace, moved); assert.equal(store.state.sessions[0].workspace, moved);
  assert.equal(store.updateSession(session.id, { workspace: moved }).workspace, moved);
  assert.equal((await call('/workspaces/open', { workspace: moved })).value.project.id, project.id); assert.equal(store.state.projects.length, 1);
});

test('historical relative workspace identities follow the actual runtime resolution without mutation', async t => {
  const { store, call } = await fixture(t), { project, session } = store.createProject({ name: '历史项目', workspace: 'Pi_agent' });
  const { projectWorkspace } = await import('../capability-service.mjs'), canonical = realpathSync(projectWorkspace('Pi_agent')), before = structuredClone(store.state);
  const result = await call('/workspaces/open', { workspace: canonical }); assert.equal(result.value.project.id, project.id); assert.equal(result.value.session.id, session.id);
  assert.equal(store.get().projects[0].workspacePath, projectWorkspace('Pi_agent')); assert.deepEqual(store.state, before);
  assert.equal((await call('/workspaces/browse', { path: canonical })).value.projects[0].id, project.id);
});

test('explicit project directory change updates historical session aliases but rejects an active turn', async t => {
  const { store, dir, path, call } = await fixture(t), next = join(dir, 'next'), alias = join(dir, 'alias'); mkdirSync(next); symlinkSync(path, alias);
  const { project, session } = (await call('/workspaces/open', { workspace: path })).value;
  store.mutate(state => { const row = state.sessions.find(row => row.id === session.id); row.workspace = alias; row.activeTurnId = 'in-progress'; });
  assert.throws(() => store.updateProject(project.id, { workspace: next }), /正在执行或暂停/); assert.equal(store.state.sessions[0].workspace, alias);
  store.mutate(state => { state.sessions[0].activeTurnId = null; });
  store.updateProject(project.id, { workspace: next }); assert.equal(store.state.sessions[0].workspace, next);
});

test('concurrent directory opens create one durable project and one initial conversation', async t => {
  const { store, call, path } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => call('/workspaces/open', { workspace: path })));
  assert.equal(new Set(results.map(row => row.value.project.id)).size, 1); assert.equal(store.state.projects.length, 1); assert.equal(store.state.sessions.length, 1);
  assert.equal(results.filter(row => row.status === 202).length, 1);
});

test('opening historical duplicate registrations requires an explicit choice and never merges them', async t => {
  const { store, path, call } = await fixture(t);
  const first = store.createProject({ name: '历史 A', workspace: path }), second = store.createProject({ name: '历史 B', workspace: path });
  const before = structuredClone(store.state);
  assert.equal((await call('/workspaces/open', { workspace: path })).status, 409);
  assert.equal((await call('/workspaces/open', { workspace: path, projectId: second.project.id })).value.project.id, second.project.id);
  assert.equal((await call('/workspaces/open', { workspace: path, projectId: 'foreign' })).status, 409);
  assert.deepEqual(store.state, before);
  const browsing = (await call('/workspaces/browse', { path })).value; assert.deepEqual(new Set(browsing.projects.map(p => p.id)), new Set([first.project.id, second.project.id]));
});

test('archive is not silently reversed and a deleted conversation is not recreated on directory reopen', async t => {
  const { path, store, call } = await fixture(t); const { project, session } = (await call('/workspaces/open', { workspace: path })).value;
  store.deleteSession(session.id); assert.equal((await call('/workspaces/open', { workspace: path })).value.session, null);
  store.updateProject(project.id, { archived: true }); const count = store.state.projects.length;
  assert.equal((await call('/workspaces/open', { workspace: path })).status, 409); assert.equal(store.state.projects.length, count);
  assert.ok((await call('/workspaces/browse', { path })).value.projects[0].archivedAt);
  store.updateProject(project.id, { archived: false }); assert.equal((await call('/workspaces/open', { workspace: path })).value.project.id, project.id);
  assert.equal(store.state.sessions.length, 0); assert.equal(store.state.projects[0].initiative.enabled, false);
});

test('browser lists actual folders, resolves symlinks, and rejects fake paths/files and cross-origin reads', async t => {
  const { dir, path, call } = await fixture(t); mkdirSync(join(dir, '.hidden')); writeFileSync(join(dir, 'file.txt'), 'not a directory'); symlinkSync(path, join(dir, 'link')); symlinkSync(join(dir, 'file.txt'), join(dir, 'file-link'));
  const result = await call('/workspaces/browse', { path: dir }); assert.equal(result.status, 200);
  const names = result.value.entries.map(entry => entry.name); assert.ok(names.includes('game') && names.includes('link')); assert.ok(!names.includes('.hidden') && !names.includes('file.txt') && !names.includes('file-link'));
  assert.ok((await call('/workspaces/browse', { path: dir, hidden: true })).value.entries.some(entry => entry.name === '.hidden'));
  assert.equal((await call('/workspaces/browse', { path: join(dir, 'link') })).value.path, path);
  for (const path of ['relative/path', join(dir, 'file.txt'), join(dir, 'missing')]) { const value = await call('/workspaces/open', { workspace: path }); assert.ok([400, 404].includes(value.status)); }
  assert.equal((await call('/workspaces/browse', { path: dir }, { headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  assert.equal((await call('/workspaces/open', { workspace: dir, name: {} })).status, 400);
});

test('directory creation is explicit, single-level, and cannot overwrite or traverse', async t => {
  const { path, call } = await fixture(t);
  const child = await call('/workspaces/directories', { parent: path, name: '新游戏' }); assert.equal(child.status, 201); assert.equal(child.value.path, join(path, '新游戏'));
  assert.equal((await call('/workspaces/directories', { parent: path, name: '新游戏' })).status, 409);
  for (const name of ['..', '../outside', '/absolute', '', 'bad\0name']) assert.equal((await call('/workspaces/directories', { parent: path, name })).status, 400);
});

test('CLI project-open and project-new --workspace reuse the same canonical identity', async t => {
  const { path, dir, server, store } = await fixture(t); const link = join(dir, 'alias'); symlinkSync(path, link);
  const invoke = async (...args) => JSON.parse((await run(process.execPath, [cli, ...args], { env: { ...process.env, RNA_AGENT_PORT: String(server.address().port) }, timeout: 10000 })).stdout);
  const a = await invoke('project-new', 'CLI 游戏项目', '--workspace', path), b = await invoke('project-open', link);
  assert.equal(a.project.id, b.project.id); assert.equal(b.project.name, 'CLI 游戏项目'); assert.equal(store.state.projects.length, 1);
});

test('native directory picker accepts only its owned main frame and coalesces simultaneous dialogs', async () => {
  const { installDirectoryPicker } = createRequire(import.meta.url)('../desktop/directory-picker.cjs');
  const frame = { url: 'http://127.0.0.1:4317/' }, contents = { mainFrame: frame }; let handler, resolveDialog, calls = 0, destroyed = false;
  const window = { webContents: contents, isDestroyed: () => destroyed }, event = { sender: contents, senderFrame: frame };
  installDirectoryPicker({ window, origin: 'http://127.0.0.1:4317', ipcMain: { handle: (_, fn) => handler = fn }, dialog: { showOpenDialog: (_window, options) => { calls++; assert.deepEqual(options.properties, ['openDirectory', 'createDirectory']); return new Promise(resolve => { resolveDialog = resolve; }); } } });
  assert.throws(() => handler({ ...event, sender: {} }), /main frame/); assert.throws(() => handler({ ...event, senderFrame: { url: frame.url } }), /main frame/);
  frame.url = 'https://untrusted.invalid'; assert.throws(() => handler(event), /main frame/); frame.url = 'http://127.0.0.1:4317/';
  const first = handler(event), second = handler(event); assert.equal(first, second); assert.equal(calls, 1); resolveDialog({ canceled: false, filePaths: ['/real/directory'] }); assert.equal(await first, '/real/directory');
  const cancelled = handler(event); resolveDialog({ canceled: true, filePaths: [] }); assert.equal(await cancelled, null);
  const late = handler(event); destroyed = true; resolveDialog({ canceled: false, filePaths: ['/late/directory'] }); assert.equal(await late, null);
});
