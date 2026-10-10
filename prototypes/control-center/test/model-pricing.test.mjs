import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_PRICES, modelPrice, requestCost, sumCosts, priceResolver } from '../model-pricing.mjs';
import { providerPresets } from '../provider-presets.mjs';
import { UsageLedger, aggregateCacheUsage, meteredProvider, cacheTtlMs, usageRecord } from '../usage-cache-service.mjs';

const provider = (id, extra = {}) => { const preset = providerPresets().find(row => row.id === id); return { id: `configured-${id}`, protocol: preset.protocol, baseUrl: preset.baseUrl, models: preset.models, ...extra }; };

test('every price entry names a preset model, an official source and a check date; unknown rates stay null', () => {
  const presets = new Map(providerPresets().map(row => [row.id, new Set(row.models.map(model => model.id))]));
  for (const [presetId, models] of Object.entries(MODEL_PRICES)) for (const [modelId, entry] of Object.entries(models)) {
    assert.ok(presets.get(presetId)?.has(modelId), `${presetId}/${modelId} is a preset model`);
    assert.match(entry.source.url, /^https:\/\//); assert.equal(entry.source.checkedAt, '2026-09-28'); assert.ok(['USD', 'CNY'].includes(entry.currency));
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) assert.ok(entry[key] === null || entry[key] > 0, `${modelId}.${key}`);
  }
  for (const id of ['groq', 'glm', 'mimo']) for (const model of providerPresets().find(row => row.id === id).models) assert.equal(modelPrice(provider(id), model.id), null, `${id}/${model.id} has no sourced price`);
  assert.equal(modelPrice(provider('glm-coding', { authMode: 'coding_plan' }), 'glm-5.3'), null, 'plans are not billed per token');
  assert.equal(modelPrice({ id: 'x', protocol: 'openai', baseUrl: 'https://proxy.example/v1' }, 'gpt-5.4'), null, 'no borrowed price for a proxy');
});

test('request cost applies cache buckets, 1h writes, long-context and DeepSeek peak rates', () => {
  const opus = modelPrice(provider('anthropic'), 'claude-opus-5-5');
  assert.deepEqual(requestCost({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }, opus), { status: 'priced', currency: 'USD', amount: 4 + 20 + 0.2 + 5 });
  assert.equal(requestCost({ cacheWrite: 1e6 }, opus, { cacheRetention: 'long' }).amount, 8);
  const gpt = modelPrice(provider('openai'), 'gpt-5.4');
  assert.equal(requestCost({ input: 100000, output: 1e6 }, gpt).amount, 0.25 + 15);
  assert.equal(requestCost({ input: 300000, output: 1e6 }, gpt).amount, 1.5 + 22.5, 'above 272K input');
  const flash = modelPrice(provider('deepseek'), 'deepseek-flash');
  assert.equal(requestCost({ input: 1e6 }, flash, { at: '2026-09-28T02:00:00Z' }).amount, 0.3, 'Monday 02:00 UTC is peak');
  assert.equal(requestCost({ input: 1e6 }, flash, { at: '2026-09-27T02:00:00Z' }).amount, 0.15, 'Sunday is off-peak');
  assert.deepEqual(requestCost({ input: 10, cacheWrite: 10 }, gpt), { status: 'partial', currency: 'USD', amount: 0.000025 }, 'a bucket without a published rate is partial, not guessed');
  assert.deepEqual(requestCost({ input: 10 }, null), { status: 'unpriced', currency: null, amount: null });
  assert.deepEqual(sumCosts([{ status: 'priced', currency: 'USD', amount: 1 }, { status: 'priced', currency: 'CNY', amount: 2 }, { status: 'unpriced', currency: null, amount: null }]), { status: 'partial', amounts: { USD: 1, CNY: 2 }, pricedRequests: 2, partialRequests: 0, unpricedRequests: 1 });
});

// The resolver still prices what is decided from a price (the cache keep-alive pings, the cache break-even); no usage report uses it.
test('a price resolves per configured provider and model, null for one without a sourced price', () => {
  const anthropic = provider('anthropic'), resolve = priceResolver({ providers: [anthropic] }), opus = anthropic.models.find(row => row.id === 'claude-opus-5-5');
  assert.equal(resolve({ providerId: anthropic.id, modelId: 'claude-opus-5-5' }).entry.input, 4);
  assert.equal(resolve({ providerId: anthropic.id, modelId: 'claude-opus-5-5' }).cacheRetention, opus.cacheRetention);
  assert.equal(resolve({ providerId: anthropic.id, modelId: 'unknown-model' }), null); assert.equal(resolve({ providerId: 'other', modelId: 'claude-opus-5-5' }), null);
  assert.equal(priceResolver(() => ({ providers: [anthropic] }))({ providerId: anthropic.id, modelId: 'claude-opus-5-5' }).entry.cacheRead, 0.2, 'a live configuration function is read at each call');
});

test('usage rows: summary purpose and cacheAligned from the documented TTL; the aggregation carries no price', async () => {
  let now = Date.parse('2026-09-28T12:00:00Z');
  const ledger = new UsageLedger({ now: () => now }), anthropic = provider('anthropic');
  const model = { ...anthropic.models[0], providerId: anthropic.id, modelId: 'claude-opus-5-5', protocol: 'anthropic' };
  const base = async function* () { yield { type: 'usage', usage: { input: 1000, output: 100, cacheRead: 9000, cacheWrite: 0, totalTokens: 10100, cacheUsageReported: true } }; yield { type: 'done', stopReason: 'stop' }; };
  const metered = meteredProvider(base, { ledger, purpose: 'foreground', projectId: 'p1' }), request = purpose => ({ model, cache: { sessionKey: 'rna-p1', prefixHash: 'h1', retention: 'short' }, ...(purpose ? { purpose } : {}) });
  for await (const _ of metered(request())) {}
  now += 4 * 60000; for await (const _ of metered(request('summary'))) {}
  now += 6 * 60000; for await (const _ of metered(request())) {}
  assert.deepEqual(ledger.rows.map(row => [row.purpose, row.cacheAligned, row.ttlMs]), [['foreground', false, 300000], ['summary', true, 300000], ['foreground', false, 300000]]);
  assert.equal(ledger.lastRequestAt({ projectId: 'p1', providerId: anthropic.id, modelId: 'claude-opus-5-5' }), now);
  const report = aggregateCacheUsage(ledger.rows, { window: '1h', now });
  assert.deepEqual(report.overall.cacheAligned, { aligned: 1, outside: 2, unknownTtl: 0 });
  assert.equal('cost' in report.overall, false); assert.equal(JSON.stringify(report).includes('cost'), false);
  assert.equal(report.byPurpose.summary.requests, 1);
  assert.equal(cacheTtlMs({ protocol: 'anthropic' }, 'long'), 3600000); assert.equal(cacheTtlMs({ protocol: 'openai', compat: { supportsLongCacheRetention: true } }, 'long'), 86400000);
  assert.equal(cacheTtlMs({ protocol: 'openai' }), null, 'best-effort caches have no documented TTL');
  assert.equal('cacheAligned' in usageRecord({ purpose: 'foreground', usage: {} }), false);
});

test('no requests in the window: hit rate and coverage are null, not 0', () => {
  const report = aggregateCacheUsage([], { window: '1h', now: Date.now() });
  assert.equal(report.overall.requests, 0); assert.equal(report.overall.hitRate, null); assert.equal(report.overall.coverage, null); assert.equal(report.latest, null);
});
