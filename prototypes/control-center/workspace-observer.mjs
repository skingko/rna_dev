import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const VERSION = 1;
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const copy = value => structuredClone(value);
const ignoredDirectories = new Set(['.git', '.hg', '.svn', 'node_modules', '.state', '.runtime', '.rna', '.rna-agent', '.ssh', '.aws', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.cache', '.turbo', '.venv', 'venv', '__pycache__', 'target']);
const ignoredFiles = /^(?:\.DS_Store|\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.secrets(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\.json|\.ya?ml|\.toml|\.txt)?|(?:auth|tokens?|api[-_]?keys?|passwords?)\.(?:json|ya?ml|toml|txt)|id_(?:rsa|ed25519)(?:\.pub)?)$|\.(?:pem|key|p12|pfx|keystore|secrets|log|tmp|swp|swo)$/i;
const defaults = Object.freeze({ maxEntries: 6000, maxFiles: 2000, maxDepth: 16, maxDurationMs: 1500, maxSnapshotBytes: 512 * 1024, contentHashMaxFileBytes: 0, contentHashTotalBytes: 2 * 1024 * 1024 });
const activeWorkers = new Map();

function bounded(value, fallback, min, max) { return Number.isSafeInteger(value) ? Math.min(max, Math.max(min, value)) : fallback; }
function limitsFor(input = {}) {
  return { maxEntries: bounded(input.maxEntries, defaults.maxEntries, 1, 50000), maxFiles: bounded(input.maxFiles, defaults.maxFiles, 1, 10000), maxDepth: bounded(input.maxDepth, defaults.maxDepth, 0, 64), maxDurationMs: bounded(input.maxDurationMs, defaults.maxDurationMs, 10, 30000), maxSnapshotBytes: bounded(input.maxSnapshotBytes, defaults.maxSnapshotBytes, 128, 2 * 1024 * 1024), contentHashMaxFileBytes: bounded(input.contentHashMaxFileBytes, 0, 0, 1024 * 1024), contentHashTotalBytes: bounded(input.contentHashTotalBytes, defaults.contentHashTotalBytes, 0, 16 * 1024 * 1024) };
}
function inside(root, path) { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
function safeRelative(path) { return typeof path === 'string' && path.length > 0 && path.length <= 1024 && !isAbsolute(path) && !path.includes('\\') && !/[\x00-\x1f\x7f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..'); }
function ignored(path) { const parts = path.split('/'); return parts.some(part => ignoredDirectories.has(part) || ignoredFiles.test(part)); }
function exclusionsFor(input = []) {
  if (!Array.isArray(input) || input.length > 64) throw new TypeError('Workspace exclusions must contain at most 64 relative paths.');
  const paths = input.map(path => typeof path === 'string' ? path.replace(/\/$/, '') : path);
  if (paths.some(path => !safeRelative(path)) || Buffer.byteLength(JSON.stringify(paths)) > 8192) throw new TypeError('Workspace exclusions must be bounded paths within the project.');
  return [...new Set(paths)].sort();
}
const excluded = (path, paths) => paths.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
function identity(canonical, stat) { return hash([canonical, String(stat.dev), String(stat.ino)]); }
/** A file's scan fingerprint (bigint stats): its metadata, or its content when the limits hash files of its size. */
const metadataFingerprint = stat => hash(['metadata', String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs), String(stat.mode)]);
const contentFingerprint = (data, stat) => hash(['content', hash(data), String(stat.mode)]);
function baseResult(status, reason = null) { return { schemaVersion: VERSION, status, reason, rootIdentity: null, entries: [], coverage: { visited: 0, files: 0, ignored: 0, symlinks: 0, contentBytes: 0 } }; }

/** Filesystem work runs only in a disposable child. */
async function scanInWorker({ root, expectedRootIdentity, limits: configured, excludePaths = [] }) {
  const limits = limitsFor(configured), result = baseResult('complete'), startedAt = performance.now();
  let snapshotBytes = 0;
  const incomplete = reason => { result.status = 'incomplete'; result.reason ??= reason; };
  const timeLeft = () => { if (performance.now() - startedAt > limits.maxDurationMs) incomplete('time_limit'); return result.status === 'complete'; };
  try {
    const requested = resolve(root), rootStat = await lstat(requested, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { ...result, status: 'unavailable', reason: 'root_not_directory' };
    const canonical = await realpath(requested);
    result.rootIdentity = identity(canonical, rootStat);
    if (expectedRootIdentity && expectedRootIdentity !== result.rootIdentity) return { ...result, status: 'root_replaced', reason: 'root_identity_changed' };
    // Never follow a nested symlink. Recheck canonical containment before opening
    // each directory and file; optional reads additionally pin the opened inode.
    const visit = async (directory, rel, depth) => {
      if (!timeLeft()) return;
      if (!inside(canonical, await realpath(directory))) { incomplete('path_changed'); return; }
      const before = await lstat(directory, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) { incomplete('path_changed'); return; }
      const handle = await opendir(directory);
      try {
        for await (const item of handle) {
          if (!timeLeft()) break;
          if (++result.coverage.visited > limits.maxEntries) { incomplete('entry_limit'); break; }
          const path = rel ? `${rel}/${item.name}` : item.name;
          if (!safeRelative(path)) { result.coverage.ignored++; continue; }
          if (ignored(path) || excluded(path, excludePaths)) { result.coverage.ignored++; continue; }
          const absolute = join(directory, item.name), stat = await lstat(absolute, { bigint: true });
          if (stat.isSymbolicLink()) { result.coverage.symlinks++; continue; }
          if (stat.isDirectory()) {
            if (depth >= limits.maxDepth) { incomplete('depth_limit'); break; }
            await visit(absolute, path, depth + 1);
            if (result.status !== 'complete') break;
            continue;
          }
          if (!stat.isFile()) { result.coverage.ignored++; continue; }
          if (result.coverage.files >= limits.maxFiles) { incomplete('file_limit'); break; }
          if (!inside(canonical, await realpath(absolute))) { incomplete('path_changed'); break; }
          let fingerprint = metadataFingerprint(stat), method = 'metadata';
          if (limits.contentHashMaxFileBytes > 0 && stat.size <= BigInt(limits.contentHashMaxFileBytes)) {
            if (result.coverage.contentBytes + Number(stat.size) > limits.contentHashTotalBytes) { incomplete('content_limit'); break; }
            const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const pinned = await file.stat({ bigint: true });
              if (!pinned.isFile() || pinned.ino !== stat.ino || pinned.dev !== stat.dev || !inside(canonical, await realpath(absolute))) { incomplete('path_changed'); break; }
              const data = Buffer.alloc(Number(stat.size));
              let offset = 0;
              while (offset < data.length && timeLeft()) { const read = await file.read(data, offset, data.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
              const after = await file.stat({ bigint: true });
              if (offset !== data.length || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) { incomplete('file_changed_during_scan'); break; }
              fingerprint = contentFingerprint(data, stat); method = 'content'; result.coverage.contentBytes += data.length;
            } finally { await file.close(); }
          }
          const entry = { path, fingerprint, method, size: Number(stat.size) };
          snapshotBytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
          if (snapshotBytes > limits.maxSnapshotBytes) { incomplete('snapshot_limit'); break; }
          result.entries.push(entry); result.coverage.files++;
        }
      } finally { await handle.close().catch(() => {}); }
      const after = await lstat(directory, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || !inside(canonical, await realpath(directory))) incomplete('path_changed');
    };
    await visit(requested, '', 0);
    const finalRoot = await lstat(requested, { bigint: true });
    if (finalRoot.isSymbolicLink() || identity(await realpath(requested), finalRoot) !== result.rootIdentity) return { ...result, status: 'root_replaced', reason: 'root_identity_changed', entries: [] };
    result.entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    return result.status === 'complete' ? result : { ...result, entries: [] };
  } catch (error) {
    return { ...result, entries: [], status: result.rootIdentity ? 'incomplete' : 'unavailable', reason: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'not_found' : ['EACCES', 'EPERM'].includes(error.code) ? 'permission_denied' : 'filesystem_error' };
  }
}

/** Hard process deadline and cancellation contain even a stuck filesystem call.
 * No file body, absolute path, or raw filesystem error appears in the result. */
export async function scanWorkspace({ root, expectedRootIdentity, signal, limits: configured, excludePaths: exclusions } = {}) {
  if (typeof root !== 'string' || !root) return baseResult('unavailable', 'root_missing');
  if (signal?.aborted) return baseResult('cancelled', 'cancelled');
  let excludePaths;
  try { excludePaths = exclusionsFor(exclusions); } catch { return baseResult('unavailable', 'invalid_exclusions'); }
  const limits = limitsFor(configured), workerKey = resolve(root);
  if (activeWorkers.has(workerKey)) return baseResult('unavailable', 'worker_still_running');
  return new Promise(resolveResult => {
    let child, settled = false, outcome = null, exitTimer, exited = false;
    const settle = result => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(exitTimer); signal?.removeEventListener('abort', abort); resolveResult(result); };
    const finish = result => {
      if (outcome) return;
      outcome = result; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (!child || exited) { activeWorkers.delete(workerKey); settle(result); return; }
      child.kill('SIGKILL');
      // If a kernel filesystem operation delays process teardown, leave the
      // root registered until its actual exit. A later poll cannot spawn more.
      exitTimer = setTimeout(() => {
        // Do not let an uninterruptible child keep host shutdown alive; retain
        // the root lock and exit listener for the remainder of this host life.
        child.unref(); child.channel?.unref();
        settle({ ...result, status: 'unavailable', reason: 'worker_unreaped' });
      }, 1000);
    };
    const abort = () => finish(baseResult('cancelled', 'cancelled'));
    const timer = setTimeout(() => finish(baseResult('incomplete', 'worker_timeout')), limits.maxDurationMs + 1500);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      // The scanner needs no provider keys, inherited preloads, or shell config.
      child = fork(SELF, ['--workspace-observer-worker'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: ['--max-old-space-size=64'], env: Object.fromEntries(['PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) });
      activeWorkers.set(workerKey, child);
      child.once('error', () => { if (!child.pid) exited = true; finish(baseResult('unavailable', 'worker_failed')); });
      child.once('exit', () => { exited = true; activeWorkers.delete(workerKey); settle(outcome ?? baseResult('unavailable', 'worker_exited')); });
      child.once('message', result => finish(result && result.schemaVersion === VERSION ? result : baseResult('unavailable', 'worker_invalid')));
      child.send({ root, expectedRootIdentity, limits, excludePaths }, error => { if (error) finish(baseResult('unavailable', 'worker_failed')); });
      if (signal?.aborted) abort();
    } catch { finish(baseResult('unavailable', 'worker_failed')); }
  });
}

/**
 * The scan fingerprint each of `paths` (relative to `root`) has now, or null where a scan holds no entry for it (absent,
 * not a regular file, a link): for a writer that knows which files it just wrote (a user's undo, see
 * ProjectObservationService.undoWrite), so a later scan that finds the same fingerprint finds that write and nothing
 * newer. Paths a scan never covers (unsafe, ignored) and paths that cannot be read now are left out.
 * @param {{ root: string, paths: string[], limits?: object }} options  `limits` as the observer's (content hashing)
 * @returns {Promise<Map<string, string|null>>}
 */
export async function fingerprintPaths({ root, paths = [], limits: configured } = {}) {
  const limits = limitsFor(configured), prints = new Map();
  if (typeof root !== 'string' || !root) return prints;
  for (const path of new Set(paths)) {
    if (!safeRelative(path) || ignored(path)) continue;
    try {
      const absolute = join(root, path), stat = await lstat(absolute, { bigint: true });
      if (!stat.isFile()) { prints.set(path, null); continue; }
      if (limits.contentHashMaxFileBytes > 0 && stat.size <= BigInt(limits.contentHashMaxFileBytes)) {
        const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { prints.set(path, contentFingerprint(await file.readFile(), stat)); } finally { await file.close(); }
      } else prints.set(path, metadataFingerprint(stat));
    } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error?.code)) prints.set(path, null); }
  }
  return prints;
}

function validCheckpoint(value, policyHash, excludePaths) {
  if (!value || value.schemaVersion !== VERSION || value.policyHash !== policyHash || !/^[a-f0-9]{64}$/.test(value.rootIdentity ?? '') || !Array.isArray(value.entries) || value.entries.length > 10000) return null;
  const paths = new Set();
  for (const entry of value.entries) {
    if (!safeRelative(entry.path) || ignored(entry.path) || excluded(entry.path, excludePaths) || paths.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.fingerprint ?? '') || !['metadata', 'content'].includes(entry.method) || !Number.isSafeInteger(entry.size) || entry.size < 0) return null;
    paths.add(entry.path);
  }
  const pending = value.pending && /^[a-f0-9]{64}$/.test(value.pending.batchId ?? '') && Number.isFinite(value.pending.firstSeenAt) && Array.isArray(value.pending.paths) && value.pending.paths.length <= 20000 && value.pending.paths.every(safeRelative) ? { batchId: value.pending.batchId, firstSeenAt: value.pending.firstSeenAt, paths: [...value.pending.paths] } : null;
  return { schemaVersion: VERSION, policyHash, rootIdentity: value.rootIdentity, entries: value.entries.map(({ path, fingerprint, method, size }) => ({ path, fingerprint, method, size })), lastBatchId: /^[a-f0-9]{64}$/.test(value.lastBatchId ?? '') ? value.lastBatchId : null, pending };
}

/** The caller persists checkpoint and observation in the SAME durable mutation.
 * A replay after a failed commit has the same deterministic batch id. */
export function createWorkspaceObserver({ root, checkpoint, now = Date.now, settleMs = 1000, limits: configured, excludePaths: exclusions } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('A workspace root is required.');
  const limits = limitsFor(configured), excludePaths = exclusionsFor(exclusions), policyHash = hash([VERSION, resolve(root), limits, ...(excludePaths.length ? [{ excludePaths }] : [])]);
  const lifecycle = new AbortController();
  let state = validCheckpoint(checkpoint, policyHash, excludePaths), proposed = null, inFlight = null, closed = false;
  const snapshot = () => state ? copy(state) : null;
  const poll = ({ signal, acknowledgeOnly = false, suppressPaths = [] } = {}) => {
    if (closed) return Promise.resolve({ ...baseResult('cancelled', 'closed'), changes: [], checkpoint: snapshot() });
    if (inFlight) return inFlight;
    if (proposed) return Promise.resolve({ ...baseResult('unavailable', 'checkpoint_not_committed'), changes: [], checkpoint: copy(proposed) });
    const operationSignal = signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal;
    inFlight = (async () => {
      const scan = await scanWorkspace({ root, expectedRootIdentity: state?.rootIdentity, signal: operationSignal, limits, excludePaths });
      const result = { ...scan, entries: undefined, changes: [], batchId: null, suppressed: 0, ownWrites: 0, checkpoint: snapshot() };
      const propose = value => { proposed = copy(value); return copy(value); };
      if (closed || operationSignal.aborted) return { ...result, status: 'cancelled', reason: 'cancelled' };
      if (scan.status !== 'complete') return result;
      if (!state) {
        return { ...result, status: 'baseline', checkpoint: propose({ schemaVersion: VERSION, policyHash, rootIdentity: scan.rootIdentity, entries: scan.entries, lastBatchId: null, pending: null }) };
      }
      const next = copy(state), pending = state.pending;
      const before = new Map(state.entries.map(entry => [entry.path, entry])), after = new Map(scan.entries.map(entry => [entry.path, entry]));
      // A plain path is folded into the baseline whatever it holds now (counted in `suppressed`); { path, fingerprint }
      // only while it holds exactly that (null: no file), so a later write by anyone else to the same path is still a
      // change (a known write, counted in `ownWrites`, not a mixed-origin one).
      const suppressed = new Map(suppressPaths.flatMap(row => (typeof row === 'string' ? [[row, undefined]] : typeof row?.path === 'string' && (typeof row.fingerprint === 'string' || row.fingerprint === null) ? [[row.path, row.fingerprint]] : [])).filter(([path]) => safeRelative(path)));
      const quiet = (path, entry) => suppressed.has(path) && (suppressed.get(path) === undefined || suppressed.get(path) === (entry?.fingerprint ?? null));
      const pendingPaths = new Set(pending?.paths ?? []);
      const changes = [];
      for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
        const a = before.get(path), b = after.get(path);
        if (a?.fingerprint === b?.fingerprint) continue;
        if (!pendingPaths.has(path) && (acknowledgeOnly || quiet(path, b))) { if (b) before.set(path, b); else before.delete(path); if (acknowledgeOnly || suppressed.get(path) === undefined) result.suppressed++; else result.ownWrites++; continue; }
        changes.push({ path, kind: !a ? 'created' : !b ? 'deleted' : 'modified', before: a?.fingerprint ?? null, after: b?.fingerprint ?? null });
      }
      next.entries = [...before.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
      if (!changes.length) { next.pending = null; return { ...result, status: result.suppressed || result.ownWrites ? 'acknowledged' : 'unchanged', checkpoint: propose(next) }; }
      const batchId = hash([scan.rootIdentity, changes]), at = now();
      if (!pending || pending.batchId !== batchId || at < pending.firstSeenAt) { next.pending = { batchId, firstSeenAt: at, paths: changes.map(change => change.path) }; return { ...result, status: 'settling', checkpoint: propose(next) }; }
      if (acknowledgeOnly || at - pending.firstSeenAt < Math.max(0, settleMs)) return { ...result, status: 'settling', checkpoint: propose(next) };
      next.entries = scan.entries; next.lastBatchId = batchId; next.pending = null;
      return { ...result, status: 'changed', batchId, changes, checkpoint: propose(next) };
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
  return { poll, checkpoint: snapshot,
    commit(checkpoint) {
      if (closed || !proposed || hash(checkpoint) !== hash(proposed)) throw new Error('Workspace observer checkpoint is not the pending proposal.');
      state = proposed; proposed = null; return snapshot();
    },
    close() { closed = true; proposed = null; lifecycle.abort(); return inFlight ?? Promise.resolve(); }
  };
}

if (process.argv[1] === SELF && process.argv[2] === '--workspace-observer-worker') {
  process.once('message', async input => { const result = await scanInWorker(input); process.send?.(result, () => process.exit(0)); });
}
