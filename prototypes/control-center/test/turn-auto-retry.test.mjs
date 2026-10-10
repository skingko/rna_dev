import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.mjs';
import { transientFailure } from '../runtime-controller.mjs';

// Plan 2026-09-30 §2.5 item 5: a transient model failure retries by itself and
// leaves no trace when it then succeeds; a lasting one still asks the user.
// Local HTTP fixture only; no paid calls. Waits are shortened for the test.
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await delay(15); }
  throw new Error('condition did not settle');
}
function stream(res, content) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}
async function setup(t, respond) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-retry-')); let calls = 0;
  const provider = http.createServer(async (request, response) => { for await (const _ of request); calls++; await respond(response, calls); });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const app = createServer({ stateFile: join(directory, '.state', 'state.json'), ticks: false });
  await app.initializer.close();
  t.after(async () => { await app.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const p = app.store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'k', models: [{ id: 'm', contextWindow: 32000, maxOutputTokens: 200, reasoning: ['off'] }] });
  app.store.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'm', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { session } = app.store.createProject({ name: 'Retry', workspace: directory, initiative: { enabled: false } });
  return { app, session, current: () => app.store.state.sessions.find(row => row.id === session.id), calls: () => calls };
}

test('transient failures are recognized; lasting ones are not', () => {
  for (const diagnostic of [{ category: 'rate_limit' }, { category: 'server_unavailable', status: 503 }, { category: 'connection', retryable: true }, { category: 'timeout' }]) assert.equal(transientFailure(diagnostic), true);
  for (const diagnostic of [{ category: 'authentication', status: 401 }, { category: 'quota_exhausted' }, { category: 'invalid_request' }, undefined]) assert.equal(transientFailure(diagnostic), false);
});

test('a 503 that clears up is retried automatically, and the conversation shows no failure', async t => {
  const f = await setup(t, (res, n) => { if (n <= 3) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'overloaded' } })); } stream(res, '好了'); });
  f.app.executor.retryTimers.clear();
  // Shorten the waits for the test; the schedule itself is unchanged.
  const { AUTO_RETRY_DELAYS_MS } = await import('../runtime-controller.mjs');
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, AUTO_RETRY_DELAYS_MS.includes(ms) ? 20 : ms, ...rest);
  t.after(() => { globalThis.setTimeout = realSetTimeout; });
  f.app.store.message(f.session.id, { text: '你好' });
  await until(() => f.current().turns[0]?.status === 'completed');
  const turn = f.current().turns[0];
  assert.equal(turn.retryHistory.length, 1); assert.equal(turn.retryHistory[0].auto, true);
  assert.equal(f.current().items.filter(item => item.kind === 'notice').length, 0, 'no failure or retry notice is left behind');
  assert.equal(f.current().items.findLast(item => item.kind === 'assistant').text, '好了');
});

test('an authentication failure is not retried and tells the user', async t => {
  const f = await setup(t, res => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad key' } })); });
  f.app.store.message(f.session.id, { text: '你好' });
  await until(() => f.current().turns[0]?.status === 'failed');
  await delay(50);
  const turn = f.current().turns[0];
  assert.equal(turn.autoRetry, undefined); assert.equal(f.calls(), 1);
  assert.ok(f.current().items.some(item => item.kind === 'notice' && item.source === 'runtime-error'));
});
