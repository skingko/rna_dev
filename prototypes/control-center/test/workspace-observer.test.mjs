import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceObserver, scanWorkspace } from '../workspace-observer.mjs';

async function fixture(t) { const parent = await mkdtemp(join(tmpdir(), 'rna-observer-')); const root = join(parent, 'project'); await mkdir(root); t.after(() => rm(parent, { recursive: true, force: true })); return { parent, root }; }
async function pollAndCommit(observer, options) { const result = await observer.poll(options); if (result.checkpoint && !['incomplete', 'unavailable', 'root_replaced', 'cancelled'].includes(result.status)) observer.commit(result.checkpoint); return result; }
function observe(t, root, options = {}) { const observer = createWorkspaceObserver({ root, settleMs: 0, ...options }); t.after(() => observer.close()); return observer; }

test('initial baseline is silent, complete, metadata only and explicit commit is required', async t => {
  const { root } = await fixture(t); await writeFile(join(root, 'README.md'), 'private document body');
  const observer = observe(t, root), initial = await observer.poll();
  assert.equal(initial.status, 'baseline'); assert.deepEqual(initial.changes, []); assert.equal(observer.checkpoint(), null);
  assert.equal(initial.checkpoint.entries[0].method, 'metadata'); assert.ok(!JSON.stringify(initial).includes('private document body'));
  assert.equal((await observer.poll()).reason, 'checkpoint_not_committed');
  assert.throws(() => observer.commit({ ...initial.checkpoint, lastBatchId: 'fake' }), /pending proposal/);
  observer.commit(initial.checkpoint); assert.equal((await pollAndCommit(observer)).status, 'unchanged');
});

test('coalesces actual writes, creates and deletion after stable scans', async t => {
  const { root } = await fixture(t); await writeFile(join(root, 'a.txt'), 'first'); await writeFile(join(root, 'gone.txt'), 'remove');
  let clock = 1000; const observer = observe(t, root, { settleMs: 100, now: () => clock }); await pollAndCommit(observer);
  await writeFile(join(root, 'a.txt'), 'second'); await writeFile(join(root, 'new.txt'), 'created'); await rm(join(root, 'gone.txt'));
  assert.equal((await pollAndCommit(observer)).status, 'settling'); clock += 101;
  await writeFile(join(root, 'a.txt'), 'third change resets settle'); assert.equal((await pollAndCommit(observer)).status, 'settling');
  clock += 101; const result = await pollAndCommit(observer); assert.equal(result.status, 'changed');
  assert.deepEqual(result.changes.map(({ path, kind }) => [path, kind]), [['a.txt', 'modified'], ['gone.txt', 'deleted'], ['new.txt', 'created']]);
  assert.equal((await pollAndCommit(observer)).status, 'unchanged');
});

test('committed checkpoint restart emits no duplicate; uncommitted retry has same batch identity', async t => {
  const { root } = await fixture(t); await writeFile(join(root, 'a.txt'), 'first'); const first = observe(t, root); await pollAndCommit(first);
  await writeFile(join(root, 'a.txt'), 'second'); await pollAndCommit(first);
  const retained = first.checkpoint(), attempted = await first.poll(); assert.equal(attempted.status, 'changed'); await first.close();
  const retry = observe(t, root, { checkpoint: retained }); const emitted = await pollAndCommit(retry);
  assert.equal(emitted.batchId, attempted.batchId);
  const restarted = observe(t, root, { checkpoint: retry.checkpoint() }); assert.equal((await pollAndCommit(restarted)).status, 'unchanged');
});

test('incomplete directory scan cannot advance baseline or infer deleted files', async t => {
  const { root } = await fixture(t); await writeFile(join(root, 'keep.txt'), 'baseline'); const observer = observe(t, root, { limits: { maxFiles: 1 } }); await pollAndCommit(observer);
  const checkpoint = observer.checkpoint(); await writeFile(join(root, 'new.txt'), 'new');
  const result = await observer.poll(); assert.equal(result.status, 'incomplete'); assert.equal(result.reason, 'file_limit'); assert.deepEqual(result.changes, []); assert.deepEqual(observer.checkpoint(), checkpoint);
  const scan = await scanWorkspace({ root, limits: { maxFiles: 1 } }); assert.deepEqual(scan.entries, []);
});

test('entry, depth, snapshot and content budgets expose incomplete coverage', async t => {
  const { root } = await fixture(t); await mkdir(join(root, 'sub')); await writeFile(join(root, 'sub', 'a.txt'), 'content');
  assert.equal((await scanWorkspace({ root, limits: { maxDepth: 0 } })).reason, 'depth_limit');
  assert.equal((await scanWorkspace({ root, limits: { maxEntries: 1 } })).reason, 'entry_limit');
  await writeFile(join(root, 'a'.repeat(180)), 'long path');
  assert.equal((await scanWorkspace({ root, limits: { maxSnapshotBytes: 128 } })).reason, 'snapshot_limit');
  assert.equal((await scanWorkspace({ root, limits: { contentHashMaxFileBytes: 100, contentHashTotalBytes: 1 } })).reason, 'content_limit');
});

