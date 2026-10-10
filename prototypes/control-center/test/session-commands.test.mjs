import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { RuntimeController } from '../runtime-controller.mjs';
import { SessionCommandService } from '../session-command-service.mjs';
import { openJournal } from '../../../packages/sdk/src/journal.mjs';

async function until(check) { const deadline = Date.now() + 8000; while (!check()) { if (Date.now() > deadline) throw new Error('Fixture did not settle'); await delay(10); } }
function stream(response, { text = 'Summary preserves the project goal.', tool, finish = 'stop', usage = true } = {}) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = tool ? { tool_calls: [{ index: 0, id: 'forbidden-write', type: 'function', function: { name: 'project_write', arguments: JSON.stringify({ path: 'should-not-exist.txt', content: 'bad', expectedHash: null }) } }] } : { content: text };
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : finish }], ...(usage ? { usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 } } : {}) })}\n\ndata: [DONE]\n\n`);
}
async function setup(t, responder = (_input, response) => stream(response)) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-commands-')), calls = [];
  const server = http.createServer(async (request, response) => { let raw = ''; for await (const chunk of request) raw += chunk; const input = JSON.parse(raw); calls.push(input); await responder(input, response, calls.length); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const store = new Store(join(directory, 'private', 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'command-fixture-private-key', models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 512, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ name: 'Commands QA', workspace: directory, initiative: { enabled: false } });
  const executor = new RuntimeController(store), service = new SessionCommandService(store, { executor });
  t.after(async () => { await executor.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const current = () => store.state.sessions.find(item => item.id === session.id);
  const command = (name, args = {}, requestId = `${name}-${Date.now()}`) => service.execute(session.id, { command: name, args, requestId });
  const history = ({ pending = false } = {}) => {
    const journal = openJournal({ stateDir: join(`${store.file}.rna`, session.id), sessionId: session.id, projectId: project.id });
    for (let index = 0; index < 4; index++) {
      journal.append('message', { message: { id: `user-${index}`, role: 'user', source: 'user', timestamp: Date.now() - 60000, content: [{ type: 'text', text: `Historical goal ${index}. ${'Keep exact original evidence. '.repeat(100)}` }] } });
      journal.append('message', { message: { id: `assistant-${index}`, role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Recorded completed operation. '.repeat(100) }] } });
    }
    if (pending) journal.append('message', { message: { id: 'pending-assistant', role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'pending', name: 'project_write', arguments: { path: 'pending.txt', content: 'unknown' } }] } });
    const file = journal.file; journal.close(); store.mutate(state => { state.sessions.find(item => item.id === session.id).runtime = { engine: 'rna', sessionId: session.id, sessionFile: file }; }); return file;
  };
  return { directory, store, executor, service, calls, project, session, current, command, history };
}

test('goal and feedback persist genuine evidence once, preserve unrelated commitments, and never create demo goals', async t => {
  const f = await setup(t);
  f.store.mutate(state => state.projects[0].commitments.push({ id: 'existing', text: 'Existing restriction', source: 'user' }));
  const result = await f.command('goal', { text: 'Build the game workbench', constraints: ['Keep save files compatible'] }, 'goal-once');
  assert.equal(result.status, 'completed'); assert.equal(f.store.state.goals.length, 0); assert.equal(f.calls.length, 0);
  assert.equal(f.store.state.projects[0].focus, 'Build the game workbench'); assert.equal(f.store.state.projects[0].commitments.length, 2);
  assert.equal(f.store.state.projects[0].observations.at(-1).simulated, false);
  assert.equal((await f.command('goal', { text: 'Build the game workbench', constraints: ['Keep save files compatible'] }, 'goal-once')).duplicate, true);
  assert.equal(f.store.state.projects[0].observations.length, 1);
  await assert.rejects(f.command('goal', { text: 'different' }, 'goal-once'), { code: 'command_conflict' });
  const feedback = await f.command('feedback', { text: 'Too much interruption', rating: 'negative', itemId: result.result.noticeId }, 'feedback-once');
  assert.equal(feedback.status, 'completed'); assert.equal(f.store.state.projects[0].observations.at(-1).data.sessionId, f.session.id);
  assert.equal(new Store(f.store.file).state.projects[0].observations.at(-1).text, 'Too much interruption');
  await assert.rejects(f.command('feedback', { text: 'bad reference', itemId: 'foreign' }), { code: 'invalid_item' });
});

test('plan changes real foreground tool permissions; denied model write never touches filesystem', async t => {
  const f = await setup(t, (_input, response, count) => stream(response, count === 1 ? { tool: true } : { text: 'Write is unavailable in plan mode.' }));
  await f.command('plan', { mode: 'plan' }, 'plan-enable');
  assert.equal(f.service.describe(f.session.id).mode, 'plan');
  f.store.message(f.session.id, { text: 'Please write the file', requestId: 'plan-request' });
  await assert.rejects(f.command('plan', { mode: 'build' }), { code: 'session_busy' });
  await until(() => f.current().turns[0]?.status === 'completed');
  assert.equal(existsSync(join(f.directory, 'should-not-exist.txt')), false);
  assert.ok(!f.calls[0].tools?.some(tool => ['project_write', 'project_exec', 'capability_install'].includes(tool.function.name)));
  assert.match(JSON.stringify(f.calls[0].messages), /This turn is in plan mode/);
  assert.equal(f.current().turns[0].mode, 'plan');
  await until(() => !f.executor.running.has(f.session.id));
  await f.command('plan', { mode: 'build' }, 'plan-disable'); assert.equal(f.current().mode, 'build');
});

test('compact sends the existing journal to the selected real HTTP provider, accounts once and preserves all raw messages', async t => {
  const f = await setup(t), file = f.history(), original = readFileSync(file, 'utf8');
  const result = await f.command('compact', { instructions: 'Preserve file paths' }, 'compact-once');
  assert.equal(result.status, 'completed'); assert.equal(result.result.compacted, true); assert.equal(f.calls.length, 1);
  assert.match(JSON.stringify(f.calls[0].messages), /Historical goal 0/); assert.match(JSON.stringify(f.calls[0].messages), /Preserve file paths/);
  assert.ok(!f.calls[0].tools?.length); assert.equal(f.store.state.realUsage.tokens, 20); assert.equal(f.current().usage.tokens, 20);
  assert.equal(f.current().context.compactions, 1); assert.ok(readFileSync(file, 'utf8').startsWith(original));
  const records = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse); assert.equal(records.filter(row => row.type === 'message').length, 8); assert.equal(records.filter(row => row.type === 'context_compaction').length, 1);
  assert.equal((await f.command('compact', { instructions: 'Preserve file paths' }, 'compact-once')).duplicate, true); assert.equal(f.calls.length, 1);
});

test('a manual summary takes its effort from the one internal plan: the usable provider default, or the chat\'s own under "same as chat"', async t => {
  const sent = async setting => {
    const f = await setup(t);
    // A model whose declared default (high) is below its top level: internal work sends 'default' instead of the chat's max.
    const provider = f.store.configurationService.provider(null, { name: 'Effort fixture', protocol: 'openai', baseUrl: f.store.state.configuration.providers.find(row => row.name === 'Fixture').baseUrl, apiKey: 'command-fixture-private-key', models: [{ id: 'effort-model', contextWindow: 64000, maxOutputTokens: 512, reasoning: ['low', 'high', 'max'], reasoningDiscovery: { efforts: ['low', 'high', 'max'], canDisable: false, providerDefault: 'high' } }] });
    f.store.mutate(state => { state.sessions.find(item => item.id === f.session.id).modelSelection = { providerId: provider.id, modelId: 'effort-model', reasoning: 'max' }; });
    if (setting) f.store.configurationService.update({ internalReasoning: setting });
    f.history();
    assert.equal((await f.command('compact', {}, 'compact-effort')).status, 'completed');
    assert.equal(f.calls.length, 1);
    return f.calls[0].reasoning_effort;
  };
  assert.equal(await sent(null), undefined, 'provider default: no effort on the wire');
  assert.equal(await sent({ mode: 'chat' }), 'max', 'the user\'s switch back to the chat\'s effort');
});

// P1 review compaction/D2: a summary prepared while idle was made without the user's focus.
async function prepareIdleSummary(f) {
  const { createSession } = await import('../../../packages/sdk/src/session.mjs');
  const { resolveModel } = await import('../configuration.mjs');
  const { idleSummaryFile } = await import('../idle-compaction-service.mjs');
  const file = f.history(), model = resolveModel(f.store.state.configuration, f.current().modelSelection);
  const handle = await createSession({ sessionId: f.session.id, projectId: f.project.id, cwd: f.directory, stateDir: join(`${f.store.file}.rna`, f.session.id), sessionFile: file, model, tools: [], autoCompaction: false });
  const plan = handle.prepareCompaction({ keepUserTurns: 2 }); await handle.dispose();
  assert.ok(plan);
  const prepared = { id: 'idle-r1', sessionId: f.session.id, trigger: 'idle', previousCompactionId: plan.previousCompactionId, throughMessageId: plan.throughMessageId, sourceDigest: plan.sourceDigest, summary: 'Idle background summary made without any focus.', archivedMessages: plan.archivedMessages, retainedMessages: plan.retainedMessages, requestId: 'r1', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, usageReported: true, model: plan.model, startedAt: 1, completedAt: 2, beforeTokens: plan.beforeTokens };
  writeFileSync(idleSummaryFile(file), JSON.stringify(prepared));
  f.store.mutate(state => { state.sessions.find(item => item.id === f.session.id).context.idleCompaction = { status: 'prepared', preparedId: 'idle-r1', basisAt: 1, at: new Date().toISOString() }; });
  return file;
}
test('/compact with a focus sets a prepared idle summary aside and summarizes the history with the focus', async t => {
  let fixture = null, held = null;
  // D6: the whole manual compaction runs under the per-session maintenance claim, so the idle planner sees it busy.
  const f = await setup(t, (_input, response) => { held = fixture.executor.maintenance.has(fixture.session.id); stream(response); }); fixture = f;
  const file = await prepareIdleSummary(f);
  const result = await f.command('compact', { instructions: 'Preserve file paths' }, 'compact-focused');
  assert.equal(held, true, 'the maintenance claim is held while the summary request runs');
  assert.equal(result.status, 'completed'); assert.equal(result.result.compacted, true);
  assert.equal(f.calls.length, 1, 'the focus reached a model');
  const sent = JSON.stringify(f.calls[0].messages);
  assert.match(sent, /Historical goal 0/); assert.match(sent, /Preserve file paths/); assert.doesNotMatch(sent, /Idle background summary/);
  const records = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.filter(row => row.type === 'compaction_prepared_discarded').map(row => [row.data.id, row.data.code]), [['idle-r1', 'superseded']]);
  assert.equal(records.filter(row => row.type === 'context_compaction').length, 1); assert.equal(records.find(row => row.type === 'context_compaction').data.preparedId, undefined);
  assert.deepEqual([f.current().context.idleCompaction.status, f.current().context.idleCompaction.code], ['discarded', 'superseded']);
});
test('/compact without a focus uses a prepared idle summary and says so when nothing newer needed summarizing', async t => {
  const f = await setup(t), file = await prepareIdleSummary(f);
  const result = await f.command('compact', {}, 'compact-background');
  assert.equal(result.status, 'completed'); assert.equal(result.result.compacted, true);
  assert.equal(f.calls.length, 0, 'no new summary was paid for');
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).find(row => row.type === 'context_compaction').data.preparedId, 'idle-r1');
  assert.equal(f.current().context.idleCompaction.status, 'committed');
  assert.ok(f.current().items.some(item => /后台空闲时准备好的摘要/.test(item.text ?? '')), 'the notice names the background summary, not a new one');
  assert.ok(!f.current().items.some(item => item.text === '已使用当前模型整理较早上下文；原始记录保留在会话日志中。'));
});

test('compact missing history is honest noop with no journal or paid call; pending tools fail closed', async t => {
  const f = await setup(t);
  const empty = await f.command('compact', {}, 'empty'); assert.equal(empty.status, 'noop'); assert.equal(f.calls.length, 0); assert.equal(existsSync(`${f.store.file}.rna`), false);
  f.history({ pending: true }); await assert.rejects(f.command('compact', {}, 'pending'), { code: 'busy' }); assert.equal(f.calls.length, 0);
});

test('truncated summary retains history and measured failure receipt; same request never repeats payment', async t => {
  const f = await setup(t, (_input, response) => stream(response, { finish: 'length' })), file = f.history();
  await assert.rejects(f.command('compact', {}, 'truncated'), { code: 'invalid_summary' });
  assert.equal(f.current().commandHistory[0].status, 'failed'); assert.equal(f.store.state.realUsage.tokens, 20);
  assert.ok(!readFileSync(file, 'utf8').includes('"type":"context_compaction"'));
  await assert.rejects(f.command('compact', {}, 'truncated'), { code: 'invalid_summary' }); assert.equal(f.calls.length, 1);
});

test('the conversation shows a compaction while it runs and then its outcome; a failure names its reason, also on a repeated request', async t => {
  const f = await setup(t, (_input, response, count) => count === 1 ? stream(response, { finish: 'length' }) : stream(response)); f.history();
  const progress = () => f.current().items.filter(item => item.kind === 'notice' && item.source === 'session-command');
  const failing = f.command('compact', {}, 'first');
  await assert.rejects(failing, error => error.code === 'invalid_summary' && /^上下文压缩未完成，原始对话已保留：模型没有返回完整的摘要/.test(error.message));
  assert.equal(progress().length, 1); assert.equal(progress()[0].progress, undefined, 'the progress line settled');
  assert.match(progress()[0].text, /^上下文压缩未完成，原始对话已保留：模型没有返回完整的摘要/);
  await assert.rejects(f.command('compact', {}, 'first'), error => /模型没有返回完整的摘要.*同一请求不会重复执行/.test(error.message));
  assert.equal(f.calls.length, 1, 'the same request is not run again');
  const done = await f.command('compact', {}, 'second');
  assert.equal(done.result.compacted, true); assert.equal(progress().length, 2);
  assert.equal(progress()[1].text, '已使用当前模型整理较早上下文；原始记录保留在会话日志中。'); assert.equal(progress()[1].progress, undefined);
});

test('real budget refusal makes zero HTTP requests and releases maintenance writer', async t => {
  const f = await setup(t); f.history(); f.store.mutate(state => { state.settings.realTokenBudget = 1; });
  await assert.rejects(f.command('compact', {}, 'budget'), { code: 'budget' });
  assert.equal(f.calls.length, 0); assert.equal(f.executor.maintenance.size, 0); assert.equal(f.store.state.realUsage.reservedTokens, 0);
});

test('new user input cancels compaction before foreground opens the same journal and never applies late summary', async t => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const f = await setup(t, async (_input, response, count) => { if (count === 1) { await held; stream(response); } else stream(response, { text: 'New request completed.' }); }), file = f.history();
  const compacting = f.command('compact', {}, 'cancelled'); const rejected = assert.rejects(compacting);
  await until(() => f.calls.length === 1); assert.equal(f.executor.maintenance.size, 1);
  f.store.message(f.session.id, { text: 'New request takes priority', requestId: 'new-input' });
  await rejected; release(); await until(() => f.current().turns[0]?.status === 'completed');
  assert.equal(f.current().commandHistory[0].status, 'interrupted'); assert.equal(f.calls.length, 2);
  assert.ok(!readFileSync(file, 'utf8').includes('"type":"context_compaction"'));
  assert.ok(f.store.state.realUsage.estimatedTokens > 0); assert.equal(f.store.state.realUsage.reservedTokens, 0);
});

test('drainMaintenance waits for cancellation and restart never replays a running command', async t => {
  const f = await setup(t); let done = false;
  const pending = f.executor.runMaintenance(f.session.id, signal => new Promise(resolve => signal.addEventListener('abort', () => { done = true; resolve(); }, { once: true })));
  await delay(0); await f.executor.drainMaintenance(f.session.id); await pending; assert.equal(done, true); assert.equal(f.executor.maintenance.size, 0);
  f.store.mutate(state => { state.sessions[0].commandHistory = [{ requestId: 'crash', command: 'compact', fingerprint: 'old', status: 'running' }]; state.sessions[0].items.push({ id: 'p', kind: 'notice', text: '正在用当前模型整理较早上下文', progress: true, commandRequestId: 'crash', source: 'session-command', createdAt: new Date().toISOString() }); });
  new SessionCommandService(f.store, { executor: f.executor }); assert.equal(f.current().commandHistory[0].status, 'interrupted'); assert.equal(f.calls.length, 0);
  const line = f.current().items.find(item => item.id === 'p'); assert.equal(line.progress, undefined); assert.match(line.text, /^上下文压缩被中断（服务重启或停止），原始对话已保留/);
});

test('journal path escapes are rejected before provider calls', async t => {
  const f = await setup(t), file = f.history(), foreign = join(f.directory, 'foreign.jsonl'); writeFileSync(foreign, readFileSync(file));
  f.store.mutate(state => { state.sessions[0].runtime.sessionFile = foreign; });
  await assert.rejects(f.command('compact', {}, 'foreign'), { code: 'invalid_path' }); assert.equal(f.calls.length, 0);
});

test('export is a valid bounded ZIP with one session and configured secrets redacted; no attachment reads', async t => {
  const f = await setup(t);
  f.store.mutate(state => { state.sessions[0].items.push({ id: 'export', kind: 'tool', text: 'command-fixture-private-key', tool: { name: 'tool', args: { api_key: 'unknown-secret', safe: 'visible' }, output: 'Bearer opaque-token' }, attachments: [{ name: 'binary.pdf', size: 10, path: '/should/never/be/read' }] }); });
  const output = f.service.export(f.session.id); assert.equal(output.contentType, 'application/zip');
  const file = join(f.directory, output.filename); writeFileSync(file, output.bytes);
  const result = JSON.parse(execFileSync('python3', ['-c', 'import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({"names":z.namelist(),"body":z.read("session.json").decode()}))', file], { encoding: 'utf8' }));
  assert.deepEqual(result.names, ['session.json', 'conversation.md', 'README.txt']);
  assert.ok(!result.body.includes('command-fixture-private-key')); assert.ok(!result.body.includes('unknown-secret')); assert.ok(!result.body.includes('opaque-token')); assert.ok(!result.body.includes('/should/never/be/read')); assert.match(result.body, /visible/);
});

test('manual compaction invalidates stale foreground usage and labels its tool-free maintenance estimate', async t => {
  const f = await setup(t); f.history();
  f.store.mutate(state => { const current = state.sessions[0]; current.context.usage = { estimatedInputTokens: 63000, capacity: 64000, outputReserve: 512, inputTrigger: 50688, status: 'ready', automaticEnabled: true, compactionId: 'old' }; });
  await f.command('compact', {}, 'manual-projection');
  assert.equal(f.current().context.usage, undefined);
  assert.equal(f.current().context.measurementScope, 'maintenance');
  assert.ok(f.current().context.tokens < 63000); assert.equal(f.current().context.capacity, 64000);
  assert.equal(f.current().context.compactions, 1); assert.equal(f.calls.length, 1);
});

test('failed manual summary clears stale compacting telemetry without claiming compression or changing prior size', async t => {
  const f = await setup(t, (_input, response) => stream(response, { finish: 'length' })); f.history();
  f.store.mutate(state => { const current = state.sessions[0]; current.context.tokens = 63000; current.context.usage = { status: 'compacting', estimatedInputTokens: 63000 }; });
  await assert.rejects(f.command('compact', {}, 'failed-projection'), { code: 'invalid_summary' });
  assert.equal(f.current().context.usage, undefined); assert.equal(f.current().context.tokens, 63000);
  assert.equal(f.current().context.compactions, 0); assert.equal(f.current().context.measurementScope, undefined);
  assert.equal(f.store.state.realUsage.tokens, 20);
});

test('manual cleanup cannot erase a successor runtime projection created during old handle disposal', async t => {
  const f = await setup(t, (_input, response) => stream(response, { finish: 'length' })); f.history();
  const originalFactory = f.service.factory;
  f.service.factory = async options => {
    const handle = await originalFactory(options), dispose = handle.dispose;
    return { ...handle, dispose: async () => {
      await dispose();
      f.store.mutate(state => { const current = state.sessions[0]; current.runtime.updatedAt = 'successor-runtime'; current.context.usage = { status: 'ready', estimatedInputTokens: 901 }; current.context.tokens = 901; });
    } };
  };
  await assert.rejects(f.command('compact', {}, 'successor-projection'), { code: 'invalid_summary' });
  assert.deepEqual(f.current().context.usage, { status: 'ready', estimatedInputTokens: 901 });
  assert.equal(f.current().context.tokens, 901); assert.equal(f.current().context.compactions, 0);
});
