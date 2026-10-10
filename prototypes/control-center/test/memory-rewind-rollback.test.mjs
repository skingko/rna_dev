import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { RevocationDispatcher } from '../revocation-dispatcher.mjs';
import { deletionRecord } from '../session-deletion.mjs';
import { MemoryRewind, memoryBodyOf, memoryDiffOperations, undoOrder, rollbackOperations, rewoundMemoryUnits, recordRewoundMemory, captureRewoundMemory, UNITS_PER_ENTRY } from '../memory-rewind.mjs';
import { createFakeOpenViking } from './harness/fake-openviking.mjs';

// D5 (reference alignment X-7): a rewind reaches OpenViking. The remote session bound to each removed turn is deleted
// after the memories its archives created or changed are rolled back, only where they still hold exactly what the archive
// wrote (the diff's `after`); everything else is left alone and reported, and nothing is deleted that no diff names.
// A fake OpenViking with real state (test/harness/fake-openviking.mjs); no model.
const USER = 'alice';
const mine = project => `viking://user/${USER}/peers/forge-${project}/memories`;
const T0 = Date.parse('2026-10-05T10:00:00.000Z');

async function setup(t) {
  const ov = await createFakeOpenViking({ user: USER }), dir = mkdtempSync(join(tmpdir(), 'rna-memory-rewind-rollback-')), store = new Store(join(dir, 'state.json'));
  store.configurationService.update({ memory: { endpoint: ov.endpoint } });
  const { project, session } = store.createProject({ name: 'Rewind rollback', workspace: dir, initiative: { enabled: false } });
  const clock = { now: T0 }, rewind = new MemoryRewind(store, { deadlineMs: 20000 });
  const dispatcher = new RevocationDispatcher(store, { decisions: { enabled: () => false }, now: () => clock.now, auditIntervalMs: 0 });
  dispatcher.register(rewind.revocationHandler());
  t.after(async () => { await dispatcher.close(); await new Promise(resolve => setTimeout(resolve, 10)); await ov.close(); rmSync(dir, { recursive: true, force: true }); });
  const f = { ov, store, project, session, rewind, dispatcher, clock, dir, ns: mine(project.id), turns: [] };
  f.current = () => store.state.sessions.find(row => row.id === session.id);
  f.entries = () => store.state.projects.find(row => row.id === project.id).mind?.revocations?.filter(row => row.type === 'message_rewound') ?? [];
  f.binding = sessionId => store.state.projects.find(row => row.id === project.id).memorySessions.find(row => row.sessionId === sessionId);
  /** A turn whose memory write committed an archive in its own remote session; `extraction` is what that commit's long-term step wrote. */
  f.turn = async (text, extraction, { startedAt = T0 + f.turns.length * 60000 } = {}) => {
    const turnId = randomUUID();
    store.mutate(state => { state.sessions.find(row => row.id === session.id).turns.push({ id: turnId, status: 'completed', createdAt: new Date(startedAt).toISOString(), startedAt: new Date(startedAt).toISOString() }); });
    const service = store.memoryService, binding = await service.createSession(project.id, { sourceSessionId: session.id, turnId });
    ov.extraction = () => extraction;
    await service.sessionMessages(project.id, binding.sessionId, { messages: [{ role: 'user', content: text }] });
    const committed = await service.sessionCommit(project.id, binding.sessionId), task = await service.sessionTask(project.id, binding.sessionId, committed.result.task_id);
    store.mutate(state => { const turn = state.sessions.find(row => row.id === session.id).turns.find(row => row.id === turnId); turn.memoryWrite = { status: 'completed', sessionId: binding.sessionId, taskId: committed.result.task_id, archiveUri: task.archiveUri, ...(task.memoryDiffUri ? { memoryDiffUri: task.memoryDiffUri } : {}), connectionFingerprint: binding.connectionFingerprint }; });
    const row = { turnId, sessionId: binding.sessionId, archiveUri: task.archiveUri };
    f.turns.push(row);
    return row;
  };
  /** A second commit in the same remote session (a turn with checkpoints): its own archive and diff. */
  f.commitAgain = async (row, text, extraction) => {
    const service = store.memoryService; ov.extraction = () => extraction;
    await service.sessionMessages(project.id, row.sessionId, { messages: [{ role: 'user', content: text }] });
    const committed = await service.sessionCommit(project.id, row.sessionId), task = await service.sessionTask(project.id, row.sessionId, committed.result.task_id);
    return task.archiveUri;
  };
  /** The rewind's transaction: the removed turns' remote sessions are recorded, then the turns go. */
  f.cut = (...rows) => {
    let units;
    store.mutate(state => {
      const current = state.sessions.find(row => row.id === session.id), project = state.projects.find(row => row.id === current.projectId), turnIds = new Set(rows.map(row => row.turnId));
      units = rewoundMemoryUnits(project, current, { turnIds, itemIds: new Set() });
      recordRewoundMemory(project, current.id, units, { now: clock.now });
      current.turns = current.turns.filter(turn => !turnIds.has(turn.id));
    });
    return units;
  };
  f.settle = async () => { await dispatcher.idle(); };
  return f;
}
const diffUri = row => `${row.archiveUri}/memory_diff.json`;

// ------------------------------------------------------------------------------------------------ pure pieces
test('a memory file’s body is what OpenViking reads: the file without its MEMORY_FIELDS comment, stripped', () => {
  const raw = 'Prefers past tense.\n\n<!-- MEMORY_FIELDS\n{\n  "version": 2\n}\n-->';
  assert.equal(memoryBodyOf(raw), 'Prefers past tense.');
  assert.equal(memoryBodyOf('  plain body \n'), 'plain body');
  assert.equal(memoryBodyOf('<!-- MEMORY_FIELDS\n{"a": 1}\n-->'), '', 'a file that is only its fields has an empty body');
  assert.equal(memoryBodyOf(undefined), '');
});

test('a memory diff is read into operations; anything that is not a diff, and an operation with no uri, are not', () => {
  const diff = { archive_uri: 'x', operations: { adds: [{ uri: 'a', memory_type: 'events', after: 'A' }, { memory_type: 'events', after: 'no uri' }], updates: [{ uri: 'u', before: 'B', after: 'C' }, { uri: 'v', before: 7, after: null }], deletes: [{ uri: 'd', deleted_content: 'D' }] } };
  assert.deepEqual(memoryDiffOperations(JSON.stringify(diff), { archive: 'archive_001' }).map(op => [op.kind, op.uri, op.before, op.after, op.memoryType, op.archive]), [
    ['add', 'a', undefined, 'A', 'events', 'archive_001'], ['update', 'u', 'B', 'C', undefined, 'archive_001'], ['update', 'v', undefined, undefined, undefined, 'archive_001'], ['delete', 'd', undefined, undefined, undefined, 'archive_001'],
  ]);
  for (const text of ['not json', '[]', '{}', '{"operations": []}', 'null']) assert.equal(memoryDiffOperations(text), null, text);
});

