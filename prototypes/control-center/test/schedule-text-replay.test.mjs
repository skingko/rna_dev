import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile, chmod } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { createServer } from '../server.mjs';
import { UsageLedger } from '../usage-cache-service.mjs';
import { resolveModel } from '../configuration.mjs';
import { EffortCapture } from '../internal-reasoning.mjs';
import { createSession } from '../../../packages/sdk/src/session.mjs';
import { ScheduleTextReplay, SCHEDULE_REPLAY_BUDGET_TOKENS, MAX_RUN_BUDGET, PLAN_SHARE, REPLAY_DEFAULTS, conditionsOf, SCOPE_TOUCHED_ALLOWANCE, sentencesOf, sentenceDiff, classifyCalls, classifyDecision, withScheduleTexts, withPlannerTexts, scheduleTextVersions, textBefore, summarizeReplay, replayMarkdown, selectCases, scanRequestsOf, purgeScheduleReplayReports, pruneScheduleReplayReports, scheduleReplayRoot } from '../benchmark/schedule-text-replay.mjs';
import { SCHEDULE_HISTORY, REQUIRED } from '../benchmark/schedule-text-cases.mjs';
import { SCHEDULE_TEXT_V1, SCHEDULE_TEXT_V2, scheduleToolParameters, scheduleContractText, schedulePolicyReason } from '../schedule-prompt.mjs';
import { runScheduleTextCommand } from '../cli-schedule-text.mjs';
import { initialMaintenance, persistMaintenance } from '../application-maintenance-state.mjs';

// W2 paired replay (design2 §7 W2): the recorded foreground turns and the constructed planner scenario, each under both text
// versions, within the approved token cap, never touching a conversation or a schedule. Every model call here is a fake
// provider: no network, no key. The conversation journal is written by the SDK itself and rebuilt by the replay.
const SCHEDULE = 'schedule-fixture';
const T8 = 'Collect first-hand sources. Write the daily report. Keep the sources section first.';
const T10 = `${T8} Deliver daily.md directly.`, T16 = `${T10} Before delivery run the guard.`, T17 = `${T16} Report only the most severe GitHub level.`;
const PREFIX = { systemPrompt: `You are the replay fixture agent.\n\n${SCHEDULE_TEXT_V1.foreground}\n\nWrite the report the user asks for.`, cacheScope: 'project:fixture', tools: [
  { name: 'project_schedule_list', description: 'List the project schedules.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'project_schedule', description: SCHEDULE_TEXT_V1.toolDescription, parameters: scheduleToolParameters('v1') },
  { name: 'project_plan', description: 'Keep the plan.', parameters: { type: 'object', properties: { item: { type: 'string' } }, additionalProperties: false } }] };
const TURNS = [
  { ref: '5fdb5b38', rev: 10, user: 'From now on deliver daily.md directly.', before: T8, after: T10, durable: 'durable' },
  { ref: '8604d1b9', rev: 16, user: 'Fix the 2 problems found in the existing files.', before: T10, after: T16, durable: 'one_off' },
  { ref: '463458ab', rev: 17, user: 'From now on only the most severe GitHub level.', before: T16, after: T17, durable: 'durable' }];
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const tokensOf = request => Math.ceil(Buffer.byteLength(JSON.stringify({ s: request.systemPrompt, t: request.tools, m: request.messages })) / 3);

/** The conversation, written by the SDK: three turns, each a first request that calls project_schedule (executed by a stub). */
async function conversation(store, session, model) {
  let revision = 8;
  const tools = PREFIX.tools.map(tool => ({ ...tool, effect: tool.name === 'project_schedule' ? 'write' : 'read', idempotent: tool.name !== 'project_schedule', execute: async (_id, args) => tool.name === 'project_schedule' ? { content: [{ type: 'text', text: JSON.stringify({ id: SCHEDULE, revision: ++revision === 9 ? (revision = TURNS[0].rev) : revision, task: args.task }) }] } : { content: [{ type: 'text', text: '{}' }] } }));
  const provider = async function* (request) {
    const last = request.messages.at(-1), text = JSON.stringify(last);
    if (last?.role === 'user') { const turn = TURNS.find(row => text.includes(row.user)); yield { type: 'tool_call', id: `call_${turn.ref}`, name: 'project_schedule', arguments: { action: 'update', id: SCHEDULE, task: turn.after } }; yield { type: 'usage', usage: { input: tokensOf(request), output: 60, cacheRead: 0, cacheWrite: 0, totalTokens: tokensOf(request) + 60 } }; yield { type: 'done', stopReason: 'toolUse' }; return; }
    yield { type: 'text_delta', delta: 'Done.' }; yield { type: 'usage', usage: { input: tokensOf(request), output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: tokensOf(request) + 5 } }; yield { type: 'done', stopReason: 'stop' };
  };
  const live = await createSession({ sessionId: session.id, projectId: session.projectId, cwd: store.dir, stateDir: join(`${store.file}.rna`, session.id), model, tools, provider, systemPrompt: PREFIX.systemPrompt, cacheScope: PREFIX.cacheScope });
  for (const turn of TURNS) await live.prompt(`${turn.user}\n\nPlease keep the sources section first when you write it down, and continue ${'with the report '.repeat(30)}.`);
  const file = live.snapshot().sessionFile; await live.dispose();
  store.mutate(state => { state.sessions.find(row => row.id === session.id).runtime = { engine: 'rna', sessionFile: file }; });
  return file;
}
const intentsOf = file => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.type === 'tool_intent' && row.data.toolName === 'project_schedule').map(row => ({ callKey: row.data.callKey, toolCallId: row.data.toolCallId, arguments: row.data.arguments }));

const plannerBase = (project, session) => ({ project: { id: project.id, title: 'Replay fixture', actionContracts: { schedule: { schemaVersion: 1, enabled: true, authorization: SCHEDULE_TEXT_V1.authorization, scope: SCHEDULE_TEXT_V1.scope, effects: 'Save a versioned task.', destinationSessionIds: [session.id] } },
  scheduleContext: { cancelled: [], destinations: [{ sessionId: session.id }], defaults: { time: '09:00', timeZone: 'Asia/Shanghai' }, policy: { initiativeMayManage: true, reason: SCHEDULE_TEXT_V1.policyReason, maxSchedules: 32, externalDelivery: false } },
  schedules: [{ schemaVersion: 1, id: SCHEDULE, title: 'Daily', task: 'CURRENT TASK TEXT', rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, destinationSessionId: session.id, enabled: true, revision: 17, source: 'user', lastEditedBy: 'user' }] },
  events: [{ id: 'project-state', type: 'project_state', summary: 'The project writes a daily report.', at: Date.now() - 60000 }], availableActions: ['schedule', 'wait'], promptActions: ['schedule', 'wait'], recentActions: [], previousDecision: null, presence: {}, policy: { decisionMaxTokens: 3000 } });
const MESSAGES = { 'c6cccf38': { id: '66d933a5-1111', text: 'The report is too wordy, make the task prompt concise.' }, 'cfe77d8a': { id: 'd89af5ea-2222', text: 'Decide after tomorrow\'s run.' }, 'da136e72': { id: '14856463-3333', text: 'Go with reality and update the README.' } };

