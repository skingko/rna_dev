import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function within(promise, label, timeout = 2000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle`)), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function until(check, label) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() >= deadline) throw new Error(`${label} did not settle`); await delay(10); }
}
async function fixture(t, { blockedPath, partialResponse = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-web-disconnect-'));
  const requests = [], started = deferred(), cancelled = deferred();
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, body: JSON.parse(raw) });
    if (req.url === blockedPath) {
      res.once('close', () => { if (!res.writableEnded) cancelled.resolve(); });
      if (partialResponse) { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"success":true,"data":'); }
      started.resolve(); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/v1/search'
      ? { success: true, data: [{ url: 'https://docs.fastcrw.com/', title: 'Docs', snippet: 'Fixture docs' }] }
      : { success: true, data: { markdown: '# Documentation\nFixture page.', metadata: { sourceURL: 'https://docs.fastcrw.com/', statusCode: 200 } } }));
  });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  const app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false });
  await app.initializer.close(); await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  app.store.configurationService.update({ webTools: { enabled: false, baseUrl: `http://127.0.0.1:${upstream.address().port}`, timeoutMs: 10000 } });
  const clients = new Set();
  t.after(async () => {
    for (const client of clients) client.destroy();
    app.server.closeAllConnections(); await app.close();
    upstream.closeAllConnections(); await new Promise(done => upstream.close(done));
    await rm(directory, { recursive: true, force: true });
  });
  function request({ incomplete = false, contentLength = 100 } = {}) {
    const client = http.request({ host: '127.0.0.1', port: app.server.address().port, path: '/api/web-tools/test', method: 'POST', headers: { 'content-type': 'application/json', ...(incomplete ? { 'content-length': contentLength } : {}) } });
    client.on('error', () => {}); clients.add(client); client.once('close', () => clients.delete(client));
    if (incomplete) { client.flushHeaders(); client.write('{'); } else client.end('{}');
    return client;
  }
  return { app, requests, started, cancelled, request, url: `http://127.0.0.1:${app.server.address().port}` };
}

for (const partialResponse of [false, true]) test(`disconnect cancels real search ${partialResponse ? 'response body' : 'pending response'} and never sends the scrape check`, { timeout: 10000 }, async t => {
  const f = await fixture(t, { blockedPath: '/v1/search', partialResponse }), client = f.request();
  await within(f.started.promise, 'upstream search start');
  assert.equal(f.app.health().workload.admittedHttp, 1);
  client.destroy();
  await within(f.cancelled.promise, 'upstream cancellation');
  await until(() => f.app.health().workload.admittedHttp === 0, 'HTTP admission release');
  assert.deepEqual(f.requests.map(row => row.path), ['/v1/search']);
  assert.equal(f.app.capabilityService.webTools.controllers.size, 0);
  assert.equal(f.app.store.state.realUsage.tokens, 0);
  assert.equal((await fetch(`${f.url}/api/health`)).status, 200);
});

test('disconnect during the second real check cancels scrape and releases HTTP admission', { timeout: 10000 }, async t => {
  const f = await fixture(t, { blockedPath: '/v1/scrape', partialResponse: true }), client = f.request();
  await within(f.started.promise, 'upstream scrape start'); client.destroy();
  await within(f.cancelled.promise, 'upstream scrape cancellation');
  await until(() => f.app.health().workload.admittedHttp === 0, 'HTTP admission release');
  assert.deepEqual(f.requests.map(row => row.path), ['/v1/search', '/v1/scrape']);
  assert.equal(f.app.capabilityService.webTools.controllers.size, 0);
});

test('aborting an incomplete JSON upload releases admission without any external request', { timeout: 10000 }, async t => {
  const f = await fixture(t), client = f.request({ incomplete: true });
  await until(() => f.app.health().workload.admittedHttp === 1, 'upload admission'); client.destroy();
  await until(() => f.app.health().workload.admittedHttp === 0, 'upload admission release');
  assert.equal(f.requests.length, 0); assert.equal(f.app.capabilityService.webTools.controllers.size, 0);
});

test('normal request end is not mistaken for disconnect; both real checks finish with the existing response contract', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.url}/api/web-tools/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.ok, true);
  assert.deepEqual(result.testedTools, ['web_search', 'web_fetch']);
  assert.deepEqual(f.requests.map(row => row.path), ['/v1/search', '/v1/scrape']);
  assert.equal(f.app.health().workload.admittedHttp, 0); assert.equal(f.app.capabilityService.webTools.controllers.size, 0);
  assert.equal(f.app.store.state.configuration.webTools.enabled, false);
});

test('an already admitted slow upload cannot start external checks after service shutdown begins', { timeout: 10000 }, async t => {
  const f = await fixture(t), client = f.request({ incomplete: true, contentLength: 2 }), completed = deferred();
  client.once('response', res => { res.resume(); res.once('end', () => completed.resolve(res.statusCode)); });
  await until(() => f.app.health().workload.admittedHttp === 1, 'upload admission');
  const closed = f.app.close(); await delay(0);
  client.end('}');
  assert.equal(await within(completed.promise, 'closing response'), 503);
  { const result = await within(closed, 'daemon close'); assert.equal(result.drained, true); assert.deepEqual(result.diagnostic.pending, []); }
  assert.equal(f.requests.length, 0); assert.equal(f.app.health().workload.admittedHttp, 0);
});

test('daemon close aborts the first real check without sending its second request and drains normally', { timeout: 10000 }, async t => {
  const f = await fixture(t, { blockedPath: '/v1/search', partialResponse: true }), client = f.request(), completed = deferred();
  client.once('response', res => { res.resume(); res.once('end', () => completed.resolve(res.statusCode)); });
  await within(f.started.promise, 'upstream start');
  const closed = f.app.close();
  await within(f.cancelled.promise, 'upstream cancellation during close');
  assert.equal(await within(completed.promise, 'closing response'), 503);
  { const result = await within(closed, 'daemon close'); assert.equal(result.drained, true); assert.deepEqual(result.diagnostic.pending, []); }
  assert.deepEqual(f.requests.map(row => row.path), ['/v1/search']);
  assert.equal(f.app.health().workload.admittedHttp, 0); assert.equal(f.app.capabilityService.webTools.controllers.size, 0);
});

test('closed service exposes no tools, refuses retained descriptors and skips the second explicit check without network', { timeout: 10000 }, async t => {
  const f = await fixture(t), service = f.app.capabilityService.webTools;
  f.app.store.configurationService.update({ webTools: { enabled: true } });
  const retained = service.tools(); assert.equal(retained.length, 2);
  service.close(); assert.deepEqual(service.tools(), []);
  for (const tool of retained) {
    const result = await tool.execute('after-close', tool.name === 'web_search' ? { query: 'test' } : { url: 'https://example.test' });
    assert.equal(result.isError, true); assert.equal(result.details.code, 'WEB_TOOLS_CLOSED'); assert.equal(result.details.executed, false);
  }
  const checked = await service.test();
  assert.equal(checked.ok, false); assert.equal(checked.code, 'WEB_TOOLS_CLOSED'); assert.equal(checked.checks.length, 1);
  assert.deepEqual(checked.testedTools, []); assert.equal(f.requests.length, 0);
});
