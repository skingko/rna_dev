import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { MemorySync, memorySyncHealth } from '../memory-sync.mjs';
import { memoryEvidenceMessages, memoryEvidenceDocument, memoryEvidenceWithdrawn, planMemoryEvidence, planEvidenceRestore, recoverPreparedMemoryEvidence, freezeLegacyMemoryEvidence, reopenOutageMemoryEvidenceIndex } from '../memory-evidence-outbox.mjs';
import { reextractPlan, applyReextract } from '../memory-sync-routes.mjs';
import { deletionRecord, SessionDeletionService } from '../session-deletion.mjs';
import { projectMemorySyncStatus } from '../memory-sync-status.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { workspaceBinding } from '../initiative-privacy.mjs';

async function fixture(t, { historical = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-memory-evidence-'));
  const f = { calls: [], sessions: new Map(), resources: new Map(), clock: 1000, taskStatus: 'running', extracted: 0 };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = raw ? JSON.parse(raw) : null;
    const path = new URL(req.url, 'http://fixture').pathname; f.calls.push({ path, body, method: req.method });
    const send = result => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', result })); };
    if (path === '/api/v1/system/status') { f.onStatus?.(); if (f.statusOutage > 0) { f.statusOutage--; res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ status: 'error' })); } return send({ initialized: true, user: 'alice' }); }
    if (path === '/api/v1/sessions') { f.sessions.set(body.session_id, { body, messages: [] }); f.onCreate?.(); return send({ session_id: body.session_id }); }
    const session = f.sessions.get(path.split('/')[4]);
    if (path.endsWith('/messages/batch')) { session.messages.push(...body.messages); if (f.dropUpload) return req.socket.destroy(); f.onUpload?.(); return send({ added: body.messages.length }); }
    if (path.endsWith('/commit')) return send({ status: 'accepted', archived: true, task_id: `task-${path.split('/')[4]}` });
    if (path.includes('/tasks/')) { const taskId = path.split('/')[4]; return send({ task_id: taskId, task_type: 'session_commit', resource_id: taskId.replace(/^task-/, ''), status: f.taskStatus, result: { memories_extracted: { events: f.extracted }, token_usage: { total: { total_tokens: 23 } } } }); }
    // Conversation archive deletion (SessionDeletionService): task discovery, the session itself, and its DELETE.
    if (path === '/api/v1/tasks') return send({ items: [], has_more: false, next_cursor: null });
    if (/^\/api\/v1\/sessions\/[^/]+$/.test(path)) {
      const id = path.split('/')[4];
      if (!f.sessions.has(id)) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ status: 'error', error: { code: 'NOT_FOUND' } })); }
      if (req.method === 'DELETE') { f.sessions.delete(id); return send({ session_id: id }); }
      return send({ session_id: id, uri: `viking://user/alice/sessions/${id}`, user: { user_id: 'alice' }, auto_commit_policy: null });
    }
    if (path === '/api/v1/content/write') { f.resources.set(body.uri, body.content); f.onResourceWrite?.(); if (f.dropResource) return req.socket.destroy(); if (f.blockResource) await f.blockResource; return send({ uri: body.uri, mode: body.mode, written_bytes: Buffer.byteLength(body.content), content_updated: true, semantic_status: f.semanticStatus ?? 'complete', vector_status: 'complete', queue_status: { Semantic: { error_count: 0 }, Embedding: { error_count: 0 } } }); }
    if (path === '/api/v1/fs/stat' && f.statReal) { const uri = new URL(req.url, 'http://fixture').searchParams.get('uri'); if (!f.resources.has(uri)) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ status: 'error', error: { code: 'NOT_FOUND' } })); } return send({ uri }); }
    if (path === '/api/v1/content/read') { if (f.resourceReadError) { res.writeHead(f.resourceReadError, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ status: 'error', error: { code: 'NOT_FOUND' } })); } return send(f.resources.get(new URL(req.url, 'http://fixture').searchParams.get('uri'))); }
    // `deleteSemantic`: the refresh status OpenViking's rm wait=true reports for the removed file's parent (MEM-6).
    if (path === '/api/v1/fs' && req.method === 'DELETE') { const uri = new URL(req.url, 'http://fixture').searchParams.get('uri'); f.resources.delete(uri); f.onDelete?.(); return send({ uri, ...(f.deleteSemantic ? { semantic_root_uri: uri.slice(0, uri.lastIndexOf('/')), semantic_status: f.deleteSemantic } : {}) }); }
    // In-place index rebuild (B1): `reindexStatus` answers with an HTTP error, `reindexFailed` reports failed records.
    if (path === '/api/v1/content/reindex') { if (f.reindexStatus) { res.writeHead(f.reindexStatus, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ status: 'error', error: { code: 'PERMISSION_DENIED' } })); } return send({ status: 'completed', uri: body.uri, object_type: 'resource', mode: body.mode, scanned_records: 1, rebuilt_records: 1, failed_records: f.reindexFailed ?? 0 }); }
    if (path === '/api/v1/search/find') return send({ resources: [...f.resources].map(([uri]) => ({ uri, level: 2, abstract: 'Assistant report; not independently verified', score: 1 })) });
    return send({});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.file = join(directory, 'state.json'); f.store = new Store(f.file); f.store.configurationService.update({ memory: { endpoint: `http://127.0.0.1:${server.address().port}` } });
  const created = f.store.createProject({ name: 'Memory evidence' }); f.pid = created.project.id; f.sid = created.session.id;
  f.session = () => f.store.state.sessions.find(row => row.id === f.sid);
  f.records = () => f.session().memoryEvidenceOutbox ?? [];
  f.delivery = (id = 'delivery', text = 'Assistant claims the report is ready.') => f.store.mutate(state => { const p = state.projects.find(row => row.id === f.pid); p.initiativeRuntime ??= { sdkState: { actions: [] } }; p.initiativeRuntime.sdkState.actions.push({ id: `share-${id}`, action: 'share', status: 'completed' }); state.sessions.find(row => row.id === f.sid).items.push({ id, kind: 'assistant', source: 'initiative', turnId: null, simulated: false, createdAt: new Date(f.clock).toISOString(), text, initiativeActionId: `share-${id}`, evidenceIds: ['action:work:completed'] }); });
  f.answer = (id = 'question', status = 'answered') => f.store.mutate(state => { state.sessions.find(row => row.id === f.sid).items.push({ id, kind: 'question', source: 'interaction', simulated: false, turnId: null, interaction: { id: `interaction-${id}`, kind: 'question', source: 'initiative', status, answeredAt: new Date(f.clock).toISOString(), responseRequestId: `response-${id}`, questions: [{ id: 'timezone', question: '归档采用哪个时区？', options: [{ id: 'cn', label: '北京时间' }, { id: 'utc', label: 'UTC' }], allowCustom: true }], answers: [{ id: 'timezone', selected: ['cn'], custom: '保留完整链接\n不能只存摘要。' }] } }); });
  if (historical) { f.delivery('old'); f.answer('old-answer'); }
  f.sync = new MemorySync(f.store, { now: () => f.clock, pollMs: 1000 });
  t.after(async () => { await f.sync.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); }); return f;
}

test('deployment watermark skips old deliveries; a new one goes to the resource index only, with no remote session or paid extraction (MEM-7), and no fake user or tool claims', async t => {
  const f = await fixture(t, { historical: true }); await Promise.all(f.sync.pump()); assert.equal(f.calls.length, 0); assert.equal(f.records().length, 0);
  f.store.mutate(state => { state.projects.find(row => row.id === f.pid).jobs = [{ id: 'work', simulated: false, lane: 'background', status: 'completed', toolReceipts: [{ recordedByHost: true, toolCallId: 'call', toolName: 'project_read', status: 'completed', resultHash: 'a'.repeat(64), output: 'PRIVATE_RAW_OUTPUT', arguments: { token: 'PRIVATE_RAW_ARGS' } }] }]; });
  f.delivery(); assert.equal(f.records().length, 1); assert.equal(JSON.stringify(f.records()).includes('Assistant claims'), false);
  // An assistant-only message gives OpenViking nothing to extract (peer memories come from user messages with a peer_id):
  // nothing to archive, so nothing to wait for but the free resource index.
  assert.deepEqual([f.records()[0].status, f.records()[0].extraction, f.records()[0].sessionId, f.records()[0].resourceIndex.status], ['completed', 'not_applicable', undefined, 'pending']);
  await Promise.all(f.sync.pump()); assert.equal(f.records()[0].resourceIndex.status, 'completed');
  assert.deepEqual(f.calls.filter(row => row.path.startsWith('/api/v1/sessions') || row.path.startsWith('/api/v1/tasks')), [], 'no remote session, upload, commit or task');
  assert.equal(f.store.state.projects.find(row => row.id === f.pid).memorySessions?.length ?? 0, 0, 'and no binding');
  const content = f.calls.find(row => row.path === '/api/v1/content/write').body.content;
  assert.match(content, /not independently verified|not a user request|independently verified knowledge/); assert.match(content, /project_read/); assert.match(content, /not that the assistant conclusion/); assert.doesNotMatch(content, /PRIVATE_RAW_OUTPUT|PRIVATE_RAW_ARGS/);
  const health = memorySyncHealth(f.store.state);
  assert.deepEqual([health.evidenceIndexOnly, health.evidenceCompleted, health.evidenceExtracted, health.evidenceIndexed, health.completedTurns], [1, 0, 0, 1, 0]);
  assert.equal(health.healthy, true);
  const count = f.calls.length; for (let i = 0; i < 100; i++) await Promise.all(f.sync.pump()); assert.equal(f.calls.length, count); assert.equal(f.session().turns.length, 0);
});

test('a delivery enrolled before MEM-7 that sent nothing yet goes index-only; one already in its remote session keeps its path', async t => {
  const f = await fixture(t); f.delivery('waiting'); f.delivery('started');
  const [waiting, started] = f.records().map(row => row.id);
  // The shapes an earlier version left: enrolled for the session path, one not sent yet, one whose remote session exists.
  f.store.mutate(state => { for (const write of state.sessions.find(row => row.id === f.sid).memoryEvidenceOutbox) { delete write.extraction; Object.assign(write, { status: 'pending', nextMessage: 0, retention: { keep_recent_count: 0 } }); if (write.id === started) Object.assign(write, { status: 'ready', sessionId: 'rna-started' }); } });
  f.sync.enrollEvidence();
  const byId = id => f.records().find(row => row.id === id);
  assert.deepEqual([byId(waiting).status, byId(waiting).extraction, byId(waiting).settledFrom.status], ['completed', 'not_applicable', 'pending']);
  assert.deepEqual([byId(started).status, byId(started).extraction], ['ready', undefined]);
  const once = structuredClone(f.records()), revision = f.store.state.revision; f.sync.enrollEvidence();
  assert.deepEqual(f.records(), once, 'idempotent'); assert.equal(f.store.state.revision, revision);
});

test('structured answered interaction preserves original options and custom answer once, never cancelled/permission prose as grant', async t => {
  const f = await fixture(t); f.answer(); f.answer('cancelled', 'cancelled');
  f.store.mutate(state => state.sessions.find(row => row.id === f.sid).items.push({ id: 'mirror', kind: 'user', source: 'interaction-answer', turnId: null, simulated: false, interactionId: 'interaction-question', text: 'Mirrored UI text' }));
  assert.equal(f.records().length, 1); await Promise.all(f.sync.pump()); const messages = [...f.sessions.values()][0].messages;
  assert.deepEqual(messages.map(row => row.role), ['assistant', 'user']); assert.equal(messages[1].peer_id, `forge-${f.pid}`);
  const user = JSON.parse(messages[1].content); assert.deepEqual(user.answers[0].selectedLabels, ['北京时间']); assert.equal(user.answers[0].custom, '保留完整链接\n不能只存摘要。'); assert.match(user.authority, /not a new permission grant/); assert.doesNotMatch(JSON.stringify(messages), /Mirrored UI text/);
  f.taskStatus = 'completed'; f.extracted = 1; f.clock += 1001; await Promise.all(f.sync.pump()); assert.equal(f.records()[0].memoriesExtracted, 1); assert.equal(memorySyncHealth(f.store.state).evidenceExtracted, 1);
});

test('pending pre-existing question can be answered after deployment and enrolled; new session is initialized before delivery', async t => {
  const f = await fixture(t); f.answer('later', 'pending'); await f.sync.close(); f.sync = new MemorySync(f.store, { now: () => f.clock });
  f.store.mutate(state => { const item = state.sessions.find(row => row.id === f.sid).items.find(row => row.id === 'later'); item.interaction.status = 'answered'; }); assert.equal(f.records().length, 1);
  const created = f.store.createProject({ name: 'Second' }); const sid = created.session.id; assert.ok(f.store.state.sessions.find(row => row.id === sid).memoryEvidenceState);
  f.store.mutate(state => state.sessions.find(row => row.id === sid).items.push({ id: 'new-delivery', kind: 'assistant', source: 'initiative', turnId: null, simulated: false, text: 'New actual delivery', initiativeActionId: 'new-share' }));
  assert.equal(f.store.state.sessions.find(row => row.id === sid).memoryEvidenceOutbox.length, 1);
});

