import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { MemorySync, memorySyncHealth } from '../memory-sync.mjs';
import { checkpointRetention } from '../memory-checkpoints.mjs';
import { deletionRecord } from '../session-deletion.mjs';
import { acknowledgeMemoryIssues, reextractPlan, applyReextract } from '../memory-sync-routes.mjs';
import { projectMemorySyncStatus } from '../memory-sync-status.mjs';

// HTTP protocol fixture, not a real semantic model. Native retention semantics
// are inspected separately against OpenViking and verified in the opt-in QA.
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-checkpoint-'));
  const f = { calls: [], sessions: new Map(), tasks: new Map(), taskCompleted: false, retainOnly: false, dropCommit: false, commits: 0, clock: Date.now() };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'); let raw = ''; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : null;
    f.calls.push({ path: url.pathname, method: req.method, body });
    const send = result => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', result })); };
    if (url.pathname.endsWith('/system/status')) return send({ initialized: true, user: 'fixture' });
    if (url.pathname === '/api/v1/sessions') { f.sessions.set(body.session_id, { all: [], live: [], archives: [] }); return send({ session_id: body.session_id }); }
    const id = url.pathname.split('/')[4], session = f.sessions.get(id);
    if (url.pathname.endsWith('/messages/batch')) {
      session.all.push(...body.messages); session.live.push(...body.messages);
      f.afterAppend?.(); return send({ added: body.messages.length });
    }
    // Read-only commit task listing (B3 reconciliation): every task the fixture created for that remote session.
    if (url.pathname === '/api/v1/tasks') {
      const resource = url.searchParams.get('resource_id');
      return send({ items: [...f.tasks].filter(([, task]) => task.sessionId === resource).map(([taskId, task]) => ({ task_id: taskId, task_type: 'session_commit', resource_id: task.sessionId, status: f.taskCompleted ? 'completed' : 'running' })), has_more: false, next_cursor: null });
    }
    if (url.pathname.endsWith('/commit')) {
      f.commits++;
      if (f.dropCommit) return req.socket.destroy();
      if (f.holdCommit) await f.holdCommit;
      if (body.retention_mode) {
        assert.deepEqual(body, { keep_recent_count: 0, ...checkpointRetention });
        if (f.retainOnly) return send({ status: 'skipped', archived: false, task_id: null, reason: 'all_within_keep_window', estimated_active_tokens: 100, budget_exceeded: false });
        // Explicit fixture contract: retain the original anchor and final raw
        // assistant step. This does not pretend to run OpenViking's planner.
        const anchor = session.live.find(row => row.role === 'user');
        session.archives.push(session.live.slice(0, -1)); session.live = [anchor, session.live.at(-1)].filter(Boolean);
      } else { assert.deepEqual(body, { keep_recent_count: 0 }); session.archives.push([...session.live]); session.live = []; }
      const taskId = `fixture-task-${f.commits}`; f.tasks.set(taskId, { sessionId: id, total: 100 + f.commits });
      // Accepted, then the response is lost.
      if (f.dropCommitReceipt) return req.socket.destroy();
      return send({ status: 'accepted', archived: true, task_id: taskId, estimated_active_tokens: body.retention_mode ? 80 : 0, budget_exceeded: false });
    }
    if (url.pathname.includes('/tasks/')) {
      const task = f.tasks.get(url.pathname.split('/').at(-1));
      return send({ status: f.taskFailed ? 'failed' : f.taskCompleted ? 'completed' : 'running', result: f.taskCompleted || f.taskFailed ? { session_id: task.sessionId, memories_extracted: {}, token_usage: { total: { total_tokens: task.total } } } : null });
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.file = join(directory, 'state.json'); f.store = new Store(f.file);
  f.store.configurationService.update({ memory: { endpoint: `http://127.0.0.1:${server.address().port}` } });
  const result = f.store.createProject({ name: 'Checkpoint fixture' }); f.projectId = result.project.id; f.sessionId = result.session.id;
  f.store.message(f.sessionId, { text: 'The fixture project must preserve keyboard navigation and visible focus.' });
  f.session = () => f.store.state.sessions.find(row => row.id === f.sessionId);
  f.turnId = f.session().activeTurnId; f.turn = () => f.session().turns.find(row => row.id === f.turnId);
  f.store.mutate(state => { const turn = state.sessions.find(row => row.id === f.sessionId).turns.find(row => row.id === f.turnId); turn.modelConfig = { execution: 'rna' }; turn.startedAt = new Date(Date.now() - 1800001).toISOString(); });
  let item = 0;
  f.assistant = (text = 'Confirmed fixture progress. '.repeat(30), streaming = false) => f.store.mutate(state => state.sessions.find(row => row.id === f.sessionId).items.push({ id: `assistant-${++item}`, turnId: f.turnId, kind: 'assistant', text, streaming }));
  f.enqueue = () => f.store.checkpointRuntimeMemory(f.sessionId, f.turnId);
  f.sync = new MemorySync(f.store, { now: () => f.clock, pollMs: 10 });
  f.step = async () => { f.clock += 100; await Promise.all(f.sync.pump()); };
  t.after(async () => { await f.sync.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  return f;
}

test('stable checkpoint requires elapsed meaningful content or message count and never backfills legacy outboxes', async t => {
  const f = await fixture(t);
  f.assistant('partial '.repeat(200), true); f.enqueue(); assert.equal(f.turn().memoryCheckpoints, undefined);
  f.assistant(); f.enqueue(); assert.equal(f.turn().memoryCheckpoints.length, 1);
  assert.equal(f.turn().memoryCheckpoints[0].boundary, 'settled_slice');
  assert.equal(f.turn().memoryCheckpoints[0].sourceRefs.length, 2);
  const writes = f.store.persistence.writes; f.enqueue(); assert.equal(f.store.persistence.writes, writes);
  f.assistant('short'); f.enqueue(); assert.equal(f.turn().memoryCheckpoints.length, 1);
  for (let n = 0; n < 39; n++) f.assistant('stable message');
  f.enqueue(); assert.equal(f.turn().memoryCheckpoints.length, 2);
  f.store.mutate(state => { state.sessions.find(row => row.id === f.sessionId).turns.find(row => row.id === f.turnId).memoryWrite = { status: 'completed', sourceHash: 'legacy' }; });
  const legacy = structuredClone(f.turn().memoryWrite); f.assistant('new'.repeat(500)); f.enqueue();
  assert.deepEqual(f.turn().memoryWrite, legacy); assert.equal(f.turn().memoryCheckpoints.length, 2);
});

test('two segments append only new text to one peer session and final commit reuses retained original user anchor', async t => {
  const f = await fixture(t); f.assistant(); f.assistant(); f.enqueue(); await f.step();
  const first = f.turn().memoryCheckpoints[0]; assert.equal(first.status, 'polling');
  f.assistant('Final confirmed fixture completion.'); f.store.finishRuntimeTurn(f.sessionId, f.turnId);
  assert.equal(f.turn().memoryWrite, undefined); assert.equal(f.turn().memoryCheckpoints.length, 2);
  await f.step(); assert.equal(f.commits, 1, 'running extraction serializes later writes');
  f.taskCompleted = true; await f.step(); await f.step(); await f.step();
  const records = f.turn().memoryCheckpoints; assert.deepEqual(records.map(row => row.status), ['completed', 'completed']);
  assert.equal(records[0].sessionId, records[1].sessionId); assert.equal(f.sessions.size, 1); assert.equal(f.commits, 2);
  // The incremental checkpoints' turn-budget retention is what reads working memory: their session is the one that has it.
  assert.deepEqual(f.calls.filter(row => row.path === '/api/v1/sessions').map(row => row.body.memory_policy.working_memory), [{ enabled: true }]);
  const [remote] = f.sessions.values(); assert.equal(remote.all.length, 4); assert.equal(remote.all.filter(row => row.role === 'user').length, 1);
  assert.ok(remote.all.filter(row => row.role === 'assistant').every(row => row.peer_id === undefined));
  assert.equal(remote.all[0].peer_id, `forge-${f.projectId}`);
  assert.equal(remote.archives[0][0].source_message_ids[0], remote.archives[1][0].source_message_ids[0]);
  assert.equal(remote.live.length, 0);
  assert.equal(records.reduce((sum, row) => sum + row.tokenUsage.total.total_tokens, 0), 203);
  const health = memorySyncHealth(f.store.state); assert.equal(health.completedTurns, 1); assert.equal(health.checkpoints, 2); assert.equal(health.total, 2);
});

test('retained window receipt is not extraction success and final empty-source checkpoint flushes remote tail', async t => {
  const f = await fixture(t); f.retainOnly = true; f.assistant(); f.enqueue(); await f.step();
  assert.equal(f.turn().memoryCheckpoints[0].status, 'retained'); assert.equal(f.turn().memoryCheckpoints[0].memoriesExtracted, undefined);
  f.store.finishRuntimeTurn(f.sessionId, f.turnId); assert.equal(f.turn().memoryCheckpoints[1].sourceRefs.length, 0);
  f.taskCompleted = true; await f.step(); await f.step();
  assert.equal(f.turn().memoryCheckpoints[1].status, 'completed'); assert.equal(f.commits, 2);
  assert.equal(f.calls.filter(row => row.path.endsWith('/messages/batch')).length, 1);
  assert.equal(f.sessions.size, 1); assert.equal(memorySyncHealth(f.store.state).completedTurns, 1); assert.equal(memorySyncHealth(f.store.state).retainedPending, 0);
});

test('unknown commit receipt blocks later segments and cannot be financed by another pump or final completion', async t => {
  const f = await fixture(t); f.dropCommit = true; f.assistant(); f.enqueue(); await f.step();
  assert.equal(f.turn().memoryCheckpoints[0].status, 'uncertain');
  f.assistant('Later completion remains queued.'); f.store.finishRuntimeTurn(f.sessionId, f.turnId);
  const calls = f.calls.length; for (let n = 0; n < 20; n++) await f.step();
  assert.equal(f.calls.length, calls); assert.equal(f.commits, 1); assert.equal(f.turn().memoryCheckpoints[1].status, 'pending');
  const record = deletionRecord(f.store, f.session());
  assert.equal(record.bindings.length, 1); assert.equal(record.bindings[0].pendingRequests[0].status, 'uncertain');
});

test('frozen source mutation before append or between append and commit stops without substituting changed text', async t => {
  for (const stage of ['before', 'after']) {
    const f = await fixture(t); f.assistant(); f.enqueue();
    const change = () => f.store.mutate(state => { state.sessions.find(row => row.id === f.sessionId).items.find(row => row.kind === 'assistant').text += ' changed'; });
    if (stage === 'before') change(); else f.afterAppend = change;
    // Changed before anything was sent: nothing reached the service. Changed after the upload: those messages are
    // never committed, so the record is abandoned (a settled outcome, not an unknown one).
    await f.step(); assert.equal(f.turn().memoryCheckpoints[0].status, stage === 'before' ? 'uncertain' : 'abandoned'); assert.equal(f.turn().memoryCheckpoints[0].code, 'MEMORY_SOURCE_CHANGED');
    assert.equal(f.commits, 0); assert.equal(f.calls.filter(row => row.path.endsWith('/messages/batch')).length, stage === 'before' ? 0 : 1);
    const health = memorySyncHealth(f.store.state); assert.equal(health.unresolved, 0); assert.equal(health.settledLoss, 1); assert.equal(health.healthy, true);
    // The rest of the turn shares that settled outcome (MEM-10, B6): it is never left pending, so the turn never shows as syncing forever.
    f.assistant('Final words of the turn.'); f.store.finishRuntimeTurn(f.sessionId, f.turnId);
    const [changed, final] = f.turn().memoryCheckpoints; assert.equal(final.status, 'pending');
    await f.step(); await f.step();
    assert.deepEqual([f.turn().memoryCheckpoints[1].status, f.turn().memoryCheckpoints[1].blockedBy, f.turn().memoryCheckpoints[1].code], ['failed', changed.id, 'MEMORY_SOURCE_CHANGED'], stage);
    assert.equal(f.commits, 0, stage);
    f.store.mutate(state => acknowledgeMemoryIssues(state, f.projectId, [changed, final].map(row => ({ sessionId: f.sessionId, turnId: f.turnId, checkpointId: row.id }))));
    const row = projectMemorySyncStatus(f.store.state, f.store.state.projects.find(project => project.id === f.projectId)).sessions[0];
    assert.notEqual(row.status, 'syncing', stage); assert.equal(row.pending, 0, stage); assert.equal(row.attention, 0, stage);
  }
});

test('deletion captures checkpoint-only binding and conservative legacy unknown-write protection', async t => {
  const f = await fixture(t); f.assistant(); f.enqueue(); await f.step();
  f.store.mutate(state => {
    const binding = state.projects.find(row => row.id === f.projectId).memorySessions[0]; delete binding.sourceSessionId; delete binding.pendingRequests;
    state.sessions.find(row => row.id === f.sessionId).turns.find(row => row.id === f.turnId).memoryCheckpoints[0].status = 'uncertain';
  });
  const record = deletionRecord(f.store, f.session()); assert.equal(record.bindings.length, 1); assert.equal(record.bindings[0].cleanupOutcomeUnknown, true);
});

test('autoStore revocation prevents checkpoint upload but still settles actual dispatched task usage', async t => {
  const f = await fixture(t); f.assistant(); f.enqueue(); f.store.configurationService.update({ memory: { autoStore: false } });
  await f.step(); assert.equal(f.calls.length, 0);
  f.store.configurationService.update({ memory: { autoStore: true } }); await f.step();
  f.store.configurationService.update({ memory: { autoStore: false } }); f.taskCompleted = true; await f.step();
  assert.equal(f.turn().memoryCheckpoints[0].status, 'completed'); assert.equal(f.turn().memoryCheckpoints[0].tokenUsage.total.total_tokens, 101);
});

test('failed, cancelled and truncated assistant messages are not checkpoint sources', async t => {
  const f = await fixture(t);
  for (const stopReason of ['error', 'aborted', 'length']) {
    f.assistant('Incomplete response '.repeat(100));
    f.store.mutate(state => { state.sessions.find(row => row.id === f.sessionId).items.at(-1).stopReason = stopReason; });
  }
  f.enqueue(); assert.equal(f.turn().memoryCheckpoints, undefined);
  f.assistant('Settled response '.repeat(100)); f.enqueue();
  assert.equal(f.turn().memoryCheckpoints[0].sourceRefs.length, 2);
  await f.step(); assert.equal([...f.sessions.values()][0].all.length, 2);
});

test('failed extraction retains actual usage, is never committed again, and does not hold the rest of the turn (MEM-10)', async t => {
  const f = await fixture(t); f.assistant(); f.enqueue(); await f.step(); f.taskFailed = true; await f.step();
  assert.equal(f.turn().memoryCheckpoints[0].status, 'failed'); assert.equal(f.turn().memoryCheckpoints[0].tokenUsage.total.total_tokens, 101);
  // The archive was committed, so the final segment goes on in the same remote session; the failed one is not re-sent.
  f.store.finishRuntimeTurn(f.sessionId, f.turnId); await f.step();
  const [first, final] = f.turn().memoryCheckpoints;
  assert.equal(f.commits, 2); assert.equal(final.status, 'polling'); assert.equal(final.sessionId, first.sessionId); assert.equal(f.sessions.size, 1);
  assert.equal(first.status, 'failed'); assert.equal(f.calls.filter(row => row.path.endsWith('/messages/batch')).length, 1, 'the failed segment is not uploaded again');
  // A failed extraction is a settled loss: listed, but it no longer degrades health.
  const health = memorySyncHealth(f.store.state);
  assert.equal(health.healthy, true); assert.equal(health.unresolved, 0); assert.equal(health.settledLoss, 1); assert.equal(health.settledLosses[0].code, 'MEMORY_EXTRACTION_FAILED');
});

test('a rejected earlier segment ends the pending rest of its turn with the same code instead of leaving it pending (MEM-10)', async t => {
  const f = await fixture(t); f.assistant(); f.enqueue();
  f.store.mutate(state => Object.assign(state.sessions.find(row => row.id === f.sessionId).turns.find(row => row.id === f.turnId).memoryCheckpoints[0], { status: 'failed', code: 'MEMORY_WRITE_REJECTED' }));
  f.assistant('Later completion.'); f.store.finishRuntimeTurn(f.sessionId, f.turnId);
  const calls = f.calls.length; await f.step(); await f.step();
  const [first, final] = f.turn().memoryCheckpoints;
  assert.equal(f.calls.length, calls, 'nothing is sent'); assert.equal(final.status, 'failed'); assert.equal(final.code, 'MEMORY_WRITE_REJECTED'); assert.equal(final.blockedBy, first.id);
  const health = memorySyncHealth(f.store.state); assert.equal(health.healthy, true); assert.equal(health.settledLoss, 2);
  // History reads newest first (A2): the blocked final settled after the rejected segment.
  assert.equal(health.settledLosses.find(row => row.checkpointId === final.id).blockedBy, first.id);
});

test('an unknown earlier segment still holds the rest of its turn', async t => {
  const f = await fixture(t); f.assistant(); f.enqueue();
  // A commit sent just now whose receipt was lost: the server may still be accepting it, so nothing is looked up yet (B3).
  f.store.mutate(state => Object.assign(state.sessions.find(row => row.id === f.sessionId).turns.find(row => row.id === f.turnId).memoryCheckpoints[0], { status: 'uncertain', code: 'MEMORY_WRITE_OUTCOME_UNKNOWN', stage: 'committing', stageAt: new Date(f.clock).toISOString(), sessionId: 'rna-remote', nextMessage: 1, batchStart: 0, batchCount: 1 }));
  f.assistant('Later completion.'); f.store.finishRuntimeTurn(f.sessionId, f.turnId); await f.step(); await f.step();
  assert.equal(f.turn().memoryCheckpoints[1].status, 'pending'); assert.equal(f.calls.length, 0);
  assert.equal(f.turn().memoryCheckpoints[0].reconcile.status, 'waiting');
  const health = memorySyncHealth(f.store.state); assert.equal(health.healthy, false); assert.equal(health.unresolved, 1);
});

test('new ordinary final outbox freezes stable sources while existing legacy rows remain untouched', async t => {
  const f = await fixture(t); f.assistant('Incomplete text');
  f.store.mutate(state => { state.sessions.find(row => row.id === f.sessionId).items.at(-1).stopReason = 'error'; });
  f.assistant('Confirmed final answer'); f.store.finishRuntimeTurn(f.sessionId, f.turnId);
  assert.equal(f.turn().memoryWrite.schemaVersion, 1); assert.equal(f.turn().memoryWrite.sourceRefs.length, 2);
  await f.step(); assert.equal([...f.sessions.values()][0].all.length, 2);
});

test('identity IO cannot open a source-mutation window before append or commit dispatch', async t => {
  for (const stage of ['append', 'commit']) {
    const f = await fixture(t); f.assistant(); f.enqueue();
    const original = f.store.memoryService.identity.bind(f.store.memoryService); let fresh = 0;
    f.store.memoryService.identity = async (remote, input) => {
      const result = await original(remote, input);
      if (input?.fresh && ++fresh === (stage === 'append' ? 1 : 2)) f.store.mutate(state => { state.sessions.find(row => row.id === f.sessionId).items.find(row => row.kind === 'assistant').text += ' changed during identity IO'; });
      return result;
    };
    await f.step(); assert.equal(f.turn().memoryCheckpoints[0].code, 'MEMORY_SOURCE_CHANGED'); assert.equal(f.commits, 0);
    assert.equal(f.calls.filter(row => row.path.endsWith('/messages/batch')).length, stage === 'append' ? 0 : 1);
  }
});

test('re-extracting a failed final also uploads the retained segment its commit archived, user anchor included, and only then counts it as extracted (B2)', async t => {
  const f = await fixture(t); f.retainOnly = true; f.assistant(); f.enqueue(); await f.step();
  const retained = f.turn().memoryCheckpoints[0]; assert.equal(retained.status, 'retained');
  f.retainOnly = false; f.taskFailed = true; f.assistant('Final short answer.'); f.store.finishRuntimeTurn(f.sessionId, f.turnId);
  await f.step(); await f.step();
  const final = f.turn().memoryCheckpoints[1]; assert.deepEqual([final.status, final.code], ['failed', 'MEMORY_EXTRACTION_FAILED']);
  assert.equal(f.sessions.get(final.sessionId).archives.at(-1).length, 3, 'the failed commit archived the retained segment and the user anchor too');
  const ref = { sessionId: f.sessionId, turnId: f.turnId, checkpointId: final.id };
  const plan = reextractPlan(f.store.state, f.projectId, ref);
  assert.deepEqual(plan.messages.map(row => row.role), ['user', 'assistant', 'assistant']); assert.deepEqual(plan.covers.map(row => row.id), [retained.id]);
  const row = () => projectMemorySyncStatus(f.store.state, f.store.state.projects.find(project => project.id === f.projectId)).sessions[0];
  // A settled loss is history at once (A2); re-extraction stays an optional paid action there.
  assert.equal(row().issues.length, 0); assert.deepEqual(row().history.find(issue => issue.checkpointId === final.id).actions, ['reextract']);
  f.store.mutate(state => { const current = reextractPlan(state, f.projectId, ref); applyReextract(current.write, { connectionFingerprint: f.store.memoryService.connectionFingerprint(f.projectId), covers: current.covers }); });
  assert.equal(f.turn().memoryCheckpoints[0].coveredBy, final.id);
  assert.equal(memorySyncHealth(f.store.state).retainedPending, 1, 'not extracted until the re-extraction completes');
  f.taskFailed = false; f.taskCompleted = true; for (let n = 0; n < 4; n++) await f.step();
  const done = f.turn().memoryCheckpoints[1]; assert.equal(done.status, 'completed'); assert.notEqual(done.sessionId, final.sessionId);
  const fresh = f.sessions.get(done.sessionId).all;
  assert.deepEqual(fresh.map(row => row.role), ['user', 'assistant', 'assistant']); assert.equal(fresh[0].peer_id, `forge-${f.projectId}`);
  assert.equal(fresh.at(-1).content, 'Final short answer.');
  assert.equal(f.turn().memoryCheckpoints[0].sourceHash, retained.sourceHash, 'each segment keeps its own frozen hash');
  const health = memorySyncHealth(f.store.state); assert.equal(health.retainedPending, 0); assert.equal(health.settledLoss, 0); assert.equal(health.completedTurns, 1);
});

test('a covering re-extraction whose remote session was started with only its own messages (rollback mid-way) goes on with those, never a shifted slice (B2)', async t => {
  const f = await fixture(t); f.retainOnly = true; f.assistant(); f.enqueue(); await f.step();
  f.retainOnly = false; f.taskFailed = true; f.assistant('Final short answer.'); f.store.finishRuntimeTurn(f.sessionId, f.turnId); await f.step(); await f.step();
  const final = f.turn().memoryCheckpoints[1], ref = { sessionId: f.sessionId, turnId: f.turnId, checkpointId: final.id };
  f.store.mutate(state => { const current = reextractPlan(state, f.projectId, ref); applyReextract(current.write, { connectionFingerprint: f.store.memoryService.connectionFingerprint(f.projectId), covers: current.covers }); });
  // What an earlier version left: a fresh session started with the record's own single message, already uploaded.
  const binding = await f.store.memoryService.createSession(f.projectId, { sourceSessionId: f.sessionId });
  f.store.mutate(state => Object.assign(state.sessions.find(row => row.id === f.sessionId).turns.find(row => row.id === f.turnId).memoryCheckpoints[1], { sessionId: binding.sessionId, status: 'ready', nextMessage: 1, messageCount: 1 }));
  const uploads = f.calls.filter(row => row.path.endsWith('/messages/batch')).length;
  f.taskFailed = false; f.taskCompleted = true; for (let n = 0; n < 3; n++) await f.step();
  assert.equal(f.calls.filter(row => row.path.endsWith('/messages/batch')).length, uploads, 'nothing of another slice is uploaded');
  assert.equal(f.turn().memoryCheckpoints[1].status, 'completed'); assert.equal(f.turn().memoryCheckpoints[1].sessionId, binding.sessionId);
});

/** A turn whose single final segment is uploaded and committed; `lose` decides how the commit's receipt is lost. */
async function lostCommit(t, lose, { incremental = false } = {}) {
  const f = await fixture(t); f.assistant();
  if (incremental) f.enqueue(); else f.store.finishRuntimeTurn(f.sessionId, f.turnId);
  f[lose] = true; await f.step(); f[lose] = false;
  return f;
}
const settleWindow = f => { f.clock += 300001; };
// A turn with one segment writes it as memoryWrite; one that checkpointed first writes checkpoints.
const firstRecord = f => f.turn().memoryCheckpoints?.[0] ?? f.turn().memoryWrite;

test('a commit accepted without a receipt is found read-only and polled to its outcome; nothing is uploaded or committed again (B3)', async t => {
  const f = await lostCommit(t, 'dropCommitReceipt'), record = () => firstRecord(f);
  assert.deepEqual([record().status, record().code, record().stage], ['uncertain', 'MEMORY_WRITE_OUTCOME_UNKNOWN', 'committing']);
  await f.step(); assert.equal(record().reconcile.status, 'waiting', 'the server may still be accepting it');
  assert.equal(f.calls.filter(row => row.path === '/api/v1/tasks').length, 0);
  settleWindow(f); await f.step();
  assert.deepEqual([record().status, record().taskId, record().reconcile.result], ['polling', 'fixture-task-1', 'commit_found']);
  f.taskCompleted = true; await f.step();
  assert.equal(record().status, 'completed'); assert.equal(f.commits, 1); assert.equal(f.calls.filter(row => row.path.endsWith('/messages/batch')).length, 1);
  assert.equal(memorySyncHealth(f.store.state).healthy, true);
});

test('a commit that never archived is proven so by a complete task listing: an incremental stays retained for the next commit, a final is a known loss that can be extracted again (B3)', async t => {
  const g = await lostCommit(t, 'dropCommit', { incremental: true });
  assert.equal(g.turn().memoryCheckpoints[0].status, 'uncertain');
  g.assistant('Final words.'); g.store.finishRuntimeTurn(g.sessionId, g.turnId);
  settleWindow(g); await g.step();
  assert.deepEqual([g.turn().memoryCheckpoints[0].status, g.turn().memoryCheckpoints[0].reconcile.result], ['retained', 'commit_not_found']);
  g.taskCompleted = true; for (let n = 0; n < 3; n++) await g.step();
  // The final commit in the same remote session archives the retained messages with its own.
  assert.equal(g.turn().memoryCheckpoints[1].status, 'completed'); assert.equal(g.sessions.size, 1);
  assert.deepEqual([...g.sessions.values()][0].archives.at(-1).map(row => row.role), ['user', 'assistant', 'assistant']);
  assert.equal(memorySyncHealth(g.store.state).healthy, true); assert.equal(memorySyncHealth(g.store.state).completedTurns, 1);

  const f = await lostCommit(t, 'dropCommit'), record = () => firstRecord(f);
  settleWindow(f); await f.step();
  assert.deepEqual([record().status, record().code, record().reconcile.result], ['failed', 'MEMORY_COMMIT_NOT_FOUND', 'commit_not_found']);
  const health = memorySyncHealth(f.store.state); assert.equal(health.healthy, true); assert.equal(health.settledLoss, 1);
  const issue = projectMemorySyncStatus(f.store.state, f.store.state.projects.find(project => project.id === f.projectId)).sessions[0].history[0];
  assert.deepEqual(issue.actions, ['reextract']); assert.match(issue.message, /没有完成归档/);
  assert.equal(f.commits, 1, 'nothing is committed again on its own');
});

test('an uncertain write no check can settle is listed for the user instead of keeping health red; creating and uploading settle locally (B3)', async t => {
  // A legacy record without the dispatch time: an absent commit task proves nothing, so it is settled as undeterminable.
  const f = await lostCommit(t, 'dropCommit'), record = () => firstRecord(f);
  f.store.mutate(state => { const turn = state.sessions.find(row => row.id === f.sessionId).turns.find(row => row.id === f.turnId); delete (turn.memoryCheckpoints?.[0] ?? turn.memoryWrite).stageAt; });
  await f.step();
  assert.deepEqual([record().status, record().reconcile.status, record().reconcile.result], ['uncertain', 'undeterminable', 'commit_not_provable']);
  assert.equal(memorySyncHealth(f.store.state).healthy, true);
  const ref = { sessionId: f.sessionId, turnId: f.turnId };
  f.store.mutate(state => assert.equal(acknowledgeMemoryIssues(state, f.projectId, [ref]), 1));
  // The compatibility acknowledgement only stamps it: it was history already (A2).
  assert.equal(memorySyncHealth(f.store.state).settledLoss, 1); assert.equal(memorySyncHealth(f.store.state).acknowledged, 1);

  // Restarted while creating its remote session: nothing of it was sent, so it starts again in a fresh one.
  const g = await fixture(t); g.assistant(); g.store.finishRuntimeTurn(g.sessionId, g.turnId);
  g.store.mutate(state => Object.assign(state.sessions.find(row => row.id === g.sessionId).turns.find(row => row.id === g.turnId).memoryWrite, { status: 'creating', sessionId: 'rna-never-confirmed', stageAt: new Date(g.clock).toISOString() }));
  await g.step(); assert.equal(g.turn().memoryWrite.stage, 'creating');
  g.taskCompleted = true; for (let n = 0; n < 4; n++) await g.step();
  const restarted = g.turn().memoryWrite;
  assert.equal(restarted.status, 'completed'); assert.equal(restarted.reconcile.result, 'restarted_in_fresh_session'); assert.notEqual(restarted.sessionId, 'rna-never-confirmed');
  assert.equal(g.commits, 1);
});

test('closing the sync never cuts a commit already sent: its receipt is awaited and recorded instead of becoming an unknown outcome (B3)', async t => {
  const f = await fixture(t); f.assistant(); f.store.finishRuntimeTurn(f.sessionId, f.turnId);
  let release; f.holdCommit = new Promise(resolve => { release = resolve; });
  const committing = new Promise(resolve => { const id = setInterval(() => { if (f.turn().memoryWrite?.status === 'committing') { clearInterval(id); resolve(); } }, 5); });
  const jobs = f.sync.pump(); await committing;
  const closed = f.sync.close(); setTimeout(release, 50);
  await closed; await Promise.all(jobs);
  const record = f.turn().memoryWrite;
  assert.deepEqual([record.status, record.taskId], ['polling', 'fixture-task-1']); assert.equal(memorySyncHealth(f.store.state).unresolved, 0);
});

test('unbound scratch sessions cannot fail foreground execution by attempting project memory enrollment', async t => {
  const f = await fixture(t); f.assistant();
  f.store.mutate(state => { delete state.sessions.find(row => row.id === f.sessionId).projectId; });
  assert.doesNotThrow(() => f.enqueue()); assert.equal(f.turn().memoryCheckpoints, undefined); assert.equal(f.calls.length, 0);
});
