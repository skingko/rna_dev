import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile), cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));

test('CLI version list/detail is read-only and machine JSON retains complete evaluation records', async t => {
  const version = { id: 'v-test', title: 'Verified task evolution', state: 'failed', simulated: false, error: { code: 'environment_unavailable' }, assessment: { label: '评估未完成', summary: 'No quality score assigned.' }, evaluationEvidence: { phaseLedger: { schemaVersion: 1, requestCount: 2, usage: { totalTokens: 300 }, phases: [{ phase: 'author', status: 'passed', requests: 2, usage: { totalTokens: 300 } }] } } };
  const project = { id: 'p-test', name: 'Task project', activeVersionId: 'base', trialVersionId: null, versions: [version] }, calls = [];
  // The interface-language probe (GET /api/health) is not a command request: `calls` is what the command itself sent.
  const server = createServer(async (request, response) => { if (request.url !== '/api/health') calls.push({ method: request.method, path: request.url }); response.setHeader('Content-Type', 'application/json'); if (request.url === '/api/projects') response.end(JSON.stringify([project])); else if (request.url === '/api/projects/p-test/versions/v-test/control') { let body = ''; for await (const part of request) body += part; response.end(JSON.stringify({ received: JSON.parse(body) })); } else { response.statusCode = 404; response.end('{"error":"not found"}'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const run = (...args) => exec(process.execPath, [cli, ...args], { env: { ...process.env, RNA_AGENT_PORT: String(server.address().port) }, timeout: 10000 });
  const list = await run('versions', project.id); assert.match(list.stdout, /v-test.*评估未完成/); assert.doesNotMatch(list.stdout, /phaseLedger|"versions"/);
  assert.deepEqual(JSON.parse((await run('versions', project.id, '--json')).stdout).versions, [version]);
  const detail = await run('version', project.id, version.id); assert.match(detail.stdout, /候选生成.*通过.*请求 2.*300/); assert.match(detail.stdout, /尚无完整质量结论/);
  assert.deepEqual(JSON.parse((await run('version', project.id, version.id, '--json')).stdout), version); assert.ok(calls.every(row => row.method === 'GET'));
  assert.deepEqual(JSON.parse((await run('version', project.id, version.id, 'trial')).stdout), { received: { action: 'trial' } }); assert.equal(calls.at(-1).method, 'POST');
  const before = calls.length; await assert.rejects(run('versions', project.id, '--unknown'), error => error.code === 1); await assert.rejects(run('version', project.id, version.id, 'erase'), error => error.code === 1); assert.equal(calls.length, before);
});

test('machine JSON escapes C1 terminal controls without changing parsed data', async t => {
  const data = [{ id: 'p', name: 'Project', versions: [{ id: 'v', title: 'value\u009b2J' }] }];
  const server = createServer((_, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(data)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const { stdout } = await exec(process.execPath, [cli, 'versions', 'p', '--json'], { env: { ...process.env, RNA_AGENT_PORT: String(server.address().port) }, timeout: 10000 });
  assert.equal(stdout.includes('\u009b'), false); assert.deepEqual(JSON.parse(stdout), { projectId: 'p', versions: data[0].versions });
});
