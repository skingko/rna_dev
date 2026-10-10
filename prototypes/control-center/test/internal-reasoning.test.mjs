import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { internalReasoningPlan, effortForDepth, defaultUsable, internalReasoningSetting, internalReasoningInput, decisionEffortInput, narratorEffortInput, workEffortInput, compactionEffortInput, reasoningFor, EffortCapture, purgeEffortCaptures, pruneEffortCaptures, captureEnabled, captureRoot, SHADOW_ONLY_PURPOSES, ROUTABLE_PURPOSES, resumedReasoning, sessionsLive, liveModel, CAPTURE_RETENTION_MS } from '../internal-reasoning.mjs';
import { providerPreset } from '../provider-presets.mjs';
import { resolveReasoningCapability } from '../reasoning-capability.mjs';
import { removeProjectFiles, sweepProjectFiles } from '../project-files.mjs';
import { CHECKPOINT_SIDECARS } from '../state-checkpoint.mjs';
import { DecisionService } from '../decision-service.mjs';

// spec p1 effort §2 / §3.1: what an internal call sends, per provider and chat selection (the §2 table).
const preset = (id, modelId) => { const provider = providerPreset(id), model = provider.models.find(row => row.id === modelId); return { provider, model }; };
const modelOf = ({ provider, model }, selection) => { const capability = resolveReasoningCapability(provider, model); return { providerId: provider.id, modelId: model.id, reasoningCapability: capability, reasoningSelection: selection, reasoning: selection === 'auto' ? 'default' : selection }; };
const glm = (selection = 'max') => modelOf(preset('glm-coding', 'glm-5.3'), selection);
const codex = { providerId: 'codex', modelId: 'gpt-6-astra', reasoningCapability: { control: 'effort', efforts: ['low', 'medium', 'high', 'xhigh'].map(id => ({ id })), providerDefault: 'medium', canDisable: false }, reasoningSelection: 'high', reasoning: 'high' };

test('the plan per provider: provider default where it adapts, a JEV route where the default is the top or unknown', () => {
  assert.deepEqual(internalReasoningPlan(glm('max')), { mode: 'route', allowed: ['low', 'high', 'max'], fallback: 'max', ceiling: 'max' });
  assert.deepEqual(internalReasoningPlan(glm('auto')), { mode: 'route', allowed: ['low', 'high', 'max'], fallback: 'default', ceiling: 'max' }, 'auto on GLM: default is max, routed with the default as fallback');
  assert.deepEqual(internalReasoningPlan(glm('high')), { mode: 'route', allowed: ['low', 'high'], fallback: 'high', ceiling: 'high' }, 'never above the chat level');
  assert.deepEqual(internalReasoningPlan(glm('low')), { mode: 'fixed', effort: 'low', source: 'chat-ceiling' });
  assert.deepEqual(internalReasoningPlan(modelOf(preset('deepseek', 'deepseek-v4-pro'), 'max')), { mode: 'fixed', effort: 'default', source: 'provider-default' });
  assert.deepEqual(internalReasoningPlan(modelOf(preset('deepseek', 'deepseek-v4-pro'), 'off')), { mode: 'fixed', effort: 'off', source: 'chat-off' });
  assert.deepEqual(internalReasoningPlan(modelOf(preset('anthropic', 'claude-opus-5-5'), 'max')), { mode: 'fixed', effort: 'default', source: 'provider-default' });
  assert.deepEqual(internalReasoningPlan(modelOf(preset('anthropic', 'claude-opus-5-5'), 'low')), { mode: 'fixed', effort: 'low', source: 'chat-ceiling' }, 'Opus defaults to medium, above a low chat level');
  assert.deepEqual(internalReasoningPlan(codex), { mode: 'fixed', effort: 'default', source: 'provider-default' });
  assert.deepEqual(internalReasoningPlan(modelOf(preset('openai', 'gpt-5.4'), 'xhigh')), { mode: 'route', allowed: ['low', 'medium', 'high', 'xhigh'], fallback: 'xhigh', ceiling: 'xhigh' });
  assert.deepEqual(internalReasoningPlan(modelOf(preset('anthropic', 'claude-haiku-4-5-20251001'), 'high')), { mode: 'route', allowed: ['low', 'medium', 'high'], fallback: 'high', ceiling: 'high' });
  assert.deepEqual(internalReasoningPlan(modelOf(preset('anthropic', 'claude-haiku-4-5-20251001'), 'auto')), { mode: 'fixed', effort: 'default', source: 'chat-off' }, 'omitted budget thinking is off: nothing heavier is chosen');
  assert.deepEqual(internalReasoningPlan(modelOf(preset('qwen-cn', 'qwen3.8-max'), 'high')), { mode: 'fixed', effort: 'default', source: 'provider-default' });
  assert.deepEqual(internalReasoningPlan(modelOf(preset('openai', 'gpt-4.1-mini'), 'auto')), { mode: 'fixed', effort: 'default', source: 'no-levels' });
  assert.deepEqual(internalReasoningPlan(glm('max'), { setting: 'chat' }), { mode: 'fixed', effort: 'max', source: 'setting' });
  assert.deepEqual(internalReasoningPlan(glm('max'), { projectSelection: { providerId: 'g', modelId: 'glm-5.3', reasoning: 'high' } }), { mode: 'fixed', effort: 'high', source: 'project' }, 'an explicit project level is the user\'s choice');
  assert.equal(internalReasoningPlan(glm('max'), { projectSelection: { reasoning: 'auto' } }).mode, 'route');
  assert.equal(defaultUsable({ control: 'adaptive', efforts: [] }), true); assert.equal(defaultUsable({ control: 'effort', efforts: [{ id: 'high' }, { id: 'max' }], providerDefault: 'max' }), false);
  assert.equal(defaultUsable({ control: 'budget', efforts: [{ id: 'low' }] }), false); assert.equal(defaultUsable({ control: 'effort', efforts: [{ id: 'low' }], providerDefault: null, defaultAdaptive: true }), true);
});

