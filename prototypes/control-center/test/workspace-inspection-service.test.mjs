import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { request } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { WorkspaceInspectionService } from '../workspace-inspection-service.mjs';

async function fixture(t, options = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rna-workspace-inspection-'))), workspace = join(dir, 'game'); await mkdir(workspace);
  const store = new Store(join(dir, 'state.json')), { project } = store.createProject({ name: 'Game', workspace });
  const service = new WorkspaceInspectionService(store, { getDaemonOrigin: () => 'http://127.0.0.1:4317', ...options });
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const html = '<!doctype html><html><body><canvas id="game"></canvas><script type="module" src="./main.mjs"></script></body></html>';
  await writeFile(join(workspace, 'index.html'), html); await writeFile(join(workspace, 'main.mjs'), 'export const initialized = true;');
  return { dir, workspace, store, project, service, html };
}
const raw = (url, path, headers = {}) => new Promise((resolve, reject) => {
  const value = new URL(url), req = request({ hostname: value.hostname, port: value.port, path, headers }, res => { let body = ''; res.setEncoding('utf8'); res.on('data', value => { body += value; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body })); }); req.on('error', reject); req.end();
});

test('tree, UTF-8 source and binary download use actual files without changing project state', async t => {
  const f = await fixture(t); await mkdir(join(f.workspace, 'assets')); await writeFile(join(f.workspace, 'assets', '中文 空格.txt'), '项目源码\n'); await writeFile(join(f.workspace, 'image.png'), Buffer.from([0, 1, 2, 255]));
  const revision = f.store.state.revision, listing = await f.service.list(f.project.id);
  assert.equal(listing.path, ''); assert.equal(listing.entries[0].type, 'directory'); assert.equal(listing.truncated, false);
  assert.deepEqual(await f.service.read(f.project.id, { path: 'assets/中文 空格.txt' }), { path: 'assets/中文 空格.txt', content: '项目源码\n', bytes: 13, language: 'text', truncated: false });
  const image = await f.service.download(f.project.id, { path: 'image.png' }); assert.deepEqual(image.bytes, Buffer.from([0, 1, 2, 255])); assert.equal(image.contentType, 'image/png'); assert.equal(image.filename, 'image.png');
  await assert.rejects(f.service.read(f.project.id, { path: 'image.png' }), { code: 'WORKSPACE_NOT_TEXT', status: 415 }); assert.equal(f.store.state.revision, revision);
});
test('raw inline reads return real MIME types, full bytes and the same path, symlink and size guards', async t => {
  const f = await fixture(t, { maxFileBytes: 64 }); await mkdir(join(f.workspace, 'reports')); await writeFile(join(f.workspace, 'reports', 'daily.pdf'), Buffer.from('%PDF-1.4\n%%EOF\n')); await writeFile(join(f.workspace, 'sheet.xlsx'), Buffer.from([0x50, 0x4b, 3, 4])); await writeFile(join(f.workspace, 'blob.bin'), Buffer.from([0, 255]));
  await writeFile(join(f.workspace, 'big.png'), Buffer.alloc(65)); await writeFile(join(f.workspace, '.env'), 'secret'); await symlink(join(f.workspace, 'index.html'), join(f.workspace, 'link.html')); await symlink(f.dir, join(f.workspace, 'escape'));
  const revision = f.store.state.revision;
  const pdf = await f.service.raw(f.project.id, { path: 'reports/daily.pdf' }); assert.equal(pdf.contentType, 'application/pdf'); assert.equal(pdf.filename, 'daily.pdf'); assert.equal(pdf.size, 15); assert.equal(pdf.bytes.toString(), '%PDF-1.4\n%%EOF\n'); assert.equal(typeof pdf.version, 'string');
  assert.equal((await f.service.raw(f.project.id, { path: 'sheet.xlsx' })).contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal((await f.service.raw(f.project.id, { path: 'blob.bin' })).contentType, 'application/octet-stream');
  await assert.rejects(f.service.raw(f.project.id, { path: 'big.png' }), { code: 'WORKSPACE_FILE_TOO_LARGE', status: 413 });
  for (const path of ['../state.json', '/etc/passwd', 'a/../index.html', '.env', 'link.html', 'escape/state.json', 'escape']) await assert.rejects(f.service.raw(f.project.id, { path }), { code: 'WORKSPACE_PATH_DENIED', status: 403 });
  await assert.rejects(f.service.raw(f.project.id, { path: 'missing.pdf' }), { code: 'WORKSPACE_NOT_FOUND', status: 404 });
  await assert.rejects(f.service.raw(f.project.id, { path: 'reports' }), { code: 'WORKSPACE_NOT_FILE' });
  assert.equal(f.store.state.revision, revision);
});
test('private paths, host state namespaces, traversal and internal/external symlinks cannot be read or listed', async t => {
  const f = await fixture(t); await writeFile(join(f.workspace, '.env'), 'secret'); await mkdir(join(f.workspace, '.runtime')); await writeFile(join(f.workspace, '.runtime', 'test.txt'), 'private'); await symlink(join(f.workspace, 'index.html'), join(f.workspace, 'internal.html')); await symlink(f.dir, join(f.workspace, 'escape'));
  for (const path of ['../state.json', '/etc/passwd', 'a\\b', 'a/../index.html', '.env', '.runtime/test.txt', 'internal.html', 'escape/state.json', 'credentials.json', 'id_rsa', 'secret.pem']) await assert.rejects(f.service.read(f.project.id, { path }), { code: 'WORKSPACE_PATH_DENIED', status: 403 });
  const listing = await f.service.list(f.project.id); assert.ok(!listing.entries.some(row => ['.env', '.runtime', 'internal.html', 'escape'].includes(row.name)));
  f.store.updateProject(f.project.id, { workspace: f.dir }); await writeFile(`${f.store.file}.anything`, 'private host journal');
  for (const path of ['state.json', 'state.json.anything']) await assert.rejects(f.service.download(f.project.id, { path }), { code: 'WORKSPACE_PATH_DENIED' });
  assert.ok(!(await f.service.list(f.project.id)).entries.some(row => row.name.startsWith('state.json')));
});
test('canonical and lexical state aliases deny the state and namespaces in every file and preview path, even when state is absent', async t => {
  const lexical = await mkdtemp(join(tmpdir(), 'rna-inspection-state-alias-')), root = await realpath(lexical), alias = join(root, 'state-parent-alias'); await symlink(root, alias);
  const store = new Store(join(lexical, 'state.json')), { project } = store.createProject({ name: 'Aliased state', workspace: root }), service = new WorkspaceInspectionService(store, { getDaemonOrigin: () => 'http://127.0.0.1:4317' });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, 'index.html'), '<h1>public</h1>'); await mkdir(join(root, 'state.json.archive')); await writeFile(join(root, 'state.json.archive', 'audit.json'), 'private'); await writeFile(join(root, 'state.json.private.html'), '<h1>private</h1>');
  // The first case exercises macOS /var -> /private/var; the explicit alias
  // guarantees the same OS-level identity mismatch on other platforms too.
  for (const file of [join(lexical, 'state.json'), join(alias, 'state.json')]) {
    store.file = file;
    const preview = await service.startPreview(project.id), prefix = new URL(preview.url).pathname.replace('index.html', '');
    for (const path of ['state.json', 'state.json.private.html', 'state.json.archive/audit.json']) {
      await assert.rejects(service.read(project.id, { path }), { code: 'WORKSPACE_PATH_DENIED', status: 403 });
      await assert.rejects(service.download(project.id, { path }), { code: 'WORKSPACE_PATH_DENIED', status: 403 });
      assert.equal((await raw(preview.origin, prefix + path)).status, 403);
    }
    await assert.rejects(service.startPreview(project.id, { path: 'state.json.private.html' }), { code: 'WORKSPACE_PATH_DENIED' });
    assert.ok(!(await service.list(project.id)).entries.some(row => row.name.startsWith('state.json')));
    await service.stopPreview(project.id);
  }
  await rm(join(root, 'state.json'));
  await assert.rejects(service.read(project.id, { path: 'state.json' }), { code: 'WORKSPACE_PATH_DENIED', status: 403 });
  await assert.rejects(service.read(project.id, { path: 'state.json.archive/audit.json' }), { code: 'WORKSPACE_PATH_DENIED', status: 403 });
});
test('source truncation preserves UTF-8 boundaries; binary and resource limits stay explicit', async t => {
  const f = await fixture(t, { maxTextBytes: 7, maxFileBytes: 20, maxEntries: 2 });
  await writeFile(join(f.workspace, 'large.txt'), '中文世界abc'); await writeFile(join(f.workspace, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
  const text = await f.service.read(f.project.id, { path: 'large.txt' }); assert.equal(text.content, '中文'); assert.equal(text.truncated, true); assert.equal(text.bytes, 15);
  await assert.rejects(f.service.read(f.project.id, { path: 'invalid.txt' }), { code: 'WORKSPACE_NOT_TEXT' });
  await assert.rejects(f.service.download(f.project.id, { path: 'index.html' }), { code: 'WORKSPACE_FILE_TOO_LARGE', status: 413 });
  const listing = await f.service.list(f.project.id); assert.equal(listing.entries.length, 2); assert.equal(listing.truncated, true);
  await assert.rejects(f.service.read(f.project.id, { path: 'missing.txt' }), { code: 'WORKSPACE_NOT_FOUND', status: 404 });
});
test('a FIFO is rejected without blocking the file service or its shutdown', async t => {
  const f = await fixture(t); await promisify(execFile)('/usr/bin/mkfifo', [join(f.workspace, 'pipe')]);
  await assert.rejects(Promise.race([f.service.read(f.project.id, { path: 'pipe' }), delay(1000).then(() => { throw new Error('FIFO open blocked'); })]), { code: 'WORKSPACE_NOT_FILE' });
  assert.equal((await f.service.read(f.project.id, { path: 'main.mjs' })).content, 'export const initialized = true;');
});
test('real static preview serves HTML and relative modules on a distinct origin, with no tokenless or cross-origin access', async t => {
  const f = await fixture(t), preview = await f.service.startPreview(f.project.id, { path: 'index.html' });
  assert.equal(preview.status, 'ready'); assert.notEqual(preview.origin, 'http://127.0.0.1:4317'); assert.deepEqual(f.service.previewStatus(f.project.id), preview);
  const response = await fetch(preview.url); assert.equal(response.status, 200); assert.equal(await response.text(), f.html); assert.match(response.headers.get('content-security-policy'), /frame-ancestors http:\/\/127\.0\.0\.1:4317/); assert.equal(response.headers.get('referrer-policy'), 'no-referrer'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const module = await fetch(new URL('./main.mjs', preview.url)); assert.equal(module.status, 200); assert.match(module.headers.get('content-type'), /javascript/); assert.match(await module.text(), /initialized/);
  await writeFile(join(f.workspace, 'main.mjs'), 'export const initialized = 2;'); assert.match(await (await fetch(new URL('./main.mjs', preview.url))).text(), /= 2/);
  assert.equal((await fetch(`${preview.origin}/index.html`)).status, 404); assert.equal((await fetch(preview.url, { headers: { Origin: 'http://127.0.0.1:4317' } })).status, 403);
  assert.equal((await fetch(preview.url, { method: 'POST' })).status, 405);
  assert.equal((await raw(preview.origin, new URL(preview.url).pathname, { Host: 'foreign.example' })).status, 403);
  assert.equal((await raw(preview.origin, new URL(preview.url).pathname, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const prefix = new URL(preview.url).pathname.replace('index.html', '');
  for (const suffix of ['%2e%2e/state.json', '.env', '%00', 'bad%ZZ']) assert.ok((await raw(preview.origin, prefix + suffix)).status >= 400);
  await assert.rejects(f.service.startPreview(f.project.id, { path: 'main.mjs' }), { code: 'PREVIEW_HTML_REQUIRED' });
});
test('relative entry paths work, while root-absolute assets have no ambient project access', async t => {
  const f = await fixture(t); await mkdir(join(f.workspace, 'dist')); await writeFile(join(f.workspace, 'dist', 'game page.html'), f.html); await writeFile(join(f.workspace, 'dist', 'main.mjs'), 'export const subdirectory = true;');
  const preview = await f.service.startPreview(f.project.id, { path: 'dist/game page.html' }); assert.match(preview.url, /dist\/game%20page.html$/); assert.equal(await (await fetch(preview.url)).text(), f.html); assert.match(await (await fetch(new URL('./main.mjs', preview.url))).text(), /subdirectory/);
  assert.equal((await fetch(new URL('/main.mjs', preview.url))).status, 404);
});
test('archive, deletion and workspace replacement revoke existing preview URLs', async t => {
  for (const operation of ['archive', 'delete', 'workspace']) {
    const f = await fixture(t), preview = await f.service.startPreview(f.project.id);
    if (operation === 'archive') f.store.updateProject(f.project.id, { archived: true });
    else if (operation === 'delete') f.store.deleteProject(f.project.id);
    else { const other = join(f.dir, 'other'); await mkdir(other); await writeFile(join(other, 'index.html'), 'other'); f.store.updateProject(f.project.id, { workspace: other }); }
    await f.service.stopPreview(f.project.id); await assert.rejects(fetch(preview.url)); assert.equal(f.service.previews.size, 0);
  }
});
test('filesystem root replacement invalidates a preview even without a settings update', async t => {
  const f = await fixture(t), preview = await f.service.startPreview(f.project.id); await rename(f.workspace, `${f.workspace}-old`); await mkdir(f.workspace); await writeFile(join(f.workspace, 'index.html'), 'unapproved replacement');
  const result = await fetch(preview.url); assert.equal(result.status, 409); assert.ok(!(await result.text()).includes('unapproved replacement'));
});
test('concurrent start is idempotent, cap is enforced before asynchronous startup, and stop destroys keep-alive sockets', async t => {
  const f = await fixture(t, { maxPreviews: 2 }), [a, b] = await Promise.all([f.service.startPreview(f.project.id), f.service.startPreview(f.project.id)]); assert.equal(a.url, b.url); assert.equal(f.service.previews.size, 1);
  const extra = [];
  for (let i = 0; i < 2; i++) { const workspace = join(f.dir, `game${i}`); await mkdir(workspace); await writeFile(join(workspace, 'index.html'), 'game'); extra.push(f.store.createProject({ name: `Game ${i}`, workspace }).project.id); }
  const starting = f.service.startPreview(extra[0]); await assert.rejects(f.service.startPreview(extra[1]), { code: 'PREVIEW_LIMIT' }); await starting;
  const socket = connect(new URL(a.url).port, '127.0.0.1'); const closed = new Promise(resolve => socket.once('close', resolve)); await new Promise(resolve => socket.once('connect', resolve)); socket.write(`GET ${new URL(a.url).pathname} HTTP/1.1\r\nHost: ${new URL(a.url).host}\r\nConnection: keep-alive\r\n\r\n`); socket.resume(); await new Promise(resolve => socket.once('data', resolve));
  await f.service.stopPreview(f.project.id); await Promise.race([closed, delay(1000).then(() => assert.fail('Preview keep-alive socket was not closed'))]); await assert.rejects(fetch(a.url));
});
test('stop during file validation cancels startup and close never leaves a listening preview', async t => {
  const f = await fixture(t); let release, entered; const gate = new Promise(resolve => { release = resolve; }), seen = new Promise(resolve => { entered = resolve; }); const original = f.service.bytes.bind(f.service);
  f.service.bytes = async (...args) => { entered(); await gate; return original(...args); };
  const start = f.service.startPreview(f.project.id); await seen; const stop = f.service.stopPreview(f.project.id); release(); await assert.rejects(start, { code: 'PREVIEW_CANCELLED' }); await stop; assert.equal(f.service.previews.size, 0); assert.equal(f.service.starting.size, 0);
  f.service.bytes = original; await f.service.startPreview(f.project.id); await f.service.close(); assert.equal(f.service.previews.size, 0); await assert.rejects(f.service.startPreview(f.project.id), { code: 'WORKSPACE_CLOSED' });
});
