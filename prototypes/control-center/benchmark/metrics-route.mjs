import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeProjectMetrics, WINDOWS } from './metrics.mjs';
import { projectSideData } from './dataset.mjs';
import { loadLabelFile } from './labels.mjs';

// GET /api/v2/projects/:id/metrics?window=7d|30d (plan §8). Registered after
// api-v2's own handler, so a K2-owned route in api-v2.mjs takes precedence and
// this module becomes inert. When K2 ships a proactive-metrics module, its
// block replaces the K4 baseline and both merge into one response object.
// K2 contract: export `computeProactiveMetrics(state, projectId, { window, now })`
// from one of PROACTIVE_PROVIDER_MODULES (first that exists wins).
export const PROACTIVE_PROVIDER_MODULES = Object.freeze(['../proactive-metrics.mjs', '../project-proactive-metrics.mjs', '../project-pacing.mjs', '../project-narrator.mjs']);
const PATTERN = /^\/api\/v2\/projects\/([^/]+)\/metrics$/;
const SIDE_TTL_MS = 30000;

/** Defensive dynamic import of K2's proactive metrics; null when absent or broken. */
export async function loadProactiveProvider(modules = PROACTIVE_PROVIDER_MODULES, base = import.meta.url) {
  for (const specifier of modules) {
    const url = new URL(specifier, base); if (!existsSync(fileURLToPath(url))) continue;
    try { const module = await import(url.href); const fn = module.computeProactiveMetrics ?? module.proactiveMetrics; if (typeof fn === 'function') return { fn, module: specifier }; } catch { /* a broken optional module never takes the endpoint down */ }
  }
  return null;
}

export function createMetricsRoute({ store, now = Date.now, labelsFile = fileURLToPath(new URL('./fixtures/labels.json', import.meta.url)), providerModules } = {}) {
  let provider, sideCache = new Map();
  const side = projectId => {
    const cached = sideCache.get(projectId); if (cached && now() - cached.at < SIDE_TTL_MS) return cached.value;
    const value = store.file ? projectSideData(store.file, projectId) : {}; sideCache.set(projectId, { at: now(), value }); return value;
  };
  return {
    async handle(req, res, { pathname, url, send }) {
      const match = req.method === 'GET' && pathname.match(PATTERN); if (!match) return false;
      const projectId = decodeURIComponent(match[1]), window = url.searchParams.get('window') ?? '7d', archived = url.searchParams.get('archived') || 'exclude';
      // B7: the project's archived conversations on request; wakes from the host's daily wake rollup when it keeps one.
      if (!['exclude', 'include', 'only'].includes(archived)) { send(400, { error: 'archived must be exclude, include or only', code: 'archived_invalid' }); return true; }
      if (!(window in WINDOWS)) { send(400, { error: 'window must be 1d, 7d, 30d or all', code: 'metrics_window_invalid' }); return true; }
      if (!store.state.projects.some(row => row.id === projectId)) { send(404, { error: 'Project not found', code: 'project_not_found' }); return true; }
      provider ??= await loadProactiveProvider(providerModules) ?? false;
      let labels = null; try { labels = loadLabelFile(labelsFile); } catch { labels = null; }
      const at = now(); let block = null;
      if (provider) { try { block = await provider.fn(store.state, projectId, { window, now: at, archived, wakes: store.wakeRollup ?? null }) ?? null; } catch { block = null; } }
      const result = computeProjectMetrics(store.state, projectId, window, { now: at, side: side(projectId), labels, proactiveProvider: block ? () => block : undefined });
      send(200, { ...result, providers: { proactive: provider ? provider.module : 'k4-baseline' } });
      return true;
    },
  };
}
