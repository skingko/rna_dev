import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, symlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { acquireProcessLease, processAlive } from './process-lease.mjs';
import { atomicWrite, syncDirectory } from './durable-files.mjs';
import { readStateFile, writeStateFile } from './state-shards.mjs';

// These are host-owned state, never the projects beside it. Keep this list in
// sync when adding persistence. An unknown state-prefixed sibling fails closed.
// '.d' holds the sharded state nodes referenced by the '' manifest. It is
// last so checkpoints and recovery markers written before sharding (which
// lack it) remain verifiable and restorable; their monolithic state migrates.
// Every generation is a prefix of the next. Old checkpoints and recovery markers
// keep verifying by the generation whose length they carry; append new sidecars only.
const SIDECARS_0_21 = Object.freeze(['', '.secrets', '.subscriptions', '.rna', '.pi', '.genomes', '.initialization', '.evolution', '.capabilities', '.archive', '.observations']);
// '.direct-fixes' and '.background-changes' hold the snapshots behind one-click reverts (state records point at them).
const SIDECARS_0_38 = Object.freeze([...SIDECARS_0_21, '.d', '.skill-foundation']);
export const CHECKPOINT_SIDECARS = Object.freeze([...SIDECARS_0_38, '.direct-fixes', '.background-changes']);
const SIDECAR_GENERATIONS = Object.freeze([SIDECARS_0_21, Object.freeze([...SIDECARS_0_21, '.d']), SIDECARS_0_38, CHECKPOINT_SIDECARS]);
const sidecarGeneration = length => SIDECAR_GENERATIONS.find(generation => generation.length === length);
const DEFAULT_LIMITS = Object.freeze({ maxEntries: 100000, maxBytes: 8 * 1024 ** 3, maxFileBytes: 1024 ** 3, maxDepth: 64, maxManifestBytes: 32 * 1024 ** 2, maxElapsedMs: 300000 });
const leases = new WeakMap();
const RECOVERY_PREIMAGE = Symbol('recovery-preimage');
const hash = value => createHash('sha256').update(value).digest('hex');
const error = (message, code = 'checkpoint_invalid') => Object.assign(new Error(message), { code });
const fail = (message, code) => { throw error(message, code); };
const inside = (root, path) => { const part = relative(root, path); return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const validName = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 255 && !/[\x00-\x1f\x7f/\\]/.test(value) && !['.', '..'].includes(value);
const safeRelative = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4096 && !isAbsolute(value) && !value.includes('\\') && value.split('/').every(validName);
const present = async path => { try { return await lstat(path); } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; } };
const metadata = info => [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rootNames = (name, sidecars = CHECKPOINT_SIDECARS) => sidecars.map(suffix => `${name}${suffix}`);
const serviceEvidence = name => ['config.json', 'intent.json', 'status.json', 'endurance.json', 'endurance-request.json'].includes(name)
  || /^endurance-[a-f0-9-]{36}(?:-[a-f0-9]{16})?\.json$/.test(name);
const metadataFields = ['device', 'inode', 'mode', 'size', 'mtime', 'ctime'];
function checkpointPath(p, path, fields) {
  const relativePath = relative(p.sourceParent, path).split(sep).join('/'), root = relativePath.split('/')[0];
  const suffix = root.startsWith(p.stateName) ? root.slice(p.stateName.length) : null;
  const rootKind = suffix === '' ? 'state' : [...CHECKPOINT_SIDECARS, '.service'].includes(suffix) ? suffix.slice(1) : 'other';
  // Per-checkpoint salt prevents stable cross-project filename fingerprints.
  // Only the relative owned path is hashed; no absolute private path is stored.
  return { pathIdentity: hash(`${p.diagnosticSalt}\0${relativePath}`).slice(0, 32), rootKind, fields };
}
function diagnostic(p, changes = [], totalChanges = changes.length) {
  return { schemaVersion: 1, inventoryId: p.diagnosticSalt, phase: p.phase, elapsedMs: Math.max(0, Date.now() - p.startedAt), changes: changes.slice(0, 8), totalChanges, truncated: totalChanges > 8 };
}
function changedFile(p, path, message, fields) {
  const cause = error(message, 'checkpoint_changed');
  if (p.sourceParent) cause.checkpointDiagnostic = diagnostic(p, [checkpointPath(p, path, fields)]);
  throw cause;
}
function changedInventory(p, before, after) {
  const previous = new Map(before.signatures), current = new Map(after.signatures), changes = [];
  for (const path of new Set([...previous.keys(), ...current.keys()])) {
    const left = previous.get(path), right = current.get(path);
    if (!same(left, right)) changes.push(checkpointPath(p, join(p.sourceParent, path), !left || !right ? ['presence'] : metadataFields.filter((_field, index) => left[index] !== right[index])));
  }
  for (const root of before.roots) if (root.present !== after.roots.find(row => row.path === root.path)?.present && !changes.some(row => row.pathIdentity === checkpointPath(p, join(p.sourceParent, root.path), []).pathIdentity)) changes.push(checkpointPath(p, join(p.sourceParent, root.path), ['presence']));
  if (!changes.length) changes.push(checkpointPath(p, join(p.sourceParent, p.stateName), ['order']));
  return diagnostic(p, changes, changes.length);
}
async function checkpointPhase(p, options, phase) {
  p.phase = phase; p.currentPath = null;
  if (options.onProgress) await options.onProgress({ phase, elapsedMs: Math.max(0, Date.now() - p.startedAt) });
}
function policy(input = {}, signal) {
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key] * 16) fail('Checkpoint limits are invalid.');
    limits[key] = value;
  }
  const deadline = Date.now() + limits.maxElapsedMs;
  return { limits, signal, check() { signal?.throwIfAborted(); if (Date.now() > deadline) fail('Checkpoint exceeded its bounded time window.', 'checkpoint_timeout'); } };
}
async function canonicalStateFile(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || !validName(basename(value))) fail('Checkpoint requires an absolute state file path.');
  const path = join(await realpath(dirname(value)), basename(value));
  const info = await present(path);
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) fail('State must be an ordinary, non-linked file.', 'checkpoint_unsafe_path');
  return path;
}
async function safeDirectory(path, { create = false } = {}) {
  const parent = await realpath(dirname(path)), expected = join(parent, basename(path));
  if (create) await mkdir(expected, { mode: 0o700 });
  const info = await lstat(expected);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(expected) !== expected) fail('Checkpoint directory is unsafe.', 'checkpoint_unsafe_path');
  return expected;
}
async function safeLockPath(path) {
  const info = await present(path);
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) fail('Lease path is unsafe.', 'checkpoint_unsafe_path');
  for (const suffix of ['.sqlite', '.sqlite-journal', '.sqlite-wal', '.sqlite-shm']) {
    const child = await present(`${path}${suffix}`);
    if (child && (!child.isFile() || child.isSymbolicLink() || child.nlink !== 1)) fail('Lease database path is unsafe.', 'checkpoint_unsafe_path');
  }
}

