import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController, pinnedVersionAllowed, scheduledOccurrence, scheduledRunOwn, EARLIER_TASK_PLACEHOLDER, EXCERPT_MARKER } from '../project-initiative-controller.mjs';
import { SCHEDULED_DELIVERY_INSTRUCTION } from '../proactive-narrator.mjs';
import { createProjectSchedule } from '../../../packages/sdk/src/project-schedules.mjs';
import { SCHEDULE_TASK_PLACEHOLDER } from '../../../packages/sdk/src/project-context.mjs';
import { controlVersion } from '../project-proactivity.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';

// Sharded persistence issues several fsyncs per mutate; under the parallel full suite a 16-step background job needs more than 7 s.
async function until(check) { const end = Date.now() + 20000; while (Date.now() < end) { if (check()) return; await delay(5); } throw Error('Background integration fixture did not settle'); }
async function fixture(t, { recall, provider, writable = false, autoRecall = true, decisionService, schedule = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-background-context-')), store = new Store(join(dir, 'state.json'));
  const p = store.configurationService.provider(null, { name: 'Isolated deterministic fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoStore: false, autoRecall } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Background continuity fixture', workspace: dir, description: 'Inspect the next actual evidence.' });
  store.mutate(state => { const p = state.projects.find(p => p.id === project.id); p.initialization = { status: 'ready' }; p.simulated = false; p.decisionMode = 'rna-model'; p.initiative.tokenBudget = null; p.permissions = { workspace: writable ? 'write' : 'read', background: writable ? 'inherit' : 'read', revision: 1 }; p.assignments = { skillIds: [], toolIds: ['project_read', ...(writable ? ['project_write'] : []), ...(autoRecall ? ['openviking_search', 'openviking_read'] : [])], mcpServerIds: [] };
    // A paused schedule: it is listed in the planning state, and nothing claims an occurrence of it.
    if (schedule) p.schedules = [{ ...createProjectSchedule({ id: 'daily-schedule', title: 'Daily report', task: schedule, destinationSessionId: session.id, rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }), enabled: false }]; });
  writeFileSync(join(dir, 'evidence.txt'), 'Actual isolated file used by the runtime.');
  const recallCalls = []; store.memoryService.recall = async (...args) => { recallCalls.push(args); return recall(...args); };
  let decisions = 0, modelCalls = 0;
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, ...(decisionService ? { decisionService } : {}), decisionProvider: async function* (request) {
    const input = JSON.parse(request.messages[0].content[0].text), output = decisions++ ? { action: 'wait', reason: 'No additional work', evidenceIds: [], content: '', nextReviewAfterMs: 86400000 } : { action: 'work', reason: 'A concrete project evidence review', evidenceIds: [input.allowedEvidenceIds[0]], content: 'Inspect the actual evidence and use any relevant project memory.', nextReviewAfterMs: 86400000 };
    yield { type: 'text_delta', delta: JSON.stringify(output) }; yield { type: 'usage', usage: { totalTokens: 11 } }; yield { type: 'done', stopReason: 'stop' };
  }, runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* (request) { modelCalls++; yield* provider(request); } }) });
  t.after(async () => { await controller.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, project, dir, controller, recallCalls, modelCalls: () => modelCalls, current: () => store.state.projects.find(p => p.id === project.id) };
}
const final = async function* () { yield { type: 'text_delta', delta: 'The isolated inspection is complete.' }; yield { type: 'usage', usage: { totalTokens: 17 } }; yield { type: 'done', stopReason: 'stop' }; };

test('background work recalls assigned OpenViking memory once and injects it as request context, with a recorded projection', async t => {
  let observed;
  const app = await fixture(t, { recall: async () => ({ entries: [{ uri: 'viking://fixture/memories/evidence.md', summary: 'ISOLATED_RECALL_MARKER', level: 'L2' }], content: JSON.stringify({ entries: [{ summary: 'ISOLATED_RECALL_MARKER' }] }), candidateCount: 1, stage: 'selected' }), provider: async function* (request) { observed = request; yield* final(); } });
  await until(() => app.current().jobs[0]?.status === 'completed');
  assert.equal(app.recallCalls.length, 1); assert.equal(app.recallCalls[0][0], app.project.id);
  assert.match(JSON.stringify(observed.messages), /ISOLATED_RECALL_MARKER/); assert.doesNotMatch(observed.systemPrompt, /ISOLATED_RECALL_MARKER/);
  const projection = app.current().jobs[0].memoryContext; assert.equal(projection.execution, 'retrieved'); assert.equal(projection.injectedEntries.length, 1); assert.equal(app.modelCalls(), 1);
});

