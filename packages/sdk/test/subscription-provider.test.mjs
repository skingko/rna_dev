import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, streamCompletion, resolveJsonOutputContract } from '../src/providers.mjs';
import { createCodexResponseState, consumeCodexEvent, finishCodexResponse } from '../src/subscription-provider.mjs';
const model = { providerId: 'codex-test', protocol: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', modelId: 'gpt-5.3-codex', contextWindow: 400000, maxOutputTokens: 32000, reasoning: 'high', compat: { supportsJsonObject: true }, input: ['text', 'image'] };
const credential = { provider: 'openai-codex', accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token', accountId: 'fake-account', expiresAt: Date.now() + 3600000 };
const completed = output => ({ type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 900 } } } });
const message = text => ({ type: 'message', id: 'msg-test', content: [{ type: 'output_text', text }] });
const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
async function collect(input) { const out = []; for await (const event of streamCompletion(input)) out.push(event); return out; }

test('Codex request uses Responses protocol and stable cache boundary, never Chat Completions fields', () => {
  const input = { model, systemPrompt: 'System', messages: [{ role: 'user', content: 'hello' }], tools: [{ name: 'z', parameters: { type: 'object', properties: {} } }, { name: 'a' }], cache: { sessionKey: 'same-session', retention: 'long' }, responseFormat: { type: 'json_object' }, toolChoice: 'none' };
  const built = buildRequest(input); assert.equal(built.url, 'https://chatgpt.com/backend-api/codex/responses'); assert.equal(built.body.store, false); assert.equal(built.body.instructions, 'System'); assert.equal(built.body.tools[0].name, 'a'); assert.equal(built.body.max_output_tokens, undefined); assert.equal(built.body.max_completion_tokens, undefined); assert.equal(built.body.text.format.type, 'json_object');
  assert.equal(built.body.prompt_cache_key, buildRequest({ ...input, messages: [...input.messages, { role: 'user', content: 'next' }] }).body.prompt_cache_key); assert.equal(resolveJsonOutputContract(model).mode, 'native');
});

test('subscription credentials cannot reach proxy endpoints or API transports', async () => {
  assert.throws(() => buildRequest({ model: { ...model, baseUrl: 'https://proxy.example/backend-api' } }), { code: 'configuration' });
  let dispatched = false; await assert.rejects(collect({ model: { ...model, protocol: 'openai', baseUrl: 'https://api.openai.com/v1' }, messages: [], subscriptionCredential: credential, fetch: async () => { dispatched = true; } }), { code: 'configuration' }); assert.equal(dispatched, false);
});