/** Same ownership locks as CLI, supervisor and daemon. Call only after draining
 * and stopping: this function never signals a process or waits for work to end. */
export async function acquireCheckpointLease(stateFile) {
  stateFile = await canonicalStateFile(stateFile);
  const service = `${stateFile}.service`;
  if (!await present(service)) await mkdir(service, { mode: 0o700 });
  await safeDirectory(service);
  const releases = [];
  try {
    for (const path of [join(service, 'operation.lock'), join(service, 'supervisor.lock'), `${stateFile}.lock`]) {
      await safeLockPath(path);
      releases.push(await acquireProcessLease(path, { purpose: 'state-checkpoint', stateFile }));
    }
  } catch (cause) { for (const release of releases.reverse()) release(); throw error(`A stopped, exclusively owned state is required: ${cause.message}`, 'checkpoint_not_offline'); }
  const record = { stateFile, active: true }, lease = Object.freeze({ stateFile, release() {
    if (!record.active) return; record.active = false;
    for (const release of releases.reverse()) release();
  } });
  leases.set(lease, record); return lease;
}
function assertLease(lease, stateFile) {
  const record = leases.get(lease);
  if (!record?.active || record.stateFile !== stateFile) fail('A live checkpoint lease for this exact state file is required.', 'checkpoint_invalid_lease');
}
async function owned(options, operation) {
  const stateFile = await canonicalStateFile(options.stateFile), lease = options.lease ?? await acquireCheckpointLease(stateFile);
  try { assertLease(lease, stateFile); return await operation(stateFile, lease); }
  finally { if (!options.lease) lease.release(); }
}
export const excludedSibling = suffix => /^\.lock(?:\.sqlite(?:-(?:journal|wal|shm))?)?$/.test(suffix)
  || /^\.(?:before-|v1-backup(?:-|$)|legacy-|tmp-)/.test(suffix) || ['.service', '.recovery', '.recovery.json', '.checkpoints', '.releases'].includes(suffix)
  // Usage metrics (and a rewrite temp left by a crash) are derived observations, not state. `.usage-cache.survival.json`
  // is the cache-survival file of an unreleased build: tolerated until it is migrated into `.rna` and removed.
  || /^\.usage-cache(?:\.survival\.json|\.jsonl)(?:\.\d+\.tmp)?$/.test(suffix);