test('rollbackOperations: byte-equal to `after` rolls back; everything else is left alone and named; a change between the two reads wins', async () => {
  const files = new Map([['m/add-same', 'A'], ['m/add-changed', 'A+'], ['m/upd-same', 'C'], ['m/upd-back', 'B'], ['m/upd-changed', 'D'], ['m/upd-nobefore', 'C'], ['m/empty-after', ''], ['m/race', 'A']]);
  const writes = [], reads = new Map();
  const io = {
    inScope: uri => uri.startsWith('m/'),
    read: async uri => { reads.set(uri, (reads.get(uri) ?? 0) + 1); if (uri === 'm/race' && reads.get(uri) === 2) files.set(uri, 'someone else'); return files.has(uri) ? { body: files.get(uri) } : { absent: true }; },
    remove: async uri => { writes.push(['remove', uri]); files.delete(uri); return 'deleted'; },
    restore: async (uri, before) => { writes.push(['restore', uri, before]); files.set(uri, before); return 'restored'; },
  };
  const ops = [
    { kind: 'add', uri: 'm/add-same', after: 'A' }, { kind: 'add', uri: 'm/add-changed', after: 'A' }, { kind: 'add', uri: 'm/add-gone', after: 'A' },
    { kind: 'update', uri: 'm/upd-same', before: 'B', after: 'C' }, { kind: 'update', uri: 'm/upd-back', before: 'B', after: 'C' }, { kind: 'update', uri: 'm/upd-changed', before: 'B', after: 'C' },
    { kind: 'update', uri: 'm/upd-nobefore', after: 'C' }, { kind: 'add', uri: 'm/empty-after', after: '' }, { kind: 'add', uri: 'elsewhere/x', after: 'A' }, { kind: 'delete', uri: 'm/was-deleted' }, { kind: 'add', uri: 'm/race', after: 'A' },
  ];
  const results = await rollbackOperations(ops, { ...io });
  assert.deepEqual(results.map(row => [row.uri, row.outcome]), [
    ['m/add-same', 'deleted'], ['m/add-changed', 'changed'], ['m/add-gone', 'absent'], ['m/upd-same', 'restored'], ['m/upd-back', 'already_restored'], ['m/upd-changed', 'changed'],
    ['m/upd-nobefore', 'before_unknown'], ['m/empty-after', 'after_unknown'], ['elsewhere/x', 'outside_scope'], ['m/was-deleted', 'deleted_by_archive'], ['m/race', 'changed'],
  ]);
  assert.deepEqual(writes, [['remove', 'm/add-same'], ['restore', 'm/upd-same', 'B']], 'only what the diff names and still equals `after` was written');
  assert.equal(files.get('m/add-changed'), 'A+'); assert.equal(files.get('m/upd-changed'), 'D'); assert.equal(files.get('m/race'), 'someone else');
  // The dry run writes nothing and says what it would do.
  writes.length = 0; files.set('m/add-same', 'A'); files.set('m/upd-same', 'C');
  const dry = await rollbackOperations(ops.slice(0, 4), { ...io, apply: false });
  assert.deepEqual(dry.map(row => row.outcome), ['would_delete', 'changed', 'absent', 'would_restore']); assert.deepEqual(writes, []);
});

// ------------------------------------------------------------------------------------------ the remote session
test('a rewind rolls back the memories its archives wrote where they are untouched, leaves the rest, deletes only what the diffs name, then the session', async t => {
  const f = await setup(t), { ov } = f;
  const event = `${f.ns}/events/2026/10/05/dinner_proposed.md`, tea = `${f.ns}/preferences/tea.md`, coffee = `${f.ns}/preferences/coffee.md`, unrelated = `${f.ns}/preferences/unrelated.md`;
  ov.memory(coffee, 'Likes coffee.'); ov.memory(unrelated, 'Not from any rewound turn.');
  const turn = await f.turn('I like tea more than coffee, and Friday dinner is proposed.', { adds: [{ uri: event, body: 'A Friday dinner was proposed.', type: 'events' }, { uri: tea, body: 'Likes tea.', type: 'preferences' }], updates: [{ uri: coffee, body: 'Likes coffee less than tea.', type: 'preferences' }] });
  assert.deepEqual(ov.tagsOf(event), [`project=${f.project.id}`, `rna_turn=${turn.turnId}`], 'its events carry the turn');
  // Since then the user edited one of the memories the turn added.
  ov.memory(tea, 'Likes tea, with milk.');
  const units = f.cut(turn);
  assert.deepEqual(units.map(unit => [unit.sessionId, unit.turnId, unit.state]), [[turn.sessionId, turn.turnId, 'pending']]);
  assert.equal(f.entries().length, 1); assert.equal(f.entries()[0].sessionId, f.session.id); assert.equal(JSON.stringify(f.entries()[0].memory).includes('tea'), false, 'the entry holds identifiers, never memory text');
  const before = ov.calls.length;
  await f.settle();
  const entry = f.entries()[0];
  assert.ok(entry.settledAt, 'settled');
  assert.equal(ov.bodyOf(event), null, 'the untouched event is gone'); assert.equal(ov.bodyOf(tea), 'Likes tea, with milk.', 'the edited memory stays');
  assert.equal(ov.bodyOf(coffee), 'Likes coffee.', 'the update is undone: its `before` is back'); assert.match(ov.resources.get(coffee), /MEMORY_FIELDS/, 'and the file keeps its fields comment');
  assert.equal(ov.bodyOf(unrelated), 'Not from any rewound turn.');
  assert.equal(ov.sessions.has(turn.sessionId), false, 'the remote session is deleted'); assert.equal(f.binding(turn.sessionId).status, 'deleted');
  assert.deepEqual(entry.result.openviking.totals, { deleted: 1, restored: 1, changed: 1 });
  assert.deepEqual(entry.result.openviking.left, [{ op: 'add', uri: tea, outcome: 'changed' }], 'what was left alone is reported');
  assert.equal(entry.result.violations, 0);
  assert.ok(f.store.state.projects.find(row => row.id === f.project.id).memorySummary.revision >= 1, 'the memory page’s content-changed signal moved');
  // The conversation lives on: deleting it later does not try the sessions this rewind already removed again.
  assert.deepEqual(deletionRecord(f.store, f.current()).bindings.map(row => row.sessionId), [], 'no removed session is captured again by a later deletion');
  const written = ov.calls.slice(before).filter(call => call.method !== 'GET').map(call => `${call.method} ${call.path}${call.query.uri ? ` ${call.query.uri}` : ''}${call.body?.uri ? ` ${call.body.uri}` : ''}`);
  assert.deepEqual(written, [`POST /api/v1/content/write ${coffee}`, `DELETE /api/v1/fs ${event}`, `DELETE /api/v1/sessions/${turn.sessionId}`], 'updates are undone before adds, the session goes last, nothing else was written');
});

test('chained updates unwind newest first; a later extraction that kept its change keeps it', async t => {
  // Three turns write one memory: an add, then two updates.
  const chain = async () => {
    const f = await setup(t), uri = `${f.ns}/preferences/style.md`;
    const a = await f.turn('Short chapters.', { adds: [{ uri, body: 'Short chapters.', type: 'preferences' }] });
    const b = await f.turn('Actually long chapters.', { updates: [{ uri, body: 'Long chapters.', type: 'preferences' }] });
    const c = await f.turn('Long, with a recap.', { updates: [{ uri, body: 'Long chapters with a recap.', type: 'preferences' }] });
    return { f, uri, a, b, c };
  };
  // Only the first is removed (a later turn updated the memory since): the add no longer matches, so it stays.
  { const { f, uri, a } = await chain(); f.cut(a); await f.settle();
    assert.equal(f.ov.bodyOf(uri), 'Long chapters with a recap.', 'a later extraction changed it: left alone'); assert.deepEqual(f.entries()[0].result.openviking.totals, { changed: 1 }); }
  // The last two are removed: both updates are undone, newest first, back to what the first turn wrote.
  { const { f, uri, b, c } = await chain(); f.cut(b, c); await f.settle();
    assert.equal(f.ov.bodyOf(uri), 'Short chapters.'); assert.deepEqual(f.entries()[0].result.openviking.totals, { restored: 2 });
    assert.deepEqual(f.ov.of('/api/v1/content/write', 'POST').map(call => call.body.content).slice(-2), ['Long chapters.', 'Short chapters.'], 'newest first'); }
  // All three: the add is undone last, once the file holds what the first turn wrote.
  { const { f, uri, a, b, c } = await chain(); f.cut(a, b, c); await f.settle();
    assert.equal(f.ov.bodyOf(uri), null, 'the whole chain is undone: the memory the first turn created is gone'); assert.deepEqual(f.entries()[0].result.openviking.totals, { restored: 2, deleted: 1 }); }
  // The oldest turn's session is processed after the newer ones: sessions are settled newest turn first.
  { const { f, a, b, c } = await chain(); f.cut(c, a, b); await f.settle();
    assert.deepEqual(f.ov.deletedSessions, [c.sessionId, b.sessionId, a.sessionId]); }
});

