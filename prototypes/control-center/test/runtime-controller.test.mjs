import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { projectGenomeFixture } from '../../../packages/sdk/test/fixtures/project-genome-fixture.mjs';
import { openJournal } from '../../../packages/sdk/src/journal.mjs';
import { saveAttachment } from '../session-attachments.mjs';
import { CORE_METHOD_SKILL_IDS } from '../../../packages/sdk/src/core-method-skills.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { RuntimeController } from '../runtime-controller.mjs';
import { streamCompletion } from '../../../packages/sdk/src/providers.mjs';
import { readStateFile } from '../state-shards.mjs';

async function until(check, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await delay(15); }
  throw new Error('Runtime condition did not settle');
}
function stream(res, content, { tool, cached = 4 } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
  chunk({ role: 'assistant' });
  if (tool) chunk({ tool_calls: [{ index: 0, id: 'tool-fixture', type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] });
  else { chunk({ content: content.slice(0, 3) }); chunk({ content: content.slice(3) }); }
  chunk({}, tool ? 'tool_calls' : 'stop', { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, prompt_tokens_details: { cached_tokens: cached } });
  res.end('data: [DONE]\n\n');
}
async function setup(t, respond, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-controller-')), calls = [];
  const provider = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = raw ? JSON.parse(raw) : {};
    calls.push({ path: request.url, input });
    await respond(input, response, calls.length, request.url);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const stateFile = join(directory, '.state', 'state.json');
  const app = createServer({ stateFile, ticks: false, ...options });
  // These protocol tests isolate chat; project bootstrap/migration has its own integration suite.
  await app.initializer.close();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const p = app.store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'fixture-private-key', models: [{ id: 'fixture-model', contextWindow: 32000, maxOutputTokens: 500, reasoning: ['off'] }] });
  app.store.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { session, project } = app.store.createProject({ name: 'Runtime integration', workspace: directory, initiative: { enabled: false } });
  const current = () => app.store.state.sessions.find(item => item.id === session.id);
  return { ...app, directory, calls, current, session, project, providerURL: `http://127.0.0.1:${provider.address().port}` };
}

test('真实运行路径向模型发送上传附件清单并按需读取已校验的文件内容', async t => {
  let attachment;
  const app = await setup(t, (input, res, count) => {
    if (count === 1) {
      assert.ok(JSON.stringify(input.messages).includes(attachment.id));
      assert.ok(input.tools.some(t => t.function.name === 'attachment_read'));
      return stream(res, '', { tool: { name: 'attachment_read', args: { id: attachment.id } } });
    }
    assert.ok(input.messages.some(m => m.role === 'tool' && String(m.content).startsWith('这是上传内容')));
    stream(res, '已读取上传文本');
  });
  ({ attachment } = saveAttachment(app.store, app.session.id, { name: '需求.txt', dataBase64: Buffer.from('这是上传内容').toString('base64') }));
  app.store.message(app.session.id, { text: '请读附件', attachments: [attachment] });
  await until(() => ['completed', 'failed'].includes(app.current().turns[0]?.status));
  assert.equal(app.current().turns[0].status, 'completed'); assert.equal(app.calls.length, 2);
  assert.equal(app.current().items.find(i => i.tool?.name === 'attachment_read').tool.status, 'succeeded');
});

test('an image-only HTTP submission reaches the configured provider through the actual attachment tool and SDK image serialization', async t => {
  const raster = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1kAAAAASUVORK5CYII=';
  let attachment;
  const app = await setup(t, (input, res, count) => {
    if (count === 1) {
      const user = input.messages.find(message => message.role === 'user' && !/^(Updated reference catalog|Host instructions)/.test(message.content));
      assert.match(user.content, /用户随消息上传的文件/); assert.ok(user.content.includes(attachment.id));
      return stream(res, '', { tool: { name: 'attachment_read', args: { id: attachment.id } } });
    }
    const toolIndex = input.messages.findIndex(message => message.role === 'tool' && message.tool_call_id === 'tool-fixture');
    const imageIndex = input.messages.findIndex(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url' && part.image_url.url === `data:image/png;base64,${raster}`));
    assert.ok(toolIndex >= 0); assert.ok(imageIndex > toolIndex, 'actual pixels must follow the complete tool result group');
    stream(res, '图像传输夹具已收到原始像素；这不是图像理解测试。');
  });
  const provider = app.store.configurationService.public().providers.find(provider => provider.id === app.store.state.configuration.defaultModel.providerId);
  app.store.configurationService.provider(provider.id, { ...provider, models: [{ ...provider.models[0], input: ['text', 'image'] }] });
  ({ attachment } = saveAttachment(app.store, app.session.id, { name: 'sample.png', dataBase64: raster }));
  const accepted = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/${app.session.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '', attachments: [{ id: attachment.id }], requestId: 'image-only-runtime' }) });
  assert.equal(accepted.status, 200); assert.equal((await accepted.json()).entry.text, '');
  await until(() => ['completed', 'failed'].includes(app.current().turns[0]?.status));
  assert.equal(app.current().turns[0].status, 'completed', JSON.stringify(app.current().items.filter(item => item.kind === 'notice')));
  assert.equal(app.calls.length, 2); assert.equal(app.current().items.find(item => item.tool?.name === 'attachment_read').tool.status, 'succeeded');
  assert.equal(app.current().items.find(item => item.kind === 'user').text, '', 'user transcript must not invent a request to describe the image');
});

test('真实 Rna SDK 回复进入 Store、提供商 usage/cache 透传、第二轮复用持久化会话', async t => {
  const app = await setup(t, (input, res) => stream(res, `reply:${JSON.stringify(input.messages.findLast(m => m.role === 'user' && ['first-user-message', 'second-user-message'].includes(m.content)).content)}`));
  app.store.message(app.session.id, { text: 'first-user-message', requestId: 'first' });
  await until(() => app.current().turns[0]?.status === 'completed');
  assert.match(app.current().items.findLast(item => item.kind === 'assistant').text, /first-user-message/);
  assert.equal(app.current().items.findLast(item => item.kind === 'assistant').final, true);
  assert.equal(app.current().turns[0].usage.cacheRead, 4);
  assert.equal(app.current().turns[0].modelConfig.execution, 'rna');
  assert.equal(app.current().usage.costStatus, 'unpriced');
  const file = app.current().runtime.sessionFile, rnaId = app.current().runtime.sessionId;
  assert.ok(readFileSync(file, 'utf8').includes('first-user-message'));
  app.store.message(app.session.id, { text: 'second-user-message' });
  await until(() => app.current().turns[1]?.status === 'completed');
  assert.equal(app.current().runtime.sessionId, rnaId);
  assert.equal(app.current().runtime.sessionFile, file);
  assert.ok(JSON.stringify(app.calls[1].input.messages).includes('first-user-message'));
  assert.equal(app.calls[0].input.max_completion_tokens, 500);
  assert.ok(!JSON.stringify(app.store.get()).includes('fixture-private-key'));
});

test('新用户请求取消旧 journal 中从未派发的命令，保留合法历史并真实写入新任务文件', async t => {
  const app = await setup(t, (_input, res, count) => count === 1
    ? stream(res, '', { tool: { name: 'project_write', args: { path: 'new-task.txt', content: 'new task completed', expectedHash: null } } })
    : count === 2 ? stream(res, '', { tool: { name: 'project_read', args: { path: 'new-task.txt' } } })
      : stream(res, '新任务文件已经写入并读回核对'));
  // Both capabilities are actually authorized: a replay bug would execute the
  // old command, not merely be hidden by the permission filter.
  app.permissions.update(app.project.id, { workspace: 'execute', background: 'read' });
  const journal = openJournal({ stateDir: join(`${app.store.file}.rna`, app.session.id), sessionId: app.session.id, projectId: app.project.id });
  journal.append('message', { message: { id: 'old-user', role: 'user', source: 'user', timestamp: Date.now() - 3600000, content: [{ type: 'text', text: '旧命令尚未派发' }] } });
  journal.append('message', { message: { id: 'old-assistant', role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'never-started-exec', name: 'project_exec', arguments: { command: 'printf old-command-ran > old-command-ran.txt' } }] } });
  const sessionFile = journal.file; journal.close();
  app.store.mutate(state => { state.sessions.find(session => session.id === app.session.id).runtime = { engine: 'rna', sessionId: app.session.id, sessionFile }; });
  const prompt = '新请求：请保存 new-task.txt';
  app.store.message(app.session.id, { text: prompt, requestId: 'new-after-never-started' });
  await until(() => ['completed', 'failed'].includes(app.current().turns[0]?.status));
  assert.equal(app.current().turns[0].status, 'completed'); assert.equal(app.calls.length, 3);
  assert.equal(readFileSync(join(app.directory, 'new-task.txt'), 'utf8'), 'new task completed');
  assert.equal(existsSync(join(app.directory, 'old-command-ran.txt')), false);
  const records = readFileSync(sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.some(record => record.type === 'tool_intent' && record.data.toolCallId === 'never-started-exec'), false);
  const messages = records.filter(record => ['message', 'tool_completed', 'request_completed'].includes(record.type)).map(record => record.data.message);
  const oldAssistant = messages.findIndex(message => message.id === 'old-assistant');
  const cancelled = messages.findIndex(message => message.role === 'toolResult' && message.toolCallId === 'never-started-exec');
  const newUsers = messages.filter(message => message.role === 'user' && message.content.some(part => part.text === prompt));
  assert.equal(newUsers.length, 1); assert.ok(cancelled > oldAssistant && messages.indexOf(newUsers[0]) > cancelled);
  assert.equal(JSON.parse(messages[cancelled].content[0].text).neverStarted, true);
  const wire = app.calls[0].input.messages, wireResult = wire.findIndex(message => message.role === 'tool' && message.tool_call_id === 'never-started-exec');
  assert.ok(wireResult >= 0); assert.equal(JSON.parse(wire[wireResult].content).neverStarted, true);
  assert.equal(wire.filter(message => message.role === 'user' && JSON.stringify(message.content).includes(prompt)).length, 1);
  assert.deepEqual(app.current().items.filter(item => item.tool).map(item => item.tool.name), ['project_write', 'project_read']);
});

