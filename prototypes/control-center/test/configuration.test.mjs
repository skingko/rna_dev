import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from '../store.mjs';
import { createServer } from '../server.mjs';
import { requestJSON } from '../configuration.mjs';
import { readStateFile, readStateText } from '../state-shards.mjs';
function fixture(t) { const dir = mkdtempSync(join(tmpdir(), 'pi-forge-config-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'state.json'); }
const model = (id = 'reasoner') => ({ id, name: '研究模型', contextWindow: 64000, maxOutputTokens: 4000, reasoning: ['off', 'high'] });
const provider = (s, extra = {}) => s.configurationService.provider(null, { name: '本地测试', protocol: 'openai', baseUrl: 'http://127.0.0.1:9000/v1', models: [model()], ...extra });
async function server(t, handler) { const value = http.createServer(handler); await new Promise(resolve => value.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { value.close(resolve); value.closeAllConnections(); })); return `http://127.0.0.1:${value.address().port}`; }
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };

test('凭据独立持久化0600；状态、配置、事件和重启API不回传API Key', t => {
  const file = fixture(t), store = new Store(file), key = 'secret-for-tests-only';
  const p = provider(store, { apiKey: key }); assert.equal(p.apiKeyConfigured, true); assert.equal(p.credentialSource, 'local-file');
  assert.ok(!JSON.stringify(store.get()).includes(key)); assert.ok(!readStateText(file).includes(key));
  assert.equal(statSync(`${file}.secrets`).mode & 0o777, 0o600);
  const reopened = new Store(file); assert.equal(reopened.configurationService.public().providers.find(x => x.id === p.id).apiKeyConfigured, true);
  reopened.configurationService.provider(p.id, { name: '改名不改变凭据' }); assert.equal(reopened.configurationService.secret(p.id, reopened.state.configuration.providers.find(x => x.id === p.id)), key);
  reopened.configurationService.provider(p.id, { apiKey: '' }); assert.equal(reopened.configurationService.public().providers.find(x => x.id === p.id).apiKeyConfigured, false);
});

test('环境变量凭据只存引用；错误配置不会写入配置或凭据', t => {
  const s = new Store(fixture(t)); process.env.PI_FORGE_TEST_CREDENTIAL = 'environment-secret'; t.after(() => delete process.env.PI_FORGE_TEST_CREDENTIAL);
  const p = provider(s, { apiKeyEnv: 'PI_FORGE_TEST_CREDENTIAL' }); assert.equal(p.credentialSource, 'environment'); assert.equal(p.apiKeyConfigured, true);
  const before = s.get();
  assert.throws(() => s.configurationService.provider(p.id, { baseUrl: 'https://user:pass@example.org', apiKey: 'should-not-save' }), /服务地址/);
  assert.throws(() => s.configurationService.provider(p.id, { models: [model(), model()] }), /重复/);
  assert.throws(() => s.configurationService.provider(p.id, { models: [{ ...model(), maxOutputTokens: 64001 }] }), /输出上限/);
  assert.deepEqual(s.get(), before); assert.ok(!JSON.stringify(s.get()).includes('environment-secret'));
});

test('默认模型用于新会话，每轮固定模型配置；修改后只影响后续轮次', t => {
  const s = new Store(fixture(t)), p = provider(s);
  s.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'reasoner', reasoning: 'high' } });
  const { session } = s.createProject({}); assert.equal(session.context.capacity, 64000); assert.equal(session.modelSelection.providerId, p.id);
  s.message(session.id, { text: '第一轮' }); const first = s.get().sessions[0].turns[0]; assert.equal(first.modelConfig.reasoning, 'high'); assert.equal(first.modelConfig.execution, 'rna');
  s.configurationService.provider(p.id, { models: [{ ...model(), contextWindow: 128000 }] });
  s.updateSession(session.id, { modelSelection: { providerId: 'demo', modelId: 'demo', reasoning: 'off' } });
  assert.deepEqual(s.get().sessions[0].turns[0], first);
  s.controlSession(session.id, 'stop'); s.message(session.id, { text: '第二轮' }); assert.equal(s.get().sessions[0].turns[1].modelConfig.providerId, 'demo');
  assert.throws(() => s.configurationService.provider(p.id, {}, true), /默认模型/);
  s.configurationService.update({ defaultModel: { providerId: 'demo', modelId: 'demo', reasoning: 'off' } });
  s.configurationService.provider(p.id, {}, true); assert.equal(s.get().sessions[0].turns[0].modelConfig.providerId, p.id);
});

