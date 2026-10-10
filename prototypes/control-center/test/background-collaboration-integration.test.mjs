import test from 'node:test';
import { sayAndFinish } from './helpers/foreground-turn.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { ProjectPermissionService } from '../project-permissions.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { RuntimeController } from '../runtime-controller.mjs';
import { readStateFile, readStateText } from '../state-shards.mjs';

const hold = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check, label) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (check()) return; await delay(5); }
  throw new Error(`Background collaboration timeout: ${label}`);
}

// Exercise the real Store notification path, actual SDK journal and actual
// project_read tool. Only provider output is scripted; no production state or
// credentials and no networked model, memory or marketplace are involved.
async function fixture(t, { writable = false, ignoreAbort = false, share = false, nextTool = false, uncertainTool = false, fromMessage = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-background-collaboration-'));
  const store = new Store(join(directory, 'state.json')), release = hold(), releaseTool = hold(), toolState = { calls: 0 };
  const provider = store.configurationService.provider(null, { name: 'Isolated collaboration fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'collaboration-fixture', contextWindow: 128000, maxOutputTokens: 2048, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'collaboration-fixture', reasoning: 'off' }, memory: { autoStore: false, autoRecall: false } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Independent background investigation', workspace: directory, initiative: { cooldownMs: 0 } });
  store.mutate(state => {
    const target = state.projects.find(row => row.id === project.id);
    target.decisionMode = 'rna-model'; target.initialization = { status: 'ready' }; target.simulated = false;
    target.permissions = { workspace: writable ? 'write' : 'read', background: writable ? 'inherit' : 'read', revision: 1 };
    target.assignments = { skillIds: [], toolIds: writable ? ['project_read', 'project_write'] : ['project_read'], mcpServerIds: [] };
    state.settings.realTokenBudget = null;
    // fromMessage: the work comes from a message in the conversation (it cites it).
    if (fromMessage) state.sessions.find(row => row.id === session.id).items.push({ id: 'request-message', kind: 'user', text: 'Please check the compatibility evidence in the background.', createdAt: new Date(Date.now() - 60000).toISOString(), simulated: false });
  });
  writeFileSync(join(directory, 'evidence.txt'), 'ACTUAL_FILE_EVIDENCE: the second input variant is absent.');
  const decisionInputs = [], workRequests = [], reads = [], handles = [], toolEnds = [], dispatched = new Set();
  let workSignal;
  const controllerOptions = {
    initialDelayMs: 0, tickIntervalMs: 0,
    decisionProvider: async function* (request) {
      const input = JSON.parse(request.messages[0].content[0].text); decisionInputs.push(input);
      const first = decisionInputs.length === 1, completed = input.events.find(event => event.type === 'action_completed');
      const shouldShare = share && completed && !input.recentActions.some(action => action.action === 'share');
      yield { type: 'text_delta', delta: JSON.stringify({ action: first ? 'work' : shouldShare ? 'share' : 'wait', content: first ? 'Read evidence.txt, investigate the missing compatibility case and retain its result.' : shouldShare ? '资料缺少第二种输入的兼容例子；检查已经完成。' : '', reason: 'Use actual retained evidence, with foreground and background responsibilities separate.', evidenceIds: [first && fromMessage ? input.events.find(event => event.type === 'user_message').id : completed?.id ?? input.events.at(-1).id], nextReviewAfterMs: 86400000 }) };
      yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: 'stop' };
    },
    runtimeFactory: async options => {
      const handle = await createRnaRuntime({ ...options,
        managementTools: [...options.managementTools, ...(uncertainTool ? [{ name: 'isolated_unconfirmed_effect', effect: 'write', permission: 'write', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => { toolState.calls++; await releaseTool.promise; return { isError: true, content: [{ type: 'text', text: 'Controlled tool receipt: external completion could not be established.' }], details: { cleanupUncertain: true } }; } }] : [])],
        onEvent: event => {
          if (event.type === 'tool_execution_start') dispatched.add(event.toolCallId);
          if (event.type === 'tool_execution_end') { toolEnds.push(event); if (event.toolName === 'project_read' && dispatched.has(event.toolCallId)) reads.push(event); }
          options.onEvent?.(event);
        }, provider: async function* (request) {
        workRequests.push(request); workSignal = request.signal;
        yield { type: 'usage', usage: { totalTokens: 10 } };
        if (!request.messages.some(message => message.role === 'toolResult')) {
          yield { type: 'tool_call', id: 'read-original-evidence-once', name: 'project_read', arguments: { path: 'evidence.txt' } };
          yield { type: 'done', stopReason: 'toolUse' }; return;
        }
        assert.match(JSON.stringify(request.messages), /ACTUAL_FILE_EVIDENCE/);
        let abort;
        const aborted = new Promise((_, reject) => { abort = () => reject(request.signal.reason); if (!ignoreAbort) { request.signal.addEventListener('abort', abort, { once: true }); if (request.signal.aborted) abort(); } });
        try { await Promise.race([release.promise, aborted]); } finally { request.signal.removeEventListener('abort', abort); }
        if ((nextTool || uncertainTool) && request.messages.filter(message => message.role === 'toolResult').length === 1) {
          yield { type: 'tool_call', id: uncertainTool ? 'unconfirmed-effect-once' : 'read-new-independent-evidence', name: uncertainTool ? 'isolated_unconfirmed_effect' : 'project_read', arguments: uncertainTool ? {} : { path: 'evidence.txt' } };
          yield { type: 'done', stopReason: 'toolUse' }; return;
        }
        yield { type: 'text_delta', delta: 'Verified evidence.txt: the second input compatibility example is absent. No project files were changed.' };
        yield { type: 'done', stopReason: 'stop' };
      } });
      handles.push(handle); return handle;
    }
  };
  const controller = new ProjectInitiativeController(store, controllerOptions), controllers = [controller];
  t.after(async () => { release.resolve(); releaseTool.resolve(); for (const instance of controllers) await instance.close(); rmSync(directory, { recursive: true, force: true }); });
  const current = () => store.state.projects.find(row => row.id === project.id);
  const action = () => current().initiativeRuntime.sdkState.actions.find(row => row.action === 'work');
  const job = () => current().jobs.find(row => row.id === action()?.id);
  const context = () => controller.contexts.get(project.id);
  await until(() => workRequests.length === 2 && reads.length === 1 && !context().reviewPromise, 'actual read completed and independent inspection remains active');
  const reopen = () => {
    const recoveredStore = new Store(join(directory, 'state.json'));
    const recoveredController = new ProjectInitiativeController(recoveredStore, { ...controllerOptions, initialDelayMs: 999999 });
    controllers.push(recoveredController); return { store: recoveredStore, controller: recoveredController };
  };
  return { directory, store, controller, projectId: project.id, sessionId: session.id, current, context, action, job, release, releaseTool, toolState, workRequests, decisionInputs, reads, toolEnds, handles, reopen, track: value => controllers.push(value), signal: () => workSignal };
}

