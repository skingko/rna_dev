import { access, lstat, realpath, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, resolve, relative, sep, dirname, basename } from 'node:path';

export const BROWSER_PRESET_ID = 'playwright-browser';
export const PLAYWRIGHT_MCP_VERSION = '0.0.82';
const names = ['browser_close', 'browser_resize', 'browser_console_messages', 'browser_handle_dialog', 'browser_fill_form', 'browser_press_key', 'browser_type', 'browser_navigate', 'browser_navigate_back', 'browser_network_requests', 'browser_take_screenshot', 'browser_snapshot', 'browser_click', 'browser_hover', 'browser_select_option', 'browser_tabs', 'browser_wait_for'];
// Observation tools only read the isolated, temporary browser context: repeating one has no effect,
// so a failed or interrupted call is an ordinary error, never an outcome the user must confirm.
const observations = new Set(['browser_console_messages', 'browser_network_requests', 'browser_snapshot', 'browser_take_screenshot', 'browser_wait_for']);
export const browserToolGrants = () => Object.fromEntries(names.map(name => [name, { permission: 'exec', idempotent: observations.has(name) }]));
/** Tool rules are part of the preset, not a user setting: an install made before a rule change gets the
 * current rules for the tools it grants (the granted set itself is kept). */
export function currentBrowserGrants(allowTools) {
  const grants = browserToolGrants();
  return Object.fromEntries(Object.keys(allowTools ?? {}).filter(name => grants[name]).map(name => [name, grants[name]]));
}
const fail = (message, code = 'browser_preset_invalid') => { throw Object.assign(new Error(message), { status: 400, code, outcome: 'not-published' }); };

export function browserPresets() {
  return [{ id: BROWSER_PRESET_ID, kind: 'mcp', name: '浏览器与网页验证', package: `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`,
    description: '官方 Playwright MCP：独立浏览器会话、导航、页面结构、交互、截图和错误检查。无需 API 密钥；需要已安装 Chrome/Chromium 和项目命令执行权限。不会连接个人浏览器或登录资料。',
    source: { type: 'preset', preset: BROWSER_PRESET_ID }, permission: 'exec', installable: true,
    isolation: 'per-session isolated browser context; not an OS or network sandbox',
    tools: [...names], excludedTools: ['browser_file_upload', 'browser_evaluate', 'browser_run_code_unsafe'],
    example: { kind: 'mcp', source: { type: 'preset', preset: BROWSER_PRESET_ID }, activate: true } }];
}

export async function findBrowserExecutable(explicit, { platform = process.platform, env = process.env } = {}) {
  if (explicit !== undefined && (typeof explicit !== 'string' || !isAbsolute(explicit) || /[\0\r\n]/.test(explicit))) fail('浏览器路径必须为现有可执行文件的绝对路径。');
  const candidates = explicit ? [explicit] : platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ] : platform === 'win32' ? [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean).map(path => join(path, 'Google/Chrome/Application/chrome.exe'))
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  for (const candidate of candidates) {
    try { const canonical = await realpath(candidate); await access(canonical, constants.X_OK); if ((await lstat(canonical)).isFile()) return canonical; }
    catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error; }
  }
  fail('未找到 Chrome/Chromium。请安装浏览器，或在 source.executablePath 指定已安装浏览器；本预设不会隐式下载或接管个人浏览器。', 'browser_unavailable');
}

export async function resolveBrowserPreset(input) {
  if (input?.source?.type !== 'preset') return { input };
  if (input.kind !== 'mcp' || input.source.preset !== BROWSER_PRESET_ID || Object.keys(input.source).some(key => !['type', 'preset', 'executablePath'].includes(key))) fail('未知浏览器预设或配置字段。');
  if (input.allowTools !== undefined || input.toolPermission !== undefined) fail('浏览器预设使用固定最小工具集和 exec 权限；不接受覆盖其工具权限。');
  const executablePath = await findBrowserExecutable(input.source.executablePath);
  return { browser: { preset: BROWSER_PRESET_ID, schemaVersion: 1, packageVersion: PLAYWRIGHT_MCP_VERSION, executablePath },
    input: { ...input, id: input.id ?? BROWSER_PRESET_ID, name: input.name ?? '浏览器与网页验证', description: input.description ?? browserPresets()[0].description,
      source: { type: 'npm', package: `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`, args: browserArguments(executablePath) }, allowTools: browserToolGrants() } };
}

export function browserArguments(executablePath, outputDir) {
  return ['--headless', '--isolated', '--executable-path', executablePath, '--image-responses', 'allow', '--no-webmcp', '--block-service-workers', '--codegen', 'none', '--timeout-action', '10000', '--timeout-navigation', '30000', '--idle-timeout', '0', '--viewport-size', '1280x900', ...(outputDir ? ['--output-dir', outputDir, '--output-max-size', String(32 * 1024 * 1024)] : [])];
}

export function normalizeBrowserMetadata(input) {
  const value = input.browser;
  if (!value) return undefined;
  if (value.preset !== BROWSER_PRESET_ID || value.schemaVersion !== 1 || value.packageVersion !== PLAYWRIGHT_MCP_VERSION || typeof value.executablePath !== 'string' || !isAbsolute(value.executablePath)) fail('浏览器预设身份无效。');
  if (input.transport !== 'stdio') fail('浏览器预设必须使用本机受管 stdio 进程。');
  for (const [name, rule] of Object.entries(input.allowTools ?? {})) if (!names.includes(name) || rule.permission !== 'exec' || rule.idempotent === true && !observations.has(name)) fail('浏览器工具必须保留已验证工具集和 exec 权限；只有观察类工具可以声明幂等。');
  return { preset: value.preset, schemaVersion: 1, packageVersion: PLAYWRIGHT_MCP_VERSION, executablePath: value.executablePath };
}

/** Outputs stay beneath the host-owned session root, never the project cwd. */
export async function browserSessionManifest(manifest, stateDir, { storageRoot = dirname(stateDir) } = {}) {
  const browser = normalizeBrowserMetadata(manifest);
  if (!browser || !Array.isArray(manifest.args) || typeof manifest.args[0] !== 'string' || !isAbsolute(manifest.args[0])) fail('浏览器安装入口无效。');
  const root = resolve(storageRoot), base = resolve(stateDir), outputDir = join(base, 'browser', manifest.id), ownedPart = relative(root, outputDir);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(manifest.id)) fail('浏览器能力 ID 无效。');
  if (!ownedPart || ownedPart === '..' || ownedPart.startsWith(`..${sep}`) || isAbsolute(ownedPart)) fail('浏览器输出目录不安全。', 'browser_storage_unsafe');
  // Canonicalize the trusted state-file parent (including macOS /var alias),
  // then reject links at every app-owned descendant.
  let path = await realpath(dirname(root));
  for (const segment of [basename(root), ...ownedPart.split(sep)]) {
    path = join(path, segment);
    try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(path); if (info.isSymbolicLink() || !info.isDirectory()) fail('浏览器输出目录不安全。', 'browser_storage_unsafe');
  }
  const canonicalBase = await realpath(base), canonical = await realpath(outputDir), part = relative(canonicalBase, canonical);
  if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) fail('浏览器输出目录不安全。', 'browser_storage_unsafe');
  return { ...manifest, command: process.execPath, args: [manifest.args[0], ...browserArguments(browser.executablePath, canonical)], cwd: canonical, env: {}, timeoutMs: 45000 };
}
