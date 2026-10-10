import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCacheUsage, usageRecord } from '../usage-cache-service.mjs';
import { checkUsageReport, recompute } from '../benchmark/usage-report-check.mjs';

// T1 equivalence check (benchmark/usage-report-check.mjs): the report's new numbers (the largest runs by tokens, the product / probe
// split of the JEV judgments) are recomputed from the ledger rows by a plain formula. The same check runs on a copy of the real
// ledger (see the script's header); here it runs on a fixture. The report weighs nothing by price, so neither does the check.
const now = Date.parse('2026-10-05T12:00:00Z');
const row = (minutesAgo, extra, usage) => usageRecord({ at: now - minutesAgo * 60000, providerId: 'zhipu', modelId: 'glm', ...extra, usage: { cacheUsageReported: true, output: 0, cacheRead: 0, cacheWrite: 0, ...usage } });
const fixture = () => [
  row(300, { purpose: 'background-work', projectId: 'p1', sessionId: 'daily' }, { input: 40000, cacheRead: 0, output: 900 }),
  ...Array.from({ length: 5 }, (_, index) => row(290 - index, { purpose: 'background-work', projectId: 'p1', sessionId: 'daily' }, { input: 800, cacheRead: 39000, output: 400 })),
  row(200, { purpose: 'background-work', projectId: 'p1', sessionId: 'fetch' }, { input: 30000, cacheRead: 5000, cacheWrite: 100, output: 300 }),
  row(100, { purpose: 'initiative', projectId: 'p1' }, { input: 20000, cacheRead: 15000, output: 2000 }),
  row(90, { purpose: 'compaction', projectId: 'p1', sessionId: 'talk' }, { input: 70000, output: 700 }),
  row(80, { purpose: 'jev', detail: 'probe' }, { input: 4000, output: 40 }), row(79, { purpose: 'jev' }, { input: 3000, output: 30 }),
  row(78, { purpose: 'jev', projectId: 'p1' }, { input: 200, output: 2 }), row(77, { purpose: 'jev', sessionId: 'talk' }, { input: 100, output: 1 }),
  row(76, { purpose: 'jev', detail: 'decision' }, { input: 50, output: 5 }), // a decision outside any project and session says so itself: the product's, not a probe
  row(60 * 30, { purpose: 'foreground', projectId: 'p1', sessionId: 'old' }, { input: 999999 }), // outside the 24h window
];

test('the report matches the plain recomputation from the ledger rows, and says what it checked', () => {
  const result = checkUsageReport(fixture(), { now });
  assert.deepEqual(result.checks.filter(check => !check.ok), []); assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map(check => check.name), ['tokens in total', 'requests per purpose', 'no price-weighted number', 'largest runs', 'no run beyond the limit', 'judge total unchanged', 'judge product', 'judge probe', 'product + probe = total']);
  assert.equal(result.summary.judge.probe.requests, 2); assert.equal(result.summary.judge.product.requests, 3, 'the scoped ones and the scope-less decision');
  assert.deepEqual(result.summary.runs.map(run => [run.sessionId, run.tokens]), [['daily', 40900 + 5 * 40200], ['talk', 70700], ['fetch', 35400]], 'ranked by tokens: daily 241,900, talk 70,700, fetch 35,400 (the cache reads of daily count as tokens, not as cost)');
  assert.equal('units' in result.summary, false, 'no cost in the summary');
  const plain = recompute(fixture(), { now });
  assert.equal(plain.skipped.estimated, 0); assert.equal(plain.runs[0].sessionId, 'daily');
});

test('the check fails when a number of the report is off', () => {
  const rows = fixture(), good = aggregateCacheUsage(rows, { now });
  const failing = report => checkUsageReport(rows, { now, report }).checks.filter(check => !check.ok).map(check => check.name);
  assert.deepEqual(failing(good), []);
  assert.deepEqual(failing({ ...good, runs: [good.runs[1], good.runs[0], ...good.runs.slice(2)] }), ['largest runs']);
  assert.deepEqual(failing({ ...good, runs: good.runs.map((run, index) => index ? run : { ...run, cacheRead: run.cacheRead - 1 }) }), ['largest runs']);
  assert.deepEqual(failing({ ...good, judge: { ...good.judge, product: { ...good.judge.product, requests: good.judge.product.requests + 1 } } }).slice(0, 2), ['judge product', 'product + probe = total']);
  assert.deepEqual(failing({ ...good, judge: { ...good.judge, product: { requests: good.judge.product.requests - 1, input: good.judge.product.input - 50, output: good.judge.product.output - 5 }, probe: { requests: good.judge.probe.requests + 1, input: good.judge.probe.input + 50, output: good.judge.probe.output + 5 } } }), ['judge product', 'judge probe'], 'a decision counted as a probe is caught');
  assert.deepEqual(failing({ ...good, overall: { ...good.overall, cacheRead: good.overall.cacheRead + 1 } }), ['tokens in total']);
  // A price-weighted number coming back into the report is itself a failure.
  assert.deepEqual(failing({ ...good, relative: { unit: 'uncached_input_token', total: { units: 1, assumedUnits: 1 } } }), ['no price-weighted number']);
  assert.deepEqual(failing({ ...good, runs: good.runs.map(run => ({ ...run, relative: { units: 1, assumedUnits: 1 } })) }), ['no price-weighted number']);
  // So is a list-price cost, in any bucket of the report (the cost the report carried before the 2026-10-05 decision).
  const cost = { status: 'priced', amounts: { USD: 1 }, pricedRequests: 1, partialRequests: 0, unpricedRequests: 0 };
  assert.deepEqual(failing({ ...good, overall: { ...good.overall, cost } }), ['no price-weighted number']);
  assert.deepEqual(failing({ ...good, overall: { ...good.overall, estimated: { ...good.overall.estimated, cost } } }), ['no price-weighted number']);
  assert.deepEqual(failing({ ...good, judge: { ...good.judge, cost } }), ['no price-weighted number']);
  assert.deepEqual(failing({ ...good, overall: { ...good.overall, misses: { count: 1, tokens: 9500, cost: { USD: 1 }, byReason: {} } } }), ['no price-weighted number']);
});

