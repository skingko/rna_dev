import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamCompletion, toolArgumentStream } from '../src/providers.mjs';
import { consumeCodexEvent, createCodexResponseState } from '../src/subscription-provider.mjs';
import { createSession } from '../src/session.mjs';

const baseModel = { providerId: 'args-fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 8192, reasoning: 'off' };
async function endpoint(t, frames) {
  const server = createServer(async (request, response) => {
    for await (const _ of request); response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(frames.map(frame => `${frame.event ? `event: ${frame.event}\n` : ''}data: ${typeof frame === 'string' ? frame : JSON.stringify(frame.data ?? frame)}\n\n`).join(''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { ...baseModel, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}
async function collect(model, protocol = 'openai') { const events = []; for await (const row of streamCompletion({ model: { ...model, protocol }, apiKey: 'k', messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'project_read', description: 'r', parameters: { type: 'object' } }], maxRetries: 0 })) events.push(row); return events; }
const progress = events => events.filter(row => row.type === 'toolcall_start' || row.type === 'toolcall_delta');
const argsOf = (events, index) => progress(events).filter(row => row.index === index).map(row => row.argumentsDelta ?? '').join('');
const oa = (tool_calls, finish_reason) => ({ choices: [{ index: 0, delta: tool_calls ? { tool_calls } : {}, ...(finish_reason ? { finish_reason } : {}) }] });

test('OpenAI-compatible split fragments stream as start + deltas; the assembled call is unchanged', async t => {
  const model = await endpoint(t, [
    oa([{ index: 0, id: 'call_a', type: 'function', function: { name: 'project_read', arguments: '' } }]),
    oa([{ index: 0, function: { arguments: '{"pa' } }]), oa([{ index: 0, function: { arguments: 'th":"src/' } }]), oa([{ index: 0, function: { arguments: 'app.ts"}' } }]),
    oa(null, 'tool_calls'), '[DONE]']);
  const events = await collect(model);
  assert.deepEqual(progress(events)[0], { type: 'toolcall_start', index: 0, id: 'call_a', name: 'project_read' });
  assert.equal(argsOf(events, 0), '{"path":"src/app.ts"}');
  assert.deepEqual(events.filter(row => row.type === 'tool_call'), [{ type: 'tool_call', id: 'call_a', name: 'project_read', arguments: { path: 'src/app.ts' } }]);
  // Progress precedes the canonical call, which precedes done.
  const kinds = events.map(row => row.type); assert.ok(kinds.lastIndexOf('toolcall_delta') < kinds.indexOf('tool_call')); assert.equal(kinds.at(-1), 'done');
});

test('OpenAI-compatible parallel calls with late/split names and ids stay keyed by index', async t => {
  const model = await endpoint(t, [
    oa([{ index: 0, function: { arguments: '{"comm' } }]), // arguments before any identity
    oa([{ index: 1, id: 'call_b', function: { name: 'project_', arguments: '{"path":' } }]),
    oa([{ index: 0, id: 'call_a', function: { name: 'project_exec', arguments: 'and":"npm test"}' } }]),
    oa([{ index: 1, function: { name: 'read', arguments: '"README.md"}' } }]),
    oa(null, 'tool_calls'), '[DONE]']);
  const events = await collect(model), rows = progress(events);
  const start0 = rows.find(row => row.type === 'toolcall_start' && row.index === 0), start1 = rows.find(row => row.type === 'toolcall_start' && row.index === 1);
  assert.deepEqual(start0, { type: 'toolcall_start', index: 0, id: 'call_a', name: 'project_exec' });
  assert.equal(rows.indexOf(start0) < rows.findIndex(row => row.index === 0 && row.type === 'toolcall_delta'), true, 'buffered args follow start');
  assert.deepEqual(start1, { type: 'toolcall_start', index: 1, id: 'call_b', name: 'project_' });
  assert.equal(rows.find(row => row.index === 1 && row.type === 'toolcall_delta' && row.name)?.name, 'project_read', 'late name suffix is announced with the full name');
  assert.equal(argsOf(events, 0), '{"command":"npm test"}'); assert.equal(argsOf(events, 1), '{"path":"README.md"}');
  assert.deepEqual(events.filter(row => row.type === 'tool_call').map(row => [row.id, row.name, row.arguments]), [['call_a', 'project_exec', { command: 'npm test' }], ['call_b', 'project_read', { path: 'README.md' }]]);
});

test('providers that do not stream arguments emit only start (complete args in one frame) or nothing new', async t => {
  const whole = await endpoint(t, [oa([{ index: 0, id: 'c', type: 'function', function: { name: 'project_read', arguments: '{"path":"a"}' } }], 'tool_calls'), '[DONE]']);
  const events = await collect(whole);
  assert.deepEqual(progress(events).map(row => row.type), ['toolcall_start', 'toolcall_delta']);
  assert.deepEqual(events.find(row => row.type === 'tool_call').arguments, { path: 'a' });
  const text = await endpoint(t, [{ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] }, '[DONE]']);
  assert.deepEqual(progress(await collect(text)), []);
});

test('Anthropic tool_use blocks stream input_json_delta as progress; initial input still wins when no delta arrives', async t => {
  const model = await endpoint(t, [
    { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 3 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading.' } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'project_read', input: {} } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_2', name: 'web_fetch', input: { url: 'https://example.com' } } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path": "src/' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'main.ts"}' } } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } } },
    { event: 'message_stop', data: { type: 'message_stop' } }]);
  const events = await collect(model, 'anthropic');
  assert.deepEqual(progress(events).filter(row => row.type === 'toolcall_start'), [{ type: 'toolcall_start', index: 1, id: 'toolu_1', name: 'project_read' }, { type: 'toolcall_start', index: 2, id: 'toolu_2', name: 'web_fetch' }]);
  assert.equal(argsOf(events, 1), '{"path": "src/main.ts"}'); assert.equal(argsOf(events, 2), '');
  assert.deepEqual(events.filter(row => row.type === 'tool_call').map(row => row.arguments), [{ path: 'src/main.ts' }, { url: 'https://example.com' }]);
});

test('argument stream helper ignores invalid indices and repeats nothing without change', () => {
  const stream = toolArgumentStream();
  assert.equal(stream.observe(undefined, { name: 'x' }, '{'), null); assert.equal(stream.observe(-1, { name: 'x' }, '{'), null);
  assert.deepEqual(stream.observe(0, { id: 'a', name: 'x', arguments: '' }, ''), [{ type: 'toolcall_start', index: 0, id: 'a', name: 'x' }]);
  assert.equal(stream.observe(0, { id: 'a', name: 'x' }, ''), null);
});

test('Codex Responses function calls stream progress; the completed receipt stays canonical', () => {
  const state = createCodexResponseState('gpt');
  assert.deepEqual(consumeCodexEvent(state, { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'project_exec', arguments: '' } }), [{ type: 'toolcall_start', index: 1, id: 'call_1', name: 'project_exec' }]);
  assert.deepEqual(consumeCodexEvent(state, { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"command":"ls"' }), [{ type: 'toolcall_delta', index: 1, id: 'call_1', argumentsDelta: '{"command":"ls"' }]);
});

test('session surfaces tool progress as transient message_update events and never journals them', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-args-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const events = []; let requests = 0;
  const lookup = { name: 'lookup', description: 'r', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, effect: 'read', execute: async () => 'ok' };
  const session = await createSession({ sessionId: 's', projectId: 'p', cwd: dir, stateDir: join(dir, 'state'), model: { ...baseModel, baseUrl: 'http://127.0.0.1:9' }, tools: [lookup], onEvent: event => events.push(event), provider: async function* () {
    if (!requests++) {
      yield { type: 'toolcall_start', index: 0, id: 'call-1', name: 'lookup' };
      for (const part of ['{"que', 'ry":"sec', 'ret-fragment"}']) yield { type: 'toolcall_delta', index: 0, id: 'call-1', argumentsDelta: part };
      yield { type: 'toolcall_delta', index: 'bad', argumentsDelta: 'ignored' };
      yield { type: 'tool_call', id: 'call-1', name: 'lookup', arguments: { query: 'secret-fragment' } }; yield { type: 'done', stopReason: 'toolUse' };
    } else { yield { type: 'text_delta', delta: 'done' }; yield { type: 'done', stopReason: 'stop' }; }
  } });
  t.after(() => session.dispose());
  await session.prompt('go');
  const updates = events.filter(event => event.type === 'message_update' && event.transient);
  assert.deepEqual(updates.map(event => event.assistantMessageEvent.type), ['toolcall_start', 'toolcall_delta', 'toolcall_delta', 'toolcall_delta']);
  assert.equal(updates.map(event => event.assistantMessageEvent.argumentsDelta ?? '').join(''), '{"query":"secret-fragment"}');
  assert.ok(updates.every(event => event.sessionId === 's' && typeof event.requestId === 'string' && typeof event.messageId === 'string' && Number.isInteger(event.seq)));
  assert.ok(events.findIndex(event => event.transient) < events.findIndex(event => event.type === 'tool_execution_start'));
  const snapshot = session.snapshot(); await session.dispose();
  const journal = await readFile(snapshot.sessionFile, 'utf8');
  assert.equal(journal.includes('toolcall_'), false); assert.equal(journal.includes('argumentsDelta'), false, 'fragments are display-only');
  // Reopening replays the canonical call only.
  const again = await createSession({ sessionId: 's', projectId: 'p', cwd: dir, stateDir: join(dir, 'state'), sessionFile: snapshot.sessionFile, model: { ...baseModel, baseUrl: 'http://127.0.0.1:9' }, tools: [lookup], provider: async function* () { yield { type: 'done' }; } });
  t.after(() => again.dispose());
  const calls = again.snapshot().messages.flatMap(message => (message.content ?? []).filter(part => part.type === 'toolCall'));
  assert.deepEqual(calls.map(call => [call.id, call.arguments]), [['call-1', { query: 'secret-fragment' }]]);
});
