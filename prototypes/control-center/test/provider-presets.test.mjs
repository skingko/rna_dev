import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { providerPresets, catalogModel } from '../provider-presets.mjs';
import { resolveModel } from '../configuration.mjs';
import { buildRequest, compactionForkEnabled } from '../../../packages/sdk/src/providers.mjs';
function fixture(t) { const dir = mkdtempSync(join(tmpdir(), 'rna-presets-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return new Store(join(dir, 'state.json')); }
test('legacy model input is projected from official catalog without mutating selections or saved configuration', t => {
  const store = fixture(t), p = store.configurationService.provider(null, { presetId: 'deepseek' });
  store.mutate(state => { const stored = state.configuration.providers.find(row => row.id === p.id); for (const m of stored.models) delete m.input; });
  const before = structuredClone(store.state.configuration);
  assert.deepEqual(resolveModel(before, { providerId: p.id, modelId: 'deepseek-v4-pro' }).input, ['text']);
  assert.deepEqual(resolveModel(before, { providerId: p.id, modelId: 'deepseek-flash' }).input, ['text', 'image']);
  assert.deepEqual(store.configurationService.public().providers.find(row => row.id === p.id).models[1].input, ['text', 'image']);
  assert.deepEqual(store.state.configuration, before);
});
test('custom image capability is explicit, validated and retained; known text-only models cannot be mislabeled', t => {
  const store = fixture(t), p = store.configurationService.provider(null, { name: 'Image fixture', baseUrl: 'https://example.test/v1', models: [{ id: 'vision', input: ['text', 'image'], contextWindow: 64000, maxOutputTokens: 1000 }] });
  assert.deepEqual(resolveModel(store.state.configuration, { providerId: p.id, modelId: 'vision' }).input, ['text', 'image']);
  for (const input of [['image'], ['text', 'audio'], ['text', 'text'], 'image']) assert.throws(() => store.configurationService.provider(p.id, { models: [{ id: 'vision', input }] }), /输入能力/);
  const known = store.configurationService.provider(null, { presetId: 'deepseek', models: [{ id: 'deepseek-v4-pro', input: ['text', 'image'] }] });
  assert.deepEqual(known.models[0].input, ['text']);
});
test('expanded preset choices contain only SDK-supported protocols, independent context/output limits and sources', () => {
  const presets = providerPresets(); assert.deepEqual(presets.map(p => p.id), ['deepseek', 'openai', 'anthropic', 'google', 'groq', 'openrouter', 'qwen-cn', 'qwen-intl', 'kimi-cn', 'kimi', 'kimi-coding', 'glm', 'glm-coding', 'mimo', 'mimo-token-plan-cn', 'openai-codex', 'custom']);
  for (const preset of presets) for (const model of preset.models) {
    assert.ok(['openai', 'anthropic'].includes(preset.protocol)); if (model.modelMaxOutputTokens !== null) { assert.ok(model.maxOutputTokens <= model.modelMaxOutputTokens); assert.ok(model.modelMaxOutputTokens <= model.contextWindow); } else { assert.ok(model.maxOutputTokens <= model.contextWindow); } assert.ok(['2026-09-24', '2026-09-26', '2026-09-27'].includes(model.source.checkedAt));
    const request = buildRequest({ model: { ...model, modelId: model.id, protocol: preset.protocol, baseUrl: preset.baseUrl, reasoning: model.reasoning[0] }, messages: [{ role: 'user', content: 'fixture' }] });
    assert.match(request.url, /\/(chat\/completions|messages)$/); assert.equal(request.body.model, model.id);
  }
  assert.equal(presets[0].models[0].contextWindow, 1000000); assert.equal(presets[0].models[0].modelMaxOutputTokens, 384000); assert.equal(presets[0].models[0].maxOutputTokens, 8192);
  // Review P1 CLAUDE-6: on Claude, thinking counts toward max_tokens; a model offering xhigh/max needs the 64K allowance
  // (8K cut tool responses off, which the provider rejects as provider_protocol).
  const claude = presets.find(p => p.id === 'anthropic').models.filter(model => model.reasoningCapability?.efforts?.some(effort => ['xhigh', 'max'].includes(effort.id)));
  assert.deepEqual(claude.map(model => model.id), ['claude-opus-5-5', 'claude-sonnet-5']);
  for (const model of claude) assert.equal(model.maxOutputTokens, 64000, model.id);
});
test('creating from preset needs only its id and credentials, never changes the existing default model', t => {
  const store = fixture(t), original = structuredClone(store.state.configuration.defaultModel);
  const p = store.configurationService.provider(null, { presetId: 'deepseek', apiKey: 'isolated-test-secret' });
  assert.equal(p.name, 'DeepSeek'); assert.equal(p.protocol, 'openai'); assert.equal(p.apiKeyEnv, ''); assert.equal(p.apiKeyConfigured, true); assert.equal(p.models[0].contextWindow, 1000000);
  assert.deepEqual(store.state.configuration.defaultModel, original); assert.ok(!JSON.stringify(store.get()).includes('isolated-test-secret'));
  const selected = resolveModel(store.state.configuration, { providerId: p.id, modelId: 'deepseek-v4-pro', reasoning: 'max' }); assert.equal(selected.contextWindow, 1000000); assert.equal(selected.maxOutputTokens, 8192);
  assert.equal(store.configurationService.public().providerPresets.length, 17);
});
test('known endpoint/model fills omitted capacity, unknown custom models require explicit capacity and output', t => {
  const store = fixture(t);
  const known = store.configurationService.provider(null, { name: 'DeepSeek custom label', baseUrl: 'https://api.deepseek.com/v1', models: [{ id: 'deepseek-v4-pro' }] }); assert.equal(known.models[0].contextWindow, 1000000);
  assert.throws(() => store.configurationService.provider(null, { name: 'Custom', baseUrl: 'https://example.org/v1', models: [{ id: 'deepseek-v4-pro' }] }), /未知模型/);
  assert.equal(catalogModel({ protocol: 'openai', baseUrl: 'https://example.org/v1' }, 'deepseek-v4-pro'), undefined);
  const custom = store.configurationService.provider(null, { name: 'Custom', baseUrl: 'https://example.org/v1', models: [{ id: 'private', contextWindow: 50000, maxOutputTokens: 4000 }] }); assert.equal(custom.models[0].modelMaxOutputTokens, null);
});
test('legacy hand-set limits survive reads and edits; explicit preset model apply resets only requested models', t => {
  const store = fixture(t), p = store.configurationService.provider(null, { name: 'Existing', baseUrl: 'https://api.deepseek.com', models: [{ id: 'deepseek-v4-pro', contextWindow: 128000, maxOutputTokens: 4000 }] });
  store.configurationService.provider(p.id, { presetId: 'deepseek' });
  let visible = store.configurationService.public().providers.find(row => row.id === p.id); assert.equal(visible.models[0].contextWindow, 128000); assert.equal(visible.models[0].catalogDefaults.contextWindow, 1000000);
  store.configurationService.provider(p.id, { models: [{ id: 'deepseek-v4-pro', name: 'Renamed' }] }); assert.equal(store.state.configuration.providers.find(row => row.id === p.id).models[0].contextWindow, 128000);
  visible = store.configurationService.provider(p.id, { presetId: 'deepseek', applyPresetModels: true }); assert.equal(visible.models[0].contextWindow, 1000000); assert.equal(visible.models[0].maxOutputTokens, 8192);
  assert.throws(() => store.configurationService.provider(p.id, { models: [{ id: 'deepseek-v4-pro', maxOutputTokens: 384001 }] }), /输出能力/);
});

test('provider updates refresh idle conversation capacity immediately while active turns retain their pinned model', t => {
  const store = fixture(t), p = store.configurationService.provider(null, { presetId: 'deepseek' });
  store.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'deepseek-v4-pro', reasoning: 'off' } });
  const idle = store.createSession({}), active = store.createSession({}); store.message(active.id, { text: 'pinned request' });
  store.configurationService.provider(p.id, { models: [{ id: 'deepseek-v4-pro', contextWindow: 256000, maxOutputTokens: 4096 }] });
  const idleNow = store.state.sessions.find(row => row.id === idle.id), activeNow = store.state.sessions.find(row => row.id === active.id);
  assert.equal(idleNow.context.capacity, 256000); assert.equal(idleNow.modelConfig.maxOutputTokens, 4096);
  assert.equal(activeNow.context.capacity, 1000000); assert.equal(activeNow.turns[0].modelConfig.contextWindow, 1000000);
});


