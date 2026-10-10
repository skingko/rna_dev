/** Give the agent the same project-bound static preview as the workbench UI.
 * No shell is launched and no project file is written. Starting the same entry
 * is idempotent; a daemon restart invalidates the URL rather than preserving a
 * fictitious browser/server state. The service owns path and origin checks. */
export function createProjectPreviewTools(service, projectId, context = {}) {
  if (!service || !projectId) return [];
  return [{
    id: 'project_preview', name: 'project_preview', label: '项目页面预览',
    permission: 'read', effect: 'read', idempotent: true,
    description: 'Discover, start, inspect or stop the current project’s real loopback static HTML preview. Use discover to find existing HTML and Vite entries with availability and missing prerequisites; discovery never starts processes or installs dependencies. The workbench automatically opens available project previews and reloads when served local files change. Use start with an existing relative HTML path, then use a browser tool to inspect rendered content and interactions. This does not build a framework app or verify appearance. Use project_dev_preview for an already-installed Vite frontend if permitted. Keep the preview available for the user after delivery. URLs do not survive daemon restart. No projectId or arbitrary external URL can be supplied.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['discover', 'start', 'status', 'stop'] },
      path: { type: 'string', minLength: 1, maxLength: 4096, description: 'Existing project-relative .html/.htm entry for start only; defaults to index.html.' },
    } },
    async execute(_id, args, signal) {
      signal?.throwIfAborted();
      try {
        if (!args || !['discover', 'start', 'status', 'stop'].includes(args.action) || Object.keys(args).some(key => !['action', 'path'].includes(key)) || (args.path !== undefined && (args.action !== 'start' || typeof args.path !== 'string' || !args.path || args.path.length > 4096))) {
          throw Object.assign(new Error('Use action discover/start/status/stop; path is only valid for start.'), { code: 'PREVIEW_ARGUMENTS_INVALID' });
        }
        // Validate the captured project for all operations, including stop;
        // models cannot use the service's low-level stop method on another ID.
        service.project(projectId);
        const preview = args.action === 'discover' ? await service.discoverPreview(projectId, { ...context, signal })
          : args.action === 'start' ? await service.startPreview(projectId, { path: args.path ?? 'index.html' }, { ...context, signal })
          : args.action === 'stop' ? await service.stopPreview(projectId) : service.previewStatus(projectId);
        signal?.throwIfAborted();
        return { content: [{ type: 'text', text: JSON.stringify({ ...preview,
          evidence: 'Static preview lifecycle only; no browser navigation, visual review or interaction check has been performed by this tool.',
          ...(preview.status === 'ready' ? { nextStep: 'Use the actual browser tools to navigate this exact URL, inspect the page and exercise the relevant user flow. After changing files, reload and recheck the affected behavior.' } : {}),
        }) }], details: { ...preview } };
      } catch (error) {
        signal?.throwIfAborted();
        return { isError: true, content: [{ type: 'text', text: error.status || error.code === 'PREVIEW_ARGUMENTS_INVALID' ? error.message : '项目静态预览不可用，请检查入口文件与工作区状态。' }], details: { code: error.code ?? 'PREVIEW_UNAVAILABLE', rendered: false } };
      }
    },
  }, {
    id: 'project_dev_preview', name: 'project_dev_preview', label: '开发服务器预览', permission: 'exec', effect: 'write', idempotent: false,
    description: 'Start/status/stop the project’s managed Vite frontend development preview with real HMR. Requires project execution permission and an assigned project_exec capability. directory is a relative directory with package.json and an already-installed local Vite dependency. Runs Vite and its project configuration/plugins with host-user rights; it is not an OS sandbox. Does not install packages, execute arbitrary npm scripts, support Next.js/backend servers or attach to an existing unknown port. The UI automatically displays the real ready URL; the process group is closed on revocation, owner session/archive/deletion, project change or daemon shutdown. Use browser tools for actual verification; HMR is not visual verification.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string', enum: ['start', 'status', 'stop'] }, directory: { type: 'string', maxLength: 4096, description: 'Project-relative Vite directory; empty means project root. Only valid with start.' } } },
    async execute(_id, args, signal) {
      signal?.throwIfAborted();
      try {
        if (!args || !['start', 'status', 'stop'].includes(args.action) || Object.keys(args).some(key => !['action', 'directory'].includes(key)) || args.directory !== undefined && (args.action !== 'start' || typeof args.directory !== 'string' || args.directory.length > 4096)) throw Object.assign(new Error('Use action start/status/stop and a relative directory for start.'), { code: 'PREVIEW_ARGUMENTS_INVALID' });
        service.project(projectId);
        const result = args.action === 'start' ? await service.startPreview(projectId, { mode: 'vite', directory: args.directory ?? '' }, { ...context, signal }) : args.action === 'stop' ? await service.stopPreview(projectId) : service.previewStatus(projectId);
        signal?.throwIfAborted();
        return { content: [{ type: 'text', text: JSON.stringify({ ...result, evidence: 'Actual development-server lifecycle only; no browser interaction or visual verification performed.' }) }], details: result };
      } catch (error) {
        signal?.throwIfAborted();
        return { isError: true, content: [{ type: 'text', text: error.status || error.code === 'PREVIEW_ARGUMENTS_INVALID' ? error.message : '开发预览不可用，请检查执行权限、依赖和项目配置。' }], details: { code: error.code ?? 'PREVIEW_UNAVAILABLE', cleanupUncertain: error.code === 'PREVIEW_CLEANUP_UNCERTAIN', rendered: false } };
      }
    }
  }];
}
