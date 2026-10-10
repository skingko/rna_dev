import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from '../durable-files.mjs';
import { createEnduranceRun, recordEnduranceSample, EnduranceMonitor, appendRotated } from '../endurance-monitor.mjs';
import { launchAgentPlist, systemdUnit, serviceOptions } from '../service-cli.mjs';

const origin = Date.parse('2026-09-24T00:00:00.000Z');
const sample = (seconds, overrides = {}) => ({ at: new Date(origin + seconds * 1000).toISOString(), healthy: true, instanceId: 'a', rssBytes: 100, stateBytes: 200, ...overrides });
test('100小时计时未完成不报通过；完整虚拟观察通过只验证记账', () => {
  let run = createEnduranceRun({ id: 'test', hours: 100, now: origin });
  for (let second = 0; second < 360000; second += 60) run = recordEnduranceSample(run, sample(second));
  assert.equal(run.status, 'running'); assert.equal(run.passed, null);
  run = recordEnduranceSample(run, sample(360000));
  assert.equal(run.status, 'completed'); assert.equal(run.passed, true); assert.equal(run.observedHealthySeconds, 360000);
});
test('休眠空档、进程重启、监控重启与时钟跳变均不能伪报连续健康', () => {
  for (const change of [ { seconds: 400000 }, { seconds: 60, instanceId: 'b' }, { seconds: 60, monitorRestarted: true }, { seconds: 60, monotonicDeltaSeconds: 1 } ]) {
    let run = recordEnduranceSample(createEnduranceRun({ id: 'test', hours: 0.01, now: origin }), sample(0));
    run = recordEnduranceSample(run, sample(change.seconds, change));
    assert.equal(run.status, 'completed'); assert.equal(run.passed, false); assert.equal(run.observedHealthySeconds, 0);
  }
});
test('A→不可达→B仍计一次重启，失败不被后来的健康样本覆盖', () => {
  let run = recordEnduranceSample(createEnduranceRun({ id: 'test', hours: 0.05, now: origin }), sample(0));
  run = recordEnduranceSample(run, sample(60, { healthy: false, instanceId: null }));
  run = recordEnduranceSample(run, sample(120, { instanceId: 'b' }));
  run = recordEnduranceSample(run, sample(180, { instanceId: 'b' }));
  assert.equal(run.daemonRestarts, 1); assert.equal(run.unhealthySamples, 1); assert.equal(run.passed, false);
});
test('actual managed generations count every replacement even when successive children never expose HTTP', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-spawn-monitor-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  atomicWrite(join(dir, 'endurance.json'), JSON.stringify(createEnduranceRun({ id: 'managed', now: origin })));
  let monitor = new EnduranceMonitor(dir);
  const identity = (generation, supervisorRunId = 'supervisor-1') => ({ generation, supervisorRunId, pid: null });
  const probe = (at, generation, health = null, supervisorRunId) => monitor.sample(health, { at: origin + at, issue: health ? null : 'daemon_starting', managedDaemon: identity(generation, supervisorRunId) });
  let run = probe(0, 'A'); assert.equal(run.daemonRestarts, 0, 'first observed daemon is not a restart');
  run = probe(1000, 'A', { ok: true, process: { instanceId: 'http-A' } }); assert.equal(run.daemonRestarts, 0);
  run = probe(2000, 'B'); assert.equal(run.daemonRestarts, 1); const samples = run.samples;
  run = probe(2100, 'B'); assert.equal(run.daemonRestarts, 1); assert.equal(run.samples, samples, 'same generation is deduplicated within sample interval');
  run = probe(3000, 'C'); assert.equal(run.daemonRestarts, 2, 'a second startup failure is recorded without a successful HTTP response');
  run = probe(4000, 'C', { ok: true, process: { instanceId: 'http-C' } }); assert.equal(run.daemonRestarts, 2, 'later HTTP identity does not double count');
  monitor = new EnduranceMonitor(dir);
  run = probe(5000, 'D', null, 'supervisor-2'); assert.equal(run.daemonRestarts, 3); assert.equal(run.lastSample.monitorRestarted, true);
  assert.equal(run.healthySamples, 2); assert.equal(run.unhealthySamples, 4); assert.equal(run.observedHealthySeconds, 0); assert.equal(run.passed, null);
  const records = readFileSync(monitor.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(row => row.managedDaemon.generation), ['A', 'A', 'B', 'C', 'C', 'D']);
});
test('依赖进程在采样间恢复仍留下重启证据，不算连续健康', () => {
  let run = recordEnduranceSample(createEnduranceRun({ id: 'helper-recovery', hours: 0.05, now: origin }), sample(0, { managedHelpers: [{ id: 'relay', generation: 'a', restarts: 0 }] }));
  run = recordEnduranceSample(run, sample(60, { healthy: false, managedHelpers: [{ id: 'relay', generation: null, restarts: 1 }] }));
  run = recordEnduranceSample(run, sample(120, { managedHelpers: [{ id: 'relay', generation: 'b', restarts: 1 }] }));
  run = recordEnduranceSample(run, sample(180, { managedHelpers: [{ id: 'relay', generation: 'b', restarts: 1 }] }));
  assert.equal(run.managedHelperRestarts, 1); assert.equal(run.passed, false);
  assert.equal(run.daemonRestarts, 0); assert.equal(run.observedHealthySeconds, 60);
  let reset = recordEnduranceSample(createEnduranceRun({ id: 'helper-counter-reset', now: origin }), sample(0, { managedHelpers: [{ id: 'relay', generation: 'a', restarts: 5 }] }));
  reset = recordEnduranceSample(reset, sample(60, { healthy: false, managedHelpers: [{ id: 'relay', generation: null, restarts: 0 }] }));
  reset = recordEnduranceSample(reset, sample(120, { managedHelpers: [{ id: 'relay', generation: 'b', restarts: 0 }] }));
  assert.equal(reset.managedHelperRestarts, 1, 'A to null to B survives a supervisor counter reset');
});
test('一分钟采样间的5秒故障立即留痕，不因下一分钟恢复而丢失', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-monitor-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  atomicWrite(join(dir, 'endurance.json'), JSON.stringify(createEnduranceRun({ id: 'test', now: origin })));
  const monitor = new EnduranceMonitor(dir), health = { ok: true, process: { instanceId: 'a', pid: 1 } };
  monitor.sample(health, { at: origin });
  monitor.sample(health, { at: origin + 1000 });
  assert.equal(JSON.parse(readFileSync(join(dir, 'endurance.json'))).samples, 1);
  monitor.sample(null, { at: origin + 5000 });
  const run = monitor.sample(health, { at: origin + 10000 });
  assert.equal(run.samples, 3); assert.equal(run.unhealthySamples, 1); assert.equal(run.observedUnavailableSeconds, 10);
});
test('learning failure and recovery preserve the cause in each durable sample without changing availability accounting', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-learning-monitor-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  atomicWrite(join(dir, 'endurance.json'), JSON.stringify(createEnduranceRun({ id: 'learning', now: origin })));
  const monitor = new EnduranceMonitor(dir), projectId = '251ded93-1e75-48f4-957c-e8e8592ea65a', reviewId = '6fa74b59-8cd1-406a-a2c8-b637c433da64';
  const health = { ok: true, autonomyDegraded: false, memorySyncDegraded: false, process: { instanceId: 'a', closing: false }, persistence: { failed: false },
    scheduler: { lastTickError: null, learning: { lastError: null, projects: [{ projectId, reviewId: null, inFlight: false, closed: false, unsettledOperations: 0, pending: 1, deferred: 0, awaitingEvidence: 0, queued: 0, interrupted: 0, retainedEpisodes: 1, seen: 1, nextReviewAt: origin, experimentNotBefore: origin, lastError: null, lastResult: null }] } } };
  monitor.sample(health, { at: origin });
  const failing = structuredClone(health); failing.ok = false; failing.autonomyDegraded = true;
  Object.assign(failing.scheduler.learning.projects[0], { reviewId, inFlight: true, lastError: 'invalid_learning_reflection' });
  const failed = monitor.sample(failing, { at: origin + 2000 });
  assert.equal(failed.lastSample.issue, 'daemon_degraded'); assert.equal(failed.lastSample.learning.projects[0].lastError, 'invalid_learning_reflection');
  assert.equal(failed.lastSample.learning.projects[0].reviewId, reviewId); assert.equal(failed.lastSample.learning.projects[0].inFlight, true);
  assert.deepEqual(failed.lastSample.diagnostics, { autonomyDegraded: true, memorySyncDegraded: false, closing: false, persistenceFailed: false, lastTickError: null });
  health.scheduler.learning.projects[0].lastResult = 'deferred';
  const recovered = monitor.sample(health, { at: origin + 4000 });
  assert.equal(recovered.samples, 3); assert.equal(recovered.unhealthySamples, 1); assert.equal(recovered.observedUnavailableSeconds, 4); assert.equal(recovered.passed, null);
  assert.equal(recovered.lastSample.learning.projects[0].lastError, null); assert.equal(recovered.lastSample.learning.projects[0].lastResult, 'deferred');
  const rows = readFileSync(monitor.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[1].learning.issueProjectCount, 1); assert.equal(rows[1].learning.projects[0].lastError, 'invalid_learning_reflection');
  assert.equal(rows[2].learning.issueProjectCount, 0); assert.deepEqual(JSON.parse(readFileSync(monitor.path)).lastSample, recovered.lastSample);
});
test('learning diagnostics are bounded metadata and never copy reflection, provider response or arbitrary health fields', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-learning-diagnostics-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  atomicWrite(join(dir, 'endurance.json'), JSON.stringify(createEnduranceRun({ id: 'bounded', now: origin })));
  const monitor = new EnduranceMonitor(dir), secret = 'PRIVATE transcript and Authorization: Bearer credential', projects = Array.from({ length: 70 }, (_, i) => ({ projectId: `${secret} ${i}`, rawReflection: secret, pending: -1, seen: Number.MAX_VALUE, lastError: null }));
  projects[69] = { ...projects[69], lastError: 'invalid_learning_reflection', persistenceError: { message: secret }, reviewId: secret, inFlight: secret, nextReviewAt: secret };
  const run = monitor.sample({ ok: false, scheduler: { lastTickError: secret, learning: { projects, lastError: { message: secret }, rawResponse: secret } } }, { at: origin });
  const diagnostics = run.lastSample.learning;
  assert.equal(diagnostics.projectCount, 70); assert.equal(diagnostics.projects.length, 64); assert.equal(diagnostics.omittedProjects, 6); assert.equal(diagnostics.issueProjectCount, 1);
  assert.equal(diagnostics.projects[0].lastError, 'invalid_learning_reflection', 'a late degraded project is not displaced by healthy entries');
  assert.equal(diagnostics.projects[0].persistenceError, 'diagnostic_redacted'); assert.equal(diagnostics.lastError, 'diagnostic_redacted');
  assert.equal(diagnostics.projects[0].nextReviewAt, null); assert.equal(diagnostics.projects[0].inFlight, null); assert.equal(diagnostics.projects[0].pending, null); assert.equal(diagnostics.projects[0].seen, null);
  assert.match(diagnostics.projects[0].projectId, /^sha256:[a-f0-9]{64}$/); assert.match(diagnostics.projects[0].reviewId, /^sha256:[a-f0-9]{64}$/);
  for (const file of [monitor.path, monitor.log]) { const content = readFileSync(file, 'utf8'); assert.equal(content.includes(secret), false); assert.doesNotMatch(content, /rawResponse|rawReflection|Authorization/); assert.ok(content.length < 60000); }
});
test('legacy health without learning remains compatible and diagnostic-only changes do not alter sample cadence', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-learning-legacy-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  atomicWrite(join(dir, 'endurance.json'), JSON.stringify(createEnduranceRun({ id: 'legacy', now: origin })));
  const monitor = new EnduranceMonitor(dir), health = { ok: true, process: { instanceId: 'a' } };
  const first = monitor.sample(health, { at: origin }); assert.equal(first.lastSample.learning, null);
  assert.deepEqual(first.lastSample.diagnostics, { autonomyDegraded: null, memorySyncDegraded: null, closing: null, persistenceFailed: null, lastTickError: null });
  health.scheduler = { learning: { projects: [], lastError: null } };
  const skipped = monitor.sample(health, { at: origin + 1000 }); assert.equal(skipped.samples, 1); assert.equal(skipped.lastSample.learning, null);
  assert.equal(readFileSync(monitor.log, 'utf8').trim().split('\n').length, 1);
});
test('memory breakdown retains only numeric bytes without changing health policy or sample cadence', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-memory-diagnostics-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  atomicWrite(join(dir, 'endurance.json'), JSON.stringify(createEnduranceRun({ id: 'memory', now: origin })));
  const monitor = new EnduranceMonitor(dir), health = { ok: true, process: { instanceId: 'a' }, memory: { rss: 1500000000, heapUsed: 410000000, heapTotal: 650000000, external: 20000000, arrayBuffers: 3000000, arbitrary: 'private transcript' } };
  const first = monitor.sample(health, { at: origin });
  assert.deepEqual(first.lastSample.memory, { heapUsed: 410000000, heapTotal: 650000000, external: 20000000, arrayBuffers: 3000000 });
  assert.equal(first.lastSample.rssBytes, 1500000000); assert.equal(first.lastSample.healthy, true, 'supervisor health policy remains the authority');
  health.memory.heapUsed++;
  assert.equal(monitor.sample(health, { at: origin + 1000 }).samples, 1, 'a changed memory diagnostic does not trigger extra sampling');
  const failed = monitor.sample(health, { at: origin + 2000, issue: 'RSS_LIMIT' });
  assert.equal(failed.unhealthySamples, 1); assert.equal(failed.lastSample.healthy, false); assert.equal(failed.lastSample.issue, 'RSS_LIMIT');
  health.memory = { rss: 100, heapUsed: -1, heapTotal: Infinity, external: 'private transcript', arrayBuffers: 1.5 };
  const invalid = monitor.sample(health, { at: origin + 3000 });
  assert.deepEqual(invalid.lastSample.memory, { heapUsed: null, heapTotal: null, external: null, arrayBuffers: null });
  const legacy = monitor.sample({ ok: true, process: { instanceId: 'a' } }, { at: origin + 63000 });
  assert.deepEqual(legacy.lastSample.memory, { heapUsed: null, heapTotal: null, external: null, arrayBuffers: null });
  for (const file of [monitor.path, monitor.log]) assert.doesNotMatch(readFileSync(file, 'utf8'), /arbitrary|private transcript/);
});
test('运行日志轮转有界，不涉及模型日志或项目证据', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-log-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'daemon.log');
  for (let i = 0; i < 20; i++) appendRotated(path, 'x'.repeat(500), { maxBytes: 100, copies: 2 });
  assert.equal(readdirSync(dir).length, 3);
  for (const file of readdirSync(dir)) { assert.ok(statSync(join(dir, file)).size <= 100); assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600); }
});
test('原生服务定义引用受管Node并转义路径，失败重启且stop有限', () => {
  const config = { stateFile: '/tmp/a & b/记忆.json', port: 4317 };
  const plist = launchAgentPlist(config);
  assert.match(plist, /a &amp; b/); assert.match(plist, /SuccessfulExit<\/key><false\/>/); assert.match(plist, /ExitTimeOut<\/key><integer>30/);
  assert.match(plist, /<key>ProcessType<\/key><string>Interactive<\/string>/);
  assert.doesNotMatch(plist, /<key>(?:Nice|LowPriorityIO|LowPriorityBackgroundIO|LegacyTimers)<\/key>/);
  assert.match(systemdUnit(config), /Restart=on-failure/); assert.match(systemdUnit(config), /KillMode=control-group/);
  assert.doesNotMatch(plist, /API_KEY|Authorization|StandardOutPath/);
});
test('服务依赖配置跨重启保留，只在明确替换或清空时改变', () => {
  const installed = { manager: 'session', helperDescriptors: ['/configured/relay.json'] };
  assert.deepEqual(serviceOptions('restart', [], installed), installed);
  assert.deepEqual(serviceOptions('start', ['--native'], installed), { ...installed, manager: 'native' });
  assert.deepEqual(serviceOptions('restart', ['--without-helpers'], installed).helperDescriptors, []);
  assert.throws(() => serviceOptions('restart', ['--session', '--native']), /只能选择一次/);
  assert.throws(() => serviceOptions('stop', ['--without-helpers']), /不接受/);
  assert.throws(() => serviceOptions('restart', ['--helper-descriptor']), /要求一个/);
  for (const action of ['start', 'install', 'run']) assert.throws(() => serviceOptions(action, ['--without-helpers'], { ...installed, stateFile: '/tmp/state.json' }), /service restart/);
  assert.deepEqual(installed.helperDescriptors, ['/configured/relay.json']);
});
