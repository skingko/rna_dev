import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { deadlineText, actionDeadlineMs } from '../work-run-text.mjs';
import { oneLine } from '../../../packages/sdk/src/proactive-message.mjs';

// W1-c (token-burn study 2026-10-05): a run the 30-minute action deadline stopped was recorded as "the project context
// changed or a stop instruction arrived", and the next decision read that as the reason. Now the handoff and the output
// say the limit (the minutes come from the deadline in force), and the job's status and error code stay as they were.
const until = async (check, label) => { const end = Date.now() + 20000; while (Date.now() < end) { if (check()) return; await delay(5); } throw Error(`Fixture did not settle: ${label}`); };
const TASK = '核对第二章的时间线并更新进度登记。';

// A runtime handle whose request never ends until the host aborts it (the run stays "running" until the deadline), with a
// tool call left unfinished when `unfinished` says so. Only what work() calls.
function handleOf({ unfinished = false, signal, hidesReason = false } = {}) {
  let stop; const hung = new Promise((_, reject) => { stop = reject; });
  // The runtime rejects with the signal's reason, as the real one does; `hidesReason`: with an error of its own that has no code.
  return {
    snapshot: () => ({ messages: [], tools: [], queue: { steering: [] }, continuation: null, sessionFile: null, ...(unfinished ? { recovery: { uncertainTools: [{ id: 'call-1', name: 'project_exec' }] } } : {}) }),
    prompt: () => hung, resume: () => hung, abort: async () => stop(!hidesReason && signal?.reason ? signal.reason : Object.assign(new Error('The request was aborted'), { name: 'AbortError' })), dispose: async () => {}, cancelUnstartedTools: () => {},
  };
}

async function fixture(t, { unfinished = false, hidesReason = false, language, actionTimeoutMs = 1800000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-work-deadline-')), store = new Store(join(dir, 'state.json'));
  const model = store.configurationService.provider(null, { name: 'Deadline fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: model.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoStore: false, autoRecall: false } });
  if (language) store.mutate(state => { state.settings.interfaceLanguage = language; });
  const { project } = store.createProject({ rhythm: { control: 'manual' }, name: 'Deadline fixture', workspace: dir, description: 'Keep the progress register current.' });
  store.mutate(state => { const row = state.projects.find(p => p.id === project.id); Object.assign(row, { initialization: { status: 'ready' }, simulated: false, decisionMode: 'rna-model', permissions: { workspace: 'read', background: 'read', revision: 1 }, assignments: { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] } }); row.initiative.tokenBudget = null; });
  let decisions = 0; const inputs = [];
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, actionTimeoutMs, decisionProvider: async function* (request) {
    const input = JSON.parse(request.messages[0].content[0].text); inputs.push(input); const output = decisions++ ? { action: 'wait', reason: 'Nothing else to do', evidenceIds: [], content: '', nextReviewAfterMs: 86400000 } : { action: 'work', reason: 'A concrete project evidence review', evidenceIds: [input.allowedEvidenceIds[0]], content: TASK, nextReviewAfterMs: 86400000 };
    yield { type: 'text_delta', delta: JSON.stringify(output) }; yield { type: 'usage', usage: { totalTokens: 11 } }; yield { type: 'done', stopReason: 'stop' };
  }, runtimeFactory: options => handleOf({ unfinished, hidesReason, signal: options.signal }) });
  t.after(async () => { await controller.close(); rmSync(dir, { recursive: true, force: true }); });
  const current = () => store.state.projects.find(row => row.id === project.id);
  return { store, controller, project, current, inputs, context: () => controller.contexts.get(project.id), job: () => current().jobs[0], action: () => current().initiativeRuntime?.sdkState?.actions?.find(row => row.action === 'work') };
}
const settled = f => until(() => f.job() && !['running', 'queued'].includes(f.job().status) && f.job().completedAt, 'the job to end');
const FALSE_REASON = /项目上下文变化或收到停止指令|收到新的项目上下文或暂停指令/;

