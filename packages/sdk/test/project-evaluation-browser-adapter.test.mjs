import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createBrowserEvaluationAdapter, validateBrowserEvaluationEnvironment } from '../src/project-evaluation-browser-adapter.mjs';

const basic = () => ({ kind: 'browser', entry: 'index.html', viewport: { width: 800, height: 600 }, steps: [{ id: 'visible', kind: 'assert_visible', selector: 'h1' }] });
const temporary = async files => { const root = await mkdtemp(join(tmpdir(), 'rna-browser-test-')), workspace = join(root, 'workspace'); await mkdir(workspace); for (const [name, value] of Object.entries(files)) await writeFile(join(workspace, name), value); return { root, workspace }; };
const adapter = createBrowserEvaluationAdapter();

test('browser frozen DSL accepts bounded interaction and assertion instructions only', () => {
  assert.deepEqual(validateBrowserEvaluationEnvironment(basic()), basic());
  for (const patch of [{ entry: '/Users/private.html' }, { entry: '../index.html' }, { entry: '.secret/index.html' }, { url: 'https://example.com' }, { viewport: { width: 5000, height: 600 } }, { settleMs: 1001 }, { steps: [{ id: 'x', kind: 'evaluate', selector: 'x', expression: 'process.env' }] }, { steps: [{ id: 'x', kind: 'click', selector: 'x' }] }, { steps: [{ id: 'x', kind: 'assert_visible', selector: 'x', unexpected: true }] }]) assert.throws(() => validateBrowserEvaluationEnvironment({ ...basic(), ...patch }), { code: 'invalid_evaluation_environment' });
});

test('browser unavailable is an explicit environment error, never a zero candidate score', async () => {
  await assert.rejects(createBrowserEvaluationAdapter({ executablePath: '/missing/rna-browser' }).verify({ workspace: '/missing', environment: basic() }), { code: 'environment_unavailable' });
});

