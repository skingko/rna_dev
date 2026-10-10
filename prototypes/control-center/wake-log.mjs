import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWrite } from './durable-files.mjs';
import { metricsRoot } from './metrics-rollup.mjs';

/**
 * The wake rows (plan 2026-10-05 C2, §1.3 H): every background wake a project recorded, in one append-only JSONL file in
 * `<state>.rna/metrics/` (inside the journal root every release inventories, so no new top-level `<state>.<name>`
 * sibling exists for an older release's checkpoint to refuse). Before 0.69 they were the last 50 rows of
 * `mind.pacing.wake.history` in hot state: about two days of a busy project, rewritten with every wake, and with no room
 * for what C2 adds to a row (the tier computed from facts, the action it admitted, the judgment rows that wake came from).
 *
 * - The daily counts are not kept here: B7's wake rollup (`wakes-daily.json`, proactive-metrics.mjs foldWakes) folds each
 *   wake as it is recorded and holds the days this file no longer does. This file holds the rows themselves, for
 *   LOG_DAYS, so a row can be read by the action it started (a late outcome finds the wake that decided it).
 * - State keeps only the newest WAKE_STATE_TAIL rows (display, the rollup's fold and a rollback: a release before 0.69
 *   reads and appends `history` there). A start imports whatever such a release wrote since (`absorb`), so a rollback
 *   followed by an upgrade loses no row.
 * - Lines of a kind this release does not know are kept through rewrites (a later release's rows survive a rollback).
 * Counts, codes and ids only: no prompt, message text, key or provider response ever reaches this file.
 */
export const wakeLogFile = stateFile => join(metricsRoot(stateFile), 'wakes.jsonl');
/** Rows are kept this many days: a 30-day report plus today (the decision ledger's retention). */
export const WAKE_LOG_DAYS = 31;
/** The newest rows hot state keeps on `mind.pacing.wake.history` once the log holds the rest. */
export const WAKE_STATE_TAIL = 8;
const DAY = 86400000;
const atOf = value => { const at = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(at) ? at : NaN; };
/** A row's identity: the instant it was recorded, how it ended and the action it admitted (a restart reads the same row twice). */
export const wakeRowKey = row => `${row?.at}|${row?.outcome}|${row?.actionId ?? ''}`;

