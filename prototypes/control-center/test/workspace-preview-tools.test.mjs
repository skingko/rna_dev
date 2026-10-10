import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { WorkspaceInspectionService } from '../workspace-inspection-service.mjs';
import { createProjectPreviewTools } from '../workspace-preview-tools.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rna-preview-tool-'))), workspace = join(root, 'project');
  await mkdir(workspace); await mkdir(join(workspace, 'demo'));
  await writeFile(join(workspace, 'demo', 'index.html'), '<!doctype html><h1>Actual preview</h1><script src="./app.js"></script>');
  await writeFile(join(workspace, 'demo', 'app.js'), 'document.querySelector("h1").dataset.ready="true";');
  await writeFile(join(workspace, '.env'), 'private');
  const store = new Store(join(root, 'state.json')), { project } = store.createProject({ name: 'Preview', workspace });
  const service = new WorkspaceInspectionService(store, { getDaemonOrigin: () => 'http://127.0.0.1:4317' });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { store, project, service, tool: createProjectPreviewTools(service, project.id)[0] };
}
const call = async (f, args) => {
  const result = await f.tool.execute('preview-call', args);
  return { ...result, value: result.isError ? null : JSON.parse(result.content[0].text) };
};

test('agent starts the same actual preview shown by UI, serves relative assets and stops it without a shell', async t => {
  const f = await fixture(t), revision = f.store.state.revision;
  assert.equal((await call(f, { action: 'status' })).value.status, 'stopped');
  const started = await call(f, { action: 'start', path: 'demo/index.html' });
  assert.equal(started.isError, undefined); assert.equal(started.value.status, 'ready');
  assert.match(started.value.evidence, /no browser navigation/);
  assert.equal(f.service.previewStatus(f.project.id).url, started.value.url);
  assert.equal((await fetch(started.value.url)).status, 200);
  assert.match(await (await fetch(new URL('./app.js', started.value.url))).text(), /dataset.ready/);
  assert.equal((await call(f, { action: 'start', path: 'demo/index.html' })).value.url, started.value.url);
  assert.equal((await call(f, { action: 'status' })).value.url, started.value.url);
  assert.equal((await call(f, { action: 'stop' })).value.status, 'stopped');
  await assert.rejects(fetch(started.value.url)); assert.equal(f.store.state.revision, revision);
});

test('model cannot select another project, external URL, private file or non-HTML executable', async t => {
  const f = await fixture(t);
  for (const args of [{ action: 'start', projectId: 'other' }, { action: 'stop', path: 'demo/index.html' }, { action: 'run' }, { action: 'start', path: '../state.json' }, { action: 'start', path: '.env' }, { action: 'start', path: 'http://example.com/index.html' }, { action: 'start', path: 'demo/app.js' }]) {
    const result = await call(f, args); assert.equal(result.isError, true); assert.equal(result.details.rendered, false);
  }
  assert.equal(f.service.previewStatus(f.project.id).status, 'stopped');
});

test('archiving the captured project revokes an existing preview and all later calls', async t => {
  const f = await fixture(t), result = await call(f, { action: 'start', path: 'demo/index.html' });
  f.store.mutate(state => { state.projects.find(p => p.id === f.project.id).archivedAt = new Date().toISOString(); });
  for (const action of ['start', 'status', 'stop']) assert.equal((await call(f, { action })).details.code, 'PROJECT_ARCHIVED');
  await f.service.stopPreview(f.project.id);
  await assert.rejects(fetch(result.value.url));
});

test('an already cancelled model tool call does not create a preview', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(f.tool.execute('cancelled-call', { action: 'start', path: 'demo/index.html' }, controller.signal), /cancelled/);
  assert.equal(f.service.previewStatus(f.project.id).status, 'stopped');
  assert.deepEqual(createProjectPreviewTools(null, f.project.id), []);
});
