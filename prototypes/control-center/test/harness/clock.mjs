// D4 scenario harness: the injected clock (plan A7; harness docs/testing.md:29 "mock only the LLM adapter, network
// and clock"). Wall time keeps running, so nothing that waits on a real deadline can hang, but `advance(ms)` jumps
// every reader of the global Date forward at once: the host's own `Date.now()`/`new Date()`, and every `now = Date.now`
// default captured after `install()`. Timers (setTimeout/setInterval) and performance.now() stay real.

const RealDate = globalThis.Date;
let installed = null;

/**
 * Installs the shifted clock for this process (one at a time). `start` pins the first reading (ms since epoch or an
 * ISO string); later readings move with wall time plus every `advance`. Uninstall restores the real Date.
 */
export function installClock({ start } = {}) {
  if (installed) throw new Error('a scenario clock is already installed');
  const origin = start === undefined ? RealDate.now() : typeof start === 'string' ? RealDate.parse(start) : start;
  let offset = origin - RealDate.now();
  const now = () => RealDate.now() + offset;
  class ScenarioDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(now()); else super(...args); }
    static now() { return now(); }
    // Dates made by Node internals (fs.Stats, structuredClone) stay instances of the real Date.
    static [Symbol.hasInstance](value) { return value instanceof RealDate; }
  }
  globalThis.Date = ScenarioDate;
  const clock = {
    now,
    iso: () => new RealDate(now()).toISOString(),
    /** Moves every Date reader forward by `ms` (never backward: the host assumes time is monotonic). */
    advance(ms) { if (!Number.isFinite(ms) || ms < 0) throw new Error('the clock only moves forward'); offset += ms; return now(); },
    /** Moves the clock to `at` (ms or ISO), which must not be in the past. */
    set(at) { const target = typeof at === 'string' ? RealDate.parse(at) : at; return clock.advance(Math.max(0, target - now())); },
    uninstall() { if (installed === clock) { globalThis.Date = RealDate; installed = null; } },
  };
  installed = clock;
  return clock;
}
export const realNow = () => RealDate.now();
