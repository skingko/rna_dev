import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, chmod, symlink, readlink, link, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { acquireProcessLease } from '../process-lease.mjs';
import { acquireCheckpointLease, assertStateRecoveryReady, CHECKPOINT_SIDECARS, createStateCheckpoint, recoveryPending, restoreStateCheckpoint, restoreStateCheckpointOriginal, verifyStateCheckpoint } from '../state-checkpoint.mjs';
import { Store } from '../store.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { projectGenomeFixture } from '../../../packages/sdk/test/fixtures/project-genome-fixture.mjs';
import { openJournal } from '../../../packages/sdk/src/journal.mjs';
import { readStateFile } from '../state-shards.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const initial = { version: 2, revision: 3, tasks: [], events: [], sessions: [], projects: [], settings: { realTokenBudget: null }, emergency: false, fixture: 'before' };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rna-checkpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'private'); await mkdir(data, { mode: 0o700 });
  const stateFile = join(data, 'state.json'); await writeFile(stateFile, JSON.stringify(initial), { mode: 0o600 });
  const destination = join(root, 'snapshot');
  const write = async (suffix, content = suffix) => { const path = `${stateFile}${suffix}`; await mkdir(join(path, '..'), { recursive: true, mode: 0o700 }); await writeFile(path, content, { mode: 0o600 }); return path; };
  return { root, data, stateFile, destination, write };
}
async function rewriteManifest(directory, mutate) {
  const path = join(directory, 'manifest.json'), manifest = JSON.parse(await readFile(path, 'utf8')); mutate(manifest);
  const bytes = `${JSON.stringify(manifest)}\n`; await writeFile(path, bytes); await writeFile(join(directory, 'manifest.sha256'), `${hash(bytes)}\n`);
}

test('offline checkpoint covers every owned sidecar, excludes project files and preserves private permissions', async t => {
  const f = await fixture(t);
  for (const suffix of CHECKPOINT_SIDECARS.slice(1)) await f.write(['.secrets', '.subscriptions'].includes(suffix) ? suffix : `${suffix}/nested/entry`, 'private fixture');
  await f.write('.service/config.json', '{"command":"/old-runtime"}');
  await f.write('.before-fixture', 'historical backup');
  await mkdir(join(f.data, 'projects')); await writeFile(join(f.data, 'projects', 'project-file'), 'do not snapshot');
  await chmod(`${f.stateFile}.secrets`, 0o644);
  const result = await createStateCheckpoint({ ...f, hostVersion: '0.14.0', sdkVersion: '0.8.0' });
  assert.equal(result.manifest.roots.length, CHECKPOINT_SIDECARS.length + 1);
  assert.ok(result.manifest.roots.every(row => row.present));
  assert.ok(result.manifest.exclusions.includes('remote-openviking-data'));
  assert.equal(result.manifest.restore.serviceConfigurationRestored, false);
  assert.equal(JSON.stringify(result.manifest).includes('private fixture'), false);
  assert.equal(result.manifest.entries.some(row => row.path.includes('before-fixture') || row.path.includes('project-file') || row.path.endsWith('.lock')), false);
  assert.equal((await stat(join(f.destination, 'payload', 'state.json.secrets'))).mode & 0o777, 0o600);
  assert.equal((await stat(f.destination)).mode & 0o777, 0o700);
  assert.equal((await verifyStateCheckpoint({ directory: f.destination })).manifestHash, result.manifestHash);
  const restored = await restoreStateCheckpoint({ directory: f.destination, destination: join(f.root, 'restored') });
  assert.equal(restored.stagingOnly, true);
  assert.deepEqual(readStateFile(restored.stateFile).state, initial);
  assert.equal((await readdir(restored.directory)).includes('state.json.service'), false, 'old runtime and supervisor ownership are evidence only');
  const marker = JSON.parse(await readFile(join(restored.directory, 'restoration.json'), 'utf8'));
  assert.equal(marker.absolutePathsPreserved, true); assert.equal(marker.remoteMemoryRestored, false); assert.equal(marker.externalEffectsReviewRequired, true);
});

