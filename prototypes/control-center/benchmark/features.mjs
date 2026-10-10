import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Feature detection for K1/K2-dependent scenarios. A feature is available
// when an adapter module benchmark/adapters/<feature>.mjs exists and its
// default export's `available()` returns true. Adapters are the only coupling
// between the benchmark and K1/K2 internals; each K line (or the integrator)
// adds a small adapter after merge. Module hints only improve skip reasons.
//
// Adapter contract (default export):
//   mind:     { available(), read(store, projectId) → project.mind }
//   capture:  { available(), captureUserMessage({ store, projectId, sessionId, itemId, jev }) → Promise }
//   narrator: { available() }   (the controller routes shares and scheduled deliveries through it; the agent's text is delivered as written, judged by JEV)
//   pacing:   { available() }   (controller holds night/away messages and emits a welcome-back summary)
// RNA_BENCH_FEATURES=none|mind,capture,... restricts detection (useful to reproduce the main-branch baseline).
export const FEATURES = Object.freeze(['mind', 'capture', 'narrator', 'pacing']);
const HINTS = { mind: /mind/i, capture: /capture|signal-capture/i, narrator: /narrat/i, pacing: /pacing|thread/i };
export const ADAPTER_DIR = fileURLToPath(new URL('./adapters/', import.meta.url));
const HOST_DIR = fileURLToPath(new URL('../', import.meta.url));

export async function detectFeatures({ adapterDir = ADAPTER_DIR, hostDir = HOST_DIR, env = process.env } = {}) {
  const allowed = env.RNA_BENCH_FEATURES === undefined ? null : new Set(String(env.RNA_BENCH_FEATURES).split(',').map(value => value.trim()).filter(value => value && value !== 'none'));
  const hostFiles = existsSync(hostDir) ? readdirSync(hostDir).filter(name => name.endsWith('.mjs')) : [];
  const out = {};
  for (const feature of FEATURES) {
    const hint = hostFiles.find(name => HINTS[feature].test(name)) ?? null, file = join(adapterDir, `${feature}.mjs`);
    if (allowed && !allowed.has(feature)) { out[feature] = { available: false, reason: `disabled by RNA_BENCH_FEATURES`, hint }; continue; }
    if (!existsSync(file)) { out[feature] = { available: false, reason: hint ? `host module ${hint} found but no benchmark adapter (benchmark/adapters/${feature}.mjs)` : `feature not present on this branch (no benchmark/adapters/${feature}.mjs)`, hint }; continue; }
    try {
      const adapter = (await import(pathToFileURL(file).href)).default;
      const available = adapter && typeof adapter.available === 'function' ? await adapter.available() : false;
      out[feature] = available ? { available: true, adapter, hint } : { available: false, reason: `adapter ${feature}.mjs reports unavailable`, hint };
    } catch (failure) { out[feature] = { available: false, reason: `adapter ${feature}.mjs failed to load: ${failure.message}`, hint }; }
  }
  return out;
}
/** First missing requirement as a skip reason, or null when all are available. */
export function missingFeature(features, requires = []) {
  for (const feature of requires) if (!features[feature]?.available) return `requires ${feature}: ${features[feature]?.reason ?? 'unknown feature'}`;
  return null;
}
