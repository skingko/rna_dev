#!/usr/bin/env node
// One bounded, explicitly authorized real-model observation in a private QA
// workspace. Source files and the one transport fault are controlled stimuli,
// not production user events. Memory is disabled, and no Goal is created.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { RuntimeController } from '../prototypes/control-center/runtime-controller.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../prototypes/control-center/store.mjs';
import { ProjectInitiativeController } from '../prototypes/control-center/project-initiative-controller.mjs';
import { createRnaRuntime } from '../prototypes/control-center/rna-runtime.mjs';
import { resolveModel } from '../prototypes/control-center/configuration.mjs';
import { streamCompletion } from '../packages/sdk/src/providers.mjs';

if (!process.argv.includes('--execute')) { console.log('Prepared only. --execute starts one isolated, paid real-model observation.'); process.exit(0); }
const reportArg = process.argv.indexOf('--report');
assert.ok(reportArg < 0 || process.argv[reportArg + 1] && !process.argv[reportArg + 1].startsWith('--'), '--report requires a path');
const reportFile = resolve(reportArg < 0 ? 'prototypes/control-center/qa/initiative-collaboration-real-report.json' : process.argv[reportArg + 1]);
// Reserve a new evidence file before reading credentials or making requests.
// A repeated invocation must never replace a previous observation.
writeFileSync(reportFile, JSON.stringify({ status: 'preparing', startedAt: new Date().toISOString() }), { flag: 'wx' });
const stateFile = resolve('prototypes/control-center/.state/state.json');
const original = JSON.parse(readFileSync(stateFile, 'utf8')), secrets = JSON.parse(readFileSync(`${stateFile}.secrets`, 'utf8'));
const selection = original.projects.find(project => project.initiativeRuntime?.modelSelection)?.initiativeRuntime.modelSelection ?? original.configuration.defaultModel;
const selected = resolveModel(original.configuration, selection), configured = original.configuration.providers.find(provider => provider.id === selected.providerId);
const apiKey = configured.apiKeyEnv ? process.env[configured.apiKeyEnv] : secrets[configured.id];
assert.ok(apiKey && selected.execution === 'rna' && /deepseek/i.test(selected.modelId) && /^https:\/\/api\.deepseek\.com(?:\/|$)/.test(selected.baseUrl), 'A currently configured real DeepSeek model is required');
const runId = randomUUID(), privateDirectory = resolve('deploy/openviking/.runtime/semantic/qa', `collaboration-${runId}`), workspace = join(privateDirectory, 'workspace');
mkdirSync(workspace, { recursive: true, mode: 0o700 });
const traceFile = join(privateDirectory, 'model-trace.jsonl');
const hash = text => createHash('sha256').update(text).digest('hex');
const files = {
  'export.mjs': 'export function normaliseLimit(value) { return value || 20; }\nexport function exportRows(rows, limit) { return rows.slice(0, normaliseLimit(limit)).map(({id,title}) => ({id,title})); }\n',
  'export-contract.md': '# 导出规范（隔离验收项目）\n\nlimit 是非负整数或 null/undefined。明确传入 0 时必须导出零行；缺省或 null 使用 20。只导出 id 与 title。当前实现及 cases.json 是待核对的源资料。本项目当前授权在此隔离项目内读写并执行本地验证。不要增加依赖、不要对外发布。\n',
  'cases.json': JSON.stringify({ rows: [{ id: 1, title: 'A', privateNote: 'excluded' }, { id: 2, title: 'B' }], limit: 0, expected: [] }, null, 2)
};
for (const [name, content] of Object.entries(files)) writeFileSync(join(workspace, name), content, { mode: 0o600 });
const { exportRows } = await import(pathToFileURL(join(workspace, 'export.mjs')).href), input = JSON.parse(files['cases.json']), actualRows = exportRows(input.rows, input.limit);
const store = new Store(join(privateDirectory, 'state.json'));
const provider = store.configurationService.provider(null, { name: 'Isolated real continuity acceptance', protocol: configured.protocol, baseUrl: configured.baseUrl, apiKey, models: [structuredClone(configured.models.find(model => model.id === selected.modelId))] });
store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: selected.modelId, reasoning: selected.reasoning }, memory: { autoStore: false, autoRecall: false } });
const { project, session } = store.createProject({ name: '导出边界复核工作台（独立验收）', description: '维护本项目的导出质量。export.mjs 与 export-contract.md 有明确边界规范，cases.json 是待修复用例。请依据真实文件自主检查、完成最小修复并验证0/null/undefined/正整数，验证结果写入 verification.json，再在项目会话报告。若一次模型请求中断，先用 project_history 查已完成工具证据，沿用结果继续，避免重做资料扫描。不加依赖、不改变公开函数签名、没有外部发布任务。', workspace,
  initiative: { enabled: true, cooldownMs: 0, tokenBudget: 120000, reviewMinMs: 5000, reviewMaxMs: 15000 }, evolution: { enabled: false } });
