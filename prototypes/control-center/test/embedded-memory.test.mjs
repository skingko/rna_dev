import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { embeddedMemoryFile } from '../memory-service.mjs';
import { EmbeddedMemory, EMBEDDED_MEMORY_ENDPOINT, EMBEDDED_USER, memoryTerms, passageFor } from '../embedded-memory.mjs';
import { CHECKPOINT_SIDECARS } from '../state-checkpoint.mjs';

// The embedded memory backend: project memory with no outside service, for a machine without Docker. It answers the
// requests the host sends an OpenViking server, in this process; the host's own MemoryService is what the tests drive.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-embedded-memory-')), file = join(dir, 'state.json'), store = new Store(file);
  t.after(() => { store.memoryService.close(); rmSync(dir, { recursive: true, force: true }); });
  store.configurationService.update({ memory: { backend: 'embedded' } });
  const { project, session } = store.createProject({});
  return { dir, file, store, service: store.memoryService, project, session, namespace: `viking://resources/projects/${project.id}` };
}
const engine = () => new EmbeddedMemory(':memory:');
const ask = (memory, path, method = 'GET', body) => memory.request(`${EMBEDDED_MEMORY_ENDPOINT}${path}`, { method, body, headers: { 'X-OpenViking-Actor-Peer': 'forge-p1' }, captureErrorCode: true });
const status = expected => error => error.upstreamStatus === expected;

test('text is indexed by words, and Chinese by adjacent character pairs, so a two-character word is found', () => {
  assert.deepEqual(memoryTerms('修改卡丁车的BGM曲风 v2'), ['修改', '改卡', '卡丁', '丁车', '车的', 'bgm', '曲风', 'v2']);
  assert.deepEqual(memoryTerms('人 Daily_report-48h café'), ['人', 'daily', 'report', '48h', 'café']);
  assert.deepEqual(memoryTerms('ひらがな 한국어'), ['ひら', 'らが', 'がな', '한국', '국어']); assert.deepEqual(memoryTerms(' ,。! '), []);
  // The passage is the file's own words around the densest stretch of query words, whole lines where they fit.
  const text = `# 调音记录\n\n${'无关的铺垫内容。'.repeat(60)}\n万圣夜墓园用管风琴式持续低音，曲风要诡谲。\n${'后续说明。'.repeat(40)}`;
  const passage = passageFor(text, memoryTerms('墓园 曲风'));
  assert.match(passage, /^万圣夜墓园用管风琴式持续低音，曲风要诡谲。/); assert.ok(Array.from(passage).length <= 360);
  assert.equal(passageFor('短文本', ['没有']), '短文本', 'without a match the start of the text is shown');
});