test('真实 Rna 工具循环读取工作区；OpenViking 作为唯一记忆工具按项目范围调用', async t => {
  const app = await setup(t, (input, res, _count, path) => {
    if (path === '/api/v1/search/find') {
      assert.equal(input.target_uri, `viking://resources/projects/${app.project.id}`);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', result: { resources: [{ uri: `${input.target_uri}/note.md`, abstract: 'memory-from-openviking' }] } })); return;
    }
    const tools = input.messages.filter(message => message.role === 'tool');
    if (!tools.length) return stream(res, '', { tool: { name: 'project_read', args: { path: 'evidence.txt' } } });
    if (tools.length === 1) return stream(res, '', { tool: { name: 'openviking_search', args: { query: 'project-evidence', level: 'L0' } } });
    stream(res, 'workspace and OpenViking evidence received');
  });
  writeFileSync(join(app.directory, 'evidence.txt'), 'real-file-evidence');
  app.store.configurationService.update({ memory: { endpoint: app.providerURL } });
  app.store.message(app.session.id, { text: 'Read evidence and search project memory' });
  await until(() => app.current().turns[0]?.status === 'completed');
  const tools = app.current().items.filter(item => item.tool);
  assert.deepEqual(tools.map(item => item.tool.name), ['project_read', 'openviking_search']);
  assert.ok(tools.every(item => item.tool.status === 'succeeded'));
  assert.match(tools[0].tool.output, /real-file-evidence/);
  assert.match(tools[1].tool.output, /memory-from-openviking/);
  assert.equal(app.current().turns[0].memoryContext.execution, 'retrieved');
});

test('每轮自动关联跨层候选，模型按需展开目录概览和文件原文，动态记忆不进入system前缀', async t => {
  let modelCalls = 0;
  const app = await setup(t, (input, res, _count, path) => {
    const ns = `viking://resources/projects/${app.project.id}`;
    const send = result => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', result })); };
    if (path.startsWith('/api/v1/fs/ls')) return send([{ uri: `${ns}/design`, name: 'design', isDir: true }]);
    if (path === '/api/v1/search/find') { assert.equal(input.level, undefined); assert.equal(input.read_content, false); return send({ resources: [{ uri: `${ns}/design/.abstract.md`, level: 0, abstract: 'candidate-summary', score: .9 }, { uri: 'viking://resources/another-project/private.md', level: 2, abstract: 'foreign-secret' }] }); }
    if (path.startsWith('/api/v1/fs/stat')) return send({ isDir: true });
    if (path.startsWith('/api/v1/content/overview')) return send(`navigation-overview: read ${ns}/design/spec.md for evidence`);
    if (path.startsWith('/api/v1/content/read')) return send('precise-file-evidence');
    modelCalls++;
    if (modelCalls === 1) {
      assert.match(JSON.stringify(input.messages), /candidate-summary/); assert.ok(!JSON.stringify(input.messages).includes('foreign-secret'));
      assert.ok(!input.messages[0].content.includes('candidate-summary'));
      assert.ok(!JSON.stringify(input.messages).includes('precise-file-evidence'));
      return stream(res, '', { tool: { name: 'openviking_read', args: { uri: `${ns}/design`, level: 'L1' } } });
    }
    if (modelCalls === 2) { assert.match(JSON.stringify(input.messages), /navigation-overview/); return stream(res, '', { tool: { name: 'openviking_read', args: { uri: `${ns}/design/spec.md`, level: 'L2', offset: 0, limit: 20 } } }); }
    assert.match(JSON.stringify(input.messages), /precise-file-evidence/); stream(res, 'answer based on selected memory');
  });
  app.store.configurationService.update({ memory: { endpoint: app.providerURL, autoRecall: true } });
  app.store.message(app.session.id, { text: 'explain design constraints' });
  await until(() => app.current().turns[0]?.status === 'completed');
  const memory = app.current().turns[0].memoryContext;
  assert.equal(modelCalls, 3); assert.equal(memory.injectedEntries.length, 1); assert.equal(memory.stage, 'expanded');
  assert.deepEqual(new Set(memory.entries.map(entry => entry.level)), new Set(['L0', 'L1', 'L2']));
  assert.equal(memory.entries.find(entry => entry.level === 'L2').content, 'precise-file-evidence');
  const requests = app.calls.filter(call => call.path === '/v1/chat/completions');
  assert.equal(requests[0].input.messages[0].content, requests[2].input.messages[0].content);
});

test('关闭自动关联或未分配记忆搜索时不进行远端检索，失败如实记录且不中断普通对话', async t => {
  const app = await setup(t, (_input, res) => stream(res, 'normal answer'));
  let recalls = 0; app.store.memoryService.recall = async () => { recalls++; throw new Error('fixture unavailable'); };
  app.store.message(app.session.id, { text: 'auto recall disabled' }); await until(() => app.current().turns[0]?.status === 'completed');
  assert.equal(recalls, 0); assert.equal(app.current().turns[0].memoryContext.reason, 'auto-disabled');
  app.store.configurationService.update({ memory: { autoRecall: true } });
  app.store.mutate(state => { state.projects.find(project => project.id === app.project.id).assignments = { skillIds: [], toolIds: ['project_list'], mcpServerIds: [] }; });
  app.store.message(app.session.id, { text: 'not assigned' }); await until(() => app.current().turns[1]?.status === 'completed');
  assert.equal(recalls, 0); assert.equal(app.current().turns[1].memoryContext.execution, 'not-assigned');
  app.store.mutate(state => { delete state.projects.find(project => project.id === app.project.id).assignments; });
  app.store.message(app.session.id, { text: 'unavailable memory' }); await until(() => app.current().turns[2]?.status === 'completed');
  assert.equal(recalls, 1); assert.equal(app.current().turns[2].memoryContext.execution, 'unavailable');
  assert.ok(app.current().items.some(item => item.kind === 'notice' && item.text.includes('未关联记忆')));
  assert.match(JSON.stringify(app.calls.at(-1).input.messages), /lookup failed/);
});

test('有历史的会话在记忆预检索时暂停后恢复，不漏掉或重复本轮问题', async t => {
  const app = await setup(t, (_input, res) => stream(res, 'reply'));
  app.store.message(app.session.id, { text: 'finished prior question' }); await until(() => app.current().turns[0]?.status === 'completed');
  app.store.configurationService.update({ memory: { autoRecall: true } });
  let release, entered = false;
  app.store.memoryService.recall = async () => { entered = true; await new Promise(resolve => { release = resolve; }); return { entries: [], content: '', estimatedTokens: 0, candidateCount: 0, stage: 'summaries' }; };
  app.store.message(app.session.id, { text: 'second question must reach model' }); await until(() => entered);
  app.store.controlSession(app.session.id, 'pause'); release(); await until(() => app.executor.running.size === 0);
  assert.equal(app.calls.length, 1); assert.equal(app.current().turns[1].runtimeMessageId, undefined);
  app.store.memoryService.recall = async () => ({ entries: [], content: '', estimatedTokens: 0, candidateCount: 0, stage: 'summaries' });
  app.store.controlSession(app.session.id, 'resume'); await until(() => app.current().turns[1]?.status === 'completed');
  assert.equal(app.calls.length, 2); assert.equal(app.calls[1].input.messages.filter(message => message.role === 'user' && JSON.stringify(message.content).includes('second question must reach model')).length, 1);
  assert.ok(app.current().turns[1].runtimeMessageId);
});

test('预检索期间的插话等原始prompt提交后消费；停止预检索不会启动模型', async t => {
  const app = await setup(t, (_input, res) => stream(res, 'reply'));
  app.store.configurationService.update({ memory: { autoRecall: true } });
  let release, entered = false;
  app.store.memoryService.recall = async () => { entered = true; await new Promise(resolve => { release = resolve; }); return { entries: [], content: '', estimatedTokens: 0, candidateCount: 0, stage: 'summaries' }; };
  app.store.message(app.session.id, { text: 'original question' }); await until(() => entered);
  app.store.message(app.session.id, { text: 'steering while retrieving', delivery: 'steer' });
  await delay(25); assert.equal(app.calls.length, 0); release(); await until(() => app.current().turns[0]?.status === 'completed');
  const history = app.calls.at(-1).input.messages.filter(message => message.role === 'user' && !/^(Updated reference catalog|Host instructions)/.test(message.content)).map(message => JSON.stringify(message.content));
  assert.match(history[0], /original question/); assert.match(history[1], /steering while retrieving/);
  entered = false; const before = app.calls.length;
  app.store.message(app.session.id, { text: 'stopped before model' }); await until(() => entered);
  app.store.controlSession(app.session.id, 'stop'); release(); await until(() => app.executor.running.size === 0);
  assert.equal(app.calls.length, before);
});

test('转义密集的记忆按实际SDK投影裁减，自动关联不使普通问题超出预算', async t => {
  const app = await setup(t, (_input, res) => stream(res, 'reply within budget'));
  app.store.configurationService.update({ memory: { autoRecall: true, contextBudget: 1024 } });
  app.store.memoryService.recall = async () => {
    const entry = { uri: 'viking://resources/test/doc.md', expandUri: 'viking://resources/test/doc.md', level: 'L2', summary: '\\"'.repeat(1000) };
    return { entries: [entry], content: JSON.stringify([entry]), estimatedTokens: 900, candidateCount: 1, stage: 'summaries' };
  };
  app.store.message(app.session.id, { text: 'small question' }); await until(() => app.current().turns[0]?.status === 'completed');
  assert.equal(app.calls.length, 1); assert.equal(app.current().turns[0].memoryContext.execution, 'budget');
  assert.equal(app.current().turns[0].memoryContext.injectedEntries.length, 0);
});

test('Rna 接收 steer 在当前轮消费；followup 从宿主持久队列开启下一轮', async t => {
  let release, received;
  const waiting = new Promise(resolve => { received = resolve; });
  const app = await setup(t, async (input, res, count) => {
    if (count === 1) { received(); await new Promise(resolve => { release = resolve; }); }
    stream(res, `reply-${count}`);
  });
  app.store.message(app.session.id, { text: 'primary' }); await waiting;
  const steering = app.store.message(app.session.id, { text: 'change-direction', delivery: 'steer' });
  app.store.message(app.session.id, { text: 'followup-task', delivery: 'followup' });
  await until(() => app.current().inbox.some(item => item.deliveryStatus === 'accepted'));
  assert.throws(() => app.store.removeInbox(app.session.id, steering.entry.id), /Rna/);
  release();
  await until(() => app.current().turns.length === 2 && app.current().turns[1].status === 'completed');
  assert.equal(app.current().turns[0].steering.length, 1);
  assert.equal(app.current().inbox.length, 0);
  assert.equal(app.current().items.filter(item => item.text === 'change-direction').length, 1);
  assert.ok(JSON.stringify(app.calls[1].input.messages).includes('change-direction'));
  assert.ok(JSON.stringify(app.calls[2].input.messages).includes('followup-task'));
});