async function inspectSiblings(stateFile) {
  const name = basename(stateFile);
  for (const sibling of await readdir(dirname(stateFile))) {
    if (!sibling.startsWith(`${name}.`)) continue;
    const suffix = sibling.slice(name.length);
    if (!CHECKPOINT_SIDECARS.includes(suffix) && !excludedSibling(suffix)) fail(`Unknown state sidecar: ${sibling}. Update the checkpoint inventory before proceeding.`, 'checkpoint_unknown_sidecar');
  }
}
function excludedEntry(root, part) {
  // Process ownership must never be restored as live state. package-lock.json
  // and arbitrary user/library *.lock files are deliberately not filtered.
  if (root.endsWith('.service')) return /^(?:operation|supervisor)\.lock(?:\.sqlite(?:-(?:journal|wal|shm))?)?$/.test(part);
  return root.endsWith('.rna') && /\.rna\.jsonl\.lock$/.test(part);
}
async function ensureInactiveJournal(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) fail('Session ownership is invalid.', 'checkpoint_not_offline');
  let owner; try { owner = JSON.parse(await readFile(path, 'utf8')); } catch { fail('Session ownership cannot be verified.', 'checkpoint_not_offline'); }
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || processAlive(owner.pid)) fail('A session still has a live or uncertain writer.', 'checkpoint_not_offline');
}
async function inventory(parent, roots, p, { excludeRuntime = false, privatePermissions = false } = {}) {
  const entries = [], presence = [], signatures = []; let bytes = 0;
  for (const root of roots) {
    p.check(); const rootPath = join(parent, root), rootInfo = await present(rootPath);
    presence.push({ path: root, present: Boolean(rootInfo) });
    if (!rootInfo) continue;
    if (rootInfo.isSymbolicLink()) fail('Owned state roots cannot be symlinks.', 'checkpoint_unsafe_path');
    const walk = async (path, depth) => {
      p.currentPath = path;
      p.check(); if (depth > p.limits.maxDepth) fail('Checkpoint path depth exceeds the limit.', 'checkpoint_limit');
      const part = relative(rootPath, path).split(sep).join('/'), entryPath = relative(parent, path).split(sep).join('/');
      if (!safeRelative(entryPath)) fail('Checkpoint contains an unsafe path.', 'checkpoint_unsafe_path');
      if (excludeRuntime && excludedEntry(root, part)) {
        if (root.endsWith('.rna')) await ensureInactiveJournal(path);
        return;
      }
      const info = await lstat(path);
      if (excludeRuntime && root.endsWith('.service') && part && (!info.isFile() || part.includes('/'))) fail('Service evidence must be a bounded ordinary file.', 'checkpoint_unsafe_path');
      // The maintenance worker owns its excluded records under .service. Their
      // atomic renames may update that directory while the evidence files and
      // all application state remain unchanged under the three offline leases.
      signatures.push([entryPath, excludeRuntime && root.endsWith('.service') && !part ? [info.dev, info.ino, info.mode] : metadata(info)]);
      if (privatePermissions && !info.isSymbolicLink() && (info.mode & 0o077)) fail('Checkpoint payload permissions are not private.', 'checkpoint_unsafe_permissions');
      if (entries.length >= p.limits.maxEntries) fail('Checkpoint entry count exceeds the limit.', 'checkpoint_limit');
      if (info.isDirectory()) {
        entries.push({ path: entryPath, type: 'directory', mode: 0o700 });
        for (const name of (await readdir(path)).sort()) {
          if (excludeRuntime && root.endsWith('.service') && !part && !serviceEvidence(name)) continue;
          if (!validName(name)) fail('Checkpoint path is invalid.', 'checkpoint_unsafe_path'); await walk(join(path, name), depth + 1);
        }
      } else if (info.isFile()) {
        if (info.nlink !== 1) fail('Checkpoint refuses hard-linked files.', 'checkpoint_unsafe_path');
        bytes += info.size;
        if (info.size > p.limits.maxFileBytes || bytes > p.limits.maxBytes || excludeRuntime && root.endsWith('.service') && info.size > 2 * 1024 ** 2) fail('Checkpoint size exceeds the limit.', 'checkpoint_limit');
        entries.push({ path: entryPath, type: 'file', bytes: info.size, mode: /\.(?:secrets|subscriptions)$/.test(root) ? 0o600 : info.mode & 0o100 ? 0o700 : 0o600 });
      } else if (info.isSymbolicLink()) {
        const target = await readlink(path);
        if (!target || Buffer.byteLength(target) > 4096 || isAbsolute(target) || /[\x00-\x1f\x7f\\]/.test(target) || !inside(rootPath, resolve(dirname(path), target))) fail('Symlink escapes its owned sidecar.', 'checkpoint_unsafe_path');
        let resolved; try { resolved = await realpath(path); } catch { fail('Symlink is dangling or cyclic.', 'checkpoint_unsafe_path'); }
        if (!inside(rootPath, resolved) || !(await lstat(resolved)).isFile() && !(await lstat(resolved)).isDirectory()) fail('Symlink target is outside its owned sidecar.', 'checkpoint_unsafe_path');
        entries.push({ path: entryPath, type: 'symlink', target });
      } else fail('Checkpoint contains a special file.', 'checkpoint_unsafe_path');
    };
    await walk(rootPath, 0);
  }
  return { entries, roots: presence, bytes, signatures };
}
async function fileBytes(path, p, { target, mode = 0o600, expectedBytes } = {}) {
  p.currentPath = path;
  p.check(); const parent = await realpath(dirname(path));
  if (parent !== dirname(path)) fail('File ancestor changed or became a symlink.', 'checkpoint_unsafe_path');
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > p.limits.maxFileBytes || expectedBytes !== undefined && before.size !== expectedBytes) changedFile(p, path, 'Checkpoint file changed or is unsafe.', [expectedBytes !== undefined && before.size !== expectedBytes ? 'size' : 'file_type']);
  const source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let output;
  try {
    const opened = metadata(await source.stat());
    if (!same(metadata(before), opened)) changedFile(p, path, 'Checkpoint source changed while opening.', metadataFields.filter((_field, index) => metadata(before)[index] !== opened[index]));
    if (target) output = await open(target, 'wx', mode);
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024); let count = 0;
    for (;;) {
      p.check(); const { bytesRead } = await source.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
      count += bytesRead; if (count > before.size) changedFile(p, path, 'Checkpoint source grew while reading.', ['read_length']);
      digest.update(buffer.subarray(0, bytesRead));
      if (output) for (let offset = 0; offset < bytesRead;) { const wrote = await output.write(buffer, offset, bytesRead - offset, null); if (!wrote.bytesWritten) fail('Checkpoint write made no progress.', 'checkpoint_write'); offset += wrote.bytesWritten; }
    }
    const finished = metadata(await source.stat()), linked = metadata(await lstat(path)), sameParent = await realpath(dirname(path)) === parent;
    if (count !== before.size || !same(metadata(before), finished) || !same(metadata(before), linked) || !sameParent) changedFile(p, path, 'Checkpoint source changed while reading.',
      [...new Set([...(count !== before.size ? ['read_length'] : []), ...metadataFields.filter((_field, index) => metadata(before)[index] !== finished[index] || metadata(before)[index] !== linked[index]), ...(!sameParent ? ['presence'] : [])])]);
    if (output) { await output.chmod(mode); await output.sync(); }
    return digest.digest('hex');
  } finally { await output?.close(); await source.close(); }
}
async function copyEntries(source, destination, entries, p, { verifyHashes = false } = {}) {
  for (const entry of entries) {
    p.check(); const target = join(destination, entry.path);
    if (entry.type === 'directory') await mkdir(target, { mode: 0o700 });
    else if (entry.type === 'file') {
      const digest = await fileBytes(join(source, entry.path), p, { target, mode: entry.mode, expectedBytes: entry.bytes });
      if (verifyHashes && digest !== entry.sha256) fail('Checkpoint content hash mismatch.', 'checkpoint_hash_mismatch');
      entry.sha256 = digest;
    }
  }
  // Create symlinks last so no output traversal can follow one.
  for (const entry of entries) if (entry.type === 'symlink') await symlink(entry.target, join(destination, entry.path));
  for (const entry of entries.filter(row => row.type === 'directory').reverse()) syncDirectory(join(destination, entry.path));
  syncDirectory(destination);
}
async function newDestination(value, blocked = []) {
  if (typeof value !== 'string' || !isAbsolute(value) || !validName(basename(value))) fail('Checkpoint destination must be an absolute, new directory.');
  const path = join(await realpath(dirname(value)), basename(value));
  if (blocked.some(root => inside(root, path) || inside(path, root))) fail('Checkpoint destination overlaps source state.', 'checkpoint_unsafe_path');
  if (await present(path)) fail('Checkpoint destination already exists.', 'checkpoint_destination_exists');
  return path;
}
async function stateVersion(path, p) {
  const info = await lstat(path); if (info.size > p.limits.maxManifestBytes) fail('State is too large to validate safely.', 'checkpoint_limit');
  let state; try { state = readStateFile(path)?.state; } catch { fail('State is not valid JSON.', 'checkpoint_invalid_state'); }
  if (!plain(state) || ![1, 2].includes(state.version) || !plain(state.settings) || !Array.isArray(state.tasks) || !Array.isArray(state.events)
    || state.version === 2 && (!Array.isArray(state.sessions) || state.sessions.some(row => !plain(row) || ['items', 'turns', 'inbox', 'submissions'].some(key => !Array.isArray(row[key]))))) fail('State format is unsupported.', 'checkpoint_invalid_state');
  return { status: 'supported', version: state.version, revision: Number.isSafeInteger(state.revision) ? state.revision : null };
}
function version(value) { if (value === undefined) return null; if (typeof value !== 'string' || !/^[a-zA-Z0-9.+_-]{1,80}$/.test(value)) fail('Release version is invalid.'); return value; }