export class WakeLog {
  constructor({ file = null, now = Date.now, retentionDays = WAKE_LOG_DAYS } = {}) {
    Object.assign(this, { file, now, retentionDays });
    // projectId → rows, oldest first; `keys` makes an append idempotent; `byAction` is the lookup a late outcome uses.
    this.projects = new Map(); this.keys = new Set(); this.byActionId = new Map(); this.unknown = []; this.appended = 0; this.unsaved = false;
    if (!file) return;
    let lines = []; try { lines = readFileSync(file, 'utf8').split('\n'); } catch { lines = []; }
    this.load(lines);
    this.prune();
  }
  load(lines) {
    for (const line of lines) {
      if (!line) continue;
      let value; try { value = JSON.parse(line); } catch { continue; }
      if (value?.t === 'wake' && typeof value.projectId === 'string' && value.row && typeof value.row === 'object') this.put(value.projectId, value.row);
      else this.unknown.push(line);
    }
    this.appended += lines.filter(Boolean).length;
    return this;
  }
  put(projectId, row) {
    const key = `${projectId}|${wakeRowKey(row)}`;
    if (this.keys.has(key) || !Number.isFinite(atOf(row.at))) return false;
    this.keys.add(key);
    const rows = this.projects.get(projectId) ?? []; rows.push(row); this.projects.set(projectId, rows);
    if (typeof row.actionId === 'string' && row.actionId) this.byActionId.set(`${projectId}|${row.actionId}`, row);
    return true;
  }
  /**
   * Record one wake row (a copy). Returns whether it is new AND on disk: false for a row already held, and false when the
   * file could not be written (a full disk), so a caller that trims its own copy of the rows past a tail (the controller's
   * `mind.pacing.wake.history`) keeps them until they are safe here. The row stays in memory either way; after a failed
   * write the next append rewrites the whole file from memory (every row held, atomically) and the log is whole again.
   */
  append(projectId, row) {
    if (typeof projectId !== 'string' || !projectId || !row || typeof row !== 'object') return false;
    const copy = structuredClone(row);
    if (!this.put(projectId, copy)) return false;
    const saved = this.unsaved ? this.rewrite() : this.write({ t: 'wake', projectId, row: copy });
    // Expired rows leave in daily batches (one rewrite a day, not one per wake); a file grown by appends is compacted.
    const oldest = atOf(this.oldest());
    if (oldest < this.now() - (this.retentionDays + 1) * DAY || this.appended > 4 * this.size() + 2000) this.prune({ rewrite: true });
    return saved || !this.unsaved;
  }
  /** Append one line; false when it could not be written (`unsaved` then says the file is behind memory). */
  write(value) {
    if (!this.file) return true;
    try { mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }); appendFileSync(this.file, `${JSON.stringify(value)}\n`, { mode: 0o600 }); this.appended++; return true; } catch { this.unsaved = true; return false; /* telemetry never blocks a wake */ }
  }
  size() { let total = 0; for (const rows of this.projects.values()) total += rows.length; return total; }
  oldest() { let first = null; for (const rows of this.projects.values()) if (rows.length && (first === null || atOf(rows[0].at) < atOf(first.at))) first = rows[0]; return first?.at ?? null; }
  /** A project's rows, oldest first, at or after `since` (ms). */
  rows(projectId, { since = -Infinity, limit = Infinity } = {}) {
    const rows = (this.projects.get(projectId) ?? []).filter(row => atOf(row.at) >= since);
    return Number.isFinite(limit) ? rows.slice(-limit) : rows;
  }
  /** The wake that admitted this action (the decision it came from), or null. */
  byAction(projectId, actionId) { return this.byActionId.get(`${projectId}|${actionId}`) ?? null; }
  /** Rows older than the retention leave; the file is rewritten from memory (atomic), unknown lines kept. */
  prune({ rewrite = false } = {}) {
    const cutoff = this.now() - this.retentionDays * DAY;
    let left = 0;
    for (const [projectId, rows] of this.projects) {
      const kept = rows.filter(row => atOf(row.at) >= cutoff);
      if (kept.length === rows.length) continue;
      for (const row of rows) if (!(atOf(row.at) >= cutoff)) { this.keys.delete(`${projectId}|${wakeRowKey(row)}`); if (row.actionId) this.byActionId.delete(`${projectId}|${row.actionId}`); left++; }
      if (kept.length) this.projects.set(projectId, kept); else this.projects.delete(projectId);
    }
    if (left || rewrite) return this.rewrite();
    return true;
  }
  /** The file rewritten from memory (atomic): rows oldest first per project, then the unknown lines. */
  rewrite() {
    if (!this.file) { this.appended = this.size(); this.unsaved = false; return true; }
    const cutoff = this.now() - this.retentionDays * DAY;
    const unknown = this.unknown.filter(line => { try { const at = atOf(JSON.parse(line)?.at ?? JSON.parse(line)?.row?.at); return !Number.isFinite(at) || at >= cutoff; } catch { return false; } });
    const lines = [...[...this.projects].flatMap(([projectId, rows]) => rows.map(row => JSON.stringify({ t: 'wake', projectId, row }))), ...unknown];
    try { atomicWrite(this.file, lines.length ? `${lines.join('\n')}\n` : ''); this.unknown = unknown; this.appended = lines.length; this.unsaved = false; return true; } catch { return false; }
  }
  /** A deleted project's wakes go with it (counts and codes only, but the deletion promise covers them too). */
  removeProject(projectId) {
    const rows = this.projects.get(projectId); if (!rows) return 0;
    for (const row of rows) { this.keys.delete(`${projectId}|${wakeRowKey(row)}`); if (row.actionId) this.byActionId.delete(`${projectId}|${row.actionId}`); }
    this.projects.delete(projectId);
    this.rewrite();
    return rows.length;
  }
  /**
   * Startup (and again after a rollback to a release before 0.69 and an upgrade back): the rows hot state still holds on
   * `mind.pacing.wake.history` that this file does not (an older release wrote them) move into the file, and the history
   * shrinks to its tail. The rows are on disk before state forgets them; a failed write leaves state as it was. Idempotent:
   * a second call, and a state with nothing beyond the tail, write nothing. Returns how many rows were imported.
   */
  absorb(store, { tail = WAKE_STATE_TAIL } = {}) {
    let imported = 0;
    for (const project of store?.state?.projects ?? []) {
      const history = project.mind?.pacing?.wake?.history;
      if (!Array.isArray(history) || !history.length) continue;
      for (const row of history) if (row && typeof row === 'object' && this.put(project.id, structuredClone(row))) { imported++; this.unsaved = true; }
    }
    if (imported) for (const rows of this.projects.values()) rows.sort((a, b) => atOf(a.at) - atOf(b.at));
    // The imported rows are on disk first (a rewrite), only then may state drop any of them.
    if (this.unsaved && !this.rewrite()) return 0;
    const over = (store?.state?.projects ?? []).some(project => (project.mind?.pacing?.wake?.history?.length ?? 0) > tail);
    if (over) try { store.mutate(state => { for (const project of state.projects) { const wake = project.mind?.pacing?.wake; if (Array.isArray(wake?.history) && wake.history.length > tail) wake.history = wake.history.slice(-tail); } }); } catch { /* the import is idempotent: the next start retries */ }
    return imported;
  }
}

/** The rows of a wake log file, read only (benchmarks read copies of it through this); {} without one. Project id → rows. */
export function readWakeLog(file) {
  let text = ''; try { text = readFileSync(file, 'utf8'); } catch { return {}; }
  const log = new WakeLog({ retentionDays: Infinity }).load(text.split('\n'));
  return Object.fromEntries(log.projects);
}
