import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { UserInteractionService } from '../user-interaction-service.mjs';
const until = async fn => { const deadline = Date.now() + 10000; while (!fn()) { if (Date.now() > deadline) throw new Error('Isolated continuity fixture timed out'); await delay(5); } };
const hold = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-continuity-')), store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Local fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 2048, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoStore: false, autoRecall: false } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Continuing work', workspace: directory, initiative: { cooldownMs: 0 } });
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); p.decisionMode = 'rna-model'; p.initialization = { status: 'ready' }; p.simulated = false; p.assignments = { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] }; state.settings.realTokenBudget = null; });
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 999999, tickIntervalMs: 0, decisionProvider: async function* () { yield { type: 'text_delta', delta: JSON.stringify({ action: 'wait', content: '', reason: 'Controlled context-only fixture', evidenceIds: [], nextReviewAfterMs: 86400000 }) }; yield { type: 'usage', usage: { totalTokens: 0 } }; yield { type: 'done', stopReason: 'stop' }; }, ...options });
  t.after(async () => { await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  await until(() => controller.contexts.get(project.id)?.initialized);
  return { store, controller, projectId: project.id, sessionId: session.id, directory, project: () => store.state.projects.find(row => row.id === project.id), context: () => controller.contexts.get(project.id) };
}

test('coherent context retains the actual request, final conclusion and failed tool after a long successful tool batch', async t => {
  const f = await fixture(t); f.store.message(f.sessionId, { text: 'ORIGINAL_OUTCOME ' + 'request-detail '.repeat(200) + 'FINAL_USER_CONSTRAINT' });
  const turnId = f.store.state.sessions.find(row => row.id === f.sessionId).activeTurnId;
  f.store.mutate(state => { const session = state.sessions.find(row => row.id === f.sessionId); for (let i = 0; i < 35; i++) session.items.push({ id: `tool-${i}`, turnId, kind: 'tool', simulated: false, tool: { name: 'project_read', status: i === 3 ? 'failed' : 'completed', output: i === 3 ? 'ROOT_CAUSE_AT_TOOL_THREE' : 'large result '.repeat(300) } }); session.items.push({ id: 'final-answer', turnId, kind: 'assistant', simulated: false, text: 'Actual intermediate finding. ' + 'supporting detail '.repeat(300) + 'FINAL_CONCLUSION_AND_NEXT_STEP' }); });
  f.store.finishRuntimeTurn(f.sessionId, turnId);
  const context = f.controller.snapshot(f.project()).continuity.recentTurns.at(-1), source = f.controller.sources(f.project(), 'fixture-scope').find(row => row.type === 'conversation_result');
  for (const value of [context, JSON.parse(source.summary)]) { assert.match(JSON.stringify(value.requests), /ORIGINAL_OUTCOME/); assert.match(JSON.stringify(value.requests), /FINAL_USER_CONSTRAINT/); assert.match(value.final.text, /FINAL_CONCLUSION_AND_NEXT_STEP/); assert.match(JSON.stringify(value.tools), /ROOT_CAUSE_AT_TOOL_THREE/); assert.equal(value.final.verifiedByHost, undefined); assert.match(value.final.basis, /^assistant reply \(its own account\); /); assert.ok(value.omitted.toolResults > 20); }
  assert.match(context.final.text, /middle omitted/);
});

test('project_history reads original pages and rejects foreign, archived, deleted and revoked sources at execution time', async t => {
  const f = await fixture(t), other = f.store.createProject({ rhythm: { control: 'manual' }, name: 'Other', workspace: f.directory });
  f.store.mutate(state => {
    state.sessions.find(row => row.id === f.sessionId).items.push({ id: 'retained-text', kind: 'assistant', simulated: false, text: 'UNIQUE_BEGIN ' + 'x'.repeat(20000) + ' UNIQUE_END' }, { id: 'redacted-text', kind: 'assistant', simulated: false, sourceDeleted: true, text: 'MUST_NOT_RESURRECT' });
    state.sessions.find(row => row.id === other.session.id).items.push({ id: 'foreign-text', kind: 'user', text: 'FOREIGN_PRIVATE' });
    const p = state.projects.find(row => row.id === f.projectId); p.initiativeRuntime.sdkState.actions.push({ id: 'retained-action', action: 'work', status: 'failed', evidenceIds: [], content: 'Investigate', failure: { code: 'root_cause', message: 'Actual controlled failure' } }, { id: 'revoked-action', action: 'work', status: 'failed', evidenceIds: [], content: 'MUST_NOT_RESURRECT_ACTION', contextRevoked: true });
  });
  const tool = f.controller.historyTools(f.context())[0], read = async args => JSON.parse((await tool.execute('read', args, new AbortController().signal)).content[0].text);
  const first = await read({ sessionId: f.sessionId, itemId: 'retained-text', limit: 1000 }); assert.match(first.content, /UNIQUE_BEGIN/); assert.equal(first.nextOffset, 1000);
  const last = await read({ sessionId: f.sessionId, itemId: 'retained-text', offset: first.totalChars - 100 }); assert.match(last.content, /UNIQUE_END/); assert.equal(last.nextOffset, null);
  assert.match((await read({ actionId: 'retained-action' })).content, /root_cause/);
  for (const args of [{ sessionId: other.session.id, itemId: 'foreign-text' }, { sessionId: f.sessionId, itemId: 'redacted-text' }, { actionId: 'revoked-action' }]) await assert.rejects(read(args), { code: 'history_unavailable' });
  f.store.updateSession(f.sessionId, { archived: true }); await assert.rejects(read({ sessionId: f.sessionId, itemId: 'retained-text' }), { code: 'history_unavailable' });
  f.store.deleteSession(f.sessionId); await assert.rejects(read({ sessionId: f.sessionId, itemId: 'retained-text' }), { code: 'history_unavailable' });
});

test('a useful proactive message interleaves with a running foreground turn without resuming or replacing it', async t => {
  const f = await fixture(t); f.store.message(f.sessionId, { text: 'Inspect the project.' });
  f.store.mutate(state => { const session = state.sessions.find(row => row.id === f.sessionId); session.turns.find(turn => turn.id === session.activeTurnId).status = 'paused'; session.status = 'paused'; });
  assert.equal(f.controller.presence(f.project()).activeTurn, false);
  const context = f.context(), action = { id: 'paused-communication', intentKey: 'paused-key', revision: context.coordinator.state.revision, content: 'An actual retained result is ready for review.', evidenceIds: [] };
  const result = await f.controller.share(context, action, { signal: new AbortController().signal });
  assert.equal(result.deferred, undefined);
  const session = f.store.state.sessions.find(row => row.id === f.sessionId);
  assert.equal(session.items.filter(item => item.initiativeActionId === action.id).length, 1);
  assert.equal(session.turns.find(turn => turn.id === session.activeTurnId).status, 'paused');
  f.store.mutate(state => { const session = state.sessions.find(row => row.id === f.sessionId); session.turns.find(turn => turn.id === session.activeTurnId).status = 'running'; });
  assert.equal(f.controller.presence(f.project()).activeTurn, true);
  const runningShare = { ...action, id: 'new-share', intentKey: 'new-share-key', content: 'A second, independent finding is ready while the foreground turn runs.' };
  assert.equal((await f.controller.share(context, runningShare, { signal: new AbortController().signal })).deferred, undefined);
  await f.controller.share(context, runningShare, { signal: new AbortController().signal });
  const current = f.store.state.sessions.find(row => row.id === f.sessionId);
  assert.equal(current.items.filter(item => item.initiativeActionId === runningShare.id).length, 1);
  assert.equal(current.turns.find(turn => turn.id === current.activeTurnId).status, 'running');
  assert.equal(current.items.find(item => item.initiativeActionId === runningShare.id).turnId, null);
  assert.equal(f.controller.presence(f.project()).allowInterleavedAsk, true);
});

test('completed tool receipts remain readable after a real SDK request fails, with bounded private-safe projections', async t => {
  let step = 0;
  const f = await fixture(t, { runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* () {
    yield { type: 'usage', usage: { totalTokens: 10 } };
    if (step++ === 0) { yield { type: 'tool_call', id: 'actual-file-read', name: 'project_read', arguments: { path: 'evidence.txt' } }; yield { type: 'done', stopReason: 'toolUse' }; }
    else throw Object.assign(new Error('Injected model failure after actual file inspection'), { code: 'controlled_model_failure' });
  } }) });
  writeFileSync(join(f.directory, 'evidence.txt'), 'VERIFIED_BEFORE_FAILURE');
  const action = { id: 'partial-work', action: 'work', revision: f.context().coordinator.state.revision, evidenceIds: [], content: 'Read the retained project evidence.' };
  f.context().coordinator.state.actions.push({ ...action, status: 'failed' }); await f.context().coordinator._persist();
  await assert.rejects(f.controller.work(f.context(), action, { signal: new AbortController().signal, evidence: [], tokenBudget: null }), { code: 'controlled_model_failure' });
  let job = f.project().jobs.find(job => job.id === action.id);
  assert.equal(job.status, 'failed'); assert.equal(job.toolReceiptCounts.completed, 1);
  assert.equal(job.toolReceipts[0].toolCallId, 'actual-file-read'); assert.match(job.toolReceipts[0].output, /VERIFIED_BEFORE_FAILURE/); assert.match(job.toolReceipts[0].resultHash, /^[a-f0-9]{64}$/);
  const tool = f.controller.historyTools(f.context())[0];
  const result = await tool.execute('inspect-history', { actionId: action.id }, new AbortController().signal);
  assert.match(result.content[0].text, /VERIFIED_BEFORE_FAILURE/); assert.match(result.content[0].text, /controlled_model_failure/);
  f.store.configurationService.secrets.receiptTestSecret = 'PRIVATE_RECEIPT_SECRET';
  for (let i = 0; i < 15; i++) f.controller.recordToolReceipt(f.context(), action, { toolCallId: `bounded-${i}`, toolName: 'project_read', isError: i === 2, uncertain: i === 3, result: { content: [{ type: 'text', text: `PRIVATE_RECEIPT_SECRET ${'x'.repeat(4000)} last-fact-${i}` }] } });
  job = f.project().jobs.find(job => job.id === action.id);
  assert.equal(job.toolReceipts.length, 12); assert.equal(job.toolReceiptCounts.total, 16); assert.equal(job.toolReceiptCounts.failed, 1); assert.equal(job.toolReceiptCounts.uncertain, 1);
  assert.equal(JSON.stringify(job.toolReceipts).includes('PRIVATE_RECEIPT_SECRET'), false); assert.ok(job.toolReceipts.every(row => row.output.length <= 2000 && row.truncated));
  f.store.mutate(state => { const job = state.projects.find(row => row.id === f.projectId).jobs.find(job => job.id === action.id); job.contextRevoked = true; job.sourceDeleted = true; });
  const before = job.toolReceiptCounts.total; f.controller.recordToolReceipt(f.context(), action, { toolCallId: 'late', toolName: 'project_read', result: { content: [{ type: 'text', text: 'MUST_NOT_REAPPEAR' }] } }); assert.equal(f.project().jobs.find(job => job.id === action.id).toolReceiptCounts.total, before);
  assert.equal((await tool.execute('read-redacted', { actionId: action.id }, new AbortController().signal)).content[0].text.includes('last-fact'), false);
});

