import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage } from '../src/providers.mjs';
import { codexEventUsage } from '../src/subscription-provider.mjs';

test('reasoning token counts are normalized only when the provider reports them', () => {
  assert.equal(normalizeUsage({ prompt_tokens: 10, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 40 } }).reasoningTokens, 40);
  assert.equal(Object.hasOwn(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5 }), 'reasoningTokens'), false);
  for (const value of [-1, '40', 1.5, null]) assert.equal(Object.hasOwn(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: value } }), 'reasoningTokens'), false);
  assert.equal(Object.hasOwn(normalizeUsage({ input_tokens: 10, output_tokens: 5 }, 'anthropic'), 'reasoningTokens'), false);
  assert.equal(codexEventUsage({ response: { usage: { input_tokens: 10, output_tokens: 30, output_tokens_details: { reasoning_tokens: 12 } } } }).reasoningTokens, 12);
});
