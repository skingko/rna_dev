import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { CapabilityInstallService } from '../capability-install-service.mjs';
import { CapabilityService } from '../capability-service.mjs';
import { loadSkill } from '../../../packages/sdk/src/capabilities.mjs';
import { skillFixture } from '../../../packages/sdk/test/fixtures/capability-fixtures.mjs';
import { readStateFile } from '../state-shards.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-install-durability-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = join(dir, 'workspace'); await mkdir(workspace); const store = new Store(join(dir, 'state.json'));
  const projectId = store.createProject({ name: 'Installation durability', workspace }).project.id;
  const input = { kind: 'skill', id: 'durable-skill', source: { type: 'local', path: await skillFixture(dir) }, activate: true };
  const service = new CapabilityInstallService(store); let prepares = 0, rollbacks = 0, prepared;
  const prepare = service.installer.prepare.bind(service.installer);
  service.installer.prepare = async (...args) => { prepares++; prepared = await prepare(...args); const rollback = prepared.rollback; prepared.rollback = async () => { rollbacks++; return rollback(); }; return prepared; };
  return { dir, store, projectId, input, service, get prepares() { return prepares; }, get rollbacks() { return rollbacks; }, get prepared() { return prepared; } };
}

// Inject at the actual Node fsync call while Store.persist owns this exact
// installation publication. File rename and Store's committed-state handling
// remain the real implementation; the transaction-journal fsync is unaffected.
function failStateSync(f, directory) {
  const persist = f.store.persist.bind(f.store), originalSync = fs.fsyncSync; let inPublication = false, injected = false;
  f.store.persist = next => { inPublication = next.capabilities?.installations.some(row => row.entries.some(entry => entry.id === f.input.id)); try { return persist(next); } finally { inPublication = false; } };
  fs.fsyncSync = fd => {
    if (inPublication && !injected && fs.fstatSync(fd).isDirectory() === directory && (!directory || fs.fstatSync(fd).ino === fs.statSync(f.store.file.slice(0, f.store.file.lastIndexOf('/'))).ino)) { injected = true; throw Object.assign(new Error('fixture private filesystem path must not reach uncertain receipt'), { code: 'EIO' }); }
    return originalSync(fd);
  };
  syncBuiltinESMExports();
  return { get injected() { return injected; }, restore() { fs.fsyncSync = originalSync; syncBuiltinESMExports(); f.store.persist = persist; } };
}

test('post-rename directory fsync failure retains the exact published generation and replays without reinstalling after restart', async t => {
  const f = await fixture(t), fault = failStateSync(f, true); let failure;
  try { await f.service.install(f.projectId, f.input, { requestId: 'same-installation' }); }
  catch (error) { failure = error; }
  finally { fault.restore(); }
  assert.equal(fault.injected, true); assert.ok(failure); assert.equal(failure.outcome, 'unknown'); assert.equal(failure.code, 'installation_durability_unknown'); assert.equal(failure.status, 503);
  assert.equal(failure.details.publication, 'visible'); assert.equal(failure.details.durability, 'unconfirmed'); assert.equal(failure.details.persistenceCode, 'EIO'); assert.doesNotMatch(failure.message, /private filesystem path/);
  assert.equal(f.prepares, 1); assert.equal(f.rollbacks, 0); assert.equal(f.store.persistence.failed, true);
  const record = f.store.state.capabilities.installations[0], manifest = f.store.state.capabilities.skills.find(row => row.id === f.input.id);
  assert.equal(record.installationDir, f.prepared.installationDir); assert.equal(failure.details.installationId, record.installationId);
  assert.equal((await stat(join(record.installationDir, 'skill/references/guide.md'))).isFile(), true);
  assert.equal((await loadSkill(manifest)).instructions, await readFile(join(f.input.source.path, 'SKILL.md'), 'utf8'));
  const onDisk = readStateFile(f.store.file).state; assert.deepEqual(onDisk.capabilities.installations, f.store.state.capabilities.installations);
  const transaction = JSON.parse(await readFile(join(f.service.rootDir, '.transactions', `${record.installationId}.json`), 'utf8'));
  assert.equal(transaction.status, 'needs_review'); assert.equal(transaction.failure.code, 'installation_durability_unknown'); assert.deepEqual(transaction.failure.details, failure.details);
  assert.equal((await f.service.install(f.projectId, f.input, { requestId: 'same-installation' })).replayed, true); assert.equal(f.prepares, 1);
  const reopened = new Store(f.store.file), resumed = new CapabilityInstallService(reopened);
  resumed.installer.prepare = async () => { assert.fail('a visible committed installation must not be downloaded or activated again'); };
  const replay = await resumed.install(f.projectId, f.input, { requestId: 'same-installation' });
  assert.equal(replay.status, 'installed'); assert.equal(replay.replayed, true); assert.equal(replay.installationId, record.installationId);
  const recovered = new CapabilityService(reopened).configuration().skills.find(row => row.id === f.input.id); assert.equal((await loadSkill(recovered)).instructions, (await loadSkill(manifest)).instructions);
  await assert.rejects(resumed.install(f.projectId, { ...f.input, id: 'changed' }, { requestId: 'same-installation' }), { code: 'request_conflict' });
});