test('a failed real SDK background run hands its diagnosis to the next useful method immediately without a timer or new user command', async t => {
  let workNumber = 0, actionId, decisions = 0, workRequests = 0;
  const f = await fixture(t, { initialDelayMs: 0, decisionProvider: async function* (request) {
    const input = JSON.parse(request.messages[0].content[0].text), failed = input.recentActions.find(row => row.status === 'failed'), completed = input.events.find(row => row.type === 'action_completed'); decisions++;
    let action = 'work', content = failed ? 'Read the original failure receipt and inspect the alternative evidence.' : 'Investigate the initial approach.';
    if (failed) { actionId = failed.actionId; assert.equal(failed.failure.code, 'context_limit'); }
    if (completed) { action = 'share'; content = '已根据失败诊断调整方法，并核对了实际资料。'; }
    yield { type: 'text_delta', delta: JSON.stringify({ action, content, reason: 'Follow actual outcomes', evidenceIds: [completed?.id ?? input.events[0].id], nextReviewAfterMs: 86400000 }) };
    yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: 'stop' };
  }, runtimeFactory: options => {
    const number = ++workNumber;
    return createRnaRuntime({ ...options, provider: async function* (request) {
      workRequests++; yield { type: 'usage', usage: { totalTokens: 10 } };
      if (number === 1) throw Object.assign(new Error('ROOT_CAUSE_BOUNDARY: split the original inspection'), { code: 'context_limit' });
      assert.match(JSON.stringify(request.messages), /context_limit/); assert.ok(request.tools.some(tool => tool.name === 'project_history'));
      if (!request.messages.some(message => message.role === 'toolResult')) { yield { type: 'tool_call', id: 'original-receipt', name: 'project_history', arguments: { actionId } }; yield { type: 'done', stopReason: 'toolUse' }; }
      else { assert.match(JSON.stringify(request.messages.filter(message => message.role === 'toolResult')), /context_limit/); yield { type: 'text_delta', delta: 'Verified original failure receipt. The earlier inspection hit context_limit; use a smaller inspection scope. No workspace mutation claimed.' }; yield { type: 'done', stopReason: 'stop' }; }
    } });
  } });
  await until(() => f.store.state.sessions.find(row => row.id === f.sessionId).items.some(item => item.source === 'initiative'));
  assert.equal(workNumber, 2); assert.equal(workRequests, 3); assert.equal(decisions, 3);
  assert.equal(f.project().initiativeRuntime.sdkState.actions.filter(action => action.status === 'failed').length, 1);
  assert.ok(f.project().initiativeRuntime.sdkState.events.every(event => event.type !== 'action_failed'));
  assert.equal(f.store.state.goals.length, 0);
});

