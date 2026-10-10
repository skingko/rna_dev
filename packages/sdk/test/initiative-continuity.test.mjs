import test from 'node:test';
import assert from 'node:assert/strict';
import { InitiativeCoordinator } from '../src/initiative.mjs';
const model = { protocol: 'openai', providerId: 'fixture', modelId: 'fixture', maxOutputTokens: 1024 };
const event = { id: 'outside-1', type: 'user_message', summary: 'Investigate the concrete input incompatibility.' };
const answer = (content, evidenceIds = [event.id]) => ({ action: content ? 'work' : 'wait', reason: 'Use actual diagnostic evidence', content, evidenceIds, nextReviewAfterMs: 86400000 });
function provider(fn) { return async function* (request) { const value = fn(JSON.parse(request.messages[0].content[0].text)); yield { type: 'text_delta', delta: JSON.stringify(value) }; yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: 'stop' }; }; }
const hold = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

for (const outcome of ['completed', 'failed']) test(`an occupied execution slot waits past its wake without requests or writes, then reviews its ${outcome} receipt`, async t => {
  let clock = 1000, calls = 0, writes = 0; const release = hold(), inputs = [];
  const coordinator = new InitiativeCoordinator({ model, now: () => clock, saveState: () => { writes++; },
    provider: provider(input => { inputs.push(input); calls++; return answer(calls === 1 ? 'Inspect slowly' : ''); }),
    handlers: { work: async () => { await release.promise; if (outcome === 'failed') throw Object.assign(new Error('Controlled actual failure'), { code: 'controlled_failure', usage: { totalTokens: 5 } }); return { summary: 'Actual completed inspection', usage: { totalTokens: 5 } }; } } });
  t.after(async () => { release.resolve(); await coordinator.close(); });
  await coordinator.observe(event); await coordinator.tick(); assert.equal(coordinator.active.size, 1);
  clock = coordinator.snapshot().nextReviewAt + 1; const before = writes;
  for (let i = 0; i < 1000; i++) assert.equal((await coordinator.tick()).reason, 'awaiting_action_result');
  assert.equal(calls, 1); assert.equal(writes, before);
  release.resolve(); await coordinator.idle(); await coordinator.tick();
  assert.equal(calls, 2); assert.equal(inputs[1].recentActions[0].status, outcome);
  if (outcome === 'failed') assert.equal(inputs[1].recentActions[0].failure.code, 'controlled_failure');
  else assert.ok(inputs[1].events.some(row => row.type === 'action_completed' && row.summary.includes('Actual completed inspection')));
});

// A host asks its judge about a review only when the coordinator would decide (decisionDue): while it waits for a
// result or for its external review, a judge's wake changes nothing, and asking again on every host pump wrote a ledger
// row per pump. decisionDue reads tick's own gates, so the two never disagree.
test('decisionDue is true exactly when a tick would request a decision', async t => {
  let clock = 1000, calls = 0; const release = hold();
  const coordinator = new InitiativeCoordinator({ model, now: () => clock, provider: provider(() => { calls++; return answer(calls === 1 ? 'Inspect slowly' : ''); }), handlers: { work: async () => { await release.promise; return { summary: 'done', usage: { totalTokens: 5 } }; } } });
  t.after(async () => { release.resolve(); await coordinator.close(); });
  assert.equal(coordinator.decisionDue(), false, 'no evidence'); assert.equal((await coordinator.tick()).reason, 'no_evidence');
  await coordinator.observe(event); assert.equal(coordinator.decisionDue(), true, 'new evidence');
  assert.equal((await coordinator.tick()).status, 'decided'); assert.equal(coordinator.active.size, 1);
  assert.equal(coordinator.decisionDue(), false, 'decided, not due yet');
  clock = coordinator.snapshot().nextReviewAt + 1;
  assert.equal(coordinator.decisionDue(), false, 'due by the clock, but the only slot is running');
  assert.equal(coordinator.decisionDue({ wakeFloor: true }), false, 'a host floor does not pass the slot wait either');
  assert.equal((await coordinator.tick()).reason, 'awaiting_action_result'); assert.equal(calls, 1);
  await coordinator.observe({ id: 'outside-2', type: 'user_message', summary: 'A new constraint.' });
  assert.equal(coordinator.decisionDue(), true, 'new evidence passes the slot wait, as in tick');
  await coordinator.updatePolicy({ enabled: false }); assert.equal(coordinator.decisionDue(), false, 'paused');
});
test('decisionDue follows the external-review barrier and the floor like tick', async t => {
  let clock = 1000, calls = 0;
  const coordinator = new InitiativeCoordinator({ model, now: () => clock, provider: provider(() => { calls++; return answer(calls === 1 ? 'Run the deploy check' : ''); }),
    handlers: { work: async () => { throw Object.assign(new Error('External command may still be running'), { code: 'uncertain_tool', usage: { totalTokens: 5 } }); } } });
  t.after(() => coordinator.close());
  await coordinator.observe(event); await coordinator.tick(); await coordinator.idle();
  assert.equal(coordinator.snapshot().actions[0].blocksExecution, true);
  assert.equal(coordinator.decisionDue(), true, 'the unresolved outcome is a changed situation: one decision may communicate it');
  assert.equal((await coordinator.tick()).status, 'decided'); assert.equal(calls, 2);
  clock = coordinator.snapshot().nextReviewAt + 1;
  assert.equal(coordinator.decisionDue(), false, 'then the coordinator waits for evidence or a resolution, not a timer');
  assert.equal(coordinator.decisionDue({ wakeFloor: true }), false);
  assert.equal((await coordinator.tick({ wakeFloor: true })).reason, 'awaiting_external_review'); assert.equal(calls, 2);
  await coordinator.observe({ id: 'outside-3', type: 'user_message', summary: 'I checked the deploy.' }); assert.equal(coordinator.decisionDue(), true);
});
test('new external evidence bypasses the occupied-slot wait and unused concurrent capacity remains usable', async t => {
  for (const maxConcurrent of [1, 2]) {
    let clock = 1000, calls = 0; const release = hold(), inputs = [];
    const coordinator = new InitiativeCoordinator({ model, now: () => clock, policy: { maxConcurrent }, provider: provider(input => { inputs.push(input); calls++; return answer(calls === 1 ? 'Inspect slowly' : ''); }), handlers: { work: async () => { await release.promise; return { usage: { totalTokens: 0 } }; } } });
    t.after(async () => { release.resolve(); await coordinator.close(); });
    await coordinator.observe(event); await coordinator.tick(); clock = coordinator.snapshot().nextReviewAt + 1;
    if (maxConcurrent === 2) { assert.equal((await coordinator.tick()).status, 'decided'); assert.equal(calls, 2); }
    await coordinator.observe({ id: 'new-user-input', type: 'user_message', summary: 'Stop the previous approach and use this new constraint.' });
    await coordinator.tick(); assert.ok(inputs.at(-1).events.some(row => row.summary === 'Stop the previous approach and use this new constraint.')); assert.equal(calls, maxConcurrent === 1 ? 2 : 3);
    release.resolve(); await coordinator.idle();
  }
});