test('a normal Store.message progress question preserves readonly work and its actual completed tool receipt', async t => {
  const f = await fixture(t), originalAction = f.action().id, signal = f.signal();
  // The question's foreground turn ends (no runtime runs it here); under the foreground lease its end is the wake.
  sayAndFinish(f.store, f.sessionId, '现在进展如何？请继续后台调查，同时回答我的问题。');
  assert.equal(signal.aborted, false, 'Store notification must invalidate the decision without aborting the worker');
  await until(() => f.decisionInputs.some(input => JSON.stringify(input.events).includes('现在进展如何')), 'latest foreground evidence reviewed');
  assert.equal(signal.aborted, false);
  assert.equal(f.action().id, originalAction); assert.equal(f.action().status, 'running');
  f.release.resolve();
  await until(() => f.job()?.status === 'completed' && f.action().status === 'completed', 'original action retains its result after a revision change');
  assert.equal(f.reads.length, 1); assert.equal(f.workRequests.length, 2); assert.equal(f.handles.length, 1);
  assert.equal(f.job().toolReceiptCounts.completed, 1); assert.match(f.job().output, /second input compatibility/);
  assert.equal(readFileSync(join(f.directory, 'evidence.txt'), 'utf8'), 'ACTUAL_FILE_EVIDENCE: the second input variant is absent.');
});