for (const outcome of ['completed', 'failed', 'new-input']) test(`host does not review busy work on an expired timer; ${outcome} wakes the real SDK loop`, async t => {
  let clock = Date.now(), decisions = 0, workRequests = 0, workSignal; const release = hold(), inputs = [];
  // Release before fixture teardown so a failed assertion cannot hang cleanup.
  t.after(() => release.resolve());
  const f = await fixture(t, { initialDelayMs: 0, now: () => clock, decisionProvider: async function* (request) {
    const input = JSON.parse(request.messages[0].content[0].text); inputs.push(input); decisions++;
    yield { type: 'text_delta', delta: JSON.stringify({ action: decisions === 1 ? 'work' : 'wait', content: decisions === 1 ? 'Inspect the existing project evidence.' : '', reason: 'Use the actual completion or changed evidence', evidenceIds: [input.events.at(-1).id], nextReviewAfterMs: 86400000 }) };
    yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: 'stop' };
  }, runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* (request) {
    workRequests++; workSignal = request.signal; yield { type: 'usage', usage: { totalTokens: 10 } };
    let abort; const interrupted = new Promise((_, reject) => { abort = () => reject(request.signal.reason); request.signal.addEventListener('abort', abort, { once: true }); if (request.signal.aborted) abort(); });
    try { await Promise.race([release.promise, interrupted]); } finally { request.signal.removeEventListener('abort', abort); }
    if (outcome === 'failed') throw Object.assign(new Error('Controlled completed request failure'), { code: 'controlled_failure' });
    yield { type: 'text_delta', delta: 'Inspection complete. No files were changed.' }; yield { type: 'done', stopReason: 'stop' };
  } }) });
  await until(() => workRequests === 1 && !f.context().reviewPromise);
  clock = f.context().coordinator.snapshot().nextReviewAt + 1;
  for (let i = 0; i < 100; i++) { await f.controller.pump(); await f.context().reviewPromise; }
  assert.equal(decisions, 1); assert.equal(workRequests, 1); assert.equal(f.context().coordinator.active.size, 1);
  if (outcome === 'new-input') {
    f.store.message(f.sessionId, { text: 'NEW_USER_CONSTRAINT: what have you found? Please keep inspecting.' });
    assert.equal(workSignal.aborted, false, 'Ordinary input invalidates the decision, not independent read-only work; explicit controls have their own contract tests');
    release.resolve();
  } else release.resolve();
  await until(() => decisions === 2 && !f.context().reviewPromise && !f.context().coordinator.active.size);
  if (outcome === 'completed') assert.ok(inputs[1].events.some(row => row.type === 'action_completed'));
  if (outcome === 'failed') assert.equal(inputs[1].recentActions[0].failure.code, 'controlled_failure');
  if (outcome === 'new-input') assert.match(JSON.stringify(inputs[1].events), /NEW_USER_CONSTRAINT/);
  assert.equal(workRequests, 1);
});


