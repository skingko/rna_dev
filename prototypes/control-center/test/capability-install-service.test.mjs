import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { Store } from '../store.mjs';
import { CapabilityService } from '../capability-service.mjs';
import { CapabilityInstallService } from '../capability-install-service.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { projectGenomeFixture } from '../../../packages/sdk/test/fixtures/project-genome-fixture.mjs';
import { skillFixture, npmRegistryFixture } from '../../../packages/sdk/test/fixtures/capability-fixtures.mjs';
import { readStateText } from '../state-shards.mjs';

const serverPath = fileURLToPath(new URL('../../../packages/sdk/test/fixtures/mcp-server.mjs', import.meta.url));
const memoryDeclarations = ['openviking_search', 'openviking_read'].map(name => ({name,permission:'read',parameters:{type:'object'},execute(){return {content:[]}}}));
const baselineTools = ['project_read', 'project_list', 'openviking_search', 'openviking_read'];
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-install-host-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = join(dir, 'workspace'); await mkdir(workspace); const store = new Store(join(dir, 'state.json'));
  const a = store.createProject({ name: 'Installation A', workspace }).project.id, b = store.createProject({ name: 'Isolation B', workspace }).project.id;
  const capabilities = new CapabilityService(store), service = new CapabilityInstallService(store, { capabilityService: capabilities });
  return { dir, workspace, store, a, b, capabilities, service, project: id => store.state.projects.find(project => project.id === id) };
}
const localServer = (id = 'fixture-mcp', extra = {}) => ({ kind: 'mcp', activate: true, source: { type: 'mcp-config', config: { mcpServers: { [id]: { command: process.execPath, args: [serverPath], ...extra } } } }, allowTools: { echo: { permission: 'read', idempotent: true } } });

test('activation validates all granted schemas without requiring ungranted extensions', async t => {
  const f = await fixture(t);
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (body.id === undefined) { res.writeHead(202); res.end(); return; }
    const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'schema-subset', version: '1' } } : { tools: [
      { name: 'echo', inputSchema: { type: 'object', properties: {} } },
      { name: 'extension', inputSchema: { type: 'object', propertyNames: { pattern: '^x' } } },
    ] };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const input = (id, allowTools) => ({ kind: 'mcp', activate: true, allowTools, source: { type: 'mcp-config', config: { mcpServers: { [id]: { type: 'streamable-http', url: `http://127.0.0.1:${server.address().port}/mcp` } } } } });
  const result = await f.service.install(f.a, input('subset', { echo: { permission: 'read' } }));
  assert.equal(result.discovered[0].tools.find(row => row.name === 'extension').granted, false);
  await assert.rejects(f.service.install(f.a, input('bad-subset', { extension: { permission: 'exec' } })), { code: 'unsupported_schema' });
  assert.equal(f.capabilities.configuration().mcpServers.some(row => row.id === 'bad-subset'), false);
});

test('generated capabilities follow only the selected project version and cannot be reassigned or removed through generic management', async t => {
  const f = await fixture(t), genomes = new ProjectGenomeStore(f.store), prepared = [];
  for (const versionId of ['version-a', 'version-b']) {
    const entry = await genomes.prepare(f.project(f.a), { genome: projectGenomeFixture(versionId), versionId }); await entry.commit(); prepared.push(entry);
    f.store.mutate(state => { state.projects.find(p => p.id === f.a).versions.push({ id: versionId, bundle: entry.record, generatedSkills: entry.skillManifests, generatedTools: entry.toolDescriptors }); state.capabilities ??= structuredClone(f.capabilities.configuration()); state.capabilities.skills.push(...entry.skillManifests); });
  }
  f.store.mutate(state => { const p = state.projects.find(p => p.id === f.a); p.activeVersionId = 'version-a'; p.trialVersionId = 'version-b'; });
  const listed = f.service.list(f.a); assert.deepEqual(listed.skills.filter(s => s.generated).map(s => s.id), prepared[1].skillManifests.map(s => s.id)); assert.deepEqual(listed.tools.filter(s => s.generated).map(s => s.id), prepared[1].toolDescriptors.map(s => s.id)); assert.equal(f.service.list(f.b).skills.some(s => s.generated), false);
  await assert.rejects(f.service.assign(f.b, { skillIds: [prepared[0].skillManifests[0].id], activate: true }), error => error.status === 409 && /版本管理/.test(error.message)); assert.equal(f.project(f.b).assignments, undefined);
  for (const [kind, id] of [['skills', prepared[1].skillManifests[0].id], ['tools', prepared[1].toolDescriptors[0].id]]) await assert.rejects(f.service.remove(f.a, { kind, id }), error => error.status === 409 && /版本管理/.test(error.message));
  f.store.mutate(state => { state.projects.find(p => p.id === f.a).trialVersionId = null; }); assert.deepEqual(f.service.list(f.a).skills.filter(s => s.generated).map(s => s.id), prepared[0].skillManifests.map(s => s.id));
});