test('a memory outside the project’s own peer namespace, a deleted one and one without `after` are never touched', async t => {
  const f = await setup(t), { ov } = f;
  const outside = `viking://user/${USER}/memories/profile.md`, own = `${f.ns}/preferences/ok.md`, removedByArchive = `${f.ns}/preferences/merged.md`;
  ov.memory(outside, 'Profile of the user.'); ov.memory(removedByArchive, 'Was merged elsewhere.');
  const turn = await f.turn('Anything.', { adds: [{ uri: outside, body: 'Profile of the user.', type: 'profile' }, { uri: own, body: 'Own memory.', type: 'preferences' }], deletes: [{ uri: removedByArchive, content: 'Was merged elsewhere.', type: 'preferences' }] });
  ov.memory(removedByArchive, 'Was merged elsewhere.');
  f.cut(turn); await f.settle();
  assert.equal(ov.bodyOf(outside), 'Profile of the user.', 'outside the namespace'); assert.equal(ov.bodyOf(own), null);
  assert.equal(ov.bodyOf(removedByArchive), 'Was merged elsewhere.', 'a memory the archive deleted is not written back');
  assert.deepEqual(f.entries()[0].result.openviking.left.map(row => [row.uri, row.outcome]).sort(), [[outside, 'outside_scope'], [removedByArchive, 'deleted_by_archive']].sort());
  assert.equal(ov.deletedResources.includes(outside), false);
});

test('a service failure in the middle keeps the session and its diffs; the retry finishes without doing anything twice', async t => {
  const f = await setup(t), { ov } = f;
  const event = `${f.ns}/events/2026/10/05/dinner.md`, pref = `${f.ns}/preferences/tea.md`;
  ov.memory(pref, 'Likes coffee.');
  const turn = await f.turn('Tea and dinner.', { adds: [{ uri: event, body: 'Dinner proposed.', type: 'events' }], updates: [{ uri: pref, body: 'Likes tea.', type: 'preferences' }] });
  ov.fail = call => call.method === 'DELETE' && call.path === '/api/v1/fs' ? 503 : null;
  f.cut(turn); await f.settle();
  let entry = f.entries()[0];
  assert.equal(entry.settledAt, undefined, 'not settled'); assert.equal(entry.attempts, 1); assert.ok(entry.retryAt);
  assert.equal(ov.sessions.has(turn.sessionId), true, 'the session, with its diff, is still there'); assert.equal(f.binding(turn.sessionId).status, 'ready');
  assert.equal(ov.bodyOf(event), 'Dinner proposed.');
  ov.fail = null; f.clock.now = Date.parse(entry.retryAt) + 1; await f.dispatcher.drain(); await f.settle();
  entry = f.entries()[0];
  assert.ok(entry.settledAt); assert.equal(ov.sessions.has(turn.sessionId), false); assert.equal(ov.bodyOf(event), null); assert.equal(ov.bodyOf(pref), 'Likes coffee.');
  assert.equal(ov.of('/api/v1/content/write', 'POST').filter(call => call.body.uri === pref && call.body.content === 'Likes coffee.').length, 1, 'the update was restored once (the retry found it restored)');
});

test('a failure on a newer turn holds every older one back, so the chain still unwinds in order on the retry', async t => {
  const f = await setup(t), { ov } = f, uri = `${f.ns}/preferences/order.md`;
  const older = await f.turn('Short.', { adds: [{ uri, body: 'Short.', type: 'preferences' }] });
  const newer = await f.turn('Long.', { updates: [{ uri, body: 'Long.', type: 'preferences' }] });
  ov.fail = call => call.method === 'POST' && call.path === '/api/v1/content/write' ? 503 : null;
  f.cut(older, newer); await f.settle();
  assert.equal(ov.sessions.has(newer.sessionId), true); assert.equal(ov.sessions.has(older.sessionId), true, 'the older turn was not settled behind the failed newer one');
  assert.equal(ov.bodyOf(uri), 'Long.'); assert.equal(f.entries()[0].settledAt, undefined);
  ov.fail = null; f.clock.now = Date.parse(f.entries()[0].retryAt) + 1; await f.dispatcher.drain(); await f.settle();
  assert.equal(ov.bodyOf(uri), null, 'newer undone first, then the older add matched and went'); assert.equal(ov.sessions.size, 0);
  assert.deepEqual(f.entries()[0].result.openviking.totals, { restored: 1, deleted: 1 });
});

test('the dry run plans a chain of removed turns the way the real run unwinds it', async t => {
  const f = await setup(t), { ov } = f, uri = `${f.ns}/preferences/chain.md`;
  const a = await f.turn('Short.', { adds: [{ uri, body: 'Short.', type: 'preferences' }] }), b = await f.turn('Long.', { updates: [{ uri, body: 'Long.', type: 'preferences' }] });
  const project = () => f.store.state.projects.find(row => row.id === f.project.id);
  const units = rewoundMemoryUnits(project(), f.current(), { turnIds: new Set([a.turnId, b.turnId]), itemIds: new Set() });
  const before = ov.calls.length, plan = await f.rewind.preview(project(), f.session.id, units);
  assert.deepEqual(plan.totals, { would_restore: 1, would_delete: 1 }, 'the older add is planned against what the newer update’s rollback leaves');
  assert.deepEqual(ov.calls.slice(before).filter(call => call.method !== 'GET'), [], 'and nothing was written');
  f.cut(a, b); await f.settle();
  assert.deepEqual(f.entries()[0].result.openviking.totals, { restored: 1, deleted: 1 }, 'the real run did exactly what was planned'); assert.equal(ov.bodyOf(uri), null);
});

test('a commit task still running is cancelled before its archives are read; the diff it wrote at the end is rolled back too', async t => {
  const f = await setup(t), { ov } = f, uri = `${f.ns}/preferences/late.md`;
  const turn = await f.turn('Late extraction.', { adds: [{ uri, body: 'Late memory.', type: 'preferences' }] });
  // The task finished after the turn was cut: the host only learns that when it cleans up.
  const task = [...ov.tasks.values()].find(row => row.resource_id === turn.sessionId); task.status = 'running';
  f.cut(turn);
  await f.settle();
  assert.equal(ov.of(`/api/v1/tasks/${task.task_id}/cancel`, 'POST').length, 1, 'the running task was cancelled first');
  assert.equal(ov.bodyOf(uri), null); assert.equal(ov.sessions.has(turn.sessionId), false);
});

test('another connection or account is never touched: the session stays, the entry settles with the reason, and the assertion reports it', async t => {
  const f = await setup(t), { ov } = f, other = await createFakeOpenViking({ user: USER });
  t.after(() => other.close());
  const uri = `${f.ns}/preferences/x.md`, turn = await f.turn('Anything.', { adds: [{ uri, body: 'X.', type: 'preferences' }] });
  f.store.configurationService.update({ memory: { endpoint: other.endpoint } });
  f.cut(turn); await f.settle();
  const entry = f.entries()[0];
  assert.ok(entry.settledAt, 'no retry can change it'); assert.equal(ov.bodyOf(uri), 'X.'); assert.equal(ov.sessions.has(turn.sessionId), true);
  assert.equal(other.writes().length, 0); assert.deepEqual(ov.writes().filter(call => call.method === 'DELETE'), []);
  assert.deepEqual(entry.result.openviking.kept, [{ sessionId: turn.sessionId, code: 'MEMORY_CLEANUP_CONNECTION_CHANGED' }]);
  assert.deepEqual(entry.result.violations, [{ subsystem: 'memory', collection: 'remote_sessions', id: turn.sessionId, why: 'MEMORY_CLEANUP_CONNECTION_CHANGED' }]);
});

