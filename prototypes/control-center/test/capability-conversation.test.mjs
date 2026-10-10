import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createServer } from '../server.mjs';
import { skillFixture } from '../../../packages/sdk/test/fixtures/capability-fixtures.mjs';

const ordinaryMutations = ['project_write', 'project_edit', 'project_exec'];
const baseline = { skillIds: [], toolIds: ['project_read', 'project_list'], mcpServerIds: [] };
const names = input => input.tools.map(tool => tool.function.name);
const toolResults = input => input.messages.filter(message => message.role === 'tool');
const lastResult = input => toolResults(input).at(-1)?.content ?? '';
const runProcess = promisify(execFile);

function stream(response, step, sequence) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null, usage) => response.write(`data: ${JSON.stringify({ id: `fixture-${sequence}`, object: 'chat.completion.chunk', model: 'capability-fixture', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
  chunk({ role: 'assistant' });
  if (step.tool) chunk({ tool_calls: [{ index: 0, id: `capability-call-${sequence}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] });
  else chunk({ content: step.text ?? 'fixture completed' });
  chunk({}, step.tool ? 'tool_calls' : 'stop', { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 });
  response.end('data: [DONE]\n\n');
}

async function until(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (check()) return; await delay(15); }
  throw new Error('Isolated capability conversation did not settle');
}

