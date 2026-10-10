// D4 scenario (plan A7, on A4's behaviour): a subagent the conversation started finishes after the turn that started
// it ended; its result reaches the next request exactly once, and a rewind that cuts the request which carried it
// offers it once more. Crosses the foreground turn, the builtin agent service (its child runs on the real provider path
// against the faux model's HTTP endpoint), the agent inbox, the runtime's tail context, the rewind route and the SDK
// journal. Model only is fake (no paid call).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { SUBAGENT_RESULTS_SOURCE } from '../../subagent-results.mjs';

const CHILD_ANSWER = 'Scout found the entry point in src/index.js.';
const count = (text, needle) => text.split(needle).length - 1;
const gate = () => { let release; const held = new Promise(done => { release = done; }); return { held, release }; };

test('a subagent result that settles after its turn reaches the next request once, and again once after a rewind cuts it', async t => {
  const world = await createWorld(t, { files: { 'src/index.js': 'export const main = () => 1;\n' } });
  const s = scenario(world), child = gate();
  // The child's requests take the real provider path to the faux model's HTTP endpoint; the first one is held.
  world.faux.script('http', { hold: child.held, then: { text: CHILD_ANSWER } });

  const started = await s.send('Find the entry point with a scout.', { reply: [{ toolCalls: [{ name: 'agent_consult', args: { role: 'scout', task: 'Find the entry point.' } }] }, 'I started a scout and will report when it returns.'] });
  const [delegation] = started.outcome.turn.delegations ?? [];
  assert.ok(delegation, 'the turn started a subagent');
  const record = () => world.app.builtinAgentService.record(world.sessionId, delegation.id);
  await started.expect({ requests: rows => assert.ok(rows.some(row => row.tag === 'http' && /Find the entry point/.test(row.wire)), 'the child was asked through the provider path') });

  const returned = await s.step('the scout returns after its turn ended', async () => { child.release(); return until(() => record()?.delivery?.status === 'noticed' ? record() : null, 'the result to be noticed'); });
  await returned.expect({
    requests: rows => assert.deepEqual(rows.filter(row => row.tag === 'foreground'), [], 'no model request for the result itself'),
    state: state => {
      const session = state.sessions.find(row => row.id === world.sessionId);
      assert.equal(session.turns.length, 1, 'no turn of its own');
      assert.ok(session.items.some(item => item.kind === 'subagent' && item.subagent?.agentId === delegation.id), 'the conversation shows the subagent');
    },
  });

  const asked = await s.send('What did the scout find?', { reply: 'It found src/index.js.' });
  await asked.expect({
    requests: rows => {
      const [first] = rows.filter(row => row.tag === 'foreground');
      assert.equal(count(first.wire, CHILD_ANSWER), 1, 'the next request carries the result exactly once');
      assert.equal(count(first.wire, SUBAGENT_RESULTS_SOURCE), 1);
    },
    state: () => assert.equal(record().delivery.status, 'reported'),
  });
  const thanks = await s.send('Thanks.', { reply: 'You are welcome.' });
  await thanks.expect({ requests: rows => assert.equal(count(rows.find(row => row.tag === 'foreground').wire, CHILD_ANSWER), 1, 'later requests hold only the copy in the history') });

  // The user edits the message whose request carried the result: that copy leaves the model's context.
  const cut = await s.revert({ item: asked.outcome.turn.userItemId, reason: 'user_edit' });
  await cut.expect({ state: state => assert.equal(state.sessions.find(row => row.id === world.sessionId).turns.length, 1, 'the cut turns are gone') });
  const again = await s.send('What did the scout find, again?', { reply: 'It found src/index.js.' });
  await again.expect({
    requests: rows => {
      const [first] = rows.filter(row => row.tag === 'foreground');
      assert.equal(count(first.wire, CHILD_ANSWER), 1, 'offered once more, since the model no longer holds it');
      assert.equal(count(first.wire, SUBAGENT_RESULTS_SOURCE), 1, 'and the cut copy is gone from the history');
    },
  });
});
