import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.mjs';
import { memorySyncHealth } from '../memory-sync.mjs';
import { EnduranceMonitor, createEnduranceRun } from '../endurance-monitor.mjs';
import { atomicWrite } from '../durable-files.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-memory-health-'));
  const app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const { project, session } = app.store.createProject({ name: 'Memory health fixture' });
  let calls = 0;
  app.store.memoryService.healthRemote = async () => { calls++; return { ready: true, liveness: { status: 'alive' }, readiness: { status: 'ready', embedding: 'ready' } }; };
  app.store.mutate(state => { state.projects.find(p => p.id === project.id).simulated = false; });
  await app.checkMemory();
  const writes = values => app.store.mutate(state => { state.sessions.find(s => s.id === session.id).turns = values.map((value, index) => ({ id: `turn-${index}`, status: 'completed', modelConfig: { execution: 'rna' }, memoryWrite: value })); });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { app, directory, project, session, writes, calls: () => calls, health: async () => (await fetch(`http://127.0.0.1:${app.server.address().port}/api/health`)).json() };
}

test('未确认结果与重试中的记录使daemon降级，embedding ready不能掩盖VLM/commit的未决状态', async t => {
  const f = await fixture(t);
  for (const write of [
    { status: 'uncertain', code: 'MEMORY_WRITE_OUTCOME_UNKNOWN' },
    { status: 'uncertain', code: 'MEMORY_COMMIT_RECEIPT_INCOMPLETE' },
    { status: 'pending', code: 'MEMORY_CONNECTION_UNAVAILABLE', pollFailures: 1 },
    { status: 'polling', code: 'MEMORY_TASK_LOOKUP_FAILED', pollFailures: 1 }
  ]) {
    f.writes([{ ...write, message: 'PRIVATE RAW VLM ERROR', content: 'PRIVATE CONVERSATION', updatedAt: '2026-09-24T00:00:00Z' }]);
    const health = await f.health();
    assert.equal(health.ok, false); assert.equal(health.memorySyncDegraded, true);
    assert.equal(health.dependencies.memory.status, 'healthy'); assert.equal(health.dependencies.memory.sync.status, 'degraded');
    assert.equal(health.dependencies.memory.sync.issues[0].code, write.code); assert.equal(health.dependencies.memory.sync.unresolved, 1);
    assert.equal(health.dependencies.memory.vlm, 'not_verified');
    assert.ok(!JSON.stringify(health).includes('PRIVATE'));
  }
  assert.equal(f.calls(), 1, 'health projection never issues a model or extra dependency request');
});

test('已落定的损失（提炼失败、被拒绝、连接已变、任务过期）只列出、不降级，后来的成功也不会把它隐藏', async t => {
  const f = await fixture(t);
  for (const write of [
    { status: 'failed', code: 'MEMORY_WRITE_REJECTED', upstreamStatus: 401 },
    { status: 'failed', code: 'MEMORY_EXTRACTION_FAILED', taskId: 'task' },
    { status: 'failed', code: 'MEMORY_CONNECTION_CHANGED' },
    { status: 'failed', code: 'MEMORY_TASK_EXPIRED', taskId: 'task' },
    { status: 'abandoned', code: 'MEMORY_SOURCE_CHANGED' },
    { status: 'uncertain', code: 'MEMORY_SOURCE_CHANGED', nextMessage: 0 },
  ]) {
    f.writes([{ ...write, message: 'PRIVATE', updatedAt: '2026-10-01T19:46:46Z' }, { status: 'completed', memoriesExtracted: 2, updatedAt: '2026-10-04T00:00:00Z' }]);
    const health = await f.health(), sync = health.dependencies.memory.sync;
    assert.equal(health.ok, true, write.code); assert.equal(health.memorySyncDegraded, false); assert.equal(sync.status, 'healthy');
    assert.equal(sync.unresolved, 0); assert.equal(sync.issues.length, 0); assert.equal(sync.settledLoss, 1);
    assert.deepEqual([sync.settledLosses[0].turnId, sync.settledLosses[0].code], ['turn-0', write.code]);
    assert.ok(!JSON.stringify(health).includes('PRIVATE'));
  }
  // A stamp (an earlier click or the A2 migration) is bookkeeping: still history, still counted as a settled loss.
  f.app.store.mutate(state => { state.sessions.find(s => s.id === f.session.id).turns[0].memoryWrite.acknowledgedAt = '2026-10-04T01:00:00Z'; });
  const sync = (await f.health()).dependencies.memory.sync;
  assert.equal(sync.settledLoss, 1); assert.equal(sync.acknowledged, 1); assert.equal(sync.settledLosses[0].acknowledgedAt, '2026-10-04T01:00:00.000Z');
});