test('source change or actual revocation before upload blocks commit; missing source never resurrects', async t => {
  const f = await fixture(t); f.delivery(); const record = structuredClone(f.records()[0]);
  f.onStatus = () => f.store.mutate(state => { state.sessions.find(row => row.id === f.sid).items.find(row => row.id === 'delivery').contextRevoked = true; });
  // Revoked before its document was written (MEM-5): its index is settled as withdrawn; nothing to report.
  await Promise.all(f.sync.pump()); assert.equal(f.calls.some(row => row.path === '/api/v1/content/write'), false);
  assert.deepEqual([f.records()[0].resourceIndex.status, f.records()[0].resourceIndex.code], ['skipped', 'MEMORY_SOURCE_WITHDRAWN']);
  const health = memorySyncHealth(f.store.state); assert.equal(health.healthy, true); assert.equal(health.unresolved + health.settledLoss, 0); assert.equal(health.evidenceIndexPending, 0);
  assert.throws(() => memoryEvidenceMessages(f.store.state, f.sid, record), { code: 'MEMORY_SOURCE_CHANGED' });
  f.store.mutate(state => state.sessions.find(row => row.id === f.sid).items.splice(0)); const count = f.calls.length; await Promise.all(f.sync.pump()); assert.equal(f.calls.length, count);
});

test('an answer edited in place before upload is a settled loss, not an unknown outcome; edited after upload it is abandoned', async t => {
  for (const when of ['before', 'after']) {
    const f = await fixture(t); f.answer();
    const edit = () => f.store.mutate(state => { state.sessions.find(row => row.id === f.sid).items.find(row => row.id === 'question').interaction.answers[0].custom += ' edited'; });
    // 'after': the upload batch is acknowledged, and the edit is caught before commit.
    if (when === 'before') f.onCreate = edit; else f.onUpload = edit;
    await Promise.all(f.sync.pump()); await Promise.all(f.sync.pump());
    assert.equal(f.records()[0].status, when === 'before' ? 'uncertain' : 'abandoned', when); assert.equal(f.records()[0].code, 'MEMORY_SOURCE_CHANGED');
    assert.equal(f.calls.filter(row => row.path.endsWith('/commit')).length, 0);
    const health = memorySyncHealth(f.store.state); assert.equal(health.healthy, true, when); assert.equal(health.settledLoss, 1);
  }
});

test('a delivery edited in place before its document is written is a settled index loss, never written', async t => {
  const f = await fixture(t); f.delivery();
  f.onStatus = () => f.store.mutate(state => { state.sessions.find(row => row.id === f.sid).items.find(row => row.id === 'delivery').text += ' edited'; });
  await Promise.all(f.sync.pump()); await Promise.all(f.sync.pump());
  assert.deepEqual([f.records()[0].resourceIndex.status, f.records()[0].resourceIndex.code], ['failed', 'MEMORY_SOURCE_CHANGED']);
  assert.equal(f.calls.some(row => row.path === '/api/v1/content/write'), false);
  const health = memorySyncHealth(f.store.state); assert.equal(health.healthy, true); assert.equal(health.settledLoss, 1);
});

test('records left uncertain or failed by a source withdrawn before upload settle once at enrollment (MEM-5 migration)', async t => {
  const f = await fixture(t); f.delivery('gone'); f.delivery('changed'); f.delivery('uploaded');
  const [gone, changed, uploaded] = f.records().map(row => row.id);
  // The live shapes of 2026-10-01/02: never-uploaded 'uncertain' records and never-dispatched 'failed' indexes.
  f.store.mutate(state => {
    const session = state.sessions.find(row => row.id === f.sid), byId = id => session.memoryEvidenceOutbox.find(row => row.id === id);
    Object.assign(byId(gone), { status: 'uncertain', code: 'MEMORY_SOURCE_CHANGED', nextMessage: 0, sessionId: 'rna-empty' });
    Object.assign(byId(changed), { status: 'completed', taskId: 'paid', nextMessage: 1, resourceIndex: { ...byId(changed).resourceIndex, status: 'failed', code: 'MEMORY_SOURCE_CHANGED' } });
    Object.assign(byId(uploaded), { status: 'uncertain', code: 'MEMORY_SOURCE_CHANGED', nextMessage: 1, batchCount: 1, sessionId: 'rna-partial' });
    session.items = session.items.filter(row => row.id !== 'gone');
    session.items.find(row => row.id === 'changed').text += ' rewritten by the host';
  });
  // A second gone delivery whose index never ran: withdrawn after its archive completed.
  f.delivery('late'); const late = f.records().at(-1).id;
  f.store.mutate(state => { const session = state.sessions.find(row => row.id === f.sid); Object.assign(session.memoryEvidenceOutbox.find(row => row.id === late), { status: 'completed', taskId: 'paid-2', nextMessage: 1, resourceIndex: { ...session.memoryEvidenceOutbox.find(row => row.id === late).resourceIndex, status: 'failed', code: 'MEMORY_SOURCE_CHANGED' } }); session.items = session.items.filter(row => row.id !== 'late'); });
  f.sync.enrollEvidence();
  const byId = id => f.records().find(row => row.id === id);
  assert.deepEqual([byId(gone).status, byId(gone).code, byId(gone).resourceIndex.status], ['skipped', 'MEMORY_SOURCE_WITHDRAWN', 'skipped']);
  assert.deepEqual(byId(gone).settledFrom.status, 'uncertain');
  assert.deepEqual([byId(changed).status, byId(changed).resourceIndex.status], ['completed', 'failed'], 'a source that is still there was changed, not withdrawn (MEM-3)');
  assert.equal(byId(uploaded).status, 'abandoned');
  assert.deepEqual([byId(late).resourceIndex.status, byId(late).resourceIndex.code], ['skipped', 'MEMORY_SOURCE_WITHDRAWN']);
  const once = structuredClone(f.records()), revision = f.store.state.revision; f.sync.enrollEvidence();
  assert.deepEqual(f.records(), once, 'idempotent'); assert.equal(f.store.state.revision, revision);
  const health = memorySyncHealth(f.store.state);
  assert.equal(health.unresolved, 0); assert.equal(health.healthy, true);
  assert.deepEqual(health.settledLosses.map(row => [row.evidenceId, row.stage ?? null, row.status]).sort(), [[changed, 'project_resource_index', 'failed'], [uploaded, null, 'abandoned']].sort());
});

test('unknown dispatched upload survives restart, settles as an abandoned upload, and is never paid/replayed again', async t => {
  const f = await fixture(t); f.answer(); f.dropUpload = true; await Promise.all(f.sync.pump()); assert.equal(f.records()[0].status, 'uncertain'); const count = f.calls.length;
  assert.equal(f.records()[0].stage, 'uploading');
  await f.sync.close(); const restarted = new Store(f.file); const sync = new MemorySync(restarted); t.after(() => sync.close());
  for (let i = 0; i < 100; i++) await Promise.all(sync.pump()); assert.equal(f.calls.length, count);
  // Uploaded or not, those messages are never committed (B3): a settled loss the user can acknowledge, not red forever.
  const record = restarted.state.sessions.find(row => row.id === f.sid).memoryEvidenceOutbox[0];
  assert.deepEqual([record.status, record.code, record.reconcile.result], ['abandoned', 'MEMORY_UPLOAD_UNCONFIRMED', 'upload_unconfirmed']);
  const health = memorySyncHealth(restarted.state); assert.equal(health.healthy, true); assert.equal(health.settledLoss, 1);
  const deletion = deletionRecord(f.store, f.session()); assert.equal(deletion.bindings.length, 1); assert.equal(deletion.bindings[0].sourceSessionId, f.sid);
});

test('late schedule delivery receipt and action eviction cannot mutate the frozen memory projection', async t => {
  const f = await fixture(t); f.delivery(); const original = memoryEvidenceMessages(f.store.state, f.sid, f.records()[0]), document = memoryEvidenceDocument(f.store.state, f.sid, f.records()[0]);
  assert.equal(f.records()[0].schemaVersion, 2);
  f.onStatus = () => f.store.mutate(state => {
    const project = state.projects.find(row => row.id === f.pid);
    project.jobs = [{ id: 'work', simulated: false, lane: 'background', status: 'completed', toolReceipts: [{ recordedByHost: true, toolCallId: 'call', toolName: 'project_read', status: 'completed' }] }];
    project.initiativeRuntime.sdkState.actions = [];
  });
  await Promise.all(f.sync.pump()); assert.equal(f.records()[0].resourceIndex.status, 'completed');
  assert.deepEqual(memoryEvidenceMessages(f.store.state, f.sid, f.records()[0]), original);
  assert.equal(f.calls.find(row => row.path === '/api/v1/content/write').body.content, document, 'the document written is the frozen one');
});

test('frozen receipt metadata cannot retain revoked work or conceal actual delivered-text changes', async t => {
  // A real revocation is a deletion (sourceDeleted) or a privacy boundary (privacyRevoked); context drift is not (MEM-1).
  for (const change of ['revoke_job', 'revoke_action', 'privacy_job', 'privacy_action', 'change_text']) await t.test(change, async t => {
    const f = await fixture(t);
    f.store.mutate(state => { const p = state.projects.find(row => row.id === f.pid); p.jobs = [{ id: 'work', simulated: false, lane: 'background', status: 'completed' }]; });
    f.delivery();
    f.store.mutate(state => { const p = state.projects.find(row => row.id === f.pid);
      if (change === 'revoke_job') Object.assign(p.jobs[0], { contextRevoked: true, sourceDeleted: true }); else if (change === 'revoke_action') Object.assign(p.initiativeRuntime.sdkState.actions[0], { contextRevoked: true, sourceDeleted: true });
      else if (change === 'privacy_job') Object.assign(p.jobs[0], { privacyRevoked: true }); else if (change === 'privacy_action') Object.assign(p.initiativeRuntime.sdkState.actions[0], { contextRevoked: true, privacyRevoked: true });
      else state.sessions.find(row => row.id === f.sid).items.find(row => row.id === 'delivery').text += ' changed'; });
    assert.throws(() => memoryEvidenceMessages(f.store.state, f.sid, f.records()[0]), { code: 'MEMORY_SOURCE_CHANGED' });
  });
});

test('context drift alone (contextRevoked on the action or its work job) keeps the frozen delivery verifiable (MEM-1)', async t => {
  const f = await fixture(t);
  f.store.mutate(state => { const p = state.projects.find(row => row.id === f.pid); p.jobs = [{ id: 'work', simulated: false, lane: 'background', status: 'completed' }]; });
  f.delivery(); const original = memoryEvidenceMessages(f.store.state, f.sid, f.records()[0]);
  f.store.mutate(state => { const p = state.projects.find(row => row.id === f.pid); p.jobs[0].contextRevoked = true; p.initiativeRuntime.sdkState.actions[0].contextRevoked = true; });
  assert.deepEqual(memoryEvidenceMessages(f.store.state, f.sid, f.records()[0]), original);
  // A new delivery citing drift-revoked work still enrols, with its receipts.
  f.delivery('second'); assert.equal(f.records().length, 2);
});

test('legacy prepared-only receipt race recovers the original hashes without repeating create or upload', async t => {
  const f = await fixture(t); f.delivery();
  // Reproduce a v1 deployment (no metadata-freezing migration, deliveries archived in a remote session): its remote
  // session was created, and a late job receipt changed the unfrozen source before anything was uploaded.
  const enroll = f.sync.enrollEvidence.bind(f.sync); f.sync.enrollEvidence = () => {};
  const created = await f.store.memoryService.createSession(f.pid, { sourceSessionId: f.sid });
  f.store.mutate(state => { const w = state.sessions.find(row => row.id === f.sid).memoryEvidenceOutbox[0]; w.schemaVersion = 1; delete w.sourceContext; delete w.extraction; Object.assign(w, { status: 'pending', nextMessage: 0, retention: { keep_recent_count: 0 } }); });
  const original = structuredClone(f.records()[0]);
  f.store.mutate(state => { state.projects.find(row => row.id === f.pid).jobs = [{ id: 'work', simulated: false, lane: 'background', status: 'completed' }];
    Object.assign(state.sessions.find(row => row.id === f.sid).memoryEvidenceOutbox[0], { status: 'uncertain', code: 'MEMORY_SOURCE_CHANGED', sessionId: created.sessionId }); });
  f.sync.enrollEvidence = enroll;
  const state = structuredClone(f.store.state), session = state.sessions.find(row => row.id === f.sid), write = session.memoryEvidenceOutbox[0], binding = state.projects.find(row => row.id === f.pid).memorySessions[0];
  const recover = () => recoverPreparedMemoryEvidence(state, session, write, write.connectionFingerprint);
  assert.equal(recover().schemaVersion, 2);
  for (const patch of [{ nextMessage: 1 }, { batchCount: 1 }, { taskId: 'task' }, { code: 'MEMORY_WRITE_OUTCOME_UNKNOWN' }, { connectionFingerprint: 'changed' }]) { const previous = structuredClone(write); Object.assign(write, patch); assert.equal(recoverPreparedMemoryEvidence(state, session, write, original.connectionFingerprint), null); Object.keys(write).forEach(key => delete write[key]); Object.assign(write, previous); }
  binding.pendingRequests.push({ id: 'unknown-upload' }); assert.equal(recover(), null); binding.pendingRequests = [];
  binding.taskIds.push('task'); assert.equal(recover(), null); binding.taskIds = [];
  session.items.find(row => row.id === 'delivery').text += ' edited'; assert.equal(recover(), null);
  await Promise.all(f.sync.pump()); assert.equal(f.records()[0].status, 'ready');
  await Promise.all(f.sync.pump()); assert.equal(f.records()[0].status, 'polling');
  assert.equal(f.records()[0].sourceHash, original.sourceHash); assert.deepEqual(f.records()[0].sourceRefs, original.sourceRefs);
  assert.equal(f.calls.filter(row => row.path === '/api/v1/sessions').length, 1);
  assert.equal(f.calls.filter(row => row.path.endsWith('/messages/batch')).length, 1);
  assert.equal(f.calls.filter(row => row.path.endsWith('/commit')).length, 1);
});

