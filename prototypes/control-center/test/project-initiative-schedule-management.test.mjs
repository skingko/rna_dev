import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectScheduleService } from '../project-schedule-service.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';

const start = Date.parse('2026-09-26T00:00:00.000Z');
async function until(check, diagnostic = () => ({})) { const end = Date.now() + 5000; while (Date.now() < end) { if (check()) return; await delay(5); } throw Error(`Isolated schedule management fixture did not settle: ${JSON.stringify(diagnostic())}`); }
async function fixture(t, decide) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-autonomous-schedule-')), store = new Store(join(dir, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Explicit deterministic decision fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Ongoing evidence project', description: 'Understand this evolving field and maintain useful project progress.', workspace: dir });
  const destinationId = 'destination-conversation'; let now = start, calls = 0, mutations = 0, latestInput;
  store.mutate(state => {
    const p = state.projects.find(p => p.id === project.id); p.initialization = { status: 'ready' }; p.simulated = false; p.decisionMode = 'rna-model'; p.initiative.tokenBudget = null; p.initiative.reviewMinMs = 1000; p.initiative.reviewMaxMs = 1000;
    p.permissions = { workspace: 'read', background: 'read' }; p.schedules = []; p.assignments = { skillIds: [], toolIds: [], mcpServerIds: [] };
    const source = state.sessions.find(s => s.id === session.id); source.items = []; source.turns = [];
    state.sessions.push({ ...structuredClone(source), id: destinationId, title: 'Intended delivery conversation' }); p.sessionIds.push(destinationId);
  });
  const service = new ProjectScheduleService(store, { now: () => now }), apply = service.applyInitiativeAction.bind(service);
  service.applyInitiativeAction = (...args) => { mutations++; return apply(...args); };
  const options = { scheduleService: service, initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, now: () => now, decisionProvider: async function* (request) {
    calls++; latestInput = JSON.parse(request.messages[0].content[0].text);
    const output = decide(latestInput, { calls, destinationId });
    yield { type: 'text_delta', delta: JSON.stringify(output) }; yield { type: 'usage', usage: { totalTokens: 31 } }; yield { type: 'done', stopReason: 'stop' };
  }, runtimeFactory: () => { throw Error('Registration must not start a worker'); } };
  let controller = new ProjectInitiativeController(store, options);
  t.after(async () => { await controller.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, project, session, destinationId, service, options, current: () => store.state.projects.find(p => p.id === project.id), controller: () => controller, replace: value => { controller = value; }, calls: () => calls, mutations: () => mutations, input: () => latestInput, advance: () => { now += 1001; controller.schedule(); } };
}
const wait = { action: 'wait', reason: 'No additional commitment is justified.', evidenceIds: [], content: '', nextReviewAfterMs: 1000 };
const choice = (input, schedule) => ({ action: 'schedule', reason: 'A periodic review serves the evolving project responsibility, without a manual task setup.', evidenceIds: [input.events.find(event => event.type === 'project_state').id], content: 'Maintain a useful project review.', nextReviewAfterMs: 1000, schedule });
const create = (input, destinationId) => choice(input, { operation: 'create', purposeKey: 'project-progress-review', title: 'Project progress review', task: 'Inspect current evidence and report one useful new finding with limitations.', rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, destinationSessionId: destinationId });

test('model review establishes a persistent task from project responsibility without a manual task, user message or Goal', async t => {
  const app = await fixture(t, (input, { destinationId }) => input.project.schedules.length ? wait : create(input, destinationId));
  await until(() => app.current().initiativeRuntime?.sdkState.actions.some(a => a.action === 'schedule' && a.status === 'completed'), () => ({ calls: app.calls(), mutations: app.mutations(), actions: app.current().initiativeRuntime?.sdkState.actions.map(a => ({ id: a.id, action: a.action, status: a.status, cancellationReason: a.cancellationReason, failure: a.failure })), error: app.current().initiativeRuntime?.lastError }));
  const record = app.current().schedules[0], action = app.current().initiativeRuntime.sdkState.actions.find(a => a.action === 'schedule');
  assert.equal(record.source, 'initiative'); assert.equal(record.destinationSessionId, app.destinationId); assert.equal(record.nextRunAt, '2026-09-26T01:00:00.000Z');
  assert.equal(record.initiativeProvenance.actionId, action.id); assert.ok(record.initiativeProvenance.sources[0].hash); assert.equal(app.current().scheduleManagementReceipts.length, 1);
  assert.equal(app.current().permissions.workspace, 'read'); assert.equal(app.current().jobs.length, 0); assert.equal(app.current().initiative.tokens, app.calls() * 31);
  assert.equal(app.store.state.sessions.find(s => s.id === app.session.id).items.length, 0); assert.equal(app.current().primarySessionId, app.session.id);
  assert.ok(app.input().hostActionContracts.schedule.enabled); assert.equal(app.input().project.scheduleContext.destinations.length, 2);
});

