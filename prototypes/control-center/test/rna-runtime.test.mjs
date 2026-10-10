import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRnaRuntime, createProjectReadTools } from '../rna-runtime.mjs';
import { SKILL_DISCOVERY_GUIDANCE } from '../../../packages/sdk/src/skill-catalog.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const usage = { prompt_tokens: 25, completion_tokens: 7, total_tokens: 32, prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 3 } };
function chunk(res, value) { res.write(`data: ${JSON.stringify(value)}\n\n`); }
function completion(res, text = 'fixture answer') {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  chunk(res, { id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
  chunk(res, { id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
  res.end('data: [DONE]\n\n');
}
function toolCompletion(res, name, args) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  chunk(res, { id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] });
  chunk(res, { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage });
  res.end('data: [DONE]\n\n');
}
async function fixture(t, responder = (_req, res) => completion(res)) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-sdk-'));
  const cwd = join(dir, 'workspace'), stateDir = join(dir, 'rna'); await mkdir(cwd); await writeFile(join(cwd, 'README.md'), 'project fixture\nsecond line');
  const requests = [], handles = [];
  const server = createServer(async (req, res) => {
    try { const chunks = []; for await (const data of req) chunks.push(data); const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ url: req.url, headers: req.headers, body }); await responder(requests.at(-1), res, requests.length); }
    catch (error) { if (!res.destroyed) { res.writeHead(500); res.end(String(error)); } }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const options = { sessionId: 'host-session', projectId: 'project', cwd, stateDir, model: { providerId: 'fixture-provider', modelId: 'fixture-model', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 64000, maxOutputTokens: 127, reasoning: 'off' }, apiKey: 'fixture-private-token', compaction: false };
  t.after(async () => { for (const handle of handles) await handle.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { dir, cwd, stateDir, requests, options, create: async extra => { const handle = await createRnaRuntime({ ...options, ...extra }); handles.push(handle); return handle; } };
}
const textOf = message => typeof message.content === 'string' ? message.content : message.content?.filter(part => part.type === 'text').map(part => part.text).join('');

test('private command capture remains readable after recovery and exec permission revocation without replay', async t => {
  let outputId, executions = 0;
  const f = await fixture(t, (req, res, n) => {
    if (n === 1) { executions++; return toolCompletion(res, 'project_exec', { command: "printf 'captured-command-proof'" }); }
    if (n === 2) { outputId = req.body.messages.findLast(row => row.role === 'tool').content.match(/Capture ID: (rna-exec-[A-Za-z0-9_-]{6})/)[1]; return completion(res); }
    if (n === 3) {
      assert.ok(!req.body.tools.some(row => row.function.name === 'project_exec'));
      assert.ok(req.body.tools.some(row => row.function.name === 'project_exec_output'));
      return toolCompletion(res, 'project_exec_output', { outputId });
    }
    assert.match(req.body.messages.findLast(row => row.role === 'tool').content, /captured-command-proof/); return completion(res);
  });
  const project = { id: 'project', workspace: f.cwd, permissions: { workspace: 'execute', background: 'read' }, assignments: { skillIds: [], toolIds: ['project_exec'], mcpServerIds: [] } };
  const first = await f.create({ project }); await first.prompt('Run an authorized one-time command.'); const sessionFile = first.snapshot().sessionFile; await first.dispose();
  project.permissions.workspace = 'read'; project.assignments.toolIds = ['project_read'];
  const recovered = await f.create({ project, sessionFile }); await recovered.prompt('Read its existing capture; do not execute again.');
  assert.equal(executions, 1); assert.equal(f.requests.length, 4);
  const captured = await readFile(join(f.stateDir, 'exec', outputId, 'output.log'), 'utf8'); assert.equal(captured, 'captured-command-proof');
});

test('Rna SDK performs selected-provider streaming, output cap, cache usage and durable recovery', { timeout: 20000 }, async t => {
  const f = await fixture(t); const events = [];
  const handle = await f.create({ onEvent: event => events.push(event) });
  await handle.prompt('first prompt');
  assert.equal(f.requests.length, 1); const request = f.requests[0];
  assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.headers.authorization, 'Bearer fixture-private-token');
  assert.equal(request.body.model, 'fixture-model'); assert.equal(request.body.max_completion_tokens, 127);
  assert.ok(request.body.messages.some(message => textOf(message) === 'first prompt'));
  assert.deepEqual(request.body.tools.map(tool => tool.function.name).sort(), ['project_find', 'project_grep', 'project_list', 'project_read', 'skill_load', 'tool_output_read']);
  assert.ok(request.body.messages.some(message => textOf(message)?.includes(SKILL_DISCOVERY_GUIDANCE)), 'normal work receives the same discovery contract as evaluation');
  assert.ok(!textOf(request.body.messages[0])?.includes(SKILL_DISCOVERY_GUIDANCE), 'catalog remains a durable context update, outside the stable system prefix');
  assert.ok(events.some(event => event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta'));
  assert.equal(events.at(-1).type, 'agent_settled'); assert.ok(events.every(event => event.sessionId === 'host-session'));
  const snapshot = handle.snapshot(); assert.equal(snapshot.idle, true); assert.equal(snapshot.cacheWarming, 'off');
  assert.deepEqual(snapshot.usage, { input: 12, output: 7, cacheRead: 10, cacheWrite: 3, totalTokens: 32, costStatus: 'unpriced' });
  assert.equal((await stat(snapshot.sessionFile)).mode & 0o777, 0o600); assert.equal((await stat(f.stateDir)).mode & 0o777, 0o700);
  const raw = await readFile(snapshot.sessionFile, 'utf8'); assert.ok(raw.includes('fixture answer')); assert.ok(!raw.includes(f.options.apiKey));
  await handle.dispose();
  const resumed = await f.create({ sessionFile: snapshot.sessionFile });
  assert.equal(resumed.snapshot().sessionId, snapshot.sessionId);
  await resumed.prompt('second prompt');
  const history = f.requests[1].body.messages;
  assert.equal(history.filter(message => textOf(message)?.includes(SKILL_DISCOVERY_GUIDANCE)).length, 1, 'unchanged catalog is reused after recovery');
  assert.ok(history.some(message => textOf(message)?.includes('first prompt'))); assert.ok(history.some(message => textOf(message)?.includes('fixture answer')));
  assert.equal(history[0].content, request.body.messages[0].content, 'stable system prefix survives recovery');
});

test('Rna executes its scoped read tool and a host custom tool through real tool-call loops', { timeout: 20000 }, async t => {
  const f = await fixture(t, (_req, res, n) => n === 1 ? toolCompletion(res, 'project_read', { path: 'README.md', limit: 1 }) : n === 2 ? toolCompletion(res, 'openviking_fixture', { query: 'memo' }) : completion(res));
  const events = []; let searched = false;
  const handle = await f.create({ onEvent: event => events.push(event), customTools: [{ name: 'openviking_fixture', permission: 'read', effect: 'read', label: 'Memory fixture', description: 'Test custom tool injection', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, execute: async (_id, args) => { searched = args.query === 'memo'; return { content: [{ type: 'text', text: 'actual fixture memory' }], details: { source: 'fixture' } }; } }] });
  await handle.prompt('read then search');
  assert.equal(f.requests.length, 3); assert.equal(searched, true);
  assert.ok(f.requests[1].body.messages.some(message => message.role === 'tool' && textOf(message).includes('project fixture')));
  assert.ok(f.requests[2].body.messages.some(message => message.role === 'tool' && textOf(message).includes('actual fixture memory')));
  assert.equal(events.filter(event => event.type === 'tool_execution_end').length, 2);
  assert.equal(handle.snapshot().messages.filter(message => message.role === 'toolResult').length, 2);
});

test('Rna steers and follows up within the running conversation before prompt settles', { timeout: 20000 }, async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, async (_req, res, n) => {
    if (n !== 1) return completion(res, `answer ${n}`);
    res.writeHead(200, { 'content-type': 'text/event-stream' }); chunk(res, { choices: [{ index: 0, delta: { role: 'assistant', content: 'working' }, finish_reason: null }] });
    await gate.promise; chunk(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }); res.end('data: [DONE]\n\n');
  });
  const events = []; const handle = await f.create({ onEvent: event => { events.push(event); if (event.type === 'message_update') started.resolve(); } });
  const run = handle.prompt('initial'); await started.promise;
  await handle.steer('change direction'); await handle.followUp('then report');
  assert.deepEqual(handle.snapshot().queue.steering.map(item => item.text), ['change direction']); assert.deepEqual(handle.snapshot().queue.followUp.map(item => item.text), ['then report']);
  await assert.rejects(handle.prompt('concurrent'), /busy/);
  gate.resolve(); await run;
  assert.equal(f.requests.length, 3);
  const users = events.filter(event => event.type === 'message_start' && event.message.role === 'user' && !event.message.contextKey).map(event => textOf(event.message));
  assert.deepEqual(users, ['initial', 'change direction', 'then report']); assert.equal(events.at(-1).type, 'agent_settled'); assert.equal(handle.snapshot().idle, true);
});

test('Rna abort cancels the actual provider stream and preserves an aborted transcript', { timeout: 20000 }, async t => {
  const started = deferred(), disconnected = deferred();
  const f = await fixture(t, async (_req, res) => { res.on('close', disconnected.resolve); res.writeHead(200, { 'content-type': 'text/event-stream' }); chunk(res, { choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' }, finish_reason: null }] }); });
  const handle = await f.create({ onEvent: event => { if (event.type === 'message_update') started.resolve(); } });
  const run = handle.prompt('long task'); await started.promise; await handle.abort(); await run; await disconnected.promise;
  const snapshot = handle.snapshot(); assert.equal(snapshot.idle, true); assert.equal(snapshot.messages.at(-1).stopReason, 'aborted');
  assert.ok((await readFile(snapshot.sessionFile, 'utf8')).includes('aborted'));
});

test('Provider errors are redacted before Rna JSONL and host events, without fallback simulation', { timeout: 20000 }, async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad credential fixture-private-token', type: 'invalid_request_error' } })); });
  const events = []; const handle = await f.create({ onEvent: event => events.push(event) }); await assert.rejects(handle.prompt('fail'), { code: 'http_error' });
  const snapshot = handle.snapshot(); assert.equal(snapshot.messages.at(-1).stopReason, 'error');
  const serialized = JSON.stringify({ snapshot, events }) + await readFile(snapshot.sessionFile, 'utf8');
  assert.ok(!serialized.includes(f.options.apiKey)); assert.equal(f.requests.length, 1);
});

test('Read tools deny traversal, symlink escape, private state and binary files, and read large text by line range', async t => {
  const f = await fixture(t);
  await writeFile(join(f.dir, 'outside.txt'), 'private'); await symlink(join(f.dir, 'outside.txt'), join(f.cwd, 'escape.txt'));
  await writeFile(join(f.cwd, '.env'), 'PRIVATE'); await writeFile(join(f.cwd, 'binary'), Buffer.from([0, 1])); await writeFile(join(f.cwd, 'large'), 'a'.repeat(100));
  await mkdir(join(f.cwd, 'state')); await writeFile(join(f.cwd, 'state', 'session.json'), 'hidden');
  const [read, list] = await createProjectReadTools(f.cwd, { deniedPaths: [join(f.cwd, 'state')], maxFileBytes: 64 });
  for (const path of ['../outside.txt', 'escape.txt', '.env', 'state/session.json', 'binary']) await assert.rejects(read.execute('test', { path }));
  assert.match((await read.execute('large', { path: 'large' })).content[0].text, /^1\ta{100}$/m, 'text above the edit size limit is still readable');
  const listing = await list.execute('list', {}); assert.ok(!listing.content[0].text.includes('.env')); assert.ok(!listing.content[0].text.includes('escape')); assert.ok(!listing.content[0].text.includes('state/'));
  assert.ok((await read.execute('read', { path: 'README.md', limit: 1 })).content[0].text.includes('project fixture'));
});

test('Unauthenticated local providers work without ambient credentials, and restore paths stay scoped', { timeout: 20000 }, async t => {
  const f = await fixture(t); const handle = await f.create({ apiKey: undefined }); await handle.prompt('local');
  assert.ok(!f.requests[0].headers.authorization); assert.equal(handle.snapshot().messages.at(-1).stopReason, 'stop');
  const outside = join(f.dir, 'outside.jsonl'); await writeFile(outside, '{}');
  await assert.rejects(f.create({ sessionFile: outside }), /within stateDir/);
});

test('Anthropic uses native Rna SSE parsing, output limit and provider cache counters', { timeout: 20000 }, async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 10, cache_creation_input_tokens: 3 } } });
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }); send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'anthropic fixture' } }); send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } }); send('message_stop', {}); res.end();
  });
  const handle = await f.create({ model: { ...f.options.model, protocol: 'anthropic' } }); await handle.prompt('anthropic');
  assert.equal(f.requests[0].url.split('?')[0], '/v1/messages'); assert.equal(f.requests[0].headers['x-api-key'], f.options.apiKey); assert.equal(f.requests[0].body.max_tokens, 127);
  const snapshot = handle.snapshot(); assert.equal(textOf(snapshot.messages.at(-1)), 'anthropic fixture'); assert.deepEqual(snapshot.usage, { input: 12, output: 7, cacheRead: 10, cacheWrite: 3, totalTokens: 32, costStatus: 'unpriced' });
});

