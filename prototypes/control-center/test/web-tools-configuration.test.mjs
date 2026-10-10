import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { createServer } from '../server.mjs';
import { initialConfiguration } from '../configuration.mjs';
import { readStateFile, readStateText } from '../state-shards.mjs';

function stateFile(t) { const dir = mkdtempSync(join(tmpdir(), 'rna-webtools-config-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'state.json'); }
function secret(store) { return store.configurationService.secret('webTools', store.state.configuration.webTools); }

test('old and new stores default to the disabled public FastCRW service, without a model provider or per-project assignment', t => {
  const file = stateFile(t), first = new Store(file);
  assert.deepEqual(initialConfiguration().webTools, { enabled: false, provider: 'fastcrw', baseUrl: 'https://api.fastcrw.com', timeoutMs: 30000, apiKeyEnv: '' });
  const raw = readStateFile(file).state; delete raw.configuration.webTools; writeFileSync(file, JSON.stringify(raw));
  const reopened = new Store(file), settings = reopened.configurationService.public().webTools;
  assert.deepEqual(reopened.state.configuration.webTools, initialConfiguration().webTools);
  assert.equal(settings.apiKeyConfigured, false); assert.equal(settings.credentialSource, 'none');
  assert.deepEqual(first.state.configuration.providers, reopened.state.configuration.providers);
});

test('web credentials persist separately as 0600, never appear in configuration/state/events, and survive unrelated edits and restart', t => {
  const file = stateFile(t), store = new Store(file), credential = 'fixture-web-key-do-not-return', events = [];
  store.subscribe(() => events.push(store.get()));
  const config = store.configurationService.update({ webTools: { enabled: true, baseUrl: 'https://search.example.test/custom/', apiKey: credential } });
  assert.equal(config.webTools.baseUrl, 'https://search.example.test/custom'); assert.equal(config.webTools.apiKeyConfigured, true);
  assert.equal(config.webTools.credentialSource, 'local-file'); assert.equal(secret(store), credential);
  assert.equal(statSync(`${file}.secrets`).mode & 0o777, 0o600);
  for (const value of [config, store.get(), store.state, events]) assert.equal(JSON.stringify(value).includes(credential), false);
  assert.equal(readStateText(file).includes(credential), false);
  const reopened = new Store(file); reopened.configurationService.update({ webTools: { timeoutMs: 45000 }, memory: { limit: 8 } });
  assert.equal(secret(reopened), credential); assert.equal(reopened.state.configuration.webTools.timeoutMs, 45000);
  assert.equal(reopened.configurationService.secretValues().includes(credential), true);
  reopened.configurationService.update({ webTools: { apiKey: '' } });
  assert.equal(secret(reopened), ''); assert.equal(reopened.configurationService.public().webTools.apiKeyConfigured, false);
});

test('environment credentials take precedence and are never copied into state; clear removes both references and stored keys', t => {
  const store = new Store(stateFile(t)), name = 'RNA_WEBTOOLS_TEST_CREDENTIAL';
  process.env[name] = 'fixture-env-web-key'; t.after(() => delete process.env[name]);
  store.configurationService.update({ webTools: { apiKey: 'fixture-file-web-key', apiKeyEnv: name, enabled: true } });
  assert.equal(secret(store), process.env[name]); assert.equal(store.configurationService.public().webTools.credentialSource, 'environment');
  assert.equal(JSON.stringify(store.get()).includes(process.env[name]), false);
  delete process.env[name]; assert.equal(secret(store), '', 'missing environment variable must not silently use a stored key');
  store.configurationService.update({ webTools: { apiKey: '', apiKeyEnv: '' } });
  assert.equal(secret(store), ''); assert.equal(store.configurationService.public().webTools.credentialSource, 'none');
});

test('invalid web settings are rejected before any config or credential write, including mixed memory changes', t => {
  const file = stateFile(t), store = new Store(file);
  store.configurationService.update({ webTools: { apiKey: 'valid-fixture-key' } });
  const before = readStateText(file), secretsBefore = readFileSync(`${file}.secrets`, 'utf8');
  const invalid = [null, [], { enabled: 'true' }, { timeoutMs: 999 }, { timeoutMs: 120001 }, { timeoutMs: 1000.5 }, { timeoutMs: NaN }, { apiKey: 'key\r\nheader' }, { apiKey: 'x'.repeat(8193) }, { apiKeyEnv: 'HOME;echo' }, { apiKeyEnv: '1invalid' }, { apiKeyConfigured: true }, { unknown: 1 }, ...['https://user:pass@example.test', 'https://example.test?key=secret', 'https://example.test#key', 'ftp://example.test', 'http://127.0.0.1.evil.test', 'http://localhost.evil.test', 'http://example.test'].map(baseUrl => ({ baseUrl }))];
  for (const webTools of invalid) {
    assert.throws(() => store.configurationService.update({ webTools, memory: { limit: 3, apiKey: 'must-not-write' } }));
    assert.equal(readStateText(file), before); assert.equal(readFileSync(`${file}.secrets`, 'utf8'), secretsBefore);
  }
});

test('choosing another search service takes that service\'s address and never carries the saved key or variable name over to it', t => {
  const file = stateFile(t), store = new Store(file), name = 'RNA_WEBTOOLS_PROVIDER_TEST';
  process.env[name] = 'fixture-env-web-key'; t.after(() => delete process.env[name]);
  const catalog = store.configurationService.public().webToolProviders;
  assert.deepEqual(catalog.map(row => row.id), ['fastcrw', 'firecrawl', 'tavily', 'brave', 'zhipu', 'bocha']);
  assert.deepEqual(catalog.find(row => row.id === 'brave'), { id: 'brave', label: 'Brave Search', baseUrl: 'https://api.search.brave.com', key: 'required', reader: 'direct' });
  store.configurationService.update({ webTools: { enabled: true, baseUrl: 'https://crw.example.test', apiKey: 'fixture-fastcrw-key', apiKeyEnv: name } });
  // Same service named again: nothing about it changes.
  assert.equal(store.configurationService.update({ webTools: { provider: 'fastcrw', timeoutMs: 20000 } }).webTools.baseUrl, 'https://crw.example.test');
  assert.equal(secret(store), 'fixture-env-web-key'); assert.equal(store.configurationService.secrets.webTools, 'fixture-fastcrw-key');
  // Another service, nothing else given: its own address, no key, no variable name, the switch stays on.
  const brave = store.configurationService.update({ webTools: { provider: 'brave' } }).webTools;
  assert.deepEqual({ provider: brave.provider, baseUrl: brave.baseUrl, apiKeyEnv: brave.apiKeyEnv, apiKeyConfigured: brave.apiKeyConfigured, credentialSource: brave.credentialSource, enabled: brave.enabled, timeoutMs: brave.timeoutMs },
    { provider: 'brave', baseUrl: 'https://api.search.brave.com', apiKeyEnv: '', apiKeyConfigured: false, credentialSource: 'none', enabled: true, timeoutMs: 20000 });
  assert.equal(store.configurationService.secrets.webTools, undefined); assert.equal(readFileSync(`${file}.secrets`, 'utf8').includes('fixture-fastcrw-key'), false);
  // A key and an address given with the change belong to the new service.
  const tavily = store.configurationService.update({ webTools: { provider: 'tavily', apiKey: 'fixture-tavily-key', baseUrl: 'https://tavily.example.test/' } }).webTools;
  assert.equal(tavily.baseUrl, 'https://tavily.example.test'); assert.equal(secret(store), 'fixture-tavily-key');
  assert.equal(new Store(file).state.configuration.webTools.provider, 'tavily', 'the choice survives a restart');
  // A configuration saved before there was a choice is FastCRW.
  const raw = readStateFile(file).state; delete raw.configuration.webTools.provider; writeFileSync(file, JSON.stringify(raw));
  assert.equal(new Store(file).state.configuration.webTools.provider, 'fastcrw');
  for (const provider of ['google', '', 'Brave', 7, null, ['brave']]) assert.throws(() => store.configurationService.update({ webTools: { provider } }), /受支持的搜索服务/);
  assert.equal(secret(store), 'fixture-tavily-key', 'a refused change writes nothing');
});

test('explicit loopback HTTP and HTTPS paths are supported, valid time bounds and disabled state persist', t => {
  const store = new Store(stateFile(t));
  for (const baseUrl of ['http://127.0.0.1:8899', 'http://localhost:9000/v1', 'http://[::1]:9000', 'https://example.test/api/']) {
    assert.equal(store.configurationService.update({ webTools: { baseUrl, timeoutMs: 1000, enabled: false } }).webTools.baseUrl, baseUrl.replace(/\/$/, ''));
  }
  assert.equal(store.configurationService.update({ webTools: { timeoutMs: 120000, enabled: true } }).webTools.timeoutMs, 120000);
  store.configurationService.update({ webTools: { enabled: false } }); assert.equal(new Store(store.file).state.configuration.webTools.enabled, false);
});

test('HTTP configuration API returns only credential state and invalid requests cannot replace a retained secret', async t => {
  const file = stateFile(t), app = createServer({ stateFile: file, ticks: false, runtime: false });
  await app.initializer.close(); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close()); const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, method = 'GET', body) => { const response = await fetch(`${base}/api${path}`, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() }; };
  const updated = await call('/configuration', 'PATCH', { webTools: { enabled: true, apiKey: 'http-fixture-secret', baseUrl: 'https://web.example.test' } });
  assert.equal(updated.status, 200); assert.equal(updated.body.webTools.apiKeyConfigured, true);
  for (const path of ['/configuration', '/state']) assert.equal(JSON.stringify((await call(path)).body).includes('http-fixture-secret'), false);
  const invalid = await call('/configuration', 'PATCH', { webTools: { enabled: 'false', apiKey: 'replacement-must-not-save' } });
  assert.equal(invalid.status, 400); assert.equal(secret(app.store), 'http-fixture-secret');
  assert.equal(app.store.state.realUsage.tokens, 0);
});