test('a borrowed offline lease serializes checkpoint and later release work; forged, mismatched and released leases fail', async t => {
  const f = await fixture(t), lease = await acquireCheckpointLease(f.stateFile); t.after(() => lease.release());
  await assert.rejects(createStateCheckpoint({ ...f, lease: { stateFile: f.stateFile } }), { code: 'checkpoint_invalid_lease' });
  const other = join(f.data, 'other.json'); await writeFile(other, JSON.stringify(initial));
  await assert.rejects(createStateCheckpoint({ ...f, stateFile: other, lease }), { code: 'checkpoint_invalid_lease' });
  await createStateCheckpoint({ ...f, lease });
  await assert.rejects(acquireProcessLease(`${f.stateFile}.lock`));
  lease.release(); lease.release();
  await assert.rejects(createStateCheckpoint({ ...f, destination: join(f.root, 'again'), lease }), { code: 'checkpoint_invalid_lease' });
  const stateRelease = await acquireProcessLease(`${f.stateFile}.lock`); stateRelease();
});

for (const lock of ['state', 'operation', 'supervisor']) test(`checkpoint refuses a live ${lock} owner without stopping or changing it`, async t => {
  const f = await fixture(t), path = lock === 'state' ? `${f.stateFile}.lock` : `${f.stateFile}.service/${lock}.lock`;
  const release = await acquireProcessLease(path); t.after(release);
  const before = await readFile(path);
  await assert.rejects(createStateCheckpoint(f), { code: 'checkpoint_not_offline' });
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(readStateFile(f.stateFile).state, initial);
});

test('unknown state sidecars fail closed rather than silently making an incomplete backup', async t => {
  const f = await fixture(t); await f.write('.future', 'must not omit');
  await assert.rejects(createStateCheckpoint(f), { code: 'checkpoint_unknown_sidecar' });
  assert.equal((await readdir(f.root)).includes('snapshot'), false);
});

test('an isolated live SDK journal writer blocks a checkpoint even without a daemon owner', async t => {
  const f = await fixture(t); await f.write('.rna/session/test.rna.jsonl', 'fixture'); await f.write('.rna/session/test.rna.jsonl.lock', JSON.stringify({ pid: process.pid }));
  await assert.rejects(createStateCheckpoint(f), { code: 'checkpoint_not_offline' });
});

test('stale SDK ownership is not revived by restore, but package-lock metadata is preserved', async t => {
  const f = await fixture(t); await f.write('.rna/session/test.rna.jsonl', 'fixture'); await f.write('.rna/session/test.rna.jsonl.lock', JSON.stringify({ pid: 2147483647 }));
  await f.write('.capabilities/package-lock.json', '{"version":1}');
  const result = await createStateCheckpoint(f);
  assert.equal(result.manifest.entries.some(entry => entry.path.endsWith('.jsonl.lock')), false);
  assert.equal(result.manifest.entries.some(entry => entry.path.endsWith('package-lock.json')), true);
});

test('relative npm symlinks within one sidecar and executable entrypoints survive round trip', async t => {
  const f = await fixture(t); await f.write('.capabilities/npm/node_modules/pkg/bin.js', '#!/usr/bin/env node\n');
  await chmod(`${f.stateFile}.capabilities/npm/node_modules/pkg/bin.js`, 0o755);
  await mkdir(`${f.stateFile}.capabilities/npm/node_modules/.bin`);
  await symlink('../pkg/bin.js', `${f.stateFile}.capabilities/npm/node_modules/.bin/pkg`);
  await createStateCheckpoint(f);
  const result = await restoreStateCheckpoint({ directory: f.destination, destination: join(f.root, 'stage') });
  assert.equal(await readlink(`${result.stateFile}.capabilities/npm/node_modules/.bin/pkg`), '../pkg/bin.js');
  assert.equal((await stat(`${result.stateFile}.capabilities/npm/node_modules/pkg/bin.js`)).mode & 0o777, 0o700);
});

