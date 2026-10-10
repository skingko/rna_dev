import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, cacheKeepAlive, normalizeUsage, streamCompletion } from '../src/providers.mjs';
import { anthropicFeatures, historyEditing } from '../src/anthropic-features.mjs';
import { providerDiagnostic } from '../src/provider-diagnostics.mjs';
import { createFakeAnthropic } from './fixtures/fake-anthropic.mjs';

const KEY = 'sk-ant-fixture-not-a-real-key';
const opus = { providerId: 'anthropic', modelId: 'claude-opus-5-5', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', contextWindow: 1000000, maxOutputTokens: 64000, reasoning: 'default', compat: { adaptiveThinking: true, thinkingDisplay: 'summarized' } };
const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
const body = (model, extra = {}) => buildRequest({ model, systemPrompt: 'S', messages: [user('hi')], ...extra }).body;

test('effort mapping: default omits output_config, minimal is low, off keeps a model that must think at low', () => {
  assert.deepEqual([body(opus).thinking.type, body(opus).output_config], ['adaptive', undefined]);
  for (const [reasoning, effort] of [['minimal', 'low'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max'], ['off', 'low']]) assert.deepEqual(body({ ...opus, reasoning }).output_config, { effort }, reasoning);
  assert.equal(body({ ...opus, reasoning: 'off' }).thinking.type, 'adaptive', 'Opus 5.5 cannot disable thinking');
  // A model id the module knows thinks by default, even without the compat flag.
  assert.equal(body({ ...opus, compat: {} }).thinking.type, 'adaptive');
  const opus5 = { ...opus, modelId: 'claude-opus-5', reasoning: 'off', compat: { adaptiveThinking: true, canDisableThinking: true } };
  assert.deepEqual(body(opus5).thinking, { type: 'disabled' }, 'off with canDisableThinking disables thinking');
  assert.equal(body(opus5).output_config, undefined);
  assert.equal(historyEditing(opus5), 'free', 'no thinking, nothing to preserve');
  const haiku = { ...opus, modelId: 'claude-haiku-4-5-20251001', compat: {}, reasoning: 'medium', maxOutputTokens: 8192 };
  assert.equal(body(haiku).thinking.type, 'enabled'); assert.equal(body(haiku).thinking.budget_tokens, 4096);
  assert.equal(body({ ...haiku, reasoning: 'default' }).thinking, undefined, 'budget models keep the provider default');
});

test('block_binding and its beta header only on the official endpoint with thinking', () => {
  const official = buildRequest({ model: opus, messages: [user('x')] });
  assert.deepEqual(official.body.thinking.block_binding, { prefix_mismatch_behavior: 'drop_block' }, 'production default: drop and rebase');
  assert.equal(official.headers['anthropic-beta'], 'thinking-binding-controls-2026-08-01');
  assert.deepEqual(buildRequest({ model: { ...opus, compat: { ...opus.compat, thinkingBindingMode: 'error' } }, messages: [user('x')] }).body.thinking.block_binding, { prefix_mismatch_behavior: 'error' });
  const monitor = buildRequest({ model: { ...opus, compat: { ...opus.compat, thinkingBindingMode: 'unset' } }, messages: [user('x')] });
  assert.equal(monitor.body.thinking.block_binding, undefined); assert.equal(monitor.headers['anthropic-beta'], 'thinking-binding-controls-2026-08-01');
  const off = buildRequest({ model: { ...opus, compat: { ...opus.compat, thinkingBindingMode: 'off' } }, messages: [user('x')] });
  assert.equal(off.body.thinking.block_binding, undefined); assert.equal(off.headers['anthropic-beta'], undefined);
  assert.throws(() => buildRequest({ model: { ...opus, compat: { ...opus.compat, thinkingBindingMode: 'sometimes' } }, messages: [user('x')] }), { code: 'configuration' });
  for (const baseUrl of ['https://api.kimi.com/coding', 'https://api.anthropic.com:8443', 'http://127.0.0.1:9', 'https://proxy.invalid']) {
    const other = buildRequest({ model: { ...opus, baseUrl }, messages: [user('x')] });
    assert.equal(other.body.thinking.block_binding, undefined, baseUrl); assert.equal(other.headers['anthropic-beta'], undefined, baseUrl);
    assert.equal(anthropicFeatures({ ...opus, baseUrl }).appendOnly, false, baseUrl);
  }
  assert.equal(anthropicFeatures(opus).appendOnly, true); assert.equal(historyEditing(opus), 'append-only');
  assert.equal(anthropicFeatures({ ...opus, compat: { ...opus.compat, appendOnly: false } }).appendOnly, false, 'explicit compat wins');
});

test('toolChoice none maps to {type: none} on the official endpoint only', () => {
  assert.deepEqual(buildRequest({ model: opus, messages: [user('x')], toolChoice: 'none' }).body.tool_choice, { type: 'none' });
  assert.throws(() => buildRequest({ model: { ...opus, baseUrl: 'https://api.kimi.com/coding' }, messages: [user('x')], toolChoice: 'none' }), { code: 'unsupported_output_contract' });
});

test('thinking projection: Codex receipts never reach Anthropic, stripThinking removes only thinking and redacted thinking', () => {
  const messages = [user('hi'), { id: 'a1', role: 'assistant', content: [{ type: 'thinking', thinking: 'codex', signature: 'rna:codex-reasoning:abc' }, { type: 'thinking', thinking: '', signature: 'sig-empty' }, { type: 'redactedThinking', data: 'opaque' }, { type: 'text', text: 'answer' }, { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a' } }] }, { id: 'r1', role: 'toolResult', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] }];
  const kept = buildRequest({ model: opus, messages }).body.messages[1].content;
  assert.deepEqual(kept.map(block => block.type), ['thinking', 'redacted_thinking', 'text', 'tool_use']);
  assert.deepEqual(kept[0], { type: 'thinking', thinking: '', signature: 'sig-empty' }, 'empty-text thinking is replayed with its signature');
  assert.deepEqual(kept[1], { type: 'redacted_thinking', data: 'opaque' });
  const stripped = buildRequest({ model: opus, messages, stripThinking: true }).body.messages[1].content;
  assert.deepEqual(stripped.map(block => block.type), ['text', 'tool_use']);
});

test('durable system messages: user content first in each run, consecutive system messages merge, never sent elsewhere', () => {
  const messages = [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'one' }] }, { id: 's1', role: 'system', source: 'system-prompt', content: [{ type: 'text', text: 'revised A' }] }, { id: 's2', role: 'system', source: 'system-prompt', content: [{ type: 'text', text: 'revised B' }] }, { id: 'u2', role: 'user', content: [{ type: 'text', text: 'late steer' }] }];
  const request = buildRequest({ model: opus, messages });
  assert.deepEqual(request.body.messages.map(message => message.role), ['user', 'system']);
  assert.deepEqual(request.body.messages[0].content.map(block => block.text), ['one', 'late steer']);
  assert.deepEqual(request.body.messages[1].content.map(block => block.text), ['revised A', 'revised B']);
  assert.deepEqual(request.blockSources, [['u1', 'u2'], ['s1', 's2']], 'blockSources maps a wire path to its journal message');
  // Claude Sonnet 5 has no mid-conversation system messages: the wire carries none.
  assert.deepEqual(buildRequest({ model: { ...opus, modelId: 'claude-sonnet-5' }, messages }).body.messages.map(message => message.role), ['user']);
  for (const protocol of ['openai', 'openai-codex']) {
    const wire = JSON.stringify(buildRequest({ model: { ...opus, protocol, baseUrl: protocol === 'openai' ? 'https://api.openai.com/v1' : 'https://chatgpt.com/backend-api', modelId: 'gpt-5.4' }, messages: messages.filter(message => message.role !== 'system') }).body);
    assert.equal(wire.includes('revised'), false, `${protocol}: projection never forwards system revisions`);
  }
});

test('cache breakpoints: at most four, the previous tail as a second read point, never on thinking, one TTL', () => {
  const messages = [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'first' }] }, { id: 'a1', role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 'sig' }, { type: 'toolCall', id: 'call_1', name: 'read', arguments: {} }] }, { id: 'r1', role: 'toolResult', toolCallId: 'call_1', content: [{ type: 'text', text: 'result' }] }, { id: 'u2', role: 'user', content: [{ type: 'text', text: 'second' }] }, { id: 's1', role: 'system', source: 'system-prompt', content: [{ type: 'text', text: 'revised' }] }];
  const tools = [{ name: 'read', parameters: { type: 'object' } }];
  const marked = request => JSON.stringify(request.body).match(/cache_control/g)?.length ?? 0;
  for (const retention of ['short', 'long']) {
    const request = buildRequest({ model: opus, systemPrompt: 'S', tools, messages, cache: { retention, previousTailMessageId: 'u1' } });
    assert.equal(marked(request), 4);
    const wire = request.body.messages;
    assert.ok(wire[0].content[0].cache_control, 'B_prev on the previous tail block');
    assert.ok(wire[2].content[1].cache_control, 'B_tail on the last user block, not the trailing system message');
    assert.equal(wire[3].content[0].cache_control, undefined);
    assert.equal(wire[1].content[0].cache_control, undefined, 'never on thinking');
    assert.equal(new Set(JSON.stringify(request.body).match(/"cache_control":\{[^}]*\}/g)).size, 1, 'one TTL for every breakpoint');
  }
  assert.equal(marked(buildRequest({ model: opus, systemPrompt: 'S', tools, messages, cache: { previousTailMessageId: 'missing' } })), 3, 'a tail no longer in the wire adds nothing');
  assert.equal(marked(buildRequest({ model: opus, systemPrompt: 'S', tools, messages, cache: { previousTailMessageId: 'u2' } })), 3, 'the same block is marked once');
});

