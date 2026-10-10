import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { BuiltinAgentService } from '../builtin-agent-service.mjs';
import { UserInteractionService, reasonExcerpt, fullAccessNotice } from '../user-interaction-service.mjs';
import { ProjectPermissionService } from '../project-permissions.mjs';
import { RuntimeController } from '../runtime-controller.mjs';
import { SessionCommandService } from '../session-command-service.mjs';
import { openJournal } from '../../../packages/sdk/src/journal.mjs';
import { DelegationError } from '../../../packages/sdk/src/agent-delegation.mjs';

// UX audit 2026-10-03, team agents: F20 / F10 (subagent text), F88 (full-access notice), F78 (slash-command feedback).

function storeFixture(t, language = 'zh', configure = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-ux-agents-')), store = new Store(join(dir, 'private', 'state.json'));
  if (language !== 'zh') store.interfaceLanguage(language);
  configure(store);
  const { project, session } = store.createProject({ name: 'UX agents', workspace: dir, initiative: { enabled: false } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store, project, session, current: () => store.state.sessions.find(row => row.id === session.id) };
}

/** A running background child on the session's turn, settled straight through the service (no model calls). */
function childFixture(t, { language, idle = false } = {}) {
  const f = storeFixture(t, language);
  f.store.message(f.session.id, { text: 'Parent task', requestId: 'parent' });
  const turnId = f.current().activeTurnId, id = 'agent-ux-1', at = new Date().toISOString();
  f.store.mutate(state => {
    const session = state.sessions.find(row => row.id === f.session.id);
    session.turns.find(row => row.id === turnId).delegations = [{ id, role: 'scout', fingerprint: 'fp', status: 'running', task: 'Find the entry point.', background: true, createdAt: at, startedAt: at, usage: { totalTokens: 0 }, delivery: { status: 'awaiting', at } }];
    session.items.push({ id: 'sub-item', turnId, kind: 'subagent', text: '项目侦察 · Find the entry point.', createdAt: at, simulated: false, subagent: { agentId: id, role: 'scout', status: 'running' } });
    if (idle) { session.activeTurnId = null; session.status = 'idle'; }
  });
  const service = new BuiltinAgentService(f.store);
  t.after(() => service.close());
  const settle = outcome => service.settle({ id, sessionId: f.session.id, turnId, waiters: 0, cancelledBy: null }, outcome);
  return { ...f, service, id, settle, record: () => service.record(f.session.id, id) };
}

test('F20: a failed child is explained in plain words; the code stays in the record and in the model prompt only', t => {
  const f = childFixture(t);
  f.settle({ status: 'failed', error: new DelegationError('子任务未完成；保留原记录，未自动重试。', 'idle_timeout') });
  const record = f.record();
  assert.equal(record.code, 'idle_timeout');
  assert.equal(record.summary, '模型服务这次没有及时响应，子任务没做完；未自动重试。');
  assert.equal(f.current().items.find(row => row.id === 'sub-item').text, record.summary, 'the card shows the same sentence');
  const message = f.current().inbox.find(row => row.agentId === f.id);
  // F10 / C-c: the readable line travels with the steering message; the prompt is for the model.
  assert.equal(message.notice, '子代理未完成：项目侦察 · 模型服务这次没有及时响应，子任务没做完；未自动重试。');
  assert.doesNotMatch(message.notice, /agentId|idle_timeout|failed|scout|宿主通知/);
  // The prompt is fixed English for the model, whatever the interface language; the reason is the English sentence.
  assert.match(message.text, /^\[Host notice · subagent did not finish\] agentId=agent-ux-1 role=scout status=failed code=idle_timeout\nTask: Find the entry point\.\nReason: The model service did not respond in time, so the subtask did not finish\. It was not retried\.\n/);
  assert.doesNotMatch(message.text, /[一-鿿]/, 'no Chinese in the model-facing envelope');
});

test('F20: unknown and prototype-named codes fall back to the general sentence, never the code', t => {
  for (const code of ['delegation_failed', 'constructor', 'weird_code']) {
    const f = childFixture(t);
    f.settle({ status: 'failed', error: new DelegationError('x', code) });
    assert.equal(f.record().summary, '子任务没做完；未自动重试。', code);
  }
  const permission = childFixture(t);
  permission.settle({ status: 'failed', error: new DelegationError('x', 'delegation_permission') });
  assert.equal(permission.record().summary, '会话已不再允许修改项目，子任务停了下来；未自动重试。');
});

test('F20: a child the provider refused says what to fix (sign-in, access, quota, rate limit, a missing model), not "no complete reply"', async t => {
  for (const [status, code, language, expected] of [
    [401, 'invalid_api_key', 'zh', '模型登录或凭据无效、已过期，子任务没做完；未自动重试。请在模型设置中重新登录或更新 API Key。'],
    [403, 'permission_denied', 'en', 'These credentials or this plan cannot use the selected model, so the subtask did not finish. It was not retried; switch to an authorized model or check the provider permissions.'],
    [429, 'insufficient_quota', 'en', 'The model service is out of quota, so the subtask did not finish. It was not retried; check the provider account balance or switch to a model with quota.'],
    [429, 'rate_limit_exceeded', 'zh', '模型服务当前限流，子任务没做完；未自动重试。可以稍后再试，或切换其他模型。'],
    [404, 'model_not_found', 'zh', '模型服务找不到所选模型（可能已下线或改名），子任务没做完；未自动重试。请在模型设置中换一个可用的模型。']
  ]) {
    const server = http.createServer(async (request, response) => { for await (const _chunk of request); response.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0' }); response.end(JSON.stringify({ error: { message: 'echoed provider body', code } })); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const f = storeFixture(t, language, store => {
      const provider = store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'ux-agents-fixture-key', models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 512, reasoning: ['off'] }] });
      store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
    });
    f.store.message(f.session.id, { text: 'Parent task', requestId: 'parent' });
    const service = new BuiltinAgentService(f.store); t.after(() => service.close());
    const consult = service.createTools({ sessionId: f.session.id, turnId: f.current().activeTurnId }).find(tool => tool.name === 'agent_consult');
    await assert.rejects(consult.execute(`refused-${status}-${code}`, { role: 'scout', task: 'Inspect the project evidence.', wait: true }, new AbortController().signal));
    const record = f.current().turns[0].delegations[0];
    assert.equal(record.status, 'failed'); assert.equal(record.code, 'http_error', 'the code stays in the record');
    assert.equal(record.summary, expected, `${status} ${code}`);
  }
  // A failure without a provider answer keeps the code's sentence.
  const f = childFixture(t);
  f.settle({ status: 'failed', error: Object.assign(new DelegationError('x', 'http_error'), { details: { providerCategory: 'server_unavailable' } }) });
  assert.equal(f.record().summary, '模型服务这次没有返回完整的回复，子任务没做完；未自动重试。');
});