for (const kind of ['absolute', 'escape', 'dangling', 'cycle', 'root', 'hardlink']) test(`checkpoint rejects ${kind} links`, async t => {
  const f = await fixture(t); await f.write('.rna/session/ordinary', 'same sidecar');
  if (kind === 'root') { await rm(`${f.stateFile}.rna`, { recursive: true }); await symlink(f.root, `${f.stateFile}.rna`); }
  else if (kind === 'hardlink') await link(f.stateFile, `${f.stateFile}.rna/session/link`);
  else await symlink({ absolute: f.stateFile, escape: '../../../state.json', dangling: 'missing', cycle: 'link' }[kind], `${f.stateFile}.rna/session/link`);
  await assert.rejects(createStateCheckpoint(f), { code: 'checkpoint_unsafe_path' });
});

test('source-side and destination-side symlinks cannot redirect state or an existing checkpoint', async t => {
  const f = await fixture(t); await symlink(f.stateFile, join(f.data, 'alias.json'));
  await assert.rejects(createStateCheckpoint({ ...f, stateFile: join(f.data, 'alias.json') }), { code: 'checkpoint_unsafe_path' });
  await symlink(f.data, f.destination);
  await assert.rejects(createStateCheckpoint(f), { code: 'checkpoint_destination_exists' });
});

test('restore refuses existing directories and never overwrites their contents', async t => {
  const f = await fixture(t); await createStateCheckpoint(f);
  await assert.rejects(restoreStateCheckpoint({ directory: f.destination, destination: f.data }), { code: 'checkpoint_destination_exists' });
  assert.deepEqual(readStateFile(f.stateFile).state, initial);
});

test('checkpoint cannot copy its output into one of its owned roots', async t => {
  const f = await fixture(t); await mkdir(`${f.stateFile}.rna`);
  await assert.rejects(createStateCheckpoint({ ...f, destination: `${f.stateFile}.rna/snapshot` }), { code: 'checkpoint_unsafe_path' });
});

test('service checkpoint location is supported without recursively backing up releases, snapshots, maintenance records or locks', async t => {
  const f = await fixture(t); await f.write('.service/config.json', '{"command":"fixture"}');
  await f.write('.service/releases/candidate/app.js', 'application code'); await f.write('.service/checkpoints/old/payload/secret', 'historical checkpoint secret');
  await f.write('.service/maintenance.json', '{"phase":"checkpoint"}'); await f.write('.service/maintenance-control.lock', 'running worker');
  await f.write('.service/endurance-samples.jsonl', 'monitor logs');
  const result = await createStateCheckpoint({ ...f, destination: `${f.stateFile}.service/checkpoints/new` });
  assert.deepEqual(result.manifest.entries.filter(row => row.path.startsWith('state.json.service')).map(row => row.path), ['state.json.service', 'state.json.service/config.json']);
  assert.equal((await verifyStateCheckpoint({ directory: result.directory })).id, result.id);
});

test('verification rejects loosened private permissions, including secret payloads', async t => {
  const f = await fixture(t); await f.write('.secrets', 'fixture'); await createStateCheckpoint(f);
  await chmod(join(f.destination, 'payload/state.json.secrets'), 0o644);
  await assert.rejects(verifyStateCheckpoint({ directory: f.destination }), { code: 'checkpoint_unsafe_permissions' });
});

for (const limits of [{ maxEntries: 1 }, { maxBytes: 1 }, { maxFileBytes: 1 }, { maxManifestBytes: 1 }, { maxDepth: 1 }]) test(`checkpoint fails explicitly at a configured resource bound ${Object.keys(limits)[0]}`, async t => {
  const f = await fixture(t); await f.write('.rna/session/nested/file', 'bounded fixture');
  await assert.rejects(createStateCheckpoint({ ...f, limits }), { code: 'checkpoint_limit' });
  assert.equal((await readdir(f.root)).includes('snapshot'), false);
});

