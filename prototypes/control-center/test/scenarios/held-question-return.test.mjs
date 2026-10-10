// D4 scenario (B3 F4 and its review): a question the background decides while the user is away. Crosses the
// initiative's decision and SDK action queue, the narrator's pacing (presence, away), the project mind's threads, the
// JEV message.value judgment, the presence route, the interactions service (the question card) and the inbox ledger.
// Before F4 the held question was re-narrated (a JEV message.value call) every ten minutes until the user came back.
// Now (harness agent.ts:213-232: a latched wake is replayed when its blocker clears):
//  - it is narrated once and its record waits in its thread's `heldAsks`, never in `held` (what a host before F4 states
//    in its welcome-back text);
//  - nothing is narrated again while the user stays away;
//  - when the user opens the conversation, the card goes out from that record (`held_released`), not as welcome-back text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { decide, decisionInput } from '../harness/faux-model.mjs';

const MINUTE = 60000, QUESTION = 'Which ending should chapter three take?';
const askAction = world => (world.project().initiativeRuntime?.sdkState?.actions ?? []).find(row => row.action === 'ask');
const card = world => world.session().items.find(item => item.kind === 'question' && item.interaction?.source === 'initiative');
const askRecords = world => (world.project().mind?.pacing?.decisions ?? []).filter(row => row.kind === 'ask').map(row => [row.outcome, row.reasons]);
const valueCalls = world => world.jev.asked('new_information').length;
const HELD = ['narrator_away', 'narrator_held'];

test('a question decided while the user is away is narrated once, waits in its thread, and goes out as its card when the user is back', async t => {
  const world = await createWorld(t, { initiative: true, files: { 'chapter3.md': '# Chapter three\n\nThe harbour at dawn.\n' } });
  const s = scenario(world);
  // The gate wakes the main model; message.value abstains (pacing alone values the question).
  world.jev.answer('needs_main_model', .95).answer('evidence_relevant', .9).answer('already_reported', .05);
  let next = 'wait';
  world.faux.on('initiative', request => {
    const input = decisionInput(request);
    if (next !== 'ask') return decide(input, 'wait', '', { reason: 'Nothing new needs the user yet.', nextReviewAfterMs: 30 * MINUTE });
    next = 'wait';
    return decide(input, 'ask', 'Chapter three can end two ways.', { reason: 'The draft needs the user\'s choice of ending.', nextReviewAfterMs: 30 * MINUTE,
      fields: { questions: [{ id: 'ending', header: 'Ending', question: QUESTION, options: [{ id: 'quiet', label: 'Quiet' }, { id: 'open', label: 'Open' }] }] } });
  });
  await s.advanceClock(1000, { settleMs: 1500, label: 'the initiative reviews the new project' });
  const wrote = await s.send('Draft chapter three tonight.', { reply: 'Started on chapter three.' });
  await wrote.expect({ state: () => assert.equal(card(world), undefined) });
  // The user leaves (no presence for an hour: away), then the background decides it needs their choice.
  await world.idle(60 * MINUTE, { stepMs: 10 * MINUTE, settleMs: 120 });
  next = 'ask';
  await world.idle(40 * MINUTE, { stepMs: 10 * MINUTE, settleMs: 150 });
  // Held for the user's absence (narrator_away), or already waited again on its ten-minute backstop (narrator_held).
  await until(() => HELD.includes(askAction(world)?.deferredReason), 'the question to be held while the user is away');
  const narrated = valueCalls(world);
  assert.ok(narrated >= 1, 'narrated once, with its message.value judgment');
  const threads = () => world.project().mind.threads;
  assert.equal(card(world), undefined, 'not asked while the user is away');
  assert.deepEqual(threads().flatMap(row => (row.heldAsks ?? []).map(held => held.actionId)), [askAction(world).id], 'one record, in its thread');
  assert.deepEqual(threads().flatMap(row => row.held ?? []), [], 'never where a welcome-back text reads');
  assert.deepEqual(askRecords(world), [['hold', ['away']]]);

  // Two more hours away: nothing narrated again (before F4: a message.value call every ten minutes).
  await world.idle(120 * MINUTE, { stepMs: 10 * MINUTE, settleMs: 120 });
  assert.equal(valueCalls(world), narrated, 'no further narration');
  assert.deepEqual(askRecords(world), [['hold', ['away']]]);
  assert.equal(card(world), undefined);

  // The user opens the conversation.
  const back = await s.step('the user is back', async () => {
    const saved = await world.post(`/api/projects/${world.projectId}/presence`, { sessionId: world.sessionId, visible: true, typing: false });
    assert.equal(saved.status, 200);
    world.tick();
    return until(() => card(world), 'the question card');
  });
  await back.expect({ state: state => {
    const project = state.projects.find(row => row.id === world.projectId), session = state.sessions.find(row => row.id === world.sessionId);
    const entry = project.inbox.find(row => row.kind === 'ask');
    assert.deepEqual([entry.pacing.outcome, entry.pacing.reasons], ['send', ['held_released']]);
    assert.deepEqual(project.mind.threads.flatMap(row => row.heldAsks ?? []), [], 'the record left its thread as the card went out');
    assert.deepEqual(session.items.find(item => item.kind === 'question' && item.interaction?.source === 'initiative').interaction.questions.map(row => row.question), [QUESTION]);
    assert.equal(session.items.some(item => item.initiative?.kind === 'welcome_back'), false, 'a question is never stated in a welcome-back text');
  } });
  assert.equal(valueCalls(world), narrated, 'sent from its record, not narrated again');
});

