import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { MemorySync, memorySyncHealth } from '../memory-sync.mjs';
import { MemorySummarySync, noteMemoryRevision } from '../memory-summary-sync.mjs';
import { projectMemorySyncStatus } from '../memory-sync-status.mjs';

// MEM-8: the whole peer-memory tree is no longer rebuilt after extractions (measurement in
// docs/research/memory-hygiene-b6-20261005.md). A completed extraction that produced memories moves the project's memory
// revision; nothing is submitted. A rebuild an earlier version already submitted is followed read-only to its end.
async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-memory-summary-'));
  const f = { calls: [], posts: 0, clock: 1000, user: 'alice', tasks: new Map(), taskStatus: 'running', trees: new Map() };
  f.active = task => ['pending', 'running', 'cancelling'].includes(task.status ?? f.taskStatus);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'); let raw = ''; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : null;
    f.calls.push({ path: url.pathname, method: req.method, query: Object.fromEntries(url.searchParams), body });
    const send = (result, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: status === 200 ? 'ok' : 'error', result })); };
    if (f.outage) return send({}, 503);
    if (url.pathname.endsWith('/system/status')) return send({ initialized: true, user: f.user });
    if (url.pathname.endsWith('/content/reindex')) { f.posts++; return send({ task_id: `summary-${f.posts}`, status: 'accepted', uri: body.uri, object_type: 'memory', mode: body.mode }); }
    if (url.pathname.includes('/tasks/')) {
      const id = url.pathname.split('/').at(-1), task = f.tasks.get(id);
      if (!task) return send({ task_id: id, status: 'completed', task_type: 'session_commit', result: { memories_extracted: { memory_write: 1 } } });
      if (f.expired) return send({}, 404);
      return send({ ...task, ...(f.wrongTask ? { task_type: 'session_commit', resource_id: 'another-project' } : {}), status: task.status ?? f.taskStatus,
        result: { status: 'completed', uri: task.resource_id, object_type: 'memory', mode: 'semantic_and_vectors', scanned_records: 3, rebuilt_records: 5, failed_records: f.failedRecords ?? 0 } });
    }
    if (url.pathname === '/api/v1/tasks' && f.tracker) return send({ items: [...f.tasks.values()].filter(task => task.task_type === url.searchParams.get('task_type') && task.resource_id === url.searchParams.get('resource_id')).reverse(), has_more: false, next_cursor: null });
    if (url.pathname.endsWith('/fs/ls')) return send(f.outside ? [{ uri: 'viking://user/bob/memories/private', isDir: true }] : f.trees.get(url.searchParams.get('uri')) ?? []);
    if (url.pathname.endsWith('/content/abstract') || url.pathname.endsWith('/content/overview')) {
      const uri = url.searchParams.get('uri'), kind = url.pathname.split('/').at(-1);
      if (f.emptyLayer) return send('  ');
      const rebuilding = f.tracker && !f.staleLayers && [...f.tasks.values()].some(task => uri.startsWith(task.resource_id) && f.active(task));
      if (rebuilding || f.placeholder) return send(kind === 'abstract' ? `# ${uri} [Directory abstract is not ready]` : `# ${uri}\n\n[Directory overview is not ready]`);
      return send(`${kind} summary of the actual fixture document.`);
    }
    if (url.pathname.endsWith('/content/read')) return send(f.invalidSource ? null : 'Artificial retained memory source.');
    if (url.pathname === '/api/v1/sessions') return send({ session_id: body.session_id });
    if (url.pathname.endsWith('/messages/batch')) return send({ added: body.messages.length });
    if (url.pathname.endsWith('/commit')) return send({ status: 'accepted', archived: true, task_id: `commit-${url.pathname.split('/')[4]}` });
    return send({}, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.file = join(directory, 'state.json'); f.store = new Store(f.file);
  f.store.configurationService.update({ memory: { endpoint: `http://127.0.0.1:${server.address().port}` } });
  f.project = f.store.createProject({ name: 'Isolated memory summary fixture' }).project;
  f.uri = id => `viking://user/alice/peers/forge-${id}/memories`;
  f.seed = projectId => { const uri = f.uri(projectId); f.trees.set(uri, [{ uri: `${uri}/entities`, isDir: true }, { uri: `${uri}/entities/artificial.md`, isDir: false }]); };
  f.seed(f.project.id);
  f.note = (id = f.project.id, taskId = `commit-${f.clock}`) => f.store.mutate(state => noteMemoryRevision(state, id, { sessionId: `remote-${id}`, taskId, memoriesExtracted: 1 }, f.clock));
  // A whole-tree rebuild an earlier version submitted (its receipt named `taskId`), as it is on disk after the upgrade.
  f.submitted = (overrides = {}, id = f.project.id) => {
    const uri = f.uri(id), taskId = overrides.taskId === undefined ? `summary-legacy-${id.slice(0, 4)}` : overrides.taskId;
    if (taskId) f.tasks.set(taskId, { task_id: taskId, task_type: 'admin_reindex', resource_id: uri, ...(f.tracker ? { status: 'running' } : {}) });
    f.store.mutate(state => { state.projects.find(project => project.id === id).memorySummary = { schemaVersion: 1, id: `row-${id}`, revision: 1, targetRevision: 1, sourceFingerprint: 'fp-1', targetFingerprint: 'fp-1', lastSourceTaskId: 'commit-0',
      connectionFingerprint: f.store.memoryService.connectionFingerprint(id), endpoint: state.configuration.memory.endpoint, userId: 'alice', actorPeerId: `forge-${id}`, uri,
      expectedFiles: [`${uri}/entities/artificial.md`], expectedDirectories: [uri, `${uri}/entities`], status: 'polling', taskId, nextPollAt: 0, createdAt: new Date(f.clock).toISOString(), ...overrides }; });
  };
  f.sync = new MemorySummarySync(f.store, { now: () => f.clock, pollMs: 10, timeoutMs: 1000, ...options });
  f.row = (id = f.project.id) => f.store.state.projects.find(project => project.id === id)?.memorySummary;
  f.step = async () => { f.clock += 1000; await Promise.all(f.sync.pump()); };
  f.writes = () => f.calls.filter(call => call.method !== 'GET');
  t.after(async () => { await f.sync.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  return f;
}

test('a completed extraction moves the project memory revision and never submits a rebuild; nothing is backfilled', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 20; n++) await f.step();
  assert.equal(f.calls.length, 0); assert.equal(f.row(), undefined);
  const memory = new MemorySync(f.store, { now: () => f.clock, pollMs: 10 }); t.after(() => memory.close());
  const session = f.store.state.sessions.find(session => session.projectId === f.project.id);
  f.store.message(session.id, { text: 'Keep this artificial project decision.' });
  const turnId = f.store.state.sessions.find(row => row.id === session.id).activeTurnId;
  f.store.mutate(state => { const turn = state.sessions.find(row => row.id === session.id).turns.find(row => row.id === turnId); turn.modelConfig = { execution: 'rna' }; });
  f.store.finishRuntimeTurn(session.id, turnId);
  await Promise.all(memory.pump()); f.clock += 100; await Promise.all(memory.pump());
  assert.deepEqual([f.row().status, f.row().code, f.row().revision], ['skipped', 'MEMORY_SUMMARY_RETIRED', 1]); assert.ok(f.row().sourceFingerprint);
  const fingerprint = f.row().sourceFingerprint;
  for (let n = 0; n < 20; n++) await f.step();
  assert.equal(f.posts, 0); assert.deepEqual(f.calls.filter(call => /reindex|abstract|overview|fs\/ls/.test(call.path)), [], 'the tree is neither rebuilt nor walked');
  // The same task twice moves nothing; a new one moves the revision again (the memory page's "content changed").
  f.store.mutate(state => noteMemoryRevision(state, f.project.id, { sessionId: 'x', taskId: f.row().lastSourceTaskId, memoriesExtracted: 1 }, f.clock)); assert.equal(f.row().revision, 1);
  f.note(); assert.equal(f.row().revision, 2); assert.notEqual(f.row().sourceFingerprint, fingerprint);
  const health = memorySyncHealth(f.store.state); assert.equal(health.summaries.healthy, true); assert.equal(health.summaries.counts.skipped, 1);
  assert.equal(projectMemorySyncStatus(f.store.state, f.store.state.projects.find(row => row.id === f.project.id)).summary, null, 'a retired row has nothing to report');
});

