#!/usr/bin/env node
// One bounded, explicitly authorized real-model observation in a private QA
// workspace. Source files and the one transport fault are controlled stimuli,
// not production user events. Memory is disabled, and no Goal is created.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../prototypes/control-center/store.mjs';
import { ProjectInitiativeController } from '../prototypes/control-center/project-initiative-controller.mjs';
import { createRnaRuntime } from '../prototypes/control-center/rna-runtime.mjs';
import { resolveModel } from '../prototypes/control-center/configuration.mjs';
import { streamCompletion } from '../packages/sdk/src/providers.mjs';

if (!process.argv.includes('--execute')) { console.log('Prepared only. --execute starts one isolated, paid real-model observation.'); process.exit(0); }
const reportArg = process.argv.indexOf('--report');
assert.ok(reportArg < 0 || process.argv[reportArg + 1] && !process.argv[reportArg + 1].startsWith('--'), '--report requires a path');
const reportFile = resolve(reportArg < 0 ? 'prototypes/control-center/qa/initiative-continuity-real-report.json' : process.argv[reportArg + 1]);
// Reserve a new evidence file before reading credentials or making requests.
// A repeated invocation must never replace a previous observation.
writeFileSync(reportFile, JSON.stringify({ status: 'preparing', startedAt: new Date().toISOString() }), { flag: 'wx' });
const stateFile = resolve('prototypes/control-center/.state/state.json');
const original = JSON.parse(readFileSync(stateFile, 'utf8')), secrets = JSON.parse(readFileSync(`${stateFile}.secrets`, 'utf8'));
const selection = original.projects.find(project => project.initiativeRuntime?.modelSelection)?.initiativeRuntime.modelSelection ?? original.configuration.defaultModel;
const selected = resolveModel(original.configuration, selection), configured = original.configuration.providers.find(provider => provider.id === selected.providerId);
const apiKey = configured.apiKeyEnv ? process.env[configured.apiKeyEnv] : secrets[configured.id];
assert.ok(apiKey && selected.execution === 'rna' && /deepseek/i.test(selected.modelId) && /^https:\/\/api\.deepseek\.com(?:\/|$)/.test(selected.baseUrl), 'A currently configured real DeepSeek model is required');
const runId = randomUUID(), privateDirectory = resolve('deploy/openviking/.runtime/semantic/qa', `initiative-${runId}`), workspace = join(privateDirectory, 'workspace');
mkdirSync(workspace, { recursive: true, mode: 0o700 });
const traceFile = join(privateDirectory, 'model-trace.jsonl');
const hash = text => createHash('sha256').update(text).digest('hex');
const files = {
  'export.mjs': 'export function normaliseLimit(value) { return value || 20; }\nexport function exportRows(rows, limit) { return rows.slice(0, normaliseLimit(limit)).map(({id,title}) => ({id,title})); }\n',
  'export-contract.md': '# 导出规范（隔离验收项目）\n\nlimit 是非负整数或 null/undefined。明确传入 0 时必须导出零行；缺省或 null 使用 20。只导出 id 与 title。当前实现及 cases.json 是待核对的源资料。本项目当前授权只读检查和项目内汇报，不改文件、不执行外部命令。\n',
  'cases.json': JSON.stringify({ rows: [{ id: 1, title: 'A', privateNote: 'excluded' }, { id: 2, title: 'B' }], limit: 0, expected: [] }, null, 2)
};
for (const [name, content] of Object.entries(files)) writeFileSync(join(workspace, name), content, { mode: 0o600 });
const { exportRows } = await import(pathToFileURL(join(workspace, 'export.mjs')).href), input = JSON.parse(files['cases.json']), actualRows = exportRows(input.rows, input.limit);
const store = new Store(join(privateDirectory, 'state.json'));
const provider = store.configurationService.provider(null, { name: 'Isolated real continuity acceptance', protocol: configured.protocol, baseUrl: configured.baseUrl, apiKey, models: [structuredClone(configured.models.find(model => model.id === selected.modelId))] });
store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: selected.modelId, reasoning: selected.reasoning }, memory: { autoStore: false, autoRecall: false } });
const { project, session } = store.createProject({ name: '导出边界复核工作台（独立验收）', description: '维护这个项目的导出质量。当前 export.mjs 和 export-contract.md 的边界行为尚待核对，项目内已有 cases.json。请依据真实文件自行进行只读检查，有确切发现时在项目内说明；已有结果应延续利用，避免重新摸索。没有外部发布任务。', workspace,
  initiative: { enabled: true, cooldownMs: 0, tokenBudget: 60000, reviewMinMs: 5000, reviewMaxMs: 15000 }, evolution: { enabled: false } });
