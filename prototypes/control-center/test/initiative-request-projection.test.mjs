import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController, continuityView, carriedEventIds, WINDOW_BLOCK } from '../project-initiative-controller.mjs';
import { InitiativeCoordinator } from '../../../packages/sdk/src/initiative.mjs';
import { mindBackgroundView } from '../project-mind.mjs';
import { permissionView } from '../project-permissions.mjs';
import { ProjectScheduleService } from '../project-schedule-service.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { createProjectSchedule } from '../../../packages/sdk/src/project-schedules.mjs';
import { buildRequest } from '../../../packages/sdk/src/providers.mjs';

// Purpose projections (spec prefix.md §4). TC-3: each turn and action appears once in a decision request. PDL-5: the
// permission in force rides at the tail. TC-2: a background worker reads a brief instead of the decision snapshot.
const until = async (fn, label = 'condition') => { const deadline = Date.now() + 15000; while (!fn()) { if (Date.now() > deadline) throw new Error(`Projection fixture timed out: ${label}`); await delay(5); } };
const at = new Date('2026-10-04T08:00:00Z').toISOString();
async function fixture(t, { decide = () => ({ action: 'wait' }), worker = null } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-projection-')), store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Local fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 2048, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoStore: false, autoRecall: false } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Projection fixture', workspace: directory, initiative: { cooldownMs: 0 } });
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); Object.assign(p, { decisionMode: 'rna-model', initialization: { status: 'ready' }, simulated: false, permissions: { workspace: 'write', background: 'inherit', revision: 1 }, assignments: { skillIds: [], toolIds: ['project_read', 'project_write'], mcpServerIds: [] } }); p.initiative.tokenBudget = null; state.settings.realTokenBudget = null; });
  writeFileSync(join(directory, 'chapter.md'), 'Chapter one.');
  const inputs = [], workers = [], schedules = new ProjectScheduleService(store);
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 999999, tickIntervalMs: 0, independentLearning: true, scheduleService: schedules,
    decisionProvider: async function* (request) { const input = JSON.parse(request.messages[0].content[0].text); inputs.push(input); const chosen = decide(input, inputs.length); yield { type: 'text_delta', delta: JSON.stringify({ reason: 'Fixture', content: '', evidenceIds: chosen.action === 'wait' ? [] : [input.allowedEvidenceIds.at(-1)], nextReviewAfterMs: 86400000, ...chosen }) }; yield { type: 'usage', usage: { totalTokens: 1 } }; yield { type: 'done', stopReason: 'stop' }; },
    runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* (request) { workers.push(structuredClone({ systemPrompt: request.systemPrompt, tools: request.tools, messages: request.messages, options: { initialContextTail: options.initialContextTail } })); yield* (worker ?? (async function* () { yield { type: 'text_delta', delta: 'Checked chapter.md.\n交接：核对了 chapter.md，下一步无。' }; yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: 'stop' }; }))(); } }) });
  t.after(async () => { await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  await until(() => controller.contexts.get(project.id)?.initialized, 'context');
  const current = () => store.state.projects.find(row => row.id === project.id);
  return { store, controller, project, session, directory, inputs, workers, schedules, current, context: () => controller.contexts.get(project.id),
    // `notes`: assistant messages before the reply (a progress note between tool calls); the turn's context holds only its final reply.
    turn(text, reply, { notes = [] } = {}) { store.message(session.id, { text }); const turnId = store.state.sessions.find(row => row.id === session.id).activeTurnId; store.mutate(state => { const items = state.sessions.find(row => row.id === session.id).items; notes.forEach((note, index) => items.push({ id: `note-${turnId}-${index}`, turnId, kind: 'assistant', text: note, createdAt: new Date().toISOString(), simulated: false })); items.push({ id: `reply-${turnId}`, turnId, kind: 'assistant', text: reply, createdAt: new Date().toISOString(), simulated: false }); }); store.finishRuntimeTurn(session.id, turnId); return turnId; } };
}

test('TC-3: a turn the request carries as evidence is referenced by its handle and its messages leave recentConversation', async t => {
  const f = await fixture(t);
  f.turn('Rewrite the ending of chapter one.', 'REWROTE_THE_ENDING');
  await until(() => f.inputs.length === 1, 'decision after the turn');
  const input = f.inputs[0], result = input.events.find(event => event.type === 'conversation_result');
  assert.ok(result, 'the turn result is an evidence event');
  assert.deepEqual(input.project.continuity.recentTurns.at(-1), { evidence: result.id }, 'referenced by its E-handle');
  assert.match(result.id, /^E\d+$/);
  assert.ok(!input.project.recentConversation.some(row => /Rewrite the ending|REWROTE_THE_ENDING/.test(row.text)), 'its messages are not repeated');
  assert.equal(JSON.stringify(input).split('REWROTE_THE_ENDING').length - 1, 1, 'the reply appears once in the request');
  assert.equal(input.project.handoffs, undefined);
});

test('TC-3: receipts the SDK sends are slim, a cancelled one stays whole; work summaries already carried are left out', async t => {
  const f = await fixture(t);
  f.store.mutate(state => {
    const p = state.projects.find(row => row.id === f.project.id), sdk = p.initiativeRuntime.sdkState;
    sdk.actions.push({ id: 'done-work', action: 'work', status: 'completed', content: 'Check chapter one', evidenceIds: [], intentKey: 'k1', revision: 1, resultSummary: 'DONE_WORK_RESULT', finishedAt: Date.parse(at) },
      { id: 'stopped-work', action: 'work', status: 'cancelled', content: 'CANCELLED_INTENT', evidenceIds: [], intentKey: 'k2', revision: 1, cancellationReason: 'action_control' });
    p.jobs.push({ id: 'done-work', projectId: p.id, kind: 'research', lane: 'background', status: 'completed', simulated: false, toolReceiptCounts: { total: 3, completed: 3, failed: 0, uncertain: 0 }, toolReceipts: [], createdAt: at });
  });
  const context = f.context(), project = f.current(), snapshot = f.controller.snapshot(project, null, null, { eventIds: new Set(context.coordinator.state.events.map(event => event.id)), liveActions: project.initiativeRuntime.sdkState.actions });
  const receipts = snapshot.continuity.actionReceipts, slim = receipts.find(row => row.actionId === 'done-work'), whole = receipts.find(row => row.actionId === 'stopped-work');
  assert.deepEqual(Object.keys(slim).sort(), ['actionId', 'endedAt', 'execution']); assert.equal(slim.execution.total, 3); assert.equal(slim.endedAt, at);
  assert.equal(whole.intent, 'CANCELLED_INTENT', 'not sent as recentActions: kept whole');
  const unshared = snapshot.communication.recentWorkNotReferencedByDelivery.find(row => row.actionId === 'done-work');
  assert.equal(unshared.summary, undefined, 'its result is in recentActions'); assert.equal(unshared.evidenceId, 'action:done-work:completed');
  const plain = f.controller.snapshot(project, null, null);
  assert.equal(plain.continuity.actionReceipts.find(row => row.actionId === 'done-work').result, 'DONE_WORK_RESULT', 'without the coordinator state, receipts stay whole');
  assert.equal(plain.communication.recentWorkNotReferencedByDelivery.find(row => row.actionId === 'done-work').summary, 'DONE_WORK_RESULT');
});

test('TC-3: schedules are sent once, at project.schedules, and the contract points there', async t => {
  const f = await fixture(t);
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).schedules = [createProjectSchedule({ id: 'daily', title: 'Daily chapter', task: 'Write one chapter.', destinationSessionId: f.session.id, rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }, { now: Date.parse(at) })]; });
  const snapshot = f.controller.snapshot(f.current(), null, null);
  assert.equal(snapshot.schedules.length, 1); assert.equal(snapshot.scheduleContext.schedules, undefined); assert.ok(Array.isArray(snapshot.scheduleContext.cancelled));
  assert.equal(JSON.stringify(snapshot).split('"Daily chapter"').length - 1, 1, 'the record appears once');
  assert.match(snapshot.actionContracts.schedule.scope, /use project\.schedules \(actual records\) and scheduleContext\.cancelled/);
});

