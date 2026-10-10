const CHANNEL = 'rna:choose-directory';

/** `title`: the dialog title in the interface language, read when the dialog opens (a string or a function). */
function installDirectoryPicker({ ipcMain, dialog, window, origin, title = '打开项目目录' }) {
  let pending;
  ipcMain.handle(CHANNEL, event => {
    if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== origin) throw new Error('Directory picker requires the local application main frame');
    if (pending) return pending;
    pending = dialog.showOpenDialog(window, { title: typeof title === 'function' ? title() : title, properties: ['openDirectory', 'createDirectory'] })
      .then(({ canceled, filePaths }) => window.isDestroyed() || canceled ? null : filePaths[0] ?? null)
      .finally(() => { pending = null; });
    return pending;
  });
}
module.exports = { installDirectoryPicker, CHANNEL };
