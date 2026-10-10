import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { streamCompletion } from '../src/providers.mjs';
import { createFakeAnthropic } from './fixtures/fake-anthropic.mjs';
import { assertAppendOnly, thinkingBlocks } from './helpers/append-only.mjs';

// Every request here goes to the in-process fake in 'error' mode: any history edit is a 400 and fails the test.
const KEY = 'sk-ant-fixture-not-a-real-key';
const opus = { providerId: 'anthropic', modelId: 'claude-opus-5-5', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', contextWindow: 1000000, maxOutputTokens: 64000, reasoning: 'default', input: ['text', 'image'], compat: { adaptiveThinking: true, thinkingDisplay: 'summarized', thinkingBindingMode: 'error' } };
const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6eZkAAAAASUVORK5CYII=' };
const tool = (name, execute, effect = 'read') => ({ name, effect, idempotent: effect === 'read', parameters: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, additionalProperties: false }, execute });
const readTool = tool('read', async (_id, args) => `contents of ${args.path}`);
const records = async file => (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const SUMMARY = /^Summarize the provided conversation record/;

async function harness(t, { respond, failures, model = opus, ...options } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rna-append-only-')), fake = createFakeAnthropic({ respond, failures }), handles = [];
  t.after(async () => { await Promise.allSettled(handles.map(handle => handle.dispose())); await rm(root, { recursive: true, force: true }); });
  const provider = Object.assign(input => streamCompletion({ ...input, fetch: fake.fetch, maxRetries: 0 }), { meteredBase: streamCompletion });
  const open = async (extra = {}) => { const session = await createSession({ sessionId: 'append', projectId: 'p', cwd: root, stateDir: join(root, 'state'), model, apiKey: KEY, provider, tools: [readTool], autoCompaction: false, ...options, ...extra }); handles.push(session); return session; };
  return { root, fake, open };
}
/** Every consecutive pair of conversation requests is append-only, unless the journal records a rebase between
 * them; then nothing at or before the floor may still carry thinking. */
async function assertSession(fake, file) {
  const journal = await records(file), conversation = fake.requests.filter(row => !row.keepAlive && !SUMMARY.test(row.body.system?.[0]?.text ?? ''));
  const started = journal.filter(row => row.type === 'request_started');
  assert.equal(started.length, conversation.length, 'one wire request per journaled request');
  for (let index = 1; index < conversation.length; index++) {
    const between = journal.filter(row => row.type === 'thinking_rebase' && row.seq > started[index - 1].seq && row.seq < started[index].seq).map(row => row.data);
    const rebase = between.length ? (between.at(-1).throughMessageId === started[index - 1].data.tailMessageId ? 'tail' : 'response') : undefined;
    assertAppendOnly(conversation[index - 1].body, conversation[index].body, { prevResponse: conversation[index - 1].response, rebase });
  }
  assert.deepEqual(fake.errors.filter(row => row.status === 400), [], 'no request was rejected');
  assert.deepEqual(fake.requests.flatMap(row => row.transformations ?? []), [], 'no block was dropped');
  return journal;
}

test('a ten-request agentic session stays append-only: context updates, parallel tools, progress blocks, steering, finish feedback, network resume', async t => {
  let tick = 0, reviewed = false, session;
  const steering = tool('check', async (_id, args) => { if (args.path === 'c') await session.steer('Also check d.'); return `checked ${args.path}`; });
  const app = await harness(t, {
    failures: [{ call: 6, network: true }],
    respond: [
      [{ thinking: 'Plan: read a and b in parallel.' }, { progress: 'Reading a.' }, { tool: { id: 'toolu_a', name: 'read', input: { path: 'a' } } }, { progress: '' }, { tool: { id: 'toolu_b', name: 'read', input: { path: 'b' } } }],
      [{ thinking: 'Both read.' }, { text: 'A and B read.' }],
      [{ text: 'Added the sizes.' }],
      [{ progress: 'c next' }, { tool: { id: 'toolu_c', name: 'check', input: { path: 'c' } } }],
      [{ thinking: 'The user also wants d.' }, { tool: { id: 'toolu_d', name: 'check', input: { path: 'd' } } }],
      [{ text: 'c and d checked.' }],
      [{ thinking: 'Resuming.' }, { text: 'Recovered.' }],
      [{ thinking: 'Fourth.', splitSignature: true }, { text: 'Four.' }],
      [{ redacted: true }, { text: 'Five.' }]
    ],
    tools: [readTool, steering],
    beforeRequest: async () => ({ contextUpdates: [{ key: 'clock', source: 'host-clock', text: `tick ${++tick}` }] }),
    beforeFinish: async () => { if (reviewed) return undefined; reviewed = true; return { feedback: [{ source: 'review', text: 'Mention the file sizes.' }] }; }
  });
  session = await app.open();
  await session.prompt('Read a and b.');
  await session.prompt('Check c.');
  await assert.rejects(session.prompt('Network test.'), error => error.code === 'connection');
  await session.resume();
  await session.prompt('Fourth.');
  await session.prompt('Fifth.');
  assert.equal(app.fake.requests.length, 10);
  const journal = await assertSession(app.fake, session.snapshot().sessionFile);
  assert.deepEqual(journal.filter(row => row.type === 'thinking_rebase'), [], 'no rebase was needed');
  assert.equal(journal.filter(row => row.type === 'prefix_pin').length, 1, 'the prefix was pinned once');
  const last = app.fake.requests.at(-1).body;
  assert.equal(thinkingBlocks(last.messages).length, 8, 'all reasoning so far is replayed (the failed request left none)');
  // The cache read the whole earlier conversation on each warm request.
  for (const row of app.fake.requests.slice(1).filter(row => row.usage)) assert.ok(row.usage.cache_read_input_tokens > 0);
});

test('a revised system prompt is appended once per change across reopenings (A, B, A); the top-level system stays pinned', async t => {
  const app = await harness(t, { respond: [[{ thinking: 'one' }, { text: '1' }], [{ thinking: 'two' }, { text: '2' }], [{ thinking: 'three' }, { text: '3' }], [{ text: '4' }]] });
  let session = await app.open({ systemPrompt: 'System A.' }); await session.prompt('One.');
  const file = session.snapshot().sessionFile; await session.dispose();
  session = await app.open({ systemPrompt: 'System B.', sessionFile: file }); await session.prompt('Two.'); await session.prompt('Three.'); await session.dispose();
  session = await app.open({ systemPrompt: 'System A.', sessionFile: file }); await session.prompt('Four.');
  const journal = await assertSession(app.fake, file);
  for (const row of app.fake.requests) assert.deepEqual(row.body.system.map(block => block.text), ['System A.']);
  const revisions = journal.filter(row => row.type === 'message' && row.data.message.role === 'system').map(row => row.data.message.content[0].text);
  assert.equal(revisions.length, 2); assert.match(revisions[0], /System B\.$/); assert.match(revisions[1], /System A\.$/);
  assert.match(revisions[0], /^\[Operator system prompt revised\./);
  const wire = app.fake.requests.at(-1).body.messages;
  assert.deepEqual(wire.filter(message => message.role === 'system').length, 2);
  assert.equal(wire.at(-1).role, 'system', 'the newest revision follows the user turn it applies to');
});

test('a tool-set change is a rebase point: prefix_changed, a new pin, no thinking at or before the floor, later thinking replayed', async t => {
  let extra = false;
  const writeTool = tool('write', async () => 'written', 'write');
  const app = await harness(t, { respond: [[{ thinking: 'first' }, { text: '1' }], [{ thinking: 'second' }, { text: '2' }], [{ thinking: 'third' }, { text: '3' }]], beforeRequest: async () => extra ? { tools: [readTool, writeTool] } : undefined });
  const session = await app.open(); await session.prompt('One.');
  extra = true; await session.prompt('Two.'); await session.prompt('Three.');
  const journal = await assertSession(app.fake, session.snapshot().sessionFile);
  assert.deepEqual(journal.filter(row => row.type === 'thinking_rebase').map(row => row.data.reason), ['prefix_changed']);
  assert.equal(journal.filter(row => row.type === 'prefix_pin').length, 2);
  const [, second, third] = app.fake.requests.map(row => row.body);
  assert.deepEqual(thinkingBlocks(second.messages), []); assert.equal(second.tools.length, 2);
  assert.deepEqual(thinkingBlocks(third.messages).map(block => block.thinking), ['second'], 'thinking after the floor is replayed');
});

test('compaction (manual and automatic) rebases and re-pins: the retained tail goes without thinking, revisions are not restored', async t => {
  // Turns large next to the summary request's checkpoint directive (~700 tokens), so the tight window below still
  // holds a summary of the older turns.
  const respond = body => SUMMARY.test(body.system?.[0]?.text ?? '') ? [{ text: 'Summary of the earlier work.' }] : [{ thinking: `t${body.messages.length}` }, { text: 'ok '.repeat(1500) }];
  const app = await harness(t, { respond });
  let session = await app.open({ systemPrompt: 'A.' });
  for (const text of ['One.', 'Two.', 'Three.']) await session.prompt(text);
  const file = session.snapshot().sessionFile; await session.dispose();
  session = await app.open({ sessionFile: file, systemPrompt: 'B.' }); await session.prompt('Four.');
  const compacted = await session.compact({ summary: 'Manual summary.', keepLastTurns: 2 });
  assert.equal(compacted.compacted, true);
  await session.prompt('Five.');
  let journal = await assertSession(app.fake, file);
  assert.deepEqual(journal.filter(row => row.type === 'thinking_rebase').map(row => row.data.reason), ['compaction']);
  const afterCompaction = app.fake.requests.at(-1).body;
  assert.deepEqual(afterCompaction.system.map(block => block.text), ['B.'], 're-pinned with the current prompt');
  assert.equal(afterCompaction.messages.some(message => message.role === 'system'), false, 'the revision is superseded by the pin');
  assert.deepEqual(thinkingBlocks(afterCompaction.messages), [], 'the retained tail carries no thinking');
  // Automatic compaction through the generated-summary path behaves the same: a window just above the current
  // context makes the next request cross the blocking trigger.
  await session.prompt('Six.'); await session.prompt('Seven.');
  const estimate = session.snapshot().contextUsage.estimatedInputTokens;
  await session.dispose();
  session = await app.open({ sessionFile: file, systemPrompt: 'B.', autoCompaction: true, model: { ...opus, contextWindow: estimate + 300, maxOutputTokens: 200 } });
  await session.prompt('Eight.');
  journal = await records(file);
  const reasons = journal.filter(row => row.type === 'thinking_rebase').map(row => row.data.reason);
  assert.ok(reasons.length >= 2 && reasons.every(reason => reason === 'compaction'), reasons.join());
  for (const row of journal.filter(row => row.type === 'context_compaction')) assert.equal(journal[journal.indexOf(row) + 1].type, 'thinking_rebase', 'each compaction is journaled with its rebase');
  await assertSession(app.fake, file);
  assert.deepEqual(app.fake.errors, []);
});

test('vision history never flips on warm turns; after a rebase only images at or before the floor become text', async t => {
  let extra = false;
  const app = await harness(t, { respond: () => [{ thinking: 'seen' }, { text: 'ok' }], beforeRequest: async () => extra ? { tools: [readTool, tool('write', async () => 'w', 'write')] } : undefined });
  const session = await app.open();
  await session.prompt('Look.', { images: [image] });
  for (const text of ['Two.', 'Three.', 'Four.']) await session.prompt(text);
  const images = body => JSON.stringify(body.messages).split('"type":"image"').length - 1;
  assert.deepEqual(app.fake.requests.map(row => images(row.body)), [1, 1, 1, 1], 'pixels stay while the prefix is warm');
  extra = true; await session.prompt('Five.');
  await assertSession(app.fake, session.snapshot().sessionFile);
  assert.equal(images(app.fake.requests.at(-1).body), 0, 'after the rebase the observed image is text');
});

test('more images than one request takes: image_offload is journaled with its image_budget rebase', async t => {
  let shots = 0;
  const capture = tool('capture', async () => ({ content: [{ ...image }] }), 'write');
  const app = await harness(t, { tools: [capture], respond: () => shots++ < 17 ? [{ thinking: `shot ${shots}` }, { tool: { id: `toolu_${shots}`, name: 'capture', input: {} } }] : [{ text: 'All captured.' }] });
  const session = await app.open();
  await session.prompt('Capture seventeen screenshots.');
  const journal = await assertSession(app.fake, session.snapshot().sessionFile);
  const offload = journal.find(row => row.type === 'image_offload'), rebase = journal.find(row => row.type === 'thinking_rebase');
  assert.ok(offload); assert.equal(rebase.data.reason, 'image_budget'); assert.equal(rebase.seq, offload.seq + 1, 'journaled in the same step');
});

test('warm settle journals nothing on an append-only target; context-pressure forget journals context_forget with its rebase', async t => {
  const writeTool = tool('write', async () => 'written', 'write');
  const big = 'x'.repeat(3000);
  // Two requests per run and a cache read at 0.6 of the uncached rate: the warm break-even share is 0.25 (cache-economics.mjs).
  const app = await harness(t, { tools: [readTool, writeTool], cachePricing: { input: 1, cacheRead: 0.6 }, settleArguments: (name, args) => name === 'write' ? { path: args.path, text: '[settled]' } : null,
    respond: body => { const n = body.messages.filter(message => message.role === 'user').length; return n % 2 ? [{ thinking: `w${n}` }, { tool: { id: `toolu_${n}`, name: 'write', input: { path: `f${n}`, text: big } } }] : [{ text: 'saved' }]; } });
  let session = await app.open();
  for (const text of ['One.', 'Two.', 'Three.', 'Four.']) await session.prompt(text);
  const file = session.snapshot().sessionFile;
  assert.deepEqual((await records(file)).filter(row => row.type === 'context_settle'), [], 'no warm settle');
  await session.dispose();
  // The same history on a target that may edit settles at once (the guard is what kept the journal clean above).
  session = await app.open({ sessionFile: file, model: { ...opus, compat: { ...opus.compat, appendOnly: false } } });
  await session.prompt('Five.');
  assert.equal((await records(file)).filter(row => row.type === 'context_settle').length, 1, 'an editable target settles warm');
  await session.dispose();
  // Context pressure: three turns that each read a large result, then a window that the fourth turn's read
  // crosses, with a host judgment that sets the earlier results aside.
  const reader = tool('read', async (_id, args) => `${args.path}: ${'r'.repeat(9000)}`);
  const pressure = createFakeAnthropic({ respond: body => { const last = body.messages.at(-1), answered = last.content.some(block => block.type === 'tool_result'); return answered ? [{ text: 'read it' }] : [{ thinking: `read ${body.messages.length}` }, { tool: { id: `toolu_p${body.messages.length}`, name: 'read', input: { path: `p${body.messages.length}` } } }]; } });
  const root = await mkdtemp(join(tmpdir(), 'rna-pressure-')); t.after(() => rm(root, { recursive: true, force: true }));
  const provider = Object.assign(input => streamCompletion({ ...input, fetch: pressure.fetch, maxRetries: 0 }), { meteredBase: streamCompletion });
  let judged = 0;
  const pressureOptions = { sessionId: 'pressure', cwd: root, stateDir: root, apiKey: KEY, provider, tools: [reader], forgetStale: async ({ results }) => { judged++; return results.map(row => row.id); } };
  session = await createSession({ ...pressureOptions, model: opus, autoCompaction: false });
  for (const text of ['A.', 'B.', 'C.']) await session.prompt(text);
  const estimate = session.snapshot().contextUsage.estimatedInputTokens, pressureFile = session.snapshot().sessionFile; await session.dispose();
  session = await createSession({ ...pressureOptions, sessionFile: pressureFile, model: { ...opus, contextWindow: Math.ceil((estimate + 2000) / 0.9), maxOutputTokens: 500 } });
  t.after(() => session.dispose());
  await session.prompt('D.');
  const journal = await records(pressureFile), forget = journal.find(row => row.type === 'context_forget');
  assert.ok(judged > 0, 'context pressure asked the host which results are superseded');
  assert.ok(forget, 'the host judgment set results aside');
  const next = journal[journal.indexOf(forget) + 1];
  assert.equal(next.type, 'thinking_rebase'); assert.equal(next.data.reason, 'context_pressure');
  assert.deepEqual(pressure.errors, [], 'the forget never produced a rejected request');
});

test('a rewind keeps the floor where nothing comes back', async t => {
  let extra = false;
  const app = await harness(t, { respond: () => [{ thinking: 'r' }, { text: 'ok' }], beforeRequest: async () => extra ? { tools: [readTool, tool('write', async () => 'w', 'write')] } : undefined });
  const session = await app.open();
  await session.prompt('One.'); extra = true; await session.prompt('Two.'); await session.prompt('Three.');
  // The floor is the "Two." message (the tool change rebased there); rewinding to it removes the floor message.
  const target = session.snapshot().messages.filter(message => message.role === 'user' && message.source === 'user').at(-2);
  await session.rewind(target.id);
  await session.prompt('Two again.');
  assert.deepEqual(app.fake.errors, []);
  const wire = app.fake.requests.at(-1).body.messages;
  assert.deepEqual(thinkingBlocks(wire), [], 'the block stripped before the rewind is not put back');
});

test('a crash mid-stream replays the partial response without any signature', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rna-crash-')); t.after(() => rm(root, { recursive: true, force: true }));
  let hold, copyTaken;
  const taken = new Promise(resolve => { copyTaken = resolve; });
  const frames = [{ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'half a thought' } }, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-never-final' } }, { type: 'content_block_stop', index: 0 }];
  const after = createFakeAnthropic({ respond: [[{ text: 'resumed' }]] });
  let calls = 0;
  const fetch = async (url, init) => ++calls === 1 ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''))); hold = controller; } }), { headers: { 'content-type': 'text/event-stream' } }) : after.fetch(url, init);
  const provider = Object.assign(input => streamCompletion({ ...input, fetch, maxRetries: 0 }), { meteredBase: streamCompletion });
  const session = await createSession({ sessionId: 'crash', cwd: root, stateDir: join(root, 'live'), model: opus, apiKey: KEY, provider, autoCompaction: false, onEvent: event => { if (event.type === 'message_update' && event.assistantMessageEvent?.delta === 'half a thought') setTimeout(copyTaken, 10); } });
  const running = session.prompt('Think.').catch(() => {});
  await taken;
  const fs = await import('node:fs/promises');
  await fs.mkdir(join(root, 'crashed'), { recursive: true });
  const copy = join(await fs.realpath(join(root, 'crashed')), 'copy.rna.jsonl');
  await copyFile(session.snapshot().sessionFile, copy);
  hold.close(); await running; await session.dispose();
  const reopened = await createSession({ sessionId: 'crash', cwd: root, stateDir: join(root, 'crashed'), sessionFile: copy, model: opus, apiKey: KEY, provider, autoCompaction: false });
  t.after(() => reopened.dispose());
  const partial = reopened.snapshot().messages.find(message => message.role === 'assistant');
  assert.equal(partial.stopReason, 'aborted');
  assert.equal(partial.content.some(part => part.signature !== undefined), false);
  await reopened.resume();
  assert.deepEqual(after.errors, []);
  assert.deepEqual(thinkingBlocks(after.requests.at(-1).body.messages), []);
});
