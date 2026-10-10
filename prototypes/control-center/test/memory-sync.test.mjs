import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../store.mjs';
import { MemorySync, memorySyncHealth } from '../memory-sync.mjs';

async function fixture(t, { fragmentUtf8 = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-memory-sync-'));
  const f = { calls: [], remoteSessions: new Map(), transportProof: [], taskStatus: 'running', clock: 1000, user: 'alice' };
  const server = createServer(async (req, res) => {
    const chunks = []; let fragmented = false;
    for await (const chunk of req) {
      const marker = fragmentUtf8 && !fragmented ? chunk.indexOf(Buffer.from('🧬')) : -1;
      if (marker >= 0) { chunks.push(chunk.subarray(0, marker + 1), chunk.subarray(marker + 1)); fragmented = true; }
      else chunks.push(chunk);
    }
    const complete = Buffer.concat(chunks).toString('utf8'), naive = chunks.map(chunk => chunk.toString('utf8')).join('');
    // HTTP Buffer boundaries may split one UTF-8 character. Decode only after
    // joining bytes; naive per-chunk decoding is retained solely as evidence
    // that the forced-boundary regression would catch the old fixture bug.
    const raw = complete;
    if (req.url.endsWith('/messages/batch')) f.transportProof.push({ fragmented, bytes: Buffer.concat(chunks).length,
      naiveUtf16: naive.length, completeUtf16: complete.length, changed: naive !== complete,
      naiveHash: createHash('sha256').update(naive).digest('hex'), completeHash: createHash('sha256').update(complete).digest('hex') });
    const url = new URL(req.url, 'http://fixture'), body = raw ? JSON.parse(raw) : null;
    f.calls.push({ path: url.pathname, params: Object.fromEntries(url.searchParams), body });
    const send = (result, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: status === 200 ? 'ok' : 'error', result })); };
    if (f.outage) return send({}, 503);
    if (url.pathname === '/api/v1/system/status') return send({ initialized: true, user: f.user });
    if (url.pathname === '/api/v1/sessions') { f.remoteSessions.set(body.session_id, { body, messages: [] }); return send({ session_id: body.session_id }); }
    const id = url.pathname.split('/')[4], session = f.remoteSessions.get(id);
    if (url.pathname.endsWith('/messages/batch')) { session.messages.push(...body.messages); if (f.dropAppend) return req.socket.destroy(); return send({ added: body.messages.length, message_count: session.messages.length }); }
    if (url.pathname.endsWith('/commit')) { if (f.dropCommit) return req.socket.destroy(); return send({ status: 'accepted', archived: true, task_id: `task-${id}` }); }
    if (url.pathname.includes('/tasks/') && f.taskGone !== undefined) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify(f.taskGone ? { status: 'error', error: { code: f.taskGone, message: 'Task not found or expired' } } : {})); }
    if (url.pathname.includes('/tasks/')) return send({ status: f.taskStatus, result: { memories_extracted: { preferences: 1 }, token_usage: { total: { total_tokens: 321 } } } });
    if (url.pathname.endsWith('/search/find')) return send({ memories: [...f.remoteSessions.values()].map((s, index) => ({ uri: `viking://user/${f.user}/peers/${s.messages.find(m => m.role === 'user')?.peer_id}/memories/preferences/p${index}.md`, level: 2, abstract: '持久设计约束', score: .99 })), resources: [{ uri: `${body.target_uri}/.overview.md`, level: 1, abstract: '范围概览', score: .5 }] });
    if (url.pathname.endsWith('/fs/ls')) return send([]);
    if (url.pathname.endsWith('/fs/stat')) return send({ isDir: true });
    if (url.pathname.endsWith('/content/read')) return send('必须提供文字和形状辅助颜色辨识。');
    if (url.pathname.endsWith('/content/overview')) return send('长期设计约束目录');
    return send({}, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.file = join(directory, 'state.json'); f.store = new Store(f.file);
  f.store.configurationService.update({ memory: { endpoint: `http://127.0.0.1:${server.address().port}` } });
  f.a = f.store.createProject({ name: 'A' }); f.b = f.store.createProject({ name: 'B' });
  f.sync = new MemorySync(f.store, { now: () => f.clock, pollMs: 1000 });
  f.write = () => f.store.state.sessions.find(s => s.id === f.a.session.id).turns.at(-1).memoryWrite;
  f.finish = (content = '设计约束：颜色之外必须有文字和形状。', beforeFinish) => {
    f.store.message(f.a.session.id, { text: content });
    const turnId = f.store.state.sessions.find(s => s.id === f.a.session.id).activeTurnId;
    f.store.mutate(state => { const s = state.sessions.find(s => s.id === f.a.session.id), turn = s.turns.find(t => t.id === turnId); turn.modelConfig = { execution: 'rna' }; s.items.push({ id: 'answer-' + turnId, turnId, kind: 'assistant', text: '已理解，设计时遵循该约束。' }); });
    beforeFinish?.(turnId); f.store.finishRuntimeTurn(f.a.session.id, turnId); return turnId;
  };
  t.after(async () => { await f.sync.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  return f;
}

test('成功真实回合同事务进入持久outbox；peer-only上传、提交和无用户输入的独立任务确认', async t => {
  const f = await fixture(t); f.finish(); assert.equal(f.write().status, 'pending');
  await Promise.all(f.sync.pump()); assert.equal(f.write().status, 'polling'); assert.equal(f.write().archived, true);
  const [remote] = f.remoteSessions.values();
  // A turn without checkpoints has one commit: no working memory to pay for (only a later commit would read it).
  assert.deepEqual(remote.body.memory_policy, { self: { enabled: false }, peer: { enabled: true }, working_memory: { enabled: false } });
  assert.equal(remote.messages.length, 2); assert.equal(remote.messages[0].peer_id, `forge-${f.a.project.id}`); assert.equal(remote.messages[1].peer_id, undefined);
  assert.ok(remote.messages[0].source_message_ids[0]); assert.equal(f.write().nextMessage, 2);
  const writes = f.store.persistence.writes, calls = f.calls.length;
  for (let i = 0; i < 1000; i++) await Promise.all(f.sync.pump());
  assert.equal(f.store.persistence.writes, writes); assert.equal(f.calls.length, calls);
  f.taskStatus = 'completed'; f.clock += 1001; await Promise.all(f.sync.pump());
  assert.equal(f.write().status, 'completed'); assert.equal(f.write().memoriesExtracted, 1); assert.equal(f.write().tokenUsage.total.total_tokens, 321);
  assert.equal(f.calls.filter(call => call.path.endsWith('/commit')).length, 1);
});

test('restored history never uploads, polls or deletes again; explicitly re-enabled memory accepts a fresh conversation', async t => {
  const f = await fixture(t); const oldTurn = f.finish();
  f.store.mutate(state => {
    state.applicationRecovery = { barriers: { memory: true } }; state.configuration.memory.autoStore = false;
    const session = state.sessions.find(row => row.id === f.a.session.id); session.appRecovery = { required: true };
    session.turns[0].memoryWrite.status = 'polling';
    session.memoryEvidenceOutbox = [{ id: 'restored-index', status: 'completed', resourceIndex: { status: 'pending', uri: 'do-not-access' } }];
  });
  const calls = f.calls.length;
  await Promise.all(f.sync.pump()); await f.sync.advance(f.a.session.id, oldTurn); await f.sync.indexEvidence(f.a.session.id, 'restored-index');
  assert.equal(f.calls.length, calls);
  const previous = f.a; f.a = { ...previous, session: f.store.createSession({ projectId: previous.project.id }) };
  f.finish('A new conversation after recovery.');
  await Promise.all(f.sync.pump()); assert.equal(f.calls.length, calls);
  assert.equal(f.write(), undefined, 'Conversation while autoStore was disabled stays unsubmitted');
  f.store.configurationService.update({ memory: { autoStore: true } });
  f.finish('A newly authorized conversation memory.');
  await Promise.all(f.sync.pump());
  assert.equal(f.write().status, 'polling'); assert.equal(f.remoteSessions.size, 1);
  const restored = f.store.state.sessions.find(row => row.id === previous.session.id);
  assert.equal(restored.turns[0].memoryWrite.status, 'polling'); assert.equal(restored.memoryEvidenceOutbox[0].resourceIndex.status, 'pending');
  assert.equal(f.calls.filter(row => row.path.endsWith('/commit')).length, 1);
});

test('真实peer范围双检索，跨项目/共享self记忆过滤；L1/L2仅展开当前项目来源', async t => {
  const f = await fixture(t); f.finish(); await Promise.all(f.sync.pump());
  const memory = `viking://user/alice/peers/forge-${f.a.project.id}/memories`;
  const found = await f.store.memoryService.search(f.a.project.id, { query: '设计约束' });
  assert.ok(found.entries.some(entry => entry.uri.startsWith(memory)));
  assert.deepEqual(found.scopes, [`viking://resources/projects/${f.a.project.id}`, memory]);
  const other = await f.store.memoryService.search(f.b.project.id, { query: '设计约束' });
  assert.ok(other.entries.every(entry => !entry.uri.startsWith(memory)));
  const recalled = await f.store.memoryService.recall(f.a.project.id, { query: '颜色', budgetTokens: 2048 });
  assert.match(recalled.content, /持久设计约束/);
  assert.equal((await f.store.memoryService.read(f.a.project.id, { uri: `${memory}/preferences/p0.md`, level: 'L2' })).content, '必须提供文字和形状辅助颜色辨识。');
  assert.equal((await f.store.memoryService.read(f.a.project.id, { uri: `${memory}/preferences/.overview.md`, level: 'L1' })).content, '长期设计约束目录');
  await assert.rejects(f.store.memoryService.read(f.b.project.id, { uri: `${memory}/preferences/p0.md` }), error => error.status === 403);
  await assert.rejects(f.store.memoryService.read(f.a.project.id, { uri: 'viking://user/alice/memories/preferences/shared.md' }), error => error.status === 403);
  await assert.rejects(f.store.memoryService.sessionCommit(f.b.project.id, f.write().sessionId), error => error.status === 404);
});

test('caller peer id不能重定向抽取；旧self binding、namespace或认证身份改变均拒绝写入', async t => {
  const f = await fixture(t), service = f.store.memoryService;
  const binding = await service.createSession(f.a.project.id);
  await service.sessionMessages(f.a.project.id, binding.sessionId, { messages: [{ role: 'user', content: '记住', peer_id: `forge-${f.b.project.id}` }] });
  assert.equal(f.remoteSessions.get(binding.sessionId).messages[0].peer_id, `forge-${f.a.project.id}`);
  f.store.mutate(state => { state.projects.find(p => p.id === f.a.project.id).memory = { namespace: binding.namespace + '/changed' }; });
  await assert.rejects(service.sessionCommit(f.a.project.id, binding.sessionId), error => error.status === 409);
  f.store.mutate(state => { state.projects.find(p => p.id === f.a.project.id).memory.namespace = binding.namespace; });
  f.user = 'bob'; service.identities.clear();
  await assert.rejects(service.sessionMessages(f.a.project.id, binding.sessionId, { messages: [{ role: 'user', content: '不能串租户' }] }), error => error.status === 409);
  f.store.mutate(state => { delete state.projects.find(p => p.id === f.a.project.id).memorySessions[0].isolation; });
  await assert.rejects(service.sessionCommit(f.a.project.id, binding.sessionId), error => error.status === 409);
});

for (const stage of ['Append', 'Commit']) test(`未知${stage}回执保留sessionId/cursor，重启和1000次pump均不盲重放`, async t => {
  const f = await fixture(t); f[`drop${stage}`] = true; f.finish(); await Promise.all(f.sync.pump());
  assert.equal(f.write().status, 'uncertain'); assert.ok(f.write().sessionId);
  const writes = () => f.calls.filter(call => call.body).length, count = writes(), cursor = f.write().nextMessage;
  const restarted = new Store(f.file), sync = new MemorySync(restarted); t.after(() => sync.close());
  for (let i = 0; i < 1000; i++) await Promise.all(sync.pump());
  // Only read-only lookups follow (B3): nothing is uploaded or committed again, and the record no longer waits forever.
  assert.equal(writes(), count); assert.equal(f.write().nextMessage, cursor);
  const write = restarted.state.sessions.find(s => s.id === f.a.session.id).turns.at(-1).memoryWrite;
  assert.equal(memorySyncHealth(restarted.state).unresolved, 0, JSON.stringify(write.reconcile));
});

test('恢复发出但未记回执的阶段只标uncertain；已确认批次游标从下一批继续', async t => {
  const f = await fixture(t); f.finish();
  f.store.mutate(state => { state.sessions.find(s => s.id === f.a.session.id).turns.at(-1).memoryWrite.status = 'uploading'; });
  await Promise.all(f.sync.pump()); assert.equal(f.write().status, 'uncertain'); assert.equal(f.calls.length, 0);
});

test('初始连接失败可退避重试且无写入；关闭autoStore停止新上传，已知task仍可查询', async t => {
  const f = await fixture(t); f.finish(); f.outage = true; await Promise.all(f.sync.pump());
  assert.equal(f.write().status, 'pending'); assert.equal(f.write().code, 'MEMORY_CONNECTION_UNAVAILABLE'); assert.equal(memorySyncHealth(f.store.state).healthy, false);
  assert.equal(f.calls.filter(call => call.body).length, 0); f.outage = false;
  f.clock += 3000; await Promise.all(f.sync.pump()); assert.equal(f.write().status, 'polling'); assert.equal(f.write().pollFailures, 0); assert.equal(f.write().code, null); assert.equal(memorySyncHealth(f.store.state).healthy, true);
  f.store.configurationService.update({ memory: { autoStore: false } }); f.taskStatus = 'completed'; f.clock += 1001;
  await Promise.all(f.sync.pump()); assert.equal(f.write().status, 'completed');
  f.finish('关闭后不上传'); assert.equal(f.write(), undefined);
});

test('抽取失败不冒称保存成功也不自动重新付费；poll网络失败仅退避读任务', async t => {
  const f = await fixture(t); f.finish(); await Promise.all(f.sync.pump());
  f.clock += 1001; f.outage = true; await Promise.all(f.sync.pump()); assert.equal(f.write().status, 'polling');
  const commits = f.calls.filter(call => call.path.endsWith('/commit')).length;
  f.outage = false; f.taskStatus = 'failed'; f.clock += 3000; await Promise.all(f.sync.pump());
  assert.equal(f.write().status, 'failed'); assert.equal(f.write().code, 'MEMORY_EXTRACTION_FAILED');
  await Promise.all(f.sync.pump()); assert.equal(f.calls.filter(call => call.path.endsWith('/commit')).length, commits);
});

for (const fragmentUtf8 of [false, true]) test(`长对话分批保留全部Unicode文本且每个已确认批次游标持久，重启poll不再次上传${fragmentUtf8 ? '（强制UTF-8字节分块）' : ''}`, async t => {
  const f = await fixture(t, { fragmentUtf8 }), long = '真实🧬证据'.repeat(10000);
  f.finish(undefined, turnId => f.store.mutate(state => { state.sessions.find(s => s.id === f.a.session.id).items.find(item => item.turnId === turnId && item.kind === 'user').text = long; }));
  await Promise.all(f.sync.pump());
  const [remote] = f.remoteSessions.values(), actual = remote.messages.filter(m => m.role === 'user').map(m => m.content).join('');
  assert.equal(actual.length, long.length, JSON.stringify(f.transportProof));
  assert.ok(actual === long, `Unicode text changed: ${JSON.stringify(f.transportProof)}`);
  if (fragmentUtf8) assert.ok(f.transportProof.some(row => row.fragmented && row.changed && row.naiveUtf16 > row.completeUtf16), 'fixture exercises an actual multibyte boundary, not merely multiple complete strings');
  assert.ok(f.calls.filter(call => call.path.endsWith('/messages/batch')).length > 1);
  await f.sync.close(); const restarted = new Store(f.file), sync = new MemorySync(restarted, { now: () => 99999 }); t.after(() => sync.close());
  const calls = f.calls.length; f.taskStatus = 'completed'; await Promise.all(sync.pump());
  assert.equal(f.calls.length, calls + 2); // fresh authenticated identity + task read
  assert.equal(restarted.state.sessions.find(s => s.id === f.a.session.id).turns.at(-1).memoryWrite.status, 'completed');
});

test('同地址切换凭据使旧outbox停止，不能把已排队对话上传到新租户', async t => {
  const f = await fixture(t); f.finish();
  f.store.configurationService.update({ memory: { apiKey: 'new-tenant-credential' } });
  await Promise.all(f.sync.pump());
  assert.equal(f.write().status, 'failed'); assert.equal(f.write().code, 'MEMORY_CONNECTION_CHANGED'); assert.equal(f.calls.length, 0);
});

for (const change of ['archive', 'delete', 'disable', 'close']) test(`已确认上传后${change}在下一网络写前生效且不误报结果未知`, async t => {
  const f = await fixture(t); f.finish();
  const original = f.store.memoryService.sessionMessages.bind(f.store.memoryService);
  f.store.memoryService.sessionMessages = async (...args) => {
    const receipt = await original(...args);
    if (change === 'archive') f.store.mutate(state => { state.projects.find(p => p.id === f.a.project.id).archivedAt = new Date().toISOString(); });
    if (change === 'delete') f.store.mutate(state => { state.projects = state.projects.filter(p => p.id !== f.a.project.id); state.sessions = state.sessions.filter(s => s.id !== f.a.session.id); });
    if (change === 'disable') f.store.configurationService.update({ memory: { autoStore: false } });
    if (change === 'close') f.sync.abort.abort();
    return receipt;
  };
  await Promise.all(f.sync.pump());
  assert.equal(f.calls.filter(call => call.path.endsWith('/commit')).length, 0);
  if (change !== 'delete') { assert.equal(f.write().status, 'ready'); assert.equal(f.write().nextMessage, 2); }
});

test('持久化ready游标可恢复下一步；先前已确认消息没有重复追加', async t => {
  const f = await fixture(t); f.finish();
  const original = f.store.memoryService.sessionMessages.bind(f.store.memoryService);
  f.store.memoryService.sessionMessages = async (...args) => { const result = await original(...args); f.store.configurationService.update({ memory: { autoStore: false } }); return result; };
  await Promise.all(f.sync.pump()); assert.equal(f.write().status, 'ready'); await f.sync.close();
  const restarted = new Store(f.file); restarted.configurationService.update({ memory: { autoStore: true } }); const sync = new MemorySync(restarted); t.after(() => sync.close());
  await Promise.all(sync.pump());
  assert.equal(f.calls.filter(call => call.path.endsWith('/messages/batch')).length, 1);
  assert.equal(f.calls.filter(call => call.path.endsWith('/commit')).length, 1);
  assert.equal(restarted.state.sessions.find(s => s.id === f.a.session.id).turns.at(-1).memoryWrite.status, 'polling');
});


test('a task the service no longer has (NOT_FOUND) settles as task_expired; a bare 404 is only retried (MEM-4)', async t => {
  const f = await fixture(t); f.finish(); await Promise.all(f.sync.pump()); assert.equal(f.write().status, 'polling');
  // A 404 without the service's own code (a proxy, a wrong route) proves nothing about the task.
  f.taskGone = ''; f.clock += 1001; await Promise.all(f.sync.pump());
  assert.equal(f.write().status, 'polling'); assert.equal(f.write().code, 'MEMORY_TASK_LOOKUP_FAILED'); assert.equal(memorySyncHealth(f.store.state).unresolved, 1);
  f.taskGone = 'NOT_FOUND'; f.clock += 60000; await Promise.all(f.sync.pump());
  assert.deepEqual([f.write().status, f.write().code, f.write().taskStatus, f.write().nextPollAt], ['failed', 'MEMORY_TASK_EXPIRED', 'task_expired', null]);
  const health = memorySyncHealth(f.store.state); assert.equal(health.healthy, true); assert.equal(health.settledLoss, 1); assert.equal(health.settledLosses[0].code, 'MEMORY_TASK_EXPIRED');
  const calls = f.calls.length; f.clock += 600000; for (let i = 0; i < 5; i++) await Promise.all(f.sync.pump());
  assert.equal(f.calls.length, calls, 'never polled again');
});

test('a binding whose remote session was deleted with its conversation is dropped from the project; its deletion record keeps a copy (MEM-11)', async t => {
  const f = await fixture(t); f.finish(); await Promise.all(f.sync.pump());
  const live = f.write().sessionId;
  f.store.mutate(state => {
    const project = state.projects.find(row => row.id === f.a.project.id);
    project.memorySessions.push({ ...structuredClone(project.memorySessions[0]), sessionId: 'rna-deleted', status: 'deleted', deletedAt: new Date().toISOString(), sourceSessionId: null, taskIds: ['old'] });
    // A 'deleted' binding a live record still names is kept (its record would lose the binding it settles against).
    project.memorySessions.push({ ...structuredClone(project.memorySessions[0]), sessionId: live, status: 'deleted' });
    state.sessionDeletions = [{ sessionId: 'gone', projectId: project.id, status: 'completed', bindings: [{ sessionId: 'rna-deleted', deletionStatus: 'completed' }] }];
  });
  await Promise.all(f.sync.pump());
  const bindings = f.store.state.projects.find(row => row.id === f.a.project.id).memorySessions;
  assert.equal(bindings.some(row => row.sessionId === 'rna-deleted'), false);
  assert.equal(bindings.filter(row => row.sessionId === live).length, 2);
  assert.deepEqual(f.store.state.sessionDeletions[0].bindings.map(row => row.sessionId), ['rna-deleted']);
  const writes = f.store.persistence.writes; await Promise.all(f.sync.pump()); assert.equal(f.store.persistence.writes, writes, 'nothing more to drop');
});

test('the last binding that proves a project\'s peer-memory scope stays after its conversation was deleted, so recall still searches the memories it left (MEM-11)', async t => {
  const f = await fixture(t); f.finish(); await Promise.all(f.sync.pump());
  const template = structuredClone(f.store.state.projects.find(row => row.id === f.a.project.id).memorySessions[0]);
  // Project B's conversations were all deleted: only 'deleted' bindings are left, on the current scope of B.
  const scopeOfB = { endpoint: f.store.memoryService.remote(f.b.project.id).config.endpoint, namespace: f.store.memoryService.remote(f.b.project.id).namespace, actorPeerId: `forge-${f.b.project.id}` };
  f.store.mutate(state => {
    const project = state.projects.find(row => row.id === f.b.project.id);
    project.memorySessions = ['rna-older', 'rna-newer'].map(sessionId => ({ ...template, ...scopeOfB, sessionId, status: 'deleted', deletedAt: new Date().toISOString(), sourceSessionId: null }));
  });
  assert.deepEqual((await f.store.memoryService.scopes(f.b.project.id)).scopes.length, 2, 'before: the peer memories are searched');
  await Promise.all(f.sync.pump());
  assert.deepEqual(f.store.state.projects.find(row => row.id === f.b.project.id).memorySessions.map(row => row.sessionId), ['rna-newer'], 'one proof of the scope stays');
  assert.deepEqual((await f.store.memoryService.scopes(f.b.project.id)).scopes.length, 2, 'after: still searched');
  const writes = f.store.persistence.writes; await Promise.all(f.sync.pump()); assert.equal(f.store.persistence.writes, writes);
});

test('查询任务短暂失败后真实成功receipt清除旧诊断，零抽取也恢复健康', async t => {
  const f = await fixture(t); f.finish(); await Promise.all(f.sync.pump());
  f.outage = true; f.clock += 1001; await Promise.all(f.sync.pump());
  assert.equal(memorySyncHealth(f.store.state).healthy, false); assert.equal(f.write().code, 'MEMORY_TASK_LOOKUP_FAILED');
  f.outage = false; f.clock += 3000; await Promise.all(f.sync.pump());
  assert.equal(f.write().status, 'polling'); assert.equal(f.write().code, null); assert.equal(f.write().message, null); assert.equal(f.write().pollFailures, 0);
  assert.equal(memorySyncHealth(f.store.state).healthy, true);
  f.store.memoryService.sessionTask = async () => ({ result: { status: 'completed', result: { memories_extracted: {} } } });
  f.clock += 1001; await Promise.all(f.sync.pump());
  assert.equal(f.write().memoriesExtracted, 0); assert.equal(memorySyncHealth(f.store.state).healthy, true);
});
