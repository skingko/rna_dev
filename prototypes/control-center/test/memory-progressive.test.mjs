import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../store.mjs';
import { estimateMemoryTokens, passageHash } from '../memory-service.mjs';
import { readStateFile } from '../state-shards.mjs';

async function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-progressive-memory-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const calls = [], f = { calls, roots: new Set(), results: [], content: '第一行\n第二行\n', overview: '目录的真实概览', abstract: '目录的真实摘要', ...overrides };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://fixture'), body = raw ? JSON.parse(raw) : null;
    const call = { path: url.pathname, params: Object.fromEntries(url.searchParams), body }; calls.push(call);
    const send = (result, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(status === 200 ? { status: 'ok', result } : {})); };
    if (f.unavailable) return send({}, f.unavailable);
    if (call.path === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ status: 'ok', healthy: true })); }
    if (call.path === '/ready' && f.ready) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(f.ready)); }
    if (call.path.endsWith('/system/status')) return send({ initialized: true, user: 'rna-test' });
    if (call.path.endsWith('/fs/mkdir')) { f.roots.add(body.uri); return send({ uri: body.uri }); }
    if (call.path.endsWith('/fs/ls')) return f.roots.has(call.params.uri) ? send(f.listings?.[call.params.uri] ?? []) : send({}, 404);
    if (call.path.endsWith('/fs/stat')) return send({ isDir: !call.params.uri.endsWith('/guide.md') });
    if (call.path.endsWith('/search/find')) return send({ resources: f.results, memories: f.duplicateResults ?? [] });
    if (call.path.endsWith('/content/overview')) return f.missingOverview ? send({}, 404) : send(f.overview);
    if (call.path.endsWith('/content/abstract')) return send(f.abstract);
    if (call.path.endsWith('/content/read')) return send(f.content);
    send({}, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  f.file = join(directory, 'state.json'); f.store = new Store(f.file);
  f.store.configurationService.update({ memory: { endpoint: `http://127.0.0.1:${server.address().port}` } });
  f.project = f.store.createProject({ name: '渐进记忆' }).project;
  f.namespace = `viking://resources/projects/${f.project.id}`;
  return f;
}

test('旧全局层级迁移清除；自动引用和预算默认启用且旧客户端不再固定检索层', async t => {
  const f = await fixture(t);
  assert.deepEqual({ autoRecall: f.store.state.configuration.memory.autoRecall, contextBudget: f.store.state.configuration.memory.contextBudget }, { autoRecall: true, contextBudget: 2048 });
  const raw = readStateFile(f.file).state;
  raw.configuration.memory.defaultLevel = 'L2'; delete raw.configuration.memory.autoRecall; delete raw.configuration.memory.contextBudget;
  writeFileSync(f.file, JSON.stringify(raw));
  const store = new Store(f.file);
  assert.equal(store.state.configuration.memory.defaultLevel, undefined); assert.equal(store.configurationService.public().memory.autoRecall, true);
  const config = store.configurationService.update({ memory: { defaultLevel: 'L1' } });
  assert.equal(config.memory.defaultLevel, undefined);
  await store.memoryService.search(f.project.id, { query: '资料' });
  assert.equal(f.calls.at(-1).body.level, undefined); assert.equal(f.calls.at(-1).body.read_content, false);
});

test('上下文预算和自动引用严格校验，非法设置不写入', async t => {
  const f = await fixture(t), before = f.store.configurationService.public();
  for (const memory of [{ autoStore: 'true' }, { autoRecall: 'true' }, { contextBudget: 255 }, { contextBudget: 16001 }, { contextBudget: 1024.5 }, { defaultLevel: 'L3' }]) assert.throws(() => f.store.configurationService.update({ memory }));
  assert.deepEqual(f.store.configurationService.public(), before);
  assert.equal(f.store.configurationService.update({ memory: { autoRecall: false, contextBudget: 512 } }).memory.contextBudget, 512);
});

