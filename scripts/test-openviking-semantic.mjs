#!/usr/bin/env node
// Real, paid-model acceptance against the isolated semantic candidate service.
// No fake HTTP/embedding/VLM provider, and no existing Rna tenant or conversation.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../prototypes/control-center/store.mjs';
import { RuntimeController } from '../prototypes/control-center/runtime-controller.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
function readPrivateJSON(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Private JSON configuration is unreadable or invalid; its contents were not printed'); } }
const args = process.argv.slice(2), options = {};
for (let index = 0; index < args.length; index += 2) {
  if (!['--endpoint', '--server-config', '--report'].includes(args[index]) || !args[index + 1]) throw new Error('Usage: test-openviking-semantic.mjs --endpoint http://127.0.0.1:CANDIDATE_PORT [--server-config private/ov.conf] [--report report.json]');
  options[args[index].slice(2)] = args[index + 1];
}
const endpoint = new URL(options.endpoint ?? '');
if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || !endpoint.port || endpoint.port === '1933' || endpoint.username || endpoint.password || endpoint.search || endpoint.pathname !== '/') throw new Error('Use an explicit isolated loopback candidate port; the current live service on 1933 is excluded');
const privateConfig = resolve(options['server-config'] ?? join(root, 'deploy/openviking/.runtime/semantic/ov.conf'));
const config = readPrivateJSON(privateConfig);
const embedding = config.embedding?.dense, vlm = config.vlm;
assert.ok(embedding && /bge-m3/i.test(embedding.model) && embedding.dimension === 1024, 'Expected real BGE-M3 1024-dimensional deployment');
assert.ok(vlm && ['deepseek-flash', 'deepseek-v4-pro'].includes(vlm.model) && /^https:\/\/api\.deepseek\.com(?:\/|$)/.test(vlm.api_base), 'Expected the verified real DeepSeek provider');
assert.ok(!JSON.stringify({ embedding, vlm }).includes('fixture'), 'Protocol fixtures cannot pass semantic acceptance');
assert.equal(typeof config.server?.root_api_key, 'string');
const runId = randomUUID(), accountId = `rna-semantic-qa-${runId.slice(0, 12)}`, folder = mkdtempSync(join(tmpdir(), 'rna-semantic-qa-'));
const privateAuditDirectory = join(root, 'deploy/openviking/.runtime/semantic/qa');
const store = new Store(join(folder, 'state.json')), checks = [];
const reportPath = resolve(options.report ?? join(root, 'prototypes/control-center/qa/openviking-semantic-report.json'));
const report = { schemaVersion: 1, runId, startedAt: new Date().toISOString(), endpoint: endpoint.origin, accountId,
  models: { embedding: { provider: embedding.provider, model: embedding.model, dimension: embedding.dimension }, extraction: { provider: vlm.provider, model: vlm.model, apiBase: vlm.api_base, scope: 'text extraction and summaries; image support is not asserted' } },
  evidenceType: 'real service and trained embedding inference with real DeepSeek extraction; constructed acceptance conversations in a separate tenant', checks, semanticQueries: [], resourceRecords: [], openIssues: [] };
