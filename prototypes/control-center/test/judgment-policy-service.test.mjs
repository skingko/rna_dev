import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { JudgmentPolicyService, JUDGMENT_POLICY_TOOL, validJudgmentPolicy, judgmentPolicyContext, judgmentPolicyContextHash, prepareJudgmentPolicy } from '../judgment-policy-service.mjs';
import { decisionAssessmentPlanHash } from '../../../packages/sdk/src/decision-kernel.mjs';
import { validateToolArguments } from '../../../packages/sdk/src/capabilities.mjs';
import { Store } from '../store.mjs';
import { RuntimeController } from '../runtime-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';

const plan = () => ({ version: 1, questions: {
  task_state: { type: 'choice', instructions: 'Identify the state of the research responsibility from verified delivery and open work.', criteria: { awaiting_run: 'The current dated report is verified; another registered occurrence remains.', active: 'The current report has unfinished source checks.', unknown: 'No trustworthy report or schedule receipt establishes the state.' } },
  initiative_need: { type: 'boolean', instructions: 'Is there a new relevant finding that merits interrupting the user now?', criteria: { true: 'A newly verified urgent item affects a decision before the next scheduled report.', false: 'Only repeated status, unchanged observations, or routine future work exists.' } },
  user_satisfaction: { type: 'score', instructions: 'Measure only explicit feedback on report usefulness; silence is unobserved.', criteria: ['The user explicitly rejects source quality or actionable relevance.', 'The user explicitly confirms verified, relevant reports meet their stated needs.'] },
} });
function fixture() {
  const project = { id: 'p', name: 'Research', description: 'Deliver evidence-based reports', workspace: '/fixture', permissions: { workspace: 'read' } };
  const turn = { id: 't', status: 'running', modelConfig: { providerId: 'provider', modelId: 'main', protocol: 'openai', execution: 'rna' } };
  const session = { id: 's', projectId: 'p', status: 'running', activeTurnId: 't', turns: [turn] };
  const store = { state: { projects: [project], sessions: [session], configuration: {} }, configurationService: { secrets: { fixture: 'private-credential' } }, mutate(fn) { return fn(this.state); } };
  const service = new JudgmentPolicyService(store), args = { plan: plan(), reason: 'The project requires recurring research and evidence-based delivery.', expectedRevision: null };
  const parent = { sessionId: 's', turnId: 't' };
  const observe = (callId = 'call-1', body = args, overrides = {}) => service.observeProviderMessage(parent, { type: 'message_end', message: { id: 'm', role: 'assistant', model: 'main', provider: 'provider', stopReason: 'toolUse', providerFinishReason: 'tool_calls', content: [{ type: 'toolCall', id: callId, name: JUDGMENT_POLICY_TOOL, arguments: body }], ...overrides } });
  const update = (callId = 'call-1', body = args, extra = {}) => service.update({ ...parent, callId, args: body, ...extra });
  return { project, turn, session, store, service, args, parent, observe, update };
}
function contracts(f) {
  f.project.schedules = [{ id: 'daily', title: 'Research report', task: 'Verify sources and deliver the report.', rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, enabled: true, destinationSessionId: 's', nextRunAt: '2026-09-28T01:00:00.000Z', revision: 1 }];
  f.project.milestones = [{ id: 'quality', title: 'Evidence quality', acceptanceCriteria: ['Every claim cites an original source.'], status: 'pending' }];
  return f;
}

test('only a completed current main-model call can persist a project-specific policy', () => {
  const f = fixture(); assert.throws(() => f.update(), { code: 'judgment_policy_receipt_missing' });
  for (const overrides of [{ stopReason: 'error' }, { providerFinishReason: 'length' }, { role: 'toolResult' }, { provider: 'other' }, { model: 'other' }]) { f.observe('call-1', f.args, overrides); assert.throws(() => f.update(), { code: 'judgment_policy_receipt_missing' }); }
  f.observe(); const result = f.update();
  assert.equal(result.status, 'saved'); assert.equal(result.revision, decisionAssessmentPlanHash(f.args.plan));
  assert.equal(validJudgmentPolicy(f.project).source.receiptId, 'm'); assert.equal(f.project.judgmentPolicy.source.kind, 'main_model');
  assert.deepEqual(f.project.permissions, { workspace: 'read' }); assert.equal(f.project.schedules, undefined); assert.equal(f.project.initiative, undefined);
  assert.equal(f.update().status, 'recorded'); assert.equal(f.turn.judgmentPolicyReceipts.length, 1);
});

