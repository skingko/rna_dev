import { WorkspaceGitService } from './workspace-git-service.mjs';
import { WorkspaceGitCompare } from './workspace-git-compare.mjs';
import { GitInitService } from './git-init-service.mjs';

// 工作区改动 panel, L2 (layout plan §3; contract v2 §8.5 `/git`). api-v2 falls
// through unknown /api/v2/* paths, so these routes live here behind one hook.
// Reads are safe views (they never start work) and may name another worktree
// of the same repository (`worktree=`); stage / unstage / discard are writes,
// held while maintenance waits, gated by the project's write permission and
// limited to the project's own folder. Discard is a user action only: no agent
// tool reaches it. `init` (0.63, worktree design §10; git-init-service.mjs)
// makes a folder that is no repository yet one, in two steps (a preview that
// writes nothing, then `confirm`); archived projects are allowed, and it shares
// `git`, so its confirmation takes the same repository lock as the writes here.
const ROUTE = /^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/git(?:\/(diff|worktrees|branches|compare|patches|stage|unstage|discard|init))?$/;

export function createWorkspaceGitRoutes({ store, body, git = new WorkspaceGitService(store), compare = new WorkspaceGitCompare(git), init = new GitInitService(store, { git }) }) {
  const handle = async function handle(req, { pathname, url, send }) {
    if (!pathname.startsWith('/api/v2/projects/') || !pathname.includes('/git')) return false;
    const match = pathname.match(ROUTE);
    if (!match) return false;
    const [, projectId, action] = match, query = url.searchParams, worktree = query.get('worktree') || undefined;
    try {
      if (req.method === 'GET' && !action) { send(200, await git.status(projectId, { upstream: query.get('include') === 'upstream', worktree })); return true; }
      if (req.method === 'GET' && action === 'diff') {
        const input = { path: query.get('path'), oldPath: query.get('oldPath') || undefined, context: query.get('context') || undefined, worktree };
        send(200, query.get('source') === 'compare' ? await compare.diff(projectId, { ...input, base: query.get('base') }) : await git.diff(projectId, { ...input, source: query.get('source') }));
        return true;
      }
      if (req.method === 'GET' && action === 'worktrees') { send(200, await git.worktrees(projectId)); return true; }
      if (req.method === 'GET' && action === 'branches') { send(200, await compare.branches(projectId, { worktree })); return true; }
      if (req.method === 'GET' && action === 'compare') { send(200, await compare.compare(projectId, { mode: query.get('mode') || undefined, base: query.get('base') || undefined, worktree })); return true; }
      if (req.method === 'GET' && action === 'patches') { send(200, await compare.patches(projectId, { base: query.get('base'), paths: query.getAll('path'), oldPaths: query.getAll('oldPath'), worktree })); return true; }
      if (req.method === 'POST' && ['stage', 'unstage', 'discard'].includes(action)) {
        const input = await body(req);
        if (Object.keys(input).some(key => !['paths', 'confirm'].includes(key)) || (action !== 'discard' && 'confirm' in input)) { send(400, { error: git.say({ zh: '请求只能包含 paths（丢弃时还可以有 confirm）。', en: 'The request may only contain paths (and confirm, when discarding).' }), code: 'git_request_invalid' }); return true; }
        send(200, await git[action](projectId, input, { worktree })); return true;
      }
      if (req.method === 'POST' && action === 'init') { send(200, await init.init(projectId, await body(req))); return true; }
    } catch (error) {
      // The web tells these apart by code (a stale confirmation, a read-only project), so they are answered here.
      if (!error.status) throw error;
      // Init refusals carry what the dialog shows next to the message (the outer repository, the files that differed, what was undone);
      // a discard no checkpoint could hold names the files (checkpoint_oversized, checkpoint_secret: `paths`).
      send(error.status, { error: error.message, ...(error.code ? { code: error.code } : {}), ...(action === 'init' && error.details ? error.details : {}), ...(action === 'discard' && ['checkpoint_oversized', 'checkpoint_secret'].includes(error.code) && Array.isArray(error.paths) ? { paths: error.paths } : {}) }); return true;
    }
    return false;
  };
  return Object.assign(handle, { git, compare, init });
}