test('搜索跨层返回真实节点信息、可展开来源；去重并过滤越界和拒绝访问结果', async t => {
  const f = await fixture(t), ns = f.namespace;
  f.results = [
    { uri: `${ns}/design/.abstract.md`, level: 0, abstract: '主题摘要', score: .7 },
    { uri: `${ns}/architecture/.overview.md`, level: 1, abstract: '概览摘录', score: .9 },
    { uri: `${ns}/guide.md`, level: 2, abstract: '文件摘录', content: '不应自动加载的完整正文', score: .8 },
    { uri: `${ns}/unknown`, abstract: '旧服务未提供类型' },
    { uri: `${ns}-other/private`, level: 2, abstract: '其他项目' },
    { uri: `${ns}/../escape`, level: 2 },
    { uri: `${ns}/%2e%2e/private`, level: 2 },
    { uri: `${ns}/denied`, access: 'denied', level: 2 }
  ];
  f.duplicateResults = [{ ...f.results[2], score: .5 }];
  const found = await f.store.memoryService.search(f.project.id, { query: '设计' });
  assert.equal(found.selection, 'all'); assert.equal(found.entries.length, 4);
  assert.deepEqual(found.entries.map(row => row.level), ['L1', 'L2', 'L0', null]);
  assert.equal(found.entries[0].expandUri, `${ns}/architecture`); assert.equal(found.entries[0].isDirectory, true);
  assert.deepEqual(found.entries[0].availableReads, ['L0', 'L1']); assert.equal(found.entries[1].isLeaf, true);
  assert.equal(found.entries[1].content, '文件摘录'); assert.equal(found.entries.at(-1).isLeaf, null);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.target_uri, ns); assert.equal(f.calls[0].body.level, undefined);
});

test('显式高级索引过滤只过滤检索，不虚构返回层级或主动读取内容', async t => {
  const f = await fixture(t); f.results = [{ uri: `${f.namespace}/design/.overview.md`, level: 1, abstract: '实际概览摘录' }];
  const result = await f.store.memoryService.search(f.project.id, { query: '设计', level: 'L0' });
  assert.equal(f.calls[0].body.level, '0'); assert.equal(f.calls[0].body.read_content, false); assert.equal(result.entries[0].level, 'L1'); assert.equal(f.calls.length, 1);
});

test('自动引用初始化缺失根目录，跨层候选按预算注入且保留来源和Unicode', async t => {
  const f = await fixture(t); f.results = [
    { uri: `${f.namespace}/design/.overview.md`, level: 1, abstract: '项目约定😀'.repeat(200), score: .9 },
    { uri: `${f.namespace}/guide.md`, level: 2, abstract: '详细说明'.repeat(200), score: .8 }
  ];
  const recalled = await f.store.memoryService.recall(f.project.id, { query: '本轮设计', budgetTokens: 300 });
  assert.equal(recalled.stage, 'summaries'); assert.equal(recalled.status, 'ready'); assert.equal(recalled.truncated, true);
  assert.ok(recalled.estimatedTokens <= 300); assert.equal(recalled.estimatedTokens, Math.ceil(Buffer.byteLength(recalled.content, 'utf8') / 3));
  assert.deepEqual(JSON.parse(recalled.content), recalled.entries); assert.equal(recalled.entries[0].uri, f.results[0].uri);
  assert.equal(recalled.entries[0].truncated, true);
  assert.equal(recalled.entries[0].expandUri, `${f.namespace}/design`); assert.doesNotMatch(recalled.entries[0].summary, /\uFFFD/u);
  assert.ok(f.roots.has(f.namespace)); assert.equal(f.calls.filter(call => call.path.endsWith('/fs/mkdir')).length, 1);
  assert.ok(!f.calls.some(call => call.path.includes('/content/') || call.path.includes('/sessions')));
});