test('停止会中止真实HTTP，取回未消费消息，禁止晚到回复覆盖已停止轮次', async t => {
  let streaming;
  const app = await setup(t, (_input, res) => { streaming = res; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); });
  app.store.message(app.session.id, { text: 'long-request' }); await until(() => streaming);
  app.store.message(app.session.id, { text: 'not-consumed', delivery: 'followup' });
  const stopped = app.store.controlSession(app.session.id, 'stop');
  assert.equal(stopped.recovered[0].text, 'not-consumed');
  await until(() => app.executor.running.size === 0);
  assert.equal(app.current().turns[0].status, 'stopped');
  assert.equal(app.current().activeTurnId, null);
  assert.equal(app.calls.length, 1);
});

test('真实模型HTTP失败显示failed且不回退、不消费followup、不泄露凭据', async t => {
  const app = await setup(t, (_input, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture-private-key invalid' } })); });
  app.store.message(app.session.id, { text: 'fail-provider' });
  app.store.message(app.session.id, { text: 'keep-queued', delivery: 'followup' });
  await until(() => app.current().turns[0]?.status === 'failed');
  assert.equal(app.calls.length, 1);
  assert.equal(app.current().inbox[0].text, 'keep-queued');
  assert.ok(!JSON.stringify(app.store.get()).includes('fixture-private-key'));
  const file = app.current().runtime.sessionFile;
  assert.ok(!readFileSync(file, 'utf8').includes('fixture-private-key'));
});

// Exercise the verified official route classification over a local HTTP server;
// no request or credential can leave the fixture process.
const entitlementFixtureRuntime = options => createRnaRuntime({ ...options, provider: request => streamCompletion({
  ...request, model: { ...request.model, baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', modelId: 'glm-5.3-flashx' },
  fetch: (url, init) => { assert.equal(url, 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'); return fetch(`${request.model.baseUrl}/chat/completions`, init); }
}) });
const deniedDiagnostic = { status: 429, providerCode: '1311', category: 'model_access_denied', retryable: false };
function rejectEntitlement(res) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' }); res.end(JSON.stringify({ error: { code: '1311', message: 'fixture-private-key echoed-provider-private-body' } })); }

test('供应商1311权限错误在真实聊天宿主显示操作提示，单次请求且安全诊断可观测', async t => {
  const app = await setup(t, (_input, res) => rejectEntitlement(res), { runtimeFactory: entitlementFixtureRuntime });
  app.store.message(app.session.id, { text: 'tiny entitlement request' });
  await until(() => app.current().turns[0]?.status === 'failed');
  assert.equal(app.calls.length, 1);
  assert.deepEqual(app.current().turns[0].errorDiagnostic, { ...deniedDiagnostic, purpose: 'response' });
  const notices = app.current().items.filter(item => item.kind === 'notice').map(item => item.text).join('\n');
  assert.match(notices, /未授权.*模型/); assert.match(notices, /1311/); assert.doesNotMatch(notices, /当前限流|执行未完成/);
  const state = JSON.stringify(app.store.get()), journal = readFileSync(app.current().runtime.sessionFile, 'utf8');
  for (const contents of [state, journal]) { assert.ok(!contents.includes('fixture-private-key')); assert.ok(!contents.includes('echoed-provider-private-body')); }
});

test('自动压缩的1311拒绝传到宿主：回复后的压缩失败只提示不判失败且不逐轮重试，请求前的压缩失败才终止本轮', async t => {
  const app = await setup(t, (input, res) => input.messages[0].content.startsWith('Summarize the provided') ? rejectEntitlement(res) : stream(res, 'Verified fixture evidence. '.repeat(800)), { runtimeFactory: entitlementFixtureRuntime });
  for (let i = 0; i < 10; i++) {
    app.store.message(app.session.id, { text: `Fixture task ${i}` });
    await until(() => ['completed', 'failed'].includes(app.current().turns.at(-1)?.status));
    if (app.current().turns.at(-1).status === 'failed') break;
  }
  const turn = app.current().turns.at(-1), deferred = app.current().turns.find(row => row.compactionUsage?.length);
  assert.equal(turn.status, 'failed');
  assert.deepEqual(turn.errorDiagnostic, { ...deniedDiagnostic, purpose: 'compaction' });
  assert.deepEqual(turn.compactionUsage.at(-1).errorDiagnostic, { ...deniedDiagnostic, purpose: 'compaction' });
  assert.notEqual(deferred.id, turn.id); assert.equal(deferred.status, 'completed', 'a summary after the answer cannot fail the answered turn');
  const notices = app.current().items.filter(item => item.kind === 'notice');
  assert.ok(notices.some(item => item.turnId === deferred.id && /上下文压缩未完成，原始对话已保留/.test(item.text) && /未授权/.test(item.text)));
  assert.match(notices.map(item => item.text).join('\n'), /上下文压缩未完成，原始对话已保留/);
  assert.equal(app.calls.filter(call => call.input.messages[0].content.startsWith('Summarize the provided')).length, 2, 'one after an answer, then only the blocking attempt; never one per turn');
  assert.ok(app.current().items.some(item => item.kind === 'assistant' && item.text.includes('Verified fixture evidence.')));
  const journal = readFileSync(app.current().runtime.sessionFile, 'utf8'); assert.ok(!journal.includes('echoed-provider-private-body')); assert.ok(!journal.includes('fixture-private-key'));
});

test('本地图片能力拒绝在宿主明确提示视觉模型，不显示连接或凭据猜测', async t => {
  const app = await setup(t, () => assert.fail('Local capability rejection must not call a provider'), { runtimeFactory: async () => { throw Object.assign(new Error('private implementation detail'), { code: 'image_capability_unknown' }); } });
  app.store.message(app.session.id, { text: 'read previously attached screenshot' });
  await until(() => app.current().turns[0]?.status === 'failed');
  assert.equal(app.calls.length, 0); assert.equal(app.current().turns[0].errorDiagnostic.category, 'vision_required');
  const notices = app.current().items.filter(item => item.kind === 'notice').map(item => item.text).join('\n');
  assert.match(notices, /图像输入.*刷新模型目录.*已识别支持图片的模型/); assert.doesNotMatch(notices, /private implementation detail|执行未完成|凭据/);
});

test('真实会话重启后保持暂停和持久化版本，显式恢复旧版历史且下一轮采用新版本', async t => {
  let started;
  const app = await setup(t, (_input, res, count) => {
    if (count === 1) { started = true; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': holding\n\n'); }
    else stream(res, 'resumed-from-Rna-history');
  });
  const genomes = new ProjectGenomeStore(app.store);
  for (const versionId of ['pinned-v1', 'selected-v2']) {
    const prepared = await genomes.prepare(app.project, { genome: projectGenomeFixture(versionId), versionId }); await prepared.commit();
    app.store.mutate(state => { const project = state.projects.find(item => item.id === app.project.id); project.versions.push({ id: versionId, bundle: prepared.record, generatedSkills: prepared.skillManifests, generatedTools: prepared.toolDescriptors }); project.initialization = { status: 'ready' }; project.simulated = false; project.decisionMode = 'rna-model'; project.activeVersionId = 'pinned-v1'; });
  }
  app.store.message(app.session.id, { text: 'persist-me-once' }); await until(() => started);
  const rnaId = app.current().runtime.sessionId; assert.equal(app.current().turns[0].projectVersionId, 'pinned-v1'); assert.match(app.calls[0].input.messages[0].content, /pinned-v1/);
  await app.close();
  app.store.mutate(state => { state.projects.find(item => item.id === app.project.id).activeVersionId = 'selected-v2'; });
  assert.equal(readStateFile(app.store.file).state.sessions[0].turns[0].projectVersionId, 'pinned-v1');
  const resumed = createServer({ stateFile: app.store.file, ticks: false });
  await new Promise(resolve => resumed.server.listen(0, '127.0.0.1', resolve));
  t.after(() => resumed.close());
  assert.equal(resumed.store.state.sessions[0].status, 'paused');
  await delay(80); assert.equal(app.calls.length, 1);
  resumed.store.controlSession(app.session.id, 'resume');
  await until(() => resumed.store.state.sessions[0].turns[0].status === 'completed');
  assert.equal(resumed.store.state.sessions[0].runtime.sessionId, rnaId);
  assert.equal(resumed.store.state.sessions[0].runtime.projectVersionId, 'pinned-v1'); assert.equal(app.calls[1].input.messages[0].content, app.calls[0].input.messages[0].content);
  const userMessages = app.calls[1].input.messages.filter(message => message.role === 'user');
  assert.equal(userMessages.filter(message => JSON.stringify(message.content).includes('persist-me-once')).length, 1);
  assert.ok(JSON.stringify(userMessages).includes('interrupted response')); 
  resumed.store.message(app.session.id, { text: 'use-new-project-version' }); await until(() => resumed.store.state.sessions[0].turns[1]?.status === 'completed'); assert.equal(resumed.store.state.sessions[0].turns[1].projectVersionId, 'selected-v2'); assert.match(app.calls[2].input.messages[0].content, /selected-v2/);
});

test('真实执行尊重并发槽位与请求前 token 预算，演示 tick 不推进真实轮次', async t => {
  let first;
  const app = await setup(t, (_input, res, count) => { if (count === 1) { first = res; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': holding\n\n'); } else stream(res, 'second-finished'); });
  const second = app.store.createSession({ workspace: app.directory });
  app.store.message(app.session.id, { text: 'first-run' }); await until(() => first);
  app.store.message(second.id, { text: 'second-run' });
  app.store.tick(); await delay(60);
  assert.equal(app.calls.length, 1);
  assert.equal(app.store.state.sessions.find(s => s.id === second.id).turns[0].stage, 0);
  app.store.controlSession(app.session.id, 'stop');
  await until(() => app.store.state.sessions.find(s => s.id === second.id).turns[0].status === 'completed');
  app.store.settings({ realTokenBudget: 0 });
  app.store.message(second.id, { text: 'no-budget' });
  await until(() => app.store.state.sessions.find(s => s.id === second.id).turns[1].status === 'failed');
  assert.equal(app.calls.length, 2);
});

test('已接收但未消费的原生 steer 可按稳定消息 ID 撤回', async t => {
  let release; const entered = new Promise(resolve => { release = { entered: resolve }; });
  const app = await setup(t, async (_input, res, count) => {
    if (count === 1) { release.entered(); await new Promise(resolve => { release.finish = resolve; }); }
    stream(res, 'done');
  });
  app.store.message(app.session.id, { text: 'primary' }); await entered;
  const queued = app.store.message(app.session.id, { text: 'withdraw-before-consumption', delivery: 'steer' });
  await until(() => app.current().inbox.find(item => item.id === queued.entry.id)?.deliveryStatus === 'accepted');
  const removed = await app.executor.withdraw(app.session.id, queued.entry.id); assert.equal(removed.recovered.text, 'withdraw-before-consumption');
  release.finish(); await until(() => app.current().turns[0].status === 'completed');
  assert.equal(app.calls.length, 1); assert.equal(app.current().inbox.length, 0); assert.equal(app.current().turns[0].steering.length, 0);
});

test('旧 Pi 轨迹保留但不读入新的 Rna 模型上下文', async t => {
  const app = await setup(t, (_input, res) => stream(res, 'new runtime'));
  const legacyFile = join(app.directory, 'old-pi.jsonl'), legacyText = 'LEGACY-PI-CONTEXT-NEVER-REPLAY'; writeFileSync(legacyFile, legacyText);
  app.store.mutate(state => { state.sessions.find(item => item.id === app.session.id).runtime = { engine: 'pi', piSessionId: 'old-pi-session', sessionFile: legacyFile }; });
  app.store.message(app.session.id, { text: 'new context' }); await until(() => app.current().turns[0]?.status === 'completed');
  assert.equal(app.current().runtime.engine, 'rna'); assert.ok(app.current().runtime.sessionFile.includes('.rna/'));
  assert.equal(app.current().legacyRuntime.sessionFile, legacyFile); assert.equal(readFileSync(legacyFile, 'utf8'), legacyText);
  assert.ok(!JSON.stringify(app.calls[0].input).includes(legacyText)); assert.ok(app.current().items.some(item => item.kind === 'notice' && item.text.includes('未自动读取旧 Pi')));
});

test('项目模型生成的能力分配直接限制实际请求工具目录', async t => {
  const app = await setup(t, (_input, res) => stream(res, 'assigned tools'));
  app.store.mutate(state => { const project = state.projects.find(item => item.id === app.project.id); project.initialization = { status: 'ready' }; project.assignments = { skillIds: ['project-analysis'], toolIds: ['project_list'], mcpServerIds: [] }; });
  app.store.message(app.session.id, { text: 'use assigned abilities' }); await until(() => app.current().turns[0]?.status === 'completed');
  assert.deepEqual(app.calls[0].input.tools.map(item => item.function.name).filter(name => !name.startsWith('capability_') && !['agent_consult', 'agent_delegate', 'agent_status', 'agent_message', 'agent_wait', 'agent_cancel', 'agent_merge', 'agent_claude_consult'].includes(name)), ['ask_user', 'attachment_read', 'marketplace_read', 'marketplace_search', 'mcp', 'mcp_call', 'project_document_read', 'project_list', 'project_plan', 'project_preview', 'project_schedule', 'project_schedule_list', 'request_project_permission', 'skill_load', 'tool_output_read']);
  assert.ok(!app.calls[0].input.tools.some(item => ['project_write', 'project_exec', 'project_read'].includes(item.function.name)));
  assert.deepEqual(app.current().runtime.assignedCapabilities.skillIds, ['project-analysis', ...CORE_METHOD_SKILL_IDS]);
});

test('saved read-only project permissions expose schedule inspection without schedule mutation', async t => {
  const app = await setup(t, (_input, res) => stream(res, 'read only schedule inspection'));
  app.store.mutate(state => { const project = state.projects.find(item => item.id === app.project.id); project.permissions = { workspace: 'read', background: 'read' }; });
  app.store.message(app.session.id, { text: '查看日程' }); await until(() => app.current().turns[0]?.status === 'completed');
  const names = app.calls[0].input.tools.map(item => item.function.name);
  // Tiered tools: schedule mutation stays declared (stable prefix) but the read
  // grant rejects it at execution; unassigned workspace writes stay undeclared.
  assert.ok(names.includes('project_schedule_list')); assert.ok(names.includes('project_schedule'));
  assert.match(JSON.stringify(app.calls[0].input.messages), /declaredButUnavailable[^\]]*project_schedule/);
  assert.ok(!names.includes('project_write')); assert.ok(!names.includes('project_exec'));
});

test('停止后取回的 steer 不会在下一次新请求从 SDK 队列重复发出', async t => {
  let started;
  const app = await setup(t, (_input, res, count) => { if (count === 1) { started = true; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': held\n\n'); } else stream(res, 'next'); });
  app.store.message(app.session.id, { text: 'first' }); await until(() => started);
  app.store.message(app.session.id, { text: 'must-not-reappear', delivery: 'steer' }); await until(() => app.current().inbox[0]?.deliveryStatus === 'accepted');
  app.store.controlSession(app.session.id, 'stop'); await until(() => app.executor.running.size === 0);
  app.store.message(app.session.id, { text: 'fresh request' }); await until(() => app.current().turns[1]?.status === 'completed');
  assert.equal(app.calls.length, 2); assert.ok(!JSON.stringify(app.calls[1].input.messages).includes('must-not-reappear'));
});

test('exhausted demo counters never block uncapped real requests, including multiple tool steps', async t => {
  const app = await setup(t, (input, res) => input.messages.some(message => message.role === 'tool') ? stream(res, 'measured-result') : stream(res, '', { tool: { name: 'project_read', args: { path: 'evidence.txt' } } }));
  writeFileSync(join(app.directory, 'evidence.txt'), 'fixture evidence');
  app.store.mutate(state => { state.usage.tokens = 104990; state.usage.usd = 100; state.settings.tokenBudget = 1; state.settings.dailyBudget = 0; });
  app.store.message(app.session.id, { text: 'Read evidence.txt' }); await until(() => app.current().turns[0].status === 'completed');
  assert.equal(app.calls.length, 2); assert.equal(app.store.state.settings.realTokenBudget, null);
  assert.equal(app.store.state.realUsage.tokens, 40); assert.equal(app.store.state.realUsage.reportedTokens, 40); assert.equal(app.store.state.realUsage.reservedTokens, 0);
  assert.equal(app.store.state.usage.tokens, 104990); assert.equal(app.store.state.usage.usd, 100);
});

test('cancelled unreported provider requests release reservations and retain explicit estimated usage', async t => {
  let entered = false;
  const app = await setup(t, (_input, res) => { entered = true; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting-for-cancel\n\n'); });
  app.store.message(app.session.id, { text: 'cancel before usage' }); await until(() => entered);
  const reserved = app.store.state.realUsage.reservedTokens; assert.ok(reserved > 0);
  app.store.controlSession(app.session.id, 'stop'); await until(() => app.store.state.realUsage.reservedTokens === 0 && app.executor.running.size === 0);
  assert.equal(app.store.state.realUsage.estimatedTokens, reserved); assert.equal(app.store.state.realUsage.reportedTokens, 0); assert.equal(app.store.state.usage.tokens, 0);
});

test('one live real request reservation prevents a concurrent request exceeding an explicit real cap', async t => {
  let entered = false;
  const app = await setup(t, (_input, res) => { entered = true; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': held\n\n'); });
  app.store.settings({ maxConcurrent: 2 });
  app.store.message(app.session.id, { text: 'hold one' }); await until(() => entered);
  const reserved = app.store.state.realUsage.reservedTokens; app.store.settings({ realTokenBudget: reserved });
  const second = app.store.createSession({ workspace: app.directory }); app.store.message(second.id, { text: 'must wait for allowance' });
  await until(() => app.store.state.sessions.find(session => session.id === second.id).turns[0].status === 'failed');
  assert.equal(app.calls.length, 1); assert.equal(app.store.state.realUsage.reservedTokens, reserved);
  app.store.controlSession(app.session.id, 'stop'); await until(() => app.store.state.realUsage.reservedTokens === 0);
});

test('automatic context summaries use the configured HTTP provider, reserve and settle separately, and preserve transcript evidence', async t => {
  let summaries = 0;
  const app = await setup(t, (input, res) => {
    if (input.messages[0]?.content?.startsWith('Summarize the provided')) { summaries++; assert.equal(input.tools, undefined); stream(res, 'The authorized task is discussion only. Earlier replies discussed fixture evidence. Continue without writing files.'); }
    else stream(res, 'Evidence from a completed discussion. '.repeat(400));
  });
  const provider = app.store.configurationService.public().providers.find(provider => provider.id === app.store.state.configuration.defaultModel.providerId);
  // 0.63 added agent_merge to the delegation tools: the fixed prefix grew, so the window has room for it and still compacts.
  app.store.configurationService.provider(provider.id, { ...provider, models: [{ id: 'fixture-model', contextWindow: 24000, maxOutputTokens: 500, reasoning: ['off'] }] });
  for (let index = 0; index < 10; index++) {
    app.store.message(app.session.id, { text: `Discuss fixture evidence ${index}; no writes authorized.` });
    await until(() => ['completed', 'failed'].includes(app.current().turns[index]?.status));
    assert.equal(app.current().turns[index].status, 'completed', JSON.stringify(app.current().items.filter(item => item.kind === 'notice')));
  }
  assert.ok(summaries > 0); assert.equal(app.store.state.realUsage.reportedTokens, app.calls.length * 20); assert.equal(app.store.state.realUsage.reservedTokens, 0); assert.equal(app.store.state.realUsage.estimatedTokens, 0);
  assert.equal(app.current().usage.tokens, app.calls.length * 20); assert.equal(app.current().turns.reduce((sum, turn) => sum + turn.usage.totalTokens, 0), app.calls.length * 20);
  const records = readFileSync(app.current().runtime.sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(record => record.type === 'compaction_request_completed').length, summaries);
  assert.ok(records.some(record => record.type === 'message' && JSON.stringify(record).includes('fixture evidence 0')));
});

function seedInterruptedTool(app, name, args) {
  const journal = openJournal({ stateDir: join(`${app.store.file}.rna`, app.session.id), sessionId: app.session.id, projectId: app.project.id });
  journal.append('message', { message: { id: 'old-user', role: 'user', source: 'user', timestamp: Date.now() - 3600000, content: [{ type: 'text', text: 'previous task' }] } });
  journal.append('message', { message: { id: 'old-assistant', role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'interrupted', name, arguments: args }] } });
  journal.append('tool_intent', { callKey: 'old-assistant/interrupted', toolCallId: 'interrupted', toolName: name, arguments: args, effect: 'write', idempotent: false });
  const sessionFile = journal.file; journal.close();
  app.store.mutate(state => { state.sessions.find(session => session.id === app.session.id).runtime = { engine: 'rna', sessionId: app.session.id, sessionFile }; });
  return sessionFile;
}

