import test from 'node:test';
import assert from 'node:assert/strict';
import { proactiveRowKind, conversationTimeline, unrepliedChain, pacingSignals, engagementOf, heldItems, heldAsks, heldAskDue, pursuedOverdue, declineOverdue, rearmWake, advanceWake, pacingDecision, WAKE_LADDER, PENDING_MAX_AGE_MS } from '../proactive-pacing.mjs';
import { settleFeedback, recordDelivery, recentDeliveries } from '../proactive-delivery.mjs';
import { applyNarration } from '../proactive-narrator.mjs';
import { proactiveMetrics } from '../proactive-metrics.mjs';

// B3: one delivery ledger (F7), the transitional reply rule (F3), held questions (F4), overdue requests and the floor's
// no-op re-arm (PDL-4). Pure helpers, synthetic data.
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const T0 = Date.parse('2026-10-05T02:00:00Z'), iso = ms => new Date(ms).toISOString();
const user = (id, at, text = 'ok') => ({ id, kind: 'user', text, createdAt: iso(at) });
const share = (id, at, extra = {}) => ({ id, kind: 'assistant', source: 'initiative', text: `finding ${id}`, createdAt: iso(at), initiativeActionId: `act-${id}`, initiative: { kind: 'insight', reach: 'inline' }, ...extra });
const workLine = (id, at) => ({ id, kind: 'assistant', source: 'initiative', text: `Background work: ${id}`, createdAt: iso(at), initiativeActionId: `${id}-changes`, initiative: { kind: 'insight', reach: 'inbox', backgroundWork: { actionId: id, status: 'done' } } });

test('F7: one classifier tells deliveries from status lines, from structure only', () => {
  const kinds = {
    share: share('s', T0), scheduled: { ...share('d', T0), initiative: { kind: 'scheduled', reach: 'inline' } }, welcome: { ...share('w', T0), initiative: { kind: 'welcome_back', reach: 'inline' } },
    digest: { ...share('g', T0), initiative: { kind: 'digest', reach: 'digest' } }, gene: { ...share('n', T0), initiativeActionId: undefined, initiative: { kind: 'insight', reach: 'inline', gene: 'gene-1' } },
    filed: { ...share('f', T0), initiative: { kind: 'insight', reach: 'inbox', filedAt: iso(T0) } },
    card: { id: 'q', kind: 'question', createdAt: iso(T0), interaction: { source: 'initiative', status: 'pending', questions: [{ question: 'Which one?' }] } },
    work: workLine('a1', T0), git: { ...share('c', T0), initiativeActionId: 'a2-changes', initiative: { kind: 'insight', reach: 'inbox', backgroundChange: 'change-1' } },
    revert: { ...share('r', T0), initiativeActionId: 'a2-changes-revert', initiative: { kind: 'insight', reach: 'inbox' } }, fixRevert: { ...share('x', T0), initiativeActionId: 'a3-direct-revert', initiative: { kind: 'insight', reach: 'inbox' } },
    close: { ...share('t', T0), initiativeActionId: undefined, initiative: { kind: 'thread_close', reach: 'inline', threadId: 't1' } },
    version: { ...share('v', T0), initiative: { kind: 'version_ready' } }, user: user('u', T0), foreground: { id: 'f1', kind: 'assistant', text: 'reply', createdAt: iso(T0), turnId: 't' },
    simulated: { ...share('m', T0), simulated: true }, deleted: { ...share('z', T0), sourceDeleted: true }, toolCard: { id: 'q2', kind: 'question', createdAt: iso(T0), interaction: { source: 'tool', status: 'pending' } },
  };
  assert.deepEqual(Object.fromEntries(Object.entries(kinds).map(([name, item]) => [name, proactiveRowKind(item)])), {
    share: 'delivery', scheduled: 'delivery', welcome: 'delivery', digest: 'delivery', gene: 'delivery', filed: 'delivery', card: 'delivery',
    work: 'status', git: 'status', revert: 'status', fixRevert: 'status', close: 'status',
    version: null, user: null, foreground: null, simulated: null, deleted: null, toolCard: null,
  });
});

