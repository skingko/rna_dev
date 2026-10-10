// D4 scenario (B3, plan §1.2 #4): the user's request is overdue while they work in the conversation. Crosses the
// foreground turn (HTTP message route, its held reply), the project mind's request, the initiative's progress lease and
// pump, the JEV gate's commitment_overdue rule and its ledger, the coordinator's decision and the pacing record.
// Before B3, any overdue request exempted the project from the lease: every user turn became a paid mid-turn decision,
// and every due review afterwards went to the main model by rule. Now (Headlong monolith/step:204-237, 425-441: a
// pending request changes what a wake does, never adds wakes; declining it takes a stated reason):
//  - the lease holds through the turn, overdue or not, and the turn's result takes the request to the main model once;
//  - a wait with its reason holds the rule until new evidence: the due reviews after it go to the judge;
//  - the next message (new evidence) brings it back by rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { decide, decisionInput } from '../harness/faux-model.mjs';
import { ledgerRows } from '../../decision-ledger.mjs';

const MINUTE = 60000;
const gate = () => { let release; const held = new Promise(done => { release = done; }); return { held, release }; };
// The decision ledger (B7: out of state, in `<state>.rna/metrics/decision-ledger.jsonl`).
const bypasses = world => ledgerRows(world.store).filter(row => row.point === 'initiative.review' && row.reason === 'bypass_commitment_overdue');

test('an overdue request during a working turn: held by the lease, reviewed once at the turn\'s result, declined with a reason until new evidence', async t => {
  const world = await createWorld(t, { initiative: true, files: { 'outline.md': '# Outline\n\n1. Opening\n' } });
  const s = scenario(world);
  // Background decisions wait, with a stated reason, and come due again in 30 minutes.
  world.faux.on('initiative', request => decide(decisionInput(request), 'wait', '', { reason: 'Waiting for the user to pick the outline format before revising it.', nextReviewAfterMs: 30 * MINUTE }));
  await s.advanceClock(1000, { settleMs: 1500, label: 'the initiative reviews the new project' });
  // The user asked for a revised outline earlier; it falls due in 20 minutes.
  world.store.mutate(state => { const project = state.projects.find(row => row.id === world.projectId); project.mind ??= {}; project.mind.commitments = [{ id: 'outline', request: 'Send me the revised outline.', trigger: 'user_request', status: 'pending', createdAt: new Date(world.clock.now() - 4 * 60 * MINUTE).toISOString(), overdueAt: new Date(world.clock.now() + 20 * MINUTE).toISOString(), source: { kind: 'user' } }]; });
  const decisions = () => world.faux.of('initiative').length, before = decisions();

  const reply = gate();
  let turnId;
  const working = await s.step('a long turn runs past the request\'s due time', async () => {
    world.faux.script('foreground', { hold: reply.held, then: { text: 'Drafted chapter three.' } });
    const accepted = await world.post(`/api/sessions/${world.sessionId}/messages`, { text: 'Draft chapter three.', requestId: randomUUID() });
    assert.equal(accepted.status, 200);
    turnId = accepted.body.session?.activeTurnId ?? world.session().activeTurnId;
    await until(() => world.session().turns.find(row => row.id === turnId)?.status === 'running', 'the turn to run');
    // Ninety minutes of work: the request is overdue for seventy of them.
    for (let n = 0; n < 9; n++) { world.clock.advance(10 * MINUTE); world.tick(); await new Promise(done => setTimeout(done, 120)); }
    return { turnId };
  });
  await working.expect({
    requests: rows => assert.deepEqual(rows.filter(row => row.tag === 'initiative'), [], 'no background decision during the turn, overdue or not'),
    state: () => assert.equal(bypasses(world).length, 0),
  });

  const ended = await s.step('the turn ends', async () => {
    reply.release();
    await until(() => world.session().turns.find(row => row.id === turnId)?.status === 'completed', 'the turn to end');
    await world.quiet();
    return until(() => decisions() > before ? decisions() : null, 'the turn\'s result to be reviewed');
  });
  await ended.expect({
    requests: rows => assert.equal(rows.filter(row => row.tag === 'initiative').length, 1, 'one decision, at the turn\'s result'),
    state: state => {
      const project = state.projects.find(row => row.id === world.projectId);
      assert.deepEqual(project.mind.pacing.overdueDeclined.ids, ['outline'], 'the wait declined the request');
      assert.match(project.mind.pacing.overdueDeclined.reason, /pick the outline format/);
    },
  });
  assert.equal(bypasses(world).length, 1, 'by the commitment_overdue rule');

  const quiet = await s.idle(2 * 60 * MINUTE, { stepMs: 10 * MINUTE, settleMs: 150 });
  await quiet.expect({
    judgments: calls => assert.ok(calls.some(call => call.questions && Object.hasOwn(call.questions, 'needs_main_model')), 'the due reviews went to the judge'),
  });
  assert.equal(bypasses(world).length, 1, 'no bypass on the same situation');

  const again = await s.send('Here is the format: numbered scenes.', { reply: 'Noted.' });
  await again.expect({ state: () => assert.ok(bypasses(world).length >= 2, 'new evidence: the request is owed again') });
  await until(() => bypasses(world).length >= 2, 'the next bypass');
});
