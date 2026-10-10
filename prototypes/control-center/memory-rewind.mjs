import { memoryWriteRecords } from './memory-checkpoints.mjs';
import { ensureMind, recordRevocation } from './project-mind.mjs';
import { MEMORY_DIFF_READ_BYTES, turnTag, within } from './memory-service.mjs';
import { noteMemoryRevision } from './memory-summary-sync.mjs';
import { deferral } from './revocation-dispatcher.mjs';

// Rewind reaches OpenViking (reference alignment §1.3 C row X-7, §2.2 D5).
//
// A rewind (an edited or deleted message) removes turns from a conversation. The turns' memory writes are gone with them,
// but each turn's remote OpenViking session, and whatever extraction made of it, stayed searchable: lessons, notes and
// genes were revoked (C4), the remote archive and the peer memories extracted from it were not. Here the revocation
// dispatcher's `message_rewound` event gets its OpenViking handler (revocation-dispatcher.mjs: one revocation path, a
// handler per subsystem, as OpenViking's own resource_memory_link_service does it for resources and memory files):
//
//   1. In the rewind's transaction the remote sessions bound to the removed turns are written to a revocation entry
//      (`rewoundMemoryUnits`, `recordRewoundMemory`): the turn rows are deleted with the turns, and an archive is lost once
//      its session is deleted, so what to look for is recorded before either happens. Identifiers only, never memory text.
//   2. After the transaction the handler settles each remote session, newest turn first: every commit task of it ends
//      (deleteSessionArchive cancels a running one), then its archives' `memory_diff.json` is read (OpenViking writes one per
//      archive: operations adds{uri, after}, updates{uri, before, after}, deletes{uri, deleted_content};
//      session/compressor_v3.py `_make_memory_diff`, `session.py` memory_diff_uri), the memories are rolled back, and only
//      then the session (with the diffs) is deleted. A rollback that fails leaves the session, so a retry finds the diffs.
//   3. A memory is rolled back only where its current content is still byte-equal to the diff's `after`: an add is deleted,
//      an update gets its `before` back. Anything else (the user or a later extraction changed it, it is gone, it lies outside
//      the project's own peer namespace, the diff has no `before`) is left alone and reported. Deletes the archive made are
//      never undone. Nothing is ever removed that no diff names; event memories, which are append-only, carry an
//      `rna_turn=<id>` tag (memory-service createSession) so those of a removed turn that no diff lists can at least be
//      found and reported. Diffs are compared archive by archive, newest first, so a chain of updates unwinds in order.
//      That order holds across entries too (a long rewind makes several, and two rewinds of one project can both be open): a
//      unit is settled only once no unit of another open entry that is newer than it is still to settle. A newer one that
//      is backing off, held, or failed makes the older ones WAIT (a deferral: no attempt is counted), never skip ahead:
//      the diffs an older turn's rollback needs leave with its session, and by then the newer turn's changes to the same
//      memory would no longer be undone in front of it.
//   4. Writes to the memory service wait while the application is held for maintenance and while a restore is under review
//      (`applicationRecovery.barriers.memory` with autoStore off), as every other memory write does: a wait, not a failure.
//   5. Deleting a whole conversation does not come through here: it keeps its extracted memory (an existing, deliberate
//      policy: the deletion notice promises it).
// `dryRun` (runtime-controller rewind) reads the same things and writes nothing.

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const ARCHIVE = /^archive_(\d{1,9})$/;
/** Remote sessions in one revocation entry (a long rewind makes several; the entry is persisted state). */
export const UNITS_PER_ENTRY = 40;
/** Remote sessions a dry run looks at (each costs a handful of read-only requests). */
export const PREVIEW_UNITS = 50;
/** A dry run is something the user waits for: one session may take this long, the whole of it this long (the rest is counted as omitted), and a client that goes away ends it. */
export const PREVIEW_SESSION_MS = 15000, PREVIEW_BUDGET_MS = 30000;
const REPORT_ROWS = 20, SUMMARY_ROWS = 40;
const iso = value => new Date(value).toISOString();
const cleanupError = code => Object.assign(new Error(code), { code, status: 503 });
/** Why remote memory writes must wait now, or null: the application is held for maintenance, or a restore awaits review with memory writes paused (memory-sync.mjs gates the same way). */
export function memoryWritesPaused(store) {
  if (store.maintenanceHeld) return 'MEMORY_CLEANUP_HELD';
  return store.state?.applicationRecovery?.barriers?.memory && store.state.configuration?.memory?.autoStore !== true ? 'MEMORY_CLEANUP_RESTORE_REVIEW' : null;
}

