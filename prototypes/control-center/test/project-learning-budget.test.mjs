import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { ProjectLearningBudget, remainingInitiativeTokenBudget } from '../project-learning-budget.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { chargeRealTokens, reserveRealTokens } from '../budget-service.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-learning-budget-')), file = join(directory, 'state.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(file), { project } = store.createProject({ name: 'Budget fixture', workspace: directory });
  const budget = new ProjectLearningBudget(store, project.id);
  return { store, file, projectId: project.id, budget, current: () => store.state.projects.find(row => row.id === project.id), usage: () => store.state.projects.find(row => row.id === project.id).learningRuntime?.usage };
}
async function normalSave(app, usedTokens, reservedTokens, admission = true) {
  const host = Object.create(ProjectInitiativeController.prototype); host.store = app.store; host.now = Date.now;
  const previous = app.current().initiativeRuntime?.sdkState;
  const context = { projectId: app.projectId, scope: 'fixture', accountedUsed: previous?.usedTokens ?? 0, accountedEstimated: 0, terminalSourceIdentity: {}, coordinator: { model: { providerId: 'test', modelId: 'test' } } };
  await host.save(context, { usedTokens, estimatedTokens: 0, reservedTokens, actions: [], nextReviewAt: 0 }, { reservationAdmission: admission });
}

test('learning shares project and global admission with the normal lane in either reservation order', async t => {
  const app = fixture(t);
  app.store.mutate(state => { state.settings.realTokenBudget = 100; const project = state.projects.find(row => row.id === app.projectId); project.initiative.tokenBudget = 100; });
  await normalSave(app, 20, 30);
  app.budget.beforeRequest({ phase: 'proposal', estimatedTokens: 50 });
  assert.equal(remainingInitiativeTokenBudget(app.current()), 50);
  await assert.rejects(normalSave(app, 20, 31), { code: 'budget' });
  assert.equal(app.store.state.realUsage.tokens, 20); assert.equal(app.store.state.realUsage.reservedTokens, 80);
  app.budget.onUsage({ usage: { totalTokens: 10 }, requestStarted: true, completed: true });
  await normalSave(app, 20, 70);
  assert.throws(() => app.budget.beforeRequest({ phase: 'judge', estimatedTokens: 1 }), { code: 'budget' });
  assert.equal(app.current().initiative.tokens, 30); assert.equal(app.store.state.realUsage.tokens, 30);
  await normalSave(app, 25, 0, false);
  assert.equal(app.current().initiative.tokens, 35); assert.equal(app.store.state.realUsage.tokens, 35);
});

test('a global cap also includes other projects and foreground requests when project learning is unlimited', t => {
  const app = fixture(t); app.store.mutate(state => { state.settings.realTokenBudget = 100; reserveRealTokens(state, 'request:foreground', 60); });
  assert.equal(remainingInitiativeTokenBudget(app.current()), null);
  assert.throws(() => app.budget.beforeRequest({ estimatedTokens: 41 }), { code: 'budget' });
  app.budget.beforeRequest({ estimatedTokens: 40 }); app.budget.onUsage({ usage: { input: 5, output: 7 }, requestStarted: true });
  assert.equal(app.store.state.realUsage.tokens, 12); assert.equal(app.store.state.realUsage.reservedTokens, 60);
});

test('real usage is settled after pause or lowered caps, with receipt idempotency and no next admission', t => {
  const app = fixture(t); app.budget.beforeRequest({ estimatedTokens: 70, phase: 'baseline' });
  app.store.mutate(state => { state.settings.realTokenBudget = 1; const project = state.projects.find(row => row.id === app.projectId); project.initiative.tokenBudget = 1; project.initiative.enabled = false; });
  const entry = { usage: { totalTokens: 90 }, usageReported: true, requestStarted: true, completed: false };
  app.budget.onUsage(entry); app.budget.onUsage(structuredClone(entry));
  assert.equal(app.usage().totalTokens, 90); assert.equal(app.usage().reportedTokens, 90); assert.equal(app.store.state.realUsage.tokens, 90); assert.equal(app.store.state.realUsage.reservedTokens, 0);
  assert.throws(() => app.budget.beforeRequest({ estimatedTokens: 1 }), { code: 'budget' });
});

test('explicit cancellation before dispatch releases reservation at zero, but known provider usage is never discarded', t => {
  const app = fixture(t), abort = new AbortController(); abort.abort();
  assert.throws(() => app.budget.beforeRequest({ estimatedTokens: 10, signal: abort.signal }), { name: 'AbortError' });
  assert.equal(app.store.state.realUsage.reservedTokens, 0);
  app.budget.beforeRequest({ estimatedTokens: 50 });
  app.budget.onUsage({ requestStarted: false, cancelledBeforeSend: true, usageReported: false, usage: { totalTokens: 0, estimatedTokens: 0 } });
  assert.equal(app.usage().totalTokens, 0); assert.equal(app.store.state.realUsage.tokens, 0); assert.equal(app.store.state.realUsage.reservedTokens, 0);
  app.budget.beforeRequest({ estimatedTokens: 50 });
  app.budget.onUsage({ requestStarted: false, usageReported: true, usage: { totalTokens: 9 } });
  assert.equal(app.usage().reportedTokens, 9); assert.equal(app.store.state.realUsage.tokens, 9);
});

