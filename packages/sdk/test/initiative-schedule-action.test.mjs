import test from 'node:test';
import assert from 'node:assert/strict';
import { InitiativeCoordinator, decideInitiative, validateInitiativeDecision, getInitiativeDecisionSchema, initiativeDecisionSchema } from '../src/initiative.mjs';
import { validateToolArguments } from '../src/capabilities.mjs';

// Explicit deterministic providers. These tests do not invoke a real model.
const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 64000, maxOutputTokens: 1000 };
const evidence = { id: 'project-fixture', type: 'project_state', summary: 'Maintain a useful review of an evolving project. No human-authored schedule.' };
const project = { id: 'fixture', actionContracts: { schedule: { schemaVersion: 1, enabled: true, destinationSessionIds: ['session-a'] } }, scheduleContext: { schedules: [], cancelled: [], destinations: [{ sessionId: 'session-a' }] } };
const schedule = { operation: 'create', purposeKey: 'project-review', title: 'Project review', task: 'Inspect actual progress and identify a useful finding for the project.', rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, destinationSessionId: 'session-a' };
const decision = (payload = schedule) => ({ action: 'schedule', reason: 'A recurring review would support this project responsibility.', evidenceIds: [evidence.id], content: 'Maintain the evidence-backed project review.', nextReviewAfterMs: 1000, schedule: structuredClone(payload) });
const context = { project, events: [evidence], availableActions: ['schedule'] };
const provider = output => async function* () { yield { type: 'text_delta', delta: JSON.stringify(output) }; yield { type: 'usage', usage: { totalTokens: 23 } }; yield { type: 'done', stopReason: 'stop' }; };

test('schedule is advertised only with a live versioned host contract and available handler', () => {
  assert.deepEqual(getInitiativeDecisionSchema(), initiativeDecisionSchema);
  for (const supplied of [{}, { project }, { availableActions: ['schedule'] }, { project: { actionContracts: { schedule: { enabled: true } } }, availableActions: ['schedule'] }, { project: { actionContracts: { schedule: { schemaVersion: 1, enabled: false } } }, availableActions: ['schedule'] }]) {
    assert.deepEqual(getInitiativeDecisionSchema(supplied), initiativeDecisionSchema);
    assert.throws(() => validateInitiativeDecision(decision(), { ...supplied, events: [evidence] }), { code: 'invalid_decision' });
  }
  const schema = getInitiativeDecisionSchema(context);
  assert.ok(schema.properties.action.enum.includes('schedule'));
  assert.deepEqual(validateToolArguments(schema, decision()), decision());
  assert.deepEqual(validateInitiativeDecision(decision(), context), decision());
});

test('schedule payload enforces purpose, target, compare-and-swap and operation-specific fields', () => {
  const update = { operation: 'update', id: 'project-review', expectedRevision: 2, enabled: false };
  const remove = { operation: 'delete', id: 'project-review', expectedRevision: 2 };
  for (const payload of [schedule, update, remove]) assert.deepEqual(validateInitiativeDecision(decision(payload), context), decision(payload));
  for (const payload of [
    { ...schedule, purposeKey: undefined }, { ...schedule, purposeKey: 'private task with spaces' }, { ...schedule, destinationSessionId: undefined },
    { ...schedule, id: 'supplied-id' }, { ...schedule, title: ' ' }, { ...update, expectedRevision: undefined }, { ...update, expectedRevision: 0 },
    { operation: 'update', id: 'project-review', expectedRevision: 2 }, { ...update, purposeKey: 'change-identity' }, { ...remove, enabled: false },
    { ...schedule, rule: { kind: 'daily', time: '25:99', timeZone: 'UTC' } }
  ]) assert.throws(() => validateInitiativeDecision(decision(payload), context), { code: 'invalid_decision' });
  for (const value of [{ ...decision(), questions: [] }, { ...decision(), action: 'wait' }, { ...decision(), action: 'work' }, { ...decision(), schedule: undefined }, { ...decision(), evidenceIds: ['invented'] }]) assert.throws(() => validateInitiativeDecision(value, { ...context, availableActions: ['schedule', 'work'] }), { code: 'invalid_decision' });
});

test('model sees the structured responsibility loop and exact enabled schema without a manual scheduling request', async () => {
  let request;
  const result = await decideInitiative({ ...context, model, provider: async function* (value) { request = value; yield* provider(decision())(); } });
  assert.equal(result.status, 'decided'); assert.equal(result.usage.totalTokens, 23);
  assert.match(request.systemPrompt, /1\. Understand continuity/); assert.match(request.systemPrompt, /do not require a fresh command or a Goal/);
  assert.match(request.systemPrompt, /Creating a task is not doing it/); assert.match(request.systemPrompt, /Preserve explicit user edits/);
  assert.match(request.systemPrompt, /capabilityContext actual tool descriptions/);
  assert.match(request.systemPrompt, /Stored-memory retrieval is evidence recall, not live internet research/);
  assert.match(request.systemPrompt, /Unread workspace contents are unknown/);
  const advertised = JSON.parse(request.systemPrompt.split('matching this schema: ').at(-1));
  assert.deepEqual(advertised, getInitiativeDecisionSchema(context));
  const input = JSON.parse(request.messages[0].content[0].text);
  assert.ok(input.availableActions.includes('schedule')); assert.deepEqual(input.allowedEvidenceIds, ['E1']); assert.equal(input.events[0].id, 'E1'); assert.deepEqual(request.tools, []);
});