test('a depth maps onto the plan: light → lightest, standard → middle (or a lower declared default), deep → the ceiling, unknown → today', () => {
  const route = internalReasoningPlan(glm('max'));
  assert.deepEqual(['light', 'standard', 'deep', null, 'unknown'].map(depth => effortForDepth(depth, route)), ['low', 'high', 'max', 'max', 'max']);
  const gpt = internalReasoningPlan(modelOf(preset('openai', 'gpt-5.4'), 'xhigh'));
  assert.deepEqual(['light', 'standard', 'deep'].map(depth => effortForDepth(depth, gpt)), ['low', 'medium', 'xhigh']);
  assert.deepEqual(['light', 'standard', 'deep'].map(depth => effortForDepth(depth, { mode: 'route', allowed: ['low', 'medium', 'high'], preferred: 'medium', fallback: 'high' })), ['low', 'medium', 'high']);
  assert.equal(effortForDepth('light', { mode: 'fixed', effort: 'default' }), 'default');
});

test('decision facts are code-computed; code settles quiet wakes (light) and pending, failed or planning wakes (deep)', () => {
  const at = 1000, events = [{ id: 'old', type: 'action_completed', summary: 'work completed. done', at: 500 }, { id: 'm1', type: 'user_message', summary: 'Please rewrite chapter 2', at: 1500 }];
  const fresh = decisionEffortInput({ events, lastDecision: { at, action: 'wait', evidenceIds: [] }, project: { actionContracts: {} }, recentActions: [{ status: 'running' }, { status: 'completed' }] });
  assert.deepEqual(fresh.facts, { wakeSources: ['user message'], newEvidence: 'one', pendingRequests: 'none', overdueRequests: 'none', waitingOnUser: 'none', failureToReview: false, planOrOptionsToWrite: false, rhythmToAssess: false, previousProposalNotAdmitted: false, openActions: 'one' });
  assert.equal(fresh.rule, null); assert.deepEqual(fresh.evidence, ['user_message: Please rewrite chapter 2']);
  const quiet = decisionEffortInput({ events, lastDecision: { at: 2000, action: 'wait' }, project: {} });
  assert.equal(quiet.rule, 'light'); assert.deepEqual(quiet.facts.wakeSources, ['none']); assert.equal(quiet.evidence.length, 2, 'a quiet wake shows the newest evidence');
  assert.equal(decisionEffortInput({ events, lastDecision: { at: 2000 }, previousDecision: { action: 'work' } }).rule, null, 'a refused proposal is not a quiet wake');
  assert.equal(decisionEffortInput({ events, lastDecision: { at }, project: {} }, { openWork: { commitments: 1 } }).rule, 'deep');
  assert.equal(decisionEffortInput({ events, lastDecision: { at }, failureReview: true }).rule, 'deep');
  assert.equal(decisionEffortInput({ events, lastDecision: { at }, project: { actionContracts: { judgment: { enabled: true } } } }).rule, 'deep');
  assert.equal(decisionEffortInput({ events, lastDecision: { at }, project: { actionContracts: { rhythm: { enabled: true, requiresAssessment: true } } } }).rule, 'deep');
  assert.equal(decisionEffortInput({ events, lastDecision: { at }, project: { actionContracts: { rhythm: { enabled: true, requiresAssessment: false } } } }).rule, null);
});