test('legacy interrupted edit is inspected before the next instruction and never replayed', async t => {
  const app = await setup(t, (input, res, count) => {
    assert.match(JSON.stringify(input.messages), /historical outcome is not claimed/);
    assert.equal(readFileSync(join(app.directory, 'main.js'), 'utf8'), 'const n = 1;');
    return count === 1 ? stream(res, '', { tool: { name: 'project_write', args: { path: 'next.txt', content: 'latest instruction delivered', expectedHash: null } } }) : stream(res, 'done');
  });
  app.permissions.update(app.project.id, { workspace: 'execute', background: 'read' });
  writeFileSync(join(app.directory, 'main.js'), 'const n = 1;');
  const file = seedInterruptedTool(app, 'project_edit', { path: 'main.js', oldText: 'n = 1', newText: 'n = 2' });
  app.store.message(app.session.id, { text: 'continue new task' });
  await until(() => app.current().turns[0]?.status === 'completed');
  assert.equal(readFileSync(join(app.directory, 'main.js'), 'utf8'), 'const n = 1;');
  assert.equal(readFileSync(join(app.directory, 'next.txt'), 'utf8'), 'latest instruction delivered');
  const records = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(row => row.type === 'tool_intent' && row.data.toolName === 'project_edit').length, 1);
  assert.equal(records.filter(row => row.type === 'tool_recovery_observation').length, 1);
  assert.ok(records.some(row => row.type === 'tool_checkpoint' && row.data.checkpoint.path === 'next.txt'), 'native checkpoint survives capability registry');
});

