import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { prepareContext, SUMMARY_FIELD_CHARS } from '../src/context.mjs';
import { ProviderError, streamCompletion } from '../src/providers.mjs';
import { providerDiagnostic } from '../src/provider-diagnostics.mjs';

// A conversation built on a large-window model, continued on a smaller one (live, 2026-10-02: glm-5.3 1M → a 272k
// ChatGPT model; 290k of history; the one summary request carried ~254k tokens and the service refused it).
// Compaction follows pi: a compact transcript (long fields cut), bounded batches, and on a reported overflow a
// smaller batch for summaries and one compact-and-retry for answers. No network; local completion sources only.
const large = { providerId: 'fixture', modelId: 'large', protocol: 'openai', baseUrl: 'https://example.test/v1', contextWindow: 1000000, maxOutputTokens: 4000 };
const isSummary = request => request.systemPrompt.startsWith('Summarize');
const summaryText = request => request.messages[0].content[0].text;
const overflow = () => new ProviderError('模型请求失败（HTTP 400）：Your input exceeds the context window of this model.', { code: 'http_error', status: 400, providerCode: 'context_length_exceeded', category: 'context_limit' });
const answer = async function* (text) { yield { type: 'text_delta', delta: text }; yield { type: 'usage', usage: { input: 10, output: 5, totalTokens: 15 } }; yield { type: 'done', stopReason: 'stop' }; };

async function fixture(t, { turns = 10, resultChars = 9000, provider } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'rna-window-switch-')), sessions = [];
  t.after(async () => { for (const session of sessions) await session.dispose(); await rm(cwd, { recursive: true, force: true }); });
  const tools = [{ name: 'inspect', effect: 'read', parameters: { type: 'object', properties: {} }, execute: async () => `${'record line of the chapter draft. '.repeat(Math.ceil(resultChars / 33)).slice(0, resultChars)}` }];
  const calls = [];
  const writer = await createSession({ sessionId: 'window-switch', cwd, stateDir: join(cwd, 'state'), model: large, tools, autoCompaction: false, provider: async function* (request) {
    calls.push(request);
    if (request.messages.at(-1)?.role === 'user') { yield { type: 'tool_call', id: `call-${calls.length}`, name: 'inspect', arguments: {} }; yield { type: 'done', stopReason: 'toolUse' }; return; }
    yield* answer('Checked the draft; the facts are consistent.');
  } });
  sessions.push(writer);
  for (let i = 0; i < turns; i++) await writer.prompt(`Check chapter ${i}`);
  const sessionFile = writer.snapshot().sessionFile; await writer.dispose();
  const resume = async (model, extra = {}) => { const session = await createSession({ sessionId: 'window-switch', cwd, stateDir: join(cwd, 'state'), sessionFile, model, tools, provider, ...extra }); sessions.push(session); return session; };
  return { resume, sessionFile };
}

test('switching to a smaller window: history is summarized from a compact transcript in batches that fit, then the answer comes', async t => {
  const requests = [];
  const f = await fixture(t, { provider: async function* (request) { requests.push(request); yield* answer(isSummary(request) ? 'Chapters 0-9 were checked; the facts are consistent; no open work.' : 'Here is my view.'); } });
  const small = { ...large, modelId: 'small', contextWindow: 30000, maxOutputTokens: 2000 };
  const session = await f.resume(small);
  assert.ok(session.snapshot().contextUsage?.estimatedInputTokens ?? true);
  await session.prompt('What do you think of the recent news?');
  const summaries = requests.filter(isSummary), answers = requests.filter(request => !isSummary(request));
  assert.ok(summaries.length >= 1, 'history was summarized before the request');
  for (const request of summaries) {
    const text = summaryText(request);
    assert.match(text, /^(<previous-summary>[\s\S]*<\/previous-summary>\n\n)?<conversation>\n/);
    assert.match(text, /\[Tool result inspect\]: /); assert.match(text, /more characters truncated\]/);
    for (const block of text.split('\n\n[')) assert.ok(block.length < SUMMARY_FIELD_CHARS + 400, `a field longer than the cut: ${block.length}`);
    const estimated = prepareContext({ sessionId: 'window-switch', systemPrompt: request.systemPrompt, messages: request.messages, model: request.model }).estimatedInputTokens;
    assert.ok(estimated + request.model.maxOutputTokens <= small.contextWindow, `${estimated} + ${request.model.maxOutputTokens} > ${small.contextWindow}`);
  }
  assert.equal(answers.length, 1); assert.equal(session.snapshot().messages.at(-1).content[0].text, 'Here is my view.');
});

