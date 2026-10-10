import test from 'node:test';
import assert from 'node:assert/strict';
import { capturedTarget, storedTarget, replyTargetOf, replyCandidates, replyAskable, attributeReply, retryDue, cardText, REPLY_ASK_ATTEMPTS, REPLY_RETRY_MS } from '../reply-attribution.mjs';
import { scanFeedback, settleDeliveryFeedback, attributeReplies, recordDelivery } from '../proactive-delivery.mjs';

// C3 reply attribution (plan §2.3 #2; headlong bin/chat:176-230 reply_to: "answered" is a fact, not an order guess): which delivered
// message does a user message answer? A model says (the focused question reply.target, else the capture's target by who
// named it); only when nobody can tell does B3's order rule settle the latest unanswered one. Synthetic data.
const MINUTE = 60000, HOUR = 60 * MINUTE;
const T0 = Date.parse('2026-10-05T02:00:00Z'), iso = ms => new Date(ms).toISOString();
const user = (id, at, extra = {}) => ({ id, kind: 'user', text: `message ${id}`, createdAt: iso(at), ...extra });
const share = (id, at, extra = {}) => ({ id, kind: 'assistant', source: 'initiative', text: `finding ${id}`, createdAt: iso(at), initiativeActionId: `act-${id}`, initiative: { kind: 'insight', reach: 'inline' }, ...extra });
const foreground = (id, at, turnId = `t-${id}`) => ({ id, kind: 'assistant', text: `reply ${id}`, createdAt: iso(at), turnId, final: true });
const world = (count = 3) => {
  const project = { id: 'p', inbox: [] }, items = [], entries = [];
  for (let index = 0; index < count; index++) {
    const key = ['a', 'b', 'c', 'd', 'e'][index], at = T0 + index * HOUR, item = share(key, at); items.push(item);
    entries.push(recordDelivery(project, { actionId: `act-${key}`, tier: 'inline', text: item.text, sessionId: 's', itemId: key, now: at }));
  }
  return { project, items, entries, session: () => ({ id: 's', items }) };
};
const outcomes = (project, items, options = {}) => scanFeedback(project, [{ id: 's', items }], options);

test('what a capture says it is about: only a model\'s naming counts, by who named it', () => {
  const output = { kind: 'output', itemId: 'x' };
  assert.deepEqual(capturedTarget({ target: output, targetSource: 'jev' }), { itemId: 'x', source: 'jev', via: 'capture' });
  assert.deepEqual(capturedTarget({ target: output, targetSource: 'fast_model' }), { itemId: 'x', source: 'fast_model', via: 'capture' });
  assert.equal(capturedTarget({ target: output, targetSource: 'heuristic' }), null, 'the regex fallback\'s "the latest output" names nothing');
  assert.equal(capturedTarget({ target: output }), null, 'a capture from before targetSource');
  assert.deepEqual(capturedTarget({ target: null, targetSource: 'jev' }), { itemId: null, source: 'jev', via: 'capture' }, 'JEV is sure it reacts to nothing earlier');
  assert.equal(capturedTarget({ target: null, targetSource: 'fast_model' }), null);
  assert.equal(capturedTarget({ target: { kind: 'thread', threadId: 't' }, targetSource: 'jev' }), null, 'a thread is a topic, not an item');
  assert.equal(capturedTarget(null), null); assert.equal(capturedTarget({ correction: true }), null);
});

test('the focused question outranks the capture; an abstention, a shadow run and an unanswered ask say nothing', () => {
  const capture = { target: { kind: 'output', itemId: 'cap' }, targetSource: 'jev' };
  assert.deepEqual(replyTargetOf({ capture }), { itemId: 'cap', source: 'jev', via: 'capture' });
  assert.deepEqual(replyTargetOf({ capture, replyTo: { source: 'jev', itemId: 'asked', kind: 'delivery' } }), { itemId: 'asked', source: 'jev', via: 'reply.target', kind: 'delivery' });
  assert.deepEqual(replyTargetOf({ capture, replyTo: { source: 'jev', itemId: null, kind: 'none' } }), { itemId: null, source: 'jev', via: 'reply.target', kind: 'none' }, 'sure it answers none of them');
  for (const replyTo of [{ source: 'jev', abstained: true }, { source: 'jev', shadow: true }, { source: 'jev', attempts: 1 }]) {
    assert.equal(storedTarget({ replyTo }), null, JSON.stringify(replyTo));
    assert.deepEqual(replyTargetOf({ capture, replyTo }), { itemId: 'cap', source: 'jev', via: 'capture' }, 'then the capture speaks');
  }
  assert.equal(replyTargetOf({ replyTo: { source: 'jev', abstained: true } }), null);
});

