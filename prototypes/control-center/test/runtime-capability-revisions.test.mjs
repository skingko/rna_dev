import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRnaRuntime, createProjectReadTools } from '../rna-runtime.mjs';
import { CapabilityRegistry } from '../../../packages/sdk/src/index.mjs';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }
async function fixture(t, { onBuild, onResolve, onClose, write = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-capability-revision-')), requests = [], registries = [], handles = [];
  let project = { id: 'qa-project', name: 'Revision fixture', workspace: directory, permissions: { workspace: 'read', background: 'read', revision: 1 }, assignments: { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] } };
  const current = () => project;
  const change = (toolIds, permission = project.permissions.workspace) => { project = { ...project, permissions: { ...project.permissions, workspace: permission, revision: project.permissions.revision + 1 }, assignments: { ...project.assignments, toolIds } }; };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const data of req) raw += data; requests.push(JSON.parse(raw));
    const tool = write && requests.length === 1;
    const delta = tool ? { tool_calls: [{ index: 0, id: 'qa-write', type: 'function', function: { name: 'project_write', arguments: JSON.stringify({ path: 'allowed.txt', content: 'write after current grant', expectedHash: null }) } }] } : { content: 'Fixture complete' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const service = { configuration: () => ({}), async registry() {
    const registry = new CapabilityRegistry({ tools: await createProjectReadTools(directory, { includeMutations: true }) }), row = { registry, closeCount: 0, number: registries.length + 1 }; registries.push(row);
    const originalResolve = registry.resolve.bind(registry), originalClose = registry.close.bind(registry);
    registry.resolve = async selection => { await onResolve?.({ row, change, current }); return originalResolve(selection); };
    registry.close = async () => { row.closeCount++; await onClose?.({ row, change, current }); return originalClose(); };
    await onBuild?.({ row, change, current }); return { registry, failures: [] };
  } };
  const create = async extra => { const handle = await createRnaRuntime({ project, getProject: current, projectId: project.id, cwd: directory, sessionId: 'qa-session', stateDir: join(directory, 'runtime'), capabilityService: service, model: { providerId: 'http-fixture', modelId: 'fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 64000, maxOutputTokens: 1000 }, ...extra }); handles.push(handle); return handle; };
  t.after(async () => { for (const handle of handles) await handle.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { directory, requests, registries, create, change, current, names: () => (requests[0]?.tools?.map(tool => tool.function.name) ?? []).filter(name => name !== 'tool_output_read') }; // the session's own saved-output reader is always declared
}

test('permission granted during initial registry loading is available to the first model request and real file write', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { write: true, onBuild: async ({ row }) => { if (row.number === 1) { entered.resolve(); await release.promise; } } });
  const creating = f.create(); await entered.promise; f.change(['project_read', 'project_write'], 'write'); release.resolve(); const handle = await creating;
  await handle.prompt('Create the granted QA file');
  assert.ok(f.names().includes('project_write')); assert.equal(await readFile(join(f.directory, 'allowed.txt'), 'utf8'), 'write after current grant');
  assert.equal(f.registries.length, 2); assert.equal(f.registries[0].registry.closed, true); assert.equal(f.registries[0].closeCount, 1);
});

test('a grant revoked while resolving a refreshed selection never reaches the provider', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { onResolve: async ({ row }) => { if (row.number === 2) { entered.resolve(); await release.promise; } } });
  const handle = await f.create(); f.change(['project_read', 'project_write'], 'write'); const running = handle.prompt('Use current tools');
  await entered.promise; f.change(['project_list'], 'read'); release.resolve(); await running;
  assert.deepEqual(f.names(), ['project_list']); assert.equal(f.registries.length, 3);
  assert.equal(f.registries[0].registry.closed, true); assert.equal(f.registries[1].registry.closed, true);
});

test('permission changes while closing a replaced MCP registry trigger a fresh build before the request', async t => {
  const f = await fixture(t, { onClose: ({ row, change }) => { if (row.number === 1 && row.closeCount === 1) change(['project_list'], 'read'); } });
  const handle = await f.create(); f.change(['project_read', 'project_write'], 'write'); await handle.prompt('Use current tools');
  assert.deepEqual(f.names(), ['project_list']); assert.equal(f.registries.length, 3); assert.equal(f.registries[1].registry.closed, true);
});

test('a superseded invalid assignment can recover without treating the old error as the current catalog', async t => {
  const f = await fixture(t, { onResolve: ({ row, change }) => { if (row.number === 1) change(['project_list']); } });
  f.change(['removed-tool']); const handle = await f.create(); await handle.prompt('Use valid current assignment');
  assert.deepEqual(f.names(), ['project_list']); assert.equal(f.registries.length, 2); assert.equal(f.registries[0].registry.closed, true);
});

test('continuous catalog changes are bounded and close every discarded registry before any model request', async t => {
  const f = await fixture(t, { onResolve: ({ row, change }) => change(row.number % 2 ? ['project_list'] : ['project_read']) });
  await assert.rejects(f.create(), { code: 'capability_state_changed' });
  assert.equal(f.registries.length, 4); assert.ok(f.registries.every(row => row.registry.closed && row.closeCount === 1)); assert.equal(f.requests.length, 0);
});

test('abort during a stale build closes its registry and does not retry or call a model', async t => {
  const entered = deferred(), release = deferred(), controller = new AbortController();
  const f = await fixture(t, { onBuild: async () => { entered.resolve(); await release.promise; } });
  const creating = f.create({ signal: controller.signal }); await entered.promise; f.change(['project_write'], 'write'); controller.abort(); release.resolve();
  await assert.rejects(creating, { name: 'AbortError' }); assert.equal(f.registries.length, 1); assert.equal(f.registries[0].registry.closed, true); assert.equal(f.requests.length, 0);
});

test('an async host request hook changing assignments is reflected before the first provider call', async t => {
  const f = await fixture(t); let changed = false;
  const handle = await f.create({ beforeRequest: async () => { if (!changed) { changed = true; await Promise.resolve(); f.change(['project_list']); } } });
  await handle.prompt('Use current tools'); assert.deepEqual(f.names(), ['project_list']); assert.equal(f.registries.length, 2);
});
