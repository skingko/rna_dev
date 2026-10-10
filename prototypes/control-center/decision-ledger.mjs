import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWrite } from './durable-files.mjs';
import { metricsRoot } from './metrics-rollup.mjs';

/**
 * The JEV decision ledger, out of the hot persisted state (plan 2026-10-05 B7, §1.3 H): one append-only JSONL file in
 * `<state>.rna/metrics/` (inside the journal root every release inventories). Before 0.69 it lived in
 * `state.decisionKernelRuntime` as a 200-row `recent` window, a 30-day `index` and `labels`, so every judgment rewrote
 * state, travelled with /api/state, and reports read truncated rows. Now:
 * - rows: every judgment for LEDGER_DAYS; the newest FULL_ROWS keep their full detail (as the hot window did), older ones
 *   a compact form that still carries what calibration, labels and reports read (predictions, observed values, label
 *   and its source, scope, small outcomes);
 * - labels and observed values are appended as their own lines and merged on load (harness: the fold is never ahead of
 *   the log), so a label that arrives days later still finds its row;
 * - lines of a kind this release does not know are kept through rewrites (a later release's rows survive a rollback).
 * Counts, probabilities and ids only: never state, prompts, provider responses, keys or free text.
 */
export const decisionLedgerFile = stateFile => join(metricsRoot(stateFile), 'decision-ledger.jsonl');
/** Rows are kept this many days: a 30-day report plus today. */
export const LEDGER_DAYS = 31;
/** The newest rows keep full detail (the size of the hot window before the move). */
export const FULL_ROWS = 200;
/** Largest ledger page (harness and zcode page history by at most 200). */
export const LEDGER_PAGE_MAX = 200;
const DAY = 86400000;

/**
 * Where a label comes from (cross-batch constraint 3: calibration labels come from outcomes and user actions, not from
 * the model's own next step). `outcome`: something happened or the user acted (a reply, a dismissal, a confirmation, a
 * return, a retirement); `self`: the system's own following decision, not something that happened (wake_needed_*, wake_unneeded,
 * defer_* from the main model's next decision; folded, an invitation the judgment itself closed as stale);
 * `heuristic`: inferred from the absence of a correction (drift_clear, necessity_right, applied_right, gene_active,
 * drift_steered). Label codes are a closed host vocabulary, so this is a table, not a judgment. A caller that knows better
 * names the source (C2's outcome wake labels will pass `outcome`).
 * PDL-7 (B3): a `self` label is kept for reading but never calibrated (no observation, Brier or bucket) and never counted
 * as label coverage; it never replaces an outcome or heuristic label, and any of those replaces it (applyLabel).
 */
export const LABEL_SOURCES = Object.freeze(['outcome', 'self', 'heuristic']);
const SELF_LABELS = new Set(['wake_unneeded', 'defer_missed', 'defer_right', 'folded']);
const HEURISTIC_LABELS = new Set(['drift_clear', 'drift_steered', 'necessity_right', 'applied_right', 'gene_active']);
export const labelSourceOf = value => typeof value !== 'string' ? 'outcome' : value.startsWith('wake_needed_') || SELF_LABELS.has(value) ? 'self' : HEURISTIC_LABELS.has(value) ? 'heuristic' : 'outcome';
/**
 * A stored label's source: the one it carries, else `self` for a label B3 flagged `provisional` (PDL-7: the same thing
 * under its earlier name, written to state before the ledger moved out), else by the label table (labels an older
 * release wrote carry neither).
 */
export const labelSource = label => !label || typeof label !== 'object' ? null : LABEL_SOURCES.includes(label.source) ? label.source : label.provisional === true ? 'self' : labelSourceOf(label.value);
/** A `self` label (PDL-7): kept for reading, never calibrated (no observation, Brier or bucket), never counted as label coverage. */
export const selfLabel = label => labelSource(label) === 'self';
/**
 * Points whose calibration observation is read from the row's label (decision-calibration-report.mjs pendingObservations);
 * the others are observed from what happened in state. An observation on one of these whose label is `self` was taken
 * from the model's own next step, not from an outcome: it is dropped (B3's PDL-7 migration; see dropSelfObservations).
 */
