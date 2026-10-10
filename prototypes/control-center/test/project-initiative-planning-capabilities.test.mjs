import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { CapabilityService } from '../capability-service.mjs';
import { ProjectScheduleService } from '../project-schedule-service.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { decideInitiative } from '../../../packages/sdk/src/initiative.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-planning-capabilities-')), store = new Store(join(dir, 'state.json'));
  const { project } = store.createProject({ rhythm: { control: 'manual' }, name: 'Planning capability evidence', description: 'Keep a useful project responsibility.', workspace: dir });
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); p.initialization = { status: 'ready' }; p.simulated = false; p.decisionMode = 'rna-model'; p.initiative.enabled = true; p.permissions = { workspace: 'execute', background: 'inherit' }; p.assignments = { skillIds: [], toolIds: ['project_read', 'project_list', 'project_write', 'openviking_search'], mcpServerIds: [] }; });
  const capabilities = new CapabilityService(store), scheduleService = new ProjectScheduleService(store);
  // A declaration whose name is intentionally misleading verifies that no
  // semantic capability is classified or invented from name substrings.
  capabilities.register('tools', { id: 'current-news', name: 'Live web news search', description: 'Inspect only a locally cached arithmetic table; no network requests are supported.', protocol: 'json-stdin', toolName: 'internet_news_search', command: '/never-executed-fixture', args: [], permission: 'read', parameters: { type: 'object', properties: {} }, enabled: true, trusted: true });
  store.mutate(state => state.projects.find(row => row.id === project.id).assignments.toolIds.push('current-news', 'missing-tool'));
  // Keep the controller idle: tests inspect actual declaration projection,
  // never start an autonomous review or invoke a model/tool.
  const controller = new ProjectInitiativeController(store, { capabilityService: capabilities, scheduleService, independentLearning: true, initialDelayMs: 1e9, tickIntervalMs: 0 });
  t.after(async () => { await controller.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, controller, capabilities, project: () => store.state.projects.find(row => row.id === project.id) };
}

test('planning sees real assigned tool descriptions and permissions without inferring semantics or reading the workspace', async t => {
  const app = fixture(t); writeFileSync(join(app.dir, 'private-unread-evidence.txt'), 'This content was not read by planning.');
  const raw = await app.controller.planningCapabilities(app.project());
  const snapshot = app.controller.snapshot(app.project(), {}, raw), view = snapshot.capabilityContext;
  assert.equal(view.workspaceState, 'not_inspected_by_planner'); assert.match(view.evidenceBoundary, /does not mean an empty workspace/);
  const declared = view.tools.find(row => row.id === 'current-news');
  assert.equal(declared.name, 'internet_news_search'); assert.equal(declared.description, 'Inspect only a locally cached arithmetic table; no network requests are supported.');
  assert.equal(declared.permission, 'read'); assert.equal(declared.permittedForBackground, true);
  assert.deepEqual(view.unresolvedToolIds, ['missing-tool']);
  assert.match(view.tools.find(row => row.id === 'openviking_search').description, /does not search or crawl the internet/);
  assert.equal(view.tools.find(row => row.id === 'project_write').permittedForBackground, true);
  assert.doesNotMatch(JSON.stringify(view), /This content was not read|never-executed-fixture/);
  let transmitted;
  await decideInitiative({ project: snapshot, availableActions: ['schedule', 'work'], events: [], model: { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', maxOutputTokens: 1000 }, provider: async function* (request) {
    transmitted = JSON.parse(request.messages[0].content[0].text).project.capabilityContext;
    yield { type: 'text_delta', delta: JSON.stringify({ action: 'wait', reason: 'Only declarations have been inspected.', evidenceIds: [], content: '', nextReviewAfterMs: 1000 }) };
    yield { type: 'usage', usage: { totalTokens: 7 } }; yield { type: 'done', stopReason: 'stop' };
  } });
  assert.deepEqual(transmitted, view);
  // Same descriptors under the saved permission: plan mode narrows background work to read at the request tail
  // (hostConditions.work.backgroundLevel), never by rewriting the declarations at the head (PDL-5 phase 2), and the
  // write tool stays a write tool.
  assert.match(view.backgroundPermission, /saved project permission.*backgroundLevel is read.*only tools whose permission is read/);
  app.store.mutate(state => { state.sessions.find(row => row.projectId === app.project().id).mode = 'plan'; });
  const planning = app.controller.snapshot(app.project(), {}, raw);
  assert.deepEqual(planning.capabilityContext, view, 'byte-for-byte the same declarations in plan mode');
  const reduced = planning.capabilityContext.tools.find(row => row.id === 'project_write');
  assert.equal(reduced.permission, 'write'); assert.equal(reduced.permittedForBackground, true);
  assert.equal(planning.actionContracts.work.backgroundLevel, 'read'); assert.equal(planning.actionContracts.work.permissions.effective.background, 'read');
});

test('planning does not connect assigned MCP servers or claim undeclared tools are available', async t => {
  const app = fixture(t), original = app.capabilities.registry.bind(app.capabilities); let calls = 0;
  app.capabilities.register('mcpServers', { id: 'uninspected', name: 'Remote service', description: 'Provider-declared remote capability; not yet inspected.', transport: 'http', url: 'http://127.0.0.1:1/mcp', allowTools: { network_read: { permission: 'read' } }, enabled: true, trusted: true });
  app.store.mutate(state => { const p = state.projects.find(row => row.id === app.project().id); p.assignments.mcpServerIds = ['uninspected']; p.assignments.toolIds.push('mcp:uninspected:network_read'); });
  app.capabilities.registry = async (...args) => { calls++; assert.deepEqual(args[2].connectIds, []); return original(...args); };
  const view = await app.controller.planningCapabilities(app.project());
  assert.equal(calls, 1); assert.equal(view.mcpServers[0].discovery, 'not_performed_by_planner');
  assert.ok(view.unresolvedToolIds.includes('mcp:uninspected:network_read'));
  assert.equal(view.tools.some(row => row.id === 'mcp:uninspected:network_read'), false);
});

test('an unavailable workspace preserves the actual memory declaration and unknown file state', async t => {
  const app = fixture(t); app.store.mutate(state => { state.projects.find(row => row.id === app.project().id).workspace = join(app.dir, 'absent'); });
  const view = await app.controller.planningCapabilities(app.project());
  assert.equal(view.status, 'partially_unavailable'); assert.equal(view.workspaceState, 'not_inspected_by_planner');
  assert.ok(view.unresolvedToolIds.includes('project_read')); assert.match(view.tools.find(row => row.id === 'openviking_search').description, /previously stored project memory/);
});

test('host leaves the provider-compatible decision deadline default intact and preserves an explicit shorter override', async t => {
  const app = fixture(t);
  const provider = app.store.configurationService.provider(null, { name: 'No network deadline fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  app.store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' } });
  const p = app.project(), model = app.controller.model(p);
  const context = await app.controller.create(p, model, app.controller.scope(p, model));
  assert.equal(app.controller.decisionTimeoutMs, undefined);
  assert.equal(context.coordinator.policy.decisionTimeoutMs, 900000);
  await app.controller.close();
  const overridden = new ProjectInitiativeController(app.store, { decisionTimeoutMs: 40, independentLearning: true, initialDelayMs: 1e9, tickIntervalMs: 0 });
  t.after(() => overridden.close());
  const second = await overridden.create(app.project(), model, overridden.scope(app.project(), model));
  assert.equal(second.coordinator.policy.decisionTimeoutMs, 40);
});
