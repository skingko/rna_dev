import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { RuntimeController } from '../runtime-controller.mjs';
import { readStateFile, readStateText } from '../state-shards.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-runtime-display-')), file = join(directory, 'state.json'), store = new Store(file);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const provider = store.configurationService.provider(null, { name: 'Display fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture', models: [{ id: 'display', contextWindow: 32000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'display', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ name: 'Display fixture', workspace: directory, initiative: { enabled: false } });
  store.message(session.id, { text: 'Durable user request', requestId: 'display-user' });
  const current = () => store.state.sessions.find(item => item.id === session.id), turnId = current().activeTurnId;
  // Exercise the real event projector and Store without running a paid model.
  const controller = Object.assign(Object.create(RuntimeController.prototype), { store, closed: false });
  const context = { sessionId: session.id, turnId, cancelled: false, submitted: new Map(), usageKeys: new Set() };
  t.after(() => { clearTimeout(context.flushTimer); });
  const send = event => controller.event(context, event);
  const start = (id = 'assistant-1') => send({ type: 'message_start', message: { id, role: 'assistant', content: '' } });
  const delta = (text, id = 'assistant-1') => send({ type: 'message_update', message: { id, role: 'assistant', content: text } });
  const end = (text, id = 'assistant-1') => send({ type: 'message_end', message: { id, role: 'assistant', content: text, stopReason: 'stop', usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8 } } });
  const disk = () => readStateFile(file).state;
  return { store, file, directory, project, session, current, turnId, controller, context, send, start, delta, end, disk };
}

test('many assistant and tool deltas are visible in one notification before completion without any state write', async t => {
  const f = fixture(t); f.start();
  f.send({ type: 'tool_execution_start', toolCallId: 'tool-1', callKey: 'request:tool-1', toolName: 'fixture_read', args: {} });
  const writes = f.store.persistence.writes, persisted = readFileSync(f.file, 'utf8'), revisions = [];
  const unsubscribe = f.store.subscribe(revision => revisions.push(revision)); t.after(unsubscribe);
  for (let index = 0; index < 1000; index++) {
    f.delta(`assistant partial ${index}`);
    f.send({ type: 'tool_execution_update', toolCallId: 'tool-1', callKey: 'request:tool-1', partialResult: { content: [{ type: 'text', text: `tool partial ${index}` }] } });
  }
  assert.equal(revisions.length, 0, 'updates are coalesced rather than notifying once per delta');
  await delay(140);
  assert.equal(revisions.length, 1); assert.equal(f.store.persistence.writes, writes); assert.equal(readFileSync(f.file, 'utf8'), persisted);
  assert.equal(f.current().status, 'running');
  const visible = f.store.get().sessions.find(item => item.id === f.session.id);
  assert.equal(visible.items.find(item => item.kind === 'assistant').text, 'assistant partial 999');
  assert.equal(visible.items.find(item => item.kind === 'tool').tool.output, 'tool partial 999');
  assert.equal(visible.items.find(item => item.kind === 'tool').tool.status, 'running');
  f.send({ type: 'tool_execution_end', toolCallId: 'tool-1', callKey: 'request:tool-1', result: { content: [{ type: 'text', text: 'Verified final output' }] } });
  f.end('Complete assistant answer'); f.store.finishRuntimeTurn(f.session.id, f.turnId);
  const final = f.disk().sessions.find(item => item.id === f.session.id);
  assert.equal(final.turns.at(-1).status, 'completed'); assert.equal(final.usage.tokens, 8);
  assert.equal(final.items.find(item => item.kind === 'user').text, 'Durable user request');
  assert.equal(final.items.find(item => item.kind === 'assistant').text, 'Complete assistant answer');
  assert.equal(final.items.find(item => item.kind === 'assistant').streaming, false);
  assert.equal(final.items.find(item => item.kind === 'tool').tool.output, 'Verified final output');
  assert.equal(final.items.find(item => item.kind === 'tool').tool.status, 'succeeded');
});

