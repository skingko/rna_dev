// D4 scenario (D5, X-7): the user edits an earlier message of a conversation whose turns already reached memory, and the
// rewind reaches OpenViking. Crosses the foreground turns, memory sync (one remote session per turn, its commit, the
// archive and its memory diff), the rewind route (dry run and real), the revocation dispatcher and its OpenViking handler,
// and the fake OpenViking's files. The world is checked from outside: what OpenViking holds and was asked, the persisted
// state. Only the model, OpenViking and the clock are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';

const PAST = 'I want the whole novel in past tense.', DINNER = 'Plan the Friday dinner and keep the narration in first person.', TONE = 'Keep a dry tone in the dialogue.';

test('editing an earlier message deletes the removed turns’ remote sessions and rolls back the memories they wrote, only where nothing changed them since', async t => {
  const world = await createWorld(t, { memory: { autoStore: true } });
  const { ov } = world, peer = `viking://user/${ov.user}/peers/forge-${world.projectId}/memories`;
  const pref = name => `${peer}/preferences/${name}.md`, event = `${peer}/events/2026/10/05/friday_dinner_proposed.md`;
  // What each turn's long-term extraction wrote: A one memory; B an event, a memory and an update of A's; C one memory.
  ov.extraction = ({ session }) => {
    const wire = JSON.stringify(session.messages);
    if (wire.includes(PAST)) return { adds: [{ uri: pref('tense'), body: 'Prefers past tense.', type: 'preferences' }] };
    if (wire.includes(DINNER)) return { adds: [{ uri: event, body: 'A Friday dinner was proposed.', type: 'events' }, { uri: pref('dinner'), body: 'Friday dinner at seven.', type: 'preferences' }], updates: [{ uri: pref('tense'), body: 'Prefers past tense, first person.', type: 'preferences' }] };
    if (wire.includes(TONE)) return { adds: [{ uri: pref('tone'), body: 'Prefers a dry tone.', type: 'preferences' }] };
    return {};
  };
  ov.memory(pref('unrelated'), 'Written by another conversation.');
  const s = scenario(world);
  const synced = turnId => s.advanceClock(20000, { repeat: true, label: `memory sync reaches the turn`, until: () => world.session().turns.find(turn => turn.id === turnId)?.memoryWrite?.status === 'completed' });
  const sent = [];
  for (const text of [PAST, DINNER, TONE]) { const step = await s.send(text, { reply: `Noted: ${text}` }); await synced(step.outcome.turnId); sent.push(step.outcome.turnId); }
  const [turnA, turnB, turnC] = sent, remoteOf = turnId => world.session().turns.find(turn => turn.id === turnId).memoryWrite.sessionId;
  const remote = { a: remoteOf(turnA), b: remoteOf(turnB), c: remoteOf(turnC) };
  assert.equal(new Set(Object.values(remote)).size, 3, 'one remote session per turn');
  assert.equal(ov.bodyOf(pref('tense')), 'Prefers past tense, first person.'); assert.equal(ov.bodyOf(pref('tone')), 'Prefers a dry tone.');
  assert.ok(ov.tagsOf(event).includes(`rna_turn=${turnB}`), 'the event carries the turn that produced it');
  assert.ok(world.session().turns.find(turn => turn.id === turnB).memoryWrite.memoryDiffUri, 'the commit recorded its archive’s memory diff');
  // Since then the user edited what turn C wrote (in the memory page, or another extraction merged into it).
  ov.memory(pref('tone'), 'Prefers a dry tone, except in narration.');
  const messageB = world.session().items.find(item => item.kind === 'user' && item.text === DINNER);

  // The dry run: what would happen, from reads alone.
  const marks = { writes: ov.writes().length, items: world.session().items.length, turns: world.session().turns.length };
  const dry = await world.post(`/api/sessions/${world.sessionId}/items/${messageB.id}/rewind`, { reason: 'user_edit', dryRun: true });
  assert.equal(dry.status, 200); assert.equal(dry.body.dryRun, true); assert.equal(dry.body.removedTurns, 2);
  assert.deepEqual(dry.body.memory.totals, { would_delete: 2, would_restore: 1, changed: 1 });
  assert.deepEqual(dry.body.memory.sessions.map(row => row.sessionId), [remote.c, remote.b], 'newest turn first');
  assert.deepEqual(dry.body.memory.sessions.find(row => row.sessionId === remote.c).left, [{ op: 'add', uri: pref('tone'), outcome: 'changed' }]);
  assert.equal(ov.writes().length, marks.writes, 'the dry run wrote nothing to OpenViking'); assert.equal(world.session().items.length, marks.items); assert.equal(world.session().turns.length, marks.turns);
  assert.deepEqual(world.project().mind?.revocations ?? [], [], 'and recorded nothing');

  // The edit.
  const edit = await s.revert({ item: messageB.id, reason: 'user_edit' });
  await edit.expect({ state: state => assert.deepEqual(edit.outcome.memory, { remoteSessions: 2, rollback: 'queued' }) });
  await world.app.store.revocations.idle();
  const settled = await s.step('the dispatcher finishes the OpenViking cleanup', async () => { await until(() => world.project().mind.revocations?.every(row => row.settledAt), 'the revocation to settle'); return world.project().mind.revocations.find(row => row.memory); });
  await settled.expect({
    state: state => {
      const project = state.projects.find(row => row.id === world.projectId), entry = project.mind.revocations.find(row => row.memory);
      assert.deepEqual(state.sessions.find(row => row.id === world.sessionId).turns.map(turn => turn.id), [turnA], 'only the first turn is left');
      assert.deepEqual(entry.result.openviking.totals, { deleted: 2, restored: 1, changed: 1 });
      assert.deepEqual(entry.result.openviking.left, [{ op: 'add', uri: pref('tone'), outcome: 'changed' }], 'what was left alone is reported');
      assert.equal(entry.result.openviking.deleted, 2); assert.equal(entry.result.violations, 0);
      assert.equal(JSON.stringify(entry.memory).includes('narration'), false, 'identifiers only, never memory text');
      const status = Object.fromEntries((project.memorySessions ?? []).map(row => [row.sessionId, row.status]));
      // A deleted binding is dropped by memory sync once nothing names it (MEM-11); until then it says it is deleted.
      assert.equal(status[remote.a], 'ready'); assert.ok([status[remote.b], status[remote.c]].every(value => value === undefined || value === 'deleted'), 'the removed turns’ bindings are deleted or already pruned');
    },
    memory: () => {
      // Everything the host changed in OpenViking since the edit: the rollback, then the removed turns' sessions, nothing else.
      const changes = ov.writes().slice(marks.writes).map(call => `${call.method} ${call.path.replace('/api/v1/', '')}${call.query.uri ? ` ${call.query.uri}` : ''}${call.body?.uri ? ` ${call.body.uri}` : ''}`);
      assert.deepEqual([...changes].sort(), [`DELETE fs ${event}`, `DELETE fs ${pref('dinner')}`, `DELETE sessions/${remote.b}`, `DELETE sessions/${remote.c}`, `POST content/write ${pref('tense')}`].sort());
      assert.ok(changes.indexOf(`DELETE sessions/${remote.c}`) < changes.indexOf(`DELETE sessions/${remote.b}`), 'the newest turn is settled first');
      assert.ok(changes.indexOf(`POST content/write ${pref('tense')}`) < changes.indexOf(`DELETE sessions/${remote.b}`), 'the memories are rolled back before the session that holds their diff goes');
    },
  });
  assert.equal(ov.bodyOf(event), null, 'the event is gone'); assert.equal(ov.bodyOf(pref('dinner')), null);
  assert.equal(ov.bodyOf(pref('tense')), 'Prefers past tense.', 'the update is undone: what the first turn wrote is back');
  assert.equal(ov.bodyOf(pref('tone')), 'Prefers a dry tone, except in narration.', 'what changed since is left alone');
  assert.equal(ov.bodyOf(pref('unrelated')), 'Written by another conversation.', 'nothing the diffs do not name');
  assert.deepEqual([remote.a, remote.b, remote.c].map(id => ov.sessions.has(id)), [true, false, false], 'the first turn’s remote session stays');
});