test('dependency/build/runtime/secrets and symlink paths are excluded from snapshots', async t => {
  const { root, parent } = await fixture(t);
  for (const name of ['node_modules', '.git', 'dist', '.state', '.rna', '.env']) { await mkdir(join(root, name)); await writeFile(join(root, name, 'hidden.txt'), 'sensitive'); }
  for (const name of ['.env.local', 'private.key', 'credentials.json', 'secrets.yaml', '.npmrc', 'secret.txt', 'state.json.secrets', 'tokens.json', 'auth.json']) await writeFile(join(root, name), 'sensitive');
  const outside = join(parent, 'outside'); await mkdir(outside); await writeFile(join(outside, 'private.txt'), 'external secret');
  await symlink(outside, join(root, 'external')); await symlink(join(outside, 'private.txt'), join(root, 'external.txt')); await writeFile(join(root, 'good.txt'), 'visible');
  const scan = await scanWorkspace({ root }); assert.equal(scan.status, 'complete'); assert.deepEqual(scan.entries.map(entry => entry.path), ['good.txt']); assert.equal(scan.coverage.symlinks, 2);
  assert.equal((await scanWorkspace({ root: join(root, 'external') })).status, 'unavailable');
});

test('root disappearance and replacement do not publish deletion or rebaseline', async t => {
  const { root, parent } = await fixture(t); await writeFile(join(root, 'a.txt'), 'original'); const observer = observe(t, root); await pollAndCommit(observer);
  const baseline = observer.checkpoint(); await rename(root, join(parent, 'previous'));
  const unavailable = await observer.poll(); assert.equal(unavailable.status, 'unavailable'); assert.deepEqual(unavailable.changes, []);
  await mkdir(root); await writeFile(join(root, 'other.txt'), 'replacement'); const replaced = await observer.poll(); assert.equal(replaced.status, 'root_replaced'); assert.deepEqual(replaced.changes, []); assert.deepEqual(observer.checkpoint(), baseline);
});

test('foreground acknowledgement does not discard already pending external changes', async t => {
  const { root } = await fixture(t); await writeFile(join(root, 'external.txt'), 'old'); await writeFile(join(root, 'own.txt'), 'old');
  const observer = observe(t, root); await pollAndCommit(observer); await writeFile(join(root, 'external.txt'), 'external change'); await pollAndCommit(observer);
  await writeFile(join(root, 'own.txt'), 'agent writes during foreground'); const during = await pollAndCommit(observer, { acknowledgeOnly: true });
  assert.equal(during.status, 'settling'); assert.equal(during.suppressed, 1); assert.deepEqual(during.changes, []);
  const restarted = observe(t, root, { checkpoint: observer.checkpoint() }); const after = await pollAndCommit(restarted);
  assert.equal(after.status, 'changed'); assert.deepEqual(after.changes.map(change => change.path), ['external.txt']);
});

test('known written paths suppress exact paths while independent external edits survive', async t => {
  const { root } = await fixture(t); const observer = observe(t, root); await pollAndCommit(observer);
  await writeFile(join(root, 'owned.txt'), 'tool'); await writeFile(join(root, 'external.txt'), 'editor');
  const pending = await pollAndCommit(observer, { suppressPaths: ['owned.txt', '../invalid'] }); assert.equal(pending.suppressed, 1);
  const changed = await pollAndCommit(observer); assert.deepEqual(changed.changes.map(change => change.path), ['external.txt']);
});

test('metadata touch is honest and optional content mode ignores same bytes rewritten', async t => {
  const { root } = await fixture(t); await writeFile(join(root, 'a.txt'), 'same'); const observer = observe(t, root, { limits: { contentHashMaxFileBytes: 100 } }); await pollAndCommit(observer);
  assert.equal(observer.checkpoint().entries[0].method, 'content'); await writeFile(join(root, 'a.txt'), 'same'); assert.equal((await pollAndCommit(observer)).status, 'unchanged');
  await writeFile(join(root, 'a.txt'), 'different'); await pollAndCommit(observer); assert.equal((await pollAndCommit(observer)).status, 'changed');
});

test('aborted scan and close return cancelled with no checkpoint publication; repeated poll coalesces', async t => {
  const { root } = await fixture(t); const signal = AbortSignal.abort(); assert.equal((await scanWorkspace({ root, signal })).status, 'cancelled');
  const observer = observe(t, root), pending = observer.poll(); assert.equal(observer.poll(), pending); const closed = observer.close();
  assert.equal((await pending).status, 'cancelled'); await closed; assert.equal(observer.checkpoint(), null); assert.equal((await observer.poll()).reason, 'closed');
  const fresh = observe(t, root); assert.equal((await pollAndCommit(fresh)).status, 'baseline');
});