test('one immediate diagnostic review persists across restart; exact failed work is suppressed without inventing evidence', async () => {
  let clock = 1000, calls = 0, works = 0, saved;
  const handlers = { work: async () => { works++; throw Object.assign(new Error('Missing project prerequisite'), { code: 'missing_prerequisite', usage: { totalTokens: 5 } }); } };
  const first = new InitiativeCoordinator({ model, now: () => clock, saveState: state => { saved = state; }, handlers, provider: provider(() => { calls++; return answer('Inspect path A'); }) });
  await first.observe(event); await first.tick(); await first.idle();
  assert.equal(works, 1); assert.ok(saved.pendingFailureReview); assert.deepEqual(saved.events.map(row => row.id), [event.id]);
  const state = saved; await first.close();
  const resumed = new InitiativeCoordinator({ model, state, now: () => clock, handlers, provider: provider(input => {
    calls++; assert.equal(input.recentActions[0].failure.code, 'missing_prerequisite'); return answer(calls <= 2 ? 'Inspect path A' : 'Inspect a different path B');
  }) });
  await resumed.tick(); await resumed.idle(); assert.equal(calls, 2); assert.equal(works, 1); assert.equal(resumed.snapshot().pendingFailureReview, undefined);
  for (let i = 0; i < 1000; i++) await resumed.tick(); assert.equal(calls, 2);
  clock = resumed.snapshot().nextReviewAt; await resumed.tick(); await resumed.idle(); assert.equal(works, 2);
  assert.equal(resumed.snapshot().pendingFailureReview, undefined, 'A different failed plan cannot finance endless immediate reviews from the same evidence');
  await resumed.tick(); assert.equal(calls, 3); assert.deepEqual(resumed.snapshot().events.map(row => row.id), [event.id]); await resumed.close();
});

test('new external evidence allows a justified retry and one further diagnostic review, while budget admission remains mandatory', async () => {
  let calls = 0, works = 0, now = 1000;
  const coordinator = new InitiativeCoordinator({ model, now: () => now, provider: provider(input => { calls++; return calls === 2 || calls === 4 ? answer('') : answer('Inspect path A', [input.events.at(-1).id]); }), handlers: { work: async () => { works++; throw Object.assign(new Error('Controlled provider condition'), { code: 'fixture_condition', usage: { totalTokens: 0 } }); } } });
  await coordinator.observe(event); await coordinator.tick(); await coordinator.idle();
  const pending = coordinator.snapshot().pendingFailureReview; await coordinator.updatePolicy({ tokenBudget: 0 });
  assert.equal((await coordinator.tick()).reason, 'budget_exhausted'); assert.deepEqual(coordinator.snapshot().pendingFailureReview, pending); assert.equal(calls, 1);
  await coordinator.updatePolicy({ tokenBudget: null }); await coordinator.tick(); assert.equal(calls, 2);
  now++; await coordinator.observe({ id: 'outside-2', type: 'prerequisite_verified', summary: 'The prerequisite changed; inspect its actual result.' });
  await coordinator.tick(); await coordinator.idle(); assert.equal(works, 2); assert.ok(coordinator.snapshot().pendingFailureReview); await coordinator.tick(); assert.equal(calls, 4);
  assert.deepEqual(coordinator.snapshot().events.map(row => row.id), ['outside-1', 'outside-2']); await coordinator.close();
});

