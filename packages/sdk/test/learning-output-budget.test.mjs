import test from 'node:test';
import assert from 'node:assert/strict';
import { LearningCoordinator, reflectProjectLearning } from '../src/learning.mjs';
import { buildRequest } from '../src/providers.mjs';

const model = { providerId: 'glm', modelId: 'glm-5.3', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', contextWindow: 1000000, maxOutputTokens: 32768, reasoning: 'xhigh' };
const episode = { id: 'e1', fingerprint: 'fp1', kind: 'tool_failure', summary: 'A real command failed at an input boundary.', at: '2026-09-26T00:00:00Z', sourceIds: ['session:s1'] };
const decision = { outcome: 'no_change', reason: 'This has already been corrected.', evidenceIds: ['e1'], diagnosis: 'No reusable change is justified by this single corrected command.', hypothesis: '', intervention: '', validationPlan: '', limitations: 'Only one observation.', nextReviewAfterMs: 60000 };
const complete = async function* () { yield { type: 'text_delta', delta: JSON.stringify(decision) }; yield { type: 'usage', usage: { input: 100, output: 10754, totalTokens: 10854 } }; yield { type: 'done', stopReason: 'stop' }; };
const truncated = async function* () { yield { type: 'usage', usage: { input: 100, output: 4096, totalTokens: 4196 } }; yield { type: 'done', stopReason: 'length' }; };

test('GLM reflection reserves and sends the configured shared reasoning and answer budget', async () => {
  const admissions = [], receipts = [];
  const result = await reflectProjectLearning({ model, episodes: [episode], provider: async function* (request) {
    const wire = buildRequest(request).body;
    assert.equal(wire.max_tokens, 32768); assert.equal(wire.max_completion_tokens, undefined);
    assert.equal(request.model.reasoning, 'xhigh'); assert.equal(wire.thinking.type, 'enabled');
    yield* complete();
  }, requestControl: { beforeRequest: r => admissions.push(r), onUsage: r => receipts.push(r) } });
  assert.equal(admissions[0].maxOutputTokens, 32768); assert.ok(admissions[0].estimatedTokens > 32768);
  assert.equal(receipts[0].usage.output, 10754); assert.equal(receipts[0].maxOutputTokens, 32768);
  assert.equal(result.decision.outcome, 'no_change');
});

test('explicit phase budget is honored without exceeding a lower user budget', async () => {
  for (const [configured, explicit, expected] of [[32768, 4096, 4096], [2048, 8192, 2048], [2048, undefined, 2048]]) {
    await reflectProjectLearning({ model: { ...model, maxOutputTokens: configured }, maxOutputTokens: explicit, episodes: [episode], provider: async function* (request) {
      assert.equal(buildRequest(request).body.max_tokens, expected); yield* complete();
    } });
  }
  for (const invalid of [0, -1, 1.5, NaN, Infinity, null]) await assert.rejects(reflectProjectLearning({ model, maxOutputTokens: invalid, episodes: [episode], provider: complete }), { code: 'learning_invalid' });
});

async function exhausted({ legacy = false } = {}) {
  let now = 0;
  const coordinator = new LearningCoordinator({ now: () => now, policy: { minReviewMs: 0, retryAfterMs: 1000 }, review: input => reflectProjectLearning({ ...input, model: { ...model, maxOutputTokens: 4096 }, provider: truncated }), execute: () => { throw new Error('No truncated result may execute'); } });
  await coordinator.ingest([episode]);
  for (let i = 0; i < 3; i++) { await assert.rejects(coordinator.tick(), { code: 'incomplete_learning_reflection' }); now += 10000; }
  assert.equal(coordinator.health().awaitingEvidence, 1);
  const state = coordinator.snapshot(); await coordinator.close();
  if (legacy) for (const review of state.reviews) delete review.request.maxOutputTokens;
  return state;
}
const restore = state => new LearningCoordinator({ state, policy: { minReviewMs: 0 }, review: input => reflectProjectLearning({ ...input, model, provider: complete }), execute: () => { throw new Error('No experiment expected'); } });

test('a proven exhausted reflection can retry once at a higher budget, retaining receipts through restart', async () => {
  const state = await exhausted(), previous = structuredClone(state.reviews);
  let saved;
  const c = restore(state); c.saveState = value => { saved = value; };
  const recovery = await c.retryTruncatedReflections({ maxOutputTokens: 32768 });
  assert.deepEqual(recovery.reviewIds, [state.reviews.at(-1).id]); assert.equal(c.health().pending, 1);
  assert.equal(saved.reviews.at(-1).outputBudgetRecovery.previousMaxOutputTokens, 4096);
  for (let i = 0; i < previous.length; i++) { const actual = structuredClone(saved.reviews[i]); delete actual.outputBudgetRecovery; assert.deepEqual(actual, previous[i]); }
  await c.close();
  const resumed = restore(saved);
  assert.deepEqual(await resumed.retryTruncatedReflections({ maxOutputTokens: 32768 }), { reviewIds: [] });
  assert.equal((await resumed.tick()).status, 'no_change'); assert.equal(resumed.snapshot().reviews.length, 4);
  assert.equal(resumed.health().seen, 1); await resumed.close();
});

test('legacy recovery needs an attested cap matching actual reported output', async () => {
  const state = await exhausted({ legacy: true }), c = restore(state);
  assert.deepEqual(await c.retryTruncatedReflections({ maxOutputTokens: 32768 }), { reviewIds: [] });
  assert.deepEqual(await c.retryTruncatedReflections({ maxOutputTokens: 32768, legacyMaxOutputTokens: 2048 }), { reviewIds: [] });
  assert.equal((await c.retryTruncatedReflections({ maxOutputTokens: 32768, legacyMaxOutputTokens: 4096 })).reviewIds.length, 1);
  await c.close();
});

test('recovery never replays experiments or revokes newer decisions or retries an unchanged budget', async () => {
  const base = await exhausted();
  for (const patch of [
    e => { e.status = 'interrupted'; }, e => { e.sourceRevoked = true; }, e => { e.executionStartedAt = 0; },
    e => { e.decision = decision; }, e => { e.request.usageReported = false; }, e => { e.request.stopReason = 'stop'; },
    e => { e.error.code = 'provider_error'; }, e => { e.outputBudgetRecovery = { maxOutputTokens: 32768 }; },
    e => { e.request.usage.output = 4095; }, e => { e.interruptedPhase = 'executing'; },
  ]) {
    const state = structuredClone(base); patch(state.reviews.at(-1)); const c = restore(state);
    assert.deepEqual(await c.retryTruncatedReflections({ maxOutputTokens: 32768 }), { reviewIds: [] }); await c.close();
  }
  const c = restore(base); assert.deepEqual(await c.retryTruncatedReflections({ maxOutputTokens: 4096 }), { reviewIds: [] }); await c.close();
  const state = structuredClone(base); state.reviews.push({ ...structuredClone(state.reviews.at(-1)), id: 'newer', status: 'deferred', decision, request: undefined });
  const newer = restore(state); assert.deepEqual(await newer.retryTruncatedReflections({ maxOutputTokens: 32768 }), { reviewIds: [] }); await newer.close();
});

test('a second truncation at the enlarged budget cannot restart the recovery cycle', async () => {
  const c = restore(await exhausted());
  await c.retryTruncatedReflections({ maxOutputTokens: 32768 });
  c.review = input => reflectProjectLearning({ ...input, model, provider: async function* () {
    yield { type: 'usage', usage: { input: 100, output: 32768, totalTokens: 32868 } };
    yield { type: 'done', stopReason: 'length' };
  } });
  await assert.rejects(c.tick(), { code: 'incomplete_learning_reflection' });
  const snapshot = c.snapshot(); await c.close();
  const restarted = restore(snapshot);
  assert.deepEqual(await restarted.retryTruncatedReflections({ maxOutputTokens: 32768, legacyMaxOutputTokens: 4096 }), { reviewIds: [] });
  assert.equal(restarted.health().pending, 0); assert.equal(restarted.health().deferred, 1);
  assert.equal(restarted.snapshot().reviews.at(-1).request.maxOutputTokens, 32768);
  await restarted.close();
});
