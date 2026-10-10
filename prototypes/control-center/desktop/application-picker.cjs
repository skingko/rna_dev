const { isAbsolute } = require('node:path');
const CHANNEL = 'rna:choose-application-source';
// The dialog and its refusals follow the interface language (`language`: a function or a value, read when the picker opens).
const TEXT = {
  zh: { title: '选择 Rna Agent 应用或运行时目录', button: '检查此目录', notOwned: '只有当前应用窗口可以选择更新目录。', changed: '应用窗口已经变化，请重新选择。', invalid: '更新目录无效。' },
  en: { title: 'Choose a Rna Agent App or Runtime Folder', button: 'Check This Folder', notOwned: 'Only the current app window can choose an update folder.', changed: 'The app window changed; choose again.', invalid: 'The update folder is not valid.' }
};

/** Native selection grants only a source path; the daemon independently verifies its contents. */
function installApplicationPicker({ ipcMain, dialog, window, origin, language = 'zh' }) {
  let pending;
  const text = () => TEXT[(typeof language === 'function' ? language() : language) === 'en' ? 'en' : 'zh'];
  const owned = event => {
    if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
    try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
  };
  ipcMain.handle(CHANNEL, event => {
    const words = text();
    if (!owned(event)) throw new Error(words.notOwned);
    if (pending) return pending;
    pending = dialog.showOpenDialog(window, { title: words.title, buttonLabel: words.button, properties: ['openFile', 'openDirectory'] })
      .then(({ canceled, filePaths }) => {
        if (!owned(event)) throw new Error(words.changed);
        if (canceled) return null;
        const path = filePaths?.[0];
        if (typeof path !== 'string' || !isAbsolute(path) || path.length > 8192 || /[\u0000-\u001f\u007f-\u009f]/.test(path)) throw new Error(words.invalid);
        return path;
      }).finally(() => { pending = null; });
    return pending;
  });
  return () => ipcMain.removeHandler(CHANNEL);
}
module.exports = { installApplicationPicker, CHANNEL };
