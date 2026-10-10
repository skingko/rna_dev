const { app, BrowserWindow, dialog, ipcMain, shell, Menu, clipboard, Notification, session, webContents } = require('electron');
const { join, resolve } = require('node:path');
const { mkdirSync } = require('node:fs');
const { installDirectoryPicker } = require('./directory-picker.cjs');
const { installPreviewLauncher } = require('./preview-launcher.cjs');
const { installApplicationPicker } = require('./application-picker.cjs');
const { installRevealPath } = require('./reveal-path.cjs');
const { installNotifications } = require('./notifications.cjs');
const { installBrowserWebviews, installBrowserBridge } = require('./browser-webview.cjs');
const { DesktopRuntime, runtimePaths } = require('./runtime.cjs');
app.setName('Rna Agent');
const dataDir = process.env.RNA_DESKTOP_DATA ? resolve(process.env.RNA_DESKTOP_DATA) : join(app.getPath('appData'), 'Rna Agent');
mkdirSync(dataDir, { recursive: true, mode: 0o700 }); app.setPath('userData', dataDir);
let window, runtime, origin, startup, quitting = false, stopping = false, stopNotifications = () => {};
const paths = runtimePaths({ packaged: app.isPackaged, appPath: app.getAppPath() });
// The native menu and dialogs follow the interface language picked in the app (settings.interfaceLanguage). Until
// the service answers, the system locale stands in, as the app's own 'system' preference does.
const TEXT = {
  zh: { show: '显示工作台', data: '打开应用数据目录', cli: '复制 CLI 启动命令', quit: '退出 Rna Agent', starting: '正在启动本机工作台…', openFailed: '无法打开工作台', startFailed: 'Rna Agent 启动失败', dataDir: '数据目录：', stopFailed: '后台尚未停止', stopKept: '工作台保留运行，稍后可重新退出。', openProject: '打开项目目录', badPort: 'RNA_AGENT_PORT 无效' },
  en: { show: 'Show Workspace', data: 'Open App Data Folder', cli: 'Copy CLI Launch Command', quit: 'Quit Rna Agent', starting: 'Starting the local workspace…', openFailed: 'Could not open the workspace', startFailed: 'Rna Agent failed to start', dataDir: 'Data folder: ', stopFailed: 'The background service has not stopped', stopKept: 'The workspace keeps running; quit again later.', openProject: 'Open Project Folder', badPort: 'RNA_AGENT_PORT is invalid' },
};
let language = 'zh';
const text = () => TEXT[language];
function setLanguage(value) {
  if (!Object.hasOwn(TEXT, value ?? '') || value === language) return;
  language = value; if (app.isReady()) buildMenu();
}
function buildMenu() {
  const copyCli = () => { if (process.platform === 'win32') { clipboard.writeText(`set "RNA_DESKTOP_DATA=${dataDir}" && "${paths.cli}" chat --workspace "%CD%"`); return; } const quote = value => `'${value.replaceAll("'", "'\\''")}'`; clipboard.writeText(`RNA_DESKTOP_DATA=${quote(dataDir)}${runtime?.port && !app.isPackaged ? ` RNA_AGENT_PORT=${runtime.port} RNA_AGENT_STATE=${quote(runtime.externalStateFile??runtime.stateFile)}` : ''} ${quote(paths.cli)} chat --workspace "$PWD"`); };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Rna Agent', submenu: [{ role: 'about' }, { type: 'separator' }, { label: text().show, click: createWindow }, { label: text().data, click: () => shell.openPath(app.getPath('userData')) }, { label: text().cli, click: copyCli }, { type: 'separator' }, { label: text().quit, accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }
  ]));
}
/** The saved interface language, once the service is up (an older service without it keeps the locale's). */
async function loadLanguage() {
  try { const response = await fetch(`${origin}/api/v2/bootstrap`); if (response.ok) setLanguage((await response.json())?.settings?.interfaceLanguage); } catch { /* keep the current language */ }
}
/**
 * Follows the language on the notifications stream (no second stream is opened; the stream stays open where native
 * notifications are unsupported): a change arrives as an `index` event with `settings`. When events may have been
 * missed (a `resync`, or the stream reconnecting after a drop), the saved language is read again.
 */