test('Skill installation activates only its project, persists revision, and replays completed request IDs without duplication', async t => {
  const f = await fixture(t), path = await skillFixture(f.dir), input = { kind: 'skill', id: 'installed-skill', source: { type: 'local', path }, activate: true };
  const installed = await f.service.install(f.a, input, { requestId: 'one-request' });
  assert.equal(installed.status, 'installed'); assert.deepEqual(f.project(f.a).assignments.skillIds, ['installed-skill']); assert.equal(f.project(f.b).assignments, undefined);
  assert.equal(f.capabilities.revision(), 1); const replay = await f.service.install(f.a, input, { requestId: 'one-request' }); assert.equal(replay.replayed, true); assert.equal(f.capabilities.revision(), 1);
  await assert.rejects(f.service.install(f.a, { ...input, id: 'different' }, { requestId: 'one-request' }), { code: 'request_conflict' });
  const reopened = new Store(f.store.file); assert.equal(new CapabilityService(reopened).revision(), 1); assert.equal(reopened.state.projects.find(project => project.id === f.a).assignments.skillIds[0], 'installed-skill');
  assert.equal((await stat(join(installed.installationDir, 'skill/references/guide.md'))).isFile(), true);
});

test('Install without activation never starts MCP; explicit assign activates and grants only named tools', async t => {
  const f = await fixture(t), input = localServer(); input.activate = false;
  await f.service.install(f.a, input); assert.equal(f.project(f.a).assignments, undefined);
  const manifest = f.capabilities.configuration().mcpServers[0]; assert.equal(manifest.enabled, false); assert.equal(manifest.discoveredTools, undefined);
  await assert.rejects(f.service.assign(f.a, { mcpServerIds: [manifest.id] }), /尚未启用/);
  const assigned = await f.service.assign(f.a, { mcpServerIds: [manifest.id], activate: true }); assert.deepEqual(assigned.assignments.toolIds, [...baselineTools, 'mcp:fixture-mcp:echo']);
  assert.equal(assigned.discovered[0].tools.find(tool => tool.name === 'unapproved_write').granted, false);
  const { registry } = await f.capabilities.registry(f.project(f.a), memoryDeclarations, { connectIds: ['fixture-mcp'] }); t.after(() => registry.close());
  const selected = await registry.resolve(f.project(f.a).assignments); assert.deepEqual(selected.tools.filter(tool => tool.mcpServerId).map(tool => tool.name), ['mcp__fixture-mcp__echo']);
  assert.equal((await selected.tools.find(tool=>tool.mcpServerId).execute('call', { text: 'hello' })).content[0].text, 'initialized:hello');
});

