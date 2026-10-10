import { matchedProviderPreset } from './provider-presets.mjs';

// List prices per 1M tokens for preset models, copied from each official
// pricing page on `checkedAt`. A rate is null when that page does not state
// it (never guessed); a model without a sourced page has no entry (unpriced).
// Token buckets are exclusive (input = uncached input), as normalizeUsage
// reports them. Account discounts, batch, data residency and taxes are not
// modelled: this is an estimate at list price, not an invoice.
const checkedAt = '2026-09-28';
const anthropic = 'https://platform.claude.com/docs/en/about-claude/pricing';
const openai = 'https://developers.openai.com/api/docs/pricing';
const deepseek = 'https://api-docs.deepseek.com/quick_start/pricing/';
// DeepSeek peak: 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday (Chinese
// public holidays are off-peak; they are not modelled, so a holiday request
// is estimated at the peak rate). Off-peak rates are the base rates.
const deepseekPeak = { weekdays: [1, 2, 3, 4, 5], utcHours: [[1, 4], [6, 10]] };
const price = (currency, url, input, output, cacheRead, cacheWrite, extra = {}) => Object.freeze({ currency, input, output, cacheRead, cacheWrite, ...extra, source: Object.freeze({ url, checkedAt }) });
const qwen = tier => `https://help.aliyun.com/zh/model-studio/qwen3-8-${tier}`;
export const MODEL_PRICES = Object.freeze({
  anthropic: {
    // cacheWrite = 5-minute write; cacheWriteLong = 1-hour write (cacheRetention 'long').
    'claude-opus-5-5': price('USD', anthropic, 4, 20, 0.2, 5, { cacheWriteLong: 8 }),
    'claude-sonnet-5': price('USD', anthropic, 2, 10, 0.2, 2.5, { cacheWriteLong: 4 }),
    'claude-haiku-4-5-20251001': price('USD', anthropic, 1, 5, 0.1, 1.25, { cacheWriteLong: 2 }),
  },
  openai: {
    // Prompts above 272K input tokens are billed at the long-context rates.
    'gpt-5.4': price('USD', openai, 2.5, 15, 0.25, null, { longContext: Object.freeze({ aboveInputTokens: 272000, input: 5, output: 22.5, cacheRead: 0.5 }) }),
    'gpt-4.1-mini': price('USD', openai, 0.4, 1.6, 0.1, null),
  },
  deepseek: {
    'deepseek-v4-pro': price('USD', deepseek, 0.66, 1.98, 0.022, null, { peak: Object.freeze({ ...deepseekPeak, input: 1.32, output: 3.96, cacheRead: 0.044 }) }),
    'deepseek-flash': price('USD', deepseek, 0.15, 0.6, 0.003, null, { peak: Object.freeze({ ...deepseekPeak, input: 0.3, output: 1.2, cacheRead: 0.006 }) }),
  },
  // Standard paid tier, text/image/video input; explicit-cache storage is not used by Rna.
  google: { 'gemini-2.5-flash': price('USD', 'https://ai.google.dev/gemini-api/docs/pricing', 0.3, 2.5, 0.03, null) },
  // From the public model listing (pricing.prompt/completion/input_cache_read, USD per token).
  openrouter: { 'openai/gpt-4.1-mini': price('USD', 'https://openrouter.ai/api/v1/models', 0.4, 1.6, 0.1, null) },
  // Beijing region; cacheWrite is the explicit cache creation rate.
  'qwen-cn': { 'qwen3.8-max': price('CNY', qwen('max'), 12, 36, 1.5, 15), 'qwen3.8-flash': price('CNY', qwen('flash'), 0.8, 2.7, 0.1, 1.25) },
  // Singapore region, as listed (元) on the same pages.
  'qwen-intl': { 'qwen3.8-max': price('CNY', qwen('max'), 14.988, 44.965, 1.874, 18.736), 'qwen3.8-flash': price('CNY', qwen('flash'), 1.094, 3.427, 0.117, 1.458) },
  'kimi-cn': { 'kimi-k3': price('CNY', 'https://platform.kimi.com/docs/pricing/chat', 20, 100, 2, null) },
  kimi: { 'kimi-k3': price('USD', 'https://platform.kimi.ai/docs/pricing/chat', 3, 15, 0.3, null) },
  // No sourced list price (checked 2026-09-28): groq llama-3.3-70b-versatile
  // ("Contact sales"), MiMo V2.6, and plan/subscription endpoints
  // (kimi-coding, glm-coding, mimo-token-plan-cn, openai-codex) which are not
  // billed per token. The GLM-5.3 family is not here either: its page's list
  // prices sit in REFERENCE_PRICES below, for the warm-cache decision only, so
  // no cost is shown for it.
});

