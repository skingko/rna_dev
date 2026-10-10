import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { resolveModel } from '../configuration.mjs';
import { normalizeDiscoveredModel, resolveInputCapability, bindInputEvidence } from '../provider-discovery.mjs';

const custom = { id: 'fixture-provider', protocol: 'openai', baseUrl: 'https://fixture.example/v1' };
const declared = (metadata = {}) => ({ id: 'fixture-model', context_length: 64000, max_output_tokens: 16000, tool_call: true, ...metadata });
function fixture(t) { const dir = mkdtempSync(join(tmpdir(), 'rna-auto-input-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return new Store(join(dir, 'state.json')); }
async function listing(t, readRows) {
  let calls = 0;
  const server = http.createServer((req, res) => { calls++; assert.equal(req.url, '/v1/models'); assert.equal(req.method, 'GET'); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: readRows() })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, calls: () => calls };
}

for (const [name, raw, expected] of [
  ['top-level modalities', { input_modalities: ['text', 'image'] }, ['text', 'image']],
  ['architecture input', { architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } }, ['text', 'image']],
  ['nested modalities', { modalities: { input: ['text', 'image'] } }, ['text', 'image']],
  ['array modalities', { modalities: ['text'] }, ['text']],
  ['explicit vision true', { capabilities: { vision: true } }, ['text', 'image']],
  ['explicit vision false', { capabilities: { vision: false } }, ['text']],
  ['missing', {}, undefined],
  ['output-only image', { output_modalities: ['image'], architecture: { output_modalities: ['image'] } }, undefined],
  ['empty list', { input_modalities: [] }, undefined],
  ['malformed vision', { vision: 'true' }, undefined],
  ['unsupported-only input', { input_modalities: ['tool'], vision: true }, undefined],
  ['image-only cannot imply text', { input_modalities: ['image'], vision: true }, undefined],
  ['explicit input wins over conflicting generic vision', { input_modalities: ['text'], vision: true }, ['text']]
]) test(`automatic multimodal parsing: ${name}`, () => {
  const found = normalizeDiscoveredModel(custom, declared(raw), { checkedAt: '2026-09-27T00:00:00.000Z', sourceUrl: `${custom.baseUrl}/models` });
  assert.deepEqual(found.input, expected); assert.equal(found.inputCapability.status, expected ? 'known' : 'unknown');
  assert.equal(found.inputCapability.source, expected ? 'provider' : 'unknown'); assert.equal(found.inputCapability.sourceUrl, `${custom.baseUrl}/models`);
});

test('exact official catalog wins over old selections and conflicting endpoint metadata; public and execution agree', t => {
  const store = fixture(t), p = store.configurationService.provider(null, { presetId: 'glm' });
  store.mutate(state => {
    const provider = state.configuration.providers.find(row => row.id === p.id);
    const flash = provider.models.find(row => row.id === 'glm-5.3-flash'); flash.input = ['text']; delete flash.catalogVersion;
    const pro = provider.models.find(row => row.id === 'glm-5.3'); pro.input = ['text', 'image'];
  });
  const provider = store.state.configuration.providers.find(row => row.id === p.id);
  const before = structuredClone(provider);
  for (const [id, input] of [['glm-5.3-flash', ['text', 'image']], ['glm-5.3', ['text']]]) {
    const publicRow = store.configurationService.public().providers.find(row => row.id === p.id).models.find(row => row.id === id);
    assert.deepEqual(publicRow.input, input); assert.equal(publicRow.inputCapability.source, 'catalog');
    assert.deepEqual(resolveModel(store.state.configuration, { providerId: p.id, modelId: id }).input, input);
    assert.deepEqual(normalizeDiscoveredModel(provider, { id, input_modalities: input.includes('image') ? ['text'] : ['text', 'image'] }).input, input);
  }
  assert.deepEqual(provider, before);
  assert.equal(normalizeDiscoveredModel(custom, { id: 'glm-5.3-flash' }).input, undefined);
  assert.equal(store.configurationService.public().providerPresets.find(row => row.id === 'glm').models[1].inputCapability.status, 'known');
});

test('refresh updates existing input automatically, preserves execution choices and leaves active turns pinned', async t => {
  let image = false;
  const endpoint = await listing(t, () => [declared({ capabilities: { vision: image } })]);
  const store = fixture(t), p = store.configurationService.provider(null, { name: 'Fixture', baseUrl: endpoint.baseUrl, models: [{ id: 'fixture-model', contextWindow: 50000, maxOutputTokens: 2000, reasoning: ['off'], compat: { maxTokensField: 'max_tokens' } }] });
  await store.configurationService.refreshModels(p.id);
  store.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'fixture-model' } });
  const session = store.createSession({}); store.message(session.id, { text: 'Pinned input capability' });
  const oldTurn = structuredClone(store.state.sessions.find(row => row.id === session.id).turns[0]);
  image = true;
  const result = await store.configurationService.refreshModels(p.id), row = result.provider.models[0];
  assert.deepEqual(row.input, ['text', 'image']); assert.equal(row.inputCapability.source, 'provider');
  assert.equal(row.contextWindow, 50000); assert.equal(row.maxOutputTokens, 2000); assert.deepEqual(row.reasoning, ['off']); assert.equal(row.compat.maxTokensField, 'max_tokens');
  assert.deepEqual(store.state.sessions.find(row => row.id === session.id).turns[0], oldTurn);
  assert.deepEqual(resolveModel(store.state.configuration, { providerId: p.id, modelId: row.id }).input, row.input);
  const reopened = new Store(store.file); assert.deepEqual(resolveModel(reopened.state.configuration, { providerId: p.id, modelId: row.id }).input, row.input);
  assert.equal(endpoint.calls(), 2);
});

