const CHANNEL = 'rna:open-preview';
// The refusals reach the page as the call's error, in the interface language (`language`: a function or a value).
const TEXT = {
  zh: { notOwned: '只有当前应用窗口可以打开项目预览。', input: '项目预览参数无效。', address: '项目预览地址无效。', local: '只允许打开当前项目的本机预览服务。', busy: '正在打开另一个预览，请稍后重试。', unknown: '无法确认预览服务状态，请在文件页重新启动预览。', changed: '应用窗口已经变化，未打开预览。', stale: '预览地址已变化或服务已停止，请刷新后重试。' },
  en: { notOwned: 'Only the current app window can open a project preview.', input: 'The project preview request is not valid.', address: 'The project preview address is not valid.', local: 'Only the current project\'s local preview can be opened.', busy: 'Another preview is opening; try again in a moment.', unknown: 'Could not check the preview; start it again from the Files page.', changed: 'The app window changed, so the preview was not opened.', stale: 'The preview address changed or the preview stopped; refresh and try again.' }
};

function installPreviewLauncher({ ipcMain, shell, window, origin, fetch: request = globalThis.fetch, language = 'zh' }) {
  let pending;
  const text = () => TEXT[(typeof language === 'function' ? language() : language) === 'en' ? 'en' : 'zh'];
  const owned = event => {
    if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
    try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
  };
  ipcMain.handle(CHANNEL, (event, input) => {
    const words = text();
    if (!owned(event)) throw new Error(words.notOwned);
    if (!input || typeof input.projectId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(input.projectId) || typeof input.url !== 'string' || input.url.length > 8192) throw new Error(words.input);
    let url;
    try { url = new URL(input.url); } catch { throw new Error(words.address); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.origin === origin || url.username || url.password || url.hash || url.search) throw new Error(words.local);
    const fingerprint = `${input.projectId}\n${input.url}`;
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new Error(words.busy);
      return pending.promise;
    }
    const promise = (async () => {
      let response, preview;
      try {
        response = await request(`${origin}/api/projects/${input.projectId}/preview`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('not ready');
        preview = await response.json();
      } catch { throw new Error(words.unknown); }
      if (!owned(event)) throw new Error(words.changed);
      if (preview?.status !== 'ready' || !['static', 'vite'].includes(preview.kind) || preview.url !== input.url || preview.origin !== url.origin) throw new Error(words.stale);
      await shell.openExternal(input.url);
      return { opened: true };
    })().finally(() => { pending = null; });
    pending = { fingerprint, promise };
    return promise;
  });
  return () => ipcMain.removeHandler(CHANNEL);
}

module.exports = { installPreviewLauncher, CHANNEL };