test('candidates: the recent deliveries newest first, the latest foreground reply only when it came after the oldest of them', () => {
  const w = world(3);
  w.items.push(foreground('f1', T0 + 3 * HOUR), { id: 'w1', kind: 'assistant', source: 'initiative', text: 'Background work: x', createdAt: iso(T0 + 3.5 * HOUR), initiativeActionId: 'run-1-changes', initiative: { kind: 'insight', reach: 'inbox', backgroundWork: { actionId: 'run-1', status: 'done' } } },
    { id: 'sched', kind: 'assistant', source: 'initiative', text: 'Daily report', createdAt: iso(T0 + 4 * HOUR), initiativeActionId: 'act-sched', scheduleId: 'sch1', initiative: { kind: 'scheduled', reach: 'inline' } }, user('u1', T0 + 5 * HOUR));
  const found = replyCandidates(w.session(), w.items.at(-1));
  assert.deepEqual(found.deliveries.map(row => [row.id, row.kind]), [['sched', 'scheduled report'], ['c', 'finding'], ['b', 'finding'], ['a', 'finding']], 'a status line is not a delivery');
  assert.deepEqual(found.latestReply, { id: 'f1', text: 'reply f1' });
  // A reply that came before every delivery is not an option; neither is a streaming or deleted one.
  const early = world(2); early.items.unshift(foreground('f0', T0 - HOUR)); early.items.push(user('u', T0 + 3 * HOUR));
  assert.equal(replyCandidates(early.session(), early.items.at(-1)).latestReply, null);
  const hidden = world(2); hidden.items[1].sourceDeleted = true; hidden.items.push(user('u', T0 + 3 * HOUR));
  assert.deepEqual(replyCandidates(hidden.session(), hidden.items.at(-1)).deliveries.map(row => row.id), ['a']);
  // At most five, and none older than two days.
  const many = world(5); many.items.push(share('f', T0 + 5 * HOUR), share('g', T0 + 6 * HOUR), user('u', T0 + 7 * HOUR));
  assert.deepEqual(replyCandidates(many.session(), many.items.at(-1)).deliveries.map(row => row.id), ['g', 'f', 'e', 'd', 'c']);
  const old = world(1); old.items.push(user('u', T0 + 49 * HOUR));
  assert.deepEqual(replyCandidates(old.session(), old.items.at(-1)).deliveries, [], 'past the ledger\'s longest window');
  assert.equal(replyAskable(old.session(), old.items.at(-1)), false, 'nothing to attribute');
});

test('F3 (the acceptance): a message JEV places on none of a night\'s shares settles none of them; before C3 it settled the latest', () => {
  const w = world(3);
  // The morning message, as capture recorded it: JEV is sure it reacts to nothing earlier.
  w.items.push(user('morning', T0 + 7 * HOUR, { capture: { correction: false, target: null, targetSource: 'jev' } }));
  assert.deepEqual(outcomes(w.project, w.items, { now: T0 + 7 * HOUR + MINUTE }).settled, [], 'nothing replied');
  // Likewise when the focused question says so.
  const asked = world(3); asked.items.push(user('morning', T0 + 7 * HOUR, { capture: { correction: false }, replyTo: { source: 'jev', itemId: null, kind: 'none' } }));
  assert.deepEqual(outcomes(asked.project, asked.items, { now: T0 + 7 * HOUR + MINUTE }).settled, []);
  // The windows still close on their own: ignored, not replied.
  const later = outcomes(w.project, w.items, { now: T0 + 13 * HOUR + MINUTE });
  assert.deepEqual(later.settled.map(row => [row.id, row.feedback.outcome]), w.entries.slice(0, 2).map(row => [row.id, 'ignored']), 'the two whose 12 hours are over');
});