test('a failure on the memory side never blocks the user’s edit: the turns go and nothing is recorded, as before D5', async t => {
  const world = await createWorld(t);
  const s = scenario(world);
  const sent = await s.send('A question.', { reply: 'An answer.' });
  const messageId = world.session().items.find(item => item.kind === 'user').id;
  // A memory record the capture cannot read (an object where it expects a list).
  world.store.mutate(state => { state.sessions.find(row => row.id === world.sessionId).turns.find(turn => turn.id === sent.outcome.turnId).memoryWrite = { status: 'completed', sessionId: 'rna-unreadable', reextract: { previous: {} } }; });
  const edit = await s.revert({ item: messageId, reason: 'user_delete' });
  await edit.expect({ state: state => {
    assert.equal(edit.outcome.removedTurns, 1); assert.equal(edit.outcome.memory, undefined);
    assert.deepEqual(edit.outcome.memoryCapture, { failed: 'MEMORY_REWIND_CAPTURE_FAILED', notReleased: null }, 'and the response says that the remote sessions were not released');
    assert.deepEqual(state.sessions.find(row => row.id === world.sessionId).turns, [], 'the turn is gone');
    assert.deepEqual((state.projects.find(row => row.id === world.projectId).mind?.revocations ?? []).filter(row => row.memory), []);
  } });
  assert.ok(world.app.executor.rewindMemoryError, 'the failure is noted for the host');
});

