import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { createApiV2, projectSummary, sessionSummary } from '../api-v2.mjs';
import { backgroundActionView, backgroundWorkView, WORK_BYTES } from '../project-background-controls.mjs';
import { planView } from '../project-mind.mjs';
import { BuiltinAgentService, agentView } from '../builtin-agent-service.mjs';
import { liveBus, stepKind, toolTarget } from '../live-bus.mjs';

// Layout plan 2.3 (H1–H5): the host's progress projection for the tasks panel. summary.work (P-1), the live
// `work.step` event (P-2), plan items' owning run (P-3), subagents' model and per-conversation counts (P-4), and ISO
// action times (P-5). Everything here is computed in code; no model call decides any of it.

const SECRET = 'sk-fixture-synthetic-0001';
const NOW = Date.parse('2026-10-03T08:00:00Z'), ago = minutes => NOW - minutes * 60000, isoAgo = minutes => new Date(ago(minutes)).toISOString();
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
async function until(check, label = 'condition') { const deadline = Date.now() + 30000; while (Date.now() < deadline) { if (check()) return; await delay(10); } throw new Error(`Timed out: ${label}`); }
const hold = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bytes = value => Buffer.byteLength(JSON.stringify(value));

// ---------- a real background run (scripted providers, real SDK and tools) ----------

function decisions(fn) { return async function* (options) { const input = JSON.parse(options.messages[0].content[0].text); yield { type: 'text_delta', delta: JSON.stringify(fn(input)) }; yield { type: 'usage', usage: { input: 12, output: 8, totalTokens: 20 } }; yield { type: 'done', stopReason: 'stop' }; }; }
const decision = (input, action = 'wait', content = '') => ({ action, content, evidenceIds: [input.events.at(-1).id], reason: 'Observed a concrete project fact', nextReviewAfterMs: 60000 });

async function workFixture(t, { workProvider, workMaxSteps = 9 }) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-background-progress-'));
  const store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Isolated fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: SECRET, models: [{ id: 'fixture-model', name: 'Fixture Model', contextWindow: 64000, maxOutputTokens: 3000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project } = store.createProject({ rhythm: { control: 'manual' }, name: 'Progress', description: 'Check compatibility evidence', workspace: directory, initiative: { cooldownMs: 0 } });
  store.mutate(state => { const target = state.projects.find(row => row.id === project.id); target.decisionMode = 'rna-model'; target.simulated = false; target.initialization = { status: 'ready' }; target.overview = 'Investigate compatibility evidence'; target.assignments = { skillIds: [], toolIds: ['project_read', 'project_list', 'project_grep'], mcpServerIds: [] }; target.initiative.tokenBudget = 100000; state.settings.realTokenBudget = 200000; });
  writeFileSync(join(directory, 'evidence.txt'), 'compatibility: second input variant is missing');
  const steps = []; t.after(liveBus(store).subscribe(event => { if (event.type === 'work.step') steps.push(event); }));
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, workMaxSteps, independentLearning: true,
    decisionProvider: decisions(input => input.events.some(event => event.type === 'action_completed') ? decision(input) : decision(input, 'work', 'Read evidence.txt and report the missing case')),
    runtimeFactory: options => createRnaRuntime({ ...options, provider: workProvider }) });
  t.after(async () => { await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, controller, steps, provider, current: () => store.state.projects.find(row => row.id === project.id) };
}

test('a running background run is on the project summary with its steps, kinds, last step, tokens and model; the live steps are published', async t => {
  const gate = hold(), requests = [];
  const f = await workFixture(t, { workProvider: async function* (request) {
    requests.push(request);
    const results = request.messages.filter(message => message.role === 'toolResult').length;
    if (results === 0) {
      yield { type: 'tool_call', id: 'read1', name: 'project_read', arguments: { path: 'evidence.txt' } };
      yield { type: 'tool_call', id: 'grep1', name: 'project_grep', arguments: { query: 'compatibility', path: '.' } };
      // Refused by argument validation: it never started (no start time, no live step), but it is a counted step.
      yield { type: 'tool_call', id: 'bad1', name: 'project_grep', arguments: { pattern: 'compatibility' } };
      yield { type: 'usage', usage: { input: 12, output: 8, totalTokens: 20 } }; yield { type: 'done', stopReason: 'toolUse' }; return;
    }
    if (results === 3) {
      // A step whose target holds the provider key: the key never reaches the receipt or the live event.
      yield { type: 'tool_call', id: 'read2', name: 'project_read', arguments: { path: `missing-${SECRET}.txt` } };
      yield { type: 'usage', usage: { input: 12, output: 8, totalTokens: 20 } }; yield { type: 'done', stopReason: 'toolUse' }; return;
    }
    await gate.promise;
    yield { type: 'text_delta', delta: 'Checked evidence.txt (E2).\n交接：核对了 evidence.txt（E2），第二种输入仍缺示例，下一步用 project_history 补写示例' };
    yield { type: 'usage', usage: { input: 12, output: 8, totalTokens: 20 } }; yield { type: 'done', stopReason: 'stop' };
  } });
  // Two requests settled, the third waits: the run is live.
  await until(() => requests.length === 3 && f.current().jobs[0]?.toolReceiptCounts?.total === 4, 'third request in flight');
  const job = f.current().jobs[0];
  assert.deepEqual(job.model, { providerId: f.provider.id, modelId: 'fixture-model', name: 'Fixture Model' }, 'names only, no key or endpoint');
  assert.equal(job.stepLimit, 9);
  assert.deepEqual(job.usage, { totalTokens: 40, estimatedTokens: 0 }, 'written after each settled request, before the run finishes');
  assert.deepEqual(job.toolKindCounts, { read: 2, search: 2, edit: 0, write: 0, command: 0, web: 0, other: 0 });
  const [read1, grep1, bad1, read2] = ['read1', 'grep1', 'bad1', 'read2'].map(id => job.toolReceipts.find(row => row.toolCallId === id));
  assert.equal(read1.target, 'evidence.txt'); assert.equal(grep1.target, 'compatibility · .'); assert.equal(grep1.status, 'completed');
  assert.equal(read2.target, 'missing-[REDACTED].txt'); assert.equal(read2.status, 'failed');
  for (const row of [read1, grep1, read2]) { assert.match(row.startedAt, ISO); assert.ok(Date.parse(row.startedAt) <= Date.parse(row.at)); }
  assert.equal(bad1.status, 'failed'); assert.equal(bad1.startedAt, undefined);
  assert.ok(!JSON.stringify(f.current().jobs).includes(SECRET));

  const work = projectSummary(f.store, f.current()).work;
  assert.equal(work.recent.length, 0); assert.equal(work.running.length, 1);
  const run = work.running[0];
  assert.equal(run.id, job.id); assert.equal(run.kind, 'work'); assert.equal(run.status, 'running'); assert.equal(run.title, 'Read evidence.txt and report the missing case');
  assert.match(run.createdAt, ISO); assert.match(run.startedAt, ISO); assert.equal(run.completedAt, undefined); assert.equal(run.summary, undefined); assert.equal(run.errorCode, undefined);
  assert.deepEqual(run.steps, { total: 4, completed: 2, failed: 2, uncertain: 0, limit: 9, kinds: { read: 2, search: 2, edit: 0, write: 0, command: 0, web: 0, other: 0 } });
  assert.deepEqual(run.latest, { name: 'project_read', kind: 'read', target: 'missing-[REDACTED].txt', status: 'failed', at: read2.at });
  assert.deepEqual(run.tokens, { total: 40, estimated: false });
  assert.deepEqual(run.model, job.model); assert.equal(run.changeId, null);

  // P-2: one live step per started tool, display only, redacted like the receipt.
  assert.deepEqual(f.steps.map(event => [event.toolCallId, event.name, event.kind, event.target, event.status]), [['read1', 'project_read', 'read', 'evidence.txt', 'running'], ['grep1', 'project_grep', 'search', 'compatibility · .', 'running'], ['read2', 'project_read', 'read', 'missing-[REDACTED].txt', 'running']]);
  for (const event of f.steps) { assert.equal(event.projectId, f.current().id); assert.equal(event.actionId, job.id); assert.match(event.at, ISO); }
  assert.ok(!JSON.stringify(f.steps).includes(SECRET));

  gate.resolve();
  await until(() => f.current().jobs[0].status === 'completed', 'run finished');
  const done = projectSummary(f.store, f.current()).work;
  assert.equal(done.running.length, 0); assert.equal(done.recent.length, 1);
  const finished = done.recent[0];
  assert.equal(finished.status, 'completed'); assert.match(finished.completedAt, ISO);
  assert.deepEqual(finished.tokens, { total: 60, estimated: false });
  // The worker's handoff in the user's words: no evidence handles, no host tool names.
  assert.equal(finished.summary, '核对了 evidence.txt，第二种输入仍缺示例，下一步用补写示例');
});