// MEM-12: background recall goes through the same JEV memory.filter hook as the foreground, keyed by project and action;
// a checkpoint resume sends no new prompt, so it recalls nothing and keeps its first pass's memory record.
const twoPassages = async () => ({ entries: [{ uri: 'viking://fixture/memories/unrelated.md', summary: 'UNRELATED_PASSAGE', level: 'L2' }, { uri: 'viking://fixture/memories/evidence.md', summary: 'RELEVANT_PASSAGE', level: 'L2' }], content: JSON.stringify([{ summary: 'UNRELATED_PASSAGE' }, { summary: 'RELEVANT_PASSAGE' }]), candidateCount: 2, stage: 'summaries' });
test('background recall drops the passages the memory.filter judgment rejects, as the foreground does (MEM-12)', async t => {
  let observed; const filtered = [];
  // Only memory.filter is on; every other judgment point stays off and answers nothing (its fallback applies).
  const judged = { enabled: point => point === 'memory.filter', memoryFilter: async input => { filtered.push(input); return { keep: [1], dropped: 1 }; } };
  const decisionService = new Proxy(judged, { get: (target, key) => key in target ? target[key] : key === 'then' || typeof key !== 'string' ? undefined : async () => null });
  const app = await fixture(t, { decisionService, recall: twoPassages, provider: async function* (request) { observed = request; yield* final(); } });
  await until(() => app.current().jobs[0]?.status === 'completed');
  const job = app.current().jobs[0];
  assert.equal(filtered.length, 1); assert.deepEqual([filtered[0].projectId, filtered[0].turnId, filtered[0].prompt], [app.project.id, job.id, 'Inspect the actual evidence and use any relevant project memory.']);
  assert.equal(job.memoryContext.filtered, 1); assert.deepEqual(job.memoryContext.injectedEntries.map(row => row.summary), ['RELEVANT_PASSAGE']);
  assert.match(JSON.stringify(observed.messages), /RELEVANT_PASSAGE/); assert.doesNotMatch(JSON.stringify(observed.messages), /UNRELATED_PASSAGE/);
});

test('a background run resumed from its checkpoint recalls nothing and keeps the memory record of its first pass (MEM-12)', async t => {
  const app = await fixture(t, { recall: twoPassages, provider: final });
  await until(() => app.current().jobs[0]?.status === 'completed');
  assert.equal(app.recallCalls.length, 1); const first = structuredClone(app.current().jobs[0].memoryContext);
  const context = app.controller.contexts.get(app.project.id), action = context.coordinator.state.actions.find(row => row.action === 'work');
  await app.controller.work(context, { ...structuredClone(action), checkpoint: { sessionId: action.id } }, { signal: new AbortController().signal, evidence: [] }).catch(() => {});
  assert.equal(app.recallCalls.length, 1, 'no recall for a resume');
  assert.deepEqual(app.current().jobs[0].memoryContext, first);
});

test('failed background recall records unavailability without invented memory and still runs authorized work', async t => {
  let observed;
  const app = await fixture(t, { recall: async () => { throw Error('Isolated backend failure'); }, provider: async function* (request) { observed = request; yield* final(); } });
  await until(() => app.current().jobs[0]?.status === 'completed');
  assert.equal(app.current().jobs[0].memoryContext.execution, 'unavailable'); assert.equal(app.current().jobs[0].memoryContext.injectedEntries.length, 0);
  assert.match(JSON.stringify(observed.messages), /No memory was retrieved/); assert.equal(app.modelCalls(), 1);
});

test('a pre-execution schema failure retains the actual string-null type through many later successes without retaining full arguments', async t => {
  const app = await fixture(t, { autoRecall: false, writable: true, provider: async function* (request) {
    const count = request.messages.filter(m => m.role === 'toolResult').length;
    if (count === 0) { yield { type: 'tool_call', id: 'invalid-write', name: 'project_write', arguments: { path: 'must-not-write.txt', content: 'PRIVATE_FULL_TOOL_CONTENT', expectedHash: 'null' } }; yield { type: 'usage', usage: { totalTokens: 17 } }; yield { type: 'done', stopReason: 'toolUse' }; }
    else if (count < 16) { yield { type: 'tool_call', id: `read-${count}`, name: 'project_read', arguments: { path: 'evidence.txt' } }; yield { type: 'usage', usage: { totalTokens: 17 } }; yield { type: 'done', stopReason: 'toolUse' }; }
    else yield* final();
  } });
  await until(() => app.current().jobs[0]?.status === 'completed');
  const job = app.current().jobs[0], failure = job.toolReceipts.find(r => r.toolCallId === 'invalid-write');
  assert.equal(job.toolReceiptCounts.total, 16); assert.equal(job.toolReceiptCounts.failed, 1); assert.equal(job.toolReceipts.length, 12); assert.ok(failure);
  assert.equal(failure.failureContext.argumentPath, '$.expectedHash'); assert.equal(failure.failureContext.argument.type, 'string'); assert.equal(failure.failureContext.argument.literal, 'null'); assert.equal(failure.failureContext.argumentsRetained, false);
  assert.doesNotMatch(JSON.stringify(job.toolReceipts), /PRIVATE_FULL_TOOL_CONTENT/); assert.equal(existsSync(join(app.dir, 'must-not-write.txt')), false);
  assert.equal(app.recallCalls.length, 0); assert.equal(app.current().jobs[0].memoryContext.execution, 'on-demand');
});

