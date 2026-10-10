import test from 'node:test';
import assert from 'node:assert/strict';
import { LearningCoordinator, reflectProjectLearning, validateLearningReflection, revokeLearningSources } from '../src/learning.mjs';
import { buildRequest } from '../src/providers.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 4096 };
const episode = (id = 'e1', patch = {}) => ({ id, fingerprint: `fp:${id}`, kind: 'completed_turn', summary: 'User corrected an unchecked output; a tool later confirmed the input boundary.', at: '2026-09-25T00:00:00Z', sourceIds: ['session:s1'], ...patch });
const decision = (outcome = 'experiment', evidenceIds = ['e1'], patch = {}) => ({ outcome, reason: 'The observed boundary should be checked before claiming completion.', evidenceIds, diagnosis: 'The observed run skipped the boundary check.', hypothesis: outcome === 'experiment' ? 'An explicit boundary check reduces unsupported claims.' : '', intervention: outcome === 'experiment' ? 'Add the existing verifier to the skill completion procedure.' : '', validationPlan: outcome === 'experiment' ? 'Compare on a frozen representative task and preserve prior regressions.' : '', limitations: 'No general visual-quality improvement has been demonstrated.', nextReviewAfterMs: 60000, ...patch });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const provider = value => async function* () { yield { type: 'text_delta', delta: JSON.stringify(value) }; yield { type: 'usage', usage: { input: 10, output: 20, totalTokens: 30 } }; yield { type: 'done', stopReason: 'stop' }; };
const options = patch => ({ review: async () => ({ decision: decision('no_change') }), execute: async () => ({ status: 'ready', versionId: 'v1', summary: 'Frozen evaluation passed.' }), policy: { minReviewMs: 0 }, ...patch });

test('reflection uses actual source IDs and returns an unverified hypothesis with no effects', async () => {
  const receipts = [], calls = [];
  const result = await reflectProjectLearning({ project: { id: 'p1' }, episodes: [episode()], model, provider: async function* (request) { calls.push(request); yield* provider(decision())(); }, requestControl: { beforeRequest: request => { assert.ok(request.estimatedTokens > 0); }, onUsage: receipt => receipts.push(receipt) } });
  assert.equal(result.decision.outcome, 'experiment'); assert.equal(result.usage.totalTokens, 30); assert.equal(receipts.length, 1);
  assert.deepEqual(calls[0].tools, []); assert.deepEqual(JSON.parse(calls[0].messages[0].content[0].text).allowedEvidenceIds, ['e1']);
  assert.match(calls[0].systemPrompt, /unverified interpretations/); assert.match(calls[0].systemPrompt, /A new user request or Goal is not required/);
});