test('live steps are throttled to four a second per run; the last step of a burst goes out when the window frees, the ones before it are dropped', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-background-progress-throttle-')), store = new Store(join(dir, 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A fake clock: the controller's and the timers'. advance() moves the clock first, so a timer run on the way sees the
  // time it was due at when the test advances exactly to it.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = NOW, ticked = NOW;
  const advance = to => { clock = to; t.mock.timers.tick(to - ticked); ticked = to; };
  // Only what publishStep reads: the store's live bus, the clock, the context check and the secrets to hide.
  const controller = Object.assign(Object.create(ProjectInitiativeController.prototype), { store, now: () => clock, valid: () => true, redactValues: () => [SECRET] });
  const context = { projectId: 'p1' }, events = [], sent = [];
  t.after(liveBus(store).subscribe(event => { if (event.type === 'work.step') { events.push(event); if (event.actionId === 'throttled') sent.push(clock); } }));
  const ids = () => events.map(event => event.toolCallId), steps = { times: [], pending: null, timer: null };
  const publish = (id, at, window = steps, actionId = 'throttled') => controller.publishStep(context, { id: actionId }, { toolCallId: id, toolName: 'project_exec', args: { command: `echo ${SECRET}` } }, at, window);
  const step = (id, at) => { advance(at); publish(id, at); };
  for (let index = 0; index < 6; index++) step(`a${index}`, NOW + index * 10);
  assert.deepEqual(ids(), ['a0', 'a1', 'a2', 'a3']);
  assert.equal(events[0].target, 'echo [REDACTED]'); assert.equal(events[0].kind, 'command'); assert.equal(events[0].at, new Date(NOW).toISOString());
  // a5 replaced a4 as the waiting step; it goes out once a0's second is over, with its own start time.
  advance(NOW + 999); assert.equal(events.length, 4, 'still within the same second');
  advance(NOW + 1000); assert.deepEqual(ids().slice(4), ['a5']);
  assert.equal(events[4].at, new Date(NOW + 50).toISOString(), 'when the step started, not when it was sent');
  // The event loop was busy: b1 starts when b0 is due, before b0's timer ran. It finds the freed slot and goes out at
  // once; b0, older, is not sent after it.
  step('b0', NOW + 1001); assert.equal(events.length, 5, 'the window is full again');
  clock = NOW + 1010; publish('b1', NOW + 1010); assert.deepEqual(ids().slice(5), ['b1']);
  advance(NOW + 1100); assert.deepEqual(ids().slice(5), ['b1']);
  // The run ended: the waiting step is dropped.
  for (const id of ['c0', 'c1', 'c2']) step(id, NOW + 1500);
  assert.equal(steps.pending?.toolCallId, 'c2'); controller.endSteps(steps);
  advance(NOW + 3000); assert.ok(!ids().includes('c2'));
  // Never more than four in any second, the trailing step included.
  for (const [index, at] of sent.entries()) assert.ok(sent.filter(time => time >= at && time < at + 1000).length <= 4, `the second from send ${index}`);
  // Another run has its own allowance.
  publish('o0', clock, { times: [], pending: null, timer: null }, 'other');
  assert.deepEqual([events.at(-1).actionId, events.at(-1).toolCallId], ['other', 'o0']);
  // A context revoked while a step waits sends nothing, and a revoked context publishes nothing.
  for (const id of ['d0', 'd1', 'd2', 'd3', 'd4']) step(id, NOW + 4000);
  assert.equal(steps.pending?.toolCallId, 'd4');
  controller.valid = () => false; advance(NOW + 6000); assert.ok(!ids().includes('d4'));
  step('e0', NOW + 9000); assert.notEqual(events.at(-1).toolCallId, 'e0');
});

test('a job records its run: the model by name, the step cap of ordinary work only, a scheduled run\'s occurrence, and tokens across a pause', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-background-progress-jobs-')), store = new Store(join(dir, 'private', 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { project } = store.createProject({ name: 'Jobs', workspace: dir, initiative: { enabled: false } });
  let clock = NOW;
  // Only what startJob and recordJobUsage read from the controller.
  const controller = Object.assign(Object.create(ProjectInitiativeController.prototype), { store, workMaxSteps: 64, now: () => clock, valid: () => true, redactValues: () => [SECRET], mutate: fn => store.mutate(fn) });
  const context = { projectId: project.id, coordinator: { model: { providerId: 'provider-1', modelId: 'model-a', name: 'Model A', baseUrl: 'http://127.0.0.1:1/v1', protocol: 'openai', reasoning: 'off' }, apiKey: SECRET } };
  const jobOf = id => store.state.projects.find(row => row.id === project.id).jobs.find(row => row.id === id);
  controller.startJob(context, { id: 'w', action: 'work', content: 'x', evidenceIds: [] }, 'research');
  controller.startJob(context, { id: 's', action: 'work', content: 'y', evidenceIds: [], hostSchedule: { key: 'occ-9', scheduleId: 's1', scheduleRevision: 1, destinationSessionId: 'x' } }, 'research');
  controller.startJob(context, { id: 'l', action: 'learn', content: 'z', evidenceIds: [] }, 'evolution');
  assert.deepEqual(jobOf('w').model, { providerId: 'provider-1', modelId: 'model-a', name: 'Model A' });
  assert.ok(!JSON.stringify(store.state.projects).includes(SECRET) && !JSON.stringify(jobOf('w')).includes('baseUrl'), 'never a key or an endpoint');
  assert.deepEqual([jobOf('w').stepLimit, jobOf('s').stepLimit, jobOf('l').stepLimit], [64, null, null]);
  assert.deepEqual([jobOf('s').scheduleId, jobOf('s').occurrenceKey, jobOf('w').scheduleId], ['s1', 'occ-9', undefined]);

  // Tokens after each settled request; an unchanged total writes nothing.
  controller.recordJobUsage(context, { id: 'w' }, { totalTokens: 120, estimatedTokens: 0 });
  assert.deepEqual(jobOf('w').usage, { totalTokens: 120, estimatedTokens: 0 });
  const revision = store.state.revision;
  controller.recordJobUsage(context, { id: 'w' }, { totalTokens: 120, estimatedTokens: 0 });
  assert.equal(store.state.revision, revision);
  // Paused, then resumed: the resumption counts from zero, the part before the pause stays in the run's total.
  store.mutate(state => { Object.assign(state.projects.find(row => row.id === project.id).jobs.find(row => row.id === 'w'), { status: 'paused', usage: { totalTokens: 150, estimatedTokens: 30 }, completedAt: isoAgo(1) }); });
  controller.recordJobUsage(context, { id: 'w' }, { totalTokens: 999, estimatedTokens: 0 });
  assert.equal(jobOf('w').usage.totalTokens, 150, 'a run that is not running is left as it finished');
  clock = NOW + 60000;
  controller.startJob(context, { id: 'w', action: 'work', content: 'x', evidenceIds: [], checkpoint: { sessionId: 'w' } }, 'research');
  assert.deepEqual([jobOf('w').status, jobOf('w').resumedAt, jobOf('w').usage, jobOf('w').completedAt], ['running', new Date(NOW + 60000).toISOString(), undefined, undefined]);
  assert.deepEqual(jobOf('w').priorUsage, { totalTokens: 150, estimatedTokens: 30 });
  controller.recordJobUsage(context, { id: 'w' }, { totalTokens: 40, estimatedTokens: 0 });
  const run = backgroundWorkView({ ...store.state.projects.find(row => row.id === project.id), initiativeRuntime: { sdkState: { actions: [{ id: 'w', action: 'work', status: 'running', content: 'x', evidenceIds: [], createdAt: NOW }] } } }, { now: NOW }).running[0];
  assert.deepEqual(run.tokens, { total: 190, estimated: true });
  assert.equal(run.resumedAt, new Date(NOW + 60000).toISOString()); assert.equal(run.startedAt, new Date(NOW).toISOString());
});