test('narrator depth follows the flagged codes; work, setup and compaction facts are words and buckets', () => {
  assert.equal(narratorEffortInput({ text: 'x', violations: [{ code: 'internal_id' }] }).rule, 'light');
  assert.equal(narratorEffortInput({ text: 'x', violations: [{ code: 'internal_id' }, { code: 'result_not_first' }] }).rule, 'standard');
  assert.equal(narratorEffortInput({ text: 'x', violations: [{ code: 'near_duplicate' }, { code: 'describes_instead_of_delivering' }] }).rule, 'deep');
  assert.equal(narratorEffortInput({ text: 'x', violations: [{ code: 'new_code' }] }).rule, null, 'an unknown code goes to JEV');
  assert.deepEqual(narratorEffortInput({ text: 'x', violations: [{ code: 'status_ping' }], scheduled: true, deliverable: 'Daily report' }).facts, { flagged: ['status ping'], scheduled: true, deliverable: 'Daily report' });
  assert.deepEqual(workEffortInput({ task: 't', origin: 'delegated', writable: true }).facts, { origin: 'delegated', scheduled: false, writable: true, isolated: false, resumes: false, earlierAttemptFailed: false, handoffAvailable: false });
  assert.deepEqual(compactionEffortInput({ historyTokens: 90000, toolResults: 3, manual: true }).facts, { historyAmount: 'large', toolResults: 'few', manual: true });
  assert.deepEqual(SHADOW_ONLY_PURPOSES, ['work', 'setup', 'compaction']); assert.deepEqual(ROUTABLE_PURPOSES, ['decision', 'narrator']);
});

test('the setting: defaults with no migration write, strict validation, public view', () => {
  assert.deepEqual(internalReasoningSetting({}), { mode: 'auto', routing: 'shadow', capture: false, purposes: ['decision', 'narrator'] });
  assert.deepEqual(internalReasoningSetting({ internalReasoning: { mode: 'chat', routing: 'route', capture: true } }), { mode: 'chat', routing: 'route', capture: true, purposes: ['decision', 'narrator'] });
  assert.deepEqual(internalReasoningInput({ routing: 'route' }, { mode: 'chat' }), { mode: 'chat', routing: 'route', capture: false, purposes: ['decision', 'narrator'] });
  assert.deepEqual(internalReasoningInput({ routing: 'route', purposes: ['narrator'] }).purposes, ['narrator']);
  assert.deepEqual(internalReasoningSetting({ internalReasoning: { purposes: ['work', 'decision'] } }).purposes, ['decision'], 'a saved purpose that cannot route is dropped');
  for (const bad of [{ mode: 'max' }, { routing: 'on' }, { capture: 'yes' }, { other: 1 }, { purposes: [] }, { purposes: ['work'] }, { purposes: ['decision', 'decision'] }, { purposes: 'decision' }, null, []]) assert.throws(() => internalReasoningInput(bad), { status: 400 });
  const prior = process.env.RNA_EFFORT_PROBE_CAPTURE;
  try {
    delete process.env.RNA_EFFORT_PROBE_CAPTURE; assert.equal(captureEnabled({ internalReasoning: { capture: true } }), true); assert.equal(captureEnabled({}), false);
    process.env.RNA_EFFORT_PROBE_CAPTURE = '1'; assert.equal(captureEnabled({}), true);
    process.env.RNA_EFFORT_PROBE_CAPTURE = '0'; assert.equal(captureEnabled({ internalReasoning: { capture: true } }), false);
  } finally { if (prior === undefined) delete process.env.RNA_EFFORT_PROBE_CAPTURE; else process.env.RNA_EFFORT_PROBE_CAPTURE = prior; }
});

