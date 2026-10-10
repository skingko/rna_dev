import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRetention, runRetentionCli, retentionText } from '../maintenance-retention.mjs';
import { writeStateFile } from '../state-shards.mjs';

const at = hour => new Date(Date.UTC(2026, 8, 27, hour)).toISOString();
function fixture(t, { current = 3, journal = null, recovery = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rna-retention-'));
  t.after(() => { chmodTree(root); rmSync(root, { recursive: true, force: true }); });
  const stateFile = join(root, 'state.json'), service = `${stateFile}.service`;
  writeStateFile(stateFile, { version: 2, revision: 1, tasks: [], events: [], sessions: [], projects: [], settings: {}, ...(recovery ? { applicationRecovery: recovery } : {}) });
  for (const directory of [service, join(service, 'releases'), join(service, 'checkpoints')]) mkdirSync(directory, { mode: 0o700 });
  const candidates = Array.from({ length: 6 }, (_, i) => ({ id: randomUUID(), digest: 'a'.repeat(64), hostVersion: `0.${15 + i}.0`, sdkVersion: '0.1.0', trust: 'local_content_verified', baselineOnly: false, preparedAt: at(i) }));
  const checkpoints = Array.from({ length: 6 }, (_, i) => ({ id: randomUUID(), createdAt: at(i), files: 1, bytes: 10, scope: 'local_application_state', verified: true, manifestHash: 'b'.repeat(64) }));
  for (const row of candidates) { const bin = join(service, 'releases', row.id, 'bin'); mkdirSync(bin, { recursive: true, mode: 0o700 }); writeFileSync(join(bin, 'node'), 'runtime'); chmodSync(join(bin, 'node'), 0o500); chmodSync(bin, 0o500); chmodSync(join(service, 'releases', row.id), 0o500); }
  for (const row of checkpoints) { mkdirSync(join(service, 'checkpoints', row.id, 'payload'), { recursive: true, mode: 0o700 }); writeFileSync(join(service, 'checkpoints', row.id, 'manifest.json'), '{}'); }
  const running = candidates[current];
  writeFileSync(join(service, 'config.json'), JSON.stringify({ schemaVersion: 1, stateFile, port: 4999, command: join(service, 'releases', running.id, 'bin/node'), cwd: join(service, 'releases', running.id, 'prototypes/control-center') }));
  writeFileSync(join(service, 'maintenance-registry.json'), JSON.stringify({ schemaVersion: 1, candidates, checkpoints }));
  if (journal) writeFileSync(join(service, 'maintenance.json'), JSON.stringify({ schemaVersion: 1, id: randomUUID(), held: false, ...journal }));
  const leftover = randomUUID(); mkdirSync(join(service, 'releases', leftover)); writeFileSync(join(service, 'releases', leftover, 'partial'), 'x');
  const staging = `.${randomUUID()}.pending-${randomUUID()}`; mkdirSync(join(service, 'checkpoints', staging));
  return { root, stateFile, service, candidates, checkpoints, running, leftover, staging, registry: () => JSON.parse(readFileSync(join(service, 'maintenance-registry.json'), 'utf8')) };
}
function chmodTree(path) { try { chmodSync(path, 0o700); } catch { return; } try { for (const name of readdirSafe(path)) chmodTree(join(path, name)); } catch { /* files */ } }
function readdirSafe(path) { return lstatSync(path).isDirectory() ? readdirSync(path) : []; }

test('dry-run reports the retention plan without touching the registry or directories', async t => {
  const f = fixture(t), before = readFileSync(join(f.service, 'maintenance-registry.json'), 'utf8');
  const result = await applyRetention(f.stateFile, { dryRun: true });
  assert.equal(result.dryRun, true); assert.equal(result.currentRelease, f.running.id);
  assert.deepEqual(new Set(result.keep.candidates), new Set([f.candidates[2].id, f.running.id, f.candidates[5].id]));
  assert.deepEqual(result.keep.checkpoints, f.checkpoints.slice(3).reverse().map(row => row.id));
  assert.equal(result.prune.filter(row => row.reason === 'retention').length, 3 + 3);
  assert.ok(result.prune.some(row => row.id === f.leftover && row.reason === 'unregistered'));
  assert.ok(result.prune.some(row => row.id === f.staging && row.reason === 'abandoned_staging'));
  assert.equal(readFileSync(join(f.service, 'maintenance-registry.json'), 'utf8'), before);
  for (const row of f.candidates) assert.ok(existsSync(join(f.service, 'releases', row.id)));
  assert.match(retentionText(result), /预览/);
});

test('prune rewrites the registry first, removes read-only releases and never the running one', async t => {
  const f = fixture(t);
  const result = await applyRetention(f.stateFile);
  assert.deepEqual(result.failed, []);
  const registry = f.registry();
  assert.deepEqual(registry.candidates.map(row => row.id), [f.candidates[2].id, f.running.id, f.candidates[5].id]);
  assert.deepEqual(registry.checkpoints.map(row => row.id), f.checkpoints.slice(3).map(row => row.id));
  for (const row of f.candidates) assert.equal(existsSync(join(f.service, 'releases', row.id)), registry.candidates.some(kept => kept.id === row.id));
  for (const row of f.checkpoints) assert.equal(existsSync(join(f.service, 'checkpoints', row.id)), registry.checkpoints.some(kept => kept.id === row.id));
  assert.ok(existsSync(join(f.service, 'releases', f.running.id, 'bin/node')));
  assert.ok(!existsSync(join(f.service, 'releases', f.leftover))); assert.ok(!existsSync(join(f.service, 'checkpoints', f.staging)));
  const again = await applyRetention(f.stateFile);
  assert.deepEqual(again.prune, []);
});

test('the newest release is the rollback target when the running release is the oldest', async t => {
  const f = fixture(t, { current: 0 });
  const result = await applyRetention(f.stateFile, { dryRun: true });
  assert.deepEqual(new Set(result.keep.candidates), new Set([f.running.id, f.candidates[5].id]));
});

test('retention refuses to run during an unfinished maintenance operation', async t => {
  const f = fixture(t, { journal: { phase: 'checkpointing', kind: 'backup' } });
  await assert.rejects(applyRetention(f.stateFile, { dryRun: true }), error => error.code === 'maintenance_active');
  await assert.rejects(applyRetention(f.stateFile), error => error.code === 'maintenance_active');
  assert.equal(f.registry().candidates.length, 6);
});

test('a pre-review checkpoint referenced by the restored state is protected', async t => {
  const protectedId = randomUUID();
  const f = fixture(t, { recovery: { operationId: randomUUID(), status: 'reconciled', preReviewCheckpointId: protectedId } });
  mkdirSync(join(f.service, 'checkpoints', protectedId));
  const result = await applyRetention(f.stateFile);
  assert.ok(result.keep.checkpoints.includes(protectedId));
  assert.ok(existsSync(join(f.service, 'checkpoints', protectedId)));
});

test('CLI parses prune flags and an explicit state path', async t => {
  const f = fixture(t);
  const value = await runRetentionCli(['--dry-run', '--json', '--state', f.stateFile]);
  assert.equal(value.json, true); assert.equal(value.result.dryRun, true);
  await assert.rejects(runRetentionCli(['--force', '--state', f.stateFile]), /maintenance prune/);
});

test('prune keeps the shared Node the service runs and removes other shared copies and abandoned staging', async t => {
  const f = fixture(t), nodes = join(f.service, 'node'), keep = '22.19.0-darwin-arm64-0123456789abcdef', old = '22.18.0-darwin-arm64-fedcba9876543210', staging = `.${keep}.pending-${randomUUID()}`;
  for (const name of [keep, old, staging, 'unrelated']) { mkdirSync(join(nodes, name), { recursive: true, mode: 0o700 }); writeFileSync(join(nodes, name, 'node'), 'bin'); chmodSync(join(nodes, name, 'node'), 0o500); }
  const config = JSON.parse(readFileSync(join(f.service, 'config.json'), 'utf8'));
  writeFileSync(join(f.service, 'config.json'), JSON.stringify({ ...config, command: join(nodes, keep, 'node') }));
  const preview = await applyRetention(f.stateFile, { dryRun: true });
  assert.deepEqual(preview.prune.filter(row => row.kind === 'node').map(row => row.id).sort(), [old, staging].sort());
  assert.equal(preview.currentRelease, f.running.id, 'the running release is still found from cwd');
  await applyRetention(f.stateFile);
  assert.deepEqual(readdirSync(nodes).sort(), [keep, 'unrelated'].sort());
});
