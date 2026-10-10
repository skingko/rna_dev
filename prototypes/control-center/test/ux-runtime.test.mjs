import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { RuntimeController, recoveredStepNotice, continuedTaskUpdate } from '../runtime-controller.mjs';
import { ruleReasoning } from '../reasoning-routing.mjs';
import { runtimeFailureMessage } from '../runtime-errors.mjs';
import { applyProjectPermissions } from '../project-permissions.mjs';

// UX audit 2026-10-03, runtime team: what the conversation says when a turn is interrupted,
// fails or recovers, in the interface language, plus the host side of contracts C-a/b/c/g/h.
async function until(check, timeout = 10000) { const deadline = Date.now() + timeout; while (!check()) { if (Date.now() > deadline) throw new Error('condition did not settle'); await delay(10); } }
function host(t, { models = [{ id: 'fixture-model', contextWindow: 32000, maxOutputTokens: 500, reasoning: ['off'] }], baseUrl = 'http://127.0.0.1:9/v1', reasoning = 'off' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-ux-runtime-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'state', 'state.json'), store = new Store(file);
  const provider = store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl, apiKey: 'ux-runtime-synthetic-key', models });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: models[0].id, reasoning }, memory: { autoRecall: false, autoStore: false } });
  const { session, project } = store.createProject({ name: 'UX runtime', workspace: directory, initiative: { enabled: false } });
  const current = () => store.state.sessions.find(row => row.id === session.id);
  return { directory, file, store, provider, session, project, current, turn: () => current().turns.at(-1) };
}
const english = store => store.mutate(state => { state.settings.interfaceLanguage = 'en'; });
// A running turn the executor leaves alone (no real model config), for driving events directly.
function idleTurn(f) {
  const turnId = randomUUID();
  f.store.mutate(state => { const s = state.sessions.find(row => row.id === f.session.id); s.turns.push({ id: turnId, status: 'running', createdAt: new Date().toISOString(), steering: [] }); s.activeTurnId = turnId; s.status = 'running'; });
  return { sessionId: f.session.id, turnId, submitted: new Map(), cancelled: false, handle: null, usageKeys: new Set(), memoryAbort: new AbortController() };
}
function controller(t, f, options = {}) { const runtime = new RuntimeController(f.store, options); t.after(() => runtime.close()); return runtime; }

test('a never-started call cancelled by a new request says nothing; other recovered steps get one localized line, never the tool ID or raw JSON', () => {
  const cancelled = { toolName: 'web_fetch', recovered: true, result: { content: [{ type: 'text', text: JSON.stringify({ status: 'cancelled', neverStarted: true, reason: 'A new user request superseded this earlier tool call before it started.' }) }], details: { cancelled: true, neverStarted: true } } };
  assert.equal(recoveredStepNotice(cancelled, 'zh'), null);
  const retired = { toolName: 'web_fetch', recovered: true, result: { content: [{ type: 'text', text: 'Interrupted call retired after newer user input.' }], details: { retired: true, historicalOutcome: 'unknown', replayed: false } } };
  assert.equal(recoveredStepNotice(retired, 'zh'), '中断前的一步（读取网页）结果已取不回，没有重做。');
  assert.equal(recoveredStepNotice(retired, 'en'), 'An interrupted step (reading a web page) left no result and was not redone.');
  const observed = { toolName: 'mystery_tool', recovered: true, result: { content: [{ type: 'text', text: '{"x":1}' }], details: {} } };
  assert.equal(recoveredStepNotice(observed, 'zh'), '已核对中断前的一步。');
  for (const text of [recoveredStepNotice(retired, 'zh'), recoveredStepNotice(observed, 'en')]) assert.doesNotMatch(text, /web_fetch|mystery_tool|[{}]|superseded/);
});

test('the executor posts no notice for a cancelled never-started call and a readable one for a retired call', t => {
  const f = host(t), runtime = controller(t, f), context = idleTurn(f);
  runtime.event(context, { type: 'tool_execution_end', callKey: 'k1', toolCallId: 'c1', toolName: 'web_fetch', recovered: true, isError: true, result: { content: [{ type: 'text', text: '{"status":"cancelled","neverStarted":true}' }], details: { cancelled: true, neverStarted: true } } });
  assert.ok(!f.current().items.some(row => row.kind === 'notice' && row.turnId === context.turnId));
  runtime.event(context, { type: 'tool_execution_end', callKey: 'k2', toolCallId: 'c2', toolName: 'project_read', recovered: true, isError: true, result: { content: [{ type: 'text', text: 'Interrupted call retired after newer user input.' }], details: { retired: true } } });
  const notice = f.current().items.findLast(row => row.kind === 'notice');
  assert.equal(notice.text, '中断前的一步（读取文件）结果已取不回，没有重做。'); assert.equal(notice.recoveryCallKey, 'k2');
});