test('captures are private, bounded, joined with their outcome, purged with a deleted conversation or project, and inside the journal root a rollback\'s checkpoint knows', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-effort-capture-')), stateFile = join(dir, 'state.json'), projectId = '11111111-2222-4333-8444-555555555555';
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-04T00:00:00Z');
  const capture = new EffortCapture({ stateFile, now: () => clock });
  const id = capture.record(projectId, 'decision', { sessionIds: ['s1'], request: { project: { id: projectId } }, verdict: { depth: 'light', effort: 'low' } });
  capture.outcome(projectId, 'decision', id, { status: 'decided', action: 'wait' });
  capture.record(projectId, 'decision', { sessionIds: ['s2'], verdict: null });
  const root = join(`${stateFile}.rna`, 'effort-probe'), file = join(root, projectId, 'effort-decision.jsonl');
  assert.equal(captureRoot(stateFile), root);
  assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal((await stat(root)).mode & 0o777, 0o700);
  const calls = capture.calls('decision');
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].outcome, { status: 'decided', action: 'wait' }); assert.equal(calls[0].kind, 'call');
  assert.equal(capture.record('../escape', 'decision', {}), null); assert.equal(capture.record(projectId, 'chat', {}), null);
  assert.equal(purgeEffortCaptures(stateFile, 's1'), 1);
  assert.deepEqual(capture.calls('decision').map(row => row.sessionIds), [['s2']]);
  assert.ok(!(await readFile(file, 'utf8')).includes(id), 'the outcome row went with its call');
  // 14-day retention on the next prune.
  clock += 15 * 86400000; capture.prune(file, 'decision'); assert.equal(capture.calls('decision').length, 0);
  // No new top-level sibling: a rolled-back release's checkpoint would refuse an unknown `<state>.<name>` (0.43.0 trap).
  assert.deepEqual((await readdir(dir)).filter(name => name.startsWith('state.json.')), ['state.json.rna']);
  assert.ok(CHECKPOINT_SIDECARS.includes('.rna'));
  capture.record(projectId, 'work', { sessionIds: [] });
  await removeProjectFiles(stateFile, projectId);
  await assert.rejects(stat(join(root, projectId)), { code: 'ENOENT' });
  // A project deleted before this cleanup existed is swept from the namespace too; the replay's reports stay.
  const gone = '22222222-2222-4333-8444-555555555555';
  capture.record(gone, 'work', { sessionIds: [] }); await mkdir(join(root, 'replay'), { recursive: true });
  await sweepProjectFiles(stateFile, [projectId]);
  await assert.rejects(stat(join(root, gone)), { code: 'ENOENT' }); assert.ok((await stat(join(root, 'replay'))).isDirectory());
});

// A DecisionService whose kernel answers effort points with a fixed depth distribution.
function judged(probabilities, { mode = 'active', settings = {}, modes = {} } = {}) {
  const store = { state: { settings: { realTokenBudget: null, ...settings }, configuration: { decisionKernel: { ...(Object.keys(modes).length ? { modes, diagnostic: true } : {}) } }, projects: [], sessions: [] }, configurationService: { secrets: { 'judge:jev': 'TEST-ONLY-SECRET' } }, mutate(fn) { return fn(this.state); } };
  const requests = [];
  const service = new DecisionService(store, { kernelFactory: options => ({ close() {}, async decide(input) { requests.push(input); const kernelMode = options.modes[input.point] ?? mode; return { point: input.point, source: kernelMode === 'active' ? 'judge' : 'fallback', mode: kernelMode, networkAttempted: true, ledgerId: `j${requests.length}`, reason: kernelMode === 'active' ? 'accepted' : 'shadow', policy: {}, answers: { depth: { type: 'choice', choice: 'light', probabilities } }, usage: { inputTokens: 900, outputTokens: 0 }, latencyMs: 5 }; } }) });
  return { service, store, requests };
}
const project = { id: 'p', name: 'Novel', taskTypes: ['creative'] };