// EVO-3: generated tools keep their names across generations, so a background run pins the version it started on (as a
// foreground turn does): a generation committed before its checkpoint resume must not swap in a newer script.
test('a background run resumed after a new generation is composed on the version it started on', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-background-pin-')), store = new Store(join(dir, 'state.json'));
  const p = store.configurationService.provider(null, { name: 'Pin fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoStore: false, autoRecall: false } });
  const { project } = store.createProject({ rhythm: { control: 'manual' }, name: 'Pinned version fixture', workspace: dir });
  store.mutate(state => { const target = state.projects.find(row => row.id === project.id); Object.assign(target, { initialization: { status: 'ready' }, simulated: false, decisionMode: 'rna-model', versions: [{ id: 'V1' }, { id: 'V2' }], activeVersionId: 'V1', assignments: { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] } }); target.initiative.tokenBudget = null; });
  writeFileSync(join(dir, 'evidence.txt'), 'Evidence.');
  const composed = [];
  let decisions = 0;
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, decisionProvider: async function* (request) {
    const input = JSON.parse(request.messages[0].content[0].text), output = decisions++ ? { action: 'wait', reason: 'Nothing else', evidenceIds: [], content: '', nextReviewAfterMs: 86400000 } : { action: 'work', reason: 'Inspect', evidenceIds: [input.allowedEvidenceIds[0]], content: 'Inspect the evidence.', nextReviewAfterMs: 86400000 };
    yield { type: 'text_delta', delta: JSON.stringify(output) }; yield { type: 'usage', usage: { totalTokens: 11 } }; yield { type: 'done', stopReason: 'stop' };
  }, runtimeFactory: options => { composed.push(options.projectVersionId); throw Object.assign(new Error('Composition recorded by the fixture'), { code: 'fixture_stop' }); } });
  t.after(async () => { await controller.close(); rmSync(dir, { recursive: true, force: true }); });
  const current = () => store.state.projects.find(row => row.id === project.id);
  await until(() => composed.length === 1 && current().jobs[0]?.status === 'failed');
  assert.equal(current().jobs[0].projectVersionId, 'V1', 'the job records the version it started on'); assert.deepEqual(composed, ['V1']);
  store.mutate(state => { state.projects.find(row => row.id === project.id).activeVersionId = 'V2'; });
  const context = controller.contexts.get(project.id), action = context.coordinator.state.actions.find(row => row.action === 'work');
  await assert.rejects(controller.work(context, { ...structuredClone(action), checkpoint: { sessionId: action.id } }, { signal: new AbortController().signal, evidence: [] }), { code: 'fixture_stop' });
  assert.deepEqual(composed, ['V1', 'V1'], 'the resumed run is composed on V1, not the newer V2');
});

// Review EFF-5: a run paused (or checkpointed) under a routed lighter effort resumes at today's effort once the setting
// no longer routes it; the job records the change.
test('a background run resumed after routing was rolled back continues at today\'s effort, not the saved lighter one', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-background-effort-')), store = new Store(join(dir, 'state.json'));
  const p = store.configurationService.provider(null, { name: 'Effort fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'glm-like', contextWindow: 64000, maxOutputTokens: 1000, reasoning: ['low', 'high', 'max'], compat: { thinkingFormat: 'zai' } }] });
  store.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'glm-like', reasoning: 'max' }, memory: { autoStore: false, autoRecall: false } });
  const { project } = store.createProject({ rhythm: { control: 'manual' }, name: 'Resumed effort fixture', workspace: dir });
  store.mutate(state => { const target = state.projects.find(row => row.id === project.id); Object.assign(target, { initialization: { status: 'ready' }, simulated: false, decisionMode: 'rna-model', assignments: { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] } }); target.initiative.tokenBudget = null; });
  writeFileSync(join(dir, 'evidence.txt'), 'Evidence.');
  const sent = [];
  let decisions = 0;
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, decisionProvider: async function* (request) {
    const input = JSON.parse(request.messages[0].content[0].text), output = decisions++ ? { action: 'wait', reason: 'Nothing else', evidenceIds: [], content: '', nextReviewAfterMs: 86400000 } : { action: 'work', title: 'Inspect', reason: 'Inspect', evidenceIds: [input.allowedEvidenceIds[0]], content: 'Inspect the evidence.', nextReviewAfterMs: 86400000 };
    yield { type: 'text_delta', delta: JSON.stringify(output) }; yield { type: 'usage', usage: { totalTokens: 11 } }; yield { type: 'done', stopReason: 'stop' };
  }, runtimeFactory: async options => { sent.push((await options.beforeRequest())?.reasoning); throw Object.assign(new Error('Effort recorded by the fixture'), { code: 'fixture_stop' }); } });
  t.after(async () => { await controller.close(); rmSync(dir, { recursive: true, force: true }); });
  const current = () => store.state.projects.find(row => row.id === project.id);
  await until(() => sent.length === 1 && current().jobs[0]?.status === 'failed');
  assert.deepEqual(sent, ['max'], 'shadow routing: today\'s effort');
  // The run had been sent at a routed lighter effort (a trial since rolled back) and was paused.
  store.mutate(state => { state.projects.find(row => row.id === project.id).jobs[0].reasoning = { effective: 'low', source: 'jev', depth: 'light' }; });
  const context = controller.contexts.get(project.id), action = context.coordinator.state.actions.find(row => row.action === 'work');
  await assert.rejects(controller.work(context, { ...structuredClone(action), checkpoint: { sessionId: action.id } }, { signal: new AbortController().signal, evidence: [] }), { code: 'fixture_stop' });
  assert.deepEqual(sent, ['max', 'max'], 'resumed at today\'s effort');
  assert.deepEqual(current().jobs[0].reasoning, { effective: 'max', source: 'fallback', resumed: true, replaced: 'low' });
});

