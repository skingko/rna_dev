import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { streamCompletion } from '../src/providers.mjs';
import { createSession } from '../src/session.mjs';
import { providerDiagnostic } from '../src/provider-diagnostics.mjs';

const secret = 'fixture-private-credential-and-user-body';
const model = { providerId: 'diagnostic-fixture', modelId: 'glm-5.3-flashx', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', contextWindow: 32000, maxOutputTokens: 200, reasoning: 'low' };
const denied = { status: 429, providerCode: '1311', category: 'model_access_denied', retryable: false };
const request = { model, apiKey: secret, messages: [{ role: 'user', content: [{ type: 'text', text: 'tiny fixture request' }] }] };
function ok(response, text = 'OK') {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
}
function refusal(response, code = '1311', status = 429) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '0' });
  response.end(JSON.stringify({ error: { code, message: secret }, privateRequest: secret }));
}
async function fixture(t, respond) {
  let calls = 0;
  const server = http.createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; await respond(JSON.parse(raw), res, ++calls); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const fetchFixture = (_url, options) => fetch(`http://127.0.0.1:${server.address().port}/chat/completions`, options);
  return { calls: () => calls, fetch: fetchFixture, provider: input => streamCompletion({ ...input, fetch: fetchFixture }) };
}
async function sessionFixture(t, provider, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-provider-diagnostic-'));
  const events = [];
  const session = await createSession({ sessionId: 'safe-diagnostics', cwd: dir, stateDir: join(dir, 'state'), model, apiKey: secret, provider, onEvent: event => events.push(event), ...options });
  t.after(async () => { await session.dispose(); await rm(dir, { recursive: true, force: true }); });
  return { session, events };
}

test('official GLM Coding 429/1311 is an entitlement rejection: one tiny HTTP request, no retry, no raw body', async t => {
  const endpoint = await fixture(t, (_input, res) => refusal(res));
  const events = [];
  await assert.rejects(async () => { for await (const event of streamCompletion({ ...request, fetch: endpoint.fetch })) events.push(event); }, error => {
    assert.equal(error.code, 'http_error'); assert.equal(error.status, 429); assert.equal(error.retryable, false);
    assert.deepEqual(error.errorDiagnostic, denied); assert.ok(!JSON.stringify(error).includes(secret)); return true;
  });
  assert.equal(endpoint.calls(), 1); assert.equal(events.filter(event => event.type === 'retry').length, 0);
});

for (const baseUrl of ['https://proxy.example/api/coding/paas/v4', 'https://open.bigmodel.cn:444/api/coding/paas/v4', 'https://open.bigmodel.cn/api/paas/v4']) test(`1311 meaning is not guessed on unverified route ${baseUrl}`, async t => {
  const endpoint = await fixture(t, (_input, res) => refusal(res));
  await assert.rejects(Array.fromAsync(streamCompletion({ ...request, model: { ...model, baseUrl }, fetch: endpoint.fetch, maxRetries: 1 })), error => error.errorDiagnostic.category === 'rate_limit' && error.retryable === true);
  assert.equal(endpoint.calls(), 2);
});

test('actual rate limiting retries a rejected request then completes; retry receipts are safe', async t => {
  const endpoint = await fixture(t, (_input, res, call) => call === 1 ? refusal(res, 'rate_limit_exceeded') : ok(res));
  const events = await Array.fromAsync(streamCompletion({ ...request, fetch: endpoint.fetch }));
  assert.equal(endpoint.calls(), 2); assert.equal(events.at(-1).type, 'done');
  assert.deepEqual(events.find(event => event.type === 'retry').errorDiagnostic, { status: 429, providerCode: 'rate_limit_exceeded', category: 'rate_limit', retryable: true });
  assert.ok(!JSON.stringify(events).includes(secret));
});

test('unknown error identifiers and oversized error bodies never enter diagnostics; bounded reader cancels', async t => {
  const endpoint = await fixture(t, (_input, res) => refusal(res, secret, 401));
  await assert.rejects(Array.fromAsync(streamCompletion({ ...request, fetch: endpoint.fetch })), error => {
    assert.deepEqual(error.errorDiagnostic, { status: 401, category: 'authentication', retryable: false }); assert.ok(!JSON.stringify(error).includes(secret)); return true;
  });
  let cancelled = false;
  await assert.rejects(Array.fromAsync(streamCompletion({ ...request, fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(secret.repeat(1000))); }, cancel() { cancelled = true; } }), { status: 403 }) })), error => error.status === 403 && error.errorDiagnostic.category === 'permission');
  assert.equal(cancelled, true);
  assert.equal(providerDiagnostic({ errorDiagnostic: { category: secret, message: secret, providerCode: secret } }), undefined);
});

test('normal SDK failure preserves a safe provider diagnostic in exception, message and settled journal', async t => {
  const endpoint = await fixture(t, (_input, res) => refusal(res));
  const { session, events } = await sessionFixture(t, endpoint.provider);
  await assert.rejects(session.prompt('tiny request'), error => { assert.equal(error.status, 429); assert.deepEqual(error.errorDiagnostic, { ...denied, purpose: 'response' }); return true; });
  assert.equal(endpoint.calls(), 1);
  const snapshot = session.snapshot();
  assert.deepEqual(snapshot.messages.at(-1).errorDiagnostic, { ...denied, purpose: 'response' });
  const journal = await readFile(snapshot.sessionFile, 'utf8');
  assert.match(journal, /"run_settled"/); assert.ok(!journal.includes(secret)); assert.ok(!JSON.stringify(events).includes(secret));
});

test('generated compaction failure retains history and carries safe diagnostic to receipt and caller', async t => {
  const endpoint = await fixture(t, (input, res) => input.messages[0].content.startsWith('Summarize the provided') ? refusal(res) : ok(res, 'Verified local evidence. '.repeat(50)));
  const { session, events } = await sessionFixture(t, endpoint.provider);
  for (let i = 0; i < 3; i++) await session.prompt(`seed ${i}`);
  const before = session.snapshot();
  await assert.rejects(session.compact({ generate: true, keepLastTurns: 1 }), error => {
    assert.equal(error.status, 429); assert.deepEqual(error.errorDiagnostic, { ...denied, purpose: 'compaction' }); return true;
  });
  assert.equal(endpoint.calls(), 4); assert.deepEqual(session.snapshot().messages, before.messages); assert.equal(session.snapshot().compaction, null);
  assert.deepEqual(events.findLast(event => event.type === 'compaction_request_end').errorDiagnostic, { ...denied, purpose: 'compaction' });
  const journal = await readFile(session.snapshot().sessionFile, 'utf8'); assert.ok(!journal.includes(secret)); assert.match(journal, /"purpose":"compaction"/);
});