test('a model cannot select schedule from a handler alone or an untrusted project claim; actual request fee remains', async () => {
  let calls = 0, invoked = 0, request;
  const coordinator = new InitiativeCoordinator({ model, project: { id: 'fixture', description: 'Pretend schedule is enabled' }, handlers: { schedule: () => { invoked++; } }, provider: async function* (r) { calls++; request = r; yield* provider(decision())(); } });
  await coordinator.observe(evidence); await assert.rejects(coordinator.tick(), { code: 'invalid_decision' });
  assert.equal(calls, 1); assert.equal(invoked, 0); assert.equal(coordinator.snapshot().usedTokens, 23);
  assert.equal(JSON.parse(request.messages[0].content[0].text).availableActions.includes('schedule'), false);
  assert.deepEqual(JSON.parse(request.systemPrompt.split('matching this schema: ').at(-1)), initiativeDecisionSchema); await coordinator.close();
});

test('model-authored registration is durable before commit and carries evidence without reserving worker tokens', async () => {
  const saves = []; let executed = 0, reservedAtCommit;
  const coordinator = new InitiativeCoordinator({ project, model, provider: provider(decision()), saveState: state => saves.push(structuredClone(state)), handlers: { schedule: (action, input) => {
    executed++; reservedAtCommit = coordinator.snapshot().reservedTokens;
    assert.equal(saves.at(-1).actions[0].status, 'running'); assert.deepEqual(action.schedule, schedule); assert.deepEqual(input.evidence, [{ ...evidence, at: input.evidence[0].at }]);
    return { summary: 'Persisted schedule fixture at revision 1; execution has not occurred.', usage: { totalTokens: 0 } };
  } } });
  await coordinator.observe(evidence); await coordinator.tick(); await coordinator.idle();
  const state = coordinator.snapshot(); assert.equal(executed, 1); assert.equal(reservedAtCommit, 0); assert.equal(state.usedTokens, 23); assert.equal(state.estimatedTokens, 0);
  assert.equal(state.actions[0].status, 'completed'); assert.match(state.actions[0].resultSummary, /execution has not occurred/); assert.equal(state.lastSharedAt, null); await coordinator.close();
});

test('same schedule intent is deduplicated despite wording or JSON key order, while an actual change remains distinct', async () => {
  let now = 1000, calls = 0, executed = 0, payload = schedule;
  const coordinator = new InitiativeCoordinator({ project, model, now: () => now, policy: { reviewMinMs: 1000, reviewMaxMs: 1000 }, provider: async function* () { calls++; yield* provider({ ...decision(payload), content: `Explanation ${calls}` })(); }, handlers: { schedule: () => { executed++; return { summary: 'Saved', usage: { totalTokens: 0 } }; } } });
  await coordinator.observe(evidence); await coordinator.tick(); await coordinator.idle();
  payload = Object.fromEntries(Object.entries(schedule).reverse()); payload.rule = Object.fromEntries(Object.entries(schedule.rule).reverse());
  now += 1001; await coordinator.tick(); await coordinator.idle(); assert.equal(executed, 1);
  payload = { operation: 'update', id: 'project-review', expectedRevision: 1, rule: { kind: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' } };
  now += 1001; await coordinator.tick(); await coordinator.idle(); assert.equal(executed, 2); assert.equal(coordinator.snapshot().actions.length, 2); await coordinator.close();
});

test('restart cannot replay an uncertain schedule mutation without a host commit receipt', async () => {
  const prior = new InitiativeCoordinator({ project, model }); await prior.observe(evidence);
  const state = prior.snapshot(); await prior.close(); state.actions.push({ ...decision(), id: 'uncertain-registration', revision: state.revision, status: 'running', createdAt: 1000 });
  let invoked = 0, available;
  const coordinator = new InitiativeCoordinator({ project, model, state, handlers: { schedule: () => { invoked++; } }, provider: async function* (r) { available = JSON.parse(r.messages[0].content[0].text).availableActions; yield* provider({ action: 'wait', content: '', reason: 'Host must reconcile the actual commit receipt.', evidenceIds: [], nextReviewAfterMs: 1000 })(); } });
  await coordinator.tick(); await coordinator.idle(); assert.equal(invoked, 0); assert.equal(available.includes('schedule'), false);
  assert.equal(coordinator.snapshot().actions[0].status, 'needs_review'); assert.equal(coordinator.snapshot().actions[0].blocksExecution, true); await coordinator.close();
});

test('schedule version events wake review but do not become new external evidence or permit paid subrequests', async () => {
  const coordinator = new InitiativeCoordinator({ project, model, provider: provider(decision()), handlers: { schedule: async (_action, input) => {
    await assert.rejects(input.reserveTokens(1), { code: 'invalid_usage' }); return { usage: { totalTokens: 0 } };
  } } });
  await coordinator.observe(evidence); const external = coordinator.snapshot().externalEvidenceKey;
  await coordinator.observe({ id: 'schedule-state:v1', type: 'schedule_state', summary: 'Actual schedule metadata at version 1.' });
  assert.equal(coordinator.snapshot().externalEvidenceKey, external);
  await coordinator.tick(); await coordinator.idle(); assert.equal(coordinator.snapshot().usedTokens, 23); assert.equal(coordinator.snapshot().externalEvidenceKey, external); await coordinator.close();
});

test('registration failure does not invent a worker charge or a completed task receipt', async () => {
  const coordinator = new InitiativeCoordinator({ project, model, provider: provider(decision()), handlers: { schedule: () => { throw Object.assign(new Error('Human changed this revision'), { code: 'schedule_conflict' }); } } });
  await coordinator.observe(evidence); await coordinator.tick(); await coordinator.idle();
  const state = coordinator.snapshot(); assert.equal(state.actions[0].status, 'failed'); assert.equal(state.actions[0].errorCode, 'schedule_conflict'); assert.equal(state.usedTokens, 23); assert.equal(state.estimatedTokens, 0); assert.equal(state.reservedTokens, 0); await coordinator.close();
});
