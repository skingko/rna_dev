import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.mjs';

const exec = promisify(execFile), cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const until = async predicate => { const end = Date.now() + 3000; while (!predicate()) { if (Date.now() >= end) throw new Error('isolated foundation scheduler did not settle'); await delay(10); } };
async function fixture(t, { live = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-foundation-http-cli-')), stateFile = join(dir, 'state.json');
  const app = createServer({ stateFile, ticks: false, runtime: false, initiative: false });
  if (!live) await app.initializer.close();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const makeProject = async (name, saved) => {
    const workspace = join(dir, name); await mkdir(workspace);
    const result = app.store.createProject({ name, workspace, demo: true });
    app.store.mutate(state => { const row = state.projects.find(row => row.id === result.project.id); Object.assign(row, { simulated: false, decisionMode: 'rna-model', initialization: { status: 'ready' }, activeVersionId: 'baseline', trialVersionId: null, versions: [{ id: 'baseline', state: 'active', bundle: { schemaVersion: 1, genome: {}, hash: 'fixture-only' } }], ...(saved ? { skillFoundation: structuredClone(saved) } : {}) }); });
    return result;
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port, base = `http://127.0.0.1:${port}`;
  const request = (id, method = 'GET', body) => fetch(`${base}/api/projects/${id}/skill-foundation`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const command = (...args) => exec(process.execPath, [cli, 'foundation', ...args], { env: { ...process.env, RNA_AGENT_PORT: String(port) }, timeout: 10000 });
  const project = id => app.store.state.projects.find(row => row.id === id);
  return { app, stateFile, request, command, makeProject, project };
}

test('actual HTTP and CLI foundation reads are read-only and return pending or the exact saved status', async t => {
  const f = await fixture(t), { project } = await f.makeProject('Read-only foundation');
  let before = await readFile(f.stateFile);
  const pending = await f.request(project.id); assert.equal(pending.status, 200); assert.deepEqual(await pending.json(), { status: 'pending' });
  const cliPending = await f.command(project.id); assert.equal(cliPending.stderr, ''); assert.deepEqual(JSON.parse(cliPending.stdout), { status: 'pending' });
  assert.deepEqual(await readFile(f.stateFile), before);
  const saved = { schemaVersion: 1, status: 'partial', acquisitionPolicy: 'reuse_only', sourceCount: 1, coverage: [{ id: 'research', status: 'deferred', reasonCode: 'unavailable', skillIds: [] }], failureCount: 0, nextRetryAt: 0 };
  f.app.store.mutate(state => { state.projects.find(row => row.id === project.id).skillFoundation = saved; }); before = await readFile(f.stateFile);
  assert.deepEqual(await (await f.request(project.id)).json(), saved);
  assert.deepEqual(JSON.parse((await f.command(project.id)).stdout), saved);
  assert.equal((await f.request('missing-project')).status, 404);
  for (const args of [[], [project.id, 'start'], [project.id, 'retry', 'extra']]) await assert.rejects(f.command(...args), error => error.code === 1 && /foundation/.test(error.stderr));
  assert.deepEqual(await readFile(f.stateFile), before);
});

test('HTTP policy and CLI retry update only foundation intent and reject invalid values before mutating', async t => {
  const f = await fixture(t), { project, session } = await f.makeProject('Explicit foundation retry', { status: 'failed', failureCount: 3, nextRetryAt: Date.now() + 21600000, sourceCount: 0, acquisitionPolicy: 'automatic' });
  const original = structuredClone(f.project(project.id)), conversation = structuredClone(f.app.store.state.sessions.find(row => row.id === session.id));
  for (const acquisitionPolicy of [true, false, '', 'all', null, 1, {}]) {
    const before = await readFile(f.stateFile), response = await f.request(project.id, 'POST', { acquisitionPolicy });
    assert.equal(response.status, 400); assert.deepEqual(await readFile(f.stateFile), before);
  }
  const queued = await f.request(project.id, 'POST', { acquisitionPolicy: 'reuse_only' }); assert.equal(queued.status, 202);
  const value = await queued.json(); assert.equal(value.status, 'queued'); assert.equal(value.acquisitionPolicy, 'reuse_only'); assert.equal(value.failureCount, 0); assert.equal(value.nextRetryAt, 0); assert.ok(value.requestedAt);
  const retry = JSON.parse((await f.command(project.id, 'retry')).stdout); assert.equal(retry.status, 'queued'); assert.equal(retry.acquisitionPolicy, 'reuse_only');
  assert.equal((await f.request(project.id, 'POST', { acquisitionPolicy: 'automatic' })).status, 202); assert.equal(f.project(project.id).skillFoundation.acquisitionPolicy, 'automatic');
  assert.deepEqual(f.project(project.id).initialization, original.initialization); assert.equal(f.project(project.id).activeVersionId, original.activeVersionId); assert.deepEqual(f.project(project.id).versions, original.versions);
  assert.deepEqual(f.app.store.state.sessions.find(row => row.id === session.id), conversation);
  const before = await readFile(f.stateFile); assert.equal((await f.request('missing-project', 'POST', {})).status, 409); assert.deepEqual(await readFile(f.stateFile), before);
  assert.equal(f.app.initializer.running.size, 0);
});

test('actual host scheduler respects numeric backoff and completed/partial states across projects', async t => {
  const f = await fixture(t, { live: true }), calls = [];
  // Inject only the expensive author operation; HTTP, Store and initializer are
  // the actual host. These tests make zero model or marketplace requests.
  f.app.initializer.foundation = { async run(project) { calls.push(project.id); f.app.store.mutate(state => { state.projects.find(row => row.id === project.id).skillFoundation = { status: 'partial', failureCount: 0, nextRetryAt: 0 }; }); } };
  const cases = [
    ['ready', { status: 'ready', nextRetryAt: 1 }], ['partial', { status: 'partial', nextRetryAt: 1 }],
    ['future', { status: 'failed', failureCount: 1, nextRetryAt: Date.now() + 3600000 }],
    ['ceiling', { status: 'failed', failureCount: 3, nextRetryAt: 1 }],
    ['invalid', { status: 'stale', failureCount: 0, nextRetryAt: 'not-a-timestamp' }],
    ['due', { status: 'failed', failureCount: 1, nextRetryAt: Date.now() - 1000 }],
  ];
  const rows = []; for (const [name, saved] of cases) rows.push(await f.makeProject(name, saved));
  const provider = f.app.store.configurationService.provider(null, { name: 'No-network scheduling fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 8192 }] });
  f.app.store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' } });
  await until(() => calls.length === 1 && !f.app.initializer.running.size); assert.deepEqual(calls, [rows.at(-1).project.id]);
  for (let i = 0; i < 3; i++) f.app.initializer.schedule(); await delay(40); assert.equal(calls.length, 1);
  const future = rows[2].project.id, accepted = await f.request(future, 'POST', {}); assert.equal(accepted.status, 202);
  await until(() => calls.length === 2 && !f.app.initializer.running.size); assert.deepEqual(calls, [rows.at(-1).project.id, future]);
  assert.equal(f.project(future).skillFoundation.status, 'partial'); f.app.initializer.schedule(); await delay(30); assert.equal(calls.length, 2);
});

test('HTTP retry waits for the foreground and a newly admitted turn aborts the same running operation once', async t => {
  const f = await fixture(t, { live: true }), { project, session } = await f.makeProject('Foreground precedence', { status: 'partial' });
  const provider = f.app.store.configurationService.provider(null, { name: 'No-network cancellation fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 8192 }] });
  f.app.store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' } });
  let calls = 0, aborted = 0;
  f.app.initializer.foundation = { async run(row, { signal }) {
    calls++; f.app.store.mutate(state => { state.projects.find(value => value.id === row.id).skillFoundation = { ...state.projects.find(value => value.id === row.id).skillFoundation, status: 'preparing', operationId: 'isolated-operation' }; });
    await new Promise(resolve => signal.addEventListener('abort', () => { aborted++; f.app.store.mutate(state => { const target = state.projects.find(value => value.id === row.id); target.skillFoundation = { ...target.skillFoundation, status: 'stale', failureCount: 0, nextRetryAt: Date.now() + 3600000 }; }); resolve(); }, { once: true }));
  } };
  const foreground = id => f.app.store.mutate(state => { state.sessions.find(row => row.id === session.id).activeTurnId = id; });
  foreground('first-foreground'); assert.equal((await f.request(project.id, 'POST', { acquisitionPolicy: 'reuse_only' })).status, 202);
  await delay(30); assert.equal(calls, 0); assert.equal(f.project(project.id).skillFoundation.status, 'queued');
  foreground(null); await until(() => calls === 1);
  const duplicate = await f.request(project.id, 'POST', {}); assert.equal(duplicate.status, 202); assert.equal((await duplicate.json()).operationId, 'isolated-operation'); assert.equal(calls, 1);
  const samePolicy = await f.request(project.id, 'POST', { acquisitionPolicy: 'reuse_only' }); assert.equal(samePolicy.status, 202); assert.equal((await samePolicy.json()).operationId, 'isolated-operation');
  const beforeConflict = await readFile(f.stateFile), changedPolicy = await f.request(project.id, 'POST', { acquisitionPolicy: 'automatic' });
  assert.equal(changedPolicy.status, 409, 'A running operation cannot silently accept an acquisition-policy change');
  assert.deepEqual(await readFile(f.stateFile), beforeConflict); assert.equal(calls, 1);
  foreground('second-foreground'); await until(() => aborted === 1 && !f.app.initializer.running.size);
  foreground(null); f.app.initializer.schedule(); await delay(40); assert.equal(calls, 1); assert.equal(aborted, 1);
  const saved = await (await f.request(project.id)).json(); assert.equal(saved.status, 'stale'); assert.equal(typeof saved.nextRetryAt, 'number'); assert.ok(saved.nextRetryAt > Date.now()); assert.equal(saved.acquisitionPolicy, 'reuse_only');
});
