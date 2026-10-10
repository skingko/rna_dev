import { resolveReasoningCapability } from './reasoning-capability.mjs';

// GET /api/v2/models/:providerId/:modelId/reasoning (contract v2 §4).
// Returns null when the route does not match so the server continues.
const ROUTE = /^\/api\/v2\/models\/([^/]+)\/([^/]+)\/reasoning$/;
export function reasoningRoute({ method, pathname, store, decisions }) {
  const match = method === 'GET' && ROUTE.exec(pathname);
  if (!match) return null;
  let providerId, modelId;
  try { providerId = decodeURIComponent(match[1]); modelId = decodeURIComponent(match[2]); } catch { return { status: 400, body: { error: '模型标识无效' } }; }
  const provider = store.state.configuration.providers.find(row => row.id === providerId);
  const model = provider?.models.find(row => row.id === modelId);
  if (!model) return { status: 404, body: { error: '模型不在供应商允许列表中' } };
  const auto = decisions?.routeAvailability?.() ?? { available: false, backend: null };
  return { status: 200, body: { capability: resolveReasoningCapability(provider, model), auto: { available: auto.available === true, backend: auto.available ? auto.backend : null } } };
}