// ---------- summary.work from recorded state (P-1) ----------

const MODEL = { providerId: 'provider-1', modelId: 'model-a', name: 'Model A' };
const receipt = (index, fields = {}) => ({ toolCallId: `call-${index}`, toolName: 'project_read', target: `src/file-${index}.ts`, startedAt: isoAgo(30 - index), at: isoAgo(29 - index), status: 'completed', output: 'x'.repeat(500), resultHash: 'h', recordedByHost: true, ...fields });
function recordedProject() {
  const action = (id, status, fields = {}) => ({ id, action: 'work', status, content: `Task ${id}`, evidenceIds: [], createdAt: ago(120), ...fields });
  const job = (id, status, fields = {}) => ({ id, kind: 'research', status, lane: 'background', simulated: false, instruction: `Task ${id}`, createdAt: isoAgo(100), model: MODEL, stepLimit: 64, usage: { totalTokens: 1000, estimatedTokens: 0 }, ...fields });
  return {
    id: 'p1', name: 'Recorded',
    schedules: [{ id: 's1', title: '晨报', enabled: false, nextRunAt: null, rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }],
    scheduleRuntime: { occurrences: [
      { key: 'occ-1', scheduleId: 's1', status: 'running', actionId: 'sched-run', claimedAt: isoAgo(10) },
      { key: 'occ-2', scheduleId: 's1', status: 'queued', actionId: 'sched-waiting', claimedAt: isoAgo(2) },
    ] },
    backgroundChanges: [{ id: 'change-old', actionId: 'done-1', at: isoAgo(50), status: 'kept', files: [] }, { id: 'change-new', actionId: 'done-1', at: isoAgo(40), status: 'kept', files: [] }],
    initiativeRuntime: { sdkState: { actions: [
      action('live', 'running', { title: '重写第 11 章', startedAt: ago(20) }),
      action('waiting', 'queued', { title: '整理大纲', createdAt: ago(5) }),
      action('paused', 'paused', { title: '核对人名', startedAt: ago(60) }),
      action('review', 'needs_review', { title: '运行测试', startedAt: ago(90), blocksExecution: true, errorCode: 'uncertain_tool' }),
      action('sched-run', 'running', { content: 'Scheduled occurrence occ-1\nDue: …\n\n写晨报\n\nProduce the requested deliverable …', hostSchedule: { key: 'occ-1', scheduleId: 's1', scheduleRevision: 1, destinationSessionId: 'x' }, startedAt: ago(10) }),
      action('done-1', 'completed', { title: '写第 10 章', startedAt: ago(50), finishedAt: ago(30), handoff: '写完第 10 章（E4），project_history 里有细节，下一步写第 11 章' }),
      action('failed-1', 'failed', { title: '抓取资料', startedAt: ago(70), finishedAt: ago(65), errorCode: 'idle_timeout', failure: { code: 'idle_timeout', message: 'x' } }),
      action('stopped-1', 'cancelled', { title: '润色', startedAt: ago(80), finishedAt: ago(75), cancellationReason: 'action_control' }),
      action('old', 'completed', { title: '很久以前', startedAt: ago(60 * 30), finishedAt: ago(60 * 25) }),
      action('revoked', 'completed', { contextRevoked: true, content: 'Previous project scope; retained only as an action receipt.', startedAt: ago(45), finishedAt: ago(44) }),
      action('revoked-unnamed', 'completed', { contextRevoked: true, content: 'Previous project scope; retained only as an action receipt.', finishedAt: ago(43) }),
      action('deleted', 'completed', { title: '来自已删除对话', sourceDeleted: true, finishedAt: ago(42) }),
      action('share-1', 'completed', { action: 'share', content: '分享', finishedAt: ago(41) }),
      action('learn-1', 'completed', { action: 'learn', content: '改进写作方法的检查清单', finishedAt: ago(35), handoff: '学习候选通过冻结评测，可提供试用：x' }),
    ] } },
    jobs: [
      job('live', 'running', { toolReceiptCounts: { total: 3, completed: 2, failed: 1, uncertain: 0 }, toolKindCounts: { read: 1, search: 0, edit: 1, write: 0, command: 1, web: 0, other: 0 }, toolReceipts: [receipt(1), receipt(2, { toolName: 'project_exec', target: 'npm test', status: 'failed' })], priorUsage: { totalTokens: 500, estimatedTokens: 0 }, usage: { totalTokens: 1000, estimatedTokens: 200 }, resumedAt: isoAgo(15) }),
      job('paused', 'paused', { completedAt: isoAgo(55) }),
      job('review', 'interrupted'),
      job('sched-run', 'running', { createdAt: isoAgo(10), stepLimit: null, scheduleId: 's1', occurrenceKey: 'occ-1' }),
      job('done-1', 'completed', { completedAt: isoAgo(30), handoff: '写完第 10 章（E4），project_history 里有细节，下一步写第 11 章', toolReceipts: [receipt(5)] }),
      job('failed-1', 'failed', { errorCode: 'idle_timeout', toolReceipts: [receipt(6, { toolName: 'web_fetch', target: 'https://example.com/a', status: 'failed' })] }),
      job('revoked', 'completed', { title: '上一轮的检查', handoff: '检查完毕' }),
      // A finished run whose action left the SDK state: the job alone is the record. Legacy: no kind counts yet.
      job('archived', 'completed', { title: '归档的工作', completedAt: isoAgo(20), handoff: '整理完毕', toolReceiptCounts: { total: 5, completed: 5, failed: 0, uncertain: 0 }, toolReceipts: [receipt(3), receipt(4, { toolName: 'web_fetch', target: 'https://example.com' })] }),
      job('archived-revoked', 'completed', { contextRevoked: true, completedAt: isoAgo(19) }),
      job('learn-1', 'completed', { kind: 'evolution', stepLimit: null, completedAt: isoAgo(35) }),
    ],
  };
}

