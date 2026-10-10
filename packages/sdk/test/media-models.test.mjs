import test from 'node:test';
import assert from 'node:assert/strict';
import { generateImage, synthesizeSpeech, transcribeAudio, generateVideo, MediaModelError } from '../src/media-models.mjs';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(16)]);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fake(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', headers: options.headers ?? {}, body: options.body });
    for (const [pattern, handler] of routes) if (pattern.test(`${options.method ?? 'GET'} ${url}`)) return handler(url, options, calls);
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls };
}

test('image generation reads b64_json or downloads result URLs without sending the key', async () => {
  const { fetchImpl, calls } = fake([
    [/POST https:\/\/api\.test\/v1\/images\/generations/, () => json({ data: [{ b64_json: PNG.toString('base64'), revised_prompt: 'a cat, watercolor' }, { url: 'https://cdn.test/2.png' }] })],
    [/GET https:\/\/cdn\.test\/2\.png/, () => new Response(PNG, { headers: { 'content-type': 'image/png' } })]
  ]);
  const images = await generateImage({ baseUrl: 'https://api.test/v1/', apiKey: 'sk-1', model: 'img-1', prompt: 'a cat', count: 2, fetchImpl });
  assert.equal(images.length, 2);
  assert.deepEqual(images.map(image => image.mimeType), ['image/png', 'image/png']);
  assert.equal(images[0].revisedPrompt, 'a cat, watercolor');
  assert.equal(calls[0].headers.authorization, 'Bearer sk-1');
  assert.deepEqual(JSON.parse(calls[0].body), { model: 'img-1', prompt: 'a cat', n: 2 });
  assert.equal(calls[1].headers.authorization, undefined, 'signed result URLs never receive the provider key');
});

test('image edits use the OpenAI multipart endpoint or the generations image field', async () => {
  const openai = fake([[/POST .*\/images\/edits/, (_url, options) => { assert.ok(options.body instanceof FormData); assert.equal(options.body.get('prompt'), 'make it blue'); assert.ok(options.body.get('image')); return json({ data: [{ b64_json: PNG.toString('base64') }] }); }]]);
  await generateImage({ baseUrl: 'https://api.test/v1', model: 'gpt-image-1', prompt: 'make it blue', images: [{ bytes: PNG, mimeType: 'image/png' }], fetchImpl: openai.fetchImpl });
  const generations = fake([[/POST .*\/images\/generations/, (_url, options) => { const body = JSON.parse(options.body); assert.match(body.image, /^data:image\/png;base64,/); return json({ images: [{ url: 'https://cdn.test/e.png' }] }); }], [/GET https:\/\/cdn/, () => new Response(PNG)]]);
  const [edited] = await generateImage({ baseUrl: 'https://api.test/v1', model: 'kolors', prompt: 'make it blue', images: [{ bytes: PNG, mimeType: 'image/png' }], editApi: 'generations', fetchImpl: generations.fetchImpl });
  assert.equal(edited.mimeType, 'image/png');
});

test('speech, transcription and HTTP failures map to typed results', async () => {
  const { fetchImpl } = fake([
    [/POST .*\/audio\/speech/, (_url, options) => { assert.equal(JSON.parse(options.body).voice, 'coral'); return new Response(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20)]), { headers: { 'content-type': 'audio/mpeg' } }); }],
    [/POST .*\/audio\/transcriptions/, (_url, options) => { assert.equal(options.body.get('model'), 'whisper-1'); return json({ text: '你好', language: 'zh' }); }]
  ]);
  const audio = await synthesizeSpeech({ baseUrl: 'https://api.test/v1', model: 'tts', input: '你好', voice: 'coral', fetchImpl });
  assert.equal(audio.mimeType, 'audio/mpeg');
  assert.deepEqual(await transcribeAudio({ baseUrl: 'https://api.test/v1', model: 'whisper-1', audio, filename: 'a.mp3', fetchImpl }), { text: '你好', language: 'zh' });
  const denied = fake([[/POST/, () => json({ error: { message: 'bad key' } }, 401)]]);
  await assert.rejects(synthesizeSpeech({ baseUrl: 'https://api.test/v1', model: 'tts', input: 'x', fetchImpl: denied.fetchImpl }), error => error instanceof MediaModelError && error.code === 'media_auth' && /bad key/.test(error.message));
});