// GN-1: the pin keeps a resumed run off a newer script, but a version the user withdrew (rolled back, or took out of trial)
// is not one the run may go on with: it stops and says why, and is not moved to the current version either.
for (const withdrawal of ['trial ended', 'adopted version rolled back']) test(`a background run resumed after its version was withdrawn (${withdrawal}) stops with an explanation`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-background-withdrawn-')), store = new Store(join(dir, 'state.json'));
  const p = store.configurationService.provider(null, { name: 'Withdrawn fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoStore: false, autoRecall: false } });
  const { project } = store.createProject({ rhythm: { control: 'manual' }, name: 'Withdrawn version fixture', workspace: dir });
  const trial = withdrawal === 'trial ended', pinned = trial ? 'T1' : 'V1';
  const versions = trial ? [{ id: 'V1', state: 'active' }, { id: 'T1', state: 'trial', parentVersionId: 'V1' }] : [{ id: 'V0', state: 'archived', bundle: { hash: 'v0' } }, { id: 'V1', state: 'active', parentVersionId: 'V0' }];
  store.mutate(state => { const target = state.projects.find(row => row.id === project.id); Object.assign(target, { initialization: { status: 'ready' }, simulated: false, decisionMode: 'rna-model', versions, activeVersionId: 'V1', trialVersionId: trial ? 'T1' : null, assignments: { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] } }); target.initiative.tokenBudget = null; });
  writeFileSync(join(dir, 'evidence.txt'), 'Evidence.');
  const composed = [];
  let decisions = 0;
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, decisionProvider: async function* (request) {
    const input = JSON.parse(request.messages[0].content[0].text), output = decisions++ ? { action: 'wait', reason: 'Nothing else', evidenceIds: [], content: '', nextReviewAfterMs: 86400000 } : { action: 'work', reason: 'Inspect', evidenceIds: [input.allowedEvidenceIds[0]], content: 'Inspect the evidence.', nextReviewAfterMs: 86400000 };
    yield { type: 'text_delta', delta: JSON.stringify(output) }; yield { type: 'usage', usage: { totalTokens: 11 } }; yield { type: 'done', stopReason: 'stop' };
  }, runtimeFactory: options => { composed.push(options.projectVersionId); throw Object.assign(new Error('Composition recorded by the fixture'), { code: 'fixture_stop' }); } });
  t.after(async () => { await controller.close(); rmSync(dir, { recursive: true, force: true }); });
  const current = () => store.state.projects.find(row => row.id === project.id);
  await until(() => composed.length === 1 && current().jobs[0]?.status === 'failed');
  assert.equal(current().jobs[0].projectVersionId, pinned); assert.ok(pinnedVersionAllowed(current(), pinned));
  // The user withdraws the version the run started on, the way the version controls do.
  store.mutate(state => { controlVersion(state, state.projects.find(row => row.id === project.id), pinned, 'rollback'); });
  assert.equal(current().versions.find(row => row.id === pinned).rolledBackAt !== undefined, true); assert.equal(pinnedVersionAllowed(current(), pinned), false);
  const context = controller.contexts.get(project.id), action = context.coordinator.state.actions.find(row => row.action === 'work');
  const result = await controller.work(context, { ...structuredClone(action), checkpoint: { sessionId: action.id } }, { signal: new AbortController().signal, evidence: [] });
  assert.deepEqual(composed, [pinned], 'nothing is composed: neither the withdrawn version nor the current one');
  assert.equal(result.superseded, true); assert.equal(result.reason, 'version_withdrawn'); assert.match(result.handoff, /^Stopped: .*rolled back by the user or taken out of trial/, 'the handoff is for the next decision: fixed English'); assert.doesNotMatch(result.handoff, /[⺀-鿿]/u);
  const job = current().jobs[0];
  assert.deepEqual([job.status, job.errorCode], ['superseded', 'version_withdrawn']); assert.match(job.output, /回退或退出试用/);
});

test('pinnedVersionAllowed: the selected and superseded versions may go on; withdrawn or missing ones may not', () => {
  const project = { activeVersionId: 'A', trialVersionId: 'T', versions: [{ id: 'A', state: 'active' }, { id: 'T', state: 'trial' }, { id: 'old', state: 'archived' }, { id: 'older', state: 'active' }, { id: 'back', state: 'archived', rolledBackAt: 'x' }, { id: 'ended', state: 'ready' }, { id: 'stale', state: 'stale' }] };
  assert.deepEqual(['A', 'T', 'old', 'older', 'back', 'ended', 'stale', 'gone'].map(id => pinnedVersionAllowed(project, id)), [true, true, true, true, false, false, false, false]);
});