test('a late result is retained as work evidence and shared only by a fresh decision containing the follow-up', async t => {
  const f = await fixture(t, { share: true });
  f.store.message(f.sessionId, { text: 'FOLLOWUP_SCOPE: 只需汇报第二种输入的兼容性，不要重复已有状态。' });
  assert.equal(f.signal().aborted, false);
  f.release.resolve();
  const messages = () => f.store.state.sessions.find(row => row.id === f.sessionId).items.filter(item => item.source === 'initiative');
  await until(() => messages().length === 1, 'fresh decision delivers retained evidence once');
  const receipt = messages()[0], shareAction = f.current().initiativeRuntime.sdkState.actions.find(action => action.id === receipt.initiativeActionId);
  assert.ok(receipt.evidenceIds.includes(`action:${f.action().id}:completed`));
  assert.ok(shareAction.revision > f.action().revision, 'delivery is separately decided from newer context');
  assert.ok(f.decisionInputs.some(input => input.events.some(event => event.type === 'action_completed') && JSON.stringify(input.events).includes('FOLLOWUP_SCOPE')));
  for (let i = 0; i < 5; i++) await f.controller.pump();
  assert.equal(messages().length, 1); assert.equal(f.reads.length, 1);
});

// Authority changes stop running work: archiving or deleting the conversation the work came from, disabling the
// project, a narrower background permission (PDL-1: only a narrower one; context drift never does, see below).
for (const change of ['session-archive', 'project-disabled', 'permission-change', 'session-delete']) test(`${change} still revokes running background authority immediately`, async t => {
  const f = await fixture(t, { ignoreAbort: true, fromMessage: change === 'session-archive', writable: change === 'permission-change' }), signal = f.signal();
  if (change === 'session-archive') f.store.updateSession(f.sessionId, { archived: true });
  if (change === 'project-disabled') f.store.updateProject(f.projectId, { initiative: { enabled: false } });
  if (change === 'permission-change') new ProjectPermissionService(f.store).update(f.projectId, { workspace: 'write', background: 'read' });
  if (change === 'session-delete') f.store.deleteSession(f.sessionId);
  assert.equal(signal.aborted, true, 'authority changes must not be treated as ordinary chat evidence');
  f.release.resolve();
  await until(() => !f.context()?.activeHandles.size, 'aborted/late runtime cleanup finishes');
  assert.notEqual(f.job()?.status, 'completed');
  assert.equal(f.store.state.sessions.flatMap(session => session.items).filter(item => item.source === 'initiative').length, 0);
  assert.equal(f.reads.length, 1, 'previous completed read was not replayed');
});

