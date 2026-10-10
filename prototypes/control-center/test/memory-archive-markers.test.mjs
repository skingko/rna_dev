import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { MemorySync, memorySyncHealth, reextractCandidate } from '../memory-sync.mjs';

// B6: a polled commit task OpenViking no longer has (completed tasks are kept 24 h, failed ones 7 d: task_tracker) is
// settled from its archive's terminal markers, which never expire (session.py _archive_terminal_state; the pi client's
// getArchiveState, DESIGN.md "Runtime flow" 6): `.done` → completed, `.failed.json` → extraction failed. Only an
// archive with neither marker, or no archive recorded, stays "cannot tell" (MEMORY_TASK_EXPIRED).
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-memory-markers-'));
  const f = { clock: 1000, calls: [], files: new Map(), sizes: new Map(), taskGone: false, commitArchive: true, outage: false };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const url = new URL(req.url, 'http://fixture'), body = raw ? JSON.parse(raw) : null;
    f.calls.push({ method: req.method, path: url.pathname, uri: url.searchParams.get('uri') });
    const send = (result, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(status === 200 ? { status: 'ok', result } : { status: 'error', error: { code: status === 404 ? 'NOT_FOUND' : 'UNAVAILABLE', message: 'fixture' } })); };
    if (url.pathname === '/api/v1/system/status') return send({ initialized: true, user: 'alice' });
    // `outage`: the archive cannot be read (the task lookup still answers).
    if (f.outage && ['/api/v1/content/read', '/api/v1/fs/stat'].includes(url.pathname)) return send(null, 503);
    if (url.pathname === '/api/v1/sessions') return send({ session_id: body.session_id });
    const id = url.pathname.split('/')[4];
    if (url.pathname.endsWith('/messages/batch')) return send({ added: body.messages.length });
    if (url.pathname.endsWith('/commit')) { f.sessionId = id; f.archive = `viking://user/alice/sessions/${id}/history/archive_001`; return send({ status: 'accepted', archived: true, task_id: `task-${id}`, ...(f.commitArchive ? { archive_uri: f.archive } : {}) }); }
    if (url.pathname.startsWith('/api/v1/tasks/')) return f.taskGone ? send(null, 404) : send({ status: 'running', result: null });
    // Archive files (read-only): content/read for the markers, fs/stat for the memory diff.
    // `sizes`: a size fs/stat reports instead of the file's own.
    if (url.pathname === '/api/v1/content/read' || url.pathname === '/api/v1/fs/stat') { const uri = url.searchParams.get('uri'); return f.files.has(uri) ? send(url.pathname.endsWith('/stat') ? { uri, isDir: false, size: f.sizes.get(uri) ?? Buffer.byteLength(f.files.get(uri)) } : f.files.get(uri)) : send(null, 404); }
    send(null, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.store = new Store(join(directory, 'state.json'));
  f.store.configurationService.update({ memory: { endpoint: `http://127.0.0.1:${server.address().port}` } });
  f.created = f.store.createProject({ name: 'Archive markers' });
  f.sync = new MemorySync(f.store, { now: () => f.clock, pollMs: 1000 });
  f.step = async () => { f.clock += 1001; await Promise.all(f.sync.pump()); };
  f.write = () => f.store.state.sessions.find(s => s.id === f.created.session.id).turns.at(-1).memoryWrite;
  f.finish = text => {
    const sessionId = f.created.session.id; f.store.message(sessionId, { text });
    const turnId = f.store.state.sessions.find(s => s.id === sessionId).activeTurnId;
    f.store.mutate(state => { const s = state.sessions.find(row => row.id === sessionId), turn = s.turns.find(row => row.id === turnId); turn.modelConfig = { execution: 'rna' }; s.items.push({ id: `answer-${turnId}`, turnId, kind: 'assistant', text: 'Noted.' }); });
    f.store.finishRuntimeTurn(sessionId, turnId); return turnId;
  };
  // The task is polled once while running, then OpenViking forgets it.
  f.polledThenExpired = async text => { f.finish(text); await f.step(); assert.equal(f.write().status, 'polling'); f.taskGone = true; await f.step(); };
  t.after(async () => { await f.sync.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  return f;
}

// OpenViking's memory_diff.json as _make_memory_diff writes it (written even when extraction changed nothing).
const memoryDiff = (archive, { adds = 0, updates = 0, deletes = 0 } = {}) => JSON.stringify({ archive_uri: archive, operations: { adds: Array.from({ length: adds }, (_, i) => ({ uri: `m${i}` })), updates: Array.from({ length: updates }, (_, i) => ({ uri: `u${i}` })), deletes: Array.from({ length: deletes }, (_, i) => ({ uri: `d${i}` })) }, skipped_operations: [], summary: { total_adds: adds, total_updates: updates, total_deletes: deletes, total_skipped: 0 } }, null, 4);

test('an expired task whose archive has .done settles as completed, with its memory diff, and is never polled again', async t => {
  const f = await fixture(t);
  f.finish('Keep the focus outline visible.'); await f.step();
  f.files.set(`${f.archive}/.done`, JSON.stringify({ starting_message_id: 'a', ending_message_id: 'b', completed_memory_steps: { long_term: ['x'] } }));
  f.files.set(`${f.archive}/memory_diff.json`, memoryDiff(f.archive, { adds: 2, updates: 1 }));
  f.taskGone = true; await f.step();
  const write = f.write();
  assert.deepEqual([write.status, write.code, write.taskStatus, write.memoryDiffUri], ['completed', null, 'task_expired', `${f.archive}/memory_diff.json`]);
  assert.deepEqual([write.settledBy.marker, write.settledBy.state, write.settledBy.memoryChanges], ['.done', 'completed', 3]);
  const health = memorySyncHealth(f.store.state); assert.equal(health.settledLoss, 0); assert.equal(health.completedTurns, 1);
  // A diff that changed memories tells the memory page its content changed (MEM-8 revision).
  assert.equal(f.store.state.projects.find(row => row.id === f.created.project.id).memorySummary.revision, 1);
  const calls = f.calls.length; for (let i = 0; i < 5; i++) await f.step();
  assert.equal(f.calls.length, calls, 'settled: nothing is looked up again');
  // Only GETs reached the archive.
  assert.deepEqual([...new Set(f.calls.filter(row => row.uri?.includes('/history/')).map(row => `${row.method} ${row.path}`))].sort(), ['GET /api/v1/content/read', 'GET /api/v1/fs/stat']);
});

test('an archive whose memory diff changed nothing, or cannot be read as one, settles as completed without moving the memory revision', async t => {
  // A diff larger than one response can carry is not read: its count is unknown, so nothing moves either.
  for (const [name, diff, changes, size] of [['empty diff', archive => memoryDiff(archive), 0], ['not a diff', () => '{}', null], ['no diff', null, undefined], ['too large to read', archive => memoryDiff(archive, { adds: 1 }), null, 3 * 1024 * 1024]]) {
    const f = await fixture(t);
    f.finish('Nothing worth remembering.'); await f.step();
    f.files.set(`${f.archive}/.done`, '{}');
    if (diff) f.files.set(`${f.archive}/memory_diff.json`, diff(f.archive));
    if (size) f.sizes.set(`${f.archive}/memory_diff.json`, size);
    f.taskGone = true; await f.step();
    const write = f.write();
    assert.deepEqual([write.status, write.settledBy.marker, write.settledBy.memoryChanges, write.memoryDiffUri], ['completed', '.done', changes, diff ? `${f.archive}/memory_diff.json` : undefined], name);
    assert.equal(f.store.state.projects.find(row => row.id === f.created.project.id).memorySummary, undefined, name);
    assert.equal(f.calls.filter(row => row.path === '/api/v1/content/read' && row.uri?.endsWith('/memory_diff.json')).length, diff && !size ? 1 : 0, `${name}: diff reads`);
  }
});

test('an expired task whose archive has .failed.json is a failed extraction (re-extraction stays optional), not "cannot tell"', async t => {
  const f = await fixture(t);
  f.finish('Keep the focus outline visible.'); await f.step();
  f.files.set(`${f.archive}/.failed.json`, JSON.stringify({ stage: 'memory_extraction', error: 'fixture' }));
  f.taskGone = true; await f.step();
  const write = f.write();
  assert.deepEqual([write.status, write.code, write.taskStatus, write.settledBy.marker], ['failed', 'MEMORY_EXTRACTION_FAILED', 'task_expired', '.failed.json']);
  assert.equal(reextractCandidate(write), true);
  const health = memorySyncHealth(f.store.state); assert.equal(health.unresolved, 0); assert.equal(health.settledLosses[0].code, 'MEMORY_EXTRACTION_FAILED');
});

test('without a marker, or without a recorded archive, an expired task stays "cannot tell"; a marker lookup that fails is retried', async t => {
  const f = await fixture(t);
  f.finish('Keep the focus outline visible.'); await f.step();
  f.taskGone = true; f.outage = true; await f.step();
  assert.deepEqual([f.write().status, f.write().code], ['polling', 'MEMORY_TASK_LOOKUP_FAILED'], 'the service could not be asked: looked at again later');
  f.outage = false; f.clock += 600000; await f.step();
  assert.deepEqual([f.write().status, f.write().code, f.write().settledBy.state], ['failed', 'MEMORY_TASK_EXPIRED', 'pending']);
  const g = await fixture(t); g.commitArchive = false;
  await g.polledThenExpired('A commit from before archive URIs were recorded.');
  assert.deepEqual([g.write().status, g.write().code, g.write().settledBy], ['failed', 'MEMORY_TASK_EXPIRED', undefined]);
  assert.equal(g.calls.some(row => row.uri?.includes('/history/')), false);
});