test('Declared max reasoning reaches Rna provider payload without silent clamping', { timeout: 20000 }, async t => {
  const f = await fixture(t); const handle = await f.create({ model: { ...f.options.model, reasoning: 'max' } }); await handle.prompt('reason');
  assert.equal(f.requests[0].body.reasoning_effort, 'max'); assert.equal(f.requests[0].body.max_completion_tokens, 127);
});

test('Rna clearQueue cancels submitted steering and follow-up before consumption', { timeout: 20000 }, async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); chunk(res, { choices: [{ index: 0, delta: { role: 'assistant', content: 'working' }, finish_reason: null }] });
    await gate.promise; chunk(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }); res.end('data: [DONE]\n\n');
  });
  const handle = await f.create({ onEvent: event => { if (event.type === 'message_update') started.resolve(); } });
  const run = handle.prompt('initial'); await started.promise; await handle.steer('withdraw me'); await handle.followUp('also withdraw');
  const cleared = handle.clearQueue(); assert.deepEqual(cleared.steering.map(item => item.text), ['withdraw me']); assert.deepEqual(cleared.followUp.map(item => item.text), ['also withdraw']);
  gate.resolve(); await run; assert.equal(f.requests.length, 1); assert.deepEqual(handle.snapshot().queue, { steering: [], followUp: [] });
});

