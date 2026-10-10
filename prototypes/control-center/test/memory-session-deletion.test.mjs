import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { MemorySync } from '../memory-sync.mjs';

function latch() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-delete-memory-'));
  const f = { calls: [], sessions: new Set(), tasks: new Map(), user: 'alice', memories: ['extracted project memory'], resources: ['project document'] };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://fixture'), body = raw ? JSON.parse(raw) : null, id = url.pathname.split('/')[4];
    f.calls.push({ method: req.method, path: url.pathname, params: Object.fromEntries(url.searchParams) });
    const send = (result, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: status === 200 ? 'ok' : 'error', result })); };
    if (f.outage) return send({}, 503);
    if (url.pathname === '/api/v1/system/status') return send({ initialized: true, user: f.user });
    if (url.pathname === '/api/v1/sessions') {
      f.sessions.add(body.session_id); f.createEntered?.resolve(); if (f.holdCreate) await f.holdCreate.promise;
      return send({ session_id: body.session_id });
    }
    if (url.pathname === '/api/v1/tasks') return send({ items: f.listOverride ?? [...f.tasks.values()].filter(task => task.resource_id === url.searchParams.get('resource_id')), has_more: false, next_cursor: null });
    if (url.pathname.startsWith('/api/v1/tasks/')) {
      const task = f.tasks.get(id); if (!task) return send({}, 404);
      if (url.pathname.endsWith('/cancel')) task.status = f.cancelPending ? 'cancelling' : 'cancelled';
      return send(task);
    }
    if (url.pathname.endsWith('/messages/batch')) return send({ added: body.messages.length });
    if (url.pathname.endsWith('/commit')) {
      f.commitEntered?.resolve(); if (f.holdCommit) await f.holdCommit.promise;
      if (f.dropCommit) return req.socket.destroy();
      const task = { task_id: `task-${id}`, task_type: 'session_commit', resource_id: id, status: 'completed', result: { session_id: id } }; f.tasks.set(task.task_id, task);
      return send({ task_id: task.task_id, archived: true });
    }
    if (url.pathname.startsWith('/api/v1/sessions/')) {
      if (!f.sessions.has(id)) return send({}, 404);
      if (req.method === 'DELETE') { f.sessions.delete(id); return send({ session_id: id }); }
      return send({ session_id: id, uri: `viking://user/${f.user}/sessions/${id}`, user: { user_id: f.user }, auto_commit_policy: null });
    }
    return send({}, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.store = new Store(join(directory, 'state.json')); f.store.configurationService.update({ memory: { endpoint: `http://127.0.0.1:${server.address().port}` } });
  f.project = f.store.createProject({ name: 'Temporary deletion fixture' }); f.service = f.store.memoryService;
  f.sync = new MemorySync(f.store); f.record = () => f.store.state.sessionDeletions.find(row => row.sessionId === f.project.session.id);
  f.bind = () => f.service.createSession(f.project.project.id, { sourceSessionId: f.project.session.id });
  f.finish = () => {
    f.store.message(f.project.session.id, { text: 'temporary fixture content' });
    const turnId = f.store.state.sessions.find(row => row.id === f.project.session.id).activeTurnId;
    f.store.mutate(state => { const session = state.sessions.find(row => row.id === f.project.session.id); session.turns.find(turn => turn.id === turnId).modelConfig = { execution: 'rna' }; session.items.push({ id: 'answer', kind: 'assistant', turnId, text: 'temporary reply' }); });
    f.store.finishRuntimeTurn(f.project.session.id, turnId);
  };
  t.after(async () => { f.holdCreate?.resolve(); f.holdCommit?.resolve(); await f.sync.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  return f;
}
test('delete uses only the pinned session endpoint after project deletion; memories/resources survive and 404 is idempotent', async t => {
  const f = await fixture(t), binding = await f.bind(); f.store.deleteProject(f.project.project.id);
  const record = f.record(); const result = await f.service.deleteSessionArchive(record, record.bindings[0]);
  assert.equal(result.deleted, true); assert.equal(f.sessions.has(binding.sessionId), false); assert.deepEqual(f.memories, ['extracted project memory']); assert.deepEqual(f.resources, ['project document']);
  await f.service.deleteSessionArchive(record, record.bindings[0]);
  assert.deepEqual(f.calls.filter(call => call.method === 'DELETE').map(call => call.path), [`/api/v1/sessions/${binding.sessionId}`, `/api/v1/sessions/${binding.sessionId}`]);
  assert.ok(!f.calls.some(call => call.path.includes('/fs/') || call.path.includes('/content/')));
});
test('task discovery catches a lost receipt, cancels it, and requires terminal confirmation before deletion', async t => {
  const f = await fixture(t), binding = await f.bind(); f.tasks.set('lost-receipt', { task_id: 'lost-receipt', task_type: 'session_commit', resource_id: binding.sessionId, status: 'running' }); f.cancelPending = true;
  f.store.deleteSession(f.project.session.id); const record = f.record();
  await assert.rejects(f.service.deleteSessionArchive(record, record.bindings[0]), { code: 'MEMORY_CLEANUP_TASK_PENDING' }); assert.ok(f.sessions.has(binding.sessionId)); assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0);
  f.tasks.get('lost-receipt').status = 'cancelled'; await f.service.deleteSessionArchive(record, record.bindings[0]); assert.equal(f.sessions.size, 0);
});
test('changed endpoint, credential fingerprint, user or task ownership never deletes another identity', async t => {
  const f = await fixture(t), binding = await f.bind(); f.store.deleteSession(f.project.session.id); const record = f.record();
  for (const changed of [{ ...record, connectionFingerprint: 'wrong' }, { ...record, projectId: 'foreign' }]) await assert.rejects(f.service.deleteSessionArchive(changed, record.bindings[0]));
  f.user = 'other'; await assert.rejects(f.service.deleteSessionArchive(record, record.bindings[0]), { code: 'MEMORY_CLEANUP_IDENTITY_CHANGED' }); f.user = 'alice';
  f.listOverride = [{ task_id: 'foreign-task', task_type: 'session_commit', resource_id: 'foreign-session', status: 'completed' }];
  await assert.rejects(f.service.deleteSessionArchive(record, record.bindings[0]), { code: 'MEMORY_CLEANUP_TASK_IDENTITY_UNVERIFIED' });
  f.listOverride = undefined; f.outage = true; await assert.rejects(f.service.deleteSessionArchive(record, record.bindings[0]), { code: 'MEMORY_CLEANUP_UNAVAILABLE' });
  assert.ok(f.sessions.has(binding.sessionId)); assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0);
});
test('late creation after local deletion updates the tombstone without recreating the local project', async t => {
  const f = await fixture(t); f.createEntered = latch(); f.holdCreate = latch(); const pending = f.bind(); await f.createEntered.promise;
  f.store.deleteProject(f.project.project.id); assert.equal(f.record().bindings[0].pendingRequests.length, 1);
  f.holdCreate.resolve(); const binding = await pending;
  assert.equal(f.record().bindings[0].status, 'ready'); assert.deepEqual(f.record().bindings[0].pendingRequests, []);
  await f.service.deleteSessionArchive(f.record(), f.record().bindings[0]); assert.equal(f.sessions.has(binding.sessionId), false);
});
test('source deletion during initial identity lookup prevents even creating an untracked remote session', async t => {
  const f = await fixture(t), wait = latch(); f.service.identity = async () => { await wait.promise; return 'alice'; };
  const pending = f.bind(); f.store.deleteSession(f.project.session.id); wait.resolve(); await assert.rejects(pending, error => error.status === 409);
  assert.equal(f.sessions.size, 0); assert.deepEqual(f.record().bindings, []);
});
test('drain waits for a late commit receipt and copies its task id into the durable deletion record', async t => {
  const f = await fixture(t); f.commitEntered = latch(); f.holdCommit = latch(); f.finish(); const jobs = f.sync.pump(); await f.commitEntered.promise;
  f.store.deleteProject(f.project.project.id); let drained = false; const drain = f.sync.drainSession(f.project.session.id).then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false); assert.deepEqual(f.sync.pump(), []);
  f.holdCommit.resolve(); await Promise.all([...jobs, drain]);
  assert.equal(f.record().bindings[0].taskIds.length, 1); assert.deepEqual(f.record().bindings[0].pendingRequests, []);
  await f.service.deleteSessionArchive(f.record(), f.record().bindings[0]); assert.equal(f.sessions.size, 0);
});
test('uncertain dispatched writes cannot be declared deleted or retried as new writes', async t => {
  const f = await fixture(t), binding = await f.bind(); f.dropCommit = true;
  await assert.rejects(f.service.sessionCommit(f.project.project.id, binding.sessionId)); f.store.deleteSession(f.project.session.id);
  assert.equal(f.record().bindings[0].pendingRequests[0].status, 'uncertain');
  await assert.rejects(f.service.deleteSessionArchive(f.record(), f.record().bindings[0]), { code: 'MEMORY_CLEANUP_WRITE_UNCONFIRMED' });
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0);
  await assert.rejects(f.service.sessionMessages(f.project.project.id, binding.sessionId, { messages: [{ role: 'user', content: 'must not dispatch' }] }), { code: 'MEMORY_CLEANUP_SOURCE_DELETED' });
});
