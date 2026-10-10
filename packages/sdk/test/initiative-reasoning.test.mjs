import test from 'node:test';
import assert from 'node:assert/strict';
import { InitiativeCoordinator, decideInitiative } from '../src/initiative.mjs';

// Internal reasoning for proactive decisions (spec p1 effort §3.4) and the aborted-decision accounting (PDL-3/TC-6).
const capability = { control: 'effort', efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }], providerDefault: null, canDisable: false };
const model = { protocol: 'openai', providerId: 'glm', modelId: 'glm-fixture', maxOutputTokens: 2048, reasoning: 'max', reasoningCapability: capability };
const event = { id: 'e1', type: 'project_opened', summary: 'A finished background check reported nothing new.' };
const decision = (action = 'wait', content = '', evidenceIds = action === 'wait' ? [] : ['e1']) => ({ action, reason: 'Nothing new to act on', evidenceIds, content, nextReviewAfterMs: 60000 });
/** A provider answering each request from `script` (a function of the request), recording the requests it saw. */
function scripted(script) {
  const seen = [];
  const provider = async function* (request) {
    seen.push({ reasoning: request.model.reasoning, messages: structuredClone(request.messages), estimatedInputTokens: request.estimatedInputTokens, purposeDetail: request.purposeDetail, prefixHash: request.cache?.prefixHash });
    yield* script(request, seen.length);
  };
  return { provider, seen };
}
const answer = (value, { usage = { input: 10, output: 30, totalTokens: 40 }, stopReason = 'stop' } = {}) => async function* () {
  yield { type: 'text_delta', delta: JSON.stringify(value) };
  if (usage) yield { type: 'usage', usage };
  yield { type: 'done', stopReason };
};

test('the routed effort goes on the first request only; the coordinator model is never changed', async () => {
  const { provider, seen } = scripted(answer(decision()));
  const calls = [], events = [];
  const coordinator = new InitiativeCoordinator({ model, provider, onEvent: row => events.push(row), decisionReasoning: async input => { calls.push(input); return { reasoning: 'low', record: { source: 'jev', depth: 'light', ledgerId: 'l1' } }; } });
  try {
    await coordinator.observe(event);
    const result = await coordinator.tick();
    assert.equal(result.status, 'decided');
    assert.equal(calls.length, 1, 'one call per decision');
    assert.deepEqual(calls[0].events.map(row => row.id), ['e1'], 'the hook sees the events that are sent');
    assert.ok(calls[0].project && calls[0].policy && calls[0].presence && calls[0].signal instanceof AbortSignal);
    assert.equal(calls[0].failureReview, false); assert.equal(calls[0].lastDecision, null);
    assert.equal(seen[0].reasoning, 'low');
    assert.equal(coordinator.model.reasoning, 'max', 'the coordinator model keeps the configured effort');
    assert.equal(seen[0].purposeDetail, 'decision'); assert.ok(seen[0].estimatedInputTokens > 0);
    assert.match(seen[0].prefixHash, /^rna-initiative-v1:[a-f0-9]{12}$/, 'the own-prefix ledger key follows the system prompt');
    assert.deepEqual(result.reasoning, { effective: 'low', routed: 'low', configured: 'max', source: 'jev', depth: 'light', ledgerId: 'l1' });
    assert.deepEqual(coordinator.snapshot().lastDecision.reasoning, result.reasoning);
    assert.deepEqual(events.find(row => row.type === 'initiative_decision').reasoning, result.reasoning);
    assert.deepEqual(result.usage, { totalTokens: 40, estimatedTokens: 0 });
    assert.equal(result.attempts, 1);
  } finally { await coordinator.close(); }
});

test('a hook that throws or returns an invalid value keeps the configured effort', async () => {
  for (const hook of [async () => { throw new Error('judge down'); }, async () => ({ reasoning: 'turbo' }), async () => undefined, async () => 'low']) {
    const { provider, seen } = scripted(answer(decision()));
    const coordinator = new InitiativeCoordinator({ model, provider, decisionReasoning: hook });
    try { await coordinator.observe(event); const result = await coordinator.tick(); assert.equal(result.status, 'decided'); assert.equal(seen[0].reasoning, 'max'); assert.equal(result.reasoning.routed, null); }
    finally { await coordinator.close(); }
  }
});

test('repairs (invalid decision, message contract) run at the configured effort', async () => {
  const invalid = scripted((_request, n) => answer(n === 1 ? { action: 'wait' } : decision())());
  const repaired = await decideInitiative({ model, events: [event], maxAttempts: 2, reasoning: 'low', provider: invalid.provider });
  assert.deepEqual(invalid.seen.map(row => row.reasoning), ['low', 'max']);
  assert.deepEqual(invalid.seen.map(row => row.purposeDetail), ['decision', 'decision-repair']);
  assert.equal(repaired.reasoning.effective, 'max'); assert.equal(repaired.attempts, 2);
  const share = scripted(answer(decision('share', 'The compatibility check found two broken examples.')));
  let checks = 0;
  const contract = await decideInitiative({ model, events: [event], availableActions: ['share'], reasoning: 'low', provider: share.provider, messageCheck: async () => (checks++ ? [] : [{ code: 'status_ping' }]) });
  assert.deepEqual(share.seen.map(row => row.reasoning), ['low', 'max']);
  assert.equal(contract.messageRepairs, 1);
});

