// Event-loop attribution (plan 2026-10-05 B7; finding D6 left a 1.6 s event-loop maximum unexplained). Diagnostic only:
// nothing ever reads these to decide anything (pi: "a span is diagnostic data, not business state").
// - Named, fixed-bucket histograms of synchronous work: how long each named section held the loop (zcode localTtft's
//   bucket set, no exporter). Names are bounded: HTTP routes by their pattern (ids folded), plus host sections.
// - The loop's own delay (monitorEventLoopDelay) per 5-minute slot, so health shows the last hour and day, not only
//   p99/max since boot.
// Both keep 24 hours of 5-minute slots in memory, nothing on disk.
import { monitorEventLoopDelay } from 'node:perf_hooks';

/** zcode packages/shared/src/localTtft.ts LOCAL_TTFT_BUCKETS_MS: upper bounds in ms; a last bucket holds the rest. */
export const LOOP_BUCKETS_MS = Object.freeze([1, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000, 60000, 300000]);
export const SLOT_MS = 5 * 60000;
const DAY = 86400000, MAX_NAMES = 200, OTHER = 'other';
export const LOOP_WINDOWS = Object.freeze({ '1h': 3600000, '24h': DAY });

/** An HTTP route as a bounded name: ids, hashes and numbers in the path become `:id`. */
export function routeName(method, pathname) {
  const path = String(pathname ?? '').split('?')[0].split('/').map(part => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part) || /^[0-9a-f]{16,}$/i.test(part) || /^\d+$/.test(part) || part.length > 48 ? ':id' : part).join('/');
  return `http ${method} ${path.startsWith('/api') ? path : '(static)'}`;
}
const bucketOf = ms => { const index = LOOP_BUCKETS_MS.findIndex(bound => ms <= bound); return index < 0 ? LOOP_BUCKETS_MS.length : index; };
/** Upper bound of the bucket holding quantile q (null without samples; Infinity past the last bound). */
const quantile = (counts, total, q) => { if (!total) return null; let seen = 0; for (let index = 0; index < counts.length; index++) { seen += counts[index]; if (seen >= q * total) return index < LOOP_BUCKETS_MS.length ? LOOP_BUCKETS_MS[index] : null; } return null; };

export class LoopHistograms {
  constructor({ now = Date.now } = {}) { this.now = now; this.slots = new Map(); this.names = new Set(); }
  slot(at = this.now()) {
    const key = Math.floor(at / SLOT_MS);
    let slot = this.slots.get(key);
    if (!slot) { slot = new Map(); this.slots.set(key, slot); for (const old of this.slots.keys()) if (old <= key - DAY / SLOT_MS) this.slots.delete(old); }
    return slot;
  }
  /** One synchronous section of `ms` under `name`. */
  record(name, ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    let label = String(name).slice(0, 120);
    if (!this.names.has(label)) { if (this.names.size >= MAX_NAMES) label = OTHER; else this.names.add(label); }
    const slot = this.slot(), entry = slot.get(label) ?? { counts: new Array(LOOP_BUCKETS_MS.length + 1).fill(0), count: 0, sumMs: 0, maxMs: 0 };
    entry.counts[bucketOf(ms)]++; entry.count++; entry.sumMs += ms; entry.maxMs = Math.max(entry.maxMs, ms); slot.set(label, entry);
  }
  /** Time a synchronous function under `name` (its result is returned; a throw is timed too). */
  time(name, fn) { const started = performance.now(); try { return fn(); } finally { this.record(name, performance.now() - started); } }
  /** Per name over the window: count, total and largest ms, p50/p95/p99 as bucket bounds, busiest first (top `limit`). */
  report(window = '1h', { limit = 15 } = {}) {
    const span = LOOP_WINDOWS[window] ?? LOOP_WINDOWS['1h'], from = Math.floor((this.now() - span) / SLOT_MS), merged = new Map();
    for (const [key, slot] of this.slots) {
      if (key <= from) continue;
      for (const [name, entry] of slot) {
        const sum = merged.get(name) ?? { counts: new Array(LOOP_BUCKETS_MS.length + 1).fill(0), count: 0, sumMs: 0, maxMs: 0 };
        entry.counts.forEach((value, index) => { sum.counts[index] += value; }); sum.count += entry.count; sum.sumMs += entry.sumMs; sum.maxMs = Math.max(sum.maxMs, entry.maxMs); merged.set(name, sum);
      }
    }
    return [...merged].sort((a, b) => b[1].sumMs - a[1].sumMs).slice(0, limit).map(([name, sum]) => ({ name, count: sum.count, totalMs: Math.round(sum.sumMs), maxMs: Math.round(sum.maxMs * 10) / 10,
      p50Ms: quantile(sum.counts, sum.count, .5), p95Ms: quantile(sum.counts, sum.count, .95), p99Ms: quantile(sum.counts, sum.count, .99) }));
  }
}