test('F7: status lines and quiet-tier deliveries are not unanswered messages; votes on status lines are not engagement', () => {
  const items = [user('u1', T0 - 3 * HOUR), share('s1', T0 - 2 * HOUR), workLine('w1', T0 - 90 * MINUTE), workLine('w2', T0 - 20 * MINUTE),
    { ...share('f1', T0 - 10 * MINUTE), initiative: { kind: 'insight', reach: 'inbox', filedAt: iso(T0 - HOUR) } }, { ...workLine('w3', T0 - 5 * MINUTE), feedback: { vote: 'up' } }];
  const sessions = [{ id: 's', items }], timeline = conversationTimeline(sessions);
  assert.deepEqual(timeline.map(row => [row.kind, row.itemId ?? null, Boolean(row.quiet)]), [['user', null, false], ['proactive', 's1', false], ['proactive', 'f1', true]], 'status lines are not in the message timeline');
  assert.equal(unrepliedChain(timeline), 1, 'one unanswered message: the share (the filed one asks for no reply)');
  const signals = pacingSignals({ id: 'p', inbox: [], mind: {} }, sessions, { now: T0 });
  assert.equal(signals.unrepliedChain, 1);
  assert.equal(signals.sinceUnrepliedMs, 2 * HOUR, 'reading time runs from the share, not from a work line or a filed share');
  assert.equal(engagementOf({ inbox: [] }, sessions, { now: T0 }).up, 0, 'a vote on a work line is not engagement with a message');
  const metrics = proactiveMetrics({ id: 'p', inbox: [], mind: {} }, sessions, { now: T0 });
  assert.deepEqual([metrics.delivered, metrics.currentUnrepliedChain, metrics.longestUnrepliedChain], [2, 1, 1], 'metrics read the same ledger');
  // Before F7, every one of these lines counted: an unreplied chain of 5 and reading time from the last work line.
  assert.ok(recentDeliveries({ inbox: [] }, sessions, { now: T0, windowMs: DAY }).some(row => row.kind === 'status' && /w2/.test(row.text)), 'status lines are still what the user was told');
});

test('F3: one user message replies to at most the latest unanswered delivery of its conversation', () => {
  const project = { id: 'p', inbox: [] }, items = [];
  const add = (key, at) => { const item = share(key, at); items.push(item); return recordDelivery(project, { actionId: `act-${key}`, tier: 'inline', text: item.text, sessionId: 's', itemId: item.id, now: at }); };
  // Three overnight shares, then one unrelated morning message.
  const a = add('a', T0), b = add('b', T0 + HOUR), c = add('c', T0 + 2 * HOUR);
  items.push(user('morning', T0 + 7 * HOUR, 'Unrelated: start chapter four.'));
  const sessions = [{ id: 's', items }];
  assert.deepEqual(settleFeedback(project, sessions, { now: T0 + 7 * HOUR + MINUTE }).map(row => [row.id, row.feedback.outcome, row.feedback.replyItemId]), [[c.id, 'replied', 'morning']], 'only the latest is replied');
  // A second message replies to the next latest; the same message never settles two.
  assert.deepEqual(settleFeedback(project, sessions, { now: T0 + 7 * HOUR + 2 * MINUTE }), []);
  items.push(user('second', T0 + 8 * HOUR));
  assert.deepEqual(settleFeedback(project, sessions, { now: T0 + 8 * HOUR + MINUTE }).map(row => [row.id, row.feedback.outcome]), [[b.id, 'replied']]);
  // Once its window closes without a reply of its own, the first is ignored.
  assert.deepEqual(settleFeedback(project, sessions, { now: T0 + 13 * HOUR }).map(row => [row.id, row.feedback.outcome]), [[a.id, 'ignored']]);
  // Engagement reads it: one reply per message, not three.
  assert.deepEqual([engagementOf(project, sessions, { now: T0 + 13 * HOUR }).replied, engagementOf(project, sessions, { now: T0 + 13 * HOUR }).ignored], [2, 1]);
});

