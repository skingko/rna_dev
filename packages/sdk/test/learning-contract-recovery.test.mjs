import test from 'node:test';
import assert from 'node:assert/strict';
import { LearningCoordinator } from '../src/learning.mjs';

const previousContractHash = 'a'.repeat(64), contractHash = 'b'.repeat(64), laterContractHash = 'c'.repeat(64);
const episode = id => ({ id, fingerprint: `fp-${id}`, kind: 'tool_failure', summary: 'The saved command receipt contradicted the completion claim.', at: '2026-09-26T00:00:00Z', sourceIds: ['session:s1'] });
const decision = episodes => ({ outcome: 'no_change', reason: 'The original fault has already been corrected.', evidenceIds: episodes.map(row => row.id), diagnosis: 'No repeatable improvement is justified by this corrected result.', hypothesis: '', intervention: '', validationPlan: '', limitations: 'Only the retained evidence was reviewed.', nextReviewAfterMs: 60000 });
const invalid = hash => {
  const usage = { input: 120, output: 321, totalTokens: 441 };
  return Object.assign(new Error('Reflection named evidence outside its frozen batch.'), { code: 'invalid_learning_reflection', usage,
    request: { id: 'measured-reflection', phase: 'learning_reflection', requestStarted: true, usageReported: true, stopReason: 'stop', completed: false, usage: structuredClone(usage), ...(hash !== undefined ? { reflectionContractHash: hash } : {}) } });
};

async function exhausted({ legacy = false, count = 2, attempts = 3 } = {}) {
  let now = 0;
  const c = new LearningCoordinator({ now: () => now, policy: { minReviewMs: 0, retryAfterMs: 1000 }, review: async () => { throw invalid(legacy ? undefined : previousContractHash); }, execute: () => assert.fail('Invalid reflection cannot execute') });
  await c.ingest(Array.from({ length: count }, (_, index) => episode(`e${index + 1}`)));
  for (let i = 0; i < attempts; i++) { await assert.rejects(c.tick(), { code: 'invalid_learning_reflection' }); now += 10000; }
  const state = c.snapshot(); await c.close(); return state;
}
function restore(state, options = {}) {
  return new LearningCoordinator({ state, policy: { minReviewMs: 0 }, review: async ({ episodes }) => ({ decision: decision(episodes) }), execute: () => assert.fail('Contract recovery cannot replay an experiment'), ...options });
}
const recover = c => c.retryInvalidReflections({ contractHash });

test('contract recovery durably releases the whole failed batch once and preserves original charges through restart', async () => {
  const base = await exhausted(), original = structuredClone(base.reviews); let saved, reviewed = 0;
  const c = restore(base, { now: () => 50000, saveState: value => { saved = value; }, review: () => { reviewed++; assert.fail('Recovery itself must not dispatch'); } });
  assert.deepEqual(await recover(c), { reviewIds: [original.at(-1).id] });
  assert.equal(reviewed, 0); assert.equal(c.health().pending, 2); assert.equal(saved.nextReviewAt, Math.min(base.nextReviewAt, 50000));
  assert.deepEqual(saved.reviews.at(-1).contractRecovery, { at: 50000, previousContractHash, contractHash, reason: 'reflection_contract_updated' });
  assert.ok(saved.episodes.every(row => row.status === 'pending' && row.nextReviewAt === 0 && row.consecutiveFailures === 0));
  for (let index = 0; index < original.length; index++) { const row = structuredClone(saved.reviews[index]); delete row.contractRecovery; assert.deepEqual(row, original[index]); }
  await c.close();
  const resumed = restore(saved);
  assert.deepEqual(await recover(resumed), { reviewIds: [] });
  assert.equal((await resumed.tick()).status, 'no_change'); assert.equal(resumed.health().seen, 2); assert.equal(resumed.snapshot().reviews.length, original.length + 1);
  assert.deepEqual(await recover(resumed), { reviewIds: [] }); await resumed.close();
});

test('a deferred failure can recover without waiting for the original backoff', async () => {
  const c = restore(await exhausted({ attempts: 1 }), { now: () => 1 });
  assert.equal(c.health().deferred, 2); assert.equal((await recover(c)).reviewIds.length, 1);
  assert.equal((await c.tick()).status, 'no_change'); await c.close();
});