test('a project_write records whether it created the file from the receipt (C-b); edits, failures and unknown receipts carry nothing', t => {
  const f = host(t), runtime = controller(t, f), context = idleTurn(f);
  const write = (id, name, end) => {
    runtime.event(context, { type: 'tool_execution_start', toolCallId: id, callKey: `key-${id}`, toolName: name, args: { path: 'a.md' } });
    runtime.event(context, { type: 'tool_execution_end', toolCallId: id, callKey: `key-${id}`, toolName: name, isError: false, ...end });
    return f.current().items.find(row => row.tool?.id === id).tool;
  };
  const hash = 'a'.repeat(64);
  assert.equal(write('w1', 'project_write', { result: { content: [{ type: 'text', text: 'Saved a.md' }], details: { path: 'a.md', beforeHash: null, hash, bytes: 3, changed: true } } }).created, true);
  assert.equal(write('w2', 'project_write', { result: { content: [{ type: 'text', text: 'Saved a.md' }], details: { path: 'a.md', beforeHash: hash, hash: 'b'.repeat(64), bytes: 4, changed: true } } }).created, false);
  assert.equal(write('w3', 'project_edit', { result: { content: [{ type: 'text', text: 'Edited a.md' }], details: { path: 'a.md', beforeHash: hash, hash, bytes: 4, changed: true } } }).created, undefined);
  assert.equal(write('w4', 'project_write', { isError: true, result: { content: [{ type: 'text', text: 'conflict' }], details: { code: 'conflict', written: false } } }).created, undefined);
  assert.equal(write('w5', 'project_write', { result: { content: [{ type: 'text', text: 'Saved' }] } }).created, undefined);
});

test('a real write through the SDK marks a new file as created and a rewrite of it as not created', async t => {
  let calls = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    calls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null, usage) => response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
    chunk({ role: 'assistant' });
    if (calls % 2) chunk({ tool_calls: [{ index: 0, id: `write-${calls}`, type: 'function', function: { name: 'project_write', arguments: JSON.stringify({ path: 'fresh.md', content: `第一章 第${calls}稿\n` }) } }] });
    else chunk({ content: '写好了。' });
    chunk({}, calls % 2 ? 'tool_calls' : 'stop', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const f = host(t, { baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
  f.store.mutate(state => applyProjectPermissions(state, f.project.id, { workspace: 'execute', background: 'read' }));
  controller(t, f);
  f.store.message(f.session.id, { text: '写第一章' });
  await until(() => ['completed', 'failed'].includes(f.turn()?.status));
  assert.equal(f.turn().status, 'completed');
  const tool = f.current().items.find(row => row.tool?.name === 'project_write').tool;
  assert.equal(tool.status, 'succeeded'); assert.equal(tool.created, true); assert.ok(existsSync(join(f.directory, 'fresh.md')));
  f.store.message(f.session.id, { text: '重写第一章' });
  await until(() => f.current().turns.length === 2 && ['completed', 'failed'].includes(f.turn().status));
  const rewrite = f.current().items.findLast(row => row.tool?.name === 'project_write').tool;
  assert.equal(rewrite.status, 'succeeded'); assert.equal(rewrite.created, false);
});

// The background host's refusal (project-initiative-controller prepareForeground), already in the interface language.
const REVIEW_REFUSAL = '后台有一项工作的结果还没核对，这一轮先没有改动工作区。请到任务页 · 待核对确认它的结果，再重试这一轮。';
const DRAINING_REFUSAL = 'Background work is still stopping and has not confirmed it ended, so this turn has not touched the workspace. Retry in a moment.';

test('a refusal while background work waits for review shows the host\'s own words and keeps the blocking action on the turn (C-g, C2-b); retry clears it', async t => {
  const f = host(t);
  let refusals = [Object.assign(new Error(REVIEW_REFUSAL), { code: 'background_recovery_required', details: { actionId: 'action-7ef892ca' } }), Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })];
  controller(t, f, { prepareForeground: async () => { throw refusals.shift() ?? new Error('unexpected'); } });
  f.store.message(f.session.id, { text: '继续写' });
  await until(() => f.turn()?.status === 'failed');
  const notice = () => f.current().items.findLast(row => row.source === 'runtime-error');
  assert.equal(f.turn().errorCode, 'background_recovery_required'); assert.equal(f.turn().blockingActionId, 'action-7ef892ca'); assert.equal(f.turn().blockingDraining, undefined);
  assert.equal(notice().text, REVIEW_REFUSAL);
  f.store.controlSession(f.session.id, 'retry');
  assert.equal(f.turn().blockingActionId, undefined);
  await until(() => f.turn()?.status === 'failed');
  // Anything unexpected is an internal stop the user can retry: no 模拟器, no advice to check their own setup.
  assert.equal(notice().text, '这一轮意外中断，没有做完（应用内部出错）。已完成的步骤和你的消息都保留着，可以直接重试。');
  assert.equal(f.turn().failure.code, 'ENOENT'); assert.equal(f.turn().blockingActionId, undefined);
  english(f.store); refusals = [Object.assign(new Error('boom'), { code: 'internal_thing' })];
  f.store.controlSession(f.session.id, 'retry');
  await until(() => f.turn()?.status === 'failed' && f.turn().retryHistory.length === 2);
  assert.equal(notice().text, 'This turn stopped unexpectedly before it finished (an internal app error). Finished steps and your message are kept; you can retry.');
  assert.equal(f.current().items.filter(row => row.kind === 'notice').at(-2).text, 'Retrying the request that did not finish; steps already done are not redone.');
});

