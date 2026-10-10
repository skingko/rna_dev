import { closeSync, chmodSync, constants, existsSync, fsyncSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export class JournalError extends Error {
  constructor(message, code) { super(message); this.name = 'JournalError'; this.code = code; }
}

export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJSON(item) ?? 'null').join(',')}]`;
  return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
}
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : canonicalJSON(value)).digest('hex');
const within = (root, path) => { const rel = relative(root, path); return !rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };

// Stream/UI events are replayable telemetry. Their bounded buffer is written in
// order but need not force stable storage at each token. Every canonical record
// is still an fsync-before-publish barrier for itself AND all preceding events.
const EVENT_BUFFER_BYTES = 64 * 1024, EVENT_BUFFER_ROWS = 128;
// Stream deltas are journaled as segments of at most this span/size (see
// session.mjs; journal-compaction.mjs applies the same to older journals).
export const STREAM_SEGMENT_MS = 250, STREAM_SEGMENT_CHARS = 32 * 1024;
const READ_BUFFER_BYTES = 64 * 1024;

// Only a chunk and the current record may remain resident. A journal can hold
// years of stream telemetry; reading it must not allocate one string/array for
// the entire file before the session discards those events.
// `bytes` (optional hash) receives every file byte read, for checkpoint segments.
function* lines(fd, end, suffix = [], start = 0, raw = false, bytes = null) {
  function* chunks() {
    for (let offset = start; offset < end;) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_BUFFER_BYTES, end - offset));
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      if (!count) throw new JournalError('Journal changed while reading.', 'journal_corrupt');
      offset += count; bytes?.update(buffer.subarray(0, count)); yield buffer.subarray(0, count);
    }
    yield* suffix;
  }
  let parts = [], length = 0;
  for (const chunk of chunks()) {
    let start = 0;
    for (let boundary; (boundary = chunk.indexOf(10, start)) !== -1;) {
      const part = chunk.subarray(start, boundary);
      const line = parts.length ? Buffer.concat([...parts, part], length + part.length) : part;
      parts = []; length = 0;
      if (line.length) yield raw ? line : line.toString('utf8');
      start = boundary + 1;
    }
    if (start < chunk.length) { const part = chunk.subarray(start); parts.push(part); length += part.length; }
  }
  if (length) throw new JournalError('Journal has an incomplete committed record.', 'journal_corrupt');
}

function* verifiedRecords(fd, end, suffix, { start = 0, sequence = 0, previous = null, bytes = null } = {}) {
  for (const line of lines(fd, end, suffix, start, false, bytes)) {
    let record;
    try { record = JSON.parse(line); } catch { throw new JournalError(`Invalid committed journal record ${sequence + 1}.`, 'journal_corrupt'); }
    const { hash, ...body } = record;
    if (body.seq !== sequence + 1 || body.prevHash !== previous || hash !== digest(body)) throw new JournalError(`Journal chain mismatch at record ${sequence + 1}.`, 'journal_corrupt');
    sequence++; previous = hash; yield record;
  }
}

// Replay of an already verified log: canonical records are parsed; telemetry
// events are skipped by their fixed record head unless the caller needs them
// (an interrupted stream). Sequence continuity and the final hash still bind
// the pass to the verified chain. Lines with an unexpected head are parsed.
const SEQ_HEAD = Buffer.from('{"seq":'), EVENT_TYPE = Buffer.from('","type":"event","'), HASH_TAIL = Buffer.from(',"hash":"'), HEX = /^[0-9a-f]{64}$/;
// Record lines are JSON.stringify({seq, prevHash, time, type, data, hash}); no
// earlier field can contain `","type":"`, so its first occurrence is the type.
const skippableEvent = (line, sequence) => {
  if (line.length < 180 || !line.subarray(0, SEQ_HEAD.length).equals(SEQ_HEAD)) return null;
  const at = line.subarray(0, 220).indexOf(EVENT_TYPE), digits = String(sequence);
  if (at < 0 || line.toString('latin1', SEQ_HEAD.length, SEQ_HEAD.length + digits.length + 1) !== `${digits},`) return null;
  const tail = line.length - 66, hash = line.toString('latin1', tail, line.length - 2);
  return line[line.length - 1] === 125 && line[line.length - 2] === 34 && line.subarray(tail - HASH_TAIL.length, tail).equals(HASH_TAIL) && HEX.test(hash) ? hash : null;
};
function* trustedRecords(fd, end, suffix, wantEvent, observed) {
  for (const line of lines(fd, end, suffix, 0, true)) {
    const skipped = !wantEvent() && skippableEvent(line, observed.sequence + 1);
    if (skipped) { observed.sequence++; observed.hash = skipped; continue; }
    let record;
    try { record = JSON.parse(line.toString('utf8')); } catch { throw new JournalError(`Invalid committed journal record ${observed.sequence + 1}.`, 'journal_corrupt'); }
    if (record.seq !== observed.sequence + 1) throw new JournalError(`Journal chain mismatch at record ${observed.sequence + 1}.`, 'journal_corrupt');
    observed.sequence++; observed.hash = record.hash; yield record;
  }
}
// A process reopens the same session log at every turn. Once a prefix was
// verified (or written) by this process, a reopen verifies only the new tail
// after confirming the exact record at the remembered boundary. Integrity
// against torn/partial writes is unchanged; the chain is not a signature.
const verifiedPrefixes = new Map();
// The exact record ending at `size` starts at `lineStart` and is `sequence`/`hash`.
function boundaryRecord(fd, { size, lineStart, sequence, hash: expected }) {
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(lineStart) || size < 1 || lineStart < 0 || lineStart >= size) return false;
  const start = Math.max(0, lineStart - 1), buffer = Buffer.allocUnsafe(size - start);
  for (let offset = 0; offset < buffer.length;) {
    const count = readSync(fd, buffer, offset, Math.min(READ_BUFFER_BYTES, buffer.length - offset), start + offset);
    if (!count) return false;
    offset += count;
  }
  if (buffer.at(-1) !== 10 || (lineStart > 0 && buffer[0] !== 10)) return false;
  const line = buffer.subarray(lineStart > 0 ? 1 : 0, -1);
  if (line.includes(10)) return false;
  try {
    const { hash, ...body } = JSON.parse(line.toString('utf8'));
    return body.seq === sequence && hash === expected && digest(body) === hash;
  } catch { return false; }
}
function rememberedPrefix(fd, file, identity, boundary, current) {
  const known = verifiedPrefixes.get(file);
  // Any write after this process last closed or verified the log (including an
  // in-place rewrite of the same size) changes size, mtime or ctime; `current`
  // is sampled before this opener's own chmod.
  if (!known || known.dev !== identity.dev || known.ino !== identity.ino || known.size !== boundary || BigInt(known.size) !== current.size || known.mtimeNs !== current.mtimeNs || known.ctimeNs !== current.ctimeNs) return null;
  return boundaryRecord(fd, known) ? known : null;
}

/* Persisted checkpoint `<journal>.checkpoint`, rewritten at every clean close,
 * so a new process (daemon restart) does not re-verify the whole chain:
 *  - identity (dev, ino), size, mtime and ctime unchanged since that close, and
 *    the boundary record matches: the verified prefix is trusted as within
 *    one process (E1), without reading it;
 *  - otherwise, when the file only grew (a writer crashed before closing), the
 *    prefix bytes must match the checkpoint's SHA-256 segment digests (a full
 *    read, but no parsing or per-record hashing) and only the tail records
 *    are verified;
 *  - anything else (missing, stale, torn or tampered) verifies the full chain.
 * Segments cover [0, size) contiguously; each open/close cycle appends one
 * (a trailing segment under SEGMENT_BYTES is re-hashed and extended). The file
 * is advisory: it is written without fsync and only ever narrows the work. */
export const journalCheckpointFile = file => `${file}.checkpoint`;
const SEGMENT_BYTES = 4 * 1024 * 1024, CHECKPOINT_FORMAT = 'rna-journal-checkpoint';
function readCheckpoint(file, stat) {
  let value; try { value = JSON.parse(readFileSync(journalCheckpointFile(file), 'utf8')); } catch { return null; }
  if (value?.format !== CHECKPOINT_FORMAT || value.version !== 1 || value.dev !== String(stat.dev) || value.ino !== String(stat.ino) || !Number.isSafeInteger(value.size) || !Number.isSafeInteger(value.sequence) || typeof value.hash !== 'string' || !value.header || !Array.isArray(value.segments)) return null;
  let end = 0;
  for (const segment of value.segments) { if (!Array.isArray(segment) || !Number.isSafeInteger(segment[0]) || segment[0] <= end || !/^[0-9a-f]{64}$/.test(segment[1] ?? '')) return null; end = segment[0]; }
  return end === value.size ? value : null;
}
function writeCheckpoint(file, value) {
  const target = journalCheckpointFile(file), temp = `${target}.tmp-${randomUUID()}`;
  try { writeFileSync(temp, JSON.stringify({ format: CHECKPOINT_FORMAT, version: 1, ...value }), { flag: 'wx', mode: 0o600 }); renameSync(temp, target); }
  catch { try { unlinkSync(temp); } catch {} }
}
function hashRange(fd, start, end, hash) {
  for (let offset = start; offset < end;) {
    const buffer = Buffer.allocUnsafe(Math.min(READ_BUFFER_BYTES, end - offset)), count = readSync(fd, buffer, 0, buffer.length, offset);
    if (!count) return false;
    hash.update(buffer.subarray(0, count)); offset += count;
  }
  return true;
}
function segmentsMatch(fd, segments) {
  let start = 0;
  for (const [end, expected] of segments) { const hash = createHash('sha256'); if (!hashRange(fd, start, end, hash) || hash.digest('hex') !== expected) return false; start = end; }
  return true;
}
function lastLineStart(fd, end) {
  // end is a committed boundary (after a newline); find the previous one.
  for (let stop = end - 1; stop > 0;) {
    const start = Math.max(0, stop - READ_BUFFER_BYTES), buffer = Buffer.allocUnsafe(stop - start);
    if (readSync(fd, buffer, 0, buffer.length, start) !== buffer.length) return -1;
    const boundary = buffer.lastIndexOf(10);
    if (boundary !== -1) return start + boundary + 1;
    stop = start;
  }
  return 0;
}

function committedBoundary(fd, size) {
  for (let end = size; end > 0;) {
    const start = Math.max(0, end - READ_BUFFER_BYTES), buffer = Buffer.allocUnsafe(end - start);
    const count = readSync(fd, buffer, 0, buffer.length, start);
    if (count !== buffer.length) throw new JournalError('Journal changed while recovering its tail.', 'journal_corrupt');
    const boundary = buffer.lastIndexOf(10);
    if (boundary !== -1) return start + boundary + 1;
    end = start;
  }
  return 0;
}

/** Exclusive writer lock `<journal>.lock` (stale owners are recovered). Returns its release. */
export function acquireJournalLock(file) {
  const lockFile = `${file}.lock`, lockToken = randomUUID();
  let lock;
  try { lock = openSync(lockFile, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { throw new JournalError('Journal lock is unreadable; inspect it before recovery.', 'journal_locked'); }
    let alive = true;
    if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
    }
    if (alive) throw new JournalError('Journal already has a live writer.', 'journal_locked');
    // Re-check the stale identity before removal. The exclusive create below
    // arbitrates concurrent recoverers; it never opens another owner's lock.
    if (readFileSync(lockFile, 'utf8') !== JSON.stringify(owner)) throw new JournalError('Journal lock changed during recovery.', 'journal_locked');
    unlinkSync(lockFile);
    try { lock = openSync(lockFile, 'wx', 0o600); } catch { throw new JournalError('Journal already has a writer.', 'journal_locked'); }
  }
  writeSync(lock, JSON.stringify({ pid: process.pid, token: lockToken })); fsyncSync(lock); closeSync(lock);
  return () => { try { if (JSON.parse(readFileSync(lockFile, 'utf8')).token === lockToken) unlinkSync(lockFile); } catch {} };
}

/** Offline full verification of a journal file, streamed: calls `onRecord`
 * for each committed record in order. A final line without its newline is
 * reported as `tornBytes`, not read. With `checkpoint`, a journal without a
 * torn tail gets a fresh persisted checkpoint (the caller holds its lock). */
export function readVerifiedJournal(file, onRecord = () => {}, { checkpoint = false } = {}) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd, { bigint: true }), size = Number(stat.size), boundary = committedBoundary(fd, size), bytes = createHash('sha256');
    let sequence = 0, hash = null, header = null;
    for (const record of verifiedRecords(fd, boundary, [], { bytes })) { header ??= record; sequence = record.seq; hash = record.hash; onRecord(record); }
    if (header && (header.type !== 'session_header' || header.data?.format !== 'rna-session' || header.data.version !== 1)) throw new JournalError('Unsupported journal format.', 'unsupported_format');
    const lineStart = boundary ? lastLineStart(fd, boundary) : -1;
    if (checkpoint && header && boundary === size && lineStart >= 0) writeCheckpoint(file, { dev: String(stat.dev), ino: String(stat.ino), size, mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), lineStart, sequence, hash, header, segments: [[size, bytes.digest('hex')]] });
    return { size: boundary, tornBytes: size - boundary, sequence, hash, header, lineStart };
  } finally { closeSync(fd); }
}

/**
 * Read-only scan of a session journal's committed records, without its writer lock: a live writer may keep appending,
 * the scan stops at the boundary seen when it opened. `verify` (default) checks the hash chain like any reader;
 * `verify: false` only checks sequence continuity and, with `wantEvent: () => false`, skips stream telemetry by its
 * record head (derived metrics over many large journals). Never a replay source for a writer.
 */
export function* readJournalRecords(file, { verify = true, wantEvent = () => true } = {}) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const boundary = committedBoundary(fd, fstatSync(fd).size);
    if (verify) yield* verifiedRecords(fd, boundary, []);
    else yield* trustedRecords(fd, boundary, [], wantEvent, { sequence: 0, hash: null });
  } finally { closeSync(fd); }
}

/** Single-writer hash chain with durable canonical records and buffered events. */
export function openJournal({ stateDir, sessionFile, sessionId, projectId } = {}) {
  if (!stateDir || !sessionId) throw new JournalError('stateDir and sessionId are required.', 'invalid_options');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const root = realpathSync(stateDir); chmodSync(root, 0o700);
  const file = sessionFile ? resolve(sessionFile) : resolve(root, `${digest(sessionId).slice(0, 24)}.rna.jsonl`);
  if (!within(root, file) || !within(root, realpathSync(dirname(file))) || !file.endsWith('.jsonl')) throw new JournalError('Journal must be a JSONL file within stateDir.', 'invalid_path');
  if (existsSync(file) && (!within(root, realpathSync(file)) || !statSync(file).isFile())) throw new JournalError('Invalid journal path.', 'invalid_path');
  const release = acquireJournalLock(file);
  let fd, closed = false;
  try {
    fd = openSync(file, constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
    const opened = fstatSync(fd, { bigint: true });
    chmodSync(file, 0o600);
    const originalSize = fstatSync(fd).size, boundary = committedBoundary(fd, originalSize);
    let recoveredBytes = originalSize - boundary;
    if (recoveredBytes) {
      // A torn final write is kept privately for inspection; committed lines
      // are never rewritten or silently skipped.
      const torn = openSync(`${file}.torn-${randomUUID()}`, 'wx', 0o600);
      try {
        for (let offset = boundary; offset < originalSize;) {
          const buffer = Buffer.allocUnsafe(Math.min(READ_BUFFER_BYTES, originalSize - offset));
          const count = readSync(fd, buffer, 0, buffer.length, offset);
          if (!count) throw new JournalError('Journal changed while saving its torn tail.', 'journal_corrupt');
          for (let written = 0; written < count;) {
            const size = writeSync(torn, buffer, written, count - written);
            if (!size) throw new JournalError('Torn tail write made no progress.', 'journal_write_failed');
            written += size;
          }
          offset += count;
        }
        fsyncSync(torn);
      } finally { closeSync(torn); }
      ftruncateSync(fd, boundary); fsyncSync(fd);
    }
    let sequence = 0, prevHash = null, header;
    // `segments` digest [0, segmentStart); `running` hashes every byte from
    // segmentStart on, both the verified tail and this writer's appends.
    let segments = [], segmentStart = 0, running = createHash('sha256'), start = 0;
    const identity = fstatSync(fd), known = !recoveredBytes && rememberedPrefix(fd, file, identity, boundary, opened);
    const resume = trusted => {
      ({ sequence, hash: prevHash, header } = trusted); start = trusted.size; header = structuredClone(header);
      segments = trusted.segments.slice(); segmentStart = trusted.size;
      // A small trailing segment is extended rather than followed by another.
      const last = segments.at(-1), lastStart = segments.at(-2)?.[0] ?? 0;
      if (last && last[0] - lastStart < SEGMENT_BYTES && hashRange(fd, lastStart, last[0], running)) { segments.pop(); segmentStart = lastStart; }
      else running = createHash('sha256');
    };
    if (known) { ({ sequence, hash: prevHash } = known); header = structuredClone(known.header); start = known.size; segments = known.segments.slice(); segmentStart = known.segmentStart; running = known.running.copy(); }
    else if (boundary) {
      const saved = readCheckpoint(file, opened);
      if (saved && saved.size <= boundary && boundaryRecord(fd, saved) && (!recoveredBytes && saved.size === boundary && BigInt(saved.size) === opened.size && saved.mtimeNs === String(opened.mtimeNs) && saved.ctimeNs === String(opened.ctimeNs) || segmentsMatch(fd, saved.segments))) resume(saved);
    }
    for (const record of verifiedRecords(fd, boundary, [], start ? { start, sequence, previous: prevHash, bytes: running } : { bytes: running })) {
      header ??= record; sequence = record.seq; prevHash = record.hash;
    }
    const remember = size => {
      const lineStart = size ? lastLineStart(fd, size) : -1, times = fstatSync(fd, { bigint: true });
      if (lineStart >= 0 && header && times.size === BigInt(size)) verifiedPrefixes.set(file, { dev: identity.dev, ino: identity.ino, size, lineStart, sequence, hash: prevHash, header: structuredClone(header), mtimeNs: times.mtimeNs, ctimeNs: times.ctimeNs, segments: segments.slice(), segmentStart, running: running.copy() });
      else verifiedPrefixes.delete(file);
      return lineStart >= 0 && header && times.size === BigInt(size) ? { lineStart, times } : null;
    };
    let pending = [], pendingBytes = 0, persistenceFailure, closedSize;
    const assertWritable = () => {
      if (closed) throw new JournalError('Journal is closed.', 'journal_closed');
      if (persistenceFailure) throw new JournalError('Journal persistence previously failed; reopen and verify the log before continuing.', 'journal_persistence_failed');
    };
    const write = bytes => {
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const count = writeSync(fd, bytes, offset, bytes.length - offset);
          if (!count) throw new JournalError('Journal write made no progress.', 'journal_write_failed');
          offset += count;
        }
      } catch (error) { persistenceFailure = error; throw error; }
      running.update(bytes);
    };
    const flushEvents = () => {
      if (!pending.length) return;
      write(Buffer.concat(pending, pendingBytes)); pending = []; pendingBytes = 0;
    };
    const synchronize = () => { try { fsyncSync(fd); } catch (error) { persistenceFailure = error; throw error; } };
    const makeRecord = (type, data) => {
      const body = JSON.parse(JSON.stringify({ seq: sequence + 1, prevHash, time: new Date().toISOString(), type, data }));
      const record = { ...body, hash: digest(body) }, line = Buffer.from(`${JSON.stringify(record)}\n`);
      return { record, line };
    };
    const publish = record => {
      sequence++; prevHash = record.hash;
      return structuredClone(record);
    };
    const append = (type, data) => {
      assertWritable(); const { record, line } = makeRecord(type, data);
      flushEvents(); write(line); synchronize();
      return publish(record);
    };
    const appendEvent = data => {
      assertWritable(); const { record, line } = makeRecord('event', data);
      // Never keep an unbounded collection or one oversized event in the
      // pending buffer. Large telemetry is written directly, still without a
      // per-event fsync. The next canonical barrier commits it in order.
      if (pendingBytes + line.length > EVENT_BUFFER_BYTES) flushEvents();
      if (line.length >= EVENT_BUFFER_BYTES) write(line);
      else { pending.push(line); pendingBytes += line.length; }
      const published = publish(record);
      if (pending.length >= EVENT_BUFFER_ROWS) flushEvents();
      return published;
    };
    if (!sequence) header = append('session_header', { format: 'rna-session', version: 1, sessionId, projectId: projectId ?? null });
    if (header.type !== 'session_header' || header.data?.format !== 'rna-session' || header.data.version !== 1) throw new JournalError('Unsupported journal format; legacy sessions require explicit import.', 'unsupported_format');
    if (header.data.sessionId !== sessionId || header.data.projectId !== (projectId ?? null)) throw new JournalError('Journal belongs to a different session or project.', 'identity_mismatch');
    if (recoveredBytes) append('journal_recovered', { truncatedTailBytes: recoveredBytes });
    remember(fstatSync(fd).size);
    // `verified: true` replays the chain this writer verified at open (and has
    // appended since) without rehashing every record; `wantEvent` decides
    // whether telemetry events need parsing at the current replay position.
    function* iterateRecords({ verified = false, wantEvent = () => true } = {}) {
      if (persistenceFailure) throw new JournalError('Journal persistence previously failed; reopen and verify the log before continuing.', 'journal_persistence_failed');
      const opened = closed, readFd = opened ? openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) : fd;
      try {
        const current = fstatSync(readFd);
        if (current.dev !== identity.dev || current.ino !== identity.ino) throw new JournalError('Journal identity changed while reading.', 'journal_corrupt');
        const end = closed ? closedSize : current.size, suffix = pending.slice(), expectedSequence = sequence, expectedHash = prevHash;
        let observedSequence = 0, observedHash = null;
        if (verified && !opened) {
          const observed = { sequence: 0, hash: null };
          yield* trustedRecords(readFd, end, suffix, wantEvent, observed);
          ({ sequence: observedSequence, hash: observedHash } = observed);
        } else for (const record of verifiedRecords(readFd, end, suffix)) { observedSequence = record.seq; observedHash = record.hash; yield record; }
        if (observedSequence !== expectedSequence || observedHash !== expectedHash) throw new JournalError('Journal changed while reading.', 'journal_corrupt');
      } finally { if (opened) closeSync(readFd); }
    }
    return {
      file, recoveredBytes, append, appendEvent, iterateRecords,
      // Explicit compatibility materialization only; normal replay is streamed.
      get records() { return Array.from(iterateRecords()); },
      releaseRecords() {},
      get seq() { return sequence; },
      close() {
        if (closed) return;
        try {
          assertWritable(); flushEvents(); synchronize(); closedSize = fstatSync(fd).size;
          const verified = remember(closedSize);
          if (verified && closedSize >= segmentStart) writeCheckpoint(file, { dev: String(opened.dev), ino: String(opened.ino), size: closedSize, mtimeNs: String(verified.times.mtimeNs), ctimeNs: String(verified.times.ctimeNs), lineStart: verified.lineStart, sequence, hash: prevHash, header, segments: closedSize > segmentStart ? [...segments, [closedSize, running.copy().digest('hex')]] : segments });
        }
        finally { closed = true; pending = []; pendingBytes = 0; try { closeSync(fd); } finally { release(); } }
      }
    };
  } catch (error) { if (fd !== undefined) closeSync(fd); release(); throw error; }
}
