import test from 'node:test';
import assert from 'node:assert/strict';
import { survivalFromSamples, survivalSample, structuralContinuity, requestContinuity, historyEditsAllowed, historyImagesSignature, SURVIVAL_MAX_AGE_MS } from '../src/cache-survival.mjs';

// Spec p1 compaction §A3: the learned cold gap is the smallest cold gap above the largest warm gap (live GLM:
// warm up to 107 min, cold from 137 min; provider-side evictions at 25.7 and 38.1 min never lower it).
const now = Date.parse('2026-10-04T12:00:00Z'), min = 60000;
const sample = (gapMin, warm, { prompt = 400000, ageDays = 1 } = {}) => ({ gapMs: Math.round(gapMin * min), warm, prompt, at: now - ageDays * 86400000 });

test('warm maximum and the smallest cold gap above it; evictions below the warm range never lower it', () => {
  const samples = [sample(2, true), sample(14, true), sample(60.4, true), sample(107.1, true), sample(25.7, false), sample(38.1, false), sample(137.3, false), sample(194, false), sample(857.8, false)];
  assert.deepEqual(survivalFromSamples(samples, { now }), { coldAfterMs: Math.round(137.3 * min), warmMaxMs: Math.round(107.1 * min), samples: 9 });
});

test('no cold sample above the warm range, or no warm sample at all, gives no estimate', () => {
  assert.equal(survivalFromSamples([sample(30, true), sample(5, false)], { now }).coldAfterMs, null);
  assert.equal(survivalFromSamples([sample(200, false), sample(300, false)], { now }).coldAfterMs, null, 'cold samples alone say nothing about when the cache was still warm');
  assert.deepEqual(survivalFromSamples([], { now }), { coldAfterMs: null, warmMaxMs: null, samples: 0 });
});

test('cold samples below the smallest warm prompt are dropped (under the provider minimum cacheable size)', () => {
  const samples = [sample(5, true, { prompt: 20000 }), sample(90, true, { prompt: 30000 }), sample(100, false, { prompt: 800 }), sample(150, false, { prompt: 25000 })];
  assert.equal(survivalFromSamples(samples, { now }).coldAfterMs, 150 * min);
});

test('samples age out after 30 days', () => {
  const samples = [sample(10, true), sample(140, false, { ageDays: 31 }), sample(400, false)];
  assert.equal(survivalFromSamples(samples, { now }).coldAfterMs, 400 * min);
  assert.equal(survivalFromSamples(samples, { now, maxAgeMs: SURVIVAL_MAX_AGE_MS * 2 }).coldAfterMs, 140 * min);
});

test('a sample needs a continuous request, reported cache usage and a gap of at least a minute; warm is half the previous prompt', () => {
  const continuity = { continuous: true, gapMs: 5 * min, previousPromptTokens: 100000 }, at = new Date(now).toISOString();
  assert.deepEqual(survivalSample({ continuity, cacheReported: true, cacheRead: 50000, at }), { gapMs: 5 * min, warm: true, prompt: 100000, at: now });
  assert.equal(survivalSample({ continuity, cacheReported: true, cacheRead: 49999, at }).warm, false);
  assert.equal(survivalSample({ continuity: { ...continuity, continuous: false }, cacheReported: true, cacheRead: 0, at }), null);
  assert.equal(survivalSample({ continuity, cacheReported: false, cacheRead: 0, at }), null);
  assert.equal(survivalSample({ continuity: { ...continuity, gapMs: 59999 }, cacheReported: true, cacheRead: 0, at }), null);
  assert.equal(survivalSample({ continuity: null, cacheReported: true, cacheRead: 0, at }), null);
});

test('structural continuity compares prefix, model, provider, compaction, edit sequence, image offload and history images', () => {
  const base = { contextPrefixHash: 'p', model: 'm', provider: 'x', contextCompactionId: null, contextForgetSeq: 2, contextImageOffloadId: null, timestamp: now - 10 * min, usage: { input: 10, cacheRead: 90, cacheWrite: 0, output: 5 } };
  assert.equal(structuralContinuity(base, { ...base }), true);
  for (const change of [{ contextPrefixHash: 'q' }, { model: 'n' }, { provider: 'y' }, { contextCompactionId: 'c' }, { contextForgetSeq: 3 }, { contextImageOffloadId: 'o' }, { contextHistoryImages: 'h' }]) assert.equal(structuralContinuity(base, { ...base, ...change }), false, JSON.stringify(change));
  assert.equal(structuralContinuity({ ...base, contextPrefixHash: undefined }, base), false);
  assert.deepEqual(requestContinuity(base, { ...base, timestamp: now }), { continuous: true, gapMs: 10 * min, previousPromptTokens: 100 });
  assert.equal(requestContinuity(null, base), null);
});

test('history editing is allowed unless the model or provider declares an append-only path', () => {
  assert.equal(historyEditsAllowed({ protocol: 'openai' }), true);
  assert.equal(historyEditsAllowed({ protocol: 'anthropic' }), true, 'absent flags mean editing is allowed');
  for (const model of [{ appendOnly: true }, { historyEditing: 'none' }, { compat: { appendOnly: true } }, { capabilities: { historyEditing: 'none' } }]) assert.equal(historyEditsAllowed(model), false, JSON.stringify(model));
  const provider = async function* () {}; provider.appendOnly = true;
  assert.equal(historyEditsAllowed({}, provider), false);
  assert.equal(historyImagesSignature(new Map()), null);
  assert.equal(historyImagesSignature(new Map([['a', new Map([[0, { reason: 'history' }]])]])), historyImagesSignature(new Map([['a', new Map([[0, { reason: 'history' }]])]])));
});