test('the dry run reads and reports, and writes nothing: no delete, no restore, no cancel, no session removed', async t => {
  const f = await setup(t), { ov } = f;
  const event = `${f.ns}/events/2026/10/05/dinner.md`, tea = `${f.ns}/preferences/tea.md`, coffee = `${f.ns}/preferences/coffee.md`;
  ov.memory(coffee, 'Likes coffee.');
  const turn = await f.turn('Tea.', { adds: [{ uri: event, body: 'Dinner.', type: 'events' }, { uri: tea, body: 'Likes tea.', type: 'preferences' }], updates: [{ uri: coffee, body: 'Likes tea more.', type: 'preferences' }] });
  ov.memory(tea, 'Likes tea, edited.');
  const units = rewoundMemoryUnits(f.store.state.projects.find(row => row.id === f.project.id), f.current(), { turnIds: new Set([turn.turnId]), itemIds: new Set() });
  const before = ov.calls.length, plan = await f.rewind.preview(f.store.state.projects.find(row => row.id === f.project.id), f.session.id, units);
  assert.deepEqual(ov.calls.slice(before).filter(call => call.method !== 'GET'), [], 'no write of any kind');
  assert.equal(plan.sessions.length, 1); assert.equal(plan.sessions[0].sessionId, turn.sessionId);
  assert.deepEqual(plan.totals, { would_delete: 1, changed: 1, would_restore: 1 }); assert.deepEqual(plan.sessions[0].left, [{ op: 'add', uri: tea, outcome: 'changed' }]);
  assert.equal(ov.sessions.has(turn.sessionId), true); assert.equal(ov.bodyOf(event), 'Dinner.'); assert.equal(ov.bodyOf(coffee), 'Likes tea more.');
  assert.equal(f.entries().length, 0, 'nothing was recorded either');
  // A service that cannot be asked is said so, per session.
  ov.outage = true;
  const down = await f.rewind.preview(f.store.state.projects.find(row => row.id === f.project.id), f.session.id, units);
  assert.deepEqual(down.sessions.map(row => row.error), ['MEMORY_CLEANUP_UNAVAILABLE']);
});

test('events of a removed turn that no diff lists are found by their tag and reported, never deleted', async t => {
  const f = await setup(t), { ov } = f;
  const listed = `${f.ns}/events/2026/10/05/listed.md`, stray = `${f.ns}/events/2026/10/05/stray.md`, foreign = `${f.ns}/events/2026/10/05/foreign.md`;
  const turn = await f.turn('Dinner.', { adds: [{ uri: listed, body: 'Listed.', type: 'events' }] });
  ov.memory(stray, 'Not in the diff.', [`project=${f.project.id}`, `rna_turn=${turn.turnId}`]); ov.memory(foreign, 'Another turn’s.', [`project=${f.project.id}`, `rna_turn=${randomUUID()}`]);
  f.cut(turn); await f.settle();
  const report = f.entries()[0].result.openviking;
  assert.deepEqual(report.unlisted, [stray]); assert.equal(ov.bodyOf(stray), 'Not in the diff.'); assert.equal(ov.bodyOf(foreign), 'Another turn’s.'); assert.equal(ov.bodyOf(listed), null);
});

test('a session with no diff (no long-term step ran, or the server writes none) is deleted without touching any memory', async t => {
  const f = await setup(t), { ov } = f, keep = `${f.ns}/preferences/keep.md`;
  ov.memory(keep, 'Stays.');
  const turn = await f.turn('Nothing extracted.', null);
  ov.extraction = null;
  f.cut(turn); await f.settle();
  assert.equal(ov.bodyOf(keep), 'Stays.'); assert.equal(ov.sessions.has(turn.sessionId), false);
  assert.deepEqual(f.entries()[0].result.openviking.totals, {}); assert.equal(ov.of('/api/v1/fs', 'DELETE').length, 0);
  assert.equal(f.store.state.projects.find(row => row.id === f.project.id).memorySummary?.revision ?? 0, 0, 'nothing changed, so the content-changed signal did not move');
});

test('a diff too large to read, or one that names another archive, is reported and no memory is rolled back on its word', async t => {
  const f = await setup(t), { ov } = f, uri = `${f.ns}/preferences/guarded.md`;
  const turn = await f.turn('Guarded.', { adds: [{ uri, body: 'Guarded.', type: 'preferences' }] });
  const diff = JSON.parse(ov.resources.get(diffUri(turn)));
  ov.resources.set(diffUri(turn), JSON.stringify({ ...diff, archive_uri: `viking://user/${USER}/sessions/rna-another/history/archive_1` }));
  f.cut(turn); await f.settle();
  assert.equal(ov.bodyOf(uri), 'Guarded.'); assert.deepEqual(f.entries()[0].result.openviking.totals, {});
  const unit = f.entries()[0].memory[0]; assert.deepEqual(unit.report.unreadable, [{ archive: 'archive_1', why: 'diff_of_another_archive' }]);
  assert.deepEqual(f.entries()[0].result.openviking.unreadable, [{ sessionId: turn.sessionId, archive: 'archive_1', why: 'diff_of_another_archive' }], 'and the entry says so');
  // One bigger than the host reads in one response is not read at all.
  const g = await setup(t), big = `${g.ns}/preferences/big.md`, row = await g.turn('Big.', { adds: [{ uri: big, body: 'Big.', type: 'preferences' }] });
  g.ov.resources.set(diffUri(row), `{"operations":{"adds":[{"uri":"${big}","after":"Big."}]},"pad":"${'x'.repeat(1100000)}"}`);
  g.cut(row); await g.settle();
  assert.equal(g.ov.bodyOf(big), 'Big.'); assert.deepEqual(g.entries()[0].memory[0].report.unreadable, [{ archive: 'archive_1', why: 'diff_too_large' }]);
  assert.equal(g.ov.sessions.has(row.sessionId), false, 'the session still goes: the memories stay, and the report says why');
});

test('a turn with several archives in one remote session unwinds them newest first', async t => {
  const f = await setup(t), { ov } = f, uri = `${f.ns}/preferences/outline.md`;
  const turn = await f.turn('Outline in three parts.', { adds: [{ uri, body: 'Outline: three parts.', type: 'preferences' }] });
  await f.commitAgain(turn, 'Make it four parts.', { updates: [{ uri, body: 'Outline: four parts.', type: 'preferences' }] });
  assert.equal(ov.bodyOf(uri), 'Outline: four parts.');
  f.cut(turn); await f.settle();
  assert.equal(ov.bodyOf(uri), null, 'the second archive’s update is undone first, then the first archive’s add matches and goes');
  assert.deepEqual(f.entries()[0].result.openviking.totals, { restored: 1, deleted: 1 }); assert.equal(f.entries()[0].memory[0].report.archives, 2);
});

test('one archive that changed the same memory in several batches unwinds in the reverse order the diff lists them', async t => {
  // OpenViking merges the diffs of an extraction's batches by concatenation: adds, then updates, each in the order they happened.
  assert.deepEqual(undoOrder([{ kind: 'add', uri: 'a1' }, { kind: 'add', uri: 'a2' }, { kind: 'update', uri: 'u1' }, { kind: 'update', uri: 'u2' }, { kind: 'delete', uri: 'd1' }]).map(op => op.uri), ['u2', 'u1', 'a2', 'a1', 'd1']);
  const f = await setup(t), { ov } = f, uri = `${f.ns}/preferences/batched.md`;
  const turn = await f.turn('Batched.', { adds: [{ uri, body: 'Version A.', type: 'preferences' }] });
  // Batch one added the memory (A), batch two changed it (A to B), batch three again (B to C): the merged diff lists all three.
  const diff = JSON.parse(ov.resources.get(diffUri(turn)));
  diff.operations.updates = [{ uri, memory_type: 'preferences', before: 'Version A.', after: 'Version B.' }, { uri, memory_type: 'preferences', before: 'Version B.', after: 'Version C.' }];
  ov.resources.set(diffUri(turn), JSON.stringify(diff)); ov.memory(uri, 'Version C.');
  f.cut(turn); await f.settle();
  assert.equal(ov.bodyOf(uri), null, 'C back to B, B back to A, then the add matched and went');
  assert.deepEqual(f.entries()[0].result.openviking.totals, { restored: 2, deleted: 1 });
  assert.deepEqual(ov.of('/api/v1/content/write', 'POST').filter(call => call.body.uri === uri).map(call => call.body.content).slice(-2), ['Version B.', 'Version A.']);
});

