import { spawn } from 'node:child_process';
import { mkdirSync, statfsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { atomicWrite, readJSON } from './durable-files.mjs';
import { acquireProcessLease, processAlive, processBirth } from './process-lease.mjs';
import { appendRotated, EnduranceMonitor } from './endurance-monitor.mjs';
import { ManagedHelpers } from './managed-helpers.mjs';
import { assertStateRecoveryReady } from './state-checkpoint.mjs';
import { ensureMaintenancePaths } from './application-maintenance-state.mjs';
import { boundedElapsed, maintenanceFailureType } from './maintenance-diagnostics.mjs';

const root = dirname(fileURLToPath(import.meta.url));
export const servicePaths = (stateFile) => ({ directory: `${stateFile}.service`, config: `${stateFile}.service/config.json`, intent: `${stateFile}.service/intent.json`, status: `${stateFile}.service/status.json`, endurance: `${stateFile}.service/endurance.json` });
const iso = () => new Date().toISOString();
const alive = child => child && child.exitCode === null && child.signalCode === null;
const monotonicMs = () => Number(process.hrtime.bigint() / 1000000n);

export class DaemonSupervisor {
  constructor(config) {
    this.config = { pollMs: 5000, healthTimeoutMs: 4000, startupGraceMs: 60000, unhealthyThreshold: 3,
      shutdownGraceMs: 20000, restartBaseMs: 1000, restartMaxMs: 60000,
      crashWindowMs: 15 * 60000, maxCrashes: 5, crashCooldownMs: 15 * 60000,
      maxRssBytes: 1024 * 1024 * 1024, ...config };
    // The soft recycle threshold must not abort a healthy in-flight operation.
    // A separate hard ceiling still protects the host from unbounded growth.
    this.config.hardMaxRssBytes ??= this.config.maxRssBytes * 2;
    if (!Number.isFinite(this.config.maxRssBytes) || this.config.maxRssBytes <= 0 || !Number.isFinite(this.config.hardMaxRssBytes) || this.config.hardMaxRssBytes < this.config.maxRssBytes) throw new Error('Invalid RSS limits');
    this.paths = servicePaths(this.config.stateFile);
    this.runId = randomUUID(); this.child = null; this.awake = null; this.closed = false; this.stopping = false;
    this.restarts = 0; this.crashes = []; this.unhealthy = 0; this.failures = 0; this.nextStartAt = 0; this.lastHealth = null;
    this.status = { schemaVersion: 1, runId: this.runId, supervisorPid: process.pid, startedAt: iso(), configuration: { stateFile: this.config.stateFile, port: this.config.port, command: this.config.command ?? process.execPath, manager: this.config.manager ?? 'native' }, phase: 'starting', restarts: 0, lastIssue: null };
    this.status.startup = { schemaVersion: 1, status: 'running', stages: [] }; this.startupStartedAt = performance.now();
    this.monitor = new EnduranceMonitor(this.paths.directory);
    this.helpers = new ManagedHelpers({ paths: this.paths, descriptors: this.config.helperDescriptors ?? [],
      stopOnly: this.config.stopOnly === true, log: (event, fields) => this.log(event, fields), onFatal: error => this.fatal(error) });
    this.status.configuration.helperDescriptors = [...(this.config.helperDescriptors ?? [])];
    this.status.configuration.memoryPolicy = { softRssBytes: this.config.maxRssBytes, hardRssBytes: this.config.hardMaxRssBytes, recycle: 'soft-limit-at-idle-with-fresh-liveness' };
    this.status.configuration.helperFingerprints = this.helpers.status().helpers.map(({ id, descriptorPath, fingerprint }) => ({ id, descriptorPath, fingerprint }));
    this.helpersStopped = false;
  }
  async start({ lease } = {}) {
    try {
      ensureMaintenancePaths(this.config.stateFile, { create: true });
      if (!this.config.stopOnly) await assertStateRecoveryReady(this.config.stateFile);
    } catch (error) { lease?.(); throw error; }
    mkdirSync(this.paths.directory, { recursive: true, mode: 0o700 });
    this.release = lease ?? await acquireProcessLease(`${this.paths.directory}/supervisor.lock`, { supervisorRunId: this.runId });
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
    this.startupStage('recover_orphan');
    // If the supervisor itself was killed, an isolated child group may remain.
    // Reclaim only a daemon whose private lease includes this state path and
    // an unchanged OS birth identity. A PID file alone is never sufficient.
    try {
      if (readJSON(this.paths.intent)?.enabled === true || this.config.recoverOnStop) {
        await this.recoverOrphan();
        if (!this.stopping) { this.startupStage('helpers'); await this.helpers.start(); }
      }
    } catch (error) { this.fatal(error); }
    await this.poll();
    if (!this.closed) this.timer = setInterval(() => { void this.poll(); }, this.config.pollMs);
    return this;
  }
  startupStage(name, error) {
    const startup = this.status.startup; if (startup.status !== 'running') return;
    const at = performance.now(), previous = startup.stages.at(-1);
    if (previous?.status === 'running') Object.assign(previous, { status: error ? 'failed' : 'completed', elapsedMs: boundedElapsed(at - this.startupStageAt), ...(error ? { failureType: maintenanceFailureType(error) } : {}) });
    if (name === 'ready' || error) Object.assign(startup, { status: error ? 'failed' : 'completed', elapsedMs: boundedElapsed(at - this.startupStartedAt) });
    else { startup.stages = [...startup.stages, { name, status: 'running', startedAt: iso() }].slice(-12); this.startupStageAt = at; }
    this.writeStatus();
  }
  async recoverOrphan() {
    const owner = readJSON(`${this.config.stateFile}.lock`);
    if (!owner || typeof owner !== 'object') return;
    if (!processAlive(owner.pid)) {
      if (process.platform !== 'win32' && Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.supervisorRunId && owner.generation && owner.stateFile === this.config.stateFile) {
        let groupExists = false;
        try { process.kill(-owner.pid, 0); groupExists = true; } catch (error) { if (error.code !== 'ESRCH') groupExists = true; }
        if (groupExists) throw Object.assign(new Error('Orphan process group remains but its leader identity is gone'), { code: 'ORPHAN_GROUP_UNCERTAIN' });
      }
      return;
    }
    if (!owner.supervisorRunId || !owner.generation || owner.stateFile !== this.config.stateFile || !owner.birth || processBirth(owner.pid) !== owner.birth) throw Object.assign(new Error('Existing daemon ownership cannot be verified'), { code: 'EXISTING_DAEMON' });
    const signal = name => { if (processBirth(owner.pid) === owner.birth) { try { process.kill(-owner.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } } };
    this.log('orphan_recovery', { pid: owner.pid, generation: owner.generation });
    // The previous supervisor can no longer observe this group's leader exit.
    // A cooperative TERM exit would strand descendants that ignore TERM and
    // remove our safe identity anchor. Reap this verified orphan group at once;
    // normal live-supervisor shutdown still drains with TERM before KILL.
    signal('SIGKILL');
    const killDeadline = Date.now() + 5000;
    while (processAlive(owner.pid) && processBirth(owner.pid) === owner.birth && Date.now() < killDeadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (processAlive(owner.pid) && processBirth(owner.pid) === owner.birth) throw Object.assign(new Error('Orphan did not exit'), { code: 'ORPHAN_STILL_RUNNING' });
  }
  writeStatus() {
    Object.assign(this.status, { updatedAt: iso(), childPid: this.child?.pid ?? null, generation: this.generation ?? null,
      restarts: this.restarts, consecutiveFailures: this.failures, nextStartAt: this.nextStartAt ? new Date(this.nextStartAt).toISOString() : null,
      keepAwakePid: this.awake?.pid ?? null,
      keepAwakePolicy: { requested: this.keepAwakeRequested === true, supported: process.platform === 'darwin', idleSleep: true, systemSleepOnAc: true, preventsDisplaySleep: false, guaranteesUninterruptedExecution: false },
      liveness: this.childLiveness ? { at: this.childLiveness.at, sequence: this.childLiveness.sequence, activeWork: this.childLiveness.activeWork, closing: this.childLiveness.closing, ageMs: Math.max(0, monotonicMs() - this.childLiveness.sentAtMonotonicMs) } : null,
      restartDeferred: this.restartDeferred ?? null,
      health: this.lastHealth, helpers: this.helpers.status() });
    atomicWrite(this.paths.status, JSON.stringify(this.status, null, 2));
  }
  log(event, fields = {}) { appendRotated(`${this.paths.directory}/supervisor.jsonl`, `${JSON.stringify({ at: iso(), event, ...fields })}\n`); }
  spawnDaemon() {
    this.startupStage('daemon_spawn');
    this.generation = randomUUID(); this.startedChildAt = Date.now(); this.unhealthy = 0; this.lastHealth = null; this.restartReason = null;
    this.childLiveness = null; this.restartDeferred = null; this.lastProbe = null;
    const generation = this.generation;
    const env = { ...process.env, ...(this.config.env ?? {}), RNA_AGENT_STATE: this.config.stateFile,
      RNA_AGENT_PORT: String(this.config.port), RNA_AGENT_SUPERVISOR_RUN: this.runId, RNA_AGENT_GENERATION: this.generation };
    const child = spawn(this.config.command ?? process.execPath, this.config.args ?? [resolve(root, 'server.mjs')],
      { cwd: this.config.cwd ?? root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    this.child = child; this.status.phase = 'starting'; this.nextStartAt = 0;
    child.once('spawn', () => {
      if (this.child !== child) return;
      try { this.monitor.sample(null, { issue: 'daemon_starting', managedDaemon: { supervisorRunId: this.runId, generation, pid: child.pid } }); }
      catch (error) { this.fatal(error); }
    });
    child.on('message', message => {
      if (this.child !== child || !alive(child) || message?.type !== 'rna-daemon-liveness'
        || message.pid !== child.pid || message.supervisorRunId !== this.runId || message.generation !== this.generation
        || !Number.isSafeInteger(message.sequence) || message.sequence <= (this.childLiveness?.sequence ?? 0)
        || !Number.isSafeInteger(message.sentAtMonotonicMs) || message.sentAtMonotonicMs < 0 || message.sentAtMonotonicMs > monotonicMs()
        || monotonicMs() - message.sentAtMonotonicMs > this.config.healthTimeoutMs
        || typeof message.activeWork !== 'boolean' || typeof message.closing !== 'boolean') return;
      this.childLiveness = { at: iso(), receivedAt: performance.now(), sentAtMonotonicMs: message.sentAtMonotonicMs, sequence: message.sequence, activeWork: message.activeWork, closing: message.closing };
    });
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream.on('data', data => {
      try { appendRotated(`${this.paths.directory}/daemon-${name}.log`, data); }
      catch (error) { this.fatal(error); }
    });
    child.once('error', error => { this.status.lastIssue = { at: iso(), code: error.code ?? 'SPAWN_FAILED' }; });
    child.once('exit', () => {
      // exit and close are distinct: a grandchild can keep inherited pipes
      // open after its parent exits. Kill the owned group before waiting for
      // close, and bound pipe teardown even when a descendant escaped it.
      if (process.platform !== 'win32' && child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') this.status.lastIssue = { at: iso(), code: error.code }; }
      const pipes = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 1000);
      child.once('close', () => clearTimeout(pipes));
    });
    child.once('close', (code, signal) => {
      if (this.child !== child) return;
      this.status.lastDaemonExit = { pid: child.pid ?? null, generation, code, signal, at: iso() };
      this.child = null; clearTimeout(this.killTimer); this.lastHealth = null;
      try {
        this.log('daemon_exit', { code, signal, reason: this.restartReason });
        if (this.stopping) return this.finish();
        this.restarts++; this.failures++;
        const now = Date.now(); this.crashes = [...this.crashes.filter(at => now - at < this.config.crashWindowMs), now];
        const backoff = Math.min(this.config.restartMaxMs, this.config.restartBaseMs * 2 ** Math.min(10, this.failures - 1));
        const cooldown = this.crashes.length >= this.config.maxCrashes ? this.config.crashCooldownMs : 0;
        this.nextStartAt = now + Math.max(backoff, cooldown); this.status.phase = cooldown ? 'cooldown' : 'backoff';
        this.status.lastIssue = { at: iso(), code: this.restartReason ?? `DAEMON_EXIT_${code ?? signal}` };
        this.writeStatus();
      } catch (error) { this.fatal(error); }
    });
    this.log('daemon_started', { pid: child.pid, generation: this.generation }); this.startupStage('health'); this.writeStatus();
  }
  terminateChild(reason) {
    if (!this.child || this.restartReason) return;
    let evidence;
    if (['HEALTH_UNREACHABLE', 'RSS_LIMIT', 'RSS_HARD_LIMIT'].includes(reason)) {
      const progress = this.childLiveness;
      evidence = { pid: this.child.pid, generation: this.generation, consecutiveUnhealthy: this.unhealthy,
        healthTimeoutMs: this.config.healthTimeoutMs, unhealthyThreshold: this.config.unhealthyThreshold,
        probe: this.lastProbe ? { ...this.lastProbe } : null,
        ...(reason.startsWith('RSS_') ? { rssBytes: this.lastHealth?.memory?.rss ?? null, softRssBytes: this.config.maxRssBytes, hardRssBytes: this.config.hardMaxRssBytes } : {}),
        liveness: progress ? { sequence: progress.sequence, activeWork: progress.activeWork, closing: progress.closing,
          sentAgeMs: Math.max(0, monotonicMs() - progress.sentAtMonotonicMs), receivedAgeMs: Math.max(0, Math.round(performance.now() - progress.receivedAt)) } : null };
      this.status.lastTermination = { at: iso(), reason, ...evidence };
    }
    this.restartReason = reason; this.restartDeferred = null; this.status.phase = 'draining';
    const child = this.child;
    const signal = name => {
      if (this.child !== child || !alive(child) || !child.pid) return;
      try { if (process.platform === 'win32') child.kill(name); else process.kill(-child.pid, name); }
      catch (error) { if (error.code !== 'ESRCH') this.fatal(error); }
    };
    signal('SIGTERM');
    this.killTimer = setTimeout(() => signal('SIGKILL'), this.config.shutdownGraceMs);
    this.log('daemon_terminate', { reason, ...(evidence ? { evidence } : {}) });
  }
  async probe() {
    const response = await fetch(`http://127.0.0.1:${this.config.port}/api/health`, { signal: AbortSignal.timeout(this.config.healthTimeoutMs) });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const health = await response.json();
    if (health.process?.supervisorRunId !== this.runId || health.process?.generation !== this.generation || health.process?.pid !== this.child?.pid) throw new Error('FOREIGN_LISTENER');
    if (!Number.isFinite(Date.parse(health.heartbeatAt)) || Date.now() - Date.parse(health.heartbeatAt) > 30000) throw new Error('STALE_HEARTBEAT');
    if ((health.memory?.rss ?? 0) > this.config.maxRssBytes) throw Object.assign(new Error(health.memory.rss > this.config.hardMaxRssBytes ? 'RSS_HARD_LIMIT' : 'RSS_LIMIT'), { health: { ...health, ok: false } });
    return health;
  }
  updateAwake(run) {
    this.keepAwakeRequested = run?.status === 'running' && run.keepAwake === true && !this.stopping;
    const wanted = process.platform === 'darwin' && this.keepAwakeRequested;
    if (wanted && !this.awake) {
      // Idle prevention alone does not cover macOS Sleep Service returning to
      // sleep. The system assertion applies on AC only; neither flag keeps the
      // display awake or guarantees lid-close/manual-sleep continuity.
      const child = spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' });
      this.awake = child;
      child.once('error', () => { this.status.lastIssue = { at: iso(), code: 'KEEP_AWAKE_FAILED' }; });
      child.once('close', () => { if (this.awake === child) this.awake = null; });
    } else if (!wanted && this.awake) { this.awake.kill('SIGTERM'); this.awake = null; }
  }
  async poll() {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      const intent = readJSON(this.paths.intent);
      if (this.config.stopOnly || this.stopping || intent?.enabled !== true) { await this.stop(); return; }
      if (!this.child && Date.now() >= this.nextStartAt) this.spawnDaemon();
      // The helper pool owns its concurrency guard and deadline. Probe alongside
      // the daemon so one unreachable dependency cannot double every poll period.
      const helpersProbe = this.helpers.poll().catch(error => this.fatal(error));
      let issue = null;
      if (this.child && !this.restartReason) {
        const progressAtProbeStart = this.childLiveness;
        this.lastProbe = { startedAt: iso(), livenessSequence: progressAtProbeStart?.sequence ?? null, activeWork: progressAtProbeStart?.activeWork ?? null };
        try {
          this.lastHealth = await this.probe(); this.unhealthy = 0;
          this.restartDeferred = null;
          if (Date.now() - this.startedChildAt > 5 * 60000) this.failures = 0;
          // A storage/configuration failure is visible, but not an invitation
          // to erase state or spin through repeated restarting processes.
          this.status.phase = this.lastHealth.ok ? 'running' : 'degraded';
          this.startupStage('ready');
        } catch (error) {
          issue = ['FOREIGN_LISTENER', 'STALE_HEARTBEAT', 'RSS_LIMIT', 'RSS_HARD_LIMIT'].includes(error.message) ? error.message : 'HEALTH_UNREACHABLE';
          this.lastHealth = issue.startsWith('RSS_') ? error.health ?? null : null;
          if (Date.now() - this.startedChildAt >= this.config.startupGraceMs || issue === 'FOREIGN_LISTENER') {
            this.unhealthy++; this.status.lastIssue = { at: iso(), code: issue };
            if (this.unhealthy >= this.config.unhealthyThreshold) {
              const progress = this.childLiveness;
              // A recent message from this exact child proves its main loop is
              // making progress. A slow health route must not kill an ongoing
              // file/tool operation. Keep recording the HTTP outage as unhealthy;
              // Soft memory recycling follows the same safe boundary. Identity,
              // stale/missing IPC and the hard RSS ceiling retain recovery.
              const progressAlive = ['HEALTH_UNREACHABLE', 'RSS_LIMIT'].includes(issue) && progress && !progress.closing
                && performance.now() - progress.receivedAt <= this.config.healthTimeoutMs
                && monotonicMs() - progress.sentAtMonotonicMs <= this.config.healthTimeoutMs;
              const busyAlive = progressAlive && progress.activeWork;
              if (busyAlive) {
                const reason = issue === 'RSS_LIMIT' ? 'ACTIVE_WORK_RSS_SOFT_LIMIT' : 'ACTIVE_WORK_LIVENESS';
                if (this.restartDeferred !== reason) this.log('daemon_restart_deferred', { reason, sequence: progress.sequence, ...(issue === 'RSS_LIMIT' ? { rssBytes: this.lastHealth?.memory?.rss, softRssBytes: this.config.maxRssBytes, hardRssBytes: this.config.hardMaxRssBytes } : {}) });
                this.restartDeferred = reason; this.status.phase = 'degraded';
              } else if (progressAlive && !progress.activeWork && (this.restartDeferred === 'ACTIVE_WORK_LIVENESS'
                || progressAtProbeStart?.activeWork && progress.sequence > progressAtProbeStart.sequence)) {
                // This failed HTTP request may predate work completion. Give
                // the now-idle generation one fresh request before restarting;
                // continued idle heartbeats cannot renew this allowance. The
                // old failure stays unhealthy and the next failed probe retains
                // the existing threshold/recovery policy.
                this.restartDeferred = 'IDLE_HEALTH_RECHECK'; this.status.phase = 'degraded';
                this.log('daemon_restart_deferred', { reason: 'IDLE_HEALTH_RECHECK', sequence: progress.sequence });
              } else this.terminateChild(issue);
            }
          }
        }
      }
      await helpersProbe;
      if (this.stopping || this.closed) return;
      const helpers = this.helpers.status();
      if (this.lastHealth) {
        this.lastHealth = { ...this.lastHealth, ok: this.lastHealth.ok && helpers.healthy,
          dependencies: { ...this.lastHealth.dependencies, managedHelpers: helpers } };
        if (!this.lastHealth.ok && !this.restartReason) this.status.phase = 'degraded';
      }
      let diskFreeBytes = null;
      try { const disk = statfsSync(dirname(this.config.stateFile)); diskFreeBytes = disk.bavail * disk.bsize; } catch { /* Unknown is not reported as healthy free space. */ }
      const run = this.monitor.sample(this.lastHealth, { issue, diskFreeBytes,
        managedDaemon: this.generation ? { supervisorRunId: this.runId, generation: this.generation, pid: this.child?.pid ?? null } : null });
      this.updateAwake(run); this.writeStatus();
    } catch (error) { this.fatal(error); }
    finally { this.polling = false; }
  }
  fatal(error) {
    if (this.closed) return;
    this.exitCode = 1; this.status.lastIssue = { at: iso(), code: error.code ?? 'SUPERVISOR_ERROR' };
    try { this.startupStage('failed', error); } catch { /* Preserve shutdown even if diagnostic persistence itself fails. */ }
    // Do not embed arbitrary HTTP/tool output or credentials in operational status.
    process.stderr.write(`Rna supervisor: ${this.status.lastIssue.code}\n`);
    void this.stop();
  }
  async stop() {
    if (this.closed) return;
    this.stopping = true; clearInterval(this.timer); this.updateAwake(null);
    this.helpersStopPromise ??= this.helpers.stop().catch(error => {
      this.exitCode = 1; this.status.lastIssue = { at: iso(), code: error.code ?? 'HELPER_STOP_FAILED' };
    }).finally(() => { this.helpersStopped = true; if (!this.child) this.finish(); });
    if (this.child) this.terminateChild('SUPERVISOR_STOP'); else if (this.helpersStopped) this.finish();
  }
  finish() {
    if (this.closed || !this.helpersStopped) return;
    this.closed = true; clearInterval(this.timer); clearTimeout(this.killTimer); this.updateAwake(null);
    this.status.phase = 'stopped';
    try { this.writeStatus(); } catch { this.exitCode = 1; }
    this.release?.(); this.resolveExit?.(this.exitCode ?? 0);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const config = readJSON(resolve(process.argv[2] ?? ''));
  if (!config?.stateFile || !Number.isInteger(config.port)) throw new Error('缺少服务配置');
  const supervisor = new DaemonSupervisor(config);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void supervisor.stop(); });
  await supervisor.start();
  process.exit(await supervisor.exitPromise);
}
