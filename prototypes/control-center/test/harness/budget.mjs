// D4 scenario harness: fixed-budget performance gates (plan A7; deepseek-harness benchmarks/session-open: the median
// of 5 samples against a reviewed constant, expected time on the reference machine times a variance headroom).
// Budgets are constants in the test that owns them, never read from the environment. The verdict message carries
// every raw sample so a failure explains itself.
import { performance } from 'node:perf_hooks';

/** Allowed variance above the measured expectation (harness support/calibration.ts PERFORMANCE_BUDGET_HEADROOM). */
export const HEADROOM = 1.25;
/** The host suite runs four test files at once on the developer's machine; expectations were measured under that load. */
export const LOAD_SCALE = 2;
/** A budget from a reference-machine expectation (ms). */
export const budgetMs = expectedMs => Math.ceil(expectedMs * LOAD_SCALE * HEADROOM);

/** Runs `fn` `warmup` times unmeasured, then `runs` times; resolves { median, samples } in ms. */
export async function medianOf(fn, { runs = 5, warmup = 1, before } = {}) {
  for (let index = 0; index < warmup; index++) { await before?.(); await fn(); }
  const samples = [];
  for (let index = 0; index < runs; index++) {
    await before?.();
    const started = performance.now(); await fn(); samples.push(performance.now() - started);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], samples: samples.map(value => Math.round(value * 10) / 10) };
}