test('an archive the service’s listing misses is still found through the archive the host recorded', async t => {
  const f = await setup(t), { ov } = f, uri = `${f.ns}/preferences/hinted.md`;
  const turn = await f.turn('Hinted.', { adds: [{ uri, body: 'Hinted.', type: 'preferences' }] });
  ov.listOverride = listed => listed.endsWith('/history') ? [] : undefined;
  f.cut(turn); await f.settle();
  assert.equal(ov.bodyOf(uri), null, 'the recorded archive gave the diff; deleting the session did not make the memory unreachable');
  assert.equal(ov.sessions.has(turn.sessionId), false);
});

test('a service that refuses to show the diffs to this key is reported, not retried: nothing is rolled back on what cannot be read', async t => {
  const f = await setup(t), { ov } = f, uri = `${f.ns}/preferences/refused.md`;
  const turn = await f.turn('Refused.', { adds: [{ uri, body: 'Refused.', type: 'preferences' }] });
  ov.fail = call => call.method === 'GET' && call.path === '/api/v1/content/read' && call.query.uri?.endsWith('/memory_diff.json') ? 403 : null;
  f.cut(turn); await f.settle();
  assert.ok(f.entries()[0].settledAt, 'no retry can change it'); assert.equal(ov.bodyOf(uri), 'Refused.');
  assert.deepEqual(f.entries()[0].result.openviking.unreadable, [{ sessionId: turn.sessionId, archive: 'archive_1', why: 'HTTP_403' }]);
  assert.equal(ov.sessions.has(turn.sessionId), false, 'the session still goes (the memories stay, and the report says why)');
  // A refusal to write is per memory: it is left and named, the others go on.
  const g = await setup(t), a = `${g.ns}/preferences/a.md`, b = `${g.ns}/preferences/b.md`, row = await g.turn('Two.', { adds: [{ uri: a, body: 'A.', type: 'preferences' }, { uri: b, body: 'B.', type: 'preferences' }] });
  g.ov.fail = call => call.method === 'DELETE' && call.path === '/api/v1/fs' && call.query.uri === a ? 403 : null;
  g.cut(row); await g.settle();
  assert.equal(g.ov.bodyOf(a), 'A.'); assert.equal(g.ov.bodyOf(b), null); assert.deepEqual(g.entries()[0].result.openviking.left, [{ op: 'add', uri: a, outcome: 'refused' }]);
});

// ------------------------------------------------------------------------------------------- what a rewind captures
test('capture: every segment and re-extraction session of a removed turn, settled evidence of a removed item, never a session already deleted or one still in flight', async t => {
  const f = await setup(t);
  const project = { memorySessions: [
    { sessionId: 'rna-a', status: 'ready', connectionFingerprint: 'fp', sourceSessionId: 's' }, { sessionId: 'rna-b', status: 'ready', sourceSessionId: 's' }, { sessionId: 'rna-gone', status: 'deleted' },
    { sessionId: 'rna-tagged', status: 'ready', turnId: 't1', sourceSessionId: 's' }, { sessionId: 'rna-kept', status: 'ready' }, { sessionId: 'rna-evidence', status: 'ready' }, { sessionId: 'rna-inflight', status: 'ready' },
  ] };
  const session = { id: 's', turns: [
    { id: 't1', startedAt: '2026-10-05T10:00:00.000Z', memoryWrite: { sessionId: 'rna-a', archiveUri: 'viking://user/alice/sessions/rna-a/history/archive_1', connectionFingerprint: 'fp', reextract: { previous: [{ sessionId: 'rna-b' }] } }, memoryCheckpoints: [{ id: 'c1', sessionId: 'rna-a' }, { id: 'c2', sessionId: 'rna-gone' }] },
    { id: 't2', startedAt: '2026-10-05T10:05:00.000Z', memoryWrite: { sessionId: 'rna-kept' } },
  ], memoryEvidenceOutbox: [
    { id: 'e1', status: 'completed', sessionId: 'rna-evidence', sourceRefs: [{ itemId: 'i9' }] }, { id: 'e2', status: 'polling', sessionId: 'rna-inflight', sourceRefs: [{ itemId: 'i9' }] }, { id: 'e3', status: 'completed', sessionId: 'rna-kept', sourceRefs: [{ itemId: 'i-other' }] },
  ] };
  const units = rewoundMemoryUnits(project, session, { turnIds: new Set(['t1']), itemIds: new Set(['i9']) });
  assert.deepEqual(units.map(unit => unit.sessionId).sort(), ['rna-a', 'rna-b', 'rna-evidence', 'rna-tagged']);
  assert.equal(units.find(unit => unit.sessionId === 'rna-a').fingerprint, 'fp'); assert.deepEqual(units.find(unit => unit.sessionId === 'rna-a').archives, ['viking://user/alice/sessions/rna-a/history/archive_1']);
  assert.equal(units.find(unit => unit.sessionId === 'rna-evidence').evidenceId, 'e1'); assert.ok(units.every(unit => unit.state === 'pending'));
  // A long rewind makes several entries (the entry is persisted state).
  const many = Array.from({ length: UNITS_PER_ENTRY * 2 + 1 }, (_, index) => ({ sessionId: `rna-${index}`, at: '2026-10-05T10:00:00.000Z', state: 'pending' }));
  f.store.mutate(state => { assert.equal(recordRewoundMemory(state.projects.find(row => row.id === f.project.id), 's', many, { now: T0 }).length, 3); });
  assert.deepEqual(f.entries().map(row => row.memory.length), [UNITS_PER_ENTRY, UNITS_PER_ENTRY, 1]);
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).mind.revocations = []; });
});

test('the remote session carries its turn as a tag only when the turn is one of the source conversation’s', async t => {
  const f = await setup(t), { ov } = f, service = f.store.memoryService;
  const row = await f.turn('Tagged.', null), bound = ov.sessions.get(row.sessionId).body;
  assert.deepEqual(bound.memory_extraction_config.events.tags, [`project=${f.project.id}`, `rna_turn=${row.turnId}`]); assert.equal(f.binding(row.sessionId).turnId, row.turnId);
  for (const turnId of [randomUUID(), 'not a valid id!', 42, null]) {
    const binding = await service.createSession(f.project.id, { sourceSessionId: f.session.id, turnId });
    assert.deepEqual(ov.sessions.get(binding.sessionId).body.memory_extraction_config.events.tags, [`project=${f.project.id}`], String(turnId)); assert.equal(f.binding(binding.sessionId).turnId, undefined);
  }
  const another = f.store.createSession({ projectId: f.project.id }), foreign = await service.createSession(f.project.id, { sourceSessionId: another.id, turnId: row.turnId });
  assert.deepEqual(ov.sessions.get(foreign.sessionId).body.memory_extraction_config.events.tags, [`project=${f.project.id}`], 'a turn of another conversation');
});

test('a rollback to a version without the handler and an upgrade again do not lose the work: its entry is settled behind our back and opens again', async t => {
  const f = await setup(t), { ov } = f, uri = `${f.ns}/preferences/old.md`;
  const turn = await f.turn('Old version.', { adds: [{ uri, body: 'Old version memory.', type: 'preferences' }] });
  f.cut(turn);
  // 0.68.0 settles a `message_rewound` entry without any handler for its `memory` (its mind handler settles nothing).
  const old = new RevocationDispatcher(f.store, { decisions: { enabled: () => false }, now: () => f.clock.now, auditIntervalMs: 0 });
  old.register({ name: 'mind', events: ['message_rewound'], settle: async () => null });
  await old.idle(); await old.close();
  assert.ok(f.entries()[0].settledAt, 'settled by the older version'); assert.equal(ov.bodyOf(uri), 'Old version memory.'); assert.equal(f.entries()[0].memory[0].state, 'pending');
  assert.equal(f.rewind.reopen(), 1); assert.equal(f.rewind.reopen(), 0, 'idempotent');
  await f.settle();
  assert.equal(ov.bodyOf(uri), null); assert.equal(ov.sessions.has(turn.sessionId), false); assert.ok(f.entries()[0].settledAt); assert.equal(f.entries()[0].memory[0].state, 'deleted');
  assert.equal(f.rewind.reopen(), 0, 'a finished entry stays finished');
  // One that ran out of attempts is tried again at the next start.
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).mind.revocations.push({ id: 'stuck', type: 'message_rewound', at: new Date(f.clock.now).toISOString(), sessionId: f.session.id, memory: [{ sessionId: 'rna-stuck', at: new Date(f.clock.now).toISOString(), state: 'pending' }], steps: { openviking: 'failed' }, attempts: 5, failed: true, failure: 'x' }); });
  assert.equal(f.rewind.reopen(), 1); assert.deepEqual([f.entries().at(-1).failed, f.entries().at(-1).attempts], [undefined, 0]);
});