test('unknown command exposes durable resolution and preserves new steering across retries without replay', async t => {
  const app = await setup(t, (input, res) => {
    assert.match(JSON.stringify(input.messages), /WITHOUT confirming its historical outcome/);
    assert.match(JSON.stringify(input.messages), /latest steering wins/);
    stream(res, 'continued after explicit resolution');
  });
  app.permissions.update(app.project.id, { workspace: 'execute', background: 'read' });
  const file = seedInterruptedTool(app, 'project_exec', { command: 'printf replayed > forbidden-replay.txt' });
  app.store.message(app.session.id, { text: 'new pending task' });
  await until(() => app.current().status === 'paused' && !app.executor.running.size);
  assert.equal(app.calls.length, 0); assert.equal(app.current().pauseReason, 'recovery');
  const key = app.current().runtime.recovery.uncertainTools[0].callKey;
  app.store.message(app.session.id, { text: 'latest steering wins' });
  await until(() => app.current().status === 'paused' && !app.executor.running.size);
  assert.equal(app.current().inbox.length, 1); assert.equal(app.calls.length, 0);
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/${app.session.id}/recovery`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callKey: key, status: 'abandoned', note: 'Checked current files; old outcome is unknown. Retire old call.' }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).remaining, 0);
  app.store.controlSession(app.session.id, 'resume');
  await until(() => app.current().turns[0]?.status === 'completed');
  assert.equal(app.current().inbox.length, 0); assert.equal(existsSync(join(app.directory, 'forbidden-replay.txt')), false);
  const records = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(row => row.type === 'tool_intent' && row.data.toolName === 'project_exec').length, 1);
  assert.equal(records.filter(row => ['message', 'inbox_claimed'].includes(row.type) && row.data.message.role === 'user' && row.data.message.content.some(block => block.text === 'latest steering wins')).length, 1);
  assert.equal(app.calls.length, 1);
});

test('retry retains the original user turn and completed failure evidence without duplicate prompt', async t => {
  const app = await setup(t, (_input, res, count) => count === 1 ? (res.writeHead(401), res.end('{}')) : stream(res, 'retry successful'));
  app.store.message(app.session.id, { text: 'retry original request' });
  await until(() => app.current().turns[0]?.status === 'failed' && !app.executor.running.size);
  const turnId = app.current().turns[0].id;
  app.store.controlSession(app.session.id, 'retry');
  await until(() => app.current().turns[0]?.status === 'completed');
  assert.equal(app.current().turns.length, 1); assert.equal(app.current().turns[0].id, turnId);
  assert.equal(app.current().turns[0].retryHistory.length, 1);
  assert.equal(app.current().items.filter(item => item.kind === 'user' && item.text === 'retry original request').length, 1);
});

test('HTTP retry after a real step limit consumes accepted steering once on the original turn without replaying completed tools', async t => {
  let lastResponse;
  const prompt = 'Inspect the existing evidence', steering = 'Change direction and report the checked evidence only';
  const app = await setup(t, (input, res, count) => {
    if (count === 1) return stream(res, '', { tool: { name: 'project_read', args: { path: 'evidence.txt' } } });
    if (count === 2) { lastResponse = res; return; }
    assert.equal(count, 3);
    assert.equal(input.messages.filter(message => message.role === 'user' && message.content === prompt).length, 1);
    assert.equal(input.messages.filter(message => message.role === 'user' && message.content === steering).length, 1);
    assert.ok(input.messages.some(message => message.role === 'tool' && message.content.includes('checked evidence')));
    stream(res, 'The checked evidence is retained and the new direction is complete.');
  }, { runtimeFactory: options => createRnaRuntime({ ...options, maxSteps: 2, stepLimitBehavior: 'error' }) });
  // A small real SDK limit isolates the same boundary without changing the
  // production default of 64 or spending 64 model requests in this fixture.
  writeFileSync(join(app.directory, 'evidence.txt'), 'checked evidence');
  app.store.message(app.session.id, { text: prompt });
  await until(() => lastResponse);
  const queued = app.store.message(app.session.id, { text: steering, delivery: 'steer' });
  await until(() => app.current().inbox[0]?.deliveryStatus === 'accepted');
  const nativeId = app.current().inbox[0].runtimeInboxId;
  stream(lastResponse, '', { tool: { name: 'project_read', args: { path: 'evidence.txt' } } });
  await until(() => app.current().turns[0]?.status === 'failed' && !app.executor.running.size);
  const turnId = app.current().turns[0].id, file = app.current().runtime.sessionFile;
  const records = () => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const completedBefore = records().filter(row => row.type === 'tool_completed').map(row => row.data.callKey);
  assert.equal(app.current().turns[0].errorCode, 'step_limit');
  assert.match(app.current().items.findLast(item => item.source === 'runtime-error').text, /步骤保护上限/);
  assert.equal(app.current().inbox[0].id, queued.entry.id); assert.equal(app.current().inbox[0].runtimeInboxId, nativeId);
  assert.equal(app.calls.length, 2, 'Failure does not issue automatic paid retries');
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/${app.session.id}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'retry' }) });
  assert.equal(response.status, 200); await response.json();
  await until(() => app.current().turns[0]?.status === 'completed' && !app.executor.running.size);
  assert.equal(app.calls.length, 3); assert.equal(app.current().turns.length, 1); assert.equal(app.current().turns[0].id, turnId);
  assert.equal(app.current().turns[0].errorCode, undefined); assert.equal(app.current().turns[0].retryHistory[0].errorCode, 'step_limit');
  assert.equal(app.current().inbox.length, 0);
  assert.equal(app.current().items.filter(item => item.kind === 'user' && item.text === prompt).length, 1);
  assert.equal(app.current().items.filter(item => item.submissionId === queued.entry.id && item.text === steering).length, 1);
  assert.equal(records().filter(row => row.type === 'inbox_added' && row.data.item.id === nativeId).length, 1);
  assert.equal(records().filter(row => row.type === 'inbox_claimed' && row.data.message.inboxId === nativeId).length, 1);
  assert.deepEqual(records().filter(row => row.type === 'tool_completed').map(row => row.data.callKey), completedBefore);
});

test('foreground crosses scheduling slices automatically, keeps one turn and consumes steering exactly once', async t => {
  let held;
  const prompt = 'Read the evidence and finish the requested investigation';
  const steering = 'Report only verified facts';
  const app = await setup(t, (input, res, count) => {
    if (count === 2) { held = res; return; }
    if (count < 5) return stream(res, '', { tool: { name: 'project_read', args: { path: 'evidence.txt' } } });
    assert.equal(count, 5);
    assert.equal(input.messages.filter(m => m.role === 'user' && m.content === prompt).length, 1);
    assert.equal(input.messages.filter(m => m.role === 'user' && m.content === steering).length, 1);
    stream(res, 'All requested evidence has been checked.');
  }, { runtimeFactory: options => createRnaRuntime({ ...options, maxSteps: 2 }) });
  writeFileSync(join(app.directory, 'evidence.txt'), 'slice evidence');
  app.store.message(app.session.id, { text: prompt });
  await until(() => held);
  const queued = app.store.message(app.session.id, { text: steering, delivery: 'steer' });
  await until(() => app.current().inbox[0]?.deliveryStatus === 'accepted');
  const nativeId = app.current().inbox[0].runtimeInboxId;
  stream(held, '', { tool: { name: 'project_read', args: { path: 'evidence.txt' } } });
  await until(() => app.current().turns[0]?.status === 'completed' && !app.executor.running.size);
  const turn = app.current().turns[0];
  assert.equal(app.calls.length, 5); assert.equal(app.current().turns.length, 1); assert.equal(turn.runtimeAttempts, 1);
  assert.equal(turn.continuation.segments, 2); assert.equal(turn.continuation.status, 'completed');
  assert.equal(app.current().inbox.length, 0); assert.equal(turn.errorCode, undefined);
  assert.equal(app.current().items.filter(item => item.submissionId === queued.entry.id).length, 1);
  assert.equal(app.current().items.some(item => item.source === 'runtime-error'), false);
  const records = readFileSync(app.current().runtime.sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(r => r.type === 'run_yielded').length, 2);
  assert.equal(records.filter(r => r.type === 'inbox_claimed' && r.data.message.inboxId === nativeId).length, 1);
  const calls = records.filter(r => r.type === 'tool_completed').map(r => r.data.callKey);
  assert.equal(calls.length, 4); assert.equal(new Set(calls).size, 4);
  assert.equal(records.filter(r => r.type === 'message' && r.data.message.source === 'resume').length, 0);
  assert.equal(app.store.state.realUsage.reportedTokens, 100);
});

test('real SDK cancellation during automatic compaction settles the final context projection before writer disposal', async t => {
  let summarizing = false;
  const app = await setup(t, (input, res) => {
    assert.ok(input.messages.find(message => message.role === 'system')?.content.startsWith('Summarize the provided'));
    summarizing = true;
    // No artificial usage receipt: interruption must keep the existing
    // conservative reserved-charge policy, while clearing only display state.
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'unfinished summary' }, finish_reason: null }] })}\n\n`);
  });
  const journal = openJournal({ stateDir: join(`${app.store.file}.rna`, app.session.id), sessionId: app.session.id, projectId: app.project.id });
  for (let i = 0; i < 6; i++) {
    journal.append('message', { message: { id: `prior-user-${i}`, role: 'user', source: 'user', timestamp: Date.now() - 60000, content: [{ type: 'text', text: `goal-${i} ${'verified historical requirement '.repeat(400)}` }] } });
    journal.append('message', { message: { id: `prior-assistant-${i}`, role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'verified historical result '.repeat(400) }] } });
  }
  const file = journal.file; journal.close();
  app.store.mutate(state => { state.sessions[0].runtime = { engine: 'rna', sessionId: app.session.id, sessionFile: file }; });
  app.store.message(app.session.id, { text: 'Continue the requested task.' });
  await until(() => summarizing && app.current().context.usage?.status === 'compacting');
  const before = app.current().context.tokens;
  app.store.controlSession(app.session.id, 'pause');
  await until(() => !app.executor.running.size);
  assert.equal(app.current().status, 'paused'); assert.equal(app.current().turns[0].status, 'paused');
  assert.equal(app.current().context.usage.status, 'ready'); assert.equal(app.current().context.usage.requestId, undefined);
  assert.equal(app.current().context.tokens, before); assert.equal(app.current().context.compactions, 0);
  assert.equal(app.calls.length, 1); assert.equal(app.store.state.realUsage.reservedTokens, 0);
  assert.ok(app.store.state.realUsage.estimatedTokens > 0);
  const records = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(row => row.type === 'context_compaction').length, 0);
  assert.equal(records.filter(row => row.type === 'compaction_request_completed').length, 1);
});