test('summary.work lists live runs by state and the last day\'s finished runs newest first, from actions, jobs and occurrences', () => {
  const work = backgroundWorkView(recordedProject(), { now: NOW, language: 'zh' });
  // Queued runs in the order they run: the oldest first.
  assert.deepEqual(work.running.map(run => [run.id, run.status]), [['sched-run', 'running'], ['live', 'running'], ['review', 'needs_review'], ['paused', 'paused'], ['waiting', 'queued'], ['sched-waiting', 'queued']]);
  // Finished within the day, newest first. The fixture fills the field's budget, so its oldest finished run may be left
  // out (the budget test covers that); it is read from a slimmer view below.
  const finished = [['archived', 'completed'], ['done-1', 'completed'], ['learn-1', 'completed'], ['revoked', 'completed'], ['failed-1', 'failed'], ['stopped-1', 'cancelled']];
  assert.ok(work.recent.length >= 5); assert.deepEqual(work.recent.map(run => [run.id, run.status]), finished.slice(0, work.recent.length));
  const byId = Object.fromEntries([...work.running, ...work.recent].map(run => [run.id, run]));

  const live = byId.live;
  assert.equal(live.title, '重写第 11 章'); assert.equal(live.kind, 'work');
  assert.equal(live.createdAt, isoAgo(120)); assert.equal(live.startedAt, isoAgo(100), 'the run started when its job did'); assert.equal(live.resumedAt, isoAgo(15));
  assert.deepEqual(live.steps, { total: 3, completed: 2, failed: 1, uncertain: 0, limit: 64, kinds: { read: 1, search: 0, edit: 1, write: 0, command: 1, web: 0, other: 0 } });
  assert.deepEqual(live.latest, { name: 'project_exec', kind: 'command', target: 'npm test', status: 'failed', at: isoAgo(27) });
  assert.deepEqual(live.tokens, { total: 1500, estimated: true }, 'the part before a pause counts');
  assert.deepEqual(live.model, MODEL);

  // A scheduled run: named by its schedule alone (its kind says it is scheduled), no step cap, its occurrence.
  const scheduled = byId['sched-run'];
  assert.equal(scheduled.kind, 'scheduled'); assert.equal(scheduled.title, '晨报'); assert.equal(scheduled.scheduleId, 's1'); assert.equal(scheduled.occurrenceKey, 'occ-1'); assert.equal(scheduled.steps.limit, null);
  const claimed = byId['sched-waiting'];
  assert.deepEqual([claimed.kind, claimed.title, claimed.status, claimed.createdAt, claimed.occurrenceKey, claimed.latest, claimed.model], ['scheduled', '晨报', 'queued', isoAgo(2), 'occ-2', null, null]);
  assert.deepEqual(byId.waiting.steps, { total: 0, completed: 0, failed: 0, uncertain: 0, limit: null, kinds: { read: 0, search: 0, edit: 0, write: 0, command: 0, web: 0, other: 0 } });
  assert.equal(byId.review.status, 'needs_review', 'waiting for the user is live work, not interrupted');
  for (const run of work.running) { assert.equal(run.summary, undefined); assert.equal(run.errorCode, undefined); assert.equal(run.completedAt, undefined); }

  const done = byId['done-1'];
  assert.equal(done.completedAt, isoAgo(30)); assert.equal(done.changeId, 'change-new', 'its latest change set');
  assert.equal(done.summary, '写完第 10 章，里有细节，下一步写第 11 章');
  assert.equal(done.errorCode, undefined);
  assert.equal(done.latest, null, 'a completed run reads by its result');
  assert.equal(byId['failed-1'].errorCode, 'idle_timeout'); assert.equal(byId['failed-1'].summary, undefined);
  assert.deepEqual(byId['failed-1'].latest, { name: 'web_fetch', kind: 'web_fetch', target: 'https://example.com/a', status: 'failed', at: isoAgo(23) }, 'a failed run keeps where it stopped');
  assert.equal(backgroundWorkView({ ...recordedProject(), jobs: [] }, { now: NOW }).recent.find(run => run.id === 'stopped-1').errorCode, 'action_control');
  // A revoked action is named from what the host kept for the user; one with nothing kept is left out.
  assert.equal(byId.revoked.title, '上一轮的检查'); assert.equal(byId.revoked.summary, '检查完毕');
  assert.equal(byId['revoked-unnamed'], undefined);
  assert.equal(byId.deleted, undefined, 'a result from a deleted conversation is left out');
  assert.equal(byId['share-1'], undefined, 'a delivery is not a run');
  assert.equal(byId.old, undefined, 'finished more than a day ago');
  assert.equal(byId['archived-revoked'], undefined);
  // A job whose action was archived; recorded before kinds were counted: its retained receipts, the rest as other.
  assert.equal(byId.archived.title, '归档的工作'); assert.equal(byId.archived.kind, 'work');
  assert.deepEqual(byId.archived.steps.kinds, { read: 1, search: 0, edit: 0, write: 0, command: 0, web: 1, other: 3 });
  // A learning run: its handoff is the host's evaluation receipt, not a result line.
  assert.equal(byId['learn-1'].kind, 'learn'); assert.equal(byId['learn-1'].summary, undefined); assert.equal(byId['learn-1'].steps.limit, null);
  for (const run of [...work.running, ...work.recent]) for (const key of ['createdAt', 'startedAt', 'resumedAt', 'completedAt']) if (run[key] !== undefined) assert.match(run[key], ISO, `${run.id}.${key}`);
  assert.ok(!JSON.stringify(work).includes('"output"') && !JSON.stringify(work).includes('toolReceipts'), 'no receipts or output text');
});

test('summary.work names runs in the interface language and leaves the occurrence and change set out when there are none', () => {
  const project = recordedProject();
  project.schedules = [];
  project.initiativeRuntime.sdkState.actions.push({ id: 'blank', action: 'work', status: 'queued', content: '', evidenceIds: [], createdAt: ago(1) });
  const work = backgroundWorkView(project, { now: NOW, language: 'en' });
  const byId = Object.fromEntries([...work.running, ...work.recent].map(run => [run.id, run]));
  assert.equal(byId.blank.title, 'Background work');
  // The schedule was deleted since: the run is named by the task it was given.
  assert.equal(byId['sched-run'].title, '写晨报');
  assert.equal(byId['sched-waiting'].title, 'Scheduled task');
  assert.equal(byId.live.scheduleId, undefined); assert.equal(byId.live.occurrenceKey, undefined);
});

