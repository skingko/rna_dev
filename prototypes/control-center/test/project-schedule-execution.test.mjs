import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { createServer } from '../server.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { createProjectSchedule } from '../../../packages/sdk/src/project-schedules.mjs';
import { ProjectScheduleService } from '../project-schedule-service.mjs';
const origin = Date.parse('2026-09-26T00:00:00Z');
async function until(check, label) { const end = Date.now() + 5000; while (Date.now() < end) { if (check()) return; await delay(5); } throw new Error(`Timeout: ${label}`); }
// `held`: quiet time holds the inline delivery (the result waits as delivery_pending). `gate`: the first model request
// waits for gate.open(), so a test can act while the scheduled run is in flight.
const QUIET = '2099-01-01T00:00:00.000Z';
const opening = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open }; };
async function fixture(t, { muted = false, held = false, budget = null, busy = false, maxSteps = 1, fail = false, truncated = false, globalBudget = null, gate = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-schedule-execution-')), store = new Store(join(dir, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Isolated schedule fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Recurring evidence review', description: 'A generic periodic report', workspace: dir });
  let now = origin + 3600000, calls = 0;
  store.mutate(state => {
    const target = state.projects.find(row => row.id === project.id); target.initialization = { status: 'ready' }; target.simulated = false; target.decisionMode = 'rna-model'; target.assignments = { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] };
    target.initiative.tokenBudget = budget; target.initiative.cooldownMs = 0; target.initiative.notificationMuted = muted; if (held) target.initiative.quietUntil = QUIET;
    target.schedules = [createProjectSchedule({ id: 'review', title: 'Daily report', task: 'Inspect evidence.txt twice and deliver the actual finding.', destinationSessionId: session.id, rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }, { now: origin })];
    state.settings.realTokenBudget = globalBudget;
    if (busy) { const s = state.sessions.find(row => row.id === session.id); s.activeTurnId = 'foreground'; s.turns.push({ id: 'foreground', status: 'running' }); }
    const alternate = structuredClone(state.sessions.find(row => row.id === session.id)); alternate.id = 'alternate-session'; alternate.activeTurnId = null; alternate.turns = []; alternate.items = []; state.sessions.push(alternate); target.sessionIds.push(alternate.id); target.primarySessionId = alternate.id;
  });
  writeFileSync(join(dir, 'evidence.txt'), 'Measured result: seven verified sources.');
  const options = { initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, now: () => now, workMaxSteps: maxSteps, decisionProvider: async function* () { yield { type: 'text_delta', delta: JSON.stringify({ action: 'wait', content: '', reason: 'No other task', evidenceIds: [], nextReviewAfterMs: 86400000 }) }; yield { type: 'usage', usage: { totalTokens: 0 } }; yield { type: 'done', stopReason: 'stop' }; }, runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* (request) {
    calls++; const count = request.messages.filter(row => row.role === 'toolResult').length;
    if (gate && calls === 1) await gate.promise;
    yield { type: 'usage', usage: { input: 15000, output: 10, totalTokens: 15010 } };
    if (fail) throw Object.assign(new Error('Fixture failed after actual usage'), { code: 'fixture_provider_error' });
    if (count < 2) { yield { type: 'tool_call', id: `read-${count}`, name: 'project_read', arguments: { path: 'evidence.txt' } }; yield { type: 'done', stopReason: 'toolUse' }; }
    else { yield { type: 'text_delta', delta: 'Verified evidence.txt: seven sources, report ready.' }; yield { type: 'done', stopReason: truncated ? 'length' : 'stop' }; }
  } }) };
  let controller = new ProjectInitiativeController(store, options);
  t.after(async () => { await controller.close(); rmSync(dir, { recursive: true, force: true }); });
  const set = fn => { store.mutate(state => fn(state.projects.find(row => row.id === project.id), state)); controller.schedule(); };
  return { store, project, session, dir, set, now: () => now, current: () => store.state.projects.find(row => row.id === project.id), controller: () => controller, calls: () => calls, advance: delta => { now += delta; controller.schedule(); }, messages: () => store.state.sessions.flatMap(s => s.items.filter(item => item.scheduleOccurrenceKey).map(item => ({ ...item, sessionId: s.id }))), restart: async () => { await controller.close(); controller = new ProjectInitiativeController(store, options); }, until: async check => { await until(check, 'scheduled outcome'); } };
}
test('due calendar task spans settled slices in one journal, meters beyond 12k and delivers once to configured session', async t => {
  const app = await fixture(t);
  await app.until(() => app.current().scheduleRuntime?.occurrences[0]?.status === 'delivered');
  assert.equal(app.calls(), 3); assert.equal(app.messages().length, 1); assert.equal(app.messages()[0].sessionId, app.session.id);
  assert.equal(app.current().scheduleRuntime.deliveredCount, 1, 'only the persisted conversation delivery counts');
  assert.equal(app.current().initiative.tokens, 45030); assert.equal(app.store.state.realUsage.tokens, 45030);
  const job = app.current().jobs[0]; assert.equal(job.status, 'completed'); assert.equal(job.usage.totalTokens, 45030);
  const journal = readFileSync(job.runtimeFile, 'utf8'); assert.equal(journal.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'run_yielded').length, 2);
  assert.equal(app.current().schedules[0].nextRunAt, '2026-09-27T01:00:00.000Z');
  await app.restart(); await delay(50); assert.equal(app.calls(), 3); assert.equal(app.messages().length, 1);
  assert.equal(app.current().scheduleRuntime.deliveredCount, 1, 'restart and repeated polls do not count the same occurrence again');
});
test('a delivery held by quiet time is retained independently of completed work and resumes without another model call', async t => {
  const app = await fixture(t, { held: true });
  await app.until(() => app.current().scheduleRuntime?.occurrences[0]?.status === 'delivery_pending');
  assert.equal(app.calls(), 3); assert.equal(app.messages().length, 0);
  assert.equal(app.current().scheduleRuntime.deliveredCount ?? 0, 0, 'completed work awaiting delivery is not delivered coverage');
  app.set(project => { project.initiative.quietUntil = null; });
  await app.until(() => app.messages().length === 1); assert.equal(app.calls(), 3);
  await app.until(() => app.current().scheduleRuntime.deliveredCount === 1);
});
test('foreground ownership defers due work without losing or duplicating occurrence', async t => {
  const app = await fixture(t, { busy: true }); await delay(30); assert.equal(app.calls(), 0); assert.equal(app.current().scheduleRuntime?.occurrences.length ?? 0, 0);
  app.store.mutate(state => { const s = state.sessions.find(row => row.id === app.session.id); s.activeTurnId = null; s.turns[0].status = 'completed'; }); app.controller().schedule();
  await app.until(() => app.messages().length === 1); assert.equal(app.calls(), 3);
});
test('global and project token gates defer scheduled admission without spending or losing the due key', async t => {
  const app = await fixture(t, { budget: 0 });
  await app.until(() => app.current().initiativeRuntime?.sdkState?.actions[0]?.deferredReason === 'budget_exhausted');
  const key = app.current().scheduleRuntime.occurrences[0].key; assert.equal(app.calls(), 0);
  app.store.mutate(state => { state.projects.find(row => row.id === app.project.id).initiative.tokenBudget = null; }); app.controller().schedule();
  await app.until(() => app.messages().length === 1); assert.equal(app.current().scheduleRuntime.occurrences[0].key, key); assert.equal(app.calls(), 3);
});
test('a failed paid scheduled request is recorded, not delivered or automatically retried', async t => {
  const app = await fixture(t, { fail: true });
  await app.until(() => app.current().scheduleRuntime?.occurrences[0]?.status === 'failed');
  assert.equal(app.calls(), 1); assert.equal(app.messages().length, 0); assert.equal(app.current().jobs[0].status, 'failed'); assert.equal(app.store.state.realUsage.tokens, 15010);
  assert.equal(app.current().scheduleRuntime.deliveredCount ?? 0, 0);
  app.controller().schedule(); await delay(50); await app.restart(); await delay(50); assert.equal(app.calls(), 1); assert.equal(app.messages().length, 0);
});
test('deleting a held schedule revokes only undelivered result and never redirects to primary session', async t => {
  const app = await fixture(t, { held: true }); await app.until(() => app.current().scheduleRuntime?.occurrences[0]?.status === 'delivery_pending');
  app.set(p => { p.schedules = []; p.initiative.quietUntil = null; });
  await app.until(() => app.current().scheduleRuntime.occurrences[0].status === 'cancelled');
  assert.equal(app.messages().length, 0); assert.equal(app.calls(), 3);
  assert.equal(app.current().scheduleRuntime.deliveredCount ?? 0, 0);
});

