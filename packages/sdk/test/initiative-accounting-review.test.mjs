import test from 'node:test';
import assert from 'node:assert/strict';
import { InitiativeCoordinator, decideInitiative } from '../src/initiative.mjs';

// P1 review ACC-1 / ACC-2: what a proactive decision is charged when the provider rejected it over HTTP, or when its
// stream was cut off after a usage report that is not the final one (Anthropic reports output ≈ 1 at message_start).
const capability = { control: 'effort', efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }], providerDefault: null, canDisable: false };
const model = { protocol: 'openai', providerId: 'glm', modelId: 'glm-fixture', maxOutputTokens: 2048, reasoning: 'max', reasoningCapability: capability };
const event = { id: 'e1', type: 'project_opened', summary: 'A finished background check reported nothing new.' };
const wait = { action: 'wait', reason: 'Nothing new to act on', evidenceIds: [], content: '', nextReviewAfterMs: 60000 };

test('ACC-1: a decision the provider rejected over HTTP after the SDK retried it is charged nothing', async () => {
  const rejected = async function* () { yield { type: 'retry', attempt: 1, maxRetries: 2, delayMs: 0, status: 429 }; throw Object.assign(new Error('rate limited'), { code: 'http_error', status: 429 }); };
  await assert.rejects(decideInitiative({ model, events: [event], provider: rejected }), error => error.code === 'http_error' && error.usage.totalTokens === 0);
  const coordinator = new InitiativeCoordinator({ model, provider: rejected });
  try {
    await coordinator.observe(event);
    await coordinator.tick().catch(() => null);
    const state = coordinator.snapshot();
    assert.equal(state.usedTokens, 0, 'it used to charge the attempt\'s estimated input'); assert.equal(state.estimatedTokens, 0); assert.equal(state.reservedTokens, 0);
  } finally { await coordinator.close(); }
  // A failure after the provider answered is still charged.
  const broken = async function* () { yield { type: 'text_delta', delta: 'x'.repeat(300) }; throw Object.assign(new Error('stream broke'), { code: 'stream_error' }); };
  await assert.rejects(decideInitiative({ model, events: [event], provider: broken }), error => error.usage.totalTokens > 100);
});

test('ACC-2: a decision cut off after a usage report is charged the report plus what streamed after it', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const provider = async function* (request) {
    yield { type: 'usage', usage: { input: 5000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5001 } };
    yield { type: 'thinking_delta', delta: 'x'.repeat(3000) };
    await new Promise((resolve, reject) => { request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }); release(); });
  };
  const coordinator = new InitiativeCoordinator({ model, provider });
  try {
    await coordinator.observe(event);
    const tick = coordinator.tick();
    await gate;
    coordinator.invalidateDecision('user_message');
    const result = await tick;
    assert.equal(result.status, 'stale');
    assert.deepEqual(result.usage, { totalTokens: 6001, estimatedTokens: 1000 }, 'it used to be 5001, output 1');
    assert.equal(coordinator.snapshot().usedTokens, 6001); assert.equal(coordinator.snapshot().estimatedTokens, 1000);
  } finally { await coordinator.close(); }
  // A completed request's last report is final: nothing is added.
  const complete = async function* () {
    yield { type: 'usage', usage: { input: 5000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5001 } };
    yield { type: 'text_delta', delta: JSON.stringify(wait) };
    yield { type: 'usage', usage: { input: 5000, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 5040 } };
    yield { type: 'done', stopReason: 'stop' };
  };
  const decided = await decideInitiative({ model, events: [event], provider: complete });
  assert.equal(decided.status, 'decided'); assert.equal(decided.usage.totalTokens, 5040); assert.equal(decided.usage.estimatedTokens, undefined);
});