// Reference list prices for models a plan or subscription serves, or whose page MODEL_PRICES did not carry when it was
// written: used ONLY to weigh a cache read against an uncached token when deciding whether to edit a warm cache (SDK
// cache-economics.mjs). They are never a cost: a Coding Plan or a ChatGPT subscription is not billed per token, so
// `modelPrice` stays null for those and no cost is shown. The relative rates are what the decision needs.
// GLM-5.3 family: CNY per million tokens as listed on the official pricing page (input / cache hit; output not used here),
// read 2026-10-05 (and again that day: 8 / 28 / 2, 0.8 / 2.8 / 0.23, 2 / 7 / 0.57, no length tiers; the page lists cache storage
// as free for a limited time, so there is no write price to count), https://docs.bigmodel.cn/cn/guide/start/pricing. Codex: the standard API list price of the same model
// (https://developers.openai.com/api/docs/pricing, read 2026-10-05). A model id not listed here has no reference price.
const referenceChecked = '2026-10-05';
const glmPricing = 'https://docs.bigmodel.cn/cn/guide/start/pricing';
const reference = (currency, url, input, output, cacheRead) => Object.freeze({ currency, input, output, cacheRead, cacheWrite: null, source: Object.freeze({ url, checkedAt: referenceChecked }) });
const glmReference = Object.freeze({ 'glm-5.3': reference('CNY', glmPricing, 8, 28, 2), 'glm-5.3-flash': reference('CNY', glmPricing, 0.8, 2.8, 0.23), 'glm-5.3-flashx': reference('CNY', glmPricing, 2, 7, 0.57) });
export const REFERENCE_PRICES = Object.freeze({
  glm: glmReference,
  // The Coding Plan preset has no FlashX.
  'glm-coding': Object.freeze({ 'glm-5.3': glmReference['glm-5.3'], 'glm-5.3-flash': glmReference['glm-5.3-flash'] }),
  'openai-codex': Object.freeze({ 'gpt-5.4': MODEL_PRICES.openai['gpt-5.4'], 'gpt-5.3-codex': reference('USD', openai, 1.75, 14, 0.175) })
});

/** The price entry of a configured provider/model, or null (unpriced). */
export function modelPrice(provider, modelId) {
  if (!provider || typeof modelId !== 'string' || ['coding_plan', 'subscription'].includes(provider.authMode)) return null;
  const preset = matchedProviderPreset(provider);
  return preset ? MODEL_PRICES[preset.id]?.[modelId] ?? null : null;
}
/**
 * What a cache read and a cache write cost relative to an uncached input token for a configured provider/model, for the
 * SDK's break-even decisions: `{ input, cacheRead, cacheWrite, reference }` (any one unit; `cacheWrite` null when the
 * provider has no separate write price), or null when no price is known — the SDK then leaves a warm cache alone. The
 * billed list price when there is one (MODEL_PRICES), else a reference price (REFERENCE_PRICES: plan and subscription
 * endpoints). The base rates only: a long-context or peak tier changes input and cache rate together.
 */
export function cachePrices(provider, modelId) {
  const listed = modelPrice(provider, modelId), preset = listed ? null : matchedProviderPreset(provider), entry = listed ?? (preset ? REFERENCE_PRICES[preset.id]?.[modelId] ?? null : null);
  if (!entry || !(entry.input > 0) || !Number.isFinite(entry.cacheRead)) return null;
  return { input: entry.input, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite ?? null, reference: !listed, ...(entry.source ? { source: entry.source } : {}) };
}
const peakAt = (peak, at) => { const date = new Date(at); if (!peak || !Number.isFinite(date.getTime())) return false; const hour = date.getUTCHours() + date.getUTCMinutes() / 60; return peak.weekdays.includes(date.getUTCDay()) && peak.utcHours.some(([from, to]) => hour >= from && hour < to); };
/** List-price estimate of one request. `status` is priced (every nonzero
 * bucket has a rate), partial (some bucket lacks one) or unpriced. */
export function requestCost(usage, entry, { at = Date.now(), cacheRetention } = {}) {
  if (!entry) return { status: 'unpriced', currency: null, amount: null };
  const n = key => Math.max(0, Number(usage?.[key]) || 0), prompt = n('input') + n('cacheRead') + n('cacheWrite');
  const long = entry.longContext && prompt > entry.longContext.aboveInputTokens ? entry.longContext : null, peak = peakAt(entry.peak, at) ? entry.peak : null;
  const rate = key => long?.[key] ?? peak?.[key] ?? (key === 'cacheWrite' && cacheRetention === 'long' && entry.cacheWriteLong != null ? entry.cacheWriteLong : entry[key]);
  let amount = 0, missing = false;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) { if (!n(key)) continue; const value = rate(key); if (value == null) missing = true; else amount += n(key) * value / 1e6; }
  return { status: missing ? 'partial' : 'priced', currency: entry.currency, amount: Math.round(amount * 1e8) / 1e8 };
}
/** Sum request costs per currency. Never adds different currencies. */
export function sumCosts(costs) {
  const amounts = {}; let priced = 0, partial = 0, unpriced = 0;
  for (const cost of costs) {
    if (cost.status === 'unpriced') { unpriced++; continue; }
    if (cost.status === 'partial') partial++; else priced++;
    amounts[cost.currency] = Math.round(((amounts[cost.currency] ?? 0) + cost.amount) * 1e8) / 1e8;
  }
  const status = !costs.length ? null : unpriced === costs.length ? 'unpriced' : unpriced || partial ? 'partial' : 'priced';
  return { status, amounts, pricedRequests: priced, partialRequests: partial, unpricedRequests: unpriced };
}
/** Resolver over the live configuration for ledger rows and turn usage. */
export function priceResolver(configuration) {
  return ({ providerId, modelId }) => {
    const config = typeof configuration === 'function' ? configuration() : configuration, provider = config?.providers?.find(row => row.id === providerId);
    const entry = modelPrice(provider, modelId), model = provider?.models?.find(row => row.id === modelId);
    return entry ? { entry, cacheRetention: model?.cacheRetention } : null;
  };
}
