import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/index.mjs';
import { buildRequest } from '../src/providers.mjs';

const main = { providerId: 'main', modelId: 'main-model', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', contextWindow: 200000, maxOutputTokens: 1000, reasoning: 'default' };
const fast = { providerId: 'fast', modelId: 'fast-model', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 64000, maxOutputTokens: 500, reasoning: 'off' };
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rna-model-change-')), requests = [], handles = [];
  const provider = options.provider ?? async function* (request) {
    requests.push(request);
    if (request.model.modelId === 'main-model') { yield { type: 'thinking_delta', delta: 'private chain' }; yield { type: 'thinking_signature', signature: 'sig-main' }; }
    yield { type: 'text_delta', delta: `answer from ${request.model.modelId}` }; yield { type: 'usage', usage: { input: 10, output: 2, totalTokens: 12 } }; yield { type: 'done', stopReason: 'stop' };
  };
  const create = async value => { const session = await createSession({ cwd: root, stateDir: join(root, 'sessions'), model: main, apiKey: 'main-secret-key', provider, ...options, ...value }); handles.push(session); return session; };
  t.after(async () => { await Promise.allSettled(handles.map(session => session.dispose())); await rm(root, { recursive: true, force: true }); });
  return { root, requests, create };
}
const records = async file => (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));

test('a turn-boundary model switch journals model_change once, keeps one history and never replays foreign thinking', async t => {
  const app = await setup(t), session = await app.create();
  await session.prompt('first');
  assert.deepEqual(session.setModel(fast, { apiKey: 'fast-secret-key', reason: 'auto_fast_model' }), { from: { providerId: 'main', modelId: 'main-model' }, to: { providerId: 'fast', modelId: 'fast-model' }, changed: true });
  assert.deepEqual(session.snapshot().model, { providerId: 'fast', modelId: 'fast-model' });
  await session.prompt('second');
  const second = app.requests[1];
  assert.equal(second.model.modelId, 'fast-model'); assert.equal(second.apiKey, 'fast-secret-key');
  assert.equal(JSON.stringify(second.messages).includes('private chain'), false, 'another model reasoning is not replayed');
  assert.ok(second.messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('answer from main-model')), 'the answer text remains history');
  // Back on the main model its own signed thinking is projected again (stable prefix per model).
  session.setModel(main, { apiKey: 'main-secret-key', reason: 'user' });
  await session.prompt('third');
  const third = app.requests[2];
  assert.ok(JSON.stringify(third.messages).includes('sig-main')); assert.equal(buildRequest({ model: main, systemPrompt: third.systemPrompt, messages: third.messages, tools: [] }).body.messages.length > 0, true);
  const changes = (await records(session.snapshot().sessionFile)).filter(row => row.type === 'model_change').map(row => row.data);
  assert.deepEqual(changes, [{ from: { providerId: 'main', modelId: 'main-model' }, to: { providerId: 'fast', modelId: 'fast-model' }, reason: 'auto_fast_model' }, { from: { providerId: 'fast', modelId: 'fast-model' }, to: { providerId: 'main', modelId: 'main-model' }, reason: 'user' }]);
  assert.equal((await readFile(session.snapshot().sessionFile, 'utf8')).includes('fast-secret-key'), false, 'the new credential joins the redactor');
  // A reopened session (resume on a different configured model) journals the change lazily.
  const file = session.snapshot().sessionFile, sessionId = session.snapshot().sessionId; await session.dispose();
  const reopened = await app.create({ sessionFile: file, sessionId, model: fast, apiKey: 'fast-secret-key' });
  await reopened.prompt('fourth');
  assert.deepEqual((await records(file)).filter(row => row.type === 'model_change').at(-1).data, { from: { providerId: 'main', modelId: 'main-model' }, to: { providerId: 'fast', modelId: 'fast-model' }, reason: 'session_model' });
});

test('setModel is refused inside a run, without a credential for another provider, or with an invalid reason', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const app = await setup(t, { provider: async function* () { await gate; yield { type: 'text_delta', delta: 'ok' }; yield { type: 'done', stopReason: 'stop' }; } });
  const session = await app.create();
  assert.throws(() => session.setModel(fast), { code: 'invalid_options' });
  assert.throws(() => session.setModel({ ...main, modelId: 'other' }, { reason: 'Bad Reason' }), { code: 'invalid_options' });
  const running = session.prompt('hold');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.throws(() => session.setModel({ ...main, modelId: 'other' }), { code: 'model_change_busy' });
  release(); await running;
  assert.equal(session.setModel({ ...main, modelId: 'other' }).changed, true);
});