test('TC-3: a referenced turn keeps the user\'s undo next to its reference', async t => {
  const f = await fixture(t);
  const turnId = f.turn('Rewrite the ending of chapter one.', 'Done.');
  const project = f.current(), sessions = f.store.state.sessions.filter(row => row.projectId === project.id);
  const trajectory = sessions.flatMap(session => session.turns.map(turn => ({ session, turn }))), turn = trajectory.find(row => row.turn.id === turnId).turn;
  const source = f.controller.sources(project, 'scope').find(row => row.type === 'conversation_result').id;
  const view = continuityView(project, sessions, { reversions: [{ kind: 'turn_rolled_back', at, owner: { sessionId: f.session.id, turnId } }], trajectory, pendingRetry: new Set(), eventIds: new Set([source]) });
  assert.deepEqual(view.recentTurns.at(-1), { evidence: source, undone: { at, kind: 'turn_rolled_back' } });
  assert.equal(turn.status, 'completed');
});

test('PDL-5: plan mode narrows the permission in force at the request tail; the contract head stays the same', async t => {
  const f = await fixture(t);
  const build = () => f.controller.snapshot(f.current(), null, null).actionContracts.work;
  const normal = build(); f.store.updateSession(f.session.id, { mode: 'plan' }); const planning = build();
  assert.equal(normal.permissions.effective.background, 'write'); assert.equal(planning.permissions.effective.background, 'read'); assert.equal(planning.backgroundLevel, 'read');
  const head = work => { const { effects: _e, planning: _p, foregroundBusy: _f, backgroundLevel: _b, permissions: { effective: _x, ...permissions }, ...rest } = work; return { ...rest, permissions }; };
  assert.deepEqual(head(planning), head(normal), 'only the volatile fields differ: authorization and scope name hostConditions.work.backgroundLevel (phase 2)');
  assert.match(normal.scope, /When hostConditions\.work\.backgroundLevel is read: .* When it is write or execute: /);
});

