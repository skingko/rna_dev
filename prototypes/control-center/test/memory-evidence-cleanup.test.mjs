import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { MemorySync, memorySyncHealth } from '../memory-sync.mjs';
import { deletionRecord } from '../session-deletion.mjs';
import { requestJSON } from '../configuration.mjs';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-evidence-cleanup-'));
  const f = { clock: 1000, calls: [], resources: new Map(), user: 'alice' };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://test'), uri = url.searchParams.get('uri');
    let raw = ''; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : null;
    f.calls.push({ method: req.method, path: url.pathname, uri });
    const send = result => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', result })); };
    const error = (status, code, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'error', error: { ...(code === undefined ? {} : { code }), message: 'PRIVATE_ERROR_BODY', ...extra } })); };
    if (url.pathname === '/api/v1/system/status') { f.onIdentity?.(); return send({ initialized: true, user: f.user }); }
    if (url.pathname === '/api/v1/sessions') return send({ session_id: body.session_id });
    if (url.pathname.endsWith('/messages/batch')) return send({ added: body.messages.length });
    if (url.pathname.endsWith('/commit')) return send({ status: 'accepted', archived: true, task_id: 'task' });
    if (url.pathname.includes('/tasks/')) return send({ status: 'completed', result: { memories_extracted: { events: 0 } } });
    if (url.pathname === '/api/v1/content/write') { f.resources.set(body.uri, body.content); return send({ uri: body.uri, mode: 'create', written_bytes: Buffer.byteLength(body.content), content_updated: true, semantic_status: 'complete', vector_status: 'complete', queue_status: {} }); }
    if (url.pathname === '/api/v1/content/read') return send(f.resources.get(uri));
    if (url.pathname === '/api/v1/fs' && req.method === 'DELETE') {
      f.resources.delete(uri);
      if (f.deleteMode === 'drop') return req.socket.destroy();
      if (f.deleteMode === 'refresh_error') return error(400, 'INVALID_ARGUMENT');
      return send({ uri });
    }
    if (url.pathname === '/api/v1/fs/stat') {
      f.onStat?.(); if (f.statWait) await f.statWait;
      if (f.statMode === 'drop') return req.socket.destroy();
      if (f.statMode === 'bare') return error(404);
      if (f.statMode === 'wrong_code') return error(404, 'ROUTE_NOT_FOUND');
      if (f.statMode === 'forbidden') return error(403, 'NOT_FOUND');
      if (f.statMode === 'oversize') return error(404, 'NOT_FOUND', { payload: 'x'.repeat(9000) });
      if (f.statMode === 'unsafe') return error(404, 'PRIVATE_ERROR_BODY\n'.repeat(10));
      if (f.resources.has(uri)) return send({ uri, isDir: false });
      return error(404, 'NOT_FOUND');
    }
    return error(404, 'ROUTE_NOT_FOUND');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.base = `http://127.0.0.1:${server.address().port}`; f.file = join(dir, 'state.json');
  f.store = new Store(f.file); f.store.configurationService.update({ memory: { endpoint: f.base } });
  const created = f.store.createProject({ name: 'Cleanup protocol fixture' }); f.pid = created.project.id; f.sid = created.session.id;
  f.session = () => f.store.state.sessions.find(row => row.id === f.sid);
  f.write = () => f.session().memoryEvidenceOutbox[0]; f.index = () => f.write().resourceIndex;
  f.sync = new MemorySync(f.store, { now: () => f.clock, pollMs: 1000 });
  f.store.mutate(state => { state.projects.find(row => row.id === f.pid).initiativeRuntime = { sdkState: { actions: [{ id: 'share', action: 'share', status: 'completed' }] } }; state.sessions.find(row => row.id === f.sid).items.push({ id: 'delivery', kind: 'assistant', source: 'initiative', initiativeActionId: 'share', simulated: false, turnId: null, text: 'Assistant-authored fixture delivery, not a user assertion.', createdAt: new Date(f.clock).toISOString() }); });
  await Promise.all(f.sync.pump()); f.clock += 1001; await Promise.all(f.sync.pump()); await Promise.all(f.sync.pump());
  assert.equal(f.index().status, 'completed'); assert.equal(f.index().receipt.contentVerified, true);
  f.receipt = structuredClone(f.index().receipt); f.uri = f.index().uri; f.baselineCalls = f.calls.length;
  // A real revocation: the source was deleted (session-evidence-cleanup scrubs cited actions this way). Context drift
  // (contextRevoked alone) keeps the document (MEM-1).
  f.revoke = () => f.store.mutate(state => { Object.assign(state.projects.find(row => row.id === f.pid).initiativeRuntime.sdkState.actions[0], { contextRevoked: true, sourceDeleted: true }); });
  f.legacy = () => f.store.mutate(state => { Object.assign(state.sessions.find(row => row.id === f.sid).memoryEvidenceOutbox[0].resourceIndex, { status: 'failed', confirmedRejected: true, code: 'MEMORY_EVIDENCE_INDEX_FAILED' }); });
  f.step = async () => { f.clock += 3600001; await Promise.all(f.sync.pump()); };
  f.count = (method, path) => f.calls.filter(row => row.method === method && row.path === path).length;
  t.after(async () => { await f.sync.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  return f;
}

test('completed write survives delete refresh failure or lost receipt; only later explicit stat NOT_FOUND settles cleanup', async t => {
  for (const mode of ['refresh_error', 'drop']) {
    const f = await fixture(t); f.revoke(); f.deleteMode = mode;
    await Promise.all(f.sync.pump());
    assert.equal(f.index().status, 'failed'); assert.equal(f.index().confirmedRejected, false);
    assert.equal(f.index().cleanup.status, 'unconfirmed'); assert.deepEqual(f.index().receipt, f.receipt);
    assert.equal(memorySyncHealth(f.store.state).issues[0].stage, 'project_resource_cleanup');
    const calls = f.calls.length; for (let n = 0; n < 50; n++) await Promise.all(f.sync.pump()); assert.equal(f.calls.length, calls);
    await f.step(); assert.equal(f.index().status, 'deleted'); assert.deepEqual(f.index().receipt, f.receipt);
    assert.deepEqual(f.index().cleanup.receipt.reconciliation.result, 'not_found');
    assert.equal(f.index().cleanup.receipt.reconciliation.upstreamCode, 'NOT_FOUND');
    assert.equal(f.count('DELETE', '/api/v1/fs'), 1); assert.equal(f.count('POST', '/api/v1/content/write'), 1);
    assert.equal(memorySyncHealth(f.store.state).evidenceIndexIssues, 0);
    assert.equal(f.store.memoryService.evidenceResourceVisible(f.pid, f.index().namespace), false, 'No proof that ancestor summaries have been cleaned');
  }
});

test('legacy failed with misleading confirmedRejected is reconciled read-only, retains historical diagnostic and original receipt across restart', async t => {
  const f = await fixture(t); f.revoke(); f.legacy(); f.resources.delete(f.uri);
  const tombstone = deletionRecord(f.store, f.session()); assert.equal(tombstone.evidenceResources.length, 1); assert.equal(tombstone.evidenceResourceRevocations.length, 1);
  await f.sync.close(); f.store = new Store(f.file); f.sync = new MemorySync(f.store, { now: () => f.clock, pollMs: 1000 });
  await Promise.all(f.sync.pump());
  assert.equal(f.index().status, 'deleted'); assert.equal(f.index().confirmedRejected, false); assert.deepEqual(f.index().receipt, f.receipt);
  assert.deepEqual(f.index().cleanup.legacyDiagnostic, { status: 'failed', code: 'MEMORY_EVIDENCE_INDEX_FAILED', confirmedRejected: true });
  assert.equal(f.count('DELETE', '/api/v1/fs'), 0); assert.equal(f.count('POST', '/api/v1/content/write'), 1);
  assert.equal((await f.store.memoryService.deleteEvidenceResource(tombstone, tombstone.evidenceResources[0])).deleted, true);
  assert.equal(f.count('DELETE', '/api/v1/fs'), 0, 'Session removal also reconciles this old failed row without replay');
});

test('exists, route/bare 404, forbidden, malformed/oversized error and network loss cannot certify deletion', async t => {
  for (const mode of ['exists', 'bare', 'wrong_code', 'forbidden', 'oversize', 'unsafe', 'drop']) {
    const f = await fixture(t); f.revoke(); f.legacy(); f.statMode = mode;
    if (mode !== 'exists') f.resources.delete(f.uri);
    await Promise.all(f.sync.pump());
    assert.equal(f.index().status, 'failed', mode); assert.equal(f.index().cleanup.status, 'unconfirmed'); assert.deepEqual(f.index().receipt, f.receipt);
    assert.equal(f.count('DELETE', '/api/v1/fs'), 0); assert.equal(f.count('POST', '/api/v1/content/write'), 1);
    assert.doesNotMatch(JSON.stringify(f.index()), /PRIVATE_ERROR_BODY|xxxxxxxxx/);
    if (mode === 'exists') assert.equal(f.index().cleanup.reconciliation.result, 'exists');
    const count = f.calls.length; await Promise.all(f.sync.pump()); assert.equal(f.calls.length, count, 'Backoff is durable, not a tight polling loop');
  }
});

test('connection, credential, namespace and authenticated identity changes cannot reconcile old evidence', async t => {
  for (const mode of ['endpoint', 'credential', 'namespace', 'identity']) {
    const f = await fixture(t); f.revoke(); f.legacy(); f.resources.delete(f.uri);
    if (mode === 'endpoint') f.store.configurationService.update({ memory: { endpoint: `${f.base}/other` } });
    if (mode === 'credential') f.store.configurationService.update({ memory: { apiKey: 'another-key' } });
    if (mode === 'namespace') f.store.mutate(state => { state.projects.find(row => row.id === f.pid).memory = { namespace: 'viking://resources/other/project' }; });
    if (mode === 'identity') f.user = 'bob';
    await Promise.all(f.sync.pump());
    assert.equal(f.index().status, 'failed', mode); assert.equal(f.index().code, 'MEMORY_EVIDENCE_SCOPE_CHANGED');
    assert.equal(f.count('GET', '/api/v1/fs/stat'), 0); assert.equal(f.count('DELETE', '/api/v1/fs'), 0); assert.deepEqual(f.index().receipt, f.receipt);
  }
});

test('connection or source changing after fresh identity or during stat prevents stale cleanup success', async t => {
  for (const mode of ['identity_then_key', 'stat_then_namespace', 'stat_then_source_live', 'stat_then_abort']) {
    const f = await fixture(t); f.revoke(); f.legacy(); f.resources.delete(f.uri);
    const change = () => {
      if (mode === 'identity_then_key') f.store.configurationService.update({ memory: { apiKey: 'changed-late' } });
      if (mode === 'stat_then_namespace') f.store.mutate(state => { state.projects.find(row => row.id === f.pid).memory = { namespace: 'viking://resources/changed/project' }; });
      if (mode === 'stat_then_source_live') f.store.mutate(state => { const action = state.projects.find(row => row.id === f.pid).initiativeRuntime.sdkState.actions[0]; delete action.contextRevoked; delete action.sourceDeleted; });
      if (mode === 'stat_then_abort') f.sync.abort.abort();
    };
    if (mode === 'identity_then_key') f.onIdentity = change; else f.onStat = change;
    await Promise.all(f.sync.pump()); assert.equal(f.index().status, 'failed', mode);
    assert.deepEqual(f.index().receipt, f.receipt); assert.equal(f.count('DELETE', '/api/v1/fs'), 0);
  }
});

test('incomplete write proof, currently live source, or forged ownership never cause a read-only deletion success or a create replay', async t => {
  for (const mode of ['incomplete', 'live', 'forged']) {
    const f = await fixture(t); f.legacy(); f.resources.delete(f.uri);
    if (mode !== 'live') f.revoke();
    f.store.mutate(state => { const index = state.sessions.find(row => row.id === f.sid).memoryEvidenceOutbox[0].resourceIndex; if (mode === 'incomplete') index.receipt.complete = false; if (mode === 'forged') index.uri = `${index.namespace}/user-owned.md`; });
    const count = f.calls.length; await Promise.all(f.sync.pump());
    assert.equal(f.index().status, 'failed'); assert.equal(f.calls.length, count);
    assert.equal(f.count('POST', '/api/v1/content/write'), 1); assert.equal(f.count('DELETE', '/api/v1/fs'), 0);
    if (mode === 'incomplete') assert.equal(deletionRecord(f.store, f.session()).evidenceResources.length, 0, 'A genuinely rejected write without full receipt is not owned deletion evidence');
  }
});

test('opt-in request error code is bounded and does not expose upstream text or affect default diagnostics', async t => {
  const f = await fixture(t); f.resources.delete(f.uri);
  const url = `${f.base}/api/v1/fs/stat?${new URLSearchParams({ uri: f.uri })}`;
  await assert.rejects(requestJSON(url), error => error.upstreamStatus === 404 && error.upstreamCode === undefined && !error.message.includes('PRIVATE'));
  await assert.rejects(requestJSON(url, { captureErrorCode: true }), error => error.upstreamCode === 'NOT_FOUND' && !JSON.stringify(error).includes('PRIVATE'));
  f.statMode = 'unsafe'; await assert.rejects(requestJSON(url, { captureErrorCode: true }), error => error.upstreamCode === undefined);
  f.statMode = 'oversize'; await assert.rejects(requestJSON(url, { captureErrorCode: true }), error => error.upstreamCode === undefined);
  f.statWait = new Promise(() => {}); await assert.rejects(requestJSON(url, { captureErrorCode: true, timeoutMs: 20 }));
});


test('explicit reviewed fresh pending index preserves prior receipt separately and only indexes resource, never re-commits archive', async t => {
  const f = await fixture(t); f.resources.delete(f.uri);
  const before = f.calls.length, previous = structuredClone(f.index());
  f.store.mutate(state => { const write = state.sessions.find(row => row.id === f.sid).memoryEvidenceOutbox[0]; write.resourceIndex = {
    status: 'pending', namespace: previous.namespace, uri: previous.uri, connectionFingerprint: previous.connectionFingerprint,
    maintenanceRecovery: { planHash: 'a'.repeat(64), priorIndex: previous, absenceProofHash: 'b'.repeat(64), expectedContentHash: previous.receipt.contentHash, at: new Date(f.clock).toISOString() }
  }; });
  await Promise.all(f.sync.pump());
  assert.equal(f.index().status, 'completed'); assert.equal(f.index().receipt.contentHash, previous.receipt.contentHash);
  assert.deepEqual(f.index().maintenanceRecovery.priorIndex, previous); assert.equal(f.write().status, 'completed');
  assert.equal(f.count('POST', '/api/v1/content/write'), 2);
  assert.deepEqual(f.calls.slice(before).map(row => [row.method, row.path]), [['POST', '/api/v1/content/write'], ['GET', '/api/v1/content/read']]);
});

test('context drift alone (contextRevoked without a deletion or privacy flag) keeps the indexed delivery; a privacy revocation withdraws it (MEM-1)', async t => {
  const f = await fixture(t);
  f.store.mutate(state => { state.projects.find(row => row.id === f.pid).initiativeRuntime.sdkState.actions[0].contextRevoked = true; });
  for (let n = 0; n < 5; n++) await f.step();
  assert.equal(f.index().status, 'completed'); assert.equal(f.count('DELETE', '/api/v1/fs'), 0); assert.ok(f.resources.has(f.uri));
  assert.equal(memorySyncHealth(f.store.state).evidenceWithdrawn, 0);
  f.store.mutate(state => { state.projects.find(row => row.id === f.pid).initiativeRuntime.sdkState.actions[0].privacyRevoked = true; });
  await Promise.all(f.sync.pump()); await f.step();
  assert.equal(f.index().status, 'deleted'); assert.equal(f.index().code, 'MEMORY_SOURCE_CHANGED'); assert.equal(f.resources.has(f.uri), false);
  const health = memorySyncHealth(f.store.state);
  assert.equal(health.evidenceWithdrawn, 1, 'a withdrawn document is counted, never silent'); assert.equal(health.healthy, true);
});
