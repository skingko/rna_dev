import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.mjs';
import { createSession } from '../../../packages/sdk/src/session.mjs';
import { initialMaintenance, persistMaintenance, readMaintenance, maintenancePaths } from '../application-maintenance-state.mjs';
import { runMaintenanceOperation } from '../application-maintenance-worker.mjs';
import { createStateCheckpoint, verifyStateCheckpoint } from '../state-checkpoint.mjs';
import { atomicWrite } from '../durable-files.mjs';
import { readStateFile } from '../state-shards.mjs';

const questions = [{ id: 'choice', question: '选择接下来的方向', options: [{ id: 'a', label: '保留现有方向' }, { id: 'b', label: '调整方向' }] }];
const answer = { requestId: 'original-answer', answers: [{ id: 'choice', selected: ['a'], custom: '保留先前写入内容' }] };
const until = async (check, timeout = 6000) => { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error('Question handoff did not settle'); await delay(10); } };
async function fixture(t, { providerTail, trailingEffect = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-question-handoff-'))), file = join(dir, 'state.json');
  const counts = { requests: 0, effects: 0 }, handles = [];
  const factory = async options => {
    const handle = await createSession({ ...options, tools: [...options.managementTools.filter(tool => tool.name === 'ask_user'), { name: 'write_once', effect: 'write', idempotent: false, parameters: { type: 'object', properties: {}, additionalProperties: false }, execute() { counts.effects++; writeFileSync(join(dir, 'delivery.txt'), 'original delivery'); return 'written'; } }],
      provider: async function* (input) {
        counts.requests++;
        const written = input.messages.some(row => row.role === 'toolResult' && row.toolName === 'write_once'), answered = input.messages.some(row => row.role === 'toolResult' && row.toolName === 'ask_user');
        if (!written) yield { type: 'tool_call', id: 'write-call', name: 'write_once', arguments: {} };
        else if (!answered) { yield { type: 'tool_call', id: 'question-call', name: 'ask_user', arguments: { questions } }; if (trailingEffect) yield { type: 'tool_call', id: 'unstarted-write', name: 'write_once', arguments: {} }; }
        else { assert.match(JSON.stringify(input.messages), /original-answer|保留先前写入内容/); yield { type: 'text_delta', delta: '原任务已完成' }; }
        yield { type: 'usage', usage: { input: 10, output: 2, totalTokens: 12 } };
        yield { type: 'done', stopReason: answered ? 'stop' : 'toolUse' };
        if (written && !answered) await providerTail?.();
      }
    }); handles.push(handle); return handle;
  };
  let app;
  const open = async () => { app = createServer({ stateFile: file, ticks: false, runtimeFactory: factory }); await app.initializer.close(); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); return app; };
  await open();
  t.after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });
  const provider = app.store.configurationService.provider(null, { name: 'Local protocol fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fixture-no-network', models: [{ id: 'fixture', contextWindow: 32000, maxOutputTokens: 500, reasoning: ['off'] }] });
  app.store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { session } = app.store.createProject({ name: 'Question maintenance', workspace: dir, initiative: { enabled: false } });
  const row = () => app.store.state.sessions.find(item => item.id === session.id), question = () => row().items.find(item => item.interaction?.toolCallId === 'question-call')?.interaction;
  app.store.message(session.id, { text: '写入一次，再询问原问题' });
  const post = async (path, input) => { const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); return { status: response.status, body: await response.json() }; };
  const prepare = () => {
    const health = app.health();
    const operation = initialMaintenance('backup', {}, randomUUID(), { process: health.process, runtimeIdentity: health.runtimeIdentity, hostVersion: health.version, sdkVersion: health.sdkVersion, nodeVersion: process.versions.node, stateVersion: 2, config: { command: process.execPath, cwd: dir, port: app.server.address().port, manager: 'session' } });
    operation.checkpointId = randomUUID(); operation.questionHandoff = { version: 1, capability: 'supported', requestId: `question-${operation.id}` };
    persistMaintenance(file, operation); app.maintenanceGate.refresh(); return operation;
  };
  const suspend = async operation => { const response = await post('/api/maintenance/questions/suspend', { operationId: operation.id, requestId: operation.questionHandoff.requestId }); assert.equal(response.status, 200); return response.body; };
  const release = operation => { persistMaintenance(file, { ...readMaintenance(file), phase: 'completed', held: false, completedAt: new Date().toISOString() }); app.maintenanceGate.refresh(); app.questionHandoff.reconcile(); };
  return { get app() { return app; }, dir, file, counts, handles, session, row, question, open, post, prepare, suspend, release };
}

