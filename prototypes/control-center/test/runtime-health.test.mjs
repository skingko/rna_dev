import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.mjs';
import { SDK_VERSION } from '../../../packages/sdk/src/version.mjs';
import metadata from '../package.json' with { type: 'json' };

async function app(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-health-'));
  const app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false, ...options });
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...app, base: `http://127.0.0.1:${app.server.address().port}` };
}
test('health exposes actual process, storage and resource metrics without provider configuration', async t => {
  const server = await app(t), health = await (await fetch(`${server.base}/api/health`)).json();
  assert.equal(health.ok, true); assert.equal(health.version, metadata.version); assert.equal(health.sdkVersion, SDK_VERSION);
  assert.equal(health.process.pid, process.pid); assert.ok(health.process.instanceId); assert.ok(health.memory.rss > 0); assert.ok(health.persistence.bytes > 0); assert.ok(health.persistence.writes > 0);
  assert.equal(health.dependencies.memory.status, 'not_monitored'); assert.equal(health.configuration, undefined); assert.equal(health.providers, undefined);
});
test('autonomous archive, provider and quarantined-operation failures cannot be counted as healthy uptime', async t => {
  const server = await app(t, { initiative: true });
  for (const status of [ { lastPumpError: 'archive_failed', projects: [] }, { projects: [{ failureCount: 1 }] }, { projects: [{ unsettledOperations: 1 }] }, { projects: [{ archiveRetryAt: Date.now() + 30000 }] }, { projects: [{ lastObserverError: 'cannot checkpoint' }] } ]) {
    server.projectInitiative.health = () => status;
    assert.equal(server.health().ok, false); assert.equal(server.health().autonomyDegraded, true);
  }
  server.projectInitiative.health = () => ({ projects: [{ inFlight: true, failureCount: 0, nextReviewAt: Date.now() + 1000000 }] });
  assert.equal(server.health().ok, true, 'Normal work or an intentional wait is not an outage');
  server.store.persistence.failed = true; assert.equal(server.health().ok, false);
});
test('memory liveness alone and legacy readiness do not count as a ready dependency', async t => {
  const server = await app(t);
  server.store.createProject({ name: 'Real memory readiness check', description: 'Isolated dependency protocol fixture' });
  server.store.mutate(state => { state.projects[0].simulated = false; });
  server.store.memoryService.healthRemote = async () => ({ connected: true, ready: false, liveness: { status: 'alive' }, readiness: { status: 'not_supported', embedding: 'not_verified' } });
  await server.checkMemory();
  assert.equal(server.health().ok, false);
  assert.equal(server.health().dependencies.memory.readiness, 'not_supported');
  assert.equal(server.health().dependencies.memory.embedding, 'not_verified');
  server.store.memoryService.healthRemote = async () => ({ ready: true, liveness: { status: 'alive' }, readiness: { status: 'ready', embedding: 'ready' } });
  await server.checkMemory();
  assert.equal(server.health().ok, true);
  assert.equal(server.health().dependencies.memory.vlm, 'not_verified', 'Readiness is not a paid generation or semantic-quality test');
  server.store.memoryService.healthRemote = async () => { throw new Error('private upstream details'); };
  await server.checkMemory();
  assert.equal(server.health().ok, false);
  assert.equal(server.health().dependencies.memory.errorCode, 'MEMORY_UNAVAILABLE');
  assert.ok(!JSON.stringify(server.health()).includes('private upstream details'));
});
test('memory health projects only bounded diagnostic metadata and discards it after verified recovery', async t => {
  const server = await app(t); server.store.createProject({ name: 'Diagnostic fixture' }); server.store.mutate(state => { state.projects[0].simulated = false; });
  const diagnostic = { phase: 'authentication', elapsedMs: 8.5, timeout: false, httpStatus: 401, url: 'private-endpoint', body: 'private-body', key: 'private-key' };
  server.store.memoryService.healthRemote = async () => { throw Object.assign(new Error('private-message'), { memoryDiagnostic: diagnostic }); };
  await server.checkMemory(); assert.equal(server.health().ok, false);
  assert.deepEqual(server.health().dependencies.memory.diagnostic, { phase: 'authentication', elapsedMs: 9, timeout: false, httpStatus: 401 });
  assert.doesNotMatch(JSON.stringify(server.health()), /private-/);
  server.store.memoryService.healthRemote = async () => ({ ready: false, readiness: { status: 'not_ready', diagnostic: { phase: 'readiness', elapsedMs: Infinity, timeout: 'private-key', httpStatus: 999, extra: 'private-body' } } });
  await server.checkMemory(); assert.equal(server.health().ok, false); assert.deepEqual(server.health().dependencies.memory.diagnostic, { phase: 'readiness' });
  server.store.memoryService.healthRemote = async () => ({ ready: true, liveness: { status: 'alive' }, readiness: { status: 'ready', embedding: 'ready' } });
  await server.checkMemory(); assert.equal(server.health().ok, true); assert.equal(server.health().dependencies.memory.diagnostic, undefined);
});
test('shutdown cancels every controller before waiting, bounds a hung close and remains idempotent', async t => {
  const server = await app(t, { runtime: true, shutdownTimeoutMs: 40 });
  let initializedClosed = false, evolutionClosed = false;
  const initializerClose = server.initializer.close.bind(server.initializer);
  server.initializer.close = async () => { initializedClosed = true; await initializerClose(); };
  const evolutionClose = server.evolution.close.bind(server.evolution);
  server.evolution.close = async () => { evolutionClosed = true; await evolutionClose(); };
  // No real work is in flight; the injected hanging close checks cancellation
  // order and the deadline without creating any dangling external resource.
  await server.executor.close(); server.executor.close = () => new Promise(() => {});
  const first = server.close(), second = server.close(); assert.equal(first, second);
  const result = await first;
  assert.equal(result.drained, false); assert.equal(initializedClosed, true); assert.equal(evolutionClosed, true); assert.equal(server.server.listening, false);
});
test('SSE reconnects release subscribers and timers when clients disconnect', async t => {
  const server = await app(t), initialListeners = server.store.listeners.size;
  for (let i = 0; i < 12; i++) {
    const response = await fetch(`${server.base}/api/stream`), reader = response.body.getReader();
    const packet = await reader.read(); assert.equal(packet.done, false); await reader.cancel();
  }
  const deadline = Date.now() + 1000;
  while (server.health().streams && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
  assert.equal(server.health().streams, 0); assert.equal(server.store.listeners.size, initialListeners);
});
