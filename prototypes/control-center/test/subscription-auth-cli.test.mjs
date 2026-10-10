import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from '../server.mjs';
const exec = promisify(execFile), cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-subscription-cli-'));
  const app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false }); await app.initializer.close();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-cli-account' } })).toString('base64url');
  app.store.configurationService.subscriptionAuth.fetch = async () => new Response(JSON.stringify({ access_token: `eyJhbGciOiJub25lIn0.${payload}.fixture`, refresh_token: 'cli-private-refresh', expires_in: 3600 }));
  const p = app.store.configurationService.provider(null, { presetId: 'openai-codex' });
  const env = { ...process.env, RNA_AGENT_PORT: String(app.server.address().port) };
  const invoke = (...args) => exec(process.execPath, [cli, ...args], { env, timeout: 15000 });
  t.after(async () => { app.server.closeAllConnections(); await app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...app, directory, p, invoke, json: async (...args) => JSON.parse((await invoke(...args)).stdout) };
}
test('HTTP/CLI expose subscription catalog, browser callback, status, cancellation and logout without returning tokens', async t => {
  const f = await fixture(t); const catalog = await f.json('provider-auth', 'catalog'); assert.ok(catalog.some(row => row.id === 'openai-codex' && row.supported));
  assert.equal((await f.json('provider-auth', 'status', f.p.id)).authenticated, false);
  const flow = await f.json('provider-auth', 'start', f.p.id, '--method', 'browser'); assert.equal(flow.state, 'awaiting_authorization');
  const callback = new URL('http://localhost:1455/auth/callback'); callback.searchParams.set('state', new URL(flow.authorizationUrl).searchParams.get('state')); callback.searchParams.set('code', 'isolated-cli-code');
  const callbackFile = join(f.directory, 'callback.txt'); writeFileSync(callbackFile, callback.href, { mode: 0o600 });
  const done = await f.json('provider-auth', 'complete', f.p.id, '--attempt', flow.attemptId, '--callback-file', callbackFile); assert.equal(done.authenticated, true);
  const configuration = await f.json('config'); assert.ok(!JSON.stringify(configuration).includes('cli-private-refresh')); assert.equal(configuration.providers.find(row => row.id === f.p.id).subscription.authenticated, true);
  const logout = await f.json('provider-auth', 'logout', f.p.id); assert.equal(logout.authenticated, false); assert.equal(JSON.parse(readFileSync(`${f.store.file}.subscriptions`))[f.p.id], undefined);
  const next = await f.json('provider-auth', 'start', f.p.id); assert.equal((await f.json('provider-auth', 'cancel', f.p.id, '--attempt', next.attemptId)).loginState, 'cancelled');
});
test('CLI rejects malformed operations, callback on argv and unsupported methods before sending authentication requests', async t => {
  const f = await fixture(t), calls = []; f.server.on('request', req => { if (req.url !== '/api/health') calls.push(req.url); });
  for (const args of [['start', f.p.id, '--method', 'other'], ['complete', f.p.id, '--callback', 'secret-code'], ['logout', '../provider'], ['unexpected', f.p.id]]) await assert.rejects(f.invoke('provider-auth', ...args), error => error.code === 1);
  assert.equal(calls.length, 0);
});
