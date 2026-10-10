import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { VisionService } from '../vision-service.mjs';
import { resolveModel } from '../configuration.mjs';
import { solidPng } from '../../../packages/sdk/src/vision-probe.mjs';

const model = (id, extra = {}) => ({ id, name: id, contextWindow: 64000, maxOutputTokens: 4096, ...extra });
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-vision-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.json')), workspace = join(dir, 'ws'); mkdirSync(workspace);
  const text = store.configurationService.provider(null, { name: 'Text', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k1', models: [model('plain')] });
  const eyes = store.configurationService.provider(null, { name: 'Eyes', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v2', apiKey: 'k2', models: [model('seer', { input: ['text', 'image'] }), model('other')] });
  const id = row => row.id ?? row.provider?.id;
  return { dir, store, workspace, textId: id(text), eyesId: id(eyes) };
}
const observe = (store, providerId, modelId, input) => {
  const provider = store.state.configuration.providers.find(row => row.id === providerId);
  return store.configurationService.recordProbedInput({ providerId, modelId, baseUrl: provider.baseUrl, protocol: provider.protocol, authMode: 'api_key' }, { input, evidence: input.includes('image') ? 'answered' : 'ignored_image' });
};

test('an observed upstream response becomes the model input capability and survives provider edits', t => {
  const { store, textId } = setup(t);
  assert.equal(resolveModel(store.state.configuration, { providerId: textId, modelId: 'plain' }).input?.includes('image'), undefined);
  assert.equal(observe(store, textId, 'plain', ['text', 'image']), true);
  assert.deepEqual(resolveModel(store.state.configuration, { providerId: textId, modelId: 'plain' }).input, ['text', 'image']);
  const shown = store.configurationService.public().providers.find(row => row.id === textId).models[0];
  assert.equal(shown.inputCapability.source, 'probe'); assert.equal(shown.probedInput, undefined);
  store.configurationService.provider(textId, { name: 'Renamed' });
  assert.equal(store.configurationService.public().providers.find(row => row.id === textId).models[0].inputCapability.source, 'probe');
  store.configurationService.provider(textId, { baseUrl: 'http://127.0.0.1:9/v9' });
  assert.notEqual(store.configurationService.public().providers.find(row => row.id === textId).models[0].inputCapability.source, 'probe', 'a different endpoint needs its own observation');
});

test('vision model: explicit choice first, else a verified image model; describe sends pixels only there', async t => {
  const { store, textId, eyesId } = setup(t), requests = [];
  const provider = async function* (input) { requests.push(input); yield { type: 'text_delta', delta: '一个红色方块' }; yield { type: 'done' }; };
  const vision = new VisionService(store, { provider, autoProbe: false }); t.after(() => vision.close());
  const main = resolveModel(store.state.configuration, { providerId: textId, modelId: 'plain' });
  assert.equal(vision.visionModel(main), null, 'a configured-only declaration is not verified');
  observe(store, eyesId, 'other', ['text', 'image']);
  assert.equal(vision.visionModel(main).modelId, 'other');
  assert.throws(() => store.configurationService.update({ media: { vision: { providerId: eyesId, modelId: 'seer' } } }), /尚未确认/);
  observe(store, eyesId, 'seer', ['text', 'image']);
  store.configurationService.update({ media: { vision: { providerId: eyesId, modelId: 'seer' } } });
  const image = { type: 'image', mimeType: 'image/png', data: solidPng(4).toString('base64') };
  const described = await vision.describe({ images: [image], question: '这是什么颜色', main });
  assert.deepEqual([described.text, described.modelId], ['一个红色方块', 'seer']);
  assert.equal(requests[0].model.modelId, 'seer'); assert.equal(requests[0].purpose, 'vision');
  assert.equal(requests[0].messages[0].content[1].type, 'image'); assert.match(requests[0].messages[0].content[0].text, /这是什么颜色/);
});

test('image_analyze reads project images inside the workspace only', async t => {
  const { store, workspace, eyesId } = setup(t);
  observe(store, eyesId, 'seer', ['text', 'image']);
  const vision = new VisionService(store, { provider: async function* () { yield { type: 'text_delta', delta: 'red square' }; yield { type: 'done' }; }, autoProbe: false }); t.after(() => vision.close());
  writeFileSync(join(workspace, 'shot.png'), solidPng(4)); writeFileSync(join(workspace, 'notes.txt'), 'x');
  const [tool] = vision.createTools({ project: { id: 'p', workspace }, sessionId: 's' });
  assert.equal(tool.name, 'image_analyze');
  assert.equal((await tool.execute('1', { question: 'colour?', path: 'shot.png' })).content[0].text, 'red square');
  assert.equal((await tool.execute('2', { question: 'x', path: '../x.png' })).isError, true);
  assert.equal((await tool.execute('3', { question: 'x', path: 'notes.txt' })).isError, true);
});

test('models in use with unknown image input are probed once and recorded', async t => {
  const { store, textId } = setup(t), probes = [];
  store.configurationService.update({ defaultModel: { providerId: textId, modelId: 'plain' } });
  const vision = new VisionService(store, { autoProbe: false, probe: async ({ model }) => { probes.push(model.modelId); return { input: ['text'], evidence: 'rejected_image' }; } }); t.after(() => vision.close());
  await vision.probeInUse(); await vision.probeInUse();
  assert.deepEqual(probes, ['plain']);
  const shown = store.configurationService.public().providers.find(row => row.id === textId).models[0].inputCapability;
  assert.deepEqual([shown.status, shown.source, shown.input], ['known', 'probe', ['text']]);
});

test('a vision model that rejects the pictures is observed, recorded as text-only and replaced', async t => {
  const { store, eyesId } = setup(t);
  const { ProviderError } = await import('../../../packages/sdk/src/providers.mjs');
  observe(store, eyesId, 'seer', ['text', 'image']);
  const provider = async function* (input) { if (input.model.modelId === 'seer') throw new ProviderError('image not supported', { status: 400 }); yield { type: 'text_delta', delta: 'described' }; yield { type: 'done' }; };
  observe(store, eyesId, 'other', ['text', 'image']);
  store.configurationService.update({ media: { vision: { providerId: eyesId, modelId: 'seer' } } });
  const vision = new VisionService(store, { provider, autoProbe: false, probe: async () => ({ input: ['text'], evidence: 'rejected_image', status: 400 }) }); t.after(() => vision.close());
  const image = { type: 'image', mimeType: 'image/png', data: solidPng(4).toString('base64') };
  const result = await vision.describe({ images: [image], question: 'q' });
  assert.deepEqual([result.text, result.modelId], ['described', 'other']);
  assert.deepEqual(store.configurationService.public().providers.find(row => row.id === eyesId).models.find(row => row.id === 'seer').inputCapability.input, ['text']);
});

test('image_analyze prefers the conversation model provider', async t => {
  const { store, workspace, textId, eyesId } = setup(t);
  store.configurationService.provider(textId, { models: [model('plain'), model('look', { input: ['text', 'image'] })] });
  observe(store, eyesId, 'seer', ['text', 'image']); observe(store, textId, 'look', ['text', 'image']);
  store.mutate(state => { state.sessions.push({ id: 's1', projectId: 'p', modelSelection: { providerId: textId, modelId: 'plain' }, turns: [], items: [] }); });
  const used = [];
  const vision = new VisionService(store, { provider: async function* (input) { used.push(input.model.modelId); yield { type: 'text_delta', delta: 'ok' }; yield { type: 'done' }; }, autoProbe: false }); t.after(() => vision.close());
  writeFileSync(join(workspace, 'a.png'), solidPng(4));
  const [tool] = vision.createTools({ project: { id: 'p', workspace }, sessionId: 's1' });
  await tool.execute('1', { question: 'q', path: 'a.png' });
  assert.deepEqual(used, ['look']);
});
