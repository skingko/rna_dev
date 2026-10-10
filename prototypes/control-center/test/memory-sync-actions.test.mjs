import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../server.mjs';
import { MemorySync, memorySyncHealth } from '../memory-sync.mjs';

// MEM-4, A2: settled losses are history without any click; the optional action on a history row is extracting a
// failed archive again (paid, two steps) in a fresh remote session. Acknowledge stays only for compatibility.
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-memory-actions-'));
  const f = { sessions: new Map(), calls: [], taskStatus: 'running', clock: 1000 };
  const viking = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const url = new URL(req.url, 'http://fixture'), body = raw ? JSON.parse(raw) : null; f.calls.push(url.pathname);
    const send = result => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', result })); };
    if (url.pathname === '/api/v1/system/status') return send({ initialized: true, user: 'fixture' });
    if (url.pathname === '/api/v1/sessions') { f.sessions.set(body.session_id, []); return send({ session_id: body.session_id }); }
    const id = url.pathname.split('/')[4];
    if (url.pathname.endsWith('/messages/batch')) { f.sessions.get(id).push(...body.messages); return send({ added: body.messages.length }); }
    if (url.pathname.endsWith('/commit')) return send({ status: 'accepted', archived: true, task_id: `task-${id}` });
    if (url.pathname.includes('/tasks/')) return send({ status: f.taskStatus, result: { memories_extracted: { events: 1 }, token_usage: { total: { total_tokens: 9 } } } });
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => viking.listen(0, '127.0.0.1', resolve));
  const app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  app.store.configurationService.update({ memory: { endpoint: `http://127.0.0.1:${viking.address().port}` } });
  const { project, session } = app.store.createProject({ name: 'Memory actions' });
  f.app = app; f.project = project; f.session = session;
  f.sync = new MemorySync(app.store, { now: () => f.clock, pollMs: 1000 });
  f.step = async () => { f.clock += 1001; await Promise.all(f.sync.pump()); };
  f.turn = turnId => app.store.state.sessions.find(row => row.id === session.id).turns.find(row => row.id === turnId);
  // A real completed turn enrolled by the Store, as a foreground turn would be.
  f.finish = text => {
    app.store.message(session.id, { text });
    const turnId = app.store.state.sessions.find(row => row.id === session.id).activeTurnId;
    app.store.mutate(state => { const s = state.sessions.find(row => row.id === session.id), turn = s.turns.find(row => row.id === turnId); turn.modelConfig = { execution: 'rna' }; s.items.push({ id: `answer-${turnId}`, turnId, kind: 'assistant', text: `已记下：${text}` }); });
    app.store.finishRuntimeTurn(session.id, turnId); return turnId;
  };
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2/projects/${project.id}/memory-sync`;
  f.post = async (action, body) => { const response = await fetch(`${base}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  f.status = async () => (await fetch(base)).json();
  t.after(async () => { await f.sync.close(); await app.close(); viking.closeAllConnections(); await new Promise(resolve => viking.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  return f;
}

test('a failed extraction is extracted again only after a paid two-step confirmation, in a fresh remote session', async t => {
  const f = await fixture(t), turnId = f.finish('设计约束：颜色之外必须有文字和形状。');
  await f.step(); f.taskStatus = 'failed'; await f.step();
  const failed = f.turn(turnId).memoryWrite; assert.deepEqual([failed.status, failed.code], ['failed', 'MEMORY_EXTRACTION_FAILED']);
  const ref = { sessionId: f.session.id, turnId };
  let status = await f.status();
  assert.equal(status.status, 'synced'); assert.equal(status.attention, 0); assert.equal(status.settledLoss, 1); assert.equal(status.unresolved, 0); assert.notEqual(status.health, 'degraded');
  assert.deepEqual(status.sessions[0].issues, []);
  assert.deepEqual(status.sessions[0].history[0].actions, ['reextract']); assert.equal(status.sessions[0].history[0].resolution, 'settled');

  // Step one changes nothing and says what would be paid for.
  const revision = f.app.store.state.revision, calls = f.calls.length;
  const plan = await f.post('reextract', ref);
  assert.equal(plan.status, 200); assert.equal(plan.body.status, 'confirm_required'); assert.equal(plan.body.paid, true); assert.equal(plan.body.messages, 2); assert.ok(plan.body.characters > 0); assert.match(plan.body.confirm, /^[a-f0-9]{32}$/);
  assert.equal(f.app.store.state.revision, revision); assert.equal(f.calls.length, calls);
  assert.equal((await f.post('reextract', { ...ref, confirm: 'f'.repeat(32) })).body.code, 'memory_reextract_unconfirmed');

  const queued = await f.post('reextract', { ...ref, confirm: plan.body.confirm });
  assert.equal(queued.status, 200); assert.equal(queued.body.status, 'queued');
  const reset = f.turn(turnId).memoryWrite;
  assert.equal(reset.status, 'pending'); assert.equal(reset.sessionId, undefined); assert.equal(reset.taskId, undefined); assert.equal(reset.reextract.attempts, 1);
  assert.deepEqual([reset.reextract.previous[0].sessionId, reset.reextract.previous[0].code], [failed.sessionId, 'MEMORY_EXTRACTION_FAILED']);
  // The same confirmation never pays twice.
  assert.equal((await f.post('reextract', { ...ref, confirm: plan.body.confirm })).status, 409);

  f.taskStatus = 'completed'; await f.step(); await f.step();
  const done = f.turn(turnId).memoryWrite;
  assert.equal(done.status, 'completed'); assert.equal(done.memoriesExtracted, 1); assert.notEqual(done.sessionId, failed.sessionId);
  assert.equal(f.sessions.size, 2); assert.equal(f.sessions.get(done.sessionId).length, 2, 'the whole turn went to the fresh session');
  assert.ok(f.app.store.state.projects.find(row => row.id === f.project.id).memorySessions.some(row => row.sessionId === failed.sessionId), 'the first remote session stays bound for deletion');
  status = await f.status(); assert.equal(status.status, 'synced'); assert.equal(status.settledLoss, 0);
});

test('a settled loss is history without a click; the compatibility acknowledge only stamps it, and unresolved outcomes are refused (A2)', async t => {
  const f = await fixture(t), lost = f.finish('第一轮'), unknown = f.finish('第二轮');
  f.app.store.mutate(state => {
    const turns = state.sessions.find(row => row.id === f.session.id).turns;
    Object.assign(turns.find(row => row.id === lost).memoryWrite, { status: 'failed', code: 'MEMORY_WRITE_REJECTED', upstreamStatus: 400 });
    Object.assign(turns.find(row => row.id === unknown).memoryWrite, { status: 'uncertain', code: 'MEMORY_WRITE_OUTCOME_UNKNOWN' });
  });
  const lostRef = { sessionId: f.session.id, turnId: lost }, unknownRef = { sessionId: f.session.id, turnId: unknown };
  let status = await f.status();
  assert.equal(status.attention, 1); assert.equal(status.unresolved, 1); assert.equal(status.settledLoss, 1);
  assert.deepEqual(status.sessions[0].issues.map(row => [row.resolution, row.actions]), [['unresolved', []]]);
  assert.deepEqual(status.sessions[0].history.map(row => [row.resolution, row.code, row.actions, row.acknowledgedAt]), [['settled', 'MEMORY_WRITE_REJECTED', [], undefined]]);
  // All or nothing: one unresolved record refuses the whole request.
  const refused = await f.post('acknowledge', { records: [lostRef, unknownRef] });
  assert.equal(refused.status, 409); assert.equal(refused.body.code, 'memory_issue_unresolved');
  assert.equal(f.turn(lost).memoryWrite.acknowledgedAt, undefined);
  const done = await f.post('acknowledge', { records: [lostRef] });
  assert.equal(done.status, 200); assert.equal(done.body.acknowledged, 1); assert.equal(done.body.sync.attention, 1); assert.equal(done.body.sync.acknowledged, 1);
  status = await f.status();
  assert.deepEqual(status.sessions[0].issues.map(row => row.code), ['MEMORY_WRITE_OUTCOME_UNKNOWN']);
  assert.equal(status.sessions[0].history[0].code, 'MEMORY_WRITE_REJECTED'); assert.ok(status.sessions[0].history[0].acknowledgedAt); assert.deepEqual(status.sessions[0].history[0].actions, []);
  assert.equal((await f.post('acknowledge', { records: [lostRef] })).body.acknowledged, 0, 'acknowledging again changes nothing');
  // Health only ever looked at the unresolved one.
  assert.equal(memorySyncHealth(f.app.store.state).unresolved, 1);
  for (const body of [{}, { records: [] }, { records: [{ sessionId: f.session.id }] }, { records: [{ sessionId: f.session.id, turnId: lost, evidenceId: 'x' }] }, { records: [lostRef], extra: 1 }])
    assert.equal((await f.post('acknowledge', body)).body.code, 'memory_record_invalid', JSON.stringify(body));
  assert.equal((await f.post('acknowledge', { records: [{ sessionId: f.session.id, turnId: 'missing' }] })).status, 404);
  assert.equal((await f.post('reextract', lostRef)).body.code, 'memory_reextract_unavailable', 'only failed extractions can be redone');
});

test('a delivery index that was never written is history at once, acknowledged (compatibility) by its stage; refusals follow the interface language', async t => {
  const f = await fixture(t);
  f.app.store.mutate(state => {
    state.settings = { ...(state.settings ?? {}), interfaceLanguage: 'en' };
    const session = state.sessions.find(row => row.id === f.session.id);
    session.memoryEvidenceOutbox = [{ id: 'delivery', kind: 'evidence', sourceKind: 'autonomous_delivery', projectId: f.project.id, status: 'completed', taskId: 'paid', nextMessage: 1, sourceRefs: [{ itemId: 'delivered', sourceHash: 'a'.repeat(64) }],
      resourceIndex: { status: 'failed', code: 'MEMORY_SOURCE_CHANGED', uri: 'viking://resources/x.md' } }];
    // Its item is still there with other text (MEM-3 territory), so it is not settled as withdrawn: a loss to acknowledge.
    session.items.push({ id: 'delivered', kind: 'assistant', source: 'initiative', text: 'rewritten', simulated: false });
  });
  let status = await f.status();
  const issue = status.sessions[0].history[0];
  assert.equal(status.attention, 0); assert.deepEqual(status.sessions[0].issues, []);
  assert.deepEqual([issue.stage, issue.resolution, issue.actions], ['project_resource_index', 'settled', []]);
  assert.match(issue.message, /^This delivery was archived, but it changed before it was added to the project resource index/);
  const wrong = await f.post('acknowledge', { records: [{ sessionId: f.session.id, evidenceId: 'delivery' }] });
  assert.equal(wrong.status, 409); assert.equal(wrong.body.code, 'memory_issue_not_found'); assert.match(wrong.body.error, /^This record has no issue/);
  const done = await f.post('acknowledge', { records: [{ sessionId: f.session.id, evidenceId: 'delivery', stage: 'project_resource_index' }] });
  assert.equal(done.body.acknowledged, 1);
  status = await f.status(); assert.equal(status.attention, 0); assert.equal(status.sessions[0].history.length, 1);
});
