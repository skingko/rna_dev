import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { streamCompletion } from '../src/providers.mjs';
import { createFakeAnthropic } from './fixtures/fake-anthropic.mjs';
import { assertAppendOnly } from './helpers/append-only.mjs';

// Synthetic key: the fake endpoint never leaves the process.
const KEY = 'sk-ant-fixture-not-a-real-key';
export const opus = { providerId: 'anthropic', modelId: 'claude-opus-5-5', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', contextWindow: 1000000, maxOutputTokens: 64000, reasoning: 'default', input: ['text', 'image'], compat: { adaptiveThinking: true, thinkingDisplay: 'summarized', thinkingBindingMode: 'error' } };
const providerFor = fake => Object.assign(input => streamCompletion({ ...input, fetch: fake.fetch, maxRetries: 0 }), { meteredBase: streamCompletion });
const readTool = { name: 'read', effect: 'read', idempotent: true, parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false }, execute: async (_id, args) => `contents of ${args.path}` };
// An Opus 5.5 agentic response: summarized reasoning, text, a progress block before each tool call, then redacted.
const agentic = [{ thinking: 'Plan: read both files.' }, { text: 'Reading the files.' }, { progress: 'Checking a.' }, { tool: { id: 'toolu_a', name: 'read', input: { path: 'a' } } }, { progress: '' }, { tool: { id: 'toolu_b', name: 'read', input: { path: 'b' } } }, { redacted: true }];

async function setup(t, { respond, model = opus, ...options } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rna-anthropic-blocks-')), fake = createFakeAnthropic({ respond }), handles = [];
  t.after(async () => { await Promise.allSettled(handles.map(handle => handle.dispose())); await rm(root, { recursive: true, force: true }); });
  const open = async (extra = {}) => { const session = await createSession({ sessionId: 'blocks', cwd: root, stateDir: join(root, 'state'), model, apiKey: KEY, provider: providerFor(fake), tools: [readTool], autoCompaction: false, ...options, ...extra }); handles.push(session); return session; };
  return { fake, open, root };
}

test('Anthropic stream: every content block keeps its index, each thinking block its own signature, redacted data verbatim', async () => {
  const fake = createFakeAnthropic({ respond: [agentic] });
  const events = await Array.fromAsync(streamCompletion({ model: opus, apiKey: KEY, fetch: fake.fetch, systemPrompt: 'S', tools: [readTool], messages: [{ role: 'user', content: 'go' }] }));
  const signatures = events.filter(event => event.type === 'thinking_signature');
  assert.deepEqual(signatures.map(event => event.blockIndex), [0, 2, 4], 'one signature per thinking block, at its own index');
  assert.equal(new Set(signatures.map(event => event.signature)).size, 3);
  assert.deepEqual(signatures.map(event => event.signature), fake.responses[0].content.filter(block => block.type === 'thinking').map(block => block.signature), 'signatures are never concatenated');
  assert.deepEqual(events.filter(event => event.type === 'thinking_delta').map(event => event.blockIndex), [0, 0, 2, 2, 4], 'empty (omitted) thinking is still announced');
  assert.deepEqual(events.filter(event => event.type === 'tool_call').map(event => [event.id, event.blockIndex]), [['toolu_a', 3], ['toolu_b', 5]]);
  assert.deepEqual(events.filter(event => event.type === 'redacted_thinking').map(event => [event.blockIndex, event.data]), [[6, fake.responses[0].content.at(-1).data]]);
  assert.deepEqual(events.filter(event => event.type === 'text_delta').map(event => event.blockIndex), [1]);
});

