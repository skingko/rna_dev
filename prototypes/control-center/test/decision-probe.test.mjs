import test from 'node:test';
import assert from 'node:assert/strict';
import { stream, setup } from './helpers/gene-fixture.mjs';
import { aggregateCacheUsage } from '../usage-cache-service.mjs';
import { DecisionService } from '../decision-service.mjs';

// A developer probe for studying JEV: one raw System One call with the configured key; answers come back as given.
test('the JEV probe sends state and questions with the configured key and returns the raw answers without the key', async t => {
  const f = await setup(t, (_input, res) => stream(res, 'ok'));
  const original = globalThis.fetch, sent = [];
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('typesafe')) return original(url, options);
    sent.push({ url: String(url), auth: options.headers.Authorization, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { done: { type: 'noul', noul: 0.91 } }, usage: { input_tokens: 120, output_tokens: 0 }, echo: 'Bearer probe-secret-key' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });
  f.app.store.configurationService.secrets['judge:jev'] = 'probe-secret-key';
  const post = body => fetch(f.url('/api/v2/decision-kernel/probe'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async response => ({ status: response.status, body: await response.json() }));
  const out = await post({ state: { task: '把第三章扩写到 3000 字', result: '已写 3120 字' }, questions: { done: { type: 'noul', instructions: 'Did `result` finish `task`?', criteria: { true: 'Finished.', false: 'Not finished.' } } } });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.answers.done.noul, 0.91); assert.equal(out.body.usage.input_tokens, 120); assert.ok(out.body.latencyMs >= 0);
  assert.equal(sent[0].auth, 'Bearer probe-secret-key'); assert.equal(sent[0].body.model, 'jev-latest'); assert.deepEqual(Object.keys(sent[0].body), ['model', 'state', 'questions']);
  assert.ok(!JSON.stringify(out.body).includes('probe-secret-key'), 'the key never comes back');
  // Z2: the probe's usage row says it is one (and names no project or session); a decision the daemon makes keeps its project and says `decision`.
  const ledger = f.app.store.usageLedger, probed = ledger.rows.at(-1);
  assert.deepEqual([probed.purpose, probed.detail, probed.projectId, probed.sessionId, probed.input], ['jev', 'probe', undefined, undefined, 120]);
  new DecisionService(f.app.store).record({ point: 'turn.route', backend: 'typesafe', source: 'jev', mode: 'active', reason: 'ok', networkAttempted: true, usage: { inputTokens: 40, outputTokens: 2 }, answers: {} }, { projectId: 'p-product' }, 'effort');
  const decided = ledger.rows.at(-1);
  assert.deepEqual([decided.purpose, decided.detail, decided.projectId, decided.input], ['jev', 'decision', 'p-product', 40]);
  // A decision outside any project and session (session.resume of a project-less conversation) has no scope to tell it from a probe: its row says so itself.
  new DecisionService(f.app.store).record({ point: 'session.resume', backend: 'typesafe', source: 'jev', mode: 'shadow', reason: 'ok', networkAttempted: true, usage: { inputTokens: 25, outputTokens: 1 }, answers: {} }, {}, 'session_resume');
  const scopeless = ledger.rows.at(-1);
  assert.deepEqual([scopeless.purpose, scopeless.detail, scopeless.projectId, scopeless.sessionId, scopeless.input], ['jev', 'decision', undefined, undefined, 25]);
  const judge = aggregateCacheUsage(ledger.rows, {}).judge;
  assert.deepEqual([judge.probe.requests, judge.probe.input, judge.product.requests, judge.product.input], [1, 120, 2, 65], 'the page can say product judgments 2, probes 1: the scope-less decision is the product\'s');
  assert.equal((await post({ state: 'x', questions: { bad: { type: 'text', instructions: 'x', criteria: {} } } })).status, 400);
  assert.equal((await post({ state: 'x' })).status, 400);
  delete f.app.store.configurationService.secrets['judge:jev']; const saved = process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_API_KEY;
  assert.equal((await post({ state: 'x', questions: { done: { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } } } })).status, 409);
  if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
});