test('F10: in the English interface the notice, the role and the failure sentence are English', t => {
  const f = childFixture(t, { language: 'en', idle: true });
  f.settle({ status: 'failed', error: new DelegationError('x', 'http_error') });
  assert.equal(f.record().summary, 'The model service did not return a complete reply, so the subtask did not finish. It was not retried.');
  const notice = f.current().items.find(row => row.kind === 'notice' && row.source === 'subagent');
  assert.equal(notice.text, 'Subagent did not finish: Scout · The model service did not return a complete reply, so the subtask did not finish. It was not retried.');
  const done = childFixture(t, { language: 'en', idle: true });
  done.settle({ status: 'completed', result: { output: 'Entry point: src/index.js.' } });
  assert.equal(done.current().items.find(row => row.kind === 'notice' && row.source === 'subagent').text, 'Subagent finished: Scout · Entry point: src/index.js.');
});

test('a child that ran out of steps is not announced as simply finished; the parent model is told its work may be unfinished', t => {
  for (const [language, line] of [['zh', '子代理步数用完，已交回总结：项目侦察 · Looked at src only.'], ['en', 'Subagent ran out of steps and returned a summary: Scout · Looked at src only.']]) {
    const f = childFixture(t, { language, idle: true });
    f.settle({ status: 'completed', result: { output: 'Looked at src only.', stepLimitReached: true } });
    assert.equal(f.record().stepLimit, true);
    assert.equal(f.current().items.find(row => row.kind === 'notice' && row.source === 'subagent').text, line);
  }
  const running = childFixture(t);
  running.settle({ status: 'completed', result: { output: 'Looked at src only.', stepLimitReached: true } });
  const message = running.current().inbox.find(row => row.agentId === running.id);
  assert.equal(message.notice, '子代理步数用完，已交回总结：项目侦察 · Looked at src only.');
  assert.match(message.text, /Result: Looked at src only\.\nThe subagent ran out of steps; this is the summary it wrote at the limit, and some of the work may be unfinished\.\nThis is a background subtask result forwarded by the host/);
  const finished = childFixture(t);
  finished.settle({ status: 'completed', result: { output: 'All checked.' } });
  assert.equal(finished.record().stepLimit, undefined); assert.match(finished.current().inbox.find(row => row.agentId === finished.id).notice, /^子代理完成：/);
});

test('F20: restart recovery words the interruption in the interface language', t => {
  const f = childFixture(t, { language: 'en', idle: true });
  assert.equal(f.service.recover(), 1);
  assert.match(f.record().summary, /^The service restarted while the subtask was running/);
  assert.equal(f.record().code, 'delegation_interrupted');
  assert.match(f.current().items.find(row => row.kind === 'notice' && row.source === 'subagent').text, /^Subagent interrupted: Scout · The service restarted/);
});

