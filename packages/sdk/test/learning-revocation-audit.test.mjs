import test from 'node:test';
import assert from 'node:assert/strict';
import { LearningCoordinator, revokeLearningSources } from '../src/learning.mjs';

const review = (status, patch = {}) => ({ id: `r-${status}`, status, sourceIds: ['scope:old', 'session:one'], episodeKeys: [`key-${status}`], startedAt: 10, completedAt: 20,
  decision: { reason: 'PRIVATE decision' }, error: { code: 'invalid_learning_reflection', message: 'PRIVATE error' }, request: { phase: 'learning_reflection', requestStarted: true }, usage: { totalTokens: 23 }, ...patch });
const state = reviews => ({ schemaVersion: 1, episodes: [], reviews, seen: [], nextReviewAt: 0 });

test('source revocation preserves every terminal outcome and safe receipts without retaining source prose', () => {
  const statuses = ['no_change', 'deferred', 'completed', 'failed', 'interrupted'];
  const input = state(statuses.map(status => review(status, status === 'completed' ? { result: { status: 'rejected', versionId: 'candidate', summary: 'PRIVATE rejected candidate', usage: { totalTokens: 44 } } } : {})));
  const result = revokeLearningSources(input, ['scope:old'], 'project_scope_changed');
  assert.deepEqual(result.reviews.map(row => row.status), statuses);
  assert.deepEqual(result.reviews.map(row => row.statusBeforeRevocation), statuses);
  for (const row of result.reviews) {
    assert.equal(row.sourceRevoked, true); assert.equal(row.revocationReason, 'project_scope_changed');
    assert.deepEqual(row.sourceIds, ['session:one']); assert.equal(row.error.code, 'invalid_learning_reflection');
    assert.equal(row.usage.totalTokens, 23); assert.equal(row.request.requestStarted, true);
  }
  assert.deepEqual(result.reviews[2].result, { status: 'rejected', versionId: 'candidate', usage: { totalTokens: 44 } });
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.equal(input.reviews[2].sourceRevoked, undefined, 'projection must not mutate caller-owned state');
});

test('revoking active claims interrupts them, retains their original phase and never replays an experiment on reopen', async () => {
  const statuses = ['reviewing', 'queued_experiment', 'executing'];
  const revoked = revokeLearningSources(state(statuses.map(status => review(status, { executionStartedAt: 15 }))), ['scope:old'], 'project_scope_changed');
  assert.deepEqual(revoked.reviews.map(row => row.status), statuses.map(() => 'interrupted'));
  assert.deepEqual(revoked.reviews.map(row => row.statusBeforeRevocation), statuses);
  let calls = 0;
  const coordinator = new LearningCoordinator({ state: revoked, review: async () => { calls++; }, execute: async () => { calls++; } });
  await coordinator.tick(); await coordinator.tick(); assert.equal(calls, 0);
  await assert.rejects(coordinator.reconcile('r-executing', { status: 'retry_experiment', verifiedNoExecution: true }), { code: 'invalid_experiment_result' });
  await coordinator.close();
});

test('successive source removals preserve the first execution status, while legacy lost statuses remain unknown', () => {
  const first = revokeLearningSources(state([review('completed', { result: { status: 'ready', versionId: 'v' } })]), ['scope:old']);
  const second = revokeLearningSources(first, ['session:one'], 'session_deleted');
  assert.equal(second.reviews[0].status, 'completed'); assert.equal(second.reviews[0].statusBeforeRevocation, 'completed');
  assert.equal(second.reviews[0].revocationReason, 'session_deleted'); assert.deepEqual(second.reviews[0].sourceIds, []);
  const legacy = revokeLearningSources(state([review('interrupted', { sourceRevoked: true, result: { status: 'rejected', versionId: 'v' } })]), ['scope:old']);
  assert.equal(legacy.reviews[0].status, 'interrupted'); assert.equal(legacy.reviews[0].statusBeforeRevocation, undefined, 'do not infer the lost original status');
});

test('only affected reviews are scrubbed and terminal audit history stays terminal after SDK reopen', async () => {
  const untouched = review('no_change', { id: 'other', sourceIds: ['scope:other'] });
  const output = revokeLearningSources(state([review('completed', { result: { status: 'rejected', versionId: 'v' } }), untouched]), ['scope:old']);
  assert.deepEqual(output.reviews[1], untouched);
  const coordinator = new LearningCoordinator({ state: output, review: async () => assert.fail('no evidence'), execute: async () => assert.fail('no claim') });
  await coordinator.tick(); assert.equal(coordinator.snapshot().reviews[0].status, 'completed');
  assert.equal(coordinator.health().interrupted, 0); await coordinator.close();
});