/** The outcomes of one operation. SETTLED ones need nothing more; the others are what stays and is reported. */
export const SETTLED_OUTCOMES = Object.freeze(['deleted', 'restored', 'already_restored', 'absent', 'would_delete', 'would_restore']);
const settled = outcome => SETTLED_OUTCOMES.includes(outcome);
/** Codes that no retry can change: the connection, the account or the binding is not what the session was created with. */
const PERMANENT = new Set(['MEMORY_CLEANUP_CONNECTION_CHANGED', 'MEMORY_CLEANUP_IDENTITY_CHANGED', 'MEMORY_CLEANUP_IDENTITY_UNVERIFIED', 'MEMORY_CLEANUP_TASK_IDENTITY_UNVERIFIED', 'MEMORY_CLEANUP_AUTOCOMMIT_ACTIVE', 'MEMORY_REWIND_BINDING_MISSING']);
const FINAL = new Set(['deleted', 'kept']);

const MEMORY_FIELDS = /<!--\s*MEMORY_FIELDS\b[\s\S]*?\s*-->/g;
/**
 * The body of a memory file as OpenViking reads it (`MemoryFileUtils.read(raw).content`, session/memory/utils/
 * messages.py parse_memory_file_with_fields): the file without its MEMORY_FIELDS comment, stripped. A diff's `before` and
 * `after` are this, never the raw file, so this is what a current file is compared with.
 */
export const memoryBodyOf = raw => typeof raw === 'string' ? raw.replace(MEMORY_FIELDS, '').trim() : '';

/**
 * The operations of one archive's `memory_diff.json` (text), or null when it is not such a diff. Only strings are kept as
 * content (an operation without a string `after` is later left alone as `after_unknown`), and only operations with a URI.
 */
