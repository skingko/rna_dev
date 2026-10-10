import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { MemorySummarySync } from '../memory-summary-sync.mjs';

// Isolated protocol fixture: no semantic model and no production state. Model
// output quality is not asserted; this exercises complete tree verification of a whole-tree rebuild submitted before
// MEM-8 (nothing is submitted any more; one already submitted is verified to its end).
async function fixture(t, { maxNodes = 100 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-memory-depth-'));
  const f = { calls: [], posts: 0, clock: 1000, completed: false, missingLayer: false };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'); let raw = '';
    for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : null;
    f.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    const send = result => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', result })); };
    if (url.pathname.endsWith('/system/status')) return send({ initialized: true, user: 'fixture' });
    if (url.pathname.endsWith('/fs/ls')) {
      const uri = url.searchParams.get('uri');
      // Match the upstream default: recursive=true silently stops at depth 3.
      const recursive = url.searchParams.get('recursive') === 'true';
      const prefix = uri + '/', depth = uri.split('/').length;
      const rows = f.entries.filter(row => row.uri.startsWith(prefix) && row.uri.split('/').length <= depth + (recursive ? 3 : 1));
      return send(rows.slice(0, Number(url.searchParams.get('node_limit'))));
    }
    if (url.pathname.endsWith('/content/reindex')) {
      f.posts++; assert.equal(body.uri, f.root); return send({ task_id: 'fixture-summary', status: 'accepted', uri: f.root, object_type: 'memory', mode: 'semantic_and_vectors' });
    }
    if (url.pathname.endsWith('/tasks/fixture-summary')) return send({ task_id: 'fixture-summary', task_type: 'admin_reindex', resource_id: f.root, status: f.completed ? 'completed' : 'running', result: f.completed ? { status: 'completed', uri: f.root, object_type: 'memory', mode: 'semantic_and_vectors', scanned_records: 2, rebuilt_records: 8, failed_records: 0 } : null });
    if (url.pathname.endsWith('/content/abstract') || url.pathname.endsWith('/content/overview')) {
      const uri = url.searchParams.get('uri');
      return send(f.missingLayer && uri === f.deepDirectory ? `# ${uri} [Directory abstract is not ready]` : 'Fixture directory summary.');
    }
    if (url.pathname.endsWith('/content/read')) return send('Fixture original.');
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.store = new Store(join(dir, 'state.json'));
  f.store.configurationService.update({ memory: { endpoint: `http://127.0.0.1:${server.address().port}` } });
  f.project = f.store.createProject({ name: 'Memory depth fixture' }).project;
  f.root = `viking://user/fixture/peers/forge-${f.project.id}/memories`;
  f.deepDirectory = `${f.root}/events/2026/09/26`;
  f.entries = [
    { uri: `${f.root}/entity.md`, isDir: false },
    ...['events', 'events/2026', 'events/2026/09', 'events/2026/09/26'].map(path => ({ uri: `${f.root}/${path}`, isDir: true })),
    { uri: `${f.deepDirectory}/decision.md`, isDir: false }
  ];
  f.store.mutate(state => {
    const project = state.projects.find(p => p.id === f.project.id);
    project.memorySummary = { schemaVersion: 1, id: 'fixture-row', revision: 1, targetRevision: 1, sourceFingerprint: 'fp', targetFingerprint: 'fp', lastSourceTaskId: 'fixture-commit', status: 'polling', taskId: 'fixture-summary', nextPollAt: 0,
      connectionFingerprint: f.store.memoryService.connectionFingerprint(project.id), endpoint: state.configuration.memory.endpoint, userId: 'fixture', actorPeerId: `forge-${project.id}`, uri: f.root,
      expectedFiles: [`${f.root}/entity.md`, `${f.deepDirectory}/decision.md`].sort(), expectedDirectories: [f.root, ...['events', 'events/2026', 'events/2026/09', 'events/2026/09/26'].map(path => `${f.root}/${path}`)] };
  });
  f.sync = new MemorySummarySync(f.store, { now: () => f.clock, pollMs: 10, maxNodes });
  f.row = () => f.store.state.projects.find(p => p.id === f.project.id).memorySummary;
  f.step = async () => { f.clock += 100; await Promise.all(f.sync.pump()); };
  t.after(async () => { await f.sync.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  return f;
}

test('verification traverses day-scoped events beyond upstream recursive depth and checks every original', async t => {
  const f = await fixture(t); await f.step();
  assert.equal(f.row().status, 'polling');
  f.completed = true; await f.step();
  assert.equal(f.row().status, 'completed');
  assert.deepEqual([f.row().verification.directories, f.row().verification.files, f.row().verification.layers], [5, 2, 10]);
  assert.ok(f.calls.some(call => call.path.endsWith('/content/read') && call.query.uri === `${f.deepDirectory}/decision.md`));
  assert.ok(f.calls.filter(call => call.path.endsWith('/fs/ls')).every(call => call.query.recursive === 'false'));
  assert.equal(f.posts, 0);
});

test('deep unfinished directory cannot be hidden by a completed reindex receipt', async t => {
  const f = await fixture(t); await f.step(); f.completed = true; f.missingLayer = true; await f.step();
  assert.equal(f.row().status, 'failed'); assert.equal(f.row().code, 'MEMORY_SUMMARY_LAYER_INCOMPLETE');
  for (let n = 0; n < 10; n++) await f.step();
  assert.equal(f.posts, 0); assert.equal(f.row().verifiedRevision, undefined);
  assert.deepEqual([f.row().status, f.row().lastFailure.code], ['skipped', 'MEMORY_SUMMARY_LAYER_INCOMPLETE'], 'the settled failure retires (MEM-8)');
});

test('the aggregate tree bound applies across small directories', async t => {
  const f = await fixture(t, { maxNodes: 4 }); f.completed = true; await f.step();
  assert.equal(f.row().status, 'failed'); assert.equal(f.row().code, 'MEMORY_SUMMARY_TREE_LIMIT');
  assert.equal(f.posts, 0); assert.equal(f.row().verifiedRevision, undefined);
});
