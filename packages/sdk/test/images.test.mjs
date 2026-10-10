import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRequest, streamCompletion } from '../src/providers.mjs';
import { createSession } from '../src/session.mjs';
import { prepareContext, automaticCompactionCandidate } from '../src/context.mjs';
import { normalizeImage, MAX_IMAGE_BYTES, IMAGE_TOKEN_RESERVE } from '../src/images.mjs';

const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6eZkAAAAASUVORK5CYII=' };
const model = { protocol: 'openai', providerId: 'fixture', modelId: 'vision-fixture', input: ['text', 'image'], baseUrl: 'http://127.0.0.1:1/v1', maxOutputTokens: 256, contextWindow: 64000, reasoning: 'off' };
const messages = [{ role: 'user', content: [{ type: 'text', text: 'Inspect the artifact.' }, image] }, { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'capture', arguments: {} }, { type: 'toolCall', id: 'b', name: 'read', arguments: {} }] }, { role: 'toolResult', toolCallId: 'a', toolName: 'capture', content: [image] }, { role: 'toolResult', toolCallId: 'b', toolName: 'read', content: [{ type: 'text', text: 'other result' }] }];
async function fixture(t, handler) { const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })); return `http://127.0.0.1:${server.address().port}/v1`; }
async function sessionFixture(t, extra = {}) { const dir = await mkdtemp(join(tmpdir(), 'rna-images-')); let session; t.after(async () => { await session?.dispose(); await rm(dir, { recursive: true, force: true }); }); session = await createSession({ stateDir: dir, cwd: dir, model, ...extra }); return session; }