test('global allowance zero prevents all scheduled requests and permits later admission of the same occurrence', async t => {
  const app = await fixture(t, { globalBudget: 0 });
  await app.until(() => app.current().initiativeRuntime?.sdkState?.actions[0]?.deferredReason === 'budget_exhausted');
  const key = app.current().scheduleRuntime.occurrences[0].key; assert.equal(app.calls(), 0);
  app.store.mutate(state => { state.settings.realTokenBudget = null; }); app.controller().schedule();
  await app.until(() => app.messages().length === 1); assert.equal(app.current().scheduleRuntime.occurrences[0].key, key);
});
test('a truncated scheduled final message is a failed result, never a completed delivery', async t => {
  const app = await fixture(t, { truncated: true });
  await app.until(() => app.current().scheduleRuntime?.occurrences[0]?.status === 'failed');
  assert.equal(app.calls(), 3); assert.equal(app.messages().length, 0); assert.equal(app.current().jobs[0].status, 'failed');
});
test('restart with an admitted unknown scheduled operation quarantines its occurrence and future windows', async t => {
  const app = await fixture(t, { held: true }); await app.until(() => app.current().scheduleRuntime?.occurrences[0]?.status === 'delivery_pending');
  await app.controller().close();
  app.store.mutate(state => {
    const p = state.projects.find(row => row.id === app.project.id), occurrence = p.scheduleRuntime.occurrences[0];
    p.initiativeRuntime.sdkState.actions = p.initiativeRuntime.sdkState.actions.filter(row => row.id === occurrence.actionId);
    const action = p.initiativeRuntime.sdkState.actions[0]; action.status = 'running'; delete action.finishedAt; delete action.resultSummary;
    p.jobs[0].status = 'running'; occurrence.status = 'running'; delete occurrence.deliveryActionId;
  });
  await app.restart(); await app.until(() => app.current().scheduleRuntime.occurrences[0].status === 'needs_review');
  app.advance(3 * 86400000); await delay(50);
  assert.equal(app.calls(), 3); assert.equal(app.messages().length, 0); assert.equal(app.current().scheduleRuntime.occurrences.length, 1);
  assert.equal(app.current().initiativeRuntime.sdkState.actions[0].blocksExecution, true);
});
test('archiving the configured destination cancels pending delivery without sending into another project conversation', async t => {
  const app = await fixture(t, { held: true }); await app.until(() => app.current().scheduleRuntime?.occurrences[0]?.status === 'delivery_pending');
  app.set((p, state) => { state.sessions.find(row => row.id === app.session.id).archivedAt = new Date().toISOString(); p.initiative.quietUntil = null; });
  await app.until(() => app.current().scheduleRuntime.occurrences[0].status === 'cancelled');
  assert.equal(app.messages().length, 0); assert.equal(app.calls(), 3);
});