test('F3: entries one digest merged are answered together; a reply settled before replyItemId existed still answers nothing else', () => {
  const project = { id: 'p', inbox: [] }, items = [share('older', T0), { ...share('dg', T0 + 3 * HOUR), initiative: { kind: 'digest', reach: 'digest' } }];
  const older = recordDelivery(project, { actionId: 'a0', tier: 'inline', text: 'older', sessionId: 's', itemId: 'older', now: T0 });
  const merged = ['d1', 'd2'].map(id => Object.assign(recordDelivery(project, { actionId: id, tier: 'digest', text: id, sessionId: 's', now: T0 + HOUR }), { heldForDigest: false, digestedAt: iso(T0 + 3 * HOUR), digestItemId: 'dg', digestSessionId: 's' }));
  items.push(user('reply', T0 + 4 * HOUR));
  const settled = settleFeedback(project, [{ id: 's', items }], { now: T0 + 4 * HOUR + MINUTE });
  assert.deepEqual(settled.map(row => [row.id, row.feedback.outcome]), merged.map(row => [row.id, 'replied']), 'the digest is one message');
  assert.equal(older.feedback, null);
  // Legacy: a reply recorded by its time only (no replyItemId) is still used up.
  const legacy = { id: 'p2', inbox: [] }, first = recordDelivery(legacy, { actionId: 'l1', tier: 'inline', text: 'x', sessionId: 's', itemId: 'x1', now: T0 }), second = recordDelivery(legacy, { actionId: 'l2', tier: 'inline', text: 'y', sessionId: 's', itemId: 'y1', now: T0 + HOUR });
  second.feedback = { outcome: 'replied', at: iso(T0 + 2 * HOUR), windowMs: 12 * HOUR };
  assert.deepEqual(settleFeedback(legacy, [{ id: 's', items: [share('x1', T0), share('y1', T0 + HOUR), user('m', T0 + 2 * HOUR)] }], { now: T0 + 2 * HOUR + MINUTE }), []);
  assert.equal(first.feedback, null);
});

test('F4: held questions are kept apart from held messages (their own field), and go out on the welcome-back condition', () => {
  const mind = { threads: [{ id: 't1', status: 'open', title: 'Plan', held: [{ id: 'h1', kind: 'share', text: 'A finding', value: .5, createdAt: iso(T0) }], heldAsks: [{ id: 'h2', kind: 'ask', actionId: 'ask-1', text: 'Which ending?', value: .6, createdAt: iso(T0) }] }, { id: 't2', status: 'muted', title: 'Muted', heldAsks: [{ id: 'h3', kind: 'ask', createdAt: iso(T0) }] }] };
  assert.deepEqual(heldItems(mind).map(row => row.id), ['h1'], 'the welcome-back text never states a question');
  assert.deepEqual(heldAsks(mind).map(row => [row.id, row.threadId]), [['h2', 't1']]);
  // The narration record of a held question goes to `thread.heldAsks`, never `thread.held`: a host before F4 (a rollback
  // to 0.68.0) reads every `thread.held` row into its welcome-back text, and would state the question there as well.
  const project = { id: 'p', mind: { threads: [], findings: [], pacing: {} } }, thread = { id: 't9', title: 'Ending', kind: 'topic', status: 'open', held: [], messageItemIds: [] };
  const plan = (kind, ledgerId) => ({ version: 2, outcome: 'hold', reasons: ['away'], text: `${kind} text`, thread, threadCreated: true, via: 'new_topic', continuing: false, finding: { summary: 'x', textHash: kind, evidenceHash: null, evidenceIds: [] }, value: .6, threshold: .5, factors: [], probabilities: {}, valueSource: 'jev', ledgerId, signals: { now: T0, activeHours: [] }, kind, actionId: `act-${kind}` });
  applyNarration(project, plan('ask', 'mv-ask'), { now: T0 }); applyNarration(project, plan('share', 'mv-share'), { now: T0 });
  const [kept] = project.mind.threads;
  assert.deepEqual(kept.held.map(row => row.kind), ['share'], 'a held message stays where every host reads it');
  assert.deepEqual(kept.heldAsks.map(row => [row.kind, row.actionId, row.ledgerId]), [['ask', 'act-ask', 'mv-ask']], 'the question, with its message.value ledger row');
  const [held] = heldAsks(mind);
  assert.equal(heldAskDue(held, { present: false, lastUserAt: T0 - MINUTE }), false, 'still away');
  assert.equal(heldAskDue(held, { present: true }), true, 'the user is here');
  assert.equal(heldAskDue(held, { present: false, lastUserAt: T0 + MINUTE }), true, 'or wrote since');
  assert.equal(heldAskDue(held, { present: true, night: true }), false); assert.equal(heldAskDue(held, { present: true, typing: true }), false);
});

