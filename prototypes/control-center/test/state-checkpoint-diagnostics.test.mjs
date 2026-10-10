import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, chmod, utimes, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { createStateCheckpoint } from '../state-checkpoint.mjs';
import { readStateText } from '../state-shards.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rna-checkpoint-diagnostic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = join(root, 'private-account-state.json'), destination = join(root, 'checkpoint');
  await writeFile(stateFile, JSON.stringify({ version: 2, settings: {}, tasks: [], events: [], sessions: [] }), { mode: 0o600 });
  const sidecar = `${stateFile}.rna`; await mkdir(sidecar, { mode: 0o700 });
  const file = join(sidecar, 'private-customer-conversation.jsonl'); await writeFile(file, 'preserved private content', { mode: 0o600 });
  return { root, stateFile, destination, file, sidecar };
}
for (const mode of ['mtime', 'ctime', 'replace', 'set', 'content']) test(`real ${mode} change during checkpoint fails closed with bounded private-path diagnostic`, async t => {
  const f = await fixture(t), original = await readFile(f.file); let changed = false, failure;
  const phases = [];
  try {
    await createStateCheckpoint({ ...f, onProgress: async ({ phase }) => {
      phases.push(phase);
      if (changed || phase !== (mode === 'content' ? 'hash_after' : 'inventory_after')) return;
      changed = true;
      const before = await stat(f.file);
      if (mode === 'mtime') await utimes(f.file, before.atime, new Date(before.mtimeMs + 5000));
      if (mode === 'ctime') { await new Promise(done => setTimeout(done, 10)); await chmod(f.file, 0o700); await chmod(f.file, 0o600); await utimes(f.file, before.atime, before.mtime); }
      if (mode === 'replace') { const replacement = join(f.root, 'replacement'); await writeFile(replacement, original, { mode: 0o600 }); await utimes(replacement, before.atime, before.mtime); await rename(replacement, f.file); }
      if (mode === 'set') for (let i = 0; i < 20; i++) await writeFile(join(f.sidecar, `private-new-${i}`), 'private content');
      if (mode === 'content') { await writeFile(f.file, Buffer.alloc(original.length, 120)); await utimes(f.file, before.atime, before.mtime); }
    } });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, 'checkpoint_changed'); assert.equal(changed, true);
  const diagnostic = failure.checkpointDiagnostic; assert.equal(diagnostic.phase, mode === 'content' ? 'hash_after' : 'inventory_after');
  assert.match(diagnostic.inventoryId, /^[a-f0-9-]{36}$/);
  if (mode !== 'set') {
    const relativePath = `${basename(f.stateFile)}.rna/${basename(f.file)}`;
    const identity = createHash('sha256').update(`${diagnostic.inventoryId}\0${relativePath}`).digest('hex').slice(0, 32);
    assert.ok(diagnostic.changes.some(row => row.pathIdentity === identity), 'A local operator can identify the changed relative path without logging it');
  }
  assert.ok(diagnostic.elapsedMs >= 0); assert.ok(diagnostic.changes.length > 0 && diagnostic.changes.length <= 8);
  assert.ok(diagnostic.changes.every(row => /^[a-f0-9]{32}$/.test(row.pathIdentity) && row.rootKind === 'rna'));
  const serialized = JSON.stringify(diagnostic); for (const secret of [f.root, 'private-account', 'private-customer', 'private-new', 'preserved private content']) assert.equal(serialized.includes(secret), false);
  if (mode === 'mtime') assert.ok(diagnostic.changes.some(row => row.fields.includes('mtime')));
  if (mode === 'ctime') assert.ok(diagnostic.changes.some(row => row.fields.includes('ctime')));
  if (mode === 'replace') assert.ok(diagnostic.changes.some(row => row.fields.includes('inode')));
  if (mode === 'content') assert.ok(diagnostic.changes.some(row => row.fields.includes('sha256')));
  if (mode === 'set') { assert.equal(diagnostic.truncated, true); assert.ok(diagnostic.totalChanges >= 20); }
  assert.equal((await readdir(f.root)).includes('checkpoint'), false); assert.ok(!(await readdir(f.root)).some(name => name.includes('.pending-')));
  assert.equal(readStateText(f.stateFile).includes('sessions'), true);
});

test('ordinary checkpoint reports finite ordered phases without leaking file inventory', async t => {
  const f = await fixture(t), progress = [];
  const result = await createStateCheckpoint({ ...f, onProgress: event => { progress.push(event); } });
  assert.deepEqual(progress.map(row => row.phase), ['inventory_before', 'validate_state', 'copy', 'inventory_after', 'hash_after', 'verify_payload', 'commit']);
  assert.ok(progress.every(row => Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0));
  assert.equal(JSON.stringify(progress).includes(f.root), false); assert.ok(result.files >= 2);
});