test('a run card counts its plan items: the todo rows it staged or finished, all of them, dropped ones left out', () => {
  const project = recordedProject();
  const todo = (id, status, fields = {}) => ({ id, kind: 'todo', text: `计划 ${id}`, status, ...(status === 'open' ? { stage: 'next' } : {}), updatedAt: isoAgo(5), ...fields });
  const by = actionId => ({ kind: 'background', actionId }), finished = actionId => ({ kind: 'background', actionId, at: isoAgo(4) });
  project.mind = { agenda: [
    todo('t1', 'open', { stage: 'doing', stagedBy: by('live') }), todo('t2', 'open', { stagedBy: by('live') }),
    // Staged by one run and finished by another: it counts for both.
    todo('t3', 'done', { stagedBy: by('done-1'), resolvedBy: finished('live') }),
    todo('t4', 'dropped', { stagedBy: by('live'), resolvedBy: { kind: 'agent', at: isoAgo(3) } }),
    // Finished by a run, then reopened in the conversation: the old finish no longer makes it that run's.
    todo('t5', 'open', { stagedBy: { kind: 'agent' }, resolvedBy: finished('paused') }),
    { id: 'i1', kind: 'intention', text: '不是计划项', status: 'open', stagedBy: by('live') },
    // More finished rows than summary.plan lists (3): all of them count.
    ...['d1', 'd2', 'd3', 'd4'].map(id => todo(id, 'done', { stagedBy: by('done-1'), resolvedBy: { kind: 'agent', sessionId: 's1', at: isoAgo(2) } })),
  ] };
  const work = backgroundWorkView(project, { now: NOW });
  const byId = Object.fromEntries([...work.running, ...work.recent].map(run => [run.id, run]));
  assert.deepEqual(byId.live.plan, { done: 1, total: 3 });
  assert.deepEqual(byId['done-1'].plan, { done: 5, total: 5 });
  assert.equal(byId.paused.plan, null); assert.equal(byId.waiting.plan, null, 'no row belongs to it');
  assert.equal(backgroundWorkView({ ...project, mind: undefined }, { now: NOW }).running.find(run => run.id === 'live').plan, null);
  assert.equal(JSON.stringify(backgroundWorkView(project, { now: NOW + 60000 })), JSON.stringify(work), 'nothing in it ticks');
});

test('a run carries the user\'s marks on it, so a result they already settled is not flagged again; unmarked runs carry none', () => {
  const project = recordedProject();
  project.taskMarks = { waiting: { needsUser: true, acknowledgedAt: isoAgo(1) } };
  const work = backgroundWorkView(project, { now: NOW });
  const byId = Object.fromEntries([...work.running, ...work.recent].map(run => [run.id, run]));
  assert.deepEqual(byId.waiting.attention, { needsUser: true, acknowledgedAt: isoAgo(1) });
  assert.equal('attention' in byId.live, false);
  project.taskMarks.waiting.needsUser = false;
  assert.equal(byId.waiting.attention.needsUser, true, 'a copy, not the stored marks');
});

test('a queued run stopped before it started is a finished run, timed by its stop; of a long queue the runs next to execute are kept', () => {
  const project = recordedProject(), actions = project.initiativeRuntime.sdkState.actions;
  const stop = minutes => ({ id: `stop-${minutes}`, kind: 'cancel', status: 'applied', revision: 1, expectedRevision: 0, createdAt: ago(minutes), settledAt: ago(minutes), summary: 'Cancelled before dispatch or at a retained checkpoint' });
  // Stopped from the panel while queued: the SDK settles it at once and records the time on the stop only.
  actions.push({ id: 'queued-stopped', action: 'work', status: 'cancelled', title: '排队时停止', content: 'x', evidenceIds: [], createdAt: ago(12), cancellationReason: 'action_control', controlRevision: 1, controls: [stop(3)] });
  // Cancelled by the SDK itself (a scope change): no time at all; put off once, so its last dispatch attempt stands in.
  actions.push({ id: 'queued-dropped', action: 'work', status: 'cancelled', title: '被撤下', content: 'x', evidenceIds: [], createdAt: ago(9), startedAt: ago(7), deferredReason: 'foreground_busy', cancellationReason: 'paused' });
  // Paused at a checkpoint and then stopped: the time of the stop, not of the pause.
  Object.assign(actions.find(row => row.id === 'paused'), { status: 'cancelled', cancellationReason: 'action_control', controls: [stop(6)] });
  const work = backgroundWorkView(project, { now: NOW });
  assert.deepEqual(work.recent.map(run => run.id).slice(0, 4), ['queued-stopped', 'paused', 'queued-dropped', 'archived']);
  const byId = Object.fromEntries(work.recent.map(run => [run.id, run]));
  assert.deepEqual(['completedAt', 'startedAt', 'errorCode', 'status'].map(key => byId['queued-stopped'][key]), [isoAgo(3), undefined, 'action_control', 'cancelled']);
  assert.deepEqual(['completedAt', 'startedAt', 'errorCode'].map(key => byId['queued-dropped'][key]), [isoAgo(7), undefined, 'paused'], 'never started: no start time');
  assert.deepEqual([byId.paused.completedAt, byId.paused.startedAt], [isoAgo(6), isoAgo(100)]);
  assert.equal(JSON.stringify(backgroundWorkView(project, { now: NOW + 60000 })), JSON.stringify(work), 'nothing in it ticks');

  // Fourteen queued behind four live runs: twelve rows, and the queued ones kept are those the SDK runs next.
  const queue = recordedProject();
  for (let index = 0; index < 12; index++) queue.initiativeRuntime.sdkState.actions.push({ id: `q-${String(index).padStart(2, '0')}`, action: 'work', status: 'queued', title: `排队 ${index}`, content: 'x', evidenceIds: [], createdAt: ago(60 - index) });
  const running = backgroundWorkView(queue, { now: NOW }).running;
  assert.deepEqual(running.map(run => run.id), ['sched-run', 'live', 'review', 'paused', 'q-00', 'q-01', 'q-02', 'q-03', 'q-04', 'q-05', 'q-06', 'q-07']);
});

test('a run paused before steps were counted by kind resumes with its earlier steps counted, so the kinds add up to the total', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-background-progress-legacy-')), store = new Store(join(dir, 'private', 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { project } = store.createProject({ name: 'Legacy', workspace: dir, initiative: { enabled: false } });
  // Recorded by an earlier version: five steps counted, two receipts kept, no kind counts.
  store.mutate(state => { state.projects.find(row => row.id === project.id).jobs.push({ id: 'legacy', kind: 'research', status: 'running', lane: 'background', simulated: false, createdAt: isoAgo(30),
    toolReceiptCounts: { total: 5, completed: 5, failed: 0, uncertain: 0 }, toolReceipts: [receipt(1), receipt(2, { toolName: 'web_fetch', target: 'https://example.com' })] }); });
  const controller = Object.assign(Object.create(ProjectInitiativeController.prototype), { store, now: () => NOW, valid: () => true, redactValues: () => [SECRET], mutate: fn => store.mutate(fn) });
  controller.recordToolReceipt({ projectId: project.id }, { id: 'legacy' }, { toolCallId: 'after-upgrade', toolName: 'project_exec', args: { command: 'npm test' }, result: { content: [{ type: 'text', text: 'ok' }] } });
  const job = store.state.projects.find(row => row.id === project.id).jobs.find(row => row.id === 'legacy');
  assert.deepEqual(job.toolReceiptCounts, { total: 6, completed: 6, failed: 0, uncertain: 0 });
  assert.deepEqual(job.toolKindCounts, { read: 1, search: 0, edit: 0, write: 0, command: 1, web: 1, other: 3 });
  // Recorded with neither receipts nor kinds: every counted step is other.
  const run = backgroundWorkView({ id: 'p', jobs: [{ id: 'bare', kind: 'research', status: 'running', lane: 'background', createdAt: isoAgo(5), toolReceiptCounts: { total: 4, completed: 4, failed: 0, uncertain: 0 } }] }, { now: NOW }).running[0];
  assert.deepEqual(run.steps.kinds, { read: 0, search: 0, edit: 0, write: 0, command: 0, web: 0, other: 4 });
});