test('legacy receipts need an explicit old contract proof and real receipt identity always takes precedence', async () => {
  const c = restore(await exhausted({ legacy: true }));
  assert.deepEqual(await recover(c), { reviewIds: [] });
  assert.deepEqual(await c.retryInvalidReflections({ contractHash, legacyContractHash: contractHash }), { reviewIds: [] });
  assert.equal((await c.retryInvalidReflections({ contractHash, legacyContractHash: previousContractHash })).reviewIds.length, 1); await c.close();
  for (const recorded of [contractHash, '', null, undefined, 'D'.repeat(64), 'x']) {
    const state = await exhausted(); state.reviews.at(-1).request.reflectionContractHash = recorded;
    const restored = restore(state); const before = restored.snapshot();
    assert.deepEqual(await restored.retryInvalidReflections({ contractHash, legacyContractHash: previousContractHash }), { reviewIds: [] });
    assert.deepEqual(restored.snapshot(), before); await restored.close();
  }
  const recorded = restore(await exhausted());
  assert.equal((await recorded.retryInvalidReflections({ contractHash, legacyContractHash: contractHash })).reviewIds.length, 1); await recorded.close();
});

test('both supplied contract identities must be lowercase SHA-256 hashes', async () => {
  const c = restore(await exhausted()), before = c.snapshot();
  for (const invalidHash of [undefined, null, '', 123, 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'z'.repeat(64)]) {
    await assert.rejects(c.retryInvalidReflections({ contractHash: invalidHash }), { code: 'learning_invalid' });
    if (invalidHash !== undefined) await assert.rejects(c.retryInvalidReflections({ contractHash, legacyContractHash: invalidHash }), { code: 'learning_invalid' });
  }
  assert.deepEqual(c.snapshot(), before); await c.close();
});

test('insufficient receipts and any execution, revocation or existing decision block recovery without mutation', async () => {
  const base = await exhausted();
  for (const patch of [
    row => { row.status = 'interrupted'; }, row => { row.status = 'completed'; }, row => { row.error.code = 'provider_error'; },
    row => { row.error.code = 'incomplete_learning_reflection'; }, row => { row.sourceRevoked = true; }, row => { row.decision = decision(base.episodes); },
    row => { row.executionStartedAt = 0; }, row => { row.interruptedPhase = 'executing'; }, row => { row.interruptedPhase = 'reviewing'; },
    row => { row.contractRecovery = { contractHash: laterContractHash }; }, row => { delete row.request; }, row => { row.request.phase = 'proposal'; },
    row => { row.request.requestStarted = false; }, row => { delete row.request.requestStarted; }, row => { row.request.usageReported = false; },
    row => { delete row.request.usageReported; }, row => { row.request.stopReason = 'length'; }, row => { delete row.request.stopReason; },
    row => { row.request.completed = true; }, row => { delete row.request.completed; },
  ]) {
    const state = structuredClone(base); patch(state.reviews.at(-1)); const c = restore(state), before = c.snapshot();
    assert.deepEqual(await recover(c), { reviewIds: [] }); assert.deepEqual(c.snapshot(), before); await c.close();
  }
});

test('only unclaimed deferred or awaiting-evidence episodes are eligible', async () => {
  const base = await exhausted();
  for (const patch of [row => { row.status = 'pending'; }, row => { row.status = 'interrupted'; }, row => { row.status = 'queued_experiment'; }, row => { row.reviewId = base.reviews.at(-1).id; }]) {
    const state = structuredClone(base); state.episodes.forEach(patch); const c = restore(state), before = c.snapshot();
    assert.deepEqual(await recover(c), { reviewIds: [] }); assert.deepEqual(c.snapshot(), before); await c.close();
  }
});

test('newer decisions or failures are never bypassed to recover an older eligible failure', async () => {
  for (const newer of [
    row => ({ ...row, status: 'deferred', decision: decision([episode('e1')]), request: undefined }),
    row => ({ ...row, error: { code: 'provider_error', message: 'A newer failure' } }),
    row => ({ ...row, request: { ...row.request, reflectionContractHash: contractHash } }),
  ]) {
    const state = await exhausted({ count: 1 }); state.reviews.push({ ...newer(state.reviews.at(-1)), id: 'newer-review' });
    const c = restore(state), before = c.snapshot(); assert.deepEqual(await recover(c), { reviewIds: [] }); assert.deepEqual(c.snapshot(), before); await c.close();
  }
});

