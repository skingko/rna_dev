import test from 'node:test';
import assert from 'node:assert/strict';
import { SubscriptionAuthManager, SUBSCRIPTION_PROVIDERS } from '../src/subscription-auth.mjs';

const jwt = account => `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.signature`;
const token = (account = 'test-account') => ({ access_token: jwt(account), refresh_token: 'fake-refresh-do-not-use', expires_in: 3600 });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
function harness(fetcher, extra = {}) {
  const state = { saved: null, writes: [], changes: [] };
  const manager = new SubscriptionAuthManager({ readCredential: () => state.saved, writeCredential: (_provider, value, meta) => { state.saved = value; state.writes.push({ value, meta }); }, fetch: fetcher, onChange: flow => state.changes.push(flow), ...extra });
  return { state, manager };
}

test('OpenAI browser login uses PKCE, validates full callback state, persists credentials only privately', async t => {
  const requests = [], { manager, state } = harness(async (url, init) => { requests.push({ url, init }); return response(token()); }); t.after(() => manager.close());
  const flow = await manager.begin('openai-codex'), authUrl = new URL(flow.url);
  assert.equal(authUrl.origin, 'https://auth.openai.com'); assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256'); assert.equal(authUrl.searchParams.get('originator'), 'rna-agent');
  assert.equal(JSON.stringify(flow).includes('verifier'), false);
  await assert.rejects(manager.complete(flow.flowId, { callbackUrl: 'http://localhost:1455/auth/callback?code=secret&state=wrong' }), { code: 'invalid_callback' });
  await assert.rejects(manager.complete(flow.flowId, { callbackUrl: `https://evil.test/auth/callback?code=secret&state=${authUrl.searchParams.get('state')}` }), { code: 'invalid_callback' });
  assert.equal(requests.length, 0);
  const done = await manager.complete(flow.flowId, { callbackUrl: `http://localhost:1455/auth/callback?code=fake-code&state=${authUrl.searchParams.get('state')}` });
  assert.equal(done.status, 'complete'); assert.equal(done.url, undefined); assert.equal(state.saved.accountId, 'test-account'); assert.equal(state.writes[0].meta.operation, 'login');
  assert.equal(requests[0].init.redirect, 'manual'); assert.equal(requests[0].init.body.get('code_verifier').length, 43);
  assert.equal(requests[0].init.body.get('grant_type'), 'authorization_code');
  assert.equal(JSON.stringify(state.changes).includes('fake-refresh'), false); assert.equal(JSON.stringify(state.changes).includes('accessToken'), false);
});