test('the host works on the embedded backend as it does on a server: setup, write, search, recall, tiered reads', async t => {
  const f = fixture(t), id = f.project.id;
  assert.equal(f.store.get().configuration.memory.backend, 'embedded'); assert.equal(f.store.get().configuration.runtime.memoryExecution, 'embedded');
  // The connection is named, never fetched, and carries no key; the file sits inside the journal root (a new sibling of
  // the state file would be refused by an older release's checkpoint, the 0.43.0 incident).
  const remote = f.service.remote(id); assert.equal(remote.config.endpoint, EMBEDDED_MEMORY_ENDPOINT); assert.equal(remote.headers['X-API-Key'], undefined);
  assert.ok(embeddedMemoryFile(f.file).startsWith(`${f.file}.rna/`)); assert.ok(CHECKPOINT_SIDECARS.includes('.rna'));
  const health = await f.service.health(id);
  assert.equal(health.backend, 'embedded'); assert.equal(health.ready, true);
  assert.deepEqual({ vectorStore: health.readiness.vectorStore, embedding: health.readiness.embedding, vlm: health.readiness.vlm, semanticQuality: health.readiness.semanticQuality }, { vectorStore: 'not_used', embedding: 'not_used', vlm: 'not_used', semanticQuality: 'keyword_only' }, 'no vector store or model is claimed');
  // First use creates the project root; an empty project recalls nothing and says so.
  const empty = await f.service.browse(id, {}); assert.deepEqual(empty.entries, []); assert.equal(empty.backend, 'embedded'); assert.ok(existsSync(embeddedMemoryFile(f.file)));
  assert.equal((await f.service.recall(id, { query: '背景音乐的曲风', budgetTokens: 800 })).status, 'empty');

  await f.service.write(id, null, { uri: `${f.namespace}/notes/音乐约定.md`, title: '音乐约定', content: '每条赛道的背景音乐必须符合场地名称特征。\n万圣夜墓园用管风琴式持续低音，曲风诡谲，不加鼓组。' });
  await f.service.write(id, null, { uri: `${f.namespace}/notes/发布流程.md`, content: 'Release checklist: run the full test suite, build the web bundle, package, boot test on a scratch port.' });
  const found = await f.service.search(id, { query: '墓园那条赛道的曲风是什么' });
  assert.deepEqual(found.entries.map(row => row.uri), [`${f.namespace}/notes/音乐约定.md`]); assert.equal(found.backend, 'embedded');
  assert.match(found.entries[0].summary, /万圣夜墓园用管风琴式持续低音/); assert.equal(found.entries[0].summaryStatus, 'ready'); assert.deepEqual(found.entries[0].availableReads, ['L2']);
  assert.deepEqual((await f.service.search(id, { query: 'boot test before release' })).entries.map(row => row.uri.split('/').at(-1)), ['发布流程.md']);
  assert.deepEqual((await f.service.search(id, { query: '数据库迁移脚本回滚' })).entries, [], 'words the store does not hold find nothing');
  // Recall packs the passages into the budget, as it does for a server.
  const recall = await f.service.recall(id, { query: '万圣夜墓园的背景音乐', budgetTokens: 800 });
  assert.equal(recall.status, 'ready'); assert.equal(recall.entries.length, 1); assert.match(recall.content, /管风琴/); assert.ok(recall.estimatedTokens <= 800);
  // L2 is the file, paged by line; L0 and L1 of its folder are a listing in the entries' own words.
  const file = await f.service.read(id, { uri: `${f.namespace}/notes/音乐约定.md`, offset: 2, limit: 1 });
  assert.equal(file.content, '每条赛道的背景音乐必须符合场地名称特征。'); assert.equal(file.level, 'L2');
  const overview = await f.service.read(id, { uri: `${f.namespace}/notes`, level: 'L1' }), abstract = await f.service.read(id, { uri: `${f.namespace}/notes/音乐约定.md`, level: 'L0' });
  assert.match(overview.content, /^# notes\n\n2 files, newest first\.\n\n- /); assert.match(overview.content, /音乐约定\.md: 每条赛道的背景音乐必须符合场地名称特征。/); assert.match(overview.content, /发布流程\.md: Release checklist/);
  assert.equal(abstract.uri, `${f.namespace}/notes`, 'a file\'s L0 is its folder\'s'); assert.match(abstract.content, /^notes: 2 files\. /);
  const listed = await f.service.browse(id, { uri: `${f.namespace}/notes`, view: 'directory' });
  assert.deepEqual(listed.entries.map(row => [row.title, row.isLeaf]).sort(), [['发布流程.md', true], ['音乐约定.md', true]]);
  await assert.rejects(f.service.read(id, { uri: 'viking://resources/projects/another/notes/x.md' }), /只能读取当前项目/);
});

test('a committed conversation segment becomes a searchable event, and goes when its upload session is deleted', async t => {
  const f = fixture(t), id = f.project.id;
  f.store.message(f.session.id, { text: '把万圣夜墓园那条赛道的背景音乐改得更诡异一点' });
  const turn = f.store.state.sessions.find(row => row.id === f.session.id).turns[0];
  const bound = await f.service.createSession(id, { sourceSessionId: f.session.id, turnId: turn.id });
  assert.equal(bound.backend, 'embedded'); assert.equal(bound.endpoint, EMBEDDED_MEMORY_ENDPOINT); assert.equal(bound.userId, EMBEDDED_USER);
  assert.equal(bound.memoryNamespace, `viking://user/${EMBEDDED_USER}/peers/forge-${id}/memories`);
  await f.service.sessionMessages(id, bound.sessionId, { messages: [{ role: 'user', content: '把万圣夜墓园那条赛道的背景音乐改得更诡异一点' }, { role: 'assistant', content: '已改为多利亚调式，加入管风琴式持续低音，去掉鼓组；验证脚本通过。' }] });
  const commit = await f.service.sessionCommit(id, bound.sessionId, {});
  assert.equal(commit.result.archived, true); assert.equal(commit.archiveUri, `viking://user/${EMBEDDED_USER}/sessions/${bound.sessionId}/history/archive_001`);
  // The commit is finished by the time it answers: its task is completed, its archive carries the marker and the diff.
  const task = await f.service.sessionTask(id, bound.sessionId, commit.result.task_id);
  assert.equal(task.result.status, 'completed'); assert.deepEqual(task.result.result.memories_extracted, { events: 1 }); assert.equal(task.memoryDiffUri, `${commit.archiveUri}/memory_diff.json`);
  assert.deepEqual(await f.service.archiveState(id, bound.sessionId, commit.archiveUri).then(row => [row.state, row.marker, row.memoryChanges]), ['completed', '.done', 1]);
  // The event is the segment's own words, found through the project's memory scope and tagged with its turn.
  const found = await f.service.search(id, { query: '墓园的背景音乐后来怎么改的' });
  assert.equal(found.entries.length, 1); assert.equal(found.entries[0].kind, 'memory'); assert.ok(found.entries[0].uri.startsWith(`${bound.memoryNamespace}/events/`));
  assert.match(found.entries[0].displayTitle, /把万圣夜墓园那条赛道的背景音乐改得更诡异一点/);
  const event = await f.service.read(id, { uri: found.entries[0].uri });
  assert.equal(event.content, '# 把万圣夜墓园那条赛道的背景音乐改得更诡异一点\n\nUser:\n把万圣夜墓园那条赛道的背景音乐改得更诡异一点\n\nAssistant:\n已改为多利亚调式，加入管风琴式持续低音，去掉鼓组；验证脚本通过。');
  const tagged = await f.service.embeddedMemory.request(`${EMBEDDED_MEMORY_ENDPOINT}/api/v1/fs/ls?${new URLSearchParams({ uri: `${bound.memoryNamespace}/events`, recursive: 'true', tags: `rna_turn=${turn.id.toLowerCase()}`, include_tags: 'true' })}`, {});
  assert.deepEqual(tagged.result.map(row => row.uri), [found.entries[0].uri]); assert.ok(tagged.result[0].tags.includes(`project=${id}`));
  // A second commit with nothing new archives nothing.
  assert.deepEqual((await f.service.sessionCommit(id, bound.sessionId, {})).result, { status: 'skipped', archived: false, reason: 'no_messages' });
  // Deleting the upload session (a deleted conversation, a rewind) takes its archive and its event along: the
  // conversation's own words do not stay searchable.
  const record = { projectId: id, sessionId: f.session.id, connectionFingerprint: f.service.connectionFingerprint(id), bindings: [f.store.state.projects.find(row => row.id === id).memorySessions.find(row => row.sessionId === bound.sessionId)] };
  const removed = await f.service.deleteSessionArchive(record, record.bindings[0]);
  assert.equal(removed.deleted, true);
  assert.deepEqual((await f.service.search(id, { query: '墓园的背景音乐后来怎么改的' })).entries, []);
  await assert.rejects(f.service.read(id, { uri: found.entries[0].uri }), error => error.upstreamStatus === 404);
});

test('the store answers like the server it stands in for: conflicts, missing files, scopes, and a reopened file', async t => {
  const memory = engine(), ns = 'viking://resources/projects/p1', other = 'viking://resources/projects/p2';
  await assert.rejects(ask(memory, `/api/v1/fs/ls?uri=${encodeURIComponent(ns)}`), status(404));
  await ask(memory, '/api/v1/fs/mkdir', 'POST', { uri: ns, description: 'project' });
  await assert.rejects(ask(memory, '/api/v1/fs/mkdir', 'POST', { uri: ns }), error => error.upstreamStatus === 409 && error.status === 502);
  assert.deepEqual((await ask(memory, `/api/v1/fs/ls?uri=${encodeURIComponent(ns)}`)).result, []);
  const write = (uri, content, mode = 'create') => ask(memory, '/api/v1/content/write', 'POST', { uri, content, mode });
  const receipt = (await write(`${ns}/a.md`, '发布前先跑完整测试')).result;
  assert.deepEqual([receipt.uri, receipt.mode, receipt.written_bytes, receipt.content_updated, receipt.semantic_status, receipt.vector_status], [`${ns}/a.md`, 'create', Buffer.byteLength('发布前先跑完整测试'), true, 'complete', 'complete']);
  await assert.rejects(write(`${ns}/a.md`, 'again'), error => error.upstreamStatus === 409 && error.upstreamCode === 'ALREADY_EXISTS');
  await assert.rejects(write(`${ns}/missing.md`, 'x', 'replace'), error => error.upstreamStatus === 404 && error.upstreamCode === 'NOT_FOUND');
  await assert.rejects(write(`${ns}/../p2/x.md`, 'x'), status(400)); await assert.rejects(write('file:///etc/passwd', 'x'), status(400));
  await write(`${ns}/a.md`, '，打包后做启动测试', 'append'); await write(`${other}/b.md`, '另一个项目也要跑完整测试');
  assert.equal((await ask(memory, `/api/v1/content/read?${new URLSearchParams({ uri: `${ns}/a.md`, offset: '0', limit: '-1', raw: 'true' })}`)).result, '发布前先跑完整测试，打包后做启动测试');
  // A search stays inside the scope it was given, even when another project holds the same words.
  const find = scope => ask(memory, '/api/v1/search/find', 'POST', { query: '完整测试', target_uri: scope, limit: 10 }).then(row => [...row.result.memories, ...row.result.resources].map(hit => hit.uri));
  assert.deepEqual(await find(ns), [`${ns}/a.md`]); assert.deepEqual(await find(other), [`${other}/b.md`]); assert.deepEqual(await find('viking://resources/projects/p'), []);
  // A level filter of 0 or 1 asks for directory records, which only an embedding index has.
  assert.equal((await ask(memory, '/api/v1/search/find', 'POST', { query: '完整测试', target_uri: ns, limit: 10, level: '1' })).result.total, 0);
  const gone = (await ask(memory, `/api/v1/fs?${new URLSearchParams({ uri: `${ns}/a.md` })}`, 'DELETE')).result;
  assert.deepEqual(gone, { uri: `${ns}/a.md`, semantic_root_uri: ns, semantic_status: 'complete' }); assert.deepEqual(await find(ns), []);
  await assert.rejects(ask(memory, `/api/v1/fs?${new URLSearchParams({ uri: `${ns}/a.md` })}`, 'DELETE'), status(404));
  await assert.rejects(ask(memory, '/api/v1/unknown'), status(404));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(memory.request(`${EMBEDDED_MEMORY_ENDPOINT}/health`, { signal: controller.signal }), { name: 'AbortError' });
  memory.close();

  // What was stored is there after the process starts again, index included.
  const dir = mkdtempSync(join(tmpdir(), 'rna-embedded-file-')), file = join(dir, 'memory', 'embedded.sqlite'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new EmbeddedMemory(file); await ask(first, '/api/v1/content/write', 'POST', { uri: `${ns}/kept.md`, content: '重启之后仍然能搜到', mode: 'create' }); first.close();
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the file holds conversations: its owner alone reads it');
  const second = new EmbeddedMemory(file); t.after(() => second.close());
  assert.deepEqual((await ask(second, '/api/v1/search/find', 'POST', { query: '重启之后', target_uri: ns, limit: 5 })).result.resources.map(row => row.uri), [`${ns}/kept.md`]);
});

test('switching backends is a different connection: what one wrote is not looked for in the other', async t => {
  const f = fixture(t), id = f.project.id, embedded = f.service.connectionFingerprint(id);
  await f.service.write(id, null, { uri: `${f.namespace}/note.md`, content: '只在本地记忆里' });
  f.store.configurationService.update({ memory: { backend: 'openviking', endpoint: 'http://127.0.0.1:1' } });
  assert.notEqual(f.service.connectionFingerprint(id), embedded); assert.equal(f.service.backend, 'openviking');
  await assert.rejects(f.service.search(id, { query: '本地记忆' }), error => error.status === 503 && /OpenViking 不可用/.test(error.message));
  // The OpenViking address is kept while the embedded engine is in use, so switching back needs no retyping.
  f.store.configurationService.update({ memory: { backend: 'embedded' } });
  assert.equal(f.store.get().configuration.memory.endpoint, 'http://127.0.0.1:1'); assert.equal(f.service.connectionFingerprint(id), embedded);
  assert.equal((await f.service.search(id, { query: '本地记忆' })).entries.length, 1);
  // A restart keeps the choice (older states' "local" still loads as OpenViking: configuration.test.mjs).
  f.service.close(); const reopened = new Store(f.file); t.after(() => reopened.memoryService.close());
  assert.equal(reopened.state.configuration.memory.backend, 'embedded'); assert.equal((await reopened.memoryService.search(id, { query: '本地记忆' })).entries.length, 1);
});

test('a finished turn is stored through the same queue: created, uploaded, committed and settled in one pass, then recalled', async t => {
  const { MemorySync, memorySyncHealth } = await import('../memory-sync.mjs');
  const f = fixture(t), id = f.project.id; let clock = 1000;
  const sync = new MemorySync(f.store, { now: () => clock, pollMs: 1000 }); t.after(() => sync.close());
  const finish = (question, answer) => {
    f.store.message(f.session.id, { text: question });
    const turnId = f.store.state.sessions.find(row => row.id === f.session.id).activeTurnId;
    f.store.mutate(state => { const session = state.sessions.find(row => row.id === f.session.id), turn = session.turns.find(row => row.id === turnId); turn.modelConfig = { execution: 'rna' }; session.items.push({ id: `answer-${turnId}`, turnId, kind: 'assistant', text: answer }); });
    f.store.finishRuntimeTurn(f.session.id, turnId); return turnId;
  };
  const write = () => f.store.state.sessions.find(row => row.id === f.session.id).turns.at(-1).memoryWrite;
  finish('把万圣夜墓园那条赛道的背景音乐改得更诡异一点', '已改为多利亚调式，加入管风琴式持续低音，去掉鼓组。');
  assert.equal(write().status, 'pending');
  for (let pass = 0; pass < 6 && !['completed', 'failed', 'uncertain', 'abandoned'].includes(write().status); pass++) { await Promise.all(sync.pump()); clock += 20000; }
  assert.equal(write().status, 'completed', JSON.stringify(write()));
  assert.equal(memorySyncHealth(f.store.state).healthy, true);
  const recall = await f.service.recall(id, { query: '墓园的背景音乐现在是什么风格', budgetTokens: 800 });
  assert.equal(recall.status, 'ready'); assert.match(recall.content, /管风琴式持续低音/);
});
