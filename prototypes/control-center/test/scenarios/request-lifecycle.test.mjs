// D4 scenario (P2 D4, MIND-5 / MIND-4 / MIND-15): a request the user sends twice is one commitment, not two; with the due
// judge acting no clock makes it overdue, and a turn that waits for the user's answer leaves it unowed; the assistant's own
// promise is turn.settled's verdict (a conditional reply opens nothing); and what the user does to a request the mind judge
// kept pending labels that judgment. Crosses the runtime (turn.route fan-out, turn.settled), the decision service, JEV, the
// project mind, the mind API and the decision ledger. Model and JEV only are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { ledgerRows } from '../../decision-ledger.mjs';
import { addCommitment, ensureMind } from '../../project-mind.mjs';

const mindOf = state => state.projects[0].mind ?? { commitments: [] };
const owed = state => mindOf(state).commitments;
const HOUR = 3600000;

test('a request sent twice is one commitment; a clock never makes it overdue while the due judge acts; a waiting turn leaves it unowed; a promise is the settle verdict; the user\'s hand labels the judgment', async t => {
  const world = await createWorld(t, { files: { 'README.md': '# Novel\n' } });
  const s = scenario(world), mind = world.store.mind, project = () => world.project();
  // The capture reads every message as a request for later work (nothing else is decided by the fake JEV).
  world.jev.answer('has_pending_request', 0.97).answer('is_standing_preference', 0.03).answer('is_correction', 0.03).answer('is_approval', 0.03).answer('requests_self_improvement', 0.03);

  // --- 1. the request, then the same request in other words
  const first = await s.send('Write chapter twelve and send it to me tomorrow.', { reply: 'Understood.' });
  await until(() => owed(world.store.state).length === 1, 'the request to be owed'); await mind.idle();
  await first.expect({ judgments: calls => assert.equal(calls.filter(call => Object.hasOwn(call.questions ?? {}, 'restates_pending_request')).length, 0, 'nothing pending yet, nothing to ask') });
  const [request] = owed(world.store.state);
  assert.equal(request.trigger, 'user_request'); assert.equal(request.status, 'pending'); assert.equal(request.overdueAt, undefined, 'no due moment at creation');

  // Hours pass with the due judge acting and nothing to show for it: the request is not overdue by a clock.
  await world.idle(6 * HOUR, { stepMs: HOUR, settleMs: 20 }); mind.sweep();
  assert.equal(owed(world.store.state)[0].overdueAt, undefined, 'a clock never makes it overdue while the judge acts');
  const counts = (await world.get(`/api/v2/projects/${world.projectId}/mind`)).body.counts;
  assert.equal(counts.pendingCommitments, 1); assert.equal(counts.overdueCommitments, 0);

  // The same request again: the judge says it asks for the pending request, and the turn that does it finishes it.
  world.jev.answer('restates_pending_request', 'req_0').answer('instruction_complete', 0.97).answer('deferred_without_cause', 0.03).answer('waiting_on_user', 0.03);
  const again = await s.send('Still waiting: please write chapter twelve and send it to me.', { reply: 'Chapter twelve is written and sent.' });
  await until(() => owed(world.store.state)[0].status === 'resolved', 'the joined request to be settled by its turn'); await mind.idle();
  await again.expect({
    judgments: calls => {
      const asked = calls.find(call => Object.hasOwn(call.questions ?? {}, 'restates_pending_request'));
      assert.ok(asked, 'the capture offered the pending request'); assert.match(JSON.stringify(asked.questions.restates_pending_request.criteria), /Write chapter twelve and send it to me tomorrow/);
    },
    state: state => {
      assert.equal(owed(state).length, 1, 'one request, one commitment: no twin');
      const [row] = owed(state), turn = state.sessions[0].turns.at(-1), message = state.sessions[0].items.find(item => item.id === turn.userItemId);
      assert.equal(row.evidence.length, 2); assert.deepEqual([row.continuedBy.via, row.continuedBy.itemId], ['jev', message.id]);
      assert.deepEqual(message.capture.continues, { commitmentId: row.id, via: 'jev' });
      assert.deepEqual([row.status, row.resolvedBy.turnId], ['resolved', turn.id]);
    },
  });

  // --- 2. a request whose turn ends waiting for the user's answer is not owed by Rna, whatever the clock says
  world.jev.answer('restates_pending_request', 'none').answer('instruction_complete', 0.04).answer('waiting_on_user', 0.95).answer('commits_to_later_work', 0.96);
  const waiting = await s.send('Write chapter thirteen once you know which ending I want.', { reply: 'Which ending do you want: tragic or open? I will write it as soon as you choose.' });
  await until(() => owed(world.store.state).some(row => row.request.includes('thirteen')), 'the second request'); await until(() => owed(world.store.state).find(row => row.request.includes('thirteen'))?.waitingOnUser, 'the wait to be recorded'); await mind.idle();
  const second = () => owed(world.store.state).find(row => row.request.includes('thirteen'));
  assert.equal(second().overdueAt, undefined);
  await waiting.expect({ state: state => assert.equal(owed(state).filter(row => row.trigger === 'agent_promise').length, 0, 'a reply that waits for the user promises nothing of its own, whatever it says about "as soon as"') });
  await world.idle(6 * HOUR, { stepMs: HOUR, settleMs: 20 }); mind.sweep();
  assert.equal((await world.get(`/api/v2/projects/${world.projectId}/mind`)).body.counts.overdueCommitments, 0);

  // --- 3. the assistant's own promise: turn.settled's verdict, with the sentence that states it
  world.jev.answer('instruction_complete', 0.97).answer('waiting_on_user', 0.05).answer('commits_to_later_work', 0.97).answer('promise_sentence', 's_1').answer('restates_pending_request', 'none');
  const promised = await s.send('Run the checks on chapter twelve.', { reply: 'The checks pass on the first half. I will rerun them on the whole chapter tonight and report back.' });
  await until(() => owed(world.store.state).some(row => row.trigger === 'agent_promise'), 'the promise to be owed'); await mind.idle();
  await promised.expect({ state: state => {
    const promise = owed(state).find(row => row.trigger === 'agent_promise');
    assert.equal(promise.request, 'I will rerun them on the whole chapter tonight and report back.'); assert.equal(promise.status, 'pending'); assert.equal(promise.source.kind, 'agent');
    assert.equal(state.sessions[0].turns.at(-1).settledVerdict.promise, true);
  } });

  // --- 4. the judgment behind a request kept pending is recorded; the user settling it by hand labels it (an outcome label)
  const kept = second();
  assert.equal(typeof kept.judgedLedgerId, 'string', 'the mind judge read it when the promise turn ended, and kept it pending'); assert.match(kept.judgedQuestion, /^resolved_\d$/);
  const call = ledgerRows(world.store).find(row => row.id === kept.judgedLedgerId); assert.equal(call.point, 'mind.judge');
  assert.equal(call.label, undefined, 'nothing labels a judgment but a person');
  const patched = await world.patch(`/api/v2/projects/${world.projectId}/mind/commitments/${kept.id}`, { status: 'resolved' });
  assert.equal(patched.status, 200);
  const labelled = ledgerRows(world.store).find(row => row.id === kept.judgedLedgerId);
  assert.deepEqual([labelled.label.value, labelled.label.source], [`${kept.judgedQuestion.replace(/_\d+$/, '')}_missed`, 'outcome']);
  assert.equal(owed(world.store.state).find(row => row.id === kept.id).judgedLedgerId, undefined, 'a decision is labelled once');
  void project;
});