test('a reply that names a share settles that share, not the latest; one message answers one delivered message', () => {
  const w = world(3);
  w.items.push(user('m1', T0 + 4 * HOUR, { capture: { target: { kind: 'output', itemId: 'a' }, targetSource: 'jev' } }), user('m2', T0 + 5 * HOUR, { replyTo: { source: 'jev', itemId: 'b', kind: 'delivery' } }));
  const { settled } = outcomes(w.project, w.items, { now: T0 + 5 * HOUR + MINUTE });
  assert.deepEqual(settled.map(row => [row.id, row.feedback.outcome, row.feedback.replyItemId, row.feedback.replyVia]), [[w.entries[0].id, 'replied', 'm1', 'capture'], [w.entries[1].id, 'replied', 'm2', 'reply.target']], 'by ledger order');
  assert.equal(w.entries[2].feedback, null, 'the latest share was not answered');
  // The same share named again by a later message is already answered: it settles nothing else.
  w.items.push(user('m3', T0 + 6 * HOUR, { replyTo: { source: 'jev', itemId: 'b', kind: 'delivery' } }));
  assert.deepEqual(outcomes(w.project, w.items, { now: T0 + 6 * HOUR + MINUTE }).settled, []);
});

test('a reply that names something that is not a delivered message settles no delivery: a foreground reply, a share outside the window', () => {
  const w = world(2); w.items.push(foreground('f1', T0 + 3 * HOUR), user('m', T0 + 4 * HOUR, { replyTo: { source: 'jev', itemId: 'f1', kind: 'latest_reply' } }));
  assert.deepEqual(outcomes(w.project, w.items, { now: T0 + 4 * HOUR + MINUTE }).settled, []);
  const gone = world(2); gone.items.push(user('m', T0 + 4 * HOUR, { replyTo: { source: 'jev', itemId: 'deleted-share', kind: 'delivery' } }));
  assert.deepEqual(outcomes(gone.project, gone.items, { now: T0 + 4 * HOUR + MINUTE }).settled, []);
});

test('entries a digest merged answer together when the reply names the digest; a share the model could not place falls to the order rule', () => {
  const project = { id: 'p', inbox: [] }, items = [share('older', T0), { ...share('dg', T0 + 3 * HOUR), initiative: { kind: 'digest', reach: 'digest' } }];
  recordDelivery(project, { actionId: 'a0', tier: 'inline', text: 'older', sessionId: 's', itemId: 'older', now: T0 });
  const merged = ['d1', 'd2'].map(id => Object.assign(recordDelivery(project, { actionId: id, tier: 'digest', text: id, sessionId: 's', now: T0 + HOUR }), { heldForDigest: false, digestedAt: iso(T0 + 3 * HOUR), digestItemId: 'dg', digestSessionId: 's' }));
  items.push(user('reply', T0 + 4 * HOUR, { replyTo: { source: 'jev', itemId: 'dg', kind: 'delivery' } }));
  assert.deepEqual(outcomes(project, items, { now: T0 + 4 * HOUR + MINUTE }).settled.map(row => row.id), merged.map(row => row.id));
  // Nobody could tell: B3's rule (the latest unanswered one visible before it), by 'order'.
  const w = world(3); w.items.push(user('thanks', T0 + 4 * HOUR, { capture: { approval: null, target: { kind: 'output', index: 0 }, targetSource: 'heuristic' } }));
  const { settled } = outcomes(w.project, w.items, { now: T0 + 4 * HOUR + MINUTE });
  assert.deepEqual(settled.map(row => [row.id, row.feedback.replyItemId, row.feedback.replyVia]), [[w.entries[2].id, 'thanks', 'order']]);
});