export function memoryDiffOperations(text, { archive = null } = {}) {
  let diff; try { diff = typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
  const operations = diff?.operations;
  if (!diff || typeof diff !== 'object' || !operations || typeof operations !== 'object' || Array.isArray(operations)) return null;
  const rows = (kind, list) => (Array.isArray(list) ? list : []).filter(row => row && typeof row === 'object' && typeof row.uri === 'string' && row.uri)
    .map(row => ({ kind, uri: row.uri, ...(typeof row.memory_type === 'string' ? { memoryType: row.memory_type.slice(0, 40) } : {}), ...(typeof row.before === 'string' ? { before: row.before } : {}), ...(typeof row.after === 'string' ? { after: row.after } : {}), archive }));
  return [...rows('add', operations.adds), ...rows('update', operations.updates), ...rows('delete', operations.deletes)];
}

/**
 * One archive's operations in the order to undo them. A diff groups what the archive did by kind, each kind in the order it
 * happened (batches of one extraction are merged by concatenation: `_merge_memory_diffs`), and an update of a memory the same
 * archive added came after the add: so updates newest first, then adds newest first. A memory the archive deleted is never
 * undone (`deleted_by_archive`), so deletes go last and need no order.
 */
export const undoOrder = operations => [...operations.filter(op => op.kind === 'update').reverse(), ...operations.filter(op => op.kind === 'add').reverse(), ...operations.filter(op => op.kind === 'delete')];

/**
 * What to do with each operation, and doing it (`apply`), against what the memory files hold now. `io`:
 *   read(uri)             → { body } | { absent: true } | { unreadable: code }   (the file's body, see memoryBodyOf)
 *   remove(uri)           → 'deleted' | 'absent' | 'refused'
 *   restore(uri, before)  → 'restored' | 'unverified' | 'absent' | 'refused'
 *   inScope(uri)          → whether the URI is in the project's own peer-memory namespace
 * `overlay` (a dry run, `apply: false`): a Map uri → what read(uri) would answer once the rollbacks planned so far had happened, so the
 * sessions of a chain of turns are planned as the real run unwinds them (newest first), not each against the untouched files.
 * `operations` are in the order to undo them (newest archive first). A write is only ever sent for a file whose body is
 * byte-equal to the operation's `after` on two reads, the second one right before the write. Never throws for a refusal;
 * a transient failure of `io` propagates (the caller retries the whole thing: every step recognizes what it did already).
 * @returns {Promise<{ op: string, uri: string, outcome: string, type?: string, archive?: string | null }[]>}
 */
export async function rollbackOperations(operations, { read: readNow, remove, restore, inScope, apply = true, overlay = null }) {
  const read = async uri => !apply && overlay?.has(uri) ? overlay.get(uri) : readNow(uri);
  const results = [];
  for (const op of operations) {
    const done = outcome => { results.push({ op: op.kind, uri: op.uri, outcome, ...(op.memoryType ? { type: op.memoryType } : {}), archive: op.archive ?? null }); };
    if (!inScope(op.uri) || op.uri.endsWith('/')) { done('outside_scope'); continue; }
    // A memory the archive deleted stays deleted: bringing it back would write what the user may have merged or dropped since.
    if (op.kind === 'delete') { done('deleted_by_archive'); continue; }
    if (typeof op.after !== 'string' || op.after === '') { done('after_unknown'); continue; }
    const known = typeof op.before === 'string' && op.before !== '';
    const now = await read(op.uri);
    if (now.unreadable) { done('unreadable'); continue; }
    if (now.absent) { done('absent'); continue; }
    if (now.body !== op.after) { done(op.kind === 'update' && known && now.body === op.before ? 'already_restored' : 'changed'); continue; }
    if (op.kind === 'update' && !known) { done('before_unknown'); continue; }
    if (!apply) { overlay?.set(op.uri, op.kind === 'add' ? { absent: true } : { body: op.before }); done(op.kind === 'add' ? 'would_delete' : 'would_restore'); continue; }
    const again = await read(op.uri);
    if (again.unreadable) { done('unreadable'); continue; }
    if (again.absent) { done('absent'); continue; }
    if (again.body !== op.after) { done('changed'); continue; }
    done(op.kind === 'add' ? await remove(op.uri) : await restore(op.uri, op.before));
  }
  return results;
}
const totalsOf = results => { const totals = {}; for (const row of results) totals[row.outcome] = (totals[row.outcome] ?? 0) + 1; return totals; };
const addTotals = (into, from) => { for (const [key, count] of Object.entries(from ?? {})) into[key] = (into[key] ?? 0) + count; return into; };

// --------------------------------------------------------------------------------------------- the remote session
const refusal = error => Number.isInteger(error?.upstreamStatus) && error.upstreamStatus >= 400 && error.upstreamStatus < 500 && ![404, 408, 409, 423, 425, 429].includes(error.upstreamStatus);

/** Every archive of the session that has a readable memory diff, newest first: { archives, diffs: [{ archive, operations }], unreadable }. */
async function sessionDiffs({ call, sessionUri }, hints = []) {
  const names = new Map();
  const unreadable = [];
  // A refusal (the service will not show these files to this key) is not a transient failure: nothing is rolled back on what cannot be read, and the report says so.
  let rows; try { rows = await call(`fs/ls?${new URLSearchParams({ uri: `${sessionUri}/history`, output: 'original', node_limit: '1000' })}`); }
  catch (error) { if (error.upstreamStatus !== 404 && !refusal(error)) throw error; rows = []; if (refusal(error)) unreadable.push({ archive: null, why: `HTTP_${error.upstreamStatus}` }); }
  for (const row of Array.isArray(rows) ? rows : []) { const name = String(row?.name ?? row?.uri ?? '').split('/').filter(Boolean).at(-1) ?? '', match = ARCHIVE.exec(name); if (match && row?.isDir !== false) names.set(name, Number(match[1])); }
  // The archives the host recorded are looked at whether or not the listing shows them: a deleted session takes its diffs along, so a listing that missed one must not make it unreachable.
  for (const uri of hints) { const name = String(uri).slice(`${sessionUri}/history/`.length), match = String(uri).startsWith(`${sessionUri}/history/`) ? ARCHIVE.exec(name) : null; if (match) names.set(name, Number(match[1])); }
  const ordered = [...names].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1)).map(([name]) => name), diffs = [];
  for (const name of ordered) {
    const archiveUri = `${sessionUri}/history/${name}`, file = `${archiveUri}/memory_diff.json`;
    let stat; try { stat = await call(`fs/stat?${new URLSearchParams({ uri: file })}`); } catch (error) { if (error.upstreamStatus === 404) continue; if (refusal(error)) { unreadable.push({ archive: name, why: `HTTP_${error.upstreamStatus}` }); continue; } throw error; }
    if (!Number.isSafeInteger(stat?.size) || stat.size > MEMORY_DIFF_READ_BYTES) { unreadable.push({ archive: name, why: 'diff_too_large' }); continue; }
    let text; try { text = await call(`content/read?${new URLSearchParams({ uri: file, offset: '0', limit: '-1' })}`); } catch (error) { if (error.upstreamStatus === 404) continue; if (refusal(error)) { unreadable.push({ archive: name, why: `HTTP_${error.upstreamStatus}` }); continue; } throw error; }
    let own = null; try { own = JSON.parse(text)?.archive_uri; } catch { /* reported below */ }
    const operations = memoryDiffOperations(text, { archive: name });
    // A diff names the archive it belongs to: one that names another is not read as this archive's.
    if (!operations || typeof own === 'string' && own.replace(/\/+$/, '') !== archiveUri) { unreadable.push({ archive: name, why: operations ? 'diff_of_another_archive' : 'diff_invalid' }); continue; }
    diffs.push({ archive: name, operations: undoOrder(operations) });
  }
  return { archives: ordered, diffs, unreadable };
}

