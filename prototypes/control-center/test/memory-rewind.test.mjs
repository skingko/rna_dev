import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.mjs';

// X-2: editing or deleting a message drains the conversation's memory writes while it is cut. The drain must end
// with the rewind, or every later turn of that conversation stays unsynced until the daemon restarts.
async function until(check, timeout = 12000, step = async () => {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await step(); await delay(15); }
  throw new Error('condition did not settle');
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-memory-rewind-'));
  let replies = 0;
  const provider = http.createServer(async (request, response) => {
    for await (const _ of request); // drain the body
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null, usage) => response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
    chunk({ role: 'assistant' }); chunk({ content: `回复${++replies}` }); chunk({}, 'stop', { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });
    response.end('data: [DONE]\n\n');
  });
  // A protocol fixture of the OpenViking session API (create, append, commit, task), not a semantic model.
  const memory = { sessions: new Map(), commits: 0 };
  const viking = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const url = new URL(req.url, 'http://fixture'), body = raw ? JSON.parse(raw) : null;
    const send = result => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', result })); };
    if (url.pathname === '/api/v1/system/status') return send({ initialized: true, user: 'fixture' });
    if (url.pathname === '/api/v1/sessions') { memory.sessions.set(body.session_id, []); return send({ session_id: body.session_id }); }
    const id = url.pathname.split('/')[4];
    if (url.pathname.endsWith('/messages/batch')) { memory.sessions.get(id).push(...body.messages); return send({ added: body.messages.length }); }
    if (url.pathname.endsWith('/commit')) { memory.commits++; return send({ status: 'accepted', archived: true, task_id: `task-${id}` }); }
    if (url.pathname.includes('/tasks/')) return send({ status: 'completed', result: { session_id: url.pathname.split('/').at(-1).slice(5), memories_extracted: {}, token_usage: { total: { total_tokens: 1 } } } });
    res.writeHead(404); res.end();
  });
  await listen(provider); await listen(viking);
  const app = createServer({ stateFile: join(directory, '.state', 'state.json'), ticks: false });
  await app.initializer.close();
  await listen(app.server);
  t.after(async () => { await app.close(); for (const server of [provider, viking]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } rmSync(directory, { recursive: true, force: true }); });
  const p = app.store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'fixture-private-key', models: [{ id: 'fixture-model', contextWindow: 32000, maxOutputTokens: 500, reasoning: ['off'] }] });
  app.store.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { endpoint: `http://127.0.0.1:${viking.address().port}`, autoRecall: false, autoStore: true } });
  const { session, project } = app.store.createProject({ name: 'Rewind memory', workspace: directory, initiative: { enabled: false } });
  const current = () => app.store.state.sessions.find(row => row.id === session.id);
  // The daemon polls every 15 s; the test drives the same pump directly.
  app.executor.memorySync.pollMs = 1;
  const sync = () => Promise.all(app.executor.memorySync.pump());
  return { app, session, project, current, memory, sync, base: `http://127.0.0.1:${app.server.address().port}` };
}

test('after a rewind the conversation keeps syncing: the next turn’s memory write reaches completed (X-2)', async t => {
  const f = await setup(t);
  const turnDone = n => until(() => f.current().turns.length === n && ['completed', 'failed'].includes(f.current().turns.at(-1)?.status));
  f.app.store.message(f.session.id, { text: '第一个问题' }); await turnDone(1);
  await until(() => f.current().turns[0].memoryWrite?.status === 'completed', 12000, f.sync);
  f.app.store.message(f.session.id, { text: '要撤回的问题' }); await turnDone(2);
  const target = f.current().items.find(item => item.kind === 'user' && item.text === '要撤回的问题');
  const response = await fetch(`${f.base}/api/sessions/${f.session.id}/items/${target.id}/rewind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'user_delete' }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).removedTurns, 1);
  assert.equal(f.app.executor.memorySync.drainingSessions.has(f.session.id), false, 'the drain ends with the rewind');
  f.app.store.message(f.session.id, { text: '接着的问题' }); await turnDone(2);
  const turn = () => f.current().turns.at(-1);
  assert.ok(turn().memoryWrite, 'the new turn was enrolled');
  await until(() => turn().memoryWrite?.status === 'completed', 12000, f.sync);
  const uploaded = JSON.stringify([...f.memory.sessions.values()]);
  assert.match(uploaded, /接着的问题/); assert.doesNotMatch(uploaded, /要撤回的问题/, 'the rewound turn never reached memory');
  assert.equal(f.memory.commits, 2);
});

test('a rewind that fails still releases the drain, and holds are counted per caller', async t => {
  const f = await setup(t);
  const sync = f.app.executor.memorySync;
  await sync.drainSession(f.session.id); await sync.drainSession(f.session.id);
  sync.resumeSession(f.session.id); assert.equal(sync.drainingSessions.has(f.session.id), true, 'another caller still holds it');
  sync.resumeSession(f.session.id); assert.equal(sync.drainingSessions.has(f.session.id), false);
  f.app.store.message(f.session.id, { text: '一个问题' });
  await until(() => f.current().turns.length === 1 && f.current().turns[0].status === 'completed');
  const item = f.current().items.find(row => row.kind === 'user');
  // The runtime journal rewind throws after the drain began: the finally still releases it.
  f.app.store.mutate(state => { const session = state.sessions.find(row => row.id === f.session.id); session.runtime = { ...session.runtime, engine: 'rna', sessionFile: join(tmpdir(), 'rna-missing-journal', 'session.jsonl') }; session.turns[0].runtimeMessageId = 'missing-message'; });
  const response = await fetch(`${f.base}/api/sessions/${f.session.id}/items/${item.id}/rewind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'user_edit' }) });
  assert.notEqual(response.status, 200);
  assert.equal(sync.drainingSessions.has(f.session.id), false);
});
