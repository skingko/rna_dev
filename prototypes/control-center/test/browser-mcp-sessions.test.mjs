import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserMcpSessions } from '../browser-mcp-sessions.mjs';
import { browserToolGrants, currentBrowserGrants, resolveBrowserPreset, normalizeBrowserMetadata, browserSessionManifest } from '../browser-capability-presets.mjs';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rna-browser-pool-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { id: 'browser', command: process.execPath, args: ['/fixture/browser.js'], transport: 'stdio', enabled: true, trusted: true, allowTools: browserToolGrants(), browser: { schemaVersion: 1, preset: 'playwright-browser', packageVersion: '0.0.82', executablePath: process.execPath } };
  const listeners = new Set(), store = { file: join(root, 'state.json'), state: { projects: [{ id: 'p', permissions: { workspace: 'execute', background: 'read' }, assignments: { mcpServerIds: ['browser'] } }], sessions: [{ id: 'a', projectId: 'p' }, { id: 'b', projectId: 'p' }], capabilities: { mcpServers: [manifest] } }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const clients = [];
  const pool = new BrowserMcpSessions(store, { clientFactory(config) { const client = { config, ready: false, closed: false, calls: [], state: 0, async connect() { this.ready = true; return this; }, async listTools() { return []; }, async callTool(name, args) { this.calls.push(name); if (name === 'browser_click') this.state++; return { content: [{ type: 'text', text: String(this.state) }] }; }, async close() { this.closed = true; this.ready = false; } }; clients.push(client); return client; }, ...extra });
  t.after(() => pool.close());
  const acquire = (sessionId = 'a', input = {}) => pool.acquire(manifest, { projectId: 'p', sessionId, stateDir: join(`${store.file}.rna`, sessionId), ...input });
  return { root, manifest, pool, store, clients, acquire, notify: () => { for (const listener of listeners) listener(); } };
}

test('same Session keeps browser state across registry leases; other Sessions are isolated', async t => {
  const f = await fixture(t), a = await f.acquire(); await a.connect(); await a.callTool('browser_click', {}); const generation = f.pool.status('p', 'a')[0].generation; await a.close();
  assert.equal(f.clients[0].closed, false);
  const again = await f.acquire(); await again.connect(); assert.equal((await again.callTool('browser_snapshot', {})).content[0].text, '1'); assert.equal(f.pool.status('p', 'a')[0].generation, generation);
  const b = await f.acquire('b'); await b.connect(); assert.equal((await b.callTool('browser_snapshot', {})).content[0].text, '0'); assert.equal(f.clients.length, 2);
  await again.close(); await b.close();
});

test('simultaneous acquisition uses one connection and serializes operations', async t => {
  const f = await fixture(t), [first, second] = await Promise.all([f.acquire(), f.acquire()]); await first.connect(); await second.connect(); assert.equal(f.clients.length, 1);
  const gate = deferred(), started = deferred(), calls = [];
  f.clients[0].callTool = async name => { calls.push(name); if (name === 'browser_click') { started.resolve(); await gate.promise; } return { content: [] }; };
  const a = first.callTool('browser_click', {}); await started.promise; const b = second.callTool('browser_snapshot', {}); await Promise.resolve(); assert.deepEqual(calls, ['browser_click']); gate.resolve(); await Promise.all([a, b]); assert.deepEqual(calls, ['browser_click', 'browser_snapshot']);
  await first.close(); await second.close();
});

test('concurrent replacement after awaited retirement cannot overwrite or leak a generation', async t => {
  const f = await fixture(t), first = await f.acquire(); await first.connect(); await first.close();
  const gate = deferred(), closing = deferred(), original = f.clients[0].close.bind(f.clients[0]);
  f.clients[0].close = async () => { closing.resolve(); await gate.promise; await original(); };
  const retired = f.pool.retire([...f.pool.entries.values()][0], 'fixture_replace'); await closing.promise;
  const a = f.acquire(), b = f.acquire(); gate.resolve(); const [one, two] = await Promise.all([a, b, retired]);
  await one.connect(); await two.connect(); assert.equal(f.clients.length, 2); assert.equal(f.pool.entries.size, 1);
  await one.close(); await two.close(); await f.pool.close(); assert.ok(f.clients.every(row => row.closed));
});