// A project with live runs and a day of finished ones; `heavy`: every name, result and target at its longest.
function busyProject({ live, finished, heavy }) {
  const long = (prefix, length) => `${prefix}${'长'.repeat(length)}`;
  const project = { id: 'busy', schedules: [], initiativeRuntime: { sdkState: { actions: [] } }, jobs: [], backgroundChanges: [] };
  const add = (id, status, minutes, index) => {
    project.initiativeRuntime.sdkState.actions.push({ id: `${id}-6f0c7f0e-8a3b-4c1e-9a77`, action: 'work', status, title: heavy ? long(`${id} `, 120) : '核对第二种输入的兼容性说明', content: 'x', evidenceIds: [], createdAt: ago(minutes + 5), startedAt: ago(minutes + 4), ...(['completed', 'failed'].includes(status) ? { finishedAt: ago(minutes) } : {}), ...(status === 'failed' ? { errorCode: 'idle_timeout' } : {}) });
    project.jobs.push({ id: `${id}-6f0c7f0e-8a3b-4c1e-9a77`, kind: 'research', status, lane: 'background', simulated: false, createdAt: isoAgo(minutes + 4), stepLimit: 64,
      model: heavy ? { providerId: '0b5e6f2a-7c1d-4e8f-9a2b-3c4d5e6f7a8b', modelId: 'deepseek-reasoner-2026-09', name: 'DeepSeek Reasoner' } : { providerId: 'deepseek', modelId: 'deepseek-chat', name: 'DeepSeek V3' },
      usage: { totalTokens: 123456, estimatedTokens: 0 }, toolReceiptCounts: { total: 48, completed: 45, failed: 2, uncertain: 1 }, toolKindCounts: { read: 20, search: 8, edit: 6, write: 4, command: 7, web: 2, other: 1 },
      toolReceipts: Array.from({ length: 12 }, (_, step) => receipt(step, { target: heavy ? `packages/sdk/src/very/deep/directory/structure/${'segment-'.repeat(20)}${step}.mjs` : 'npm test -- --run src/lib' })),
      handoff: heavy ? long('交接内容', 400) : '核对了第二种输入的兼容性说明，结论写在 evidence.txt，下一步补一个示例并重测', output: 'y'.repeat(6000), ...(status === 'completed' ? { completedAt: isoAgo(minutes) } : {}) });
    if (heavy || index % 2 === 0) project.backgroundChanges.push({ id: `change-${id}-0d6b8f5f1a2b`, actionId: `${id}-6f0c7f0e-8a3b-4c1e-9a77`, at: isoAgo(minutes), status: 'kept', files: [] });
  };
  live.forEach((status, index) => add(`run-${index}`, status, index + 1, index));
  for (let index = 0; index < finished; index++) add(`done-${String(index).padStart(2, '0')}`, index % 4 === 3 ? 'failed' : 'completed', 10 + index * 30, index);
  return project;
}

test('summary.work stays within its budget for a busy project: the oldest finished runs go first', () => {
  const work = backgroundWorkView(busyProject({ live: ['running', 'needs_review', 'queued'], finished: 12, heavy: true }), { now: NOW, language: 'zh' });
  const size = bytes(work);
  assert.ok(size <= WORK_BYTES && size < 6 * 1024, `summary.work is ${size} bytes`);
  assert.deepEqual(work.running.map(run => run.id.slice(0, 5)), ['run-0', 'run-1', 'run-2'], 'live runs are kept');
  assert.ok(work.recent.length >= 1 && work.recent.length < 8, `${work.recent.length} finished runs fit`);
  assert.deepEqual(work.recent.map(run => run.id.slice(0, 7)), ['done-00', 'done-01', 'done-02', 'done-03', 'done-04', 'done-05', 'done-06', 'done-07'].slice(0, work.recent.length), 'the newest are the ones kept');
  for (const run of [...work.running, ...work.recent]) { assert.ok(run.title.length <= 80); assert.ok(!run.summary || run.summary.length <= 160); assert.ok(!run.latest?.target || run.latest.target.length <= 80); }
  // Usual names and results: a live run and six finished ones fit whole.
  const usual = backgroundWorkView(busyProject({ live: ['running'], finished: 6, heavy: false }), { now: NOW, language: 'zh' });
  assert.equal(usual.running.length, 1); assert.equal(usual.recent.length, 6);
  assert.ok(bytes(usual) <= WORK_BYTES, `summary.work is ${bytes(usual)} bytes`);
  // Small runs: at most eight finished ones, the newest.
  const small = busyProject({ live: [], finished: 12, heavy: false });
  for (const job of small.jobs) { delete job.toolReceipts; delete job.handoff; delete job.model; }
  const capped = backgroundWorkView(small, { now: NOW, language: 'zh' });
  assert.deepEqual(capped.recent.map(run => run.id.slice(0, 7)), ['done-00', 'done-01', 'done-02', 'done-03', 'done-04', 'done-05', 'done-06', 'done-07']);
});

test('an unchanged run keeps the project summary\'s hash; a new step changes it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-background-progress-hash-')), store = new Store(join(dir, 'private', 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { project } = store.createProject({ name: 'Hash', workspace: dir, initiative: { enabled: false } });
  const recorded = recordedProject();
  store.mutate(state => { const target = state.projects.find(row => row.id === project.id); for (const key of ['schedules', 'scheduleRuntime', 'backgroundChanges', 'initiativeRuntime', 'jobs']) target[key] = recorded[key]; });
  const current = () => store.state.projects.find(row => row.id === project.id), work = now => JSON.stringify(projectSummary(store, current(), { now }).work);
  const first = work(NOW);
  assert.equal(work(NOW + 5 * 60000), first, 'nothing in it ticks with the clock');
  assert.equal(work(NOW + 60 * 60000), first);
  store.mutate(state => { const job = state.projects.find(row => row.id === project.id).jobs.find(row => row.id === 'live'); job.toolReceipts = [...job.toolReceipts, receipt(9, { target: 'src/new.ts' })]; job.toolReceiptCounts = { ...job.toolReceiptCounts, total: 4, completed: 3 }; });
  assert.notEqual(work(NOW), first);
  // So does a plan item the run stages or finishes.
  const second = work(NOW);
  store.mutate(state => { const target = state.projects.find(row => row.id === project.id); target.mind ??= {}; (target.mind.agenda ??= []).push({ id: 'p1', kind: 'todo', text: '写第 11 章', status: 'open', stage: 'doing', stagedBy: { kind: 'background', actionId: 'live' }, createdAt: isoAgo(1), updatedAt: isoAgo(1), source: { kind: 'background', actionId: 'live' }, evidence: [] }); });
  assert.notEqual(work(NOW), second); assert.equal(work(NOW + 5 * 60000), work(NOW));
  assert.deepEqual(JSON.parse(work(NOW)).running.find(run => run.id === 'live').plan, { done: 0, total: 1 });
  // A finished run leaves `recent` once it is more than a day old.
  assert.ok(JSON.parse(work(NOW + 24 * 3600000 - 60 * 60000)).recent.some(run => run.id === 'done-1'));
  assert.ok(!JSON.parse(work(NOW + 24 * 3600000)).recent.some(run => run.id === 'done-1'));
});

test('a scheduled run put off while the conversation works has not started, and its retries leave the summary as it was', () => {
  const project = recordedProject();
  const deferred = (at) => ({ id: 'sched-deferred', action: 'work', status: 'queued', content: 'Scheduled occurrence occ-3\nDue: …\n\n写晨报\n\nProduce the requested deliverable …', evidenceIds: [], hostSchedule: { key: 'occ-3', scheduleId: 's1', scheduleRevision: 1, destinationSessionId: 'x' }, createdAt: ago(3), startedAt: at, nextAttemptAt: at + 1000, deferredReason: 'foreground_busy' });
  project.initiativeRuntime.sdkState.actions.push(deferred(ago(1)));
  const first = backgroundWorkView(project, { now: NOW });
  const run = first.running.find(row => row.id === 'sched-deferred');
  assert.deepEqual([run.status, run.createdAt, run.startedAt, run.title], ['queued', isoAgo(3), undefined, '晨报']);
  // The host retries the dispatch every second; each attempt stamps the action again.
  project.initiativeRuntime.sdkState.actions[project.initiativeRuntime.sdkState.actions.length - 1] = deferred(ago(1) + 1000);
  assert.equal(JSON.stringify(backgroundWorkView(project, { now: NOW + 1000 })), JSON.stringify(first));
  // A run resumed after a pause and waiting to continue did start: its job says when.
  assert.equal(first.running.find(row => row.id === 'paused').startedAt, isoAgo(100));
});

