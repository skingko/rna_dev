import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { NATIVE_PROBE_SOURCE } from '../maintenance-native-probe.mjs';
import { nativeRuntimeReadPreflight, runNativePreflightCli, NATIVE_PREFLIGHT_CHECKS, publicNativePreflight } from '../maintenance-native-preflight.mjs';
import { runMaintenanceOperation } from '../application-maintenance-worker.mjs';
import { maintenancePaths, persistMaintenance, readMaintenance, publicMaintenanceOperation } from '../application-maintenance-state.mjs';
import { createRuntimeManifest, prepareLocalRuntime } from '../runtime-release.mjs';
import { registerMaintenanceEntry } from '../application-maintenance.mjs';
import { formatMaintenanceStatus } from '../presentation/maintenance-display.mjs';

function files(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rna-preflight-test-'))), runtime = join(root, 'runtime'), host = join(runtime, 'prototypes/control-center'), stateFile = join(root, 'state.json');
  mkdirSync(host, { recursive: true }); mkdirSync(join(runtime, 'packages/sdk/src'), { recursive: true }); mkdirSync(`${stateFile}.service`);
  writeFileSync(join(host, 'server.mjs'), 'throw Error("Host must never execute");');
  writeFileSync(join(host, 'daemon-supervisor.mjs'), 'throw Error("Supervisor must never execute");');
  writeFileSync(join(runtime, 'packages/sdk/src/index.mjs'), 'throw Error("SDK must never execute");');
  writeFileSync(stateFile, '{"version":2,"secretFixture":"PRIVATE_CONTENT_NEVER_OUTPUT"}');
  writeFileSync(`${stateFile}.service/config.json`, JSON.stringify({ stateFile, manager: 'native' }));
  t.after(() => { const writable = path => { const st = lstatSync(path); if (st.isSymbolicLink()) return; chmodSync(path, 0o700); if (st.isDirectory()) for (const name of readdirSync(path)) writable(join(path, name)); }; writable(root); rmSync(root, { recursive: true, force: true }); });
  const input = { stateFile, target: { cwd: host, command: process.execPath, manager: 'native' }, candidateId: randomUUID(), candidateDigest: 'a'.repeat(64), operationId: randomUUID() };
  return { root, host, runtime, stateFile, input };
}
function managedFixture({ mode, mutate, afterBootstrap } = {}) {
  let context, child, exit, exists = false, removed = 0, bootstraps = 0, queries = 0, observed = false;
  const manager = info => {
    context = info;
    const inspect = async () => {
      queries++;
      if (mode === 'preexisting') return { exists: true, owned: false, pid: 424242 };
      if (!exists) return { exists: false };
      if (mode === 'foreign') return { exists: true, owned: false, pid: child?.pid ?? null };
      if (mode === 'no_receipt') return { exists: true, owned: true, pid: null, exited: true, exitCode: 1 };
      if (mode === 'never_finishes') return { exists: true, owned: true, pid: 333333, exited: false };
      if (mode === 'late_foreign' && observed) return { exists: true, owned: false, pid: 444444 };
      if (mutate && existsSync(info.input.receipt)) {
        const r = JSON.parse(readFileSync(info.input.receipt, 'utf8')); mutate(r); writeFileSync(info.input.receipt, JSON.stringify(r), { mode: 0o600 }); mutate = null;
      }
      observed = true;
      return { exists: true, owned: true, pid: exit ? null : child?.pid ?? null, exited: Boolean(exit), exitCode: exit?.code };
    };
    return { inspect, async bootstrap() {
      bootstraps++; exists = true;
      if (mode === 'no_receipt' || mode === 'never_finishes') return;
      child = spawn(process.execPath, ['-e', NATIVE_PROBE_SOURCE, JSON.stringify(info.input)], { stdio: 'ignore' });
      child.on('close', (code, signal) => { exit = { code, signal }; });
      await afterBootstrap?.(info, child);
      if (mode === 'launch_receipt_lost') throw Error('private manager stderr should not escape');
    }, async remove() {
      removed++;
      if (child && !exit) { child.kill('SIGTERM'); await new Promise(done => child.once('close', done)); }
      if (mode !== 'cleanup_lost') exists = false;
    } };
  };
  return { manager, context: () => context, counts: () => ({ removed, bootstraps, queries }),
    async dispose() { if (child && !exit) { child.kill('SIGKILL'); await new Promise(done => child.once('close', done)); } if (context) rmSync(context.directory, { recursive: true, force: true }); } };
}