test('rows an earlier version left waiting to submit, or failed, are retired without a request; a completed one until the next extraction', async t => {
  const f = await fixture(t), second = f.store.createProject({ name: 'Second' }).project, third = f.store.createProject({ name: 'Third' }).project;
  f.submitted({ status: 'pending', taskId: null });
  f.submitted({ status: 'failed', code: 'MEMORY_SUMMARY_TREE_LIMIT', taskId: null }, second.id);
  f.submitted({ status: 'completed', taskId: null, verification: { directories: 2, files: 1, layers: 4 } }, third.id);
  await f.step();
  assert.equal(f.calls.length, 0, 'no request');
  assert.deepEqual([f.row().status, f.row().code], ['skipped', 'MEMORY_SUMMARY_RETIRED']);
  assert.deepEqual([f.row(second.id).status, f.row(second.id).lastFailure.code], ['skipped', 'MEMORY_SUMMARY_TREE_LIMIT']);
  assert.equal(f.row(third.id).status, 'completed');
  f.note(third.id); assert.deepEqual([f.row(third.id).status, f.row(third.id).verification.layers], ['skipped', 4]);
});

test('a rebuild submitted before the upgrade is followed by GETs to its end and verified; one superseded by a later extraction retires', async t => {
  const f = await fixture(t); f.submitted();
  await f.step(); assert.equal(f.row().status, 'polling'); assert.equal(f.row().taskStatus, 'running');
  f.taskStatus = 'completed'; await f.step();
  assert.equal(f.row().status, 'completed'); assert.deepEqual([f.row().verification.directories, f.row().verification.files, f.row().verification.layers], [2, 1, 4]);
  assert.deepEqual(f.writes(), [], 'reads only');
  const calls = f.calls.length; for (let n = 0; n < 20; n++) await f.step(); assert.equal(f.calls.length, calls);
  const g = await fixture(t); g.submitted(); await g.step();
  g.note(); assert.equal(g.row().status, 'polling', 'a running rebuild keeps its status while later revisions arrive');
  g.taskStatus = 'completed'; await g.step();
  assert.deepEqual([g.row().status, g.row().verifiedRevision, g.row().revision], ['skipped', 1, 2]); assert.equal(g.posts, 0);
});

