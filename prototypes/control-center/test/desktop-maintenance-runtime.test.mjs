import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const require = createRequire(import.meta.url), { resolveManagedRuntime, preparedRuntimeIdentity, assertManagedHealth } = require('../desktop/managed-runtime.cjs'), { DesktopRuntime } = require('../desktop/runtime.cjs'), { stopOwnedSupervisor } = require('../desktop/ownership.cjs'), exec = promisify(execFile);
function fixture(t) {
  const temporary = mkdtempSync(join(tmpdir(), 'rna-desktop-maintenance-')); t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const dataDir = join(temporary, 'data'), stateFile = join(dataDir, 'state.json'), trusted = join(temporary, 'trusted'), id = '12345678-abcd-abcd-abcd-123456789012', slot = `${stateFile}.service/releases/${id}`;
  const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
  const paths = { host: join(trusted, 'prototypes/control-center'), node: join(trusted, 'bin/node'), bin: join(trusted, 'bin'), cli: join(trusted, 'bin/rna') }, chosen = { host: join(slot, 'prototypes/control-center'), node: join(slot, 'bin/node'), bin: join(slot, 'bin'), cli: join(slot, 'bin/rna') };
  write(paths.node, 'trusted-node'); write(join(paths.host, 'server.mjs'), 'trusted host'); write(join(chosen.host, 'server.mjs'), 'selected host'); write(join(slot, 'packages/sdk/src/index.mjs'), 'selected sdk'); write(stateFile, { version: 2 });
  const candidate = { id, digest: 'a'.repeat(64), hostVersion: '0.15.0', sdkVersion: '0.9.0', baselineOnly: false }, config = { stateFile, command: chosen.node, cwd: chosen.host, port: 45234, manager: 'session' }, release = { digest: candidate.digest, paths: chosen, manifest: { nodeVersion: process.versions.node, platform: process.platform, arch: process.arch, hostVersion: candidate.hostVersion, sdkVersion: candidate.sdkVersion } };
  write(`${stateFile}.service/maintenance-registry.json`, { schemaVersion: 1, candidates: [candidate], checkpoints: [] }); write(`${stateFile}.service/config.json`, config);
  return { temporary, dataDir, stateFile, paths, chosen, candidate, config, release, write };
}
test('desktop accepts only a fully verified registered runtime for its exact state directory', async t => {
  const f = fixture(t), calls = [], selected = await resolveManagedRuntime({ ...f, verifyRuntime: async input => { calls.push(input); return f.release; } });
  assert.equal(calls.length, 1); assert.equal(calls[0].expectedDigest, f.candidate.digest); assert.equal(calls[0].policy.stateVersion, 2); assert.deepEqual(selected.paths, f.chosen);
  assertManagedHealth({ version: f.candidate.hostVersion, sdkVersion: f.candidate.sdkVersion, runtimeIdentity: preparedRuntimeIdentity(f.release) }, selected);
  assert.throws(() => assertManagedHealth({ version: f.candidate.hostVersion, sdkVersion: f.candidate.sdkVersion, runtimeIdentity: 'mismatched' }, selected), /运行身份/);
  await assert.rejects(resolveManagedRuntime({ ...f, config: { ...f.config, stateFile: '/foreign/state' }, verifyRuntime: () => assert.fail() }), /状态目录/);
  await assert.rejects(resolveManagedRuntime({ ...f, config: { ...f.config, command: '/unregistered/node' }, verifyRuntime: () => assert.fail() }), /未登记/);
  f.write(`${f.stateFile}.service/maintenance-registry.json`, { schemaVersion: 1, candidates: [{ ...f.candidate, baselineOnly: true }] }); await assert.rejects(resolveManagedRuntime({ ...f, verifyRuntime: () => assert.fail() }), /登记记录/);
});
test('desktop accepts the shared release Node only when its bytes match the slot manifest', async t => {
  const f = fixture(t), shared = `${f.stateFile}.service/node/22.19.0-${process.platform}-${process.arch}-0123456789abcdef/node`, bytes = 'node-bytes';
  f.write(shared, bytes);
  const { createHash } = await import('node:crypto'), release = { ...f.release, paths: { ...f.chosen, sharedNode: shared }, manifest: { ...f.release.manifest, files: [{ path: 'bin/node', type: 'file', sha256: createHash('sha256').update(bytes).digest('hex') }] } };
  const config = { ...f.config, command: shared };
  assert.equal((await resolveManagedRuntime({ ...f, config, verifyRuntime: () => release })).release, release);
  await assert.rejects(resolveManagedRuntime({ ...f, config: { ...config, command: `${f.stateFile}.service/node/other/node` }, verifyRuntime: () => release }), /登记版本/);
  f.write(shared, 'tampered'); await assert.rejects(resolveManagedRuntime({ ...f, config, verifyRuntime: () => release }), /登记版本/);
});
test('desktop never attaches a modified digest or a verifier result bound to another version', async t => {
  const f = fixture(t); await assert.rejects(resolveManagedRuntime({ ...f, verifyRuntime: () => { throw Error('RUNTIME_CONTENT_MISMATCH'); } }), /RUNTIME_CONTENT_MISMATCH/);
  await assert.rejects(resolveManagedRuntime({ ...f, verifyRuntime: () => ({ ...f.release, digest: 'b'.repeat(64) }) }), /登记版本/);
});
test('desktop attaches a verified active upgrade without invoking its old application service start', async t => {
  const f = fixture(t), identity = preparedRuntimeIdentity(f.release), connection = { origin: 'http://127.0.0.1:45234', port: 45234, stateFile: f.stateFile, daemonPid: 101, instanceId: 'instance' }, owner = { pid: 100, birth: 'birth', token: 'token', supervisorRunId: 'run' }, stops = [];
  const runtime = new DesktopRuntime({ ...f, env: { RNA_DESKTOP_ISOLATED: '1' }, selectRuntime: input => resolveManagedRuntime({ ...input, verifyRuntime: () => f.release }), verifyConnection: async () => connection, request: async () => Response.json({ version: '0.15.0', sdkVersion: '0.9.0', runtimeIdentity: identity, process: { pid: 101, instanceId: 'instance' } }), run: () => assert.fail('old app must not start'), readOwner: async input => { assert.deepEqual(input.paths, f.chosen); return owner; }, stopOwner: async input => stops.push(input) });
  const result = await runtime.start(); assert.equal(result.managed, true); await runtime.stop(); assert.deepEqual(stops[0].paths, f.chosen); assert.equal(stops[0].owner, owner);
});
test('desktop waits through held maintenance and attaches without acquiring shutdown ownership', async t => {
  const f = fixture(t); f.write(`${f.stateFile}.service/maintenance.json`, { schemaVersion: 1, held: true, phase: 'switching' }); let clock = 0, checks = 0; const statuses = [], identity = preparedRuntimeIdentity(f.release);
  const runtime = new DesktopRuntime({ ...f, env: { RNA_DESKTOP_ISOLATED: '1' }, now: () => clock, wait: async ms => { clock += ms; }, onStatus: message => statuses.push(message), selectRuntime: input => resolveManagedRuntime({ ...input, verifyRuntime: () => f.release }), verifyConnection: async () => ++checks < 2 ? null : { origin: 'http://127.0.0.1:45234', port: 45234, daemonPid: 101, instanceId: 'instance' }, request: async () => Response.json({ version: '0.15.0', sdkVersion: '0.9.0', runtimeIdentity: identity, process: { pid: 101, instanceId: 'instance' } }), run: () => assert.fail('held maintenance must not start'), readOwner: () => assert.fail('maintenance owns shutdown'), stopOwner: () => assert.fail('must not stop maintenance') });
  await runtime.start(); await runtime.stop(); assert.equal(checks, 2); assert.match(statuses[0], /维护中/); assert.equal(runtime.maintenanceAttached, true);
});
test('maintenance admission and application quit are serialized; held service is never signalled', async t => {
  const f = fixture(t), locks = [], owner = { pid: 100, birth: 'birth', token: 'token', supervisorRunId: 'run' }; f.write(`${f.stateFile}.service/supervisor.lock`, owner);
  const result = await stopOwnedSupervisor({ ...f, owner, identities: { acquireProcessLease: async path => { locks.push(path); f.write(`${f.stateFile}.service/maintenance.json`, { schemaVersion: 1, held: true }); return () => locks.push('release-maintenance'); }, processAlive: () => true, processBirth: () => 'birth' }, acquire: async path => { locks.push(path); return () => locks.push('release-operation'); }, writeIntent: () => assert.fail('must not disable held service'), signal: () => assert.fail('must not signal') });
  assert.deepEqual(result, { stopped: false, reason: 'maintenance_held' }); assert.deepEqual(locks, [`${f.stateFile}.service/operation.lock`, `${f.stateFile}.service/maintenance-control.lock`, 'release-maintenance', 'release-operation']);
});
test('an external workspace under maintenance never falls back to a new private workspace', async t => {
  const f = fixture(t), originalState = join(f.temporary, 'original/state.json'), serviceConfig = `${originalState}.service/config.json`;
  f.write(serviceConfig, { stateFile: originalState, command: '/original/node', cwd: '/original/host', port: 45234 }); f.write(`${originalState}.service/maintenance.json`, { schemaVersion: 1, held: true });
  f.write(join(f.dataDir, 'desktop-connection.json'), { managed: false, stateFile: originalState, serviceConfig });
  let clock = 0, attempts = 0;
  const runtime = new DesktopRuntime({ ...f, env: {}, now: () => clock, wait: async ms => { clock += ms; }, verifyConnection: async path => { assert.equal(path, serviceConfig); if (++attempts === 1) return null; return { managed: false, stateFile: originalState, serviceConfig, origin: 'http://127.0.0.1:45234', port: 45234 }; }, run: () => assert.fail('must not start a private replacement'), choosePort: () => assert.fail('must not allocate a replacement port'), stopOwner: () => assert.fail('external owner') });
  const result = await runtime.start(); assert.equal(result.stateFile, originalState); assert.equal(runtime.external, true); assert.equal(attempts, 2); await runtime.stop();
});
test('packaged CLI offline recovery preserves explicit state and keeps legacy session recovery routing', async t => {
  const f = fixture(t), launcher = join(f.temporary, 'application/runtime/bin/cli-launcher.mjs'), host = join(f.temporary, 'application/runtime/prototypes/control-center'); f.write(launcher, readFileSync(new URL('../desktop/cli-launcher.mjs', import.meta.url), 'utf8'));
  for (const [file, route] of [['application-recovery-cli.mjs', 'offline'], ['cli.mjs', 'session']]) f.write(join(host, file), `console.log(JSON.stringify({route:${JSON.stringify(route)},state:process.env.RNA_AGENT_STATE,args:process.argv.slice(2)}));`);
  const run = async args => JSON.parse((await exec(process.execPath, [launcher, ...args], { env: { ...process.env, RNA_DESKTOP_DATA: f.dataDir, RNA_AGENT_STATE: f.stateFile, RNA_AGENT_PORT: '45234' }, timeout: 5000 })).stdout);
  for (const action of ['status', 'resume', 'reconcile', 'restore']) { const result = await run(['recovery', action]); assert.equal(result.route, 'offline'); assert.equal(result.state, f.stateFile); }
  assert.equal((await run(['recovery', 'session-1'])).route, 'session');
  const offline = JSON.parse((await exec(process.execPath, [launcher, 'recovery', 'status'], { env: { ...process.env, RNA_DESKTOP_DATA: f.dataDir, RNA_AGENT_STATE: f.stateFile, RNA_AGENT_PORT: '' }, timeout: 5000 })).stdout); assert.equal(offline.state, f.stateFile); assert.equal(offline.route, 'offline');
  f.write(join(f.temporary, 'application/runtime/desktop/managed-runtime.cjs'), 'module.exports={resolveManagedRuntime:async({paths})=>({paths,release:null})};');
  f.write(join(host, 'service-cli.mjs'), 'console.log(JSON.stringify({route:"service",state:process.env.RNA_AGENT_STATE,args:process.argv.slice(2)}));');
  f.write(join(f.dataDir, 'desktop-connection.json'), { managed: true, stateFile: f.stateFile, port: 45234 });
  assert.equal((await run(['service', 'status'])).route, 'service', 'a standalone runtime uses its included desktop bridge, without an enclosing .app');
});