/** The event memories carrying a removed turn's tag (OpenViking `fs/ls` with `tags`), or null when the service cannot say. */
async function taggedEvents({ call, memoryNamespace, signal }, turnId) {
  const events = `${memoryNamespace}/events`;
  let rows; try { rows = await call(`fs/ls?${new URLSearchParams({ uri: events, recursive: 'true', output: 'original', tags: turnTag(turnId), include_tags: 'true', node_limit: '500' })}`); }
  catch (error) { if (signal?.aborted) throw error; return error.upstreamStatus === 404 ? [] : null; }
  return (Array.isArray(rows) ? rows : []).filter(row => row && row.isDir !== true && typeof row.uri === 'string' && within(row.uri, events)).map(row => row.uri);
}

/**
 * One remote session's rollback (apply) or what it would do (dry run), through the pinned `remote`
 * (MemoryService.sessionCleanupRemote). Returns the report that is persisted and shown:
 * { archives, diffs, unreadable?, totals, left, unlisted?, unlistedCount?, census? }.
 */
export async function inspectUnit(remote, unit, { apply, overlay = null }) {
  const { call, memoryNamespace } = remote;
  const found = await sessionDiffs(remote, Array.isArray(unit.archives) ? unit.archives : []);
  const operations = found.diffs.flatMap(row => row.operations);
  const read = async uri => {
    try { const raw = await call(`content/read?${new URLSearchParams({ uri, offset: '0', limit: '-1', raw: 'true' })}`); return typeof raw === 'string' ? { body: memoryBodyOf(raw) } : { unreadable: 'not_text' }; }
    catch (error) { if (error.upstreamStatus === 404) return { absent: true }; if (refusal(error)) return { unreadable: `HTTP_${error.upstreamStatus}` }; throw error; }
  };
  const remove = async uri => {
    try { const result = await call(`fs?${new URLSearchParams({ uri, recursive: 'false', wait: 'false' })}`, 'DELETE', { timeoutMs: 45000 }); if (result?.uri !== uri) throw cleanupError('MEMORY_CLEANUP_ROLLBACK_UNCONFIRMED'); return 'deleted'; }
    catch (error) { if (error.upstreamStatus === 404) return 'absent'; if (refusal(error)) return 'refused'; throw error; }
  };
  // OpenViking keeps a memory file's MEMORY_FIELDS comment when its body is replaced (content_write `_write_in_place`).
  const restore = async (uri, before) => {
    try {
      await call('content/write', 'POST', { body: { uri, content: before, mode: 'replace', wait: false }, timeoutMs: 30000 });
      const now = await read(uri);
      return now.absent ? 'absent' : now.body === before ? 'restored' : 'unverified';
    } catch (error) { if (error.upstreamStatus === 404) return 'absent'; if (refusal(error)) return 'refused'; throw error; }
  };
  const results = await rollbackOperations(operations, { read, remove, restore, inScope: uri => within(uri, memoryNamespace) && uri !== memoryNamespace, apply, overlay });
  const census = unit.turnId ? await taggedEvents(remote, unit.turnId) : undefined, listed = new Set(operations.map(op => op.uri));
  const unlisted = census ? census.filter(uri => !listed.has(uri)) : [];
  return { archives: found.archives.length, diffs: found.diffs.length, ...(found.unreadable.length ? { unreadable: found.unreadable.slice(0, REPORT_ROWS) } : {}), totals: totalsOf(results),
    left: results.filter(row => !settled(row.outcome)).slice(0, REPORT_ROWS).map(({ op, uri, outcome }) => ({ op, uri, outcome })),
    ...(unlisted.length ? { unlisted: unlisted.slice(0, REPORT_ROWS), unlistedCount: unlisted.length } : {}), ...(census === null ? { census: 'unavailable' } : {}) };
}