test('an actual schedule action id reaches the existing HTTP explicit-outcome route without replay or resume', async t => {
  const app = await fixture(t, { held: true }); await app.until(() => app.current().scheduleRuntime?.occurrences[0]?.status === 'delivery_pending');
  await app.controller().close(); const actionId = app.current().scheduleRuntime.occurrences[0].actionId;
  assert.match(actionId, /^[a-zA-Z0-9-]+$/);
  app.store.mutate(state => { const p = state.projects.find(row => row.id === app.project.id); p.initiative.enabled = false; const action = p.initiativeRuntime.sdkState.actions.find(row => row.id === actionId); action.status = 'needs_review'; action.blocksExecution = true; p.jobs[0].status = 'needs_review'; });
  const server = createServer({ stateFile: app.store.file, ticks: false, runtime: false, initiative: true, initiativeOptions: { initialDelayMs: 60000, tickIntervalMs: 0, decisionProvider: async function* () { throw new Error('No model request permitted'); } } });
  await server.initializer.close(); await new Promise(resolve => server.server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.server.address().port}/api/projects/${app.project.id}/initiative/actions/${actionId}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'not-executed', summary: 'Isolated fixture: journal and process inspected; no remaining execution.' }) });
    assert.equal(response.status, 200); const receipt = await response.json(); assert.equal(receipt.id, actionId); assert.equal(receipt.status, 'cancelled');
    assert.equal(server.store.state.projects.find(row => row.id === app.project.id).initiative.enabled, false); assert.equal(app.calls(), 3);
  } finally { await server.close(); }
});

