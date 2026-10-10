import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.mjs';
import { Store } from '../store.mjs';
import { RuntimeController } from '../runtime-controller.mjs';
import { createApiV2, MAX_EVENT_BYTES } from '../api-v2.mjs';
import { INDEX_PROTOCOL } from '../index-schema.mjs';
import { liveBus, toolKind, toolTarget } from '../live-bus.mjs';

async function until(check, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await delay(10); }
  throw new Error('condition did not settle');
}
// Minimal SSE reader: keeps every frame (comments included) in arrival order.
function sse(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path, headers }, response => {
      const events = []; let buffer = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk; let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, index), lines = raw.split('\n'); buffer = buffer.slice(index + 2);
          if (lines.every(line => line.startsWith(':'))) { events.push({ comment: raw }); continue; }
          const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
          events.push({ id: lines.find(line => line.startsWith('id: '))?.slice(4), event: lines.find(line => line.startsWith('event: '))?.slice(7), bytes: Buffer.byteLength(data), data: JSON.parse(data) });
        }
      });
      const closed = new Promise(done => response.on('close', done));
      resolve({ status: response.statusCode, response, events, closed, close: () => request.destroy(), of: type => events.filter(event => event.event === type) });
    });
    request.on('error', reject);
  });
}
const getJson = async (port, path, headers = {}) => { const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers }); return { status: response.status, body: await response.json(), bytes: Number(response.headers.get('content-length')) || null }; };