test('real builtin-only probe reads 8 required inputs, never imports modules, leaves state byte-identical and removes its dedicated job', async t => {
  const f = files(t), manager = managedFixture(); t.after(manager.dispose);
  const before = readFileSync(f.stateFile), config = readFileSync(`${f.stateFile}.service/config.json`);
  const result = await nativeRuntimeReadPreflight({ ...f.input, io: { platform: 'darwin', manager: manager.manager, timeoutMs: 2000 } });
  assert.equal(result.status, 'passed'); assert.equal(result.cleanup, 'completed'); assert.deepEqual(result.checks.map(row => row.name), NATIVE_PREFLIGHT_CHECKS); assert.ok(result.checks.every(row => row.ok));
  assert.deepEqual(readFileSync(f.stateFile), before); assert.deepEqual(readFileSync(`${f.stateFile}.service/config.json`), config);
  assert.equal(manager.counts().bootstraps, 1); assert.equal(manager.counts().removed, 1); assert.equal(existsSync(manager.context().directory), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_CONTENT'), false); assert.equal(JSON.stringify(result).includes(f.root), false);
});

test('a receipt caught half-written is read again, not rejected (a busy machine, or a probe from an older release)', async t => {
  const f = files(t), manager = managedFixture({ afterBootstrap: async info => { writeFileSync(info.input.receipt, '{"schemaVersion":1,"probeId":', { mode: 0o600 }); } });
  t.after(manager.dispose);
  const result = await nativeRuntimeReadPreflight({ ...f.input, io: { platform: 'darwin', manager: manager.manager, timeoutMs: 5000 } });
  assert.equal(result.status, 'passed'); assert.equal(result.cleanup, 'completed');
});

test('an actual filesystem denial returns its fixed check ID and EACCES, without reading credentials or blaming all entry failures on TCC', async t => {
  const f = files(t), manager = managedFixture(); t.after(manager.dispose); chmodSync(f.stateFile, 0);
  t.after(() => { if (existsSync(f.stateFile)) chmodSync(f.stateFile, 0o600); });
  await assert.rejects(nativeRuntimeReadPreflight({ ...f.input, io: { platform: 'darwin', manager: manager.manager, timeoutMs: 2000 } }), error => {
    assert.equal(error.code, 'maintenance_native_access_denied'); assert.equal(error.nativePreflight.checks.find(row => row.name === 'application_state').errorCode, 'EACCES');
    assert.equal(error.nativePreflight.cleanup, 'completed'); assert.equal(JSON.stringify(error.nativePreflight).includes(f.root), false); return true;
  });
});

test('symlink input and missing SDK entry cannot produce a successful permission preflight', async t => {
  const f = files(t); rmSync(join(f.runtime, 'packages/sdk/src/index.mjs')); rmSync(f.stateFile); symlinkSync(join(f.host, 'server.mjs'), f.stateFile);
  const manager = managedFixture(); t.after(manager.dispose);
  await assert.rejects(nativeRuntimeReadPreflight({ ...f.input, io: { platform: 'darwin', manager: manager.manager, timeoutMs: 2000 } }), error => {
    assert.equal(error.code, 'maintenance_native_read_failed'); assert.equal(error.nativePreflight.status, 'failed');
    assert.equal(error.nativePreflight.checks.find(row => row.name === 'sdk_entry').errorCode, 'ENOENT');
    assert.equal(error.nativePreflight.checks.find(row => row.name === 'application_state').errorCode, 'ELOOP'); return true;
  });
});

for (const mode of ['preexisting', 'foreign', 'late_foreign', 'no_receipt', 'never_finishes', 'launch_receipt_lost', 'cleanup_lost']) test(`native manager ${mode} fails closed and never removes a foreign job`, async t => {
  const f = files(t), manager = managedFixture({ mode }); t.after(manager.dispose); let clock = 0;
  await assert.rejects(nativeRuntimeReadPreflight({ ...f.input, io: { platform: 'darwin', manager: manager.manager, timeoutMs: 10,
    now: () => clock, sleep: async ms => { clock += ms; await new Promise(done => setTimeout(done, 5)); } } }), error => {
      assert.notEqual(error.nativePreflight?.status, 'passed'); assert.match(error.code, /^maintenance_native_/); return true;
    });
  assert.equal(manager.counts().bootstraps, mode === 'preexisting' ? 0 : 1);
  assert.equal(manager.counts().removed, ['preexisting', 'foreign', 'late_foreign'].includes(mode) ? 0 : 1);
});

for (const key of ['nonce', 'operationId', 'candidateId', 'digest', 'pid']) test(`receipt with wrong ${key} is rejected`, async t => {
  const f = files(t), manager = managedFixture({ mutate: r => { r[key] = key === 'pid' ? -1 : 'wrong'; } }); t.after(manager.dispose);
  await assert.rejects(nativeRuntimeReadPreflight({ ...f.input, io: { platform: 'darwin', manager: manager.manager, timeoutMs: 2000 } }), error => error.code === 'maintenance_native_receipt_invalid');
  assert.equal(manager.counts().removed, 1);
});

test('only a bounded allowlisted public receipt reaches maintenance details', () => {
  const value = publicNativePreflight({ schemaVersion: 1, context: 'launchd', status: 'access_denied', cleanup: 'completed', elapsedMs: 9999999, path: '/secret', nonce: 'private',
    checks: [{ name: 'application_state', ok: false, errorCode: 'EACCES', path: '/secret' }, { name: 'secret_custom_check', ok: true }] });
  assert.deepEqual(value, { schemaVersion: 1, context: 'launchd', status: 'access_denied', cleanup: 'completed', elapsedMs: 60000, checks: [{ name: 'application_state', ok: false, errorCode: 'EACCES' }] });
});

// Real launchd running a freshly copied Node: macOS scans a new executable on its first run, which on a
// busy machine (the full suite runs files in parallel) takes well over the old 15 s; the limits leave room for it.
test('actual one-shot launchd job uses the exact target Node and is removed; isolated temp inputs only', { skip: process.platform !== 'darwin', timeout: 90000 }, async t => {
  const f = files(t), node = join(f.root, 'node'); copyFileSync(process.execPath, node); chmodSync(node, 0o700);
  const result = await nativeRuntimeReadPreflight({ ...f.input, target: { ...f.input.target, command: node }, io: { timeoutMs: 30000 } });
  assert.equal(result.status, 'passed'); assert.equal(result.context, 'launchd'); assert.equal(result.cleanup, 'completed');
  chmodSync(join(f.runtime, 'packages/sdk/src/index.mjs'), 0);
  await assert.rejects(nativeRuntimeReadPreflight({ ...f.input, target: { ...f.input.target, command: node }, io: { timeoutMs: 30000 } }), error => {
    assert.equal(error.code, 'maintenance_native_access_denied'); assert.equal(error.nativePreflight.cleanup, 'completed');
    assert.equal(error.nativePreflight.checks.find(row => row.name === 'sdk_entry').errorCode, 'EACCES'); return true;
  });
});

test('standalone bootstrap CLI rejects duplicate/unknown flags and unregistered candidates before a native job', async t => {
  const f = files(t), args = ['--state', f.stateFile, '--candidate', f.input.candidateId, '--digest', f.input.candidateDigest, '--request-id', f.input.operationId];
  writeFileSync(`${f.stateFile}.service/maintenance-registry.json`, JSON.stringify({ schemaVersion: 1, candidates: [] }));
  await assert.rejects(runNativePreflightCli([...args, '--state', f.stateFile]), { code: 'maintenance_native_input_invalid' });
  await assert.rejects(runNativePreflightCli([...args, '--unknown', 'x']), { code: 'maintenance_native_input_invalid' });
  await assert.rejects(runNativePreflightCli(args), { code: 'maintenance_native_candidate_unregistered' });
  rmSync(`${f.stateFile}.service/maintenance-registry.json`); symlinkSync(f.stateFile, `${f.stateFile}.service/maintenance-registry.json`);
  await assert.rejects(runNativePreflightCli(args), { code: 'maintenance_native_input_invalid' });
});

test('standalone bootstrap CLI verifies a registered immutable slot before actual launchd reads, without creating maintenance state', { skip: process.platform !== 'darwin', timeout: 20000 }, async t => {
  const f = files(t);
  for (const [file, content] of [['prototypes/control-center/package.json', '{"name":"rna-agent","version":"0.20.0"}'], ['packages/sdk/package.json', '{"name":"@rna-agent/sdk","version":"0.13.0"}'], ['prototypes/control-center/service-cli.mjs', '// never execute'], ['bin/rna', '#!/bin/sh\nexit 0']]) {
    const path = join(f.runtime, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
  }
  copyFileSync(process.execPath, join(f.runtime, 'bin/node')); chmodSync(join(f.runtime, 'bin/node'), 0o700);
  createRuntimeManifest({ runtimeRoot: f.runtime, nodeVersion: process.versions.node, platform: process.platform, arch: process.arch });
  const prepared = prepareLocalRuntime({ source: f.runtime, destination: join(`${f.stateFile}.service/releases`, f.input.candidateId) });
  writeFileSync(`${f.stateFile}.service/maintenance-registry.json`, JSON.stringify({ schemaVersion: 1, candidates: [{ id: f.input.candidateId, digest: prepared.digest }] }));
  const before = readFileSync(f.stateFile), config = readFileSync(`${f.stateFile}.service/config.json`);
  const result = await runNativePreflightCli(['--state', f.stateFile, '--candidate', f.input.candidateId, '--digest', prepared.digest, '--request-id', f.input.operationId]);
  assert.equal(result.status, 'passed'); assert.equal(result.cleanup, 'completed'); assert.equal(result.candidateId, f.input.candidateId); assert.equal(result.digest, prepared.digest);
  assert.deepEqual(readFileSync(f.stateFile), before); assert.deepEqual(readFileSync(`${f.stateFile}.service/config.json`), config); assert.equal(existsSync(`${f.stateFile}.service/maintenance.json`), false);
});

async function workerFixture(t) {
  const f = files(t), id = f.input.operationId, candidateId = f.input.candidateId;
  for (const [file, content] of [['prototypes/control-center/package.json', '{"name":"rna-agent","version":"0.20.0"}'], ['packages/sdk/package.json', '{"name":"@rna-agent/sdk","version":"0.13.0"}'], ['prototypes/control-center/service-cli.mjs', '// never execute'], ['bin/rna', '#!/bin/sh\nexit 0']]) { const path = join(f.runtime, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
  const binary = Buffer.alloc(128);
  if (process.platform === 'darwin') { binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(process.arch === 'arm64' ? 0x0100000c : 0x01000007, 4); }
  else { binary.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); binary.writeUInt16LE(process.arch === 'arm64' ? 183 : 62, 18); }
  writeFileSync(join(f.runtime, 'bin/node'), binary, { mode: 0o700 });
  createRuntimeManifest({ runtimeRoot: f.runtime, nodeVersion: '22.19.0', platform: process.platform, arch: process.arch });
  const paths = maintenancePaths(f.stateFile), slot = join(paths.releases, candidateId), release = prepareLocalRuntime({ source: f.runtime, destination: slot });
  await registerMaintenanceEntry(f.stateFile, 'candidates', { id: candidateId, digest: release.digest });
  const identity = 'b'.repeat(64), row = { schemaVersion: 1, id, kind: 'apply', args: { candidateId }, phase: 'waiting_idle', held: true, startedAt: new Date(Date.now() - 100).toISOString(), checkpointId: randomUUID(),
    expected: { hostVersion: '0.19.0', sdkVersion: '0.12.0', stateVersion: 2, nodeVersion: process.versions.node, runtimeIdentity: identity, process: { pid: 123, instanceId: 'old', supervisorRunId: 'old-run', generation: 'old-generation' },
      config: { stateFile: f.stateFile, command: process.execPath, cwd: f.host, port: 64332, manager: 'native' } } };
  persistMaintenance(f.stateFile, row); const calls = []; let phase = 'old', active = true, clock = 0;
  const health = () => phase === 'none' ? null : { ok: true, version: phase === 'old' ? '0.19.0' : '0.20.0', sdkVersion: phase === 'old' ? '0.12.0' : '0.13.0', runtimeIdentity: identity,
    process: phase === 'old' ? row.expected.process : { pid: 456, instanceId: 'new' }, maintenance: { protocolVersion: 1, held: true, operationId: id, questionHandoff: 1 }, workload: { activeWork: active } };
  const io = { platform: 'darwin', now: () => clock, sleep: async ms => { clock += ms; }, waitMs: 1000, verifyMs: 1000, health, runtimeIdentity: () => identity, binding: () => true,
    nativePreflight: async () => { calls.push('preflight'); return { applicable: true, schemaVersion: 1, context: 'launchd', status: 'passed', checks: [], elapsedMs: 10, cleanup: 'completed' }; },
    suspendQuestions: async () => { calls.push('suspend'); active = false; }, service: async (_config, action) => {
      calls.push(action); if (action === 'start') { phase = 'new'; return {}; }
      phase = 'none'; const at = new Date().toISOString();
      writeFileSync(join(paths.directory, 'drain-receipt.json'), JSON.stringify({ schemaVersion: 1, drained: true, ...row.expected.process, runtimeIdentity: identity, maintenanceOperationId: id, at }));
      return { stoppedDaemon: { pid: 123, generation: 'old-generation' }, lastDaemonExit: { pid: 123, generation: 'old-generation', code: 0, signal: null, at } };
    }, createCheckpoint: async ({ destination }) => { calls.push('checkpoint'); return { directory: destination, files: 1, bytes: 1, manifestHash: 'c'.repeat(64), manifest: { sourceStateFile: f.stateFile, createdAt: new Date().toISOString() } }; } };
  return { ...f, row, paths, calls, io, run: () => runMaintenanceOperation({ stateFile: f.stateFile, id, io }), setPhase: value => { phase = value; } };
}

test('worker proves native reads before suspending original questions or stopping service', async t => {
  const f = await workerFixture(t), before = readFileSync(f.stateFile), result = await f.run();
  assert.equal(result.phase, 'completed'); assert.deepEqual(f.calls, ['preflight', 'suspend', 'stop', 'checkpoint', 'start']); assert.deepEqual(readFileSync(f.stateFile), before);
  assert.equal(result.attempts[0].stages.find(row => row.name === 'native_preflight').nativePreflight.status, 'passed');
});

for (const code of ['maintenance_native_access_denied', 'maintenance_native_entry_failed', 'maintenance_native_probe_timeout']) test(`worker ${code} keeps old work/question untouched and releases admission`, async t => {
  const f = await workerFixture(t), before = readFileSync(f.stateFile);
  f.io.nativePreflight = async () => { f.calls.push('preflight'); throw Object.assign(Error('/private/API_KEY=never_expose'), { code, nativePreflight: { schemaVersion: 1, context: 'launchd', status: code.endsWith('access_denied') ? 'access_denied' : 'unconfirmed', checks: [], cleanup: 'completed' } }); };
  const result = await f.run(); assert.equal(result.phase, 'failed'); assert.equal(result.held, false); assert.equal(result.stopped, undefined); assert.deepEqual(f.calls, ['preflight']);
  assert.deepEqual(readFileSync(f.stateFile), before); assert.match(result.summary, /当前服务继续运行/); assert.equal(result.questionHandoff, undefined);
  const text = formatMaintenanceStatus({ current: {}, operation: publicMaintenanceOperation(result) }); assert.match(text, /停机前核对新运行时访问/); assert.equal(text.includes('API_KEY'), false); assert.equal(text.includes('/private'), false);
});

test('cancellation before preflight launches no probe; a stopped legacy operation never fabricates a pre-stop check', async t => {
  const f = await workerFixture(t); persistMaintenance(f.stateFile, { ...readMaintenance(f.stateFile), cancelRequested: true });
  assert.equal((await f.run()).phase, 'cancelled'); assert.deepEqual(f.calls, []);
  persistMaintenance(f.stateFile, { ...f.row, phase: 'recovery_required', stopped: true, checkpointCompleted: true }); f.setPhase('none');
  const resumed = await f.run(); assert.equal(resumed.phase, 'completed'); assert.deepEqual(f.calls, ['preflight', 'start'], 'a resumed stopped operation checks native reads before start, as its own stage');
  const stages = resumed.attempts.at(-1).stages.map(row => row.name);
  assert.equal(stages.includes('native_preflight'), false, 'no pre-stop check is fabricated'); assert.ok(stages.indexOf('native_preflight_start') < stages.indexOf('start'));
});

for (const code of ['maintenance_native_access_denied', 'maintenance_native_probe_timeout']) test(`resume after stop with ${code} does not start the target and stays held, never hanging`, async t => {
  const f = await workerFixture(t);
  persistMaintenance(f.stateFile, { ...f.row, phase: 'recovery_required', stopped: true, checkpointCompleted: true }); f.setPhase('none');
  f.io.nativePreflight = async () => { f.calls.push('preflight'); throw Object.assign(Error('/private/never_expose'), { code, nativePreflight: { schemaVersion: 1, context: 'launchd', status: code.endsWith('access_denied') ? 'access_denied' : 'unconfirmed', checks: [], cleanup: 'completed' } }); };
  const result = await f.run();
  assert.deepEqual(f.calls, ['preflight']); assert.equal(result.phase, 'recovery_required'); assert.equal(result.held, true); assert.equal(result.startAttempted, undefined);
  assert.equal(result.errorCode, code); assert.match(result.summary, /未启动新服务|访问权限/); assert.equal(result.summary.includes('/private'), false);
  assert.equal(result.attempts.at(-1).stages.find(row => row.name === 'native_preflight_start').status, 'failed');
});