test('Responses emits text once, preserves cache counts and completed function calls', async () => {
  const events = [{ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hello ' }, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'world' }, completed([message('Hello world'), { type: 'function_call', id: 'fc_test', call_id: 'call-test', name: 'inspect', arguments: '{"file":"a.md"}', status: 'completed' }])];
  let headers; const output = await collect({ model, messages: [], apiKey: async () => credential, fetch: async (_url, init) => { headers = init.headers; return sse(events); } });
  assert.equal(headers.Authorization, 'Bearer fake-access-token'); assert.equal(headers['chatgpt-account-id'], 'fake-account'); assert.equal(headers.originator, 'rna-agent');
  assert.equal(output.filter(e => e.type === 'text_delta').map(e => e.delta).join(''), 'Hello world'); assert.deepEqual(output.find(e => e.type === 'tool_call').arguments, { file: 'a.md' }); assert.equal(output.find(e => e.type === 'usage').usage.cacheRead, 900); assert.equal(output.find(e => e.type === 'usage').usage.cacheUsageReported, true); assert.equal(output.at(-1).stopReason, 'toolUse');
});

test('terminal-only text is delivered; missing terminal and malformed or incomplete tool calls never execute', async () => {
  assert.equal((await collect({ model, messages: [], subscriptionCredential: credential, fetch: async () => sse([completed([message('terminal text')])]) })).find(e => e.type === 'text_delta').delta, 'terminal text');
  for (const events of [
    [{ type: 'response.output_item.added', item: { id: 'fc', type: 'function_call', call_id: 'call', name: 'write', arguments: '{}' } }],
    [completed([{ id: 'fc', type: 'function_call', call_id: 'call', name: 'write', arguments: '{' }])],
    [{ type: 'response.output_item.added', item: { id: 'fc', type: 'function_call', call_id: 'call', name: 'write', arguments: '{}' } }, { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }],
    [{ type: 'response.completed', response: { status: 'failed', output: [] } }],
  ]) { const seen = []; await assert.rejects(async () => { for await (const event of streamCompletion({ model, messages: [], subscriptionCredential: credential, fetch: async () => sse(events) })) seen.push(event); }); assert.equal(seen.some(e => e.type === 'tool_call'), false); }
});

test('encrypted reasoning survives SDK signature round-trip with tool-call correlation', () => {
  const state = createCodexResponseState(model.modelId); consumeCodexEvent(state, completed([{ type: 'reasoning', id: 'rs-test', summary: [], encrypted_content: 'encrypted-test' }, { type: 'function_call', id: 'fc_test', call_id: 'call-test', name: 'read', arguments: '{}' }]));
  const output = finishCodexResponse(state), signature = output.find(e => e.type === 'thinking_signature').signature;
  assert.ok(output.some(e => e.type === 'thinking_delta')); const request = buildRequest({ model, messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature }, { type: 'toolCall', id: 'call-test', name: 'read', arguments: {} }] }, { role: 'toolResult', toolCallId: 'call-test', content: 'data' }] });
  assert.equal(request.body.input[0].encrypted_content, 'encrypted-test'); assert.equal(request.body.input[1].call_id, 'call-test'); assert.equal(request.body.input[1].id, 'fc_test'); assert.equal(request.body.input[2].call_id, 'call-test');
  assert.throws(() => buildRequest({ model, messages: [{ role: 'toolResult', toolCallId: 'unknown', content: 'x' }] }), { code: 'invalid_tool_group' });
});

test('expired access refreshes once only on a rejected HTTP 401; forbidden and partial streams never replay', async () => {
  const authRequests = [], calls = []; let attempt = 0;
  const output = await collect({ model, messages: [], apiKey: async options => { authRequests.push(options); return { ...credential, accessToken: options.forceRefresh ? 'new-access' : 'old-access' }; }, fetch: async (_url, init) => { calls.push(init.headers.Authorization); return attempt++ ? sse([completed([message('ok')])]) : new Response('{}', { status: 401 }); } });
  assert.equal(output.at(-1).stopReason, 'stop'); assert.equal(authRequests.length, 2); assert.equal(authRequests[1].forceRefresh, true); assert.deepEqual(calls, ['Bearer old-access', 'Bearer new-access']);
  let count = 0; await assert.rejects(collect({ model, messages: [], apiKey: async () => { count++; return credential; }, fetch: async () => new Response('{}', { status: 403 }) }), { status: 403 }); assert.equal(count, 1);
  count = 0; await assert.rejects(collect({ model, messages: [], apiKey: async () => { count++; return credential; }, fetch: async () => sse([{ type: 'response.output_text.delta', output_index: 0, delta: 'partial' }]) }), { code: 'incomplete_stream' }); assert.equal(count, 1);
});

test('credential resolver cancellation is prompt even if resolver ignores signal', async () => {
  const abort = new AbortController(), started = Date.now(); setTimeout(() => abort.abort(), 15);
  await assert.rejects(collect({ model, messages: [], signal: abort.signal, apiKey: () => new Promise(() => {}) }), { code: 'aborted' }); assert.ok(Date.now() - started < 1000);
});

