import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { WorkspaceInspectionService } from '../workspace-inspection-service.mjs';
import { PreviewResourceWatch } from '../preview-resource-watch.mjs';
import { createProjectPreviewTools } from '../workspace-preview-tools.mjs';

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'rna-live-preview-'))), workspace = join(directory, 'app'); await mkdir(workspace);
  const store = new Store(join(directory, 'state.json')), { project, session } = store.createProject({ name: 'Preview', workspace });
  store.mutate(state => { state.projects.find(p => p.id === project.id).assignments = { toolIds: [], skillIds: [], mcpServerIds: [] }; });
  const service = new WorkspaceInspectionService(store, { getDaemonOrigin: () => 'http://127.0.0.1:4317' });
  await writeFile(join(workspace, 'index.html'), '<h1>Before</h1><link rel="stylesheet" href="./style.css">'); await writeFile(join(workspace, 'style.css'), 'h1{color:red}');
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, workspace, store, project, session, service };
}
async function until(check) { const deadline = Date.now() + 2500; while (!await check()) { if (Date.now() >= deadline) assert.fail('Preview did not observe the real file change'); await delay(30); } }

test('static revision tracks actual served dependencies and preserves its origin/generation', async t => {
  const f = await fixture(t), before = await f.service.startPreview(f.project.id);
  await fetch(before.url); await fetch(new URL('./style.css', before.url));
  await writeFile(join(f.workspace, 'unrelated.txt'), 'not part of the page');
  await f.service.previews.get(f.project.id).watch.poll(); assert.equal(f.service.previewStatus(f.project.id).revision, 0);
  await writeFile(join(f.workspace, 'style.css'), 'h1{color:blue}');
  await until(() => f.service.previewStatus(f.project.id).revision === 1);
  const after = f.service.previewStatus(f.project.id); assert.equal(after.url, before.url); assert.equal(after.generation, before.generation); assert.equal(after.liveReload, 'reload');
  await rm(join(f.workspace, 'style.css')); await until(() => f.service.previewStatus(f.project.id).revision === 2);
  await f.service.stopPreview(f.project.id); assert.equal(f.service.previews.size, 0);
});

test('dependency replacement with symlink is denied instead of watching outside the project', async t => {
  const f = await fixture(t), preview = await f.service.startPreview(f.project.id); await fetch(new URL('./style.css', preview.url));
  const outside = join(f.directory, 'private.css'); await writeFile(outside, 'sensitive-content'); await rm(join(f.workspace, 'style.css')); await symlink(outside, join(f.workspace, 'style.css'));
  await f.service.previews.get(f.project.id).watch.poll(); assert.equal(f.service.previewStatus(f.project.id).watchError, 'WORKSPACE_PATH_DENIED');
  const response = await fetch(new URL('./style.css', preview.url)); assert.equal(response.status, 403); assert.ok(!(await response.text()).includes('sensitive-content'));
});

test('resource watcher is single-flight and close discards a pending metadata observation', async () => {
  let release, calls = 0, changes = 0; const pending = new Promise(resolve => { release = resolve; });
  const watcher = new PreviewResourceWatch({ inspect: async () => { calls++; await pending; return 'new'; }, changed: () => changes++, failed: assert.fail });
  watcher.add('index.html', 'old'); const a = watcher.poll(), b = watcher.poll(); assert.equal(a, b); assert.equal(calls, 1);
  watcher.close(); release(); await a; assert.equal(changes, 0); assert.equal(watcher.resources.size, 0);
});

test('Vite requires a real execute grant and project_exec assignment before reading or spawning', async t => {
  const f = await fixture(t); const tools = createProjectPreviewTools(f.service, f.project.id, { sessionId: f.session.id });
  assert.equal(tools[0].permission, 'read'); assert.equal(tools[1].permission, 'exec'); assert.equal(tools[1].effect, 'write');
  for (const permission of ['read', 'write', 'execute']) {
    f.store.mutate(state => { const p = state.projects.find(p => p.id === f.project.id); p.permissions.workspace = permission; p.assignments.toolIds = []; });
    await assert.rejects(f.service.startPreview(f.project.id, { mode: 'vite' }), { code: 'PREVIEW_EXECUTION_DENIED' });
  }
  f.store.mutate(state => state.projects.find(p => p.id === f.project.id).assignments.toolIds = ['project_exec']);
  await assert.rejects(f.service.startPreview(f.project.id, { mode: 'vite', sessionId: 'missing' }), { code: 'PREVIEW_EXECUTION_DENIED' });
  await assert.rejects(f.service.startPreview(f.project.id, { mode: 'vite' }, { permissionScope: 'background' }), { code: 'PREVIEW_EXECUTION_DENIED' });
  assert.equal(f.service.previews.size, 0);
});

test('Vite does not install missing dependencies or treat malformed package files as success', async t => {
  const f = await fixture(t); f.store.mutate(state => state.projects.find(p => p.id === f.project.id).assignments.toolIds = ['project_exec']);
  await writeFile(join(f.workspace, 'package.json'), '{}');
  await assert.rejects(f.service.startPreview(f.project.id, { mode: 'vite' }), { code: 'PREVIEW_VITE_UNAVAILABLE' });
  await writeFile(join(f.workspace, 'package.json'), 'broken');
  await assert.rejects(f.service.startPreview(f.project.id, { mode: 'vite' }), { code: 'PREVIEW_PACKAGE_INVALID' });
  assert.equal(f.service.previews.size, 0);
});