// T3 (token burn, design P2): a scheduled run's first request carries its task once. The planning state, the run's own
// receipt and pending job, and the task text of earlier runs' receipts are the same words again; they are left out only
// when the request keeps them word for word, and nothing else in those rows changes.
const RULE = { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' };
const HOST_TAIL = `\n\nProduce the requested deliverable using current evidence and authorized tools. Report actual outputs and any limitation. The host will deliver this result to the configured project conversation; do not send it to another channel. ${SCHEDULED_DELIVERY_INSTRUCTION}`;
const occurrenceContent = (key, due, task, tail = HOST_TAIL) => `Scheduled occurrence ${key}\nDue: ${due}\nTime rule: ${JSON.stringify(RULE)}\n\n${task}${tail}`;
const TASK = `Daily research. ${'Cover the models, frameworks and products that changed today and cite a source for every item. '.repeat(12)}Deliver the report text.`;
const scheduledAction = (id, key, due, task, { tail, handoff = `HANDOFF_OF_${id}` } = {}) => ({ id, action: 'work', status: 'completed', content: occurrenceContent(key, due, task, tail), evidenceIds: [key], intentKey: id, revision: 1, hostSchedule: { key, scheduleId: 'daily', scheduleRevision: 1, destinationSessionId: 's' }, finishedAt: Date.parse(due) + 600000, handoff });
async function briefFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-brief-dedupe-')), store = new Store(join(directory, 'state.json'));
  const { project } = store.createProject({ rhythm: { control: 'manual' }, name: 'Brief dedupe fixture', workspace: directory, initiative: { cooldownMs: 0 } });
  // A fixed clock: two briefs built one after the other must differ only in what the dedupe takes out (clock.now is in both).
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 999999, tickIntervalMs: 0, independentLearning: true, now: () => Date.parse('2026-10-05T01:00:05.000Z') });
  t.after(async () => { await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  const weekly = TASK.replace('Daily research.', 'Weekly research.'), running = scheduledAction('day-5', 'schedule:daily:k5', '2026-10-05T01:00:00.000Z', TASK);
  delete running.handoff; delete running.finishedAt; running.status = 'running';
  const actions = [
    { id: 'ancient', action: 'work', status: 'completed', content: 'An older one-off check.', evidenceIds: [], intentKey: 'a0', revision: 1, handoff: 'HANDOFF_OF_ANCIENT', finishedAt: 1 },
    { id: 'oneoff', action: 'work', status: 'completed', content: 'Check chapter one carefully.', evidenceIds: [], intentKey: 'a1', revision: 1, handoff: 'HANDOFF_OF_ONEOFF', finishedAt: 2 },
    scheduledAction('day-1', 'schedule:daily:k1', '2026-10-01T01:00:00.000Z', TASK),
    scheduledAction('day-2', 'schedule:daily:k2', '2026-10-02T01:00:00.000Z', weekly),
    scheduledAction('day-3', 'schedule:daily:k3', '2026-10-03T01:00:00.000Z', TASK, { tail: '\n\nProduce the requested deliverable using current evidence and authorized tools. A different host tail.' }),
    scheduledAction('day-4', 'schedule:daily:k4', '2026-10-04T01:00:00.000Z', TASK),
    { id: 'chat-1', action: 'share', status: 'completed', content: 'A short message.', evidenceIds: [], intentKey: 'a6', revision: 1, finishedAt: 7 },
    { id: 'chat-2', action: 'share', status: 'completed', content: 'Another short message.', evidenceIds: [], intentKey: 'a7', revision: 1, finishedAt: 8 },
    running];
  store.mutate(state => {
    const p = state.projects.find(row => row.id === project.id);
    Object.assign(p, { decisionMode: 'rna-model', initialization: { status: 'ready' }, simulated: false, permissions: { workspace: 'write', background: 'inherit', revision: 1 }, assignments: { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] } });
    p.initiativeRuntime = { ...(p.initiativeRuntime ?? {}), sdkState: { ...(p.initiativeRuntime?.sdkState ?? {}), actions, events: [] } };
    p.jobs = [{ id: 'other-job', projectId: p.id, kind: 'research', lane: 'background', status: 'running', simulated: false, instruction: 'Another background job in progress.', createdAt: '2026-10-05T00:50:00.000Z' },
      { id: 'day-5', projectId: p.id, kind: 'research', lane: 'background', status: 'running', simulated: false, instruction: running.content, createdAt: '2026-10-05T01:00:00.000Z' }];
  });
  const current = () => store.state.projects.find(row => row.id === project.id), run = () => current().initiativeRuntime.sdkState.actions.find(row => row.id === 'day-5');
  return { store, controller, project, current, run, own: () => scheduledRunOwn(run()), brief: (own = scheduledRunOwn(run())) => controller.workerBrief(current(), { evidence: [], query: run().content, own }) };
}
const receiptIds = brief => brief.volatile.continuity.actionReceipts.map(row => row.actionId);
const receiptOf = (brief, id) => brief.volatile.continuity.actionReceipts.find(row => row.actionId === id);

test('T3: a scheduled run\'s brief leaves out its own receipt and pending job, and nothing older moves into their place', async t => {
  const f = await briefFixture(t), old = f.brief(null), now = f.brief();
  assert.deepEqual(receiptIds(old), ['oneoff', 'day-1', 'day-2', 'day-3', 'day-4', 'chat-1', 'chat-2', 'day-5'], 'before: the last eight actions, the run\'s own receipt last');
  assert.deepEqual(receiptIds(now), ['oneoff', 'day-1', 'day-2', 'day-3', 'day-4', 'chat-1', 'chat-2'], 'now: the same window without the own receipt; the action before it does not move up');
  assert.deepEqual(old.volatile.pendingJobs.map(row => row.id), ['other-job', 'day-5']);
  assert.deepEqual(now.volatile.pendingJobs.map(row => row.id), ['other-job'], 'another job in progress stays');
  assert.deepEqual(now.stable, old.stable);
  const { continuity, pendingJobs: _jobs, ...rest } = now.volatile, { continuity: oldContinuity, pendingJobs: _oldJobs, ...oldRest } = old.volatile;
  assert.deepEqual(rest, oldRest, 'nothing else in the brief changes');
  assert.deepEqual({ ...continuity, actionReceipts: null }, { ...oldContinuity, actionReceipts: null }, 'turns, retry and history pointers are the same');
  assert.doesNotMatch(JSON.stringify(now), /day-5/, 'the run\'s id is not in its brief');
});