test('the handler answers message_rewound only: deleting a whole conversation keeps its extracted memory', () => {
  const handler = new MemoryRewind({}).revocationHandler();
  assert.deepEqual(handler.events, ['message_rewound']); assert.equal(handler.name, 'openviking');
});

// ------------------------------------------------------------------------------------- review: retries, order, waits
const failOn = (method, path, uri) => call => call.method === method && call.path === path && (uri === undefined || (call.query.uri ?? call.body?.uri) === uri) ? 503 : null;

test('with the dispatcher running as in production, a service failure in the middle of a long entry costs one attempt and waits out its backoff', async t => {
  // Every unit the handler settles is saved (a store change), and in production a store change kicks the dispatcher: a second
  // run of the same entry queued behind the first one used to count an attempt of its own and ignore the backoff.
  const f = await setup(t), { ov } = f, rows = [], uri = index => `${f.ns}/preferences/m${index}.md`;
  for (let index = 0; index < 6; index++) rows.push(await f.turn(`Turn ${index}.`, { adds: [{ uri: uri(index), body: `M${index}.`, type: 'preferences' }] }));
  let runs = 0; const settleEntry = f.dispatcher.settleEntry.bind(f.dispatcher); f.dispatcher.settleEntry = (...args) => { runs++; return settleEntry(...args); };
  f.dispatcher.start();
  ov.fail = failOn('DELETE', '/api/v1/fs', uri(1));   // turns settle newest first: the fifth one fails
  f.cut(...rows); await f.settle(); await new Promise(resolve => setTimeout(resolve, 150)); await f.settle();
  let entry = f.entries()[0];
  assert.equal(runs, 1, 'the entry was run once, not queued again behind itself by each save of a unit');
  assert.equal(entry.attempts, 1, 'one failure, one attempt'); assert.equal(entry.failed, undefined, 'not given up'); assert.equal(entry.retryAt, new Date(T0 + 120000).toISOString(), 'the first backoff');
  assert.deepEqual(entry.memory.map(unit => unit.state).sort(), ['deleted', 'deleted', 'deleted', 'deleted', 'pending', 'pending']);
  assert.equal(ov.of('/api/v1/fs', 'DELETE').filter(call => call.query.uri === uri(1)).length, 1, 'the failing request was sent once, not once per queued run');
  ov.fail = null; f.clock.now = Date.parse(entry.retryAt) + 1; await f.dispatcher.drain(); await f.settle();
  entry = f.entries()[0];
  assert.ok(entry.settledAt); assert.equal(entry.attempts, 1); assert.equal(ov.sessions.size, 0);
  for (let index = 0; index < 6; index++) assert.equal(ov.bodyOf(uri(index)), null, `m${index}`);
});

test('a run queued behind another run of the same entry finds the backoff it left, and a forced run does not', async t => {
  const f = await setup(t), { ov } = f, uri = `${f.ns}/preferences/queued.md`;
  const turn = await f.turn('Queued.', { adds: [{ uri, body: 'Queued.', type: 'preferences' }] });
  ov.fail = failOn('DELETE', '/api/v1/fs', uri);
  f.cut(turn);
  const project = f.project.id, entry = f.entries()[0].id;
  const runs = await Promise.all([f.dispatcher.settle(project, entry), f.dispatcher.settle(project, entry), f.dispatcher.settle(project, entry)]);
  assert.deepEqual(runs.map(run => run === null), [false, true, true], 'only the first run did anything');
  assert.equal(f.entries()[0].attempts, 1);
  // The backoff is the dispatcher’s own: a caller that means it forces.
  const forced = await f.dispatcher.settle(project, entry, { force: true });
  assert.equal(forced.complete, false); assert.equal(f.entries()[0].attempts, 2);
  // An entry that ran out of attempts is left alone until it is reopened.
  f.store.mutate(state => { const row = state.projects.find(item => item.id === project).mind.revocations.find(item => item.id === entry); row.failed = true; });
  assert.equal(await f.dispatcher.settle(project, entry), null); assert.equal(f.entries()[0].attempts, 2);
});

test('an older entry never settles ahead of a newer one that is backing off: its session and diff stay until the newer turn’s change to the same memory is undone', async t => {
  const f = await setup(t), { ov } = f, uri = `${f.ns}/preferences/two-entries.md`;
  const older = await f.turn('Short.', { adds: [{ uri, body: 'Short.', type: 'preferences' }] }), newer = await f.turn('Long.', { updates: [{ uri, body: 'Long.', type: 'preferences' }] });
  // Two entries: two rewinds of one project, or the 40 sessions an entry holds. The newer turns' entry is the first one.
  f.cut(newer); f.cut(older);
  assert.equal(f.entries().length, 2);
  ov.fail = failOn('POST', '/api/v1/content/write', uri);
  await f.dispatcher.drain(); await f.settle();
  let [first, second] = f.entries();
  assert.equal(first.attempts, 1); assert.ok(first.retryAt, 'the newer entry backs off');
  assert.equal(ov.sessions.has(older.sessionId), true, 'the older turn’s session, with the diff its rollback needs, is still there');
  assert.equal(ov.bodyOf(uri), 'Long.'); assert.equal(second.settledAt, undefined);
  assert.equal(second.attempts, 0, 'waiting is not an attempt'); assert.equal(second.waiting, 'MEMORY_REWIND_WAITS_FOR_NEWER'); assert.ok(second.retryAt);
  assert.equal(ov.of('/api/v1/sessions/', 'DELETE').length, 0, 'no session of either turn was deleted');
  // The service is back: the newer one first, then the older one: the whole chain goes, and the memory the older turn created with it.
  ov.fail = null; f.clock.now = Date.parse(first.retryAt) + 1; await f.dispatcher.drain(); await f.settle();
  [first, second] = f.entries();
  assert.ok(first.settledAt); assert.ok(second.settledAt); assert.equal(second.waiting, undefined, 'the wait is cleared');
  assert.equal(ov.bodyOf(uri), null, 'newer undone first (Short.), then the older add matched and went'); assert.equal(ov.sessions.size, 0);
  assert.deepEqual(first.result.openviking.totals, { restored: 1 }); assert.deepEqual(second.result.openviking.totals, { deleted: 1 });
});

test('the order is by turn, not by entry: an older entry written first waits for a newer one written later, and the newer one is not held up', async t => {
  const f = await setup(t), { ov } = f, uri = `${f.ns}/preferences/reverse.md`;
  const older = await f.turn('Short.', { adds: [{ uri, body: 'Short.', type: 'preferences' }] }), newer = await f.turn('Long.', { updates: [{ uri, body: 'Long.', type: 'preferences' }] });
  f.cut(older); f.cut(newer);
  await f.dispatcher.drain(); await f.settle();
  let [first, second] = f.entries();
  assert.ok(second.settledAt, 'the newer turn’s entry went first although it was written second'); assert.equal(ov.sessions.has(older.sessionId), true);
  assert.equal(first.settledAt, undefined); assert.equal(first.attempts, 0); assert.equal(first.waiting, 'MEMORY_REWIND_WAITS_FOR_NEWER');
  f.clock.now = Date.parse(first.retryAt) + 1; await f.dispatcher.drain(); await f.settle();
  [first, second] = f.entries();
  assert.ok(first.settledAt); assert.equal(ov.bodyOf(uri), null); assert.equal(ov.sessions.size, 0);
});