// ------------------------------------------------------------------------------------------------ review of the D4 batch
// A request the user reopens after it ended stays open; the due judge reaches every pending request, not the first six; and a label
// goes only to the judgment that decided the row (a request asked for again, then finished by the turn's own verdict, is not what the
// mind judge's earlier "not yet" is blamed for). Real host, fake model and JEV only; the requests that need not come from a model are
// seeded through the mind's own writer.
const DAY = 24 * HOUR;

test('the due judge reaches every pending request in turn; a request that ended as expired and was reopened is not ended again; a later decision takes a label away from an earlier call', async t => {
  const world = await createWorld(t, { files: { 'README.md': '# Novel\n' } });
  const s = scenario(world), mind = world.store.mind;
  world.jev.answer('has_pending_request', 0.97).answer('is_standing_preference', 0.03).answer('is_correction', 0.03).answer('is_approval', 0.03).answer('requests_self_improvement', 0.03).answer('restates_pending_request', 'none');
  for (let index = 0; index < 6; index++) world.jev.answer(`due_${index}`, 0.04);   // every request: "it is fine to wait longer"
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'].map(name => `Request ${name}: tidy the ${name.toLowerCase()} notes`);
  world.store.mutate(state => { const mindState = ensureMind(state.projects[0]); for (const request of names) addCommitment(mindState, { request, trigger: 'user_request' }, { now: Date.now() }); });

  // --- 1. eight pending requests, a judge that always says wait: every one of them meets it within a few rounds (the call holds six)
  const seen = () => new Set(world.jev.asked('due_0').flatMap(call => names.filter(name => JSON.stringify(call.state).includes(name))));
  world.clock.advance(HOUR);
  for (let round = 0; round < 3; round++) { mind.sweep(); await mind.idle(); world.clock.advance(31 * 60000); }
  assert.deepEqual([...seen()].sort(), [...names].sort(), 'no request is starved by the ones before it');
  assert.equal(owed(world.store.state).filter(row => row.overdueAt !== undefined).length, 0, 'and nobody was made overdue by a clock');

  // --- 2. a request nobody touched for fourteen days ends as expired; the user reopens it from the mind page; it is not ended again
  const mindPath = `/api/v2/projects/${world.projectId}/mind`;
  world.clock.advance(15 * DAY); mind.sweep();
  const gone = (await world.get(mindPath)).body.commitments.filter(row => row.phase === 'expired');
  assert.equal(gone.length, names.length, 'fifteen days on, none of them was ever touched');
  const target = gone[0];
  const reopened = await world.patch(`${mindPath}/commitments/${target.id}`, { status: 'pending' });
  assert.equal(reopened.status, 200);
  world.clock.advance(40000); mind.sweep(); await mind.idle();
  const after = owed(world.store.state).find(row => row.id === target.id);
  assert.equal(after.status, 'pending', 'the user reopened it a minute ago'); assert.equal(after.reason, undefined);
  assert.equal((await world.get(mindPath)).body.commitments.find(row => row.id === target.id).phase, 'open');
  world.clock.advance(13 * DAY); mind.sweep();
  assert.equal(owed(world.store.state).find(row => row.id === target.id).status, 'pending', 'thirteen days from the user\'s hand it is still theirs');

  // --- 3. a request the judge kept pending, then asked for again and finished by the turn\'s own verdict: reopening it blames no one
  world.jev.answer('instruction_complete', 0.04).answer('waiting_on_user', 0.04).answer('deferred_without_cause', 0.04);
  const third = await s.send('Write the epilogue and send it to me.', { reply: 'On it.' });
  await until(() => owed(world.store.state).some(row => row.request.includes('epilogue')), 'the epilogue request'); await mind.idle();
  const epilogue = () => owed(world.store.state).find(row => row.request.includes('epilogue'));
  const judgedBy = epilogue().judgedLedgerId; assert.equal(typeof judgedBy, 'string', 'the mind judge read it and kept it pending');
  await third.expect({ state: () => assert.equal(ledgerRows(world.store).find(row => row.id === judgedBy).point, 'mind.judge') });
  world.jev.answer('restates_pending_request', 'req_0').answer('instruction_complete', 0.97).answer('deferred_without_cause', 0.03);
  await s.send('Please write the epilogue now.', { reply: 'The epilogue is written and sent.' });
  await until(() => epilogue().status === 'resolved', 'the epilogue request to be settled by its turn'); await mind.idle();
  assert.equal(epilogue().judgedLedgerId, undefined, 'the call that read the first ask is not the one that settled it');
  const undone = await world.patch(`${mindPath}/commitments/${epilogue().id}`, { status: 'pending' });
  assert.equal(undone.status, 200);
  assert.equal(ledgerRows(world.store).find(row => row.id === judgedBy).label, undefined, 'reopening what the turn verdict settled says nothing about the earlier call');
  assert.equal(ledgerRows(world.store).filter(row => row.point === 'mind.judge' && row.label).length, 0);
});