// The exact decision request the SDK would send for a project state (a coordinator tick on a copy, a capturing provider).
const decisionModel = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', maxOutputTokens: 2048 };
async function decisionRequest(f, sdkState, planningCapabilities = null) {
  const state = structuredClone(sdkState); Object.assign(state, { decisionRevision: -1, failureRetryAt: 0, archiveRetryAt: 0, reservedTokens: 0 });
  const project = { ...f.current(), initiativeRuntime: { ...f.current().initiativeRuntime, sdkState: structuredClone(state) } };
  const idle = async () => ({ deferred: true, retryAfterMs: 1e9, usage: { totalTokens: 0 } });
  let request;
  const coordinator = new InitiativeCoordinator({ project: f.controller.snapshot(project, null, planningCapabilities, { eventIds: carriedEventIds(state.events), liveActions: state.actions }), model: decisionModel, state, policy: { tokenBudget: null, maxEvents: 16, eventBlock: WINDOW_BLOCK }, handlers: { work: idle, share: idle, ask: idle, schedule: idle },
    provider: async function* (input) { request = input; yield { type: 'text_delta', delta: JSON.stringify({ action: 'wait', reason: 'Fixture', content: '', evidenceIds: [], nextReviewAfterMs: 86400000 }) }; yield { type: 'usage', usage: { totalTokens: 1 } }; yield { type: 'done', stopReason: 'stop' }; } });
  try { await coordinator.tick({ presence: { conversationAvailable: true } }); } finally { await coordinator.close(); }
  return { system: request.systemPrompt, text: request.messages[0].content[0].text, project };
}
const throughEvents = text => text.slice(0, text.indexOf('"allowedEvidenceIds"'));

test('PDL-5: plan mode or a running turn leaves the system prompt and the decision request byte-identical through its events, capability declarations included, and the worker brief unchanged', async t => {
  const f = await fixture(t);
  f.turn('Rewrite the ending of chapter one.', 'Rewrote it.');
  await until(() => f.inputs.length >= 1 && f.current().initiativeRuntime?.sdkState?.events?.length, 'first decision');
  const capabilities = await f.controller.planningCapabilities(f.current()), sdk = f.current().initiativeRuntime.sdkState;
  const render = async () => ({ request: await decisionRequest(f, sdk, capabilities), brief: JSON.stringify(f.controller.workerBrief(f.current(), { evidence: [] }).stable) });
  const original = f.store.state.sessions.find(row => row.id === f.session.id).mode;
  const flip = async mutate => { f.store.mutate(state => mutate(state.sessions.find(row => row.id === f.session.id))); try { return await render(); } finally { f.store.mutate(state => { const session = state.sessions.find(row => row.id === f.session.id); session.mode = original; delete session.activeTurnId; }); } };
  const normal = await render(), planning = await flip(session => { session.mode = 'plan'; }), busy = await flip(session => { session.activeTurnId = 'turn-still-running'; });
  const parsed = JSON.parse(normal.request.text);
  assert.ok(parsed.project.capabilityContext?.tools.some(tool => tool.id === 'project_write' && tool.permittedForBackground), 'the declarations ride in the request');
  for (const [label, flipped] of [['plan mode', planning], ['a running turn', busy]]) {
    assert.equal(flipped.request.system, normal.request.system, `${label}: the system prompt`);
    assert.equal(throughEvents(flipped.request.text), throughEvents(normal.request.text), `${label}: the request through its events`);
    assert.equal(JSON.parse(flipped.request.text).hostConditions.work.backgroundLevel, 'read', `${label}: the tail says read`);
    assert.equal(flipped.brief, normal.brief, `${label}: the worker brief`);
  }
  assert.equal(parsed.hostConditions.work.backgroundLevel, 'write');
});