test('runs that finished more than a day ago are not named or measured', () => {
  const project = recordedProject();
  let reads = 0;
  const old = { id: 'old-many', action: 'work', status: 'completed', content: 'x', evidenceIds: [], createdAt: ago(60 * 40), startedAt: ago(60 * 40), finishedAt: ago(60 * 39) };
  Object.defineProperty(old, 'title', { enumerable: true, get: () => { reads++; return '很久以前做完的'; } });
  project.initiativeRuntime.sdkState.actions.push(old);
  const work = backgroundWorkView(project, { now: NOW });
  assert.equal(reads, 0);
  assert.ok(![...work.running, ...work.recent].some(run => run.id === 'old-many'));
});

// ---------- P-5: ISO action times ----------

test('the action view gives a live action\'s times as ISO instants (H1)', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-background-progress-times-')), store = new Store(join(dir, 'private', 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { project } = store.createProject({ name: 'Times', workspace: dir, initiative: { enabled: false } });
  store.mutate(state => { state.projects.find(row => row.id === project.id).initiativeRuntime = { sdkState: { actions: [
    { id: 'a', action: 'work', status: 'completed', content: 'x', evidenceIds: [], createdAt: ago(10), startedAt: ago(9), finishedAt: ago(1) },
    { id: 'b', action: 'work', status: 'queued', content: 'y', evidenceIds: [], createdAt: ago(2) },
  ] } }; });
  const view = backgroundActionView({ store, project: id => store.state.projects.find(row => row.id === id), contexts: new Map(), valid: () => false }, project.id);
  const [a, b] = view.actions;
  assert.deepEqual([a.createdAt, a.startedAt, a.finishedAt], [isoAgo(10), isoAgo(9), isoAgo(1)]);
  assert.equal(b.createdAt, isoAgo(2)); assert.equal(Object.hasOwn(b, 'startedAt'), false); assert.equal(Object.hasOwn(b, 'finishedAt'), false);
  assert.equal(typeof store.state.projects.find(row => row.id === project.id).initiativeRuntime.sdkState.actions[0].createdAt, 'number', 'the stored record is unchanged');
});

test('a scheduled run in the action view carries its occurrence, also one the project row leaves out (交付 stage)', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-background-progress-occurrence-')), store = new Store(join(dir, 'private', 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { project } = store.createProject({ name: 'Hourly', workspace: dir, initiative: { enabled: false } });
  // An hourly schedule: 12 runs in the last day, each completed and delivered; the row's `work` lists the newest 8.
  const actions = [], jobs = [], occurrences = [];
  for (let i = 0; i < 12; i++) {
    const at = ago((12 - i) * 60), key = `hourly:${new Date(at).toISOString()}`, id = `schedule-work-${i}`, deliveryId = `schedule-delivery-${i}`;
    actions.push({ id, action: 'work', status: 'completed', content: 'Report the hour.', evidenceIds: [], createdAt: at, startedAt: at + 1000, finishedAt: at + 60000, hostSchedule: { key, scheduleId: 'hourly' } });
    actions.push({ id: deliveryId, action: 'share', status: 'completed', content: 'Hourly report.', evidenceIds: [], createdAt: at + 61000, finishedAt: at + 62000, hostSchedule: { key, scheduleId: 'hourly' } });
    jobs.push({ id, lane: 'background', kind: 'work', status: 'completed', createdAt: new Date(at + 1000).toISOString(), completedAt: new Date(at + 60000).toISOString() });
    occurrences.push({ key, scheduleId: 'hourly', scheduledAt: new Date(at).toISOString(), status: 'delivered', deliveredAt: new Date(at + 63000).toISOString(), deliveryItemId: `item-${i}`, actionId: id, deliveryActionId: deliveryId, claimedAt: new Date(at).toISOString() });
  }
  occurrences.push({ key: 'hourly:failed', scheduleId: 'hourly', scheduledAt: isoAgo(30), status: 'failed', errorCode: 'provider_timeout', actionId: 'schedule-work-failed' });
  actions.push({ id: 'schedule-work-failed', action: 'work', status: 'failed', content: 'Report the hour.', evidenceIds: [], createdAt: ago(30), finishedAt: ago(29), hostSchedule: { key: 'hourly:failed', scheduleId: 'hourly' } }, { id: 'plain', action: 'work', status: 'completed', content: 'x', evidenceIds: [], createdAt: ago(5), finishedAt: ago(4) });
  store.mutate(state => { Object.assign(state.projects.find(row => row.id === project.id), { schedules: [{ id: 'hourly', title: 'Hourly report', task: 'Report the hour.', enabled: true, rule: { kind: 'interval', everyMs: 3600000 }, destinationSessionId: null, nextRunAt: new Date(NOW + 1800000).toISOString(), source: 'user', revision: 1 }], scheduleRuntime: { schemaVersion: 1, occurrences }, initiativeRuntime: { sdkState: { actions } }, jobs }); });
  const live = store.state.projects.find(row => row.id === project.id);
  const row = projectSummary(store, live, { now: NOW }), kept = new Set(row.scheduleRuntime.occurrences.map(item => item.actionId));
  assert.ok(['schedule-work-0', 'schedule-work-1', 'schedule-work-2', 'schedule-work-3'].every(id => !kept.has(id)), 'the row leaves the oldest runs\' occurrences out (precondition)');
  const view = backgroundActionView({ store, project: id => store.state.projects.find(item => item.id === id), contexts: new Map(), valid: () => false }, project.id);
  const of = id => view.actions.find(action => action.id === id);
  for (let i = 0; i < 12; i++) assert.deepEqual(of(`schedule-work-${i}`).occurrence, { key: occurrences[i].key, status: 'delivered', deliveredAt: occurrences[i].deliveredAt });
  assert.deepEqual(of('schedule-delivery-0').occurrence, of('schedule-work-0').occurrence, 'its delivery action points at the same occurrence');
  assert.deepEqual(of('schedule-work-failed').occurrence, { key: 'hourly:failed', status: 'failed' });
  assert.equal(Object.hasOwn(of('plain'), 'occurrence'), false, 'an unscheduled run has none');
  // A run whose occurrence the host no longer keeps says so (null), rather than leaving the panel to guess.
  store.mutate(state => { state.projects.find(item => item.id === project.id).scheduleRuntime.occurrences.splice(0, 1); });
  assert.equal(backgroundActionView({ store, project: id => store.state.projects.find(item => item.id === id), contexts: new Map(), valid: () => false }, project.id).actions.find(action => action.id === 'schedule-work-0').occurrence, null);
});

// ---------- P-3: plan items name their run ----------

