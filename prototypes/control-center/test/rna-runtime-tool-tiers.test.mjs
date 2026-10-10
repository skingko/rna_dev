import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRnaRuntime, runSurface } from '../rna-runtime.mjs';
import { sharedPrefixFor, forgetPrefix } from '../prompt-prefix-registry.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 64000, maxOutputTokens: 1000, reasoning: 'off' };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-tool-tiers-')), cwd = join(dir, 'workspace'); await mkdir(cwd); await writeFile(join(cwd, 'README.md'), 'tiers');
  const handles = []; t.after(async () => { for (const handle of handles) await handle.dispose(); await rm(dir, { recursive: true, force: true }); });
  const project = { id: 'project', workspace: cwd, permissions: { workspace: 'write', background: 'read' }, assignments: { skillIds: [], toolIds: ['project_read', 'project_list', 'project_find', 'project_grep', 'project_write', 'project_edit'], mcpServerIds: [] } };
  const run = async (options, writes = true) => {
    const requests = [], results = [];
    const handle = await createRnaRuntime({ sessionId: `s-${handles.length}`, projectId: project.id, project, cwd, stateDir: join(dir, `rna-${handles.length}`), model, ...options,
      onEvent: event => { if (event.type === 'tool_execution_end') results.push(event); },
      provider: async function* (request) {
        requests.push(structuredClone({ systemPrompt: request.systemPrompt, tools: request.tools.map(({ name, description, parameters }) => ({ name, description, parameters })), messages: request.messages }));
        if (writes && !request.messages.some(message => message.role === 'toolResult')) { yield { type: 'tool_call', id: 'w', name: 'project_write', arguments: { path: 'out.txt', content: 'x', createOnly: true } }; yield { type: 'done', stopReason: 'toolUse' }; return; }
        yield { type: 'text_delta', delta: 'done' }; yield { type: 'done', stopReason: 'stop' };
      } });
    handles.push(handle); await handle.prompt('task'); return { requests, results };
  };
  return { cwd, project, run };
}

test('plan mode keeps the identical tools array and system prompt, rejecting writes at execution', async t => {
  const f = await fixture(t);
  const plan = await f.run({ readOnly: true, systemPrompt: '当前轮次为计划模式：只读。' });
  const normal = await f.run({ readOnly: false, systemPrompt: '普通前台轮次。' }, false);
  assert.deepEqual(plan.requests[0].tools, normal.requests[0].tools, 'plan/readOnly does not fork the tools array');
  assert.equal(plan.requests[0].systemPrompt, normal.requests[0].systemPrompt, 'purpose text is not system text');
  assert.ok(plan.requests[0].tools.some(tool => tool.name === 'project_write'));
  const rejected = plan.results.find(event => event.toolName === 'project_write');
  assert.equal(rejected.isError, true); assert.equal(rejected.result.details.code, 'authorization_read_only'); assert.equal(existsSync(join(f.cwd, 'out.txt')), false);
  assert.match(JSON.stringify(plan.requests[0].messages), /host-purpose-instructions[^\]]*计划模式/);
});

test('a background scope with a read grant declares the same assigned tools and rejects writes; foreground write executes', async t => {
  const f = await fixture(t);
  const background = await f.run({ permissionScope: 'background', readOnly: false });
  const foreground = await f.run({});
  assert.deepEqual(background.requests[0].tools, foreground.requests[0].tools);
  assert.equal(background.results[0].result.details.code, 'authorization_read_only');
  assert.equal(foreground.results[0].isError, false); assert.equal(existsSync(join(f.cwd, 'out.txt')), true, 'the permitted purpose still executes');
});