test('usage, input_transformations and refusals are read from the documented stream fields', async () => {
  assert.equal(normalizeUsage({ input_tokens: 5, output_tokens: 9, output_tokens_details: { thinking_tokens: 7 } }, 'anthropic').reasoningTokens, 7);
  const frames = (stop, extra = {}) => [{ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 }, input_transformations: [{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }, { type: 'Bad Type!' }] } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'x' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: stop, ...extra }, input_transformations: [{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'model_binding_mismatch' }], usage: { output_tokens: 2 } }, { type: 'message_stop' }];
  const fetchOf = list => async () => new Response(list.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  const messages = [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] }, { id: 'a1', role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'prior' }] }, { id: 'u2', role: 'user', content: [{ type: 'text', text: 'next' }] }];
  const events = await Array.fromAsync(streamCompletion({ model: opus, apiKey: KEY, fetch: fetchOf(frames('end_turn')), messages }));
  assert.deepEqual(events.filter(event => event.type === 'input_transformations').map(event => event.items), [[{ type: 'thinking_dropped', reason: 'prefix_binding_mismatch', path: 'messages.1.content.0', sourceMessageId: 'a1' }], [{ type: 'thinking_dropped', reason: 'model_binding_mismatch', path: 'messages.1.content.0', sourceMessageId: 'a1' }]]);
  await assert.rejects(Array.fromAsync(streamCompletion({ model: opus, apiKey: KEY, fetch: fetchOf(frames('refusal', { stop_details: { type: 'refusal', category: 'cyber', explanation: 'private text' } })), messages })), error => {
    assert.equal(error.code, 'provider_termination'); assert.equal(error.providerFinishReason, 'refusal');
    assert.deepEqual(providerDiagnostic(error, 'response'), { category: 'refusal', refusalCategory: 'cyber', retryable: false, purpose: 'response' });
    assert.equal(JSON.stringify(error.errorDiagnostic).includes('private text'), false);
    return true;
  });
});

