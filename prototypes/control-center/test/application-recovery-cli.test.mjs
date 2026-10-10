import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath, chmod, copyFile, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Store } from '../store.mjs';
import { atomicWrite } from '../durable-files.mjs';
import { acquireProcessLease } from '../process-lease.mjs';
import { createStateCheckpoint } from '../state-checkpoint.mjs';
import { maintenancePaths, readMaintenance, persistMaintenance, ensureMaintenancePaths } from '../application-maintenance-state.mjs';
import { runApplicationRecoveryCli } from '../application-recovery-cli.mjs';
import { runtimeImplementationIdentity } from '../runtime-identity.mjs';
import { createRuntimeManifest, prepareLocalRuntime } from '../runtime-release.mjs';
import { readStateFile } from '../state-shards.mjs';

async function makeWritable(path) { const info = await lstat(path); if (info.isSymbolicLink()) return; await chmod(path, info.mode | 0o700); if (info.isDirectory()) for (const entry of await readdir(path)) await makeWritable(join(path, entry)); }

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-recovery-cli-')); t.after(async () => { await makeWritable(directory); await rm(directory, { recursive: true, force: true }); });
  const stateFile = join(directory, 'state.json'), store = new Store(stateFile), paths = maintenancePaths(stateFile), checkpointId = randomUUID();
  await mkdir(paths.checkpoints, { recursive: true, mode: 0o700 });
  const runtime = join(directory, 'runtime'), host = join(runtime, 'prototypes/control-center');
  await mkdir(host, { recursive: true }); await mkdir(join(runtime, 'packages/sdk/src'), { recursive: true });
  await writeFile(join(host, 'server.mjs'), 'export const server = true;'); await writeFile(join(host, 'service-cli.mjs'), 'export const cli = true;');
  await writeFile(join(runtime, 'packages/sdk/src/index.mjs'), 'export const sdk = true;');
  const config = { stateFile, command: process.execPath, cwd: host, port: 4318, manager: 'session' };
  atomicWrite(join(paths.directory, 'config.json'), JSON.stringify(config));
  atomicWrite(join(paths.directory, 'status.json'), JSON.stringify({ phase: 'stopped', health: { version: '0.15.0', sdkVersion: '0.9.0', node: process.version, runtimeIdentity: runtimeImplementationIdentity({ root: host }), process: { pid: 123456789, instanceId: 'former-instance', generation: 'former-generation' } } }));
  const checkpoint = await createStateCheckpoint({ stateFile, destination: join(paths.checkpoints, checkpointId) });
  atomicWrite(paths.registry, JSON.stringify({ schemaVersion: 1, candidates: [], checkpoints: [{ id: checkpointId, verified: true, manifestHash: checkpoint.manifestHash }] }));
  const launches = [], services = [], io = { launch: async value => launches.push(value), service: async (_config, action, path, id) => { services.push({ action, path, id }); return { phase: action === 'stop' ? 'stopped' : 'running' }; } };
  return { directory, stateFile, store, paths, checkpointId, checkpoint, config, runtime, launches, services, io };
}
async function restoredFixture(t) {
  const f = await fixture(t), restored = await runApplicationRecoveryCli(['recovery', 'restore', f.checkpointId, '--confirm'], f);
  persistMaintenance(f.stateFile, { ...readMaintenance(f.stateFile), phase: 'recovery_required', owner: null });
  return { ...f, operationId: restored.operationId };
}

test('fresh-install recovery status --json works through the actual CLI with no maintenance or recovery record', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rna-fresh-recovery-cli-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, 'state.json'); new Store(stateFile);
  const result = await promisify(execFile)(process.execPath, [join(import.meta.dirname, '../application-recovery-cli.mjs'), 'recovery', 'status', '--json'], { env: { ...process.env, RNA_AGENT_STATE: stateFile }, timeout: 10000 });
  assert.equal(result.stderr, '');
  const status = JSON.parse(result.stdout); assert.equal(status.operation, null); assert.equal(status.held, false); assert.deepEqual(status.checkpoints, []);
  assert.equal(status.recovery.reconciled, false); assert.equal(status.recovery.required, false);
});

