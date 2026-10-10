import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { MediaToolsService } from '../media-tools-service.mjs';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-media-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, 'ws'); mkdirSync(workspace);
  const store = new Store(join(dir, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Media', protocol: 'openai', baseUrl: 'https://media.example.test/v1', apiKey: 'sk-media', models: [] });
  return { dir, workspace, store, providerId: provider.id ?? provider.provider?.id ?? store.state.configuration.providers.at(-1).id };
}
const fetchFor = calls => async (url, options = {}) => {
  calls.push({ url, headers: options.headers, body: options.body });
  if (url.endsWith('/images/generations')) return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: 'hello' }), { headers: { 'content-type': 'application/json' } });
  return new Response('no', { status: 404 });
};

test('media choices validate against configured providers and are dropped with their provider', t => {
  const { store, providerId } = setup(t);
  assert.throws(() => store.configurationService.update({ media: { image: { providerId: 'missing', modelId: 'x' } } }), /已配置的提供商/);
  assert.throws(() => store.configurationService.update({ media: { video: { providerId, modelId: 'sora-2' } } }), /视频接口/);
  assert.throws(() => store.configurationService.update({ media: { music: { providerId, modelId: 'x' } } }), /未知/);
  const config = store.configurationService.update({ media: { image: { providerId, modelId: 'gpt-image-1', editApi: 'openai' }, video: { providerId, modelId: 'sora-2', api: 'openai' }, speech: null } });
  assert.deepEqual(config.media, { image: { providerId, modelId: 'gpt-image-1', editApi: 'openai' }, video: { providerId, modelId: 'sora-2', api: 'openai' } });
  assert.equal(JSON.stringify(config.media).includes('sk-media'), false);
  store.configurationService.provider(providerId, null, true);
  assert.deepEqual(store.configurationService.public().media, {});
});

test('tools exist only for configured kinds; outputs are saved inside the project without overwriting', async t => {
  const { store, workspace, providerId } = setup(t), calls = [];
  const service = new MediaToolsService(store, { fetchImpl: fetchFor(calls) }), project = { id: 'p', workspace };
  assert.deepEqual(service.createTools(project), []);
  store.configurationService.update({ media: { image: { providerId, modelId: 'img' }, transcription: { providerId, modelId: 'whisper-1' } } });
  const tools = Object.fromEntries(service.createTools(project).map(tool => [tool.name, tool]));
  assert.deepEqual(Object.keys(tools).sort(), ['audio_transcribe', 'image_generate']);
  assert.equal(JSON.stringify(Object.values(tools).map(({ execute, ...rest }) => rest)).includes('sk-media'), false);
  const first = await tools.image_generate.execute('c1', { prompt: 'logo', path: 'assets/logo.png' });
  assert.equal(first.isError, undefined);
  assert.deepEqual(first.details.files.map(file => file.path), ['assets/logo.png']);
  assert.match(first.content[0].text, /^Generated 1 image: assets\/logo\.png \(img\)$/, 'the model reads the result in fixed English');
  assert.deepEqual(readFileSync(join(workspace, 'assets/logo.png')), PNG);
  assert.equal(first.content[1].type, 'image');
  assert.equal(calls[0].headers.authorization, 'Bearer sk-media');
  const again = await tools.image_generate.execute('c2', { prompt: 'logo', path: 'assets/logo.png' });
  assert.equal(again.isError, true); assert.match(again.content[0].text, /已存在/);
  const escape = await tools.image_generate.execute('c3', { prompt: 'x', path: '../outside.png' });
  assert.equal(escape.isError, true); assert.equal(calls.length, 2, 'an invalid output path fails before the billed call');
  const secret = await tools.image_generate.execute('c4', { prompt: 'x', path: '.env.png' });
  assert.equal(secret.details.code, 'MEDIA_PATH');
  symlinkSync(tmpdir(), join(workspace, 'link'));
  const linked = await tools.image_generate.execute('c5', { prompt: 'x', path: 'link/out.png' });
  assert.equal(linked.isError, true); assert.equal(existsSync(join(tmpdir(), 'out.png')), false);
  writeFileSync(join(workspace, 'note.mp3'), Buffer.from('ID3aaaa'));
  const heard = await tools.audio_transcribe.execute('c6', { path: 'note.mp3', language: 'en' });
  assert.equal(heard.content[0].text, 'hello');
  const unsupported = await tools.audio_transcribe.execute('c7', { path: 'assets/logo.png' });
  assert.equal(unsupported.isError, true);
});

