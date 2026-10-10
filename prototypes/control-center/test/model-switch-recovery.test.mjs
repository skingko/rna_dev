import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-model-recovery-')), file = join(directory, 'state.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(file);
  store.configurationService.update({ memory: { autoStore: false, autoRecall: false } });
  const create = (name, id, contextWindow) => store.configurationService.provider(null, {
    name, protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1',
    models: [{ id, name, contextWindow, maxOutputTokens: 4096, reasoning: ['off', 'high'], input: ['text'] }]
  });
  const a = create('Provider A', 'model-a', 1000000), b = create('Provider B', 'model-b', 120000);
  const selectA = { providerId: a.id, modelId: 'model-a', reasoning: 'off' }, selectB = { providerId: b.id, modelId: 'model-b', reasoning: 'high' };
  const session = store.createSession({ modelSelection: selectA, workspace: directory });
  store.message(session.id, { text: 'Continue the existing work' });
  const current = () => store.state.sessions.find(row => row.id === session.id), turn = () => current().turns.at(-1);
  return { store, file, a, b, selectA, selectB, sessionId: session.id, current, turn,
    fail: () => store.finishRuntimeTurn(session.id, turn().id, { status: 'failed', errorCode: 'provider_auth', error: 'Controlled provider failure' }) };
}
const route = turn => structuredClone({ model: turn.model, modelSelection: turn.modelSelection, modelConfig: turn.modelConfig });

test('explicit retry adopts the selected provider and audits both immutable route snapshots', t => {
  const f = fixture(t), originalId = f.turn().id, previous = route(f.turn()); f.fail();
  f.store.updateSession(f.sessionId, { modelSelection: f.selectB });
  assert.deepEqual(route(f.turn()), previous, 'Selecting a future route does not rewrite the failed attempt');
  f.store.controlSession(f.sessionId, 'retry');
  assert.equal(f.turn().id, originalId); assert.equal(f.turn().modelConfig.providerId, f.b.id); assert.equal(f.turn().modelConfig.reasoning, 'high');
  assert.deepEqual(f.turn().modelSelection, f.selectB); assert.equal(f.current().status, 'running');
  assert.equal(f.turn().retryHistory.length, 1); assert.equal(f.turn().retryHistory[0].errorCode, 'provider_auth');
  assert.equal(f.turn().modelChanges.length, 1);
  const change = f.turn().modelChanges[0]; assert.equal(change.action, 'retry'); assert.ok(Number.isFinite(Date.parse(change.at)));
  assert.deepEqual(change.previous, previous); assert.deepEqual(change.next, route(f.turn()));
  const audit = structuredClone(change); f.fail(); f.store.controlSession(f.sessionId, 'retry');
  assert.equal(f.turn().retryHistory.length, 2); assert.deepEqual(f.turn().modelChanges, [audit], 'Same resolved route does not duplicate the change audit');
});

test('resume re-resolves catalog changes including reasoning, image input, capacity and compatibility', t => {
  const f = fixture(t); f.store.controlSession(f.sessionId, 'pause');
  f.store.updateSession(f.sessionId, { modelSelection: f.selectB });
  f.store.configurationService.provider(f.b.id, { models: [{ id: 'model-b', name: 'Updated B', contextWindow: 128000, maxOutputTokens: 8192, reasoning: ['off', 'high'], input: ['text', 'image'], cacheRetention: 'long', compat: { maxTokensField: 'max_tokens', supportsUsageInStreaming: false, supportsPromptCacheKey: true } }] });
  const previous = route(f.turn()); f.store.controlSession(f.sessionId, 'resume');
  const resolved = f.turn().modelConfig;
  assert.equal(resolved.reasoning, 'high'); assert.deepEqual(resolved.input, ['text', 'image']);
  assert.equal(resolved.contextWindow, 128000); assert.equal(resolved.maxOutputTokens, 8192); assert.equal(f.current().context.capacity, 128000);
  assert.equal(resolved.compat.maxTokensField, 'max_tokens'); assert.equal(resolved.compat.supportsUsageInStreaming, false); assert.equal(resolved.cacheRetention, 'long');
  assert.equal(f.turn().modelChanges[0].action, 'resume'); assert.deepEqual(f.turn().modelChanges[0].previous, previous);
  assert.deepEqual(f.turn().modelChanges[0].next, route(f.turn()));
});

