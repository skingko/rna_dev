import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { probeImageInput, solidPng } from '../src/vision-probe.mjs';
import { ProviderError } from '../src/providers.mjs';
import { normalizeImage } from '../src/images.mjs';

const model = { protocol: 'openai', providerId: 'p', modelId: 'm', baseUrl: 'http://127.0.0.1:1/v1', maxOutputTokens: 4096, contextWindow: 32000, reasoningCapability: { control: 'none' } };
const answering = reply => async function* () { yield { type: 'text_delta', delta: reply }; yield { type: 'done' }; };

test('the probe picture is a valid solid PNG', () => {
  const png = solidPng(8);
  assert.doesNotThrow(() => normalizeImage({ type: 'image', mimeType: 'image/png', data: png.toString('base64') }));
  const idat = png.subarray(png.indexOf('IDAT') + 4, png.indexOf('IEND') - 8);
  assert.deepEqual([...inflateSync(idat).subarray(1, 4)], [220, 20, 20]);
});

test('the upstream answer decides image input', async () => {
  const requests = [];
  const seen = await probeImageInput({ model, provider: async function* (input) { requests.push(input); yield { type: 'text_delta', delta: 'Red.' }; yield { type: 'done' }; } });
  assert.deepEqual(seen.input, ['text', 'image']); assert.equal(seen.evidence, 'answered');
  assert.equal(requests[0].messages[0].content[1].type, 'image'); assert.equal(requests[0].model.reasoning, 'off'); assert.equal(requests[0].model.maxOutputTokens, 64);
  assert.deepEqual((await probeImageInput({ model, provider: answering('红色') })).input, ['text', 'image']);
  const ignored = await probeImageInput({ model, provider: answering('I cannot see any image.') });
  assert.deepEqual(ignored.input, ['text']); assert.equal(ignored.evidence, 'ignored_image');
  assert.equal(await probeImageInput({ model, provider: answering('') }), null, 'an empty answer proves nothing');
});

test('a rejected image counts only when the same text request passes', async () => {
  const rejectImages = async function* (input) { if (input.messages[0].content.some(block => block.type === 'image')) throw new ProviderError('unknown variant image_url', { status: 400 }); yield { type: 'text_delta', delta: 'ok' }; yield { type: 'done' }; };
  assert.deepEqual(await probeImageInput({ model, provider: rejectImages }), { input: ['text'], evidence: 'rejected_image', status: 400 });
  const rejectAll = async function* () { throw new ProviderError('bad model', { status: 400 }); };
  assert.equal(await probeImageInput({ model, provider: rejectAll }), null);
  for (const status of [401, 429, 503]) assert.equal(await probeImageInput({ model, provider: async function* () { throw new ProviderError('x', { status }); } }), null);
});