// The B3 review's finding 1: message.value continued a thread the user's reply had resolved (resolved threads stay
// candidates for 7 days). The hold went into that resolved thread; its record was dropped there as not open, and the
// question was narrated again on every pump (a message.value call, two state writes and a pacing record each time). Now
// the hold reopens the thread, as a delivery there does, and the record waits in it.
test('a question held for a thread the user\'s reply resolved reopens that thread: narrated once, sent from its record when the user is back', async t => {
  const world = await createWorld(t, { initiative: true, files: { 'chapter3.md': '# Chapter three\n\nThe harbour at dawn.\n' } });
  const s = scenario(world);
  world.jev.answer('needs_main_model', .95).answer('evidence_relevant', .9).answer('already_reported', .05)
    .answer('new_information', .9).answer('relevant_now', .9).answer('continues_open_thread_or_commitment', .6).answer('time_sensitive', .1).answer('continues_thread', 'thread_0');
  let next = 'wait';
  world.faux.on('initiative', request => {
    const input = decisionInput(request);
    if (next !== 'ask') return decide(input, 'wait', '', { reason: 'Nothing new needs the user yet.', nextReviewAfterMs: 30 * MINUTE });
    next = 'wait';
    return decide(input, 'ask', 'Chapter three can end two ways.', { reason: 'The draft needs the user\'s choice of ending.', nextReviewAfterMs: 30 * MINUTE,
      fields: { questions: [{ id: 'ending', header: 'Ending', question: QUESTION, options: [{ id: 'quiet', label: 'Quiet' }, { id: 'open', label: 'Open' }] }] } });
  });
  await s.advanceClock(1000, { settleMs: 1500, label: 'the initiative reviews the new project' });
  await s.send('Draft chapter three tonight.', { reply: 'Started on chapter three.' });
  // An earlier topic about the chapter, closed by the user's reply (ProjectMind.settleThread: resolvedBy user_reply).
  const at = new Date(Date.now() - 5 * MINUTE).toISOString();
  world.store.mutate(state => {
    const project = state.projects.find(row => row.id === world.projectId);
    project.mind ??= {};
    project.mind.threads = [{ id: 'chapter-three', title: 'Chapter three opening', kind: 'topic', status: 'resolved', resolvedAt: at, resolvedBy: 'user_reply', awaitingUser: false, messageItemIds: [], messageSessions: {}, lastMessageAt: at, lastSummary: 'The opening scene is drafted.', held: [], reactions: {}, createdAt: at, updatedAt: at }];
  });
  await world.idle(60 * MINUTE, { stepMs: 10 * MINUTE, settleMs: 120 });
  next = 'ask';
  await world.idle(40 * MINUTE, { stepMs: 10 * MINUTE, settleMs: 150 });
  // Held for the user's absence (narrator_away), or already waited again on its ten-minute backstop (narrator_held).
  await until(() => HELD.includes(askAction(world)?.deferredReason), 'the question to be held while the user is away');
  const thread = () => world.project().mind.threads.find(row => row.id === 'chapter-three');
  await s.step('pumps without the clock moving', async () => { for (let n = 0; n < 10; n++) { world.tick(); await new Promise(done => setTimeout(done, 30)); } });
  const narrated = valueCalls(world);
  assert.ok(narrated >= 1);
  assert.deepEqual([thread().status, thread().resolvedAt, (thread().heldAsks ?? []).map(held => held.actionId)], ['open', undefined, [askAction(world).id]], 'the hold reopened the thread; its record waits there');
  assert.deepEqual(world.project().mind.pacing.decisions.filter(row => row.kind === 'ask').map(row => [row.outcome, row.reasons, row.threadId]), [['hold', ['away'], 'chapter-three']], 'one narration, on the continued thread');

  // Two more hours away: nothing narrated again.
  await world.idle(120 * MINUTE, { stepMs: 10 * MINUTE, settleMs: 120 });
  assert.equal(valueCalls(world), narrated, 'no further narration');
  assert.deepEqual(askRecords(world), [['hold', ['away']]]);

  const back = await s.step('the user is back', async () => {
    const saved = await world.post(`/api/projects/${world.projectId}/presence`, { sessionId: world.sessionId, visible: true, typing: false });
    assert.equal(saved.status, 200);
    world.tick();
    return until(() => card(world), 'the question card');
  });
  await back.expect({ state: state => {
    const project = state.projects.find(row => row.id === world.projectId), entry = project.inbox.find(row => row.kind === 'ask');
    assert.deepEqual([entry.pacing.outcome, entry.pacing.reasons, entry.threadId], ['send', ['held_released'], 'chapter-three']);
    assert.deepEqual(project.mind.threads.find(row => row.id === 'chapter-three').heldAsks, []);
  } });
  assert.equal(valueCalls(world), narrated, 'sent from its record');
});
