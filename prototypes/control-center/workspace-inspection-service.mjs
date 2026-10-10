import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { workspacePrivateSegment } from '../../packages/sdk/src/workspace-tools.mjs';
import { registeredWorkspacePath } from './workspace-directories.mjs';
import { PreviewResourceWatch } from './preview-resource-watch.mjs';
import { permissionLevel } from './project-permissions.mjs';
import { interfaceLanguageOf, inLanguage } from './interface-language.mjs';
import { localizeErrorMessage } from './api-error-text.mjs';
import { startVitePreview } from './workspace-dev-preview.mjs';
import { discoverWorkspacePreview, ensureWorkspacePreview } from './workspace-preview-discovery.mjs';

const within = (root, path) => { const part = relative(root, path); return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };
const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const hidden = name => workspacePrivateSegment(name) || /^\.(?:rna|pi|genomes|initialization|evolution|capabilities|archive)$/iu.test(name);
const types = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.mp4': 'video/mp4' };
const languages = { '.html': 'html', '.htm': 'html', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'typescript', '.tsx': 'tsx', '.jsx': 'jsx', '.css': 'css', '.json': 'json', '.md': 'markdown', '.py': 'python', '.sh': 'shell', '.yml': 'yaml', '.yaml': 'yaml', '.svg': 'xml' };
// Raw inline reads (the web file preview) also name documents and data files;
// anything unknown stays application/octet-stream.
const rawTypes = { ...types, '.md': 'text/markdown; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.tsv': 'text/tab-separated-values; charset=utf-8', '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.bmp': 'image/bmp', '.avif': 'image/avif', '.webm': 'video/webm', '.wav': 'audio/wav' };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const versionOf = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

/** Read-only project files and real static HTTP previews. This is a path guard,
 * not an OS sandbox against a process actively replacing filesystem ancestors.
 * With `sessionId` (worktree design 0.63 §9) reads and previews go through that
 * conversation's root (RootResolver: its own worktree when it runs in one, else
 * the project folder), and a scope stays valid only while state names the same root. */