test('real SDK + host + maintenance worker: suspend, exact checkpoint, successor reattaches original question with zero repeated requests/effects', async t => {
  const f = await fixture(t); await until(() => f.question()?.status === 'pending');
  const original = structuredClone(f.question()), originalPrompt = f.row().turns.at(-1).runtimeMessageId, operation = f.prepare();
  let old = true, offline = false, checkpoint;
  const result = await runMaintenanceOperation({ stateFile: f.file, id: operation.id, io: {
    runtimeIdentity: () => operation.expected.runtimeIdentity, binding: () => true, waitMs: 6000,
    health: async () => offline ? null : f.app.health(),
    suspendQuestions: (_port, input) => f.app.questionHandoff.suspend(input),
    createCheckpoint: async options => { checkpoint = await createStateCheckpoint(options); return checkpoint; },
    service: async (_config, action) => {
      if (action === 'stop') {
        assert.equal(old, true); assert.equal(f.app.health().workload.activeWork, false);
        const closed = await f.app.close(); assert.equal(closed.drained, true); offline = true;
        const h = operation.expected; atomicWrite(`${maintenancePaths(f.file).directory}/drain-receipt.json`, JSON.stringify({ schemaVersion: 1, drained: true, pid: h.process.pid, instanceId: h.process.instanceId, runtimeIdentity: h.runtimeIdentity, maintenanceOperationId: operation.id, at: new Date().toISOString() }));
        return { stoppedDaemon: { pid: h.process.pid, generation: h.process.generation }, lastDaemonExit: { pid: h.process.pid, generation: h.process.generation, code: 0, signal: null, at: new Date().toISOString() } };
      }
      old = false; await f.open(); offline = false; return { started: true };
    }
  } });
  assert.equal(result.phase, 'completed', JSON.stringify(result)); assert.equal(result.questionHandoff.suspended, 1);
  await until(() => f.app.interactions.isWaiting(f.session.id));
  assert.deepEqual(f.counts, { requests: 2, effects: 1 }); assert.equal(f.question().id, original.id); assert.equal(f.question().fingerprint, original.fingerprint); assert.equal(f.question().toolCallId, original.toolCallId); assert.equal(f.row().turns.at(-1).runtimeMessageId, originalPrompt); assert.equal(f.row().maintenanceQuestion.phase, 'reattached');
  const verified = await verifyStateCheckpoint({ directory: checkpoint.directory }); assert.ok(verified.files > 2);
  const saved = readStateFile(join(checkpoint.directory, 'payload', 'state.json')).state; assert.equal(saved.sessions.find(item => item.id === f.session.id).maintenanceQuestion.phase, 'suspended');
  const journalFile = f.row().runtime.sessionFile, journalRelative = journalFile.slice(dirname(f.file).length + 1), prefix = readFileSync(join(checkpoint.directory, 'payload', journalRelative));
  assert.deepEqual(readFileSync(journalFile).subarray(0, prefix.length), prefix);
  const response = await f.post(`/api/sessions/${f.session.id}/interactions/${original.id}/answer`, answer); assert.equal(response.status, 200);
  await until(() => f.row().status === 'idle'); assert.deepEqual(f.counts, { requests: 3, effects: 1 });
  assert.equal(f.row().items.filter(item => item.interaction?.id === original.id).length, 1); assert.equal(f.row().turns.length, 1); assert.equal(readFileSync(join(f.dir, 'delivery.txt'), 'utf8'), 'original delivery');
});

for (const before of [false, true]) test(`answer ${before ? 'before' : 'after'} canonical suspension is retained; maintenance never re-asks or double-starts`, async t => {
  const f = await fixture(t); await until(() => f.question()?.status === 'pending'); const operation = f.prepare(), id = f.question().id;
  if (before) { assert.equal((await f.post(`/api/sessions/${f.session.id}/interactions/${id}/answer`, answer)).status, 200); await until(() => f.row().status === 'idle'); assert.equal((await f.suspend(operation)).suspended, 0); }
  else { assert.equal((await f.suspend(operation)).suspended, 1); await until(() => !f.app.executor.running.size); const response = await f.post(`/api/sessions/${f.session.id}/interactions/${id}/answer`, answer); assert.equal(response.status, 200); assert.equal(response.body.requiresResume, true); assert.deepEqual(f.counts, { requests: 2, effects: 1 }); }
  f.release(operation); await until(() => f.row().status === 'idle'); assert.deepEqual(f.counts, { requests: 3, effects: 1 }); assert.equal(f.question().id, id);
});

