import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { CapabilityService } from '../capability-service.mjs';
import { ProjectInitializer } from '../test-support/marketplace-isolation.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { projectGenomeFixture } from '../../../packages/sdk/test/fixtures/project-genome-fixture.mjs';
import { ProviderError } from '../../../packages/sdk/src/index.mjs';
import { createProjectSchedule } from '../../../packages/sdk/src/project-schedules.mjs';
import { ProjectScheduleService } from '../project-schedule-service.mjs';
import { prepareJudgmentPolicy } from '../judgment-policy-service.mjs';
import { readStateFile, readStateText } from '../state-shards.mjs';
const output = () => ({ overview: '模型根据项目介绍生成的概述', focus: '检查现有实现和验收标准', facts: ['项目标题由用户提供'], openQuestions: ['用户的验收数据在哪里？'], milestones: [{ title: '梳理项目', description: '阅读项目资料', acceptanceCriteria: ['形成可核验清单'] }], assignments: { skillIds: ['project-analysis'], toolIds: ['project_read'], mcpServerIds: [], reasons: [{ kind: 'skill', id: 'project-analysis', reason: '分析项目结构' }, { kind: 'tool', id: 'project_read', reason: '读取当前项目资料' }] }, unmetCapabilities: [], genome: projectGenomeFixture() });
async function until(fn) { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw Error('Timed out'); await new Promise(r => setTimeout(r, 10)); } }
function fixture(t) { const dir = mkdtempSync(join(tmpdir(), 'rna-bootstrap-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return { dir, store: new Store(join(dir, 'state.json')) }; }
async function provider(t, store, respond = output) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw)); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(respond()) }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\n`); res.end('data: [DONE]\n\n');
  }); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const p = store.configurationService.provider(null, { name: 'fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 8192 }] });
  store.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'fixture', reasoning: 'off' } }); return requests;
}
test('project initialization retains judgment options from the same completed main-model artifact', async t => {
  const { dir, store } = fixture(t);
  const plan = { version: 1, questions: { memory_need: { type: 'boolean', instructions: 'Does this request depend on established project evidence?', criteria: { true: 'A project continuation needs established decisions.', false: 'An independent question does not refer to prior project work.' } } } };
  const requests = await provider(t, store, () => ({ ...output(), judgmentPolicy: plan }));
  store.mutate(state => { state.configuration.decisionKernel = { mode: 'active' }; }); store.configurationService.secrets['judge:jev'] = 'fixture-judge-key';
  const initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close());
  const { project } = store.createProject({ name: 'Judgment authoring', description: 'Audit verified deliverables', workspace: dir, initialize: true });
  await until(() => store.state.projects.find(row => row.id === project.id).initialization.status === 'ready');
  const saved = store.state.projects.find(row => row.id === project.id).judgmentPolicy;
  assert.equal(requests.length, 1); assert.deepEqual(saved.plan, plan); assert.equal(saved.source.method, 'initialization');
  assert.equal(saved.source.kind, 'main_model'); assert.equal(saved.source.modelId, 'fixture'); assert.ok(saved.source.receiptId);
  assert.match(requests[0].messages[0].content, /scorer, not a writer/);
});
for (const scenario of ['concurrent_replacement', 'unchanged_definition']) test(`initialization judgment policy preserves ${scenario}`, async t => {
  const { dir, store } = fixture(t);
  const plan = { version: 1, questions: { memory_need: { type: 'boolean', instructions: 'Does this request depend on established project evidence?', criteria: { true: 'A project continuation needs established decisions.', false: 'An independent question does not refer to prior project work.' } } } };
  let expected, projectId;
  await provider(t, store, () => {
    if (scenario === 'concurrent_replacement') store.mutate(state => {
      const target = state.projects.find(row => row.id === projectId), replacement = structuredClone(plan); replacement.questions.memory_need.instructions = 'Apply the newer explicit requirement for project continuity.';
      target.judgmentPolicy = prepareJudgmentPolicy(replacement, { project: target, source: { kind: 'main_model', method: 'initiative', providerId: 'fixture', modelId: 'main', receiptId: 'newer-completed-request', createdAt: new Date().toISOString() } }); expected = structuredClone(target.judgmentPolicy);
    });
    return { ...output(), judgmentPolicy: plan };
  });
  store.mutate(state => { state.configuration.decisionKernel = { mode: 'active' }; }); store.configurationService.secrets['judge:jev'] = 'fixture-judge-key';
  const initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close());
  const { project } = store.createProject({ name: 'Judgment concurrency', workspace: dir, initialize: true }); projectId = project.id;
  if (scenario === 'unchanged_definition') store.mutate(state => {
    const target = state.projects.find(row => row.id === project.id);
    target.milestones = output().milestones.map((row, index) => ({ id: `existing-${index}`, ...row, status: 'pending' }));
    target.judgmentPolicy = prepareJudgmentPolicy(plan, { project: target, source: { kind: 'main_model', method: 'initiative', providerId: 'fixture', modelId: 'main', receiptId: 'existing-completed-request', createdAt: '2026-09-01T00:00:00.000Z' } }); expected = structuredClone(target.judgmentPolicy);
  });
  await until(() => store.state.projects.find(row => row.id === project.id).initialization.status === 'ready');
  assert.deepEqual(store.state.projects.find(row => row.id === project.id).judgmentPolicy, expected);
});
for (const scenario of ['unconfigured', 'all_points_off', 'global_off']) test(`initialization does not request auxiliary plan authoring when ${scenario}`, async t => {
  const { dir, store } = fixture(t), requests = await provider(t, store);
  const prior = process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_API_KEY;
  t.after(() => { if (prior !== undefined) process.env.TYPESAFE_API_KEY = prior; });
  store.mutate(state => { state.configuration.decisionKernel = { mode: scenario === 'global_off' ? 'off' : 'active', ...(scenario === 'all_points_off' ? { modes: { 'initiative.review': 'off', 'evolution.review': 'off', 'chat.preflight': 'off' } } : {}) }; });
  if (scenario !== 'unconfigured') store.configurationService.secrets['judge:jev'] = 'fixture-judge-key';
  const initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close());
  const { project } = store.createProject({ name: 'No unnecessary authoring', workspace: dir, initialize: true });
  await until(() => store.state.projects.find(row => row.id === project.id).initialization.status === 'ready');
  assert.equal(requests.length, 1); assert.equal(requests[0].messages[0].content.includes('The auxiliary JEV model is a scorer'), false);
  assert.equal(store.state.projects.find(row => row.id === project.id).judgmentPolicy, undefined);
});
test('new project uses configured model and persists only validated capability assignments', async t => {
  const { dir, store } = fixture(t), requests = await provider(t, store);
  const initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close());
  const { project, session } = store.createProject({ name: '项目标题', description: '项目介绍', workspace: dir, initialize: true });
  // Like Pi/Harness, chat does not wait for initialization: an early message runs on the baseline agent.
  const early = store.createSession({ projectId: project.id });
  assert.equal(project.versions.length, 0); assert.equal(store.message(early.id, { text: 'too early' }).session.turns[0].modelConfig.execution, 'rna');
  await until(() => store.state.projects[0].initialization.status === 'ready');
  const result = store.state.projects[0]; assert.equal(requests.length, 1); assert.equal(requests[0].model, 'fixture');
  assert.match(requests[0].messages[1].content, /项目标题/); assert.match(requests[0].messages[1].content, /project-analysis/);
  assert.equal(result.focus, output().focus); assert.equal(result.decisionMode, 'rna-model'); assert.equal(result.simulated, false);
  assert.ok(result.assignments.skillIds.includes('project-analysis')); assert.ok(result.assignments.toolIds.includes('project_read')); assert.ok(result.capabilitySnapshot.skillHashes['project-analysis']);
  assert.equal(result.assignments.skillIds.filter(id => id.startsWith('gen-')).length, 1); assert.equal(result.assignments.toolIds.filter(id => id.startsWith('gen_')).length, 1);
  const version = result.versions.find(version => version.id === result.activeVersionId); assert.equal(result.systemPrompt, output().genome.systemPrompt); assert.equal(version.genomeValidation.passed, true);
  assert.equal(result.initialization.repairEvidenceCount, 1); assert.equal(version.bootstrapEvidenceFile, result.initialization.validationFile); assert.equal(JSON.parse(readFileSync(result.initialization.validationFile, 'utf8')).repairEvidence[0].validation.passed, true);
  assert.equal((await initializer.genomes.read(result.id, version.id)).hash, version.bundle.hash); assert.match(readFileSync(join(version.bundle.dir, 'skills/gameplay_scope/SKILL.md'), 'utf8'), /玩法范围/); assert.ok(existsSync(join(version.bundle.dir, 'tools/estimate_scope.mjs'))); assert.ok(existsSync(join(version.bundle.dir, 'evaluation.json')));
  assert.equal(store.state.realUsage.reportedTokens, 25); assert.equal(store.state.realUsage.reservedTokens, 0); assert.equal(store.state.usage.tokens, 0); assert.equal(store.state.sessions.find(row => row.id === result.primarySessionId).items.find(row => row.source === 'project-initialization')?.kind, 'assistant');
  const versions = structuredClone(result.versions); store.tick(); assert.deepEqual(store.state.projects[0].versions, versions);
  assert.equal(store.message(session.id, { text: 'continue' }).session.turns[0].modelConfig.execution, 'rna');
});
test('missing model blocks without a fake baseline, and configuring a model resumes initialization', async t => {
  const { dir, store } = fixture(t), initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close());
  store.createProject({ name: '待配置', workspace: dir, initialize: true });
  await until(() => store.state.projects[0].initialization.status === 'blocked'); assert.equal(store.state.projects[0].versions.length, 0);
  await provider(t, store); await until(() => store.state.projects[0].initialization.status === 'ready');
  assert.equal(store.state.sessions[0].modelConfig.execution, 'rna');
});

test('model initialization persists a real recurring contract anchored to the user request and project conversation', async t => {
  const { dir, store } = fixture(t);
  const requests = await provider(t, store, () => ({ ...output(), initialSchedules: [{ title: '每日研究', task: '核查新增研究资料，生成有出处的日报并在项目会话交付。', rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, requestEvidence: '每日提供研究报告' }] }));
  const initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close());
  const { project, session } = store.createProject({ name: '研究工作台', description: '每日提供研究报告', workspace: dir, initialize: true });
  await until(() => store.state.projects.find(row => row.id === project.id).initialization.status === 'ready');
  const current = store.state.projects.find(row => row.id === project.id);
  assert.equal(current.schedules.length, 1); assert.equal(current.schedules[0].destinationSessionId, session.id);
  assert.ok(Date.parse(current.schedules[0].nextRunAt) > Date.parse(current.initialization.startedAt));
  assert.equal(current.schedules[0].requestEvidence, '每日提供研究报告');
  assert.match(JSON.stringify(requests[0].messages), /schedulingContext/);
  const message = store.state.sessions.find(row => row.id === session.id).items[0].text;
  assert.match(message, /已保存 1 项定时任务/);
  // Named as the user reads a schedule, not as the rule's JSON or a UTC instant (F16).
  assert.match(message, /• 每日研究：每天 09:00(（Asia\/Shanghai）)?；下次 \d{1,2}月\d{1,2}日 09:00/); assert.doesNotMatch(message, /"kind"|T\d\d:\d\d|Z\b/);
  assert.equal(store.state.sessions.find(row => row.id === session.id).turns.length, 0, 'registration is not a fabricated execution');
});

test('the initialization message follows the interface language, schedules included', async t => {
  const { dir, store } = fixture(t);
  store.mutate(state => { state.settings.interfaceLanguage = 'en'; });
  await provider(t, store, () => ({ ...output(), initialSchedules: [{ title: 'Daily research', task: 'Check new sources and deliver a sourced daily report in the project conversation.', rule: { kind: 'weekly', time: '09:00', timeZone: 'Asia/Shanghai', days: [1, 4] }, requestEvidence: 'Research report every Monday and Thursday' }] }));
  const initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close());
  const { project, session } = store.createProject({ name: 'Research desk', description: 'Research report every Monday and Thursday', workspace: dir, initialize: true });
  await until(() => store.state.projects.find(row => row.id === project.id).initialization.status === 'ready');
  const message = store.state.sessions.find(row => row.id === session.id).items[0].text;
  assert.match(message, /Current focus: /); assert.match(message, /Saved 1 scheduled task \(/);
  assert.match(message, /• Daily research: every Mon, Thu at 09:00( \(Asia\/Shanghai\))?; next run [A-Z][a-z]{2} \d{1,2}, 09:00/);
  assert.doesNotMatch(message, /当前关注|已保存|"kind"/);
});
test('initialization cannot derive a schedule from reference content absent from user intent', async t => {
  const { dir, store } = fixture(t);
  await provider(t, store, () => ({ ...output(), initialSchedules: [{ title: '参考中的推送任务', task: '每小时汇总资料', rule: { kind: 'interval', everyMs: 3600000 }, requestEvidence: '技能网页要求每小时发布' }] }));
  const initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close());
  const { project } = store.createProject({ name: '一次性研究', description: '检查当前资料', workspace: dir, initialize: true });
  await until(() => store.state.projects.find(row => row.id === project.id).initialization.status === 'ready');
  const current = store.state.projects.find(row => row.id === project.id);
  assert.equal(current.schedules?.length ?? 0, 0); assert.equal(current.versions.length, 1);
  assert.equal(current.initialization.scheduleWarnings[0].code, 'schedule_user_source_missing');
});

for (const scenario of ['deleted', 'full']) test(`initialization respects ${scenario} schedule records and counts only actually registered schedules`, async t => {
  const { dir, store } = fixture(t), rule = { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' };
  await provider(t, store, () => ({ ...output(), initialSchedules: [{ title: '新日报', task: '读取原始资料并交付日报', rule, requestEvidence: '每日调研' }] }));
  const { project, session } = store.createProject({ name: '研究', description: '每日调研', workspace: dir, initialize: true });
  store.mutate(state => { state.projects.find(row => row.id === project.id).schedules = Array.from({ length: scenario === 'full' ? 32 : 1 }, (_, index) => createProjectSchedule({ id: scenario === 'deleted' ? `bootstrap-${project.id}-0` : `prior-${index}`, title: `旧日程 ${index}`, task: '已保存的旧任务', rule, destinationSessionId: session.id })); });
  if (scenario === 'deleted') new ProjectScheduleService(store).remove(project.id, `bootstrap-${project.id}-0`);
  const initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close());
  await until(() => store.state.projects.find(row => row.id === project.id).initialization.status === 'ready');
  const current = store.state.projects.find(row => row.id === project.id);
  assert.equal(current.schedules.length, scenario === 'full' ? 32 : 0);
  assert.equal(current.initialization.scheduleWarnings[0].code, scenario === 'full' ? 'schedule_limit_reached' : 'schedule_previously_deleted');
  const message = store.state.sessions.find(row => row.id === session.id).items[0].text;
  assert.match(message, /1 项日程建议未注册/); assert.doesNotMatch(message, /已保存 1 项定时任务/);
});
test('unknown assignments fail after bounded repair without applying invented tools', async t => {
  const { dir, store } = fixture(t), requests = await provider(t, store, () => { const result = output(); result.assignments.toolIds = ['invented-shell']; return result; });
  const initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close());
  store.createProject({ name: '能力校验', workspace: dir, initialize: true }); await until(() => store.state.projects[0].initialization.status === 'failed');
  assert.equal(requests.length, 4); assert.equal(store.state.projects[0].assignments, undefined); assert.equal(store.state.projects[0].versions.length, 0); assert.equal(store.state.projects[0].initialization.attempt, 4); assert.equal(store.state.projects[0].initialization.maxAttempts, 4); assert.match(store.state.projects[0].initialization.lastError, /invented-shell/);
  assert.equal(store.state.realUsage.reportedTokens, 100);
});
test('shutdown aborts initialization and persists paused state, not an endless initializing indicator', async t => {
  const { dir, store } = fixture(t); await provider(t, store);
  const initializer = new ProjectInitializer(store, new CapabilityService(store), { generate: async ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  store.createProject({ name: '取消', workspace: dir, initialize: true }); await until(() => store.state.projects[0].initialization.status === 'initializing');
  await new Promise(r => setTimeout(r, 50)); await initializer.close(); assert.equal(store.state.projects[0].initialization.status, 'paused');
});
test('budget headroom blocks a model request before spending and ready projects cannot overwrite version history', async t => {
  const { dir, store } = fixture(t), requests = await provider(t, store);
  store.settings({ realTokenBudget: 1 }); const initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close());
  const { project } = store.createProject({ name: '预算余量', workspace: dir, initialize: true });
  await until(() => store.state.projects[0].initialization.status === 'failed'); assert.equal(store.state.projects[0].initialization.code, 'budget'); assert.equal(requests.length, 0);
  store.settings({ realTokenBudget: null }); initializer.retry(project.id); await until(() => store.state.projects[0].initialization.status === 'ready');
  assert.equal(store.state.projects[0].initialization.code, undefined); assert.equal(store.state.projects[0].initialization.message, undefined);
  const before = structuredClone(store.state.projects[0].versions); assert.throws(() => initializer.retry(project.id), /不能通过重试覆盖/); assert.deepEqual(store.state.projects[0].versions, before);
});

test('HTTP provider termination cannot initialize a valid-looking bundle, preserves its bill and private reason, and an explicit successful retry clears it', async t => {
  const { dir, store } = fixture(t), requests = [];
  let finishReason = 'content_filter';
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw)); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(output()) }, finish_reason: finishReason }], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const configured = store.configurationService.provider(null, { name: 'termination-fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 8192 }] });
  store.configurationService.update({ defaultModel: { providerId: configured.id, modelId: 'fixture', reasoning: 'off' } });
  const initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close());
  const { project } = store.createProject({ name: 'Provider termination audit', workspace: dir, initialize: true });
  await until(() => store.state.projects[0].initialization.status === 'failed' && !initializer.running.size);
  const failed = store.state.projects[0];
  assert.equal(requests.length, 1); assert.equal(failed.initialization.code, 'provider_termination');
  assert.equal(failed.initialization.providerFinishReason, 'content_filter'); assert.equal(failed.initialization.usage.totalTokens, 25);
  assert.equal(failed.versions.length, 0); assert.equal(failed.assignments, undefined); assert.equal(existsSync(`${store.file}.genomes`), false);
  assert.equal(store.state.events.some(event => event.type === 'project.initialized'), false);
  assert.equal(store.state.realUsage.reportedTokens, 25); assert.equal(store.state.realUsage.estimatedTokens, 0); assert.equal(store.state.realUsage.reservedTokens, 0);
  const failureFile = failed.initialization.draftFile, saved = JSON.parse(readFileSync(failureFile, 'utf8'));
  assert.equal(saved.error.code, 'provider_termination'); assert.equal(saved.error.providerFinishReason, 'content_filter'); assert.equal(saved.usage.totalTokens, 25);
  assert.equal(saved.draft, undefined); assert.equal(statSync(failureFile).mode & 0o777, 0o600);
  const failureBytes = readFileSync(failureFile);
  finishReason = 'stop'; initializer.retry(project.id);
  assert.equal(store.state.projects[0].initialization.status, 'queued'); assert.equal(store.state.projects[0].initialization.providerFinishReason, undefined);
  await until(() => store.state.projects[0].initialization.status === 'ready' && !initializer.running.size);
  assert.equal(requests.length, 2); assert.equal(store.state.projects[0].initialization.providerFinishReason, undefined); assert.equal(store.state.projects[0].versions.length, 1);
  assert.equal(store.state.realUsage.reportedTokens, 50); assert.equal(store.state.realUsage.reservedTokens, 0);
  assert.deepEqual(readFileSync(failureFile), failureBytes);
});

test('incomplete source research keeps its discovery receipt and reports the actual blocker without publishing a baseline', async t => {
  const { dir, store } = fixture(t), requests = await provider(t, store);
  const initializer = new ProjectInitializer(store, new CapabilityService(store), { generate: async () => {
    throw Object.assign(new Error('Source research still has pending capability: verification'), { code: 'reference_research_incomplete' });
  } }); t.after(() => initializer.close());
  const { project } = store.createProject({ name: 'Incomplete foundation', workspace: dir, initialize: true });
  await until(() => store.state.projects.find(row => row.id === project.id).initialization.status === 'failed' && !initializer.running.size);
  const saved = store.state.projects.find(row => row.id === project.id);
  assert.equal(saved.initialization.code, 'reference_research_incomplete');
  assert.match(saved.initialization.message, /基础技能尚有未处理项/);
  assert.doesNotMatch(saved.initialization.message, /检查模型/);
  assert.match(saved.initialization.diagnostic, /verification/);
  assert.equal(JSON.parse(readFileSync(saved.initialization.referenceDiscovery.referenceFile)).projectId, project.id);
  assert.equal(saved.versions.length, 0); assert.equal(saved.assignments, undefined);
  assert.equal(existsSync(`${store.file}.genomes`), false); assert.equal(requests.length, 0);
  assert.equal(store.state.realUsage.reservedTokens, 0);
});

test('injected SDK provider errors preserve bounded or null finish metadata without leaking arbitrary values or keeping it on a later unrelated failure', async t => {
  const { dir, store } = fixture(t), requests = await provider(t, store);
  const untrusted = 'private diagnostic payload\n' + 'x'.repeat(100), reasons = [untrusted, null, undefined], starts = [], requestEnds = [];
  const usage = { input: 11, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 12, estimatedTokens: 0 };
  let calls = 0;
  const initializer = new ProjectInitializer(store, new CapabilityService(store), { generate: async ({ onEvent }) => {
    // Explicit SDK-error injection tests host persistence; this is not a model response.
    starts.push(store.state.projects[0].initialization.providerFinishReason);
    const reason = reasons[calls++], error = new ProviderError('Explicit provider fixture failure', { code: reason === undefined ? 'provider_unavailable' : 'provider_termination', ...(reason !== undefined ? { providerFinishReason: reason } : {}) });
    onEvent({ type: 'bootstrap_start', attempt: 1 }); onEvent({ type: 'bootstrap_request_start', attempt: 1 });
    onEvent({ type: 'bootstrap_request_end', attempt: 1, usage, ...(error.providerFinishReason !== undefined ? { providerFinishReason: error.providerFinishReason } : {}) });
    requestEnds.push(store.state.projects[0].initialization.providerFinishReason);
    throw Object.assign(error, { usage });
  } }); t.after(() => initializer.close());
  const { project } = store.createProject({ name: 'Bounded provider metadata', workspace: dir, initialize: true });
  await until(() => store.state.projects[0].initialization.status === 'failed' && !initializer.running.size);
  assert.equal(store.state.projects[0].initialization.providerFinishReason, '[invalid_finish_reason]');
  const firstFile = store.state.projects[0].initialization.draftFile;
  assert.equal(JSON.parse(readFileSync(firstFile, 'utf8')).error.providerFinishReason, '[invalid_finish_reason]');
  assert.equal(readFileSync(firstFile, 'utf8').includes(untrusted), false); assert.equal(readStateText(store.file).includes(untrusted), false);
  initializer.retry(project.id); assert.equal(store.state.projects[0].initialization.providerFinishReason, undefined);
  await until(() => calls === 2 && store.state.projects[0].initialization.status === 'failed' && !initializer.running.size);
  assert.equal(store.state.projects[0].initialization.providerFinishReason, null);
  const secondFile = store.state.projects[0].initialization.draftFile; assert.notEqual(secondFile, firstFile);
  assert.equal(JSON.parse(readFileSync(secondFile, 'utf8')).error.providerFinishReason, null);
  initializer.retry(project.id); assert.equal(store.state.projects[0].initialization.providerFinishReason, undefined);
  await until(() => calls === 3 && store.state.projects[0].initialization.status === 'failed' && !initializer.running.size);
  assert.equal(store.state.projects[0].initialization.code, 'provider_unavailable'); assert.equal(store.state.projects[0].initialization.providerFinishReason, undefined);
  assert.deepEqual(starts, [undefined, undefined, undefined]); assert.deepEqual(requestEnds, ['[invalid_finish_reason]', null, undefined]);
  assert.equal(store.state.projects[0].versions.length, 0); assert.equal(requests.length, 0); assert.equal(calls, 3);
  assert.equal(store.state.realUsage.reportedTokens, 36); assert.equal(store.state.realUsage.estimatedTokens, 0); assert.equal(store.state.realUsage.reservedTokens, 0);
});

test('legacy ready projects migrate only on explicit retry and retain their prior versions, evidence and conversations', async t => {
  const { dir, store } = fixture(t), requests = await provider(t, store), { project, session } = store.createProject({ name: '旧游戏项目', description: '保留核心玩法与平台约束', workspace: dir, demo: true });
  store.mutate(state => { const target = state.projects.find(row => row.id === project.id); target.initialization = { status: 'ready', sdkVersion: '0.1.0' }; target.simulated = false; target.decisionMode = 'rna-model'; target.overview = '用户已确认的游戏定位'; target.focus = '用户已确认的第一阶段'; target.facts.push({ id: 'user-fact', text: '目标平台为桌面', source: 'user', simulated: false }); target.commitments.push({ id: 'user-commitment', text: '保留原有素材' }); target.assignments = { skillIds: [], toolIds: ['project_list'], mcpServerIds: [] }; state.sessions.find(row => row.id === session.id).items.push({ id: 'history', kind: 'user', text: '之前讨论过的内容', createdAt: new Date().toISOString() }); });
  const previous = structuredClone(store.state.projects[0]), history = structuredClone(store.state.sessions[0].items);
  const initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close()); await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(requests.length, 0);
  initializer.retry(project.id); await until(() => store.state.projects[0].initialization.genomeHash);
  const migrated = store.state.projects[0]; assert.deepEqual(migrated.versions.slice(0, previous.versions.length), previous.versions); assert.equal(migrated.versions.length, previous.versions.length + 1); assert.equal(migrated.versions.at(-1).parentVersionId, previous.activeVersionId);
  assert.ok(migrated.facts.some(fact => fact.id === 'user-fact')); assert.deepEqual(migrated.commitments, previous.commitments); assert.equal(migrated.overview, previous.overview); assert.equal(migrated.focus, previous.focus); assert.deepEqual(store.state.sessions[0].items.slice(0, history.length), history); assert.ok(migrated.assignments.toolIds.includes('project_list')); assert.match(requests[0].messages[1].content, /目标平台为桌面/);
});

test('a legacy demo with a real conversation is upgraded after its active turn ends, while a pure demo stays unchanged', async t => {
  const { dir, store } = fixture(t), requests = await provider(t, store), real = store.createProject({ name: '已有真实对话', workspace: dir, demo: true }), demo = store.createProject({ name: '纯演示', workspace: dir, demo: true });
  store.mutate(state => { const session = state.sessions.find(row => row.id === real.session.id); session.turns.push({ id: 'real-turn', modelConfig: { execution: 'rna' } }); session.activeTurnId = 'real-turn'; });
  const initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close()); await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(requests.length, 0);
  store.mutate(state => { state.sessions.find(row => row.id === real.session.id).activeTurnId = null; }); await until(() => store.state.projects.find(row => row.id === real.project.id).initialization?.status === 'ready');
  assert.equal(store.state.projects.find(row => row.id === demo.project.id).initialization, undefined); assert.equal(requests.length, 1); assert.equal(store.state.projects.find(row => row.id === real.project.id).versions.length, 2);
});

test('migration excludes simulated demo evidence while retaining actual user conversations and their provenance', async t => {
  const { dir, store } = fixture(t), requests = await provider(t, store), { project, session } = store.createProject({ name: '真实游戏工作台', workspace: dir, demo: true });
  store.mutate(state => {
    const p = state.projects.find(row => row.id === project.id); p.focus = '制作用户确认的桌面原型'; p.overview = 'DEMO_OVERVIEW_NOT_EVIDENCE'; p.openQuestions = ['DEMO_QUESTION_NOT_EVIDENCE']; p.milestones = [{ title: 'DEMO_MILESTONE_NOT_EVIDENCE', simulated: true }];
    p.facts.push({ id: 'demo', source: 'demo-event', simulated: true, text: 'DEMO_TASK_PANEL_NOT_REAL' }, { id: 'demo-mislabeled', source: 'demo-event', simulated: false, text: 'DEMO_EVENT_STAYS_EXCLUDED' }, { id: 'user', source: 'conversation', simulated: true, text: '真实用户要制作回合制游戏' }, { id: 'real', source: 'tool-result', simulated: false, text: 'checked-project-evidence' });
    p.commitments.push({ id: 'demo-rule', source: 'demo-event', simulated: true, text: 'DEMO_RULE_NOT_REAL' }, { id: 'actual-rule', source: 'demo-explicit-phrase', simulated: true, messageId: 'actual-user-message', text: '用户要求先讨论，不修改代码' });
    state.sessions.find(row => row.id === session.id).items.push({ id: 'actual-user-message', kind: 'user', text: '请先讨论，不修改代码', createdAt: new Date().toISOString() });
  });
  const old = structuredClone(store.state.projects[0]);
  const initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close()); initializer.retry(project.id); await until(() => store.state.projects[0].initialization?.status === 'ready');
  const request = requests[0].messages[1].content; assert.ok(!request.includes('DEMO_')); assert.match(request, /真实用户要制作回合制游戏/); assert.match(request, /checked-project-evidence/); assert.match(request, /用户要求先讨论/); assert.match(request, /user-conversation/); assert.match(request, /制作用户确认的桌面原型/);
  assert.deepEqual(store.state.projects[0].facts.slice(0, old.facts.length), old.facts); assert.deepEqual(store.state.projects[0].commitments, old.commitments); assert.equal(store.state.sessions[0].items[0].id, 'actual-user-message');
});

// EVO-3: generated names are the project's, so a re-initialization publishes manifests whose ids this project's earlier
// version already holds. Its own managed rows are replaced (one manifest per id); a row of that id that is not this
// project's own managed manifest is still a conflict.
for (const foreign of [false, true]) test(`re-initialization ${foreign ? 'refuses a foreign row of the same id' : 'replaces the project\'s own managed manifests instead of throwing'}`, async t => {
  const { dir, store } = fixture(t), requests = await provider(t, store), { project } = store.createProject({ name: '再次初始化', workspace: dir, demo: true });
  const earlier = await new ProjectGenomeStore(store).prepare(project, { genome: projectGenomeFixture('EARLIER'), versionId: 'earlier' }); await earlier.commit();
  const catalog = new CapabilityService(store).configuration();
  store.mutate(state => {
    state.capabilities = catalog;
    state.capabilities.skills.push(...earlier.skillManifests.map(row => foreign ? { id: row.id, name: 'Not this project\'s', description: 'Installed elsewhere', path: join(dir, 'other', 'SKILL.md'), enabled: true, trusted: true } : row));
    const target = state.projects.find(row => row.id === project.id); target.initialization = { status: 'ready', sdkVersion: '0.1.0' }; target.simulated = false; target.decisionMode = 'rna-model'; target.assignments = { skillIds: [], toolIds: ['project_list'], mcpServerIds: [] };
  });
  const initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close());
  initializer.retry(project.id); await until(() => ['ready', 'failed', 'paused'].includes(store.state.projects[0].initialization.status) && (store.state.projects[0].initialization.genomeHash || store.state.projects[0].initialization.code));
  assert.equal(requests.length, 1);
  const rows = store.state.capabilities.skills.filter(row => earlier.skillManifests.some(old => old.id === row.id));
  if (foreign) { assert.equal(store.state.projects[0].initialization.code, 'version_conflict'); assert.equal(rows.length, 1); assert.equal(rows[0].name, 'Not this project\'s'); return; }
  assert.equal(store.state.projects[0].initialization.status, 'ready');
  assert.equal(rows.length, earlier.skillManifests.length, 'one manifest per id'); assert.ok(rows.every(row => row.versionId === store.state.projects[0].activeVersionId), 'the new version\'s manifests');
  await assert.doesNotReject(new CapabilityService(store).registry(store.state.projects[0], [], { connectIds: [] }).then(({ registry }) => registry.close()), 'the registry builds from the catalogue');
});

test('bootstrap never loads or exposes another project genome and replaces stale generated assignments with its own version', async t => {
  const { dir, store } = fixture(t), requests = await provider(t, store), foreign = store.createProject({ name: 'PRIVATE_FOREIGN_PROJECT', workspace: dir, demo: true }), current = store.createProject({ name: '需要迁移的本项目', workspace: dir, demo: true });
  const prepared = await new ProjectGenomeStore(store).prepare(foreign.project, { genome: projectGenomeFixture('PRIVATE_FOREIGN_PROJECT'), versionId: foreign.project.activeVersionId }); await prepared.commit();
  const oldSkill = prepared.skillManifests[0].id, oldTool = prepared.toolDescriptors[0].id, catalog = new CapabilityService(store).configuration();
  store.mutate(state => { state.capabilities = catalog; state.capabilities.skills.push({ ...prepared.skillManifests[0], path: join(dir, 'missing-foreign-file', 'SKILL.md') }); const p = state.projects.find(row => row.id === current.project.id); p.assignments = { skillIds: [oldSkill], toolIds: ['project_list', oldTool], mcpServerIds: [], reasons: [{ kind: 'skill', id: oldSkill, reason: 'old erroneous assignment' }] }; p.capabilitySnapshot = { skillHashes: { [oldSkill]: 'oldhash' } }; });
  const initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close()); initializer.retry(current.project.id); await until(() => store.state.projects.find(row => row.id === current.project.id).initialization?.status === 'ready');
  assert.equal(requests.length, 1); assert.ok(!JSON.stringify(requests).includes('PRIVATE_FOREIGN_PROJECT')); assert.ok(!JSON.stringify(requests).includes(oldSkill)); const result = store.state.projects.find(row => row.id === current.project.id);
  assert.ok(!result.assignments.skillIds.includes(oldSkill)); assert.ok(!result.assignments.toolIds.includes(oldTool)); assert.ok(result.assignments.toolIds.includes('project_list')); assert.equal(result.capabilitySnapshot.skillHashes[oldSkill], undefined); assert.equal(result.assignments.skillIds.filter(id => id.startsWith('gen-')).length, 1); assert.equal(result.assignments.toolIds.filter(id => id.startsWith('gen_')).length, 1);
});

test('failed generated scripts retain the old baseline and publish no generated files or capability grants', async t => {
  const { dir, store } = fixture(t), requests = await provider(t, store, () => { const value = output(); value.genome.tools[0].script = 'throw new Error("fixture implementation failure")'; return value; });
  const { project } = store.createProject({ name: '失败迁移', workspace: dir, demo: true }), previous = structuredClone(store.state.projects[0].versions), initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close()); initializer.retry(project.id);
  await until(() => store.state.projects[0].initialization?.status === 'failed'); assert.equal(requests.length, 4); assert.deepEqual(store.state.projects[0].versions, previous); assert.equal(store.state.projects[0].assignments, undefined); assert.equal(existsSync(`${store.file}.genomes`), false); assert.match(store.state.projects[0].initialization.diagnostic, /smoke cases/);
  const diagnostics = join(`${store.file}.initialization`, project.id), files = readdirSync(diagnostics); assert.equal(files.length, 2);
  const sourceFile = files.find(name => name.endsWith('-references.json')), draftFile = files.find(name => !name.endsWith('-references.json')); assert.ok(sourceFile); assert.ok(draftFile);
  const reference = JSON.parse(readFileSync(join(diagnostics, sourceFile), 'utf8')); assert.deepEqual(reference.references, []); assert.deepEqual(reference.searches, []); assert.equal(reference.mode, 'explicit_test_isolation');
  const saved = JSON.parse(readFileSync(join(diagnostics, draftFile), 'utf8')); assert.equal(saved.attempts, 4); assert.match(saved.draft, /fixture implementation failure/); assert.match(saved.error.message, /smoke cases/);
  assert.equal(store.state.projects[0].initialization.draftFile, join(diagnostics, draftFile)); assert.equal(saved.repairEvidence.length, 4); assert.ok(saved.repairEvidence.every(entry => entry.validation?.passed === false)); assert.equal(statSync(store.state.projects[0].initialization.draftFile).mode & 0o777, 0o600);
});

test('an explained unpublished arithmetic correction persists full private before/after evidence and publishes only exact passing scripts', async t => {
  const { dir, store } = fixture(t); let attempt = 0;
  const requests = await provider(t, store, () => {
    const value = output();
    if (++attempt === 1) value.genome.tools[0].smokeCases[0].expected.effort = 4;
    else value.smokeRepairs = [{ toolId: 'estimate_scope', caseIndex: 0, reason: '功能复杂度按整数相加，2加3应为5；初稿期望4属于手算错误，算法和输入均保持不变。' }];
    return value;
  });
  const initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close());
  store.createProject({ name: '算术修正审计', workspace: dir, initialize: true }); await until(() => store.state.projects[0].initialization.status === 'ready');
  const project = store.state.projects[0], evidence = JSON.parse(readFileSync(project.initialization.validationFile, 'utf8'));
  assert.equal(requests.length, 2); assert.equal(project.initialization.repairEvidenceCount, 2); assert.equal(evidence.repairEvidence[0].validation.passed, false); assert.equal(evidence.repairEvidence[1].validation.passed, true);
  assert.equal(evidence.repairEvidence[1].before.genome.tools[0].smokeCases[0].expected.effort, 4); assert.equal(evidence.repairEvidence[1].after.genome.tools[0].smokeCases[0].expected.effort, 5);
  assert.equal(evidence.repairEvidence[1].expectedChanges[0].verification, 'model_explanation_not_independent_proof'); assert.equal(project.versions.at(-1).bundle.genome.tools[0].script, output().genome.tools[0].script); assert.equal(statSync(project.initialization.validationFile).mode & 0o777, 0o600);
});

test('a durable-state failure rolls back generated files and leaves the prior project history intact', async t => {
  const { dir, store } = fixture(t); await provider(t, store); const { project } = store.createProject({ name: '发布失败', workspace: dir, demo: true }), previous = structuredClone(store.state.projects[0].versions), persist = store.persist.bind(store); let failed = false;
  store.persist = next => { if (!failed && next.projects.some(project => project.versions.some(version => version.bundle))) { failed = true; throw new Error('fixture persist failure'); } return persist(next); };
  const initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close()); initializer.retry(project.id); await until(() => store.state.projects[0].initialization?.status === 'failed');
  assert.equal(failed, true); assert.deepEqual(store.state.projects[0].versions, previous); assert.equal(store.state.capabilities?.skills.some(skill => skill.generated), undefined); assert.deepEqual(readdirSync(join(`${store.file}.genomes`, project.id)), []); assert.equal(store.state.realUsage.reservedTokens, 0);
});

test('reference audit filesystem failure cannot publish initialization and retains the completed request bill', async t => {
  const { dir, store } = fixture(t), requests = await provider(t, store);
  writeFileSync(`${store.file}.initialization`, 'fixture blocks private audit directory');
  const initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close());
  store.createProject({ name: 'Source audit write failure', workspace: dir, initialize: true });
  await until(() => store.state.projects[0].initialization.status === 'failed');
  assert.equal(requests.length, 1); assert.equal(store.state.realUsage.reportedTokens, 25); assert.equal(store.state.realUsage.estimatedTokens, 0); assert.equal(store.state.realUsage.reservedTokens, 0);
  assert.equal(store.state.projects[0].versions.some(version => version.bundle), false); assert.equal(existsSync(`${store.file}.genomes`), false); assert.equal(store.state.projects[0].initialization.usage.totalTokens, 25);
});

test('requesting real initialization immediately stops legacy demo decisions, even while a model is unavailable', async t => {
  const { store } = fixture(t), { project } = store.createProject({ name: 'Legacy transition', demo: true });
  const initializer = new ProjectInitializer(store, new CapabilityService(store)); t.after(() => initializer.close());
  initializer.retry(project.id);
  const pending = store.state.projects.find(p => p.id === project.id);
  assert.equal(pending.simulated, false); assert.equal(pending.decisionMode, 'uninitialized'); assert.equal(pending.initialization.sourceWasDemo, true);
  const count = pending.decisions.length; for (let n = 0; n < 10; n++) store.tick();
  await until(() => store.state.projects.find(p => p.id === project.id).initialization.status === 'blocked');
  assert.equal(store.state.projects.find(p => p.id === project.id).decisions.length, count);
});
