import { closeSync, fsyncSync, linkSync, lstatSync, openSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { acquireJournalLock, canonicalJSON, digest, JournalError, journalCheckpointFile, readVerifiedJournal, STREAM_SEGMENT_CHARS, STREAM_SEGMENT_MS } from './journal.mjs';

/* Offline compaction of stream telemetry in existing session journals.
 *
 * Consecutive per-token `message_update` events of one stream (same request,
 * message and delta kind) within a segment window are merged into one event
 * carrying the concatenated delta, as a live session now writes them. Every
 * other record is kept verbatim (type, time, data); the hash chain is rebuilt
 * over the new sequence. Replay reads stream events only to rebuild the
 * partial text of an interrupted request, which is the concatenation of its
 * deltas, so the merge preserves it exactly. The rewrite is verified (chain
 * and replay projection) before it replaces the journal; the original stays
 * beside it as `<journal>.precompact-<time>-<records>` until removed explicitly.
 * Running it again on a compacted journal changes nothing. */
const BACKUP = /\.precompact-\d+-(\d+)$/;
const segmentKey = data => {
  // Only plain delta records merge: no partial snapshot, no extra fields, and
  // never an already merged segment (that keeps compaction idempotent).
  if (data?.type !== 'message_update' || typeof data.requestId !== 'string' || data.message !== undefined || data.deltas !== undefined) return null;
  const event = data.assistantMessageEvent;
  if (!event || typeof event !== 'object' || typeof event.delta !== 'string' || !['text_delta', 'thinking_delta'].includes(event.type) || Object.keys(event).some(key => !['type', 'delta'].includes(key))) return null;
  if (Object.keys(data).some(key => !['type', 'requestId', 'messageId', 'assistantMessageEvent'].includes(key))) return null;
  return JSON.stringify([data.requestId, data.messageId ?? null, event.type]);
};
// Order-sensitive digest of what replay and observers can derive: every
// record's type, time and data, except that a maximal run of stream deltas
// of one stream contributes its key and concatenated text.
function projection() {
  const hash = createHash('sha256'); let run = null, result;
  const flush = () => { if (run) { hash.update(`${canonicalJSON(['stream', run.key, run.text])}\n`); run = null; } };
  return {
    add(record) {
      const key = record.type === 'event' ? streamKey(record.data) : null;
      if (key) { if (run?.key !== key) { flush(); run = { key, text: '' }; } run.text += record.data.assistantMessageEvent.delta; return; }
      flush(); hash.update(`${canonicalJSON([record.type, record.time, record.data])}\n`);
    },
    digest() { if (result === undefined) { flush(); result = hash.digest('hex'); } return result; }
  };
}
// Merged segments are stream deltas too; only their text matters to replay.
const streamKey = data => {
  if (data?.type !== 'message_update' || typeof data.requestId !== 'string' || data.message !== undefined || typeof data.assistantMessageEvent?.delta !== 'string') return null;
  return JSON.stringify([data.requestId, data.messageId ?? null, data.assistantMessageEvent.type]);
};

/** Compact one journal. Returns a report; `dryRun` only measures. */
export function compactJournal(file, { dryRun = false, segmentMs = STREAM_SEGMENT_MS, segmentChars = STREAM_SEGMENT_CHARS } = {}) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new JournalError('Journal must be a regular file.', 'invalid_path');
  const release = dryRun ? () => {} : acquireJournalLock(file);
  let temp, fd;
  try {
    const report = { file, bytes: 0, records: 0, compactedBytes: 0, compactedRecords: 0, mergedEvents: 0, changed: false, dryRun };
    const original = projection(), rewritten = projection();
    let sequence = 0, previous = null, pending = null, written = 0;
    const emit = (type, time, data) => {
      const body = { seq: ++sequence, prevHash: previous, time, type, data }, record = { ...body, hash: digest(body) };
      previous = record.hash; rewritten.add(record);
      const line = Buffer.from(`${JSON.stringify(record)}\n`);
      report.compactedRecords++; report.compactedBytes += line.length;
      if (fd !== undefined) for (let offset = 0; offset < line.length;) { const count = writeSync(fd, line, offset, line.length - offset); if (!count) throw new JournalError('Compaction write made no progress.', 'journal_write_failed'); offset += count; }
      written += line.length;
    };
    const flush = () => {
      if (!pending) return;
      const { time, data, count, delta } = pending; pending = null;
      emit('event', time, count > 1 ? { ...data, assistantMessageEvent: { ...data.assistantMessageEvent, delta }, deltas: count } : data);
    };
    if (!dryRun) { temp = join(dirname(file), `${basename(file)}.compact-${randomUUID()}`); fd = openSync(temp, 'wx', 0o600); }
    const scan = readVerifiedJournal(file, record => {
      original.add(record); report.records++;
      const key = record.type === 'event' ? segmentKey(record.data) : null;
      if (key && pending?.key === key && Date.parse(record.time) - pending.started < segmentMs && pending.delta.length + record.data.assistantMessageEvent.delta.length <= segmentChars) {
        pending.delta += record.data.assistantMessageEvent.delta; pending.count++; pending.time = record.time; report.mergedEvents++; return;
      }
      flush();
      if (key) pending = { key, started: Date.parse(record.time), time: record.time, data: record.data, delta: record.data.assistantMessageEvent.delta, count: 1 };
      else emit(record.type, record.time, record.data);
    });
    flush();
    report.bytes = scan.size;
    if (scan.tornBytes) { report.skipped = 'torn_tail'; report.tornBytes = scan.tornBytes; }
    else if (!report.mergedEvents) report.skipped = 'already_compact';
    if (original.digest() !== rewritten.digest()) throw new JournalError('Compaction would change the replay projection.', 'journal_compaction_mismatch');
    if (dryRun || report.skipped) return report;
    fsyncSync(fd); closeSync(fd); fd = undefined;
    // Verify the rewrite from disk before it replaces anything.
    const check = projection(), verified = readVerifiedJournal(temp, record => check.add(record));
    if (verified.tornBytes || verified.size !== written || verified.sequence !== sequence || verified.hash !== previous || check.digest() !== original.digest()) throw new JournalError('Compacted journal failed verification.', 'journal_compaction_mismatch');
    if (fstatSafe(file)?.size !== scan.size) throw new JournalError('Journal changed during compaction.', 'journal_corrupt');
    report.backup = `${file}.precompact-${Date.now()}-${sequence}`;
    linkSync(file, report.backup); renameSync(temp, file); temp = undefined;
    syncDirectory(dirname(file));
    // The old checkpoint describes the original bytes; the verified pass
    // above wrote a fresh one for the rewrite (see readVerifiedJournal).
    try { unlinkSync(journalCheckpointFile(file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    readVerifiedJournal(file, () => {}, { checkpoint: true });
    report.changed = true;
    return report;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (temp) try { unlinkSync(temp); } catch { /* best effort */ }
    release();
  }
}
const fstatSafe = path => { try { return lstatSync(path); } catch { return null; } };
// Windows cannot fsync a directory handle (EPERM); a rename there is already written through.
function syncDirectory(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } catch (error) { if (!(process.platform === 'win32' && ['EPERM', 'EISDIR', 'EINVAL', 'EACCES'].includes(error.code))) throw error; } finally { closeSync(fd); } }

/** Backups left by earlier compactions of `file`. */
export function compactionBackups(file) {
  const prefix = `${basename(file)}.precompact-`;
  return readdirSync(dirname(file)).filter(name => name.startsWith(prefix) && BACKUP.test(name)).map(name => join(dirname(file), name));
}
/** Remove backups whose replay projection equals the current journal's
 * projection up to the record the backup ended at (named in the backup;
 * a session may have appended to the compacted journal since). */
export function removeCompactionBackups(file, { dryRun = false } = {}) {
  const backups = compactionBackups(file); if (!backups.length) return { file, removed: [], kept: [] };
  const ends = new Map(backups.map(backup => [backup, Number(BACKUP.exec(backup)[1])])), prefixes = new Map([...new Set(ends.values())].map(end => [end, projection()]));
  const scan = readVerifiedJournal(file, record => { for (const [end, digest] of prefixes) if (record.seq <= end) digest.add(record); });
  if (scan.tornBytes) return { file, removed: [], kept: backups, reason: 'torn_tail' };
  const removed = [], kept = [];
  for (const backup of backups) {
    const check = projection(), end = ends.get(backup); let ok = false;
    try { const read = readVerifiedJournal(backup, record => check.add(record)); ok = !read.tornBytes && end <= scan.sequence && check.digest() === prefixes.get(end).digest(); } catch { ok = false; }
    if (!ok) { kept.push(backup); continue; }
    const { size: bytes } = lstatSync(backup);
    if (!dryRun) unlinkSync(backup);
    removed.push({ backup, bytes });
  }
  return { file, removed, kept };
}