test('Multi-server activation failure restores the exact capability state and removes the staged generation', async t => {
  const f = await fixture(t), bad = join(f.dir, 'bad.mjs'); await writeFile(bad, 'process.stdout.write("not-json\\n"); setTimeout(()=>process.exit(1),20);');
  const before = JSON.stringify(f.capabilities.public()), input = localServer(); input.source.config.mcpServers.bad = { command: process.execPath, args: [bad] };
  await assert.rejects(f.service.install(f.a, input), /MCP/); assert.equal(JSON.stringify(f.capabilities.public()), before); assert.equal(f.project(f.a).assignments, undefined);
  assert.deepEqual(await readdir(f.service.rootDir), ['.transactions']); const transaction = JSON.parse(await readFile(join(f.service.rootDir, '.transactions', (await readdir(join(f.service.rootDir, '.transactions')))[0]), 'utf8')); assert.equal(transaction.status, 'failed');
});

test('npm MCP JSON import pins npx package locally, skips postinstall, activates and calls the discovered tool', { timeout: 30000 }, async t => {
  const f = await fixture(t), fixtureRegistry = await npmRegistryFixture(f.dir); t.after(() => fixtureRegistry.close());
  const installed = await f.service.install(f.a, { kind: 'mcp', activate: true, source: { type: 'mcp-config', config: { mcpServers: { 'npm-local': { command: 'npx', args: ['-y', fixtureRegistry.name], registry: fixtureRegistry.base } } } }, toolPermission: 'exec' });
  const manifest = f.capabilities.configuration().mcpServers[0]; assert.equal(manifest.command, process.execPath); assert.ok(!manifest.args.includes('-y')); assert.equal(installed.sources[0].version, '1.2.3');
  assert.deepEqual(installed.discovered[0].tools.map(tool => tool.permission), ['exec', 'exec']);
  const { registry } = await f.capabilities.registry(f.project(f.a), memoryDeclarations, { connectIds: ['npm-local'] }); t.after(() => registry.close()); const resolved = await registry.resolve(f.project(f.a).assignments);
  assert.equal((await resolved.tools.find(tool => tool.rawName === 'echo').execute('call', { text: 'npm fixture' })).content[0].text, 'initialized:npm fixture');
  await assert.rejects(stat(join(manifest.cwd, 'node_modules', fixtureRegistry.name, 'postinstall-ran')), { code: 'ENOENT' });
});

test('Packages requiring postinstall fail activation without publishing a partial install or silently running scripts', { timeout: 30000 }, async t => {
  const f = await fixture(t), fixtureRegistry = await npmRegistryFixture(f.dir, { native: true }); t.after(() => fixtureRegistry.close());
  await assert.rejects(f.service.install(f.a, { kind: 'mcp', id: 'native-fixture', source: { type: 'npm', package: fixtureRegistry.name, registry: fixtureRegistry.base }, activate: true, toolPermission: 'exec' }), /MCP/);
  assert.equal(f.capabilities.configuration().mcpServers.length, 0); assert.equal(f.project(f.a).assignments, undefined); assert.deepEqual(await readdir(f.service.rootDir), ['.transactions']);
});

test('Unregister respects other project grants, leaves in-flight client ownership alone, and preserves generation files', async t => {
  const f = await fixture(t), installed = await f.service.install(f.a, localServer()); await f.service.assign(f.b, { mcpServerIds: ['fixture-mcp'] });
  await assert.rejects(f.service.remove(f.a, { installationId: installed.installationId, uninstall: true }), { code: 'capability_in_use' }); assert.deepEqual(f.project(f.a).assignments.mcpServerIds, ['fixture-mcp']);
  await f.service.remove(f.b, { installationId: installed.installationId });
  const { registry } = await f.capabilities.registry(f.project(f.a), memoryDeclarations, { connectIds: ['fixture-mcp'] }); t.after(() => registry.close()); const { tools } = await registry.resolve(f.project(f.a).assignments);
  const removed = await f.service.remove(f.a, { installationId: installed.installationId, uninstall: true }); assert.equal(removed.status, 'unregistered'); assert.equal(removed.filesRetained, true); assert.deepEqual(f.project(f.a).assignments.toolIds, baselineTools);
  assert.equal((await tools.find(tool=>tool.mcpServerId).execute('old-call', { text: 'still owned' })).content[0].text, 'initialized:still owned'); assert.equal((await stat(installed.installationDir)).isDirectory(), true);
});

