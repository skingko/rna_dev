import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// UX audit 2026-10-03 (texts, F80): the desktop's startup page, startup and quit dialogs, native pickers and the
// refusals its bridges return follow the interface language main.cjs knows, read when each message is produced.
const require = createRequire(import.meta.url);
const { installApplicationPicker } = require('../desktop/application-picker.cjs');
const { installPreviewLauncher } = require('../desktop/preview-launcher.cjs');
const { installBrowserBridge } = require('../desktop/browser-webview.cjs');
const { installNotifications } = require('../desktop/notifications.cjs');
const { DesktopRuntime } = require('../desktop/runtime.cjs');
const { resolveManagedRuntime, assertManagedHealth } = require('../desktop/managed-runtime.cjs');
const { stopOwnedSupervisor } = require('../desktop/ownership.cjs');
const origin = 'http://127.0.0.1:4317';

function bridge() {
  const frame = { url: `${origin}/` }, window = { isDestroyed: () => false, webContents: { mainFrame: frame } }, handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel) };
  return { window, ipcMain, handlers, owned: { sender: window.webContents, senderFrame: frame }, foreign: { sender: {}, senderFrame: frame } };
}

test('the update picker opens with its title and button in the interface language; its refusals follow it', async () => {
  const f = bridge(), dialogs = []; let language = 'zh';
  installApplicationPicker({ ...f, origin, language: () => language, dialog: { showOpenDialog: async (_window, options) => { dialogs.push([options.title, options.buttonLabel]); return { canceled: false, filePaths: ['relative'] }; } } });
  const pick = f.handlers.get('rna:choose-application-source');
  await assert.rejects(pick(f.owned), /^Error: 更新目录无效。$/);
  language = 'en';
  await assert.rejects(pick(f.owned), /^Error: The update folder is not valid\.$/);
  assert.throws(() => pick(f.foreign), /^Error: Only the current app window can choose an update folder\.$/);
  assert.deepEqual(dialogs, [['选择 Rna Agent 应用或运行时目录', '检查此目录'], ['Choose a Rna Agent App or Runtime Folder', 'Check This Folder']]);
});

test('preview and built-in browser refusals reach the page in the interface language', async () => {
  const f = bridge();
  installPreviewLauncher({ ...f, origin, language: () => 'en', shell: { openExternal: async () => {} }, fetch: async () => { throw new Error('offline'); } });
  const open = f.handlers.get('rna:open-preview');
  assert.throws(() => open(f.foreign, {}), /^Error: Only the current app window can open a project preview\.$/);
  assert.throws(() => open(f.owned, { projectId: 'p', url: 'file:///x' }), /^Error: Only the current project's local preview can be opened\.$/);
  await assert.rejects(open(f.owned, { projectId: 'p', url: 'http://127.0.0.1:4321/' }), /^Error: Could not check the preview; start it again from the Files page\.$/);
  installBrowserBridge({ ...f, origin, language: 'en', shell: { openExternal: async () => {} }, webContents: { fromId: () => null } });
  await assert.rejects(f.handlers.get('rna:browser-open-external')(f.owned, 'file:///etc/hosts'), /^Error: Only web addresses \(http or https\) can open in the default browser\.$/);
  assert.throws(() => f.handlers.get('rna:browser-open-devtools')(f.owned, 7), /^Error: Only pages in the built-in browser can be inspected\.$/);
  // Chinese stays the default for callers that pass no language.
  const zh = bridge(); installBrowserBridge({ ...zh, origin, shell: {}, webContents: { fromId: () => null } });
  assert.throws(() => zh.handlers.get('rna:browser-open-devtools')(zh.owned, 7), /只能调试内置浏览器中的页面/);
});

test('the startup page and the startup and quit dialogs speak the interface language', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'rna-desktop-language-')); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const host = join(temp, 'host'), dataDir = join(temp, 'private'); mkdirSync(host); writeFileSync(join(host, 'server.mjs'), ''); writeFileSync(join(temp, 'node'), '');
  const paths = { host, node: join(temp, 'node'), bin: join(temp, 'bin'), cli: join(temp, 'rna') };
  let language = 'en', clock = 0; const statuses = [];
  const runtime = new DesktopRuntime({ paths, dataDir, env: { RNA_DESKTOP_ISOLATED: '1' }, language: () => language, maintenanceWaitMs: 1000, now: () => clock, wait: async ms => { clock += ms; }, onStatus: message => statuses.push(message),
    verifyConnection: async () => null, run: () => assert.fail('held maintenance must not start') });
  mkdirSync(join(dataDir, 'state.json.service'), { recursive: true }); writeFileSync(join(dataDir, 'state.json.service', 'maintenance.json'), JSON.stringify({ schemaVersion: 1, held: true }));
  await assert.rejects(runtime.start(), /^Error: Maintenance has not brought the service back yet; your records and work are kept\./);
  assert.equal(statuses[0], 'The app is under maintenance; waiting for the local service to reconnect…');
  language = 'zh'; writeFileSync(join(dataDir, 'state.json.service', 'config.json'), JSON.stringify({ stateFile: '/foreign/state.json', port: 45000 }));
  await assert.rejects(runtime.start(), /^Error: 应用数据目录中的服务配置不匹配/, 'the language is read again for each message');
  // The managed-runtime and quit refusals take the language the runtime passes; the CLI keeps Chinese.
  await assert.rejects(resolveManagedRuntime({ paths, stateFile: '/a/state.json', config: { stateFile: '/b/state.json' }, language: 'en' }), /^Error: The app service state folder does not match\.$/);
  await assert.rejects(resolveManagedRuntime({ paths, stateFile: '/a/state.json', config: { stateFile: '/b/state.json' } }), /应用服务状态目录不匹配/);
  assert.throws(() => assertManagedHealth({ runtimeIdentity: 'x' }, { release: { manifest: {} }, runtimeIdentity: 'y' }, 'en'), /^Error: The running service does not match the verified app version\.$/);
  const stateFile = join(temp, 'quit', 'state.json'); mkdirSync(`${stateFile}.service`, { recursive: true });
  const owner = { pid: 100, birth: 'b', token: 't', supervisorRunId: 'r' }; writeFileSync(`${stateFile}.service/supervisor.lock`, JSON.stringify(owner));
  await assert.rejects(stopOwnedSupervisor({ paths, stateFile, owner, language: 'en', timeoutMs: -1, identities: { processAlive: () => true, processBirth: () => 'b' }, acquire: async () => () => {}, acquireMaintenance: async () => () => {}, writeIntent: () => {}, signal: () => {}, wait: async () => {} }),
    /^Error: The app's background service is still shutting down; try again later\.$/);
});

test('the notifications stream feeds the language watcher even where native notifications are unsupported', async () => {
  const seen = []; let calls = 0;
  const frames = text => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
  const request = async (_url, options) => { calls++; if (calls > 1) return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))); return new Response(frames('event: hello\ndata: {}\n\nid: 3\nevent: resync\ndata: {"reason":"resume_unavailable"}\n\nid: 4\nevent: notify\ndata: {"projectId":"p"}\n\n'), { status: 200 }); };
  const stop = installNotifications({ Notification: class { static isSupported() { return false; } constructor() { assert.fail('no native notification'); } }, origin, fetch: request, onEvent: event => seen.push(event.event), retryMs: 1, wait: () => Promise.resolve() });
  while (calls < 2) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, ['hello', 'resync', 'notify']);
  await stop();
});
