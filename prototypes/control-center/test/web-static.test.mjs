import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.mjs';

async function start(t, { withBuild }) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-web-static-'));
  const webDist = join(directory, 'dist');
  if (withBuild) {
    await mkdir(join(webDist, 'assets'), { recursive: true });
    await writeFile(join(webDist, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/assets/index-abc.js"></script>');
    await writeFile(join(webDist, 'assets', 'index-abc.js'), 'console.log("new ui")');
    await writeFile(join(webDist, 'favicon.svg'), '<svg/>');
  }
  const { server } = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false, webDist });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(directory, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('without a web build / explains how to build the UI; API and CLI routes keep working', async t => {
  const base = await start(t, { withBuild: false });
  const root = await fetch(`${base}/`);
  assert.equal(root.status, 503);
  const html = await root.text();
  assert.match(html, /npm run build/); assert.match(html, /web\/dist/);
  assert.doesNotMatch(html, /<script/);
  assert.match(root.headers.get('content-security-policy'), /default-src 'none'/);
  const route = await fetch(`${base}/sessions/abc`, { headers: { accept: 'text/html' } });
  assert.equal(route.status, 503);
  for (const path of ['/app.js', '/style.css', '/legacy/', '/favicon.svg']) assert.equal((await fetch(`${base}${path}`)).status, path === '/legacy/' ? 503 : 404, path);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test('with a web build: / is the workbench UI, legacy asset paths are gone, assets and API untouched', async t => {
  const base = await start(t, { withBuild: true });
  const root = await fetch(`${base}/`);
  assert.equal(root.status, 200);
  assert.match(await root.text(), /<div id="root">/);
  assert.match(root.headers.get('content-security-policy'), /script-src 'self';/);

  const asset = await fetch(`${base}/assets/index-abc.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.match(asset.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);

  // The legacy UI is gone: its paths are not served (the SPA owns /legacy/ like any client route).
  for (const path of ['/app.js', '/style.css', '/settings-ui.js', '/vendor/split-1.6.5.js']) assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  const favicon = await fetch(`${base}/favicon.ico`);
  assert.equal(favicon.status, 200); assert.match(favicon.headers.get('content-type'), /svg/);
  const settingsRoute = await fetch(`${base}/?settings=models`);
  assert.equal(settingsRoute.status, 200); assert.match(await settingsRoute.text(), /<div id="root">/);

  // SPA fallback for client routes, but never for the API or dotfiles.
  const route = await fetch(`${base}/sessions/abc`, { headers: { accept: 'text/html' } });
  assert.equal(route.status, 200);
  assert.match(await route.text(), /<div id="root">/);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/state.json`)).status, 404);
  const api = await fetch(`${base}/api/health`);
  assert.equal(api.status, 200);
  assert.match(api.headers.get('content-type'), /application\/json/);
});