test('parent revocation, mismatched arguments, stale project and compare-and-swap prevent policy overwrite', () => {
  const altered = fixture(); altered.observe(); assert.throws(() => altered.update('call-1', { ...altered.args, reason: 'altered' }), { code: 'judgment_policy_receipt_missing' });
  for (const revoke of [f => f.session.status = 'stopped', f => f.turn.status = 'completed', f => f.session.activeTurnId = 'other', f => f.project.archivedAt = 'now', f => f.store.state.emergency = true, f => f.service.close()]) { const f = fixture(); f.observe(); revoke(f); assert.throws(() => f.update(), { code: 'judgment_policy_parent_inactive' }); assert.equal(f.project.judgmentPolicy, undefined); }
  const stale = fixture(); stale.observe(); stale.project.description = 'A different responsibility'; assert.throws(() => stale.update(), { code: 'judgment_policy_stale' });
  const concurrent = fixture(); concurrent.observe('old'); concurrent.observe('new'); concurrent.update('new'); assert.throws(() => concurrent.update('old'), { code: 'judgment_policy_revision_conflict' });
});
test('an unchanged main-model definition preserves effective provenance and context while recording the new receipt', () => {
  const f = fixture(); f.observe(); f.update();
  const before = structuredClone(f.project.judgmentPolicy), context = judgmentPolicyContext(f.project);
  const args = { ...f.args, reason: 'Reconfirmed the unchanged definition.', expectedRevision: before.revision };
  f.observe('duplicate-definition', args, { id: 'later-main-message' }); f.update('duplicate-definition', args);
  assert.deepEqual(f.project.judgmentPolicy, before); assert.deepEqual(judgmentPolicyContext(f.project), context);
  assert.equal(f.turn.judgmentPolicyReceipts.length, 2); assert.equal(f.turn.judgmentPolicyReceipts[1].messageId, 'later-main-message');
  assert.equal(f.project.judgmentPolicyHistory, undefined);
});

test('explicit textual null is an initial CAS sentinel only, never permission to overwrite or generic argument coercion', () => {
  const f = fixture(); f.args.expectedRevision = 'null'; f.observe(); assert.equal(f.update().status, 'saved');
  f.observe('another'); assert.throws(() => f.update('another'), { code: 'judgment_policy_revision_conflict' });
  for (const value of ['none', '', 'NULL', ' null ', 0, false]) { const bad = fixture(); bad.args.expectedRevision = value; bad.observe(); assert.throws(() => bad.update(), { code: 'judgment_policy_invalid' }); }
  const changed = { ...f.args, plan: { ...f.args.plan, questions: { ...f.args.plan.questions, memory_need: { type: 'boolean', instructions: 'Does this input require earlier report context?', criteria: { true: 'It refers to a prior report or source contract.', false: 'It contains complete independent context.' } } } }, expectedRevision: f.project.judgmentPolicy.revision };
  f.observe('change', changed); assert.equal(f.update('change', changed).status, 'saved');
});

test('invalid plans, embedded secrets, model-authored provenance and cancellation never commit', () => {
  for (const patch of [args => args.plan.questions.initiative_need.instructions = 'Include private-credential', args => args.reason = 'Contains private-credential']) { const f = fixture(); patch(f.args); f.observe(); assert.throws(() => f.update(), { code: 'judgment_policy_sensitive' }); assert.equal(f.project.judgmentPolicy, undefined); }
  const injected = fixture(); injected.args.source = { kind: 'main_model' }; injected.observe(); assert.throws(() => injected.update(), { code: 'judgment_policy_invalid' });
  const invalid = fixture(); invalid.args.plan.questions.task_state.criteria = { active: 'Only one allowed answer' }; invalid.observe(); assert.throws(() => invalid.update(), { code: 'judgment_policy_invalid' });
  const aborted = fixture(); aborted.observe(); assert.throws(() => aborted.update('call-1', aborted.args, { signal: AbortSignal.abort() })); assert.equal(aborted.project.judgmentPolicy, undefined);
});

