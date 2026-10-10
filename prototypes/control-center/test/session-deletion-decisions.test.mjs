import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJournal } from '../../../packages/sdk/src/journal.mjs';
import { Store } from '../store.mjs';
import { SessionDeletionService, publicSessionDeletions, blockedKey, deletionChoice } from '../session-deletion.mjs';
import { createServer } from '../server.mjs';

// A blocked deletion waits on exactly what blocked it (review D2-1, X6, D2-5) and always offers the user a decision
// that ends it (D2-3). Synthetic state and files; no model calls, no memory service.

const until = async (check, label, ms = 5000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error(`timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 10)); } };
const settle = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-delete-decide-')), file = join(dir, 'state.json'), store = new Store(file);
  const { project, session } = store.createProject({ name: 'Decisions', workspace: dir });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  store.mutate(state => { state.sessions.find(row => row.id === session.id).items.push({ id: 'message-one', kind: 'user', text: 'private request', createdAt: new Date().toISOString() }); });
  const runRoot = join(`${file}.rna`, 'initiative', project.id);
  // A background run that read this conversation; `pending` leaves a non-idempotent tool of unknown outcome.
  const journal = (actionId, { pending = false } = {}) => {
    const stateDir = join(runRoot, actionId), handle = openJournal({ stateDir, sessionId: actionId, projectId: project.id });
    handle.append('inbox_added', { item: { context: [{ source: 'project-evidence', text: JSON.stringify({ project: { recentConversation: [{ sessionId: session.id, id: 'message-one', text: 'context' }] }, evidence: [] }) }] } });
    if (pending) { handle.append('tool_intent', { callKey: 'call-1', toolName: 'project_exec', arguments: { command: 'make' }, effect: 'write', idempotent: false }); handle.append('tool_uncertain', { callKey: 'call-1', code: 'cleanup_uncertain' }); }
    handle.close();
    return { dir: stateDir, file: handle.file };
  };
  const actions = rows => store.mutate(state => {
    const p = state.projects.find(row => row.id === project.id);
    p.initiativeRuntime = { sdkState: { usedTokens: 0, reservedTokens: 0, events: [], actions: [...(p.initiativeRuntime?.sdkState?.actions ?? []), ...rows] } };
  });
  const record = () => store.state.sessionDeletions.find(row => row.sessionId === session.id);
  return { dir, file, store, project, session, runRoot, journal, actions, record };
}
const counting = () => { const calls = { initiative: 0, learning: 0 }; return { calls, projectInitiative: { drainDeletedSession: async () => { calls.initiative++; } }, projectLearning: { drainDeletedSession: async () => { calls.learning++; } } }; };

test('D2-1 / X6 / D2-5: a deletion blocked on a remote record never reruns, nor stops the live project, on background changes; a restored memory key reruns it', async t => {
  const f = fixture(t), writers = counting();
  f.store.deleteSession(f.session.id);
  const uri = `viking://resources/rna/rna-execution-evidence/${f.session.id}/${'a'.repeat(64)}.md`;
  // Local cleanup finished; one evidence file in the memory service no longer holds what was written.
  f.store.mutate(state => Object.assign(state.sessionDeletions[0], { localStatus: 'completed', status: 'blocked', code: 'MEMORY_EVIDENCE_CONTENT_DIFFERS', attempts: 1,
    evidenceResources: [{ uri, namespace: 'viking://resources/rna', status: 'uncertain', dispatchedAt: new Date(Date.now() - 3600000).toISOString(), deletionStatus: 'blocked', evidenceId: 'e1', sourceHash: 'a'.repeat(64) }] }));
  let verified = 0;
  f.store.memoryService.verifyDeletedEvidence = async () => { verified++; return { state: 'differs' }; };
  const service = new SessionDeletionService(f.store, { ...writers, intervalMs: 20 }); t.after(() => service.close());
  // A service start looks at it once.
  await until(() => f.record().attempts === 2 && !service.running.size, 'the start revisit');
  assert.equal(f.record().status, 'blocked'); assert.equal(verified, 1);
  assert.deepEqual(writers.calls, { initiative: 0, learning: 0 }, 'a remote-phase pass never drains the live project’s writers');
  // The live project's background runs, its jobs come and go: nothing reruns the deletion.
  for (let i = 0; i < 4; i++) {
    f.actions([{ id: `run-${i}`, action: 'work', status: 'running', evidenceIds: [] }]);
    f.store.mutate(state => { const p = state.projects.find(row => row.id === f.project.id); p.initiativeRuntime.sdkState.actions.at(-1).status = 'completed'; p.jobs = [...(p.jobs ?? []), { id: `job-${i}`, status: 'completed' }]; });
    await settle(40);
  }
  assert.equal(f.record().attempts, 2); assert.equal(verified, 1); assert.deepEqual(writers.calls, { initiative: 0, learning: 0 });
  // The user restores the memory key: the connection the deletion waits on changed, so it runs again by itself.
  f.store.configurationService.secrets.openviking = 'synthetic-key-restored';
  await until(() => f.record().attempts === 3 && !service.running.size, 'rerun after the key changed');
  assert.equal(verified, 2); assert.deepEqual(writers.calls, { initiative: 0, learning: 0 });
  // The decision it offers: keep that remote record and finish.
  f.store.interfaceLanguage('en');
  const [row] = publicSessionDeletions(f.store.state);
  assert.deepEqual([row.decision, row.choice], ['memory_differs', 'keep_remote']); assert.match(row.notice, /“Keep the remote records”/);
  assert.throws(() => service.decide(f.session.id, 'remove_entry'), { status: 409, code: 'cleanup_decision_unavailable' });
  const status = await service.decide(f.session.id, 'keep_remote');
  assert.equal(status.status, 'completed'); assert.equal(status.remoteStatus, 'kept_by_user');
  assert.equal(f.record().evidenceResources[0].deletionStatus, 'kept_by_user'); assert.equal(f.record().decisions.at(-1).choice, 'keep_remote');
  assert.equal(verified, 2, 'a kept record is not looked at again');
});

