import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { McpClient } from '../src/mcp.mjs';
import { CapabilityRegistry } from '../src/capabilities.mjs';
const fixture = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
const config = { id: 'fixture', transport: 'stdio', command: process.execPath, args: [fixture], enabled: true, trusted: true, timeoutMs: 2000 };
test('stdio initializes, discovers, calls, cancels and closes an actual child process', async () => {
  const client = new McpClient(config);
  try {
    await client.connect(); assert.equal(client.ready, true); assert.equal((await client.listTools()).length, 2);
    assert.equal((await client.callTool('echo', { text: 'hello' })).content[0].text, 'initialized:hello');
    const controller = new AbortController(); const pending = client.request('hang', {}, { signal: controller.signal }); controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(client.request('hang', {}, { timeoutMs: 30 }), { code: 'timeout' });
  } finally { await client.close(); }
  assert.equal(client.closed, true); assert.equal(client.pending.size, 0); await assert.rejects(client.callTool('echo', {}));
});
test('registry discovery grants only explicit tools with configured effects', async () => {
  const registry = new CapabilityRegistry({ mcpServers: [{ ...config, allowTools: { echo: { permission: 'read', idempotent: true } } }] });
  try {
    await registry.connectMcp('fixture'); const catalog = await registry.catalog(); assert.equal(catalog.tools.length, 1); assert.equal(catalog.tools[0].id, 'mcp:fixture:echo'); assert.equal(catalog.tools[0].permission, 'read');
    await assert.rejects(registry.resolve({ toolIds: ['mcp:fixture:echo'] }), /require their server/);
    const { tools } = await registry.resolve({ toolIds: ['mcp:fixture:echo'], mcpServerIds: ['fixture'] });
    assert.equal((await tools[0].execute('call1', { text: 'test' })).content[0].text, 'initialized:test');
    await assert.rejects(tools[0].execute('call2', { text: 123 }), { code: 'invalid_arguments' });
    assert.equal(tools[0].effect, 'read'); assert.equal(tools[0].idempotent, true);
  } finally { await registry.close(); }
  assert.equal((await registry.catalog()).tools.length, 0);
});
test('streamable HTTP negotiates session, parses SSE, paginates, cancels and DELETE closes', async () => {
  const calls = []; let deleted = false; let pageCount = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'DELETE') { deleted = true; res.writeHead(204).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body); calls.push(message);
    assert.equal(req.headers.authorization, 'Bearer fixture-key');
    assert.match(req.headers.accept, /application\/json/); assert.match(req.headers.accept, /text\/event-stream/);
    if (message.method !== 'initialize') assert.equal(req.headers['mcp-session-id'], 'test-session');
    const send = result => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    if (message.method === 'initialize') { res.setHeader('Mcp-Session-Id', 'test-session'); send({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } }); }
    else if (!message.id) res.writeHead(202).end();
    else if (message.method === 'tools/list') { pageCount++; send({ tools: [{ name: message.params.cursor ? 'second' : 'first', inputSchema: { type: 'object' } }], ...(message.params.cursor ? {} : { nextCursor: 'page2' }) }); }
    else if (message.method === 'tools/call') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); const data = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '测试成功' }] } });
      res.write('event: message\r\n'); res.write(`data: ${data}\r\n\r\n`); // Intentionally leave stream open: matching response must finish the request.
      req.on('close', () => res.end());
    } else if (message.method === 'hang') { req.on('close', () => res.end()); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new McpClient({ id: 'http', enabled: true, trusted: true, transport: 'http', url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: 'Bearer fixture-key' }, timeoutMs: 2000 });
  try {
    await client.connect(); assert.deepEqual((await client.listTools()).map(tool => tool.name), ['first', 'second']); assert.equal(pageCount, 2);
    assert.equal((await client.callTool('first', {})).content[0].text, '测试成功');
    const controller = new AbortController(); const pending = client.request('hang', {}, { signal: controller.signal }); setTimeout(() => controller.abort(), 20); await assert.rejects(pending, { name: 'AbortError' });
    await new Promise(resolve => setTimeout(resolve, 40)); assert.ok(calls.some(message => message.method === 'notifications/cancelled'));
  } finally { await client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  assert.ok(deleted);
});
test('MCP refuses untrusted endpoints, unsupported transports and startup failures safely', async () => {
  assert.throws(() => new McpClient({ ...config, trusted: false }), { code: 'not_authorized' });
  assert.throws(() => new McpClient({ ...config, transport: 'http', url: 'http://example.com/mcp' }), { code: 'invalid_config' });
  assert.throws(() => new McpClient({ ...config, transport: 'http', url: 'https://user:secret@example.com/mcp' }), { code: 'invalid_config' });
  const missing = new McpClient({ ...config, command: '/nonexistent/rna-test-command' }); await assert.rejects(missing.connect(), { code: 'transport_closed' }); await missing.close();
});

