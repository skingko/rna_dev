import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.mjs';
import { Store } from '../store.mjs';
import { TerminalService, loadPty, terminalEnvironment } from '../terminal-service.mjs';

async function until(check, timeout = 10000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = check(); if (value) return value; await delay(20); } throw new Error('condition did not settle'); }
function sse(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path, headers }, response => {
      const events = []; let buffer = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { buffer += chunk; let index; while ((index = buffer.indexOf('\n\n')) >= 0) { const lines = buffer.slice(0, index).split('\n'); buffer = buffer.slice(index + 2); const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n'); if (data) events.push({ id: lines.find(line => line.startsWith('id: '))?.slice(4), event: lines.find(line => line.startsWith('event: '))?.slice(7), data: JSON.parse(data) }); } });
      const closed = new Promise(done => response.on('close', done));
      resolve({ status: response.statusCode, events, closed, close: () => request.destroy(), of: type => events.filter(row => row.event === type), text: () => Buffer.concat(events.filter(row => row.event === 'data').map(row => Buffer.from(row.data.b64, 'base64'))).toString('utf8') });
    });
    request.on('error', reject);
  });
}
const b64 = text => Buffer.from(text).toString('base64');
async function setup(t, terminalOptions = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'rna-terminal-'))), workspace = join(directory, 'workspace'); mkdirSync(join(workspace, 'sub'), { recursive: true });
  const app = createServer({ stateFile: join(directory, '.state', 'state.json'), ticks: false, runtime: false, terminalOptions: { env: { ...process.env, SHELL: '/bin/sh', RNA_SECRET_PROBE: 'leak', OPENAI_API_KEY: 'leak' }, ...terminalOptions } });
  await app.initializer.close();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const { project } = app.store.createProject({ name: 'Terminal', workspace, initiative: { enabled: false } });
  const port = app.server.address().port, url = path => `http://127.0.0.1:${port}${path}`;
  const call = async (method, path, body) => { const response = await fetch(url(path), { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  return { app, directory, workspace, project, port, call };
}
const modes = [['fallback', { pty: null }], ...(loadPty() ? [['pty', {}]] : [])];
if (process.platform === 'win32') modes.length = 0;

for (const [mode, options] of modes) test(`terminal lifecycle over HTTP (${mode}): create, stream, input, resize, replay, delete`, async t => {
  const f = await setup(t, options);
  const bootstrap = await f.call('GET', '/api/v2/bootstrap');
  assert.deepEqual(bootstrap.body.capabilities, { terminal: mode, sideChat: true });
  const created = await f.call('POST', `/api/v2/projects/${f.project.id}/terminals`, { cols: 100, rows: 30, cwd: 'sub' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.capability, mode); assert.equal(created.body.cwd, join(f.workspace, 'sub')); assert.equal(created.body.shell, '/bin/sh'); assert.ok(created.body.title);
  const id = created.body.id, stream = await sse(f.port, `/api/v2/terminals/${id}/stream`); t.after(stream.close);
  assert.equal(stream.status, 200);
  await until(() => stream.of('hello').length);
  assert.equal(stream.of('hello')[0].data.id, id);
  await delay(300);
  assert.equal((await f.call('POST', `/api/v2/terminals/${id}/input`, { b64: b64('echo "o""k:$RNA_SECRET_PROBE:$OPENAI_API_KEY:$(pwd)"\n') })).status, 200);
  await until(() => stream.text().includes(`ok:::${join(f.workspace, 'sub')}`));
  const resized = await f.call('POST', `/api/v2/terminals/${id}/resize`, { cols: 120, rows: 40 });
  assert.equal(resized.body.resized, mode === 'pty');
  const listed = await f.call('GET', `/api/v2/projects/${f.project.id}/terminals`);
  assert.equal(listed.body.capability, mode); assert.equal(listed.body.terminals.length, 1); assert.equal(listed.body.terminals[0].status, 'running');
  // Resume: only chunks after Last-Event-ID; a stale id replays the whole ring buffer.
  const ids = stream.of('data').map(row => Number(row.id)), resume = await sse(f.port, `/api/v2/terminals/${id}/stream`, { 'last-event-id': String(ids.at(-2) ?? ids[0]) }); t.after(resume.close);
  await until(() => resume.of('hello').length);
  assert.equal(resume.of('hello')[0].data.replay, 'partial');
  await until(() => resume.of('data').length);
  assert.ok(resume.of('data').every(row => Number(row.id) > (ids.at(-2) ?? ids[0])));
  const stale = await sse(f.port, `/api/v2/terminals/${id}/stream?lastEventId=1`); t.after(stale.close);
  await until(() => stale.of('hello').length && stale.of('data').length);
  assert.equal(stale.of('hello')[0].data.replay, 'reset'); assert.ok(stale.text().includes('ok:::'));
  const removed = await f.call('DELETE', `/api/v2/terminals/${id}`);
  assert.equal(removed.status, 200); assert.equal(removed.body.closed, true);
  await until(() => stream.of('exit').length); await stream.closed;
  assert.equal((await f.call('POST', `/api/v2/terminals/${id}/input`, { b64: b64('x') })).status, 404);
});

for (const [mode, options] of modes) test(`terminal exit is reported with its code (${mode})`, async t => {
  const f = await setup(t, options);
  const { body } = await f.call('POST', `/api/v2/projects/${f.project.id}/terminals`, { cols: 80, rows: 24 });
  const stream = await sse(f.port, `/api/v2/terminals/${body.id}/stream`); t.after(stream.close);
  await until(() => stream.of('hello').length); await delay(300);
  await f.call('POST', `/api/v2/terminals/${body.id}/input`, { b64: b64('exit 7\n') });
  await until(() => stream.of('exit').length);
  assert.equal(stream.of('exit')[0].data.code, 7);
  const after = await sse(f.port, `/api/v2/terminals/${body.id}/stream`); await after.closed;
  assert.equal(after.of('exit')[0].data.code, 7, 'an exited terminal replays its output and exit, then closes');
});

test('terminal permission gate, cwd confinement, validation and limits', async t => {
  const f = await setup(t, { pty: null, maxPerProject: 2 });
  const outside = join(f.directory, 'outside'); mkdirSync(outside); symlinkSync(outside, join(f.workspace, 'escape'));
  for (const cwd of ['..', '../outside', 'escape', '/tmp']) {
    const denied = await f.call('POST', `/api/v2/projects/${f.project.id}/terminals`, { cols: 80, rows: 24, cwd });
    assert.ok([400, 403].includes(denied.status), cwd); assert.match(denied.body.code, /^TERMINAL_CWD_/u);
  }
  assert.equal((await f.call('POST', `/api/v2/projects/${f.project.id}/terminals`, { cols: 1, rows: 24 })).body.code, 'TERMINAL_SIZE_INVALID');
  assert.equal((await f.call('POST', `/api/v2/projects/${f.project.id}/terminals`, { cols: 80, rows: 24, shell: '/bin/bash' })).body.code, 'TERMINAL_ARGUMENTS_INVALID');
  const one = await f.call('POST', `/api/v2/projects/${f.project.id}/terminals`, {}), two = await f.call('POST', `/api/v2/projects/${f.project.id}/terminals`, {});
  assert.equal(one.status, 201); assert.equal(two.status, 201);
  const third = await f.call('POST', `/api/v2/projects/${f.project.id}/terminals`, {});
  assert.equal(third.status, 429); assert.equal(third.body.code, 'TERMINAL_LIMIT');
  assert.equal((await f.call('POST', `/api/v2/terminals/${one.body.id}/input`, { b64: '***' })).body.code, 'TERMINAL_INPUT_INVALID');
  // Lowering the saved permission kills running terminals and blocks new ones.
  f.app.permissions.update(f.project.id, { workspace: 'write', background: 'read' });
  await until(() => [...f.app.terminals.terminals.values()].every(row => row.exit));
  assert.equal([...f.app.terminals.terminals.values()][0].exit.reason, 'permission');
  const gated = await f.call('POST', `/api/v2/projects/${f.project.id}/terminals`, {});
  assert.equal(gated.status, 403); assert.equal(gated.body.code, 'TERMINAL_PERMISSION_DENIED');
  f.app.permissions.update(f.project.id, { workspace: 'execute', background: 'read' });
  // Cross-site and foreign Host requests are refused by the server's shared checks.
  const foreign = await fetch(`http://127.0.0.1:${f.port}/api/v2/projects/${f.project.id}/terminals`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' });
  assert.equal(foreign.status, 403);
  // Archiving the project kills its terminals.
  const live = await f.call('POST', `/api/v2/projects/${f.project.id}/terminals`, {});
  assert.equal(live.status, 201);
  f.app.store.updateProject(f.project.id, { archived: true });
  await until(() => f.app.terminals.terminals.get(live.body.id).exit);
  assert.equal((await f.call('POST', `/api/v2/projects/${f.project.id}/terminals`, {})).status, 409);
});

test('terminal service: ring buffer bound, idle timeout, input rate limit, env scrub and close', { skip: process.platform === 'win32' }, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'rna-terminal-unit-'))), store = new Store(join(directory, 'state.json'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { project } = store.createProject({ name: 'Unit', workspace: directory });
  const service = new TerminalService(store, { pty: null, bufferBytes: 4096, idleMs: 60000, inputBytesPerSecond: 1024, env: { ...process.env, SHELL: '/bin/sh' } });
  t.after(() => service.close());
  const view = service.create(project.id, {}), terminal = service.terminals.get(view.id);
  service.output(terminal, Buffer.alloc(10000, 'a'));
  assert.ok(terminal.chunkBytes <= 4096 + 48 * 1024 && terminal.chunks.length >= 1);
  for (let index = 0; index < 20; index++) service.output(terminal, Buffer.alloc(1000, 'b'));
  assert.ok(terminal.chunkBytes <= 4096, 'ring buffer is bounded');
  assert.throws(() => service.input(view.id, { b64: b64('x'.repeat(2000)) }), error => error.code === 'TERMINAL_RATE_LIMITED');
  terminal.lastActivity = Date.now() - 120000; service.sweep();
  await until(() => terminal.exit);
  assert.equal(terminal.exit.reason, 'idle');
  const env = terminalEnvironment({ PATH: '/usr/bin', HOME: '/h', RNA_AGENT_STATE: 's', PI_FORGE_PORT: '1', GITHUB_TOKEN: 't', ANTHROPIC_API_KEY: 'k', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1', npm_config_x: 'y' });
  assert.deepEqual(Object.keys(env).filter(key => /RNA|PI_FORGE|TOKEN|API_KEY|NODE_OPTIONS|ELECTRON|npm_/u.test(key)), []);
  assert.equal(env.HOME, '/h'); assert.equal(env.TERM, 'xterm-256color'); assert.ok(env.PATH.includes('/usr/bin'));
  const second = service.create(project.id, {});
  await service.close();
  assert.ok(service.terminals.get(second.id).exit, 'daemon stop kills terminals');
  assert.throws(() => service.create(project.id, {}), error => error.code === 'TERMINAL_CLOSED');
});

test('run preview is exposed as a browser-tab target at GET /api/v2/projects/:id/preview', async t => {
  const f = await setup(t, { pty: null });
  writeFileSync(join(f.workspace, 'index.html'), '<!doctype html><title>demo</title><h1>hi</h1>');
  const stopped = await f.call('GET', `/api/v2/projects/${f.project.id}/preview`);
  assert.equal(stopped.status, 200); assert.equal(stopped.body.status, 'stopped'); assert.equal(stopped.body.browser, null);
  assert.deepEqual(stopped.body.actions.start, { method: 'POST', path: `/api/projects/${f.project.id}/preview`, body: { mode: 'auto' } });
  assert.equal((await f.call('POST', `/api/projects/${f.project.id}/preview`, { path: 'index.html' })).status, 200);
  const ready = await f.call('GET', `/api/v2/projects/${f.project.id}/preview`);
  assert.equal(ready.body.status, 'ready'); assert.equal(ready.body.browser.openIn, 'browser-tab'); assert.match(ready.body.browser.url, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\/index\.html$/u);
  const page = await fetch(ready.body.browser.url); assert.equal(page.status, 200); assert.match(await page.text(), /<h1>hi<\/h1>/u);
});