async function fixture(t, { provider = replayProvider(), held = () => false, now = Date.now, prefix = PREFIX, planner = true, usable = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-schedule-replay-')), store = new Store(join(dir, 'state.json'));
  store.dir = dir;
  t.after(() => rm(dir, { recursive: true, force: true }));
  const glm = store.configurationService.provider(null, { name: 'GLM-like', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-only-not-a-key', models: [{ id: 'glm-fixture', contextWindow: 200000, maxOutputTokens: 4000, reasoning: ['low', 'high', 'max'] }] });
  store.configurationService.update({ defaultModel: { providerId: glm.id, modelId: 'glm-fixture', reasoning: 'high' } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Replay fixture', description: 'A daily report project', workspace: dir });
  const model = resolveModel(store.state.configuration, { providerId: glm.id, modelId: 'glm-fixture', reasoning: 'high' });
  const journal = await conversation(store, session, model), intents = intentsOf(journal);
  assert.equal(intents.length, 3);
  const user = (id, text, extra = {}) => ({ id, turnId: `turn-${id}`, kind: 'user', text, createdAt: '2026-10-01T00:00:00.000Z', ...extra });
  store.mutate(state => {
    const row = state.projects.find(p => p.id === project.id), s = state.sessions.find(item => item.id === session.id);
    s.items = [...Object.values(MESSAGES).map(message => user(message.id, message.text)),
      ...TURNS.flatMap((turn, index) => [user(`user-${turn.ref}`, turn.user, { turnId: `${turn.ref}-0000-4000-8000-000000000000`, capture: { durable: turn.durable } }),
        { id: `tool-${turn.ref}`, turnId: `${turn.ref}-0000-4000-8000-000000000000`, kind: 'tool', createdAt: `2026-10-0${index + 1}T00:00:00.000Z`, tool: { id: intents[index].toolCallId, callKey: intents[index].callKey, name: 'project_schedule', args: intents[index].arguments, status: 'succeeded', output: JSON.stringify({ id: SCHEDULE, revision: turn.rev, task: turn.after }) } }])];
    row.scheduleManagementReceipts = [{ actionId: 'da136e72-aaaa', operation: 'update', scheduleId: SCHEDULE, revision: 2, committedAt: '2026-09-26T09:07:29.000Z' }, { actionId: 'cfe77d8a-bbbb', operation: 'update', scheduleId: SCHEDULE, revision: 3, committedAt: '2026-09-26T09:21:03.000Z' }, { actionId: 'c6cccf38-cccc', operation: 'update', scheduleId: SCHEDULE, revision: 8, committedAt: '2026-09-27T09:21:19.000Z' }];
    row.initiativeRuntime = { ...(row.initiativeRuntime ?? {}), sdkState: { ...(row.initiativeRuntime?.sdkState ?? {}), actions: [
      { id: 'da136e72-aaaa', action: 'schedule', schedule: { operation: 'update', id: SCHEDULE, expectedRevision: 1, task: 'Collect sources. Index them.' } },
      { id: 'cfe77d8a-bbbb', action: 'schedule', schedule: { operation: 'update', id: SCHEDULE, expectedRevision: 2, task: 'Collect sources. Index them. Re-ask about the browser after the 09-27 run.' } },
      { id: 'c6cccf38-cccc', action: 'schedule', schedule: { operation: 'update', id: SCHEDULE, expectedRevision: 7, task: T8 } }] } };
  });
  const capture = new EffortCapture({ stateFile: store.file });
  if (planner) { const id = capture.record(project.id, 'decision', { sessionIds: [], providerId: glm.id, modelId: 'glm-fixture', sent: 'high', request: plannerBase(project, session), at: new Date(Date.now() - 60000).toISOString() }); capture.outcome(project.id, 'decision', id, { status: 'decided', action: 'wait', usage: { totalTokens: 4000 } }); }
  const ledger = new UsageLedger({ file: join(dir, 'state.json.usage-cache.jsonl') });
  const replay = new ScheduleTextReplay(store, { decisions: { secrets: () => [] }, ledger, provider: provider.provider, held, now, prefixFor: projectId => projectId === project.id && prefix ? structuredClone(prefix) : null });
  return { dir, store, replay, provider, ledger, journal, project, session, glm, capture };
}
const settled = async replay => { while (replay.running) await new Promise(done => setTimeout(done, 5)); return replay.status().job; };
const projectState = state => JSON.stringify({ ...state, revision: null, realUsage: null });

/** The fake model. Foreground: reads which turn the last user message belongs to. Planner: reads the user message among the events. A durable request
 * is written under both versions (v2 quoting the user's words in `basis`, touching one sentence; v1 rewriting more); the one-off is written under v1 only. */
function replayProvider({ onRequest = null, hold = null, usage = null, leak = null } = {}) {
  const seen = [];
  const provider = async function* (input) {
    seen.push(structuredClone({ systemPrompt: input.systemPrompt, tools: input.tools, messages: input.messages, cache: input.cache, model: input.model, estimatedInputTokens: input.estimatedInputTokens }));
    await onRequest?.(input, seen.length);
    if (hold) await new Promise((resolve, reject) => { input.signal.addEventListener('abort', () => reject(input.signal.reason ?? new Error('aborted')), { once: true }); hold(); });
    const v2 = input.systemPrompt.includes(SCHEDULE_TEXT_V2.foreground) || input.systemPrompt.includes('standing instruction that every future run receives');
    const reported = usage ?? { input: 1000, output: 100, cacheRead: 500, cacheWrite: 0, totalTokens: 1600 };
    if (input.tools.length) {
      const text = JSON.stringify(input.messages.at(-1)), turn = TURNS.find(row => text.includes(row.user));
      if (turn.durable === 'one_off' && v2) { yield { type: 'text_delta', delta: 'I will fix those files now and leave the schedule alone.' }; yield { type: 'tool_call', id: 'p1', name: 'project_plan', arguments: { item: 'fix the 2 problems' } }; }
      else yield { type: 'tool_call', id: 'u1', name: 'project_schedule', arguments: { action: 'update', id: SCHEDULE, task: `${turn.durable === 'durable' && !v2 ? `Rewritten. ${turn.after.replace('Write the daily report.', 'Write it.')}` : turn.after}${leak ? ` ${leak}` : ''}`, ...(v2 ? { basis: `${turn.user}${leak ? ` ${leak}` : ''}` } : {}) } };
      yield { type: 'usage', usage: reported }; yield { type: 'done', stopReason: 'toolUse' }; return;
    }
    // Planner: the request text is JSON; the user message is one of the events.
    const body = JSON.parse(input.messages[0].content[0].text), event = body.events.find(row => row.type === 'user_message');
    const quoted = Object.values(MESSAGES).find(message => event?.summary === message.text);
    let decision = { action: 'wait', reason: 'Nothing to change.', evidenceIds: [], content: '', nextReviewAfterMs: 1000 };
    const writes = quoted && (quoted.text.includes('concise') || !v2);
    if (writes) decision = { action: 'schedule', reason: 'The user asked for a change.', evidenceIds: [event.id], content: 'Update the task.', nextReviewAfterMs: 1000, schedule: { operation: 'update', id: SCHEDULE, expectedRevision: 17, task: `${body.project.schedules[0].task} ${quoted.text}${leak ? ` ${leak}` : ''}`, ...(v2 ? { basis: `${quoted.text}${leak ? ` ${leak}` : ''}` } : {}) } };
    yield { type: 'text_delta', delta: JSON.stringify(decision) }; yield { type: 'usage', usage: reported }; yield { type: 'done', stopReason: 'stop' };
  };
  return { provider, seen };
}

// ------------------------------------------------------------------------------------------------ pure pieces
test('sentences and the sentence diff: what a proposed text keeps, removes (or rewrites) and adds', () => {
  assert.deepEqual(sentencesOf('Collect sources. Write the report；Keep it short!\nNew line 。 End'), ['Collect sources.', 'Write the report；', 'Keep it short!', 'New line 。', 'End']);
  assert.deepEqual(sentencesOf('收集来源。写日报；来源章节在前。'), ['收集来源。', '写日报；', '来源章节在前。']);
  assert.deepEqual(sentenceDiff(T8, T10), { previous: 3, proposed: 4, kept: 3, removed: 0, added: 1 });
  assert.deepEqual(sentenceDiff(T8, `Rewritten. ${T8.replace('Write the daily report.', 'Write it.')}`), { previous: 3, proposed: 4, kept: 2, removed: 1, added: 2 });
  assert.deepEqual(sentenceDiff(T8, 'Something else entirely.'), { previous: 3, proposed: 1, kept: 0, removed: 3, added: 1 });
  assert.deepEqual(sentenceDiff(null, 'A. B.'), { previous: null, proposed: 2, kept: null, removed: null, added: null }, 'an unknown earlier text keeps and removes nothing: it is not "nothing removed"');
  assert.deepEqual(sentenceDiff(undefined, 'A.'), { previous: null, proposed: 1, kept: null, removed: null, added: null });
  assert.deepEqual(sentenceDiff('', 'A. B.'), { previous: 0, proposed: 2, kept: 0, removed: 0, added: 2 }, 'a known empty text is known');
  assert.deepEqual(sentenceDiff('A. A. B.', 'A. B.'), { previous: 3, proposed: 2, kept: 2, removed: 1, added: 0 }, 'a multiset: a repeated sentence counts once per copy');
});

test('reading a reply: a changed task in a project_schedule update, or in a schedule action, is a write; anything else is not', () => {
  const call = (name, args) => ({ name, arguments: args });
  const write = classifyCalls([call('project_schedule', { action: 'update', id: 'x', task: T10, basis: 'words' })], { previousTask: T8 });
  assert.deepEqual([write.write, write.task, write.basis, write.scheduleCalls], [true, T10, 'words', 1]);
  assert.equal(classifyCalls([call('project_schedule', { action: 'update', id: 'x', task: `  ${T8}\n` })], { previousTask: T8 }).write, false, 'the same text (whitespace aside) is no change');
  assert.equal(classifyCalls([call('project_schedule', { action: 'update', id: 'x', enabled: false })], { previousTask: T8 }).write, false);
  assert.equal(classifyCalls([call('project_schedule', { action: 'create', title: 't', task: 'once', rule: {} })], { previousTask: T8 }).creates, 1);
  assert.equal(classifyCalls([call('project_schedule', { action: 'create', title: 't', task: 'once', rule: {} })], { previousTask: T8 }).write, false, 'a separate once-task is not a write of the standing text');
  assert.deepEqual(classifyCalls([call('project_plan', { item: 'x' }), call('project_edit', {})], { previousTask: T8 }).toolNames, ['project_plan', 'project_edit']);
  assert.equal(classifyCalls([call('project_schedule', { action: 'update', id: 'x', task: 'any' })]).write, true, 'with no earlier text any task is a change');
  const decision = (schedule, action = 'schedule') => ({ action, schedule });
  assert.deepEqual(classifyDecision({ ...decision({ operation: 'update', id: 'x', task: T10, basis: 'b' }), evidenceIds: ['message:m1'] }, { previousTask: T8 }), { action: 'schedule', evidenceIds: ['message:m1'], scheduleOperation: 'update', write: true, task: T10, basis: 'b', creates: 0 });
  assert.equal(classifyDecision(decision({ operation: 'update', id: 'x', enabled: false }), { previousTask: T8 }).write, false);
  assert.equal(classifyDecision(decision({ operation: 'create', purposeKey: 'k', task: 'x' }), { previousTask: T8 }).creates, 1);
  assert.equal(classifyDecision({ action: 'wait' }, { previousTask: T8 }).write, false);
});

test('withScheduleTexts swaps exactly the paragraph and the declaration, both ways, and refuses a prompt it does not know', () => {
  const request = { systemPrompt: PREFIX.systemPrompt, tools: structuredClone(PREFIX.tools), messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], estimatedInputTokens: 1000, cache: { sessionKey: 'k' } };
  const v2 = withScheduleTexts(request, 'v2'), v1 = withScheduleTexts(request, 'v1'), back = withScheduleTexts(v2, 'v1');
  assert.deepEqual(v1, request, 'v1 on a v1 prefix is the prefix itself');
  assert.equal(v2.systemPrompt, request.systemPrompt.replace(SCHEDULE_TEXT_V1.foreground, SCHEDULE_TEXT_V2.foreground));
  assert.deepEqual(back.systemPrompt, request.systemPrompt); assert.deepEqual(back.tools, request.tools.map(tool => tool.name === 'project_schedule' ? { ...tool, parameters: JSON.parse(JSON.stringify(tool.parameters)) } : tool));
  const tool = v2.tools.find(row => row.name === 'project_schedule');
  assert.equal(tool.description, SCHEDULE_TEXT_V2.toolDescription); assert.ok('basis' in tool.parameters.properties && 'expectedRevision' in tool.parameters.properties, 'canonical key order, as the session projects every declaration');
  assert.deepEqual(v2.tools.filter(row => row.name !== 'project_schedule'), request.tools.filter(row => row.name !== 'project_schedule'));
  assert.deepEqual(v2.messages, request.messages); assert.deepEqual(v2.cache, request.cache);
  assert.notEqual(v2.estimatedInputTokens, request.estimatedInputTokens); assert.ok(v2.estimatedInputTokens > 0);
  assert.equal(withScheduleTexts({ ...request, tools: request.tools.filter(row => row.name !== 'project_schedule') }, 'v2').tools.at(-1).name, 'project_schedule', 'a prefix without the tool gets its declaration');
  assert.throws(() => withScheduleTexts({ ...request, systemPrompt: 'No schedule paragraph.' }, 'v2'), { code: 'schedule_paragraph_missing' });
  assert.throws(() => withScheduleTexts({ ...request, systemPrompt: `${request.systemPrompt}\n${SCHEDULE_TEXT_V1.foreground}` }, 'v2'), { code: 'schedule_paragraph_missing' }, 'twice is not exactly once');
  assert.equal(request.systemPrompt, PREFIX.systemPrompt, 'the input is not changed');
});

test('withPlannerTexts swaps the contract and the policy reason of a captured planner request', () => {
  const request = plannerBase({ id: 'p' }, { id: 's' });
  const v2 = withPlannerTexts(request, 'v2');
  assert.deepEqual([v2.project.actionContracts.schedule.authorization, v2.project.actionContracts.schedule.scope], [scheduleContractText('v2').authorization, scheduleContractText('v2').scope]);
  assert.equal(v2.project.scheduleContext.policy.reason, schedulePolicyReason('v2'));
  assert.deepEqual(withPlannerTexts(v2, 'v1').project, request.project);
  assert.equal(request.project.scheduleContext.policy.reason, SCHEDULE_TEXT_V1.policyReason, 'the input is not changed');
  assert.deepEqual(withPlannerTexts({ project: { id: 'old' }, events: [] }, 'v2').project, { id: 'old' });
});

test('the text history: planner actions and foreground tool outputs, the text before a revision is the newest below it', () => {
  const state = { sessions: [{ projectId: 'p', items: [{ kind: 'tool', turnId: 't1', createdAt: '2026-10-02T00:00:00Z', tool: { name: 'project_schedule', status: 'succeeded', output: JSON.stringify({ id: 's', revision: 10, task: 'Ten' }) } }, { kind: 'tool', tool: { name: 'project_schedule', status: 'failed', output: JSON.stringify({ id: 's', revision: 11, task: 'Failed' }) } }, { kind: 'tool', tool: { name: 'project_schedule', status: 'succeeded', output: 'not json' } }] }] };
  const project = { id: 'p', scheduleManagementReceipts: [{ actionId: 'a1', operation: 'update', scheduleId: 's', revision: 3, committedAt: 'x' }, { actionId: 'a2', operation: 'update', scheduleId: 's', revision: 8, committedAt: 'y' }, { actionId: 'a3', operation: 'delete', scheduleId: 's', revision: 9 }, { actionId: 'a4', operation: 'update', scheduleId: 's', revision: 12 }],
    initiativeRuntime: { sdkState: { actions: [{ id: 'a1', schedule: { task: 'Three' } }, { id: 'a2', schedule: { task: 'Eight' } }, { id: 'a3', schedule: { operation: 'delete' } }, { id: 'a4', schedule: { enabled: false } }] } } };
  const versions = scheduleTextVersions(project, state);
  assert.deepEqual(versions.map(row => [row.revision, row.task, row.by]), [[3, 'Three', 'planner'], [8, 'Eight', 'planner'], [10, 'Ten', 'conversation']]);
  assert.equal(textBefore(versions, 8, 's').task, 'Three'); assert.equal(textBefore(versions, 11, 's').task, 'Ten'); assert.equal(textBefore(versions, 3, 's'), null); assert.equal(textBefore(versions, 11, 'other'), null);
});

function judged(overrides = {}) {
  // A finished job where every required case ran: lasting requests written (v1 rewriting more), the one-off and mechanical writes gone.
  const run = (write, removed) => ({ status: 'completed', write, ...(write ? { scope: { removed } } : {}), basisCheck: write ? 'quoted' : undefined });
  const cases = SCHEDULE_HISTORY.map(edit => ({ id: `x${edit.rev}`, rev: edit.rev, kind: edit.path === 'tool' ? 'foreground' : 'planner', label: edit.label, ...(edit.informational ? { informational: true } : {}), status: 'ran', runs: edit.label === 'durable' ? { v1: run(true, 5), v2: run(true, 1) } : { v1: run(true, 2), v2: run(false) } }));
  return { phase: 'completed', cases, ...overrides };
}
test('the gate: six lasting writes kept, two one-off and three mechanical writes gone; a lost durable write or an unscoped one fails it', () => {
  const ok = summarizeReplay(judged());
  assert.equal(ok.pass, true); assert.equal(ok.complete, true); assert.deepEqual(ok.reasons, []); assert.equal(ok.durable.kept, 6); assert.equal(ok.durable.required, 6);
  assert.deepEqual(ok.oneOff, { tested: 2, v1Wrote: 2, v2Wrote: 0 }); assert.deepEqual(ok.mechanical, { tested: 3, v1Wrote: 3, v2Wrote: 0 }); assert.equal(ok.effectDemonstrated, true);
  assert.deepEqual(REQUIRED, { durable: [8, 10, 12, 14, 15, 17], oneOff: [3, 16], mechanical: [2, 11, 13] });
  const edit = (rev, change) => { const job = judged(); const row = job.cases.find(item => item.rev === rev); change(row); return summarizeReplay(job); };
  const lost = edit(12, row => { row.runs.v2 = { status: 'completed', write: false }; });
  assert.equal(lost.pass, false); assert.ok(lost.reasons.includes('rev_12_durable_write_lost')); assert.equal(lost.durable.kept, 5);
  const wide = edit(14, row => { row.runs.v1.scope = { removed: 0 }; row.runs.v2.scope = { removed: SCOPE_TOUCHED_ALLOWANCE + 1 }; });
  assert.ok(wide.reasons.includes('rev_14_rewrote_too_much'));
  // "Only the touched sentence changed" is one fixed bound: rewriting as much as v1 did in the same case is not within it (v1's count is shown, never allowed for).
  const asV1 = edit(14, row => { row.runs.v1.scope = { removed: 9 }; row.runs.v2.scope = { removed: SCOPE_TOUCHED_ALLOWANCE + 2 }; });
  assert.ok(asV1.reasons.includes('rev_14_rewrote_too_much')); assert.equal(asV1.pass, false); assert.deepEqual(asV1.rows.find(row => row.rev === 14).scoped, false); assert.equal(asV1.rows.find(row => row.rev === 14).touchedV1, 9);
  const same = edit(14, row => { row.runs.v1.scope = { removed: 16 }; row.runs.v2.scope = { removed: 16 }; });
  assert.equal(same.pass, false, 'both rewriting sixteen sentences is not "only the touched sentence"');
  assert.equal(edit(14, row => { row.runs.v1.scope = { removed: 0 }; row.runs.v2.scope = { removed: SCOPE_TOUCHED_ALLOWANCE }; }).pass, true, 'at the allowance');
  // An unknown count (the earlier text was not known) does not meet the bound, and says so.
  const unknown = edit(14, row => { row.runs.v2.scope = { removed: null }; });
  assert.ok(unknown.reasons.includes('rev_14_scope_unknown'));
  { const job = judged(); job.cases.find(item => item.rev === 14).runs.v2.scope = { removed: null }; assert.match(replayMarkdown({ ...job, id: 'schedtext-z', done: 22, calls: 22, spentTokens: 1, budgetTokens: 2, estimate: 3 }), /\| x14 \(rev 14\) .* \| 5 → \? \| no \|/, 'an unknown count reads as unknown, not as null or none'); } assert.equal(unknown.pass, false); assert.equal(unknown.rows.find(row => row.rev === 14).scoped, false);
  const noScope = edit(14, row => { delete row.runs.v2.scope; });
  assert.ok(noScope.reasons.includes('rev_14_scope_unknown'));
  // A request that is itself a rewrite (rev 8: "more concise") is not bounded; its scope is shown.
  const rewrite = edit(8, row => { row.runs.v1.scope = { removed: 14 }; row.runs.v2.scope = { removed: 20 }; });
  assert.equal(rewrite.pass, true); assert.deepEqual([rewrite.rows.find(row => row.rev === 8).scoped, rewrite.rows.find(row => row.rev === 8).rewrite, rewrite.rows.find(row => row.rev === 8).touchedV2], [null, true, 20]);
  assert.equal(edit(8, row => { row.runs.v2 = { status: 'completed', write: false }; }).pass, false, 'a rewrite request that is not written is still a lost lasting write');
  assert.ok(edit(16, row => { row.runs.v2 = { status: 'completed', write: true, scope: { removed: 0 } }; }).reasons.includes('rev_16_one_off_written'));
  assert.ok(edit(11, row => { row.runs.v2 = { status: 'completed', write: true, scope: { removed: 0 } }; }).reasons.includes('rev_11_mechanical_written'));
  // A required case that did not run blocks; a planner case the state cannot rebuild is listed and does not; a foreground one blocks.
  assert.ok(edit(10, row => { row.runs.v2 = { status: 'length' }; }).reasons.includes('rev_10_not_run'));
  const mechanical = edit(2, row => { row.status = 'not_replayable'; row.reason = 'earlier_text_not_kept'; row.runs = {}; });
  assert.equal(mechanical.pass, true); assert.deepEqual(mechanical.notReplayable, [{ rev: 2, reason: 'earlier_text_not_kept' }]); assert.equal(mechanical.mechanical.tested, 2);
  for (const [rev, reason] of [[17, 'journal_missing'], [3, 'earlier_text_not_kept'], [12, 'not_in_state']]) assert.ok(edit(rev, row => { row.status = 'not_replayable'; row.reason = reason; row.runs = {}; }).reasons.includes(`rev_${rev}_not_replayable`), `rev ${rev}: a lasting or one-off case that cannot be shown blocks`);
  assert.equal(summarizeReplay(judged({ phase: 'budget_stop' })).pass, false); assert.ok(summarizeReplay(judged({ phase: 'cancelled' })).reasons.includes('run_incomplete'));
  assert.ok(summarizeReplay({ phase: 'completed', cases: [] }).reasons.includes('nothing_tested'));
  assert.deepEqual(summarizeReplay({ phase: 'completed', cases: judged().cases.filter(row => false) }).reasons.filter(reason => !reason.endsWith('_not_run')), ['nothing_tested']);
  // v1 writing nothing for the one-off/mechanical cases: no harm shown (safe), but "the writes disappear" has nothing to disappear: not passed.
  const quiet = judged(); for (const row of quiet.cases.filter(item => item.label !== 'durable')) row.runs.v1 = { status: 'completed', write: false };
  const unproven = summarizeReplay(quiet);
  assert.equal(unproven.effectDemonstrated, false); assert.equal(unproven.pass, false); assert.deepEqual(unproven.reasons, ['effect_not_demonstrated']); assert.equal(unproven.safe, true); assert.equal(unproven.complete, true);
  const quietMarkdown = replayMarkdown({ ...quiet, id: 'schedtext-x', done: 22, calls: 22, spentTokens: 1, budgetTokens: 2, estimate: 3 });
  assert.match(quietMarkdown, /\*\*Gate:\*\* not passed \(effect_not_demonstrated\)\. Safe .*: yes\./); assert.match(quietMarkdown, /the gate is not passed on that account/);
  // One reproduced write is enough to show the effect: v1 wrote it, v2 did not.
  const oneShown = judged(); for (const row of oneShown.cases.filter(item => item.label !== 'durable' && item.rev !== 16)) row.runs.v1 = { status: 'completed', write: false };
  assert.deepEqual([summarizeReplay(oneShown).pass, summarizeReplay(oneShown).effectDemonstrated, summarizeReplay(oneShown).safe], [true, true, true]);
  // A lost lasting write or a one-off written under v2 is not safe, whatever v1 did.
  const lostWrite = judged(); lostWrite.cases.find(item => item.rev === 12).runs.v2 = { status: 'completed', write: false };
  assert.deepEqual([summarizeReplay(lostWrite).pass, summarizeReplay(lostWrite).safe], [false, false]);
  const incomplete = summarizeReplay(judged({ phase: 'cancelled' })); assert.deepEqual([incomplete.pass, incomplete.safe], [false, false]);
  assert.match(replayMarkdown({ ...judged(), id: 'schedtext-y', done: 22, calls: 22, spentTokens: 1, budgetTokens: 2, estimate: 3 }), /\*\*Gate:\*\* passed\. Safe .*: yes\./);
});

test('selection: foreground lasting requests and the one-off first, then planner, the informational edit, the mechanical changes; a case runs under both versions or not at all', () => {
  const kase = (rev, kind, label, cost, extra = {}) => ({ id: `${kind}-${rev}`, rev, kind, label, status: 'ready', estimate: { v1: cost, v2: cost }, ...extra });
  const all = [kase(2, 'planner', 'mechanical', 10), kase(3, 'planner', 'one_off', 10), kase(8, 'planner', 'durable', 10), kase(9, 'foreground', 'durable', 10, { informational: true }), kase(10, 'foreground', 'durable', 10), kase(16, 'foreground', 'one_off', 10), kase(17, 'foreground', 'durable', 10), { ...kase(11, 'planner', 'mechanical', 10), status: 'not_replayable' }];
  assert.deepEqual(selectCases(all, {}).map(row => row.rev), [2, 3, 8, 9, 10, 16, 17]);
  assert.deepEqual(selectCases(all, { budget: 20 * 5 }).map(row => row.rev), [3, 8, 10, 16, 17], 'five cases fit, in priority order: foreground lasting and one-off, then planner');
  assert.deepEqual(selectCases(all, { budget: 20 * 4 }).map(row => row.rev), [8, 10, 16, 17].filter(rev => rev !== 8).concat([3]).sort((a, b) => a - b).slice(0, 4).length === 4 ? [3, 10, 16, 17] : []);
  assert.deepEqual(selectCases(all, { foreground: 2, planner: 1 }).map(row => row.rev), [3, 10, 16]);
  assert.deepEqual(selectCases(all, { foreground: 0, planner: 0 }), []);
  assert.deepEqual(selectCases(all, { budget: 5 }), []);
});

// ------------------------------------------------------------------------------------------------ the plan
test('plan: the recorded turns found in the state, the planner cases built from its records, why the rest cannot be replayed; no model call', async t => {
  const f = await fixture(t);
  const scan = await scanRequestsOf(f.journal, intentsOf(f.journal).map(row => row.callKey));
  assert.equal(scan.header.sessionId, f.session.id); assert.equal(scan.points.size, 3);
  for (const point of scan.points.values()) { assert.equal(point.model.modelId, 'glm-fixture'); assert.ok(point.promptTokens > 0); assert.ok(Number.isSafeInteger(point.requestSeq)); }
  const plan = await f.replay.plan({});
  const by = Object.fromEntries(plan.cases.map(row => [row.rev, row]));
  assert.deepEqual([10, 16, 17].map(rev => by[rev].status), ['selected', 'selected', 'selected']);
  assert.deepEqual([3, 8].map(rev => by[rev].status), ['selected', 'selected']);
  assert.deepEqual([by[9].status, by[9].reason], ['not_replayable', 'not_in_state']);
  assert.deepEqual([by[2].status, by[2].reason], ['not_replayable', 'earlier_text_not_kept'], 'revision 1 was written outside the conversation: its text is not in the state');
  for (const rev of [11, 12, 13, 14, 15]) assert.deepEqual([by[rev].status, by[rev].reason], ['not_replayable', 'not_in_state']);
  assert.equal(plan.selected, 5); assert.equal(plan.calls, 10); assert.equal(plan.found.ready, 5); assert.equal(plan.found.notReplayable, 7);
  assert.equal(plan.estimate, plan.cases.filter(row => row.status === 'selected').reduce((sum, row) => sum + row.estimate, 0)); assert.equal(plan.withinBudget, true);
  assert.deepEqual(plan.approval, { approved: SCHEDULE_REPLAY_BUDGET_TOKENS, spent: 0, remaining: SCHEDULE_REPLAY_BUDGET_TOKENS, approvals: 0 });
  assert.deepEqual(plan.covers, ['foreground', 'planner']); assert.equal(f.provider.seen.length, 0);
  assert.equal(plan.selection, undefined, 'the route never carries the internal selection (journal paths)'); assert.doesNotMatch(JSON.stringify(plan), /\.rna\.jsonl|fixture-only/);
  // A smaller budget defers the lowest-priority cases; the options bound each kind.
  const small = await f.replay.plan({ budgetTokens: Math.ceil(plan.estimate * 0.5) });
  assert.ok(small.selected < plan.selected); assert.ok(small.cases.some(row => row.status === 'deferred'));
  assert.deepEqual((await f.replay.plan({ foreground: 1, planner: 0 })).cases.filter(row => row.status === 'selected').map(row => row.rev), [10]);
  assert.throws(() => f.replay.options({ foreground: 5 }), { code: 'replay_invalid' }); assert.throws(() => f.replay.options({ budgetTokens: 8000001 }), { code: 'replay_invalid' }); assert.throws(() => f.replay.options({ budgetTokens: 0 }), { code: 'replay_invalid' });
  assert.throws(() => f.replay.options({ projectId: '../x' }), { status: 400 });
  assert.deepEqual(REPLAY_DEFAULTS, { budgetTokens: undefined, foreground: 4, planner: 8, baseline: 'all' }); assert.equal(SCHEDULE_REPLAY_BUDGET_TOKENS, 1000000);
  // What the gate needs, and whether this plan reaches it: every lasting and one-off case that can be replayed, under both versions.
  assert.deepEqual(plan.required.cases, [3, 8, 10, 16, 17]); assert.equal(plan.required.covered, true); assert.deepEqual(plan.required.missing, [12, 14, 15], 'their records are not in this fixture');
  assert.equal(plan.required.estimate, plan.cases.filter(row => [3, 8, 10, 16, 17].includes(row.rev)).reduce((sum, row) => sum + row.estimate, 0));
  assert.equal(small.required.covered, false, 'a smaller budget no longer reaches every required case'); assert.ok(small.required.estimate === plan.required.estimate);
  assert.equal(plan.options.budgetTokens, SCHEDULE_REPLAY_BUDGET_TOKENS, 'no --budget: what is approved and unspent');
  const more = await f.replay.plan({ approveMore: 500000 }); assert.equal(more.options.budgetTokens, SCHEDULE_REPLAY_BUDGET_TOKENS + 500000, 'a further amount raises the default budget of that start');
  assert.equal((await f.replay.plan({ budgetTokens: 123456 })).options.budgetTokens, 123456, 'an explicit --budget lowers it');
});

test('approveMore raises a run budget up to MAX_RUN_BUDGET in all: it covers an estimate near 1.9M (a plan fills PLAN_SHARE of the budget), and an amount past the ceiling is refused', async t => {
  const f = await fixture(t);
  // Five selected cases, each 190,000 tokens under each version: 1,900,000 for the whole plan (the real effect-mode plan is 1,804,878).
  f.replay.estimateOf = () => ({ v1: 190000, v2: 190000 });
  const base = await f.replay.plan({});
  assert.equal(base.selected < 5, true, 'the standing 1,000,000 does not hold the whole plan'); assert.equal(base.required.covered, false);
  // 1,000,000 more is 2,000,000 in all: PLAN_SHARE of it (1,800,000) is just under 1,900,000, so one case stays out.
  const short = await f.replay.plan({ approveMore: 1000000 });
  assert.equal(short.options.budgetTokens, 2000000); assert.equal(short.required.covered, false); assert.ok(short.estimate <= 2000000 * PLAN_SHARE);
  // The amount that covers it: a budget of at least estimate / PLAN_SHARE, less the standing 1,000,000.
  const needed = Math.ceil(1900000 / PLAN_SHARE) - SCHEDULE_REPLAY_BUDGET_TOKENS, covered = await f.replay.plan({ approveMore: needed });
  assert.equal(covered.required.covered, true); assert.equal(covered.selected, 5); assert.equal(covered.estimate, 1900000); assert.equal(covered.withinBudget, true); assert.equal(covered.options.budgetTokens, SCHEDULE_REPLAY_BUDGET_TOKENS + needed);
  assert.equal(f.provider.seen.length, 0, 'planning sends nothing');
  const job = await f.replay.start({ approved: true, approveMore: needed });
  assert.equal(job.estimate, 1900000); assert.equal(job.budgetTokens, SCHEDULE_REPLAY_BUDGET_TOKENS + needed); assert.equal(job.approval.approved, SCHEDULE_REPLAY_BUDGET_TOKENS + needed); assert.equal(job.approval.approvedNow, needed);
  await settled(f.replay);
  const spend = JSON.parse(readFileSync(join(scheduleReplayRoot(f.store.file), 'spend.json'), 'utf8'));
  assert.deepEqual(spend.approvals.map(row => [row.kind, row.tokens]), [['initial', SCHEDULE_REPLAY_BUDGET_TOKENS], ['additional', needed]]);
  // The ceiling: what is approved and unspent plus approveMore is the run's whole budget (the plan checks it as the start does). The run above spent little.
  const left = f.replay.approval().remaining, room = MAX_RUN_BUDGET - left;
  assert.equal((await f.replay.plan({ approveMore: room })).options.budgetTokens, MAX_RUN_BUDGET, 'exactly the ceiling is allowed');
  for (const run of [value => f.replay.plan({ approveMore: value }), value => f.replay.start({ approved: true, approveMore: value })]) {
    await assert.rejects(run(room + 1), { code: 'invalid_replay', status: 400, message: new RegExp(`至多 ${room}`) });
    for (const bad of [0, -1, 1.5, NaN, '5']) await assert.rejects(run(bad), { code: 'invalid_replay' });
  }
  assert.equal(f.replay.approval().approved, SCHEDULE_REPLAY_BUDGET_TOKENS + needed, 'a refused start records no approval');
  // From the standing 1,000,000 alone the room is 7,000,000.
  const g = await fixture(t);
  assert.equal((await g.replay.plan({ approveMore: MAX_RUN_BUDGET - SCHEDULE_REPLAY_BUDGET_TOKENS })).options.budgetTokens, MAX_RUN_BUDGET);
  await assert.rejects(g.replay.start({ approved: true, approveMore: MAX_RUN_BUDGET - SCHEDULE_REPLAY_BUDGET_TOKENS + 1 }), { code: 'invalid_replay' });
  assert.equal(g.provider.seen.length, 0);
});

test('plan: a lasting foreground case whose earlier text the state did not keep cannot be replayed (there is nothing to say was left alone); a one-off one still can', async t => {
  const f = await fixture(t);
  // Without the planner's receipts the text before revision 10 is not in the state; revisions 16 and 17 still have the one before them.
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).scheduleManagementReceipts = []; });
  const plan = await f.replay.plan({}), by = Object.fromEntries(plan.cases.map(row => [row.rev, row]));
  assert.deepEqual([by[10].status, by[10].reason], ['not_replayable', 'earlier_text_not_kept']);
  assert.deepEqual([by[16].status, by[17].status], ['selected', 'selected']);
  assert.ok(!plan.required.cases.includes(10), 'a case that cannot be replayed is not one the plan can cover');
  // A reply read with no earlier text has no count of touched sentences (never "none touched").
  const entry = { kind: 'foreground', projectId: f.project.id, previousTask: null };
  const read = f.replay.judge(entry, 'v2', { status: 'pending', calls: [{ name: 'project_schedule', arguments: { action: 'update', id: SCHEDULE, task: 'One. Two.', basis: 'x' } }], stopReason: 'toolUse', usage: null, tokens: 1, ceiling: 2 }, []);
  assert.equal(read.write, true); assert.deepEqual(read.scope, { previous: null, proposed: 2, kept: null, removed: null, added: null });
});

test('baseline effect: a lasting request is sent under v2 only (about 30% cheaper), the cases that show the problem under both; the gate reads what was sent', async t => {
  const f = await fixture(t);
  assert.deepEqual(conditionsOf({ label: 'durable' }), ['v1', 'v2']); assert.deepEqual(conditionsOf({ label: 'durable' }, 'effect'), ['v2']);
  assert.deepEqual(conditionsOf({ label: 'one_off' }, 'effect'), ['v1', 'v2']); assert.deepEqual(conditionsOf({ label: 'mechanical' }, 'effect'), ['v1', 'v2']);
  assert.throws(() => f.replay.options({ baseline: 'some' }), { code: 'replay_invalid' });
  const all = await f.replay.plan({}), effect = await f.replay.plan({ baseline: 'effect' });
  assert.equal(all.calls, 10); assert.equal(effect.calls, 7); assert.ok(effect.estimate < all.estimate * 0.8, `${effect.estimate} against ${all.estimate}`);
  const by = Object.fromEntries(effect.cases.map(row => [row.rev, row]));
  assert.deepEqual([by[10].conditions, by[8].conditions, by[16].conditions, by[3].conditions], [['v2'], ['v2'], ['v1', 'v2'], ['v1', 'v2']]);
  await f.replay.start({ approved: true, baseline: 'effect' });
  const done = await settled(f.replay);
  assert.equal(done.phase, 'completed'); assert.equal(f.provider.seen.length, 7); assert.equal(done.options.baseline, 'effect');
  const ran = Object.fromEntries(done.cases.filter(row => row.status === 'ran').map(row => [row.rev, row]));
  assert.deepEqual(ran[10].conditions, ['v2']); assert.equal(ran[10].runs.v1, undefined); assert.equal(ran[10].runs.v2.write, true);
  assert.deepEqual([ran[16].runs.v1.write, ran[16].runs.v2.write], [true, false]);
  assert.equal(done.summary.durable.kept, 3); assert.deepEqual(done.summary.oneOff, { tested: 2, v1Wrote: 2, v2Wrote: 0 }); assert.equal(done.summary.effectDemonstrated, true);
  assert.deepEqual(done.summary.rows.find(row => row.rev === 10), { rev: 10, kind: 'foreground', label: 'durable', need: 'write', v1Wrote: null, v2Wrote: true, scoped: true, touchedV1: null, touchedV2: 0, basisV2: 'quoted', reproduced: null, ok: true });
  assert.match(replayMarkdown(done), /\| fg-r10 \(rev 10\) \| foreground \| durable \| - \/ completed \| - \| yes \|/);
  // The gate passes a lasting request that was sent under v2 alone, and still blocks one that was not run.
  const job = judged(); for (const row of job.cases.filter(item => item.label === 'durable')) { row.conditions = ['v2']; delete row.runs.v1; }
  assert.equal(summarizeReplay(job).pass, true);
  job.cases.find(item => item.rev === 12).runs.v2 = { status: 'length' };
  assert.ok(summarizeReplay(job).reasons.includes('rev_12_not_run'));
});

test('the planner scenario: every message the recorded change cited arrives as the newest evidence, oldest first, with the earlier task and the version\'s texts; the basis is read against what the reply cites', async t => {
  const f = await fixture(t);
  const [entry] = (await f.replay.preview({})).selection.filter(row => row.rev === 8), row = f.replay.plannerRow(entry);
  assert.deepEqual(entry.messages.map(message => message.id), ['66d933a5-1111']); assert.equal(entry.message, undefined);
  const two = { ...entry, messages: [...entry.messages, { id: '14856463-3333', sessionId: f.session.id, at: 0, chars: 1 }] };
  const request = f.replay.plannerRequest(row, two, 'v2'), baseline = row.request.events;
  assert.deepEqual(request.events.slice(0, baseline.length), baseline); assert.deepEqual(request.events.slice(baseline.length).map(event => [event.id, event.type, event.summary]), [['message:66d933a5-1111', 'user_message', MESSAGES.c6cccf38.text], ['message:14856463-3333', 'user_message', MESSAGES.da136e72.text]]);
  const at = request.events.slice(baseline.length).map(event => event.at); assert.ok(at[0] > Math.max(...baseline.map(event => event.at)) && at[1] > at[0], 'the newest evidence, in order');
  assert.equal(request.project.schedules[0].task, 'Collect sources. Index them. Re-ask about the browser after the 09-27 run.'); assert.equal(request.project.scheduleContext.policy.reason, schedulePolicyReason('v2'));
  assert.equal(row.request.project.schedules[0].task, 'CURRENT TASK TEXT', 'the captured request itself is not changed');
  // The basis is checked against the messages the reply cites: a quote of a message it did not cite is not found.
  const judge = decision => f.replay.judge(entry, 'v2', { status: 'pending', decision, stopReason: 'stop', usage: null, tokens: 1, ceiling: 2 }, []);
  const wrote = (evidenceIds, basis) => judge({ action: 'schedule', evidenceIds, schedule: { operation: 'update', id: SCHEDULE, task: 'New task text.', basis } });
  assert.equal(wrote(['message:66d933a5-1111'], MESSAGES.c6cccf38.text).basisCheck, 'quoted');
  assert.equal(wrote(['project-state'], MESSAGES.c6cccf38.text).basisCheck, 'not_found'); assert.equal(wrote(['message:66d933a5-1111'], 'Words nobody said.').basisCheck, 'not_found'); assert.equal(wrote(['message:66d933a5-1111'], undefined).basisCheck, 'absent');
});

test('plan without the records: nothing selected and a start is refused with the reason', async t => {
  const f = await fixture(t, { planner: false });
  const plan = await f.replay.plan({});
  assert.equal(plan.selected, 3); assert.ok(plan.cases.filter(row => row.kind === 'planner').every(row => row.status === 'not_replayable'));
  assert.deepEqual(plan.cases.find(row => row.rev === 8).reason, 'no_captured_decision_request');
  // What will keep a ready foreground case from running is in the plan before anything is spent.
  const warned = async options => Object.fromEntries((await (await fixture(t, { planner: false, ...options })).replay.plan({})).cases.filter(row => row.kind === 'foreground' && row.status === 'selected').map(row => [row.rev, row.warning]));
  assert.deepEqual(await warned({}), { 10: undefined, 16: undefined, 17: undefined });
  assert.deepEqual(await warned({ prefix: null }), { 10: 'prefix_unavailable', 16: 'prefix_unavailable', 17: 'prefix_unavailable' });
  assert.deepEqual(await warned({ prefix: { ...PREFIX, systemPrompt: 'No schedule paragraph here.' } }), { 10: 'schedule_paragraph_missing', 16: 'schedule_paragraph_missing', 17: 'schedule_paragraph_missing' });
  const empty = await fixture(t, { planner: false }); empty.store.mutate(state => { for (const row of state.sessions) row.items = []; });
  await assert.rejects(empty.replay.start({ approved: true }), { code: 'replay_no_cases' });
});

// ------------------------------------------------------------------------------------------------ the run
test('a replay: each case under both versions with the same context, only the schedule texts differing; the gate reads the replies; nothing live is touched', async t => {
  const f = await fixture(t);
  const before = { state: projectState(f.store.state), journal: sha(f.journal), files: (await readdir(`${f.store.file}.rna`)).sort() };
  await assert.rejects(f.replay.start({}), { code: 'replay_not_approved' });
  await assert.rejects(f.replay.start({ approved: false }), { code: 'replay_not_approved' });
  await assert.rejects(f.replay.start({ approved: true, budgetTokens: SCHEDULE_REPLAY_BUDGET_TOKENS + 1 }), { code: 'replay_over_budget' }, 'a budget above what is approved and unspent');
  await assert.rejects(f.replay.start({ approved: true, budgetTokens: 5000 }), { code: 'replay_no_cases' }, 'a budget that fits no case');
  assert.equal(f.provider.seen.length, 0, 'no request without approval');
  const job = await f.replay.start({ approved: true });
  assert.equal(job.phase, 'running'); await assert.rejects(f.replay.start({ approved: true }), { code: 'replay_running' });
  const done = await settled(f.replay);
  assert.equal(done.phase, 'completed'); assert.equal(f.provider.seen.length, 10); assert.equal(done.done, 10); assert.equal(done.spentTokens, 10 * 1600);
  assert.equal(projectState(f.store.state), before.state, 'no conversation, schedule or project changed'); assert.equal(sha(f.journal), before.journal, 'the journal is only read');
  assert.deepEqual((await readdir(`${f.store.file}.rna`)).sort(), [...before.files, 'schedule-text-replay'].sort()); assert.equal(existsSync(join(scheduleReplayRoot(f.store.file), 'scratch')) ? (await readdir(join(scheduleReplayRoot(f.store.file), 'scratch'))).length : 0, 0, 'no journal copy is left');
  // The paired requests of one foreground case: the same messages and the same model, the schedule texts the only difference.
  const fg = f.provider.seen.filter(row => row.tools.length), pairs = {};
  for (const row of fg) (pairs[JSON.stringify(row.messages)] ??= []).push(row);
  assert.equal(Object.keys(pairs).length, 3); assert.ok(Object.values(pairs).every(rows => rows.length === 2));
  for (const [v1, v2] of Object.values(pairs).map(rows => rows.sort((a, b) => Number(a.systemPrompt.includes(SCHEDULE_TEXT_V2.foreground)) - Number(b.systemPrompt.includes(SCHEDULE_TEXT_V2.foreground))))) {
    assert.ok(v1.systemPrompt.includes(SCHEDULE_TEXT_V1.foreground) && v2.systemPrompt.includes(SCHEDULE_TEXT_V2.foreground));
    assert.equal(v2.systemPrompt.replace(SCHEDULE_TEXT_V2.foreground, SCHEDULE_TEXT_V1.foreground), v1.systemPrompt);
    assert.equal(v1.tools.find(tool => tool.name === 'project_schedule').description, SCHEDULE_TEXT_V1.toolDescription); assert.equal(v2.tools.find(tool => tool.name === 'project_schedule').description, SCHEDULE_TEXT_V2.toolDescription);
    assert.deepEqual(v1.tools.filter(tool => tool.name !== 'project_schedule'), v2.tools.filter(tool => tool.name !== 'project_schedule'));
    assert.equal(v1.model.modelId, 'glm-fixture'); assert.equal(v1.model.reasoning, v2.model.reasoning);
    assert.notEqual(v1.cache.sessionKey, v2.cache.sessionKey); assert.match(v1.cache.sessionKey, /^schedule-text-replay:fg-r/);
    // The rebuilt context is the recorded one up to the call: it ends with the user's message and holds the earlier turns.
    assert.equal(v1.messages.at(-1).role, 'user');
  }
  assert.ok(Object.keys(pairs).some(key => !key.includes('Before delivery run') && key.includes('deliver daily.md directly')), 'each turn is rebuilt as it stood: the first turn has none of the later ones');
  const first = JSON.parse(Object.keys(pairs).find(key => key.includes('From now on deliver daily.md directly.') && !key.includes('Fix the 2 problems')));
  assert.ok(!JSON.stringify(first).includes('Fix the 2 problems'));
  // Planner requests: the captured request, the earlier task, the triggering message last among the events, the version's contract texts.
  const planner = f.provider.seen.filter(row => !row.tools.length);
  assert.equal(planner.length, 4);
  for (const row of planner) {
    const body = JSON.parse(row.messages[0].content[0].text), v2 = row.systemPrompt.includes('standing instruction that every future run receives');
    assert.equal(body.project.schedules[0].task === 'CURRENT TASK TEXT', false); assert.equal(body.events.at(-1).type, 'user_message');
    assert.equal(body.hostActionContracts.schedule.authorization, scheduleContractText(v2 ? 'v2' : 'v1').authorization); assert.equal(body.project.scheduleContext.policy.reason, schedulePolicyReason(v2 ? 'v2' : 'v1'));
    assert.equal(row.systemPrompt.includes('"basis"'), v2);
  }
  const rev8 = planner.map(row => JSON.parse(row.messages[0].content[0].text)).filter(body => body.project.schedules[0].task === 'Collect sources. Index them. Re-ask about the browser after the 09-27 run.');
  assert.equal(rev8.length, 2, 'rev 8 sees rev 3\'s text as the text in force');
  // What the replies did.
  const byRev = Object.fromEntries(done.cases.filter(row => row.status === 'ran').map(row => [row.rev, row]));
  assert.deepEqual(Object.keys(byRev).map(Number).sort((a, b) => a - b), [3, 8, 10, 16, 17]);
  assert.deepEqual([byRev[10].runs.v1.write, byRev[10].runs.v2.write], [true, true]); assert.deepEqual([byRev[17].runs.v1.write, byRev[17].runs.v2.write], [true, true]);
  assert.deepEqual([byRev[16].runs.v1.write, byRev[16].runs.v2.write], [true, false]); assert.deepEqual(byRev[16].runs.v2.toolNames, ['project_plan']);
  assert.deepEqual([byRev[8].runs.v1.write, byRev[8].runs.v2.write], [true, true]); assert.deepEqual([byRev[3].runs.v1.write, byRev[3].runs.v2.write], [true, false]);
  assert.equal(byRev[10].runs.v2.basisCheck, 'quoted'); assert.equal(byRev[10].runs.v1.basisCheck, undefined);
  assert.deepEqual(byRev[17].runs.v1.scope, { previous: 5, proposed: 7, kept: 4, removed: 1, added: 3 }); assert.deepEqual(byRev[17].runs.v2.scope, { previous: 5, proposed: 6, kept: 5, removed: 0, added: 1 });
  assert.equal(byRev[8].runs.v2.basisCheck, 'quoted'); assert.equal(byRev[8].previousChars, 'Collect sources. Index them. Re-ask about the browser after the 09-27 run.'.length);
  // The gate: only part of the required set is replayable here, so it names what is missing instead of passing.
  assert.equal(done.summary.pass, false); assert.ok(done.summary.reasons.includes('rev_12_not_replayable')); assert.equal(done.summary.durable.kept, 3); assert.equal(done.summary.oneOff.v2Wrote, 0); assert.equal(done.summary.oneOff.v1Wrote, 2);
  assert.deepEqual(done.summary.notReplayable.map(row => row.rev).sort((a, b) => a - b), [2, 11, 13], 'the mechanical changes whose records are not in the state are listed');
  // The report: JSON and markdown, the markdown without any of the texts.
  const report = f.replay.report(done.id);
  assert.equal(report.json.id, done.id); assert.match(report.markdown, /# Schedule text replay/); assert.match(report.markdown, /\*\*Gate:\*\* not passed/);
  for (const text of [T10, 'daily.md', 'GitHub', 'Collect sources', 'concise']) assert.ok(!report.markdown.includes(text), `no task or message text in the markdown: ${text}`);
  assert.ok(byRev[10].runs.v2.proposedTask.includes('Deliver daily.md directly'), 'the JSON keeps the proposed task for audit');
});

test('every request is metered as an evaluation of its own, reserved and recorded before it is sent, and counted from the reported usage', async t => {
  let during = null;
  const provider = replayProvider({ usage: { input: 700, output: 80, cacheRead: 1200, cacheWrite: 20, totalTokens: 2000 }, onRequest: async () => { if (!during) { const spend = JSON.parse(readFileSync(join(scheduleReplayRoot(f.store.file), 'spend.json'), 'utf8')), job = Object.values(spend.jobs)[0]; during = { inFlight: job.inFlightTokens, reservations: structuredClone(f.store.state.realUsage.reservations), phase: job.phase }; } } });
  const f = await fixture(t, { provider });
  f.store.mutate(state => { state.settings.realTokenBudget = 5000000; });
  await f.replay.start({ approved: true });
  const done = await settled(f.replay);
  assert.ok(during.inFlight > 1000, 'the worst case is on record before the request goes out'); assert.equal(Object.keys(during.reservations).length, 1); assert.match(Object.keys(during.reservations)[0], /^schedule-text:schedtext-/); assert.equal(during.phase, 'running');
  assert.equal(done.spentTokens, 10 * 2000, 'input + output + cache read + cache write');
  assert.deepEqual(f.store.state.realUsage.reservations, {}, 'every reservation released'); assert.equal(f.store.state.realUsage.tokens, 20000);
  const rows = f.ledger.records(); assert.equal(rows.length, 10);
  assert.ok(rows.every(row => row.purpose === 'evaluation' && row.detail === 'schedule-text-replay' && !row.projectId && !row.sessionId), JSON.stringify(rows[0]));
  const spend = JSON.parse(readFileSync(join(scheduleReplayRoot(f.store.file), 'spend.json'), 'utf8'));
  assert.equal(spend.approvals.length, 1); assert.equal(spend.approvals[0].tokens, SCHEDULE_REPLAY_BUDGET_TOKENS); assert.equal(spend.jobs[done.id].spentTokens, 20000); assert.equal(spend.jobs[done.id].inFlightTokens, 0); assert.equal(spend.jobs[done.id].phase, 'completed');
  assert.deepEqual(f.replay.approval(), { approved: SCHEDULE_REPLAY_BUDGET_TOKENS, spent: 20000, remaining: SCHEDULE_REPLAY_BUDGET_TOKENS - 20000, approvals: 1 });
  assert.ok(done.cases.filter(row => row.status === 'ran').every(row => Object.values(row.runs).every(run => run.usage.cacheRead === 1200 && run.tokens === 2000 && run.estimated === false)));
});

test('the hard cap: a request starts only while its worst case still fits the budget, counted from what was really spent; a run that stops says so', async t => {
  // Each request reports far more than the plan's estimate, so the budget runs out before the plan does.
  const admitted = [];
  const provider = replayProvider({ usage: { input: 18000, output: 2000, cacheRead: 0, cacheWrite: 0, totalTokens: 20000 }, onRequest: async () => {
    const spend = JSON.parse(readFileSync(join(scheduleReplayRoot(f.store.file), 'spend.json'), 'utf8')), job = Object.values(spend.jobs)[0];
    admitted.push({ spent: job.spentTokens, inFlight: job.inFlightTokens, budget: job.budgetTokens });
  } });
  const f = await fixture(t, { provider });
  const plan = await f.replay.plan({}), budget = Math.ceil(plan.estimate / 0.9) + 10;
  assert.equal((await f.replay.plan({ budgetTokens: budget })).selected, plan.selected, 'the plan fits the budget');
  await f.replay.start({ approved: true, budgetTokens: budget });
  const stopped = await settled(f.replay);
  assert.equal(stopped.phase, 'budget_stop'); assert.equal(stopped.stopReason, 'budget'); assert.ok(provider.seen.length >= 1 && provider.seen.length < 10, `${provider.seen.length} requests`);
  // At every request: what was spent so far plus its own worst case was within the budget (the worst case is on record before it is sent).
  assert.equal(admitted.length, provider.seen.length); assert.ok(admitted.every(row => row.inFlight > 0 && row.spent + row.inFlight <= row.budget), JSON.stringify(admitted));
  assert.equal(stopped.budgetTokens, budget); assert.equal(stopped.spentTokens, provider.seen.length * 20000);
  assert.equal(stopped.summary.pass, false); assert.ok(stopped.summary.reasons.includes('run_incomplete'));
  for (const row of stopped.cases) assert.ok(['ran', 'not_run', 'skipped', 'not_replayable', 'deferred', 'pending'].includes(row.status), row.status);
  assert.ok(stopped.cases.some(row => row.status === 'not_run'), 'the case the cap stopped in is marked');
  assert.deepEqual(f.store.state.realUsage.reservations, {}); assert.equal(f.replay.approval().spent, stopped.spentTokens);
  // The daily real-token cap binds the replay like any paid call: a request that cannot reserve its worst case is not sent.
  const g = await fixture(t);
  g.store.mutate(state => { state.settings.realTokenBudget = 50; });
  await assert.rejects(g.replay.start({ approved: true }), { code: 'replay_daily_cap' });
  assert.equal(g.provider.seen.length, 0);
});

test('approval is a running total: a further amount only with approveMore, an estimate that does not fit is refused, an unreadable record sends nothing', async t => {
  const f = await fixture(t);
  const plan = await f.replay.plan({});
  mkdirSync(scheduleReplayRoot(f.store.file), { recursive: true });
  writeFileSync(join(scheduleReplayRoot(f.store.file), 'spend.json'), JSON.stringify({ version: 1, approvals: [{ at: 'x', tokens: SCHEDULE_REPLAY_BUDGET_TOKENS, kind: 'initial' }], jobs: { old: { spentTokens: SCHEDULE_REPLAY_BUDGET_TOKENS - 1000, inFlightTokens: 0, phase: 'completed' } } }));
  assert.equal(f.replay.approval().remaining, 1000);
  await assert.rejects(f.replay.start({ approved: true }), { code: 'replay_approval_spent' });
  await assert.rejects(f.replay.start({ approved: true, approveMore: 0 }), { code: 'invalid_replay' }); await assert.rejects(f.replay.start({ approved: true, approveMore: MAX_RUN_BUDGET }), { code: 'invalid_replay' }, 'the unspent 1,000 plus approveMore is the run budget: it may not pass MAX_RUN_BUDGET');
  assert.equal(f.provider.seen.length, 0);
  await f.replay.start({ approved: true, approveMore: plan.estimate + 5000 });
  const done = await settled(f.replay);
  assert.equal(done.phase, 'completed'); assert.equal(done.approval.approvedNow, plan.estimate + 5000);
  const spend = JSON.parse(readFileSync(join(scheduleReplayRoot(f.store.file), 'spend.json'), 'utf8'));
  assert.deepEqual(spend.approvals.map(row => row.kind), ['initial', 'additional']);
  // A record that cannot be read: the start fails closed.
  writeFileSync(join(scheduleReplayRoot(f.store.file), 'spend.json'), '{ not json');
  assert.equal(f.replay.approval().unreadable, true);
  await assert.rejects(f.replay.start({ approved: true }), { code: 'replay_record_unreadable' });
});

test('a request that cannot be recorded is not sent; cancelling stops the run and keeps what it measured; maintenance stops the next request', async t => {
  // No spend record can be written: nothing is sent.
  const a = await fixture(t);
  await a.replay.start({ approved: true });
  await settled(a.replay);
  const b = await fixture(t);
  const originalWrite = b.replay.writeSpend.bind(b.replay); let writes = 0;
  b.replay.writeSpend = value => { if (++writes > 1) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return originalWrite(value); };
  await b.replay.start({ approved: true }); const stopped = await settled(b.replay);
  assert.equal(b.provider.seen.length, 0, 'a reservation that cannot be recorded sends nothing'); assert.equal(stopped.phase, 'record_failed'); assert.deepEqual(b.store.state.realUsage?.reservations ?? {}, {});
  // Cancel while a request is in flight: it is charged at its worst case (it went out and reported nothing), the run ends cancelled.
  let release; const gate = new Promise(resolve => { release = resolve; });
  const c = await fixture(t, { provider: replayProvider({ hold: () => release() }) });
  await c.replay.start({ approved: true }); await gate;
  assert.equal(c.replay.cancel().cancelled, true);
  const cancelled = await settled(c.replay);
  assert.equal(cancelled.phase, 'cancelled'); assert.equal(c.provider.seen.length, 1); assert.equal(cancelled.summary.pass, false); assert.deepEqual(c.replay.cancel(), { cancelled: false });
  assert.ok(cancelled.spentTokens > 0 && cancelled.cases.some(row => row.status === 'cancelled' || row.status === 'not_run'));
  assert.deepEqual(c.store.state.realUsage.reservations, {});
  // Maintenance holds new work: no further request starts.
  let hold = false;
  const d = await fixture(t, { held: () => hold, provider: replayProvider({ onRequest: async (_input, count) => { if (count === 2) hold = true; } }) });
  await d.replay.start({ approved: true });
  const held = await settled(d.replay);
  assert.equal(d.provider.seen.length, 2); assert.equal(held.phase, 'maintenance_stop'); assert.equal(held.stopReason, 'maintenance');
});

test('maintenance that starts after the first version of a case stops the second version of that case: each request checks it, not only each case', async t => {
  let hold = false;
  const f = await fixture(t, { held: () => hold, provider: replayProvider({ onRequest: async (_input, count) => { if (count === 1) hold = true; } }) });
  await f.replay.start({ approved: true });
  const done = await settled(f.replay);
  assert.equal(f.provider.seen.length, 1, 'only the first request of the first case went out'); assert.equal(done.phase, 'maintenance_stop'); assert.equal(done.stopReason, 'maintenance');
  const [first] = done.cases.filter(row => row.status !== 'not_replayable' && row.runs && Object.keys(row.runs).length);
  assert.deepEqual(Object.values(first.runs).map(run => [run.condition, run.status]).sort(), [['v1', 'completed'], ['v2', 'not_run']].sort());
  assert.equal(Object.values(first.runs).find(run => run.status === 'not_run').reason, 'maintenance');
  assert.deepEqual(f.store.state.realUsage.reservations, {}); assert.equal(done.summary.pass, false);
});

test('a key the model echoes into its proposed task or its quoted basis is redacted from the job, its status and the reports on disk', async t => {
  const key = 'fixture-only-not-a-key';
  const f = await fixture(t, { provider: replayProvider({ leak: key }) });
  await f.replay.start({ approved: true });
  const done = await settled(f.replay), runs = done.cases.flatMap(row => Object.values(row.runs ?? {})).filter(run => run.write);
  assert.ok(runs.length >= 5, 'foreground and planner writes were read');
  for (const run of runs) assert.ok(run.proposedTask.includes('[REDACTED]') && !run.proposedTask.includes(key), run.condition);
  assert.ok(runs.some(run => run.basis?.includes('[REDACTED]')) && runs.every(run => !run.basis?.includes(key)), 'the quoted basis too');
  const files = readdirSync(f.replay.reportDir()).filter(name => name.startsWith('schedtext-'));
  assert.equal(files.length, 2);
  for (const name of files) assert.ok(!readFileSync(join(f.replay.reportDir(), name), 'utf8').includes(key), name);
  assert.ok(!JSON.stringify(f.replay.status()).includes(key)); assert.ok(!f.replay.report(done.id).markdown.includes(key));
});

test('skips with a reason: model or key gone, conversation deleted, no published prefix, a prompt without the schedule paragraph; a failed or cut request is not a result', async t => {
  const skipped = async (setup, options = {}) => { const f = await fixture(t, options); await setup(f); await f.replay.start({ approved: true, planner: 0 }); const done = await settled(f.replay); return { f, done, by: Object.fromEntries(done.cases.filter(row => row.kind === 'foreground').map(row => [row.rev, row])) }; };
  const gone = await skipped(f => { f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).deletedAt = undefined; state.sessionDeletions = [{ sessionId: f.session.id, status: 'running' }]; }); });
  assert.ok(Object.values(gone.by).filter(row => row.status !== 'not_replayable').every(row => row.status === 'skipped' && row.reason === 'session_deleted')); assert.equal(gone.f.provider.seen.length, 0);
  const noPrefix = await skipped(() => {}, { prefix: null });
  assert.ok([10, 16, 17].every(rev => noPrefix.by[rev].reason === 'prefix_unavailable')); assert.equal(noPrefix.f.provider.seen.length, 0);
  const unknown = await skipped(() => {}, { prefix: { ...PREFIX, systemPrompt: 'A prompt that does not carry the schedule paragraph.' } });
  assert.ok([10, 16, 17].every(rev => unknown.by[rev].reason === 'schedule_paragraph_missing')); assert.equal(unknown.f.provider.seen.length, 0);
  // The model a turn ran on no longer configured: the project's current model stands in (both versions on the same one, flagged); no key: nothing is sent.
  const renamed = await skipped(f => { f.store.mutate(state => { const provider = state.configuration.providers.find(row => row.id === f.glm.id); provider.models = provider.models.map(row => ({ ...row, id: 'renamed' })); state.configuration.defaultModel = { providerId: f.glm.id, modelId: 'renamed', reasoning: 'high' }; }); });
  assert.ok([10, 16, 17].every(rev => renamed.by[rev].status === 'ran' && renamed.by[rev].model.substituted === true && renamed.by[rev].model.modelId === 'renamed')); assert.ok(renamed.f.provider.seen.every(row => row.model.modelId === 'renamed'));
  const noKey = await skipped(f => { f.store.configurationService.provider(f.glm.id, { apiKey: '' }); });
  assert.ok([10, 16, 17].every(rev => noKey.by[rev].reason === 'key_missing')); assert.equal(noKey.f.provider.seen.length, 0);
  // A provider failure and a reply cut at its allowance are recorded as such and never as a result.
  const failing = await skipped(() => {}, { provider: { seen: [], provider: async function* () { throw Object.assign(new Error('upstream'), { code: 'upstream_error' }); } } });
  assert.ok([10, 16, 17].every(rev => failing.by[rev].runs.v1.status === 'failed' && failing.by[rev].runs.v1.code === 'upstream_error' && failing.by[rev].runs.v1.write === undefined));
  assert.ok(failing.done.summary.reasons.includes('rev_10_not_run')); assert.ok(failing.done.spentTokens > 0, 'a request that went out and reported nothing is charged its worst case');
  const cut = await skipped(() => {}, { provider: { seen: [], provider: async function* () { yield { type: 'text_delta', delta: 'I will' }; yield { type: 'usage', usage: { input: 10, output: 4000, totalTokens: 4010 } }; yield { type: 'done', stopReason: 'length' }; } } });
  assert.ok([10, 16, 17].every(rev => cut.by[rev].runs.v2.status === 'length'));
});

