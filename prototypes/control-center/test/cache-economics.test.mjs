import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_PRICES, REFERENCE_PRICES, cachePrices, modelPrice } from '../model-pricing.mjs';
import { providerPresets } from '../provider-presets.mjs';
import { settleBreakEven } from '../../../packages/sdk/src/cache-economics.mjs';

// Plan C5: the share of the context a warm-cache edit must free is computed from the model's prices — cache read against the
// uncached input rate, and the cache write where the provider bills one — and the conversation's requests per run
// (packages/sdk/src/cache-economics.mjs), replacing the fixed 0.25. The host resolves the prices: the billed list price
// (MODEL_PRICES) or, for a plan or subscription that is not billed per token, a reference price (REFERENCE_PRICES) used for this
// decision only. A model with no price at all has no break-even.
const provider = (id, extra = {}) => { const preset = providerPresets().find(row => row.id === id); return { id: `configured-${id}`, protocol: preset.protocol, baseUrl: preset.baseUrl, models: preset.models, ...extra }; };
const codex = { id: 'configured-codex', protocol: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', authMode: 'subscription', authProvider: 'openai-codex' };
const shares = (entry, requests) => settleBreakEven({ prices: entry, requests }).share;
const round = value => Math.round(value * 10000) / 10000;

test('computed break-even shares for GLM, DeepSeek, Codex and Claude, from their prices', t => {
  const rows = [
    ['GLM-5.3 (API)', cachePrices(provider('glm'), 'glm-5.3')], ['GLM-5.3 (Coding Plan)', cachePrices(provider('glm-coding', { authMode: 'coding_plan' }), 'glm-5.3')],
    ['GLM-5.3 Flash', cachePrices(provider('glm'), 'glm-5.3-flash')], ['GLM-5.3 FlashX', cachePrices(provider('glm'), 'glm-5.3-flashx')],
    ['DeepSeek V4 Pro', cachePrices(provider('deepseek'), 'deepseek-v4-pro')], ['DeepSeek V4.1 Flash', cachePrices(provider('deepseek'), 'deepseek-flash')],
    ['GPT-5.4 (API)', cachePrices(provider('openai'), 'gpt-5.4')], ['GPT-5.4 (Codex)', cachePrices(codex, 'gpt-5.4')], ['GPT-5.3-Codex', cachePrices(codex, 'gpt-5.3-codex')],
    ['Claude Opus 5.5', cachePrices(provider('anthropic'), 'claude-opus-5-5')], ['Claude Sonnet 5', cachePrices(provider('anthropic'), 'claude-sonnet-5')], ['Claude Haiku 4.5', cachePrices(provider('anthropic'), 'claude-haiku-4-5-20251001')],
  ];
  assert.ok(rows.every(([, entry]) => entry), 'every one is priced');
  const table = [['model', 'read/input', 'write/input', 'N=1', 'N=2', 'N=10', 'N=27'], ...rows.map(([name, entry]) => { const one = settleBreakEven({ prices: entry, requests: 1 }); return [name, round(one.read), round(one.write), ...[1, 2, 10, 27].map(n => round(shares(entry, n)))]; })];
  t.diagnostic(`\n${table.map(row => row.join('\t')).join('\n')}`);
  const at = (name, n) => round(shares(rows.find(row => row[0] === name)[1], n));
  // GLM-5.3: a cache hit is a quarter of the input price (2 against 8, CNY per million).
  assert.deepEqual([1, 2, 10, 27].map(n => at('GLM-5.3 (API)', n)), [0.75, 0.6, 0.2308, 0.1]);
  assert.deepEqual([1, 27].map(n => at('GLM-5.3 (Coding Plan)', n)), [0.75, 0.1], 'the plan endpoint uses the same reference price');
  assert.deepEqual([1, 2, 10, 27].map(n => at('GLM-5.3 Flash', n)), [0.7125, 0.5534, 0.1986, 0.0841]);
  assert.deepEqual([1, 27].map(n => at('GLM-5.3 FlashX', n)), [0.715, 0.085]);
  // DeepSeek: a hit costs a thirtieth of the input price, so a saved token is almost worthless and a warm edit rarely pays.
  assert.deepEqual([1, 2, 10, 27].map(n => at('DeepSeek V4 Pro', n)), [0.9667, 0.9355, 0.7436, 0.5179]);
  assert.deepEqual([1, 27].map(n => at('DeepSeek V4.1 Flash', n)), [0.98, 0.6447]);
  // Codex and the API model it serves: a hit is a tenth of the input price, no write fee.
  assert.deepEqual([1, 2, 10, 27].map(n => at('GPT-5.4 (Codex)', n)), [0.9, 0.8182, 0.4737, 0.25]);
  assert.deepEqual([1, 27].map(n => at('GPT-5.3-Codex', n)), [0.9, 0.25]); assert.equal(at('GPT-5.4 (API)', 27), 0.25);
  // Claude: a read is a tenth (Opus a twentieth) of the input price and a 5-minute write costs a quarter more.
  assert.deepEqual([1, 2, 10, 27].map(n => at('Claude Sonnet 5', n)), [0.92, 0.8519, 0.5349, 0.2987]);
  assert.deepEqual([1, 27].map(n => at('Claude Opus 5.5', n)), [0.96, 0.4706]); assert.deepEqual([1, 27].map(n => at('Claude Haiku 4.5', n)), [0.92, 0.2987]);
  // The cheaper a read is against an uncached token, the less a saved token is worth and the more a warm edit must free.
  assert.ok(at('DeepSeek V4 Pro', 27) > at('Claude Opus 5.5', 27) && at('Claude Opus 5.5', 27) > at('Claude Sonnet 5', 27) && at('Claude Sonnet 5', 27) > at('GPT-5.4 (Codex)', 27) && at('GPT-5.4 (Codex)', 27) > at('GLM-5.3 (API)', 27));
});

test('every entry of both price tables has a break-even: the closed form, between 0 and 1, falling with the requests that read the saving', t => {
  const entries = [...Object.entries(MODEL_PRICES), ...Object.entries(REFERENCE_PRICES).map(([id, models]) => [`${id} (reference)`, models])].flatMap(([presetId, models]) => Object.entries(models).map(([modelId, entry]) => [`${presetId}/${modelId}`, entry]));
  assert.ok(entries.length >= 20, `${entries.length} entries`);
  const lines = [];
  for (const [name, entry] of entries) {
    const prices = { input: entry.input, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite }, r = entry.cacheRead / entry.input, w = (entry.cacheWrite ?? entry.input) / entry.input;
    let previous = Infinity;
    for (const n of [1, 2, 10, 27]) {
      const share = settleBreakEven({ prices, requests: n }).share;
      assert.ok(Math.abs(share - (w - r) / (w + (n - 1) * r)) < 1e-12, `${name} at ${n}`);
      assert.ok(share > 0 && share < 1 && share < previous, `${name} at ${n}: ${share}`);
      previous = share;
    }
    lines.push(`${name}\tread ${round(r)}\twrite ${round(w)}\t${[1, 2, 10, 27].map(n => round(shares(prices, n))).join('\t')}`);
  }
  t.diagnostic(`\n${lines.join('\n')}`);
});

test('price resolution: the billed list price first, a reference price only where nothing is billed per token, never a guess', () => {
  // A billed price is used as listed, and says so.
  const sonnet = cachePrices(provider('anthropic'), 'claude-sonnet-5');
  assert.deepEqual({ input: sonnet.input, cacheRead: sonnet.cacheRead, cacheWrite: sonnet.cacheWrite, reference: sonnet.reference }, { input: 2, cacheRead: 0.2, cacheWrite: 2.5, reference: false });
  assert.equal(sonnet.source.url, MODEL_PRICES.anthropic['claude-sonnet-5'].source.url);
  // A plan or subscription has no per-token price (modelPrice is null, so no cost is shown) but a reference one for the decision.
  const plan = provider('glm-coding', { authMode: 'coding_plan' });
  assert.equal(modelPrice(plan, 'glm-5.3'), null); assert.equal(modelPrice(codex, 'gpt-5.4'), null); assert.equal(modelPrice(provider('glm'), 'glm-5.3'), null, 'GLM is still unpriced as a cost');
  const reference = cachePrices(plan, 'glm-5.3');
  assert.deepEqual({ input: reference.input, cacheRead: reference.cacheRead, cacheWrite: reference.cacheWrite, reference: reference.reference }, { input: 8, cacheRead: 2, cacheWrite: null, reference: true });
  assert.match(reference.source.url, /^https:\/\/docs\.bigmodel\.cn\//); assert.equal(reference.source.checkedAt, '2026-10-05');
  assert.equal(cachePrices(codex, 'gpt-5.4').reference, true);
  // Every reference entry names a source and a check date, and a model of the preset.
  const known = new Map(providerPresets().map(row => [row.id, new Set(row.models.map(model => model.id))]));
  for (const [presetId, models] of Object.entries(REFERENCE_PRICES)) for (const [modelId, entry] of Object.entries(models)) {
    assert.match(entry.source.url, /^https:\/\//); assert.ok(entry.cacheRead > 0 && entry.input > entry.cacheRead, `${presetId}/${modelId}`);
    if (known.get(presetId)?.size) assert.ok(known.get(presetId).has(modelId), `${presetId}/${modelId} is a preset model`);
  }
  // No price: a model the tables do not know, a proxy, a custom endpoint, a preset with no sourced page.
  assert.equal(cachePrices(codex, 'gpt-9-unknown'), null, 'an unlisted Codex model has no reference price');
  assert.equal(cachePrices(provider('glm'), 'glm-9'), null);
  assert.equal(cachePrices({ id: 'x', protocol: 'openai', baseUrl: 'https://proxy.example/v1' }, 'gpt-5.4'), null, 'no borrowed price for a proxy');
  assert.equal(cachePrices({ id: 'x', protocol: 'openai', baseUrl: 'https://proxy.example/api/paas/v4' }, 'glm-5.3'), null);
  assert.equal(cachePrices(provider('mimo'), 'mimo-v2.6-pro'), null); assert.equal(cachePrices(provider('groq'), 'llama-3.3-70b-versatile'), null);
  assert.equal(cachePrices(undefined, 'glm-5.3'), null); assert.equal(cachePrices(provider('glm'), undefined), null);
});
