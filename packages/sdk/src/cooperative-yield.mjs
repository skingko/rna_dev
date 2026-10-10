import { performance } from 'node:perf_hooks';
import { setImmediate as yieldImmediate } from 'node:timers/promises';

// Awaiting an already-ready iterator or stream read only drains microtasks.
// Bound that burst by both elapsed work and event count, then admit real I/O,
// timers and cancellation. This cannot preempt one synchronous operation.
const MAX_EVENTS = 64, QUANTUM_MS = 8;
export function createStreamCheckpoint(signal) {
  let events = 0, startedAt = performance.now();
  return () => {
    signal?.throwIfAborted();
    if (++events < MAX_EVENTS && performance.now() - startedAt < QUANTUM_MS) return;
    return (async () => {
      try { await yieldImmediate(undefined, signal ? { signal } : undefined); }
      catch (error) { signal?.throwIfAborted(); throw error; }
      signal?.throwIfAborted();
      events = 0; startedAt = performance.now();
    })();
  };
}