// Context drift and conversation membership are not authority changes (PDL-1): the running work goes on and completes.
for (const change of ['permission-widened', 'project-renamed', 'new-conversation', 'plan-toggle', 'unrelated-archive', 'capability-install-elsewhere', 'gene-generation']) test(`${change} leaves running background work alone`, async t => {
  const f = await fixture(t), signal = f.signal(), context = f.context(), drift = context.drift;
  // A gene generation in this project: a new active version, its skill in the global registry and in the assignments.
  if (change === 'gene-generation') f.store.mutate(state => {
    const project = state.projects.find(row => row.id === f.projectId);
    project.versions = [...(project.versions ?? []), { id: 'gen-1', version: 'gen-1', state: 'active', source: 'gene-tree', bundle: { hash: 'f'.repeat(64) }, createdAt: new Date().toISOString(), simulated: false }];
    project.activeVersionId = 'gen-1'; project.capabilityRevision = (project.capabilityRevision ?? 0) + 1;
    project.assignments = { ...project.assignments, skillIds: [...(project.assignments.skillIds ?? []), 'gen-skill'] };
    state.capabilities = { ...state.capabilities, revision: (state.capabilities?.revision ?? 0) + 1, skills: [...(state.capabilities?.skills ?? []), { id: 'gen-skill', name: 'Generation 1 skill', description: 'This project’s own' }] };
  });
  if (change === 'permission-widened') new ProjectPermissionService(f.store).update(f.projectId, { workspace: 'write', background: 'read' });
  if (change === 'project-renamed') f.store.updateProject(f.projectId, { name: 'Renamed investigation' });
  if (change === 'new-conversation') f.store.createSession({ projectId: f.projectId, title: 'Another conversation' });
  if (change === 'plan-toggle') { f.store.updateSession(f.sessionId, { mode: 'plan' }); f.store.updateSession(f.sessionId, { mode: 'build' }); }
  if (change === 'unrelated-archive') { const other = f.store.createSession({ projectId: f.projectId, title: 'Side discussion' }); f.store.updateSession(other.id, { archived: true }); }
  if (change === 'capability-install-elsewhere') f.store.mutate(state => { state.capabilities = { ...state.capabilities, revision: (state.capabilities?.revision ?? 0) + 1, skills: [...(state.capabilities?.skills ?? []), { id: 'elsewhere-skill', name: 'Installed in another project', description: 'Not assigned here' }] }; });
  for (let i = 0; i < 3; i++) await f.controller.pump();
  assert.equal(signal.aborted, false, `${change} must not stop running work`);
  assert.equal(f.context(), context, 'the coordinator is kept, not rebuilt');
  // Only a change to what the coordinator froze (here: this project's version and its own capabilities) refreshes it.
  if (change === 'gene-generation') assert.notEqual(context.drift, drift); else if (change !== 'permission-widened' && change !== 'project-renamed') assert.equal(context.drift, drift);
  f.release.resolve();
  await until(() => f.job()?.status === 'completed', 'work completes');
  assert.equal(f.action().status, 'completed'); assert.equal(f.action().contextRevoked, undefined); assert.match(f.action().resultSummary, /second input compatibility example is absent/);
});

test('a new Store.message still takes priority over an existing background writer lease', async t => {
  const f = await fixture(t, { writable: true }), signal = f.signal();
  assert.equal(f.context().workRuns.get(f.action().id).writable, true);
  f.store.message(f.sessionId, { text: '请继续处理前台文件修改。' });
  assert.equal(signal.aborted, true, 'the foreground writer fence remains in force');
  f.release.resolve();
  await until(() => !f.context()?.activeHandles.size, 'writer lease drains');
  assert.equal(f.reads.length, 1);
  assert.notEqual(f.job()?.status, 'completed');
});

const publicAction = (controller, projectId, actionId) => controller.actionView(projectId).actions.find(action => action.id === actionId);
const control = (f, action, requestId, text) => f.controller.controlAction(f.projectId, f.action().id, { action, requestId, expectedRevision: f.action().controlRevision ?? 0, ...(text ? { text } : {}) });