test('a message still waiting for its capture or for the focused question is not read yet, and nothing after it is', () => {
  const w = world(2); w.items.push(user('m1', T0 + 3 * HOUR), user('m2', T0 + 4 * HOUR));
  const waiting = outcomes(w.project, w.items, { now: T0 + 4 * HOUR + MINUTE, awaiting: new Set(['m1']) });
  assert.deepEqual(waiting.settled, []); assert.deepEqual(waiting.pending, [{ sessionId: 's', itemId: 'm1', reason: 'capture' }]);
  // Its capture lands (it names the older share): m1 settles that one, and m2 is read next.
  w.items[2].capture = { target: { kind: 'output', itemId: 'a' }, targetSource: 'jev' };
  const settled = outcomes(w.project, w.items, { now: T0 + 4 * HOUR + MINUTE, awaiting: new Set() });
  assert.deepEqual(settled.settled.map(row => [row.feedback.replyItemId, row.feedback.replyVia]), [['m1', 'capture'], ['m2', 'order']]);
  // The focused question: held while it can still be asked; once its attempts are spent, the order rule reads it.
  const j = world(2); j.items.push(user('m', T0 + 3 * HOUR));
  const held = outcomes(j.project, j.items, { now: T0 + 3 * HOUR + MINUTE, judging: true });
  assert.deepEqual(held.settled, []); assert.deepEqual(held.pending, [{ sessionId: 's', itemId: 'm', reason: 'judgement' }]);
  j.items.at(-1).replyTo = { source: 'jev', at: iso(T0), attempts: REPLY_ASK_ATTEMPTS };
  assert.deepEqual(outcomes(j.project, j.items, { now: T0 + 3 * HOUR + MINUTE, judging: true }).settled.map(row => row.feedback.replyVia), ['order']);
  // A window closing while a message that could answer it waits is not over: not ignored yet.
  const closing = world(1); closing.items.push(user('m', T0 + 11 * HOUR));
  assert.deepEqual(outcomes(closing.project, closing.items, { now: T0 + 13 * HOUR, awaiting: new Set(['m']) }).settled, [], 'the share\'s 12 hours are over, but the message inside them is unread');
  assert.deepEqual(outcomes(closing.project, closing.items, { now: T0 + 13 * HOUR }).settled.map(row => row.feedback.outcome), ['replied'], 'read by order: it did arrive inside the window');
});

// ---------------------------------------------------------------- the asking
const store = (items, project = { id: 'p', name: 'Novel', inbox: [] }) => { const state = { projects: [project], sessions: [{ id: 's', projectId: 'p', items }] }; return { state, mutate: fn => fn(state), mind: null }; };
const decisionsOf = answer => { const asked = []; return { asked, enabled: point => point === 'reply.target', replyTarget: async (_project, input) => { asked.push(input); return typeof answer === 'function' ? answer(input) : answer; } }; };

test('attributeReply asks once per message, with the deliveries newest first and the latest reply, and keeps the answer on the message', async () => {
  const w = world(3); w.items.push(foreground('f1', T0 + 3 * HOUR), user('m', T0 + 4 * HOUR));
  const decisions = decisionsOf({ target: 1, ledgerId: 'rt-1' }), s = store(w.items);
  const row = await attributeReply(s, decisions, { sessionId: 's', itemId: 'm', now: () => T0 + 4 * HOUR });
  assert.deepEqual(row, { source: 'jev', at: iso(T0 + 4 * HOUR), itemId: 'b', kind: 'delivery', ledgerId: 'rt-1' }, 'index 1 of [c, b, a] is b');
  assert.deepEqual(decisions.asked[0].deliveries.map(item => item.text), ['finding c', 'finding b', 'finding a']); assert.equal(decisions.asked[0].latestReply, 'reply f1'); assert.equal(decisions.asked[0].message, 'message m');
  assert.deepEqual(replyTargetOf(w.items.at(-1)), { itemId: 'b', source: 'jev', via: 'reply.target', kind: 'delivery' });
  await attributeReply(s, decisions, { sessionId: 's', itemId: 'm' });
  assert.equal(decisions.asked.length, 1, 'answered: never asked again');
  // Concurrent callers (the ledger pump and evolution) share one question.
  const q = world(2); q.items.push(user('m', T0 + 3 * HOUR));
  const slow = decisionsOf(async () => { await new Promise(done => setTimeout(done, 20)); return { target: null }; });
  const both = await Promise.all([attributeReply(store(q.items), slow, { sessionId: 's', itemId: 'm' }), attributeReply(store(q.items), slow, { sessionId: 's', itemId: 'm' })]);
  assert.equal(slow.asked.length, 1); assert.deepEqual(both[0], both[1]);
});

