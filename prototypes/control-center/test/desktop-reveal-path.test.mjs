import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 在访达中显示 (rnaDesktop.revealPath): the main process shows a file in Finder only behind the window/main-frame
// ownership check, and only inside a project workspace the service reports — never a list the page could pass.
const require = createRequire(import.meta.url);
const { installRevealPath, CHANNEL } = require('../desktop/reveal-path.cjs');
const origin = 'http://127.0.0.1:4317';

function fixture(t, { projects, request, language } = {}) {
  // tmpdir() on macOS is itself behind a symlink (/var → /private/var): the registered path is the unresolved one.
  const temp = mkdtempSync(join(tmpdir(), 'rna-reveal-')); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const workspace = join(temp, 'project'), outside = join(temp, 'outside');
  mkdirSync(join(workspace, 'src'), { recursive: true }); mkdirSync(outside);
  writeFileSync(join(workspace, 'src', 'main.ts'), 'x'); writeFileSync(join(outside, 'secret.txt'), 'x');
  symlinkSync(outside, join(workspace, 'link'));
  const frame = { url: `${origin}/` }, window = { isDestroyed: () => false, webContents: { mainFrame: frame } };
  const shown = [], requests = [], touched = [], handlers = new Map();
  const files = { lstat: async path => { touched.push(path); return fs.lstat(path); }, realpath: async path => { touched.push(path); return fs.realpath(path); } };
  const respond = request ?? (async () => ({ ok: true, json: async () => ({ protocol: 3, projects: projects ?? [{ id: 'p1', workspacePath: workspace }, { id: 'old', workspacePath: 42 }], sessions: [] }) }));
  const dispose = installRevealPath({ window, origin, files, language, ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel) },
    shell: { showItemInFolder: path => shown.push(path) }, fetch: async (...args) => { requests.push(args); return respond(...args); } });
  return { temp, workspace, outside, frame, window, shown, requests, touched, handlers, dispose, event: { sender: window.webContents, senderFrame: frame }, call: (...args) => handlers.get(CHANNEL)(...args) };
}

test('shows a file or folder inside a registered project workspace, asking the service for the workspaces', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.call(f.event, join(f.workspace, 'src', 'main.ts')), { revealed: true });
  assert.deepEqual(f.shown, [join(realpathSync(f.workspace), 'src', 'main.ts')]);
  // The v2 index (B9), never the legacy whole-record /api/projects.
  assert.equal(f.requests[0][0], `${origin}/api/v2/bootstrap`); assert.equal(f.requests[0][1].redirect, 'error'); assert.ok(f.requests[0][1].signal instanceof AbortSignal);
  // A folder, the workspace itself, a trailing slash and a symlink's own entry (not where it points) are fine too.
  for (const path of [join(f.workspace, 'src'), f.workspace, `${join(f.workspace, 'src')}/`, join(f.workspace, 'link')]) await f.call(f.event, path);
  assert.deepEqual(f.shown.slice(1), [join(realpathSync(f.workspace), 'src'), realpathSync(f.workspace), join(realpathSync(f.workspace), 'src'), join(realpathSync(f.workspace), 'link')]);
  assert.equal(f.requests.length, 5, 'the workspaces are asked for on every call, never cached from an earlier answer');
  f.dispose(); assert.equal(f.handlers.size, 0);
});

test('refuses paths outside every workspace before touching the disk, and links that lead outside', async t => {
  const f = fixture(t);
  for (const path of [join(f.outside, 'secret.txt'), join(f.workspace, '..', 'outside', 'secret.txt'), `${f.workspace}-other/x`, '/etc/hosts']) {
    await assert.rejects(f.call(f.event, path), /^Error: 只能显示项目目录里的文件。$/);
  }
  assert.ok(f.touched.every(path => path === f.workspace), 'only the registered workspace itself was resolved');
  await assert.rejects(f.call(f.event, join(f.workspace, 'link', 'secret.txt')), /只能显示项目目录里的文件/);
  await assert.rejects(f.call(f.event, join(f.workspace, 'src', 'gone.ts')), /^Error: 这个文件已经不在了。$/);
  assert.deepEqual(f.shown, []);
});