test('communication context separates retained delivered findings from work receipts and excludes revoked or deleted content', async t => {
  const f = await fixture(t);
  f.store.mutate(state => {
    const project = state.projects.find(row => row.id === f.projectId), session = state.sessions.find(row => row.id === f.sessionId);
    project.initiativeRuntime.sdkState.actions.push(
      { id: 'discussed-work', action: 'work', status: 'completed', evidenceIds: [], content: 'Already discussed', resultSummary: 'Reported finding', finishedAt: 1000 },
      { id: 'undelivered-work', action: 'work', status: 'completed', evidenceIds: [], content: 'New inspection', resultSummary: 'Worker states a new finding', finishedAt: 2000 },
      { id: 'revoked-work', action: 'work', status: 'completed', contextRevoked: true, evidenceIds: [], content: 'REVOKED_CONTENT', resultSummary: 'REVOKED_CONTENT' },
      { id: 'pending-share', action: 'share', status: 'queued', evidenceIds: [], content: 'Not yet delivered', deferredReason: 'user_typing' }
    );
    session.items.push({ id: 'delivered', kind: 'assistant', source: 'initiative', initiativeActionId: 'actual-share', evidenceIds: ['action:discussed-work:completed'], text: 'Delivered finding', createdAt: '2026-01-01T00:00:00.000Z' }, { id: 'deleted', kind: 'assistant', source: 'initiative', initiativeActionId: 'deleted-share', sourceDeleted: true, text: 'DELETED_CONTENT' });
  });
  const value = f.controller.snapshot(f.project()).communication;
  assert.deepEqual(value.recentDeliveries.map(x => x.actionId), ['actual-share']); assert.equal(value.lastDeliveredAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(value.recentWorkNotReferencedByDelivery.map(x => x.actionId), ['undelivered-work']); assert.equal(value.recentWorkNotReferencedByDelivery[0].verifiedByHost, false);
  assert.deepEqual(value.pending, [{ actionId: 'pending-share', action: 'share', status: 'queued', deferredReason: 'user_typing' }]);
  assert.ok(!JSON.stringify(value).includes('DELETED_CONTENT')); assert.ok(!JSON.stringify(value).includes('REVOKED_CONTENT'));
  assert.match(value.interpretation, /may already have been discussed in the foreground/);
});


test('one autonomous question can accompany foreground work; a pending or interrupted foreground question holds the slot until answer or cancel', async t => {
  const f = await fixture(t), service = new UserInteractionService(f.store); f.controller.interactions = service; t.after(() => service.close());
  f.store.message(f.sessionId, { text: 'Continue implementation while I choose the next direction.' });
  const session = () => f.store.state.sessions.find(row => row.id === f.sessionId), turnId = session().activeTurnId;
  const questions = [{ id: 'direction', question: 'Choose the next emphasis', options: [{ id: 'visual', label: 'Visual quality' }, { id: 'play', label: 'Gameplay' }] }];
  const card = () => session().items.filter(item => item.interaction).at(-1).interaction;
  const permissions = structuredClone(f.project().permissions);
  const ask = async id => f.controller.ask(f.context(), { id, revision: f.context().coordinator.state.revision, content: 'A concrete next choice', questions, evidenceIds: [] }, { signal: new AbortController().signal });
  assert.equal((await ask('first-autonomous-choice')).deferred, undefined);
  assert.equal(card().source, 'initiative'); assert.equal(card().canRespond, true); assert.equal(session().activeTurnId, turnId); assert.equal(session().status, 'running'); assert.equal(service.isWaiting(f.sessionId), false);
  assert.equal((await ask('another-choice')).reason, 'pending_question');
  service.answer(f.sessionId, card().id, { requestId: 'chosen-first', answers: [{ id: 'direction', selected: ['visual'], custom: 'Please keep the current controls.' }] });
  assert.equal(card().status, 'answered'); assert.equal(f.controller.presence(f.project()).pendingQuestion, false); assert.deepEqual(f.project().permissions, permissions);
  // The next foreground ask is a real waiting tool, and is also the question
  // slot owner after a recoverable interruption, independently of work status.
  const waiting = service.ask({ sessionId: f.sessionId, turnId, toolCallId: 'foreground-choice', questions });
  const foregroundId = card().id; const interrupted = assert.rejects(waiting, { code: 'interaction_interrupted' });
  assert.equal((await ask('blocked-by-foreground')).reason, 'pending_question');
  service.interrupt(f.sessionId, foregroundId, 'controlled-pause'); await interrupted;
  assert.equal(card().status, 'interrupted'); assert.equal(card().canRespond, true);
  assert.equal((await ask('blocked-by-interrupted')).reason, 'pending_question');
  service.cancel(f.sessionId, foregroundId, { requestId: 'cancel-foreground' });
  assert.equal(f.controller.presence(f.project()).pendingQuestion, false);
  assert.equal((await ask('after-cancellation')).deferred, undefined); assert.equal(card().actionId, 'after-cancellation');
  assert.equal(session().items.filter(item => item.interaction?.canRespond).length, 1);
  assert.equal(session().activeTurnId, turnId); assert.equal(session().status, 'running'); assert.deepEqual(f.project().permissions, permissions);
});

test('expired, deleted and revoked interaction records do not falsely occupy the proactive question slot', async t => {
  const f = await fixture(t); f.store.mutate(state => { const s = state.sessions.find(s => s.id === f.sessionId); s.items.push(
    { id: 'inactive-question', interaction: { id: 'inactive-question', kind: 'question', status: 'pending', canRespond: false } },
    { id: 'deleted-question', sourceDeleted: true, interaction: { id: 'deleted-question', kind: 'question', status: 'pending', canRespond: true } },
    { id: 'revoked-question', contextRevoked: true, interaction: { id: 'revoked-question', kind: 'permission', status: 'interrupted', canRespond: true } }
  ); });
  assert.equal(f.controller.presence(f.project()).pendingQuestion, false); assert.deepEqual(f.controller.snapshot(f.project()).actionContracts.ask.pending, []);
});

test('a failed request waiting for the user to retry it is not answered from the background until the user moves on', async t => {
  // Live, 2026-10-03: the foreground answer failed on the chosen ChatGPT model and the initiative answered the same
  // question from the background with the project's own model, then did it again for the next failed question.
  const f = await fixture(t); f.store.message(f.sessionId, { text: 'WHAT_ABOUT_THE_NEWS' });
  const turnId = f.store.state.sessions.find(row => row.id === f.sessionId).activeTurnId;
  f.store.mutate(state => { const session = state.sessions.find(row => row.id === f.sessionId), turn = session.turns.find(row => row.id === turnId); Object.assign(turn, { status: 'failed', completedAt: new Date().toISOString() }); session.activeTurnId = null; session.status = 'idle'; });
  const snapshot = f.controller.snapshot(f.project()), sources = f.controller.sources(f.project(), 'fixture-scope');
  assert.doesNotMatch(JSON.stringify(snapshot.recentConversation), /WHAT_ABOUT_THE_NEWS/);
  assert.doesNotMatch(JSON.stringify(snapshot.continuity.unfinishedTurns), new RegExp(turnId));
  assert.deepEqual(snapshot.continuity.awaitingUserRetry.sessionIds, [f.sessionId]);
  // The failure stays observable (diagnosis, learning) and says whose it is.
  const failure = sources.find(row => row.id.startsWith(`turn:${turnId}:failed`));
  assert.match(JSON.parse(failure.summary).awaitingUserRetry, /waits for the user to retry/);
  // A message built on it is not delivered.
  const message = f.store.state.sessions.find(row => row.id === f.sessionId).items.find(item => item.kind === 'user' && item.turnId === turnId);
  for (const evidenceIds of [[failure.id], [`message:${message.id}`]]) {
    const context = f.context(), action = { id: `answer-${evidenceIds[0]}`, intentKey: evidenceIds[0], revision: context.coordinator.state.revision, content: 'Here is my view on the news.', evidenceIds };
    const result = await f.controller.share(context, action, { signal: new AbortController().signal });
    assert.equal(result.reason, 'awaiting_user_retry');
  }
  assert.equal(f.store.state.sessions.find(row => row.id === f.sessionId).items.some(item => item.source === 'initiative'), false);
  // Once the user sends something else, the failed request is ordinary history again.
  f.store.message(f.sessionId, { text: 'NEXT_REQUEST' });
  const later = f.controller.sources(f.project(), 'fixture-scope');
  assert.equal(JSON.parse(later.find(row => row.id.startsWith(`turn:${turnId}:failed`)).summary).awaitingUserRetry, undefined);
  assert.equal(f.controller.snapshot(f.project()).continuity.awaitingUserRetry, undefined);
});