test('aborting a checkpoint preserves the source and does not publish a completed checkpoint', async t => {
  const f = await fixture(t), control = new AbortController(); control.abort(new Error('fixture abort'));
  await assert.rejects(createStateCheckpoint({ ...f, signal: control.signal }), /fixture abort/);
  assert.deepEqual(readStateFile(f.stateFile).state, initial);
  assert.equal((await readdir(f.root)).includes('snapshot'), false);
});

test('corrupt file bytes and corrupt manifest bytes are detected before restore', async t => {
  const f = await fixture(t); await f.write('.secrets', 'test secret value'); await createStateCheckpoint(f);
  await writeFile(join(f.destination, 'payload/state.json.secrets'), 'test secret wrong');
  await assert.rejects(verifyStateCheckpoint({ directory: f.destination }), { code: 'checkpoint_hash_mismatch' });
  await writeFile(join(f.destination, 'manifest.json'), '{}');
  await assert.rejects(restoreStateCheckpoint({ directory: f.destination, destination: join(f.root, 'restored') }), { code: 'checkpoint_hash_mismatch' });
});

for (const [name, mutation] of [
  ['traversal', m => { m.entries[0].path = '../outside'; }],
  ['duplicate', m => { m.entries.push(m.entries[0]); }],
  ['missing root', m => { m.roots.pop(); }],
  ['unbounded bytes', m => { m.entries[0].bytes = Number.MAX_SAFE_INTEGER; }],
  ['foreign version', m => { m.version = 999; }],
  ['symlink ancestor', m => { m.entries.push({ path: 'state.json.rna', type: 'symlink', target: 'state.json.rna' }, { path: 'state.json.rna/child', type: 'directory', mode: 0o700 }); }]
]) test(`malformed manifest with a recomputed digest still rejects ${name}`, async t => {
  const f = await fixture(t); await createStateCheckpoint(f); await rewriteManifest(f.destination, mutation);
  await assert.rejects(verifyStateCheckpoint({ directory: f.destination }));
});

test('unlisted payload and missing optional sidecar payload are detected', async t => {
  const f = await fixture(t); await f.write('.secrets', 'secret'); await createStateCheckpoint(f);
  await writeFile(join(f.destination, 'payload/unlisted'), 'surprise');
  await assert.rejects(verifyStateCheckpoint({ directory: f.destination }));
  await rm(join(f.destination, 'payload/unlisted')); await rm(join(f.destination, 'payload/state.json.secrets'));
  await assert.rejects(verifyStateCheckpoint({ directory: f.destination }), { code: 'checkpoint_hash_mismatch' });
});

test('a digest-valid checkpoint still requires supported state JSON and matching format metadata', async t => {
  const f = await fixture(t); await createStateCheckpoint(f);
  await rewriteManifest(f.destination, m => { m.state.revision = 999; });
  await assert.rejects(verifyStateCheckpoint({ directory: f.destination }), { code: 'checkpoint_invalid_state' });
  const content = Buffer.from('{broken'), file = join(f.destination, 'payload/state.json'); await writeFile(file, content);
  await rewriteManifest(f.destination, m => { m.state.revision = 3; const entry = m.entries.find(row => row.path === 'state.json'); m.totalBytes += content.length - entry.bytes; entry.bytes = content.length; entry.sha256 = hash(content); });
  await assert.rejects(verifyStateCheckpoint({ directory: f.destination }), { code: 'checkpoint_invalid_state' });
});