test('external cancellation mid scan releases child before a new scan is admitted', async t => {
  const { root } = await fixture(t); const abort = new AbortController(); const pending = scanWorkspace({ root, signal: abort.signal }); abort.abort();
  assert.equal((await pending).status, 'cancelled'); assert.equal((await scanWorkspace({ root })).status, 'complete');
});

test('checkpoint root/config mismatch rebaselines silently instead of interpreting changed scope', async t => {
  const { root, parent } = await fixture(t); await writeFile(join(root, 'a.txt'), 'original'); const first = observe(t, root); await pollAndCommit(first);
  const second = join(parent, 'second'); await mkdir(second); await writeFile(join(second, 'b.txt'), 'other');
  const observer = observe(t, second, { checkpoint: first.checkpoint() }); assert.equal((await pollAndCommit(observer)).status, 'baseline');
  const differentPolicy = observe(t, root, { checkpoint: first.checkpoint(), limits: { maxFiles: 100 } }); assert.equal((await pollAndCommit(differentPolicy)).status, 'baseline');
});

test('concurrent scans cannot accumulate workers for one root', async t => {
  const { root } = await fixture(t); const pending = scanWorkspace({ root });
  assert.equal((await scanWorkspace({ root })).reason, 'worker_still_running');
  assert.equal((await pending).status, 'complete'); assert.equal((await scanWorkspace({ root })).status, 'complete');
});

test('clock rewind restarts settling rather than releasing a stale pending batch', async t => {
  const { root } = await fixture(t); let now = 1000; const observer = observe(t, root, { settleMs: 100, now: () => now }); await pollAndCommit(observer);
  await writeFile(join(root, 'new.txt'), 'created'); await pollAndCommit(observer); now = 1;
  assert.equal((await pollAndCommit(observer)).status, 'settling'); now = 102; assert.equal((await pollAndCommit(observer)).status, 'changed');
});

test('explicit host-state exclusions stop state-file echoes without hiding similar project filenames', async t => {
  const { root } = await fixture(t); await writeFile(join(root, 'custom-state.json'), '{}');
  await mkdir(join(root, 'custom-state.json.observations')); await writeFile(join(root, 'custom-state.json.observations', 'source.json'), '{}');
  await writeFile(join(root, 'custom-state.json.examples.md'), 'project documentation');
  const observer = observe(t, root, { excludePaths: ['custom-state.json', 'custom-state.json.observations/'] }); await pollAndCommit(observer);
  for (let i = 0; i < 3; i++) {
    await writeFile(join(root, 'custom-state.json'), JSON.stringify({ revision: i + 1 }));
    await writeFile(join(root, 'custom-state.json.observations', 'source.json'), JSON.stringify({ checkedAt: i + 1 }));
    assert.equal((await pollAndCommit(observer)).status, 'unchanged');
  }
  await writeFile(join(root, 'custom-state.json.examples.md'), 'real project documentation edit'); await pollAndCommit(observer);
  assert.deepEqual((await pollAndCommit(observer)).changes.map(change => change.path), ['custom-state.json.examples.md']);
  assert.deepEqual(observer.checkpoint().entries.map(entry => entry.path), ['custom-state.json.examples.md']);
});

test('exclusions are bounded root-relative paths and change the checkpoint policy only when actually configured', async t => {
  const { root } = await fixture(t); await writeFile(join(root, 'a.txt'), 'a'); const first = observe(t, root); await pollAndCommit(first);
  const empty = observe(t, root, { checkpoint: first.checkpoint(), excludePaths: [] }); assert.deepEqual(empty.checkpoint(), first.checkpoint());
  const changed = observe(t, root, { checkpoint: first.checkpoint(), excludePaths: ['a.txt'] }); assert.equal(changed.checkpoint(), null); assert.equal((await pollAndCommit(changed)).status, 'baseline');
  const identical = observe(t, root, { checkpoint: changed.checkpoint(), excludePaths: ['a.txt', 'a.txt/'] }); assert.deepEqual(identical.checkpoint(), changed.checkpoint());
  for (const excludePaths of [['../escape'], ['/absolute'], [''], ['.'], ['a//b'], ['a\nb'], ['a\\b'], Array.from({ length: 65 }, (_, i) => `file-${i}`)]) {
    assert.throws(() => createWorkspaceObserver({ root, excludePaths }), /exclusions/);
    assert.equal((await scanWorkspace({ root, excludePaths })).reason, 'invalid_exclusions');
  }
});