test('attributeReply: none, the latest reply, an abstention, a shadow run, no judge and no candidates', async () => {
  const kinds = {};
  for (const [name, answer] of Object.entries({ none: { target: null }, latest: { target: null, other: 'latest_reply' }, abstained: { ledgerId: 'x' }, shadow: { shadow: true } })) {
    const w = world(2); w.items.push(foreground('f1', T0 + 3 * HOUR), user('m', T0 + 4 * HOUR));
    kinds[name] = await attributeReply(store(w.items), decisionsOf(answer), { sessionId: 's', itemId: 'm', now: () => T0 });
  }
  assert.deepEqual([kinds.none.itemId, kinds.none.kind], [null, 'none']);
  assert.deepEqual([kinds.latest.itemId, kinds.latest.kind], ['f1', 'latest_reply']);
  assert.equal(kinds.abstained.abstained, true); assert.equal(kinds.abstained.ledgerId, 'x'); assert.equal(kinds.shadow.shadow, true);
  for (const row of [kinds.abstained, kinds.shadow]) assert.equal(replyTargetOf({ replyTo: row }), null, 'says nothing');
  // No judge: nothing asked, nothing written.
  const off = world(2); off.items.push(user('m', T0 + 3 * HOUR));
  assert.equal(await attributeReply(store(off.items), { enabled: () => false, replyTarget: async () => assert.fail('asked') }, { sessionId: 's', itemId: 'm' }), null); assert.equal(off.items.at(-1).replyTo, undefined);
  // No candidates: nothing to ask about.
  const none = [user('m', T0)], decisions = decisionsOf({ target: 0 });
  assert.equal(await attributeReply(store(none), decisions, { sessionId: 's', itemId: 'm' }), null); assert.equal(decisions.asked.length, 0);
});

test('a question the judge did not answer is counted, asked again after its back-off, and given up after its attempts', async () => {
  const w = world(2); w.items.push(user('m', T0 + 3 * HOUR));
  const decisions = decisionsOf(null), s = store(w.items);
  let clock = T0 + 3 * HOUR + MINUTE;
  for (let attempt = 1; attempt <= REPLY_ASK_ATTEMPTS; attempt++) {
    assert.equal(replyAskable(s.state.sessions[0], w.items.at(-1)), true, `attempt ${attempt}`);
    assert.equal((await attributeReply(s, decisions, { sessionId: 's', itemId: 'm', now: () => clock })).attempts, attempt);
    clock += REPLY_RETRY_MS[Math.min(attempt, REPLY_RETRY_MS.length) - 1];
  }
  assert.equal(replyAskable(s.state.sessions[0], w.items.at(-1)), false); assert.equal(decisions.asked.length, REPLY_ASK_ATTEMPTS);
  assert.equal(replyTargetOf(w.items.at(-1)), null, 'the order rule reads it');
});