test('a refusal while background work is still stopping is a plain retry: no blocking action, blockingDraining instead (C2-b)', async t => {
  const f = host(t); english(f.store);
  // The draining refusal still names the writer being stopped; that action is not under review.
  let refusals = [Object.assign(new Error(DRAINING_REFUSAL), { code: 'background_recovery_required', details: { actionId: 'action-writer-1', draining: true } }), Object.assign(new Error(''), { code: 'background_recovery_required', details: { draining: true } })];
  controller(t, f, { prepareForeground: async () => { throw refusals.shift() ?? new Error('unexpected'); } });
  f.store.message(f.session.id, { text: 'Keep writing' });
  await until(() => f.turn()?.status === 'failed');
  const notice = () => f.current().items.findLast(row => row.source === 'runtime-error');
  assert.equal(f.turn().blockingActionId, undefined); assert.equal(f.turn().blockingDraining, true); assert.equal(notice().text, DRAINING_REFUSAL);
  f.store.controlSession(f.session.id, 'retry');
  assert.equal(f.turn().blockingDraining, undefined);
  // A refusal without words of its own still reads as the draining case, in the interface language.
  await until(() => f.turn()?.status === 'failed' && f.turn().retryHistory.length === 1);
  assert.equal(notice().text, DRAINING_REFUSAL); assert.equal(f.turn().blockingDraining, true);
});

test('a project folder moved or deleted fails with its own reason and where to look, not as an internal error (F18)', async t => {
  const f = host(t), workspace = join(f.directory, 'novel');
  mkdirSync(workspace);
  const { session } = f.store.createProject({ name: 'Novel', workspace, initiative: { enabled: false } });
  rmSync(workspace, { recursive: true, force: true });
  controller(t, f);
  f.store.message(session.id, { text: '继续写第三章' });
  const turn = () => f.store.state.sessions.find(row => row.id === session.id).turns.at(-1);
  await until(() => turn()?.status === 'failed');
  const notice = f.store.state.sessions.find(row => row.id === session.id).items.findLast(row => row.source === 'runtime-error');
  assert.equal(turn().errorCode, 'workspace_missing'); assert.equal(turn().failure.code, 'ENOENT');
  assert.equal(notice.text, `项目文件夹 ${workspace} 找不到了（可能被移动、改名或删除），这一轮没法接着做。请把文件夹放回原处后重试，项目设置里的「工作目录」写着它原来的位置；你的消息和已完成的步骤都保留着。`);
  assert.equal(turn().autoRetry, undefined, 'a retry would fail the same way, so none is scheduled');
  // A known refusal keeps its own words even with the folder gone.
  const g = host(t), gone = join(g.directory, 'gone');
  mkdirSync(gone);
  const other = g.store.createProject({ name: 'Gone', workspace: gone, initiative: { enabled: false } }).session;
  rmSync(gone, { recursive: true, force: true });
  controller(t, g, { prepareForeground: async () => { throw Object.assign(new Error(REVIEW_REFUSAL), { code: 'background_recovery_required', details: { actionId: 'action-2' } }); } });
  g.store.message(other.id, { text: '继续' });
  const last = () => g.store.state.sessions.find(row => row.id === other.id).turns.at(-1);
  await until(() => last()?.status === 'failed');
  assert.equal(last().errorCode, 'background_recovery_required');
});

test('provider failures follow the interface language; Chinese text and the diagnostic suffix are unchanged', () => {
  const timeout = { errorDiagnostic: { category: 'timeout', retryable: true } };
  assert.equal(runtimeFailureMessage(timeout), '模型响应超时。已完成的操作仍保留，请稍后重试或切换其他可用模型。');
  assert.equal(runtimeFailureMessage(timeout, 'en'), 'The model took too long to respond. Finished steps are kept; retry later or switch to another available model.');
  const compaction = { errorDiagnostic: { category: 'rate_limit', status: 429, providerCode: 'rate_limit_exceeded', purpose: 'compaction' } };
  assert.equal(runtimeFailureMessage(compaction), '上下文压缩未完成，原始对话已保留。模型服务当前限流。请稍后重试，或切换其他可用模型。（HTTP 429；供应商代码 rate_limit_exceeded）');
  assert.equal(runtimeFailureMessage(compaction, 'en'), 'Context compaction did not finish; the original conversation is kept. The model service is rate limiting requests. Retry later, or switch to another available model. (HTTP 429; provider code rate_limit_exceeded)');
  assert.doesNotMatch(runtimeFailureMessage(compaction, 'en'), /[一-鿿]/);
});

