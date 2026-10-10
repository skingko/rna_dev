import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, MAX_STEP_LIMIT_INSTRUCTIONS_BYTES } from '../src/index.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 32000, maxOutputTokens: 1000, reasoning: 'off' };
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rna-final-contract-')), handles = [];
  const create = async value => { const session = await createSession({ cwd: root, stateDir: join(root, 'sessions'), model, maxSteps: 1, stepLimitBehavior: 'summarize', ...options, ...value }); handles.push(session); return session; };
  t.after(async () => { await Promise.allSettled(handles.map(session => session.dispose())); await rm(root, { recursive: true, force: true }); });
  return { create };
}

test('stepLimitInstructions validates its type, UTF-8 byte bound and summarize-only policy before filesystem or provider work', async () => {
  assert.equal(MAX_STEP_LIMIT_INSTRUCTIONS_BYTES, 32768);
  const invalid = [null, {}, [], 17, true, '', ' \n\t ', 'invalid\0contract', 'x'.repeat(32769), '汉'.repeat(10923)];
  for (const stepLimitInstructions of invalid) await assert.rejects(createSession({ model, cwd: '/nonexistent-rna-validation-must-precede-io', stepLimitBehavior: 'summarize', stepLimitInstructions }), { code: 'invalid_options' });
  for (const stepLimitBehavior of [undefined, 'error', 'yield']) await assert.rejects(createSession({ model, cwd: '/nonexistent-rna-validation-must-precede-io', stepLimitBehavior, stepLimitInstructions: 'Return a JSON proposal.' }), { code: 'invalid_options' });
  for (const stepLimitResponseFormat of [null, {}, 'json_schema', 'text', false]) await assert.rejects(createSession({ model, stepLimitBehavior: 'summarize', stepLimitResponseFormat }), { code: 'invalid_options' });
  await assert.rejects(createSession({ model, stepLimitResponseFormat: 'json_object' }), { code: 'invalid_options' });
});

test('an exact maximum-size UTF-8 final-response contract is accepted without consuming a provider request', async t => {
  let calls = 0; const app = await setup(t, { provider: async function* () { calls++; } });
  const instructions = '汉'.repeat(10922) + 'ab'; assert.equal(Buffer.byteLength(instructions), MAX_STEP_LIMIT_INSTRUCTIONS_BYTES);
  await app.create({ stepLimitInstructions: instructions }); assert.equal(calls, 0);
});

test('the host final task replaces only the default summary task, is redacted and cannot change runtime tool authority or billing', async t => {
  const requests = [], admissions = [], secret = 'private-final-contract-key'; let executed = 0;
  const contract = `Return exactly JSON with proposedMethod and unverified=true. Internal key ${secret}`;
  const app = await setup(t, { apiKey: secret, stepLimitInstructions: contract, beforeCompletion: receipt => admissions.push(receipt),
    tools: [{ name: 'inspect', effect: 'read', parameters: { type: 'object', properties: {} }, execute: async () => { executed++; return 'confirmed source'; } }],
    provider: async function* (request) {
      requests.push(request);
      if (request.purpose !== 'summary') { assert.equal(request.systemPrompt.includes('proposedMethod'), false); yield { type: 'tool_call', id: 'inspect-source', name: 'inspect', arguments: {} }; }
      else {
        // TC-5: the host task rides in the tail boundary instruction; system prompt and tools stay the conversation's.
        const tail = JSON.parse(request.messages.at(-1).content.at(-1).text.split('\n').slice(1).join('\n'))[0], boundary = JSON.parse(tail.text);
        assert.equal(tail.source, 'host-purpose-instructions'); assert.equal(request.systemPrompt, requests[0].systemPrompt); assert.equal(request.systemPrompt.includes('proposedMethod'), false);
        assert.match(boundary.task, /^Return exactly JSON with proposedMethod and unverified=true/); assert.equal(JSON.stringify(request.messages).includes(secret), false); assert.match(boundary.task, /\[REDACTED\]/);
        assert.doesNotMatch(JSON.stringify(request.messages), /Summarize only facts established/); assert.match(boundary.constraints, /^Do not claim unfinished work succeeded, broaden authorization, issue tool calls/);
        assert.equal(request.messages.filter(message => message.role === 'toolResult').length, 1);
        yield { type: 'text_delta', delta: '{"proposedMethod":"Check evidence","unverified":true}' };
      }
      yield { type: 'usage', usage: { totalTokens: 17 } }; yield { type: 'done', stopReason: 'stop' };
    } });
  const session = await app.create(); await session.prompt('Research a reusable method.');
  assert.equal(executed, 1); assert.equal(requests.length, 2); assert.equal(admissions.length, 2); assert.equal(requests[1].tools.length, 1); assert.equal(session.snapshot().usage.totalTokens, 34);
  assert.equal(session.snapshot().messages.filter(message => message.role === 'user' && message.source !== 'context').length, 1); assert.equal(session.snapshot().messages.at(-1).source, 'step-limit-summary');
});