test('deadlineText: the minutes come from the deadline in force, never from a constant', () => {
  const minutes = ms => deadlineText({ task: 't', deadlineMs: ms, language: 'en', code: 'action_timeout' }).handoff.match(/Stopped at the (\S+) limit/)[1];
  assert.equal(minutes(1800000), '30-minute');
  assert.equal(minutes(600000), '10-minute');
  assert.equal(minutes(86400000), '1440-minute');
  assert.equal(minutes(90000), '90-second', 'not rounded: the unit that says it exactly');
  assert.equal(minutes(45000), '45-second');
  assert.equal(minutes(300), '300-millisecond');
  // What the SDK does with a setting it cannot use is what the text says: its own reading of it.
  assert.equal(actionDeadlineMs(undefined), 1800000); assert.equal(actionDeadlineMs(1.5), 1800000); assert.equal(actionDeadlineMs('900000'), 1800000);
  assert.equal(actionDeadlineMs(1), 10); assert.equal(actionDeadlineMs(10 ** 9), 86400000); assert.equal(actionDeadlineMs(900000), 900000);
  assert.equal(minutes(undefined), '30-minute');
});

test('deadlineText: the handoff says what stopped it, what stays and what to do next, in the interface language; the output agrees', () => {
  const task = oneLine(TASK, 120);
  const zh = deadlineText({ task, deadlineMs: 1800000, language: 'zh', code: 'action_timeout' }), en = deadlineText({ task, deadlineMs: 1800000, language: 'en', code: 'action_timeout' });
  assert.equal(zh.handoff, `已到 30 分钟时限被停止：${TASK}；时限前完成的操作保留，不会自动重跑；下一步把剩余部分拆小再做。`);
  assert.equal(zh.output, '这项后台工作到 30 分钟时限被停止；时限前完成的操作和结果保留，不会自动重跑。');
  assert.equal(en.handoff, `Stopped at the 30-minute limit: ${TASK}; what was done before the limit stays and is not rerun; next, split the remainder into smaller steps.`);
  assert.equal(en.output, 'This background work was stopped at the 30-minute limit; what it completed before then is kept and is not rerun.');
  for (const row of [zh, en]) assert.doesNotMatch(row.handoff + row.output, FALSE_REASON);
  // With a tool call left unfinished, the limit comes before the "unconfirmed" sentence; the error code is the caller's.
  const unsure = deadlineText({ task, deadlineMs: 1800000, language: 'zh', code: 'uncertain_tool', toolUnfinished: true }), unsureEn = deadlineText({ task, deadlineMs: 1800000, language: 'en', code: 'uncertain_tool', toolUnfinished: true });
  // This handoff is only for the next decision (the web hides it), so it is the same fixed English in both languages.
  assert.equal(unsure.handoff, unsureEn.handoff);
  assert.ok(unsure.handoff.startsWith('Result to verify (uncertain_tool): ') && unsure.handoff.indexOf('stopped at the 30-minute limit with a tool call unfinished') < unsure.handoff.indexOf('an external operation\'s outcome is unconfirmed: next, check its side effects and confirm explicitly, do not replay it.'));
  assert.match(unsureEn.handoff, /^Result to verify \(uncertain_tool\): .*; stopped at the 30-minute limit with a tool call unfinished; an external operation's outcome is unconfirmed: next, check its side effects and confirm explicitly, do not replay it\.$/);
  assert.match(unsure.output, /^已到 30 分钟时限被停止，到时限时有工具调用尚未结束；后台检查存在未决外部执行（uncertain_tool）：需核对副作用后明确确认；不会在新会话中重放。$/);
  // A handoff is one line of at most 400 characters (oneLine), the task name included at its 120.
  for (const language of ['zh', 'en']) for (const toolUnfinished of [false, true]) assert.ok(deadlineText({ task: oneLine('任'.repeat(300), 120), deadlineMs: 1800000, language, code: 'uncertain_tool', toolUnfinished }).handoff.length <= 400, `${language} ${toolUnfinished}`);
});

// The deadline's own error, delivered by the run's abort once its runtime exists (the SDK coordinator aborts the same way
// when its timer fires: the scenario scheduled-timeout-handoff holds that timer; here the moment is exact, never raced).
async function stopAtDeadline(f) {
  await until(() => f.context()?.workRuns?.size === 1 && [...f.context().workRuns.values()][0].handle, 'the run to be under way');
  const [run] = [...f.context().workRuns.values()];
  run.abort(Object.assign(new Error('Host action deadline exceeded'), { code: 'action_timeout' }));
}

test('a run the deadline stopped says so in its handoff and output; its status and error code are what they were', async t => {
  const f = await fixture(t);
  await stopAtDeadline(f); await settled(f);
  const job = f.job();
  assert.equal(job.status, 'cancelled'); assert.equal(job.errorCode, 'action_timeout'); assert.equal(job.failure.code, 'action_timeout');
  assert.equal(job.handoff, `已到 30 分钟时限被停止：${TASK}；时限前完成的操作保留，不会自动重跑；下一步把剩余部分拆小再做。`);
  assert.equal(job.output, '这项后台工作到 30 分钟时限被停止；时限前完成的操作和结果保留，不会自动重跑。');
  assert.doesNotMatch(job.handoff + job.output, FALSE_REASON);
});

test('the signal\'s own reason decides, also when the runtime\'s abort error hides the code: status and error code stay what the runtime reported', async t => {
  const f = await fixture(t, { hidesReason: true });
  await stopAtDeadline(f); await settled(f);
  assert.equal(f.job().status, 'cancelled'); assert.equal(f.job().errorCode, 'initiative_error', 'unchanged: it is the error the host was given');
  assert.match(f.job().handoff, /^已到 30 分钟时限被停止：/);
  assert.doesNotMatch(f.job().handoff + f.job().output, FALSE_REASON);
});

test('the limit is worded in the interface language the user chose', async t => {
  const f = await fixture(t, { language: 'en' });
  await stopAtDeadline(f); await settled(f);
  assert.equal(f.job().handoff, `Stopped at the 30-minute limit: ${TASK}; what was done before the limit stays and is not rerun; next, split the remainder into smaller steps.`);
  assert.equal(f.job().output, 'This background work was stopped at the 30-minute limit; what it completed before then is kept and is not rerun.');
  assert.equal(f.job().errorCode, 'action_timeout');
});

test('a tool call left unfinished at the deadline: the limit is named before the unconfirmed outcome, and the run still needs review under uncertain_tool', async t => {
  const f = await fixture(t, { unfinished: true });
  await stopAtDeadline(f); await settled(f);
  const job = f.job();
  assert.equal(job.status, 'needs_review'); assert.equal(job.errorCode, 'uncertain_tool');
  assert.equal(job.handoff, `Result to verify (uncertain_tool): ${TASK}; stopped at the 30-minute limit with a tool call unfinished; an external operation's outcome is unconfirmed: next, check its side effects and confirm explicitly, do not replay it.`, 'model-only: fixed English whatever the interface language');
  assert.equal(job.output, '已到 30 分钟时限被停止，到时限时有工具调用尚未结束；后台检查存在未决外部执行（uncertain_tool）：需核对副作用后明确确认；不会在新会话中重放。');
});

test('a stop that is not the deadline keeps its own wording: the context changed or the user stopped it', async t => {
  const f = await fixture(t);
  await until(() => f.context()?.workRuns?.size === 1 && f.job(), 'the run to start');
  const [[id, run]] = [...f.context().workRuns];
  run.abort(Object.assign(new Error('Foreground work has priority'), { code: 'foreground_started' }));
  await settled(f);
  assert.equal(f.job().status, 'cancelled'); assert.equal(f.job().id, id);
  assert.match(f.job().handoff, /^Interrupted: .*; the project context changed or a stop instruction arrived; the reads already done stay in the execution record\.$/);
  assert.equal(f.job().output, '收到新的项目上下文或暂停指令，后台检查已中断。');
  assert.doesNotMatch(f.job().handoff + f.job().output, /时限/);
});

test('the corrected handoff rides on the error the worker rethrows, so the action row and the next decision carry it; the minutes are the deadline in force', async t => {
  const f = await fixture(t, { actionTimeoutMs: 600000 });
  await stopAtDeadline(f); await settled(f);
  await until(() => f.action()?.handoff && f.inputs.length >= 2, 'the action row and the decision after it');
  assert.equal(f.job().handoff, `已到 10 分钟时限被停止：${TASK}；时限前完成的操作保留，不会自动重跑；下一步把剩余部分拆小再做。`, 'the minutes are the deadline in force (600,000 ms here), not a constant');
  assert.equal(f.action().handoff, f.job().handoff, 'the action row carries it');
  assert.equal(f.action().errorCode, 'action_timeout');
  assert.ok(JSON.stringify(f.inputs.at(-1)).includes('已到 10 分钟时限被停止'), 'and the decision after the run reads it');
  assert.doesNotMatch(JSON.stringify(f.inputs.at(-1)), FALSE_REASON);
});