test('an OpenViking failure in the middle of the cleanup is waited out in order, with the real dispatcher: one attempt, nothing older settled ahead of the newer turn, everything rolled back after', async t => {
  const world = await createWorld(t, { memory: { autoStore: true } });
  const { ov } = world, peer = `viking://user/${ov.user}/peers/forge-${world.projectId}/memories`, pref = name => `${peer}/preferences/${name}.md`;
  const FIRST = 'Write the novel in short chapters.', SECOND = 'Actually make the chapters long.', THIRD = 'Keep the dialogue dry.';
  ov.extraction = ({ session }) => {
    const wire = JSON.stringify(session.messages);
    if (wire.includes(FIRST)) return { adds: [{ uri: pref('chapters'), body: 'Short chapters.', type: 'preferences' }] };
    if (wire.includes(SECOND)) return { updates: [{ uri: pref('chapters'), body: 'Long chapters.', type: 'preferences' }] };
    if (wire.includes(THIRD)) return { adds: [{ uri: pref('dialogue'), body: 'Dry dialogue.', type: 'preferences' }] };
    return {};
  };
  const s = scenario(world), sent = [];
  for (const text of [FIRST, SECOND, THIRD]) { const step = await s.send(text, { reply: `Noted: ${text}` }); await s.advanceClock(20000, { repeat: true, until: () => world.session().turns.find(turn => turn.id === step.outcome.turnId)?.memoryWrite?.status === 'completed' }); sent.push(step.outcome.turnId); }
  const remote = sent.map(turnId => world.session().turns.find(turn => turn.id === turnId).memoryWrite.sessionId);
  assert.equal(ov.bodyOf(pref('chapters')), 'Long chapters.');
  // The service refuses to write a memory file: the second turn’s update cannot be undone.
  ov.fail = call => call.method === 'POST' && call.path === '/api/v1/content/write' ? 503 : null;
  const first = world.session().items.find(item => item.kind === 'user' && item.text === FIRST);
  await (await s.revert({ item: first.id, reason: 'user_edit' })).expect({ state: () => {} });
  await world.app.store.revocations.idle(); await delay(150); await world.app.store.revocations.idle();
  const entry = () => world.project().mind.revocations.find(row => row.memory);
  assert.equal(entry().attempts, 1, 'the failure cost one attempt, however many times the dispatcher was kicked'); assert.equal(entry().failed, undefined); assert.ok(entry().retryAt);
  assert.equal(ov.sessions.has(remote[2]), false, 'the newest turn went first'); assert.equal(ov.bodyOf(pref('dialogue')), null);
  assert.deepEqual([remote[0], remote[1]].map(id => ov.sessions.has(id)), [true, true], 'the older turns’ sessions, with the diffs their rollback needs, are still there');
  assert.equal(ov.of('/api/v1/content/write', 'POST').length, 1, 'the failing write was sent once');
  // The service is back, later: the second turn’s update is undone, then the first turn’s add.
  ov.fail = null; world.clock.advance(130000);
  await world.app.store.revocations.drain(); await world.app.store.revocations.idle();
  assert.ok(entry().settledAt, 'settled'); assert.equal(entry().attempts, 1);
  assert.equal(ov.bodyOf(pref('chapters')), null, 'the update is undone, then the memory the first turn created goes');
  assert.deepEqual(remote.map(id => ov.sessions.has(id)), [false, false, false]);
  assert.deepEqual(entry().result.openviking.totals, { deleted: 2, restored: 1 });
});

test('a dry run is not carried on for a client that went away', async t => {
  const world = await createWorld(t, { memory: { autoStore: true } });
  const { ov } = world, peer = `viking://user/${ov.user}/peers/forge-${world.projectId}/memories`;
  ov.extraction = () => ({ adds: [{ uri: `${peer}/preferences/dry.md`, body: 'Dry run memory.', type: 'preferences' }] });
  const s = scenario(world), step = await s.send('Remember this for the dry run.', { reply: 'Noted.' });
  await s.advanceClock(20000, { repeat: true, until: () => world.session().turns.find(turn => turn.id === step.outcome.turnId)?.memoryWrite?.status === 'completed' });
  const messageId = world.session().items.find(item => item.kind === 'user').id;
  // OpenViking stops answering; the user closes the dialog that asked for the dry run.
  let release; ov.hold = new Promise(resolve => { release = resolve; });
  const before = ov.calls.length, controller = new AbortController();
  const asked = fetch(`http://127.0.0.1:${world.port}/api/sessions/${world.sessionId}/items/${messageId}/rewind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'user_edit', dryRun: true }), signal: controller.signal }).then(() => 'answered', error => error.name);
  await until(() => ov.calls.length > before, 'the dry run to reach OpenViking');
  controller.abort(); assert.equal(await asked, 'AbortError');
  await delay(100);
  const stalled = ov.calls.length; ov.hold = null; release();
  await delay(400);
  assert.equal(ov.calls.length, stalled, 'the dry run asked OpenViking nothing more once the client was gone');
  assert.deepEqual(ov.writes().filter(call => call.method === 'DELETE' || call.path.endsWith('/content/write')), [], 'and wrote nothing'); assert.equal(world.session().turns.length, 1, 'or removed anything');
});