test('C4: removing a capability tells the revocation dispatcher which skills, tools and services left the project', async t => {
  const f = await fixture(t), installed = await f.service.install(f.a, localServer()), told = [];
  f.service.onWithdrawn = event => told.push(event);
  await f.service.remove(f.a, { installationId: installed.installationId });
  assert.equal(told.length, 1); assert.equal(told[0].type, 'tool_withdrawn'); assert.equal(told[0].projectId, f.a);
  assert.ok(told[0].tools.some(row => row.kind === 'mcp' && row.id === 'fixture-mcp'), 'the service that left'); assert.ok(told[0].tools.filter(row => row.kind === 'tool').length > 0 && told[0].tools.filter(row => row.kind === 'tool').every(row => row.id.startsWith('mcp:fixture-mcp:')), 'and its tools: the dispatcher asks which notes, plan items and lessons still tell the assistant to use them');
  // An observer that throws never blocks a removal.
  await f.service.assign(f.a, { mcpServerIds: ['fixture-mcp'] }); f.service.onWithdrawn = () => { throw new Error('observer failed'); };
  assert.equal((await f.service.remove(f.a, { installationId: installed.installationId })).status, 'detached');
});

test('Declarative command tools validate arguments, use JSON stdin/output, and redact explicitly referenced credentials', async t => {
  const f = await fixture(t), path = join(f.dir, 'command.mjs'); await writeFile(path, 'let input=""; for await(const chunk of process.stdin)input+=chunk; const args=JSON.parse(input); console.log(JSON.stringify({text:args.text,secret:process.env.CAPABILITY_SECRET}));');
  process.env.RNA_TEST_CAPABILITY_SECRET = 'fixture-sensitive-credential'; t.after(() => { delete process.env.RNA_TEST_CAPABILITY_SECRET; });
  await f.service.install(f.a, { kind: 'tool', id: 'json-fixture', activate: true, permission: 'exec', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, source: { type: 'command', command: process.execPath, args: [path], env: { CAPABILITY_SECRET: '${RNA_TEST_CAPABILITY_SECRET}' } } });
  const { registry } = await f.capabilities.registry(f.project(f.a), memoryDeclarations); t.after(() => registry.close()); const selected = await registry.resolve(f.project(f.a).assignments), tool = selected.tools.find(tool=>tool.id==='json-fixture');
  await assert.rejects(tool.execute('invalid', {}), /required/); const response = (await tool.execute('valid', { text: 'actual JSON' })).content[0].text; assert.match(response, /actual JSON/); assert.match(response, /REDACTED/); assert.doesNotMatch(response, /fixture-sensitive-credential/);
  assert.ok(!readStateText(f.store.file).includes('fixture-sensitive-credential'));
});

test('Agent-facing management tools share installation transactions and emit change notifications only after commit', async t => {
  const f = await fixture(t), path = await skillFixture(f.dir); let changes = 0; const tools = f.service.createTools(f.a, { onChanged: () => changes++ });
  assert.equal(tools.find(tool => tool.name === 'capability_install').permission, 'exec'); assert.equal(tools.find(tool => tool.name === 'capability_inspect').permission, 'read');
  const input = { kind: 'skill', id: 'agent-installed', source: { type: 'local', path }, activate: true };
  await tools.find(tool => tool.name === 'capability_inspect').execute('inspect', input); assert.equal(changes, 0);
  const response = await tools.find(tool => tool.name === 'capability_install').execute('install-call', input); assert.equal(JSON.parse(response.content[0].text).status, 'installed'); assert.equal(changes, 1);
  assert.deepEqual(f.project(f.a).assignments.skillIds, ['agent-installed']);
  const invalid = await tools.find(tool => tool.name === 'capability_install').execute('bad-path', { kind: 'skill', source: { type: 'local', path: join(f.dir, 'missing') }, activate: true });
  assert.equal(invalid.isError, true); assert.equal(JSON.parse(invalid.content[0].text).outcome, 'not-published'); assert.equal(changes, 1);
  await f.service.install(f.a, { ...localServer('unavailable'), activate: false });
  f.store.mutate(state => { state.capabilities.mcpServers[0].command = '/a/missing/fixture-command'; });
  const failedActivation = await tools.find(tool => tool.name === 'capability_assign').execute('failed-activation', { mcpServerIds: ['unavailable'], activate: true });
  assert.equal(failedActivation.isError, true); assert.equal(JSON.parse(failedActivation.content[0].text).outcome, 'not-published'); assert.equal(f.project(f.a).assignments.mcpServerIds.length, 0); assert.equal(changes, 1);
});

