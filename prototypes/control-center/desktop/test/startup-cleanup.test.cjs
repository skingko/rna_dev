const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { DesktopRuntime } = require('../runtime.cjs');
const { readOwnedSupervisor, stopOwnedSupervisor } = require('../ownership.cjs');

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-desktop-ownership-review-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = join(directory, 'host'), dataDir = join(directory, 'private');
  mkdirSync(host); mkdirSync(dataDir); writeFileSync(join(host, 'server.mjs'), ''); writeFileSync(join(directory, 'node'), '');
  const paths = { host, node: join(directory, 'node'), bin: directory, cli: join(directory, 'rna') }, stateFile = join(dataDir, 'state.json'), port = 45234;
  mkdirSync(`${stateFile}.service`);
  const config = { stateFile, port, command: paths.node, cwd: paths.host, manager: 'session' };
  const owner = { pid: 123, birth: 'actual-birth', token: 'owner-token', supervisorRunId: 'run' }, status = { supervisorPid: 123, runId: 'run' };
  const put = (name, value) => writeFileSync(`${stateFile}.service/${name}`, JSON.stringify(value));
  const persist = () => { put('config.json', config); put('supervisor.lock', owner); put('status.json', status); };
  let alive = true;
  const identities = { processAlive: pid => alive && pid === owner.pid, processBirth: () => 'actual-birth', acquireProcessLease: async () => () => {} };
  return { paths, dataDir, stateFile, port, config, owner, status, persist, put, identities, die: () => { alive = false; } };
}

test('startup side effects followed by CLI failure retain a verified owner and clean it up on exit', async t => {
  const f = fixture(t), events = [];
  const runtime = new DesktopRuntime({ paths: f.paths, dataDir: f.dataDir, env: { RNA_DESKTOP_ISOLATED: '1' }, choosePort: async () => f.port,
    run: async () => { f.persist(); events.push('detached-start'); throw Error('waitStatus timeout'); },
    readOwner: options => readOwnedSupervisor({ ...options, identities: f.identities }),
    stopOwner: options => stopOwnedSupervisor({ ...options, identities: f.identities,
      acquire: async path => { assert.equal(path, `${f.stateFile}.service/operation.lock`); events.push('lock'); return () => events.push('unlock'); },
      writeIntent: (path, text) => { assert.equal(path, `${f.stateFile}.service/intent.json`); assert.equal(JSON.parse(text).enabled, false); events.push('intent'); },
      signal: (pid, name) => { assert.equal(pid, 123); assert.equal(name, 'SIGTERM'); events.push('signal'); f.die(); } }) });
  await assert.rejects(runtime.start(), /waitStatus timeout/); assert.equal(runtime.started, false); assert.deepEqual(runtime.owner, f.owner);
  await runtime.stop(); assert.equal(runtime.owner, null);
  assert.deepEqual(events, ['detached-start', 'lock', 'intent', 'signal', 'unlock']);
  await runtime.stop(); assert.equal(events.length, 5, 'repeated stop cannot signal again');
});

for (const [name, mutate] of [
  ['foreign state', f => { f.config.stateFile += '.other'; }],
  ['foreign Node', f => { f.config.command += '.other'; }],
  ['foreign working directory', f => { f.config.cwd += '.other'; }],
  ['different port', f => { f.config.port++; }],
  ['native external manager', f => { f.config.manager = 'native'; }],
  ['missing token', f => { delete f.owner.token; }],
  ['reused PID birth', f => { f.owner.birth = 'old-birth'; }],
  ['different run', f => { f.status.runId = 'other'; }],
  ['different supervisor', f => { f.status.supervisorPid++; }],
  ['dead process', f => { f.die(); }],
]) test(`owner discovery rejects ${name}`, async t => {
  const f = fixture(t); mutate(f); f.persist(); assert.equal(await readOwnedSupervisor({ ...f, identities: f.identities }), null);
});

test('replacement owner after lock admission causes neither an intent change nor a signal', async t => {
  const f = fixture(t); f.persist(); const pinned = await readOwnedSupervisor(f), events = [];
  const result = await stopOwnedSupervisor({ ...f, owner: pinned, identities: f.identities,
    acquire: async () => { events.push('lock'); f.put('supervisor.lock', { ...f.owner, token: 'replacement-token' }); return () => events.push('unlock'); },
    writeIntent: () => assert.fail('must not disable replacement service'), signal: () => assert.fail('must not signal replacement owner') });
  assert.deepEqual(result, { stopped: false, reason: 'ownership_changed' }); assert.deepEqual(events, ['lock', 'unlock']);
});

test('PID reuse after pin never writes intent or signals a process with another birth', async t => {
  const f = fixture(t); f.persist(); const events = [];
  const result = await stopOwnedSupervisor({ ...f, owner: f.owner, identities: { ...f.identities, processBirth: () => 'replacement-birth' },
    acquire: async () => () => events.push('unlock'), writeIntent: () => assert.fail('must not disable replacement service'), signal: () => assert.fail('must not signal replacement process') });
  assert.deepEqual(result, { stopped: true }); assert.deepEqual(events, ['unlock']);
});

test('graceful timeout releases control lock without force-kill, permitting a later stop retry', async t => {
  const f = fixture(t); f.persist(); const events = [];
  await assert.rejects(stopOwnedSupervisor({ ...f, owner: f.owner, identities: f.identities, timeoutMs: -1,
    acquire: async () => { events.push('lock'); return () => events.push('unlock'); }, writeIntent: () => events.push('intent'),
    signal: (_pid, name) => events.push(name), wait: async () => assert.fail('expired before wait') }), /稍后重试/);
  assert.deepEqual(events, ['lock', 'intent', 'SIGTERM', 'unlock']);
  f.die(); assert.deepEqual(await stopOwnedSupervisor({ ...f, owner: f.owner, identities: f.identities, acquire: async () => () => {}, writeIntent: () => assert.fail(), signal: () => assert.fail() }), { stopped: true });
});

test('failed lock admission and failed intent persistence cannot send a stop signal', async t => {
  const f = fixture(t); f.persist(); let released = false;
  await assert.rejects(stopOwnedSupervisor({ ...f, owner: f.owner, identities: f.identities, acquire: async () => { throw Error('busy'); }, writeIntent: () => assert.fail(), signal: () => assert.fail() }), /busy/);
  await assert.rejects(stopOwnedSupervisor({ ...f, owner: f.owner, identities: f.identities, acquire: async () => () => { released = true; }, writeIntent: () => { throw Error('disk full'); }, signal: () => assert.fail() }), /disk full/);
  assert.equal(released, true);
});

test('unverified startup and externally attached runtime never invoke stopOwner', async t => {
  const f = fixture(t), runtime = new DesktopRuntime({ paths: f.paths, dataDir: f.dataDir, env: { RNA_DESKTOP_ISOLATED: '1' }, choosePort: async () => f.port,
    run: async () => { throw Error('start not admitted'); }, readOwner: async () => null, stopOwner: async () => assert.fail('unowned process') });
  await assert.rejects(runtime.start(), /not admitted/); await runtime.stop();
  runtime.external = true; runtime.owner = f.owner; await runtime.stop();
});