test('项目目录摘要同样分为未决与已落定：failed（如超过节点上限）只列出、不让 /api/health 失败；待核对与查询失败才降级（A2）', async t => {
  const f = await fixture(t);
  const summary = value => f.app.store.mutate(state => { state.projects.find(p => p.id === f.project.id).memorySummary = { schemaVersion: 1, id: 'summary', endpoint: 'http://127.0.0.1:1', updatedAt: '2026-10-04T00:00:00Z', message: 'PRIVATE', ...value }; });
  f.writes([{ status: 'completed', memoriesExtracted: 1 }]);
  for (const code of ['MEMORY_SUMMARY_TREE_LIMIT', 'MEMORY_SUMMARY_TASK_FAILED', 'MEMORY_SUMMARY_CONNECTION_CHANGED']) {
    summary({ status: 'failed', code });
    const health = await f.health(), summaries = health.dependencies.memory.sync.summaries;
    assert.equal(health.ok, true, code); assert.equal(health.memorySyncDegraded, false, code); assert.equal(summaries.healthy, true, code);
    assert.deepEqual(summaries.issues, []); assert.deepEqual(summaries.settled.map(row => [row.status, row.code]), [['failed', code]]);
    assert.ok(!JSON.stringify(health).includes('PRIVATE'));
    const status = await (await fetch(`http://127.0.0.1:${f.app.server.address().port}/api/v2/projects/${f.project.id}/memory-sync`)).json();
    assert.deepEqual([status.summary.status, status.summary.resolution, status.status], ['failed', 'settled', 'synced'], code);
  }
  for (const value of [{ status: 'uncertain', code: 'MEMORY_SUMMARY_OUTCOME_UNKNOWN' }, { status: 'uncertain', code: 'MEMORY_SUMMARY_TASK_EXPIRED' }, { status: 'polling', code: 'MEMORY_SUMMARY_LOOKUP_FAILED', pollFailures: 1 }]) {
    summary(value);
    const health = await f.health();
    assert.equal(health.ok, false, value.code); assert.equal(health.memorySyncDegraded, true, value.code);
    assert.equal(health.dependencies.memory.sync.summaries.issues[0].code, value.code);
  }
  for (const value of [{ status: 'polling' }, { status: 'pending' }, { status: 'completed' }]) { summary(value); assert.equal((await f.health()).ok, true, value.status); }
});

test('正常等待与零提取成功不降级，已完成记录的陈旧诊断不永久污染健康', async t => {
  const f = await fixture(t);
  f.writes([{ status: 'completed', memoriesExtracted: 0, pollFailures: 7, code: 'MEMORY_TASK_LOOKUP_FAILED', updatedAt: '2026-09-24T00:00:00Z' },
    ...['pending', 'ready', 'creating', 'uploading', 'committing', 'polling', 'skipped'].map(status => ({ status }))]);
  const health = await f.health(), sync = health.dependencies.memory.sync;
  assert.equal(health.ok, true); assert.equal(health.memorySyncDegraded, false); assert.equal(sync.status, 'healthy');
  assert.equal(sync.counts.completed, 1); assert.equal(sync.counts.retrying, 0); assert.equal(sync.counts.inFlight, 3); assert.equal(sync.issues.length, 0);
  const before = f.app.store.persistence.writes;
  for (let i = 0; i < 1000; i++) f.app.health();
  assert.equal(f.app.store.persistence.writes, before); assert.equal(f.calls(), 1);
});

test('后来新回合成功不遮蔽旧未决，只有对应记录真正完成才退出降级', async t => {
  const f = await fixture(t);
  f.writes([{ status: 'uncertain', code: 'MEMORY_WRITE_OUTCOME_UNKNOWN' }, { status: 'completed', memoriesExtracted: 3 }]);
  assert.equal((await f.health()).ok, false);
  f.app.store.mutate(state => { const write = state.sessions.find(s => s.id === f.session.id).turns[0].memoryWrite; write.status = 'completed'; write.memoriesExtracted = 0; });
  assert.equal((await f.health()).ok, true);
});

