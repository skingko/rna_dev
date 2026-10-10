const { basename, dirname, isAbsolute, join, resolve, sep } = require('node:path');
const fs = require('node:fs/promises');
const CHANNEL = 'rna:reveal-path';
// The refusals reach the page as the call's error, in the interface language (`language`: a function or a value).
const TEXT = {
  zh: { notOwned: '只有当前应用窗口可以在访达中显示文件。', input: '要显示的路径无效。', unknown: '无法核对项目目录，请稍后重试。', outside: '只能显示项目目录里的文件。', missing: '这个文件已经不在了。', changed: '应用窗口已经变化，未在访达中显示。' },
  en: { notOwned: 'Only the current app window can show files in Finder.', input: 'The path to show is not valid.', unknown: 'Could not check the project folders; try again shortly.', outside: 'Only files inside a project folder can be shown.', missing: 'This file is no longer there.', changed: 'The app window changed, so nothing was shown in Finder.' }
};
const within = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * The folder holding `target`, through symlinks: { real } when it resolves, or { missing } when it does not, judged by
 * the nearest ancestor (inside a workspace) that does resolve — `missing: 'inside'` only when that ancestor's real path
 * lies in a workspace. So a missing file in a project is reported as missing, while a path through a link that leads
 * out of the project is refused alike whether or not anything exists where it leads (no existence oracle).
 */
async function realFolder(files, target, roots) {
  const folder = dirname(target);
  try { return { real: await files.realpath(folder) }; } catch { /* judged by an ancestor below */ }
  for (let at = dirname(folder); at !== dirname(at) && roots.some(root => within(at, root)); at = dirname(at)) {
    let real;
    try { real = await files.realpath(at); } catch { continue; }
    return { missing: roots.some(root => within(real, root)) ? 'inside' : 'outside' };
  }
  return { missing: 'inside' };
}

/**
 * 在访达中显示 (`rnaDesktop.revealPath(absPath)`): selects an existing file or folder in Finder, only inside a project
 * workspace the service has registered. The workspaces are asked of the service by this process on every call, never
 * taken from the page, so a page cannot widen the list; a project added since is found, a removed one is not. They come
 * from the v2 index (GET /api/v2/bootstrap: every project's row, archived ones included, carries `workspacePath`), not
 * from the legacy /api/projects, which sent every project's whole record (17 MB on a long-used install).
 * Paths outside every workspace are refused before the disk is touched (no existence oracle), and the folder holding
 * the target is resolved through symlinks before the check, so a link inside a project cannot lead Finder outside it,
 * nor tell the page what exists where it leads.
 */
function installRevealPath({ ipcMain, shell, window, origin, fetch: request = globalThis.fetch, files = fs, language = 'zh' }) {
  const text = () => TEXT[(typeof language === 'function' ? language() : language) === 'en' ? 'en' : 'zh'];
  const owned = event => {
    if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
    try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
  };
  ipcMain.removeHandler(CHANNEL);
  ipcMain.handle(CHANNEL, async (event, input) => {
    const words = text();
    if (!owned(event)) throw new Error(words.notOwned);
    if (typeof input !== 'string' || !isAbsolute(input) || input.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/.test(input)) throw new Error(words.input);
    const target = resolve(input);
    let registered;
    try {
      const response = await request(`${origin}/api/v2/bootstrap`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('unavailable');
      const projects = (await response.json())?.projects;
      if (!Array.isArray(projects)) throw new Error('unexpected');
      registered = projects.map(project => project?.workspacePath).filter(path => typeof path === 'string' && isAbsolute(path) && !path.includes('\0')).map(path => resolve(path));
    } catch { throw new Error(words.unknown); }
    const roots = [...new Set([...registered, ...(await Promise.all(registered.map(path => files.realpath(path).catch(() => null)))).filter(Boolean)])];
    if (!roots.some(root => within(target, root))) throw new Error(words.outside);
    // The folder is resolved and checked before the target itself is looked at: past a link that leads out of the
    // project the answer is the same refusal whether or not anything is there.
    const folder = await realFolder(files, target, roots);
    if (folder.missing) throw new Error(folder.missing === 'inside' ? words.missing : words.outside);
    const real = join(folder.real, basename(target));
    if (!roots.some(root => within(real, root))) throw new Error(words.outside);
    try { await files.lstat(real); } catch { throw new Error(words.missing); }
    if (!owned(event)) throw new Error(words.changed);
    shell.showItemInFolder(real);
    return { revealed: true };
  });
  return () => ipcMain.removeHandler(CHANNEL);
}

module.exports = { installRevealPath, CHANNEL };
