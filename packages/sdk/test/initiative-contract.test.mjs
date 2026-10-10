import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { decideInitiative, initiativeDecisionSchema, initiativeFailure, validateInitiativeDecision, InitiativeCoordinator } from '../src/initiative.mjs';
import { validateToolArguments } from '../src/capabilities.mjs';

const event = { id: 'qa-evidence', type: 'test_failure', summary: 'Artificial fixture evidence, not user data.' };
const base = { action: 'work', reason: 'An observed fixture failure needs investigation.', evidenceIds: [event.id], content: 'Inspect the failing fixture and report evidence.', nextReviewAfterMs: 60000 };
const model = { providerId: 'http-fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 32000, maxOutputTokens: 2048, reasoning: 'off' };
const provider = output => async function* () { yield { type: 'text_delta', delta: JSON.stringify(output) }; yield { type: 'usage', usage: { totalTokens: 23 } }; yield { type: 'done', stopReason: 'stop' }; };
const validate = decision => validateInitiativeDecision(decision, { events: [event], availableActions: ['work', 'ask'] });

test('advertised schema rejects empty non-wait payloads and missing review interval exactly as the runtime does', () => {
  for (const decision of [{ ...base, content: '' }, { ...base, content: ' \n ' }, { ...base, evidenceIds: [] }, Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'nextReviewAfterMs'))]) {
    assert.throws(() => validateToolArguments(initiativeDecisionSchema, decision));
    assert.throws(() => validate(decision), { code: 'invalid_decision' });
  }
  const wait = { ...base, action: 'wait', evidenceIds: [], content: '' };
  assert.deepEqual(validateToolArguments(initiativeDecisionSchema, wait), wait); assert.deepEqual(validate(wait), wait);
});

test('ask contract requires introduction, evidence and exactly one question shape without fabricating fields', () => {
  const ask = { ...base, action: 'ask', content: 'Choose the supported target before implementation.', questions: [{ id: 'target', question: 'Which target?', options: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }] };
  assert.deepEqual(validateToolArguments(initiativeDecisionSchema, ask), ask); assert.deepEqual(validate(ask), ask);
  const grant = { ...base, action: 'ask', permissionRequest: { workspace: 'write', background: 'read', reason: 'Save the specified result.' } };
  assert.deepEqual(validate(grant), grant);
  for (const decision of [{ ...ask, content: '' }, { ...ask, evidenceIds: [] }, { ...ask, action: 'work' }, { ...ask, permissionRequest: grant.permissionRequest }, { ...base, action: 'ask' }, { ...grant, permissionRequest: { ...grant.permissionRequest, reason: '  ' } }]) {
    assert.throws(() => validateToolArguments(initiativeDecisionSchema, decision)); assert.throws(() => validate(decision), { code: 'invalid_decision' });
  }
});

test('failure diagnostics identify absent/blank fields without recording response text or arbitrary property names', async () => {
  const output = { ...base, content: 'PRIVATE_CONTENT', reason: 'PRIVATE_REASON' }; delete output.nextReviewAfterMs;
  let failure;
  await assert.rejects(decideInitiative({ model, events: [event], availableActions: ['work'], provider: provider(output) }), error => { failure = error.initiativeFailure; return error.code === 'invalid_decision'; });
  assert.deepEqual(failure.decisionValidation, { action: 'work', missingFields: ['nextReviewAfterMs'], contentState: 'present', evidenceState: 'present', evidenceCount: 1, questionsPresent: false, permissionRequestPresent: false, nextReviewState: 'missing' });
  assert.ok(!JSON.stringify(failure).includes('PRIVATE_')); assert.equal(failure.request.stopReason, 'stop');
  const corrupted = { ...failure.decisionValidation, privateResponse: 'PRIVATE_BODY' };
  assert.deepEqual(initiativeFailure({ decisionValidation: corrupted }).decisionValidation, failure.decisionValidation);
  assert.equal(initiativeFailure({ decisionValidation: { ...corrupted, missingFields: ['PRIVATE_FIELD'] } }).decisionValidation, undefined);
  assert.equal(initiativeFailure({ decisionValidation: { ...corrupted, action: 'PRIVATE_ACTION' } }).decisionValidation, undefined);
  assert.equal(initiativeFailure({ decisionValidation: { ...corrupted, evidenceCount: 1000000 } }).decisionValidation, undefined);
  await assert.rejects(decideInitiative({ model, events: [event], availableActions: ['work'], provider: provider({ ...base, content: '  ', evidenceIds: [] }) }), error => error.initiativeFailure.decisionValidation.contentState === 'empty' && error.initiativeFailure.decisionValidation.evidenceState === 'empty');
});

test('invalid decision is still a single metered failed request and invokes no action handler', async () => {
  let calls = 0, executed = 0;
  const coordinator = new InitiativeCoordinator({ model, handlers: { work: () => { executed++; } }, provider: async function* (request) { calls++; yield* provider({ ...base, content: '' })(request); } });
  await coordinator.observe(event); await assert.rejects(coordinator.tick(), { code: 'invalid_decision' });
  assert.equal(calls, 1); assert.equal(executed, 0); assert.equal(coordinator.snapshot().usedTokens, 23); assert.equal(coordinator.snapshot().reservedTokens, 0); assert.equal(coordinator.snapshot().actions.length, 0);
  assert.equal(coordinator.snapshot().lastFailure.decisionValidation.contentState, 'empty'); assert.ok(coordinator.snapshot().failureRetryAt > 0); await coordinator.close();
});

test('real HTTP provider receives the matching schema and mandatory-field guidance; strict parsing accepts its complete fixture response', async t => {
  let input;
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk; input = JSON.parse(raw);
    const prompt = input.messages.find(message => message.role === 'system').content;
    assert.match(prompt, /For every non-wait action/); assert.match(prompt, /nextReviewAfterMs is always required/);
    const advertised = JSON.parse(prompt.slice(prompt.lastIndexOf('matching this schema: ') + 'matching this schema: '.length));
    assert.deepEqual(advertised, initiativeDecisionSchema); assert.throws(() => validateToolArguments(advertised, { ...base, content: '' }));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify(base) }, finish_reason: 'stop' }], usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const result = await decideInitiative({ model: { ...model, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, events: [event], availableActions: ['work'] });
  assert.equal(result.status, 'decided'); assert.deepEqual(result.decision, base); assert.equal(result.usage.totalTokens, 23); assert.equal(input.tools, undefined);
});