test('discovered custom model output capacity survives save, reopen and ordinary edits independently from request output', async t => {
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; assert.equal(req.url, '/v1/models'); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'discovery-fixture', context_length: 64000, max_output_tokens: 16000 }] })); });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  const store = fixture(t), provider = store.configurationService.provider(null, { name: 'Discovery fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [] });
  const found = await store.configurationService.test(provider.id); assert.equal(found.models[0].modelMaxOutputTokens, 16000); assert.equal(requests, 1);
  store.configurationService.provider(provider.id, { models: [{ ...found.models[0], maxOutputTokens: 4000 }] });
  const reopened = new Store(store.file), visible = reopened.configurationService.public().providers.find(row => row.id === provider.id).models[0];
  assert.equal(visible.contextWindow, 64000); assert.equal(visible.modelMaxOutputTokens, 16000); assert.equal(visible.maxOutputTokens, 4000); assert.equal(visible.limitsSource.modelMaxOutputTokens, 'custom');
  const edited = reopened.configurationService.provider(provider.id, { models: [{ id: visible.id, name: 'Renamed', maxOutputTokens: 6000 }] }).models[0];
  assert.equal(edited.modelMaxOutputTokens, 16000); assert.equal(edited.maxOutputTokens, 6000);
  assert.throws(() => reopened.configurationService.provider(provider.id, { models: [{ id: visible.id, maxOutputTokens: 16001 }] }), /输出能力/);
  assert.equal(reopened.configurationService.public().providers.find(row => row.id === provider.id).models[0].maxOutputTokens, 6000);
  const cleared = reopened.configurationService.provider(provider.id, { models: [{ id: visible.id, modelMaxOutputTokens: null }] }).models[0]; assert.equal(cleared.modelMaxOutputTokens, null); assert.equal(cleared.maxOutputTokens, 6000);
});

