import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { SessionDeletionService, purgeSessionFiles } from '../session-deletion.mjs';
import { createServer } from '../server.mjs';
import { readStateText } from '../state-shards.mjs';
const hold = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-session-purge-')), store = new Store(join(dir, 'state.json'));
  const { project, session } = store.createProject({ name: 'Keep workspace', workspace: dir });
  const other = store.createSession({ projectId: project.id });
  for (const id of [session.id, other.id]) for (const suffix of ['.rna', '.pi']) { mkdirSync(join(store.file + suffix, id), { recursive: true }); writeFileSync(join(store.file + suffix, id, 'chat.jsonl'), `chat ${id}`); }
  writeFileSync(join(dir, 'project.txt'), 'keep project file');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store, project, session, other };
}
test('archive retains transcripts; deletion removes only owned conversation journals and durable UI history', async t => {
  const f = fixture(t), service = new SessionDeletionService(f.store); t.after(() => service.close());
  f.store.message(f.session.id, { text: 'private chat text' }); f.store.updateSession(f.session.id, { archived: true });
  assert.ok(existsSync(join(f.store.file + '.rna', f.session.id, 'chat.jsonl'))); assert.ok(f.store.state.sessions.find(s => s.id === f.session.id).items.some(i => i.text === 'private chat text'));
  f.store.deleteSession(f.session.id); assert.equal((await service.wait(f.session.id)).status, 'completed');
  for (const suffix of ['.rna', '.pi']) { assert.equal(existsSync(join(f.store.file + suffix, f.session.id)), false); assert.ok(existsSync(join(f.store.file + suffix, f.other.id, 'chat.jsonl'))); }
  assert.equal(readFileSync(join(f.dir, 'project.txt'), 'utf8'), 'keep project file');
  assert.equal(readStateText(f.store.file).includes('private chat text'), false);
  assert.equal(f.store.get().sessionDeletions[0].bindings, undefined);
});
test('deletion waits for an aborted writer and memory upload receipt before unlinking; late writes cannot resurrect a journal', async t => {
  const f = fixture(t), settled = hold(), drain = hold(); let aborted = false;
  const context = { cancelled: false, memoryAbort: new AbortController(), handle: { abort: async () => { aborted = true; } }, runPromise: settled.promise };
  const service = new SessionDeletionService(f.store, { executor: { running: new Map([[f.session.id, context]]), memorySync: { drainSession: () => drain.promise } } }); t.after(() => service.close());
  f.store.deleteSession(f.session.id); const cleaning = service.clean(f.session.id); await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborted, true); assert.equal(context.memoryAbort.signal.aborted, true); assert.ok(existsSync(join(f.store.file + '.rna', f.session.id)));
  writeFileSync(join(f.store.file + '.rna', f.session.id, 'last-event.json'), 'late event'); settled.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.ok(existsSync(join(f.store.file + '.rna', f.session.id))); drain.resolve();
  assert.equal((await cleaning).status, 'completed'); assert.equal(existsSync(join(f.store.file + '.rna', f.session.id)), false);
});
test('deletion drains the independent learning writer before discovering and deleting a late frozen snapshot', async t => {
  const f = fixture(t), drain = hold(); let called = false;
  const service = new SessionDeletionService(f.store, { projectLearning: { async drainDeletedSession(record) { assert.equal(record.sessionId, f.session.id); called = true; await drain.promise; } } });
  t.after(async () => { drain.resolve(); await service.close(); });
  f.store.deleteSession(f.session.id); const cleaning = service.clean(f.session.id); await new Promise(resolve => setImmediate(resolve));
  assert.equal(called, true); assert.ok(existsSync(join(f.store.file + '.rna', f.session.id)));
  const dir = join(`${f.store.file}.evolution`, f.project.id, 'late-version'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'learning-context.json'), JSON.stringify({ evidence: [{ id: `episode:turn:${f.session.id}:turn-one:abcdef0123456789`, content: 'late private receipt' }], files: [] }));
  drain.resolve(); assert.equal((await cleaning).status, 'completed'); assert.equal(existsSync(join(dir, 'learning-context.json')), false); assert.equal(readFileSync(join(f.dir, 'project.txt'), 'utf8'), 'keep project file');
});
test('cleanup refuses a linked private root, unlinks child symlinks without touching target, and retries durable failures', async t => {
  const f = fixture(t), outside = join(f.dir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'keep');
  rmSync(join(f.store.file + '.rna', f.session.id), { recursive: true }); symlinkSync(outside, join(f.store.file + '.rna', f.session.id));
  purgeSessionFiles(f.store.file, f.session.id); assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'keep');
  rmSync(f.store.file + '.rna', { recursive: true }); symlinkSync(outside, f.store.file + '.rna');
  f.store.deleteSession(f.session.id); let service = new SessionDeletionService(f.store); assert.equal((await service.wait(f.session.id)).code, 'SESSION_EVIDENCE_STORAGE_UNSAFE'); await service.close();
  rmSync(f.store.file + '.rna'); mkdirSync(f.store.file + '.rna');
  const reopened = new Store(f.store.file); service = new SessionDeletionService(reopened); t.after(() => service.close());
  assert.equal((await service.clean(f.session.id, { retry: true })).status, 'completed'); assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'keep');
  assert.throws(() => purgeSessionFiles(f.store.file, '../outside'), { code: 'INVALID_SESSION_ID' });
});
test('HTTP project deletion cleans its conversation files, retains project workspace and exposes completion honestly', async t => {
  const f = fixture(t), app = createServer({ stateFile: f.store.file, ticks: false, runtime: false }); await app.initializer.close();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/projects/${f.project.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.cleanup.status, 'completed');
  assert.equal(existsSync(join(f.store.file + '.rna', f.session.id)), false); assert.equal(existsSync(join(f.store.file + '.rna', f.other.id)), false); assert.equal(readFileSync(join(f.dir, 'project.txt'), 'utf8'), 'keep project file');
});
test('direct HTTP wait and retry callers cannot exceed the shared cleanup concurrency limit', async t => {
  const f = fixture(t), firstSession = f.store.createSession({}), secondSession = f.store.createSession({}), third = f.store.createSession({});
  const gates = new Map([firstSession.id, secondSession.id, third.id].map(id => [id, hold()])); let active = 0, peak = 0;
  const service = new SessionDeletionService(f.store, { executor: { running: new Map(), memorySync: { async drainSession(id) { peak = Math.max(peak, ++active); await gates.get(id).promise; active--; } } } });
  t.after(async () => { for (const gate of gates.values()) gate.resolve(); await service.close(); });
  for (const session of [firstSession, secondSession, third]) f.store.deleteSession(session.id);
  const first = service.wait(firstSession.id), second = service.wait(secondSession.id);
  assert.equal((await service.clean(third.id, { retry: true })).status, 'pending');
  assert.equal(peak, 2); assert.equal(service.running.size, 2);
  gates.get(firstSession.id).resolve(); await first; await new Promise(resolve => setImmediate(resolve));
  assert.ok(service.running.has(third.id)); assert.equal(peak, 2);
  gates.get(secondSession.id).resolve(); gates.get(third.id).resolve(); await second; await service.wait(third.id);
  assert.equal(service.status(third.id).status, 'completed');
});
// C5 probe summaries quote the user's requests (A3 template): a deleted conversation's go with it, as its effort
// captures do; a deleted project's conversations each purge theirs, and the sweep catches any written after a purge.
test('deleting a conversation or its project removes the compaction-fork probe summaries of it and keeps the others', async t => {
  const f = fixture(t), root = join(`${f.store.file}.rna`, 'compaction-fork-probe'); mkdirSync(root, { recursive: true });
  const report = (id, points, summaries) => { writeFileSync(join(root, `${id}.json`), JSON.stringify({ id, points })); writeFileSync(join(root, `${id}.summaries.json`), JSON.stringify(summaries)); };
  report('probe-one', [{ id: 'a-c1', sessionId: f.session.id }, { id: 'b-r2', sessionId: f.other.id }], { 'a-c1': { fork: 'Checkpoint: the user asked "private request one"' }, 'b-r2': { fork: 'Checkpoint: other conversation' } });
  report('probe-two', [{ id: 'a-r3', sessionId: f.session.id }], { 'a-r3': { fork: 'Checkpoint: "private request two"', flat: 'flat' } });
  const service = new SessionDeletionService(f.store); t.after(() => service.close());
  f.store.deleteSession(f.session.id); assert.equal((await service.wait(f.session.id)).status, 'completed');
  assert.equal(service.record(f.session.id).removedProbeSummaries, 2);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'probe-one.summaries.json'), 'utf8')), { 'b-r2': { fork: 'Checkpoint: other conversation' } });
  assert.equal(existsSync(join(root, 'probe-two.summaries.json')), false, 'a file left empty is removed');
  assert.ok(existsSync(join(root, 'probe-one.json')) && existsSync(join(root, 'probe-two.json')), 'the reports (ids and numbers, no text) stay');
  f.store.deleteProject(f.project.id); assert.equal((await service.wait(f.other.id)).status, 'completed');
  assert.equal(existsSync(join(root, 'probe-one.summaries.json')), false, 'the project\'s last conversation took its summaries along');
});