let streamConnected = false;
function followSettings(event) {
  if (event.event === 'resync' || event.event === 'hello' && streamConnected) void loadLanguage();
  if (event.event === 'hello') streamConnected = true;
  else if (event.event === 'index' && event.data.includes('"interfaceLanguage"')) { try { setLanguage(JSON.parse(event.data).settings?.interfaceLanguage); } catch { /* not a settings change */ } }
}
function createWindow() {
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
  window = new BrowserWindow({ width: 1500, height: 960, minWidth: 700, minHeight: 550, title: 'Rna Agent', backgroundColor: '#f7f7f4', ...(process.platform === 'linux' ? { icon: join(__dirname, 'icon.png') } : {}), webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: true, preload: join(__dirname, 'preload.cjs') } });
  // Side-panel built-in browser: hardened <webview> guests in their own partition.
  installBrowserWebviews({ window, session });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { try { if (new URL(url).origin !== origin) event.preventDefault(); } catch { event.preventDefault(); } });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('closed', () => { window = null; });
  if (origin) connectWindow();
  else startupStatus(text().starting);
}
function connectWindow() {
  if (!window || window.isDestroyed()) return;
  ipcMain.removeHandler('rna:choose-directory'); ipcMain.removeHandler('rna:open-preview'); ipcMain.removeHandler('rna:choose-application-source');
  const current = () => language;
  installDirectoryPicker({ ipcMain, dialog, window, origin, title: () => text().openProject }); installPreviewLauncher({ ipcMain, shell, window, origin, language: current }); installApplicationPicker({ ipcMain, dialog, window, origin, language: current }); installBrowserBridge({ ipcMain, shell, window, origin, webContents, language: current });
  // 在访达中显示: only inside a project workspace the service has registered (asked of the service on every call).
  installRevealPath({ ipcMain, shell, window, origin, language: current });
  void window.loadURL(origin).catch(error => { if (!quitting) dialog.showErrorBox(text().openFailed, error.message); });
}
function startupStatus(message) {
  if (!window || window.isDestroyed() || origin) return;
  const safe = String(message).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html lang="${language}"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Rna Agent</title><style>body{font:15px system-ui;color:#44516b;background:#f7f7f4;display:grid;place-content:center;height:90vh}h1{font-size:24px}</style><h1>Rna Agent</h1><p>${safe}</p></html>`)}`);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => createWindow());
  app.whenReady().then(async () => {
    language = /^en\b/i.test(app.getLocale()) ? 'en' : 'zh';
    buildMenu();
    createWindow();
    try {
      if (process.env.RNA_DESKTOP_CONNECT === '1') {
        const port = Number(process.env.RNA_AGENT_PORT ?? 4317); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(text().badPort); origin = `http://127.0.0.1:${port}`;
      } else { let lastStatus; runtime = new DesktopRuntime({ paths, dataDir: app.getPath('userData'), language: () => language, onStatus: message => { if (message !== lastStatus) { lastStatus = message; startupStatus(message); } } }); startup = runtime.start(); origin = (await startup).origin; }
      void loadLanguage(); // never holds the window: the menu is rebuilt when it answers
      if (!stopping) connectWindow();
      // Opt-in per project on the service side; clicking opens the window at that project.
      if (!stopping) stopNotifications = installNotifications({ Notification, origin, onEvent: followSettings, onOpen: target => { const existing = Boolean(window && !window.isDestroyed()); createWindow(); if (!window || window.isDestroyed()) return; if (existing) window.webContents.send('rna:notification-open', target); else window.webContents.once('did-finish-load', () => { if (window && !window.isDestroyed()) window.webContents.send('rna:notification-open', target); }); } });
    } catch (error) { dialog.showErrorBox(text().startFailed, `${error.message}\n\n${text().dataDir}${app.getPath('userData')}`); app.quit(); }
  });
  app.on('activate', () => { if (app.isReady()) createWindow(); });
  // macOS: closing the window preserves background work, and the Dock brings the window back; explicit Quit drains the
  // owned service. Windows and Linux have no Dock to come back through, so closing the last window quits.
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    stopNotifications();
    if (quitting || !runtime || !startup) return;
    event.preventDefault(); if (stopping) return; stopping = true;
    void startup.catch(() => {}).then(() => runtime.stop()).then(() => { quitting = true; app.quit(); }, error => { stopping = false; dialog.showErrorBox(text().stopFailed, `${error.message}\n${text().stopKept}`); createWindow(); });
  });
}