for (const protocol of ['openai', 'anthropic']) test(`${protocol} actual HTTP request carries user and tool image pixels with complete tool groups`, async t => {
  let payload;
  const baseUrl = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); payload = JSON.parse(Buffer.concat(chunks));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(protocol === 'openai' ? 'data: {"choices":[{"delta":{"content":"received"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' : 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  await Array.fromAsync(streamCompletion({ model: { ...model, protocol, baseUrl }, messages }));
  if (protocol === 'openai') {
    assert.deepEqual(payload.messages.map(m => m.role), ['user', 'assistant', 'tool', 'tool', 'user']);
    assert.equal(payload.messages[0].content[1].image_url.url, `data:image/png;base64,${image.data}`);
    assert.equal(payload.messages[4].content[1].image_url.url, `data:image/png;base64,${image.data}`);
    assert.match(payload.messages[4].content[0].text, /call "a".*not a new user/);
    assert.deepEqual(payload.messages.slice(2, 4).map(m => m.tool_call_id), ['a', 'b']);
  } else {
    assert.deepEqual(payload.messages.map(m => m.role), ['user', 'assistant', 'user']);
    assert.equal(payload.messages[0].content[1].source.data, image.data);
    assert.equal(payload.messages[2].content[0].content[0].source.data, image.data);
    assert.deepEqual(payload.messages[2].content.map(b => b.tool_use_id), ['a', 'b']);
  }
});
test('invalid, remote, oversized, unsupported-model and incomplete-batch inputs fail before network', async () => {
  for (const bad of [{ ...image, data: 'https://example.test/a.png' }, { ...image, data: 'AQID' }, { ...image, mimeType: 'image/svg+xml' }, { ...image, data: `${image.data}\n` }, { ...image, mimeType: 'image/jpeg' }]) assert.throws(() => normalizeImage(bad), { code: 'invalid_image' });
  assert.throws(() => normalizeImage({ ...image, data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }), { code: 'image_limit' });
  let network = 0;
  for (const [input, code] of [[['text'], 'image_not_supported'], [undefined, 'image_capability_unknown']]) await assert.rejects(Array.fromAsync(streamCompletion({ model: { ...model, input }, messages, fetch: async () => { network++; throw new Error('unexpected'); } })), { code });
  assert.equal(network, 0);
  assert.throws(() => buildRequest({ model, messages: messages.slice(0, -1) }), { code: 'invalid_tool_group' });
  assert.throws(() => buildRequest({ model, messages: [{ role: 'assistant', content: [image] }] }), { code: 'image_role_unsupported' });
  assert.throws(() => buildRequest({ model, messages: [{ role: 'user', content: Array(17).fill(image) }] }), { code: 'image_limit' });
});
test('session retains real pixels in tool and user history without applying text-output truncation or secret substitution', async t => {
  let calls = 0, toolCalls = 0;
  const s = await sessionFixture(t, { apiKey: image.data.slice(15, 23), maxToolOutputBytes: 32, tools: [{ name: 'capture', permission: 'read', idempotent: true, parameters: { type: 'object' }, execute: () => { toolCalls++; return { content: [image] }; } }], provider: async function* (input) { calls++; if (calls === 1) yield { type: 'tool_call', id: 'image', name: 'capture', arguments: {} }; else { assert.equal(input.messages.at(-1).content[0].data, image.data); yield { type: 'text_delta', delta: 'Observed image fixture.' }; } yield { type: 'done' }; } });
  await s.prompt('Inspect', { images: [image] });
  assert.equal(calls, 2); assert.equal(toolCalls, 1); assert.equal(s.snapshot().messages[0].content[1].data, image.data);
  const raw = await readFile(s.snapshot().sessionFile, 'utf8'); assert.ok(raw.includes(image.data));
});
test('text-only tool image yields explicit diagnostic and never retries the completed operation', async t => {
  let calls = 0, executions = 0;
  const s = await sessionFixture(t, { model: { ...model, input: ['text'] }, tools: [{ name: 'capture', parameters: { type: 'object' }, execute: () => { executions++; return { content: [image] }; } }], provider: async function* (input) { calls++; if (calls === 1) yield { type: 'tool_call', id: 'a', name: 'capture', arguments: {} }; else { assert.match(input.messages.at(-1).content[0].text, /image_not_supported/); assert.match(input.messages.at(-1).content[0].text, /尚未读取图片像素/); yield { type: 'text_delta', delta: 'Visual content remains unverified.' }; } yield { type: 'done' }; } });
  await s.prompt('Inspect'); assert.equal(executions, 1); assert.equal(calls, 2);
  await assert.rejects(s.prompt('Image', { images: [image] }), { code: 'image_not_supported' });
});
test('observed image history reaches a text-only model as stable text; only unobserved user pixels fail locally', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-image-switch-')); let s; t.after(async () => { await s?.dispose(); await rm(dir, { recursive: true, force: true }); });
  const requests = [], provider = async function* (request) { requests.push(request); yield { type: 'text_delta', delta: 'The chart shows a red spike.' }; yield { type: 'done' }; };
  const pictures = request => request.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'image') : []);
  s = await createSession({ sessionId: 'same', cwd: dir, stateDir: dir, model, provider });
  await s.prompt('Image', { images: [image] }); const file = s.snapshot().sessionFile; await s.dispose();
  let admitted = 0;
  s = await createSession({ sessionId: 'same', cwd: dir, stateDir: dir, model: { ...model, input: ['text'] }, provider, beforeCompletion: () => { admitted++; } });
  await s.prompt('Continue'); await s.prompt('Again');
  const [first, second] = requests.slice(1);
  assert.equal(pictures(first).length, 0); assert.ok(!JSON.stringify(first.messages).includes(image.data));
  const placeholder = first.messages[0].content.find(block => block.type === 'text' && block.text.startsWith('[Earlier image omitted'));
  assert.match(placeholder.text, /image\/png; \d+ bytes; sha256:[0-9a-f]{16}\. .*"The chart shows a red spike\."/);
  assert.deepEqual(second.messages[0], first.messages[0], 'the placeholder is byte-stable across requests');
  assert.equal(s.snapshot().messages[0].content[1].data, image.data, 'the journal keeps the original pixels');
  await assert.rejects(s.prompt('New picture', { images: [image] }), { code: 'image_not_supported' });
  assert.equal(admitted, 2); await s.dispose();
  // Switching back within the recent user turns restores the pixels.
  s = await createSession({ sessionId: 'same', cwd: dir, stateDir: dir, model: { ...model, input: ['text', 'image'] }, provider });
  await s.prompt('Look again'); assert.equal(pictures(requests.at(-1)).length, 0, 'older than the recent user turns: still text for a vision model');
  await s.dispose();
  const other = join(dir, 'unobserved'); requests.length = 0; admitted = 0;
  s = await createSession({ sessionId: 'fresh', cwd: dir, stateDir: other, model, provider: async function* () { throw Object.assign(new Error('offline'), { code: 'connection' }); } });
  await assert.rejects(s.prompt('Image', { images: [image] })); const journalFile = s.snapshot().sessionFile; await s.dispose();
  const before = (await readFile(journalFile, 'utf8')).split('\n').filter(line => line.includes('"type":"request_started"')).length;
  s = await createSession({ sessionId: 'fresh', cwd: dir, stateDir: other, model: { ...model, input: ['text'] }, provider, beforeCompletion: () => { admitted++; } });
  await assert.rejects(s.prompt('Continue'), { code: 'image_not_supported' });
  assert.equal(admitted, 0); assert.equal(requests.length, 0); assert.equal((await readFile(journalFile, 'utf8')).split('\n').filter(line => line.includes('"type":"request_started"')).length, before);
});
test('images receive admission token reserve and compaction uses explicit nonvisual handles while raw journal remains intact', async t => {
  const text = prepareContext({ messages: [{ role: 'user', content: 'a' }], model }), visual = prepareContext({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, image] }], model });
  assert.ok(visual.estimatedInputTokens >= text.estimatedInputTokens + IMAGE_TOKEN_RESERVE);
  assert.ok(visual.estimatedInputTokens < IMAGE_TOKEN_RESERVE + 2000);
  let summaries = 0;
  const s = await sessionFixture(t, { provider: async function* (request) { if (request.systemPrompt.startsWith('Summarize')) { summaries++; assert.ok(!JSON.stringify(request.messages).includes(image.data)); assert.match(JSON.stringify(request.messages), /Pixels are not included/); yield { type: 'text_delta', delta: 'Earlier user supplied an image. No visual findings have been established.' }; } else yield { type: 'text_delta', delta: 'Fixture observed.' }; yield { type: 'done' }; } });
  await s.prompt('Look', { images: [image] }); await s.prompt('Keep this turn');
  const candidate = automaticCompactionCandidate(s.snapshot().messages, { keepLastGroups: 1 }); assert.ok(candidate); assert.ok(candidate.sourceTokens > 0);
  const result = await s.compact({ keepLastTurns: 1, generate: true }); assert.equal(result.compacted, true); assert.equal(summaries, 1);
  assert.ok((await readFile(s.snapshot().sessionFile, 'utf8')).includes(image.data));
});
test('a text-only model routes tool and user images through describeImages and continues on the description', async t => {
  const requests = [], routed = [];
  const describeImages = async ({ images, question, modelId }) => { routed.push({ count: images.length, question, modelId }); return { text: 'A red error banner reads "Build failed".', model: 'Vision · v1' }; };
  const provider = async function* (input) {
    requests.push(input);
    if (requests.length === 1) yield { type: 'tool_call', id: 'a', name: 'capture', arguments: { url: '/' } }; else yield { type: 'text_delta', delta: 'The build failed.' };
    yield { type: 'done' };
  };
  const s = await sessionFixture(t, { model: { ...model, input: ['text'] }, describeImages, provider, tools: [{ name: 'capture', permission: 'read', idempotent: true, parameters: { type: 'object' }, execute: () => ({ content: [{ type: 'text', text: 'Screenshot:' }, image] }) }] });
  await s.prompt('Check the page');
  const pixels = request => request.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'image') : []);
  assert.equal(requests.flatMap(pixels).length, 0, 'no pixels reach the text-only model');
  const tool = s.snapshot().messages.find(message => message.role === 'toolResult');
  assert.equal(tool.content[0].text, 'Screenshot:');
  assert.match(tool.content[1].text, /analyzed by vision model Vision · v1.*\n.*Build failed/s);
  assert.equal(routed[0].count, 1); assert.match(routed[0].question, /Check the page/); assert.match(routed[0].question, /tool capture \{"url":"\/"\}/);
  await s.prompt('', { images: [image] });
  assert.match(s.snapshot().messages.findLast(message => message.role === 'user').content.at(-1).text, /Build failed/);
  assert.equal(requests.flatMap(pixels).length, 0);
});
test('an unavailable vision route keeps the explicit text-only diagnostic', async t => {
  let calls = 0;
  const s = await sessionFixture(t, { model: { ...model, input: ['text'] }, describeImages: async () => null, tools: [{ name: 'capture', parameters: { type: 'object' }, execute: () => ({ content: [image] }) }], provider: async function* (input) { calls++; if (calls === 1) yield { type: 'tool_call', id: 'a', name: 'capture', arguments: {} }; else assert.match(input.messages.at(-1).content[0].text, /image_not_supported/); yield { type: 'done' }; } });
  await s.prompt('Inspect'); assert.equal(calls, 2);
});
test('HTTP failures carry the provider\'s own error text, bounded and with keys masked', async () => {
  const fetch = async () => new Response(JSON.stringify({ error: { code: 'invalid_image', message: 'Image could not be decoded (key sk-abcdefghijklmnop was used)\n' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  await assert.rejects(Array.fromAsync(streamCompletion({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], fetch, maxRetries: 0 })),
    error => error.status === 400 && /HTTP 400）：Image could not be decoded/.test(error.message) && !error.message.includes('sk-abcdefghijklmnop') && !error.message.includes('\n'));
});
