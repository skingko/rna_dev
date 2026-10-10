import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionService } from '../decision-service.mjs';
import { Store } from '../store.mjs';

// UX audit 2026-10-03 (settings): a refused JEV key, models still in use, the demo provider name.
function judge() {
  let clock = 1_000_000;
  const store = { state: { settings: {}, configuration: { decisionKernel: {} }, projects: [], sessions: [] }, configurationService: { secrets: { 'judge:jev': 'TEST-ONLY-OLD' }, writeSecret(id, input) { if (input.apiKey !== undefined) this.secrets[id] = input.apiKey; } }, mutate(fn) { return fn(this.state); } };
  const service = new DecisionService(store, { now: () => clock, kernelFactory: () => ({ close() {}, async decide() { throw new Error('no judge in this test'); } }) });
  const row = (reason, extra = {}) => { (store.state.decisionKernelRuntime ??= { recent: [] }).recent.push({ id: `r${clock}`, at: clock, point: 'mind.judge', backend: 'typesafe', source: 'fallback', reason, networkAttempted: true, scope: {}, ...extra }); clock += 1000; };
  return { service, store, row, advance(ms) { clock += ms; } };
}

test('a saved JEV key reads as refused when JEV last refused it, and only since it was saved', () => {
  const f = judge();
  f.row('auth');
  assert.equal(f.service.public().credential.state, 'invalid', 'a refusal of the saved key shows');
  assert.equal(f.service.public().status, 'ready', 'status keeps meaning "a judge is configured"');
  f.advance(1000); f.service.update({ apiKey: 'TEST-ONLY-NEW' });
  assert.deepEqual(f.service.public().credential, { state: 'unverified' }, 'an earlier key\'s refusals do not mark the new one');
  f.row('timeout'); f.row('circuit_open', { networkAttempted: false });
  assert.equal(f.service.public().credential.state, 'unverified', 'timeouts and an open circuit say nothing about the key');
  f.row('accepted');
  assert.equal(f.service.public().credential.state, 'valid');
  f.row('payment_required');
  assert.deepEqual(f.service.public().credential, { state: 'payment_required', at: f.service.public().credential.at, source: 'ledger', reason: 'payment_required' });
  f.row('shadow');
  assert.equal(f.service.public().credential.state, 'valid', 'a later answer clears it');
  f.row('auth', { backend: 'llm' });
  assert.equal(f.service.public().credential.state, 'valid', 'fast-model judge failures are not JEV key failures');
  f.service.update({ apiKey: '' });
  assert.equal(f.service.public().credential, null, 'no key, nothing to report');
});

test('the credential check on save sends one minimal question with the saved key and marks the key', async t => {
  const f = judge(), original = globalThis.fetch, sent = [];
  let status = 401;
  globalThis.fetch = async (url, options) => { sent.push({ url: String(url), auth: options.headers.Authorization, body: JSON.parse(options.body) }); return new Response(JSON.stringify(status === 200 ? { answers: { reachable: { type: 'noul', noul: 0.99 } }, usage: { input_tokens: 30, output_tokens: 0 } } : { error: 'bad key' }), { status }); };
  t.after(() => { globalThis.fetch = original; });
  f.service.update({ apiKey: 'TEST-ONLY-NEW' });
  const refused = await f.service.probe({ check: 'credential' });
  assert.equal(refused.status, 401); assert.equal(refused.credential.state, 'invalid'); assert.equal(refused.credential.source, 'check');
  assert.equal(sent.length, 1); assert.equal(sent[0].auth, 'Bearer TEST-ONLY-NEW'); assert.deepEqual(Object.keys(sent[0].body.questions), ['reachable']);
  assert.ok(!JSON.stringify(refused).includes('TEST-ONLY-NEW'));
  assert.equal(f.service.public().credential.state, 'invalid');
  status = 200; f.advance(1000);
  assert.equal((await f.service.probe({ check: 'credential' })).credential.state, 'valid');
  f.advance(1000); f.service.update({ apiKey: 'TEST-ONLY-OTHER' });
  assert.equal(f.service.public().credential.state, 'unverified', 'a check of the previous key does not carry over');
  await assert.rejects(f.service.probe({ check: 'credential', state: 'x' }), /state 与 questions|state 和/);
});

function store(t) { const dir = mkdtempSync(join(tmpdir(), 'rna-ux-settings-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return new Store(join(dir, 'state.json')); }
const model = id => ({ id, name: `模型 ${id}`, contextWindow: 64000, maxOutputTokens: 4000, reasoning: ['off', 'high'] });

test('removing a model the default model or a session still uses names the holder', t => {
  const s = store(t), config = s.configurationService;
  const p = config.provider(null, { name: '本地测试', protocol: 'openai', baseUrl: 'http://127.0.0.1:9000/v1', models: [model('a'), model('b')] });
  config.update({ defaultModel: { providerId: p.id, modelId: 'a', reasoning: 'auto' } });
  assert.throws(() => config.provider(p.id, { models: [model('b')] }), error => error.status === 409 && /「模型 a」是默认模型/.test(error.message) && /默认模型/.test(error.message));
  const { session } = s.createProject({}); s.updateSession(session.id, { title: '周报整理', modelSelection: { providerId: p.id, modelId: 'b', reasoning: 'auto' } });
  config.update({ defaultModel: { providerId: 'demo', modelId: 'demo', reasoning: 'auto' } });
  s.updateSession(session.id, { archived: true });
  assert.throws(() => config.provider(p.id, { models: [model('a')] }), error => error.status === 409 && error.message.includes('「模型 b」仍被会话使用：《周报整理》（已归档），'));
  assert.throws(() => config.provider(p.id, {}, true), error => error.status === 409 && error.message.includes('《周报整理》（已归档）'));
  s.mutate(state => { state.settings.interfaceLanguage = 'en'; });
  assert.throws(() => config.provider(p.id, {}, true), error => error.message.includes('“周报整理” (archived)'));
  s.mutate(state => { delete state.settings.interfaceLanguage; });
  // Unused models still go, and a provider nobody holds is deleted.
  s.updateSession(session.id, { archived: false }); s.updateSession(session.id, { modelSelection: { providerId: 'demo', modelId: 'demo', reasoning: 'auto' } });
  assert.deepEqual(config.provider(p.id, { models: [model('a')] }).models.map(row => row.id), ['a']);
  assert.equal(config.provider(p.id, {}, true).deleted, true);
});

test('the built-in demo provider reads with the current product name in the interface language', t => {
  const s = store(t);
  s.mutate(state => { state.configuration.providers.find(row => row.id === 'demo').name = 'Pi · 演示'; });
  const reopened = new Store(s.file);
  assert.equal(reopened.configurationService.public().providers.find(row => row.id === 'demo').name, 'Rna · 演示');
  assert.equal(reopened.state.configuration.providers.find(row => row.id === 'demo').name, 'Rna · 演示', 'session labels read the stored name');
  reopened.mutate(state => { state.settings.interfaceLanguage = 'en'; });
  const demo = reopened.configurationService.public().providers.find(row => row.id === 'demo');
  assert.equal(demo.name, 'Rna · Demo'); assert.equal(demo.models[0].name, 'Demo model');
});