for (const kind of ['corrupt', 'missing']) test(`offline CLI can report and recover a ${kind} primary state from a registered verified checkpoint`, async t => {
  const f = await fixture(t);
  if (kind === 'missing') await rm(f.stateFile); else await writeFile(f.stateFile, '{broken');
  const status = await runApplicationRecoveryCli(['recovery', 'status', '--json'], f);
  assert.equal(status.recovery.available, false); assert.equal(status.checkpoints.length, 1);
  const result = await runApplicationRecoveryCli(['recovery', 'restore', f.checkpointId, '--confirm'], f);
  assert.equal(result.accepted, true); assert.equal(result.completed, false); assert.equal(f.launches.length, 1);
  const row = readMaintenance(f.stateFile); assert.equal(row.id, result.operationId); assert.equal(row.restoreCompleted, true); assert.equal(row.held, true);
  assert.equal(readStateFile(f.stateFile).state.emergency, true);
});

test('offline restore fails before publishing a maintenance hold when a daemon is still alive', async t => {
  const f = await fixture(t), release = await acquireProcessLease(`${f.stateFile}.lock`); t.after(release);
  const before = await readFile(f.stateFile);
  await assert.rejects(runApplicationRecoveryCli(['recovery', 'restore', f.checkpointId, '--confirm'], f), { code: 'checkpoint_not_offline' });
  assert.equal(readMaintenance(f.stateFile), null); assert.deepEqual(await readFile(f.stateFile), before); assert.equal(f.launches.length, 0);
});

test('canonical checkpoint binding accepts an alias parent without rewriting service ownership paths', async t => {
  const f = await fixture(t), alias = join(f.directory, 'alias'), actual = join(f.directory, 'actual'); await mkdir(actual);
  await symlink(f.directory, alias);
  const aliasedState = join(alias, 'state.json');
  const paths = ensureMaintenancePaths(aliasedState);
  assert.equal(paths.stateFile, aliasedState); assert.equal(paths.canonicalStateFile, await realpath(f.stateFile));
  const result = await runApplicationRecoveryCli(['recovery', 'restore', f.checkpointId, '--confirm'], { ...f, stateFile: aliasedState });
  assert.equal(result.accepted, true); assert.equal(f.launches[0].stateFile, aliasedState);
  const row = readMaintenance(f.stateFile); assert.equal(row.expected.config.stateFile, f.stateFile);
});

test('CLI reconciliation releases its stop owner before offline review and starts only after review is durable', async t => {
  const f = await fixture(t), restored = await runApplicationRecoveryCli(['recovery', 'restore', f.checkpointId, '--confirm'], f);
  persistMaintenance(f.stateFile, { ...readMaintenance(f.stateFile), phase: 'recovery_required', owner: null });
  const result = await runApplicationRecoveryCli(['recovery', 'reconcile', restored.operationId, '--confirm'], f);
  assert.equal(result.completed, true); assert.deepEqual(f.services.map(row => row.action), ['stop', 'start']);
  assert.equal(readMaintenance(f.stateFile).held, false); assert.equal(readStateFile(f.stateFile).state.applicationRecovery.status, 'reconciled');
  const bytes = await readFile(f.stateFile);
  await runApplicationRecoveryCli(['recovery', 'reconcile', restored.operationId, '--confirm'], f);
  assert.deepEqual(f.services.map(row => row.action), ['stop', 'start', 'start']); assert.deepEqual(await readFile(f.stateFile), bytes);
});

test('restore and reconciliation need explicit confirmation and strict argument parsing', async t => {
  const f = await fixture(t);
  await assert.rejects(runApplicationRecoveryCli(['recovery', 'restore', f.checkpointId], f), { code: 'recovery_confirmation_required' });
  for (const args of [['recovery', 'status', '--confirm'], ['recovery', 'status', '--json', '--json'], ['recovery', 'resume', randomUUID(), '--confirm'], ['recovery', 'restore', f.checkpointId, '--confirm', '--confirm'], ['recovery', 'unknown']]) await assert.rejects(runApplicationRecoveryCli(args, f), { code: 'recovery_input_invalid' });
  assert.equal(readMaintenance(f.stateFile), null); assert.equal(f.launches.length, 0);
});