test('X6 / D2-3: a run of unknown outcome blocks on exactly that run; unrelated runs never rerun it; "delete without checking" finishes it', async t => {
  const f = fixture(t), writers = counting(), uncertain = f.journal('run-uncertain', { pending: true });
  f.actions([{ id: 'run-uncertain', action: 'work', status: 'needs_review', blocksExecution: true, errorCode: 'uncertain_tool', evidenceIds: [], content: 'run' }]);
  f.store.deleteSession(f.session.id);
  const service = new SessionDeletionService(f.store, { ...writers, intervalMs: 20 }); t.after(() => service.close());
  const status = await service.wait(f.session.id);
  assert.deepEqual([status.status, status.decision, status.choice], ['blocked', 'execution', 'release_runs']);
  assert.deepEqual(f.record().blockedActionIds, ['run-uncertain']);
  const attempts = f.record().attempts, drains = writers.calls.initiative;
  // Other runs of the live project change: not what it waits on.
  for (let i = 0; i < 3; i++) { f.actions([{ id: `other-${i}`, action: 'work', status: 'running', evidenceIds: [] }]); f.store.mutate(state => { state.projects[0].initiativeRuntime.sdkState.actions.at(-1).status = 'failed'; }); await settle(40); }
  assert.equal(f.record().attempts, attempts); assert.equal(writers.calls.initiative, drains);
  assert.equal(blockedKey(f.store.state, f.record()), blockedKey({ ...f.store.state, projects: f.store.state.projects.map(p => ({ ...p, jobs: [{ id: 'unrelated', status: 'running' }] })) }, f.record()));
  // The user deletes the record without checking: the run record goes; the run itself still waits for its review.
  const done = await service.decide(f.session.id, 'release_runs');
  assert.equal(done.status, 'completed');
  assert.equal(existsSync(uncertain.dir), false);
  const run = f.store.state.projects[0].initiativeRuntime.sdkState.actions.find(row => row.id === 'run-uncertain');
  assert.equal(run.status, 'needs_review'); assert.equal(run.blocksExecution, true); assert.equal(run.sourceDeleted, true);
  assert.deepEqual(f.record().evidence.userReleasedActionIds, ['run-uncertain']);
  assert.equal(f.record().blockedActionIds, undefined, 'a settled record keeps no blocker');
});

test('D2-3: a damaged, linked or oversized run record is removed on the user’s word, and only it', async t => {
  const f = fixture(t), service = new SessionDeletionService(f.store, { intervalMs: 20 }); t.after(() => service.close());
  const keep = f.journal('run-keep'), outside = join(f.dir, 'outside.log'); writeFileSync(outside, 'not the app’s');
  // Damaged: an unknown file beside a run's journal.
  const damaged = f.journal('run-damaged'); writeFileSync(join(damaged.dir, 'notes.txt'), 'unknown');
  // Unsafe: an execution log that is a link to a file outside the run folder.
  const linked = f.journal('run-linked'); mkdirSync(join(linked.dir, 'exec', 'rna-exec-abcdef'), { recursive: true }); symlinkSync(outside, join(linked.dir, 'exec', 'rna-exec-abcdef', 'output.log'));
  // Too large: a journal line over the per-line limit.
  const large = f.journal('run-large'); truncateSync(large.file, 33 * 1024 * 1024);
  f.store.deleteSession(f.session.id);
  const seen = [];
  for (let round = 0; round < 3; round++) {
    const status = await service.wait(f.session.id);
    assert.equal(status.status, 'blocked'); assert.equal(status.choice, 'remove_entry', status.code);
    seen.push([status.decision, f.record().blockedEntry.path.split('/').slice(2).join('/')]);
    await service.decide(f.session.id, 'remove_entry');
  }
  assert.equal((await service.wait(f.session.id)).status, 'completed');
  assert.deepEqual(seen.sort(), [['damaged', 'run-damaged/notes.txt'], ['too_large', 'run-large'], ['unsafe', 'run-linked/exec/rna-exec-abcdef/output.log']]);
  assert.equal(readFileSync(outside, 'utf8'), 'not the app’s', 'a link is removed itself, never what it points to');
  assert.equal(existsSync(keep.dir), false, 'the run linked to the conversation is cleaned as usual');
  assert.deepEqual(f.record().removedEntries.map(row => row.root), ['.rna', '.rna', '.rna']);
});