test('steering is durably accepted once, does not abort the current request and reaches the next SDK request', async t => {
  const f = await fixture(t, { nextTool: true }), signal = f.signal();
  const input = { action: 'steer', requestId: 'integration-steer-once', expectedRevision: 0, text: 'STEERING_SCOPE: examine only the missing second input case.' };
  const first = await f.controller.controlAction(f.projectId, f.action().id, input);
  const repeated = await f.controller.controlAction(f.projectId, f.action().id, input);
  assert.equal(first.receipt.id, repeated.receipt.id);
  assert.equal(f.action().controls.filter(row => row.id === input.requestId).length, 1);
  assert.equal(f.action().controlRevision, 1); assert.equal(signal.aborted, false);
  const persisted = readStateFile(join(f.directory, 'state.json')).state.projects.find(row => row.id === f.projectId).initiativeRuntime.sdkState.actions.find(row => row.id === f.action().id);
  assert.equal(persisted.controls.filter(row => row.id === input.requestId).length, 1, 'receipt exists on disk before a caller is acknowledged');
  await assert.rejects(f.controller.controlAction(f.projectId, f.action().id, { ...input, text: 'DIFFERENT_DIRECTION' }), error => error.status === 409 || error.code === 'action_control_conflict');
  f.release.resolve();
  await until(() => f.action().status === 'completed', 'steered worker completes');
  const steered = f.workRequests.filter(request => JSON.stringify(request.messages).includes('STEERING_SCOPE'));
  assert.ok(steered.length >= 1);
  for (const request of steered) assert.equal(request.messages.filter(message => message.role === 'user' && JSON.stringify(message.content).includes('STEERING_SCOPE')).length, 1);
  assert.equal(f.reads.filter(row => row.toolCallId === 'read-original-evidence-once').length, 1);
  assert.equal(f.action().controls.find(row => row.id === input.requestId).status, 'applied');
});

test('pause is acknowledged at a safe boundary and resume continues the same journal without replaying completed tools', async t => {
  const f = await fixture(t, { nextTool: true }), id = f.action().id, originalSignal = f.signal();
  const paused = await control(f, 'pause', 'integration-pause');
  assert.equal(paused.receipt.status, 'pending'); assert.equal(originalSignal.aborted, false);
  assert.equal(f.reads.length, 1);
  f.release.resolve();
  await until(() => f.action().status === 'paused' && !f.context().activeHandles.size, 'safe pause and runtime cleanup');
  assert.equal(f.action().controls.find(row => row.id === 'integration-pause').status, 'applied');
  assert.equal(f.action().checkpoint.sessionId, id);
  assert.equal(f.reads.length, 1, 'the pending next tool was not dispatched after pause');
  assert.ok(publicAction(f.controller, f.projectId, id).availableControls.includes('resume'));
  await control(f, 'resume', 'integration-resume');
  await until(() => f.action().status === 'completed', 'resumed original action completes');
  assert.equal(f.action().id, id); assert.equal(f.handles.length, 2);
  assert.equal(f.reads.filter(row => row.toolCallId === 'read-original-evidence-once').length, 1);
  assert.equal(f.reads.filter(row => row.toolCallId === 'read-new-independent-evidence').length, 1);
  assert.equal(f.job().toolReceiptCounts.completed, 2);
  await until(() => !f.context().reviewPromise && !f.context().coordinator.active.size && f.current().initiativeRuntime.sdkState.reservedTokens === 0, 'all request accounting settled');
  assert.equal(f.current().initiativeRuntime.sdkState.usedTokens, 10 * (f.decisionInputs.length + f.workRequests.length), 'pause/resume charges each actual model request once');
});

test('a safely paused action survives a real Store reload and resumes the original journal', async t => {
  const f = await fixture(t, { nextTool: true }), id = f.action().id;
  await control(f, 'pause', 'restart-pause'); f.release.resolve();
  await until(() => f.action().status === 'paused' && !f.context().activeHandles.size, 'pause saved before daemon close');
  await f.controller.close();
  const recovered = f.reopen(), action = () => recovered.store.state.projects.find(row => row.id === f.projectId).initiativeRuntime.sdkState.actions.find(row => row.id === id);
  await until(() => recovered.controller.contexts.get(f.projectId)?.initialized, 'new controller reads persisted state');
  assert.equal(action().status, 'paused'); assert.equal(f.workRequests.length, 2, 'restart does not automatically run paused work');
  assert.equal(action().controls.find(row => row.id === 'restart-pause').status, 'applied');
  await recovered.controller.controlAction(f.projectId, id, { action: 'resume', requestId: 'restart-resume', expectedRevision: action().controlRevision });
  await until(() => action().status === 'completed', 'persisted same-journal continuation completes');
  assert.equal(f.reads.filter(row => row.toolCallId === 'read-original-evidence-once').length, 1);
  assert.equal(f.reads.filter(row => row.toolCallId === 'read-new-independent-evidence').length, 1);
});