test('a running turn remains on A while an explicitly queued next turn starts on B', t => {
  const f = fixture(t), first = structuredClone(f.turn());
  f.store.updateSession(f.sessionId, { modelSelection: f.selectB });
  assert.deepEqual(f.turn(), first);
  f.store.message(f.sessionId, { text: 'The next independent request', delivery: 'followup' });
  assert.deepEqual(route(f.turn()), route(first)); assert.equal(f.current().inbox.length, 1);
  f.store.finishRuntimeTurn(f.sessionId, first.id, { status: 'completed' });
  assert.equal(f.current().turns.length, 2); assert.notEqual(f.turn().id, first.id);
  assert.equal(f.current().turns[0].modelConfig.providerId, f.a.id); assert.equal(f.turn().modelConfig.providerId, f.b.id);
  assert.equal(f.current().inbox.length, 0);
});

for (const action of ['retry', 'resume']) test(`removed provider makes ${action} atomic: old turn, audit and persisted state survive`, t => {
  const f = fixture(t); f.fail(); f.store.updateSession(f.sessionId, { modelSelection: f.selectB }); f.store.controlSession(f.sessionId, 'retry');
  if (action === 'retry') f.fail(); else f.store.controlSession(f.sessionId, 'pause');
  // Simulate a separately edited catalog: public deletion correctly refuses a
  // selected provider, but stale persisted selections still need fail-closed recovery.
  f.store.mutate(state => { state.configuration.providers = state.configuration.providers.filter(row => row.id !== f.b.id); });
  const before = structuredClone(f.store.state), persisted = readFileSync(f.file, 'utf8');
  assert.throws(() => f.store.controlSession(f.sessionId, action), error => error.status === 404 && /供应商/.test(error.message));
  assert.deepEqual(f.store.state, before); assert.equal(readFileSync(f.file, 'utf8'), persisted);
  assert.equal(f.turn().modelChanges.length, 1);
});

test('model recovery preserves uncertain tool records, verified resolutions and completed tool receipts', t => {
  const f = fixture(t), turnId = f.turn().id;
  f.store.mutate(state => {
    const session = state.sessions.find(row => row.id === f.sessionId), turn = session.turns.at(-1);
    turn.toolResolutions = { verified: { status: 'completed', note: 'Receipt checked', result: { content: [{ type: 'text', text: 'verified output' }] }, isError: false } };
    session.items.push({ id: 'completed-tool', kind: 'tool', turnId, tool: { name: 'project_edit', status: 'completed', output: 'Already committed' } });
  });
  const recovery = { uncertainTools: [{ callKey: 'pending', toolName: 'project_exec', arguments: { command: 'do-once' } }], reason: 'missing_receipt' };
  f.store.pauseRuntimeRecovery(f.sessionId, turnId, recovery);
  const retainedRecovery = structuredClone(f.current().runtime.recovery), retainedResolutions = structuredClone(f.turn().toolResolutions), completed = structuredClone(f.current().items.find(row => row.id === 'completed-tool'));
  f.store.updateSession(f.sessionId, { modelSelection: f.selectB }); f.store.controlSession(f.sessionId, 'resume');
  assert.equal(f.turn().id, turnId); assert.equal(f.turn().modelConfig.providerId, f.b.id);
  assert.deepEqual(f.current().runtime.recovery, retainedRecovery); assert.deepEqual(f.turn().toolResolutions, retainedResolutions);
  assert.deepEqual(f.current().items.find(row => row.id === 'completed-tool'), completed);
  assert.equal(f.current().items.filter(row => row.id === 'completed-tool').length, 1);
});

test('new steering that resumes recovery adopts the saved model without discarding unresolved operations', t => {
  const f = fixture(t), turnId = f.turn().id;
  f.store.pauseRuntimeRecovery(f.sessionId, turnId, { uncertainTools: [{ callKey: 'pending', toolName: 'project_exec', arguments: { command: 'do-once' } }] });
  const recovery = structuredClone(f.current().runtime.recovery);
  f.store.updateSession(f.sessionId, { modelSelection: f.selectB });
  const result = f.store.message(f.sessionId, { text: 'Use the new model to continue', delivery: 'steer' });
  assert.equal(result.queued, true); assert.equal(f.current().activeTurnId, turnId);
  assert.equal(f.turn().modelConfig.providerId, f.b.id); assert.equal(f.turn().modelChanges[0].action, 'message-resume');
  assert.deepEqual(f.current().runtime.recovery, recovery); assert.equal(f.current().inbox.length, 1);
});

test('a failed real turn cannot silently resume through the demonstration executor', t => {
  const f = fixture(t); f.fail();
  f.store.updateSession(f.sessionId, { modelSelection: { providerId: 'demo', modelId: 'demo', reasoning: 'off' } });
  const before = structuredClone(f.store.state);
  assert.throws(() => f.store.controlSession(f.sessionId, 'retry'), /真实轮次需要真实模型/);
  assert.deepEqual(f.store.state, before);
});
