import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { WorkspaceInspectionService } from '../workspace-inspection-service.mjs';
import { createProjectPreviewTools } from '../workspace-preview-tools.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rna-preview-discovery-'))), workspace = join(root, 'workspace');
  await mkdir(workspace);
  const store = new Store(join(root, 'state.json')), { project, session } = store.createProject({ name: 'Preview discovery', workspace });
  const service = new WorkspaceInspectionService(store, { getDaemonOrigin: () => 'http://127.0.0.1:4317' });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const file = async (path, content) => { await mkdir(join(workspace, path, '..'), { recursive: true }); await writeFile(join(workspace, path), content); };
  return { root, workspace, store, project, session, service, file };
}

test('an existing nested web app starts automatically without model preview calls, file-page selection or state mutation', async t => {
  const f = await fixture(t);
  await f.file('game/index.html', '<h1>Game</h1><script src="./main.js"></script>');
  await f.file('game/main.js', 'document.body.dataset.ready = "yes"');
  const revision = f.store.state.revision;
  const discovery = await f.service.discoverPreview(f.project.id);
  assert.equal(discovery.preferred, 'static:game/index.html'); assert.equal(discovery.status, 'available');
  assert.equal(f.service.previews.size, 0, 'discovery is read-only');
  const preview = await f.service.startPreview(f.project.id, { mode: 'auto', sessionId: f.session.id });
  assert.equal(preview.status, 'ready'); assert.equal(preview.automatic, true);
  assert.match(await (await fetch(preview.url)).text(), /Game/);
  assert.match(await (await fetch(new URL('./main.js', preview.url))).text(), /dataset.ready/);
  assert.equal((await f.service.startPreview(f.project.id, { mode: 'auto' })).url, preview.url);
  assert.equal(f.store.state.revision, revision);
});

test('one conventional root entry wins; multiple nested apps are reported without guessing or starting a process', async t => {
  const f = await fixture(t);
  await f.file('app/index.html', '<h1>A</h1>'); await f.file('other/index.html', '<h1>B</h1>');
  const result = await f.service.startPreview(f.project.id, { mode: 'auto' });
  assert.equal(result.status, 'stopped'); assert.equal(result.discovery.status, 'ambiguous'); assert.equal(result.discovery.preferred, null);
  assert.equal(f.service.previews.size, 0);
  await f.file('index.html', '<h1>Root</h1>');
  assert.equal((await f.service.discoverPreview(f.project.id)).preferred, 'static:index.html');
});

test('a project without HTML stays idle and a later created page becomes discoverable', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.startPreview(f.project.id, { mode: 'auto' })).discovery.reason, 'no_entry');
  await f.file('web/index.html', '<h1>New page</h1>');
  assert.equal((await f.service.startPreview(f.project.id, { mode: 'auto' })).status, 'ready');
});

test('discovery does not follow private namespaces, symlinks, dependency folders or state aliases', async t => {
  const f = await fixture(t);
  for (const path of ['.evolution/index.html', '.git/index.html', 'node_modules/lib/index.html', 'fixtures/index.html']) await f.file(path, '<h1>not an app</h1>');
  await writeFile(join(f.root, 'private.html'), '<h1>private</h1>'); await symlink(join(f.root, 'private.html'), join(f.workspace, 'index.html'));
  assert.deepEqual((await f.service.discoverPreview(f.project.id)).candidates, []);
  await rm(join(f.workspace, 'index.html'));
  f.store.updateProject(f.project.id, { workspace: f.root });
  await writeFile(`${f.store.file}.secret.html`, '<h1>host journal</h1>');
  assert.ok(!(await f.service.discoverPreview(f.project.id)).candidates.some(row => row.path?.includes('state.json')));
});

test('Vite manifests are only inspected: missing dependencies and revoked execution remain visible prerequisites', async t => {
  const f = await fixture(t);
  await f.file('index.html', '<script type="module" src="/src/main.ts"></script>');
  await f.file('package.json', JSON.stringify({ devDependencies: { vite: '^6' }, scripts: { dev: 'touch forbidden' } }));
  let discovery = await f.service.discoverPreview(f.project.id);
  assert.equal(discovery.preferred, 'vite:'); assert.equal(discovery.candidates.length, 1); assert.equal(discovery.reason, 'vite_dependencies_missing');
  assert.equal((await f.service.startPreview(f.project.id, { mode: 'auto' })).status, 'stopped');
  // This is deliberately an installation-presence fixture, never imported or
  // started. Runtime coverage separately launches the genuine Vite package.
  await f.file('node_modules/vite/dist/node/index.js', 'throw new Error("must not import during discovery")');
  f.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.permissions.workspace = 'read'; project.assignments = { toolIds: ['project_exec'], skillIds: [], mcpServerIds: [] }; });
  discovery = await f.service.discoverPreview(f.project.id);
  assert.equal(discovery.reason, 'execute_permission_required');
  assert.equal((await f.service.startPreview(f.project.id, { mode: 'auto' })).status, 'stopped');
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).permissions.workspace = 'execute'; });
  assert.equal((await f.service.discoverPreview(f.project.id, { sessionId: f.session.id })).status, 'available');
  assert.equal((await f.service.discoverPreview(f.project.id, { sessionId: 'not-a-session' })).reason, 'execute_permission_required');
  assert.equal(f.service.previews.size, 0);
});