test('capacity retirement rechecks owner and serializes two new acquisitions for one Session', async t => {
  const f = await fixture(t, { maxSessions: 1 }), first = await f.acquire(); await first.connect(); await first.close();
  const gate = deferred(), closing = deferred(), original = f.clients[0].close.bind(f.clients[0]);
  f.clients[0].close = async () => { closing.resolve(); await gate.promise; await original(); };
  const a = f.acquire('b'); await closing.promise; const b = f.acquire('b'); gate.resolve(); const [one, two] = await Promise.all([a, b]);
  await one.connect(); await two.connect(); assert.equal(f.clients.length, 2); assert.equal(f.pool.entries.size, 1); await one.close(); await two.close();
});

test('foreground requires a live owner; delegated leases explicitly bind their parent and deletion cancels pending acquisition', async t => {
  const f = await fixture(t);
  f.store.state.sessions.push({ id: 'foreign', projectId: 'other' });
  await assert.rejects(f.acquire('missing'), { code: 'browser_owner_unavailable' });
  await assert.rejects(f.acquire('foreign'), { code: 'browser_owner_unavailable' });
  const delegated = await f.acquire('agent-child', { ownerSessionId: 'a' }); await delegated.connect(); assert.equal(f.pool.status('p', 'agent-child')[0].lifetime, 'turn');
  await f.pool.drainSession('a'); assert.equal(delegated.closed, true); await delegated.close();
  const first = await f.acquire(); await first.connect(); await first.close();
  const gate = deferred(), closing = deferred(), original = f.clients.at(-1).close.bind(f.clients.at(-1));
  f.clients.at(-1).close = async () => { closing.resolve(); await gate.promise; await original(); };
  const retired = f.pool.retire([...f.pool.entries.values()][0], 'pending_owner'); await closing.promise;
  const pending = f.acquire(); f.store.state.sessions = f.store.state.sessions.filter(row => row.id !== 'a'); gate.resolve();
  await assert.rejects(pending, { code: 'browser_owner_unavailable' }); await retired; assert.equal(f.clients.length, 2);
});

test('revocation, archive and deletion close retained browsers before new use', async t => {
  for (const change of ['revoke', 'archive', 'delete']) {
    const f = await fixture(t), lease = await f.acquire(); await lease.connect(); await lease.close();
    if (change === 'revoke') f.store.state.projects[0].permissions.workspace = 'read';
    if (change === 'archive') f.store.state.sessions[0].archivedAt = new Date().toISOString();
    if (change === 'delete') f.store.state.sessions.splice(0, 1);
    f.notify(); await new Promise(resolve => setImmediate(resolve)); await f.pool.drainSession('a'); assert.equal(f.clients[0].closed, true); assert.deepEqual(f.pool.status('p', 'a'), []);
  }
});

test('idle expiry changes generation, capacity refuses active leases, and draining one Session preserves another', async t => {
  let now = 0; const f = await fixture(t, { now: () => now, idleTimeoutMs: 100, maxSessions: 1 });
  const a = await f.acquire(); await a.connect(); const old = f.pool.status('p', 'a')[0].generation; await assert.rejects(f.acquire('b'), { code: 'browser_capacity' });
  await a.close(); now = 200; f.pool.sweep(); await f.pool.drainSession('a'); const fresh = await f.acquire(); await fresh.connect(); assert.notEqual(f.pool.status('p', 'a')[0].generation, old); await fresh.close();
  const b = await f.acquire('b'); await b.connect(); await f.pool.drainSession('a'); assert.equal(b.ready, true); await b.close();
});

test('tool transport error retires browser; cancelled queued work is not dispatched', async t => {
  const f = await fixture(t), lease = await f.acquire(); await lease.connect();
  const gate = deferred(), started = deferred(), calls = []; f.clients[0].callTool = async name => { calls.push(name); if (name === 'browser_click') { started.resolve(); await gate.promise; } return { content: [] }; };
  const first = lease.callTool('browser_click', {}); await started.promise; const controller = new AbortController(); const second = lease.callTool('browser_snapshot', {}, { signal: controller.signal }); controller.abort(); gate.resolve(); await first; await assert.rejects(second, { name: 'AbortError' }); assert.deepEqual(calls, ['browser_click']);
  f.clients[0].callTool = async () => { throw Object.assign(new Error('lost response'), { code: 'transport_closed' }); };
  await assert.rejects(lease.callTool('browser_click', {}), { code: 'transport_closed' }); assert.equal(f.clients[0].closed, true); await lease.close();
});

