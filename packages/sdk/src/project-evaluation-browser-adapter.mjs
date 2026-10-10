import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdtemp, mkdir, open, opendir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { retainEvaluationScreenshot } from './project-evaluation-evidence.mjs';

export const BROWSER_EVALUATION_ADAPTER_ID = 'local-chromium-cdp-v1';
const executeFile = promisify(execFile);

const MAX_FILES = 100, MAX_BYTES = 2 * 1024 * 1024, MAX_FILE_BYTES = 256 * 1024, MAX_RECEIPTS = 100;
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const failure = (message, code = 'environment_unavailable') => Object.assign(new Error(message), { code });
const sha = value => createHash('sha256').update(value).digest('hex');
const safePath = value => typeof value === 'string' && value.length <= 200 && /^[\p{L}\p{N}_. -]+(?:\/[\p{L}\p{N}_. -]+)*$/u.test(value) && value.split('/').length <= 8 && !value.split('/').some(part => part.startsWith('.') || part === 'node_modules');
function invalid(message) { throw failure(message, 'invalid_evaluation_environment'); }

export { validateBrowserEvaluationEnvironment } from './project-evaluation-browser.mjs';
import { validateBrowserEvaluationEnvironment } from './project-evaluation-browser.mjs';

async function executable(explicit) {
  if (explicit !== undefined && (typeof explicit !== 'string' || !isAbsolute(explicit) || /[\0\r\n]/.test(explicit))) throw failure('Browser executable must be an absolute path');
  const choices = explicit ? [explicit] : process.platform === 'darwin' ? ['/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'] : process.platform === 'win32' ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map(root => join(root, 'Google/Chrome/Application/chrome.exe')) : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const path of choices) try { const actual = await realpath(path); if (!(await lstat(actual)).isFile()) continue; await access(actual, constants.X_OK); return actual; } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error; }
  throw failure('Chrome/Chromium is unavailable; browser evaluation was not scored');
}

async function readSnapshot(workspace, signal) {
  const root = await realpath(workspace), files = new Map(); let total = 0, entries = 0;
  const walk = async (path, prefix = '') => {
    signal?.throwIfAborted();
    for await (const item of await opendir(path)) {
      signal?.throwIfAborted(); if (++entries > 200) throw failure('Browser workspace exceeds its directory-entry limit', 'evaluation_workspace_invalid');
      const name = prefix ? prefix + '/' + item.name : item.name, absolute = join(path, item.name);
      if (!safePath(name)) throw failure('Browser workspace contains an unsafe path', 'evaluation_workspace_invalid');
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw failure('Browser workspace links are not allowed', 'evaluation_workspace_invalid');
      if (stat.isDirectory()) { await walk(absolute, name); continue; }
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES || files.size >= MAX_FILES || total + stat.size > MAX_BYTES) throw failure('Browser workspace exceeds regular-file limits', 'evaluation_workspace_invalid');
      const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat(); if (before.ino !== stat.ino || before.dev !== stat.dev || before.size !== stat.size || before.nlink !== 1) throw failure('Browser workspace changed during snapshot', 'evaluation_workspace_invalid');
        const content = await handle.readFile(), after = await handle.stat();
        if (content.length > MAX_FILE_BYTES || total + content.length > MAX_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw failure('Browser workspace changed during snapshot', 'evaluation_workspace_invalid');
        total += content.length; files.set(name, { bytes: content, hash: sha(content), contentType: mimeTypes[extname(name).toLowerCase()] ?? 'application/octet-stream' });
      } finally { await handle.close(); }
    }
  };
  await walk(root); return files;
}

class Cdp {
  constructor(socket, onEvent, signal) {
    this.socket = socket; this.pending = new Map(); this.sequence = 0;
    socket.addEventListener('message', event => { let value; try { value = JSON.parse(event.data); } catch { return; } if (value.id) { const call = this.pending.get(value.id); if (!call) return; this.pending.delete(value.id); clearTimeout(call.timer); value.error ? call.reject(failure('Browser protocol failed: ' + value.error.message)) : call.resolve(value.result); } else onEvent(value, this); });
    socket.addEventListener('close', () => this.reject(failure('Browser protocol disconnected')));
    socket.addEventListener('error', () => this.reject(failure('Browser protocol failed')));
    this.abort = () => this.reject(signal.reason ?? failure('Browser evaluation cancelled', 'aborted'));
    signal?.addEventListener('abort', this.abort, { once: true }); this.signal = signal;
  }
  async call(method, params = {}) {
    this.signal?.throwIfAborted();
    return new Promise((resolve, reject) => { const id = ++this.sequence, timer = setTimeout(() => { this.pending.delete(id); reject(failure('Browser protocol timed out: ' + method)); }, 5000); this.pending.set(id, { resolve, reject, timer }); try { this.socket.send(JSON.stringify({ id, method, params })); } catch { clearTimeout(timer); this.pending.delete(id); reject(failure('Browser protocol unavailable')); } });
  }
  reject(error) { for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); } this.pending.clear(); }
  close() { this.signal?.removeEventListener('abort', this.abort); this.reject(failure('Browser evaluation ended')); this.socket.close(); }
}