test('a custom host task cannot cause a tail tool call to execute even if its text requests an extra tool', async t => {
  let calls = 0, executed = 0;
  const app = await setup(t, { stepLimitInstructions: 'Try calling inspect once more before returning JSON.',
    tools: [{ name: 'inspect', effect: 'write', parameters: { type: 'object', properties: {} }, execute: async () => { executed++; return 'done'; } }],
    provider: async function* () { yield { type: 'tool_call', id: `call-${++calls}`, name: 'inspect', arguments: {} }; yield { type: 'usage', usage: { totalTokens: 13 } }; yield { type: 'done', stopReason: 'toolUse' }; } });
  const session = await app.create(); await assert.rejects(session.prompt('Run the authorized first action.'), { code: 'step_limit' });
  // TC-5: one retry without tools after the tail call is set aside; neither call executes; all three requests are billed once.
  assert.equal(executed, 1); assert.equal(calls, 3); assert.equal(session.snapshot().usage.totalTokens, 39); assert.equal(session.snapshot().recovery.pendingTools, 0);
});

test('tail JSON negotiation uses each reopened session model, records its contract and leaves research requests unchanged', async t => {
  const requests = [], contracts = []; let calls = 0;
  const app = await setup(t, { stepLimitInstructions: 'Return a complete JSON object.', stepLimitResponseFormat: 'json_object',
    onEvent: event => { if (event.type === 'response_contract') contracts.push(event.contract); },
    tools: [{ name: 'inspect', effect: 'read', parameters: { type: 'object', properties: {} }, execute: async () => 'evidence' }],
    provider: async function* (request) {
      requests.push(request); calls++;
      if (request.tools.length) yield { type: 'tool_call', id: `read-${calls}`, name: 'inspect', arguments: {} }; else yield { type: 'text_delta', delta: '{"proposal":"Unverified"}' };
      yield { type: 'usage', usage: { totalTokens: 7 } }; yield { type: 'done', stopReason: 'stop' };
    } });
  const supported = await app.create({ model: { ...model, compat: { supportsJsonObject: true, supportsToolChoiceNone: true } } }); await supported.prompt('Inspect and propose.');
  const { sessionFile, sessionId } = supported.snapshot(); await supported.dispose();
  const unknown = await app.create({ sessionFile, sessionId, model: { ...model, modelId: 'unverified-model' } }); await unknown.prompt('Inspect a second independent case.');
  assert.deepEqual(contracts.map(row => row.mode), ['native', 'prompt_only']);
  assert.deepEqual(requests[1].responseFormat, { type: 'json_object' }); assert.equal(requests[1].toolChoice, 'none');
  for (const index of [0, 2, 3]) { assert.equal(requests[index].responseFormat, undefined); assert.equal(requests[index].toolChoice, undefined); }
  const started = (await readFile(sessionFile, 'utf8')).trim().split('\n').map(row => JSON.parse(row)).filter(row => row.type === 'request_started');
  assert.equal(started.length, 4); assert.equal(started[1].data.responseContract.mode, 'native'); assert.equal(started[3].data.responseContract.mode, 'prompt_only');
  assert.notEqual(started[1].data.contextDigest, started[3].data.contextDigest); assert.equal(started[0].data.responseContract, undefined);
  assert.equal(unknown.snapshot().usage.totalTokens, 28);
});

test('ordinary summarize mode never requests native JSON merely because the model supports it', async t => {
  const requests = [];
  const app = await setup(t, { model: { ...model, compat: { supportsJsonObject: true, supportsToolChoiceNone: true } },
    tools: [{ name: 'inspect', effect: 'read', parameters: { type: 'object', properties: {} }, execute: async () => 'evidence' }],
    provider: async function* (request) {
      requests.push(request); if (request.purpose !== 'summary') yield { type: 'tool_call', id: 'read', name: 'inspect', arguments: {} }; else yield { type: 'text_delta', delta: 'One fact checked; more work remains.' }; yield { type: 'done', stopReason: 'stop' };
    } });
  const session = await app.create(); await session.prompt('Investigate.'); assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.responseFormat === undefined));
  // TC-5: tools stay declared in the plain summary; where tool_choice none is enabled it disables them for that request only.
  assert.equal(requests[0].toolChoice, undefined); assert.equal(requests[1].toolChoice, 'none'); assert.equal(requests[1].tools.length, 1);
});