test('F4: a question in the below-threshold band goes out as a new-thread question does; only a share folds into its continuing thread', () => {
  // The band is not a blocker the user's return clears: a question held there would be released on presence alone,
  // past the threshold (B3 review). Held questions are absence holds only (system-review F4: the band outcome of an ask
  // does not depend on the thread).
  const signals = { night: false, away: false, present: true };
  const band = { value: .58, threshold: .69, signals };
  assert.deepEqual(pacingDecision({ ...band, kind: 'ask', probabilities: { needs_user_decision: 1 }, continuing: true }), { outcome: 'inbox', reasons: ['below_threshold_band'] }, 'a continuing-thread question in the band');
  assert.deepEqual(pacingDecision({ ...band, kind: 'ask', probabilities: { needs_user_decision: 1 }, continuing: false }), { outcome: 'inbox', reasons: ['below_threshold_band'] }, 'as a new-thread one');
  assert.deepEqual(pacingDecision({ ...band, kind: 'share', continuing: true }), { outcome: 'hold', reasons: ['below_threshold_band'] }, 'a share still folds into its thread');
  assert.deepEqual(pacingDecision({ ...band, kind: 'ask', probabilities: { needs_user_decision: 1 }, continuing: true, signals: { ...signals, present: false, away: true } }), { outcome: 'hold', reasons: ['away'] }, 'a question is held for the user\'s absence');
});

test('overdue requests: pursued for at most 14 days, and not at the revision a waiting decision declined them', () => {
  const now = T0, mind = { commitments: [
    { id: 'fresh', status: 'pending', request: 'a', createdAt: iso(now - DAY), overdueAt: iso(now - HOUR) },
    { id: 'aged', status: 'pending', request: 'b', createdAt: iso(now - PENDING_MAX_AGE_MS - HOUR), overdueAt: iso(now - PENDING_MAX_AGE_MS - HOUR / 2) },
    { id: 'later', status: 'pending', request: 'c', createdAt: iso(now), overdueAt: iso(now + HOUR) },
    { id: 'applying', status: 'pending', request: 'd', createdAt: iso(now - DAY), overdueAt: iso(now - HOUR), awaitingApply: true }] };
  assert.deepEqual(pursuedOverdue(mind, { now }).map(row => row.id), ['fresh']);
  // (D4: the 14 days run from the request's last sign of life, the due moment included: one made as long ago that fell due since is pursued from then.)
  assert.deepEqual(pursuedOverdue({ commitments: [{ ...mind.commitments[1], overdueAt: iso(now - HOUR) }] }, { now }).map(row => row.id), ['aged']);
  const declined = declineOverdue(mind, { now, revision: 'scope:4', reason: '  Waiting for the outline.  ' });
  assert.deepEqual(declined, { ids: ['fresh'], revision: 'scope:4', at: iso(now), reason: 'Waiting for the outline.' });
  mind.pacing = { overdueDeclined: declined };
  assert.deepEqual(pursuedOverdue(mind, { now, revision: 'scope:4' }), [], 'declined at this revision');
  assert.deepEqual(pursuedOverdue(mind, { now, revision: 'scope:5' }).map(row => row.id), ['fresh'], 'new evidence: owed again');
  mind.commitments[2].overdueAt = iso(now - MINUTE);
  assert.deepEqual(pursuedOverdue(mind, { now, revision: 'scope:4' }).map(row => row.id), ['later'], 'a request that fell due since was not declined');
  assert.equal(declineOverdue({ commitments: [] }, { now, revision: 'scope:4' }), null, 'nothing owed, nothing declined');
});

test('PDL-4: a floor wake that reached no decision only re-arms its timer', () => {
  const wake = advanceWake(advanceWake({}, 'thought', { now: T0 }), 'thought', { now: T0 });
  const rearmed = rearmWake(wake, { now: T0 + HOUR });
  assert.deepEqual({ ...rearmed, nextAt: undefined }, { ...wake, nextAt: undefined }, 'level, ticks, quiet count, last outcome and history stay');
  assert.equal(Date.parse(rearmed.nextAt), T0 + HOUR + WAKE_LADDER[wake.level]);
});