export const LABEL_OBSERVED_POINTS = Object.freeze(new Set(['delivery.reach', 'initiative.review', 'initiative.gate', 'message.value', 'turn.settled', 'feedback.signal', 'tool.risk', 'turn.drift', 'ask.necessity', 'gene.review']));
/** Whether a row's observation came from a self label (and so must not be calibrated). */
export const selfObserved = row => Boolean(row?.observed) && LABEL_OBSERVED_POINTS.has(row.point) && selfLabel(row.label);

const finite = value => typeof value === 'number' && Number.isFinite(value);
const atOf = value => { const at = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(at) ? at : NaN; };
const pick = (row, keys) => Object.fromEntries(keys.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
const COMPACT_KEYS = ['id', 'at', 'point', 'backend', 'source', 'mode', 'reason', 'disposition', 'decided', 'applied', 'networkAttempted', 'cached', 'coalesced', 'latencyMs', 'predictions', 'observed', 'label', 'savings', 'planRevision', 'supplementRevision', 'indexed'];
const SCOPE_KEYS = ['projectId', 'sessionId', 'turnId', 'spillId', 'ranges'];
/** The compact form of a row: what calibration, labels, observations and reports read. */
export function compactRow(row) {
  if (row.compact === true) return row;
  const outcome = row.outcome !== undefined && JSON.stringify(row.outcome ?? null).length <= 300 ? { outcome: row.outcome } : {};
  const usage = finite(row.usage?.inputTokens) || finite(row.usage?.outputTokens) ? { usage: pick(row.usage, ['inputTokens', 'outputTokens']) } : {};
  return { ...pick(row, COMPACT_KEYS), scope: pick(row.scope ?? {}, SCOPE_KEYS), ...(row.answers || row.scored ? { scored: true } : {}), ...usage, ...outcome, compact: true };
}

/** Per-day counts of rows leaving the ledger (kind 'decisions' rollup), for reports longer than LEDGER_DAYS. */
const rollupCell = row => ({ at: atOf(row.at), key: { projectId: row.scope?.projectId, point: row.point, source: row.source },
  // `labeled` counts outcome and heuristic labels only (label coverage, PDL-7); `labels` counts every source, self included.
  values: { decisions: 1, ...(row.source === 'judge' || row.source === 'rule' ? { judged: 1 } : {}), ...(row.label ? { ...(selfLabel(row.label) ? {} : { labeled: 1 }), labels: { [labelSource(row.label)]: 1 } } : {}), ...(row.observed && !selfObserved(row) ? { observed: 1 } : {}) } });

export class DecisionLedger {
  constructor({ file = null, now = Date.now, rollup = null, retentionDays = LEDGER_DAYS, fullRows = FULL_ROWS } = {}) {
    Object.assign(this, { file, now, rollup, retentionDays, fullRows });
    // `unsaved`: rows imported from state that only memory holds (their rewrite failed); state may not forget them yet.
    this.list = []; this.byId = new Map(); this.unknown = []; this.appended = 0; this.migrations = []; this.unsaved = false;
    if (!file) return;
    let lines = [];
    try { lines = readFileSync(file, 'utf8').split('\n'); } catch { lines = []; }
    this.load(lines);
    this.prune();
  }
  /** Merge a ledger file's lines into memory (rows, then their label and observed lines; other kinds kept as they are). */
  load(lines) {
    const mark = this.rollup?.mark('decisions') ?? null;
    for (const line of lines) {
      if (!line) continue;
      let value; try { value = JSON.parse(line); } catch { continue; }
      if (value?.t === 'row' && value.row && typeof value.row.id === 'string') {
        // Already counted in the rollup before a crash kept this file from being rewritten.
        if (mark !== null && atOf(value.row.at) < mark) continue;
        this.put(value.row);
      } else if (value?.t === 'label') this.applyLabel(value.id, { value: value.value, at: value.at, ...(value.source ? { source: value.source } : {}) });
      else if (value?.t === 'observed') { if (value.observed === null) this.clearObserved(value.id); else this.applyObserved(value.id, value.observed); }
      else if (value?.t === 'migration') this.migrations.push(value);
      else this.unknown.push(line);
    }
    this.sort();
    this.appended += lines.filter(Boolean).length;
    return this;
  }
  sort() { this.list.sort((a, b) => (atOf(a.at) || 0) - (atOf(b.at) || 0)); this.compactOld(); }
  /** Rows beyond the newest FULL_ROWS keep only their compact form. */
  compactOld() { for (let index = 0; index < this.list.length - this.fullRows; index++) if (this.list[index].compact !== true) { const row = compactRow(this.list[index]); this.list[index] = row; this.byId.set(row.id, row); } }
  put(row) {
    const known = this.byId.get(row.id);
    if (known) { if (known.compact === true && row.compact !== true) { const merged = { ...row, ...(known.label ? { label: known.label } : {}), ...(known.observed ? { observed: known.observed } : {}) }; this.list[this.list.indexOf(known)] = merged; this.byId.set(row.id, merged); } return false; }
    this.list.push(row); this.byId.set(row.id, row);
    return true;
  }
  /**
   * Set a row's label. PDL-7 (B3): a `self` label never writes over a label that is not `self` (an outcome stays the
   * outcome); any other label replaces a self label. Returns false when nothing was set.
   */
  applyLabel(id, label) {
    const row = this.byId.get(id); if (!row || typeof label?.value !== 'string') return false;
    const source = labelSource(label);
    if (source === 'self' && row.label && !selfLabel(row.label)) return false;
    row.label = { value: label.value, at: label.at, source };
    return true;
  }
  applyObserved(id, observed) { const row = this.byId.get(id); if (!row || !observed || typeof observed !== 'object') return false; row.observed = observed; return true; }
  clearObserved(id) { const row = this.byId.get(id); if (!row?.observed) return false; delete row.observed; return true; }
  /** In memory: drop every observation a self label gave (selfObserved). Returns how many rows changed. */
  clearSelfObservations(rows = this.list) { let cleared = 0; for (const row of rows) if (selfObserved(row)) { delete row.observed; cleared++; } return cleared; }
  append(value) {
    if (!this.file) return;
    try { mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }); appendFileSync(this.file, `${JSON.stringify(value)}\n`, { mode: 0o600 }); this.appended++; } catch { /* telemetry never blocks the decision */ }
  }
  /** One judgment (the full row DecisionService.record builds). */
  add(input) {
    const row = input && typeof input.id === 'string' ? structuredClone(input) : null;
    if (!row || !this.put(row)) return false;
    this.append({ t: 'row', row });
    if (this.list.length > this.fullRows) { const index = this.list.length - this.fullRows - 1, old = this.list[index]; if (old.compact !== true) { const compact = compactRow(old); this.list[index] = compact; this.byId.set(compact.id, compact); } }
    // Expired rows leave in daily batches (one rewrite a day, not one per judgment); a file grown by label lines is compacted.
    if (atOf(this.list[0]?.at) < this.now() - (this.retentionDays + 1) * DAY || this.appended > 4 * this.list.length + 2000) this.prune();
    return true;
  }
  has(id) { return this.byId.has(id); }
  get(id) { return this.byId.get(id) ?? null; }
  /**
   * Label a row by id; unknown ids are not labeled (no row explains them). `source` defaults by the label table. A self
   * label never replaces an outcome or heuristic label (false); an outcome label replacing a self label also drops an
   * observation the self label left (none is taken from one since PDL-7), so the backfill observes the outcome. A
   * different label replacing a calibrated one drops the observation read from the old (C2: an outcome that moved).
   */
  label(id, value, { at = this.now(), source } = {}) {
    // The observation a replaced label gave is stale: a self label's (PDL-7), or a calibrated label's the outcome has since
    // contradicted (C2: a change kept, then reverted by the user, relabels the wake that decided it).
    const row = this.byId.get(id), stale = selfObserved(row) || Boolean(row?.observed && row.label && row.label.value !== value && LABEL_OBSERVED_POINTS.has(row.point));
    if (!this.applyLabel(id, { value, at, ...(source ? { source } : {}) })) return false;
    this.append({ t: 'label', id, value, at, source: row.label.source });
    if (stale && !selfLabel(row.label) && this.clearObserved(id)) this.append({ t: 'observed', id, observed: null });
    return true;
  }
  /**
   * PDL-7 (B3) on the ledger, at startup: observations a self label gave (an older release took them from its own wake
   * labels before labels were told apart) are dropped, and the file rewritten, so calibration never scores them.
   * Idempotent: nothing to do, nothing written. Returns how many rows changed.
   */
  dropSelfObservations() {
    const cleared = this.clearSelfObservations();
    if (!cleared) return 0;
    this.migrations.push({ t: 'migration', at: this.now(), from: 'self_label_observations', rows: cleared });
    this.rewrite();
    return cleared;
  }
  observe(id, observed) {
    const row = this.byId.get(id);
    if (!row || row.observed || !this.applyObserved(id, observed)) return false;
    this.append({ t: 'observed', id, observed });
    return true;
  }
  /** Every row, oldest first (a copy of the list; rows are shared, do not mutate them). */
  rows() { return [...this.list]; }
  /**
   * Newest first, `limit` (≤ LEDGER_PAGE_MAX) rows older than the row `before` (a ledger id), that pass `keep`.
   * `nextBefore` continues the listing; null at its end.
   */
  page({ before, limit = 50, keep = () => true } = {}) {
    const size = Math.max(1, Math.min(LEDGER_PAGE_MAX, Math.floor(Number(limit)) || 50));
    let index = this.list.length - 1;
    if (before !== undefined && before !== null && before !== '') { const anchor = this.byId.get(before); if (!anchor) throw Object.assign(new Error('before must be a ledger id'), { status: 400, code: 'ledger_cursor_invalid' }); index = this.list.indexOf(anchor) - 1; }
    const rows = [];
    for (; index >= 0 && rows.length < size; index--) if (keep(this.list[index])) rows.push(this.list[index]);
    let more = false; for (let rest = index; rest >= 0; rest--) if (keep(this.list[rest])) { more = true; break; }
    return { rows, hasMore: more, nextBefore: more ? rows.at(-1)?.id ?? null : null };
  }
  /**
   * Rows older than the retention leave, counted into the rollup first; the file is rewritten compact. They leave memory
   * once folded, whether or not the rollup could be written now (as the usage ledger's rows do): the file keeps them until
   * a rewrite, and a rewrite waits until the rollup holding them is on disk, so a failed flush neither loses a row nor
   * folds it again on the next prune (a restart reads the older rollup and its watermark and folds them once more, once).
   */
  prune({ rewrite = false } = {}) {
    const cutoff = this.now() - this.retentionDays * DAY, leaving = this.list.filter(row => !(atOf(row.at) >= cutoff));
    if (leaving.length) {
      this.rollup?.fold('decisions', leaving.map(rollupCell), cutoff);
      const gone = new Set(leaving.map(row => row.id));
      this.list = this.list.filter(row => !gone.has(row.id)); for (const id of gone) this.byId.delete(id);
    }
    if (leaving.length || rewrite || this.appended > 4 * this.list.length + 2000) return this.rewrite();
    return true;
  }
  /**
   * Rewrite the file from memory: rows with their labels and observed values, the migration notes, unknown lines. Never
   * before the rollup holding the rows that left memory is on disk (else they would be in neither file).
   */
  rewrite() {
    if (!this.file) { this.appended = this.list.length; this.unsaved = false; return true; }
    if (this.rollup && !this.rollup.flush()) return false;
    const cutoff = this.now() - this.retentionDays * DAY;
    const unknown = this.unknown.filter(line => { try { const at = atOf(JSON.parse(line)?.at ?? JSON.parse(line)?.row?.at); return !Number.isFinite(at) || at >= cutoff; } catch { return false; } });
    const lines = [...this.migrations.slice(-20).map(value => JSON.stringify(value)), ...this.list.map(row => JSON.stringify({ t: 'row', row })), ...unknown];
    try { atomicWrite(this.file, lines.length ? `${lines.join('\n')}\n` : ''); this.unknown = unknown; this.appended = lines.length; this.unsaved = false; return true; } catch { return false; }
  }
  /** A deleted project's judgments go with it (they hold no content, but the deletion promise covers them). */
  removeProject(projectId) {
    const before = this.list.length;
    this.list = this.list.filter(row => row.scope?.projectId !== projectId);
    if (this.list.length === before) return 0;
    this.byId = new Map(this.list.map(row => [row.id, row]));
    this.rollup?.removeProject(projectId); this.rollup?.flush();
    this.rewrite();
    return before - this.list.length;
  }
  /**
   * Move the ledger an older release kept in state (`decisionKernelRuntime.recent`, `index`, `labels`) into this file:
   * once at the first start of this release, and again after a rollback to such a release and an upgrade back (rows it
   * wrote meanwhile). The rows are on disk (atomic rewrite) before state forgets them; `recent: []` stays, because an
   * older release appends to that array. Returns how many rows were imported.
   * A failed rewrite leaves state as it was and the imported rows marked `unsaved`: a later absorb finds them already in
   * memory (nothing new to import), so it is that mark, not the count, that makes it write again before state may forget them.
   */
  absorb(store) {
    const runtime = store?.state?.decisionKernelRuntime;
    const recent = Array.isArray(runtime?.recent) ? runtime.recent : [], index = runtime?.index && typeof runtime.index === 'object' ? runtime.index : {}, labels = runtime?.labels && typeof runtime.labels === 'object' ? runtime.labels : {};
    if (!recent.length && !Object.keys(index).length && !Object.keys(labels).length) return 0;
    const cutoff = this.now() - this.retentionDays * DAY;
    let imported = 0, labeled = 0;
    for (const row of recent) if (row && typeof row.id === 'string' && atOf(row.at) >= cutoff && this.put(structuredClone(row))) imported++;
    for (const rows of Object.values(index)) for (const entry of Array.isArray(rows) ? rows : []) {
      if (!entry || typeof entry.id !== 'string' || !(atOf(entry.at) >= cutoff)) continue;
      if (this.put({ id: entry.id, at: entry.at, point: entry.point, source: entry.source, scope: entry.projectId ? { projectId: entry.projectId } : {}, indexed: true, compact: true })) imported++;
    }
    // A label already on the row (same value, its source known) is not news: only new or changed labels need the file
    // rewritten. A row imported just now carries its label as the older release wrote it (no source): it is set here.
    const relabel = (id, label) => { const known = this.byId.get(id)?.label; if (known && known.value === label?.value && LABEL_SOURCES.includes(known.source)) return; if (this.applyLabel(id, label)) labeled++; };
    for (const row of recent) if (row?.label && typeof row.id === 'string') relabel(row.id, row.label);
    for (const [id, label] of Object.entries(labels)) relabel(id, label);
    // PDL-7 (B3): an older release's wake labels carry no source and read as `self` (the label table; B3's `provisional`
    // flag means the same); the observation its backfill took from one is dropped before the rows reach the file.
    const cleared = this.clearSelfObservations();
    if (imported || labeled || cleared) {
      this.sort();
      this.migrations.push({ t: 'migration', at: this.now(), from: 'state.decisionKernelRuntime', rows: imported, labels: labeled, ...(cleared ? { selfObservations: cleared } : {}) });
      this.unsaved = true;
    }
    // On disk first; only then may state drop them. A failed write leaves state as it was (nothing is lost).
    if (this.unsaved && !this.rewrite()) return 0;
    try { store.mutate(state => { const live = state.decisionKernelRuntime ??= {}; live.recent = []; delete live.index; delete live.labels; live.ledger = { location: 'rna/metrics/decision-ledger.jsonl', version: 1, migratedAt: new Date(this.now()).toISOString() }; }); } catch { /* the import is idempotent: the next start retries */ }
    return imported;
  }
  /**
   * Rows as a reader sees them now: this ledger plus any rows an older release left in `state` that are not imported yet
   * (a rollback's rows before the next absorb). Read-only: nothing is moved.
   */
  view(state) {
    const runtime = state?.decisionKernelRuntime, recent = Array.isArray(runtime?.recent) ? runtime.recent : [];
    const pending = recent.filter(row => row && typeof row.id === 'string' && !this.byId.has(row.id));
    return pending.length ? [...this.list, ...pending] : this.list;
  }
}

/** The rows of a ledger file, oldest first, read only (benchmarks read copies of it through this); [] without one. */
export function readDecisionLedger(file) {
  let text = ''; try { text = readFileSync(file, 'utf8'); } catch { return []; }
  return new DecisionLedger({ fullRows: Infinity }).load(text.split('\n')).rows();
}
/** Ledger rows of a store: its ledger (with rows not yet absorbed), else the legacy `state.decisionKernelRuntime.recent`. */
export const ledgerRows = (store, state = store?.state) => store?.decisionLedger ? store.decisionLedger.view(state) : (state?.decisionKernelRuntime?.recent ?? []);
/** A label's source for a ledger row (stored, else by the label table). */
export const rowLabelSource = row => labelSource(row?.label);
export const isFiniteNumber = finite;