test('unregistered checkpoints and mismatched service configurations cannot trigger any launch', async t => {
  const f = await fixture(t);
  await assert.rejects(runApplicationRecoveryCli(['recovery', 'restore', randomUUID(), '--confirm'], f), { code: 'maintenance_checkpoint_invalid' });
  atomicWrite(join(f.paths.directory, 'config.json'), JSON.stringify({ ...f.config, stateFile: join(f.directory, 'unrelated.json') }));
  await assert.rejects(runApplicationRecoveryCli(['recovery', 'restore', f.checkpointId, '--confirm'], f), { code: 'recovery_runtime_binding' });
  assert.equal(f.launches.length, 0); assert.equal(readMaintenance(f.stateFile), null);
});

test('shared maintenance path guard rejects linked metadata and control roots, while missing primary state is allowed', async t => {
  const f = await fixture(t); await rm(f.stateFile); assert.equal(ensureMaintenancePaths(f.stateFile).canonicalStateFile.endsWith('/state.json'), true);
  await rm(join(f.paths.directory, 'config.json')); await symlink(join(f.directory, 'outside'), join(f.paths.directory, 'config.json'));
  assert.throws(() => ensureMaintenancePaths(f.stateFile), { code: 'maintenance_unsafe_path' });
  await assert.rejects(runApplicationRecoveryCli(['recovery', 'status'], f), { code: 'maintenance_unsafe_path' });
});

test('reconciliation refuses changed source before invoking stop or claiming ownership', async t => {
  const f = await restoredFixture(t);
  await writeFile(join(f.config.cwd, 'server.mjs'), 'export const changed = true;');
  const before = await readFile(f.stateFile);
  await assert.rejects(runApplicationRecoveryCli(['recovery', 'reconcile', f.operationId, '--confirm'], f), { code: 'recovery_runtime_changed' });
  assert.deepEqual(f.services, []); assert.deepEqual(await readFile(f.stateFile), before);
  assert.equal(readMaintenance(f.stateFile).owner, null); assert.equal(readMaintenance(f.stateFile).held, true);
});

for (const field of ['port', 'manager', 'cwd']) test(`reconciliation rejects changed ${field} rather than trusting the latest config`, async t => {
  const f = await restoredFixture(t);
  atomicWrite(join(f.paths.directory, 'config.json'), JSON.stringify({ ...f.config, [field]: { port: 4419, manager: 'native', cwd: f.directory }[field] }));
  await assert.rejects(runApplicationRecoveryCli(['recovery', 'reconcile', f.operationId, '--confirm'], f), { code: 'recovery_runtime_binding' });
  assert.deepEqual(f.services, []); assert.equal(readMaintenance(f.stateFile).held, true);
});

