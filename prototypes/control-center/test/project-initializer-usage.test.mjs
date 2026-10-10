import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { CapabilityService } from '../capability-service.mjs';
import { ProjectInitializer } from '../test-support/marketplace-isolation.mjs';
import { projectGenomeFixture } from '../../../packages/sdk/test/fixtures/project-genome-fixture.mjs';
const valid = () => ({ overview: '初始化计量项目', focus: '核对各轮消费', facts: [], openQuestions: [], milestones: [], assignments: { skillIds: [], toolIds: [], mcpServerIds: [], reasons: [] }, unmetCapabilities: [], genome: projectGenomeFixture() });
const until = async fn => { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw Error('Timed out'); await new Promise(done => setTimeout(done, 10)); } };
async function fixture(t, mode, { maxOutputTokens = 8192, reasoning = 'off' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-bootstrap-usage-')), store = new Store(join(dir, 'state.json')), requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; requests.push(JSON.parse(raw));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (requests.length === 1) {
      if (mode === 'cap') store.settings({ realTokenBudget: 26 });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\ndata: [DONE]\n\n`);
    } else if (mode === 'cancel') { res.write(': started\n\n'); }
    else res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(valid()) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  }); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const provider = store.configurationService.provider(null, { name: 'fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens, reasoning: ['off', 'high'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning } });
  const initializer = new ProjectInitializer(store, new CapabilityService(store));
  t.after(async () => { await initializer.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); rmSync(dir, { recursive: true, force: true }); });
  store.createProject({ name: '预算分轮结算', workspace: dir, initialize: true });
  return { store, initializer, requests };
}

test('actual bootstrap cancellation after a reported first repair accounts the unreported second request', async t => {
  const { store, initializer, requests } = await fixture(t, 'cancel'); await until(() => requests.length === 2);
  const reserved = store.state.realUsage.reservedTokens; assert.ok(reserved > 0); assert.equal(store.state.realUsage.reportedTokens, 25);
  await initializer.close(); const usage = store.state.realUsage, initialization = store.state.projects[0].initialization;
  assert.equal(initialization.status, 'paused'); assert.equal(usage.reportedTokens, 25); assert.equal(usage.estimatedTokens, reserved); assert.equal(usage.tokens, 25 + reserved); assert.equal(usage.reservedTokens, 0); assert.equal(initialization.usage.totalTokens, usage.tokens); assert.equal(initialization.usage.estimatedTokens, reserved); assert.equal(store.state.usage.tokens, 0);
});

test('actual bootstrap missing final usage on a successful repair is estimated and preserved separately', async t => {
  const { store, requests } = await fixture(t, 'missing'); await until(() => store.state.projects[0].initialization.status === 'ready');
  const usage = store.state.realUsage, initialization = store.state.projects[0].initialization;
  assert.equal(requests.length, 2); assert.equal(usage.reportedTokens, 25); assert.ok(usage.estimatedTokens > 8192); assert.equal(usage.tokens, 25 + usage.estimatedTokens); assert.equal(usage.reservedTokens, 0); assert.equal(initialization.usage.estimatedTokens, usage.estimatedTokens);
});

test('actual bootstrap pays reported attempt then denies repair before another HTTP request exceeds explicit cap', async t => {
  const { store, requests } = await fixture(t, 'cap'); await until(() => store.state.projects[0].initialization.status === 'failed');
  assert.equal(requests.length, 1); assert.equal(store.state.projects[0].initialization.code, 'budget'); assert.equal(store.state.realUsage.tokens, 25); assert.equal(store.state.realUsage.estimatedTokens, 0); assert.equal(store.state.realUsage.reservedTokens, 0); assert.equal(store.state.projects[0].initialization.usage.totalTokens, 25);
});

test('host bootstrap and its repair transmit the configured reasoning and output allowance without a phase ceiling', async t => {
  const { store, requests } = await fixture(t, 'missing', { maxOutputTokens: 32768, reasoning: 'high' });
  await until(() => store.state.projects[0].initialization.status === 'ready');
  assert.equal(requests.length, 2);
  for (const request of requests) { assert.equal(request.max_completion_tokens, 32768); assert.equal(request.reasoning_effort, 'high'); }
  assert.ok(store.state.realUsage.estimatedTokens > 32768);
  assert.equal(store.state.realUsage.reservedTokens, 0);
});
