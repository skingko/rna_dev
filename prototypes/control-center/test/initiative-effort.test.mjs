import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { ProjectEvolutionService } from '../test-support/marketplace-isolation.mjs';

// spec p1 effort §3.4 (controller wiring): a GLM-like project model (effort levels low/high/max, provider default
// unknown) routes the decision's effort through the judge; in shadow it sends today's. The background run's effort is
// judged and recorded but never routed by the setting (review EFF-4: no replay of its own yet).
async function until(check, label = 'condition') { const deadline = Date.now() + 30000; while (Date.now() < deadline) { if (check()) return; await delay(10); } throw new Error(`Timed out: ${label}`); }
async function fixture(t, { decisionService, routing = 'shadow', work = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-initiative-effort-'));
  const store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Isolated GLM-like fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'glm-like', contextWindow: 64000, maxOutputTokens: 3000, reasoning: ['low', 'high', 'max'], compat: { thinkingFormat: 'zai' } }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'glm-like', reasoning: 'max' }, memory: { autoRecall: false, autoStore: false }, internalReasoning: { routing } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Effort fixture', description: 'Check current compatibility evidence', workspace: directory, initiative: { cooldownMs: 0 } });
  store.mutate(state => { const target = state.projects.find(row => row.id === project.id); target.decisionMode = 'rna-model'; target.simulated = false; target.initialization = { status: 'ready' }; target.overview = 'Investigate compatibility evidence'; target.assignments = { skillIds: [], toolIds: [], mcpServerIds: [], reasons: [] }; target.permissions = { workspace: 'write', background: 'inherit' }; });
  writeFileSync(join(directory, 'evidence.txt'), 'compatibility: second input variant is missing');
  const decided = [], worked = [];
  const decisionProvider = async function* (options) {
    const input = JSON.parse(options.messages[0].content[0].text); decided.push({ reasoning: options.model.reasoning, purposeDetail: options.purposeDetail });
    const completed = input.events.find(event => event.type === 'action_completed');
    const output = work && !completed ? { action: 'work', title: 'Read the notes', content: 'Read evidence.txt and report the missing variant.', evidenceIds: [input.events.at(-1).id], reason: 'A concrete gap is recorded', nextReviewAfterMs: 60000 } : { action: 'wait', content: '', evidenceIds: [], reason: 'Nothing new', nextReviewAfterMs: 3600000 };
    yield { type: 'text_delta', delta: JSON.stringify(output) }; yield { type: 'usage', usage: { input: 12, output: 8, totalTokens: 20 } }; yield { type: 'done', stopReason: 'stop' };
  };
  const runtimeFactory = options => createRnaRuntime({ ...options, provider: async function* (request) { worked.push(request.model.reasoning); yield { type: 'text_delta', delta: '读了 evidence.txt：第二种输入仍缺示例。\n交接：核对了 evidence.txt，第二种输入缺示例，下一步补写示例。' }; yield { type: 'usage', usage: { input: 10, output: 10, totalTokens: 20 } }; yield { type: 'done', stopReason: 'stop' }; } });
  const evolutionService = new ProjectEvolutionService(store, { provider: decisionProvider });
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, decisionProvider, runtimeFactory, evolutionService, decisionService });
  t.after(async () => { await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, controller, project, session, decided, worked, current: () => store.state.projects.find(row => row.id === project.id) };
}
// effortMayApply as DecisionService answers it: the setting's per-purpose route (work is never in it), when the point may apply.
const judge = ({ mayApply, review = { review: true } }) => {
  const calls = [];
  return { calls, service: { enabled: () => false, review: async () => review, openWork: () => ({ commitments: 0, overdue: 0, awaitingUser: 0 }), effortMayApply: (_purpose, { route = false } = {}) => mayApply && route, labelEffort: () => true,
    internalEffort: async (_project, { purpose, plan, rule, floor, apply }) => { calls.push({ purpose, plan, rule, floor, apply }); const effort = plan.allowed[0]; return { effort, depth: 'light', source: 'jev', ledgerId: `l${calls.length}`, applied: apply === true }; } } };
};

