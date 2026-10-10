import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest } from '../src/providers.mjs';
const base = { modelId: 'fixture', protocol: 'openai', baseUrl: 'https://example.test/v1', contextWindow: 1000000, maxOutputTokens: 32768, reasoning: 'high' };
const build = model => buildRequest({ model: { ...base, ...model }, messages: [{ role: 'user', content: 'Fixture' }], tools: [{ name: 'read', parameters: { type: 'object' } }] }).body;
test('Qwen emits native thinking toggle and preserved-thinking only when declared, not fabricated reasoning effort', () => {
  const compat = { thinkingFormat: 'qwen', preserveThinking: true, maxTokensField: 'max_completion_tokens' };
  const on = build({ compat }); assert.equal(on.enable_thinking, true); assert.equal(on.preserve_thinking, true); assert.equal(on.reasoning_effort, undefined); assert.equal(on.max_completion_tokens, 32768);
  const off = build({ compat, reasoning: 'off' }); assert.equal(off.enable_thinking, false); assert.equal(off.preserve_thinking, undefined); assert.equal(off.reasoning_effort, undefined);
});
test('MiMo and toggle-style providers preserve returned reasoning content across tool rounds', () => {
  const compat = { thinkingFormat: 'toggle', requiresReasoningContent: true };
  const body = buildRequest({ model: { ...base, compat }, messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'retained fixture reasoning' }, { type: 'toolCall', id: 't', name: 'read', arguments: {} }] }, { role: 'toolResult', toolCallId: 't', content: 'done' }] }).body;
  assert.deepEqual(body.thinking, { type: 'enabled' }); assert.equal(body.reasoning_effort, undefined); assert.equal(body.messages[0].reasoning_content, 'retained fixture reasoning');
  assert.deepEqual(build({ compat, reasoning: 'off' }).thinking, { type: 'disabled' });
});
test('official GLM5.3 legacy xhigh maps to max, output field is max_tokens, proxy namesakes remain untouched', () => {
  for (const route of ['/api/paas/v4', '/api/coding/paas/v4']) for (const modelId of ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx']) {
    const body = build({ baseUrl: `https://open.bigmodel.cn${route}`, modelId, reasoning: 'xhigh' }); assert.equal(body.max_tokens, 32768); assert.equal(body.max_completion_tokens, undefined); assert.equal(body.reasoning_effort, 'max'); assert.deepEqual(body.thinking, { type: 'enabled' });
  }
  const proxy = build({ modelId: 'glm-5.3', reasoning: 'xhigh' }); assert.equal(proxy.reasoning_effort, 'xhigh'); assert.equal(proxy.thinking, undefined);
  const wrongRoute = build({ baseUrl: 'https://open.bigmodel.cn/proxy/v1', modelId: 'glm-5.3' }); assert.equal(wrongRoute.thinking, undefined);
});
test('explicit GLM compat sends streaming tools while OpenAI native reasoning remains unchanged', () => {
  const body = build({ compat: { thinkingFormat: 'zai', toolStream: true, reasoningEffortMap: { xhigh: 'max' } }, reasoning: 'xhigh' }); assert.equal(body.tool_stream, true); assert.equal(body.reasoning_effort, 'max');
  assert.equal(build({ reasoning: 'xhigh' }).reasoning_effort, 'xhigh'); assert.throws(() => build({ compat: { thinkingFormat: 'invented' } }), /思考格式/);
});