test('internalEffort: routed and applied only when allowed; shadow records the verdict without applying it', async () => {
  const plan = internalReasoningPlan(glm('max'));
  const route = judged({ light: .95, standard: .03, deep: .01, unknown: .01 });
  assert.deepEqual(await route.service.internalEffort(project, { purpose: 'decision', plan, facts: { wakeSources: ['background result'] }, evidence: ['action_completed: done'], apply: true }), { effort: 'low', depth: 'light', source: 'jev', ledgerId: 'j1', applied: true });
  assert.equal(route.requests[0].point, 'effort.decision'); assert.deepEqual(Object.keys(route.requests[0].state), ['call', 'project']);
  const row = route.store.decisionLedger.rows().at(-1);
  assert.deepEqual(row.outcome, { purpose: 'decision', depth: 'light', effort: 'low', applied: true }); assert.equal(row.applied, true);
  // Its label: `self` when a judgment of the system's own read it (B7 review); an outcome by default (what the call did),
  // which replaces a self label and is never replaced by one (PDL-7).
  const label = () => [route.store.decisionLedger.get('j1').label.value, route.store.decisionLedger.get('j1').label.source];
  assert.equal(route.service.labelEffort('j1', 'inadequate', { source: 'self' }), true); assert.deepEqual(label(), ['inadequate', 'self']);
  assert.equal(route.service.labelEffort('j1', 'adequate'), true); assert.deepEqual(label(), ['adequate', 'outcome']);
  assert.equal(route.service.labelEffort('j1', 'inadequate', { source: 'self' }), false); assert.deepEqual(label(), ['adequate', 'outcome']);
  const shadow = judged({ light: .95, standard: .03, deep: .01, unknown: .01 });
  const recorded = await shadow.service.internalEffort(project, { purpose: 'decision', plan, apply: false });
  assert.equal(recorded.applied, false); assert.equal(recorded.effort, 'low');
  const shadowRow = shadow.store.decisionLedger.rows().at(-1);
  assert.equal(shadowRow.applied, false); assert.equal(shadowRow.mode, 'shadow'); assert.equal(shadowRow.outcome.applied, false);
  // A code rule needs no judge call and is recorded as a rule.
  const ruled = judged({ light: 1 });
  assert.deepEqual(await ruled.service.internalEffort(project, { purpose: 'decision', plan, rule: 'deep', apply: true }), { effort: 'max', depth: 'deep', source: 'rule', ledgerId: ruled.store.decisionLedger.rows().at(-1).id, applied: true });
  assert.equal(ruled.requests.length, 0);
  // Recording only under an explicit usage cap spends nothing; a fixed plan or an unknown purpose asks nothing.
  const capped = judged({ light: .95 }, { settings: { realTokenBudget: 1000 } });
  assert.equal(await capped.service.internalEffort(project, { purpose: 'work', plan, apply: false }), null); assert.equal(capped.requests.length, 0);
  // …unless the opt-in capture asked for the verdicts (the replay needs them); still recorded, never applied.
  const roomy = judged({ light: .95 }, { settings: { realTokenBudget: 10000000 } });
  assert.equal(await roomy.service.internalEffort(project, { purpose: 'work', plan, apply: false }), null);
  assert.equal((await roomy.service.internalEffort(project, { purpose: 'work', plan, apply: false, capture: true })).applied, false); assert.equal(roomy.requests.length, 1);
  assert.equal(await route.service.internalEffort(project, { purpose: 'work', plan: { mode: 'fixed', effort: 'default' } }), null);
  assert.equal(await route.service.internalEffort(project, { purpose: 'chat', plan }), null);
  // Unknown as the most likely option: no effort, the caller keeps today's.
  const unsure = judged({ light: .1, standard: .1, deep: .1, unknown: .7 });
  assert.deepEqual(await unsure.service.internalEffort(project, { purpose: 'work', plan, apply: true }), { effort: null, depth: null, source: 'jev', ledgerId: 'j1', applied: false });
});

test('effortMayApply: the setting routes decisions and rewrites; work, setup and compaction stay recorded only (review EFF-4/RPL-4); an env trial names one point', () => {
  const { service } = judged({ light: 1 });
  assert.equal(service.effortMayApply('decision', { route: true }), true); assert.equal(service.effortMayApply('decision', { route: false }), false);
  assert.equal(service.effortMayApply('narrator', { route: true }), true);
  assert.equal(service.effortMayApply('work', { route: true }), false, 'background work has no replay of its own yet');
  assert.equal(service.effortMayApply('compaction', { route: true }), false); assert.equal(service.effortMayApply('setup', { route: true }), false);
  const prior = process.env.RNA_JEV_MODES;
  try { process.env.RNA_JEV_MODES = 'effort.compaction=active'; assert.equal(service.effortMayApply('compaction', { route: false }), true); process.env.RNA_JEV_MODES = 'effort.decision=shadow'; assert.equal(service.effortMayApply('decision', { route: true }), false); }
  finally { if (prior === undefined) delete process.env.RNA_JEV_MODES; else process.env.RNA_JEV_MODES = prior; }
  assert.equal(service.labelEffort('j-missing', 'adequate'), false); assert.equal(service.labelEffort('x', 'great'), false);
});

