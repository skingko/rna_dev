import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { encodeState, reachableShardFiles, readStateFile, readStateText, shardDirectory, STATE_SHARD_FORMAT, writeStateFile } from '../state-shards.mjs';
import { createStateCheckpoint, restoreStateCheckpoint, restoreStateCheckpointOriginal, verifyStateCheckpoint } from '../state-checkpoint.mjs';

const directory = t => { const root = mkdtempSync(join(tmpdir(), 'rna-shards-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };
const entries = file => { try { return readdirSync(shardDirectory(file)).sort(); } catch { return []; } };
// Node files only; the commit log (formatVersion 2) is listed by logs().
const nodes = file => entries(file).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
const logs = file => entries(file).filter(name => name.startsWith('log-'));
const shardText = file => entries(file).map(name => readFileSync(join(shardDirectory(file), name), 'utf8')).join('\n');
const sha = text => createHash('sha256').update(text).digest('hex');
// Deterministic ids: shard spans are content-defined, so random ids made span
// boundaries (and which node files an append supersedes) vary between runs.
let itemSequence = 0;
const item = (i, size = 900) => ({ id: `item-${String(++itemSequence).padStart(8, '0')}`, kind: 'assistant', text: `item-${i} ${'x'.repeat(size)}`, createdAt: new Date(0).toISOString() });
function bigStore(file, count = 600) {
  const store = new Store(file), session = store.createSession({ title: 'large' });
  store.mutate(state => { const target = state.sessions.find(row => row.id === session.id); for (let i = 0; i < count; i++) target.items.push(item(i)); });
  return { store, session };
}

test('sharded encoding round-trips JSON semantics exactly, including hostile shapes', t => {
  const file = join(directory(t), 'state.json');
  const value = { version: 2, revision: 1, tasks: [], events: [], sessions: [],
    odd: { v: 'x', p: [1], c: ['a'], '$rnaRef': 'y', '': 0, 'ключ': '值', nested: [[['deep', { v: { p: 1 } }]]] },
    sparse: [1, undefined, () => 1, null], skip: undefined, date: new Date(0),
    big: Array.from({ length: 300 }, (_, i) => ({ id: `row-${i}`, v: i, p: [i], blob: 'y'.repeat(200), inner: Array.from({ length: 30 }, (_, j) => ({ id: `${i}-${j}`, text: 'z'.repeat(40) })) })),
    bigObject: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, { list: Array.from({ length: 20 }, (_, j) => `${i}:${j}:${'q'.repeat(30)}`) }])),
    hashLike: 'a'.repeat(64), arrayOfHashes: ['b'.repeat(64)] };
  writeStateFile(file, value);
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(manifest.format, STATE_SHARD_FORMAT); assert.equal(manifest.version, 2); assert.ok(manifest.nodes > 3); assert.equal(sha(manifest.rootNode), manifest.root);
  assert.deepEqual(readStateFile(file).state, JSON.parse(JSON.stringify(value)));
  assert.equal(readStateText(file), JSON.stringify(value));
  for (const name of nodes(file)) assert.equal(sha(readFileSync(join(shardDirectory(file), name), 'utf8')), name.slice(0, 64));
});

test('a typical single-session mutate appends only touched shards to the commit log with one fsync', t => {
  const file = join(directory(t), 'state.json'), { store, session } = bigStore(file, 1500);
  assert.ok(store.persistence.bytes > 1_300_000, 'fixture state is large');
  const manifest = readFileSync(file, 'utf8'), before = new Set(nodes(file)), [log] = logs(file), logBytes = readFileSync(join(shardDirectory(file), log)).length;
  store.mutate(state => { state.sessions.find(row => row.id === session.id).items.push(item('new')); });
  assert.ok(store.persistence.writtenBytes < 200_000, `wrote ${store.persistence.writtenBytes} bytes`);
  assert.equal(store.persistence.shardFiles, 1); assert.equal(store.persistence.fsyncs, 1);
  assert.equal(readFileSync(file, 'utf8'), manifest, 'the manifest is untouched between checkpoints');
  assert.equal(readFileSync(join(shardDirectory(file), log)).length, logBytes + store.persistence.writtenBytes);
  const after = new Set(nodes(file));
  assert.ok([...after].every(name => before.has(name)), 'no node file is written by an append');
  assert.ok([...before].some(name => !after.has(name)), 'node files superseded by the appended generation are collected');
  const unrelated = store.createSession({ title: 'other' });
  store.mutate(state => { state.sessions.find(row => row.id === unrelated.id).title = 'renamed'; });
  assert.ok(store.persistence.writtenBytes < 40_000, `unrelated session write ${store.persistence.writtenBytes}`);
  // An unchanged state appends only its root.
  store.persist(store.state); assert.equal(store.persistence.shardFiles, 1);
  assert.equal(readStateText(file), JSON.stringify(store.state));
  const reopened = new Store(file);
  assert.equal(reopened.state.sessions.find(row => row.id === session.id).items.length, 1501);
  // Reopening checkpoints: live log nodes become files, the old log is gone.
  assert.equal(logs(file).length, 1); assert.notEqual(logs(file)[0], log);
  assert.equal(readFileSync(join(shardDirectory(file), logs(file)[0]), 'utf8'), '');
  assert.deepEqual(nodes(file), reachableShardFiles(file).filter(name => name.endsWith('.json')));
});