test('an MCP server assigned mid-session is reached through the mcp loader without changing the tools array', async t => {
  const { Store } = await import('../store.mjs'), { CapabilityService } = await import('../capability-service.mjs'), { CapabilityInstallService } = await import('../capability-install-service.mjs');
  const { fileURLToPath } = await import('node:url');
  const dir = await mkdtemp(join(tmpdir(), 'rna-mcp-loader-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.json')), capabilityService = new CapabilityService(store), installer = new CapabilityInstallService(store, { capabilityService });
  const { project } = store.createProject({ name: 'MCP loader', workspace: dir });
  store.mutate(state => { state.projects.find(row => row.id === project.id).assignments = { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] }; state.projects.find(row => row.id === project.id).permissions = { workspace: 'read', background: 'read' }; });
  const current = () => store.state.projects.find(row => row.id === project.id), requests = [];
  const install = () => installer.install(project.id, { kind: 'mcp', activate: true, source: { type: 'mcp-config', config: { mcpServers: { late: { command: process.execPath, args: [fileURLToPath(new URL('../../../packages/sdk/test/fixtures/mcp-server.mjs', import.meta.url))] } } } }, allowTools: { echo: { permission: 'read', idempotent: true }, unapproved_write: { permission: 'write' } } });
  const handle = await createRnaRuntime({ sessionId: 'loader', projectId: project.id, project: current(), getProject: current, capabilityService, cwd: dir, stateDir: join(dir, 'rna'), model,
    provider: async function* (request) {
      requests.push(request.tools.map(tool => tool.name).sort());
      const results = request.messages.filter(message => message.role === 'toolResult');
      if (!results.length) { yield { type: 'tool_call', id: 'list', name: 'mcp', arguments: { action: 'list' } }; yield { type: 'done', stopReason: 'toolUse' }; return; }
      if (results.length === 1) { assert.match(JSON.stringify(results[0]), /mcp__late__echo/); yield { type: 'tool_call', id: 'call', name: 'mcp_call', arguments: { tool: 'mcp__late__echo', arguments: { text: 'loaded-evidence' } } }; yield { type: 'done', stopReason: 'toolUse' }; return; }
      if (results.length === 2) { assert.match(JSON.stringify(results[1]), /loaded-evidence/); yield { type: 'tool_call', id: 'write', name: 'mcp_call', arguments: { tool: 'mcp__late__unapproved_write', arguments: {} } }; yield { type: 'done', stopReason: 'toolUse' }; return; }
      assert.match(JSON.stringify(results[2]), /authorization_read_only|Read-only authorization: writes are rejected/, 'the loaded tool keeps its own grant'); yield { type: 'text_delta', delta: 'done' }; yield { type: 'done', stopReason: 'stop' };
    } });
  t.after(() => handle.dispose());
  const before = [...handle.snapshot().tools].sort();
  await install(); // assigned after this handle pinned its MCP servers
  await handle.prompt('Use the newly installed MCP evidence.');
  assert.equal(requests.length, 4);
  assert.ok(requests.every(names => JSON.stringify(names) === JSON.stringify(before)), 'tools array unchanged after the mid-session MCP assignment');
  assert.ok(requests[0].includes('mcp') && requests[0].includes('mcp_call')); assert.ok(!requests[0].some(name => name.startsWith('mcp__late__')));
});

test('surface-only declarations reject with tool_unavailable_for_purpose and are listed as unavailable in the tail', async t => {
  const f = await fixture(t);
  const surfaceTools = [{ name: 'ask_user', description: 'Ask the user.', parameters: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false }, permission: 'read', effect: 'read' }];
  const result = await f.run({ permissionScope: 'background', surfaceTools }, false);
  assert.ok(result.requests[0].tools.some(tool => tool.name === 'ask_user'));
  const note = result.requests[0].messages.flatMap(message => message.content ?? []).map(part => part.text ?? '').find(text => text.includes('host-authorization'));
  assert.match(note, /declaredButUnavailable[^\]]*ask_user/); assert.match(note, /background-work/);
});

// Token-burn T2 (design 2026-10-05 §5 P1): a scheduled run declares only what it can execute.
const stubTool = (name, description) => ({ name, description, parameters: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false }, permission: 'read', effect: 'read' });
const surfaceTools = [stubTool('ask_user', 'Ask the user.'), stubTool('agent_consult', 'Consult a worker.'), stubTool('capability_install', 'Install a capability.')];
const authorizationOf = request => {
  const text = request.messages.flatMap(message => message.content ?? []).map(part => part.text ?? '').find(part => part.includes('[{"source":"host-authorization"'));
  return JSON.parse(JSON.parse(text.slice(text.indexOf('[{"source":"host-authorization"')))[0].text);
};