test('a thinking rejection names the folded position; the source message is resolved back on the wire', async () => {
  // Wire: u1, a1 [thinking, tool_use], user [tool_result], a2 [thinking, text], u2, a3 [thinking, text], u3. The API folds
  // a1 + tool_result + a2 into one assistant turn (measured live, P9), so messages.3 is a3 and a2's thinking is messages.1.content.3.
  const messages = [user('first'), { role: 'assistant', content: [{ type: 'thinking', thinking: 't1', signature: 'sig1' }, { type: 'toolCall', id: 'call_1', name: 'read', arguments: {} }] }, { role: 'toolResult', toolCallId: 'call_1', toolName: 'read', content: [{ type: 'text', text: 'result' }] }, { role: 'assistant', content: [{ type: 'thinking', thinking: 't2', signature: 'sig2' }, { type: 'text', text: 'two' }] }, user('second'), { role: 'assistant', content: [{ type: 'thinking', thinking: 't3', signature: 'sig3' }, { type: 'text', text: 'three' }] }, user('third')].map((message, index) => ({ id: ['u1', 'a1', 'r1', 'a2', 'u2', 'a3', 'u3'][index], ...message }));
  const ok = [{ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'x' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }];
  const rebaseOf = async path => {
    let calls = 0;
    const fetch = async () => calls++ === 0 ? new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `${path}: Invalid \`signature\` in \`thinking\` block.` } }), { status: 400, headers: { 'content-type': 'application/json' } }) : new Response(ok.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    const events = await Array.fromAsync(streamCompletion({ model: opus, apiKey: KEY, fetch, messages }));
    assert.equal(calls, 2, path);
    return events.find(event => event.type === 'thinking_rebase');
  };
  assert.deepEqual(await rebaseOf('messages.3.content.0'), { type: 'thinking_rebase', reason: 'invalid_signature', recovery: 'strip', path: 'messages.3.content.0', sourceMessageId: 'a3' }, 'a3, not the wire message 3 (a2)');
  assert.equal((await rebaseOf('messages.1.content.3')).sourceMessageId, 'a2', 'a block offset past the tool round');
  assert.equal((await rebaseOf('messages.1.content.1')).sourceMessageId, undefined, 'a folded position on a tool_use block names no thinking source');
  assert.equal((await rebaseOf('messages.9.content.0')).sourceMessageId, undefined, 'beyond the conversation');
});

