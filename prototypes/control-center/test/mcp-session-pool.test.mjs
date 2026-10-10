import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { McpClient } from '../../../packages/sdk/src/mcp.mjs';
import { McpSessionPool, mcpFingerprint } from '../mcp-session-pool.mjs';
import { Store } from '../store.mjs';
import { CapabilityService } from '../capability-service.mjs';

// MCP connections live with a conversation (after zcode / Claude Code): started
// once, reused by later turns, closed when idle or reconfigured.
function fakeFactory() {
  const made = [];
  const factory = config => { const client = { config, ready: false, closed: false, connects: 0, async connect() { this.connects++; await new Promise(resolve => setTimeout(resolve, 5)); this.ready = true; return this; }, async listTools() { return [{ name: 'echo' }]; }, async callTool() { return { content: [] }; }, async close() { this.closed = true; this.ready = false; } }; made.push(client); return client; };
  return { made, factory };
}
const server = { id: 'search', transport: 'stdio', command: 'node', args: ['s.mjs'], enabled: true, trusted: true };

test('a conversation starts its MCP connection once; its turns lease and give it back', async t => {
  let clock = 0; const { made, factory } = fakeFactory();
  const pool = new McpSessionPool({ clientFactory: factory, now: () => clock, idleTimeoutMs: 1000 }); t.after(() => pool.close());
  const first = pool.acquire(server, { projectId: 'p', sessionId: 's1' }), second = pool.acquire(server, { projectId: 'p', sessionId: 's1' });
  await Promise.all([first.connect(), second.connect()]);
  assert.equal(made.length, 1); assert.equal(made[0].connects, 1, 'two turns waiting share one start');
  await first.close(); await second.close();
  assert.equal(made[0].closed, false, 'given back, not closed');
  const next = pool.acquire(server, { projectId: 'p', sessionId: 's1' }); await next.connect();
  assert.equal(made.length, 1); assert.equal(next.ready, true); await next.close();
  // Another conversation never shares it.
  const other = pool.acquire(server, { projectId: 'p', sessionId: 's2' }); await other.connect(); await other.close();
  assert.equal(made.length, 2);
  // Idle past the limit: closed.
  clock += 1500; pool.sweep();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(made.every(client => client.closed), true); assert.equal(pool.entries.size, 0);
});

test('a broken or reconfigured connection is replaced; a waiting turn can stop waiting', async t => {
  const { made, factory } = fakeFactory();
  const pool = new McpSessionPool({ clientFactory: factory }); t.after(() => pool.close());
  const lease = pool.acquire(server, { projectId: 'p', sessionId: 's' }); await lease.connect(); await lease.close();
  made[0].ready = false; made[0].closed = true; // the process died
  const again = pool.acquire(server, { projectId: 'p', sessionId: 's' }); await again.connect(); await again.close();
  assert.equal(made.length, 2);
  // Settings changed: the old key is no longer configured and goes once free.
  pool.sweep(new Set([mcpFingerprint({ ...server, args: ['other.mjs'] })]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(made[1].closed, true);
  // A caller's cancellation ends its wait without failing the shared start.
  const slow = pool.acquire(server, { projectId: 'p', sessionId: 'slow' }), controller = new AbortController();
  const waiting = slow.connect({ signal: controller.signal }); controller.abort(new Error('turn stopped'));
  await assert.rejects(waiting, /turn stopped/);
  const later = pool.acquire(server, { projectId: 'p', sessionId: 'slow' }); await later.connect();
  assert.equal(later.ready, true); await later.close(); await slow.close();
});

test('with a real stdio server: two turns of one conversation start the process once; typing prewarms it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-mcp-pool-')), store = new Store(join(dir, 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { project } = store.createProject({ name: 'MCP', workspace: dir });
  const fixture = fileURLToPath(new URL('../../../packages/sdk/test/fixtures/mcp-server.mjs', import.meta.url));
  store.mutate(state => { state.capabilities = { ...(state.capabilities ?? {}), skills: state.capabilities?.skills ?? [], tools: state.capabilities?.tools ?? [], mcpServers: [{ id: 'fixture', name: 'Fixture', transport: 'stdio', command: process.execPath, args: [fixture], enabled: true, trusted: true, allowTools: { echo: { permission: 'read', idempotent: true } } }] }; const target = state.projects.find(row => row.id === project.id); target.assignments = { skillIds: [], toolIds: ['mcp:fixture:echo'], mcpServerIds: ['fixture'] }; });
  const service = new CapabilityService(store); t.after(() => service.close());
  let started = 0; service.mcpSessions = new McpSessionPool({ clientFactory: config => { started++; return new McpClient(config); } });
  const current = () => store.state.projects.find(row => row.id === project.id);
  assert.equal(await service.prewarm(current(), 's1'), 1, 'typing started it');
  for (let turn = 0; turn < 2; turn++) {
    const { registry, failures } = await service.registry(current(), [], { connectIds: ['fixture'], sessionId: 's1', stateDir: join(dir, 'rna') });
    assert.deepEqual(failures, []);
    const echo = [...registry.tools.values()].find(tool => tool.mcpServerId === 'fixture');
    const result = await echo.execute('c', { text: `turn ${turn}` });
    assert.match(JSON.stringify(result), new RegExp(`turn ${turn}`));
    await registry.close();
  }
  assert.equal(started, 1, 'one process for the prewarm and both turns');
  await service.drainSession('s1');
  assert.equal(service.mcpSessions.entries.size, 0, 'a deleted conversation closes its connections');
});
