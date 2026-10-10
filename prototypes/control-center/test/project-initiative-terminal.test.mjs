import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { captureSessionEvidence, scrubSessionEvidence } from '../session-evidence-cleanup.mjs';

const until = async fn => { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw new Error('Terminal fixture timed out'); await delay(5); } };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-terminal-source-')), store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Terminal fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 2048, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoStore: false, autoRecall: false } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Terminal recovery', workspace: directory });
  let clock = Date.parse('2026-01-01T00:00:00Z'), calls = 0;
  store.mutate(state => {
    const p = state.projects.find(row => row.id === project.id), s = state.sessions.find(row => row.id === session.id);
    Object.assign(p, { decisionMode: 'rna-model', initialization: { status: 'ready' }, simulated: false, assignments: { skillIds: [], toolIds: [], mcpServerIds: [] } }); state.settings.realTokenBudget = null;
    s.turns = [{ id: 'retained-turn', modelConfig: { execution: 'rna' }, status: 'failed', runtimeAttempts: 1, createdAt: new Date(clock - 1000).toISOString(), completedAt: new Date(clock).toISOString() }];
    s.items = [{ id: 'retained-message', kind: 'user', turnId: 'retained-turn', text: 'Controlled original request', createdAt: new Date(clock - 1000).toISOString() }]; s.status = 'idle'; s.activeTurnId = null;
  });
  const controllers = [], p = () => store.state.projects.find(row => row.id === project.id), s = () => store.state.sessions.find(row => row.id === session.id);
  const mutate = fn => store.mutate(state => fn(state.projects.find(row => row.id === project.id), state.sessions.find(row => row.id === session.id), state));
  const projector = Object.assign(Object.create(ProjectInitiativeController.prototype), { store, now: () => clock });
  const model = () => projector.model(p()), scope = () => projector.scope(p(), model());
  const sources = () => projector.sources(p(), scope());
  async function settle(controller) { await immediate(); await controller.pendingPump; await controller.contexts.get(project.id)?.reviewPromise; await immediate(); await controller.pendingPump; }
  async function boot({ beforePump } = {}) {
    const controller = new ProjectInitiativeController(store, { now: () => clock, initialDelayMs: 0, tickIntervalMs: 0, decisionProvider: async function* () {
      calls++; yield { type: 'text_delta', delta: JSON.stringify({ action: 'wait', content: '', reason: 'Controlled terminal review', evidenceIds: [], nextReviewAfterMs: 900000 }) }; yield { type: 'usage', usage: { totalTokens: 0 } }; yield { type: 'done', stopReason: 'stop' };
    } }); controllers.push(controller);
    if (beforePump) { clearImmediate(controller.scheduleHandle); controller.scheduleHandle = null; controller.scheduled = false; await beforePump(controller); return controller; }
    await until(() => controller.contexts.get(project.id)?.initialized); await settle(controller); return controller;
  }
  function legacy({ location = 'events', previousAt, changedScope = false } = {}) {
    const rows = sources().map(row => row.type === 'conversation_result' ? { ...row, id: 'turn:retained-turn:failed', ...(previousAt === undefined ? {} : { at: previousAt }) } : row);
    if (location === 'archive') store.archiveRecords(`initiative/${project.id}/seen`, rows.map(({ id }) => ({ id })));
    const sourceHash = changedScope ? 'obsolete-scope' : scope();
    // A changed scope is one saved by a version that splits it (scopeSchemaVersion 2) under another privacy identity; an
    // unversioned (pre-split) runtime is adopted as the same scope whatever its hash.
    mutate(project => { project.initiativeRuntime = { sourceHash, ...(changedScope ? { scopeSchemaVersion: 2 } : {}), sdkState: { schemaVersion: 1, revision: rows.length, decisionRevision: rows.length, events: location === 'events' ? rows : [], seenEventIds: location === 'archive' ? [] : rows.map(row => row.id), actions: [], usedTokens: 0, reservedTokens: 0, nextReviewAt: clock + 900000 } }; });
  }
  function finishAgain({ timestamp = true, attempts = true } = {}) {
    clock += 1000;
    mutate((_project, session) => { session.turns[0].status = 'running'; delete session.turns[0].completedAt; });
    mutate((_project, session) => { Object.assign(session.turns[0], { status: 'failed', ...(timestamp ? { completedAt: new Date(clock).toISOString() } : {}) }); if (attempts) session.turns[0].runtimeAttempts++; session.items.push({ id: `failure-${clock}`, kind: 'tool', turnId: 'retained-turn', tool: { name: 'project_read', status: 'failed', output: 'New controlled failure receipt' } }); });
  }
  t.after(async () => { for (const controller of controllers) await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, p, s, mutate, model, scope, sources, boot, settle, legacy, finishAgain, calls: () => calls, clock: () => clock };
}

