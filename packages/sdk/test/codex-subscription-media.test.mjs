import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_CLIENT_VERSION_FLOOR, codexClientVersion, laterVersion, refreshCodexClientVersion, resetCodexClientVersion } from '../src/codex-client.mjs';
import { buildRequest } from '../src/providers.mjs';
import { generateSubscriptionImage, transcribeSubscriptionAudio, MediaModelError } from '../src/media-models.mjs';

// The ChatGPT backend lists only models whose minimal_client_version the presented Codex version meets (live,
// 2026-10-03: a pinned 0.153.0 hid gpt-6-sol, gpt-6-luna and gpt-6.1-sol). No network here: fetch is faked.
const registry = versions => { const asked = []; return { asked, fetch: async url => { asked.push(url); const version = versions[url]; return version instanceof Error ? Promise.reject(version) : new Response(JSON.stringify({ version }), { status: version ? 200 : 404 }); } }; };
const NPM = 'https://registry.npmjs.org/@openai/codex/latest', MIRROR = 'https://registry.npmmirror.com/@openai/codex/latest';

test('the Codex version follows the current release, never drops below the floor, and is reused for hours', async t => {
  t.after(resetCodexClientVersion);
  assert.equal(laterVersion('0.160.0', '0.159.3'), '0.160.0'); assert.equal(laterVersion('0.160.0', '0.161.0'), '0.161.0'); assert.equal(laterVersion('0.160.0', '0.162.0-alpha.7'), '0.160.0'); assert.equal(laterVersion('0.9.0', '0.10.0'), '0.10.0');
  resetCodexClientVersion(); assert.equal(codexClientVersion(), CODEX_CLIENT_VERSION_FLOOR);
  let clock = 0; const now = () => clock;
  const first = registry({ [NPM]: '0.163.1', [MIRROR]: '0.163.0' });
  assert.equal(await refreshCodexClientVersion({ fetch: first.fetch, now }), '0.163.1'); assert.equal(codexClientVersion(), '0.163.1');
  clock += 3600000; const cached = registry({ [NPM]: '0.170.0' });
  assert.equal(await refreshCodexClientVersion({ fetch: cached.fetch, now }), '0.163.1'); assert.equal(cached.asked.length, 0, 'within six hours nothing is asked');
  // An older or broken answer never moves the version back; a failed check keeps the last known one.
  clock += 6 * 3600000;
  assert.equal(await refreshCodexClientVersion({ fetch: registry({ [NPM]: '0.150.0', [MIRROR]: 'latest' }).fetch, now }), '0.163.1');
  resetCodexClientVersion();
  assert.equal(await refreshCodexClientVersion({ fetch: registry({ [NPM]: new Error('offline'), [MIRROR]: new Error('offline') }).fetch, now }), CODEX_CLIENT_VERSION_FLOOR);
  // Either source is enough (the mirror answers where the registry is slow).
  resetCodexClientVersion();
  assert.equal(await refreshCodexClientVersion({ fetch: registry({ [NPM]: new Error('timeout'), [MIRROR]: '0.161.2' }).fetch, now }), '0.161.2');
});

test('Codex requests carry the Codex version they speak', t => {
  t.after(resetCodexClientVersion);
  const model = { providerId: 'codex', protocol: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', modelId: 'gpt-6.1-sol', contextWindow: 272000, maxOutputTokens: 8192, reasoning: 'default' };
  assert.equal(buildRequest({ model, messages: [{ role: 'user', content: 'hi' }] }).headers.version, CODEX_CLIENT_VERSION_FLOOR);
});

test('a ChatGPT login generates images and transcribes audio through the routes Codex uses, refreshing a rejected token once', async () => {
  const credentials = [];
  const credential = async options => { credentials.push(options?.forceRefresh === true); return { provider: 'openai-codex', accessToken: `token-${credentials.length}`, refreshToken: 'fake-refresh', accountId: 'account-1', expiresAt: Date.now() + 3600000 }; };
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return new Response('{"detail":"expired"}', { status: 401 });
    if (url.endsWith('/transcribe')) return new Response(JSON.stringify({ text: '  你好，世界 ' }), { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64'), revised_prompt: 'a red apple' }] }), { headers: { 'content-type': 'application/json' } });
  };
  const image = await generateSubscriptionImage({ credential, prompt: 'an apple', size: '1024x1024', fetchImpl });
  assert.deepEqual(credentials, [false, true], 'a 401 refreshes the login once');
  assert.equal(calls[1].url, 'https://chatgpt.com/backend-api/codex/images/generations');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer token-2'); assert.equal(calls[1].init.headers['chatgpt-account-id'], 'account-1'); assert.equal(calls[1].init.headers.version, codexClientVersion()); assert.equal(calls[1].init.redirect, 'manual');
  assert.deepEqual(JSON.parse(calls[1].init.body), { model: 'gpt-image-2', prompt: 'an apple', size: '1024x1024' });
  assert.equal(image.mimeType, 'image/png'); assert.deepEqual(image.bytes, png); assert.equal(image.revisedPrompt, 'a red apple');

  await generateSubscriptionImage({ credential, prompt: 'make it green', images: [{ bytes: png, mimeType: 'image/png' }], fetchImpl });
  assert.equal(calls.at(-1).url, 'https://chatgpt.com/backend-api/codex/images/edits');
  assert.deepEqual(JSON.parse(calls.at(-1).init.body).images, [{ image_url: `data:image/png;base64,${png.toString('base64')}` }]);
  await assert.rejects(generateSubscriptionImage({ credential, prompt: 'x', images: Array(6).fill({ bytes: png, mimeType: 'image/png' }), fetchImpl }), error => error instanceof MediaModelError && error.code === 'media_invalid_configuration');

  const heard = await transcribeSubscriptionAudio({ credential, audio: { bytes: Buffer.from('RIFF0000WAVEfmt '), mimeType: 'audio/wav' }, filename: 'note.wav', language: 'zh', fetchImpl });
  assert.equal(heard.text, '你好，世界');
  const sent = calls.at(-1);
  assert.equal(sent.url, 'https://chatgpt.com/backend-api/transcribe'); assert.ok(sent.init.body instanceof FormData);
  assert.equal(sent.init.body.get('file').name, 'note.wav'); assert.equal(sent.init.body.get('language'), 'zh'); assert.equal(sent.init.body.get('model'), null, 'ChatGPT chooses the speech model');

  // No login, or an answer without an image, is a plain media error the agent can read.
  await assert.rejects(generateSubscriptionImage({ credential: async () => ({}), prompt: 'x', fetchImpl }), { code: 'media_auth' });
  await assert.rejects(generateSubscriptionImage({ credential, prompt: 'x', fetchImpl: async () => new Response('{"data":[]}') }), { code: 'media_bad_response' });
  await assert.rejects(generateSubscriptionImage({ credential, prompt: 'x', fetchImpl: async () => new Response('{"detail":"Image generation is not available on your plan"}', { status: 403 }) }), error => error.code === 'media_auth' && /not available on your plan/.test(error.message));
});