test('real Chromium clicks/types, verifies DOM in isolated world and retains screenshot outside workspace', async () => {
  const fixture = await temporary({ 'index.html': '<!doctype html><h1>Counter</h1><input id="name" value="old"><button id="go">Apply</button><output id="out">0</output><script src="app.js"></script>', 'app.js': 'document.querySelector("#go").onclick=()=>document.querySelector("#out").textContent=document.querySelector("#name").value;Document.prototype.querySelectorAll=()=>[];' });
  try {
    const environment = { ...basic(), steps: [{ id: 'input', kind: 'input', selector: '#name', value: '你好 Rna' }, { id: 'click', kind: 'click', selector: '#go' }, { id: 'text', kind: 'assert_text', selector: '#out', expected: '你好 Rna' }, { id: 'count', kind: 'assert_count', selector: 'button', expected: 1 }] };
    const result = await createBrowserEvaluationAdapter({ artifactDirectory: join(fixture.root, 'receipts') }).verify({ workspace: fixture.workspace, environment });
    assert.equal(result.passed, true, JSON.stringify(result)); assert.equal(result.checks.length, 4);
    assert.equal(result.screenshot.retained, true); assert.equal('data' in result.screenshot, false);
    const screenshot = await readFile(result.screenshot.path); assert.equal(screenshot.subarray(1, 4).toString(), 'PNG'); assert.equal(createHash('sha256').update(screenshot).digest('hex'), result.screenshot.hash);
    assert.equal(result.runtimeErrors.length, 0); assert.equal(result.isolation.osSandbox, 'not_claimed');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('real Chromium reports baseline behavior failure and candidate success under same frozen task', async () => {
  const baseline = await temporary({ 'index.html': '<h1>0</h1><button onclick="document.querySelector(\'h1\').textContent=2">Add</button>' });
  const candidate = await temporary({ 'index.html': '<h1>0</h1><button onclick="document.querySelector(\'h1\').textContent=1">Add</button>' });
  const environment = { ...basic(), screenshot: false, steps: [{ id: 'click', kind: 'click', selector: 'button' }, { id: 'answer', kind: 'assert_text', selector: 'h1', expected: '1' }] };
  try {
    const old = await adapter.verify({ workspace: baseline.workspace, environment }), next = await adapter.verify({ workspace: candidate.workspace, environment });
    assert.equal(old.passed, false); assert.equal(old.checks[1].code, 'assertion_mismatch'); assert.equal(next.passed, true);
    assert.deepEqual(old.viewport, next.viewport); assert.equal(old.browser.product, next.browser.product);
  } finally { await rm(baseline.root, { recursive: true, force: true }); await rm(candidate.root, { recursive: true, force: true }); }
});

test('real Chromium blocks host network, file, websocket, worker and iframe attempts without contacting a trap server', async () => {
  let contacts = 0;
  const server = createServer((request, response) => { contacts++; response.end('private'); }); server.on('upgrade', socket => { contacts++; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
  const fixture = await temporary({ 'index.html': '<h1>Safe</h1><iframe src="http://127.0.0.1:' + port + '/frame"></iframe><script>fetch("http://127.0.0.1:' + port + '/secret").catch(()=>{});fetch("file:///etc/passwd").catch(()=>{});try{new WebSocket("ws://127.0.0.1:' + port + '/ws")}catch{};try{new Worker("worker.js")}catch{};</script>', 'worker.js': 'fetch("http://127.0.0.1:' + port + '/worker")' });
  try {
    const result = await adapter.verify({ workspace: fixture.workspace, environment: { ...basic(), settleMs: 200, screenshot: false } });
    assert.equal(result.passed, false); assert.equal(contacts, 0); assert.ok(result.networkAttempts.some(item => /connect-src/.test(item.directive))); assert.ok(result.networkAttempts.some(item => /worker-src/.test(item.directive))); assert.ok(result.networkAttempts.some(item => /frame-src/.test(item.directive)));
  } finally { await rm(fixture.root, { recursive: true, force: true }); await new Promise(resolve => server.close(resolve)); }
});

test('browser reports actual runtime errors even if visible assertions pass', async () => {
  const fixture = await temporary({ 'index.html': '<h1>Visible</h1><script>throw new Error("actual fixture failure")</script>' });
  try {
    const result = await adapter.verify({ workspace: fixture.workspace, environment: { ...basic(), screenshot: false } });
    assert.equal(result.passed, false); assert.equal(result.checks[0].passed, true); assert.match(result.runtimeErrors[0].text, /actual fixture failure/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('browser workspace refuses links before launching and missing HTML is an artifact failure', async () => {
  const fixture = await temporary({});
  try {
    assert.equal((await adapter.verify({ workspace: fixture.workspace, environment: basic() })).checks[0].code, 'artifact_missing');
    await symlink('/etc/passwd', join(fixture.workspace, 'index.html'));
    await assert.rejects(adapter.verify({ workspace: fixture.workspace, environment: basic() }), { code: 'evaluation_workspace_invalid' });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('browser cancellation propagates, cleans resources and never returns a partial pass', async () => {
  const fixture = await temporary({ 'index.html': '<h1>Ready</h1>' }), controller = new AbortController(), reason = Object.assign(new Error('test cancelled'), { code: 'test_cancelled' });
  try {
    const pending = adapter.verify({ workspace: fixture.workspace, environment: { ...basic(), steps: [{ id: 'wait', kind: 'assert_text', selector: 'h1', expected: 'never' }], settleMs: 1000 }, signal: controller.signal });
    setTimeout(() => controller.abort(reason), 700);
    await assert.rejects(pending, error => error === reason);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('frozen browser identity rejects an executable changed between probe and execution', async () => {
  const fixture = await temporary({});
  try {
    const executablePath = join(fixture.root, 'browser-probe');
    const { chmod } = await import('node:fs/promises');
    await writeFile(executablePath, '#!/bin/sh\necho "Google Chrome 123.0.0.1"\n'); await chmod(executablePath, 0o700);
    const pinned = createBrowserEvaluationAdapter({ executablePath }), identity = await pinned.probe();
    assert.match(identity.executableHash, /^[a-f0-9]{64}$/); assert.equal('executable' in identity, false);
    await writeFile(executablePath, '#!/bin/sh\necho "Google Chrome 123.0.0.2"\n');
    await assert.rejects(pinned.verify({ workspace: fixture.workspace, environment: basic() }), { code: 'environment_changed' });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('real Chromium serves only snapshot-local fetches and fresh profiles never inherit local storage', async () => {
  const fixture = await temporary({ 'index.html': '<h1>Loading</h1><script>fetch("data.json").then(r=>r.json()).then(d=>{document.querySelector("h1").textContent=localStorage.getItem("old")||d.message;localStorage.setItem("old","leaked")})</script>', 'data.json': '{"message":"fresh"}' });
  try {
    const environment = { ...basic(), screenshot: false, steps: [{ id: 'fresh', kind: 'assert_text', selector: 'h1', expected: 'fresh' }] };
    for (let n = 0; n < 2; n++) { const result = await adapter.verify({ workspace: fixture.workspace, environment }); assert.equal(result.passed, true, JSON.stringify(result)); assert.equal(result.networkAttempts.length, 0); }
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('real Chromium does not report an element hidden by an ancestor as visible', async () => {
  const fixture = await temporary({ 'index.html': '<main style="opacity:0"><h1>Hidden</h1></main>' });
  try {
    const result = await adapter.verify({ workspace: fixture.workspace, environment: { ...basic(), screenshot: false } });
    assert.equal(result.passed, false); assert.equal(result.checks[0].observed.visible, false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('real Chromium refreshes its isolated verification context after a local-page navigation', async () => {
  const fixture = await temporary({ 'index.html': '<a href="done.html">Continue</a>', 'done.html': '<h1>Delivered</h1>' });
  try {
    const result = await adapter.verify({ workspace: fixture.workspace, environment: { ...basic(), screenshot: false, steps: [{ id: 'navigate', kind: 'click', selector: 'a' }, { id: 'arrived', kind: 'assert_text', selector: 'h1', expected: 'Delivered' }] } });
    assert.equal(result.passed, true, JSON.stringify(result));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('browser snapshot bounds empty-directory entries as well as file count', async () => {
  const fixture = await temporary({ 'index.html': '<h1>Visible</h1>' });
  try {
    for (let n = 0; n < 201; n++) await mkdir(join(fixture.workspace, 'empty-' + n));
    await assert.rejects(adapter.verify({ workspace: fixture.workspace, environment: basic() }), { code: 'evaluation_workspace_invalid' });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('browser receipt reuse rejects an oversized existing same-name screenshot before reading it', async () => {
  const fixture = await temporary({ 'index.html': '<h1>Receipt</h1>' });
  try {
    const retained = createBrowserEvaluationAdapter({ artifactDirectory: join(fixture.root, 'receipts') });
    const first = await retained.verify({ workspace: fixture.workspace, environment: basic() });
    await writeFile(first.screenshot.path, Buffer.alloc(2 * 1024 * 1024 + 1));
    await assert.rejects(retained.verify({ workspace: fixture.workspace, environment: basic() }), { code: 'evaluation_artifact_directory_invalid' });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
