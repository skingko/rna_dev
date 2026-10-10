import { mkdir, mkdtemp, realpath, lstat, rm } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, sep, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnGuardedCommand } from '../../packages/sdk/src/command-process-guardian.mjs';
import { SANDBOX_EXEC, sandboxAvailable, sandboxProfile, sandboxRuntimeFolders } from '../../packages/sdk/src/workspace-exec.mjs';
import { privateStatePaths, sandboxReadableStatePaths } from './state-privacy.mjs';

const fail = (message, code, status = 409) => Object.assign(new Error(message), { code, status });
const inside = (root, path) => { const p = relative(root, path); return !p || !isAbsolute(p) && p !== '..' && !p.startsWith(`..${sep}`); };
const worker = fileURLToPath(new URL('./workspace-dev-preview-worker.mjs', import.meta.url));
const daemonPortOf = origin => { try { const port = Number(new URL(origin).port); return Number.isInteger(port) && port > 0 ? port : undefined; } catch { return undefined; } };
const seatbeltString = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Whether a preview scope is an isolated root (a session, worker or background worktree inside the project folder P,
 * worktree design 0.63 §9): its files are the agent's, so its vite.config and plugins are agent-written code.
 */
export function isolatedPreview(scope) {
  return Boolean(scope?.worktreeId) || (Boolean(scope?.project) && scope.project !== scope.root && inside(scope.project, scope.root));
}
/**
 * The seatbelt profile a Vite preview of an isolated root runs under: project_exec's own for that root (writes only in
 * the root, temporary folders and package caches; all of P around it denied, the root's `.git` too — sandboxProfile with
 * `deny: [P]`, as CapabilityService gives an isolated registry; Rna's state and its `<state>.` siblings unreadable
 * except skill packages and the Node runtime, as stateConfinement gives it; no connection to Rna's own API port), plus
 * the preview's private Vite cache folder inside `<state>.previews`, readable and writable. Other reads and the loopback
 * listener stay open, which is all a dev server needs; what the root's config or plugins try to write anywhere else, or
 * to read from Rna's state, fails with "Operation not permitted".
 * @param {{ root: string, project: string }} scope
 * @param {string} cacheDir
 * @param {{ stateFile?: string, daemonPort?: number }} [options]
 */
export function previewSandboxProfile(scope, cacheDir, { stateFile, daemonPort } = {}) {
  const state = stateFile ? resolve(stateFile) : null;
  const profile = sandboxProfile(scope.root, { deny: [scope.project], ...(state ? { denyRead: privateStatePaths(state), denyPrefixes: [`${state}.`] } : {}),
    readable: [...(state ? sandboxReadableStatePaths(state) : []), ...sandboxRuntimeFolders(), cacheDir], ...(Number.isInteger(daemonPort) ? { denyPorts: [daemonPort] } : {}) });
  return `${profile}\n(allow file-write* (subpath ${seatbeltString(cacheDir)}))`;
}
/** A path as a literal picomatch prefix (Vite matches fs.deny and watch.ignored against absolute paths). */
export const escapeGlob = path => String(path).replace(/[\\*?[\]{}()!+@]/g, '\\$&');
const PRIVATE_FILES = ['.env', '.env.*', 'credentials*', 'auth.json', '*.secrets', '*.secrets.*', '*.subscriptions', '*.subscriptions.*', 'id_rsa', 'id_ed25519', '*.pem', '*.key', '*.p12'];
const PRIVATE_FOLDERS = ['.git', '.ssh', '.aws', '.state', '.runtime', '.rna', '.pi', '.genomes', '.initialization', '.evolution', '.capabilities', '.archive'];
/**
 * Vite's deny list for a preview root. Every pattern starts with the root itself (worktree design 0.63 §9): Vite
 * matches absolute paths, so a bare "any folder named .rna" pattern would deny every file of a root that lies
 * inside `<P>/.rna/worktrees.nosync/`. Matches file-inspection private segments; node_modules is the deliberate
 * exception (Vite must transform and serve the project's installed modules).
 */
export function previewDeniedPatterns(root, privateStates = []) {
  const base = escapeGlob(root);
  return [...PRIVATE_FILES.map(name => `${base}/**/${name}`), ...PRIVATE_FOLDERS.map(name => `${base}/**/${name}/**`),
    ...privateStates.flatMap(path => [escapeGlob(path), `${escapeGlob(path)}*/**`, `${escapeGlob(path)}*`])];
}
/**
 * The installed Vite a preview runs: `node_modules/vite` of the previewed folder. In a worktree root (inside the
 * project folder P) the lookup also walks up to P, as Node's own resolution does, since worktrees have no
 * node_modules of their own (design §6.4). It must lie inside the root, or inside P for a worktree.
 */
export async function viteEntryFor(scope) {
  const isolated = Boolean(scope.project) && scope.project !== scope.root && inside(scope.project, scope.root);
  for (let folder = scope.directory; ; folder = dirname(folder)) {
    const entry = await realpath(join(folder, 'node_modules/vite/dist/node/index.js')).catch(() => null);
    if (entry && inside(isolated ? scope.project : scope.root, entry) && (await lstat(entry)).isFile()) return entry;
    if (!isolated || folder === scope.project || !inside(scope.project, dirname(folder))) return null;
  }
}

/** Vite-only frontend adapter. Dependencies must already exist in the project.
 * The guardian owns the full process group through cancellation and host death.
 * An isolated root (worktree design 0.63 §9) runs its worker under sandbox-exec with previewSandboxProfile, so the
 * config and plugins an agent wrote there cannot write to the project folder; without a sandbox it does not run. */