test('T3: an earlier run of the schedule keeps its handoff and occurrence line; only its task excerpt, which this request carries word for word, is replaced', async t => {
  const f = await briefFixture(t), old = f.brief(null), now = f.brief(), own = f.own();
  const header = `Scheduled occurrence schedule:daily:k1\nDue: 2026-10-01T01:00:00.000Z\nTime rule: ${JSON.stringify(RULE)}\n\n`;
  assert.equal(receiptOf(now, 'day-1').intent, header + EARLIER_TASK_PLACEHOLDER, 'the occurrence line stays, the task excerpt is a statement');
  assert.equal(receiptOf(now, 'day-4').intent, `Scheduled occurrence schedule:daily:k4\nDue: 2026-10-04T01:00:00.000Z\nTime rule: ${JSON.stringify(RULE)}\n\n${EARLIER_TASK_PLACEHOLDER}`);
  assert.deepEqual({ ...receiptOf(now, 'day-1'), intent: null }, { ...receiptOf(old, 'day-1'), intent: null }, 'handoff, evidence ids, status and end time are untouched');
  assert.equal(receiptOf(now, 'day-1').handoff, 'HANDOFF_OF_day-1');
  // What it replaced is in this request: the excerpt's start is the start of this run's task, its end the end of this run's message.
  const [head, tail] = receiptOf(old, 'day-1').intent.slice(header.length).split('\n[… middle omitted; project_history can read the original …]\n');
  assert.ok(head && own.occurrence.task.startsWith(head)); assert.ok(tail && own.occurrence.content.endsWith(tail));
  // A run whose task was edited (another start), one with another host tail, and rows that are not occurrences keep what they had.
  for (const id of ['day-2', 'day-3', 'oneoff', 'chat-1', 'chat-2']) assert.deepEqual(receiptOf(now, id), receiptOf(old, id), id);
  assert.match(receiptOf(old, 'day-2').intent, /Weekly research\./); assert.doesNotMatch(receiptOf(now, 'day-1').intent, /Daily research\./);
});