test('failed diagnostic-review admission rolls back the consumed marker and keeps the real receipt', async () => {
  let reject = false, calls = 0;
  const coordinator = new InitiativeCoordinator({ model, provider: provider(() => { calls++; return answer(calls === 1 ? 'Inspect' : ''); }), saveState: (_state, metadata) => { if (reject && metadata?.reservationAdmission) throw new Error('Controlled storage fault'); }, handlers: { work: async () => { throw Object.assign(new Error('Controlled work failure'), { code: 'fixture_failure', usage: { totalTokens: 0 } }); } } });
  await coordinator.observe(event); await coordinator.tick(); await coordinator.idle(); const pending = coordinator.snapshot().pendingFailureReview;
  reject = true; await assert.rejects(coordinator.tick(), /storage fault/); assert.deepEqual(coordinator.snapshot().pendingFailureReview, pending); assert.equal(calls, 1);
  reject = false; await coordinator.tick(); assert.equal(calls, 2); assert.equal(coordinator.snapshot().actions[0].status, 'failed'); await coordinator.close();
});

test('unknown external effects allow one communication decision, then survive 200 idle hours and restart without paid polling', async () => {
  let clock = 1000, calls = 0, writes = 0, delivered = 0, saved;
  const make = state => new InitiativeCoordinator({ model, state, now: () => clock, saveState: value => { writes++; saved = value; },
    provider: provider(() => { calls++; return { ...answer('A real unknown outcome needs explicit verification.'), action: 'share' }; }),
    handlers: { share: async () => { delivered++; return { usage: { totalTokens: 0 } }; }, work: async () => { throw new Error('Must not execute unknown effects'); } } });
  let coordinator = make(); await coordinator.observe(event);
  coordinator.state.actions.push({ id: 'unknown', action: 'work', content: 'An interrupted operation', evidenceIds: [event.id], status: 'needs_review', blocksExecution: true });
  assert.equal((await coordinator.tick({ presence: { activeTurn: true } })).status, 'decided'); assert.equal(calls, 1);
  const before = writes;
  for (let i = 0; i < 1000; i++) { clock += 720000; assert.equal((await coordinator.tick({ presence: { activeTurn: true } })).reason, 'awaiting_external_review'); }
  assert.equal(writes, before); assert.equal(calls, 1); assert.equal(delivered, 0);
  await coordinator.close(); coordinator = make(saved);
  assert.equal((await coordinator.tick()).reason, 'awaiting_external_review'); await coordinator.idle();
  assert.equal(delivered, 1, 'Queued communication drains once the real reply is no longer running'); assert.equal(calls, 1);
  const restartWrites = writes; clock += 86400000; await coordinator.tick(); assert.equal(writes, restartWrites);
  await coordinator.observe({ id: 'real-new-user', type: 'user_message', summary: 'New constraint, without asserting the old outcome.' }); await coordinator.tick(); await coordinator.idle();
  assert.equal(calls, 2); assert.equal(coordinator.snapshot().actions[0].status, 'needs_review');
  const originalEvents = coordinator.snapshot().events;
  await coordinator.resolveAction('unknown', { status: 'cancelled', summary: 'A human checked and ended the old operation; result remains unverified.' });
  await coordinator.tick(); await coordinator.idle(); assert.equal(calls, 3); assert.deepEqual(coordinator.snapshot().events, originalEvents, 'Resolution is a receipt, never fabricated evidence');
  await coordinator.close();
});

test('a newly discovered unknown operation wakes even before the old review deadline, without replaying the old one', async () => {
  let calls = 0, clock = 1000;
  const coordinator = new InitiativeCoordinator({ model, now: () => clock, provider: provider(() => { calls++; return answer(''); }) });
  await coordinator.observe(event); await coordinator.tick(); assert.equal(calls, 1);
  coordinator.state.actions.push({ id: 'new-unknown', action: 'work', content: 'Unconfirmed outcome', evidenceIds: [event.id], status: 'needs_review', blocksExecution: true });
  assert.equal((await coordinator.tick()).status, 'decided'); assert.equal(calls, 2);
  assert.equal((await coordinator.tick()).reason, 'awaiting_external_review'); await coordinator.close();
});
