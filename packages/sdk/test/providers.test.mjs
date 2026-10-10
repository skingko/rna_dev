import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildRequest, normalizeUsage, parseSSE, streamCompletion } from '../src/providers.mjs';
const model = { protocol: 'openai', providerId: 'fixture', modelId: 'model', baseUrl: 'https://api.openai.com/v1', maxOutputTokens: 200, contextWindow: 32000, reasoning: 'off' };
const input = { model, systemPrompt: 'stable-prefix', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] };
async function fixture(t, handler) { const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })); return `http://127.0.0.1:${server.address().port}/v1`; }

test('provider mapping preserves stable prefix/tool order, optional native cache key and DeepSeek reasoning/cache fields', () => {
  const tools = ['z', 'a'].map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } }));
  const a = buildRequest({ ...input, tools, cache: { sessionKey: 'session-A' } }), b = buildRequest({ ...input, tools: [...tools].reverse(), cache: { sessionKey: 'session-A' } });
  assert.deepEqual(a, b); assert.equal(a.body.tools[0].function.name, 'a'); assert.equal(a.body.max_completion_tokens, 200); assert.equal(a.body.prompt_cache_key.length, 64);
  const ds = buildRequest({ ...input, model: { ...model, baseUrl: 'https://api.deepseek.com/v1', reasoning: 'max' }, cache: { sessionKey: 'A' } });
  assert.equal(ds.body.max_tokens, 200); assert.equal(ds.body.thinking.type, 'enabled'); assert.equal(ds.body.reasoning_effort, 'max'); assert.equal(ds.body.prompt_cache_key, undefined);
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 80 }), { input: 20, output: 20, cacheRead: 80, cacheWrite: 0, totalTokens: 120, costStatus: 'unpriced', cacheUsageReported: true });
});
test('Anthropic cache boundary, tool results and signed thinking are preserved without changing stable prefix', () => {
  const req = buildRequest({ ...input, model: { ...model, protocol: 'anthropic', maxOutputTokens: 8192, reasoning: 'high' }, tools: [{ name: 'read', parameters: { type: 'object' } }], messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'analysis', signature: 'signed' }, { type: 'toolCall', id: 'c', name: 'read', arguments: {} }] }, { role: 'toolResult', toolCallId: 'c', content: [{ type: 'text', text: 'evidence' }] }] });
  assert.ok(req.url.endsWith('/v1/messages')); assert.equal(req.body.system[0].cache_control.type, 'ephemeral'); assert.equal(req.body.tools[0].cache_control.type, 'ephemeral'); assert.equal(req.body.messages[0].content[0].signature, 'signed'); assert.equal(req.body.messages[1].content[0].tool_use_id, 'c'); assert.equal(req.body.thinking.budget_tokens, 8191);
  assert.deepEqual(normalizeUsage({ input_tokens: 5, output_tokens: 4, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 }, 'anthropic'), { input: 5, output: 4, cacheRead: 20, cacheWrite: 10, totalTokens: 39, costStatus: 'unpriced', cacheUsageReported: true });
});
test('SSE parser handles fragmented UTF8/CRLF/multiline/comments and bounded buffers', async () => {
  const data = new TextEncoder().encode(': ping\r\nevent: msg\r\ndata: 中文\r\ndata: line2\r\n\r\n'), bytes = new ReadableStream({ start(controller) { for (const byte of data) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  assert.deepEqual(await Array.fromAsync(parseSSE(bytes)), [{ event: 'msg', data: '中文\nline2' }]);
  await assert.rejects(Array.fromAsync(parseSSE(new Response('data: big\n\n').body, { maxBytes: 2 })), /大小上限/);
});
test('OpenAI transport assembles tool fragments, normalizes usage, and never persists or returns credentials', async t => {
  const endpoint = await fixture(t, async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer secret-fixture'); let raw = ''; for await (const chunk of req) raw += chunk;
    assert.equal(JSON.parse(raw).max_completion_tokens, 200);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const delta of [{ content: 'ok' }, { tool_calls: [{ index: 0, id: 'call', function: { name: 'read', arguments: '{"path":' } }] }, { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }]) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 12 } } })}\n\ndata: [DONE]\n\n`);
  });
  const events = await Array.fromAsync(streamCompletion({ ...input, model: { ...model, baseUrl: endpoint }, apiKey: 'secret-fixture' }));
  assert.deepEqual(events.find(e => e.type === 'tool_call').arguments, { path: 'x' }); assert.equal(events.at(-1).stopReason, 'toolUse'); assert.equal(events.find(e => e.type === 'usage').usage.cacheRead, 12); assert.ok(!JSON.stringify(events).includes('secret-fixture'));
});
test('transport rejects redirects without forwarding auth, incomplete streams and unsafe endpoint URLs', async t => {
  let targetHits = 0;
  const target = await fixture(t, (_req, res) => { targetHits++; res.end(); });
  const endpoint = await fixture(t, (_req, res) => { res.writeHead(302, { Location: target }); res.end(); });
  await assert.rejects(Array.fromAsync(streamCompletion({ ...input, model: { ...model, baseUrl: endpoint }, apiKey: 'private' })), error => error.code === 'redirect_rejected'); assert.equal(targetHits, 0);
  const broken = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'); });
  await assert.rejects(Array.fromAsync(streamCompletion({ ...input, model: { ...model, baseUrl: broken } })), error => error.code === 'incomplete_stream');
  assert.throws(() => buildRequest({ ...input, model: { ...model, baseUrl: 'http://remote.example/v1' } }), /HTTPS/);
});
test('transport abort closes actual HTTP stream and raw error response cannot expose API keys', async t => {
  let begin;
  const ready = new Promise(resolve => { begin = resolve; });
  const endpoint = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': wait\n\n'); begin(); });
  const controller = new AbortController(); const operation = Array.fromAsync(streamCompletion({ ...input, model: { ...model, baseUrl: endpoint }, signal: controller.signal }));
  await ready; controller.abort(); await assert.rejects(operation, error => error.code === 'aborted');
  const failed = await fixture(t, (_req, res) => { res.writeHead(401); res.end('secret-fixture was invalid'); });
  await assert.rejects(Array.fromAsync(streamCompletion({ ...input, model: { ...model, baseUrl: failed }, apiKey: 'secret-fixture' })), error => error.status === 401 && !error.message.includes('secret-fixture'));
});

test('heartbeat traffic cannot extend the absolute deadline and idle cancellation closes stalled reads', async t => {
  const endpoint = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); const timer = setInterval(() => res.write(': heartbeat\n\n'), 10); res.on('close', () => clearInterval(timer)); });
  await assert.rejects(Array.fromAsync(streamCompletion({ ...input, model: { ...model, baseUrl: endpoint }, idleTimeoutMs: 100, totalTimeoutMs: 75 })), error => error.code === 'total_timeout');
  const idle = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); });
  await assert.rejects(Array.fromAsync(streamCompletion({ ...input, model: { ...model, baseUrl: idle }, idleTimeoutMs: 35, totalTimeoutMs: 500 })), error => error.code === 'idle_timeout');
});

test('explicit 429/503 rejection retries finitely before streaming, honoring Retry-After', async t => {
  let hits = 0;
  const endpoint = await fixture(t, (_req, res) => { hits++; if (hits < 3) { res.writeHead(hits === 1 ? 429 : 503, { 'Retry-After': '0.001' }); res.end(); } else { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); } });
  const events = await Array.fromAsync(streamCompletion({ ...input, model: { ...model, baseUrl: endpoint } }));
  assert.equal(hits, 3); assert.deepEqual(events.filter(event => event.type === 'retry').map(event => event.status), [429, 503]); assert.equal(events.filter(event => event.type === 'text_delta').length, 1);
  let rejected = 0; const always = await fixture(t, (_req, res) => { rejected++; res.writeHead(503, { 'Retry-After': '0' }); res.end(); });
  await assert.rejects(Array.fromAsync(streamCompletion({ ...input, model: { ...model, baseUrl: always } })), error => error.status === 503); assert.equal(rejected, 3);
});

test('partial streams and ambiguous network failures are never automatically reissued', async t => {
  let hits = 0;
  const endpoint = await fixture(t, (_req, res) => { hits++; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"x","function":{"name":"write","arguments":"{}"}}]}}]}\n\n'); });
  const events = [];
  await assert.rejects(async () => { for await (const event of streamCompletion({ ...input, model: { ...model, baseUrl: endpoint } })) events.push(event); }, { code: 'incomplete_stream' });
  assert.equal(hits, 1); assert.ok(!events.some(event => event.type === 'tool_call'));
  let fetches = 0; await assert.rejects(Array.fromAsync(streamCompletion({ ...input, fetch: async () => { fetches++; throw new Error('connection reset after write'); } })), { code: 'connection' }); assert.equal(fetches, 1);
});

test('cancel interrupts provider retry waits and custom iterators without admitting late output', async t => {
  const { iterateCompletion } = await import('../src/providers.mjs');
  let hits = 0; const controller = new AbortController();
  const endpoint = await fixture(t, (_req, res) => { hits++; res.writeHead(429, { 'Retry-After': '50' }); res.end(); });
  await assert.rejects(async () => { for await (const event of streamCompletion({ ...input, model: { ...model, baseUrl: endpoint }, signal: controller.signal })) if (event.type === 'retry') controller.abort(); }, { code: 'aborted' }); assert.equal(hits, 1);
  let release; const wait = new Promise(resolve => { release = resolve; }); let failure;
  await assert.rejects(Array.fromAsync(iterateCompletion(async function* () { await wait; yield { type: 'text_delta', delta: 'late' }; }, input, { timeoutMs: 25 })), error => { failure = error; return error.code === 'total_timeout'; });
  assert.ok(failure.completionPending instanceof Promise); release(); await failure.completionPending;
});

test('Chat projection omits only empty assistant receipts, including failed, interrupted and thinking-only attempts', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'original user' }] }];
  for (const stopReason of ['stop', 'error', 'aborted', 'length']) {
    messages.push({ role: 'assistant', stopReason, content: [] });
    messages.push({ role: 'assistant', stopReason, content: [{ type: 'text', text: ' \n\t' }] });
    messages.push({ role: 'assistant', stopReason, content: [{ type: 'thinking', thinking: 'unfinished internal reasoning' }] });
  }
  messages.push({ role: 'assistant', stopReason: 'aborted', content: [{ type: 'thinking', thinking: 'reasoning retained with text' }, { type: 'text', text: '  actual partial answer\n' }] });
  messages.push({ role: 'assistant', stopReason: 'error', content: [{ type: 'text', text: 'actual failed-attempt text' }] });
  messages.push({ role: 'user', content: [{ type: 'text', text: 'continue current work' }] });
  const before = structuredClone(messages);
  const request = buildRequest({ ...input, systemPrompt: '', model: { ...model, baseUrl: 'https://api.deepseek.com/v1' }, messages });
  assert.deepEqual(request.body.messages, [
    { role: 'user', content: 'original user' },
    { role: 'assistant', content: '  actual partial answer\n', reasoning_content: 'reasoning retained with text' },
    { role: 'assistant', content: 'actual failed-attempt text' },
    { role: 'user', content: 'continue current work' }
  ]);
  assert.deepEqual(messages, before, 'wire filtering must not mutate canonical receipts');
});

test('filtering an empty assistant keeps a complete multi-tool group and its reasoning in order', () => {
  const messages = [
    { role: 'user', content: 'inspect both files' },
    { role: 'assistant', content: [] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'inspect evidence' }, { type: 'toolCall', id: 'a', name: 'read', arguments: { path: 'a.txt' } }, { type: 'toolCall', id: 'b', name: 'read', arguments: { path: 'b.txt' } }] },
    { role: 'toolResult', toolCallId: 'a', content: [{ type: 'text', text: 'result a' }] },
    { role: 'toolResult', toolCallId: 'b', content: [{ type: 'text', text: 'result b' }] },
    { role: 'assistant', stopReason: 'stop', content: [] },
    { role: 'user', content: 'continue' }
  ];
  const wire = buildRequest({ ...input, systemPrompt: '', messages }).body.messages;
  assert.deepEqual(wire.map(message => message.role), ['user', 'assistant', 'tool', 'tool', 'user']);
  assert.equal(wire[1].content, null); assert.equal(wire[1].reasoning_content, 'inspect evidence');
  assert.deepEqual(wire[1].tool_calls.map(call => call.id), ['a', 'b']);
  assert.deepEqual(wire.slice(2, 4).map(message => message.tool_call_id), ['a', 'b']);
});

test('HTTP fixture accepts the retained-user continuation after an empty completed assistant, without inventing text', async t => {
  let hits = 0, captured;
  const endpoint = await fixture(t, async (req, res) => {
    hits++; let raw = ''; for await (const chunk of req) raw += chunk; captured = JSON.parse(raw);
    const invalid = captured.messages.some(message => message.role === 'assistant' && !message.content?.trim() && !message.tool_calls?.length);
    if (invalid) { res.writeHead(400); res.end(JSON.stringify({ error: { message: 'Invalid assistant message: content or tool_calls must be set' } })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"continued"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const messages = [{ role: 'user', content: 'retained original request' }, { role: 'assistant', stopReason: 'stop', content: [] }, { role: 'user', content: 'continue development' }];
  const events = await Array.fromAsync(streamCompletion({ ...input, systemPrompt: '', model: { ...model, baseUrl: endpoint }, messages }));
  assert.equal(hits, 1); assert.deepEqual(captured.messages, [{ role: 'user', content: 'retained original request' }, { role: 'user', content: 'continue development' }]);
  assert.equal(events[0].delta, 'continued'); assert.equal(events.at(-1).type, 'done');
  assert.equal(messages[1].content.length, 0);
});

test('provider requests keep their connection across a gap longer than the default 4 s fetch keep-alive', { timeout: 20000 }, async t => {
  // Like most provider front ends, this server sends no Keep-Alive timeout hint.
  const { createServer } = await import('node:net'); let connections = 0; const open = new Set();
  const body = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
  const server = createServer(socket => {
    connections++; open.add(socket); socket.on('close', () => open.delete(socket)); let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk; const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
      const length = Number(/content-length: *(\d+)/i.exec(buffer.slice(0, end))?.[1] ?? 0); if (Buffer.byteLength(buffer.slice(end + 4)) < length) return;
      buffer = ''; socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { for (const socket of open) socket.destroy(); server.close(resolve); }));
  const call = () => Array.fromAsync(streamCompletion({ ...input, model: { ...model, baseUrl: `http://127.0.0.1:${server.address().port}/v1` } }));
  await call(); await call(); const before = connections;
  await new Promise(resolve => setTimeout(resolve, 4600));
  await call();
  assert.equal(connections, before, 'the idle provider socket is reused instead of a new TCP/TLS handshake');
});
