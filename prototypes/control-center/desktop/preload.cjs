const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rnaDesktop', Object.freeze({ chooseDirectory: () => ipcRenderer.invoke('rna:choose-directory'), openPreview: input => ipcRenderer.invoke('rna:open-preview', input), chooseApplicationSource: () => ipcRenderer.invoke('rna:choose-application-source'),
  // 在访达中显示 for a file or folder inside a project workspace (the main process checks it against the service's projects).
  revealPath: path => ipcRenderer.invoke('rna:reveal-path', path),
  // P3: a clicked proactive-delivery notification ({ projectId, entryId, sessionId }). Returns an unsubscribe.
  onNotificationOpen: callback => { const listener = (_event, target) => callback(target); ipcRenderer.on('rna:notification-open', listener); return () => ipcRenderer.removeListener('rna:notification-open', listener); },
  // Side-panel built-in browser (<webview> is hardened by the main process; see browser-webview.cjs).
  // onOpenUrl receives { url, disposition, sourceWebContentsId } for popups/target=_blank; open it as a new browser tab.
  browser: Object.freeze({ openExternal: url => ipcRenderer.invoke('rna:browser-open-external', url), openDevTools: webContentsId => ipcRenderer.invoke('rna:browser-open-devtools', webContentsId),
    onOpenUrl: callback => { const listener = (_event, target) => callback(target); ipcRenderer.on('rna:browser-open-url', listener); return () => ipcRenderer.removeListener('rna:browser-open-url', listener); },
    partition: 'persist:rna-browser', capabilities: Object.freeze({ webview: true }) }) }));
