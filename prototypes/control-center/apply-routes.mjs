import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';

// Apply records and rollback (worktree design 0.63 §5, protocol v2 §8.7). Owner: T1; registered by the lead in
// server.mjs behind the same maintenance gate as the git writes (POST answers 503 while maintenance holds).
//
//   GET  /api/v2/projects/:id/applies?sessionId=&turnId=&limit=     records, newest first (limit 1–500, default 50)
//   GET  /api/v2/projects/:id/applies/:applyId                       a record with its files (before → after)
//   GET  /api/v2/projects/:id/applies/:applyId/patches?path=…        1–40 files' patches (path repeated)
//   POST /api/v2/projects/:id/applies/:applyId/rollback              { paths?, force?, confirm? } — two steps
//   POST /api/v2/projects/:id/turns/:turnId/rollback                 { paths?, force?, confirm? } — a whole turn
//   GET  /api/v2/projects/:id/turns/:turnId/changes?sessionId=       what the turn changed in the project folder, per file
//   GET  /api/v2/projects/:id/turns/:turnId/changes/patches?sessionId=&path=…   1–40 of those files' patches
//
// Reads never start work. Rollbacks are user actions only (no agent tool reaches them): the first step changes
// nothing and answers a one-time token; the web sends it back only on the user's second click. Errors carry `code`.
// The rollback record says so (`initiator: 'user'`, passed here, never read from the body), which is what tells the
// models "the user undid this" (workspace-events.mjs).

// A turn has three: POST rollback, GET changes and GET changes/patches (the turn's action is the last group).
const ROUTE = /^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/(?:applies(?:\/([A-Za-z0-9_-]{1,80})(?:\/(patches|rollback))?)?|turns\/([A-Za-z0-9_-]{1,160})\/(rollback|changes|changes\/patches))$/;
const ID = /^[A-Za-z0-9_-]{1,160}$/, USER = Object.freeze({ initiator: 'user' });

export function createApplyRoutes({ store, body, engine }) {
  const say = variants => inLanguage(interfaceLanguageOf(store?.state), variants);
  const invalid = (send, variants, code = 'applies_request_invalid') => { send(400, { error: say(variants), code }); return true; };
  const handle = async function handle(req, { pathname, url, send }) {
    if (!pathname.startsWith('/api/v2/projects/') || !(pathname.includes('/applies') || pathname.includes('/turns/'))) return false;
    const match = pathname.match(ROUTE);
    if (!match) return false;
    const [, projectId, applyId, action, turnId, turnAction] = match, query = url.searchParams;
    try {
      if (turnId) {
        if (turnAction === 'rollback') {
          if (req.method !== 'POST') return false;
          send(200, await engine.rollbackTurn(projectId, turnId, await body(req), USER));
          return true;
        }
        // Reads: what the turn changed (host-computed), and its files' patches.
        if (req.method !== 'GET') return false;
        const sessionId = query.get('sessionId') || undefined;
        if (sessionId !== undefined && !ID.test(sessionId)) return invalid(send, { zh: 'sessionId 不是有效的编号。', en: 'sessionId isn’t a valid id.' });
        send(200, turnAction === 'changes' ? await engine.turnChanges(projectId, turnId, { sessionId }) : await engine.turnPatches(projectId, turnId, { sessionId, paths: query.getAll('path') }));
        return true;
      }
      if (!applyId) {
        if (req.method !== 'GET') return false;
        const filter = {};
        for (const key of ['sessionId', 'turnId']) {
          const value = query.get(key);
          if (value === null || value === '') continue;
          if (!ID.test(value)) return invalid(send, { zh: `${key} 不是有效的编号。`, en: `${key} isn’t a valid id.` });
          filter[key] = value;
        }
        if (query.has('limit')) {
          const limit = Number(query.get('limit'));
          if (!Number.isInteger(limit) || limit < 1 || limit > 500) return invalid(send, { zh: 'limit 要是 1–500 的整数。', en: 'limit must be a whole number from 1 to 500.' });
          filter.limit = limit;
        }
        send(200, engine.applies(projectId, filter));
        return true;
      }
      if (!action && req.method === 'GET') { send(200, await engine.applyDetail(projectId, applyId)); return true; }
      if (action === 'patches' && req.method === 'GET') { send(200, await engine.applyPatches(projectId, applyId, { paths: query.getAll('path') })); return true; }
      if (action === 'rollback' && req.method === 'POST') { send(200, await engine.rollback(projectId, applyId, await body(req), USER)); return true; }
    } catch (error) {
      // The web tells these apart by code (a stale confirmation, an expired record, a read-only project).
      if (!error.status) throw error;
      send(error.status, { error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.reason ? { reason: error.reason } : {}) });
      return true;
    }
    return false;
  };
  return Object.assign(handle, { engine });
}