test('one request per case and version: a second call of the stream (a repair, a retry) is refused', async t => {
  const f = await fixture(t, { provider: { seen: [], provider: async function* () { yield { type: 'done', stopReason: 'stop' }; } } });
  f.replay.job = { id: 'schedtext-x' };
  const { stream } = f.replay.observe(), input = { model: {}, messages: [], tools: [], systemPrompt: '', cache: {}, estimatedInputTokens: 1, signal: new AbortController().signal };
  for await (const _ of stream(input)); // the first call goes to the (fake) provider
  await assert.rejects(async () => { for await (const _ of stream(input)); }, { code: 'replay_single_request' });
});

// ------------------------------------------------------------------------------------------------ reports and conversations
test('a conversation deleted takes the reports that replayed it; the sweep drops those of conversations that are gone', async t => {
  const f = await fixture(t);
  await f.replay.start({ approved: true }); const done = await settled(f.replay);
  const root = scheduleReplayRoot(f.store.file), names = (await readdir(root)).sort();
  assert.ok(names.includes(`${done.id}.json`) && names.includes(`${done.id}.md`) && names.includes('spend.json'));
  await writeFile(join(root, 'schedtext-other.json'), JSON.stringify({ id: 'schedtext-other', cases: [{ sessionIds: ['someone-else'] }] })); await writeFile(join(root, 'schedtext-other.md'), '# other');
  assert.equal(purgeScheduleReplayReports(f.store.file, 'someone-else'), 1); assert.equal(existsSync(join(root, 'schedtext-other.json')), false); assert.equal(existsSync(join(root, 'schedtext-other.md')), false);
  assert.equal(pruneScheduleReplayReports(f.store.file, { state: f.store.state }), 0, 'the conversation is live');
  assert.equal(purgeScheduleReplayReports(f.store.file, f.session.id), 1);
  assert.deepEqual((await readdir(root)).sort(), ['spend.json'], 'the spend record stays: what was spent stays spent');
  assert.equal(f.replay.approval().spent, done.spentTokens);
  assert.equal(purgeScheduleReplayReports(f.store.file, ''), 0); assert.equal(purgeScheduleReplayReports(join(f.dir, 'nowhere.json'), 'x'), 0);
  // A report of a conversation no longer in state is swept; a corrupted one goes too.
  await writeFile(join(root, 'schedtext-gone.json'), JSON.stringify({ id: 'schedtext-gone', cases: [{ sessionIds: ['deleted-session'] }] })); await writeFile(join(root, 'schedtext-bad.json'), '{ not json');
  assert.equal(pruneScheduleReplayReports(f.store.file, { state: f.store.state }), 2); assert.deepEqual((await readdir(root)).sort(), ['spend.json']);
});