test('a failure between shard writes and manifest commit latches and exposes only the previous generation', t => {
  const file = join(directory(t), 'state.json'), { store, session } = bigStore(file, 400);
  const committed = readStateText(file), manifest = readFileSync(file, 'utf8');
  let written = [];
  store.shards.hooks.beforeManifest = plan => { written = plan.fresh.map(([hash]) => `${hash}.json`); throw Object.assign(new Error('simulated crash'), { code: 'EIO' }); };
  store.shards.checkpointNext = true;
  assert.throws(() => store.mutate(state => { const target = state.sessions.find(row => row.id === session.id); target.title = 'never committed'; target.items[5].text = 'never committed item'; }), /simulated crash/);
  assert.equal(store.persistence.failed, true); assert.equal(store.persistence.errorCode, 'EIO');
  assert.notEqual(store.state.sessions.find(row => row.id === session.id).title, 'never committed');
  assert.throws(() => store.mutate(() => {}), /持久化先前失败/);
  assert.equal(readFileSync(file, 'utf8'), manifest);
  assert.ok(written.length > 0 && written.every(name => nodes(file).includes(name)), 'new nodes were durable before the failed commit');
  const reopened = new Store(file);
  assert.equal(JSON.stringify(readStateFile(file).state.sessions), JSON.stringify(JSON.parse(committed).sessions));
  assert.ok(written.every(name => !nodes(file).includes(name)), 'startup sweep removes nodes of the uncommitted generation');
  assert.ok(!shardText(file).includes('never committed')); assert.ok(!readFileSync(file, 'utf8').includes('never committed'));
  assert.equal(reopened.state.sessions.find(row => row.id === session.id).title, 'large');
});

test('a committed manifest with a failed directory sync publishes the new state and latches', t => {
  const file = join(directory(t), 'state.json'), store = new Store(file), session = store.createSession({ title: 'before' });
  const original = store.shards.commit.bind(store.shards);
  store.shards.commit = (plan, state) => { original(plan, state); throw Object.assign(new Error('fsync failed'), { code: 'EIO', committed: true }); };
  assert.throws(() => store.mutate(state => { state.sessions.find(row => row.id === session.id).title = 'after'; }), /fsync failed/);
  assert.equal(store.state.sessions.find(row => row.id === session.id).title, 'after');
  assert.equal(new Store(file).state.sessions.find(row => row.id === session.id).title, 'after');
});

test('legacy monolithic state migrates idempotently, verifies, then drops the backup', t => {
  const root = directory(t), file = join(root, 'state.json');
  const { store, session } = bigStore(file, 50); const legacy = JSON.parse(readStateText(file));
  rmSync(shardDirectory(file), { recursive: true, force: true }); writeFileSync(file, JSON.stringify(legacy, null, 2));
  // A previous migration crashed after copying its backup and before commit.
  writeFileSync(`${file}.legacy-1-deadbeef`, JSON.stringify(legacy, null, 2));
  mkdirSync(shardDirectory(file)); writeFileSync(join(shardDirectory(file), `${'e'.repeat(64)}.json`), 'orphan');
  const migrated = new Store(file);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).format, STATE_SHARD_FORMAT);
  assert.deepEqual(readdirSync(root).filter(name => name.includes('.legacy-')), []);
  assert.ok(!existsSync(join(shardDirectory(file), `${'e'.repeat(64)}.json`)));
  assert.equal(migrated.state.sessions.find(row => row.id === session.id).items.length, 50);
  assert.equal(migrated.state.revision, legacy.revision);
  const again = new Store(file);
  assert.equal(JSON.stringify(again.state), JSON.stringify(migrated.state)); void store;
});

test('a missing manifest beside populated shards fails closed instead of starting fresh', t => {
  const file = join(directory(t), 'state.json'); bigStore(file, 400);
  rmSync(file);
  assert.throws(() => new Store(file), /状态文件无法读取/);
  assert.ok(nodes(file).length > 0);
});

test('a corrupted node is detected on load', t => {
  const file = join(directory(t), 'state.json'); bigStore(file, 400);
  const name = nodes(file)[0]; writeFileSync(join(shardDirectory(file), name), '{"v":{},"p":[]}');
  assert.throws(() => new Store(file), /校验失败/);
});

test('deleted sessions and projects leave no shard content behind after commit', t => {
  const file = join(directory(t), 'state.json'), store = new Store(file);
  const { project, session } = store.createProject({ name: 'Doomed' });
  store.mutate(state => { const target = state.sessions.find(row => row.id === session.id); for (let i = 0; i < 300; i++) target.items.push({ ...item(i), text: `doomed-secret-${i} ${'x'.repeat(900)}` }); });
  const other = store.createSession({ title: 'survivor' });
  store.mutate(state => { const target = state.sessions.find(row => row.id === other.id); for (let i = 0; i < 40; i++) target.items.push(item(i)); });
  assert.ok(shardText(file).includes('doomed-secret-3'));
  store.deleteProject(project.id);
  assert.ok(!shardText(file).includes('doomed-secret-'));
  assert.ok(readStateText(file).includes('survivor'));
});