test('a saved task resumes only GET polling after restart', async t => {
  const f = await fixture(t); f.submitted(); await f.step();
  await f.sync.close(); f.store = new Store(f.file); f.sync = new MemorySummarySync(f.store, { now: () => f.clock, pollMs: 10 });
  f.taskStatus = 'completed'; await f.step(); assert.equal(f.row().status, 'completed'); assert.deepEqual(f.writes(), []);
});

test('an unconfirmed submission is settled by the read-only tree check: summarized → completed, otherwise retired, never submitted again', async t => {
  const f = await fixture(t); f.submitted({ status: 'uncertain', code: 'MEMORY_SUMMARY_OUTCOME_UNKNOWN', taskId: null });
  assert.equal(memorySyncHealth(f.store.state).healthy, false);
  await f.step();
  assert.equal(f.row().status, 'completed'); assert.deepEqual([f.row().settledFrom.status, f.row().settledFrom.code], ['uncertain', 'MEMORY_SUMMARY_OUTCOME_UNKNOWN']);
  assert.equal(memorySyncHealth(f.store.state).healthy, true);
  const g = await fixture(t); g.submitted({ status: 'uncertain', code: 'MEMORY_SUMMARY_OUTCOME_UNKNOWN', taskId: null });
  g.outage = true; await g.step();
  assert.deepEqual([g.row().status, g.row().code, g.row().pollFailures], ['uncertain', 'MEMORY_SUMMARY_OUTCOME_UNKNOWN', 1]);
  g.outage = false; g.placeholder = true; await g.step();
  assert.deepEqual([g.row().status, g.row().previousVerification.code, g.row().previousVerification.from], ['skipped', 'MEMORY_SUMMARY_LAYER_INCOMPLETE', 'MEMORY_SUMMARY_OUTCOME_UNKNOWN']);
  for (let n = 0; n < 10; n++) await g.step(); assert.equal(g.posts, 0); assert.deepEqual(g.writes(), []);
});

test('a crash while submitting never repeats the POST: the row is checked, and retires when nothing proves it', async t => {
  const f = await fixture(t); f.submitted({ status: 'submitting', taskId: null, expectedFiles: undefined });
  await f.step(); assert.equal(f.row().status, 'uncertain');
  await f.step(); assert.deepEqual([f.row().status, f.row().previousVerification.code], ['skipped', 'MEMORY_SUMMARY_SOURCE_MISSING']);
  for (let n = 0; n < 10; n++) await f.step(); assert.equal(f.posts, 0);
});

for (const failure of ['placeholder', 'emptyLayer', 'invalidSource', 'wrongTask', 'failedRecords']) test(`a completed task does not hide ${failure}: a settled failure that does not gate health, then retired`, async t => {
  const f = await fixture(t); f.submitted(); await f.step(); f[failure] = failure === 'failedRecords' ? 1 : true; f.taskStatus = 'completed'; await f.step();
  const health = memorySyncHealth(f.store.state);
  assert.equal(f.row().status, 'failed'); assert.equal(health.healthy, true); assert.equal(health.summaries.issues.length, 0);
  const code = f.row().code; await f.step();
  assert.deepEqual([f.row().status, f.row().lastFailure.code], ['skipped', code]); assert.equal(f.posts, 0);
});

test('an expired task is settled by the read-only tree check', async t => {
  const f = await fixture(t); f.submitted(); await f.step(); f.expired = true; await f.step();
  assert.deepEqual([f.row().status, f.row().code], ['uncertain', 'MEMORY_SUMMARY_TASK_EXPIRED']);
  await f.step(); assert.equal(f.row().status, 'completed'); assert.equal(f.row().settledFrom.code, 'MEMORY_SUMMARY_TASK_EXPIRED'); assert.equal(f.posts, 0);
});