// B4 (plan §1.3 E, F9): mute means pause, the occurrence key names the window, and there is no late backlog.
const DAY = 86400000;
const settle = async app => { for (let i = 0; i < 4; i++) { app.controller().schedule(); await delay(15); await app.controller().pendingPump; } };
const rowsOf = app => () => app.current().scheduleRuntime?.occurrences ?? [];
test('F9 mute is a pause: nothing is claimed or run while muted, only the latest due window is kept as skipped, and after unmute only it runs', async t => {
  const app = await fixture(t, { muted: true }), rows = rowsOf(app);
  await app.until(() => rows()[0]?.status === 'skipped'); await settle(app);
  assert.equal(app.calls(), 0, 'no paid run while muted'); assert.equal(app.messages().length, 0);
  assert.deepEqual(rows().map(row => [row.scheduledAt, row.status, row.errorCode]), [['2026-09-26T01:00:00.000Z', 'skipped', 'notifications_muted']]);
  assert.equal(app.current().schedules[0].nextRunAt, '2026-09-27T01:00:00.000Z', 'the schedule moves on, so a muted window is not left due for hours');
  app.advance(DAY); await app.until(() => rows()[0]?.scheduledAt === '2026-09-27T01:00:00.000Z'); await settle(app);
  assert.deepEqual(rows().map(row => [row.scheduledAt, row.status]), [['2026-09-27T01:00:00.000Z', 'skipped']], 'only the latest skipped window is kept');
  assert.equal(app.calls(), 0);
  const key = rows()[0].key;
  app.set(project => { project.initiative.notificationMuted = false; });
  await app.until(() => rows()[0]?.status === 'delivered'); await settle(app);
  assert.equal(app.calls(), 3, 'one run after unmute: the latest window only');
  assert.equal(app.messages().length, 1); assert.equal(app.messages()[0].scheduleOccurrenceKey, key, 'the skipped window itself ran');
  assert.equal(rows().length, 1); assert.ok(rows()[0].resumedAt);
  assert.equal(app.current().schedules[0].nextRunAt, '2026-09-28T01:00:00.000Z');
});
test('F9: a window skipped while muted does not run once the next window has opened; only the newest one does', async t => {
  const app = await fixture(t, { muted: true }), rows = rowsOf(app);
  await app.until(() => rows()[0]?.status === 'skipped');
  // Unmuted two days later, with no pump in between: the newest window is due, the skipped one is past its period.
  app.advance(2 * DAY); app.set(project => { project.initiative.notificationMuted = false; });
  await app.until(() => app.messages().length === 1); await settle(app);
  assert.equal(app.calls(), 3, 'one run, no backlog');
  assert.deepEqual(rows().map(row => [row.scheduledAt, row.status]), [['2026-09-26T01:00:00.000Z', 'skipped'], ['2026-09-28T01:00:00.000Z', 'delivered']]);
});
test('F9: a run already in flight when mute starts is delivered to the inbox only, not held until unmute and never posted into the idle conversation', async t => {
  const gate = opening(), app = await fixture(t, { gate });
  await app.until(() => app.calls() === 1);
  app.set(project => { project.initiative.notificationMuted = true; }); gate.open();
  await app.until(() => app.current().scheduleRuntime?.occurrences[0]?.status === 'delivered'); await settle(app);
  assert.equal(app.calls(), 3);
  assert.equal(app.messages().length, 0, 'paused: nothing new appears in the conversation, although it was idle');
  const occurrence = app.current().scheduleRuntime.occurrences[0], entry = app.current().inbox.find(row => row.id === occurrence.deliveryInboxId);
  assert.equal(entry.tier, 'inbox'); assert.deepEqual(entry.reachReasons, ['notification_muted']); assert.equal(entry.scheduled, true); assert.equal(entry.itemId, null);
  assert.match(entry.text, /seven sources/); assert.equal(occurrence.deliveryItemId, null);
  app.set(project => { project.initiative.notificationMuted = false; }); await settle(app);
  assert.equal(app.messages().length, 0, 'not posted late after the unmute either'); assert.equal(app.current().inbox.find(row => row.id === entry.id).itemId, null);
  assert.equal(app.calls(), 3); assert.equal(app.current().scheduleRuntime.deliveredCount, 1);
});
test('F9: a quiet scheduled delivery filed in the inbox (the user typing) settles its occurrence and stays in the inbox, never posted late or elsewhere', async t => {
  const gate = opening(), app = await fixture(t, { gate });
  await app.until(() => app.calls() === 1);
  app.store.presences.set(app.project.id, { sessionId: app.session.id, typing: true, visible: true, expiresAt: QUIET });
  app.set(project => { project.initiative.notificationMuted = true; }); gate.open();
  await app.until(() => app.current().scheduleRuntime?.occurrences[0]?.status === 'delivered');
  const occurrence = app.current().scheduleRuntime.occurrences[0], entry = app.current().inbox.find(row => row.id === occurrence.deliveryInboxId);
  assert.equal(entry.tier, 'inbox'); assert.equal(entry.scheduled, true); assert.equal(entry.itemId, null); assert.equal(occurrence.deliveryItemId, null);
  assert.equal(app.current().scheduleRuntime.deliveredCount, 1, 'the inbox entry is its delivery receipt');
  app.store.presences.delete(app.project.id); await settle(app);
  assert.ok(!app.store.state.sessions.some(row => row.items.some(item => item.initiativeDeliveryKey === `filed-share:${entry.id}`)), 'not posted into the conversation in front of the user later');
  assert.equal(app.current().inbox.find(row => row.id === entry.id).itemId, null);
  assert.equal(app.calls(), 3); assert.equal(app.current().scheduleRuntime.deliveredCount, 1);
});
test('the occurrence identity survives a title edit: a running scheduled run is not revoked and delivers once', async t => {
  const gate = opening(), app = await fixture(t, { gate });
  await app.until(() => app.calls() === 1);
  new ProjectScheduleService(app.store, { now: app.now }).update(app.project.id, 'review', { title: 'Renamed daily report' }); gate.open();
  await app.until(() => app.current().scheduleRuntime?.occurrences[0]?.status === 'delivered'); await settle(app);
  assert.equal(app.calls(), 3); assert.equal(app.messages().length, 1);
  assert.deepEqual([app.current().schedules[0].revision, app.current().schedules[0].executionRevision], [2, 1]);
});
test('changing what a running occurrence performs (its task) still revokes it', async t => {
  const gate = opening(), app = await fixture(t, { gate });
  await app.until(() => app.calls() === 1);
  new ProjectScheduleService(app.store, { now: app.now }).update(app.project.id, 'review', { task: 'Inspect another file instead.' }); gate.open();
  await app.until(() => ['needs_review', 'cancelled'].includes(app.current().scheduleRuntime?.occurrences[0]?.status)); await settle(app);
  assert.equal(app.messages().length, 0); assert.equal(app.current().scheduleRuntime.occurrences[0].errorCode, 'schedule_revoked');
});
test('F9: a result that waited a whole period for delivery expires to the inbox; the next window runs and nothing is posted late', async t => {
  const app = await fixture(t, { held: true }), rows = rowsOf(app);
  await app.until(() => rows()[0]?.status === 'delivery_pending'); assert.ok(rows()[0].pendingSince);
  app.advance(DAY);
  await app.until(() => rows()[0]?.status === 'expired');
  const entry = app.current().inbox.find(row => row.id === rows()[0].deliveryInboxId);
  assert.equal(entry.expired, true); assert.equal(entry.tier, 'inbox'); assert.equal(entry.itemId, null); assert.match(entry.text, /seven sources/);
  await app.until(() => rows()[1]?.status === 'delivery_pending');
  assert.equal(rows()[1].scheduledAt, '2026-09-27T01:00:00.000Z', 'the schedule is not blocked by the stale result'); assert.equal(app.calls(), 6);
  app.set(project => { project.initiative.quietUntil = null; });
  await app.until(() => app.messages().length === 1); await settle(app);
  assert.equal(app.messages().length, 1); assert.equal(app.messages()[0].scheduleOccurrenceKey, rows()[1].key, 'only the current result reaches the conversation');
  assert.equal(app.current().inbox.find(row => row.id === entry.id).itemId, null, 'the expired result is never posted late');
});
test('no late backlog: a claim that could not start before the next window opened is skipped, and only the newest window runs', async t => {
  const app = await fixture(t, { budget: 0 }), rows = rowsOf(app);
  await app.until(() => app.current().initiativeRuntime?.sdkState?.actions[0]?.deferredReason === 'budget_exhausted');
  app.advance(DAY);
  await app.until(() => rows()[0]?.status === 'skipped' && rows()[1]?.status === 'queued');
  assert.equal(rows()[0].errorCode, 'window_passed'); assert.equal(rows()[1].scheduledAt, '2026-09-27T01:00:00.000Z');
  assert.equal(app.current().initiativeRuntime.sdkState.actions.find(row => row.id === rows()[0].actionId).status, 'cancelled');
  app.set(project => { project.initiative.tokenBudget = null; });
  await app.until(() => app.messages().length === 1); await settle(app);
  assert.equal(app.calls(), 3, 'the stale window never ran'); assert.equal(app.messages().length, 1); assert.equal(app.messages()[0].scheduleOccurrenceKey, rows()[1].key);
});
test('the key names the window: a window already handled is never claimed again, the schedule only moves on', async t => {
  const app = await fixture(t), rows = rowsOf(app);
  await app.until(() => rows()[0]?.status === 'delivered');
  // A due instant pointing back at the delivered window (as an edit that kept a stale due instant could leave it).
  app.set(project => { project.schedules[0].nextRunAt = '2026-09-26T01:00:00.000Z'; });
  await app.until(() => app.current().schedules[0].nextRunAt === '2026-09-27T01:00:00.000Z'); await settle(app);
  assert.equal(rows().length, 1); assert.equal(app.calls(), 3); assert.equal(app.messages().length, 1);
});
// Review fixes (B4): a claim waiting in the SDK queue pauses too; switching a schedule off and on drops its skipped
// window; claims a rolled-back 0.68 made stay current; a wall clock stepped back keeps a queued claim.
test('F9: a run claimed before the mute but not started (held on budget) does not start while muted; after the unmute it runs once', async t => {
  const app = await fixture(t, { budget: 0 }), rows = rowsOf(app);
  await app.until(() => app.current().initiativeRuntime?.sdkState?.actions[0]?.deferredReason === 'budget_exhausted');
  app.set(project => { project.initiative.notificationMuted = true; }); await settle(app);
  app.set(project => { project.initiative.tokenBudget = null; }); app.advance(60000);
  await app.until(() => app.current().initiativeRuntime.sdkState.actions.find(row => row.id === rows()[0].actionId)?.deferredReason === 'notification_muted');
  await delay(1500); await settle(app);
  assert.equal(app.calls(), 0, 'no paid run while muted'); assert.equal(app.messages().length, 0); assert.equal(rows()[0].status, 'queued');
  assert.equal((app.current().inbox ?? []).length, 0);
  app.set(project => { project.initiative.notificationMuted = false; });
  await app.until(() => rows()[0]?.status === 'delivered'); await settle(app);
  assert.equal(app.calls(), 3); assert.equal(app.messages().length, 1); assert.equal(rows().length, 1);
});
test('F9: switching a schedule off and on while muted drops the skipped window: after the unmute nothing is caught up', async t => {
  const app = await fixture(t, { muted: true }), rows = rowsOf(app), service = new ProjectScheduleService(app.store, { now: app.now });
  await app.until(() => rows()[0]?.status === 'skipped'); await settle(app);
  service.update(app.project.id, 'review', { enabled: false }); app.advance(60000); await settle(app);
  service.update(app.project.id, 'review', { enabled: true }); app.advance(60000); await settle(app);
  assert.equal(app.current().schedules[0].nextRunAt, '2026-09-27T01:00:00.000Z', 'switching back on starts from now');
  app.set(project => { project.initiative.notificationMuted = false; });
  await delay(300); await settle(app);
  assert.equal(app.calls(), 0, 'the window the pause skipped is not run'); assert.equal(app.messages().length, 0);
  assert.deepEqual(rows().map(row => [row.scheduledAt, row.status, row.errorCode]), [['2026-09-26T01:00:00.000Z', 'skipped', 'notifications_muted']]);
});
test('F9: a title edit while muted keeps the skipped window: after the unmute it still runs once', async t => {
  const app = await fixture(t, { muted: true }), rows = rowsOf(app);
  await app.until(() => rows()[0]?.status === 'skipped'); await settle(app);
  new ProjectScheduleService(app.store, { now: app.now }).update(app.project.id, 'review', { title: 'Renamed daily report' }); app.advance(60000); await settle(app);
  app.set(project => { project.initiative.notificationMuted = false; });
  await app.until(() => rows()[0]?.status === 'delivered'); await settle(app);
  assert.equal(app.calls(), 3); assert.equal(app.messages().length, 1); assert.ok(rows()[0].resumedAt);
});
// A claim 0.68 made after a rollback: it carries the record revision and no execution revision (0.68 claim shape).
const legacyClaim = app => app.store.mutate(state => {
  const project = state.projects.find(row => row.id === app.project.id), schedule = project.schedules[0], scheduledAt = '2026-09-26T01:00:00.000Z';
  project.scheduleRuntime = { schemaVersion: 1, occurrences: [{ key: 'schedule:review:claimed-by-0.68', scheduledAt, nextRunAt: '2026-09-27T01:00:00.000Z', coalescedFrom: null, scheduleId: schedule.id, scheduleRevision: schedule.revision, claimedAt: scheduledAt, status: 'queued', actionId: 'schedule-work-claimed-by-0-68' }] };
  schedule.nextRunAt = '2026-09-27T01:00:00.000Z';
});
const foreground = (app, busy) => app.store.mutate(state => { const session = state.sessions.find(row => row.id === app.session.id); if (busy) { session.activeTurnId = 'foreground'; session.turns.push({ id: 'foreground', status: 'running' }); } else { session.activeTurnId = null; session.turns.at(-1).status = 'completed'; } });
test('a claim a rolled-back 0.68 made after a rename here stays current on the roll-forward and delivers once', async t => {
  const app = await fixture(t, { busy: true }), rows = rowsOf(app);
  await delay(30); assert.equal(rows().length, 0);
  new ProjectScheduleService(app.store, { now: app.now }).update(app.project.id, 'review', { title: 'Renamed daily report' });
  legacyClaim(app); foreground(app, false); app.controller().schedule();
  await app.until(() => ['delivered', 'cancelled', 'needs_review'].includes(rows()[0]?.status)); await settle(app);
  assert.deepEqual([rows()[0].status, rows()[0].errorCode], ['delivered', null], 'the rename before the claim is not a change to what it performs');
  assert.equal(app.calls(), 3); assert.equal(app.messages().length, 1);
});
test('a task edit here after a 0.68 claim started still revokes it, although its revision number equals the execution revision a counter would reach', async t => {
  const gate = opening(), app = await fixture(t, { busy: true, gate }), rows = rowsOf(app), service = new ProjectScheduleService(app.store, { now: app.now });
  await delay(30);
  service.update(app.project.id, 'review', { title: 'Renamed daily report' });
  legacyClaim(app); foreground(app, false); app.controller().schedule();
  await app.until(() => app.calls() === 1);
  service.update(app.project.id, 'review', { task: 'Inspect another file instead.' }); gate.open();
  await app.until(() => ['needs_review', 'cancelled'].includes(rows()[0]?.status)); await settle(app);
  assert.equal(rows()[0].errorCode, 'schedule_revoked'); assert.equal(app.messages().length, 0);
});
test('a queued claim survives a wall clock stepped back behind its window, and runs', async t => {
  const app = await fixture(t, { budget: 0 }), rows = rowsOf(app);
  await app.until(() => app.current().initiativeRuntime?.sdkState?.actions[0]?.deferredReason === 'budget_exhausted');
  app.advance(-60000); await settle(app);
  assert.equal(rows()[0].status, 'queued', 'no later window opened, so it is not skipped');
  app.set(project => { project.initiative.tokenBudget = null; });
  await app.until(() => rows()[0]?.status === 'delivered'); await settle(app);
  assert.equal(app.calls(), 3); assert.equal(app.messages().length, 1);
});