test('original-path recovery preserves newer state in a verified checkpoint and quarantine, pauses restored state, leaves external data alone', async t => {
  const f = await fixture(t); await f.write('.secrets', 'old-key'); await f.write('.rna/session/log.jsonl', 'old log');
  await f.write('.service/config.json', '{"command":"/old-runtime"}');
  await createStateCheckpoint(f);
  await writeFile(f.stateFile, JSON.stringify({ ...initial, fixture: 'new activity', revision: 9 }));
  await f.write('.secrets', 'new-key'); await f.write('.rna/session/log.jsonl', 'new log'); await f.write('.observations/project.json', 'new only');
  await f.write('.service/config.json', '{"command":"/new-runtime"}');
  const project = join(f.data, 'project-file'); await writeFile(project, 'external side effect remains');
  const result = await restoreStateCheckpointOriginal({ stateFile: f.stateFile, directory: f.destination });
  assert.equal(result.phase, 'completed'); assert.equal(await recoveryPending(f.stateFile), null);
  assert.deepEqual(readStateFile(f.stateFile).state, { ...initial, emergency: true, revision: 4 });
  assert.equal(await readFile(`${f.stateFile}.secrets`, 'utf8'), 'old-key');
  assert.equal(await readFile(project, 'utf8'), 'external side effect remains');
  assert.equal(await readFile(`${f.stateFile}.service/config.json`, 'utf8'), '{"command":"/new-runtime"}');
  await assert.rejects(stat(`${f.stateFile}.observations`), { code: 'ENOENT' });
  const before = await verifyStateCheckpoint({ directory: result.beforeCheckpoint });
  assert.equal(before.manifest.id, result.beforeCheckpointId);
  assert.equal(readStateFile(join(result.transactionDirectory, 'quarantine/state.json')).state.fixture, 'new activity');
  assert.equal(await readFile(join(result.transactionDirectory, 'quarantine/state.json.observations/project.json'), 'utf8'), 'new only');
  assert.equal((await restoreStateCheckpointOriginal({ stateFile: f.stateFile, directory: f.destination })).alreadyCompleted, true);
});

test('original recovery rejects another state binding, keeping both locations untouched', async t => {
  const f = await fixture(t); await createStateCheckpoint(f);
  const other = join(f.data, 'other.json'); await writeFile(other, JSON.stringify(initial));
  await assert.rejects(restoreStateCheckpointOriginal({ stateFile: other, directory: f.destination }), { code: 'recovery_binding_mismatch' });
  assert.deepEqual(readStateFile(f.stateFile).state, initial);
});

for (const condition of ['corrupt', 'missing', 'future-format']) test(`disaster recovery preserves a ${condition} current state before restoring supported bytes`, async t => {
  const f = await fixture(t); await f.write('.secrets', 'recoverable key'); await createStateCheckpoint(f);
  if (condition === 'missing') await rm(f.stateFile);
  else await writeFile(f.stateFile, condition === 'corrupt' ? '{broken-but-retained' : JSON.stringify({ ...initial, version: 999 }));
  await f.write('.observations/orphan.json', 'orphan receipt must be preserved');
  const result = await restoreStateCheckpointOriginal({ stateFile: f.stateFile, directory: f.destination });
  assert.deepEqual(readStateFile(f.stateFile).state, { ...initial, emergency: true, revision: 4 });
  const before = await verifyStateCheckpoint({ directory: result.beforeCheckpoint });
  assert.equal(before.manifest.state.status, condition === 'missing' ? 'missing' : 'unsupported');
  await assert.rejects(restoreStateCheckpoint({ directory: result.beforeCheckpoint, destination: join(f.root, 'unsafe-restoration') }), { code: 'checkpoint_not_restorable' });
  assert.equal(await readFile(join(result.transactionDirectory, 'quarantine/state.json.observations/orphan.json'), 'utf8'), 'orphan receipt must be preserved');
  if (condition === 'corrupt') assert.equal(await readFile(join(result.transactionDirectory, 'quarantine/state.json'), 'utf8'), '{broken-but-retained');
});

test('completed recovery is not reused when later state activity exists; a new recovery preserves it first', async t => {
  const f = await fixture(t); await createStateCheckpoint(f);
  const first = await restoreStateCheckpointOriginal({ stateFile: f.stateFile, directory: f.destination });
  await writeFile(f.stateFile, JSON.stringify({ ...initial, fixture: 'later work' }));
  const second = await restoreStateCheckpointOriginal({ stateFile: f.stateFile, directory: f.destination });
  assert.notEqual(first.id, second.id); assert.equal(second.alreadyCompleted, undefined);
  assert.equal(JSON.parse(await readFile(join(second.transactionDirectory, 'quarantine/state.json'), 'utf8')).fixture, 'later work');
});

