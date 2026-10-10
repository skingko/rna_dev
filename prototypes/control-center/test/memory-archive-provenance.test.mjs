import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { MemorySync } from '../memory-sync.mjs';
import { applyReextract, reextractPlan } from '../memory-sync-routes.mjs';

// A2 (for X-7): every commit records where OpenViking archived the turn and, once long-term extraction ran, the archive's
// memory_diff.json (adds/updates/deletes). OpenViking 0.4.21.1 returns `archive_uri` in the commit result and
// `archive_uri` + `memory_diff_uri` in the phase-2 task result (session.py). The archive is gone once its remote session
// is deleted, so these are recorded as they arrive.
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-memory-archive-'));
  const f = { taskStatus: 'completed', clock: 1000, archive: {}, task: {} };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const url = new URL(req.url, 'http://fixture'), body = raw ? JSON.parse(raw) : null;
    const send = result => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', result })); };
    if (url.pathname === '/api/v1/system/status') return send({ initialized: true, user: 'alice' });
    if (url.pathname === '/api/v1/sessions') return send({ session_id: body.session_id });
    const id = url.pathname.split('/')[4], archive = f.archive.commit === undefined ? `viking://user/alice/sessions/${id}/history/archive_001` : f.archive.commit;
    if (url.pathname.endsWith('/messages/batch')) return send({ added: body.messages.length });
    if (url.pathname.endsWith('/commit')) { f.sessionId = id; return send({ status: 'accepted', archived: true, task_id: `task-${id}`, ...(archive ? { archive_uri: archive } : {}) }); }
    if (url.pathname.includes('/tasks/')) {
      const own = `viking://user/alice/sessions/${f.sessionId}/history/archive_001`, taskArchive = f.archive.task === undefined ? own : f.archive.task;
      const diff = f.archive.diff === undefined ? `${taskArchive}/memory_diff.json` : f.archive.diff;
      return send({ status: f.taskStatus, result: f.taskStatus === 'completed' ? { session_id: f.sessionId, archive_uri: taskArchive, memories_extracted: { preferences: 1 }, ...(diff ? { memory_diff_uri: diff } : {}) } : null });
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.store = new Store(join(directory, 'state.json'));
  f.store.configurationService.update({ memory: { endpoint: `http://127.0.0.1:${server.address().port}` } });
  f.created = f.store.createProject({ name: 'Archive provenance' });
  f.sync = new MemorySync(f.store, { now: () => f.clock, pollMs: 1000 });
  f.step = async () => { f.clock += 1001; await Promise.all(f.sync.pump()); };
  f.write = () => f.store.state.sessions.find(s => s.id === f.created.session.id).turns.at(-1).memoryWrite;
  f.finish = text => {
    const sessionId = f.created.session.id; f.store.message(sessionId, { text });
    const turnId = f.store.state.sessions.find(s => s.id === sessionId).activeTurnId;
    f.store.mutate(state => { const s = state.sessions.find(row => row.id === sessionId), turn = s.turns.find(row => row.id === turnId); turn.modelConfig = { execution: 'rna' }; s.items.push({ id: `answer-${turnId}`, turnId, kind: 'assistant', text: 'Noted.' }); });
    f.store.finishRuntimeTurn(sessionId, turnId); return turnId;
  };
  t.after(async () => { await f.sync.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  return f;
}

test('a commit records its archive at once, and the completed task adds the archive\'s memory diff', async t => {
  const f = await fixture(t); f.taskStatus = 'running'; f.finish('Keep the focus outline visible.'); await f.step();
  const own = `viking://user/alice/sessions/${f.write().sessionId}/history/archive_001`;
  assert.equal(f.write().status, 'polling'); assert.equal(f.write().archiveUri, own); assert.equal(f.write().memoryDiffUri, undefined);
  f.taskStatus = 'completed'; await f.step();
  assert.equal(f.write().status, 'completed'); assert.equal(f.write().archiveUri, own); assert.equal(f.write().memoryDiffUri, `${own}/memory_diff.json`);
});

test('an older server without archive_uri on commit: the task result supplies it', async t => {
  const f = await fixture(t); f.archive.commit = null; f.finish('Keep the focus outline visible.'); await f.step();
  assert.equal(f.write().archiveUri, undefined);
  await f.step();
  const own = `viking://user/alice/sessions/${f.write().sessionId}/history/archive_001`;
  assert.deepEqual([f.write().status, f.write().archiveUri, f.write().memoryDiffUri], ['completed', own, `${own}/memory_diff.json`]);
});

test('a URI outside the bound remote session, or a diff of another archive, is never recorded', async t => {
  for (const [name, archive] of [
    ['another user', { commit: 'viking://user/bob/sessions/rna-x/history/archive_001', task: 'viking://user/bob/sessions/rna-x/history/archive_001' }],
    ['another session', { commit: 'viking://user/alice/sessions/rna-other/history/archive_001', task: 'viking://user/alice/sessions/rna-other/history/archive_001' }],
    ['not an archive', { commit: 'viking://user/alice/memories/../sessions', task: 'viking://user/alice/sessions' }],
  ]) {
    const f = await fixture(t); f.archive = archive; f.finish('Keep the focus outline visible.'); await f.step(); await f.step();
    assert.deepEqual([f.write().status, f.write().archiveUri, f.write().memoryDiffUri], ['completed', undefined, undefined], name);
  }
  const f = await fixture(t); f.archive = { diff: 'viking://user/alice/sessions/rna-other/history/archive_001/memory_diff.json' };
  f.finish('Keep the focus outline visible.'); await f.step(); await f.step();
  assert.ok(f.write().archiveUri); assert.equal(f.write().memoryDiffUri, undefined, 'a diff of another archive');
  const g = await fixture(t); g.archive = { diff: null }; g.finish('Nothing to extract.'); await g.step(); await g.step();
  assert.ok(g.write().archiveUri); assert.equal(g.write().memoryDiffUri, undefined, 'no long-term step, no diff');
});

test('a failed extraction keeps its archive; re-extraction moves it into the attempt it replaces', async t => {
  const f = await fixture(t); f.taskStatus = 'failed'; const turnId = f.finish('Keep the focus outline visible.'); await f.step(); await f.step();
  const failed = f.write(); assert.deepEqual([failed.status, failed.code], ['failed', 'MEMORY_EXTRACTION_FAILED']);
  assert.ok(failed.archiveUri); assert.equal(failed.memoryDiffUri, undefined);
  const ref = { sessionId: f.created.session.id, turnId };
  f.store.mutate(state => { const plan = reextractPlan(state, f.created.project.id, ref); applyReextract(plan.write, { connectionFingerprint: f.store.memoryService.connectionFingerprint(f.created.project.id) }); });
  assert.equal(f.write().archiveUri, undefined); assert.equal(f.write().reextract.previous.at(-1).archiveUri, failed.archiveUri);
  f.taskStatus = 'completed'; await f.step(); await f.step();
  assert.equal(f.write().status, 'completed'); assert.notEqual(f.write().archiveUri, failed.archiveUri); assert.equal(f.write().memoryDiffUri, `${f.write().archiveUri}/memory_diff.json`);
});