// The excerpt of an earlier run shows its beginning and the message's closing text (the host's own, the same every day):
// a task that changed only in the middle is not told apart by it, and it never showed that middle either. The statement
// that replaces it must not read as "the same task"; the marker's pointer to the original stays.
test('T3: the statement for an earlier run\'s task excerpt says only what the excerpt showed, and keeps the pointer to the original', async t => {
  const f = await briefFixture(t), edit = ' MIDDLE_EDIT_THE_EXCERPT_NEVER_SHOWED. ', middleAt = 600;
  assert.ok(middleAt > 450 && middleAt < TASK.length - 400, 'the edit lies between the head and the tail an excerpt keeps');
  const changed = TASK.slice(0, middleAt) + edit + TASK.slice(middleAt);
  f.store.mutate(state => { const action = state.projects.find(row => row.id === f.project.id).initiativeRuntime.sdkState.actions.find(row => row.id === 'day-1'); action.content = occurrenceContent('schedule:daily:k1', '2026-10-01T01:00:00.000Z', changed); });
  const old = f.brief(null), now = f.brief();
  assert.doesNotMatch(receiptOf(old, 'day-1').intent, /MIDDLE_EDIT/, 'the old excerpt never showed the edit');
  assert.match(receiptOf(now, 'day-1').intent, new RegExp(`${EARLIER_TASK_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), 'the excerpt shows the same two ends as today\'s message, so it is replaced');
  // What it says: which parts were shown, that they match, that the middle was not shown, and where the original is.
  assert.match(EARLIER_TASK_PLACEHOLDER, /only its beginning and its closing text were shown here, both word for word as in this request/);
  assert.match(EARLIER_TASK_PLACEHOLDER, /its middle was not shown/);
  const pointer = EXCERPT_MARKER.match(/project_history[^…\]]*?(?= …)/)?.[0];
  assert.equal(pointer, 'project_history can read the original'); assert.ok(EARLIER_TASK_PLACEHOLDER.includes(pointer), 'the marker\'s pointer to the original stays');
  assert.doesNotMatch(EARLIER_TASK_PLACEHOLDER, /identical|same task/i, 'it does not claim the two tasks are the same');
});

test('T3: nothing is left out unless the brief is built for a scheduled occurrence, and a receipt that is not this run\'s own message stays', async t => {
  const f = await briefFixture(t), old = f.brief(null);
  assert.deepEqual(f.controller.workerBrief(f.current(), { evidence: [], query: f.run().content }), old, 'without `own` the brief is what it always was');
  assert.deepEqual([f.own()?.actionId, f.own()?.scheduleId], ['day-5', 'daily'], 'the running scheduled action is recognized');
  // A decision-started run is not a scheduled occurrence: no hostSchedule, no identity.
  assert.equal(scheduledRunOwn({ ...f.run(), hostSchedule: undefined }), null);
  assert.equal(scheduledRunOwn({ ...f.run(), content: 'Inspect the evidence.' }), null);
  // The stored message differs from the occurrence message the run was given: its receipt and job are not duplicates of it.
  const strange = { ...f.own(), occurrence: scheduledOccurrence(occurrenceContent('schedule:daily:k5', '2026-10-05T01:00:00.000Z', `${TASK} Changed.`)) }, kept = f.brief(strange);
  assert.ok(receiptIds(kept).includes('day-5')); assert.deepEqual(kept.volatile.pendingJobs.map(row => row.id), ['other-job', 'day-5']);
  // The receipt is left out only while it holds nothing but the message again: a result, tool receipts (a run resumed after a
  // pause), a failure or a blocking flag keep it.
  const change = fn => f.store.mutate(state => fn(state.projects.find(row => row.id === f.project.id)));
  const action = () => f.current().initiativeRuntime.sdkState.actions.find(row => row.id === 'day-5');
  change(p => { p.initiativeRuntime.sdkState.actions.find(row => row.id === 'day-5').resultSummary = 'PARTIAL_RESULT_OF_THE_FIRST_PASS'; });
  assert.ok(receiptIds(f.brief()).includes('day-5'), 'a result keeps it'); change(p => { delete p.initiativeRuntime.sdkState.actions.find(row => row.id === 'day-5').resultSummary; });
  change(p => { p.jobs.find(row => row.id === 'day-5').toolReceiptCounts = { total: 3, completed: 3, failed: 0, uncertain: 0 }; });
  assert.ok(receiptIds(f.brief()).includes('day-5'), 'tool receipts keep it'); change(p => { delete p.jobs.find(row => row.id === 'day-5').toolReceiptCounts; });
  change(p => { p.initiativeRuntime.sdkState.actions.find(row => row.id === 'day-5').errorCode = 'background_failed'; });
  assert.ok(receiptIds(f.brief()).includes('day-5'), 'a failure keeps it'); change(p => { delete p.initiativeRuntime.sdkState.actions.find(row => row.id === 'day-5').errorCode; });
  change(p => { p.initiativeRuntime.sdkState.actions.find(row => row.id === 'day-5').evidenceIds.push('E-from-elsewhere'); });
  assert.ok(receiptIds(f.brief()).includes('day-5'), 'an evidence id the message does not name keeps it');
  change(p => { p.initiativeRuntime.sdkState.actions.find(row => row.id === 'day-5').evidenceIds.pop(); });
  assert.ok(!receiptIds(f.brief()).includes('day-5'), 'back to a run at its first request: left out'); assert.equal(action().evidenceIds.length, 1);
  // An earlier receipt whose excerpt is not carried (this task starts differently) keeps its excerpt.
  const edited = { ...f.own(), occurrence: scheduledOccurrence(occurrenceContent('schedule:daily:k5', '2026-10-05T01:00:00.000Z', `Reworded. ${TASK}`)) };
  assert.deepEqual(receiptOf(f.brief(edited), 'day-1'), receiptOf(old, 'day-1'));
});

test('T3: the occurrence message is read the way scheduledWork composes it', () => {
  const content = occurrenceContent('schedule:daily:k1', '2026-10-01T01:00:00.000Z', TASK), parts = scheduledOccurrence(content);
  assert.equal(parts.task, TASK); assert.equal(parts.header + parts.task + parts.tail, content); assert.match(parts.header, /^Scheduled occurrence schedule:daily:k1\nDue: 2026-10-01T01:00:00.000Z\nTime rule: \{.*\}\n\n$/);
  assert.match(parts.tail, /^\n\nProduce the requested deliverable/); assert.ok(parts.tail.endsWith(SCHEDULED_DELIVERY_INSTRUCTION));
  // A task that itself quotes the host's wording is read up to the last occurrence of it: the host's own tail.
  const quoting = `${TASK}\n\nProduce the requested deliverable using current evidence and authorized tools. Quoted.`;
  assert.equal(scheduledOccurrence(occurrenceContent('k', 'd', quoting)).task, quoting);
  for (const other of ['Inspect the evidence.', '', undefined, null, 42, occurrenceContent('k', 'd', ''), `Scheduled occurrence k\nDue: d\nTime rule: {}\n\n${TASK}`]) assert.equal(scheduledOccurrence(other), null, String(other).slice(0, 40));
});

// The planning state is rebuilt from the live project for every request: it names the run's task by placeholder only while
// the schedule still says those words, so an edit after the first request reaches the model whole.
test('T3: the runtime\'s planning state follows the live schedule: placeholder while identical, the whole task once it was edited', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-brief-live-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'evidence.txt'), 'Evidence.');
  const task = `Live task. ${'Check the evidence and report it. '.repeat(8)}`.trim(), edited = `${task} EDITED_LIVE_TASK_MARK`;
  const schedule = createProjectSchedule({ id: 'daily', title: 'Daily', task, destinationSessionId: 's1', rule: RULE }), live = { id: 'project', workspace: directory, permissions: { workspace: 'read', background: 'read' }, assignments: { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] }, schedules: [schedule] };
  const requests = [], model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 64000, maxOutputTokens: 1000, reasoning: 'off' };
  const planning = request => { for (const message of request.messages.slice().reverse()) for (const part of Array.isArray(message.content) ? message.content : []) { const at = String(part.text).indexOf('\n[{"source":'); if (at < 0) continue; const found = JSON.parse(part.text.slice(at + 1)).find(item => item.source === 'project-planning-state'); if (found) return JSON.parse(found.text); } return null; };
  const handle = await createRnaRuntime({ sessionId: 'live', projectId: 'project', project: live, getProject: () => live, cwd: directory, stateDir: join(directory, 'rna'), model, permissionScope: 'background', workingContextOptions: { omitScheduleTask: { scheduleId: 'daily', task } },
    provider: async function* (request) {
      requests.push(planning(request));
      if (requests.length === 1) { live.schedules = [{ ...schedule, task: edited }]; yield { type: 'tool_call', id: 'read', name: 'project_read', arguments: { path: 'evidence.txt' } }; yield { type: 'done', stopReason: 'toolUse' }; return; }
      yield { type: 'text_delta', delta: 'done' }; yield { type: 'done', stopReason: 'stop' };
    } });
  t.after(() => handle.dispose());
  await handle.prompt(occurrenceContent('schedule:daily:k1', '2026-10-05T01:00:00.000Z', task));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].schedules[0].task, SCHEDULE_TASK_PLACEHOLDER, 'the first request: the task is named, not repeated');
  assert.equal(requests[1].schedules[0].task, edited, 'the next request: the schedule as it is now, whole');
});

// A compaction replaces the run's occurrence message by a summary, and the summary does not copy the planning state (it is
// restored verbatim next to it): from then on the planning state is the one place the task's exact words stay.
test('T3: once the run has compacted its conversation, the planning state carries the schedule\'s task whole again', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-brief-compact-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'big.txt'), 'line of evidence text that is long enough to matter. '.repeat(250));
  const MARK = 'COMPACTED_RUN_TASK_MARK', task = `Daily task (${MARK}). ${'Name the source of every number and report the measured result first. '.repeat(6)}`.trim();
  const schedule = createProjectSchedule({ id: 'daily', title: 'Daily', task, destinationSessionId: 's1', rule: RULE }), live = { id: 'project', workspace: directory, permissions: { workspace: 'read', background: 'read' }, assignments: { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] }, schedules: [schedule] };
  // A small window, so three reads of the file push the conversation over the compaction trigger.
  const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 9000, maxOutputTokens: 500, reasoning: 'off' };
  const planning = request => { for (const message of request.messages.slice().reverse()) for (const part of Array.isArray(message.content) ? message.content : []) { const at = String(part.text).indexOf('\n[{"source":'); if (at < 0) continue; const found = JSON.parse(part.text.slice(at + 1)).find(item => item.source === 'project-planning-state'); if (found) return JSON.parse(found.text); } return null; };
  const requests = [];
  const handle = await createRnaRuntime({ sessionId: 'live', projectId: 'project', project: live, getProject: () => live, cwd: directory, stateDir: join(directory, 'rna'), model, permissionScope: 'background', workingContextOptions: { omitScheduleTask: { scheduleId: 'daily', task } },
    provider: async function* (request) {
      if ((request.tools ?? []).length === 0) { requests.push({ summary: true }); yield { type: 'text_delta', delta: '## User requests\n- [in progress] produce the daily report\n## Progress\n- read big.txt' }; yield { type: 'done', stopReason: 'stop' }; return; }
      const compacted = JSON.stringify(request.messages).includes('Prior conversation summary'), state = planning(request);
      requests.push({ compacted, task: state?.schedules[0].task });
      if (!compacted && requests.length < 12) { yield { type: 'tool_call', id: `read-${requests.length}`, name: 'project_read', arguments: { path: 'big.txt' } }; yield { type: 'done', stopReason: 'toolUse' }; return; }
      yield { type: 'text_delta', delta: 'done' }; yield { type: 'done', stopReason: 'stop' };
    } });
  t.after(() => handle.dispose());
  await handle.prompt(occurrenceContent('schedule:daily:k1', '2026-10-05T01:00:00.000Z', task));
  const before = requests.filter(row => !row.summary && !row.compacted), after = requests.filter(row => row.compacted);
  assert.ok(requests.some(row => row.summary), 'the conversation compacted'); assert.ok(before.length >= 2 && after.length >= 1, JSON.stringify(requests));
  assert.ok(before.every(row => row.task === SCHEDULE_TASK_PLACEHOLDER), 'before the compaction the occurrence message holds the task: the planning state names it');
  assert.ok(after.every(row => row.task === task), 'after it the occurrence message is a summary: the planning state holds the task, whole');
});

// A run a decision started keeps the planning state it always had: the schedule's task stays in it (no occurrence message holds it).
test('T3: a decision-started background run still carries every schedule\'s task in its planning state', async t => {
  let observed;
  const app = await fixture(t, { recall: async () => ({ entries: [], content: '[]', candidateCount: 0, stage: 'none' }), provider: async function* (request) { observed = request; yield* final(); }, schedule: 'DECISION_RUN_SCHEDULE_TASK' });
  await until(() => app.current().jobs[0]?.status === 'completed');
  const wire = JSON.stringify(observed.messages);
  assert.equal(wire.split('DECISION_RUN_SCHEDULE_TASK').length - 1, 1, 'the task is in the planning state, once');
  assert.doesNotMatch(wire, /identical to the task in this request/);
});