// ---------- end-to-end through the real SDK + fake providers ----------
async function setup(t, respond, { protocol = 'openai' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-v2-')), calls = [];
  const provider = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    calls.push({ path: request.url, input: raw ? JSON.parse(raw) : {} });
    await respond(calls.at(-1).input, response, calls.length);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const app = createServer({ stateFile: join(directory, '.state', 'state.json'), ticks: false });
  await app.initializer.close();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${provider.address().port}${protocol === 'openai' ? '/v1' : ''}`;
  const p = app.store.configurationService.provider(null, { name: 'Fixture', protocol, baseUrl: base, apiKey: 'fixture-key', models: [{ id: 'fixture-model', contextWindow: 32000, maxOutputTokens: 500, reasoning: ['off'] }] });
  app.store.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { session, project } = app.store.createProject({ name: 'V2 integration', workspace: directory, initiative: { enabled: false } });
  const current = () => app.store.state.sessions.find(item => item.id === session.id);
  return { ...app, directory, calls, current, session, project, port: app.server.address().port };
}
async function openaiStream(res, { thinking = [], text = [], tool, reasoningTokens, gap = 30 } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
  chunk({ role: 'assistant' });
  for (const part of thinking) { chunk({ reasoning_content: part }); await delay(gap); }
  for (const part of text) { chunk({ content: part }); await delay(gap); }
  if (tool) chunk({ tool_calls: [{ index: 0, id: 'tool-fixture', type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] });
  chunk({}, tool ? 'tool_calls' : 'stop', { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42, ...(reasoningTokens !== undefined ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } } : {}) });
  res.end('data: [DONE]\n\n');
}
function reassemble(deltas, itemId, block) {
  let value = '';
  for (const { data } of deltas.filter(row => row.data.itemId === itemId && row.data.block === block)) { assert.equal(data.offset, value.length, `${block} offsets are contiguous`); value += data.append; }
  return value;
}

test('OpenAI reasoning_content is streamed as thinking deltas and persisted with timing and reasoning tokens', async t => {
  const app = await setup(t, (_input, res) => openaiStream(res, { thinking: ['Let me ', 'think ', 'carefully.'], text: ['The ', 'answer ', 'is 4.'], reasoningTokens: 42 }));
  const client = await sse(app.port, `/api/v2/stream?session=${app.session.id}`); t.after(client.close);
  await until(() => client.of('hello').length);
  assert.equal(client.events[0].event, 'hello'); assert.equal(client.events[0].data.protocol, INDEX_PROTOCOL); assert.equal(client.events[0].id, undefined, 'hello carries no resume id');
  app.store.message(app.session.id, { text: '2+2?' });
  await until(() => app.current().turns[0]?.status === 'completed');
  await until(() => client.of('items.upsert').some(row => row.data.items.some(item => item.kind === 'assistant' && item.streaming === false)));
  const item = app.current().items.find(row => row.kind === 'assistant'), turn = app.current().turns[0];
  assert.equal(item.text, 'The answer is 4.');
  assert.equal(item.thinking.text, 'Let me think carefully.'); assert.equal(item.thinking.visibility, 'full'); assert.equal(item.thinking.tokens, 42);
  assert.ok(item.startedAt <= item.firstTokenAt && item.firstTokenAt <= item.endedAt);
  assert.ok(item.thinking.startedAt <= item.thinking.endedAt && item.thinking.endedAt <= item.endedAt);
  assert.equal(turn.firstTokenAt, item.firstTokenAt); assert.ok(turn.startedAt <= turn.firstTokenAt && turn.firstTokenAt <= turn.completedAt);
  assert.equal(item.usage.output, 30);
  const deltas = client.of('delta');
  assert.equal(reassemble(deltas, item.id, 'thinking'), 'Let me think carefully.');
  assert.equal(reassemble(deltas, item.id, 'text'), 'The answer is 4.');
  assert.ok(deltas.filter(row => row.data.block === 'text').length >= 2, 'deltas are frame-coalesced, not batched to the end');
  const phases = client.of('turn.phase').map(row => row.data.phase);
  for (const phase of ['connecting', 'thinking', 'writing', 'finishing']) assert.ok(phases.includes(phase), phase);
  assert.ok(phases.indexOf('thinking') < phases.indexOf('writing'));
  // Monotonic ids; every delta precedes the final full upsert of its block.
  const ids = client.events.filter(row => row.id).map(row => Number(row.id));
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b)); assert.equal(new Set(ids).size, ids.length);
  const final = client.events.findIndex(row => row.event === 'items.upsert' && row.data.items.some(entry => entry.id === item.id && entry.streaming === false));
  assert.ok(client.events.findLastIndex(row => row.event === 'delta' && row.data.itemId === item.id) < final);
  assert.equal(client.events[final].data.items.find(entry => entry.id === item.id).thinking.text, 'Let me think carefully.');
  // While streaming, assistant upserts do not repeat the growing text.
  const streamingUpserts = client.of('items.upsert').flatMap(row => row.data.items).filter(entry => entry.id === item.id && entry.streaming === true);
  assert.ok(streamingUpserts.length <= 4,`streaming item upserts: ${streamingUpserts.length}`);
  assert.ok(client.of('turns.upsert').some(row => row.data.turns.some(entry => entry.id === turn.id && entry.status === 'completed')));
  assert.ok(client.of('session.patch').some(row => row.data.fields.status === 'idle'));
  for (const event of client.events) if (event.bytes) assert.ok(event.bytes <= MAX_EVENT_BYTES);
});

test('reasoning without returned text is kept as hidden thinking with timing and provider token count', async t => {
  const app = await setup(t, (_input, res) => openaiStream(res, { text: ['Done.'], reasoningTokens: 99 }));
  app.store.message(app.session.id, { text: 'hidden reasoning' });
  await until(() => app.current().turns[0]?.status === 'completed');
  const item = app.current().items.find(row => row.kind === 'assistant');
  assert.deepEqual({ ...item.thinking, startedAt: typeof item.thinking.startedAt, endedAt: typeof item.thinking.endedAt }, { text: '', startedAt: 'string', endedAt: 'string', tokens: 99, visibility: 'hidden' });
  assert.equal(item.thinking.endedAt, item.firstTokenAt, 'hidden reasoning spans until the first visible token');
});

test('a model that neither returns nor reports reasoning gets no thinking field', async t => {
  const app = await setup(t, (_input, res) => openaiStream(res, { text: ['Plain.'] }));
  app.store.message(app.session.id, { text: 'plain' });
  await until(() => app.current().turns[0]?.status === 'completed');
  assert.equal(app.current().items.find(row => row.kind === 'assistant').thinking, undefined);
});

test('Anthropic thinking blocks are projected as full thinking, separate from answer text', async t => {
  const app = await setup(t, async (_input, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    send({ type: 'message_start', message: { id: 'msg', usage: { input_tokens: 10, output_tokens: 1 } } });
    send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Weighing ' } }); await delay(30);
    send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'options.' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } });
    send({ type: 'content_block_stop', index: 0 }); await delay(30);
    send({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    send({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Final answer.' } });
    send({ type: 'content_block_stop', index: 1 });
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } });
    send({ type: 'message_stop' }); res.end();
  }, { protocol: 'anthropic' });
  const client = await sse(app.port, `/api/v2/stream?session=${app.session.id}`); t.after(client.close);
  app.store.message(app.session.id, { text: 'think' });
  await until(() => app.current().turns[0]?.status === 'completed');
  const item = app.current().items.find(row => row.kind === 'assistant');
  assert.equal(item.text, 'Final answer.'); assert.equal(item.thinking.text, 'Weighing options.');
  assert.equal(item.thinking.visibility, 'full'); assert.equal(item.thinking.tokens, null);
  await until(() => client.of('delta').some(row => row.data.block === 'text'));
  assert.equal(reassemble(client.of('delta'), item.id, 'thinking'), 'Weighing options.');
});

test('tool items gain kind, target and timing without changing legacy fields', async t => {
  const app = await setup(t, (_input, res, count) => count === 1 ? openaiStream(res, { tool: { name: 'project_list', args: { path: '.' } } }) : openaiStream(res, { text: ['Listed.'] }));
  app.store.message(app.session.id, { text: 'list' });
  await until(() => app.current().turns[0]?.status === 'completed');
  const tool = app.current().items.find(row => row.kind === 'tool').tool;
  assert.equal(tool.name, 'project_list'); assert.equal(tool.status, 'succeeded'); assert.deepEqual(tool.args, { path: '.' });
  assert.equal(tool.kind, 'read'); assert.equal(tool.target, '.'); assert.ok(tool.startedAt <= tool.endedAt);
});

test('tool kind and target cover workspace, web, skill, MCP, question and command tools', () => {
  assert.deepEqual(['project_read', 'project_write', 'project_edit', 'project_grep', 'project_exec', 'web_search', 'web_fetch', 'skill_load', 'mcp__github__search_issues', 'ask_user', 'project_schedule', 'unknown_tool', undefined].map(toolKind), ['read', 'write', 'edit', 'search', 'command', 'web_search', 'web_fetch', 'skill', 'mcp', 'question', 'plan', 'other', 'other']);
  assert.equal(toolTarget('project_exec', { command: 'npm test\n--watch' }), 'npm test');
  assert.equal(toolTarget('project_grep', { pattern: 'TODO', path: 'src' }), 'TODO · src');
  assert.equal(toolTarget('web_fetch', { url: 'https://example.com/a' }), 'https://example.com/a');
  assert.equal(toolTarget('ask_user', { questions: [{ id: 'q', question: 'Deploy now?' }] }), 'Deploy now?');
  assert.equal(toolTarget('mcp__github__search_issues', {}), 'search_issues');
  assert.equal(toolTarget('project_read', { path: 'x'.repeat(400) }).length, 160);
});

// ---------- live delta bus (display-only, no revision) ----------
function displayFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-v2-live-')), store = new Store(join(directory, 'state.json'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const provider = store.configurationService.provider(null, { name: 'Live', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture', models: [{ id: 'live', contextWindow: 32000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'live', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { session } = store.createProject({ name: 'Live', workspace: directory, initiative: { enabled: false } });
  store.message(session.id, { text: 'go' });
  const turnId = store.state.sessions[0].activeTurnId, controller = Object.assign(Object.create(RuntimeController.prototype), { store, closed: false });
  const context = { sessionId: session.id, turnId, cancelled: false, submitted: new Map(), usageKeys: new Set() };
  t.after(() => { clearTimeout(context.flushTimer); clearTimeout(context.live?.timer); });
  const live = []; t.after(liveBus(store).subscribe(event => live.push(event)));
  const send = event => controller.event(context, event);
  const update = (content, type = 'text_delta') => send({ type: 'message_update', message: { id: 'a1', role: 'assistant', content }, assistantMessageEvent: { type } });
  return { store, session, turnId, controller, context, live, send, update, current: () => store.state.sessions[0] };
}

test('live deltas carry offsets, coalesce within one frame and never bump the revision', async t => {
  const f = displayFixture(t);
  f.send({ type: 'message_start', message: { id: 'a1', role: 'assistant', content: [] } });
  const revision = f.store.state.revision, writes = f.store.persistence.writes;
  let text = '';
  for (let index = 0; index < 200; index++) { text += `w${index} `; f.update([{ type: 'text', text }]); }
  await delay(50);
  const deltas = () => f.live.filter(event => event.type === 'delta');
  // The phase change flushes the first token at once; the remaining 199 updates share one frame.
  assert.equal(deltas().length, 2, '200 synchronous updates coalesce');
  assert.deepEqual({ ...deltas()[0], turnId: null }, { type: 'delta', sessionId: f.session.id, turnId: null, itemId: f.context.assistantId, block: 'text', offset: 0, append: 'w0 ' });
  assert.deepEqual([deltas()[1].offset, deltas()[1].append], [3, text.slice(3)]);
  assert.equal(f.store.state.revision, revision, 'live deltas alone do not change the durable revision'); assert.equal(f.store.persistence.writes, writes);
  const before = text.length; text += 'tail';
  f.update([{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text }], 'thinking_delta');
  await delay(50);
  assert.deepEqual(deltas().slice(2).map(event => [event.block, event.offset, event.append]).sort(), [['text', before, 'tail'], ['thinking', 0, 'hmm']]);
  // A non-prefix rewrite is not expressible as an append: no delta, the display projection covers it.
  f.update([{ type: 'text', text: 'rewritten' }]); await delay(50);
  assert.equal(deltas().length, 4);
  assert.deepEqual(f.live.filter(event => event.type === 'turn.phase').map(event => event.phase), ['connecting', 'writing', 'thinking', 'writing']);
  await delay(120);
  const item = f.current().items.find(row => row.kind === 'assistant');
  assert.equal(item.thinking.text, 'hmm'); assert.equal(item.thinking.visibility, 'full'); assert.ok(item.firstTokenAt);
  assert.equal(f.current().turns.at(-1).firstTokenAt, item.firstTokenAt);
  assert.equal(f.store.persistence.writes, writes, 'thinking and timing ride the non-persisting display projection');
});

test('display projection validates the new thinking update and optional firstTokenAt', t => {
  const f = displayFixture(t);
  f.send({ type: 'message_start', message: { id: 'a1', role: 'assistant', content: [] } });
  const base = { sessionId: f.session.id, turnId: f.turnId }, itemId = f.context.assistantId, at = new Date().toISOString();
  const thinking = { text: 'x', startedAt: at, endedAt: null, tokens: null, visibility: 'full' };
  assert.equal(f.store.projectRuntimeDisplay({ ...base, updates: [{ type: 'thinking', itemId, thinking, firstTokenAt: at }] }), true);
  for (const invalid of [
    { type: 'thinking', itemId, thinking: { ...thinking, extra: 1 } },
    { type: 'thinking', itemId, thinking: { ...thinking, visibility: 'loud' } },
    { type: 'thinking', itemId, thinking: { ...thinking, tokens: -1 } },
    { type: 'thinking', itemId, thinking: { ...thinking, text: 'x'.repeat(64001) } },
    { type: 'assistant_text', itemId, text: 'x', firstTokenAt: 'not a time' },
    { type: 'tool_output', itemId, output: 'x', firstTokenAt: at }
  ]) assert.throws(() => f.store.projectRuntimeDisplay({ ...base, updates: [invalid] }), TypeError);
});

// ---------- v2 read API and stream semantics (API module on a plain server) ----------
async function apiFixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-v2-api-')), store = new Store(join(directory, 'state.json')), streams = new Set();
  const api = createApiV2({ store, streams, heartbeatMs: 50, ...options });
  const server = http.createServer((req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try { const url = new URL(req.url, 'http://127.0.0.1'); if (!api.handle(req, res, { pathname: url.pathname, url, send })) send(404, { error: 'missing' }); }
    catch (error) { send(error.status ?? 500, { error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { api.close(); for (const res of streams) res.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const { project, session } = store.createProject({ name: 'API', workspace: directory, initiative: { enabled: false } });
  return { store, api, streams, server, port: server.address().port, project, session, directory };
}
const addItems = (store, sessionId, count, text = index => `message ${index}`) => store.mutate(state => { const session = state.sessions.find(row => row.id === sessionId); for (let index = 0; index < count; index++) session.items.push({ id: randomUUID(), turnId: null, kind: index % 2 ? 'assistant' : 'user', text: text(index), createdAt: new Date(Date.now() + index).toISOString(), simulated: true }); });

test('bootstrap is summary-only and far smaller than the full state', async t => {
  const f = await apiFixture(t);
  addItems(f.store, f.session.id, 400, index => `long message ${index} ${'body '.repeat(200)}`);
  f.store.mutate(state => { const project = state.projects[0]; project.versions = Array.from({ length: 30 }, (_, index) => ({ id: `v${index}`, version: `0.${index}.0`, title: `Version ${index}`, simulated: true, bundle: { blob: 'x'.repeat(5000) } })); project.activeVersionId = 'v29'; project.jobs = [{ id: 'j1', status: 'running' }, { id: 'j2', status: 'completed' }]; });
  const { status, body } = await getJson(f.port, '/api/v2/bootstrap');
  assert.equal(status, 200); assert.equal(body.protocol, INDEX_PROTOCOL); assert.equal(INDEX_PROTOCOL, 3, 'allowlisted rows'); assert.equal(body.revision, f.store.state.revision);
  for (const key of ['maintenance', 'configuration', 'settings', 'projects', 'sessions', 'emergency']) assert.ok(Object.hasOwn(body, key), key);
  const session = body.sessions.find(row => row.id === f.session.id), project = body.projects.find(row => row.id === f.project.id);
  for (const key of ['items', 'turns', 'inbox', 'submissions', 'artifacts']) assert.equal(session[key], undefined, key);
  assert.equal(session.itemCount, 400); assert.equal(session.status, 'idle'); assert.equal(session.activeTurnId, null); assert.ok(session.lastItemAt);
  assert.ok(session.preview.startsWith('long message 399')); assert.ok(session.preview.length <= 80);
  for (const key of ['versions', 'jobs', 'decisions', 'learningRuntime', 'observations', 'memorySessions', 'facts']) assert.equal(project[key], undefined, key);
  assert.deepEqual(project.counts, { versions: 30, jobs: 2, openTasks: 1, observations: 0, decisions: project.counts.decisions, facts: project.counts.facts, inbox: 0, inboxUnread: 0, lessons: 0, openAgenda: 0, pendingCommitments: 0, overdueCommitments: 0 });
  assert.deepEqual(project.activeVersion, { id: 'v29', version: '0.29.0', title: 'Version 29' });
  assert.ok('rhythmStatus' in project && 'initiativeRuntime' in project);
  assert.equal(project.presence, undefined, 'presence changes with every typing report; the web reads it from no row');
  const size = Buffer.byteLength(JSON.stringify(body)), full = Buffer.byteLength(JSON.stringify(f.store.get()));
  assert.ok(size * 20 < full, `bootstrap ${size} bytes vs full state ${full} bytes`);
  const detail = await getJson(f.port, `/api/v2/sessions/${f.session.id}`);
  assert.equal(detail.body.items.length, 400); assert.equal(detail.body.revision, f.store.state.revision);
  assert.equal((await getJson(f.port, '/api/v2/sessions/missing')).status, 404);
  const itemId = f.store.state.sessions[0].items[5].id, one = await getJson(f.port, `/api/v2/sessions/${f.session.id}/items/${itemId}`);
  assert.equal(one.body.item.id, itemId);
  const plain = await getJson(f.port, `/api/v2/projects/${f.project.id}`);
  assert.equal(plain.body.versions, undefined); assert.equal(plain.body.counts.versions, 30);
  assert.ok('presence' in plain.body && 'workspace' in plain.body, 'the project route keeps what the index row leaves out');
  const withVersions = await getJson(f.port, `/api/v2/projects/${f.project.id}?include=versions,jobs`);
  assert.equal(withVersions.body.versions.length, 30); assert.equal(withVersions.body.jobs.length, 2); assert.equal(withVersions.body.decisions, undefined);
  assert.equal((await getJson(f.port, `/api/v2/projects/${f.project.id}?include=secrets`)).status, 400);
});

test('session stream sends only changed items, turns and fields', async t => {
  const f = await apiFixture(t);
  addItems(f.store, f.session.id, 50);
  const client = await sse(f.port, `/api/v2/stream?session=${f.session.id}`); t.after(client.close);
  await until(() => client.of('hello').length);
  const hello = client.of('hello')[0].data;
  assert.equal(hello.revision, f.store.state.revision); assert.equal(typeof hello.seq, 'number');
  const target = f.store.state.sessions[0].items[10].id;
  f.store.mutate(state => { const session = state.sessions[0]; session.items.find(item => item.id === target).text = 'edited'; session.title = 'Renamed'; });
  await until(() => client.of('items.upsert').length && client.of('session.patch').length);
  await delay(80);
  assert.deepEqual(client.of('items.upsert').flatMap(row => row.data.items).map(item => [item.id, item.text]), [[target, 'edited']]);
  const fields = client.of('session.patch').map(row => row.data.fields);
  assert.equal(fields.length, 1); assert.equal(fields[0].title, 'Renamed'); assert.equal(fields[0].items, undefined); assert.equal(fields[0].turns, undefined);
  assert.ok(Object.keys(fields[0]).every(key => ['title', 'updatedAt'].includes(key)), Object.keys(fields[0]).join());
  // Mutations that do not change the session produce nothing for it.
  const sessionEvents = () => client.events.filter(event => ['items.upsert', 'items.remove', 'turns.upsert', 'session.patch'].includes(event.event)).length, count = sessionEvents();
  f.store.mutate(state => { state.settings.maxConcurrent = state.settings.maxConcurrent; });
  await delay(150);
  assert.equal(sessionEvents(), count);
  f.store.mutate(state => { state.sessions[0].items.splice(0, 2); });
  await until(() => client.of('items.remove').length);
  assert.equal(client.of('items.remove')[0].data.ids.length, 2);
  // Oversized single rows are never truncated: the client is told what to re-read.
  const huge = randomUUID();
  f.store.mutate(state => { state.sessions[0].items.push({ id: huge, turnId: null, kind: 'assistant', text: '界'.repeat(30000), createdAt: new Date().toISOString(), simulated: true }); });
  await until(() => client.of('resync').length);
  assert.deepEqual(client.of('resync')[0].data, { reason: 'event_too_large', sessionId: f.session.id, itemIds: [huge] });
  for (const event of client.events) if (event.bytes) assert.ok(event.bytes <= MAX_EVENT_BYTES);
  assert.ok(client.events.some(event => event.comment === ': hb'), 'heartbeat comments are sent');
});

test('index-only stream reports changed summaries and removals, never items', async t => {
  const f = await apiFixture(t);
  const client = await sse(f.port, '/api/v2/stream'); t.after(client.close);
  await until(() => client.of('hello').length);
  addItems(f.store, f.session.id, 3);
  await until(() => client.of('index').length);
  const index = client.of('index')[0].data;
  assert.equal(index.sessions.length, 1); assert.equal(index.sessions[0].itemCount, 3); assert.equal(index.sessions[0].items, undefined);
  assert.equal(client.of('items.upsert').length, 0);
  f.store.mutate(state => { state.sessions = state.sessions.filter(row => row.id !== f.session.id); });
  await until(() => client.of('index').some(row => row.data.removed?.sessions));
  assert.deepEqual(client.of('index').at(-1).data.removed.sessions, [f.session.id]);
});

test('delta events are split below 64KB with contiguous offsets', async t => {
  const f = await apiFixture(t);
  const client = await sse(f.port, `/api/v2/stream?session=${f.session.id}`); t.after(client.close);
  await until(() => client.of('hello').length);
  const append = '字'.repeat(30000);
  liveBus(f.store).publish({ type: 'delta', sessionId: f.session.id, turnId: 't', itemId: 'i', block: 'text', offset: 5, append });
  liveBus(f.store).publish({ type: 'delta', sessionId: 'other-session', turnId: 't', itemId: 'x', block: 'text', offset: 0, append: 'ignored' });
  await until(() => client.of('delta').map(row => row.data.append).join('').length === append.length);
  const deltas = client.of('delta');
  assert.ok(deltas.length > 1); assert.ok(deltas.every(row => row.bytes <= MAX_EVENT_BYTES));
  let offset = 5; for (const { data } of deltas) { assert.equal(data.offset, offset); offset += data.append.length; }
});

test('Last-Event-ID resumes from the ring buffer, else the client is told to resync', async t => {
  const f = await apiFixture(t, { hub: { bufferEvents: 3, retentionMs: -1 } });
  const first = await sse(f.port, `/api/v2/stream?session=${f.session.id}`);
  await until(() => first.of('hello').length);
  liveBus(f.store).publish({ type: 'turn.phase', sessionId: f.session.id, turnId: 't', phase: 'writing', at: new Date().toISOString() });
  await until(() => first.of('turn.phase').length);
  const last = first.of('turn.phase')[0].id; first.close(); await first.closed;
  // Missed while disconnected; the channel keeps its buffer for the resume window.
  for (const append of ['a', 'b']) liveBus(f.store).publish({ type: 'delta', sessionId: f.session.id, turnId: 't', itemId: 'i', block: 'text', offset: append === 'a' ? 0 : 1, append });
  const resumed = await sse(f.port, `/api/v2/stream?session=${f.session.id}`, { 'Last-Event-ID': last }); t.after(resumed.close);
  await until(() => resumed.of('delta').length === 2);
  assert.equal(resumed.events[0].event, 'hello'); assert.equal(resumed.of('resync').length, 0);
  assert.deepEqual(resumed.of('delta').map(row => row.data.append), ['a', 'b']);
  assert.deepEqual(resumed.of('delta').map(row => Number(row.id)), [Number(last) + 1, Number(last) + 2]);
  // Up to date: nothing replayed.
  const current = resumed.of('delta').at(-1).id;
  const fresh = await sse(f.port, `/api/v2/stream?session=${f.session.id}`, { 'Last-Event-ID': current }); t.after(fresh.close);
  await delay(80); assert.equal(fresh.events.filter(event => event.event).length, 1);
  // Trimmed beyond the buffer, from another daemon instance, or garbage: resync.
  for (let index = 0; index < 5; index++) liveBus(f.store).publish({ type: 'delta', sessionId: f.session.id, turnId: 't', itemId: 'i', block: 'text', offset: 2 + index, append: 'c' });
  for (const id of [last, '12', 'not-a-number']) {
    const stale = await sse(f.port, `/api/v2/stream?session=${f.session.id}`, { 'Last-Event-ID': id }); t.after(stale.close);
    await until(() => stale.of('resync').length);
    assert.equal(stale.of('resync')[0].data.reason, 'resume_unavailable'); assert.equal(stale.of('delta').length, 0);
  }
});

test('a slow consumer is closed instead of buffering without bound, and stream limits apply', async t => {
  const f = await apiFixture(t, { maxStreams: 2, backlogBytes: 1024 });
  const writes = [], listeners = {};
  let backlog = 0, ended = false;
  const res = { writeHead() {}, write(text) { writes.push(text); }, end() { ended = true; }, on(event, fn) { listeners[event] = fn; }, get writableLength() { return backlog; }, destroyed: false, get writableEnded() { return ended; } };
  const url = new URL(`http://127.0.0.1/api/v2/stream?session=${f.session.id}`);
  f.api.handle({ method: 'GET', headers: {} }, res, { pathname: url.pathname, url, send: () => assert.fail('no JSON response') });
  const publish = () => liveBus(f.store).publish({ type: 'turn.phase', sessionId: f.session.id, turnId: 't', phase: 'tool', at: new Date().toISOString() });
  publish(); assert.equal(writes.filter(text => text.includes('turn.phase')).length, 1);
  backlog = 4096; publish();
  assert.equal(ended, true); assert.equal(writes.filter(text => text.includes('turn.phase')).length, 1);
  publish(); assert.equal(writes.filter(text => text.includes('turn.phase')).length, 1, 'no writes after close');
  listeners.close();
  assert.equal(f.streams.size, 0);
  const a = await sse(f.port, '/api/v2/stream'), b = await sse(f.port, '/api/v2/stream'); t.after(a.close); t.after(b.close);
  assert.equal((await getJson(f.port, '/api/v2/stream')).status, 429);
  assert.equal((await getJson(f.port, '/api/v2/stream?session=missing')).status, 404);
});

