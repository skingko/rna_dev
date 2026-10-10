import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decideInitiative, initiativeFailure, InitiativeCoordinator, validateInitiativeDecision } from '../src/initiative.mjs';

const model = { protocol: 'openai', providerId: 'local-fixture', modelId: 'fixture', maxOutputTokens: 2048 };
const event = { id: 'message:source-message', type: 'user_message', summary: 'A checked project fact.' };
const decision = evidenceIds => ({ action: 'wait', reason: 'A concrete prerequisite is still missing.', evidenceIds, content: '', nextReviewAfterMs: 60000 });
const sha = value => createHash('sha256').update(value).digest('hex');
const provider = (output, inspect = () => {}) => async function* (request) { inspect(request); yield { type: 'text_delta', delta: JSON.stringify(output) }; yield { type: 'usage', usage: { totalTokens: 29 } }; yield { type: 'done', stopReason: 'stop' }; };

test('model projection distinguishes receipt/message IDs from the exact allowed event IDs without mutating public identities', async () => {
  const project = { id: 'project', recentConversation: [{ id: 'source-message', role: 'user', text: 'A checked project fact.' }] };
  const recentActions = [{ id: 'receipt', action: 'work', evidenceIds: [event.id], content: 'Check the fact', status: 'completed' }];
  const before = structuredClone({ project, recentActions, event }), emitted = [];
  const result = await decideInitiative({ project, recentActions, events: [event], model, onEvent: event => emitted.push(event), provider: provider(decision([event.id]), request => {
    const input = JSON.parse(request.messages[0].content[0].text);
    assert.deepEqual(input.allowedEvidenceIds, input.events.map(event => event.id));
    assert.equal(input.project.recentConversation[0].messageId, 'source-message'); assert.equal(input.project.recentConversation[0].id, undefined);
    assert.equal(input.recentActions[0].actionId, 'receipt'); assert.equal(input.recentActions[0].id, undefined);
    assert.match(input.evidenceReferencePolicy, /not evidence/); assert.match(input.evidenceReferencePolicy, /Do not add prefixes, guess IDs/);
  }) });
  assert.deepEqual({ project, recentActions, event }, before); assert.deepEqual(result.decision.evidenceIds, [event.id]); assert.deepEqual(emitted[0].decision, result.decision);
});

test('invalid citation diagnostics classify context-ID confusion but persist only counts and hashes', async () => {
  const secret = 'model-secret-not-to-persist', invented = 'private-response-id', messageId = 'source-message', actionId = 'receipt';
  const project = { recentConversation: [{ id: messageId, text: 'PRIVATE_CONVERSATION_BODY' }] }, recentActions = [{ id: actionId, action: 'work', evidenceIds: [event.id], content: 'PRIVATE_ACTION_BODY', status: 'completed' }];
  let failure;
  await assert.rejects(decideInitiative({ project, recentActions, events: [event], model, apiKey: secret, provider: provider({ ...decision([actionId, messageId, invented, secret]), reason: 'PRIVATE_RESPONSE_BODY' }) }), error => { failure = error.initiativeFailure; return error.code === 'invalid_decision'; });
  assert.deepEqual(failure.evidenceValidation, { allowedCount: 1, citedCount: 4, invalidCount: 4, categories: { actionReceiptId: 1, conversationMessageId: 1, unknown: 2 }, invalidIdSha256: [actionId, messageId, invented, secret].map(sha) });
  assert.equal(failure.request.stopReason, 'stop');
  for (const value of [secret, invented, messageId, actionId, 'PRIVATE_CONVERSATION_BODY', 'PRIVATE_ACTION_BODY', 'PRIVATE_RESPONSE_BODY']) assert.ok(!JSON.stringify(failure).includes(value));
});

test('request validation uses the immutable sent event snapshot and does not accept IDs introduced after dispatch', async () => {
  for (const [returnedId, accepted] of [[event.id, true], ['later-event', false]]) {
    const events = [structuredClone(event)];
    const request = decideInitiative({ events, model, provider: provider(decision([returnedId]), options => {
      assert.deepEqual(JSON.parse(options.messages[0].content[0].text).allowedEvidenceIds, ['E1']);
      events[0].id = 'later-event';
    }) });
    if (accepted) assert.equal((await request).status, 'decided');
    else await assert.rejects(request, error => error.code === 'invalid_decision' && error.initiativeFailure.evidenceValidation.invalidIdSha256[0] === sha('later-event'));
  }
});