test('Source inspection maps correctable input errors without publishing or exposing credentials', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.inspect({ kind: 'skill', source: { type: 'local', path: join(f.dir, 'missing') } }, { projectId: f.a }), { status: 404, code: 'ENOENT', outcome: 'not-published' });
  const invalid = localServer('invalid', { allowTools: { echo: { permission: 'admin' } } });
  await assert.rejects(f.service.inspect(invalid, { projectId: f.a }), { status: 400, code: 'invalid_install' });
  const secret = localServer('secret', { env: { TOKEN: 'must-not-appear-in-error' } });
  await assert.rejects(f.service.inspect(secret, { projectId: f.a }), error => { assert.equal(error.status, 400); assert.ok(!error.message.includes('must-not-appear-in-error')); return true; });
  assert.equal(f.capabilities.configuration().installations.length, 0);
});

test('Imported explicit permission maps, including empty maps, are never widened by a blanket activation permission', async t => {
  const f = await fixture(t);
  for (const [id, allowTools] of [['restricted', { echo: { permission: 'read', idempotent: true } }], ['none', {}]]) {
    const input = localServer(id, { allowTools }); input.toolPermission = 'exec';
    await f.service.install(f.a, input);
    const manifest = f.capabilities.configuration().mcpServers.find(row => row.id === id);
    assert.deepEqual(manifest.allowTools, allowTools); assert.equal(manifest.allowToolsSpecified, true);
    assert.equal(manifest.discoveredTools.find(tool => tool.name === 'unapproved_write').granted, false);
    await f.service.assign(f.b, { mcpServerIds: [id], activate: true, toolPermission: 'exec' });
    assert.deepEqual(f.capabilities.configuration().mcpServers.find(row => row.id === id).allowTools, allowTools);
  }
});

test('HTTP MCP import uses referenced credentials, conservatively grants exec despite read-only annotations, and calls the server', async t => {
  const f = await fixture(t), requests = []; process.env.RNA_HTTP_MCP_AUTH = 'Bearer local-fixture-auth'; t.after(() => { delete process.env.RNA_HTTP_MCP_AUTH; });
  const server = createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; const body = raw ? JSON.parse(raw) : {}; requests.push({ body, authorization: req.headers.authorization }); if (body.id === undefined) { res.writeHead(202); res.end(); return; } let result;
    if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } };
    else if (body.method === 'tools/list') result = { tools: [{ name: 'echo', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', $comment: 'Standard JSON Schema annotations', properties: { text: { type: 'string', format: 'uri', contentEncoding: 'base64', contentMediaType: 'text/plain' } }, required: ['text'] } }] };
    else result = { content: [{ type: 'text', text: body.params.arguments.text }] };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await f.service.install(f.a, { kind: 'mcp', activate: true, toolPermission: 'exec', source: { type: 'mcp-config', config: { mcpServers: { http: { type: 'streamable-http', url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: '${RNA_HTTP_MCP_AUTH}' } } } } } });
  const manifest = f.capabilities.configuration().mcpServers[0]; assert.equal(manifest.allowTools.echo.permission, 'exec'); assert.equal(requests[0].authorization, 'Bearer local-fixture-auth');
  const { registry } = await f.capabilities.registry(f.project(f.a), memoryDeclarations, { connectIds: ['http'] }); t.after(() => registry.close()); const { tools } = await registry.resolve(f.project(f.a).assignments); assert.equal((await tools.find(tool=>tool.mcpServerId).execute('call', { text: 'over HTTP' })).content[0].text, 'over HTTP'); assert.ok(!readStateText(f.store.file).includes('Bearer local-fixture-auth'));
});

