import test from 'node:test';
import { sayAndFinish } from './helpers/foreground-turn.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { createProjectSchedule } from '../../../packages/sdk/src/project-schedules.mjs';
import { projectRhythmEvidenceKey, projectRhythmStatus } from '../project-rhythm.mjs';

const DAY = 86400000, ORIGIN = Date.parse('2026-09-26T00:00:00Z');
const hold = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate, label = 'condition') { const end = Date.now() + 7000; while (!predicate()) { if (Date.now() > end) throw Error(`timeout: ${label}`); await delay(10); } }
const rhythm = (input, lifecycle = 'complete') => ({ lifecycle, reason: 'Based on the actual provided project evidence and registered responsibilities.', evidenceIds: [input.events.at(-1).id], scheduleIds: (input.project.schedules ?? []).map(row => row.id), initiative: { mode: 'event_only', reviewAfterMs: DAY }, evolution: { mode: 'weekly', maxPerDay: 1, maxPerWeek: 1, minIntervalMs: DAY } });
const reply = (input, { lifecycle = 'complete', action = 'wait', assess = true } = {}) => ({ action, content: action === 'wait' ? '' : action === 'share' ? 'The requested result has a retained verification receipt.' : 'Read evidence.txt and report its exact content.', evidenceIds: [input.events.at(-1).id], reason: 'Current project evidence supports this bounded action.', nextReviewAfterMs: 60000, ...(assess ? { rhythm: rhythm(input, lifecycle) } : {}) });

async function fixture(t, { lifecycle = 'complete', respond, scheduled = false, typing = false, workGate } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-initiative-rhythm-')), file = join(directory, 'state.json'), store = new Store(file);
  const provider = store.configurationService.provider(null, { name: 'Rhythm host fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 4096, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ name: 'Domain-neutral responsibility', description: 'Observe verified state and deliver the requested work.', workspace: directory, initiative: { cooldownMs: 0 } });
  assert.equal(project.rhythm.control, 'auto');
  let clock = ORIGIN, workCalls = 0; const calls = [], controllers = [];
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); p.decisionMode = 'rna-model'; p.simulated = false; p.initialization = { status: 'ready' }; p.assignments = { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] }; p.initiative.tokenBudget = null; state.settings.realTokenBudget = null;
    if (scheduled) p.schedules = [createProjectSchedule({ id: 'daily-output', title: 'Verified output', task: 'Read evidence.txt and report its content.', destinationSessionId: session.id, rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }, { now: clock })]; });
  writeFileSync(join(directory, 'evidence.txt'), 'Verified fixture source: seven distinct items.');
  if (typing) store.presence(project.id, { sessionId: session.id, visible: true, typing: true });
  const options = { initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, now: () => clock, evolutionService: { running: new Map() },
    decisionProvider: async function* (request) { const input = JSON.parse(request.messages[0].content[0].text); calls.push({ input, systemPrompt: request.systemPrompt }); const output = await (respond ? respond(input, calls.length) : reply(input, { lifecycle })); yield { type: 'text_delta', delta: JSON.stringify(output) }; yield { type: 'usage', usage: { input: 12, output: 8, totalTokens: 20 } }; yield { type: 'done', stopReason: 'stop' }; },
    runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* (request) { workCalls++; if (workGate) await workGate.promise; request.signal.throwIfAborted();
      if (!request.messages.some(row => row.role === 'toolResult')) { yield { type: 'tool_call', id: 'read-source', name: 'project_read', arguments: { path: 'evidence.txt' } }; yield { type: 'done', stopReason: 'toolUse' }; }
      else { assert.match(JSON.stringify(request.messages), /seven distinct items/); yield { type: 'text_delta', delta: 'Read evidence.txt: seven distinct items.' }; yield { type: 'done', stopReason: 'stop' }; }
      yield { type: 'usage', usage: { input: 10, output: 5, totalTokens: 15 } };
    } }) };
  const restart = () => { const controller = new ProjectInitiativeController(store, options); controllers.push(controller); return controller; };
  const controller = restart(), current = () => store.state.projects.find(row => row.id === project.id);
  t.after(async () => { workGate?.resolve(); for (const controller of controllers) await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, project, session, controller, current, restart, calls, now: () => clock, advance: ms => { clock += ms; }, workCalls: () => workCalls,
    messages: () => store.state.sessions.find(row => row.id === session.id).items.filter(row => row.source === 'initiative') };
}

async function settled(app, controller = app.controller) { await until(() => !controller.pumping && !controller.scheduled && !controller.contexts.get(app.project.id)?.reviewPromise, 'host settled'); }
async function pumps(app, count = 50, controller = app.controller) { for (let i = 0; i < count; i++) { await controller.pump(); await controller.contexts.get(app.project.id)?.reviewPromise; } await settled(app, controller); }

