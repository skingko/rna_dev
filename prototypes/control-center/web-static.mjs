// Static host for the workbench UI (web/dist), the only browser UI.
//
// - `/` and client routes serve web/dist/index.html.
// - Without a build, HTML requests get a small built-in page explaining how
//   to build the UI; other paths fall through (404 / API).
// - `/api/*` is never touched.
// Zero dependencies, like the rest of the daemon.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm', '.map': 'application/json; charset=utf-8'
};

// The React/Motion UI sets inline styles through CSSOM and Radix injects a
// scroll-lock <style>, so this document allows inline styles; scripts stay 'self'.
const WEB_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src http://127.0.0.1:* blob:; object-src blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// The fallback page has no scripts, styles or external resources.
const MISSING_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const MISSING_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Rna Agent · 界面尚未构建</title>
<style>body{font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;max-width:640px;margin:12vh auto;padding:0 24px;color:#222}code,pre{font:13px ui-monospace,Menlo,monospace}pre{background:#f4f4f5;padding:12px 14px;border-radius:8px;overflow:auto}@media(prefers-color-scheme:dark){body{background:#161616;color:#e8e8e8}pre{background:#232323}}</style></head>
<body><h1>界面尚未构建</h1>
<p>本地 daemon 正在运行，API 可用，但没有找到工作台界面的构建产物 <code>prototypes/control-center/web/dist</code>。</p>
<p>在仓库根目录执行：</p>
<pre>cd prototypes/control-center/web
npm ci
npm run build</pre>
<p>构建完成后刷新此页面即可，无需重启 daemon。</p>
<hr><p lang="en">The daemon is running, but the workbench UI has not been built. Run <code>npm ci &amp;&amp; npm run build</code> in <code>prototypes/control-center/web</code>, then reload.</p>
</body></html>
`;

export function createWebStatic({ headers, root, distDir = resolve(root, 'web', 'dist') }) {
  const dist = resolve(distDir);
  let checkedAt = 0, available = false;
  const hasBuild = () => {
    const now = Date.now();
    if (now - checkedAt > 2000) { checkedAt = now; available = existsSync(join(dist, 'index.html')); }
    return available;
  };
  const distFile = pathname => {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return null; }
    if (decoded.includes('\0') || decoded.split('/').some(part => part.startsWith('.'))) return null;
    const file = resolve(dist, normalize(`.${decoded}`));
    if (file !== dist && !file.startsWith(dist + sep)) return null;
    try { return statSync(file).isFile() ? file : null; } catch { return null; }
  };
  const sendFile = (res, file, extra = {}) => {
    res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', ...extra });
    res.end(readFileSync(file));
  };
  const sendIndex = res => sendFile(res, join(dist, 'index.html'), { 'Content-Security-Policy': WEB_CSP, 'Cache-Control': 'no-store' });

  const sendMissing = (req, res, pathname) => {
    const accept = String(req.headers.accept ?? '');
    if (pathname !== '/' && (extname(pathname) || (accept && !accept.includes('text/html') && !accept.includes('*/*')))) return false;
    res.writeHead(503, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': MISSING_CSP, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : MISSING_PAGE);
    return true;
  };

  /** @returns {boolean} true when the request was answered here. */
  return function handle(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (pathname === '/api' || pathname.startsWith('/api/')) return false;
    if (!hasBuild()) return sendMissing(req, res, pathname);
    if (pathname === '/favicon.ico') pathname = '/favicon.svg';
    if (pathname !== '/') {
      if (pathname.split('/').some(part => part.startsWith('.') || part.toLowerCase().startsWith('%2e'))) return false;
      const file = distFile(pathname);
      if (file) {
        if (file.endsWith(`${sep}index.html`)) { sendIndex(res); return true; }
        const immutable = pathname.startsWith('/assets/');
        sendFile(res, file, immutable ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : {});
        return true;
      }
      // Unknown file-like paths are real 404s, not the SPA shell.
      if (extname(pathname) || pathname.startsWith('/assets/')) return false;
      const accept = String(req.headers.accept ?? '');
      if (accept && !accept.includes('text/html') && !accept.includes('*/*')) return false;
    }
    sendIndex(res);
    return true;
  };
}
