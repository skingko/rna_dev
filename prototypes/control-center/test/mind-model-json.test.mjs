import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { ProjectMindService } from '../project-mind.mjs';
import { UsageLedger } from '../usage-cache-service.mjs';

// spec p1 effort §3.5 / §3.7: a mind or gene JSON call cut off by its output allowance used to parse to null and read as
// "skip" (EVO-10); it is asked once more with twice the allowance, never past the configured one. Its ledger rows carry
// their own purpose (mind / evolution) with the raw one as detail.
function setup(t, script) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-mind-json-')), store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'mind fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'main', contextWindow: 128000, maxOutputTokens: 8192, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'main', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  store.mutate(state => { state.settings.realTokenBudget = null; });
  const { project } = store.createProject({ name: 'Mind fixture', description: 'x', workspace: directory });
  store.usageLedger = new UsageLedger({});
  const caps = [];
  const mind = new ProjectMindService(store, { decisions: null, provider: async function* (request) { caps.push(request.model.maxOutputTokens); yield* script(caps.length, request); }, sweepIntervalMs: 0, notesIntervalMs: 0 });
  t.after(async () => { await mind.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, mind, project, caps };
}

test('a truncated JSON answer is asked again with twice the allowance; a second cut is null', async t => {
  const f = setup(t, async function* (n) { yield { type: 'text_delta', delta: n === 1 ? '{"rule": "trunc' : '{"rule": "complete"}' }; yield { type: 'usage', usage: { input: 50, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 550 } }; yield { type: 'done', stopReason: n === 1 ? 'length' : 'stop' }; });
  assert.deepEqual(await f.mind.modelJson(f.project.id, { system: 'Return JSON.', input: { a: 1 }, maxOutputTokens: 900, purpose: 'gene-patch' }), { rule: 'complete' });
  assert.deepEqual(f.caps, [900, 1800]);
  assert.deepEqual(f.store.usageLedger.rows.map(row => [row.purpose, row.detail, row.stopReason]), [['evolution', 'gene-patch', 'length'], ['evolution', 'gene-patch', 'stop']]);
  const g = setup(t, async function* () { yield { type: 'text_delta', delta: '{"cut' }; yield { type: 'done', stopReason: 'length' }; });
  assert.equal(await g.mind.modelJson(g.project.id, { system: 'Return JSON.', input: {}, maxOutputTokens: 5000, purpose: 'mind-capture' }), null);
  assert.deepEqual(g.caps, [5000, 8192], 'the retry never passes the configured allowance');
  assert.deepEqual(g.store.usageLedger.rows.map(row => [row.purpose, row.detail, row.estimated]), [['mind', 'mind-capture', true], ['mind', 'mind-capture', true]], 'unreported rows are estimated, not dropped');
  const h = setup(t, async function* () { yield { type: 'text_delta', delta: '{"cut' }; yield { type: 'done', stopReason: 'length' }; });
  await h.mind.modelJson(h.project.id, { system: 'Return JSON.', input: {}, maxOutputTokens: 8192, purpose: 'mind' });
  assert.deepEqual(h.caps, [8192], 'already at the configured allowance: no retry');
});