test('device login handles pending and slow_down, then exchanges authorization code', async t => {
  let calls = 0; const sleeps = [], requests = [];
  const { manager, state } = harness(async (url, init) => { requests.push({ url, body: init.body }); calls++; if (calls === 1) return response({ device_auth_id: 'device-secret', user_code: 'PUBLIC-CODE', interval: '1' }); if (calls === 2) return response({ error: 'authorization_pending' }, 403); if (calls === 3) return response({ error: 'slow_down' }, 400); if (calls === 4) return response({ authorization_code: 'fake-code', code_verifier: 'fake-verifier' }); return response(token()); }, { sleep: async ms => { sleeps.push(ms); } }); t.after(() => manager.close());
  const flow = await manager.begin('openai-codex', { method: 'device_code' }); assert.equal(flow.verificationUri, 'https://auth.openai.com/codex/device'); assert.equal(flow.userCode, 'PUBLIC-CODE'); assert.equal(JSON.stringify(flow).includes('device-secret'), false);
  await settle(); assert.equal(manager.flow(flow.flowId).status, 'complete'); assert.equal(state.saved.accountId, 'test-account'); assert.deepEqual(sleeps, [1000, 1000, 6000]);
  assert.equal(requests.at(-1).body.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
});

test('cancelled device login ignores late service credentials and clears public one-time code', async t => {
  let release; const wait = new Promise(resolve => { release = resolve; });
  const { manager, state } = harness(async url => url.endsWith('/usercode') ? response({ device_auth_id: 'device-secret', user_code: 'PUBLIC-CODE', interval: 1 }) : await wait, { sleep: async () => {} }); t.after(() => manager.close());
  const flow = await manager.begin('openai-codex', { method: 'device_code' }); manager.cancel(flow.flowId); release(response({ authorization_code: 'code', code_verifier: 'verifier' })); await settle();
  assert.equal(manager.flow(flow.flowId).status, 'cancelled'); assert.equal(manager.flow(flow.flowId).userCode, undefined); assert.equal(state.saved, null);
});

test('token refresh is single-flight, keeps rotated refresh token, and does not expose upstream error payloads', async t => {
  let calls = 0; const { manager, state } = harness(async () => { calls++; await settle(); return response({ ...token(), refresh_token: 'rotated-secret' }); }); t.after(() => manager.close());
  state.saved = { provider: 'openai-codex', accessToken: jwt('test-account'), refreshToken: 'old-secret', expiresAt: 1 };
  const values = await Promise.all(Array.from({ length: 8 }, () => manager.credential('openai-codex')));
  assert.equal(calls, 1); assert.equal(values[0].refreshToken, 'rotated-secret'); assert.equal(state.writes[0].meta.operation, 'refresh');
  values[0].accessToken = 'tampered'; assert.notEqual(state.saved.accessToken, 'tampered');
});

test('revoked refresh clears credentials, transient errors keep them, logout prevents late refresh resurrection', async t => {
  let mode = 'transient', release; const wait = new Promise(resolve => { release = resolve; });
  const { manager, state } = harness(async () => mode === 'transient' ? response({ error: 'upstream secret old-secret' }, 503) : mode === 'revoked' ? response({ error: 'invalid_grant', access_token: 'do-not-log' }, 400) : await wait); t.after(() => manager.close());
  const saved = { provider: 'openai-codex', accessToken: jwt('test-account'), refreshToken: 'old-secret', expiresAt: 1 }; state.saved = saved;
  await assert.rejects(manager.credential('openai-codex'), error => error.code === 'http_error' && !error.message.includes('old-secret')); assert.equal(state.saved, saved);
  mode = 'revoked'; await assert.rejects(manager.credential('openai-codex'), { code: 'reauth_required' }); assert.equal(state.saved, null); assert.equal(state.writes.at(-1).meta.operation, 'invalidated');
  state.saved = saved; mode = 'late'; const refreshing = manager.credential('openai-codex'); await settle(); await manager.logout('openai-codex'); release(response(token())); await assert.rejects(refreshing, { code: 'aborted' }); assert.equal(state.saved, null);
});

test('one caller cancellation does not abort refresh required by another caller', async t => {
  let release; const wait = new Promise(resolve => { release = resolve; }); const { manager, state } = harness(async () => await wait); t.after(() => manager.close());
  state.saved = { provider: 'openai-codex', accessToken: jwt('test-account'), refreshToken: 'old-secret', expiresAt: 1 };
  const controller = new AbortController(), first = manager.credential('openai-codex', { signal: controller.signal }), second = manager.credential('openai-codex'); await settle(); controller.abort(); await assert.rejects(first, { code: 'aborted' }); release(response(token())); assert.equal((await second).accountId, 'test-account');
});

test('unsupported subscription OAuth is not offered as a working login mode', async t => {
  const { manager } = harness(() => { throw new Error('should not call'); }); t.after(() => manager.close());
  for (const provider of ['anthropic', 'kimi-coding', 'zhipu-coding']) await assert.rejects(manager.begin(provider), { code: 'unsupported_auth' });
  assert.deepEqual(SUBSCRIPTION_PROVIDERS.find(p => p.id === 'kimi-coding').methods, ['coding_plan_key']);
  assert.equal(SUBSCRIPTION_PROVIDERS.find(p => p.id === 'anthropic').subscriptionStatus, 'official_client_only');
});

test('expired browser callback, redirects and oversized authentication payloads never persist credentials', async t => {
  let clock = Date.now(), calls = 0; const { manager, state } = harness(async () => { calls++; return response(token()); }, { now: () => clock }); t.after(() => manager.close());
  const flow = await manager.begin('openai-codex'); const stateParam = new URL(flow.url).searchParams.get('state'); clock = flow.expiresAt + 1;
  await assert.rejects(manager.complete(flow.flowId, { callbackUrl: `http://localhost:1455/auth/callback?code=code&state=${stateParam}` }), { code: 'expired_token' }); assert.equal(calls, 0); assert.equal(state.saved, null);
  for (const [payload, expected] of [[new Response('redirect secret', { status: 302, headers: { location: 'https://evil.test' } }), 'redirect_rejected'], [new Response('x'.repeat(140000)), 'invalid_response']]) {
    const other = harness(async () => payload); t.after(() => other.manager.close()); await assert.rejects(other.manager.begin('openai-codex', { method: 'device_code' }), error => error.code === expected && !error.message.includes('secret')); assert.equal(other.state.saved, null);
  }
});

test('refresh does not silently replace the account behind an existing subscription', async t => {
  const { manager, state } = harness(async () => response(token('different-account'))); t.after(() => manager.close()); state.saved = { provider: 'openai-codex', accountId: 'original-account', accessToken: jwt('original-account'), refreshToken: 'old', expiresAt: 1 };
  await assert.rejects(manager.credential('openai-codex'), { code: 'reauth_required' }); assert.equal(state.saved, null);
});

test('logout waits for an in-flight asynchronous refresh write and remains the final credential commit', async t => {
  let saved = { provider: 'openai-codex', accountId: 'original', accessToken: jwt('original'), refreshToken: 'old', expiresAt: 1 }, release, started;
  const writeStarted = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; }), operations = [];
  const manager = new SubscriptionAuthManager({ readCredential: () => saved, fetch: async () => response(token('original')), writeCredential: async (_provider, value, meta) => { operations.push(meta.operation); if (meta.operation === 'refresh') { started(); await gate; } saved = value; } }); t.after(() => manager.close());
  const refreshing = manager.credential('openai-codex'); const rejected = assert.rejects(refreshing, { code: 'aborted' }); await writeStarted;
  let logoutFinished = false; const loggingOut = manager.logout('openai-codex').then(() => { logoutFinished = true; }); await settle(); assert.equal(logoutFinished, false); release(); await rejected; await loggingOut;
  assert.deepEqual(operations, ['refresh', 'rollback', 'logout']); assert.equal(saved, null); await assert.rejects(manager.credential('openai-codex'), { code: 'reauth_required' });
});