test('units of one moment have no order to keep, and a unit kept for good never holds an older one back', async t => {
  const f = await setup(t), { ov } = f, a = `${f.ns}/preferences/a.md`, b = `${f.ns}/preferences/b.md`;
  const first = await f.turn('A.', { adds: [{ uri: a, body: 'A.', type: 'preferences' }] }, { startedAt: T0 }), second = await f.turn('B.', { adds: [{ uri: b, body: 'B.', type: 'preferences' }] }, { startedAt: T0 });
  f.cut(first); f.cut(second);
  await f.dispatcher.drain(); await f.settle();
  assert.ok(f.entries().every(entry => entry.settledAt), 'strictly newer only: neither waited'); assert.equal(ov.sessions.size, 0);
  // A newer unit that can never settle (the account changed: kept) is final and does not block.
  const g = await setup(t), other = await createFakeOpenViking({ user: USER }); t.after(() => other.close());
  const old = await g.turn('Old.', { adds: [{ uri: `${g.ns}/preferences/old.md`, body: 'Old.', type: 'preferences' }] });
  const recent = await g.turn('Recent.', { adds: [{ uri: `${g.ns}/preferences/recent.md`, body: 'Recent.', type: 'preferences' }] });
  g.cut(recent); g.cut(old);
  g.store.mutate(state => { const binding = state.projects.find(row => row.id === g.project.id).memorySessions.find(row => row.sessionId === recent.sessionId); binding.connectionFingerprint = 'another-connection'; });
  await g.dispatcher.drain(); await g.settle();
  const [kept, settled] = g.entries();
  assert.equal(kept.memory[0].state, 'kept'); assert.ok(settled.settledAt, 'the older entry went on');
  assert.equal(g.ov.sessions.has(old.sessionId), false); assert.equal(g.ov.sessions.has(recent.sessionId), true);
});

test('a restore under review pauses the cleanup like every other memory write: it waits without costing attempts, and goes on once memory writes are allowed again', async t => {
  const f = await setup(t), { ov } = f, uri = `${f.ns}/preferences/barrier.md`;
  const turn = await f.turn('Barrier.', { adds: [{ uri, body: 'Barrier.', type: 'preferences' }] });
  f.store.mutate(state => { state.applicationRecovery = { schemaVersion: 1, status: 'reconciled', barriers: { memory: true, background: true } }; state.configuration.memory.autoStore = false; });
  f.cut(turn); await f.dispatcher.drain(); await f.settle();
  let entry = f.entries()[0];
  assert.equal(entry.settledAt, undefined); assert.equal(entry.attempts, 0, 'a wait, not a failure'); assert.equal(entry.waiting, 'MEMORY_CLEANUP_RESTORE_REVIEW');
  assert.equal(ov.bodyOf(uri), 'Barrier.'); assert.equal(ov.sessions.has(turn.sessionId), true); assert.deepEqual(ov.writes().filter(call => call.method === 'DELETE' || call.path.endsWith('content/write')), [], 'nothing was written');
  // Still under review hours later: no attempt is ever spent on the wait.
  for (let round = 0; round < 8; round++) { f.clock.now = Date.parse(f.entries()[0].retryAt) + 1; await f.dispatcher.drain(); await f.settle(); }
  entry = f.entries()[0]; assert.equal(entry.attempts, 0); assert.equal(entry.failed, undefined); assert.equal(entry.settledAt, undefined);
  // The user turns memory writes back on.
  f.store.mutate(state => { state.configuration.memory.autoStore = true; });
  f.clock.now = Date.parse(f.entries()[0].retryAt) + 1; await f.dispatcher.drain(); await f.settle();
  entry = f.entries()[0]; assert.ok(entry.settledAt); assert.equal(entry.waiting, undefined); assert.equal(ov.bodyOf(uri), null); assert.equal(ov.sessions.has(turn.sessionId), false);
});

test('a maintenance hold waits too: hours of it do not run the entry out of attempts', async t => {
  const f = await setup(t), { ov } = f, uri = `${f.ns}/preferences/held.md`;
  const turn = await f.turn('Held.', { adds: [{ uri, body: 'Held.', type: 'preferences' }] });
  f.store.maintenanceHeld = true;
  f.cut(turn); await f.dispatcher.drain(); await f.settle();
  for (let round = 0; round < 8; round++) { f.clock.now = Date.parse(f.entries()[0].retryAt) + 1; await f.dispatcher.drain(); await f.settle(); }
  let entry = f.entries()[0];
  assert.equal(entry.attempts, 0); assert.equal(entry.failed, undefined); assert.equal(entry.waiting, 'MEMORY_CLEANUP_HELD'); assert.equal(ov.sessions.has(turn.sessionId), true);
  f.store.maintenanceHeld = false; f.clock.now = Date.parse(entry.retryAt) + 1; await f.dispatcher.drain(); await f.settle();
  entry = f.entries()[0]; assert.ok(entry.settledAt); assert.equal(ov.bodyOf(uri), null);
});

test('a handler that waits does not hold back what the other handlers settled, and a failure of another handler still counts', async t => {
  const f = await setup(t), seen = [];
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).mind ??= {}; });
  const wait = { name: 'waiter', events: ['message_rewound'], settle: async () => { seen.push('waiter'); throw Object.assign(new Error('MEMORY_WAIT_TEST'), { code: 'MEMORY_WAIT_TEST', defer: true, retryMs: 5000 }); } };
  const fine = { name: 'fine', events: ['message_rewound'], settle: async () => { seen.push('fine'); return 'ok'; } };
  const broken = { name: 'broken', events: ['message_rewound'], settle: async () => { seen.push('broken'); throw new Error('boom'); } };
  const dispatcher = new RevocationDispatcher(f.store, { decisions: { enabled: () => false }, now: () => f.clock.now, auditIntervalMs: 0 });
  dispatcher.register(wait).register(fine);
  t.after(() => dispatcher.close());
  let entry;
  f.store.mutate(state => { entry = recordRewoundMemory(state.projects.find(row => row.id === f.project.id), f.session.id, [{ sessionId: 'rna-x', at: new Date(T0).toISOString(), state: 'pending' }], { now: T0 })[0]; });
  await dispatcher.drain();
  let row = f.entries().find(item => item.id === entry.id);
  assert.deepEqual(seen, ['waiter', 'fine'], 'the others still ran'); assert.equal(row.steps.fine, 'done'); assert.equal(row.steps.waiter, 'pending');
  assert.equal(row.attempts, 0); assert.equal(row.waiting, 'MEMORY_WAIT_TEST'); assert.equal(row.retryAt, new Date(T0 + 5000).toISOString(), 'its own retry time');
  seen.length = 0; f.clock.now = T0 + 6000; await dispatcher.drain();
  assert.deepEqual(seen, ['waiter'], 'a handler that finished is not run again'); assert.equal(f.entries().find(item => item.id === entry.id).attempts, 0);
  dispatcher.register(broken); seen.length = 0; f.clock.now = T0 + 12000; await dispatcher.drain();
  row = f.entries().find(item => item.id === entry.id);
  assert.equal(row.attempts, 1, 'a failure is an attempt even when another handler waits'); assert.equal(row.waiting, undefined);
});