test('a new failure under the current contract cannot be recovered again after restart', async () => {
  const c = restore(await exhausted()); await recover(c); c.review = async () => { throw invalid(contractHash); };
  await assert.rejects(c.tick(), { code: 'invalid_learning_reflection' }); const saved = c.snapshot(); await c.close();
  const resumed = restore(saved), before = resumed.snapshot();
  assert.deepEqual(await resumed.retryInvalidReflections({ contractHash, legacyContractHash: previousContractHash }), { reviewIds: [] });
  assert.deepEqual(resumed.snapshot(), before); assert.equal(resumed.health().pending, 0);
  assert.equal((await resumed.retryInvalidReflections({ contractHash: laterContractHash })).reviewIds.length, 1); await resumed.close();
});

test('a later hash-less failed request cannot recycle the same legacy proof into repeated recovery', async () => {
  const c = restore(await exhausted({ legacy: true })); await c.retryInvalidReflections({ contractHash, legacyContractHash: previousContractHash });
  c.review = async () => { throw invalid(undefined); }; await assert.rejects(c.tick(), { code: 'invalid_learning_reflection' });
  const saved = c.snapshot(); await c.close(); const resumed = restore(saved), before = resumed.snapshot();
  assert.deepEqual(await resumed.retryInvalidReflections({ contractHash, legacyContractHash: previousContractHash }), { reviewIds: [] });
  assert.deepEqual(resumed.snapshot(), before); await resumed.close();
});

test('saving the recovery claim must finish before another tick may dispatch', async () => {
  let release, entered; const saving = new Promise(resolve => { entered = resolve; }), saved = new Promise(resolve => { release = resolve; }); let calls = 0;
  const c = restore(await exhausted(), { saveState: async () => { entered(); await saved; }, review: async ({ episodes }) => { calls++; return { decision: decision(episodes) }; } });
  const recovery = recover(c); await saving; const tick = c.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0); release(); await recovery; assert.equal((await tick).status, 'no_change'); assert.equal(calls, 1); await c.close();
});

test('a failed recovery save prevents dispatch, and a restart from the prior durable state can safely try saving again', async () => {
  const state = await exhausted(), diskError = Object.assign(new Error('The durable store is unavailable'), { code: 'EIO' }); let calls = 0;
  const c = restore(state, { saveState: async () => { throw diskError; }, review: async () => { calls++; assert.fail('Unsaved recovery must not dispatch'); } });
  await assert.rejects(recover(c), error => error === diskError);
  await assert.rejects(recover(c), error => error === diskError); await assert.rejects(c.tick(), error => error === diskError);
  assert.equal(calls, 0); assert.equal(c.health().persistenceError, 'EIO'); await c.close();
  const resumed = restore(state); assert.equal((await recover(resumed)).reviewIds.length, 1); assert.equal((await resumed.tick()).status, 'no_change'); await resumed.close();
});

test('closed, active and unsettled coordinators cannot alter recovery state', async () => {
  const base = await exhausted(), closed = restore(base); await closed.close(); await assert.rejects(recover(closed), { code: 'closed' });
  const unsettled = restore(base), pending = Promise.resolve(); unsettled.unsettled.add(pending);
  await assert.rejects(recover(unsettled), { code: 'learning_busy' }); assert.deepEqual(unsettled.snapshot(), base); unsettled.unsettled.delete(pending); await unsettled.close();
  let resolveReview, entered; const started = new Promise(resolve => { entered = resolve; });
  const active = restore(base, { review: async ({ episodes }) => { entered(); await new Promise(resolve => { resolveReview = resolve; }); return { decision: decision(episodes) }; } });
  await recover(active); const tick = active.tick(); await started; const before = active.snapshot();
  await assert.rejects(recover(active), { code: 'learning_busy' }); assert.deepEqual(active.snapshot(), before); resolveReview(); await tick; await active.close();
});