/** Byte-preserving checkpoint. SHA-256 detects corruption, not authenticity.
 * Live provider/remote memory state and external project work are not included. */
export async function createStateCheckpoint(options) {
  return owned(options, async (stateFile, lease) => {
    const p = policy(options.limits, options.signal), name = basename(stateFile);
    Object.assign(p, { sourceParent: dirname(stateFile), stateName: name, diagnosticSalt: randomUUID(), startedAt: Date.now(), phase: 'inventory_before' });
    try {
    const stateExists = Boolean(await present(stateFile));
    if (!stateExists && options[RECOVERY_PREIMAGE] !== true) fail('State file does not exist.', 'checkpoint_missing_state');
    await inspectSiblings(stateFile);
    const roots = [...rootNames(name), `${name}.service`], parent = dirname(stateFile);
    // .service/checkpoints is a supported output location. Only the explicit
    // small evidence allowlist is read from .service; checkpoint/code trees are
    // never recursively included in their own backups.
    const destination = await newDestination(options.destination, rootNames(name).map(root => join(parent, root)));
    await checkpointPhase(p, options, 'inventory_before');
    const before = await inventory(parent, roots, p, { excludeRuntime: true });
    await checkpointPhase(p, options, 'validate_state');
    let state;
    if (!stateExists) state = { status: 'missing', version: null, revision: null };
    else try { state = await stateVersion(stateFile, p); }
    catch (cause) {
      if (options[RECOVERY_PREIMAGE] !== true || !['checkpoint_invalid_state', 'checkpoint_limit'].includes(cause.code)) throw cause;
      state = { status: 'unsupported', version: null, revision: null };
    }
    const staging = join(dirname(destination), `.${basename(destination)}.pending-${randomUUID()}`); let committed = false;
    await mkdir(staging, { mode: 0o700 });
    try {
      const payload = join(staging, 'payload'); await mkdir(payload, { mode: 0o700 });
      await checkpointPhase(p, options, 'copy');
      await copyEntries(parent, payload, before.entries, p);
      await checkpointPhase(p, options, 'inventory_after');
      const after = await inventory(parent, roots, p, { excludeRuntime: true });
      if (!same(before.signatures, after.signatures) || !same(before.roots, after.roots)) throw Object.assign(error('State changed during checkpoint.', 'checkpoint_changed'), { checkpointDiagnostic: changedInventory(p, before, after) });
      // A second hash pass detects an in-place write with restored timestamps.
      await checkpointPhase(p, options, 'hash_after');
      for (const entry of before.entries) if (entry.type === 'file' && await fileBytes(join(parent, entry.path), p, { expectedBytes: entry.bytes }) !== entry.sha256) throw Object.assign(error('State content changed during checkpoint.', 'checkpoint_changed'), { checkpointDiagnostic: diagnostic(p, [checkpointPath(p, join(parent, entry.path), ['sha256'])]) });
      assertLease(lease, stateFile); p.check();
      const manifest = { format: 'rna-state-checkpoint', version: 1, id: randomUUID(), createdAt: new Date().toISOString(), sourceStateFile: stateFile,
        stateFileName: name, state, hostVersion: version(options.hostVersion), sdkVersion: version(options.sdkVersion),
        consistency: 'offline-exclusive-owner', roots: before.roots.map(root => ({ ...root, role: root.path === `${name}.service` ? 'service-evidence' : 'application-state' })),
        exclusions: ['project-workspaces', 'remote-openviking-data', 'external-provider-state', 'global-auth-stores', 'process-ownership-locks', 'historical-backups', 'previous-recovery-transactions', 'service-release-checkpoint-and-maintenance-trees', 'service-logs'],
        entries: before.entries, totalBytes: before.bytes, restore: { absolutePathsPreserved: true, newDirectoryIsStagingOnly: true, externalEffectsReviewRequired: true, serviceConfigurationRestored: false } };
      const content = `${JSON.stringify(manifest)}\n`; if (Buffer.byteLength(content) > p.limits.maxManifestBytes) fail('Checkpoint manifest exceeds the limit.', 'checkpoint_limit');
      atomicWrite(join(staging, 'manifest.json'), content); atomicWrite(join(staging, 'manifest.sha256'), `${hash(content)}\n`);
      await checkpointPhase(p, options, 'verify_payload');
      await verifyStateCheckpoint({ directory: staging, limits: options.limits, signal: options.signal });
      await checkpointPhase(p, options, 'commit');
      if (await present(destination)) fail('Checkpoint destination appeared during copy.', 'checkpoint_destination_exists');
      await rename(staging, destination); committed = true; syncDirectory(dirname(destination));
      return { directory: destination, id: manifest.id, manifestHash: hash(content), files: manifest.entries.filter(row => row.type === 'file').length, bytes: manifest.totalBytes, manifest };
    } finally { if (!committed) await rm(staging, { recursive: true, force: true }); }
    } catch (cause) {
      cause.checkpointDiagnostic ??= diagnostic(p, p.currentPath ? [checkpointPath(p, p.currentPath, [])] : []);
      throw cause;
    }
  });
}

