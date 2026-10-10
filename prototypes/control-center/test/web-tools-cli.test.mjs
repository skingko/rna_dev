import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.mjs';

const exec = promisify(execFile), cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
async function fixture(t, { failFetch = false, authenticationFailure = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-web-cli-')), file = join(directory, 'state.json'), remoteRequests = [], apiRequests = [];
  const remote = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    remoteRequests.push({ path: req.url, method: req.method, headers: req.headers, body: JSON.parse(raw) });
    const key = req.headers.authorization?.slice(7) ?? '', failed = authenticationFailure || failFetch && req.url.endsWith('/scrape');
    res.writeHead(authenticationFailure ? 401 : failed ? 502 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(failed ? { success: false, error: `Reflected credential ${key}` } : req.url.endsWith('/search') ? { success: true, data: [{ url: 'https://docs.fastcrw.com/', title: 'Documentation', snippet: 'Official docs' }] } : { success: true, data: { markdown: '# Documentation\nFixture page.', metadata: { sourceURL: 'https://docs.fastcrw.com/', statusCode: 200 } } }));
  });
  await new Promise(done => remote.listen(0, '127.0.0.1', done));
  const app = createServer({ stateFile: file, ticks: false, runtime: false }); await app.initializer.close();
  await new Promise(done => app.server.listen(0, '127.0.0.1', done)); app.server.on('request', req => apiRequests.push({ method: req.method, path: req.url }));
  t.after(async () => { app.server.closeAllConnections(); await app.close(); remote.closeAllConnections(); await new Promise(done => remote.close(done)); await rm(directory, { recursive: true, force: true }); });
  const invoke = (...args) => exec(process.execPath, [cli, ...args], { env: { ...process.env, RNA_AGENT_PORT: String(app.server.address().port), PI_FORGE_PORT: '1' }, timeout: 15000 });
  const json = async (...args) => JSON.parse((await invoke(...args)).stdout);
  return { ...app, directory, file, remoteRequests, apiRequests, baseUrl: `http://127.0.0.1:${remote.address().port}`, invoke, json };
}

test('CLI file configuration stores key privately and explicit connection test verifies both routes while model tools remain disabled', async t => {
  const f = await fixture(t), key = randomUUID(), input = join(f.directory, 'web-config.json');
  const defaults = await f.json('web-config'); assert.equal(defaults.enabled, false); assert.equal(defaults.apiKeyConfigured, false);
  await writeFile(input, JSON.stringify({ enabled: false, baseUrl: f.baseUrl, timeoutMs: 3000, apiKey: key }), { mode: 0o600 });
  const settings = await f.json('web-config', '--file', input); assert.equal(settings.enabled, false); assert.equal(settings.timeoutMs, 3000); assert.equal(settings.apiKeyConfigured, true);
  assert.ok(!JSON.stringify(settings).includes(key)); assert.ok(!(await readFile(f.file, 'utf8')).includes(key)); assert.equal((await stat(`${f.file}.secrets`)).mode & 0o777, 0o600);
  const checked = await f.json('web-test'); assert.equal(checked.ok, true); assert.deepEqual(checked.testedTools, ['web_search', 'web_fetch']); assert.deepEqual(checked.checks.map(row => [row.tool, row.ok]), [['web_search', true], ['web_fetch', true]]);
  assert.deepEqual(f.remoteRequests.map(row => row.path), ['/v1/search', '/v1/scrape']); assert.ok(f.remoteRequests.every(row => row.method === 'POST' && row.headers.authorization === `Bearer ${key}`));
  assert.equal(f.store.state.configuration.webTools.enabled, false); assert.equal(f.store.state.realUsage.tokens, 0); assert.ok(!JSON.stringify(checked).includes(key));
  assert.ok(f.apiRequests.every(row => ['/api/configuration', '/api/web-tools/test'].includes(row.path)));
});