test('reasoningFor: a fixed plan asks nobody; a shadow route sends today\'s effort at once and records the verdict beside it; a route waits for it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-effort-route-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const fixed = await reasoningFor({ decisions: null, configuration: {}, project, model: modelOf(preset('anthropic', 'claude-opus-5-5'), 'max'), purpose: 'decision' });
  assert.deepEqual(fixed, { reasoning: 'default', record: { source: 'provider-default' } });
  const shadow = judged({ light: .95, standard: .03, deep: .01, unknown: .01 }), capture = new EffortCapture({ stateFile: join(dir, 'state.json') });
  const sent = await reasoningFor({ decisions: shadow.service, configuration: { internalReasoning: { capture: true } }, project: { ...project, id: '11111111-2222-4333-8444-555555555555' }, model: glm('max'), purpose: 'decision', call: decisionEffortInput({ events: [{ id: 'a', type: 'action_completed', summary: 'done', at: 2 }], lastDecision: { at: 1 } }), capture, sessionIds: ['s1'], request: { events: [] } });
  assert.equal(sent.reasoning, 'max'); assert.equal(sent.record.source, 'fallback'); assert.equal(sent.record.shadow, true); assert.ok(sent.record.captureId);
  await shadow.service.drain();
  const row = capture.calls('decision')[0];
  assert.deepEqual(row.verdict, { depth: 'light', effort: 'low', source: 'jev', applied: false, ledgerId: 'j1' }); assert.equal(row.sent, 'max'); assert.deepEqual(row.sessionIds, ['s1']); assert.deepEqual(row.request, { events: [] });
  const route = judged({ light: .95, standard: .03, deep: .01, unknown: .01 });
  const applied = await reasoningFor({ decisions: route.service, configuration: { internalReasoning: { routing: 'route' } }, project, model: glm('max'), purpose: 'decision', call: decisionEffortInput({ events: [{ id: 'a', type: 'action_completed', summary: 'done', at: 2 }], lastDecision: { at: 1 } }) });
  assert.deepEqual(applied, { reasoning: 'low', record: { source: 'jev', depth: 'light', ledgerId: 'j1' } });
  // Routing names its purposes: one left out, and background work always, keep today's effort and only record.
  const narrowed = judged({ light: .95, standard: .03, deep: .01, unknown: .01 });
  const kept = await reasoningFor({ decisions: narrowed.service, configuration: { internalReasoning: { routing: 'route', purposes: ['narrator'] } }, project, model: glm('max'), purpose: 'decision', call: decisionEffortInput({ events: [{ id: 'a', type: 'action_completed', summary: 'done', at: 2 }], lastDecision: { at: 1 } }) });
  assert.equal(kept.reasoning, 'max'); assert.equal(kept.record.shadow, true);
  const work = await reasoningFor({ decisions: narrowed.service, configuration: { internalReasoning: { routing: 'route' } }, project, model: glm('max'), purpose: 'work', call: workEffortInput({ task: 'Read the report and list its section titles.' }) });
  assert.equal(work.reasoning, 'max', 'routing never sends a lighter background run'); assert.equal(work.record.shadow, true);
  const chat = await reasoningFor({ decisions: route.service, configuration: { internalReasoning: { mode: 'chat', routing: 'route' } }, project, model: glm('max'), purpose: 'work' });
  assert.deepEqual(chat, { reasoning: 'max', record: { source: 'setting' } });
});

test('a quiet wake is coded light only when nothing at all is open; otherwise JEV judges it, never lighter than standard (review EFF-2)', async () => {
  const events = [{ id: 'old', type: 'action_completed', summary: 'work completed. done', at: 500 }], last = { at: 2000, action: 'wait', evidenceIds: [] }, quiet = (input = {}, options = {}) => decisionEffortInput({ events, lastDecision: last, project: {}, ...input }, options);
  assert.equal(quiet().rule, 'light'); assert.equal(quiet().floor, undefined);
  assert.equal(quiet({ recentActions: [{ status: 'running' }, { status: 'completed' }] }).rule, 'light', 'work merely running is not waiting on this decision');
  for (const [label, input, options] of [['a stopped run to confirm', { recentActions: [{ status: 'needs_review' }] }], ['a paused run', { recentActions: [{ status: 'paused' }] }], ['queued work', { recentActions: [{ status: 'queued' }] }],
    ['open agenda (a floor wake)', {}, { openWork: { agenda: 3 } }], ['something waiting on the user', {}, { openWork: { awaitingUser: 1 } }], ['a held finding', {}, { openWork: { heldFindings: 2 } }], ['a host bypass', {}, { bypass: 'pending_review' }]]) {
    const built = quiet(input, options);
    assert.equal(built.rule, null, label); assert.equal(built.floor, 'standard', label);
  }
  // The facts JEV reads are unchanged (Stage A measured this state shape).
  assert.deepEqual(Object.keys(quiet({}, { openWork: { agenda: 3 } }).facts), Object.keys(quiet().facts));
  // With new evidence the measured judgment stands, unfloored.
  assert.equal(decisionEffortInput({ events: [{ id: 'm', type: 'user_message', summary: 'x', at: 3000 }], lastDecision: last }, { openWork: { agenda: 3 } }).floor, undefined);
  // The floor raises a lighter verdict; the judged depth stays on the ledger row.
  const plan = internalReasoningPlan(glm('max')), floored = judged({ light: .95, standard: .03, deep: .01, unknown: .01 });
  assert.deepEqual(await floored.service.internalEffort(project, { purpose: 'decision', plan, floor: 'standard', apply: true }), { effort: 'high', depth: 'standard', source: 'jev', ledgerId: 'j1', applied: true });
  assert.deepEqual(floored.store.decisionLedger.rows().at(-1).outcome, { purpose: 'decision', depth: 'standard', effort: 'high', applied: true, judged: 'light', floor: 'standard' });
  const deeper = judged({ light: .01, standard: .01, deep: .97, unknown: .01 });
  assert.equal((await deeper.service.internalEffort(project, { purpose: 'decision', plan, floor: 'standard', apply: true })).depth, 'deep', 'a floor never lowers');
});