test("surface 'executable' declares only the executable tools: same system prompt, the stubs named as not declared, a call to one gets the session's receipt", async t => {
  const f = await fixture(t);
  forgetPrefix(f.project.id);
  const fixtureModel = { providerId: 'fixture', modelId: 'fixture' };
  let count = 0;
  const consult = async (surface, scripted = true) => {
    const requests = [], results = [], id = count++;
    const handle = await createRnaRuntime({ sessionId: `lean-${id}`, projectId: f.project.id, project: f.project, cwd: f.cwd, stateDir: join(f.cwd, '..', `rna-lean-${id}`), model, permissionScope: 'background', surfaceTools, surface,
      onEvent: event => { if (event.type === 'tool_execution_end') results.push(event); },
      provider: async function* (request) {
        requests.push(structuredClone({ systemPrompt: request.systemPrompt, tools: request.tools.map(({ name, description, parameters }) => ({ name, description, parameters })), messages: request.messages }));
        if (scripted && !request.messages.some(message => message.role === 'toolResult')) { yield { type: 'tool_call', id: 'consult', name: 'agent_consult', arguments: { q: 'look at this' } }; yield { type: 'done', stopReason: 'toolUse' }; return; }
        yield { type: 'text_delta', delta: 'done' }; yield { type: 'done', stopReason: 'stop' };
      } });
    t.after(() => handle.dispose()); await handle.prompt('task'); return { requests, results };
  };
  const names = request => request.tools.map(tool => tool.name), stubbed = ['agent_consult', 'ask_user', 'capability_install'];
  const full = await consult('full');
  assert.deepEqual(sharedPrefixFor(f.project.id, fixtureModel)?.tools.map(tool => tool.name).sort(), names(full.requests[0]).sort(), 'a full surface publishes its prefix');
  forgetPrefix(f.project.id);
  const lean = await consult('executable');
  assert.deepEqual(names(lean.requests[0]), names(full.requests[0]).filter(name => !stubbed.includes(name)), 'the lean array is the full one without the three stubs, in the same order');
  for (const name of stubbed) { assert.ok(names(full.requests[0]).includes(name)); assert.ok(!names(lean.requests[0]).includes(name)); }
  assert.equal(lean.requests[0].systemPrompt, full.requests[0].systemPrompt, 'the system prompt is byte-identical');
  const fullNote = authorizationOf(full.requests[0]), leanNote = authorizationOf(lean.requests[0]);
  // The fixture's background grant is read: the two write tools are declared and refused at execution in both surfaces.
  assert.deepEqual(fullNote.declaredButUnavailable, [...stubbed, 'project_edit', 'project_write']); assert.equal(fullNote.notDeclaredHere, undefined, 'a full surface adds nothing to the authorization block');
  assert.deepEqual(leanNote.declaredButUnavailable, ['project_edit', 'project_write'], 'tools that are declared and refused stay in declaredButUnavailable'); assert.deepEqual(leanNote.notDeclaredHere, stubbed);
  assert.equal(leanNote.notDeclaredRule, 'Tools in notDeclaredHere are not available in this run; do not call them.');
  assert.deepEqual(leanNote.executableTools, fullNote.executableTools, 'what the run can execute does not change');
  // The model calls a tool it was not given: the session answers "not assigned", and the run goes on and finishes.
  assert.equal(lean.results.length, 1); assert.equal(lean.results[0].isError, true); assert.match(lean.results[0].result.content[0].text, /Tool is not assigned to this session/);
  assert.equal(lean.requests.length, 2, 'the run asks again after the receipt'); assert.match(JSON.stringify(lean.requests[1].messages), /not assigned to this session/);
  assert.equal(full.results[0].result.details.code, 'tool_unavailable_for_purpose', 'a full surface still refuses at execution');
  // A lean run publishes nothing: its array is not the project's shared one.
  assert.equal(sharedPrefixFor(f.project.id, fixtureModel), null, 'the lean run did not publish its prefix');
});

test('the lean surface is the same array for every run of a project; an unknown surface is refused', async t => {
  const f = await fixture(t);
  const open = (surface, id) => createRnaRuntime({ sessionId: `stable-${id}`, projectId: f.project.id, project: f.project, cwd: f.cwd, stateDir: join(f.cwd, '..', `rna-stable-${id}`), model, permissionScope: 'background', surfaceTools, surface, provider: async function* () { yield { type: 'text_delta', delta: 'ok' }; yield { type: 'done', stopReason: 'stop' }; } });
  const a = await open('executable', 'a'), b = await open('executable', 'b'), c = await open('full', 'c'); t.after(() => Promise.all([a.dispose(), b.dispose(), c.dispose()]));
  assert.deepEqual(a.snapshot().tools, b.snapshot().tools, 'two lean runs of one project declare identical arrays');
  assert.ok(!a.snapshot().tools.includes('ask_user')); assert.ok(c.snapshot().tools.includes('ask_user'));
  await assert.rejects(() => open('lean', 'd'), { code: 'invalid_options' });
});