test('the model amends and cancels the same task using actual revisions; deleted purpose remains visible and cannot be recreated', async t => {
  let stage = 'create';
  const app = await fixture(t, (input, { destinationId }) => {
    const record = input.project.schedules[0];
    if (stage === 'create') return record ? wait : create(input, destinationId);
    if (stage === 'update') { stage = 'wait'; return choice(input, { operation: 'update', id: record.id, expectedRevision: record.revision, rule: { kind: 'weekly', days: [1], time: '10:00', timeZone: 'Asia/Shanghai' } }); }
    if (stage === 'delete') { stage = 'wait'; return choice(input, { operation: 'delete', id: record.id, expectedRevision: record.revision }); }
    if (stage === 'recreate') { stage = 'wait'; return { ...create(input, destinationId), evidenceIds: [input.events.find(event => /not a cancellation reversal/.test(event.summary ?? '')).id] }; }
    return wait;
  });
  await until(() => app.current().scheduleManagementReceipts?.length === 1); const id = app.current().schedules[0].id;
  stage = 'update'; app.advance(); await until(() => app.current().schedules[0]?.revision === 2); stage = 'wait';
  assert.equal(app.current().schedules[0].id, id); assert.equal(app.current().schedules[0].rule.kind, 'weekly');
  stage = 'delete'; app.advance(); await until(() => app.current().schedules.length === 0); stage = 'wait';
  const view = app.service.agentView(app.project.id); assert.equal(view.cancelled[0].purposeKey, 'project-progress-review');
  // A fresh actual project observation avoids relying on SDK same-intent suppression.
  app.store.mutate(state => { state.projects.find(p => p.id === app.project.id).observations.push({ id: 'fixture-new-source', kind: 'project_change', text: 'A new project observation, not a cancellation reversal.', createdAt: new Date(start + 5000).toISOString(), simulated: false }); });
  stage = 'recreate'; app.advance(); await until(() => app.current().initiativeRuntime.sdkState.actions.some(a => a.action === 'schedule' && a.status === 'failed'));
  assert.equal(app.current().schedules.length, 0); assert.equal(app.current().scheduleManagementReceipts.length, 3);
});

test('human pause is shown to the model and cannot be reenabled by an autonomous update', async t => {
  let resume = false;
  const app = await fixture(t, (input, { destinationId }) => {
    const row = input.project.schedules[0]; if (!row) return create(input, destinationId);
    return resume ? choice(input, { operation: 'update', id: row.id, expectedRevision: row.revision, enabled: true }) : wait;
  });
  await until(() => app.current().scheduleManagementReceipts?.length === 1);
  const row = app.current().schedules[0]; app.service.update(app.project.id, row.id, { enabled: false }); resume = true; app.advance();
  await until(() => app.current().initiativeRuntime.sdkState.actions.some(a => a.action === 'schedule' && a.status === 'failed'));
  assert.equal(app.current().schedules[0].enabled, false); assert.equal(app.current().schedules[0].lastEditedBy, 'user');
  assert.equal(app.input().project.schedules[0].userPaused, true); assert.equal(app.input().project.scheduleContext.schedules, undefined, 'the records are sent once'); assert.equal(app.current().scheduleManagementReceipts.length, 1);
});