test('a summary batch the service reports as too long is retried as a smaller batch, carrying the summary forward', async t => {
  let refused = 0;
  const f = await fixture(t, { provider: async function* (request) {
    // The service's own tokenizer is stricter than the byte estimate: anything over ~6k estimated tokens is refused.
    if (isSummary(request) && summaryText(request).length > 18000) { refused++; throw overflow(); }
    yield* answer(isSummary(request) ? 'Earlier chapters were checked and consistent.' : 'Answer after summaries.');
  } });
  const session = await f.resume({ ...large, modelId: 'small', contextWindow: 30000, maxOutputTokens: 2000 });
  await session.prompt('Continue');
  assert.ok(refused >= 1, 'the first batch was refused');
  assert.equal(session.snapshot().messages.at(-1).content[0].text, 'Answer after summaries.');
  const journal = (await readFile(f.sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const failed = journal.filter(row => row.type === 'compaction_request_completed' && row.data.code);
  assert.ok(failed.length >= 1 && failed.every(row => row.data.errorDiagnostic?.category === 'context_limit'), JSON.stringify(failed.map(row => row.data)));
  assert.ok(journal.some(row => row.type === 'context_compaction'));
});

test('an answer request the service rejects as too long is summarized and retried once, never in a loop', async t => {
  let answersTried = 0;
  const f = await fixture(t, { turns: 6, provider: async function* (request) {
    if (isSummary(request)) { yield* answer('Six chapters checked; all consistent.'); return; }
    answersTried++;
    // The estimate fits this window, but the service counts more: the first answer request is refused.
    if (answersTried === 1) throw overflow();
    yield* answer('Answered after making room.');
  } });
  const fits = { ...large, modelId: 'tight', contextWindow: 200000, maxOutputTokens: 2000 };
  const events = [];
  const session = await f.resume(fits, { onEvent: event => events.push(event) });
  await session.prompt('Next step?');
  assert.equal(answersTried, 2); assert.equal(session.snapshot().messages.at(-1).content[0].text, 'Answered after making room.');
  assert.ok(events.some(event => event.type === 'context_overflow_recovery'));
  assert.ok(events.some(event => event.type === 'compaction_request_start' && event.trigger === 'overflow'));

  let tries = 0;
  const g = await fixture(t, { turns: 4, provider: async function* (request) { if (isSummary(request)) { yield* answer('Summary.'); return; } tries++; throw overflow(); } });
  const stuck = await g.resume(fits);
  await assert.rejects(stuck.prompt('Again?'), error => providerDiagnostic(error, 'response')?.category === 'context_limit');
  assert.equal(tries, 2, 'one retry only');
});

test('ChatGPT Codex rejections keep their reason ({"detail": …}); a context overflow is recognized as such', async () => {
  const model = { providerId: 'codex', protocol: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', modelId: 'gpt-6-astra', contextWindow: 272000, maxOutputTokens: 8192, reasoning: 'default' };
  const credential = { provider: 'openai-codex', accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token', accountId: 'fake-account', expiresAt: Date.now() + 3600000 };
  const rejected = detail => async () => new Response(JSON.stringify({ detail }), { status: 400, headers: { 'content-type': 'application/json' } });
  const run = async fetch => { try { for await (const _event of streamCompletion({ model, messages: [{ role: 'user', content: 'hi' }], subscriptionCredential: credential, fetch, maxRetries: 0 })); } catch (error) { return error; } };
  const tooLong = await run(rejected('Your input exceeds the context window of this model. Please adjust your input and try again.'));
  assert.equal(providerDiagnostic(tooLong)?.category, 'context_limit'); assert.match(tooLong.message, /exceeds the context window/);
  const unsupported = await run(rejected('Unsupported parameter: text.verbosity'));
  assert.equal(providerDiagnostic(unsupported)?.category, 'invalid_request'); assert.match(unsupported.message, /Unsupported parameter: text\.verbosity/);
  // The same overflow reported inside the stream (response.failed) instead of as a status.
  const failed = await run(async () => new Response(`data: ${JSON.stringify({ type: 'response.failed', response: { error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model.' } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
  assert.equal(providerDiagnostic(failed)?.category, 'context_limit');
});

test('ChatGPT Codex responses are read as pi reads them; an unusable 2xx says what it looked like, never what it said', async () => {
  // Live, 2026-10-02: every gpt-6-astra request failed in ~3 s as invalid_response, with nothing recorded to tell why.
  const model = { providerId: 'codex', protocol: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', modelId: 'gpt-6-astra', contextWindow: 272000, maxOutputTokens: 8192, reasoning: 'default' };
  const credential = { provider: 'openai-codex', accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token', accountId: 'fake-account', expiresAt: Date.now() + 3600000 };
  const run = async (body, headers) => { const events = []; try { for await (const event of streamCompletion({ model, messages: [{ role: 'user', content: 'hi' }], subscriptionCredential: credential, fetch: async () => new Response(body, { headers }), maxRetries: 0 })) events.push(event); return { events }; } catch (error) { return { error, events }; } };
  const sse = (...events) => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const done = type => ({ type, response: { status: 'completed', output: [{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Summary.' }] }], usage: { input_tokens: 12, output_tokens: 3 } } });
  const reply = [{ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } }, { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'Summary.' }];
  const text = events => events.filter(event => event.type === 'text_delta').map(event => event.delta).join('');

  // A stream whose declared type is missing or unusual, a trailing [DONE], and response.done as the terminal receipt.
  for (const headers of [{}, { 'content-type': 'Text/Event-Stream; charset=utf-8' }, { 'content-type': 'application/octet-stream' }]) {
    const { error, events } = await run(`${sse(...reply, done('response.done'))}data: [DONE]\n\n`, headers);
    assert.equal(error, undefined, `${JSON.stringify(headers)}: ${error?.message}`); assert.equal(text(events), 'Summary.');
  }
  // A JSON refusal delivered with a 2xx: its reason is kept, an overflow is context_limit (summarize, retry).
  const tooLong = await run(JSON.stringify({ detail: 'Your input exceeds the context window of this model.' }), { 'content-type': 'application/json' });
  assert.equal(providerDiagnostic(tooLong.error)?.category, 'context_limit'); assert.match(tooLong.error.message, /exceeds the context window/);
  const refused = await run(JSON.stringify({ detail: 'The model is not available on your plan.' }), { 'content-type': 'application/json; charset=utf-8' });
  assert.deepEqual(providerDiagnostic(refused.error), { responseShape: 'not_sse:application/json', category: 'provider_failure', retryable: false });
  assert.match(refused.error.message, /not available on your plan/);
  // A page instead of a stream, and a frame that is not JSON: the shape is recorded; the content is not.
  const page = await run('<html><body>Just a moment… secret-session-cookie</body></html>', { 'content-type': 'text/html; charset=UTF-8' });
  assert.equal(providerDiagnostic(page.error)?.responseShape, 'not_sse:text/html');
  const garbled = await run('event: response.created\ndata: {"type":"response.created"\n\n', { 'content-type': 'text/event-stream' });
  assert.equal(providerDiagnostic(garbled.error, 'compaction')?.responseShape, 'non_json_frame:response.created');
  for (const error of [page.error, garbled.error]) assert.doesNotMatch(JSON.stringify(providerDiagnostic(error)), /secret|html>|"type"/);
  // A shape is a protocol token or nothing.
  assert.equal(providerDiagnostic({ code: 'invalid_response', responseShape: 'not_sse:<script>' })?.responseShape, undefined);
});

test('an overflow with nothing left to summarize is not retried: the same request would be refused again', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'rna-window-switch-')); let tries = 0;
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const session = await createSession({ sessionId: 'nothing-to-summarize', cwd, stateDir: join(cwd, 'state'), model: { ...large, contextWindow: 200000 }, provider: async function* () { tries++; throw overflow(); } });
  t.after(() => session.dispose());
  await assert.rejects(session.prompt('A single very long request'), error => providerDiagnostic(error, 'response')?.category === 'context_limit');
  assert.equal(tries, 1);
});