test('stopping cancels the running step (shown as stopped, not failed); a restart interrupts it and the clock ends at the last activity (C-a)', t => {
  const f = host(t);
  f.store.message(f.session.id, { text: '运行测试' });
  const turnId = f.turn().id;
  f.store.mutate(state => { const s = state.sessions.find(row => row.id === f.session.id); s.items.push({ id: randomUUID(), turnId, kind: 'tool', text: 'project_exec', createdAt: new Date().toISOString(), simulated: false, tool: { id: 't1', name: 'project_exec', args: { command: 'npm run dev' }, status: 'running', output: '' } }); });
  f.store.controlSession(f.session.id, 'stop');
  const stopped = f.current().items.find(row => row.tool?.id === 't1').tool;
  assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.output, '你停止了这一轮，这一步没有做完。');

  const g = host(t);
  g.store.message(g.session.id, { text: '写第二章' });
  const turn = g.turn(), base = Date.parse('2026-10-01T10:00:00.000Z');
  g.store.mutate(state => {
    const s = state.sessions.find(row => row.id === g.session.id), row = s.turns.find(item => item.id === turn.id);
    row.createdAt = row.attemptStartedAt = new Date(base).toISOString();
    for (const item of s.items) if (item.turnId === turn.id) item.createdAt = new Date(base).toISOString();
    s.items.push({ id: randomUUID(), turnId: turn.id, kind: 'tool', text: 'project_write', createdAt: new Date(base + 12000).toISOString(), simulated: false, tool: { id: 't2', name: 'project_write', args: { path: 'b.md' }, status: 'running', output: '' } });
  });
  const reopened = new Store(g.file), session = () => reopened.state.sessions.find(row => row.id === g.session.id), last = () => session().turns.at(-1);
  assert.equal(session().pauseReason, 'recovery');
  assert.equal(session().items.find(row => row.tool?.id === 't2').tool.status, 'interrupted');
  assert.equal(last().pausedAt, new Date(base + 12000).toISOString());
  const before = Date.now();
  reopened.controlSession(g.session.id, 'resume');
  assert.equal(last().activeMs, 12000); assert.ok(Date.parse(last().attemptStartedAt) >= before); assert.equal(last().pausedAt, undefined);
  assert.equal(session().items.at(-1).text, '接着上次继续，已完成的步骤不会重做。');
});

test('a retry counts only the failed attempt, not the wait before it (C-a)', t => {
  const f = host(t);
  f.store.message(f.session.id, { text: '整理大纲' });
  const turnId = f.turn().id, base = Date.parse('2026-10-02T21:55:34.000Z');
  assert.equal(f.turn().activeMs, 0); assert.equal(f.turn().attemptStartedAt, f.turn().createdAt);
  f.store.finishRuntimeTurn(f.session.id, turnId, { status: 'failed', error: '失败', errorCode: 'background_recovery_required' });
  f.store.mutate(state => { const row = state.sessions.find(item => item.id === f.session.id).turns.find(item => item.id === turnId); row.attemptStartedAt = new Date(base).toISOString(); row.completedAt = new Date(base + 3000).toISOString(); row.blockingActionId = 'action-1'; });
  f.store.controlSession(f.session.id, 'retry');
  const turn = f.turn();
  assert.equal(turn.activeMs, 3000); assert.equal(turn.attemptStartedAt, turn.retryHistory.at(-1).retriedAt);
  assert.equal(turn.completedAt, undefined); assert.equal(turn.blockingActionId, undefined); assert.equal(turn.status, 'running');
});

test('lifting the emergency stop switches back on exactly the projects it switched off (C-h)', t => {
  const f = host(t);
  for (const name of ['on', 'changed', 'archived']) mkdirSync(join(f.directory, name));
  const on = f.store.createProject({ name: 'On', workspace: join(f.directory, 'on'), initiative: { enabled: true } }).project;
  const changed = f.store.createProject({ name: 'Changed', workspace: join(f.directory, 'changed'), initiative: { enabled: true } }).project;
  const archived = f.store.createProject({ name: 'Archived', workspace: join(f.directory, 'archived'), initiative: { enabled: true } }).project;
  const project = id => f.store.state.projects.find(row => row.id === id);
  f.store.emergency(true);
  assert.deepEqual([on, changed, archived].map(row => [project(row.id).initiative.enabled, project(row.id).initiative.pausedByEmergency]), [[false, true], [false, true], [false, true]]);
  assert.equal(project(f.project.id).initiative.enabled, false); assert.equal(project(f.project.id).initiative.pausedByEmergency, undefined, 'a project already off is not marked');
  f.store.updateProject(changed.id, { initiative: { enabled: false } });
  f.store.updateProject(archived.id, { archived: true });
  f.store.emergency(false);
  assert.equal(project(on.id).initiative.enabled, true); assert.equal(project(on.id).initiative.pausedByEmergency, undefined); assert.equal(project(on.id).initiative.pauseReason, undefined);
  assert.equal(project(changed.id).initiative.enabled, false, 'the user switched it off during the stop');
  assert.equal(project(archived.id).initiative.enabled, false); assert.equal(project(f.project.id).initiative.enabled, false);
});

