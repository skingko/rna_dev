import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MemoryService } from '../memory-service.mjs';

async function fixture(t) {
  const f = { root: 'viking://resources/projects/project-1', peer: 'viking://user/fixture/peers/forge-project-1/memories', listings: new Map(), unavailable: new Set(), missing: new Set(), calls: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture'), uri = url.searchParams.get('uri');
    f.calls.push({ method: req.method, path: url.pathname, uri });
    if (f.invalidEndpoint) { res.writeHead(404); return res.end('{}'); }
    let result;
    if (url.pathname === '/health') { f.onHealth?.(); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ status: 'ok', healthy: true })); }
    else if (url.pathname.endsWith('/system/status')) result = { initialized: true, user: 'fixture' };
    else if (url.pathname.endsWith('/fs/ls')) {
      f.onList?.(uri);
      if (f.missing.has(uri)) { res.writeHead(404); return res.end('{}'); }
      if (f.unavailable.has(uri)) { res.writeHead(503); return res.end('{}'); }
      const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('node_limit'));
      result = (f.listings.get(uri) ?? []).slice(offset, offset + limit);
    } else { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  f.state = { projects: [{ id: 'project-1', memorySessions: [{ isolation: 'project-peer-v1', endpoint, namespace: f.root }] }], sessions: [], configuration: { memory: { backend: 'openviking', endpoint, limit: 20 } } };
  f.service = new MemoryService({ state: f.state, configurationService: { secret() {} }, mutate() { throw new Error('Recent navigation must be read only'); } });
  f.row = (scope, name, minute = 0, isDir = false) => ({ uri: `${scope}/${name}`, name, isDir, size: 123, modTime: new Date(Date.UTC(2026, 8, 26, 0, minute)).toISOString() });
  f.branch = (root, paths) => { let parent = root; for (const name of paths) { const row = f.row(parent, name, 0, true); f.listings.set(parent, [...(f.listings.get(parent) ?? []), row]); parent = row.uri; } return parent; };
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return f;
}

test('recent memory exposes deep L2 leaves and separate resource counts without reading any text or triggering extraction', async t => {
  const f = await fixture(t), day = f.branch(f.peer, ['events', '2026', '09', '26']);
  const entity = f.branch(f.peer, ['entities', 'project']);
  f.listings.set(day, Array.from({ length: 44 }, (_, i) => f.row(day, `event-${i}.md`, i)));
  f.listings.set(entity, [f.row(entity, 'project.md', 46)]); f.listings.set(f.root, [f.row(f.root, 'source.md', 47)]);
  const page = await f.service.browse('project-1', { view: 'recent' });
  assert.deepEqual({ memoryFiles: page.collection.memoryFiles, resourceFiles: page.collection.resourceFiles, complete: page.collection.complete }, { memoryFiles: 45, resourceFiles: 1, complete: true });
  assert.equal(page.entries[0].kind, 'resource'); assert.equal(page.entries[1].kind, 'memory');
  assert.equal(page.entries[1].category, 'entities'); assert.equal(page.entries[2].path, 'events/2026/09/26/event-43.md');
  assert.ok(page.entries.every(row => row.isLeaf && !row.isDirectory && row.availableReads.join() === 'L2'));
  assert.equal(page.hasMore, true); assert.equal(page.nextOffset, 20);
  assert.ok(f.calls.every(call => call.method === 'GET' && /\/(?:ls|status)$/.test(call.path)));
});

test('metadata snapshot stabilizes pagination; explicit refresh observes changes and never reads assistant text', async t => {
  const f = await fixture(t); f.listings.set(f.peer, Array.from({ length: 145 }, (_, i) => f.row(f.peer, `event-${i}.md`, i)));
  const first = await f.service.browse('project-1', { view: 'recent', limit: 100 }); const requests = f.calls.length;
  f.listings.set(f.peer, [f.row(f.peer, 'new.md', 999), ...f.listings.get(f.peer)]);
  const second = await f.service.browse('project-1', { view: 'recent', limit: 100, offset: first.nextOffset });
  assert.equal(f.calls.length, requests); assert.equal(second.collection.memoryFiles, 145);
  assert.equal(new Set([...first.entries, ...second.entries].map(row => row.uri)).size, 145);
  assert.equal((await f.service.browse('project-1', { view: 'recent', refresh: 'true' })).entries[0].title, 'new.md');
  assert.ok(f.calls.length > requests);
});

test('unavailable subdirectories are visible partial results and are not cached as an empty collection', async t => {
  const f = await fixture(t), child = f.branch(f.peer, ['events']);
  f.listings.set(f.root, [f.row(f.root, 'known.md')]); f.unavailable.add(child);
  const partial = await f.service.browse('project-1', { view: 'recent' });
  assert.equal(partial.collection.complete, false); assert.equal(partial.scanLimited, false);
  assert.deepEqual(partial.warnings, [{ code: 'MEMORY_INDEX_DIRECTORY_UNAVAILABLE' }]);
  f.unavailable.clear(); f.listings.set(child, [f.row(child, 'recovered.md')]);
  const recovered = await f.service.browse('project-1', { view: 'recent' });
  assert.equal(recovered.collection.complete, true); assert.equal(recovered.collection.memoryFiles, 1);
});

test('large collections are bounded, report incomplete scans, and do not claim global newest ordering completeness', async t => {
  const f = await fixture(t); f.listings.set(f.peer, Array.from({ length: 700 }, (_, i) => f.row(f.peer, `event-${i}.md`, i)));
  const result = await f.service.browse('project-1', { view: 'recent' });
  assert.equal(result.collection.memoryFiles, 500); assert.equal(result.collection.complete, false); assert.equal(result.scanLimited, true);
  assert.deepEqual(result.warnings, [{ code: 'MEMORY_INDEX_SCAN_LIMIT' }]); assert.ok(f.calls.length <= 8);
});