test('a report of a run its daemon lost is read as interrupted', async t => {
  const f = await fixture(t);
  const root = scheduleReplayRoot(f.store.file); mkdirSync(root, { recursive: true });
  const job = { id: 'schedtext-lost', phase: 'running', done: 1, calls: 10, spentTokens: 900, budgetTokens: 5000, estimate: 4000, cases: [] };
  writeFileSync(join(root, 'schedtext-lost.json'), JSON.stringify(job)); writeFileSync(join(root, 'schedtext-lost.md'), replayMarkdown(job));
  assert.equal(f.replay.report('schedtext-lost').json.phase, 'interrupted'); assert.match(f.replay.report('schedtext-lost').markdown, /Phase \*\*interrupted\*\*/);
  assert.throws(() => f.replay.report('schedtext-missing'), { code: 'replay_report_missing', status: 404 }); assert.throws(() => f.replay.report('../x'), { status: 400 });
  assert.deepEqual(f.replay.reports(), ['schedtext-lost']);
});

// ------------------------------------------------------------------------------------------------ the daemon routes and the CLI
test('daemon routes and the CLI: version, dry-run plan, refusal without approval, status, cancel while maintenance holds', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-schedule-routes-')), stateFile = join(dir, 'state.json');
  const app = createServer({ stateFile, ticks: false, runtime: false, initiative: false }); await app.initializer.close();
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const call = async (path, method = 'GET', data) => { const response = await fetch(`${base}${path}`, { method, headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined }); const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status, code: result.code }); return result; };
  const status = await call('/v2/maintenance/schedule-text-replay');
  assert.equal(status.running, false); assert.equal(status.plan.selected, 0); assert.equal(status.plan.options.budgetTokens, SCHEDULE_REPLAY_BUDGET_TOKENS); assert.equal(status.approval.remaining, SCHEDULE_REPLAY_BUDGET_TOKENS);
  await assert.rejects(call('/v2/maintenance/schedule-text-replay', 'POST', {}), error => error.status === 400 && error.code === 'replay_not_approved');
  await assert.rejects(call('/v2/maintenance/schedule-text-replay', 'POST', { approved: true }), error => error.status === 409 && error.code === 'replay_no_cases');
  await assert.rejects(call('/v2/maintenance/schedule-text-replay/reports/nothing'), error => error.status === 404);
  assert.deepEqual(await call('/v2/maintenance/schedule-text-replay/cancel', 'POST', {}), { cancelled: false });
  assert.equal((await call('/configuration')).schedulePromptVersion, 'v1');
  const logs = [];
  assert.deepEqual(await runScheduleTextCommand(['version'], call), { schedulePromptVersion: 'v1' });
  assert.deepEqual(await runScheduleTextCommand(['version', 'v2'], call), { schedulePromptVersion: 'v2' }); assert.equal(app.store.state.configuration.schedulePromptVersion, 'v2');
  assert.deepEqual((await runScheduleTextCommand(['status'], call)).schedulePromptVersion, 'v2');
  assert.deepEqual(await runScheduleTextCommand(['version', 'v1'], call), { schedulePromptVersion: 'v1' });
  await assert.rejects(runScheduleTextCommand(['version', 'v3'], call), /schedule-text version/); await assert.rejects(call('/configuration', 'PATCH', { schedulePromptVersion: 'v3' }), error => error.status === 400);
  const dry = await runScheduleTextCommand(['replay'], call, { log: line => logs.push(line) });
  assert.equal(dry.approved, false); assert.match(logs[0], /回放计划：0 个案例/); assert.match(logs[0], /剩余 1000000/); assert.match(dry.note, /--approved/);
  await assert.rejects(runScheduleTextCommand(['replay', '--approve-more', '5'], call), /--approve-more/); await assert.rejects(runScheduleTextCommand(['replay', '--foreground'], call), /需要一个值/); await assert.rejects(runScheduleTextCommand(['replay', '--foreground', 'x'], call), /必须是整数/);
  await assert.rejects(runScheduleTextCommand(['replay', '--nope'], call), /schedule-text status/); await assert.rejects(runScheduleTextCommand(['frobnicate'], call), /schedule-text status/);
  // While maintenance holds new work a replay is not admitted, but stopping one still is.
  persistMaintenance(stateFile, initialMaintenance('backup', {}, randomUUID(), {})); app.maintenanceGate.refresh();
  assert.equal(app.maintenanceGate.held, true);
  assert.deepEqual(await call('/v2/maintenance/schedule-text-replay/cancel', 'POST', {}), { cancelled: false });
});