test('pre-rename file fsync failure still rolls back unpublished files and allows an explicit same-request retry after reopening', async t => {
  const f = await fixture(t), fault = failStateSync(f, false); let failure;
  try { await f.service.install(f.projectId, f.input, { requestId: 'same-installation' }); }
  catch (error) { failure = error; }
  finally { fault.restore(); }
  assert.equal(fault.injected, true); assert.equal(failure.outcome, 'not-published'); assert.equal(failure.code, 'EIO'); assert.equal(f.rollbacks, 1);
  await assert.rejects(stat(f.prepared.installationDir), { code: 'ENOENT' }); assert.equal(f.store.state.capabilities?.installations?.length ?? 0, 0);
  const reopened = new Store(f.store.file), resumed = new CapabilityInstallService(reopened);
  const result = await resumed.install(f.projectId, f.input, { requestId: 'same-installation' });
  assert.equal(result.status, 'installed'); assert.equal(result.replayed, undefined); assert.equal((await stat(result.installationDir)).isDirectory(), true);
});

for (const mismatch of ['fingerprint', 'projectId', 'generation', 'manifest', 'missing-sources', 'duplicate-receipt', 'uncommitted']) test(`a claimed commit cannot preserve a generation without exact authoritative proof: ${mismatch}`, async t => {
  const f = await fixture(t);
  f.store.mutate = fn => {
    const next = structuredClone(f.store.state); fn(next); const installation = next.capabilities.installations[0];
    if (mismatch === 'fingerprint') installation.fingerprint = 'different';
    if (mismatch === 'projectId') installation.projectId = 'different';
    if (mismatch === 'generation') installation.installationDir = join(f.dir, 'other-generation');
    if (mismatch === 'manifest') next.capabilities.skills.find(row => row.id === f.input.id).path = join(f.dir, 'different-SKILL.md');
    if (mismatch === 'missing-sources') delete installation.sources;
    if (mismatch === 'duplicate-receipt') next.capabilities.installations.push(structuredClone(installation));
    f.store.state = next;
    throw Object.assign(new Error('fixture untrusted claimed commit'), { code: 'EIO', committed: mismatch !== 'uncommitted' });
  };
  await assert.rejects(f.service.install(f.projectId, f.input), error => error.code !== 'installation_durability_unknown' && error.outcome === 'not-published');
  assert.equal(f.rollbacks, 1); await assert.rejects(stat(f.prepared.installationDir), { code: 'ENOENT' });
});

test('model-facing installation leaves committed-but-unconfirmed publication as an uncertain write and emits no completed-change event', async t => {
  const f = await fixture(t); let changes = 0;
  const tool = f.service.createTools(f.projectId, { onChanged: () => changes++ }).find(row => row.name === 'capability_install');
  const fault = failStateSync(f, true);
  try { await assert.rejects(tool.execute('original-call', f.input), { outcome: 'unknown', code: 'installation_durability_unknown' }); }
  finally { fault.restore(); }
  assert.equal(changes, 0); assert.equal(f.prepares, 1); assert.equal(f.rollbacks, 0);
  const result = await tool.execute('original-call', f.input); assert.equal(JSON.parse(result.content[0].text).replayed, true); assert.equal(f.prepares, 1); assert.equal(changes, 1);
});