test('switching models rescales the last context projection to the new window and marks it an estimate (F49, C2-a)', t => {
  const f = host(t, { models: [{ id: 'wide', contextWindow: 1000000, maxOutputTokens: 32000, reasoning: ['off'] }, { id: 'narrow', contextWindow: 272000, maxOutputTokens: 16000, reasoning: ['off'] }] });
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).context.usage = { estimatedInputTokens: 578867, capacity: 1000000, outputReserve: 32000, inputTrigger: 768000, method: 'fixture', status: 'ready', automaticEnabled: true, compactionId: null }; });
  // Re-applying the same model (as every new turn does) leaves a measurement alone.
  f.store.updateSession(f.session.id, { modelSelection: { providerId: f.provider.id, modelId: 'wide', reasoning: 'off' } });
  assert.equal(f.current().context.usage.estimated, undefined); assert.equal(f.current().context.usage.capacity, 1000000);
  f.store.updateSession(f.session.id, { modelSelection: { providerId: f.provider.id, modelId: 'narrow', reasoning: 'off' } });
  const { context } = f.current();
  assert.deepEqual([context.capacity, context.usage.capacity, context.usage.outputReserve, context.usage.inputTrigger, context.usage.estimatedInputTokens, context.usage.estimated], [272000, 272000, 16000, Math.floor(272000 * 0.8) - 16000, 578867, true]);
});

test('context use is always against the session\'s own model (C2-a): a fast-model turn is rescaled and marked an estimate, a measurement on the session\'s model drops the mark', t => {
  const f = host(t, { models: [{ id: 'main', contextWindow: 400000, maxOutputTokens: 32000, reasoning: ['off'] }, { id: 'fast', contextWindow: 128000, maxOutputTokens: 8000, reasoning: ['off'] }] });
  const runtime = controller(t, f), context = idleTurn(f);
  const measured = (capacity, outputReserve, tokens) => ({ estimatedInputTokens: tokens, capacity, outputReserve, inputTrigger: Math.floor(capacity * 0.8) - outputReserve, method: 'fixture', status: 'ready', automaticEnabled: true });
  const routeTo = modelId => f.store.mutate(state => { const turn = state.sessions.find(row => row.id === f.session.id).turns.find(row => row.id === context.turnId); turn.modelConfig = { providerId: f.provider.id, modelId, ...(modelId === 'fast' ? { contextWindow: 128000, maxOutputTokens: 8000 } : { contextWindow: 400000, maxOutputTokens: 32000 }) }; });
  // JEV routed this turn to the fast model: the SDK measures against its window.
  routeTo('fast');
  runtime.event(context, { type: 'context_usage', usage: measured(128000, 8000, 50000) });
  let usage = f.current().context.usage;
  assert.deepEqual([usage.capacity, usage.outputReserve, usage.inputTrigger, usage.estimatedInputTokens, usage.estimated, f.current().context.capacity], [400000, 32000, 400000 * 0.8 - 32000, 50000, true, 400000]);
  // The final snapshot names the model it measured on.
  runtime.settleContextUsage(context, { contextUsage: measured(128000, 8000, 51000), model: { providerId: f.provider.id, modelId: 'fast' } });
  usage = f.current().context.usage;
  assert.deepEqual([usage.capacity, usage.estimatedInputTokens, usage.estimated], [400000, 51000, true]);
  // The next turn on the session's own model measures it again.
  routeTo('main');
  runtime.event(context, { type: 'context_usage', usage: measured(400000, 32000, 52000) });
  usage = f.current().context.usage;
  assert.deepEqual([usage.capacity, usage.estimatedInputTokens, usage.estimated], [400000, 52000, undefined]);
});

