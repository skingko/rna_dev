import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { installPreviewLauncher, CHANNEL } = createRequire(import.meta.url)('../desktop/preview-launcher.cjs');
const origin = 'http://127.0.0.1:4317', url = 'http://127.0.0.1:4321/preview-token/index.html';
function fixture(request) {
  const frame = { url: `${origin}/` }, window = { isDestroyed: () => false, webContents: { mainFrame: frame } }, opened = [], requests = [];
  let handler, removed;
  const cleanup = installPreviewLauncher({ window, origin, ipcMain: { handle: (channel, fn) => { assert.equal(channel, CHANNEL); handler = fn; }, removeHandler: channel => { removed = channel; } }, shell: { openExternal: async value => opened.push(value) }, fetch: async (...args) => { requests.push(args); return request ? request(...args) : { ok: true, json: async () => ({ status: 'ready', kind: 'static', url, origin: new URL(url).origin }) }; } });
  return { window, frame, opened, requests, cleanup, removed: () => removed, event: { sender: window.webContents, senderFrame: frame }, call: (...args) => handler(...args), input: { projectId: 'project-1', url } };
}
test('desktop opens only the exact current ready static preview after host verification', async () => {
  const f = fixture(); assert.deepEqual(await f.call(f.event, f.input), { opened: true }); assert.deepEqual(f.opened, [url]);
  assert.equal(f.requests[0][0], `${origin}/api/projects/project-1/preview`); assert.equal(f.requests[0][1].redirect, 'error'); assert.ok(f.requests[0][1].signal instanceof AbortSignal);
  f.cleanup(); assert.equal(f.removed(), CHANNEL);
});
test('desktop opens a current managed Vite preview through the same exact-URL verification', async () => {
  const f = fixture(async () => ({ ok: true, json: async () => ({ status: 'ready', kind: 'vite', url, origin: new URL(url).origin }) }));
  assert.deepEqual(await f.call(f.event, f.input), { opened: true }); assert.deepEqual(f.opened, [url]);
});
test('desktop preview bridge rejects non-owned windows, subframes and foreign origins before fetching', () => {
  const f = fixture();
  for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: { url: f.frame.url } }, { ...f.event, senderFrame: null }]) assert.throws(() => f.call(event, f.input), /当前应用窗口/);
  f.frame.url = 'https://untrusted.invalid/'; assert.throws(() => f.call(f.event, f.input), /当前应用窗口/);
  f.frame.url = 'invalid'; assert.throws(() => f.call(f.event, f.input), /当前应用窗口/);
  f.frame.url = origin; f.window.isDestroyed = () => true; assert.throws(() => f.call(f.event, f.input), /当前应用窗口/);
  assert.equal(f.requests.length, 0); assert.equal(f.opened.length, 0);
});
test('desktop refuses arbitrary protocols, remote hosts, daemon URLs and decorated preview URLs', () => {
  const f = fixture();
  for (const candidate of ['file:///tmp/index.html','javascript:alert(1)','https://127.0.0.1:4321/x','http://example.com:4321/x',`${origin}/api/state`,'http://127.0.0.1/x','http://user:pass@127.0.0.1:4321/x',`${url}?query=1`,`${url}#hash`,'broken']) assert.throws(() => f.call(f.event, { ...f.input, url: candidate }));
  for (const projectId of ['', '../secrets', 'x/y', 'x?y', 'a'.repeat(129)]) assert.throws(() => f.call(f.event, { ...f.input, projectId }));
  assert.equal(f.requests.length, 0); assert.equal(f.opened.length, 0);
});
test('desktop refuses stale, stopped, mismatched and unreachable preview state', async () => {
  for (const patch of [{ status: 'stopped' }, { kind: 'other' }, { url: url + '/other' }, { origin }]) {
    const f = fixture(async () => ({ ok: true, json: async () => ({ status: 'ready', kind: 'static', url, origin: new URL(url).origin, ...patch }) }));
    await assert.rejects(f.call(f.event, f.input), /已变化或服务已停止/); assert.equal(f.opened.length, 0);
  }
  for (const response of [async () => { throw Error('offline'); }, async () => ({ ok: false }), async () => ({ ok: true, json: async () => { throw Error('bad JSON'); } })]) {
    const f = fixture(response); await assert.rejects(f.call(f.event, f.input), /无法确认/); assert.equal(f.opened.length, 0);
  }
});
test('desktop revalidates window ownership after awaiting host response', async () => {
  let finish; const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const result = f.call(f.event, f.input); f.window.webContents.mainFrame = { url: origin };
  finish({ ok: true, json: async () => ({ status: 'ready', kind: 'static', url, origin: new URL(url).origin }) });
  await assert.rejects(result, /窗口已经变化/); assert.equal(f.opened.length, 0);
});
test('desktop coalesces repeated launch clicks and rejects a concurrent different target', async () => {
  let finish; const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const first = f.call(f.event, f.input), second = f.call(f.event, f.input); assert.equal(first, second);
  assert.throws(() => f.call(f.event, { ...f.input, projectId: 'other' }), /正在打开另一个/);
  finish({ ok: true, json: async () => ({ status: 'ready', kind: 'static', url, origin: new URL(url).origin }) });
  await Promise.all([first, second]); assert.equal(f.requests.length, 1); assert.deepEqual(f.opened, [url]);
});