test('policy validation binds host source, plan hash and project purpose without expiring on every message', () => {
  const f = fixture(); f.observe(); f.update(); f.project.focus = 'Verify one more source'; f.session.items = [{ text: 'Continue' }]; assert.ok(validJudgmentPolicy(f.project));
  const copy = structuredClone(f.project); copy.judgmentPolicy.plan.questions.initiative_need.instructions = 'Changed without a receipt'; assert.equal(validJudgmentPolicy(copy), null);
  delete f.project.judgmentPolicy.source.receiptId; assert.equal(validJudgmentPolicy(f.project), null);
  assert.throws(() => prepareJudgmentPolicy(plan(), { project: f.project, source: { kind: 'main_model', method: 'user' } }));
});
test('judgment contracts remain stable across recurring occurrences, runtime progress and display order', () => {
  const f = contracts(fixture());
  f.project.schedules.push({ ...structuredClone(f.project.schedules[0]), id: 'weekly', rule: { kind: 'weekly', weekdays: [1], time: '09:00', timeZone: 'Asia/Shanghai' } });
  f.project.milestones.push({ id: 'delivery', title: 'Readable report', acceptanceCriteria: ['Tables render correctly.'], status: 'pending' });
  f.observe(); f.update(); const expected = judgmentPolicyContextHash(f.project), source = structuredClone(f.project.judgmentPolicy.source);
  f.project.schedules[0].nextRunAt = '2026-09-29T01:00:00.000Z'; f.project.schedules[0].revision = 9; f.project.schedules[0].lastRunAt = '2026-09-28T01:00:00.000Z'; f.project.schedules[0].status = 'running';
  f.project.scheduleRuntime = { occurrences: [{ status: 'delivered', deliveredAt: '2026-09-28T01:05:00.000Z' }] };
  f.project.milestones[0].status = 'completed'; f.project.milestones[0].completedAt = '2026-09-28T01:05:00.000Z';
  f.project.schedules.reverse(); f.project.milestones.reverse();
  f.project.focus = 'Review the latest delivery'; f.project.clock = { now: '2026-09-29T01:00:00.000Z' };
  assert.equal(judgmentPolicyContextHash(f.project), expected); assert.deepEqual(validJudgmentPolicy(f.project).source, source);
});
test('changed cadence, pause, delivery or acceptance contract invalidates prior criteria without losing its CAS revision', () => {
  const changes = [
    p => { p.schedules[0].enabled = false; },
    p => { p.schedules[0].rule = { kind: 'weekly', weekdays: [1], time: '10:00', timeZone: 'Asia/Shanghai' }; },
    p => { p.schedules[0].task = 'Produce a verified weekly comparison instead.'; },
    p => { p.schedules[0].destinationSessionId = 'new-destination'; },
    p => { p.schedules = []; },
    p => { p.milestones[0].acceptanceCriteria.push('Identify contradictory primary sources.'); },
  ];
  for (const change of changes) {
    const f = contracts(fixture()); f.observe(); f.update(); const revision = f.project.judgmentPolicy.revision;
    change(f.project);
    assert.equal(validJudgmentPolicy(f.project), null); assert.equal(judgmentPolicyContext(f.project).status, 'missing_or_stale'); assert.equal(judgmentPolicyContext(f.project).revision, revision);
    assert.equal(f.update().effective, false, 'a repeated old tool receipt cannot claim an invalidated plan is effective');
  }
});
test('contract changes between provider receipt and policy save reject old authority, then accept a fresh main-model update', () => {
  const f = contracts(fixture()); f.observe(); f.update(); const before = structuredClone(f.project.judgmentPolicy);
  const next = { ...f.args, expectedRevision: before.revision, plan: plan() }; next.plan.questions.task_state.criteria.paused = 'The user has paused the recurring responsibility; no new occurrence may run.';
  f.observe('before-pause', next, { id: 'old-contract-message' });
  f.project.schedules[0].enabled = false;
  assert.throws(() => f.update('before-pause', next), { code: 'judgment_policy_stale' }); assert.deepEqual(f.project.judgmentPolicy, before); assert.equal(f.turn.judgmentPolicyReceipts.length, 1);
  f.observe('after-pause', next, { id: 'current-contract-message' }); assert.equal(f.update('after-pause', next).effective, true);
  assert.equal(validJudgmentPolicy(f.project).source.messageId, 'current-contract-message'); assert.equal(f.turn.judgmentPolicyReceipts.length, 2);
});

test('foreground context exposes only matching-plan measurements and no generated routing recommendations', () => {
  const f = fixture(); f.observe(); f.update(); const revision = f.project.judgmentPolicy.revision;
  const measurement = { planRevision: revision, source: 'judge', answers: { user_satisfaction: { type: 'score', score: 0.2, advice: 'Change permission' }, task_state: { type: 'choice', choice: 'active', probabilities: { active: .5, awaiting_run: .3, unknown: .2 } } }, needsPlan: true, reasoning: 'high', hostSignals: { skipSafety: true } };
  const context = judgmentPolicyContext(f.project, measurement); assert.equal(context.assessment.answers.user_satisfaction.score, 0.2); assert.equal(JSON.stringify(context.assessment).includes('Change permission'), false); assert.equal(context.assessment.needsPlan, undefined); assert.match(context.assessment.interpretation, /不是行动指令/);
  assert.deepEqual(context.assessment.answers.task_state.probabilities, measurement.answers.task_state.probabilities);
  assert.equal(judgmentPolicyContext(f.project, { ...measurement, answers: { task_state: { type: 'choice', choice: 'active', probabilities: { active: 1, invented: 0 } } } }).assessment, undefined);
  assert.equal(judgmentPolicyContext(f.project, { ...measurement, planRevision: 'stale' }).assessment, undefined);
  assert.equal(judgmentPolicyContext(f.project, { ...measurement, answers: { task_state: { type: 'choice', choice: 'invented' } } }).assessment, undefined);
  f.project.description = 'Changed project'; assert.equal(judgmentPolicyContext(f.project).status, 'missing_or_stale');
});