test('strict evidence validation still rejects receipt aliases and evicted references without automatic repair or extra requests', async () => {
  let requests = 0, executions = 0;
  const old = 'message:old', coordinator = new InitiativeCoordinator({ model, policy: { maxEvents: 1 }, handlers: { work: () => { executions++; } }, provider: provider({ ...decision([old]), action: 'work', content: 'Must not execute a guess.' }, () => { requests++; }) });
  await coordinator.observe({ ...event, id: old }); await coordinator.observe(event);
  await assert.rejects(coordinator.tick(), { code: 'invalid_decision' });
  assert.equal(requests, 1); assert.equal(executions, 0); assert.equal(coordinator.snapshot().actions.length, 0); assert.equal(coordinator.snapshot().usedTokens, 29);
  assert.equal(coordinator.snapshot().lastFailure.evidenceValidation.categories.unknown, 1);
  await coordinator.close();
  assert.throws(() => validateInitiativeDecision(decision(['source-message']), { events: [event] }), error => error.code === 'invalid_decision' && error.evidenceValidation.invalidIdSha256[0] === sha('source-message'));
});

test('diagnostics are bounded by validated citation shape and whitelist fields instead of copying error payloads', async () => {
  const ids = Array.from({ length: 50 }, (_, index) => `private-${index}`); let failure;
  await assert.rejects(decideInitiative({ events: [event], model, provider: provider(decision(ids)) }), error => { failure = error.initiativeFailure; return error.code === 'invalid_decision'; });
  assert.equal(failure.evidenceValidation.invalidIdSha256.length, 50); assert.equal(failure.evidenceValidation.categories.unknown, 50);
  const projected = initiativeFailure({ message: 'Fixed error', evidenceValidation: { ...failure.evidenceValidation, rawIds: ids, body: 'PRIVATE_BODY', categories: { ...failure.evidenceValidation.categories, body: 'PRIVATE_BODY' } } });
  assert.deepEqual(projected.evidenceValidation, failure.evidenceValidation); assert.ok(!JSON.stringify(projected).includes('private-')); assert.ok(!JSON.stringify(projected).includes('PRIVATE_BODY'));
  assert.equal(initiativeFailure({ evidenceValidation: { ...failure.evidenceValidation, invalidIdSha256: ['raw-private-id'] } }).evidenceValidation, undefined);
  await assert.rejects(decideInitiative({ events: [event], model, provider: provider(decision([...ids, 'one-too-many'])) }), error => error.code === 'invalid_decision' && error.initiativeFailure.evidenceValidation === undefined);
});

test('the model cites short handles for long event ids; they are mapped back before the same strict validation', async () => {
  const long = { id: 'turn:0979b846-de67-4af4-bf2a-42f7de90f00a:completed@a6d8d93fad439c8f918b', type: 'turn_completed', summary: 'A finished turn.' };
  const recentActions = [{ id: 'receipt', action: 'work', evidenceIds: [long.id, 'turn:evicted'], content: 'Checked it', status: 'completed' }];
  let seen;
  const result = await decideInitiative({ recentActions, events: [event, long], model, provider: provider({ ...decision(['E2']), action: 'share', content: 'The turn finished; here is what changed.' }, request => { seen = JSON.parse(request.messages[0].content[0].text); }) , availableActions: ['share'] });
  assert.deepEqual(seen.allowedEvidenceIds, ['E1', 'E2']); assert.deepEqual(seen.events.map(row => row.id), ['E1', 'E2']);
  // A receipt that cites a current event shows the same handle; a no-longer-current id stays as it was (not citable).
  assert.deepEqual(seen.recentActions[0].evidenceIds, ['E2', 'turn:evicted']);
  assert.equal(JSON.stringify(seen).includes(long.id), false, 'the long id is never shown to the model');
  assert.deepEqual(result.decision.evidenceIds, [long.id], 'the decision carries the real id');
  // An unknown handle or a mangled long id is still an unknown citation, rejected without a repair round.
  for (const cited of ['E3', 'turn:0979b846-de67-4af4-bf2a-42f7de90f00a:completed']) {
    let requests = 0;
    await assert.rejects(decideInitiative({ events: [event, long], model, provider: provider({ ...decision([cited]), action: 'share', content: 'x' }, () => { requests++; }), availableActions: ['share'] }), error => error.code === 'invalid_decision' && error.initiativeFailure.evidenceValidation.invalidIdSha256[0] === sha(cited));
    assert.equal(requests, 1);
  }
});
