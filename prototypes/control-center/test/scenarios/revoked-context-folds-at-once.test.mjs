// D4 scenario (plan C4: "隐私撤销立即折叠上下文副本，记 context_fold、reason=revoked"). A note the project made from one
// conversation rode the notes block into another conversation's model context. The user deletes the first conversation:
// the note is withdrawn from the mind, and the OTHER conversation's very next request no longer carries it — its earlier
// copy of the notes block folds to one line (a warm cache break, not the next cold one), the journal keeps the copy, and the
// host does not ask again once the SDK has applied it. A note that kept a source in another conversation stays and is
// judged against what is left. Crosses the deletion service, the revocation entry, the foreground's request hook, the SDK
// fold and the session journal. Model and JEV are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { MIND_CONTEXT_KEYS, addLesson, mindSource } from '../../project-mind.mjs';
import { foldedContextText } from '../../../../packages/sdk/src/context.mjs';

const PRIVATE = '用户的老家在青岛的一条老街上';
const KEPT = '日报要写得简洁一些';
const RULE = 'Always answer with exactly three bullet points.';

test('a conversation deleted: the note made from it is withdrawn and another conversation folds its earlier copy at its next request', async t => {
  const world = await createWorld(t);
  const s = scenario(world), at = new Date().toISOString(), source = world.store.createSession({ projectId: world.projectId });
  world.store.mutate(state => {
    state.sessions.find(row => row.id === source.id).items.push({ id: 'src-1', kind: 'user', text: `我老家在青岛。${PRIVATE}`, createdAt: at }, { id: 'src-2', kind: 'user', text: '另外，日报写简洁些', createdAt: at });
    const project = state.projects.find(row => row.id === world.projectId); project.mind ??= {};
    Object.assign(project.mind, { lessons: [], agenda: [], commitments: [], notes: { facts: [{ id: 'note-private', text: PRIVATE, createdAt: at, sources: [{ sessionId: source.id, itemId: 'src-1' }] }],
      preferences: [{ id: 'note-kept', text: KEPT, createdAt: at, sources: [{ sessionId: source.id, itemId: 'src-2' }, { sessionId: world.sessionId, itemId: 'own-1' }] }], updatedAt: at } });
    state.sessions.find(row => row.id === world.sessionId).items.push({ id: 'own-1', kind: 'user', text: '日报请保持简洁', createdAt: at });
    // A standing rule of the project: it rides the rules block of every conversation, and a revocation elsewhere must not take it away.
    addLesson(project.mind, { kind: 'preference', text: RULE, source: mindSource('user', {}) }, { now: Date.now() });
  });
  // JEV, asked whether the remaining messages still say each note: the message that remains still says the short-report note.
  world.jev.answerAll((id, _question, body) => id.startsWith('stale_') ? (body.state?.mind?.rows?.[Number(id.slice('stale_'.length))]?.sources?.some(text => text.includes('简洁')) ? 0.95 : 0.05) : undefined);

  const first = await s.send('你好，今天做什么？', { reply: '先看看昨天的日报。' });
  await first.expect({ requests: rows => {
    const request = rows.find(row => row.tag === 'foreground');
    assert.ok(request.wire.includes(MIND_CONTEXT_KEYS.notes) && request.wire.includes(PRIVATE), 'the private note rides the notes block of this conversation');
    assert.ok(request.wire.includes(RULE), 'precondition: the standing rule rides the rules block');
  } });
  const warm = await s.send('继续。', { reply: '好的。' });
  await warm.expect({ requests: rows => assert.ok(rows.find(row => row.tag === 'foreground').wire.includes(PRIVATE), 'warm: nothing folds on its own (the cached prefix is worth more)') });

  const deleted = await s.delete(source.id);
  await world.app.store.revocations.idle(); await world.quiet();
  await deleted.expect({ state: state => {
    const mind = state.projects.find(row => row.id === world.projectId).mind;
    assert.ok(!mind.notes.facts.some(row => row.id === 'note-private'), 'the note made wholly from the deleted conversation is gone');
    assert.deepEqual(mind.notes.preferences.find(row => row.id === 'note-kept').sources, [{ sessionId: world.sessionId, itemId: 'own-1' }], 'the note with another source lost only the link');
    assert.equal(mind.notes.preferences.find(row => row.id === 'note-kept').stale, undefined, 'and the message that remains still says it');
    const entry = mind.revocations.find(row => row.type === 'session_deleted');
    assert.ok(entry.context.keys.includes(MIND_CONTEXT_KEYS.notes), 'the revocation asks the conversations to fold their copies of the notes block');
  } });
  assert.equal(world.jev.asked('stale_0').length, 1); assert.ok(!JSON.stringify(world.jev.calls.map(call => call.state)).includes(PRIVATE), 'the deleted conversation\'s words were never sent to the judge');

  const after = await s.send('今天的日报怎么写？', { reply: '写成三条要点。' });
  await after.expect({
    requests: rows => {
      const request = rows.find(row => row.tag === 'foreground');
      assert.ok(!request.wire.includes(PRIVATE), 'the very next request carries no copy of what was withdrawn');
      assert.ok(request.wire.includes(foldedContextText(MIND_CONTEXT_KEYS.notes, 'revoked').replace(/"/g, '\\"')), 'the earlier copies are one line each, said to be withdrawn');
      assert.ok(request.wire.includes(KEPT), 'the note that stays is in the newest copy');
      assert.ok(request.wire.includes(RULE), 'the standing rule is still there: its earlier copy folded, and its current copy was offered again in the same request');
    },
  });
  // The journal keeps what the conversation had; the fold is journaled with its reason, once.
  const sessionFile = world.session().runtime?.sessionFile, log = sessionFile ? readFileSync(sessionFile, 'utf8') : '';
  assert.match(log, /"reason":"revoked"/); assert.ok(log.includes(PRIVATE), 'the journal keeps the copy whole (raw history stays); the model never reads it again');
  await until(() => (world.session().revocationsApplied ?? []).length > 0, 'the host to record that the SDK applied it');
  const again = await s.send('再问一次。', { reply: '好的。' });
  await again.expect({ requests: rows => { const wire = rows.find(row => row.tag === 'foreground').wire; assert.ok(!wire.includes(PRIVATE)); assert.ok(wire.includes(RULE), 'and on the turn after that'); } });
  const third = await s.send('第三次。', { reply: '好的。' });
  await third.expect({ requests: rows => assert.ok(rows.find(row => row.tag === 'foreground').wire.includes(RULE), 'and on the one after: the rules block is not lost for good') });
  const folds = log.split('\n').filter(line => line.includes('"type":"context_fold"') && line.includes('"targets"') && line.includes('"reason":"revoked"')).length;
  const finalLog = readFileSync(sessionFile, 'utf8').split('\n').filter(line => line.includes('"type":"context_fold"') && line.includes('"targets"') && line.includes('"reason":"revoked"')).length;
  assert.equal(finalLog, folds, 'not applied again');
});
