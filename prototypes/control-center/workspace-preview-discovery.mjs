import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { permissionLevel } from './project-permissions.mjs';

const inside = (root, path) => { const part = relative(root, path); return !part || !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`); };
const excluded = /^(?:node_modules|vendor|coverage|tests?|__tests__|fixtures?|\.\S*)$/iu;
const frameworks = ['next', 'nuxt', '@angular/core', 'gatsby', 'astro', '@sveltejs/kit'];
const joinPath = (directory, name) => directory ? `${directory}/${name}` : name;
const error = (message, code, status = 400) => Object.assign(new Error(message), { code, status });

/** Bounded, read-only entry discovery. Manifest scripts/configuration are data,
 * never evaluated. A framework source HTML must not masquerade as a ready
 * static application merely because its HTTP response is 200. */
export async function discoverWorkspacePreview(service, id, context = {}) {
  const scope = await service.scope(id), project = service.project(id);
  const queue = [{ path: '', depth: 0 }], candidates = [], manifests = new Map();
  let visited = 0, truncated = false;
  const check = async () => { context.signal?.throwIfAborted(); await service.checkScope(scope); };
  const candidate = value => candidates.push({ id: `${value.mode}:${value.path ?? value.directory}`, ...value });
  while (queue.length && visited < 24 && candidates.length < 24) {
    await check();
    const directory = queue.shift(); visited++;
    let listing;
    try { listing = await service.list(id, { path: directory.path }); }
    catch (failure) { if (['WORKSPACE_NOT_FOUND', 'WORKSPACE_PATH_DENIED'].includes(failure.code) && directory.path) continue; throw failure; }
    truncated ||= listing.truncated;
    const manifestPath = joinPath(directory.path, 'package.json');
    if (listing.entries.some(row => row.path === manifestPath && row.type === 'file')) {
      try {
        const data = await service.read(id, { path: manifestPath });
        if (!data.truncated) {
          const value = JSON.parse(data.content);
          if (value && typeof value === 'object' && !Array.isArray(value)) manifests.set(directory.path, value);
        }
      } catch (failure) { if (!(failure instanceof SyntaxError) && !['WORKSPACE_NOT_FOUND', 'WORKSPACE_PATH_DENIED', 'WORKSPACE_NOT_TEXT', 'WORKSPACE_CHANGED'].includes(failure.code)) throw failure; }
    }
    const manifest = manifests.get(directory.path), dependencies = { ...manifest?.dependencies, ...manifest?.devDependencies };
    const html = listing.entries.filter(row => row.type === 'file' && /\.html?$/iu.test(row.name));
    const isVite = typeof dependencies.vite === 'string';
    if (isVite) {
      let installed = false;
      try { const entry = await realpath(join(scope.root, directory.path, 'node_modules/vite/dist/node/index.js')); installed = inside(scope.root, entry) && (await lstat(entry)).isFile(); } catch {}
      const permitted = permissionLevel(project, context.permissionScope ?? 'foreground') === 'execute' && project.assignments?.toolIds?.includes('project_exec');
      const session = context.sessionId ? service.store.state.sessions.find(row => row.id === context.sessionId) : null;
      const ownerValid = context.permissionScope === 'background' || !context.sessionId || session?.projectId === id && !session.archivedAt;
      const entryExists = html.some(row => /^index\.html?$/iu.test(row.name));
      const reason = !entryExists ? 'entry_missing' : !installed ? 'vite_dependencies_missing' : !permitted || !ownerValid ? 'execute_permission_required' : null;
      candidate({ mode: 'vite', directory: directory.path, label: directory.path || '项目根目录', available: !reason, reason });
    }
    // Vite owns its source HTML entries. Built outputs in a child directory
    // remain separately discoverable; source JS/TS is never rewritten here.
    if (!isVite) for (const entry of html) {
      if (candidates.length >= 24) { truncated = true; break; }
      let data;
      try { data = await service.read(id, { path: entry.path }); }
      catch (failure) { if (['WORKSPACE_NOT_FOUND', 'WORKSPACE_PATH_DENIED', 'WORKSPACE_NOT_TEXT', 'WORKSPACE_CHANGED'].includes(failure.code)) continue; throw failure; }
      const requiresBuild = /<script\b[^>]*(?:\bsrc\s*=\s*["'][^"']*\.(?:tsx?|jsx)(?:[?#][^"']*)?["']|\btype\s*=\s*["'](?:text\/(?:typescript|babel)|module\/typescript)["'])/iu.test(data.content);
      const configuredFramework = frameworks.some(name => typeof dependencies[name] === 'string');
      const reason = data.truncated ? 'entry_too_large' : requiresBuild || configuredFramework ? 'framework_requires_build' : null;
      candidate({ mode: 'static', path: entry.path, label: entry.path, available: !reason, reason });
    }
    for (const row of listing.entries) if (row.type === 'directory' && !excluded.test(row.name)) {
      if (directory.depth < 3) queue.push({ path: row.path, depth: directory.depth + 1 });
      else truncated = true;
    }
  }
  truncated ||= queue.length > 0;
  await check();
  // A root entry is a clear conventional default. Multiple nested apps or
  // arbitrary HTML reports have no guessed winner, even if only one is runnable.
  const root = candidates.filter(row => row.mode === 'vite' && row.directory === '' || row.mode === 'static' && /^index\.html?$/iu.test(row.path));
  const selected = root.length === 1 ? root[0] : candidates.length === 1 && !truncated ? candidates[0] : null;
  return { status: selected?.available ? 'available' : selected || !candidates.length ? 'unavailable' : 'ambiguous', candidates,
    preferred: selected?.id ?? null, reason: selected?.reason ?? (selected ? null : candidates.length ? 'multiple_entries' : truncated ? 'scan_limit' : 'no_entry'), truncated };
}

/** Auto discovery is separate from status and cannot grant command permission.
 * A concurrent explicit stop/start wins over a scan that was already in flight. */
export async function ensureWorkspacePreview(service, id, input = {}, context = {}) {
  if (Object.keys(input).some(key => !['mode', 'sessionId'].includes(key))) throw error('自动预览仅接受 mode 与 sessionId。', 'PREVIEW_ARGUMENTS_INVALID');
  service.project(id); context.signal?.throwIfAborted();
  const current = service.previewStatus(id);
  if (current.status === 'ready') return current;
  const generation = service.generations.get(id) ?? 0;
  const discovery = await service.discoverPreview(id, { ...context, sessionId: context.sessionId ?? input.sessionId });
  context.signal?.throwIfAborted();
  if ((service.generations.get(id) ?? 0) !== generation) return { ...service.previewStatus(id), discovery, automatic: true, superseded: true };
  const candidate = discovery.candidates.find(row => row.id === discovery.preferred);
  if (!candidate?.available) return { status: 'stopped', kind: 'static', discovery, automatic: true };
  const value = await service.startPreview(id, { mode: candidate.mode, ...(candidate.mode === 'vite' ? { directory: candidate.directory } : { path: candidate.path }), ...(input.sessionId ? { sessionId: input.sessionId } : {}) }, context);
  return { ...value, automatic: true };
}