for (const lifecycle of ['complete', 'recurring']) test(`default auto ${lifecycle} assessment uses the real SDK contract and rests without idle model requests or state writes`, async t => {
  const app = await fixture(t, { lifecycle, scheduled: lifecycle === 'recurring' });
  await until(() => app.current().rhythmRuntime?.assessment); await settled(app);
  assert.equal(app.calls.length, 1); assert.equal(app.calls[0].input.hostConditions.rhythm.requiresAssessment, true); assert.match(app.calls[0].systemPrompt, /"rhythm"/);
  assert.equal(app.current().rhythmRuntime.assessment.lifecycle, lifecycle); assert.equal(app.current().rhythmRuntime.history.length, 1);
  assert.equal(app.current().rhythmRuntime.evidenceKey, projectRhythmEvidenceKey(app.store.state, app.current()));
  const writes = app.store.persistence.writes; await pumps(app, 100);
  assert.equal(app.calls.length, 1); assert.equal(app.store.persistence.writes, writes); assert.equal(app.messages().length, 0);
  assert.equal(projectRhythmStatus(app.store.state, app.current(), { now: app.now() }).initiative.reason, lifecycle === 'complete' ? 'project_complete' : 'awaiting_scheduled_work');
});

test('fresh user evidence wakes one assessment, preserves optional historical assessment and survives host restart without another paid review', async t => {
  const app = await fixture(t, { respond: (input, count) => reply(input, { assess: count === 1 }) });
  await until(() => app.current().rhythmRuntime?.assessment); await settled(app); const original = structuredClone(app.current().rhythmRuntime);
  app.advance(1000); sayAndFinish(app.store, app.session.id, 'The project has a new verified requirement.');
  await until(() => app.calls.length === 2 && app.current().rhythmRuntime.evidenceKey !== original.evidenceKey); await settled(app);
  assert.equal(app.calls[1].input.hostConditions.rhythm.requiresAssessment, false); assert.deepEqual(app.current().rhythmRuntime.assessment, original.assessment); assert.equal(app.current().rhythmRuntime.history.length, 1);
  assert.equal(app.current().rhythmRuntime.lastInitiativeAt, app.now()); await app.controller.close();
  const persisted = structuredClone(app.current().rhythmRuntime), restarted = app.restart(); await settled(app, restarted); await pumps(app, 50, restarted);
  assert.equal(app.calls.length, 2); assert.deepEqual(app.current().rhythmRuntime, persisted);
});

for (const failureBackoff of [false, true]) test(`a queued share drains after typing ends while decisions sleep${failureBackoff ? ' and a paid-decision backoff is active' : ''}`, async t => {
  const app = await fixture(t, { typing: true, respond: input => reply(input, { action: 'share' }) });
  await until(() => app.current().initiativeRuntime?.sdkState.actions.some(row => row.status === 'queued')); await settled(app);
  assert.equal(app.calls.length, 1); assert.equal(app.messages().length, 0); assert.equal(projectRhythmStatus(app.store.state, app.current(), { now: app.now() }).initiative.eligible, false);
  if (failureBackoff) { const context = app.controller.contexts.get(app.project.id); context.coordinator.state.failureRetryAt = app.now() + DAY; await app.controller.save(context, context.coordinator.snapshot()); }
  app.store.presence(app.project.id, { sessionId: app.session.id, visible: true, typing: false }); app.controller.schedule();
  await until(() => app.messages().length === 1); await settled(app); await pumps(app);
  assert.equal(app.calls.length, 1); assert.equal(app.messages().length, 1);
});

test('already admitted work is not cancelled by its sleeping rhythm, and a real tool result permits one later review', async t => {
  const gate = hold(); const app = await fixture(t, { workGate: gate, respond: (input, count) => reply(input, { action: count === 1 ? 'work' : 'wait' }) });
  await until(() => app.workCalls() === 1); assert.equal(app.current().rhythmRuntime.assessment.lifecycle, 'complete');
  await pumps(app, 10); assert.equal(app.calls.length, 1); assert.equal(app.current().jobs[0].status, 'running');
  gate.resolve(); await until(() => app.current().jobs[0]?.status === 'completed'); await until(() => app.calls.length === 2); await settled(app); await pumps(app);
  assert.equal(app.workCalls(), 2); assert.equal(app.calls.length, 2); assert.equal(app.current().jobs[0].status, 'completed');
});

test('an existing due daily responsibility runs real SDK read work and delivers once while generic recurring review is asleep', async t => {
  const app = await fixture(t, { lifecycle: 'recurring', scheduled: true });
  await until(() => app.current().rhythmRuntime?.assessment); await settled(app); assert.equal(app.calls.length, 1);
  app.advance(3600000); await app.controller.pump();
  await until(() => app.current().scheduleRuntime?.occurrences[0]?.status === 'delivered', 'daily delivery'); await settled(app); await pumps(app);
  assert.equal(app.workCalls(), 2); assert.equal(app.messages().filter(row => row.scheduleOccurrenceKey).length, 1);
  const calls = app.calls.length; assert.ok(calls <= 2); assert.equal(app.current().schedules[0].nextRunAt, '2026-09-27T01:00:00.000Z');
  await app.controller.close(); const restarted = app.restart(); await settled(app, restarted); await pumps(app, 25, restarted);
  assert.equal(app.workCalls(), 2); assert.equal(app.calls.length, calls); assert.equal(app.messages().filter(row => row.scheduleOccurrenceKey).length, 1);
});
