import { mindService } from './mind.mjs';

// K1 benchmark adapter: per-user-message capture for a scenario world. With a
// JEV DecisionService (turn.route enabled) the capture rides one turn.route
// request exactly like the runtime; otherwise the host fallbacks apply.
export default {
  available: () => true,
  async captureUserMessage({ store, projectId, sessionId, itemId, jev } = {}) {
    const session = store.state.sessions.find(row => row.id === sessionId && row.projectId === projectId);
    const turn = session?.turns.find(row => row.userItemId === itemId), item = session?.items.find(row => row.id === itemId);
    if (!turn || !item) return null;
    const mind = mindService(store, { decisions: jev }), input = mind.captureInput(session, item);
    let route = null;
    if (typeof jev?.route === 'function' && jev.routePoint?.() === 'turn.route' && jev.enabled?.('turn.route')) {
      try { route = await jev.route({ project: store.state.projects.find(row => row.id === projectId), sessionId, turnId: turn.id, userMessage: item.text, capture: input }); } catch { route = null; }
    }
    const record = await mind.capture({ sessionId, turnId: turn.id, route, input });
    await mind.idle();
    return record;
  },
};