test('the projection taken when a turn starts names the model it was measured on (C2-a): another model\'s figure is an estimate even at the same window', async t => {
  const f = host(t, { models: [{ id: 'main', contextWindow: 128000, maxOutputTokens: 8000, reasoning: ['off'] }, { id: 'fast', contextWindow: 128000, maxOutputTokens: 8000, reasoning: ['off'] }] });
  let measuredOn = 'fast', finish, began;
  const started = new Promise(resolve => { began = resolve; }), waiting = new Promise(resolve => { finish = resolve; });
  const usage = { estimatedInputTokens: 4000, capacity: 128000, outputReserve: 8000, inputTrigger: Math.floor(128000 * 0.8) - 8000, method: 'fixture', status: 'ready', automaticEnabled: true, compactionId: null };
  const runtime = new RuntimeController(f.store, { factory: async () => ({
    snapshot: () => ({ sessionFile: join(f.directory, 'fixture.jsonl'), sessionId: 'fixture-sdk', model: { providerId: f.provider.id, modelId: measuredOn }, tools: [], messages: [], queue: { steering: [] }, cache: { estimatedInputTokens: 4000 }, contextUsage: usage }),
    prompt: async () => { began(); await waiting; }, abort: async () => finish(), dispose: async () => {}
  }) });
  t.after(async () => { finish(); await runtime.close(); });
  // A turn whose SDK session is on the fast model (a resumed auto-routed turn): same window, still not the session's model.
  f.store.message(f.session.id, { text: '继续' });
  await started;
  assert.deepEqual([f.current().context.usage.capacity, f.current().context.usage.estimatedInputTokens, f.current().context.usage.estimated], [128000, 4000, true]);
  measuredOn = 'main'; finish(); await runtime.running.get(f.session.id)?.runPromise;
  assert.equal(f.current().context.usage.estimated, undefined, 'measured again on the session\'s own model');
});

test('a stopped or interrupted step stays as shown when the SDK later retires it; a real recovered result still replaces it (C2-i)', t => {
  const f = host(t);
  f.store.message(f.session.id, { text: '读网页' });
  const first = f.turn().id, tool = (id, status) => ({ id: randomUUID(), turnId: first, kind: 'tool', text: 'web_fetch', createdAt: new Date().toISOString(), simulated: false, tool: { id, callKey: `key-${id}`, name: 'web_fetch', args: { url: 'https://example.com' }, status, output: '' } });
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).items.push(tool('c1', 'running')); });
  f.store.controlSession(f.session.id, 'stop');
  // Two steps a restart interrupted, in an older turn (shape written by pauseSession).
  f.store.mutate(state => { const s = state.sessions.find(row => row.id === f.session.id); for (const id of ['c2', 'c3']) s.items.push({ ...tool(id, 'interrupted'), tool: { ...tool(id).tool, status: 'interrupted', output: '这一步被打断了；恢复后按它实际留下的结果接着做。' } }); });
  const runtime = controller(t, f), context = idleTurn(f), row = id => f.current().items.find(item => item.tool?.id === id).tool;
  const retire = id => runtime.event(context, { type: 'tool_execution_end', callKey: `key-${id}`, toolCallId: id, toolName: 'web_fetch', recovered: true, isError: true, result: { content: [{ type: 'text', text: 'Interrupted call retired after newer user input. Its prior result is unavailable and its historical outcome is not claimed.' }], details: { retired: true, historicalOutcome: 'unknown', replayed: false } } });
  retire('c1'); retire('c2');
  assert.deepEqual([row('c1').status, row('c1').output], ['cancelled', '你停止了这一轮，这一步没有做完。']);
  assert.deepEqual([row('c2').status, row('c2').output], ['interrupted', '这一步被打断了；恢复后按它实际留下的结果接着做。']);
  assert.ok(!f.current().items.some(item => item.turnId === context.turnId && item.kind === 'notice'), 'no second line for a step already shown as stopped');
  runtime.event(context, { type: 'tool_execution_end', callKey: 'key-c3', toolCallId: 'c3', toolName: 'web_fetch', recovered: true, isError: false, result: { content: [{ type: 'text', text: 'page text' }], details: {} } });
  assert.deepEqual([row('c3').status, row('c3').output, row('c3').recovered], ['succeeded', 'page text', true]);
});

