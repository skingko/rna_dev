import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { memoryEvidenceDocument, planMemoryEvidence } from '../memory-evidence-outbox.mjs';

async function fixture(t, { legacyProof = false, revoked = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-capacity-evidence-')), file = join(dir, 'state.json');
  let store = new Store(file); const controllers = [];
  const provider = store.configurationService.provider(null, { name: 'Capacity fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-secret', models: [
    { id: 'selected', contextWindow: 120000, maxOutputTokens: 32768, reasoning: ['off'] },
    { id: 'other', contextWindow: 64000, maxOutputTokens: 2048, reasoning: ['off'] }
  ] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'selected', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const created = store.createProject({ rhythm: { control: 'manual' }, name: 'Retained delivery', workspace: dir, initiative: { enabled: false } });
  const p = (state = store.state) => state.projects.find(row => row.id === created.project.id), s = (state = store.state) => state.sessions.find(row => row.id === created.session.id);
  const projector = () => Object.assign(Object.create(ProjectInitiativeController.prototype), { store });
  store.mutate(state => {
    Object.assign(p(state), { simulated: false, decisionMode: 'rna-model', initialization: { status: 'ready' }, assignments: { skillIds: [], toolIds: [], mcpServerIds: [] }, permissions: { workspace: 'write', background: 'inherit' } });
    const model = projector().model(p(state));
    p(state).initiativeRuntime = { sourceHash: projector().scope(p(state), model), sdkState: { schemaVersion: 1, revision: 1, decisionRevision: 1, nextReviewAt: 0, usedTokens: 23, reservedTokens: 0,
      events: [{ id: 'prior', type: 'project_state', summary: 'Old decision input', at: 1000 }], seenEventIds: ['prior'], actions: [
        { id: 'work', action: 'work', status: 'completed', content: 'Inspect actual material', resultSummary: 'Recorded result', evidenceIds: ['prior'], intentKey: 'work-intent' },
        { id: 'share', action: 'share', status: 'completed', content: 'Delivered report', resultSummary: 'Delivered once', evidenceIds: ['action:work:completed'], intentKey: 'share-intent', ...(revoked ? { contextRevoked: true } : {}) },
        { id: 'queued', action: 'share', status: 'queued', content: 'Unsent conclusion', evidenceIds: ['prior'], intentKey: 'queued-intent' }
      ] } };
    p(state).jobs = [{ id: 'work', lane: 'background', simulated: false, status: 'completed', toolReceipts: [{ recordedByHost: true, toolCallId: 'read', toolName: 'project_read', status: 'completed', resultHash: 'a'.repeat(64) }] }];
    s(state).items.push({ id: 'delivery', kind: 'assistant', source: 'initiative', simulated: false, turnId: null, initiativeActionId: 'share', text: 'A delivered assistant report, not independent verification.', createdAt: '2026-01-01T00:00:00Z', evidenceIds: ['action:work:completed'] });
    s(state).memoryEvidenceState = { schemaVersion: 1, seen: [] };
  });
  const boot = async () => {
    const controller = new ProjectInitiativeController(store, { initialDelayMs: 1000000, tickIntervalMs: 0, decisionProvider: async function* () { throw new Error('No model request allowed in evidence fixture'); } });
    controllers.push(controller);
    const model = controller.model(p()), context = await controller.create(p(), model, controller.scope(p(), model));
    return { controller, context };
  };
  const first = await boot();
  if (legacyProof) store.mutate(state => { delete p(state).initiativeRuntime.retainedEvidenceScopeHash; });
  const freeze = () => {
    const snapshot = structuredClone(store.state); snapshot.configuration.memory.autoStore = true;
    const planned = planMemoryEvidence(snapshot, snapshot.sessions.find(row => row.id === s().id), { connectionFingerprint: 'fixture', namespace: 'viking://resources/project', now: 1000 });
    return planned.records[0];
  };
  const capacity = () => store.configurationService.provider(provider.id, { models: [{ id: 'selected', contextWindow: 1000000 }, { id: 'other' }] });
  const reopen = async () => { await first.controller.close(); store = new Store(file); return boot(); };
  t.after(async () => { for (const controller of controllers) await controller.close(); rmSync(dir, { recursive: true, force: true }); });
  return { p, s, sessionId: created.session.id, store: () => store, provider: (state = store.state) => state.configuration.providers.find(row => row.id === provider.id), providerId: provider.id, first, boot, reopen, freeze, capacity, file };
}

test('a capacity-only provider update is drift: the coordinator takes the new model in place and keeps events, queued work, receipts and the frozen memory document', async t => {
  const f = await fixture(t), write = f.freeze(), original = memoryEvidenceDocument(f.store().state, f.s().id, write);
  const before = structuredClone(f.p().initiativeRuntime), provider = structuredClone(f.provider()), credentials = readFileSync(`${f.file}.secrets`);
  assert.equal(before.scopeSchemaVersion, 2, 'a pre-split runtime is adopted, not revoked');
  assert.equal(f.first.controller.valid(f.first.context, { enabled: false }), true);
  f.capacity();
  assert.equal(f.first.controller.valid(f.first.context, { enabled: false }), true, 'context drift does not invalidate the coordinator');
  assert.equal(await f.first.controller.refreshDrift(f.first.context, f.p(), f.first.controller.model(f.p())), true);
  assert.equal(f.first.context.coordinator.model.contextWindow, 1000000, 'the running coordinator decides on the refreshed model');
  assert.equal(f.provider().evidenceRevision, provider.evidenceRevision);
  assert.notEqual(f.provider().updatedAt, provider.updatedAt);
  assert.deepEqual(readFileSync(`${f.file}.secrets`), credentials);
  const { context } = await f.reopen();
  assert.equal(context.coordinator.model.contextWindow, 1000000); assert.equal(context.coordinator.model.maxOutputTokens, 32768);
  assert.deepEqual(f.provider().models[1], provider.models[1]);
  const after = f.p().initiativeRuntime;
  assert.equal(after.sourceHash, before.sourceHash); assert.equal(after.retainedEvidenceScopeHash, undefined);
  for (const id of ['work', 'share', 'queued']) assert.deepEqual(after.sdkState.actions.find(row => row.id === id), before.sdkState.actions.find(row => row.id === id));
  assert.equal(after.sdkState.actions.find(row => row.id === 'queued').status, 'queued');
  assert.deepEqual(after.sdkState.events, before.sdkState.events); assert.deepEqual(after.sdkState.seenEventIds, before.sdkState.seenEventIds);
  assert.equal(after.sdkState.usedTokens, 23); assert.equal(after.sdkState.reservedTokens, 0);
  assert.equal(memoryEvidenceDocument(f.store().state, f.s().id, write), original);
});

for (const change of ['credential', 'credential-env', 'endpoint', 'output-cap', 'permission', 'archive', 'content', 'plan-mode', 'new-conversation', 'capabilities']) test(`${change} changes are context drift: receipts, queued work and the delivery's memory document stay`, async t => {
  const f = await fixture(t), write = f.freeze(), original = memoryEvidenceDocument(f.store().state, f.sessionId, write);
  await f.first.controller.close();
  if (change === 'credential') f.store().configurationService.provider(f.providerId, { apiKey: 'different-secret' });
  else if (change === 'credential-env') f.store().configurationService.provider(f.providerId, { apiKeyEnv: 'RNA_FIXTURE_UNUSED_KEY' });
  else if (change === 'endpoint') f.store().configurationService.provider(f.providerId, { baseUrl: 'http://127.0.0.1:2/v1' });
  else if (change === 'output-cap') f.store().configurationService.provider(f.providerId, { models: [{ id: 'selected', contextWindow: 1000000, maxOutputTokens: 16384 }, { id: 'other' }] });
  else if (change === 'new-conversation') f.store().createSession({ projectId: f.p().id, title: 'Another conversation' });
  else f.store().mutate(state => {
    if (change === 'permission') f.p(state).permissions = { ...f.p(state).permissions, background: 'read' };
    if (change === 'archive') f.s(state).archivedAt = '2026-01-02T00:00:00Z';
    if (change === 'content') f.p(state).description = 'A different project responsibility';
    if (change === 'plan-mode') f.s(state).mode = 'plan';
    if (change === 'capabilities') state.capabilities = { ...state.capabilities, revision: (state.capabilities?.revision ?? 0) + 1, skills: [...(state.capabilities?.skills ?? []), { id: 'another-project-skill', name: 'Other project', description: 'Installed elsewhere' }] };
  });
  await f.boot();
  const actions = f.p().initiativeRuntime.sdkState.actions;
  assert.equal(actions.find(row => row.id === 'share').contextRevoked, undefined);
  assert.equal(actions.find(row => row.id === 'work').resultSummary, 'Recorded result');
  assert.equal(actions.find(row => row.id === 'queued').status, 'queued');
  assert.equal(memoryEvidenceDocument(f.store().state, f.sessionId, write), original);
});

for (const change of ['workspace', 'workspace-identity']) test(`${change} is a privacy boundary: receipts are revoked with privacyRevoked and the delivery's memory document is withdrawn`, async t => {
  const f = await fixture(t), write = f.freeze();
  await f.first.controller.close();
  f.store().mutate(state => {
    if (change === 'workspace') f.p(state).workspace = join(f.p(state).workspace, 'moved');
    else f.p(state).observationSources = [{ id: 'workspace', sourceRevision: 2, identityRevoked: true }];
  });
  await f.boot();
  const actions = f.p().initiativeRuntime.sdkState.actions;
  assert.equal(actions.find(row => row.id === 'share').privacyRevoked, true); assert.equal(actions.find(row => row.id === 'share').contextRevoked, true);
  assert.equal(actions.find(row => row.id === 'queued').status, 'cancelled');
  assert.equal(f.p().jobs.find(row => row.id === 'work').privacyRevoked, true);
  assert.deepEqual(f.p().initiativeRuntime.sdkState.events, []);
  assert.throws(() => memoryEvidenceDocument(f.store().state, f.sessionId, write), { code: 'MEMORY_SOURCE_CHANGED' });
});

test('a deleted conversation still withdraws its delivery document', async t => {
  const f = await fixture(t), write = f.freeze();
  await f.first.controller.close();
  f.store().mutate(state => { state.sessions = state.sessions.filter(row => row.id !== f.sessionId); });
  await f.boot();
  assert.throws(() => memoryEvidenceDocument(f.store().state, f.sessionId, write), { code: 'MEMORY_SOURCE_CHANGED' });
});

test('a share action revoked before the split keeps its receipt only (it has no job to restore from), and drift never revokes again', async t => {
  for (const mode of ['legacy', 'revoked']) {
    const f = await fixture(t, { legacyProof: mode === 'legacy', revoked: mode === 'revoked' });
    await f.first.controller.close(); f.capacity(); await f.boot();
    assert.equal(f.p().initiativeRuntime.sdkState.actions.find(row => row.id === 'share').contextRevoked, mode === 'revoked' ? true : undefined);
  }
});

test('explicit unchanged credential input still rotates evidence identity, while old providers can establish a future proof', async t => {
  const f = await fixture(t); await f.first.controller.close();
  f.store().mutate(state => { delete f.provider(state).evidenceRevision; });
  const initial = await f.boot(); await initial.controller.close();
  const oldRevision = f.provider().updatedAt;
  f.capacity(); assert.equal(f.provider().evidenceRevision, oldRevision);
  const next = await f.boot(); await next.controller.close();
  assert.equal(f.p().initiativeRuntime.sdkState.actions.find(row => row.id === 'share').contextRevoked, undefined);
  const current = f.provider().evidenceRevision;
  f.store().configurationService.provider(f.providerId, { apiKey: 'fixture-secret', models: [{ id: 'selected', contextWindow: 2000000 }, { id: 'other' }] });
  assert.notEqual(f.provider().evidenceRevision, current);
});

test('settings UI style full payload with unchanged empty apiKeyEnv preserves completed evidence for a capacity-only edit', async t => {
  const f = await fixture(t), write = f.freeze(), original = memoryEvidenceDocument(f.store().state, f.sessionId, write);
  await f.first.controller.close();
  const provider = f.store().configurationService.public().providers.find(row => row.id === f.providerId), priorRevision = provider.evidenceRevision;
  const body = { name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl, apiKeyEnv: '', models: provider.models.map(model => ({
    input: model.input ?? null, id: model.id, name: model.name, contextWindow: model.id === 'selected' ? 1000000 : model.contextWindow, maxOutputTokens: model.maxOutputTokens, reasoning: model.reasoning,
    ...(model.compat ? { compat: model.compat } : {}), ...(model.cacheRetention ? { cacheRetention: model.cacheRetention } : {})
  })) };
  f.store().configurationService.provider(f.providerId, body);
  assert.equal(f.provider().evidenceRevision, priorRevision);
  await f.boot();
  assert.equal(f.p().initiativeRuntime.sdkState.actions.find(row => row.id === 'share').contextRevoked, undefined);
  assert.equal(memoryEvidenceDocument(f.store().state, f.sessionId, write), original);
});