test('TS/JSX source entry and unsupported framework are not mislabeled as runnable static HTML', async t => {
  const f = await fixture(t);
  await f.file('index.html', '<script type="module" src="./src/main.tsx"></script>');
  assert.equal((await f.service.discoverPreview(f.project.id)).reason, 'framework_requires_build');
  await f.file('index.html', '<div id="app"></div>'); await f.file('package.json', JSON.stringify({ dependencies: { next: '^15' } }));
  assert.equal((await f.service.startPreview(f.project.id, { mode: 'auto' })).discovery.reason, 'framework_requires_build');
  assert.equal(f.service.previews.size, 0);
});

test('bounded scans cannot auto-select an arbitrary nested candidate from an incomplete inventory', async t => {
  const f = await fixture(t);
  await f.file('a/index.html', '<h1>A</h1>');
  for (let i = 0; i < 30; i++) await f.file(`directory-${i}/source.txt`, 'not HTML');
  const discovery = await f.service.discoverPreview(f.project.id);
  assert.equal(discovery.truncated, true); assert.equal(discovery.preferred, null);
  assert.equal((await f.service.startPreview(f.project.id, { mode: 'auto' })).status, 'stopped');
});

test('explicit stop wins over an automatic scan already in flight', async t => {
  const f = await fixture(t); await f.file('index.html', '<h1>Ready</h1>');
  const original = f.service.list.bind(f.service); let entered, release;
  const seen = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.service.list = async (...args) => { entered(); await gate; return original(...args); };
  const pending = f.service.startPreview(f.project.id, { mode: 'auto' }); await seen;
  await f.service.stopPreview(f.project.id); release();
  assert.equal((await pending).superseded, true); assert.equal(f.service.previews.size, 0);
});

test('project switch, archive and cancellation invalidate discovery before a preview can start', async t => {
  const f = await fixture(t); await f.file('index.html', '<h1>Ready</h1>');
  const original = f.service.list.bind(f.service); let entered, release;
  const seen = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.service.list = async (...args) => { entered(); await gate; return original(...args); };
  const pending = f.service.startPreview(f.project.id, { mode: 'auto' }); await seen;
  f.store.updateProject(f.project.id, { workspace: f.root }); release();
  await assert.rejects(pending, { code: 'WORKSPACE_CHANGED' });
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(f.service.startPreview(f.project.id, { mode: 'auto' }, { signal: controller.signal }), /cancelled/);
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).archivedAt = new Date().toISOString(); });
  await assert.rejects(f.service.discoverPreview(f.project.id), { code: 'PROJECT_ARCHIVED' });
  assert.equal(f.service.previews.size, 0);
});

test('read-only model tool discovers candidates without spawning a development server or accepting foreign project paths', async t => {
  const f = await fixture(t); await f.file('index.html', '<h1>Ready</h1>');
  const tool = createProjectPreviewTools(f.service, f.project.id, { sessionId: f.session.id })[0];
  const result = await tool.execute('discover', { action: 'discover' });
  assert.equal(JSON.parse(result.content[0].text).status, 'available'); assert.equal(f.service.previews.size, 0);
  assert.equal((await tool.execute('bad', { action: 'discover', path: '../private.html' })).isError, true);
  for (const value of [{ mode: 'auto', path: 'index.html' }, { mode: 'auto', command: 'npm run dev' }, { mode: 'auto', projectId: 'other' }]) await assert.rejects(f.service.startPreview(f.project.id, value), { code: 'PREVIEW_ARGUMENTS_INVALID' });
});

test('HTML created before JS/CSS refreshes when its initially missing dependency appears; private 403s are never watched', async t => {
  const f = await fixture(t); await f.file('index.html', '<h1>Loading</h1><script src="./assets/app.js"></script>');
  const preview = await f.service.startPreview(f.project.id, { mode: 'auto' });
  assert.equal((await fetch(new URL('./assets/app.js', preview.url))).status, 404);
  assert.equal((await fetch(new URL('./.env', preview.url))).status, 403);
  const watch = f.service.previews.get(f.project.id).watch;
  assert.equal(watch.resources.get('assets/app.js'), 'missing'); assert.equal(watch.resources.has('.env'), false);
  await f.file('assets/app.js', 'document.querySelector("h1").textContent="Ready"'); await watch.poll();
  assert.equal(f.service.previewStatus(f.project.id).revision, 1);
  assert.match(await (await fetch(new URL('./assets/app.js', preview.url))).text(), /Ready/);
});

test('HTTP discovery and auto startup use the real current project and retain status-only GET semantics', async t => {
  const { createServer } = await import('../server.mjs');
  const f = await fixture(t), app = createServer({ stateFile: join(f.root, 'http-state.json'), ticks: false, runtime: false });
  const { project, session } = app.store.createProject({ name: 'HTTP preview', workspace: f.workspace });
  await f.file('site/index.html', '<h1>HTTP actual page</h1>');
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`, endpoint = `${origin}/api/projects/${project.id}/preview`;
  assert.equal((await (await fetch(endpoint)).json()).status, 'stopped');
  const discovery = await (await fetch(`${endpoint}/discovery?sessionId=${session.id}`)).json();
  assert.equal(discovery.preferred, 'static:site/index.html'); assert.equal(app.workspaceInspection.previews.size, 0);
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ mode: 'auto', sessionId: session.id }) });
  assert.equal(response.status, 200); const value = await response.json(); assert.equal(value.status, 'ready');
  assert.match(await (await fetch(value.url)).text(), /HTTP actual page/);
  assert.equal((await (await fetch(endpoint)).json()).url, value.url);
});