test('submitted model output capability rejects invalid metadata without changing saved configuration', t => {
  const store = fixture(t), provider = store.configurationService.provider(null, { name: 'Custom boundary', baseUrl: 'https://example.org/v1', models: [{ id: 'custom', contextWindow: 64000, maxOutputTokens: 4000, modelMaxOutputTokens: 8000 }] });
  for (const value of [0, -1, 1.5, '8000', NaN, Infinity, 10000001, {}, []]) {
    const before = structuredClone(store.state.configuration);
    assert.throws(() => store.configurationService.provider(provider.id, { models: [{ id: 'custom', modelMaxOutputTokens: value }] }), /模型输出能力/);
    assert.deepEqual(store.state.configuration, before);
  }
  const lower = store.configurationService.provider(provider.id, { models: [{ id: 'custom', modelMaxOutputTokens: 1, maxOutputTokens: 1 }] }).models[0]; assert.equal(lower.modelMaxOutputTokens, 1);
  const upper = store.configurationService.provider(provider.id, { models: [{ id: 'custom', modelMaxOutputTokens: 10000000, maxOutputTokens: 4000 }] }).models[0]; assert.equal(upper.modelMaxOutputTokens, 10000000); assert.equal(upper.contextWindow, 64000); assert.equal(upper.maxOutputTokens, 4000);
});