for (const action of ['pause', 'stop']) test(`explicit user ${action} overrides operation-bound automatic reattachment durably`, async t => {
  const f = await fixture(t); await until(() => f.question()?.status === 'pending'); const operation = f.prepare(); await f.suspend(operation); await until(() => !f.app.executor.running.size);
  assert.equal((await f.post(`/api/sessions/${f.session.id}/control`, { action })).status, 200); assert.match(f.row().maintenanceQuestion.phase, /^user_/);
  await f.app.close(); await f.open(); f.release(operation); await delay(80);
  assert.equal(f.app.executor.running.size, 0); assert.deepEqual(f.counts, { requests: 2, effects: 1 }); assert.equal(f.row().status, action === 'pause' ? 'paused' : 'idle');
});

test('live provider tail, host request reservation, queued steering and canonical changed tools block suspension', async t => {
  let release; const tail = new Promise(resolve => { release = resolve; }); const f = await fixture(t, { providerTail: () => tail });
  await until(() => f.counts.requests === 2); const operation = f.prepare();
  assert.equal((await f.suspend(operation)).suspended, 0); assert.equal(f.app.executor.maintenanceQuestionCandidate(f.session.id), null);
  release(); await until(() => f.question()?.status === 'pending');
  const context = f.app.executor.running.get(f.session.id); context.reservation = 'unreleased-lease'; assert.equal(f.app.executor.maintenanceQuestionCandidate(f.session.id), null); context.reservation = null;
  const proof = context.handle.questionCheckpoint({ runtimeMessageId: f.row().turns.at(-1).runtimeMessageId }); assert.equal(proof.toolCallId, 'question-call');
  await context.handle.steer('保留这条真实的新指令'); assert.equal((await f.suspend(operation)).suspended, 0); assert.equal(f.row().status, 'running');
});

test('stale operation/request, non-question active work and canonical mismatch cannot authorize automatic work', async t => {
  const f = await fixture(t); await until(() => f.question()?.status === 'pending'); const operation = f.prepare();
  assert.equal((await f.post('/api/maintenance/questions/suspend', { operationId: randomUUID(), requestId: operation.questionHandoff.requestId })).status, 409);
  const original = f.app.questionHandoff.otherWork; f.app.questionHandoff.otherWork = () => true; assert.equal((await f.suspend(operation)).suspended, 0); f.app.questionHandoff.otherWork = original;
  await f.suspend(operation); await until(() => !f.app.executor.running.size);
  f.app.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).maintenanceQuestion.argumentsHash = 'foreign-proof'; });
  f.release(operation); await until(() => f.row().maintenanceQuestion.phase === 'blocked'); assert.equal(f.row().status, 'paused'); assert.deepEqual(f.counts, { requests: 2, effects: 1 });
});

test('ask_user followed by an undispatched write remains active, never a maintenance idle shortcut', async t => {
  const f = await fixture(t, { trailingEffect: true }); await until(() => f.question()?.status === 'pending'); const operation = f.prepare();
  assert.equal(f.app.executor.running.get(f.session.id).handle.snapshot().recovery.pendingTools, 2);
  assert.equal((await f.suspend(operation)).suspended, 0); assert.equal(f.row().status, 'running'); assert.deepEqual(f.counts, { requests: 2, effects: 1 });
});

test('failed durable suspension has no partial pause; duplicate negotiation preserves one receipt and original question', async t => {
  const f = await fixture(t); await until(() => f.question()?.status === 'pending'); const operation = f.prepare(), id = f.question().id;
  const persist = f.app.store.persist; f.app.store.persist = () => { throw new Error('fixture disk unavailable'); };
  await assert.rejects(f.app.questionHandoff.suspend({ operationId: operation.id, requestId: operation.questionHandoff.requestId }), /fixture disk unavailable/);
  f.app.store.persist = persist; assert.equal(f.row().status, 'running'); assert.equal(f.row().maintenanceQuestion, undefined); assert.equal(f.question().status, 'pending');
  await f.suspend(operation); await until(() => !f.app.executor.running.size); const receipt = structuredClone(f.row().maintenanceQuestion);
  const replay = await f.suspend(operation); assert.equal(replay.suspended, 1); assert.deepEqual(f.row().maintenanceQuestion, receipt);
  f.release(operation); await until(() => f.app.interactions.isWaiting(f.session.id)); assert.equal(f.question().id, id); assert.deepEqual(f.counts, { requests: 2, effects: 1 });
});