test('TC-2 accuracy: the worker keeps the lessons its project\'s name and focus recall that its task\'s project-mind attachment lacks, once, and the saved permission\'s inheritedAssignments', async t => {
  const decide = (input, count) => count === 2 ? { action: 'work', title: 'Outline', content: 'Verify outline file lists every arc.' } : { action: 'wait' };
  const f = await fixture(t, { decide });
  const at = new Date().toISOString(), lesson = (id, text) => ({ id, kind: 'pitfall', scope: 'project', text, status: 'active', createdAt: at, source: { kind: 'reflection' } });
  f.store.mutate(state => { const p = state.projects.find(row => row.id === f.project.id); p.focus = 'pacing'; p.mind = { lessons: [lesson('named-lesson', 'Pacing slips late: recheck pacing chapter by chapter.'), lesson('task-lesson', 'Outline file must list every arc before drafting.')], agenda: [], commitments: [], findings: [], threads: [], notes: { facts: [], preferences: [] } }; });
  // The project-mind attachment as ProjectMindService.backgroundContext builds it (its view for the task; recall accounting aside).
  f.store.mind = { backgroundContext: (projectId, { query = '' } = {}) => { const view = mindBackgroundView(f.store.state.projects.find(row => row.id === projectId), { query }); return view ? JSON.stringify(view) : null; } };
  t.after(() => { delete f.store.mind; });
  const recalled = query => mindBackgroundView(f.current(), { query }).lessons.map(row => row.id);
  assert.deepEqual([recalled(''), recalled('Verify outline file lists every arc.')], [['named-lesson'], ['task-lesson']], 'each query recalls its own lesson');
  f.turn('First request about chapter one.', 'REPLY_ONE_TEXT');
  await until(() => f.inputs.length >= 1, 'first decision');
  f.turn('Second request about the opening.', 'REPLY_TWO_TEXT');
  await until(() => f.workers.length >= 1, 'the worker request');
  const textOf = message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('\n');
  const all = f.workers[0].messages.map(textOf).join('\n');
  assert.equal(occurrences(all, 'Pacing slips late'), 1, 'the lesson the decision snapshot used to give the worker');
  assert.equal(occurrences(all, 'Outline file must list every arc'), 1, 'the task\'s lesson, in the project-mind attachment only');
  const brief = JSON.parse(f.workers[0].options.initialContextTail[0].text);
  assert.equal(brief.work.permissions.inheritedAssignments, permissionView(f.current()).inheritedAssignments);
  assert.deepEqual(Object.keys(brief.work.permissions).sort(), ['description', 'inheritedAssignments', 'revision', 'settings', 'workspace'], 'every saved permission fact but its project id (the brief\'s own id) and the one in force (volatile)');
});

test('A1 block windows: the next decision after one more action keeps the request bytes up to that action until the receipt window moves; the worker keeps plain windows', async t => {
  const f = await fixture(t);
  f.turn('Rewrite the ending of chapter one.', 'Rewrote it.');
  await until(() => f.inputs.length >= 1 && f.current().initiativeRuntime?.sdkState?.events?.length, 'first decision');
  assert.equal(f.context().coordinator.policy.eventBlock, WINDOW_BLOCK, 'the coordinator\'s evidence window moves in the same blocks');
  const sdk = structuredClone(f.current().initiativeRuntime.sdkState), done = Date.parse('2026-10-04T08:00:00Z');
  const add = id => sdk.actions.push({ id, action: 'share', status: 'completed', content: `Shared ${id}.`, evidenceIds: [], intentKey: `key-${id}`, revision: 1, createdAt: done, finishedAt: done + sdk.actions.length, resultSummary: `Delivered ${id}.` });
  // Nine receipts: more than the host's eight, so a plain window drops the oldest when the tenth arrives.
  while (sdk.actions.filter(row => !row.contextRevoked && !row.sourceDeleted).length < 9) add(`seed-${sdk.actions.length}`);
  const receipts = request => JSON.parse(request.text).project.continuity.actionReceipts.map(row => row.actionId);
  let previous = await decisionRequest(f, sdk);
  assert.equal(receipts(previous).length, 9, 'the receipt window holds its eight and up to three more');
  const kept = [];
  for (let step = 1; step <= WINDOW_BLOCK; step++) {
    add(`next-${step}`);
    const next = await decisionRequest(f, sdk), at = next.text.lastIndexOf('{', next.text.indexOf(`"next-${step}"`));
    assert.equal(receipts(next).at(-1), `next-${step}`);
    kept.push(next.text.slice(0, at - 1) === previous.text.slice(0, at - 1));
    previous = next;
  }
  // 10 and 11 receipts append; the twelfth moves the start by four (eight shown); the thirteenth appends again.
  assert.deepEqual(kept, [true, true, false, true]);
  assert.equal(receipts(previous).length, 9);
  const worker = f.controller.workerBrief(previous.project, { evidence: [] });
  assert.deepEqual(worker.volatile.continuity.actionReceipts.map(row => row.actionId), receipts(previous).slice(-8), 'a worker reads the newest eight');
});