test('改了供应商模型的上下文窗口：空闲会话的上下文用量按新窗口重算，不标成估算', t => {
  const s = new Store(fixture(t)), p = provider(s);
  s.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'reasoner', reasoning: 'high' } });
  const { session } = s.createProject({});
  s.mutate(state => { state.sessions.find(row => row.id === session.id).context.usage = { estimatedInputTokens: 30000, capacity: 64000, outputReserve: 0, inputTrigger: 51200, blockingTrigger: 57600 }; });
  s.configurationService.provider(p.id, { models: [{ ...model(), contextWindow: 128000 }] });
  const usage = s.get().sessions.find(row => row.id === session.id).context.usage;
  assert.equal(usage.capacity, 128000); assert.equal(usage.estimatedInputTokens, 30000);
  assert.equal(usage.inputTrigger, Math.floor(128000 * 0.8) - usage.outputReserve); assert.equal(usage.blockingTrigger, Math.floor(128000 * 0.9) - usage.outputReserve);
  assert.equal(usage.estimated, undefined, 'same model, measured size: not an estimate');
});

test('供应商连接只探测模型目录；Anthropic根目录补/v1，响应不自动写模型', async t => {
  const calls = [], base = await server(t, (req, res) => { calls.push({ url: req.url, method: req.method, key: req.headers['x-api-key'] ?? req.headers.authorization }); json(res, { data: [{ id: 'discovered', display_name: '发现模型' }] }); });
  const s = new Store(fixture(t)), p = provider(s, { baseUrl: base, protocol: 'anthropic', apiKey: 'local-only-key' });
  const before = s.get(), result = await s.configurationService.test(p.id);
  assert.equal(result.ok, true); assert.deepEqual(calls, [{ url: '/v1/models', method: 'GET', key: 'local-only-key' }]); assert.equal(result.models[0].id, 'discovered'); assert.deepEqual(s.get(), before);
});

test('连接拒绝重定向、超时和原始错误体，不将凭据泄漏到返回错误', async t => {
  let targetHits = 0; const target = await server(t, (req, res) => { targetHits++; res.end('{}'); });
  const base = await server(t, (req, res) => { if (req.url === '/slow') return; if (req.url === '/error') return json(res, { secret: 'must-not-return' }, 401); res.writeHead(302, { location: target }); res.end(); });
  await assert.rejects(requestJSON(base, { headers: { Authorization: 'Bearer sensitive' } }), /重定向/); assert.equal(targetHits, 0);
  await assert.rejects(requestJSON(`${base}/slow`, { timeoutMs: 20 }), /超时/);
  await assert.rejects(requestJSON(`${base}/error`), error => error.message.includes('401') && !error.message.includes('must-not-return'));
});

test('OpenViking是唯一默认后端；旧本地数据保留为归档但不再检索或进入轮次', async t => {
  const file = fixture(t), s = new Store(file), { project, session } = s.createProject({});
  assert.equal(s.get().configuration.memory.backend, 'openviking');
  assert.throws(() => s.configurationService.update({ memory: { backend: 'local' } }), /只能是 openviking 或 embedded/);
  const raw = readStateFile(file).state; raw.configuration.memory.backend = 'local';
  raw.projectMemories = [{ id: 'old', projectId: project.id, title: '历史记忆', content: '不可作为本地回退', summary: '历史归档' }]; writeFileSync(file, JSON.stringify(raw));
  const migrated = new Store(file); assert.equal(migrated.state.configuration.memory.backend, 'openviking'); assert.equal(migrated.state.projectMemories[0].content, '不可作为本地回退');
  assert.equal(migrated.get().projectMemories, undefined); migrated.message(session.id, { text: '不能用旧本地记忆回答' });
  assert.equal(migrated.get().sessions[0].turns[0].memoryContext.backend, 'openviking'); assert.deepEqual(migrated.get().sessions[0].turns[0].memoryContext.entries, []);
  migrated.configurationService.update({ memory: { endpoint: 'http://127.0.0.1:1' } });
  await assert.rejects(migrated.memoryService.list(project.id), error => error.status === 503 && /不会回退/.test(error.message));
});