test('the daemon serves v2 under the same host/origin protections and leaves legacy endpoints intact', async t => {
  const app = await setup(t, (_input, res) => openaiStream(res, { text: ['ok'] }));
  assert.equal((await getJson(app.port, '/api/v2/bootstrap')).status, 200);
  assert.equal((await getJson(app.port, '/api/v2/bootstrap', { origin: 'http://evil.example' })).status, 403);
  assert.equal((await getJson(app.port, '/api/v2/bootstrap', { 'sec-fetch-site': 'cross-site' })).status, 403);
  const legacy = await getJson(app.port, '/api/state');
  assert.ok(Array.isArray(legacy.body.sessions[0].items));
  const client = await sse(app.port, '/api/v2/stream'); t.after(client.close);
  await until(() => client.of('hello').length);
  assert.equal((await getJson(app.port, '/api/health')).body.streams, 1);
});

test('turn start publishes real preparation phases and durable turn.timing; memory lookup overlaps composition and a stalled preflight is bounded', async t => {
  const app = await setup(t, (_input, res) => openaiStream(res, { text: ['Ready.'] }));
  app.store.configurationService.update({ memory: { autoRecall: true } });
  let recallStarted = null;
  app.store.memoryService.recall = async () => { recallStarted = Date.now(); await delay(300); return { entries: [], content: '', estimatedTokens: 0, candidateCount: 0, stage: 'summaries' }; };
  // A judgment that never answers must not hold the first request.
  app.executor.decisions = { chat: () => new Promise(() => {}), enabled: () => false };
  const phases = []; const unsubscribe = liveBus(app.store).subscribe(event => { if (event.type === 'turn.phase') phases.push({ phase: event.phase, at: Date.now() }); }); t.after(unsubscribe);
  const sent = Date.now(); app.store.message(app.session.id, { text: 'Status?' });
  await until(() => app.current().turns[0]?.status === 'completed');
  const turn = app.current().turns[0], names = phases.map(row => row.phase);
  for (const phase of ['preparing_workspace', 'preparing_memory', 'preparing_context', 'connecting', 'writing', 'finishing']) assert.ok(names.includes(phase), phase);
  assert.ok(names.indexOf('preparing_workspace') < names.indexOf('preparing_memory') && names.indexOf('preparing_memory') < names.indexOf('preparing_context') && names.indexOf('preparing_context') < names.indexOf('connecting'));
  assert.ok(recallStarted - sent < phases.find(row => row.phase === 'preparing_memory').at - sent, 'the lookup starts at turn start, before composition finishes');
  for (const key of ['queued', 'foreground', 'capabilities', 'orientation', 'journal', 'runtime', 'preparing', 'memory', 'context', 'toRequest', 'request', 'firstToken']) assert.ok(Number.isSafeInteger(turn.timing[key]) && turn.timing[key] >= 0, key);
  assert.ok(turn.timing.firstToken >= turn.timing.toRequest && turn.timing.preparing >= turn.timing.runtime);
  assert.ok(turn.timing.toRequest < 3000, `first request after ${turn.timing.toRequest} ms`);
  assert.deepEqual({ needsMemory: turn.preflight.needsMemory, reason: turn.preflight.reason }, { needsMemory: true, reason: 'preflight_budget' });
  assert.equal(turn.memoryContext.execution, 'empty');
});
