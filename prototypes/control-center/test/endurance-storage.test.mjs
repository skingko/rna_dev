import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { atomicWrite } from '../durable-files.mjs';
import { acquireProcessLease } from '../process-lease.mjs';
import { readStateFile } from '../state-shards.mjs';

const leaseModule = new URL('../process-lease.mjs', import.meta.url).href;
async function temporary(t) { const directory = await mkdtemp(join(tmpdir(), 'rna-endurance-storage-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }
function leaseProcess(t, path) {
  const source = `import {acquireProcessLease} from ${JSON.stringify(leaseModule)};
    let release, timer;
    try { release = await acquireProcessLease(process.env.TEST_LEASE_PATH, { fixture: 'endurance-test' });
      timer = setInterval(() => {}, 1000); process.send({ type:'acquired', pid:process.pid });
      process.on('message', value => { if(value === 'release') { release(); clearInterval(timer); process.exit(0); } });
      process.on('SIGTERM', () => { release(); clearInterval(timer); process.exit(0); });
    } catch(error) { process.send({type:'rejected', message:error.message}); process.exit(0); }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, TEST_LEASE_PATH: path }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })); });
  const result = new Promise((done, reject) => {
    let responded = false;
    const deadline = setTimeout(() => reject(new Error(`Lease process did not respond: ${stderr}`)), 10000);
    child.once('message', message => { responded = true; clearTimeout(deadline); done(message); }); child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(deadline); if (!responded) reject(new Error(`Lease process exited before reporting (${code ?? signal}): ${stderr}`)); });
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; });
  return { child, result, exit, release: async () => { child.send('release'); await exit; } };
}

test('cross-process SQLite lease admits exactly one concurrent owner and a loser cannot delete that owner identity', async t => {
  const directory = await temporary(t), path = join(directory, 'daemon.lock');
  const first = leaseProcess(t, path), second = leaseProcess(t, path), results = await Promise.all([first.result, second.result]);
  assert.equal(results.filter(result => result.type === 'acquired').length, 1, JSON.stringify(results)); assert.equal(results.filter(result => result.type === 'rejected').length, 1);
  const winner = results[0].type === 'acquired' ? first : second, loser = winner === first ? second : first;
  await loser.exit; const owner = JSON.parse(await readFile(path, 'utf8')); assert.equal(owner.pid, winner.child.pid); assert.equal(owner.fixture, 'endurance-test'); assert.ok(owner.birth); assert.ok(owner.token);
  await assert.rejects(acquireProcessLease(path), /持有排他锁|已有进程/); assert.equal(JSON.parse(await readFile(path, 'utf8')).token, owner.token);
  await winner.release(); await assert.rejects(readFile(path), { code: 'ENOENT' });
  const third = leaseProcess(t, path); assert.equal((await third.result).type, 'acquired'); await third.release();
});
test('SIGKILL releases the OS lease while retaining stale identity for the next exclusive owner to reclaim', async t => {
  const directory = await temporary(t), path = join(directory, 'daemon.lock'), first = leaseProcess(t, path);
  assert.equal((await first.result).type, 'acquired'); const old = JSON.parse(await readFile(path, 'utf8'));
  first.child.kill('SIGKILL'); assert.equal((await first.exit).signal, 'SIGKILL'); assert.equal(JSON.parse(await readFile(path, 'utf8')).token, old.token);
  const second = leaseProcess(t, path); assert.equal((await second.result).type, 'acquired'); const next = JSON.parse(await readFile(path, 'utf8')); assert.notEqual(next.token, old.token); assert.notEqual(next.pid, old.pid);
  assert.equal((await stat(`${path}.sqlite`)).mode & 0o777, 0o600); await second.release();
});
test('corrupt or unverifiable live legacy lease metadata is preserved instead of automatically replacing it', async t => {
  const directory = await temporary(t), path = join(directory, 'daemon.lock');
  await writeFile(path, '{incomplete'); await assert.rejects(acquireProcessLease(path), /格式损坏/); assert.equal(await readFile(path, 'utf8'), '{incomplete');
  await writeFile(path, JSON.stringify(process.pid)); await assert.rejects(acquireProcessLease(path), /已有进程/); assert.equal(await readFile(path, 'utf8'), JSON.stringify(process.pid));
});
test('history archive is immutable, content-addressed, private and idempotent across Store restart', async t => {
  const directory = await temporary(t), file = join(directory, 'state.json'), store = new Store(file);
  const rows = [{ id: 'old-decision', reason: 'An actual prior observation', nested: { state: 'completed' } }, { id: 'old-action', usage: { totalTokens: 42 } }];
  const first = store.archiveRecords('initiative/test-project/actions', rows), second = store.archiveRecords('initiative/test-project/actions', structuredClone(rows)); assert.deepEqual(second, first);
  const archive = `${file}.archive`; assert.equal((await readdir(join(archive, 'initiative/test-project/actions'))).length, 2);
  for (let index = 0; index < first.length; index++) { const path = join(archive, first[index]); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), rows[index]); assert.equal((await stat(path)).mode & 0o777, 0o600); }
  const reloaded = new Store(file); assert.deepEqual(reloaded.archiveRecords('initiative/test-project/actions', rows), first);
  assert.throws(() => store.archiveRecords('../escape', rows), /命名空间/);
  await writeFile(join(archive, first[0]), 'corrupted evidence'); assert.throws(() => store.archiveRecords('initiative/test-project/actions', rows), /损坏/); assert.equal(await readFile(join(archive, first[0]), 'utf8'), 'corrupted evidence', 'A collision is never silently overwritten');
});
test('archive I/O failure prevents pruning and preserves the exact persisted hot history for a later successful retry', async t => {
  const directory = await temporary(t), file = join(directory, 'state.json'), store = new Store(file), records = [{ id: 'keep-1' }, { id: 'keep-2' }];
  store.mutate(state => { state.enduranceFixtureHistory = structuredClone(records); }); const before = await readFile(file, 'utf8'), revision = store.state.revision;
  await writeFile(`${file}.archive`, 'blocked-directory');
  const prune = () => store.mutate(state => { store.archiveRecords('initiative/test/actions', state.enduranceFixtureHistory); state.enduranceFixtureHistory = []; });
  assert.throws(prune); assert.deepEqual(store.state.enduranceFixtureHistory, records); assert.equal(store.state.revision, revision); assert.equal(await readFile(file, 'utf8'), before);
  await rm(`${file}.archive`); prune(); assert.deepEqual(store.state.enduranceFixtureHistory, []);
  const archived = await readdir(join(`${file}.archive`, 'initiative/test/actions')); assert.equal(archived.length, 2);
  const reloaded = new Store(file); assert.deepEqual(reloaded.state.enduranceFixtureHistory, []); assert.equal((await readdir(join(`${file}.archive`, 'initiative/test/actions'))).length, 2);
});
test('a pre-rename persistence failure retains memory and disk and fails closed after the filesystem recovers', async t => {
  const directory = await temporary(t), stateDir = join(directory, 'state'), file = join(stateDir, 'state.json'), store = new Store(file), before = await readFile(file, 'utf8'), revision = store.state.revision;
  let notifications = 0; store.subscribe(() => { notifications++; });
  const preservedDir = join(directory, 'preserved-state'); await rename(stateDir, preservedDir); await writeFile(stateDir, 'filesystem unavailable');
  assert.throws(() => store.mutate(state => { state.enduranceUncommitted = true; }));
  assert.equal(store.persistence.failed, true); assert.ok(store.persistence.errorCode); assert.equal(store.state.enduranceUncommitted, undefined); assert.equal(store.state.revision, revision); assert.equal(notifications, 0); assert.equal(await readFile(join(preservedDir, 'state.json'), 'utf8'), before);
  await rm(stateDir); await rename(preservedDir, stateDir);
  assert.throws(() => store.mutate(state => { state.enduranceUncommitted = 'retry-without-restart'; }), /停止后续写入/); assert.equal(await readFile(file, 'utf8'), before);
  const reloaded = new Store(file); assert.equal(reloaded.persistence.failed, false); assert.equal(reloaded.state.enduranceUncommitted, undefined); reloaded.mutate(state => { state.enduranceRecovered = true; }); assert.equal(readStateFile(file).state.enduranceRecovered, true);
});
test('post-rename directory sync failure publishes one matching disk/memory value then forbids subsequent writes', async t => {
  const directory = await temporary(t), file = join(directory, 'state.json'), store = new Store(file), previousRevision = store.state.revision;
  const original = fs.fsyncSync; let calls = 0;
  fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory() && fs.fstatSync(fd).ino === fs.statSync(store.file.slice(0, store.file.lastIndexOf('/'))).ino && ++calls === 1) throw Object.assign(new Error('injected directory sync failure'), { code: 'EIO' }); return original(fd); }; syncBuiltinESMExports();
  try {
    assert.throws(() => store.mutate(state => { state.enduranceCommitted = 'visible-before-directory-sync'; }), error => error.code === 'EIO' && error.committed === true);
  } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  const disk = readStateFile(file).state; assert.equal(store.persistence.failed, true); assert.equal(store.state.enduranceCommitted, disk.enduranceCommitted); assert.equal(store.state.revision, previousRevision + 1); assert.equal(disk.revision, store.state.revision);
  assert.throws(() => store.mutate(state => { state.enduranceCommitted = 'must-not-write'; }), /停止后续写入/); assert.equal(readStateFile(file).state.enduranceCommitted, 'visible-before-directory-sync');
  assert.equal((await readdir(directory)).filter(name => name.includes('.tmp-')).length, 0);
});
test('atomic replacement failure cleans its partial payload without touching the original target', async t => {
  const directory = await temporary(t), target = join(directory, 'target'); await mkdir(target); await writeFile(join(target, 'history.txt'), 'preserved');
  assert.throws(() => atomicWrite(target, 'replacement'), error => error.committed === false); assert.equal(await readFile(join(target, 'history.txt'), 'utf8'), 'preserved'); assert.equal((await readdir(directory)).filter(name => name.includes('.tmp-')).length, 0);
});
test('a reused live PID with a different recorded birth is reclaimed only after the OS lock was acquired', async t => {
  const directory = await temporary(t), path = join(directory, 'daemon.lock');
  await writeFile(path, JSON.stringify({ pid: process.pid, token: 'stale-owner', birth: 'a different previous process birth', fixture: 'old-generation' }));
  const release = await acquireProcessLease(path, { fixture: 'replacement-generation' });
  try { const owner = JSON.parse(await readFile(path, 'utf8')); assert.equal(owner.pid, process.pid); assert.notEqual(owner.token, 'stale-owner'); assert.equal(owner.fixture, 'replacement-generation'); assert.ok(process.kill(process.pid, 0)); }
  finally { release(); }
});
test('failure after a prefix was archived keeps all hot records and reuses the prefix on retry', async t => {
  const directory = await temporary(t), file = join(directory, 'state.json'), store = new Store(file), rows = [{ id: 'first' }, { id: 'second' }];
  store.mutate(state => { state.enduranceHistory = structuredClone(rows); }); const before = await readFile(file, 'utf8');
  const first = store.archiveRecords('partial-history', [rows[0]])[0];
  const secondHash = createHash('sha256').update(JSON.stringify(rows[1])).digest('hex'), blocked = join(`${file}.archive`, 'partial-history', `${secondHash}.json`); await mkdir(blocked);
  const prune = () => store.mutate(state => { state.enduranceArchiveRefs = store.archiveRecords('partial-history', state.enduranceHistory); state.enduranceHistory = []; });
  assert.throws(prune); assert.deepEqual(store.state.enduranceHistory, rows); assert.equal(await readFile(file, 'utf8'), before); assert.deepEqual(JSON.parse(await readFile(join(`${file}.archive`, first), 'utf8')), rows[0]);
  await rm(blocked, { recursive: true }); prune(); assert.deepEqual(store.state.enduranceHistory, []); assert.equal(store.state.enduranceArchiveRefs[0], first); assert.equal((await readdir(join(`${file}.archive`, 'partial-history'))).length, 2);
});
