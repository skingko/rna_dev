import test from 'node:test';
import assert from 'node:assert/strict';
import { settleBreakEven, cachePriceShares, requestsPerRun, growthPerRun, validCachePrices } from '../src/cache-economics.mjs';

// Plan C5: the share of the context an edit to a warm prefix cache must free is computed, not fixed. Editing earlier
// history makes the next request pay the uncached rate (the write rate where the provider bills one) for everything after
// the edit instead of the read rate; the tokens it removes are then read at the read rate by the requests that follow.
// With r the cache-read and w the cache-write rate (the input rate when there is no write price), the edit wins when the
// share f/C of the context it frees exceeds (w − r) / (w + (N − 1) · r) over N requests.
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} ${actual} vs ${expected}`);

test('the break-even share, from the prices: the closed form and its limits', () => {
  // GLM-5.3 list: 8 uncached, 2 cache hit (CNY per million), no write price.
  const glm = { input: 8, cacheRead: 2 };
  close(settleBreakEven({ prices: glm, requests: 1 }).share, 0.75, 'one request: a warm edit pays only when it frees 1 − r/w of the context');
  close(settleBreakEven({ prices: glm, requests: 2 }).share, 0.75 / 1.25);
  close(settleBreakEven({ prices: glm, requests: 27 }).share, 0.75 / (1 + 26 * 0.25), '27 requests per run (the novel)');
  // Anthropic: a write costs 1.25x, a read 0.1x.
  const sonnet = { input: 2, cacheRead: 0.2, cacheWrite: 2.5 };
  close(settleBreakEven({ prices: sonnet, requests: 27 }).share, (1.25 - 0.1) / (1.25 + 26 * 0.1));
  assert.deepEqual(cachePriceShares(sonnet), { read: 0.1, write: 1.25 });
  // The share is the answer, the inputs ride along.
  assert.deepEqual(settleBreakEven({ prices: sonnet, requests: 27 }), { share: (1.25 - 0.1) / (1.25 + 26 * 0.1), read: 0.1, write: 1.25, requests: 27 });
  // A read no cheaper than a write: any saving pays. A free read: the saving is worth nothing per request, the share tends to 1 - never above it.
  assert.equal(settleBreakEven({ prices: { input: 1, cacheRead: 1 }, requests: 5 }).share, 0);
  assert.equal(settleBreakEven({ prices: { input: 1, cacheRead: 1.5 }, requests: 5 }).share, 0);
  assert.equal(settleBreakEven({ prices: { input: 1, cacheRead: 0 }, requests: 1000 }).share, 1);
  // Fewer than one request counts as one; a non-number too.
  assert.equal(settleBreakEven({ prices: glm, requests: 0 }).requests, 1); assert.equal(settleBreakEven({ prices: glm, requests: Number.NaN }).requests, 1);
  assert.equal(settleBreakEven({ prices: glm }).requests, 1);
});

test('the share falls as more requests read the saving and rises as reads get cheaper', () => {
  const shareAt = (cacheRead, requests) => settleBreakEven({ prices: { input: 1, cacheRead }, requests }).share;
  for (const cacheRead of [0.03, 0.1, 0.25, 0.5]) { let previous = Infinity; for (const requests of [1, 2, 5, 10, 27, 100]) { const share = shareAt(cacheRead, requests); assert.ok(share < previous, `${cacheRead} at ${requests}`); previous = share; } }
  for (const requests of [2, 27]) { let previous = -Infinity; for (const cacheRead of [0.5, 0.25, 0.1, 0.03]) { const share = shareAt(cacheRead, requests); assert.ok(share > previous, `${requests} at ${cacheRead}`); previous = share; } }
});

test('no usable price, no break-even: the caller leaves a warm cache alone', () => {
  for (const prices of [undefined, null, {}, { input: 0, cacheRead: 1 }, { input: -1, cacheRead: 0 }, { input: 1 }, { input: 1, cacheRead: -1 }, { input: 1, cacheRead: 0.1, cacheWrite: 0 }, { input: Infinity, cacheRead: 1 }, 'cheap']) {
    assert.equal(settleBreakEven({ prices, requests: 10 }), null, JSON.stringify(prices)); assert.equal(cachePriceShares(prices), null); assert.equal(validCachePrices(prices), false);
  }
  assert.equal(settleBreakEven(), null);
  assert.equal(validCachePrices({ input: 1, cacheRead: 0 }), true); assert.equal(validCachePrices({ input: 1, cacheRead: 0.1, cacheWrite: null }), true);
});

// A conversation's own requests per run: the assistant messages between two user turn starts, over the answered turns.
const user = (id, source = 'user') => ({ id, role: 'user', source, content: [{ type: 'text', text: id }] });
const answer = id => ({ id, role: 'assistant', content: [{ type: 'text', text: id }] });
const tool = id => ({ id, role: 'toolResult', content: [{ type: 'text', text: id }] });
const turn = (name, answers) => [user(`u-${name}`), ...Array.from({ length: answers }, (_, index) => [answer(`a-${name}-${index}`), tool(`t-${name}-${index}`)]).flat()];

test('requests per run: the median over answered turns, the present work first, 1 with no history', () => {
  assert.equal(requestsPerRun([]), 1);
  assert.equal(requestsPerRun(turn('only-question', 0)), 1, 'a turn with no answer yet is not a sample');
  assert.equal(requestsPerRun([...turn('a', 2), ...turn('b', 4), ...turn('c', 30)]), 4, 'the median, not the mean (a runaway turn does not move it)');
  assert.equal(requestsPerRun([...turn('a', 2), ...turn('b', 4), ...turn('c', 6), ...turn('d', 8)]), 5, 'even count: the middle two');
  // The run about to start has its user message and no answer: it is not counted.
  assert.equal(requestsPerRun([...turn('a', 3), ...turn('b', 3), user('u-next')]), 3);
  // Context copies, steering and the like are not turn starts.
  const copies = [user('ctx', 'context'), answer('x')];
  assert.equal(requestsPerRun([user('u1'), ...copies, answer('y'), user('steer', 'steer'), answer('z')]), 3, 'one turn: the context and steer messages do not split it');
  // After a compaction boundary only the turns after it describe the present work; with none after it, all of them.
  const old = [...turn('old1', 40), ...turn('old2', 50)], boundary = old.at(-1).id, recent = [...turn('new1', 3), ...turn('new2', 5)];
  assert.equal(requestsPerRun([...old, ...recent], { throughMessageId: boundary }), 4);
  assert.equal(requestsPerRun(old, { throughMessageId: boundary }), 45, 'nothing after the boundary yet: every answered turn');
  assert.equal(requestsPerRun([...turn('a', 2), ...turn('b', 4), ...turn('c', 6)], { throughMessageId: 'missing' }), 4, 'an unknown boundary counts every turn');
});

// What one more run adds to the context, measured on the conversation's own turns (review of C5, finding 3): the margin the
// deferred compaction's economies must leave under the trigger. The byte estimate of a turn's messages, the median.
const sized = (name, chars, answers = 1) => [{ ...user(`u-${name}`), content: [{ type: 'text', text: 'q'.repeat(chars) }] }, ...Array.from({ length: answers }, (_, index) => [{ ...answer(`a-${name}-${index}`), content: [{ type: 'text', text: 'a'.repeat(chars) }] }, tool(`t-${name}-${index}`)]).flat()];
const near = (actual, tokens, message) => assert.ok(actual >= tokens && actual <= tokens + 100, `${message}: ${actual} tokens, expected about ${tokens}`);

test('growth per run: the median over answered turns of what a turn adds, the present work first, 0 with no history', () => {
  assert.equal(growthPerRun([]), 0); assert.equal(growthPerRun(), 0);
  assert.equal(growthPerRun([user('u-only')]), 0, 'a turn with no answer yet is not a sample');
  // Each turn adds its request and its answer: 2 x chars / 3 tokens.
  near(growthPerRun([...sized('a', 3000), ...sized('b', 3000), ...sized('c', 3000)]), 2000, 'three turns of 3000 characters each way');
  near(growthPerRun([...sized('a', 300), ...sized('b', 900), ...sized('c', 90000)]), 600, 'the median, not the mean: a runaway turn does not move it');
  near(growthPerRun([...sized('a', 300), ...sized('b', 900), ...sized('c', 1500), ...sized('d', 90000)]), 800, 'even count: the middle two');
  // A turn grows with the requests it makes.
  assert.ok(growthPerRun([...sized('a', 900, 6), ...sized('b', 900, 6)]) > 3 * growthPerRun([...sized('a', 900, 1), ...sized('b', 900, 1)]));
  // The run about to start has its request and no answer: not a sample. Steering and context copies do not split a turn.
  near(growthPerRun([...sized('a', 3000), ...sized('b', 3000), user('u-next')]), 2000, 'the unanswered request');
  const steered = [...sized('a', 3000), { ...user('steer', 'steer'), content: [{ type: 'text', text: 'q'.repeat(3000) }] }, answer('x')];
  near(growthPerRun(steered), 2000 + 1000, 'one turn: the steer message is part of it');
  // After a compaction boundary only the turns after it describe the present work; with none after it, all of them.
  const old = [...sized('old1', 90000), ...sized('old2', 90000)], boundary = old.at(-1).id, recent = [...sized('new1', 900), ...sized('new2', 900)];
  near(growthPerRun([...old, ...recent], { throughMessageId: boundary }), 600, 'only the turns after the boundary');
  assert.ok(growthPerRun(old, { throughMessageId: boundary }) > 50000, 'nothing after the boundary yet: every answered turn');
  assert.equal(growthPerRun([...sized('a', 900), ...sized('b', 900), ...sized('c', 900)], { throughMessageId: 'missing' }), growthPerRun([...sized('a', 900), ...sized('b', 900), ...sized('c', 900)]), 'an unknown boundary counts every turn');
});
