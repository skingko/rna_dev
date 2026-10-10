import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildRequest, streamCompletion } from '../src/providers.mjs';

const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6eZkAAAAASUVORK5CYII=' };
const model = { protocol: 'anthropic', providerId: 'isolated', modelId: 'vision-fixture', input: ['text', 'image'], baseUrl: 'http://127.0.0.1:1', maxOutputTokens: 4096, contextWindow: 64000, reasoning: 'off' };
const tools = [{ name: 'capture', description: 'Isolated declaration only', parameters: { type: 'object', properties: {} } }];
const request = (messages, extra = {}) => ({ model, systemPrompt: 'Stable fixture system.', tools, messages, cache: { retention: 'short' }, ...extra });
async function wire(t, input) {
  let captured;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    captured = { path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":80,"cache_creation_input_tokens":15,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const events = await Array.fromAsync(streamCompletion({ ...input, model: { ...input.model, baseUrl: `http://127.0.0.1:${server.address().port}` }, maxRetries: 0 }));
  assert.equal(events.at(-1).stopReason, 'stop');
  assert.deepEqual(events.findLast(event => event.type === 'usage').usage, { input: 5, output: 1, cacheRead: 80, cacheWrite: 15, totalTokens: 101, costStatus: 'unpriced', cacheUsageReported: true });
  assert.equal(captured.path, '/v1/messages');
  return captured.body;
}

test('Anthropic wire caches the image boundary of an image-only user input', async t => {
  const input = request([{ role: 'user', content: [image] }]), original = structuredClone(input);
  const body = await wire(t, input);
  assert.deepEqual(body.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data }, cache_control: { type: 'ephemeral' } });
  assert.deepEqual(input, original);
});
test('Anthropic wire marks the final image rather than the preceding text', async t => {
  const body = await wire(t, request([{ role: 'user', content: [{ type: 'text', text: 'Inspect these pixels.' }, image] }]));
  assert.equal(body.messages[0].content[0].cache_control, undefined);
  assert.deepEqual(body.messages[0].content[1].cache_control, { type: 'ephemeral' });
  assert.equal(body.messages[0].content[1].source.data, image.data);
});
test('Anthropic wire keeps the outer tool-result boundary, not its image sub-block', async t => {
  const body = await wire(t, request([{ role: 'user', content: 'Inspect.' }, { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'capture', arguments: {} }] }, { role: 'toolResult', toolCallId: 'call-1', toolName: 'capture', content: [{ type: 'text', text: 'Actual isolated receipt.' }, image] }]));
  const result = body.messages.at(-1).content[0];
  assert.equal(result.type, 'tool_result'); assert.deepEqual(result.cache_control, { type: 'ephemeral' });
  assert.equal(result.content.at(-1).source.data, image.data); assert.equal(result.content.at(-1).cache_control, undefined);
  assert.equal(body.messages[1].content[0].cache_control, undefined);
});
test('Anthropic wire leaves signed thinking unchanged and never marks it', async t => {
  const thinking = { type: 'thinking', thinking: 'Fixture reasoning.', signature: 'fixture-signature' };
  const body = await wire(t, request([{ role: 'user', content: 'Check.' }, { role: 'assistant', content: [thinking, { type: 'text', text: 'Prior conclusion.' }] }]));
  assert.deepEqual(body.messages[1].content[0], thinking);
  assert.deepEqual(body.messages[1].content[1].cache_control, { type: 'ephemeral' });
  const onlyThinking = buildRequest(request([{ role: 'assistant', content: [thinking] }])).body;
  assert.deepEqual(onlyThinking.messages[0].content, [thinking]);
});
test('Anthropic long-cache explicit false preserves short markers at all three boundaries', async t => {
  const body = await wire(t, request([{ role: 'user', content: [image] }], { model: { ...model, compat: { supportsLongCacheRetention: false } }, cache: { retention: 'long' } }));
  for (const block of [body.system[0], body.tools[0], body.messages[0].content[0]]) assert.deepEqual(block.cache_control, { type: 'ephemeral' });
  assert.ok(!JSON.stringify(body).includes('"ttl"'));
});
test('Anthropic long-cache true and historical unspecified support retain one-hour markers', () => {
  for (const compat of [{ supportsLongCacheRetention: true }, {}]) {
    const body = buildRequest(request([{ role: 'user', content: 'Stable text.' }], { model: { ...model, compat }, cache: { retention: 'long' } })).body;
    for (const block of [body.system[0], body.tools[0], body.messages[0].content[0]]) assert.deepEqual(block.cache_control, { type: 'ephemeral', ttl: '1h' });
  }
});
test('Anthropic cache none removes every marker without removing images or tool declarations', async t => {
  const body = await wire(t, request([{ role: 'user', content: [{ type: 'text', text: 'Inspect.' }, image] }], { cache: { retention: 'none' }, model: { ...model, compat: { supportsLongCacheRetention: true } } }));
  assert.ok(!JSON.stringify(body).includes('cache_control')); assert.ok(!JSON.stringify(body).includes('"ttl"'));
  assert.equal(body.messages[0].content[1].source.data, image.data); assert.equal(body.tools[0].name, 'capture');
});
test('GLM and DeepSeek OpenAI requests gain no cache fields or affinity headers', () => {
  for (const [baseUrl, modelId] of [['https://api.deepseek.com', 'deepseek-v4-pro'], ['https://api.z.ai/api/paas/v4', 'glm-5.3']]) {
    const result = buildRequest({ model: { ...model, protocol: 'openai', baseUrl, modelId }, messages: [{ role: 'user', content: 'Stable text.' }], cache: { retention: 'long', sessionKey: 'stable-session' } });
    assert.equal(result.body.prompt_cache_key, undefined); assert.equal(result.body.prompt_cache_retention, undefined);
    assert.ok(!JSON.stringify(result.body).includes('cache_control')); assert.deepEqual(result.headers, {});
  }
});
