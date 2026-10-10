import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { projectLearningEpisodes } from '../project-learning-evidence.mjs';
import { sideChatContext } from '../side-chat.mjs';

async function until(check, timeout = 12000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = check(); if (value) return value; await delay(10); } throw new Error('condition did not settle'); }
async function openaiText(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
  chunk({ role: 'assistant' }); chunk({ content: text }); chunk({}, 'stop', { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
  res.end('data: [DONE]\n\n');
}
async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-side-')), calls = [];
  const provider = http.createServer(async (request, response) => { let raw = ''; for await (const chunk of request) raw += chunk; calls.push(raw ? JSON.parse(raw) : {}); await openaiText(response, calls.length === 1 ? 'Parent answer: use a queue.' : `Side answer ${calls.length}.`); });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const app = createServer({ stateFile: join(directory, '.state', 'state.json'), ticks: false });
  await app.initializer.close();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const p = app.store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'fixture-key', models: [{ id: 'fixture-model', contextWindow: 32000, maxOutputTokens: 500, reasoning: ['off'] }] });
  app.store.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { session, project } = app.store.createProject({ name: 'Side chat', workspace: directory, initiative: { enabled: false } });
  const port = app.server.address().port;
  const call = async (method, path, body) => { const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const session$ = id => app.store.state.sessions.find(row => row.id === id);
  return { app, calls, session, project, call, session$ };
}