test('outputs reject traversal/symlink targets and presets reject permission downgrades or missing browsers', async t => {
  const f = await fixture(t), lease = await f.acquire(); await lease.connect();
  for (const filename of ['/tmp/private', '../x', 'a/b']) await assert.rejects(lease.callTool('browser_take_screenshot', { filename }), { code: 'browser_output_path_denied' });
  assert.deepEqual(f.clients[0].calls, []); await lease.close();
  const outside = join(f.root, 'outside'), dir = join(`${f.store.file}.rna`, 'unsafe'); await mkdir(outside); await symlink(outside, dir);
  await assert.rejects(browserSessionManifest(f.manifest, dir, { storageRoot: `${f.store.file}.rna` }), { code: 'browser_storage_unsafe' });
  assert.throws(() => normalizeBrowserMetadata({ ...f.manifest, allowTools: { browser_click: { permission: 'read' } } }), { code: 'browser_preset_invalid' });
  await assert.rejects(resolveBrowserPreset({ kind: 'mcp', source: { type: 'preset', preset: 'playwright-browser', executablePath: join(f.root, 'missing') } }), { code: 'browser_unavailable' });
  await assert.rejects(resolveBrowserPreset({ kind: 'mcp', source: { type: 'preset', preset: 'playwright-browser' }, allowTools: {} }), { code: 'browser_preset_invalid' });
});

test('only browser observation tools are idempotent; older installs get the current preset rules for the tools they grant', () => {
  const grants = browserToolGrants();
  for (const name of ['browser_console_messages', 'browser_snapshot', 'browser_take_screenshot', 'browser_network_requests', 'browser_wait_for']) assert.equal(grants[name].idempotent, true, name);
  for (const name of ['browser_click', 'browser_type', 'browser_navigate', 'browser_tabs', 'browser_close']) assert.equal(grants[name].idempotent, false, name);
  const old = { browser_console_messages: { permission: 'exec', idempotent: false }, browser_click: { permission: 'exec', idempotent: false } };
  assert.deepEqual(currentBrowserGrants(old), { browser_console_messages: { permission: 'exec', idempotent: true }, browser_click: { permission: 'exec', idempotent: false } });
});

test('an install stored with older tool rules still authorizes the registry copy refreshed to the current rules', async t => {
  const f = await fixture(t);
  const stored = f.store.state.capabilities.mcpServers.find(row => row.id === 'browser');
  stored.allowTools = Object.fromEntries(Object.keys(browserToolGrants()).map(name => [name, { permission: 'exec', idempotent: false }]));
  const refreshed = { ...stored, allowTools: currentBrowserGrants(stored.allowTools) };
  const lease = await f.pool.acquire(refreshed, { projectId: 'p', sessionId: 'a', stateDir: join(`${f.store.file}.rna`, 'a') });
  await lease.connect(); assert.equal((await lease.callTool('browser_snapshot', {})).isError ?? false, false); await lease.close();
});

test('the conversation browser opens a loopback DevTools port for the live view; each tool call shows as the current action', async t => {
  const f = await fixture(t), a = await f.acquire(); await a.connect();
  const args = f.clients[0].config.args, file = args[args.indexOf('--config') + 1];
  const { readFile } = await import('node:fs/promises');
  const launch = JSON.parse(await readFile(file, 'utf8')).browser.launchOptions.args;
  assert.match(launch[0], /^--remote-debugging-port=\d+$/); assert.ok(!args.includes('--cdp-endpoint'), 'Playwright still launches and isolates the browser');
  const view = f.pool.view('a'), seen = [];
  view.connect = async () => {}; // no Chrome here; the CDP side has its own test
  const unsubscribe = view.subscribe(event => { if (event.type === 'state') seen.push(event.action?.name ?? null); });
  assert.equal(view.port, Number(launch[0].split('=')[1]));
  await a.callTool('browser_navigate', { url: 'http://127.0.0.1:5173/' });
  assert.deepEqual(seen.slice(-2), ['browser_navigate', null]);
  unsubscribe(); await a.close();
  // A background run's browser (not a conversation) gets no port.
  const background = await f.acquire('bg-run', { permissionScope: 'background', ownerSessionId: 'bg-run' }).catch(error => error);
  if (!(background instanceof Error)) { await background.connect(); assert.ok(!f.clients.at(-1).config.args.includes('--config')); await background.close(); }
  await f.pool.drainSession('a'); assert.equal(f.pool.views.has('a'), false);
});