test('namespace escape, malformed entries and hidden sidecars never become memory files', async t => {
  const f = await fixture(t);
  f.listings.set(f.peer, [f.row(f.peer, 'valid.md'), f.row(f.peer, '.abstract.md'), f.row(`${f.peer}-other`, 'secret.md'), f.row(f.peer, 'not-immediate/leaf.md'), { ...f.row(f.peer, 'denied.md'), access: 'denied' }]);
  const result = await f.service.browse('project-1', { view: 'recent' });
  assert.equal(result.collection.memoryFiles, 1); assert.equal(result.entries[0].title, 'valid.md'); assert.equal(result.collection.complete, false);
  const count = f.calls.length;
  await assert.rejects(f.service.browse('project-1', { view: 'recent', uri: `${f.peer}-other` }), /项目根目录/);
  await assert.rejects(f.service.browse('project-1', { view: 'recent', offset: -1 })); assert.equal(f.calls.length, count);
});

test('cached files are rechecked against source revocation and scope changes force fresh discovery', async t => {
  const f = await fixture(t); f.listings.set(f.root, [f.row(f.root, 'document.md')]);
  const first = await f.service.browse('project-1', { view: 'recent' }); assert.equal(first.collection.resourceFiles, 1);
  f.service.evidenceResourceVisible = () => false;
  assert.equal((await f.service.browse('project-1', { view: 'recent' })).collection.resourceFiles, 0);
  const calls = f.calls.length; f.state.projects[0].memorySummary = { revision: 2 };
  await f.service.browse('project-1', { view: 'recent' }); assert.ok(f.calls.length > calls);
});

test('ordinary directory responses identify categories as directories rather than counting two memories', async t => {
  const f = await fixture(t); f.branch(f.peer, ['entities']); f.branch(f.peer, ['events']);
  const page = await f.service.browse('project-1', { view: 'directory' });
  assert.equal(page.view, 'directory'); assert.deepEqual(page.pageCounts, { directories: 2, files: 0 });
  assert.ok(page.entries.every(row => row.kind === 'memory' && row.isDirectory));
});

test('complete transport outage is an error rather than a successful zero-memory result', async t => {
  const f = await fixture(t); f.unavailable.add(f.root); f.unavailable.add(f.peer);
  await assert.rejects(f.service.browse('project-1', { view: 'recent' }), error => error.status === 503);
  assert.equal(f.service.browseSnapshots.size, 0);
});

test('an endpoint returning 404 for every route cannot be cached as a successful empty memory collection', async t => {
  const f = await fixture(t); f.state.projects[0].memorySessions = []; f.invalidEndpoint = true;
  await assert.rejects(f.service.browse('project-1', { view: 'recent' }), error => error.upstreamStatus === 404);
  assert.equal(f.calls.filter(call => call.path === '/health').length, 1);
  assert.equal(f.service.browseSnapshots.size, 0);
  assert.ok(f.calls.every(call => call.method === 'GET'), 'Navigation must not initialize or write to the invalid endpoint');
});

test('missing roots on a healthy authenticated service share one probe and remain a read-only empty collection', async t => {
  const f = await fixture(t); f.missing.add(f.root); f.missing.add(f.peer);
  const result = await f.service.browse('project-1', { view: 'recent' });
  assert.equal(result.collection.complete, true); assert.equal(result.collection.memoryFiles, 0); assert.equal(result.collection.resourceFiles, 0);
  assert.deepEqual(result.entries, []); assert.deepEqual(result.warnings, []);
  assert.equal(f.calls.filter(call => call.path === '/health').length, 1, 'Concurrent root 404s share the health probe');
  assert.equal(f.calls.filter(call => call.path.endsWith('/system/status')).length, 2, 'One identity lookup and one authenticated health check');
  assert.ok(f.calls.every(call => call.method === 'GET'));
  const count = f.calls.length; await f.service.browse('project-1', { view: 'recent' }); assert.equal(f.calls.length, count, 'Verified empty collections may use the existing short-lived cache');
});

test('successful recent directory listings do not add health or readiness probes', async t => {
  const f = await fixture(t); f.listings.set(f.root, [f.row(f.root, 'document.md')]);
  const result = await f.service.browse('project-1', { view: 'recent' });
  assert.equal(result.collection.resourceFiles, 1); assert.equal(result.collection.complete, true);
  assert.equal(f.calls.filter(call => ['/health', '/ready'].includes(call.path)).length, 0);
});

test('connection changes while verifying a missing root discard the empty result', async t => {
  const f = await fixture(t); f.missing.add(f.root); f.missing.add(f.peer);
  f.onHealth = () => { f.state.configuration.memory.endpoint = 'http://127.0.0.1:1'; };
  await assert.rejects(f.service.browse('project-1', { view: 'recent' }), error => error.status === 409);
  assert.equal(f.service.browseSnapshots.size, 0);
});

test('connection changes during a scan discard old-scope responses before publishing or caching', async t => {
  const f = await fixture(t); f.listings.set(f.peer, [f.row(f.peer, 'old-tenant.md')]);
  f.onList = () => { f.state.configuration.memory.endpoint = 'http://127.0.0.1:1'; };
  await assert.rejects(f.service.browse('project-1', { view: 'recent' }), error => error.status === 409);
  assert.equal(f.service.browseSnapshots.size, 0);
});
