// Built-in browser (side panel <webview>). The workbench may embed web pages, never
// give them Node, preloads, popups as windows, or the app's session. Only http(s)
// and about:blank load in a guest; popups become a browser tab in the workbench.
const PARTITION = 'persist:rna-browser';
const OPEN_URL = 'rna:browser-open-url', OPEN_EXTERNAL = 'rna:browser-open-external', OPEN_DEVTOOLS = 'rna:browser-open-devtools';
const GUEST_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

function httpUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
const guestUrl = value => value === 'about:blank' ? value : httpUrl(value);

/** will-attach-webview: strip everything a page could use to escape; false = refuse. */
function hardenWebview(webPreferences, params) {
  for (const key of ['preload', 'preloadURL', 'enableBlinkFeatures', 'additionalArguments']) delete webPreferences[key];
  Object.assign(webPreferences, { nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false, webviewTag: false, partition: PARTITION });
  for (const key of ['preload', 'nodeintegration', 'nodeintegrationinsubframes', 'disablewebsecurity', 'webpreferences', 'enableblinkfeatures', 'disableblinkfeatures', 'plugins']) delete params[key];
  // Popups must reach setWindowOpenHandler (which always denies a native window).
  params.partition = PARTITION; params.allowpopups = 'true';
  return guestUrl(params.src || 'about:blank') !== null;
}

/** Per window: harden every guest and route its popups back to the workbench. */
function installBrowserWebviews({ window, session, logger = console }) {
  const contents = window.webContents;
  const guestSession = session?.fromPartition?.(PARTITION);
  guestSession?.setPermissionRequestHandler((_contents, permission, callback) => callback(GUEST_PERMISSIONS.has(permission)));
  guestSession?.setPermissionCheckHandler?.((_contents, permission) => GUEST_PERMISSIONS.has(permission));
  const attach = (event, webPreferences, params) => { if (!hardenWebview(webPreferences, params)) { logger.warn?.('[browser] blocked webview source'); event.preventDefault(); } };
  const attached = (_event, guest) => {
    guest.setWindowOpenHandler(({ url, disposition }) => {
      const safe = httpUrl(url);
      if (safe && !window.isDestroyed()) contents.send(OPEN_URL, { url: safe, disposition: typeof disposition === 'string' ? disposition : 'new-window', sourceWebContentsId: guest.id });
      return { action: 'deny' };
    });
    const guard = (event, url) => { if (!guestUrl(url)) event.preventDefault(); };
    guest.on('will-navigate', guard); guest.on('will-redirect', guard);
    guest.on('will-attach-webview', event => event.preventDefault());
  };
  contents.on('will-attach-webview', attach); contents.on('did-attach-webview', attached);
  return () => { contents.removeListener('will-attach-webview', attach); contents.removeListener('did-attach-webview', attached); };
}

// The bridge's refusals reach the page as the call's error, in the interface language (`language`: a function or a value).
const BRIDGE_TEXT = {
  zh: { externalOwner: '只有当前应用窗口可以打开外部链接。', externalUrl: '只能在默认浏览器中打开 http/https 地址。', devtoolsOwner: '只有当前应用窗口可以打开调试工具。', devtoolsGuest: '只能调试内置浏览器中的页面。' },
  en: { externalOwner: 'Only the current app window can open outside links.', externalUrl: 'Only web addresses (http or https) can open in the default browser.', devtoolsOwner: 'Only the current app window can open the developer tools.', devtoolsGuest: 'Only pages in the built-in browser can be inspected.' }
};

/** IPC for window.rnaDesktop.browser, callable only from the workbench main frame. */
function installBrowserBridge({ ipcMain, shell, window, origin, webContents, language = 'zh' }) {
  const text = () => BRIDGE_TEXT[(typeof language === 'function' ? language() : language) === 'en' ? 'en' : 'zh'];
  const owned = event => {
    if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
    try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
  };
  ipcMain.removeHandler(OPEN_EXTERNAL); ipcMain.removeHandler(OPEN_DEVTOOLS);
  ipcMain.handle(OPEN_EXTERNAL, async (event, url) => {
    if (!owned(event)) throw new Error(text().externalOwner);
    const safe = httpUrl(url); if (!safe) throw new Error(text().externalUrl);
    await shell.openExternal(safe); return { opened: true };
  });
  ipcMain.handle(OPEN_DEVTOOLS, (event, id) => {
    if (!owned(event)) throw new Error(text().devtoolsOwner);
    const guest = Number.isSafeInteger(id) ? webContents.fromId(id) : null;
    if (!guest || guest.isDestroyed() || guest.getType() !== 'webview' || guest.hostWebContents !== window.webContents) throw new Error(text().devtoolsGuest);
    guest.openDevTools({ mode: 'detach' }); return { opened: true };
  });
  return () => { ipcMain.removeHandler(OPEN_EXTERNAL); ipcMain.removeHandler(OPEN_DEVTOOLS); };
}

module.exports = { PARTITION, OPEN_URL, OPEN_EXTERNAL, OPEN_DEVTOOLS, httpUrl, guestUrl, hardenWebview, installBrowserWebviews, installBrowserBridge };
