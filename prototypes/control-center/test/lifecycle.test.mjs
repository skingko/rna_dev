import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { createServer } from '../server.mjs';
import { CapabilityService } from '../capability-service.mjs';
import { ProjectInitializer } from '../test-support/marketplace-isolation.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-lifecycle-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, store: new Store(join(directory, 'state.json')) };
}
const selected = (store, id) => store.state.sessions.find(session => session.id === id);
const projectOf = (store, id) => store.state.projects.find(project => project.id === id);
async function until(check) { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw Error('Lifecycle fixture did not settle'); await delay(10); } }
const rejectsArchived = fn => assert.throws(fn, error => error.status === 409 && /归档/.test(error.message));
function model(store) {
  const provider = store.configurationService.provider(null, { name: 'Lifecycle fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:19999/v1', models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 8192 }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' } });
}

test('session archive preserves a turn and inbox, requires explicit resume after restoring, and persists metadata', t => {
  const { store } = fixture(t), { project, session } = store.createProject({ name: 'Archive a conversation' });
  store.message(session.id, { text: 'running turn' });
  store.message(session.id, { text: 'keep this followup', delivery: 'followup' });
  store.presence(project.id, { sessionId: session.id, visible: true, typing: false });
  const archived = store.updateSession(session.id, { archived: true });
  assert.ok(Date.parse(archived.archivedAt)); assert.equal(archived.status, 'paused'); assert.equal(archived.inbox.length, 1);
  assert.equal(store.presences.size, 0); assert.equal(projectOf(store, project.id).primarySessionId, null);
  const before = JSON.stringify(store.state.sessions); store.tick(); assert.equal(JSON.stringify(store.state.sessions), before);
  rejectsArchived(() => store.message(session.id, { text: 'forbidden' }));
  rejectsArchived(() => store.controlSession(session.id, 'resume'));
  rejectsArchived(() => store.presence(project.id, { sessionId: session.id, visible: true, typing: false }));
  const restored = store.updateSession(session.id, { archived: false });
  assert.equal(restored.archivedAt, null); assert.equal(restored.status, 'paused'); assert.equal(restored.inbox[0].text, 'keep this followup');
  store.tick(); assert.equal(selected(store, session.id).status, 'paused');
  assert.equal(projectOf(store, project.id).primarySessionId, session.id);
  store.controlSession(session.id, 'resume'); assert.equal(selected(store, session.id).status, 'running');
  store.updateSession(session.id, { archived: true });
  const reopened = new Store(store.file); assert.equal(reopened.get().sessions[0].archivedAt, selected(store, session.id).archivedAt);
  assert.equal(reopened.state.sessions[0].status, 'paused');
});

test('project archive pauses sessions, model initialization and initiative without losing history or queued work', t => {
  const { store } = fixture(t), { project, session } = store.createProject({ name: 'Project archive', demo: true });
  const other = store.createSession({ projectId: project.id }); store.message(session.id, { text: 'first' }); store.message(other.id, { text: 'second' });
  store.mutate(state => { const p = state.projects[0]; p.initialization = { status: 'queued' }; p.jobs.push({ id: 'job', status: 'queued', evidenceIds: [] }); });
  const archived = store.updateProject(project.id, { archived: true });
  assert.equal(archived.initialization.status, 'paused'); assert.equal(archived.jobs[0].status, 'queued'); assert.equal(archived.initiative.enabled, false);
  assert.ok(store.state.sessions.every(session => session.status === 'paused'));
  rejectsArchived(() => store.createSession({ projectId: project.id }));
  rejectsArchived(() => store.message(session.id, { text: 'forbidden' }));
  rejectsArchived(() => store.controlSession(session.id, 'resume'));
  rejectsArchived(() => store.updateSession(session.id, { archived: false }));
  rejectsArchived(() => store.observeProject(project.id, { kind: 'note', text: 'do not wake' }));
  rejectsArchived(() => store.updateProject(project.id, { initiative: { enabled: true } }));
  const stable = structuredClone(store.state); store.tick(); assert.deepEqual(store.state, stable);
  store.updateProject(project.id, { archived: false }); store.tick();
  assert.equal(projectOf(store, project.id).initiative.enabled, false); assert.equal(projectOf(store, project.id).initialization.status, 'paused');
  assert.ok(store.state.sessions.every(session => session.status === 'paused'));
});

test('archive input is validated and rename remains available on archived records', t => {
  const { store } = fixture(t), { project, session } = store.createProject({ name: 'Original' });
  for (const update of [input => store.updateProject(project.id, input), input => store.updateSession(session.id, input)]) {
    assert.throws(() => update({ archived: 'yes' }), error => error.status === 400);
    assert.throws(() => update({ archivedAt: '2026-01-01' }), error => error.status === 400);
  }
  store.updateSession(session.id, { archived: true, title: 'Renamed session' });
  store.updateProject(project.id, { archived: true, name: 'Renamed project' });
  assert.equal(store.get().projects[0].name, 'Renamed project'); assert.equal(store.get().sessions[0].title, 'Renamed session');
  assert.ok(store.get().projects[0].archivedAt && store.get().sessions[0].archivedAt);
});

test('session archive pauses its autonomous goal and excludes it from time-based wakeups', t => {
  const { store } = fixture(t), { goal, session } = store.createAutonomyDemo();
  store.tick(); assert.equal(selected(store, session.id).status, 'running');
  store.updateSession(session.id, { archived: true });
  assert.equal(store.state.goals[0].status, 'paused');
  rejectsArchived(() => store.controlGoal(goal.id, { action: 'resume' }));
  rejectsArchived(() => store.controlGoal(goal.id, { action: 'advance' }));
  store.updateSession(session.id, { archived: false }); store.tick();
  assert.equal(store.state.goals[0].status, 'paused'); assert.equal(selected(store, session.id).status, 'paused');
});

test('delete session repairs primary selection and cancels evidence jobs without deleting workspace files', t => {
  const { store, directory } = fixture(t), { project, session } = store.createProject({ name: 'Deletion references', workspace: directory });
  const second = store.createSession({ projectId: project.id });
  const evidence = store.observeProject(project.id, { kind: 'context', text: 'evidence', data: { sessionId: session.id } }).observation;
  store.mutate(state => { const p = state.projects[0]; p.jobs.push({ id: 'job', status: 'queued', evidenceIds: [evidence.id], sessionId: session.id }); });
  store.observeProject(project.id, { kind: 'research_result', text: 'late job report', data: { jobId: 'job' } });
  writeFileSync(join(directory, 'evidence.txt'), 'keep real project files');
  store.presence(project.id, { sessionId: session.id, visible: true, typing: false });
  const result = store.deleteSession(session.id), current = projectOf(store, project.id);
  assert.equal(result.deleted, true); assert.deepEqual(current.sessionIds, [second.id]); assert.equal(current.primarySessionId, second.id);
  assert.equal(current.observations[0].status, 'superseded'); assert.equal(current.jobs[0].status, 'cancelled'); assert.equal(current.jobs[0].sessionId, undefined);
  assert.equal(current.observations[1].status, 'superseded');
  assert.equal(store.presences.size, 0); assert.equal(readFileSync(join(directory, 'evidence.txt'), 'utf8'), 'keep real project files');
  assert.throws(() => store.deleteSession(session.id), error => error.status === 404);
  store.deleteSession(second.id); assert.deepEqual(projectOf(store, project.id).sessionIds, []); assert.equal(projectOf(store, project.id).primarySessionId, null);
  const replacement = store.createSession({ projectId: project.id }); assert.equal(projectOf(store, project.id).primarySessionId, replacement.id);
});

test('delete removes goals and candidates so background schedulers cannot resurrect sessions', t => {
  const { store } = fixture(t), { goal, session } = store.createAutonomyDemo();
  store.mutate(state => state.candidates.push({ id: 'goal-candidate', goalId: goal.id }));
  store.deleteSession(session.id); assert.equal(store.state.goals.length, 0); assert.ok(!store.state.candidates.some(candidate => candidate.goalId === goal.id));
  store.tick(); assert.equal(store.state.sessions.length, 0);
});

test('delete project removes all child references but retains unrelated project and private runtime files', t => {
  const { store, directory } = fixture(t), first = store.createProject({ name: 'Delete me' }), other = store.createProject({ name: 'Keep me' });
  const extra = store.createSession({ projectId: first.project.id });
  store.presence(first.project.id, { sessionId: first.session.id, visible: true, typing: false });
  store.mutate(state => { state.goals.push({ id: 'nested-goal', sessionId: extra.id, projectId: first.project.id }); state.candidates.push({ id: 'nested-candidate', goalId: 'nested-goal' }, { id: 'project-candidate', projectId: first.project.id }); });
  const privateFile = join(directory, 'retained-rna-log.jsonl'); writeFileSync(privateFile, 'private retained record');
  const result = store.deleteProject(first.project.id);
  assert.deepEqual(new Set(result.deletedSessionIds), new Set([first.session.id, extra.id]));
  assert.deepEqual(store.state.projects.map(project => project.id), [other.project.id]); assert.deepEqual(store.state.sessions.map(session => session.id), [other.session.id]);
  assert.equal(store.state.goals.length, 0); assert.ok(!store.state.candidates.some(candidate => ['nested-candidate', 'project-candidate'].includes(candidate.id)));
  assert.equal(store.presences.size, 0); assert.equal(readFileSync(privateFile, 'utf8'), 'private retained record');
  assert.throws(() => store.deleteProject(first.project.id), error => error.status === 404);
  assert.throws(() => store.presence(first.project.id, {}), error => error.status === 404);
});

test('HTTP lifecycle routes expose archived entries, validate booleans and return 404 after deletion', async t => {
  const { directory } = fixture(t), app = createServer({ stateFile: join(directory, 'http.json'), ticks: false, runtime: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, method = 'GET', body) => fetch(base + path, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const { project, session } = app.store.createProject({ name: 'HTTP project' });
  assert.equal((await request(`/api/projects/${project.id}`, 'PATCH', { archived: 1 })).status, 400);
  const archive = await request(`/api/sessions/${session.id}`, 'PATCH', { archived: true }); assert.equal(archive.status, 200); assert.ok((await archive.json()).archivedAt);
  assert.equal((await request(`/api/sessions/${session.id}/messages`, 'POST', { text: 'blocked' })).status, 409);
  assert.equal((await (await request('/api/sessions')).json()).length, 1);
  assert.equal((await request(`/api/sessions/${session.id}`, 'PATCH', { archived: false })).status, 200);
  assert.equal((await request(`/api/projects/${project.id}`, 'PATCH', { archived: true })).status, 200);
  assert.equal((await request('/api/sessions', 'POST', { projectId: project.id })).status, 409);
  assert.equal((await request(`/api/projects/${project.id}`, 'DELETE', {})).status, 200);
  assert.equal((await request(`/api/sessions/${session.id}`)).status, 404);
  assert.equal((await request(`/api/sessions/${session.id}`, 'DELETE', {})).status, 404);
});

for (const operation of ['archive', 'delete']) test(`${operation} active runtime aborts HTTP and blocks late replies or queued paid calls`, async t => {
  const { directory } = fixture(t); let calls = 0, streaming;
  const provider = http.createServer(async (request, response) => { for await (const _ of request) {} calls++; streaming = response; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': hold\n\n'); });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const app = createServer({ stateFile: join(directory, 'runtime.json'), ticks: false });
  t.after(async () => { await app.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
  const p = app.store.configurationService.provider(null, { name: 'local fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 8192 }] });
  app.store.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = app.store.createProject({ name: 'Running fixture', workspace: directory });
  app.store.message(session.id, { text: 'running request' }); await until(() => streaming);
  app.store.message(session.id, { text: 'queued request', delivery: 'followup' });
  const turnId = selected(app.store, session.id).activeTurnId;
  if (operation === 'archive') app.store.updateProject(project.id, { archived: true }); else app.store.deleteSession(session.id);
  await until(() => app.executor.running.size === 0);
  assert.equal(calls, 1); app.store.finishRuntimeTurn(session.id, turnId); assert.equal(calls, 1);
  if (operation === 'archive') {
    assert.equal(selected(app.store, session.id).status, 'paused'); assert.equal(selected(app.store, session.id).inbox.length, 1);
    app.store.updateProject(project.id, { archived: false }); await delay(50); assert.equal(calls, 1); assert.equal(selected(app.store, session.id).status, 'paused');
  } else assert.equal(selected(app.store, session.id), undefined);
});

for (const operation of ['archive', 'delete']) test(`${operation} during model initialization ignores a late generated project`, async t => {
  const { store, directory } = fixture(t); model(store); let release, signal;
  const generator = async input => { signal = input.signal; return await new Promise(resolve => { release = resolve; }); };
  const initializer = new ProjectInitializer(store, new CapabilityService(store), { generate: generator }); t.after(() => initializer.close());
  const { project } = store.createProject({ name: 'Initialize race', workspace: directory, initialize: true }); await until(() => release);
  if (operation === 'archive') store.updateProject(project.id, { archived: true }); else store.deleteProject(project.id);
  await until(() => signal.aborted); release({ status: 'ready', overview: 'late result', usage: { totalTokens: 7 } });
  await until(() => initializer.running.size === 0);
  assert.equal(store.state.realUsage.tokens, 7);
  if (operation === 'archive') { assert.equal(projectOf(store, project.id).initialization.status, 'paused'); assert.equal(projectOf(store, project.id).versions.length, 0); store.updateProject(project.id, { archived: false }); await delay(30); assert.equal(projectOf(store, project.id).initialization.status, 'paused'); }
  else assert.equal(projectOf(store, project.id), undefined);
});

test('archived uninitialized projects cannot retry or auto-start after a model is configured', async t => {
  const { store, directory } = fixture(t); let generated = 0;
  const initializer = new ProjectInitializer(store, new CapabilityService(store), { generate: async () => { generated++; throw Error('must not run'); } }); t.after(() => initializer.close());
  const { project } = store.createProject({ name: 'No automatic restart', workspace: directory, initialize: true });
  store.updateProject(project.id, { archived: true }); model(store); await delay(50);
  rejectsArchived(() => initializer.retry(project.id)); assert.equal(generated, 0);
  store.updateProject(project.id, { archived: false }); await delay(50); assert.equal(generated, 0); assert.equal(projectOf(store, project.id).initialization.status, 'paused');
});