test('TC-2: a worker reads a brief after the shared prefix and an evidence attachment without the decision-only parts; consecutive runs share the prefix through the brief', async t => {
  let runs = 0, passes = 0;
  // One work per finished turn (a run's own completion is reviewed too, and answered with wait).
  const decide = input => input.events.at(-1)?.type === 'conversation_result' && passes < 2 ? (passes++, { action: 'work', title: `Check ${passes}`, content: `Check chapter.md, pass ${passes}.` }) : { action: 'wait' };
  const f = await fixture(t, { decide });
  f.turn('Rewrite the ending of chapter one.', 'Rewrote it.');
  await until(() => f.current().jobs.filter(job => job.status === 'completed').length >= 1, 'first run');
  f.turn('Now the opening.', 'Rewrote the opening.');
  await until(() => f.current().jobs.filter(job => job.status === 'completed').length >= 2, 'second run');
  runs = f.workers.length; assert.ok(runs >= 2);
  const wire = request => buildRequest({ model: { providerId: 'w', modelId: 'w', protocol: 'openai', baseUrl: 'https://wire.invalid/v1', contextWindow: 128000, maxOutputTokens: 2048 }, systemPrompt: request.systemPrompt, messages: request.messages, tools: request.tools }).body.messages;
  const [first, second] = [wire(f.workers[0]), wire(f.workers[1])];
  const briefAt = messages => messages.findIndex(message => typeof message.content === 'string' && message.content.includes('project-brief'));
  assert.ok(briefAt(first) > 0 && briefAt(first) < first.findIndex(message => typeof message.content === 'string' && message.content.includes('Check chapter.md, pass 1.')), 'the brief comes before the task');
  assert.equal(JSON.stringify(first.slice(0, briefAt(first) + 1)), JSON.stringify(second.slice(0, briefAt(second) + 1)), 'byte-identical through the brief');
  // The task message carries its context as `<label>\n[{"source":…,"text":…}]` (renderContext).
  const textOf = message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('\n');
  const carrying = textOf(first.find(message => textOf(message).includes('"source":"project-evidence"'))), blocks = JSON.parse(carrying.slice(carrying.indexOf('[{"source":')));
  const evidence = JSON.parse(blocks.find(block => block.source === 'project-evidence').text);
  for (const key of ['capabilityContext', 'actionContracts', 'communication', 'scheduleContext', 'schedules', 'rhythmStatus', 'learningStatus', 'assignments', 'projectVersion', 'recentConversation', 'handoffs', 'mind']) assert.equal(evidence.project[key], undefined, key);
  assert.ok(evidence.project.continuity && evidence.project.work.effective, 'the run\'s conditions and continuity');
  const cited = new Set(evidence.evidence.map(row => row.id));
  assert.ok(evidence.project.continuity.recentTurns.some(row => row.evidence && cited.has(row.evidence) && Object.keys(row).length === 1), 'a turn the run\'s evidence carries is referenced');
  const job = f.current().jobs[0];
  assert.ok(job.briefStats.stableChars > 0 && job.briefStats.volatileChars > 0 && job.briefStats.evidenceChars > 0);
});

// Accuracy guard for the projections (spec prefix.md §4.5, shipped without the main-model replay): only duplicates leave
// the decision request. Every recent action reaches it exactly once (its intent, result or handoff, its failure), every
// carried turn's reply exactly once, and a handoff neither receipt list carries is still listed.
const occurrences = (text, needle) => text.split(needle).length - 1;
const seedActions = (f, at) => {
  const actions = f.context().coordinator.state.actions, done = Date.parse(at);
  const row = (id, fields) => ({ id, evidenceIds: [], intentKey: `key-${id}`, revision: 1, createdAt: done - 60000, ...fields });
  actions.push(row('old-stop', { action: 'work', status: 'cancelled', content: 'OLD_STOP_INTENT', handoff: '已中断：OLD_STOP_HANDOFF', cancellationReason: 'action_control', finishedAt: done - 50000 }));
  for (let index = 0; index < 8; index++) actions.push(row(`pad-${index}`, { action: 'share', status: 'completed', content: `PAD_SHARE_${index}`, resultSummary: `PAD_RESULT_${index}`, finishedAt: done - 40000 + index }));
  actions.push(row('done-handoff', { action: 'work', status: 'completed', content: 'DONE_HANDOFF_INTENT', handoff: '交接：DONE_HANDOFF_LINE', resultSummary: 'DONE_HANDOFF_RESULT', finishedAt: done - 30000 }),
    row('done-plain', { action: 'work', status: 'completed', content: 'DONE_PLAIN_INTENT', resultSummary: 'DONE_PLAIN_RESULT', finishedAt: done - 20000 }),
    row('failed-work', { action: 'work', status: 'failed', content: 'FAILED_INTENT', handoff: '未完成：FAILED_HANDOFF', failure: { code: 'tool_failed', message: 'FAILED_MESSAGE' }, errorCode: 'tool_failed', error: 'Host action failed', finishedAt: done - 15000 }),
    // Resolved by the user after an uncertain run: completed, and its failure kept (the SDK receipt does not show it).
    row('resolved-work', { action: 'work', status: 'completed', content: 'RESOLVED_INTENT', resultSummary: 'RESOLVED_SUMMARY', failure: { code: 'uncertain_tool', message: 'RESOLVED_FAILURE_MESSAGE' }, errorCode: 'uncertain_tool', blocksExecution: true, resolutionOutcome: 'completed', resolvedAt: done - 9000, finishedAt: done - 10000 }),
    row('stopped-recent', { action: 'work', status: 'cancelled', content: 'STOPPED_RECENT_INTENT', handoff: '已中断：STOPPED_RECENT_HANDOFF', cancellationReason: 'action_control', finishedAt: done - 5000 }),
    // Longer than the SDK receipt shows (its first 2,000 characters): the host excerpt's end is only on the host receipt.
    row('long-work', { action: 'work', status: 'completed', content: `LONG_INTENT_HEAD ${'x'.repeat(2400)} LONG_INTENT_TAIL`, resultSummary: `LONG_RESULT_HEAD ${'y'.repeat(2400)} LONG_RESULT_TAIL`, finishedAt: done - 1000 }));
};