test('test-and-save recognizes a discovered model without a client input field; spoofed provenance is ignored', async t => {
  const endpoint = await listing(t, () => [declared({ input_modalities: ['text', 'image'] })]);
  const store = fixture(t), p = store.configurationService.provider(null, { name: 'Fixture', baseUrl: endpoint.baseUrl, models: [] });
  await store.configurationService.test(p.id);
  const saved = store.configurationService.provider(p.id, { models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 2000 }] });
  assert.equal(saved.models[0].inputCapability.source, 'provider'); assert.deepEqual(saved.models[0].input, ['text', 'image']);
  const forged = store.configurationService.provider(p.id, { models: [{ id: 'unknown', contextWindow: 64000, maxOutputTokens: 2000, inputCapability: { status: 'known', source: 'provider', input: ['text', 'image'] }, discoveredInput: { binding: { modelId: 'unknown', baseUrl: endpoint.baseUrl, protocol: 'openai', authMode: 'api_key' }, input: ['text', 'image'] } }] });
  assert.equal(forged.models[0].inputCapability.status, 'unknown'); assert.equal(forged.models[0].input, undefined);
});

test('same-row edits preserve compatibility declarations; model ID and endpoint changes drop previous automatic capability', async t => {
  const endpoint = await listing(t, () => [declared({ input_modalities: ['text', 'image'] })]);
  const store = fixture(t), p = store.configurationService.provider(null, { name: 'Fixture', baseUrl: endpoint.baseUrl, models: [] }); await store.configurationService.refreshModels(p.id);
  const switched = store.configurationService.provider(p.id, { baseUrl: 'https://another.example/v1' });
  assert.equal(switched.models[0].input, undefined); assert.equal(switched.models[0].inputCapability.status, 'unknown');
  const renamed = store.configurationService.provider(p.id, { models: [{ id: 'another-id', contextWindow: 64000, maxOutputTokens: 2000 }] });
  assert.equal(renamed.models[0].input, undefined);
  const legacy = store.configurationService.provider(null, { name: 'Legacy explicit SDK declaration', baseUrl: 'https://legacy.example/v1', models: [{ id: 'custom', input: ['text', 'image'], contextWindow: 64000, maxOutputTokens: 2000 }] });
  const edited = store.configurationService.provider(legacy.id, { models: [{ id: 'custom', maxOutputTokens: 1000 }] });
  assert.deepEqual(edited.models[0].input, ['text', 'image']); assert.equal(edited.models[0].inputCapability.source, 'configured'); assert.equal(edited.models[0].inputCapability.status, 'unknown');
  assert.equal(store.configurationService.provider(legacy.id, { baseUrl: 'https://changed.example/v1' }).models[0].input, undefined);
});

