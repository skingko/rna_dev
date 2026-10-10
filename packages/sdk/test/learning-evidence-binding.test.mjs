import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LearningCoordinator, reflectProjectLearning, validateLearningReflection, LEARNING_REFLECTION_CONTRACT_HASH } from '../src/learning.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 8192 };
const episode = (id, fingerprint = `private-fingerprint:${id}`) => ({ id, fingerprint, kind: 'tool_failure', summary: 'A real operation omitted a boundary check.', at: '2026-09-26T00:00:00Z', sourceIds: ['session:fixture'] });
const decision = (ids, patch = {}) => ({ outcome: 'no_change', reason: 'The observed fault has already been corrected.', evidenceIds: ids, diagnosis: 'No further reusable intervention is justified.', hypothesis: '', intervention: '', validationPlan: '', limitations: 'Only supplied experience was reviewed.', nextReviewAfterMs: 60000, ...patch });
const complete = async function* (value) { yield { type: 'text_delta', delta: JSON.stringify(value) }; yield { type: 'usage', usage: { input: 31, output: 19, totalTokens: 50 } }; yield { type: 'done', stopReason: 'stop' }; };
const run = (episodes, ids = ['e1'], extra = {}) => reflectProjectLearning({ episodes, model, provider: async function* () { yield* complete(decision(ids)); }, ...extra });
const expectedKeys = episodes => episodes.map(row => hash([row.id, row.fingerprint]));
const expectedBinding = episodes => hash(expectedKeys(episodes).map((key, index) => [`e${index + 1}`, key]));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('provider sees only batch-local IDs and returns canonical citations through two complete validation passes', async () => {
  const episodes = [episode('episode:long-canonical-one'), episode('episode:long-canonical-two'), episode('episode:long-canonical-three')], before = structuredClone(episodes), receipts = [];
  const result = await run(episodes, ['e3', 'e1'], { provider: async function* (request) {
    const input = JSON.parse(request.messages[0].content[0].text);
    assert.deepEqual(input.allowedEvidenceIds, ['e1', 'e2', 'e3']); assert.deepEqual(input.outputSchema.properties.evidenceIds.items.enum, input.allowedEvidenceIds);
    assert.deepEqual(input.episodes.map(row => row.id), input.allowedEvidenceIds);
    for (const row of input.episodes) assert.equal(row.fingerprint, undefined);
    for (const row of episodes) { assert.equal(JSON.stringify(input).includes(row.id), false); assert.equal(JSON.stringify(input).includes(row.fingerprint), false); }
    assert.match(request.systemPrompt, /assigned only for this request's ordered batch/);
    yield* complete(decision(['e3', 'e1']));
  }, requestControl: { onUsage: receipt => receipts.push(receipt) } });
  assert.deepEqual(result.decision.evidenceIds, [episodes[2].id, episodes[0].id]); assert.deepEqual(validateLearningReflection(result.decision, before), result.decision);
  assert.deepEqual(result.request.evidenceBatchKeys, expectedKeys(before)); assert.equal(result.request.evidenceBindingHash, expectedBinding(before));
  assert.deepEqual(receipts[0], result.request); assert.equal(result.usage.totalTokens, 50); assert.equal(result.request.completed, true); assert.deepEqual(episodes, before);
  for (const row of before) assert.equal(JSON.stringify(result.request).includes(row.id), false);
});

test('binding is deterministic, ordered and sensitive to canonical identity and fingerprint without invalidating the static prefix', async () => {
  const episodes = [episode('canonical:a'), episode('canonical:b')], calls = [];
  const provider = async function* (request) { calls.push(request); yield* complete(decision(['e1'])); };
  const original = await run(episodes, ['e1'], { provider }), identical = await run(structuredClone(episodes), ['e1'], { provider });
  assert.equal(original.request.evidenceBindingHash, identical.request.evidenceBindingHash);
  for (const batch of [[...episodes].reverse(), [episode('canonical:c'), episodes[1]], [{ ...episodes[0], fingerprint: 'changed' }, episodes[1]], [episodes[0]]]) {
    const changed = await run(batch, ['e1'], { provider });
    assert.notEqual(changed.request.evidenceBindingHash, original.request.evidenceBindingHash); assert.equal(changed.request.evidenceBindingHash, expectedBinding(batch));
  }
  assert.ok(calls.every(request => request.systemPrompt === calls[0].systemPrompt && request.cache.prefixHash === calls[0].cache.prefixHash));
  assert.equal(original.request.reflectionContractHash, LEARNING_REFLECTION_CONTRACT_HASH);
});

test('concurrent reflections with overlapping short references never share mappings', async () => {
  const gate = deferred(); let started = 0;
  const provider = async function* () { if (++started === 2) gate.resolve(); await gate.promise; yield* complete(decision(['e2'])); };
  const [left, right] = await Promise.all([run([episode('left:a'), episode('left:b')], ['e2'], { provider }), run([episode('right:a'), episode('right:b')], ['e2'], { provider })]);
  assert.deepEqual(left.decision.evidenceIds, ['left:b']); assert.deepEqual(right.decision.evidenceIds, ['right:b']); assert.notEqual(left.request.evidenceBindingHash, right.request.evidenceBindingHash);
});

test('canonical identities that look like aliases are interpreted solely by their position in this request', async () => {
  const episodes = [episode('e2'), episode('e1'), episode('e3')];
  const result = await run(episodes, ['e1', 'e2']);
  assert.deepEqual(result.decision.evidenceIds, ['e2', 'e1']); assert.equal(result.request.evidenceBindingHash, expectedBinding(episodes));
});

test('unknown, reconstructed, whitespace and duplicate citations reject the entire result with actual usage', async () => {
  const episodes = [episode('canonical:a'), episode('canonical:b')];
  for (const ids of [['canonical:a'], ['e1', 'canonical:b'], ['e3'], ['e01'], ['E1'], ['e1 '], [' e1'], ['e1', 'e1']]) {
    const receipts = []; let calls = 0;
    await assert.rejects(run(episodes, ids, { provider: async function* () { calls++; yield* complete(decision(ids)); }, requestControl: { onUsage: receipt => receipts.push(receipt) } }), error => {
      assert.equal(error.code, 'invalid_learning_reflection'); assert.equal(error.request.completed, false); assert.equal(error.usage.totalTokens, 50);
      assert.equal(error.validationDiagnostic.phase, ids[0] === ids[1] ? 'schema' : 'evidence'); assert.equal(error.request.evidenceBindingHash, expectedBinding(episodes)); return true;
    });
    assert.equal(calls, 1); assert.equal(receipts.length, 1); assert.equal(receipts[0].usage.totalTokens, 50);
  }
});

test('valid short references cannot bypass the rest of the reflection contract', async () => {
  for (const patch of [{ diagnosis: null }, { outcome: 'experiment', hypothesis: '', intervention: 'Check actual boundary.', validationPlan: 'Verify unchanged cases.' }, { nextReviewAfterMs: 0 }, { extra: 'not-allowed' }]) {
    await assert.rejects(run([episode('canonical:a')], ['e1'], { provider: async function* () { yield* complete(decision(['e1'], patch)); } }), { code: 'invalid_learning_reflection' });
  }
});

test('admission-time caller and receipt mutations cannot change the frozen evidence binding or provider source', async () => {
  const episodes = [episode('canonical:original')], before = structuredClone(episodes); let sent;
  const result = await run(episodes, ['e1'], { requestControl: {
    beforeRequest(receipt) { episodes[0].id = 'canonical:changed'; episodes[0].fingerprint = 'changed'; episodes[0].summary = 'MUTATED'; episodes[0].sourceIds.push('session:changed'); receipt.evidenceBatchKeys[0] = 'forged'; receipt.evidenceBindingHash = 'forged'; },
    onUsage(receipt) { receipt.evidenceBatchKeys[0] = 'forged-after-send'; }
  }, provider: async function* (request) { sent = JSON.parse(request.messages[0].content[0].text); yield* complete(decision(['e1'])); } });
  assert.deepEqual(result.decision.evidenceIds, [before[0].id]); assert.equal(sent.episodes[0].summary, before[0].summary); assert.deepEqual(sent.episodes[0].sourceIds, before[0].sourceIds);
  assert.deepEqual(result.request.evidenceBatchKeys, expectedKeys(before)); assert.equal(result.request.evidenceBindingHash, expectedBinding(before));
});

test('cancellation and usage settlement failure cannot publish a mapped decision or cause another request', async () => {
  const episodes = [episode('canonical:a')], controller = new AbortController(), receipts = []; let calls = 0;
  await assert.rejects(run(episodes, ['e1'], { signal: controller.signal, provider: async function* () {
    calls++; yield { type: 'text_delta', delta: JSON.stringify(decision(['e1'])) }; yield { type: 'usage', usage: { totalTokens: 27 } }; controller.abort(); yield { type: 'done', stopReason: 'stop' };
  }, requestControl: { onUsage: row => receipts.push(row) } }), error => error.name === 'AbortError' && error.request.completed === false && error.usage.totalTokens === 27);
  assert.equal(calls, 1); assert.equal(receipts[0].evidenceBindingHash, expectedBinding(episodes));
  await assert.rejects(run(episodes, ['e1'], { requestControl: { onUsage() { throw Object.assign(new Error('Receipt write failed.'), { code: 'storage_failed' }); } } }), error => error.code === 'storage_failed' && error.usage.totalTokens === 50 && error.request.evidenceBindingHash === expectedBinding(episodes));
});

test('partial selection persists canonical decisions and a full hash-only batch after consumption and restart', async () => {
  const episodes = [episode('canonical:a'), episode('canonical:b'), episode('canonical:c')]; let saved;
  const review = input => reflectProjectLearning({ ...input, model, provider: async function* () { yield* complete(decision(['e2'])); } });
  const c = new LearningCoordinator({ policy: { minReviewMs: 0 }, saveState: value => { saved = value; }, review, execute: () => assert.fail('No-change never executes an experiment') });
  await c.ingest(episodes); assert.equal((await c.tick()).status, 'no_change');
  const record = c.snapshot().reviews[0];
  assert.deepEqual(record.decision.evidenceIds, ['canonical:b']); assert.deepEqual(record.episodeKeys, [expectedKeys(episodes)[1]]);
  assert.deepEqual(record.request.evidenceBatchKeys, expectedKeys(episodes)); assert.equal(record.request.evidenceBindingHash, hash(record.request.evidenceBatchKeys.map((key, i) => [`e${i + 1}`, key])));
  assert.deepEqual(c.snapshot().episodes.map(row => row.id), ['canonical:a', 'canonical:c']); await c.close();
  const restored = new LearningCoordinator({ state: saved, review, execute: () => assert.fail('No experiment') });
  assert.deepEqual(restored.snapshot().reviews[0], record); await restored.close();
});

test('legacy prior reviews remain usable audit context without granting their old IDs or prior aliases', async () => {
  const prior = [{ id: 'legacy-review', status: 'no_change', decision: decision(['old-canonical-citation']), request: { id: 'legacy-request', usage: { totalTokens: 2 } } }, { id: 'alias-era-review', status: 'failed', error: { validationDiagnostic: { phase: 'evidence', path: '$.evidenceIds', rule: 'unknown_evidence', unknownCount: 1, allowedCount: 8 } } }], original = structuredClone(prior);
  const result = await run([episode('new-canonical')], ['e1'], { priorReviews: prior, provider: async function* (request) {
    const input = JSON.parse(request.messages[0].content[0].text);
    assert.equal(input.priorReviews[0].decision.evidenceIds, undefined); assert.equal(JSON.stringify(input).includes('old-canonical-citation'), false);
    assert.deepEqual(input.allowedEvidenceIds, ['e1']); assert.equal(input.priorReviews[1].validationFailure.allowedCount, 8);
    yield* complete(decision(['e1']));
  } });
  assert.deepEqual(result.decision.evidenceIds, ['new-canonical']); assert.deepEqual(prior, original);
  await assert.rejects(run([episode('new-canonical')], ['e8'], { priorReviews: prior }), error => error.validationDiagnostic.phase === 'evidence' && error.validationDiagnostic.allowedCount === 1);
});

test('an interrupted review never restores a short-reference result into a new batch', async () => {
  const episodes = [episode('canonical:interrupted')], entered = deferred(), release = deferred(); let saved, calls = 0;
  const c = new LearningCoordinator({ saveState: value => { saved = value; }, review: input => reflectProjectLearning({ ...input, model, provider: async function* () { calls++; entered.resolve(); await release.promise; yield* complete(decision(['e1'])); } }), execute: () => assert.fail('No experiment') });
  await c.ingest(episodes); const active = c.tick(); await entered.promise; const frozen = structuredClone(saved);
  const restored = new LearningCoordinator({ state: frozen, review: () => assert.fail('Interrupted reflection does not resume itself'), execute: () => assert.fail('No experiment') });
  assert.equal((await restored.tick()).status, 'interrupted'); assert.equal(restored.snapshot().reviews[0].decision, undefined);
  c.invalidate(); release.resolve(); await assert.rejects(active); assert.equal(c.snapshot().reviews[0].decision, undefined); assert.equal(calls, 1);
  await c.close(); await restored.close();
});