const digest = value => createHash('sha256').update(value).digest('hex');
function journalCounts(raw) {
  const records = raw.trim().split('\n').filter(Boolean).map(JSON.parse);
  return { requests: records.filter(row => row.type === 'request_started').length, completedRequests: records.filter(row => row.type === 'request_completed').length,
    toolResults: records.filter(row => row.type === 'tool_completed').length, uncertainTools: records.filter(row => row.type === 'tool_uncertain').length,
    modelIds: [...new Set(records.filter(row => row.type === 'request_started').map(row => row.data?.model?.modelId).filter(Boolean))] };
}
const pause = ms => new Promise(done => setTimeout(done, ms));
let client, projectA, projectB, runtime;
function safeError(error) {
  let message = String(error?.message ?? error);
  for (const value of [config.server.root_api_key, vlm.api_key, client?.api_key].filter(Boolean)) {
    for (const secret of new Set([value, encodeURIComponent(value)])) message = message.split(secret).join('[REDACTED]');
  }
  return message.slice(0, 2000);
}
async function request(path, { method = 'GET', body, rootKey = false } = {}) {
  const response = await fetch(`${endpoint.origin}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-API-Key': rootKey ? config.server.root_api_key : client.api_key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Object.assign(new Error(`Candidate API ${path.split('?')[0]} returned HTTP ${response.status}`), { status: response.status });
  const result = await response.json(); if (result.status !== 'ok') throw new Error(`Candidate API ${path.split('?')[0]} did not confirm success`);
  return result.result;
}
async function check(name, fn) {
  const started = Date.now();
  try { const details = await fn(); checks.push({ name, ok: true, elapsedMs: Date.now() - started, ...(details ? { details } : {}) }); console.log(`PASS ${name}`); return true; }
  catch (error) { const message = safeError(error); checks.push({ name, ok: false, elapsedMs: Date.now() - started, error: message }); console.error(`FAIL ${name}: ${message}`); return false; }
}
async function until(fn, label, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs; let value;
  while (Date.now() < deadline) { value = await fn(); if (value) return value; await pause(1500); }
  throw new Error(`${label} did not become ready within ${timeoutMs / 1000}s`);
}
const documents = [
  { key: 'recovery', title: '故障后的任务恢复', content: '执行耗时工作时，定期将已完成阶段和中间结果持久化。突然断电或进程崩溃后，从最近一次保存的位置接着做，已经完成的步骤不可重复执行。', query: 'How can a long running job resume after a power outage without repeating completed work?' },
  { key: 'accessibility', title: '可辨认的界面状态', content: '界面不能只用红色和绿色表达成败。每个状态都同时提供明确的文字标签与不同形状的图标，使色觉异常的人也能辨认结果。', query: 'What UI rule helps people who cannot distinguish red from green understand success and failure?' },
  { key: 'delivery', title: '消息重复投递', content: '消息到达时先检查唯一编号是否已处理。网络重试导致同一条消息再次送达时，只返回之前保存的结果，不再次修改数据。', query: 'How should duplicate event deliveries be handled without applying the same update twice?' },
  { key: 'performance', title: '画面刷新性能', content: '交互动画应平滑连续。每帧计算控制在十六毫秒以内，复杂计算移到后台，避免滚动和鼠标操作发生卡顿。', query: 'How do we keep motion smooth and input responsive when rendering complex scenes?' },
  { key: 'unrelated', title: '植物养护', content: '盆栽养护首先观察土壤干湿，避免根部长期积水。春天适当增加光照，夏季正午遮阴，并定期修剪枯枝。' },
];
try {
  await check('create a separate real OpenViking QA tenant', async () => {
    const created = await request('/api/v1/admin/accounts', { rootKey: true, method: 'POST', body: { account_id: accountId, admin_user_id: 'semantic-verifier' } });
    const key = created.user_key ?? created.admin_api_key ?? created.api_key; assert.equal(typeof key, 'string'); assert.ok(key);
    client = { endpoint: endpoint.origin, account_id: accountId, user_id: 'semantic-verifier', api_key: key };
    mkdirSync(privateAuditDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(privateAuditDirectory, `${runId}.json`), JSON.stringify(client, null, 2), { mode: 0o600 });
    store.configurationService.update({ memory: { backend: 'openviking', endpoint: endpoint.origin, apiKey: key } });
    projectA = store.createProject({ name: '真实语义验收项目甲', description: 'Independent semantic acceptance namespace.' }).project;
    projectB = store.createProject({ name: '真实语义验收项目乙', description: 'Isolation control, no shared project memories.' }).project;
    report.projects = { a: projectA.id, b: projectB.id }; return { newTenant: true, credentialPrinted: false };
  });
  if (!client) throw new Error('No isolated QA tenant exists; subsequent checks were not attempted');
  await check('real dependency readiness includes embedding inference', async () => { const result = await store.memoryService.health(projectA.id); assert.equal(result.ready, true); assert.equal(result.readiness.embedding, 'ready'); return result.readiness; });
  await check('write persistent resources through the Rna adapter', async () => {
    await store.memoryService.initialize(projectA.id); await store.memoryService.initialize(projectB.id);
    for (const document of documents) {
      const result = await store.memoryService.write(projectA.id, null, { title: document.title, content: document.content });
      document.uri = result.uri; assert.equal(result.accepted, true);
      report.resourceRecords.push({ uri: result.uri, key: document.key, sha256: digest(`# ${document.title}\n\n${document.content}`) });
      assert.match((await store.memoryService.read(projectA.id, { uri: result.uri, level: 'L2' })).content, new RegExp(document.content.slice(0, 8)));
    }
    const foreign = await store.memoryService.write(projectB.id, null, { title: '独立旅行计划', content: '周末乘火车前往湖边露营，预先准备雨衣和帐篷，返程时清理营地。' }); report.foreignResource = foreign.uri;
    return { written: documents.length + 1 };
  });
  await check('cross-language retrieval works without lexical overlap', async () => {
    await until(async () => { const found = await store.memoryService.search(projectA.id, { query: '故障 恢复 界面 消息 动画 植物', level: 'L2', limit: 30 }); return documents.every(document => found.entries.some(entry => entry.uri === document.uri)); }, 'real vector indexing');
    for (const document of documents.filter(document => document.query)) {
      assert.ok(!/[A-Za-z]/.test(document.content)); assert.ok(!/[\u3400-\u9fff]/.test(document.query));
      const found = await store.memoryService.search(projectA.id, { query: document.query, level: 'L2', limit: 5 });
      const rank = found.entries.findIndex(entry => entry.uri === document.uri) + 1;
      report.semanticQueries.push({ query: document.query, expectedUri: document.uri, rank, score: found.entries.find(entry => entry.uri === document.uri)?.score ?? null, results: found.entries.map(({ uri, score }) => ({ uri, score })) });
      assert.ok(rank > 0 && rank <= 2, `Expected ${document.key} within top two semantically ranked resources; actual rank ${rank}`);
    }
    return { pairs: report.semanticQueries.length, maximumRank: 2, sourceLanguage: 'Chinese', queryLanguage: 'English', lexicalOverlap: 'no shared words/scripts' };
  });
  await check('real L0 and L1 summaries are generated and can be progressively expanded', async () => {
    const uri = store.memoryService.remote(projectA.id).namespace;
    let abstract, overview;
    const themes = [/恢复|断电|崩溃|checkpoint|recover|resum/i, /色觉|红绿|界面|标签|accessib|color|colour|interface/i, /动画|每帧|滚动|animation|render|frame/i, /消息|投递|重复|dedup|message|event/i, /盆栽|植物|浇水|养护|plant|water|soil/i];
    // Writes return before directory summaries are regenerated. Wait for the
    // expected topics rather than accepting an earlier partial summary.
    await until(async () => {
      try {
        abstract = await store.memoryService.read(projectA.id, { uri, level: 'L0' }); overview = await store.memoryService.read(projectA.id, { uri, level: 'L1' });
        return themes.some(pattern => pattern.test(abstract.content)) && themes.filter(pattern => pattern.test(overview.content)).length >= 3;
      } catch (error) { if (error.code === 'MEMORY_LAYER_UNAVAILABLE' || error.upstreamStatus === 404) return false; throw error; }
    }, 'topic-relevant L0/L1 summaries');
    for (const layer of [abstract, overview]) assert.ok(!/rna-fixture|protocol.fixture|RNA_MEMORY_TEST|fixture.summary/i.test(layer.content), 'Fixture text cannot count as a real generated summary');
    const l0Topics = themes.filter(pattern => pattern.test(abstract.content)).length, l1Topics = themes.filter(pattern => pattern.test(overview.content)).length;
    assert.ok(l0Topics >= 1, 'L0 must refer to an actual document topic'); assert.ok(l1Topics >= 3, 'L1 must describe multiple actual document topics');
    return { L0: { chars: abstract.content.length, sha256: digest(abstract.content), matchedTopics: l0Topics }, L1: { chars: overview.content.length, sha256: digest(overview.content), matchedTopics: l1Topics } };
  });
  await check('project scopes prevent resource reads and search contamination', async () => {
    await assert.rejects(store.memoryService.read(projectB.id, { uri: documents[0].uri, level: 'L2' }), error => error.status === 403);
    const found = await store.memoryService.search(projectB.id, { query: documents[0].query, level: 'L2', limit: 20 });
    assert.ok(found.entries.every(entry => !documents.some(document => document.uri === entry.uri)));
    return { crossReadRejectedBeforeHttp: true, otherProjectResults: found.entries.length };
  });
  let binding, commit, task;
  await check('real session extraction produces non-empty durable memories', async () => {
    binding = await store.memoryService.createSession(projectA.id);
    // A fresh fact appears only in this conversation, never in the resource set.
    const messages = [
      { role: 'user', content: '请为这个项目长期记住一个已确认的团队协作安排：所有设计评审固定安排在每周四下午三点。周一至周三的上午我要照顾家人，不能安排会议。不要把这个安排应用到其他项目。' },
      { role: 'assistant', content: '这个项目的设计评审固定为每周四下午三点，并避开周一至周三上午。我会保留为本项目的协作约束。' },
      { role: 'user', content: '对，这不是临时建议，是我们已经决定的长期安排。以后制定迭代计划时请一直使用该时间。' },
      { role: 'assistant', content: '已确认长期有效：本项目后续迭代计划中的设计评审使用每周四下午三点。' },
    ];
    await store.memoryService.sessionMessages(projectA.id, binding.sessionId, { messages });
    commit = await store.memoryService.sessionCommit(projectA.id, binding.sessionId); assert.ok(commit.result.task_id);
    report.session = { sessionId: binding.sessionId, taskId: commit.result.task_id, conversationSha256: digest(JSON.stringify(messages)), messageCount: messages.length, archiveUri: commit.result.archive_uri };
    task = await until(async () => { const result = (await store.memoryService.sessionTask(projectA.id, binding.sessionId, commit.result.task_id)).result; return ['completed', 'failed', 'cancelled'].includes(result.status) && result; }, 'real DeepSeek session extraction', 240000);
    const counts = task.result?.memories_extracted ?? {}; report.session.status = task.status; report.session.extractedCounts = counts;
    const usage = task.result?.token_usage;
    if (usage) report.session.reportedTokenUsage = Object.fromEntries(['llm', 'embedding', 'total'].map(kind => [kind, Object.fromEntries(Object.entries(usage[kind] ?? {}).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)))]));
    else report.session.reportedTokenUsage = null;
    assert.equal(task.status, 'completed'); assert.ok(Object.values(counts).some(value => Number.isFinite(value) && value > 0), 'A completed archive with zero extracted memories does not pass');
    return { status: task.status, extractedCounts: counts };
  });
  await check('extracted session memory is semantically recalled through the project adapter', async () => {
    assert.ok(binding && task?.status === 'completed', 'Session extraction prerequisite failed');
    const query = 'On which weekday and at what hour should recurring design reviews be scheduled?';
    const found = await until(async () => {
      const result = await store.memoryService.search(projectA.id, { query, level: 'L2', limit: 20 });
      return result.entries.some(entry => !documents.some(document => document.uri === entry.uri) && /\/memories\//.test(entry.uri)) && result;
    }, 'project session memory indexing');
    const entries = found.entries.filter(entry => /\/memories\//.test(entry.uri)); let matched;
    for (const entry of entries) {
      const read = await store.memoryService.read(projectA.id, { uri: entry.uri, level: 'L2' });
      if (/(?:周四|星期四|Thursday)/i.test(read.content) && /(?:三点|三時|15[:：]00|3\s*(?:p\.?m\.?|点)|three)/i.test(read.content)) { matched = entry; report.session.memory = { uri: entry.uri, sha256: digest(read.content), chars: read.content.length, score: entry.score }; break; }
    }
    assert.ok(matched, 'Retrieved memory must preserve both the agreed weekday and hour');
    const recalled = await store.memoryService.recall(projectA.id, { query, budgetTokens: 4000, limit: 20 });
    assert.ok(recalled.entries.some(entry => /\/memories\//.test(entry.uri)), 'Foreground recall must include extracted memory candidates');
    return { uri: matched.uri, semanticQuery: query, recallCandidates: recalled.entries.length };
  });
  await check('session memories, sessions and extraction tasks stay within their project', async () => {
    assert.ok(report.session?.memory?.uri, 'Recall prerequisite failed');
    await assert.rejects(store.memoryService.read(projectB.id, { uri: report.session.memory.uri, level: 'L2' }), error => error.status === 403);
    await assert.rejects(store.memoryService.sessionMessages(projectB.id, binding.sessionId, { messages: [{ role: 'user', content: 'Unauthorized cross-project append' }] }), error => error.status === 404);
    await assert.rejects(store.memoryService.sessionTask(projectB.id, binding.sessionId, commit.result.task_id), error => error.status === 404);
    const found = await store.memoryService.search(projectB.id, { query: 'When is the recurring design review meeting?', level: 'L2', limit: 20 });
    assert.ok(found.entries.every(entry => entry.uri !== report.session.memory.uri));
    return { crossProjectReadRejected: true, crossSessionAppendRejected: true, crossTaskReadRejected: true, foreignMemoryAbsent: true };
  });
  await check('a real chat turn automatically archives and extracts memory, then a new conversation recalls it', async () => {
    // Use the real provider through the unmodified production RuntimeController.
    // A new conversation for the second turn rules out ordinary chat-history recall.
    const sourceState = readPrivateJSON(join(root, 'prototypes/control-center/.state/state.json'));
    const sourceProvider = sourceState.configuration.providers.find(provider => provider.baseUrl === vlm.api_base);
    const sourceModel = sourceProvider?.models.find(model => model.id === vlm.model); assert.ok(sourceModel, 'Use a configured, actually discovered real model');
    const provider = store.configurationService.provider(null, { name: 'Real semantic acceptance model', protocol: 'openai', baseUrl: vlm.api_base, apiKey: vlm.api_key, models: [{ ...sourceModel, maxOutputTokens: 1024 }] });
    store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: vlm.model, reasoning: 'off' }, memory: { autoStore: true, autoRecall: true, contextBudget: 4000 } });
    const { project, session } = store.createProject({ name: '真实聊天记忆验收', description: 'Isolated real chat and real semantic memory round trip.', workspace: folder, initiative: { enabled: false } });
    store.mutate(state => { const target = state.projects.find(row => row.id === project.id); target.assignments = { skillIds: [], toolIds: ['openviking_search', 'openviking_read'], mcpServerIds: [] }; state.settings.realTokenBudget = 50000; });
    runtime = new RuntimeController(store);
    store.message(session.id, { text: '这个项目已经确认的长期交付规则：每一版客户演示必须在周二上午十点前准备好，演示彩排固定在前一天晚上八点。这里只需用一句话确认，不要执行工具或创建文件。' });
    const stateOf = id => store.state.sessions.find(row => row.id === id);
    const first = await until(() => { const turn = stateOf(session.id).turns.at(-1); return turn && ['completed', 'failed', 'stopped'].includes(turn.status) && turn; }, 'first real chat completion', 180000);
    report.automaticChat = { projectId: project.id, firstSessionId: session.id, firstTurnId: first.id, firstStatus: first.status, firstUsage: first.usage };
    assert.equal(first.status, 'completed'); assert.equal(first.modelConfig.execution, 'rna'); assert.ok(first.usage?.totalTokens > 0);
    const firstJournal = readFileSync(stateOf(session.id).runtime.sessionFile, 'utf8'), firstJournalPath = join(privateAuditDirectory, `${runId}-first-chat.jsonl`);
    writeFileSync(firstJournalPath, firstJournal, { mode: 0o600 }); report.automaticChat.firstJournal = { path: firstJournalPath, sha256: digest(firstJournal), counters: journalCounts(firstJournal) };
    const write = await until(() => {
      const value = stateOf(session.id).turns.find(turn => turn.id === first.id)?.memoryWrite;
      return value && ['completed', 'failed', 'uncertain', 'skipped'].includes(value.status) && value;
    }, 'automatic real memory extraction', 240000);
    report.automaticChat.memoryWrite = { status: write.status, code: write.code ?? null, sessionId: write.sessionId, taskId: write.taskId, memoriesExtracted: write.memoriesExtracted, extractionCounts: write.extractionCounts, tokenUsage: write.tokenUsage };
    assert.equal(write.status, 'completed', `Automatic outbox stopped at ${write.status} (${write.code ?? 'no code'})`); assert.ok(write.memoriesExtracted > 0);
    const followup = store.createSession({ title: 'A separate conversation recalls the project agreement', projectId: project.id });
    store.message(followup.id, { text: 'For this project, when must the customer demo be ready, and when is the rehearsal? 请用中文回答，根据已保存的项目记忆，必要时读取原文，不要猜测。' });
    const second = await until(() => { const turn = stateOf(followup.id).turns.at(-1); return turn && ['completed', 'failed', 'stopped'].includes(turn.status) && turn; }, 'new-conversation real recall completion', 180000);
    const resultSession = stateOf(followup.id), answer = resultSession.items.filter(item => item.kind === 'assistant' && item.turnId === second.id).map(item => item.text).join('\n');
    const entries = second.memoryContext?.entries ?? [], journal = readFileSync(resultSession.runtime.sessionFile, 'utf8');
    const secondJournalPath = join(privateAuditDirectory, `${runId}-recalled-chat.jsonl`); writeFileSync(secondJournalPath, journal, { mode: 0o600 });
    report.automaticChat.second = { sessionId: followup.id, turnId: second.id, status: second.status, usage: second.usage, memoryUris: entries.map(entry => entry.uri), journalSha256: digest(journal), answerSha256: digest(answer), answerChars: answer.length,
      journalPath: secondJournalPath, counters: journalCounts(journal),
      demoWeekdayCorrect: /周二|星期二|礼拜二|Tuesday/i.test(answer), demoHourCorrect: /十点|10\s*[:：]\s*00|10\s*(?:点|时|a\.?m\.?)/i.test(answer), rehearsalWeekdayCorrect: /周一|星期一|礼拜一|前一天|Monday/i.test(answer), rehearsalHourCorrect: /八点|20\s*[:：]\s*00|20\s*(?:点|时)|8\s*p\.?m\.?|(?:晚上|晚间|夜里)\s*(?:八|8)\s*(?:点|[:：]\s*00)/i.test(answer) };
    assert.equal(second.status, 'completed'); assert.ok(second.usage?.totalTokens > 0);
    assert.ok(entries.some(entry => /\/memories\//.test(entry.uri)), 'New conversation must receive memory through production recall');
    assert.ok(entries.some(entry => /\/memories\//.test(entry.uri) && journal.includes(entry.uri)), 'Actual SDK journal must contain the recalled memory source');
    for (const key of ['demoWeekdayCorrect', 'demoHourCorrect', 'rehearsalWeekdayCorrect', 'rehearsalHourCorrect']) assert.equal(report.automaticChat.second[key], true, `The real reply missed ${key}`);
    return { realProvider: vlm.model, automaticExtraction: true, separateConversation: true, realReplyVerified: true };
  });
  report.ok = checks.every(check => check.ok);
} catch (error) { report.ok = false; report.error = safeError(error); }
finally {
  // Private QA credentials stay in the ignored semantic runtime directory for
  // later removal/audit; no test conversation is stored in the actual Rna tenant.
  try { await runtime?.close(); } catch (error) { report.ok = false; report.cleanupError = safeError(error); }
  report.finishedAt = new Date().toISOString(); report.retention = 'Isolated QA tenant retained for audit; temporary host Store removed';
  writeFileSync(reportPath, JSON.stringify(report, null, 2)); rmSync(folder, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: report.ok, passed: checks.filter(check => check.ok).length, checks: checks.length, report: reportPath })); if (!report.ok) process.exitCode = 1;
}