test('cache keep-alive re-sends the same request with max_tokens 0 and no streaming', async () => {
  const fake = createFakeAnthropic({ respond: [[{ text: 'answer' }]] }), input = { model: opus, apiKey: KEY, fetch: fake.fetch, systemPrompt: 'Stable system prompt. '.repeat(40), messages: [user('question '.repeat(60))], cache: { retention: 'short' } };
  await Array.fromAsync(streamCompletion(input));
  const result = await cacheKeepAlive(input), [real, ping] = fake.requests.map(row => row.body);
  assert.equal(ping.max_tokens, 0); assert.equal(ping.stream, undefined);
  const { max_tokens: _a, stream: _b, ...realRest } = real, { max_tokens: _c, ...pingRest } = ping;
  assert.deepEqual(pingRest, realRest, 'byte-identical apart from max_tokens and stream');
  assert.equal(fake.requests[1].headers['x-api-key'], KEY);
  assert.ok(result.usage.cacheRead > 0, 'the ping reads (and so refreshes) the cached prefix');
  assert.equal(result.usage.output, 0); assert.equal(result.stopReason, 'max_tokens');
  await assert.rejects(cacheKeepAlive({ ...input, model: { ...opus, modelId: 'claude-haiku-4-5-20251001', compat: {}, reasoning: 'medium' } }), { code: 'configuration' }, 'enabled (budget) thinking rejects max_tokens 0');
});
