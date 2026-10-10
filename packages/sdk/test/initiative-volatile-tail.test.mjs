import test from 'node:test';
import assert from 'node:assert/strict';
import { InitiativeCoordinator, decideInitiative, receiptEligible, RECENT_RECEIPTS } from '../src/initiative.mjs';

// PDL-5 phase 1: contract fields that change from wake to wake ride at the request tail (hostConditions), so toggling
// them leaves the request identical up to and including its evidence events; validation still sees them in place.
const model = { protocol: 'openai', providerId: 'test', modelId: 'fixture', maxOutputTokens: 2048 };
const event = { id: 'e1', type: 'conversation_result', summary: 'The foreground finished chapter one.' };
const wait = { action: 'wait', reason: 'Nothing new', evidenceIds: [], content: '', nextReviewAfterMs: 60000 };
function capture(seen) { return async function* (options) { seen.push(options.messages[0].content[0].text); yield { type: 'text_delta', delta: JSON.stringify(wait) }; yield { type: 'usage', usage: { input: 10, output: 5, totalTokens: 15 } }; yield { type: 'done', stopReason: 'stop' }; }; }
const contracts = ({ pending = [], quietNow = false, notificationsMuted = false, effective = 'write' } = {}) => ({
  wait: { enabled: true, purpose: 'Wait.' },
  work: { enabled: true, authorization: 'Authorized.', scope: 'Bounded work.', effects: 'Writes allowed.', permissions: { projectId: 'p', settings: { workspace: 'write', background: 'inherit' }, effective: { foreground: 'write', background: effective }, revision: 1, description: 'Permissions.' }, backgroundLevel: effective, continuation: 'Continue.' },
  share: { enabled: true, authorization: 'Authorized.', scope: 'Share findings.', effects: 'One message.', messageContract: 1, reach: { enabled: true, tiers: ['inbox', 'inline'], notificationsMuted, quietNow } },
  ask: { enabled: true, scope: 'Ask.', effects: 'One card.', pending },
});
const prefix = text => text.slice(0, text.indexOf('"allowedEvidenceIds"'));

test('toggling a pending question, quiet time, muted notifications or the permission in force leaves the request bytes identical through its events', async () => {
  const variants = [{}, { pending: [{ id: 'q1', kind: 'question', questions: [{ id: 'a', question: 'Which chapter?' }], status: 'pending' }] }, { quietNow: true }, { notificationsMuted: true }, { effective: 'read' }];
  const seen = [];
  for (const [index, variant] of variants.entries()) await decideInitiative({ project: { id: 'p', actionContracts: contracts(variant) }, events: [event], availableActions: ['work', 'share', 'ask'], policy: { notificationMuted: index === 3 }, model, provider: capture(seen) });
  assert.equal(seen.length, variants.length);
  for (const text of seen.slice(1)) assert.equal(prefix(text), prefix(seen[0]), 'same bytes up to and including events');
  const parsed = seen.map(text => JSON.parse(text));
  assert.deepEqual(parsed[1].hostConditions.ask.pending.map(row => row.id), ['q1']);
  assert.equal(parsed[2].hostConditions.share.reach.quietNow, true); assert.equal(parsed[3].hostConditions.share.reach.notificationsMuted, true);
  assert.equal(parsed[3].communicationPolicy.notificationMuted, true); assert.equal(parsed[4].hostConditions.work.permissions.effective.background, 'read');
  assert.equal(parsed[0].hostActionContracts.work.permissions.effective, undefined, 'the head carries the saved permission, not the one in force');
  assert.equal(parsed[0].hostActionContracts.share.reach.tiers.length, 2, 'the rest of a nested contract stays in the head');
  const keys = Object.keys(parsed[0]);
  assert.ok(keys.indexOf('communicationPolicy') > keys.indexOf('events') && keys.indexOf('communicationPolicy') === keys.indexOf('presence') - 1, 'communicationPolicy rides just before presence');
});