test('an unfamiliar Node is read only, never probed or executed, and does not publish an offline restore', async t => {
  const f = await fixture(t), command = join(f.directory, 'untrusted-node'), sentinel = join(f.directory, 'executed');
  await writeFile(command, `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o700 });
  atomicWrite(join(f.paths.directory, 'config.json'), JSON.stringify({ ...f.config, command }));
  await assert.rejects(runApplicationRecoveryCli(['recovery', 'restore', f.checkpointId, '--confirm'], f), { code: 'recovery_node_untrusted' });
  await assert.rejects(readFile(sentinel), { code: 'ENOENT' }); assert.deepEqual(f.services, []); assert.deepEqual(f.launches, []); assert.equal(readMaintenance(f.stateFile), null);
});

test('a relocated byte-identical trusted Node supports restore and reconciliation without executing a version probe', async t => {
  const f = await fixture(t), command = join(f.directory, 'copied-node'); await copyFile(process.execPath, command); await chmod(command, 0o700);
  atomicWrite(join(f.paths.directory, 'config.json'), JSON.stringify({ ...f.config, command }));
  const restored = await runApplicationRecoveryCli(['recovery', 'restore', f.checkpointId, '--confirm'], f);
  persistMaintenance(f.stateFile, { ...readMaintenance(f.stateFile), phase: 'recovery_required', owner: null });
  await runApplicationRecoveryCli(['recovery', 'reconcile', restored.operationId, '--confirm'], f);
  assert.deepEqual(f.services.map(value => value.action), ['stop', 'start']);
});

test('a stale recorded Node version cannot be substituted into the source identity calculation', async t => {
  const f = await restoredFixture(t), row = readMaintenance(f.stateFile);
  persistMaintenance(f.stateFile, { ...row, expected: { ...row.expected, nodeVersion: '99.0.0', runtimeIdentity: runtimeImplementationIdentity({ root: f.config.cwd, nodeVersion: '99.0.0' }) } });
  await assert.rejects(runApplicationRecoveryCli(['recovery', 'reconcile', f.operationId, '--confirm'], f), { code: 'recovery_runtime_changed' });
  assert.deepEqual(f.services, []);
});

test('reconciliation rechecks source before start even after the review is durably completed', async t => {
  const f = await restoredFixture(t), ordinaryService = f.io.service;
  f.io.service = async (...args) => { const result = await ordinaryService(...args); if (args[1] === 'stop') await writeFile(join(f.config.cwd, 'server.mjs'), 'export const replaced = true;'); return result; };
  await assert.rejects(runApplicationRecoveryCli(['recovery', 'reconcile', f.operationId, '--confirm'], f), { code: 'recovery_runtime_changed' });
  assert.deepEqual(f.services.map(value => value.action), ['stop']);
  const state = readStateFile(f.stateFile).state; assert.equal(state.emergency, true); assert.equal(state.applicationRecovery.status, 'reconciled');
});

async function registeredSlot(f, { register = true } = {}) {
  const put = async (path, content, mode = 0o600) => { const file = join(f.runtime, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, content, { mode }); };
  await put('prototypes/control-center/package.json', JSON.stringify({ name: 'rna-agent', version: '0.15.0' }));
  await put('packages/sdk/package.json', JSON.stringify({ name: '@rna-agent/sdk', version: '0.9.0' }));
  await put('prototypes/control-center/web/dist/assets/app.js', 'export const ui = true;');
  const binary = Buffer.alloc(128);
  if (process.platform === 'darwin') { binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(process.arch === 'arm64' ? 0x0100000c : 0x01000007, 4); }
  else { binary.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); binary.writeUInt16LE(process.arch === 'arm64' ? 183 : 62, 18); }
  await put('bin/node', binary, 0o700); await put('bin/rna', '#!/bin/sh\nexit 0\n', 0o700);
  createRuntimeManifest({ runtimeRoot: f.runtime, nodeVersion: process.versions.node });
  const id = randomUUID(), release = prepareLocalRuntime({ source: f.runtime, destination: join(f.paths.releases, id) });
  const registry = JSON.parse(await readFile(f.paths.registry)); if (register) registry.candidates.push({ id, digest: release.digest }); atomicWrite(f.paths.registry, JSON.stringify(registry));
  const config = { ...f.config, command: release.paths.node, cwd: release.paths.host };
  atomicWrite(join(f.paths.directory, 'config.json'), JSON.stringify(config));
  const status = JSON.parse(await readFile(join(f.paths.directory, 'status.json'))); status.health.runtimeIdentity = runtimeImplementationIdentity({ root: config.cwd }); atomicWrite(join(f.paths.directory, 'status.json'), JSON.stringify(status));
  return { id, release, config };
}

test('a registered slot is fully rehashed before both restore and reconciliation, including UI assets outside source identity', async t => {
  const f = await fixture(t), slot = await registeredSlot(f);
  const restored = await runApplicationRecoveryCli(['recovery', 'restore', f.checkpointId, '--confirm'], f);
  persistMaintenance(f.stateFile, { ...readMaintenance(f.stateFile), phase: 'recovery_required', owner: null });
  await runApplicationRecoveryCli(['recovery', 'reconcile', restored.operationId, '--confirm'], f);
  assert.deepEqual(f.services.map(value => value.action), ['stop', 'start']);
  const asset = join(slot.config.cwd, 'web/dist/assets/app.js'); await chmod(asset, 0o600); await writeFile(asset, 'tampered');
  await assert.rejects(runApplicationRecoveryCli(['recovery', 'reconcile', restored.operationId, '--confirm'], f), { code: 'RUNTIME_CONTENT_MISMATCH' });
  assert.deepEqual(f.services.map(value => value.action), ['stop', 'start']);
});

test('a prepared but unregistered slot cannot authorize its own binary', async t => {
  const f = await fixture(t); await registeredSlot(f, { register: false });
  await assert.rejects(runApplicationRecoveryCli(['recovery', 'restore', f.checkpointId, '--confirm'], f), { code: 'recovery_runtime_binding' });
  assert.deepEqual(f.services, []); assert.deepEqual(f.launches, []); assert.equal(readMaintenance(f.stateFile), null);
});
