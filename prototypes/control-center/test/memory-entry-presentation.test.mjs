import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MemoryService } from '../memory-service.mjs';
import { planMemoryEvidence, memoryEvidenceDocument } from '../memory-evidence-outbox.mjs';
import { memoryTextPresentation } from '../memory-entry-presentation.mjs';

async function fixture(t) {
  const f = { root: 'viking://resources/projects/p', peer: 'viking://user/alice/peers/forge-p/memories', calls: [], files: [] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'), uri = url.searchParams.get('uri'); f.calls.push([req.method, url.pathname]);
    let result;
    if (url.pathname.endsWith('/system/status')) result = { initialized: true, user: 'alice' };
    else if (url.pathname.endsWith('/fs/ls')) {
      f.onList?.();
      const rows = new Map();
      for (const leaf of f.files) {
        if (!leaf.uri.startsWith(`${uri}/`)) continue;
        const name = leaf.uri.slice(uri.length + 1).split('/')[0], isDir = leaf.uri !== `${uri}/${name}`;
        rows.set(name, isDir ? { name, uri: `${uri}/${name}`, isDir: true } : leaf);
      }
      const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('node_limit'));
      result = [...rows.values()].slice(offset, offset + limit);
    } else if (url.pathname.endsWith('/search/find')) {
      f.onSearch?.(); let raw = ''; for await (const part of req) raw += part;
      const scope = JSON.parse(raw).target_uri;
      result = { resources: f.files.filter(row => row.uri.startsWith(`${scope}/`)).map(row => ({ uri: row.uri, level: 2, score: 1, abstract: 'Remote summary' })) };
    } else if (url.pathname.endsWith('/content/read')) result = f.document;
    else { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  f.state = { projects: [{ id: 'p', memorySessions: [{ isolation: 'project-peer-v1', endpoint, namespace: f.root }], initiativeRuntime: { sdkState: { actions: [{ id: 'share', action: 'share' }] } } }],
    sessions: [{ id: 's', projectId: 'p', items: [{ id: 'delivery', kind: 'assistant', source: 'initiative', initiativeActionId: 'share', turnId: null, simulated: false,
      text: '## AI 应用调研：可验证的交付\n\n今天检查了 **三项变化**，详见 [来源](https://example.com)。\n\n```json\n{"toolCallId":"private-receipt"}\n```', createdAt: '2026-09-26T12:00:00Z' }], memoryEvidenceState: { seen: [] } }],
    configuration: { memory: { backend: 'openviking', endpoint, limit: 20 } } };
  f.service = new MemoryService({ state: f.state, configurationService: { secret() {} }, mutate() { throw new Error('Presentation must not mutate'); } });
  f.session = f.state.sessions[0]; f.item = f.session.items[0];
  f.write = planMemoryEvidence(f.state, f.session, { namespace: f.root, connectionFingerprint: f.service.connectionFingerprint('p') }).records[0];
  f.write.resourceIndex.status = 'completed'; f.session.memoryEvidenceOutbox = [f.write]; f.uri = f.write.resourceIndex.uri;
  f.document = memoryEvidenceDocument(f.state, 's', f.write);
  f.add = (uri, minute = 0) => f.files.push({ uri, name: uri.split('/').at(-1), isDir: false, modTime: new Date(Date.UTC(2026, 8, 26, 12, minute)).toISOString() });
  f.add(f.uri);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return f;
}

test('recent, directory and semantic search expose the same verified readable title while preserving original identity', async t => {
  const f = await fixture(t), before = structuredClone(f.state);
  const pages = [await f.service.browse('p', { view: 'recent' }), await f.service.browse('p', { uri: `${f.root}/rna-execution-evidence/s` }), await f.service.search('p', { query: 'AI' })];
  for (const page of pages) {
    const row = page.entries.find(entry => entry.uri === f.uri);
    assert.equal(row.title, `${f.write.sourceRefs[0].sourceHash}.md`); assert.equal(row.fileName, row.title);
    assert.equal(row.displayTitle, 'AI 应用调研：可验证的交付'); assert.equal(row.displayTitleSource, 'assistant_delivery');
    assert.match(row.displayExcerpt, /今天检查了 三项变化，详见 来源/); assert.doesNotMatch(row.displayExcerpt, /toolCallId|private-receipt|\*\*|https:/);
    assert.deepEqual(row.provenance, { kind: 'autonomous_delivery', role: 'assistant', sessionId: 's', itemId: 'delivery', createdAt: f.item.createdAt, sourceHash: f.write.sourceRefs[0].sourceHash });
  }
  assert.deepEqual(f.state, before); assert.ok(f.calls.every(([method, path]) => method === 'GET' || method === 'POST' && path.endsWith('/search/find')));
  assert.ok(f.calls.every(([, path]) => !path.includes('/content/')));
  const raw = await f.service.read('p', { uri: f.uri, maxChars: 64000 }); assert.equal(raw.content, f.document);
});

test('cached navigation never retains derived text and current source edits, revocation or removal hide stale evidence', async t => {
  for (const mode of ['edited', 'revoked', 'action-revoked', 'removed', 'tombstone']) {
    const f = await fixture(t); await f.service.browse('p', { view: 'recent' }); const calls = f.calls.length;
    const snapshots = JSON.stringify([...f.service.browseSnapshots.values()]);
    assert.doesNotMatch(snapshots, /AI 应用调研|三项变化|private-receipt|displayTitle|displayExcerpt|provenance/);
    if (mode === 'edited') f.item.text += ' Source changed.';
    if (mode === 'revoked') f.item.contextRevoked = true;
    // A real revocation of the delivering action: a privacy boundary (or a deletion), not context drift.
    if (mode === 'action-revoked') Object.assign(f.state.projects[0].initiativeRuntime.sdkState.actions[0], { contextRevoked: true, privacyRevoked: true });
    if (mode === 'removed') f.session.items.length = 0;
    if (mode === 'tombstone') f.state.sessionDeletions = [{ projectId: 'p', evidenceResourceRevocations: [{ uri: f.uri }] }];
    const result = await f.service.browse('p', { view: 'recent' });
    assert.equal(result.entries.length, 0, mode); assert.equal(result.collection.resourceFiles, 0, mode); assert.equal(f.calls.length, calls);
  }
  // Context drift alone (contextRevoked on the delivering action) is not a revocation (MEM-1): the delivery stays listed.
  const f = await fixture(t); f.state.projects[0].initiativeRuntime.sdkState.actions[0].contextRevoked = true;
  assert.ok((await f.service.browse('p', { view: 'recent' })).entries.length > 0);
});

test('source revoked while awaiting remote search/list response cannot publish derived metadata', async t => {
  const f = await fixture(t);
  f.onSearch = () => { f.item.sourceDeleted = true; };
  assert.equal((await f.service.search('p', { query: 'AI' })).entries.length, 0);
  delete f.item.sourceDeleted;
  f.onList = () => { f.item.contextRevoked = true; };
  assert.equal((await f.service.browse('p', { uri: `${f.root}/rna-execution-evidence/s` })).entries.length, 0);
});

test('archiving retains readable source, whereas unknown or unconfirmed execution documents remain hidden', async t => {
  const f = await fixture(t); f.session.archivedAt = '2026-09-26T13:00:00Z';
  assert.equal((await f.service.browse('p', { view: 'recent' })).entries[0].displayTitleSource, 'assistant_delivery');
  f.add(`${f.root}/rna-execution-evidence/s/${'a'.repeat(64)}.md`); f.write.resourceIndex.status = 'uncertain';
  const page = await f.service.browse('p', { view: 'recent', refresh: true });
  assert.equal(page.entries.length, 0); assert.equal(page.collection.resourceFiles, 0);
});

test('category filters run before pagination, preserve global inventory, share metadata cache and reject invalid values', async t => {
  const f = await fixture(t); f.add(`${f.peer}/events/recent.md`, 20); f.add(`${f.root}/older.md`, 1); f.add(`${f.peer}/events/old.md`, 0);
  const all = await f.service.browse('p', { view: 'recent', limit: 1 }); const calls = f.calls.length;
  const memory = await f.service.browse('p', { view: 'recent', filter: 'memory', limit: 1 });
  const second = await f.service.browse('p', { view: 'recent', filter: 'memory', offset: memory.nextOffset, limit: 1 });
  const resource = await f.service.browse('p', { view: 'recent', filter: 'resource', limit: 1 });
  assert.equal(all.filter, 'all'); assert.equal(all.matchingFiles, 4);
  assert.equal(memory.filter, 'memory'); assert.equal(memory.matchingFiles, 2); assert.equal(memory.entries[0].title, 'recent.md'); assert.equal(memory.hasMore, true);
  assert.equal(second.entries[0].title, 'old.md'); assert.equal(second.hasMore, false); assert.equal(second.nextOffset, null);
  assert.equal(resource.entries[0].title, 'older.md'); assert.equal(resource.matchingFiles, 2);
  assert.deepEqual(resource.collection, all.collection); assert.equal(f.calls.length, calls);
  await assert.rejects(f.service.browse('p', { view: 'recent', filter: 'invalid' }), error => error.status === 400);
  assert.equal(f.calls.length, calls);
});

test('ordinary opaque names receive honest fallback labels without inventing descriptions or reading remote files', async t => {
  const f = await fixture(t); f.files.length = 0;
  f.add(`${f.peer}/events/${'b'.repeat(64)}.md`); f.add(`${f.root}/e52c32a4-1f5b-40b7-b853-458030904b63.md`); f.add(`${f.root}/用户调研.md`);
  const page = await f.service.browse('p', { view: 'recent' });
  assert.equal(page.entries.find(row => row.kind === 'memory').displayTitle, '项目记忆 · bbbbbbbb');
  assert.equal(page.entries.find(row => row.title.startsWith('e52c')).displayTitle, '项目资料 · e52c32a4');
  assert.equal(page.entries.find(row => row.title === '用户调研.md').displayTitle, '用户调研');
  assert.ok(page.entries.every(row => row.displayExcerpt === undefined && row.provenance === undefined));
  assert.ok(f.calls.every(([method, path]) => method === 'GET' && !path.includes('/content/')));
});

test('author wording is retained, Markdown and structured data omitted, bounds count Unicode codepoints', () => {
  const view = memoryTextPresentation('```json\n{"tool":"private"}\n```\n\n## **🧠 研究结果**\n\n[模型](https://example.test) 与 `工具` 已检查。\n\n' + '🧠研'.repeat(400));
  assert.equal(view.displayTitle, '🧠 研究结果'); assert.match(view.displayExcerpt, /模型 与 工具 已检查/);
  assert.equal(Array.from(view.displayExcerpt).length, 180); assert.ok(!view.displayExcerpt.includes('\uFFFD'));
  const prose = memoryTextPresentation('已经完成来源核对。接下来检查引用。'); assert.equal(prose.displayTitle, '已经完成来源核对。');
  assert.deepEqual(memoryTextPresentation('```json\n{"toolCallId":"x"}\n```\n{}'), {});
});
