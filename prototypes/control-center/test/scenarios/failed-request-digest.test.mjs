// D4 scenario (P2 B5): a request whose turn failed stays owed until the mind judge reads it settled. An unrelated
// question answered afterwards no longer clears it (it rides the judge's resolved batch instead); the turn that does
// the work keeps a digest naming the chapter a shell command wrote (from its checkpoint), and its turn.settled
// conclusion on the turn. Crosses the runtime (failure, settle, hand-back checkpoint), the project mind, the decision
// service and JEV. Model and JEV only are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';

const owed = state => state.projects[0].mind?.commitments ?? [];

test('a failed request waits for the mind judge, and the turn that does it keeps a digest of what it wrote', async t => {
  const world = await createWorld(t, { files: { 'README.md': '# Novel\n', 'chapters/10.md': 'Chapter ten.\n' } });
  const s = scenario(world), mind = world.store.mind;

  const failed = await s.send('Write chapter eleven into chapters/11.md.', { reply: { error: { message: 'faux request rejected', status: 400, code: 'faux_rejected' } } });
  await until(() => owed(world.store.state).some(row => row.trigger === 'failed_turn'), 'the failed request to be owed');
  await mind.idle();
  await failed.expect({ state: state => {
    const [row] = owed(state);
    assert.equal(row.trigger, 'failed_turn'); assert.equal(row.status, 'pending'); assert.match(row.request, /chapter eleven/);
    assert.equal(state.sessions[0].turns[0].status, 'failed');
  } });

  // An unrelated question: the judge is asked about the failed request (it abstains here), and the request stays owed.
  const unrelated = await s.send('What is the hero called?', { reply: 'The hero is called Gu Zhao.' });
  await until(() => world.session().turns.at(-1).mindSettledAt, 'the mind to read the second turn');
  await unrelated.expect({
    state: state => assert.equal(owed(state).find(row => row.trigger === 'failed_turn').status, 'pending', 'an unrelated turn does not settle it'),
    judgments: calls => {
      const call = calls.find(row => Object.hasOwn(row.questions ?? {}, 'resolved_0'));
      assert.ok(call, 'the mind judge read the failed request in its resolved batch');
      assert.match(JSON.stringify(call.state), /chapter eleven/); assert.match(JSON.stringify(call.state), /Gu Zhao/);
    },
  });

  // The turn that does the work: a shell command writes the chapter. JEV now reads the request as settled and the
  // instruction as complete.
  world.jev.answer('resolved_0', 0.95).answer('instruction_complete', 0.97).answer('deferred_without_cause', 0.03).answer('waiting_on_user', 0.03);
  const work = await s.send('Carry on with chapter eleven.', { reply: [
    { toolCalls: [{ name: 'project_exec', args: { command: "printf 'Chapter eleven.\\n' > chapters/11.md" } }] },
    'Chapter eleven is written to chapters/11.md.'] });
  const workTurn = work.outcome.turnId;
  await until(() => world.session().turns.find(row => row.id === workTurn)?.digest?.paths === 'checkpoint', 'the digest to take the checkpoint\'s paths');
  await mind.idle();
  await work.expect({
    files: { 'chapters/11.md': 'Chapter eleven.\n' },
    state: state => {
      const row = owed(state).find(entry => entry.trigger === 'failed_turn');
      assert.equal(row.status, 'resolved'); assert.equal(row.resolvedBy.kind, 'jev'); assert.equal(row.resolvedBy.turnId, workTurn);
      const turn = state.sessions[0].turns.find(entry => entry.id === workTurn);
      assert.equal(turn.settledVerdict.finished, true, 'the turn.settled conclusion is kept on the turn'); assert.equal(typeof turn.settledVerdict.ledgerId, 'string');
      assert.equal(turn.digest.request, 'Carry on with chapter eleven.');
      assert.match(turn.digest.steps[0], /^command printf .* -> ok$/);
      assert.deepEqual(turn.digest.written, ['chapters/11.md'], 'what the command wrote, read from the turn checkpoint');
      assert.equal(turn.digest.reply, 'Chapter eleven is written to chapters/11.md.');
      // Earlier turns kept theirs too (the failed one has no reply and says how it ended).
      assert.equal(state.sessions[0].turns[0].digest.status, 'failed');
    },
  });
});