test("runSurface: a scheduled run is lean, a resumed run keeps its job's surface, every other run is full, and the env switch rolls new runs back", () => {
  assert.equal(runSurface({ scheduled: true, env: {} }), 'executable');
  assert.equal(runSurface({ scheduled: false, env: {} }), 'full', 'a decision-started run keeps the full surface');
  assert.equal(runSurface({ env: {} }), 'full');
  assert.equal(runSurface({ scheduled: true, env: { RNA_SCHEDULED_SURFACE: 'full' } }), 'full', 'the rollback switch');
  assert.equal(runSurface({ scheduled: true, env: { RNA_SCHEDULED_SURFACE: 'executable' } }), 'executable');
  assert.equal(runSurface({ scheduled: true, resumed: true, saved: 'executable', env: {} }), 'executable', 'a resumed run continues the surface it began with');
  assert.equal(runSurface({ scheduled: true, resumed: true, saved: 'executable', env: { RNA_SCHEDULED_SURFACE: 'full' } }), 'executable', 'the switch changes runs that start from now on');
  assert.equal(runSurface({ scheduled: true, resumed: true, saved: 'full', env: {} }), 'full');
  assert.equal(runSurface({ scheduled: true, resumed: true, saved: undefined, env: {} }), 'full', 'a job from before this rule continues as it began');
});

// Review of T2 (finding 3): the full surface of a subagent was only claimed, never asserted. A delegated child is built by
// BuiltinAgentService with the SDK's fixed child options; nothing hands it a surface or the purpose-only stubs, and its
// authorization block names nothing as left out. A regression that passes `surface` down to the child's factory fails here.
test('a delegated subagent is built with no surface option, declares its own full array and names no tool as not declared', async t => {
  const { Store } = await import('../store.mjs'), { BuiltinAgentService } = await import('../builtin-agent-service.mjs'), { applyProjectPermissions } = await import('../project-permissions.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'rna-child-surface-')), seen = [], requests = [];
  const store = new Store(join(directory, 'private', 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Child fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'child-surface-fixture-key', models: [{ id: 'child-model', contextWindow: 64000, maxOutputTokens: 512, reasoning: ['low'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'child-model', reasoning: 'low' }, memory: { autoRecall: false, autoStore: false } });
  const { session, project } = store.createProject({ name: 'Child surface fixture', workspace: directory, initiative: { enabled: false } });
  store.mutate(state => applyProjectPermissions(state, project.id, { workspace: 'execute', background: 'read' }));
  store.message(session.id, { text: 'Parent task', requestId: 'parent-request' });
  const turnId = store.state.sessions.find(item => item.id === session.id).activeTurnId;
  const service = new BuiltinAgentService(store, { factory: options => { seen.push(Object.keys(options)); return createRnaRuntime({ ...options, provider: async function* (request) {
    requests.push(structuredClone({ tools: request.tools.map(tool => tool.name), messages: request.messages }));
    yield { type: 'text_delta', delta: 'Inspected; nothing else verified.' }; yield { type: 'done', stopReason: 'stop' };
  } }); } });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const result = await service.createTools({ sessionId: session.id, turnId }).find(tool => tool.name === 'agent_consult').execute('child-call', { role: 'scout', task: 'Inspect the project evidence.', wait: true }, new AbortController().signal);
  assert.equal(JSON.parse(result.content[0].text).status, 'completed');
  assert.equal(seen.length, 1, 'one child runtime was built');
  assert.ok(!seen[0].includes('surface'), 'the child factory is not given a surface option'); assert.ok(!seen[0].includes('surfaceTools'), 'nor the purpose-only stubs');
  assert.ok(seen[0].includes('ownerSessionId'), 'it is a delegated child');
  assert.ok(requests[0].tools.length > 0 && !requests[0].tools.includes('agent_consult'), 'the child declares its own narrowed tools, as before');
  const note = authorizationOf(requests[0]);
  assert.equal(note.purpose, 'subagent'); assert.deepEqual(note.declaredButUnavailable, []); assert.equal(note.notDeclaredHere, undefined); assert.equal(note.notDeclaredRule, undefined);
});