function validateManifest(manifest, p) {
  if (!plain(manifest) || manifest.format !== 'rna-state-checkpoint' || manifest.version !== 1 || typeof manifest.id !== 'string' || !/^[a-f0-9-]{36}$/.test(manifest.id)
    || !validName(manifest.stateFileName) || !isAbsolute(manifest.sourceStateFile ?? '') || basename(manifest.sourceStateFile) !== manifest.stateFileName || manifest.consistency !== 'offline-exclusive-owner') fail('Checkpoint manifest format is unsupported.');
  const sidecars = (Array.isArray(manifest.roots) && sidecarGeneration(manifest.roots.length - 1)) || CHECKPOINT_SIDECARS;
  const expected = [...rootNames(manifest.stateFileName, sidecars), `${manifest.stateFileName}.service`];
  if (!plain(manifest.state) || !['supported', 'unsupported', 'missing'].includes(manifest.state.status)
    || manifest.state.status === 'supported' && ![1, 2].includes(manifest.state.version)
    || manifest.state.status !== 'supported' && (manifest.state.version !== null || manifest.state.revision !== null)) fail('Checkpoint state metadata is invalid.');
  if (!Array.isArray(manifest.roots) || manifest.roots.length !== expected.length || manifest.roots.some((row, i) => !plain(row) || row.path !== expected[i] || typeof row.present !== 'boolean' || row.role !== (i === expected.length - 1 ? 'service-evidence' : 'application-state'))
    || manifest.roots[0].present !== (manifest.state.status !== 'missing')) fail('Checkpoint roots are incomplete or invalid.');
  if (!Array.isArray(manifest.entries) || manifest.entries.length > p.limits.maxEntries) fail('Checkpoint entry count is invalid.', 'checkpoint_limit');
  const names = new Set(), types = new Map(); let bytes = 0;
  for (const entry of manifest.entries) {
    p.check();
    if (!plain(entry) || !safeRelative(entry.path) || names.has(entry.path) || !expected.includes(entry.path.split('/')[0]) || entry.path.split('/').length > p.limits.maxDepth + 1) fail('Checkpoint entry path is invalid.', 'checkpoint_unsafe_path');
    names.add(entry.path); types.set(entry.path, entry.type);
    if (entry.type === 'file') {
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > p.limits.maxFileBytes || ![0o600, 0o700].includes(entry.mode) || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) fail('Checkpoint file metadata is invalid.');
      if (['.secrets', '.subscriptions'].some(suffix => entry.path === `${manifest.stateFileName}${suffix}`) && entry.mode !== 0o600) fail('Secret file permissions are invalid.');
      bytes += entry.bytes;
    } else if (entry.type === 'directory') { if (entry.mode !== 0o700) fail('Checkpoint directory permissions are invalid.'); }
    else if (entry.type === 'symlink') {
      const root = entry.path.split('/')[0], absoluteRoot = join('/', root), path = resolve('/', dirname(entry.path), entry.target ?? '');
      if (typeof entry.target !== 'string' || !entry.target || Buffer.byteLength(entry.target) > 4096 || /[\x00-\x1f\x7f\\]/.test(entry.target) || isAbsolute(entry.target) || !inside(absoluteRoot, path) || entry.path === root) fail('Checkpoint symlink is unsafe.', 'checkpoint_unsafe_path');
    } else fail('Checkpoint entry type is invalid.');
  }
  for (const entry of manifest.entries) { const parent = dirname(entry.path); if (parent !== '.' && types.get(parent) !== 'directory') fail('Checkpoint file parent is missing or is a symlink.', 'checkpoint_unsafe_path'); }
  for (const root of manifest.roots) if (root.present !== names.has(root.path)) fail('Checkpoint root presence does not match the payload.');
  for (let index = 0; index < manifest.roots.length; index++) {
    const root = manifest.roots[index]; if (!root.present) continue;
    const fileRoot = index === 0 || ['.secrets', '.subscriptions'].some(suffix => root.path === `${manifest.stateFileName}${suffix}`);
    if (types.get(root.path) !== (fileRoot ? 'file' : 'directory')) fail('Checkpoint owned root has an unsupported file type.', 'checkpoint_unsafe_path');
  }
  const serviceRoot = `${manifest.stateFileName}.service`;
  for (const entry of manifest.entries) if (entry.path.startsWith(`${serviceRoot}/`) && (entry.type !== 'file' || !serviceEvidence(entry.path.slice(serviceRoot.length + 1)) || entry.bytes > 2 * 1024 ** 2)) fail('Checkpoint contains unsupported service evidence.', 'checkpoint_unsafe_path');
  if (types.get(manifest.stateFileName) !== (manifest.state.status === 'missing' ? undefined : 'file') || bytes !== manifest.totalBytes || bytes > p.limits.maxBytes) fail('Checkpoint total size is invalid.', 'checkpoint_limit');
}
export async function verifyStateCheckpoint({ directory, limits, signal } = {}) {
  const p = policy(limits, signal), root = await safeDirectory(resolve(directory ?? ''));
  if (!same((await readdir(root)).sort(), ['manifest.json', 'manifest.sha256', 'payload'])) fail('Checkpoint contains unexpected top-level files.');
  const file = join(root, 'manifest.json'), info = await lstat(file), digestInfo = await lstat(join(root, 'manifest.sha256'));
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > p.limits.maxManifestBytes || !digestInfo.isFile() || digestInfo.isSymbolicLink() || digestInfo.nlink !== 1 || digestInfo.size !== 65) fail('Checkpoint manifest is not a bounded ordinary file.');
  if (info.mode & 0o077 || digestInfo.mode & 0o077 || (await lstat(root)).mode & 0o077) fail('Checkpoint metadata permissions are not private.', 'checkpoint_unsafe_permissions');
  const content = await readFile(file), expectedHash = await readFile(join(root, 'manifest.sha256'), 'utf8');
  if (!/^[a-f0-9]{64}\n$/.test(expectedHash) || hash(content) !== expectedHash.trim()) fail('Checkpoint manifest hash mismatch.', 'checkpoint_hash_mismatch');
  let manifest; try { manifest = JSON.parse(content); } catch { fail('Checkpoint manifest is invalid JSON.'); }
  validateManifest(manifest, p);
  const payload = await safeDirectory(join(root, 'payload'));
  if ((await lstat(payload)).mode & 0o077) fail('Checkpoint payload permissions are not private.', 'checkpoint_unsafe_permissions');
  const actual = await inventory(payload, manifest.roots.map(row => row.path), p, { privatePermissions: true });
  if ((await readdir(payload)).some(name => !manifest.roots.some(row => row.path === name && row.present))) fail('Checkpoint payload contains unknown roots.');
  const stripHash = entry => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'sha256'));
  if (!same(actual.entries, manifest.entries.map(stripHash)) || !same(actual.roots, manifest.roots.map(({ path, present }) => ({ path, present })))) fail('Checkpoint payload inventory mismatch.', 'checkpoint_hash_mismatch');
  for (const entry of manifest.entries) if (entry.type === 'file' && await fileBytes(join(payload, entry.path), p, { expectedBytes: entry.bytes }) !== entry.sha256) fail('Checkpoint content hash mismatch.', 'checkpoint_hash_mismatch');
  if (manifest.state.status === 'supported') {
    const actualState = await stateVersion(join(payload, manifest.stateFileName), p);
    if (!same(actualState, manifest.state)) fail('Checkpoint state metadata does not match its payload.', 'checkpoint_invalid_state');
  }
  return { directory: root, id: manifest.id, manifestHash: hash(content), files: manifest.entries.filter(row => row.type === 'file').length, bytes: manifest.totalBytes, manifest };
}

