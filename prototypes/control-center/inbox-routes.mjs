import { DomainError } from './store.mjs';
import { inboxView, inboxEntryLocation, applyInboxAction, deliveryMetrics, deliveryFeedbackSignals, settleDeliveryFeedback } from './proactive-delivery.mjs';

// Project inbox and delivery feedback (contract v2 §1, P3). api-v2 falls
// through unknown /api/v2/* paths, so these routes live behind one hook.
const LIST = /^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/inbox$/, READ_ALL = /^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/inbox\/read-all$/;
const ENTRY = /^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/inbox\/([a-zA-Z0-9-]+)$/, FEEDBACK = /^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/delivery-feedback$/;
const WINDOWS = { '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 };

export function createInboxRoutes({ store, body, decisions, now = Date.now }) {
  const project = id => store.state.projects.find(row => row.id === id) ?? (() => { throw new DomainError('项目不存在', 404); })();
  return async function handle(req, { pathname, url, send }) {
    if (!pathname.startsWith('/api/v2/projects/')) return false;
    const list = pathname.match(LIST), readAll = pathname.match(READ_ALL), entry = !readAll && pathname.match(ENTRY), feedback = pathname.match(FEEDBACK);
    if (req.method === 'GET' && list) {
      const status = url.searchParams.get('status') ?? 'active';
      if (!['active', 'all', 'unread', 'read', 'dismissed'].includes(status)) throw new DomainError('status 必须为 active、all、unread、read 或 dismissed', 400);
      send(200, { ...inboxView(project(list[1]), { status, limit: url.searchParams.get('limit') ?? 50, now: now() }), revision: store.state.revision }); return true;
    }
    if (req.method === 'POST' && readAll) {
      project(readAll[1]); await body(req);
      store.mutate(state => { const target = state.projects.find(row => row.id === readAll[1]); for (const row of target.inbox ?? []) if (row.status === 'unread' && !row.contextRevoked) applyInboxAction(target, row.id, 'read', { now: now() }); });
      send(200, { ...inboxView(project(readAll[1]), { limit: 1, now: now() }), revision: store.state.revision }); return true;
    }
    if (req.method === 'GET' && entry) {
      // Deep link: one entry plus where it lives in a conversation (read-only; does not mark it read).
      const found = project(entry[1]), row = (found.inbox ?? []).find(value => value.id === entry[2] && !value.contextRevoked);
      if (!row) throw new DomainError('收件箱中没有这条消息', 404);
      send(200, { ...inboxEntryLocation(found, row, store.state.sessions, { now: now() }), revision: store.state.revision }); return true;
    }
    if (req.method === 'POST' && entry) {
      project(entry[1]);
      const input = await body(req);
      if (Object.keys(input).some(key => key !== 'action')) throw new DomainError('请求只能包含 action（read、dismiss 或 act）', 400);
      let updated;
      store.mutate(state => { updated = structuredClone(applyInboxAction(state.projects.find(row => row.id === entry[1]), entry[2], input.action, { now: now() })); });
      // A dismissal or an explicit act is the user's reaction: settle it now.
      settleDeliveryFeedback(store, entry[1], { decisions, now: now() });
      const current = project(entry[1]);
      send(200, { entry: structuredClone(current.inbox.find(row => row.id === updated.id) ?? updated), unread: (current.inbox ?? []).filter(row => row.status === 'unread' && !row.contextRevoked).length, revision: store.state.revision }); return true;
    }
    if (req.method === 'GET' && feedback) {
      const window = url.searchParams.get('window') ?? '7d';
      if (!WINDOWS[window]) throw new DomainError('window 必须为 24h、7d 或 30d', 400);
      const found = project(feedback[1]);
      send(200, { ...deliveryMetrics(found, { now: now(), windowMs: WINDOWS[window] }), window, recent: deliveryFeedbackSignals(found, { limit: 20 }), revision: store.state.revision }); return true;
    }
    return false;
  };
}