test('cancelling during an asynchronous login commit restores the previous account rather than accepting the late credential', async t => {
  const previous = { provider: 'openai-codex', accountId: 'existing', accessToken: jwt('existing'), refreshToken: 'existing-refresh', expiresAt: Date.now() + 3600000 };
  let saved = previous, release, started; const writeStarted = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const manager = new SubscriptionAuthManager({ readCredential: () => saved, fetch: async () => response(token('new')), writeCredential: async (_provider, value, meta) => { if (meta.operation === 'login') { started(); await gate; } saved = value; } }); t.after(() => manager.close());
  const flow = await manager.begin('openai-codex'); const exchange = manager.complete(flow.flowId, { callbackUrl: `http://localhost:1455/auth/callback?code=code&state=${new URL(flow.url).searchParams.get('state')}` }); const rejected = assert.rejects(exchange, { code: 'aborted' }); await writeStarted;
  manager.cancel(flow.flowId); release(); await rejected; assert.equal(manager.flow(flow.flowId).status, 'cancelled'); assert.equal(saved, previous);
});

test('closing the manager cancels shared refresh and cannot persist a late credential', async () => {
  const saved = { provider: 'openai-codex', accountId: 'existing', accessToken: jwt('existing'), refreshToken: 'existing', expiresAt: 1 }; let writes = 0, started; const dispatch = new Promise(resolve => { started = resolve; });
  const manager = new SubscriptionAuthManager({ readCredential: () => saved, writeCredential: () => { writes++; }, fetch: async () => { started(); return new Promise(() => {}); } });
  const refreshing = manager.credential('openai-codex'); const rejected = assert.rejects(refreshing, { code: 'aborted' }); await dispatch; manager.close(); await rejected; assert.equal(writes, 0); await assert.rejects(manager.begin('openai-codex'), { code: 'auth_closed' });
});