/** Restore bytes to an unused directory for inspection. It is not a relocated
 * runnable installation: immutable records intentionally retain original paths. */
export async function restoreStateCheckpoint({ directory, destination, limits, signal } = {}) {
  const checked = await verifyStateCheckpoint({ directory, limits, signal }), p = policy(limits, signal);
  if (checked.manifest.state.status !== 'supported') fail('This is a raw recovery preimage, not a supported state to restore.', 'checkpoint_not_restorable');
  destination = await newDestination(destination, [checked.directory]);
  const staging = join(dirname(destination), `.${basename(destination)}.pending-${randomUUID()}`); let committed = false;
  await mkdir(staging, { mode: 0o700 });
  try {
    const app = checked.manifest.entries.filter(entry => !entry.path.startsWith(`${checked.manifest.stateFileName}.service`));
    await copyEntries(join(checked.directory, 'payload'), staging, clone(app), p, { verifyHashes: true });
    atomicWrite(join(staging, 'restoration.json'), JSON.stringify({ schemaVersion: 1, checkpointId: checked.id, manifestHash: checked.manifestHash, sourceStateFile: checked.manifest.sourceStateFile, stateFileName: checked.manifest.stateFileName, stagingOnly: true, absolutePathsPreserved: true, externalEffectsReviewRequired: true, remoteMemoryRestored: false, projectFilesRestored: false, serviceConfigurationRestored: false }));
    if (await present(destination)) fail('Restore destination appeared during copy.', 'checkpoint_destination_exists');
    await rename(staging, destination); committed = true; syncDirectory(dirname(destination));
    return { directory: destination, stateFile: join(destination, checked.manifest.stateFileName), checkpointId: checked.id, stagingOnly: true, externalEffectsReviewRequired: true };
  } finally { if (!committed) await rm(staging, { recursive: true, force: true }); }
}

