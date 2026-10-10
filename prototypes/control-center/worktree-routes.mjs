// Rna's worktrees of a project (worktree design 0.63 §11; contract v2 §8.6): the list with the isolation conditions,
// and the two-step apply / discard of a kept, conflicted or orphan worktree. Owner: T2. api-v2 falls through unknown
// /api/v2/* paths, so these routes live here behind one hook (as workspace-git-routes.mjs); the lead registers it,
// with the writes held while maintenance waits. A thrown `{ status, code }` is answered as
// `{ error, code, ...extra }` so the web can tell a stale confirmation from a worktree still in use.
const ROUTE = /^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/worktrees(?:\/([A-Za-z0-9_-]{1,80})\/(apply|discard))?$/;
/** Error fields besides the message and code that the web reads (isolation reason, which worktree). */
const EXTRA = ['reason', 'worktreeId'];

export function createWorktreeRoutes({ store, body, worktrees }) {
  void store;
  const handle = async function handle(req, { pathname, send }) {
    if (!pathname.startsWith('/api/v2/projects/') || !pathname.includes('/worktrees')) return false;
    const match = pathname.match(ROUTE);
    if (!match) return false;
    const [, projectId, worktreeId, action] = match;
    try {
      if (req.method === 'GET' && !worktreeId) { send(200, await worktrees.list(projectId)); return true; }
      if (req.method === 'POST' && worktreeId) {
        const input = await body(req);
        send(200, action === 'apply' ? await worktrees.applyWorktree(projectId, worktreeId, input) : await worktrees.discardWorktree(projectId, worktreeId, input));
        return true;
      }
    } catch (error) {
      if (!error.status) throw error;
      send(error.status, { error: error.message, ...(error.code ? { code: error.code } : {}), ...Object.fromEntries(EXTRA.filter(key => error[key] !== undefined).map(key => [key, error[key]])) });
      return true;
    }
    return false;
  };
  return Object.assign(handle, { worktrees });
}
