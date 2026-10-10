// Trusted launcher, executed inside the existing command guardian. Project Vite
// configuration/plugins are executable project code, not a security sandbox.
// For an isolated root (a worktree: agent-written code) the host runs this
// launcher under sandbox-exec (workspace-dev-preview.mjs previewSandboxProfile).
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { realpath, lstat, mkdir } from 'node:fs/promises';

/**
 * Under the sandbox the project folder around the worktree is read-only, and Vite bundles a config file into the
 * nearest `node_modules/.vite-temp` — the project folder's, for a worktree without modules of its own — and only falls
 * back on EACCES, not on the sandbox's EPERM. An empty `node_modules` in the previewed folder keeps that write inside
 * the worktree; module resolution walks past an empty one to the project folder's.
 */
async function localModules(directory, workspace) {
  for (let folder = directory; ; folder = dirname(folder)) {
    const info = await lstat(join(folder, 'node_modules')).catch(() => null);
    if (info?.isDirectory()) return;
    if (folder === workspace || relative(workspace, folder).startsWith('..') || dirname(folder) === folder) break;
  }
  await mkdir(join(directory, 'node_modules')).catch(error => { if (error.code !== 'EEXIST') throw error; });
}

let raw = '', config, server, vite, stopping = false, origin, changedTimer;
const stop = async () => { if (stopping) return; stopping = true; clearTimeout(changedTimer); await vite?.close().catch(() => {}); if (server) { server.closeAllConnections(); server.close(); } };
process.on('SIGTERM', () => void stop().finally(() => { process.exitCode = 0; }));
process.on('SIGINT', () => void stop().finally(() => { process.exitCode = 0; }));
try {
  for await (const chunk of process.stdin) { raw += chunk.toString('utf8'); if (Buffer.byteLength(raw) > 32768) throw new Error('input'); }
  config = JSON.parse(raw); raw = '';
  const prefix = `/${config.token}/`;
  const sameWorkspace = async () => { try { const root = await realpath(config.workspace), info = await lstat(root); return root === config.workspace && info.isDirectory() && info.dev === config.rootIdentity.dev && info.ino === config.rootIdentity.ino; } catch { return false; } };
  const allowed = request => {
    if (request.headers.host !== new URL(origin).host || request.headers['sec-fetch-site'] === 'cross-site') return false;
    if (request.headers.origin && request.headers.origin !== origin) return false;
    try { return new URL(request.url, origin).pathname.startsWith(prefix); } catch { return false; }
  };
  server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    if (!origin || !allowed(request)) { response.writeHead(403); response.end('Preview access denied'); return; }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    if (!await sameWorkspace()) { response.writeHead(409); response.end('Workspace identity changed'); return; }
    response.setHeader('X-Rna-Preview-Identity', config.token);
    response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', `default-src 'self' https: data: blob:; script-src 'self' https: 'unsafe-inline' 'unsafe-eval'; style-src 'self' https: 'unsafe-inline'; connect-src 'self' ws://${new URL(origin).host} https:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors ${config.daemonOrigin}`);
    if (!vite || stopping) { response.writeHead(503); response.end('Preview starting'); return; }
    vite.middlewares(request, response, () => { response.writeHead(404); response.end('Preview not found'); });
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000; server.maxConnections = 48;
  // Authenticate upgrades before Vite's HMR listener can consume them.
  server.on('upgrade', (request, socket) => { if (!origin || !allowed(request)) socket.destroy(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  if (config.sandboxed === true) await localModules(config.directory, config.workspace);
  const module = await import(pathToFileURL(config.viteEntry).href);
  if (stopping) throw new Error('stopped');
  // Merge a normal project config, then replace server boundaries after its
  // resolution. User plugins remain user-authorized code; no shell is parsed.
  const boundary = { name: 'rna-managed-preview-boundary', enforce: 'post', configResolved(resolved) {
    resolved.root = config.directory; resolved.base = prefix; resolved.cacheDir = config.cacheDir;
    // In the managed macOS guardian, the optional FSEvents watcher can finish
    // its initial scan yet deliver no subsequent changes. Node fs.watch works
    // in that same process without a full-tree polling loop. Keep explicit
    // project choices (including polling for mounted filesystems) authoritative.
    const watch = { ...(process.platform === 'darwin' ? { useFsEvents: false, usePolling: false } : {}), ...resolved.server.watch };
    Object.assign(resolved.server, { host: '127.0.0.1', open: false, cors: false, proxy: undefined, middlewareMode: true,
      hmr: { server, path: `${prefix}hmr`, host: '127.0.0.1', clientPort: server.address().port },
      fs: { strict: true, allow: [config.workspace, ...(config.allow ?? [])], deny: config.denied }, watch: { ...watch, ignored: [...(Array.isArray(watch.ignored) ? watch.ignored : []), ...config.denied] } });
  } };
  vite = await module.createServer({ root: config.directory, base: prefix, cacheDir: config.cacheDir, logLevel: 'silent', clearScreen: false,
    plugins: [boundary], server: { middlewareMode: true, hmr: { server, path: `${prefix}hmr`, host: '127.0.0.1', clientPort: server.address().port },
      cors: false, proxy: undefined, open: false, fs: { strict: true, allow: [config.workspace, ...(config.allow ?? [])], deny: config.denied } } });
  if (stopping) throw new Error('stopped');
  const changed = () => { if (!stopping && !changedTimer) changedTimer = setTimeout(() => { changedTimer = null; if (!stopping) process.stdout.write(`RNA_PREVIEW_CHANGED ${JSON.stringify({ token: config.token })}\n`); }, 100); };
  for (const event of ['add', 'change', 'unlink']) vite.watcher.on(event, changed);
  process.stdout.write(`RNA_PREVIEW_READY ${JSON.stringify({ token: config.token, pid: process.pid, origin })}\n`);
} catch {
  process.stderr.write('PREVIEW_VITE_START_FAILED\n');
  await stop(); process.exitCode = 1;
}
