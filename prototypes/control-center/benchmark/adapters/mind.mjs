import { ProjectMindService, publicMind } from '../../project-mind.mjs';

// K1 benchmark adapter: the scenario world has no daemon, so a mind service is
// attached per store (no model calls: provider null; JEV when the world has
// one). read() first catches up on terminal turns and delivery-settled
// commitments exactly as the daemon's periodic sweep would.
const services = new WeakMap();
export function mindService(store, { decisions } = {}) {
  if (store.mind) return store.mind;
  let service = services.get(store);
  if (!service) { service = new ProjectMindService(store, { decisions: decisions ?? null, provider: null, sweepIntervalMs: 0 }); services.set(store, service); }
  else if (decisions && !service.decisions) service.decisions = decisions;
  return service;
}
export default {
  available: () => true,
  async read(store, projectId) {
    const mind = mindService(store);
    mind.sweep();
    await mind.catchUp(projectId, { since: 0 });
    await mind.idle();
    const project = store.state.projects.find(row => row.id === projectId);
    return project ? publicMind(project) : null;
  },
};