test('D2-3: an archived receipt that is a link is unsafe and removable; a damaged deletion record is rebuilt; a whole linked root is not removable', async t => {
  const f = fixture(t), service = new SessionDeletionService(f.store, { intervalMs: 20 }); t.after(() => service.close());
  const outside = join(f.dir, 'outside.json'); writeFileSync(outside, '{"id":"elsewhere"}');
  const archive = join(`${f.file}.archive`, 'initiative', f.project.id, 'actions'); mkdirSync(archive, { recursive: true });
  symlinkSync(outside, join(archive, `${'b'.repeat(64)}.json`));
  f.store.deleteSession(f.session.id);
  // A record whose evidence capture is gone (as an older release could leave it).
  f.store.mutate(state => { delete state.sessionDeletions[0].evidence; });
  let status = await service.wait(f.session.id);
  assert.deepEqual([status.code, status.choice], ['SESSION_EVIDENCE_CAPTURE_MISSING', 'rebuild']);
  status = await service.decide(f.session.id, 'rebuild');
  assert.deepEqual([status.code, status.decision, status.choice], ['SESSION_EVIDENCE_STORAGE_UNSAFE', 'unsafe', 'remove_entry']);
  assert.deepEqual(f.record().blockedEntry, { root: '.archive', path: `initiative/${f.project.id}/actions/${'b'.repeat(64)}.json` });
  status = await service.decide(f.session.id, 'remove_entry');
  assert.equal(status.status, 'completed'); assert.equal(readFileSync(outside, 'utf8'), '{"id":"elsewhere"}');
  // Nothing to remove in the app when the run records root itself is a link: the user fixes it, then retries.
  assert.equal(deletionChoice({ status: 'blocked', code: 'SESSION_EVIDENCE_STORAGE_UNSAFE' }), null);
  assert.equal(deletionChoice({ status: 'blocked', code: 'SESSION_EVIDENCE_STORAGE_UNSAFE', blockedEntry: { root: '.rna', path: `initiative/${f.project.id}` } }), null);
  assert.equal(deletionChoice({ status: 'blocked', code: 'SESSION_EVIDENCE_STORAGE_UNSAFE', blockedEntry: { root: '.rna', path: `initiative/${f.project.id}/../x` } }), null);
});

test('D2-3: more run records than one pass reads are read in full once the user says so', async t => {
  // The pass limit lowered to 8 files (it is 20 000): 5 execution logs count 10.
  const f = fixture(t), service = new SessionDeletionService(f.store, { intervalMs: 20, readLimits: { files: 8 } }); t.after(() => service.close());
  const exec = join(f.journal('run-busy').dir, 'exec');
  for (let i = 0; i < 5; i++) { const child = join(exec, `rna-exec-${String(i).padStart(6, '0')}`); mkdirSync(child, { recursive: true }); writeFileSync(join(child, 'output.log'), ''); }
  f.store.deleteSession(f.session.id);
  const status = await service.wait(f.session.id);
  assert.deepEqual([status.code, status.choice], ['SESSION_EVIDENCE_READ_LIMIT', 'read_all']); assert.equal(f.record().blockedLimit, 'cumulative');
  assert.equal((await service.decide(f.session.id, 'read_all')).status, 'completed');
  assert.equal(existsSync(exec), false);
});

test('D2-3: POST /api/session-deletions/:id/decide takes only the decision the record offers', async t => {
  const f = fixture(t);
  f.store.deleteSession(f.session.id); f.store.mutate(state => { delete state.sessionDeletions[0].evidence; });
  const app = createServer({ stateFile: f.file, ticks: false, runtime: false }); await app.initializer.close();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (path, body) => { const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  await until(() => false, 'settle', 200).catch(() => {});
  const [row] = (await (await fetch(`${base}/api/v2/session-deletions`)).json()).deletions;
  assert.deepEqual([row.status, row.choice], ['blocked', 'rebuild']);
  const wrong = await post(`/api/session-deletions/${f.session.id}/decide`, { choice: 'read_all' });
  assert.equal(wrong.status, 409); assert.equal(wrong.body.code, 'cleanup_decision_unavailable');
  assert.equal((await post('/api/session-deletions/unknown-session/decide', { choice: 'rebuild' })).body.code, 'cleanup_not_found');
  const right = await post(`/api/session-deletions/${f.session.id}/decide`, { choice: 'rebuild' });
  assert.equal(right.status, 202); assert.equal(right.body.cleanup.status, 'completed');
});