test('checkpoint and restore carry the manifest with every referenced shard', async t => {
  const root = directory(t), data = join(root, 'data'); await mkdir(data, { mode: 0o700 });
  const file = join(data, 'state.json'), { store, session } = bigStore(file, 400);
  const expected = readStateText(file);
  const checkpoint = await createStateCheckpoint({ stateFile: file, destination: join(root, 'checkpoint') });
  assert.ok(checkpoint.manifest.entries.some(entry => entry.path.startsWith('state.json.d/')));
  assert.equal(checkpoint.manifest.state.revision, JSON.parse(expected).revision);
  await verifyStateCheckpoint({ directory: checkpoint.directory });
  const staged = await restoreStateCheckpoint({ directory: checkpoint.directory, destination: join(root, 'staged') });
  assert.equal(readStateText(staged.stateFile), expected);
  store.mutate(state => { state.sessions.find(row => row.id === session.id).title = 'after checkpoint'; });
  await restoreStateCheckpointOriginal({ directory: checkpoint.directory, stateFile: file });
  const restored = readStateFile(file);
  assert.equal(restored.legacy, false); assert.equal(restored.state.emergency, true);
  assert.equal(restored.state.sessions.find(row => row.id === session.id).title, 'large');
  assert.equal(restored.state.sessions.find(row => row.id === session.id).items.length, 400);
  const unreferenced = entries(file).filter(name => !reachableShardFiles(file).includes(name));
  assert.deepEqual(unreferenced, []);
});

test('checkpoints made before sharding (without the .d root) stay verifiable and restore by migration', async t => {
  const root = directory(t), data = join(root, 'data'); await mkdir(data, { mode: 0o700 });
  const file = join(data, 'state.json'), legacy = { version: 2, revision: 7, tasks: [], events: [], sessions: [], projects: [], settings: { realTokenBudget: null }, emergency: false, marker: 'legacy' };
  await writeFile(file, JSON.stringify(legacy), { mode: 0o600 });
  const checkpoint = await createStateCheckpoint({ stateFile: file, destination: join(root, 'checkpoint') });
  const manifestPath = join(checkpoint.directory, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // A 0.21 checkpoint has none of the sidecars appended since: .d (sharding), .skill-foundation and the revert snapshot stores.
  assert.deepEqual(manifest.roots.slice(-5, -1).map(row => [row.path, row.present]), [['state.json.d', false], ['state.json.skill-foundation', false], ['state.json.direct-fixes', false], ['state.json.background-changes', false]]);
  manifest.roots.splice(-5, 4);
  const bytes = `${JSON.stringify(manifest)}\n`; await writeFile(manifestPath, bytes); await writeFile(join(checkpoint.directory, 'manifest.sha256'), `${sha(bytes)}\n`);
  await verifyStateCheckpoint({ directory: checkpoint.directory });
  new Store(file); assert.equal(JSON.parse(readFileSync(file, 'utf8')).format, STATE_SHARD_FORMAT);
  await restoreStateCheckpointOriginal({ directory: checkpoint.directory, stateFile: file });
  const restored = new Store(file);
  assert.equal(restored.state.marker, 'legacy'); assert.equal(restored.state.emergency, true);
});

test('encoding hysteresis keeps array chunk boundaries stable while appending', () => {
  const state = { list: Array.from({ length: 2000 }, (_, i) => ({ id: `id-${i}`, text: 'w'.repeat(500 + (i % 7) * 50) })) };
  const first = encodeState(state);
  state.list.push({ id: 'id-new', text: 'tail' });
  const second = encodeState(state, { known: first.contents, spans: first.spans });
  assert.ok(second.fresh.length <= 4, `fresh ${second.fresh.length}`);
  state.list.shift();
  const third = encodeState(state, { known: second.contents, spans: second.spans });
  assert.ok(third.fresh.length <= 4, `front trim fresh ${third.fresh.length}`);
});

test('small states stay inline in the manifest and switch layouts in both directions', t => {
  const file = join(directory(t), 'state.json'), store = new Store(file), session = store.createSession({ title: 'grow' });
  assert.deepEqual(nodes(file), []); assert.equal(store.persistence.shardFiles, 1);
  store.mutate(state => { const target = state.sessions.find(row => row.id === session.id); for (let i = 0; i < 400; i++) target.items.push(item(i)); });
  assert.ok(nodes(file).length > 3, 'large state is split into nodes');
  store.mutate(state => { state.sessions.find(row => row.id === session.id).items = []; });
  assert.deepEqual(entries(file), [], 'shrinking back inline collects every node and the commit log');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).formatVersion, 1);
  assert.equal(new Store(file).state.sessions.find(row => row.id === session.id).title, 'grow');
});