test('real SDK session persists Codex reasoning receipts across tool steps and reopen without credentials in the journal', async t => {
  const { createSession } = await import('../src/session.mjs');
  const { mkdtemp, rm, readFile } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'rna-codex-session-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const bodies = []; let requests = 0, resolved = 0, executed = 0;
  const provider = input => streamCompletion({ ...input, fetch: async (_url, init) => { bodies.push(JSON.parse(init.body)); return sse([completed(requests++ === 0 ? [{ type: 'reasoning', id: 'rs_session', summary: [], encrypted_content: 'opaque-session-reasoning' }, { type: 'function_call', id: 'fc_session', call_id: 'call-session', name: 'read_fixture', arguments: '{}', status: 'completed' }] : [message('Complete')])]); } });
  const options = { sessionId: 'codex-session', cwd: dir, stateDir: dir, model, apiKey: async () => { resolved++; return credential; }, provider, tools: [{ name: 'read_fixture', effect: 'read', parameters: { type: 'object', properties: {} }, execute: async () => { executed++; return 'fixture data'; } }] };
  let session = await createSession(options); await session.prompt('Inspect fixture'); assert.equal(executed, 1); assert.equal(resolved, 2); assert.equal(bodies[1].input.find(item => item.type === 'reasoning').encrypted_content, 'opaque-session-reasoning'); assert.equal(bodies[1].input.find(item => item.type === 'function_call').id, 'fc_session');
  const snapshot = session.snapshot(), file = snapshot.sessionFile; await session.dispose();
  assert.equal(JSON.stringify(snapshot).includes('fake-access-token'), false); assert.equal(JSON.stringify(snapshot).includes('fake-refresh-token'), false);
  const journal = await readFile(file, 'utf8'); assert.equal(journal.includes('fake-access-token'), false); assert.equal(journal.includes('fake-refresh-token'), false);
  session = await createSession(options); await session.prompt('Continue consultation'); await session.dispose(); assert.equal(executed, 1); assert.equal(resolved, 3); assert.equal(bodies[2].input.find(item => item.type === 'function_call').id, 'fc_session');
});

test('Codex JSON format is opt-in and provider switches do not replay encrypted receipts', () => {
  const unknown = { ...model, compat: {} }; assert.equal(resolveJsonOutputContract(unknown).mode, 'prompt_only'); assert.throws(() => buildRequest({ model: unknown, responseFormat: { type: 'json_object' } }), { code: 'unsupported_output_contract' });
  const state = createCodexResponseState(model.modelId); consumeCodexEvent(state, completed([{ type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'old-account-data' }])); const signature = finishCodexResponse(state).find(event => event.type === 'thinking_signature').signature;
  const built = buildRequest({ model, messages: [{ role: 'assistant', provider: 'different-account', model: model.modelId, content: [{ type: 'thinking', thinking: '', signature }, { type: 'text', text: 'Visible explanation' }] }] });
  assert.equal(JSON.stringify(built.body).includes('old-account-data'), false); assert.equal(built.body.input[0].role, 'assistant');
});