test('step-limit summaries are metered as the summary purpose', async t => {
  const purposes = [];
  const app = await setup(t, { maxSteps: 1, stepLimitBehavior: 'summarize', model: fast, apiKey: 'k',
    tools: [{ name: 'inspect', effect: 'read', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' }],
    provider: async function* (request) { purposes.push(request.purpose ?? null); const summary = request.purpose === 'summary'; if (!summary) yield { type: 'tool_call', id: 'call-1', name: 'inspect', arguments: {} }; else yield { type: 'text_delta', delta: 'summary' }; yield { type: 'done', stopReason: summary ? 'stop' : 'toolUse' }; } });
  const session = await app.create(); await session.prompt('go');
  assert.deepEqual(purposes, [null, 'summary']);
});

test('Anthropic projection maps foreign tool ids deterministically and leaves valid ids unchanged', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }, { role: 'assistant', content: [{ type: 'toolCall', id: 'functions.read:0', name: 'read', arguments: {} }, { type: 'toolCall', id: 'toolu_ok', name: 'read', arguments: {} }] },
    { role: 'toolResult', toolCallId: 'functions.read:0', content: [{ type: 'text', text: 'a' }] }, { role: 'toolResult', toolCallId: 'toolu_ok', content: [{ type: 'text', text: 'b' }] }];
  const body = buildRequest({ model: main, messages, tools: [] }).body, ids = body.messages[1].content.map(block => block.id), results = body.messages[2].content.map(block => block.tool_use_id);
  assert.match(ids[0], /^toolu_[a-f0-9]{24}$/); assert.equal(ids[1], 'toolu_ok'); assert.deepEqual(results, ids);
  assert.equal(buildRequest({ model: main, messages, tools: [] }).body.messages[1].content[0].id, ids[0]);
});

test('append-only Anthropic targets keep same-provider blocks of another model and never receive Codex receipts', async t => {
  const official = { providerId: 'claude', modelId: 'claude-opus-5-5', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', contextWindow: 1000000, maxOutputTokens: 64000, reasoning: 'default', compat: { adaptiveThinking: true } };
  const sonnet = { ...official, modelId: 'claude-sonnet-5-5' }, codex = { providerId: 'codex', modelId: 'gpt-5.5', protocol: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', contextWindow: 272000, maxOutputTokens: 1000, reasoning: 'default' };
  const signatures = { 'claude-opus-5-5': 'sig-opus', 'claude-sonnet-5-5': 'sig-sonnet', 'gpt-5.5': 'rna:codex-reasoning:e30' };
  const requests = [];
  const app = await setup(t, { model: official, apiKey: 'claude-secret-key', provider: async function* (request) {
    requests.push(request);
    yield { type: 'thinking_delta', delta: `${request.model.modelId} thought` }; yield { type: 'thinking_signature', signature: signatures[request.model.modelId] };
    yield { type: 'text_delta', delta: `answer from ${request.model.modelId}` }; yield { type: 'done', stopReason: 'stop' };
  } });
  const session = await app.create();
  await session.prompt('one');
  session.setModel(sonnet); await session.prompt('two');
  session.setModel(official); await session.prompt('three');
  const third = JSON.stringify(requests[2].messages);
  assert.ok(third.includes('sig-opus') && third.includes('sig-sonnet'), 'Opus gets every same-provider block back: nothing stripped, nothing put back');
  assert.ok(JSON.stringify(requests[1].messages).includes('sig-opus'), 'Sonnet is sent Opus blocks too (the API drops what it cannot read)');
  session.setModel(codex, { apiKey: 'codex-secret' }); await session.prompt('four');
  session.setModel(official, { apiKey: 'claude-secret-key' }); await session.prompt('five');
  const wire = buildRequest({ model: official, systemPrompt: requests[4].systemPrompt, messages: requests[4].messages, tools: [] }).body;
  assert.equal(JSON.stringify(wire).includes('rna:codex'), false, 'a Codex receipt never reaches Anthropic');
  assert.equal(JSON.stringify(requests[4].messages).includes('rna:codex'), false, 'nor the projection');
});