test('健康证据有界且只投影当前outbox，不引用累计错误或原始事件', () => {
  const rows = status => Array.from({ length: 100 }, (_, index) => ({ id: `t${index}`, memoryWrite: { status, code: index ? 'MEMORY_WRITE_OUTCOME_UNKNOWN' : 'secret: raw credentials', message: 'PRIVATE', sourceHash: 'PRIVATE', taskId: 'PRIVATE' } }));
  const state = { projects: [{ id: 'p' }], sessions: [{ id: 's', projectId: 'p', turns: rows('uncertain') }], events: [{ error: 'PRIVATE historical failure' }] };
  let health = memorySyncHealth(state);
  assert.equal(health.counts.uncertain, 100); assert.equal(health.unresolved, 100); assert.equal(health.issues.length, 20); assert.equal(health.omittedIssues, 80);
  assert.equal(health.issues[0].code, 'MEMORY_SYNC_FAILED'); assert.ok(!JSON.stringify(health).includes('PRIVATE')); assert.ok(!JSON.stringify(health).includes('credentials'));
  state.sessions[0].turns = rows('failed');
  health = memorySyncHealth(state);
  assert.equal(health.healthy, true); assert.equal(health.settledLoss, 100); assert.equal(health.settledLosses.length, 20); assert.equal(health.omittedSettledLosses, 80);
  assert.equal(health.settledLosses[0].code, 'MEMORY_SYNC_FAILED'); assert.ok(!JSON.stringify(health).includes('PRIVATE'));
  // History reads newest first, stamped or not (A2): a stamp changes no count but `acknowledged`.
  state.sessions[0].turns.slice(0, 50).forEach(turn => { turn.memoryWrite.acknowledgedAt = '2026-10-04T00:00:00Z'; });
  state.sessions[0].turns[70].memoryWrite.updatedAt = '2026-10-05T00:00:00Z';
  health = memorySyncHealth(state);
  assert.equal(health.settledLoss, 100); assert.equal(health.acknowledged, 50); assert.equal(health.omittedSettledLosses, 80);
  assert.equal(health.settledLosses[0].turnId, 't70'); assert.equal(health.settledLosses[1].turnId, 't0');
  state.sessions[0].turns = [{ id: 'resolved', memoryWrite: { status: 'completed', memoriesExtracted: 0 } }];
  assert.equal(memorySyncHealth(state).healthy, true);
});

test('endurance样本持久保留真实记忆未决证据，恢复后不会抹除失败观察；已落定的损失不让样本失败', async t => {
  const f = await fixture(t), now = Date.now();
  atomicWrite(join(f.directory, 'endurance.json'), JSON.stringify(createEnduranceRun({ id: 'memory-sync', now })));
  const monitor = new EnduranceMonitor(f.directory);
  monitor.sample(f.app.health(), { at: now });
  f.writes([{ status: 'uncertain', code: 'MEMORY_WRITE_OUTCOME_UNKNOWN' }]);
  let result = monitor.sample(f.app.health(), { at: now + 1000 });
  assert.equal(result.unhealthySamples, 1); assert.equal(result.lastSample.dependencies.memory.sync.issues[0].code, 'MEMORY_WRITE_OUTCOME_UNKNOWN');
  f.writes([{ status: 'completed', memoriesExtracted: 0 }]);
  result = monitor.sample(f.app.health(), { at: now + 2000 });
  assert.equal(result.unhealthySamples, 1); assert.equal(result.lastSample.healthy, true);
  f.writes([{ status: 'failed', code: 'MEMORY_EXTRACTION_FAILED', taskId: 'task' }]);
  result = monitor.sample(f.app.health(), { at: now + 3000 });
  assert.equal(result.unhealthySamples, 1); assert.equal(result.lastSample.healthy, true); assert.equal(result.lastSample.dependencies.memory.sync.settledLoss, 1);
  const samples = readFileSync(join(f.directory, 'endurance-samples.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(samples.length, 4); assert.equal(samples[1].healthy, false); assert.equal(samples[1].dependencies.memory.sync.counts.uncertain, 1);
});

test('an upgrade verifies a successor whose only problem is recorded memory-sync history', async () => {
  const { serviceReady } = await import('../application-maintenance-worker.mjs');
  const base = { ok: false, memorySyncDegraded: true, autonomyDegraded: false, persistence: { failed: false }, process: { closing: false }, scheduler: { lastTickError: null }, dependencies: { memory: { status: 'healthy' } } };
  assert.equal(serviceReady(base), true);
  for (const broken of [{ autonomyDegraded: true }, { persistence: { failed: true } }, { process: { closing: true } }, { scheduler: { lastTickError: 'x' } }, { dependencies: { memory: { status: 'unavailable' } } }, { memorySyncDegraded: false }]) assert.equal(serviceReady({ ...base, ...broken }), false);
});