test('lost HTTP audit summary and successor restart still recover from owned session receipt; another operation cannot steal it', async t => {
  const f = await fixture(t); await until(() => f.question()?.status === 'pending'); const operation = f.prepare(); await f.suspend(operation); await until(() => !f.app.executor.running.size);
  // Crash after Store receipt committed but before optional operation summary.
  persistMaintenance(f.file, operation); await f.app.close(); await f.open();
  persistMaintenance(f.file, { ...operation, id: randomUUID(), held: false, phase: 'completed' }); f.app.maintenanceGate.refresh(); f.app.questionHandoff.reconcile(); await delay(50); assert.equal(f.row().status, 'paused');
  persistMaintenance(f.file, operation); f.release(operation); await until(() => f.app.interactions.isWaiting(f.session.id)); assert.deepEqual(f.counts, { requests: 2, effects: 1 });
});

for (const condition of ['cancelled', 'failed', 'recovery_required', 'restore']) test(`maintenance ${condition} release respects suspension ownership and failure recovery`, async t => {
  const f = await fixture(t); await until(() => f.question()?.status === 'pending'); const operation = f.prepare(); await f.suspend(operation); await until(() => !f.app.executor.running.size);
  const auto = ['cancelled', 'failed'].includes(condition);
  persistMaintenance(f.file, { ...readMaintenance(f.file), phase: condition === 'restore' ? 'completed' : condition, kind: condition === 'restore' ? 'restore' : 'backup', held: condition === 'recovery_required', ...(condition === 'recovery_required' ? { stopped: true } : {}) });
  f.app.maintenanceGate.refresh(); f.app.questionHandoff.reconcile();
  if (auto) await until(() => f.app.interactions.isWaiting(f.session.id)); else { await delay(60); assert.equal(f.row().status, 'paused'); assert.equal(f.app.executor.running.size, 0); }
  assert.deepEqual(f.counts, { requests: 2, effects: 1 });
});

test('new user direction while suspended is retained and prevents automatic old-question resume', async t => {
  const f = await fixture(t); await until(() => f.question()?.status === 'pending'); const operation = f.prepare(); await f.suspend(operation); await until(() => !f.app.executor.running.size);
  // Represent accepted input retained by another durable control surface.
  f.app.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).inbox.push({ id: 'new-direction', delivery: 'steer', text: '改变原来的方向', createdAt: new Date().toISOString() }); });
  assert.equal((await f.post(`/api/sessions/${f.session.id}/interactions/${f.question().id}/answer`, answer)).status, 200);
  f.release(operation); await until(() => f.row().maintenanceQuestion.phase === 'blocked'); assert.equal(f.row().inbox[0].text, '改变原来的方向'); assert.equal(f.question().status, 'answered'); assert.deepEqual(f.counts, { requests: 2, effects: 1 });
});

test('answer during maintenance after manual pause is saved but never revokes the user pause', async t => {
  const f = await fixture(t); await until(() => f.question()?.status === 'pending'); const operation = f.prepare(), id = f.question().id; await f.suspend(operation); await until(() => !f.app.executor.running.size);
  assert.equal((await f.post(`/api/sessions/${f.session.id}/control`, { action: 'pause' })).status, 200);
  const response = await f.post(`/api/sessions/${f.session.id}/interactions/${id}/answer`, answer); assert.equal(response.status, 200); assert.equal(response.body.requiresResume, true); assert.equal(f.question().status, 'answered');
  f.release(operation); await delay(50); assert.equal(f.row().status, 'paused'); assert.equal(f.row().pauseReason, 'manual'); assert.deepEqual(f.counts, { requests: 2, effects: 1 });
});

test('the turn clock stops at the suspension and counts again from the reattach (UX audit C-a)', async t => {
  const f = await fixture(t); await until(() => f.question()?.status === 'pending'); const operation = f.prepare();
  const started = f.row().turns.at(-1).attemptStartedAt;
  await f.suspend(operation); await until(() => !f.app.executor.running.size);
  const paused = f.row().turns.at(-1), pausedAt = paused.pausedAt;
  assert.equal(paused.status, 'paused'); assert.ok(pausedAt >= started);
  await delay(30); f.release(operation); await until(() => f.app.interactions.isWaiting(f.session.id));
  const turn = f.row().turns.at(-1);
  assert.equal(turn.pausedAt, undefined); assert.equal(turn.activeMs, Date.parse(pausedAt) - Date.parse(started)); assert.ok(turn.attemptStartedAt > pausedAt, 'the wait while suspended is not counted');
});