store.mutate(state => { const target = state.projects.find(row => row.id === project.id); target.decisionMode = 'rna-model'; target.simulated = false; target.initialization = { status: 'ready' }; target.overview = '根据实际源码及失败用例完成最小修复、真实验证、verification.json交付，再进行一次有用汇报。'; target.focus = '已有项目资料待检查，无需另建目标。'; target.permissions = { workspace: 'execute', background: 'inherit', revision: 1, source: 'acceptance-fixture' }; target.assignments = { skillIds: [], toolIds: ['project_read', 'project_list', 'project_write', 'project_edit', 'project_exec'], mcpServerIds: [] }; target.evolution.enabled = false; state.settings.realTokenBudget = 120000; });

const report = { schemaVersion: 1, runId, startedAt: new Date().toISOString(), privateDirectory,
  evidenceType: 'controlled project-state and source fixture with one injected transport failure after a real completed read, plus one controlled mid-request user clarification; configured real model decisions and SDK work/tools; no production user events',
  model: { id: selected.modelId, reasoning: selected.reasoning, contextWindow: selected.contextWindow, maxOutputTokens: selected.maxOutputTokens },
  limits: { totalTokens: 120000, decisionRequests: 6, elapsedMs: 480000, maxStepsPerWork: 8 }, projectId: project.id, sessionId: session.id,
  memory: { autoStore: false, autoRecall: false, remoteRequests: 0 }, noGoal: store.state.goals.length === 0,
  fixture: { files: Object.entries(files).map(([name, content]) => ({ name, sha256: hash(content), bytes: Buffer.byteLength(content) })), independentCheck: { expectedRows: 0, actualRows: actualRows.length, actualSha256: hash(JSON.stringify(actualRows)) } },
  decisions: [], requests: [], tools: [], status: 'running', observations: {} };