/**
 * Time one object's own method under `name` from now on: the instance gets a wrapper that calls the original on it.
 * For sections that run inside other work (a state commit, an index diff); their time also counts in the route or tick
 * that started them, so names may nest. Diagnostic only.
 */
export function instrument(target, method, name, histograms) {
  const original = target?.[method];
  if (typeof original !== 'function' || original.instrumented === true) return false;
  const wrapped = (...args) => histograms.time(name, () => original.apply(target, args));
  wrapped.instrumented = true; target[method] = wrapped;
  return true;
}

/**
 * The loop's delay per 5-minute slot: one never-reset monitor for the since-boot numbers health always showed, and one
 * reset at each slot boundary whose p99 and max are kept 24 hours.
 */
export class LoopDelay {
  constructor({ now = Date.now, resolution = 20 } = {}) {
    this.now = now; this.boot = monitorEventLoopDelay({ resolution }); this.window = monitorEventLoopDelay({ resolution }); this.slots = [];
    this.boot.enable(); this.window.enable(); this.slotAt = Math.floor(now() / SLOT_MS);
    this.timer = setInterval(() => this.roll(), SLOT_MS); this.timer.unref?.();
  }
  roll() {
    const key = Math.floor(this.now() / SLOT_MS);
    if (this.window.count) this.slots.push({ at: this.slotAt * SLOT_MS, p99Ms: this.window.percentile(99) / 1e6, maxMs: this.window.max / 1e6, count: this.window.count });
    this.window.reset(); this.slotAt = key;
    const cutoff = this.now() - DAY; this.slots = this.slots.filter(slot => slot.at >= cutoff);
  }
  summary(window) {
    const cutoff = this.now() - LOOP_WINDOWS[window], rows = this.slots.filter(slot => slot.at >= cutoff);
    const current = this.window.count ? [{ p99Ms: this.window.percentile(99) / 1e6, maxMs: this.window.max / 1e6 }] : [];
    const all = [...rows, ...current];
    // The worst slot's p99 (slots are not mergeable percentiles) and the largest delay seen.
    return all.length ? { p99Ms: Math.round(Math.max(...all.map(slot => slot.p99Ms)) * 10) / 10, maxMs: Math.round(Math.max(...all.map(slot => slot.maxMs)) * 10) / 10 } : { p99Ms: null, maxMs: null };
  }
  /** Health's `eventLoop`: since boot (as before), plus the last hour and day. */
  health(histograms = null) {
    return { p99Ms: this.boot.percentile(99) / 1e6, maxMs: this.boot.max / 1e6, lastHour: this.summary('1h'), lastDay: this.summary('24h'),
      ...(histograms ? { attribution: { lastHour: histograms.report('1h', { limit: 10 }), lastDay: histograms.report('24h', { limit: 10 }) } } : {}) };
  }
  close() { clearInterval(this.timer); this.boot.disable(); this.window.disable(); }
}