test('Codex streams are read as pi reads them: an item is final at its own item.done; the terminal receipt only fills gaps', async () => {
  // Live, 2026-10-03: gpt-6-astra answered (30k in, 48 out) and the turn failed as provider_protocol, because the
  // terminal response.completed was required to re-list every streamed item. ChatGPT Codex often sends it without
  // them (pi and mu test against exactly that shape) and pi never asks for it.
  const run = async events => { const seen = []; try { for await (const event of streamCompletion({ model, messages: [], subscriptionCredential: credential, fetch: async () => sse(events) })) seen.push(event); return { seen }; } catch (error) { return { seen, error }; } };
  const text = seen => seen.filter(e => e.type === 'text_delta').map(e => e.delta).join('');
  const bare = { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } } } };
  // mu's Codex fixture: no output_index anywhere, no output on the terminal event.
  const mu = await run([{ type: 'response.output_item.added', item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } }, { type: 'response.content_part.added', part: { type: 'output_text', text: '' } }, { type: 'response.output_text.delta', delta: 'Hello' }, { type: 'response.output_item.done', item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello' }] } }, bare]);
  assert.equal(mu.error, undefined); assert.equal(text(mu.seen), 'Hello'); assert.equal(mu.seen.at(-1).stopReason, 'stop');
  // A call finished by its item.done, reasoning whose encrypted content arrives only on the terminal event, an
  // unknown item type, and a terminal output that omits the message and orders things differently.
  const reasoning = { type: 'reasoning', id: 'rs_1', summary: [] }, call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'project_read', arguments: '' };
  const tool = await run([
    { type: 'response.output_item.added', output_index: 0, item: reasoning }, { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'Looking up.' }, { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'web_search_call', id: 'ws_1' } }, { type: 'response.output_item.done', output_index: 1, item: { type: 'web_search_call', id: 'ws_1', status: 'completed' } },
    { type: 'response.output_item.added', output_index: 2, item: call }, { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc_1', delta: '{"path":' }, { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc_1', delta: '"a.md"}' },
    { type: 'response.output_item.done', output_index: 2, item: { ...call, arguments: '{"path":"a.md"}', status: 'completed' } },
    { type: 'response.completed', response: { status: 'completed', output: [{ ...reasoning, encrypted_content: 'enc-1' }], usage: { input_tokens: 30483, output_tokens: 48 } } },
  ]);
  assert.equal(tool.error, undefined, tool.error?.message);
  assert.deepEqual(tool.seen.filter(e => e.type === 'tool_call'), [{ type: 'tool_call', id: 'call_1', name: 'project_read', arguments: { path: 'a.md' } }]);
  assert.equal(tool.seen.at(-1).stopReason, 'toolUse');
  const receipt = JSON.parse(Buffer.from(tool.seen.find(e => e.type === 'thinking_signature').signature.slice('rna:codex-reasoning:'.length), 'base64url').toString());
  assert.deepEqual(receipt.reasoning, [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-1', summary: [] }]); assert.deepEqual(receipt.toolItems, [{ callId: 'call_1', itemId: 'fc_1' }]);
  // Text already shown stays shown, with or without a matching receipt; a receipt that only exists at the end is delivered.
  for (const [events, expected] of [
    [[{ type: 'response.output_text.delta', output_index: 0, delta: 'claimed completion' }, completed([])], 'claimed completion'],
    [[{ type: 'response.output_text.delta', output_index: 0, item_id: 'msg-original', delta: 'text' }, completed([{ ...message('text'), id: 'msg-different' }])], 'text'],
    [[{ type: 'response.output_text.delta', output_index: 0, delta: 'Hello ' }, completed([message('Hello world')])], 'Hello world'],
    [[{ type: 'response.done', response: { status: 'completed', output: [message('done receipt')] } }], 'done receipt'],
  ]) { const result = await run(events); assert.equal(result.error, undefined, result.error?.message); assert.equal(text(result.seen), expected); }
  // Still refused: duplicate ids in a receipt, a call that never finished, and a call cut off at the output limit.
  for (const events of [
    [completed([{ type: 'function_call', id: 'fc_duplicate', call_id: 'first', name: 'first_tool', arguments: '{}' }, { type: 'function_call', id: 'fc_duplicate', call_id: 'second', name: 'second_tool', arguments: '{}' }])],
    [{ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_missing', call_id: 'first', name: 'first_tool', arguments: '' } }, { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"a":' }, completed([])],
  ]) { const result = await run(events); assert.equal(result.error?.code, 'provider_protocol'); assert.equal(result.seen.some(e => e.type === 'tool_call' || e.type === 'done'), false); }
});

test('provider-reported usage survives a failed Codex response and is kept when the receipt is only partial', async () => {
  const usage = { input_tokens: 500, output_tokens: 60, input_tokens_details: { cached_tokens: 450 } }, expected = { input: 50, output: 60, cacheRead: 450, cacheWrite: 0, totalTokens: 560, costStatus: 'unpriced', cacheUsageReported: true };
  const failed = []; await assert.rejects(async () => { for await (const event of streamCompletion({ model, messages: [], subscriptionCredential: credential, fetch: async () => sse([{ type: 'response.output_text.delta', output_index: 0, delta: 'partial' }, { type: 'response.failed', response: { status: 'failed', usage, error: { message: 'sensitive upstream error' } } }]) })) failed.push(event); }, error => !error.message.includes('sensitive'));
  assert.deepEqual(failed.find(e => e.type === 'usage').usage, expected); assert.equal(failed.some(e => e.type === 'done'), false);
  const partial = await collect({ model, messages: [], subscriptionCredential: credential, fetch: async () => sse([{ type: 'response.output_text.delta', output_index: 0, delta: 'partial' }, { type: 'response.completed', response: { status: 'completed', output: [], usage } }]) });
  assert.deepEqual(partial.find(e => e.type === 'usage').usage, expected); assert.equal(partial.at(-1).type, 'done');
});

test('credential resolver failures cannot disclose credentials in generic or subscription transport diagnostics', async () => {
  for (const selected of [model, { ...model, protocol: 'openai', baseUrl: 'https://api.openai.com/v1' }]) {
    await assert.rejects(collect({ model: selected, messages: [], apiKey: async () => { throw new Error('secret-resolver-value'); } }), error => error.code === 'connection' && !error.message.includes('secret-resolver-value'));
  }
});