test('F3 (review): a short outage does not spend the attempts; the message waits for the judge and is not handed to the order rule', async () => {
  const w = world(2); w.items.push(user('m', T0 + 3 * HOUR));
  let down = true; const decisions = decisionsOf(() => down ? null : { target: null }), s = store(w.items, w.project);
  const start = T0 + 3 * HOUR + 10000;
  // The pump ticks every 30 seconds. Before the back-off three ticks in a row spent all three attempts (about 90 seconds), and the
  // message then settled the latest share by order for good: a laptop waking from sleep was enough.
  for (const tick of [0, 30000, 59000]) assert.deepEqual(await attributeReplies(s, 'p', { decisions, now: start + tick }), [], `tick ${tick}`);
  assert.equal(decisions.asked.length, 1, 'asked once; the next ticks are inside its back-off');
  assert.equal(w.items.at(-1).replyTo.attempts, 1);
  assert.deepEqual(w.entries.map(row => row.feedback), [null, null], 'nothing settled by order while the judge may still answer');
  assert.deepEqual(scanFeedback(w.project, [{ id: 's', items: w.items }], { now: start + 59000, judging: true }).pending, [{ sessionId: 's', itemId: 'm', reason: 'judgement' }]);
  // The judge is back: the question is asked again and the unrelated message settles none of the shares.
  down = false;
  assert.deepEqual(await attributeReplies(s, 'p', { decisions, now: start + MINUTE }), []);
  assert.equal(decisions.asked.length, 2); assert.deepEqual([w.items.at(-1).replyTo.itemId, w.items.at(-1).replyTo.kind], [null, 'none']);
  assert.deepEqual(w.entries.map(row => row.feedback), [null, null], 'after C3 an unrelated message settles no share, and after a short outage neither');
  // An outage that outlasts every back-off falls to the order rule, as when nobody can tell.
  const long = world(2); long.items.push(user('m', T0 + 3 * HOUR));
  const stuck = decisionsOf(null), t = store(long.items, long.project); let clock = start;
  for (let attempt = 1; attempt <= REPLY_ASK_ATTEMPTS; attempt++) { await attributeReplies(t, 'p', { decisions: stuck, now: clock }); clock += REPLY_RETRY_MS[Math.min(attempt, REPLY_RETRY_MS.length) - 1]; }
  assert.equal(stuck.asked.length, REPLY_ASK_ATTEMPTS);
  assert.deepEqual(long.entries.map(row => row.feedback?.replyVia ?? null), [null, 'order']);
});

test('the back-off: due at once when nothing was tried, then after each wait, the last one repeating', () => {
  assert.equal(retryDue(undefined, T0), true); assert.equal(retryDue({ source: 'jev', itemId: 'a' }, T0), true);
  const failed = attempts => ({ source: 'jev', at: iso(T0), attempts });
  assert.deepEqual([failed(1), failed(2), failed(3), failed(4)].map((row, index) => [retryDue(row, T0 + REPLY_RETRY_MS[index] - 1), retryDue(row, T0 + REPLY_RETRY_MS[index])]), [[false, true], [false, true], [false, true], [false, true]]);
  assert.equal(retryDue(failed(9), T0 + REPLY_RETRY_MS.at(-1) - 1), false); assert.equal(retryDue(failed(9), T0 + REPLY_RETRY_MS.at(-1)), true);
});

test('the ledger pass asks for the messages it waits on and then settles by the answers', async () => {
  const w = world(3); w.items.push(user('morning', T0 + 7 * HOUR), user('about-a', T0 + 8 * HOUR));
  const answers = { 'message morning': { target: null }, 'message about-a': { target: 2 } };
  const decisions = decisionsOf(input => answers[input.message]), s = store(w.items, w.project);
  const settled = await attributeReplies(s, 'p', { decisions, now: T0 + 8 * HOUR + MINUTE });
  assert.deepEqual(decisions.asked.map(input => input.message), ['message morning', 'message about-a'], 'in order, one question each');
  assert.deepEqual(settled.map(row => [row.id, row.feedback.outcome, row.feedback.replyItemId, row.feedback.replyVia]), [[w.entries[0].id, 'replied', 'about-a', 'reply.target']]);
  assert.deepEqual(w.entries.slice(1).map(row => row.feedback), [null, null], 'the unrelated morning message settled nothing, and neither did a share nobody answered');
  assert.deepEqual((await attributeReplies(s, 'p', { decisions, now: T0 + 8 * HOUR + 2 * MINUTE })), [], 'nothing left to ask or settle');
  assert.equal(decisions.asked.length, 2);
  // Without the judge nothing is asked and the order rule applies at once.
  const off = world(2); off.items.push(user('m', T0 + 3 * HOUR));
  const plain = settleDeliveryFeedback(store(off.items, off.project), 'p', { decisions: { enabled: () => false }, now: T0 + 3 * HOUR + MINUTE });
  assert.deepEqual(plain.map(row => [row.id, row.feedback.replyVia]), [[off.entries[1].id, 'order']]);
});