for (const phase of ['before-replace', 'after-quarantine', 'after-applied-before-journal']) test(`crash recovery resumes an interrupted transaction at ${phase} without replaying tools`, async t => {
  const f = await fixture(t); await f.write('.secrets', 'old'); await createStateCheckpoint(f);
  await writeFile(f.stateFile, JSON.stringify({ ...initial, fixture: 'current state' })); await f.write('.secrets', 'new');
  const completed = await restoreStateCheckpointOriginal({ stateFile: f.stateFile, directory: f.destination });
  // Reconstruct exact filesystem/journal combinations a kill between rename
  // and fsync-before-publish can leave. No application/provider is executed.
  const marker = structuredClone(completed), row = marker.operations[0]; marker.phase = 'replacing'; delete marker.completedAt; row.status = 'pending';
  const stage = join(marker.transactionDirectory, 'staging/state.json'), quarantine = join(marker.transactionDirectory, 'quarantine/state.json');
  if (phase !== 'after-applied-before-journal') await rename(f.stateFile, stage);
  if (phase === 'before-replace') await rename(quarantine, f.stateFile);
  if (phase === 'after-quarantine') row.status = 'quarantined';
  await writeFile(`${f.stateFile}.recovery.json`, JSON.stringify(marker));
  assert.equal((await recoveryPending(f.stateFile)).phase, 'replacing');
  const resumed = await restoreStateCheckpointOriginal({ stateFile: f.stateFile, directory: f.destination });
  assert.equal(resumed.id, completed.id); assert.equal(resumed.phase, 'completed'); assert.equal(await recoveryPending(f.stateFile), null);
  assert.deepEqual(readStateFile(f.stateFile).state, { ...initial, emergency: true, revision: 4 });
  assert.equal(JSON.parse(await readFile(quarantine, 'utf8')).fixture, 'current state');
});

test('unexpected post-crash content blocks recovery and retains its durable pending marker', async t => {
  const f = await fixture(t); await createStateCheckpoint(f);
  const completed = await restoreStateCheckpointOriginal({ stateFile: f.stateFile, directory: f.destination });
  completed.phase = 'replacing'; await writeFile(`${f.stateFile}.recovery.json`, JSON.stringify(completed));
  await writeFile(f.stateFile, JSON.stringify({ ...initial, fixture: 'unrecorded newer work' }));
  await assert.rejects(restoreStateCheckpointOriginal({ stateFile: f.stateFile, directory: f.destination }), { code: 'recovery_conflict' });
  assert.equal((await recoveryPending(f.stateFile)).phase, 'replacing');
  assert.equal(readStateFile(f.stateFile).state.fixture, 'unrecorded newer work');
});

test('corrupt recovery markers fail closed rather than appearing safe to start', async t => {
  const f = await fixture(t); assert.equal(await recoveryPending(f.stateFile), null);
  await writeFile(`${f.stateFile}.recovery.json`, '{invalid');
  await assert.rejects(recoveryPending(f.stateFile), { code: 'recovery_marker_invalid' });
});

test('all startup surfaces can reject staged bytes while unrelated sibling and descendant states remain independent', async t => {
  const f = await fixture(t); await assertStateRecoveryReady(f.stateFile); await createStateCheckpoint(f);
  const stage = await restoreStateCheckpoint({ directory: f.destination, destination: join(f.root, 'stage') });
  await assert.rejects(assertStateRecoveryReady(stage.stateFile), { code: 'checkpoint_staging_only' });
  const other = join(stage.directory, 'unrelated.json'); await writeFile(other, JSON.stringify(initial)); await assertStateRecoveryReady(other);
  await mkdir(join(stage.directory, 'nested')); const nested = join(stage.directory, 'nested/state.json'); await writeFile(nested, JSON.stringify(initial)); await assertStateRecoveryReady(nested);
  await writeFile(join(stage.directory, 'restoration.json'), '{damaged');
  await assert.rejects(assertStateRecoveryReady(stage.stateFile), { code: 'recovery_marker_invalid' });
});