test('unknown sent requests remain estimated while reflection receipts without usageReported settle actual usage', t => {
  const app = fixture(t); app.budget.beforeRequest({ phase: 'reflection', estimatedTokens: 40 });
  app.budget.onUsage({ phase: 'reflection', requestStarted: true, estimatedWhenUnknown: true, usage: { totalTokens: 40, estimatedTokens: 40 } });
  app.budget.beforeRequest({ phase: 'reflection', estimatedTokens: 40 });
  app.budget.onUsage({ phase: 'reflection', requestStarted: true, estimatedWhenUnknown: false, usage: { totalTokens: 11, estimatedTokens: 0 } });
  assert.equal(app.usage().totalTokens, 51); assert.equal(app.usage().estimatedTokens, 40); assert.equal(app.usage().reportedTokens, 11);
  assert.equal(app.store.state.realUsage.estimatedTokens, 40); assert.equal(app.store.state.realUsage.reportedTokens, 11);
});

test('restart migration leaves learning reservation for its owner, which conservatively recovers it exactly once', t => {
  const app = fixture(t); app.budget.beforeRequest({ phase: 'candidate', estimatedTokens: 80 });
  const reopened = new Store(app.file);
  assert.equal(reopened.state.realUsage.tokens, 0); assert.equal(reopened.state.realUsage.reservedTokens, 80);
  const recovered = new ProjectLearningBudget(reopened, app.projectId);
  assert.deepEqual(recovered.recover(), { recovered: true, estimatedTokens: 80 });
  assert.deepEqual(recovered.recover(), { recovered: false, estimatedTokens: 0 });
  const again = new Store(app.file); new ProjectLearningBudget(again, app.projectId).recover();
  assert.equal(again.state.realUsage.estimatedTokens, 80); assert.equal(again.state.realUsage.reservedTokens, 0);
  const usage = again.state.projects.find(row => row.id === app.projectId).learningRuntime.usage;
  assert.equal(usage.totalTokens, 80); assert.equal(usage.recoveredRequests, 1); assert.equal(usage.activeRequest, undefined);
});

test('single flight admission is durable across budget objects and rejects before charging another request', t => {
  const app = fixture(t), second = new ProjectLearningBudget(app.store, app.projectId);
  app.budget.beforeRequest({ estimatedTokens: 0 });
  assert.throws(() => second.beforeRequest({ estimatedTokens: 1 }), { code: 'learning_request_pending' });
  app.budget.onUsage({ requestStarted: false, usage: { totalTokens: 0 } });
  second.beforeRequest({ estimatedTokens: 1 }); second.onUsage({ requestStarted: true, usage: { totalTokens: 1 } });
  assert.equal(app.store.state.realUsage.tokens, 1); assert.equal(app.usage().settledRequests, 2);
});

test('a late duplicate receipt cannot settle a subsequent request with the same phase', t => {
  const app = fixture(t);
  app.budget.beforeRequest({ id: 'first', phase: 'judge', estimatedTokens: 40 });
  const first = { id: 'first', phase: 'judge', requestStarted: true, usage: { totalTokens: 12 } };
  app.budget.onUsage(first);
  assert.throws(() => app.budget.beforeRequest({ id: 'first', estimatedTokens: 40 }), { code: 'learning_request_settled' });
  app.budget.beforeRequest({ id: 'second', phase: 'judge', estimatedTokens: 40 });
  assert.equal(app.budget.onUsage(structuredClone(first)).reason, 'different_request');
  assert.equal(app.usage().reservedTokens, 40); assert.equal(app.usage().totalTokens, 12);
  app.budget.onUsage({ id: 'second', requestStarted: true, usage: { totalTokens: 8 } });
  assert.equal(app.usage().totalTokens, 20); assert.equal(app.usage().reservedTokens, 0);
});

test('actual receipts settle globally even when the project was removed after admission', t => {
  const app = fixture(t); app.budget.beforeRequest({ estimatedTokens: 20 });
  app.store.mutate(state => { state.projects = state.projects.filter(row => row.id !== app.projectId); });
  app.budget.onUsage({ requestStarted: true, usageReported: true, usage: { totalTokens: 14 } });
  assert.equal(app.store.state.realUsage.tokens, 14); assert.equal(app.store.state.realUsage.reservedTokens, 0);
});

test('independent projects compete atomically for one global cap', t => {
  const app = fixture(t), { project } = app.store.createProject({ name: 'Second project', workspace: app.current().workspace });
  const second = new ProjectLearningBudget(app.store, project.id);
  app.store.mutate(state => { state.settings.realTokenBudget = 100; chargeRealTokens(state, 10); });
  app.budget.beforeRequest({ estimatedTokens: 50 }); second.beforeRequest({ estimatedTokens: 40 });
  assert.equal(app.store.state.realUsage.reservedTokens, 90);
  app.budget.onUsage({ requestStarted: true, usage: { totalTokens: 30 } }); second.onUsage({ requestStarted: true, usage: { totalTokens: 20 } });
  assert.equal(app.store.state.realUsage.tokens, 60); assert.equal(app.store.state.realUsage.reservedTokens, 0);
});