test('自动引用按可展开来源去重，配置预算是不可突破的上限', async t => {
  const f = await fixture(t); f.roots.add(f.namespace);
  f.store.configurationService.update({ memory: { contextBudget: 256 } });
  f.results = [
    { uri: `${f.namespace}/design/.abstract.md`, level: 0, abstract: '一'.repeat(500), score: .9 },
    { uri: `${f.namespace}/design/.overview.md`, level: 1, abstract: '二'.repeat(500), score: .8 }
  ];
  const result = await f.store.memoryService.recall(f.project.id, { query: '检索', budgetTokens: 1000 });
  assert.equal(result.budgetTokens, 256); assert.ok(result.estimatedTokens <= 256); assert.equal(result.candidateCount, 1); assert.equal(result.entries.length, 1);
});

test('a passage already attached unchanged gives its budget to the next candidate and leaves a pointer; a changed one is attached again (MIND-13)', async t => {
  const f = await fixture(t); f.roots.add(f.namespace);
  f.results = [
    { uri: `${f.namespace}/a.md`, level: 2, abstract: 'Alpha passage. '.repeat(40), score: .9 },
    { uri: `${f.namespace}/b.md`, level: 2, abstract: 'Beta passage. '.repeat(40), score: .8 },
  ];
  // The budget is a little short of both passages: without the exclusion the second is clipped.
  const row = result => ({ uri: result.uri, expandUri: result.uri, level: 'L2', isLeaf: true, availableReads: ['L2'], summary: result.abstract, truncated: false });
  const budget = estimateMemoryTokens(JSON.stringify(f.results.map(row))) - 10;
  const plain = await f.store.memoryService.recall(f.project.id, { query: 'passage', budgetTokens: budget });
  assert.deepEqual(plain.entries.map(row => [row.uri.split('/').at(-1), row.truncated]), [['a.md', false], ['b.md', true]]);
  assert.deepEqual(plain.candidates.map(row => row.uri.split('/').at(-1)), ['a.md', 'b.md'], 'every candidate comes back whole for a later re-pack');
  const exclude = new Map([[`${f.namespace}/a.md`, new Set([passageHash(f.results[0].abstract)])]]);
  const deduped = await f.store.memoryService.recall(f.project.id, { query: 'passage', budgetTokens: budget, exclude });
  assert.deepEqual(deduped.entries.map(row => [row.uri.split('/').at(-1), row.truncated]), [['b.md', false]], 'the freed budget holds the next passage whole');
  assert.deepEqual(deduped.alreadyAttached, [`${f.namespace}/a.md`]);
  const content = JSON.parse(deduped.content);
  assert.deepEqual(content.alreadyAttached.uris, [`${f.namespace}/a.md`]); assert.match(content.alreadyAttached.note, /unchanged text is in an earlier project-memory attachment/);
  assert.ok(deduped.estimatedTokens <= budget);
  // Same URI, different text: not the passage the conversation holds.
  const changed = await f.store.memoryService.recall(f.project.id, { query: 'passage', budgetTokens: budget, exclude: new Map([[`${f.namespace}/a.md`, new Set([passageHash('older text')])]]) });
  assert.deepEqual(changed.entries.map(row => row.uri.split('/').at(-1)), ['a.md', 'b.md']); assert.equal(changed.alreadyAttached, undefined);
});

test('零预算和关闭自动引用不请求远端，微小剩余预算不被上调', async t => {
  const f = await fixture(t);
  assert.equal((await f.store.memoryService.recall(f.project.id, { query: '检索', budgetTokens: 0 })).status, 'budget-exhausted');
  f.store.configurationService.update({ memory: { autoRecall: false } });
  assert.equal((await f.store.memoryService.recall(f.project.id, { query: '检索' })).status, 'disabled'); assert.equal(f.calls.length, 0);
  f.store.configurationService.update({ memory: { autoRecall: true } }); f.results = [{ uri: `${f.namespace}/guide.md`, level: 2, abstract: '摘录' }];
  const result = await f.store.memoryService.recall(f.project.id, { query: '检索', budgetTokens: 1 });
  assert.equal(result.budgetTokens, 1); assert.equal(result.content, ''); assert.deepEqual(result.entries, []); assert.equal(result.status, 'budget-exhausted');
});