test('explicit stop cancels at a safe boundary and stale concurrent controls do not alter it', async t => {
  const f = await fixture(t, { nextTool: true }), id = f.action().id;
  const result = await control(f, 'stop', 'integration-stop'); assert.equal(result.receipt.status, 'pending');
  await assert.rejects(f.controller.controlAction(f.projectId, id, { action: 'steer', requestId: 'stale-steer', expectedRevision: 0, text: 'Must not replace the stop.' }), error => error.status === 409 || error.code === 'action_control_conflict');
  f.release.resolve();
  await until(() => f.action().status === 'cancelled' && !f.context().activeHandles.size, 'safe stop is settled');
  assert.equal(f.reads.length, 1); assert.equal(f.action().controls.length, 1);
  assert.ok(f.toolEnds.some(row => row.toolCallId === 'read-new-independent-evidence' && row.result?.details?.neverStarted === true));
  assert.equal(f.action().controls[0].status, 'applied');
  assert.equal(publicAction(f.controller, f.projectId, id).availableControls.includes('resume'), false);
  await assert.rejects(control(f, 'resume', 'invalid-resume'), error => error.status === 409 || error.code === 'action_control_state');
});

test('pause cannot acknowledge a safe checkpoint for an actual SDK tool with an unconfirmed outcome', async t => {
  const f = await fixture(t, { writable: true, uncertainTool: true });
  f.release.resolve();
  await until(() => f.toolState.calls === 1, 'unconfirmed effect is already dispatched');
  const result = await control(f, 'pause', 'pause-while-effect-running');
  assert.equal(result.receipt.status, 'pending'); assert.equal(f.action().status, 'running');
  f.releaseTool.resolve();
  await until(() => f.action().status === 'needs_review' && !f.context().activeHandles.size, 'uncertain receipt fences further execution');
  assert.equal(f.action().blocksExecution, true); assert.equal(f.job().status, 'needs_review');
  assert.equal(f.action().controls.find(row => row.id === 'pause-while-effect-running').status, 'rejected');
  assert.equal(f.action().checkpoint, undefined);
  await assert.rejects(control(f, 'resume', 'resume-unconfirmed-effect'), error => error.status === 409 || error.code === 'action_control_state');
  assert.equal(f.toolState.calls, 1);
  await f.controller.close();
  const recovered = f.reopen();
  await until(() => recovered.controller.contexts.get(f.projectId)?.initialized, 'unknown outcome recovered');
  assert.equal(publicAction(recovered.controller, f.projectId, f.action().id).availableControls.includes('resume'), false);
  assert.equal(f.toolState.calls, 1, 'daemon recovery must not retry an unconfirmed effect');
});

test('a failed durable mailbox save neither acknowledges nor delivers steering, and an identical retry remains usable', async t => {
  const f = await fixture(t, { nextTool: true }), coordinator = f.context().coordinator;
  const save = coordinator.saveState, before = f.handles[0].snapshot();
  coordinator.saveState = async (snapshot, metadata) => {
    if (snapshot.actions.some(action => action.controls?.some(row => row.id === 'disk-failure-steer'))) throw Object.assign(new Error('Controlled durable mailbox write failure'), { code: 'EIO' });
    return save(snapshot, metadata);
  };
  await assert.rejects(control(f, 'steer', 'disk-failure-steer', 'SAVE_BEFORE_DELIVERY'), { code: 'EIO' });
  assert.equal(f.action().controlRevision ?? 0, 0); assert.equal(f.action().controls?.length ?? 0, 0);
  assert.deepEqual(f.handles[0].snapshot().queue, before.queue);
  assert.equal(f.signal().aborted, false);
  coordinator.saveState = save;
  await control(f, 'steer', 'disk-failure-steer', 'SAVE_BEFORE_DELIVERY');
  f.release.resolve();
  await until(() => f.action().status === 'completed', 'same command can be retried after storage recovers');
  assert.equal(f.action().controls.filter(row => row.id === 'disk-failure-steer').length, 1);
  assert.ok(f.workRequests.some(request => JSON.stringify(request.messages).includes('SAVE_BEFORE_DELIVERY')));
});