store.mutate(state => { const target = state.projects.find(row => row.id === project.id); target.decisionMode = 'rna-model'; target.simulated = false; target.initialization = { status: 'ready' }; target.overview = '核对实际导出实现与已经明确的边界规范，报告可验证的差异和下一步。'; target.focus = '已有项目资料待检查，无需另建目标。'; target.permissions = { workspace: 'read', background: 'read', revision: 1, source: 'acceptance-fixture' }; target.assignments = { skillIds: [], toolIds: ['project_read', 'project_list'], mcpServerIds: [] }; target.evolution.enabled = false; state.settings.realTokenBudget = 60000; });

const report = { schemaVersion: 1, runId, startedAt: new Date().toISOString(), privateDirectory,
  evidenceType: 'controlled project-state and source fixture with one injected post-inspection handoff fault; real configured model decisions and real SDK work/tools; no production user events',
  model: { id: selected.modelId, reasoning: selected.reasoning, contextWindow: selected.contextWindow, maxOutputTokens: selected.maxOutputTokens },
  limits: { totalTokens: 60000, decisionRequests: 3, elapsedMs: 480000, maxStepsPerWork: 8 }, projectId: project.id, sessionId: session.id,
  memory: { autoStore: false, autoRecall: false, remoteRequests: 0 }, noGoal: store.state.goals.length === 0,
  fixture: { files: Object.entries(files).map(([name, content]) => ({ name, sha256: hash(content), bytes: Buffer.byteLength(content) })), independentCheck: { expectedRows: 0, actualRows: actualRows.length, actualSha256: hash(JSON.stringify(actualRows)) } },
  decisions: [], requests: [], tools: [], status: 'running', observations: {} };