test('startup blocks incomplete original recovery; a completed recovery remains emergency paused on real Store reload', async t => {
  const f = await fixture(t); await rm(f.stateFile); const store = new Store(f.stateFile);
  store.mutate(state => { state.events.push({ id: 'fixture-evidence', type: 'fixture', text: 'saved evidence', at: new Date().toISOString() }); });
  await createStateCheckpoint(f);
  store.mutate(state => { state.events.push({ id: 'later-evidence', type: 'fixture', text: 'preserve later evidence in quarantine', at: new Date().toISOString() }); });
  const result = await restoreStateCheckpointOriginal({ stateFile: f.stateFile, directory: f.destination });
  result.phase = 'replacing'; await writeFile(`${f.stateFile}.recovery.json`, JSON.stringify(result));
  await assert.rejects(assertStateRecoveryReady(f.stateFile), { code: 'recovery_pending' });
  await restoreStateCheckpointOriginal({ stateFile: f.stateFile, directory: f.destination });
  await assertStateRecoveryReady(f.stateFile);
  const reloaded = new Store(f.stateFile);
  assert.equal(reloaded.state.emergency, true);
  assert.equal(reloaded.state.events.some(row => row.id === 'fixture-evidence'), true);
  assert.equal(reloaded.state.events.some(row => row.id === 'later-evidence'), false);
  assert.equal(readStateFile(join(result.transactionDirectory, 'quarantine/state.json')).state.events.some(row => row.id === 'later-evidence'), true);
});

test('same-binding recovery preserves actual genome absolute paths and SDK hash-chain receipts; later receipts stay in the retained preimage', async t => {
  const f = await fixture(t), genomes = new ProjectGenomeStore({ file: f.stateFile }), project = { id: 'recovery-project' };
  const prepared = await genomes.prepare(project, { genome: projectGenomeFixture(), versionId: 'recovery-version' }); await prepared.commit();
  const options = { stateDir: `${f.stateFile}.rna/recovery-session`, sessionId: 'recovery-session', projectId: project.id };
  const original = openJournal(options);
  original.append('tool_intent', { callKey: 'already-executed', toolName: 'project_write', arguments: { path: 'main.js' }, effect: 'write', idempotent: false });
  original.append('tool_completed', { callKey: 'already-executed', result: { content: [{ type: 'text', text: 'write completed' }] } });
  original.close(); const before = await readFile(original.file);
  await createStateCheckpoint(f);
  await writeFile(join(prepared.record.dir, 'SYSTEM.md'), 'corrupt changed prompt');
  const later = openJournal(options); later.append('tool_intent', { callKey: 'later-side-effect', toolName: 'project_exec', effect: 'write', idempotent: false }); later.close();
  const result = await restoreStateCheckpointOriginal({ stateFile: f.stateFile, directory: f.destination });
  assert.equal((await genomes.read(project.id, 'recovery-version')).hash, prepared.record.hash);
  assert.equal((await genomes.read(project.id, 'recovery-version')).dir, prepared.record.dir, 'immutable absolute binding remains valid');
  assert.deepEqual(await readFile(original.file), before, 'the journal is restored byte-for-byte, without replay or invented receipts');
  const restored = openJournal(options); try { assert.equal(restored.records.some(row => row.type === 'tool_completed' && row.data.callKey === 'already-executed'), true); assert.equal(restored.records.some(row => row.data?.callKey === 'later-side-effect'), false); } finally { restored.close(); }
  const heldFile = join(result.transactionDirectory, 'quarantine/state.json.rna/recovery-session', basename(original.file));
  assert.match(await readFile(heldFile, 'utf8'), /later-side-effect/);
});