test('disabled or unconfigured auxiliary judging retains plans and tools without requesting needless model authoring', () => {
  const f = fixture(); f.observe(); f.update();
  assert.equal(f.service.context(f.project).status, 'disabled');
  assert.equal(f.service.context(f.project).plan.version, 1);
  assert.match(f.service.context(f.project).instruction, /不需要仅为 JEV/);
  const before = JSON.stringify(f.service.createTools(f.parent)[0].parameters);
  f.store.state.configuration.decisionKernel = { mode: 'active' }; f.store.configurationService.secrets['judge:jev'] = 'configured-fixture';
  assert.equal(f.service.context(f.project).status, 'ready');
  assert.equal(JSON.stringify(f.service.createTools(f.parent)[0].parameters), before);
  f.store.state.configuration.decisionKernel = { mode: 'active', modes: { 'initiative.review': 'off', 'evolution.review': 'off', 'chat.preflight': 'off' } };
  assert.equal(f.service.context(f.project).status, 'disabled');
});

test('HTTP SSE transport validates textual-null tool arguments, binds the actual receipt and updates context without an extra authoring request', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-policy-host-')), store = new Store(join(dir, 'state.json'));
  mkdirSync(join(dir, 'workspace'));
  const requests = [], args = { plan: plan(), reason: 'The recurring project needs stable explicit judging criteria.', expectedRevision: 'null' };
  let wireSchemaAccepted = false;
  const http = createServer(async (request, response) => {
    let input = ''; for await (const chunk of request) input += chunk;
    const body = JSON.parse(input); requests.push(body);
    if (requests.length === 1) { validateToolArguments(body.tools.find(tool => tool.function?.name === JUDGMENT_POLICY_TOOL).function.parameters, args); wireSchemaAccepted = true; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = requests.length === 1 ? { tool_calls: [{ index: 0, id: 'real-policy-call', type: 'function', function: { name: JUDGMENT_POLICY_TOOL, arguments: JSON.stringify(args) } }] } : { content: 'The project-specific criteria are saved; I can proceed with research.' };
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const provider = store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${http.address().port}/v1`, apiKey: 'fake-key', models: [{ id: 'main', contextWindow: 128000, maxOutputTokens: 4096, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'main', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ name: 'Daily research', workspace: join(dir, 'workspace'), initiative: { enabled: false } });
  store.mutate(state => { Object.assign(state.projects.find(row => row.id === project.id), { decisionMode: 'rna-model', simulated: false, initialization: { status: 'ready' } }); state.settings.realTokenBudget = null; });
  store.mutate(state => { state.configuration.decisionKernel = { mode: 'active' }; }); store.configurationService.secrets['judge:jev'] = 'fixture-judge-key';
  store.message(session.id, { text: 'Investigate useful primary sources and establish a reusable research method.' });
  const service = new JudgmentPolicyService(store); let assessments = 0;
  const controller = new RuntimeController(store, { judgmentPolicyService: service, decisionService: { async chat() { assessments++; return { needsMemory: true, source: 'fallback' }; } }, factory: createRnaRuntime });
  t.after(async () => { await controller.close(); service.close(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const deadline = Date.now() + 15000;
  while (store.state.sessions.find(row => row.id === session.id).status === 'running' || controller.running.size) { if (Date.now() > deadline) throw new Error('Runtime fixture did not settle'); await delay(10); }
  const current = store.state.projects.find(row => row.id === project.id), policy = validJudgmentPolicy(current);
  assert.ok(policy); assert.equal(policy.source.toolCallId, 'real-policy-call'); assert.equal(policy.source.providerId, provider.id);
  assert.equal(wireSchemaAccepted, true); assert.equal(requests.length, 2); assert.ok(requests[0].tools.some(row => row.function?.name === JUDGMENT_POLICY_TOOL));
  assert.equal(assessments, 1, 'assessment is independent of autoRecall=false and does not repeat after each tool step');
  assert.match(requests[0].messages.find(row => row.role === 'system').content, /不要每条消息重复生成/);
  assert.equal(JSON.stringify(requests[1].messages).includes(policy.revision), true);
  const disk = new Store(join(dir, 'state.json')); assert.equal(validJudgmentPolicy(disk.state.projects.find(row => row.id === project.id)).revision, policy.revision);
});