test('a message of the running turn that has no capture yet is waited for (the stretch before routing starts); not for ever', () => {
  const w = world(2); w.items.push(user('m', T0 + 3 * HOUR));
  const running = { id: 's', activeTurnId: 't1', turns: [{ id: 't1', userItemId: 'm' }], items: w.items };
  const waiting = scanFeedback(w.project, [running], { now: T0 + 3 * HOUR + 10000 });
  assert.deepEqual(waiting.settled, []); assert.deepEqual(waiting.pending, [{ sessionId: 's', itemId: 'm', reason: 'capture' }]);
  // Three minutes on, a capture that never came is not waited for: the order rule reads it.
  assert.deepEqual(scanFeedback(w.project, [running], { now: T0 + 3 * HOUR + 3 * MINUTE }).settled.map(row => row.feedback.replyVia), ['order']);
  // A turn that is over, or a message whose capture has landed, is read at once.
  const done = world(2); done.items.push(user('m', T0 + 3 * HOUR));
  assert.deepEqual(scanFeedback(done.project, [{ id: 's', activeTurnId: null, turns: [{ id: 't1', userItemId: 'm' }], items: done.items }], { now: T0 + 3 * HOUR + 10000 }).settled.map(row => row.feedback.replyVia), ['order']);
  const captured = world(2); captured.items.push(user('m', T0 + 3 * HOUR, { capture: { correction: false, target: null, targetSource: 'jev' } }));
  assert.deepEqual(scanFeedback(captured.project, [{ id: 's', activeTurnId: 't1', turns: [{ id: 't1', userItemId: 'm' }], items: captured.items }], { now: T0 + 3 * HOUR + 10000 }).settled, []);
});

// ---------------------------------------------------------------- question cards (review F1)
const QUESTIONS = [{ id: 'platform', header: 'Platform', question: 'Which platform should the build target?', options: [{ id: 'ios', label: 'iOS' }, { id: 'android', label: 'Android' }] }];
/** A pending question card the host asked (an ask or a direct fix to keep or revert) at `at`: its conversation item and its ledger entry (no item id, an interaction id). */
const addCard = (w, at, { id = 'card1', questions = QUESTIONS, kind = 'ask', status = 'pending', answeredAt } = {}) => {
  const interaction = { id: `int-${id}`, kind: 'question', source: 'initiative', status, canRespond: status === 'pending', questions, ...(answeredAt ? { answeredAt: iso(answeredAt) } : {}) };
  w.items.push({ id, kind: 'question', text: '', turnId: null, createdAt: iso(at), source: 'interaction', interaction });
  const entry = recordDelivery(w.project, { actionId: `act-${id}`, kind, tier: 'inline', text: 'a card', sessionId: 's', interactionId: interaction.id, now: at });
  w.entries.push(entry); return entry;
};

test('F1 (review): a question card is offered to the judge as a delivery, with its questions and options, while it is unanswered', () => {
  const w = world(1), card = addCard(w, T0 + HOUR); w.items.push(user('m', T0 + 2 * HOUR));
  const { deliveries } = replyCandidates(w.session(), w.items.at(-1));
  assert.deepEqual(deliveries.map(row => [row.id, row.kind]), [['card1', 'question card'], ['a', 'finding']], 'newest first');
  assert.equal(deliveries[0].text, 'Which platform should the build target? (options: iOS / Android)'); assert.equal(cardText({ interaction: { questions: [{ header: 'Keep?', options: [] }] } }), 'Keep?');
  assert.equal(replyAskable(w.session(), w.items.at(-1)), true);
  // A card the user already answered (or cancelled) before the message is dealt with; one answered after it was open when it was sent.
  const settled = world(1); addCard(settled, T0 + HOUR, { status: 'answered', answeredAt: T0 + 90 * MINUTE }); settled.items.push(user('m', T0 + 2 * HOUR));
  assert.deepEqual(replyCandidates(settled.session(), settled.items.at(-1)).deliveries.map(row => row.id), ['a']);
  const later = world(1); addCard(later, T0 + HOUR, { status: 'answered', answeredAt: T0 + 3 * HOUR }); later.items.push(user('m', T0 + 2 * HOUR));
  assert.deepEqual(replyCandidates(later.session(), later.items.at(-1)).deliveries.map(row => row.id), ['card1', 'a']);
  // Only the host's own cards: a question the model asked in a turn is not a delivery.
  const tool = world(1); addCard(tool, T0 + HOUR); tool.items.find(row => row.id === 'card1').interaction.source = 'tool'; tool.items.push(user('m', T0 + 2 * HOUR));
  assert.deepEqual(replyCandidates(tool.session(), tool.items.at(-1)).deliveries.map(row => row.id), ['a']);
  assert.equal(card.feedback, null);
});

