import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionPerformance, formatDecisionStatus } from '../decision-observability.mjs';
test('latency metrics exclude cache/legacy receipts and keep unknown billing explicit', () => {
  const shared = { point: 'chat.preflight', mode: 'shadow', source: 'fallback', reason: 'shadow', execution: { latencyClass: 'parallel' } };
  const data = decisionPerformance([
    { ...shared, networkAttempted: true, latencyMs: 400, usage: { inputTokens: 10, outputTokens: 0 } },
    { ...shared, networkAttempted: true, latencyMs: 100, usage: {} },
    { ...shared, networkAttempted: false, cached: true, latencyMs: 1, usage: {} },
    { ...shared, latencyMs: 9000, usage: { inputTokens: 999, outputTokens: 9 } },
  ]);
  const [row] = data.groups;
  assert.equal(row.measuredRequests, 2); assert.equal(row.p50Ms, 100); assert.equal(row.p95Ms, 400);
  assert.equal(row.reportedTokens, 10); assert.equal(row.unknownUsageRequests, 1); assert.equal(row.legacyUnmeasured, 1);
  assert.equal(row.fallback, 0); assert.equal(data.comparison, 'not_controlled');
  assert.match(formatDecisionStatus({ mode: 'shadow', performance: data }), /不能据此推算节省/);
});
test('no samples produce no false zero latency or accuracy', () => { assert.deepEqual(decisionPerformance().groups, []); assert.match(formatDecisionStatus(), /未知/); });