// -------------------------------------------------------------------------------------------- what a rewind captures
/**
 * The remote OpenViking sessions bound to what a rewind removes: those of the removed turns' memory writes (every segment
 * of a turn, and the earlier sessions a re-extraction left), those named by a binding's `turnId`, and those of settled
 * evidence records (a delivery or an answered card) whose source message is among the removed items. Newest first.
 * Pure; inside the rewind's transaction, before the turns are removed. A session that is already deleted is not listed.
 * @param {object} project
 * @param {object} session the conversation (its turns still there)
 * @param {{ turnIds: Set<string>, itemIds: Set<string> }} removed
 * @returns {{ sessionId: string, turnId?: string, evidenceId?: string, at: string, fingerprint?: string, archives?: string[], state: 'pending' }[]}
 */
export function rewoundMemoryUnits(project, session, { turnIds, itemIds }) {
  const bindings = new Map((project?.memorySessions ?? []).map(row => [row.sessionId, row])), units = new Map();
  const touch = (sessionId, { turnId = null, evidenceId = null, at = null, fingerprint = null, archives = [] } = {}) => {
    if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)) return;
    const binding = bindings.get(sessionId);
    if (binding?.status === 'deleted') return;
    const unit = units.get(sessionId) ?? { sessionId, ...(turnId ? { turnId } : {}), ...(evidenceId ? { evidenceId } : {}), at: at && Number.isFinite(Date.parse(at)) ? iso(at) : iso(0), state: 'pending' };
    // The binding's own fingerprint is the one cleanup checks the connection against; the record's is only a fallback.
    const print = binding?.connectionFingerprint ?? fingerprint ?? null; if (print && !unit.fingerprint) unit.fingerprint = print;
    const known = new Set(unit.archives ?? []); for (const uri of archives) if (typeof uri === 'string' && uri.startsWith('viking://') && known.size < 20) known.add(uri);
    if (known.size) unit.archives = [...known];
    if (turnId && !unit.turnId) unit.turnId = turnId;
    units.set(sessionId, unit);
  };
  for (const turn of session?.turns ?? []) if (turnIds.has(turn.id)) {
    const at = turn.startedAt ?? turn.createdAt;
    for (const { write } of memoryWriteRecords(turn)) {
      if (!write || typeof write !== 'object') continue;
      touch(write.sessionId, { turnId: turn.id, at, fingerprint: write.connectionFingerprint, archives: [write.archiveUri] });
      for (const previous of write.reextract?.previous ?? []) touch(previous?.sessionId, { turnId: turn.id, at, fingerprint: write.connectionFingerprint, archives: [previous?.archiveUri] });
    }
  }
  for (const binding of project?.memorySessions ?? []) if (binding.turnId && turnIds.has(binding.turnId) && binding.sourceSessionId === session?.id) touch(binding.sessionId, { turnId: binding.turnId, at: binding.createdAt });
  // Evidence is archived in its own remote session; a record still in flight is left (its poll goes on), the others are bound to their source message.
  for (const write of session?.memoryEvidenceOutbox ?? []) if (['completed', 'failed', 'abandoned'].includes(write?.status) && itemIds.has(write.sourceRefs?.[0]?.itemId)) touch(write.sessionId, { evidenceId: write.id, at: write.createdAt, fingerprint: write.connectionFingerprint, archives: [write.archiveUri] });
  return [...units.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/**
 * The revocation entries a rewind writes for the remote sessions it released (`message_rewound`, `memory: [unit…]`), in
 * the rewind's own transaction, so a restart between the rewind and the cleanup finishes the work. Returns the entries.
 * A failure part way (the entries before it ARE written) throws with `recorded`: the entries written so far, so the caller
 * can tell what was released and what was not.
 */
export function recordRewoundMemory(project, sessionId, units, { now = Date.now() } = {}) {
  if (!project || !units.length) return [];
  const mind = ensureMind(project, now), entries = [];
  for (let at = 0; at < units.length; at += UNITS_PER_ENTRY) {
    try { entries.push(recordRevocation(mind, { type: 'message_rewound', sessionId, memory: units.slice(at, at + UNITS_PER_ENTRY) }, { now })); }
    catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { recorded: entries }); }
  }
  return entries;
}