test('a model control call cannot outlive the foreground turn while waiting for mailbox admission', async t => {
  const f = await fixture(t), blocked = hold();
  f.store.message(f.sessionId, { text: '请暂停后台调查。' });
  const session = f.store.state.sessions.find(row => row.id === f.sessionId), turnId = session.activeTurnId;
  const tool = f.controller.createControlTools({ projectId: f.projectId, sessionId: f.sessionId, turnId }).find(row => row.name === 'project_background_control');
  assert.ok(tool);
  const coordinator = f.context().coordinator, save = coordinator.saveState; let entered = false;
  coordinator.saveState = async (snapshot, metadata) => {
    if (!entered && snapshot.actions.some(action => action.controls?.some(row => row.id === 'prior-ui-steer'))) { entered = true; await blocked.promise; }
    return save(snapshot, metadata);
  };
  // A genuine earlier UI command holds the mailbox persistence boundary;
  // only the second, model-owned command loses its authorization meanwhile.
  const earlier = control(f, 'steer', 'prior-ui-steer', 'Retain the existing inspection scope.');
  try {
    await until(() => entered, 'earlier control is awaiting durable storage');
    const operation = tool.execute('controlled-old-turn-call', { actionId: f.action().id, action: 'pause', expectedRevision: 1 }, new AbortController().signal);
    const rejected = assert.rejects(operation, error => ['background_source_revoked', 'aborted'].includes(error.code));
    f.store.finishRuntimeTurn(f.sessionId, turnId);
    blocked.resolve(); await earlier; await rejected;
  } finally { blocked.resolve(); coordinator.saveState = save; await earlier.catch(() => {}); }
  assert.equal(f.action().controlRevision, 1);
  assert.equal(f.action().controls.length, 1);
  assert.equal(f.signal().aborted, false);
});

test('restart with an admitted but unconfirmed pause exposes unresolved execution instead of an endless pausing indicator', async t => {
  const f = await fixture(t, { nextTool: true }), id = f.action().id;
  await control(f, 'pause', 'crash-window-pause');
  // Capture the durable crash point, before the current request reaches the
  // boundary. Close the isolated owner before loading that captured image.
  const crashImage = readStateText(join(f.directory, 'state.json'));
  assert.equal(JSON.parse(crashImage).projects.find(row => row.id === f.projectId).initiativeRuntime.sdkState.actions.find(row => row.id === id).status, 'running');
  await f.controller.close();
  writeFileSync(join(f.directory, 'state.json'), crashImage);
  const recovered = f.reopen();
  await until(() => recovered.controller.contexts.get(f.projectId)?.initialized, 'crash image recovery');
  const view = publicAction(recovered.controller, f.projectId, id);
  assert.equal(view.status, 'needs_review'); assert.equal(view.blocksExecution, true);
  assert.notEqual(view.controlState, 'pausing'); assert.notEqual(view.controlState, 'stopping');
  assert.equal(view.availableControls.includes('resume'), false);
  assert.notEqual(view.controls.find(row => row.id === 'crash-window-pause').status, 'applied');
  assert.equal(f.workRequests.length, 2); assert.equal(f.reads.length, 1);
});