const markerPath = stateFile => `${stateFile}.recovery.json`;
async function readRecovery(stateFile) {
  const file = markerPath(stateFile), info = await present(file); if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) fail('Recovery marker cannot be trusted; startup is blocked.', 'recovery_marker_invalid');
  let marker; try { marker = JSON.parse(await readFile(file, 'utf8')); } catch { fail('Recovery marker is unreadable; startup is blocked.', 'recovery_marker_invalid'); }
  if (!plain(marker) || marker.version !== 1 || marker.format !== 'rna-state-recovery' || marker.stateFile !== stateFile || !/^[a-f0-9-]{36}$/.test(marker.id ?? '') || !['prepared', 'replacing', 'completed'].includes(marker.phase) || !/^[a-f0-9]{64}$/.test(marker.manifestHash ?? '')) fail('Recovery marker is invalid; startup is blocked.', 'recovery_marker_invalid');
  const expected = join(`${stateFile}.recovery`, marker.id);
  if (marker.transactionDirectory !== expected || marker.beforeCheckpoint !== join(expected, 'before') || typeof marker.checkpointDirectory !== 'string' || !isAbsolute(marker.checkpointDirectory)
    || !Array.isArray(marker.operations) || !sidecarGeneration(marker.operations.length) || marker.operations.some((row, i) => !plain(row) || row.path !== `${basename(stateFile)}${CHECKPOINT_SIDECARS[i]}` || !['pending', 'quarantined', 'applied'].includes(row.status) || ![row.before, row.desired].every(value => value === null || /^[a-f0-9]{64}$/.test(value ?? '')))) fail('Recovery operation inventory is invalid; startup is blocked.', 'recovery_marker_invalid');
  return marker;
}
export async function recoveryPending(stateFile) {
  stateFile = await canonicalStateFile(stateFile);
  const marker = await readRecovery(stateFile); return marker?.phase !== 'completed' ? marker : null;
}
/** Shared pre-start barrier. A copied stage retains absolute references and is
 * intentionally non-runnable. Check only this state directory, never ancestors.
 * Completed original recovery still requires the caller's maintenance hold and
 * external-effects review; absence of a pending marker does not release that. */
export async function assertStateRecoveryReady(stateFile) {
  stateFile = await canonicalStateFile(stateFile);
  if (await recoveryPending(stateFile)) fail('State recovery is incomplete. Resume the same checkpoint before starting.', 'recovery_pending');
  const file = join(dirname(stateFile), 'restoration.json'), info = await present(file);
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65536) fail('Staging marker is unsafe; startup is blocked.', 'recovery_marker_invalid');
  let marker; try { marker = JSON.parse(await readFile(file, 'utf8')); } catch { fail('Staging marker is unreadable; startup is blocked.', 'recovery_marker_invalid'); }
  if (!plain(marker) || marker.schemaVersion !== 1 || marker.stagingOnly !== true || !isAbsolute(marker.sourceStateFile ?? '') || marker.stateFileName !== undefined && !validName(marker.stateFileName)) fail('Staging marker is invalid; startup is blocked.', 'recovery_marker_invalid');
  const name = marker.stateFileName ?? basename(marker.sourceStateFile);
  if (name === basename(stateFile)) fail('This directory is an inspection-only recovery stage. Restore to the original binding before starting.', 'checkpoint_staging_only');
}
async function rootDigest(parent, name, p) {
  const seen = await inventory(parent, [name], p, { excludeRuntime: true }); if (!seen.roots[0].present) return null;
  for (const entry of seen.entries) if (entry.type === 'file') entry.sha256 = await fileBytes(join(parent, entry.path), p, { expectedBytes: entry.bytes });
  return hash(JSON.stringify(seen.entries));
}
function writeRecovery(stateFile, marker) { atomicWrite(markerPath(stateFile), `${JSON.stringify(marker)}\n`); }

/** Explicit offline recovery to the original binding. This restores local
 * history, not external effects. The final state is always emergency-paused.
 * Every old root remains in quarantine and a verified pre-recovery checkpoint.
 * A crash leaves a marker that MUST block all daemon startup until resumed. */