test('F88: the reason is a bounded quote with tool ids named in words, cut at a sentence end with an ellipsis', () => {
  assert.equal(reasonExcerpt('需要 project_write/project_edit 修改 js/scenes.js', 'zh'), '需要 写文件/改文件 修改 js/scenes.js');
  assert.equal(reasonExcerpt('Use project_exec to build', 'en'), 'Use run commands to build');
  const long = `${'现在我在后台只能读文件，所以只能帮你复核。'.repeat(3)}允许后，我可以在后台直接接着做${'并同步更新'.repeat(30)}`;
  const cut = reasonExcerpt(long, 'zh');
  assert.ok(cut.length <= 120 && cut.endsWith('复核…'), cut);
  const unbroken = reasonExcerpt('x'.repeat(300), 'en');
  assert.equal(unbroken.length, 120); assert.ok(unbroken.endsWith('…'));
  // A hard cut does not leave half an emoji before the ellipsis.
  assert.equal(reasonExcerpt(`${'x'.repeat(118)}😀😀`, 'en'), `${'x'.repeat(118)}…`);
  assert.equal(reasonExcerpt(`${'x'.repeat(117)}😀😀`, 'en'), `${'x'.repeat(117)}😀…`);
  assert.equal(fullAccessNotice({ workspace: 'write', background: 'inherit' }, '', 'zh'), '已按「完全访问」自动允许修改项目文件（后台工作同样适用）。');
  assert.equal(fullAccessNotice({ workspace: 'execute', background: 'read' }, 'Run the build', 'en'), 'Allowed automatically under Full access: edit project files and run commands. Reason given: "Run the build"');
});

test('F88: a card settled by full access says first what was allowed, then quotes the reason', t => {
  for (const language of ['zh', 'en']) {
    const f = storeFixture(t, language);
    const interactions = new UserInteractionService(f.store), permissions = new ProjectPermissionService(f.store, interactions);
    t.after(() => interactions.close());
    permissions.update(f.project.id, { workspace: 'read', background: 'read' });
    const request = permissions.request(f.project.id, { workspace: 'write', background: 'inherit', reason: '现在我在后台只能读文件。允许后，我可以用 project_write 接着做' });
    const card = interactions.publishInitiative({ projectId: f.project.id, sessionId: f.session.id, actionId: `ux-${language}`, questions: request.questions, metadata: request.metadata });
    permissions.update(f.project.id, { workspace: 'execute', background: 'read' }); permissions.settleFullAccess(f.project.id);
    const notice = f.current().items.find(row => row.kind === 'notice' && row.source === 'full-access' && row.interactionId === card.id);
    assert.equal(notice.text, language === 'zh'
      ? '已按「完全访问」自动允许修改项目文件（后台工作同样适用）。申请理由：“现在我在后台只能读文件。允许后，我可以用 写文件 接着做”'
      : 'Allowed automatically under Full access: edit project files (background work included). Reason given: "现在我在后台只能读文件。允许后，我可以用 write files 接着做"');
  }
});