test('each video task API is submitted, polled and downloaded', async () => {
  const cases = {
    openai: [[/POST .*\/videos$/, () => json({ id: 'v1', status: 'queued' })], [/GET .*\/videos\/v1$/, (_u, _o, calls) => json({ id: 'v1', status: calls.filter(c => /videos\/v1$/.test(c.url)).length > 1 ? 'completed' : 'in_progress', progress: 40 })], [/GET .*\/videos\/v1\/content/, () => new Response(MP4)]],
    zhipu: [[/POST .*\/videos\/generations/, () => json({ id: 'z1' })], [/GET .*\/async-result\/z1/, () => json({ task_status: 'SUCCESS', video_result: [{ url: 'https://cdn.test/z.mp4' }] })], [/GET https:\/\/cdn/, () => new Response(MP4)]],
    ark: [[/POST .*\/contents\/generations\/tasks$/, (_u, options) => { assert.match(JSON.parse(options.body).content[0].text, /--duration 5/); return json({ id: 'a1' }); }], [/GET .*\/tasks\/a1/, () => json({ status: 'succeeded', content: { video_url: 'https://cdn.test/a.mp4' } })], [/GET https:\/\/cdn/, () => new Response(MP4)]],
    siliconflow: [[/POST .*\/video\/submit/, () => json({ requestId: 's1' })], [/POST .*\/video\/status/, () => json({ status: 'Succeed', results: { videos: [{ url: 'https://cdn.test/s.mp4' }] } })], [/GET https:\/\/cdn/, () => new Response(MP4)]],
    dashscope: [[/POST https:\/\/dash\.test\/api\/v1\/services\/aigc\/video-generation\/video-synthesis/, (_u, options) => { assert.equal(options.headers['X-DashScope-Async'], 'enable'); return json({ output: { task_id: 'd1' } }); }], [/GET https:\/\/dash\.test\/api\/v1\/tasks\/d1/, () => json({ output: { task_status: 'SUCCEEDED', video_url: 'https://cdn.test/d.mp4' } })], [/GET https:\/\/cdn/, () => new Response(MP4)]]
  };
  for (const [api, routes] of Object.entries(cases)) {
    const { fetchImpl } = fake(routes), progress = [];
    const baseUrl = api === 'dashscope' ? 'https://dash.test/compatible-mode/v1' : 'https://api.test/v1';
    const video = await generateVideo({ api, baseUrl, model: 'm', prompt: 'waves', seconds: 5, fetchImpl, pollMs: 1, onProgress: event => progress.push(event.status) });
    assert.equal(video.mimeType, 'video/mp4', api);
    assert.equal(progress[0], 'submitted', api);
  }
  const failed = fake([[/POST .*\/videos\/generations/, () => json({ id: 'z2' })], [/GET .*\/async-result/, () => json({ task_status: 'FAIL' })]]);
  await assert.rejects(generateVideo({ api: 'zhipu', baseUrl: 'https://api.test/v1', model: 'm', prompt: 'x', fetchImpl: failed.fetchImpl, pollMs: 1 }), error => error.code === 'media_generation_failed' && error.details.taskId === 'z2');
  const slow = fake([[/POST .*\/videos$/, () => json({ id: 'v2' })], [/GET/, () => json({ status: 'in_progress' })]]);
  await assert.rejects(generateVideo({ baseUrl: 'https://api.test/v1', model: 'm', prompt: 'x', fetchImpl: slow.fetchImpl, pollMs: 1, timeoutMs: 5 }), error => error.code === 'media_timeout');
});