test('真实空库不伪造命中；错误地址404不当成空库或初始化成功', async t => {
  const f = await fixture(t);
  const empty = await f.store.memoryService.recall(f.project.id, { query: '尚无资料' });
  assert.equal(empty.status, 'empty'); assert.equal(empty.candidateCount, 0); assert.equal(empty.content, '');
  f.unavailable = 404; f.calls.length = 0;
  await assert.rejects(f.store.memoryService.recall(f.project.id, { query: '地址错误' }), error => error.upstreamStatus === 404);
  assert.ok(!f.calls.some(call => call.path.endsWith('/fs/mkdir')));
});

test('按需读L1还原sidecar目录，文件误传L0也明确归属于父目录', async t => {
  const f = await fixture(t);
  const overview = await f.store.memoryService.read(f.project.id, { uri: `${f.namespace}/design/.overview.md`, level: 'L1' });
  assert.equal(overview.uri, `${f.namespace}/design`); assert.equal(overview.scope, 'directory'); assert.equal(overview.content, '目录的真实概览');
  assert.equal(f.calls[0].path, '/api/v1/content/overview'); assert.equal(f.calls[0].params.uri, `${f.namespace}/design`);
  const abstract = await f.store.memoryService.read(f.project.id, { uri: `${f.namespace}/guide.md`, level: 'L0' });
  assert.equal(abstract.requestedUri, `${f.namespace}/guide.md`); assert.equal(abstract.uri, f.namespace); assert.equal(abstract.scope, 'directory');
  assert.equal(f.calls[1].path, '/api/v1/fs/stat'); assert.equal(f.calls[2].params.uri, f.namespace);
});

test('按需文件读取受行数、字符预算和命名空间约束，保留范围元数据', async t => {
  const f = await fixture(t); f.content = '内容😀'.repeat(200);
  const read = await f.store.memoryService.read(f.project.id, { uri: `${f.namespace}/guide.md`, level: 'L2', offset: 5, limit: 300, maxChars: 256 });
  assert.equal(f.calls[0].params.offset, '5'); assert.equal(f.calls[0].params.limit, '300'); assert.equal(read.truncated, true); assert.equal(Array.from(read.content).length, 256); assert.equal(read.nextOffset, null);
  assert.equal(read.estimatedTokens, estimateMemoryTokens(read.content));
  for (const input of [{ offset: -1 }, { limit: 501 }, { maxChars: 64001 }, { uri: `${f.namespace}-other/private` }]) await assert.rejects(f.store.memoryService.read(f.project.id, { uri: `${f.namespace}/guide.md`, ...input }));
  for (const uri of ['docs/validation.md', 'scripts/verify-deliverables.py']) await assert.rejects(f.store.memoryService.read(f.project.id, { uri, level: 'L2' }), error => error.status === 403 && error.upstreamStatus === undefined);
  assert.equal(f.calls.length, 1);
});

test('缺失概览保持错误语义，不能用L0候选冒充L1内容', async t => {
  const f = await fixture(t, { missingOverview: true });
  await assert.rejects(f.store.memoryService.read(f.project.id, { uri: `${f.namespace}/design/.overview.md`, level: 'L1' }), error => error.upstreamStatus === 404 && error.status === 404 && error.code === 'MEMORY_LAYER_UNAVAILABLE' && !error.message.includes('服务不可用'));
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, '/api/v1/content/overview');
});