test('carrying on a task revoked by a scope change, or one the SDK no longer lists, gives the turn the user\'s record of the run (its job), and nothing when none is kept', t => {
  const f = host(t);
  const message = (actionId, sessionId = f.session.id) => { f.store.message(sessionId, { text: '接着完成：写第四章', continues: { actionId } }); return { sessionId, turnId: f.store.state.sessions.find(row => row.id === sessionId).turns.at(-1).id }; };
  f.store.mutate(state => {
    const project = state.projects.find(row => row.id === f.project.id);
    project.initiativeRuntime = { sdkState: { actions: [
      { id: 'live', action: 'work', status: 'paused', content: 'Write chapter four', handoff: 'Outline done' },
      { id: 'revoked', action: 'work', status: 'paused', content: 'Previous project scope; retained only as an action receipt.', contextRevoked: true },
      { id: 'scrubbed', action: 'work', status: 'paused', content: 'Previous project scope; retained only as an action receipt.', contextRevoked: true },
      { id: 'deleted', action: 'work', status: 'paused', content: 'x', sourceDeleted: true }] } };
    project.jobs = [{ id: 'revoked', title: '写第四章', instruction: 'Write chapter four from the outline', handoff: 'Scenes 1-2 written', status: 'paused' }, { id: 'scrubbed', instruction: '[deleted]', status: 'paused', sourceDeleted: true, contextRevoked: true },
      // The SDK no longer lists this run (compacted away); its job is still the user's record.
      { id: 'job-only', title: '补全简介', instruction: 'Complete the synopsis', handoff: 'First paragraph done', status: 'failed' }];
  });
  const read = actionId => { const context = message(actionId), update = continuedTaskUpdate(f.store.state, context); f.store.controlSession(f.session.id, 'stop'); return update && JSON.parse(update.text); };
  assert.deepEqual([read('live').task, read('live').handoff], ['Write chapter four', 'Outline done']);
  const revoked = read('revoked');
  assert.deepEqual([revoked.title, revoked.task, revoked.handoff, revoked.status], ['写第四章', 'Write chapter four from the outline', 'Scenes 1-2 written', 'paused']);
  assert.doesNotMatch(JSON.stringify(revoked), /Previous project scope/);
  assert.equal(read('scrubbed'), null); assert.equal(read('deleted'), null);
  assert.deepEqual(Object.values((({ title, task, handoff, status }) => ({ title, task, handoff, status }))(read('job-only'))), ['补全简介', 'Complete the synopsis', 'First paragraph done', 'failed']);
  assert.equal(read('never-was'), null);
});

// SCOPE-1: the continued task's full text is the only copy of what the user asked to carry on (their message shows one
// line), and the work often spans turns ("继续" after a break). It is window-scoped (never set aside at a cold break) and
// offered on every request of that turn and the next, so a compaction that archived it is followed by a fresh copy.
test('the continued task stays with the conversation for the turn after it and comes back after a compaction', async t => {
  const f = host(t);
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).initiativeRuntime = { sdkState: { actions: [{ id: 'live', action: 'work', status: 'paused', content: 'Write chapter four in full, 4000 characters, keep the magic system rules', handoff: 'Outline done' }] } }; });
  const turn = text => { f.store.message(f.session.id, text); const id = f.turn().id; f.store.controlSession(f.session.id, 'stop'); return id; };
  const asked = turn({ text: '接着完成：写第四章', continues: { actionId: 'live' } }), next = turn({ text: '继续' }), later = turn({ text: '再写一章' });
  const update = continuedTaskUpdate(f.store.state, { sessionId: f.session.id, turnId: asked });
  assert.deepEqual([update.key, update.scope], ['continued-task:live', 'window']);
  assert.equal(continuedTaskUpdate(f.store.state, { sessionId: f.session.id, turnId: next })?.text, update.text, 'the turn after it still has it');
  assert.equal(continuedTaskUpdate(f.store.state, { sessionId: f.session.id, turnId: later }), null, 'two turns on it is history the summary carries');
  // Through the request hook: not repeated while the model can see it; offered again once a compaction hid it.
  const controller = Object.create(RuntimeController.prototype);
  Object.assign(controller, { store: f.store, admitSteering: async () => {} });
  const keys = async snapshot => (await controller.prepareRequest({ sessionId: f.session.id, turnId: next, feedbackSent: true }, { snapshot }))?.contextUpdates?.map(row => row.key) ?? [];
  const note = { id: 'n1', role: 'user', source: 'context', contextKey: update.key, contextScope: 'window', context: [{ source: update.source, text: update.text }] };
  const user = id => ({ id, role: 'user', source: 'user', content: [{ type: 'text', text: id }] });
  assert.ok(!(await keys({ messages: [user('u1'), note, user('u2')] })).includes(update.key), 'visible: not sent again');
  assert.ok((await keys({ messages: [user('u1'), note, user('u2')], compaction: { throughMessageId: 'n1' } })).includes(update.key), 'behind a compaction boundary: sent again');
});

test('rule-chosen reasoning levels explain themselves in the interface language', () => {
  const capability = { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }], providerDefault: 'medium' };
  assert.equal(ruleReasoning({ capability, prompt: 'thanks', language: 'en' }).rationale, 'a simple greeting or acknowledgement, the lowest level');
  assert.equal(ruleReasoning({ capability, prompt: 'Please think carefully about it.', language: 'en' }).rationale, 'you asked for careful thinking');
  assert.equal(ruleReasoning({ capability, mode: 'plan', prompt: 'plan it', language: 'en' }).rationale, 'plan mode, a higher thinking level');
  assert.equal(ruleReasoning({ capability, prompt: 'again', previousTurn: { status: 'failed' }, language: 'en' }).rationale, 'a retry after the last turn failed, one level higher');
  assert.equal(ruleReasoning({ capability, prompt: '你好' }).rationale, '简单问候或确认，使用最低档位');
});

