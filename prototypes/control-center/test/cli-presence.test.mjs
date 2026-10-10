import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createCliPresence } from '../cli-presence.mjs';
import { createServer } from '../server.mjs';

const hold = () => { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; };
async function until(check, label = 'condition') { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (await check()) return; await delay(10); } throw new Error(`Timed out: ${label}`); }
function fixture(options = {}) {
  let now = 10000, next = 0, current = null; const intervals = new Map(), calls = [], errors = [];
  const input = Object.assign(new EventEmitter(), { isTTY: true }), output = { isTTY: true };
  const api = async (path, method, data) => {
    calls.push({ path, method, data });
    // The project's own v2 route, never the whole project list (B9).
    if (method === 'GET') { assert.equal(path, '/v2/projects/project'); return { id: 'project', presence: structuredClone(current) }; }
    const receipt = current && Date.parse(current.expiresAt) > now ? current.receiptId : null;
    if (data.expectedReceiptId !== receipt) throw Object.assign(new Error('Presence conflict'), { status: 409 });
    current = { receiptId: `receipt-${++next}`, ...data, at: new Date(now).toISOString(), expiresAt: new Date(now + 10000).toISOString() }; delete current.expectedReceiptId;
    return structuredClone(current);
  };
  const presence = createCliPresence({ projectId: 'project', sessionId: 'session', input, output, api, now: () => now, timers: { setInterval: fn => { const id = ++next; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id) }, onError: error => errors.push(error), ...options });
  return { presence, input, output, calls, errors, intervals, api, current: () => current, other: (sessionId = 'web-session', visible = true) => { current = { receiptId: `other-${++next}`, sessionId, typing: true, visible, at: new Date(now).toISOString(), expiresAt: new Date(now + 10000).toISOString() }; return current; }, async type() { input.emit('keypress', 'x', { name: 'x' }); await presence.flush(); }, async advance(ms) { now += ms; for (const callback of intervals.values()) callback(); await presence.flush(); } };
}

test('presence remains inert for pipes, redirected output, unassigned chat and idle TTYs', async () => {
  for (const options of [{ input: Object.assign(new EventEmitter(), { isTTY: false }) }, { output: { isTTY: false } }, { projectId: null }, {}]) {
    const f = fixture(options); assert.equal(f.calls.length, 0); assert.equal(f.intervals.size, 0);
    if (!f.presence.enabled) { await f.type(); f.presence.submitting(true); await f.advance(2000); assert.equal(f.calls.length, 0); assert.equal(f.intervals.size, 0); }
    await f.presence.close(); assert.equal(f.calls.length, 0);
  }
});

test('actual keypress claims a CAS receipt, renews typing and clears typing after its TTL without endless idle renewals', async t => {
  const f = fixture(); t.after(() => f.presence.close()); await f.type();
  assert.equal(f.current().typing, true); assert.equal(f.current().visible, true); assert.equal(f.calls[1].data.expectedReceiptId, null);
  const receipt = f.current().receiptId; await f.advance(1000); assert.equal(f.calls.at(-1).data.expectedReceiptId, receipt);
  await f.advance(2600); assert.equal(f.current().typing, false); const count = f.calls.length;
  await f.advance(1000); assert.equal(f.calls.length, count);
  await f.advance(10001); await f.type(); assert.equal(f.calls.at(-1).data.expectedReceiptId, null); assert.equal(f.current().typing, true);
});

test('a visible Web or other CLI writer wins, including another client in the same session', async t => {
  for (const sessionId of ['web-session', 'session']) {
    const f = fixture(); t.after(() => f.presence.close()); const foreign = f.other(sessionId); await f.type();
    assert.equal(f.current().receiptId, foreign.receiptId); assert.equal(f.calls.filter(call => call.method === 'POST').length, 0); assert.equal(f.presence.typing(), true);
    await f.presence.close(); assert.equal(f.current().receiptId, foreign.receiptId);
  }
});