test('different terminal occurrences wake once, while running tools and 1000 repeated pumps do not create evidence or requests', async t => {
  const f = fixture(t), controller = await f.boot(); assert.equal(f.calls(), 1);
  const firstId = f.sources().find(row => row.type === 'conversation_result').id;
  f.finishAgain(); await f.settle(controller);
  assert.equal(f.calls(), 2); const secondId = f.sources().find(row => row.type === 'conversation_result').id; assert.notEqual(secondId, firstId);
  const revision = f.p().initiativeRuntime.sdkState.revision, writes = f.store.persistence.writes;
  for (let i = 0; i < 1000; i++) await controller.pump();
  assert.equal(f.calls(), 2); assert.equal(f.p().initiativeRuntime.sdkState.revision, revision); assert.equal(f.store.persistence.writes, writes);
  // These new-style IDs still match the existing deletion graph and scrubber.
  const copy = structuredClone(f.store.state), session = copy.sessions.find(row => row.id === f.s().id);
  scrubSessionEvidence(copy, { sessionId: session.id, projectId: session.projectId, evidence: captureSessionEvidence(copy, session) });
  assert.ok(copy.projects.find(row => row.id === session.projectId).initiativeRuntime.sdkState.events.every(row => !row.id.startsWith('turn:retained-turn:')));
  f.mutate((_project, session) => { session.turns[0].status = 'running'; delete session.turns[0].completedAt; }); await f.settle(controller);
  const before = f.calls();
  f.mutate((_project, session) => { session.items.push({ id: 'stream-output', kind: 'assistant', turnId: 'retained-turn', text: 'In-progress text' }, { id: 'live-tool', kind: 'tool', turnId: 'retained-turn', tool: { name: 'project_read', status: 'completed', output: 'Actual tool output' } }); }); await f.settle(controller);
  assert.equal(f.calls(), before);
});

for (const location of ['events', 'seen', 'archive']) test(`legacy ${location} preserves the existing terminal ID across reopen and observes the next genuine retry`, async t => {
  const f = fixture(t); f.legacy({ location }); let controller = await f.boot();
  assert.equal(f.calls(), 0); assert.equal(f.sources().find(row => row.type === 'conversation_result').id, 'turn:retained-turn:failed');
  const identity = structuredClone(f.p().initiativeRuntime.terminalSourceIdentity), revision = f.p().initiativeRuntime.sdkState.revision;
  assert.equal(identity.legacy.length, 1); await controller.close(); controller = await f.boot();
  assert.equal(f.calls(), 0); assert.deepEqual(f.p().initiativeRuntime.terminalSourceIdentity, identity); assert.equal(f.p().initiativeRuntime.sdkState.revision, revision);
  f.finishAgain(); await f.settle(controller); assert.equal(f.calls(), 1); assert.equal(f.p().initiativeRuntime.sdkState.revision, revision + 1);
  assert.match(f.sources().find(row => row.type === 'conversation_result').id, /^turn:retained-turn:failed@[a-f0-9]{20}$/);
  await controller.close(); controller = await f.boot(); assert.equal(f.calls(), 1); assert.deepEqual(f.p().initiativeRuntime.terminalSourceIdentity, identity);
});

test('a retained old receipt with a different terminal timestamp does not hide a newer offline failure', async t => {
  const f = fixture(t); f.legacy({ previousAt: f.clock() - 500 }); await f.boot();
  assert.equal(f.calls(), 1); assert.equal(f.p().initiativeRuntime.terminalSourceIdentity.legacy.length, 0);
  assert.match(f.sources().find(row => row.type === 'conversation_result').id, /@/);
});