test('a truncated answer at a lighter routed effort is asked again at the configured effort, without the cut answer', async () => {
  const run = scripted((_request, n) => (n === 1 ? answer({ action: 'wa' }, { stopReason: 'length' }) : answer(decision()))());
  const result = await decideInitiative({ model, events: [event], maxAttempts: 2, reasoning: 'low', provider: run.provider });
  assert.deepEqual(run.seen.map(row => row.reasoning), ['low', 'max']);
  assert.equal(run.seen[1].messages.length, run.seen[0].messages.length, 'the truncated answer is not replayed');
  assert.equal(result.reasoning.escalated, true); assert.equal(result.reasoning.effective, 'max');
  // At the configured effort a truncation stays an invalid decision.
  const same = scripted(answer({ action: 'wa' }, { stopReason: 'length' }));
  await assert.rejects(decideInitiative({ model, events: [event], maxAttempts: 1, provider: same.provider }), error => error.code === 'invalid_decision' && error.initiativeFailure.request.reasoning === 'max' && error.initiativeFailure.request.stopReason === 'length');
});

test('an aborted decision is charged its estimated input plus what streamed, not the admission reserve', async () => {
  const thinking = 'x'.repeat(3000);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let reserved = 0, coordinator;
  const provider = async function* (request) {
    reserved = coordinator.snapshot().reservedTokens;
    yield { type: 'thinking_delta', delta: thinking };
    await new Promise((resolve, reject) => { request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }); release(); });
  };
  coordinator = new InitiativeCoordinator({ model, provider });
  try {
    await coordinator.observe(event);
    const tick = coordinator.tick();
    await gate;
    coordinator.invalidateDecision('user_message');
    const result = await tick;
    assert.equal(result.status, 'stale');
    const state = coordinator.snapshot();
    assert.ok(result.usage.totalTokens > 0);
    assert.equal(state.usedTokens, result.usage.totalTokens); assert.equal(state.estimatedTokens, result.usage.estimatedTokens); assert.equal(state.reservedTokens, 0);
    // input ≈ request bytes / 3, output = 3000 streamed bytes / 3; the reserve is the request's bytes + the 2048 allowance + 512.
    assert.ok(result.usage.totalTokens >= 1000 && result.usage.totalTokens < reserved / 2, `charged ${result.usage.totalTokens} of a ${reserved} reserve`);
  } finally { await coordinator.close(); }
});

test('a decision superseded while its effort is being chosen costs nothing and keeps a pending failure review', async () => {
  let entered, proceed;
  const inHook = new Promise(resolve => { entered = resolve; }), hold = new Promise(resolve => { proceed = resolve; });
  const { provider, seen } = scripted(answer(decision()));
  const coordinator = new InitiativeCoordinator({ model, provider, decisionReasoning: async () => { entered(); await hold; return { reasoning: 'low' }; } });
  try {
    await coordinator.observe(event);
    const tick = coordinator.tick();
    await inHook;
    await coordinator.observe({ id: 'e2', type: 'user_message', summary: 'A new message' });
    proceed();
    const result = await tick;
    assert.deepEqual(result, { status: 'stale', reason: 'new_evidence', usage: { totalTokens: 0, estimatedTokens: 0 } });
    assert.equal(seen.length, 0, 'nothing was sent');
    const state = coordinator.snapshot();
    assert.equal(state.usedTokens, 0); assert.equal(state.reservedTokens, 0);
  } finally { await coordinator.close(); }
});

test('a decision whose provider reports no usage is charged its estimate, and admission still blocks at the reserve', async () => {
  let reserved = 0, coordinator;
  const quiet = scripted(answer(decision(), { usage: null }));
  coordinator = new InitiativeCoordinator({ model, provider: async function* (request) { reserved = coordinator.snapshot().reservedTokens; yield* quiet.provider(request); } });
  try {
    await coordinator.observe(event);
    const result = await coordinator.tick();
    assert.equal(result.status, 'decided');
    assert.ok(result.usage.estimatedTokens > 0 && result.usage.totalTokens === result.usage.estimatedTokens);
    assert.equal(coordinator.snapshot().usedTokens, result.usage.totalTokens); assert.equal(coordinator.snapshot().estimatedTokens, result.usage.totalTokens);
    assert.ok(result.usage.totalTokens < reserved / 2, `charged ${result.usage.totalTokens} of a ${reserved} reserve`);
  } finally { await coordinator.close(); }
  const budgeted = new InitiativeCoordinator({ model, provider: scripted(answer(decision())).provider, policy: { tokenBudget: 1000 } });
  try { await budgeted.observe(event); assert.deepEqual((await budgeted.tick()).reason, 'budget_exhausted'); }
  finally { await budgeted.close(); }
});

test('a local configuration refusal before the first byte is not charged', async () => {
  const provider = async function* () { throw Object.assign(new Error('bad config'), { code: 'configuration' }); };
  await assert.rejects(decideInitiative({ model, events: [event], provider }), error => error.code === 'configuration' && error.usage.totalTokens === 0);
});