test('official model output capability takes precedence over submitted metadata without replacing request output', t => {
  const store = fixture(t), provider = store.configurationService.provider(null, { presetId: 'deepseek', models: [{ id: 'deepseek-v4-pro', modelMaxOutputTokens: 4096, maxOutputTokens: 4000 }] });
  assert.equal(provider.models[0].modelMaxOutputTokens, 384000); assert.equal(provider.models[0].maxOutputTokens, 4000); assert.equal(provider.models[0].limitsSource.modelMaxOutputTokens, 'catalog');
  const edited = store.configurationService.provider(provider.id, { models: [{ id: 'deepseek-v4-pro', modelMaxOutputTokens: null, maxOutputTokens: 8192 }] }).models[0];
  assert.equal(edited.modelMaxOutputTokens, 384000); assert.equal(edited.maxOutputTokens, 8192);
  assert.throws(() => store.configurationService.provider(provider.id, { models: [{ id: 'deepseek-v4-pro', modelMaxOutputTokens: 1000000, maxOutputTokens: 384001 }] }), /输出能力/);
});

// Plan C5 (TC-6): the paid probe measured GLM-5.3 only, so only that model's entry declares the compaction fork; a
// configuration saved before the flag existed gets the same default from the SDK (the official route and exact model id).
test('GLM-5.3 declares compat.compactionFork, Flash and FlashX do not; the flag is saved, validated, and an old saved entry forks too', t => {
  for (const id of ['glm', 'glm-coding']) {
    const models = new Map(providerPresets().find(row => row.id === id).models.map(model => [model.id, model]));
    assert.equal(models.get('glm-5.3').compat.compactionFork, true, id);
    for (const other of ['glm-5.3-flash', 'glm-5.3-flashx']) if (models.has(other)) assert.equal(models.get(other).compat.compactionFork, undefined, `${id}/${other}`);
  }
  const store = fixture(t), provider = store.configurationService.provider(null, { presetId: 'glm', apiKey: 'fixture-only-not-a-key' });
  const flag = id => resolveModel(store.state.configuration, { providerId: provider.id, modelId: id }).compat?.compactionFork;
  assert.equal(flag('glm-5.3'), true); assert.equal(flag('glm-5.3-flash'), undefined);
  assert.equal(compactionForkEnabled(resolveModel(store.state.configuration, { providerId: provider.id, modelId: 'glm-5.3' })), true);
  assert.equal(compactionForkEnabled(resolveModel(store.state.configuration, { providerId: provider.id, modelId: 'glm-5.3-flash' })), false);
  // The flag must be a boolean, and an explicit false is kept (the user's choice beats the default).
  assert.throws(() => store.configurationService.provider(provider.id, { models: [{ id: 'glm-5.3', compat: { compactionFork: 'yes' } }] }), /兼容开关必须为布尔值/);
  const saved = provider.models.find(model => model.id === 'glm-5.3');
  store.configurationService.provider(provider.id, { models: [{ id: 'glm-5.3', compat: { ...saved.compat, compactionFork: false } }] });
  assert.equal(flag('glm-5.3'), false); assert.equal(compactionForkEnabled(resolveModel(store.state.configuration, { providerId: provider.id, modelId: 'glm-5.3' })), false);
  // A configuration saved before the flag existed has no `compactionFork` on its entry: the SDK's route default applies.
  store.mutate(state => { for (const model of state.configuration.providers.find(row => row.id === provider.id).models) delete model.compat?.compactionFork; });
  assert.equal(flag('glm-5.3'), undefined); assert.equal(compactionForkEnabled(resolveModel(store.state.configuration, { providerId: provider.id, modelId: 'glm-5.3' })), true, 'an older saved GLM-5.3 entry');
  // A proxy under the same model id is not the measured route.
  const proxy = store.configurationService.provider(null, { name: 'GLM proxy', protocol: 'openai', baseUrl: 'https://proxy.example.com/api/paas/v4', apiKey: 'fixture-only-not-a-key', models: [{ id: 'glm-5.3', contextWindow: 1000000, maxOutputTokens: 8192 }] });
  assert.equal(compactionForkEnabled(resolveModel(store.state.configuration, { providerId: proxy.id, modelId: 'glm-5.3' })), false);
});