test('a ChatGPT login serves image generation and speech recognition, and nothing else', async t => {
  // Live, 2026-10-03: the Pro plan includes image and voice use, but subscription providers were refused for every media kind.
  const { store, workspace } = setup(t), calls = [];
  const jwt = account => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.fixture`;
  const auth = store.configurationService.subscriptionAuth; t.after(() => auth.close());
  auth.fetch = async () => new Response(JSON.stringify({ access_token: jwt('media-account'), refresh_token: 'fixture-refresh', expires_in: 3600 }), { status: 200 });
  const provider = store.configurationService.provider(null, { presetId: 'openai-codex' });
  const flow = await auth.start(provider.id), url = new URL(flow.authorizationUrl), callback = new URL('http://localhost:1455/auth/callback');
  callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('code', 'fixture-code');
  await auth.complete(provider.id, { attemptId: flow.attemptId, callbackUrl: callback.href });

  const offered = store.configurationService.public().providers.find(row => row.id === provider.id).subscriptionMedia;
  // Live, 2026-10-10: only gpt-image-2 was offered, and whichever model was chosen the request said gpt-image-2.
  assert.deepEqual(offered, { image: ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'], transcription: ['chatgpt-transcribe'] });
  assert.throws(() => store.configurationService.update({ media: { speech: { providerId: provider.id, modelId: 'gpt-4o-mini-tts' } } }), /语音合成或视频生成/);
  assert.throws(() => store.configurationService.update({ media: { video: { providerId: provider.id, modelId: 'sora-2', api: 'openai' } } }), /语音合成或视频生成/);
  assert.throws(() => store.configurationService.update({ media: { image: { providerId: provider.id, modelId: 'dall-e-3' } } }), /gpt-image-2/);
  const config = store.configurationService.update({ media: { image: { providerId: provider.id, modelId: 'gpt-image-2.5-sunburst', editApi: 'openai' }, transcription: { providerId: provider.id, modelId: 'chatgpt-transcribe' } } });
  assert.deepEqual(config.media, { image: { providerId: provider.id, modelId: 'gpt-image-2.5-sunburst' }, transcription: { providerId: provider.id, modelId: 'chatgpt-transcribe' } });

  let images = 0;
  const service = new MediaToolsService(store, { fetchImpl: async (target, options = {}) => {
    calls.push({ url: target, headers: options.headers, body: options.body });
    if (target.endsWith('/codex/images/generations')) return ++images === 3 ? new Response('{"detail":"Rate limit reached for images"}', { status: 429 }) : new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
    if (target.endsWith('/transcribe')) return new Response(JSON.stringify({ text: '会议纪要' }));
    return new Response('no', { status: 404 });
  } }), project = { id: 'p', workspace };
  const tools = Object.fromEntries(service.createTools(project).map(tool => [tool.name, tool]));
  assert.deepEqual(Object.keys(tools).sort(), ['audio_transcribe', 'image_generate']);
  // One image per call on this route; images made before a later call fails are kept and reported.
  const made = await tools.image_generate.execute('c1', { prompt: 'logo', count: 3, path: 'art/logo.png' });
  assert.equal(made.isError, undefined); assert.deepEqual(made.details.files.map(file => file.path), ['art/logo.png', 'art/logo-2.png']);
  assert.match(made.content[0].text, /The other 1 not generated: .*Rate limit reached/);
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/images/generations'); assert.equal(calls[0].headers['chatgpt-account-id'], 'media-account');
  assert.equal(JSON.parse(calls[0].body).model, 'gpt-image-2.5-sunburst'); assert.match(made.content[0].text, /\(gpt-image-2\.5-sunburst\)/);
  writeFileSync(join(workspace, 'memo.m4a'), Buffer.from('....ftypM4A '));
  const heard = await tools.audio_transcribe.execute('c2', { path: 'memo.m4a' });
  assert.equal(heard.content[0].text, '会议纪要'); assert.equal(calls.at(-1).url, 'https://chatgpt.com/backend-api/transcribe');
  for (const call of calls) assert.ok(!JSON.stringify(call.body ?? '').includes('fixture-refresh'));
});
