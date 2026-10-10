import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../store.mjs';

async function fixture(t, behavior = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-memory-onboarding-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [], directories = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'); let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null; calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body, key: req.headers['x-api-key'] });
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (behavior.wrongEndpoint) return send({ error: 'not found' }, 404);
    if (url.pathname === '/health') return send({ status: 'ok', healthy: true });
    if (url.pathname === '/api/v1/system/status') return behavior.authFailure ? send({}, 401) : send({ status: 'ok', result: { initialized: true } });
    if (url.pathname === '/api/v1/fs/mkdir') {
      if (behavior.mkdirFailure) return send({}, behavior.mkdirFailure);
      if (directories.has(body.uri)) return send({}, 409);
      directories.add(body.uri); return send({ status: 'ok', result: { uri: body.uri } });
    }
    if (url.pathname === '/api/v1/fs/ls') {
      const uri = url.searchParams.get('uri');
      if (!directories.has(uri) || behavior.inconsistentDirectory) return send({}, 404);
      return send({ status: 'ok', result: behavior.rows ?? [] });
    }
    return send({}, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const store = new Store(join(dir, 'state.json'));
  store.configurationService.update({ memory: { endpoint: `http://127.0.0.1:${server.address().port}`, apiKey: 'isolated-memory-key' } });
  const { project } = store.createProject({ name: '首次记忆', description: '只准备项目空间' });
  const namespace = `viking://resources/projects/${project.id}`;
  return { store, project, namespace, calls, directories };
}

test('首次浏览自动鉴权并创建当前项目空间，返回空库；重复浏览不写入', async t => {
  const f = await fixture(t); const result = await f.store.memoryService.browse(f.project.id);
  assert.equal(result.total, 0); assert.equal(result.namespace, f.namespace);
  assert.deepEqual(f.calls.map(c => c.path), ['/api/v1/fs/ls', '/health', '/api/v1/system/status', '/ready', '/api/v1/fs/mkdir', '/api/v1/fs/ls']);
  assert.deepEqual(f.calls.find(c => c.path.endsWith('/mkdir')).body, { uri: f.namespace, description: '只准备项目空间' });
  assert.ok(f.calls.every(c => c.key === 'isolated-memory-key'));
  await f.store.memoryService.browse(f.project.id); assert.equal(f.calls.filter(c => c.path.endsWith('/mkdir')).length, 1);
  assert.ok(!f.calls.some(c => /content\/write|sessions/.test(c.path)));
});

test('已有空间的目录列表保留过滤与当前项目范围限制', async t => {
  const f = await fixture(t); f.directories.add(f.namespace);
  await assert.rejects(f.store.memoryService.browse(f.project.id, { uri: f.namespace + '-other' }), e => e.status === 403);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.store.memoryService.browse(f.project.id)).total, 0);
  assert.deepEqual(f.calls.map(c => c.path), ['/api/v1/fs/ls']);
});

test('缺失子目录不触发初始化，也不伪装为空库', async t => {
  const f = await fixture(t); f.directories.add(f.namespace);
  await assert.rejects(f.store.memoryService.browse(f.project.id, { uri: f.namespace + '/missing' }), e => e.upstreamStatus === 404);
  assert.deepEqual(f.calls.map(c => c.path), ['/api/v1/fs/ls']);
});

for (const [name, behavior, code] of [['错误服务地址', { wrongEndpoint: true }, 404], ['无效租户凭据', { authFailure: true }, 401], ['服务不支持创建目录', { mkdirFailure: 404 }, 404]]) {
  test(`${name}不会当作空项目，也不会越过鉴权写入`, async t => {
    const f = await fixture(t, behavior);
    await assert.rejects(f.store.memoryService.browse(f.project.id), e => e.status === 503 && e.upstreamStatus === code);
    assert.equal(f.directories.size, 0);
    if (!behavior.mkdirFailure) assert.ok(!f.calls.some(c => c.path.endsWith('/mkdir')));
  });
}

test('并发首次浏览接受幂等创建冲突，不重复创建其他项目空间', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.store.memoryService.browse(f.project.id), f.store.memoryService.browse(f.project.id)]);
  assert.ok(results.every(r => r.total === 0)); assert.deepEqual([...f.directories], [f.namespace]);
  assert.ok(f.calls.filter(c => c.path.endsWith('/mkdir')).every(c => c.body.uri === f.namespace));
});

test('创建冲突后仍缺失的目录报错，不无限初始化或返回假空库', async t => {
  const f = await fixture(t, { inconsistentDirectory: true }); f.directories.add(f.namespace);
  await assert.rejects(f.store.memoryService.browse(f.project.id), e => e.upstreamStatus === 404);
  assert.equal(f.calls.filter(c => c.path.endsWith('/mkdir')).length, 1);
});
