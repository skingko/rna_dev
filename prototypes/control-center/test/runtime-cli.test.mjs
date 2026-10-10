import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.mjs';

const exec = promisify(execFile), cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-runtime-cli-')), file = join(directory, 'state.json');
  const app = createServer({ stateFile: file, ticks: false, runtime: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.server.closeAllConnections(); await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const env = { ...process.env, RNA_AGENT_PORT: String(app.server.address().port), PI_FORGE_PORT: '1' };
  const invoke = (...args) => exec(process.execPath, [cli, ...args], { env, timeout: 15000 });
  const json = async (...args) => JSON.parse((await invoke(...args)).stdout);
  return { ...app, directory, file, invoke, json };
}
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await delay(10); } throw new Error('等待测试条件超时'); }
async function remote(t, handler) { const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })); return `http://127.0.0.1:${server.address().port}`; }
const reply = (res, result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', result })); };

test('CLI commands share real focus, plan, feedback, frequency, attachment and export APIs', async t => {
  const f = await fixture(t), { session, project } = f.store.createProject({ name: 'CLI commands', workspace: f.directory });
  assert.equal((await f.json('plan', session.id, 'plan')).result.mode, 'plan');
  await f.json('focus', session.id, '实现文件浏览'); await f.json('feedback', session.id, '保留中文文件名');
  assert.equal(f.store.state.projects.find(p => p.id === project.id).focus, '实现文件浏览');
  await f.json('frequency', project.id, 'quiet'); assert.equal(f.store.state.projects.find(p => p.id === project.id).evolution.minIntervalMs, 21600000);
  const path = join(f.directory, '说明.txt'); writeFileSync(path, '真实附件内容');
  const { attachment } = await f.json('attach', session.id, path);
  await f.json('send', session.id, '请读取附件', '--attachment', attachment.id);
  assert.equal(f.store.state.sessions.find(s => s.id === session.id).items.find(i => i.kind === 'user').attachments[0].id, attachment.id);
  const archive = join(f.directory, 'export.zip'); await f.json('export', session.id, archive);
  assert.equal(readFileSync(archive).readUInt32LE(), 0x04034b50);
  await assert.rejects(f.invoke('export', session.id, archive));
  writeFileSync(join(f.directory, 'index.html'), '<h1>Real preview</h1>');
  assert.ok((await f.json('files', project.id)).entries.some(row => row.name === 'index.html'));
  assert.equal((await f.json('file', project.id, 'index.html')).content, '<h1>Real preview</h1>');
  const preview = await f.json('preview', project.id, 'start', 'index.html');
  assert.equal(await (await fetch(preview.url)).text(), '<h1>Real preview</h1>');
  const base = `http://127.0.0.1:${f.server.address().port}`;
  const crossOrigin = await fetch(`${base}/api/state`, { headers: { Origin: preview.origin, 'Sec-Fetch-Site': 'same-site' } });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await fetch(`${base}/api/projects/${project.id}/file?path=state.json`)).status, 403);
  const download = await fetch(`${base}/api/projects/${project.id}/file/download?path=index.html`);
  assert.match(download.headers.get('content-disposition'), /^attachment;/); assert.equal(await download.text(), '<h1>Real preview</h1>');
  const inline = await fetch(`${base}/api/projects/${project.id}/file/raw?path=index.html`);
  assert.equal(inline.status, 200); assert.match(inline.headers.get('content-type'), /^text\/html/); assert.match(inline.headers.get('content-disposition'), /^inline;/); assert.match(inline.headers.get('content-security-policy'), /^sandbox;/); assert.equal(inline.headers.get('x-content-type-options'), 'nosniff'); assert.equal(await inline.text(), '<h1>Real preview</h1>');
  assert.equal((await fetch(`${base}/api/projects/${project.id}/file/raw?path=..%2Fstate.json`)).status, 403);
  assert.equal((await fetch(`${base}/api/projects/${project.id}/file/raw?path=index.html`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  // The workbench page (and its frame policy) exists once the web UI is built; an unbuilt tree serves a notice instead.
  if (existsSync(new URL('../web/dist/index.html', import.meta.url))) assert.match((await fetch(base)).headers.get('content-security-policy'), /frame-src http:\/\/127\.0\.0\.1:\*/);
  assert.equal((await f.json('preview', project.id, 'stop')).status, 'stopped');
  await assert.rejects(fetch(preview.url));
});

test('CLI run通过SSE等待自己的排队轮次并输出JSONL，不把上一轮完成当成本轮成功', async t => {
  const { store, server, invoke } = await fixture(t), { session } = store.createProject({}); const requests = [];
  server.on('request', request => requests.push(request.url)); store.message(session.id, { text: '上一轮', delivery: 'send' });
  const running = invoke('run', session.id, '属于本次CLI的后续消息', '--jsonl', '--timeout', '5');
  await until(() => store.state.sessions[0].inbox.length === 1);
  for (let i = 0; i < 10; i++) store.tick();
  const lines = (await running).stdout.trim().split('\n').map(JSON.parse), result = lines.at(-1);
  assert.equal(result.type, 'result'); assert.equal(result.status, 'completed'); assert.equal(result.turnId, store.state.sessions[0].turns[1].id);
  assert.equal(lines[0].queued, true); assert.ok(lines.some(row => row.type === 'state'));
  // B9: the v2 stream and one tail window, never the legacy whole-session stream or GET.
  assert.equal(requests.filter(path => path.startsWith('/api/v2/stream?session=')).length, 1); assert.equal(requests.filter(path => /^\/api\/v2\/sessions\/[\w-]+\?window=tail$/.test(path)).length, 1);
  assert.equal(requests.filter(path => path.startsWith('/api/stream')).length, 0); assert.equal(requests.filter(path => /^\/api\/sessions\/[\w-]+$/.test(path)).length, 0);
  const state = lines.find(row => row.type === 'state'); assert.equal(state.session.id, session.id); assert.ok(Array.isArray(state.session.items) && Array.isArray(state.session.turns));
  // The old whole-state stream's lines carried the maintenance gate: these still do (from the v2 `hello`).
  assert.deepEqual(Object.keys(state), ['type', 'revision', 'maintenance', 'session']); assert.deepEqual(state.maintenance, { protocolVersion: 1, held: false, operationId: null, phase: null, errorCode: null });
});

test('CLI run失败返回非零，超时保留daemon轮次且可以重新watch', async t => {
  const { store, invoke } = await fixture(t), { session } = store.createProject({});
  const failing = invoke('run', session.id, '故障用例', '--jsonl', '--timeout', '5');
  await until(() => store.state.sessions[0].activeTurnId);
  store.mutate(state => { const session = state.sessions[0]; session.turns[0].status = 'failed'; session.status = 'idle'; session.activeTurnId = null; });
  await assert.rejects(failing, error => error.code === 1 && /failed/.test(error.stderr) && /"status":"failed"/.test(error.stdout));
  await assert.rejects(invoke('run', session.id, '保留进度用例', '--timeout', '0.1'), error => error.code === 1 && /等待超时/.test(error.stderr));
  assert.equal(store.state.sessions[0].status, 'running');
  const watching = invoke('watch', session.id, '--jsonl'); let observed = ''; watching.child.stdout.on('data', chunk => observed += chunk);
  await until(() => observed.includes('"type":"state"')); watching.child.kill('SIGINT'); await watching;
  assert.equal(store.state.sessions[0].status, 'running');
});

test('CLI provider文件配置脱敏、RNA_AGENT_PORT优先、workspace路径真实有效', async t => {
  const { json, invoke, directory, file } = await fixture(t); const providerFile = join(directory, 'provider.json');
  writeFileSync(providerFile, JSON.stringify({ name: 'CLI 提供商', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'not-in-cli-output', models: [] }));
  const provider = await json('provider-add', '--file', providerFile); assert.equal(provider.apiKeyConfigured, true); assert.ok(!JSON.stringify(provider).includes('not-in-cli-output')); assert.ok(!readFileSync(file, 'utf8').includes('not-in-cli-output'));
  const { project } = await json('project-new', '工作目录', '--workspace', directory); assert.equal(project.workspace, realpathSync(directory));
  const session = await json('new', '独立会话', '--workspace', directory); assert.equal(session.workspace, realpathSync(directory));
  await assert.rejects(invoke('new', '--workspace', join(directory, 'missing')), error => error.code === 1);
  await assert.rejects(invoke('provider-add', '--api-key', 'should-reject'), error => error.code === 1 && !error.stderr.includes('should-reject'));
});

test('CLI OpenViking配置、health、initialize、browse、read、write都请求同一真实HTTP适配层，doctor报告离线', async t => {
  const { store, json, invoke, directory } = await fixture(t), { project } = store.createProject({}), ns = `viking://resources/projects/${project.id}`, calls = [];
  const endpoint = await remote(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; calls.push({ path: req.url, body: raw ? JSON.parse(raw) : null });
    if (req.url === '/health') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ status: 'ok', healthy: true, version: 'fixture' })); }
    if (req.url === '/api/v1/system/status') return reply(res, { initialized: true });
    if (req.url.startsWith('/api/v1/fs/ls')) return reply(res, [{ uri: `${ns}/note.md`, name: 'note.md', isDir: false }]);
    if (req.url.startsWith('/api/v1/content/read')) return reply(res, 'OpenViking 记忆正文');
    if (req.url === '/api/v1/search/find') return reply(res, { resources: [{ uri: `${ns}/note.md`, abstract: '项目记录' }] });
    return reply(res, { semantic_status: 'pending' });
  });
  const configured = await json('memory-config', '--endpoint', endpoint, '--auto-recall', 'true', '--auto-store', 'false', '--context-budget', '3072');
  assert.equal(configured.autoStore, false); assert.equal(configured.backend, 'openviking'); assert.equal(configured.autoRecall, true); assert.equal(configured.contextBudget, 3072); assert.equal(configured.defaultLevel, undefined);
  assert.equal((await json('memory-config')).contextBudget, 3072);
  await assert.rejects(invoke('memory-config', '--level', 'L1'), error => error.code === 1);
  assert.equal((await json('memory', project.id, 'health')).connected, true); assert.equal((await json('memory', project.id, 'initialize')).initialized, true);
  assert.equal((await json('memory', project.id, 'browse')).entries[0].uri, `${ns}/note.md`);
  assert.equal((await json('memory', project.id, 'read', `${ns}/note.md`)).content, 'OpenViking 记忆正文');
  const contentFile = join(directory, 'note.md'); writeFileSync(contentFile, '需要保存到 OpenViking 的项目约定');
  const written = await json('memory', project.id, 'write', '--file', contentFile, '--title', '发布约定'); assert.equal(written.accepted, true);
  assert.match(calls.find(c => c.path === '/api/v1/content/write').body.content, /需要保存到 OpenViking/);
  assert.equal((await json('doctor', project.id)).memory.health.connected, true);
  await json('memory-config', '--endpoint', 'http://127.0.0.1:1'); await assert.rejects(invoke('doctor', project.id), error => error.code === 1 && /"connected": false/.test(error.stdout) && /不会回退/.test(error.stdout));
});