test('plan rows on the project summary name the run that staged or finished them; the model\'s plan view does not', () => {
  const mind = { agenda: [
    { id: 't1', kind: 'todo', text: '写第 11 章', status: 'open', stage: 'doing', stagedBy: { kind: 'background', actionId: 'run-1' }, updatedAt: isoAgo(5) },
    { id: 't2', kind: 'todo', text: '核对人名', status: 'open', stage: 'next', stagedBy: { kind: 'background', actionId: 'run-1' }, updatedAt: isoAgo(6) },
    { id: 't3', kind: 'todo', text: '写第 10 章', status: 'done', stagedBy: { kind: 'background', actionId: 'run-0' }, resolvedBy: { kind: 'background', actionId: 'run-1', at: isoAgo(4) }, updatedAt: isoAgo(4) },
    { id: 't4', kind: 'todo', text: '对话里加的', status: 'open', stage: 'next', stagedBy: { kind: 'agent' }, updatedAt: isoAgo(7) },
    { id: 't5', kind: 'todo', text: '旧的一项', status: 'open', updatedAt: isoAgo(8) },
  ] };
  const owned = planView(mind, { owners: true });
  assert.deepEqual([...owned.doing, ...owned.next, ...owned.done].map(row => [row.id, row.actionId]), [['t1', 'run-1'], ['t2', 'run-1'], ['t4', undefined], ['t5', undefined], ['t3', 'run-1']]);
  const plain = planView(mind);
  assert.ok([...plain.doing, ...plain.next, ...plain.done].every(row => !Object.hasOwn(row, 'actionId')), 'project_plan and the model context are unchanged');
});

// ---------- P-4: subagents ----------

test('a subagent carries its turn\'s model; the session summary counts the agents of its latest 20 delegating turns', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-background-progress-agents-')), store = new Store(join(dir, 'private', 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { session } = store.createProject({ name: 'Agents', workspace: dir, initiative: { enabled: false } });
  const modelConfig = { providerId: 'provider-1', modelId: 'model-a', name: 'Model A', baseUrl: 'http://127.0.0.1:1/v1', protocol: 'openai', execution: 'rna' };
  const child = (id, status, tokens) => ({ id, role: 'scout', fingerprint: id, status, task: `Task ${id}`, background: true, createdAt: isoAgo(5), startedAt: isoAgo(5), usage: { totalTokens: tokens } });
  store.mutate(state => {
    const target = state.sessions.find(row => row.id === session.id);
    target.turns = [
      // Older than the latest 20 delegating turns: not counted.
      { id: 'turn-old', status: 'completed', modelConfig, delegations: [child('agent-old', 'running', 999)] },
      ...Array.from({ length: 19 }, (_, index) => ({ id: `turn-${index}`, status: 'completed', modelConfig, delegations: [child(`agent-${index}`, 'completed', 100)] })),
      { id: 'turn-plain', status: 'completed', modelConfig },
      { id: 'turn-last', status: 'running', modelConfig, delegations: [child('agent-a', 'running', 50), child('agent-b', 'failed', 25)], officialDelegations: [{ id: 'consult-1', background: true, status: 'completed', createdAt: isoAgo(3) }] },
      { id: 'turn-after', status: 'completed', modelConfig: null },
    ];
  });
  const summary = sessionSummary(store.state.sessions.find(row => row.id === session.id));
  assert.deepEqual(summary.agents, { running: 1, total: 21, tokens: 19 * 100 + 75, latestTurnId: 'turn-last' });
  assert.equal(summary.turns, undefined, 'no heavy fields');
  assert.deepEqual(sessionSummary({ id: 'empty', items: [], turns: [] }).agents, { running: 0, total: 0, tokens: 0, latestTurnId: null });

  const service = new BuiltinAgentService(store); t.after(() => service.close());
  const listed = service.list(session.id), byId = Object.fromEntries(listed.map(row => [row.agentId, row]));
  assert.deepEqual(byId['agent-a'].model, { providerId: 'provider-1', modelId: 'model-a', name: 'Model A' }, 'names only: no endpoint, protocol or key');
  assert.equal(byId['consult-1'].model, null, 'a Claude Code consultation did not run on the turn\'s model');
  assert.equal(agentView({ id: 'x', role: 'scout', status: 'running' }).model, null);
});

// ---------- P-2: the stream hub broadcasts `work.step` ----------

function sse(port, path) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path }, response => {
      const events = []; let buffer = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk; let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const lines = buffer.slice(0, index).split('\n'); buffer = buffer.slice(index + 2);
          if (lines.every(line => line.startsWith(':'))) continue;
          events.push({ event: lines.find(line => line.startsWith('event: '))?.slice(7), data: JSON.parse(lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')) });
        }
      });
      resolve({ events, close: () => request.destroy(), of: type => events.filter(event => event.event === type) });
    });
    request.on('error', reject);
  });
}

test('the stream hub sends a work step to every connection, like a desktop notification, and keeps only its display fields', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-background-progress-stream-')), store = new Store(join(dir, 'state.json')), streams = new Set();
  const api = createApiV2({ store, streams, heartbeatMs: 50 });
  const server = http.createServer((req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try { const url = new URL(req.url, 'http://127.0.0.1'); if (!api.handle(req, res, { pathname: url.pathname, url, send })) send(404, { error: 'missing' }); } catch (error) { send(error.status ?? 500, { error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { api.close(); for (const res of streams) res.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const { project, session } = store.createProject({ name: 'Stream', workspace: dir, initiative: { enabled: false } });
  const port = server.address().port, index = await sse(port, '/api/v2/stream'), scoped = await sse(port, `/api/v2/stream?session=${session.id}`);
  t.after(() => { index.close(); scoped.close(); });
  await until(() => index.of('hello').length && scoped.of('hello').length, 'connected');
  const revision = store.state.revision, at = new Date(NOW).toISOString();
  liveBus(store).publish({ type: 'work.step', projectId: project.id, actionId: 'run-1', toolCallId: 'call-1', name: 'project_exec', kind: 'command', target: `npm test ${'x'.repeat(400)}`, status: 'running', at, args: { command: 'secret' } });
  await until(() => index.of('work.step').length && scoped.of('work.step').length, 'step delivered');
  for (const client of [index, scoped]) {
    const [{ data }] = client.of('work.step');
    assert.deepEqual(Object.keys(data).sort(), ['actionId', 'at', 'kind', 'name', 'projectId', 'status', 'target', 'toolCallId']);
    assert.deepEqual([data.projectId, data.actionId, data.toolCallId, data.name, data.kind, data.status, data.at], [project.id, 'run-1', 'call-1', 'project_exec', 'command', 'running', at]);
    assert.equal(data.target.length, 160);
  }
  assert.equal(store.state.revision, revision, 'display only: nothing is persisted');
});

// ---------- step kinds and targets ----------

test('steps are counted in the panel\'s coarse kinds and their targets are cut after secrets are hidden', () => {
  assert.deepEqual(['project_read', 'project_list', 'project_grep', 'project_find', 'project_edit', 'project_write', 'project_exec', 'web_search', 'web_fetch', 'skill_load', 'mcp__github__search', 'ask_user', undefined].map(stepKind),
    ['read', 'read', 'search', 'search', 'edit', 'write', 'command', 'web', 'web', 'other', 'other', 'other', 'other']);
  // A secret straddling the cut is hidden before the cut, never half shown.
  assert.equal(toolTarget('project_exec', { command: `${'a'.repeat(75)}${SECRET}` }, { redactValues: [SECRET], limit: 80 }), `${'a'.repeat(75)}[RED…`);
  assert.equal(toolTarget('project_exec', { command: `curl https://x.test/?k=${encodeURIComponent(SECRET)}` }, { redactValues: [SECRET] }), 'curl https://x.test/?k=[REDACTED]');
  assert.equal(toolTarget('project_exec', { command: 'npm test\n--watch' }), 'npm test', 'callers without options are unchanged');
});