test('validation sees the nested conditions put back where the model read them', async () => {
  const seen = [];
  // A share needs evidence; validation reads the reach tiers, which stay in the head while quietNow travels.
  const share = { action: 'share', title: 'Chapter one', reason: 'Finished', evidenceIds: ['e1'], content: 'Chapter one is done.', nextReviewAfterMs: 60000, urgency: 'inline' };
  const result = await decideInitiative({ project: { id: 'p', actionContracts: contracts({ quietNow: true, effective: 'read' }) }, events: [event], availableActions: ['work', 'share', 'ask'], model, provider: async function* (options) { seen.push(JSON.parse(options.messages[0].content[0].text)); yield { type: 'text_delta', delta: JSON.stringify(share) }; yield { type: 'usage', usage: { totalTokens: 1 } }; yield { type: 'done', stopReason: 'stop' }; } });
  assert.equal(result.status, 'decided'); assert.equal(result.decision.urgency, 'inline');
  assert.equal(seen[0].hostConditions.share.reach.quietNow, true);
});

test('recentActions use the exported receipt predicate and bound', async () => {
  assert.equal(RECENT_RECEIPTS, 20);
  assert.deepEqual(['queued', 'running', 'paused', 'completed', 'needs_review', 'failed', 'cancelled'].map(status => receiptEligible({ status })), [true, true, true, true, true, true, false]);
  assert.equal(receiptEligible({ status: 'failed', contextRevoked: true }), false);
  const actions = Array.from({ length: 26 }, (_, index) => ({ id: `a${index}`, action: 'work', status: index % 5 === 0 ? 'cancelled' : 'completed', content: `Work ${index}`, evidenceIds: [], intentKey: `k${index}`, revision: 1, resultSummary: `Result ${index}` }));
  const seen = [];
  const coordinator = new InitiativeCoordinator({ project: { id: 'p', actionContracts: contracts() }, model, provider: capture(seen), state: { schemaVersion: 1, revision: 2, decisionRevision: 1, nextReviewAt: 0, usedTokens: 0, reservedTokens: 0, events: [event], seenEventIds: ['e1'], actions }, handlers: { work: async () => ({ usage: { totalTokens: 0 } }), share: async () => ({ usage: { totalTokens: 0 } }) } });
  try {
    await coordinator.tick();
    const sent = JSON.parse(seen[0]).recentActions.map(row => row.actionId);
    assert.deepEqual(sent, actions.filter(receiptEligible).slice(-RECENT_RECEIPTS).map(row => row.id));
  } finally { await coordinator.close(); }
});

test('a citation of a message id the request showed only inside an evidence event, or in a host turn row, still counts as a message id', async () => {
  // TC-3: a finished turn is referenced by the event that holds its messages instead of repeating them in recentConversation.
  const turn = { id: 'turn:t1:completed@1', type: 'conversation_result', summary: JSON.stringify({ turnId: 't1', requests: [{ messageId: 'msg-in-event', text: 'Rewrite chapter one.' }], final: { messageId: 'reply-in-event', text: 'Done.' } }) };
  const project = { id: 'p', actionContracts: contracts(), recentConversation: [], continuity: { recentTurns: [{ turnId: 't0', requests: [{ messageId: 'msg-in-row', text: 'Earlier.' }] }] } };
  const cite = ids => async function* () { yield { type: 'text_delta', delta: JSON.stringify({ action: 'share', title: 'Chapter one', reason: 'Finished', evidenceIds: ids, content: 'Chapter one is done.', nextReviewAfterMs: 60000 }) }; yield { type: 'usage', usage: { totalTokens: 1 } }; yield { type: 'done', stopReason: 'stop' }; };
  let failure;
  await assert.rejects(decideInitiative({ project, events: [turn], availableActions: ['share'], model, provider: cite(['msg-in-event', 'reply-in-event', 'msg-in-row', 'never-shown']) }), error => { failure = error.initiativeFailure; return error.code === 'invalid_decision'; });
  assert.deepEqual(failure.evidenceValidation.categories, { actionReceiptId: 0, conversationMessageId: 3, unknown: 1 });
});