function sse(response, { finish = 'stop' } = {}) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Summary.' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
}
async function commandFixture(t, language, responder = (_input, response) => sse(response)) {
  const calls = [];
  const server = http.createServer(async (request, response) => { let raw = ''; for await (const chunk of request) raw += chunk; calls.push(JSON.parse(raw)); await responder(raw, response, calls.length); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const f = storeFixture(t, language, store => {
    const provider = store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'ux-agents-fixture-key', models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 512, reasoning: ['off'] }] });
    store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  });
  const executor = new RuntimeController(f.store), service = new SessionCommandService(f.store, { executor });
  t.after(async () => { await executor.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const history = () => {
    const journal = openJournal({ stateDir: join(`${f.store.file}.rna`, f.session.id), sessionId: f.session.id, projectId: f.project.id });
    for (let index = 0; index < 4; index++) {
      journal.append('message', { message: { id: `user-${index}`, role: 'user', source: 'user', timestamp: Date.now() - 60000, content: [{ type: 'text', text: `Goal ${index}. ${'Keep the evidence. '.repeat(100)}` }] } });
      journal.append('message', { message: { id: `assistant-${index}`, role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Done. '.repeat(100) }] } });
    }
    const file = journal.file; journal.close(); f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).runtime = { engine: 'rna', sessionId: f.session.id, sessionFile: file }; });
  };
  const notices = () => f.current().items.filter(row => row.kind === 'notice' && row.source === 'session-command').map(row => row.text);
  return { ...f, service, calls, history, notices, command: (name, args, requestId) => service.execute(f.session.id, { command: name, args, requestId }) };
}

test('F78: /plan, /goal and /feedback answer in the English interface', async t => {
  const f = await commandFixture(t, 'en');
  await f.command('plan', { mode: 'plan' }, 'plan-on'); await f.command('plan', { mode: 'build' }, 'plan-off');
  await f.command('goal', { text: 'Ship the editor' }, 'goal'); await f.command('feedback', { text: 'Fewer interruptions' }, 'feedback');
  assert.deepEqual(f.notices(), [
    'Plan mode is on: read-only investigation and discussion; writing files and running commands are off.',
    'Plan mode is off; later turns use the permissions the project has granted.',
    'Project focus updated: Ship the editor',
    'Project feedback saved: Fewer interruptions'
  ]);
  f.store.message(f.session.id, { text: 'Busy now', requestId: 'busy' });
  await assert.rejects(f.command('plan', { mode: 'plan' }, 'busy-plan'), error => error.code === 'session_busy' && error.message === 'Finish or stop the current turn before running this command.');
});

test('F78: /compact progress, outcome and failure follow the interface language; Chinese stays the default', async t => {
  const f = await commandFixture(t, 'en', (_raw, response, count) => sse(response, { finish: count === 1 ? 'length' : 'stop' })); f.history();
  await assert.rejects(f.command('compact', {}, 'first'), error => error.code === 'invalid_summary' && error.message === 'Context compaction did not finish; the original conversation is kept: The model did not return a complete summary. You can run it again.');
  assert.deepEqual(f.notices(), ['Context compaction did not finish; the original conversation is kept: The model did not return a complete summary. You can run it again.']);
  await assert.rejects(f.command('compact', {}, 'first'), error => /The same request is not run twice/.test(error.message));
  await f.command('compact', {}, 'second');
  assert.equal(f.notices()[1], 'Compacted the earlier context with the current model; the original record stays in the conversation log.');
  const zh = await commandFixture(t, 'zh');
  await zh.command('plan', { mode: 'plan' }, 'plan-zh');
  assert.deepEqual(zh.notices(), ['已进入计划模式：只读调查与讨论，写入和命令执行均停用。']);
});

test('F78: a provider refusal during /compact reads like a failed conversation turn, in the interface language, with the host status', async t => {
  const refuse = (status, code) => (_raw, response) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'echoed provider body', code } })); };
  for (const [language, status, code, expected] of [
    ['zh', 401, 'invalid_api_key', '上下文压缩未完成，原始对话已保留。模型登录或凭据无效、已过期。请在模型设置中重新登录或更新 API Key 后重试。（HTTP 401；供应商代码 invalid_api_key）'],
    ['en', 401, 'invalid_api_key', 'Context compaction did not finish; the original conversation is kept. The model sign-in or credentials are invalid or expired. Sign in again or update the API key in model settings, then retry. (HTTP 401; provider code invalid_api_key)'],
    ['en', 429, 'insufficient_quota', 'Context compaction did not finish; the original conversation is kept. The model service is out of quota. Check the provider account balance, or switch to an endpoint with quota, then retry. (HTTP 429; provider code insufficient_quota)'],
    ['zh', 403, 'permission_denied', '上下文压缩未完成，原始对话已保留。当前凭据没有访问所选模型或接入端点的权限。请切换已授权的模型或检查供应商权限后重试。（HTTP 403；供应商代码 permission_denied）']
  ]) {
    const f = await commandFixture(t, language, refuse(status, code)); f.history();
    await assert.rejects(f.command('compact', {}, `refused-${status}`), error => {
      assert.equal(error.message, expected); assert.equal(error.status, 502, 'the response carries the host status, not the provider\'s');
      return true;
    });
    assert.deepEqual(f.notices(), [expected], 'the progress line settles to the same words');
    assert.equal(f.current().commandHistory[0].message, expected);
  }
  // The host's own refusals keep their words and status.
  const f = await commandFixture(t, 'en'); f.history();
  const outside = join(f.dir, 'outside.jsonl'); writeFileSync(outside, '');
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).runtime.sessionFile = outside; });
  await assert.rejects(f.command('compact', {}, 'untrusted'), error => error.status === 409 && error.code === 'invalid_path' && error.message === 'The conversation log path is not trusted.');
  assert.equal(f.calls.length, 0);
});

test('F78: an interrupted compaction is reported in the interface language after a restart', async t => {
  const f = await commandFixture(t, 'en');
  f.store.mutate(state => { const session = state.sessions.find(row => row.id === f.session.id); session.commandHistory = [{ requestId: 'crash', command: 'compact', fingerprint: 'old', status: 'running' }]; session.items.push({ id: 'p', kind: 'notice', text: 'Compacting…', progress: true, commandRequestId: 'crash', source: 'session-command', createdAt: new Date().toISOString() }); });
  new SessionCommandService(f.store, { executor: null });
  assert.match(f.current().items.find(row => row.id === 'p').text, /^Context compaction was interrupted \(the service restarted or stopped\)/);
});