test('registry disposal during initialization closes the pending child and never publishes late capabilities', async t => {
  const registry = new CapabilityRegistry({ mcpServers: [{ ...config, args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'] }] });
  t.after(() => registry.close());
  const connection = registry.connectMcp('fixture'), failure = assert.rejects(connection);
  // A host factory may acquire a session-owned client asynchronously. Observe
  // the actual spawned process, not a synchronous Map insertion assumption.
  // The fixture never replies to initialize, so readiness must remain false.
  const deadline = Date.now() + 1500;
  while (!registry.pendingClients.get('fixture')?.process?.pid && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  const client = registry.pendingClients.get('fixture'); assert.ok(client?.process?.pid); assert.equal(client.ready, false); const pid = client.process.pid;
  const first = registry.close(), second = registry.close(); assert.equal(first, second);
  await Promise.all([failure, first]); assert.equal(registry.clients.size, 0); assert.equal(registry.pendingClients.size, 0); assert.equal((await registry.catalog()).tools.length, 0);
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  await assert.rejects(registry.connectMcp('fixture'), { code: 'registry_closed' });
});

test('concurrent MCP close issues one HTTP DELETE and refuses requests while teardown runs', async () => {
  let deletions = 0; const server = createServer(async (req, res) => {
    if (req.method === 'DELETE') { deletions++; setTimeout(() => res.writeHead(204).end(), 30); return; }
    let raw = ''; for await (const chunk of req) raw += chunk; const message = JSON.parse(raw);
    if (message.method === 'initialize') { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: {} } })); }
    else res.writeHead(202).end();
  }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new McpClient({ ...config, transport: 'http', url: `http://127.0.0.1:${server.address().port}/mcp` });
  try { await client.connect(); const closing = client.close(); assert.equal(closing, client.close()); await assert.rejects(client.request('tools/list'), { code: 'transport_closed' }); await closing; assert.equal(deletions, 1); }
  finally { await client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('MCP teardown kills descendants in its owned process group, including a child ignoring SIGTERM', { skip: process.platform === 'win32' }, async () => {
  const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'],{stdio:'ignore'}); let data=''; process.stdin.on('data',chunk=>{data+=chunk; let end; while((end=data.indexOf('\\n'))>=0){const m=JSON.parse(data.slice(0,end));data=data.slice(end+1);if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:'tree',version:String(child.pid)}}})+'\\n');}});`;
  const client = new McpClient({ ...config, args: ['-e', script] }); await client.connect(); const childPid = Number(client.serverInfo.version); assert.ok(childPid > 0);
  await client.close();
  const deadline = Date.now() + 2000; let gone = false;
  while (Date.now() < deadline) { try { process.kill(childPid, 0); } catch (error) { if (error.code === 'ESRCH') { gone = true; break; } } await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(gone, 'owned descendant must exit after registry teardown');
});

test('stdio guardian preserves exit status and drains output under pipe backpressure', async () => {
  const { spawn } = await import('node:child_process');
  const guardian = fileURLToPath(new URL('../src/mcp-stdio-supervisor.mjs', import.meta.url));
  const child = spawn(process.execPath, [guardian, String(process.pid), process.execPath, '-e', 'process.stdout.write("x".repeat(524288),()=>{process.exitCode=23})'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const chunks = []; child.stderr.resume(); await new Promise(resolve => setTimeout(resolve, 30)); child.stdout.on('data', data => chunks.push(data));
  const result = await exited; assert.equal(result.code, 23); assert.equal(result.signal, null); assert.equal(Buffer.concat(chunks).length, 524288);
});

test('SIGKILL of the SDK host still reaps its stdio MCP server and grandchild without touching unrelated processes', { skip: process.platform === 'win32' }, async t => {
  const { spawn } = await import('node:child_process');
  const moduleUrl = new URL('../src/mcp.mjs', import.meta.url).href;
  const serverScript = `const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>{}); const grand=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000);let data='';process.stdin.on('data',chunk=>{data+=chunk;let end;while((end=data.indexOf('\\n'))>=0){const m=JSON.parse(data.slice(0,end));data=data.slice(end+1);if(m.method==='initialize')setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:String(process.pid),version:String(grand.pid)}}})+'\\n'),100);}});`;
  const hostScript = `import {McpClient} from ${JSON.stringify(moduleUrl)};const client=new McpClient({id:'orphan',transport:'stdio',command:process.execPath,args:['-e',${JSON.stringify(serverScript)}],enabled:true,trusted:true});await client.connect();console.log(JSON.stringify({wrapper:client.process.pid,server:Number(client.serverInfo.name),grand:Number(client.serverInfo.version)}));setInterval(()=>{},1000);`;
  const host = spawn(process.execPath, ['--input-type=module', '-e', hostScript], { stdio: ['ignore', 'pipe', 'pipe'] });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  let pids;
  t.after(() => { for (const pid of [host.pid, unrelated.pid, ...Object.values(pids ?? {})]) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  host.stderr.resume();
  pids = await new Promise((resolve, reject) => { let buffer = ''; const timer = setTimeout(() => reject(new Error('host did not initialize')), 5000); host.stdout.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(buffer.split('\n')[0])); } }); host.once('exit', () => { clearTimeout(timer); reject(new Error('host exited before init')); }); });
  const ended = new Promise(resolve => host.once('exit', resolve)); host.kill('SIGKILL'); await ended;
  const exists = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  const deadline = Date.now() + 5000;
  while (Object.values(pids).some(exists) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(Object.values(pids).every(pid => !exists(pid)), 'guardian, server and grandchild must all exit after host death');
  assert.equal(exists(unrelated.pid), true, 'unrelated processes remain untouched');
});