test('TC-3 accuracy: every recent action and carried turn reaches the decision request exactly once', async t => {
  const f = await fixture(t);
  seedActions(f, at);
  f.turn('First request about chapter one.', 'REPLY_ONE_TEXT');
  await until(() => f.inputs.length >= 1, 'first decision');
  f.turn('Second request about the opening.', 'REPLY_TWO_TEXT', { notes: ['PROGRESS_NOTE_TEXT', ''] });
  await until(() => f.inputs.length >= 2, 'second decision');
  const input = f.inputs.at(-1), text = JSON.stringify(input);
  // Actions: what each one says reaches the request once, whichever list carries it.
  for (const needle of ['DONE_HANDOFF_INTENT', 'DONE_HANDOFF_LINE', 'DONE_HANDOFF_RESULT', 'DONE_PLAIN_INTENT', 'DONE_PLAIN_RESULT', 'FAILED_INTENT', 'FAILED_HANDOFF', 'FAILED_MESSAGE', 'RESOLVED_INTENT', 'RESOLVED_SUMMARY', 'RESOLVED_FAILURE_MESSAGE', 'STOPPED_RECENT_INTENT', 'STOPPED_RECENT_HANDOFF', 'OLD_STOP_HANDOFF', ...Array.from({ length: 8 }, (_, index) => `PAD_SHARE_${index}`)]) assert.equal(occurrences(text, needle), 1, needle);
  const sent = new Set(input.recentActions.map(row => row.actionId)), receipts = input.project.continuity.actionReceipts;
  for (const id of ['pad-0', 'pad-7', 'done-handoff', 'done-plain', 'failed-work', 'resolved-work']) assert.ok(sent.has(id), `${id} is an SDK receipt`);
  assert.ok(!sent.has('stopped-recent') && !sent.has('old-stop'), 'cancelled runs are not');
  // A slim host receipt names an action the SDK sends (no dangling reference) and repeats none of its text.
  for (const receipt of receipts.filter(row => sent.has(row.actionId) && row.actionId !== 'long-work')) {
    assert.deepEqual(Object.keys(receipt).filter(key => !['actionId', 'execution', 'changesReverted', 'failure', 'endedAt'].includes(key)), [], receipt.actionId);
    assert.ok(receipt.endedAt, `${receipt.actionId} keeps when it ended`);
  }
  assert.equal(receipts.find(row => row.actionId === 'resolved-work').failure.code, 'uncertain_tool', 'a failure the SDK receipt does not show stays');
  // Text past what the SDK receipt shows stays on the host receipt (its excerpt keeps the end).
  const long = receipts.find(row => row.actionId === 'long-work');
  assert.ok(sent.has('long-work') && long.intent.endsWith('LONG_INTENT_TAIL') && long.result.endsWith('LONG_RESULT_TAIL'));
  assert.equal(occurrences(text, 'LONG_INTENT_TAIL'), 1); assert.ok(occurrences(text, 'LONG_RESULT_TAIL') >= 1);
  assert.equal(receipts.find(row => row.actionId === 'done-plain').result, undefined, 'a short result the SDK receipt shows whole is not repeated');
  assert.equal(receipts.find(row => row.actionId === 'failed-work').failure, undefined, 'the SDK receipt shows this one');
  const stopped = receipts.find(row => row.actionId === 'stopped-recent');
  assert.equal(stopped.intent, 'STOPPED_RECENT_INTENT'); assert.ok(stopped.endedAt, 'a whole receipt with a handoff keeps its time');
  assert.deepEqual(input.project.handoffs.map(row => row.handoff), ['已中断：OLD_STOP_HANDOFF'], 'only the handoff no receipt carries');
  assert.equal(input.project.communication.recentWorkNotReferencedByDelivery.find(row => row.actionId === 'done-handoff').summary, 'DONE_HANDOFF_RESULT', 'the receipt shows a handoff, so the result excerpt stays');
  // Turns: each finished turn is an event the request carries whole, referenced (never repeated) from recentTurns.
  const events = new Map(input.events.map(event => [event.id, event]));
  for (const reply of ['REPLY_ONE_TEXT', 'REPLY_TWO_TEXT']) {
    assert.equal(occurrences(text, reply), 1, reply);
    const event = input.events.find(row => row.type === 'conversation_result' && row.summary.includes(reply));
    assert.ok(event, `${reply} is carried by an event`);
    assert.ok(input.project.continuity.recentTurns.some(row => row.evidence === event.id), `${reply}'s turn is referenced by its handle`);
  }
  for (const row of input.project.continuity.recentTurns) if (row.evidence) assert.ok(events.has(row.evidence), 'no reference dangles');
  assert.ok(!input.project.recentConversation.some(row => /REPLY_(ONE|TWO)_TEXT|First request|Second request/.test(row.text)), 'carried turns leave recentConversation');
  // A progress note before the reply is not in the turn's event: it stays, once; the empty one carried nothing.
  assert.equal(occurrences(text, 'PROGRESS_NOTE_TEXT'), 1); assert.ok(input.project.recentConversation.some(row => row.text === 'PROGRESS_NOTE_TEXT'));
  assert.ok(!input.project.recentConversation.some(row => !row.text.trim()), 'empty messages of carried turns are left out');
});