test('上游200空L0/L1按未生成处理，正常摘要与空L2保持原内容语义', async t => {
  const f = await fixture(t);
  for (const [level, field, sidecar] of [['L0', 'abstract', '.abstract.md'], ['L1', 'overview', '.overview.md']]) {
    for (const content of ['', ' \t\r\n\u3000']) {
      f[field] = content; const before = f.calls.length;
      await assert.rejects(f.store.memoryService.read(f.project.id, { uri: `${f.namespace}/design/${sidecar}`, level }), error => error.status === 404 && error.code === 'MEMORY_LAYER_UNAVAILABLE' && error.upstreamStatus === 200);
      assert.equal(f.calls.length, before + 1); assert.equal(f.calls.at(-1).path, `/api/v1/content/${field}`);
    }
    f[field] = '  已生成的真实内容\n';
    assert.equal((await f.store.memoryService.read(f.project.id, { uri: `${f.namespace}/design/${sidecar}`, level })).content, f[field]);
  }
  for (const content of ['', ' \t\n']) {
    f.content = content;
    assert.equal((await f.store.memoryService.read(f.project.id, { uri: `${f.namespace}/guide.md`, level: 'L2' })).content, content);
  }
});

test('上游200官方同URI完整目录占位返回层级不可用，真实正文和所有L2原文保持不变', async t => {
  const f = await fixture(t), uri = `${f.namespace}/design`;
  const placeholders = [`# ${uri} [Directory abstract is not ready]`, `# ${uri}\n\n[Directory overview is not ready]`];
  for (const [level, field, sidecar, placeholder] of [['L0', 'abstract', '.abstract.md', placeholders[0]], ['L1', 'overview', '.overview.md', placeholders[1]]]) {
    for (const content of [placeholder, ` \n${placeholder.replaceAll('\n', '\r\n')}\r\n`]) {
      f[field] = content;
      await assert.rejects(f.store.memoryService.read(f.project.id, { uri: `${uri}/${sidecar}`, level }), error => error.status === 404 && error.code === 'MEMORY_LAYER_UNAVAILABLE' && error.upstreamStatus === 200 && error.message === '目录摘要尚未生成，可浏览目录读取原文。');
    }
    for (const content of [`# ${uri}\n\n真实正文中提及 [Directory abstract is not ready]`, `# ${uri}\n\n正文结束于 [Directory overview is not ready]`, `# ${uri}-other [Directory abstract is not ready]`, placeholder + '\n已有真实说明']) {
      f[field] = content; assert.equal((await f.store.memoryService.read(f.project.id, { uri: `${uri}/${sidecar}`, level })).content, content);
    }
  }
  for (const content of [...placeholders, `# ${f.namespace}/guide.md [Directory abstract is not ready]`]) {
    f.content = content; assert.equal((await f.store.memoryService.read(f.project.id, { uri: `${f.namespace}/guide.md`, level: 'L2' })).content, content);
  }
});

test('检索标明占位与空摘要不可用；自动引用先排除占位再按来源去重，保留同目录真实概览', async t => {
  const f = await fixture(t), ns = f.namespace; f.roots.add(ns);
  const marker = `# ${ns}/design [Directory abstract is not ready]`, ready = '有效目录概览与项目约束';
  f.results = [
    { uri: `${ns}/design/.abstract.md`, level: 0, abstract: marker, score: .99 },
    { uri: `${ns}/design/.overview.md`, level: 1, abstract: ready, score: .9 },
    { uri: `${ns}/unavailable`, level: 1, abstract: `# ${ns}/unavailable\n\n[Directory overview is not ready]`, score: .8 },
    { uri: `${ns}/blank`, level: 0, abstract: ' \r\n', score: .7 },
    { uri: `${ns}/file.md`, level: 2, abstract: '普通摘要提及 [Directory abstract is not ready] 作为诊断说明', score: .6 }
  ];
  const found = await f.store.memoryService.search(f.project.id, { query: '约束' });
  assert.deepEqual(found.entries.map(entry => entry.summaryStatus), ['unavailable', 'ready', 'unavailable', 'unavailable', 'ready']);
  for (const entry of found.entries.filter(row => row.summaryStatus === 'unavailable')) { assert.equal(entry.summary, ''); assert.equal(entry.content, ''); }
  const recalled = await f.store.memoryService.recall(f.project.id, { query: '约束' });
  assert.equal(recalled.status, 'ready'); assert.equal(recalled.candidateCount, 2); assert.equal(recalled.entries[0].uri, `${ns}/design/.overview.md`); assert.equal(recalled.entries[0].summary, ready); assert.equal(recalled.entries.length, 2);
  assert.ok(!recalled.content.includes(marker)); assert.ok(!recalled.entries.some(entry => entry.uri.endsWith('/unavailable') || entry.uri.endsWith('/blank')));
  assert.ok(recalled.content.includes('诊断说明')); assert.ok(!f.calls.some(call => call.path.includes('/content/')));
});