/**
 * A rewind's capture, in its transaction: finds the remote sessions bound to what is removed (`rewoundMemoryUnits`) and
 * records them (`recordRewoundMemory`). Returns { units, failed? }: the units that ARE recorded, and when something went
 * wrong { code, notReleased } (how many sessions were left unreleased, null when they could not even be listed). Never
 * throws: the user's edit goes through whatever the memory side finds, but the failure is said, not swallowed.
 */
export function captureRewoundMemory(project, session, removed, { now = Date.now() } = {}) {
  let found = null;
  try {
    found = project ? rewoundMemoryUnits(project, session, removed) : [];
    if (found.length) recordRewoundMemory(project, session.id, found, { now });
    return { units: found };
  } catch (error) {
    const written = (Array.isArray(error?.recorded) ? error.recorded : []).reduce((count, entry) => count + (entry.memory?.length ?? 0), 0), units = found ? found.slice(0, written) : [];
    return { units, failed: { code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : 'MEMORY_REWIND_CAPTURE_FAILED', notReleased: found ? found.length - units.length : null } };
  }
}

/** What a revocation entry's remote sessions came to, as one report: { sessions, deleted, kept, totals, left, unlisted, unreadable }. */
export function summarizeUnits(units) {
  const out = { sessions: units.length, deleted: 0, kept: [], totals: {}, left: [], unlisted: [], unreadable: [] };
  for (const unit of units) {
    if (unit.state === 'deleted') out.deleted++; else if (unit.state === 'kept') out.kept.push({ sessionId: unit.sessionId, code: unit.code ?? null });
    addTotals(out.totals, unit.report?.totals);
    for (const row of unit.report?.left ?? []) if (out.left.length < SUMMARY_ROWS) out.left.push(row);
    for (const uri of unit.report?.unlisted ?? []) if (out.unlisted.length < SUMMARY_ROWS) out.unlisted.push(uri);
    for (const row of unit.report?.unreadable ?? []) if (out.unreadable.length < SUMMARY_ROWS) out.unreadable.push({ sessionId: unit.sessionId, ...row });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- the handler
export class MemoryRewind {
  /**
   * `deadlineMs`: the time one remote session's cleanup may take (its tasks, its diffs, its rollback, its deletion).
   * `previewSessionMs` / `previewBudgetMs`: the same for a dry run, one session and all of them.
   */
  constructor(store, { deadlineMs = 120000, previewSessionMs = PREVIEW_SESSION_MS, previewBudgetMs = PREVIEW_BUDGET_MS, now = Date.now } = {}) { Object.assign(this, { store, deadlineMs, previewSessionMs, previewBudgetMs, now }); }
  get service() { return this.store.memoryService; }
  /** The handler registered with the revocation dispatcher for `message_rewound` (a deleted conversation keeps its extracted memory and is not in this list). */
  revocationHandler() {
    return {
      name: 'openviking', events: ['message_rewound'],
      settle: (entry, ctx) => this.settle(entry, ctx),
      // The final assertion: no remote session of a removed turn is left, unless it could not be told apart from another account's.
      assert: entry => (entry.memory ?? []).filter(unit => unit.state === 'kept').map(unit => ({ subsystem: 'memory', collection: 'remote_sessions', id: unit.sessionId, why: unit.code ?? 'remote_session_kept' })),
    };
  }
  /**
   * Once per start: an entry a version without this handler settled (or one that ran out of attempts under an older release)
   * while remote sessions were still to be released is open again (a rollback to 0.68.0 and an upgrade again must not lose the
   * work: that version settles `message_rewound` entries without it). Idempotent. Returns how many entries it reopened.
   */
  reopen() {
    const open = entry => entry?.type === 'message_rewound' && Array.isArray(entry.memory) && entry.memory.some(unit => !FINAL.has(unit.state)) && (entry.settledAt || entry.failed);
    const found = this.store.state.projects.flatMap(project => (project.mind?.revocations ?? []).filter(open).map(entry => [project.id, entry.id]));
    if (!found.length) return 0;
    this.store.mutate(state => {
      for (const [projectId, entryId] of found) {
        const row = state.projects.find(project => project.id === projectId)?.mind?.revocations?.find(entry => entry.id === entryId);
        if (row) { for (const key of ['settledAt', 'failed', 'failure', 'retryAt', 'waiting']) delete row[key]; Object.assign(row, { steps: {}, attempts: 0 }); delete row.result; }
      }
    });
    return found.length;
  }
  recordOf(project, entry, binding, unit) {
    return { sessionId: entry.sessionId, projectId: project.id, bindings: [structuredClone(binding)], connectionFingerprint: unit.fingerprint ?? binding.connectionFingerprint ?? null };
  }
  /**
   * Another open `message_rewound` entry of the project that still has a unit to settle which is newer than `unit`
   * (a strictly newer turn: two units of one moment have no order to keep). Entries a version without this handler settled
   * do not count: `reopen()` opens them again at the next start.
   */
  newerPending(project, entry, unit) {
    const at = Date.parse(unit.at) || 0;
    for (const other of project?.mind?.revocations ?? []) {
      if (other.id === entry.id || other.type !== 'message_rewound' || other.settledAt || !Array.isArray(other.memory)) continue;
      if (other.memory.some(row => !FINAL.has(row.state) && (Date.parse(row.at) || 0) > at)) return true;
    }
    return false;
  }
  async settle(entry, ctx) {
    if (!Array.isArray(entry.memory) || !entry.memory.length) return null;
    // Writes to the memory service wait while the application is held for maintenance or a restore is under review, like
    // every other memory write; a wait is not a failure and costs no attempt (the dispatcher's deferral).
    const gate = () => { const paused = memoryWritesPaused(this.store); if (paused) throw deferral(paused); };
    gate();
    const save = (unit, changes) => ctx.store.mutate(state => {
      const row = state.projects.find(project => project.id === ctx.projectId)?.mind?.revocations?.find(item => item.id === entry.id)?.memory?.find(item => item.sessionId === unit.sessionId);
      if (row) { Object.assign(row, changes); if (changes.state === 'deleted' || changes.state === 'kept') delete row.archives; }
      // The memory page's "content changed" signal (the project's memory revision) moves when memories were deleted or restored.
      const touched = (changes.report?.totals?.deleted ?? 0) + (changes.report?.totals?.restored ?? 0);
      if (touched > 0) noteMemoryRevision(state, ctx.projectId, { taskId: `rewind:${entry.id}:${unit.sessionId}`, sessionId: unit.sessionId }, ctx.now());
      if (changes.state === 'deleted') { const binding = state.projects.find(project => project.id === ctx.projectId)?.memorySessions?.find(item => item.sessionId === unit.sessionId); if (binding) Object.assign(binding, { status: 'deleted', deletedAt: iso(ctx.now()), sourceSessionId: null }); }
    });
    let transient = null;
    for (const unit of [...entry.memory].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
      if (FINAL.has(unit.state)) continue;
      if (ctx.signal?.aborted) return null;
      gate();
      // Newest first matters: an older turn's memories can only be undone once the newer turns' changes to them are, and that
      // holds across entries too (the live state is read at each unit: another entry may have settled meanwhile).
      if (this.newerPending(ctx.project(), entry, unit)) throw deferral('MEMORY_REWIND_WAITS_FOR_NEWER');
      try { save(unit, await this.settleUnit(entry, unit, ctx)); }
      catch (error) {
        if (ctx.signal?.aborted) return null;
        if (error?.defer === true) throw error;
        if (PERMANENT.has(error.code)) { save(unit, { state: 'kept', code: error.code }); continue; }
        // Nothing older is settled (and its diffs deleted) after a failure; the retry starts here.
        transient = error; break;
      }
    }
    if (transient) throw transient;
    return summarizeUnits(ctx.project()?.mind?.revocations?.find(item => item.id === entry.id)?.memory ?? entry.memory);
  }
  async settleUnit(entry, unit, ctx) {
    const project = ctx.project(), binding = project?.memorySessions?.find(row => row.sessionId === unit.sessionId);
    if (!project || !binding) throw cleanupError('MEMORY_REWIND_BINDING_MISSING');
    if (binding.status === 'deleted') return { state: 'deleted' };
    const record = this.recordOf(project, entry, binding, unit);
    const result = await this.service.deleteSessionArchive(record, record.bindings[0], { signal: ctx.signal, deadlineMs: this.deadlineMs, beforeDelete: remote => this.rollback(remote, unit, { apply: true }) });
    return { state: 'deleted', ...(result.rollback ? { report: result.rollback } : {}) };
  }
  /** A rollback failure other than a refusal is a service problem: the session stays and the step is retried. */
  async rollback(remote, unit, { apply }) {
    try { return await inspectUnit(remote, unit, { apply }); }
    catch (error) {
      if (/^MEMORY_CLEANUP_[A-Z_]+$/.test(error.code ?? '')) throw error;
      throw cleanupError('MEMORY_CLEANUP_ROLLBACK_UNAVAILABLE');
    }
  }
  /**
   * The dry run: what a rewind of `units` (rewoundMemoryUnits) would do to OpenViking, read-only, one report per remote
   * session. A session that cannot be looked at (the service is down, the binding is gone, the account changed) says so.
   * Writes nothing and cancels nothing. It is bounded: one session at most `previewSessionMs`, all of them `previewBudgetMs`
   * (the sessions not reached are counted in `omittedSessions` with `omitted: 'time_budget'`), and `signal` (the client that
   * asked went away) ends it at once by throwing.
   */
  async preview(project, sessionId, units, { signal } = {}) {
    const sessions = [], overlay = new Map(), started = this.now(), looked = units.slice(0, PREVIEW_UNITS);
    let reached = 0;
    for (const unit of looked) {
      signal?.throwIfAborted();
      if (this.now() - started >= this.previewBudgetMs) break;
      reached++;
      const head = { sessionId: unit.sessionId, ...(unit.turnId ? { turnId: unit.turnId } : {}), ...(unit.evidenceId ? { evidenceId: unit.evidenceId } : {}) };
      const binding = project?.memorySessions?.find(row => row.sessionId === unit.sessionId);
      if (!binding) { sessions.push({ ...head, error: 'MEMORY_REWIND_BINDING_MISSING' }); continue; }
      try {
        const record = this.recordOf(project, { sessionId }, binding, unit);
        sessions.push({ ...head, ...await this.service.inspectSession(record, record.bindings[0], { signal, deadlineMs: Math.min(this.previewSessionMs, Math.max(1, this.previewBudgetMs - (this.now() - started))), inspect: remote => inspectUnit(remote, unit, { apply: false, overlay }) }) });
      } catch (error) { if (signal?.aborted) throw error; sessions.push({ ...head, error: /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : 'MEMORY_CLEANUP_UNAVAILABLE' }); }
    }
    const totals = {}; for (const row of sessions) addTotals(totals, row.totals);
    const omitted = units.length - reached;
    return { sessions, totals, ...(omitted > 0 ? { omittedSessions: omitted, ...(reached < looked.length ? { omitted: 'time_budget' } : {}) } : {}) };
  }
}