test('Store不自行发起记忆请求；find限定命名空间并过滤越界结果，目录/内容遵循官方API', async t => {
  const calls = []; let ns;
  const base = await server(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; calls.push({ url: req.url, method: req.method, body: body ? JSON.parse(body) : null, key: req.headers['x-api-key'] });
    if (req.url.includes('/search/find')) return json(res, { status: 'ok', result: { resources: [{ uri: `${ns}/note`, level: 2, abstract: '项目记忆' }, { uri: `${ns}-other/private`, abstract: '其他项目' }, { uri: `${ns}/../private`, abstract: '穿越' }] } });
    if (req.url.includes('/fs/ls')) return json(res, { status: 'ok', result: [{ uri: `${ns}/note`, name: 'note', isDir: false }, { uri: `${ns}/private`, access: 'denied' }] });
    json(res, { status: 'ok', result: '真实服务返回的项目内容' });
  });
  const s = new Store(fixture(t)), { project, session } = s.createProject({}); ns = `viking://resources/projects/${project.id}`;
  s.configurationService.update({ memory: { backend: 'openviking', endpoint: base, apiKey: 'ov-local-key' } });
  s.get(); s.message(session.id, { text: '这段聊天不能自动上传' }); s.tick(); assert.equal(calls.length, 0);
  const found = await s.memoryService.search(project.id, { query: '缓存', level: 'L1' }); assert.equal(found.entries.length, 1); assert.equal(calls[0].body.target_uri, ns); assert.equal(calls[0].body.level, '1'); assert.equal(calls[0].body.read_content, false); assert.equal(found.entries[0].level, 'L2'); assert.equal(calls[0].key, 'ov-local-key');
  assert.equal((await s.memoryService.browse(project.id)).entries.length, 1);
  await s.memoryService.read(project.id, { uri: `${ns}/note`, level: 'L2' }); assert.match(calls[2].url, /content\/read/);
  await assert.rejects(s.memoryService.read(project.id, { uri: 'viking://resources/private', level: 'L2' }), /当前项目/); assert.equal(calls.length, 3);
});

test('静音只阻止主动消息：后台新证据继续评测，解除后只发一次；输入礼让可以独立关闭', t => {
  const s = new Store(fixture(t)), { project, session } = s.createProject({ initiative: { cooldownMs: 0, notificationMuted: true } });
  s.observeProject(project.id, { kind: 'research_result', text: '先暂存主动消息', relevance: 1 }); s.tick();
  s.observeProject(project.id, { kind: 'ci_failure', text: '新的失败值得改进', relevance: .9 }); s.tick(); s.tick();
  assert.ok(s.get().projects[0].versions.some(v => v.state === 'ready')); assert.equal(s.get().sessions[0].items.length, 0);
  s.updateProject(project.id, { initiative: { notificationMuted: false, deferWhileTyping: false } });
  s.presence(project.id, { sessionId: session.id, typing: true, visible: true }); s.tick(); assert.equal(s.get().sessions[0].items.length, 1);
  s.tick(); s.tick(); assert.equal(s.get().sessions[0].items.filter(i => i.versionId).length, 1);
});