test('F1 (review): a typed reply to an ask card or a direct-fix card is a reply to it: by the judge\'s answer, and by order where only the capture spoke', async () => {
  const FIX = [{ id: 'decision', header: '已直接处理', question: '我发现了几处明确的问题，已经直接修正（2 个文件）。要保留这些修改吗？', options: [{ id: 'keep', label: '确认保留' }, { id: 'revert', label: '回退这些修改' }] }];
  for (const [name, questions, kind, text] of [['ask card', QUESTIONS, 'ask', 'iOS'], ['direct-fix card', FIX, 'share', '保留，我晚点再看']]) {
    const build = reply => { const w = world(1), card = addCard(w, T0 + HOUR, { questions, kind }); w.items.push(user('m', T0 + 2 * HOUR, { text, ...reply })); return { ...w, card }; };
    const settle = w => scanFeedback(w.project, [{ id: 's', items: w.items }], { now: T0 + 2 * HOUR + MINUTE, judging: true }).settled.map(row => [row.id === w.card.id ? 'card' : 'share', row.feedback.outcome, row.feedback.replyVia]);
    // The judge placed it on the card (D0 of [card, share]): the card is replied, the share is not.
    const placed = build({}), asked = decisionsOf({ target: 0 });
    assert.deepEqual((await attributeReply(store(placed.items, placed.project), asked, { sessionId: 's', itemId: 'm', now: () => T0 + 2 * HOUR })).itemId, 'card1', name);
    assert.deepEqual(settle(placed), [['card', 'replied', 'reply.target']], name);
    // The judge saw the card and said the message is about none of them: not a reply to it (an unrelated message settles nothing).
    const away = build({}); await attributeReply(store(away.items, away.project), decisionsOf({ target: null }), { sessionId: 's', itemId: 'm', now: () => T0 + 2 * HOUR });
    assert.deepEqual(settle(away), [], `${name}: none`);
    // The judge could not tell; the capture (it reads assistant outputs, never a card) says it reacts to nothing earlier: the card is read by order, as before C3, and the share is not.
    const unsure = build({ capture: { correction: false, target: null, targetSource: 'jev' } }); await attributeReply(store(unsure.items, unsure.project), decisionsOf({}), { sessionId: 's', itemId: 'm', now: () => T0 + 2 * HOUR });
    assert.deepEqual(settle(unsure), [['card', 'replied', 'order']], `${name}: abstained, then the capture's null`);
    // No question asked at all (the judge off) and no capture: the order rule, which reads the card as the latest delivery.
    const off = build({}); assert.deepEqual(scanFeedback(off.project, [{ id: 's', items: off.items }], { now: T0 + 2 * HOUR + MINUTE }).settled.map(row => [row.id === off.card.id ? 'card' : 'share', row.feedback.replyVia]), [['card', 'order']]);
    // The capture names the share: the card is not what it is about.
    const share = build({ capture: { correction: false, target: { kind: 'output', itemId: 'a' }, targetSource: 'jev' } });
    assert.deepEqual(scanFeedback(share.project, [{ id: 's', items: share.items }], { now: T0 + 2 * HOUR + MINUTE }).settled.map(row => [row.id === share.card.id ? 'card' : 'share', row.feedback.replyVia]), [['share', 'capture']], `${name}: a share named by the capture`);
  }
});
