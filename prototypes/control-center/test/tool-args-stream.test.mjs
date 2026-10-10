import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.mjs';
import { Store } from '../store.mjs';
import { RuntimeController } from '../runtime-controller.mjs';
import { createApiV2 } from '../api-v2.mjs';
import { liveBus, partialJsonFields, TARGET_FIELDS, toolTarget } from '../live-bus.mjs';

async function until(check, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await delay(10); }
  throw new Error('condition did not settle');
}

test('partial JSON extractor reads top-level string fields from any streaming prefix', () => {
  const cases = [
    ['', {}], ['{', {}], ['{"pa', {}], ['{"path"', {}], ['{"path": ', {}],
    ['{"path": "src/a', { path: 'src/a' }],
    ['{"path":"src/a.ts","x":{"path":"nested"},"command":"np', { path: 'src/a.ts', command: 'np' }],
    ['{"n":1,"ok":true,"command":"a\\nb\\u00e9 \\"q\\"', { command: 'a\nbé "q"' }],
    ['{"command":"x\\u00', { command: 'x' }], ['{"command":"trailing\\', { command: 'trailing' }],
    ['{"a":["path",{"query":"inner"}],"query":"outer"}', { query: 'outer' }],
    ['{"url":"https://e.com/\\/p"}', { url: 'https://e.com//p' }],
    ['{"path": 42, "query": "q"}', { query: 'q' }],
    ['not json {"path":"late"', { path: 'late' }]
  ];
  for (const [input, expected] of cases) assert.deepEqual(partialJsonFields(input), expected, input);
  assert.deepEqual(partialJsonFields('{"path":"a","path":"b"}'), { path: 'a' }, 'first value wins');
  assert.deepEqual(partialJsonFields(null), {}); assert.deepEqual(partialJsonFields('{"title":"t"}', ['title']), { title: 't' });
  assert.equal(toolTarget('project_exec', partialJsonFields('{"command":"npm te', TARGET_FIELDS)), 'npm te');
  assert.equal(toolTarget('project_read', partialJsonFields('{"path":"src/app.ts"', TARGET_FIELDS)), 'src/app.ts');
});

function displayFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-args-live-')), store = new Store(join(directory, 'state.json'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const provider = store.configurationService.provider(null, { name: 'Live', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture', models: [{ id: 'live', contextWindow: 32000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'live', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { session } = store.createProject({ name: 'Live', workspace: directory, initiative: { enabled: false } });
  store.message(session.id, { text: 'go' });
  const turnId = store.state.sessions[0].activeTurnId, controller = Object.assign(Object.create(RuntimeController.prototype), { store, closed: false });
  const context = { sessionId: session.id, turnId, cancelled: false, submitted: new Map(), usageKeys: new Set() };
  t.after(() => { clearTimeout(context.flushTimer); clearTimeout(context.live?.timer); clearTimeout(context.deferTimer); });
  const live = []; t.after(liveBus(store).subscribe(event => live.push(event)));
  const send = event => controller.event(context, event);
  const progress = (type, index, fields = {}) => send({ type: 'message_update', transient: true, requestId: 'r1', messageId: 'a1', assistantMessageEvent: { type, index, ...fields } });
  return { store, session, turnId, controller, context, live, send, progress, current: () => store.state.sessions[0] };
}

test('streaming tool arguments project a display-only pending entry that the durable tool item supersedes', async t => {
  const f = displayFixture(t);
  f.send({ type: 'message_start', message: { id: 'a1', role: 'assistant', content: [] } });
  const revision = f.store.state.revision, writes = f.store.persistence.writes, items = f.current().items.length;
  f.progress('toolcall_start', 0, { id: 'call-1', name: 'project_read' });
  for (const part of ['{"pa', 'th":"src/', 'app.ts"}']) f.progress('toolcall_delta', 0, { id: 'call-1', argumentsDelta: part });
  f.progress('toolcall_start', 1, { name: 'project_exec' }); // id arrives late
  f.progress('toolcall_delta', 1, { argumentsDelta: '{"command":"npm' });
  await delay(60);
  f.progress('toolcall_delta', 1, { id: 'call-2', argumentsDelta: ' test"}' });
  f.progress('toolcall_delta', 7, { argumentsDelta: 'orphan' }); // never named: nothing published
  f.progress('toolcall_delta', 0, { argumentsDelta: '' }); await delay(60);
  const phases = f.live.filter(event => event.type === 'turn.phase');
  assert.deepEqual(phases.map(event => [event.phase, event.preparing ?? false]), [['connecting', false], ['tool', true]]);
  const deltas = f.live.filter(event => event.type === 'delta');
  assert.ok(deltas.every(event => event.block === 'tool_args' && event.tool.preparing === true));
  const of = index => deltas.filter(event => event.tool.index === index);
  let text = ''; for (const event of of(0)) { assert.equal(event.offset, text.length); text += event.append; }
  assert.equal(text, '{"path":"src/app.ts"}');
  assert.deepEqual(of(0).at(-1).tool, { id: 'call-1', index: 0, name: 'project_read', kind: 'read', target: 'src/app.ts', preparing: true });
  assert.equal(of(0)[0].itemId, 'pending-tool:a1:0');
  assert.deepEqual(of(1).map(event => [event.tool.id ?? null, event.tool.target]), [[null, 'npm'], ['call-2', 'npm test']]);
  assert.equal(deltas.some(event => event.tool.index === 7), false);
  assert.equal(f.store.state.revision, revision, 'pending entries are display-only'); assert.equal(f.store.persistence.writes, writes); assert.equal(f.current().items.length, items);
  // A message_update for another request message is ignored.
  f.send({ type: 'message_update', transient: true, requestId: 'r0', messageId: 'stale', assistantMessageEvent: { type: 'toolcall_start', index: 3, name: 'project_read' } }); await delay(40);
  assert.equal(f.live.filter(event => event.type === 'delta' && event.tool?.index === 3).length, 0);
  // Execution: the durable item carries the same toolCallId; the pending entry stops updating.
  f.send({ type: 'message_end', message: { id: 'a1', role: 'assistant', content: [], stopReason: 'toolUse' } });
  f.send({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'project_read', args: { path: 'src/app.ts' } });
  const phase = f.live.filter(event => event.type === 'turn.phase').at(-1); assert.deepEqual([phase.phase, phase.preparing], ['tool', undefined]);
  const durable = f.current().items.find(row => row.kind === 'tool'); assert.equal(durable.tool.id, 'call-1'); assert.equal(durable.tool.target, 'src/app.ts'); assert.equal(durable.tool.status, 'running');
  assert.equal(f.current().items.some(row => String(row.id).startsWith('pending-tool:')), false);
  assert.equal(f.context.pendingTools.has(0), false); assert.equal(f.context.pendingTools.has(1), true);
  // A new assistant message resets pending state.
  f.send({ type: 'message_start', message: { id: 'a2', role: 'assistant', content: [] } }); assert.equal(f.context.pendingTools, null);
});

test('pending tool previews are bounded and cancelled turns publish nothing', async t => {
  const f = displayFixture(t);
  f.send({ type: 'message_start', message: { id: 'a1', role: 'assistant', content: [] } });
  f.progress('toolcall_start', 0, { id: 'w', name: 'project_write' });
  f.progress('toolcall_delta', 0, { argumentsDelta: `{"path":"big.txt","content":"${'x'.repeat(50000)}` });
  await delay(60);
  const first = f.live.filter(event => event.type === 'delta');
  assert.equal(first.reduce((sum, event) => sum + event.append.length, 0), 2000); assert.equal(first.at(-1).tool.target, 'big.txt');
  f.progress('toolcall_delta', 0, { argumentsDelta: 'more' }); await delay(60);
  assert.equal(f.live.filter(event => event.type === 'delta').length, first.length, 'past the preview cap nothing new is sent while metadata is unchanged');
  f.context.cancelled = true; f.progress('toolcall_start', 1, { id: 'c', name: 'project_exec' }); await delay(60);
  assert.equal(f.live.filter(event => event.type === 'delta').length, first.length);
});

test('tool_args deltas keep their pending-tool metadata on the v2 stream', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-args-api-')), store = new Store(join(directory, 'state.json')), streams = new Set();
  const api = createApiV2({ store, streams, heartbeatMs: 50 });
  const server = http.createServer((req, res) => { const url = new URL(req.url, 'http://127.0.0.1'); if (!api.handle(req, res, { pathname: url.pathname, url, send: (status, value) => { res.writeHead(status); res.end(JSON.stringify(value)); } })) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { api.close(); for (const res of streams) res.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const { session } = store.createProject({ name: 'API', workspace: directory, initiative: { enabled: false } });
  const events = []; const request = http.get({ host: '127.0.0.1', port: server.address().port, path: `/api/v2/stream?session=${session.id}` }, response => {
    let buffer = ''; response.setEncoding('utf8');
    response.on('data', chunk => { buffer += chunk; let index; while ((index = buffer.indexOf('\n\n')) >= 0) { const lines = buffer.slice(0, index).split('\n'); buffer = buffer.slice(index + 2); const event = lines.find(line => line.startsWith('event: '))?.slice(7), data = lines.find(line => line.startsWith('data: '))?.slice(6); if (event) events.push({ event, data: JSON.parse(data) }); } });
  });
  t.after(() => request.destroy());
  await until(() => events.some(row => row.event === 'hello'));
  const tool = { id: 'c1', index: 0, name: 'project_exec', kind: 'command', target: 'npm', preparing: true };
  liveBus(store).publish({ type: 'turn.phase', sessionId: session.id, turnId: 't', phase: 'tool', preparing: true, at: 'now' });
  liveBus(store).publish({ type: 'delta', sessionId: session.id, turnId: 't', itemId: 'pending-tool:m:0', block: 'tool_args', offset: 0, append: '{"command":"npm', tool });
  liveBus(store).publish({ type: 'delta', sessionId: session.id, turnId: 't', itemId: 'pending-tool:m:0', block: 'tool_args', offset: 15, append: '', tool: { ...tool, target: 'npm test' } });
  liveBus(store).publish({ type: 'delta', sessionId: session.id, turnId: 't', itemId: 'a', block: 'text', offset: 0, append: '', tool });
  await until(() => events.filter(row => row.event === 'delta').length >= 2);
  await delay(30);
  assert.deepEqual(events.find(row => row.event === 'turn.phase').data, { sessionId: session.id, turnId: 't', phase: 'tool', preparing: true, at: 'now' });
  assert.deepEqual(events.filter(row => row.event === 'delta').map(row => [row.data.offset, row.data.append, row.data.tool?.target]), [[0, '{"command":"npm', 'npm'], [15, '', 'npm test']]);
});

// ---------- end to end: real SDK, fake OpenAI-compatible provider ----------
test('an OpenAI-compatible stream with fragmented tool arguments reaches the v2 bus, and the journal holds no fragments', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-args-e2e-')); let count = 0;
  const provider = http.createServer(async (request, res) => {
    for await (const _ of request); count++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (count === 1) {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-list', type: 'function', function: { name: 'project_list', arguments: '' } }] }); await delay(30);
      for (const part of ['{"pa', 'th": "', '."}']) { chunk({ tool_calls: [{ index: 0, function: { arguments: part } }] }); await delay(30); }
      chunk({}, 'tool_calls');
    } else { chunk({ content: 'Listed.' }); chunk({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const app = createServer({ stateFile: join(directory, '.state', 'state.json'), ticks: false });
  await app.initializer.close();
  t.after(async () => { await app.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const p = app.store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'fixture-key', models: [{ id: 'fixture-model', contextWindow: 32000, maxOutputTokens: 500, reasoning: ['off'] }] });
  app.store.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { session } = app.store.createProject({ name: 'Args', workspace: directory, initiative: { enabled: false } });
  const live = []; t.after(liveBus(app.store).subscribe(event => { if (event.sessionId === session.id) live.push(event); }));
  app.store.message(session.id, { text: 'list src' });
  const current = () => app.store.state.sessions.find(row => row.id === session.id);
  await until(() => current().turns[0]?.status === 'completed');
  const args = live.filter(event => event.type === 'delta' && event.block === 'tool_args');
  assert.ok(args.length >= 1);
  assert.equal(args.map(event => event.append).join(''), '{"path": "."}');
  assert.deepEqual({ ...args.at(-1).tool }, { id: 'call-list', index: 0, name: 'project_list', kind: 'read', target: '.', preparing: true });
  assert.ok(live.some(event => event.type === 'turn.phase' && event.phase === 'tool' && event.preparing));
  const tools = current().items.filter(row => row.kind === 'tool');
  assert.equal(tools.length, 1); assert.equal(tools[0].tool.id, 'call-list'); assert.deepEqual(tools[0].tool.args, { path: '.' }); assert.equal(tools[0].tool.status, 'succeeded');
  assert.equal(current().items.some(row => String(row.id).startsWith('pending-tool:')), false);
  const journal = readFileSync(current().runtime.sessionFile, 'utf8');
  assert.equal(journal.includes('toolcall_'), false); assert.equal(journal.includes('argumentsDelta'), false);
});