test('incremental memory hook runs only after actual yielded tool batches settle and before the next response', async t => {
  const checkpoints = [];
  const app = await setup(t, (_input, res, count) => count <= 2
    ? stream(res, '', { tool: { name: 'project_read', args: { path: 'checkpoint.txt' } } })
    : stream(res, 'Verified evidence completed.'), { runtimeFactory: options => createRnaRuntime({ ...options, maxSteps: 1 }) });
  writeFileSync(join(app.directory, 'checkpoint.txt'), 'stable checkpoint evidence');
  const original = app.store.checkpointRuntimeMemory.bind(app.store);
  app.store.checkpointRuntimeMemory = (sessionId, turnId) => {
    const current = app.current(), items = current.items.filter(item => item.turnId === turnId);
    checkpoints.push({ sessionId, turnId, requestCount: app.calls.length, tools: items.filter(item => item.kind === 'tool').map(item => item.tool.status), streaming: items.some(item => item.streaming), reasons: items.filter(item => item.kind === 'assistant').map(item => item.stopReason) });
    return original(sessionId, turnId);
  };
  app.store.message(app.session.id, { text: 'Read evidence and finish.' });
  await until(() => app.current().turns[0]?.status === 'completed' && !app.executor.running.size);
  assert.equal(checkpoints.length, 2); assert.deepEqual(checkpoints.map(item => item.requestCount), [1, 2]);
  assert.ok(checkpoints.every(item => !item.streaming && item.tools.every(status => status === 'succeeded') && item.reasons.every(reason => reason === 'toolUse')));
  assert.ok(checkpoints.every(item => item.sessionId === app.session.id && item.turnId === app.current().turns[0].id));
  assert.equal(app.calls.length, 3);
});