const deadline = AbortSignal.timeout(report.limits.elapsedMs);
let controller, decisionRequests = 0, faultInjected = false, workRuns = 0, stopReason = null;
function privateTrace(row) { appendFileSync(traceFile, `${JSON.stringify(row)}\n`, { mode: 0o600 }); }
function publish() { report.updatedAt = new Date().toISOString(); writeFileSync(reportFile, JSON.stringify(report, null, 2)); }
function fault(code, message) { return Object.assign(new Error(message), { code, usage: { totalTokens: 0 } }); }
function realProvider(kind) {
  return async function* (request) {
    deadline.throwIfAborted();
    if (kind === 'decision' && decisionRequests >= 3) throw fault('qa_decision_limit', 'Explicit QA decision limit reached; no provider request was sent');
    if (kind === 'decision') {
      decisionRequests++;
      // The third admitted decision may still start legitimate background
      // work. Stop future review scheduling, not that already admitted work.
      if (decisionRequests === 3 && controller) { clearInterval(controller.timer); controller.schedule = () => {}; }
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
  controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 500, maxConcurrentReviews: 1, decisionTimeoutMs: 120000, actionTimeoutMs: 240000, workMaxSteps: 8,
    decisionProvider: realProvider('decision'), runtimeFactory: async options => {
      const run = ++workRuns, handle = await createRnaRuntime({ ...options, provider: realProvider('work'), onEvent: event => {
        privateTrace({ type: 'sdk-event', workRun: run, actionId: options.sessionId, event });
        if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') report.tools.push({ workRun: run, actionId: options.sessionId, type: event.type, name: event.toolName, toolCallId: event.toolCallId, isError: event.isError ?? event.result?.isError ?? false });
        options.onEvent?.(event);
      } });
      return new Proxy(handle, { get(target, property) {
        if (property !== 'prompt') { const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; }
        return async (...args) => {
          const result = await target.prompt(...args), snapshot = target.snapshot();
          const reads = report.tools.filter(row => row.workRun === run && row.type === 'tool_execution_end' && !row.isError && ['project_read', 'project_list'].includes(row.name));
          if (!faultInjected && reads.length > 0 && !snapshot.recovery?.uncertainTools?.length) {
            faultInjected = true;
            const answer = snapshot.messages.findLast(message => message.role === 'assistant'), text = (answer?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
            report.inspectionBeforeControlledFault = { outputChars: text.length, outputSha256: hash(text), mentionsZero: /\b0\b|零/.test(text), mentionsTwenty: /\b20\b|二十/.test(text), mentionsLogicalOr: text.includes('||'), mentionsNullishCoalescing: text.includes('??'), mentionsNormaliseLimit: text.includes('normaliseLimit'), readOnly: options.readOnly };
            privateTrace({ type: 'injected-handoff-fault', actionId: options.sessionId, workRun: run, actualInspectionSummary: text, readOnly: options.readOnly, state: snapshot });
            const failure = new Error(`Controlled QA handoff fault after read-only inspection; no workspace mutations were permitted. The work itself may have produced findings. Read project_history with actionId ${options.sessionId} before repeating it. Recorded model conclusion (not an independent verification): ${text.slice(0, 600)}`);
            failure.code = 'qa_handoff_interrupted'; throw failure;
          }
          return result;
        };
      } });
    } });
  publish(); let previousProgress = '';
  while (!deadline.aborted) {
    const context = controller.contexts.get(project.id), sdk = context?.coordinator.snapshot(), remaining = store.state.settings.realTokenBudget - store.state.realUsage.tokens;
    const progress = `${decisionRequests}/${workRuns}/${sdk?.actions.at(-1)?.status ?? 'observing'}`;
    if (progress !== previousProgress) { console.log(JSON.stringify({ progress, reportedTokens: store.state.realUsage.reportedTokens, faultInjected })); previousProgress = progress; }
    if (decisionRequests >= 3 && !context?.reviewPromise && !context?.coordinator.active.size) { stopReason = 'decision_limit'; break; }
    if (sdk?.lastFailure?.phase === 'decision') { stopReason = 'decision_failed'; break; }
    if (remaining <= 0 || store.state.projects.find(row => row.id === project.id)?.initiativeRuntime?.status === 'budget_exhausted') { stopReason = 'token_budget'; break; }
    await delay(250);
  }
  stopReason ??= 'deadline';
} catch (error) { stopReason = deadline.aborted ? 'deadline' : 'execution_failed'; report.errorCode = /^[a-zA-Z0-9_.-]{1,80}$/.test(error.code ?? '') ? error.code : 'execution_failed'; }
finally {
  await controller?.close(); removeListener();
  const finalProject = store.state.projects.find(row => row.id === project.id), actions = finalProject.initiativeRuntime?.sdkState?.actions ?? [], messages = store.state.sessions.find(row => row.id === session.id).items.filter(item => item.source === 'initiative');
  const receipts = actions.map(action => ({ actionId: action.id, action: action.action, status: action.status, code: action.failure?.code ?? null, resultChars: action.resultSummary?.length ?? 0, resultSha256: hash(action.resultSummary ?? ''), evidenceCount: action.evidenceIds?.length ?? 0 }));
  const successfulReads = report.tools.filter(row => row.type === 'tool_execution_end' && !row.isError), historyReads = successfulReads.filter(row => row.name === 'project_history');
  const findings = [...actions.map(action => action.resultSummary ?? ''), ...messages.map(message => message.text)].join('\n');
  report.actions = receipts; report.usage = { totalTokens: store.state.realUsage.tokens, reportedTokens: store.state.realUsage.reportedTokens, estimatedTokens: store.state.realUsage.estimatedTokens, reservedTokens: store.state.realUsage.reservedTokens };
  report.observations = { autonomousWorkSelected: report.decisions.some(row => row.action === 'work'), realWorkRequests: report.requests.filter(row => row.kind === 'work').length,
    successfulWorkspaceReads: successfulReads.filter(row => ['project_read', 'project_list'].includes(row.name)).length, controlledFaultInjected: faultInjected,
    postFaultDecision: report.decisions.some(row => row.afterInjectedFault), successfulHistoryReads: historyReads.length, completedWorkAfterFault: actions.some(action => action.action === 'work' && action.status === 'completed'),
    findingsMentionZeroBoundary: /(?:\b0\b|零)/.test(findings), proactiveMessages: messages.length, projectFilesUnchanged: Object.entries(files).every(([name, content]) => readFileSync(join(workspace, name), 'utf8') === content), noGoal: store.state.goals.length === 0 };
  report.passed = report.observations.autonomousWorkSelected && report.observations.realWorkRequests > 0 && report.observations.successfulWorkspaceReads > 0 && faultInjected && report.observations.postFaultDecision && report.observations.successfulHistoryReads > 0 && report.observations.completedWorkAfterFault && report.observations.findingsMentionZeroBoundary;
  report.stopReason = stopReason; report.status = report.passed ? 'observed_pass' : 'observation_incomplete'; report.finishedAt = new Date().toISOString();
  report.limitations = ['One controlled fixture and injected host fault; not a production user incident or a statistical quality claim.', 'No main-model retry beyond the bounded observation; legitimate wait/share/blocker responses are recorded even if the strong history-tool assertion is unmet.', 'A phrase match for the zero boundary is a limited metadata check, not an independent semantic judge. Complete model requests, responses, SDK tools and artifacts remain in the private trace for human review.'];
  privateTrace({ type: 'final-host-state', state: store.state });
  const trace = readFileSync(traceFile); report.privateTrace = { path: traceFile, sha256: hash(trace), bytes: trace.length };
  publish(); const publicBody = readFileSync(reportFile, 'utf8'); assert.ok(!publicBody.includes(apiKey), 'Credential must not occur in public metadata');
  console.log(JSON.stringify({ status: report.status, decisions: decisionRequests, workRuns, usage: report.usage, observations: report.observations, stopReason, report: reportFile }));
  if (!report.passed) process.exitCode = 1;
}