test('legacy completed metadata freezes without changing source identity, receipts or dispatching extraction', async t => {
  const f = await fixture(t); f.delivery(); const write = structuredClone(f.records()[0]);
  write.schemaVersion = 1; delete write.sourceContext; write.status = 'completed'; write.taskId = 'already-paid';
  const patch = freezeLegacyMemoryEvidence(f.store.state, f.session(), write);
  assert.equal(patch.schemaVersion, 2); assert.deepEqual(Object.keys(patch).sort(), ['schemaVersion', 'sourceContext']);
  Object.assign(write, patch);
  f.store.mutate(state => { const p = state.projects.find(row => row.id === f.pid); p.initiativeRuntime.sdkState.actions = []; p.jobs = [{ id: 'work', simulated: false, lane: 'background', status: 'completed' }]; });
  assert.doesNotThrow(() => memoryEvidenceMessages(f.store.state, f.sid, write));
  assert.equal(write.taskId, 'already-paid'); assert.equal(f.calls.length, 0);
});

test('source hash includes complete original despite bounded remote excerpt; backlog overflow does not mark unseen sources consumed', async t => {
  const f = await fixture(t); f.delivery('long', 'z'.repeat(30000)); const record = f.records()[0], messages = memoryEvidenceMessages(f.store.state, f.sid, record);
  const wire = messages.map(row => row.content).join(''); assert.equal(JSON.parse(wire).text.length, 16000); assert.equal(JSON.parse(wire).textTruncated, true); assert.ok(messages.every(row => row.content.length <= 12000));
  f.store.mutate(state => { state.sessions.find(row => row.id === f.sid).items.find(row => row.id === 'long').text += 'changed after clip'; }); assert.throws(() => memoryEvidenceMessages(f.store.state, f.sid, record), { code: 'MEMORY_SOURCE_CHANGED' });
  const snapshot = structuredClone(f.store.state), session = snapshot.sessions.find(row => row.id === f.sid); session.items.push({ id: 'pending-cap', kind: 'assistant', source: 'initiative', simulated: false, text: 'wait', initiativeActionId: 'share-cap' });
  assert.equal(planMemoryEvidence(snapshot, session, { connectionFingerprint:'f', maxPending: 1 }), null);
  const plan = planMemoryEvidence(snapshot, session, { connectionFingerprint:'f', maxPending: 2 }); assert.equal(plan.records.length, 1); assert.equal(plan.records[0].sourceRefs[0].itemId, 'pending-cap');
});

test('autoStore off and session archive suspend new events but actual task polling remains read-only', async t => {
  const f = await fixture(t); f.store.configurationService.update({ memory:{autoStore:false} }); f.answer(); assert.equal(f.records().length,0); await Promise.all(f.sync.pump());assert.equal(f.calls.length,0);
  f.store.configurationService.update({memory:{autoStore:true}});await Promise.all(f.sync.pump());assert.equal(f.records()[0].status,'polling');
  f.store.mutate(state=>{state.sessions.find(row=>row.id===f.sid).archivedAt=new Date().toISOString();});f.taskStatus='completed';f.clock+=1001;await Promise.all(f.sync.pump());assert.equal(f.records()[0].status,'completed');
});

test('revoked answer mirror or cross-project interaction cannot be reconstructed from a retained question card', async t => {
  const f = await fixture(t); f.answer(); const record = f.records()[0];
  f.store.mutate(state => state.sessions.find(row => row.id === f.sid).items.push({ id: 'revoked-answer', kind: 'user', source: 'interaction-answer', simulated: false, interactionId: 'interaction-question', sourceDeleted: true, text: 'revoked' }));
  assert.throws(() => memoryEvidenceMessages(f.store.state, f.sid, record), { code: 'MEMORY_SOURCE_CHANGED' });
  await Promise.all(f.sync.pump()); assert.equal(f.calls.length, 0); assert.equal(f.records()[0].status, 'uncertain');
  const snapshot = structuredClone(f.store.state), session = snapshot.sessions.find(row => row.id === f.sid);
  session.items = session.items.filter(row => row.kind === 'question'); session.items[0].interaction.projectId = 'different-project';
  assert.throws(() => memoryEvidenceMessages(snapshot, f.sid, record), { code: 'MEMORY_SOURCE_CHANGED' });
});

/** A delivery enrolled with `options` set on the fixture: complete at once (nothing to archive, MEM-7), its resource index
 * pending for the next pump. */
async function archivedDelivery(t, options = {}) {
  const f = await fixture(t); Object.assign(f, options); f.delivery('resource', '实际助手交付：日报已安排；是否完成执行仍以将来的回执为准。');
  assert.deepEqual([f.records()[0].status, f.records()[0].extraction, f.records()[0].resourceIndex.status], ['completed', 'not_applicable', 'pending']); return f;
}
/** A delivery enrolled before MEM-7 whose archive was committed: its extraction task is being polled. */
async function legacyCommittedDelivery(f, id = 'resource', text = '实际助手交付：日报已安排。') {
  f.delivery(id, text); const writeId = f.records().at(-1).id;
  const binding = await f.store.memoryService.createSession(f.pid, { sourceSessionId: f.sid }), taskId = `task-${binding.sessionId}`;
  f.store.memoryService.updateSessionBinding(f.pid, binding.sessionId, row => { row.taskIds.push(taskId); });
  f.store.mutate(state => { const write = state.sessions.find(row => row.id === f.sid).memoryEvidenceOutbox.find(row => row.id === writeId); delete write.extraction;
    Object.assign(write, { status: 'polling', sessionId: binding.sessionId, taskId, archived: true, nextMessage: write.sourceMessageCount, retention: { keep_recent_count: 0 }, nextPollAt: 0 }); });
}

test('assistant-only delivery becomes explicitly sourced project resource with semantic receipt and exact content readback, with nothing extracted or archived', async t => {
  const f = await archivedDelivery(t); await Promise.all(f.sync.pump()); const write = f.records()[0], index = write.resourceIndex;
  assert.equal(index.status, 'completed'); assert.equal(index.receipt.contentVerified, true); assert.equal(index.receipt.semanticStatus, 'complete'); assert.equal(write.memoriesExtracted, undefined); assert.equal(f.sessions.size, 0);
  assert.equal(f.calls.filter(row => row.path === '/api/v1/content/write').length, 1); const posted = f.calls.find(row => row.path === '/api/v1/content/write').body;
  assert.equal(posted.mode, 'create'); assert.equal(posted.wait, true); assert.match(posted.content, /来源角色：assistant/); assert.match(posted.content, /不是用户陈述、权限授予/);
  const result = await f.store.memoryService.search(f.pid, { query: '日报安排' }); assert.ok(result.entries.some(row => row.uri === index.uri));
  const read = await f.store.memoryService.read(f.pid, { uri: index.uri, level: 'L2' }); assert.match(read.content, /实际助手交付/);
  await assert.rejects(f.store.memoryService.write(f.pid, null, { uri: index.uri, content: 'overwrite' }), /原始回执/);
});

test('partial semantic receipt and ambiguous index transport are not reported complete and never re-dispatch create', async t => {
  for (const mode of ['partial', 'uncertain']) {
    // While the read-only check cannot reach the service, neither can be settled.
    const f = await archivedDelivery(t, mode === 'partial' ? { semanticStatus: 'skipped' } : { dropResource: true });
    const original = f.store.memoryService.verifyEvidenceWrite.bind(f.store.memoryService);
    f.store.memoryService.verifyEvidenceWrite = async () => { throw Object.assign(new Error('unreachable'), { status: 503 }); };
    await Promise.all(f.sync.pump()); assert.equal(f.records()[0].resourceIndex.status, mode);
    for (let i = 0; i < 5; i++) await Promise.all(f.sync.pump());
    assert.equal(f.calls.filter(row => row.path === '/api/v1/content/write').length, 1);
    assert.equal((await f.store.memoryService.search(f.pid, { query: '日报' })).entries.length, 0);
    const deletion = deletionRecord(f.store, f.session()); assert.equal(deletion.evidenceResources.length, 1);
    await assert.rejects(f.store.memoryService.deleteEvidenceResource(deletion, deletion.evidenceResources[0]), { code: 'MEMORY_EVIDENCE_WRITE_UNCONFIRMED' });
    // Unknown remote state is the one thing that keeps health degraded.
    assert.equal(memorySyncHealth(f.store.state).healthy, false); assert.equal(memorySyncHealth(f.store.state).unresolved, 1);
    f.store.memoryService.verifyEvidenceWrite = original;
  }
});

test('a partial index whose only gap is deferred directory aggregation is reconciled read-only: the exact content held becomes a verified resource without a second write or a rebuild', async t => {
  const f = await archivedDelivery(t, { semanticStatus: 'skipped', statReal: true });
  await Promise.all(f.sync.pump()); assert.equal(f.records()[0].resourceIndex.status, 'partial');
  await Promise.all(f.sync.pump());
  const index = f.records()[0].resourceIndex;
  assert.equal(index.status, 'completed'); assert.equal(index.receipt.contentVerified, true); assert.equal(index.indexing.status, 'complete'); assert.equal(index.verify.status, 'verified');
  assert.equal(f.calls.filter(row => row.path === '/api/v1/content/write').length, 1); assert.equal(f.calls.filter(row => row.path === '/api/v1/content/reindex').length, 0);
  assert.equal(memorySyncHealth(f.store.state).healthy, true); assert.equal(memorySyncHealth(f.store.state).evidenceIndexed, 1);
  // Withdrawn after it was reconciled: the verified resource is then removed like any other.
  f.store.mutate(state => { state.sessions.find(row => row.id === f.sid).items.find(row => row.id === 'resource').sourceDeleted = true; });
  await Promise.all(f.sync.pump()); assert.equal(f.records()[0].resourceIndex.status, 'deleted'); assert.equal(f.resources.has(index.uri), false);
});

test('a partial index whose semantic processing failed is not completed by a content match: it is rebuilt in place until a clean rebuild, never written again (B1)', async t => {
  const f = await archivedDelivery(t, { semanticStatus: 'failed', statReal: true, reindexFailed: 1 });
  await Promise.all(f.sync.pump()); assert.equal(f.records()[0].resourceIndex.status, 'partial');
  const writes = () => f.calls.filter(row => row.path === '/api/v1/content/write').length, rebuilds = () => f.calls.filter(row => row.path === '/api/v1/content/reindex');
  // The embedding helper is still down: the content matches, but the rebuild reports a failed record.
  await Promise.all(f.sync.pump());
  let index = f.records()[0].resourceIndex, health = memorySyncHealth(f.store.state);
  assert.equal(index.status, 'partial'); assert.equal(index.reindex.attempts, 1); assert.equal(index.verify.status, 'reindex_incomplete');
  assert.equal(health.healthy, false); assert.equal(health.unresolved, 1); assert.equal(health.evidenceIndexed, 0);
  assert.deepEqual(rebuilds()[0].body, { uri: index.uri, mode: 'semantic_and_vectors', recursive: false, wait: true });
  // Nothing happens before its backoff; then a clean rebuild completes it.
  await Promise.all(f.sync.pump()); assert.equal(rebuilds().length, 1);
  f.reindexFailed = 0; f.clock = index.verify.nextCheckAt; await Promise.all(f.sync.pump());
  index = f.records()[0].resourceIndex; health = memorySyncHealth(f.store.state);
  assert.equal(index.status, 'completed'); assert.equal(index.indexing.status, 'complete'); assert.equal(index.indexing.reindexed, true); assert.equal(index.receipt.contentVerified, true);
  assert.equal(health.healthy, true); assert.equal(health.evidenceIndexed, 1); assert.equal(writes(), 1, 'content/write is never called a second time');
});

test('a partial index whose rebuild is refused, or keeps failing, settles as a stored resource with an incomplete index: listed in history, and still removed when withdrawn (B1)', async t => {
  for (const mode of ['refused', 'exhausted']) {
    const f = await archivedDelivery(t, { semanticStatus: 'failed', statReal: true, ...(mode === 'refused' ? { reindexStatus: 403 } : { reindexFailed: 1 }) });
    await Promise.all(f.sync.pump());
    for (let i = 0; i < 8 && f.records()[0].resourceIndex.status === 'partial'; i++) { f.clock += 3600000; await Promise.all(f.sync.pump()); }
    const index = f.records()[0].resourceIndex, health = memorySyncHealth(f.store.state);
    assert.deepEqual([index.status, index.code, index.indexing.status, index.indexing.reason], ['completed', 'MEMORY_EVIDENCE_INDEX_INCOMPLETE', 'incomplete', mode === 'refused' ? 'reindex_refused' : 'reindex_exhausted'], mode);
    assert.equal(index.reindex.attempts, mode === 'refused' ? 1 : 5, mode);
    assert.equal(health.healthy, true, mode); assert.equal(health.unresolved, 0, mode); assert.equal(health.settledLoss, 1, mode); assert.equal(health.evidenceIndexed, 0, mode); assert.equal(health.evidenceIndexIssues, 1, mode);
    // A settled loss is history at once (A2): nothing for the user to do about an index.
    const status = projectMemorySyncStatus(f.store.state, f.store.state.projects.find(row => row.id === f.pid)), issue = status.sessions[0].history[0];
    assert.equal(status.sessions[0].issues.length, 0, mode); assert.deepEqual([issue.stage, issue.resolution, issue.actions], ['project_resource_index', 'settled', []], mode);
    assert.match(issue.message, /语义索引没有完成/);
    assert.equal(f.calls.filter(row => row.path === '/api/v1/content/write').length, 1, mode);
    // Its content is verified as ours: a withdrawal still removes it.
    f.store.mutate(state => { state.sessions.find(row => row.id === f.sid).items.find(row => row.id === 'resource').sourceDeleted = true; });
    await Promise.all(f.sync.pump()); assert.equal(f.records()[0].resourceIndex.status, 'deleted', mode); assert.equal(f.resources.has(index.uri), false, mode);
  }
});

