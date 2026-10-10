import { DomainError } from './store.mjs';

// Subagent control for clients (contract v2 §1 `/agents`). api-v2 falls
// through unknown /api/v2/* paths, so these routes live here behind one hook.
// Cancel stays available while maintenance holds new work (like stop).
export const AGENT_CANCEL_ROUTE = /^\/api\/v2\/sessions\/([a-zA-Z0-9-]+)\/agents\/([a-zA-Z0-9-]+)\/cancel$/;
const LIST = /^\/api\/v2\/sessions\/([a-zA-Z0-9-]+)\/agents$/, MESSAGE = /^\/api\/v2\/sessions\/([a-zA-Z0-9-]+)\/agents\/([a-zA-Z0-9-]+)\/message$/;
// The subagent card's merge buttons (worktree design 0.63 §4.1, protocol §8.6): merge / handoff / two-step drop. A
// write: refused while maintenance holds (server.mjs answers 503 before this hook), like the other git writes.
export const AGENT_MERGE_ROUTE = /^\/api\/v2\/sessions\/([a-zA-Z0-9-]+)\/agents\/([a-zA-Z0-9-]+)\/merge$/;
const parse = result => JSON.parse(result.content[0].text);

export function createAgentRoutes({ store, agents, body }) {
  const session = id => { if (!store.state.sessions.some(row => row.id === id)) throw new DomainError('会话不存在', 404); return id; };
  const known = (id, agentId) => { if (!agents.record(id, agentId)) throw new DomainError('本会话没有这个子任务', 404); };
  return async function handle(req, { pathname, send }) {
    if (!pathname.startsWith('/api/v2/sessions/') || !pathname.includes('/agents')) return false;
    const list = pathname.match(LIST), cancel = pathname.match(AGENT_CANCEL_ROUTE), message = pathname.match(MESSAGE), merge = pathname.match(AGENT_MERGE_ROUTE);
    if (req.method === 'GET' && list) { send(200, { sessionId: session(list[1]), revision: store.state.revision, agents: agents.list(list[1]) }); return true; }
    if (req.method === 'POST' && cancel) { session(cancel[1]); known(cancel[1], cancel[2]); await body(req); send(200, parse(await agents.cancel(cancel[1], cancel[2], 'user'))); return true; }
    if (req.method === 'POST' && message) {
      session(message[1]); known(message[1], message[2]);
      const input = await body(req);
      if (typeof input?.message !== 'string' || !input.message.trim() || input.message.length > 4000) throw new DomainError('消息需为 1–4000 字符', 400);
      const result = await agents.message(message[1], { agentId: message[2], message: input.message });
      send(result.isError ? 409 : 200, parse(result)); return true;
    }
    if (req.method === 'POST' && merge) {
      session(merge[1]);
      const input = await body(req);
      // Isolation errors carry their own code and status (and `reason` where there is one): answered as such.
      try { send(200, await agents.userMerge(merge[1], merge[2], input)); }
      catch (error) { if (!error?.code || !error.status) throw error; send(error.status, { error: error.message, code: error.code, ...(error.reason ? { reason: error.reason } : {}) }); }
      return true;
    }
    return false;
  };
}