test('an actual SIGKILL after the durable restore marker releases ownership and resumes without discarding the newer preimage', { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.write('.rna/session/blob', Buffer.alloc(16 * 1024 ** 2, 0x31)); await createStateCheckpoint(f);
  await f.write('.rna/session/blob', Buffer.alloc(16 * 1024 ** 2, 0x32)); await writeFile(f.stateFile, JSON.stringify({ ...initial, fixture: 'before actual crash' }));
  let child, killed = false, inspecting = false;
  // macOS directory watch batching can arrive after a small recovery finishes;
  // poll this single marker to target the crash boundary, not host wall-clock.
  const monitor = setInterval(async () => {
    if (killed || inspecting || !child) return;
    inspecting = true;
    try {
      const marker = JSON.parse(await readFile(`${f.stateFile}.recovery.json`, 'utf8'));
      if (marker.phase !== 'completed') { killed = true; child.kill('SIGKILL'); }
    } catch { /* The marker has not been published yet. */ }
    finally { inspecting = false; }
  }, 2);
  t.after(() => clearInterval(monitor));
  const source = `import {restoreStateCheckpointOriginal} from ${JSON.stringify(new URL('../state-checkpoint.mjs', import.meta.url).href)};await restoreStateCheckpointOriginal(${JSON.stringify({ stateFile: f.stateFile, directory: f.destination })});`;
  child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4096); });
  const exited = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const exit = await exited; clearInterval(monitor);
  assert.equal(killed, true, `fixture exit ${JSON.stringify(exit)}: ${stderr}`); assert.equal(exit.signal, 'SIGKILL');
  assert.ok(await recoveryPending(f.stateFile)); await assert.rejects(assertStateRecoveryReady(f.stateFile), { code: 'recovery_pending' });
  const recovered = await restoreStateCheckpointOriginal({ stateFile: f.stateFile, directory: f.destination });
  assert.equal(recovered.phase, 'completed'); assert.equal(await recoveryPending(f.stateFile), null);
  assert.deepEqual(readStateFile(f.stateFile).state, { ...initial, emergency: true, revision: 4 });
  const preserved = readStateFile(join(recovered.beforeCheckpoint, 'payload/state.json')).state; assert.equal(preserved.fixture, 'before actual crash');
  assert.equal(hash(await readFile(`${f.stateFile}.rna/session/blob`)), hash(Buffer.alloc(16 * 1024 ** 2, 0x31)));
  assert.equal(hash(await readFile(join(recovered.beforeCheckpoint, 'payload/state.json.rna/session/blob'))), hash(Buffer.alloc(16 * 1024 ** 2, 0x32)));
});

test('usage-cache ledgers (and a crash-left rewrite temp) never block a checkpoint and are not captured', async t => {
  const f = await fixture(t);
  await f.write('.usage-cache.jsonl', '{"purpose":"foreground"}\n');
  await f.write('.usage-cache.jsonl.4242.tmp', 'partial');
  await f.write('.skill-foundation/project/operation/receipt.json', '{}');
  const result = await createStateCheckpoint({ ...f, hostVersion: '0.22.0', sdkVersion: '0.15.0' });
  assert.equal(result.manifest.entries.some(row => row.path.includes('usage-cache')), false);
  assert.ok(result.manifest.entries.some(row => row.path.startsWith('state.json.skill-foundation/')));
  await assert.rejects(f.write('.unknown-sidecar', 'x').then(() => createStateCheckpoint({ ...f, destination: join(f.root, 'second'), hostVersion: '0.22.0', sdkVersion: '0.15.0' })), error => error.code === 'checkpoint_unknown_sidecar');
});

test('a crash-left atomic-write temp next to the state never blocks a checkpoint', async t => {
  const f = await fixture(t);
  await f.write('.tmp-4242-1b4e28ba-2fa1-11d2-883f-0016d3cca427', 'partial state write');
  const result = await createStateCheckpoint({ ...f, hostVersion: '0.23.0', sdkVersion: '0.16.0' });
  assert.equal(result.manifest.entries.some(row => row.path.includes('.tmp-')), false);
});