test('an unconfirmed write of a source revoked meanwhile is still checked read-only, then removed if it is there', async t => {
  const f = await archivedDelivery(t, { dropResource: true, statReal: true });
  await Promise.all(f.sync.pump()); const before = f.records()[0].resourceIndex; assert.equal(before.status, 'uncertain');
  f.store.mutate(state => { state.sessions.find(row => row.id === f.sid).items.find(row => row.id === 'resource').sourceDeleted = true; });
  f.clock = Date.parse(before.dispatchedAt) + 10 * 60000;
  for (let i = 0; i < 3; i++) { await Promise.all(f.sync.pump()); f.clock += 60000; }
  assert.equal(f.records()[0].resourceIndex.status, 'deleted'); assert.equal(f.resources.has(before.uri), false);
  assert.equal(f.calls.filter(row => row.path === '/api/v1/content/write').length, 1, 'never written again');
  assert.equal(memorySyncHealth(f.store.state).healthy, true);
});

test('an unconfirmed index write is settled by what the service holds: the exact content → completed, confirmed absent → sent again', async t => {
  for (const present of [true, false]) {
    const f = await archivedDelivery(t, { dropResource: true, statReal: true });
    await Promise.all(f.sync.pump());
    const before = f.records()[0].resourceIndex;
    assert.deepEqual([before.status, before.code], ['uncertain', 'MEMORY_EVIDENCE_WRITE_UNCONFIRMED']);
    await Promise.all(f.sync.pump());
    assert.equal(f.records()[0].resourceIndex.status, 'uncertain', 'not judged while the write request could still be running');
    f.dropResource = false; if (!present) f.resources.delete(before.uri);
    f.clock = Date.parse(before.dispatchedAt) + 10 * 60000;
    for (let i = 0; i < 3; i++) { await Promise.all(f.sync.pump()); f.clock += 60000; }
    const after = f.records()[0].resourceIndex;
    assert.equal(after.status, 'completed'); assert.equal(after.receipt.contentVerified, true);
    assert.equal(f.calls.filter(row => row.path === '/api/v1/content/write').length, present ? 1 : 2, present ? 'verified in place, never written again' : 'confirmed absent, so written once more');
    assert.ok((await f.store.memoryService.search(f.pid, { query: '日报' })).entries.some(row => row.uri === after.uri));
  }
});

test('revoked source is excluded immediately then only its proven owned resource is removed without touching project files', async t => {
  const f = await archivedDelivery(t); await Promise.all(f.sync.pump()); const uri = f.records()[0].resourceIndex.uri;
  const userResource = `viking://resources/projects/${f.pid}/project-guide.md`; f.resources.set(userResource, 'persistent project guide');
  f.store.mutate(state => { state.sessions.find(row => row.id === f.sid).items.find(row => row.id === 'resource').sourceDeleted = true; });
  assert.equal(f.store.memoryService.evidenceResourceVisible(f.pid, uri), false);
  await assert.rejects(f.store.memoryService.read(f.pid, { uri, level: 'L2' }), /来源不可用/);
  await Promise.all(f.sync.pump()); assert.equal(f.records()[0].resourceIndex.status, 'deleted'); assert.equal(f.resources.has(uri), false); assert.equal(f.resources.has(userResource), true);
  for (let i = 0; i < 5; i++) await Promise.all(f.sync.pump()); assert.equal(f.calls.filter(row => row.path === '/api/v1/content/write').length, 1);
});