test('archived new-style receipts stay seen on reopen without growing the migration alias set', async t => {
  const f = fixture(t); let controller = await f.boot(); const calls = f.calls();
  const rows = f.sources(), revision = f.p().initiativeRuntime.sdkState.revision;
  await controller.contexts.get(f.p().id).coordinator.archiveHistory({ actions: [], seenEventIds: rows.map(row => row.id) }); await controller.close();
  f.mutate(project => { const sdk = project.initiativeRuntime.sdkState; sdk.events = []; sdk.seenEventIds = []; });
  controller = await f.boot(); assert.equal(f.calls(), calls); assert.equal(f.p().initiativeRuntime.sdkState.revision, revision);
  assert.deepEqual(f.p().initiativeRuntime.terminalSourceIdentity, { version: 1, reobservePending: false, legacyArchiveScope: null, legacy: [] });
  for (let i = 0; i < 10; i++) await controller.pump(); assert.equal(f.calls(), calls);
});

test('scope revocation does not import legacy aliases or suppress reobservation using another scope archive', async t => {
  const f = fixture(t); f.legacy({ location: 'archive', changedScope: true }); await f.boot();
  assert.equal(f.calls(), 1); assert.deepEqual(f.p().initiativeRuntime.terminalSourceIdentity, { version: 1, reobservePending: false, legacyArchiveScope: 'obsolete-scope', legacy: [] });
  assert.match(f.sources().find(row => row.type === 'conversation_result').id, /@/);
});

test('a crash after persisting a new scope but before observing cannot inherit the previous scope archives', async t => {
  const f = fixture(t); f.legacy({ location: 'archive', changedScope: true });
  const controller = await f.boot({ beforePump: async controller => { await controller.create(f.p(), f.model(), f.scope()); } });
  assert.equal(f.p().initiativeRuntime.sourceHash, f.scope()); assert.equal(f.p().initiativeRuntime.sdkState.events.length, 0);
  await controller.close(); await f.boot();
  assert.equal(f.calls(), 1); assert.ok(f.p().initiativeRuntime.sdkState.events.some(row => row.id === 'message:retained-message'));
  assert.ok(f.p().initiativeRuntime.sdkState.events.some(row => row.id.startsWith('turn:retained-turn:failed@')));
});

for (const partial of [false, true]) test(`returning to the same scope hash must finish durable reobservation before using old archives (${partial ? 'partial' : 'empty'} import crash)`, async t => {
  const f = fixture(t); let controller = await f.boot(); const originalWorkspace = f.p().workspace;
  await controller.contexts.get(f.p().id).coordinator.archiveHistory({ actions: [], seenEventIds: f.sources().map(row => row.id) }); await controller.close();
  // Only a privacy input changes the scope now: the workspace folder, then back.
  f.mutate(project => { project.workspace = join(originalWorkspace, 'scope-b'); });
  controller = await f.boot({ beforePump: controller => controller.create(f.p(), f.model(), f.scope()) }); await controller.close();
  f.mutate(project => { project.workspace = originalWorkspace; });
  controller = await f.boot({ beforePump: async controller => {
    const context = await controller.create(f.p(), f.model(), f.scope());
    if (partial) await context.coordinator.observe(f.sources().find(row => row.id === 'message:retained-message'));
  } });
  assert.equal(f.p().initiativeRuntime.terminalSourceIdentity.reobservePending, true);
  const revisionBeforeReopen = f.p().initiativeRuntime.sdkState.revision, before = f.calls(); await controller.close(); await f.boot();
  assert.equal(f.calls(), before + 1); assert.equal(f.p().initiativeRuntime.terminalSourceIdentity.reobservePending, false);
  const events = f.p().initiativeRuntime.sdkState.events;
  assert.equal(events.filter(row => row.id === 'message:retained-message').length, 1);
  assert.equal(events.filter(row => row.type === 'conversation_result').length, 1); assert.equal(events.filter(row => row.type === 'project_state').length, 1);
  assert.equal(f.p().initiativeRuntime.sdkState.revision, revisionBeforeReopen + (partial ? 2 : 3));
});

test('missing terminal timestamps use the persisted attempt, never pump time or streamed output', async t => {
  const f = fixture(t); f.mutate((_project, session) => { delete session.turns[0].completedAt; }); const controller = await f.boot(), first = f.sources().find(row => row.type === 'conversation_result').id;
  f.finishAgain({ timestamp: false }); await f.settle(controller);
  assert.equal(f.calls(), 2); assert.notEqual(f.sources().find(row => row.type === 'conversation_result').id, first);
  const stable = f.sources(); for (let i = 0; i < 10; i++) await controller.pump(); assert.deepEqual(f.sources(), stable); assert.equal(f.calls(), 2);
});