test('a resumed run keeps its saved effort only while today\'s setting would still send it (review EFF-5)', () => {
  const { service } = judged({ light: 1 }), lowered = { effective: 'low', source: 'jev', depth: 'light' }, route = { internalReasoning: { routing: 'route' } };
  assert.equal(resumedReasoning({ decisions: service, configuration: route, model: glm('max'), purpose: 'work', saved: null }), null);
  // A routed lighter effort after the rollback (routing shadow; or work, which the setting never routes): today's effort.
  assert.deepEqual(resumedReasoning({ decisions: service, configuration: {}, model: glm('max'), purpose: 'decision', saved: lowered }), { reasoning: 'max', record: { source: 'fallback', resumed: true, replaced: 'low' } });
  assert.equal(resumedReasoning({ decisions: service, configuration: route, model: glm('max'), purpose: 'work', saved: lowered }).reasoning, 'max');
  // …while routing still applies to the purpose, the saved effort (and its cache) is kept.
  assert.deepEqual(resumedReasoning({ decisions: service, configuration: route, model: glm('max'), purpose: 'decision', saved: lowered }), { reasoning: 'low', record: { source: 'jev', resumed: true } });
  const prior = process.env.RNA_JEV_MODES;
  try { process.env.RNA_JEV_MODES = 'effort.work=active'; assert.equal(resumedReasoning({ decisions: service, configuration: {}, model: glm('max'), purpose: 'work', saved: lowered }).reasoning, 'low', 'an env trial still routes'); }
  finally { if (prior === undefined) delete process.env.RNA_JEV_MODES; else process.env.RNA_JEV_MODES = prior; }
  // The user's switch back to the chat level, or a project level, applies to the rest of the run.
  assert.deepEqual(resumedReasoning({ decisions: service, configuration: { internalReasoning: { mode: 'chat', routing: 'route' } }, model: glm('max'), purpose: 'decision', saved: lowered }), { reasoning: 'max', record: { source: 'setting', resumed: true, replaced: 'low' } });
  assert.equal(resumedReasoning({ decisions: service, configuration: route, model: glm('max'), purpose: 'decision', saved: lowered, projectSelection: { reasoning: 'high' } }).reasoning, 'high');
  // Today's own effort, or the same fixed effort, is kept as it was.
  assert.deepEqual(resumedReasoning({ decisions: service, configuration: {}, model: glm('max'), purpose: 'work', saved: { effective: 'max', source: 'fallback' } }), { reasoning: 'max', record: { source: 'fallback', resumed: true } });
  assert.deepEqual(resumedReasoning({ decisions: service, configuration: {}, model: modelOf(preset('deepseek', 'deepseek-v4-pro'), 'max'), purpose: 'work', saved: { effective: 'default', source: 'provider-default' } }).reasoning, 'default');
});

test('a summary is planned on the effort the conversation sends now, not on the turn snapshot (review EFF-3)', () => {
  const deepseek = modelOf(preset('deepseek', 'deepseek-v4-pro'), 'auto');
  assert.equal(deepseek.reasoning, 'default');
  const live = liveModel(deepseek, { reasoning: 'max', reasoningSelection: 'auto' });
  assert.equal(live.reasoning, 'max'); assert.equal(live.reasoningCapability, deepseek.reasoningCapability);
  assert.deepEqual(internalReasoningPlan(live), { mode: 'fixed', effort: 'default', source: 'provider-default' });
  assert.equal(liveModel(deepseek, undefined), deepseek); assert.equal(liveModel(deepseek, { reasoning: 7 }), deepseek);
});

