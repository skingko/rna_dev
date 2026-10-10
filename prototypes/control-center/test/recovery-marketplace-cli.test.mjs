import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.mjs';
import { marketplaceFixture } from '../../../packages/sdk/test/fixtures/skill-marketplace.mjs';

const exec = promisify(execFile), cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-recovery-cli-')), workspace = join(directory, 'project'); mkdirSync(workspace);
  const app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false }); await app.initializer.close();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, RNA_AGENT_PORT: String(app.server.address().port) }, calls = [];
  // The CLI's interface-language probe (GET /api/health, cli-language.mjs) is not an operation; only operations are counted.
  app.server.on('request', request => { if (request.url !== '/api/health') calls.push({ method: request.method, path: request.url }); });
  const invoke = (...args) => exec(process.execPath, [cli, ...args], { env, timeout: 15000 });
  t.after(async () => { app.server.closeAllConnections(); await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const { session, project } = app.store.createProject({ name: 'CLI isolation', workspace, initiative: { enabled: false } });
  const current = () => app.store.state.sessions.find(row => row.id === session.id);
  function pending() {
    app.store.message(session.id, { text: 'Original interrupted request' });
    app.store.mutate(state => { const row = state.sessions.find(row => row.id === session.id); row.status = 'paused'; row.pauseReason = 'recovery'; row.turns[0].status = 'paused'; row.turns[0].modelConfig.execution = 'rna'; row.runtime = { recovery: { uncertainTools: [{ callKey: 'assistant-a/command-b', toolName: 'project_exec', requiresResolution: true }] } }; });
  }
  return { ...app, directory, workspace, session, project, current, pending, env, calls, invoke, json: async (...args) => JSON.parse((await invoke(...args)).stdout) };
}

test('CLI views recovery and records an explicit unresolved retirement without resuming, repeating a user message or granting permissions', async t => {
  const f = await fixture(t); f.pending(); const beforePermissions = structuredClone(f.store.state.projects.find(p => p.id === f.project.id).permissions);
  const view = await f.json('recovery', f.session.id); assert.equal(view.recovery.uncertainTools[0].callKey, 'assistant-a/command-b');
  const result = await f.json('recovery', f.session.id, 'resolve', 'assistant-a/command-b', 'abandoned', 'Observed process stopped;', 'outcome remains unknown.');
  assert.equal(result.remaining, 0); assert.equal(f.current().status, 'paused'); assert.equal(f.current().turns.length, 1);
  assert.equal(f.current().turns[0].toolResolutions['assistant-a/command-b'].status, 'abandoned');
  assert.match(f.current().turns[0].toolResolutions['assistant-a/command-b'].note, /outcome remains unknown/);
  assert.deepEqual(f.store.state.projects.find(p => p.id === f.project.id).permissions, beforePermissions);
  assert.equal(f.current().items.filter(row => row.kind === 'user').length, 1);
  assert.equal(f.calls.filter(row => row.path.endsWith('/control')).length, 0);
  const before = f.calls.length;
  for (const args of [['resolve', 'assistant-a/command-b', 'success', 'invalid'], ['resolve', 'assistant-a/command-b', 'completed'], ['resolve', 'assistant-a/command-b', 'abandoned', ' '.repeat(3)]]) await assert.rejects(f.invoke('recovery', f.session.id, ...args), error => error.code === 1);
  assert.equal(f.calls.length, before, 'invalid confirmations never leave the client');
});

test('CLI retry uses the failed real turn once and rejects active or demo retries', async t => {
  const f = await fixture(t);
  const provider = f.store.configurationService.provider(null, { name: 'CLI retry fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', autoDiscoverModels: false, models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 500, reasoning: ['off'], input: ['text'] }] });
  f.store.updateSession(f.session.id, { modelSelection: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' } });
  f.store.message(f.session.id, { text: 'Failed original request' });
  f.store.mutate(state => { const row = state.sessions.find(row => row.id === f.session.id); row.status = 'idle'; row.activeTurnId = null; row.turns[0].status = 'failed'; row.turns[0].modelConfig.execution = 'rna'; });
  const turn = f.current().turns[0].id; const result = await f.json('retry', f.session.id);
  assert.equal(result.session.activeTurnId, turn); assert.equal(result.session.turns.length, 1); assert.equal(result.session.turns[0].retryHistory.length, 1);
  await assert.rejects(f.invoke('retry', f.session.id)); assert.equal(f.current().turns[0].retryHistory.length, 1);
  const before = f.calls.length; await assert.rejects(f.invoke('retry', f.session.id, 'unexpected')); assert.equal(f.calls.length, before);
});

test('interactive slash recovery records exact call identity and slash retry never becomes a user prompt', { timeout: 20000 }, async t => {
  const f = await fixture(t); f.pending();
  const child = spawn(process.execPath, [cli, 'chat', f.session.id], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] }); let output = '', error = '';
  child.stdout.on('data', data => output += data); child.stderr.on('data', data => error += data);
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const wait = async check => { const deadline = Date.now() + 10000; while (!check()) { if (Date.now() > deadline) throw new Error(`Chat condition failed: ${error}`); await delay(20); } };
  await wait(() => output.includes('你 ›')); child.stdin.write('/recovery\n'); await wait(() => output.includes('assistant-a/command-b'));
  child.stdin.write('/recovery resolve assistant-a/command-b abandoned 已核对进程停止，结果未确认\n'); await wait(() => f.current().turns[0].toolResolutions?.['assistant-a/command-b']);
  await wait(() => output.includes('"remaining": 0')); child.stdin.write('/retry\n'); await wait(() => error.includes('当前会话不能重试'));
  assert.equal(f.current().items.filter(row => row.kind === 'user').length, 1); assert.equal(f.current().status, 'paused');
  const ended = new Promise(resolve => child.once('exit', resolve)); child.stdin.end('/quit\n'); await ended;
});