/** Fresh profile + browser policies, not an OS security sandbox. */
export function createBrowserEvaluationAdapter({ executablePath, startupTimeoutMs = 10000, artifactDirectory } = {}) {
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 500 || startupTimeoutMs > 30000) invalid('Browser startup timeout is invalid');
  if (artifactDirectory !== undefined && (typeof artifactDirectory !== 'string' || !isAbsolute(artifactDirectory))) invalid('Browser artifact directory must be an absolute host-owned path');
  let frozen;
  const probe = async ({ signal } = {}) => {
    signal?.throwIfAborted(); const binary = frozen?.binary ?? await executable(executablePath);
    try {
      const { stdout } = await executeFile(binary, ['--version'], { env: { PATH: '/usr/bin:/bin:' + dirname(binary), LANG: 'en_US.UTF-8' }, encoding: 'utf8', timeout: 10000, maxBuffer: 4096, signal });
      const version = stdout.trim(); if (!/\d+\.\d+\.\d+/.test(version)) throw failure('Browser version is unavailable');
      const executableHash = sha(await readFile(binary));
      if (frozen && (frozen.version !== version || frozen.executableHash !== executableHash)) throw failure('Browser changed after the evaluation environment was frozen', 'environment_changed');
      frozen ??= { binary, version, executableHash };
      return { available: true, adapter: BROWSER_EVALUATION_ADAPTER_ID, version, executableHash, executableHashScope: 'browser_launcher_binary', policy: 'fresh_profile_static_snapshot_block_external_v1' };
    } catch (error) { if (signal?.aborted) throw signal.reason; if (error.code === 'environment_changed') throw error; throw failure('Browser version probe failed; evaluation was not scored'); }
  };
  return {
    id: BROWSER_EVALUATION_ADAPTER_ID,
    probe,
    async verify({ workspace, environment, signal, artifactKey = 'case' } = {}) {
      const spec = validateBrowserEvaluationEnvironment(environment); if (!spec) invalid('Browser environment is required'); if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(artifactKey)) invalid('Browser artifact key is invalid'); signal?.throwIfAborted();
      const identity = await probe({ signal }), binary = frozen.binary, files = await readSnapshot(workspace, signal);
      if (!files.has(spec.entry)) return { applicable: true, passed: false, verifier: BROWSER_EVALUATION_ADAPTER_ID, checks: [{ id: 'entry', kind: 'entry', passed: false, code: 'artifact_missing' }], artifacts: [], executionClaim: 'browser_entry_missing' };
      const temporary = await mkdtemp(join(tmpdir(), 'rna-eval-browser-')), profile = join(temporary, 'profile');
      const localAbort = new AbortController(), combined = signal ? AbortSignal.any([signal, localAbort.signal]) : localAbort.signal;
      const brokerSockets = new Set();
      let ORIGIN, browser, cdp, broker, browserError, childClosed = false, screenshot, screenshotBytes; const startedAt = Date.now();
      const checks = [], runtimeErrors = [], consoleErrors = [], networkAttempts = [], resourceErrors = []; let omittedReceipts = 0, contextId;
      const record = (list, item) => { if (list.length < MAX_RECEIPTS) list.push(item); else omittedReceipts++; };
      const overall = setTimeout(() => localAbort.abort(failure('Browser evaluation exceeded its time limit', 'environment_timeout')), 30000);
      try {
        // A non-forwarding broker makes the synthetic origin real to Chromium
        // without exposing the user's web server, credentials or filesystem.
        // It rejects CONNECT/upgrades and all origins except the frozen fixture.
        broker = createServer((request, response) => {
          let url, path; try { url = new URL(request.url, ORIGIN); path = decodeURIComponent(url.pathname).slice(1); } catch {}
          const allowed = url?.origin === ORIGIN && ['GET', 'HEAD'].includes(request.method) && safePath(path), file = allowed ? files.get(path) : null;
          if (!allowed) { response.writeHead(403, { 'Content-Type': 'text/plain', Connection: 'close' }); response.end('Blocked'); return; }
          response.writeHead(file ? 200 : 404, { 'Content-Type': file?.contentType ?? 'text/plain', 'Cache-Control': 'no-store', 'Content-Security-Policy': "sandbox allow-scripts allow-same-origin; default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'" });
          response.end(request.method === 'HEAD' ? undefined : file?.bytes ?? 'Not found');
        });
        broker.on('connection', socket => { brokerSockets.add(socket); socket.on('error', () => {}); socket.once('close', () => brokerSockets.delete(socket)); });
        broker.on('connect', (request, socket) => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
        broker.on('upgrade', (request, socket) => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
        await new Promise((resolve, reject) => { broker.once('error', reject); broker.listen(0, '127.0.0.1', resolve); });
        ORIGIN = 'http://127.0.0.1:' + broker.address().port;
        // macOS Chromium network helpers require the OS HOME/TMPDIR. Keep only
        // these runtime variables; do not inherit API keys/proxies/Node hooks.
        // Personal browser state remains excluded by the fresh user-data-dir.
        const env = { PATH: '/usr/bin:/bin:' + dirname(binary), HOME: process.env.HOME, TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
        browser = spawn(binary, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-breakpad', '--disable-default-apps', '--disable-client-side-phishing-detection', '--disable-domain-reliability', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-features=MediaRouter', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--proxy-server=http://127.0.0.1:' + broker.address().port, '--proxy-bypass-list=127.0.0.1:' + broker.address().port + ';<-loopback>', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { cwd: temporary, env, stdio: 'ignore' });
        browser.once('error', error => { browserError = error; }); browser.once('close', () => { childClosed = true; });
        const portFile = join(profile, 'DevToolsActivePort'); let port;
        while (!port && Date.now() - startedAt < startupTimeoutMs) {
          combined.throwIfAborted(); if (browserError || childClosed) throw failure('Browser could not start; evaluation was not scored');
          try { const value = (await readFile(portFile, 'utf8')).split('\n')[0]; if (/^\d+$/.test(value)) port = Number(value); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (!port) await delay(30, undefined, { signal: combined });
        }
        if (!port) throw failure('Browser startup timed out; evaluation was not scored');
        const tabs = await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: combined })).json(), target = tabs.find(tab => tab.type === 'page');
        if (!target || !target.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:' + port + '/')) throw failure('Browser debugging target is unavailable');
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { const abort = () => { socket.close(); reject(combined.reason); }; combined.addEventListener('abort', abort, { once: true }); socket.addEventListener('open', () => { combined.removeEventListener('abort', abort); resolve(); }, { once: true }); socket.addEventListener('error', () => { combined.removeEventListener('abort', abort); reject(failure('Browser protocol connection failed')); }, { once: true }); });
        cdp = new Cdp(socket, (event, client) => {
          if (event.method === 'Runtime.bindingCalled' && event.params.name === '__rnaEvaluationPolicy') { try { const policy = JSON.parse(event.params.payload); record(networkAttempts, { url: String(policy.url).slice(0, 1000), directive: String(policy.directive).slice(0, 100), blocked: true }); } catch {} }
          else if (event.method === 'Runtime.exceptionThrown') record(runtimeErrors, { text: (event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text).slice(0, 2000) });
          else if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') record(consoleErrors, { text: event.params.args.map(arg => arg.value ?? arg.description ?? '').join(' ').slice(0, 2000) });
          else if (event.method === 'Page.javascriptDialogOpening') void client.call('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
          else if (event.method === 'Fetch.requestPaused') {
            const { request, requestId } = event.params; let url, path; try { url = new URL(request.url); path = decodeURIComponent(url.pathname).replace(/^\//, ''); } catch {}
            const allowed = url?.origin === ORIGIN && ['GET', 'HEAD'].includes(request.method) && safePath(path), file = allowed ? files.get(path) : null;
            if (!allowed) { record(networkAttempts, { url: String(request.url).slice(0, 1000), method: request.method, resourceType: event.params.resourceType, blocked: true }); void client.call('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {}); return; }
            if (!file && path !== 'favicon.ico') record(resourceErrors, { path, code: 'resource_missing' });
            const headers = [{ name: 'Content-Type', value: file?.contentType ?? 'text/plain' }, { name: 'Cache-Control', value: 'no-store' }, { name: 'X-Content-Type-Options', value: 'nosniff' }, { name: 'Content-Security-Policy', value: "sandbox allow-scripts allow-same-origin; default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'" }, { name: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), payment=()' }];
            void client.call('Fetch.fulfillRequest', { requestId, responseCode: file ? 200 : 404, responseHeaders: headers, body: request.method === 'HEAD' ? '' : (file?.bytes ?? Buffer.from('Not found')).toString('base64') }).catch(() => {});
          }
        }, combined);
        for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await cdp.call(method);
        
        
        await cdp.call('Browser.setDownloadBehavior', { behavior: 'deny' });
        
        await cdp.call('Runtime.addBinding', { name: '__rnaEvaluationPolicy', executionContextName: 'rna-host-evaluation' });
        await cdp.call('Page.addScriptToEvaluateOnNewDocument', { worldName: 'rna-host-evaluation', source: 'document.addEventListener("securitypolicyviolation",e=>__rnaEvaluationPolicy(JSON.stringify({url:e.blockedURI,directive:e.violatedDirective})))' });
        await cdp.call('Network.setBypassServiceWorker', { bypass: true });
        await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
        await cdp.call('Emulation.setDeviceMetricsOverride', { ...spec.viewport, deviceScaleFactor: 1, mobile: false });
        const navigated = await cdp.call('Page.navigate', { url: ORIGIN + '/' + spec.entry.split('/').map(encodeURIComponent).join('/') });
        if (navigated.errorText) throw failure('Browser fixture navigation failed: ' + navigated.errorText);
        const evaluate = async expression => { const result = await cdp.call('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: false }); if (result.exceptionDetails) throw failure('Browser selector or operation was invalid', 'evaluation_assertion_invalid'); return result.result.value; };
        // Isolated-world DOM wrappers prevent page monkeypatches of host probes.
        for (let count = 0; count < 100; count++) { combined.throwIfAborted(); const tree = await cdp.call('Page.getFrameTree'); if (tree.frameTree.frame.url.startsWith(ORIGIN)) { contextId = (await cdp.call('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'rna-host-evaluation', grantUniveralAccess: false })).executionContextId; if (await evaluate("document.readyState !== 'loading'")) break; } if (count === 99) throw failure('Browser fixture did not become ready'); await delay(30, undefined, { signal: combined }); }
        await delay(spec.settleMs ?? 50, undefined, { signal: combined });
        const inspect = async selector => { const tree = await cdp.call('Page.getFrameTree'); if (new URL(tree.frameTree.frame.url).origin !== ORIGIN) return { count: 0, visible: false, text: null }; contextId = (await cdp.call('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'rna-host-evaluation', grantUniveralAccess: false })).executionContextId; return evaluate('(()=>{const nodes=[...document.querySelectorAll(' + JSON.stringify(selector) + ')],n=nodes[0];if(!n)return {count:0,visible:false,text:null};const r=n.getBoundingClientRect(),s=getComputedStyle(n),x=Math.max(0,Math.min(innerWidth-1,r.x+r.width/2)),y=Math.max(0,Math.min(innerHeight-1,r.y+r.height/2)),hit=document.elementFromPoint(x,y);return {count:nodes.length,visible:n.checkVisibility({opacityProperty:true,visibilityProperty:true})&&r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none"&&Number(s.opacity)>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth,text:n.textContent.slice(0,4001),x,y,actionable:!!hit&&(n===hit||n.contains(hit))&&!n.disabled,input:n instanceof HTMLInputElement||n instanceof HTMLTextAreaElement};})()'); };
        for (const step of spec.steps) {
          combined.throwIfAborted(); let state, passed = false, code = 'assertion_mismatch'; const beginning = Date.now();
          do {
            state = await inspect(step.selector);
            passed = step.kind === 'assert_count' ? state.count === step.expected : step.kind === 'assert_text' ? state.count === 1 && state.text === step.expected : state.count === 1 && state.visible;
            if (passed || Date.now() - beginning >= 1500) break;
            await delay(50, undefined, { signal: combined });
          } while (true);
          if (step.kind === 'click' || step.kind === 'input') {
            passed &&= state.actionable && (step.kind !== 'input' || state.input); code = passed ? 'interaction_completed' : 'element_not_actionable';
            if (passed) {
              for (const type of ['mousePressed', 'mouseReleased']) await cdp.call('Input.dispatchMouseEvent', { type, x: state.x, y: state.y, button: 'left', clickCount: 1 });
              if (step.kind === 'input') {
                await evaluate('(()=>{const n=document.querySelector(' + JSON.stringify(step.selector) + ');n.focus();n.select();})()');
                await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
                await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
                if (step.value) await cdp.call('Input.insertText', { text: step.value });
              }
              await delay(spec.settleMs ?? 50, undefined, { signal: combined });
            }
          } else if (passed) code = 'assertion_matches';
          checks.push({ id: step.id, kind: step.kind, selector: step.selector, passed, code, observed: { count: state.count, visible: state.visible, ...(step.kind === 'assert_text' ? { text: state.text } : {}) } });
          if (!passed && ['click', 'input'].includes(step.kind)) break;
        }
        if (spec.screenshot !== false) {
          const capture = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }), bytes = Buffer.from(capture.data, 'base64');
          if (bytes.length > MAX_BYTES) throw failure('Browser screenshot exceeded its receipt limit', 'environment_receipt_limit');
          screenshotBytes = bytes;
          screenshot = { mimeType: 'image/png', hash: sha(bytes), bytes: bytes.length, ...spec.viewport, retained: false };
          if (artifactDirectory) {
            const canonicalWorkspace = await realpath(workspace);
            const artifactRoot = join(artifactDirectory, artifactKey); await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
            const directoryInfo = await lstat(artifactRoot), canonicalArtifacts = await realpath(artifactRoot), part = relative(canonicalWorkspace, canonicalArtifacts);
            if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory() || !part || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part))) throw failure('Browser receipts must be outside the execution workspace', 'evaluation_artifact_directory_invalid');
            const artifactPath = join(canonicalArtifacts, screenshot.hash + '.png');
            try { await writeFile(artifactPath, bytes, { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; const existing = await lstat(artifactPath); if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.size > MAX_BYTES || sha(await readFile(artifactPath)) !== screenshot.hash) throw failure('Existing browser receipt does not match', 'evaluation_artifact_directory_invalid'); }
            screenshot = { ...screenshot, retained: true, path: artifactPath };
          }
        }
        combined.throwIfAborted(); const version = await cdp.call('Browser.getVersion');
        if (!version.product.includes(identity.version.match(/\d+\.\d+\.\d+(?:\.\d+)?/)[0])) throw failure('Running browser differs from the frozen environment', 'environment_changed');
        const receipt = { applicable: true, passed: checks.length === spec.steps.length && checks.every(check => check.passed) && runtimeErrors.length === 0 && resourceErrors.length === 0 && networkAttempts.length === 0, verifier: BROWSER_EVALUATION_ADAPTER_ID, executionClaim: 'local_static_browser_interactions_only', checks, runtimeErrors, consoleErrors, networkAttempts, resourceErrors, omittedReceipts, ...(screenshot ? { screenshot } : {}), browser: { product: version.product, protocolVersion: version.protocolVersion }, viewport: spec.viewport, durationMs: Date.now() - startedAt, artifacts: [...files].map(([path, file]) => ({ path, hash: file.hash, bytes: file.bytes.length })), isolation: { freshProfile: true, externalNetwork: 'blocked_by_browser_policies_and_request_interception', workspace: 'in_memory_static_snapshot', osSandbox: 'not_claimed', networkBoundary: 'not_an_os_firewall' } };
        if (screenshotBytes) retainEvaluationScreenshot(receipt, screenshotBytes);
        return receipt;
      } catch (error) { if (signal?.aborted) throw signal.reason; if (combined.aborted) throw combined.reason; throw error; }
      finally {
        clearTimeout(overall); cdp?.close();
        if (browser && !childClosed) { browser.kill('SIGTERM'); await Promise.race([new Promise(resolve => browser.once('close', resolve)), delay(1000)]); if (!childClosed) { browser.kill('SIGKILL'); await Promise.race([new Promise(resolve => browser.once('close', resolve)), delay(1000)]); } }
        if (broker) { for (const socket of brokerSockets) socket.destroy(); broker.closeAllConnections(); await new Promise(resolve => broker.close(resolve)); }
        // Chromium's profile writers can finish after the browser parent's
        // close event. Retry only transient filesystem cleanup failures in
        // this private directory; never repeat page actions or an evaluation.
        await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  };
}
