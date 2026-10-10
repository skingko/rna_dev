import test from 'node:test';
import assert from 'node:assert/strict';
import { LearningCoordinator, reflectProjectLearning, LEARNING_REFLECTION_CONTRACT_HASH } from '../src/learning.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 8192 };
const episode = id => ({ id, fingerprint: `fingerprint:${id}`, kind: 'tool_failure', summary: 'A real operation failed at a boundary', at: '2026-09-26T00:00:00Z' });
const decision = ids => ({ outcome: 'no_change', reason: 'Existing instructions already address this correction', evidenceIds: ids, diagnosis: 'No reusable change is supported by this batch', hypothesis: '', intervention: '', validationPlan: '', limitations: 'No general quality claim', nextReviewAfterMs: 60000 });
const stream = value => async function* () { yield { type: 'text_delta', delta: JSON.stringify(value) }; yield { type: 'usage', usage: { input: 100, output: 300, totalTokens: 400 } }; yield { type: 'done', stopReason: 'stop' }; };

test('short-reference enum stays stable across equal-sized batches while canonical evidence remains local', async () => {
  const requests = [];
  for (const id of ['episode:a', 'episode:b']) await reflectProjectLearning({ model, episodes: [episode(id)], priorReviews: [{ id: 'older-review', status: 'no_change', decision: decision(['past-evidence-not-allowed']), result: { status: 'no_change' } }], provider: async function* (request) {
    requests.push(request); const input = JSON.parse(request.messages[0].content[0].text);
    assert.deepEqual(input.outputSchema.properties.evidenceIds.items.enum, ['e1']);
    assert.deepEqual(input.allowedEvidenceIds, ['e1']); assert.equal(input.priorReviews[0].decision.evidenceIds, undefined);
    assert.equal(input.episodes[0].id, 'e1'); assert.equal(input.episodes[0].fingerprint, undefined);
    assert.equal(JSON.stringify(input).includes(id), false);
    assert.equal(JSON.stringify(input).includes('past-evidence-not-allowed'), false);
    yield* stream(decision(['e1']))();
  } });
  assert.equal(requests[0].systemPrompt, requests[1].systemPrompt); assert.equal(requests[0].cache.prefixHash, requests[1].cache.prefixHash);
});

test('a mistyped citation rejects the whole decision and the next bounded review sees safe feedback', async () => {
  let now = 0, calls = 0, executions = 0, persisted;
  const inputs = [], receipts = [], id = 'turn:abcdefghijklmnopqrstuvwxy0123456789';
  const wrong = id.replace('x', 'z');
  const c = new LearningCoordinator({ now: () => now, policy: { minReviewMs: 0, retryAfterMs: 1000 }, saveState: snapshot => { persisted = snapshot; }, execute: () => { executions++; }, review: input => reflectProjectLearning({ ...input, model, requestControl: { onUsage: receipt => receipts.push(receipt) }, provider: async function* (request) {
    inputs.push(JSON.parse(request.messages[0].content[0].text)); calls++;
    yield* stream(decision([calls === 1 ? wrong : 'e1']))();
  } }) });
  await c.ingest([episode(id)]);
  await assert.rejects(c.tick(), error => error.code === 'invalid_learning_reflection' && error.validationDiagnostic.phase === 'evidence');
  assert.equal(c.health().seen, 0); assert.equal(executions, 0);
  const rejected = structuredClone(persisted.reviews[0]);
  assert.deepEqual(rejected.error.validationDiagnostic, { phase: 'evidence', path: '$.evidenceIds', rule: 'unknown_evidence', unknownCount: 1, allowedCount: 1 });
  assert.deepEqual(rejected.request.validationDiagnostic, rejected.error.validationDiagnostic);
  assert.equal(rejected.request.reflectionContractHash, LEARNING_REFLECTION_CONTRACT_HASH);
  assert.equal(JSON.stringify(rejected).includes(wrong), false); assert.equal(rejected.usage.totalTokens, 400);
  now = 10000;
  assert.equal((await c.tick()).status, 'no_change');
  assert.deepEqual(inputs[1].priorReviews[0].validationFailure, rejected.error.validationDiagnostic);
  assert.deepEqual(persisted.reviews[0], rejected); assert.equal(c.health().seen, 1);
  assert.deepEqual(persisted.reviews[1].decision.evidenceIds, [id]);
  assert.equal(calls, 2); assert.equal(receipts.reduce((sum, row) => sum + row.usage.totalTokens, 0), 800);
  assert.equal(executions, 0); await c.close();
});

test('untrusted prior error properties cannot become model instructions through feedback', async () => {
  const secret = 'private-source-do-not-repeat';
  await reflectProjectLearning({ model, episodes: [episode('e1')], priorReviews: [{ id: 'failed', status: 'failed', error: { code: 'invalid_learning_reflection', message: secret, validationDiagnostic: { phase: 'evidence', path: '$.evidenceIds', rule: 'unknown_evidence', unknownCount: 1, allowedCount: 1, output: secret, unknownId: secret } } }], provider: async function* (request) {
    const input = JSON.parse(request.messages[0].content[0].text);
    assert.equal(JSON.stringify(input).includes(secret), false);
    assert.deepEqual(input.priorReviews[0].validationFailure, { phase: 'evidence', path: '$.evidenceIds', rule: 'unknown_evidence', unknownCount: 1, allowedCount: 1 });
    yield* stream(decision(['e1']))();
  } });
});

test('parse, schema and experiment diagnostics persist without raw provider text', async () => {
  const secret = 'private-source-do-not-repeat';
  for (const [value, phase] of [[secret, 'parse'], [{ ...decision(['e1']), [secret]: true }, 'schema'], [{ ...decision(['e1']), outcome: 'experiment', hypothesis: ' ' }, 'experiment']]) {
    const receipts = [];
    await assert.rejects(reflectProjectLearning({ model, episodes: [episode('e1')], requestControl: { onUsage: r => receipts.push(r) }, provider: async function* () {
      yield { type: 'text_delta', delta: typeof value === 'string' ? value : JSON.stringify(value) };
      yield { type: 'usage', usage: { totalTokens: 400 } }; yield { type: 'done', stopReason: 'stop' };
    } }), e => e.code === 'invalid_learning_reflection' && e.request.validationDiagnostic.phase === phase);
    assert.equal(receipts[0].completed, false); assert.equal(JSON.stringify(receipts).includes(secret), false);
  }
});