test('reflection uses declared native JSON with an audited contract, keeps unknown transports prompt-only and still validates and charges failures', async () => {
  const official = { ...model, modelId: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com' };
  for (const [selected, native] of [[official, true], [{ ...official, baseUrl: 'https://fixture.invalid/v1' }, false], [{ ...official, baseUrl: 'https://fixture.invalid/v1', compat: { supportsJsonObject: true, supportsToolChoiceNone: true } }, true], [{ ...official, compat: { supportsJsonObject: false, supportsToolChoiceNone: false } }, false]]) {
    const receipts = []; let calls = 0;
    const result = await reflectProjectLearning({ episodes: [episode()], model: selected, provider: async function* (request) {
      calls++; const wire = buildRequest(request).body;
      assert.deepEqual(wire.response_format, native ? { type: 'json_object' } : undefined); assert.equal(wire.tool_choice, native ? 'none' : undefined); assert.deepEqual(request.tools, []);
      yield* provider(decision('no_change'))();
    }, requestControl: { onUsage: receipt => receipts.push(receipt) } });
    assert.equal(calls, 1); assert.equal(result.request.responseContract.mode, native ? 'native' : 'prompt_only'); assert.deepEqual(receipts[0].responseContract, result.request.responseContract); assert.equal(receipts[0].usage.totalTokens, 30);
  }
  const receipts = []; let invalidCalls = 0;
  await assert.rejects(reflectProjectLearning({ episodes: [episode()], model: official, provider: async function* () { invalidCalls++; yield* provider(decision('experiment', ['fabricated']))(); }, requestControl: { onUsage: row => receipts.push(row) } }), error => error.code === 'invalid_learning_reflection' && error.request.responseContract.mode === 'native' && error.usage.totalTokens === 30);
  assert.equal(invalidCalls, 1); assert.equal(receipts[0].completed, false); assert.equal(receipts[0].usage.totalTokens, 30);
  let rejectedCalls = 0;
  await assert.rejects(reflectProjectLearning({ episodes: [episode()], model: official, provider: async function* () { rejectedCalls++; yield { type: 'usage', usage: { totalTokens: 4 } }; yield { type: 'error', error: { code: 'http_400', status: 400 } }; } }), error => error.code === 'http_400' && error.usage.totalTokens === 4 && error.request.responseContract.mode === 'native');
  assert.equal(rejectedCalls, 1, 'a rejected native contract is not resent without constraints');
});

test('invalid reflection cannot fabricate evidence, omit validation or authorize a version', () => {
  for (const bad of [decision('experiment', ['invented']), decision('experiment', ['e1', 'e1']), decision('experiment', ['e1'], { hypothesis: ' ' }), decision('experiment', ['e1'], { validationPlan: '' }), decision('experiment', ['e1'], { gatePassed: true }), decision('defer', [], {}), decision('defer', ['e1'], { nextReviewAfterMs: 0 })]) assert.throws(() => validateLearningReflection(bad, [episode()]), { code: 'invalid_learning_reflection' });
  const value = decision('no_change'); assert.deepEqual(validateLearningReflection(value, [episode()]), value);
});

test('admission rejection and admission-time cancellation make no model call and no phantom charge', async () => {
  let calls = 0; const receipts = [], controller = new AbortController(), fake = async function* () { calls++; };
  await assert.rejects(reflectProjectLearning({ episodes: [episode()], model, provider: fake, requestControl: { beforeRequest: () => { throw Object.assign(new Error('budget'), { code: 'budget' }); }, onUsage: row => receipts.push(row) } }), { code: 'budget' });
  assert.equal(receipts.length, 0);
  await assert.rejects(reflectProjectLearning({ episodes: [episode()], model, provider: fake, signal: controller.signal, requestControl: { beforeRequest: () => controller.abort(), onUsage: row => receipts.push(row) } }));
  assert.equal(calls, 0); assert.equal(receipts.length, 1); assert.equal(receipts[0].usage.totalTokens, 0); assert.equal(receipts[0].requestStarted, false);
});

test('unknown usage is estimated honestly while malformed, truncated and tool outputs never become decisions', async () => {
  const receipts = [];
  const result = await reflectProjectLearning({ episodes: [episode()], model, provider: async function* () { yield { type: 'text_delta', delta: JSON.stringify(decision('no_change')) }; yield { type: 'done', stopReason: 'stop' }; }, requestControl: { onUsage: row => receipts.push(row) } });
  assert.ok(result.usage.estimatedTokens > 0); assert.equal(result.usage.estimatedTokens, result.usage.totalTokens);
  for (const [events, code] of [
    [[{ type: 'text_delta', delta: 'not JSON' }, { type: 'usage', usage: { totalTokens: 4 } }, { type: 'done', stopReason: 'stop' }], 'invalid_learning_reflection'],
    [[{ type: 'text_delta', delta: JSON.stringify(decision()) }, { type: 'done', stopReason: 'length' }], 'incomplete_learning_reflection'],
    [[{ type: 'tool_call', id: 'invented', name: 'write' }], 'unexpected_tool_call'],
  ]) await assert.rejects(reflectProjectLearning({ episodes: [episode()], model, provider: async function* () { yield* events; } }), error => error.code === code && error.usage.totalTokens > 0);
});

test('invalid or over-capacity inputs fail before dispatch, without silently omitting constraints', async () => {
  let calls = 0; const fake = async function* () { calls++; };
  for (const episodes of [[], [episode(), episode()], [episode('e1', { summary: 'x'.repeat(6001) })], [episode('e1', { at: 'yesterday' })]]) await assert.rejects(reflectProjectLearning({ episodes, model, provider: fake }), { code: 'invalid_learning_episodes' });
  await assert.rejects(reflectProjectLearning({ episodes: [episode()], model: { ...model, contextWindow: 10 }, provider: fake }), { code: 'context_capacity' });
  await assert.rejects(reflectProjectLearning({ episodes: [episode()], model: { ...model, providerId: 'demo' }, provider: fake }), { code: 'configured_model_required' }); assert.equal(calls, 0);
});

test('backlog does not depend on chat, work routing or new goals and persists claims before callbacks', async () => {
  let saved; const states = [], order = [];
  const coordinator = new LearningCoordinator(options({ saveState: state => { saved = state; states.push(state); }, review: async ({ episodes, reviewId }) => { order.push('review'); assert.equal(saved.reviews.at(-1).id, reviewId); assert.equal(saved.reviews.at(-1).status, 'reviewing'); assert.deepEqual(episodes.map(row => row.id), ['e1']); return { decision: decision() }; }, execute: async ({ reviewId }) => { order.push('execute'); assert.equal(saved.reviews.at(-1).id, reviewId); assert.equal(saved.reviews.at(-1).status, 'executing'); return { status: 'ready', versionId: 'real-version-id', summary: 'A separately evaluated candidate exists.' }; } }));
  await coordinator.ingest([episode()]); await coordinator.tick();
  assert.deepEqual(order, ['review', 'execute']); assert.equal(saved.reviews[0].result.versionId, 'real-version-id'); assert.equal(saved.episodes.length, 0); assert.equal(saved.seen.length, 1);
  const writes = states.length; for (let i = 0; i < 100; i++) await coordinator.tick(); assert.equal(states.length, writes); assert.equal(order.length, 2);
  assert.deepEqual((await coordinator.ingest([episode()])).duplicate, ['e1']); await coordinator.close();
});

test('new episodes append without cancelling a frozen experiment, and remain pending after its completion', async () => {
  const entered = deferred(), release = deferred(); let experimentSignal;
  const coordinator = new LearningCoordinator(options({ review: async () => ({ decision: decision() }), execute: async ({ signal }) => { experimentSignal = signal; entered.resolve(); await release.promise; return { status: 'rejected', versionId: 'v1', summary: 'Measured candidate was not better.' }; } }));
  await coordinator.ingest([episode()]); const work = coordinator.tick(); await entered.promise;
  await coordinator.ingest([episode('e2')]); assert.equal(experimentSignal.aborted, false); assert.equal((await coordinator.tick()).status, 'busy');
  release.resolve(); await work; assert.deepEqual(coordinator.snapshot().episodes.map(row => [row.id, row.status]), [['e2', 'pending']]); assert.equal(coordinator.snapshot().seen.length, 1); await coordinator.close();
});

test('no-change covers only cited evidence; oldest bounded batches retain everything else', async () => {
  const batches = [];
  const coordinator = new LearningCoordinator(options({ policy: { minReviewMs: 0, maxBatch: 2 }, review: async ({ episodes }) => { batches.push(episodes.map(row => row.id)); return { decision: decision('no_change', [episodes[0].id]) }; } }));
  await coordinator.ingest([episode('e3', { at: '2026-09-25T00:03:00Z' }), episode('e2', { at: '2026-09-25T00:02:00Z' }), episode('e1')]);
  await coordinator.tick(); assert.deepEqual(batches[0], ['e1', 'e2']); assert.deepEqual(coordinator.snapshot().episodes.map(row => row.id), ['e3', 'e2']);
  await coordinator.tick(); assert.deepEqual(batches[1], ['e2', 'e3']); assert.equal(coordinator.snapshot().seen.length, 2); await coordinator.close();
});

test('defer persists a due time, avoids idle paid polling and can reconsider with genuinely new evidence', async () => {
  let now = 1000, calls = 0;
  const coordinator = new LearningCoordinator(options({ now: () => now, review: async ({ episodes }) => { calls++; return { decision: decision('defer', episodes.map(row => row.id)) }; } }));
  await coordinator.ingest([episode()]); await coordinator.tick(); assert.equal(coordinator.snapshot().episodes[0].nextReviewAt, 61000);
  now = 60000; await coordinator.tick(); assert.equal(calls, 1);
  await coordinator.ingest([episode('e2')]); await coordinator.tick(); assert.equal(calls, 2); assert.equal(coordinator.snapshot().episodes.length, 2);
  now = 120000; await coordinator.tick(); assert.equal(calls, 3); assert.equal(coordinator.snapshot().seen.length, 0); await coordinator.close();
});

test('experiment cooldown queues the validated decision without rerunning reflection and survives restart', async () => {
  let now = 1000, reviews = 0, executions = 0, saved;
  const config = options({ now: () => now, policy: { minReviewMs: 0, experimentNotBefore: 10000 }, saveState: state => { saved = state; }, review: async () => { reviews++; return { decision: decision() }; }, execute: async () => { executions++; return { status: 'ready', versionId: 'v1', summary: 'Ready.' }; } });
  const first = new LearningCoordinator(config); await first.ingest([episode()]); assert.equal((await first.tick()).status, 'experiment_waiting'); await first.close();
  assert.equal(saved.reviews[0].status, 'queued_experiment'); const next = new LearningCoordinator({ ...config, state: saved });
  await next.tick(); assert.equal(executions, 0); now = 10000; await next.tick(); assert.equal(reviews, 1); assert.equal(executions, 1); await next.close();
});

test('busy experiment host defers without consuming evidence or inventing a completed evaluation', async () => {
  let now = 1000, calls = 0, reviews = 0;
  const coordinator = new LearningCoordinator(options({ now: () => now, review: async () => { reviews++; return { decision: decision() }; }, execute: async () => ++calls === 1 ? { deferred: true, nextAttemptAt: 2000, reason: 'evolution_busy' } : { status: 'rejected', versionId: 'v1', summary: 'Rejected.' } }));
  await coordinator.ingest([episode()]); await coordinator.tick(); assert.equal(coordinator.health().queued, 1); assert.equal(coordinator.snapshot().seen.length, 0);
  await coordinator.tick(); assert.equal(calls, 1); now = 2000; await coordinator.tick(); assert.equal(calls, 2); assert.equal(reviews, 1); assert.equal(coordinator.snapshot().seen.length, 1); await coordinator.close();
});

test('restart during admitted experiment is interrupted and never replayed until host reconciles its immutable result', async () => {
  const entered = deferred(), release = deferred(); let saved, calls = 0;
  const first = new LearningCoordinator(options({ saveState: state => { saved = state; }, review: async () => ({ decision: decision() }), execute: async () => { entered.resolve(); await release.promise; return { status: 'ready', versionId: 'v1', summary: 'Ready.' }; } }));
  await first.ingest([episode()]); const run = first.tick(); await entered.promise;
  const restored = new LearningCoordinator(options({ state: saved, execute: async () => { calls++; } })); const reviewId = restored.snapshot().reviews[0].id;
  assert.equal(restored.health().interrupted, 1); await restored.tick(); await restored.tick(); assert.equal(calls, 0);
  await assert.rejects(restored.reconcile(reviewId, { status: 'retry_review', verifiedNoExecution: true }), { code: 'invalid_experiment_result' });
  await restored.reconcile(reviewId, { status: 'ready', versionId: 'v1', summary: 'Read from the durable version record.' }); assert.equal(restored.snapshot().seen.length, 1);
  release.resolve(); await run; await first.close(); await restored.close();
});

test('hard invalidation blocks late result commitment and explicit verified review recovery preserves evidence', async () => {
  const entered = deferred(), release = deferred();
  const coordinator = new LearningCoordinator(options({ review: async () => { entered.resolve(); await release.promise; return { decision: decision('no_change') }; } }));
  await coordinator.ingest([episode()]); const run = coordinator.tick(); await entered.promise; coordinator.invalidate('permission_changed'); release.resolve(); await assert.rejects(run, { code: 'permission_changed' });
  const entry = coordinator.snapshot().reviews[0]; assert.equal(entry.status, 'interrupted'); assert.equal(coordinator.snapshot().seen.length, 0);
  await coordinator.reconcile(entry.id, { status: 'retry_review', verifiedNoExecution: true }); assert.equal(coordinator.health().pending, 1); await coordinator.close();
});

test('review failure backoff retains evidence and only logs sanitized diagnostics', async () => {
  let now = 1000, calls = 0;
  const coordinator = new LearningCoordinator(options({ now: () => now, review: async () => { calls++; throw Object.assign(new Error('Bearer fixture-secret'), { code: 'provider_error', usage: { totalTokens: 20 } }); } }));
  await coordinator.ingest([episode()]); await assert.rejects(coordinator.tick(), { code: 'provider_error' });
  assert.equal(coordinator.health().deferred, 1); assert.equal(coordinator.snapshot().seen.length, 0); assert.ok(!JSON.stringify(coordinator.snapshot()).includes('fixture-secret'));
  now = 60000; await coordinator.tick(); assert.equal(calls, 1); now = 62000; await assert.rejects(coordinator.tick()); assert.equal(calls, 2); await coordinator.close();
});

test('same evidence failures back off exponentially, pause after three attempts across restart, and need accepted evidence to reset', async () => {
  let now = 1000, calls = 0;
  const config = options({ now: () => now, policy: { minReviewMs: 0, maxPending: 2 }, review: async () => { calls++; throw Object.assign(new Error('Unavailable'), { code: 'provider_error' }); } });
  let coordinator = new LearningCoordinator(config);
  await coordinator.ingest([episode()]); await assert.rejects(coordinator.tick());
  assert.equal(coordinator.snapshot().episodes[0].consecutiveFailures, 1); assert.equal(coordinator.snapshot().episodes[0].nextReviewAt, 61000);
  now = 61000; await assert.rejects(coordinator.tick());
  assert.equal(coordinator.snapshot().episodes[0].consecutiveFailures, 2); assert.equal(coordinator.snapshot().episodes[0].nextReviewAt, 181000);
  const persisted = coordinator.snapshot(); await coordinator.close(); coordinator = new LearningCoordinator({ ...config, state: persisted });
  now = 180999; await coordinator.tick(); assert.equal(calls, 2);
  now = 181000; await assert.rejects(coordinator.tick()); assert.equal(coordinator.health().awaitingEvidence, 1); assert.equal(coordinator.snapshot().episodes[0].consecutiveFailures, 3);
  now = 999999; for (let i = 0; i < 10; i++) assert.equal((await coordinator.tick()).status, 'awaiting_evidence'); assert.equal(calls, 3);
  await coordinator.ingest([episode(), episode('e1', { fingerprint: 'conflicting-revision' })]); assert.equal(coordinator.health().awaitingEvidence, 1);
  assert.deepEqual((await coordinator.ingest([episode('e2')])).accepted, ['e2']); assert.equal(coordinator.health().pending, 2); assert.equal(coordinator.snapshot().episodes[0].consecutiveFailures, 0);
  await assert.rejects(coordinator.tick()); assert.equal(calls, 4); assert.equal(coordinator.snapshot().episodes[0].consecutiveFailures, 1); await coordinator.close();
});

test('same evidence deferrals stop paid polling after three, while backlog rejection is not fresh evidence', async () => {
  let now = 1000, calls = 0;
  const config = options({ now: () => now, policy: { minReviewMs: 0, maxPending: 1 }, review: async ({ episodes }) => { calls++; return { decision: decision('defer', episodes.map(row => row.id)) }; } });
  const first = new LearningCoordinator(config); await first.ingest([episode()]);
  for (let i = 0; i < 3; i++) { await first.tick(); now += 60000; }
  assert.equal(first.health().awaitingEvidence, 1); assert.equal(first.snapshot().episodes[0].deferCount, 3); assert.equal(first.snapshot().seen.length, 0);
  const persisted = first.snapshot(); await first.close(); const restored = new LearningCoordinator({ ...config, state: persisted });
  now = 1000000; assert.equal((await restored.tick()).status, 'awaiting_evidence'); assert.equal(calls, 3);
  assert.equal((await restored.ingest([episode('e2')])).deferred[0].reason, 'backlog_full'); assert.equal(restored.health().awaitingEvidence, 1); await restored.close();
  const reopened = new LearningCoordinator({ ...config, policy: { minReviewMs: 0, maxPending: 2 }, state: restored.snapshot() });
  await reopened.ingest([episode('e2')]); assert.equal(reopened.snapshot().episodes[0].deferCount, 0); await reopened.tick(); assert.equal(calls, 4); assert.deepEqual(reopened.snapshot().episodes.map(row => row.deferCount), [1, 1]); await reopened.close();
});

test('a successful reflection resets consecutive failure streak without erasing deferral history', async () => {
  let now = 1000, calls = 0;
  const coordinator = new LearningCoordinator(options({ now: () => now, review: async () => { if (++calls !== 2) throw new Error('Transient'); return { decision: decision('defer') }; } }));
  await coordinator.ingest([episode()]); await assert.rejects(coordinator.tick()); now = 61000; await coordinator.tick();
  assert.equal(coordinator.snapshot().episodes[0].consecutiveFailures, 0); assert.equal(coordinator.snapshot().episodes[0].deferCount, 1);
  now = 121000; await assert.rejects(coordinator.tick()); assert.equal(coordinator.snapshot().episodes[0].consecutiveFailures, 1); assert.equal(coordinator.snapshot().episodes[0].deferCount, 1); assert.equal(coordinator.snapshot().episodes[0].nextReviewAt, 181000); await coordinator.close();
});

test('verified pre-dispatch experiment recovery reuses the frozen reflection and persists its queue across restart', async () => {
  let reflections = 0, executions = 0, now = 1000;
  const config = options({ now: () => now, review: async () => { reflections++; return { decision: decision(), usage: { totalTokens: 31 } }; }, execute: async () => { if (++executions === 1) throw Object.assign(new Error('Snapshot unavailable before dispatch'), { code: 'EACCES' }); return { status: 'ready', versionId: 'v1', summary: 'A durable evaluated version.' }; } });
  const first = new LearningCoordinator(config); await first.ingest([episode()]); await assert.rejects(first.tick());
  const review = first.snapshot().reviews[0]; assert.equal(review.interruptedPhase, 'executing');
  await assert.rejects(first.reconcile(review.id, { status: 'retry_experiment', verifiedNoExecution: false }), { code: 'invalid_experiment_result' });
  await first.reconcile(review.id, { status: 'retry_experiment', verifiedNoExecution: true });
  assert.equal(first.health().queued, 1); assert.equal(first.snapshot().reviews[0].status, 'queued_experiment'); assert.equal(first.snapshot().reviews[0].usage.totalTokens, 31);
  const saved = first.snapshot(); await first.close(); const restored = new LearningCoordinator({ ...config, state: saved }); await restored.tick();
  assert.equal(reflections, 1); assert.equal(executions, 2); assert.equal(restored.snapshot().reviews[0].id, review.id); assert.equal(restored.snapshot().seen.length, 1); await restored.close();
});

test('experiment retry refuses review-phase claims, revoked sources and incomplete frozen evidence', async () => {
  const first = new LearningCoordinator(options({ review: async () => ({ decision: decision() }), execute: async () => { throw new Error('Before dispatch'); } }));
  await first.ingest([episode()]); await assert.rejects(first.tick()); const state = first.snapshot(), id = state.reviews[0].id; await first.close();
  for (const mutate of [s => { s.reviews[0].interruptedPhase = 'reviewing'; }, s => { s.reviews[0].sourceRevoked = true; }, s => { s.episodes = []; }, s => { delete s.reviews[0].decision; }]) {
    const invalid = structuredClone(state); mutate(invalid); const coordinator = new LearningCoordinator(options({ state: invalid }));
    await assert.rejects(coordinator.reconcile(id, { status: 'retry_experiment', verifiedNoExecution: true })); assert.equal(coordinator.snapshot().reviews[0].status, 'interrupted'); await coordinator.close();
  }
});

test('backlog overflow and revision conflicts apply backpressure without silently losing unreviewed evidence', async () => {
  const coordinator = new LearningCoordinator(options({ policy: { maxPending: 1 } }));
  await coordinator.ingest([episode()]); const result = await coordinator.ingest([episode('e2'), episode('e1', { fingerprint: 'changed' }), episode()]);
  assert.deepEqual(result.deferred, [{ id: 'e2', reason: 'backlog_full' }, { id: 'e1', reason: 'episode_revision_conflict' }]); assert.deepEqual(result.duplicate, ['e1']); assert.equal(coordinator.snapshot().episodes.length, 1); await coordinator.close();
});

test('history archive finishes durably before dropping audit records; missing archive applies explicit backpressure', async () => {
  const archive = [], config = options({ policy: { minReviewMs: 0, maxReviews: 1 }, review: async ({ episodes }) => ({ decision: decision('no_change', episodes.map(row => row.id)) }) });
  const blocked = new LearningCoordinator(config); await blocked.ingest([episode()]); await blocked.tick(); await blocked.ingest([episode('e2')]); assert.equal((await blocked.tick()).status, 'history_full'); assert.equal(blocked.health().pending, 1);
  const coordinator = new LearningCoordinator({ ...config, state: blocked.snapshot(), archiveReviews: rows => archive.push(rows) }); await coordinator.tick();
  assert.equal(archive.length, 1); assert.equal(archive[0][0].status, 'no_change'); assert.equal(coordinator.snapshot().reviews.length, 1); assert.equal(coordinator.snapshot().seen.length, 2); await blocked.close(); await coordinator.close();
});

test('persistence failure prevents model dispatch and later polls cannot progress from undurable memory', async () => {
  let calls = 0, writes = 0;
  const coordinator = new LearningCoordinator(options({ saveState: () => { if (++writes >= 3) throw Object.assign(new Error('disk'), { code: 'storage_failure' }); }, review: async () => { calls++; return { decision: decision() }; } }));
  await coordinator.ingest([episode()]); await assert.rejects(coordinator.tick(), { code: 'storage_failure' }); await assert.rejects(coordinator.tick(), { code: 'storage_failure' }); assert.equal(calls, 0); assert.equal(coordinator.health().persistenceError, 'storage_failure'); await coordinator.close();
});

test('source revocation clears pending and completed review prose without removing version and billing receipts', async () => {
  const coordinator = new LearningCoordinator(options({ review: async () => ({ decision: decision() }), execute: async () => ({ status: 'ready', versionId: 'v1', summary: 'private candidate summary', usage: { totalTokens: 10 } }) }));
  await coordinator.ingest([episode()]); await coordinator.tick(); await coordinator.ingest([episode('e2')]); await coordinator.close();
  const original = coordinator.snapshot(), cleaned = revokeLearningSources(original, ['session:s1']);
  assert.equal(cleaned.episodes.length, 0); assert.equal(cleaned.reviews[0].decision, undefined); assert.equal(cleaned.reviews[0].result.summary, undefined); assert.equal(cleaned.reviews[0].result.versionId, 'v1'); assert.equal(cleaned.reviews[0].result.usage.totalTokens, 10); assert.equal(cleaned.seen.length, 1);
  assert.ok(!JSON.stringify(cleaned).includes('private candidate summary')); assert.ok(original.reviews[0].decision); assert.equal(original.episodes.length, 1);
});

test('an uncooperative timed-out provider blocks new reviews and close until its pending request actually settles', async () => {
  const entered = deferred(), release = deferred(); let calls = 0, now = 1000;
  const coordinator = new LearningCoordinator(options({ now: () => now, review: args => reflectProjectLearning({ ...args, model, timeoutMs: 10, provider: async function* () { calls++; entered.resolve(); await release.promise; yield { type: 'text_delta', delta: JSON.stringify(decision('no_change')) }; yield { type: 'done', stopReason: 'stop' }; } }) }));
  await coordinator.ingest([episode()]); const run = coordinator.tick(); await entered.promise; await assert.rejects(run, { code: 'total_timeout' });
  now = 999999; assert.equal((await coordinator.tick()).status, 'unsettled_operation'); assert.equal(calls, 1); assert.equal(coordinator.health().unsettledOperations, 1);
  let closed = false; const closing = coordinator.close().then(() => { closed = true; }); await Promise.resolve(); assert.equal(closed, false);
  release.resolve(); await closing; assert.equal(coordinator.health().unsettledOperations, 0); assert.equal(coordinator.snapshot().seen.length, 0);
});
