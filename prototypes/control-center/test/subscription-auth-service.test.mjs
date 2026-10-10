import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { resolveModel } from '../configuration.mjs';

const jwt = (account, suffix = '') => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.fixture${suffix}`;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-subscription-host-')), file = join(dir, 'state.json'), store = new Store(file), service = store.configurationService, auth = service.subscriptionAuth, calls = [];
  auth.fetch = async (url, options) => { calls.push({ url, body: String(options.body) }); return new Response(JSON.stringify({ access_token: jwt('fixture-account', String(calls.length)), refresh_token: `fixture-refresh-${calls.length}`, expires_in: 3600 }), { status: 200 }); };
  const provider = service.provider(null, { presetId: 'openai-codex' });
  t.after(() => { auth.close(); rmSync(dir, { recursive: true, force: true }); });
  async function login(id = provider.id) { const flow = await auth.start(id); const u = new URL(flow.authorizationUrl), callback = new URL('http://localhost:1455/auth/callback'); callback.searchParams.set('state', u.searchParams.get('state')); callback.searchParams.set('code', 'fixture-code'); return auth.complete(id, { attemptId: flow.attemptId, callbackUrl: callback.href }); }
  return { dir, file, store, service, auth, provider, calls, login };
}
test('subscription credentials persist privately with 0600 while public state, model snapshots and flow omit tokens', async t => {
  const f = fixture(t); assert.equal(f.provider.authMode, 'subscription'); assert.equal(f.provider.models.length, 0);
  const done = await f.login(); assert.equal(done.authenticated, true); assert.equal(done.loginState, 'complete');
  const raw = JSON.parse(readFileSync(`${f.file}.subscriptions`, 'utf8')), secret = raw[f.provider.id].credential;
  assert.equal(statSync(`${f.file}.subscriptions`).mode & 0o777, 0o600);
  assert.equal(typeof f.service.secret(f.provider.id, f.provider), 'function');
  for (const publicValue of [f.store.get(), f.service.public(), f.auth.status(f.provider.id), readFileSync(f.file, 'utf8')]) for (const token of [secret.accessToken, secret.refreshToken]) assert.ok(!JSON.stringify(publicValue).includes(token));
  const reopened = new Store(f.file); t.after(() => reopened.configurationService.subscriptionAuth.close()); assert.equal(reopened.configurationService.public().providers.find(p => p.id === f.provider.id).subscription.authenticated, true);
  assert.equal((await reopened.configurationService.secret(f.provider.id, f.provider)()).accountId, 'fixture-account');
});
test('refresh is singleflight, keeps evidence identity, and a new login rotates it without putting token in models', async t => {
  const f = fixture(t); await f.login(); const revision = f.service.credentialRevision(f.provider.id);
  f.auth.records[f.provider.id].credential.expiresAt = 1;
  const [a,b] = await Promise.all([f.auth.resolve(f.provider.id), f.auth.resolve(f.provider.id)]); assert.equal(a.accessToken, b.accessToken); assert.equal(f.calls.length, 2); assert.equal(f.service.credentialRevision(f.provider.id), revision);
  await f.login(); assert.notEqual(f.service.credentialRevision(f.provider.id), revision);
  f.service.provider(f.provider.id, { models: [{ id: 'account-model', contextWindow: 272000, maxOutputTokens: 8192, reasoning: ['high'] }] });
  const model = resolveModel(f.store.state.configuration, { providerId: f.provider.id, modelId: 'account-model' }); assert.equal(model.subscriptionProvider, 'openai-codex'); assert.ok(!JSON.stringify(model).includes('fixture-account'));
});
test('logout during credential refresh prevents late completion from restoring a signed-out account', async t => {
  const f = fixture(t); await f.login(); f.auth.records[f.provider.id].credential.expiresAt = 1; const manager = f.auth.manager(f.provider.id), originalFetch = f.auth.fetch;
  // The manager has its own injected fetch; gate it via a second configured account.
  f.auth.forget(f.provider.id); let release; f.auth.fetch = (url, options) => new Promise(resolve => { release = () => originalFetch(url, options).then(resolve); });
  const credential = { provider: 'openai-codex', accessToken: jwt('fixture-account'), refreshToken: 'fixture-old-refresh', expiresAt: 1, accountId: 'fixture-account' };
  f.auth.write({ [f.provider.id]: { credential, revision: 'rev', authorizedAt: 1 } });
  const pending = f.auth.resolve(f.provider.id); await new Promise(resolve => setImmediate(resolve)); assert.equal(typeof release, 'function');
  await f.auth.logout(f.provider.id); release(); await assert.rejects(pending); assert.equal(f.auth.status(f.provider.id).authenticated, false); assert.equal(f.auth.records[f.provider.id], undefined);
});
test('cancel validates flow identity and subscription endpoints cannot be redirected to a custom server', async t => {
  const f = fixture(t), flow = await f.auth.start(f.provider.id);
  assert.throws(() => f.auth.cancel(f.provider.id, { attemptId: 'another-flow' }), /变化/);
  assert.equal(f.auth.cancel(f.provider.id, { attemptId: flow.attemptId }).loginState, 'cancelled');
  const before = readFileSync(f.file, 'utf8');
  assert.throws(() => f.service.provider(f.provider.id, { baseUrl: 'https://attacker.test/backend-api' }), /固定地址/);
  assert.throws(() => f.service.provider(f.provider.id, { apiKey: 'not-oauth' }), /不使用/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  await assert.rejects(f.auth.complete(f.provider.id, { attemptId: flow.attemptId, callbackUrl: 'http://localhost:1455/auth/callback?code=old' }), /结束/);
});
test('account model discovery uses actual context, unknown output stays unknown, and no API model capacity is borrowed', async t => {
  const f = fixture(t); await f.login(); const requests = [];
  f.service.catalogRequest = async (url, options) => { requests.push({ url, options }); return { models: [{ slug: 'gpt-5.4', display_name: 'Account GPT', context_window: 272000, supported_reasoning_levels: [{ effort: 'high' }], default_reasoning_level: 'high', input_modalities: ['text','image'] }, { slug: 'unknown-capacity', supported_reasoning_levels: [{ effort: 'high' }] }] }; };
  const result = await f.service.refreshModels(f.provider.id); assert.deepEqual(result.added, ['gpt-5.4']); assert.equal(result.skipped.length, 1);
  const model = result.provider.models[0]; assert.equal(model.contextWindow, 272000); assert.equal(model.modelMaxOutputTokens, null); assert.equal(model.maxOutputTokens, 8192);
  assert.match(requests[0].url, /^https:\/\/chatgpt\.com\/backend-api\/codex\/models\?client_version=/); assert.equal(requests[0].options.headers.originator, 'rna-agent'); assert.ok(!JSON.stringify(result).includes('fixture-refresh'));
});
test('account catalog distinguishes explicit vision and text-only from absent input metadata', async t => {
  const f = fixture(t); await f.login();
  f.service.catalogRequest = async () => ({ models: ['image', 'text', 'unknown'].map(kind => ({ slug: `account-${kind}`, context_window: 64000, supported_reasoning_levels: [{ effort: 'high' }], ...(kind === 'unknown' ? {} : { input_modalities: kind === 'image' ? ['text', 'image'] : ['text'] }) })) });
  const result = await f.service.refreshModels(f.provider.id);
  const rows = result.provider.models;
  assert.deepEqual(rows[0].input, ['text', 'image']); assert.deepEqual(rows[1].input, ['text']); assert.equal(rows[2].input, undefined);
  assert.equal(rows[0].inputCapability.source, 'provider'); assert.equal(rows[1].inputCapability.status, 'known'); assert.equal(rows[2].inputCapability.status, 'unknown');
  assert.match(rows[0].inputCapability.sourceUrl, /^https:\/\/chatgpt\.com\/backend-api\/codex\/models/);
  for (const row of rows) assert.deepEqual(resolveModel(f.store.state.configuration, { providerId: f.provider.id, modelId: row.id }).input, row.input);
});
for (const action of ['test', 'refreshModels']) test(`${action}: a superseded subscription login cannot publish reusable input capability evidence`, async t => {
  const f = fixture(t); await f.login();
  let arrived, release;
  const ready = new Promise(resolve => { arrived = resolve; });
  f.service.catalogRequest = async () => { arrived(); return new Promise(resolve => { release = () => resolve({ models: [{ slug: 'account-vision', context_window: 64000, supported_reasoning_levels: [{ effort: 'high' }], input_modalities: ['text', 'image'] }] }); }); };
  const revision = f.service.credentialRevision(f.provider.id), pending = f.service[action](f.provider.id); await ready;
  await f.login(); assert.notEqual(f.service.credentialRevision(f.provider.id), revision); release();
  await assert.rejects(pending, error => error.status === 409);
  const saved = f.service.provider(f.provider.id, { models: [{ id: 'account-vision', contextWindow: 64000, maxOutputTokens: 1000, reasoning: ['high'] }] });
  assert.equal(saved.models[0].input, undefined); assert.equal(saved.models[0].inputCapability.status, 'unknown');
  assert.equal(resolveModel(f.store.state.configuration, { providerId: f.provider.id, modelId: 'account-vision' }).input, undefined);
});
test('Kimi coding mode projects interactive-only even under API mode; ordinary Kimi API remains unrestricted', t => {
  const f = fixture(t), p = f.service.provider(null, { presetId: 'kimi-coding', apiKey: 'fixture-plan-key' });
  const selection = { providerId: p.id, modelId: 'k3-256k', reasoning: 'high' };
  assert.equal(p.authMode, 'coding_plan'); assert.equal(resolveModel(f.store.state.configuration, selection).usagePolicy, 'interactive_only');
  f.service.provider(p.id, { authMode: 'api_key', usagePolicy: 'unrestricted' }); assert.equal(resolveModel(f.store.state.configuration, selection).usagePolicy, 'interactive_only');
  const api = f.service.provider(null, { presetId: 'kimi-cn' }); assert.equal(resolveModel(f.store.state.configuration, { providerId: api.id, modelId: 'kimi-k3' }).usagePolicy, undefined);
});
test('untrusted or malformed subscription credential files fail closed and deleting a provider erases its private credential', async t => {
  const f = fixture(t); await f.login(); f.service.provider(f.provider.id, {}, true); assert.equal(JSON.parse(readFileSync(`${f.file}.subscriptions`, 'utf8'))[f.provider.id], undefined);
  writeFileSync(`${f.file}.subscriptions`, '{bad'); assert.throws(() => new Store(f.file), /安全读取/);
  rmSync(`${f.file}.subscriptions`); const target = join(f.dir, 'other'); writeFileSync(target, '{}'); symlinkSync(target, `${f.file}.subscriptions`); assert.throws(() => new Store(f.file), /安全读取/);
});