test('配置和记忆HTTP路由返回脱敏配置，命名空间拒绝跨项目重叠', async t => {
  const app = createServer({ stateFile: fixture(t), ticks: false }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, method = 'GET', input) => { const response = await fetch(base + path, { method, ...(input ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : {}) }); return { response, value: await response.json() }; };
  const p = await call('/api/providers', 'POST', { name: 'API测试', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'unreturned', models: [model()] }); assert.equal(p.response.status, 201); assert.equal(p.value.apiKeyConfigured, true);
  assert.ok(!JSON.stringify((await call('/api/state')).value).includes('unreturned'));
  const a = (await call('/api/projects', 'POST', {})).value.project, b = (await call('/api/projects', 'POST', {})).value.project;
  assert.equal((await call(`/api/projects/${b.id}`, 'PATCH', { memory: { namespace: `viking://resources/projects/${a.id}` } })).response.status, 409);
  assert.equal((await call(`/api/projects/${a.id}/memory?level=L2`)).response.status, 503);
});

test('延期的版本消息不阻塞输入中、冷却中或用户轮次中的后台新证据', t => {
  for (const block of ['typing', 'cooldown', 'turn']) {
    const s = new Store(fixture(t)), { project, session } = s.createProject({ initiative: { cooldownMs: 0 } });
    s.observeProject(project.id, { kind: 'ci_failure', text: '第一条失败' }); s.tick(); s.tick();
    if (block === 'typing') s.presence(project.id, { sessionId: session.id, typing: true, visible: true });
    if (block === 'cooldown') s.mutate(state => { state.projects[0].initiative.lastSpokeAt = new Date().toISOString(); state.projects[0].initiative.cooldownMs = 60000; });
    if (block === 'turn') s.message(session.id, { text: '保持当前回复' });
    s.tick();
    s.observeProject(project.id, { kind: 'context', text: '新的低优先级研究线索', relevance: .8 }); s.tick(); s.tick();
    assert.ok(s.get().projects[0].jobs.some(job => job.kind === 'research' && job.status === 'completed'), block);
    assert.equal(s.get().sessions[0].items.filter(item => item.source === 'initiative').length, 0, block);
  }
});

test('CLI读取脱敏配置、切换模型、读取项目记忆并独立控制静音', async t => {
  const { spawn } = await import('node:child_process');
  const app = createServer({ stateFile: fixture(t), ticks: false }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const { project, session } = app.store.createProject({}), p = provider(app.store, { apiKey: 'cli-hidden-key' });
  const memoryEndpoint = await server(t, (req, res) => json(res, { status: 'ok', result: req.url.includes('/content/read') ? '跨界面共享项目记忆' : { resources: [{ uri: `viking://resources/projects/${project.id}/note.md`, level: 2, abstract: 'CLI 记忆', content: '不能依赖find额外返回正文' }] } }));
  app.store.configurationService.update({ memory: { endpoint: memoryEndpoint } });
  const cli = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), ...args], { env: { ...process.env, PI_FORGE_PORT: String(app.server.address().port) } });
    let output = '', errors = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk); child.on('error', reject); child.on('exit', code => code ? reject(new Error(errors)) : resolve(output));
  });
  assert.ok(!(await cli(['config'])).includes('cli-hidden-key'));
  await cli(['model-default', p.id, 'reasoner', 'high']); await cli(['model-set', session.id, p.id, 'reasoner', 'off']);
  assert.equal(app.store.get().configuration.defaultModel.reasoning, 'high'); assert.equal(app.store.get().sessions[0].modelSelection.reasoning, 'off');
  const found = await cli(['memory', project.id, 'search', '共享', '--level', 'L2']); assert.match(found, /CLI 记忆/); assert.doesNotMatch(found, /不能依赖find/);
  assert.match(await cli(['memory', project.id, 'read', `viking://resources/projects/${project.id}/note.md`, '--level', 'L2']), /跨界面共享/);
  await cli(['initiative', project.id, 'mute']); assert.equal(app.store.get().projects[0].initiative.notificationMuted, true); assert.equal(app.store.get().projects[0].initiative.enabled, true);
});