test('Anthropic stream honours a signature carried by content_block_start', async () => {
  const frames = [{ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'ready', signature: 'sig-from-start' } }, { type: 'content_block_stop', index: 0 }, { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'done' } }, { type: 'content_block_stop', index: 1 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4, output_tokens_details: { thinking_tokens: 2 } } }, { type: 'message_stop' }];
  const fetch = async () => new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  const events = await Array.fromAsync(streamCompletion({ model: opus, apiKey: KEY, fetch, messages: [{ role: 'user', content: 'go' }] }));
  assert.deepEqual(events.find(event => event.type === 'thinking_signature'), { type: 'thinking_signature', signature: 'sig-from-start', blockIndex: 0 });
  assert.deepEqual(events.find(event => event.type === 'text_delta'), { type: 'text_delta', delta: 'done', blockIndex: 1 });
  assert.equal(events.findLast(event => event.type === 'usage').usage.reasoningTokens, 2, 'thinking_tokens reaches reasoningTokens');
});

test('Session journals the response block-exact and replays it verbatim as the next assistant message', async t => {
  const app = await setup(t, { respond: [agentic, [{ thinking: 'Both read.' }, { text: 'Done.' }]] }), session = await app.open();
  await session.prompt('Read a and b.');
  const assistant = session.snapshot().messages.find(message => message.role === 'assistant');
  assert.deepEqual(assistant.content.map(part => part.type), ['thinking', 'text', 'thinking', 'toolCall', 'thinking', 'toolCall', 'redactedThinking']);
  assert.deepEqual(assistant.content.map(part => part.blockIndex), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(assistant.content.filter(part => part.type === 'thinking').map(part => part.signature), app.fake.responses[0].content.filter(block => block.type === 'thinking').map(block => block.signature));
  assert.equal(app.fake.errors.length, 0);
  const [first, second] = app.fake.requests.map(row => row.body);
  assertAppendOnly(first, second, { prevResponse: app.fake.responses[0].content });
  const replayed = second.messages.find(message => message.role === 'assistant');
  assert.deepEqual(replayed.content.map(({ cache_control, ...block }) => block), app.fake.responses[0].content, 'the wire assistant message deep-equals the original response');
});

test('Interjected and aborted partial responses keep no signature and no redacted block', async t => {
  let release;
  const frames = [{ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'partial reasoning' } }, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-partial' } }, { type: 'content_block_stop', index: 0 }, { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'redacted-partial' } }, { type: 'content_block_stop', index: 1 }, { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Starting' } }];
  const hanging = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''))); release = () => controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  for (const mode of ['interject', 'abort']) {
    const root = await mkdtemp(join(tmpdir(), 'rna-anthropic-partial-')); t.after(() => rm(root, { recursive: true, force: true }));
    let calls = 0, session, seen;
    const seenPartial = new Promise(resolve => { seen = resolve; });
    const after = createFakeAnthropic({ respond: [[{ text: 'after' }]] });
    const provider = Object.assign(input => streamCompletion({ ...input, maxRetries: 0, fetch: async (url, init) => { calls++; return calls === 1 ? hanging() : after.fetch(url, init); } }), { meteredBase: streamCompletion });
    session = await createSession({ sessionId: `partial-${mode}`, cwd: root, stateDir: root, model: opus, apiKey: KEY, provider, autoCompaction: false, onEvent: event => { if (event.type === 'message_update' && event.assistantMessageEvent?.delta === 'Starting') seen(); } });
    t.after(() => session.dispose());
    const running = session.prompt('Start.').catch(() => {});
    await seenPartial;
    if (mode === 'interject') { await session.steer('New direction.'); assert.equal(session.interject(), true); }
    else await session.abort();
    try { release?.(); } catch { /* the reader was already cancelled */ }
    await running;
    if (mode === 'interject') assert.equal(after.errors.length, 0, 'the request after an interjection is valid');
    const partial = session.snapshot().messages.find(message => message.role === 'assistant');
    assert.ok(partial.content.some(part => part.type === 'thinking' && part.thinking === 'partial reasoning'), `${mode}: the reasoning text stays in the journal`);
    assert.equal(partial.content.some(part => part.type === 'thinking' && part.signature !== undefined), false, `${mode}: no signature on a partial`);
    assert.equal(partial.content.some(part => part.type === 'redactedThinking'), false, `${mode}: no redacted block on a partial`);
  }
});