test('GET/POST races cannot overwrite a newer visible presence', async () => {
  let f; f = fixture({ api: async (path, method, data) => { if (method === 'POST') f.other(); return f.api(path, method, data); } });
  await f.type(); assert.equal(f.current().sessionId, 'web-session'); assert.equal(f.errors.length, 0);
  await f.presence.close(); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('exit only clears its own receipt, never a newer Web client, and detaches input/timers', async () => {
  const own = fixture(); await own.type(); const receipt = own.current().receiptId; await own.presence.close();
  assert.deepEqual(own.calls.at(-1).data, { sessionId: 'session', typing: false, visible: false, expectedReceiptId: receipt });
  assert.equal(own.current().visible, false); assert.equal(own.input.listenerCount('keypress'), 0); assert.equal(own.intervals.size, 0); const count = own.calls.length; await own.type(); await own.presence.close(); assert.equal(own.calls.length, count);
  const changed = fixture(); await changed.type(); const foreign = changed.other('session'); await changed.presence.close(); assert.equal(changed.current().receiptId, foreign.receiptId); assert.equal(changed.current().visible, true);
});

test('closing during a lookup prevents a late acquisition; closing during an accepted POST releases its returned receipt', async () => {
  const lookup = hold(); let first; first = fixture({ api: async (...args) => { if (args[1] === 'GET') await lookup.promise; return first.api(...args); } });
  first.input.emit('keypress', 'x', { name: 'x' }); const closed = first.presence.close(); lookup.release(); await closed;
  assert.equal(first.calls.filter(call => call.method === 'POST').length, 0);
  const posting = hold(); let second; second = fixture({ api: async (...args) => { if (args[1] === 'POST' && args[2].visible) await posting.promise; return second.api(...args); } });
  second.input.emit('keypress', 'x', { name: 'x' }); await until(() => second.calls.some(call => call.method === 'GET'));
  await delay(0); const ending = second.presence.close(); posting.release(); await ending;
  assert.equal(second.current().visible, false); assert.equal(second.calls.filter(call => call.method === 'POST').length, 2);
});

test('typing TTL and submission completion release local initiative output without transmitting draft text', async t => {
  let idle = 0; const f = fixture({ onIdle: () => idle++ }); t.after(() => f.presence.close());
  f.input.emit('keypress', '\r', { name: 'return' }); await f.presence.flush(); assert.equal(f.calls.length, 0);
  await f.type(); f.presence.submitting(true); await f.advance(5000); assert.equal(f.presence.typing(), true); assert.equal(idle, 0);
  f.presence.submitting(false); await f.presence.flush(); assert.equal(f.presence.typing(), false); assert.equal(idle, 1); assert.equal(f.current().typing, false);
  await f.type(); await f.advance(3000); assert.equal(idle, 2);
  assert.ok(f.calls.filter(call => call.method === 'POST').every(call => Object.keys(call.data).every(key => ['sessionId', 'typing', 'visible', 'expectedReceiptId'].includes(key))));
});

test('a project that is gone or archived is never claimed, and its lookup is one project, not the list', async () => {
  for (const answer of [() => { throw Object.assign(new Error('项目不存在'), { status: 404 }); }, () => ({ id: 'project', archivedAt: '2026-10-01T00:00:00.000Z', presence: null })]) {
    let f; f = fixture({ api: async (...args) => args[1] === 'GET' ? answer() : f.api(...args) });
    await f.type(); await f.advance(1000);
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0); assert.equal(f.errors.length, 0);
    await f.presence.close();
  }
});

test('presence network failures are bounded and do not prevent chat cleanup', async () => {
  const f = fixture({ api: () => new Promise(() => {}), requestTimeoutMs: 15 });
  f.input.emit('keypress', 'x', { name: 'x' }); await Promise.all([f.presence.flush(), delay(40)]); assert.equal(f.errors.length, 1); await f.presence.close(); assert.equal(f.intervals.size, 0);
});

test('local CLI deferral respects the project input-courtesy preference', async t => {
  let idle = 0, f; f = fixture({ onIdle: () => idle++, api: async (...args) => { const result = await f.api(...args); if (args[1] === 'GET') result.initiative = { deferWhileTyping: false }; return result; } });
  t.after(() => f.presence.close()); await f.type();
  assert.equal(f.presence.typing(), true); assert.equal(f.presence.deferOutput(), false); assert.equal(idle, 1); assert.equal(f.current().typing, true);
});

async function serverFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-cli-presence-')), app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false });
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  t.after(async () => { app.server.closeAllConnections(); await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const seeded = app.store.createProject({ name: 'Presence fixture' }), port = String(app.server.address().port);
  return { ...app, ...seeded, port, async post(body) { const response = await fetch(`http://127.0.0.1:${port}/api/projects/${seeded.project.id}/presence`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; } };
}

test('presence HTTP CAS is atomic, receipts rotate, old Web clients remain compatible and expired receipts become null', async t => {
  const f = await serverFixture(t), body = { sessionId: f.session.id, typing: true, visible: true };
  const initial = await f.post({ ...body, expectedReceiptId: null }); assert.equal(initial.status, 200); assert.ok(initial.body.receiptId);
  const [a, b] = await Promise.all([f.post({ ...body, expectedReceiptId: initial.body.receiptId }), f.post({ ...body, expectedReceiptId: initial.body.receiptId })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]); const winner = a.status === 200 ? a : b; assert.notEqual(winner.body.receiptId, initial.body.receiptId);
  const web = await f.post({ ...body, typing: false }); assert.equal(web.status, 200); assert.notEqual(web.body.receiptId, winner.body.receiptId);
  assert.equal((await f.post({ ...body, visible: false, expectedReceiptId: winner.body.receiptId })).status, 409); assert.equal(f.store.presences.get(f.project.id).receiptId, web.body.receiptId);
  f.store.presences.get(f.project.id).expiresAt = '2000-01-01T00:00:00.000Z'; assert.equal((await f.post({ ...body, expectedReceiptId: null })).status, 200);
  assert.equal((await f.post({ ...body, expectedReceiptId: 1 })).status, 400);
});

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
function subprocess(t, command, args, port, { env = {} } = {}) {
  const child = spawn(command, args, { env: { ...process.env, RNA_AGENT_PORT: port, ...env }, stdio: 'pipe', detached: process.platform !== 'win32' }); let output = '';
  child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
  const exited = new Promise((done, reject) => { child.once('error', reject); child.once('exit', code => done(code)); });
  t.after(() => { if (child.exitCode === null) { try { if (process.platform === 'win32') child.kill('SIGTERM'); else process.kill(-child.pid, 'SIGTERM'); } catch {} } }); return { child, output: () => output, exited };
}

test('piped CLI chat reads SSE and exits without claiming or clearing the Web presence', { timeout: 10000 }, async t => {
  const f = await serverFixture(t), web = await f.post({ sessionId: f.session.id, typing: true, visible: true }); const paths = []; f.server.on('request', request => paths.push(request.url));
  const process = subprocess(t, globalThis.process.execPath, [cli, 'chat', f.session.id], f.port);
  await until(() => process.output().includes('/quit')); process.child.stdin.end('/quit\n'); assert.equal(await process.exited, 0);
  assert.equal(paths.filter(path => path.endsWith('/presence')).length, 0); assert.equal(f.store.presences.get(f.project.id).receiptId, web.body.receiptId);
});

test('TTY CLI sends typing only after a real key and releases its receipt on quit', { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/script'), timeout: 10000 }, async t => {
  // Node's child stdin is a socket on macOS, which script(1) rejects. The fixed
  // cat bridge gives script an ordinary pipe; arguments remain shell positional
  // parameters and are never interpolated into command text.
  // The parent test runner may declare TERM=dumb. Readline intentionally treats
  // Ctrl-U as literal input there; this test specifically exercises line editing.
  const f = await serverFixture(t), terminal = subprocess(t, '/bin/sh', ['-c', 'cat | "$@"', 'rna-pty-test', '/usr/bin/script', '-q', '/dev/null', process.execPath, cli, 'chat', f.session.id], f.port, { env: { TERM: 'xterm-256color' } });
  t.after(() => { if (terminal.child.exitCode === null) t.diagnostic(`TTY exit did not settle: ${JSON.stringify({ output: terminal.output(), presence: f.store.presences.get(f.project.id), killed: terminal.child.killed, signalCode: terminal.child.signalCode })}`); });
  try { await until(() => terminal.output().includes('/quit'), 'TTY CLI banner'); } catch (error) { error.message += `: ${terminal.output()}`; throw error; } assert.equal(f.store.presences.size, 0);
  terminal.child.stdin.write('draft'); await until(() => f.store.presences.get(f.project.id)?.typing, 'TTY keypress presence');
  terminal.child.stdin.end('\u0015/quit\r'); assert.equal(await terminal.exited, 0);
  assert.equal(f.store.presences.get(f.project.id).typing, false); assert.equal(f.store.presences.get(f.project.id).visible, false);
  assert.equal(f.store.state.sessions.find(session => session.id === f.session.id).items.filter(item => item.kind === 'user').length, 0, 'The edited draft must not be submitted as a message');
});

test('dumb TTY CLI accepts a plain quit command and releases presence without terminal editing support', { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/script'), timeout: 10000 }, async t => {
  const f = await serverFixture(t), terminal = subprocess(t, '/bin/sh', ['-c', 'cat | "$@"', 'rna-dumb-pty-test', '/usr/bin/script', '-q', '/dev/null', process.execPath, cli, 'chat', f.session.id], f.port, { env: { TERM: 'dumb' } });
  await until(() => terminal.output().includes('/quit'), 'dumb TTY banner');
  terminal.child.stdin.write('/quit'); await until(() => f.store.presences.get(f.project.id)?.typing, 'dumb TTY typing');
  terminal.child.stdin.end('\r'); assert.equal(await terminal.exited, 0);
  assert.equal(f.store.presences.get(f.project.id).typing, false); assert.equal(f.store.presences.get(f.project.id).visible, false);
  assert.equal(f.store.state.sessions.find(session => session.id === f.session.id).items.filter(item => item.kind === 'user').length, 0);
});