test('仅暂停进化不会让既有候选检查点阻塞项目研究，恢复后候选继续', t => {
  const s = new Store(fixture(t)), { project } = s.createProject({ initiative: { cooldownMs: 0 } });
  s.observeProject(project.id, { kind: 'ci_failure', text: '先安排候选' }); s.tick();
  s.updateProject(project.id, { evolution: { enabled: false } });
  s.observeProject(project.id, { kind: 'ci_failure', text: '另一条失败保持待处理', relevance: 1 });
  s.observeProject(project.id, { kind: 'context', text: '普通研究继续', relevance: .8 }); s.tick(); s.tick();
  assert.ok(s.get().projects[0].jobs.some(j => j.kind === 'research' && j.status === 'completed'));
  assert.equal(s.get().projects[0].jobs.find(j => j.kind === 'evolution').status, 'queued');
  s.updateProject(project.id, { evolution: { enabled: true } }); s.tick();
  assert.equal(s.get().projects[0].jobs.find(j => j.kind === 'evolution').status, 'completed');
});

test('供应商可先保存空模型目录再探测，显式添加后才允许选择；支持max推理且不能移除正在使用的模型', async t => {
  const base = await server(t, (req, res) => json(res, { data: [{ id: 'discovered-max-model', name: '最高推理模型' }] }));
  const s = new Store(fixture(t));
  const p = provider(s, { baseUrl: base, models: [] }); assert.deepEqual(p.models, []);
  assert.throws(() => s.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'discovered-max-model' } }), /允许列表/);
  const found = await s.configurationService.test(p.id); assert.equal(found.models[0].id, 'discovered-max-model');
  assert.deepEqual(s.configurationService.public().providers.find(row => row.id === p.id).models, []);
  s.configurationService.provider(p.id, { models: [{ ...model('discovered-max-model'), reasoning: ['off', 'max'] }] });
  s.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'discovered-max-model', reasoning: 'max' } });
  const session = s.createSession(); s.message(session.id, { text: '保留最高推理配置' }); assert.equal(s.get().sessions[0].turns[0].modelConfig.reasoning, 'max');
  const before = s.get(); assert.throws(() => s.configurationService.provider(p.id, { models: [] }), /允许列表/); assert.deepEqual(s.get(), before);
});

test('OpenViking健康检查鉴权、项目初始化和写入使用官方API；写入接受不冒充索引完成', async t => {
  const calls = []; const base = await server(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; calls.push({ path: req.url, method: req.method, body: body ? JSON.parse(body) : null, key: req.headers['x-api-key'] });
    if (req.headers['x-api-key'] !== 'fixture-memory-credential') return json(res, {}, 401);
    if (req.url === '/health') return json(res, { status: 'ok', healthy: true, version: 'test-fixture' });
    if (req.url === '/api/v1/system/status') return json(res, { status: 'ok', result: { initialized: true } });
    if (req.url === '/ready') return json(res, { status: 'ready', checks: { agfs: { status: 'ok', checks: { filesystem: 'ok' } }, vectordb: 'ok', embedding: 'ok' } });
    if (req.url === '/api/v1/fs/mkdir') return json(res, { status: 'ok', result: {} });
    if (req.url === '/api/v1/content/write') return json(res, { status: 'ok', result: { semantic_status: 'pending' } });
    json(res, {}, 404);
  });
  const s = new Store(fixture(t)), { project } = s.createProject({}); s.configurationService.update({ memory: { endpoint: base, apiKey: 'fixture-memory-credential' } });
  const health = await s.memoryService.health(project.id);
  assert.equal(health.authenticated, true); assert.equal(health.ready, true); assert.equal(health.readiness.embedding, 'ready');
  assert.equal((await s.memoryService.initialize(project.id)).initialized, true);
  const result = await s.memoryService.write(project.id, null, { title: '发布约定', content: '发布前运行测试' });
  assert.equal(result.backend, 'openviking'); assert.equal(result.semanticStatus, 'pending'); assert.match(result.uri, new RegExp(project.id));
  assert.deepEqual(calls.map(({ method, path }) => [method, path]), [
    ['GET', '/health'], ['GET', '/api/v1/system/status'], ['GET', '/ready'],
    ['POST', '/api/v1/fs/mkdir'], ['POST', '/api/v1/content/write'],
  ]);
  assert.ok(calls.every(call => call.key === 'fixture-memory-credential'));
  assert.deepEqual(calls[3].body, { uri: `viking://resources/projects/${project.id}`, description: project.description || project.name });
  assert.deepEqual(calls[4].body, { uri: result.uri, content: '# 发布约定\n\n发布前运行测试', mode: 'create', wait: false });
  const before = calls.length; await assert.rejects(s.memoryService.write(project.id, null, { uri: 'viking://resources/elsewhere/file.md', content: '越界' }), error => error.status === 403); assert.equal(calls.length, before);
});

