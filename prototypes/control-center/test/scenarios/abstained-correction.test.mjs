// D4 scenario (P2 B5 review, MIND-12): JEV answers a message's capture questions in the turn.route call but abstains on
// is_correction. The message is stored without a correction verdict (null, not false), and what reads it downstream
// changes nothing: the interaction signal miner records no correction and does not fall back to its regex on a
// captured message, and evolution's lane C sees no outcome for the reply. A message JEV does call a correction still
// reads as one. Crosses the runtime (turn.route fan-out), the decision service, JEV, the project mind, the signal
// miner and evolution. Model and JEV only are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { mineProjectSignals } from '../../project-interaction-signals.mjs';

const userItem = (state, text) => state.sessions[0].items.find(row => row.kind === 'user' && row.text === text);

test('a correction JEV abstained on is no verdict: no correction signal, no regex fallback, no lane C outcome', async t => {
  const world = await createWorld(t, { files: { 'README.md': '# Novel\n' } });
  const s = scenario(world), mind = world.store.mind;
  // JEV is sure about every capture signal but is_correction (left to the fake's default: an abstention).
  world.jev.answer('is_standing_preference', 0.03).answer('is_approval', 0.03).answer('has_pending_request', 0.03).answer('requests_self_improvement', 0.03);

  await s.send('写第三章', { reply: '第三章写好了：顾昭走进长明宗。' });
  const corrected = await s.send('不对，重写这一章', { reply: '好的，我重写第三章。' });
  await until(() => userItem(world.store.state, '不对，重写这一章')?.capture, 'the second message to be captured');
  await mind.idle();
  const [first] = world.session().turns;
  await corrected.expect({
    judgments: calls => {
      const route = calls.find(call => Object.hasOwn(call.questions ?? {}, 'is_correction') && JSON.stringify(call.state).includes('不对，重写这一章'));
      assert.ok(route, 'is_correction was asked in the turn.route call');
    },
    state: state => {
      const capture = userItem(state, '不对，重写这一章').capture;
      assert.equal(capture.correction, null, 'no verdict, not a confident "no"');
      assert.equal(capture.sources.correction, undefined);
      assert.equal(capture.preference, false); assert.equal(capture.sources.preference, 'jev');
      // The signal miner: the regex would call this wording a correction; a captured message without a verdict is none.
      const signals = mineProjectSignals(state, world.projectId, { now: Date.now() + 1000 });
      assert.equal(signals.find(row => row.kind === 'user_correction' && row.turnId === first.id), undefined);
      // Lane C: the first reply is neither corrected nor accepted.
      assert.equal(world.store.genes.contrastOutcomes(state.projects[0]).find(row => row.source.turnId === first.id), undefined);
    },
  });

  // When JEV calls the next message a correction, it is one everywhere.
  world.jev.answer('is_correction', 0.96);
  const again = await s.send('还是不对，再改一次', { reply: '好的。' });
  await until(() => userItem(world.store.state, '还是不对，再改一次')?.capture, 'the third message to be captured');
  await mind.idle();
  const second = world.session().turns[1];
  await again.expect({ state: state => {
    assert.equal(userItem(state, '还是不对，再改一次').capture.correction, true);
    const signal = mineProjectSignals(state, world.projectId, { now: Date.now() + 1000 }).find(row => row.kind === 'user_correction' && row.turnId === second.id);
    assert.equal(signal?.detail.via, 'capture:jev');
    assert.equal(world.store.genes.contrastOutcomes(state.projects[0]).find(row => row.source.turnId === second.id)?.outcome, 'corrected');
  } });
});