test('restart reconciles an exact committed registration receipt without replay, fee or loss of original uncertainty reason', async t => {
  const app = await fixture(t, (input, { destinationId }) => input.project.schedules.length ? wait : create(input, destinationId));
  await until(() => app.current().initiativeRuntime?.sdkState.actions.some(a => a.action === 'schedule' && a.status === 'completed'), () => ({ calls: app.calls(), mutations: app.mutations(), actions: app.current().initiativeRuntime?.sdkState.actions.map(a => ({ id: a.id, action: a.action, status: a.status, cancellationReason: a.cancellationReason, failure: a.failure })), error: app.current().initiativeRuntime?.lastError }));
  await app.controller().close();
  const id = app.current().initiativeRuntime.sdkState.actions.find(a => a.action === 'schedule').id;
  app.store.mutate(state => { const p = state.projects.find(p => p.id === app.project.id); p.initiative.enabled = false; const a = p.initiativeRuntime.sdkState.actions.find(a => a.id === id); a.status = 'running'; delete a.finishedAt; });
  const beforeTokens = app.current().initiative.tokens, beforeCalls = app.calls(), beforeMutations = app.mutations();
  const controller = new ProjectInitiativeController(app.store, app.options); app.replace(controller);
  const p = app.current(), model = controller.model(p); await controller.create(p, model, controller.scope(p, model));
  const action = app.current().initiativeRuntime.sdkState.actions.find(a => a.id === id);
  assert.equal(action.status, 'completed'); assert.equal(action.resolutionSource, 'host'); assert.match(action.reasonForReview, /Daemon ended/);
  assert.equal(app.current().schedules.length, 1); assert.equal(app.current().initiative.tokens, beforeTokens); assert.equal(app.calls(), beforeCalls); assert.equal(app.mutations(), beforeMutations);
});

test('missing or nonmatching commit receipt remains needs-review on restart and does not replay a mutation', async t => {
  const app = await fixture(t, (input, { destinationId }) => input.project.schedules.length ? wait : create(input, destinationId));
  await until(() => app.current().initiativeRuntime?.sdkState.actions.some(a => a.action === 'schedule' && a.status === 'completed'), () => ({ calls: app.calls(), mutations: app.mutations(), actions: app.current().initiativeRuntime?.sdkState.actions.map(a => ({ id: a.id, action: a.action, status: a.status, cancellationReason: a.cancellationReason, failure: a.failure })), error: app.current().initiativeRuntime?.lastError })); await app.controller().close();
  app.store.mutate(state => { const p = state.projects.find(p => p.id === app.project.id); p.initiative.enabled = false; const a = p.initiativeRuntime.sdkState.actions.find(a => a.action === 'schedule'); a.status = 'running'; a.schedule.task = 'Different payload must not inherit the old commit receipt.'; });
  const beforeCalls = app.calls(), beforeMutations = app.mutations(); const controller = new ProjectInitiativeController(app.store, app.options); app.replace(controller);
  const p = app.current(), model = controller.model(p); await controller.create(p, model, controller.scope(p, model));
  const action = app.current().initiativeRuntime.sdkState.actions.find(a => a.action === 'schedule'); assert.equal(action.status, 'needs_review'); assert.equal(action.blocksExecution, true);
  assert.equal(app.calls(), beforeCalls); assert.equal(app.mutations(), beforeMutations); assert.equal(app.current().schedules.length, 1);
});

test('a read-only QA observer can close at durable schedule completion without a second model review or unknown fee', async t => {
  const app = await fixture(t, (input, { destinationId }) => input.project.schedules.length ? wait : create(input, destinationId));
  let closing;
  const unsubscribe = app.store.subscribe(() => {
    if (closing) return;
    const p = app.current(), receipt = p.scheduleManagementReceipts?.[0];
    if (receipt && p.initiativeRuntime?.sdkState?.actions.some(row => row.id === receipt.actionId && row.status === 'completed')) closing = app.controller().close();
  });
  t.after(unsubscribe);
  await until(() => closing); await closing;
  assert.equal(app.calls(), 1); assert.equal(app.current().initiative.tokens, 31);
  assert.equal(app.current().initiativeRuntime.sdkState.estimatedTokens, 0);
  assert.equal(app.current().initiativeRuntime.sdkState.actions.find(row => row.action === 'schedule').status, 'completed');
});
