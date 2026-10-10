import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { installApplicationPicker, CHANNEL } = createRequire(import.meta.url)('../desktop/application-picker.cjs');
const origin = 'http://127.0.0.1:4317';
function fixture(select = async () => ({ canceled: false, filePaths: ['/tmp/Rna Agent.app'] })) {
  const frame = { url: `${origin}/` }, window = { isDestroyed: () => false, webContents: { mainFrame: frame } }, calls = []; let handler, removed;
  const close = installApplicationPicker({ window, origin, ipcMain: { handle: (channel, fn) => { assert.equal(channel, CHANNEL); handler = fn; }, removeHandler: channel => { removed = channel; } }, dialog: { showOpenDialog: (...args) => { calls.push(args); return select(...args); } } });
  return { frame, window, calls, event: { sender: window.webContents, senderFrame: frame }, call: (...args) => handler(...args), close, removed: () => removed };
}
test('application source selection returns only an explicit native path, cancellation returns null', async () => {
  const f = fixture(); assert.equal(await f.call(f.event), '/tmp/Rna Agent.app'); assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0][1].properties, ['openFile', 'openDirectory']); f.close(); assert.equal(f.removed(), CHANNEL);
  const cancelled = fixture(async () => ({ canceled: true, filePaths: [] })); assert.equal(await cancelled.call(cancelled.event), null);
});
test('native application picker rejects unowned windows, subframes, malformed and foreign origins before showing', () => {
  const f = fixture(); for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: null }, { ...f.event, senderFrame: { url: origin } }]) assert.throws(() => f.call(event), /当前应用窗口/);
  for (const url of ['https://invalid.example', 'invalid']) { f.frame.url = url; assert.throws(() => f.call(f.event), /当前应用窗口/); }
  assert.equal(f.calls.length, 0);
});
test('picker coalesces clicks and revalidates ownership after the asynchronous native selection', async () => {
  let finish; const f = fixture(() => new Promise(resolve => { finish = resolve; })); const first = f.call(f.event), second = f.call(f.event); assert.equal(first, second); assert.equal(f.calls.length, 1);
  f.window.webContents.mainFrame = { url: origin }; finish({ canceled: false, filePaths: ['/tmp/source'] }); await assert.rejects(first, /窗口已经变化/);
});
test('native picker does not forward relative, control-character or missing paths', async () => {
  for (const value of ['relative', '/tmp/a\nsecret', undefined, '/tmp/a\u009b', '/'+ 'a'.repeat(8192)]) { const f = fixture(async () => ({ canceled: false, filePaths: [value] })); await assert.rejects(f.call(f.event), /目录无效/); }
});
