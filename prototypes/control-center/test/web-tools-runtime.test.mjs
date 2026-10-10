import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { CapabilityService } from '../capability-service.mjs';
import { BuiltinAgentService } from '../builtin-agent-service.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';

const names = request => (request.tools ?? []).map(row => row.function.name);
const webNames = ['web_search', 'web_fetch'];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const data = result => JSON.parse(result.content[0].text);
function stream(res, { tool, args, content = 'Read-only fixture response; source verification remains bounded.' } = {}) {
  const delta = tool ? { tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } : { content };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } })}\n\ndata: [DONE]\n\n`);
}
async function http(t, respond) {
  const requests = [], server = createServer(async (req, res) => {
    try { let raw = ''; for await (const part of req) raw += part; const row = { method: req.method, path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null }; requests.push(row); await respond(row, res, requests.length); }
    catch { res.destroy(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
async function crw(t, { marker = 'fixture', failFetch = false } = {}) {
  return http(t, (req, res) => {
    const echoedKey = req.headers.authorization?.slice(7) ?? '';
    res.writeHead(req.path.endsWith('/scrape') && failFetch ? 502 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.path.endsWith('/search') ? { success: true, data: { results: [{ url: 'https://example.com/source', title: marker, snippet: `Source snippet ${echoedKey}` }] } } : failFetch ? { success: false, error: echoedKey } : { success: true, data: { markdown: `# ${marker}\nContent ${echoedKey}`, metadata: { title: marker, sourceURL: 'https://example.com/source', statusCode: 200 } } }));
  });
}
async function fixture(t, respond) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-web-runtime-')), requests = [], events = [], handles = [];
  const llm = await http(t, async (request, res, count) => {
    requests.push(request.body);
    if (respond) return respond(request.body, res, count);
    const isToolResult = request.body.messages.at(-1)?.role === 'tool';
    stream(res, isToolResult ? {} : { tool: 'web_search', args: { query: 'public fixture source', limit: 1 } });
  });
  const remote = await crw(t), key = randomUUID(), store = new Store(join(directory, 'private', 'state.json'));
  store.configurationService.update({ webTools: { enabled: true, baseUrl: remote.baseUrl, apiKey: key }, memory: { autoRecall: false, autoStore: false } });
  const provider = store.configurationService.provider(null, { name: 'Isolated HTTP model fixture', protocol: 'openai', baseUrl: `${llm.baseUrl}/v1`, models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 512, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' } });
  const projects = [];
  for (const name of ['research', 'application']) {
    const workspace = join(directory, name); await mkdir(workspace);
    const created = store.createProject({ name, workspace, initiative: { enabled: false } });
    store.mutate(state => { const project = state.projects.find(row => row.id === created.project.id); project.assignments = { skillIds: [], toolIds: [], mcpServerIds: [] }; project.permissions = { ...project.permissions, workspace: 'read', background: 'read', revision: 1 }; });
    projects.push({ project: () => store.state.projects.find(row => row.id === created.project.id), session: created.session, workspace });
  }
  const capabilities = new CapabilityService(store), model = { providerId: provider.id, modelId: 'fixture', protocol: 'openai', baseUrl: `${llm.baseUrl}/v1`, contextWindow: 64000, maxOutputTokens: 512 };
  async function runtime(projectIndex, options = {}) {
    const selected = projects[projectIndex], sessionId = randomUUID(), cwd = selected?.workspace ?? directory;
    const handle = await createRnaRuntime({ ...(selected ? { project: selected.project(), getProject: selected.project, projectId: selected.project().id } : {}), cwd, sessionId, stateDir: join(directory, 'sessions', sessionId), model, capabilityService: capabilities, onEvent: event => events.push(event), ...options });
    handles.push(handle); return handle;
  }
  t.after(async () => { for (const handle of handles) await handle.dispose(); await capabilities.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, requests, events, handles, store, key, projects, capabilities, remote, runtime, model };
}

test('two ordinary projects with empty assignments and a projectless session naturally discover and execute global tools across six user turns', async t => {
  const f = await fixture(t);
  for (const projectIndex of [0, 1, undefined]) {
    const handle = await f.runtime(projectIndex), start = f.requests.length;
    assert.deepEqual(handle.snapshot().globalToolIds, webNames);
    for (let round = 0; round < 2; round++) await handle.prompt(`Look up public fixture round ${round + 1}.`);
    assert.equal(f.requests.length - start, 4);
    for (const request of f.requests.slice(start)) assert.ok(webNames.every(name => names(request).includes(name)));
    if (projectIndex !== undefined) assert.deepEqual(f.projects[projectIndex].project().assignments, { skillIds: [], toolIds: [], mcpServerIds: [] });
  }
  assert.equal(f.remote.requests.length, 6);
  for (const value of [f.requests, f.events, f.store.get(), ...f.handles.map(handle => handle.snapshot())]) assert.equal(JSON.stringify(value).includes(f.key), false);
  assert.ok(f.requests.some(row => JSON.stringify(row.messages).includes('[REDACTED]')));
});

test('ordinary agent sees no time-filter parameter and continues with one ordinary search', async t => {
  const f = await fixture(t, (request, res) => stream(res, request.messages.at(-1)?.role === 'tool' ? {} : { tool: 'web_search', args: { query: 'ai tools', limit: 5 } }));
  const remote = await http(t, (request, res) => {
    const filtered = Boolean(request.body.tbs);
    res.writeHead(filtered ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(filtered ? { success: false, errorCode: 'search_degraded' } : { success: true, data: { results: [{ url: 'https://example.com/source', title: 'Date unverified', snippet: 'Fetch this source to check its publication date.' }] } }));
  });
  f.store.configurationService.update({ webTools: { baseUrl: remote.baseUrl } });
  const handle = await f.runtime(0); await handle.prompt('Find recent AI tools; use original publication dates.');
  assert.equal(remote.requests.length, 1); assert.equal(f.requests.length, 2); assert.equal(Object.hasOwn(remote.requests[0].body, 'tbs'), false);
  assert.equal(Object.hasOwn(f.requests[0].tools.find(tool => tool.function.name === 'web_search').function.parameters.properties, 'tbs'), false);
  const toolMessage = f.requests[1].messages.find(message => message.role === 'tool'); assert.ok(toolMessage);
  const receipt = JSON.parse(toolMessage.content); assert.equal(receipt.ok, true); assert.equal(receipt.filterApplied, undefined); assert.equal(receipt.attempts, undefined); assert.equal(receipt.notice, undefined);
  assert.deepEqual(f.projects[0].project().assignments, { skillIds: [], toolIds: [], mcpServerIds: [] });
  assert.ok(!JSON.stringify(f.requests).includes(f.key));
});

test('explicit readonly and background read scopes retain global search and fetch without granting writes', async t => {
  const f = await fixture(t);
  for (const options of [{ readOnly: true }, { permissionScope: 'background' }]) {
    const handle = await f.runtime(0, options), start = f.requests.length; await handle.prompt('Read a public source within the current scope.');
    for (const request of f.requests.slice(start)) {
      assert.ok(webNames.every(name => names(request).includes(name)));
      assert.ok(!names(request).some(name => ['project_write', 'project_edit', 'project_exec'].includes(name)));
    }
  }
  assert.equal(f.remote.requests.length, 2);
});

test('enable and disable refresh the next request catalog within one handle without changing system prefix or earlier conversation', async t => {
  const f = await fixture(t, (_input, res) => stream(res)); f.store.configurationService.update({ webTools: { enabled: false } });
  const handle = await f.runtime(0);
  await handle.prompt('First turn, no networking.');
  f.store.configurationService.update({ webTools: { enabled: true } }); await handle.prompt('Second turn, networking now available.');
  f.store.configurationService.update({ webTools: { enabled: false } }); await handle.prompt('Third turn, networking disabled.');
  assert.equal(f.requests.length, 3);
  assert.ok(!names(f.requests[0]).some(name => webNames.includes(name))); assert.ok(webNames.every(name => names(f.requests[1]).includes(name))); assert.ok(!names(f.requests[2]).some(name => webNames.includes(name)));
  const prefix = f.requests[0].messages.filter(row => row.role === 'system'); assert.ok(prefix.length);
  for (const request of f.requests) { assert.deepEqual(request.messages.filter(row => row.role === 'system'), prefix); assert.equal(request.prompt_cache_key, f.requests[0].prompt_cache_key); }
  // The catalog changed (a cold break: the cached prefix ends at the tools), so superseded keyed copies (the earlier
  // authorization) fold to one line (spec p1 compaction TC-2); every other earlier message stays byte-identical in place.
  const earlier = f.requests[0].messages, later = f.requests[2].messages.slice(0, earlier.length);
  for (const [index, message] of earlier.entries()) {
    if (JSON.stringify(later[index]) === JSON.stringify(message)) continue;
    assert.equal(later[index].role, message.role); assert.match(JSON.stringify(later[index].content), /\[Superseded: a later update of /, `message ${index} changed without being a superseded copy`);
  }
  assert.equal(f.remote.requests.length, 0);
});

test('async request boundary host hook can enable networking before the first model catalog is sent', async t => {
  const f = await fixture(t); f.store.configurationService.update({ webTools: { enabled: false } }); let once = false;
  const handle = await f.runtime(0, { beforeRequest: async () => { if (!once) { once = true; await Promise.resolve(); f.store.configurationService.update({ webTools: { enabled: true } }); } } });
  await handle.prompt('Search when the configuration is current.'); assert.ok(webNames.every(name => names(f.requests[0]).includes(name))); assert.equal(f.remote.requests.length, 1);
});

test('a tool requested before disable is blocked at execution and the following provider request sees it removed', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, async (_input, res, count) => { if (count === 1) { entered.resolve(); await release.promise; stream(res, { tool: 'web_search', args: { query: 'must not leave fixture' } }); } else stream(res); });
  const staleTool = f.capabilities.globalTools().find(tool => tool.name === 'web_search'), handle = await f.runtime(0), pending = handle.prompt('A search may be revoked while waiting.');
  await entered.promise; f.store.configurationService.update({ webTools: { enabled: false } }); release.resolve(); await pending;
  assert.ok(names(f.requests[0]).includes('web_search')); assert.ok(!names(f.requests[1]).includes('web_search')); assert.equal(f.remote.requests.length, 0);
  const denied = await staleTool.execute('stale', { query: 'blocked' }); assert.equal(denied.isError, true); assert.equal(denied.details.executed, false); assert.equal(denied.details.code, 'WEB_TOOLS_DISABLED'); assert.equal(f.remote.requests.length, 0);
});

test('retained descriptors resolve a new endpoint and credential for the next execute without exposing either secret in catalog, events or outputs', async t => {
  const f = await fixture(t), replacement = await crw(t, { marker: 'replacement' }), nextKey = randomUUID();
  const descriptor = f.capabilities.globalTools().find(tool => tool.name === 'web_fetch'), catalog = JSON.stringify(f.capabilities.globalTools());
  const first = await descriptor.execute('first', { url: 'https://example.com/source' });
  f.store.configurationService.update({ webTools: { baseUrl: replacement.baseUrl, apiKey: nextKey } });
  const second = await descriptor.execute('second', { url: 'https://example.com/source' });
  assert.equal(data(first).title, 'fixture'); assert.equal(data(second).title, 'replacement');
  assert.equal(f.remote.requests[0].headers.authorization, `Bearer ${f.key}`); assert.equal(replacement.requests[0].headers.authorization, `Bearer ${nextKey}`); assert.equal(f.remote.requests.length, 1); assert.equal(replacement.requests.length, 1);
  assert.equal(JSON.stringify(f.capabilities.globalTools()), catalog);
  assert.ok(!catalog.includes(f.remote.baseUrl)); assert.ok(!catalog.includes(replacement.baseUrl));
  for (const value of [catalog, JSON.stringify(first), JSON.stringify(second), JSON.stringify(f.store.get())]) for (const key of [f.key, nextKey]) assert.ok(!value.includes(key));
});

test('host global names take priority over explicitly assigned custom names while enabled', async t => {
  const f = await fixture(t); let customCalls = 0;
  const custom = { id: 'custom-web-search', name: 'web_search', description: 'Custom conflicting tool must not replace global search.', permission: 'read', effect: 'read', idempotent: true, parameters: { type: 'object', properties: { query: { type: 'string' } } }, execute: () => { customCalls++; return 'CUSTOM_SHADOW_RESULT'; } };
  f.store.mutate(state => { state.projects.find(row => row.id === f.projects[0].project().id).assignments.toolIds = [custom.id]; });
  const handle = await f.runtime(0, { customTools: [custom] }); await handle.prompt('Use the globally configured source service.');
  assert.equal(names(f.requests[0]).filter(name => name === 'web_search').length, 1); assert.equal(customCalls, 0); assert.equal(f.remote.requests.length, 1); assert.ok(!JSON.stringify(f.requests).includes('CUSTOM_SHADOW_RESULT'));
});

test('builtin scout executes global web tools through the actual bounded child service and keeps parent assignments empty', async t => {
  const f = await fixture(t), selected = f.projects[0]; f.store.message(selected.session.id, { text: 'Read-only source research', requestId: 'web-child-parent' });
  const session = f.store.state.sessions.find(row => row.id === selected.session.id), service = new BuiltinAgentService(f.store, { capabilityService: f.capabilities }); t.after(() => service.close());
  const tool = service.createTools({ sessionId: session.id, turnId: session.activeTurnId }).find(row => row.name === 'agent_consult');
  const output = await tool.execute('web-child-once', { role: 'scout', task: 'Find the public fixture source and state the scope of its snippet.', wait: true }, new AbortController().signal);
  assert.equal(data(output).status, 'completed'); assert.equal(f.remote.requests.length, 1); assert.equal(f.requests.length, 2);
  assert.ok(webNames.every(name => names(f.requests[0]).includes(name))); assert.ok(!names(f.requests[0]).some(name => ['project_write', 'project_exec', 'agent_delegate'].includes(name)));
  assert.deepEqual(selected.project().assignments, { skillIds: [], toolIds: [], mcpServerIds: [] }); assert.ok(!JSON.stringify(output).includes(f.key));
  const childRoot = join(`${f.store.file}.rna`, session.id, 'agents'), directories = await readdir(childRoot);
  for (const directory of directories) for (const file of await readdir(join(childRoot, directory))) if (file.endsWith('.jsonl')) assert.ok(!(await readFile(join(childRoot, directory, file), 'utf8')).includes(f.key));
});
