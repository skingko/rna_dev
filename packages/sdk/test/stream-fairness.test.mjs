import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { iterateCompletion, parseSSE, streamCompletion } from '../src/providers.mjs';
import { createSession } from '../src/session.mjs';

const model = { providerId: 'fixture', modelId: 'burst', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 32000, maxOutputTokens: 1000 };
const input = { model, messages: [] };
const cpuWork = ms => { const end = performance.now() + ms; while (performance.now() < end) structuredClone({ content: [{ type: 'text', text: 'bounded fixture CPU work' }], values: [1, 2, 3] }); };

test('already-ready provider yields a macrotask within 64 events without changing event order', async () => {
  const observed = []; let heartbeatAt;
  const provider = async function* () { for (let index = 0; index < 1024; index++) yield { type: 'text_delta', delta: String(index) }; yield { type: 'done' }; };
  for await (const event of iterateCompletion(provider, input)) {
    observed.push(event);
    if (observed.length === 1) setImmediate(() => { heartbeatAt = observed.length; });
  }
  assert.ok(heartbeatAt >= 1 && heartbeatAt <= 64, `heartbeat must run during the burst, saw ${heartbeatAt}`);
  assert.deepEqual(observed.slice(0, -1).map(event => event.delta), Array.from({ length: 1024 }, (_, i) => String(i)));
  assert.equal(observed.at(-1).type, 'done');
});

test('time quantum admits timer cancellation before a CPU-heavy ready burst finishes, keeping its original reason', async () => {
  const controller = new AbortController(), reason = Object.assign(new Error('timer cancellation'), { code: 'fixture_cancel' });
  let delivered = 0, returned = false, timer;
  const provider = async function* () { try { for (let index = 0; index < 100; index++) yield { type: 'text_delta', delta: String(index) }; } finally { returned = true; } };
  try {
    await assert.rejects(async () => {
      for await (const _event of iterateCompletion(provider, { ...input, signal: controller.signal })) {
        delivered++;
        if (delivered === 1) timer = setTimeout(() => controller.abort(reason), 1);
        cpuWork(3);
      }
    }, error => error === reason);
    assert.ok(delivered >= 1 && delivered < 64, `time quantum must yield before event cap, delivered ${delivered}`);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(returned, true);
  } finally { clearTimeout(timer); }
});

test('a single queued SSE chunk containing many data frames admits heartbeats while retaining ordered frames', async () => {
  const count = 2048, body = new Response(Array.from({ length: count }, (_, i) => `data: ${i}\n\n`).join('')).body;
  let received = 0, heartbeatAt;
  for await (const frame of parseSSE(body)) {
    assert.equal(frame.data, String(received++));
    if (received === 1) setImmediate(() => { heartbeatAt = received; });
  }
  assert.equal(received, count);
  assert.ok(heartbeatAt >= 1 && heartbeatAt <= 64, `parser must yield inside one network chunk, saw ${heartbeatAt}`);
});

test('comment-only SSE bursts yield to abort and release their reader instead of draining the whole chunk first', async () => {
  const controller = new AbortController(), reason = new Error('stop heartbeat flood'); let cancelled = false, reads = 0, readsAtAbort;
  const stream = new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode(': heartbeat\n\n'.repeat(20000))); }, cancel() { cancelled = true; } });
  const body = { getReader() { const reader = stream.getReader(); return { read() { reads++; return reader.read(); }, cancel() { return reader.cancel(); }, releaseLock() { reader.releaseLock(); } }; } };
  const timer = setTimeout(() => { readsAtAbort = reads; controller.abort(reason); }, 1);
  try {
    await assert.rejects(Array.fromAsync(parseSSE(body, { signal: controller.signal })), error => error === reason);
    assert.equal(readsAtAbort, 1, 'abort must run while draining the first comment burst, not only when waiting for a second chunk');
    assert.equal(cancelled, true); assert.equal(stream.locked, false);
  } finally { clearTimeout(timer); }
});

test('native transport total timeout interrupts a buffered SSE burst without emitting partial tool calls', async () => {
  const chunks = Array.from({ length: 2000 }, (_, i) => `data: ${JSON.stringify({ choices: [{ delta: { content: String(i) } }] })}\n\n`).join('');
  const tail = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'effect', function: { name: 'write', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`;
  const events = [];
  await assert.rejects(async () => {
    for await (const event of streamCompletion({ ...input, idleTimeoutMs: 1000, totalTimeoutMs: 25, fetch: async () => new Response(chunks + tail, { headers: { 'content-type': 'text/event-stream' } }) })) { events.push(event); cpuWork(1); }
  }, { code: 'total_timeout' });
  assert.ok(events.length > 0 && events.length < 2000);
  assert.ok(events.every(event => event.type === 'text_delta'));
});

test('two actual sessions with ready provider bursts let heartbeat and abort timers run before either completes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rna-stream-fairness-')), sessions = [], updates = [0, 0], ended = [false, false], beats = [];
  let timer, stop, executions = 0;
  t.after(async () => { clearInterval(timer); clearTimeout(stop); await Promise.allSettled(sessions.map(session => session.dispose())); await rm(directory, { recursive: true, force: true }); });
  for (let index = 0; index < 2; index++) { let requests = 0; sessions.push(await createSession({
    sessionId: `burst-${index}`, cwd: directory, stateDir: join(directory, `state-${index}`), model,
    tools: [{ name: 'write', effect: 'write', parameters: { type: 'object' }, execute: async () => { executions++; return 'must not execute'; } }],
    provider: async function* () { if (!requests++) { for (let i = 0; i < 300; i++) yield { type: 'text_delta', delta: `${i},` }; yield { type: 'tool_call', id: 'late', name: 'write', arguments: {} }; } yield { type: 'done' }; },
    onEvent: event => { if (event.type === 'message_update') { updates[index]++; if (!stop && updates.every(value => value > 0)) stop = setTimeout(() => { for (const session of sessions) void session.abort(); }, 30); cpuWork(0.5); } }
  })); }
  timer = setInterval(() => beats.push({ updates: [...updates], ended: [...ended] }), 1);
  await Promise.all(sessions.map((session, index) => session.prompt('Observe the burst; a timer will cancel it.').finally(() => { ended[index] = true; })));
  clearInterval(timer); clearTimeout(stop);
  assert.ok(beats.some(beat => beat.ended.every(value => !value) && beat.updates.some(value => value > 0)), 'heartbeat must run while both actual sessions are active');
  assert.ok(updates.every(value => value > 0 && value < 300), `both streams must be interrupted mid-burst: ${updates}`);
  assert.equal(executions, 0);
  for (const session of sessions) { assert.equal(session.snapshot().messages.at(-1).stopReason, 'aborted'); assert.equal(session.snapshot().recovery.pendingTools, 0); }
});