export async function startVitePreview({ scope, token, daemonOrigin, stateFile, current, validateScope, signal, sandbox = sandboxAvailable, say = variants => variants.zh }) {
  const check = () => { signal?.throwIfAborted(); if (!current()) throw fail('项目状态或执行权限已改变。', 'PREVIEW_EXECUTION_DENIED', 403); };
  check();
  const isolated = isolatedPreview(scope);
  if (isolated && !sandbox()) throw fail(say({ zh: '这个对话在独立工作树里，它的开发预览只能在沙箱里运行，这台电脑上没有可用的沙箱。可以改用静态预览打开 HTML 文件。', en: 'This conversation runs in its own worktree, so its dev preview can only run in a sandbox, and none is available on this computer. You can open an HTML file with the static preview instead.' }), 'PREVIEW_SANDBOX_UNAVAILABLE', 409);
  let viteEntry;
  try {
    const manifest = scope.packageManifest;
    if (!manifest.dependencies?.vite && !manifest.devDependencies?.vite) throw new Error('dependency missing');
    viteEntry = await viteEntryFor(scope);
    if (!viteEntry) throw new Error('external dependency');
  } catch { throw fail('开发预览支持已安装 Vite 的项目。请先在项目中安装依赖；不会自动安装或执行任意 npm 脚本。', 'PREVIEW_VITE_UNAVAILABLE', 400); }
  check();
  const cacheRoot = `${resolve(stateFile)}.previews`; await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(cacheRoot)).isSymbolicLink() || await realpath(cacheRoot) !== join(scope.privateStateParent, `${basename(stateFile)}.previews`)) throw fail('预览私有目录身份无效。', 'PREVIEW_PRIVATE_DIRECTORY_INVALID', 403);
  const cacheDir = await mkdtemp(join(cacheRoot, 'vite-'));
  let child, ready, closed = false, output = '', stopped, revision = 0;
  const env = { PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`, NODE_ENV: 'development' };
  for (const name of ['TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'LANG']) if (process.env[name]) env[name] = process.env[name];
  try {
    await validateScope(); check();
    child = isolated
      ? spawnGuardedCommand(SANDBOX_EXEC, ['-p', previewSandboxProfile(scope, cacheDir, { stateFile, daemonPort: daemonPortOf(daemonOrigin) }), process.execPath, worker], { cwd: scope.directory, env })
      : spawnGuardedCommand(process.execPath, [worker], { cwd: scope.directory, env });
    child.on('error', () => {}); child.stdin.on('error', () => {});
    const close = new Promise(done => child.once('close', () => { closed = true; done(); }));
    const stop = () => stopped ??= (async () => {
      child.stop(); await Promise.race([close, delay(3500)]);
      if (!closed || child.commandResult.cleanupUncertain || child.commandResult.startUncertain) throw fail('开发预览进程的退出尚未确认，未自动重启。', 'PREVIEW_CLEANUP_UNCERTAIN', 503);
      await rm(cacheDir, { recursive: true, force: true });
    })();
    const abort = () => { void stop().catch(() => {}); }; signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', bytes => {
      // A bounded control line, never raw project logs or model-visible stdout.
      output += bytes.toString('utf8'); if (output.length > 65536) output = output.slice(-32768);
      const rows = output.split('\n'); output = rows.pop();
      for (const row of rows) {
        if (row.startsWith('RNA_PREVIEW_READY ')) { try { const value = JSON.parse(row.slice(18)); if (value.token === token && Number.isSafeInteger(value.pid) && /^http:\/\/127\.0\.0\.1:\d+$/u.test(value.origin)) ready = value; } catch {} }
        else if (row.startsWith('RNA_PREVIEW_CHANGED ')) { try { if (JSON.parse(row.slice(20)).token === token) revision++; } catch {} }
      }
    });
    child.stderr.resume();
    // Match file-inspection private segments, rooted at the preview root (previewDeniedPatterns).
    const denied = previewDeniedPatterns(scope.root, scope.privateStates);
    // A worktree root serves the modules installed in the project folder it lies in: that node_modules is allowed too.
    const modules = dirname(dirname(dirname(dirname(viteEntry)))), allow = inside(scope.root, modules) ? [] : [modules];
    child.stdin.end(JSON.stringify({ workspace: scope.root, rootIdentity: { dev: scope.info.dev, ino: scope.info.ino }, directory: scope.directory, viteEntry, cacheDir, token, daemonOrigin, denied, allow, ...(isolated ? { sandboxed: true } : {}) }));
    try {
      const deadline = Date.now() + 20000;
      while (!ready) { check(); if (closed) throw fail('Vite 未能启动，请检查已安装依赖与项目配置。', 'PREVIEW_VITE_START_FAILED'); if (Date.now() >= deadline) throw fail('Vite 启动超过20秒，已停止本次启动。', 'PREVIEW_START_TIMEOUT'); await delay(30); }
      check();
      if (ready.pid !== child.commandResult.pid) throw fail('开发预览进程身份未确认。', 'PREVIEW_IDENTITY_MISMATCH');
      const url = `${ready.origin}/${token}/`;
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      try { if (response.status !== 200 || response.headers.get('x-rna-preview-identity') !== token || !response.headers.get('content-type')?.includes('text/html')) throw fail('开发服务未返回实际 HTML 入口。', 'PREVIEW_NOT_READY'); }
      finally { await response.body?.cancel(); }
      check();
      return { url, origin: ready.origin, child, revision: () => revision, stop: async () => { signal?.removeEventListener('abort', abort); await stop(); }, alive: () => !closed && !stopped };
    } catch (error) { await stop(); throw error; }
    finally { if (closed) signal?.removeEventListener('abort', abort); }
  } catch (error) {
    if (!child) await rm(cacheDir, { recursive: true, force: true });
    throw error;
  }
}