test('TC-3 accuracy: a turn whose event summary was cut at its bound stays whole', async t => {
  const f = await fixture(t);
  const turnId = f.turn('Rewrite the ending of chapter one.', 'CUT_REPLY_TEXT');
  const project = f.current(), sessions = f.store.state.sessions.filter(row => row.projectId === project.id);
  const trajectory = sessions.flatMap(session => session.turns.map(turn => ({ session, turn })));
  const source = f.controller.sources(project, 'scope').find(row => row.type === 'conversation_result');
  const cut = { ...source, summary: source.summary.slice(0, Math.floor(source.summary.length / 2)) };
  assert.deepEqual([...carriedEventIds([cut, { id: 'message:x', type: 'user_message', summary: 'not json' }])], ['message:x'], 'only a cut conversation_result is not carried');
  assert.deepEqual([...carriedEventIds([source])], [source.id]);
  const view = continuityView(project, sessions, { reversions: [], trajectory, pendingRetry: new Set(), eventIds: carriedEventIds([cut]) });
  assert.equal(view.recentTurns.at(-1).turnId, turnId); assert.equal(view.recentTurns.at(-1).final.text, 'CUT_REPLY_TEXT');
  const snapshot = f.controller.snapshot(project, null, null, { eventIds: carriedEventIds([cut]), liveActions: [] });
  assert.ok(snapshot.recentConversation.some(row => row.text === 'CUT_REPLY_TEXT'), 'its messages stay too');
});

test('TC-3 accuracy: a run past the host receipts whose handoff only recentActions carries keeps when it ended', async t => {
  const f = await fixture(t);
  f.turn('Rewrite the ending of chapter one.', 'Rewrote it.');
  await until(() => f.inputs.length >= 1 && f.current().initiativeRuntime?.sdkState?.events?.length, 'first decision');
  const sdk = structuredClone(f.current().initiativeRuntime.sdkState), done = Date.parse('2026-10-04T03:00:00Z');
  const row = (id, fields) => ({ id, evidenceIds: [], intentKey: `key-${id}`, revision: 1, createdAt: done - 60000, ...fields });
  sdk.actions.push(row('old-work', { action: 'work', status: 'completed', content: 'OLD_WORK_INTENT', handoff: '交接：OLD_WORK_HANDOFF', resultSummary: 'OLD_WORK_RESULT', finishedAt: done }),
    row('old-failed', { action: 'work', status: 'failed', content: 'OLD_FAILED_INTENT', handoff: '未完成：OLD_FAILED_HANDOFF', failure: { code: 'tool_failed', message: 'OLD_FAILED_MESSAGE' }, errorCode: 'tool_failed', finishedAt: done + 1000 }));
  // Twelve later shares: both runs leave continuity.actionReceipts (8 to 11 rows) and stay among the SDK's last 20
  // receipts, and no completion event in the window carries them (the failed one never had one).
  for (let index = 0; index < 12; index++) sdk.actions.push(row(`later-${index}`, { action: 'share', status: 'completed', content: `LATER_SHARE_${index}`, resultSummary: `Delivered ${index}.`, finishedAt: done + (index + 2) * 60000 }));
  assert.ok(!sdk.events.some(event => event.id.startsWith('action:old-')));
  const request = await decisionRequest(f, sdk), input = JSON.parse(request.text);
  const sent = new Map(input.recentActions.map(receipt => [receipt.actionId, receipt])), receipted = new Set(input.project.continuity.actionReceipts.map(receipt => receipt.actionId));
  for (const id of ['old-work', 'old-failed']) {
    assert.ok(sent.get(id)?.handoff, `${id}'s SDK receipt carries its handoff`); assert.ok(!receipted.has(id), `${id} is past the host receipts`);
    assert.ok(!Object.keys(sent.get(id)).some(key => /At$/.test(key)), `${id}'s SDK receipt has no time`);
  }
  assert.deepEqual(input.project.handoffs, [{ actionId: 'old-work', at: new Date(done).toISOString() }, { actionId: 'old-failed', at: new Date(done + 1000).toISOString() }], 'when each ended, without repeating the handoff');
  for (const needle of ['OLD_WORK_HANDOFF', 'OLD_FAILED_HANDOFF']) assert.equal(occurrences(request.text, needle), 1, needle);
  // A worker reads no recentActions: its handoffs list keeps the whole line.
  const worker = f.controller.workerBrief(request.project, { evidence: [] });
  assert.deepEqual(worker.volatile.handoffs, [{ at: new Date(done).toISOString(), action: 'work', status: 'completed', handoff: '交接：OLD_WORK_HANDOFF' }, { at: new Date(done + 1000).toISOString(), action: 'work', status: 'failed', handoff: '未完成：OLD_FAILED_HANDOFF' }]);
});

