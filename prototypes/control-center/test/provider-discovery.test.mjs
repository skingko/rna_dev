import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { Store } from '../store.mjs';
import { normalizeDiscoveredModel } from '../provider-discovery.mjs';
import { providerPreset } from '../provider-presets.mjs';
import { resolveModel } from '../configuration.mjs';
function fixture(t) { const dir = mkdtempSync(join(tmpdir(), 'rna-discovery-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return new Store(join(dir, 'state.json')); }
async function server(t, handler) { const instance = http.createServer(handler); await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); })); return `http://127.0.0.1:${instance.address().port}/v1`; }
const send = (res, data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
test('known IDs receive endpoint-bound official capabilities, unknown IDs do not inherit namesakes', () => {
  const known = normalizeDiscoveredModel(providerPreset('glm-coding'), { id: 'glm-5.3' });
  assert.equal(known.contextWindow, 1000000); assert.equal(known.modelMaxOutputTokens, 131072); assert.equal(known.readyForAgent, true); assert.deepEqual(known.reasoning, ['low', 'high', 'max']); assert.equal(known.reasoningCapability.control, 'effort'); assert.equal(known.reasoningCapability.canDisable, false);
  const proxy = normalizeDiscoveredModel({ protocol: 'openai', baseUrl: 'https://untrusted.example/v1' }, { id: 'glm-5.3' });
  assert.equal(proxy.contextWindow, undefined); assert.equal(proxy.modelMaxOutputTokens, undefined); assert.equal(proxy.readyForAgent, false); assert.equal(proxy.toolCall, null);
});
test('provider capacity is field-specific and wins over official defaults; malformed values never fill missing capability', () => {
  const row = normalizeDiscoveredModel(providerPreset('glm'), { id: 'glm-5.3', context_length: 500000, max_output_tokens: '12000' });
  assert.equal(row.contextWindow, 500000); assert.equal(row.modelMaxOutputTokens, 131072); assert.deepEqual(row.limitsSource, { contextWindow: 'provider-catalog', modelMaxOutputTokens: 'verified-preset' });
  for (const value of [null, 0, -1, '64000', Infinity, 1.4, 10000001]) {
    const unknown = normalizeDiscoveredModel({}, { id: 'unlisted', context_length: value, max_output_tokens: value, tool_call: true }); assert.equal(unknown.readyForAgent, false); assert.equal(unknown.contextWindow, undefined);
  }
});
test('refresh is a catalog-only GET, adds tool-ready models, and preserves custom choices/defaults/evidence identity', async t => {
  const calls = [], baseUrl = await server(t, (req, res) => { calls.push([req.method, req.url, req.headers.authorization]); send(res, { data: [
    { id: 'existing', context_length: 1000000, max_output_tokens: 128000, tool_call: true },
    { id: 'new', context_length: 64000, max_output_tokens: 16000, tool_call: true },
    { id: 'unknown' }, { id: 'embedding', context_length: 64000, max_output_tokens: 8000, tool_call: false },
    { id: 'unknown-tools', context_length: 64000, max_output_tokens: 8000 }
  ] }); });
  const store = fixture(t), p = store.configurationService.provider(null, { name: 'Fixture', baseUrl, apiKey: 'secret-fixture', models: [{ id: 'existing', contextWindow: 32000, maxOutputTokens: 4000 }] });
  const before = structuredClone(store.state.configuration), result = await store.configurationService.refreshModels(p.id), after = store.state.configuration.providers.find(x => x.id === p.id);
  assert.deepEqual(calls, [['GET', '/v1/models', 'Bearer secret-fixture']]); assert.deepEqual(result.added, ['new']); assert.equal(result.skipped.length, 3);
  assert.equal(after.models[0].contextWindow, 32000); assert.equal(after.models[0].maxOutputTokens, 4000); assert.equal(after.models[0].modelMaxOutputTokens, 128000);
  assert.equal(after.evidenceRevision, before.providers.find(x => x.id === p.id).evidenceRevision); assert.equal(after.updatedAt, before.providers.find(x => x.id === p.id).updatedAt); assert.deepEqual(store.state.configuration.defaultModel, before.defaultModel);
  assert.ok(!JSON.stringify(result).includes('secret-fixture')); assert.equal(after.models[1].limitsSource.contextWindow, 'provider-catalog');
  const reopened = new Store(store.file); assert.equal(reopened.state.configuration.providers.find(x => x.id === p.id).modelDiscovery.discovered, 5);
});
test('a model the user removes stays removed when the listing is read again, until it is saved again', async t => {
  // Live, 2026-10-10: the editor reads the listing right after each save, and that read added every removed model back.
  const listed = ['keep', 'unwanted', 'later'].map(id => ({ id, context_length: 64000, max_output_tokens: 8000, tool_call: true }));
  const baseUrl = await server(t, (_req, res) => send(res, { data: listed }));
  const store = fixture(t), service = store.configurationService, p = service.provider(null, { name: 'Fixture', baseUrl, models: [] });
  const first = await service.refreshModels(p.id); assert.deepEqual(first.added, ['keep', 'unwanted', 'later']); assert.deepEqual(first.declined, []);
  const rows = ids => store.state.configuration.providers.find(x => x.id === p.id).models.filter(row => ids.includes(row.id)).map(row => ({ id: row.id, contextWindow: row.contextWindow, maxOutputTokens: row.maxOutputTokens }));
  const saved = service.provider(p.id, { models: rows(['keep', 'later']) }); assert.deepEqual(saved.removedModels, ['unwanted']);
  const again = await service.refreshModels(p.id);
  assert.deepEqual(again.added, []); assert.deepEqual(again.declined, ['unwanted']); assert.deepEqual(again.skipped, []); assert.match(again.message, /你移除的 1 个模型没有加回/);
  assert.deepEqual(again.provider.models.map(row => row.id), ['keep', 'later']); assert.equal(again.provider.modelDiscovery.unknown, 0);
  // A model the provider starts listing afterwards is still added; an edit that leaves the catalog alone forgets nothing.
  listed.push({ id: 'released', context_length: 64000, max_output_tokens: 8000, tool_call: true });
  service.provider(p.id, { name: 'Renamed' });
  assert.deepEqual((await service.refreshModels(p.id)).added, ['released']);
  assert.deepEqual(new Store(store.file).state.configuration.providers.find(x => x.id === p.id).removedModels, ['unwanted']);
  // Saving the model again puts it back and it is refreshed like any other.
  const restored = service.provider(p.id, { models: [...rows(['keep', 'later', 'released']), { id: 'unwanted', contextWindow: 64000, maxOutputTokens: 8000 }] });
  assert.equal(restored.removedModels, undefined); assert.deepEqual((await service.refreshModels(p.id)).declined, []);
  assert.deepEqual(store.state.configuration.providers.find(x => x.id === p.id).models.map(row => row.id), ['keep', 'later', 'released', 'unwanted']);
  // Another endpoint's listing owes nothing to ids removed on this one.
  service.provider(p.id, { models: rows(['keep']) }); assert.deepEqual(store.state.configuration.providers.find(x => x.id === p.id).removedModels, ['later', 'released', 'unwanted']);
  const elsewhere = await server(t, (_req, res) => send(res, { data: listed }));
  assert.equal(service.provider(p.id, { baseUrl: elsewhere }).removedModels, undefined);
  assert.deepEqual((await service.refreshModels(p.id)).added, ['unwanted', 'later', 'released']);
});
test('managed capacities synchronize, manual edit opts out, output and active turns remain pinned', async t => {
  let capacity = 64000; const baseUrl = await server(t, (_req, res) => send(res, { data: [{ id: 'remote', context_length: capacity, max_output_tokens: 16000, tool_call: true }] }));
  const store = fixture(t), p = store.configurationService.provider(null, { name: 'Fixture', baseUrl, models: [] }); await store.configurationService.refreshModels(p.id);
  store.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'remote', reasoning: 'off' } });
  const idle = store.createSession({}), active = store.createSession({}); store.message(active.id, { text: 'Pinned' });
  const identity = store.state.configuration.providers.find(x => x.id === p.id).evidenceRevision; capacity = 128000;
  const result = await store.configurationService.refreshModels(p.id); assert.deepEqual(result.updated, ['remote']); assert.equal(result.provider.evidenceRevision, identity);
  assert.equal(store.state.sessions.find(x => x.id === idle.id).context.capacity, 128000); assert.equal(store.state.sessions.find(x => x.id === active.id).turns[0].modelConfig.contextWindow, 64000);
  assert.equal(result.provider.models[0].maxOutputTokens, 8192);
  store.configurationService.provider(p.id, { models: [{ id: 'remote', contextWindow: 90000, maxOutputTokens: 3000 }] }); capacity = 256000;
  const manual = await store.configurationService.refreshModels(p.id); assert.equal(manual.provider.models[0].contextWindow, 90000); assert.equal(manual.provider.models[0].maxOutputTokens, 3000); assert.deepEqual(manual.preserved[0], { id: 'remote', fields: ['contextWindow'] });
});
test('concurrent credential/configuration edits reject discovery without overwriting user changes', async t => {
  let release; const arrived = new Promise(resolve => { release = resolve; }); let reply;
  const baseUrl = await server(t, (_req, res) => { reply = () => send(res, { data: [{ id: 'new', context_length: 64000, max_output_tokens: 8000, tool_call: true }] }); release(); });
  const store = fixture(t), p = store.configurationService.provider(null, { name: 'Fixture', baseUrl, models: [] });
  const pending = store.configurationService.refreshModels(p.id); await arrived;
  store.configurationService.provider(p.id, { apiKey: 'changed-secret' }); reply(); await assert.rejects(pending, error => error.status === 409);
  assert.equal(store.state.configuration.providers.find(x => x.id === p.id).models.length, 0);
});
test('Anthropic listing pagination is bounded, deduplicated and never forwards keys to provider-supplied URLs', async t => {
  const urls = [], baseUrl = await server(t, (req, res) => { urls.push(req.url); assert.equal(req.headers['x-api-key'], 'fixture-key'); send(res, req.url.includes('?') ? { data: [{ id: 'a' }, { id: 'b' }], has_more: false } : { data: [{ id: 'a' }], has_more: true, last_id: 'a', next: 'https://attacker.example/steal' }); });
  const store = fixture(t), p = store.configurationService.provider(null, { name: 'Anthropic', protocol: 'anthropic', baseUrl, apiKey: 'fixture-key', models: [] });
  const before = structuredClone(store.state.configuration), result = await store.configurationService.test(p.id);
  assert.deepEqual(urls, ['/v1/models', '/v1/models?after_id=a']); assert.deepEqual(result.models.map(x => x.id), ['a', 'b']); assert.deepEqual(store.state.configuration, before);
});
test('current automatic input capabilities agree in public and new resolution without changing saved legacy settings', t => {
  const store = fixture(t), p = store.configurationService.provider(null, { presetId: 'glm' });
  store.mutate(state => { const saved = state.configuration.providers.find(x => x.id === p.id); delete saved.models[0].input; delete saved.models[0].compat; });
  const saved = store.state.configuration.providers.find(x => x.id === p.id);
  const before = structuredClone(saved);
  const resolved = resolveModel(store.state.configuration, { providerId: p.id, modelId: 'glm-5.3' }); assert.deepEqual(resolved.input, ['text']); assert.equal(resolved.compat, undefined);
  assert.deepEqual(store.configurationService.public().providers.find(x => x.id === p.id).models[0].input, ['text']);
  assert.deepEqual(saved, before);
});
test('missing official listing route uses labeled bundled metadata; auth failure never becomes success', async t => {
  let status = 404; const urls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { urls.push(String(url)); assert.equal(options.redirect, 'manual'); return new Response('{}', { status }); });
  const store = fixture(t), p = store.configurationService.provider(null, { presetId: 'glm-coding', apiKey: 'fixture' });
  const result = await store.configurationService.test(p.id); assert.equal(result.connectionVerified, false); assert.equal(result.catalogSource, 'official-presets'); assert.equal(result.models[0].contextWindow, 1000000); assert.match(result.message, /尚未验证/);
  status = 401; await assert.rejects(store.configurationService.refreshModels(p.id), error => error.upstreamStatus === 401); assert.equal(urls.length, 2);
});
test('legacy GLM capacity-only updates stay capacity-only after a new bundled catalog is introduced', t => {
  const store = fixture(t), p = store.configurationService.provider(null, { name: 'Legacy GLM', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', models: [{ id: 'glm-5.3', contextWindow: 120000, maxOutputTokens: 32768, reasoning: ['xhigh'] }] });
  store.mutate(state => { const old = state.configuration.providers.find(x => x.id === p.id); delete old.models[0].catalogVersion; delete old.models[0].input; delete old.models[0].compat; old.models[0].modelMaxOutputTokens = null; old.models[0].limitsSource = { contextWindow: 'custom', maxOutputTokens: 'custom', modelMaxOutputTokens: 'unknown' }; });
  const old = store.state.configuration.providers.find(x => x.id === p.id);
  const before = structuredClone(old), updated = store.configurationService.provider(p.id, { models: [{ id: 'glm-5.3', contextWindow: 1000000 }] });
  assert.equal(updated.evidenceRevision, before.evidenceRevision);
  const saved = store.state.configuration.providers.find(x => x.id === p.id); assert.equal(saved.models[0].compat, undefined); assert.equal(saved.models[0].input, undefined); assert.equal(saved.models[0].modelMaxOutputTokens, null); assert.deepEqual(saved.models[0].reasoning, ['xhigh']);
});
test('official Qwen workspace endpoints use regional specs while lookalike hosts and Token Plan routes do not', () => {
  const row = url => normalizeDiscoveredModel({ protocol: 'openai', baseUrl: url }, { id: 'qwen3.8-max' });
  assert.equal(row('https://workspace123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1').contextWindow, 1000000);
  assert.equal(row('https://workspace123.cn-beijing.maas.aliyuncs.com.attacker.test/compatible-mode/v1').contextWindow, undefined);
  assert.equal(row('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1').contextWindow, undefined);
});