test('captures: rows past 14 days are never read and are swept with capture off; rows of deleted conversations are not written or kept (review RPL-2/RPL-10/RPL-11)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-effort-retention-')), stateFile = join(dir, 'state.json'), projectId = '11111111-2222-4333-8444-555555555555';
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-09-01T00:00:00Z');
  const state = { sessions: [{ id: 's1' }, { id: 's2' }], sessionDeletions: [] };
  const capture = new EffortCapture({ stateFile, now: () => clock, live: ids => sessionsLive(state, ids) });
  for (const id of ['a', 'b', 'c']) capture.record(projectId, 'decision', { id, sessionIds: ['s1'], verdict: null });
  const file = join(captureRoot(stateFile), projectId, 'effort-decision.jsonl');
  clock += CAPTURE_RETENTION_MS + 86400000;
  assert.equal(capture.calls('decision').length, 0, 'older than 14 days: not selectable, pruned or not');
  assert.equal(capture.has(projectId, 'decision', 'a'), false);
  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 3, 'nothing appended since, so nothing pruned yet');
  // The sweep runs whether capture is on or off.
  assert.equal(pruneEffortCaptures(stateFile, { now: clock }), 3); assert.equal((await readFile(file, 'utf8')).trim(), '');
  // A row for a conversation that is gone, or being deleted, is not written.
  assert.equal(capture.record(projectId, 'decision', { sessionIds: ['s9'] }), null);
  state.sessionDeletions.push({ sessionId: 's2' });
  assert.equal(capture.record(projectId, 'decision', { sessionIds: ['s1', 's2'] }), null);
  assert.ok(capture.record(projectId, 'decision', { id: 'kept', sessionIds: ['s1'] }));
  assert.equal(capture.has(projectId, 'decision', 'kept'), true);
  // The sweep drops a row whose conversation left the state after it landed.
  const plain = new EffortCapture({ stateFile, now: () => clock });
  plain.record(projectId, 'decision', { id: 'late', sessionIds: ['s1'] });
  state.sessions = state.sessions.filter(row => row.id !== 's1');
  assert.equal(pruneEffortCaptures(stateFile, { now: clock, state }), 2); assert.equal(plain.calls('decision').length, 0);
  // Decisions keep about one replay's worth (40); a file is read once per version.
  for (let index = 0; index < 45; index++) plain.record(projectId, 'decision', { id: `d${index}`, sessionIds: [] });
  plain.prune(file, 'decision');
  assert.equal(plain.calls('decision').length, 40); assert.equal(plain.calls('decision')[0].id, 'd5');
  const first = plain.rows(file); assert.equal(plain.rows(file), first, 'unchanged file: parsed once');
  plain.record(projectId, 'decision', { id: 'd45', sessionIds: [] }); assert.notEqual(plain.rows(file), first); assert.equal(plain.rows(file).length, first.length + 1);
});

test('a shadow verdict that lands after its conversation was deleted leaves no capture row (review RPL-10)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-effort-late-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const state = { sessions: [{ id: 's1' }], sessionDeletions: [] }, capture = new EffortCapture({ stateFile: join(dir, 'state.json'), live: ids => sessionsLive(state, ids) });
  let answer; const verdict = new Promise(resolve => { answer = resolve; }), pending = [];
  const decisions = { effortMayApply: () => false, shadow: (_key, work) => { pending.push(work()); }, internalEffort: () => verdict };
  const sent = await reasoningFor({ decisions, configuration: { internalReasoning: { capture: true } }, project: { id: '11111111-2222-4333-8444-555555555555' }, model: glm('max'), purpose: 'decision', call: { facts: {} }, capture, sessionIds: ['s1'], request: { events: [] } });
  assert.equal(sent.reasoning, 'max');
  state.sessions = []; state.sessionDeletions.push({ sessionId: 's1' });
  answer({ effort: 'low', depth: 'light', source: 'jev', applied: false }); await Promise.all(pending);
  assert.equal(capture.calls('decision').length, 0);
});

test('messageCheck({ verdict: true }) answers null without an active verdict; callers that only act on flags still get [] (review EFF-7)', async () => {
  const shadow = judged({}, { modes: { 'message.check': 'shadow' } });
  assert.equal(await shadow.service.messageCheck(project, { text: 'Two parser tests fail.', verdict: true }), null);
  assert.deepEqual(await shadow.service.messageCheck(project, { text: 'Two parser tests fail.' }), []);
  assert.ok(Array.isArray(await judged({}).service.messageCheck(project, { text: 'Two parser tests fail.', verdict: true })), 'an active verdict is an array');
});
