import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './durable-files.mjs';
import { appTimeZone, addDays, dayKeyer, localDay } from './metric-windows.mjs';

/**
 * Durable metrics live in `<state>.rna/metrics/` (plan 2026-10-05 B7): inside the journal root, which every release since
 * 0.21 inventories, so no new top-level `<state>.<name>` sibling exists for an older release's checkpoint to refuse
 * (the 0.43.0 `checkpoint_unknown_sidecar` incident). Counts only: no prompt, text or credential reaches these files.
 */
export const metricsRoot = stateFile => join(`${stateFile}.rna`, 'metrics');
/** Daily rollups are kept at least this long: 13 months plus the open month. */
export const ROLLUP_RETENTION_DAYS = 400;

const plainKey = key => JSON.stringify(Object.keys(key).sort().filter(name => key[name] !== undefined && key[name] !== null && key[name] !== false).map(name => [name, key[name]]));
const add = (target, values) => {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'number' && Number.isFinite(value)) { if (name.startsWith('max')) target[name] = Math.max(target[name] ?? -Infinity, value); else target[name] = (target[name] ?? 0) + value; }
    else if (value && typeof value === 'object') add(target[name] ??= {}, value);
  }
  return target;
};
/** Sum several value objects (numbers add, `max*` keep the largest, nested objects merge); used for rollup cells and live cells alike. */
export const sumValues = (rows, into = {}) => { for (const row of rows) add(into, row); return into; };

/** The file format this release writes (`version`); `fold` is the fold function's own version, per kind. */
export const ROLLUP_FORMAT = 1;
/**
 * A versioned daily fold (harness session-projection-cache: possibly stale, never wrong, never ahead of the log).
 * `days[localDay]` holds cells `{ k: key, v: values }`. Sources fold rows exactly once by a watermark kept in the same
 * atomic file (`marks[source]`): a row is in the rollup if and only if it is older than its source's mark, so a crash
 * between writing the rollup and pruning the raw rows neither loses nor double-counts anything. The writer must flush
 * before it drops raw rows (`flush()` is synchronous and durable).
 *
 * A file this release cannot read as its own — a later format or fold version (a rollback from a later release), or
 * another kind — is never replaced: it holds up to 400 days the raw rows no longer do. The rollup is then `readOnly`
 * (its reason): empty to this release (no cells, no watermark, so readers count the raw rows only), it folds nothing,
 * notes nothing and never writes, and `flush()` succeeds at once, so writers drop expired raw rows as a release without
 * a rollup did (the cost of a rollback to 0.68 too: the later release, back, finds the usage rows gone after the oldest
 * one it noted and records the gap). A project deleted meanwhile keeps its counts (ids and numbers, no content) there.
 */