test('TC-3 accuracy: the continuity scope names a referenced turn as evidence, not context', async t => {
  const f = await fixture(t);
  f.turn('Rewrite the ending of chapter one.', 'REWROTE_THE_ENDING');
  await until(() => f.inputs.length === 1, 'decision after the turn');
  const input = f.inputs[0], reference = input.project.continuity.recentTurns.at(-1).evidence, scope = input.project.continuity.history.scope;
  assert.match(reference, /^E\d+$/); assert.ok(input.allowedEvidenceIds.includes(reference), 'the turn\'s row is an allowed evidence ID');
  assert.match(scope, /A recentTurns row \{ evidence: id \} is that whole turn: the evidence event with that same id carries it, and that id is an evidence ID\./);
  assert.doesNotMatch(scope, /(?<!Other )IDs here identify context, not allowed evidence/, 'no claim that every ID here is context');
  assert.equal(f.controller.workerBrief(f.current(), { evidence: [] }).volatile.continuity.history.scope, scope, 'a worker reads the same scope');
});

test('TC-2 accuracy: the worker attachment carries the run\'s evidence whole, and every handoff once', async t => {
  const decide = (input, count) => count === 2 ? { action: 'work', title: 'Check', content: 'Check chapter.md against the latest request.' } : { action: 'wait' };
  const f = await fixture(t, { decide });
  seedActions(f, at);
  f.turn('First request about chapter one.', 'REPLY_ONE_TEXT');
  await until(() => f.inputs.length >= 1, 'first decision');
  f.turn('Second request about the opening.', 'REPLY_TWO_TEXT', { notes: ['PROGRESS_NOTE_TEXT', ''] });
  await until(() => f.workers.length >= 1, 'the worker request');
  const action = f.context().coordinator.state.actions.find(row => row.action === 'work' && row.content === 'Check chapter.md against the latest request.');
  assert.ok(action?.evidenceIds.length, 'the work cites evidence');
  const textOf = message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('\n');
  const all = f.workers[0].messages.map(textOf).join('\n'), carrying = f.workers[0].messages.map(textOf).find(text => text.includes('"source":"project-evidence"'));
  const blocks = JSON.parse(carrying.slice(carrying.indexOf('[{"source":'))), attachment = JSON.parse(blocks.find(block => block.source === 'project-evidence').text);
  // The run's evidence: every event the work cites, whole (the same rows the coordinator holds).
  const held = new Map(f.context().coordinator.state.events.map(event => [event.id, event]));
  assert.deepEqual(attachment.evidence.map(row => row.id).sort(), [...action.evidenceIds].sort());
  for (const row of attachment.evidence) assert.equal(row.summary, held.get(row.id).summary, `${row.id} is carried whole`);
  const cited = new Set(attachment.evidence.map(row => row.id));
  for (const row of attachment.project.continuity.recentTurns) if (row.evidence) assert.ok(cited.has(row.evidence), 'a reference names attached evidence');
  assert.equal(occurrences(all, 'REPLY_TWO_TEXT'), 1, 'the cited turn\'s reply once');
  assert.equal(occurrences(all, 'REPLY_ONE_TEXT'), 1, 'the other turn whole, once');
  // A message no turn context holds (a progress note before the reply) still reaches the worker, once.
  assert.equal(occurrences(all, 'PROGRESS_NOTE_TEXT'), 1); assert.deepEqual(attachment.project.recentConversation.map(row => row.text), ['PROGRESS_NOTE_TEXT']);
  // Every handoff the decision snapshot used to list reaches the worker once: receipts carry the recent ones, `handoffs` the rest.
  for (const needle of ['DONE_HANDOFF_LINE', 'FAILED_HANDOFF', 'STOPPED_RECENT_HANDOFF', 'OLD_STOP_HANDOFF']) assert.equal(occurrences(all, needle), 1, needle);
  assert.deepEqual(attachment.project.handoffs.map(row => row.handoff), ['已中断：OLD_STOP_HANDOFF']);
  assert.ok(attachment.project.continuity.actionReceipts.every(row => row.intent !== undefined), 'the worker\'s receipts are whole');
});