test('the foreground SDK interprets a user pause through registered control tools while the background inspection remains independent', async t => {
  const f = await fixture(t, { nextTool: true }); let requests = 0;
  const foreground = new RuntimeController(f.store, {
    backgroundController: () => f.controller,
    prepareForeground: (projectId, options) => f.controller.prepareForeground(projectId, options),
    factory: options => createRnaRuntime({ ...options, provider: async function* (request) {
      requests++; yield { type: 'usage', usage: { totalTokens: 10 } };
      assert.ok(request.tools.some(tool => tool.name === 'project_background_list'));
      assert.ok(request.tools.some(tool => tool.name === 'project_background_control'));
      if (requests === 1) {
        assert.match(JSON.stringify(request.messages), /先把后台的兼容性调查暂停/);
        yield { type: 'tool_call', id: 'model-read-background-status', name: 'project_background_list', arguments: {} };
        yield { type: 'done', stopReason: 'toolUse' }; return;
      }
      if (requests === 2) {
        const result = request.messages.find(message => message.role === 'toolResult' && message.toolName === 'project_background_list');
        const listed = JSON.parse(result.content.find(part => part.type === 'text').text), action = listed.actions.find(row => row.id === f.action().id);
        assert.equal(action.status, 'running'); assert.equal(action.controlRevision, 0);
        yield { type: 'tool_call', id: 'model-pause-background-work', name: 'project_background_control', arguments: { actionId: action.id, action: 'pause', expectedRevision: action.controlRevision } };
        yield { type: 'done', stopReason: 'toolUse' }; return;
      }
      const result = request.messages.find(message => message.role === 'toolResult' && message.toolName === 'project_background_control');
      assert.equal(JSON.parse(result.content.find(part => part.type === 'text').text).receipt.status, 'pending');
      yield { type: 'text_delta', delta: '暂停要求已保存；当前检查到达执行边界后会暂停。' };
      yield { type: 'done', stopReason: 'stop' };
    } })
  });
  f.track(foreground);
  f.store.message(f.sessionId, { text: '先把后台的兼容性调查暂停，我想补充一条约束。' });
  assert.equal(f.action().controlRevision ?? 0, 0, 'Store text itself does not invent a control command');
  assert.equal(f.signal().aborted, false, 'new user input does not cancel the independent readonly run');
  const session = () => f.store.state.sessions.find(row => row.id === f.sessionId);
  await until(() => session().turns.at(-1)?.status === 'completed', 'ordinary foreground SDK tool loop completes independently');
  assert.equal(requests, 3); assert.equal(f.action().controlRevision, 1);
  assert.match(f.action().controls[0].id, /^foreground-[a-f0-9]{64}$/);
  assert.equal(f.action().controls[0].kind, 'pause'); assert.equal(f.action().controls[0].status, 'pending');
  f.release.resolve();
  await until(() => f.action().status === 'paused', 'model-issued command reaches the background safe boundary');
  assert.equal(f.reads.length, 1);
});

test('invalid cross-field model control input explains how to correct it without consuming a revision or submitting a command', async t => {
  const f = await fixture(t);
  f.store.message(f.sessionId, { text: '请暂停后台调查。' });
  const turnId = f.store.state.sessions.find(row => row.id === f.sessionId).activeTurnId;
  const tool = f.controller.createControlTools({ projectId: f.projectId, sessionId: f.sessionId, turnId }).find(row => row.name === 'project_background_control');
  for (const action of ['pause', 'resume', 'stop']) {
    await assert.rejects(tool.execute(`invalid-${action}`, { actionId: f.action().id, action, expectedRevision: 0, text: '保留已有检查记录。' }, new AbortController().signal), error => error.status === 400 && error.code === 'invalid_control' && /必须省略 text/.test(error.message) && /尚未保存或执行/.test(error.message));
    assert.equal(f.action().controlRevision ?? 0, 0); assert.equal(f.action().controls?.length ?? 0, 0);
    assert.equal(f.signal().aborted, false);
  }
  await assert.rejects(tool.execute('invalid-steer', { actionId: f.action().id, action: 'steer', expectedRevision: 0 }, new AbortController().signal), error => error.status === 400 && /steer 必须提供非空 text/.test(error.message));
  assert.equal(f.action().controlRevision ?? 0, 0);
  const result = await tool.execute('corrected-pause', { actionId: f.action().id, action: 'pause', expectedRevision: 0 }, new AbortController().signal);
  assert.equal(JSON.parse(result.content[0].text).receipt.status, 'pending');
  assert.equal(f.action().controlRevision, 1); assert.equal(f.action().controls.length, 1);
});