export class DailyRollup {
  constructor({ file = null, kind, foldVersion = 1, now = Date.now, timeZone = appTimeZone(), retentionDays = ROLLUP_RETENTION_DAYS } = {}) {
    Object.assign(this, { file, kind, foldVersion, now, timeZone, retentionDays });
    this.days = new Map(); this.marks = {}; this.raw = {}; this.gaps = []; this.dirty = false; this.timeZones = []; this.readOnly = null;
    if (!file) return;
    let saved = null;
    try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { saved = null; }
    // Only what the file positively declares makes it read-only; a shape without a version is this release's to replace.
    const version = Number(saved?.version), fold = Number(saved?.fold);
    const newer = version > ROLLUP_FORMAT || version === ROLLUP_FORMAT && saved.kind === kind && fold > foldVersion, foreign = typeof saved?.kind === 'string' && saved.kind !== kind;
    if (newer || foreign) { this.readOnly = newer ? 'newer_version' : 'other_kind'; return; }
    // An older fold of this kind (this release changed how rows fold) is replaced: the raw rows still on disk fold again
    // from scratch (watermarks reset, so nothing counts twice), and the loss of older days is recorded.
    if (saved?.version === ROLLUP_FORMAT && saved.kind === kind && saved.fold === foldVersion) {
      for (const [day, cells] of Object.entries(saved.days ?? {})) if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Array.isArray(cells)) this.days.set(day, new Map(cells.filter(cell => cell && typeof cell.k === 'object' && typeof cell.v === 'object').map(cell => [plainKey(cell.k), { k: cell.k, v: cell.v }])));
      this.marks = saved.marks && typeof saved.marks === 'object' ? saved.marks : {};
      this.raw = saved.raw && typeof saved.raw === 'object' ? saved.raw : {};
      this.gaps = Array.isArray(saved.gaps) ? saved.gaps.slice(-50) : [];
      this.timeZones = Array.isArray(saved.timeZones) ? saved.timeZones.slice(-20) : [];
      // A time-zone change keeps the days already closed under the old zone; only days folded from now on use the new one.
      if (saved.timeZone && saved.timeZone !== timeZone) { this.timeZones.push({ at: new Date(now()).toISOString(), from: saved.timeZone, to: timeZone }); this.dirty = true; }
    } else if (saved) { this.gaps.push({ reason: 'fold_version', at: new Date(now()).toISOString(), previous: { kind: saved.kind ?? null, fold: saved.fold ?? null } }); this.dirty = true; }
  }
  /** Watermark of one source: every row of that source older than this instant is folded (null: nothing yet). */
  mark(source) { const value = this.marks[source]; return Number.isFinite(value) ? value : null; }
  /** Whether this release may fold into the file (not `readOnly`). */
  get writable() { return this.readOnly === null; }
  /**
   * The oldest raw row of a source not folded yet, as its writer last left it (null: none). The writer keeps that row in
   * its raw file until it folds it, so a later start that finds the file's oldest unfolded row newer knows another
   * release deleted rows unfolded (a rollback) and records that as a gap; an empty stretch after the watermark is not one.
   */
  rawOldest(source) { const value = this.raw[source]; return Number.isFinite(value) ? value : null; }
  noteRaw(source, at) { if (!this.writable) return; const value = Number.isFinite(at) ? at : null; if ((this.raw[source] ?? null) !== value) { this.raw[source] = value; this.dirty = true; } }
  /** Fold rows (each `{ at, key, values }`) and advance the source's watermark to `through` (all folded rows are older). */
  fold(source, rows, through) {
    if (!this.writable) return;
    const keyOf = dayKeyer(this.timeZone);
    for (const row of rows) {
      if (!Number.isFinite(row.at)) continue;
      const day = keyOf(row.at), cells = this.days.get(day) ?? new Map(), id = plainKey(row.key);
      const cell = cells.get(id) ?? { k: Object.fromEntries(Object.entries(row.key).filter(([, value]) => value !== undefined && value !== null && value !== false)), v: {} };
      add(cell.v, row.values); cells.set(id, cell); this.days.set(day, cells);
    }
    if (Number.isFinite(through) && through > (this.mark(source) ?? -Infinity)) this.marks[source] = through;
    if (rows.length || Number.isFinite(through)) this.dirty = true;
  }
  /** Raw rows of a source that were dropped without being folded (an older release pruned them): an honest hole. */
  gap(source, from, to) {
    if (!this.writable || !(Number.isFinite(from) && Number.isFinite(to) && to > from)) return;
    // The same hole seen again (each start until the watermark moves past it) widens the one already noted.
    const start = new Date(from).toISOString(), end = new Date(to).toISOString(), known = this.gaps.find(row => row.source === source && row.from === start);
    if (known) { if (end > known.to) { known.to = end; this.dirty = true; } return; }
    this.gaps.push({ source, from: start, to: end }); this.gaps = this.gaps.slice(-50); this.dirty = true;
  }
  /** Cells of the local days in [firstDay, lastDay], filtered by `keep(key)`. */
  cells({ firstDay = '0000-01-01', lastDay = '9999-12-31', keep = () => true } = {}) {
    const out = [];
    for (const [day, cells] of this.days) if (day >= firstDay && day <= lastDay) for (const cell of cells.values()) if (keep(cell.k)) out.push({ day, k: cell.k, v: cell.v });
    return out;
  }
  /** First local day held, or null. */
  firstDay() { let first = null; for (const day of this.days.keys()) if (first === null || day < first) first = day; return first; }
  /** Deleting a project removes its rows (counts only, but the deletion promise covers them too). */
  removeProject(projectId) {
    let removed = 0;
    for (const [day, cells] of this.days) { for (const [id, cell] of cells) if (cell.k.projectId === projectId) { cells.delete(id); removed++; } if (!cells.size) this.days.delete(day); }
    if (removed) this.dirty = true;
    return removed;
  }
  prune() {
    const cutoff = addDays(localDay(this.now(), this.timeZone), -this.retentionDays);
    for (const day of [...this.days.keys()]) if (day < cutoff) { this.days.delete(day); this.dirty = true; }
  }
  toJSON() {
    const days = Object.fromEntries([...this.days.keys()].sort().map(day => [day, [...this.days.get(day).values()]]));
    return { version: 1, kind: this.kind, fold: this.foldVersion, timeZone: this.timeZone, updatedAt: new Date(this.now()).toISOString(), marks: this.marks, raw: this.raw, gaps: this.gaps, timeZones: this.timeZones, days };
  }
  /** Durable before returning (atomic rename + fsync); a failure leaves the previous file and the dirty flag. */
  flush() {
    if (!this.dirty || !this.writable) return true;
    this.prune();
    if (!this.file) { this.dirty = false; return true; }
    try { atomicWrite(this.file, JSON.stringify(this.toJSON())); this.dirty = false; return true; } catch { return false; }
  }
}