test('a durable boundary flushes pending display immediately and final output wins over late deltas', async t => {
  const f = fixture(t); f.start(); f.delta('pending before tool starts');
  f.send({ type: 'tool_execution_start', toolCallId: 't', callKey: 'first:t', toolName: 'fixture_read', args: {} });
  assert.equal(f.disk().sessions[0].items.find(item => item.kind === 'assistant').text, 'pending before tool starts');
  f.send({ type: 'tool_execution_update', toolCallId: 't', callKey: 'first:t', partialResult: { content: 'pending output' } });
  f.send({ type: 'tool_execution_end', toolCallId: 't', callKey: 'first:t', result: { content: 'final output' } });
  f.end('Final text');
  const writes = f.store.persistence.writes, before = JSON.stringify(f.store.state);
  f.delta('late overwritten text'); f.send({ type: 'tool_execution_update', toolCallId: 't', callKey: 'first:t', partialResult: { content: 'late overwritten output' } });
  await delay(140);
  assert.equal(JSON.stringify(f.store.state), before); assert.equal(f.store.persistence.writes, writes);
  f.start('assistant-2'); f.delta('stale previous message', 'assistant-1'); await delay(140);
  assert.equal(f.current().items.findLast(item => item.kind === 'assistant').text, '');
});

test('ordinary durable mutations include the latest displayed text and pause/resume remains durable', async t => {
  const f = fixture(t); f.start(); f.delta('visible checkpoint'); await delay(140);
  f.store.controlSession(f.session.id, 'pause');
  const paused = f.disk().sessions[0];
  assert.equal(paused.status, 'paused'); assert.equal(paused.turns.at(-1).status, 'paused');
  assert.equal(paused.items.find(item => item.kind === 'assistant').text, 'visible checkpoint');
  f.delta('late during pause'); f.controller.flush(f.context);
  assert.equal(f.current().items.find(item => item.kind === 'assistant').text, 'visible checkpoint');
  f.store.controlSession(f.session.id, 'resume');
  assert.equal(f.disk().sessions[0].status, 'running');
  f.delta('late from the old stream after resume'); f.controller.flush(f.context);
  assert.equal(f.current().items.find(item => item.kind === 'assistant').text, 'visible checkpoint', 'a resumed turn does not reopen the old assistant stream');
});

test('archive, complete, deleted project, cancelled context and emergency reject pending or late display updates', async t => {
  for (const scenario of ['archive', 'complete', 'deleted-project', 'cancelled', 'emergency']) await t.test(scenario, async t => {
    const f = fixture(t); f.start(); f.delta('pending stale update');
    if (scenario === 'archive') f.store.updateSession(f.session.id, { archived: true });
    if (scenario === 'complete') f.store.finishRuntimeTurn(f.session.id, f.turnId);
    if (scenario === 'deleted-project') f.store.mutate(state => { state.projects = []; });
    if (scenario === 'cancelled') f.context.cancelled = true;
    if (scenario === 'emergency') f.store.mutate(state => { state.emergency = true; });
    const state = JSON.stringify(f.store.state), writes = f.store.persistence.writes;
    await delay(140); f.delta('later update'); f.controller.flush(f.context);
    assert.equal(JSON.stringify(f.store.state), state); assert.equal(f.store.persistence.writes, writes);
  });
});

test('display API rejects control/configuration changes and invalid batches atomically', t => {
  const f = fixture(t); f.start();
  const valid = { type: 'assistant_text', itemId: f.context.assistantId, text: 'allowed field' };
  const input = { sessionId: f.session.id, turnId: f.turnId, updates: [valid] }, before = JSON.stringify(f.store.state), writes = f.store.persistence.writes;
  for (const invalid of [
    { ...input, settings: { tokenBudget: 0 } },
    { ...input, updates: [{ ...valid, streaming: false }] },
    { ...input, updates: [{ ...valid, type: 'assistant_end' }] },
    { ...input, updates: [valid, { type: 'tool_output', itemId: 'missing', output: {}, status: 'succeeded' }] },
    { ...input, updates: [{ ...valid, text: 'x'.repeat(64001) }] }
  ]) assert.throws(() => f.store.projectRuntimeDisplay(invalid), TypeError);
  assert.equal(JSON.stringify(f.store.state), before); assert.equal(f.store.persistence.writes, writes);
  assert.equal(f.store.projectRuntimeDisplay({ ...input, turnId: 'wrong-turn' }), false);
  assert.equal(f.store.projectRuntimeDisplay({ ...input, updates: [{ ...valid, itemId: f.current().items.find(item => item.kind === 'user').id }] }), false);
  f.store.persistence.failed = true;
  assert.equal(f.store.projectRuntimeDisplay(input), false, 'failed durability remains fail closed');
  assert.equal(JSON.stringify(f.store.state), before);
});