test('a link leading out of the project answers alike whether or not anything is there; a missing folder inside is missing', async t => {
  const f = fixture(t);
  for (const path of [join(f.workspace, 'link', 'secret.txt'), join(f.workspace, 'link', 'nothing.txt'), join(f.workspace, 'link', 'no-dir', 'x.txt'), join(f.workspace, 'link', 'a', 'b', 'c')]) {
    await assert.rejects(f.call(f.event, path), /^Error: 只能显示项目目录里的文件。$/, path);
  }
  // Nothing past the link was looked at by name: only folders were resolved, never the target behind it.
  assert.ok(!f.touched.some(path => path.endsWith('secret.txt') || path.endsWith('nothing.txt')));
  for (const path of [join(f.workspace, 'gone', 'x.ts'), join(f.workspace, 'src', 'main.ts', 'x')]) await assert.rejects(f.call(f.event, path), /^Error: 这个文件已经不在了。$/, path);
  assert.deepEqual(f.shown, []);
});

test('a page cannot widen the list: no project, an unreachable service or a malformed answer shows nothing', async t => {
  const none = fixture(t, { projects: [] });
  await assert.rejects(none.call(none.event, join(none.workspace, 'src', 'main.ts')), /只能显示项目目录里的文件/);
  for (const request of [async () => { throw new Error('offline'); }, async () => ({ ok: false }), async () => ({ ok: true, json: async () => [{ id: 'p1', workspacePath: '/' }] }), async () => ({ ok: true, json: async () => ({ projects: { p1: '/' } }) }), async () => ({ ok: true, json: async () => { throw new Error('bad JSON'); } })]) {
    const f = fixture(t, { request });
    await assert.rejects(f.call(f.event, join(f.workspace, 'src', 'main.ts')), /^Error: 无法核对项目目录，请稍后重试。$/);
    assert.deepEqual(f.shown, []);
  }
});

test('the same ownership check as the other bridges, before anything is asked or read', async t => {
  const f = fixture(t);
  const path = join(f.workspace, 'src', 'main.ts');
  for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: { url: f.frame.url } }, { ...f.event, senderFrame: null }]) await assert.rejects(f.call(event, path), /当前应用窗口/);
  f.frame.url = 'https://untrusted.invalid/'; await assert.rejects(f.call(f.event, path), /当前应用窗口/);
  f.frame.url = 'invalid'; await assert.rejects(f.call(f.event, path), /当前应用窗口/);
  f.frame.url = origin; f.window.isDestroyed = () => true; await assert.rejects(f.call(f.event, path), /当前应用窗口/);
  f.window.isDestroyed = () => false;
  for (const input of [undefined, 42, '', 'relative/main.ts', `${path}\n`, `${path}\u0000`, `/${'a'.repeat(4096)}`, { path }]) await assert.rejects(f.call(f.event, input), /^Error: 要显示的路径无效。$/);
  assert.equal(f.requests.length, 0); assert.equal(f.touched.length, 0); assert.deepEqual(f.shown, []);
});

test('ownership is checked again after the service answers', async t => {
  let finish; const f = fixture(t, { request: () => new Promise(resolve => { finish = resolve; }) });
  const result = f.call(f.event, join(f.workspace, 'src', 'main.ts'));
  await new Promise(resolve => setImmediate(resolve));
  f.window.webContents.mainFrame = { url: origin };
  finish({ ok: true, json: async () => ({ projects: [{ id: 'p1', workspacePath: f.workspace }] }) });
  await assert.rejects(result, /^Error: 应用窗口已经变化，未在访达中显示。$/);
  assert.deepEqual(f.shown, []);
});

test('refusals follow the interface language, read for each call', async t => {
  let language = 'en';
  const f = fixture(t, { language: () => language });
  await assert.rejects(f.call(f.event, join(f.outside, 'secret.txt')), /^Error: Only files inside a project folder can be shown\.$/);
  await assert.rejects(f.call({ ...f.event, sender: {} }, f.workspace), /^Error: Only the current app window can show files in Finder\.$/);
  language = 'zh';
  await assert.rejects(f.call(f.event, 'relative'), /^Error: 要显示的路径无效。$/);
});

test('main wires the bridge for the window, preload exposes revealPath, and the package ships the module', () => {
  const desktop = new URL('../desktop/', import.meta.url);
  const main = readFileSync(new URL('main.cjs', desktop), 'utf8'), preload = readFileSync(new URL('preload.cjs', desktop), 'utf8'), build = readFileSync(new URL('build.mjs', desktop), 'utf8');
  assert.match(main, /require\('\.\/reveal-path\.cjs'\)/);
  assert.match(main, /installRevealPath\(\{ ipcMain, shell, window, origin, language: current \}\)/);
  assert.match(preload, /revealPath: path => ipcRenderer\.invoke\('rna:reveal-path', path\)/);
  assert.match(build, /'reveal-path\.cjs'/);
  assert.equal(CHANNEL, 'rna:reveal-path');
});