test('a delivered proactive message joins the next foreground request as bounded context, not a fake user instruction', async t => {
  let held;
  const app = await setup(t, (input, res, count) => {
    if (count === 1) { held = res; return; }
    assert.equal(count, 2);
    const body = JSON.stringify(input.messages);
    assert.match(body, /delivered-project-messages/); assert.match(body, /实际调查发现：测试覆盖缺口在路径边界/);
    assert.doesNotMatch(body, /尚未送达的推测/);
    stream(res, 'The visible finding is understood alongside the current work.');
  });
  writeFileSync(join(app.directory, 'evidence.txt'), 'evidence');
  app.store.message(app.session.id, { text: 'Continue the current investigation' });
  await until(() => held);
  app.store.mutate(state => {
    const current = state.sessions.find(s => s.id === app.session.id);
    current.items.push({ id: 'proactive-delivered', kind: 'assistant', source: 'initiative', turnId: null, initiativeActionId: 'action-delivered', evidenceIds: ['observed-gap'], text: '实际调查发现：测试覆盖缺口在路径边界', createdAt: new Date().toISOString(), simulated: false });
    current.items.push({ id: 'proactive-revoked', kind: 'assistant', source: 'initiative', contextRevoked: true, text: '尚未送达的推测', createdAt: new Date().toISOString() });
  });
  stream(held, '', { tool: { name: 'project_read', args: { path: 'evidence.txt' } } });
  await until(() => app.current().turns[0].status === 'completed' && !app.executor.running.size);
  const records = readFileSync(app.current().runtime.sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
  // TC-2: one window-scoped block per delivered message (complete and immutable), the guide once; no revoked entry.
  const context = records.find(r => r.type === 'message' && r.data.message.contextKey === 'project-collaboration:proactive-delivered');
  assert.ok(context); assert.equal(context.data.message.source, 'context'); assert.equal(context.data.message.contextScope, 'window');
  assert.equal(JSON.parse(context.data.message.context[0].text).kind, 'collaborator_finding');
  assert.ok(records.some(r => r.type === 'message' && r.data.message.contextKey === 'project-collaboration-guide'));
  assert.ok(!records.some(r => r.type === 'message' && r.data.message.contextKey === 'project-collaboration:proactive-revoked'));
  assert.equal(records.filter(r => r.type === 'message' && r.data.message.source === 'user').length, 1);
  assert.equal(app.current().items.filter(i => i.id === 'proactive-delivered').length, 1);
});

test('answering a nonblocking initiative question informs the live foreground without fabricating authorization or another prompt', async t => {
  let held;
  const app = await setup(t, (input, res, count) => {
    if (count === 1) { held = res; return; }
    assert.equal(count, 2);
    const body = JSON.stringify(input.messages);
    assert.match(body, /user_answer/); assert.match(body, /优先核对边界/);
    assert.match(body, /permissionChangedByHost/);
    assert.equal(input.tools.some(t => t.function.name === 'project_exec'), false);
    stream(res, '已根据选择调整核对顺序');
  });
  writeFileSync(join(app.directory, 'evidence.txt'), 'question evidence');
  app.store.message(app.session.id, { text: 'Review the current project' });
  await until(() => held);
  const question = app.interactions.publishInitiative({ projectId: app.project.id, sessionId: app.session.id, actionId: 'initiative-ask-live', questions: [{ id: 'focus', question: '优先核对哪一部分？', options: [{ id: 'boundary', label: '优先核对边界' }, { id: 'typical', label: '先核对常见流程' }], allowCustom: true }] });
  app.interactions.answer(app.session.id, question.id, { requestId: 'live-answer', answers: [{ id: 'focus', selected: ['boundary'], custom: '' }] });
  assert.equal(app.current().status, 'running');
  stream(held, '', { tool: { name: 'project_read', args: { path: 'evidence.txt' } } });
  await until(() => app.current().turns[0].status === 'completed' && !app.executor.running.size);
  assert.equal(app.current().turns.length, 1);
  assert.equal(app.current().items.filter(i => i.source === 'interaction-answer').length, 1);
  const records = readFileSync(app.current().runtime.sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(r => r.type === 'message' && r.data.message.source === 'user').length, 1);
  const update = records.find(r => r.type === 'message' && r.data.message.contextKey?.startsWith('project-collaboration:'));
  assert.ok(update); assert.equal(JSON.parse(update.data.message.context[0].text).permissionChangedByHost, false);
});

// Spec p1 compaction §D6: the turn's session learns the model's cache survival; turn-only notes are turn-scoped; a
// conversation holding the pre-0.66 mind or collaboration block gets each tombstone once.
test('the factory gets the learned cache survival; turn notes are turn-scoped; legacy blocks get one tombstone', async t => {
  let options;
  const app = await setup(t, (_input, res) => stream(res, 'Done.'), { runtimeFactory: value => { options = value; return createRnaRuntime(value); } });
  app.executor.survival = { estimate: model => ({ coldAfterMs: model?.modelId === 'fixture-model' ? 8239341 : null, warmMaxMs: model?.modelId === 'fixture-model' ? 6424780 : null }) };
  app.store.message(app.session.id, { text: 'Hello' });
  await until(() => app.current().turns[0]?.status === 'completed' && !app.executor.running.size);
  assert.equal(options.cacheSurvivalMs, 8239341); assert.equal(options.cacheWarmMaxMs, 6424780, 'the longest warm gap seen: what the fork counts on while no survival is known (review of C5)');
  // TC-3 keep-alive: the session's idle check counts from the conversation's last keep-alive ping (none here).
  assert.equal(typeof options.cacheRefreshedAt, 'function'); assert.equal(options.cacheRefreshedAt(), null);
  const ledger = app.store.usageLedger; app.store.usageLedger = { lastKeepAlive: id => id === app.session.id ? 1234 : null };
  assert.equal(options.cacheRefreshedAt(), 1234); app.store.usageLedger = ledger;
  // C5: what a cache read and write cost against an uncached token, resolved from the live configuration for the session's
  // current model; the SDK computes the share a warm edit must free from it. No price: null (a warm cache is left alone).
  assert.equal(typeof options.cachePricing, 'function'); assert.equal(options.cachePricing({ providerId: 'unknown', modelId: 'fixture-model' }), null);
  assert.equal(options.cachePricing({ providerId: app.store.state.configuration.defaultModel.providerId, modelId: 'fixture-model' }), null, 'a custom endpoint is unpriced');
  const deepseek = app.store.configurationService.provider(null, { presetId: 'deepseek', apiKey: 'fixture-only-not-a-key' }), glmPlan = app.store.configurationService.provider(null, { presetId: 'glm-coding', apiKey: 'fixture-only-not-a-key' });
  const listed = options.cachePricing({ providerId: deepseek.id, modelId: 'deepseek-v4-pro' });
  assert.deepEqual([listed.input, listed.cacheRead, listed.cacheWrite, listed.reference], [0.66, 0.022, null, false], 'the billed list price');
  const plan = options.cachePricing({ providerId: glmPlan.id, modelId: 'glm-5.3' });
  assert.deepEqual([plan.input, plan.cacheRead, plan.reference], [8, 2, true], 'a Coding Plan is not billed per token: a reference price, for this decision only');
  const controller = Object.create(RuntimeController.prototype);
  Object.assign(controller, { store: { state: { sessions: [{ id: 's', items: [], turns: [{ id: 'one' }, { id: 'two' }] }], projects: [] } }, admitSteering: async () => {} });
  const legacy = { messages: [{ id: 'm1', role: 'user', source: 'context', contextKey: 'project-mind', context: [{ source: 'host-project-mind', text: '{"lessons":[]}' }] }, { id: 'm2', role: 'user', source: 'context', contextKey: 'project-collaboration', context: [{ source: 'delivered-project-messages', text: '{"messages":[]}' }] }] };
  const context = { sessionId: 's', turnId: 'two', routeHints: { hints: ['h'] }, feedbackSent: true };
  const first = (await controller.prepareRequest(context, { snapshot: legacy })).contextUpdates;
  assert.deepEqual(first.map(row => [row.key, row.scope ?? 'conversation']), [['turn-route-hints', 'turn'], ['project-collaboration', 'conversation']]);
  // (No mind context this turn: the mind tombstone rides with the next mind update.)
  assert.equal(first[1].accumulates, true, 'the collaboration tombstone declares the old sliding window accumulating (FOLD-1)');
  const tombstoned = { messages: [...legacy.messages, ...first.map((row, index) => ({ id: `t${index}`, role: 'user', source: 'context', contextKey: row.key, ...(row.scope ? { contextScope: row.scope } : {}), ...(row.accumulates ? { contextAccumulates: true } : {}), context: [{ source: row.source, text: row.text }] }))] };
  assert.equal(await controller.prepareRequest({ ...context, routeHintsSent: true, mindContext: Promise.resolve([{ key: 'project-mind-rules', source: 'host-project-mind', text: '{"rules":[]}', empty: true }]) }, { snapshot: tombstoned }).then(value => value?.contextUpdates?.filter(row => row.key === 'project-collaboration').length ?? 0), 0, 'the collaboration tombstone is sent once');
  const mind = await controller.prepareRequest({ ...context, routeHintsSent: true, mindContext: Promise.resolve([{ key: 'project-mind-rules', source: 'host-project-mind', text: '{"rules":[1]}', empty: false }]) }, { snapshot: tombstoned });
  assert.deepEqual(mind.contextUpdates.map(row => row.key), ['project-mind-rules', 'project-mind'], 'the mind tombstone rides with the new blocks');
  assert.deepEqual(JSON.parse(mind.contextUpdates[1].text).moved, ['project-mind-rules', 'project-mind-notes', 'project-mind-turn']);
});

// C4: a delivered project message the user took back leaves the model at once. Its tombstone supersedes the earlier copy,
// and the request also asks the SDK to fold that copy (`revokeContext`, key of the entry), so the text itself is gone from
// the request — not only said to be withdrawn beside it.
test('a delivered message the project withdrew: the request folds the earlier copy of it together with the tombstone', async () => {
  const { projectConversationUpdates } = await import('../project-conversation-context.mjs');
  const finding = id => ({ id, kind: 'assistant', source: 'initiative', initiativeActionId: `action-${id}`, text: `Observed ${id}`, evidenceIds: ['evidence'], createdAt: '2026-09-25T07:00:00Z' });
  const items = [finding('f1'), finding('f2')], held = projectConversationUpdates({ id: 's', projectId: 'p', items });
  const snapshot = { messages: held.map((row, index) => ({ id: `m${index}`, role: 'user', source: 'context', contextKey: row.key, ...(row.scope ? { contextScope: row.scope } : {}), context: [{ source: row.source, text: row.text }] })) };
  const controller = Object.create(RuntimeController.prototype);
  const run = list => { Object.assign(controller, { store: { state: { sessions: [{ id: 's', projectId: 'p', items: list, turns: [{ id: 'one' }, { id: 'two' }] }], projects: [{ id: 'p' }] } }, admitSteering: async () => {} }); return controller.prepareRequest({ sessionId: 's', turnId: 'two', routeHintsSent: true, feedbackSent: true }, { snapshot }); };
  assert.equal((await run(items))?.revokeContext, undefined, 'nothing withdrawn: nothing to fold');
  const request = await run([{ ...finding('f1'), contextRevoked: true }, finding('f2')]);
  assert.deepEqual(request.revokeContext.map(row => row.contextKeys), [['project-collaboration:f1']], 'only the withdrawn entry\'s copies');
  assert.equal(typeof request.revokeContext[0].before, 'number');
  assert.ok(request.contextUpdates.some(row => row.key === 'project-collaboration:f1' && JSON.parse(row.text).withdrawn === true), 'the tombstone rides along (the SDK appends it after the fold, so it stays)');
  assert.ok(request.contextUpdates.every(row => !('withdrawn' in row)), 'the host marker never reaches the SDK');
});

// C4 (review finding 1): a revocation folds the copies of the three mind blocks in every conversation of the project. A block whose
// current text equals the copy just folded must still be offered again in that request — filtered as "already visible" it would
// leave the conversation without the project's standing rules for good (the copy folded is still in the journal, with the same text).
test('a revocation that folds the mind blocks: the unchanged rules block is offered again, on this request and after it', async () => {
  const RULES = { key: 'project-mind-rules', source: 'host-project-mind', text: '{"block":"project-mind-rules","rules":[{"id":"l1"}]}', empty: false };
  const copy = (row, id, timestamp) => ({ id, role: 'user', source: 'context', contextKey: row.key, timestamp, context: [{ source: row.source, text: row.text }] });
  const revocation = { id: 'rev-1', type: 'session_deleted', at: new Date(2000).toISOString(), context: { keys: ['project-mind-rules', 'project-mind-notes', 'project-mind-turn'], sourceIds: [] }, steps: {}, attempts: 0 };
  const session = { id: 's', projectId: 'p', items: [], turns: [{ id: 'one' }, { id: 'two' }] };
  const make = (applied = [], foreground = null) => { const controller = Object.create(RuntimeController.prototype); session.revocationsApplied = applied; Object.assign(controller, { store: { state: { sessions: [session], projects: [{ id: 'p', mind: { revocations: [revocation] } }] } }, admitSteering: async () => {}, mind: foreground ? { foregroundContext: foreground } : undefined }); return controller; };
  const snapshot = { messages: [copy(RULES, 'm1', 1000)] };
  const base = { sessionId: 's', turnId: 'two', routeHintsSent: true, feedbackSent: true };
  // The request that asks for the fold: the rules block is in the offer although its text is the visible copy's.
  const asked = await make().prepareRequest({ ...base, mindContextAt: 3000, mindContext: Promise.resolve([RULES]) }, { snapshot });
  assert.deepEqual(asked.revokeContext.map(row => row.id), ['rev-1']);
  assert.deepEqual(asked.contextUpdates.map(row => row.key), ['project-mind-rules'], 'offered again together with the fold');
  // The conversation applied it (the SDK folded the copy and the host recorded it) but the request carried no mind blocks: the next
  // turn offers the block again, because the journal's latest copy of the key is the one that was folded.
  const later = await make(['rev-1']).prepareRequest({ ...base, mindContext: Promise.resolve([RULES]) }, { snapshot });
  assert.equal(later.revokeContext, undefined);
  assert.deepEqual(later.contextUpdates.map(row => row.key), ['project-mind-rules'], 'an applied revocation does not leave the key looking visible');
  // A copy the host appended after the cut is current content: not folded, not offered twice.
  const fresh = await make(['rev-1']).prepareRequest({ ...base, mindContext: Promise.resolve([RULES]) }, { snapshot: { messages: [copy(RULES, 'm1', 1000), copy(RULES, 'm2', 5000)] } });
  assert.equal(fresh, undefined, 'the latest copy was made after the revocation');
  // A revocation made after this turn's blocks were worked out (a tool call took a while): they are worked out again from the mind
  // as it is now, and offered in this request (the first-request copy of the turn is folded, so it would leave nothing).
  let asks = 0;
  const midTurn = make([], async options => { asks++; assert.equal(options.refresh, true, 'a second look counts no second recall'); return [RULES]; });
  const sent = await midTurn.prepareRequest({ ...base, mindContextAt: 1500, mindSent: true, mindPrompt: 'hello', mindContext: Promise.resolve([{ ...RULES, text: '{"block":"project-mind-rules","rules":[{"id":"stale"}]}' }]) }, { snapshot });
  assert.equal(asks, 1); assert.deepEqual(sent.contextUpdates.map(row => row.key), ['project-mind-rules']);
  assert.ok(sent.contextUpdates[0].text.includes('"l1"') && !sent.contextUpdates[0].text.includes('stale'), 'the blocks of the earlier look are not offered');
  // A turn that started after the revocation already holds the current content: no second look.
  const current = make([], async () => { asks++; return [RULES]; });
  await current.prepareRequest({ ...base, mindContextAt: 3000, mindContext: Promise.resolve([RULES]) }, { snapshot });
  assert.equal(asks, 1);
});

for (const boundaryControl of ['pause', 'stop', 'budget']) test(`a ${boundaryControl} at a yielded boundary prevents any automatic paid continuation`, async t => {
  let controlled = false;
  const app = await setup(t, (_input, res, count) => {
    if (count <= 2) stream(res, '', { tool: { name: 'project_read', args: { path: 'evidence.txt' } } });
    else stream(res, 'Continued only after an explicit resume');
  }, { runtimeFactory: options => createRnaRuntime({ ...options, maxSteps: 2, onEvent(event) {
    options.onEvent(event);
    if (event.type === 'run_yielded' && !controlled) {
      controlled = true;
      if (boundaryControl === 'budget') app.store.settings({ realTokenBudget: app.store.state.realUsage.tokens });
      else app.store.controlSession(app.session.id, boundaryControl);
    }
  } }) });
  writeFileSync(join(app.directory, 'evidence.txt'), 'boundary evidence');
  app.store.message(app.session.id, { text: 'Read until finished' });
  await until(() => controlled && !app.executor.running.size);
  await delay(30);
  assert.equal(app.calls.length, 2);
  assert.equal(app.current().turns[0].status, boundaryControl === 'pause' ? 'paused' : boundaryControl === 'stop' ? 'stopped' : 'failed');
  if (boundaryControl === 'budget') assert.equal(app.current().turns[0].errorCode, 'budget');
  if (boundaryControl === 'pause') {
    app.store.controlSession(app.session.id, 'resume');
    await until(() => app.current().turns[0].status === 'completed' && !app.executor.running.size);
    assert.equal(app.calls.length, 3); assert.equal(app.current().turns.length, 1);
    const records = readFileSync(app.current().runtime.sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.filter(r => r.type === 'tool_completed').length, 2);
  }
});

for (const outcome of ['settled', 'uncertain', 'cancelled']) test(`foreground tool runtime waits for background writer handoff: ${outcome}`, async t => {
  let entered = false, release;
  const app = await setup(t, (_input, res) => stream(res, 'A clean handoff completed'));
  app.executor.prepareForeground = async (_projectId, { signal }) => {
    entered = true;
    await new Promise(resolve => { release = resolve; });
    signal.throwIfAborted();
    // The background host words its refusal for the user (prepareForeground); the conversation shows it as is (C2-b).
    if (outcome === 'uncertain') throw Object.assign(new Error('后台有一项工作的结果还没核对，这一轮先没有改动工作区。请到任务页 · 待核对确认它的结果，再重试这一轮。'), { code: 'background_recovery_required' });
  };
  app.store.message(app.session.id, { text: 'Start after the writer settles' });
  await until(() => entered); assert.equal(app.calls.length, 0);
  if (outcome === 'cancelled') app.store.controlSession(app.session.id, 'stop');
  release();
  await until(() => !app.executor.running.size);
  assert.equal(app.calls.length, outcome === 'settled' ? 1 : 0);
  if (outcome === 'uncertain') {
    assert.equal(app.current().turns[0].errorCode, 'background_recovery_required');
    assert.equal(app.current().items.findLast(i => i.source === 'runtime-error').text, '后台有一项工作的结果还没核对，这一轮先没有改动工作区。请到任务页 · 待核对确认它的结果，再重试这一轮。');
  }
});

test('a background task stopped for a foreground turn is named in the conversation and handed to the turn as context', async t => {
  const app = await setup(t, (_input, res) => stream(res, '接着扩写第 22 章。'));
  app.executor.prepareForeground = async () => [{ id: 'act-1', task: '有界一轮扩容：Ch22–30 逐章扩到 3000 字以上。', detail: '有界一轮扩容：Ch22–30 逐章扩到 3000 字以上。先扩 Ch22、Ch23。' }];
  app.store.message(app.session.id, { text: '继续' });
  await until(() => app.current().turns[0]?.status === 'completed' && !app.executor.running.size);
  const notice = app.current().items.find(item => item.kind === 'notice' && item.source === 'background-stop');
  assert.match(notice?.text ?? '', /^已先停下后台的「有界一轮扩容：Ch22–30 逐章扩到 3000 字以上。」，由这一轮接着做/);
  const sent = JSON.stringify(app.calls[0]);
  assert.match(sent, /先扩 Ch22、Ch23/); assert.match(sent, /do not repeat what is already done/);
});

function seedInterruptedRead(app, { requiresResolution = false } = {}) {
  const journal = openJournal({ stateDir: join(`${app.store.file}.rna`, app.session.id), sessionId: app.session.id, projectId: app.project.id });
  const key = 'retired-read-assistant/interrupted-read';
  journal.append('message', { message: { id: 'retired-read-user', role: 'user', source: 'user', timestamp: Date.now() - 3600000, content: [{ type: 'text', text: 'old request to read stale.txt' }] } });
  journal.append('message', { message: { id: 'retired-read-assistant', role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'interrupted-read', name: 'project_read', arguments: { path: 'stale.txt' } }] } });
  journal.append('tool_intent', { callKey: key, toolCallId: 'interrupted-read', toolName: 'project_read', arguments: { path: 'stale.txt' }, effect: 'read', idempotent: true });
  if (requiresResolution) journal.append('tool_uncertain', { callKey: key, requiresResolution: true, reason: 'process_cleanup_uncertain', details: { cleanupUncertain: true } });
  const sessionFile = journal.file; journal.close();
  app.store.mutate(state => { state.sessions.find(session => session.id === app.session.id).runtime = { engine: 'rna', sessionId: app.session.id, sessionFile }; });
  return { sessionFile, key, records: () => readFileSync(sessionFile, 'utf8').trim().split('\n').map(JSON.parse) };
}