test('CLI marketplace search then read uses the real catalog adapter and pinned source contract without installing', async t => {
  const remote = await marketplaceFixture(t), realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => new URL(url).hostname === '127.0.0.1' ? realFetch(url, options) : remote.fetchImpl(url, options));
  // The in-process host resolves the pinned commit with `git ls-remote`: answer it for the fixture repository.
  const bin = mkdtempSync(join(tmpdir(), 'rna-git-stub-')), path = process.env.PATH;
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = ls-remote ]; then printf '${remote.commit}\\tHEAD\\n'; exit 0; fi; done\nexit 1\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${path}`; t.after(() => { process.env.PATH = path; rmSync(bin, { recursive: true, force: true }); });
  const f = await fixture(t), originalAssignments = structuredClone(f.store.state.projects.find(p => p.id === f.project.id).assignments);
  assert.equal((await f.json('marketplace')).providers.length, 3);
  await assert.rejects(f.invoke('marketplace', 'read', 'skills-sh', 'fixture/skills/research'));
  const search = await f.json('marketplace', 'search', 'source checking', '--provider', 'skills-sh', '--limit', '2', '--project', f.project.id);
  const source = await f.json('marketplace', 'read', 'skills-sh', search.results[0].id, '--project', f.project.id);
  assert.equal(source.commit, remote.commit); assert.match(source.content, /Read references/); assert.ok(source.installInput);
  const resource = await f.json('marketplace', 'read', 'skills-sh', search.results[0].id, '--path', 'references/method.md'); assert.match(resource.content, /Compare claims/);
  assert.deepEqual(f.store.state.projects.find(p => p.id === f.project.id).assignments, originalAssignments);
  const before = f.calls.length;
  for (const args of [['search', 'browser', '--provider', 'unknown'], ['search', 'browser', '--limit', '11'], ['catalog', 'extra'], ['read', 'skills-sh'], ['search', 'browser', '--api-key', 'not-a-cli-secret']]) await assert.rejects(f.invoke('marketplace', ...args), error => error.code === 1 && !error.stderr.includes('not-a-cli-secret'));
  assert.equal(f.calls.length, before); assert.ok(!f.calls.some(row => row.path.includes('/install')));
});

test('CLI Vite mode reaches the real preview authorization and local dependency checks, never silently serving static HTML', async t => {
  const f = await fixture(t); writeFileSync(join(f.workspace, 'index.html'), '<h1>Static fixture</h1>'); writeFileSync(join(f.workspace, 'package.json'), '{}');
  f.store.mutate(state => { const p = state.projects.find(p => p.id === f.project.id); p.permissions.workspace = 'read'; p.assignments = { toolIds: ['project_exec'], skillIds: [], mcpServerIds: [] }; });
  await assert.rejects(f.invoke('preview', f.project.id, 'start', '--mode', 'vite', '--session', f.session.id), error => error.code === 1 && /执行权限/.test(error.stderr));
  f.store.mutate(state => { state.projects.find(p => p.id === f.project.id).permissions.workspace = 'execute'; });
  await assert.rejects(f.invoke('preview', f.project.id, 'start', '--mode', 'vite', '--session', f.session.id), error => error.code === 1 && /Vite/.test(error.stderr));
  assert.equal((await f.json('preview', f.project.id)).status, 'stopped');
  const before = f.calls.length;
  for (const args of [['status', '--mode', 'vite'], ['stop', '--session', f.session.id], ['start', '--mode', 'arbitrary-shell']]) await assert.rejects(f.invoke('preview', f.project.id, ...args));
  assert.equal(f.calls.length, before);
});
