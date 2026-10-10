import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs, { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { encodeState, encoderCache, LOG_LIMIT, readStateFile, readStateText, shardDirectory, ShardedStateFile } from '../state-shards.mjs';
import { draft, finalize, isCommitted, seal } from '../state-draft.mjs';

const directory = t => { const root = mkdtempSync(join(tmpdir(), 'rna-cow-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };
const item = (i, size = 900) => ({ id: randomUUID(), kind: 'assistant', text: `item-${i} ${'x'.repeat(size)}`, createdAt: new Date(0).toISOString(), tool: { name: 'read', args: { path: `f${i}` } } });
const logs = file => readdirSync(shardDirectory(file)).filter(name => name.startsWith('log-'));
function bigStore(file, sessions = 3, count = 500) {
  const store = new Store(file), ids = [];
  for (let s = 0; s < sessions; s++) {
    const { id } = store.createSession({ title: `large-${s}` }); ids.push(id);
    store.mutate(state => { const target = state.sessions.find(row => row.id === id); for (let i = 0; i < count; i++) target.items.push(item(i)); });
  }
  return { store, ids };
}
// Counts fsync calls made by any module (named ESM imports see the patch).
function countFsyncs(t) {
  const original = fs.fsyncSync; let count = 0;
  fs.fsyncSync = fd => { count++; return original(fd); }; syncBuiltinESMExports();
  t.after(() => { fs.fsyncSync = original; syncBuiltinESMExports(); });
  return { get count() { return count; }, reset() { count = 0; } };
}

test('a mutate that throws midway leaves committed state, revision and disk untouched', t => {
  const file = join(directory(t), 'state.json'), { store, ids } = bigStore(file, 2, 50);
  const before = store.state, text = readStateText(file), revision = store.state.revision;
  assert.throws(() => store.mutate(state => {
    const session = state.sessions.find(row => row.id === ids[0]);
    session.title = 'partial'; session.items.push(item('partial')); session.items[3].text = 'edited'; delete session.plan; state.settings.dailyBudget = 999;
    throw new Error('validation failed late');
  }), /validation failed late/);
  assert.equal(store.state, before, 'the committed root is the same object');
  assert.equal(store.state.revision, revision); assert.equal(readStateText(file), text);
  const session = store.state.sessions.find(row => row.id === ids[0]);
  assert.equal(session.title, 'large-0'); assert.equal(session.items.length, 50); assert.notEqual(session.items[3].text, 'edited'); assert.ok(Array.isArray(session.plan));
});

test('a failed persist is all-or-nothing and latches; a visible commit is adopted', t => {
  const file = join(directory(t), 'state.json'), { store, ids } = bigStore(file, 2, 50), before = store.state, text = readStateText(file);
  const original = store.shards.commit.bind(store.shards);
  store.shards.commit = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC', committed: false }); };
  assert.throws(() => store.mutate(state => { state.sessions.find(row => row.id === ids[1]).title = 'lost'; }), /disk full/);
  assert.equal(store.state, before); assert.equal(readStateText(file), text); assert.equal(store.persistence.failed, true);
  assert.throws(() => store.mutate(() => {}), /持久化先前失败/);
  const other = new Store(join(directory(t), 'state.json')), session = other.createSession({ title: 'before' });
  const commit = other.shards.commit.bind(other.shards);
  other.shards.commit = (plan, state, options) => { commit(plan, state, options); throw Object.assign(new Error('fsync failed'), { code: 'EIO', committed: true }); };
  assert.throws(() => other.mutate(state => { state.sessions.find(row => row.id === session.id).title = 'after'; }), /fsync failed/);
  assert.equal(other.state.sessions.find(row => row.id === session.id).title, 'after');
  assert.ok(isCommitted(other.state)); void original;
});

test('committed state is frozen, shared structurally, and returned values are detached copies', t => {
  const file = join(directory(t), 'state.json'), { store, ids } = bigStore(file, 3, 20);
  const before = store.state, untouched = before.sessions.find(row => row.id === ids[2]);
  assert.ok(Object.isFrozen(before) && Object.isFrozen(untouched.items[0]));
  assert.throws(() => { untouched.title = 'in place'; }, TypeError, 'in-place writes to committed state fail fast');
  let leaked;
  const returned = store.mutate(state => { leaked = state.sessions.find(row => row.id === ids[0]); leaked.title = 'renamed'; leaked.items.push(item('new')); return leaked; });
  // Only the touched path was copied.
  assert.equal(store.state.sessions.find(row => row.id === ids[2]), untouched);
  assert.equal(store.state.projects, before.projects);
  const touched = store.state.sessions.find(row => row.id === ids[0]), old = before.sessions.find(row => row.id === ids[0]);
  assert.notEqual(touched, old); assert.equal(touched.items[0], old.items[0], 'unchanged items keep their identity');
  // The result is a detached, mutable copy with the committed values.
  assert.equal(returned.title, 'renamed'); assert.equal(returned.items.length, 21);
  returned.title = 'caller edit'; returned.items[0].text = 'caller edit'; returned.items.pop();
  assert.equal(touched.title, 'renamed'); assert.equal(touched.items.length, 21); assert.notEqual(touched.items[0].text, 'caller edit');
  assert.deepEqual(JSON.parse(JSON.stringify(returned.items[1])), JSON.parse(JSON.stringify(touched.items[1])));
  assert.deepEqual(structuredClone(returned).items.length, 20);
  // A draft kept past its mutate stays mutable and never reaches the store.
  leaked.title = 'late write'; assert.equal(store.state.sessions.find(row => row.id === ids[0]).title, 'renamed');
  // Without a result the whole new state is returned, equally detached.
  const whole = store.mutate(state => { state.settings.dailyBudget = 7; });
  assert.equal(whole.settings.dailyBudget, 7); whole.settings.dailyBudget = 8; whole.sessions.length = 0;
  assert.equal(store.state.settings.dailyBudget, 7); assert.equal(store.state.sessions.length, 3);
});

test('listeners run after the commit and observe the committed generation', t => {
  const file = join(directory(t), 'state.json'), store = new Store(file), { id } = store.createSession({ title: 'listen' }), seen = [];
  store.subscribe(revision => { seen.push({ revision, current: store.state.revision, title: store.state.sessions.find(row => row.id === id).title, onDisk: JSON.parse(readStateText(file)).revision }); throw new Error('listener failure is isolated'); });
  const log = console.error; console.error = () => {}; t.after(() => { console.error = log; });
  store.mutate(state => { state.sessions.find(row => row.id === id).title = 'committed'; });
  assert.deepEqual(seen, [{ revision: store.state.revision, current: store.state.revision, title: 'committed', onDisk: store.state.revision }]);
  assert.throws(() => store.mutate(() => { throw new Error('rejected'); }), /rejected/);
  assert.equal(seen.length, 1, 'no notification for an abandoned draft');
});

test('display projections are copy-on-write, unpersisted until the next mutate, and keep committed objects frozen', t => {
  const file = join(directory(t), 'state.json'), store = new Store(file), { id } = store.createSession({ title: 'display' });
  const turnId = randomUUID(), itemId = randomUUID();
  store.mutate(state => {
    const session = state.sessions.find(row => row.id === id);
    Object.assign(session, { status: 'running', activeTurnId: turnId });
    session.turns.push({ id: turnId, status: 'running', modelConfig: { execution: 'rna' } });
    session.items.push({ id: itemId, turnId, kind: 'assistant', text: '', streaming: true, simulated: false });
  });
  const before = store.state, onDisk = readStateText(file);
  assert.equal(store.projectRuntimeDisplay({ sessionId: id, turnId, updates: [{ type: 'assistant_text', itemId, text: 'partial answer' }] }), true);
  assert.notEqual(store.state, before); assert.ok(Object.isFrozen(store.state));
  assert.equal(before.sessions.find(row => row.id === id).items.at(-1).text, '', 'the previous generation is unchanged');
  assert.equal(readStateText(file), onDisk);
  store.mutate(state => { state.settings.dailyBudget = 3; });
  assert.equal(JSON.parse(readStateText(file)).sessions.find(row => row.id === id).items.at(-1).text, 'partial answer');
});

test('draft finalize resolves unchanged subtrees to committed objects and copies changes without freezing caller values', () => {
  const base = seal({ a: { b: [1, { c: 2 }] }, d: [{ e: 1 }, { e: 2 }], f: 'x' });
  const same = draft(base); same.a.b[1].c; same.d.find(row => row.e === 2); same.f = 'x';
  assert.equal(finalize(same), base, 'read-only access and identical writes change nothing');
  const mine = { fresh: [1] }, changed = draft(base); changed.d[1].e = 3; changed.g = mine; delete changed.f;
  const next = finalize(changed);
  assert.notEqual(next, base); assert.equal(next.a, base.a); assert.equal(next.d[0], base.d[0]); assert.equal(next.d[1].e, 3);
  assert.deepEqual(Object.keys(next), ['a', 'd', 'g']); assert.ok(Object.isFrozen(next.g) && !Object.isFrozen(mine));
  mine.fresh.push(2); assert.deepEqual(next.g.fresh, [1]);
  const edge = seal({ a: 1, last: { x: 1 } }), replaced = draft(edge); delete replaced.last; replaced.last = { x: 2 };
  assert.equal(finalize(replaced).last.x, 2, 'a container field deleted and re-added in place is not mistaken for untouched');
  const primitive = draft(edge); primitive.a = 2; assert.equal(finalize(primitive).a, 2); assert.equal(finalize(primitive).last, edge.last);
  const odd = seal(JSON.parse('{"__proto__":{"x":1},"y":[]}')), copy = draft(odd); copy.y.push(1);
  assert.equal(Object.getPrototypeOf(finalize(copy)), Object.prototype); assert.deepEqual(JSON.parse(JSON.stringify(finalize(copy))), { ['__proto__']: { x: 1 }, y: [1] });
});

test('the encoder reuses untouched subtrees and produces byte-identical nodes to a full encode', () => {
  const random = (seed => () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)(7);
  let state = seal({ version: 2, revision: 1, sessions: Array.from({ length: 4 }, (_, s) => ({ id: `s${s}`, title: `t${s}`, items: Array.from({ length: 300 }, (_, i) => item(`${s}-${i}`, 200 + (i % 9) * 300)), turns: [] })), settings: { a: 1 } });
  const cache = encoderCache(); let plan = encodeState(state, { cache });
  for (let round = 0; round < 40; round++) {
    const working = draft(state), session = working.sessions[Math.floor(random() * 4)], action = random();
    if (action < .3) session.items.push(item(`r${round}`, Math.floor(random() * 12000)));
    else if (action < .5) session.items[Math.floor(random() * session.items.length)].text += ' edited';
    else if (action < .6) session.items.splice(Math.floor(random() * session.items.length), 1);
    else if (action < .7) session.items.shift();
    else if (action < .8) session.turns.push({ id: `turn-${round}`, data: 'q'.repeat(Math.floor(random() * 20000)) });
    else session.title = `title-${round}`;
    working.revision++; state = finalize(working);
    const untouched = state.sessions.find(row => row !== session && row.id !== session.id), entry = cache.parts.get(untouched);
    const cached = encodeState(state, { known: plan.contents, spans: plan.spans, cache }), full = encodeState(state, { known: plan.contents, spans: plan.spans });
    assert.equal(cached.rootContent, full.rootContent); assert.equal(cached.root, full.root); assert.equal(cached.size, full.size);
    assert.deepEqual([...cached.contents].sort(), [...full.contents].sort()); assert.deepEqual(cached.fresh.map(([hash]) => hash).sort(), full.fresh.map(([hash]) => hash).sort());
    assert.deepEqual([...cached.spans].sort(), [...full.spans].sort());
    if (entry) assert.equal(cache.parts.get(untouched), entry, 'an untouched session is not re-serialized');
    plan = cached;
  }
});

test('a large-state commit appends one log record with one fsync; checkpoints bound the log', t => {
  const file = join(directory(t), 'state.json'), { store, ids } = bigStore(file, 2, 400), fsyncs = countFsyncs(t);
  for (let i = 0; i < 5; i++) {
    fsyncs.reset(); store.mutate(state => { state.sessions.find(row => row.id === ids[i % 2]).items.push(item(`n${i}`)); });
    assert.equal(fsyncs.count, 1, 'one durable append per commit'); assert.equal(store.persistence.fsyncs, 1);
  }
  const small = new Store(join(directory(t), 'state.json')), { id } = small.createSession({ title: 'small' });
  fsyncs.reset(); small.mutate(state => { state.sessions.find(row => row.id === id).title = 'renamed'; });
  assert.ok(fsyncs.count <= 2, `inline states replace the manifest: ${fsyncs.count}`);
  // The log is checkpointed into node files before it grows past its limit.
  store.shards.logBytes = LOG_LIMIT; const [before] = logs(file);
  store.mutate(state => { state.sessions.find(row => row.id === ids[0]).title = 'checkpointed'; });
  assert.equal(logs(file).length, 1); assert.notEqual(logs(file)[0], before); assert.equal(readFileSync(join(shardDirectory(file), logs(file)[0]), 'utf8'), '');
  assert.equal(new Store(file).state.sessions.find(row => row.id === ids[0]).title, 'checkpointed');
});

test('a torn log tail exposes the previous generation; a corrupt record fails closed; reopening rotates the log', t => {
  const file = join(directory(t), 'state.json'), { store, ids } = bigStore(file, 2, 300);
  store.mutate(state => { state.sessions.find(row => row.id === ids[0]).title = 'first'; });
  const committed = readStateText(file), [log] = logs(file), path = join(shardDirectory(file), log);
  // A crash in the middle of an append leaves a line without its newline.
  appendFileSync(path, '{"generation":999,"root":"'); assert.equal(readStateText(file), committed);
  const reopened = new Store(file);
  assert.equal(reopened.state.sessions.find(row => row.id === ids[0]).title, 'first');
  assert.ok(!logs(file).includes(log), 'the first commit after a load checkpoints and drops the old log');
  reopened.mutate(state => { state.sessions.find(row => row.id === ids[1]).title = 'second'; });
  const [next] = logs(file), nextPath = join(shardDirectory(file), next), bytes = readFileSync(nextPath, 'utf8');
  writeFileSync(nextPath, bytes.replace('second', 'secbnd'));
  assert.throws(() => readStateFile(file), { code: 'STATE_SHARD_CORRUPT' });
  writeFileSync(nextPath, bytes); assert.equal(readStateFile(file).state.sessions.find(row => row.id === ids[1]).title, 'second');
});

test('an interrupted append latches the writer and never publishes a partial generation', t => {
  const file = join(directory(t), 'state.json'), { store, ids } = bigStore(file, 2, 300);
  store.mutate(state => { state.sessions.find(row => row.id === ids[0]).title = 'durable'; });
  const committed = readStateText(file), write = fs.writeSync; let injected = false;
  fs.writeSync = (fd, buffer, offset, length, position) => { if (!injected && length > 64) { injected = true; write(fd, buffer, offset, 40, position); throw Object.assign(new Error('injected EIO'), { code: 'EIO' }); } return write(fd, buffer, offset, length, position); };
  syncBuiltinESMExports(); t.after(() => { fs.writeSync = write; syncBuiltinESMExports(); });
  assert.throws(() => store.mutate(state => { state.sessions.find(row => row.id === ids[1]).title = 'torn'; }), /injected EIO/);
  fs.writeSync = write; syncBuiltinESMExports();
  assert.equal(store.persistence.failed, true); assert.equal(readStateText(file), committed);
  assert.equal(store.state.sessions.find(row => row.id === ids[1]).title, 'large-1');
  assert.equal(new Store(file).state.sessions.find(row => row.id === ids[0]).title, 'durable');
});

test('a clean close leaves a log-free formatVersion 1 manifest that earlier releases read; the next commit starts a new log', t => {
  const file = join(directory(t), 'state.json'), { store, ids } = bigStore(file, 2, 300);
  store.mutate(state => { state.sessions.find(row => row.id === ids[0]).title = 'before close'; });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).formatVersion, 2);
  assert.equal(store.close(), true); assert.equal(store.close(), false, 'nothing left to checkpoint');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(manifest.formatVersion, 1); assert.equal(manifest.log, undefined); assert.deepEqual(logs(file), []);
  assert.equal(JSON.stringify(readStateFile(file).state), JSON.stringify(store.state));
  store.mutate(state => { state.sessions.find(row => row.id === ids[1]).title = 'after close'; });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).formatVersion, 2); assert.equal(logs(file).length, 1);
  assert.equal(new Store(file).state.sessions.find(row => row.id === ids[1]).title, 'after close');
});

test('offline readers see every appended generation and a sharded writer reloads the log exactly', t => {
  const file = join(directory(t), 'state.json'), { store, ids } = bigStore(file, 2, 300);
  for (let i = 0; i < 4; i++) store.mutate(state => { state.sessions.find(row => row.id === ids[i % 2]).items.push(item(`g${i}`)); });
  const loaded = readStateFile(file);
  assert.equal(JSON.stringify(loaded.state), JSON.stringify(store.state)); assert.equal(loaded.generation, store.shards.generation);
  assert.equal(loaded.manifest.formatVersion, 2); assert.ok(loaded.logged.size > 0, 'recent nodes live only in the log');
  const writer = new ShardedStateFile(file); writer.load();
  assert.equal(writer.root, store.shards.root); assert.equal(JSON.stringify(readStateFile(file).state), JSON.stringify(store.state));
});