test('routing on: the decision sends the routed effort, the background run only records its verdict (review EFF-4); the coordinator model and scope stay', async t => {
  const j = judge({ mayApply: true });
  const app = await fixture(t, { decisionService: j.service, routing: 'route', work: true });
  await until(() => app.current().jobs?.[0]?.status === 'completed', 'background run completed');
  assert.equal(app.decided[0].reasoning, 'low', 'the decision ran at the routed effort'); assert.equal(app.decided[0].purposeDetail, 'decision');
  assert.deepEqual(app.worked, ['max'], 'the run keeps today\'s effort: background work has no replay of its own yet');
  const job = app.current().jobs[0];
  assert.equal(job.reasoning.effective, 'max'); assert.equal(job.reasoning.source, 'fallback');
  // Recorded only: `shadow` is true until the verdict arrives, then the verdict itself (review ACC-5) — never applied.
  assert.ok(job.reasoning.shadow === true || (typeof job.reasoning.shadow?.effort === 'string'), JSON.stringify(job.reasoning.shadow));
  const context = app.controller.contexts.get(app.project.id), scope = context.scope;
  assert.equal(context.coordinator.model.reasoning, 'max', 'the coordinator model is never changed');
  await until(() => j.calls.filter(row => row.purpose === 'work').length >= 1, 'work verdict recorded');
  assert.deepEqual(j.calls.map(row => [row.purpose, row.apply]).slice(0, 2), [['decision', true], ['work', false]]);
  await until(() => app.decided.length >= 2, 'second decision after the work result');
  assert.equal(app.controller.contexts.get(app.project.id).scope, scope, 'two routed decisions, one scope');
  const wake = app.current().mind.pacing.wake.history[0];
  assert.equal(wake.reasoning.effective, 'low'); assert.equal(wake.reasoning.source, 'jev');
  assert.equal(app.current().decisions[0].reasoning.effective, 'low');
});

test('routing in shadow (the default): today\'s effort is sent and the judge is still asked, to record its choice', async t => {
  const j = judge({ mayApply: false });
  const app = await fixture(t, { decisionService: j.service });
  await until(() => app.decided.length >= 1 && j.calls.length >= 1, 'first decision');
  assert.equal(app.decided[0].reasoning, 'max');
  assert.equal(j.calls[0].purpose, 'decision'); assert.equal(j.calls[0].apply, false); assert.deepEqual(j.calls[0].plan.allowed, ['low', 'high', 'max']);
  await until(() => app.current().mind?.pacing?.wake?.history?.length, 'wake recorded');
  const wake = app.current().mind.pacing.wake.history[0];
  assert.equal(wake.reasoning.effective, 'max'); assert.equal(wake.reasoning.source, 'fallback'); assert.equal(wake.tokens, 20, 'the decision\'s own tokens');
  // ACC-5: the effort JEV would have chosen reaches the wake row and the decision record (the per-effort monitor's shadow column).
  assert.equal(wake.reasoning.shadow, 'low', 'the shadow verdict is written on the wake row');
  assert.equal(app.current().decisions[0].reasoning.shadow, 'low');
});

test('effort.decision hears why the host sent a wake past the judge, and never codes such a quiet wake light (review EFF-2)', async t => {
  const j = judge({ mayApply: false, review: { review: true, reason: 'main_review_required', bypass: 'pending_review' } });
  const app = await fixture(t, { decisionService: j.service });
  await until(() => app.decided.length >= 1 && j.calls.length >= 1, 'first decision');
  const context = app.controller.contexts.get(app.project.id);
  assert.equal(context.wakeBypass, 'pending_review', 'the gate\'s bypass reason rides on the wake');
  const quiet = { events: [{ id: 'old', type: 'action_completed', summary: 'done', at: 1 }], lastDecision: { at: 2, action: 'wait', evidenceIds: [] }, project: {} };
  await app.controller.decisionReasoning(context, quiet);
  await until(() => j.calls.length >= 2, 'quiet wake judged');
  assert.deepEqual([j.calls.at(-1).rule, j.calls.at(-1).floor], [null, 'standard']);
  context.wakeBypass = null;
  await app.controller.decisionReasoning(context, quiet);
  await until(() => j.calls.length >= 3, 'second quiet wake');
  assert.deepEqual([j.calls.at(-1).rule, j.calls.at(-1).floor], ['light', undefined], 'nothing open, no bypass: a quiet wake');
});
