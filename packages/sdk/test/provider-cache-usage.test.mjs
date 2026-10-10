import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage, streamCompletion } from '../src/providers.mjs';

test('cache reporting distinguishes an explicit zero from absent or malformed counters', () => {
  const missing = normalizeUsage({ prompt_tokens: 100, completion_tokens: 5 });
  const zero = normalizeUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } });
  assert.equal(missing.cacheRead, 0); assert.equal(missing.cacheUsageReported, false);
  assert.equal(zero.cacheRead, 0); assert.equal(zero.cacheUsageReported, true);
  for (const value of [undefined, null, '50', -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizeUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: value } }).cacheUsageReported, false);
  }
  for (const value of [undefined, -1, '100', 1.5]) assert.equal(normalizeUsage({ prompt_tokens: value, cached_tokens: 0 }).cacheUsageReported, false);
  assert.equal(normalizeUsage({ prompt_tokens: 100, cached_tokens: 101 }).cacheUsageReported, false);
  assert.equal(normalizeUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 70, cache_write_tokens: 31 } }).cacheUsageReported, false);
  assert.equal(normalizeUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 70, cache_write_tokens: '10' } }).cacheUsageReported, false);
});

test('OpenAI and DeepSeek include cache tokens in prompt totals; Anthropic reports separate buckets', () => {
  for (const cache of [{ prompt_tokens_details: { cached_tokens: 80 } }, { prompt_cache_hit_tokens: 80 }, { cached_tokens: 80 }]) {
    const usage = normalizeUsage({ prompt_tokens: 100, completion_tokens: 999, ...cache });
    assert.equal(usage.cacheUsageReported, true); assert.equal(usage.cacheRead / (usage.input + usage.cacheRead + usage.cacheWrite), 0.8);
    assert.equal(usage.totalTokens, 1099);
  }
  const anthropic = normalizeUsage({ input_tokens: 10, output_tokens: 999, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 }, 'anthropic');
  assert.equal(anthropic.cacheUsageReported, true); assert.equal(anthropic.cacheRead / (anthropic.input + anthropic.cacheRead + anthropic.cacheWrite), 0.8);
  assert.equal(anthropic.totalTokens, 1099);
  assert.equal(normalizeUsage({ input_tokens: 10, cache_read_input_tokens: 0 }, 'anthropic').cacheUsageReported, true);
  assert.equal(normalizeUsage({ input_tokens: 10 }, 'anthropic').cacheUsageReported, false);
  assert.equal(normalizeUsage({ cache_read_input_tokens: 80 }, 'anthropic').cacheUsageReported, false);
  assert.equal(normalizeUsage({ input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: -1 }, 'anthropic').cacheUsageReported, false);
  assert.equal(normalizeUsage({ input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: 80 }, 'anthropic').cacheUsageReported, false);
});

test('Anthropic cumulative streaming preserves reported cache counters through output-only usage frames', async () => {
  const frames = [
    { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  const events = await Array.fromAsync(streamCompletion({
    model: { providerId: 'fixture', modelId: 'test', protocol: 'anthropic', baseUrl: 'https://fixture.invalid', contextWindow: 10000, maxOutputTokens: 100 },
    messages: [{ role: 'user', content: 'hello' }],
    fetch: async () => new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }),
  }));
  const usage = events.filter(event => event.type === 'usage').map(event => event.usage);
  assert.equal(usage.length, 2); assert.ok(usage.every(item => item.cacheUsageReported));
  assert.deepEqual(usage.at(-1), { input: 10, output: 5, cacheRead: 80, cacheWrite: 10, totalTokens: 105, costStatus: 'unpriced', cacheUsageReported: true });
});