const deadline = AbortSignal.timeout(report.limits.elapsedMs);
let controller, foreground, decisionRequests = 0, faultInjected = false, steerInjected = false, workRuns = 0, stopReason = null;
function privateTrace(row) { appendFileSync(traceFile, `${JSON.stringify(row)}\n`, { mode: 0o600 }); }
function publish() { report.updatedAt = new Date().toISOString(); writeFileSync(reportFile, JSON.stringify(report, null, 2)); }
function fault(code, message) { return Object.assign(new Error(message), { code, usage: { totalTokens: 0 } }); }
function realProvider(kind, run = 0) {
  return async function* (request) {
    deadline.throwIfAborted();
    if (kind === 'work' && run === 1 && !faultInjected && report.tools.some(row => row.workRun === run && row.type === 'tool_execution_end' && row.name === 'project_read' && !row.isError)) {
      faultInjected = true;
      privateTrace({ type: 'controlled-transport-failure', at: new Date().toISOString(), workRun: run, providerRequestSent: false });
      yield { type: 'usage', usage: { totalTokens: 0 } };
      yield { type: 'error', error: { code: 'qa_transport_once', message: 'Controlled QA transport failure before this request was sent. Prior tools really completed; inspect their project_history action receipt, then continue the unfinished fix and verification.' } };
      return;
    }
    if (kind === 'decision' && decisionRequests >= 6) throw fault('qa_decision_limit', 'Explicit QA decision limit reached; no provider request was sent');
    if (kind === 'decision') {
      decisionRequests++;
      // The sixth admitted decision may still start legitimate background
      // work. Stop future review scheduling, not that already admitted work.
      if (decisionRequests === 6 && controller) { clearInterval(controller.timer); controller.schedule = () => {}; }
    }
    const number = report.requests.length + 1, started = Date.now(), row = { number, kind, startedAt: new Date().toISOString(), outputChars: 0, toolCalls: [], usage: null, ...(kind === 'decision' ? { afterInjectedFault: faultInjected } : {}) };
    report.requests.push(row); privateTrace({ type: 'request', number, kind, model: request.model, systemPrompt: request.systemPrompt, messages: request.messages, tools: request.tools });
    let output = '';
    try {
      for await (const event of streamCompletion({ ...request, signal: request.signal ? AbortSignal.any([request.signal, deadline]) : deadline })) {
        privateTrace({ type: 'event', number, kind, event });
        if (event.type === 'text_delta') output += event.delta ?? '';
        if (event.type === 'usage') row.usage = event.usage;
        if (event.type === 'tool_call') row.toolCalls.push({ name: event.name, id: event.id });
        if (event.type === 'done') row.stopReason = event.stopReason;
        if (kind === 'work' && run >= 2 && !steerInjected && report.tools.some(tool => tool.name === 'project_history' && tool.type === 'tool_execution_end' && !tool.isError) && ['text_delta', 'tool_call'].includes(event.type)) {
          steerInjected = true;
          report.userInterruption = { at: new Date().toISOString(), workRun: run, requestNumber: number, eventType: event.type };
          const sent = store.message(session.id, { text: '补充验收约束：不要增加新依赖，不改变公开函数签名；verification.json 应分别说明0、null、undefined和正整数的实际结果。请继续原项目修复与验证；这条补充先简短确认收到，不要另起无关任务。' });
          privateTrace({ type: 'controlled-user-steering', at: new Date().toISOString(), receipt: sent });
          report.userInterruption.signalAbortedSynchronously = request.signal?.aborted === true;
        }
        yield event;
      }
      if (kind === 'decision') {
        try { const value = JSON.parse(output.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1')); report.decisions.push({ cycle: decisionRequests, action: value.action, evidenceCount: value.evidenceIds?.length, contentChars: value.content?.length, contentSha256: hash(value.content ?? ''), reasonChars: value.reason?.length, afterInjectedFault: row.afterInjectedFault }); } catch { row.invalidDecision = true; }
      }
    } catch (error) { row.errorCode = /^[a-zA-Z0-9_.-]{1,80}$/.test(error.code ?? '') ? error.code : 'provider_failure'; throw error; }
    finally { row.durationMs = Date.now() - started; row.outputChars = output.length; row.outputSha256 = hash(output); publish(); }
  };
}
const removeListener = store.subscribe(() => {
  const projectNow = store.state.projects.find(row => row.id === project.id), sdk = projectNow?.initiativeRuntime?.sdkState;
  if (sdk?.lastFailure) report.lastFailure = { phase: sdk.lastFailure.phase, code: sdk.lastFailure.code };
});
try {
  foreground = new RuntimeController(store, { factory: options => createRnaRuntime({ ...options, provider: realProvider('foreground') }) });
  controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 500, maxConcurrentReviews: 1, decisionTimeoutMs: 120000, actionTimeoutMs: 240000, workMaxSteps: 8,
    decisionProvider: realProvider('decision'), runtimeFactory: async options => {
      const run = ++workRuns, handle = await createRnaRuntime({ ...options, provider: realProvider('work', run), onEvent: event => {
        privateTrace({ type: 'sdk-event', workRun: run, actionId: options.sessionId, event });
        if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') report.tools.push({ workRun: run, actionId: options.sessionId, type: event.type, name: event.toolName, toolCallId: event.toolCallId, isError: event.isError ?? event.result?.isError ?? false });
        options.onEvent?.(event);
      } });
      return handle;
    } });
  publish(); let previousProgress = '';
  while (!deadline.aborted) {
    const context = controller.contexts.get(project.id), sdk = context?.coordinator.snapshot(), remaining = store.state.settings.realTokenBudget - store.state.realUsage.tokens;
    const progress = `${decisionRequests}/${workRuns}/${sdk?.actions.at(-1)?.status ?? 'observing'}`;
    if (progress !== previousProgress) { console.log(JSON.stringify({ progress, reportedTokens: store.state.realUsage.reportedTokens, faultInjected })); previousProgress = progress; }
    if (steerInjected && store.state.sessions.find(row => row.id === session.id).items.some(item => item.source === 'initiative') && !context?.reviewPromise && !context?.coordinator.active.size && !foreground?.running.size) { stopReason = 'observed_communication_after_steering'; break; }
    if (decisionRequests >= 6 && !context?.reviewPromise && !context?.coordinator.active.size && !foreground?.running.size) { stopReason = 'decision_limit'; break; }
    if (sdk?.lastFailure?.phase === 'decision') { stopReason = 'decision_failed'; break; }
    if (remaining <= 0 || store.state.projects.find(row => row.id === project.id)?.initiativeRuntime?.status === 'budget_exhausted') { stopReason = 'token_budget'; break; }
    await delay(250);
  }
  stopReason ??= 'deadline';
} catch (error) { stopReason = deadline.aborted ? 'deadline' : 'execution_failed'; report.errorCode = /^[a-zA-Z0-9_.-]{1,80}$/.test(error.code ?? '') ? error.code : 'execution_failed'; }
finally {
  await controller?.close(); await foreground?.close(); removeListener();
  const finalProject = store.state.projects.find(row => row.id === project.id), actions = finalProject.initiativeRuntime?.sdkState?.actions ?? [], messages = store.state.sessions.find(row => row.id === session.id).items.filter(item => item.source === 'initiative');
  const receipts = actions.map(action => ({ actionId: action.id, action: action.action, status: action.status, code: action.failure?.code ?? null, resultChars: action.resultSummary?.length ?? 0, resultSha256: hash(action.resultSummary ?? ''), evidenceCount: action.evidenceIds?.length ?? 0 }));
  const successfulReads = report.tools.filter(row => row.type === 'tool_execution_end' && !row.isError), historyReads = successfulReads.filter(row => row.name === 'project_history');
  const findings = [...actions.map(action => action.resultSummary ?? ''), ...messages.map(message => message.text)].join('\n');
  try {
    const verified = execFileSync(process.execPath, ['--input-type=module', '-e', `import { exportRows } from './export.mjs';const rows=[{id:1,title:'A',privateNote:'x'},{id:2,title:'B'}]; console.log(JSON.stringify({zero:exportRows(rows,0),nil:exportRows(rows,null),missing:exportRows(rows,undefined),one:exportRows(rows,1)}));`], { cwd: workspace, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    const value = JSON.parse(verified); const want=[{id:1,title:'A'},{id:2,title:'B'}];
    report.artifactVerification={passed:JSON.stringify(value.zero)==='[]' && JSON.stringify(value.nil)===JSON.stringify(want) && JSON.stringify(value.missing)===JSON.stringify(want) && JSON.stringify(value.one)===JSON.stringify(want.slice(0,1)), result:value};
  } catch (error) { report.artifactVerification={passed:false,errorCode:error.code??'independent_check_failed'}; }
  report.artifacts = ['export.mjs','verification.json'].map(name => { try { const data=readFileSync(join(workspace,name));return {name,sha256:hash(data),bytes:data.length}; } catch{return {name,missing:true};} });
  report.actions = receipts; report.usage = { totalTokens: store.state.realUsage.tokens, reportedTokens: store.state.realUsage.reportedTokens, estimatedTokens: store.state.realUsage.estimatedTokens, reservedTokens: store.state.realUsage.reservedTokens };
  report.observations = { autonomousWorkSelected: report.decisions.some(row => row.action === 'work'), realWorkRequests: report.requests.filter(row => row.kind === 'work').length,
    successfulWorkspaceReads: successfulReads.filter(row => ['project_read', 'project_list'].includes(row.name)).length, controlledFaultInjected: faultInjected,
    postFaultDecision: report.decisions.some(row => row.afterInjectedFault), successfulHistoryReads: historyReads.length, completedWorkAfterFault: actions.some(action => action.action === 'work' && action.status === 'completed'),
    findingsMentionZeroBoundary: /(?:\b0\b|零)/.test(findings), proactiveMessages: messages.length, sourceChanged: readFileSync(join(workspace, 'export.mjs'), 'utf8') !== files['export.mjs'], userSteeringInjected: steerInjected, noGoal: store.state.goals.length === 0 };
  report.passed = report.observations.autonomousWorkSelected && report.observations.realWorkRequests > 0 && report.observations.successfulWorkspaceReads > 0 && faultInjected && report.observations.postFaultDecision && report.observations.successfulHistoryReads > 0 && report.observations.completedWorkAfterFault && report.artifactVerification.passed && report.artifacts.every(file => !file.missing) && steerInjected && report.userInterruption.signalAbortedSynchronously && messages.length > 0;
  report.stopReason = stopReason; report.status = report.passed ? 'observed_pass' : 'observation_incomplete'; report.finishedAt = new Date().toISOString();
  report.limitations = ['One controlled fixture and injected host fault; not a production user incident or a statistical quality claim.', 'No main-model retry beyond the bounded observation; legitimate wait/share/blocker responses are recorded even if the strong history-tool assertion is unmet.', 'Independent module execution checks four concrete export cases; it is not a statistical reliability claim. Complete model requests, responses, SDK tools and artifacts remain in the private trace for human review.'];
  privateTrace({ type: 'final-host-state', state: store.state });
  const trace = readFileSync(traceFile); report.privateTrace = { path: traceFile, sha256: hash(trace), bytes: trace.length };
  publish(); const publicBody = readFileSync(reportFile, 'utf8'); assert.ok(!publicBody.includes(apiKey), 'Credential must not occur in public metadata');
  console.log(JSON.stringify({ status: report.status, decisions: decisionRequests, workRuns, usage: report.usage, observations: report.observations, stopReason, report: reportFile }));
  if (!report.passed) process.exitCode = 1;
}