test('capture failure: what is recorded and what is not is said, and the capture never throws', () => {
  // The second entry cannot be written (a long rewind makes several entries).
  class Failing extends Array { push(...items) { if (this.length >= 1) throw Object.assign(new Error('disk'), { code: 'STATE_FULL' }); return super.push(...items); } }
  const project = { memorySessions: [], mind: { revocations: new Failing() } };
  const reextract = { previous: Array.from({ length: UNITS_PER_ENTRY + 1 }, (_, index) => ({ sessionId: `rna-prev-${index}` })) };
  const session = { id: 's1', turns: [{ id: 't1', startedAt: '2026-10-05T10:00:00.000Z', memoryWrite: { sessionId: 'rna-main', reextract } }] };
  const result = captureRewoundMemory(project, session, { turnIds: new Set(['t1']), itemIds: new Set() }, { now: T0 });
  assert.equal(result.units.length, UNITS_PER_ENTRY, 'the sessions of the entry that was written'); assert.deepEqual(result.failed, { code: 'STATE_FULL', notReleased: 2 });
  assert.equal(project.mind.revocations.length, 1); assert.equal(project.mind.revocations[0].memory.length, UNITS_PER_ENTRY, 'and exactly those are in the state');
  // Nothing could even be listed: an unreadable memory record.
  const broken = captureRewoundMemory({ memorySessions: [] }, { id: 's1', turns: [{ id: 't1', memoryWrite: { sessionId: 'rna-main', reextract: { previous: {} } } }] }, { turnIds: new Set(['t1']), itemIds: new Set() }, { now: T0 });
  assert.deepEqual(broken.units, []); assert.deepEqual(broken.failed, { code: 'MEMORY_REWIND_CAPTURE_FAILED', notReleased: null });
  // And nothing wrong, nothing said.
  assert.deepEqual(captureRewoundMemory({ memorySessions: [] }, { id: 's1', turns: [] }, { turnIds: new Set(), itemIds: new Set() }, { now: T0 }), { units: [] });
});

test('the dry run is bounded: a client that goes away ends it, and sessions beyond its time budget are counted, not waited for', async t => {
  const f = await setup(t), { ov } = f, rows = [];
  for (let index = 0; index < 3; index++) rows.push(await f.turn(`Turn ${index}.`, { adds: [{ uri: `${f.ns}/preferences/p${index}.md`, body: `P${index}.`, type: 'preferences' }] }));
  const project = () => f.store.state.projects.find(row => row.id === f.project.id);
  const units = rewoundMemoryUnits(project(), f.current(), { turnIds: new Set(rows.map(row => row.turnId)), itemIds: new Set() });
  // The service stops answering. The client leaves after a moment: the dry run ends then, not after every session's deadline.
  let release; ov.hold = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const controller = new AbortController(), started = Date.now(), slow = new MemoryRewind(f.store, { previewSessionMs: 60000, previewBudgetMs: 600000 });
  const pending = slow.preview(project(), f.session.id, units, { signal: controller.signal }).then(() => 'finished', () => 'ended');
  setTimeout(() => controller.abort(), 100);
  assert.equal(await pending, 'ended', 'it throws, so nothing is sent to a client that is gone'); assert.ok(Date.now() - started < 5000, 'ended when the client left');
  // No client, but the total time is bounded: the first session is looked at, then the budget is spent and the rest is counted.
  // (The clock moves 400 ms at each reading: the first session starts at 800 of a 1000 ms budget, the second finds it spent.)
  let now = 0; const budget = new MemoryRewind(f.store, { previewSessionMs: 200, previewBudgetMs: 1000, now: () => (now += 400) });
  const plan = await budget.preview(project(), f.session.id, units);
  assert.deepEqual(plan.sessions.map(row => row.error), ['MEMORY_CLEANUP_UNAVAILABLE'], 'the session looked at: it timed out at its own deadline, and says so');
  assert.equal(plan.omittedSessions, 2); assert.equal(plan.omitted, 'time_budget');
});

test('an entry that was waiting when a version without the handler settled it opens again with its wait cleared', async t => {
  const f = await setup(t), { ov } = f, uri = `${f.ns}/preferences/waiting.md`;
  const turn = await f.turn('Waiting.', { adds: [{ uri, body: 'Waiting.', type: 'preferences' }] });
  f.store.maintenanceHeld = true; f.cut(turn); await f.dispatcher.drain(); await f.settle();
  assert.equal(f.entries()[0].waiting, 'MEMORY_CLEANUP_HELD');
  f.store.maintenanceHeld = false;
  const old = new RevocationDispatcher(f.store, { decisions: { enabled: () => false }, now: () => f.clock.now + 600000, auditIntervalMs: 0 });
  old.register({ name: 'mind', events: ['message_rewound'], settle: async () => null });
  await old.idle(); await old.close();
  f.store.mutate(state => { const row = state.projects.find(item => item.id === f.project.id).mind.revocations.find(item => item.type === 'message_rewound'); row.waiting = 'MEMORY_CLEANUP_HELD'; });
  assert.ok(f.entries()[0].settledAt);
  assert.equal(f.rewind.reopen(), 1); assert.equal(f.entries()[0].waiting, undefined, 'the old wait is not carried into the new run');
  f.clock.now += 700000; await f.settle();
  assert.ok(f.entries()[0].settledAt); assert.equal(ov.bodyOf(uri), null);
});

test('what must wait for what: only a strictly newer unit of another open entry holds a unit back', () => {
  const rewind = new MemoryRewind({}), at = minutes => new Date(T0 + minutes * 60000).toISOString();
  const entry = (id, units, extra = {}) => ({ id, type: 'message_rewound', memory: units.map(([state, minutes], index) => ({ sessionId: `${id}-${index}`, at: at(minutes), state })), ...extra });
  const project = rows => ({ mind: { revocations: rows } }), mine = entry('mine', [['pending', 5]]), unit = mine.memory[0];
  assert.equal(rewind.newerPending(project([mine, entry('newer', [['pending', 10]])]), mine, unit), true, 'a newer unit still to settle');
  assert.equal(rewind.newerPending(project([mine, entry('newer', [['pending', 5]])]), mine, unit), false, 'one of the same moment');
  assert.equal(rewind.newerPending(project([mine, entry('older', [['pending', 1]])]), mine, unit), false, 'an older one');
  assert.equal(rewind.newerPending(project([mine, entry('newer', [['deleted', 10]])]), mine, unit), false, 'a newer one that is done');
  assert.equal(rewind.newerPending(project([mine, entry('newer', [['kept', 10]])]), mine, unit), false, 'a newer one kept for good (the account changed) can never settle: it holds nothing back');
  assert.equal(rewind.newerPending(project([mine, entry('newer', [['deleted', 10], ['pending', 7]])]), mine, unit), true, 'any one unit of the other entry');
  assert.equal(rewind.newerPending(project([mine, entry('settled', [['pending', 10]], { settledAt: at(0) })]), mine, unit), false, 'an entry a version without the handler settled (opened again at the next start)');
  assert.equal(rewind.newerPending(project([mine, { id: 'other-kind', type: 'lesson_revoked', memory: mine.memory.map(row => ({ ...row, at: at(10) })) }]), mine, unit), false, 'other kinds of revocation');
  assert.equal(rewind.newerPending(project([mine]), mine, unit), false, 'itself');
});

test('while one handler waits, the entry’s judge and assertion wait too, and run once it has settled', async t => {
  const f = await setup(t); let waits = 2; const calls = [];
  const wait = { name: 'waiter', events: ['message_rewound'], settle: async () => { if (waits-- > 0) throw Object.assign(new Error('W'), { code: 'W', defer: true, retryMs: 1000 }); return 'ok'; } };
  const judging = { name: 'judging', events: ['message_rewound'], settle: async () => 'ok', candidates: async () => { calls.push('candidates'); return { kind: 'note', rows: [{ id: 'n1' }] }; }, apply: async () => 0, assert: async () => { calls.push('assert'); return []; } };
  const decisions = { enabled: () => true, mindStale: async () => { calls.push('judge'); return { stale: [] }; } };
  const dispatcher = new RevocationDispatcher(f.store, { decisions, now: () => f.clock.now, auditIntervalMs: 0 }).register(wait).register(judging);
  t.after(() => dispatcher.close());
  let entry; f.store.mutate(state => { entry = recordRewoundMemory(state.projects.find(row => row.id === f.project.id), f.session.id, [{ sessionId: 'rna-j', at: new Date(T0).toISOString(), state: 'pending' }], { now: T0 })[0]; });
  await dispatcher.drain(); f.clock.now += 2000; await dispatcher.drain();
  assert.deepEqual(calls, [], 'neither judged nor asserted while a handler still waits');
  f.clock.now += 2000; await dispatcher.drain();
  assert.deepEqual(calls, ['candidates', 'judge', 'assert'], 'once, after the wait'); assert.ok(f.entries().find(row => row.id === entry.id).settledAt);
});
