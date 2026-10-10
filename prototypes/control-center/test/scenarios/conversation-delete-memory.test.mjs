// D4 scenario (plan A7): a conversation whose turns reached memory and whose answered question card became memory
// evidence is deleted. Crosses the foreground turn and its tools (ask_user), the interaction service, memory sync and
// the evidence outbox (fake OpenViking), session deletion, the stream index and the files beside state. The world is
// checked from outside: what OpenViking holds and was asked, the persisted state, the journal folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readStateText } from '../../state-shards.mjs';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';

const PRIVATE = 'The protagonist is called Lin Qiao and hides a letter in chapter three.';

test('deleting a conversation removes its memory sessions (turns and evidence), its journal and its rows, and keeps extracted memory', async t => {
  const world = await createWorld(t, { memory: { autoStore: true } });
  const s = scenario(world);
  // A second conversation of the project: the one the user deletes (the project keeps its primary one).
  const created = await world.post('/api/sessions', { projectId: world.projectId, title: 'Side discussion' });
  assert.equal(created.status, 201);
  const sessionId = created.body.id;

  const told = await s.send(PRIVATE, { sessionId, reply: 'Noted: Lin Qiao, and the letter in chapter three.' });
  await s.advanceClock(20000, { label: 'memory sync uploads the turn', until: () => world.ov.of(/\/commit$/, 'POST').length >= 1 });
  await told.expect({ state: state => assert.ok(state.sessions.some(row => row.id === sessionId)) });
  const turnSessions = [...world.ov.sessions.keys()];
  assert.ok([...world.ov.sessions.values()].some(row => JSON.stringify(row.messages).includes('Lin Qiao')), 'OpenViking holds the turn');

  await s.send('Ask me which tense to use.', { sessionId, stopAt: 'card', reply: [{ toolCalls: [{ name: 'ask_user', args: { questions: [{ id: 'tense', question: 'Which tense should the chapters use?', options: [{ id: 'past', label: 'Past tense' }, { id: 'present', label: 'Present tense' }] }] } }] }, 'Past tense it is.'] });
  const answered = await s.answer([{ id: 'tense', selected: ['past'] }], { sessionId });
  await answered.expect({ state: state => assert.ok(state.sessions.find(row => row.id === sessionId).memoryEvidenceOutbox?.some(row => row.sourceKind === 'interaction_answer'), 'the answered card became memory evidence') });
  // Evidence is archived in its own memory session and committed; the clock moves past each poll of its task.
  await s.advanceClock(20000, { repeat: true, label: 'evidence reaches memory', until: () => world.session(sessionId)?.memoryEvidenceOutbox?.some(row => row.status === 'completed') });
  const evidence = world.session(sessionId).memoryEvidenceOutbox.find(row => row.status === 'completed');
  assert.ok(world.ov.sessions.has(evidence.sessionId) && !turnSessions.includes(evidence.sessionId), 'the evidence has its own memory session');
  assert.match(JSON.stringify(world.ov.sessions.get(evidence.sessionId).messages), /Past tense/, 'holding the answered card');
  const ovSessions = [...world.ov.sessions.keys()];
  // What extraction produced stays: a memory OpenViking holds outside the conversation's sessions.
  const memoryUri = `viking://user/${world.ov.user}/memories/profile.md`;
  world.ov.resources.set(memoryUri, 'Prefers past tense.');

  const index = await world.sse('/api/v2/stream');
  await until(() => index.of('hello').length, 'hello');
  const journal = world.sidecarEntries('.rna');
  assert.ok(journal.includes(sessionId), 'the conversation has a journal folder');

  const deleted = await s.delete(sessionId);
  await deleted.expect({
    state: state => {
      assert.equal(state.sessions.some(row => row.id === sessionId), false);
      assert.equal(state.projects.find(row => row.id === world.projectId).sessionIds.includes(sessionId), false);
      assert.equal(deleted.outcome.deletion.status, 'completed');
      assert.equal(readStateText(world.stateFile).includes('Lin Qiao'), false, 'the persisted state no longer holds the conversation text');
    },
    sidecars: () => assert.equal(world.sidecarEntries('.rna').includes(sessionId), false, 'its journal folder is gone'),
    memory: calls => {
      const removed = calls.filter(call => call.method === 'DELETE');
      for (const id of ovSessions) assert.ok(removed.some(call => call.path === `/api/v1/sessions/${id}`), `memory session ${id} deleted`);
      assert.deepEqual(removed.filter(call => !call.path.startsWith('/api/v1/sessions/')).map(call => `${call.path} ${call.query.uri ?? ''}`), [], 'nothing but its memory sessions deleted');
    },
    frames: frames => assert.ok(frames.some(frame => frame.event === 'index' && frame.data.removed?.sessions?.includes(sessionId)), 'the index removed the conversation'),
  });
  assert.equal(world.ov.resources.get(memoryUri), 'Prefers past tense.', 'extracted memory is kept');
  assert.deepEqual(ovSessions.filter(id => world.ov.sessions.has(id)), [], 'OpenViking holds none of its sessions');
  assert.ok(world.session(world.sessionId), 'the project keeps its other conversation');
});