test('仅占位摘要的召回为空，目录仍可浏览且服务健康与记忆层级缺失分开', async t => {
  const f = await fixture(t), uri = `${f.namespace}/design`; f.roots.add(f.namespace);
  f.ready = { status: 'ready', checks: { agfs: 'ok', vectordb: 'ok', embedding: 'ok' } };
  f.results = [{ uri, level: 0, abstract: `# ${uri} [Directory abstract is not ready]`, score: .99 }];
  f.listings = { [f.namespace]: [{ uri, name: 'design', isDir: true }] };
  const before = await f.store.memoryService.health(f.project.id);
  const recalled = await f.store.memoryService.recall(f.project.id, { query: '约束' }); assert.equal(recalled.status, 'empty'); assert.equal(recalled.content, ''); assert.equal(recalled.candidateCount, 0); assert.equal(recalled.estimatedTokens, 0); assert.deepEqual(recalled.entries, []);
  const browsed = await f.store.memoryService.browse(f.project.id); assert.equal(browsed.entries[0].uri, uri); assert.deepEqual(browsed.entries[0].availableReads, ['L0', 'L1']);
  const after = await f.store.memoryService.health(f.project.id); assert.equal(before.ready, true); assert.equal(after.ready, true); assert.equal(after.connected, before.connected); assert.equal(after.authenticated, before.authenticated); assert.deepEqual(after.readiness, before.readiness);
});

test('已经取消的自动引用不会发出检索或建目录请求', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.store.memoryService.recall(f.project.id, { query: '取消', signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(f.calls.length, 0);
});

test('浏览显式资源根时合并本项目抽取记忆，子目录不混用两种根且仍拒绝越界', async t => {
  const f = await fixture(t), peer = `viking://user/rna-test/peers/forge-${f.project.id}/memories`;
  f.store.mutate(state => { state.projects.find(p => p.id === f.project.id).memorySessions = [{ isolation: 'project-peer-v1', endpoint: f.store.state.configuration.memory.endpoint, namespace: f.namespace }]; });
  f.roots.add(f.namespace); f.roots.add(peer); f.roots.add(`${peer}/preferences`);
  f.listings = { [f.namespace]: [{ uri: `${f.namespace}/guide.md`, isDir: false }], [peer]: [{ uri: `${peer}/preferences`, isDir: true }], [`${peer}/preferences`]: [{ uri: `${peer}/preferences/style.md`, isDir: false }] };
  const result = await f.store.memoryService.browse(f.project.id, { uri: f.namespace });
  assert.deepEqual(result.entries.map(e => e.uri), [`${peer}/preferences`, `${f.namespace}/guide.md`]);
  assert.deepEqual(f.calls.filter(c => c.path.endsWith('/fs/ls')).map(c => c.params.uri), [f.namespace, peer]);
  const child = await f.store.memoryService.browse(f.project.id, { uri: `${peer}/preferences` });
  assert.equal(child.entries[0].uri, `${peer}/preferences/style.md`);
  const count = f.calls.length;
  for (const uri of [`${peer}-other/private`, `viking://user/rna-test/peers/forge-other/memories`, `${f.namespace}/../other`]) await assert.rejects(f.store.memoryService.browse(f.project.id, { uri }), e => e.status === 403);
  assert.equal(f.calls.length, count);
});