test('accepted in-flight resource write settles into deletion tombstone before cleanup, never into removed conversation', async t => {
  let release, started; const observed = new Promise(resolve => { started = resolve; });
  const f = await archivedDelivery(t, { blockResource: new Promise(resolve => { release = resolve; }), onResourceWrite: () => started() });
  const job = Promise.all(f.sync.pump()); await observed;
  const deletion = deletionRecord(f.store, f.session()); assert.equal(deletion.evidenceResources[0].status, 'dispatching');
  f.store.mutate(state => { state.sessionDeletions ??= []; state.sessionDeletions.push(deletion); state.sessions = state.sessions.filter(row => row.id !== f.sid); });
  let drained = false; const drain = f.sync.drainSession(f.sid).then(() => { drained = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  release(); await job; await drain;
  const tombstone = f.store.state.sessionDeletions.find(row => row.sessionId === f.sid), resource = tombstone.evidenceResources[0];
  assert.equal(resource.status, 'completed'); assert.equal(resource.receipt.complete, true); assert.equal(f.store.state.sessions.some(row => row.id === f.sid), false);
  assert.equal((await f.store.memoryService.deleteEvidenceResource(tombstone, resource)).deleted, true); assert.equal(f.resources.has(resource.uri), false);
});

test('paused writes or pre-dispatch source/config changes cannot index or create a new resource', async t => {
  for (const mode of ['paused', 'source', 'connection']) {
    const f = await archivedDelivery(t);
    if (mode === 'paused') f.store.configurationService.update({ memory: { autoStore: false } });
    if (mode === 'source') f.store.mutate(state => { state.sessions.find(row => row.id === f.sid).items[0].contextRevoked = true; });
    if (mode === 'connection') f.store.configurationService.update({ memory: { apiKey: 'changed-key' } });
    await Promise.all(f.sync.pump()); assert.equal(f.calls.filter(row => row.path === '/api/v1/content/write').length, 0);
  }
});

test('revoked or unknown evidence cannot re-enter via ancestor L0/L1, direct L2 sidecars or search while unrelated project files remain readable', async t => {
  const f = await archivedDelivery(t); await Promise.all(f.sync.pump()); const namespace = f.store.memoryService.remote(f.pid).namespace;
  const guide = `${namespace}/guide.md`; f.resources.set(guide, 'Ordinary persistent guide');
  f.resources.set(`${namespace}/.abstract.md`, 'STALE_PRIVATE_ASSISTANT_SUMMARY'); f.resources.set(`${namespace}/.overview.md`, 'STALE_PRIVATE_ASSISTANT_OVERVIEW');
  assert.equal(f.store.memoryService.evidenceResourceVisible(f.pid, namespace), true);
  f.store.mutate(state => { state.sessions.find(row => row.id === f.sid).items.find(row => row.id === 'resource').sourceDeleted = true; });
  for (const uri of [namespace, `${namespace}/.abstract.md`, `${namespace}/.overview.md`, `${namespace}/rna-execution-evidence/.abstract.md`]) {
    assert.equal(f.store.memoryService.evidenceResourceVisible(f.pid, uri), false);
    await assert.rejects(f.store.memoryService.read(f.pid, { uri, level: 'L2' }), /来源不可用/);
  }
  assert.deepEqual((await f.store.memoryService.search(f.pid, { query: 'summary' })).entries.map(row => row.uri), [guide]);
  await Promise.all(f.sync.pump()); assert.equal(f.records()[0].resourceIndex.status, 'deleted');
  assert.equal(f.store.memoryService.evidenceResourceVisible(f.pid, `${namespace}/.abstract.md`), false, 'A delete receipt cannot certify ancestor semantic freshness');
  assert.match((await f.store.memoryService.read(f.pid, { uri: guide, level: 'L2' })).content, /Ordinary persistent guide/);
  const tombstone = deletionRecord(f.store, f.session());
  // Known deleted resources need not be re-deleted but their provenance still
  // needs to block stale ancestor summaries after source removal.
  assert.ok(tombstone.evidenceResourceRevocations?.length);
});

// Review X-4: a deleted conversation's remote cleanup settles item by item, so one evidence resource never holds back
// the conversation archive; a write whose outcome was never confirmed is looked at read-only once its deadline passed.
async function deleteConversation(t, options, remote) {
  const f = await fixture(t);
  // The conversation's archive: its answered card's remote session (a delivery has none, MEM-7).
  f.answer(); f.taskStatus = 'completed'; for (let i = 0; i < 3; i++) { f.clock += 1001; await Promise.all(f.sync.pump()); }
  const [archive] = f.sessions.keys(); assert.ok(archive);
  Object.assign(f, options); f.delivery('resource', '实际助手交付：日报已安排；是否完成执行仍以将来的回执为准。'); await Promise.all(f.sync.pump());
  const index = f.records().find(row => row.sourceKind === 'autonomous_delivery').resourceIndex;
  remote?.(f, index);
  f.store.deleteSession(f.sid);
  const service = (now = Date.now) => { const value = new SessionDeletionService(f.store, { executor: { running: new Map(), memorySync: f.sync }, now, intervalMs: 3600000 }); t.after(() => value.close()); return value; };
  const record = () => f.store.state.sessionDeletions.find(row => row.sessionId === f.sid);
  return { f, index, archive, service, record, later: () => Date.now() + 10 * 60000 };
}
const deletes = f => f.calls.filter(row => row.path === '/api/v1/fs' && row.method === 'DELETE').length;

test('a partial evidence write never holds back the conversation archive; after its deadline the exact content is verified and deleted', async t => {
  const { f, index, archive, service, record, later } = await deleteConversation(t, { semanticStatus: 'skipped' });
  assert.equal(index.status, 'partial');
  const early = await service().clean(f.sid);
  assert.deepEqual([early.status, early.code], ['pending', 'MEMORY_EVIDENCE_WRITE_PENDING']);
  assert.equal(f.sessions.has(archive), false, 'the archive is deleted although the evidence is still waiting');
  assert.equal(record().bindings[0].deletionStatus, 'completed'); assert.equal(record().evidenceResources[0].deletionStatus, 'pending');
  assert.equal(f.resources.has(index.uri), true); assert.equal(deletes(f), 0);
  const done = await service(later).clean(f.sid, { retry: true });
  assert.equal(done.status, 'completed'); assert.equal(f.resources.has(index.uri), false); assert.equal(deletes(f), 1);
  assert.equal(record().evidenceResources[0].deletionReconciliation.result, 'content_matches');
});

test('an uncertain evidence write the service never kept is settled as absent, without a delete', async t => {
  const { f, index, service, record, later } = await deleteConversation(t, { dropResource: true, statReal: true }, (f, index) => f.resources.delete(index.uri));
  assert.equal(index.status, 'uncertain');
  assert.equal((await service(later).clean(f.sid)).status, 'completed');
  assert.equal(deletes(f), 0); assert.equal(record().evidenceResources[0].deletionReconciliation.result, 'not_found');
});

test('evidence whose remote content differs from what was written is never deleted and blocks visibly; the archive still goes', async t => {
  const { f, index, archive, service, record, later } = await deleteConversation(t, { semanticStatus: 'skipped' }, (f, index) => f.resources.set(index.uri, 'someone else wrote this'));
  const status = await service(later).clean(f.sid);
  assert.deepEqual([status.status, status.code, status.decision, status.retryAt], ['blocked', 'MEMORY_EVIDENCE_CONTENT_DIFFERS', 'memory_differs', null]);
  assert.match(status.notice, /证据文件/);
  assert.equal(f.resources.get(index.uri), 'someone else wrote this'); assert.equal(deletes(f), 0);
  assert.equal(f.sessions.has(archive), false); assert.equal(record().bindings[0].deletionStatus, 'completed');
  assert.deepEqual([record().evidenceResources[0].deletionStatus, record().evidenceResources[0].deletionCode], ['blocked', 'MEMORY_EVIDENCE_CONTENT_DIFFERS']);
});

test('a readback 404 after accepted write is not a rejected write or proof of safe deletion', async t => {
  const f = await archivedDelivery(t, { resourceReadError: 404 }); await Promise.all(f.sync.pump());
  const index = f.records()[0].resourceIndex; assert.equal(index.status, 'uncertain'); assert.equal(index.receipt.contentUpdated, true); assert.notEqual(index.confirmedRejected, true);
  const deletion = deletionRecord(f.store, f.session()); assert.equal(deletion.evidenceResources.length, 1);
  await assert.rejects(f.store.memoryService.deleteEvidenceResource(deletion, deletion.evidenceResources[0]), { code: 'MEMORY_EVIDENCE_WRITE_UNCONFIRMED' });
  await Promise.all(f.sync.pump()); assert.equal(f.calls.filter(row => row.path === '/api/v1/content/write').length, 1);
});

test('a background work line is archived only once its run ended, never while it is a changing status line', async t => {
  // Live: lines archived while "running" were rewritten in place when the run ended, failing as MEMORY_SOURCE_CHANGED.
  const f = await fixture(t, { historical: true }); await Promise.all(f.sync.pump());
  const line = status => ({ id: 'work-line', kind: 'assistant', source: 'initiative', simulated: false, turnId: null, initiativeActionId: 'run-1-changes', createdAt: new Date(f.clock).toISOString(),
    text: status === 'running' ? '后台开始做：定时任务「每日 AI 日报」\n\n正在进行，做完后会在这里补上做了什么、改了哪些文件。' : '日报已写好。\n\n改了 1 个文件。', initiative: { kind: 'insight', reach: 'inbox', backgroundWork: { actionId: 'run-1', status } } });
  f.store.mutate(state => { state.sessions.find(row => row.id === f.sid).items.push(line('running')); });
  assert.equal(f.records().length, 0, 'not while running');
  f.store.mutate(state => { const items = state.sessions.find(row => row.id === f.sid).items; items[items.findIndex(row => row.id === 'work-line')] = line('paused'); });
  assert.equal(f.records().length, 0, 'not while paused');
  f.store.mutate(state => { const items = state.sessions.find(row => row.id === f.sid).items; items[items.findIndex(row => row.id === 'work-line')] = line('done'); });
  assert.equal(f.records().length, 1, 'the line the run ended with');
  await Promise.all(f.sync.pump());
  assert.equal(f.records()[0].resourceIndex.status, 'completed'); assert.doesNotMatch(JSON.stringify([...f.resources.values()]), /正在进行/); assert.match(JSON.stringify([...f.resources.values()]), /日报已写好/);
});

test('the one-time restore re-indexes delivery documents deleted by scope drift at the same URI without extracting again; one that no longer verifies stays withdrawn', async t => {
  const f = await archivedDelivery(t); await Promise.all(f.sync.pump());
  f.delivery('second', 'A second delivered report.'); await Promise.all(f.sync.pump()); f.clock += 1001; await Promise.all(f.sync.pump()); await Promise.all(f.sync.pump());
  assert.deepEqual(f.records().map(row => [row.status, row.resourceIndex.status]), [['completed', 'completed'], ['completed', 'completed']]);
  const uris = f.records().map(row => row.resourceIndex.uri);
  // What 0.64 left: every action drift-revoked, both documents deleted for it, and later the second delivery's text changed.
  f.store.mutate(state => {
    for (const action of state.projects.find(row => row.id === f.pid).initiativeRuntime.sdkState.actions) action.contextRevoked = true;
    const session = state.sessions.find(row => row.id === f.sid);
    for (const write of session.memoryEvidenceOutbox) Object.assign(write.resourceIndex, { status: 'deleted', code: 'MEMORY_SOURCE_CHANGED', cleanup: { status: 'deleted', completedAt: new Date(f.clock).toISOString() } });
    session.items.find(row => row.id === 'second').text += ' Edited afterwards.';
    delete session.memoryEvidenceState.scopeRestore;
  });
  for (const uri of uris) f.resources.delete(uri);
  const extraction = () => f.calls.filter(row => row.path === '/api/v1/sessions' || row.path.endsWith('/commit') || row.path.endsWith('/messages/batch')).length, before = extraction();
  f.sync.enrollEvidence();
  const [restored, withdrawn] = f.records();
  assert.equal(restored.resourceIndex.status, 'pending'); assert.equal(restored.resourceIndex.uri, uris[0]); assert.equal(restored.resourceIndex.restore.reason, 'scope_drift_revocation');
  assert.equal(withdrawn.resourceIndex.status, 'deleted');
  assert.deepEqual({ restored: f.session().memoryEvidenceState.scopeRestore.restored, stillWithdrawn: f.session().memoryEvidenceState.scopeRestore.stillWithdrawn }, { restored: 1, stillWithdrawn: 1 });
  await Promise.all(f.sync.pump());
  assert.equal(f.records()[0].resourceIndex.status, 'completed'); assert.equal(f.records()[0].resourceIndex.receipt.contentVerified, true); assert.ok(f.resources.has(uris[0]));
  assert.equal(f.calls.filter(row => row.path === '/api/v1/content/write').at(-1).body.uri, uris[0]);
  assert.equal(extraction(), before, 'embedding only: nothing is uploaded, committed or extracted again');
  const health = memorySyncHealth(f.store.state); assert.equal(health.evidenceWithdrawn, 1); assert.equal(health.healthy, true);
  const status = projectMemorySyncStatus(f.store.state, f.store.state.projects.find(row => row.id === f.pid));
  assert.equal(status.evidence.withdrawn, 1); assert.deepEqual([status.evidence.restore.restored, status.evidence.restore.stillWithdrawn], [1, 1]);
  const snapshot = structuredClone(f.session().memoryEvidenceOutbox); f.sync.enrollEvidence(); assert.deepEqual(f.session().memoryEvidenceOutbox, snapshot, 'runs once');
});

/** A background change set's line in the conversation (git change set row + its work line). */
const changeLine = (f, { id = 'line', actionId = 'a1', changeId = 'c1', status = 'deferred', text, work = 'done', extra = {} } = {}) => f.store.mutate(state => {
  const project = state.projects.find(row => row.id === f.pid);
  project.backgroundChanges = [...(project.backgroundChanges ?? []), { id: changeId, kind: 'git', actionId, at: new Date(f.clock).toISOString(), status, files: [], ...extra }];
  state.sessions.find(row => row.id === f.sid).items.push({ id, kind: 'assistant', source: 'initiative', simulated: false, turnId: null, initiativeActionId: `${actionId}-changes`, createdAt: new Date(f.clock).toISOString(), text,
    initiative: { kind: 'insight', reach: 'inbox', backgroundWork: { actionId, status: work, startedAt: new Date(f.clock).toISOString(), endedAt: new Date(f.clock).toISOString() }, backgroundChange: changeId } });
});

test('a change set that is still deferred keeps its line out of memory; deferred → applied gives one settled record and no deletion (MEM-3)', async t => {
  const f = await fixture(t, { historical: true }); await Promise.all(f.sync.pump()); f.taskStatus = 'completed';
  changeLine(f, { text: 'Its changes wait in its own working copy and are applied when the current turn ends.', extra: { hold: 'deferred', retryAt: f.clock + 30000 } });
  assert.equal(f.records().length, 0, 'deferred with a hold');
  f.store.mutate(state => { const row = state.projects.find(item => item.id === f.pid).backgroundChanges[0]; delete row.hold; delete row.retryAt; });
  assert.equal(f.records().length, 0, 'deferred');
  f.store.mutate(state => { state.projects.find(item => item.id === f.pid).backgroundChanges[0].status = 'merge_conflicted'; });
  assert.equal(f.records().length, 0, 'on its conflict card');
  // The host settles the set and says so on its line in one write (settleChange).
  ProjectInitiativeController.prototype.settleChange.call({ mutate: fn => f.store.mutate(fn), now: () => f.clock }, f.pid, 'c1', row => { row.status = 'kept'; delete row.conflicts; }, 'The background work was applied: 2 files changed.');
  assert.equal(f.records().length, 1); assert.ok(f.records()[0].settlement.textHash);
  assert.match(JSON.stringify(memoryEvidenceMessages(f.store.state, f.sid, f.records()[0])), /2 files changed/);
  await Promise.all(f.sync.pump()); f.clock += 1001; await Promise.all(f.sync.pump()); await Promise.all(f.sync.pump());
  assert.equal(f.records()[0].status, 'completed'); assert.equal(f.records()[0].resourceIndex.status, 'completed');
  assert.equal(f.calls.filter(row => row.method === 'DELETE').length, 0); assert.equal(memorySyncHealth(f.store.state).healthy, true);
  assert.doesNotMatch(JSON.stringify([...f.resources.values()]), /wait in its own working copy/); assert.match(JSON.stringify([...f.resources.values()]), /2 files changed/);
});

test('a restart-interrupted isolated run enters memory only with the line its worktree settles with (MEM-3)', async t => {
  const f = await fixture(t, { historical: true }); await Promise.all(f.sync.pump()); f.taskStatus = 'completed';
  f.store.mutate(state => {
    const project = state.projects.find(row => row.id === f.pid);
    project.git = { ...(project.git ?? {}), worktrees: [{ id: 'w2', kind: 'background', owner: { actionId: 'a2' }, state: 'active', name: 'bg-a2', dir: '.rna/worktrees/bg-a2' }] };
    state.sessions.find(row => row.id === f.sid).items.push({ id: 'run-line', kind: 'assistant', source: 'initiative', simulated: false, turnId: null, initiativeActionId: 'a2-changes', createdAt: new Date(f.clock).toISOString(), text: 'Background work started: chapter 7.', initiative: { kind: 'insight', reach: 'inbox', backgroundWork: { actionId: 'a2', status: 'running', startedAt: new Date(f.clock).toISOString() } } });
  });
  // A restart: the line says the run was cut off and its files will be settled from its worktree.
  const controller = new ProjectInitiativeController(f.store, { initialDelayMs: 86400000, tickIntervalMs: 0, decisionProvider: async function* () { throw new Error('No model request'); } }); t.after(() => controller.close());
  const line = () => f.session().items.find(row => row.id === 'run-line');
  assert.equal(line().initiative.backgroundWork.status, 'interrupted'); assert.equal(line().initiative.backgroundWork.recovering, true);
  assert.equal(f.records().length, 0, 'not while its worktree is unsettled');
  f.store.mutate(state => { state.projects.find(row => row.id === f.pid).git.worktrees[0].state = 'removed'; });
  assert.equal(f.records().length, 0, 'the worktree closing first does not expose the interim line');
  // recordGitChange: the row, then the line rewritten with its outcome (a new backgroundWork without the flag).
  f.store.mutate(state => {
    const project = state.projects.find(row => row.id === f.pid); project.backgroundChanges = [{ id: 'c2', kind: 'git', actionId: 'a2', status: 'kept', files: [], at: new Date(f.clock).toISOString() }];
    Object.assign(state.sessions.find(row => row.id === f.sid).items.find(row => row.id === 'run-line'), { text: 'This background task was: chapter 7. It stopped before finishing; 1 file without conflicts was applied.', initiative: { kind: 'insight', reach: 'inbox', backgroundWork: { actionId: 'a2', status: 'failed', endedAt: new Date(f.clock).toISOString() }, backgroundChange: 'c2' } });
  });
  assert.equal(f.records().length, 1); assert.match(JSON.stringify(memoryEvidenceMessages(f.store.state, f.sid, f.records()[0])), /1 file without conflicts was applied/);
  await Promise.all(f.sync.pump()); f.clock += 1001; await Promise.all(f.sync.pump()); await Promise.all(f.sync.pump());
  assert.equal(f.records()[0].resourceIndex.status, 'completed'); assert.equal(f.calls.filter(row => row.method === 'DELETE').length, 0); assert.equal(memorySyncHealth(f.store.state).healthy, true);
  // A line marked interrupted by an older version (no flag) is unsettled while its worktree is in use.
  const state = structuredClone(f.store.state), session = state.sessions.find(row => row.id === f.sid);
  session.items.push({ id: 'old-line', kind: 'assistant', source: 'initiative', simulated: false, turnId: null, initiativeActionId: 'a3-changes', createdAt: new Date(f.clock).toISOString(), text: 'Cut off by a restart.', initiative: { kind: 'insight', backgroundWork: { actionId: 'a3', status: 'interrupted' } } });
  state.projects.find(row => row.id === f.pid).git.worktrees.push({ id: 'w3', kind: 'background', owner: { actionId: 'a3' }, state: 'active' });
  const plan = () => planMemoryEvidence(state, session, { connectionFingerprint: 'fixture', namespace: 'viking://resources/project', now: f.clock });
  assert.equal(plan()?.records.some(row => row.sourceRefs[0].itemId === 'old-line') ?? false, false);
  state.projects.find(row => row.id === f.pid).git.worktrees.at(-1).state = 'removed';
  assert.equal(plan().records.some(row => row.sourceRefs[0].itemId === 'old-line'), true);
});

test('a settled line the host rewrites later is a supersession: a new record, the old one skipped or cleaned up as superseded, never a withdrawal (MEM-3)', async t => {
  const f = await fixture(t, { historical: true }); await Promise.all(f.sync.pump()); f.taskStatus = 'completed';
  changeLine(f, { status: 'kept', text: 'Applied 1 file.' });
  assert.equal(f.records().length, 1); const first = f.records()[0].id;
  // Rewritten before anything was sent: the old record is skipped, not left uncertain.
  f.store.mutate(state => { state.sessions.find(row => row.id === f.sid).items.find(row => row.id === 'line').text = 'Applied 1 file; the other one kept the folder version.'; });
  assert.equal(f.records().length, 2); assert.equal(f.records()[0].supersededBy, f.records()[1].id); assert.equal(f.records()[1].supersedes, first);
  await Promise.all(f.sync.pump()); f.clock += 1001; await Promise.all(f.sync.pump()); await Promise.all(f.sync.pump());
  assert.deepEqual([f.records()[0].resourceIndex.status, f.records()[0].resourceIndex.code], ['skipped', 'MEMORY_EVIDENCE_SUPERSEDED']);
  assert.equal(f.records()[1].resourceIndex.status, 'completed');
  // Rewritten after it was indexed: the superseded document is removed as superseded.
  f.store.mutate(state => { state.sessions.find(row => row.id === f.sid).items.find(row => row.id === 'line').text = 'Applied 2 files.'; });
  assert.equal(f.records().length, 3);
  for (let i = 0; i < 3; i++) { f.clock += 1001; await Promise.all(f.sync.pump()); }
  assert.deepEqual([f.records()[1].resourceIndex.status, f.records()[1].resourceIndex.code], ['deleted', 'MEMORY_EVIDENCE_SUPERSEDED']);
  assert.equal(f.records()[2].resourceIndex.status, 'completed');
  const health = memorySyncHealth(f.store.state); assert.equal(health.evidenceWithdrawn, 0); assert.equal(health.healthy, true); assert.equal(health.issues.length, 0);
});

const projectOf = (state, f) => state.projects.find(row => row.id === f.pid);
const english = f => f.store.mutate(state => { state.settings.interfaceLanguage = 'en'; });
/** A controller on the fixture's store that never reviews (no model request). */
const quietController = (t, f) => { const controller = new ProjectInitiativeController(f.store, { initialDelayMs: 86400000, tickIntervalMs: 0, decisionProvider: async function* () { throw new Error('No model request'); } }); t.after(() => controller.close()); return controller; };
const lineRecords = (f, itemId) => f.records().filter(row => row.sourceRefs[0].itemId === itemId);

test('a privacy revocation of a run withdraws its work line even when the run failed or never reported (A4)', async t => {
  const f = await fixture(t, { historical: true }); await Promise.all(f.sync.pump());
  f.store.mutate(state => { const p = projectOf(state, f); p.initiativeRuntime.sdkState.actions.push({ id: 'a1', action: 'work', status: 'failed' }); p.jobs = [...(p.jobs ?? []), { id: 'a1', projectId: f.pid, lane: 'background', simulated: false, status: 'failed', instruction: 'Chapter 7' }]; });
  // A failed run's line cites nothing (only reported runs cite `action:<id>:completed`), and is keyed `a1-changes`.
  changeLine(f, { status: 'kept', work: 'failed', text: 'This background task was: chapter 7. It stopped before finishing; 1 file without conflicts was applied.' });
  const [record] = lineRecords(f, 'line'); assert.ok(record);
  assert.match(memoryEvidenceDocument(f.store.state, f.sid, record), /stopped before finishing/);
  assert.equal(memoryEvidenceWithdrawn(f.store.state, f.sid, record), false);
  // The workspace moved: create() marks the run's action and job privacyRevoked.
  f.store.mutate(state => { const p = projectOf(state, f); p.initiativeRuntime.sdkState.actions.find(row => row.id === 'a1').privacyRevoked = true; p.jobs.find(row => row.id === 'a1').privacyRevoked = true; });
  assert.throws(() => memoryEvidenceDocument(f.store.state, f.sid, record), { code: 'MEMORY_SOURCE_CHANGED' });
  assert.equal(memoryEvidenceWithdrawn(f.store.state, f.sid, record), true, 'a withdrawal, not a change');
});

test('a delivery whose action was privacy-revoked or deleted before upload is withdrawn, not a loss to acknowledge (A8)', async t => {
  const f = await fixture(t); f.delivery();
  f.onStatus = () => f.store.mutate(state => { projectOf(state, f).initiativeRuntime.sdkState.actions.find(row => row.id === 'share-delivery').privacyRevoked = true; });
  await Promise.all(f.sync.pump());
  assert.deepEqual([f.records()[0].resourceIndex.status, f.records()[0].resourceIndex.code], ['skipped', 'MEMORY_SOURCE_WITHDRAWN']);
  assert.equal(f.calls.some(row => row.path === '/api/v1/content/write'), false);
  assert.equal(memorySyncHealth(f.store.state).settledLoss, 0);
  // Records an earlier version (remote-session path) left 'uncertain' for the same reason (a deleted conversation's receipt) settle the same way.
  f.onStatus = null; f.delivery('legacy'); const legacy = f.records().at(-1).id;
  f.delivery('edited'); const edited = f.records().at(-1).id;
  f.store.mutate(state => {
    const session = state.sessions.find(row => row.id === f.sid);
    projectOf(state, f).initiativeRuntime.sdkState.actions.find(row => row.id === 'share-legacy').sourceDeleted = true;
    session.items.find(row => row.id === 'edited').text += ' edited';
    for (const id of [legacy, edited]) { const write = session.memoryEvidenceOutbox.find(row => row.id === id); delete write.extraction; Object.assign(write, { status: 'uncertain', code: 'MEMORY_SOURCE_CHANGED', nextMessage: 0 }); }
  });
  f.sync.enrollEvidence();
  const byId = id => f.records().find(row => row.id === id);
  assert.deepEqual([byId(legacy).status, byId(legacy).code], ['skipped', 'MEMORY_SOURCE_WITHDRAWN']);
  assert.deepEqual([byId(edited).status, byId(edited).code], ['uncertain', 'MEMORY_SOURCE_CHANGED'], 'a delivery still there with different text is a change');
});

test('the evidence restore runs again after a rollback deleted the documents again, counts each once, and keeps a delivery from an earlier folder withdrawn (MIG-2, A5)', async t => {
  const f = await archivedDelivery(t); await Promise.all(f.sync.pump());
  f.delivery('second', 'A second delivered report.'); await Promise.all(f.sync.pump()); f.clock += 1001; await Promise.all(f.sync.pump()); await Promise.all(f.sync.pump());
  assert.deepEqual(f.records().map(row => row.resourceIndex.status), ['completed', 'completed']);
  const extraction = () => f.calls.filter(row => row.path === '/api/v1/sessions' || row.path.endsWith('/commit') || row.path.endsWith('/messages/batch')).length, before = extraction();
  let deletedAt = Date.now();
  // What a version before MEM-1 does on this state: drift-revoke the actions and delete every delivery document.
  const asOlderVersion = () => { deletedAt += 60000; f.store.mutate(state => {
    for (const action of projectOf(state, f).initiativeRuntime.sdkState.actions) action.contextRevoked = true;
    for (const write of state.sessions.find(row => row.id === f.sid).memoryEvidenceOutbox) Object.assign(write.resourceIndex, { status: 'deleted', code: 'MEMORY_SOURCE_CHANGED', cleanup: { status: 'deleted', completedAt: new Date(deletedAt).toISOString() } });
  }); for (const uri of f.records().map(row => row.resourceIndex.uri)) f.resources.delete(uri); };
  const settle = async () => { for (let i = 0; i < 3; i++) { f.clock += 1001; await Promise.all(f.sync.pump()); } };
  asOlderVersion(); f.sync.enrollEvidence();
  assert.deepEqual(f.records().map(row => row.resourceIndex.status), ['pending', 'pending']);
  await settle(); assert.deepEqual(f.records().map(row => row.resourceIndex.status), ['completed', 'completed']);
  // Rolled back once more, and upgraded again: given back again (no one-shot marker stops it), counted once.
  asOlderVersion(); f.sync.enrollEvidence();
  assert.deepEqual(f.records().map(row => row.resourceIndex.status), ['pending', 'pending']);
  const marker = () => f.session().memoryEvidenceState.scopeRestore;
  assert.deepEqual([marker().restored, marker().stillWithdrawn], [2, 0]);
  await settle(); assert.equal(extraction(), before, 'embedding only: nothing is extracted again');
  const revision = f.store.state.revision; f.sync.enrollEvidence(); assert.equal(f.store.state.revision, revision, 'nothing new: not run or written again');
  // A delivery the project's records place in an earlier folder stays withdrawn (a privacy boundary now); one made
  // once the current folder was observed is given back.
  f.store.mutate(state => {
    const project = projectOf(state, f);
    project.observations = [{ id: 'o-old', kind: 'workspace_change', text: 'old folder', createdAt: new Date(0).toISOString(), status: 'withdrawn', data: { source: { bindingId: 'b'.repeat(64), revision: 1 }, revocationReason: 'workspace_source_changed' } },
      { id: 'o-new', kind: 'workspace_change', text: 'this folder', createdAt: new Date(1).toISOString(), status: 'received', data: { source: { bindingId: workspaceBinding(project), revision: 1 } } }];
    state.sessions.find(row => row.id === f.sid).items.find(row => row.id === 'second').evidenceIds.push('observation:o-old');
  });
  asOlderVersion(); f.sync.enrollEvidence();
  assert.deepEqual(f.records().map(row => row.resourceIndex.status), ['pending', 'deleted']);
  assert.equal(marker().stillWithdrawn, 1);
  // Checked against another memory connection while one stayed withdrawn: checked again once the connection changes.
  const fingerprint = f.store.memoryService.connectionFingerprint(f.pid), state = structuredClone(f.store.state), session = state.sessions.find(row => row.id === f.sid);
  assert.equal(planEvidenceRestore(state, session, { connectionFingerprint: fingerprint, now: f.clock }), null);
  session.memoryEvidenceState.scopeRestore.connectionFingerprint = 'another-connection';
  assert.notEqual(planEvidenceRestore(state, session, { connectionFingerprint: fingerprint, now: f.clock }), null);
});

test('discarding a change set held read only settles its line, which then enrols (A6); a stale hold on a settled set holds no line back', async t => {
  const f = await fixture(t, { historical: true }); await Promise.all(f.sync.pump()); english(f);
  changeLine(f, { status: 'merge_conflicted', text: 'Background work may not write to the project folder now, so its changes are still in its own working copy; decide on the card above the composer.', extra: { hold: 'read_only', task: 'Chapter 7', sessionId: f.sid, worktreeId: 'w1' } });
  assert.equal(lineRecords(f, 'line').length, 0, 'on its card');
  const controller = quietController(t, f);
  const stub = Object.assign(Object.create(controller), { gitRun: async () => ({ projectId: f.pid, worktreeId: 'w1' }), background: { close: async () => {}, release: () => {} } });
  await ProjectInitiativeController.prototype.answerGitCard.call(stub, f.pid, 'c1', 'discard');
  const row = projectOf(f.store.state, f).backgroundChanges.find(item => item.id === 'c1');
  assert.deepEqual([row.status, row.discarded, row.hold], ['reverted', true, undefined]);
  const [record] = lineRecords(f, 'line'); assert.ok(record, 'the settled line enrols');
  assert.match(JSON.stringify(memoryEvidenceMessages(f.store.state, f.sid, record)), /were discarded/);
  // An earlier version left a hold on a settled set: it is not waiting, so its line is a delivery.
  changeLine(f, { id: 'line-2', actionId: 'a2', changeId: 'c2', status: 'kept', text: 'Applied 1 file.', extra: { hold: 'read_only', retryAt: f.clock + 30000 } });
  assert.equal(lineRecords(f, 'line-2').length, 1);
});

test('a change set settled by agent_merge or the worktree panel says so on its line in the same write, and that line enrols (X5)', async t => {
  const f = await fixture(t, { historical: true }); await Promise.all(f.sync.pump()); english(f);
  f.store.mutate(state => { projectOf(state, f).permissions = { workspace: 'execute', background: 'inherit', revision: 1 }; });
  const conflict = 'This background task: Chapter 7\n\n1 file conflicts with changes made in the project folder meanwhile and was not applied; decide on the card above the composer.';
  changeLine(f, { status: 'merge_conflicted', text: conflict, extra: { task: 'Chapter 7', sessionId: f.sid, worktreeId: 'w1', conflicts: [{ path: 'a.md' }] } });
  changeLine(f, { id: 'line-2', actionId: 'a2', changeId: 'c2', status: 'merge_conflicted', text: conflict, extra: { task: 'Chapter 8', sessionId: f.sid, worktreeId: 'w2', conflicts: [{ path: 'b.md' }] } });
  changeLine(f, { id: 'line-3', actionId: 'a3', changeId: 'c3', status: 'deferred', text: 'Its changes wait in its own working copy and are applied to the project folder when the current turn of the conversation ends.', extra: { task: 'Chapter 9', worktreeId: 'w3', hold: 'deferred' } });
  f.store.mutate(state => { projectOf(state, f).git = { worktrees: [{ id: 'w3', kind: 'background', owner: { actionId: 'a3' }, state: 'removed' }], applies: [] }; });
  assert.equal(['line', 'line-2', 'line-3'].flatMap(id => lineRecords(f, id)).length, 0, 'all three wait');
  const controller = quietController(t, f), settled = { c1: 'merged', c2: 'dropped' };
  for (const changeId of ['c1', 'c2']) {
    const stub = Object.assign(Object.create(controller), { gitBusy: new Set(), gitRun: async () => ({ projectId: f.pid, worktreeId: changeId, applyIds: changeId === 'c1' ? ['k1'] : [], files: new Map([['a.md', { path: 'a.md' }]]) }),
      background: { ready: () => true, close: async () => {}, handoff: async () => ({ result: { status: settled[changeId] }, handoff: null, settled: settled[changeId] }) } });
    const answer = await ProjectInitiativeController.prototype.backgroundMerge.call(stub, { projectId: f.pid, sessionId: f.sid, changeId });
    assert.equal(answer.isError, undefined, changeId);
  }
  controller.settleGone(f.pid, projectOf(f.store.state, f).backgroundChanges.find(row => row.id === 'c3'));
  const rows = Object.fromEntries(projectOf(f.store.state, f).backgroundChanges.map(row => [row.id, row]));
  assert.deepEqual([rows.c1.status, rows.c2.status, rows.c2.droppedBy, rows.c3.status, rows.c3.discarded], ['kept', 'reverted', 'agent', 'reverted', true]);
  const text = id => JSON.stringify(memoryEvidenceMessages(f.store.state, f.sid, lineRecords(f, id)[0]));
  assert.match(text('line'), /The conversation merged its changes \(1 file\)/);
  assert.match(text('line-2'), /chose not to merge its changes/);
  assert.match(text('line-3'), /removed in Project settings › Worktrees & Git, and its changes were not applied/);
  for (const id of ['line', 'line-2', 'line-3']) { assert.equal(lineRecords(f, id).length, 1, id); assert.doesNotMatch(text(id), /decide on the card|wait in its own working copy/, id); }
});

test('a run a restart cut off gets a final line once its working copy had nothing to apply, could not be read or left the worktree panel, and enrols (MIG-4, X8)', async t => {
  const f = await fixture(t, { historical: true }); await Promise.all(f.sync.pump()); english(f);
  const ids = ['nothing', 'unreadable', 'removed'];
  f.store.mutate(state => {
    projectOf(state, f).git = { worktrees: ids.map(id => ({ id: `w-${id}`, kind: 'background', owner: { actionId: `a-${id}` }, state: 'active', name: `bg-${id}`, dir: `.rna/worktrees/bg-${id}` })), applies: [] };
    state.sessions.find(row => row.id === f.sid).items.push(...ids.map(id => ({ id: `line-${id}`, kind: 'assistant', source: 'initiative', simulated: false, turnId: null, initiativeActionId: `a-${id}-changes`, createdAt: new Date(f.clock).toISOString(), text: 'Background work started.', initiative: { kind: 'insight', reach: 'inbox', backgroundWork: { actionId: `a-${id}`, status: 'running', startedAt: new Date(f.clock).toISOString() } } })));
  });
  const controller = quietController(t, f), work = id => f.session().items.find(row => row.id === `line-${id}`);
  assert.ok(ids.every(id => work(id).initiative.backgroundWork.recovering === true), 'cut off by the restart');
  // Its working copy had nothing to apply (recordGitChange, outcome 'nothing'): the worktree goes, the line is final.
  controller.background.close = async bg => { f.store.mutate(state => { projectOf(state, f).git.worktrees.find(row => row.id === bg.worktreeId).state = 'removed'; }); };
  await controller.recordGitChange({ projectId: f.pid }, { id: 'a-nothing', content: 'Outline chapter 7' }, { projectId: f.pid, worktreeId: 'w-nothing' }, { status: 'nothing' });
  // The worktree panel removed one before recovery ran; another's working copy cannot be read.
  f.store.mutate(state => { projectOf(state, f).git.worktrees.find(row => row.id === 'w-removed').state = 'removed'; });
  controller.background.load = async () => { throw new Error('unreadable working copy'); };
  await controller.recoverProjectWorktrees(f.pid);
  for (const id of ids) assert.equal(work(id).initiative.backgroundWork.recovering, undefined, id);
  assert.match(work('nothing').text, /Outline chapter 7[\s\S]*It had not changed any file/);
  assert.match(work('unreadable').text, /could not be read/); assert.match(work('removed').text, /removed in Project settings › Worktrees & Git/);
  assert.equal(lineRecords(f, 'line-nothing').length, 1); assert.equal(lineRecords(f, 'line-removed').length, 1);
  assert.equal(lineRecords(f, 'line-unreadable').length, 0, 'its worktree is still there, kept for the panel');
  f.store.mutate(state => { projectOf(state, f).git.worktrees.find(row => row.id === 'w-unreadable').state = 'removed'; });
  assert.equal(lineRecords(f, 'line-unreadable').length, 1);
});

/** Runs every pending delivery of `f` through archive, extraction and index. */
const settleDeliveries = async (f, rounds = 6) => { f.taskStatus = 'completed'; for (let i = 0; i < rounds; i++) { f.clock += 1001; await Promise.all(f.sync.pump()); } };

test('an archived project\'s pending delivery documents never take the pump\'s two slots: a live conversation after it still syncs (MIG-1)', async t => {
  const f = await archivedDelivery(t); f.delivery('second', 'A second delivered report.'); f.delivery('third', 'A third delivered report.'); await settleDeliveries(f);
  assert.deepEqual(f.records().map(row => row.resourceIndex.status), ['completed', 'completed', 'completed']);
  // What the evidence restore leaves for a project archived since: its documents back to 'pending'.
  f.store.mutate(state => {
    state.projects.find(row => row.id === f.pid).archivedAt = new Date(f.clock).toISOString();
    for (const write of state.sessions.find(row => row.id === f.sid).memoryEvidenceOutbox) { const { namespace, uri, connectionFingerprint } = write.resourceIndex; write.resourceIndex = { status: 'pending', namespace, uri, connectionFingerprint, mode: 'create' }; }
  });
  const live = f.store.createProject({ name: 'Live' }), sid = live.session.id;
  f.store.message(sid, { text: '设计约束：保留键盘焦点。' });
  const turnId = f.store.state.sessions.find(row => row.id === sid).activeTurnId;
  f.store.mutate(state => { const session = state.sessions.find(row => row.id === sid); session.turns.find(row => row.id === turnId).modelConfig = { execution: 'rna' }; session.items.push({ id: `answer-${turnId}`, turnId, kind: 'assistant', text: '已记下。' }); });
  f.store.finishRuntimeTurn(sid, turnId);
  // Live order: the archived conversation sits before the live one.
  f.store.mutate(state => { state.sessions.sort((a, b) => Number(b.id === f.sid) - Number(a.id === f.sid)); });
  const memoryWrite = () => f.store.state.sessions.find(row => row.id === sid).turns.find(row => row.id === turnId).memoryWrite;
  assert.equal(memoryWrite().status, 'pending');
  assert.ok(f.store.state.sessions.findIndex(row => row.id === f.sid) < f.store.state.sessions.findIndex(row => row.id === sid), 'the archived conversation is walked first');
  const writes = () => f.calls.filter(row => row.path === '/api/v1/content/write').length, before = writes();
  await Promise.all(f.sync.pump());
  assert.notEqual(memoryWrite().status, 'pending', 'the live conversation got a slot on the first pass');
  assert.equal(writes(), before, 'nothing is written for the archived project');
  assert.ok(f.records().every(row => row.resourceIndex.status === 'pending'));
  // Unarchived: its documents are indexed again.
  f.store.mutate(state => { delete state.projects.find(row => row.id === f.pid).archivedAt; });
  await settleDeliveries(f);
  assert.deepEqual(f.records().map(row => row.resourceIndex.status), ['completed', 'completed', 'completed']);
});

test('the one-time evidence restore waits while the conversation or its project is archived, without a marker, and runs once unarchived (MIG-1)', async t => {
  for (const scope of ['session', 'project']) {
    const f = await archivedDelivery(t); await Promise.all(f.sync.pump());
    const uri = f.records()[0].resourceIndex.uri;
    f.store.mutate(state => {
      const session = state.sessions.find(row => row.id === f.sid);
      Object.assign(session.memoryEvidenceOutbox[0].resourceIndex, { status: 'deleted', code: 'MEMORY_SOURCE_CHANGED', cleanup: { status: 'deleted', completedAt: new Date(f.clock).toISOString() } });
      delete session.memoryEvidenceState.scopeRestore;
      (scope === 'session' ? session : state.projects.find(row => row.id === f.pid)).archivedAt = new Date(f.clock).toISOString();
    });
    f.resources.delete(uri);
    const fingerprint = f.store.memoryService.connectionFingerprint(f.pid);
    assert.equal(planEvidenceRestore(f.store.state, f.session(), { connectionFingerprint: fingerprint }), null, scope);
    f.sync.enrollEvidence(); await Promise.all(f.sync.pump());
    assert.equal(f.records()[0].resourceIndex.status, 'deleted', scope); assert.equal(f.session().memoryEvidenceState.scopeRestore, undefined, scope);
    f.store.mutate(state => { const session = state.sessions.find(row => row.id === f.sid); delete (scope === 'session' ? session : state.projects.find(row => row.id === f.pid)).archivedAt; });
    f.sync.enrollEvidence();
    assert.equal(f.records()[0].resourceIndex.status, 'pending', scope); assert.equal(f.session().memoryEvidenceState.scopeRestore.restored, 1, scope);
    await Promise.all(f.sync.pump()); assert.equal(f.records()[0].resourceIndex.status, 'completed', scope); assert.ok(f.resources.has(uri), scope);
  }
});

const revokeResource = (f, revoked) => f.store.mutate(state => { const item = state.sessions.find(row => row.id === f.sid).items.find(row => row.id === 'resource'); if (revoked) item.sourceDeleted = true; else delete item.sourceDeleted; });

test('a source that comes back while its document is being deleted is written again, not left as a stopped cleanup (B4)', async t => {
  const f = await archivedDelivery(t, { statReal: true }); await Promise.all(f.sync.pump());
  const uri = f.records()[0].resourceIndex.uri, writes = () => f.calls.filter(row => row.path === '/api/v1/content/write').length;
  revokeResource(f, true);
  f.onDelete = () => { f.onDelete = null; revokeResource(f, false); };
  await Promise.all(f.sync.pump());
  let index = f.records()[0].resourceIndex;
  assert.deepEqual([index.status, index.restore.reason, index.cleanupHistory[0].status], ['pending', 'source_restored_during_cleanup', 'deleted']);
  assert.equal(f.resources.has(uri), false, 'the removal happened');
  await Promise.all(f.sync.pump());
  index = f.records()[0].resourceIndex;
  assert.equal(index.status, 'completed'); assert.ok(f.resources.has(uri)); assert.equal(writes(), 2);
  const health = memorySyncHealth(f.store.state); assert.equal(health.healthy, true); assert.equal(health.unresolved + health.settledLoss, 0); assert.equal(health.evidenceWithdrawn, 0);
});

test('a cleanup stopped because its source came back is settled by what the service holds: still there → completed again, gone → written again (B4)', async t => {
  for (const held of ['matches', 'missing']) {
    const f = await archivedDelivery(t, { statReal: true }); await Promise.all(f.sync.pump());
    const uri = f.records()[0].resourceIndex.uri, deletes = () => f.calls.filter(row => row.path === '/api/v1/fs' && row.method === 'DELETE').length;
    revokeResource(f, true);
    // The source comes back while the cleanup authenticates, before anything is deleted.
    f.onStatus = () => { f.onStatus = null; revokeResource(f, false); };
    await Promise.all(f.sync.pump());
    let index = f.records()[0].resourceIndex;
    assert.deepEqual([index.status, index.code, index.cleanup.status], ['failed', 'MEMORY_EVIDENCE_CLEANUP_PAUSED', 'unconfirmed'], held);
    assert.equal(memorySyncHealth(f.store.state).unresolved, 1, held); assert.equal(deletes(), 0, held);
    if (held === 'missing') f.resources.delete(uri);
    f.clock = index.cleanup.nextCheckAt; await Promise.all(f.sync.pump());
    index = f.records()[0].resourceIndex;
    if (held === 'matches') {
      assert.deepEqual([index.status, index.code, index.cleanup, index.cleanupHistory[0].outcome], ['completed', null, undefined, 'matches']);
      assert.equal(index.receipt.contentVerified, true);
    } else {
      assert.deepEqual([index.status, index.restore.reason], ['pending', 'source_restored_after_cleanup']);
      await Promise.all(f.sync.pump()); assert.equal(f.records()[0].resourceIndex.status, 'completed'); assert.ok(f.resources.has(uri));
    }
    assert.equal(deletes(), 0, held);
    const health = memorySyncHealth(f.store.state); assert.equal(health.healthy, true, held); assert.equal(health.unresolved + health.settledLoss, 0, held);
  }
});

test('an unconfirmed index write whose check answers another scope, or keeps finding other content, settles as a listed loss instead of being checked forever (B4)', async t => {
  for (const answer of ['scope_changed', 'differs']) {
    const f = await archivedDelivery(t, { dropResource: true, statReal: true }); await Promise.all(f.sync.pump());
    const before = f.records()[0].resourceIndex; assert.equal(before.status, 'uncertain');
    if (answer === 'scope_changed') f.store.configurationService.update({ memory: { apiKey: 'rotated-synthetic-key' } });
    else f.resources.set(before.uri, 'someone else wrote this');
    f.clock = Date.parse(before.dispatchedAt) + 10 * 60000;
    for (let i = 0; i < 10 && f.records()[0].resourceIndex.status === 'uncertain'; i++) { await Promise.all(f.sync.pump()); f.clock += 3600000; }
    const index = f.records()[0].resourceIndex;
    assert.deepEqual([index.status, index.code], ['failed', answer === 'scope_changed' ? 'MEMORY_EVIDENCE_SCOPE_CHANGED' : 'MEMORY_EVIDENCE_CONTENT_DIFFERS'], answer);
    assert.equal(index.verify.checks, answer === 'scope_changed' ? 1 : 6, answer);
    const health = memorySyncHealth(f.store.state); assert.equal(health.healthy, true, answer); assert.equal(health.unresolved, 0, answer); assert.equal(health.settledLoss, 1, answer);
    const issue = projectMemorySyncStatus(f.store.state, f.store.state.projects.find(row => row.id === f.pid)).sessions[0].history[0];
    assert.deepEqual(issue.actions, [], answer);
    if (answer === 'differs') {
      // Never ours to delete: withdrawing the delivery leaves the other content alone.
      revokeResource(f, true); await Promise.all(f.sync.pump());
      assert.equal(f.resources.get(index.uri), 'someone else wrote this'); assert.equal(f.calls.filter(row => row.method === 'DELETE').length, 0);
    }
  }
});

test('a transient failure before the index write is sent is retried with backoff and completes with exactly one write; a lasting one settles only after the bound (B5)', async t => {
  const f = await archivedDelivery(t); f.store.memoryService.identities.clear(); f.statusOutage = 1;
  const writes = () => f.calls.filter(row => row.path === '/api/v1/content/write').length;
  await Promise.all(f.sync.pump());
  let index = f.records()[0].resourceIndex, health = memorySyncHealth(f.store.state);
  assert.deepEqual([index.status, index.code, index.retry.attempts, index.retry.outages], ['pending', 'MEMORY_CONNECTION_UNAVAILABLE', 0, 1]);
  assert.equal(health.healthy, false); assert.equal(health.unresolved, 1); assert.equal(health.settledLoss, 0); assert.equal(writes(), 0);
  await Promise.all(f.sync.pump()); assert.equal(f.records()[0].resourceIndex.retry.outages, 1, 'waits for its backoff');
  f.clock = index.retry.nextCheckAt; await Promise.all(f.sync.pump());
  index = f.records()[0].resourceIndex; health = memorySyncHealth(f.store.state);
  assert.equal(index.status, 'completed'); assert.equal(index.retry, null); assert.equal(writes(), 1); assert.equal(health.healthy, true);

  // A failure that is not the service being down settles as a loss once it never got through.
  const g = await archivedDelivery(t); g.store.memoryService.writeEvidenceResource = async () => { throw new Error('document could not be prepared'); };
  for (let i = 0; i < 20 && g.records()[0].resourceIndex.status === 'pending'; i++) { await Promise.all(g.sync.pump()); g.clock += 3600000; }
  const settled = g.records()[0].resourceIndex;
  assert.deepEqual([settled.status, settled.code, settled.retry.attempts, settled.retry.outages], ['failed', 'MEMORY_EVIDENCE_INDEX_FAILED', 12, 0]);
  assert.equal(memorySyncHealth(g.store.state).healthy, true); assert.equal(memorySyncHealth(g.store.state).settledLoss, 1);
  assert.equal(g.calls.filter(row => row.path === '/api/v1/content/write').length, 0);
});

test('an outage of the memory service, however long, never settles an unsent index write as a loss: it waits like the archive does and completes with one write once the service is back', async t => {
  const f = await archivedDelivery(t); f.store.memoryService.identities.clear(); f.statusOutage = Infinity;
  const writes = () => f.calls.filter(row => row.path === '/api/v1/content/write').length;
  // Two days of hourly checks: far past the bound a failing write gets.
  for (let i = 0; i < 48; i++) { await Promise.all(f.sync.pump()); f.clock += 3600000; f.store.memoryService.identities.clear(); }
  let index = f.records()[0].resourceIndex, health = memorySyncHealth(f.store.state);
  assert.deepEqual([index.status, index.code, index.retry.attempts], ['pending', 'MEMORY_CONNECTION_UNAVAILABLE', 0]);
  assert.equal(index.retry.outages, 48); assert.ok(index.retry.nextCheckAt - f.clock <= 3600000, 'backoff stays capped');
  assert.equal(health.healthy, false); assert.equal(health.unresolved, 1); assert.equal(health.settledLoss, 0); assert.equal(writes(), 0);
  f.statusOutage = 0; f.clock = index.retry.nextCheckAt; await Promise.all(f.sync.pump());
  index = f.records()[0].resourceIndex; health = memorySyncHealth(f.store.state);
  assert.deepEqual([index.status, index.retry], ['completed', null]); assert.equal(writes(), 1); assert.equal(health.healthy, true); assert.equal(health.settledLoss, 0);
});

test('an index write an earlier version settled after an outage, never sent, is reopened once with a fresh bound and completes; sent, refused or already reopened ones stay as they are', async t => {
  const legacy = { status: 'failed', code: 'MEMORY_EVIDENCE_INDEX_FAILED', retry: { attempts: 12, nextCheckAt: null, exhaustedAt: '2026-10-07T00:00:00.000Z' }, acknowledgedAt: '2026-10-08T00:00:00.000Z' };
  assert.equal(reopenOutageMemoryEvidenceIndex({ resourceIndex: { ...legacy, dispatchedAt: '2026-10-06T00:00:00.000Z' } }, 'now'), null, 'sent');
  assert.equal(reopenOutageMemoryEvidenceIndex({ resourceIndex: { ...legacy, confirmedRejected: true } }, 'now'), null, 'refused');
  assert.equal(reopenOutageMemoryEvidenceIndex({ resourceIndex: { ...legacy, retry: { ...legacy.retry, outages: 0 } } }, 'now'), null, 'settled by this version: a real failure');
  assert.equal(reopenOutageMemoryEvidenceIndex({ resourceIndex: { ...legacy, cleanup: { status: 'pending' } } }, 'now'), null, 'being withdrawn');
  assert.equal(reopenOutageMemoryEvidenceIndex({ resourceIndex: { ...legacy, code: 'MEMORY_EVIDENCE_SCOPE_CHANGED' } }, 'now'), null, 'another failure');

  const f = await archivedDelivery(t);
  f.store.mutate(state => { const write = state.sessions.find(row => row.id === f.sid).memoryEvidenceOutbox[0]; write.resourceIndex = { ...write.resourceIndex, ...legacy }; });
  // Seen at enrollment (every change, and at startup): back to 'pending', no longer a loss.
  const reopened = f.records()[0].resourceIndex;
  assert.deepEqual([reopened.status, reopened.code, reopened.retry], ['pending', null, null]); assert.equal(memorySyncHealth(f.store.state).settledLoss, 0);
  await Promise.all(f.sync.pump());
  const index = f.records()[0].resourceIndex, health = memorySyncHealth(f.store.state);
  assert.deepEqual([index.status, index.code, index.retry], ['completed', null, null]); assert.equal(index.acknowledgedAt, undefined);
  assert.deepEqual(index.reopened.previous, { attempts: 12, exhaustedAt: legacy.retry.exhaustedAt }); assert.equal(index.reopened.reason, 'outage_counted');
  assert.equal(health.settledLoss, 0); assert.equal(health.evidenceIndexed, 1); assert.equal(f.calls.filter(row => row.path === '/api/v1/content/write').length, 1);
  assert.equal(reopenOutageMemoryEvidenceIndex({ resourceIndex: { ...index, ...legacy } }, 'now'), null, 'never reopened twice');
  for (let i = 0; i < 4; i++) { f.clock += 3600000; await Promise.all(f.sync.pump()); }
  assert.equal(f.calls.filter(row => row.path === '/api/v1/content/write').length, 1);
});

test('a rebuild that fails while the memory service is down is not counted toward the rebuild bound; one that fails while the service answers is (B1)', async t => {
  const f = await archivedDelivery(t, { semanticStatus: 'failed', statReal: true });
  await Promise.all(f.sync.pump()); assert.equal(f.records()[0].resourceIndex.status, 'partial');
  const rebuilds = () => f.calls.filter(row => row.path === '/api/v1/content/reindex').length;
  f.reindexStatus = 503; f.statusOutage = Infinity;
  for (let i = 0; i < 12; i++) { f.clock += 3600000; await Promise.all(f.sync.pump()); }
  let index = f.records()[0].resourceIndex;
  assert.equal(index.status, 'partial'); assert.equal(index.reindex, undefined); assert.ok(rebuilds() >= 1);
  assert.ok(['reindex_unreachable', 'unreachable'].includes(index.verify.status), index.verify.status);
  assert.equal(memorySyncHealth(f.store.state).unresolved, 1); assert.equal(memorySyncHealth(f.store.state).settledLoss, 0);
  f.reindexStatus = 0; f.statusOutage = 0; f.clock += 3600000; await Promise.all(f.sync.pump());
  index = f.records()[0].resourceIndex;
  assert.deepEqual([index.status, index.code, index.indexing.status], ['completed', null, 'complete']); assert.equal(index.reindex.attempts, 1);

  const g = await archivedDelivery(t, { semanticStatus: 'failed', statReal: true, reindexStatus: 503 });
  await Promise.all(g.sync.pump());
  for (let i = 0; i < 8 && g.records()[0].resourceIndex.status === 'partial'; i++) { g.clock += 3600000; await Promise.all(g.sync.pump()); }
  const settled = g.records()[0].resourceIndex;
  assert.deepEqual([settled.status, settled.code, settled.indexing.reason, settled.reindex.attempts, settled.reindex.upstreamStatus], ['completed', 'MEMORY_EVIDENCE_INDEX_INCOMPLETE', 'reindex_exhausted', 5, 503]);
});

test('a delivery enrolled before MEM-7 whose paid extraction failed still gets its free resource index, once; a paid re-extraction is neither offered nor accepted for it (B7, MEM-7)', async t => {
  const f = await fixture(t); await legacyCommittedDelivery(f);
  f.taskStatus = 'failed'; f.clock += 1001; await Promise.all(f.sync.pump());
  assert.deepEqual([f.records()[0].status, f.records()[0].code], ['failed', 'MEMORY_EXTRACTION_FAILED']);
  assert.equal(memorySyncHealth(f.store.state).evidenceIndexPending, 1, 'counted while it waits');
  await Promise.all(f.sync.pump());
  const writes = () => f.calls.filter(row => row.path === '/api/v1/content/write').length, sessions = f.sessions.size;
  assert.equal(f.records()[0].resourceIndex.status, 'completed'); assert.equal(writes(), 1);
  let health = memorySyncHealth(f.store.state); assert.equal(health.evidenceIndexed, 1); assert.equal(health.evidenceIndexPending, 0); assert.equal(health.settledLoss, 1);
  // An assistant-authored delivery gives OpenViking nothing to extract: the memory page offers no paid re-extraction,
  // and the route refuses one (reextractPlan runs first in it, and again inside the mutation).
  const issue = projectMemorySyncStatus(f.store.state, f.store.state.projects.find(row => row.id === f.pid)).sessions[0].history[0];
  assert.deepEqual([issue.code, issue.actions], ['MEMORY_EXTRACTION_FAILED', []]);
  const ref = { sessionId: f.sid, evidenceId: f.records()[0].id };
  assert.throws(() => reextractPlan(f.store.state, f.pid, ref, { say: text => text.en }), error => error.code === 'memory_reextract_unavailable' && /autonomous delivery/.test(error.message));
  f.taskStatus = 'completed'; for (let i = 0; i < 4; i++) { f.clock += 1001; await Promise.all(f.sync.pump()); }
  assert.deepEqual([f.records()[0].status, f.records()[0].code, f.records()[0].resourceIndex.status], ['failed', 'MEMORY_EXTRACTION_FAILED', 'completed'], 'nothing was queued');
  assert.equal(writes(), 1); assert.equal(f.sessions.size, sessions, 'no new remote session');
  health = memorySyncHealth(f.store.state); assert.equal(health.settledLoss, 1); assert.equal(health.healthy, true);
});

test('a paid re-extraction an earlier version queued for a delivery and never sent goes index-only like the delivery, and says so (MEM-7)', async t => {
  const f = await fixture(t); await legacyCommittedDelivery(f);
  f.taskStatus = 'failed'; f.clock += 1001; await Promise.all(f.sync.pump()); await Promise.all(f.sync.pump());
  assert.deepEqual([f.records()[0].status, f.records()[0].resourceIndex.status], ['failed', 'completed']);
  const previousSession = f.records()[0].sessionId, sessions = f.sessions.size, calls = f.calls.length;
  // What 0.68.0's route left when the user confirmed a re-extraction the pump had not sent yet.
  f.store.mutate(state => { const write = state.sessions.find(row => row.id === f.sid).memoryEvidenceOutbox[0]; applyReextract(write, { connectionFingerprint: f.store.memoryService.connectionFingerprint(f.pid), now: '2026-10-04T08:00:00.000Z' }); });
  for (let i = 0; i < 4; i++) { f.clock += 1001; await Promise.all(f.sync.pump()); }
  const write = f.records()[0];
  assert.deepEqual([write.status, write.extraction, write.sessionId], ['completed', 'not_applicable', undefined]);
  assert.deepEqual(write.settledFrom.reextract, { requestedAt: '2026-10-04T08:00:00.000Z', attempts: 1, code: 'MEMORY_REEXTRACT_NOT_APPLICABLE' });
  assert.equal(write.reextract.previous.at(-1).sessionId, previousSession, 'the earlier remote session stays known to deletion');
  assert.equal(f.sessions.size, sessions, 'no remote session'); assert.deepEqual(f.calls.slice(calls).filter(row => row.path.startsWith('/api/v1/sessions') || row.path === '/api/v1/content/write'), [], 'nothing sent, no second index write');
  const health = memorySyncHealth(f.store.state); assert.equal(health.settledLoss, 0); assert.equal(health.evidenceIndexOnly, 1); assert.equal(health.healthy, true);
});

test('a settled evidence record\'s receipts move to the history archive; what deletion, rewind and the memory page read stays (MEM-11)', async t => {
  const f = await fixture(t); f.answer(); f.delivery();
  await Promise.all(f.sync.pump());
  const answer = () => f.records().find(row => row.sourceKind === 'interaction_answer');
  assert.equal(answer().status, 'polling'); assert.ok(Object.hasOwn(answer(), 'nextMessage'), 'not settled yet: kept as it is');
  f.taskStatus = 'completed'; f.extracted = 1; f.clock += 1001; await Promise.all(f.sync.pump()); await Promise.all(f.sync.pump());
  const settled = answer();
  assert.deepEqual([settled.status, settled.memoriesExtracted, typeof settled.sessionId, typeof settled.taskId], ['completed', 1, 'string', 'string']);
  for (const key of ['tokenUsage', 'extractionCounts', 'message', 'retention', 'taskStatus', 'nextMessage', 'nextPollAt']) assert.equal(Object.hasOwn(settled, key), false, key);
  assert.equal(settled.archivedHistory.length, 1);
  const archived = JSON.parse(readFileSync(join(`${f.file}.archive`, settled.archivedHistory[0]), 'utf8'));
  assert.deepEqual([archived.id, archived.sessionId, archived.fields.tokenUsage.total.total_tokens], [settled.id, f.sid, 23]);
  assert.equal(memorySyncHealth(f.store.state).evidenceExtracted, 1);
  assert.equal(deletionRecord(f.store, f.session()).bindings.length, 1, 'deletion still finds its remote session');
  const writes = f.store.persistence.writes; await Promise.all(f.sync.pump()); assert.equal(f.store.persistence.writes, writes, 'once');
});

test('a withdrawn delivery whose DELETE refreshed its directory (semantic_status complete) no longer hides that directory\'s L0/L1; the directories above it stay hidden (MEM-6)', async t => {
  for (const semantic of ['complete', 'deferred', null]) {
    const f = await fixture(t); f.deleteSemantic = semantic;
    f.delivery('resource', 'First delivered report.'); f.delivery('kept', 'Second delivered report.');
    await Promise.all(f.sync.pump()); await Promise.all(f.sync.pump());
    assert.deepEqual(f.records().map(row => row.resourceIndex.status), ['completed', 'completed'], String(semantic));
    const namespace = f.store.memoryService.remote(f.pid).namespace, directory = `${namespace}/rna-execution-evidence/${f.sid}`;
    assert.equal(f.store.memoryService.evidenceResourceVisible(f.pid, `${directory}/.overview.md`), true);
    revokeResource(f, true); await Promise.all(f.sync.pump());
    const index = f.records()[0].resourceIndex;
    assert.equal(index.status, 'deleted', String(semantic));
    assert.deepEqual(index.cleanup.receipt.semantic ?? null, semantic ? { rootUri: directory, status: semantic } : null, 'the receipt is kept');
    // OpenViking regenerated this directory's summary with the deletion as its change: its L0/L1 hold only the kept report.
    assert.equal(f.store.memoryService.evidenceResourceVisible(f.pid, `${directory}/.overview.md`), semantic === 'complete', String(semantic));
    assert.equal(f.store.memoryService.evidenceResourceVisible(f.pid, `${directory}/.abstract.md`), semantic === 'complete', String(semantic));
    // Ancestors were refreshed best-effort at most: still hidden, and the deleted file itself never comes back.
    for (const uri of [`${namespace}/rna-execution-evidence/.overview.md`, `${namespace}/.abstract.md`, index.uri]) assert.equal(f.store.memoryService.evidenceResourceVisible(f.pid, uri), false, `${semantic} ${uri}`);
  }
});