test('new user turn retires an already-started safe read without replay and reaches the configured model', async t => {
  const marker = 'OLD-READ-MUST-NOT-EXECUTE-FOR-NEW-INSTRUCTION';
  const app = await setup(t, (input, res) => {
    const toolIndex = input.messages.findIndex(row => row.role === 'tool' && row.tool_call_id === 'interrupted-read');
    const newIndex = input.messages.findIndex(row => row.role === 'user' && row.content === 'New direction; do not repeat the earlier read.');
    assert.ok(toolIndex >= 0 && newIndex > toolIndex, 'retirement receipt must preserve the old call/result pair before the new user instruction');
    assert.ok(!JSON.stringify(input.messages).includes(marker));
    stream(res, 'Continued with the new instruction.');
  });
  app.permissions.update(app.project.id, { workspace: 'read', background: 'read' });
  writeFileSync(join(app.directory, 'stale.txt'), marker);
  const seeded = seedInterruptedRead(app);
  app.store.message(app.session.id, { text: 'New direction; do not repeat the earlier read.' });
  await until(() => ['completed', 'failed', 'paused'].includes(app.current().turns[0]?.status) && !app.executor.running.size);
  assert.equal(app.current().turns[0].status, 'completed', 'safe interrupted read must not trap the new turn in an empty recovery dialog');
  assert.equal(app.calls.length, 1); assert.equal(app.current().activeTurnId, null); assert.equal(app.current().items.filter(row => row.kind === 'user' && row.text === 'New direction; do not repeat the earlier read.').length, 1);
  const records = seeded.records(), results = records.filter(row => row.type === 'tool_completed' && row.data.callKey === seeded.key);
  assert.equal(records.filter(row => row.type === 'tool_intent' && row.data.callKey === seeded.key).length, 1, 'the old read must not be dispatched again');
  assert.equal(results.length, 1); assert.equal(results[0].data.isError, true);
  assert.ok(!JSON.stringify(results[0]).includes(marker)); assert.equal(readFileSync(join(app.directory, 'stale.txt'), 'utf8'), marker);
});

test('new user direction cannot retire a read whose process cleanup explicitly requires resolution', async t => {
  const app = await setup(t, (_input, res) => stream(res, 'This request must remain blocked.'));
  app.permissions.update(app.project.id, { workspace: 'read', background: 'read' });
  writeFileSync(join(app.directory, 'stale.txt'), 'original file');
  const seeded = seedInterruptedRead(app, { requiresResolution: true });
  app.store.message(app.session.id, { text: 'Continue with a new direction' });
  await until(() => app.current().status === 'paused' && !app.executor.running.size);
  assert.equal(app.current().pauseReason, 'recovery'); assert.equal(app.calls.length, 0);
  assert.deepEqual(app.current().runtime.recovery.uncertainTools.map(row => row.callKey), [seeded.key]);
  app.store.message(app.session.id, { text: 'Keep this latest steering while I verify the old process.' });
  await until(() => app.current().status === 'paused' && !app.executor.running.size);
  assert.equal(app.calls.length, 0); assert.equal(app.current().inbox.length, 1); assert.equal(app.current().inbox[0].text, 'Keep this latest steering while I verify the old process.');
  const records = seeded.records();
  assert.equal(records.filter(row => row.type === 'tool_intent' && row.data.callKey === seeded.key).length, 1);
  assert.equal(records.filter(row => row.type === 'tool_completed' && row.data.callKey === seeded.key).length, 0);
  assert.equal(records.filter(row => row.type === 'tool_manual_resolution').length, 0);
  assert.equal(readFileSync(join(app.directory, 'stale.txt'), 'utf8'), 'original file');
});

test('uncertain calls of read-only or idempotent MCP tools (current rules) are retired automatically; mutating ones still need review', () => {
  const grants = { browser_console_messages: { permission: 'exec', idempotent: false }, browser_click: { permission: 'exec', idempotent: false } };
  const host = { capabilityService: { configuration: () => ({ mcpServers: [{ id: 'playwright-browser', browser: { preset: 'playwright-browser' }, allowTools: grants }, { id: 'docs', allowTools: { search: { permission: 'read' }, write: { permission: 'write' } } }] }) } };
  const entry = (callKey, toolName, args) => ({ callKey, toolName, arguments: args });
  const safe = RuntimeController.prototype.safeUncertainTools.call(host, { uncertainTools: [
    entry('a', 'mcp_call', { tool: 'mcp__playwright-browser__browser_console_messages', arguments: {} }),
    entry('b', 'mcp_call', { tool: 'mcp__playwright-browser__browser_click', arguments: {} }),
    entry('c', 'mcp__docs__search', {}), entry('d', 'mcp__docs__write', {}),
    entry('e', 'mcp_call', { tool: 'mcp:playwright-browser:browser_console_messages' }),
    { ...entry('f', 'mcp__docs__search', {}), requiresResolution: true },
    entry('g', 'project_exec', { command: 'ls' }),
  ] }).map(row => row.callKey);
  assert.deepEqual(safe, ['a', 'c', 'e']);
});

test('editing or deleting a user message rewinds the model context, not just the view', async t => {
  const app = await setup(t, (input, res, count) => stream(res, `回复${count}`));
  const turnDone = n => until(() => app.current().turns.length === n && ['completed', 'failed'].includes(app.current().turns.at(-1)?.status));
  app.store.message(app.session.id, { text: '第一个问题' }); await turnDone(1);
  app.store.message(app.session.id, { text: '写一个爬虫抓取全书' }); await turnDone(2);
  app.store.message(app.session.id, { text: '第三个问题' }); await turnDone(3);
  const target = app.current().items.find(item => item.kind === 'user' && item.text === '写一个爬虫抓取全书');
  app.store.mutate(state => { const project = state.projects.find(row => row.id === app.project.id); project.mind ??= {}; project.mind.lessons = [{ id: 'l-derived', kind: 'preference', text: '用户想要爬虫', status: 'active', source: { kind: 'capture', sessionId: app.session.id, itemId: target.id }, evidence: [], createdAt: new Date().toISOString() }]; project.mind.agenda ??= []; project.mind.commitments ??= []; });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${base}/api/sessions/${app.session.id}/items/${target.id}/rewind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'user_edit' }) });
  const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.removedTurns, 2); assert.equal(result.withdrawn, 1);
  assert.deepEqual(app.current().items.filter(item => item.kind === 'user').map(item => item.text), ['第一个问题']);
  assert.equal(app.current().turns.length, 1);
  assert.equal(app.store.state.projects.find(row => row.id === app.project.id).mind.lessons[0].status, 'retired');
  app.store.message(app.session.id, { text: '改成：先整理人物设定' }); await turnDone(2);
  const sent = JSON.stringify(app.calls.at(-1).input.messages);
  assert.match(sent, /第一个问题/); assert.match(sent, /改成：先整理人物设定/);
  assert.doesNotMatch(sent, /爬虫|第三个问题|回复2|回复3/, 'the rewound history never reaches the model again');
  const busy = await fetch(`${base}/api/sessions/${app.session.id}/items/nope/rewind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'user_delete' }) });
  assert.equal(busy.status, 404);
});