test('a bound discovery receipt cannot be transplanted to another model, provider or route', () => {
  const found = normalizeDiscoveredModel(custom, declared({ input_modalities: ['text', 'image'] }));
  const row = { id: found.id, input: found.input, discoveredInput: bindInputEvidence(custom, found) };
  for (const changed of [{ ...custom, id: 'another' }, { ...custom, baseUrl: 'https://other.example/v1' }, { ...custom, protocol: 'anthropic' }, { ...custom, authMode: 'coding_plan' }]) assert.deepEqual(resolveInputCapability(changed, row), { status: 'unknown', source: 'unknown' });
  assert.deepEqual(resolveInputCapability(custom, { ...row, id: 'renamed' }), { status: 'unknown', source: 'unknown' });
});

test('refresh cannot retain an old automatic image claim when the endpoint no longer reports modalities', async t => {
  let input = { input_modalities: ['text', 'image'] };
  const endpoint = await listing(t, () => [declared(input)]);
  const store = fixture(t), p = store.configurationService.provider(null, { name: 'Fixture', baseUrl: endpoint.baseUrl, models: [] }); await store.configurationService.refreshModels(p.id);
  input = {};
  const result = await store.configurationService.refreshModels(p.id);
  assert.equal(result.provider.models[0].inputCapability.status, 'unknown'); assert.equal(result.provider.models[0].input, undefined);
  assert.equal(resolveModel(store.state.configuration, { providerId: p.id, modelId: 'fixture-model' }).input, undefined);
});

test('a listing without modality metadata preserves an existing explicit API contract as unverified', async t => {
  const endpoint = await listing(t, () => [declared()]);
  const store = fixture(t), p = store.configurationService.provider(null, { name: 'Legacy explicit', baseUrl: endpoint.baseUrl, models: [{ id: 'fixture-model', input: ['text', 'image'], contextWindow: 64000, maxOutputTokens: 1000 }] });
  const refreshed = await store.configurationService.refreshModels(p.id);
  assert.deepEqual(refreshed.provider.models[0].input, ['text', 'image']);
  assert.equal(refreshed.provider.models[0].inputCapability.status, 'unknown'); assert.equal(refreshed.provider.models[0].inputCapability.source, 'configured');
  assert.deepEqual(resolveModel(store.state.configuration, { providerId: p.id, modelId: 'fixture-model' }).input, ['text', 'image']);
});

test('credential and credential-source updates invalidate automatic metadata without retaining derived vision', async t => {
  const endpoint = await listing(t, () => [declared({ vision: true })]);
  const store = fixture(t), p = store.configurationService.provider(null, { name: 'Fixture', baseUrl: endpoint.baseUrl, apiKey: 'first-fixture-credential', models: [] }); await store.configurationService.refreshModels(p.id);
  const changed = store.configurationService.provider(p.id, { apiKey: 'next-fixture-credential' });
  assert.equal(changed.models[0].inputCapability.status, 'unknown'); assert.equal(changed.models[0].input, undefined);
  await store.configurationService.refreshModels(p.id);
  const fromEnvironment = store.configurationService.provider(p.id, { apiKeyEnv: 'RNA_CAPABILITY_FIXTURE_TOKEN' });
  assert.equal(fromEnvironment.models[0].inputCapability.status, 'unknown'); assert.equal(fromEnvironment.models[0].input, undefined);
});

for (const action of ['test', 'refreshModels']) test(`${action}: an old API credential response cannot repopulate reusable capability evidence`, async t => {
  let arrived, release;
  const ready = new Promise(resolve => { arrived = resolve; });
  const server = http.createServer((_req, res) => { release = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [declared({ input_modalities: ['text', 'image'] })] })); }; arrived(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const store = fixture(t), p = store.configurationService.provider(null, { name: 'Gated', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'old-fixture', models: [] });
  const pending = store.configurationService[action](p.id); await ready;
  store.configurationService.provider(p.id, { apiKey: 'new-fixture' }); release();
  await assert.rejects(pending, error => error.status === 409);
  const saved = store.configurationService.provider(p.id, { models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 2000 }] });
  assert.equal(saved.models[0].input, undefined); assert.equal(saved.models[0].inputCapability.status, 'unknown');
  assert.equal(resolveModel(store.state.configuration, { providerId: p.id, modelId: 'fixture-model' }).input, undefined);
});