export class WorkspaceInspectionService {
  constructor(store, { getDaemonOrigin, maxTextBytes = 512 * 1024, maxFileBytes = 32 * 1024 * 1024, maxEntries = 200, maxPreviews = 5, maxConcurrent = 8, roots = null, previewSandbox = null } = {}) {
    // previewSandbox (test seam): whether sandbox-exec is there for a Vite preview of an isolated root (default: the SDK's check).
    this.store = store; this.getDaemonOrigin = getDaemonOrigin; this.roots = roots; this.previewSandbox = previewSandbox;
    for (const [name, value, ceiling] of [['maxTextBytes', maxTextBytes, 1024 * 1024], ['maxFileBytes', maxFileBytes, 64 * 1024 * 1024], ['maxEntries', maxEntries, 1000], ['maxPreviews', maxPreviews, 5], ['maxConcurrent', maxConcurrent, 16]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new TypeError(`Invalid ${name}`);
      this[name] = value;
    }
    this.previews = new Map(); this.starting = new Map(); this.generations = new Map(); this.inFlight = 0; this.closed = false;
    this.unsubscribe = store.subscribe(() => {
      for (const [id, preview] of this.previews) if (!this.current(preview.scope)) void this.stopPreview(id).catch(() => {});
    }, { display: false });
  }
  project(id) {
    const project = this.store.state.projects.find(row => row.id === id);
    if (!project) throw fail('项目不存在。', 'PROJECT_NOT_FOUND', 404);
    if (project.archivedAt) throw fail('项目已归档。', 'PROJECT_ARCHIVED', 409);
    return project;
  }
  current(scope) {
    const project = this.store.state.projects.find(row => row.id === scope.projectId);
    const session = scope.sessionId ? this.store.state.sessions.find(row => row.id === scope.sessionId) : null;
    return !this.closed && project && !project.archivedAt && project.workspace === scope.workspace
      && (!scope.execute || permissionLevel(project, scope.permissionScope) === 'execute' && project.assignments?.toolIds?.includes('project_exec'))
      && (!scope.sessionId || session?.projectId === project.id && !session.archivedAt)
      && this.sameRoot(scope);
  }
  /** A conversation's root (rootSessionId) is still the one this scope was opened on: same worktree, or the project folder. */
  sameRoot(scope) {
    // A worktree conversation whose worktree is not made yet reads and previews the project folder, which is what its
    // worktree will be made from; once the worktree exists (its first turn) the scope is stale and closes.
    if (scope.pendingSessionId) {
      const session = this.store.state.sessions.find(row => row.id === scope.pendingSessionId);
      return session?.projectId === scope.projectId && (!session.worktree || session.worktree.state === 'pending');
    }
    if (!scope.rootSessionId) return true;
    if (this.roots) return this.roots.current({ projectId: scope.projectId, sessionId: scope.rootSessionId }, { kind: scope.rootKind, worktreeId: scope.worktreeId });
    const session = this.store.state.sessions.find(row => row.id === scope.rootSessionId);
    return session?.projectId === scope.projectId && !session.worktree && scope.rootKind === 'project';
  }
  /** The folder a conversation's reads use: RootResolver's answer, or (none wired) the project folder of a direct-mode conversation. */
  async sessionRoot(id, sessionId) {
    const say = variants => inLanguage(interfaceLanguageOf(this.store.state), variants);
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw fail(say({ zh: '无效的对话。', en: 'That conversation isn’t valid.' }), 'WORKSPACE_SESSION_INVALID');
    if (this.roots) return this.roots.rootOf({ projectId: id, sessionId });
    const session = this.store.state.sessions.find(row => row.id === sessionId);
    if (!session || session.projectId !== id) throw fail(say({ zh: '这个对话不属于该项目。', en: 'This conversation isn’t part of the project.' }), 'WORKSPACE_SESSION_INVALID', 404);
    if (session.worktree) throw fail(say({ zh: '这个对话的工作树现在不可用。', en: 'This conversation’s worktree isn’t available right now.' }), 'WORKSPACE_UNAVAILABLE', 409);
    return { root: await realpath(registeredWorkspacePath(this.project(id).workspace)), kind: 'project', isolated: false };
  }
  /** A conversation of this project that runs in its own worktree, not created yet (`session.worktree.state` 'pending'). */
  pendingWorktree(id, sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const session = this.store.state.sessions.find(row => row.id === sessionId);
    return session?.projectId === id && session.worktree?.state === 'pending';
  }
  async scope(id, { sessionId } = {}) {
    if (this.closed) throw fail('文件服务已关闭。', 'WORKSPACE_CLOSED', 503);
    const project = this.project(id), workspace = project.workspace, folder = await realpath(registeredWorkspacePath(workspace));
    // A worktree conversation before its first turn (or restored after archiving, its worktree removed) has no folder of
    // its own yet: it reads and previews the project folder its worktree will be made from (RootResolver would answer
    // worktree_pending). The scope remembers that and goes stale as soon as the worktree exists.
    const pending = this.pendingWorktree(id, sessionId);
    const rooted = pending || sessionId === undefined || sessionId === null || sessionId === '' ? null : await this.sessionRoot(id, sessionId);
    const root = rooted ? rooted.root : folder, info = await lstat(root);
    if (!info.isDirectory()) throw fail('工作目录不可用。', 'WORKSPACE_UNAVAILABLE', 409);
    // The project root is canonical, so every private state prefix must be too.
    // Canonicalize its existing parent, not the file: an absent/replaced state
    // file must never remove the denial for its journals and other namespaces.
    const privateState = resolve(this.store.file), privateStateParent = await realpath(dirname(privateState));
    const scope = { projectId: id, workspace, root, project: folder, info, privateState, privateStateParent, privateStates: [...new Set([privateState, resolve(privateStateParent, basename(privateState))])],
      ...(pending ? { pendingSessionId: sessionId } : {}),
      ...(rooted ? { rootSessionId: sessionId, rootKind: rooted.kind, ...(rooted.worktreeId ? { worktreeId: rooted.worktreeId } : {}) } : {}) };
    await this.checkScope(scope); return scope;
  }
  async checkScope(scope) {
    if (!this.current(scope)) throw fail('项目目录或状态已改变，请重新打开。', 'WORKSPACE_CHANGED', 409);
    const actual = await realpath(scope.worktreeId ? scope.root : registeredWorkspacePath(scope.workspace)), info = await lstat(actual);
    if (!this.current(scope) || actual !== scope.root || !sameFile(info, scope.info) || !info.isDirectory() || resolve(this.store.file) !== scope.privateState || await realpath(dirname(scope.privateState)) !== scope.privateStateParent) throw fail('工作目录身份已改变。', 'WORKSPACE_CHANGED', 409);
  }
  path(input = '') {
    if (typeof input !== 'string' || input.length > 4096 || /[\\\0]/u.test(input) || isAbsolute(input) || input.split('/').some(part => ['.', '..'].includes(part)) || input.split('/').some(part => hidden(part))) throw fail('路径超出项目范围或属于私密文件。', 'WORKSPACE_PATH_DENIED', 403);
    if (input && input.split('/').some(part => !part)) throw fail('无效的项目相对路径。', 'WORKSPACE_PATH_INVALID');
    return input;
  }
  allowed(scope, target) {
    // The host state and every adjacent journal/secret/archive namespace remain
    // private even when the user intentionally opens the host source directory.
    if (!within(scope.root, target) || scope.privateStates.some(state => target === state || target.startsWith(`${state}.`)) || relative(scope.root, target).split(sep).some(hidden)) throw fail('路径超出项目范围或属于私密文件。', 'WORKSPACE_PATH_DENIED', 403);
    return target;
  }
  async checked(scope, input) {
    const path = this.path(input), target = this.allowed(scope, resolve(scope.root, path));
    let cursor = scope.root;
    for (const segment of path ? path.split('/') : []) {
      cursor = this.allowed(scope, resolve(cursor, segment)); const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw fail('文件浏览与预览不跟随符号链接。', 'WORKSPACE_PATH_DENIED', 403);
    }
    if (await realpath(target) !== target) throw fail('路径身份已改变。', 'WORKSPACE_PATH_DENIED', 403);
    await this.checkScope(scope); return target;
  }
  async limited(task) {
    if (this.inFlight >= this.maxConcurrent) throw fail('同时读取的文件过多，请稍后重试。', 'WORKSPACE_BUSY', 429);
    this.inFlight++;
    try { return await task(); }
    catch (error) {
      if (error.status) throw error;
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw fail('文件或目录不存在。', 'WORKSPACE_NOT_FOUND', 404);
      if (['EACCES', 'EPERM', 'ELOOP'].includes(error.code)) throw fail('文件不可访问。', 'WORKSPACE_PATH_DENIED', 403);
      throw error;
    } finally { this.inFlight--; }
  }
  async list(id, { path = '', sessionId } = {}) {
    return this.limited(async () => {
      const scope = await this.scope(id, { sessionId }), target = await this.checked(scope, path), info = await lstat(target);
      if (!info.isDirectory()) throw fail('此路径不是目录。', 'WORKSPACE_NOT_DIRECTORY', 400);
      const dir = await opendir(target), entries = []; let scanned = 0, truncated = false;
      try {
        for await (const row of dir) {
          if (++scanned > this.maxEntries * 10) { truncated = true; break; }
          if (hidden(row.name) || row.isSymbolicLink() || (!row.isFile() && !row.isDirectory())) continue;
          const child = path ? `${path}/${row.name}` : row.name;
          try {
            const resolved = await this.checked(scope, child), stat = await lstat(resolved);
            if (!stat.isFile() && !stat.isDirectory()) continue;
            if (entries.length >= this.maxEntries) { truncated = true; break; }
            entries.push({ name: row.name, path: child, type: stat.isDirectory() ? 'directory' : 'file', size: stat.isFile() ? stat.size : null });
          } catch (error) { if (!['WORKSPACE_PATH_DENIED', 'ENOENT'].includes(error.code)) throw error; }
        }
      } finally { await dir.close().catch(error => { if (error.code !== 'ERR_DIR_CLOSED') throw error; }); }
      await this.checkScope(scope);
      return { path, entries: entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1), truncated };
    });
  }
  async bytes(scope, path, { text = false } = {}) {
    if (!path) throw fail('请选择项目文件。', 'WORKSPACE_PATH_INVALID');
    // O_NONBLOCK prevents a FIFO substituted just before open from hanging the
    // daemon; fstat below still rejects everything except regular files.
    const target = await this.checked(scope, path), file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile()) throw fail('此路径不是普通文件。', 'WORKSPACE_NOT_FILE', 400);
      if (!text && info.size > this.maxFileBytes) throw fail('文件超过下载或预览大小限制。', 'WORKSPACE_FILE_TOO_LARGE', 413);
      if (!sameFile(info, await lstat(await this.checked(scope, path)))) throw fail('文件在读取前发生替换，请重试。', 'WORKSPACE_CHANGED', 409);
      const limit = text ? this.maxTextBytes : this.maxFileBytes, buffer = Buffer.alloc(Math.min(info.size, limit) + 1); let length = 0;
      while (length < buffer.length) { const chunk = await file.read(buffer, length, buffer.length - length, length); if (!chunk.bytesRead) break; length += chunk.bytesRead; }
      if (!text && length > limit) throw fail('文件超过下载或预览大小限制。', 'WORKSPACE_FILE_TOO_LARGE', 413);
      const after = await file.stat(), current = await lstat(await this.checked(scope, path));
      if (!sameFile(info, current) || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw fail('文件正在修改，请重试。', 'WORKSPACE_CHANGED', 409);
      return { bytes: buffer.subarray(0, Math.min(length, limit)), size: info.size, version: versionOf(after), truncated: length > limit || info.size > limit };
    } finally { await file.close(); }
  }
  async read(id, { path, sessionId } = {}) {
    return this.limited(async () => {
      const scope = await this.scope(id, { sessionId }), value = await this.bytes(scope, path, { text: true }); let content;
      try { if (value.bytes.includes(0)) throw new Error('binary'); content = new TextDecoder('utf-8', { fatal: true }).decode(value.bytes, { stream: value.truncated }); }
      catch { throw fail('此文件不是 UTF-8 文本，请下载查看。', 'WORKSPACE_NOT_TEXT', 415); }
      return { path, content, language: languages[extname(path).toLowerCase()] ?? 'text', bytes: value.size, truncated: value.truncated };
    });
  }
  async download(id, { path, sessionId } = {}) {
    return this.limited(async () => {
      const scope = await this.scope(id, { sessionId }), value = await this.bytes(scope, path);
      return { bytes: value.bytes, filename: basename(path), contentType: types[extname(path).toLowerCase()] ?? 'application/octet-stream' };
    });
  }
  /** Complete bytes for inline preview with a real MIME type (same guards and size cap as download). */
  async raw(id, { path, sessionId } = {}) {
    return this.limited(async () => {
      const scope = await this.scope(id, { sessionId }), value = await this.bytes(scope, path);
      return { bytes: value.bytes, size: value.size, version: value.version, filename: basename(path), contentType: rawTypes[extname(path).toLowerCase()] ?? 'application/octet-stream' };
    });
  }
  view(record) { return { status: 'ready', kind: record.kind ?? 'static', url: record.url ?? `${record.origin}/${record.token}/${record.entryPath.split('/').map(encodeURIComponent).join('/')}`, origin: record.origin, entryPath: record.entryPath, generation: record.token, revision: record.dev?.revision() ?? record.revision ?? 0, liveReload: record.kind === 'vite' ? 'hmr' : 'reload', ...(record.watch?.truncated ? { watchTruncated: true } : {}), ...(record.watchError ? { watchError: record.watchError } : {}) }; }
  previewStatus(id) {
    this.project(id); const record = this.previews.get(id);
    if (record && this.current(record.scope) && !record.stopped && record.origin && (record.kind !== 'vite' || record.dev?.alive())) return this.view(record);
    if (record && !this.current(record.scope)) void this.stopPreview(id).catch(() => {});
    return { status: 'stopped', kind: 'static' };
  }
  // S1 side panel: the run preview as a browser-tab target (GET /api/v2/projects/:id/preview).
  browserPreview(id) {
    const status = this.previewStatus(id), base = `/api/projects/${id}/preview`, ready = status.status === 'ready';
    return { projectId: id, ...status, browser: ready ? { url: status.url, title: status.kind === 'vite' ? 'Vite 开发预览' : status.entryPath || '预览', openIn: 'browser-tab' } : null,
      actions: { start: { method: 'POST', path: base, body: { mode: 'auto' } }, stop: { method: 'DELETE', path: base }, discover: { method: 'GET', path: `${base}/discovery` } } };
  }
  discoverPreview(id, context = {}) { return discoverWorkspacePreview(this, id, context); }
  async startPreview(id, input = {}, context = {}) {
    context.signal?.throwIfAborted();
    if (input.mode === 'auto') return ensureWorkspacePreview(this, id, input, context);
    const mode = input.mode ?? 'static', path = mode === 'vite' ? input.directory ?? '' : input.path ?? 'index.html';
    if (!['static', 'vite'].includes(mode) || Object.keys(input).some(key => !['mode', 'path', 'directory', 'sessionId'].includes(key)) || mode === 'vite' && input.path !== undefined || mode === 'static' && input.directory !== undefined) throw fail('预览参数无效。', 'PREVIEW_ARGUMENTS_INVALID');
    const owner = { permissionScope: context.permissionScope ?? 'foreground', sessionId: context.permissionScope === 'background' ? undefined : context.sessionId ?? input.sessionId };
    if (this.closed) throw fail('文件服务已关闭。', 'WORKSPACE_CLOSED', 503);
    if (this.starting.has(id)) {
      const pending = this.starting.get(id);
      if (pending.entryPath !== path || pending.mode !== mode) throw fail('此项目正在启动另一个预览，请稍后重试。', 'PREVIEW_STARTING', 409);
      return pending;
    }
    if (!this.previews.has(id) && new Set([...this.previews.keys(), ...this.starting.keys()]).size >= this.maxPreviews) throw fail('最多同时打开五个项目预览，请先关闭一个。', 'PREVIEW_LIMIT', 429);
    const generation = (this.generations.get(id) ?? 0) + 1; this.generations.set(id, generation);
    const task = this.start(id, path, generation, mode, owner, context.signal); task.entryPath = path; task.mode = mode; this.starting.set(id, task);
    try { return await task; } finally { if (this.starting.get(id) === task) this.starting.delete(id); }
  }
  async start(id, path, generation, mode, owner, signal) {
    const check = () => { signal?.throwIfAborted(); if (this.closed || this.generations.get(id) !== generation) throw fail('预览启动已取消。', 'PREVIEW_CANCELLED', 409); };
    const scope = await this.limited(async () => {
      // A foreground preview serves its conversation's root (its worktree, or the project folder). An owner that is not
      // a conversation of this project is refused below, as before, by the execution checks.
      const rootSession = owner.sessionId && this.store.state.sessions.find(row => row.id === owner.sessionId)?.projectId === id ? owner.sessionId : undefined;
      const scope = await this.scope(id, { sessionId: rootSession }); this.path(path);
      if (mode === 'vite') {
        Object.assign(scope, { execute: true, ...owner });
        if (!this.current(scope)) throw fail('开发预览需要此项目已分配命令工具和执行权限，以及有效的所属会话。', 'PREVIEW_EXECUTION_DENIED', 403);
        const target = await this.checked(scope, path); if (!(await lstat(target)).isDirectory()) throw fail('请选择框架项目目录。', 'PREVIEW_DIRECTORY_REQUIRED');
        scope.directory = target;
        const manifest = await this.bytes(scope, path ? `${path}/package.json` : 'package.json', { text: true });
        if (manifest.truncated) throw fail('package.json 超出读取限制。', 'PREVIEW_PACKAGE_INVALID');
        try { scope.packageManifest = JSON.parse(manifest.bytes.toString('utf8')); } catch { throw fail('项目 package.json 无效。', 'PREVIEW_PACKAGE_INVALID'); }
        return scope;
      }
      if (!['.html', '.htm'].includes(extname(path).toLowerCase())) throw fail('静态预览需要实际存在的 HTML 入口文件。', 'PREVIEW_HTML_REQUIRED', 400);
      await this.bytes(scope, path); return scope;
    }); check();
    const daemonOrigin = this.getDaemonOrigin?.();
    if (typeof daemonOrigin !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(daemonOrigin)) throw fail('控制平台尚未开始监听。', 'PREVIEW_DAEMON_UNAVAILABLE', 503);
    const previous = this.previews.get(id);
    if (previous && this.current(previous.scope) && previous.scope.root === scope.root && sameFile(previous.scope.info, scope.info) && previous.entryPath === path && (previous.kind ?? 'static') === mode && previous.scope.sessionId === scope.sessionId && !previous.stopped && (mode !== 'vite' || previous.dev?.alive())) return this.view(previous);
    if (previous) await this.stopRecord(id, previous); check(); await this.checkScope(scope);
    const record = { scope, entryPath: path, kind: mode, token: randomBytes(32).toString('hex'), daemonOrigin, stopped: false, origin: null, revision: 0, abort: new AbortController() };
    if (mode === 'vite') {
      this.previews.set(id, record);
      try {
        record.devTask = startVitePreview({ scope, token: record.token, daemonOrigin, stateFile: this.store.file, current: () => !record.stopped && this.current(scope), validateScope: () => this.checkScope(scope), signal: signal ? AbortSignal.any([record.abort.signal, signal]) : record.abort.signal, say: variants => inLanguage(interfaceLanguageOf(this.store.state), variants), ...(this.previewSandbox ? { sandbox: this.previewSandbox } : {}) });
        record.dev = await record.devTask;
        record.origin = record.dev.origin; record.url = record.dev.url; check(); await this.checkScope(scope);
        record.monitor = setInterval(() => {
          if (record.stopped || record.monitoring) return;
          record.monitoring = this.checkScope(scope).then(() => { if (!record.dev.alive()) throw fail('开发服务已退出。', 'PREVIEW_STOPPED'); }).catch(() => { void this.stopPreview(id).catch(() => {}); }).finally(() => { record.monitoring = null; });
        }, 500); record.monitor.unref?.();
        return this.view(record);
      } catch (error) { await this.stopRecord(id, record); throw error; }
    }
    record.server = createServer({ maxHeaderSize: 8192 }, (request, response) => { void this.serve(record, request, response); });
    record.server.requestTimeout = 10000; record.server.headersTimeout = 10000; record.server.keepAliveTimeout = 1000;
    record.server.maxConnections = 32; record.server.maxHeadersCount = 32; record.server.maxRequestsPerSocket = 100;
    record.server.on('error', () => {}); this.previews.set(id, record);
    record.listening = new Promise((done, reject) => { record.server.once('error', reject); record.server.listen(0, '127.0.0.1', () => { record.server.off('error', reject); done(); }); });
    try {
      await record.listening; check(); await this.checkScope(scope);
      record.origin = `http://127.0.0.1:${record.server.address().port}`;
      record.watch = new PreviewResourceWatch({ inspect: async path => versionOf(await lstat(await this.checked(scope, path))), changed: () => { if (!record.stopped) { record.revision++; record.watchError = null; } }, failed: error => { record.watchError = error.code ?? 'PREVIEW_WATCH_FAILED'; if (error.code === 'WORKSPACE_CHANGED') void this.stopPreview(id).catch(() => {}); } });
      record.watch.add(path, versionOf(await lstat(await this.checked(scope, path))));
      return this.view(record);
    } catch (error) { await this.stopRecord(id, record); throw error; }
  }
  async serve(record, request, response) {
    try {
      if (record.stopped || !this.current(record.scope)) throw fail('预览已关闭。', 'PREVIEW_STOPPED', 410);
      if (request.headers.host !== record.origin?.slice('http://'.length)) throw fail('无效的预览来源。', 'PREVIEW_ORIGIN_DENIED', 403);
      if ((request.headers.origin && request.headers.origin !== record.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw fail('预览不接受跨来源请求。', 'PREVIEW_ORIGIN_DENIED', 403);
      if (!['GET', 'HEAD'].includes(request.method)) throw fail('静态预览仅接受读取。', 'PREVIEW_METHOD_DENIED', 405);
      const rawPath = request.url.split('?')[0], prefix = `/${record.token}/`;
      if (!rawPath.startsWith(prefix)) throw fail('预览地址无效。', 'PREVIEW_NOT_FOUND', 404);
      let path;
      try { path = rawPath.slice(prefix.length).split('/').map(decodeURIComponent).join('/'); } catch { throw fail('预览路径无效。', 'WORKSPACE_PATH_INVALID', 400); }
      if (!path || path.endsWith('/')) path += 'index.html';
      let value;
      try { value = await this.limited(() => this.bytes(record.scope, path)); }
      catch (error) {
        // HTML is often created before its JS/CSS during an agent turn. An
        // allowed dependency's first 404 must still wake the live preview when
        // the file appears; denied/private paths must never enter the watcher.
        if (error.code === 'WORKSPACE_NOT_FOUND' && !record.stopped && this.current(record.scope)) record.watch?.add(path, 'missing');
        throw error;
      }
      if (record.stopped || !this.current(record.scope)) throw fail('预览已关闭。', 'PREVIEW_STOPPED', 410);
      record.watch?.add(path, value.version);
      response.writeHead(200, { 'Content-Type': types[extname(path).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': value.bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': `default-src 'self' https: data: blob:; script-src 'self' https: 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' https: 'unsafe-inline'; connect-src 'self' https:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors ${record.daemonOrigin}` });
      response.end(request.method === 'HEAD' ? undefined : value.bytes);
    } catch (error) {
      if (response.destroyed) return;
      response.writeHead(error.status ?? 500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(localizeErrorMessage(error.status ? error.message : '无法读取预览文件。', interfaceLanguageOf(this.store.state)));
    }
  }
  async stopRecord(id, record) {
    if (record.closing) return record.closing;
    record.stopped = true;
    record.abort.abort();
    clearInterval(record.monitor);
    record.watch?.close();
    record.closing = (async () => {
      if (record.kind === 'vite') {
        const dev = record.dev ?? await record.devTask?.catch(error => { if (error.code === 'PREVIEW_CLEANUP_UNCERTAIN') throw error; return null; });
        await dev?.stop();
        if (this.previews.get(id) === record) this.previews.delete(id);
        return;
      }
      await record.listening?.catch(() => {});
      await new Promise(done => { record.server.close(() => done()); record.server.closeAllConnections(); });
      if (this.previews.get(id) === record) this.previews.delete(id);
    })();
    return record.closing;
  }
  async stopPreview(id) {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    const record = this.previews.get(id); if (record) await this.stopRecord(id, record);
    await this.starting.get(id)?.catch(() => {});
    return { status: 'stopped', kind: 'static' };
  }
  async close() {
    this.closed = true; this.unsubscribe?.();
    await Promise.all([...new Set([...this.previews.keys(), ...this.starting.keys()])].map(id => this.stopPreview(id)));
  }
}