export async function restoreStateCheckpointOriginal(options) {
  return owned(options, async (stateFile, lease) => {
    const checked = await verifyStateCheckpoint({ directory: options.directory, limits: options.limits, signal: options.signal });
    if (checked.manifest.state.status !== 'supported') fail('This is a raw recovery preimage, not a supported state to restore.', 'checkpoint_not_restorable');
    if (checked.manifest.sourceStateFile !== stateFile) fail('Original restore requires the exact original state-file binding.', 'recovery_binding_mismatch');
    const p = policy(options.limits, options.signal), parent = dirname(stateFile), recovery = `${stateFile}.recovery`;
    if (!await present(recovery)) await mkdir(recovery, { mode: 0o700 });
    await safeDirectory(recovery);
    let marker = await readRecovery(stateFile);
    if (marker?.phase === 'completed' && marker.manifestHash === checked.manifestHash) {
      let unchanged = true;
      for (const row of marker.operations) if (await rootDigest(parent, row.path, p) !== row.desired) { unchanged = false; break; }
      if (unchanged) return { ...clone(marker), alreadyCompleted: true, emergency: true };
    }
    if (marker && marker.phase !== 'completed' && marker.manifestHash !== checked.manifestHash) fail('Another recovery is incomplete; resume its exact checkpoint first.', 'recovery_conflict');
    if (!marker || marker.phase === 'completed') {
      const id = randomUUID(), transactionDirectory = join(recovery, id); await mkdir(transactionDirectory, { mode: 0o700 });
      const before = await createStateCheckpoint({ ...options, stateFile, lease, destination: join(transactionDirectory, 'before'), [RECOVERY_PREIMAGE]: true });
      await restoreStateCheckpoint({ directory: checked.directory, destination: join(transactionDirectory, 'staging'), limits: options.limits, signal: options.signal });
      const staging = join(transactionDirectory, 'staging'), { state } = readStateFile(join(staging, basename(stateFile)));
      state.emergency = true; if (Number.isSafeInteger(state.revision)) state.revision++;
      // Staging is private and offline: commit a sharded generation and drop
      // nodes it no longer references before digests are recorded.
      writeStateFile(join(staging, basename(stateFile)), state, { sweep: true });
      await mkdir(join(transactionDirectory, 'quarantine'), { mode: 0o700 });
      marker = { format: 'rna-state-recovery', version: 1, id, stateFile, checkpointId: checked.id, manifestHash: checked.manifestHash, checkpointDirectory: checked.directory,
        transactionDirectory, beforeCheckpoint: before.directory, beforeCheckpointId: before.id, createdAt: new Date().toISOString(), phase: 'prepared', emergency: true,
        externalEffectsReviewRequired: true, remoteMemoryRestored: false, projectFilesRestored: false, serviceConfigurationRestored: false, operations: [] };
      for (const path of rootNames(basename(stateFile))) {
        const saved = before.manifest.entries.filter(entry => entry.path === path || entry.path.startsWith(`${path}/`));
        const fingerprint = saved.length ? hash(JSON.stringify(saved)) : null;
        if (await rootDigest(parent, path, p) !== fingerprint) fail('State changed after its pre-recovery checkpoint.', 'checkpoint_changed');
        marker.operations.push({ path, before: fingerprint, desired: await rootDigest(staging, path, p), status: 'pending' });
      }
      // Only after both verified copies are durable can replacement begin.
      writeRecovery(stateFile, marker);
    }
    assertLease(lease, stateFile);
    const transaction = await safeDirectory(marker.transactionDirectory), staging = await safeDirectory(join(transaction, 'staging')), quarantine = await safeDirectory(join(transaction, 'quarantine'));
    const before = await verifyStateCheckpoint({ directory: marker.beforeCheckpoint, limits: options.limits, signal: options.signal });
    if (before.id !== marker.beforeCheckpointId || before.manifest.sourceStateFile !== stateFile) fail('Pre-recovery checkpoint identity changed.', 'recovery_conflict');
    marker.phase = 'replacing'; writeRecovery(stateFile, marker);
    for (const row of marker.operations) {
      p.check(); assertLease(lease, stateFile);
      const current = await rootDigest(parent, row.path, p), held = await rootDigest(quarantine, row.path, p);
      if (current === row.desired && (row.before === null || held === row.before || row.before === row.desired)) { row.status = 'applied'; writeRecovery(stateFile, marker); continue; }
      if (row.before !== null) {
        if (held !== null && held !== row.before) fail('Recovery quarantine changed; manual inspection is required.', 'recovery_conflict');
        if (held === null) {
          if (current !== row.before) fail('Current state changed since the recovery checkpoint.', 'recovery_conflict');
          await rename(join(parent, row.path), join(quarantine, row.path)); syncDirectory(parent); syncDirectory(quarantine);
        } else if (current !== null) fail('Unexpected state appeared during recovery.', 'recovery_conflict');
      } else if (current !== null) fail('Unexpected state appeared during recovery.', 'recovery_conflict');
      row.status = 'quarantined'; writeRecovery(stateFile, marker);
      if (row.desired !== null) {
        if (await rootDigest(staging, row.path, p) !== row.desired || await present(join(parent, row.path))) fail('Staged recovery content changed.', 'recovery_conflict');
        await rename(join(staging, row.path), join(parent, row.path)); syncDirectory(staging); syncDirectory(parent);
      }
      if (await rootDigest(parent, row.path, p) !== row.desired) fail('Restored content verification failed.', 'recovery_conflict');
      row.status = 'applied'; writeRecovery(stateFile, marker);
    }
    for (const row of marker.operations) if (await rootDigest(parent, row.path, p) !== row.desired) fail('Restored content changed before completion.', 'recovery_conflict');
    marker.phase = 'completed'; marker.completedAt = new Date().toISOString(); writeRecovery(stateFile, marker);
    return clone(marker);
  });
}