test('side chat: tail context seed, parent untouched, flagged kind, excluded from initiative evidence, promote', async t => {
  const f = await setup(t);
  f.app.store.message(f.session.id, { text: 'How should we buffer jobs?' });
  await until(() => f.session$(f.session.id).turns[0]?.status === 'completed');
  const answer = f.session$(f.session.id).items.find(row => row.kind === 'assistant');
  const created = await f.call('POST', `/api/v2/sessions/${f.session.id}/side-chats`, { selection: { text: 'use a queue', itemId: answer.id } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const side = created.body;
  assert.equal(side.kind, 'side'); assert.equal(side.parentSessionId, f.session.id); assert.equal(side.projectId, f.project.id); assert.equal(side.mode, 'plan', 'read-only tools by default');
  assert.equal(side.modelSelection.modelId, 'fixture-model'); assert.match(side.title, /use a queue/u); assert.equal(side.sideContext, undefined, 'the seed stays out of summaries');
  assert.equal((await f.call('POST', `/api/v2/sessions/${side.id}/side-chats`, {})).body.code, 'SIDE_CHAT_NESTED');
  assert.equal((await f.call('POST', `/api/v2/sessions/${f.session.id}/side-chats`, { selection: { text: 'x', itemId: 'missing' } })).body.code, 'SIDE_CHAT_SELECTION_INVALID');
  const bootstrap = (await f.call('GET', '/api/v2/bootstrap')).body;
  assert.equal(bootstrap.capabilities.sideChat, true);
  assert.equal(bootstrap.sessions.find(row => row.id === side.id).kind, 'side'); assert.equal(bootstrap.sessions.find(row => row.id === f.session.id).kind, 'main');
  assert.deepEqual((await f.call('GET', `/api/v2/sessions/${f.session.id}/side-chats`)).body.sideChats.map(row => row.id), [side.id]);
  assert.equal((await f.call('GET', `/api/v2/sessions/${side.id}`)).body.sideContext.selection.text, 'use a queue');

  const parentBefore = JSON.stringify(f.session$(f.session.id)), project = () => f.app.store.state.projects.find(row => row.id === f.project.id), observations = project().observations.length;
  f.app.store.message(side.id, { text: 'Why a queue?' });
  await until(() => f.session$(side.id).turns[0]?.status === 'completed');
  assert.equal(JSON.stringify(f.session$(f.session.id)), parentBefore, 'the parent session is untouched');
  assert.equal(project().primarySessionId, f.session.id); assert.equal(project().observations.length, observations, 'no project evidence from side messages');
  // The seed is a named context message at the tail, never in the stable prefix.
  const request = f.calls.at(-1), texts = request.messages.map(row => typeof row.content === 'string' ? row.content : JSON.stringify(row.content));
  const seedIndex = texts.findIndex(text => text.includes('side-chat-parent') || text.includes('side conversation') && text.includes('use a queue'));
  assert.ok(seedIndex > 0, 'side context present'); assert.ok(texts[seedIndex].includes('Parent answer: use a queue.'), 'recent parent turns are included');
  assert.equal(seedIndex, texts.length - 1, 'the seed rides at the context tail (after the side question, like other host hints)');
  assert.ok(texts.findIndex(text => text.includes('Why a queue?')) > 0);
  assert.equal(request.messages[0].role, 'system'); assert.ok(!texts[0].includes('use a queue'), 'never in the cached system prefix');

  // Initiative/learning evidence and delivery targets ignore the side chat.
  const initiative = new ProjectInitiativeController(f.app.store, { initialDelayMs: 999999, tickIntervalMs: 0 }); t.after(() => initiative.close());
  assert.equal(initiative.planning(f.project.id), false, 'a plan-mode side chat does not throttle background work');
  f.app.store.presence(f.project.id, { sessionId: side.id, visible: true, typing: false });
  assert.equal(initiative.presence(project()).session.id, f.session.id);
  assert.ok(!initiative.sources(project(), 'scope').some(row => row.summary.includes('Why a queue?')));
  assert.ok(!JSON.stringify(projectLearningEpisodes(f.app.store.state, project(), 'scope')).includes(side.id));

  // Promote: explicit action only; display note in the parent, idempotent.
  const sideAnswer = f.session$(side.id).items.find(row => row.kind === 'assistant');
  const promoted = await f.call('POST', `/api/v2/sessions/${side.id}/side-chats/promote`, { itemId: sideAnswer.id });
  assert.equal(promoted.status, 200); assert.equal(promoted.body.parentSessionId, f.session.id);
  const note = f.session$(f.session.id).items.at(-1);
  assert.equal(note.kind, 'notice'); assert.equal(note.source, 'side-chat'); assert.equal(note.text, sideAnswer.text); assert.deepEqual(note.sideChat, { sessionId: side.id, itemId: sideAnswer.id, title: side.title });
  assert.equal(f.session$(f.session.id).turns.length, 1, 'promote starts no parent turn');
  assert.equal((await f.call('POST', `/api/v2/sessions/${side.id}/side-chats/promote`, { itemId: sideAnswer.id })).body.duplicate, true);
  assert.equal((await f.call('POST', `/api/v2/sessions/${side.id}/side-chats/promote`, { itemId: f.session$(side.id).items.find(row => row.kind === 'user').id })).status, 400);
  assert.equal((await f.call('POST', `/api/v2/sessions/${f.session.id}/side-chats/promote`, { itemId: answer.id })).status, 409);
  // Deleting the parent removes its side chats.
  const deleted = await f.call("DELETE", `/api/sessions/${f.session.id}`, {}); assert.ok([200, 202].includes(deleted.status), JSON.stringify(deleted));
  assert.equal(f.session$(side.id), undefined);
});

test('side chat context is bounded and skips hidden or streaming items', () => {
  const items = Array.from({ length: 30 }, (_, index) => ({ id: `i${index}`, kind: index % 2 ? 'assistant' : 'user', text: 'x'.repeat(3000), createdAt: String(index) }));
  items.push({ id: 'hidden', kind: 'user', text: 'secret', contextRevoked: true }, { id: 'live', kind: 'assistant', text: 'partial', streaming: true });
  const context = sideChatContext({ id: 'p', title: 'Parent', items }, { text: 'sel' });
  assert.ok(context.recentTurns.length <= 8); assert.ok(context.recentTurns.every(row => row.text.length <= 1201));
  assert.ok(JSON.stringify(context).length < 16000); assert.ok(!JSON.stringify(context).includes('secret')); assert.ok(!JSON.stringify(context).includes('partial'));
  assert.equal(context.recentTurns.at(-1).id, 'i29');
});