test('CLI typed flags and environment references work; plaintext-key flags and mixed file modes are refused without changing configuration', async t => {
  const f = await fixture(t), environment = `RNA_WEB_CLI_${randomUUID().replaceAll('-', '_')}`, key = randomUUID(); process.env[environment] = key; t.after(() => delete process.env[environment]);
  const settings = await f.json('web-config', '--enabled', 'true', '--endpoint', `${f.baseUrl}/v1`, '--timeout-ms', '2500', '--api-key-env', environment);
  assert.equal(settings.enabled, true); assert.equal(settings.baseUrl, `${f.baseUrl}/v1`); assert.equal(settings.credentialSource, 'environment'); assert.equal(settings.apiKeyConfigured, true); assert.ok(!JSON.stringify(settings).includes(key));
  await f.json('web-test'); assert.equal(f.remoteRequests[0].path, '/v1/search'); assert.equal(f.remoteRequests[0].headers.authorization, `Bearer ${key}`);
  const before = await readFile(f.file, 'utf8'), input = join(f.directory, 'safe.json'); await writeFile(input, '{}');
  for (const args of [['--api-key', key], ['--enabled', 'yes'], ['--timeout-ms', '999'], ['--file', input, '--enabled', 'false']]) await assert.rejects(f.invoke('web-config', ...args), error => error.code === 1 && !`${error.stdout}${error.stderr}`.includes(key));
  assert.equal(await readFile(f.file, 'utf8'), before); assert.equal(f.remoteRequests.length, 2); assert.equal(f.store.state.realUsage.tokens, 0);
  // Another search service by name: its own address, and the variable that named the old service's key is dropped.
  const brave = await f.json('web-config', '--provider', 'brave');
  assert.deepEqual({ provider: brave.provider, baseUrl: brave.baseUrl, apiKeyEnv: brave.apiKeyEnv, apiKeyConfigured: brave.apiKeyConfigured, enabled: brave.enabled }, { provider: 'brave', baseUrl: 'https://api.search.brave.com', apiKeyEnv: '', apiKeyConfigured: false, enabled: true });
  await assert.rejects(f.invoke('web-config', '--provider', 'google'), error => error.code === 1 && /supported search services|受支持的搜索服务/.test(`${error.stdout}${error.stderr}`));
  assert.equal(f.store.state.configuration.webTools.provider, 'brave');
});

test('CLI web-test exits nonzero and preserves partial checks when search succeeds but fetch fails', async t => {
  const f = await fixture(t, { failFetch: true }), key = randomUUID(); f.store.configurationService.update({ webTools: { enabled: true, baseUrl: f.baseUrl, apiKey: key } });
  await assert.rejects(f.invoke('web-test'), error => {
    const output = JSON.parse(error.stdout); assert.equal(error.code, 1); assert.equal(output.ok, false); assert.deepEqual(output.testedTools, ['web_search']);
    assert.deepEqual(output.checks.map(row => [row.tool, row.ok]), [['web_search', true], ['web_fetch', false]]); assert.equal(output.checks[1].code, 'FASTCRW_UPSTREAM'); assert.ok(!`${error.stdout}${error.stderr}`.includes(key)); return true;
  });
  assert.equal(f.remoteRequests.length, 2); assert.equal(f.store.state.realUsage.tokens, 0);
});

test('CLI authentication failure does not dispatch an unnecessary second route or claim fetch was checked', async t => {
  const f = await fixture(t, { authenticationFailure: true }); f.store.configurationService.update({ webTools: { baseUrl: f.baseUrl, apiKey: randomUUID() } });
  await assert.rejects(f.invoke('web-test'), error => {
    const output = JSON.parse(error.stdout); assert.equal(error.code, 1); assert.equal(output.ok, false); assert.deepEqual(output.testedTools, []); assert.deepEqual(output.checks.map(row => [row.tool, row.code]), [['web_search', 'FASTCRW_AUTH']]); return true;
  });
  assert.equal(f.remoteRequests.length, 1); assert.equal(f.store.state.realUsage.tokens, 0);
});