test('Runtime reads scoped project instructions as context without executing workspace extensions', { timeout: 20000 }, async t => {
  const f = await fixture(t); await mkdir(join(f.cwd, '.pi', 'extensions'), { recursive: true });
  const sentinel = join(f.cwd, 'extension-ran');
  await writeFile(join(f.cwd, '.pi', 'extensions', 'untrusted.mjs'), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(sentinel)},'executed');export default function() {}`);
  await writeFile(join(f.cwd, 'AGENTS.md'), 'PROJECT-CONVENTION: use the existing design system.');
  const handle = await f.create(); await handle.prompt('hello');
  await assert.rejects(access(sentinel));
  // The root AGENTS.md / CLAUDE.md is the project's own instruction file (shared with other agents, after pi):
  // it is a labelled project_instructions block of the system prompt, and it is not repeated in the orientation.
  assert.match(f.requests[0].body.messages[0].content, /<project_instructions path="AGENTS.md">\nPROJECT-CONVENTION: use the existing design system.\n<\/project_instructions>/);
  assert.equal(JSON.stringify(f.requests[0].body).split('PROJECT-CONVENTION').length, 2, 'the instruction file is sent once');
  assert.deepEqual(handle.snapshot().tools, ['project_read', 'project_list', 'project_find', 'project_grep', 'skill_load', 'tool_output_read']);
});

test('A configured output cap leaving no prompt space is rejected before network execution', { timeout: 20000 }, async t => {
  const f = await fixture(t); const handle = await f.create({ model: { ...f.options.model, contextWindow: 4096, maxOutputTokens: 4096 } });
  await assert.rejects(handle.prompt('bounded'), { code: 'context_limit' }); assert.equal(f.requests.length, 0);
});

test('Short local credentials do not corrupt Rna protocol event discriminators', { timeout: 20000 }, async t => {
  const f = await fixture(t); const handle = await f.create({ apiKey: 'a' }); await handle.prompt('hello');
  assert.equal(f.requests[0].headers.authorization, 'Bearer a'); assert.equal(handle.snapshot().messages.at(-1).role, 'assistant'); assert.equal(handle.snapshot().messages.at(-1).stopReason, 'stop');
  await access(handle.snapshot().sessionFile);
});

test('Ready project capability assignments restrict tools instead of silently granting the registry', async t => {
  const f = await fixture(t);
  const handle = await f.create({ project: { name: 'Assigned project', description: 'Use only listing', initialization: { status: 'ready' }, assignments: { skillIds: [], toolIds: ['project_list'], mcpServerIds: [] } }, customTools: [{ name: 'unassigned_host_tool', description: 'Must not be available', permission: 'read', parameters: { type: 'object' }, execute: async () => 'forbidden' }] });
  await handle.prompt('list');
  assert.deepEqual(f.requests[0].body.tools.map(tool => tool.function.name), ['project_list', 'skill_load', 'tool_output_read']);
  assert.deepEqual(handle.snapshot().assignedCapabilities.toolIds, ['project_list']);
  assert.ok(JSON.stringify(f.requests[0].body.messages.slice(1)).includes('Assigned project'));
  assert.ok(!f.requests[0].body.messages[0].content.includes('Assigned project'));
});

test('changing project focus refreshes durable working context without changing the stable prefix or tool declarations', async t => {
  const f = await fixture(t), project = { name: 'Practice', focus: 'Initial investigation', assignments: { skillIds: [], toolIds: ['project_read', 'project_list'], mcpServerIds: [] } };
  const handle = await f.create({ project, getProject: () => project });
  await handle.prompt('Understand the project'); const first = handle.snapshot();
  project.focus = 'Verify the delivered artifact';
  await handle.prompt('Continue'); const second = handle.snapshot();
  assert.equal(first.cache.prefixHash, second.cache.prefixHash);
  assert.equal(f.requests[0].body.messages[0].content, f.requests[1].body.messages[0].content);
  assert.deepEqual(f.requests[0].body.tools, f.requests[1].body.tools);
  const changes = second.messages.filter(message => message.contextKey === 'project-working-state');
  assert.equal(changes.length, 2); assert.match(changes.at(-1).context[0].text, /Verify the delivered artifact/);
});

test('host delivery observation resumes a premature answer after an actual write, then preserves read-back evidence', async t => {
  const f = await fixture(t, (request, res, n) => {
    if (n === 1) return toolCompletion(res, 'project_write', { path: 'delivery.txt', content: 'actual artifact', expectedHash: null });
    if (n === 2) return completion(res, 'Written.');
    if (n === 3) { assert.match(JSON.stringify(request.body.messages), /host-delivery-observation/); return toolCompletion(res, 'project_read', { path: 'delivery.txt' }); }
    return completion(res, 'Read back the actual artifact. No visual claim.');
  });
  const project = { name: 'Delivery', assignments: { skillIds: [], toolIds: ['project_read', 'project_list', 'project_write'], mcpServerIds: [] }, permissions: { workspace: 'write', background: 'read' } };
  const handle = await f.create({ project }); await handle.prompt('Create and inspect the delivery.');
  assert.equal(f.requests.length, 4); assert.equal(await readFile(join(f.cwd, 'delivery.txt'), 'utf8'), 'actual artifact');
  assert.equal(handle.snapshot().messages.filter(message => message.source === 'finish-feedback').length, 1);
  assert.equal(handle.snapshot().messages.filter(message => message.toolName === 'project_write').length, 1, 'the write is not replayed');
});

test('An unreachable assigned MCP service is left out of the turn (never replaced by fallback tools) and named to the model', async t => {
  const f = await fixture(t); let connected;
  const { CapabilityRegistry } = await import('../../../packages/sdk/src/index.mjs');
  const capabilityService = { async registry(_project, _tools, { connectIds }) { connected = connectIds; return { registry: new CapabilityRegistry({ tools: [] }), failures: [{ id: 'wanted-server', name: 'wanted' }] }; } };
  const handle = await f.create({ capabilityService, project: { assignments: { skillIds: [], toolIds: [], mcpServerIds: ['wanted-server'] } } });
  await handle.prompt('hello');
  assert.deepEqual(connected, ['wanted-server']);
  assert.deepEqual(handle.snapshot().assignedCapabilities.mcpServerIds, [], 'the unreachable service is not in this turn');
  assert.deepEqual(handle.snapshot().assignedCapabilities.toolIds, [], 'nothing is granted in its place');
  assert.match(JSON.stringify(f.requests.at(-1)), /unreachableServices[^\]]*wanted/);
});

test('Legacy projects never connect configured MCP servers implicitly', async t => {
  const f = await fixture(t); let connectIds;
  const capabilityService = { async registry(_project, memoryTools, options) {
    connectIds = options.connectIds;
    const { CapabilityRegistry } = await import('../../../packages/sdk/src/index.mjs');
    return { registry: new CapabilityRegistry({ tools: await createProjectReadTools(f.cwd, { deniedPaths: [f.stateDir] }) }), failures: [] };
  } };
  const handle = await f.create({ capabilityService, project: { name: 'Existing project' } }); await handle.prompt('hello');
  assert.deepEqual(connectIds, []); assert.deepEqual(handle.snapshot().assignedCapabilities.mcpServerIds, []);
});

test('expired MCP sessions reconnect at the next request boundary without replaying a failed call', async t => {
  const { CapabilityRegistry, mcpToolName } = await import('../../../packages/sdk/src/index.mjs');
  let modelRequests = 0, generations = 0, toolCalls = 0, deleted = 0;
  const mcp = createServer(async (req, res) => {
    if (req.method === 'DELETE') { deleted++; res.writeHead(204).end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk; const message = JSON.parse(raw);
    const send = result => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    if (message.method === 'initialize') { generations++; res.setHeader('mcp-session-id', `generation-${generations}`); send({ protocolVersion: '2025-03-26', capabilities: { tools: {} } }); }
    else if (!message.id) res.writeHead(202).end();
    else if (message.method === 'tools/list') send({ tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] });
    else if (message.method === 'tools/call') { toolCalls++; if (toolCalls === 1) res.writeHead(404).end(); else send({ content: [{ type: 'text', text: 'fresh session result' }] }); }
  }); await new Promise(resolve => mcp.listen(0, '127.0.0.1', resolve));
  const f = await fixture(t, (_request, res) => { if (++modelRequests < 3) toolCompletion(res, mcpToolName('fixture', 'echo'), {}); else completion(res, 'recovered'); });
  const service = {
    configuration: () => ({}),
    async registry() { const registry = new CapabilityRegistry({ mcpServers: [{ id: 'fixture', transport: 'http', url: `http://127.0.0.1:${mcp.address().port}/mcp`, enabled: true, trusted: true, allowTools: { echo: { permission: 'read', idempotent: true } } }] }); await registry.connectMcp('fixture'); return { registry, failures: [] }; }
  };
  const handle = await f.create({ project: { id: 'project', assignments: { skillIds: [], toolIds: ['mcp:fixture:echo'], mcpServerIds: ['fixture'] } }, capabilityService: service });
  try {
    await handle.prompt('Inspect the assigned service.');
    assert.equal(generations, 2); assert.equal(toolCalls, 2); assert.equal(modelRequests, 3);
    const results = handle.snapshot().messages.filter(message => message.role === 'toolResult'); assert.equal(results[0].isError, true); assert.equal(results[1].isError, false); assert.match(textOf(results[1]), /fresh session result/);
    await handle.dispose(); assert.equal(deleted, 2);
  } finally { await handle.dispose(); mcp.closeAllConnections(); await new Promise(resolve => mcp.close(resolve)); }
});

test('the background actions context leaves out revoked rows: they are the user\'s record of a previous scope (UX audit 25)', async t => {
  const f = await fixture(t);
  const project = { id: 'project', workspace: f.cwd, permissions: { workspace: 'read', background: 'read' }, assignments: { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] } };
  const getBackgroundState = () => ({ projectId: 'project', actions: [
    { id: 'live-action', status: 'running', content: 'Write chapter four', controlRevision: 1, availableControls: ['pause', 'stop', 'steer'] },
    { id: 'revoked-action', status: 'needs_review', revoked: true, label: '写第三章', content: '', controlRevision: 0, availableControls: [] }] });
  const handle = await f.create({ project, getBackgroundState });
  await handle.prompt('What is running in the background?');
  const sent = JSON.stringify(f.requests[0].body.messages);
  assert.match(sent, /live-action/); assert.doesNotMatch(sent, /revoked-action/);
});