test('Imported disabled servers remain inactive, and native/control-plane tool names cannot be shadowed', async t => {
  const f = await fixture(t), input = localServer('disabled', { disabled: true, args: ['/a/missing/script-that-must-not-run.mjs'] });
  const result = await f.service.install(f.a, input); assert.equal(result.activated, false); assert.equal(f.project(f.a).assignments, undefined); assert.equal(f.capabilities.configuration().mcpServers[0].enabled, false);
  await assert.rejects(f.service.install(f.a, { kind: 'tool', id: 'capability_install', activate: true, source: { type: 'command', command: process.execPath, args: ['--version'] } }), { code: 'capability_conflict' });
  assert.equal(f.capabilities.configuration().tools.length, 0);
});

test('Builtin write/exec grants can be revoked project by project and can never be unregistered', async t => {
  const f = await fixture(t), names = ['project_write', 'project_edit', 'project_exec'];
  assert.equal(f.service.list(f.a).tools.filter(tool => tool.builtin).length, 9);
  assert.deepEqual(f.service.list(f.a).assignments.toolIds, baselineTools);
  await f.service.assign(f.a, { toolIds: names });
  for (const id of names) {
    assert.ok(f.project(f.a).assignments.toolIds.includes(id));
    await assert.rejects(f.service.remove(f.a, { kind: 'tools', id, uninstall: true }), { status: 409 });
    const removed = await f.service.remove(f.a, { kind: 'tools', id }); assert.equal(removed.status, 'detached');
    assert.ok(!f.project(f.a).assignments.toolIds.includes(id));
  }
  assert.equal(f.project(f.b).assignments, undefined); assert.equal(f.service.list(f.a).tools.filter(tool => tool.builtin).length, 9);
});

test('A durable-state write failure rolls back the new generation and can be retried with the same request ID', async t => {
  const f = await fixture(t), path = await skillFixture(f.dir), input = { kind: 'skill', id: 'write-failure', activate: true, source: { type: 'local', path } }, persist = f.store.persist.bind(f.store), before = JSON.stringify(f.store.state);
  f.store.persist = () => { throw new Error('fixture disk failure'); };
  await assert.rejects(f.service.install(f.a, input, { requestId: 'retry-after-disk' }), /disk failure/); assert.equal(JSON.stringify(f.store.state), before); assert.deepEqual(await readdir(f.service.rootDir), ['.transactions']);
  f.store.persist = persist; const result = await f.service.install(f.a, input, { requestId: 'retry-after-disk' }); assert.equal(result.status, 'installed'); assert.deepEqual(f.project(f.a).assignments.skillIds, ['write-failure']);
});

test('Concurrent management requests serialize publication without losing either project assignment', async t => {
  const f = await fixture(t), path = await skillFixture(f.dir); let release, entered; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; }), original = f.service.installer.prepare.bind(f.service.installer), order = [];
  f.service.installer.prepare = async (...args) => { order.push(args[0].id); if (args[0].id === 'first') { entered(); await gate; } return original(...args); };
  const first = f.service.install(f.a, { kind: 'skill', id: 'first', activate: true, source: { type: 'local', path } }); await started;
  const second = f.service.install(f.a, { kind: 'skill', id: 'second', activate: true, source: { type: 'local', path } }); assert.deepEqual(order, ['first']); release(); await Promise.all([first, second]); assert.deepEqual(order, ['first', 'second']); assert.deepEqual(f.project(f.a).assignments.skillIds, ['first', 'second']); assert.equal(f.capabilities.revision(), 2);
});