test('`rna schedule-text replay` follows a started job to its report, and ends cleanly when the daemon lost it', async () => {
  const id = 'schedtext-2026-10-05T00-00-00-000Z-abcdef12';
  const plan = { selected: 5, calls: 10, estimate: 900000, required: { cases: [10, 16, 17], estimate: 1450000, covered: false, missing: [12] }, options: { budgetTokens: SCHEDULE_REPLAY_BUDGET_TOKENS }, approval: { approved: SCHEDULE_REPLAY_BUDGET_TOKENS, spent: 0, remaining: SCHEDULE_REPLAY_BUDGET_TOKENS }, cases: [{ id: 'fg-r10', rev: 10, label: 'durable', status: 'selected', estimate: 180000 }, { id: 'pl-r11', rev: 11, label: 'mechanical', status: 'not_replayable', reason: 'not_in_state' }, { id: 'pl-r3', rev: 3, label: 'one_off', status: 'deferred', estimate: 90000 }] };
  const summary = { pass: false, safe: false, effectDemonstrated: null, complete: false, reasons: ['rev_12_not_run'], durable: { required: 6, tested: 1, written: 1, kept: 1 }, oneOff: { tested: 0, v1Wrote: 0, v2Wrote: 0 }, mechanical: { tested: 0, v1Wrote: 0, v2Wrote: 0 } };
  // The route without a query is the status poll while a run is in progress, and the plan otherwise (as the daemon answers).
  const daemon = ({ reports }) => { let started = false; return async (path, method = 'GET') => {
    if (path.startsWith('/v2/maintenance/schedule-text-replay?')) return { plan };
    if (path === '/v2/maintenance/schedule-text-replay' && method === 'GET') return started ? { running: false, job: null, reports, plan: null } : { running: false, job: null, reports, plan };
    if (path === '/v2/maintenance/schedule-text-replay' && method === 'POST') { started = true; return { id, phase: 'running', done: 0, calls: 10, spentTokens: 0 }; }
    if (path.startsWith('/v2/maintenance/schedule-text-replay/reports/')) return { id, json: { id, phase: 'interrupted', done: 4, calls: 10, spentTokens: 900, summary }, markdown: '# report' };
    throw new Error(`unexpected ${method} ${path}`);
  }; };
  const logs = []; let polls = 0;
  const done = await runScheduleTextCommand(['replay', '--approved', '--foreground', '1'], daemon({ reports: [id] }), { wait: async () => { polls++; }, log: line => logs.push(line) });
  assert.deepEqual([done.phase, done.spentTokens, done.markdown, polls], ['interrupted', 900, '# report', 1]); assert.deepEqual(done.gate.reasons, ['rev_12_not_run']); assert.equal(done.gate.pass, false);
  assert.deepEqual([done.gate.safe, done.gate.effectDemonstrated], [false, null], 'the command reports whether the new text was shown to prevent anything, and whether the run was safe');
  assert.match(logs.join('\n'), /5 个案例，每个在 v1 与 v2 两套文本下各发 1 次请求，共 10 次主模型请求，估算 900000/); assert.match(logs.join('\n'), /fg-r10\s+rev 10 durable\s+回放，估算 180000/); assert.match(logs.join('\n'), /无法回放：not_in_state/); assert.match(logs.join('\n'), /暂缓（预算放不下/);
  assert.match(logs.join('\n'), /必需案例（持久要求与一次性）3 个，估算共 1450000 token：本计划没有全部覆盖，门槛不会通过/); assert.match(logs.join('\n'), /找不到必需案例的记录：rev 12/);
  polls = 0;
  await assert.rejects(runScheduleTextCommand(['replay', '--approved'], daemon({ reports: [] }), { wait: async () => { polls++; }, log: () => {} }), new RegExp(id));
  assert.equal(polls, 4, 'bounded');
  await assert.rejects(runScheduleTextCommand(['replay'], async () => ({ running: true, job: { id }, plan: null }), { log: () => {} }), /已有回放在运行/);
  const out = await runScheduleTextCommand(['replay', '--approved', '--no-wait'], daemon({ reports: [] }), { log: () => {} }); assert.deepEqual(out, { started: id });
});