async function fixture(t, respond) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-capability-conversation-'));
  const workspace = join(directory, 'workspace'); await mkdir(workspace);
  const calls = [], providerErrors = [];
  const provider = http.createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      let raw = ''; for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw); calls.push(input);
      stream(response, await respond(input, calls.length), calls.length);
    } catch (error) {
      providerErrors.push(error);
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Fixture expectation failed' } }));
    }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  // Isolate foreground capability installation from project generation. These
  // legacy initialized fixture projects deliberately start without any skills.
  // Only foreground requests reach the local HTTP provider.
  const app = createServer({ stateFile: join(directory, '.state', 'state.json'), ticks: false, initiative: false });
  await app.initializer.close();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  async function post(path, input) {
    const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  }
  const selected = app.store.configurationService.provider(null, { name: 'Local capability fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'isolated-fixture-key', models: [{ id: 'capability-fixture', contextWindow: 128000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  app.store.configurationService.update({ defaultModel: { providerId: selected.id, modelId: 'capability-fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const primary = await post('/api/projects', { name: 'Capability foreground', workspace, initiative: { enabled: false } });
  // Directory identity is unique at the API boundary; a genuinely unrelated
  // project must use a different real directory, not another label for this one.
  const otherWorkspace = join(directory, 'unrelated-workspace'); await mkdir(otherWorkspace);
  const other = await post('/api/projects', { name: 'Unrelated project', workspace: otherWorkspace, initiative: { enabled: false } });
  const project = id => app.store.state.projects.find(item => item.id === id);
  app.store.mutate(state => { for (const item of [primary, other]) { const current = state.projects.find(row => row.id === item.project.id); current.initialization = { status: 'ready' }; current.simulated = false; current.decisionMode = 'rna-model'; current.assignments = structuredClone(baseline); } });
  await until(() => [primary, other].every(item => project(item.project.id)?.initialization.status === 'ready'));
  async function converse(text, target = primary) {
    const current = () => app.store.state.sessions.find(item => item.id === target.session.id);
    const index = current().turns.length;
    await post(`/api/sessions/${target.session.id}/messages`, { text, requestId: `foreground-${target.session.id}-${index}` });
    await until(() => ['completed', 'failed', 'stopped'].includes(current().turns[index]?.status));
    if (providerErrors.length) throw providerErrors[0];
    assert.equal(current().turns[index].status, 'completed', JSON.stringify(current().turns[index]));
    return current();
  }
  return { ...app, directory, workspace, calls, primary, other, project, converse };
}

function noOrdinaryMutations(input) {
  for (const name of ordinaryMutations) assert.ok(!names(input).includes(name), `${name} requires explicit assignment`);
}
function stableSystemPrefix(calls, forbidden = []) {
  const prefix = calls[0].messages.filter(message => message.role === 'system');
  assert.ok(prefix.length);
  for (const input of calls) {
    assert.deepEqual(input.messages.filter(message => message.role === 'system'), prefix);
    for (const text of forbidden) assert.ok(!JSON.stringify(prefix).includes(text), 'Skill body/resources must not enter system prefix');
  }
}
async function journal(session) {
  return (await readFile(session.runtime.sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

test('foreground repairs a failed skill install, loads complete bundle on demand on the next step, and preserves project scope/cache prefix', async t => {
  let source;
  const fullInstruction = 'SKILL_BODY_SENTINEL: confirm all conclusions using the adjacent reference file.';
  const guide = 'RESOURCE_SENTINEL: project answer is forty two.';
  const app = await fixture(t, (input, step) => {
    noOrdinaryMutations(input);
    if (step === 1) {
      assert.ok(names(input).includes('capability_install')); assert.ok(names(input).includes('skill_load'));
      const catalog = input.messages.findLast(message => message.role === 'user' && JSON.stringify(message.content).includes('capability-catalog'));
      assert.match(JSON.stringify(catalog), /rna-delivery-quality/); assert.ok(!JSON.stringify(catalog).includes('conversation-skill'));
      return { tool: 'capability_install', args: { kind: 'skill', id: 'conversation-skill', source: { type: 'local', path: join(source, 'nonexistent') }, activate: true } };
    }
    if (step === 2) {
      assert.match(lastResult(input), /not-published/); assert.ok(names(input).includes('skill_load'));
      assert.ok(!JSON.stringify(input.messages.findLast(message => message.role === 'user' && JSON.stringify(message.content).includes('capability-catalog'))).includes('conversation-skill'));
      assert.deepEqual(app.project(app.primary.project.id).assignments.skillIds, []);
      return { tool: 'capability_install', args: { kind: 'skill', id: 'conversation-skill', source: { type: 'local', path: source }, activate: true } };
    }
    if (step === 3) {
      assert.match(lastResult(input), /"status":"installed"/); assert.ok(names(input).includes('skill_load'));
      const catalogs = input.messages.filter(message => message.role === 'user' && JSON.stringify(message.content).includes('capability-catalog'));
      assert.equal(catalogs.length, 2);
      const catalog = JSON.stringify(catalogs.at(-1)); assert.match(catalog, /conversation-skill/); assert.match(catalog, /Fixture instructions and adjacent resources/); assert.match(catalog, /contentHash/);
      assert.ok(!JSON.stringify(input.messages).includes(fullInstruction)); assert.ok(!JSON.stringify(input.messages).includes(guide));
      return { tool: 'skill_load', args: { id: 'conversation-skill' } };
    }
    if (step === 4) { assert.match(lastResult(input), /SKILL_BODY_SENTINEL/); return { tool: 'skill_load', args: { id: 'conversation-skill', path: 'references/guide.md' } }; }
    if (step === 5) { assert.match(lastResult(input), /RESOURCE_SENTINEL/); return { text: 'The complete installed skill and its relative reference support answer forty two.' }; }
    assert.equal(step, 6); assert.ok(names(input).includes('skill_load'));
    assert.match(JSON.stringify(input.messages), /rna-delivery-quality/);
    assert.ok(!JSON.stringify(input.messages).includes('conversation-skill'));
    return { text: 'Unrelated project retained its own capabilities.' };
  });
  source = await skillFixture(app.directory, 'conversation-bundle');
  await writeFile(join(source, 'SKILL.md'), (await readFile(join(source, 'SKILL.md'), 'utf8')) + fullInstruction + '\n');
  await writeFile(join(source, 'references', 'guide.md'), guide);
  const otherBefore = structuredClone(app.project(app.other.project.id).assignments);
  const session = await app.converse('Install the provided local skill and use its referenced guide to answer.');
  assert.equal(app.calls.length, 5);
  const executions = session.items.filter(item => item.tool).map(item => item.tool);
  assert.deepEqual(executions.map(item => [item.name, item.status]), [['capability_install', 'failed'], ['capability_install', 'succeeded'], ['skill_load', 'succeeded'], ['skill_load', 'succeeded']]);
  assert.match(session.items.findLast(item => item.kind === 'assistant' && item.final).text, /forty two/);
  const records = await journal(session);
  assert.equal(records.filter(record => record.type === 'tool_uncertain').length, 0);
  assert.equal(records.filter(record => record.type === 'tool_completed' && record.data.message.toolName === 'capability_install' && record.data.isError).length, 1);
  assert.equal(records.filter(record => record.type === 'message' && record.data.message.contextKey === 'skill-catalog').length, 2, 'Initial host-method catalog and one installed-skill replacement; unchanged catalogs must not grow every request');
  stableSystemPrefix(app.calls, [fullInstruction, guide]);
  const installed = app.capabilityService.configuration().skills.find(skill => skill.id === 'conversation-skill');
  const installedRoot = join(installed.path, '..');
  assert.equal(await readFile(join(installedRoot, 'references', 'guide.md'), 'utf8'), guide);
  assert.equal(await readFile(join(installedRoot, 'scripts', 'helper.mjs'), 'utf8'), await readFile(join(source, 'scripts', 'helper.mjs'), 'utf8'));
  assert.deepEqual(app.project(app.other.project.id).assignments, otherBefore);
  await app.converse('List my available capabilities without installing anything.', app.other);
  assert.equal(app.calls.length, 6);
});

test('foreground MCP config import activates only explicit tools for this project and calls the actual stdio server next through the mcp loader', async t => {
  let serverPath;
  const app = await fixture(t, (input, step) => {
    noOrdinaryMutations(input);
    assert.ok(!names(input).includes('mcp__conversation-mcp__unapproved_write'));
    if (step === 1) {
      assert.ok(!names(input).some(name => name.startsWith('mcp__')));
      return { tool: 'capability_install', args: { kind: 'mcp', activate: true, source: { type: 'mcp-config', config: { mcpServers: { 'conversation-mcp': { command: process.execPath, args: [serverPath] } } } }, allowTools: { echo: { permission: 'read', idempotent: true } } } };
    }
    // A server assigned mid-session keeps the tools array stable: it is reached
    // through mcp/mcp_call rather than a new native declaration.
    if (step === 2) { assert.match(lastResult(input), /"status":"installed"/); assert.ok(!names(input).includes('mcp__conversation-mcp__echo')); assert.ok(names(input).includes('mcp_call')); return { tool: 'mcp_call', args: { tool: 'mcp__conversation-mcp__echo', arguments: { text: 'real-local-stdio-result' } } }; }
    if (step === 3) { assert.match(lastResult(input), /initialized:real-local-stdio-result/); return { text: 'The locally imported MCP returned its initialized response.' }; }
    assert.equal(step, 4); assert.ok(!names(input).some(name => name.startsWith('mcp__'))); return { text: 'No imported MCP assigned to this unrelated project.' };
  });
  serverPath = join(app.directory, 'fixture-mcp.mjs');
  await writeFile(serverPath, await readFile(new URL('../../../packages/sdk/test/fixtures/mcp-server.mjs', import.meta.url), 'utf8'));
  const otherBefore = structuredClone(app.project(app.other.project.id).assignments);
  const session = await app.converse('Import this local MCP and use only its echo tool.');
  assert.equal(app.calls.length, 3);
  assert.deepEqual(session.items.filter(item => item.tool).map(item => [item.tool.name, item.tool.status]), [['capability_install', 'succeeded'], ['mcp_call', 'succeeded']]);
  assert.deepEqual(app.project(app.primary.project.id).assignments.mcpServerIds, ['conversation-mcp']);
  assert.deepEqual(app.project(app.primary.project.id).assignments.toolIds, [...baseline.toolIds, 'mcp:conversation-mcp:echo']);
  assert.deepEqual(app.project(app.other.project.id).assignments, otherBefore);
  stableSystemPrefix(app.calls);
  assert.ok(!(await journal(session)).some(record => record.type === 'tool_uncertain'));
  await app.converse('Show my assigned tools.', app.other);
  assert.equal(app.calls.length, 4);
});

test('ordinary writes and exec are absent until explicit assignment, then update and execute on the next foreground step', async t => {
  const app = await fixture(t, (input, step) => {
    if (step === 1) {
      noOrdinaryMutations(input);
      return { tool: 'capability_assign', args: { toolIds: ordinaryMutations, reason: 'The user requested writing, editing and running the local fixture.' } };
    }
    if (step <= 5) for (const name of ordinaryMutations) assert.ok(names(input).includes(name), `${name} becomes available after assignment`);
    if (step === 2) return { tool: 'project_write', args: { path: 'result.txt', content: 'before edit\n', expectedHash: null } };
    if (step === 3) { assert.match(lastResult(input), /Saved result.txt\nSHA-256:/); return { tool: 'project_edit', args: { path: 'result.txt', oldText: 'before edit', newText: 'after edit' } }; }
    if (step === 4) { assert.match(lastResult(input), /Edited result.txt\nSHA-256:/); return { tool: 'project_exec', args: { command: 'cat result.txt', timeoutMs: 3000 } }; }
    if (step === 5) { assert.match(lastResult(input), /after edit/); return { text: 'Wrote, edited and verified the fixture through the assigned tools.' }; }
    assert.equal(step, 6); noOrdinaryMutations(input); return { text: 'Unrelated project still has no ordinary write or execution tools.' };
  });
  const otherBefore = structuredClone(app.project(app.other.project.id).assignments);
  await assert.rejects(stat(join(app.workspace, 'result.txt')), { code: 'ENOENT' });
  const session = await app.converse('Assign write/edit/exec to this project, write result.txt, edit it, and verify with cat.');
  assert.equal(app.calls.length, 5);
  assert.equal(await readFile(join(app.workspace, 'result.txt'), 'utf8'), 'after edit\n');
  assert.deepEqual(session.items.filter(item => item.tool).map(item => [item.tool.name, item.tool.status]), [['capability_assign', 'succeeded'], ['project_write', 'succeeded'], ['project_edit', 'succeeded'], ['project_exec', 'succeeded']]);
  assert.deepEqual(app.project(app.other.project.id).assignments, otherBefore);
  assert.ok(!(await journal(session)).some(record => record.type === 'tool_uncertain'));
  stableSystemPrefix(app.calls);
  await app.converse('Show my permissions without changing them.', app.other);
  assert.equal(app.calls.length, 6);
});

test('CLI and HTTP share inspect/install/list/assign/remove transactions without provider calls or cross-project grants', async t => {
  const app = await fixture(t, () => { throw new Error('Capability CLI must not invoke the model'); });
  const cliPath = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const port = String(app.server.address().port);
  const cli = async (...args) => {
    const { stdout, stderr } = await runProcess(process.execPath, [cliPath, ...args], { env: { ...process.env, RNA_AGENT_PORT: port }, timeout: 15000 });
    assert.equal(stderr, ''); return JSON.parse(stdout);
  };
  const file = async (name, value) => { const path = join(app.directory, name); await writeFile(path, JSON.stringify(value)); return path; };
  const skill = await skillFixture(app.directory, 'cli-bundle');
  const installInput = await file('install.json', { kind: 'skill', id: 'cli-installed', activate: true, source: { type: 'local', path: skill } });
  const inspected = await cli('capability-inspect', app.primary.project.id, installInput);
  assert.equal(inspected.kind, 'skill'); assert.equal(inspected.executesCode, false);
  assert.ok(!app.capabilityService.configuration().skills.some(row => row.id === 'cli-installed'));
  assert.deepEqual(app.project(app.primary.project.id).assignments, baseline);
  const installed = await cli('capability-install', app.primary.project.id, installInput);
  assert.equal(installed.status, 'installed'); assert.deepEqual(installed.assignments.skillIds, ['cli-installed']);
  const listed = await cli('project-capabilities', app.primary.project.id);
  const response = await fetch(`http://127.0.0.1:${port}/api/projects/${app.primary.project.id}/capabilities`);
  assert.equal(response.status, 200); assert.deepEqual(listed, await response.json());
  assert.deepEqual(app.project(app.other.project.id).assignments, baseline);
  const grantInput = await file('assign.json', { skillIds: ['cli-installed'], reason: 'Explicit grant to the second fixture project' });
  const granted = await cli('capability-assign', app.other.project.id, grantInput);
  assert.deepEqual(granted.assignments.skillIds, ['cli-installed']);
  const removeInput = await file('remove.json', { installationId: installed.installationId });
  const removed = await cli('capability-remove', app.primary.project.id, removeInput);
  assert.equal(removed.status, 'detached'); assert.deepEqual(removed.assignments.skillIds, []);
  assert.deepEqual(app.project(app.other.project.id).assignments.skillIds, ['cli-installed']);
  assert.ok(app.capabilityService.configuration().skills.some(row => row.id === 'cli-installed'));
  const retained = join(installed.installationDir, 'skill', 'references', 'guide.md');
  assert.equal(await readFile(retained, 'utf8'), 'supporting fixture resource');
  assert.equal(app.calls.length, 0);
});