test('a subagent result reads as its notice line (C-c): one visible line on wake, displayText on steering and queued turns', t => {
  const f = host(t);
  const prompt = '[宿主通知 · 子代理完成] agentId=3f2a 角色=研究员（researcher） 状态=completed\n任务：查资料\n结果：找到三处出处。\n这是宿主转交的后台子任务结果，不是用户新指令。', notice = '子代理完成：研究员 · 找到三处出处。';
  // Wake an idle parent.
  const turnId = randomUUID();
  f.store.mutate(state => { const s = state.sessions.find(row => row.id === f.session.id); s.turns.push({ id: turnId, status: 'completed', createdAt: new Date().toISOString(), delegations: [{ id: 'agent-1', status: 'completed', delivery: { status: 'pending' } }] }); });
  assert.equal(f.store.deliverAgentNotice(f.session.id, { agentId: 'agent-1', turnId, prompt, notice, wake: true }).status, 'woke');
  const woke = f.current().items.find(row => row.id === f.turn().userItemId);
  assert.equal(woke.text, prompt); assert.equal(woke.displayText, notice); assert.equal(woke.source, 'subagent');
  assert.ok(!f.current().items.some(row => row.kind === 'notice' && row.source === 'subagent'), 'no second line for the same result');
  // A queued result starts the next turn after a completed one.
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).inbox.push({ id: 'queued-1', delivery: 'steer', text: prompt, attachments: [], skillIds: [], createdAt: new Date().toISOString(), source: 'subagent', agentId: 'agent-2', notice, wake: true }); });
  f.store.finishRuntimeTurn(f.session.id, f.turn().id, {});
  assert.equal(f.current().items.find(row => row.id === f.turn().userItemId).displayText, notice);
  // Steering consumed by a running turn.
  const g = host(t), runtime = controller(t, g), context = idleTurn(g);
  g.store.mutate(state => { state.sessions.find(row => row.id === g.session.id).inbox.push({ id: 'steer-1', delivery: 'steer', text: prompt, attachments: [], skillIds: [], createdAt: new Date().toISOString(), source: 'subagent', agentId: 'agent-3', notice }); });
  runtime.consumeSteering(context, 'steer-1');
  const steered = g.current().items.findLast(row => row.kind === 'user');
  assert.deepEqual([steered.text, steered.displayText, steered.source, steered.agentId], [prompt, notice, 'subagent', 'agent-3']);
});

test('the model tooltip rationale is plain text in the interface language, never an internal reason code', async t => {
  const f = host(t, { models: [{ id: 'leveled', contextWindow: 32000, maxOutputTokens: 500, reasoning: ['low', 'high'] }], reasoning: 'auto' });
  english(f.store);
  const decisions = { enabled: () => true, route: async () => ({ reasoningDecided: false, reason: 'accepted', backend: 'typesafe', ledgerId: 'l1' }) };
  const runtime = controller(t, f, { decisionService: decisions, prepareForeground: async () => { await delay(50); throw Object.assign(new Error('stop here'), { code: 'internal_thing' }); } });
  f.store.updateSession(f.session.id, { modelSelection: { providerId: f.provider.id, modelId: 'leveled', reasoning: 'auto' } });
  f.store.message(f.session.id, { text: 'Refactor the scheduler to use a heap' });
  await until(() => f.turn()?.status === 'failed');
  await until(() => f.turn().modelConfig.reasoningDecision);
  const decision = f.turn().modelConfig.reasoningDecision;
  assert.equal(decision.source, 'provider-default'); assert.equal(decision.rationale, 'the judgment gave no clear level');
  assert.doesNotMatch(JSON.stringify(decision), /accepted|typesafe/);
  void runtime;
});

test('the stop notice says the user\'s queued messages went back into the input box; a queued subagent result is not counted', t => {
  const f = host(t); english(f.store);
  f.store.message(f.session.id, { text: 'First' });
  for (const text of ['Second', 'Third']) f.store.message(f.session.id, { text, delivery: 'followup' });
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).inbox.push({ id: 'agent-msg', delivery: 'steer', text: 'host prompt', attachments: [], skillIds: [], createdAt: new Date().toISOString(), source: 'subagent', agentId: 'agent-1', notice: 'Subagent finished', wake: true }); });
  const { recovered } = f.store.controlSession(f.session.id, 'stop');
  assert.equal(recovered.length, 3);
  assert.equal(f.current().items.at(-1).text, 'Turn stopped. 2 messages not yet processed were put back in the input box; you can keep the conversation going.');
  f.store.message(f.session.id, { text: 'Again' }); f.store.message(f.session.id, { text: 'One more', delivery: 'followup' });
  f.store.controlSession(f.session.id, 'stop');
  assert.equal(f.current().items.at(-1).text, 'Turn stopped. The message not yet processed was put back in the input box; you can keep the conversation going.');
});