test('partial output requires exact call identity and does not reopen a completed tool', async t => {
  const f = fixture(t); f.start();
  f.send({ type: 'tool_execution_start', toolCallId: 'reused', callKey: 'first:reused', toolName: 'fixture_read', args: {} });
  f.send({ type: 'tool_execution_update', toolCallId: 'reused', callKey: 'wrong:reused', partialResult: { content: 'wrong call' } });
  f.controller.flush(f.context); assert.equal(f.current().items.find(item => item.tool).tool.output, '');
  f.send({ type: 'tool_execution_end', toolCallId: 'reused', callKey: 'first:reused', result: { content: 'first final' } });
  f.send({ type: 'tool_execution_start', toolCallId: 'reused', callKey: 'second:reused', toolName: 'fixture_read', args: {} });
  f.send({ type: 'tool_execution_update', toolCallId: 'reused', partialResult: { content: 'ambiguous' } });
  f.send({ type: 'tool_execution_update', toolCallId: 'reused', callKey: 'first:reused', partialResult: { content: 'stale first' } });
  f.send({ type: 'tool_execution_update', toolCallId: 'reused', callKey: 'second:reused', partialResult: { content: 'second partial' } });
  await delay(140);
  assert.deepEqual(f.current().items.filter(item => item.tool).map(item => item.tool.output), ['first final', 'second partial']);
});

test('live RuntimeController preserves request reservation and final usage while streaming without writes', async t => {
  const f = fixture(t);
  let emit, finish, began;
  const started = new Promise(resolve => { began = resolve; }), waiting = new Promise(resolve => { finish = resolve; });
  const controller = new RuntimeController(f.store, { factory: async options => {
    emit = options.onEvent;
    return {
      snapshot: () => ({ sessionFile: join(f.directory, 'fixture.jsonl'), sessionId: 'fixture-sdk', tools: [], messages: [], queue: { steering: [] }, cache: { estimatedInputTokens: 10 } }),
      prompt: async () => {
        await options.beforeCompletion({ signal: new AbortController().signal, estimatedInputTokens: 10, maxOutputTokens: 1000 });
        emit({ type: 'message_start', message: { id: 'live', role: 'assistant', content: '' } }); began(); await waiting;
        emit({ type: 'message_end', message: { id: 'live', role: 'assistant', content: 'Complete actual host projection', stopReason: 'stop', usageReported: true, usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18 } } });
      },
      abort: async () => finish(), dispose: async () => {}
    };
  } });
  t.after(async () => { finish(); await controller.close(); });
  await started;
  const writes = f.store.persistence.writes, before = readFileSync(f.file, 'utf8');
  for (let n = 0; n < 200; n++) emit({ type: 'message_update', message: { id: 'live', role: 'assistant', content: `visible live ${n}` } });
  await delay(140);
  assert.equal(f.current().items.findLast(item => item.kind === 'assistant').text, 'visible live 199');
  assert.equal(f.store.persistence.writes, writes); assert.equal(readFileSync(f.file, 'utf8'), before);
  const running = controller.running.get(f.session.id).runPromise; finish(); await running;
  const final = f.disk(); assert.equal(final.sessions[0].turns.at(-1).status, 'completed'); assert.equal(final.sessions[0].usage.tokens, 18);
  assert.equal(final.sessions[0].items.findLast(item => item.kind === 'assistant').text, 'Complete actual host projection');
  assert.equal(final.realUsage.reportedTokens, 18); assert.equal(final.realUsage.reservedTokens, 0); assert.deepEqual(final.realUsage.reservations, {});
  await controller.close();
});