for (const pause of ['emergency', 'archive', 'autoStore']) test(`${pause} still lets a submitted rebuild be verified read-only`, async t => {
  const f = await fixture(t); f.submitted();
  f.store.mutate(state => { if (pause === 'emergency') state.emergency = true; else if (pause === 'archive') state.projects[0].archivedAt = '2026-09-24T00:00:00Z'; else state.configuration.memory.autoStore = false; });
  f.taskStatus = 'completed'; await f.step(); assert.equal(f.row().status, 'completed'); assert.equal(f.posts, 0);
});

test('one project is looked at at a time; a project deleted during its lookup is not recreated', async t => {
  const f = await fixture(t), second = f.store.createProject({ name: 'Second project' }).project;
  f.seed(second.id); f.submitted(); f.submitted({}, second.id); f.taskStatus = 'completed';
  f.sync.cursor = f.store.state.projects.findIndex(project => project.id === f.project.id);
  const first = f.sync.pump(); assert.equal(first.length, 1); assert.deepEqual(f.sync.pump(), []);
  f.store.mutate(state => { state.projects = state.projects.filter(project => project.id !== f.project.id); });
  await Promise.all(first); assert.equal(f.row(), undefined);
  await f.step(); assert.equal(f.row(second.id).status, 'completed');
});

test('connection and identity changes fail closed; foreign or truncated trees are not certified', async t => {
  for (const kind of ['identity', 'connection', 'outside', 'limit', 'tampered-scope']) {
    const f = await fixture(t, kind === 'limit' ? { maxNodes: 1 } : {}); f.submitted(); f.taskStatus = 'completed';
    if (kind === 'identity') f.user = 'bob';
    if (kind === 'connection') f.store.configurationService.update({ memory: { apiKey: 'changed-fixture-credential' } });
    if (kind === 'outside') f.outside = true;
    if (kind === 'tampered-scope') f.store.mutate(state => { state.projects[0].memorySummary.uri = 'viking://user/alice/memories'; });
    await f.step(); assert.equal(f.row().status, 'failed', kind); assert.equal(f.posts, 0);
  }
});

test('read-only lookup outages back off and recover', async t => {
  const f = await fixture(t); f.submitted(); f.outage = true; await f.step();
  assert.equal(f.row().status, 'polling'); assert.equal(f.row().pollFailures, 1); assert.equal(memorySyncHealth(f.store.state).healthy, false);
  f.outage = false; f.taskStatus = 'completed'; await f.step(); assert.equal(f.row().status, 'completed'); assert.equal(f.posts, 0);
});

// OpenViking runs one reindex per tree. A row whose receipt was lost while its reindex still runs neither passes the tree
// check on the older layers before the rebuild ends nor settles early: it follows the running task to its end.
for (const layers of ['rebuilding', 'stale']) test(`a lost receipt while its reindex still runs (${layers} layers): the check follows the running task, no early completion`, async t => {
  const f = await fixture(t); f.tracker = true; f.staleLayers = layers === 'stale';
  f.submitted({ status: 'uncertain', code: 'MEMORY_SUMMARY_OUTCOME_UNKNOWN', taskId: null }); f.tasks.set('summary-running', { task_id: 'summary-running', task_type: 'admin_reindex', resource_id: f.uri(f.project.id), status: 'running' });
  const trail = [];
  for (let n = 0; n < 5; n++) { await f.step(); trail.push(f.row().status); }
  assert.deepEqual(trail, Array(5).fill('polling'));
  assert.deepEqual([f.row().taskId, f.row().adoptedTaskId, f.row().adoptedFrom.code], ['summary-running', 'summary-running', 'MEMORY_SUMMARY_OUTCOME_UNKNOWN']);
  assert.equal(f.row().verifiedRevision, undefined, 'nothing is claimed while it rebuilds');
  f.tasks.get('summary-running').status = 'completed'; await f.step();
  assert.equal(f.row().status, 'completed'); assert.equal(f.posts, 0); assert.deepEqual(f.writes(), []);
});

test('an uncertain row is looked at once its pause is over, not before', async t => {
  const f = await fixture(t, { pollMs: 5000 }); f.submitted({ status: 'uncertain', code: 'MEMORY_SUMMARY_OUTCOME_UNKNOWN', taskId: null, nextPollAt: f.clock + 5000 });
  f.clock += 1000; await Promise.all(f.sync.pump()); assert.equal(f.calls.length, 0, 'nothing is read before its time');
  f.clock += 5000; await Promise.all(f.sync.pump()); assert.equal(f.row().status, 'completed');
});
