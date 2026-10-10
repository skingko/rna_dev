import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.mjs';

const execute = promisify(execFile), cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
async function fixture(t, { initiative = true, active = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-action-resolution-')); let modelCalls = 0, requests = 0;
  const app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false, initiative,
    initiativeOptions: { tickIntervalMs: 0, initialDelayMs: 60000, decisionProvider: async function* () { modelCalls++; throw new Error('Resolution must not invoke a model'); } } });
  await app.initializer.close();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  // The CLI's interface-language read (cli-language.mjs, GET /api/health before printing its own error) submits nothing.
  app.server.on('request', request => { if (!(request.method === 'GET' && request.url === '/api/health')) requests++; });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  if (active) {
    const provider = app.store.configurationService.provider(null, { name: 'Isolated resolution fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 3000, reasoning: ['off'] }] });
    app.store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  }
  const { project, session } = app.store.createProject({ rhythm: { control: 'manual' }, name: 'Inspect an uncertain action', initiative: { enabled: false } }), actionId = randomUUID();
  app.store.mutate(state => {
    const value = state.projects.find(p => p.id === project.id);
    value.initiative.enabled = active;
    if (active) { value.decisionMode = 'rna-model'; value.simulated = false; value.initialization = { status: 'ready' }; }
    value.initiativeRuntime = { status: 'paused', sdkState: { schemaVersion: 1, revision: 1, actions: [{ id: actionId, action: 'work', status: 'needs_review', blocksExecution: true, evidenceIds: [], createdAt: Date.now(), reasonForReview: 'Original operation outcome requires inspection' }], events: [], seenEventIds: [], usedTokens: 0, reservedTokens: 0 } };
    value.jobs = [{ id: actionId, projectId: project.id, kind: 'research', lane: 'background', status: 'needs_review', simulated: false }];
  });
  if (active) {
    const deadline = Date.now() + 5000;
    while (!app.projectInitiative.contexts.get(project.id)?.initialized) { if (Date.now() > deadline) throw new Error('Active controller did not initialize'); await delay(10); }
  }
  const base = `http://127.0.0.1:${app.server.address().port}`, path = `/api/projects/${project.id}/initiative/actions/${actionId}/resolve`;
  const call = async (body, options = {}) => { const response = await fetch(`${base}${options.path ?? path}`, { method: options.method ?? 'POST', headers: { 'Content-Type': 'application/json', ...options.headers }, ...(options.method === 'GET' ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, value: await response.json() }; };
  const invoke = (...args) => execute(process.execPath, [cli, ...args], { env: { ...process.env, RNA_AGENT_PORT: String(app.server.address().port) }, timeout: 10000 });
  const current = () => app.store.state.projects.find(p => p.id === project.id);
  return { ...app, project, session, actionId, base, path, call, invoke, current, modelCalls: () => modelCalls, requests: () => requests };
}

test('HTTP explicit action resolution preserves a paused project and records the checked result without invoking a model', async t => {
  const app = await fixture(t), summary = 'Inspected the output and related processes; the action completed and no process remains.';
  const result = await app.call({ status: 'completed', summary: `  ${summary}  ` });
  assert.equal(result.status, 200); assert.equal(result.value.id, app.actionId); assert.equal(result.value.status, 'completed'); assert.equal(result.value.resultSummary, summary); assert.equal(result.value.resolutionSource, 'user'); assert.ok(result.value.resolvedAt);
  assert.equal(app.current().jobs[0].status, 'completed'); assert.equal(app.current().initiative.enabled, false); assert.equal(app.modelCalls(), 0);
  const repeat = await app.call({ status: 'not-executed', summary: 'A repeated conflicting resolution' }); assert.equal(repeat.status, 409); assert.equal(repeat.value.code, 'invalid_resolution'); assert.equal(app.current().jobs[0].status, 'completed');
});

test('CLI accepts only an explicit not-executed outcome with a non-empty inspection summary', async t => {
  const app = await fixture(t), before = app.requests();
  for (const args of [[], [app.project.id], [app.project.id, app.actionId], [app.project.id, app.actionId, '--status', 'continue', '--summary', 'checked'], [app.project.id, app.actionId, '--status', 'completed'], [app.project.id, app.actionId, '--status', 'completed', '--summary', '   '], [app.project.id, app.actionId, '--status', 'completed', '--summary', 'x'.repeat(16001)], [app.project.id, app.actionId, '--status', 'completed', '--summary', 'checked', '--force']]) {
    await assert.rejects(app.invoke('initiative-resolve', ...args), error => error.code === 1 && /Rna Agent:/.test(error.stderr));
  }
  assert.equal(app.requests(), before, 'Invalid CLI input must not submit any confirmation');
  const result = JSON.parse((await app.invoke('initiative-resolve', app.project.id, app.actionId, '--status', 'not-executed', '--summary', 'Inspected journal and external state; this action did not execute.')).stdout);
  assert.equal(result.status, 'cancelled'); assert.equal(result.resolutionSource, 'user'); assert.equal(app.current().jobs[0].status, 'cancelled'); assert.equal(app.current().initiative.enabled, false); assert.equal(app.modelCalls(), 0);
});

test('HTTP invalid input, unknown identities, other methods and foreign origins cannot resolve an action', async t => {
  const app = await fixture(t);
  for (const input of [{}, { status: 'continue', summary: 'checked' }, { status: 'completed' }, { status: 'completed', summary: ' ' }, { status: 'completed', summary: 'x'.repeat(16001) }]) {
    const result = await app.call(input); assert.equal(result.status, 400); assert.equal(result.value.code, 'invalid_resolution');
  }
  const unknownAction = await app.call({ status: 'completed', summary: 'checked' }, { path: app.path.replace(app.actionId, randomUUID()) }); assert.equal(unknownAction.status, 404); assert.equal(unknownAction.value.code, 'action_not_found');
  const unknownProject = await app.call({ status: 'completed', summary: 'checked' }, { path: app.path.replace(app.project.id, randomUUID()) }); assert.equal(unknownProject.status, 404); assert.equal(unknownProject.value.code, 'project_not_found');
  assert.equal((await app.call({}, { method: 'GET' })).status, 404);
  assert.equal((await app.call({ status: 'completed', summary: 'checked' }, { headers: { Origin: 'http://untrusted.example' } })).status, 403);
  assert.equal(app.current().initiativeRuntime.sdkState.actions[0].status, 'needs_review'); assert.equal(app.modelCalls(), 0);
});

test('ordinary continue messages and enabling initiative do not count as outcome confirmation', async t => {
  const app = await fixture(t);
  await app.invoke('send', app.session.id, '继续'); await app.invoke('initiative', app.project.id, 'resume');
  assert.equal(app.current().initiativeRuntime.sdkState.actions[0].status, 'needs_review'); assert.equal(app.current().jobs[0].status, 'needs_review'); assert.equal(app.modelCalls(), 0);
});

test('disabled or closed initiative controllers fail explicitly rather than pretend to confirm a result', async t => {
  const disabled = await fixture(t, { initiative: false }), result = await disabled.call({ status: 'completed', summary: 'checked' });
  assert.equal(result.status, 503); assert.equal(result.value.code, 'initiative_unavailable'); assert.equal(disabled.current().initiativeRuntime.sdkState.actions[0].status, 'needs_review');
  const closed = await fixture(t); await closed.projectInitiative.close(); const unavailable = await closed.call({ status: 'completed', summary: 'checked' });
  assert.equal(unavailable.status, 503); assert.equal(unavailable.value.code, 'closed'); assert.equal(closed.current().initiativeRuntime.sdkState.actions[0].status, 'needs_review');
});

test('HTTP health reports an unresolved execution block as degraded until explicit resolution', async t => {
  const app = await fixture(t, { active: true });
  const health = async () => (await fetch(`${app.base}/api/health`)).json();
  const blocked = await health();
  assert.equal(blocked.ok, false); assert.equal(blocked.autonomyDegraded, true);
  assert.equal(blocked.scheduler.initiative.projects.find(project => project.projectId === app.project.id).executionBlocked, true);
  assert.equal((await app.call({ status: 'completed', summary: 'Verified completion and that the original process has exited.' })).status, 200);
  const resolved = await health();
  assert.equal(resolved.ok, true); assert.equal(resolved.autonomyDegraded, false);
  assert.equal(resolved.scheduler.initiative.projects.find(project => project.projectId === app.project.id).executionBlocked, false);
  assert.equal(app.current().initiative.enabled, true); assert.equal(app.modelCalls(), 0);
});

test('CLI verified cancellation keeps original uncertainty and output, without claiming the action never executed', async t => {
  const app = await fixture(t);
  app.store.mutate(state => { const p = state.projects.find(p => p.id === app.project.id); p.jobs[0].output = 'Original partial output and cleanup uncertainty'; p.jobs[0].errorCode = 'uncertain_tool'; Object.assign(p.initiativeRuntime.sdkState.actions[0], { errorCode: 'uncertain_tool', failure: { code: 'uncertain_tool', message: 'Original diagnostic' } }); });
  const result = JSON.parse((await app.invoke('initiative-resolve', app.project.id, app.actionId, '--status', 'cancelled', '--summary', 'Inspected original processes; they have ended. Partial output was not validated.')).stdout);
  assert.equal(result.status, 'cancelled'); assert.equal(result.resolutionOutcome, 'cancelled'); assert.equal(result.errorCode, 'uncertain_tool'); assert.equal(result.failure.message, 'Original diagnostic');
  assert.equal(app.current().jobs[0].output, 'Original partial output and cleanup uncertainty'); assert.equal(app.current().jobs[0].resolutionOutcome, 'cancelled'); assert.equal(app.modelCalls(), 0);
});

test('HTTP refuses to confirm cancellation while an underlying operation remains active or unsettled', async t => {
  const app = await fixture(t, { active: true }), context = app.projectInitiative.contexts.get(app.project.id);
  for (const collection of [context.coordinator.active, context.coordinator.unsettled, context.activeHandles]) {
    const marker = {}; if (collection instanceof Map) collection.set('fixture-running', marker); else collection.add(marker);
    try { const response = await app.call({ status: 'cancelled', summary: 'Premature confirmation' }); assert.equal(response.status, 409); assert.equal(response.value.code, 'action_still_running'); }
    finally { if (collection instanceof Map) collection.delete('fixture-running'); else collection.delete(marker); }
  }
  assert.equal(app.current().initiativeRuntime.sdkState.actions[0].status, 'needs_review');
  const response = await app.call({ status: 'cancelled', summary: 'The original operation is now verified to have ended; no success claimed.' });
  assert.equal(response.status, 200); assert.equal(response.value.resolutionOutcome, 'cancelled'); assert.equal(app.modelCalls(), 0);
});