test('OpenViking会话显式创建、写消息、提交和任务查询；项目隔离且不自动上传源会话', async t => {
  const calls = []; const base = await server(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = raw ? JSON.parse(raw) : null;
    calls.push({ path: req.url, body, actor: req.headers['x-openviking-actor-peer'] });
    if (req.url === '/api/v1/system/status') return json(res, { status: 'ok', result: { initialized: true, user: 'fixture-user' } });
    if (req.url === '/api/v1/sessions') return json(res, { status: 'ok', result: { session_id: body.session_id } });
    if (req.url.endsWith('/commit')) return json(res, { status: 'ok', result: { status: 'queued', task_id: 'task-test', archived: true } });
    json(res, { status: 'ok', result: req.url.includes('/tasks/') ? { status: 'completed' } : { message_count: 1 } });
  });
  const s = new Store(fixture(t)), a = s.createProject({}), b = s.createProject({}); s.configurationService.update({ memory: { endpoint: base } });
  s.message(a.session.id, { text: '这条源会话消息不能自动上传' });
  const remote = await s.memoryService.createSession(a.project.id, { sourceSessionId: a.session.id });
  assert.equal(calls.length, 2); assert.equal(calls[1].body.auto_commit_policy, null); assert.equal(calls[1].body.memory_policy.peer.enabled, true); assert.equal(calls[1].body.memory_policy.self.enabled, false); assert.equal(calls[1].actor, `forge-${a.project.id}`);
  await s.memoryService.sessionMessages(a.project.id, remote.sessionId, { messages: [{ role: 'user', content: '明确要求保存的消息', sourceMessageId: 'source-1' }] });
  assert.equal(calls[3].body.messages[0].content, '明确要求保存的消息');
  const commit = await s.memoryService.sessionCommit(a.project.id, remote.sessionId); assert.equal(commit.result.task_id, 'task-test'); assert.match(commit.message, /仍需查询/);
  assert.equal((await s.memoryService.sessionTask(a.project.id, remote.sessionId, 'task-test')).result.status, 'completed');
  await assert.rejects(s.memoryService.sessionMessages(b.project.id, remote.sessionId, { messages: [{ role: 'user', content: '越界' }] }), error => error.status === 404);
  assert.equal(calls.length, 7);
  s.configurationService.update({ memory: { endpoint: 'http://127.0.0.1:2' } }); await assert.rejects(s.memoryService.sessionCommit(a.project.id, remote.sessionId), error => error.status === 409);
});
test('provider compatibility and native cache retention survive model resolution without arbitrary payload fields', t => {
  const s = new Store(fixture(t));
  const p = provider(s, { models: [{ ...model(), cacheRetention: 'long', compat: { maxTokensField: 'max_tokens', supportsUsageInStreaming: false, supportsPromptCacheKey: true } }] });
  const selected = { providerId: p.id, modelId: p.models[0].id, reasoning: p.models[0].reasoning[0] };
  s.configurationService.update({ defaultModel: selected });
  const resolved = s.createSession({}).modelConfig; assert.equal(resolved.cacheRetention, 'long'); assert.equal(resolved.compat.maxTokensField, 'max_tokens'); assert.equal(resolved.compat.supportsUsageInStreaming, false);
  assert.throws(() => provider(s, { models: [{ ...model(), cacheRetention: 'forever' }] }), /缓存保留/);
  assert.throws(() => provider(s, { models: [{ ...model(), compat: { arbitrary: true } }] }), /兼容配置/);
});
