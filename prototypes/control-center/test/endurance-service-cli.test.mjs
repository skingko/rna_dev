import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEnduranceRun, recordEnduranceSample, EnduranceMonitor } from '../endurance-monitor.mjs';

// Invoke the real CLI in a child process against an isolated supervisor command
// directory. Synthetic archived time tests policy, never real uptime evidence.
const cli = fileURLToPath(new URL('../service-cli.mjs', import.meta.url));
const runtimeIdentity = 'a'.repeat(64);
const write = (path, value) => writeFileSync(path, JSON.stringify(value));
function fixture(t, { identity = runtimeIdentity } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rna-endurance-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateFile = join(root, 'state.json'), directory = `${stateFile}.service`;
  mkdirSync(directory); write(join(directory, 'intent.json'), { enabled: true });
  write(join(directory, 'status.json'), { phase: 'running', updatedAt: new Date().toISOString(), health: { runtimeIdentity: identity } });
  const monitor = new EnduranceMonitor(directory), failures = [];
  const timer = setInterval(() => {
    try { monitor.consumeRequest({ at: Date.now() }); } catch (error) { failures.push(error); }
  }, 10);
  t.after(() => { clearInterval(timer); assert.deepEqual(failures, []); });
  return { root, directory, stateFile, monitor,
    async invoke(...args) {
      const child = spawn(process.execPath, [cli, 'endurance', ...args], { env: { ...process.env, RNA_AGENT_STATE: stateFile, RNA_AGENT_PORT: '64537' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
      const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      clearTimeout(deadline);
      return { code, stdout, stderr, value: code === 0 ? JSON.parse(stdout) : null };
    },
  };
}
function completedStartup() {
  const origin = Date.now() - 4 * 3600000;
  let run = createEnduranceRun({ id: 'old-adaptive-startup', runtimeIdentity, now: origin });
  for (let second = 0; second <= run.targetSeconds; second += 60) run = recordEnduranceSample(run, {
    at: new Date(origin + second * 1000).toISOString(), healthy: true, instanceId: 'fixture', workload: { activeWork: false, activeSessions: 0, activeExecutions: 0 },
  });
  assert.equal(run.schemaVersion, 2); assert.equal(run.passed, true); return run;
}

test('real CLI defaults to an acknowledged adaptive startup and stops without fabricating uptime', async t => {
  const f = fixture(t), start = await f.invoke('start');
  assert.equal(start.code, 0, start.stderr); assert.equal(start.value.policy.mode, 'adaptive');
  assert.equal(start.value.policy.stage, 'startup'); assert.equal(start.value.targetHours, 2);
  assert.equal(start.value.policy.runtimeIdentity, runtimeIdentity); assert.equal(start.value.keepAwake, false);
  assert.equal(start.value.lastRequest.status, 'applied'); assert.equal(start.value.samples, 0); assert.equal(start.value.passed, null);
  const status = await f.invoke('status'); assert.equal(status.code, 0, status.stderr); assert.equal(status.value.id, start.value.id);
  const stopped = await f.invoke('stop'); assert.equal(stopped.code, 0, stopped.stderr); assert.equal(stopped.value.status, 'stopped');
  assert.equal(stopped.value.targetHours, 2); assert.equal(stopped.value.observedHealthySeconds, 0); assert.equal(stopped.value.passed, null);
});

test('real CLI consumes schema 2 archive history and advances only the same implementation', async t => {
  const f = fixture(t), old = completedStartup(); write(join(f.directory, `endurance-${old.id}.json`), old);
  const before = readFileSync(join(f.directory, `endurance-${old.id}.json`));
  const result = await f.invoke('start'); assert.equal(result.code, 0, result.stderr);
  assert.equal(result.value.targetHours, 8); assert.equal(result.value.policy.stage, 'workload');
  assert.equal(result.value.policy.predecessor.id, old.id); assert.equal(result.value.samples, 0);
  assert.deepEqual(readFileSync(join(f.directory, `endurance-${old.id}.json`)), before);
  const other = fixture(t, { identity: 'b'.repeat(64) }); write(join(other.directory, `endurance-${old.id}.json`), old);
  const mismatch = await other.invoke('start'); assert.equal(mismatch.code, 0, mismatch.stderr); assert.equal(mismatch.value.targetHours, 2);
});

test('real CLI respects explicit hours and refuses to replace an ongoing 120 hour observation', async t => {
  const f = fixture(t), old = completedStartup(); write(join(f.directory, `endurance-${old.id}.json`), old);
  const result = await f.invoke('start', '--hours', '120'); assert.equal(result.code, 0, result.stderr);
  assert.equal(result.value.policy.mode, 'fixed'); assert.equal(result.value.targetHours, 120); assert.equal(result.value.keepAwake, false);
  const bytes = readFileSync(f.monitor.path), request = readFileSync(f.monitor.requestPath);
  const replacement = await f.invoke('start'); assert.notEqual(replacement.code, 0); assert.match(replacement.stderr, /已有耐久观测运行中/);
  assert.deepEqual(readFileSync(f.monitor.path), bytes); assert.deepEqual(readFileSync(f.monitor.requestPath), request);
});

test('real CLI rejects invalid explicit hours before submitting an observation request', async t => {
  const f = fixture(t);
  for (const args of [['--hours'], ['--hours', '0'], ['--hours', 'NaN'], ['--hours', '8761'], ['--other']]) {
    const result = await f.invoke('start', ...args); assert.notEqual(result.code, 0, JSON.stringify(args));
    assert.equal(existsSync(f.monitor.requestPath), false); assert.equal(existsSync(f.monitor.path), false);
  }
});

test('real CLI excludes symlink and oversized archives, bounds recent history, and preserves current history priority', async t => {
  const f = fixture(t), old = completedStartup(), oldPath = join(f.root, 'outside.json');
  write(oldPath, old); symlinkSync(oldPath, join(f.directory, 'endurance-symlink.json'));
  writeFileSync(join(f.directory, 'endurance-oversized.json'), `${JSON.stringify(old)}${' '.repeat(1024 * 1024)}`);
  const clean = await f.invoke('start'); assert.equal(clean.code, 0, clean.stderr); assert.equal(clean.value.targetHours, 2);
  await f.invoke('stop');
  for (let index = 0; index < 260; index++) {
    const path = join(f.directory, `endurance-old-${index}.json`);
    write(path, { schemaVersion: 1, id: `old-${index}`, requestedAt: new Date(Date.now() - (index + 10) * 86400000).toISOString(), status: 'stopped', targetHours: 120 });
    utimesSync(path, new Date(index * 1000), new Date(index * 1000));
  }
  write(f.monitor.path, old);
  const next = await f.invoke('start'); assert.equal(next.code, 0, next.stderr);
  assert.equal(next.value.targetHours, 8); assert.equal(next.value.policy.predecessor.id, old.id);
  assert.ok(next.value.policy.history.runs <= 256);
  assert.deepEqual(JSON.parse(readFileSync(oldPath, 'utf8')), old, 'outside archive was not modified');
});
