import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MemoryService } from '../memory-service.mjs';

const ready = { status: 'ready', checks: { agfs: { status: 'ok', checks: { filesystem: 'ok', multiwrite_sync: 'not_supported' } }, vectordb: 'ok', api_key_manager: 'ok', embedding: 'ok', ollama: 'not_configured' } };
async function fixture(t, { report = ready, code = 200, delay = 0, authFailure = false, alive = true } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ path: req.url, key: req.headers['x-api-key'] });
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/health') return send({ status: 'ok', healthy: alive, version: 'fixture' });
    if (req.url === '/api/v1/system/status') return send({ status: 'ok', result: { initialized: true } }, authFailure ? 401 : 200);
    if (req.url === '/ready') { if (delay) { const timer = setTimeout(() => send(report, code), delay); res.once('close', () => clearTimeout(timer)); } else send(report, code); return; }
    send({}, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const memory = new MemoryService({});
  const remote = { config: { endpoint: `http://127.0.0.1:${server.address().port}` }, headers: { 'X-API-Key': 'fixture-only-private-key' } };
  return { calls, check: input => memory.healthRemote(remote, input) };
}

test('HTTP liveness and authenticated initialization only become ready after filesystem/vector/embedding evidence', async t => {
  const f = await fixture(t); const health = await f.check();
  assert.equal(health.ready, true); assert.equal(health.liveness.status, 'alive');
  assert.equal(health.readiness.embedding, 'ready'); assert.equal(health.readiness.vlm, 'not_verified');
  assert.equal(health.readiness.semanticQuality, 'not_assessed');
  assert.deepEqual(f.calls.map(v => v.path), ['/health', '/api/v1/system/status', '/ready']);
  assert.ok(f.calls.every(v => v.key === 'fixture-only-private-key'));
});

for (const code of [404, 405]) test(`legacy readiness HTTP ${code} is explicit compatibility, never claimed embedding ready`, async t => {
  const f = await fixture(t, { code }); const health = await f.check();
  assert.equal(health.connected, true); assert.equal(health.authenticated, true); assert.equal(health.ready, false);
  assert.equal(health.readiness.status, 'not_supported'); assert.equal(health.readiness.supported, false);
  assert.equal(health.readiness.embedding, 'not_verified');
});

for (const [name, report] of [
  ['embedding absent', { ...ready, checks: { ...ready.checks, embedding: undefined } }],
  ['embedding not configured', { ...ready, checks: { ...ready.checks, embedding: 'not_configured' } }],
  ['storage absent', { ...ready, checks: { ...ready.checks, agfs: 'not_configured' } }],
  ['vector unhealthy', { ...ready, checks: { ...ready.checks, vectordb: 'unhealthy' } }],
  ['not ready overall', { ...ready, status: 'not_ready' }],
]) test(`${name} cannot become healthy from HTTP 200`, async t => {
  const f = await fixture(t, { report }); const health = await f.check();
  assert.equal(health.ready, false); assert.equal(health.readiness.status, 'not_ready');
});

test('readiness 503 is dependency degradation with liveness retained and private diagnostics excluded', async t => {
  const f = await fixture(t, { code: 503, report: { status: 'not_ready', error: 'private-token-should-not-escape' } });
  const health = await f.check();
  assert.equal(health.ready, false); assert.equal(health.liveness.status, 'alive');
  assert.equal(health.readiness.upstreamStatus, 503);
  assert.equal(health.readiness.diagnostic.phase, 'readiness'); assert.equal(health.readiness.diagnostic.httpStatus, 503);
  assert.equal(health.readiness.diagnostic.timeout, false); assert.ok(health.readiness.diagnostic.elapsedMs >= 0);
  assert.doesNotMatch(JSON.stringify(health), /private-token/);
});

test('health diagnostics distinguish authenticated rejection from a caller readiness deadline without exposing response content', async t => {
  const auth = await fixture(t, { authFailure: true });
  await assert.rejects(auth.check(), error => {
    assert.equal(error.memoryDiagnostic.phase, 'authentication'); assert.equal(error.memoryDiagnostic.httpStatus, 401); assert.equal(error.memoryDiagnostic.timeout, false);
    assert.doesNotMatch(JSON.stringify(error.memoryDiagnostic), /fixture-only-private-key|127\.0\.0\.1/); return true;
  });
  const slow = await fixture(t, { delay: 2000 }), controller = new AbortController();
  const pending = slow.check({ signal: controller.signal });
  while (!slow.calls.some(call => call.path === '/ready')) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort(new DOMException('Isolated deadline', 'TimeoutError'));
  await assert.rejects(pending, error => {
    assert.equal(error.name, 'TimeoutError'); assert.equal(error.memoryDiagnostic.phase, 'readiness'); assert.equal(error.memoryDiagnostic.timeout, true);
    assert.ok(error.memoryDiagnostic.elapsedMs >= 0); assert.equal(error.memoryDiagnostic.httpStatus, undefined); return true;
  });
});

test('caller cancellation during readiness remains an abort, not a completed unhealthy check', async t => {
  const f = await fixture(t, { delay: 2000 }); const controller = new AbortController();
  const pending = f.check({ signal: controller.signal });
  const deadline = Date.now() + 1000;
  while (!f.calls.some(c => c.path === '/ready') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(f.calls.some(c => c.path === '/ready'));
  controller.abort(new Error('test-cancelled'));
  await assert.rejects(pending, /test-cancelled/);
});

test('failed authentication or liveness does not probe embedding', async t => {
  for (const options of [{ authFailure: true }, { alive: false }]) {
    const f = await fixture(t, options); await assert.rejects(f.check(), e => e.status === 503);
    assert.ok(!f.calls.some(v => v.path === '/ready'));
  }
});
