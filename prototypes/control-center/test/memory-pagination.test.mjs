import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MemoryService } from '../memory-service.mjs';

// Matches OpenViking's documented ls order: dirs before files, newest first,
// then case-insensitive/original name. No provider or real service is used.
const compare = (a, b) => Number(b.isDir) - Number(a.isDir) || (Date.parse(b.modTime) || 0) - (Date.parse(a.modTime) || 0) || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0);
async function fixture(t) {
  const f = { root: 'viking://resources/projects/project-1', peer: 'viking://user/fixture/peers/forge-project-1/memories', listings: new Map(), calls: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture'); f.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    let result;
    if (url.pathname.endsWith('/system/status')) result = { initialized: true, user: 'fixture' };
    else if (url.pathname.endsWith('/fs/ls')) {
      const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('node_limit'));
      result = [...(f.listings.get(url.searchParams.get('uri')) ?? [])].sort(compare).slice(offset, offset + limit);
    } else { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  f.service = new MemoryService({ state: { projects: [{ id: 'project-1', memorySessions: [{ isolation: 'project-peer-v1', endpoint, namespace: f.root }] }], configuration: { memory: { backend: 'openviking', endpoint, limit: 20 } } }, configurationService: { secret() {} }, mutate() { throw new Error('Pagination must be read only'); } });
  f.row = (scope, name, second, isDir = false) => ({ uri: `${scope}/${name}`, name, isDir, size: 123, modTime: new Date(Date.UTC(2026, 8, 26, 0, 0, second)).toISOString() });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return f;
}

test('a 38-file memory directory lists newest first and reaches the second page without dropping entries', async t => {
  const f = await fixture(t), child = `${f.peer}/events/2026/09/26`;
  const rows = Array.from({ length: 38 }, (_, i) => f.row(child, `event-${String(i).padStart(2, '0')}.md`, i)); f.listings.set(child, rows);
  const first = await f.service.browse('project-1', { uri: child, limit: 20, offset: 0 });
  const second = await f.service.browse('project-1', { uri: child, limit: 20, offset: first.nextOffset });
  assert.equal(first.hasMore, true); assert.equal(first.nextOffset, 20); assert.equal(second.hasMore, false); assert.equal(second.nextOffset, null);
  assert.deepEqual([...first.entries, ...second.entries].map(row => row.uri), rows.sort(compare).map(row => row.uri));
  assert.equal(first.entries[0].modifiedAt, new Date(Date.UTC(2026, 8, 26, 0, 0, 37)).toISOString());
  assert.ok(f.calls.filter(call => call.path.endsWith('/fs/ls')).every(call => call.query.sort_by === 'mtime' && call.query.sort_order === 'desc' && call.query.node_limit === '21'));
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('merged resource and peer roots each exceeding a page globally interleave by time with stable ties and no page loss', async t => {
  const f = await fixture(t);
  const resources = Array.from({ length: 31 }, (_, i) => f.row(f.root, `item-${String(i * 2).padStart(2, '0')}.md`, Math.floor(i / 2)));
  const memories = Array.from({ length: 34 }, (_, i) => f.row(f.peer, `item-${String(i * 2 + 1).padStart(2, '0')}.md`, Math.floor(i / 2)));
  resources.push(f.row(f.root, 'Z-directory', 3, true)); memories.push(f.row(f.peer, 'A-directory', 2, true));
  f.listings.set(f.root, resources); f.listings.set(f.peer, memories);
  const expected = [...resources, ...memories].sort(compare).map(row => row.uri), found = []; let offset = 0;
  do {
    const page = await f.service.browse('project-1', { uri: f.root, limit: 20, offset }); found.push(...page.entries.map(row => row.uri));
    assert.equal(page.total, page.entries.length); offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(found, expected); assert.equal(new Set(found).size, expected.length);
  assert.ok(found.slice(2, 22).some(uri => uri.startsWith(f.peer)) && found.slice(2, 22).some(uri => uri.startsWith(f.root)));
  assert.ok(f.calls.filter(call => call.path.endsWith('/fs/ls')).every(call => call.query.offset === '0'));
});

test('browse validates page bounds and retains namespace isolation before any directory request', async t => {
  const f = await fixture(t); await f.service.scopes('project-1'); const before = f.calls.length;
  for (const input of [{ offset: -1 }, { offset: 10001 }, { offset: 1.5 }, { limit: 101 }, { uri: `${f.peer}-other/private` }]) await assert.rejects(f.service.browse('project-1', input));
  assert.equal(f.calls.length, before);
});
