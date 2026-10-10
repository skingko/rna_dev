import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLedger, aggregateCacheUsage, usageRecord, meteredProvider } from '../usage-cache-service.mjs';

// spec p1 effort §3.6/§3.7: aborted and unreported requests leave an estimated receipt; rows carry the purpose detail,
// the effort sent, reasoning tokens, the stop reason and the output allowance; the aggregation reads them.
test('an aborted unreported request is recorded with its estimate; a cancelled-before-sending or local refusal is not', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-usage-effort-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json.usage-cache.jsonl'), ledger = new UsageLedger({ file });
  const streaming = async function* (request) {
    yield { type: 'thinking_delta', delta: 'y'.repeat(300) }; yield { type: 'text_delta', delta: 'x'.repeat(30) };
    request.signal.throwIfAborted();
    await new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
  };
  const provider = meteredProvider(streaming, { ledger, purpose: 'initiative', projectId: 'p1' });
  const controller = new AbortController();
  const run = (async () => { for await (const event of provider({ model: { providerId: 'glm', modelId: 'glm-5.3', reasoning: 'low', maxOutputTokens: 32768 }, signal: controller.signal, estimatedInputTokens: 4200, purposeDetail: 'decision', systemPrompt: 's', messages: [] })) if (event.type === 'text_delta') controller.abort(); })();
  await assert.rejects(run);
  const row = ledger.rows.at(-1);
  assert.deepEqual({ purpose: row.purpose, input: row.input, output: row.output, cacheReported: row.cacheReported, estimated: row.estimated, aborted: row.aborted, responded: row.responded, detail: row.detail, reasoning: row.reasoning, outputCap: row.outputCap },
    { purpose: 'initiative', input: 4200, output: 110, cacheReported: false, estimated: true, aborted: true, responded: undefined, detail: 'decision', reasoning: 'low', outputCap: 32768 });
  // Aborted after it was handed over but before its first byte: recorded, flagged responded:false, input from the request bytes.
  const silent = meteredProvider(async function* (request) { await new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })); yield* []; }, { ledger, purpose: 'background-work' });
  const early = new AbortController(), pending = (async () => { for await (const _ of silent({ model: { providerId: 'glm', modelId: 'glm-5.3' }, signal: early.signal, systemPrompt: 'system '.repeat(30), messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })) {} })();
  await new Promise(resolve => setImmediate(resolve)); early.abort(); await assert.rejects(pending);
  const quiet = ledger.rows.at(-1);
  assert.equal(quiet.responded, false); assert.equal(quiet.estimated, true); assert.ok(quiet.input > 50); assert.equal(quiet.output, 0);
  // Never sent (cancelled before the call) and a local refusal (neither answered nor cancelled): nothing recorded.
  const before = ledger.rows.length, cancelled = new AbortController(); cancelled.abort();
  await assert.rejects((async () => { for await (const _ of meteredProvider(async function* (request) { request.signal.throwIfAborted(); yield* []; }, { ledger, purpose: 'mind' })({ model: {}, signal: cancelled.signal })) {} })());
  await assert.rejects((async () => { for await (const _ of meteredProvider(async function* () { throw Object.assign(new Error('bad'), { code: 'configuration' }); }, { ledger, purpose: 'mind' })({ model: {} })) {} })());
  assert.equal(ledger.rows.length, before);
  // The new fields persist and reload; old rows without them stay readable.
  const reloaded = new UsageLedger({ file }).rows;
  assert.equal(reloaded.find(item => item.aborted)?.detail, 'decision');
});

test('a completed request records its stop reason, the effort sent, reasoning tokens and the raw purpose as detail', async () => {
  const ledger = new UsageLedger({});
  const base = async function* () { yield { type: 'text_delta', delta: '{}' }; yield { type: 'usage', usage: { input: 900, output: 2048, cacheRead: 100, cacheWrite: 0, totalTokens: 3048, reasoningTokens: 1900, cacheUsageReported: true } }; yield { type: 'done', stopReason: 'length' }; };
  for await (const _ of meteredProvider(base, { ledger, purpose: 'gene-author', projectId: 'p1' })({ model: { providerId: 'glm', modelId: 'glm-5.3', reasoning: 'low', maxOutputTokens: 2400 }, maxOutputTokens: 2400 })) {}
  const row = ledger.rows.at(-1);
  assert.deepEqual({ purpose: row.purpose, detail: row.detail, reasoning: row.reasoning, reasoningTokens: row.reasoningTokens, stopReason: row.stopReason, outputCap: row.outputCap, estimated: row.estimated }, { purpose: 'evolution', detail: 'gene-author', reasoning: 'low', reasoningTokens: 1900, stopReason: 'length', outputCap: 2400, estimated: undefined });
  assert.equal(usageRecord({ purpose: 'session-suggestions' }).purpose, 'mind'); assert.equal(usageRecord({ purpose: 'session-suggestions' }).detail, 'session-suggestions');
  assert.equal(usageRecord({ purpose: 'narrator', reasoning: 'turbo', stopReason: 'weird' }).reasoning, undefined, 'unknown values are dropped');
});

test('aggregation adds output, reasoning tokens, truncations, estimated rows (outside the hit rate) and a split by effort', () => {
  const now = Date.parse('2026-10-04T12:00:00Z'), at = minutes => now - minutes * 60000;
  const rows = [
    usageRecord({ at: at(5), purpose: 'initiative', usage: { input: 100, cacheRead: 900, cacheWrite: 0, output: 400, reasoningTokens: 350, cacheUsageReported: true }, reasoning: 'low', stopReason: 'stop' }),
    usageRecord({ at: at(4), purpose: 'initiative', usage: { input: 200, cacheRead: 800, cacheWrite: 0, output: 32768, cacheUsageReported: true }, reasoning: 'max', stopReason: 'length' }),
    usageRecord({ at: at(3), purpose: 'initiative', usage: { input: 4000, output: 50, cacheRead: 0, cacheWrite: 0, cacheUsageReported: false }, reasoning: 'max', estimated: true, aborted: true }),
  ];
  const bucket = aggregateCacheUsage(rows, { window: '1h', now }).byPurpose.initiative;
  assert.equal(bucket.output, 400 + 32768 + 50); assert.equal(bucket.reasoningTokens, 350); assert.equal(bucket.lengthStops, 1);
  assert.deepEqual(bucket.estimated, { requests: 1, input: 4000, output: 50 });
  assert.equal(bucket.hitRate, 1700 / 2000, 'the estimated row stays out of the hit rate');
  // ACC-4: the estimated row's input is kept apart from the reported input of its effort.
  assert.deepEqual(bucket.byReasoning, { low: { requests: 1, input: 100, cacheRead: 900, output: 400, reasoningTokens: 350, estimatedInput: 0 }, max: { requests: 2, input: 200, cacheRead: 800, output: 32818, reasoningTokens: 0, estimatedInput: 4000 } });
});
